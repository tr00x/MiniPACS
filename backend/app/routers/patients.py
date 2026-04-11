from fastapi import APIRouter, Depends, Request

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/patients", tags=["patients"])


@router.get("")
async def list_patients(
    request: Request,
    search: str = None,
    user: dict = Depends(get_current_user),
):
    await log_audit("list_patients", user_id=user["id"], ip_address=request.client.host)
    patients = await orthanc.get_patients()
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
    await log_audit("view_patient", "patient", patient_id, user_id=user["id"], ip_address=request.client.host)
    patient = await orthanc.get_patient(patient_id)
    studies = await orthanc.get_patient_studies(patient_id)
    return {"patient": patient, "studies": studies}
