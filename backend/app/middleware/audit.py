import asyncio
import logging
from datetime import datetime, timezone

import aiosqlite

from app.database import DB_PATH

_log = logging.getLogger(__name__)


async def _write_audit(
    action: str,
    resource_type: str | None,
    resource_id: str | None,
    user_id: int | None,
    patient_token: str | None,
    ip_address: str | None,
):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO audit_log (user_id, patient_token, action, resource_type, resource_id, ip_address, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user_id, patient_token, action, resource_type, resource_id, ip_address,
             datetime.now(timezone.utc).isoformat()),
        )
        await db.commit()


async def log_audit(
    action: str,
    resource_type: str = None,
    resource_id: str = None,
    user_id: int = None,
    patient_token: str = None,
    ip_address: str = None,
    wait: bool = False,
):
    """Record an audit entry.

    By default fire-and-forget: the insert is scheduled on the event loop and the
    caller returns immediately, keeping read endpoints (list_studies, view_study,
    etc.) off the critical path of a SQLite commit.

    Pass wait=True for security-critical writes (login, delete, password change)
    where the caller must observe the record before responding.
    """
    if wait:
        await _write_audit(action, resource_type, resource_id, user_id, patient_token, ip_address)
        return

    async def _bg():
        try:
            await _write_audit(action, resource_type, resource_id, user_id, patient_token, ip_address)
        except Exception:
            _log.exception("audit write failed for action=%s", action)

    asyncio.create_task(_bg())
