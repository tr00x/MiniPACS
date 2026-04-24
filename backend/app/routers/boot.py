"""Aggregate /api/boot endpoint.

One round-trip that replaces the old auth/me → settings sequential chain on
every app load. While we're doing the SQL hit anyway we also ship viewers and
pacs-nodes so Settings/StudyDetail pages find them already in React Query
cache on first navigation.

Kept separate from auth.py so the auth flow file stays focused on login/tokens.
"""

import aiosqlite
from fastapi import APIRouter, Depends

from app.database import get_db
from app.routers.auth import get_current_user

router = APIRouter(prefix="/api", tags=["boot"])


@router.get("/boot")
async def boot(
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Return everything the portal needs at session start."""
    # SQLite reads are sub-millisecond and share one connection — sequential
    # is actually faster than gather (no task overhead). Order by read cost.
    cur = await db.execute("SELECT key, value FROM settings")
    settings_map = {row["key"]: row["value"] for row in await cur.fetchall()}

    cur = await db.execute(
        "SELECT id, name, icon, url_scheme, is_enabled, sort_order "
        "FROM external_viewers WHERE is_enabled = 1 ORDER BY sort_order, name"
    )
    viewers = [dict(r) for r in await cur.fetchall()]

    cur = await db.execute(
        "SELECT id, name, ae_title, ip, port, description, is_active, last_echo_at "
        "FROM pacs_nodes ORDER BY name"
    )
    pacs_nodes = [dict(r) for r in await cur.fetchall()]

    # user dict already comes from get_current_user; strip password_hash just
    # in case a future code path returns it — defensive, pin the shape.
    safe_user = {
        "id": user["id"],
        "username": user["username"],
        "created_at": user.get("created_at"),
        "last_login": user.get("last_login"),
    }

    return {
        "user": safe_user,
        "settings": settings_map,
        "viewers": viewers,
        "pacs_nodes": pacs_nodes,
    }
