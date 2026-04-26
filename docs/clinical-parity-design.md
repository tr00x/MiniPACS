---
title: Clinical Parity — master design
date: 2026-04-25
status: draft → approval pending
supersedes-section: docs/milestone-clinical-parity.md (this is the executable design)
---

# Clinical Parity — Master Design

**Goal:** give a Sectra/Philips/Fuji-trained radiologist eight features that
remove their reasons to keep using the old PACS. Ship as eight independent
sub-specs in a defined order so each is reversible and testable on its own.

**Non-goal:** match every commercial bell. Pick the eight that move the
radiologist's day. Skip the rest.

---

## Decomposition (8 shippable units)

| # | Unit | Block | Why this order |
|---|------|-------|----------------|
| A | Persistent annotations (measurements) | 1.1 | Deepest unknown — Stone measurement API limits. If it walls, we trigger H early. |
| B | Cine playback for multi-frame | 1.3 | Trivial. Days. Ship while A is in QA. |
| C | Prior comparison side-by-side | 1.2 | Clinical win. No Stone API risk on baseline (no scroll-sync v1). |
| D | DICOM Modality Worklist (MWL) C-FIND SCP | 2.1 | Largest commercial moat. No open-source PACS does this cleanly. |
| E | Structured reporting templates + DICOM SR | 2.2 | Reuses `study_reports`. Adds template layer + SR emit to Orthanc. |
| F | Critical findings + acknowledgement workflow | 2.3 | Depends on E (report flow). Medico-legal cover. |
| G | Referring physician portal | 3 | Upgrades existing one-shot shares to persistent accounts. |
| H | OHIF as default + hanging protocols + MPR | 4 | Strategic 2-3 week bet. Fires when A walls, or after A-G ship. |

Each unit gets its own `writing-plans` plan, its own commits, its own
rollback. Master design freezes interfaces between units so plans can be
written in parallel without later rework.

---

## Unit A — Persistent annotations

**Backend**
- New table `study_measurements`:
  ```
  id BIGSERIAL PK
  orthanc_study_id TEXT NOT NULL
  orthanc_series_id TEXT NOT NULL
  orthanc_instance_id TEXT NOT NULL
  sop_instance_uid TEXT NOT NULL
  tool TEXT NOT NULL  -- "length" | "angle" | "ellipse" | "rectangle" | "freehand" | "arrow" | "text"
  coords_json JSONB NOT NULL
  label TEXT
  author_id BIGINT REFERENCES users(id)
  created_at TIMESTAMPTZ DEFAULT now()
  updated_at TIMESTAMPTZ DEFAULT now()
  INDEX (orthanc_study_id)
  ```
- Endpoints (`backend/app/routers/measurements.py`):
  - `POST /api/measurements` — create
  - `GET /api/measurements?study_id=…` — list
  - `PATCH /api/measurements/{id}` — label/coords update
  - `DELETE /api/measurements/{id}`
- Worklist badge: `/api/studies` already aggregated. Add a single COUNT subquery and emit `has_measurements: bool` in each row.

**Stone integration** (`frontend/src/viewers/stone-bridge.ts` — new):
- Inject a small bridge JS into the Stone iframe on load (postMessage handshake)
- Subscribe to `measurement-added/modified/removed` events from Stone (verified API: `GetMeasurementsAsJson`, `LoadMeasurements`)
- On every change → POST/PATCH/DELETE
- On study open → fetch all measurements for the study → `LoadMeasurements`

**Risk:** Stone's measurement API is documented but limited (no freehand,
no text annotations). If unit A reveals the limit hits clinical needs, mark
it "Stone-only basic tools" and start unit H in parallel rather than
forcing the limit on the radiologist.

---

## Unit B — Cine playback

**Backend** — none. Multi-frame detection is already in Orthanc tags.

**Frontend**
- Stone launcher: enable cine toolbar unconditionally in Stone config
  (`orthanc/stone-config.json` if mounted; otherwise add as a UserConfig
  override). Stone shows the control only when the active series has
  multi-frame instances, so no per-series logic needed in the launcher.
- Frame rate slider: Stone has it built-in once cine is enabled.

Effort: hours. Ship same day as the unit-A frontend wave.

---

## Unit C — Prior comparison

**Backend** (`backend/app/routers/studies.py`):
- `GET /api/studies/{id}/priors` returns ordered list, newest-first:
  ```
  [{
    "study_id": "...", "study_uid": "...",
    "study_date": "20240115", "modality": "MR",
    "study_description": "MRI Knee Right",
    "body_part_match": true,        # parsed substring overlap with current
    "modality_match": true
  }, ...]
  ```
- Implementation: Orthanc `/tools/find` by `PatientID`, sort by `StudyDate`,
  filter out current. Body-part match = naive token overlap on
  `StudyDescription` (cheap, good enough for first ship).

**Frontend**
- `StudyDetailPage` gets a "Priors" panel showing list (date, modality,
  description, body-part badge).
- Click → opens viewer with `?StudyInstanceUIDs=current,prior` for OHIF
  (native dual-study layout) or two side-by-side iframes for Stone (no
  scroll-sync v1; defer sync until v2 if user asks).

**Defer to v2 (not in unit C):** scroll/W-L synchronisation between viewports.

---

## Unit D — DICOM Modality Worklist (MWL) C-FIND SCP

**Orthanc**
- Enable built-in `Worklists` plugin in `orthanc-docker.json`:
  ```
  "Worklists": {
    "Enable": true,
    "Database": "/var/lib/orthanc/worklists",
    "FilterIssuerAet": false,
    "LimitAnswers": 100
  }
  ```
- Mount `orthanc-worklists` named volume to `/var/lib/orthanc/worklists`.

**Backend**
- New table `worklist_orders`:
  ```
  id BIGSERIAL PK
  accession_number TEXT UNIQUE NOT NULL
  patient_id TEXT NOT NULL              -- DICOM PatientID (MRN)
  patient_name TEXT NOT NULL            -- "LAST^FIRST^MIDDLE"
  patient_birth_date DATE
  patient_sex CHAR(1)
  scheduled_datetime TIMESTAMPTZ NOT NULL
  scheduled_station_aet TEXT NOT NULL   -- e.g. "MRI1"
  modality TEXT NOT NULL                -- "MR" | "CT" | "CR" | "US" | …
  study_description TEXT
  requested_procedure_id TEXT
  status TEXT NOT NULL DEFAULT 'scheduled'
       -- scheduled | started | completed | discontinued | expired
  created_by BIGINT REFERENCES users(id)
  created_at TIMESTAMPTZ DEFAULT now()
  ```
- Worklist file writer (`backend/app/services/mwl_writer.py`):
  - On `POST /api/orders` → write a DICOM file to the worklist directory
    using `pydicom` with the required MWL fields
    (`ScheduledProcedureStepSequence`, `ScheduledStationAETitle`, etc.)
  - On status change → rewrite or remove the file
  - On C-STORE arrival with matching `AccessionNumber` (Lua/Python hook on
    Orthanc `OnStoredInstance`) → mark `status='completed'` + delete file
  - TTL job: anything older than 7 days unmatched → mark `expired` + delete file

**Frontend** (`frontend/src/pages/OrdersPage.tsx` — new):
- List today's orders with status filter
- "New order" form: patient lookup or new patient, accession (auto-gen
  ULID-ish if blank), scheduled datetime, modality, station AET, description
- Status badge per row; manual "Discontinue" action

**Modality config doc** (`docs/equipment-mwl-setup.md`):
- AE = `MINIPACS`, host = clinic LAN IP, port = `4242` (existing DICOM port),
  C-FIND query parameters, sample C-FIND test command.

**Why this is the moat:** every commercial PACS demo opens with MWL.
Open-source competitors require manual JSON file editing or external RIS
integration. We ship a UI form. That alone closes deals.

---

## Unit E — Structured reporting templates + DICOM SR

**Backend**
- New table `report_templates`:
  ```
  id BIGSERIAL PK
  name TEXT NOT NULL
  modality TEXT          -- nullable = any
  body_part TEXT         -- nullable = any
  schema_json JSONB NOT NULL
       -- [{key, label, type: "text"|"number"|"enum"|"measurement",
       --   required: bool, options?: [...], default?: ...}]
  is_active BOOLEAN DEFAULT true
  created_by BIGINT REFERENCES users(id)
  created_at TIMESTAMPTZ DEFAULT now()
  updated_at TIMESTAMPTZ DEFAULT now()
  ```
- Endpoints (`backend/app/routers/report_templates.py`): CRUD.
- Existing `study_reports` keeps free-text. New optional column
  `template_id BIGINT REFERENCES report_templates(id)` and
  `template_values JSONB` — stores the form payload that produced the text.
- DICOM SR emitter (`backend/app/services/sr_emitter.py`):
  - Build Basic Text SR (`SOPClassUID = 1.2.840.10008.5.1.4.1.1.88.11`) via
    `pydicom`
  - Reference the parent study by `StudyInstanceUID`, copy `PatientID`,
    `PatientName`, `AccessionNumber`
  - Body = templated text + machine-readable findings list
  - `POST /instances` to Orthanc → SR shows up as a series in the study

**Frontend** (`frontend/src/pages/ReportEditorPage.tsx` — extend existing):
- "Use template" dropdown next to the editor
- Selecting a template renders fields above the free-text area; the editor
  body is auto-populated from a Mustache-style render of the schema
- Save → both `study_reports` row and the SR instance

**Seed templates** (migration):
1. MRI Knee — Findings (menisci, ligaments, cartilage, bone marrow), Impression
2. MRI L-Spine — Findings (alignment, discs L1-S1, cord, foramina), Impression
3. Chest X-Ray — Findings (lungs, heart, mediastinum, bones, devices), Impression

---

## Unit F — Critical findings + acknowledgement

**Backend**
- New table `critical_findings`:
  ```
  id BIGSERIAL PK
  study_id BIGINT REFERENCES study_reports(orthanc_study_id) … (TEXT FK actually)
  report_id BIGINT REFERENCES study_reports(id)
  flagged_by BIGINT REFERENCES users(id)
  flagged_at TIMESTAMPTZ DEFAULT now()
  ack_token TEXT UNIQUE NOT NULL          -- random 32 bytes urlsafe
  recipient_name TEXT NOT NULL
  recipient_email TEXT NOT NULL
  acknowledged_at TIMESTAMPTZ
  acknowledged_ip INET
  notes TEXT
  ```
- Endpoints:
  - `POST /api/reports/{id}/flag-critical` — body `{recipient_name, recipient_email, notes}`
  - `GET /api/critical/by-token/{token}` — public, no auth, returns minimal study info + report text
  - `POST /api/critical/ack/{token}` — public, marks ack
  - `GET /api/critical?status=open|all` — radiologist dashboard list
- SMTP integration: extend existing `settings` (already supports keyed
  values) with `smtp_host`, `smtp_port`, `smtp_user`, `smtp_pass`,
  `smtp_from`. Send via `aiosmtplib` from a background task; failure does
  not block the flag (record the row, surface the failure on dashboard).

**Frontend**
- Reports editor: "Flag critical" button (rad role only) → modal with
  recipient form
- New `/critical/{token}` public page: read-only one-study view (Stone
  embed) + report text + "Acknowledge receipt" button
- Audit log entries via existing `audit` table on flag and ack

---

## Unit G — Referring physician portal

**Backend**
- New table `referring_physicians`:
  ```
  id BIGSERIAL PK
  full_name TEXT NOT NULL
  email TEXT UNIQUE NOT NULL
  clinic TEXT
  password_hash TEXT NOT NULL
  match_names JSONB NOT NULL          -- ["Smith^John", "Smith^J", ...] for DICOM tag match
  is_active BOOLEAN DEFAULT true
  totp_secret TEXT                    -- nullable; v2 will offer enrolment
  last_login_at TIMESTAMPTZ
  created_at TIMESTAMPTZ DEFAULT now()
  ```
- Auth: separate JWT audience `referring`, never crosses with admin tokens
  - `POST /api/auth/referring/login` — email + password (+ optional totp)
- Endpoints (referring scope):
  - `GET /api/referring/studies` — Orthanc `/tools/find` with
    `ReferringPhysicianName` IN (match_names), paginated
  - `GET /api/referring/studies/{id}/full` — read-only aggregate
  - Read-only viewer (Stone or OHIF) launched with the same JWT cookie

**Frontend**
- New route `/referring` with its own login page and worklist layout
- No delete, no transfer, no share creation, no settings access
- Reuse existing read-only viewer launchers

---

## Unit H — OHIF as default + hanging protocols + MPR

Trigger: unit A reveals Stone API limits, OR after A-G ship and we have
budget.

- Flip `external_viewers.sort_order` so OHIF is row 1
- Keep Stone as opt-in "fast viewer" alternative
- OHIF user-config:
  - Hanging protocols for top 5: MR Knee, MR Brain, MR L-Spine, CT Chest, CR Chest
  - Cornerstone3D MPR enabled for CT
  - Measurement service writes DICOM SR → reuses unit E SR pipeline

Effort: 2-3 weeks including LAN-bundle latency tuning per
`docs/ohif-speedup.md`.

---

## Cross-cutting decisions

- **All UI strings English.** Memory: `feedback_ui_english_only.md`.
- **Direct commits to master.** Memory: `feedback_no_pr_direct_master.md`.
- **Local-first dev → push → user pulls on prod.** Memory:
  `feedback_no_prod_ssh_deploy.md`.
- **No mock data, no deferred CRUD.** Every endpoint ships with real
  persistence and real Orthanc round-trips.
- **PostgreSQL is the only datastore.** All new tables live in the shared
  `orthanc` PG database (memory: `project_backend_pg_migration.md`).
- **Migrations:** existing pattern in `backend/app/db.py` — extend the
  schema bootstrap to create new tables idempotently with `CREATE TABLE IF
  NOT EXISTS`.
- **Audit:** every privileged write (measurement create, order create,
  flag critical, referring login) appends to existing `audit` table.

## Out of scope for this milestone

- AI auto-impression / GPT integration
- Voice dictation
- Mobile-responsive radiologist UI
- Multi-tenant role hierarchy beyond {admin, radiologist, referring}
- Active Directory / SAML SSO
- DICOM Storage Commitment SCP
- DICOM MPPS (Modality Performed Procedure Step)

## Rollout order — locked

A → B (parallel with A QA) → C → D → E → F → G → H

After each unit: smoke test, commit, push. No batching across units.

## Per-unit deliverables checklist (template each plan must satisfy)

- [ ] Migration written and tested locally
- [ ] Backend router with full CRUD + audit hooks
- [ ] Frontend page or component wired to React Query
- [ ] All UI strings English
- [ ] Smoke test passes on local docker
- [ ] Rollback documented (revert SQL + revert commit)
- [ ] Updated `CHANGELOG.md`
