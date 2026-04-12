import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/patients", tags=["patients"])


@router.get("")
async def list_patients(
    request: Request,
    search: str = None,
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
):
    await log_audit("list_patients", user_id=user["id"], ip_address=request.client.host)

    # Fetch all patients expanded (manageable for a clinic-scale dataset)
    all_patients = await orthanc.get_patients()

    # Server-side search filter
    if search:
        search_lower = search.lower()
        all_patients = [
            p for p in all_patients
            if search_lower in str(p.get("MainDicomTags", {}).get("PatientName", "")).lower()
            or search_lower in str(p.get("MainDicomTags", {}).get("PatientID", "")).lower()
        ]

    total = len(all_patients)

    # Paginate BEFORE enriching — only enrich the visible page
    page = all_patients[offset:offset + limit]

    # Enrich with last study info for each patient in the page
    async def enrich_last_study(patient: dict) -> dict:
        study_ids = patient.get("Studies", [])
        if not study_ids:
            return patient
        try:
            last_study = await orthanc.get_study(study_ids[-1])
            if last_study:
                tags = last_study.get("MainDicomTags", {})
                # Enrich modality from series if missing
                if not tags.get("ModalitiesInStudy"):
                    series_ids = last_study.get("Series", [])
                    if series_ids:
                        r = await orthanc._http().get(f"/series/{series_ids[0]}")
                        if r.status_code == 200:
                            mod = r.json().get("MainDicomTags", {}).get("Modality")
                            if mod:
                                tags["ModalitiesInStudy"] = mod
                patient["LastStudy"] = {
                    "StudyDate": tags.get("StudyDate"),
                    "StudyDescription": tags.get("StudyDescription"),
                    "ModalitiesInStudy": tags.get("ModalitiesInStudy"),
                }
        except Exception:
            pass
        return patient

    page = list(await asyncio.gather(*[enrich_last_study(p) for p in page]))
    return {"items": page, "total": total}


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
