"""Unit tests for app.services.pdf_encapsulator.encapsulate_pdf."""
from io import BytesIO

import pydicom

from app.services.pdf_encapsulator import encapsulate_pdf


def test_encapsulate_pdf_returns_valid_dicom_bytes(sample_pdf_bytes, sample_ctx_dicom):
    out_bytes = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)

    assert isinstance(out_bytes, bytes)
    assert len(out_bytes) > 128
    # Re-parse to confirm it's valid DICOM
    ds = pydicom.dcmread(BytesIO(out_bytes))
    assert ds.SOPClassUID == "1.2.840.10008.5.1.4.1.1.104.1"
    assert ds.Modality == "DOC"
    assert ds.MIMETypeOfEncapsulatedDocument == "application/pdf"
    assert bytes(ds.EncapsulatedDocument) == sample_pdf_bytes


def test_encapsulate_pdf_is_deterministic(sample_pdf_bytes, sample_ctx_dicom):
    a = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)
    b = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)

    ds_a = pydicom.dcmread(BytesIO(a))
    ds_b = pydicom.dcmread(BytesIO(b))

    assert ds_a.SOPInstanceUID == ds_b.SOPInstanceUID
    assert ds_a.SeriesInstanceUID == ds_b.SeriesInstanceUID


def test_encapsulate_pdf_copies_patient_and_study_tags(sample_pdf_bytes, sample_ctx_dicom):
    out = encapsulate_pdf(sample_pdf_bytes, sample_ctx_dicom)
    ds_out = pydicom.dcmread(BytesIO(out))
    ds_ctx = pydicom.dcmread(sample_ctx_dicom)

    assert ds_out.PatientName == ds_ctx.PatientName
    assert ds_out.PatientID == ds_ctx.PatientID
    assert ds_out.PatientBirthDate == ds_ctx.PatientBirthDate
    assert ds_out.PatientSex == ds_ctx.PatientSex
    assert ds_out.StudyInstanceUID == ds_ctx.StudyInstanceUID
    assert ds_out.StudyID == ds_ctx.StudyID
    assert ds_out.StudyDate == ds_ctx.StudyDate
    # Series and SOP should be NEW
    assert ds_out.SeriesInstanceUID != ds_ctx.SeriesInstanceUID
    assert ds_out.SOPInstanceUID != ds_ctx.SOPInstanceUID
