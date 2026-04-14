import io
import zipfile as zipfile_mod

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/studies", tags=["studies"])


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
