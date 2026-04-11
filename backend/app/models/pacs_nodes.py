import re
from pydantic import BaseModel, field_validator, Field

AE_TITLE_PATTERN = re.compile(r"^[A-Za-z0-9_ \-\.]+$")


class PacsNodeCreate(BaseModel):
    name: str
    ae_title: str = Field(max_length=16)
    ip: str
    port: int = Field(ge=1, le=65535)
    description: str = ""

    @field_validator("ae_title")
    @classmethod
    def validate_ae_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("AE Title cannot be empty")
        if not AE_TITLE_PATTERN.match(v):
            raise ValueError("AE Title may only contain alphanumeric, space, hyphen, underscore, dot")
        return v


class PacsNodeUpdate(BaseModel):
    name: str | None = None
    ae_title: str | None = Field(default=None, max_length=16)
    ip: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    description: str | None = None
    is_active: bool | None = None

    @field_validator("ae_title")
    @classmethod
    def validate_ae_title(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("AE Title cannot be empty")
        if not AE_TITLE_PATTERN.match(v):
            raise ValueError("AE Title may only contain alphanumeric, space, hyphen, underscore, dot")
        return v
