#!/bin/bash
# MiniPACS First-Time Setup
# Run once on a fresh server to generate credentials and start the stack
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "=== MiniPACS Setup ==="
echo ""

# Check Docker
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker not found. Install Docker Desktop first."
  exit 1
fi

if ! docker info &>/dev/null 2>&1; then
  echo "ERROR: Docker daemon not running. Start Docker Desktop."
  exit 1
fi

# Generate .env if not exists
if [ -f .env ]; then
  echo ".env already exists — skipping generation."
  echo "Delete .env and re-run to regenerate."
else
  echo "Generating credentials..."

  SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))" 2>/dev/null || openssl rand -base64 32)
  ORTHANC_PASSWORD=$(python3 -c "import secrets; print(secrets.token_urlsafe(16))" 2>/dev/null || openssl rand -base64 16)
  ORTHANC_BASIC_AUTH=$(printf 'orthanc:%s' "$ORTHANC_PASSWORD" | base64)

  read -p "Domain (e.g. pacs.clintonmedical.com): " DOMAIN
  read -p "Cloudflare Tunnel token: " CF_TUNNEL_TOKEN

  cat > .env <<EOF
# MiniPACS Production Config — generated $(date +%Y-%m-%d)
SECRET_KEY=$SECRET_KEY
ORTHANC_USERNAME=orthanc
ORTHANC_PASSWORD=$ORTHANC_PASSWORD
ORTHANC_BASIC_AUTH=$ORTHANC_BASIC_AUTH
DOMAIN=$DOMAIN
CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN
AUTO_LOGOUT_MINUTES=15
DEFAULT_SHARE_EXPIRY_DAYS=30
EOF

  chmod 600 .env
  echo ""
  echo "Credentials saved to .env (chmod 600)"
  echo "  Orthanc password: $ORTHANC_PASSWORD"
  echo ""
fi

# Source .env
set -a; source .env; set +a

# Build and start
echo "Building Docker images..."
docker compose -f docker-compose.prod.yml build

echo ""
echo "Starting services..."
docker compose -f docker-compose.prod.yml up -d

# Wait for backend
echo "Waiting for backend..."
for i in $(seq 1 30); do
  if docker compose -f docker-compose.prod.yml exec -T backend python3 -c "
import aiosqlite, asyncio
async def check():
    db = await aiosqlite.connect('/app/data/minipacs.db')
    r = await db.execute('SELECT count(*) FROM users')
    print((await r.fetchone())[0])
    await db.close()
asyncio.run(check())
" 2>/dev/null | grep -q "^[0-9]"; then
    break
  fi
  sleep 2
done

# Create admin user
echo ""
read -p "Admin username [admin]: " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}
read -sp "Admin password: " ADMIN_PASS
echo ""

if [ -z "$ADMIN_PASS" ]; then
  echo "ERROR: Password cannot be empty"
  exit 1
fi

docker compose -f docker-compose.prod.yml exec -T backend python3 -c "
import asyncio, bcrypt, aiosqlite
async def create():
    db = await aiosqlite.connect('/app/data/minipacs.db')
    h = bcrypt.hashpw(b'''$ADMIN_PASS''', bcrypt.gensalt()).decode()
    try:
        await db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)', ('$ADMIN_USER', h))
        await db.commit()
        print('User $ADMIN_USER created')
    except Exception as e:
        print(f'User may already exist: {e}')
    await db.close()
asyncio.run(create())
"

# Install backup cron
echo ""
echo "Installing daily backup cron..."
BACKUP_DIR="$PROJECT_DIR/backups"
mkdir -p "$BACKUP_DIR"

CRON_LINE="0 2 * * * $PROJECT_DIR/scripts/backup.sh >> $PROJECT_DIR/backups/backup.log 2>&1"
(crontab -l 2>/dev/null | grep -v "backup.sh"; echo "$CRON_LINE") | crontab -

echo ""
echo "=== MiniPACS is running ==="
echo ""
docker compose -f docker-compose.prod.yml ps
echo ""
echo "Portal:  https://$DOMAIN"
echo "DICOM:   AET=MINIPACS, port 48924"
echo "Backups: daily at 2am → $BACKUP_DIR/"
echo ""
echo "Manage:"
echo "  docker compose -f docker-compose.prod.yml logs -f"
echo "  docker compose -f docker-compose.prod.yml down"
echo "  docker compose -f docker-compose.prod.yml up -d"
