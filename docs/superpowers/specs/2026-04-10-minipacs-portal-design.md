# MiniPACS Portal — Design Document

## Overview

Web portal for a solo clinic that has imaging equipment (MRI, CT, X-ray) but no radiologists on staff. The clinic captures images, sends them to external diagnostic centers for reading, receives reports back, and physicians use those reports for diagnosis and treatment.

The portal provides a single point of control: store, view, send, and share medical images.

## Development Approach

This is a production-first project. No mock data, no placeholder content, no MVP shortcuts. The project scope is manageable — we build it right from the start. All features work with real DICOM data from Orthanc. All UI states are real states driven by actual data.

## Architecture

```
[MRI/CT/X-ray machines]
        | DICOM C-STORE
        v
[Orthanc PACS :48924 DICOM TLS] <--- DICOM C-STORE --- [External PACS]
        |
        | REST API / DICOMweb
        v
[FastAPI Backend :48922]
        | - Authentication
        | - Transfer management
        | - Patient sharing
        | - Audit logging
        | - Settings management
        | - Proxy to Orthanc
        |
        | REST API
        v
[React Frontend + OHIF Viewer (embedded)]
        | - Dashboard
        | - Patient cards with full DICOM metadata
        | - Study browser
        | - One-click PACS transfer
        | - Patient share links
        | - Settings panel
        | - Audit log viewer

[nginx :48920 HTTP / :48921 HTTPS]
    /          -> React (static)
    /api/      -> FastAPI (uvicorn)
    /dicomweb/ -> Orthanc DICOMweb
    /ohif/     -> OHIF Viewer (static)
```

### Three Components

1. **Orthanc** — native install, DICOM server. Receives from clinic equipment and external PACS, stores, sends via C-STORE.
2. **FastAPI** — business logic, auth, sharing, audit, communicates with Orthanc via REST API.
3. **React + OHIF** — frontend. OHIF embedded as component (no new tabs). shadcn/ui + Lucide icons, minimalist black-and-white design.

### Ports

All ports are intentionally obscure to avoid conflicts:

| Service         | Port  |
|-----------------|-------|
| nginx HTTP      | 48920 |
| nginx HTTPS     | 48921 |
| FastAPI         | 48922 |
| Orthanc HTTP    | 48923 |
| Orthanc DICOM   | 48924 |
| OHIF dev        | 48925 |

## Data Flow

### Incoming Images
Clinic equipment and external PACS send DICOM via C-STORE to Orthanc (:48924). The clinic workstation is transit-only — images are not stored there long-term. MiniPACS is the sole storage.

### Outgoing Transfers
User selects a study -> clicks "Send to PACS" -> selects destination from PACS directory -> FastAPI calls Orthanc C-STORE -> Orthanc sends to external PACS by IP + AE Title.

### Patient Sharing
User generates a unique link for a patient -> patient opens link in browser -> FastAPI validates token -> shows patient's profile with study timeline -> patient can view (embedded OHIF) or download.

## DICOM Metadata

All metadata comes from Orthanc API, not duplicated in our database.

### Patient Level
- Patient ID, Patient Name, Date of Birth, Sex
- Other Patient IDs, Patient Comments
- Ethnic Group, Patient Size, Patient Weight

### Study Level
- Study ID, Study Date, Study Time, Study Description
- Accession Number, Referring Physician Name
- Institution Name, Study Instance UID

### Series Level
- Series Number, Series Date, Series Description
- Modality (CT, MR, CR, US, XA, etc.)
- Body Part Examined, Protocol Name
- Operator Name
- Equipment: Manufacturer, Model, Station Name
- Series Instance UID

### Instance Level
- Instance Number, Image Type
- Rows, Columns, Bits Allocated, Pixel Spacing
- Window Center / Width
- SOP Instance UID

Full DICOM tag list to be researched during implementation to ensure completeness.

## Database (SQLite)

Minimal — only what Orthanc doesn't store.

### users
| Column        | Type     |
|---------------|----------|
| id            | INTEGER PK |
| username      | TEXT UNIQUE |
| password_hash | TEXT     |
| token_version | INTEGER DEFAULT 0 |
| created_at    | DATETIME |
| last_login    | DATETIME |

Incrementing `token_version` invalidates all existing refresh tokens for that user (account compromise, employee termination).

### patient_shares
| Column            | Type     |
|-------------------|----------|
| id                | INTEGER PK |
| orthanc_patient_id| TEXT     |
| token             | TEXT UNIQUE |
| expires_at        | DATETIME |
| created_by        | INTEGER FK(users) |
| created_at        | DATETIME |
| is_active         | BOOLEAN  |
| view_count        | INTEGER DEFAULT 0 |
| first_viewed_at   | DATETIME NULL |
| last_viewed_at    | DATETIME NULL |

Expiry is set by the operator at creation time (1 day, 7 days, 30 days, custom date, or no expiry). Expired tokens return a clear "Link expired, contact the clinic" page — no information leakage. Clinic staff can extend, shorten, revoke, or regenerate links from the Shares management page. The Shares page shows all links (active/expired/revoked) with filters, view_count, last_viewed_at, and quick actions.

### pacs_nodes
| Column      | Type     |
|-------------|----------|
| id          | INTEGER PK |
| name        | TEXT     |
| ae_title    | TEXT     |
| ip          | TEXT     |
| port        | INTEGER  |
| description | TEXT     |
| is_active   | BOOLEAN  |

### transfer_log
| Column           | Type     |
|------------------|----------|
| id               | INTEGER PK |
| orthanc_study_id | TEXT     |
| pacs_node_id     | INTEGER FK(pacs_nodes) |
| initiated_by     | INTEGER FK(users) |
| status           | TEXT (pending/success/failed) |
| error_message    | TEXT NULL |
| created_at       | DATETIME |
| completed_at     | DATETIME NULL |

### audit_log (immutable, 6-year retention)
| Column        | Type     |
|---------------|----------|
| id            | INTEGER PK |
| user_id       | INTEGER NULL |
| patient_token | TEXT NULL |
| action        | TEXT (view/download/send/login/logout) |
| resource_type | TEXT     |
| resource_id   | TEXT     |
| ip_address    | TEXT     |
| timestamp     | DATETIME |

### external_viewers
| Column     | Type     |
|------------|----------|
| id         | INTEGER PK |
| name       | TEXT     |
| icon       | TEXT     |
| url_scheme | TEXT     |
| is_enabled | BOOLEAN  |
| sort_order | INTEGER  |

### settings
| Column     | Type     |
|------------|----------|
| key        | TEXT PK  |
| value      | TEXT     |
| updated_at | DATETIME |

## API Endpoints (FastAPI)

### Auth
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Patients (proxied from Orthanc)
- `GET /api/patients` — list with search/filter
- `GET /api/patients/{id}` — patient card + all studies

### Studies
- `GET /api/studies` — list with filters (date, modality, patient)
- `GET /api/studies/{id}` — study details (series, instances)
- `GET /api/studies/{id}/download` — download as ZIP

### Transfers
- `POST /api/transfers` — send study (study_id + pacs_node_id)
- `GET /api/transfers` — transfer log
- `POST /api/transfers/{id}/retry` — retry failed transfer

### PACS Nodes
- `GET /api/pacs-nodes`
- `POST /api/pacs-nodes`
- `PUT /api/pacs-nodes/{id}`
- `DELETE /api/pacs-nodes/{id}`
- `POST /api/pacs-nodes/{id}/echo` — C-ECHO connectivity test

### Patient Sharing
- `POST /api/shares` — generate patient link
- `GET /api/shares` — list active links
- `PUT /api/shares/{id}` — extend/regenerate link
- `DELETE /api/shares/{id}` — deactivate link
- `GET /api/patient-portal/{token}` — public endpoint, patient data by token
- `GET /api/patient-portal/{token}/studies/{id}/download` — public download for patient

### Settings
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/settings/orthanc`
- `PUT /api/settings/orthanc`

### External Viewers
- `GET /api/viewers`
- `POST /api/viewers`
- `PUT /api/viewers/{id}`
- `DELETE /api/viewers/{id}`

### Audit
- `GET /api/audit-log` — filterable by date, user, action

Every endpoint: auth check + audit_log entry. Patient-portal endpoints: token validation only.

## Frontend Pages

### Clinic Portal (authenticated)

1. **Dashboard** — summary: recent studies, today/week counts, recent transfers, unviewed patient links
2. **Patients** — searchable/filterable table -> click -> patient card (DICOM info + study timeline + transfer history + share links)
3. **Studies** — full list, filters by date/modality/patient
4. **Viewer** — OHIF embedded inside portal (no new tabs) + external viewer buttons
5. **Transfers** — log: destination, timestamp, status, retry
6. **PACS Directory** — external nodes list, add/edit, C-ECHO test
7. **Settings** — Orthanc config, OHIF config, user accounts, external viewers, general portal settings
8. **Audit Log** — action log with filtering

### Patient Portal (via unique link, no login)

1. **Profile** — name, DOB, ID (from DICOM)
2. **Studies** — timeline of their studies
3. **Viewer** — OHIF read-only (embedded) + external viewer buttons
4. **Download** — per study or per instance

### Design System
- React + shadcn/ui + Lucide icons
- Minimalist black-and-white aesthetic
- Everything inside one tab — OHIF embedded, external viewers in embedded panel
- No new browser tabs ever

## Orthanc Configuration

### Plugins
- **DICOMweb** — REST API for OHIF (WADO-RS, STOW-RS, QIDO-RS)
- **Authorization** — FastAPI controls access to Orthanc
- **DICOM TLS** — encrypted DICOM traffic (HIPAA)
- **Transfer Accelerator** — faster large study transfers
- Storage compression

### Settings
- AE Title, DICOM port (48924), HTTP port (48923)
- Modalities list (synced with portal PACS directory)
- Peers configuration
- Connection limits
- Storage path, compression settings

## OHIF Configuration

- DICOMweb connection to Orthanc
- Tool set: zoom, pan, window level, length/angle measurements, annotations
- Layout presets (1x1, 2x2, etc.)
- Hanging protocols by modality (CT: scroll through slices, X-ray: single frame)
- No diagnostic/AI features (FDA compliance)
- Custom black-and-white theme matching portal design

## Compliance (USA)

### HIPAA

**Encryption:**
- In transit: TLS 1.2+ (HTTPS on all web traffic, DICOM TLS for image transfers)
- At rest: AES-256 encryption on Orthanc storage

**Access Control:**
- Unique login per user
- Automatic logout on inactivity timeout
- Minimum necessary access to data

**Audit Logs (mandatory):**
- Every access, view, download, send, login, logout recorded
- Immutable — cannot be deleted or modified
- Minimum 6-year retention

**Breach Notification:**
- Notify HHS + affected patients within 60 days if breach occurs

### Patient Sharing
- HIPAA Right of Access — patients entitled to their data
- Share links: time-limited, TLS-only, fully logged
- View tracking: view_count, first_viewed_at, last_viewed_at
- Free electronic delivery

### FDA
- Portal is viewing and routing only, not diagnostic — no FDA clearance required
- OHIF in viewing mode is not SaMD (Software as Medical Device)
- No AI/CAD/auto-measurement features

### Implementation Checklist
1. HTTPS everywhere (no HTTP)
2. AES-256 encrypted storage for Orthanc
3. Audit log module in FastAPI — every action logged
4. Audit log integrity: append-only file permissions + periodic export to off-system storage
5. Automatic logout on inactivity
6. Patient links — expiring (30 days default), cryptographically random tokens, logged
7. bcrypt password hashing
8. Rate limiting on login (brute force protection)
9. CORS — portal hostname/IP only
10. JWT tokens with short TTL + refresh, revocable via token_version
11. BAA with any external vendor
12. Orthanc HTTP API (:48923) firewalled — accessible only from FastAPI (localhost), not LAN
13. Backup strategy: daily SQLite + Orthanc storage backups, 30-day retention, offsite copy, quarterly restoration test

## Deployment (No Docker)

- **Orthanc** — native install on clinic server
- **FastAPI** — uvicorn, managed via systemd
- **React** — static build served by nginx
- **OHIF** — static build served by nginx
- **nginx** — reverse proxy, single entry point with HTTPS
- **SQLite** — file alongside FastAPI, scheduled backups
- **Orthanc storage** — separate disk/partition, scheduled backups

Docker containerization deferred until production-ready.

## Technology Stack Summary

| Layer      | Technology                        |
|------------|-----------------------------------|
| DICOM      | Orthanc (native)                  |
| Viewer     | OHIF Viewer (embedded)            |
| Backend    | Python, FastAPI, uvicorn          |
| Frontend   | React, shadcn/ui, Lucide icons    |
| Database   | SQLite                            |
| Proxy      | nginx                             |
| Auth       | JWT + bcrypt                      |
