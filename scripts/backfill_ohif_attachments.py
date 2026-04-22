#!/usr/bin/env python3
"""
Backfill OHIF plugin DICOM-JSON attachments for studies that arrived before
the plugin was enabled. New studies get the attachment automatically via the
OnStableStudy Lua prewarm — this script handles the historical archive.

For each study, GET /studies/{id}/ohif-dicom-json triggers the plugin to
read tags, build the JSON, and cache it as a SQLite attachment. Subsequent
viewer opens then serve from the attachment (no disk I/O).

Run inside the backend container (which has httpx + ORTHANC_* env vars):
    docker compose -f docker-compose.prod.yml exec backend \
        python /app/scripts/backfill_ohif_attachments.py

Idempotent: if the attachment already exists, the plugin returns it fast.
Concurrency is bounded by Orthanc ConcurrentJobs (6) × our worker pool (4)
so the host doesn't overload. Progress printed every 25 studies.
"""

from __future__ import annotations

import concurrent.futures
import os
import sys
import time
from typing import Tuple

import httpx

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://orthanc:8042")
USERNAME = os.environ.get("ORTHANC_USERNAME", "orthanc")
PASSWORD = os.environ["ORTHANC_PASSWORD"]

WORKERS = int(os.environ.get("BACKFILL_WORKERS", "4"))
TIMEOUT = httpx.Timeout(120.0, connect=10.0)


def warm_one(client: httpx.Client, study_id: str) -> Tuple[str, bool, str]:
    try:
        r = client.get(f"/studies/{study_id}/ohif-dicom-json")
        if r.status_code == 200:
            return (study_id, True, f"{len(r.content)}B")
        return (study_id, False, f"HTTP {r.status_code}")
    except httpx.HTTPError as e:
        return (study_id, False, str(e)[:80])


def main() -> int:
    with httpx.Client(
        base_url=ORTHANC_URL, auth=(USERNAME, PASSWORD), timeout=TIMEOUT
    ) as client:
        studies = client.get("/studies").json()
        total = len(studies)
        print(f"backfill: {total} studies, {WORKERS} workers")

        ok_count = 0
        fail_count = 0
        start = time.time()

        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = [pool.submit(warm_one, client, sid) for sid in studies]
            for i, fut in enumerate(concurrent.futures.as_completed(futures), 1):
                sid, ok, info = fut.result()
                if ok:
                    ok_count += 1
                else:
                    fail_count += 1
                    print(f"  FAIL {sid}: {info}", file=sys.stderr)
                if i % 25 == 0 or i == total:
                    elapsed = time.time() - start
                    rate = i / elapsed if elapsed else 0
                    eta = (total - i) / rate if rate else 0
                    print(
                        f"  {i}/{total}  ok={ok_count} fail={fail_count}  "
                        f"{rate:.1f}/s  ETA {eta:.0f}s"
                    )

        elapsed = time.time() - start
        print(f"done in {elapsed:.0f}s — ok={ok_count} fail={fail_count}")
        return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
