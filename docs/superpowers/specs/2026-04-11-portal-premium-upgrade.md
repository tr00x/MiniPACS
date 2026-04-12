# MiniPACS Portal — Premium Upgrade Design

## Overview

Full audit of the MiniPACS portal revealed 30+ gaps between the spec and current implementation. This design covers: foundation infrastructure, spec compliance, and UX polish to bring the portal to premium production quality.

## Approach: Foundation + User Journey

Build shared infrastructure first (utilities, toast, error handling), then walk through every user journey fixing everything along the path.

---

## Phase 1: Foundation Layer

### 1.1 Shared DICOM Utilities
Extract from 6+ files into `frontend/src/lib/dicom.ts`:
- `formatDicomName(raw)` — "DOE^JOHN" → "John Doe"
- `formatDicomDate(raw)` — "20260411" → "Apr 11, 2026"
- `formatTimestamp(raw)` — ISO → locale string
- `calculateAge(birthDate)` — "19850315" → "41 yrs"
- `getInitials(name)` — for avatar circles
- `getAvatarColor(name)` — hash → tailwind color class
- `getModalityColor(mod)` — CT→blue, MR→violet, etc.

All pages switch to single import from `@/lib/dicom`.

### 1.2 Toast System
Add `sonner` (shadcn/ui ecosystem). `<Toaster />` in App.tsx. Every successful save/create/delete/send/revoke shows a toast. Errors through toast where appropriate.

### 1.3 Confirm Dialog
`ConfirmDialog` component on shadcn AlertDialog. Replaces all browser `confirm()` calls — delete user, delete node, revoke share.

### 1.4 Error Boundary + 404
- `ErrorBoundary` component — catches React crashes, shows "Something went wrong" with reload button
- `NotFoundPage` — catch-all route `*`

### 1.5 Sidebar Active State Fix
`location.pathname.startsWith(to)` instead of exact match. `/patients/abc-123` highlights "Patients". Dashboard (`/`) uses exact match.

### 1.6 Settings → AuthProvider Connection
AuthProvider reads `auto_logout_minutes` from `/api/settings` at init. Fallback 15 min if not set.

### 1.7 Loading Skeletons
`TableSkeleton` (animated rows) and `CardSkeleton` components. Replace "Loading..." text on all pages.

---

## Phase 2: Login → Dashboard

### 2.1 LoginPage
- **Rate limit handling** — 429 → "Too many attempts, try again in X minutes"
- **Clinic branding** — show `clinic_name` from settings (new public endpoint `GET /api/settings/public` returning only clinic_name)
- **HIPAA notice** — small text under form: "This system contains protected health information. Unauthorized access is prohibited."

### 2.2 DashboardPage
- **Welcome message** — "Welcome back, {username}" with current date
- **Time-based metrics** — "Studies today", "Transfers this week" (new backend endpoint `GET /api/stats` with counts, replacing loading ALL patients/studies)
- **Quick actions** — 2 buttons: "Create Share Link", "View Transfer Log"
- **Recent studies list** — replace current transfers/shares lists with last 5 studies (more useful for solo clinic)

---

## Phase 3: Find Patient → View Study

### 3.1 PatientsPage
- **Pagination** — backend supports `limit/offset`. UI: page size 25, prev/next, total count
- **Column sorting** — clickable column headers: Name, DOB, Studies count. Client-side sort

### 3.2 PatientDetailPage
- **Transfer history** — spec requires. New section showing transfers filtered by this patient's studies. Table: study description, destination, status, date
- **Breadcrumb** — `Patients > John Doe` at top instead of only back arrow

### 3.3 StudiesPage
- **Search** — by patient name, description, accession number (300ms debounce)
- **Filters** — modality dropdown, date range (from/to)
- **Pagination** — same as PatientsPage
- **Patient column → link to patient** — currently links to study. Add separate click on patient name → PatientDetailPage

### 3.4 StudyDetailPage
- **Success toast after Send** — "Study sent to {node_name}"
- **Create Share from study** — "Share with Patient" button creates share for ParentPatient
- **Breadcrumb** — `Studies > CT Chest — John Doe`
- **Smart back button** — `useNavigate(-1)` instead of hardcoded `/studies`

---

## Phase 4: Send to PACS → Transfers

### 4.1 TransfersPage
- **Pagination** — limit/offset, 25 per page
- **Filters** — status dropdown (all/success/failed/pending), date range
- **Auto-refresh** — poll every 10s while pending transfers exist
- **Patient name** — resolve from studies API, show alongside study ID

### 4.2 PacsNodesPage
- **Description column** — show in table (field exists but not displayed)
- **ConfirmDialog** for delete instead of `confirm()`
- **Active/Inactive toggle** — clickable Badge directly in table row

---

## Phase 5: Create Share → Patient Portal

### 5.1 SharesPage
- **Pagination** — 25 per page
- **Search** — by patient name
- **ConfirmDialog** for Revoke

### 5.2 PatientPortalPage (critical)
- **OHIF viewer** — spec requires "OHIF read-only (embedded)". Embed OhifViewer component. Patient clicks study → inline viewer expands
- **Clinic branding** — header shows `clinic_name`, footer shows `clinic_phone` and `clinic_email` from settings
- **Study cards** — Card per study (date, description, modality badge) with View and Download buttons. Visual parity with admin pages
- **External viewer buttons** — spec requires. Load enabled viewers, show buttons per study

---

## Phase 6: Admin Polish

### 6.1 AuditPage
- **shadcn Select** instead of raw `<select>` for user filter
- **Export CSV** — button generates CSV from current filtered view

### 6.2 SettingsPage
- **Success toast** after save — "Settings saved"
- **ConfirmDialog** for delete user
- **Password hint** — "Minimum 8 characters" in Add User dialog

### 6.3 Sidebar
- **Clinic name** — header from settings instead of hardcoded "MiniPACS"

---

## New Backend Endpoints Required

| Endpoint | Purpose |
|----------|---------|
| `GET /api/settings/public` | Returns only `clinic_name` — no auth required, for LoginPage and PatientPortalPage |
| `GET /api/stats` | Dashboard counts: patients_total, studies_total, studies_today, transfers_week, failed_transfers, unviewed_shares |

## Summary

~30 changes across 6 phases. Foundation first (shared utils, toast, error handling), then user journey fixes (login → dashboard → patients → studies → transfers → shares → patient portal → admin).
