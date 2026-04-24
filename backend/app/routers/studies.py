import asyncio
import io
import os
import time
import zipfile as zipfile_mod

from app.db import PgConnection
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse

from app.database import get_db
from app.routers.auth import get_current_user
from app.services import orthanc
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


@router.get("")
async def list_studies(
    request: Request,
    search: str = "",
    modality: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
):
    await log_audit("list_studies", user_id=user["id"], ip_address=request.client.host)

    try:
        page, total = await orthanc.find_studies(
            search=search, modality=modality,
            date_from=date_from, date_to=date_to,
            limit=limit, offset=offset,
        )
    except Exception as exc:
        raise HTTPException(502, f"PACS server unavailable: {exc}") from exc

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

    Resolves the first series' middle instance (more representative than the
    very first slice) and proxies Orthanc's /instances/{id}/preview. Cached
    in-process for 1h — grid reopens and back navigation never re-render.
    """
    hit = _thumb_cache.get(study_id)
    now = time.time()
    if hit and now - hit[0] < _THUMB_TTL:
        return Response(
            content=hit[1],
            media_type="image/png",
            headers={"Cache-Control": "private, max-age=3600"},
        )

    # Fast path: Orthanc plugin already wrote this one to disk. Single fs stat
    # + read, no PACS round-trip. We still populate the in-memory cache so
    # subsequent hits skip even the syscalls.
    disk_path = os.path.join(_THUMB_DIR, f"{study_id}.png")
    try:
        if os.path.isfile(disk_path):
            with open(disk_path, "rb") as f:
                png_disk = f.read()
            _thumb_cache[study_id] = (now, png_disk)
            if len(_thumb_cache) > _THUMB_CACHE_MAX:
                _thumb_cache.pop(next(iter(_thumb_cache)))
            return Response(
                content=png_disk,
                media_type="image/png",
                headers={"Cache-Control": "private, max-age=3600"},
            )
    except OSError:
        # Volume missing or permission oddity — fall through to on-demand.
        pass

    series_list = await orthanc.get_study_series(study_id)
    if not series_list:
        raise HTTPException(status_code=404, detail="Study has no series")

    def _series_num(s):
        try:
            return int(s.get("MainDicomTags", {}).get("SeriesNumber") or 999)
        except ValueError:
            return 999

    first_series = sorted(series_list, key=_series_num)[0]
    instances = first_series.get("Instances") or []
    if not instances:
        raise HTTPException(status_code=404, detail="Series has no instances")
    # Middle slice ≈ diagnostic preview. First slice on CT/MR is often a scout
    # or localizer, which makes a confusing grid tile.
    instance_id = instances[len(instances) // 2]

    try:
        resp = await orthanc._http().get(f"/instances/{instance_id}/preview")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Orthanc preview failed: {exc}") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Orthanc preview HTTP {resp.status_code}")
    png = resp.content

    _thumb_cache[study_id] = (now, png)
    if len(_thumb_cache) > _THUMB_CACHE_MAX:
        _thumb_cache.pop(next(iter(_thumb_cache)))

    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=3600"},
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

    buf = io.BytesIO()
    with zipfile_mod.ZipFile(buf, "w", zipfile_mod.ZIP_DEFLATED) as zf:
        for i, iid in enumerate(instance_ids, 1):
            try:
                resp = await orthanc._http().get(f"/instances/{iid}/preview")
                if resp.status_code == 200:
                    zf.writestr(f"{series_desc}_{i:04d}.jpg", resp.content)
            except Exception:
                pass

    buf.seek(0)
    return StreamingResponse(
        iter([buf.read()]),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={series_desc}-images.zip"},
    )
