"""Tests for the directory walkers in import_studies."""
from pathlib import Path

import pytest

from app.routers.import_studies import _walk_pdfs, _walk_dicom


def _write_dicom(path: Path, study_uid: str = "1.2.3.4.5.999.42"):
    """Write a tiny synthetic DICOM (DICM magic + minimal dataset) at `path`."""
    import pydicom
    from pydicom.dataset import Dataset, FileDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid

    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.7"
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = generate_uid()
    ds = FileDataset(str(path), {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.7"
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.PatientID = "PI0001"
    ds.PatientName = "T^P"
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = "1.2.3.4.5.999.42.1"
    path.parent.mkdir(parents=True, exist_ok=True)
    ds.save_as(path)


def test_walk_pdfs_pairs_pdf_with_sibling_dicom(tmp_path):
    pdf_path = tmp_path / "S0000001" / "_REPORT.PDF"
    dcm_path = tmp_path / "S0000001" / "O0000001"
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    pdf_path.write_bytes(b"%PDF-1.4\n%fake\n")
    _write_dicom(dcm_path)

    pairs = list(_walk_pdfs(tmp_path))
    assert len(pairs) == 1
    pdf, ctx = pairs[0]
    assert pdf == pdf_path
    assert ctx == dcm_path


def test_walk_pdfs_skips_when_multi_study(tmp_path):
    pdf_path = tmp_path / "_REPORT.PDF"
    pdf_path.write_bytes(b"%PDF-1.4\n%fake\n")
    _write_dicom(tmp_path / "a.dcm", study_uid="1.2.3.4.5.999.A")
    _write_dicom(tmp_path / "b.dcm", study_uid="1.2.3.4.5.999.B")

    pairs = list(_walk_pdfs(tmp_path))
    assert pairs == []


def test_walk_pdfs_skips_when_no_dicom(tmp_path):
    pdf_path = tmp_path / "report.pdf"
    pdf_path.write_bytes(b"%PDF-1.4\n%fake\n")

    pairs = list(_walk_pdfs(tmp_path))
    assert pairs == []


@pytest.mark.integration
def test_walk_pdfs_to_orthanc_full_pipeline(tmp_path, sample_pdf_bytes):
    """End-to-end: simulate extracted-archive layout → _walk_pdfs →
    encapsulate_pdf → POST to running Orthanc → verify DOC series in study.

    Substitutes for the UI drag-drop manual smoke. Uses a real ~40 KB PDF
    (the same fixture the unit tests use) and a synthesized clinical-style
    DICOM with a stable StudyInstanceUID so the assertion is deterministic.
    """
    import os
    import httpx

    from app.services.pdf_encapsulator import encapsulate_pdf

    url = os.environ.get("ORTHANC_URL", "http://orthanc:8042")
    user = os.environ.get("ORTHANC_USERNAME", "orthanc")
    pwd = os.environ.get("ORTHANC_PASSWORD")
    if not pwd:
        pytest.skip("ORTHANC_PASSWORD not set")

    # Build the WL_*-style layout: S0000001/_REPORT.PDF + S0000001/O0000001
    study_uid = "1.2.3.4.5.999.E2E"
    work = tmp_path / "extracted"
    series_dir = work / "S0000001"
    series_dir.mkdir(parents=True)
    (series_dir / "_REPORT.PDF").write_bytes(sample_pdf_bytes)
    _write_dicom(series_dir / "O0000001", study_uid=study_uid)

    # Walker yields exactly 1 pair (single study, one PDF).
    pairs = list(_walk_pdfs(work))
    assert len(pairs) == 1
    pdf_path, ctx_path = pairs[0]

    # First push the ctx DICOM so Orthanc has the study.
    ctx_bytes = ctx_path.read_bytes()
    r1 = httpx.post(
        f"{url}/instances",
        content=ctx_bytes,
        headers={"Content-Type": "application/dicom"},
        auth=(user, pwd),
        timeout=30.0,
    )
    assert r1.status_code in (200, 201), r1.text

    # Now encapsulate + POST the PDF (same code path _process_one_file uses).
    pdf_bytes = pdf_path.read_bytes()
    dicom_bytes = encapsulate_pdf(pdf_bytes, ctx_path)
    r2 = httpx.post(
        f"{url}/instances",
        content=dicom_bytes,
        headers={"Content-Type": "application/dicom"},
        auth=(user, pwd),
        timeout=30.0,
    )
    assert r2.status_code in (200, 201), r2.text
    parent_study = r2.json()["ParentStudy"]

    # Find the DOC series in that study.
    r3 = httpx.get(
        f"{url}/studies/{parent_study}/series",
        auth=(user, pwd),
        timeout=10.0,
    )
    assert r3.status_code == 200, r3.text
    doc_series = [s for s in r3.json() if s["MainDicomTags"].get("Modality") == "DOC"]
    assert len(doc_series) == 1, "expected exactly one DOC series attached to study"
    assert doc_series[0]["MainDicomTags"]["SeriesDescription"] == "Radiology Report"
