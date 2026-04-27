"""Route-level smoke test for GET /api/studies/{id}/burn-iso.

Uses FastAPI TestClient with auth + iso_builder + orthanc all mocked, so
this exercises the routing/headers/streaming wiring without needing a
real Orthanc or running xorriso again (the real pipeline is covered in
test_iso_builder_integration.py).

Marked `integration` only because it imports the live FastAPI app, which
in turn imports app.db (asyncpg) and the rest of the runtime. It still
runs fine inside the backend container.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.auth import get_current_user

pytestmark = pytest.mark.integration


def _override_user():
    """Stand-in for the JWT-decoding dependency. Returns the same shape
    as a real DB user row (only `id` is referenced by the burn-iso path,
    but we include the rest for forward-compat if the route grows)."""
    return {
        "id": 42,
        "username": "tester",
        "role": "admin",
        "token_version": 1,
    }


@pytest.fixture
def fake_iso(tmp_path: Path) -> Path:
    """Pre-built byte-identical 'ISO' that build_study_iso returns. Doesn't
    need to be a real ISO 9660 image — the route is a passthrough stream."""
    p = tmp_path / "fake.iso"
    p.write_bytes(b"PRETEND-ISO-9660-IMAGE-PAYLOAD" * 100)
    return p


@pytest.fixture
def client(monkeypatch, fake_iso: Path, tmp_path: Path):
    """TestClient with auth bypassed and the heavy dependencies stubbed.

    Three things mocked:
      1. get_current_user      -> fake admin (no JWT to forge)
      2. orthanc.get_study     -> minimal MainDicomTags (provides accession)
      3. iso_builder.build_study_iso -> returns (fake_iso, tmp_path)
      4. log_audit             -> no-op so we don't need a live DB pool
    """
    app.dependency_overrides[get_current_user] = _override_user

    async def fake_get_study(study_id: str):
        return {"MainDicomTags": {"AccessionNumber": "ACC-test/2026"}}

    # iso_builder return contract: (iso_path, tempdir) — caller schedules
    # `rmtree(tempdir)` as a BackgroundTask after the stream finishes.
    iso_tempdir = tmp_path / "build-tempdir"
    iso_tempdir.mkdir()

    async def fake_build_iso(study_id: str, accession: str | None = None):
        return fake_iso, iso_tempdir

    audit_calls: list[tuple] = []

    async def fake_log_audit(action, resource_type=None, resource_id=None,
                             user_id=None, patient_token=None,
                             ip_address=None, wait=False):
        audit_calls.append((action, resource_type, resource_id, user_id))

    from app.services import orthanc as orthanc_mod
    from app.services import iso_builder as iso_mod
    from app.routers import studies as studies_mod

    monkeypatch.setattr(orthanc_mod, "get_study", fake_get_study)
    monkeypatch.setattr(iso_mod, "build_study_iso", fake_build_iso)
    # log_audit is imported by name into studies.py — patch the attribute
    # *on that module*, otherwise the local reference still points at the
    # real (DB-touching) implementation.
    monkeypatch.setattr(studies_mod, "log_audit", fake_log_audit)

    tc = TestClient(app)
    # Stash the audit recorder on the client so the test can assert it.
    tc._audit_calls = audit_calls  # type: ignore[attr-defined]
    try:
        yield tc
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        shutil.rmtree(iso_tempdir, ignore_errors=True)


class TestBurnIsoRoute:
    def test_returns_200_with_iso_content_type(self, client: TestClient, fake_iso: Path):
        resp = client.get("/api/studies/abcdef1234567890/burn-iso")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/x-iso9660-image"

    def test_streams_iso_bytes_intact(self, client: TestClient, fake_iso: Path):
        resp = client.get("/api/studies/abcdef1234567890/burn-iso")
        assert resp.status_code == 200
        # Body must be exactly the bytes iso_builder produced — the route
        # is a thin streaming passthrough; any mismatch means the streaming
        # iterator is truncating or double-reading.
        assert resp.content == fake_iso.read_bytes()

    def test_content_disposition_uses_sanitized_accession(self, client: TestClient):
        resp = client.get("/api/studies/abcdef1234567890/burn-iso")
        cd = resp.headers["content-disposition"]
        assert "attachment" in cd
        # AccessionNumber "ACC-test/2026" -> _sanitize_filename strips '/'
        # and other risky chars. We don't pin the exact form (the regex
        # is a router internal), but path separators MUST be gone.
        assert "/" not in cd.split("filename=")[1]
        assert ".iso" in cd
        # And the accession should still be recognisable in some form.
        assert "ACC" in cd

    def test_audit_row_written(self, client: TestClient):
        resp = client.get("/api/studies/abcdef1234567890/burn-iso")
        assert resp.status_code == 200
        calls = client._audit_calls  # type: ignore[attr-defined]
        # Exactly one audit row, action=export_study_iso, type=study,
        # resource_id=the study id, user_id=42 (our fake admin).
        assert len(calls) == 1
        action, rtype, rid, uid = calls[0]
        assert action == "export_study_iso"
        assert rtype == "study"
        assert rid == "abcdef1234567890"
        assert uid == 42

    def test_unauth_when_dependency_not_overridden(self, monkeypatch, fake_iso: Path, tmp_path: Path):
        """Sanity — without the override, the route should 401/403, not 200.
        Confirms our auth bypass in the other tests is actually load-bearing
        (we're not silently authenticating anonymous traffic in prod)."""
        # Build a fresh client that does NOT override get_current_user.
        async def fake_get_study(study_id: str):
            return {"MainDicomTags": {}}

        async def fake_build_iso(study_id: str, accession: str | None = None):
            td = tmp_path / "untouched"
            td.mkdir(exist_ok=True)
            return fake_iso, td

        from app.services import orthanc as orthanc_mod
        from app.services import iso_builder as iso_mod
        monkeypatch.setattr(orthanc_mod, "get_study", fake_get_study)
        monkeypatch.setattr(iso_mod, "build_study_iso", fake_build_iso)

        with TestClient(app) as tc:
            resp = tc.get("/api/studies/abcdef1234567890/burn-iso")
            # Either 401 (no creds) or 403 (creds rejected) is acceptable —
            # the load-bearing assertion is "not 200".
            assert resp.status_code in (401, 403), (
                f"unauth call should be rejected, got {resp.status_code}"
            )
