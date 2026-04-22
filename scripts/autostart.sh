#!/bin/bash
# Auto-launch import in tmux after WSL boot
set -e
# Wait for Docker daemon (up to 90s)
for i in {1..30}; do docker ps >/dev/null 2>&1 && break; sleep 3; done
# Wait for SMB mount (fstab should handle, but belt+suspenders)
for i in {1..10}; do mountpoint -q /mnt/mri-archive && break; sleep 3; done
# Skip if user paused the importer (rm the marker to resume)
[ -f /home/pacs-user/minipacs/backups/.import_paused ] && exit 0
# Skip if already running
tmux has-session -t import 2>/dev/null && exit 0
# Launch
cd /home/pacs-user/minipacs && tmux new-session -d -s import "python3 -u scripts/import_archive.py >> backups/import.log 2>&1"
echo "$(date -Is) autostart launched import" >> /home/pacs-user/minipacs/backups/autostart.log
