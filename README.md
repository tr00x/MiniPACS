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
  <a href="#what-makes-it-different">What's different</a> ·
  <a href="#vs-commercial-pacs">vs Commercial</a> ·
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
clinics use to read MRIs in production. Six containers, one host, one
`pg_dump` for backup.

---

## What makes it different

These are the engineering decisions you will not find in commercial PACS
or in other open-source PACS projects. Each one is in production at the
pilot clinic right now.

### 1. Live worklist over WebSocket — no polling, ever

When a study lands from an MRI, the radiologist sees it in the browser
**within ~2 seconds**. Most PACS poll their worklist every 30–60 s.

- Orthanc Python plugin subscribes to the `STABLE_STUDY` event
- Plugin POSTs to a backend internal endpoint (shared-secret + RFC1918 IP allowlist)
- Backend invalidates the Redis QIDO cache and broadcasts to every `/api/ws/studies` subscriber
- Frontend `useStudiesWebSocket` invalidates `['studies']`, `['patients']`, `['dashboard']` query keys and toasts the patient name

Result: zero polling load, zero stale worklists, sub-second perceived latency.

### 2. Shared PostgreSQL database with disjoint table names

Orthanc and the MiniPACS backend co-tenant **one PG database**. Orthanc
owns its `dicomidentifiers/dicomstudies/...` tables; MiniPACS owns
`users/shares/audit_log/...`. No name collisions, no separate provisioning,
**one `pg_dump orthanc` captures both applications' state**.

Backend uses `asyncpg.Pool` (min 2, max 8) behind a thin aiosqlite-shaped
adapter so legacy router code (`?` placeholders, `cursor.lastrowid`) keeps
working. A SQLite → PG migration script ships for upgrades.

### 3. Encapsulated PDF reports — radiologist reports live inside the study

Radiologist PDFs are encapsulated as DICOM Encapsulated PDF (SOP
`1.2.840.10008.5.1.4.1.1.104.1`) and attached to the study they describe.
Any DICOM viewer renders them inline. Reports travel with the study on
C-STORE, archive on the same disk, back up in the same `pg_dump`.

Most PACS keep reports in a separate document store with a foreign-key
join — a perfectly fine choice that breaks the moment you export a CD.

### 4. Resumable chunked upload with two-level dedup

Drop a folder of 50 GB DICOMs into the browser. Browser tab dies.
Network blips. WSL restarts. **Resume from where you left off.**

- Chunked uploads with per-chunk hash, per-file hash, and per-job
  persistence in PG
- File-level dedup against Orthanc's `lookup-instance` (skip the chunk
  upload entirely if Orthanc already has the SOPInstanceUID)
- Chunk-level dedup at the upload session (don't re-send the same chunk
  twice in the same job)
- Jobs surface as a global UI pill — close the import dialog, the job
  keeps running

Production-tested on a 5,387-disc archive import: 852 discs, 14k+ studies,
zero re-uploads on resume.

### 5. Split-horizon HTTPS — LAN clients save 50–100 ms per request

WAN clients hit Cloudflare → CF Tunnel (outbound-only) → nginx → backend.
LAN clients hit nginx **directly on `:443`** with the same Cloudflare
Origin Cert + HTTP/2, bypassing the entire CF round-trip.

- Same domain, same cert, two paths
- Resolved by a UniFi DNS override on the clinic LAN
- ~50–100 ms RTT savings per Stone metadata/frame burst — perceptible on
  500-slice MRs

### 6. Zero open inbound web ports

The clinic firewall has **no inbound port forward for HTTPS**. Cloudflare
Tunnel is outbound-only — `cloudflared` dials Cloudflare, traffic flows
back through the tunnel. Eliminates an entire class of port-scan attacks.

The only inbound port forward is `48924` for DICOM C-STORE between
imaging facilities.

### 7. Five-layer cache, no N+1

| Layer | What it caches | TTL |
|---|---|---|
| Service worker (Workbox) | `/api/*` (NetworkFirst), Stone WASM (CacheFirst) | offline-aware |
| React Query + hover-prefetch | API responses, post-login dashboard/worklist warmup | session |
| nginx `proxy_cache` | `/dicom-web/` | 2 GB × 7 days |
| Redis QIDO cache | `find_studies` / `find_patients` | 30 s fresh / 600 s stale-while-error |
| In-process aggregate cache | `/api/studies/{id}/full` | 15 s |

`asyncpg.Pool` (2–8) and httpx pool (`max_connections=100`, keepalive 50)
are TCP+auth-prewarmed at boot. CORS preflight cached 24 h client-side
+ server-side. `orjson` default response class (5–10× faster JSON
serialize). Stone WASM preloaded via `<link rel="preload">` in
`index.html`.

### 8. Pre-computed DICOM metadata — no disk reads on viewer open

`ExtraMainDicomTags` carries the OHIF/Stone-required tag set (`Rows`,
`PixelSpacing`, `ImagePositionPatient`, `WindowCenter`, `RescaleSlope`, …)
in the PG index. Viewer metadata resolves from PG in microseconds,
**never touches the DICOM file on disk**. CF Tunnel's 100 s timeout
never triggers, even on 5,000-instance studies.

`SeriesMetadataCacheSize: 30000` keeps the metadata attachments resident.
First open caches as an attachment; subsequent opens are index-only.

### 9. Token-versioned JWTs — instant session revocation

JWTs carry a `token_version` claim. Admin password change bumps
`users.token_version`; **every existing session invalidates on the next
request**, no session table lookup needed. O(1) revocation.

### 10. PWA with offline shell

Installable like a native app. Last-viewed worklist renders without
network. Workbox SW does `NetworkFirst` for `/api/*`, `CacheFirst` for
Stone WASM. Add to Home Screen / Dock and run in its own window.

---

## vs Commercial PACS

|  | Commercial cloud PACS | MiniPACS |
|---|---|---|
| **Cost** | $150–$2,000 / month | **$0 / month** |
| **Data location** | Vendor's data centre | Your clinic, your disk |
| **Worklist updates** | Polling, 30–60 s | **WebSocket, ~2 s** |
| **Web viewer** | Java applet or paid SaaS | **Stone WASM, ~1 MB, <1 s cold open** |
| **Reports** | Separate document store | **Encapsulated PDF DICOM** in the study |
| **Bulk import** | Manual, restart on failure | **Resumable chunked + 2-level dedup** |
| **Inbound web ports** | Yes, exposed to internet | **Zero** (Cloudflare Tunnel outbound-only) |
| **Backup** | Vendor SLA, opaque | **One `pg_dump` covers everything** |
| **LAN performance** | Same as WAN | **HTTP/2 direct, ~50–100 ms saved/request** |
| **Source** | Closed | **BSL 1.1**, Apache 2.0 from 2030 |
| **Vendor lock-in** | High — proprietary archive formats | **None** — DICOM in, DICOM out |

---

## Features

- **DICOM ingest from any modality** — MRI, CT, X-ray, ultrasound, etc.
  via C-STORE on the LAN. AE Title `MINIPACS`, port `48924`.
- **Two web viewers** — Stone Web Viewer (default) and OHIF, plus URL
  launchers for OsiriX, RadiAnt, 3D Slicer, MicroDicom, MedDream.
- **Live worklist** with grid view + thumbnails (PNGs pre-generated by
  the Orthanc Python plugin on `STABLE_STUDY`, 2/s rate limit).
- **Patient portal** — secure share links with configurable expiry,
  optional PIN protection, QR codes, JPEG fallback for non-DICOM viewers,
  mobile-first responsive layout.
- **Inter-clinic transfers** — C-STORE to other PACS nodes with C-ECHO
  preflight, retry, human-readable error reporting.
- **Encapsulated PDF reports** — radiologist PDFs as Encapsulated PDF
  DICOM, visible in any viewer.
- **Resumable chunked upload** with two-level dedup (file + chunk).
- **PWA** — installable, offline-aware shell.
- **Security** — JWT with token versioning + instant revocation, session
  timeout with HIPAA-style warning modal, immutable audit log with CSV
  export, login rate limit, CSP/HSTS/X-Frame-Options. DICOMweb gated to
  LAN only.
- **Operational** — daily backup cron, Windows Scheduled Tasks +
  WSL systemd unit for autostart and liveness watchdog, secret rotation
  script.

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

| Container | Image | Role |
|---|---|---|
| `postgres` | `postgres:16-alpine` | Shared index — Orthanc + MiniPACS, disjoint table names |
| `orthanc` | `orthancteam/orthanc` | DICOM ingest, DICOMweb, Stone, OHIF, Python plugin (thumbs + WS events) |
| `redis` | `redis:7-alpine` | QIDO cache, 30 s fresh / 600 s stale, memory fallback if Redis dies |
| `backend` | `python:3.12` + FastAPI + asyncpg | Auth, REST, WebSocket fanout, audit log |
| `frontend` | node build → `nginx:alpine` | React PWA, reverse proxy, LAN-HTTPS listener |
| `cloudflared` | `cloudflare/cloudflared` | Outbound CF Tunnel for WAN access |

Full breakdown — request paths, caching layers, auth surfaces, storage,
schema boundary — in [`docs/architecture.md`](docs/architecture.md).

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
