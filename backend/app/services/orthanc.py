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


async def get_patients(limit: int | None = None, since: int | None = None):
    params = {"expand": ""}
    if limit is not None:
        params["limit"] = str(limit)
    if since is not None:
        params["since"] = str(since)
    resp = await _http().get("/patients", params=params)
    resp.raise_for_status()
    return resp.json()


async def get_patient(patient_id: str):
    resp = await _http().get(f"/patients/{patient_id}")
    resp.raise_for_status()
    return resp.json()


async def get_patient_studies(patient_id: str):
    patient = await get_patient(patient_id)
    study_ids = patient.get("Studies", [])
    studies = []
    for sid in study_ids:
        r = await _http().get(f"/studies/{sid}")
        r.raise_for_status()
        studies.append(r.json())
    return studies


async def get_studies(limit: int | None = None, since: int | None = None):
    params = {"expand": ""}
    if limit is not None:
        params["limit"] = str(limit)
    if since is not None:
        params["since"] = str(since)
    resp = await _http().get("/studies", params=params)
    resp.raise_for_status()
    return resp.json()


async def get_study(study_id: str):
    resp = await _http().get(f"/studies/{study_id}")
    resp.raise_for_status()
    return resp.json()


async def get_study_series(study_id: str):
    study = await get_study(study_id)
    series_ids = study.get("Series", [])
    series_list = []
    for sid in series_ids:
        r = await _http().get(f"/series/{sid}")
        r.raise_for_status()
        series_list.append(r.json())
    return series_list


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
