# Split-horizon DNS + HTTPS on LAN

By default MiniPACS traffic goes:

```
browser → CF edge (TLS) → CF Tunnel → 127.0.0.1:8080 (HTTP) → nginx → backend
```

That's fine for WAN users, but a radiologist sitting in the clinic pays
~50–100ms per request to leave the building and come back. Split-horizon
DNS pins `pacs.clintonmedical.net` at the clinic's own server (10.0.0.50)
for anyone on the LAN, so their traffic never leaves the switch:

```
LAN browser → UniFi DNS (override) → 10.0.0.50:443 (HTTPS, HTTP/2) → nginx → backend
```

RTT drops to ~1 ms and the HTTP/2 multiplex is visible on Stone bursts.

## What's already in the repo

| File | What it does |
|---|---|
| `nginx/nginx-prod.conf` | `server { listen 80; listen 443 ssl http2; … }` — one block handles both entry points. |
| `docker-compose.prod.yml` | Maps `443:443` on the host, mounts `./ssl` → `/etc/ssl/minipacs` for the real cert. |
| `scripts/windows/update-portproxy.ps1` | Scheduled task target — rewrites `netsh portproxy` 22/443/48924 → current WSL IP at Windows boot. |
| `frontend/Dockerfile` | Bakes a self-signed fallback pair so the 443 listener always comes up. |

## What you do once in the clinic

### 1. Generate a Cloudflare Origin Certificate

In the CF dashboard for `clintonmedical.net`:
`SSL/TLS → Origin Server → Create Certificate`. Defaults (RSA 2048, 15-year
TTL) are fine. Save the two blocks into:

```
/home/pacs-user/minipacs/ssl/cert.pem
/home/pacs-user/minipacs/ssl/key.pem
```

(The `./ssl` directory is git-ignored, cert never enters the repo.)

Set the CF SSL mode to **Full (strict)** so CF validates the cert on the
tunnel side too.

### 2. Restart the frontend container

```bash
cd ~/minipacs
docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
```

Nginx now listens on 443 with the real cert.

### 3. Drop the PS1 onto the Windows host

Copy `scripts/windows/update-portproxy.ps1` from the repo to:

```
C:\ProgramData\MiniPACS\update-portproxy.ps1
```

If the existing `MiniPACS_PortProxy` Scheduled Task already points at this
path, you're done — at the next Windows boot (or manual run) it will
publish port 443 alongside the 22/48924 rules. To refresh without a reboot:

```powershell
powershell -ExecutionPolicy Bypass -File C:\ProgramData\MiniPACS\update-portproxy.ps1
```

### 4. Add the UniFi DNS override

UniFi Network → Settings → Networks → (your LAN) → Advanced → DNS:

| Host | Type | Value |
|---|---|---|
| `pacs.clintonmedical.net` | A | `10.0.0.50` |

Flush the browser DNS cache on a client (`chrome://net-internals/#dns` →
Clear host cache) and `nslookup pacs.clintonmedical.net` from the LAN
should now resolve to `10.0.0.50`.

### 5. Verify

```bash
# From a LAN Mac:
curl -vk https://pacs.clintonmedical.net/api/health
# → HTTP/2 200, cert CN = pacs.clintonmedical.net, chain = Cloudflare Origin CA
```

HTTP/2 shows up as `* Using HTTP/2` in the curl trace. Cert name matches
the domain (not "minipacs.local") → you're on the CF Origin Cert, not the
self-signed fallback.

## Rollback

If the real cert is absent the self-signed pair still serves — browsers
show a cert warning but everything works. To go back to "CF-only" entirely:
unmount `./ssl` from `docker-compose.prod.yml`, recreate the frontend
container, and remove the UniFi DNS override (so LAN clients hit CF again).
