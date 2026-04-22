#!/bin/bash
# MiniPACS Watchdog — ensures all containers are running
PROJECT=/home/pacs-user/minipacs
cd "$PROJECT" || exit 1
EXPECTED=4
RUNNING=$(docker compose -f docker-compose.prod.yml ps --status running -q | wc -l)
if [ "$RUNNING" -lt "$EXPECTED" ]; then
    echo "$(date -Is) [watchdog] $RUNNING/$EXPECTED running — restarting stack" >> "$PROJECT/backups/watchdog.log"
    docker compose -f docker-compose.prod.yml up -d >> "$PROJECT/backups/watchdog.log" 2>&1
fi
