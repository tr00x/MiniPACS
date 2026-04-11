from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

import aiosqlite

from app.database import get_db
from app.models.auth import LoginRequest, TokenResponse, UserResponse, RefreshRequest
from app.services.auth import (
    verify_password, hash_password, create_access_token,
    create_refresh_token, decode_token,
)
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/auth", tags=["auth"])
security = HTTPBearer()

_login_attempts: dict[str, list[float]] = {}
MAX_ATTEMPTS = 5
WINDOW_SECONDS = 300


def _check_rate_limit(ip: str):
    now = datetime.now(timezone.utc).timestamp()
    attempts = _login_attempts.get(ip, [])
    attempts = [t for t in attempts if now - t < WINDOW_SECONDS]
    _login_attempts[ip] = attempts
    if len(attempts) >= MAX_ATTEMPTS:
        raise HTTPException(429, "Too many login attempts. Try again later.")
    attempts.append(now)
    _login_attempts[ip] = attempts


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: aiosqlite.Connection = Depends(get_db),
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
async def login(body: LoginRequest, request: Request, db: aiosqlite.Connection = Depends(get_db)):
    ip = request.client.host
    _check_rate_limit(ip)

    cursor = await db.execute("SELECT * FROM users WHERE username = ?", (body.username,))
    user = await cursor.fetchone()
    if not user or not verify_password(body.password, user["password_hash"]):
        await log_audit("login_failed", ip_address=ip)
        raise HTTPException(401, "Invalid credentials")

    user = dict(user)
    await db.execute(
        "UPDATE users SET last_login = ? WHERE id = ?",
        (datetime.now(timezone.utc).isoformat(), user["id"]),
    )
    await db.commit()
    await log_audit("login", user_id=user["id"], ip_address=ip)

    return TokenResponse(
        access_token=create_access_token(user["id"], user["token_version"]),
        refresh_token=create_refresh_token(user["id"], user["token_version"]),
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: aiosqlite.Connection = Depends(get_db)):
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(401, "Invalid refresh token")

    user_id = int(payload["sub"])
    cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    user = await cursor.fetchone()
    if not user or user["token_version"] != payload.get("tv"):
        raise HTTPException(401, "Token revoked")

    user = dict(user)
    return TokenResponse(
        access_token=create_access_token(user["id"], user["token_version"]),
        refresh_token=create_refresh_token(user["id"], user["token_version"]),
    )


@router.post("/logout")
async def logout(request: Request, user: dict = Depends(get_current_user)):
    await log_audit("logout", user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}


@router.get("/me", response_model=UserResponse)
async def me(user: dict = Depends(get_current_user)):
    return UserResponse(**user)
