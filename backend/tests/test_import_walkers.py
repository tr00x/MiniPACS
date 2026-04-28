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
