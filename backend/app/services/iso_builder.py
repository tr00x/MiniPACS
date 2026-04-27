"""Lazy on-demand ISO builder for the burn-to-disc / USB export feature.

Pipeline per request:

    Orthanc /studies/{id}/media (ZIP with DICOMDIR)
        -> tempdir/staging/DICOM/                  (extracted)
        -> tempdir/staging/index.html              (instructions + viewer links)
        -> tempdir/staging/autorun.inf             (Win autoplay -> index.html)
        -> tempdir/staging/README.txt              (cross-platform instructions)
        -> xorriso -as mkisofs ...                 (mints tempdir/study.iso)
    StreamingResponse(study.iso) -> client
    BackgroundTask: rm -rf tempdir

No embedded HTML viewer: modern browsers fence off file:// origins —
they block ES module imports, Worker construction, fetch(), service
worker registration. dwv-simplistic (PWA) and stock dwv UMD (needs
Workers for J2K / JPEG-Lossless / RLE) both fail on real-world
compressed studies. ISO is IHE PDI compliant (DICOM/DICOMDIR);
README.txt directs patients to free desktop viewers that read it
natively.

Concurrency capped at 2 — a single 2 GB study peaks ~6 GB intermediate disk.
"""

from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

from app.services import orthanc

_BUILD_SEM = asyncio.Semaphore(2)

_AUTORUN_INF = b"""[autorun]
shellexecute=index.html
label=Patient DICOM Study
"""

_INDEX_HTML = b"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Patient DICOM Study</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:720px;margin:3em auto;padding:0 1.5em;color:#222;line-height:1.55;}
    h1{margin-bottom:.2em;}
    h2{margin-top:1.6em;border-bottom:1px solid #ddd;padding-bottom:.2em;}
    code{background:#f4f4f4;padding:1px 5px;border-radius:3px;font-size:.95em;}
    ul{padding-left:1.4em;}
    li{margin:.35em 0;}
    a{color:#06c;}
    .muted{color:#666;font-size:.9em;}
  </style>
</head>
<body>
  <h1>Patient DICOM Study</h1>
  <p>This disc contains your medical images in standard <strong>DICOM</strong> format
  (IHE PDI compliant), in the <code>DICOM/</code> folder, indexed by <code>DICOMDIR</code>.</p>

  <h2>How to view the images</h2>
  <p>Install one of the free DICOM viewers below, then open this disc / USB drive
  with it (most viewers have a <em>File &rarr; Open DICOMDIR</em> menu, or accept
  the disc's drive letter).</p>
  <ul>
    <li><strong>Windows:</strong>
        <a href="https://www.microdicom.com">MicroDICOM</a> &middot;
        <a href="https://www.radiantviewer.com">RadiAnt</a> &middot;
        <a href="https://weasis.org">Weasis</a> &middot;
        <a href="https://www.medixant.com">Medixant</a> &middot;
        <a href="https://dicom.online">Online DICOM Viewer</a> (browser, no install)</li>
    <li><strong>macOS:</strong>
        <a href="https://horosproject.org">Horos</a> &middot;
        <a href="https://www.osirix-viewer.com">OsiriX Lite</a> &middot;
        <a href="https://weasis.org">Weasis</a> &middot;
        <a href="https://www.santesoft.com/win/sante-dicom-viewer-free/sante-dicom-viewer-free.html">Sante DICOM Viewer Free</a></li>
    <li><strong>Linux:</strong>
        <a href="https://weasis.org">Weasis</a> &middot;
        <a href="https://github.com/Crystalcave/Aeskulap">Aeskulap</a> &middot;
        <a href="https://github.com/InsightSoftwareConsortium/itk-snap">ITK-SNAP</a> &middot;
        <a href="https://github.com/ginkgocadx/ginkgocadx">Ginkgo CADx</a></li>
    <li><strong>iOS / iPad:</strong>
        OsiriX HD &middot; iMedicalView &middot; Symphony Free DICOM Viewer
        (search "DICOM viewer" in App Store)</li>
    <li><strong>Android:</strong>
        DroidRender &middot; mRay &middot; DICOM Viewer (search "DICOM viewer" in Play Store)</li>
    <li><strong>In a browser, no install:</strong>
        <a href="https://www.imaios.com/en/imaios-dicom-viewer">IMAIOS DICOM Viewer</a> &middot;
        <a href="https://dicom.online">dicom.online</a> &middot;
        <a href="https://viewer.ohif.org">OHIF Viewer</a>
        &mdash; copy your <code>DICOM</code> folder to the page</li>
    <li><strong>Already have software</strong> from a previous radiologist visit?
        It probably reads DICOMDIR &mdash; just point it at the disc.</li>
  </ul>

  <h2>What's on this disc</h2>
  <ul>
    <li><code>DICOM/</code> &mdash; the image files</li>
    <li><code>DICOMDIR</code> &mdash; index of the study (inside <code>DICOM/</code>)</li>
    <li><code>README.txt</code> &mdash; this information as plain text</li>
  </ul>

  <p class="muted">If you received this disc from a clinic, give it (or a copy) to
  any other doctor &mdash; every modern radiology workstation reads DICOMDIR.</p>
</body>
</html>
"""

_README_TXT = b"""Patient DICOM Study
====================

This disc / USB drive contains your medical images in standard DICOM
format (IHE PDI compliant). Any radiology workstation can read it.

Contents
--------

  DICOM/        DICOM image files
  DICOM/DICOMDIR  Index of the study (auto-discovered by viewers)
  index.html    Open in a browser for viewer download links
  README.txt    This file

How to view the images
----------------------

Install a free DICOM viewer, then open this disc with it. Most viewers
auto-discover the DICOMDIR file when you point them at the drive.

  WINDOWS:  MicroDICOM        https://www.microdicom.com
            RadiAnt           https://www.radiantviewer.com
            Weasis            https://weasis.org              (needs Java)
            Sante DICOM Free  https://www.santesoft.com

  MAC:      Horos             https://horosproject.org
            OsiriX Lite       https://www.osirix-viewer.com
            Weasis            https://weasis.org
            Sante DICOM Free  https://www.santesoft.com

  LINUX:    Weasis            https://weasis.org
            Aeskulap          https://github.com/Crystalcave/Aeskulap
            Ginkgo CADx       https://github.com/ginkgocadx/ginkgocadx
            ITK-SNAP          https://github.com/InsightSoftwareConsortium/itk-snap

  IOS/IPAD: OsiriX HD, iMedicalView, Symphony Free DICOM Viewer
            (search "DICOM viewer" in the App Store)

  ANDROID:  DroidRender, mRay, DICOM Viewer
            (search "DICOM viewer" in the Play Store)

  BROWSER:  IMAIOS  https://www.imaios.com/en/imaios-dicom-viewer
            OHIF    https://viewer.ohif.org
            Online  https://dicom.online
            (no install needed; upload the DICOM folder to the page)

If you already have radiology software from a prior visit, it most
likely reads DICOMDIR -- just point it at this disc.

For more info, double-click index.html on this disc.
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

            _write_top_level(staging)

            await _run_xorriso(staging, iso_path, _volume_label(accession, study_id))

            await asyncio.to_thread(shutil.rmtree, staging)  # only the ISO needs to survive past return
            return iso_path, tempdir
        except Exception:
            shutil.rmtree(tempdir, ignore_errors=True)
            raise
