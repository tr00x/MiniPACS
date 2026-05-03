"""Unit tests for app.services.pdf_extractor.

Round-trip property: encapsulate(P) → DICOM bytes → extract → P.
The extractor is the inverse of pdf_encapsulator and is used by
both the burn-ISO builder (to surface report PDFs at disc root)
and the /studies/{id}/reports endpoint (to ship the report as
application/pdf to the browser).
"""
from io import BytesIO

import pydicom
import pytest

from app.services.pdf_encapsulator import encapsulate_pdf
from app.services.pdf_extractor import (
    extract_pdf_from_dicom,
    is_encapsulated_pdf,
)


def test_extract_returns_pdf_bytes_for_encapsulated(sample_pdf_bytes, sample_ctx_dicom):
    dcm = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)
    out = extract_pdf_from_dicom(dcm)
    assert out == sample_pdf_bytes


def test_extract_returns_none_for_non_pdf_dicom(sample_ctx_dicom):
    dcm_bytes = sample_ctx_dicom.read_bytes()
    assert extract_pdf_from_dicom(dcm_bytes) is None


def test_extract_returns_none_for_garbage_bytes():
    assert extract_pdf_from_dicom(b"this is not DICOM at all") is None


def test_is_encapsulated_pdf_predicate(sample_pdf_bytes, sample_ctx_dicom):
    encap = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)
    ds_pdf = pydicom.dcmread(BytesIO(encap))
    ds_ctx = pydicom.dcmread(sample_ctx_dicom)

    assert is_encapsulated_pdf(ds_pdf) is True
    assert is_encapsulated_pdf(ds_ctx) is False


def test_extract_rejects_non_pdf_mime_even_with_104_sop(sample_ctx_dicom):
    """Defensive: a DICOM tagged as Encapsulated Document SOP but with a
    non-PDF MIME type (e.g. CDA/STL) must NOT be treated as a PDF —
    the extractor returns None so callers don't ship CDA bytes labelled
    application/pdf to the patient's browser."""
    ctx = pydicom.dcmread(sample_ctx_dicom)
    # Hand-craft a fake 104.x with non-PDF mime
    from pydicom.dataset import Dataset, FileDataset
    from pydicom.uid import ExplicitVRLittleEndian

    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.104.1"
    file_meta.MediaStorageSOPInstanceUID = "2.25.99999"
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = "1.2.826.0.1.3680043.8.498.1"

    ds = FileDataset("fake.dcm", {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.104.1"
    ds.SOPInstanceUID = "2.25.99999"
    ds.PatientName = ctx.PatientName
    ds.PatientID = ctx.PatientID
    ds.StudyInstanceUID = ctx.StudyInstanceUID
    ds.SeriesInstanceUID = "2.25.99999.1"
    ds.Modality = "DOC"
    ds.MIMETypeOfEncapsulatedDocument = "application/dicom+xml"
    ds.EncapsulatedDocument = b"<?xml version='1.0'?><foo/>"

    buf = BytesIO()
    ds.save_as(buf, write_like_original=False)

    assert extract_pdf_from_dicom(buf.getvalue()) is None
