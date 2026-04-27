"""Background task that fails import jobs which have stopped making progress.

A job is "stale" if it's still non-terminal (finished_at IS NULL) and
its last_progress_at timestamp is older than STALE_THRESHOLD_SECONDS.
That timestamp is updated on every chunk PUT, status change, and
counter increment, so an actively-uploading or actively-processing job
will never be reaped by accident — only abandoned ones (browser closed
mid-upload, machine slept, network died and retry never came).

The sweeper also calls upload_staging.cleanup() for every upload_id
attached to the failed job, so disk doesn't accumulate orphaned
chunks. The 24h staging GC would catch them eventually, but reclaiming
right away keeps the dashboard's reported staging-size honest.

Tick cadence: every TICK_SECONDS. Each tick costs one indexed query
(idx_import_jobs_stale, partial index on finished_at IS NULL) plus a
handful of updates only when there are stale jobs — effectively free.
"""
from __future__ import annotations

import asyncio
import logging

from app.services import import_jobs_repo, upload_staging

log = logging.getLogger(__name__)

TICK_SECONDS = 60
# 30 min covers a long lunch + WiFi handoff. Anything past this and
# the upload is almost certainly never coming back — better to flip
# to error so the UI dialog can offer Retry instead of forever-Queued.
STALE_THRESHOLD_SECONDS = 30 * 60


async def _tick() -> int:
    stale = await import_jobs_repo.find_stale(STALE_THRESHOLD_SECONDS)
    if not stale:
        return 0
    flipped = 0
    for job in stale:
        idle_min = int((job["elapsed_seconds"] - 0) // 60)
        # `last_progress_at` is the field that drove selection; surface a
        # human-readable line in errors[].
        reason = (
            f"abandoned — no progress for {STALE_THRESHOLD_SECONDS // 60}+ min "
            f"(elapsed {idle_min} min)"
        )
        ok = await import_jobs_repo.mark_stale_failed(job["job_id"], reason)
        if not ok:
            continue  # raced with cancel/finish, skip cleanup
        flipped += 1
        for uid in job["upload_ids"]:
            try:
                await upload_staging.cleanup(uid)
            except Exception:  # noqa: BLE001
                log.exception("sweeper: cleanup of upload %s failed", uid)
        log.warning(
            "sweeper: marked job %s as stale-failed (uploads=%d)",
            job["job_id"], len(job["upload_ids"]),
        )
    return flipped


async def loop() -> None:
    """Run _tick() forever. Call from FastAPI lifespan as a task —
    cancellation on shutdown is handled by the lifespan context."""
    while True:
        try:
            await _tick()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("sweeper tick failed")
        await asyncio.sleep(TICK_SECONDS)
