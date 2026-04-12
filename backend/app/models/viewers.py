from pydantic import BaseModel


class ViewerCreate(BaseModel):
    name: str
    icon: str = ""
    url_scheme: str
    is_enabled: bool = True
    sort_order: int = 0
    description: str = ""
    icon_key: str = ""


class ViewerUpdate(BaseModel):
    name: str | None = None
    icon: str | None = None
    url_scheme: str | None = None
    is_enabled: bool | None = None
    sort_order: int | None = None
    description: str | None = None
    icon_key: str | None = None
