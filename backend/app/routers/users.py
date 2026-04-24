from fastapi import APIRouter, Depends, HTTPException, Request
import asyncpg

from app.db import PgConnection

from app.database import get_db
from app.routers.auth import get_current_user
from app.services.auth import hash_password
from app.models.auth import LoginRequest
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("")
async def list_users(db: PgConnection = Depends(get_db), user: dict = Depends(get_current_user)):
    cursor = await db.execute("SELECT id, username, created_at, last_login FROM users")
    return [dict(row) for row in await cursor.fetchall()]


@router.post("", status_code=201)
async def create_user(
    body: LoginRequest,
    request: Request,
    db: PgConnection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    try:
        cursor = await db.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id",
            (body.username, hash_password(body.password)),
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(409, "Username already exists")
    # Everything after the INSERT is NOT a duplicate-username situation — any
    # pool / network / follow-up error here would previously mask as 409 and
    # make the operator think they were hitting a naming collision. Let real
    # errors propagate as 500 with their actual traceback in the logs.
    await db.commit()
    new_id = cursor.lastrowid
    await log_audit("create_user", "user", str(new_id), user_id=user["id"], ip_address=request.client.host, wait=True)
    row = await db.execute(
        "SELECT id, username, token_version, created_at, last_login FROM users WHERE id = ?",
        (new_id,),
    )
    new_user = await row.fetchone()
    return dict(new_user)


@router.delete("/{target_id}")
async def delete_user(
    target_id: int,
    request: Request,
    db: PgConnection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    if target_id == user["id"]:
        raise HTTPException(400, "Cannot delete yourself")
    await db.execute("DELETE FROM users WHERE id = ?", (target_id,))
    await db.commit()
    await log_audit("delete_user", "user", str(target_id), user_id=user["id"], ip_address=request.client.host, wait=True)
    return {"status": "ok"}


@router.post("/{target_id}/revoke-tokens")
async def revoke_tokens(
    target_id: int,
    request: Request,
    db: PgConnection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    await db.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", (target_id,))
    await db.commit()
    await log_audit("revoke_tokens", "user", str(target_id), user_id=user["id"], ip_address=request.client.host, wait=True)
    return {"status": "ok"}
