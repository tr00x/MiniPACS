# MiniPACS Portal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready web portal for a solo US clinic to store, view, send, and share DICOM medical images via Orthanc PACS.

**Architecture:** Orthanc (native DICOM server) → FastAPI (Python backend with PyOrthanc client, JWT auth, audit logging) → React (shadcn/ui + Lucide, embedded OHIF viewer). All behind nginx reverse proxy with HTTPS. SQLite for minimal app state. HIPAA compliant.

**Tech Stack:** Python 3.12+, FastAPI, PyOrthanc (async), SQLite (aiosqlite), React 18, shadcn/ui, Lucide icons, OHIF Viewer 3.x, nginx, Orthanc 1.12+

---

## Chunk 1: Project Structure and Backend Foundation

### Task 1: Initialize Project Structure

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/app/__init__.py`
- Create: `backend/app/main.py`
- Create: `backend/app/config.py`
- Create: `backend/app/database.py`
- Create: `backend/alembic.ini` (not needed for SQLite, skip)
- Create: `frontend/package.json` (via create-react-app or vite)
- Create: `orthanc/orthanc.json`
- Create: `nginx/nginx.conf`
- Create: `.gitignore`

- [ ] **Step 1: Create project directory structure**

```bash
mkdir -p backend/app/{routers,models,services,middleware}
mkdir -p backend/tests
mkdir -p frontend
mkdir -p orthanc
mkdir -p nginx
```

- [ ] **Step 2: Create .gitignore**

```gitignore
# Python
__pycache__/
*.py[cod]
*.egg-info/
.venv/
backend/.venv/

# Node
node_modules/
frontend/dist/
frontend/build/

# IDE
.idea/
.vscode/
*.swp

# Environment
.env
*.env.local

# SQLite
*.db
*.sqlite3

# OS
.DS_Store
Thumbs.db
```

- [ ] **Step 3: Create backend requirements.txt**

```
fastapi==0.115.6
uvicorn[standard]==0.34.0
pyorthanc==1.18.0
aiosqlite==0.20.0
python-jose[cryptography]==3.3.0
passlib[bcrypt]==1.7.4
python-multipart==0.0.18
httpx==0.28.1
pydantic==2.10.4
pydantic-settings==2.7.1
```

- [ ] **Step 4: Create Python virtual environment and install dependencies**

```bash
cd /Users/timur/projectos/minipacs/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

- [ ] **Step 5: Create backend/app/config.py**

```python
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
```

- [ ] **Step 6: Create backend/app/database.py**

```python
import aiosqlite
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "minipacs.db"


async def get_db():
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    try:
        yield db
    finally:
        await db.close()


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                token_version INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                last_login TEXT
            );

            CREATE TABLE IF NOT EXISTS patient_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orthanc_patient_id TEXT NOT NULL,
                token TEXT UNIQUE NOT NULL,
                expires_at TEXT,
                created_by INTEGER REFERENCES users(id),
                created_at TEXT DEFAULT (datetime('now')),
                is_active INTEGER DEFAULT 1,
                view_count INTEGER DEFAULT 0,
                first_viewed_at TEXT,
                last_viewed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS pacs_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                ae_title TEXT NOT NULL,
                ip TEXT NOT NULL,
                port INTEGER NOT NULL,
                description TEXT,
                is_active INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS transfer_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                orthanc_study_id TEXT NOT NULL,
                pacs_node_id INTEGER REFERENCES pacs_nodes(id),
                initiated_by INTEGER REFERENCES users(id),
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                patient_token TEXT,
                action TEXT NOT NULL,
                resource_type TEXT,
                resource_id TEXT,
                ip_address TEXT,
                timestamp TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS external_viewers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                icon TEXT,
                url_scheme TEXT NOT NULL,
                is_enabled INTEGER DEFAULT 1,
                sort_order INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at TEXT DEFAULT (datetime('now'))
            );
        """)
        await db.commit()
```

- [ ] **Step 7: Create backend/app/main.py**

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Will be restricted in nginx
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 8: Test that the server starts**

```bash
cd /Users/timur/projectos/minipacs/backend
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 48922 --reload
```

Visit `http://localhost:48922/api/health` — should return `{"status": "ok"}`

- [ ] **Step 9: Commit**

```bash
git add backend/ .gitignore
git commit -m "feat: initialize backend with FastAPI, database schema, config"
```

---

### Task 2: Authentication System

**Files:**
- Create: `backend/app/services/auth.py`
- Create: `backend/app/routers/auth.py`
- Create: `backend/app/models/auth.py`
- Create: `backend/app/middleware/audit.py`
- Modify: `backend/app/main.py`

- [ ] **Step 1: Create backend/app/models/auth.py**

```python
from pydantic import BaseModel


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    id: int
    username: str
    created_at: str
    last_login: str | None


class RefreshRequest(BaseModel):
    refresh_token: str
```

- [ ] **Step 2: Create backend/app/services/auth.py**

```python
import secrets
from datetime import datetime, timedelta, timezone

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

ALGORITHM = "HS256"


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(user_id: int, token_version: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    return jwt.encode(
        {"sub": str(user_id), "tv": token_version, "exp": expire, "type": "access"},
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def create_refresh_token(user_id: int, token_version: int) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    return jwt.encode(
        {"sub": str(user_id), "tv": token_version, "exp": expire, "type": "refresh"},
        settings.secret_key,
        algorithm=ALGORITHM,
    )


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except JWTError:
        return None


def generate_share_token() -> str:
    return secrets.token_urlsafe(32)
```

- [ ] **Step 3: Create backend/app/middleware/audit.py**

```python
from datetime import datetime, timezone

import aiosqlite

from app.database import DB_PATH


async def log_audit(
    action: str,
    resource_type: str = None,
    resource_id: str = None,
    user_id: int = None,
    patient_token: str = None,
    ip_address: str = None,
):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO audit_log (user_id, patient_token, action, resource_type, resource_id, ip_address, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user_id, patient_token, action, resource_type, resource_id, ip_address,
             datetime.now(timezone.utc).isoformat()),
        )
        await db.commit()
```

- [ ] **Step 4: Create backend/app/routers/auth.py**

```python
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

import aiosqlite

from app.database import get_db
from app.models.auth import LoginRequest, TokenResponse, UserResponse, RefreshRequest
from app.services.auth import (
    verify_password, hash_password, create_access_token,
    create_refresh_token, decode_token,
)
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/auth", tags=["auth"])
security = HTTPBearer()

# Rate limiting state (simple in-memory)
_login_attempts: dict[str, list[float]] = {}
MAX_ATTEMPTS = 5
WINDOW_SECONDS = 300


def _check_rate_limit(ip: str):
    now = datetime.now(timezone.utc).timestamp()
    attempts = _login_attempts.get(ip, [])
    attempts = [t for t in attempts if now - t < WINDOW_SECONDS]
    _login_attempts[ip] = attempts
    if len(attempts) >= MAX_ATTEMPTS:
        raise HTTPException(429, "Too many login attempts. Try again later.")
    attempts.append(now)
    _login_attempts[ip] = attempts


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: aiosqlite.Connection = Depends(get_db),
) -> dict:
    payload = decode_token(credentials.credentials)
    if not payload or payload.get("type") != "access":
        raise HTTPException(401, "Invalid token")

    user_id = int(payload["sub"])
    cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    user = await cursor.fetchone()
    if not user:
        raise HTTPException(401, "User not found")
    if user["token_version"] != payload.get("tv"):
        raise HTTPException(401, "Token revoked")
    return dict(user)


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, request: Request, db: aiosqlite.Connection = Depends(get_db)):
    ip = request.client.host
    _check_rate_limit(ip)

    cursor = await db.execute("SELECT * FROM users WHERE username = ?", (body.username,))
    user = await cursor.fetchone()
    if not user or not verify_password(body.password, user["password_hash"]):
        await log_audit("login_failed", ip_address=ip)
        raise HTTPException(401, "Invalid credentials")

    user = dict(user)
    await db.execute(
        "UPDATE users SET last_login = ? WHERE id = ?",
        (datetime.now(timezone.utc).isoformat(), user["id"]),
    )
    await db.commit()
    await log_audit("login", user_id=user["id"], ip_address=ip)

    return TokenResponse(
        access_token=create_access_token(user["id"], user["token_version"]),
        refresh_token=create_refresh_token(user["id"], user["token_version"]),
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: aiosqlite.Connection = Depends(get_db)):
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(401, "Invalid refresh token")

    user_id = int(payload["sub"])
    cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    user = await cursor.fetchone()
    if not user or user["token_version"] != payload.get("tv"):
        raise HTTPException(401, "Token revoked")

    user = dict(user)
    return TokenResponse(
        access_token=create_access_token(user["id"], user["token_version"]),
        refresh_token=create_refresh_token(user["id"], user["token_version"]),
    )


@router.post("/logout")
async def logout(request: Request, user: dict = Depends(get_current_user)):
    await log_audit("logout", user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}


@router.get("/me", response_model=UserResponse)
async def me(user: dict = Depends(get_current_user)):
    return UserResponse(**user)
```

- [ ] **Step 5: Create initial admin user via CLI script: backend/app/create_user.py**

```python
"""Usage: python -m app.create_user <username> <password>"""
import asyncio
import sys

import aiosqlite

from app.database import DB_PATH, init_db
from app.services.auth import hash_password


async def main():
    if len(sys.argv) != 3:
        print("Usage: python -m app.create_user <username> <password>")
        sys.exit(1)

    username, password = sys.argv[1], sys.argv[2]
    await init_db()

    async with aiosqlite.connect(DB_PATH) as db:
        try:
            await db.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, hash_password(password)),
            )
            await db.commit()
            print(f"User '{username}' created.")
        except aiosqlite.IntegrityError:
            print(f"User '{username}' already exists.")
            sys.exit(1)


asyncio.run(main())
```

- [ ] **Step 6: Register auth router in main.py**

Add to `backend/app/main.py`:
```python
from app.routers.auth import router as auth_router

# After app creation:
app.include_router(auth_router)
```

- [ ] **Step 7: Test auth flow**

```bash
# Create user
cd /Users/timur/projectos/minipacs/backend
source .venv/bin/activate
python -m app.create_user admin admin123

# Start server
uvicorn app.main:app --host 0.0.0.0 --port 48922 --reload

# Test login (in another terminal)
curl -X POST http://localhost:48922/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'

# Should return access_token and refresh_token
```

- [ ] **Step 8: Commit**

```bash
git add backend/
git commit -m "feat: add JWT authentication with rate limiting and audit logging"
```

---

### Task 3: Orthanc Proxy — Patients and Studies

**Files:**
- Create: `backend/app/services/orthanc.py`
- Create: `backend/app/routers/patients.py`
- Create: `backend/app/routers/studies.py`

- [ ] **Step 1: Create backend/app/services/orthanc.py**

```python
from pyorthanc import AsyncOrthanc, Modality
from app.config import settings

_client: AsyncOrthanc | None = None


def get_orthanc() -> AsyncOrthanc:
    global _client
    if _client is None:
        _client = AsyncOrthanc(
            url=settings.orthanc_url,
            username=settings.orthanc_username,
            password=settings.orthanc_password,
        )
    return _client


async def get_patients(query: dict = None):
    client = get_orthanc()
    if query:
        import pyorthanc
        return await asyncio.to_thread(
            pyorthanc.find_patients, client, query=query
        )
    patient_ids = await client.get_patients()
    patients = []
    for pid in patient_ids:
        p = await client.get_patient(pid)
        patients.append(p)
    return patients


async def get_patient(patient_id: str):
    client = get_orthanc()
    return await client.get_patient(patient_id)


async def get_patient_studies(patient_id: str):
    client = get_orthanc()
    return await client.get_patient_studies(patient_id)


async def get_studies():
    client = get_orthanc()
    study_ids = await client.get_studies()
    studies = []
    for sid in study_ids:
        s = await client.get_study(sid)
        studies.append(s)
    return studies


async def get_study(study_id: str):
    client = get_orthanc()
    return await client.get_study(study_id)


async def get_study_series(study_id: str):
    client = get_orthanc()
    return await client.get_study_series(study_id)


async def get_series(series_id: str):
    client = get_orthanc()
    return await client.get_series(series_id)


async def get_series_instances(series_id: str):
    client = get_orthanc()
    return await client.get_series_instances(series_id)


async def get_instance(instance_id: str):
    client = get_orthanc()
    return await client.get_instance(instance_id)


async def download_study(study_id: str) -> bytes:
    """Download study as ZIP archive."""
    client = get_orthanc()
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.get(
            f"{settings.orthanc_url}/studies/{study_id}/archive",
            auth=(settings.orthanc_username, settings.orthanc_password),
        )
        resp.raise_for_status()
        return resp.content


async def send_to_modality(modality_id: str, resource_ids: list[str], synchronous: bool = False):
    """Send DICOM resources to a remote modality via C-STORE."""
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.post(
            f"{settings.orthanc_url}/modalities/{modality_id}/store",
            json={"Resources": resource_ids, "Synchronous": synchronous},
            auth=(settings.orthanc_username, settings.orthanc_password),
            timeout=300,
        )
        resp.raise_for_status()
        return resp.json()


async def echo_modality(modality_id: str) -> bool:
    """Test connectivity to a remote modality via C-ECHO."""
    import httpx
    async with httpx.AsyncClient() as http:
        try:
            resp = await http.post(
                f"{settings.orthanc_url}/modalities/{modality_id}/echo",
                auth=(settings.orthanc_username, settings.orthanc_password),
                timeout=10,
            )
            return resp.status_code == 200
        except Exception:
            return False


async def register_modality(modality_id: str, aet: str, host: str, port: int):
    """Register a remote modality in Orthanc."""
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.put(
            f"{settings.orthanc_url}/modalities/{modality_id}",
            json={"AET": aet, "Host": host, "Port": port},
            auth=(settings.orthanc_username, settings.orthanc_password),
        )
        resp.raise_for_status()


async def delete_modality(modality_id: str):
    """Remove a remote modality from Orthanc."""
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.delete(
            f"{settings.orthanc_url}/modalities/{modality_id}",
            auth=(settings.orthanc_username, settings.orthanc_password),
        )
        resp.raise_for_status()
```

- [ ] **Step 2: Create backend/app/routers/patients.py**

```python
from fastapi import APIRouter, Depends, Request

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/patients", tags=["patients"])


@router.get("")
async def list_patients(
    request: Request,
    search: str = None,
    user: dict = Depends(get_current_user),
):
    await log_audit("list_patients", user_id=user["id"], ip_address=request.client.host)
    patients = await orthanc.get_patients()
    if search:
        search_lower = search.lower()
        patients = [
            p for p in patients
            if search_lower in str(p.get("MainDicomTags", {}).get("PatientName", "")).lower()
            or search_lower in str(p.get("MainDicomTags", {}).get("PatientID", "")).lower()
        ]
    return patients


@router.get("/{patient_id}")
async def get_patient(
    patient_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    await log_audit("view_patient", "patient", patient_id, user_id=user["id"], ip_address=request.client.host)
    patient = await orthanc.get_patient(patient_id)
    studies = await orthanc.get_patient_studies(patient_id)
    return {"patient": patient, "studies": studies}
```

- [ ] **Step 3: Create backend/app/routers/studies.py**

```python
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
import io

from app.routers.auth import get_current_user
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/studies", tags=["studies"])


@router.get("")
async def list_studies(
    request: Request,
    user: dict = Depends(get_current_user),
):
    await log_audit("list_studies", user_id=user["id"], ip_address=request.client.host)
    return await orthanc.get_studies()


@router.get("/{study_id}")
async def get_study(
    study_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    await log_audit("view_study", "study", study_id, user_id=user["id"], ip_address=request.client.host)
    study = await orthanc.get_study(study_id)
    series = await orthanc.get_study_series(study_id)
    return {"study": study, "series": series}


@router.get("/{study_id}/series/{series_id}")
async def get_series_detail(
    study_id: str,
    series_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    await log_audit("view_series", "series", series_id, user_id=user["id"], ip_address=request.client.host)
    series = await orthanc.get_series(series_id)
    instances = await orthanc.get_series_instances(series_id)
    return {"series": series, "instances": instances}


@router.get("/{study_id}/download")
async def download_study(
    study_id: str,
    request: Request,
    user: dict = Depends(get_current_user),
):
    await log_audit("download_study", "study", study_id, user_id=user["id"], ip_address=request.client.host)
    data = await orthanc.download_study(study_id)
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=study-{study_id}.zip"},
    )
```

- [ ] **Step 4: Register routers in main.py**

Add to `backend/app/main.py`:
```python
from app.routers.patients import router as patients_router
from app.routers.studies import router as studies_router

app.include_router(patients_router)
app.include_router(studies_router)
```

- [ ] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat: add Orthanc proxy endpoints for patients and studies"
```

---

### Task 4: Transfers, PACS Nodes, Shares

**Files:**
- Create: `backend/app/routers/transfers.py`
- Create: `backend/app/routers/pacs_nodes.py`
- Create: `backend/app/routers/shares.py`
- Create: `backend/app/models/transfers.py`
- Create: `backend/app/models/pacs_nodes.py`
- Create: `backend/app/models/shares.py`

- [ ] **Step 1: Create backend/app/models/pacs_nodes.py**

```python
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
```

- [ ] **Step 2: Create backend/app/routers/pacs_nodes.py**

```python
from fastapi import APIRouter, Depends, HTTPException, Request
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.pacs_nodes import PacsNodeCreate, PacsNodeUpdate
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/pacs-nodes", tags=["pacs-nodes"])


def _modality_id(name: str) -> str:
    """Convert display name to Orthanc modality ID (alphanumeric + hyphens)."""
    return name.lower().replace(" ", "-")


@router.get("")
async def list_nodes(db: aiosqlite.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    cursor = await db.execute("SELECT * FROM pacs_nodes ORDER BY name")
    return [dict(row) for row in await cursor.fetchall()]


@router.post("")
async def create_node(
    body: PacsNodeCreate,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute(
        "INSERT INTO pacs_nodes (name, ae_title, ip, port, description) VALUES (?, ?, ?, ?, ?)",
        (body.name, body.ae_title, body.ip, body.port, body.description),
    )
    await db.commit()
    node_id = cursor.lastrowid

    # Register in Orthanc
    modality_id = _modality_id(body.name)
    await orthanc.register_modality(modality_id, body.ae_title, body.ip, body.port)

    await log_audit("create_pacs_node", "pacs_node", str(node_id), user_id=user["id"], ip_address=request.client.host)
    return {"id": node_id}


@router.put("/{node_id}")
async def update_node(
    node_id: int,
    body: PacsNodeUpdate,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (node_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "Node not found")

    existing = dict(existing)
    updates = body.model_dump(exclude_none=True)
    for key, value in updates.items():
        existing[key] = value

    await db.execute(
        "UPDATE pacs_nodes SET name=?, ae_title=?, ip=?, port=?, description=?, is_active=? WHERE id=?",
        (existing["name"], existing["ae_title"], existing["ip"], existing["port"],
         existing["description"], existing["is_active"], node_id),
    )
    await db.commit()

    # Update in Orthanc
    modality_id = _modality_id(existing["name"])
    await orthanc.register_modality(modality_id, existing["ae_title"], existing["ip"], existing["port"])

    await log_audit("update_pacs_node", "pacs_node", str(node_id), user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}


@router.delete("/{node_id}")
async def delete_node(
    node_id: int,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (node_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "Node not found")

    existing = dict(existing)
    await db.execute("DELETE FROM pacs_nodes WHERE id = ?", (node_id,))
    await db.commit()

    # Remove from Orthanc
    modality_id = _modality_id(existing["name"])
    try:
        await orthanc.delete_modality(modality_id)
    except Exception:
        pass

    await log_audit("delete_pacs_node", "pacs_node", str(node_id), user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}


@router.post("/{node_id}/echo")
async def echo_node(
    node_id: int,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (node_id,))
    existing = await cursor.fetchone()
    if not existing:
        raise HTTPException(404, "Node not found")

    existing = dict(existing)
    modality_id = _modality_id(existing["name"])
    success = await orthanc.echo_modality(modality_id)

    await log_audit("echo_pacs_node", "pacs_node", str(node_id), user_id=user["id"], ip_address=request.client.host)
    return {"success": success}
```

- [ ] **Step 3: Create backend/app/models/transfers.py**

```python
from pydantic import BaseModel


class TransferRequest(BaseModel):
    study_id: str
    pacs_node_id: int
```

- [ ] **Step 4: Create backend/app/routers/transfers.py**

```python
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user
from app.routers.pacs_nodes import _modality_id
from app.models.transfers import TransferRequest
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/transfers", tags=["transfers"])


@router.get("")
async def list_transfers(
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute(
        """SELECT t.*, p.name as pacs_name, p.ae_title
           FROM transfer_log t
           JOIN pacs_nodes p ON t.pacs_node_id = p.id
           ORDER BY t.created_at DESC"""
    )
    return [dict(row) for row in await cursor.fetchall()]


@router.post("")
async def create_transfer(
    body: TransferRequest,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    # Verify PACS node exists
    cursor = await db.execute("SELECT * FROM pacs_nodes WHERE id = ? AND is_active = 1", (body.pacs_node_id,))
    node = await cursor.fetchone()
    if not node:
        raise HTTPException(404, "PACS node not found or inactive")
    node = dict(node)

    # Create log entry
    cursor = await db.execute(
        "INSERT INTO transfer_log (orthanc_study_id, pacs_node_id, initiated_by, status) VALUES (?, ?, ?, 'pending')",
        (body.study_id, body.pacs_node_id, user["id"]),
    )
    await db.commit()
    transfer_id = cursor.lastrowid

    # Send via Orthanc
    modality_id = _modality_id(node["name"])
    try:
        await orthanc.send_to_modality(modality_id, [body.study_id], synchronous=True)
        await db.execute(
            "UPDATE transfer_log SET status='success', completed_at=? WHERE id=?",
            (datetime.now(timezone.utc).isoformat(), transfer_id),
        )
    except Exception as e:
        await db.execute(
            "UPDATE transfer_log SET status='failed', error_message=?, completed_at=? WHERE id=?",
            (str(e), datetime.now(timezone.utc).isoformat(), transfer_id),
        )
    await db.commit()

    await log_audit("transfer_study", "study", body.study_id, user_id=user["id"], ip_address=request.client.host)

    cursor = await db.execute("SELECT * FROM transfer_log WHERE id = ?", (transfer_id,))
    return dict(await cursor.fetchone())


@router.post("/{transfer_id}/retry")
async def retry_transfer(
    transfer_id: int,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute("SELECT * FROM transfer_log WHERE id = ?", (transfer_id,))
    transfer = await cursor.fetchone()
    if not transfer:
        raise HTTPException(404, "Transfer not found")
    transfer = dict(transfer)

    if transfer["status"] != "failed":
        raise HTTPException(400, "Can only retry failed transfers")

    # Retry
    cursor2 = await db.execute("SELECT * FROM pacs_nodes WHERE id = ?", (transfer["pacs_node_id"],))
    node = dict(await cursor2.fetchone())
    modality_id = _modality_id(node["name"])

    await db.execute("UPDATE transfer_log SET status='pending', error_message=NULL, completed_at=NULL WHERE id=?", (transfer_id,))
    await db.commit()

    try:
        await orthanc.send_to_modality(modality_id, [transfer["orthanc_study_id"]], synchronous=True)
        await db.execute(
            "UPDATE transfer_log SET status='success', completed_at=? WHERE id=?",
            (datetime.now(timezone.utc).isoformat(), transfer_id),
        )
    except Exception as e:
        await db.execute(
            "UPDATE transfer_log SET status='failed', error_message=?, completed_at=? WHERE id=?",
            (str(e), datetime.now(timezone.utc).isoformat(), transfer_id),
        )
    await db.commit()

    await log_audit("retry_transfer", "transfer", str(transfer_id), user_id=user["id"], ip_address=request.client.host)

    cursor = await db.execute("SELECT * FROM transfer_log WHERE id = ?", (transfer_id,))
    return dict(await cursor.fetchone())
```

- [ ] **Step 5: Create backend/app/models/shares.py**

```python
from pydantic import BaseModel
from datetime import datetime


class ShareCreate(BaseModel):
    orthanc_patient_id: str
    expires_at: datetime | None = None  # None = no expiry


class ShareUpdate(BaseModel):
    expires_at: datetime | None = None
    is_active: bool | None = None
```

- [ ] **Step 6: Create backend/app/routers/shares.py**

```python
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.shares import ShareCreate, ShareUpdate
from app.services.auth import generate_share_token
from app.services import orthanc
from app.middleware.audit import log_audit

router = APIRouter(tags=["shares"])

# --- Authenticated endpoints ---

auth_router = APIRouter(prefix="/api/shares")


@auth_router.get("")
async def list_shares(db: aiosqlite.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    cursor = await db.execute("SELECT * FROM patient_shares ORDER BY created_at DESC")
    return [dict(row) for row in await cursor.fetchall()]


@auth_router.post("")
async def create_share(
    body: ShareCreate,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    token = generate_share_token()
    expires = body.expires_at.isoformat() if body.expires_at else None

    cursor = await db.execute(
        "INSERT INTO patient_shares (orthanc_patient_id, token, expires_at, created_by) VALUES (?, ?, ?, ?)",
        (body.orthanc_patient_id, token, expires, user["id"]),
    )
    await db.commit()

    await log_audit("create_share", "patient", body.orthanc_patient_id, user_id=user["id"], ip_address=request.client.host)
    return {"id": cursor.lastrowid, "token": token, "url": f"/patient-portal/{token}"}


@auth_router.put("/{share_id}")
async def update_share(
    share_id: int,
    body: ShareUpdate,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute("SELECT * FROM patient_shares WHERE id = ?", (share_id,))
    share = await cursor.fetchone()
    if not share:
        raise HTTPException(404, "Share not found")

    updates = body.model_dump(exclude_none=True)
    if "expires_at" in updates and updates["expires_at"]:
        updates["expires_at"] = updates["expires_at"].isoformat()

    for key, value in updates.items():
        await db.execute(f"UPDATE patient_shares SET {key} = ? WHERE id = ?", (value, share_id))
    await db.commit()

    await log_audit("update_share", "share", str(share_id), user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}


@auth_router.delete("/{share_id}")
async def revoke_share(
    share_id: int,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    await db.execute("UPDATE patient_shares SET is_active = 0 WHERE id = ?", (share_id,))
    await db.commit()

    await log_audit("revoke_share", "share", str(share_id), user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}


# --- Public patient portal endpoints ---

portal_router = APIRouter(prefix="/api/patient-portal")


async def _validate_token(token: str, db: aiosqlite.Connection) -> dict:
    cursor = await db.execute("SELECT * FROM patient_shares WHERE token = ?", (token,))
    share = await cursor.fetchone()
    if not share:
        raise HTTPException(404, "Link not found")

    share = dict(share)
    if not share["is_active"]:
        raise HTTPException(410, "This link has been revoked. Please contact the clinic.")

    if share["expires_at"]:
        expires = datetime.fromisoformat(share["expires_at"])
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) > expires:
            raise HTTPException(410, "This link has expired. Please contact the clinic.")

    # Update view stats
    now = datetime.now(timezone.utc).isoformat()
    if not share["first_viewed_at"]:
        await db.execute("UPDATE patient_shares SET first_viewed_at = ? WHERE id = ?", (now, share["id"]))
    await db.execute(
        "UPDATE patient_shares SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?",
        (now, share["id"]),
    )
    await db.commit()
    return share


@portal_router.get("/{token}")
async def patient_portal(
    token: str,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
):
    share = await _validate_token(token, db)
    patient = await orthanc.get_patient(share["orthanc_patient_id"])
    studies = await orthanc.get_patient_studies(share["orthanc_patient_id"])

    await log_audit("patient_view", "patient", share["orthanc_patient_id"],
                    patient_token=token, ip_address=request.client.host)
    return {"patient": patient, "studies": studies}


@portal_router.get("/{token}/studies/{study_id}/download")
async def patient_download(
    token: str,
    study_id: str,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
):
    share = await _validate_token(token, db)

    # Verify study belongs to this patient
    studies = await orthanc.get_patient_studies(share["orthanc_patient_id"])
    study_ids = [s.get("ID") for s in studies]
    if study_id not in study_ids:
        raise HTTPException(403, "Access denied")

    await log_audit("patient_download", "study", study_id,
                    patient_token=token, ip_address=request.client.host)

    import io
    from fastapi.responses import StreamingResponse
    data = await orthanc.download_study(study_id)
    return StreamingResponse(
        io.BytesIO(data),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=study-{study_id}.zip"},
    )


router.include_router(auth_router)
router.include_router(portal_router)
```

- [ ] **Step 7: Register routers in main.py**

Add to `backend/app/main.py`:
```python
from app.routers.transfers import router as transfers_router
from app.routers.pacs_nodes import router as pacs_nodes_router
from app.routers.shares import router as shares_router

app.include_router(transfers_router)
app.include_router(pacs_nodes_router)
app.include_router(shares_router)
```

- [ ] **Step 8: Commit**

```bash
git add backend/
git commit -m "feat: add transfers, PACS nodes, and patient sharing endpoints"
```

---

### Task 5: Settings, Viewers, Audit Endpoints

**Files:**
- Create: `backend/app/routers/settings.py`
- Create: `backend/app/routers/viewers.py`
- Create: `backend/app/routers/audit.py`
- Create: `backend/app/models/viewers.py`

- [ ] **Step 1: Create backend/app/routers/settings.py**

```python
from fastapi import APIRouter, Depends, Request
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
async def get_settings(db: aiosqlite.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    cursor = await db.execute("SELECT key, value FROM settings")
    rows = await cursor.fetchall()
    return {row["key"]: row["value"] for row in rows}


@router.put("")
async def update_settings(
    body: dict,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    for key, value in body.items():
        await db.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
            (key, str(value)),
        )
    await db.commit()

    await log_audit("update_settings", user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}
```

- [ ] **Step 2: Create backend/app/models/viewers.py**

```python
from pydantic import BaseModel


class ViewerCreate(BaseModel):
    name: str
    icon: str = ""
    url_scheme: str
    is_enabled: bool = True
    sort_order: int = 0


class ViewerUpdate(BaseModel):
    name: str | None = None
    icon: str | None = None
    url_scheme: str | None = None
    is_enabled: bool | None = None
    sort_order: int | None = None
```

- [ ] **Step 3: Create backend/app/routers/viewers.py**

```python
from fastapi import APIRouter, Depends, HTTPException, Request
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.viewers import ViewerCreate, ViewerUpdate
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/viewers", tags=["viewers"])


@router.get("")
async def list_viewers(db: aiosqlite.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    cursor = await db.execute("SELECT * FROM external_viewers ORDER BY sort_order, name")
    return [dict(row) for row in await cursor.fetchall()]


@router.post("")
async def create_viewer(
    body: ViewerCreate,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute(
        "INSERT INTO external_viewers (name, icon, url_scheme, is_enabled, sort_order) VALUES (?, ?, ?, ?, ?)",
        (body.name, body.icon, body.url_scheme, body.is_enabled, body.sort_order),
    )
    await db.commit()
    await log_audit("create_viewer", "viewer", str(cursor.lastrowid), user_id=user["id"], ip_address=request.client.host)
    return {"id": cursor.lastrowid}


@router.put("/{viewer_id}")
async def update_viewer(
    viewer_id: int,
    body: ViewerUpdate,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    cursor = await db.execute("SELECT * FROM external_viewers WHERE id = ?", (viewer_id,))
    if not await cursor.fetchone():
        raise HTTPException(404, "Viewer not found")

    updates = body.model_dump(exclude_none=True)
    for key, value in updates.items():
        await db.execute(f"UPDATE external_viewers SET {key} = ? WHERE id = ?", (value, viewer_id))
    await db.commit()
    await log_audit("update_viewer", "viewer", str(viewer_id), user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}


@router.delete("/{viewer_id}")
async def delete_viewer(
    viewer_id: int,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    await db.execute("DELETE FROM external_viewers WHERE id = ?", (viewer_id,))
    await db.commit()
    await log_audit("delete_viewer", "viewer", str(viewer_id), user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}
```

- [ ] **Step 4: Create backend/app/routers/audit.py**

```python
from fastapi import APIRouter, Depends, Query
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user

router = APIRouter(prefix="/api/audit-log", tags=["audit"])


@router.get("")
async def get_audit_log(
    user: dict = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
    action: str = None,
    user_id: int = None,
    date_from: str = None,
    date_to: str = None,
    limit: int = Query(default=100, le=1000),
    offset: int = 0,
):
    query = "SELECT * FROM audit_log WHERE 1=1"
    params = []

    if action:
        query += " AND action = ?"
        params.append(action)
    if user_id:
        query += " AND user_id = ?"
        params.append(user_id)
    if date_from:
        query += " AND timestamp >= ?"
        params.append(date_from)
    if date_to:
        query += " AND timestamp <= ?"
        params.append(date_to)

    query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    cursor = await db.execute(query, params)
    rows = [dict(row) for row in await cursor.fetchall()]

    # Total count
    count_query = "SELECT COUNT(*) as total FROM audit_log WHERE 1=1"
    count_params = []
    if action:
        count_query += " AND action = ?"
        count_params.append(action)
    if user_id:
        count_query += " AND user_id = ?"
        count_params.append(user_id)
    if date_from:
        count_query += " AND timestamp >= ?"
        count_params.append(date_from)
    if date_to:
        count_query += " AND timestamp <= ?"
        count_params.append(date_to)

    cursor = await db.execute(count_query, count_params)
    total = (await cursor.fetchone())["total"]

    return {"items": rows, "total": total}
```

- [ ] **Step 5: Create backend/app/routers/users.py (user management)**

```python
from fastapi import APIRouter, Depends, HTTPException, Request
import aiosqlite

from app.database import get_db
from app.routers.auth import get_current_user
from app.services.auth import hash_password
from app.models.auth import LoginRequest
from app.middleware.audit import log_audit

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("")
async def list_users(db: aiosqlite.Connection = Depends(get_db), user: dict = Depends(get_current_user)):
    cursor = await db.execute("SELECT id, username, created_at, last_login FROM users")
    return [dict(row) for row in await cursor.fetchall()]


@router.post("")
async def create_user(
    body: LoginRequest,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    try:
        cursor = await db.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            (body.username, hash_password(body.password)),
        )
        await db.commit()
        await log_audit("create_user", "user", str(cursor.lastrowid), user_id=user["id"], ip_address=request.client.host)
        return {"id": cursor.lastrowid}
    except Exception:
        raise HTTPException(409, "Username already exists")


@router.delete("/{target_id}")
async def delete_user(
    target_id: int,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    if target_id == user["id"]:
        raise HTTPException(400, "Cannot delete yourself")
    await db.execute("DELETE FROM users WHERE id = ?", (target_id,))
    await db.commit()
    await log_audit("delete_user", "user", str(target_id), user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}


@router.post("/{target_id}/revoke-tokens")
async def revoke_tokens(
    target_id: int,
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    await db.execute("UPDATE users SET token_version = token_version + 1 WHERE id = ?", (target_id,))
    await db.commit()
    await log_audit("revoke_tokens", "user", str(target_id), user_id=user["id"], ip_address=request.client.host)
    return {"status": "ok"}
```

- [ ] **Step 6: Register all remaining routers in main.py**

Final `backend/app/main.py`:
```python
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import init_db
from app.routers.auth import router as auth_router
from app.routers.patients import router as patients_router
from app.routers.studies import router as studies_router
from app.routers.transfers import router as transfers_router
from app.routers.pacs_nodes import router as pacs_nodes_router
from app.routers.shares import router as shares_router
from app.routers.settings import router as settings_router
from app.routers.viewers import router as viewers_router
from app.routers.audit import router as audit_router
from app.routers.users import router as users_router


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
app.include_router(transfers_router)
app.include_router(pacs_nodes_router)
app.include_router(shares_router)
app.include_router(settings_router)
app.include_router(viewers_router)
app.include_router(audit_router)
app.include_router(users_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
```

- [ ] **Step 7: Test that server starts with all routers**

```bash
cd /Users/timur/projectos/minipacs/backend
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 48922 --reload
```

Visit `http://localhost:48922/docs` — should show all endpoints in Swagger UI.

- [ ] **Step 8: Commit**

```bash
git add backend/
git commit -m "feat: add settings, viewers, audit, user management endpoints"
```

---

## Chunk 2: Orthanc Configuration and Frontend

### Task 6: Orthanc Configuration

**Files:**
- Create: `orthanc/orthanc.json`
- Create: `orthanc/README.md`

- [ ] **Step 1: Create orthanc/orthanc.json**

```json
{
  "Name": "MiniPACS",
  "StorageDirectory": "/var/lib/orthanc/db",
  "IndexDirectory": "/var/lib/orthanc/db",
  "StorageCompression": true,
  "DicomServerEnabled": true,
  "DicomAet": "MINIPACS",
  "DicomPort": 48924,
  "DefaultEncoding": "Latin1",
  "HttpServerEnabled": true,
  "HttpPort": 48923,
  "RemoteAccessAllowed": false,
  "AuthenticationEnabled": true,
  "RegisteredUsers": {
    "orthanc": "orthanc"
  },
  "DicomModalitiesInDatabase": true,
  "DicomModalities": {},
  "StableAge": 60,
  "DicomAssociationCloseDelay": 5,
  "MaximumStorageSize": 0,
  "MaximumPatientCount": 0,
  "LimitFindResults": 100,
  "LimitFindInstances": 100,
  "KeepAlive": true,
  "HttpTimeout": 60,
  "DicomScuTimeout": 30,
  "Plugins": [
    "/usr/share/orthanc/plugins/libOrthancDicomWeb.so"
  ],
  "DicomWeb": {
    "Enable": true,
    "Root": "/dicom-web/",
    "EnableWado": true,
    "WadoRoot": "/wado",
    "Host": "0.0.0.0",
    "Ssl": false,
    "StudiesMetadata": "MainDicomTags",
    "SeriesMetadata": "Full"
  }
}
```

- [ ] **Step 2: Create orthanc/README.md with installation instructions**

```markdown
# Orthanc Setup

## Install on macOS (for development)
```
brew install orthanc
brew install orthanc-dicomweb
```

## Install on Ubuntu/Debian (for production)
```
sudo apt-get install orthanc orthanc-dicomweb
```

## Configuration
Copy `orthanc.json` to Orthanc config directory:
- macOS: `/usr/local/etc/orthanc/`
- Linux: `/etc/orthanc/`

## Start Orthanc
```
Orthanc /path/to/orthanc.json
```

## Verify
- HTTP API: http://localhost:48923
- DICOM port: 48924
- DICOMweb: http://localhost:48923/dicom-web/
```

- [ ] **Step 3: Commit**

```bash
git add orthanc/
git commit -m "feat: add Orthanc configuration with DICOMweb plugin"
```

---

### Task 7: Initialize React Frontend

**Files:**
- Create: `frontend/` (via Vite)
- Create: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/auth.ts`

- [ ] **Step 1: Create React app with Vite**

```bash
cd /Users/timur/projectos/minipacs
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
```

- [ ] **Step 2: Install dependencies**

```bash
cd /Users/timur/projectos/minipacs/frontend
npm install @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-select @radix-ui/react-tabs @radix-ui/react-toast @radix-ui/react-tooltip @radix-ui/react-popover @radix-ui/react-switch @radix-ui/react-label @radix-ui/react-separator @radix-ui/react-slot
npm install class-variance-authority clsx tailwind-merge
npm install lucide-react
npm install tailwindcss @tailwindcss/vite
npm install react-router-dom
npm install axios
npm install date-fns
npm install @tanstack/react-table
```

- [ ] **Step 3: Initialize shadcn/ui**

```bash
cd /Users/timur/projectos/minipacs/frontend
npx shadcn@latest init
```

Select: TypeScript, Default style, Neutral color, CSS variables. Then add components:

```bash
npx shadcn@latest add button card input label table dialog select tabs toast dropdown-menu badge separator switch popover tooltip scroll-area sheet
```

- [ ] **Step 4: Create frontend/src/lib/api.ts**

```typescript
import axios from "axios";

const api = axios.create({
  baseURL: "/api",
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      const refreshToken = localStorage.getItem("refresh_token");
      if (refreshToken && !error.config._retry) {
        error.config._retry = true;
        try {
          const { data } = await axios.post("/api/auth/refresh", {
            refresh_token: refreshToken,
          });
          localStorage.setItem("access_token", data.access_token);
          localStorage.setItem("refresh_token", data.refresh_token);
          error.config.headers.Authorization = `Bearer ${data.access_token}`;
          return api(error.config);
        } catch {
          localStorage.removeItem("access_token");
          localStorage.removeItem("refresh_token");
          window.location.href = "/login";
        }
      } else {
        localStorage.removeItem("access_token");
        localStorage.removeItem("refresh_token");
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

export default api;
```

- [ ] **Step 5: Create frontend/src/lib/auth.ts**

```typescript
import { createContext, useContext } from "react";

export interface User {
  id: number;
  username: string;
  created_at: string;
  last_login: string | null;
}

export interface AuthContextType {
  user: User | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

export const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
```

- [ ] **Step 6: Update vite.config.ts for proxy**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 48925,
    proxy: {
      "/api": {
        target: "http://localhost:48922",
        changeOrigin: true,
      },
      "/dicom-web": {
        target: "http://localhost:48923",
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 7: Commit**

```bash
git add frontend/
git commit -m "feat: initialize React frontend with shadcn/ui, routing, API client"
```

---

### Task 8: Auth Provider and Layout

**Files:**
- Create: `frontend/src/providers/AuthProvider.tsx`
- Create: `frontend/src/components/layout/AppLayout.tsx`
- Create: `frontend/src/components/layout/Sidebar.tsx`
- Create: `frontend/src/pages/LoginPage.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Create frontend/src/providers/AuthProvider.tsx**

```typescript
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { AuthContext, type User } from "@/lib/auth";
import api from "@/lib/api";

const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    api.post("/auth/logout").catch(() => {});
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    setUser(null);
  }, []);

  // Auto-logout on inactivity
  useEffect(() => {
    if (!user) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(logout, INACTIVITY_TIMEOUT);
    };
    const events = ["mousedown", "keydown", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [user, logout]);

  useEffect(() => {
    const token = localStorage.getItem("access_token");
    if (token) {
      api
        .get("/auth/me")
        .then(({ data }) => setUser(data))
        .catch(() => {
          localStorage.removeItem("access_token");
          localStorage.removeItem("refresh_token");
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (username: string, password: string) => {
    const { data } = await api.post("/auth/login", { username, password });
    localStorage.setItem("access_token", data.access_token);
    localStorage.setItem("refresh_token", data.refresh_token);
    const { data: me } = await api.get("/auth/me");
    setUser(me);
  };

  if (loading) return null;

  return (
    <AuthContext.Provider value={{ user, login, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}
```

- [ ] **Step 2: Create frontend/src/components/layout/Sidebar.tsx**

```typescript
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Users, FileImage, Send, Share2,
  Network, Settings, ScrollText, LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/patients", icon: Users, label: "Patients" },
  { to: "/studies", icon: FileImage, label: "Studies" },
  { to: "/transfers", icon: Send, label: "Transfers" },
  { to: "/shares", icon: Share2, label: "Shares" },
  { to: "/pacs-nodes", icon: Network, label: "PACS Nodes" },
  { to: "/audit", icon: ScrollText, label: "Audit Log" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar() {
  const location = useLocation();
  const { logout, user } = useAuth();

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-background">
      <div className="flex h-14 items-center border-b px-4">
        <h1 className="text-lg font-semibold tracking-tight">MiniPACS</h1>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {nav.map(({ to, icon: Icon, label }) => (
          <Link key={to} to={to}>
            <Button
              variant="ghost"
              className={cn(
                "w-full justify-start gap-2",
                location.pathname === to && "bg-accent"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Button>
          </Link>
        ))}
      </nav>
      <div className="border-t p-2">
        <div className="mb-2 px-3 text-xs text-muted-foreground">{user?.username}</div>
        <Button variant="ghost" className="w-full justify-start gap-2" onClick={logout}>
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Create frontend/src/components/layout/AppLayout.tsx**

```typescript
import { Outlet, Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Create frontend/src/pages/LoginPage.tsx**

```typescript
import { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (isAuthenticated) return <Navigate to="/" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(username, password);
      navigate("/");
    } catch {
      setError("Invalid credentials");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-semibold tracking-tight">MiniPACS</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 5: Create App.tsx with routing**

```typescript
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/providers/AuthProvider";
import { AppLayout } from "@/components/layout/AppLayout";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { PatientsPage } from "@/pages/PatientsPage";
import { PatientDetailPage } from "@/pages/PatientDetailPage";
import { StudiesPage } from "@/pages/StudiesPage";
import { StudyDetailPage } from "@/pages/StudyDetailPage";
import { TransfersPage } from "@/pages/TransfersPage";
import { SharesPage } from "@/pages/SharesPage";
import { PacsNodesPage } from "@/pages/PacsNodesPage";
import { AuditPage } from "@/pages/AuditPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { PatientPortalPage } from "@/pages/PatientPortalPage";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/patient-portal/:token" element={<PatientPortalPage />} />
          <Route element={<AppLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/patients" element={<PatientsPage />} />
            <Route path="/patients/:id" element={<PatientDetailPage />} />
            <Route path="/studies" element={<StudiesPage />} />
            <Route path="/studies/:id" element={<StudyDetailPage />} />
            <Route path="/transfers" element={<TransfersPage />} />
            <Route path="/shares" element={<SharesPage />} />
            <Route path="/pacs-nodes" element={<PacsNodesPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "feat: add auth provider, layout with sidebar, login page, routing"
```

---

### Task 9: Dashboard Page

**Files:**
- Create: `frontend/src/pages/DashboardPage.tsx`

- [ ] **Step 1: Create DashboardPage.tsx**

```typescript
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileImage, Users, Send, Share2, AlertCircle, Eye } from "lucide-react";
import api from "@/lib/api";

interface Stats {
  totalPatients: number;
  totalStudies: number;
  recentTransfers: any[];
  activeShares: any[];
}

export function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    Promise.all([
      api.get("/patients"),
      api.get("/studies"),
      api.get("/transfers"),
      api.get("/shares"),
    ]).then(([patients, studies, transfers, shares]) => {
      setStats({
        totalPatients: patients.data.length,
        totalStudies: studies.data.length,
        recentTransfers: transfers.data.slice(0, 5),
        activeShares: shares.data.filter((s: any) => s.is_active),
      });
    });
  }, []);

  if (!stats) return <div className="text-muted-foreground">Loading...</div>;

  const failedTransfers = stats.recentTransfers.filter((t) => t.status === "failed");
  const unviewedShares = stats.activeShares.filter((s) => s.view_count === 0);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Patients</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalPatients}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Studies</CardTitle>
            <FileImage className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalStudies}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failed Transfers</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{failedTransfers.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unviewed Shares</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{unviewedShares.length}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Recent Transfers</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.recentTransfers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transfers yet</p>
            ) : (
              <div className="space-y-2">
                {stats.recentTransfers.map((t) => (
                  <div key={t.id} className="flex items-center justify-between text-sm">
                    <span>{t.pacs_name}</span>
                    <span className={t.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                      {t.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Active Patient Shares</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.activeShares.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active shares</p>
            ) : (
              <div className="space-y-2">
                {stats.activeShares.slice(0, 5).map((s) => (
                  <div key={s.id} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs">{s.token.slice(0, 12)}...</span>
                    <span className="text-muted-foreground">
                      {s.view_count} views
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/
git commit -m "feat: add dashboard page with stats cards"
```

---

### Task 10: Patients Pages

**Files:**
- Create: `frontend/src/pages/PatientsPage.tsx`
- Create: `frontend/src/pages/PatientDetailPage.tsx`

- [ ] **Step 1: Create PatientsPage.tsx**

```typescript
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Search } from "lucide-react";
import api from "@/lib/api";

export function PatientsPage() {
  const [patients, setPatients] = useState<any[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.get("/patients", { params: search ? { search } : {} }).then(({ data }) => setPatients(data));
  }, [search]);

  const tag = (p: any, key: string) => p?.MainDicomTags?.[key] || "";

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight">Patients</h2>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name or ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Patient ID</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Birth Date</TableHead>
            <TableHead>Sex</TableHead>
            <TableHead>Studies</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {patients.map((p) => (
            <TableRow key={p.ID} className="cursor-pointer hover:bg-accent">
              <TableCell>
                <Link to={`/patients/${p.ID}`} className="font-mono text-sm">
                  {tag(p, "PatientID")}
                </Link>
              </TableCell>
              <TableCell>
                <Link to={`/patients/${p.ID}`}>{tag(p, "PatientName")}</Link>
              </TableCell>
              <TableCell>{tag(p, "PatientBirthDate")}</TableCell>
              <TableCell>{tag(p, "PatientSex")}</TableCell>
              <TableCell>{p.Studies?.length || 0}</TableCell>
            </TableRow>
          ))}
          {patients.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No patients found
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Create PatientDetailPage.tsx**

```typescript
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileImage, Send, Share2, Eye } from "lucide-react";
import api from "@/lib/api";

export function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [transfers, setTransfers] = useState<any[]>([]);
  const [shares, setShares] = useState<any[]>([]);

  useEffect(() => {
    api.get(`/patients/${id}`).then(({ data }) => setData(data));
    api.get("/transfers").then(({ data }) =>
      setTransfers(data.filter((t: any) => t.orthanc_study_id && data?.studies?.some((s: any) => s.ID === t.orthanc_study_id)))
    );
    api.get("/shares").then(({ data }) =>
      setShares(data.filter((s: any) => s.orthanc_patient_id === id))
    );
  }, [id]);

  if (!data) return <div className="text-muted-foreground">Loading...</div>;

  const { patient, studies } = data;
  const tag = (obj: any, key: string) => obj?.MainDicomTags?.[key] || "";

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold tracking-tight">{tag(patient, "PatientName")}</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Patient Information</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Patient ID</dt>
              <dd className="font-mono">{tag(patient, "PatientID")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Birth Date</dt>
              <dd>{tag(patient, "PatientBirthDate")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sex</dt>
              <dd>{tag(patient, "PatientSex")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Total Studies</dt>
              <dd>{studies.length}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Studies</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Modality</TableHead>
                <TableHead>Accession</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studies.map((s: any) => (
                <TableRow key={s.ID}>
                  <TableCell>{tag(s, "StudyDate")}</TableCell>
                  <TableCell>{tag(s, "StudyDescription")}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{tag(s, "ModalitiesInStudy") || "—"}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{tag(s, "AccessionNumber")}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" asChild>
                        <Link to={`/studies/${s.ID}`}>
                          <Eye className="h-4 w-4" />
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Patient Shares</CardTitle>
        </CardHeader>
        <CardContent>
          {shares.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shares for this patient</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Token</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Views</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shares.map((s: any) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.token.slice(0, 16)}...</TableCell>
                    <TableCell>
                      <Badge variant={s.is_active ? "default" : "secondary"}>
                        {s.is_active ? "Active" : "Revoked"}
                      </Badge>
                    </TableCell>
                    <TableCell>{s.view_count}</TableCell>
                    <TableCell>{s.created_at}</TableCell>
                    <TableCell>{s.expires_at || "No expiry"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/
git commit -m "feat: add patients list and patient detail pages"
```

---

### Task 11: Studies, Transfers, Shares, PACS Nodes, Audit, Settings Pages

Due to the length of this plan, the remaining frontend pages follow the same pattern as Tasks 9-10. Each page:

**Files to create:**
- `frontend/src/pages/StudiesPage.tsx` — table of all studies with filters (date, modality), link to detail
- `frontend/src/pages/StudyDetailPage.tsx` — study info, series list, OHIF viewer embed, send/download buttons, external viewer buttons
- `frontend/src/pages/TransfersPage.tsx` — transfer log table with status badges, retry button for failed
- `frontend/src/pages/SharesPage.tsx` — all shares with status (active/expired/revoked), view count, actions (revoke/extend/copy link), create new share dialog with expiry picker
- `frontend/src/pages/PacsNodesPage.tsx` — PACS directory table, add/edit dialog, C-ECHO test button
- `frontend/src/pages/AuditPage.tsx` — audit log table with filters (date range, action, user), pagination
- `frontend/src/pages/SettingsPage.tsx` — tabbed settings: General, Orthanc, OHIF, Users, External Viewers
- `frontend/src/pages/PatientPortalPage.tsx` — public patient view (validates token, shows profile + studies + viewer + download)

- [ ] **Step 1: Create StudiesPage.tsx** — table listing all studies from `/api/studies`, columns: Date, Patient, Description, Modality, Accession, Series count. Click navigates to detail.

- [ ] **Step 2: Create StudyDetailPage.tsx** — shows study DICOM metadata, series table, embedded OHIF iframe (`/ohif/viewer?StudyInstanceUIDs={uid}`), buttons: "Send to PACS" (opens dialog to pick node), "Download ZIP", external viewer buttons (from `/api/viewers` where is_enabled=true).

- [ ] **Step 3: Create TransfersPage.tsx** — table from `/api/transfers`, columns: Study, Destination (PACS name + AE Title), Status (badge: green/red/yellow), Created, Completed, Duration. Retry button on failed rows.

- [ ] **Step 4: Create SharesPage.tsx** — table from `/api/shares`, columns: Patient ID, Token (truncated + copy button), Status (active/expired/revoked), Views, First Viewed, Last Viewed, Expires, Actions (revoke/extend). "New Share" dialog with patient selector and expiry picker (preset options + custom date).

- [ ] **Step 5: Create PacsNodesPage.tsx** — table from `/api/pacs-nodes`, columns: Name, AE Title, IP, Port, Status. Actions: Edit (dialog), Delete, Test Connection (C-ECHO with success/fail toast). "Add Node" button.

- [ ] **Step 6: Create AuditPage.tsx** — table from `/api/audit-log`, columns: Timestamp, User, Action, Resource, IP. Filters: date range, action type dropdown, user dropdown. Pagination.

- [ ] **Step 7: Create SettingsPage.tsx** — tabs:
  - **General**: portal name, auto-logout timeout
  - **Users**: table of users, add/delete, revoke tokens
  - **External Viewers**: table, add/edit/delete/enable/disable, reorder

- [ ] **Step 8: Create PatientPortalPage.tsx** — fetches `/api/patient-portal/{token}`, shows patient info card, studies timeline, each study expandable with OHIF embed + download button. On expired/revoked token shows clear error message.

- [ ] **Step 9: Commit each page separately**

```bash
git commit -m "feat: add studies pages with OHIF viewer integration"
git commit -m "feat: add transfers page with retry"
git commit -m "feat: add shares management page"
git commit -m "feat: add PACS nodes management page"
git commit -m "feat: add audit log page"
git commit -m "feat: add settings page with tabs"
git commit -m "feat: add patient portal page"
```

---

## Chunk 3: OHIF Integration, nginx, Final Setup

### Task 12: OHIF Viewer Integration

**Files:**
- Create: `frontend/src/components/viewer/OhifViewer.tsx`
- Modify: `frontend/src/pages/StudyDetailPage.tsx`

- [ ] **Step 1: Build OHIF for embedding**

```bash
cd /Users/timur/projectos/minipacs
git clone https://github.com/OHIF/Viewers.git ohif-source
cd ohif-source
yarn install --frozen-lockfile
```

- [ ] **Step 2: Create OHIF config for our Orthanc**

Create `ohif-source/platform/app/.env`:
```
VITE_APP_CONFIG=config/orthanc.js
```

Create `ohif-source/platform/app/public/config/orthanc.js`:
```javascript
window.config = {
  routerBasename: "/ohif",
  extensions: [],
  modes: [],
  showStudyList: false,
  dataSources: [
    {
      namespace: "@ohif/extension-default.dataSourcesModule.dicomweb",
      sourceName: "dicomweb",
      configuration: {
        friendlyName: "MiniPACS Orthanc",
        name: "orthanc",
        wadoUriRoot: "/dicom-web",
        qidoRoot: "/dicom-web",
        wadoRoot: "/dicom-web",
        qidoSupportsIncludeField: false,
        supportsReject: false,
        imageRendering: "wadors",
        thumbnailRendering: "wadors",
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: true,
        bulkDataURI: {
          enabled: true,
        },
      },
    },
  ],
  defaultDataSourceName: "dicomweb",
};
```

- [ ] **Step 3: Build OHIF**

```bash
cd /Users/timur/projectos/minipacs/ohif-source
PUBLIC_URL=/ohif/ yarn run build
```

Copy built files:
```bash
mkdir -p /Users/timur/projectos/minipacs/ohif-dist
cp -r ohif-source/platform/app/dist/* ohif-dist/
```

- [ ] **Step 4: Create OhifViewer.tsx component**

```typescript
interface OhifViewerProps {
  studyInstanceUID: string;
  className?: string;
}

export function OhifViewer({ studyInstanceUID, className }: OhifViewerProps) {
  const src = `/ohif/viewer?StudyInstanceUIDs=${studyInstanceUID}`;

  return (
    <iframe
      src={src}
      className={className || "h-[600px] w-full rounded-lg border"}
      allow="fullscreen"
      title="DICOM Viewer"
    />
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/viewer/ ohif-dist/
git commit -m "feat: integrate OHIF viewer as embedded iframe"
```

---

### Task 13: nginx Configuration

**Files:**
- Create: `nginx/nginx.conf`

- [ ] **Step 1: Create nginx/nginx.conf**

```nginx
server {
    listen 48920;
    server_name _;

    # Redirect HTTP to HTTPS
    return 301 https://$host:48921$request_uri;
}

server {
    listen 48921 ssl;
    server_name _;

    ssl_certificate     /etc/ssl/minipacs/cert.pem;
    ssl_certificate_key /etc/ssl/minipacs/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    client_max_body_size 500M;

    # React frontend
    location / {
        root /Users/timur/projectos/minipacs/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # FastAPI backend
    location /api/ {
        proxy_pass http://127.0.0.1:48922;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # Orthanc DICOMweb (proxied, not directly exposed)
    location /dicom-web/ {
        proxy_pass http://127.0.0.1:48923/dicom-web/;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic b3J0aGFuYzpvcnRoYW5j";
        proxy_read_timeout 300s;
    }

    # OHIF Viewer (static)
    location /ohif/ {
        alias /Users/timur/projectos/minipacs/ohif-dist/;
        try_files $uri $uri/ /ohif/index.html;
    }
}
```

- [ ] **Step 2: Generate self-signed cert for development**

```bash
mkdir -p /etc/ssl/minipacs
openssl req -x509 -newkey rsa:4096 -keyout /etc/ssl/minipacs/key.pem \
  -out /etc/ssl/minipacs/cert.pem -days 365 -nodes \
  -subj "/CN=minipacs.local"
```

- [ ] **Step 3: Commit**

```bash
git add nginx/
git commit -m "feat: add nginx reverse proxy configuration with HTTPS"
```

---

### Task 14: Final Assembly and Testing

- [ ] **Step 1: Build React frontend**

```bash
cd /Users/timur/projectos/minipacs/frontend
npm run build
```

- [ ] **Step 2: Start all services**

```bash
# Terminal 1: Orthanc
Orthanc /Users/timur/projectos/minipacs/orthanc/orthanc.json

# Terminal 2: FastAPI
cd /Users/timur/projectos/minipacs/backend
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 48922

# Terminal 3: nginx
sudo nginx -c /Users/timur/projectos/minipacs/nginx/nginx.conf
```

- [ ] **Step 3: Create admin user**

```bash
cd /Users/timur/projectos/minipacs/backend
source .venv/bin/activate
python -m app.create_user admin <secure-password>
```

- [ ] **Step 4: Test complete flow**

1. Open `https://localhost:48921` — should see login page
2. Log in with admin credentials
3. Dashboard should load (empty data from Orthanc)
4. Navigate through all pages — verify no errors
5. Add a PACS node, test C-ECHO
6. Create a patient share link, open in incognito — verify patient portal
7. Check audit log — all actions should be recorded
8. Test auto-logout after inactivity

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete MiniPACS Portal v1.0 — production ready"
```
