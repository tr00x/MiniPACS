"""CRUD + counters over the import_jobs table.

Replaces the in-memory _jobs dict from the MVP. Every state change
(extracting → uploading → done) goes through here so a parallel tab
or a backend restart sees coherent state.

All callers MUST go through this module, never write to import_jobs
directly — that keeps the JSON shape returned to the frontend in one
place (to_dict in this module mirrors what useImportJob expects).

Status vocabulary:
    queued      — job_id minted, waiting for first finalize
    extracting  — archive being unpacked
    uploading   — DICOM instances being POSTed to PACS
    done        — terminal, no failures or partial success
    error       — terminal, finalize failed or backend was restarted mid-flight
    cancelled   — terminal, user-issued DELETE

`finished_at IS NULL` is the canonical "still active" predicate; UI
treats anything with a non-null finished_at as terminal regardless of
status string, but the string distinguishes user-cancellation from
system-failure in the history view.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from app.db import pool

_log = logging.getLogger(__name__)

_TERMINAL_STATUSES = ("done", "error", "cancelled")


async def create(job_id: str, user_id: int, source_label: str = "") -> None:
    async with pool().acquire() as con:
        await con.execute(
            """INSERT INTO import_jobs (job_id, user_id, status, source_label)
               VALUES ($1, $2, 'queued', $3)""",
            job_id, user_id, source_label,
        )


async def attach_upload(job_id: str, upload_id: str) -> None:
    async with pool().acquire() as con:
        await con.execute(
            """UPDATE import_jobs
                  SET upload_ids = array_append(upload_ids, $2),
                      last_progress_at = now()
                WHERE job_id = $1""",
            job_id, upload_id,
        )


async def touch(job_id: str) -> None:
    """Mark the job as having made progress now. Called from chunk-upload
    so the stale-job sweeper doesn't kill an actively-uploading job whose
    server-side processing hasn't started yet (status still 'queued')."""
    async with pool().acquire() as con:
        await con.execute(
            "UPDATE import_jobs SET last_progress_at = now() WHERE job_id = $1",
            job_id,
        )


async def set_status(job_id: str, status: str, *, current_file: str | None = None) -> None:
    async with pool().acquire() as con:
        if current_file is not None:
            await con.execute(
                """UPDATE import_jobs
                      SET status = $2, current_file = $3, last_progress_at = now()
                    WHERE job_id = $1""",
                job_id, status, current_file,
            )
        else:
            await con.execute(
                """UPDATE import_jobs
                      SET status = $2, last_progress_at = now()
                    WHERE job_id = $1""",
                job_id, status,
            )


async def set_total_files(job_id: str, total: int) -> None:
    async with pool().acquire() as con:
        await con.execute(
            "UPDATE import_jobs SET total_files = $2 WHERE job_id = $1",
            job_id, total,
        )


async def increment(
    job_id: str,
    *,
    processed: int = 0,
    failed: int = 0,
    new_instances: int = 0,
    duplicate_instances: int = 0,
    study_id: str | None = None,
    error: str | None = None,
    current_file: str | None = None,
    file_error: dict | None = None,
) -> None:
    """Atomic increment + optional study_ids/errors append.

    `error` (str) is the short, human-readable line shown in the dialog
    summary. `file_error` (dict with keys name/reason/ts) is the
    structured record persisted for the history-page details drawer.
    Pass both — they serve different consumers."""
    file_error_json = json.dumps(file_error) if file_error else None
    async with pool().acquire() as con:
        await con.execute(
            """
            UPDATE import_jobs
               SET processed           = processed + $2,
                   failed              = failed + $3,
                   new_instances       = new_instances + $4,
                   duplicate_instances = duplicate_instances + $5,
                   study_ids           = CASE WHEN $6::text IS NULL OR $6 = ANY(study_ids)
                                              THEN study_ids
                                              ELSE array_append(study_ids, $6) END,
                   errors              = CASE WHEN $7::text IS NULL
                                              THEN errors
                                              ELSE (array_append(errors, $7))[GREATEST(1, array_length(array_append(errors, $7), 1) - 19):]
                                         END,
                   current_file        = COALESCE($8, current_file),
                   file_errors         = CASE WHEN $9::jsonb IS NULL
                                              THEN file_errors
                                              ELSE file_errors || $9::jsonb
                                         END,
                   last_progress_at    = now()
             WHERE job_id = $1
            """,
            job_id, processed, failed, new_instances, duplicate_instances,
            study_id, error, current_file, file_error_json,
        )


async def finish(job_id: str, status: str) -> None:
    async with pool().acquire() as con:
        await con.execute(
            """UPDATE import_jobs
                  SET status = $2, finished_at = now(), last_progress_at = now()
                WHERE job_id = $1 AND finished_at IS NULL""",
            job_id, status,
        )


async def cancel(job_id: str, *, reason: str = "cancelled by user") -> bool:
    """Atomic flip to terminal 'cancelled'. Returns True if the row was
    updated (i.e. job existed and was non-terminal). Idempotent: calling
    twice on the same job returns False the second time without raising."""
    async with pool().acquire() as con:
        row = await con.fetchval(
            """UPDATE import_jobs
                  SET status = 'cancelled',
                      finished_at = now(),
                      last_progress_at = now(),
                      errors = (array_append(errors, $2))[GREATEST(1, array_length(array_append(errors, $2), 1) - 19):]
                WHERE job_id = $1 AND finished_at IS NULL
            RETURNING 1""",
            job_id, reason,
        )
    return bool(row)


async def get(job_id: str) -> dict[str, Any] | None:
    async with pool().acquire() as con:
        row = await con.fetchrow("SELECT * FROM import_jobs WHERE job_id = $1", job_id)
        return _to_dict(row) if row else None


async def active_for_user(user_id: int) -> list[dict[str, Any]]:
    async with pool().acquire() as con:
        rows = await con.fetch(
            """SELECT * FROM import_jobs
                WHERE user_id = $1 AND finished_at IS NULL
                ORDER BY started_at DESC""",
            user_id,
        )
    return [_to_dict(r) for r in rows]


async def history_for_user(
    user_id: int,
    *,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    """List every job for the user, newest first. Returns (rows, total).

    `status` filter accepts a single status name or one of the buckets
    "active" (finished_at IS NULL) / "terminal" (finished_at IS NOT NULL).
    The total is computed for the same filter so the UI can paginate."""
    where = ["user_id = $1"]
    params: list[Any] = [user_id]
    if status == "active":
        where.append("finished_at IS NULL")
    elif status == "terminal":
        where.append("finished_at IS NOT NULL")
    elif status:
        params.append(status)
        where.append(f"status = ${len(params)}")
    where_sql = " AND ".join(where)

    params_paged = list(params) + [limit, offset]
    rows_sql = (
        f"SELECT * FROM import_jobs WHERE {where_sql} "
        f"ORDER BY started_at DESC LIMIT ${len(params)+1} OFFSET ${len(params)+2}"
    )
    count_sql = f"SELECT count(*) FROM import_jobs WHERE {where_sql}"
    async with pool().acquire() as con:
        rows = await con.fetch(rows_sql, *params_paged)
        total = await con.fetchval(count_sql, *params)
    return [_to_dict(r) for r in rows], int(total or 0)


async def find_stale(stale_seconds: int) -> list[dict[str, Any]]:
    """Non-terminal jobs whose last_progress_at is older than the
    threshold. Used by the lifespan sweeper. Light query — partial
    index `idx_import_jobs_stale` makes it cheap regardless of history
    size."""
    async with pool().acquire() as con:
        rows = await con.fetch(
            """SELECT * FROM import_jobs
                WHERE finished_at IS NULL
                  AND last_progress_at < now() - make_interval(secs => $1)
                ORDER BY last_progress_at ASC""",
            stale_seconds,
        )
    return [_to_dict(r) for r in rows]


async def mark_stale_failed(job_id: str, reason: str) -> bool:
    """Atomic flip of a non-terminal job to 'error' with a reason
    appended to errors[]. Used by the sweeper. Returns True if the
    update happened (i.e. job was still non-terminal at the moment
    of the UPDATE)."""
    async with pool().acquire() as con:
        row = await con.fetchval(
            """UPDATE import_jobs
                  SET status = 'error',
                      finished_at = now(),
                      last_progress_at = now(),
                      errors = (array_append(errors, $2))[GREATEST(1, array_length(array_append(errors, $2), 1) - 19):]
                WHERE job_id = $1 AND finished_at IS NULL
            RETURNING 1""",
            job_id, reason,
        )
    return bool(row)


async def mark_interrupted_on_startup() -> int:
    """Flip every non-terminal job to 'error'. Called from FastAPI lifespan."""
    async with pool().acquire() as con:
        result = await con.execute(
            """
            UPDATE import_jobs
               SET status = 'error',
                   errors = array_append(errors, 'interrupted by backend restart'),
                   finished_at = now(),
                   last_progress_at = now()
             WHERE finished_at IS NULL
            """,
        )
        # asyncpg returns "UPDATE N"; parse the count for logging.
        try:
            return int(result.split()[-1])
        except Exception as exc:
            _log.warning("mark_interrupted_on_startup: failed to parse asyncpg result %r (%s)", result, exc)
            return 0


def _to_dict(row) -> dict[str, Any]:
    started = row["started_at"].timestamp() if row["started_at"] else 0.0
    finished = row["finished_at"].timestamp() if row["finished_at"] else None
    last_prog = row["last_progress_at"].timestamp() if row["last_progress_at"] else started
    file_errs = row["file_errors"]
    # asyncpg returns JSONB as raw str unless a codec is registered; normalize.
    if isinstance(file_errs, str):
        try:
            file_errs = json.loads(file_errs)
        except Exception:
            file_errs = []
    return {
        "job_id": row["job_id"],
        "user_id": row["user_id"],
        "status": row["status"],
        "source_label": row["source_label"],
        "total_files": row["total_files"],
        "processed": row["processed"],
        "failed": row["failed"],
        "new_instances": row["new_instances"],
        "duplicate_instances": row["duplicate_instances"],
        "studies_created": len(row["study_ids"]),
        "study_ids": list(row["study_ids"]),
        "errors": list(row["errors"]),
        "file_errors": list(file_errs or []),
        "current_file": row["current_file"],
        "upload_ids": list(row["upload_ids"]),
        "started_at": started,
        "finished_at": finished,
        "last_progress_at": last_prog,
        "elapsed_seconds": (finished or time.time()) - started,
    }


def is_terminal(status: str) -> bool:
    return status in _TERMINAL_STATUSES
