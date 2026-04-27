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
# Patient-level wildcard-safe fan-out fields. PatientBirthDate is added
# dynamically as a DICOM date range when the input parses as a date —
# Orthanc rejects `*1985*` against date VR fields, so it can't live here.
# Source-of-truth for `_multi_field_find_patients`'s wildcard fan-out.
_PATIENT_TEXT_SEARCH_FIELDS: tuple[str, ...] = ("PatientName", "PatientID")
# Upper bound on per-field fetch so multi-field merge stays under a second even
# on a 10k-study archive. 500 covers any realistic name/description collision;
# if someone actually types "a" we accept that the merged set may be truncated.
_TEXT_FANOUT_LIMIT = 500

# Sort key → DICOM tag mapping. Maps the small allow-listed UI sort keys onto
# the actual DICOM tag names that Orthanc /tools/find OrderBy understands.
# OrderBy is supported by Orthanc core 1.12.5+ — our base image
# orthancteam/orthanc:26.4.2-full ships 1.12.6+, so this is safe.
_STUDY_SORT_TAGS = {
    "date": "StudyDate",
    "patient": "PatientName",
    # ModalitiesInStudy is a computed/synthetic tag in Orthanc — using it in
    # /tools/find OrderBy returns 500. Modality filtering is already handled
    # by the chip filter at the UI level.
    "description": "StudyDescription",
}
_PATIENT_SORT_TAGS = {
    "name": "PatientName",
    "dob": "PatientBirthDate",
    "id": "PatientID",
}


def _order_by(tag: str | None, direction: str) -> list[dict] | None:
    """Build an Orthanc OrderBy clause. Returns None if the tag is empty —
    callers omit the field from the request body in that case so Orthanc
    falls back to its default ordering (insertion order)."""
    if not tag:
        return None
    return [{"Type": "DicomTag", "Key": tag, "Direction": "DESC" if direction == "desc" else "ASC"}]


def _resolve_sort(table: dict[str, str], sort_by: str, sort_dir: str) -> tuple[str, str]:
    """Validate (sort_by, sort_dir) against an allow-list. Empty sort_by
    means "use Orthanc default order"; an unknown key is silently coerced
    to default rather than 500'ing a UI request."""
    tag = table.get(sort_by, "") if sort_by else ""
    direction = "desc" if sort_dir == "desc" else "asc"
    return tag, direction


def _dob_query_range(text: str) -> str | None:
    """Convert a user DOB token into a DICOM date-range string for
    /tools/find. Orthanc rejects wildcards on date VR fields, but accepts
    `YYYYMMDD-YYYYMMDD` ranges. Returns None if the input doesn't look like
    a date — the caller skips PatientBirthDate fan-out in that case so we
    never 400 Orthanc.

    Accepts `1985`, `1985-03`, `1985-03-15`, `19850315`, with `/` or `.` as
    separators. Returns the DICOM range that covers the implied window:
    a year-only token spans Jan 1 — Dec 31, year+month spans the full month.
    """
    if not text:
        return None
    digits = "".join(ch for ch in text if ch.isdigit())
    n = len(digits)
    # Reject anything with non-digit + non-separator chars (e.g. names).
    allowed = set("0123456789-/.")
    if not all(ch in allowed for ch in text):
        return None
    if n == 8:
        return f"{digits}-{digits}"
    if n == 6:
        y, m = digits[:4], digits[4:6]
        if not (1 <= int(m) <= 12):
            return None
        # Feb gets a fixed "29" — leap-year correctness is not needed because
        # Orthanc /tools/find compares date-range bounds *lexically* against
        # YYYYMMDD-stored values. Over-shooting non-leap Feb by one day
        # cannot match a non-existent record, only widens the window.
        last = "31" if m in {"01", "03", "05", "07", "08", "10", "12"} else ("30" if m != "02" else "29")
        return f"{y}{m}01-{y}{m}{last}"
    if n == 4:
        # Years before 1900 likely aren't DOBs — skip to avoid matching
        # accession-number-like tokens. 19xx/20xx are real DOBs.
        if digits[:2] not in ("19", "20"):
            return None
        return f"{digits}0101-{digits}1231"
    return None

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


async def find_patients(search: str = "", limit: int = 25, offset: int = 0, sort_by: str = "", sort_dir: str = "asc"):
    """Server-side patient search and pagination via Orthanc /tools/find.

    `search` accepts free-text that is fanned out across PatientName,
    PatientID, and PatientBirthDate so a single input box matches name
    fragments, MRN substrings, and DOB tokens (1985, 1985-03, 1985-03-15)
    via wildcard against YYYYMMDD storage.

    `sort_by` is one of `_PATIENT_SORT_TAGS` keys (or empty for default
    insertion order). Unknown keys silently fall back to default.
    """
    sort_tag, sort_direction = _resolve_sort(_PATIENT_SORT_TAGS, sort_by, sort_dir)
    key = ("p", search, sort_tag, sort_direction, limit, offset)
    hit = await cache.get("patients", key, _PATIENTS_FRESH_TTL)
    if hit is not None and hit[1]:
        return tuple(hit[0])

    order_clause = _order_by(sort_tag, sort_direction)

    try:
        if search:
            items, total = await _multi_field_find_patients(search, limit, offset, sort_tag, sort_direction)
        else:
            req_body: dict = {
                "Level": "Patient",
                "Query": {},
                "Expand": True,
                "Limit": limit,
                "Since": offset,
            }
            if order_clause:
                req_body["OrderBy"] = order_clause
            resp = await _http().post("/tools/find", json=req_body)
            resp.raise_for_status()
            items = resp.json()
            total = None
    except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
        # Stale-while-error: if Orthanc is slow or timing out, return the last
        # known good cache entry for this key (past TTL) so the UI keeps
        # rendering rows instead of flashing a 502.
        if hit is not None:
            _log.warning("find_patients: serving stale cache (Orthanc error: %s)", exc)
            return tuple(hit[0])
        raise Exception(f"PACS server unreachable: {exc}") from exc

    if search:
        # Fan-out path already knows the merged total exactly; no Orthanc
        # round-trip needed for a count.
        filter_key = ("p_total", search)
        await cache.set("patients", filter_key, total)
        await cache.set("patients", key, [items, total])
        return items, total

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
            # Unfiltered patients list — ask Orthanc for the true archive
            # count instead of /tools/find, which is globally capped by
            # LimitFindResults (=1000) and would silently under-report.
            stat_resp = await _http().get("/statistics")
            stat_resp.raise_for_status()
            total = int(stat_resp.json().get("CountPatients", 0))
        except Exception:
            total = offset + len(items)
    await cache.set("patients", filter_key, total)
    await cache.set("patients", key, [items, total])
    return items, total


async def _multi_field_find_patients(text: str, limit: int, offset: int, sort_tag: str = "", sort_direction: str = "asc"):
    """Fan-out free-text search across PatientName/PatientID and (when the
    input parses as a date) PatientBirthDate, merging results by Patient.ID.

    PatientName / PatientID accept Orthanc's `*text*` wildcard. PatientBirthDate
    does NOT — Orthanc rejects wildcards on date VR fields with 400 — so DOB
    is only queried when the input parses to a year (`1985`), year+month
    (`1985-03`), or full date (`1985-03-15`), and is sent as a DICOM
    `YYYYMMDD-YYYYMMDD` range.
    """
    wildcard = f"*{text}*"
    dob_range = _dob_query_range(text)

    async def _fetch_text(field: str):
        try:
            r = await _http().post("/tools/find", json={
                "Level": "Patient",
                "Query": {field: wildcard},
                "Expand": True,
                "Limit": _TEXT_FANOUT_LIMIT,
            })
            r.raise_for_status()
            return r.json()
        except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
            _log.warning("multi_field_patients: %s query failed: %s", field, exc)
            return []

    async def _fetch_dob(rng: str):
        try:
            r = await _http().post("/tools/find", json={
                "Level": "Patient",
                "Query": {"PatientBirthDate": rng},
                "Expand": True,
                "Limit": _TEXT_FANOUT_LIMIT,
            })
            r.raise_for_status()
            return r.json()
        except (httpx.HTTPError, httpx.TimeoutException, httpx.ConnectError) as exc:
            _log.warning("multi_field_patients: PatientBirthDate range query failed: %s", exc)
            return []

    fetches = [_fetch_text(f) for f in _PATIENT_TEXT_SEARCH_FIELDS]
    if dob_range:
        fetches.append(_fetch_dob(dob_range))
    results = await asyncio.gather(*fetches)

    merged: dict[str, dict] = {}
    for rs in results:
        for p in rs:
            pid = p.get("ID")
            if pid and pid not in merged:
                merged[pid] = p

    effective_tag = sort_tag or "PatientName"
    effective_dir = sort_direction if sort_tag else "asc"

    def _sort_key(p: dict) -> str:
        return ((p.get("MainDicomTags", {}) or {}).get(effective_tag, "") or "").lower()

    descending = effective_dir == "desc"
    has_value = [p for p in merged.values() if _sort_key(p)]
    blanks = [p for p in merged.values() if not _sort_key(p)]
    has_value.sort(key=_sort_key, reverse=descending)
    ordered = has_value + blanks
    total = len(ordered)
    page = ordered[offset:offset + limit]
    return page, total


async def find_studies(search: str = "", modality: str = "", date_from: str = "", date_to: str = "", limit: int = 25, offset: int = 0, sort_by: str = "", sort_dir: str = "desc"):
    """Server-side study search and pagination via Orthanc /tools/find.

    `search` is parsed: modality codes (CT, MR, ...) and date tokens (2024,
    2024-01, 2022-2024) are pulled out into their structured slots, and
    anything left over is fanned out across PatientName/PatientID/
    StudyDescription/AccessionNumber so typing `CT 2024 ivanov` finds all
    CT studies from 2024 where the patient name or description matches.

    `sort_by` is one of `_STUDY_SORT_TAGS` keys (or empty for Orthanc's
    default insertion order). Unknown keys are silently dropped to default —
    we never 500 the worklist on a stale localStorage value.
    """
    # Explicit modality/date params still win — they come from UI filter chips.
    parsed = parse_search(search)
    text = parsed.text
    modality = modality or parsed.modality
    date_from = date_from or parsed.date_from
    date_to = date_to or parsed.date_to

    sort_tag, sort_direction = _resolve_sort(_STUDY_SORT_TAGS, sort_by, sort_dir)

    key = (text, modality, date_from, date_to, sort_tag, sort_direction, limit, offset)
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

    order_clause = _order_by(sort_tag, sort_direction)

    try:
        if text:
            items, total = await _multi_field_find(text, base_query, limit, offset, sort_tag, sort_direction)
        else:
            # Single query — no fanout needed. Use Orthanc's own pagination.
            req_body: dict = {
                "Level": "Study",
                "Query": base_query,
                "Expand": True,
                "RequestedTags": ["ModalitiesInStudy"],
                "Limit": limit,
                "Since": offset,
            }
            if order_clause:
                req_body["OrderBy"] = order_clause
            resp = await _http().post("/tools/find", json=req_body)
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


async def _multi_field_find(text: str, base_query: dict, limit: int, offset: int, sort_tag: str = "", sort_direction: str = "desc"):
    """Fan out a free-text search across name-like fields and merge by Study.ID.

    Orthanc /tools/find ANDs keys within one Query, so we issue one request
    per field in parallel and dedupe. Per-field fetches are capped at
    `_TEXT_FANOUT_LIMIT`; the merged set is then sorted in-memory by the
    requested sort tag (default StudyDate desc) and paginated. Trade-off:
    extremely common tokens (`a`, `b`) may truncate — acceptable because such
    searches return noise anyway.

    In-memory sort is correct even for the merged set because each per-field
    fetch has Limit=500, so the merged superset is bounded — pagination over
    the same merged ordering across pages stays consistent.
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

    # Default sort: StudyDate desc (matches user expectation — most-recent
    # imaging first when typing a name search).
    effective_tag = sort_tag or "StudyDate"
    effective_dir = sort_direction if sort_tag else "desc"

    def _sort_key(s: dict) -> str:
        # All our supported tags are strings; YYYYMMDD dates are lexically
        # ordered correctly. Missing values sort last in desc, first in asc —
        # to keep consistent "missing always at the bottom" we coerce empty
        # to a sentinel that lands at the bottom for both directions.
        val = (s.get("MainDicomTags", {}) or {}).get(effective_tag, "") or ""
        return val.lower()

    descending = effective_dir == "desc"
    # Two-pass: blanks always go last regardless of direction.
    has_value = [s for s in merged.values() if _sort_key(s)]
    blanks = [s for s in merged.values() if not _sort_key(s)]
    has_value.sort(key=_sort_key, reverse=descending)
    ordered = has_value + blanks
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
