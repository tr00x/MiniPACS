from datetime import datetime, timezone

import aiosqlite

from app.database import DB_PATH


async def log_audit(
    action: str,
    resource_type: str = None,
    resource_id: str = None,
    user_id: int = None,
    patient_token: str = None,
    ip_address: str = None,
):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO audit_log (user_id, patient_token, action, resource_type, resource_id, ip_address, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user_id, patient_token, action, resource_type, resource_id, ip_address,
             datetime.now(timezone.utc).isoformat()),
        )
        await db.commit()
