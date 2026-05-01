#!/bin/bash
# MiniPACS First-Time Setup
# Run once on a fresh server to generate credentials, start the stack,
# create the admin user, and schedule daily backups.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "=== MiniPACS Setup ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Docker sanity
# ---------------------------------------------------------------------------
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker not found. Install Docker Desktop / Docker Engine first."
  exit 1
fi
if ! docker info &>/dev/null; then
  echo "ERROR: Docker daemon not running."
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Generate .env (idempotent — skip if already present)
# ---------------------------------------------------------------------------
if [ -f .env ]; then
  echo ".env already exists — keeping existing credentials."
  echo "Delete .env and re-run to regenerate."
else
  echo "Generating credentials..."

  gen() { openssl rand -base64 "$1" | tr -d '/+=' | head -c "$2"; }

  SECRET_KEY=$(openssl rand -hex 48)
  ORTHANC_PASSWORD=$(gen 24 32)
  POSTGRES_PASSWORD=$(gen 24 32)
  INTERNAL_EVENT_TOKEN=$(openssl rand -hex 32)
  BACKUP_PASSPHRASE=$(openssl rand -base64 32 | tr -d '/+=\n' | head -c 40)
  ORTHANC_BASIC_AUTH=$(printf 'orthanc:%s' "$ORTHANC_PASSWORD" | base64 | tr -d '\n')

  cat <<'BAA_NOTICE'

  ┌─ HIPAA notice ──────────────────────────────────────────────────────┐
  │                                                                     │
  │  If you are deploying for a US covered entity:                      │
  │                                                                     │
  │   • Cloudflare Tunnel on the FREE plan is NOT covered by a BAA.     │
  │     Sign one before routing PHI through it (CF Enterprise, or use   │
  │     a different tunnel that offers a BAA).                          │
  │   • Enable full-disk encryption on this host (BitLocker / LUKS).    │
  │   • See docs/hipaa-notes.md for the full clinic checklist.          │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

BAA_NOTICE

  read -rp "Domain (e.g. pacs.your-clinic.example): " DOMAIN
  read -rp "Cloudflare Tunnel token: " CF_TUNNEL_TOKEN

  cat > .env <<EOF
# MiniPACS Production Config — generated $(date +%Y-%m-%d)
SECRET_KEY=$SECRET_KEY
ORTHANC_USERNAME=orthanc
ORTHANC_PASSWORD=$ORTHANC_PASSWORD
ORTHANC_BASIC_AUTH=$ORTHANC_BASIC_AUTH
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
INTERNAL_EVENT_TOKEN=$INTERNAL_EVENT_TOKEN
# AES-256 passphrase for backups. DO NOT rotate without re-encrypting
# the existing backup pairs — see scripts/restore-backup.sh.
BACKUP_PASSPHRASE=$BACKUP_PASSPHRASE
DOMAIN=$DOMAIN
CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN
AUTO_LOGOUT_MINUTES=15
DEFAULT_SHARE_EXPIRY_DAYS=30
EOF
  chmod 600 .env

  echo ""
  echo "Credentials saved to .env (chmod 600)."
  echo "  Orthanc password:   $ORTHANC_PASSWORD"
  echo "  Postgres password:  $POSTGRES_PASSWORD"
  echo ""
fi

# ---------------------------------------------------------------------------
# 3. Build + start stack
# ---------------------------------------------------------------------------
COMPOSE="docker compose -f docker-compose.prod.yml"

echo "Building Docker images..."
$COMPOSE build

echo ""
echo "Starting services..."
$COMPOSE up -d

# ---------------------------------------------------------------------------
# 4. Wait for backend /api/health to come up
# ---------------------------------------------------------------------------
echo "Waiting for backend to become healthy..."
ready=false
for i in $(seq 1 60); do
  if $COMPOSE exec -T backend \
      python3 -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/health', timeout=2).status==200 else 1)" \
      &>/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
if [ "$ready" != "true" ]; then
  echo "ERROR: backend did not become ready in 120s."
  echo "Last 20 log lines:"
  $COMPOSE logs --tail=20 backend
  exit 1
fi
echo "  Backend is healthy."

# ---------------------------------------------------------------------------
# 5. Create admin user (idempotent — skips if already exists)
# ---------------------------------------------------------------------------
echo ""
read -rp "Admin username [admin]: " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}
read -srp "Admin password: " ADMIN_PASS
echo ""
if [ -z "$ADMIN_PASS" ]; then
  echo "ERROR: Password cannot be empty"
  exit 1
fi

# `app.create_user` writes directly to the shared PG backend — no shell
# quoting of bcrypt output, no inline heredoc. Exit codes:
#   0 = created, 1 = already exists, other = real error.
if $COMPOSE exec -T backend python -m app.create_user "$ADMIN_USER" "$ADMIN_PASS"; then
  echo "  Admin user '$ADMIN_USER' created."
else
  rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "  Admin user '$ADMIN_USER' already exists — leaving untouched."
  else
    echo "ERROR: create_user failed with exit code $rc."
    exit $rc
  fi
fi

# ---------------------------------------------------------------------------
# 6. Install daily backup cron
# ---------------------------------------------------------------------------
echo ""
echo "Installing daily backup cron..."
BACKUP_DIR="$PROJECT_DIR/backups"
mkdir -p "$BACKUP_DIR"

CRON_LINE="0 2 * * * $PROJECT_DIR/scripts/backup.sh >> $PROJECT_DIR/backups/backup.log 2>&1"
(crontab -l 2>/dev/null | grep -v "$PROJECT_DIR/scripts/backup.sh" || true; echo "$CRON_LINE") | crontab -

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
# shellcheck disable=SC1091
set -a; source .env; set +a

echo ""
echo "=== MiniPACS is running ==="
echo ""
$COMPOSE ps
echo ""
echo "Portal:  https://$DOMAIN"
echo "DICOM:   AET=MINIPACS, port 48924"
echo "Backups: daily at 02:00 → $BACKUP_DIR/"
echo ""
echo "Next steps (optional):"
echo "  - Real LAN HTTPS cert:     docs/split-horizon-https.md"
echo "  - Secret rotation:         scripts/rotate-secrets.sh"
echo "  - Windows autostart:       docs/wsl-autostart.md"
echo ""
echo "Manage:"
echo "  $COMPOSE logs -f"
echo "  $COMPOSE down"
echo "  $COMPOSE up -d"
