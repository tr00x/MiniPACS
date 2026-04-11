from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "MiniPACS Portal"
    secret_key: str = "CHANGE-ME-IN-PRODUCTION"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7
    orthanc_url: str = "http://localhost:48923"
    orthanc_username: str = "orthanc"
    orthanc_password: str = "orthanc"
    database_url: str = "sqlite+aiosqlite:///./minipacs.db"
    auto_logout_minutes: int = 15
    default_share_expiry_days: int = 30

    class Config:
        env_file = ".env"


settings = Settings()
