from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/patients", tags=["patients"])


@router.get("")
async def list_patients(
    request: Request,
    search: str = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
):
    await log_audit("list_patients", user_id=user["id"], ip_address=request.client.host)
    patients = await orthanc.get_patients(limit=limit, since=offset)
    if search:
        search_lower = search.lower()
        patients = [
            p for p in patients
            if search_lower in str(p.get("MainDicomTags", {}).get("PatientName", "")).lower()
            or search_lower in str(p.get("MainDicomTags", {}).get("PatientID", "")).lower()
        ]
    return patients


@router.get("/{patient_id}")
async def get_patient(
    patient_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    patient = await orthanc.get_patient(patient_id)
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")
    await log_audit("view_patient", "patient", patient_id, user_id=user["id"], ip_address=request.client.host)
    studies = await orthanc.get_patient_studies(patient_id)
    return {"patient": patient, "studies": studies}
