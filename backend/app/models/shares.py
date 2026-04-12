from pydantic import BaseModel
from datetime import datetime


class ShareCreate(BaseModel):
    orthanc_patient_id: str
    expires_at: datetime | None = None
    pin: str | None = None  # plain 4-6 digit PIN, will be hashed


class ShareUpdate(BaseModel):
    expires_at: datetime | None = None
    is_active: bool | None = None
