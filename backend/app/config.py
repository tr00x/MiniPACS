from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "MiniPACS Portal"
    secret_key: str = "CHANGE-ME-IN-PRODUCTION"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7
    orthanc_url: str = "http://localhost:48923"
    orthanc_username: str = "orthanc"
    orthanc_password: str = "CHANGE-ME-IN-PRODUCTION"
    # Optional shared QIDO cache. Empty string = in-memory fallback (single-
    # worker dev), full redis://host:port/db = shared across uvicorn workers
    # and survives a backend restart. Unreachable Redis degrades gracefully
    # to the in-memory path — never a hard dep.
    redis_url: str = ""
    database_url: str = "sqlite+aiosqlite:///./minipacs.db"
    cors_origins: list[str] = ["http://localhost:48920"]
    auto_logout_minutes: int = 15
    default_share_expiry_days: int = 30

    class Config:
        env_file = ".env"


settings = Settings()
