# Run as Administrator on the Windows Hyper-V host that owns the PACS VM.
# Configures the VM so it boots automatically after host reboot, with a
# 60-second delay so storage / network drivers settle before the guest
# starts hitting them.
#
# After running this once, the only manual recovery step ever needed is:
#   Get-VM -Name "PACS" | Start-VM
# (and even that only when the VM is in "Saved" state).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup-host-autostart.ps1

$VMName = "PACS"

if (-not (Get-Command Set-VM -ErrorAction SilentlyContinue)) {
    Write-Error "Hyper-V cmdlets not available. Install RSAT or run on a Hyper-V host."
    exit 1
}

$vm = Get-VM -Name $VMName -ErrorAction SilentlyContinue
if (-not $vm) {
    Write-Error "VM named '$VMName' not found. Available VMs:"
    Get-VM | Select-Object Name, State | Format-Table
    exit 1
}

Set-VM -Name $VMName -AutomaticStartAction Start -AutomaticStartDelay 60
# ShutDown (clean Linux shutdown via integration services) instead of Save —
# saving 16 GB of guest RAM to disk and restoring it after a host reboot
# risks corrupting Orthanc's WAL / attachment store; Postgres handles its
# own crash recovery, so a clean shutdown + cold start is safer.
Set-VM -Name $VMName -AutomaticStopAction ShutDown

$updated = Get-VM -Name $VMName
Write-Host "VM '$VMName' configured:" -ForegroundColor Green
Write-Host "  AutomaticStartAction = $($updated.AutomaticStartAction)"
Write-Host "  AutomaticStartDelay  = $($updated.AutomaticStartDelay) seconds"
Write-Host "  AutomaticStopAction  = $($updated.AutomaticStopAction)"
Write-Host ""
Write-Host "Test: reboot the host. The VM should come back up on its own." -ForegroundColor Cyan
