"""Usage: python -m app.create_user <username> <password>"""
import asyncio
import sys

import asyncpg

from app.db import init_pool, pool, close_pool
from app.database import init_db
from app.services.auth import hash_password


async def main():
    if len(sys.argv) != 3:
        print("Usage: python -m app.create_user <username> <password>")
        sys.exit(1)

    username, password = sys.argv[1], sys.argv[2]

    await init_pool()
    try:
        await init_db()
        async with pool().acquire() as conn:
            try:
                await conn.execute(
                    "INSERT INTO users (username, password_hash) VALUES ($1, $2)",
                    username, hash_password(password),
                )
                print(f"User '{username}' created.")
            except asyncpg.UniqueViolationError:
                print(f"User '{username}' already exists.")
                sys.exit(1)
    finally:
        await close_pool()


asyncio.run(main())
