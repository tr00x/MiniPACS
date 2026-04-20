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


async def list_studies(client: httpx.AsyncClient) -> list[str]:
    resp = await client.get("/studies", params={"limit": 100000})
    resp.raise_for_status()
    return resp.json()


async def study_uid(client: httpx.AsyncClient, sid: str) -> str | None:
    try:
        r = await client.get(f"/studies/{sid}")
        r.raise_for_status()
        return r.json()["MainDicomTags"].get("StudyInstanceUID")
    except Exception as exc:
        print(f"  ! skip {sid}: {exc}", file=sys.stderr)
        return None


async def warm_one(client: httpx.AsyncClient, uid: str, sem: asyncio.Semaphore, idx: int, total: int):
    async with sem:
        t0 = time.monotonic()
        try:
            r = await client.get(f"/dicom-web/studies/{uid}/metadata", timeout=300.0)
            dt = time.monotonic() - t0
            size_kb = len(r.content) / 1024
            status = "OK " if r.status_code == 200 else f"{r.status_code}"
            print(f"[{idx:>5}/{total}] {status} {dt:>6.2f}s {size_kb:>7.1f}KB {uid}")
        except Exception as exc:
            dt = time.monotonic() - t0
            print(f"[{idx:>5}/{total}] ERR {dt:>6.2f}s              {uid}: {exc}", file=sys.stderr)


async def main():
    async with httpx.AsyncClient(
        base_url=ORTHANC_URL,
        auth=(ORTHANC_USER, ORTHANC_PASS),
        timeout=httpx.Timeout(60.0, connect=5.0),
        limits=httpx.Limits(max_connections=CONCURRENCY * 2, max_keepalive_connections=CONCURRENCY * 2),
    ) as c:
        print(f"listing studies from {ORTHANC_URL} ...")
        sids = await list_studies(c)
        print(f"found {len(sids)} studies, resolving UIDs ...")

        uid_sem = asyncio.Semaphore(8)

        async def resolve(sid):
            async with uid_sem:
                return await study_uid(c, sid)

        uids = [u for u in await asyncio.gather(*(resolve(s) for s in sids)) if u]
        print(f"resolved {len(uids)} UIDs, warming metadata cache (concurrency={CONCURRENCY}) ...")

        sem = asyncio.Semaphore(CONCURRENCY)
        t0 = time.monotonic()
        await asyncio.gather(*(warm_one(c, u, sem, i + 1, len(uids)) for i, u in enumerate(uids)))
        total = time.monotonic() - t0
        print(f"done — {len(uids)} studies in {total/60:.1f} min")


if __name__ == "__main__":
    asyncio.run(main())
