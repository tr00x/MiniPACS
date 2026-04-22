#!/usr/bin/env bash
# One tick invoked from the Windows-side watchdog: revive tmux import if
# dead, sniff orthanc health, emit a one-line status for the PS console.
set -u
TOTAL=5429
STATE=/home/pacs-user/minipacs/backups/import_state.json

if [ -f /home/pacs-user/minipacs/backups/.import_paused ]; then
  printf 'tmux=paused '
elif ! tmux has-session -t import 2>/dev/null; then
  bash /home/pacs-user/minipacs/scripts/autostart.sh >/dev/null 2>&1 || true
  if tmux has-session -t import 2>/dev/null; then
    printf 'tmux=restarted '
  else
    printf 'tmux=DEAD '
  fi
else
  printf 'tmux=ok '
fi

if docker inspect -f '{{.State.Health.Status}}' minipacs-orthanc-1 2>/dev/null | grep -q healthy; then
  printf 'orthanc=ok '
else
  printf 'orthanc=DOWN '
fi

python3 - "$STATE" "$TOTAL" <<'PY'
import json, sys
path, total = sys.argv[1], int(sys.argv[2])
try:
    entries = json.load(open(path))['entries']
except Exception:
    print('state=missing')
    raise SystemExit
done   = sum(1 for v in entries.values() if v.get('status') == 'done')
failed = sum(1 for v in entries.values() if v.get('status') == 'failed')
pending = total - done - failed
pct = 100 * done / total if total else 0
print(f'done={done} failed={failed} pending={pending} ({pct:.1f}%)')
PY
