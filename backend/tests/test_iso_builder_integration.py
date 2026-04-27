"""Integration tests that exercise real xorriso + the full build_study_iso
pipeline (Orthanc download is mocked, but extraction, viewer staging, and
ISO mastering all run for real).

Run with:    pytest -m integration

These are skipped automatically if `xorriso` is not on PATH (e.g. on a
host without the binary — the backend container does ship it).
"""

from __future__ import annotations

import asyncio
import io
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import AsyncIterator

import pytest

from app.services import iso_builder

pytestmark = pytest.mark.integration


_HAS_XORRISO = shutil.which("xorriso") is not None


def _make_fake_dicom_zip() -> bytes:
    """Synthesise a tiny zip that mimics Orthanc /studies/{id}/media output.

    We do NOT need real DICOM bytes — iso_builder treats the zip opaquely,
    just extracting + handing the result to xorriso. A handful of small
    files exercises both the unzip path and the file-count edge.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("DICOMDIR", b"FAKE-DICOMDIR-INDEX")
        zf.writestr("IMAGES/IM00001", b"\x00\x01\x02\x03" * 64)
        zf.writestr("IMAGES/IM00002", b"\x04\x05\x06\x07" * 64)
    return buf.getvalue()


# ---------- _run_xorriso (lowest-level real-binary test) --------------------


class TestRunXorriso:
    @pytest.mark.skipif(not _HAS_XORRISO, reason="xorriso not on PATH")
    async def test_builds_iso_from_minimal_staging(self, tmp_path: Path):
        # Stage what build_study_iso would stage: DICOM/, VIEWER/, and the
        # three top-level files. We don't need DWV proper here — a marker
        # file inside VIEWER is enough to prove xorriso preserved the tree.
        staging = tmp_path / "staging"
        (staging / "DICOM").mkdir(parents=True)
        (staging / "DICOM" / "IM00001").write_bytes(b"\x00" * 256)
        (staging / "VIEWER").mkdir()
        (staging / "VIEWER" / "index.html").write_bytes(b"<html><body>fake viewer</body></html>")
        (staging / "VIEWER" / "favicon.ico").write_bytes(b"\x00" * 32)
        iso_builder._write_top_level(staging)

        iso_path = tmp_path / "out.iso"
        await iso_builder._run_xorriso(staging, iso_path, "TEST_LABEL")

        # ISO exists and has a non-trivial size.
        assert iso_path.exists()
        assert iso_path.stat().st_size > 0, "ISO should not be empty"
        # ISO 9660 minimum image size is ~300 KB even for a tiny payload.
        assert iso_path.stat().st_size > 100_000, "ISO suspiciously small"

        # xorriso -indev <iso> -ls / lists the root dir; verify all four
        # expected entries (DICOM, VIEWER, index.html, autorun.inf) are
        # present. README.txt is also there but we keep the assertion list
        # compact — DICOM/VIEWER are the load-bearing payload directories.
        result = subprocess.run(
            ["xorriso", "-indev", str(iso_path), "-ls", "/"],
            capture_output=True,
            text=True,
            check=True,
        )
        listing = result.stdout
        assert "DICOM" in listing
        assert "VIEWER" in listing
        assert "index.html" in listing
        assert "autorun.inf" in listing
        assert "README.txt" in listing

    @pytest.mark.skipif(not _HAS_XORRISO, reason="xorriso not on PATH")
    async def test_xorriso_failure_surfaces_runtime_error(self, tmp_path: Path):
        # Point xorriso at a path that does not exist — it must fail
        # non-zero, and our wrapper must translate that into RuntimeError
        # rather than swallowing the exit code.
        iso_path = tmp_path / "wont-be-created.iso"
        with pytest.raises(RuntimeError, match="xorriso failed"):
            await iso_builder._run_xorriso(
                tmp_path / "does-not-exist", iso_path, "BAD"
            )


# ---------- _BUILD_SEM concurrency cap --------------------------------------


class TestBuildSemaphoreConcurrency:
    @pytest.mark.skipif(not _HAS_XORRISO, reason="xorriso not on PATH")
    async def test_only_two_concurrent_builds(self, tmp_path: Path, monkeypatch):
        """Three callers fire build_study_iso simultaneously; we must observe
        peak concurrency of exactly 2 (the semaphore capacity).

        Disk pressure invariant: a single 2 GB study peaks ~6 GB of
        intermediate state. Letting three run in parallel risks OOM-on-disk.
        """
        # Reset the semaphore to a known fresh state — other tests in the
        # session may have left it perturbed (it's module-level singleton).
        # A fresh semaphore with the same capacity is the cleanest reset.
        monkeypatch.setattr(iso_builder, "_BUILD_SEM", asyncio.Semaphore(2))

        # DWV bundle is required by _stage_viewer; substitute a tiny stub
        # so we don't have to ship the real ~3 MB DWV in the test fixture.
        fake_dwv = tmp_path / "fake-dwv"
        fake_dwv.mkdir()
        (fake_dwv / "index.html").write_bytes(b"<html>stub viewer</html>")
        (fake_dwv / "favicon.ico").write_bytes(b"\x00" * 32)
        monkeypatch.setattr(iso_builder, "DWV_PATH", fake_dwv)

        # Instrumentation: every download attempt bumps `active` and yields.
        # We track peak concurrency observed across the run.
        active = 0
        peak = 0
        gate = asyncio.Event()

        async def fake_download(study_id: str) -> AsyncIterator[bytes]:
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            try:
                # Hold inside the critical section long enough that all
                # three callers have a chance to try entering. The third
                # one MUST be blocked at the semaphore at this point.
                await gate.wait()
                yield _make_fake_dicom_zip()
            finally:
                active -= 1

        # The download stream is reached from inside _stream_to_file ->
        # orthanc.download_study_media_stream. Patch that symbol.
        from app.services import orthanc as orthanc_mod
        monkeypatch.setattr(orthanc_mod, "download_study_media_stream", fake_download)

        async def run_one(sid: str) -> Path:
            iso_path, td = await iso_builder.build_study_iso(sid, accession=None)
            # Cleanup the per-call tempdir immediately.
            shutil.rmtree(td, ignore_errors=True)
            return iso_path

        # Kick off three concurrently.
        tasks = [
            asyncio.create_task(run_one(f"study-{i}-aaaaaaaa")) for i in range(3)
        ]

        # Give the event loop a few ticks so all three tasks reach either
        # the semaphore wait or the download wait.
        for _ in range(20):
            await asyncio.sleep(0.01)
            if active >= 2:
                break

        # CRITICAL: at this point exactly 2 of the 3 must be inside the
        # download (which is itself inside the semaphore). The third is
        # waiting on the semaphore and has NOT entered fake_download.
        assert active == 2, f"expected 2 in flight under SEM cap, saw {active}"

        # Release everyone and let them finish.
        gate.set()
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Sanity: all three completed without exception, and peak never
        # exceeded the cap during the entire run.
        for r in results:
            assert not isinstance(r, Exception), f"build raised: {r!r}"
        assert peak == 2, f"peak concurrency was {peak}, expected 2 (cap)"


# ---------- full build_study_iso end-to-end ---------------------------------


class TestBuildStudyIsoEndToEnd:
    @pytest.mark.skipif(not _HAS_XORRISO, reason="xorriso not on PATH")
    async def test_builds_iso_with_mocked_orthanc(self, tmp_path: Path, monkeypatch):
        """Full pipeline: mocked Orthanc download -> real unzip -> stub
        DWV copy -> real xorriso. Verifies the returned ISO is well-formed
        and the staging directory was cleaned up after mastering."""
        fake_dwv = tmp_path / "dwv-bundle"
        fake_dwv.mkdir()
        (fake_dwv / "index.html").write_bytes(b"<html>viewer</html>")
        (fake_dwv / "app.js").write_bytes(b"console.log('dwv stub')")
        monkeypatch.setattr(iso_builder, "DWV_PATH", fake_dwv)

        async def fake_download(study_id: str) -> AsyncIterator[bytes]:
            yield _make_fake_dicom_zip()

        from app.services import orthanc as orthanc_mod
        monkeypatch.setattr(orthanc_mod, "download_study_media_stream", fake_download)

        iso_path, tempdir = await iso_builder.build_study_iso(
            "abcdef1234567890", accession="ACC-2026-001"
        )
        try:
            assert iso_path.exists()
            assert iso_path.stat().st_size > 100_000
            # iso_builder removes the staging dir before returning so only
            # the ISO survives — cheap intermediate-disk reclamation.
            assert not (tempdir / "staging").exists()
            assert not (tempdir / "media.zip").exists()

            # Inspect the actual ISO contents.
            result = subprocess.run(
                ["xorriso", "-indev", str(iso_path), "-ls", "/"],
                capture_output=True,
                text=True,
                check=True,
            )
            for entry in ("DICOM", "VIEWER", "index.html", "autorun.inf", "README.txt"):
                assert entry in result.stdout, f"{entry} missing from ISO root"
        finally:
            shutil.rmtree(tempdir, ignore_errors=True)
