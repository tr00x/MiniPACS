#!/usr/bin/env python3
"""Parallel reconstruct — splits remaining studies across N workers.

Sequential reconstruct takes ~2 min/study on this VM, making the full
2621-archive pass ~87 hours. Orthanc has headroom (4% CPU observed during
sequential run), so we parallelize. N workers each pick a disjoint slice
and fire /studies/{id}/reconstruct serially within their slice.

Set RECONSTRUCT_FROM to resume from a known index (skip already-done ones).
"""
import asyncio
import os
import sys
import time

import httpx

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://orthanc:8042")
ORTHANC_USER = os.environ.get("ORTHANC_USERNAME", "orthanc")
ORTHANC_PASS = os.environ["ORTHANC_PASSWORD"]
WORKERS = int(os.environ.get("RECONSTRUCT_WORKERS", "4"))
SKIP_FIRST = int(os.environ.get("RECONSTRUCT_FROM", "0"))


async def worker(wid: int, sids: list[str], shared_client: httpx.AsyncClient, counter: dict):
    for sid in sids:
        t = time.monotonic()
        try:
            r = await shared_client.post(f"/studies/{sid}/reconstruct", json={})
            dt = time.monotonic() - t
            status = "OK " if r.status_code == 200 else f"{r.status_code}"
            counter["done"] += 1
            if r.status_code == 200:
                counter["ok"] += 1
            else:
                counter["err"] += 1
            print(f"w{wid} [{counter['done']:>5}/{counter['total']}] {status} {dt:>6.1f}s {sid}", flush=True)
        except Exception as exc:
            counter["done"] += 1
            counter["err"] += 1
            dt = time.monotonic() - t
            print(f"w{wid} [{counter['done']:>5}/{counter['total']}] ERR {dt:>6.1f}s {sid}: {exc}", flush=True)


async def main():
    async with httpx.AsyncClient(
        base_url=ORTHANC_URL,
        auth=(ORTHANC_USER, ORTHANC_PASS),
        timeout=httpx.Timeout(600.0, connect=5.0),
        limits=httpx.Limits(max_connections=WORKERS * 2, max_keepalive_connections=WORKERS * 2),
    ) as c:
        print(f"listing studies from {ORTHANC_URL}", flush=True)
        sids = (await c.get("/studies")).json()
        print(f"total {len(sids)}, skip first {SKIP_FIRST}, workers={WORKERS}", flush=True)
        remaining = sids[SKIP_FIRST:]

        # round-robin split
        chunks = [[] for _ in range(WORKERS)]
        for i, sid in enumerate(remaining):
            chunks[i % WORKERS].append(sid)

        counter = {"total": len(remaining), "done": 0, "ok": 0, "err": 0}
        t0 = time.monotonic()
        await asyncio.gather(*(worker(w, chunks[w], c, counter) for w in range(WORKERS)))
        total_min = (time.monotonic() - t0) / 60
        print(f"done — {counter['done']}/{counter['total']} in {total_min:.1f}min ok={counter['ok']} err={counter['err']}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
