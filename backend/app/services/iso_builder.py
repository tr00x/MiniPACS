"""Lazy on-demand ISO builder for the burn-to-disc / USB export feature.

Pipeline per request:

    Orthanc /studies/{id}/media (ZIP with DICOMDIR)
        -> tempdir/staging/DICOM/                  (extracted)
        -> tempdir/staging/VIEWER/                 (DWV bundle copy)
        -> tempdir/staging/index.html              (auto-redirect to VIEWER)
        -> tempdir/staging/autorun.inf             (Win autoplay)
        -> tempdir/staging/README.txt              (cross-platform instructions)
        -> xorriso -as mkisofs ...                 (mints tempdir/study.iso)
    StreamingResponse(study.iso) -> client
    BackgroundTask: rm -rf tempdir

Concurrency capped at 2 — a single 2 GB study peaks ~6 GB intermediate disk.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

from app.services import orthanc

DWV_PATH = Path(os.environ.get("DWV_PATH", "/opt/dwv"))
_BUILD_SEM = asyncio.Semaphore(2)

_AUTORUN_INF = b"""[autorun]
shellexecute=index.html
icon=VIEWER\\favicon.ico
label=Patient DICOM Study
"""

_INDEX_HTML = b"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Patient DICOM Study</title>
  <meta http-equiv="refresh" content="0; url=VIEWER/index.html">
  <style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3em auto;padding:0 1em;color:#222;}</style>
</head>
<body>
  <h1>Patient DICOM Study</h1>
  <p>Loading viewer&hellip; If nothing happens, <a href="VIEWER/index.html">click here</a>.</p>
  <p>After the viewer opens, drag the <code>DICOM</code> folder onto it (or use the viewer's <em>Open files</em> control to select all files inside <code>DICOM/</code>).</p>
</body>
</html>
"""

_README_TXT = b"""Patient DICOM Study
====================

Contents of this disc / USB drive:

  DICOM/      DICOM image files (with DICOMDIR index, IHE PDI compliant)
  VIEWER/     DWV (DICOM Web Viewer) - HTML5/JS, MIT license
  index.html  Click this to launch the viewer in your default browser

How to view the images
----------------------

WINDOWS:    Double-click index.html. (Most discs auto-launch on insert.)
MAC/LINUX:  Open index.html in any modern browser (Safari, Chrome, Firefox).
TABLET:     Copy the contents to a USB-C drive, then open index.html
            via your tablet's Files app.

After the viewer loads, drag the DICOM folder onto the viewer area,
or click "Open files" and select every file inside the DICOM folder.
(Browser security prevents the viewer from auto-loading files off disc.)

Alternative viewers (read the DICOMDIR file directly):
  - Weasis        https://weasis.org
  - MicroDicom    https://microdicom.com
  - Horos (Mac)   https://horosproject.org
  - RadiAnt (Win) https://www.radiantviewer.com
"""

_SAFE_LABEL = re.compile(r"[^A-Za-z0-9_-]")


def _volume_label(accession: str | None, fallback: str) -> str:
    base = (accession or fallback)[:24]
    return _SAFE_LABEL.sub("_", base) or "PACS_STUDY"


async def _stream_to_file(study_id: str, dest: Path) -> None:
    with dest.open("wb") as fh:
        async for chunk in orthanc.download_study_media_stream(study_id):
            fh.write(chunk)


def _extract_zip(zip_path: Path, dest: Path) -> None:
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest)


def _stage_viewer(dest: Path) -> None:
    if not DWV_PATH.exists():
        raise RuntimeError(f"DWV bundle missing at {DWV_PATH} — image not built correctly")
    shutil.copytree(DWV_PATH, dest, symlinks=False)


def _write_top_level(root: Path) -> None:
    (root / "autorun.inf").write_bytes(_AUTORUN_INF)
    (root / "index.html").write_bytes(_INDEX_HTML)
    (root / "README.txt").write_bytes(_README_TXT)


async def _run_xorriso(staging: Path, iso_path: Path, label: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "xorriso",
        "-as", "mkisofs",
        "-V", label,
        "-J", "-r",
        "-o", str(iso_path),
        str(staging),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"xorriso failed (rc={proc.returncode}): {stderr.decode(errors='replace')[:500]}")


async def build_study_iso(study_id: str, accession: str | None = None) -> tuple[Path, Path]:
    """Build an ISO for the given study. Returns (iso_path, tempdir).

    Caller MUST schedule cleanup of tempdir (which contains iso_path) — typically
    via FastAPI BackgroundTask after the StreamingResponse finishes.
    """
    async with _BUILD_SEM:
        tempdir = Path(tempfile.mkdtemp(prefix=f"burn-{study_id[:8]}-"))
        try:
            zip_path = tempdir / "media.zip"
            staging = tempdir / "staging"
            staging.mkdir()
            iso_path = tempdir / f"study-{study_id[:8]}.iso"

            await _stream_to_file(study_id, zip_path)
            await asyncio.to_thread(_extract_zip, zip_path, staging / "DICOM")
            zip_path.unlink()  # reclaim space before xorriso

            await asyncio.to_thread(_stage_viewer, staging / "VIEWER")
            _write_top_level(staging)

            await _run_xorriso(staging, iso_path, _volume_label(accession, study_id))

            await asyncio.to_thread(shutil.rmtree, staging)  # only the ISO needs to survive past return
            return iso_path, tempdir
        except Exception:
            shutil.rmtree(tempdir, ignore_errors=True)
            raise
