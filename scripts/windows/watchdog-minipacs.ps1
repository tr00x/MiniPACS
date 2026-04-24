# Liveness watchdog for MiniPACS.
#
# Target of the `MiniPACS_Watchdog` Scheduled Task (recommended: every 5 min).
# Pings http://localhost:8080/api/health — if it's down for N consecutive
# ticks, re-runs `boot-minipacs.ps1` to bring everything back. If it's up,
# this is a quick HTTP call and exits.
#
# The "N consecutive failures before restart" threshold prevents a hair
# trigger during in-progress restarts / container recreates from cascading
# into another restart cycle.

$ErrorActionPreference = "Continue"
$logDir = "C:\ProgramData\MiniPACS\logs"
$stateFile = Join-Path $logDir "watchdog-state.txt"
$log = Join-Path $logDir "watchdog.log"
$failuresToTrigger = 2  # ~10 min at 5-min cadence before restart action
$healthUrl = "http://localhost:8080/api/health"
$bootScript = "C:\ProgramData\MiniPACS\boot-minipacs.ps1"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line
}

# Read prior consecutive-failure count (or 0).
$failures = 0
if (Test-Path $stateFile) {
    try { $failures = [int](Get-Content $stateFile -Raw).Trim() } catch { $failures = 0 }
}

$healthy = $false
try {
    $resp = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 8 -UseBasicParsing
    if ($resp.StatusCode -eq 200) { $healthy = $true }
} catch {
    Log "health probe failed: $($_.Exception.Message)"
}

if ($healthy) {
    if ($failures -gt 0) { Log "recovered — was $failures failures, clearing" }
    Set-Content -Path $stateFile -Value "0"
    exit 0
}

$failures++
Log "health DOWN (consecutive failures=$failures, trigger at $failuresToTrigger)"
Set-Content -Path $stateFile -Value "$failures"

if ($failures -lt $failuresToTrigger) { exit 0 }

# Breach — reboot the stack.
Log "BREACH — invoking $bootScript"
if (Test-Path $bootScript) {
    & $bootScript 2>&1 | ForEach-Object { Log $_ }
    # Reset counter so we don't ping-pong.
    Set-Content -Path $stateFile -Value "0"
} else {
    Log "ERROR: $bootScript not found"
}
