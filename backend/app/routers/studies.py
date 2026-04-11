from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/studies", tags=["studies"])


@router.get("")
async def list_studies(
    request: Request,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
):
    await log_audit("list_studies", user_id=user["id"], ip_address=request.client.host)
    return await orthanc.get_studies(limit=limit, since=offset)


@router.get("/{study_id}")
async def get_study(
    study_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    await log_audit("view_study", "study", study_id, user_id=user["id"], ip_address=request.client.host)
    study = await orthanc.get_study(study_id)
    series = await orthanc.get_study_series(study_id)
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
