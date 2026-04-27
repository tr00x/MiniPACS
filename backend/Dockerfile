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

# Weasis Portable bakes a Java DICOM viewer with a bundled JRE per OS into
# the backend image so the burn-ISO export can stage it next to the
# patient's DICOMs without runtime downloads. Apache 2.0 license — fine
# to redistribute on patient discs. Pinned version for repeatable
# builds; bump deliberately when upstream releases a new feature LTS.
ENV WEASIS_VERSION=4.6.2
ENV WEASIS_PATH=/opt/weasis
RUN mkdir -p ${WEASIS_PATH} \
    && curl -fsSL -o /tmp/weasis.zip \
       "https://github.com/nroduit/Weasis/releases/download/v${WEASIS_VERSION}/weasis-native.zip" \
    && unzip -q /tmp/weasis.zip -d ${WEASIS_PATH} \
    && rm /tmp/weasis.zip \
    && test -d ${WEASIS_PATH}/bin-dist

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
