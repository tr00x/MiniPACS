#!/usr/bin/env bash
# Task 0.3 — Verify WADO-RS HTJ2K serving when stored bytes are HTJ2K.
#
# Tests whether the DicomWeb plugin in Orthanc serves stored HTJ2K bytes as-is
# when the client politely asks for transfer-syntax=1.2.840.10008.1.2.4.201,
# both at the instance level and (the path Stone/OHIF actually use) at the
# frame level. Also probes wildcard-Accept fallback to see what the server
# defaults to.
#
# Pre-req: Task 0.2 has pushed an HTJ2K-native instance into Orthanc. UIDs are
# wired in below for reproducibility on this machine; they can be overridden
# via env.
#
# Outputs go to /tmp; verdict is written separately into the baseline doc.

set -euo pipefail

ORTHANC_URL="${ORTHANC_URL:-http://localhost:48923}"
ORTHANC_AUTH="${ORTHANC_AUTH:-orthanc:CHANGE-ME-IN-PRODUCTION}"

STUDY_UID="${STUDY_UID:-1.2.826.0.1.3680043.8.498.89660403630396210808681955639703008310}"
SERIES_UID="${SERIES_UID:-1.2.826.0.1.3680043.8.498.11196342524154857620201920211982916259}"
INSTANCE_UID="${INSTANCE_UID:-1.2.826.0.1.3680043.8.498.91575830460297584858972199863051402008}"

HTJ2K_TS="1.2.840.10008.1.2.4.201"

INST_BIN=/tmp/wado.bin
INST_HDR=/tmp/wado.headers
FRAME_BIN=/tmp/wado_frame.bin
FRAME_HDR=/tmp/wado_frame.headers
WILD_BIN=/tmp/wado_frame_wildcard.bin
WILD_HDR=/tmp/wado_frame_wildcard.headers

base="${ORTHANC_URL}/dicom-web/studies/${STUDY_UID}/series/${SERIES_UID}/instances/${INSTANCE_UID}"

echo "=== Task 0.3: WADO-RS HTJ2K serving check ==="
echo "Orthanc: ${ORTHANC_URL}"
echo "Instance: ${INSTANCE_UID}"
echo

echo "--- [1/3] WADO-RS instance, Accept HTJ2K (application/dicom) ---"
http_status_inst=$(curl -s -o "${INST_BIN}" -D "${INST_HDR}" -w '%{http_code}' \
  -u "${ORTHANC_AUTH}" \
  -H "Accept: multipart/related; type=\"application/dicom\"; transfer-syntax=${HTJ2K_TS}" \
  "${base}")
echo "HTTP status: ${http_status_inst}"
echo "Headers:"
sed -n '1,20p' "${INST_HDR}"
echo "First 200 bytes (hex):"
head -c 200 "${INST_BIN}" | xxd | head -10
echo

echo "--- [2/3] WADO-RS frame 1, Accept HTJ2K (application/octet-stream) ---"
http_status_frame=$(curl -s -o "${FRAME_BIN}" -D "${FRAME_HDR}" -w '%{http_code}' \
  -u "${ORTHANC_AUTH}" \
  -H "Accept: multipart/related; type=\"application/octet-stream\"; transfer-syntax=${HTJ2K_TS}" \
  "${base}/frames/1")
echo "HTTP status: ${http_status_frame}"
echo "Headers:"
sed -n '1,20p' "${FRAME_HDR}"
echo "First 200 bytes (hex):"
head -c 200 "${FRAME_BIN}" | xxd | head -10
echo
echo "Looking for HTJ2K SOC+SIZ magic FF 4F FF 51 anywhere in body:"
if xxd -p "${FRAME_BIN}" | tr -d '\n' | grep -qoE 'ff4fff51'; then
  echo "  FOUND HTJ2K magic"
else
  echo "  NOT FOUND"
fi
echo

echo "--- [3/3] WADO-RS frame 1, Accept */* (wildcard fallback) ---"
http_status_wild=$(curl -s -o "${WILD_BIN}" -D "${WILD_HDR}" -w '%{http_code}' \
  -u "${ORTHANC_AUTH}" \
  -H "Accept: */*" \
  "${base}/frames/1")
echo "HTTP status: ${http_status_wild}"
echo "Headers:"
sed -n '1,20p' "${WILD_HDR}"
echo "First 200 bytes (hex):"
head -c 200 "${WILD_BIN}" | xxd | head -10
echo
echo "transfer-syntax in returned Content-Type:"
grep -i '^content-type' "${WILD_HDR}" | head -1 || echo "  (no content-type)"
echo

echo "=== Done. Inspect /tmp/wado*.bin and /tmp/wado*.headers for raw output. ==="
