#!/usr/bin/env python3
"""
Seed Orthanc with realistic demo DICOM data.
Downloads public datasets and uploads to Orthanc with proper clinic metadata.
"""
import asyncio
import io
import zipfile
from pathlib import Path

import os

import httpx
import pydicom
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import generate_uid, ExplicitVRLittleEndian
from pydicom.sequence import Sequence
import numpy as np

# Load from .env file if present
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://127.0.0.1:48923")
ORTHANC_AUTH = (
    os.environ.get("ORTHANC_USERNAME", "orthanc"),
    os.environ.get("ORTHANC_PASSWORD", "orthanc"),
)
CLINIC_NAME = "Clinton Medical"

# Realistic patient data for a US solo clinic
PATIENTS = [
    {"name": "SMITH^JOHN^A", "id": "MRN-10042", "dob": "19680315", "sex": "M"},
    {"name": "JOHNSON^EMILY^R", "id": "MRN-10078", "dob": "19820722", "sex": "F"},
    {"name": "WILLIAMS^ROBERT^J", "id": "MRN-10103", "dob": "19550901", "sex": "M"},
    {"name": "BROWN^SARAH^L", "id": "MRN-10156", "dob": "19910214", "sex": "F"},
    {"name": "DAVIS^MICHAEL^T", "id": "MRN-10201", "dob": "19750608", "sex": "M"},
    {"name": "GARCIA^MARIA^C", "id": "MRN-10245", "dob": "19880430", "sex": "F"},
    {"name": "MILLER^JAMES^W", "id": "MRN-10289", "dob": "19620117", "sex": "M"},
    {"name": "WILSON^JENNIFER^A", "id": "MRN-10334", "dob": "19950810", "sex": "F"},
    {"name": "MARTINEZ^CARLOS^D", "id": "MRN-10378", "dob": "19710923", "sex": "M"},
    {"name": "ANDERSON^PATRICIA^M", "id": "MRN-10412", "dob": "19840506", "sex": "F"},
    {"name": "TAYLOR^DAVID^R", "id": "MRN-10456", "dob": "19580212", "sex": "M"},
    {"name": "THOMAS^LISA^K", "id": "MRN-10501", "dob": "19790725", "sex": "F"},
]

# Realistic studies for a solo clinic with imaging equipment
STUDIES = [
    # Patient 0 - John Smith, 57yo M — multiple visits
    {"patient": 0, "date": "20260108", "time": "091500", "desc": "CT CHEST W CONTRAST", "accession": "ACC-2026-0042", "ref_phys": "DR CHEN^WILLIAM", "modality": "CT", "series": [
        {"desc": "Scout", "num": "1", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 2},
        {"desc": "Axial 5mm", "num": "2", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 4},
        {"desc": "Coronal MPR", "num": "3", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 3},
    ]},
    {"patient": 0, "date": "20260305", "time": "143000", "desc": "XRAY CHEST PA AND LAT", "accession": "ACC-2026-0198", "ref_phys": "DR CHEN^WILLIAM", "modality": "CR", "series": [
        {"desc": "PA View", "num": "1", "mod": "CR", "body": "CHEST", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
        {"desc": "Lateral View", "num": "2", "mod": "CR", "body": "CHEST", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
    ]},
    # Patient 1 - Emily Johnson, 43yo F
    {"patient": 1, "date": "20260215", "time": "100000", "desc": "MRI BRAIN WO CONTRAST", "accession": "ACC-2026-0105", "ref_phys": "DR PATEL^ANITA", "modality": "MR", "series": [
        {"desc": "T1 Sagittal", "num": "1", "mod": "MR", "body": "HEAD", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
        {"desc": "T2 Axial", "num": "2", "mod": "MR", "body": "HEAD", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
        {"desc": "FLAIR Axial", "num": "3", "mod": "MR", "body": "HEAD", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
        {"desc": "DWI", "num": "4", "mod": "MR", "body": "HEAD", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 2},
    ]},
    # Patient 2 - Robert Williams, 70yo M
    {"patient": 2, "date": "20260112", "time": "083000", "desc": "CT ABDOMEN PELVIS W CONTRAST", "accession": "ACC-2026-0056", "ref_phys": "DR KIM^SUSAN", "modality": "CT", "series": [
        {"desc": "Scout", "num": "1", "mod": "CT", "body": "ABDOMEN", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 2},
        {"desc": "Axial 3mm Arterial", "num": "2", "mod": "CT", "body": "ABDOMEN", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 5},
        {"desc": "Axial 3mm Venous", "num": "3", "mod": "CT", "body": "ABDOMEN", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 5},
        {"desc": "Coronal MPR", "num": "4", "mod": "CT", "body": "ABDOMEN", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 3},
    ]},
    {"patient": 2, "date": "20260320", "time": "110000", "desc": "XRAY LUMBAR SPINE AP LAT", "accession": "ACC-2026-0234", "ref_phys": "DR KIM^SUSAN", "modality": "CR", "series": [
        {"desc": "AP View", "num": "1", "mod": "CR", "body": "LSPINE", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
        {"desc": "Lateral View", "num": "2", "mod": "CR", "body": "LSPINE", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
    ]},
    # Patient 3 - Sarah Brown, 34yo F
    {"patient": 3, "date": "20260401", "time": "140000", "desc": "US ABDOMEN COMPLETE", "accession": "ACC-2026-0301", "ref_phys": "DR CHEN^WILLIAM", "modality": "US", "series": [
        {"desc": "Liver", "num": "1", "mod": "US", "body": "ABDOMEN", "mfr": "Philips", "model": "EPIQ 7", "images": 3},
        {"desc": "Gallbladder", "num": "2", "mod": "US", "body": "ABDOMEN", "mfr": "Philips", "model": "EPIQ 7", "images": 2},
        {"desc": "Kidneys", "num": "3", "mod": "US", "body": "ABDOMEN", "mfr": "Philips", "model": "EPIQ 7", "images": 2},
    ]},
    # Patient 4 - Michael Davis, 50yo M
    {"patient": 4, "date": "20260225", "time": "093000", "desc": "CT HEAD WO CONTRAST", "accession": "ACC-2026-0167", "ref_phys": "DR PATEL^ANITA", "modality": "CT", "series": [
        {"desc": "Axial 5mm", "num": "1", "mod": "CT", "body": "HEAD", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 4},
        {"desc": "Bone Window", "num": "2", "mod": "CT", "body": "HEAD", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 4},
    ]},
    {"patient": 4, "date": "20260403", "time": "160000", "desc": "XRAY KNEE RIGHT 3 VIEWS", "accession": "ACC-2026-0312", "ref_phys": "DR LOPEZ^RICARDO", "modality": "CR", "series": [
        {"desc": "AP View", "num": "1", "mod": "CR", "body": "KNEE", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
        {"desc": "Lateral View", "num": "2", "mod": "CR", "body": "KNEE", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
        {"desc": "Sunrise View", "num": "3", "mod": "CR", "body": "KNEE", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
    ]},
    # Patient 5 - Maria Garcia, 37yo F
    {"patient": 5, "date": "20260318", "time": "111500", "desc": "MRI KNEE LEFT WO CONTRAST", "accession": "ACC-2026-0221", "ref_phys": "DR LOPEZ^RICARDO", "modality": "MR", "series": [
        {"desc": "Sagittal PD", "num": "1", "mod": "MR", "body": "KNEE", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
        {"desc": "Coronal T2 FS", "num": "2", "mod": "MR", "body": "KNEE", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
        {"desc": "Axial PD FS", "num": "3", "mod": "MR", "body": "KNEE", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
    ]},
    # Patient 6 - James Miller, 63yo M
    {"patient": 6, "date": "20260128", "time": "080000", "desc": "CT CHEST ABDOMEN PELVIS W CONTRAST", "accession": "ACC-2026-0082", "ref_phys": "DR CHEN^WILLIAM", "modality": "CT", "series": [
        {"desc": "Scout", "num": "1", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 2},
        {"desc": "Axial Chest 5mm", "num": "2", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 5},
        {"desc": "Axial Abdomen 3mm", "num": "3", "mod": "CT", "body": "ABDOMEN", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 5},
        {"desc": "Coronal MPR", "num": "4", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 4},
        {"desc": "Sagittal MPR", "num": "5", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 3},
    ]},
    # Patient 7 - Jennifer Wilson, 30yo F
    {"patient": 7, "date": "20260405", "time": "145000", "desc": "US PELVIS TRANSVAGINAL", "accession": "ACC-2026-0328", "ref_phys": "DR PATEL^ANITA", "modality": "US", "series": [
        {"desc": "Uterus", "num": "1", "mod": "US", "body": "PELVIS", "mfr": "Philips", "model": "EPIQ 7", "images": 3},
        {"desc": "Ovaries", "num": "2", "mod": "US", "body": "PELVIS", "mfr": "Philips", "model": "EPIQ 7", "images": 2},
    ]},
    # Patient 8 - Carlos Martinez, 54yo M
    {"patient": 8, "date": "20260202", "time": "090000", "desc": "XRAY CHEST PA", "accession": "ACC-2026-0098", "ref_phys": "DR CHEN^WILLIAM", "modality": "CR", "series": [
        {"desc": "PA View", "num": "1", "mod": "CR", "body": "CHEST", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
    ]},
    {"patient": 8, "date": "20260408", "time": "103000", "desc": "CT CHEST LOW DOSE LUNG SCREENING", "accession": "ACC-2026-0345", "ref_phys": "DR CHEN^WILLIAM", "modality": "CT", "series": [
        {"desc": "Scout", "num": "1", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 1},
        {"desc": "Axial 1mm", "num": "2", "mod": "CT", "body": "CHEST", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 6},
    ]},
    # Patient 9 - Patricia Anderson, 41yo F
    {"patient": 9, "date": "20260310", "time": "133000", "desc": "MRI LUMBAR SPINE WO CONTRAST", "accession": "ACC-2026-0210", "ref_phys": "DR LOPEZ^RICARDO", "modality": "MR", "series": [
        {"desc": "Sagittal T1", "num": "1", "mod": "MR", "body": "LSPINE", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
        {"desc": "Sagittal T2", "num": "2", "mod": "MR", "body": "LSPINE", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
        {"desc": "Axial T2", "num": "3", "mod": "MR", "body": "LSPINE", "mfr": "Siemens Healthineers", "model": "MAGNETOM Vida", "images": 3},
    ]},
    # Patient 10 - David Taylor, 67yo M
    {"patient": 10, "date": "20260115", "time": "074500", "desc": "XRAY HIP RIGHT 2 VIEWS", "accession": "ACC-2026-0065", "ref_phys": "DR LOPEZ^RICARDO", "modality": "CR", "series": [
        {"desc": "AP View", "num": "1", "mod": "CR", "body": "HIP", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
        {"desc": "Frog Leg Lateral", "num": "2", "mod": "CR", "body": "HIP", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
    ]},
    {"patient": 10, "date": "20260322", "time": "091500", "desc": "CT HIP RIGHT W WO CONTRAST", "accession": "ACC-2026-0242", "ref_phys": "DR LOPEZ^RICARDO", "modality": "CT", "series": [
        {"desc": "Scout", "num": "1", "mod": "CT", "body": "HIP", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 1},
        {"desc": "Axial Pre-contrast", "num": "2", "mod": "CT", "body": "HIP", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 3},
        {"desc": "Axial Post-contrast", "num": "3", "mod": "CT", "body": "HIP", "mfr": "GE Medical Systems", "model": "Revolution CT", "images": 3},
    ]},
    # Patient 11 - Lisa Thomas, 46yo F
    {"patient": 11, "date": "20260407", "time": "120000", "desc": "US BREAST BILATERAL", "accession": "ACC-2026-0338", "ref_phys": "DR PATEL^ANITA", "modality": "US", "series": [
        {"desc": "Right Breast", "num": "1", "mod": "US", "body": "BREAST", "mfr": "Philips", "model": "EPIQ 7", "images": 3},
        {"desc": "Left Breast", "num": "2", "mod": "US", "body": "BREAST", "mfr": "Philips", "model": "EPIQ 7", "images": 3},
    ]},
    {"patient": 11, "date": "20260410", "time": "141500", "desc": "XRAY SHOULDER LEFT 3 VIEWS", "accession": "ACC-2026-0356", "ref_phys": "DR LOPEZ^RICARDO", "modality": "CR", "series": [
        {"desc": "AP Internal Rotation", "num": "1", "mod": "CR", "body": "SHOULDER", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
        {"desc": "AP External Rotation", "num": "2", "mod": "CR", "body": "SHOULDER", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
        {"desc": "Scapular Y View", "num": "3", "mod": "CR", "body": "SHOULDER", "mfr": "Fujifilm", "model": "FDR D-EVO II", "images": 1},
    ]},
]


def create_dicom_image(patient: dict, study: dict, series_info: dict, instance_num: int, study_uid: str, series_uid: str) -> bytes:
    """Create a synthetic DICOM image with realistic metadata."""
    ds = Dataset()
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    # Patient
    ds.PatientName = patient["name"]
    ds.PatientID = patient["id"]
    ds.PatientBirthDate = patient["dob"]
    ds.PatientSex = patient["sex"]

    # Study
    ds.StudyDate = study["date"]
    ds.StudyTime = study["time"]
    ds.StudyDescription = study["desc"]
    ds.AccessionNumber = study["accession"]
    ds.ReferringPhysicianName = study["ref_phys"]
    ds.InstitutionName = CLINIC_NAME
    ds.StudyInstanceUID = study_uid
    ds.StudyID = study["accession"].split("-")[-1]

    # Series
    ds.SeriesDate = study["date"]
    ds.SeriesTime = study["time"]
    ds.SeriesDescription = series_info["desc"]
    ds.SeriesNumber = int(series_info["num"])
    ds.Modality = series_info["mod"]
    ds.BodyPartExamined = series_info["body"]
    ds.Manufacturer = series_info["mfr"]
    ds.ManufacturerModelName = series_info["model"]
    ds.SeriesInstanceUID = series_uid
    ds.StationName = "STATION01"
    ds.ProtocolName = series_info["desc"]
    ds.OperatorsName = "TECH^JOHNSON"

    # Instance
    ds.InstanceNumber = instance_num
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.2"  # CT Image Storage
    if series_info["mod"] == "MR":
        ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.4"  # MR Image Storage
    elif series_info["mod"] in ("CR", "DX"):
        ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.1"  # CR Image Storage
    elif series_info["mod"] == "US":
        ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.6.1"  # US Image Storage
    ds.SOPInstanceUID = generate_uid()
    ds.ImageType = ["DERIVED", "PRIMARY"]

    # Pixel data — small synthetic image
    rows, cols = 128, 128
    ds.Rows = rows
    ds.Columns = cols
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.RescaleIntercept = "0"
    ds.RescaleSlope = "1"
    ds.WindowCenter = "256"
    ds.WindowWidth = "128"
    ds.PixelSpacing = [1.0, 1.0]

    # Generate synthetic pixel data with some structure
    np.random.seed(hash(f"{study_uid}{series_uid}{instance_num}") % (2**31))
    pixels = np.random.randint(100, 400, (rows, cols), dtype=np.uint16)
    # Add some circular structures to look vaguely medical
    y, x = np.ogrid[-64:64, -64:64]
    mask = x*x + y*y < 50*50
    pixels[mask] += 200
    inner_mask = x*x + y*y < 30*30
    pixels[inner_mask] -= 100
    ds.PixelData = pixels.tobytes()

    # File meta
    file_meta = pydicom.dataset.FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = generate_uid()

    file_ds = FileDataset("", ds, file_meta=file_meta, preamble=b"\x00" * 128)
    file_ds.is_little_endian = True
    file_ds.is_implicit_VR = False

    buf = io.BytesIO()
    pydicom.dcmwrite(buf, file_ds)
    return buf.getvalue()


async def main():
    async with httpx.AsyncClient(base_url=ORTHANC_URL, auth=ORTHANC_AUTH, timeout=30) as client:
        # 1. Delete all existing data
        print("Clearing existing data...")
        patients = (await client.get("/patients")).json()
        for pid in patients:
            await client.delete(f"/patients/{pid}")
        print(f"  Deleted {len(patients)} patients")

        # 2. Generate and upload new data
        total_instances = 0
        for study_info in STUDIES:
            patient = PATIENTS[study_info["patient"]]
            study_uid = generate_uid()

            for series_info in study_info["series"]:
                series_uid = generate_uid()

                for img_num in range(1, series_info["images"] + 1):
                    dcm_bytes = create_dicom_image(
                        patient, study_info, series_info, img_num, study_uid, series_uid
                    )
                    resp = await client.post(
                        "/instances",
                        content=dcm_bytes,
                        headers={"Content-Type": "application/dicom"},
                    )
                    if resp.status_code == 200:
                        total_instances += 1
                    else:
                        print(f"  ERROR uploading: {resp.status_code} {resp.text}")

            print(f"  {patient['name']} — {study_info['desc']}")

        # 3. Summary
        stats = (await client.get("/statistics")).json()
        print(f"\nDone! Orthanc now has:")
        print(f"  {stats['CountPatients']} patients")
        print(f"  {stats['CountStudies']} studies")
        print(f"  {stats['CountSeries']} series")
        print(f"  {stats['CountInstances']} instances ({total_instances} uploaded)")


if __name__ == "__main__":
    asyncio.run(main())
