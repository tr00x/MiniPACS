#!/bin/sh
# Substitute env vars in orthanc config and start Orthanc
set -e

ORTHANC_USERNAME="${ORTHANC_USERNAME:-orthanc}"
ORTHANC_PASSWORD="${ORTHANC_PASSWORD:?ORTHANC_PASSWORD must be set}"

sed "s/\$ORTHANC_USERNAME/$ORTHANC_USERNAME/g; s/\$ORTHANC_PASSWORD/$ORTHANC_PASSWORD/g" \
  /etc/orthanc/orthanc-template.json > /etc/orthanc/orthanc.json

exec Orthanc /etc/orthanc/orthanc.json
