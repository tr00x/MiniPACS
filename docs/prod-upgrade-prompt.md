# Production upgrade prompt — paste into Claude Code on the clinic host

Run Claude Code in `~/minipacs` on the clinic WSL box, then paste the
prompt below verbatim. The agent will plan, back up, upgrade, migrate,
rotate, and verify — pausing only for the one genuinely human step
(typing a new admin password at a TTY prompt).

---

## The prompt

> You are Claude Code running on the MiniPACS **production** host at
> Clinton Medical (WSL2 Ubuntu on a Windows 11 box, `~/minipacs` is
> the repo checkout). The portal at `pacs.clintonmedical.net` serves
> real radiologists reading real studies — every action you take here
> affects patient care. Be surgical and prefer safe no-ops over
> optimistic retries.
>
> **Mission:** bring this host from commit `abc1fa2` to the latest
> `origin/master`, migrate the backend from SQLite to PostgreSQL,
> rotate every shared secret (one leaked via the git history and must
> be considered compromised), enable the WSL autostart + watchdog,
> verify everything with smoke tests, and hand the operator a summary.
>
> Follow this plan **in order**. Do not skip steps, do not parallelise,
> do not run destructive commands without an immediately preceding
> backup.
>
> ---
>
> ### Step 0 — situational awareness
> 1. `pwd` must equal `/home/pacs-user/minipacs`. If not, stop and
>    report.
> 2. `git rev-parse --short HEAD` — record this as `PREV_SHA`. If any
>    uncommitted changes exist (`git status --porcelain`), stop and
>    report; never overwrite the operator's in-flight work.
> 3. `docker compose -f docker-compose.prod.yml ps` — record the
>    current health of every service.
> 4. `pgrep -af import_archive.py`. If the bulk archive import is
>    still running, pause it: `touch backups/.import_paused && pkill
>    -TERM -f import_archive.py`, wait for in-flight tasks to finish.
>    Do NOT `SIGKILL`. Record that you paused it.
> 5. Fetch without merging: `git fetch origin master`. If
>    `origin/master..HEAD` has any local-only commits, stop and report
>    — the operator has diverged and only they can reconcile.
>
> ### Step 1 — full backup (MUST precede any destructive action)
> 1. Run `bash scripts/backup.sh`. Confirm the generated `pg-*.dump`
>    and `orthanc-*.tar.gz` both exist and are non-empty.
> 2. Additionally capture the legacy SQLite file if it is still on
>    disk: `docker compose -f docker-compose.prod.yml exec -T backend
>    test -f /app/data/minipacs.db` → if present, `docker cp
>    minipacs-backend-1:/app/data/minipacs.db backups/minipacs-legacy-$(date
>    +%Y%m%d-%H%M).db`. This is the source of the migration — keep it.
> 3. Show the operator the backup file sizes; refuse to proceed if any
>    is under 1 KB.
>
> ### Step 2 — fetch + build (non-destructive)
> 1. `git pull --ff-only origin master`. If it is not a fast-forward,
>    stop — never rebase prod history unattended.
> 2. `docker compose -f docker-compose.prod.yml build backend
>    frontend`. If either build fails, stop and report; do NOT `up -d`
>    a broken image.
>
> ### Step 3 — rotate secrets (leaked `hdp123` forces full rotation)
> 1. Run `bash scripts/rotate-secrets.sh`. Accept the defaults; the
>    script writes new `SECRET_KEY`, `ORTHANC_PASSWORD`,
>    `POSTGRES_PASSWORD`, `INTERNAL_EVENT_TOKEN`, and recomputes
>    `ORTHANC_BASIC_AUTH`. It creates an `.env.bak-*` backup.
> 2. **Postgres password caveat:** the running volume still has the
>    old password baked into its auth. Before restarting the stack:
>    ```bash
>    NEW_PG_PWD=$(grep ^POSTGRES_PASSWORD= .env | cut -d= -f2-)
>    docker compose -f docker-compose.prod.yml exec -T postgres \
>        psql -U orthanc -d orthanc \
>        -c "ALTER USER orthanc WITH PASSWORD '$NEW_PG_PWD';"
>    ```
>    If that command errors, STOP — do not `down` the stack; the
>    operator needs to reconcile `.env` vs DB state manually.
> 3. Also change the SSH password for `pacs-user` on the Windows side.
>    The Windows host is NOT reachable from WSL, so instead emit a
>    one-line instruction for the operator:
>    ```
>    ACTION REQUIRED: change pacs-user SSH password on the Windows
>    host. Current value (hdp123) leaked via git history.
>    ```
>
> ### Step 4 — apply the PG migration (SQLite → shared PG)
> 1. Bring the backend up on the new image **without** touching
>    Orthanc yet:
>    ```
>    docker compose -f docker-compose.prod.yml up -d --no-deps backend
>    ```
>    Backend's `init_db()` creates MiniPACS tables inside the shared
>    `orthanc` PG database on first boot. This is additive; Orthanc's
>    own tables are not touched.
> 2. Wait for `/api/health`:
>    ```
>    for i in {1..60}; do
>      docker compose -f docker-compose.prod.yml exec -T backend \
>        python3 -c "import urllib.request; import sys; \
>    sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/health',timeout=2).status==200 else 1)" \
>        && break
>      sleep 2
>    done
>    ```
>    If health never returns 200, stop and dump `backend` logs.
> 3. Run the one-shot data migration:
>    ```
>    docker compose -f docker-compose.prod.yml exec -T backend \
>        python -m scripts.migrate_sqlite_to_pg
>    ```
>    It prints per-table insert counts. Record them.
> 4. Sanity checks — verify that nothing was lost:
>    - `users` count in PG ≥ `users` count in the legacy SQLite dump
>    - At least one row in `audit_log` with a recent timestamp
>    - `external_viewers` has ≥ 2 `is_enabled=1` rows (Stone + OHIF)
>
> ### Step 5 — finish the stack recreate
> 1. `docker compose -f docker-compose.prod.yml up -d redis frontend`
>    (brings up the new Redis service and the rebuilt frontend).
> 2. `docker compose -f docker-compose.prod.yml restart orthanc` —
>    required so the Python plugin picks up the new
>    `INTERNAL_EVENT_TOKEN` and re-registers its STABLE_STUDY callback.
> 3. `docker compose -f docker-compose.prod.yml ps` — every service
>    must be `running` (or `healthy` for those with healthchecks).
>
> ### Step 6 — change the admin password
> 1. Prompt the operator at the TTY:
>    ```
>    read -srp "Choose NEW admin password (min 12 chars): " NEW_ADMIN
>    echo
>    ```
>    Refuse to proceed if `${#NEW_ADMIN}` < 12.
> 2. Apply it:
>    ```
>    docker compose -f docker-compose.prod.yml exec -T backend \
>        python -m app.change_password admin "$NEW_ADMIN"
>    ```
>    This bumps `token_version`, invalidating any outstanding session.
>
> ### Step 7 — smoke test (must all pass)
>
> | Check | Command | Expect |
> |---|---|---|
> | Portal edge | `curl -fsS https://pacs.clintonmedical.net/api/health` | `{"status":"ok"}` |
> | Login with new password | `curl -sS -X POST https://pacs.clintonmedical.net/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$NEW_ADMIN\"}"` | JSON with `access_token` |
> | PWA manifest | `curl -sSI https://pacs.clintonmedical.net/manifest.webmanifest \| grep -i content-type` | `application/manifest+json` |
> | Service worker | `curl -sSI https://pacs.clintonmedical.net/sw.js \| grep -i cache-control` | `no-cache, must-revalidate` |
> | QIDO speed | run the login curl twice back-to-back, second response < 50 ms | — |
>
> If any check fails, **do not proceed**. Dump the last 80 lines of
> every service's `docker compose logs` and hand control back.
>
> ### Step 8 — resume background import (only if step 0 paused it)
> If you paused a bulk import in step 0 and every smoke check passed:
> ```
> rm -f backups/.import_paused
> nohup python3 scripts/import_archive.py >> backups/import.log 2>&1 &
> ```
> If any smoke check failed, DO NOT resume — the operator owns that
> decision.
>
> ### Step 9 — hand off to the operator
>
> Produce a single markdown summary:
>
> ```
> ## Upgrade complete — <PREV_SHA> → <NEW_SHA>
>
> ### Actions taken
> - [ ] Backup: pg-<ts>.dump (<size>), orthanc-<ts>.tar.gz (<size>), minipacs-legacy-<ts>.db (<size>)
> - [ ] Fast-forward: N commits applied
> - [ ] Secrets rotated (.env.bak-<ts> kept)
> - [ ] PG password in-place updated on the running volume
> - [ ] SQLite → PG: <N> users, <M> audit_log rows, <K> viewers migrated
> - [ ] Admin password changed (token_version bumped)
> - [ ] All services healthy
> - [ ] Smoke tests passed
> - [ ] Background import resumed / not resumed (<reason>)
>
> ### Action still required from you (human)
> 1. Change the pacs-user SSH password on the Windows host.
> 2. Install the WSL autostart + watchdog — from Windows PowerShell
>    as Administrator, run:
>       powershell -ExecutionPolicy Bypass -File ~\minipacs\scripts\windows\install-autostart.ps1
>    Reboot Windows once to exercise the Boot task.
> 3. (Optional) LAN HTTPS: generate a Cloudflare Origin Certificate,
>    drop cert.pem + key.pem into ~/minipacs/ssl/, then:
>       cp docker-compose.override.yml.example docker-compose.override.yml
>       docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
> 4. (Optional) Add UniFi DNS override for pacs.clintonmedical.net → 10.0.0.50.
>
> ### If you need to roll back
> - git reset --hard <PREV_SHA>
> - docker compose -f docker-compose.prod.yml down
> - docker volume rm minipacs_orthanc-pg    # ONLY if PG data is unusable
> - docker run --rm -v minipacs_orthanc-pg:/restore -v $PWD/backups:/b \
>     postgres:16-alpine pg_restore -U orthanc -d orthanc /b/pg-<ts>.dump
> - (or restore DICOM tar in place of orthanc-data)
> - docker compose -f docker-compose.prod.yml up -d --build
> ```
>
> ---
>
> ### Rules
> - Never run `ssh minipacs` — you ARE the minipacs host.
> - Never pass `--no-verify` to git, never `--force-push`.
> - Never delete a backup file.
> - Never continue past a failing smoke check.
> - If you encounter anything unexpected (unfamiliar file, diverged
>   history, healthcheck flapping), STOP and show the operator the
>   exact output you saw — do not self-heal by deleting or retrying.

---

## How the local-side agent (this session) got you here

Upstream work that this prompt consumes is already on `origin/master`
as of `959b826`. Nothing else needs to be pushed first.
