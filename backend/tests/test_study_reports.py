"""Unit tests for app.services.study_reports.collect_study_pdf_reports.

Mocks orthanc.get_study_series / get_series_instances / get_instance_file
so the helper is exercised without a running Orthanc.
"""
from __future__ import annotations

import pytest

from app.services import study_reports
from app.services.pdf_encapsulator import encapsulate_pdf


@pytest.fixture
def mock_orthanc(monkeypatch, sample_pdf_bytes, sample_ctx_dicom):
    """Synthesise a study with one DOC series containing one PDF instance.

    Returns a (study_id, list_of_pdf_bytes) tuple — the helper under test
    should round-trip back to the SAME pdf bytes.
    """
    pdf_dcm_bytes = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)

    series_listing = [
        {"ID": "img-series-1", "MainDicomTags": {"Modality": "MR"}, "Instances": ["img-i-1"]},
        {"ID": "doc-series-1", "MainDicomTags": {"Modality": "DOC"}, "Instances": ["pdf-i-1"]},
    ]
    instance_files = {"pdf-i-1": pdf_dcm_bytes, "img-i-1": b"not-a-dicom"}

    async def fake_get_study_series(study_id: str):
        assert study_id == "S1"
        return series_listing

    async def fake_get_series_instances(series_id: str):
        if series_id == "doc-series-1":
            return [{"ID": "pdf-i-1"}]
        return [{"ID": "img-i-1"}]

    async def fake_get_instance_file(instance_id: str) -> bytes:
        return instance_files[instance_id]

    monkeypatch.setattr(study_reports.orthanc, "get_study_series", fake_get_study_series)
    monkeypatch.setattr(study_reports.orthanc, "get_series_instances", fake_get_series_instances)
    monkeypatch.setattr(study_reports, "get_instance_file", fake_get_instance_file)

    return "S1", [sample_pdf_bytes]


@pytest.mark.asyncio
async def test_collects_single_pdf_from_doc_series(mock_orthanc):
    study_id, expected = mock_orthanc
    out = await study_reports.collect_study_pdf_reports(study_id)
    assert out == expected


@pytest.mark.asyncio
async def test_skips_non_doc_series_without_fetching_files(
    monkeypatch, sample_pdf_bytes, sample_ctx_dicom
):
    """Non-DOC series must NOT trigger an instance-file fetch — that would
    pull megabytes per image just to discard them. Modality filter is the
    cheap pre-filter."""
    fetches: list[str] = []

    async def fake_get_study_series(study_id: str):
        return [
            {"ID": "img-series-1", "MainDicomTags": {"Modality": "MR"}, "Instances": ["img-i-1"]},
        ]

    async def fake_get_series_instances(series_id: str):
        return [{"ID": "img-i-1"}]

    async def fake_get_instance_file(instance_id: str) -> bytes:
        fetches.append(instance_id)
        return b""

    monkeypatch.setattr(study_reports.orthanc, "get_study_series", fake_get_study_series)
    monkeypatch.setattr(study_reports.orthanc, "get_series_instances", fake_get_series_instances)
    monkeypatch.setattr(study_reports, "get_instance_file", fake_get_instance_file)

    out = await study_reports.collect_study_pdf_reports("S1")
    assert out == []
    assert fetches == [], "no per-instance fetches expected when no DOC series"


@pytest.mark.asyncio
async def test_returns_empty_list_for_study_with_no_pdfs(monkeypatch):
    async def fake_get_study_series(study_id: str):
        return []

    monkeypatch.setattr(study_reports.orthanc, "get_study_series", fake_get_study_series)
    out = await study_reports.collect_study_pdf_reports("S1")
    assert out == []
