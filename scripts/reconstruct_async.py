#!/usr/bin/env python3
"""Async reconstruct via Orthanc jobs engine.

Submits every remaining study as an async reconstruct job (body
{"Asynchronous": true}). Orthanc queues them and runs up to
ConcurrentJobs=6 in parallel — real multi-core utilization.

Script keeps the queue primed (never more than MAX_QUEUED pending)
so memory is bounded. Progress reported by polling /jobs periodically.
"""
import asyncio
import os
import time

import httpx

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://orthanc:8042")
ORTHANC_USER = os.environ.get("ORTHANC_USERNAME", "orthanc")
ORTHANC_PASS = os.environ["ORTHANC_PASSWORD"]
SKIP_FIRST = int(os.environ.get("RECONSTRUCT_FROM", "0"))
MAX_QUEUED = int(os.environ.get("MAX_QUEUED", "50"))  # bound outstanding jobs
POLL_INTERVAL = 10.0


async def main():
    async with httpx.AsyncClient(
        base_url=ORTHANC_URL,
        auth=(ORTHANC_USER, ORTHANC_PASS),
        timeout=httpx.Timeout(60.0, connect=5.0),
    ) as c:
        sids = (await c.get("/studies")).json()
        remaining = sids[SKIP_FIRST:]
        total = len(remaining)
        print(f"submitting {total} async reconstructs (skip={SKIP_FIRST}, max_queued={MAX_QUEUED})", flush=True)

        submitted = 0
        done = 0
        err = 0
        t0 = time.monotonic()
        queued_ids: list[str] = []

        async def check_jobs():
            """Remove finished jobs from queued_ids; return (done_delta, err_delta)."""
            nonlocal queued_ids
            if not queued_ids:
                return 0, 0
            jobs = (await c.get("/jobs", params={"expand": ""})).json()
            state = {j["ID"]: j["State"] for j in jobs}
            still = []
            d = 0
            e = 0
            for jid in queued_ids:
                s = state.get(jid)
                if s in ("Success",):
                    d += 1
                elif s in ("Failure",):
                    e += 1
                else:
                    still.append(jid)
            queued_ids = still
            return d, e

        last_report = time.monotonic()
        for sid in remaining:
            # throttle if too many queued
            while len(queued_ids) >= MAX_QUEUED:
                d, e = await check_jobs()
                done += d
                err += e
                if d + e == 0:
                    await asyncio.sleep(2.0)

            try:
                r = await c.post(f"/studies/{sid}/reconstruct", json={"Asynchronous": True})
                if r.status_code == 200:
                    body = r.json()
                    jid = body.get("ID") or body.get("JobID") or body.get("Path", "").rsplit("/", 1)[-1]
                    if jid:
                        queued_ids.append(jid)
                    submitted += 1
                else:
                    err += 1
                    print(f"submit fail {r.status_code} {sid}", flush=True)
            except Exception as exc:
                err += 1
                print(f"submit err {sid}: {exc}", flush=True)

            # progress tick
            now = time.monotonic()
            if now - last_report >= POLL_INTERVAL:
                d, e = await check_jobs()
                done += d
                err += e
                elapsed = (now - t0) / 60
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else float("inf")
                print(f"submitted={submitted}/{total} done={done} err={err} queued={len(queued_ids)} rate={rate:.1f}/min eta={eta:.0f}min", flush=True)
                last_report = now

        # drain remaining queue
        while queued_ids:
            d, e = await check_jobs()
            done += d
            err += e
            if queued_ids:
                await asyncio.sleep(POLL_INTERVAL)
                elapsed = (time.monotonic() - t0) / 60
                print(f"draining: done={done} err={err} queued={len(queued_ids)} elapsed={elapsed:.1f}min", flush=True)

        total_min = (time.monotonic() - t0) / 60
        print(f"done — {done}/{total} submitted={submitted} err={err} in {total_min:.1f}min", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
