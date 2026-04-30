<h1 align="center">MiniPACS</h1>

<p align="center">
  <strong>Self-hosted PACS portal for independent medical clinics.</strong><br/>
  One server. Zero recurring fees. Your data stays in your clinic.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/DICOM-compatible-blue" alt="DICOM" />
  <img src="https://img.shields.io/badge/HIPAA-ready-green" alt="HIPAA" />
  <img src="https://img.shields.io/badge/license-BSL_1.1-orange" alt="License" />
  <img src="https://img.shields.io/badge/stack-React_·_FastAPI_·_Orthanc-009688" alt="Stack" />
</p>

<p align="center">
  <a href="#why">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#docs">Docs</a>
</p>

---

## Why

Solo and small clinics pay **$150–$2,000/month** for cloud PACS that are
overengineered for their needs and lock their data in someone else's data
centre. MiniPACS runs on a single Windows or Linux box you already own,
sends nothing outbound except optional Cloudflare Tunnel traffic, and
costs **$0/month** to operate.

It is not a toy. The same image you would build for a demo is the image
clinics use to read MRIs in production — DICOM C-STORE on the LAN, HTTPS
on WAN, audit log, share links with PIN, encapsulated PDF reports, live
worklist via WebSocket. Six containers, one `pg_dump` for backup.

---

## Features

- **DICOM ingest from any modality** — MRI, CT, X-ray, ultrasound, etc.
  via C-STORE on the LAN. AE Title `MINIPACS`, port `48924`.
- **Two viewers** — Stone Web Viewer (default, ~1 MB WASM, cold-open
  <1 s on a 500-slice MR) and OHIF (zero-footprint, dicom-json
  datasource with precomputed metadata). Plus URL launchers for OsiriX,
  RadiAnt, 3D Slicer, MicroDicom, MedDream.
- **Live worklist** — new studies appear in the browser within seconds
  of arrival via WebSocket fanout from Orthanc's `STABLE_STUDY` event.
  No polling, no refresh.
- **Patient portal** — secure share links with configurable expiry,
  optional PIN protection, QR codes, JPEG fallback for non-DICOM viewers,
  mobile-first responsive layout.
- **Inter-clinic transfers** — C-STORE to other PACS nodes with C-ECHO
  preflight, retry, and human-readable error reporting.
- **Encapsulated PDF reports** — radiologist PDFs ride alongside the
  study as DICOM Encapsulated PDF (SOP `1.2.840.10008.5.1.4.1.1.104.1`),
  visible in any DICOM viewer.
- **Progressive Web App** — installable, offline-aware shell, aggressive
  cache of Stone WASM via Workbox.
- **Resumable bulk import** — chunked uploads with two-level dedup, work
  resumes after browser tab drop or network blip; long-running jobs
  surface as a global UI pill.
- **Security & compliance** — JWT with token versioning + instant
  revocation, session timeout with HIPAA-style warning modal, immutable
  audit log with CSV export, login rate limit, CSP/HSTS/X-Frame-Options.
  DICOMweb gated to LAN only.

---

## Screenshots

| Dashboard | Worklist |
|-----------|----------|
| ![Dashboard](docs/assets/screenshots/dashboard.png) | ![Worklist](docs/assets/screenshots/worklist.png) |

| Study + Share | Patient Portal |
|---------------|----------------|
| ![Study](docs/assets/screenshots/study-share.png) | ![Portal](docs/assets/screenshots/patient-portal.png) |

| Patients (Dark) | Audit Log |
|----------------|-----------|
| ![Dark](docs/assets/screenshots/patients-dark.png) | ![Audit](docs/assets/screenshots/audit-log.png) |

---

## Architecture

```
                Internet                              Clinic LAN
                    │                                      │
       ┌────────────┴────────────┐         ┌──────────────┴────────┐
       │                         │         │                       │
 [Doctors / Patients]      [Other PACS]    │   [MRI / CT / X-ray]  │
       │                       │           │           │           │
       │ HTTPS                 │ C-STORE   │           │ C-STORE   │
       ▼                       │           │           ▼           │
 [Cloudflare edge]              │           │     LAN :48924        │
       │ CF Tunnel              │           │           │           │
       │ (outbound only)        │           │           │           │
       ▼                       ▼           │           │           │
┌── Docker Compose (single host) ──────────────────────┤           │
│                                                      │           │
│  cloudflared ──► nginx :80/:443 (HTTP/2) ◄───────────┤           │
│                    │                                  │           │
│                    │  React PWA  ──► /api/    ──► FastAPI        │
│                    │              ──► /api/ws/ ──► WebSocket     │
│                    │              ──► /stone-* ──► Stone Viewer  │
│                    │              ──► /ohif/   ──► OHIF plugin   │
│                    │              ──► /dicom-web/                │
│                    │                                  │           │
│       ┌────────────┴───────┐                          │           │
│       ▼                    ▼                          ▼           │
│   [backend]          [redis cache]              [orthanc PACS] ◄──┴── :48924
│       │              (QIDO / WS)                       │
│       │ asyncpg                                        │
│       ▼                                                ▼
│   [postgres] ◄────── shared DB ─────── Orthanc index + DICOM files on disk
└──────────────────────────────────────────────────────────────────────────
```

Six containers, one host, one backup artefact. Full breakdown in
[`docs/architecture.md`](docs/architecture.md).

| Container | Image | Role |
|---|---|---|
| `postgres` | `postgres:16-alpine` | Shared index — Orthanc + MiniPACS tables, disjoint names |
| `orthanc` | `orthancteam/orthanc` | DICOM ingest, DICOMweb, Stone, OHIF, Python plugin (thumbs + WS events) |
| `redis` | `redis:7-alpine` | QIDO cache, 30 s fresh / 600 s stale, memory fallback |
| `backend` | `python:3.12` + FastAPI + asyncpg | Auth, REST, WebSocket fanout, audit log |
| `frontend` | node build → `nginx:alpine` | React SPA (PWA), reverse proxy, LAN-HTTPS listener |
| `cloudflared` | `cloudflare/cloudflared` | Outbound CF Tunnel for WAN access |

---

## Quick Start

### Production (one command)

```bash
git clone https://github.com/tr00x/MiniPACS.git
cd MiniPACS
./scripts/setup.sh
```

The setup script generates strong passwords, asks for your domain and
Cloudflare Tunnel token, builds images, creates an admin user, installs
the daily backup cron, and starts the stack. Open `https://your-domain`
and log in.

### Local dev (self-signed TLS)

```bash
git clone https://github.com/tr00x/MiniPACS.git
cd MiniPACS
cp .env.docker .env        # edit passwords
docker compose up -d
```

Open `https://localhost:48921` (accept the self-signed cert).

### Hot-reload frontend

```bash
docker compose up -d              # backend + Orthanc in containers
cd frontend && npm install && npm run dev
```

Vite on `http://localhost:48925` proxies `/api/*` to the Docker backend.

### DICOM equipment

| Parameter | Value |
|-----------|-------|
| AE Title | `MINIPACS` |
| Host | server LAN IP |
| Port | `48924` |
| Protocol | DICOM C-STORE |

---

## Docs

| Doc | For |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Request paths, caching layers, auth surfaces, storage, schema boundary |
| [`docs/prod-hardening.md`](docs/prod-hardening.md) | Secret rotation, admin password, firewall, backups |
| [`docs/split-horizon-https.md`](docs/split-horizon-https.md) | Real TLS on LAN — CF Origin Cert, UniFi DNS override, portproxy `:443` |
| [`docs/wsl-autostart.md`](docs/wsl-autostart.md) | Windows Scheduled Tasks + WSL systemd unit for auto-recovery |
| [`scripts/README.md`](scripts/README.md) | Operational runbooks — bulk PDF inject, prewarm, backup, secret rotation |
| [`CHANGELOG.md`](CHANGELOG.md) | Deploy-wave history (no semver — `master` is the product) |

---

## License

**Business Source License 1.1** — see [LICENSE](LICENSE).

- View, fork, modify
- Non-commercial and educational use permitted
- Commercial use requires a separate license
- Converts to Apache 2.0 on April 12, 2030

Commercial licensing: **tr00x@proton.me**

---

<p align="center">
  <sub>Built for clinics that want to own their imaging data.</sub>
</p>
