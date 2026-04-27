"""SHA-256 → known-import lookup for the precheck endpoint.

The hash is over the raw bytes the user dropped (a .dcm, a .zip, an
.iso). It is NOT a DICOM SOPInstanceUID — those are dedupped at the
Orthanc layer. Two layers because the same study can arrive in
different file packagings (loose .dcm vs ZIP vs ISO) and we want to
catch both: file-hash skips redundant transfers, UID skips redundant
Orthanc inserts when packagings differ.
"""
from __future__ import annotations

from typing import Any

from app.db import pool


async def lookup_many(hashes: list[str]) -> dict[str, dict[str, Any]]:
    """Return {sha256: {instance_count, study_ids}} for hashes we know."""
    if not hashes:
        return {}
    async with pool().acquire() as con:
        rows = await con.fetch(
            "SELECT sha256, instance_count, study_ids FROM import_file_hashes WHERE sha256 = ANY($1::char(64)[])",
            hashes,
        )
    return {
        r["sha256"]: {"instance_count": r["instance_count"], "study_ids": list(r["study_ids"])}
        for r in rows
    }


async def record(sha256: str, instance_count: int, study_ids: list[str]) -> None:
    """Idempotent insert. If the hash exists we trust the older row —
    counts can drift if Orthanc is wiped, but precheck-skip is
    advisory: the operator has Force re-upload to bypass."""
    async with pool().acquire() as con:
        await con.execute(
            """INSERT INTO import_file_hashes (sha256, instance_count, study_ids)
               VALUES ($1, $2, $3)
               ON CONFLICT (sha256) DO NOTHING""",
            sha256, instance_count, study_ids,
        )
