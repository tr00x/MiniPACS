#!/bin/bash
# MiniPACS Daily Backup
#
# After the SQLite → PostgreSQL migration (commit 051b8d5), the backend's
# users/shares/audit_log/etc. live in the same `orthanc` PG database that
# Orthanc uses for its index. A single `pg_dump` now captures both —
# we no longer need a separate SQLite step.
#
# Run via cron: 0 2 * * * /path/to/backup.sh >> /path/to/backups/backup.log 2>&1
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
DATE=$(date +%Y%m%d_%H%M)
KEEP_DAYS=30
COMPOSE="docker compose -f $PROJECT_DIR/docker-compose.prod.yml"

mkdir -p "$BACKUP_DIR"

echo "=== MiniPACS Backup $DATE ==="

# 1. PostgreSQL dump — holds BOTH the Orthanc index AND the MiniPACS backend
#    tables (users, patient_shares, pacs_nodes, transfer_log, audit_log,
#    external_viewers, settings, study_reports). One file restores the
#    whole relational layer. Custom format (-Fc) for selective pg_restore.
echo "Backing up PostgreSQL (Orthanc + MiniPACS)..."
$COMPOSE exec -T postgres pg_dump -U orthanc -Fc orthanc \
    > "$BACKUP_DIR/pg-$DATE.dump"
echo "  Saved: $BACKUP_DIR/pg-$DATE.dump"

# 2. Orthanc DICOM files — the actual pixel data on disk. Incremental would
#    be lovely someday; for now a full tar works for the current archive
#    size. Read-only mount prevents any accidental write during the tar.
echo "Backing up Orthanc DICOM storage..."
docker run --rm \
  -v minipacs_orthanc-data:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/orthanc-$DATE.tar.gz" -C /data .
echo "  Saved: $BACKUP_DIR/orthanc-$DATE.tar.gz"

# 3. Cleanup old backups
echo "Cleaning backups older than $KEEP_DAYS days..."
find "$BACKUP_DIR" -name "pg-*.dump" -mtime +$KEEP_DAYS -delete
find "$BACKUP_DIR" -name "orthanc-pg-*.dump" -mtime +$KEEP_DAYS -delete  # legacy name
find "$BACKUP_DIR" -name "minipacs-*.db" -mtime +$KEEP_DAYS -delete      # legacy SQLite backups
find "$BACKUP_DIR" -name "orthanc-*.tar.gz" -mtime +$KEEP_DAYS -delete

# 4. Summary
PG_SIZE=$(du -sh "$BACKUP_DIR/pg-$DATE.dump" | cut -f1)
ORTHANC_SIZE=$(du -sh "$BACKUP_DIR/orthanc-$DATE.tar.gz" | cut -f1)
TOTAL=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "Done: PG=$PG_SIZE, DICOM=$ORTHANC_SIZE, Total backups=$TOTAL"
