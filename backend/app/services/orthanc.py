import asyncio
from typing import AsyncIterator

import httpx
from app.config import settings

_client: httpx.AsyncClient | None = None


async def init_client():
    global _client
    _client = httpx.AsyncClient(
        base_url=settings.orthanc_url,
        auth=(settings.orthanc_username, settings.orthanc_password),
        timeout=30,
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
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise Exception(f"PACS server unreachable: {exc}") from exc

    # Get total count (without limit) for pagination
    try:
        count_resp = await _http().post("/tools/find", json={
            "Level": "Patient",
            "Query": query,
            "Expand": False,
        })
        count_resp.raise_for_status()
        total = len(count_resp.json())
    except Exception:
        total = len(items)

    return items, total


async def find_studies(search: str = "", modality: str = "", date_from: str = "", date_to: str = "", limit: int = 25, offset: int = 0):
    """Server-side study search and pagination via Orthanc /tools/find."""
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

    try:
        resp = await _http().post("/tools/find", json={
            "Level": "Study",
            "Query": query,
            "Expand": True,
            "Limit": limit,
            "Since": offset,
        })
        resp.raise_for_status()
        items = resp.json()
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise Exception(f"PACS server unreachable: {exc}") from exc

    # Get total count
    try:
        count_resp = await _http().post("/tools/find", json={
            "Level": "Study",
            "Query": query,
            "Expand": False,
        })
        count_resp.raise_for_status()
        total = len(count_resp.json())
    except Exception:
        total = len(items)

    items = await _enrich_study_modalities(items)
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
    patient = await get_patient(patient_id)
    if patient is None:
        return []
    study_ids = patient.get("Studies", [])

    async def fetch_study(sid: str):
        r = await _http().get(f"/studies/{sid}")
        r.raise_for_status()
        return r.json()

    studies = list(await asyncio.gather(*[fetch_study(sid) for sid in study_ids]))
    return await _enrich_study_modalities(studies)


async def _enrich_study_modalities(studies: list) -> list:
    """Add ModalitiesInStudy from series-level Modality if not present at study level."""
    async def enrich(study: dict) -> dict:
        tags = study.get("MainDicomTags", {})
        if tags.get("ModalitiesInStudy"):
            return study
        series_ids = study.get("Series", [])
        if not series_ids:
            return study
        modalities = set()
        for sid in series_ids:
            try:
                r = await _http().get(f"/series/{sid}")
                if r.status_code == 200:
                    mod = r.json().get("MainDicomTags", {}).get("Modality")
                    if mod:
                        modalities.add(mod)
            except Exception:
                pass
        if modalities:
            tags["ModalitiesInStudy"] = "/".join(sorted(modalities))
        return study

    return list(await asyncio.gather(*[enrich(s) for s in studies]))


async def get_studies(limit: int | None = None, since: int | None = None):
    params = {"expand": ""}
    if limit is not None:
        params["limit"] = str(limit)
    if since is not None:
        params["since"] = str(since)
    try:
        resp = await _http().get("/studies", params=params)
        resp.raise_for_status()
        studies = resp.json()
        return await _enrich_study_modalities(studies)
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise Exception(f"PACS server unreachable: {exc}") from exc


async def get_study(study_id: str):
    resp = await _http().get(f"/studies/{study_id}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


async def get_study_series(study_id: str):
    study = await get_study(study_id)
    if study is None:
        return []
    series_ids = study.get("Series", [])

    async def fetch_series(sid: str):
        r = await _http().get(f"/series/{sid}")
        r.raise_for_status()
        return r.json()

    return await asyncio.gather(*[fetch_series(sid) for sid in series_ids])


async def get_series(series_id: str):
    resp = await _http().get(f"/series/{series_id}")
    resp.raise_for_status()
    return resp.json()


async def get_series_instances(series_id: str):
    series = await get_series(series_id)
    instance_ids = series.get("Instances", [])
    instances = []
    for iid in instance_ids:
        r = await _http().get(f"/instances/{iid}")
        r.raise_for_status()
        instances.append(r.json())
    return instances


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
