#!/bin/bash
# Keep the Orthanc SQLite index hot in OS page cache.
#
# Root cause: Orthanc process only keeps ~30 MiB RSS, so the 637 MB index relies
# on the OS page cache. After ~10 min of idle, Linux evicts those pages in favour
# of other workloads, and the next worklist query pays the cold-scan cost
# (backend times out at 30s → 502 in the UI).
#
# This script fires a trivial /tools/find every 2 min (via cron) so the index
# stays resident. Cost: one no-op Orthanc query per 2 min. Benefit: worklist
# never cold-starts in front of a user.
docker exec minipacs-backend-1 python3 -c "
import urllib.request, base64, json, time, sys
a = base64.b64encode(b'orthanc:6GymDRk7txuTO3SQUyUm4Q').decode()
h = {'Authorization': 'Basic ' + a, 'Content-Type': 'application/json'}
body = json.dumps({'Level': 'Study', 'Query': {}, 'Expand': False, 'Limit': 1}).encode()
try:
    t = time.time()
    urllib.request.urlopen(
        urllib.request.Request('http://orthanc:8042/tools/find', data=body, headers=h, method='POST'),
        timeout=600,
    ).read()
    sys.stdout.write(f'prewarm OK {time.time()-t:.1f}s\n')
except Exception as e:
    sys.stderr.write(f'prewarm FAIL {e}\n')
    sys.exit(1)
"
