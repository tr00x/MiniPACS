from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from app.db import PgConnection

from app.database import get_db
from app.models.pacs_nodes import PacsNodeCreate, PacsNodeUpdate
from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/pacs-nodes", tags=["pacs-nodes"])


def _modality_id(name: str) -> str:
    """Convert display name to Orthanc modality ID (lowercase, spaces to hyphens)."""
    return name.strip().lower().replace(" ", "-")


@router.get("")
async def list_pacs_nodes(
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    await log_audit("list_pacs_nodes", user_id=user["id"], ip_address=request.client.host)
    cursor = await db.execute("SELECT * FROM pacs_nodes ORDER BY id")
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]


@router.post("", status_code=201)
async def create_pacs_node(
    body: PacsNodeCreate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    modality = _modality_id(body.name)

    # Register with Orthanc first so failure prevents DB insert
    try:
        await orthanc.register_modality(modality, body.ae_title, body.ip, body.port)
    except Exception as exc:
        raise HTTPException(502, f"Failed to register modality in Orthanc: {exc}")

    cursor = await db.execute(
        """INSERT INTO pacs_nodes (name, ae_title, ip, port, description)
           VALUES (?, ?, ?, ?, ?)
           RETURNING id""",
        (body.name, body.ae_title, body.ip, body.port, body.description),
    )
    await db.commit()
    node_id = cursor.lastrowid

    await log_audit(
        "create_pacs_node", "pacs_node", str(node_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )

    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (node_id,))
    node = await cursor.fetchone()
    return dict(node)


@router.put("/{node_id}")
async def update_pacs_node(
    node_id: int,
    body: PacsNodeUpdate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (node_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "PACS node not found")

    existing = dict(existing)
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "No fields to update")

    # Merge updates into existing values
    merged = {**existing, **updates}
    # Convert is_active bool to int for sqlite
    if "is_active" in updates and isinstance(updates["is_active"], bool):
        merged["is_active"] = int(updates["is_active"])

    # Sync with Orthanc — use old name for deletion if name changed
    old_modality = _modality_id(existing["name"])
    new_modality = _modality_id(merged["name"])

    try:
        if old_modality != new_modality:
            try:
                await orthanc.delete_modality(old_modality)
            except Exception:
                pass  # Old modality may not exist in Orthanc
        await orthanc.register_modality(
            new_modality, merged["ae_title"], merged["ip"], merged["port"],
        )
    except Exception as exc:
        raise HTTPException(502, f"Failed to update modality in Orthanc: {exc}")

    await db.execute(
        """UPDATE pacs_nodes SET name=?, ae_title=?, ip=?, port=?, description=?, is_active=?
           WHERE id=?""",
        (merged["name"], merged["ae_title"], merged["ip"], merged["port"],
         merged["description"], merged["is_active"], node_id),
    )
    await db.commit()

    await log_audit(
        "update_pacs_node", "pacs_node", str(node_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )

    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (node_id,))
    node = await cursor.fetchone()
    return dict(node)


@router.delete("/{node_id}", status_code=204)
async def delete_pacs_node(
    node_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (node_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "PACS node not found")

    modality = _modality_id(existing["name"])

    # Remove from Orthanc
    try:
        await orthanc.delete_modality(modality)
    except Exception:
        pass  # Best-effort removal from Orthanc

    await db.execute("DELETE FROM pacs_nodes WHERE id = ?", (node_id,))
    await db.commit()

    await log_audit(
        "delete_pacs_node", "pacs_node", str(node_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )


@router.post("/{node_id}/echo")
async def echo_pacs_node(
    node_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (node_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "PACS node not found")

    modality = _modality_id(existing["name"])
    success = await orthanc.echo_modality(modality)

    if success:
        await db.execute(
            "UPDATE pacs_nodes SET last_echo_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).isoformat(), node_id),
        )
        await db.commit()

    await log_audit(
        "echo_pacs_node", "pacs_node", str(node_id),
        user_id=user["id"], ip_address=request.client.host, wait=True,
    )

    return {"success": success, "node_id": node_id, "modality": modality}
