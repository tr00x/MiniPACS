"""One-shot migration: SQLite `minipacs.db` → PostgreSQL `orthanc` database.

Runs inside the backend container after the PG-enabled build lands on prod.
Reads the legacy SQLite file at $SQLITE_PATH (default /app/data/minipacs.db),
inserts every row into the PG tables already created by backend startup.

Idempotency: each row is inserted with `ON CONFLICT DO NOTHING` on the primary
key, so re-running is safe — duplicate keys are skipped. id sequences are
bumped to max(id)+1 at the end so newly inserted rows on PG continue past the
migrated ids instead of colliding with them.

Usage (inside backend container):
    python -m scripts.migrate_sqlite_to_pg

Or from host:
    docker compose exec backend python -m scripts.migrate_sqlite_to_pg
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import sys
from pathlib import Path

import asyncpg

# Tables + the columns we migrate. Ordered so FK parents come first (users,
# pacs_nodes) before children (patient_shares, transfer_log, audit_log).
TABLES: list[tuple[str, tuple[str, ...]]] = [
    ("users", ("id", "username", "password_hash", "token_version", "created_at", "last_login")),
    ("pacs_nodes", ("id", "name", "ae_title", "ip", "port", "description", "is_active", "last_echo_at")),
    ("external_viewers", ("id", "name", "icon", "url_scheme", "is_enabled", "sort_order", "description", "icon_key")),
    ("settings", ("key", "value", "updated_at")),
    ("patient_shares", ("id", "orthanc_patient_id", "token", "expires_at", "created_by", "created_at", "is_active", "view_count", "first_viewed_at", "last_viewed_at", "pin_hash")),
    ("transfer_log", ("id", "orthanc_study_id", "pacs_node_id", "initiated_by", "status", "error_message", "created_at", "completed_at")),
    ("audit_log", ("id", "user_id", "patient_token", "action", "resource_type", "resource_id", "ip_address", "timestamp")),
    ("study_reports", ("id", "orthanc_study_id", "title", "report_type", "content", "filename", "created_by", "created_at")),
]

SEQUENCE_TABLES = {"users", "pacs_nodes", "external_viewers", "patient_shares",
                   "transfer_log", "audit_log", "study_reports"}


def _placeholders(cols: tuple[str, ...]) -> str:
    return ", ".join(f"${i+1}" for i in range(len(cols)))


async def _migrate_table(pg: asyncpg.Connection, src: sqlite3.Connection, table: str, cols: tuple[str, ...]) -> int:
    cur = src.execute(f"SELECT {', '.join(cols)} FROM {table}")
    rows = cur.fetchall()
    if not rows:
        return 0

    conflict_col = "key" if table == "settings" else "id"
    sql = (
        f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({_placeholders(cols)}) "
        f"ON CONFLICT ({conflict_col}) DO NOTHING"
    )
    inserted = 0
    for row in rows:
        try:
            result = await pg.execute(sql, *row)
            # `INSERT 0 0` → nothing inserted; `INSERT 0 1` → one row in.
            if result.endswith(" 1"):
                inserted += 1
        except Exception as exc:
            print(f"  ! {table} row {row[0]!r} failed: {exc}", file=sys.stderr)
    return inserted


async def _bump_sequence(pg: asyncpg.Connection, table: str) -> None:
    seq = f"{table}_id_seq"
    row = await pg.fetchrow(f"SELECT COALESCE(MAX(id), 0) AS m FROM {table}")
    max_id = row["m"] or 0
    if max_id > 0:
        await pg.execute(f"SELECT setval($1, $2, TRUE)", seq, max_id)


async def main() -> None:
    sqlite_path = Path(os.environ.get("SQLITE_PATH", "/app/data/minipacs.db"))
    if not sqlite_path.exists():
        print(f"no legacy SQLite file at {sqlite_path} — nothing to migrate")
        return

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(2)

    print(f"migrating {sqlite_path} → {dsn}")
    src = sqlite3.connect(sqlite_path)
    src.row_factory = sqlite3.Row
    try:
        pg = await asyncpg.connect(dsn=dsn)
        try:
            total = 0
            for table, cols in TABLES:
                # Skip tables that don't exist in the SQLite file (older installs).
                exists = src.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
                ).fetchone()
                if not exists:
                    print(f"  - {table}: absent in SQLite, skipped")
                    continue
                n = await _migrate_table(pg, src, table, cols)
                total += n
                print(f"  + {table}: {n} rows inserted")
            for table in SEQUENCE_TABLES:
                await _bump_sequence(pg, table)
            print(f"done, {total} rows migrated")
        finally:
            await pg.close()
    finally:
        src.close()


if __name__ == "__main__":
    asyncio.run(main())
