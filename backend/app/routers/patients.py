import asyncio

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.database import get_db
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

    try:
        page, total = await orthanc.find_patients(search=search or "", limit=limit, offset=offset)
    except Exception as exc:
        raise HTTPException(502, f"PACS server unavailable: {exc}") from exc

    # NOTE: last-study enrichment used to live here and fired one Orthanc /studies/{id}
    # call per patient (plus a fallback /series/{sid}) — an N+1 that produced
    # 100-200 concurrent HTTP calls for a Dashboard that fetches 100 patients.
    # With HttpThreadsCount=10 that serialized into ~30s of queue time.
    # Patients list UI no longer renders LastStudy (it shows study count from
    # patient.Studies.length), so enrichment is dropped entirely.
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


@router.get("/{patient_id}/full")
async def get_patient_full(
    patient_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """One-shot bundle for PatientDetailPage.

    Replaces 1 + 1 + N separate requests (patient, shares, transfers-per-study)
    with a single round-trip. Transfers for every study of this patient are
    fetched in one SQLite IN(...) query.
    """
    try:
        patient, studies = await asyncio.gather(
            orthanc.get_patient(patient_id),
            orthanc.get_patient_studies(patient_id),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"PACS server unavailable: {exc}") from exc
    if patient is None:
        raise HTTPException(status_code=404, detail="Patient not found")

    # Fire audit in background — view action, doesn't need durability.
    await log_audit("view_patient", "patient", patient_id, user_id=user["id"], ip_address=request.client.host)

    # Shares for this patient. We return has_pin as a boolean instead of the
    # bcrypt digest — the browser never needs the actual hash, and shipping it
    # would be a pointless PHI-adjacent leak.
    cur = await db.execute(
        "SELECT id, orthanc_patient_id, token, is_active, view_count, created_at, "
        "expires_at, first_viewed_at, last_viewed_at, "
        "(pin_hash IS NOT NULL AND pin_hash != '') AS has_pin "
        "FROM patient_shares WHERE orthanc_patient_id = ? ORDER BY created_at DESC",
        (patient_id,),
    )
    shares = [dict(r) for r in await cur.fetchall()]

    # Transfers across every study of this patient — one IN(...) query,
    # replacing the old N-per-study fan-out on the frontend.
    # JOIN pacs_nodes so the UI gets node name+ae without another lookup.
    study_ids = [s["ID"] for s in studies] if studies else []
    transfers = []
    if study_ids:
        placeholders = ",".join("?" * len(study_ids))
        cur = await db.execute(
            f"SELECT t.id, t.orthanc_study_id, t.pacs_node_id, "
            f"n.name AS pacs_node_name, n.ae_title AS pacs_node_ae_title, "
            f"t.status, t.error_message, t.created_at, t.completed_at, t.initiated_by "
            f"FROM transfer_log t LEFT JOIN pacs_nodes n ON n.id = t.pacs_node_id "
            f"WHERE t.orthanc_study_id IN ({placeholders}) "
            f"ORDER BY t.created_at DESC",
            study_ids,
        )
        transfers = [dict(r) for r in await cur.fetchall()]

    return {
        "patient": patient,
        "studies": studies,
        "shares": shares,
        "transfers": transfers,
    }
