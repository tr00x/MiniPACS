import asyncio
import time
from typing import AsyncIterator

import httpx
from app.config import settings

_client: httpx.AsyncClient | None = None

# Short-TTL in-memory cache for list endpoints.
# Worklist is read-heavy and many clients view the same window simultaneously;
# a few-seconds cache collapses bursts of identical requests into one Orthanc call.
_STUDIES_CACHE_TTL = 8.0
_studies_cache: dict[tuple, tuple[float, list, int]] = {}
_PATIENTS_CACHE_TTL = 8.0
_patients_cache: dict[tuple, tuple[float, list, int]] = {}
_STUDIES_CACHE_MAX = 32  # simple FIFO bound; small enough that lookup cost is trivial

# Per-filter total cache — avoids counting all studies again on every page flip.
# Keyed by filter tuple (no pagination params), so page 2/3/... all reuse the
# total computed on first page. TTL matches the studies_cache.
_studies_total_cache: dict[tuple, tuple[float, int]] = {}
_patients_total_cache: dict[tuple, tuple[float, int]] = {}


def _cache_get(cache: dict, key: tuple, ttl: float):
    hit = cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1:]
    return None


def _cache_get_stale(cache: dict, key: tuple):
    """Return whatever is in cache regardless of TTL — used as stale-while-error
    fallback so a transient Orthanc stall doesn't produce a 502 in the UI."""
    hit = cache.get(key)
    if hit:
        return hit[1:]
    return None


def _cache_put(cache: dict, key: tuple, *values):
    cache[key] = (time.time(),) + values
    if len(cache) > _STUDIES_CACHE_MAX:
        cache.pop(next(iter(cache)))


import logging as _logging
_log = _logging.getLogger(__name__)


def invalidate_study_caches():
    """Call when studies change (C-STORE received, study deleted) to bust caches."""
    _studies_cache.clear()
    _patients_cache.clear()
    _studies_total_cache.clear()
    _patients_total_cache.clear()


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
    cached = _cache_get(_patients_cache, key, _PATIENTS_CACHE_TTL)
    if cached is not None:
        return cached

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
        # rendering rows instead of flashing a 502. The prewarm cron will
        # restore live data on the next tick.
        stale = _cache_get_stale(_patients_cache, key)
        if stale is not None:
            _log.warning("find_patients: serving stale cache (Orthanc error: %s)", exc)
            return stale
        raise Exception(f"PACS server unreachable: {exc}") from exc

    filter_key = (search,)
    total: int | None = None
    if offset == 0 and len(items) < limit:
        total = len(items)
    else:
        hit = _patients_total_cache.get(filter_key)
        if hit and time.time() - hit[0] < _PATIENTS_CACHE_TTL:
            total = hit[1]
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
    _patients_total_cache[filter_key] = (time.time(), total)

    _cache_put(_patients_cache, key, items, total)
    return items, total


async def find_studies(search: str = "", modality: str = "", date_from: str = "", date_to: str = "", limit: int = 25, offset: int = 0):
    """Server-side study search and pagination via Orthanc /tools/find."""
    key = (search, modality, date_from, date_to, limit, offset)
    cached = _cache_get(_studies_cache, key, _STUDIES_CACHE_TTL)
    if cached is not None:
        return cached

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
        # Stale-while-error — same rationale as find_patients: never 502 the UI
        # just because Orthanc is briefly cold.
        stale = _cache_get_stale(_studies_cache, key)
        if stale is not None:
            _log.warning("find_studies: serving stale cache (Orthanc error: %s)", exc)
            return stale
        raise Exception(f"PACS server unreachable: {exc}") from exc

    # Total count — issued once per (filter) tuple and cached so subsequent
    # pages do not lie to the pagination UI. Only skipped when the first page
    # already contains everything.
    filter_key = (search, modality, date_from, date_to)
    total: int | None = None
    if offset == 0 and len(items) < limit:
        total = len(items)
    else:
        hit = _studies_total_cache.get(filter_key)
        if hit and time.time() - hit[0] < _STUDIES_CACHE_TTL:
            total = hit[1]
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
    _studies_total_cache[filter_key] = (time.time(), total)

    items = _propagate_modalities(items)
    _cache_put(_studies_cache, key, items, total)
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
    """Fetch all instances of a series in parallel (was sequential N+1)."""
    series = await get_series(series_id)
    instance_ids = series.get("Instances", [])

    async def fetch_instance(iid: str):
        r = await _http().get(f"/instances/{iid}")
        r.raise_for_status()
        return r.json()

    return list(await asyncio.gather(*[fetch_instance(iid) for iid in instance_ids]))


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
