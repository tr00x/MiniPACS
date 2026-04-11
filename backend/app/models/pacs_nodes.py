from pydantic import BaseModel


class PacsNodeCreate(BaseModel):
    name: str
    ae_title: str
    ip: str
    port: int
    description: str = ""


class PacsNodeUpdate(BaseModel):
    name: str | None = None
    ae_title: str | None = None
    ip: str | None = None
    port: int | None = None
    description: str | None = None
    is_active: bool | None = None
