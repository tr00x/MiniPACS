"""Filesystem-backed chunk staging for resumable uploads.

Each upload gets its own dir under STAGING_ROOT/{upload_id}/:
    chunk-0000  chunk-0001  ...  meta.json

meta.json:
    {"name": "...", "size": int, "sha256": "...",
     "total_chunks": int, "received_chunks": [0, 1, 2]}

Lifecycle:
    create()        -> mkdir + meta.json with received_chunks=[]
    write_chunk()   -> append idx to received_chunks (idempotent — same idx OK)
    received()      -> read meta.json, return list (resume support)
    finalize()      -> concat chunks → assembled.bin, verify sha256
    cleanup()       -> rm -rf {upload_id}
    gc_old()        -> sweep dirs whose mtime is older than 24 h

Concurrency: per-upload meta.json read-modify-write is protected by an
asyncio.Lock keyed on upload_id. Two browser tabs hitting the same
upload_id is unusual but possible (refresh during retry); the lock
prevents lost writes.

Disk safety: every path is constructed from STAGING_ROOT joined with
the upload_id, then resolve()'d and verified to be inside STAGING_ROOT
before any file op (defense against ../ in upload_id even though we
only ever pass uuid4().hex).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
import uuid
from hashlib import sha256 as _sha256
from pathlib import Path

log = logging.getLogger(__name__)

STAGING_ROOT = Path(os.environ.get("MINIPACS_STAGING_DIR", "/app/data/import-staging"))


def init() -> None:
    """Idempotent: ensure STAGING_ROOT exists. Called from FastAPI lifespan."""
    STAGING_ROOT.mkdir(parents=True, exist_ok=True)


# 24 h is enough for a user to walk away at lunch and come back; longer
# than that and the chunks are almost certainly orphaned.
_GC_AGE_SECONDS = 24 * 3600

_locks: dict[str, asyncio.Lock] = {}


def _lock_for(upload_id: str) -> asyncio.Lock:
    lk = _locks.get(upload_id)
    if lk is None:
        lk = asyncio.Lock()
        _locks[upload_id] = lk
    return lk


def _safe_dir(upload_id: str) -> Path:
    """Resolve and assert the dir is under STAGING_ROOT."""
    d = (STAGING_ROOT / upload_id).resolve()
    if STAGING_ROOT.resolve() not in d.parents and d != STAGING_ROOT.resolve():
        raise ValueError(f"upload_id {upload_id!r} escapes staging root")
    return d


async def create(name: str, size: int, sha256_hex: str, total_chunks: int, user_id: int) -> str:
    upload_id = uuid.uuid4().hex
    d = _safe_dir(upload_id)
    d.mkdir(parents=True, exist_ok=False)
    meta = {
        "name": name,
        "size": size,
        "sha256": sha256_hex.lower(),
        "total_chunks": total_chunks,
        "received_chunks": [],
        "user_id": user_id,
        "created_at": time.time(),
    }
    (d / "meta.json").write_text(json.dumps(meta))
    return upload_id


async def assert_owner(upload_id: str, user_id: int) -> dict:
    """Return meta dict if owner matches, raise PermissionError otherwise.
    Raises FileNotFoundError if upload doesn't exist.

    Multi-tenant guard: every per-upload endpoint (PUT chunk, GET status,
    POST finalize) must call this before touching the staging dir, so a
    user who guesses another tenant's uuid4 still gets 404."""
    meta = await received(upload_id)
    if meta.get("user_id") != user_id:
        raise PermissionError(f"upload {upload_id} not owned by user {user_id}")
    return meta


def _write_chunk_sync(d: Path, idx: int, data: bytes) -> None:
    chunk_path = d / f"chunk-{idx:04d}"
    chunk_path.write_bytes(data)
    meta_path = d / "meta.json"
    meta = json.loads(meta_path.read_text())
    if idx not in meta["received_chunks"]:
        meta["received_chunks"].append(idx)
        meta["received_chunks"].sort()
        # Atomic meta write — prevents truncated meta.json on crash mid-write.
        tmp = meta_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(meta))
        os.replace(tmp, meta_path)


async def write_chunk(upload_id: str, idx: int, data: bytes) -> None:
    d = _safe_dir(upload_id)
    if not d.is_dir():
        raise FileNotFoundError(upload_id)
    async with _lock_for(upload_id):
        await asyncio.to_thread(_write_chunk_sync, d, idx, data)


def _read_meta_sync(d: Path) -> dict:
    return json.loads((d / "meta.json").read_text())


async def received(upload_id: str) -> dict:
    d = _safe_dir(upload_id)
    if not d.is_dir():
        # Drop any lingering lock so the dict can't grow unboundedly
        # across upload-id rotation. The 24h GC also cleans up but
        # that leaves up to a day of dead Lock objects in memory per
        # cancelled / finalized upload.
        _locks.pop(upload_id, None)
        raise FileNotFoundError(upload_id)
    # Off-load the read so /uploads-progress on a job with many staged
    # files doesn't block the event loop on disk I/O.
    return await asyncio.to_thread(_read_meta_sync, d)


def _finalize_sync(d: Path, expected: str, total: int) -> Path:
    out = d / "assembled.bin"
    h = _sha256()
    with out.open("wb") as fout:
        for i in range(total):
            with (d / f"chunk-{i:04d}").open("rb") as fin:
                while True:
                    buf = fin.read(1024 * 1024)
                    if not buf:
                        break
                    h.update(buf)
                    fout.write(buf)
    actual = h.hexdigest()
    if actual != expected:
        out.unlink(missing_ok=True)
        raise ValueError(f"finalize: sha256 mismatch (expected {expected}, got {actual})")
    return out


async def finalize(upload_id: str) -> Path:
    """Concat chunk-NNNN in order → assembled.bin, verify sha256.
    Returns path to assembled file. Caller is responsible for moving
    it out of the staging dir before calling cleanup()."""
    d = _safe_dir(upload_id)
    if not d.is_dir():
        raise FileNotFoundError(upload_id)
    async with _lock_for(upload_id):
        meta = json.loads((d / "meta.json").read_text())
        expected = meta["sha256"]
        total = meta["total_chunks"]
        received_set = set(meta["received_chunks"])
        missing = [i for i in range(total) if i not in received_set]
        if missing:
            raise ValueError(f"finalize: missing chunks {missing[:10]} (of {total})")
        return await asyncio.to_thread(_finalize_sync, d, expected, total)


async def cleanup(upload_id: str) -> None:
    d = _safe_dir(upload_id)
    await asyncio.to_thread(shutil.rmtree, d, ignore_errors=True)
    _locks.pop(upload_id, None)


def _gc_old_sync() -> list[str]:
    if not STAGING_ROOT.is_dir():
        return []
    cutoff = time.time() - _GC_AGE_SECONDS
    removed_ids: list[str] = []
    for child in STAGING_ROOT.iterdir():
        if not child.is_dir():
            continue
        meta = child / "meta.json"
        try:
            mtime = meta.stat().st_mtime if meta.is_file() else child.stat().st_mtime
        except OSError:
            continue
        if mtime < cutoff:
            shutil.rmtree(child, ignore_errors=True)
            removed_ids.append(child.name)
    return removed_ids


async def gc_old() -> int:
    """Remove staging dirs whose meta.json mtime is older than _GC_AGE_SECONDS.
    Returns count removed. Safe to call from a background loop."""
    removed_ids = await asyncio.to_thread(_gc_old_sync)
    # Fix I2: drop locks for any upload_id whose dir is gone.
    for uid in removed_ids:
        _locks.pop(uid, None)
    if removed_ids:
        log.info("import-staging GC removed %d stale uploads", len(removed_ids))
    return len(removed_ids)


async def gc_loop() -> None:
    """Run gc_old() every hour. Started from FastAPI lifespan."""
    while True:
        try:
            await gc_old()
        except Exception:
            log.exception("staging GC tick failed")
        await asyncio.sleep(3600)
