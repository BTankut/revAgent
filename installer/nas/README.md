# NAS Deployment for Revit MCP

This folder contains the tools used to publish Revit MCP releases to the NAS
and keep office workstations updated from that single deployment source.

## Deployment Model

GitHub is the source history. The NAS share is the deployment source read by
office workstations.

```text
Code change
-> commit / push
-> test
-> publish-nas-release.ps1
-> channels\stable.json is updated
-> workstations run update-from-nas.ps1
```

A normal `git commit` or `git push` does not update the office by itself.

## NAS Layout

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\
  channels\
    stable.json
  releases\
    2026.05.08.1500-a1b2c3d4\
      revit-mcp-skill-2026.05.08.1500-a1b2c3d4.zip
      manifest.json
  reports\
    PC-01_USER22.json
  tools\
    Install-Revit-MCP-Updater.cmd
    Install-Revit-MCP-Updater-GUI.cmd
    Install-Revit-MCP-Updater-GUI.ps1
    install-updater-task.ps1
    update-from-nas.ps1
    show-installed-version.ps1
```

## Publish A Release

Run from a clean repo root on the development machine:

```powershell
$ReleaseRoot = "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy"
powershell -ExecutionPolicy Bypass -File ".\installer\nas\publish-nas-release.ps1" `
  -ReleaseRoot $ReleaseRoot `
  -Channel stable
```

## Install The Workstation Updater

Workstation prerequisites:

- Autodesk Revit 2022.
- Node.js 20 or newer, including `node.exe` and `npm.cmd`.
- Codex CLI for the Windows user running the installer.

On each workstation, close Revit and run:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-Revit-MCP-Updater-GUI.cmd
```

The GUI shows the live install/update log and provides a button to open the log
folder if something fails. The GUI launchers start PowerShell hidden, so a
separate terminal window should not remain beside the installer.

The GUI requests admin rights as soon as it opens. The updater then registers a
per-user Scheduled Task that checks at logon and every 30 minutes during the
day. If Windows still blocks Scheduled Task registration, the installer creates
a Startup fallback that keeps a hidden per-user update loop running with the
same interval.

If you want to copy a single launcher to a workstation desktop, copy the
standalone launcher instead:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Revit MCP Updater STABLE.cmd
```

Do not copy `Install-Revit-MCP-Updater-GUI.cmd` by itself. That file is meant
to run from the NAS `tools\` folder and expects
`Install-Revit-MCP-Updater-GUI.ps1` beside it.

The non-GUI bootstrap is also available:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-Revit-MCP-Updater.cmd
```

The updater uses the standard machine-wide root:

```text
C:\ProgramData\DPE\RevitMCP\
  package\
  runtime\
  updater\
  state\
  revit-plugin\
  codex\
```

Logs are written to:

```text
C:\ProgramData\DPE\RevitMCP\updater\logs\
```

## Update Behavior

- Reads the target version from `channels\stable.json`.
- Shows the installed version and target version as `old -> new`.
- Copies the versioned ZIP from NAS.
- Verifies the package SHA256 hash before install.
- Replaces the managed local package copy under `C:\ProgramData\DPE\RevitMCP\package`.
- Runs `install-self-contained.ps1`.
- Runs `npm install --omit=dev` for the runtime and docs MCP servers.
- Re-registers Codex MCP entries for the current office flow.
- Writes local and NAS report JSON files.

This is a full package update, not a file-level delta update.

## Safety

- Revit-loaded add-in and command files are not replaced while `Revit.exe` is
  running; those updates are deferred so the user can save/sync and close
  Revit. Non-Revit payload updates may still be applied while Revit is open.
- Missing Node.js/npm or Codex CLI is detected before local Revit MCP files are
  replaced.
- Pending updates that require the user to close Revit show a throttled user
  notification instead of failing silently in the background.
- Official Autodesk Revit and Windows system folders are not deleted.
- Cleanup is limited to known Revit MCP-owned install paths.
- The managed package target is refused if it is a Git working tree unless
  `-AllowReplaceGitPackageTarget` is explicitly passed.
- Release ZIPs include a generated legacy `kurulum/` alias so older installed
  updaters can install the renamed `installer/` layout safely.
