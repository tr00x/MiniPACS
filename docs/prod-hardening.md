# Production hardening checklist

Everything in this doc is manual — security operations deliberately stay
out of automated deploy pipelines. Each section is independent; pick
what applies.

## 1. Rotate all shared secrets (fully automated)

One script handles `SECRET_KEY`, `ORTHANC_PASSWORD`, `POSTGRES_PASSWORD`,
`INTERNAL_EVENT_TOKEN`, and the derived `ORTHANC_BASIC_AUTH`:

```bash
cd ~/minipacs
bash scripts/rotate-secrets.sh
# read the NEXT STEPS block, follow based on environment
```

**POSTGRES_PASSWORD caveat**: the current Postgres volume already has
the old password baked into its authentication state. Two options:

- **Easy (destructive)**: `docker compose -f docker-compose.prod.yml down`,
  `docker volume rm minipacs_orthanc-pg`, `up -d` — Orthanc will recreate
  the index from the DICOM files on disk (minutes, automatic), but ALL
  backend tables (users, shares, audit_log…) are wiped. Only OK on a
  fresh install.
- **Safe (preferred)**: keep the volume, change the password in-place:
  ```bash
  # BEFORE running rotate-secrets.sh:
  docker compose -f docker-compose.prod.yml exec postgres \
      psql -U orthanc -d orthanc \
      -c "ALTER USER orthanc WITH PASSWORD 'NEW_PASSWORD_HERE';"
  # THEN edit .env by hand / rerun rotate-secrets.sh for everything else.
  ```

## 2. Change the `admin` password

Default is `admin123` / seeded by the initial `create_user` run. Do NOT
go to production with that value.

```bash
docker compose -f docker-compose.prod.yml exec backend \
    python -m app.change_password admin 'STRONG_PASSWORD_HERE'
```

Bumps `token_version`, so every session for `admin` is invalidated on
the next request — the user sees a forced re-login. No other users are
affected.

## 3. Real TLS certificate (vs the self-signed fallback)

See `docs/split-horizon-https.md`. TL;DR: generate a Cloudflare Origin
Certificate, drop `cert.pem` + `key.pem` into `~/minipacs/ssl/`,
`docker compose -f docker-compose.prod.yml up -d --force-recreate frontend`.

## 4. Close dev-only ports at the host firewall

Dev-only ports that must never be LAN-visible in production:

| Port | What | Exposed by |
|---|---|---|
| 48922 | Backend direct (`http://…:48922/api/*`) | docker-compose.yml only — NOT docker-compose.prod.yml. |
| 48923 | Orthanc admin HTTP | Same — dev-only. |

`docker-compose.prod.yml` does NOT publish these, so a prod deploy is
already clean. Double-check with:

```bash
docker compose -f docker-compose.prod.yml ps --format "table {{.Service}}\t{{.Ports}}"
# expected: only 127.0.0.1:8080, 443, 48924
```

If a prior dev run accidentally left containers up with the dev
compose file, bring everything down once:

```bash
docker compose down
docker compose -f docker-compose.prod.yml up -d
```

Belt-and-braces: add a Windows Defender Firewall block for 48922/48923
inbound (`New-NetFirewallRule -DisplayName "Block MiniPACS dev ports"
-Direction Inbound -LocalPort 48922,48923 -Protocol TCP -Action Block`).

## 5. Backups

`scripts/backup.sh` updated to use `pg_dump` on the shared `orthanc`
database (covers both Orthanc index and MiniPACS backend tables after
the PG migration). Cron entry:

```cron
0 2 * * * /home/pacs-user/minipacs/scripts/backup.sh \
    >> /home/pacs-user/minipacs/backups/backup.log 2>&1
```

Off-site target for HIPAA 3-2-1 compliance still pending — see
`project_phase2_deployment.md` in memory.

## 6. Post-hardening smoke

```bash
# Public edge
curl -fsS https://pacs.your-clinic.example/api/health
# Internal endpoints must NOT answer from outside the LAN
curl -fs --max-time 3 http://<public_ip>:48922/api/health && echo FAIL || echo ok
curl -fs --max-time 3 http://<public_ip>:48923/            && echo FAIL || echo ok
# Admin login with new password
curl -sS -X POST https://pacs.your-clinic.example/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"NEW_PASSWORD_HERE"}' | jq .access_token
```
