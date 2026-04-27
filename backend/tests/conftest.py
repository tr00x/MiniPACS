"""Shared pytest fixtures for backend tests.

Kept intentionally minimal — burn-iso is currently the only module under
test, and most of its tests are self-contained (tmp_path + monkeypatch).
Add fixtures here when more than one test file needs the same setup.
"""

from __future__ import annotations

import shutil

import pytest


@pytest.fixture(scope="session")
def has_xorriso() -> bool:
    """Skip-helper used by integration tests that need a real ISO mastered."""
    return shutil.which("xorriso") is not None
