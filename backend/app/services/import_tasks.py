"""Tracker for in-flight `_process_one_file` asyncio tasks.

Two roles:
1. Keep a strong reference to every detached upload-processing task so
   the loop can't GC them mid-run (asyncio docs explicitly warn:
   "Save a reference to the result of [create_task]"). Without this,
   a fire-and-forget like `asyncio.create_task(_process_one_file(...))`
   can be cancelled by the GC under memory pressure.

2. Drain on lifespan shutdown: give running tasks a bounded window to
   finish (so an in-flight Orthanc POST completes and the file lands)
   instead of cancelling them mid-write. Anything past the deadline
   gets cancelled hard; `mark_interrupted_on_startup` recovers those
   on the next boot.
"""
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)

# Bounded grace window for in-flight tasks. Long enough to let a
# typical 5MB-DICOM POST + Orthanc store finish (~1-2s each, with up
# to UPLOAD_CONCURRENCY in flight); short enough to not block a
# rolling deploy past a reasonable healthcheck timeout.
SHUTDOWN_DRAIN_SECONDS = 30

_tasks: set[asyncio.Task] = set()


def track(task: asyncio.Task) -> None:
    """Register a detached task. Auto-removed on completion via
    add_done_callback so the set doesn't grow unboundedly."""
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def active_count() -> int:
    return len(_tasks)


async def drain(timeout: float = SHUTDOWN_DRAIN_SECONDS) -> tuple[int, int]:
    """Wait for tracked tasks to finish, then cancel any stragglers.

    Returns (completed, cancelled). Safe to call with no tasks running
    (returns (0, 0) immediately)."""
    if not _tasks:
        return (0, 0)
    snapshot = list(_tasks)
    log.info("import-tasks: draining %d in-flight tasks (timeout=%ds)", len(snapshot), int(timeout))
    done, pending = await asyncio.wait(snapshot, timeout=timeout)
    cancelled = 0
    for t in pending:
        t.cancel()
        cancelled += 1
    if pending:
        # Give cancellations a chance to propagate; ignore CancelledError.
        await asyncio.gather(*pending, return_exceptions=True)
    log.info("import-tasks: drain done — completed=%d cancelled=%d", len(done), cancelled)
    return (len(done), cancelled)
