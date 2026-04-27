import asyncio
import base64
import io
import logging
import os
import re
import shutil
import time
from datetime import datetime, timezone

_log = logging.getLogger(__name__)

from app.db import PgConnection
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from PIL import Image
from starlette.background import BackgroundTask
from stream_zip import async_stream_zip, ZIP_64

from app.database import get_db
from app.routers.auth import get_current_user
from app.services import iso_builder, orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/studies", tags=["studies"])

# TTL cache for /api/studies/{id}/full. Per-study bundle (series list, pacs
# nodes, viewers, reports) rarely changes second-to-second; Orthanc series
# metadata takes ~1.5s on a 11+ series study, so caching the aggregate
# response makes back-navigation instant. Keyed by study_id; bounded to 64
# entries FIFO so memory stays under 50 MB on worst case.
_STUDY_FULL_TTL = 15.0
_study_full_cache: dict[str, tuple[float, dict]] = {}

# Worklist thumbnails. Two tiers:
#  1. Orthanc Python plugin (`orthanc/python/thumbnails.py`) pre-generates
#     PNGs to /srv/thumbs on STABLE_STUDY + one-shot backfill of the archive.
#  2. On-demand fallback: if the disk copy is missing (ingest still in
#     flight, or the worker queue is behind), we render via Orthanc /preview
#     and memoize for 1h.
# The in-memory cache is bounded to keep RAM predictable —
# 500 thumbs × ~50 KB = ~25 MB max.
_THUMB_DIR = "/srv/thumbs"
_THUMB_TTL = 3600.0
_THUMB_CACHE_MAX = 500
_thumb_cache: dict[str, tuple[float, bytes]] = {}
# Single-flight gate: when a worklist scroll fires N concurrent /thumb
# requests for the same study, only one decodes through Pillow; the rest
# await the Event and read the cache the winner populated.
_thumb_inflight: dict[str, asyncio.Event] = {}


# Thumbnail target: 96 px square is plenty for grid view (cards are 64-80
# px on screen at 1x), WebP @ q=70 lands at 2-5 KB per thumb. The Orthanc
# Python plugin writes raw `/instances/{id}/preview` PNGs to disk — those
# can run 1-2 MB each on full-resolution scans, so we always re-encode
# before serving. Without this resize a 50-study worklist returned 27 MB
# and stalled CF Tunnel ~20 s.
_THUMB_TARGET_PX = 96
_THUMB_QUALITY = 70


def _resize_to_webp(raw: bytes) -> bytes | None:
    """Decode any common image format Orthanc returns and re-encode as a
    96 px WebP. Synchronous (Pillow has no async API) — callers must
    dispatch via asyncio.to_thread. Returns None on decode/encode failure
    (callers fall through to the next cache tier). Never returns the
    original bytes — that path silently persisted a non-WebP file under a
    .webp name and served it forever after with image/webp Content-Type."""
    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.thumbnail((_THUMB_TARGET_PX, _THUMB_TARGET_PX), Image.Resampling.LANCZOS)
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            out = io.BytesIO()
            im.save(out, format="WEBP", quality=_THUMB_QUALITY, method=6)
            return out.getvalue()
    except Exception as exc:
        _log.warning("thumb resize failed: %s", exc)
        return None


def _is_webp(buf: bytes) -> bool:
    # RIFF....WEBP — magic bytes 0..3 = b"RIFF", 8..11 = b"WEBP".
    return len(buf) > 12 and buf[:4] == b"RIFF" and buf[8:12] == b"WEBP"


def _persist_webp(study_id: str, webp: bytes) -> None:
    """Write a WebP sibling next to the plugin-generated PNG so a backend
    restart doesn't re-pay the resize cost on every study. Atomic via
    rename — the read path tolerates a brief tmp file. Refuses to write
    if the bytes don't carry the WebP magic (defense in depth — callers
    already filter None resize results)."""
    if not _is_webp(webp):
        _log.warning("thumb persist refused for %s: bytes not WebP", study_id[:12])
        return
    path = os.path.join(_THUMB_DIR, f"{study_id}.webp")
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(webp)
        os.replace(tmp, path)
    except OSError as exc:
        _log.warning("thumb persist failed for %s: %s", study_id[:12], exc)
        try:
            os.remove(tmp)
        except OSError:
            pass


async def _load_thumb(study_id: str) -> bytes | None:
    """Resolve a study's WebP thumbnail through the 4-tier cache.

    Returns small (~2-5 KB) WebP bytes on success, None when the study has
    no renderable series.

    Lookup order:
      1. in-memory FIFO cache (~1ms)
      2. disk WebP (~5ms, written by us on previous hit) — survives restart
      3. disk PNG (~50ms, written by Orthanc plugin) — resize + persist WebP
      4. Orthanc /preview fallback (~100-300ms) — resize + persist WebP
    """
    hit = _thumb_cache.get(study_id)
    now = time.time()
    if hit and now - hit[0] < _THUMB_TTL:
        return hit[1]

    webp_path = os.path.join(_THUMB_DIR, f"{study_id}.webp")
    png_path = os.path.join(_THUMB_DIR, f"{study_id}.png")

    # Tier 2: pre-rendered WebP from a previous backend lifetime. Skip if
    # the source PNG has been touched more recently — plugin overwrites
    # X.png when new series merge into the study, and the WebP we made
    # earlier may now be of an outdated middle-instance.
    try:
        if os.path.isfile(webp_path):
            webp_mtime = os.path.getmtime(webp_path)
            png_mtime = os.path.getmtime(png_path) if os.path.isfile(png_path) else 0
            if webp_mtime >= png_mtime:
                with open(webp_path, "rb") as f:
                    webp = f.read()
                if _is_webp(webp):
                    # Pop-then-set so a re-insert of an existing key moves
                    # it to the tail of insertion order. Without the pop,
                    # FIFO eviction could throw out the entry we just
                    # refreshed.
                    _thumb_cache.pop(study_id, None)
                    _thumb_cache[study_id] = (now, webp)
                    if len(_thumb_cache) > _THUMB_CACHE_MAX:
                        _thumb_cache.pop(next(iter(_thumb_cache)))
                    return webp
                # Bad bytes on disk (legacy or partial write) — drop and
                # fall through to re-render.
                _log.warning("thumb tier-2: %s.webp not WebP, re-rendering", study_id[:12])
    except OSError:
        pass

    # Single-flight gate for tier-3/4: a worklist scroll fires N concurrent
    # /thumb requests for the same study; without coalescing each request
    # decodes + encodes through Pillow independently. The dict is keyed by
    # study_id; the first arrival creates an Event, does the work, and
    # signals; the rest await and read the cache.
    inflight = _thumb_inflight.get(study_id)
    if inflight is not None:
        await inflight.wait()
        hit = _thumb_cache.get(study_id)
        if hit and now - hit[0] < _THUMB_TTL:
            return hit[1]
        # winner returned None → fall through and try ourselves
    inflight = asyncio.Event()
    _thumb_inflight[study_id] = inflight
    try:
        return await _resolve_thumb_uncached(study_id, png_path, now)
    finally:
        inflight.set()
        _thumb_inflight.pop(study_id, None)


async def _resolve_thumb_uncached(study_id: str, png_path: str, now: float) -> bytes | None:
    """Tier-3/4 path. Tries the plugin PNG on disk first, then falls back
    to /preview against Orthanc. Persists a WebP on success so the next
    backend lifetime gets a tier-2 hit."""
    # Tier 3: plugin PNG → resize + persist.
    try:
        if os.path.isfile(png_path):
            with open(png_path, "rb") as f:
                png_disk = f.read()
            webp = await asyncio.to_thread(_resize_to_webp, png_disk)
            if webp is not None:
                await asyncio.to_thread(_persist_webp, study_id, webp)
                _thumb_cache.pop(study_id, None)
                _thumb_cache[study_id] = (now, webp)
                if len(_thumb_cache) > _THUMB_CACHE_MAX:
                    _thumb_cache.pop(next(iter(_thumb_cache)))
                return webp
            # resize failed — try the live Orthanc path before giving up
    except OSError:
        pass

    # Tier 4: ondemand fallback against Orthanc.
    try:
        series_list = await orthanc.get_study_series(study_id)
    except Exception:
        return None
    if not series_list:
        return None

    def _series_num(s):
        try:
            return int(s.get("MainDicomTags", {}).get("SeriesNumber") or 999)
        except ValueError:
            return 999

    first_series = sorted(series_list, key=_series_num)[0]
    instances = first_series.get("Instances") or []
    if not instances:
        return None
    instance_id = instances[len(instances) // 2]

    try:
        resp = await orthanc._http().get(f"/instances/{instance_id}/preview")
    except Exception:
        return None
    if resp.status_code != 200:
        return None
    webp = await asyncio.to_thread(_resize_to_webp, resp.content)
    if webp is None:
        return None
    await asyncio.to_thread(_persist_webp, study_id, webp)

    _thumb_cache.pop(study_id, None)
    _thumb_cache[study_id] = (now, webp)
    if len(_thumb_cache) > _THUMB_CACHE_MAX:
        _thumb_cache.pop(next(iter(_thumb_cache)))
    return webp


_SAFE_FILENAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _sanitize_filename(name: str | None) -> str:
    """Strip path separators / control chars from a DICOM tag before using
    it in Content-Disposition. Without this, a SeriesDescription containing
    `/` or `\\0` would produce a broken header and a corrupt download."""
    if not name:
        return "series"
    cleaned = _SAFE_FILENAME_RE.sub("_", name).strip("._-")
    return cleaned[:80] or "series"


async def _zip_series_previews(instance_ids: list[str], safe_desc: str):
    """Streaming ZIP generator for series-image downloads.

    Issues all preview fetches in parallel through bounded_get_instance_preview
    (gated by _BATCH_SEM(20)) and yields zip entries via asyncio.as_completed —
    so the first byte of the zip ships as soon as the *fastest* preview lands,
    not after every one. Order of files in the archive matches arrival order;
    the 4-digit index in the filename preserves clinical sequencing for
    extracted-folder views regardless of zip storage order.
    """
    modified = datetime.now(timezone.utc)
    tasks = [
        asyncio.create_task(_fetch_preview_with_index(idx, iid))
        for idx, iid in enumerate(instance_ids, 1)
    ]
    try:
        for coro in asyncio.as_completed(tasks):
            idx, content = await coro
            if not content:
                continue

            async def chunks(data: bytes = content):
                yield data

            yield (
                f"{safe_desc}_{idx:04d}.jpg",
                modified,
                0o644,
                ZIP_64,
                chunks(),
            )
    finally:
        # Cancel any in-flight fetches if the client disconnects mid-stream.
        for t in tasks:
            if not t.done():
                t.cancel()


async def _fetch_preview_with_index(idx: int, iid: str) -> tuple[int, bytes | None]:
    return idx, await orthanc.bounded_get_instance_preview(iid)


@router.get("")
async def list_studies(
    request: Request,
    search: str = "",
    modality: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    include: str = "",
    sort_by: str = Query(default="", pattern="^(date|patient|description|)$"),
    sort_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    user: dict = Depends(get_current_user),
):
    await log_audit("list_studies", user_id=user["id"], ip_address=request.client.host)

    try:
        page, total = await orthanc.find_studies(
            search=search, modality=modality,
            date_from=date_from, date_to=date_to,
            limit=limit, offset=offset,
            sort_by=sort_by, sort_dir=sort_dir,
        )
    except Exception as exc:
        raise HTTPException(502, f"PACS server unavailable: {exc}") from exc

    # Inline thumbnails — collapses the worklist's per-study GET fan-out
    # (50 cards × ~400 ms CF Tunnel overhead) into one bulk fetch. Callers
    # opt in via ?include=thumbs so plain list views don't pay the payload.
    if "thumbs" in {tok.strip() for tok in include.split(",") if tok.strip()}:
        ids = [s.get("ID") for s in page if s.get("ID")]

        async def _bounded(sid: str):
            # Share the global Orthanc batch budget so worklist + transfers
            # + shares can't collectively storm Orthanc.
            async with orthanc._BATCH_SEM:
                return await _load_thumb(sid)

        thumbs = await asyncio.gather(*(_bounded(sid) for sid in ids), return_exceptions=True)
        thumb_map: dict[str, bytes | None] = {}
        for sid, webp in zip(ids, thumbs):
            if isinstance(webp, BaseException) or not webp:
                thumb_map[sid] = None
            else:
                thumb_map[sid] = webp
        for s in page:
            webp = thumb_map.get(s.get("ID"))
            # Bare base64; the frontend wraps with data:image/webp;base64,
            # before binding to <img src>.
            s["thumb_b64"] = base64.b64encode(webp).decode("ascii") if webp else None

    return {"items": page, "total": total}


@router.get("/{study_id}")
async def get_study(
    study_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    study = await orthanc.get_study(study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")
    await log_audit("view_study", "study", study_id, user_id=user["id"], ip_address=request.client.host)
    series = await orthanc.get_study_series(study_id)
    # Enrich study with modalities from already-loaded series
    study_tags = study.get("MainDicomTags", {})
    if not study_tags.get("ModalitiesInStudy"):
        modalities = set()
        for s in series:
            mod = s.get("MainDicomTags", {}).get("Modality")
            if mod:
                modalities.add(mod)
        if modalities:
            study_tags["ModalitiesInStudy"] = "/".join(sorted(modalities))
    # Fill instance counts from Instances array if not in tags
    for s in series:
        tags = s.get("MainDicomTags", {})
        if not tags.get("NumberOfSeriesRelatedInstances"):
            tags["NumberOfSeriesRelatedInstances"] = str(len(s.get("Instances", [])))
    return {"study": study, "series": series}


@router.get("/{study_id}/full")
async def get_study_full(
    study_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    """One-shot bundle for StudyDetailPage.

    Collapses 4 separate calls (study, pacs-nodes, viewers, reports) that the
    Study detail UI needs on open into one round-trip. 15s TTL cache on the
    whole payload — re-opening the same study (back-nav, tab switch) is
    served instantly.
    """
    cached = _study_full_cache.get(study_id)
    if cached and time.time() - cached[0] < _STUDY_FULL_TTL:
        # Still audit the view (fire-and-forget)
        await log_audit("view_study", "study", study_id, user_id=user["id"], ip_address=request.client.host)
        return cached[1]

    try:
        study, series = await asyncio.gather(
            orthanc.get_study(study_id),
            orthanc.get_study_series(study_id),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PACS server unavailable: {exc}") from exc
    if study is None:
        raise HTTPException(status_code=404, detail="Study not found")

    await log_audit("view_study", "study", study_id, user_id=user["id"], ip_address=request.client.host)

    # Derive ModalitiesInStudy from series if missing (reuse existing logic).
    study_tags = study.get("MainDicomTags", {})
    if not study_tags.get("ModalitiesInStudy"):
        modalities = {s.get("MainDicomTags", {}).get("Modality") for s in series}
        modalities.discard(None)
        if modalities:
            study_tags["ModalitiesInStudy"] = "/".join(sorted(modalities))
    for s in series:
        tags = s.get("MainDicomTags", {})
        if not tags.get("NumberOfSeriesRelatedInstances"):
            tags["NumberOfSeriesRelatedInstances"] = str(len(s.get("Instances", [])))

    # PACS nodes, viewers, reports — all from SQLite, sequential on one
    # connection is fine (these are sub-millisecond).
    cur = await db.execute(
        "SELECT id, name, ae_title, ip, port, description, is_active, last_echo_at "
        "FROM pacs_nodes ORDER BY name"
    )
    pacs_nodes = [dict(r) for r in await cur.fetchall()]

    cur = await db.execute(
        "SELECT id, name, icon, url_scheme, is_enabled, sort_order "
        "FROM external_viewers WHERE is_enabled = 1 ORDER BY sort_order, name"
    )
    viewers = [dict(r) for r in await cur.fetchall()]

    cur = await db.execute(
        "SELECT r.id, r.orthanc_study_id, r.title, r.report_type, r.content, "
        "r.filename, r.created_by, u.username AS created_by_username, r.created_at "
        "FROM study_reports r LEFT JOIN users u ON u.id = r.created_by "
        "WHERE r.orthanc_study_id = ? ORDER BY r.created_at DESC",
        (study_id,),
    )
    reports = [dict(r) for r in await cur.fetchall()]

    result = {
        "study": study,
        "series": series,
        "pacs_nodes": pacs_nodes,
        "viewers": viewers,
        "reports": reports,
    }
    _study_full_cache[study_id] = (time.time(), result)
    if len(_study_full_cache) > 64:
        _study_full_cache.pop(next(iter(_study_full_cache)))
    return result


@router.get("/{study_id}/thumb")
async def get_study_thumbnail(
    study_id: str,
    user: dict = Depends(get_current_user),
):
    """PNG thumbnail for the worklist grid view.

    Single-study fallback path. The grid normally pulls thumbnails inline
    via `/api/studies?include=thumbs`; this endpoint stays for detail views,
    cache misses, and any consumer that hasn't migrated to the bulk path.
    """
    webp = await _load_thumb(study_id)
    if webp is None:
        raise HTTPException(status_code=404, detail="No renderable thumbnail")
    # Thumbnails are derived from a Study's middle-instance preview; the
    # underlying SOP Instance UID is immutable, so a once-rendered image is
    # safe to pin as immutable. Year-long max-age tells the browser to skip
    # revalidation entirely — 0 RTT on every worklist re-render.
    return Response(
        content=webp,
        media_type="image/webp",
        headers={"Cache-Control": "private, immutable, max-age=31536000"},
    )


@router.get("/{study_id}/series/{series_id}")
async def get_series_detail(
    study_id: str,
    series_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    await log_audit("view_series", "series", series_id, user_id=user["id"], ip_address=request.client.host)
    series = await orthanc.get_series(series_id)
    instances = await orthanc.get_series_instances(series_id)
    return {"series": series, "instances": instances}


@router.get("/{study_id}/download")
async def download_study(
    study_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    await log_audit("download_study", "study", study_id, user_id=user["id"], ip_address=request.client.host)
    return StreamingResponse(
        orthanc.download_study_stream(study_id),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=study-{study_id}.zip"},
    )


@router.get("/{study_id}/burn-iso")
async def burn_study_iso(
    study_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Build and stream a bootable ISO for the study — DICOM files + DICOMDIR
    + bundled DWV (HTML5 DICOM viewer). Patient or referring physician can
    either burn this image to a CD/DVD via Windows "Burn files to disc" or
    write it to USB via Rufus / balenaEtcher / dd."""
    try:
        meta = await orthanc.get_study(study_id)
        accession = (meta.get("MainDicomTags") or {}).get("AccessionNumber") or None
    except Exception:
        accession = None

    await log_audit(
        "export_study_iso", "study", study_id,
        user_id=user["id"], ip_address=request.client.host,
    )

    iso_path, tempdir = await iso_builder.build_study_iso(study_id, accession)

    def _iter_iso():
        with iso_path.open("rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk

    def _cleanup():
        shutil.rmtree(tempdir, ignore_errors=True)

    safe_label = _sanitize_filename(accession or study_id[:8])
    return StreamingResponse(
        _iter_iso(),
        media_type="application/x-iso9660-image",
        headers={"Content-Disposition": f'attachment; filename="study-{safe_label}.iso"'},
        background=BackgroundTask(_cleanup),
    )


@router.get("/{study_id}/series/{series_id}/download")
async def download_series(
    study_id: str,
    series_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Download a single series as a DICOM ZIP archive."""
    await log_audit("download_series", "series", series_id, user_id=user["id"], ip_address=request.client.host)

    async def stream():
        req = orthanc._http().build_request("GET", f"/series/{series_id}/archive")
        resp = await orthanc._http().send(req, stream=True)
        resp.raise_for_status()
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()

    return StreamingResponse(
        stream(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=series-{series_id}.zip"},
    )


@router.get("/{study_id}/series/{series_id}/download-images")
async def download_series_images(
    study_id: str,
    series_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """Download series as ZIP of JPEG images (for patients who can't open DICOM)."""
    await log_audit("download_series_images", "series", series_id, user_id=user["id"], ip_address=request.client.host)

    series_data = await orthanc.get_series(series_id)
    instance_ids = series_data.get("Instances", [])
    series_desc = series_data.get("MainDicomTags", {}).get("SeriesDescription", "series")
    safe_desc = _sanitize_filename(series_desc)

    return StreamingResponse(
        async_stream_zip(_zip_series_previews(instance_ids, safe_desc)),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe_desc}-images.zip"'},
    )
