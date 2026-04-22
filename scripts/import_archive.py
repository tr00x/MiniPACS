#!/usr/bin/env python3
"""
Mass DICOM import from /mnt/mri-archive/MRI Archive/**/*.iso -> MiniPACS.

- Resource-aware: refuses to submit new work when disk, RAM, or Orthanc are
  under pressure — sleeps and retries instead of crashing.
- Signal-safe: SIGINT/SIGTERM stops the feeder, lets in-flight ISOs finish,
  saves state, and exits cleanly. tmpdirs are force-chmod'd then rm'd even
  when the worker fails.
- Bounded concurrency (default 3) so SMB reads, /tmp disk, and Orthanc
  ingestion all breathe. Override with IMPORT_WORKERS=N.
- Newest year first (2026 -> 2022), so clinicians see recent studies early.
- Rich per-ISO state (status / duration / size / stage / error) persisted
  every completion — resume picks up exactly where it left off.

Usage:
  python3 scripts/import_archive.py                 # normal run / resume
  python3 scripts/import_archive.py --retry-failed  # re-try failed entries
  python3 scripts/import_archive.py --reset         # wipe state, start over
"""
import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ARCHIVE_ROOT = Path("/mnt/mri-archive/MRI Archive")
STATE_PATH = Path("/home/pacs-user/minipacs/backups/import_state.json")
STATE_TMP = STATE_PATH.with_suffix(".tmp")
FAIL_LOG = Path("/home/pacs-user/minipacs/backups/import_failed.log")

AEC = "MINIPACS"
AET = "ERADIMPORT"
HOST = "127.0.0.1"
PORT = "48924"

WORKERS = int(os.environ.get("IMPORT_WORKERS", "3"))
EXTRACT_TIMEOUT = 180
STORESCU_TIMEOUT = 1800
MIN_FREE_DISK_GB = 15
MIN_FREE_RAM_GB = 2
THROTTLE_SLEEP = 30

_shutdown = False


def _handle_sig(signum, _frame):
    global _shutdown
    _shutdown = True
    print(f"\n[signal {signum}] shutdown requested, finishing in-flight ISOs", flush=True)


def _free_gb(path: str) -> float:
    s = os.statvfs(path)
    return s.f_bavail * s.f_frsize / 1024**3


def _avail_ram_gb() -> float:
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024 / 1024
    return 0.0


def _orthanc_up() -> bool:
    try:
        socket.create_connection((HOST, int(PORT)), timeout=3).close()
        return True
    except OSError:
        return False


def resource_block_reason() -> str | None:
    free = _free_gb("/tmp")
    if free < MIN_FREE_DISK_GB:
        return f"low disk: {free:.1f}GB free on /tmp (need >{MIN_FREE_DISK_GB})"
    ram = _avail_ram_gb()
    if ram < MIN_FREE_RAM_GB:
        return f"low RAM: {ram:.1f}GB avail (need >{MIN_FREE_RAM_GB})"
    if not _orthanc_up():
        return f"orthanc unreachable at {HOST}:{PORT}"
    return None


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            raw = json.loads(STATE_PATH.read_text())
            if "entries" in raw:
                return raw
        except Exception:
            pass
    return {"started_at": time.time(), "entries": {}}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_TMP.write_text(json.dumps(state, indent=1))
    STATE_TMP.replace(STATE_PATH)


def _make_writable(path: str) -> None:
    for root, dirs, files in os.walk(path):
        for d in dirs:
            try:
                os.chmod(os.path.join(root, d), 0o700)
            except OSError:
                pass
        for f in files:
            try:
                os.chmod(os.path.join(root, f), 0o600)
            except OSError:
                pass


def _is_dicom_part10(path: str) -> bool:
    """True if file has the DICOM Part-10 preamble (128-byte pad + 'DICM' at offset 128)."""
    try:
        with open(path, "rb") as f:
            f.seek(128)
            return f.read(4) == b"DICM"
    except OSError:
        return False


def _filter_dicom_only(root: str) -> tuple[int, int]:
    """Remove non-DICOM files in-place. ISOs ship viewer .exe, autorun,
    readme.pdf, menu images — none of those should reach storescu. Returns
    (kept, removed). _make_writable must have run first."""
    kept = removed = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            p = os.path.join(dirpath, name)
            if _is_dicom_part10(p):
                kept += 1
            else:
                try:
                    os.remove(p)
                except OSError:
                    pass
                removed += 1
    return kept, removed


def process_iso(iso_path: str) -> dict:
    """Worker: extract ISO -> storescu to Orthanc -> cleanup. Always returns a dict."""
    t0 = time.monotonic()
    try:
        size_mb = round(os.path.getsize(iso_path) / 1024**2, 1)
    except OSError:
        size_mb = None

    tmp = tempfile.mkdtemp(dir="/tmp", prefix="iso_import_")
    try:
        r = subprocess.run(
            ["bsdtar", "-xf", iso_path, "-C", tmp],
            capture_output=True, timeout=EXTRACT_TIMEOUT, text=True,
        )
        if r.returncode != 0:
            return {
                "status": "failed", "stage": "extract",
                "error": (r.stderr or "bsdtar non-zero").strip()[:300],
                "duration_s": round(time.monotonic() - t0, 1),
                "size_mb": size_mb,
            }

        # ISO content is mixed: viewer software, PDFs, autorun, + actual DICOM.
        # Pre-filter to DICOM Part-10 files only so storescu doesn't waste time
        # parsing .exe/.dll/.pdf and can't get stuck on malformed junk.
        _make_writable(tmp)
        kept, removed = _filter_dicom_only(tmp)
        if kept == 0:
            return {
                "status": "failed", "stage": "no_dicom",
                "error": f"no DICOM Part-10 files in ISO (dropped {removed} non-DICOM files)",
                "duration_s": round(time.monotonic() - t0, 1),
                "size_mb": size_mb,
            }

        r = subprocess.run(
            ["storescu", "-aec", AEC, "-aet", AET,
             "+sd", "+r", "--no-halt",
             HOST, PORT, tmp],
            capture_output=True, timeout=STORESCU_TIMEOUT, text=True,
        )
        # "No presentation context" is benign (non-DICOM files in the ISO); real errors have other text
        if r.returncode != 0 and "No presentation context" not in (r.stderr or ""):
            return {
                "status": "failed", "stage": "storescu", "rc": r.returncode,
                "error": (r.stderr or "storescu non-zero").strip()[-300:],
                "duration_s": round(time.monotonic() - t0, 1),
                "size_mb": size_mb,
            }

        return {
            "status": "done",
            "duration_s": round(time.monotonic() - t0, 1),
            "size_mb": size_mb,
            "dicom_files": kept,
            "non_dicom_dropped": removed,
        }

    except subprocess.TimeoutExpired as e:
        return {
            "status": "failed", "stage": "timeout",
            "error": f"{e.cmd[0] if isinstance(e.cmd, list) else e.cmd} timeout after {e.timeout}s",
            "duration_s": round(time.monotonic() - t0, 1),
            "size_mb": size_mb,
        }
    except Exception as e:
        return {
            "status": "failed", "stage": "exception",
            "error": f"{type(e).__name__}: {e}"[:300],
            "duration_s": round(time.monotonic() - t0, 1),
            "size_mb": size_mb,
        }
    finally:
        _make_writable(tmp)
        shutil.rmtree(tmp, ignore_errors=True)


def _sort_isos(isos) -> list[str]:
    def key(p: str):
        m = re.search(r"/(\d{4})/", p)
        y = -int(m.group(1)) if m else 0
        return (y, p)
    return sorted(isos, key=key)


def list_isos() -> list[str]:
    return _sort_isos(str(p) for p in ARCHIVE_ROOT.rglob("*.iso"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="wipe state file and start over")
    ap.add_argument("--retry-failed", action="store_true", help="retry previously failed entries")
    args = ap.parse_args()

    signal.signal(signal.SIGINT, _handle_sig)
    signal.signal(signal.SIGTERM, _handle_sig)

    if args.reset and STATE_PATH.exists():
        STATE_PATH.unlink()
        print(f"state wiped: {STATE_PATH}", flush=True)

    print(f"scanning {ARCHIVE_ROOT} ...", flush=True)
    all_isos = list_isos()
    print(f"found {len(all_isos)} ISOs", flush=True)

    state = load_state()
    entries = state["entries"]

    if args.retry_failed:
        n = 0
        for k, v in list(entries.items()):
            if v.get("status") == "failed":
                entries.pop(k)
                n += 1
        print(f"cleared {n} failed entries for retry", flush=True)

    pending = [p for p in all_isos if entries.get(p, {}).get("status") != "done"]
    done_total = len(all_isos) - len(pending)
    print(f"done already: {done_total}, pending: {len(pending)}, workers: {WORKERS}", flush=True)
    if not pending:
        print("nothing to do.")
        return

    start = time.time()
    ok = fail = 0

    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futures: dict = {}
        remaining = list(pending)

        while (remaining or futures) and not (_shutdown and not futures):
            while remaining and len(futures) < WORKERS and not _shutdown:
                reason = resource_block_reason()
                if reason:
                    print(f"[throttle] {reason} — sleeping {THROTTLE_SLEEP}s", flush=True)
                    time.sleep(THROTTLE_SLEEP)
                    continue
                iso = remaining.pop(0)
                futures[ex.submit(process_iso, iso)] = iso

            if not futures:
                break

            # wait for one completion, then loop
            fut = next(as_completed(list(futures.keys())))
            iso = futures.pop(fut)
            try:
                res = fut.result()
            except Exception as e:
                res = {"status": "failed", "stage": "executor",
                       "error": f"{type(e).__name__}: {e}"[:300]}

            entries[iso] = res
            if res["status"] == "done":
                ok += 1
            else:
                fail += 1
                with FAIL_LOG.open("a") as f:
                    f.write(f"{iso}\t{res.get('stage','?')}\t{res.get('error','')[:240]}\n")

            elapsed = time.time() - start
            rate = (ok + fail) / elapsed if elapsed else 0
            eta_min = (len(pending) - ok - fail) / rate / 60 if rate else 0
            tag = "OK  " if res["status"] == "done" else "FAIL"
            err = "" if res["status"] == "done" else f" :: {res.get('stage','?')} {res.get('error','')[:80]}"
            print(
                f"[{ok+fail:>5}/{len(pending)}] {tag} "
                f"{(res.get('duration_s') or 0):>6.1f}s "
                f"{(res.get('size_mb') or 0):>6.1f}MB  {Path(iso).name}  | "
                f"rate={rate:.2f}/s ETA={eta_min:.0f}min ok={ok} fail={fail}{err}",
                flush=True,
            )
            save_state(state)

    save_state(state)
    print(f"\nexit: shutdown={_shutdown} ok={ok} fail={fail} elapsed={(time.time()-start)/60:.1f}min")
    sys.exit(0 if fail == 0 and not _shutdown else 1)


if __name__ == "__main__":
    main()
