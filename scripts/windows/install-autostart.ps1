# Installs the MiniPACS autostart machinery on Windows.
#
# Run ONCE from an elevated PowerShell (Run as Administrator):
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#
# What it sets up:
#   1. C:\ProgramData\MiniPACS\*  — drops the three operational PS1 scripts
#      (update-portproxy, boot-minipacs, watchdog-minipacs) so they live at a
#      stable, admin-only path independent of the git checkout.
#   2. Scheduled Task "MiniPACS_Boot"     — runs boot-minipacs.ps1 at Windows
#      startup as SYSTEM.
#   3. Scheduled Task "MiniPACS_Watchdog" — runs watchdog-minipacs.ps1 every
#      5 minutes as SYSTEM. Restarts the stack after 2 consecutive health
#      probe failures.
#
# Uninstall:
#   Unregister-ScheduledTask -TaskName MiniPACS_Boot -Confirm:$false
#   Unregister-ScheduledTask -TaskName MiniPACS_Watchdog -Confirm:$false
#   Remove-Item -Recurse C:\ProgramData\MiniPACS

$ErrorActionPreference = "Stop"

# Must be admin to create machine-scope Scheduled Tasks.
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Run this script from an elevated PowerShell (Run as Administrator)."
    exit 1
}

$target = "C:\ProgramData\MiniPACS"
$scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path

New-Item -ItemType Directory -Force -Path $target | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $target "logs") | Out-Null

foreach ($f in @("update-portproxy.ps1", "boot-minipacs.ps1", "watchdog-minipacs.ps1")) {
    Copy-Item -Force -Path (Join-Path $scriptsDir $f) -Destination (Join-Path $target $f)
    Write-Host "Installed $target\$f"
}

function Register-Task($name, $scriptPath, $trigger) {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    $runAs = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

    # Idempotent install — unregister if present.
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
        -Settings $settings -Principal $runAs -Force | Out-Null
    Write-Host "Registered Scheduled Task: $name"
}

# Boot: fire once at Windows startup.
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
# Give the Windows TCP/IP + WSL subsystem a moment before invoking wsl.exe.
$bootTrigger.Delay = "PT45S"
Register-Task "MiniPACS_Boot" (Join-Path $target "boot-minipacs.ps1") $bootTrigger

# Watchdog: every 5 minutes, indefinitely.
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-Task "MiniPACS_Watchdog" (Join-Path $target "watchdog-minipacs.ps1") $watchdogTrigger

Write-Host ""
Write-Host "MiniPACS autostart installed. Rebooting Windows now will exercise the Boot task."
Write-Host "Watch logs: $target\logs\"
