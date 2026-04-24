"""Incoming DICOM studies — on-the-fly view of C-STORE SCP receipts.

Orthanc persists RemoteAET/RemoteIP/Origin/ReceptionDate as per-instance
metadata. Three bulk-content calls give us the full picture without any
per-study fan-out:

  1) POST /tools/find Level=Study OrderBy=LastUpdate DESC
  2) POST /tools/bulk-content Level=Series Expand=True   (resolves Study→first series→Instances)
  3) POST /tools/bulk-content Level=Instance Metadata=True (one instance per study, full metadata)

Origin=DicomProtocol filter keeps REST-API uploads (import tool, STOW-RS)
out so only peer-to-peer DICOM C-STOREs show up. A 60s in-proc cache
makes repeat-loads trivial.
"""

import time
from fastapi import APIRouter, Depends, Query, Request

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/received", tags=["received"])

_CACHE_TTL = 60.0
_cache: dict[int, tuple[float, dict]] = {}


@router.get("")
async def list_received(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    user: dict = Depends(get_current_user),
):
    await log_audit("list_received", user_id=user["id"], ip_address=request.client.host)

    cached = _cache.get(limit)
    if cached and time.time() - cached[0] < _CACHE_TTL:
        return cached[1]

    http = orthanc._http()
    empty = {"items": [], "total": 0}

    # --- 1) Most-recent studies with full tags in one call.
    # 2× buffer so that Origin filtering (step 4) still leaves ~limit rows.
    try:
        r = await http.post("/tools/find", json={
            "Level": "Study",
            "Query": {},
            "Expand": True,
            "OrderBy": [{"Type": "Metadata", "Key": "LastUpdate", "Direction": "DESC"}],
            "Limit": limit * 2,
            "RequestedTags": ["ModalitiesInStudy"],
        })
        r.raise_for_status()
        studies = r.json()
    except Exception:
        return empty
    if not studies:
        _cache[limit] = (time.time(), empty)
        return empty

    # --- 2) Bulk-expand first Series of every study to reach Instances.
    first_series_ids = [
        s["Series"][0] for s in studies if s.get("Series")
    ]
    if not first_series_ids:
        _cache[limit] = (time.time(), empty)
        return empty
    try:
        r = await http.post("/tools/bulk-content", json={
            "Level": "Series",
            "Resources": first_series_ids,
            "Expand": True,
        })
        r.raise_for_status()
        series_data = r.json()
    except Exception:
        return empty

    # series_id → first instance id
    inst_by_series: dict[str, str] = {}
    for s in series_data:
        sid = s.get("ID")
        insts = s.get("Instances") or []
        if sid and insts:
            inst_by_series[sid] = insts[0]

    # study_id → first instance id (via first series)
    study_to_inst: dict[str, str] = {}
    for s in studies:
        series = s.get("Series") or []
        if not series:
            continue
        iid = inst_by_series.get(series[0])
        if iid:
            study_to_inst[s["ID"]] = iid
    if not study_to_inst:
        _cache[limit] = (time.time(), empty)
        return empty

    # --- 3) Bulk-fetch metadata for all picked instances in one call.
    try:
        r = await http.post("/tools/bulk-content", json={
            "Level": "Instance",
            "Resources": list(study_to_inst.values()),
            "Metadata": True,
        })
        r.raise_for_status()
        bulk_instances = r.json()
    except Exception:
        return empty

    meta_by_inst: dict[str, dict] = {
        e.get("ID"): (e.get("Metadata") or {})
        for e in bulk_instances
        if e.get("ID")
    }

    # --- 4) Stitch + filter to DICOM-protocol origins only.
    items: list[dict] = []
    for s in studies:
        sid = s["ID"]
        iid = study_to_inst.get(sid)
        if not iid:
            continue
        meta = meta_by_inst.get(iid, {})
        if meta.get("Origin") != "DicomProtocol":
            continue
        tags = s.get("MainDicomTags", {}) or {}
        ptags = s.get("PatientMainDicomTags", {}) or {}
        req = s.get("RequestedTags", {}) or {}
        items.append({
            "study_id": sid,
            "patient_id": s.get("ParentPatient"),
            "patient_name": ptags.get("PatientName", ""),
            "patient_dicom_id": ptags.get("PatientID", ""),
            "study_description": tags.get("StudyDescription", ""),
            "study_date": tags.get("StudyDate", ""),
            "accession_number": tags.get("AccessionNumber", ""),
            "modalities": req.get("ModalitiesInStudy", "") or tags.get("ModalitiesInStudy", ""),
            "sender_aet": meta.get("RemoteAET", ""),
            "sender_ip": meta.get("RemoteIP", ""),
            "called_aet": meta.get("CalledAET", ""),
            "transfer_syntax": meta.get("TransferSyntax", ""),
            "received_at": meta.get("ReceptionDate", ""),
        })
        if len(items) >= limit:
            break

    items.sort(key=lambda x: x["received_at"], reverse=True)

    result = {"items": items, "total": len(items)}
    _cache[limit] = (time.time(), result)
    return result
