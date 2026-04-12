<h1 align="center">MiniPACS</h1>

<p align="center">
  <strong>Full-featured PACS portal for independent medical clinics</strong>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick Start</a> ·
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
- Multi-modality study support with color-coded badges

### Worklist & Study Management
- Server-side search, filtering, and pagination
- Filter by modality, date range (presets + custom), patient name
- Two-line rich table rows with institution, referring physician, accession number
- Click any study to view details, series breakdown, and launch viewer

### Patient Portal
- Secure share links with configurable expiry (7/14/30/90 days)
- Optional PIN protection with server-side enforcement (httponly cookies)
- QR code generation for easy sharing — printable or scannable
- Email integration — pre-filled mailto with study details and portal link
- Mobile-first responsive design — works on any device
- Patient-friendly JPEG download option (no DICOM knowledge needed)

### PACS Transfers
- Send studies to other PACS nodes via DICOM C-STORE
- C-ECHO connectivity testing before sending
- Real-time transfer status tracking with auto-refresh
- Retry failed transfers with human-readable error messages
- Transfer history with resolved study descriptions

### Radiology Reports
- Attach text or PDF reports to any study
- Inline PDF viewer with fullscreen overlay
- Download reports directly
- Reports linked to studies for complete clinical workflow

### External Viewers
- Pre-configured desktop viewer integration (OsiriX, Horos, RadiAnt, 3D Slicer)
- Cloud viewer support (PostDICOM, MedDream)
- Custom URL scheme support — add any DICOM viewer
- Enable/disable viewers with one click
- Real favicon icons from official viewer sites

### Security & Compliance
- JWT authentication with token versioning and instant revocation
- Session timeout with 60-second warning modal (HIPAA requirement)
- Immutable audit log with CSV export — every action logged
- SQLite-based rate limiting on login attempts
- Content Security Policy, HSTS, X-Frame-Options headers
- DICOMweb access restricted to clinic LAN only
- Credentials via `.env` — zero hardcoded secrets

### Admin Dashboard
- System health monitoring — PACS server status, storage, last received study
- Patient/study/transfer/share statistics at a glance
- Recent transfers and active shares feed
- Collapsible sidebar with dark/light mode toggle

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
        │ DICOM C-STORE
        ▼
[Orthanc PACS Server]  ◄── Docker container, persistent storage
        │ REST API + DICOMweb
        ▼
[FastAPI Backend]  ◄── Python, JWT auth, audit logging, SQLite
        │ JSON REST API
        ▼
[React Frontend + OHIF Viewer]  ◄── TypeScript, Tailwind, shadcn/ui
        │
[nginx Reverse Proxy]  ◄── HTTPS, security headers, CSP
    /         → React (static build)
    /api/     → FastAPI
    /dicom-web/ → Orthanc DICOMweb (LAN only)
    /ohif/    → OHIF Viewer (static build)
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| **PACS Server** | Orthanc 1.12 (Docker) |
| **Backend** | Python 3.14, FastAPI, aiosqlite, httpx |
| **Frontend** | React 18, TypeScript, Tailwind CSS v4, shadcn/ui |
| **Viewer** | OHIF Viewer 3.x (DICOMweb) |
| **Proxy** | nginx (HTTPS, TLS 1.2+) |
| **Database** | SQLite (application state) |
| **Auth** | JWT + bcrypt, token versioning |

### Ports

| Service | Port | Purpose |
|---------|------|---------|
| nginx HTTPS | 48921 | Entry point (production) |
| nginx HTTP | 48920 | Redirect to HTTPS |
| FastAPI | 48922 | Backend API |
| Orthanc HTTP | 48923 | REST API + DICOMweb |
| Orthanc DICOM | 48924 | C-STORE / C-ECHO |
| Vite Dev | 48925 | Development server |

---

## Quick Start

### Prerequisites

- **Docker** — for Orthanc PACS server
- **Python 3.12+** — for FastAPI backend
- **Node.js 18+** — for React frontend
- **nginx** — for production reverse proxy

### 1. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/minipacs.git
cd minipacs
cp backend/.env.example backend/.env
# Edit backend/.env — set strong SECRET_KEY and ORTHANC_PASSWORD
```

### 2. Start Orthanc PACS

```bash
./scripts/start-orthanc.sh
```

### 3. Set up backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m app.create_user  # Create admin account
uvicorn app.main:app --host 0.0.0.0 --port 48922 --reload
```

### 4. Set up frontend

```bash
cd frontend
npm install
npm run dev
```

### 5. Open in browser

```
http://localhost:48925
```

### 6. Load demo data (optional)

```bash
cd backend
python seed_demo.py  # 12 patients, 18 studies, 125 images
```

---

## Production Deployment

### Deployment checklist

- [ ] **TLS certificates** — Let's Encrypt (`certbot`) or purchased certificate
  ```bash
  sudo certbot --nginx -d pacs.yourclinic.com
  ```
  Update `nginx/nginx.conf` with real cert paths.

- [ ] **Firewall rules** — Only expose necessary ports
  ```bash
  # Allow HTTPS (web portal) and DICOM (equipment) only
  sudo ufw allow 48921/tcp  # HTTPS portal
  sudo ufw allow 48924/tcp  # DICOM from equipment
  # Bind FastAPI and Orthanc HTTP to localhost only
  ```

- [ ] **systemd services** — Auto-start on boot
  ```bash
  # Create service files for:
  # - minipacs-backend.service (uvicorn)
  # - minipacs-orthanc.service (docker container)
  # - nginx (usually already a service)
  sudo systemctl enable minipacs-backend minipacs-orthanc nginx
  ```

- [ ] **Backups** — Daily automated backups
  ```bash
  # Add to crontab:
  0 2 * * * cp /path/to/minipacs.db /backup/minipacs-$(date +\%Y\%m\%d).db
  0 3 * * * rsync -a /path/to/orthanc-data/ /backup/orthanc-data/
  ```

- [ ] **Production .env** — Strong passwords, real domain
  ```bash
  SECRET_KEY=<generate with: python -c "import secrets; print(secrets.token_urlsafe(32))">
  ORTHANC_PASSWORD=<strong random password>
  CORS_ORIGINS=["https://pacs.yourclinic.com"]
  ```

- [ ] **Frontend build** — Create production bundle
  ```bash
  cd frontend && npm run build
  # Static files served by nginx from frontend/dist/
  ```

- [ ] **OHIF build** — White-label viewer with clinic branding
  ```bash
  cd ohif-source && yarn build
  cp -r platform/app/dist/* ../ohif-dist/
  cp ../ohif-config/minipacs.js ../ohif-dist/app-config.js
  ```

### DICOM Equipment Setup

Configure your imaging equipment (MRI, CT, X-ray) to send studies to:

| Parameter | Value |
|-----------|-------|
| **AE Title** | `MINIPACS` |
| **IP Address** | Your server's IP |
| **Port** | `48924` |
| **Protocol** | DICOM C-STORE |

---

## Project Structure

```
minipacs/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI application
│   │   ├── config.py            # Settings (pydantic-settings)
│   │   ├── database.py          # SQLite schema + migrations
│   │   ├── services/
│   │   │   ├── orthanc.py       # Orthanc API client
│   │   │   └── auth.py          # JWT + bcrypt
│   │   ├── routers/             # 12 API routers (~50 endpoints)
│   │   ├── models/              # Pydantic request/response models
│   │   └── middleware/
│   │       └── audit.py         # Immutable audit logging
│   ├── seed_demo.py             # Demo data generator
│   └── .env.example             # Environment template
├── frontend/
│   └── src/
│       ├── pages/               # 13 page components
│       ├── components/          # Shared UI components
│       └── lib/                 # API client, auth, DICOM utils
├── orthanc/
│   └── orthanc.json             # PACS configuration template
├── nginx/
│   └── nginx.conf               # Reverse proxy + security headers
├── scripts/
│   ├── start-orthanc.sh         # Docker Orthanc launcher
│   └── start-all.sh             # Full stack launcher
└── ohif-config/
    └── minipacs.js              # OHIF viewer configuration
```

---

## API Overview

| Endpoint Group | Routes | Description |
|---------------|--------|-------------|
| `/api/auth` | 4 | Login, logout, refresh, me |
| `/api/patients` | 2 | List (paginated), detail with studies |
| `/api/studies` | 5 | List (filtered), detail, download, series download |
| `/api/transfers` | 3 | Send, retry, history |
| `/api/shares` | 4 | Create, update, revoke, list |
| `/api/pacs-nodes` | 5 | CRUD + C-ECHO test |
| `/api/reports` | 3 | Create, list, delete |
| `/api/settings` | 3 | Get, update, public |
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
