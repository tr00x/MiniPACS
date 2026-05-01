#!/bin/bash
# Decrypt and restore a MiniPACS encrypted backup pair.
#
# Usage: scripts/restore-backup.sh <YYYYMMDD_HHMM>
# e.g.   scripts/restore-backup.sh 20260501_0200
#
# Reads BACKUP_PASSPHRASE from .env (same source as backup.sh).
#
# WARNING: pg_restore overwrites the live `orthanc` database. DICOM files
# are extracted into the orthanc-data volume, REPLACING existing content.
# Verify the target environment before typing YES.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
COMPOSE="docker compose -f $PROJECT_DIR/docker-compose.prod.yml"

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <YYYYMMDD_HHMM>"
  echo
  echo "Available backups:"
  ls "$BACKUP_DIR" 2>/dev/null | grep -E "\.enc$" | sed 's/^pg-//;s/^orthanc-//;s/\.dump\.enc$//;s/\.tar\.gz\.enc$//' | sort -u || true
  exit 1
fi

DATE="$1"
PG_FILE="$BACKUP_DIR/pg-$DATE.dump.enc"
DICOM_FILE="$BACKUP_DIR/orthanc-$DATE.tar.gz.enc"

[ -f "$PG_FILE" ] || { echo "ERROR: $PG_FILE not found" >&2; exit 1; }
[ -f "$DICOM_FILE" ] || { echo "ERROR: $DICOM_FILE not found" >&2; exit 1; }

if [ -f "$PROJECT_DIR/.env" ]; then
  BACKUP_PASSPHRASE=$(grep -E '^BACKUP_PASSPHRASE=' "$PROJECT_DIR/.env" | cut -d= -f2- || true)
fi
export BACKUP_PASSPHRASE
[ -n "${BACKUP_PASSPHRASE:-}" ] || { echo "ERROR: BACKUP_PASSPHRASE missing from .env" >&2; exit 1; }

echo "=== Restoring backup $DATE ==="
echo "  pg dump: $PG_FILE"
echo "  dicom:   $DICOM_FILE"
echo
echo "This will OVERWRITE the live orthanc database AND the DICOM volume."
read -rp "Type YES to proceed: " CONFIRM
[ "$CONFIRM" = "YES" ] || { echo "Aborted."; exit 1; }

echo "Stopping orthanc + backend..."
$COMPOSE stop orthanc backend

echo "Decrypting + restoring PostgreSQL..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass env:BACKUP_PASSPHRASE \
    -in "$PG_FILE" \
  | $COMPOSE exec -T postgres pg_restore -U orthanc -d orthanc --clean --if-exists

echo "Decrypting + restoring DICOM storage..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass env:BACKUP_PASSPHRASE \
    -in "$DICOM_FILE" \
  | docker run --rm -i \
      -v minipacs_orthanc-data:/data \
      alpine sh -c "rm -rf /data/* && tar xzf - -C /data"

echo "Starting orthanc + backend..."
$COMPOSE start orthanc backend

echo
echo "=== Restore complete ==="
echo "Smoke test: curl https://your-domain/api/health"
