FROM python:3.12-slim

WORKDIR /app

# p7zip-full powers the import endpoint's archive extraction — one binary
# that handles ZIP / TAR / TAR.GZ / 7Z / RAR / ISO (including UDF-mode ISO
# images that pycdlib chokes on). Slim image ships without it by default.
# xorriso powers the burn-ISO export endpoint — masters ISO 9660 with
# Joliet + Rock Ridge extensions so Windows, macOS, and Linux all read
# long filenames correctly off the resulting disc/USB.
RUN apt-get update \
    && apt-get install -y --no-install-recommends p7zip-full xorriso curl unzip \
    && rm -rf /var/lib/apt/lists/*

# DWV (DICOM Web Viewer) is bundled into the backend image so the burn-ISO
# export can stage a self-contained HTML5 viewer next to the patient's
# DICOMs. MIT license — fine to redistribute on patient discs. Pure
# HTML/JS, no Java/install — patient opens index.html in any browser
# (Win/Mac/Linux/iPad), picks the DICOM folder, viewer loads.
# Using the upstream "dwv-simplistic" prebuilt PWA distro: single
# index.html entry + bundled jpeg2000/jpegbaseline/jpegloss/rle workers
# so compressed DICOMs render offline. Pinned version for repeatable
# builds; bump deliberately on major upstream releases. The zip extracts
# to a versioned subdir which we flatten so iso_builder can stage a
# stable ${DWV_PATH}/index.html regardless of version bumps.
ENV DWV_VERSION=0.10.0
ENV DWV_PATH=/opt/dwv
RUN mkdir -p ${DWV_PATH} \
    && curl -fsSL -o /tmp/dwv.zip \
       "https://github.com/ivmartel/dwv-simplistic/releases/download/v${DWV_VERSION}/dwv-simplistic-${DWV_VERSION}.zip" \
    && unzip -q /tmp/dwv.zip -d /tmp/dwv-extract \
    && mv /tmp/dwv-extract/dwv-simplistic-${DWV_VERSION}/* ${DWV_PATH}/ \
    && mv /tmp/dwv-extract/dwv-simplistic-${DWV_VERSION}/.[!.]* ${DWV_PATH}/ 2>/dev/null || true \
    && rm -rf /tmp/dwv.zip /tmp/dwv-extract \
    && test -f ${DWV_PATH}/index.html

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/
COPY seed_demo.py .

EXPOSE 8000

# Single worker + uvloop + httptools. Previously tried --workers 2 for
# parallelism, but each worker carried its OWN in-memory cache
# (_studies_cache, _patients_cache, _cache) — so users got routed
# round-robin between a warm and a cold worker, producing random
# 10-30s tail latency on supposedly-cached endpoints. uvloop alone
# gives us ~2x the throughput of asyncio default loop, which is
# enough headroom for concurrent UI + OHIF metadata bursts. A shared
# cache (Redis) is the proper fix for multi-worker, deferred.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--loop", "uvloop", "--http", "httptools"]
