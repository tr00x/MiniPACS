# Windows boot-time starter for MiniPACS.
#
# Target of the `MiniPACS_Boot` Scheduled Task (fires at Windows startup).
# Makes two things true:
#
#   1. WSL2 Ubuntu is running (wsl.exe returns after distro init).
#   2. The docker-compose stack inside WSL is `up -d`.
#
# Also re-runs `update-portproxy.ps1` so :22, :443, :48924 point at today's
# fresh WSL IP — netsh portproxy rules are per-boot and must be rewritten
# every time the WSL IP changes.
#
# This is idempotent: if WSL is already up and compose is healthy, it's a
# fast no-op. Safe to run by hand after `wsl --shutdown`.

$ErrorActionPreference = "Continue"
$logDir = "C:\ProgramData\MiniPACS\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "boot-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    Write-Host $line
    Add-Content -Path $log -Value $line
}

$distro = "Ubuntu-24.04"
$composeDir = "~/minipacs"
$composeFile = "docker-compose.prod.yml"

# Step 1 — ensure WSL distro is running. `wsl -l -v` reports state.
Log "Checking WSL distro '$distro' state"
$distroState = (wsl -l -v | Out-String) -split "`n" | Where-Object { $_ -match $distro }
Log "Distro line: $distroState"

if ($distroState -notmatch "Running") {
    Log "WSL not running — starting"
    # Fire a no-op command to boot the distro; return immediately.
    wsl -d $distro -e sh -c "true" 2>&1 | ForEach-Object { Log $_ }
    Start-Sleep -Seconds 5
}

# Step 2 — bring docker-compose stack up. depends_on + healthchecks gate
# the dependents, so one `up -d` handles the whole graph.
Log "docker compose up -d"
wsl -d $distro -e sh -c "cd $composeDir && docker compose -f $composeFile up -d" 2>&1 | ForEach-Object { Log $_ }

# Step 3 — refresh portproxy against the (possibly changed) WSL IP.
$portproxy = "C:\ProgramData\MiniPACS\update-portproxy.ps1"
if (Test-Path $portproxy) {
    Log "Refreshing portproxy"
    & $portproxy 2>&1 | ForEach-Object { Log $_ }
} else {
    Log "WARNING: $portproxy not found — portproxy rules stale"
}

# Step 4 — smoke test so the log reflects reality, not intent.
Start-Sleep -Seconds 8
Log "Smoke: curl http://localhost:8080/api/health"
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:8080/api/health" -TimeoutSec 10 -UseBasicParsing
    Log "Smoke result: HTTP $($resp.StatusCode)"
} catch {
    Log "Smoke FAILED: $($_.Exception.Message)"
}

Log "boot-minipacs done"
