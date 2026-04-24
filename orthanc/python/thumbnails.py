"""MiniPACS thumbnail pre-generator — Orthanc Python plugin.

Writes PNG thumbnails to a volume shared with the backend so the worklist
grid view renders from disk instead of rebuilding PNGs on every hit.

Design constraints learned from the prewarm-Lua disaster:

1. OnChange fires on Orthanc's write thread — it MUST NOT block. We only
   push the study_id into a bounded queue; the heavy lifting happens on a
   separate worker thread.
2. Global rate limit of 2 thumbnails/sec so bulk ingest (or the one-shot
   backfill of an existing archive) does not compete with the web UI for
   Orthanc's HTTP thread pool.
3. The backend has an on-demand fallback (`/api/studies/{id}/thumb` →
   `/instances/{id}/preview`) — if our worker gets behind or misses a
   study, the grid still shows a thumbnail, just paid at first view.
"""
import json
import os
import threading
import time
from queue import Empty, Queue
from urllib import request as urlrequest
from urllib.error import URLError

import orthanc  # type: ignore[import-not-found]  # provided by Orthanc runtime

THUMB_DIR = "/var/cache/minipacs-thumbs"
# Keep the rate conservative — Orthanc shares its HTTP pool between the
# plugin's RestApiGet calls and real user traffic. 2/sec finishes an 850-
# study backfill in ~7 min without any visible UI slowdown.
RATE_LIMIT_SECONDS = 0.5
QUEUE_MAX = 2000
BACKFILL_DELAY_SECONDS = 30  # let Orthanc fully boot before scanning

os.makedirs(THUMB_DIR, exist_ok=True)

# Non-image modalities — no pixel data to render.
_SKIP_MODALITIES = {"SEG", "PR", "SR", "KO", "OT", "DOC", "PDF", "FID", "PLAN", "RWV", "RAW"}

_queue: Queue = Queue(maxsize=QUEUE_MAX)
_seen: set[str] = set()
_seen_lock = threading.Lock()

# Live-worklist notify pipeline. Orthanc's OnChange callback fires on the
# write thread — we MUST NOT do blocking HTTP from it. Push an event tuple
# into this queue and let a dedicated worker thread POST to the backend.
_BACKEND_EVENT_URL = os.environ.get("BACKEND_EVENT_URL", "").strip()
_INTERNAL_EVENT_TOKEN = os.environ.get("INTERNAL_EVENT_TOKEN", "").strip()
_notify_queue: Queue = Queue(maxsize=500)


def _thumb_path(study_id: str) -> str:
    return os.path.join(THUMB_DIR, f"{study_id}.png")


def _thumb_exists(study_id: str) -> bool:
    return os.path.isfile(_thumb_path(study_id))


def _get_json(uri: str):
    try:
        raw = orthanc.RestApiGet(uri)
    except Exception:  # noqa: BLE001  — Orthanc raises plain Exception
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


def _pick_instance(study_id: str) -> str | None:
    """Return the best instance to represent this study in a grid tile.

    Strategy: iterate series by SeriesNumber ascending, skip non-image
    modalities (SEG, PR, SR, ...), return middle slice of first eligible
    series. Middle beats first because the first slice on CT/MR is often
    a scout/localizer which makes a confusing tile.
    """
    study = _get_json(f"/studies/{study_id}")
    if not study:
        return None
    series_ids = study.get("Series", [])
    if not series_ids:
        return None

    candidates: list[tuple[int, list[str]]] = []
    for sid in series_ids:
        s = _get_json(f"/series/{sid}")
        if not s:
            continue
        tags = s.get("MainDicomTags", {}) or {}
        modality = (tags.get("Modality") or "").upper()
        if modality in _SKIP_MODALITIES:
            continue
        instances = s.get("Instances") or []
        if not instances:
            continue
        try:
            num = int(tags.get("SeriesNumber") or 999)
        except (TypeError, ValueError):
            num = 999
        candidates.append((num, instances))

    if not candidates:
        return None
    candidates.sort(key=lambda c: c[0])
    instances = candidates[0][1]
    return instances[len(instances) // 2]


def _generate(study_id: str) -> str:
    if _thumb_exists(study_id):
        return "skipped"

    instance_id = _pick_instance(study_id)
    if not instance_id:
        return "no_instance"

    # /preview is fastest but only handles plain image SOP classes.
    # /rendered?format=png handles multi-frame, video first-frame, and
    # encapsulated PDFs, so fall back before giving up.
    png: bytes | None = None
    for uri in (
        f"/instances/{instance_id}/preview",
        f"/instances/{instance_id}/rendered?format=png",
    ):
        try:
            png = orthanc.RestApiGet(uri)
        except Exception as exc:  # noqa: BLE001
            orthanc.LogInfo(f"thumb: {uri.split('/')[-1][:20]} failed for {instance_id[:12]}: {exc}")
            png = None
            continue
        if png:
            break
    if not png:
        return "preview_failed"

    # Atomic write — avoids the backend reading a half-flushed file.
    tmp = _thumb_path(study_id) + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(png)
        os.replace(tmp, _thumb_path(study_id))
    except OSError as exc:
        orthanc.LogWarning(f"thumb: write failed for {study_id[:12]}: {exc}")
        try:
            os.remove(tmp)
        except OSError:
            pass
        return "write_failed"

    return "ok"


def _worker() -> None:
    while True:
        try:
            study_id = _queue.get(timeout=5)
        except Empty:
            continue
        try:
            result = _generate(study_id)
            if result == "ok":
                orthanc.LogInfo(f"thumb: generated {study_id[:12]}")
        except Exception as exc:  # noqa: BLE001
            orthanc.LogWarning(f"thumb worker error for {study_id[:12]}: {exc}")
        finally:
            _queue.task_done()
        time.sleep(RATE_LIMIT_SECONDS)


def _enqueue(study_id: str) -> None:
    """Non-blocking enqueue. Drops on full queue — backend on-demand path
    is the safety net for studies the worker missed."""
    with _seen_lock:
        if study_id in _seen:
            return
        _seen.add(study_id)
    if _thumb_exists(study_id):
        return
    try:
        _queue.put_nowait(study_id)
    except Exception:  # noqa: BLE001
        pass


def _backfill() -> None:
    """One-shot scan of the whole archive at plugin boot."""
    time.sleep(BACKFILL_DELAY_SECONDS)
    try:
        ids = _get_json("/studies") or []
    except Exception as exc:  # noqa: BLE001
        orthanc.LogWarning(f"thumb backfill: listing failed: {exc}")
        return
    enqueued = 0
    for sid in ids:
        before = _queue.qsize()
        _enqueue(sid)
        if _queue.qsize() > before:
            enqueued += 1
    orthanc.LogInfo(
        f"thumb backfill: scanned {len(ids)} studies, enqueued {enqueued}"
    )


def _build_notify_payload(study_id: str) -> dict:
    """Minimal study metadata for the live-worklist toast. Best-effort — on
    any Orthanc hiccup we still broadcast with just the ID; the frontend
    will invalidate its queries and re-fetch."""
    payload: dict = {"study_id": study_id}
    study = _get_json(f"/studies/{study_id}")
    if not study:
        return payload
    tags = study.get("MainDicomTags", {}) or {}
    p_tags = study.get("PatientMainDicomTags", {}) or {}
    if p_tags.get("PatientName"):
        payload["patient_name"] = p_tags["PatientName"]
    if tags.get("StudyDescription"):
        payload["study_description"] = tags["StudyDescription"]
    if tags.get("StudyDate"):
        payload["study_date"] = tags["StudyDate"]
    # ModalitiesInStudy is nicer but not always set server-side — cheap to
    # derive from child series if missing.
    if tags.get("ModalitiesInStudy"):
        payload["modalities"] = tags["ModalitiesInStudy"]
    return payload


def _notify_worker() -> None:
    """POST STABLE_STUDY notifications to the backend. One connection, no
    pooling — events arrive at worklist cadence (< dozens/min in any real
    clinic), and a fresh short-lived TCP connection is simpler than
    reasoning about keep-alive across a long-lived daemon."""
    if not _BACKEND_EVENT_URL or not _INTERNAL_EVENT_TOKEN:
        orthanc.LogWarning(
            "thumb plugin: live-worklist disabled (BACKEND_EVENT_URL or INTERNAL_EVENT_TOKEN not set)"
        )
        return
    while True:
        try:
            study_id = _notify_queue.get(timeout=5)
        except Empty:
            continue
        try:
            payload = _build_notify_payload(study_id)
            body = json.dumps(payload).encode("utf-8")
            req = urlrequest.Request(
                _BACKEND_EVENT_URL,
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-Internal-Token": _INTERNAL_EVENT_TOKEN,
                },
            )
            with urlrequest.urlopen(req, timeout=5) as resp:
                if resp.status >= 300:
                    orthanc.LogWarning(
                        f"thumb notify: backend returned {resp.status} for {study_id[:12]}"
                    )
        except URLError as exc:
            # Backend briefly down is not fatal — the study still lands in
            # Orthanc, and the next /api/studies refresh will pick it up.
            orthanc.LogWarning(f"thumb notify: POST failed for {study_id[:12]}: {exc}")
        except Exception as exc:  # noqa: BLE001
            orthanc.LogWarning(f"thumb notify worker error for {study_id[:12]}: {exc}")
        finally:
            _notify_queue.task_done()


def on_change(change_type, level, resource):
    # STABLE_STUDY fires once per study after ~60s of ingest inactivity.
    # NEW_STUDY fires immediately but the study may still be receiving
    # more series — STABLE gives us a complete picture.
    if change_type != orthanc.ChangeType.STABLE_STUDY:
        return
    _enqueue(resource)
    try:
        _notify_queue.put_nowait(resource)
    except Exception:  # noqa: BLE001 — full queue / shutdown
        pass


orthanc.RegisterOnChangeCallback(on_change)
threading.Thread(target=_worker, daemon=True, name="thumb-worker").start()
threading.Thread(target=_backfill, daemon=True, name="thumb-backfill").start()
threading.Thread(target=_notify_worker, daemon=True, name="ws-notifier").start()
orthanc.LogInfo("thumb plugin: initialized (worker + backfill + notifier)")
