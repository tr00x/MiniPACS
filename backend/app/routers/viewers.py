from fastapi import APIRouter, Depends, HTTPException, Request
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.viewers import ViewerCreate, ViewerUpdate
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/viewers", tags=["viewers"])


@router.get("")
async def list_viewers(
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute(
        "SELECT * FROM external_viewers ORDER BY sort_order, name"
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


@router.post("", status_code=201)
async def create_viewer(
    body: ViewerCreate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute(
        "INSERT INTO external_viewers (name, icon, url_scheme, is_enabled, sort_order, description, icon_key) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (body.name, body.icon, body.url_scheme, body.is_enabled, body.sort_order, body.description, body.icon_key),
    )
    await db.commit()
    viewer_id = cursor.lastrowid
    await log_audit(
        action="viewer.create",
        resource_type="viewer",
        resource_id=str(viewer_id),
        user_id=user["id"],
        ip_address=request.client.host if request.client else None,
    )
    cur = await db.execute("SELECT * FROM external_viewers WHERE id = ?", (viewer_id,))
    return dict(await cur.fetchone())


@router.put("/{viewer_id}")
async def update_viewer(
    viewer_id: int,
    body: ViewerUpdate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute("SELECT * FROM external_viewers WHERE id = ?", (viewer_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "Viewer not found")

    updates = body.model_dump(exclude_none=True)
    if not updates:
        return dict(existing)

    ALLOWED_COLUMNS = {"name", "icon", "url_scheme", "is_enabled", "sort_order", "description", "icon_key"}
    set_clauses = []
    values = []
    for col in ALLOWED_COLUMNS:
        if col in updates:
            set_clauses.append(f"{col} = ?")
            values.append(updates[col])

    if not set_clauses:
        return dict(existing)

    values.append(viewer_id)
    await db.execute(
        f"UPDATE external_viewers SET {', '.join(set_clauses)} WHERE id = ?", values
    )
    await db.commit()
    await log_audit(
        action="viewer.update",
        resource_type="viewer",
        resource_id=str(viewer_id),
        user_id=user["id"],
        ip_address=request.client.host if request.client else None,
    )
    cur = await db.execute("SELECT * FROM external_viewers WHERE id = ?", (viewer_id,))
    return dict(await cur.fetchone())


@router.delete("/{viewer_id}")
async def delete_viewer(
    viewer_id: int,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute("SELECT * FROM external_viewers WHERE id = ?", (viewer_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "Viewer not found")

    await db.execute("DELETE FROM external_viewers WHERE id = ?", (viewer_id,))
    await db.commit()
    await log_audit(
        action="viewer.delete",
        resource_type="viewer",
        resource_id=str(viewer_id),
        user_id=user["id"],
        ip_address=request.client.host if request.client else None,
    )
    return {"status": "deleted"}
