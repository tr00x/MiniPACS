from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import settings
from app.database import init_db
from app.services.cache import init_cache, close_cache
from app.services.orthanc import init_client as init_orthanc, close_client as close_orthanc
from app.routers.auth import router as auth_router
from app.routers.patients import router as patients_router
from app.routers.studies import router as studies_router
from app.routers.pacs_nodes import router as pacs_nodes_router
from app.routers.transfers import router as transfers_router
from app.routers.shares import router as shares_router
from app.routers.settings import router as settings_router
from app.routers.viewers import router as viewers_router
from app.routers.audit import router as audit_router
from app.routers.users import router as users_router
from app.routers.stats import router as stats_router
from app.routers.reports import router as reports_router
from app.routers.dashboard import router as dashboard_router
from app.routers.boot import router as boot_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await init_cache(settings.redis_url)
    await init_orthanc()
    yield
    await close_orthanc()
    await close_cache()


app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
    default_response_class=ORJSONResponse,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Cache CORS preflight 24h. Without this, browsers OPTIONS every /api/
    # call, adding 1 RTT per fetch. Starlette's default is 600s.
    # Note: FastAPI's CORSMiddleware handles OPTIONS itself BEFORE nginx's
    # add_header has a chance — so the nginx-side Access-Control-Max-Age
    # directive is shadowed, and the authoritative knob is this one.
    max_age=86400,
)


# Browser-side cache policy on read-heavy endpoints.
#
# Two tiers, because not everything is safe to cache the same way:
#  - NON_PHI_PATHS: configuration-shaped data (viewers, settings, pacs-nodes).
#    Safe to cache with max-age — if an admin changes it, 5s of staleness is
#    fine. `Vary: Authorization` ensures a different session does not pick up
#    another user's cached copy on a shared browser.
#  - PHI_PATHS: patient/study/dashboard data. We never emit max-age here —
#    the backend in-memory cache already collapses bursts, and browser-side
#    caching of PHI on a shared workstation would let a logout-then-login
#    cycle reveal the previous user's patient list via Back button.
#    We do set `no-store` to make the intent explicit.
_NON_PHI_PATHS = (
    "/api/pacs-nodes",
    "/api/viewers",
    "/api/settings",
)
_PHI_PATHS = (
    "/api/studies",
    "/api/patients",
    "/api/stats",
    "/api/dashboard",
)


class BrowserCacheHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.method != "GET" or not (200 <= response.status_code < 300):
            return response
        if "cache-control" in (h.lower() for h in response.headers):
            return response
        path = request.url.path
        if any(path.startswith(p) for p in _NON_PHI_PATHS):
            response.headers["Cache-Control"] = "private, max-age=5"
            response.headers["Vary"] = "Authorization"
        elif any(path.startswith(p) for p in _PHI_PATHS):
            # Keyed per session via Vary: Authorization so another user on the
            # same browser never sees a different session's PHI. Short max-age
            # lets Cloudflare collapse concurrent identical requests + the
            # browser reuses within a paint cycle. must-revalidate forces an
            # upstream check once stale instead of indefinitely reusing.
            response.headers["Cache-Control"] = "private, max-age=5, must-revalidate"
            response.headers["Vary"] = "Authorization"
        return response


app.add_middleware(BrowserCacheHeaders)


app.include_router(auth_router)
app.include_router(patients_router)
app.include_router(studies_router)
app.include_router(pacs_nodes_router)
app.include_router(transfers_router)
app.include_router(shares_router)
app.include_router(settings_router)
app.include_router(viewers_router)
app.include_router(audit_router)
app.include_router(users_router)
app.include_router(stats_router)
app.include_router(reports_router)
app.include_router(dashboard_router)
app.include_router(boot_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
