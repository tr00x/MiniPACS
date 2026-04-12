from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

import aiosqlite

from app.database import get_db
from app.models.shares import ShareCreate, ShareUpdate
from app.routers.auth import get_current_user
from app.services.auth import generate_share_token
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(tags=["shares"])

# ─── Authenticated endpoints ─────────────────────────────────────────────────
auth_router = APIRouter(prefix="/api/shares")


@auth_router.get("")
async def list_shares(
    request: Request,
    patient_id: str | None = Query(default=None),
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    await log_audit("list_shares", user_id=user["id"], ip_address=request.client.host)
    if patient_id:
        cursor = await db.execute(
            """SELECT s.*, u.username as created_by_username
               FROM patient_shares s
               LEFT JOIN users u ON s.created_by = u.id
               WHERE s.orthanc_patient_id = ?
               ORDER BY s.created_at DESC""",
            (patient_id,),
        )
    else:
        cursor = await db.execute(
            """SELECT s.*, u.username as created_by_username
               FROM patient_shares s
               LEFT JOIN users u ON s.created_by = u.id
               ORDER BY s.created_at DESC""",
        )
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]


@auth_router.post("", status_code=201)
async def create_share(
    body: ShareCreate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    token = generate_share_token()
    expires_at = body.expires_at.isoformat() if body.expires_at else None

    cursor = await db.execute(
        """INSERT INTO patient_shares (orthanc_patient_id, token, expires_at, created_by)
           VALUES (?, ?, ?, ?)""",
        (body.orthanc_patient_id, token, expires_at, user["id"]),
    )
    await db.commit()
    share_id = cursor.lastrowid

    await log_audit(
        "create_share", "share", str(share_id),
        user_id=user["id"], ip_address=request.client.host,
    )

    cursor = await db.execute("SELECT * FROM patient_shares WHERE id = ?", (share_id,))
    share = await cursor.fetchone()
    return dict(share)


@auth_router.put("/{share_id}")
async def update_share(
    share_id: int,
    body: ShareUpdate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute("SELECT * FROM patient_shares WHERE id = ?", (share_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "Share not found")

    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "No fields to update")

    set_clauses = []
    params = []
    if "expires_at" in updates:
        val = updates["expires_at"]
        set_clauses.append("expires_at = ?")
        params.append(val.isoformat() if val else None)
    if "is_active" in updates:
        set_clauses.append("is_active = ?")
        params.append(int(updates["is_active"]) if updates["is_active"] is not None else 0)

    params.append(share_id)
    await db.execute(
        f"UPDATE patient_shares SET {', '.join(set_clauses)} WHERE id = ?",
        tuple(params),
    )
    await db.commit()

    await log_audit(
        "update_share", "share", str(share_id),
        user_id=user["id"], ip_address=request.client.host,
    )

    cursor = await db.execute("SELECT * FROM patient_shares WHERE id = ?", (share_id,))
    share = await cursor.fetchone()
    return dict(share)


@auth_router.delete("/{share_id}", status_code=200)
async def revoke_share(
    share_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute("SELECT * FROM patient_shares WHERE id = ?", (share_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "Share not found")

    # Soft-revoke: set is_active to 0
    await db.execute(
        "UPDATE patient_shares SET is_active = 0 WHERE id = ?",
        (share_id,),
    )
    await db.commit()

    await log_audit(
        "revoke_share", "share", str(share_id),
        user_id=user["id"], ip_address=request.client.host,
    )

    return {"message": "Share revoked"}


# ─── Public patient portal endpoints ─────────────────────────────────────────
portal_router = APIRouter(prefix="/api/patient-portal")


async def _validate_share(token: str, db: aiosqlite.Connection) -> dict:
    """Validate a share token and return the share record, or raise appropriate HTTP error."""
    cursor = await db.execute(
        "SELECT * FROM patient_shares WHERE token = ?", (token,),
    )
    share = await cursor.fetchone()
    if not share:
        raise HTTPException(404, "Link not found")

    share = dict(share)

    if not share["is_active"]:
        raise HTTPException(410, "This link has been revoked. Please contact the clinic.")

    if share["expires_at"]:
        expires = datetime.fromisoformat(share["expires_at"])
        # Handle naive datetimes from sqlite by assuming UTC
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > expires:
            raise HTTPException(410, "This link has expired. Please contact the clinic.")

    return share


@portal_router.get("/{token}")
async def patient_portal(
    token: str,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
):
    share = await _validate_share(token, db)

    # Update view tracking
    now = datetime.now(timezone.utc).isoformat()
    if share["first_viewed_at"] is None:
        await db.execute(
            "UPDATE patient_shares SET view_count = view_count + 1, first_viewed_at = ?, last_viewed_at = ? WHERE id = ?",
            (now, now, share["id"]),
        )
    else:
        await db.execute(
            "UPDATE patient_shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?",
            (now, share["id"]),
        )
    await db.commit()

    await log_audit(
        "patient_portal_view", "share", str(share["id"]),
        patient_token=token, ip_address=request.client.host,
    )

    # Fetch patient data and studies from Orthanc
    try:
        patient = await orthanc.get_patient(share["orthanc_patient_id"])
        studies = await orthanc.get_patient_studies(share["orthanc_patient_id"])
    except Exception:
        raise HTTPException(502, "Unable to retrieve patient data")

    return {
        "patient": patient,
        "studies": studies,
        "share": {
            "orthanc_patient_id": share["orthanc_patient_id"],
            "expires_at": share["expires_at"],
        },
    }


@portal_router.get("/{token}/download/{study_id}")
async def patient_portal_download(
    token: str,
    study_id: str,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
):
    share = await _validate_share(token, db)

    # Verify the study belongs to the patient in this share
    try:
        patient = await orthanc.get_patient(share["orthanc_patient_id"])
    except Exception:
        raise HTTPException(502, "Unable to retrieve patient data")

    patient_studies = patient.get("Studies", [])
    if study_id not in patient_studies:
        raise HTTPException(403, "Study does not belong to this patient")

    await log_audit(
        "patient_portal_download", "study", study_id,
        patient_token=token, ip_address=request.client.host,
    )

    return StreamingResponse(
        orthanc.download_study_stream(study_id),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=study-{study_id}.zip"},
    )


# Include both sub-routers
router.include_router(auth_router)
router.include_router(portal_router)
