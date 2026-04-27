"""CRUD + counters over the import_jobs table.

Replaces the in-memory _jobs dict from the MVP. Every state change
(extracting → uploading → done) goes through here so a parallel tab
or a backend restart sees coherent state.

All callers MUST go through this module, never write to import_jobs
directly — that keeps the JSON shape returned to the frontend in one
place (to_dict in this module mirrors what useImportJob expects).
"""
from __future__ import annotations

import time
from typing import Any

from app.db import pool


async def create(job_id: str, user_id: int) -> None:
    async with pool().acquire() as con:
        await con.execute(
            """INSERT INTO import_jobs (job_id, user_id, status)
               VALUES ($1, $2, 'queued')""",
            job_id, user_id,
        )


async def attach_upload(job_id: str, upload_id: str) -> None:
    async with pool().acquire() as con:
        await con.execute(
            "UPDATE import_jobs SET upload_ids = array_append(upload_ids, $2) WHERE job_id = $1",
            job_id, upload_id,
        )


async def set_status(job_id: str, status: str, *, current_file: str | None = None) -> None:
    async with pool().acquire() as con:
        if current_file is not None:
            await con.execute(
                "UPDATE import_jobs SET status = $2, current_file = $3 WHERE job_id = $1",
                job_id, status, current_file,
            )
        else:
            await con.execute(
                "UPDATE import_jobs SET status = $2 WHERE job_id = $1",
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
) -> None:
    """Atomic increment + optional study_ids/errors append."""
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
                                              ELSE array_append(errors, $7) END,
                   current_file        = COALESCE($8, current_file)
             WHERE job_id = $1
            """,
            job_id, processed, failed, new_instances, duplicate_instances,
            study_id, error, current_file,
        )


async def finish(job_id: str, status: str) -> None:
    async with pool().acquire() as con:
        await con.execute(
            "UPDATE import_jobs SET status = $2, finished_at = now() WHERE job_id = $1",
            job_id, status,
        )


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


async def mark_interrupted_on_startup() -> int:
    """Flip every non-terminal job to 'error'. Called from FastAPI lifespan."""
    async with pool().acquire() as con:
        result = await con.execute(
            """
            UPDATE import_jobs
               SET status = 'error',
                   errors = array_append(errors, 'interrupted by backend restart'),
                   finished_at = now()
             WHERE finished_at IS NULL
            """,
        )
        # asyncpg returns "UPDATE N"; parse the count for logging.
        try:
            return int(result.split()[-1])
        except Exception:
            return 0


def _to_dict(row) -> dict[str, Any]:
    started = row["started_at"].timestamp() if row["started_at"] else 0.0
    finished = row["finished_at"].timestamp() if row["finished_at"] else None
    return {
        "job_id": row["job_id"],
        "status": row["status"],
        "total_files": row["total_files"],
        "processed": row["processed"],
        "failed": row["failed"],
        "new_instances": row["new_instances"],
        "duplicate_instances": row["duplicate_instances"],
        "studies_created": len(row["study_ids"]),
        "study_ids": list(row["study_ids"]),
        "errors": list(row["errors"])[-20:],
        "current_file": row["current_file"],
        "upload_ids": list(row["upload_ids"]),
        "started_at": started,
        "finished_at": finished,
        "elapsed_seconds": (finished or time.time()) - started,
    }
