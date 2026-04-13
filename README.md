<h1 align="center">MiniPACS</h1>

<p align="center">
  <strong>Full-featured PACS portal for independent medical clinics</strong>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#development">Development</a> ·
  <a href="#deployment">Production Deployment</a> ·
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DICOM-compatible-blue" alt="DICOM" />
  <img src="https://img.shields.io/badge/HIPAA-compliant-green" alt="HIPAA" />
  <img src="https://img.shields.io/badge/license-BSL_1.1-orange" alt="License" />
  <img src="https://img.shields.io/badge/TypeScript-React-blue" alt="React" />
  <img src="https://img.shields.io/badge/Python-FastAPI-009688" alt="FastAPI" />
</p>

---

## Why MiniPACS?

Solo and small clinics pay $150–$2,000/month for cloud PACS solutions that are overengineered for their needs. MiniPACS is a **self-hosted** alternative that gives you:

- Full DICOM storage and viewing — no cloud dependency, no per-study fees
- Patient portal with secure sharing — QR codes, PIN protection, email integration
- Study transfers between facilities — C-STORE with retry and error handling
- Professional admin interface — dark mode, collapsible sidebar, mobile responsive
- HIPAA-ready — audit logging, session management, encrypted storage

**One server. Zero recurring fees. Your data stays in your clinic.**

---

## Features

### DICOM Imaging
- Receive studies from MRI, CT, X-ray, Ultrasound equipment via **C-STORE**
- View studies in the built-in **OHIF DICOM Viewer** (zero-footprint, web-based)
- Fullscreen viewer mode with keyboard controls
- Support for all modalities: CT, MR, US, XR, DX, MG, NM, PT, RF, XA
- Series-level download in DICOM or JPEG format

### Worklist & Study Management
- Server-side search, filtering, and pagination
- Filter by modality, date range (presets + custom), patient name
- Click any study to view details, series breakdown, and launch viewer

### Patient Portal
- Secure share links with configurable expiry (7/14/30/90 days)
- Optional PIN protection with server-side enforcement (httponly cookies)
- QR code generation for easy sharing
- Email integration — pre-filled mailto with study details and portal link
- Mobile-first responsive design
- Patient-friendly JPEG download option

### PACS Transfers
- Send studies to other PACS nodes via DICOM C-STORE
- C-ECHO connectivity testing before sending
- Real-time transfer status tracking with auto-refresh
- Retry failed transfers with human-readable error messages

### Security & Compliance
- JWT authentication with token versioning and instant revocation
- Session timeout with 60-second warning modal (HIPAA requirement)
- Immutable audit log with CSV export
- Rate limiting on login attempts
- Content Security Policy, HSTS, X-Frame-Options headers
- DICOMweb access restricted to clinic LAN only

---

## Screenshots

### Dashboard & Worklist

| Dashboard | Worklist |
|-----------|----------|
| ![Dashboard](docs/assets/screenshots/dashboard.png) | ![Worklist](docs/assets/screenshots/worklist.png) |

### Patients & Study Viewer

| Patients | Study Detail + Share |
|----------|---------------------|
| ![Patients](docs/assets/screenshots/patients.png) | ![Study](docs/assets/screenshots/study-share.png) |

### Patient Sharing

| QR Code + Link | Patient Portal |
|---------------|----------------|
| ![QR](docs/assets/screenshots/share-qr.png) | ![Portal](docs/assets/screenshots/patient-portal.png) |

### Transfers & Shares

| Transfers | Patient Shares |
|-----------|---------------|
| ![Transfers](docs/assets/screenshots/transfers.png) | ![Shares](docs/assets/screenshots/shares.png) |

### Admin

| PACS Nodes | Settings — External Viewers |
|------------|---------------------------|
| ![PACS](docs/assets/screenshots/pacs-nodes.png) | ![Viewers](docs/assets/screenshots/settings-viewers.png) |

### Dark Mode

| Patients (Dark) | Audit Log |
|----------------|-----------|
| ![Dark](docs/assets/screenshots/patients-dark.png) | ![Audit](docs/assets/screenshots/audit-log.png) |

---

## Architecture

```
[MRI / CT / X-ray Equipment]
        │ DICOM C-STORE (:48924)
        ▼
┌─── Docker Compose ──────────────────────────────┐
│                                                  │
│  [Orthanc PACS]         internals: 8042 / 4242   │
│       │ REST + DICOMweb                          │
│       ▼                                          │
│  [FastAPI Backend]      internal: 8000            │
│       │ JSON API                                 │
│       ▼                                          │
│  [nginx + React + OHIF] :48920 HTTP → :48921 HTTPS│
│       /         → React SPA                      │
│       /api/     → FastAPI                        │
│       /dicom-web/ → Orthanc DICOMweb             │
│       /ohif/    → OHIF Viewer                    │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Three containers

| Container | Image | Purpose |
|-----------|-------|---------|
| `orthanc` | `orthancteam/orthanc` | PACS server — DICOM storage, DICOMweb API |
| `backend` | Custom (python:3.12-slim) | FastAPI — auth, API, business logic, SQLite |
| `frontend` | Custom (node build → nginx:alpine) | nginx reverse proxy + React SPA + OHIF Viewer |

### Ports exposed to host

| Port | Protocol | Purpose |
|------|----------|---------|
| **48921** | HTTPS | **Main entry point** — portal, API, viewer |
| 48920 | HTTP | Redirects to HTTPS |
| 48922 | HTTP | Backend API (for development only) |
| 48923 | HTTP | Orthanc HTTP API (for development only) |
| 48924 | DICOM | C-STORE / C-ECHO from imaging equipment |

### Data persistence (Docker volumes)

| Volume | Path in container | Contents |
|--------|-------------------|----------|
| `orthanc-data` | `/var/lib/orthanc/db` | DICOM images + Orthanc index |
| `minipacs-db` | `/app/data` | SQLite database (users, shares, audit, settings) |

---

## Quick Start

### Prerequisites

- **Docker** and **Docker Compose** (Docker Desktop or standalone)

### 1. Clone and configure

```bash
git clone https://github.com/tr00x/MiniPACS.git
cd MiniPACS

# Create .env from template
cp .env.docker .env
```

Edit `.env` — set all values:

```env
SECRET_KEY=<generate: python3 -c "import secrets; print(secrets.token_urlsafe(32))">
ORTHANC_USERNAME=orthanc
ORTHANC_PASSWORD=<strong password>
# Generate: printf 'orthanc:<your password>' | base64
ORTHANC_BASIC_AUTH=<base64 of username:password>
```

### 2. Build and start

```bash
docker compose build
docker compose up -d
```

### 3. Create admin user

```bash
docker exec minipacs-backend-1 python3 -c "
import asyncio, bcrypt, aiosqlite
async def create():
    db = await aiosqlite.connect('/app/data/minipacs.db')
    h = bcrypt.hashpw(b'YOUR_PASSWORD', bcrypt.gensalt()).decode()
    await db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', ('admin', h))
    await db.commit()
    await db.close()
asyncio.run(create())
"
```

### 4. Load demo data (optional)

```bash
docker exec minipacs-backend-1 pip install pydicom numpy -q
docker exec minipacs-backend-1 python3 seed_demo.py
```

This creates 12 patients, 18 studies, and 125 DICOM images.

### 5. Open in browser

```
https://localhost:48921
```

Accept the self-signed certificate warning — this is expected for local development.

### Common commands

```bash
docker compose up -d          # Start all services
docker compose down           # Stop all services
docker compose logs -f        # Stream all logs
docker compose logs backend   # Backend logs only
docker compose ps             # Check container status
docker compose build          # Rebuild after code changes
docker compose restart backend # Restart single service
```

---

## Development

For active frontend or backend development, you may want hot-reload instead of rebuilding Docker images on every change.

### Option A: Full Docker (recommended for testing)

Everything runs in Docker. To see your changes:

```bash
docker compose build          # Rebuild images
docker compose up -d          # Restart
```

### Option B: Hybrid — Docker backend + Vite frontend (for UI development)

Keep Orthanc and backend in Docker, run frontend locally with hot-reload:

```bash
# 1. Docker services are already running (docker compose up -d)

# 2. Run Vite dev server
cd frontend
npm install
npm run dev
```

Open `http://localhost:48925` — Vite proxies API calls to Docker backend on `:48922`.

> **Note:** Port 48925 is the Vite dev server with hot-reload.
> Port 48921 is the production nginx with pre-built static files.
> They serve the same app, but 48925 updates instantly when you edit code.

### Option C: Fully native (no Docker)

```bash
# 1. Start Orthanc via Docker
./scripts/start-orthanc.sh

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m app.create_user
uvicorn app.main:app --host 127.0.0.1 --port 48922 --reload

# 3. Frontend
cd frontend
npm install && npm run dev

# 4. (Optional) nginx for HTTPS
./scripts/generate-certs.sh
./scripts/start-all.sh
```

---

## Configuration

### Environment variables (.env)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SECRET_KEY` | Yes | — | JWT signing key. Generate a random 32+ char string |
| `ORTHANC_USERNAME` | No | `orthanc` | Orthanc HTTP basic auth username |
| `ORTHANC_PASSWORD` | Yes | — | Orthanc HTTP basic auth password |
| `ORTHANC_BASIC_AUTH` | Yes | — | Base64 of `username:password` for nginx proxy |
| `HTTP_PORT` | No | `48920` | HTTP port (redirects to HTTPS) |
| `HTTPS_PORT` | No | `48921` | HTTPS port (main entry point) |
| `AUTO_LOGOUT_MINUTES` | No | `15` | Session inactivity timeout |
| `DEFAULT_SHARE_EXPIRY_DAYS` | No | `30` | Default patient share link expiry |

### DICOM equipment setup

Configure your imaging equipment to send studies to:

| Parameter | Value |
|-----------|-------|
| **AE Title** | `MINIPACS` |
| **IP Address** | Your server's IP |
| **Port** | `48924` |
| **Protocol** | DICOM C-STORE |

---

## Production Deployment

### Checklist

- [ ] **Strong passwords** in `.env` — SECRET_KEY, ORTHANC_PASSWORD
- [ ] **Real TLS certificates** — mount via Docker volume to replace self-signed certs
  ```bash
  # In docker-compose.yml, add to frontend volumes:
  - /etc/letsencrypt/live/pacs.clinic.com/fullchain.pem:/etc/ssl/minipacs/cert.pem:ro
  - /etc/letsencrypt/live/pacs.clinic.com/privkey.pem:/etc/ssl/minipacs/key.pem:ro
  ```
- [ ] **Firewall** — only expose ports 48921 (HTTPS) and 48924 (DICOM)
- [ ] **Backups** — schedule Docker volume backups
  ```bash
  # SQLite backup
  docker exec minipacs-backend-1 cp /app/data/minipacs.db /app/data/backup.db
  docker cp minipacs-backend-1:/app/data/backup.db ./backups/

  # Orthanc DICOM data
  docker run --rm -v minipacs_orthanc-data:/data -v ./backups:/backup \
    alpine tar czf /backup/orthanc-$(date +%Y%m%d).tar.gz /data
  ```
- [ ] **CORS origins** — update to your domain in `.env` or docker-compose.yml
- [ ] **Remove dev ports** — remove `48922:8000` and `48923:8042` mappings

---

## Project Structure

```
minipacs/
├── docker-compose.yml            # Full stack orchestration
├── .env.docker                   # Environment template
├── .env                          # Your configuration (git-ignored)
│
├── backend/
│   ├── Dockerfile                # python:3.12-slim + FastAPI
│   ├── app/
│   │   ├── main.py               # FastAPI app, lifespan, routers
│   │   ├── config.py             # pydantic-settings
│   │   ├── database.py           # SQLite schema + migrations
│   │   ├── services/orthanc.py   # Orthanc API client (httpx)
│   │   ├── routers/              # 12 routers (~50 endpoints)
│   │   └── middleware/audit.py   # Immutable audit logging
│   └── seed_demo.py              # Demo data generator
│
├── frontend/
│   ├── Dockerfile                # node build → nginx:alpine
│   └── src/
│       ├── pages/                # 13 page components
│       ├── components/           # shadcn/ui + custom components
│       └── lib/                  # API client, auth, DICOM utils
│
├── orthanc/
│   ├── orthanc.json              # Native Orthanc config (non-Docker)
│   └── orthanc-docker.json       # Docker Orthanc config
│
├── nginx/
│   ├── nginx.conf                # Native nginx config
│   └── nginx-docker.conf         # Docker nginx config (container names)
│
├── ohif-dist/                    # Pre-built OHIF Viewer
├── ohif-config/minipacs.js       # OHIF white-label config
│
└── scripts/
    ├── start-all.sh              # Native full-stack launcher
    ├── start-orthanc.sh          # Docker Orthanc launcher
    └── generate-certs.sh         # Self-signed TLS cert generator
```

---

## API Overview

| Endpoint Group | Routes | Description |
|---------------|--------|-------------|
| `/api/auth` | 4 | Login, logout, refresh, me |
| `/api/patients` | 2 | List (paginated), detail with studies |
| `/api/studies` | 5 | List (filtered), detail, download, series |
| `/api/transfers` | 3 | Send, retry, history |
| `/api/shares` | 4 | Create, update, revoke, list |
| `/api/pacs-nodes` | 5 | CRUD + C-ECHO test |
| `/api/reports` | 3 | Create, list, delete |
| `/api/settings` | 3 | Get, update, public (no auth) |
| `/api/viewers` | 4 | CRUD for external viewers |
| `/api/users` | 4 | CRUD + token revocation |
| `/api/audit-log` | 1 | Filtered, paginated log |
| `/api/stats` | 2 | Dashboard stats + system health |
| `/api/patient-portal` | 5 | Public: view, download, PIN verify |

---

## License

**Business Source License 1.1** — see [LICENSE](LICENSE).

- You can view, fork, and modify the code
- Non-commercial and educational use is permitted
- Commercial use requires a separate license
- Becomes Apache 2.0 on April 12, 2030

For commercial licensing inquiries: **tr00x@proton.me**

---

<p align="center">
  <sub>Built for clinics that want to own their imaging data.</sub>
</p>
