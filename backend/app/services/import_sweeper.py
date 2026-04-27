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
# Two-tier threshold so the sweeper doesn't kill slow-but-honest
# uploads on the clinic's median 8.7 Mbps link (where a 4 GB ISO
# needs ~60 min of chunk PUTs and any WiFi handoff easily eats 5+
# min without progress). Never-started jobs (no processed/failed
# yet) still get reaped aggressively — those are usually
# closed-tab-mid-precheck.
STALE_NEVER_STARTED_SECONDS = 30 * 60       # processed=0 AND failed=0
STALE_IN_PROGRESS_SECONDS = 60 * 60         # has done some work, give more grace


async def _tick() -> int:
    # Pull the strictest threshold — anything past it is definitely
    # stale regardless of progress state. Then per-job, decide
    # whether to actually fail it or skip (in-progress jobs get the
    # longer grace window).
    stale = await import_jobs_repo.find_stale(STALE_NEVER_STARTED_SECONDS)
    if not stale:
        return 0
    flipped = 0
    now_idle_threshold_in_progress = STALE_IN_PROGRESS_SECONDS
    for job in stale:
        # `last_progress_at` drove the find_stale query; recompute idle
        # from elapsed_seconds isn't quite right (elapsed counts since
        # started_at, not last activity). Use the actual idle window:
        # since now() - last_progress_at. The repo dict gives us
        # last_progress_at as a unix ts.
        import time as _time
        idle_seconds = _time.time() - (job.get("last_progress_at") or job["started_at"])
        in_progress = (job["processed"] > 0 or job["failed"] > 0)
        threshold = now_idle_threshold_in_progress if in_progress else STALE_NEVER_STARTED_SECONDS
        if idle_seconds < threshold:
            continue
        idle_min = int(idle_seconds // 60)
        reason = (
            f"abandoned — no progress for {threshold // 60}+ min "
            f"(idle {idle_min} min, processed={job['processed']}/{job['total_files']})"
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
            "sweeper: marked job %s as stale-failed (uploads=%d, idle=%dm)",
            job["job_id"], len(job["upload_ids"]), idle_min,
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
