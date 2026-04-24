import asyncio
import logging as _logging
from typing import AsyncIterator

import httpx
from app.config import settings
from app.services import cache

_client: httpx.AsyncClient | None = None

# Fresh-window for QIDO cache. Redis (when present) keeps the entry for up to
# STALE_TTL_SECONDS beyond this so transient Orthanc stalls don't 502 the UI.
# 30s is long enough to collapse a workroom's concurrent worklist refreshes
# and short enough that a manually-refreshed study is visible within one tick.
_STUDIES_FRESH_TTL = 30.0
_PATIENTS_FRESH_TTL = 30.0


_log = _logging.getLogger(__name__)


async def invalidate_study_caches() -> None:
    """Call when studies change (C-STORE received, study deleted) to bust caches."""
    await cache.invalidate_namespace("studies", "patients")


async def init_client():
    global _client
    # Larger pool + long keep-alive: /tools/find, /statistics, and
    # per-series fetches can fire in parallel at peak; defaults (10/5)
    # were bottlenecking burst traffic.
    _client = httpx.AsyncClient(
        base_url=settings.orthanc_url,
        auth=(settings.orthanc_username, settings.orthanc_password),
        timeout=httpx.Timeout(30.0, connect=5.0),
        # Raised from 40/20 — dashboard aggregate + OHIF metadata bursts can
        # easily saturate the smaller pool; 100/50 sits well under Orthanc's
        # HttpThreadsCount=50 upper bound.
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=50, keepalive_expiry=60),
    )
    # Prewarm: open one keepalive connection + BasicAuth handshake so the
    # first user request doesn't pay TCP+auth setup (~50-150ms saved on cold).
    try:
        await _client.get("/system", timeout=5.0)
    except Exception as exc:
        _log.warning("Orthanc prewarm GET /system failed: %s (continuing)", exc)


async def close_client():
    global _client
    if _client:
        await _client.aclose()
        _client = None


def _http() -> httpx.AsyncClient:
    assert _client is not None, "Orthanc client not initialized — call init_client() in lifespan"
    return _client


async def find_patients(search: str = "", limit: int = 25, offset: int = 0):
    """Server-side patient search and pagination via Orthanc /tools/find."""
    key = ("p", search, limit, offset)
    hit = await cache.get("patients", key, _PATIENTS_FRESH_TTL)
    if hit is not None and hit[1]:
        return tuple(hit[0])

    query = {}
    if search:
        query["PatientName"] = f"*{search}*"
    try:
        resp = await _http().post("/tools/find", json={
            "Level": "Patient",
            "Query": query,
            "Expand": True,
            "Limit": limit,
            "Since": offset,
        })
        resp.raise_for_status()
        items = resp.json()
    except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
        # Stale-while-error: if Orthanc is slow or timing out, return the last
        # known good cache entry for this key (past TTL) so the UI keeps
        # rendering rows instead of flashing a 502.
        if hit is not None:
            _log.warning("find_patients: serving stale cache (Orthanc error: %s)", exc)
            return tuple(hit[0])
        raise Exception(f"PACS server unreachable: {exc}") from exc

    filter_key = ("p_total", search)
    total: int | None = None
    if offset == 0 and len(items) < limit:
        total = len(items)
    else:
        total_hit = await cache.get("patients", filter_key, _PATIENTS_FRESH_TTL)
        if total_hit is not None and total_hit[1]:
            total = int(total_hit[0])
    if total is None:
        try:
            count_resp = await _http().post("/tools/find", json={
                "Level": "Patient",
                "Query": query,
                "Expand": False,
            })
            count_resp.raise_for_status()
            total = len(count_resp.json())
        except Exception:
            total = offset + len(items)
    await cache.set("patients", filter_key, total)
    await cache.set("patients", key, [items, total])
    return items, total


async def find_studies(search: str = "", modality: str = "", date_from: str = "", date_to: str = "", limit: int = 25, offset: int = 0):
    """Server-side study search and pagination via Orthanc /tools/find."""
    key = (search, modality, date_from, date_to, limit, offset)
    hit = await cache.get("studies", key, _STUDIES_FRESH_TTL)
    if hit is not None and hit[1]:
        return tuple(hit[0])

    query = {}
    if search:
        query["PatientName"] = f"*{search}*"
    if modality:
        query["ModalitiesInStudy"] = modality.split(",")[0].strip()
    if date_from and date_to:
        query["StudyDate"] = f"{date_from}-{date_to}"
    elif date_from:
        query["StudyDate"] = f"{date_from}-"
    elif date_to:
        query["StudyDate"] = f"-{date_to}"

    # RequestedTags tells Orthanc to compute ModalitiesInStudy server-side (aggregated from
    # child series) so we do NOT need N+1 per-series follow-up fetches in _enrich_*.
    try:
        resp = await _http().post("/tools/find", json={
            "Level": "Study",
            "Query": query,
            "Expand": True,
            "RequestedTags": ["ModalitiesInStudy"],
            "Limit": limit,
            "Since": offset,
        })
        resp.raise_for_status()
        items = resp.json()
    except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
        # Stale-while-error — same rationale as find_patients: never 502 the UI.
        if hit is not None:
            _log.warning("find_studies: serving stale cache (Orthanc error: %s)", exc)
            return tuple(hit[0])
        raise Exception(f"PACS server unreachable: {exc}") from exc

    filter_key = ("s_total", search, modality, date_from, date_to)
    total: int | None = None
    if offset == 0 and len(items) < limit:
        total = len(items)
    else:
        total_hit = await cache.get("studies", filter_key, _STUDIES_FRESH_TTL)
        if total_hit is not None and total_hit[1]:
            total = int(total_hit[0])
    if total is None:
        try:
            count_resp = await _http().post("/tools/find", json={
                "Level": "Study",
                "Query": query,
                "Expand": False,
            })
            count_resp.raise_for_status()
            total = len(count_resp.json())
        except Exception:
            total = offset + len(items)
    await cache.set("studies", filter_key, total)

    items = _propagate_modalities(items)
    await cache.set("studies", key, [items, total])
    return items, total


async def get_patients(limit: int | None = None, since: int | None = None):
    params = {"expand": ""}
    if limit is not None:
        params["limit"] = str(limit)
    if since is not None:
        params["since"] = str(since)
    try:
        resp = await _http().get("/patients", params=params)
        resp.raise_for_status()
        return resp.json()
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise Exception(f"PACS server unreachable: {exc}") from exc


async def get_patient(patient_id: str):
    resp = await _http().get(f"/patients/{patient_id}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


async def get_patient_studies(patient_id: str):
    """All studies for a patient — scoped /tools/find, no N+1, no truncation.

    Uses the patient's real DICOM PatientID tag to scope the search inside
    Orthanc, so LimitFindResults (which caps global queries at 1000) cannot
    hide later studies for patients with deep histories.

    On Orthanc timeout/error we return the empty list and let the caller keep
    serving the patient record. Better to show "0 studies, try again" than to
    500 the whole patient-detail page.
    """
    patient = await get_patient(patient_id)
    if patient is None:
        return []
    dicom_patient_id = (patient.get("MainDicomTags") or {}).get("PatientID")

    if dicom_patient_id:
        try:
            resp = await _http().post("/tools/find", json={
                "Level": "Study",
                "Query": {"PatientID": dicom_patient_id},
                "Expand": True,
                "RequestedTags": ["ModalitiesInStudy"],
            })
            resp.raise_for_status()
            studies = resp.json()
        except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
            _log.warning("get_patient_studies: Orthanc error for %s — returning []: %s", patient_id, exc)
            studies = []
    else:
        # Fallback: fetch each study individually via the parent patient's Studies[].
        # Still bounded by the patient's own study count, no global cap involved.
        study_ids = patient.get("Studies", [])

        async def fetch(sid: str):
            r = await _http().get(f"/studies/{sid}")
            r.raise_for_status()
            return r.json()

        try:
            studies = list(await asyncio.gather(*[fetch(sid) for sid in study_ids]))
        except Exception as exc:
            _log.warning("get_patient_studies fallback: Orthanc error for %s — returning []: %s", patient_id, exc)
            studies = []

    return _propagate_modalities(studies)


def _propagate_modalities(studies: list) -> list:
    """Copy ModalitiesInStudy from Orthanc-aggregated RequestedTags into MainDicomTags.

    Upstream /tools/find with RequestedTags=['ModalitiesInStudy'] returns the value
    under study['RequestedTags']; frontend reads from MainDicomTags. This is a cheap
    in-memory propagation — no HTTP calls, no N+1.
    """
    for study in studies:
        tags = study.setdefault("MainDicomTags", {})
        if tags.get("ModalitiesInStudy"):
            continue
        mod = (study.get("RequestedTags") or {}).get("ModalitiesInStudy")
        if mod:
            tags["ModalitiesInStudy"] = mod
    return studies


async def get_studies(limit: int | None = None, since: int | None = None):
    """List studies via /tools/find so we can request ModalitiesInStudy in one shot."""
    body = {
        "Level": "Study",
        "Query": {},
        "Expand": True,
        "RequestedTags": ["ModalitiesInStudy"],
    }
    if limit is not None:
        body["Limit"] = int(limit)
    if since is not None:
        body["Since"] = int(since)
    try:
        resp = await _http().post("/tools/find", json=body)
        resp.raise_for_status()
        return _propagate_modalities(resp.json())
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise Exception(f"PACS server unreachable: {exc}") from exc


async def get_study(study_id: str):
    resp = await _http().get(f"/studies/{study_id}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


async def get_study_series(study_id: str):
    """All series of a study — ONE call, no N+1.

    Benchmarked against the 11-series MR study Timur opened:
      - N+1 (1 study + 11 parallel /series/{sid}): 14s visible to UI
      - /tools/find Level=Series ParentStudy Expand=True:    4.0s
      - GET /studies/{id}/series?expand:                     1.5s   ← winner

    Orthanc's native /studies/{id}/series endpoint walks the study's
    children server-side without the /tools/find query planner overhead,
    so it's the fastest shape for this exact need.
    """
    try:
        resp = await _http().get(f"/studies/{study_id}/series", params={"expand": ""})
        resp.raise_for_status()
        return resp.json()
    except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
        _log.warning("get_study_series: Orthanc error for %s — []: %s", study_id, exc)
        return []


async def get_series(series_id: str):
    resp = await _http().get(f"/series/{series_id}")
    resp.raise_for_status()
    return resp.json()


async def get_series_instances(series_id: str):
    """All instances of a series — ONE call via /series/{id}/instances?expand.

    Replaces the earlier N+1 (fetch series, then fan out per-instance /instances/{iid}
    in parallel — fine for small series, catastrophic for a 300-instance MR because
    Orthanc must answer 300 simultaneous index reads while also serving the user).
    Orthanc's native expand walks the children server-side in one round-trip.
    """
    resp = await _http().get(f"/series/{series_id}/instances", params={"expand": ""})
    resp.raise_for_status()
    return resp.json()


async def download_study_stream(study_id: str) -> AsyncIterator[bytes]:
    req = _http().build_request("GET", f"/studies/{study_id}/archive")
    resp = await _http().send(req, stream=True)
    resp.raise_for_status()
    try:
        async for chunk in resp.aiter_bytes(chunk_size=65536):
            yield chunk
    finally:
        await resp.aclose()


async def send_to_modality(modality_id: str, resource_ids: list[str], synchronous: bool = True):
    resp = await _http().post(
        f"/modalities/{modality_id}/store",
        json={"Resources": resource_ids, "Synchronous": synchronous},
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json()


async def echo_modality(modality_id: str) -> bool:
    try:
        resp = await _http().post(f"/modalities/{modality_id}/echo", timeout=10)
        return resp.status_code == 200
    except Exception:
        return False


async def register_modality(modality_id: str, aet: str, host: str, port: int):
    resp = await _http().put(
        f"/modalities/{modality_id}",
        json={"AET": aet, "Host": host, "Port": port},
    )
    resp.raise_for_status()


async def delete_modality(modality_id: str):
    resp = await _http().delete(f"/modalities/{modality_id}")
    resp.raise_for_status()
