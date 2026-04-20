#!/usr/bin/env python3
"""Prewarm DICOMweb metadata cache for every study in Orthanc.

First-open of a study in OHIF calls /dicom-web/studies/{uid}/metadata. In
StudiesMetadata=Full mode Orthanc opens every DICOM file to harvest tags —
22s for a 295-instance study. DICOMweb plugin v1.15+ caches the result as
a gzipped attachment (EnableMetadataCache=true default), so SECOND open is
instant. This script runs that first open in the background for every
existing study, so real users never pay the cold cost.

Usage (run inside the orthanc docker net or on host with ORTHANC_URL reachable):
    docker compose exec backend python /app/scripts/prewarm_dicomweb_metadata.py

Safe to rerun — already-cached studies return fast.
"""
import asyncio
import os
import sys
import time

import httpx

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://orthanc:8042")
ORTHANC_USER = os.environ.get("ORTHANC_USERNAME", "orthanc")
ORTHANC_PASS = os.environ["ORTHANC_PASSWORD"]  # fail fast if missing
CONCURRENCY = int(os.environ.get("PREWARM_CONCURRENCY", "3"))
# Orthanc HttpThreadsCount=50, but metadata extraction is CPU+IO-heavy;
# 3 in parallel keeps the box responsive for live users.


async def list_study_uids(client: httpx.AsyncClient) -> list[str]:
    """Fetch all StudyInstanceUIDs via QIDO-RS in one go — avoids the
    N+1 of /studies (Orthanc IDs) followed by /studies/{id} (for UID)."""
    resp = await client.get(
        "/dicom-web/studies",
        params={"limit": 100000, "includefield": "0020000D"},
    )
    resp.raise_for_status()
    out: list[str] = []
    for entry in resp.json():
        uid = entry.get("0020000D", {}).get("Value", [None])[0]
        if uid:
            out.append(uid)
    return out


async def warm_one(client: httpx.AsyncClient, uid: str, sem: asyncio.Semaphore, idx: int, total: int):
    async with sem:
        t0 = time.monotonic()
        try:
            r = await client.get(f"/dicom-web/studies/{uid}/metadata", timeout=300.0)
            dt = time.monotonic() - t0
            size_kb = len(r.content) / 1024
            status = "OK " if r.status_code == 200 else f"{r.status_code}"
            print(f"[{idx:>5}/{total}] {status} {dt:>6.2f}s {size_kb:>7.1f}KB {uid}", flush=True)
        except Exception as exc:
            dt = time.monotonic() - t0
            print(f"[{idx:>5}/{total}] ERR {dt:>6.2f}s              {uid}: {exc}", file=sys.stderr, flush=True)


async def main():
    async with httpx.AsyncClient(
        base_url=ORTHANC_URL,
        auth=(ORTHANC_USER, ORTHANC_PASS),
        timeout=httpx.Timeout(300.0, connect=5.0),
        limits=httpx.Limits(max_connections=CONCURRENCY * 2, max_keepalive_connections=CONCURRENCY * 2),
    ) as c:
        print(f"listing study UIDs from {ORTHANC_URL} via QIDO-RS ...", flush=True)
        uids = await list_study_uids(c)
        print(f"got {len(uids)} UIDs, warming metadata cache (concurrency={CONCURRENCY}) ...", flush=True)

        sem = asyncio.Semaphore(CONCURRENCY)
        t0 = time.monotonic()
        await asyncio.gather(*(warm_one(c, u, sem, i + 1, len(uids)) for i, u in enumerate(uids)))
        total = time.monotonic() - t0
        print(f"done — {len(uids)} studies in {total/60:.1f} min", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
