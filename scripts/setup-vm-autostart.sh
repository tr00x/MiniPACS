#!/usr/bin/env bash
# Run as root inside the PACS Linux VM (Hyper-V guest) once.
# Ensures Docker daemon + the minipacs compose stack come up automatically
# whenever the VM boots — combined with the host-side Hyper-V autostart
# (scripts/setup-host-autostart.ps1) this means the whole stack survives
# a host reboot end-to-end without sysadmin intervention.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Run as root (sudo $0)" >&2
    exit 1
fi

# 1. Docker daemon at boot — only if it's actually a systemd unit. Snap
#    or manually-installed binary docker have no docker.service and would
#    abort the script via `set -e`.
if systemctl list-unit-files 2>/dev/null | grep -q '^docker\.service'; then
    systemctl enable docker
    systemctl enable containerd 2>/dev/null || true
    echo "Docker daemon enabled at boot."
else
    echo "WARNING: docker.service systemd unit not found." >&2
    echo "Install Docker via apt/dnf (not snap) or enable manually." >&2
    exit 1
fi

# 2. Cloudflared (if installed as a systemd service) — make sure it
#    follows Docker, not the other way around. Tunnel needs the origin
#    healthy before it announces itself to CF edge.
if systemctl list-unit-files | grep -q cloudflared; then
    systemctl enable cloudflared
    echo "Cloudflared enabled at boot."
else
    echo "Note: cloudflared not installed as systemd service — skipping."
fi

# 3. Compose stack — containers already have restart: unless-stopped, so
#    they'll come up when the daemon starts. Verify the project directory
#    is in a known place and add a one-shot oneline systemd unit only if
#    docker compose isn't auto-restoring on its own (rare on docker-ce).
# Resolve the compose dir. logname is unreliable in non-tty contexts
# (cloud-init, ansible, automated provisioning) and silently returns ""
# → "/home//minipacs". SUDO_USER is set by sudo and stays empty when not.
USER_NAME="${SUDO_USER:-pacs-user}"
COMPOSE_DIR="${MINIPACS_DIR:-/home/$USER_NAME/minipacs}"
COMPOSE_DIR="$(realpath -m "$COMPOSE_DIR" 2>/dev/null || echo "$COMPOSE_DIR")"
if [[ ! -f "$COMPOSE_DIR/docker-compose.yml" ]]; then
    echo "ERROR: $COMPOSE_DIR/docker-compose.yml not found." >&2
    echo "Set MINIPACS_DIR=/abs/path/to/repo explicitly and re-run." >&2
    exit 1
fi
echo "Compose directory: $COMPOSE_DIR"

cat > /etc/systemd/system/minipacs-stack.service <<EOF
[Unit]
Description=MiniPACS docker-compose stack
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$COMPOSE_DIR
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable minipacs-stack.service
echo "minipacs-stack.service enabled — \`docker compose up -d\` runs on every boot."

echo ""
echo "Test: reboot the VM. Once it's up, run:"
echo "  systemctl status minipacs-stack"
echo "  docker compose ps"
echo "Both should report all services healthy."
