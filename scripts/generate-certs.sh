#!/bin/bash
# Generate self-signed SSL certificate for MiniPACS development
set -e

CERT_DIR="/etc/ssl/minipacs"

if [ -f "$CERT_DIR/cert.pem" ]; then
  echo "Certificates already exist at $CERT_DIR"
  exit 0
fi

echo "Creating certificate directory..."
sudo mkdir -p "$CERT_DIR"

echo "Generating self-signed certificate..."
sudo openssl req -x509 -newkey rsa:4096 \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days 365 -nodes \
  -subj "/CN=minipacs.local"

echo "Done. Certificate at $CERT_DIR/cert.pem"
