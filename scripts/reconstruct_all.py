#!/usr/bin/env python3
"""Reconstruct every Orthanc study to re-index DICOM tags.

After adding ExtraMainDicomTags to orthanc config and restarting, existing
studies still have only the old tag set in the SQLite index. This script
iterates all studies and triggers /studies/{id}/reconstruct, which re-reads
files and refreshes the index. Run once, in the background, after the
config change.

Usage:
    docker compose exec -d backend python /tmp/reconstruct_all.py

Expected runtime: 2-4h on the clinic VM (I/O-bound). Sequential on purpose
so the box stays responsive for live users.
"""
import httpx
import os
import sys
import time

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://orthanc:8042")
ORTHANC_USER = os.environ.get("ORTHANC_USERNAME", "orthanc")
ORTHANC_PASS = os.environ["ORTHANC_PASSWORD"]


def main():
    with httpx.Client(
        base_url=ORTHANC_URL,
        auth=(ORTHANC_USER, ORTHANC_PASS),
        timeout=httpx.Timeout(3600.0, connect=5.0),
    ) as c:
        print(f"listing studies ...", flush=True)
        sids = c.get("/studies").json()
        total = len(sids)
        print(f"reconstructing {total} studies sequentially", flush=True)

        t0 = time.monotonic()
        ok = 0
        err = 0
        for i, sid in enumerate(sids, 1):
            t = time.monotonic()
            try:
                r = c.post(f"/studies/{sid}/reconstruct", json={})
                dt = time.monotonic() - t
                if r.status_code == 200:
                    ok += 1
                    print(f"[{i:>5}/{total}] OK  {dt:>6.1f}s {sid}", flush=True)
                else:
                    err += 1
                    print(f"[{i:>5}/{total}] HTTP {r.status_code} {dt:>6.1f}s {sid}", flush=True)
            except Exception as exc:
                err += 1
                dt = time.monotonic() - t
                print(f"[{i:>5}/{total}] ERR {dt:>6.1f}s {sid}: {exc}", file=sys.stderr, flush=True)
            # progress line every 50
            if i % 50 == 0:
                elapsed = (time.monotonic() - t0) / 60
                eta = elapsed * (total - i) / i
                print(f"  -- progress: {i}/{total} ({100*i/total:.1f}%) elapsed={elapsed:.1f}min eta={eta:.1f}min ok={ok} err={err}", flush=True)

        total_min = (time.monotonic() - t0) / 60
        print(f"done — {total} studies in {total_min:.1f}min (ok={ok} err={err})", flush=True)


if __name__ == "__main__":
    main()
