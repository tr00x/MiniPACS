from pydantic import BaseModel


class ReportCreate(BaseModel):
    orthanc_study_id: str
    title: str
    report_type: str = "text"  # "text" or "pdf"
    content: str  # text content or base64-encoded PDF
    filename: str | None = None


class ReportUpdate(BaseModel):
    title: str | None = None
    content: str | None = None
