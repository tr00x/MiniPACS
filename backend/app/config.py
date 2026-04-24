import os
import sys

from pydantic_settings import BaseSettings


# Sentinel placeholders baked into the open-source repo. If any of these
# reach runtime it means the operator never set the corresponding env var
# — which on a production deployment is a hard security failure (the JWT
# signing key, the Orthanc admin password, and the shared PG password
# become known strings from the public git history). We fail loud at
# startup rather than silently sign tokens with a well-known secret.
_PLACEHOLDER_SECRET = "CHANGE-ME-IN-PRODUCTION"
_SECRETS_THAT_MUST_BE_OVERRIDDEN = ("secret_key", "orthanc_password")


class Settings(BaseSettings):
    app_name: str = "MiniPACS Portal"
    secret_key: str = _PLACEHOLDER_SECRET
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7
    orthanc_url: str = "http://localhost:48923"
    orthanc_username: str = "orthanc"
    orthanc_password: str = _PLACEHOLDER_SECRET
    # Optional shared QIDO cache. Empty string = in-memory fallback (single-
    # worker dev), full redis://host:port/db = shared across uvicorn workers
    # and survives a backend restart. Unreachable Redis degrades gracefully
    # to the in-memory path — never a hard dep.
    redis_url: str = ""
    # PostgreSQL DSN. In docker-compose this points at the same PG that
    # Orthanc uses — our tables don't collide with Orthanc's. Outside of
    # docker (unit tests, tooling) the caller must set it explicitly.
    database_url: str = "postgresql://orthanc:orthanc@localhost:5432/orthanc"
    cors_origins: list[str] = ["http://localhost:48920"]
    auto_logout_minutes: int = 15
    default_share_expiry_days: int = 30
    # Pydantic model configuration
    class Config:
        env_file = ".env"


settings = Settings()


# ---------------------------------------------------------------------------
# Startup security gate
# ---------------------------------------------------------------------------
# Pass MINIPACS_ALLOW_INSECURE_DEFAULTS=1 to bypass the check — intended
# for unit tests that don't exercise auth at all. Any real HTTP surface
# should supply proper env vars instead.
if os.environ.get("MINIPACS_ALLOW_INSECURE_DEFAULTS") != "1":
    _insecure: list[str] = []
    for name in _SECRETS_THAT_MUST_BE_OVERRIDDEN:
        if getattr(settings, name) == _PLACEHOLDER_SECRET:
            _insecure.append(name.upper())
    if _insecure:
        sys.stderr.write(
            "\n[SECURITY] Refusing to start: the following secrets still use "
            "the public placeholder value from the open-source repo: "
            f"{', '.join(_insecure)}. "
            "Set real values in .env (see .env.docker template) before running. "
            "If you are running a test that never exercises auth, export "
            "MINIPACS_ALLOW_INSECURE_DEFAULTS=1.\n\n"
        )
        raise SystemExit(2)
