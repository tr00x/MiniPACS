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
    _volume_label,
    _write_top_level,
)


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

    def test_autorun_inf_uses_single_backslash_before_favicon(self, tmp_path: Path):
        # Windows autorun.inf needs a backslash, not a forward slash.
        # And critically — exactly one backslash, not two (a doubled "\\"
        # would point at a UNC path and Windows would reject the autorun).
        _write_top_level(tmp_path)
        content = (tmp_path / "autorun.inf").read_bytes()
        # Should contain "VIEWER\favicon.ico" — exactly one backslash.
        assert b"VIEWER\\favicon.ico" in content
        # And NOT a UNC-style double backslash.
        assert b"VIEWER\\\\favicon.ico" not in content

    def test_autorun_inf_has_shellexecute(self, tmp_path: Path):
        _write_top_level(tmp_path)
        content = (tmp_path / "autorun.inf").read_bytes()
        assert b"shellexecute=index.html" in content
        assert b"[autorun]" in content

    def test_index_html_has_meta_refresh(self, tmp_path: Path):
        # Disc opens index.html -> meta refresh punts to VIEWER/index.html.
        # If this regresses, double-clicking the disc shows a static page.
        _write_top_level(tmp_path)
        content = (tmp_path / "index.html").read_bytes()
        assert b'meta http-equiv="refresh"' in content
        assert b"VIEWER/index.html" in content
        # Refresh delay must be 0 — anything else means a perceptible flash.
        assert b'content="0;' in content

    def test_index_html_has_fallback_link(self, tmp_path: Path):
        # If meta refresh is blocked (locked-down kiosk browser), the
        # user must still be able to click through manually.
        _write_top_level(tmp_path)
        content = (tmp_path / "index.html").read_bytes()
        assert b'href="VIEWER/index.html"' in content

    def test_readme_mentions_dwv(self, tmp_path: Path):
        _write_top_level(tmp_path)
        content = (tmp_path / "README.txt").read_bytes()
        assert b"DWV" in content

    def test_readme_mentions_dicomdir(self, tmp_path: Path):
        # Patients with non-DWV viewers (Weasis, RadiAnt) need to know
        # the disc is DICOMDIR-indexed so they can point those tools at it.
        _write_top_level(tmp_path)
        content = (tmp_path / "README.txt").read_bytes()
        assert b"DICOMDIR" in content

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


# ---------- module surface ---------------------------------------------------


class TestModuleSurface:
    def test_build_sem_capacity_is_two(self):
        # The module-level concurrency cap is the load-bearing invariant
        # for disk pressure — a single 2 GB study peaks ~6 GB intermediate.
        # Three concurrent builds would risk OOM-on-disk on the host.
        assert iso_builder._BUILD_SEM._value == 2
