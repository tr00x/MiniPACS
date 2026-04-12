#!/bin/bash
# Start all MiniPACS services
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== MiniPACS Portal ==="
echo "Project: $PROJECT_DIR"
echo ""

# Load environment variables from backend/.env
ENV_FILE="$PROJECT_DIR/backend/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
  echo "Loaded env from $ENV_FILE"
else
  echo "WARNING: $ENV_FILE not found — using defaults"
fi

# Check prerequisites
command -v Orthanc >/dev/null 2>&1 || { echo "ERROR: Orthanc not found. Install it first."; exit 1; }
command -v nginx >/dev/null 2>&1 || { echo "ERROR: nginx not found. Install it first."; exit 1; }

# Build frontend if needed
if [ ! -d "$PROJECT_DIR/frontend/dist" ]; then
  echo "Building frontend..."
  cd "$PROJECT_DIR/frontend" && npm run build
fi

echo "Starting services..."
echo ""

# Derive credentials
ORTHANC_USERNAME="${ORTHANC_USERNAME:-orthanc}"
ORTHANC_PASSWORD="${ORTHANC_PASSWORD:?ERROR: ORTHANC_PASSWORD not set in .env}"
export ORTHANC_USERNAME ORTHANC_PASSWORD
export ORTHANC_BASIC_AUTH
ORTHANC_BASIC_AUTH=$(printf '%s:%s' "$ORTHANC_USERNAME" "$ORTHANC_PASSWORD" | base64)

# Orthanc — generate runtime config with credentials from env
echo "[1/3] Starting Orthanc..."
envsubst '$ORTHANC_USERNAME $ORTHANC_PASSWORD' \
  < "$PROJECT_DIR/orthanc/orthanc.json" \
  > "$PROJECT_DIR/orthanc/orthanc-runtime.json"
Orthanc "$PROJECT_DIR/orthanc/orthanc-runtime.json" &
ORTHANC_PID=$!
echo "  PID: $ORTHANC_PID (DICOM: 48924, HTTP: 48923)"

# FastAPI
echo "[2/3] Starting FastAPI..."
cd "$PROJECT_DIR/backend"
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 48922 &
FASTAPI_PID=$!
echo "  PID: $FASTAPI_PID (HTTP: 48922)"

# nginx — generate runtime config with credentials from env
echo "[3/3] Starting nginx..."
envsubst '$ORTHANC_BASIC_AUTH' \
  < "$PROJECT_DIR/nginx/nginx.conf" \
  > "$PROJECT_DIR/nginx/nginx-runtime.conf"
sudo nginx -c "$PROJECT_DIR/nginx/nginx-runtime.conf"
echo "  HTTPS: 48921"

echo ""
echo "=== All services running ==="
echo "Portal:  https://localhost:48921"
echo "API:     https://localhost:48921/api/"
echo "OHIF:    https://localhost:48921/ohif/"
echo ""
echo "Press Ctrl+C to stop..."

# Trap to clean up
trap 'echo "Stopping..."; kill $ORTHANC_PID $FASTAPI_PID 2>/dev/null; sudo nginx -s stop 2>/dev/null; rm -f "$PROJECT_DIR/orthanc/orthanc-runtime.json" "$PROJECT_DIR/nginx/nginx-runtime.conf"; echo "Done."' EXIT

wait
