"""Reset a user's password and invalidate all their existing sessions.

Usage:
    python -m app.change_password <username> <new_password>

Bumps `token_version` so every outstanding JWT for this user stops being
accepted on the next request — the user is forced to re-login with the
new password. Safe to run in production during business hours; only the
affected user sees a session drop.
"""
import asyncio
import sys

from app.db import init_pool, pool, close_pool
from app.services.auth import hash_password


async def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: python -m app.change_password <username> <new_password>")
        sys.exit(1)

    username, new_password = sys.argv[1], sys.argv[2]

    await init_pool()
    try:
        async with pool().acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id FROM users WHERE username = $1", username
            )
            if not row:
                print(f"User '{username}' not found", file=sys.stderr)
                sys.exit(2)

            await conn.execute(
                """UPDATE users
                   SET password_hash = $1,
                       token_version = COALESCE(token_version, 0) + 1
                   WHERE username = $2""",
                hash_password(new_password),
                username,
            )
            print(f"Password updated for '{username}'. All existing sessions invalidated.")
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
