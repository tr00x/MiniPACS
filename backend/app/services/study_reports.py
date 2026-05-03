"""Collect Encapsulated-PDF reports embedded in a study.

Powers GET /studies/{id}/reports — patients click "Download Report" in
the UI, the endpoint walks the study's DOC-modality series, fetches each
encapsulated PDF instance, and returns the raw PDF bytes (or a ZIP of
them).

DOC-modality filter is the cheap pre-filter — fetching the raw bytes
of an MR/CT instance just to discover it isn't a PDF would pull
megabytes per study. We rely on encapsulate_pdf always tagging
Modality=DOC when shipping a report (see pdf_encapsulator.py).
"""
from __future__ import annotations

import asyncio
import logging

from app.services import orthanc
from app.services.orthanc import get_instance_file
from app.services.pdf_extractor import extract_pdf_from_dicom

_log = logging.getLogger(__name__)


async def collect_study_pdf_reports(study_id: str) -> list[bytes]:
    """Return raw PDF bytes for every Encapsulated-PDF instance in `study_id`,
    sorted by SOPInstanceUID for stable output order. Empty list if none."""
    series = await orthanc.get_study_series(study_id)
    doc_series_ids = [
        s["ID"]
        for s in series
        if (s.get("MainDicomTags") or {}).get("Modality") == "DOC"
    ]
    if not doc_series_ids:
        return []

    instance_lists = await asyncio.gather(
        *(orthanc.get_series_instances(sid) for sid in doc_series_ids),
        return_exceptions=True,
    )
    instance_ids: list[str] = []
    for entry in instance_lists:
        if isinstance(entry, Exception):
            _log.warning("collect_study_pdf_reports: series fetch failed: %s", entry)
            continue
        for inst in entry:
            iid = inst.get("ID") if isinstance(inst, dict) else None
            if iid:
                instance_ids.append(iid)

    if not instance_ids:
        return []

    file_results = await asyncio.gather(
        *(get_instance_file(iid) for iid in instance_ids),
        return_exceptions=True,
    )
    pdfs: list[bytes] = []
    for iid, data in zip(instance_ids, file_results):
        if isinstance(data, Exception):
            _log.warning("collect_study_pdf_reports: instance %s fetch failed: %s", iid, data)
            continue
        pdf = extract_pdf_from_dicom(data)
        if pdf is not None:
            pdfs.append(pdf)
    return pdfs
