"""Study import — drag-and-drop upload path.

Client POSTs one or more files to /api/studies/import. The request returns
immediately with a job_id; extraction + per-instance upload to Orthanc runs
on the backend event loop so the browser is never held on a single
multi-GB request. Progress is polled via /api/studies/import/{job_id}.

Accepted shapes, transparently to the client:

  * Bare DICOM files (.dcm, or anything whose bytes start with the DICM
    preamble at offset 128)
  * ZIP / TAR / 7Z / ISO archives — unpacked server-side with the `7z` CLI
    (p7zip-full), which understands all four formats plus RAR and UDF-ISO.
  * Nested trees — the extract output is walked recursively; only files
    matching the DICM magic are sent to Orthanc.

Rejected files count toward `failed` and surface in the job's `errors[]`
with a short reason.  Non-DICOM payloads inside an archive are silently
skipped — we do not treat an archive that happens to also contain a PDF
or a .zip-of-a-zip as a failure.

Auth: standard JWT bearer (same as every other /api/* route).

Upload lifecycle is best-effort durable — we keep the temp staging
directory until the job reaches a terminal state (done / error), then
clean up. The in-memory job dict is bounded by _JOB_RETAIN_SECONDS so a
reconnecting client can still see the final summary for ~10 minutes.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/studies/import", tags=["import"])
log = logging.getLogger(__name__)

# How long a completed job remains queryable. 10 minutes is enough for a
# radiologist who closed the tab mid-upload to reopen and see the final
# summary without us growing the dict unboundedly.
_JOB_RETAIN_SECONDS = 600.0
# Per-file upload concurrency. Orthanc HttpThreadsCount = 50, but we share
# that pool with every /api/studies worklist call — 8 parallel uploads
# leaves plenty of headroom even under active viewing traffic.
_UPLOAD_CONCURRENCY = 8
# Hard cap per job so one runaway operator-initiated import can't exhaust
# disk. 20 GB covers a full CD ISO of CT studies; beyond this the client
# should run scripts/import_archive.py.
_MAX_JOB_SIZE_BYTES = 20 * 1024**3

_ARCHIVE_SUFFIXES = {
    ".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2",
    ".tar.xz", ".txz", ".7z", ".iso", ".img",
}


@dataclass
class ImportJob:
    job_id: str
    user_id: int
    status: str = "queued"          # queued | extracting | uploading | done | error
    total_files: int = 0            # DICOM instances found across all inputs
    processed: int = 0              # successfully uploaded
    failed: int = 0
    errors: list[str] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    current_file: str = ""
    # Orthanc gives us back {ID, ParentPatient, ParentStudy, ParentSeries}
    # per uploaded instance. Worklist cares about unique parent studies —
    # track that set so the final summary reports how many *studies* the
    # operator actually added, not instance count.
    study_ids: set[str] = field(default_factory=set)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "status": self.status,
            "total_files": self.total_files,
            "processed": self.processed,
            "failed": self.failed,
            "errors": self.errors[-20:],   # cap on the wire
            "current_file": self.current_file,
            "studies_created": len(self.study_ids),
            "study_ids": list(self.study_ids),
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_seconds": (self.finished_at or time.time()) - self.started_at,
        }


_jobs: dict[str, ImportJob] = {}
_jobs_lock = asyncio.Lock()


def _is_dicom(path: Path) -> bool:
    """DICOM Part 10 preamble: 128-byte pad + b'DICM' at offset 128."""
    try:
        with open(path, "rb") as f:
            f.seek(128)
            return f.read(4) == b"DICM"
    except OSError:
        return False


def _has_archive_suffix(filename: str) -> bool:
    low = filename.lower()
    return any(low.endswith(sfx) for sfx in _ARCHIVE_SUFFIXES)


def _extract_archive(archive_path: Path, dest_dir: Path) -> tuple[bool, str]:
    """Extract via `7z x` — handles zip, tar*, 7z, iso, udf, rar."""
    try:
        result = subprocess.run(
            ["7z", "x", "-y", f"-o{dest_dir}", str(archive_path)],
            capture_output=True, timeout=600, check=False,
        )
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or b"").decode(errors="replace").strip().splitlines()[-3:]
            return False, f"7z exit {result.returncode}: {' | '.join(tail)}"
        return True, ""
    except FileNotFoundError:
        return False, "7z not installed in backend image"
    except subprocess.TimeoutExpired:
        return False, "7z timed out after 10 min"
    except Exception as exc:  # noqa: BLE001
        return False, f"7z error: {exc}"


def _walk_dicom(root: Path):
    """Yield every DICOM file under `root` (any depth)."""
    for dirpath, _dirs, filenames in os.walk(root):
        for name in filenames:
            p = Path(dirpath) / name
            if _is_dicom(p):
                yield p


async def _upload_one(job: ImportJob, path: Path, sem: asyncio.Semaphore) -> None:
    async with sem:
        job.current_file = path.name
        try:
            data = path.read_bytes()
            resp = await orthanc._http().post("/instances", content=data,
                                              headers={"Content-Type": "application/dicom"})
            if resp.status_code >= 300:
                job.failed += 1
                job.errors.append(f"{path.name}: orthanc {resp.status_code}")
                return
            payload = resp.json()
            # /instances returns either a dict or a list depending on the
            # ingested transfer syntax; normalize.
            items = payload if isinstance(payload, list) else [payload]
            for item in items:
                sid = item.get("ParentStudy")
                if sid:
                    job.study_ids.add(sid)
            job.processed += 1
        except Exception as exc:  # noqa: BLE001
            job.failed += 1
            job.errors.append(f"{path.name}: {exc}")


async def _run_job(job: ImportJob, staging: Path, source_files: list[Path]) -> None:
    """Background driver: expand archives, collect DICOMs, upload concurrently."""
    try:
        job.status = "extracting"

        # Expand archives in place. Bare DICOMs are left where they are;
        # archives produce sibling extract/ dirs we then walk.
        extract_roots: list[Path] = []
        for src in source_files:
            if _has_archive_suffix(src.name):
                out = staging / f"extract-{src.stem}-{uuid.uuid4().hex[:8]}"
                out.mkdir(parents=True, exist_ok=True)
                ok, err = _extract_archive(src, out)
                if not ok:
                    job.failed += 1
                    job.errors.append(f"{src.name}: {err}")
                    continue
                extract_roots.append(out)
            else:
                # bare upload candidate — _is_dicom filter applied below
                extract_roots.append(src.parent)

        # Dedup across all walk roots (extract dirs can share parents).
        seen: set[Path] = set()
        dicom_files: list[Path] = []
        for root in extract_roots:
            for p in _walk_dicom(root):
                rp = p.resolve()
                if rp not in seen:
                    seen.add(rp)
                    dicom_files.append(p)
        # Also include any source file that is itself a DICOM (no archive,
        # no extension trickery — just magic bytes).
        for src in source_files:
            if not _has_archive_suffix(src.name) and _is_dicom(src):
                rp = src.resolve()
                if rp not in seen:
                    seen.add(rp)
                    dicom_files.append(src)

        job.total_files = len(dicom_files)
        if job.total_files == 0:
            job.status = "done"
            job.finished_at = time.time()
            if not job.errors:
                job.errors.append("no DICOM files found in the upload")
            return

        job.status = "uploading"
        sem = asyncio.Semaphore(_UPLOAD_CONCURRENCY)
        await asyncio.gather(*(_upload_one(job, p, sem) for p in dicom_files))

        job.status = "done" if job.failed == 0 else ("done" if job.processed > 0 else "error")
        job.finished_at = time.time()

        # Bust the QIDO cache so the worklist reflects the new studies on
        # the next refresh even if the Python-plugin STABLE_STUDY event has
        # not yet fired (it will fire ~60s after the last instance anyway,
        # but the UI user wants to see their uploads immediately).
        try:
            await orthanc.invalidate_study_caches()
        except Exception:
            pass
    except Exception as exc:  # noqa: BLE001
        log.exception("import job %s crashed", job.job_id)
        job.status = "error"
        job.errors.append(f"internal: {exc}")
        job.finished_at = time.time()
    finally:
        # Aggressive cleanup — staging dirs can be gigabytes.
        try:
            shutil.rmtree(staging, ignore_errors=True)
        except Exception:
            pass


async def _gc_old_jobs() -> None:
    """Drop completed jobs older than the retention window."""
    cutoff = time.time() - _JOB_RETAIN_SECONDS
    async with _jobs_lock:
        stale = [k for k, v in _jobs.items()
                 if v.finished_at is not None and v.finished_at < cutoff]
        for k in stale:
            _jobs.pop(k, None)


@router.post("")
async def start_import(
    request: Request,
    files: list[UploadFile] = File(...),
    user: dict = Depends(get_current_user),
):
    if not files:
        raise HTTPException(400, "no files uploaded")

    await _gc_old_jobs()

    staging = Path(tempfile.mkdtemp(prefix="minipacs-import-"))
    source_files: list[Path] = []
    size_total = 0
    try:
        for uf in files:
            if not uf.filename:
                continue
            # Normalize filename — strip any path component a multipart client
            # might have set (Safari sends "folder/subfolder/file.dcm").
            rel = Path(uf.filename).name or f"unnamed-{uuid.uuid4().hex[:8]}"
            target = staging / rel
            # If a multipart upload carried the same basename twice (webkit
            # dir upload of a_nested/file.dcm + b_nested/file.dcm), keep both.
            if target.exists():
                target = staging / f"{uuid.uuid4().hex[:8]}-{rel}"
            with open(target, "wb") as out:
                while True:
                    chunk = await uf.read(1024 * 1024)
                    if not chunk:
                        break
                    size_total += len(chunk)
                    if size_total > _MAX_JOB_SIZE_BYTES:
                        raise HTTPException(413, f"upload exceeds {_MAX_JOB_SIZE_BYTES // 1024**3} GB cap")
                    out.write(chunk)
            source_files.append(target)
    except HTTPException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    except Exception as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise HTTPException(500, f"staging write failed: {exc}") from exc

    job = ImportJob(job_id=uuid.uuid4().hex, user_id=user["id"])
    async with _jobs_lock:
        _jobs[job.job_id] = job

    await log_audit(
        "study_import_start", "import", job.job_id,
        user_id=user["id"], ip_address=request.client.host if request.client else None,
    )

    # Fire-and-forget; _run_job owns cleanup.
    asyncio.create_task(_run_job(job, staging, source_files))

    return {"job_id": job.job_id, "files_staged": len(source_files), "bytes_staged": size_total}


@router.get("/{job_id}")
async def get_import_status(
    job_id: str,
    user: dict = Depends(get_current_user),
):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "job not found (may have expired)")
    # Mild authz — a job's status is scoped to its creator. Audit log still
    # covers who did what on the write side.
    if job.user_id != user["id"]:
        raise HTTPException(403, "not your import job")
    return job.to_dict()
