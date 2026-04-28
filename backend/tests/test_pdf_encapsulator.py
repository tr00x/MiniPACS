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
