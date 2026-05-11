# Developer Runbook

This file is for developers and code assistants. It is not an end-user
installation guide. Its purpose is to preserve the operational context needed
to continue development, release, and office deployment from any workstation
that can clone this repository and reach the NAS share.

## Canonical Sources

- GitHub repository: `BTankut/revit-mcp-skill`
- Local development path on the current workstation:
  `C:\Projects\revit-mcp-skill`
- Main branch: `main`
- Office deployment source:
  `\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy`
- Standard workstation install root:
  `C:\ProgramData\DPE\RevitMCP`

GitHub is the source history. The NAS share is the deployment source read by
office workstations. A normal `git commit` or `git push` does not deploy
anything by itself. Office deployment changes only when a release is published
to the NAS and a channel file points at that release.

Development and production releases are managed from `main`. Historical
branches or older repositories are not part of the current production flow.

## First Files To Read After Cloning

When this repo is cloned on another development workstation, read these files
before making changes:

1. `README.md`
2. `docs/DEVELOPER_RUNBOOK.md`
3. `docs/REPOSITORY_STRUCTURE.md`
4. `docs/PLATFORM_ARCHITECTURE.md`
5. `installer/nas/README.md`
6. `CHANGELOG.md`
7. `AGENTS.md`
8. `SKILL.md`

If Revit automation will be tested live, also read the installed or repo copy of
`SKILL.md` and follow the Revit MCP status preflight rule before every
non-status runtime command.

## Repository Map

High-value paths:

```text
revit-mcp-skill/
|-- README.md
|-- SKILL.md
|-- AGENTS.md
|-- CHANGELOG.md
|-- config/
|   `-- revit-versions.json
|-- docs/
|   |-- DEVELOPER_RUNBOOK.md
|   |-- PLATFORM_ARCHITECTURE.md
|   |-- ADR-0001-UPDATER-DOTNET-HELPER.md
|   |-- REPOSITORY_STRUCTURE.md
|   `-- MONOREPO_MIGRATION.md
|-- references/
|-- scripts/
|   |-- build-revit-plugin.ps1
|   |-- test-all.ps1
|   `-- test-installer-smoke.ps1
|-- src/
|   `-- revit-plugin/
`-- installer/
    |-- install-self-contained.ps1
    |-- lib/
    |-- nas/
    |-- runtime-mcp-server/
    |-- revit-api-docs-mcp/
    |-- command-payload/
    `-- revit-plugin/
```

Important source vs payload rule:

- `src/revit-plugin/` is the Revit add-in source.
- `installer/revit-plugin/` is the bundled install payload.
- `installer/command-payload/` is the bundled dynamic command payload.
- `installer/runtime-mcp-server/src/` is the runtime MCP TypeScript source;
  `installer/runtime-mcp-server/build/` is the built runtime payload.
- `installer/revit-api-docs-mcp/src/` is the docs MCP TypeScript source;
  `installer/revit-api-docs-mcp/build/` is the built docs server payload.
- `installer/lib/` contains shared PowerShell helper modules used by installer
  and updater entrypoints.
- `config/revit-versions.json` is the central Revit version matrix.

Do not edit deployed files under `C:\ProgramData\DPE\RevitMCP` as a source of
truth. Fix the repo, rebuild or refresh payloads when needed, commit the repo,
then install or publish through the normal flow.

## Development Setup On A New Machine

Clone the repo:

```powershell
git clone https://github.com/BTankut/revit-mcp-skill.git C:\Projects\revit-mcp-skill
cd C:\Projects\revit-mcp-skill
git status
git branch --show-current
```

Expected branch: `main`.

Required local tools for full development:

- Git for Windows
- Autodesk Revit 2022
- Node.js 20 or newer
- Codex Desktop app or another MCP/skill-capable host
- PowerShell 5.1 or newer
- Visual Studio/MSBuild tooling if rebuilding the Revit add-in source
- Access to `\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy` for office
  publishing and workstation updater tests

Office workstations reach the internet through `http://192.168.90.10:6588`.
The NAS installer/updater configures this proxy automatically for terminal
environment variables, WinHTTP, current-user Windows internet settings, npm,
and Git. Keep this behavior in sync if the office proxy changes.

Before changing anything on a new machine:

```powershell
git pull --ff-only
git status --short
```

The publish script refuses dirty releases unless `-AllowDirty` is explicitly
used. Production NAS releases should be published from a clean tree.

## Normal Development Workflow

1. Pull latest `main`.
2. Inspect existing patterns before editing.
3. Make the smallest safe change in source files.
4. If Revit add-in source changed, rebuild the plugin payload.
5. Run targeted validation.
6. Commit source and generated payload together when payload is affected.
7. Push `main`.
8. Publish the tested release to NAS `stable`.
9. Verify one real Revit workstation after the stable publish.

Useful baseline commands:

```powershell
cd C:\Projects\revit-mcp-skill
git status --short
git pull --ff-only
```

## Revit Add-In Development

Edit source under:

```text
src\revit-plugin\
```

Then rebuild and refresh the installer payload:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Commit together:

- changed files under `src/revit-plugin/`
- refreshed files under `installer/revit-plugin/`
- refreshed files under `installer/command-payload/` if the command payload
  changed
- `CHANGELOG.md` when behavior changes
- relevant docs

Do not publish an add-in change if the payload binaries were not refreshed.

## Runtime And Docs MCP Development

The office package includes two local MCP servers:

- `revit-mcp`: live Revit runtime execution and inspection
- `revit-api-docs`: local Revit API DLL/XML lookup

Installed workstation registrations normally point to:

```text
C:\ProgramData\DPE\RevitMCP\runtime\build\index.js
C:\ProgramData\DPE\RevitMCP\package\installer\revit-api-docs-mcp\build\index.js
```

Both servers are required. If only the runtime server is available, non-trivial
Revit API work is not considered fully set up.

Both MCP packages are TypeScript-first. Edit `src/`, then emit the existing
`build/` contract:

```powershell
cd .\installer\runtime-mcp-server
npm install --no-audit --no-fund
npm run test

cd ..\revit-api-docs-mcp
npm install --no-audit --no-fund
npm run test
```

`npm run test` runs `tsc` and a local smoke check. It does not need Revit. The
docs MCP smoke intentionally verifies tool registration without requiring a
local Revit API index.

After changes to bundled MCP server payloads, run the relevant local tests,
commit `src/`, `build/`, `package.json`, and `package-lock.json` together, and
verify `codex mcp list` after install or update.

## PowerShell Installer/Updater Modules

Public entrypoint script names stay stable, but shared behavior lives under
`installer/lib/`:

- hidden VBS launcher generation
- scheduled task action creation/repair
- targeted permission repair
- package path/layout and ZIP extraction
- Revit version matrix and install-root discovery
- Revit-open defer/update policy
- proxy normalization
- Codex MCP `config.toml` registration helper
- JSON reporting helper

When updater tools are installed or published to NAS, the `lib` folder must be
copied beside them. The matching `config` folder must also be copied so the
Revit version matrix is available before a package is extracted. The local
updater expects:

```text
C:\ProgramData\DPE\RevitMCP\updater\lib
C:\ProgramData\DPE\RevitMCP\updater\config
```

NAS tools expect:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\lib
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\config
```

Run the local PowerShell smoke suite after touching installer/updater behavior:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1
```

The smoke suite is non-admin and does not need Revit. It checks hidden launcher
exit-code propagation, WScript scheduled task action shape, targeted permission
plans, Revit-open update decisions, stable package path/layout resolution, and
public `install-self-contained.ps1` parameters.

## Revit Version Matrix

Revit version metadata is centralized in:

```text
config\revit-versions.json
```

The matrix contains target framework, build configuration, install-root
candidates, add-in path pattern, API package mappings, and payload path
expectations. Revit 2022 remains the only bundled installer payload. Revit
2023/2024/2025 are modeled, but `installerPayloadAvailable` stays `false` until
real payload artifacts are built, tested, and committed. Installer paths must
not pretend to deploy a version whose payload flag is false.

Use:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

for a source build check. Use the same command without `-SkipPayloadCopy` only
when intentionally refreshing the 2022 bundled payload.

## Local No-Deploy Test Flow

For branch validation that must not publish to NAS:

```powershell
git branch --show-current
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1

cd .\installer\runtime-mcp-server
npm run test

cd ..\revit-api-docs-mcp
npm run test

cd ..\..
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

Aggregate non-Revit tests can also be run with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
```

This local flow does not run `publish-nas-release.ps1` and does not touch
`channels\stable.json`.

## Revit MCP Runtime Rule

Before every non-status Revit MCP runtime command:

1. Call `get_revit_mcp_status`.
2. If `activeTask` is present, do not send a new command.
3. Report the active task name and elapsed time.
4. Poll only `get_revit_mcp_status` until the task clears.
5. Then send the next Revit command.

Do not run Revit MCP runtime commands in parallel. The only exception is
status polling while a task is already active.

This rule catches MCP tasks, not every manual user action in Revit. If the user
is actively selecting, saving, syncing, or editing, wait for user instruction.

## Local Install And Live Test

For manual local install from the repo, close Revit first:

```powershell
$RepoRoot = (Resolve-Path .).Path
powershell -ExecutionPolicy Bypass -File "$RepoRoot\installer\install-self-contained.ps1" -RevitVersion 2022
```

For office-style testing, prefer the NAS GUI updater:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-Revit-MCP-Updater-GUI.cmd
```

Live smoke test after install:

1. Open Revit 2022.
2. If Revit asks about unsigned add-in publisher, choose `Always Load`.
3. Confirm only the intended Revit process is open.
4. Call `get_revit_mcp_status`.
5. Call `get_revit_session_context`.
6. Run one small read-only count task.
7. Confirm `get_revit_mcp_status` shows the task as `completed`.
8. Confirm `revit-api-docs` responds to a small search such as
   `FilteredElementCollector`.

The current production status window behavior:

- running task: visible warning and elapsed time
- completed or failed task: stays visible until user clicks `OK`
- close button after completion acts as acknowledge/hide
- status window should not steal foreground focus from other apps
- recent task history is selectable and resizable

## Git Commit And Push

Typical flow:

```powershell
git status --short
git add <changed-files>
git commit -m "Short imperative message"
git push origin main
```

Keep commits coherent:

- source and matching payload in the same commit
- installer/updater behavior and docs in the same commit when useful
- no unrelated cleanup mixed into a production fix

Never deploy from an uncommitted production change unless it is an explicit
temporary test package with `-AllowDirty`.

## NAS Deployment Model

NAS root:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy
```

Layout:

```text
channels\
  stable.json
releases\
  <version>\
    revit-mcp-skill-<version>.zip
    manifest.json
reports\
tools\
```

Publish a stable release from a clean repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\nas\publish-nas-release.ps1 `
  -ReleaseRoot "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy" `
  -Channel stable
```

Verify channels:

```powershell
Get-Content -Raw "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\channels\stable.json"
```

Publishing refreshes `tools\` on the NAS. Workstations should launch the tools
from the NAS share, not from copied old script bodies when possible.

Large offline dependency payloads are local/NAS-side assets, not Git assets:

```text
installer\nas\dependencies\
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\dependencies\
```

The local dependency folder is ignored by Git. Keep it populated on the
development workstation before publishing. `publish-nas-release.ps1` copies it
to NAS `tools\dependencies\`, while excluding it from the versioned release ZIP.

Release ZIP compatibility:

- canonical package folder: `installer/`
- generated legacy alias inside the ZIP: `kurulum/`
- purpose: older workstation updaters can still install renamed layouts

## Workstation Install And Update

Stable workstation GUI:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-Revit-MCP-Updater-GUI.cmd
```

Single-file desktop launchers:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Revit MCP Updater STABLE.cmd
```

Use the single-file launchers when copying a `.cmd` to a workstation desktop.
The generic `Install-Revit-MCP-Updater-GUI.cmd` is meant to run from the NAS
`tools\` folder because it expects `Install-Revit-MCP-Updater-GUI.ps1` beside
it.

The GUI installs or refreshes the local updater and then runs an initial update.
The updater writes:

```text
C:\ProgramData\DPE\RevitMCP\updater\installed.json
C:\ProgramData\DPE\RevitMCP\updater\last-update-report.json
C:\ProgramData\DPE\RevitMCP\updater\logs\
```

The workstation install root is:

```text
C:\ProgramData\DPE\RevitMCP
```

Important deployed locations:

```text
C:\ProgramData\Autodesk\Revit\Addins\2022\mcp-servers-for-revit.addin
C:\ProgramData\DPE\RevitMCP\revit-plugin\revit_mcp_plugin
C:\ProgramData\DPE\RevitMCP\commands\CommandSet
C:\ProgramData\DPE\RevitMCP\runtime
C:\ProgramData\DPE\RevitMCP\package
C:\ProgramData\DPE\RevitMCP\codex
```

If registering a scheduled task fails because the user is not elevated, the
bootstrap creates a Startup-folder fallback:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Revit MCP Auto Update.cmd
```

The preferred updater registration is a per-user Scheduled Task. It runs at
logon and repeats every 30 minutes. If Scheduled Task registration is blocked,
the Startup fallback launches a hidden `auto-update-loop.ps1` process for the
user session and checks on the same interval. This keeps long-running office
workstations updated even when they are rarely restarted.

The GUI requests admin rights immediately at startup. If Windows opens the GUI
with different admin credentials, user-profile Codex integration may be written
under that admin profile instead of the operator profile. Prefer approving UAC
with the same Windows user when possible.

Background updater notifications:

- `deferred-revit-close-required`: user must save/sync, close Revit, and rerun
  the updater because Revit-loaded payload files changed.
- `updated`: background update completed.
- Notifications are throttled per version/status; default throttle is 240
  minutes.

## Revit-Close Update Policy

The updater is component-aware.

The release manifest includes `updatePolicy.revitClosedRequiredComponentKeys`
for Revit-loaded files. These include the Revit add-in DLLs, command payload,
command manifests, and command runtime assemblies.

Update behavior:

- If Revit-loaded files changed and Revit is running, the updater defers.
- It never auto-closes Revit.
- The message tells the user to save/sync, close Revit, and rerun the updater.
- If no Revit-loaded files changed, the updater can apply non-Revit payload
  updates while Revit is open.
- In that case it passes `-SkipRevitPayloadInstall` to the installer so active
  Revit add-in and command DLL files are left untouched.
- The updater compares actual installed Revit payload file hashes, not only the
  stored installed version. This catches stale Revit DLLs even when the package
  version already matches.

This policy is critical for large office models: do not require users to close
Revit for skill/docs/runtime/updater-only changes.

## Cleanup And Uninstall Safety

The installer cleans only known Revit MCP-owned locations. It must not delete:

- Autodesk Revit program files
- Windows system folders
- broad user profile folders
- broad workspace roots
- official Revit add-in root folders themselves

Known cleanup targets include the Revit MCP add-in manifest, old user-profile
add-in payloads, old local command folders, managed runtime targets, active
skill backup folders, and known legacy runtime folders.

Uninstall command:

```powershell
powershell -ExecutionPolicy Bypass -File ".\installer\install-self-contained.ps1" -RevitVersion 2022 -Uninstall
```

Use `-RemoveAgents` only when global/workspace `AGENTS.md` should also be
removed.

## Diagnostics

Check installed version:

```powershell
Get-Content -Raw "C:\ProgramData\DPE\RevitMCP\updater\installed.json"
```

Check last update report:

```powershell
Get-Content -Raw "C:\ProgramData\DPE\RevitMCP\updater\last-update-report.json"
```

Check logs:

```powershell
Get-ChildItem "C:\ProgramData\DPE\RevitMCP\updater\logs" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 10
```

Check whether Revit is still running:

```powershell
Get-Process -Name Revit -ErrorAction SilentlyContinue |
  Select-Object Id,StartTime,MainWindowTitle
```

Compare deployed plugin DLL with package DLL:

```powershell
$installed = "C:\ProgramData\DPE\RevitMCP\revit-plugin\revit_mcp_plugin\RevitMCPPlugin.dll"
$package = "C:\ProgramData\DPE\RevitMCP\package\installer\revit-plugin\revit_mcp_plugin\RevitMCPPlugin.dll"
(Get-FileHash -Algorithm SHA256 $installed).Hash
(Get-FileHash -Algorithm SHA256 $package).Hash
```

Compare deployed command DLL with package DLL:

```powershell
$installed = "C:\ProgramData\DPE\RevitMCP\commands\CommandSet\RevitMCPCommandSet.dll"
$package = "C:\ProgramData\DPE\RevitMCP\package\installer\command-payload\RevitMCPCommandSet.dll"
(Get-FileHash -Algorithm SHA256 $installed).Hash
(Get-FileHash -Algorithm SHA256 $package).Hash
```

Check MCP registrations:

```powershell
codex mcp list
```

Expected entries:

- `revit-mcp`
- `revit-api-docs`

If `list_revit_instances` shows an old Revit process, close all Revit windows
and check `Get-Process -Name Revit` again before reinstalling or retesting.

## Stable Channel

Use `stable` for all office deployment after local/manual validation. There is
only one deployment channel.

Do not assume the latest commit is the deployed version. Read the channel JSON:

```powershell
Get-Content -Raw "\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\channels\stable.json"
```

## Documentation Rules

When behavior changes, update the relevant docs in the same commit:

- `CHANGELOG.md` for user-visible or deployment-visible changes
- `README.md` for main repo orientation
- `docs/DEVELOPER_RUNBOOK.md` for development and release process changes
- `installer/nas/README.md` for workstation updater workflow changes
- `SKILL.md` and `AGENTS.md` for live Revit MCP coordination rules

This runbook should stay operational and command-oriented. Avoid vague history.
Write down exact paths, exact commands, and the current source of truth.
