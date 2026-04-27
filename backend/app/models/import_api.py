"""Request/response shapes for /api/studies/import.

Frontend (useChunkedUpload.ts) imports the same names; keep these in
sync. All field types are exact — no Optional[Any] catch-alls.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class PrecheckFile(BaseModel):
    name: str
    size: int = Field(ge=0)
    sha256: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")


class PrecheckRequest(BaseModel):
    files: list[PrecheckFile]


class PrecheckEntry(BaseModel):
    action: str  # "skip" | "upload"
    instance_count: int = 0  # populated when action == "skip"
    study_ids: list[str] = []


class PrecheckResponse(BaseModel):
    results: dict[str, PrecheckEntry]  # keyed by sha256


class CreateUploadRequest(BaseModel):
    job_id: str
    name: str
    size: int = Field(ge=0)
    sha256: str = Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}$")
    total_chunks: int = Field(ge=1)


class CreateUploadResponse(BaseModel):
    upload_id: str


class UploadStatusResponse(BaseModel):
    upload_id: str
    name: str
    size: int
    total_chunks: int
    received_chunks: list[int]


class FinalizeRequest(BaseModel):
    upload_id: str


class StartJobResponse(BaseModel):
    job_id: str
