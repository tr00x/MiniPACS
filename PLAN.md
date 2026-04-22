# MiniPACS — Competitive On-Prem Roadmap

**Date:** 2026-04-22
**Current commit:** `9dd5956` (origin/master)
**Goal:** On-prem PACS for solo clinics that matches cloud competitors (PostDICOM/MedDream/Ambra) on perceived speed.

## Product decision — locked

- **Model:** on-prem install on clinic hardware. **No SaaS.**
- **Hardware requirement for new customers:** Ubuntu Server 22.04 LTS bare metal or Proxmox VM. 16 GB RAM, NVMe SSD, 4+ cores.
- **Clinton Medical (current pilot):** stays on WSL2 until Day 4 tests prove Ubuntu is better — then migrate.

## Why we're slow today

The single architectural root cause: **`/dicom-web/studies/{uid}/metadata` in Full mode reads every `.dcm` file from disk on each request.** No amount of backend/nginx/React optimization removes this disk read. That's why:
- Dashboard / Worklist / Patient list / Study detail = <1s already (backend+cache works)
- OHIF cold open = 20-30s (Full mode disk reads, CF Tunnel 100s timeout risk)

## Fix strategy — 4 days

Remove five architectural debts in order. Each day is independently reversible via `git revert`.

---

## Day 1 — Replace custom OHIF with Orthanc OHIF plugin

**Impact:** OHIF cold-open drops 20s → 1-3s for both old and new studies. This is the single biggest win.

**Why it works:** Orthanc OHIF plugin precomputes DICOM JSON metadata as a SQLite attachment when each study becomes stable (60s after last instance). Viewer opens read from attachment — zero disk I/O.

**Tasks:**

1. **`frontend/Dockerfile`:** remove these lines:
   ```
   COPY ohif-dist/ /usr/share/nginx/ohif/
   COPY ohif-config/minipacs.js /usr/share/nginx/ohif/app-config.js
   COPY ohif-config/minipacs-brand.css /usr/share/nginx/ohif/minipacs-brand.css
   RUN sed -i 's|</head>|<link ...
   RUN sed -i 's|<head>|<head><script>window.__filename=...
   ```
2. **`nginx/nginx-prod.conf`:** delete `location /ohif/index.html`, `location /ohif/` (alias blocks), `location /ohif-plugin/`. Replace with single:
   ```nginx
   location /ohif/ {
       proxy_pass http://orthanc_upstream/ohif/;
       proxy_http_version 1.1;
       proxy_set_header Connection "";
       proxy_set_header Host $host;
       proxy_set_header Authorization "Basic ${ORTHANC_BASIC_AUTH}";
       proxy_read_timeout 300s;
   }
   ```
3. **`orthanc/orthanc-docker.json`:** update OHIF block — remove `RouterBasename`, set `Preload: true`, `DataSource: "dicom-json"`. Add `UserConfiguration` pointing to a file we mount with MiniPACS logo/colors.
4. **Branding via UserConfiguration:** create `orthanc/ohif-user-config.json` with OHIF config overrides (logo, theme). Mount via volume. Reference: <https://orthanc.uclouvain.be/book/plugins/ohif.html#user-configuration>
5. **`backend/app/database.py`:** in `default_viewers` seed, first row stays "OHIF Viewer" but URL becomes `/ohif/?StudyInstanceUIDs={StudyInstanceUID}`. Drop the "Orthanc OHIF (Fast)" row and all references to `/ohif-plugin/`.
6. **Backfill 854 existing studies** with ohif-dicom-json attachment. One-time async reconstruct:
   ```python
   # run inside backend container
   import httpx, os
   c = httpx.Client(base_url='http://orthanc:8042',
                    auth=(os.environ['ORTHANC_USERNAME'], os.environ['ORTHANC_PASSWORD']),
                    timeout=60)
   for sid in c.get('/studies').json():
       c.post(f'/studies/{sid}/reconstruct',
              json={'Asynchronous': True, 'ReconstructFiles': False})
   ```
   `ConcurrentJobs=6` handles this in the background. Monitor via `GET /jobs?expand`.
7. **Deploy + measure:**
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build frontend orthanc
   ```
   Verify via Playwright: `studyToFirstImage` < 3s on a new study, < 5s on old (before backfill completes), < 2s on any study after backfill.

**Rollback:** `git revert`, rebuild. Custom OHIF bundle returns.

---

## Day 2 — PostgreSQL backend for Orthanc

**Impact:** concurrent writes, parallel reconstruct, no SQLite global write lock. Matters under burst C-STORE from multiple modalities or parallel admin jobs.

**Tasks:**

1. **`docker-compose.prod.yml`:** add service:
   ```yaml
   postgres:
     image: postgres:16-alpine
     restart: unless-stopped
     volumes:
       - orthanc-pg:/var/lib/postgresql/data
     environment:
       POSTGRES_USER: orthanc
       POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}"
       POSTGRES_DB: orthanc
     healthcheck:
       test: ["CMD-SHELL", "pg_isready -U orthanc"]
   ```
2. **`orthanc` service env:**
   ```yaml
   POSTGRESQL_PLUGIN_ENABLED: "true"
   POSTGRESQL_HOST: postgres
   POSTGRESQL_PORT: "5432"
   POSTGRESQL_DATABASE: orthanc
   POSTGRESQL_USERNAME: orthanc
   POSTGRESQL_PASSWORD: "${POSTGRES_PASSWORD}"
   ```
3. **`orthanc/orthanc-docker.json`:** add `PostgreSQL` block:
   ```json
   "PostgreSQL": {
     "EnableIndex": true,
     "EnableStorage": false,
     "Lock": true,
     "IndexConnectionsCount": 10
   }
   ```
   Keep `EnableStorage: false` — DICOM files stay on disk (simpler backup, no blob-in-DB pain).
4. **Migration (Clinton Medical specifically):**
   - Stop stack.
   - `docker compose run --rm orthanc Orthanc --verbose --upgrade` (Orthanc plugin auto-migrates from SQLite to PG on first run if `PostgreSQL.EnableIndex=true` and existing SQLite index found). Back up first.
   - Start stack. Verify `/studies` count matches.
5. **Backup script update:** dump PG (`pg_dump`) + tar.gz DICOM storage. Two files instead of one.

**Rollback:** remove PG env, keep `EnableIndex: false`. Orthanc falls back to SQLite if present.

---

## Day 3 — Lua OnStableStudy prewarm + optional HTJ2K

**Impact:** new studies from equipment are ready for viewing *instantly* after the 60s stable timer — no user pays cold-open cost.

**Tasks:**

1. **Activate Lua hook:** `orthanc/orthanc-docker.json`:
   ```json
   "LuaScripts": ["/etc/orthanc/lua/prewarm_on_stable.lua"]
   ```
   Mount `orthanc/lua/` into `/etc/orthanc/lua/` via compose volume.
2. **`orthanc/lua/prewarm_on_stable.lua`** (local CC already authored — verify it triggers the right endpoints):
   ```lua
   function OnStableStudy(studyId, tags, metadata)
     -- Force precompute of OHIF DICOM JSON attachment
     RestApiGet('/studies/' .. studyId .. '/ohif-dicom-json')
     -- Warm DICOMweb metadata so nginx cache gets it too
     local uid = tags['StudyInstanceUID']
     if uid then
       RestApiGet('/dicom-web/studies/' .. uid .. '/metadata')
     end
   end
   ```
3. **Test:** send one DICOM via storescu, wait 60s (StableAge), open in OHIF — should be <2s with zero prior viewer opens.
4. **Optional HTJ2K transcoding** (defer if GDCM plugin lacks support): on ingest, transcode to `1.2.840.10008.1.2.4.201` (HTJ2K lossless). 3-5× smaller frames = faster streaming.

---

## Day 4 — Installer + Ubuntu Server validation

**Impact:** shippable product. One command deploy on a fresh Ubuntu VM.

**Tasks:**

1. **`scripts/install.sh`** — idempotent Ubuntu installer:
   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   # 1. Check Ubuntu 22+
   . /etc/os-release
   [[ "$ID" == "ubuntu" && "${VERSION_ID%%.*}" -ge 22 ]] || { echo "Need Ubuntu 22.04+"; exit 1; }
   # 2. Docker + compose
   command -v docker || curl -fsSL https://get.docker.com | sh
   # 3. Clone or update
   cd /opt
   [[ -d minipacs ]] || git clone https://github.com/tr00x/MiniPACS.git minipacs
   cd minipacs && git pull
   # 4. .env generation
   [[ -f .env ]] || ./scripts/generate-env.sh
   # 5. Build + up
   docker compose -f docker-compose.prod.yml up -d --build
   # 6. Admin user
   docker compose exec backend python -m app.create_user
   # 7. Backup cron
   (crontab -l 2>/dev/null; echo "0 2 * * * /opt/minipacs/scripts/backup.sh") | crontab -
   # 8. Next steps print
   echo "Install complete. Next:"
   echo "  - Configure Cloudflare Tunnel: ..."
   echo "  - Point modality AE MINIPACS to this host:48924"
   ```
2. **`docs/install.md`** — 1-pager for clinic IT:
   - Hardware requirements (Ubuntu 22.04 LTS, 16 GB RAM, NVMe 1TB+, static LAN IP).
   - Port forward on router: `WAN:48924 → LAN:48924` (DICOM C-STORE).
   - Cloudflare Tunnel setup (10 min).
   - Smoke test checklist.
3. **`docs/equipment-setup.md`** — radiology tech reference:
   - AE title = `MINIPACS`
   - Host = clinic server LAN IP
   - Port = `48924`
   - Test via C-ECHO from modality console.
4. **Validation on Hetzner:** spin up a 4-core 16GB Ubuntu 22.04 VM (~$15/mo), run `install.sh`, push 100 test DICOMs, open in OHIF, measure. Target: cold open < 2s, warm < 500ms.
5. **Document Clinton migration path:** when Timur is ready, backup WSL2 data, fresh Ubuntu install, restore DICOM + SQLite-or-PG-dump.

---

## Validation gates

After each day, run this smoke test — all must pass before moving to next day:

| Check | Target |
|-------|--------|
| `/api/health` | 200 < 500ms |
| `/api/studies?limit=50` | < 700ms |
| `/api/patients?limit=50` | < 600ms |
| `/api/studies/{id}/full` on fresh study | < 1s |
| OHIF cold open via Playwright | Day 1: < 5s, Day 3: < 2s |
| OHIF warm open (2nd time) | < 500ms |

## Rules for the session doing this work

1. **Every day = its own feature branch, its own commit.** Never combine days.
2. **Rollback path documented for each day** before deploy.
3. **Playwright smoke test must pass** before merging day's work.
4. **Keep custom OHIF files in the repo** even after Day 1 removes them from Dockerfile — keeps `git revert` clean.
5. **Do not touch volumes** `orthanc-data`, `minipacs-db`, `orthanc-pg` destructively. Backup first.
6. **Talk to user before** starting Day 2 PG migration on Clinton Medical — it's the highest-risk step.

## What comes after Day 4

- **Security hardening:** rotate admin/orthanc/postgres passwords, replace default `hdp123` SSH, firewall rules, fail2ban.
- **Monitoring:** UptimeRobot on `/api/health`, healthcheck.io for backup cron, Grafana dashboard scraping `/statistics` and FastAPI `/metrics`.
- **Offsite backup:** rclone to Backblaze B2 ($6/TB/mo) for 3-2-1 compliance.
- **NAS backup** (if clinic has one): rsync target added to backup.sh.
- **CF Access** email-login on `/api/*` and `/orthanc/*` for extra auth layer.
- **Product polish:** rebrand MiniPACS Viewer, clinic-specific white-labeling on login/dashboard.
