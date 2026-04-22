#!/usr/bin/env python3
"""
Warm the nginx DICOMweb disk cache by hitting /dicom-web/studies/<uid>/metadata
for every study in the archive. After this, the first viewer open of any study
served is fast because nginx already has the metadata on disk — Orthanc never
has to re-read DICOM files for metadata answering.

Hits nginx (127.0.0.1:8080) so the proxy_cache dicomweb zone is populated;
nginx forwards upstream with its own injected Basic auth, so the client side
needs no credentials. Bounded concurrency to avoid slamming Orthanc.

Usage:
  python3 scripts/prewarm_dicomweb_metadata.py            # normal
  PREWARM_WORKERS=4 python3 scripts/prewarm_dicomweb_metadata.py
"""
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

NGINX = "http://127.0.0.1:8080"
WORKERS = int(os.environ.get("PREWARM_WORKERS", "3"))
TIMEOUT = 180


def list_study_uids() -> list[str]:
    """Use QIDO-RS via nginx — already populates the /studies cache entry for free."""
    req = urllib.request.Request(f"{NGINX}/dicom-web/studies", headers={"Accept": "application/dicom+json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        import json
        studies = json.loads(r.read())
    # 0020,000D = StudyInstanceUID
    return [s["0020000D"]["Value"][0] for s in studies if "0020000D" in s]


def warm(uid: str) -> tuple[str, float, int]:
    """Hit /dicom-web/studies/{uid}/metadata — the heavy call the viewer
    makes on study open. Orthanc reads every DICOM file for that study to
    build the metadata JSON; nginx caches the response for 24h, so after
    this prewarm the first-open latency drops from ~30s to ~200ms."""
    url = f"{NGINX}/dicom-web/studies/{uid}/metadata"
    t0 = time.monotonic()
    req = urllib.request.Request(url, headers={"Accept": "application/dicom+json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return uid, time.monotonic() - t0, len(r.read())
    except Exception:
        return uid, time.monotonic() - t0, -1


def main():
    uids = list_study_uids()
    print(f"prewarming {len(uids)} studies with {WORKERS} workers", flush=True)
    t0 = time.monotonic()
    ok = fail = total_bytes = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(warm, u): u for u in uids}
        for i, fut in enumerate(as_completed(futs), 1):
            uid, dt, size = fut.result()
            if size < 0:
                fail += 1
            else:
                ok += 1
                total_bytes += size
            if i % 50 == 0 or i == len(uids):
                mb = total_bytes / 1024 / 1024
                rate = i / (time.monotonic() - t0)
                eta = (len(uids) - i) / rate if rate else 0
                print(f"  {i}/{len(uids)}  ok={ok} fail={fail}  {mb:.0f}MB cached  "
                      f"rate={rate:.1f}/s ETA={eta:.0f}s", flush=True)
    print(f"done: ok={ok} fail={fail} total={total_bytes/1024/1024:.0f}MB elapsed={time.monotonic()-t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
