from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsUpdate(BaseModel):
    clinic_name: str | None = None
    clinic_phone: str | None = None
    clinic_email: str | None = None
    auto_logout_minutes: int | None = None
    default_share_expiry_days: int | None = None
    viewer_default: str | None = None


ALLOWED_KEYS = set(SettingsUpdate.model_fields.keys())


@router.get("")
async def get_settings(
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cursor = await db.execute("SELECT key, value FROM settings")
    rows = await cursor.fetchall()
    return {row["key"]: row["value"] for row in rows}


@router.put("")
async def put_settings(
    body: SettingsUpdate,
    request: Request,
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    updates = body.model_dump(exclude_none=True)
    now = datetime.now(timezone.utc).isoformat()
    for key, value in updates.items():
        await db.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, str(value), now),
        )
    await db.commit()
    await log_audit(
        action="settings.update",
        resource_type="settings",
        user_id=user["id"],
        ip_address=request.client.host if request.client else None,
    )
    return {"status": "ok"}
