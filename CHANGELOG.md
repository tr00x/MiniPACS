# Changelog

All notable changes to MiniPACS.

The format is roughly [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
kept deliberately thin — we do not cut numbered releases; every commit on
`master` is the product. Grouping below is by deploy wave, not by semver.

---

## Unreleased — 2026-05-01 — HIPAA technical safeguards

**Theme:** close the gap between the HIPAA badge and what the code actually
enforces. Sources: HIPAA Security Rule §164.312 + NIST 800-63B.

### Added

- **Password complexity policy** — `app/services/auth.validate_password_strength()`
  rejects passwords shorter than 12 characters or using fewer than 3 of
  4 character classes (lower, upper, digit, special). Wired into
  `create_user.py`, `change_password.py`, and the `POST /api/users` admin
  endpoint. Tests in `backend/tests/test_password_policy.py`.
- **Encrypted backups** — `scripts/backup.sh` now wraps both `pg_dump`
  and the DICOM tar in `openssl enc -aes-256-cbc -pbkdf2 -iter 100000`
  using `BACKUP_PASSPHRASE` from `.env`. Refuses to write plaintext PHI
  if the passphrase is missing.
- **Restore script** — `scripts/restore-backup.sh <YYYYMMDD_HHMM>`
  decrypts, calls `pg_restore --clean --if-exists`, and replaces the
  DICOM volume contents. Interactive YES guard.
- **`docs/hipaa-notes.md`** — implementation matrix mapping every
  §164.312 technical safeguard to MiniPACS code, plus the clinic-side
  checklist (FDE, Cloudflare BAA, off-site backup, MFA roadmap, etc.).
- **`docs/prod-hardening.md` §6 + §7** — full-disk encryption guidance
  (BitLocker / LUKS) and the Cloudflare Tunnel + BAA caveat called out
  in a `[!WARNING]` callout.

### Changed

- **`scripts/setup.sh`** generates `BACKUP_PASSPHRASE` (40 chars,
  `openssl rand -base64`) and writes it into `.env`. Prints a HIPAA
  notice block before prompting for domain + CF token, covering the
  BAA requirement and the FDE requirement.
- **`scripts/rotate-secrets.sh`** documents that `BACKUP_PASSPHRASE`
  is intentionally NOT rotated (would orphan existing encrypted
  backups) and lists the manual rotation procedure.
- **`.env.docker`** template adds `BACKUP_PASSPHRASE` placeholder with
  inline guidance.
- **README HIPAA badge** now links to `docs/hipaa-notes.md` instead of
  the in-page anchor — honest disclosure of what's implemented vs what
  remains the clinic's responsibility.

---

## 2026-04-24 session (7 commits)

**Theme:** backend engine swap, live-data pipes, LAN HTTPS, operational
resilience.

### Added

- **Redis-backed QIDO cache** with a memory fallback (`backend/app/services/cache.py`).
  Fresh window 30 s, stale envelope 600 s — stale-while-error preserves
  worklist visibility when Orthanc stalls. `redis:7-alpine` added to
  both compose files, no persistence, 128 MB allkeys-lru.
- **Live worklist WebSocket.** Orthanc Python plugin posts STABLE_STUDY
  events to `/api/internal/events/new-study` (shared-secret + RFC1918
  gated); backend invalidates the QIDO cache and broadcasts to every
  `/api/ws/studies` subscriber. Frontend `useStudiesWebSocket` hook
  invalidates `['studies']`, `['patients']`, `['dashboard']` and toasts
  the incoming patient.
- **Direct-LAN HTTPS.** nginx learns `listen 443 ssl; http2 on;` with a
  Cloudflare Origin Certificate mounted via `./ssl`. Self-signed fallback
  baked in so the listener always comes up. See
  [docs/split-horizon-https.md](docs/split-horizon-https.md).
- **Windows autostart + liveness watchdog.** `MiniPACS_Boot` fires
  `boot-minipacs.ps1` at Windows startup (WSL up → compose up →
  portproxy refresh → smoke probe). `MiniPACS_Watchdog` runs every
  5 min, triggers the boot sequence after 2 consecutive `/api/health`
  failures. `install-autostart.ps1` one-shot installer. systemd unit
  `minipacs-compose.service` inside WSL covers the
  `wsl --shutdown`/`wsl -d Ubuntu` path. See
  [docs/wsl-autostart.md](docs/wsl-autostart.md).
- **Production hardening scripts.** `scripts/rotate-secrets.sh`
  regenerates all `.env` secrets in one pass (SECRET_KEY, ORTHANC_PASSWORD,
  POSTGRES_PASSWORD, INTERNAL_EVENT_TOKEN; derives ORTHANC_BASIC_AUTH).
  `python -m app.change_password <user> <pwd>` bumps token_version so
  all sessions invalidate. See
  [docs/prod-hardening.md](docs/prod-hardening.md).
- **Architecture document.** [docs/architecture.md](docs/architecture.md)
  — request paths, services, storage layout, ports, caching hierarchy,
  schema boundary, auth surfaces, durability.

### Changed

- **Backend storage: SQLite → PostgreSQL.** Backend now shares Orthanc's
  PG database — disjoint table names, no additional user/db
  provisioning. `asyncpg.Pool` (min 2, max 8) behind a thin
  aiosqlite-shaped adapter (`app/db.py`) keeps router code almost
  untouched — `?` → `$N` translation, `INSERT ... RETURNING id`
  surfaces as `cursor.lastrowid`. `scripts/migrate_sqlite_to_pg.py`
  moves legacy installs' data idempotently.
- **Audit writes use the shared pool** instead of opening a fresh
  SQLite connection per event — a hot login page that used to land a
  dozen fresh connects/sec now collapses them into two.
- **Backup script** collapsed from three artefacts (SQLite copy + PG
  dump + DICOM tar) to two (PG dump + DICOM tar). One `pg_dump orthanc`
  now captures both applications' tables.

### Removed

- `aiosqlite` dependency — `asyncpg` replaces it.

### Upgrade path for existing installs

```bash
git pull --ff-only origin master
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml up -d --no-deps backend
docker compose exec backend python -m scripts.migrate_sqlite_to_pg
docker compose -f docker-compose.prod.yml build frontend
docker compose -f docker-compose.prod.yml up -d redis frontend
docker compose -f docker-compose.prod.yml restart orthanc
curl -fsS https://your-domain/api/health
```

---

## 2026-04-23 — Phase 1 + Phase 2 rocket design rollout

PWA, thumbnails, optimistic UI, aggregate endpoints, prefetch warming.

- PWA via `vite-plugin-pwa` + Workbox (installable, offline shell).
- Orthanc Python plugin `thumbnails.py` — pre-generates PNG thumbnails
  on STABLE_STUDY with a 2/s rate limit, one-shot backfill at boot,
  backend on-demand fallback via `/instances/{id}/preview`.
- Worklist grid view with thumbnails, backend
  `/api/studies/{id}/thumb` with 1h cache.
- `/api/boot` aggregate endpoint — user + settings + viewers +
  pacs-nodes in one call on page load, seeds React Query on landing.
- Optimistic UI for shares / pacs-nodes / users / viewers mutations.
- Keyboard navigation (`/ j k Enter`) and adjacent-study prefetch
  (`n/p`) in study detail.
- Backend orjson default response class (5–10× faster JSON serialize).
- FastAPI `CORSMiddleware max_age=86400` — browsers stop preflighting
  every `/api/` call.
- Stone preload hints in `index.html`; dashboard + worklist warmed in
  `AuthProvider` after login.

---

## 2026-04-22 — Stone-as-default viewer, prewarm Lua retired

- Stone Web Viewer becomes the default viewer (50× faster cold-open
  than the prior custom-OHIF bundle on 500+-slice MR).
- Stone skips SR/OT/KO/DOC/SEG/PR series its renderer does not handle.
- Stone branded as "MiniPACS viewer"; Orthanc branding hidden.
- Prewarm Lua script disabled — it blocked Orthanc HTTP under bulk
  ingest and warmed caches that Stone does not consume.
- OHIF retained as a secondary viewer.

---

## 2026-04-16 — Clinical deploy at the pilot clinic

First MiniPACS production deployment.

- Windows 11 host, WSL2 Ubuntu 24.04, Docker Engine 29.4.
- Cloudflare Tunnel at `pacs.your-clinic.example`.
- `docker-compose.prod.yml` production profile with cloudflared +
  nginx HTTP-only origin + LAN-only frontend bind.
- `MiniPACS_PortProxy` Scheduled Task keeps netsh portproxy rules
  aligned with the shifting WSL IP.
- Daily cron backups (SQLite + DICOM).
- All dev ports (48922/48923) kept off the LAN via portproxy scope.

---

## 2026-04-10 onward — initial MiniPACS

The portal itself — worklist, patients, shares with QR + PIN,
transfers between PACS nodes, audit log, external viewer launcher,
admin surfaces. Orthanc + FastAPI + React stack, originally on
SQLite for the application state. Development done in a flurry,
migrated to this codebase under BSL 1.1.
