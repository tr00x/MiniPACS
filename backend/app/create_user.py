"""Usage: python -m app.create_user <username> <password>"""
import asyncio
import sys

import aiosqlite

from app.database import DB_PATH, init_db
from app.services.auth import hash_password


async def main():
    if len(sys.argv) != 3:
        print("Usage: python -m app.create_user <username> <password>")
        sys.exit(1)

    username, password = sys.argv[1], sys.argv[2]
    await init_db()

    async with aiosqlite.connect(DB_PATH) as db:
        try:
            await db.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, hash_password(password)),
            )
            await db.commit()
            print(f"User '{username}' created.")
        except aiosqlite.IntegrityError:
            print(f"User '{username}' already exists.")
            sys.exit(1)


asyncio.run(main())
