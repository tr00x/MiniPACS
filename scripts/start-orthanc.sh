#!/bin/bash
# Start Orthanc PACS server via Docker with full configuration
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/backend/.env"

# Load .env
if [ -f "$ENV_FILE" ]; then
  set -a; source "$ENV_FILE"; set +a
else
  echo "ERROR: $ENV_FILE not found"; exit 1
fi

ORTHANC_USERNAME="${ORTHANC_USERNAME:-orthanc}"
ORTHANC_PASSWORD="${ORTHANC_PASSWORD:?Set ORTHANC_PASSWORD in .env}"

# Create data directory for persistence
mkdir -p "$PROJECT_DIR/orthanc-data"

# Stop existing container
docker stop minipacs-orthanc 2>/dev/null || true
docker rm minipacs-orthanc 2>/dev/null || true

echo "Starting Orthanc PACS..."
docker run -d \
  --name minipacs-orthanc \
  --restart unless-stopped \
  -p 48923:8042 \
  -p 48924:4242 \
  -v "$PROJECT_DIR/orthanc-data:/var/lib/orthanc/db" \
  -e ORTHANC__NAME="MiniPACS" \
  -e ORTHANC__DICOM_AET="MINIPACS" \
  -e ORTHANC__DICOM_PORT=4242 \
  -e ORTHANC__REGISTERED_USERS="{\"$ORTHANC_USERNAME\":\"$ORTHANC_PASSWORD\"}" \
  -e ORTHANC__STORAGE_COMPRESSION=true \
  -e ORTHANC__DICOM_SCU_TIMEOUT=30 \
  -e ORTHANC__STABLE_AGE=60 \
  -e ORTHANC__MAXIMUM_STORAGE_SIZE=0 \
  -e ORTHANC__MAXIMUM_PATIENT_COUNT=0 \
  -e ORTHANC__DICOM_MODALITIES_IN_DATABASE=true \
  -e ORTHANC__OVERWRITE_INSTANCES=false \
  -e ORTHANC__HTTP_TIMEOUT=60 \
  -e ORTHANC__LIMIT_FIND_RESULTS=0 \
  -e ORTHANC__LIMIT_FIND_INSTANCES=0 \
  -e ORTHANC__KEEP_ALIVE=true \
  -e DICOM_WEB_PLUGIN_ENABLED=true \
  -e ORTHANC__DICOM_WEB__ENABLE=true \
  -e ORTHANC__DICOM_WEB__ROOT="/dicom-web/" \
  -e ORTHANC__DICOM_WEB__ENABLE_WADO=true \
  -e ORTHANC__DICOM_WEB__WADO_ROOT="/wado" \
  -e ORTHANC__DICOM_WEB__STUDIES_METADATA="MainDicomTags" \
  -e ORTHANC__DICOM_WEB__SERIES_METADATA="Full" \
  orthancteam/orthanc

echo ""
echo "Orthanc PACS running:"
echo "  DICOM AET:  MINIPACS"
echo "  DICOM Port: 48924 (C-STORE / C-ECHO)"
echo "  HTTP API:   http://localhost:48923"
echo "  DICOMweb:   http://localhost:48923/dicom-web/"
echo "  Storage:    $PROJECT_DIR/orthanc-data/ (persistent)"
echo ""
echo "Data persists across restarts."
