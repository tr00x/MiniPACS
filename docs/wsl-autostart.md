# WSL + MiniPACS autostart & watchdog

Two layers so neither one being mispigment breaks the whole thing:

| Layer | What | When it fires |
|---|---|---|
| **Windows Scheduled Tasks** | `MiniPACS_Boot`, `MiniPACS_Watchdog` | At Windows startup; every 5 min |
| **systemd unit inside WSL** | `minipacs-compose.service` | Whenever the WSL distro itself boots |

Prior state (pre-2026-04-24): when WSL crashed or Windows rebooted,
MiniPACS stayed down until someone with access to the Windows console
manually ran `wsl -d Ubuntu` and `docker compose up -d`. This now is
fully automatic.

## One-time install on the Windows host

Open **PowerShell as Administrator**, checkout the repo on the Windows side
(or wherever), then:

```powershell
cd C:\path\to\minipacs\scripts\windows
powershell -ExecutionPolicy Bypass -File install-autostart.ps1
```

That:

- Copies `update-portproxy.ps1`, `boot-minipacs.ps1`, `watchdog-minipacs.ps1`
  into `C:\ProgramData\MiniPACS\` (admin-writable, survives git checkouts).
- Registers `MiniPACS_Boot` (runs at Windows startup, SYSTEM, 45s delay
  so WSL subsystem is warm).
- Registers `MiniPACS_Watchdog` (runs every 5 min, SYSTEM, restarts the
  stack after 2 consecutive `/api/health` failures).
- Creates `C:\ProgramData\MiniPACS\logs\` — boot + watchdog outputs.

Reboot Windows once to confirm `MiniPACS_Boot` fires.

## One-time install inside WSL (belt and braces)

`wsl --shutdown` + `wsl -d Ubuntu` does NOT trigger the Windows Boot task.
A systemd unit inside WSL handles that flow:

```bash
# inside the Ubuntu WSL distro
sudo cp ~/minipacs/scripts/wsl/minipacs-compose.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now minipacs-compose.service

# sanity
systemctl status minipacs-compose.service
```

## What the watchdog actually does

`watchdog-minipacs.ps1` hits `http://localhost:8080/api/health` every tick.

- 200 → clear the failure counter, exit.
- non-200 / timeout → increment counter, persist.
- counter ≥ 2 (≈10 min) → run `boot-minipacs.ps1` (WSL start + compose up +
  portproxy refresh + smoke probe), reset counter.

The two-tick threshold is deliberate — a container-recreate during a
normal deploy takes ~30s during which health is unreachable; a single
failed probe must not cascade into another restart.

## Debugging

```
C:\ProgramData\MiniPACS\logs\watchdog.log         # watchdog decisions
C:\ProgramData\MiniPACS\logs\boot-YYYYMMDD-*.log  # each boot run
```

To see task state:

```powershell
Get-ScheduledTask MiniPACS_Boot, MiniPACS_Watchdog | Format-Table TaskName, State, LastRunTime, LastTaskResult
```

## Rollback

```powershell
Unregister-ScheduledTask -TaskName MiniPACS_Boot -Confirm:$false
Unregister-ScheduledTask -TaskName MiniPACS_Watchdog -Confirm:$false
Remove-Item -Recurse C:\ProgramData\MiniPACS
```

Inside WSL: `sudo systemctl disable --now minipacs-compose.service`.
