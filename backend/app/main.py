from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import init_db
from app.routers.auth import router as auth_router
from app.routers.patients import router as patients_router
from app.routers.studies import router as studies_router
from app.routers.pacs_nodes import router as pacs_nodes_router
from app.routers.transfers import router as transfers_router
from app.routers.shares import router as shares_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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


@app.get("/api/health")
async def health():
    return {"status": "ok"}
