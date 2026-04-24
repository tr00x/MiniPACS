import asyncio
import logging
from datetime import datetime, timezone

from app.db import pool

_log = logging.getLogger(__name__)

# Hold strong refs to in-flight background audit writes so the GC doesn't
# collect them mid-commit (CPython emits a RuntimeWarning when this happens).
_pending_bg_tasks: set[asyncio.Task] = set()


async def _write_audit(
    action: str,
    resource_type: str | None,
    resource_id: str | None,
    user_id: int | None,
    patient_token: str | None,
    ip_address: str | None,
):
    # Acquire from the shared pool — fire-and-forget writes no longer open
    # a brand-new connection per event (a hot login page used to land ~dozen
    # fresh SQLite connects/sec; the pool collapses that into two).
    async with pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO audit_log
                 (user_id, patient_token, action, resource_type, resource_id, ip_address, timestamp)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            user_id, patient_token, action, resource_type, resource_id, ip_address,
            datetime.now(timezone.utc).isoformat(),
        )


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
    etc.) off the critical path of a DB commit.

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

    task = asyncio.create_task(_bg())
    _pending_bg_tasks.add(task)
    task.add_done_callback(_pending_bg_tasks.discard)
