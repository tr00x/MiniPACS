import httpx
from app.config import settings


def _auth():
    return (settings.orthanc_username, settings.orthanc_password)


def _url(path: str) -> str:
    return f"{settings.orthanc_url}{path}"


async def get_patients():
    async with httpx.AsyncClient() as http:
        resp = await http.get(_url("/patients?expand"), auth=_auth(), timeout=30)
        resp.raise_for_status()
        return resp.json()


async def get_patient(patient_id: str):
    async with httpx.AsyncClient() as http:
        resp = await http.get(_url(f"/patients/{patient_id}"), auth=_auth(), timeout=30)
        resp.raise_for_status()
        return resp.json()


async def get_patient_studies(patient_id: str):
    async with httpx.AsyncClient() as http:
        patient = await get_patient(patient_id)
        study_ids = patient.get("Studies", [])
        studies = []
        for sid in study_ids:
            r = await http.get(_url(f"/studies/{sid}"), auth=_auth(), timeout=30)
            r.raise_for_status()
            studies.append(r.json())
        return studies


async def get_studies():
    async with httpx.AsyncClient() as http:
        resp = await http.get(_url("/studies?expand"), auth=_auth(), timeout=30)
        resp.raise_for_status()
        return resp.json()


async def get_study(study_id: str):
    async with httpx.AsyncClient() as http:
        resp = await http.get(_url(f"/studies/{study_id}"), auth=_auth(), timeout=30)
        resp.raise_for_status()
        return resp.json()


async def get_study_series(study_id: str):
    async with httpx.AsyncClient() as http:
        study = await get_study(study_id)
        series_ids = study.get("Series", [])
        series_list = []
        for sid in series_ids:
            r = await http.get(_url(f"/series/{sid}"), auth=_auth(), timeout=30)
            r.raise_for_status()
            series_list.append(r.json())
        return series_list


async def get_series(series_id: str):
    async with httpx.AsyncClient() as http:
        resp = await http.get(_url(f"/series/{series_id}"), auth=_auth(), timeout=30)
        resp.raise_for_status()
        return resp.json()


async def get_series_instances(series_id: str):
    async with httpx.AsyncClient() as http:
        series = await get_series(series_id)
        instance_ids = series.get("Instances", [])
        instances = []
        for iid in instance_ids:
            r = await http.get(_url(f"/instances/{iid}"), auth=_auth(), timeout=30)
            r.raise_for_status()
            instances.append(r.json())
        return instances


async def download_study(study_id: str) -> bytes:
    async with httpx.AsyncClient() as http:
        resp = await http.get(
            _url(f"/studies/{study_id}/archive"),
            auth=_auth(),
            timeout=300,
        )
        resp.raise_for_status()
        return resp.content


async def send_to_modality(modality_id: str, resource_ids: list[str], synchronous: bool = True):
    async with httpx.AsyncClient() as http:
        resp = await http.post(
            _url(f"/modalities/{modality_id}/store"),
            json={"Resources": resource_ids, "Synchronous": synchronous},
            auth=_auth(),
            timeout=300,
        )
        resp.raise_for_status()
        return resp.json()


async def echo_modality(modality_id: str) -> bool:
    async with httpx.AsyncClient() as http:
        try:
            resp = await http.post(
                _url(f"/modalities/{modality_id}/echo"),
                auth=_auth(),
                timeout=10,
            )
            return resp.status_code == 200
        except Exception:
            return False


async def register_modality(modality_id: str, aet: str, host: str, port: int):
    async with httpx.AsyncClient() as http:
        resp = await http.put(
            _url(f"/modalities/{modality_id}"),
            json={"AET": aet, "Host": host, "Port": port},
            auth=_auth(),
        )
        resp.raise_for_status()


async def delete_modality(modality_id: str):
    async with httpx.AsyncClient() as http:
        resp = await http.delete(
            _url(f"/modalities/{modality_id}"),
            auth=_auth(),
        )
        resp.raise_for_status()
