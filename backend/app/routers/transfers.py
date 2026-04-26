import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.db import PgConnection

from app.database import get_db
from app.models.transfers import TransferRequest
from app.routers.auth import get_current_user
from app.routers.pacs_nodes import _modality_id
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/transfers", tags=["transfers"])


@router.get("")
async def list_transfers(
    request: Request,
    study_id: str = None,
    status: str = None,
    limit: int = Query(default=25, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    await log_audit("list_transfers", user_id=user["id"], ip_address=request.client.host)

    where_clauses = []
    params = []

    if study_id:
        where_clauses.append("t.orthanc_study_id = ?")
        params.append(study_id)
    if status:
        where_clauses.append("t.status = ?")
        params.append(status)

    where_sql = (" WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    # Get total count
    count_cursor = await db.execute(
        f"SELECT COUNT(*) FROM transfer_log t{where_sql}", params
    )
    total = (await count_cursor.fetchone())[0]

    # Get paginated results
    cursor = await db.execute(
        f"""SELECT t.*, p.name as pacs_node_name, p.ae_title as pacs_node_ae_title
            FROM transfer_log t
            LEFT JOIN pacs_nodes p ON t.pacs_node_id = p.id
            {where_sql}
            ORDER BY t.created_at DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    )
    rows = await cursor.fetchall()
    items = [dict(row) for row in rows]

    # Inline study description + patient name. Without this, the frontend
    # had to issue one GET /api/studies/{id} per unique transfer — on a page
    # with 30 unique studies that was 30 round-trips through CF Tunnel
    # (~400 ms each), repeating every 5 s while any transfer was pending.
    # Resolving here, in-Docker (Orthanc round-trip ~5 ms), collapses the
    # whole fan-out into the single /api/transfers response.
    unique_sids = list({it.get("orthanc_study_id") for it in items if it.get("orthanc_study_id")})
    if unique_sids:
        # bounded_get_study: shared semaphore (20 concurrent) + warning logs
        # on Orthanc errors, so a 503 spike doesn't silently blank every row.
        studies = await asyncio.gather(
            *(orthanc.bounded_get_study(sid) for sid in unique_sids),
            return_exceptions=True,
        )
        study_meta: dict[str, tuple[str, str]] = {}
        for sid, study in zip(unique_sids, studies):
            if isinstance(study, BaseException) or not study:
                study_meta[sid] = ("", "")
                continue
            tags = study.get("MainDicomTags", {}) or {}
            pat_tags = study.get("PatientMainDicomTags", {}) or {}
            study_meta[sid] = (
                tags.get("StudyDescription") or "",
                pat_tags.get("PatientName") or "",
            )
        for it in items:
            sid = it.get("orthanc_study_id")
            desc, pname = study_meta.get(sid, ("", ""))
            it["study_description"] = desc
            it["patient_name"] = pname

    return {"items": items, "total": total}


@router.post("", status_code=201)
async def create_transfer(
    body: TransferRequest,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    # Validate PACS node exists and is active
    cursor = await db.execute(
        "SELECT * FROM pacs_nodes WHERE id = ? AND is_active = 1",
        (body.pacs_node_id,),
    )
    node = await cursor.fetchone()
    if not node:
        raise HTTPException(404, "PACS node not found or inactive")

    node = dict(node)
    modality = _modality_id(node["name"])

    # Create transfer log entry
    cursor = await db.execute(
        """INSERT INTO transfer_log (orthanc_study_id, pacs_node_id, initiated_by, status)
           VALUES (?, ?, ?, 'pending')
           RETURNING id""",
        (body.study_id, body.pacs_node_id, user["id"]),
    )
    await db.commit()
    transfer_id = cursor.lastrowid

    # Execute the transfer
    now = datetime.now(timezone.utc)
    try:
        await orthanc.send_to_modality(modality, [body.study_id])
        await db.execute(
            "UPDATE transfer_log SET status='success', completed_at=? WHERE id=?",
            (now, transfer_id),
        )
        await db.commit()
        status = "success"
        error_message = None
    except Exception as exc:
        error_msg = str(exc)
        await db.execute(
            "UPDATE transfer_log SET status='failed', error_message=?, completed_at=? WHERE id=?",
            (error_msg, now, transfer_id),
        )
        await db.commit()
        status = "failed"
        error_message = error_msg

    await log_audit(
        "create_transfer", "transfer", str(transfer_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )

    # Return the created transfer with PACS node info
    cursor = await db.execute(
        """SELECT t.*, p.name as pacs_node_name, p.ae_title as pacs_node_ae_title
           FROM transfer_log t
           LEFT JOIN pacs_nodes p ON t.pacs_node_id = p.id
           WHERE t.id = ?""",
        (transfer_id,),
    )
    transfer = await cursor.fetchone()
    return dict(transfer)


@router.post("/{transfer_id}/retry")
async def retry_transfer(
    transfer_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    cursor = await db.execute(
        """SELECT t.*, p.name as pacs_node_name
           FROM transfer_log t
           LEFT JOIN pacs_nodes p ON t.pacs_node_id = p.id
           WHERE t.id = ?""",
        (transfer_id,),
    )
    transfer = await cursor.fetchone()
    if not transfer:
        raise HTTPException(404, "Transfer not found")

    transfer = dict(transfer)
    if transfer["status"] != "failed":
        raise HTTPException(400, "Only failed transfers can be retried")

    # Verify PACS node still exists and is active
    cursor = await db.execute(
        "SELECT * FROM pacs_nodes WHERE id = ? AND is_active = 1",
        (transfer["pacs_node_id"],),
    )
    node = await cursor.fetchone()
    if not node:
        raise HTTPException(404, "PACS node not found or inactive")

    node = dict(node)
    modality = _modality_id(node["name"])

    # Reset status to pending
    await db.execute(
        "UPDATE transfer_log SET status='pending', error_message=NULL, completed_at=NULL WHERE id=?",
        (transfer_id,),
    )
    await db.commit()

    # Retry the transfer
    now = datetime.now(timezone.utc)
    try:
        await orthanc.send_to_modality(modality, [transfer["orthanc_study_id"]])
        await db.execute(
            "UPDATE transfer_log SET status='success', completed_at=? WHERE id=?",
            (now, transfer_id),
        )
        await db.commit()
    except Exception as exc:
        error_msg = str(exc)
        await db.execute(
            "UPDATE transfer_log SET status='failed', error_message=?, completed_at=? WHERE id=?",
            (error_msg, now, transfer_id),
        )
        await db.commit()

    await log_audit(
        "retry_transfer", "transfer", str(transfer_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )

    cursor = await db.execute(
        """SELECT t.*, p.name as pacs_node_name, p.ae_title as pacs_node_ae_title
           FROM transfer_log t
           LEFT JOIN pacs_nodes p ON t.pacs_node_id = p.id
           WHERE t.id = ?""",
        (transfer_id,),
    )
    result = await cursor.fetchone()
    return dict(result)
