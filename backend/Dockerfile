FROM python:3.12-slim

WORKDIR /app

# p7zip-full powers the import endpoint's archive extraction — one binary
# that handles ZIP / TAR / TAR.GZ / 7Z / RAR / ISO (including UDF-mode ISO
# images that pycdlib chokes on). Slim image ships without it by default.
# xorriso powers the burn-ISO export endpoint — masters ISO 9660 with
# Joliet + Rock Ridge extensions so Windows, macOS, and Linux all read
# long filenames correctly off the resulting disc/USB.
RUN apt-get update \
    && apt-get install -y --no-install-recommends p7zip-full xorriso \
    && rm -rf /var/lib/apt/lists/*

# Burn-ISO export ships DICOMDIR-only (IHE PDI compliant). No embedded
# viewer — modern browsers block file:// origins from loading ES modules,
# instantiating Workers, fetching JSON, registering Service Workers, etc.
# Both `dwv-simplistic` (PWA) and stock `dwv` UMD (needs Workers for J2K
# / JPEG-Lossless / RLE decoders) failed under file:// in Chrome/Safari.
# Real-world studies are almost always compressed, so a viewer that
# silently fails on every compressed series is worse than no viewer at
# all. README.txt directs patients to free desktop viewers (Weasis,
# MicroDicom, Horos, RadiAnt) which read DICOMDIR natively.

COPY requirements.txt requirements-test.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-test.txt

COPY app/ app/
COPY tests/ tests/
COPY pytest.ini ./
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
