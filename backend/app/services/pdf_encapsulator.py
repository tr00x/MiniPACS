"""Build Encapsulated-PDF DICOM bytes (SOP 1.2.840.10008.5.1.4.1.1.104.1).

The output is anchored to an existing StudyInstanceUID by copying Patient/Study
tags from a context DICOM file on the same media. UIDs for the new instance
are deterministic (hash-derived) so re-running the same input is a no-op in
Orthanc — which dedups by SOPInstanceUID.
"""
from __future__ import annotations

import hashlib
from datetime import datetime
from io import BytesIO
from pathlib import Path

import pydicom
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import ExplicitVRLittleEndian


_ENCAPSULATED_PDF_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.104.1"


def _det_uid(*parts: str) -> str:
    """Deterministic OID-style UID rooted at 2.25 (RFC 4122-derived integer).

    Same inputs → same UID. Used so retried POSTs hit Orthanc dedup.
    """
    h = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return "2.25." + str(int.from_bytes(h[:16], "big"))


def encapsulate_pdf(
    pdf_bytes: bytes,
    ctx_dicom_path: Path,
    document_title: str = "Radiology Report",
) -> bytes:
    """Build an Encapsulated-PDF DICOM file as bytes.

    Args:
        pdf_bytes: Raw PDF file contents.
        ctx_dicom_path: Any DICOM file from the same study (Patient/Study tags
            are copied from it; pixel data is not read).
        document_title: Free text for (0042,0010) DocumentTitle.

    Returns:
        Serialized DICOM bytes ready for POST to Orthanc /instances.
    """
    ctx = pydicom.dcmread(ctx_dicom_path, stop_before_pixels=True)

    study_uid = str(ctx.StudyInstanceUID)
    pdf_sha = hashlib.sha256(pdf_bytes).hexdigest()

    sop_instance_uid = _det_uid(study_uid, pdf_sha)
    series_instance_uid = _det_uid(study_uid, "PDF_REPORT_SERIES")

    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = _ENCAPSULATED_PDF_SOP_CLASS
    file_meta.MediaStorageSOPInstanceUID = sop_instance_uid
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = "1.2.826.0.1.3680043.8.498.1"
    file_meta.ImplementationVersionName = "MINIPACS_PDF_ENCAP"

    ds = FileDataset("encap.dcm", {}, file_meta=file_meta, preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    ds.SOPClassUID = _ENCAPSULATED_PDF_SOP_CLASS
    ds.SOPInstanceUID = sop_instance_uid

    # Patient (copy)
    ds.PatientName = ctx.get("PatientName", "")
    ds.PatientID = ctx.get("PatientID", "")
    if "PatientBirthDate" in ctx:
        ds.PatientBirthDate = ctx.PatientBirthDate
    if "PatientSex" in ctx:
        ds.PatientSex = ctx.PatientSex

    # Study (copy — anchor)
    ds.StudyInstanceUID = study_uid
    ds.StudyID = ctx.get("StudyID", "")
    if "StudyDate" in ctx:
        ds.StudyDate = ctx.StudyDate
    if "StudyTime" in ctx:
        ds.StudyTime = ctx.StudyTime
    if "AccessionNumber" in ctx:
        ds.AccessionNumber = ctx.AccessionNumber
    if "ReferringPhysicianName" in ctx:
        ds.ReferringPhysicianName = ctx.ReferringPhysicianName

    # Series (new — encapsulated PDF)
    ds.SeriesInstanceUID = series_instance_uid
    ds.SeriesNumber = "9999"
    ds.Modality = "DOC"
    ds.SeriesDescription = document_title

    # Content
    now = datetime.utcnow()
    ds.ContentDate = now.strftime("%Y%m%d")
    ds.ContentTime = now.strftime("%H%M%S")
    ds.ConversionType = "WSD"  # Workstation
    ds.BurnedInAnnotation = "NO"

    # Encapsulated document
    ds.DocumentTitle = document_title
    ds.MIMETypeOfEncapsulatedDocument = "application/pdf"
    ds.EncapsulatedDocument = pdf_bytes

    buf = BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()
