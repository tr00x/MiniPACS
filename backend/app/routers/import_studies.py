"""Resumable, dedup-aware study import.

Frontend slices the file into 5 MB chunks, computes a streaming
SHA-256, and asks /precheck whether we already have the bytes. For
every "upload"-bound file it POSTs /uploads to get an upload_id, PUTs
each chunk to /uploads/{id}/chunks/{idx}, then POSTs /finalize. Each
finalize attaches the assembled file to a job_id; multiple files can
share one job.

A separate /start-job POST creates the job_id up front so the upload
endpoints have something to attach to. This keeps the protocol
stateless from the chunk endpoints' perspective.

Server-side per-instance dedup uses the Status field Orthanc returns
in the /instances response ("Success" vs "AlreadyStored"). File-hash
dedup uses import_file_hashes; we record the hash after a successful
upload so the next attempt with the same bytes can short-circuit.

Job state lives in import_jobs (Postgres), survives backend restarts.
The lifespan startup hook flips any non-terminal job to "error" with
the reason "interrupted by backend restart" — the operator clicks
Retry to redo from chunks (which are still on disk under the
upload_ids attached to the job).
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

from app.middleware.audit import log_audit
from app.models.import_api import (
    CreateUploadRequest, CreateUploadResponse,
    FinalizeRequest,
    PrecheckRequest, PrecheckResponse, PrecheckEntry,
    StartJobResponse, UploadStatusResponse,
)
from app.routers.auth import get_current_user
from app.services import import_hashes_repo, import_jobs_repo, orthanc, upload_staging

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/studies/import", tags=["import"])

_UPLOAD_CONCURRENCY = 8
_MAX_JOB_SIZE_BYTES = 20 * 1024**3
_ARCHIVE_SUFFIXES = {
    ".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2",
    ".tar.xz", ".txz", ".7z", ".iso", ".img",
}


def _is_dicom(path: Path) -> bool:
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
    for dirpath, _dirs, filenames in os.walk(root):
        for name in filenames:
            p = Path(dirpath) / name
            if _is_dicom(p):
                yield p


# ---- routes ----

@router.post("/start-job", response_model=StartJobResponse)
async def start_job(request: Request, user: dict = Depends(get_current_user)):
    job_id = uuid.uuid4().hex
    await import_jobs_repo.create(job_id, user["id"])
    await log_audit(
        "study_import_start", "import", job_id,
        user_id=user["id"],
        ip_address=request.client.host if request.client else None,
    )
    return {"job_id": job_id}


@router.post("/precheck", response_model=PrecheckResponse)
async def precheck(req: PrecheckRequest, user: dict = Depends(get_current_user)):
    hashes = [f.sha256.lower() for f in req.files]
    known = await import_hashes_repo.lookup_many(hashes)
    results: dict[str, PrecheckEntry] = {}
    for f in req.files:
        h = f.sha256.lower()
        if h in known:
            results[h] = PrecheckEntry(
                action="skip",
                instance_count=known[h]["instance_count"],
                study_ids=known[h]["study_ids"],
            )
        else:
            results[h] = PrecheckEntry(action="upload")
    return {"results": results}


@router.post("/uploads", response_model=CreateUploadResponse)
async def create_upload(req: CreateUploadRequest, user: dict = Depends(get_current_user)):
    if req.size > _MAX_JOB_SIZE_BYTES:
        raise HTTPException(413, f"file exceeds {_MAX_JOB_SIZE_BYTES // 1024**3} GB cap")
    # Owner check on job_id — only the creator may attach uploads.
    job = await import_jobs_repo.get(req.job_id)
    if not job:
        raise HTTPException(404, "job not found")
    upload_id = await upload_staging.create(req.name, req.size, req.sha256, req.total_chunks)
    await import_jobs_repo.attach_upload(req.job_id, upload_id)
    return {"upload_id": upload_id}


@router.put("/uploads/{upload_id}/chunks/{idx}")
async def upload_chunk(upload_id: str, idx: int, request: Request,
                        user: dict = Depends(get_current_user)):
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty chunk")
    try:
        await upload_staging.write_chunk(upload_id, idx, body)
    except FileNotFoundError:
        raise HTTPException(404, "unknown upload_id")
    return {"ok": True, "bytes": len(body)}


@router.get("/uploads/{upload_id}", response_model=UploadStatusResponse)
async def upload_status(upload_id: str, user: dict = Depends(get_current_user)):
    try:
        meta = await upload_staging.received(upload_id)
    except FileNotFoundError:
        raise HTTPException(404, "unknown upload_id")
    return {
        "upload_id": upload_id,
        "name": meta["name"],
        "size": meta["size"],
        "total_chunks": meta["total_chunks"],
        "received_chunks": meta["received_chunks"],
    }


@router.post("/finalize")
async def finalize(req: FinalizeRequest, user: dict = Depends(get_current_user)):
    """Triggers extract+upload-to-Orthanc for one assembled file. Returns
    immediately; progress is polled via GET /api/studies/import/{job_id}."""
    try:
        meta = await upload_staging.received(req.upload_id)
        assembled = await upload_staging.finalize(req.upload_id)
    except FileNotFoundError:
        raise HTTPException(404, "unknown upload_id")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    # Find the job_id this upload was attached to.
    job_id = await _find_job_for_upload(req.upload_id, user["id"])
    if not job_id:
        raise HTTPException(404, "upload not attached to any job for this user")

    asyncio.create_task(_process_one_file(job_id, req.upload_id, assembled, meta))
    return {"queued": True}


async def _find_job_for_upload(upload_id: str, user_id: int) -> str | None:
    from app.db import pool
    async with pool().acquire() as con:
        row = await con.fetchrow(
            """SELECT job_id FROM import_jobs
                WHERE user_id = $1 AND $2 = ANY(upload_ids)
                ORDER BY started_at DESC LIMIT 1""",
            user_id, upload_id,
        )
    return row["job_id"] if row else None


async def _process_one_file(job_id: str, upload_id: str, assembled: Path, meta: dict) -> None:
    """Extract (if archive) → upload each DICOM to Orthanc → record file hash."""
    sha = meta["sha256"]
    name = meta["name"]
    work = Path(tempfile.mkdtemp(prefix="minipacs-import-work-"))
    try:
        await import_jobs_repo.set_status(job_id, "extracting", current_file=name)

        dicom_files: list[Path] = []
        if _has_archive_suffix(name):
            ok, err = _extract_archive(assembled, work)
            if not ok:
                await import_jobs_repo.increment(job_id, failed=1, error=f"{name}: {err}")
                return
            seen: set[Path] = set()
            for p in _walk_dicom(work):
                rp = p.resolve()
                if rp not in seen:
                    seen.add(rp)
                    dicom_files.append(p)
        elif _is_dicom(assembled):
            # Bare DICOM upload — assembled.bin IS the file. Do NOT walk its
            # parent: the staging dir still holds chunk-NNNN files at this
            # point, and chunk-0000 of a bare DICOM has the same DICM magic
            # so a naive walk would double-count. Cleanup happens in the
            # outer `finally`, but walk runs first.
            dicom_files = [assembled]
        else:
            await import_jobs_repo.increment(
                job_id, failed=1, error=f"{name}: not a DICOM file or recognized archive",
            )
            return

        if not dicom_files:
            await import_jobs_repo.increment(
                job_id, failed=1, error=f"{name}: no DICOM files found inside",
            )
            return

        # update total_files atomically (additive — multiple files per job)
        from app.db import pool
        async with pool().acquire() as con:
            await con.execute(
                "UPDATE import_jobs SET total_files = total_files + $2, status = 'uploading' WHERE job_id = $1",
                job_id, len(dicom_files),
            )

        sem = asyncio.Semaphore(_UPLOAD_CONCURRENCY)
        instance_study_ids: list[str] = []
        new_count = 0
        dup_count = 0
        local_lock = asyncio.Lock()

        async def _one(p: Path):
            nonlocal new_count, dup_count
            async with sem:
                try:
                    data = p.read_bytes()
                    resp = await orthanc._http().post(
                        "/instances", content=data,
                        headers={"Content-Type": "application/dicom"},
                    )
                    if resp.status_code >= 300:
                        await import_jobs_repo.increment(
                            job_id, failed=1,
                            error=f"{p.name}: orthanc {resp.status_code}",
                            current_file=p.name,
                        )
                        return
                    payload = resp.json()
                    items = payload if isinstance(payload, list) else [payload]
                    item_new = 0
                    item_dup = 0
                    sid = None
                    for item in items:
                        sid = item.get("ParentStudy")
                        if sid:
                            instance_study_ids.append(sid)
                        if item.get("Status") == "AlreadyStored":
                            item_dup += 1
                        else:
                            item_new += 1
                    async with local_lock:
                        new_count += item_new
                        dup_count += item_dup
                    await import_jobs_repo.increment(
                        job_id, processed=1,
                        new_instances=item_new,
                        duplicate_instances=item_dup,
                        study_id=sid if sid else None,
                        current_file=p.name,
                    )
                except Exception as exc:  # noqa: BLE001
                    await import_jobs_repo.increment(
                        job_id, failed=1, error=f"{p.name}: {exc}", current_file=p.name,
                    )

        await asyncio.gather(*(_one(p) for p in dicom_files))

        # Record file hash (idempotent) for future precheck.
        await import_hashes_repo.record(sha, len(dicom_files), list(set(instance_study_ids)))

        # Bust QIDO cache.
        try:
            await orthanc.invalidate_study_caches()
        except Exception:
            pass

    except Exception as exc:  # noqa: BLE001
        log.exception("file processing failed")
        await import_jobs_repo.increment(job_id, failed=1, error=f"internal: {exc}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
        await upload_staging.cleanup(upload_id)
        # Promote job to terminal if no more active uploads attached.
        await _maybe_finish_job(job_id)


async def _maybe_finish_job(job_id: str) -> None:
    """If every upload_id attached to the job is gone from staging,
    flip status to 'done' (or 'error' if anything failed)."""
    job = await import_jobs_repo.get(job_id)
    if not job or job["status"] in ("done", "error"):
        return
    # Any upload_id still on disk → not done yet.
    for uid in job["upload_ids"]:
        try:
            await upload_staging.received(uid)
            return  # still active
        except FileNotFoundError:
            continue
    final = "done" if job["failed"] == 0 or job["processed"] > 0 else "error"
    await import_jobs_repo.finish(job_id, final)


@router.get("/active")
async def active(user: dict = Depends(get_current_user)):
    rows = await import_jobs_repo.active_for_user(user["id"])
    return {"jobs": rows}


@router.get("/{job_id}")
async def get_status(job_id: str, user: dict = Depends(get_current_user)):
    job = await import_jobs_repo.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if (await _job_owner(job_id)) != user["id"]:
        raise HTTPException(403, "not your import job")
    return job


@router.post("/{job_id}/retry")
async def retry(job_id: str, user: dict = Depends(get_current_user)):
    if (await _job_owner(job_id)) != user["id"]:
        raise HTTPException(403, "not your import job")
    job = await import_jobs_repo.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["status"] != "error":
        raise HTTPException(409, f"can only retry jobs in error state, got {job['status']}")
    # Atomic flip → uploading; if another tab beat us, 409.
    from app.db import pool
    async with pool().acquire() as con:
        result = await con.execute(
            """UPDATE import_jobs
                  SET status = 'uploading', finished_at = NULL,
                      errors = array_append(errors, '--- retry ---')
                WHERE job_id = $1 AND status = 'error'""",
            job_id,
        )
    if result == "UPDATE 0":
        raise HTTPException(409, "job already running in another tab")

    # Re-process every upload_id that still has chunks on disk.
    for uid in job["upload_ids"]:
        try:
            meta = await upload_staging.received(uid)
        except FileNotFoundError:
            continue
        try:
            assembled = await upload_staging.finalize(uid)
        except ValueError:
            await import_jobs_repo.increment(
                job_id, failed=1,
                error=f"retry: upload {uid} has missing chunks, please re-upload",
            )
            continue
        asyncio.create_task(_process_one_file(job_id, uid, assembled, meta))
    return {"retried": True}


async def _job_owner(job_id: str) -> int | None:
    from app.db import pool
    async with pool().acquire() as con:
        row = await con.fetchrow("SELECT user_id FROM import_jobs WHERE job_id = $1", job_id)
    return row["user_id"] if row else None
