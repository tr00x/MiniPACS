import asyncio
import logging as _logging
from typing import AsyncIterator

import httpx
from app.config import settings
from app.services import cache
from app.services.search_parser import parse_search

# Fields to fan out across when the user's search string has free-text tokens.
# Orthanc /tools/find ANDs keys within one Query dict, so to get OR-across-fields
# we issue one request per field and merge. PatientName is the hottest — listed
# first so its cache key stays warm across related queries.
_TEXT_SEARCH_FIELDS = ("PatientName", "PatientID", "StudyDescription", "AccessionNumber")
# Upper bound on per-field fetch so multi-field merge stays under a second even
# on a 10k-study archive. 500 covers any realistic name/description collision;
# if someone actually types "a" we accept that the merged set may be truncated.
_TEXT_FANOUT_LIMIT = 500

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
            if not query:
                # Unfiltered worklist — ask Orthanc for the true archive count
                # instead of /tools/find, which is globally capped by
                # LimitFindResults (=1000) and would silently under-report.
                stat_resp = await _http().get("/statistics")
                stat_resp.raise_for_status()
                total = int(stat_resp.json().get("CountPatients", 0))
            else:
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
    """Server-side study search and pagination via Orthanc /tools/find.

    `search` is parsed: modality codes (CT, MR, ...) and date tokens (2024,
    2024-01, 2022-2024) are pulled out into their structured slots, and
    anything left over is fanned out across PatientName/PatientID/
    StudyDescription/AccessionNumber so typing `CT 2024 ivanov` finds all
    CT studies from 2024 where the patient name or description matches.
    """
    # Explicit modality/date params still win — they come from UI filter chips.
    parsed = parse_search(search)
    text = parsed.text
    modality = modality or parsed.modality
    date_from = date_from or parsed.date_from
    date_to = date_to or parsed.date_to

    key = (text, modality, date_from, date_to, limit, offset)
    hit = await cache.get("studies", key, _STUDIES_FRESH_TTL)
    if hit is not None and hit[1]:
        return tuple(hit[0])

    base_query: dict[str, str] = {}
    if modality:
        base_query["ModalitiesInStudy"] = modality.split(",")[0].strip()
    if date_from and date_to:
        base_query["StudyDate"] = f"{date_from}-{date_to}"
    elif date_from:
        base_query["StudyDate"] = f"{date_from}-"
    elif date_to:
        base_query["StudyDate"] = f"-{date_to}"

    try:
        if text:
            items, total = await _multi_field_find(text, base_query, limit, offset)
        else:
            # Single query — no fanout needed. Use Orthanc's own pagination.
            resp = await _http().post("/tools/find", json={
                "Level": "Study",
                "Query": base_query,
                "Expand": True,
                "RequestedTags": ["ModalitiesInStudy"],
                "Limit": limit,
                "Since": offset,
            })
            resp.raise_for_status()
            items = resp.json()
            total = None  # filled in below
    except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
        # Stale-while-error — same rationale as find_patients: never 502 the UI.
        if hit is not None:
            _log.warning("find_studies: serving stale cache (Orthanc error: %s)", exc)
            return tuple(hit[0])
        raise Exception(f"PACS server unreachable: {exc}") from exc

    if text:
        # _multi_field_find already knows the exact merged total; no need to
        # round-trip Orthanc for a count. Cache + return.
        filter_key = ("s_total", text, modality, date_from, date_to)
        await cache.set("studies", filter_key, total)
        await cache.set("studies", key, [items, total])
        return items, total

    filter_key = ("s_total", text, modality, date_from, date_to)
    total: int | None = None
    if offset == 0 and len(items) < limit:
        total = len(items)
    else:
        total_hit = await cache.get("studies", filter_key, _STUDIES_FRESH_TTL)
        if total_hit is not None and total_hit[1]:
            total = int(total_hit[0])
    if total is None:
        try:
            if not base_query:
                # Unfiltered worklist — ask Orthanc for the true archive count
                # instead of /tools/find, which is globally capped by
                # LimitFindResults (=1000) and would silently under-report.
                stat_resp = await _http().get("/statistics")
                stat_resp.raise_for_status()
                total = int(stat_resp.json().get("CountStudies", 0))
            else:
                count_resp = await _http().post("/tools/find", json={
                    "Level": "Study",
                    "Query": base_query,
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


async def _multi_field_find(text: str, base_query: dict, limit: int, offset: int):
    """Fan out a free-text search across name-like fields and merge by Study.ID.

    Orthanc /tools/find ANDs keys within one Query, so we issue one request
    per field in parallel and dedupe. Per-field fetches are capped at
    `_TEXT_FANOUT_LIMIT`; the merged set is sorted by StudyDate desc and
    paginated in-memory. Trade-off: extremely common tokens (`a`, `b`) may
    truncate — acceptable because such searches return noise anyway.
    """
    wildcard = f"*{text}*"

    async def _fetch(field: str):
        q = dict(base_query)
        q[field] = wildcard
        try:
            r = await _http().post("/tools/find", json={
                "Level": "Study",
                "Query": q,
                "Expand": True,
                "RequestedTags": ["ModalitiesInStudy"],
                "Limit": _TEXT_FANOUT_LIMIT,
            })
            r.raise_for_status()
            return r.json()
        except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
            _log.warning("multi_field: %s query failed: %s", field, exc)
            return []

    results = await asyncio.gather(*(_fetch(f) for f in _TEXT_SEARCH_FIELDS))

    merged: dict[str, dict] = {}
    for rs in results:
        for s in rs:
            sid = s.get("ID")
            if sid and sid not in merged:
                merged[sid] = s

    def _sort_key(s: dict) -> str:
        # StudyDate is YYYYMMDD — lexical desc = chronological desc. Missing
        # dates sort last (they're usually malformed or legacy imports).
        return s.get("MainDicomTags", {}).get("StudyDate") or "00000000"

    ordered = sorted(merged.values(), key=_sort_key, reverse=True)
    total = len(ordered)
    page = ordered[offset:offset + limit]
    page = _propagate_modalities(page)
    return page, total


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


# Bounded concurrency for batch enrich paths (worklist thumbs, transfers
# study lookup, shares patient lookup). Without this, a single
# /api/transfers?limit=1000 page could fan out 1000 simultaneous GETs into
# Orthanc — fine on warm cache, brutal on cold. 20 in flight keeps the
# Orthanc connection pool happy and bounds tail latency.
_BATCH_SEM = asyncio.Semaphore(20)


async def bounded_get_study(study_id: str):
    """Semaphore-gated get_study. Use inside asyncio.gather for batches."""
    async with _BATCH_SEM:
        try:
            return await get_study(study_id)
        except Exception as exc:
            _log.warning("bounded_get_study(%s) failed: %s", study_id, exc)
            return None


async def bounded_get_patient(patient_id: str):
    """Semaphore-gated get_patient. Use inside asyncio.gather for batches."""
    async with _BATCH_SEM:
        try:
            return await get_patient(patient_id)
        except Exception as exc:
            _log.warning("bounded_get_patient(%s) failed: %s", patient_id, exc)
            return None


async def bounded_get_instance_preview(instance_id: str) -> bytes | None:
    """Semaphore-gated /instances/{id}/preview fetch returning JPEG bytes.

    Used by series-image ZIP downloads (clinician + patient portal) where a
    single series can have 100+ instances. Sequential per-instance fetch turned
    a cold-cache 100-frame download into ~10s of stalled HTTP; gather'd through
    _BATCH_SEM(20) it collapses to ~5 sequential batches of 20 (still 100 HTTP
    calls total, but with up to 20 in flight at once).

    Result order matches input order — callers depend on this for indexed
    filenames. Don't switch to as_completed without re-threading the index.
    """
    async with _BATCH_SEM:
        try:
            resp = await _http().get(f"/instances/{instance_id}/preview")
            if resp.status_code == 200:
                return resp.content
            return None
        except Exception as exc:
            _log.warning("bounded_get_instance_preview(%s) failed: %s", instance_id, exc)
            return None


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


async def download_study_media_stream(study_id: str) -> AsyncIterator[bytes]:
    """Like download_study_stream but uses Orthanc's /media variant — adds a
    DICOMDIR at the ZIP root, IHE PDI Basic Image and SR Profile. Required
    by portable viewers (Weasis, OsiriX, RadiAnt) for one-click discovery."""
    req = _http().build_request("GET", f"/studies/{study_id}/media")
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
