#!/bin/bash
# MiniPACS Daily Backup
# Backs up SQLite DB and Orthanc DICOM data
# Run via cron: 0 2 * * * /path/to/backup.sh >> /path/to/backups/backup.log 2>&1
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
DATE=$(date +%Y%m%d_%H%M)
KEEP_DAYS=30

mkdir -p "$BACKUP_DIR"

echo "=== MiniPACS Backup $DATE ==="

# 1. SQLite database
echo "Backing up SQLite..."
docker compose -f "$PROJECT_DIR/docker-compose.prod.yml" exec -T backend \
  python3 -c "
import sqlite3, shutil
src = '/app/data/minipacs.db'
dst = '/app/data/backup.db'
conn = sqlite3.connect(src)
bck = sqlite3.connect(dst)
conn.backup(bck)
bck.close()
conn.close()
print('SQLite backup created')
"
docker cp minipacs-backend-1:/app/data/backup.db "$BACKUP_DIR/minipacs-$DATE.db"
docker compose -f "$PROJECT_DIR/docker-compose.prod.yml" exec -T backend rm -f /app/data/backup.db
echo "  Saved: $BACKUP_DIR/minipacs-$DATE.db"

# 2. Orthanc DICOM data
echo "Backing up Orthanc data..."
docker run --rm \
  -v minipacs_orthanc-data:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/orthanc-$DATE.tar.gz" -C /data .
echo "  Saved: $BACKUP_DIR/orthanc-$DATE.tar.gz"

# 3. Cleanup old backups
echo "Cleaning backups older than $KEEP_DAYS days..."
find "$BACKUP_DIR" -name "minipacs-*.db" -mtime +$KEEP_DAYS -delete
find "$BACKUP_DIR" -name "orthanc-*.tar.gz" -mtime +$KEEP_DAYS -delete

# 4. Summary
DB_SIZE=$(du -sh "$BACKUP_DIR/minipacs-$DATE.db" | cut -f1)
ORTHANC_SIZE=$(du -sh "$BACKUP_DIR/orthanc-$DATE.tar.gz" | cut -f1)
TOTAL=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "Done: DB=$DB_SIZE, DICOM=$ORTHANC_SIZE, Total backups=$TOTAL"
