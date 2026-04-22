#!/usr/bin/env bash
# Wipe MiniPACS data (Orthanc DICOM, user DB, nginx cache, import state),
# then restart the stack clean. Preserves SQLite DB snapshots in backups/*.db.
#
# Idempotent: re-running after a partial wipe finishes the remaining work.
#
# Destroys:
#   docker volume: minipacs_orthanc-data    (all DICOM instances)
#   docker volume: minipacs_orthanc-pg      (PostgreSQL index — Orthanc catalog)
#   docker volume: minipacs_minipacs-db     (users, patient map, shares)
#   docker volume: minipacs_nginx-cache     (DICOMweb disk cache)
#   file: backups/import_state.json         (archive importer resume state)
#   file: backups/import_failed.log
#
# Keeps:
#   backups/minipacs-*.db                    (historical DB snapshots)
#   All config, scripts, Orthanc Lua hooks

set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"

# ---- size helpers ---------------------------------------------------------

vol_size_mb() {
  # print size in MB of volume contents via a throwaway container
  local vol="$1"
  docker run --rm -v "$vol:/d" --entrypoint sh alpine:3 -c 'du -sm /d 2>/dev/null | awk "{print \$1}"' 2>/dev/null || echo 0
}

wipe_volume_with_progress() {
  local vol="$1"

  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    printf "  skip %-28s (not present)\n" "$vol"
    return
  fi

  local orig_mb
  orig_mb=$(vol_size_mb "$vol")
  orig_mb=${orig_mb:-0}
  if [[ "$orig_mb" -eq 0 ]]; then
    printf "  %-28s empty, removing metadata\n" "$vol"
    docker volume rm "$vol" >/dev/null
    return
  fi

  printf "  %-28s deleting %d MB...\n" "$vol" "$orig_mb"

  # Launch rm in a detached container so we can poll size from outside.
  # find -delete handles hidden files and is reliable.
  local wipe_cid
  wipe_cid=$(docker run -d --rm -v "$vol:/d" --entrypoint sh alpine:3 \
             -c 'find /d -mindepth 1 -delete')

  # Poll size every 4s while the wipe container runs.
  while docker ps --format '{{.ID}}' | grep -q "^${wipe_cid:0:12}"; do
    local cur_mb
    cur_mb=$(vol_size_mb "$vol")
    cur_mb=${cur_mb:-0}
    local deleted=$((orig_mb - cur_mb))
    local pct=0
    (( orig_mb > 0 )) && pct=$(( 100 * deleted / orig_mb ))
    (( pct > 100 )) && pct=100
    (( pct < 0 )) && pct=0
    printf "\r  %-28s %6d / %6d MB deleted (%3d%%)    " "$vol" "$deleted" "$orig_mb" "$pct"
    sleep 4
  done
  printf "\r  %-28s %6d / %6d MB deleted (100%%)    \n" "$vol" "$orig_mb" "$orig_mb"

  docker volume rm "$vol" >/dev/null
}

# ---- main -----------------------------------------------------------------

echo "This will DELETE all DICOM data and user records in MiniPACS."
echo "Historical backups/minipacs-*.db snapshots will be kept."
read -rp "Type 'WIPE' to continue: " ack
if [[ "$ack" != "WIPE" ]]; then
  echo "aborted."
  exit 1
fi

echo "[1/4] stopping stack..."
$COMPOSE down

echo "[2/4] removing data volumes..."
for v in minipacs_orthanc-data minipacs_orthanc-pg minipacs_minipacs-db minipacs_nginx-cache; do
  wipe_volume_with_progress "$v"
done

echo "[3/4] clearing import state..."
rm -fv backups/import_state.json backups/import_failed.log 2>/dev/null || true

echo "[4/4] starting stack..."
$COMPOSE up -d
echo "waiting for orthanc healthy..."
for i in {1..60}; do
  status=$($COMPOSE ps --format '{{.Name}} {{.Health}}' | awk '/orthanc/ {print $2}')
  if [[ "$status" == "healthy" ]]; then
    echo "orthanc healthy after ${i}s"
    break
  fi
  sleep 1
done

$COMPOSE ps
echo
echo "Ready. Next: python3 scripts/import_archive.py"
