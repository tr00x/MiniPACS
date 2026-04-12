from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import init_db
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await init_orthanc()
    yield
    await close_orthanc()


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.get("/api/health")
async def health():
    return {"status": "ok"}
