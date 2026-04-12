from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends
import aiosqlite
from app.database import get_db
from app.routers.auth import get_current_user
from app.services import orthanc

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("")
async def get_stats(
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    # Get patient and study counts from Orthanc
    patients_total = 0
    studies_total = 0
    studies_today = 0
    try:
        r = await orthanc._http().get("/statistics")
        if r.status_code == 200:
            data = r.json()
            patients_total = data.get("CountPatients", 0)
            studies_total = data.get("CountStudies", 0)

        # Studies today - get today's studies from Orthanc
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        r2 = await orthanc._http().post("/tools/find", json={
            "Level": "Study",
            "Query": {"StudyDate": today},
        })
        if r2.status_code == 200:
            studies_today = len(r2.json())
    except Exception:
        pass

    # Transfer stats from SQLite
    now = datetime.now(timezone.utc)
    week_ago = (now - timedelta(days=7)).isoformat()

    cursor = await db.execute(
        "SELECT COUNT(*) FROM transfer_log WHERE created_at >= ?", (week_ago,)
    )
    transfers_week = (await cursor.fetchone())[0]

    cursor = await db.execute(
        "SELECT COUNT(*) FROM transfer_log WHERE status = 'failed'"
    )
    failed_transfers = (await cursor.fetchone())[0]

    cursor = await db.execute(
        "SELECT COUNT(*) FROM patient_shares WHERE is_active = 1 AND view_count = 0"
    )
    unviewed_shares = (await cursor.fetchone())[0]

    return {
        "patients_total": patients_total,
        "studies_total": studies_total,
        "studies_today": studies_today,
        "transfers_week": transfers_week,
        "failed_transfers": failed_transfers,
        "unviewed_shares": unviewed_shares,
    }
