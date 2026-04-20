FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ app/
COPY seed_demo.py .

EXPOSE 8000

# 2 workers with uvloop+httptools. Single worker serialized all request
# handling on one event loop, so a burst of OHIF metadata calls blocked
# worklist/dashboard traffic. 2 workers give us headroom for concurrent
# UI + viewer usage. The 8s in-memory cache becomes per-worker — still
# acceptable, TTL bridges the gap. `uvicorn[standard]` already pulls in
# uvloop + httptools (in requirements.txt).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--loop", "uvloop", "--http", "httptools"]
