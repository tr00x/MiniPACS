#!/bin/bash
# Start all MiniPACS services
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== MiniPACS Portal ==="
echo "Project: $PROJECT_DIR"
echo ""

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

# Orthanc
echo "[1/3] Starting Orthanc..."
Orthanc "$PROJECT_DIR/orthanc/orthanc.json" &
ORTHANC_PID=$!
echo "  PID: $ORTHANC_PID (DICOM: 48924, HTTP: 48923)"

# FastAPI
echo "[2/3] Starting FastAPI..."
cd "$PROJECT_DIR/backend"
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 48922 &
FASTAPI_PID=$!
echo "  PID: $FASTAPI_PID (HTTP: 48922)"

# nginx
echo "[3/3] Starting nginx..."
sudo nginx -c "$PROJECT_DIR/nginx/nginx.conf"
echo "  HTTPS: 48921"

echo ""
echo "=== All services running ==="
echo "Portal:  https://localhost:48921"
echo "API:     https://localhost:48921/api/"
echo "OHIF:    https://localhost:48921/ohif/"
echo ""
echo "Press Ctrl+C to stop..."

# Trap to clean up
trap 'echo "Stopping..."; kill $ORTHANC_PID $FASTAPI_PID 2>/dev/null; sudo nginx -s stop 2>/dev/null; echo "Done."' EXIT

wait
