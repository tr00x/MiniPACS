"""Shared PostgreSQL pool + aiosqlite-compatible wrapper.

Routers across this codebase were written against aiosqlite's API
(`await db.execute(sql, params)`, `cursor.fetchone()`, `db.commit()`),
so rather than rewrite every handler we keep the same surface and
translate the handful of SQLite-isms to PostgreSQL underneath.

The backend shares the same PG instance as Orthanc but uses different
tables — nothing in Orthanc's schema collides with ours (users,
patient_shares, pacs_nodes, transfer_log, audit_log, external_viewers,
settings, study_reports), so a separate database was not worth the
extra admin-user dance.

Connection acquisition flows through `get_db` as a FastAPI dependency;
each request acquires one connection from the pool and returns it to
the pool after the handler finishes. The pool itself is initialised
in the FastAPI lifespan.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

import asyncpg

from app.config import settings


_pool: asyncpg.Pool | None = None


def pool() -> asyncpg.Pool:
    assert _pool is not None, "DB pool not initialised — call init_pool() in lifespan"
    return _pool


async def init_pool() -> None:
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=2,
        max_size=8,
        command_timeout=30,
        # Modest statement cache — asyncpg rewrites all params to prepared
        # statements by default, and we never churn DDL at runtime.
        max_cached_statement_lifetime=0,
    )


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


# ---------------------------------------------------------------------------
# SQL translation: `?` positional placeholders → `$1, $2, ...`
# ---------------------------------------------------------------------------

_PLACEHOLDER_RE = re.compile(r"\?")


def _translate(sql: str) -> str:
    counter = {"i": 0}

    def repl(_):
        counter["i"] += 1
        return f"${counter['i']}"

    return _PLACEHOLDER_RE.sub(repl, sql)


def _is_read(sql: str) -> bool:
    head = sql.lstrip().upper()
    if head.startswith(("SELECT", "WITH", "VALUES", "SHOW", "EXPLAIN")):
        return True
    return "RETURNING" in head


# ---------------------------------------------------------------------------
# aiosqlite-compatible wrappers
# ---------------------------------------------------------------------------


class PgCursor:
    """Mimics the subset of aiosqlite's cursor API that this codebase uses."""

    def __init__(self, rows: list[asyncpg.Record] | None = None):
        self._rows: list[asyncpg.Record] = rows or []
        self.lastrowid: int | None = None
        # If a RETURNING id came back, expose it the aiosqlite way.
        if self._rows:
            first = self._rows[0]
            if "id" in first.keys():
                try:
                    self.lastrowid = int(first["id"])
                except (TypeError, ValueError):
                    pass

    async def fetchone(self) -> asyncpg.Record | None:
        return self._rows[0] if self._rows else None

    async def fetchall(self) -> list[asyncpg.Record]:
        return list(self._rows)

    def __aiter__(self):
        self._iter = iter(self._rows)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class PgConnection:
    """Thin facade over asyncpg.Connection matching aiosqlite's surface."""

    def __init__(self, conn: asyncpg.Connection):
        self._conn = conn

    @property
    def raw(self) -> asyncpg.Connection:
        """Escape hatch for call sites that need asyncpg features (COPY, LISTEN)."""
        return self._conn

    async def execute(self, sql: str, params: Iterable[Any] = ()) -> PgCursor:
        pg_sql = _translate(sql)
        args = tuple(params)
        if _is_read(sql):
            rows = await self._conn.fetch(pg_sql, *args)
            return PgCursor(list(rows))
        await self._conn.execute(pg_sql, *args)
        return PgCursor([])

    async def executescript(self, script: str) -> None:
        """aiosqlite had a dedicated multi-statement helper. asyncpg's
        `execute` already handles semicolon-separated DDL, so we just pass
        it through — translation is not needed for schema text because we
        write schemas in native PG syntax already."""
        await self._conn.execute(script)

    async def commit(self) -> None:
        # asyncpg auto-commits outside an explicit transaction block.
        # Multi-statement atomicity should use `async with conn.transaction():`
        # at the call site. This no-op keeps legacy aiosqlite-shaped code
        # working without change.
        return None

    async def close(self) -> None:
        # Connection lifetime is managed by the pool — returning here would
        # actually close the underlying socket. The pool releases via the
        # acquire() context manager in `get_db`.
        return None


async def get_db():
    """FastAPI dependency — acquires a connection from the pool for the
    request's lifetime and releases it on exit, even if the handler raises.
    """
    assert _pool is not None, "DB pool not initialised"
    async with _pool.acquire() as raw:
        yield PgConnection(raw)
