#!/usr/bin/env bash
# HTJ2K smoke test — Task 0.2 reproducer.
#
# Hand-crafts an HTJ2K instance from an existing uncompressed instance in
# local Orthanc and verifies the upload round-trips with TS 1.2.840.10008.1.2.4.201.
#
# Visual verification in Stone Web Viewer is the user's job; see
# scripts/htj2k_smoke_result.txt for the manual checklist.
#
# Prereqs (host):
#   - docker compose stack running (orthanc on localhost:48923)
#   - ojph_compress on PATH  (`brew install openjph` or build OpenJPH 0.16+)
#   - python3 with pydicom + numpy in a venv (auto-created at /tmp/htj2k_venv)
set -euo pipefail

ORTHANC_URL="${ORTHANC_URL:-http://localhost:48923}"
ORTHANC_USER="${ORTHANC_USERNAME:-orthanc}"
ORTHANC_PASS="${ORTHANC_PASSWORD:-CHANGE-ME-IN-PRODUCTION}"
VENV="${VENV:-/tmp/htj2k_venv}"
WORK="${WORK:-/tmp}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v ojph_compress >/dev/null || {
  echo "ojph_compress not found. brew install openjph (or build OpenJPH)." >&2
  exit 1
}

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "[smoke] creating venv at $VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet pydicom numpy
fi

echo "[smoke] picking first uncompressed instance from Orthanc"
INST="$(curl -fsS -u "$ORTHANC_USER:$ORTHANC_PASS" "$ORTHANC_URL/instances" \
  | "$VENV/bin/python" -c 'import json,sys; print(json.load(sys.stdin)[0])')"
echo "[smoke] source instance: $INST"

ORIG_TS="$(curl -fsS -u "$ORTHANC_USER:$ORTHANC_PASS" \
  "$ORTHANC_URL/instances/$INST/metadata/TransferSyntax")"
echo "[smoke] source TS: $ORIG_TS"

if [[ "$ORIG_TS" == "1.2.840.10008.1.2.4.201" ]]; then
  echo "[smoke] source is already HTJ2K — nothing to prove" >&2
  exit 0
fi

echo "[smoke] downloading source DICOM to $WORK/orig.dcm"
curl -fsS -u "$ORTHANC_USER:$ORTHANC_PASS" \
  "$ORTHANC_URL/instances/$INST/file" -o "$WORK/orig.dcm"

echo "[smoke] re-packing as HTJ2K → $WORK/htj2k.dcm"
"$VENV/bin/python" "$SCRIPT_DIR/htj2k_repack.py" \
  "$WORK/orig.dcm" "$WORK/htj2k.dcm" --new-sop-uid

echo "[smoke] POSTing HTJ2K instance to Orthanc"
RESP="$(curl -fsS -u "$ORTHANC_USER:$ORTHANC_PASS" \
  -X POST "$ORTHANC_URL/instances" --data-binary "@$WORK/htj2k.dcm")"
echo "$RESP"

NEW_INST="$(echo "$RESP" | "$VENV/bin/python" -c 'import json,sys; print(json.load(sys.stdin)["ID"])')"
NEW_TS="$(curl -fsS -u "$ORTHANC_USER:$ORTHANC_PASS" \
  "$ORTHANC_URL/instances/$NEW_INST/metadata/TransferSyntax")"
echo "[smoke] new instance: $NEW_INST  TS=$NEW_TS"

if [[ "$NEW_TS" != "1.2.840.10008.1.2.4.201" ]]; then
  echo "[smoke] FAIL — Orthanc did not store as HTJ2K (got $NEW_TS)" >&2
  exit 2
fi

echo "[smoke] OK — server-side checks pass."
echo "[smoke] Stone visual verification is YOUR job; see scripts/htj2k_smoke_result.txt"
