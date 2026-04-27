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


async def create(name: str, size: int, sha256_hex: str, total_chunks: int) -> str:
    upload_id = uuid.uuid4().hex
    d = _safe_dir(upload_id)
    d.mkdir(parents=True, exist_ok=False)
    meta = {
        "name": name,
        "size": size,
        "sha256": sha256_hex.lower(),
        "total_chunks": total_chunks,
        "received_chunks": [],
        "created_at": time.time(),
    }
    (d / "meta.json").write_text(json.dumps(meta))
    return upload_id


async def write_chunk(upload_id: str, idx: int, data: bytes) -> None:
    d = _safe_dir(upload_id)
    if not d.is_dir():
        raise FileNotFoundError(upload_id)
    async with _lock_for(upload_id):
        # Write data first; only update meta after the bytes are durable.
        chunk_path = d / f"chunk-{idx:04d}"
        chunk_path.write_bytes(data)
        meta_path = d / "meta.json"
        meta = json.loads(meta_path.read_text())
        if idx not in meta["received_chunks"]:
            meta["received_chunks"].append(idx)
            meta["received_chunks"].sort()
            meta_path.write_text(json.dumps(meta))


async def received(upload_id: str) -> dict:
    d = _safe_dir(upload_id)
    if not d.is_dir():
        raise FileNotFoundError(upload_id)
    return json.loads((d / "meta.json").read_text())


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


async def cleanup(upload_id: str) -> None:
    d = _safe_dir(upload_id)
    shutil.rmtree(d, ignore_errors=True)
    _locks.pop(upload_id, None)


async def gc_old() -> int:
    """Remove staging dirs whose meta.json mtime is older than _GC_AGE_SECONDS.
    Returns count removed. Safe to call from a background loop."""
    if not STAGING_ROOT.is_dir():
        return 0
    cutoff = time.time() - _GC_AGE_SECONDS
    removed = 0
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
            removed += 1
    if removed:
        log.info("import-staging GC removed %d stale uploads", removed)
    return removed


async def gc_loop() -> None:
    """Run gc_old() every hour. Started from FastAPI lifespan."""
    while True:
        try:
            await gc_old()
        except Exception:
            log.exception("staging GC tick failed")
        await asyncio.sleep(3600)
