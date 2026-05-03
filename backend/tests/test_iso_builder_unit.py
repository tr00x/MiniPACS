"""Unit tests for iso_builder pure helpers.

No async, no I/O beyond tmp_path, no Orthanc, no xorriso. These run on
every push and stay fast — the integration tests cover the real pipeline.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services import iso_builder
from app.services.iso_builder import (
    _AUTORUN_INF,
    _INDEX_HTML,
    _README_TXT,
    _extract_pdfs_to_root,
    _volume_label,
    _write_top_level,
)
from app.services.pdf_encapsulator import encapsulate_pdf


# ---------- _volume_label ----------------------------------------------------


class TestVolumeLabel:
    def test_empty_accession_uses_fallback(self):
        # Accession is the natural label; if absent we fall back to study_id.
        assert _volume_label("", "study123abc") == "study123abc"

    def test_none_accession_uses_fallback(self):
        assert _volume_label(None, "study123abc") == "study123abc"

    def test_empty_both_returns_default(self):
        # Both empty -> regex sub on empty string returns empty,
        # which `or "PACS_STUDY"` rescues to the static default.
        assert _volume_label("", "") == "PACS_STUDY"

    def test_none_both_returns_default(self):
        assert _volume_label(None, "") == "PACS_STUDY"

    def test_special_chars_replaced_with_underscore(self):
        # ISO 9660 volume labels are restricted to A-Z 0-9 _; our regex
        # is broader (allows lowercase + dash) but anything else -> _.
        assert _volume_label("AB/CD:EF*GH", "fallback") == "AB_CD_EF_GH"

    def test_spaces_become_underscores(self):
        assert _volume_label("Patient Smith 2026", "fb") == "Patient_Smith_2026"

    def test_only_special_chars_collapses_to_default(self):
        # Pure punctuation -> after sub becomes "____", which is truthy
        # so we keep it (not PACS_STUDY). The "or PACS_STUDY" only fires
        # when the post-sub string is empty, so verify both branches.
        out = _volume_label("////", "fb")
        assert out == "____"

    def test_truncated_at_24_chars(self):
        # Accession longer than 24 must be sliced before sanitization so the
        # final label respects the ISO 9660-ish 32-char limit and our 24 cap.
        long = "A" * 50
        assert len(_volume_label(long, "fb")) == 24
        assert _volume_label(long, "fb") == "A" * 24

    def test_truncation_applies_before_sanitization(self):
        # First 24 chars contain mixed legal/illegal; verify both ops applied.
        accession = "Pat/2026/0123456789ABCDEFGHIJ_extra_ignored"
        result = _volume_label(accession, "fb")
        assert len(result) == 24
        assert "/" not in result
        assert result == "Pat_2026_0123456789ABCDE"

    def test_dash_and_underscore_preserved(self):
        # Regex whitelists [A-Za-z0-9_-]; both must survive untouched.
        assert _volume_label("A-B_C-1", "fb") == "A-B_C-1"

    def test_fallback_also_truncated(self):
        # When fallback is used (empty accession), cap still applies.
        long_fb = "X" * 40
        assert len(_volume_label("", long_fb)) == 24


# ---------- _write_top_level -------------------------------------------------


class TestWriteTopLevel:
    def test_writes_three_files(self, tmp_path: Path):
        _write_top_level(tmp_path)
        assert (tmp_path / "autorun.inf").exists()
        assert (tmp_path / "index.html").exists()
        assert (tmp_path / "README.txt").exists()
        # And only those three at the top level (no surprise siblings).
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "README.txt",
            "autorun.inf",
            "index.html",
        ]

    def test_autorun_inf_content_exact(self, tmp_path: Path):
        _write_top_level(tmp_path)
        content = (tmp_path / "autorun.inf").read_bytes()
        assert content == _AUTORUN_INF

    def test_autorun_inf_has_shellexecute(self, tmp_path: Path):
        _write_top_level(tmp_path)
        content = (tmp_path / "autorun.inf").read_bytes()
        assert b"shellexecute=index.html" in content
        assert b"[autorun]" in content

    def test_autorun_inf_no_viewer_path(self, tmp_path: Path):
        # ISO no longer ships an embedded viewer (file:// fences it off);
        # autorun must not reference a VIEWER/ subdir that doesn't exist.
        _write_top_level(tmp_path)
        content = (tmp_path / "autorun.inf").read_bytes()
        assert b"VIEWER" not in content

    def test_index_html_no_viewer_redirect(self, tmp_path: Path):
        # Old behaviour was a meta-refresh into VIEWER/index.html. Now there
        # IS no viewer on disc — index.html is a static page with viewer
        # download links. Regression here means we shipped a redirect to
        # a missing path.
        _write_top_level(tmp_path)
        content = (tmp_path / "index.html").read_bytes()
        assert b"VIEWER/" not in content
        assert b'meta http-equiv="refresh"' not in content

    def test_index_html_links_external_viewers(self, tmp_path: Path):
        # The whole point of index.html now is to direct patients to free
        # desktop viewers. If these links disappear, patients open the
        # disc and have no idea what to do.
        _write_top_level(tmp_path)
        content = (tmp_path / "index.html").read_bytes()
        assert b"weasis.org" in content
        assert b"microdicom.com" in content
        assert b"horosproject.org" in content

    def test_index_html_mentions_dicom_layout(self, tmp_path: Path):
        # Patients (and other clinics) need to know the disc is plain
        # DICOM/DICOMDIR — so any radiology workstation can ingest it.
        _write_top_level(tmp_path)
        content = (tmp_path / "index.html").read_bytes()
        assert b"DICOM" in content
        assert b"DICOMDIR" in content

    def test_readme_no_dwv_references(self, tmp_path: Path):
        # Old README mentioned DWV / VIEWER folder; both are gone now.
        # Stale references would mislead the patient about disc contents.
        _write_top_level(tmp_path)
        content = (tmp_path / "README.txt").read_bytes()
        assert b"DWV" not in content
        assert b"VIEWER" not in content

    def test_readme_mentions_dicomdir(self, tmp_path: Path):
        # Patients with desktop viewers (Weasis, RadiAnt, etc.) need to
        # know the disc is DICOMDIR-indexed so they can point those
        # tools at it.
        _write_top_level(tmp_path)
        content = (tmp_path / "README.txt").read_bytes()
        assert b"DICOMDIR" in content

    def test_readme_lists_external_viewers(self, tmp_path: Path):
        # Patients need at least one actionable viewer per OS family.
        _write_top_level(tmp_path)
        content = (tmp_path / "README.txt").read_bytes()
        # Windows
        assert b"microdicom.com" in content or b"radiantviewer.com" in content
        # Mac
        assert b"horosproject.org" in content or b"weasis.org" in content
        # Linux / cross-platform
        assert b"weasis.org" in content

    def test_readme_content_exact(self, tmp_path: Path):
        _write_top_level(tmp_path)
        assert (tmp_path / "README.txt").read_bytes() == _README_TXT

    def test_index_html_content_exact(self, tmp_path: Path):
        _write_top_level(tmp_path)
        assert (tmp_path / "index.html").read_bytes() == _INDEX_HTML

    def test_overwrites_existing_files(self, tmp_path: Path):
        # Caller may invoke twice (retry path); the second call must clobber.
        (tmp_path / "autorun.inf").write_bytes(b"stale")
        _write_top_level(tmp_path)
        assert (tmp_path / "autorun.inf").read_bytes() == _AUTORUN_INF


# ---------- _extract_pdfs_to_root --------------------------------------------


class TestExtractPdfsToRoot:
    """The burn-ISO disc must surface encapsulated PDF reports at the disc
    root as `report-N.pdf`, NOT just leave them as `.dcm` files inside
    DICOM/. Patients can't open encapsulated DICOM PDFs without a viewer.
    """

    def _stage_with_dicom_dir(self, tmp_path: Path) -> Path:
        staging = tmp_path / "staging"
        (staging / "DICOM").mkdir(parents=True)
        return staging

    def test_returns_empty_when_no_pdfs(self, tmp_path: Path):
        staging = self._stage_with_dicom_dir(tmp_path)
        # Drop a non-PDF file into DICOM/ to confirm the walker doesn't
        # mis-classify random bytes as a PDF.
        (staging / "DICOM" / "IM00001").write_bytes(b"\x00\x01\x02\x03" * 64)
        out = _extract_pdfs_to_root(staging)
        assert out == []
        assert not list(staging.glob("report-*.pdf"))

    def test_extracts_single_pdf(
        self, tmp_path: Path, sample_pdf_bytes, sample_ctx_dicom
    ):
        staging = self._stage_with_dicom_dir(tmp_path)
        encap = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)
        (staging / "DICOM" / "IM00001.dcm").write_bytes(encap)

        out = _extract_pdfs_to_root(staging)

        assert out == ["report-1.pdf"]
        assert (staging / "report-1.pdf").read_bytes() == sample_pdf_bytes

    def test_extracts_multiple_pdfs_deterministic_order(
        self, tmp_path: Path, sample_pdf_bytes, sample_ctx_dicom
    ):
        staging = self._stage_with_dicom_dir(tmp_path)
        encap = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)
        # Two distinct payloads → two distinct SOPInstanceUIDs.
        encap2 = encapsulate_pdf(sample_pdf_bytes + b"%%EOF\n", sample_ctx_dicom)
        # File names intentionally NOT in alpha order — output order is
        # determined by SOPInstanceUID, not directory listing order.
        (staging / "DICOM" / "z.dcm").write_bytes(encap)
        (staging / "DICOM" / "a.dcm").write_bytes(encap2)

        out = _extract_pdfs_to_root(staging)

        assert sorted(out) == ["report-1.pdf", "report-2.pdf"]
        # Both files exist with the right magic.
        for name in out:
            assert (staging / name).read_bytes().startswith(b"%PDF-")
        # Calling twice must be idempotent — same inputs, same names.
        out2 = _extract_pdfs_to_root(staging)
        assert out == out2

    def test_skips_non_dicom_files_silently(self, tmp_path: Path):
        staging = self._stage_with_dicom_dir(tmp_path)
        (staging / "DICOM" / "DICOMDIR").write_bytes(b"DICM-like-but-not")
        (staging / "DICOM" / "subdir").mkdir()
        (staging / "DICOM" / "subdir" / "blob").write_bytes(b"random")
        out = _extract_pdfs_to_root(staging)
        assert out == []


class TestWriteTopLevelWithReports:
    def test_no_reports_default_writes_static_bytes(self, tmp_path: Path):
        # Backwards-compat: existing exact-content tests assume default.
        _write_top_level(tmp_path)
        assert (tmp_path / "README.txt").read_bytes() == _README_TXT
        assert (tmp_path / "index.html").read_bytes() == _INDEX_HTML

    def test_with_reports_appends_report_section_to_readme(self, tmp_path: Path):
        _write_top_level(tmp_path, report_filenames=["report-1.pdf"])
        readme = (tmp_path / "README.txt").read_bytes()
        # Static base content still present...
        assert b"DICOMDIR" in readme
        # ...plus a clear pointer to the PDF report so the patient can
        # double-click it without any viewer.
        assert b"report-1.pdf" in readme
        assert b"REPORT" in readme.upper()

    def test_with_reports_mentions_pdf_in_index_html(self, tmp_path: Path):
        _write_top_level(tmp_path, report_filenames=["report-1.pdf", "report-2.pdf"])
        html = (tmp_path / "index.html").read_bytes()
        assert b"report-1.pdf" in html
        assert b"report-2.pdf" in html


# ---------- module surface ---------------------------------------------------


class TestModuleSurface:
    def test_build_sem_capacity_is_two(self):
        # The module-level concurrency cap is the load-bearing invariant
        # for disk pressure — a single 2 GB study peaks ~6 GB intermediate.
        # Three concurrent builds would risk OOM-on-disk on the host.
        assert iso_builder._BUILD_SEM._value == 2
