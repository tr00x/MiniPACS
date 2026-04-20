"""Aggregate /api/dashboard endpoint.

Collapses the five round-trips that the Dashboard page makes at open (stats,
system-health, transfers, shares, patients) into a single response. All four
Orthanc/SQLite reads run concurrently on the server, so latency is bounded by
the slowest one instead of summed.
"""

import asyncio
import time
from datetime import datetime, timezone, timedelta

import aiosqlite
from fastapi import APIRouter, Depends

from app.database import get_db
from app.routers.auth import get_current_user
from app.services import orthanc

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

_DASHBOARD_TTL = 8.0
_cache: dict[str, tuple[float, dict]] = {}


async def _orthanc_stats():
    try:
        r = await orthanc._http().get("/statistics")
        if r.status_code == 200:
            d = r.json()
            return d.get("CountPatients", 0), d.get("CountStudies", 0)
    except Exception:
        pass
    return 0, 0


async def _studies_today():
    try:
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        r = await orthanc._http().post(
            "/tools/find",
            json={"Level": "Study", "Query": {"StudyDate": today}},
        )
        if r.status_code == 200:
            return len(r.json())
    except Exception:
        pass
    return 0


async def _system_health():
    orthanc_info = {"status": "offline"}
    try:
        r_sys = await orthanc._http().get("/system")
        if r_sys.status_code == 200:
            sys_data = r_sys.json()
            orthanc_info = {
                "status": "online",
                "version": sys_data.get("Version", "unknown"),
                "dicom_aet": sys_data.get("DicomAet", ""),
            }
            r_stat = await orthanc._http().get("/statistics")
            if r_stat.status_code == 200:
                stat_data = r_stat.json()
                orthanc_info["count_studies"] = stat_data.get("CountStudies", 0)
                orthanc_info["count_instances"] = stat_data.get("CountInstances", 0)
                total = stat_data.get("TotalDiskSize", 0)
                try:
                    size = int(total)
                    if size < 1024:
                        orthanc_info["storage_size"] = f"{size}B"
                    elif size < 1024**2:
                        orthanc_info["storage_size"] = f"{size / 1024:.1f}KB"
                    elif size < 1024**3:
                        orthanc_info["storage_size"] = f"{size / 1024**2:.1f}MB"
                    else:
                        orthanc_info["storage_size"] = f"{size / 1024**3:.1f}GB"
                except Exception:
                    orthanc_info["storage_size"] = "0B"
    except Exception:
        pass
    return orthanc_info


async def _last_received():
    try:
        r = await orthanc._http().get("/changes", params={"limit": 100})
        if r.status_code != 200:
            return None
        for change in reversed(r.json().get("Changes", [])):
            if change.get("ChangeType") == "NewStudy":
                return change.get("Date")
    except Exception:
        pass
    return None


async def _db_counts(db: aiosqlite.Connection):
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    cur = await db.execute(
        "SELECT COUNT(*) FROM transfer_log WHERE created_at >= ?", (week_ago,)
    )
    transfers_week = (await cur.fetchone())[0]
    cur = await db.execute("SELECT COUNT(*) FROM transfer_log WHERE status = 'failed'")
    failed_transfers = (await cur.fetchone())[0]
    cur = await db.execute(
        "SELECT COUNT(*) FROM patient_shares WHERE is_active = 1 AND view_count = 0"
    )
    unviewed_shares = (await cur.fetchone())[0]
    return transfers_week, failed_transfers, unviewed_shares


async def _recent_transfers(db: aiosqlite.Connection):
    cur = await db.execute(
        "SELECT t.id, t.orthanc_study_id, "
        "n.name AS pacs_node_name, n.ae_title AS pacs_node_ae_title, "
        "t.status, t.created_at "
        "FROM transfer_log t LEFT JOIN pacs_nodes n ON n.id = t.pacs_node_id "
        "ORDER BY t.created_at DESC LIMIT 5"
    )
    rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def _active_shares(db: aiosqlite.Connection):
    cur = await db.execute(
        "SELECT id, orthanc_patient_id, token, is_active, view_count, created_at, expires_at "
        "FROM patient_shares WHERE is_active = 1 ORDER BY created_at DESC LIMIT 5"
    )
    rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def _patients_list():
    # Same call Dashboard uses to resolve patient names on the transfer list.
    try:
        items, _ = await orthanc.find_patients(limit=100, offset=0)
        return items
    except Exception:
        return []


@router.get("")
async def get_dashboard(
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    cached = _cache.get("all")
    if cached and time.time() - cached[0] < _DASHBOARD_TTL:
        return cached[1]

    # SQLite sequential (same connection), Orthanc concurrent.
    transfers_week, failed_transfers, unviewed_shares = await _db_counts(db)
    recent_transfers = await _recent_transfers(db)
    active_shares = await _active_shares(db)

    (patients_total, studies_total), studies_today, system_health, last_received, patients = await asyncio.gather(
        _orthanc_stats(),
        _studies_today(),
        _system_health(),
        _last_received(),
        _patients_list(),
    )

    result = {
        "stats": {
            "patients_total": patients_total,
            "studies_total": studies_total,
            "studies_today": studies_today,
            "transfers_week": transfers_week,
            "failed_transfers": failed_transfers,
            "unviewed_shares": unviewed_shares,
        },
        "system_health": {
            "orthanc": system_health,
            "last_received": last_received,
        },
        "recent_transfers": recent_transfers,
        "active_shares": active_shares,
        "patients": patients,
    }
    _cache["all"] = (time.time(), result)
    return result
