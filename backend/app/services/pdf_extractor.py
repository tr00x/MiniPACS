"""Extract raw PDF bytes from an Encapsulated-PDF DICOM instance.

Inverse of pdf_encapsulator.encapsulate_pdf — used by:
  * iso_builder, to surface report-N.pdf at the disc root so patients
    can read the report without a DICOM viewer
  * /studies/{id}/reports endpoint, to ship the PDF to the browser
    as application/pdf

Defensive: returns None for anything that isn't an Encapsulated PDF
SOP (1.2.840.10008.5.1.4.1.1.104.1) AND tagged
MIMETypeOfEncapsulatedDocument == "application/pdf". This guards
against shipping CDA/STL/other encapsulated payloads as PDF.
"""
from __future__ import annotations

from io import BytesIO

import pydicom
from pydicom.dataset import Dataset


_ENCAPSULATED_PDF_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.104.1"
_PDF_MAGIC = b"%PDF-"


def is_encapsulated_pdf(ds: Dataset) -> bool:
    sop = str(getattr(ds, "SOPClassUID", "") or "")
    if sop != _ENCAPSULATED_PDF_SOP_CLASS:
        return False
    mime = str(getattr(ds, "MIMETypeOfEncapsulatedDocument", "") or "").lower()
    return mime == "application/pdf"


def extract_pdf_from_dicom(dcm_bytes: bytes) -> bytes | None:
    try:
        ds = pydicom.dcmread(BytesIO(dcm_bytes))
    except Exception:
        return None
    if not is_encapsulated_pdf(ds):
        return None
    payload = getattr(ds, "EncapsulatedDocument", None)
    if payload is None:
        return None
    raw = bytes(payload)
    # DICOM pads OB values to even length with a NUL — strip trailing NULs
    # to get the original PDF (PDFs always end with %%EOF + optional newline).
    raw = raw.rstrip(b"\x00")
    if not raw.startswith(_PDF_MAGIC):
        return None
    return raw
