from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from app.config import settings
from app.db import PgConnection

from app.database import get_db
from app.models.auth import LoginRequest, TokenResponse, UserResponse, RefreshRequest
from app.services.auth import (
    verify_password, hash_password, create_access_token,
    create_refresh_token, decode_token,
)
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/auth", tags=["auth"])
security = HTTPBearer()

MAX_ATTEMPTS = 5
WINDOW_MINUTES = 5

# HttpOnly cookie used solely by nginx auth_request to gate viewer/orthanc/
# dicom-web paths. Same JWT as the Bearer access token; only the delivery
# channel differs (cookie travels on iframe + new-tab requests, Authorization
# header does not).
VIEWER_COOKIE = "viewer_session"


def _set_viewer_cookie(response: Response, access_token: str) -> None:
    response.set_cookie(
        key=VIEWER_COOKIE,
        value=access_token,
        max_age=settings.access_token_expire_minutes * 60,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
    )


def _clear_viewer_cookie(response: Response) -> None:
    response.delete_cookie(key=VIEWER_COOKIE, path="/")


async def _check_rate_limit(ip: str, db: PgConnection):
    """Check if IP is rate-limited based on failed login audit entries. Survives restarts."""
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=WINDOW_MINUTES)).isoformat()
    cursor = await db.execute(
        "SELECT COUNT(*) FROM audit_log WHERE ip_address = ? AND action = 'login_failed' AND timestamp > ?",
        (ip, cutoff),
    )
    count = (await cursor.fetchone())[0]
    if count >= MAX_ATTEMPTS:
        raise HTTPException(429, "Too many login attempts. Try again in 5 minutes.")


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: PgConnection = Depends(get_db),
) -> dict:
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access":
        raise HTTPException(401, "Invalid token")

    user_id = int(payload["sub"])
    cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    user = await cursor.fetchone()
    if not user:
        raise HTTPException(401, "User not found")
    if user["token_version"] != payload.get("tv"):
        raise HTTPException(401, "Token revoked")
    return dict(user)


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, request: Request, response: Response, db: PgConnection = Depends(get_db)):
    ip = request.client.host
    await _check_rate_limit(ip, db)

    cursor = await db.execute("SELECT * FROM users WHERE username = ?", (body.username,))
    user = await cursor.fetchone()
    if not user or not verify_password(body.password, user["password_hash"]):
        await log_audit("login_failed", ip_address=ip, wait=True)
        raise HTTPException(401, "Invalid credentials")

    user = dict(user)
    await db.execute(
        "UPDATE users SET last_login = ? WHERE id = ?",
        (datetime.now(timezone.utc).isoformat(), user["id"]),
    )
    await db.commit()
    await log_audit("login", user_id=user["id"], ip_address=ip, wait=True)

    # Warm up Orthanc SQLite cache in the background so the first worklist/dashboard
    # query after this login lands on a hot index. The user's browser is still
    # rendering the post-login redirect while this runs — it does not block login.
    _schedule_post_login_warmup()

    access = create_access_token(user["id"], user["token_version"])
    refresh = create_refresh_token(user["id"], user["token_version"])
    _set_viewer_cookie(response, access)
    return TokenResponse(access_token=access, refresh_token=refresh)


import asyncio as _asyncio

# Hold strong refs so GC can't collect the warmup task mid-flight.
_warmup_tasks: set = set()


def _schedule_post_login_warmup():
    from app.services import orthanc as _orthanc

    async def _warm():
        try:
            # Populate the backend study cache (fills page cache + in-memory TTL
            # simultaneously). Failures are silent — warmup is best-effort.
            await _orthanc.find_studies(limit=50, offset=0)
            await _orthanc.find_patients(limit=100, offset=0)
        except Exception:
            pass

    task = _asyncio.create_task(_warm())
    _warmup_tasks.add(task)
    task.add_done_callback(_warmup_tasks.discard)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, response: Response, db: PgConnection = Depends(get_db)):
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(401, "Invalid refresh token")

    user_id = int(payload["sub"])
    cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    user = await cursor.fetchone()
    if not user or user["token_version"] != payload.get("tv"):
        raise HTTPException(401, "Token revoked")

    user = dict(user)
    access = create_access_token(user["id"], user["token_version"])
    refresh_tok = create_refresh_token(user["id"], user["token_version"])
    _set_viewer_cookie(response, access)
    return TokenResponse(access_token=access, refresh_token=refresh_tok)


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    user: dict = Depends(get_current_user),
    db: PgConnection = Depends(get_db),
):
    await db.execute(
        "UPDATE users SET token_version = token_version + 1 WHERE id = ?",
        (user["id"],),
    )
    await db.commit()
    await log_audit("logout", user_id=user["id"], ip_address=request.client.host, wait=True)
    _clear_viewer_cookie(response)
    return {"status": "ok"}


@router.get("/me", response_model=UserResponse)
async def me(response: Response, user: dict = Depends(get_current_user)):
    # Sliding cookie refresh: every /me call (frontend pings on app load and
    # after token refresh) re-stamps the viewer cookie so an active session
    # never loses iframe access while REST stays alive.
    access = create_access_token(user["id"], user["token_version"])
    _set_viewer_cookie(response, access)
    return UserResponse(**user)


@router.get("/verify-viewer", include_in_schema=False)
async def verify_viewer(viewer_session: str | None = Cookie(default=None)):
    """nginx auth_request target. JWT-only check (no DB) — must stay <1ms so
    that 200+ DICOMweb subrequests during a study open don't accumulate cost.
    Trade-off: a logged-out user keeps viewer access until the JWT exp
    (≤30 min). Acceptable for V1 — the alternative is a per-subrequest DB hit.
    """
    if not viewer_session:
        raise HTTPException(401, "No session")
    payload = decode_token(viewer_session)
    if not payload or payload.get("type") != "access":
        raise HTTPException(401, "Invalid session")
    return {"ok": True}
