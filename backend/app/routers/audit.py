from fastapi import APIRouter, Depends, Query
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user

router = APIRouter(prefix="/api/audit-log", tags=["audit"])


@router.get("")
async def get_audit_log(
    action: str | None = None,
    user_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = Query(default=100, le=1000, ge=1),
    offset: int = Query(default=0, ge=0),
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    conditions = []
    params = []

    if action:
        conditions.append("action = ?")
        params.append(action)
    if user_id is not None:
        conditions.append("user_id = ?")
        params.append(user_id)
    if date_from:
        conditions.append("timestamp >= ?")
        params.append(date_from)
    if date_to:
        conditions.append("timestamp <= ?")
        params.append(date_to)

    where = ""
    if conditions:
        where = "WHERE " + " AND ".join(conditions)

    count_cursor = await db.execute(
        f"SELECT COUNT(*) as cnt FROM audit_log {where}", params
    )
    total_row = await count_cursor.fetchone()
    total = total_row["cnt"]

    cursor = await db.execute(
        f"SELECT * FROM audit_log {where} ORDER BY timestamp DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    )
    rows = await cursor.fetchall()
    return {"items": [dict(r) for r in rows], "total": total}
