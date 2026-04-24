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

import orthanc  # type: ignore[import-not-found]  # provided by Orthanc runtime

THUMB_DIR = "/var/cache/minipacs-thumbs"
# Keep the rate conservative — Orthanc shares its HTTP pool between the
# plugin's RestApiGet calls and real user traffic. 2/sec finishes an 850-
# study backfill in ~7 min without any visible UI slowdown.
RATE_LIMIT_SECONDS = 0.5
QUEUE_MAX = 2000
BACKFILL_DELAY_SECONDS = 30  # let Orthanc fully boot before scanning

os.makedirs(THUMB_DIR, exist_ok=True)

_queue: Queue = Queue(maxsize=QUEUE_MAX)
_seen: set[str] = set()
_seen_lock = threading.Lock()


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

    Strategy: lowest-numbered series' middle slice. Middle beats first
    because the first slice on CT/MR is often a scout/localizer which
    makes a confusing tile.
    """
    study = _get_json(f"/studies/{study_id}")
    if not study:
        return None
    series_ids = study.get("Series", [])
    if not series_ids:
        return None

    best_series = None
    best_num: int | None = None
    for sid in series_ids:
        s = _get_json(f"/series/{sid}")
        if not s:
            continue
        try:
            num = int(s.get("MainDicomTags", {}).get("SeriesNumber") or 999)
        except (TypeError, ValueError):
            num = 999
        if best_num is None or num < best_num:
            best_num = num
            best_series = s

    if not best_series:
        return None

    instances = best_series.get("Instances") or []
    if not instances:
        return None
    return instances[len(instances) // 2]


def _generate(study_id: str) -> str:
    if _thumb_exists(study_id):
        return "skipped"

    instance_id = _pick_instance(study_id)
    if not instance_id:
        return "no_instance"

    try:
        png = orthanc.RestApiGet(f"/instances/{instance_id}/preview")
    except Exception as exc:  # noqa: BLE001
        orthanc.LogWarning(f"thumb: preview failed for {instance_id[:12]}: {exc}")
        return "preview_failed"
    if not png:
        return "empty_png"

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


def on_change(change_type, level, resource):
    # STABLE_STUDY fires once per study after ~60s of ingest inactivity.
    # NEW_STUDY fires immediately but the study may still be receiving
    # more series — STABLE gives us a complete picture.
    if change_type != orthanc.ChangeType.STABLE_STUDY:
        return
    _enqueue(resource)


orthanc.RegisterOnChangeCallback(on_change)
threading.Thread(target=_worker, daemon=True, name="thumb-worker").start()
threading.Thread(target=_backfill, daemon=True, name="thumb-backfill").start()
orthanc.LogInfo("thumb plugin: initialized (worker + backfill scheduled)")
