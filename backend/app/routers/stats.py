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


def _format_storage_size(dicom_size) -> str:
    """Format bytes into human-readable storage size."""
    try:
        size = int(dicom_size)
    except (TypeError, ValueError):
        return "0B"
    if size < 1024:
        return f"{size}B"
    elif size < 1024 ** 2:
        return f"{size / 1024:.1f}KB"
    elif size < 1024 ** 3:
        return f"{size / (1024 ** 2):.1f}MB"
    else:
        return f"{size / (1024 ** 3):.1f}GB"


@router.get("/system-health")
async def get_system_health(
    user: dict = Depends(get_current_user),
):
    orthanc_info = {"status": "offline"}
    try:
        r_sys = await orthanc._http().get("/system")
        if r_sys.status_code == 200:
            sys_data = r_sys.json()
            orthanc_info = {
                "status": "online",
                "version": sys_data.get("Version", "unknown"),
                "storage_size": "0B",
                "dicom_aet": sys_data.get("DicomAet", ""),
            }
            # Get storage size + counts from /statistics
            r_stat = await orthanc._http().get("/statistics")
            if r_stat.status_code == 200:
                stat_data = r_stat.json()
                orthanc_info["storage_size"] = _format_storage_size(
                    stat_data.get("TotalDiskSize", 0)
                )
                orthanc_info["count_studies"] = stat_data.get("CountStudies", 0)
                orthanc_info["count_instances"] = stat_data.get("CountInstances", 0)
    except Exception:
        pass

    # Last received study — find most recent NewStudy change (real DICOM receive, not internal ops)
    last_received = None
    try:
        # Walk backwards through changes to find last NewStudy
        done = False
        last_seq = None
        for _ in range(5):  # max 5 pages back
            params = {"limit": 100}
            if last_seq is not None:
                params["to"] = last_seq
            r = await orthanc._http().get("/changes", params=params)
            if r.status_code != 200:
                break
            data = r.json()
            for change in reversed(data.get("Changes", [])):
                if change.get("ChangeType") == "NewStudy":
                    last_received = change.get("Date")
                    done = True
                    break
            if done or data.get("Done", True):
                break
            changes_list = data.get("Changes", [])
            if changes_list:
                last_seq = changes_list[0].get("Seq", 0) - 1
            else:
                break
    except Exception:
        pass

    return {
        "orthanc": orthanc_info,
        "last_received": last_received,
    }
