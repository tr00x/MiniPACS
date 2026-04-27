# Milestone: Clinical parity with commercial PACS

**Goal:** take a radiologist who is used to Sectra / Philips IntelliSpace /
Fuji Synapse and give them a reason not to go back. Today we beat
open-source PACS on UX and ingest speed; we trail commercial PACS on
clinical workflow. This milestone closes the workflow gap.

**Non-goal:** feature-match every bell and whistle. We pick the 8 items
that actually move a radiologist's day, skip the rest.

---

## Block 1 — "Won't give this back" (radiologist QoL)

The three features a radiologist touches every study. If these work,
they stop opening Sectra out of habit.

### 1.1 Persistent annotations
Backend table `measurements(study_id, series_id, instance_id, tool, coords_json, label, author_id, created_at)`. Stone posts on tool-complete to `POST /api/measurements`. Worklist shows a badge when a study has measurements. A re-opened study reloads them into Stone via `viewer.loadMeasurements(...)`.
Gotchas: Stone's measurement API is limited — may force a move to OHIF for
tools beyond length/angle/ellipse. If so, this block triggers Block 4 early.

### 1.2 Prior comparison
On study open, backend finds priors: same `PatientID`, same body part (parsed from StudyDescription + SeriesDescription), optional modality filter. Viewer renders a side-by-side layout: current left, most-recent prior right, synchronized scroll + W/L. Stone's "compare" API or an iframe-pair shim.
Endpoint: `GET /api/studies/{id}/priors` → ordered list by StudyDate desc.

### 1.3 Cine playback for multi-frame
Stone already supports it — we flip the config and add a toolbar play/pause + frame-rate slider. US cine loops and cardiac MRI series need this or they are unreadable. First deliverable: cine button visible for any series with >1 frame and Modality in {US, XA, RF, MR if multi-frame}.

---

## Block 2 — "Workflow loop closes" (PACS, not viewer)

Without these we are a pretty viewer, not a replacement PACS. Commercial
vendors win every deal on these three.

### 2.1 DICOM Modality Worklist (MWL) C-FIND SCP
Tech at the MRI console types patient name → gets today's scheduled study with Accession Number, PatientID, scheduled time — no retyping. Implement via Orthanc's built-in MWL (worklist from JSON files) or pynetdicom C-FIND handler backed by our `orders` table. Expose `POST /api/orders` to seed worklist from RIS/front desk.

### 2.2 Structured reporting templates
Reuse `study_reports`. Add `report_templates(id, name, modality, body_part, schema_json)` — schema is a list of field defs (findings, impression, measurements). Radiologist picks template, fills fields, backend emits DICOM SR and attaches to study via Orthanc `POST /instances`. Three templates at ship: MRI knee, MRI L-spine, chest X-ray — covers majority of Clinton's volume.

### 2.3 Critical findings workflow
Radiologist toggles "critical" on a report → backend queues notification (email first, SMS later). Referring physician clicks link, lands on a one-study view, acknowledges. `critical_findings(study_id, report_id, flagged_by, flagged_at, acknowledged_by, acknowledged_at)`. Audit trail is the whole point — medico-legal cover.

### 2.4 Study export (ISO + portable viewer)
Patient or referring physician needs a takeaway copy of the study. Backend builds an ISO 9660 image on demand from Orthanc `/studies/{id}/media` (DICOMDIR-included, IHE PDI compliant) plus a baked-in DWV (HTML5 DICOM Web Viewer, MIT) and minimal autorun, streams it via `GET /api/studies/{id}/burn-iso` with audit action `export_study_iso`. Radiologist clicks "Burn to CD/USB" on `StudyDetailPage`, downloads the `.iso`, then either burns to disc via Windows "Burn files to disc" or writes to USB via Rufus / balenaEtcher. Patient opens `index.html` in any browser (Win/Mac/Linux/iPad) — no Java, no install. Closes the "burn disc" feature gap that commercial PACS sell on. Concurrency capped at 2 builds (disk-spike control); no pre-cached ISOs.

---

## Block 3 — "Referring doctor stops calling"

### 3.1 Referring physician portal
Upgrade today's share-links into persistent accounts:
- `referring_physicians(id, name, email, clinic, is_active)`
- each has a scoped worklist — studies where they were the referrer (from `ReferringPhysicianName` tag)
- read-only viewer, no delete/modify
- optional 2FA on login

One clinic has ~15 referring docs; each currently calls the front desk to ask "is it ready?". Portal eliminates that call.

---

## Block 4 — "OHIF becomes default viewer" (strategic bet)

Stone is a dead-end for advanced features. Cornerstone3D / OHIF is where
the plugin ecosystem lives — hanging protocols, MPR, AI integrations, SR
annotation. Block 4 fires once Block 1 hits Stone's measurement-API wall,
OR as its own investment after Blocks 1-3 ship.

See `docs/ohif-speedup.md` for the performance path.

Scope of Block 4:
- OHIF becomes default viewer (`external_viewers.sort_order`)
- Stone stays available for users who prefer it (keep enabled row)
- Hanging protocols for top 5 body-part/modality combos
- Cornerstone3D MPR enabled for CT (head, chest, abdomen)
- Annotations persist via DICOM SR through OHIF's own measurement service

Effort: 2–3 weeks including tuning. Biggest risk is bundle-load latency on
slow clinic LANs — mitigated per the OHIF speedup doc.

---

## Sequence

1. Block 1 first — fastest wins, highest daily visibility.
2. Block 2 second — unblocks selling to clinics that need real PACS workflow.
3. Block 3 once we have referrals to bring aboard.
4. Block 4 parallel to 2/3 as a separate workstream — it's infrastructure,
   not a user-facing feature until we flip the default.

Nothing in here blocks on HTJ2K. That stays parked per
`docs/phase4-experimental.md`.

---

## Out of scope (explicitly)

- 3D volumetric reformatting beyond basic MPR — waits for clinical demand
- Voice dictation (Dragon/Nuance) — integration cost > value at current scale
- HL7 full integration — only MWL subset for now; full HL7 is Block 5 territory
- Multi-tenant isolation — architect single-tenant well, revisit when a second clinic signs
- AI triage models — marketing flash, skip until a concrete clinical partner asks
