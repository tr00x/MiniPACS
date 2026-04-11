from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

import aiosqlite

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
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    await log_audit("list_transfers", user_id=user["id"], ip_address=request.client.host)
    cursor = await db.execute(
        """SELECT t.*, p.name as pacs_node_name, p.ae_title as pacs_node_ae_title
           FROM transfer_log t
           LEFT JOIN pacs_nodes p ON t.pacs_node_id = p.id
           ORDER BY t.created_at DESC""",
    )
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]


@router.post("", status_code=201)
async def create_transfer(
    body: TransferRequest,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
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
           VALUES (?, ?, ?, 'pending')""",
        (body.study_id, body.pacs_node_id, user["id"]),
    )
    await db.commit()
    transfer_id = cursor.lastrowid

    # Execute the transfer
    now = datetime.now(timezone.utc).isoformat()
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
        user_id=user["id"], ip_address=request.client.host,
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
    db: aiosqlite.Connection = Depends(get_db),
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
    now = datetime.now(timezone.utc).isoformat()
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
        user_id=user["id"], ip_address=request.client.host,
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
