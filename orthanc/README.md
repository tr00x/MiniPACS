# Orthanc Setup

## Install on macOS (development)

```bash
brew install orthanc
brew install orthanc-dicomweb
brew install orthanc-authorization
brew install orthanc-transfers
```

## Install on Ubuntu/Debian (production)

```bash
sudo apt-get install orthanc orthanc-dicomweb orthanc-authorization orthanc-transfers
```

## Configuration

Copy `orthanc.json` to the Orthanc config directory:

- **macOS:** `/usr/local/etc/orthanc/`
- **Linux:** `/etc/orthanc/`

```bash
# macOS
cp orthanc.json /usr/local/etc/orthanc/orthanc.json

# Linux
sudo cp orthanc.json /etc/orthanc/orthanc.json
```

## TLS Certificates (HIPAA requirement)

Generate or obtain TLS certificates for DICOM encryption:

```bash
sudo mkdir -p /etc/orthanc/tls

# Self-signed for development:
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/orthanc/tls/key.pem \
  -out /etc/orthanc/tls/cert.pem \
  -subj "/CN=MINIPACS"

cp /etc/orthanc/tls/cert.pem /etc/orthanc/tls/trusted.pem
```

For production, use certificates from your organization's CA.

## Firewall (HIPAA requirement)

Port 48923 (Orthanc HTTP API) must be accessible only from localhost. FastAPI is the sole gateway.

```bash
# Linux (ufw)
sudo ufw deny 48923
sudo ufw allow from 127.0.0.1 to any port 48923

# macOS (pf) — add to /etc/pf.conf:
# block in on ! lo0 proto tcp to any port 48923
```

Port 48924 (DICOM) should be open only to known clinic equipment and external PACS IPs.

## Create Storage Directory

```bash
# Linux
sudo mkdir -p /var/lib/orthanc/db
sudo chown orthanc:orthanc /var/lib/orthanc/db

# macOS (development)
sudo mkdir -p /var/lib/orthanc/db
sudo chown $(whoami) /var/lib/orthanc/db
```

## Start Orthanc

```bash
# macOS (development)
Orthanc /usr/local/etc/orthanc/orthanc.json

# Linux (production) — via systemd
sudo systemctl start orthanc
sudo systemctl enable orthanc
```

## Verify

- **HTTP API:** http://localhost:48923 (should require auth)
- **DICOM port:** 48924 (C-ECHO test from another node)
- **DICOMweb:** http://localhost:48923/dicom-web/

## Ports

| Service       | Port  |
|---------------|-------|
| Orthanc HTTP  | 48923 |
| Orthanc DICOM | 48924 |

## Plugin Notes

| Plugin / Feature | Purpose | Type |
|------------------|---------|------|
| DICOMweb | WADO-RS, STOW-RS, QIDO-RS for OHIF viewer | Plugin (.so) |
| Authorization | Delegates access control to FastAPI backend | Plugin (.so) |
| Transfers | Accelerated transfer of large studies between peers | Plugin (.so) |
| DICOM TLS | Encrypted DICOM traffic (HIPAA) | Built-in (no .so needed) |

## Storage

Default storage path: `/var/lib/orthanc/db`. For production, place on a dedicated partition with:
- Sufficient capacity for projected study volume
- OS-level encryption (AES-256) for HIPAA at-rest compliance
- Scheduled backups (daily, 30-day retention, offsite copy)
