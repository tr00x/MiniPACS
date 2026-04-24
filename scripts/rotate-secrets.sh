#!/bin/bash
# Rotate all MiniPACS secrets in one pass.
#
# Generates fresh cryptographically-random values for SECRET_KEY,
# ORTHANC_PASSWORD, POSTGRES_PASSWORD, INTERNAL_EVENT_TOKEN, recomputes the
# derived ORTHANC_BASIC_AUTH, writes the updated .env in place with a
# timestamped backup, then restarts the affected containers so the new
# values take effect.
#
# Run on the machine that owns the .env (prod: ~/minipacs; local dev: repo root).
# All mutations are logged so you can undo with `mv .env.bak-<ts> .env` if
# something goes wrong.
set -euo pipefail

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $(pwd)" >&2
  echo "Run this script from the directory that contains your .env file." >&2
  exit 1
fi

if ! command -v openssl >/dev/null; then
  echo "ERROR: openssl required" >&2; exit 1
fi

TS=$(date +%Y%m%d-%H%M%S)
BACKUP=".env.bak-$TS"
cp .env "$BACKUP"
echo "backup: $BACKUP"

# Cryptographically strong values. SECRET_KEY deliberately longer than the
# bare minimum — HMAC-SHA256 uses the full key length, no benefit to
# trimming, small cost to going big.
SECRET_KEY=$(openssl rand -hex 48)
ORTHANC_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
INTERNAL_EVENT_TOKEN=$(openssl rand -hex 32)

ORTHANC_USERNAME=$(grep -E '^ORTHANC_USERNAME=' .env | cut -d= -f2- || echo orthanc)
ORTHANC_USERNAME=${ORTHANC_USERNAME:-orthanc}
ORTHANC_BASIC_AUTH=$(printf '%s:%s' "$ORTHANC_USERNAME" "$ORTHANC_PASSWORD" | base64 | tr -d '\n')

set_var() {
    local key="$1" value="$2"
    # In-place: replace existing line or append if missing. Use awk so we
    # don't fight sed escaping on values that contain `/`.
    if grep -qE "^${key}=" .env; then
        awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > .env.tmp
        mv .env.tmp .env
    else
        printf '%s=%s\n' "$key" "$value" >> .env
    fi
    echo "  rotated: $key"
}

set_var SECRET_KEY "$SECRET_KEY"
set_var ORTHANC_PASSWORD "$ORTHANC_PASSWORD"
set_var POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
set_var INTERNAL_EVENT_TOKEN "$INTERNAL_EVENT_TOKEN"
set_var ORTHANC_BASIC_AUTH "$ORTHANC_BASIC_AUTH"

echo
echo "New values written to .env. Backup at $BACKUP."
echo
cat <<'MSG'
NEXT STEPS — choose based on environment:

  Production (docker-compose.prod.yml):
    docker compose -f docker-compose.prod.yml down
    docker compose -f docker-compose.prod.yml up -d

  Dev (docker-compose.yml):
    docker compose down
    docker compose up -d

NOTES:
  * Rotating SECRET_KEY invalidates all existing JWTs — every user has
    to log in again. This is usually what you want after a rotation.
  * POSTGRES_PASSWORD change requires a `down` → `up`: Postgres caches
    the password it was initialised with inside the volume. If the
    password on the running instance has drifted from .env, Orthanc and
    backend will fail to connect on the next restart.
    To change the password of an already-initialised PG volume:
      docker compose exec postgres psql -U orthanc -d orthanc \
          -c "ALTER USER orthanc WITH PASSWORD '<new_password>';"
    THEN update .env to the same value. Otherwise restore from backup.
  * ORTHANC_PASSWORD change flushes Orthanc HTTP auth. Re-login in UI.
  * INTERNAL_EVENT_TOKEN — no user impact. Backend + Orthanc plugin must
    both restart to pick up the new value; a `restart backend orthanc`
    is enough, full `down` not required.
MSG
