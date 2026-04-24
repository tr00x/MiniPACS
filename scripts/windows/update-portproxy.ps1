# MiniPACS portproxy refresh for Windows host running WSL2 (NAT mode).
#
# WSL2 in NAT mode gets a new internal IP every boot — `netsh portproxy` rules
# must be rewritten every time, otherwise the Cloudflare Tunnel connector,
# SSH, and direct-LAN HTTPS all silently fail because their portproxy rules
# still point at yesterday's WSL IP.
#
# This script is wired to the Scheduled Task `MiniPACS_PortProxy` which fires
# at Windows boot. It's also safe to run by hand after resuming WSL:
#   powershell -ExecutionPolicy Bypass -File C:\ProgramData\MiniPACS\update-portproxy.ps1
#
# Ports exposed to the host:
#   22    — SSH into WSL (Timur's diagnostic access via LAN)
#   443   — LAN-facing HTTPS for split-horizon DNS
#                     (pacs.your-clinic.example → clinic LAN IP on the UniFi)
#   48924 — DICOM C-STORE for modalities on the LAN

$ErrorActionPreference = "Stop"

$distro = "Ubuntu"

# Get the current WSL IP. Probes once — WSL must already be running; the
# caller (either Task Scheduler's "Start WSL" step, or a human) is expected
# to have ensured that.
$wslIp = (wsl -d $distro -e sh -c "ip -4 addr show eth0 | awk '/inet / {print `$2}' | cut -d/ -f1").Trim()
if ([string]::IsNullOrWhiteSpace($wslIp)) {
    Write-Error "Could not resolve WSL IP — is the $distro distro running?"
    exit 1
}
Write-Host "WSL IP detected: $wslIp"

# Wipe existing rules for the ports we manage, then re-add. Using v4tov4 on
# 0.0.0.0 so the rule matches both LAN and CF-tunnel-side traffic.
$ports = @(22, 443, 48924)
foreach ($p in $ports) {
    Write-Host "Resetting portproxy :$p → $wslIp`:$p"
    netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 | Out-Null
    netsh interface portproxy add    v4tov4 listenport=$p listenaddress=0.0.0.0 connectport=$p connectaddress=$wslIp | Out-Null
}

# Show current state for the event log / manual runs.
Write-Host ""
Write-Host "Current portproxy rules:"
netsh interface portproxy show v4tov4
