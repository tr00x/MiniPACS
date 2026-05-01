#!/bin/bash
# MiniPACS Daily Backup
#
# Backups are AES-256-CBC encrypted (openssl + PBKDF2, 100k iterations) using
# BACKUP_PASSPHRASE from .env. Encrypts both the pg_dump and the DICOM tar.gz.
# HIPAA §164.312(a)(2)(iv) — encryption of PHI at rest.
#
# Restore: scripts/restore-backup.sh <YYYYMMDD_HHMM>
#
# Run via cron: 0 2 * * * /path/to/backup.sh >> /path/to/backups/backup.log 2>&1
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
DATE=$(date +%Y%m%d_%H%M)
KEEP_DAYS=30
COMPOSE="docker compose -f $PROJECT_DIR/docker-compose.prod.yml"

# BACKUP_PASSPHRASE intentionally read from .env only — keep host environment
# minimal so cron + interactive shells share the same source of truth.
if [ -f "$PROJECT_DIR/.env" ]; then
  BACKUP_PASSPHRASE=$(grep -E '^BACKUP_PASSPHRASE=' "$PROJECT_DIR/.env" | cut -d= -f2- || true)
fi
export BACKUP_PASSPHRASE

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "ERROR: BACKUP_PASSPHRASE missing from .env. Refusing to write plaintext PHI backups." >&2
  echo "       Run scripts/setup.sh on a fresh install, or generate a passphrase manually:" >&2
  echo "         openssl rand -base64 32 | tr -d '/+=' | head -c 40" >&2
  echo "       and append BACKUP_PASSPHRASE=<value> to .env (chmod 600)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "=== MiniPACS Backup $DATE ==="

# 1. PostgreSQL dump (Orthanc index + MiniPACS tables) → encrypted .dump.enc
echo "Backing up PostgreSQL (Orthanc + MiniPACS) — encrypted..."
$COMPOSE exec -T postgres pg_dump -U orthanc -Fc orthanc \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass env:BACKUP_PASSPHRASE \
  > "$BACKUP_DIR/pg-$DATE.dump.enc"
echo "  Saved: $BACKUP_DIR/pg-$DATE.dump.enc"

# 2. Orthanc DICOM files → encrypted .tar.gz.enc
echo "Backing up Orthanc DICOM storage — encrypted..."
docker run --rm \
  -v minipacs_orthanc-data:/data:ro \
  alpine tar czf - -C /data . \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -pass env:BACKUP_PASSPHRASE \
  > "$BACKUP_DIR/orthanc-$DATE.tar.gz.enc"
echo "  Saved: $BACKUP_DIR/orthanc-$DATE.tar.gz.enc"

# 3. Cleanup old encrypted + legacy plaintext backups
echo "Cleaning backups older than $KEEP_DAYS days..."
find "$BACKUP_DIR" -name "pg-*.dump*" -mtime +$KEEP_DAYS -delete
find "$BACKUP_DIR" -name "orthanc-*.tar.gz*" -mtime +$KEEP_DAYS -delete
find "$BACKUP_DIR" -name "minipacs-*.db" -mtime +$KEEP_DAYS -delete  # legacy SQLite

# 4. Summary
PG_SIZE=$(du -sh "$BACKUP_DIR/pg-$DATE.dump.enc" | cut -f1)
ORTHANC_SIZE=$(du -sh "$BACKUP_DIR/orthanc-$DATE.tar.gz.enc" | cut -f1)
TOTAL=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "Done: PG=$PG_SIZE, DICOM=$ORTHANC_SIZE, Total backups=$TOTAL"
echo "Restore: scripts/restore-backup.sh $DATE"
