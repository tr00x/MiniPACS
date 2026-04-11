from pydantic import BaseModel
from datetime import datetime


class ShareCreate(BaseModel):
    orthanc_patient_id: str
    expires_at: datetime | None = None


class ShareUpdate(BaseModel):
    expires_at: datetime | None = None
    is_active: bool | None = None
