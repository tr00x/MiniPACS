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
import time
import uuid
from pathlib import Path
from typing import Iterator

import pydicom


def _now() -> float:
    return time.time()

from fastapi import APIRouter, Depends, HTTPException, Request

from app.db import pool
from app.middleware.audit import log_audit
from app.models.import_api import (
    CreateUploadRequest, CreateUploadResponse,
    FinalizeRequest,
    PrecheckRequest, PrecheckResponse, PrecheckEntry,
    StartJobRequest, StartJobResponse, UploadStatusResponse,
)
from app.routers.auth import get_current_user
from app.services import import_hashes_repo, import_jobs_repo, import_tasks, orthanc, upload_staging

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/studies/import", tags=["import"])

_UPLOAD_CONCURRENCY = 8
_MAX_JOB_SIZE_BYTES = 20 * 1024**3
# Cap concurrent active jobs per user. A misbehaving client (or just a
# very click-happy user) could otherwise fill import_jobs with thousands
# of empty queued rows in seconds — each start-job is one DB write and
# no upload required to register. 10 covers the realistic "drag 10 CDs
# at once" workflow with headroom; anything past it is almost certainly
# unintentional.
_MAX_ACTIVE_JOBS_PER_USER = 10
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
            # DICOMDIR is the DICOM Part 11 filesystem index — has DICM magic
            # at offset 128 (it IS a Part 10 file with SOPClass = Media
            # Storage Directory Storage), but Orthanc /instances rejects it
            # since it's metadata, not an imaging instance. Skip silently.
            if name.upper() == "DICOMDIR":
                continue
            p = Path(dirpath) / name
            if _is_dicom(p):
                yield p


def _walk_pdfs(root: Path) -> Iterator[tuple[Path, Path]]:
    """Yield (pdf_path, ctx_dicom_path) pairs for raw PDF reports inside `root`.

    Pairing rule: for every .pdf file in the tree, find any sibling DICOM
    file in the SAME archive (root subtree) whose StudyInstanceUID matches
    every other DICOM in the tree — i.e. only single-study archives are
    paired. If multiple distinct StudyInstanceUIDs exist in `root`, the PDF
    is ambiguous and skipped (logged at the call-site).

    Why single-study only: clinic CDs in this archive are 1 CD == 1 study.
    Multi-study CDs (e.g. test discs) shouldn't auto-attach reports to an
    arbitrary study without operator review.
    """
    pdfs: list[Path] = []
    dicoms: list[Path] = []
    for dirpath, _dirs, filenames in os.walk(root):
        for name in filenames:
            p = Path(dirpath) / name
            if name.upper() == "DICOMDIR":
                continue
            if name.lower().endswith(".pdf"):
                pdfs.append(p)
                continue
            if _is_dicom(p):
                dicoms.append(p)

    if not pdfs or not dicoms:
        return

    # Determine if all DICOMs in this archive share a single StudyInstanceUID.
    study_uids: set[str] = set()
    for d in dicoms:
        try:
            ds = pydicom.dcmread(d, stop_before_pixels=True, specific_tags=["StudyInstanceUID"])
            uid = getattr(ds, "StudyInstanceUID", None)
            if uid:
                study_uids.add(str(uid))
                if len(study_uids) > 1:
                    return  # multi-study — skip all PDFs in this tree
        except Exception:
            continue

    if len(study_uids) != 1:
        return

    ctx = dicoms[0]
    for pdf in pdfs:
        yield pdf, ctx


# ---- routes ----

@router.post("/start-job", response_model=StartJobResponse)
async def start_job(
    request: Request,
    body: StartJobRequest | None = None,
    user: dict = Depends(get_current_user),
):
    # body is optional so old frontends (no JSON payload) still work.
    source_label = (body.source_label.strip() if body else "")[:512]
    active = await import_jobs_repo.active_for_user(user["id"])
    if len(active) >= _MAX_ACTIVE_JOBS_PER_USER:
        raise HTTPException(
            429,
            f"too many active imports ({len(active)}/{_MAX_ACTIVE_JOBS_PER_USER}); "
            "finish or cancel some before starting more",
        )
    job_id = uuid.uuid4().hex
    await import_jobs_repo.create(job_id, user["id"], source_label=source_label)
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
    # Return 404 (not 403) so we don't leak job existence to other tenants.
    job = await import_jobs_repo.get(req.job_id)
    if not job or job["user_id"] != user["id"]:
        raise HTTPException(404, "job not found")
    # Cancel-race guard: if the job was cancelled (or otherwise finished)
    # between start-job and this attach, refuse with 409. Without this,
    # attach_upload's `finished_at IS NULL` filter silently drops the
    # array_append and the client gets a confusing 404 from /finalize
    # later instead of a clear "job is gone" up front.
    if job["finished_at"] is not None or import_jobs_repo.is_terminal(job["status"]):
        raise HTTPException(409, f"job is {job['status']}, cannot attach new uploads")
    upload_id = await upload_staging.create(
        req.name, req.size, req.sha256, req.total_chunks, user["id"],
    )
    await import_jobs_repo.attach_upload(req.job_id, upload_id)
    return {"upload_id": upload_id}


@router.put("/uploads/{upload_id}/chunks/{idx}")
async def upload_chunk(upload_id: str, idx: int, request: Request,
                        user: dict = Depends(get_current_user)):
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty chunk")
    # Multi-tenant guard: 404 (not 403) so we don't leak whether the
    # upload_id exists for another user.
    try:
        await upload_staging.assert_owner(upload_id, user["id"])
    except FileNotFoundError:
        raise HTTPException(404, "unknown upload_id")
    except PermissionError:
        raise HTTPException(404, "unknown upload_id")
    try:
        await upload_staging.write_chunk(upload_id, idx, body)
    except FileNotFoundError:
        raise HTTPException(404, "unknown upload_id")
    # Heartbeat the parent job so the stale-sweeper doesn't reap a job
    # that's still actively receiving chunks (status stays 'queued'
    # until /finalize fires).
    job_id = await _find_job_for_upload(upload_id, user["id"])
    if job_id:
        await import_jobs_repo.touch(job_id)
    return {"ok": True, "bytes": len(body)}


@router.get("/uploads/{upload_id}", response_model=UploadStatusResponse)
async def upload_status(upload_id: str, user: dict = Depends(get_current_user)):
    try:
        meta = await upload_staging.assert_owner(upload_id, user["id"])
    except FileNotFoundError:
        raise HTTPException(404, "unknown upload_id")
    except PermissionError:
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
        meta = await upload_staging.assert_owner(req.upload_id, user["id"])
    except FileNotFoundError:
        raise HTTPException(404, "unknown upload_id")
    except PermissionError:
        raise HTTPException(404, "unknown upload_id")
    try:
        assembled = await upload_staging.finalize(req.upload_id)
    except FileNotFoundError:
        raise HTTPException(404, "unknown upload_id")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    # Find the job_id this upload was attached to.
    job_id = await _find_job_for_upload(req.upload_id, user["id"])
    if not job_id:
        raise HTTPException(404, "upload not attached to any job for this user")

    # Track the task so lifespan shutdown can drain it instead of GC
    # cancelling mid-Orthanc-POST. add_done_callback in import_tasks
    # auto-removes on completion.
    import_tasks.track(asyncio.create_task(_process_one_file(job_id, req.upload_id, assembled, meta)))
    return {"queued": True}


async def _find_job_for_upload(upload_id: str, user_id: int) -> str | None:
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
                await import_jobs_repo.increment(
                    job_id, failed=1, error=f"{name}: {err}",
                    file_error={"name": name, "reason": err, "kind": "extract", "ts": _now()},
                )
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
            reason = "not a DICOM file or recognized archive"
            await import_jobs_repo.increment(
                job_id, failed=1, error=f"{name}: {reason}",
                file_error={"name": name, "reason": reason, "kind": "format", "ts": _now()},
            )
            return

        if not dicom_files:
            reason = "no DICOM files found inside"
            await import_jobs_repo.increment(
                job_id, failed=1, error=f"{name}: {reason}",
                file_error={"name": name, "reason": reason, "kind": "empty", "ts": _now()},
            )
            return

        # update total_files atomically (additive — multiple files per job).
        # `finished_at IS NULL` guard: if the user cancelled while we were
        # extracting the archive, this fire-and-forget task must not flip
        # the job back to 'uploading' or grow total_files retroactively.
        async with pool().acquire() as con:
            updated = await con.fetchval(
                """UPDATE import_jobs
                      SET total_files = total_files + $2,
                          status = 'uploading',
                          last_progress_at = now()
                    WHERE job_id = $1 AND finished_at IS NULL
                RETURNING 1""",
                job_id, len(dicom_files),
            )
        if not updated:
            log.info("import: job %s already terminal — abandoning %d-file batch",
                     job_id, len(dicom_files))
            return

        sem = asyncio.Semaphore(_UPLOAD_CONCURRENCY)
        instance_study_ids: list[str] = []
        new_count = 0
        dup_count = 0
        # Mutable cell so failure branches inside _one can mutate it under the
        # lock without `nonlocal` gymnastics. Used below to gate the hash
        # record — partial failures must NOT mark the file as cached, or the
        # next precheck will lie about what's in PACS.
        file_failed = [0]
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
                        async with local_lock:
                            file_failed[0] += 1
                        reason = f"PACS rejected (HTTP {resp.status_code})"
                        await import_jobs_repo.increment(
                            job_id, failed=1,
                            error=f"{p.name}: {reason}",
                            current_file=p.name,
                            file_error={"name": p.name, "reason": reason,
                                         "kind": "pacs_reject", "http": resp.status_code,
                                         "ts": _now()},
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
                    async with local_lock:
                        file_failed[0] += 1
                    await import_jobs_repo.increment(
                        job_id, failed=1, error=f"{p.name}: {exc}", current_file=p.name,
                        file_error={"name": p.name, "reason": str(exc),
                                     "kind": "internal", "ts": _now()},
                    )

        await asyncio.gather(*(_one(p) for p in dicom_files))

        # PDF reports — encapsulate as SOP 1.2.840.10008.5.1.4.1.1.104.1
        # ("Encapsulated PDF Storage") and post to Orthanc through the same
        # shared httpx client used for DICOM. Anchored to the study via
        # Patient/Study tags from a sibling DICOM. Multi-study or no-DICOM
        # archives are silently skipped by _walk_pdfs.
        from app.services.pdf_encapsulator import encapsulate_pdf  # local — keep top imports lean

        # 50 MB cap on a single PDF — clinical reports are typically under
        # 1 MB. Anything bigger is almost certainly a misplaced imaging file
        # (or worst case, a malformed CD trying to OOM the backend via
        # read_bytes). Skipped with a warning, not a failure.
        _MAX_PDF_BYTES = 50 * 1024 * 1024
        pdf_pairs = list(_walk_pdfs(work))
        for pdf_path, ctx_path in pdf_pairs:
            try:
                size = pdf_path.stat().st_size
                if size > _MAX_PDF_BYTES:
                    log.warning(
                        "pdf too large — skipped",
                        extra={"job_id": job_id, "pdf": str(pdf_path), "size": size},
                    )
                    continue
                pdf_bytes = pdf_path.read_bytes()
                dicom_bytes = encapsulate_pdf(pdf_bytes, ctx_path)
                resp = await orthanc._http().post(
                    "/instances",
                    content=dicom_bytes,
                    headers={"Content-Type": "application/dicom"},
                )
                if resp.status_code >= 300:
                    log.warning(
                        "pdf encapsulation rejected by orthanc",
                        extra={"job_id": job_id, "pdf": str(pdf_path),
                               "status": resp.status_code},
                    )
                    continue
                payload = resp.json()
                items = payload if isinstance(payload, list) else [payload]
                pdf_sid = None
                pdf_new = 0
                pdf_dup = 0
                for item in items:
                    pdf_sid = item.get("ParentStudy")
                    if item.get("Status") == "AlreadyStored":
                        pdf_dup += 1
                    else:
                        pdf_new += 1
                # Bump the same counters as DICOM uploads — UI shows total
                # instances regardless of source. PDFs land as DOC series
                # in the existing study; user sees one extra "instance" and
                # a Radiology Report series in the viewer.
                await import_jobs_repo.increment(
                    job_id, processed=1,
                    new_instances=pdf_new,
                    duplicate_instances=pdf_dup,
                    study_id=pdf_sid if pdf_sid else None,
                    current_file=pdf_path.name,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "pdf encapsulation failed",
                    extra={"job_id": job_id, "pdf": str(pdf_path), "error": repr(exc)},
                )

        # Record file hash (idempotent) for future precheck — but only if
        # every DICOM in this file landed cleanly. A partial Orthanc 5xx
        # would otherwise teach the dedup table that the file is fully
        # stored, and the next /precheck would skip the re-upload and
        # silently lose data.
        if file_failed[0] == 0:
            await import_hashes_repo.record(sha, len(dicom_files), list(set(instance_study_ids)))
        else:
            log.warning(
                "import: skipping hash record for %s — %d/%d files failed",
                name, file_failed[0], len(dicom_files),
            )

        # Bust QIDO cache.
        try:
            await orthanc.invalidate_study_caches()
        except Exception:
            pass

    except Exception as exc:  # noqa: BLE001
        log.exception("file processing failed")
        await import_jobs_repo.increment(
            job_id, failed=1, error=f"internal: {exc}",
            file_error={"name": name, "reason": str(exc),
                         "kind": "internal", "ts": _now()},
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
        await upload_staging.cleanup(upload_id)
        # Promote job to terminal if no more active uploads attached.
        await _maybe_finish_job(job_id)


async def _maybe_finish_job(job_id: str) -> None:
    """If every upload_id attached to the job is gone from staging,
    flip status to 'done' (or 'error' if anything failed). Skips
    terminal jobs — important for the cancel path, where a concurrent
    _process_one_file task hits this finally-block after the user has
    already flipped the job to 'cancelled'."""
    job = await import_jobs_repo.get(job_id)
    if not job or import_jobs_repo.is_terminal(job["status"]):
        return
    # Any upload_id still on disk → not done yet.
    for uid in job["upload_ids"]:
        try:
            await upload_staging.received(uid)
            return  # still active
        except FileNotFoundError:
            continue
    if job["failed"] > 0 and job["processed"] == 0:
        final = "error"
    else:
        # All-success or partial-success both flip to done; UI distinguishes via failed > 0.
        final = "done"
    await import_jobs_repo.finish(job_id, final)


@router.get("/active")
async def active(user: dict = Depends(get_current_user)):
    rows = await import_jobs_repo.active_for_user(user["id"])
    return {"jobs": rows}


@router.get("/jobs")
async def list_jobs(
    user: dict = Depends(get_current_user),
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
):
    """History endpoint — every job for the user, newest first.

    `status` filter: a literal status string (queued/uploading/done/error/cancelled),
    or one of the buckets "active" / "terminal". Pagination via limit+offset;
    UI keeps a header total to render a page count."""
    limit = max(1, min(200, limit))
    offset = max(0, offset)
    rows, total = await import_jobs_repo.history_for_user(
        user["id"], status=status, limit=limit, offset=offset,
    )
    return {"jobs": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/{job_id}")
async def get_status(job_id: str, user: dict = Depends(get_current_user)):
    job = await import_jobs_repo.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if (await _job_owner(job_id)) != user["id"]:
        raise HTTPException(403, "not your import job")
    return job


@router.get("/{job_id}/uploads-progress")
async def uploads_progress(job_id: str, user: dict = Depends(get_current_user)):
    """Aggregate chunk-receipt totals across every upload_id attached
    to the job. Lets the pill render a real upload-phase % even before
    the server has started processing files (status='queued')."""
    if (await _job_owner(job_id)) != user["id"]:
        raise HTTPException(403, "not your import job")
    job = await import_jobs_repo.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")

    chunks_total = 0
    chunks_received = 0
    bytes_total = 0
    bytes_received_est = 0
    files: list[dict] = []
    for uid in job["upload_ids"]:
        try:
            meta = await upload_staging.received(uid)
        except FileNotFoundError:
            # Already finalized & cleaned up. Treat as fully done so the
            # %-bar reaches 100 even after staging cleanup.
            continue
        tc = int(meta.get("total_chunks") or 0)
        rc = len(meta.get("received_chunks") or [])
        size = int(meta.get("size") or 0)
        chunks_total += tc
        chunks_received += rc
        bytes_total += size
        # Approximate bytes-received: rc/tc * size — avoids stat()ing every
        # chunk file on disk. Off by at most one chunk-size at the tail.
        if tc > 0:
            bytes_received_est += int(size * rc / tc)
        files.append({
            "upload_id": uid,
            "name": meta.get("name") or "",
            "size": size,
            "total_chunks": tc,
            "received_chunks": rc,
        })
    return {
        "chunks_total": chunks_total,
        "chunks_received": chunks_received,
        "bytes_total": bytes_total,
        "bytes_received_est": bytes_received_est,
        "files": files,
    }


@router.delete("/{job_id}")
async def cancel_job(
    job_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    """User-issued cancel. Flips job → 'cancelled' (terminal) and
    schedules cleanup of every staging dir attached to the job. Returns
    409 if the job is already terminal so the UI can refresh and stop
    showing the dialog instead of looping the cancel."""
    if (await _job_owner(job_id)) != user["id"]:
        raise HTTPException(403, "not your import job")
    job = await import_jobs_repo.get(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if import_jobs_repo.is_terminal(job["status"]) or job["finished_at"] is not None:
        raise HTTPException(409, f"job is already {job['status']}, cannot cancel")

    flipped = await import_jobs_repo.cancel(job_id, reason="cancelled by user")
    if not flipped:
        # Lost the race to another tab — surface as 409 so UI re-polls.
        raise HTTPException(409, "job already terminal")

    # Best-effort chunk cleanup. Errors are logged but don't fail the
    # response — the staging GC will sweep any leftovers within 24 h.
    for uid in job["upload_ids"]:
        try:
            await upload_staging.cleanup(uid)
        except Exception:  # noqa: BLE001
            log.exception("cancel: failed to clean upload %s for job %s", uid, job_id)

    await log_audit(
        "study_import_cancel", "import", job_id,
        user_id=user["id"],
        ip_address=request.client.host if request.client else None,
    )
    return {"cancelled": True}


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
    async with pool().acquire() as con:
        updated = await con.fetchval(
            """UPDATE import_jobs
                  SET status = 'uploading', finished_at = NULL,
                      errors = array_append(errors, '--- retry ---')
                WHERE job_id = $1 AND status = 'error'
            RETURNING 1""",
            job_id,
        )
    if not updated:
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
        import_tasks.track(asyncio.create_task(_process_one_file(job_id, uid, assembled, meta)))
    return {"retried": True}


async def _job_owner(job_id: str) -> int | None:
    async with pool().acquire() as con:
        row = await con.fetchrow("SELECT user_id FROM import_jobs WHERE job_id = $1", job_id)
    return row["user_id"] if row else None
