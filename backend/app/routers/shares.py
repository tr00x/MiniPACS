import asyncio
import hashlib
import io
import zipfile as zipfile_mod
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.db import PgConnection

from app.database import get_db
from app.models.shares import ShareCreate, ShareUpdate
from app.routers.auth import get_current_user
from app.services.auth import generate_share_token, hash_password, verify_password
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
    db: PgConnection = Depends(get_db),
):
    await log_audit("list_shares", user_id=user["id"], ip_address=request.client.host)
    # Whitelist columns instead of s.* so the bcrypt pin_hash never leaves the
    # server. Client only needs to know whether the share has a PIN.
    select_cols = (
        "s.id, s.orthanc_patient_id, s.token, s.expires_at, s.created_by, "
        "s.created_at, s.is_active, s.view_count, s.first_viewed_at, s.last_viewed_at, "
        "(s.pin_hash IS NOT NULL AND s.pin_hash != '') AS has_pin, "
        "u.username AS created_by_username"
    )
    if patient_id:
        cursor = await db.execute(
            f"""SELECT {select_cols}
               FROM patient_shares s
               LEFT JOIN users u ON s.created_by = u.id
               WHERE s.orthanc_patient_id = ?
               ORDER BY s.created_at DESC""",
            (patient_id,),
        )
    else:
        cursor = await db.execute(
            f"""SELECT {select_cols}
               FROM patient_shares s
               LEFT JOIN users u ON s.created_by = u.id
               ORDER BY s.created_at DESC""",
        )
    rows = await cursor.fetchall()
    items = [dict(row) for row in rows]

    # Inline patient name. The old frontend pulled /api/patients?limit=100
    # to build a local lookup table — that broke once the archive grew past
    # 100 patients (everything after that just rendered as a raw orthanc id).
    # Resolving here scales with shares-on-page (typically <50), is one
    # in-Docker round-trip per unique patient, and removes a bug, not just a
    # fan-out.
    unique_pids = list({it.get("orthanc_patient_id") for it in items if it.get("orthanc_patient_id")})
    if unique_pids:
        # bounded_get_patient: shared semaphore + warning on Orthanc errors,
        # so transient 5xx don't silently blank patient names for the page.
        patients = await asyncio.gather(
            *(orthanc.bounded_get_patient(pid) for pid in unique_pids),
            return_exceptions=True,
        )
        name_by_pid: dict[str, str] = {}
        for pid, patient in zip(unique_pids, patients):
            if isinstance(patient, BaseException) or not patient:
                name_by_pid[pid] = ""
                continue
            tags = patient.get("MainDicomTags", {}) or {}
            name_by_pid[pid] = tags.get("PatientName") or ""
        for it in items:
            it["patient_name"] = name_by_pid.get(it.get("orthanc_patient_id"), "")

    return items


@auth_router.post("", status_code=201)
async def create_share(
    body: ShareCreate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    token = generate_share_token()
    expires_at = body.expires_at.isoformat() if body.expires_at else None

    pin_hash = None
    if body.pin:
        pin_hash = hash_password(body.pin)

    cursor = await db.execute(
        """INSERT INTO patient_shares (orthanc_patient_id, token, expires_at, created_by, pin_hash)
           VALUES (?, ?, ?, ?, ?)
           RETURNING id""",
        (body.orthanc_patient_id, token, expires_at, user["id"], pin_hash),
    )
    await db.commit()
    share_id = cursor.lastrowid

    await log_audit(
        "create_share", "share", str(share_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )

    cursor = await db.execute("SELECT * FROM patient_shares WHERE id = ?", (share_id,))
    share = await cursor.fetchone()
    result = dict(share)
    # Return plain PIN once so frontend can display it at creation time only
    if body.pin:
        result["pin_display"] = body.pin
    return result


@auth_router.put("/{share_id}")
async def update_share(
    share_id: int,
    body: ShareUpdate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
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
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )

    cursor = await db.execute("SELECT * FROM patient_shares WHERE id = ?", (share_id,))
    share = await cursor.fetchone()
    return dict(share)


@auth_router.delete("/{share_id}", status_code=200)
async def revoke_share(
    share_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
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
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )

    return {"message": "Share revoked"}


# ─── Public patient portal endpoints ─────────────────────────────────────────
portal_router = APIRouter(prefix="/api/patient-portal")


async def _validate_share(token: str, db: PgConnection) -> dict:
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


@portal_router.get("/{token}/info")
async def share_info(
    token: str,
    db: PgConnection = Depends(get_db),
):
    """Get basic share info (no PHI) -- used to show PIN prompt."""
    cursor = await db.execute(
        "SELECT token, pin_hash, is_active, expires_at FROM patient_shares WHERE token = ?",
        (token,),
    )
    share = await cursor.fetchone()
    if not share:
        raise HTTPException(404, "Link not found")
    share = dict(share)

    if not share["is_active"]:
        raise HTTPException(410, "This link has been revoked.")

    if share["expires_at"]:
        expires = datetime.fromisoformat(share["expires_at"])
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > expires:
            raise HTTPException(410, "This link has expired.")

    return {
        "has_pin": bool(share.get("pin_hash")),
        "expires_at": share["expires_at"],
    }


@portal_router.post("/{token}/verify-pin")
async def verify_share_pin(
    token: str,
    request: Request,
    db: PgConnection = Depends(get_db),
):
    """Verify PIN for a share. Returns 200 if correct, 401 if wrong. Sets cookie for server-side enforcement."""
    body = await request.json()
    pin = body.get("pin", "")

    cursor = await db.execute(
        "SELECT * FROM patient_shares WHERE token = ?", (token,),
    )
    share = await cursor.fetchone()
    if not share:
        raise HTTPException(404, "Link not found")
    share = dict(share)

    if not share.get("pin_hash"):
        return {"verified": True}

    if not verify_password(pin, share["pin_hash"]):
        raise HTTPException(401, "Invalid PIN")

    # Set httponly cookie for server-side PIN verification
    token_hash = hashlib.sha256(token.encode()).hexdigest()[:16]
    response = JSONResponse({"verified": True})
    response.set_cookie(
        key=f"pin_{token_hash}",
        value=token_hash,
        max_age=1800,  # 30 minutes
        httponly=True,
        samesite="strict",
    )
    return response


@portal_router.get("/{token}")
async def patient_portal(
    token: str,
    request: Request,
    db: PgConnection = Depends(get_db),
):
    share = await _validate_share(token, db)

    # Server-side PIN enforcement: require cookie set by verify-pin
    if share.get("pin_hash"):
        token_hash = hashlib.sha256(token.encode()).hexdigest()[:16]
        if request.cookies.get(f"pin_{token_hash}") != token_hash:
            raise HTTPException(403, "PIN verification required")

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
        patient_token=token, ip_address=request.client.host, wait=True,
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
            "has_pin": bool(share.get("pin_hash")),
        },
    }


@portal_router.get("/{token}/download/{study_id}")
async def patient_portal_download(
    token: str,
    study_id: str,
    request: Request,
    db: PgConnection = Depends(get_db),
):
    share = await _validate_share(token, db)

    # Server-side PIN enforcement
    if share.get("pin_hash"):
        token_hash = hashlib.sha256(token.encode()).hexdigest()[:16]
        if request.cookies.get(f"pin_{token_hash}") != token_hash:
            raise HTTPException(403, "PIN verification required")

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
        patient_token=token, ip_address=request.client.host, wait=True,
    )

    return StreamingResponse(
        orthanc.download_study_stream(study_id),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=study-{study_id}.zip"},
    )


@portal_router.get("/{token}/download-images/{study_id}/{series_id}")
async def patient_portal_download_series_images(
    token: str,
    study_id: str,
    series_id: str,
    request: Request,
    db: PgConnection = Depends(get_db),
):
    """Download a single series as ZIP of JPEG images (patient portal)."""
    share = await _validate_share(token, db)

    # Server-side PIN enforcement
    if share.get("pin_hash"):
        token_hash = hashlib.sha256(token.encode()).hexdigest()[:16]
        if request.cookies.get(f"pin_{token_hash}") != token_hash:
            raise HTTPException(403, "PIN verification required")

    # Verify study belongs to patient
    try:
        patient = await orthanc.get_patient(share["orthanc_patient_id"])
    except Exception:
        raise HTTPException(502, "Unable to retrieve patient data")

    if study_id not in patient.get("Studies", []):
        raise HTTPException(403, "Study does not belong to this patient")

    # Verify series belongs to study
    study_data = await orthanc.get_study(study_id)
    if series_id not in study_data.get("Series", []):
        raise HTTPException(403, "Series does not belong to this study")

    await log_audit(
        "patient_portal_download_images", "series", series_id,
        patient_token=token, ip_address=request.client.host, wait=True,
    )

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


# Include both sub-routers
router.include_router(auth_router)
router.include_router(portal_router)
