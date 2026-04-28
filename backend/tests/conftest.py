"""Shared pytest fixtures for backend tests.

Kept intentionally minimal — burn-iso is currently the only module under
test, and most of its tests are self-contained (tmp_path + monkeypatch).
Add fixtures here when more than one test file needs the same setup.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import pydicom
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid


FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def has_xorriso() -> bool:
    """Skip-helper used by integration tests that need a real ISO mastered."""
    return shutil.which("xorriso") is not None


@pytest.fixture
def sample_pdf_bytes() -> bytes:
    return (FIXTURES / "sample_report.pdf").read_bytes()


@pytest.fixture
def sample_ctx_dicom(tmp_path: Path) -> Path:
    """Synthesize a minimal valid DICOM file for use as study context."""
    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.7"  # Secondary Capture
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = generate_uid()

    ds = FileDataset(str(tmp_path / "ctx.dcm"), {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.PatientName = "TEST^PATIENT"
    ds.PatientID = "PI0001"
    ds.PatientBirthDate = "19800101"
    ds.PatientSex = "F"
    ds.StudyInstanceUID = "1.2.3.4.5.999.1"
    ds.SeriesInstanceUID = "1.2.3.4.5.999.1.1"
    ds.StudyID = "TEST_STUDY"
    ds.StudyDate = "20260101"
    ds.StudyDescription = "TEST CERVICAL MRI"
    ds.AccessionNumber = "ACC0001"
    ds.Modality = "MR"
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    out = tmp_path / "ctx.dcm"
    ds.save_as(out)
    return out
