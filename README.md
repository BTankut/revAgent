# revAgent Workstation Package - Production Monorepo

This repo packages the revAgent workstation product: the `revit-mcp` skill,
Revit add-in source and payload, bundled local runtime MCP server, required
companion Revit API docs MCP server, installer, NAS updater, and deployment
documentation in one place.

It is the single canonical source for production office deployment.

Product-facing documentation should use **revAgent**. The names `revit-mcp`,
`RevitMCP*`, `mcp-servers-for-revit`, and `C:\ProgramData\DPE\RevitMCP`
remain exact implementation, tool, package, manifest, and path identifiers.

## What this repo provides

- `SKILL.md`: host-agnostic skill instructions for Revit MEP work
- `AGENTS.md`: workstation-wide coordination rules copied during install
- `src/revit-plugin/`: Revit add-in source code
- `config/revit-versions.json`: central Revit version matrix and payload gate
- `scripts/build-revit-plugin.ps1`: builds the add-in source and refreshes the installer payload binaries and manifest
- `installer/revit-plugin/`: bundled Revit add-in payload
- `installer/command-payload/`: command set DLL and manifest backup
- `installer/revit-payload-manifest.json`: source-to-payload freshness manifest for Revit DLL payloads
- `installer/runtime-mcp-server/`: TypeScript source and bundled local runtime MCP server build for live Revit execution
- `dashboard/`: read-only live dashboard server and browser UI for office monitoring
- `docs/PLATFORM_ARCHITECTURE.md`: current platform, bridge, runtime, telemetry, dashboard, and deployment architecture
- `docs/REVAGENT_USAGE_INTELLIGENCE.md`: usage-intelligence event, summary, live dashboard, and analyst pipeline
- `docs/REVIT_IMAGE_EXPORT.md`: visual QA export workflow for active views,
  selected views, and coordination-focused 3D review images
- `installer/revit-api-docs-mcp/`: TypeScript source and required companion local MCP server for Revit API DLL + XML documentation search
- `installer/lib/`: shared PowerShell helper modules for installer/updater behavior
- `installer/install-self-contained.ps1`: self-contained installer script
- `installer/nas/`: NAS release publishing, workstation updater, and scheduled update bootstrap scripts
- `docs/`: active architecture, runbook, repository structure, usage, and visual QA documentation
- `evals/evals.json`: eval set aligned to the current `send_code_to_revit` contract

## Repository model

Development and production releases both happen from `main` in this repository.
Historical branches in the old repositories are not part of office deployment.
Modernization feature branches are for local build/test work only and must not
publish to the NAS managed release channel.

`src/revit-plugin` is source code. `installer/revit-plugin` is install payload.
When the Revit add-in changes, build the source and refresh the payload binaries
with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Commit the source change and refreshed payload binaries together. See
`docs/REPOSITORY_STRUCTURE.md`, `docs/PLATFORM_ARCHITECTURE.md`, and
`docs/DEVELOPER_RUNBOOK.md`.

## Technical direction

This repo stays self-contained and keeps the live Revit execution contract
explicit:

- `send_code_to_revit` expects code for `Execute(Document document, object[] parameters)`;
  only `document` and `parameters` are guaranteed snippet-scope variables
- the bundled Revit payload is built from the source under `src/revit-plugin`
- the bundled Node wrapper and command payload support `transactionMode`:
  `auto` opens a wrapper-managed transaction, while `none` executes without an
  outer transaction so read-only probes and explicitly controlled snippets can
  avoid nested Revit transactions
- manual Revit `Transaction` snippets submitted with `transactionMode: "auto"`
  are treated as guarded safety blocks, not failed model operations; use
  `transactionMode: "none"` only for explicitly confirmed snippets that manage
  their own transaction
- dynamic C# compilation de-duplicates loaded assembly references by assembly
  name so common libraries such as `Newtonsoft.Json` do not fail when multiple
  versions are loaded in the Revit AppDomain
- the runtime MCP server exposes raw dynamic execution plus read-only context
  primitives for session, active view, elements, and parameter schema
- both MCP packages compile with `strict:true`, keep committed `build/` payloads
  fresh, and reject `@ts-nocheck` in runtime/docs MCP source
- the runtime MCP server also exposes Revit image export tools for visual QA:
  `export_revit_view_image` is read-only for ordinary view/sheet exports and
  uses a temporary sheet for standalone Schedule exports, while
  `export_revit_coordination_image` writes only review view and image export
  settings, never physical model elements; it is an image-artifact tool, not
  the primary tool for live Revit zoom/open/show workflows
- the required docs server resolves class/member signatures before non-trivial snippets are generated, including bulk symbol resolution

## Requirements

- Windows 10 or 11
- Autodesk Revit 2022
- Git for Windows, if you want to pull future updates from this repo
- Node.js 20+; Node 24 is supported by the bundled runtime dependency lock
- Codex Desktop app or another MCP/skill-capable LLM host

Office workstation installs automatically configure the DPE proxy
`http://192.168.90.10:6588` for terminal tools, npm/Git, current-user Windows
internet settings, and WinHTTP where admin rights are available. For a manual
repo-root development setup outside the NAS installer, use the same proxy:

```powershell
[Environment]::SetEnvironmentVariable("HTTP_PROXY", "http://192.168.90.10:6588", "User")
[Environment]::SetEnvironmentVariable("HTTPS_PROXY", "http://192.168.90.10:6588", "User")
[Environment]::SetEnvironmentVariable("ALL_PROXY", "http://192.168.90.10:6588", "User")
[Environment]::SetEnvironmentVariable("NO_PROXY", "localhost,127.0.0.1,::1", "User")
```

## Quick start

For office workstations, prefer the NAS updater in `installer/nas/README.md`.
It installs into the standard machine-wide root:

```text
C:\ProgramData\DPE\RevitMCP
```

For a manual repo-root install, close Revit and run:

```powershell
$RepoRoot = (Resolve-Path .).Path

powershell -ExecutionPolicy Bypass -File "$RepoRoot\installer\install-self-contained.ps1" -RevitVersion 2022

cd C:\ProgramData\DPE\RevitMCP\runtime
npm install --omit=dev --no-audit --no-fund
codex mcp add revit-mcp -- node "C:\ProgramData\DPE\RevitMCP\runtime\build\index.js"

cd "$RepoRoot\installer\revit-api-docs-mcp"
npm install --omit=dev --no-audit --no-fund
powershell -ExecutionPolicy Bypass -File ".\scripts\build-index.ps1" -RevitRoot "C:\Program Files\Autodesk\Revit 2022" -OutputPath "C:\ProgramData\DPE\RevitMCP\state\revit-api-docs\cache\revit-api-docs-2022.json"
codex mcp add revit-api-docs -- node "$RepoRoot\installer\revit-api-docs-mcp\build\index.js"
```

Both MCP servers are required: the runtime server executes code, the docs server resolves the API surface against the locally installed Revit DLLs and XML. The skill assumes both are connected.

## NAS-based office deployment

For multiple office workstations, use `installer/nas/` instead of manually
pulling and reinstalling on every machine.

- GitHub remains the source history.
- The NAS share is the single deployment source workstations read from.
- A normal `git commit` / `git push` does not update the office.
- A release is published only when `publish-nas-release.ps1` is run.
- Office releases are published to the managed release channel after local/manual testing.
- Workstations run `update-from-nas.ps1`, usually through a scheduled task
  installed by `install-updater-task.ps1`; automatic checks run once daily at
  12:00 local time, while manual update/repair remains available from the
  updater UI and command launchers.
- Workstations install under `C:\ProgramData\DPE\RevitMCP`, not under
  `C:\Projects` or user AppData folders.
- Workstation updater logs are retained under the managed updater folder, with
  automatic cleanup keeping the latest 10 `.log` files.
- Workstation updates check npm dependency lockfile markers and the managed
  local npm cache, then skip runtime dependency installation when the installed
  or cached `node_modules` already matches. The docs server dependency junction
  is restored even when its payload fingerprint is unchanged, because the docs
  server is stored inside the managed package folder that is replaced on every
  versioned update.
- Release manifests classify changed surfaces before install. Updater-only
  changes use a fast package/updater refresh path. Runtime MCP server changes
  refresh only the runtime payload and related MCP registration. Revit add-in or
  command payload changes are deferred until Revit is closed. Skill/AGENTS and
  docs-server changes refresh their own payloads without touching Revit files
  when the Revit payload is unchanged.
- If the fast package-only path fails, the updater warns in the log/report and
  falls back to the full repair/install path instead of leaving the workstation
  half-updated.

See `installer/nas/README.md` for the full first-time workflow. For the
developer and code-assistant context needed to continue development from a
fresh clone, see `docs/DEVELOPER_RUNBOOK.md`.

## Multi-instance / multi-port runtime targeting

The bundled runtime MCP server no longer assumes a single Revit socket at
`localhost:8080`.

Every runtime tool accepts these optional target fields:

- `port`: direct Revit socket port, for example `8081`
- `host`: socket host, defaulting to `localhost`
- `target`: registered instance name, a port string such as `8081`, or
  `host:port`

Environment defaults are also supported:

```powershell
$env:REVIT_MCP_PORT = "8080"
$env:REVIT_MCP_PORTS = "8080,8081,8082"
$env:REVIT_MCP_TARGET = "localhost:8080"
```

The runtime also exposes `list_revit_instances`, which scans configured ports
and reports the reachable Revit document, process id, active view, and version.
If present, it also reads `%TEMP%\revit-mcp-instances.json` or the path in
`REVIT_MCP_INSTANCE_REGISTRY`.

The runtime also exposes `get_revit_mcp_status`. It reports the active task,
elapsed time, recent completed/guarded/failed tasks, and service port. Routine
status responses stay compact by default: recent task records are limited to the
latest few items and transport diagnostics are hidden unless explicitly
requested. Full-test/debug checks can request up to 100 recent records.
`guarded` is an expected safety state for blocked operations such as
manual Revit transactions submitted inside the wrapper-managed `auto` mode; it
is not a failed model operation.
Status calls bypass the per-port command lock so Codex can query progress during
a long Revit operation. Every response also includes `runtimeIdentity` with the
active `runtimeVersion`, status `schemaVersion`, `toolSurfaceVersion`,
`processStartedAtUtc`, `buildTimestampUtc`, and `buildHash`, so agents can
detect whether the running runtime matches the deployed build.
Bridge responses also include `resultContractVersion` in the JSON-RPC `result`
payload when the active Revit DLL supports the normalized bridge contract. The
TypeScript runtime decides compatibility per response from that payload, not
from a process-global flag, so mixed old/new Revit instances can remain
connected safely.

The Revit socket protocol uses length-prefixed JSON-RPC frames by default, so
large snippets and parameter payloads are not limited by the old single-read
socket buffer behavior. The add-in still accepts legacy raw JSON requests for
compatibility. The default request frame limit is 16 MB and can be raised, up
to 128 MB, with `REVIT_MCP_MAX_MESSAGE_BYTES` when a workstation explicitly
needs larger payloads.

Recent task records include transport diagnostics: framing mode, request size,
receive time, parse time, execution time, response size, and elapsed time. The
Revit status window stays concise for users and shows only task state, task
name, total Revit-side duration, and request size; detailed transport metrics
are written to the add-in log under
`C:\ProgramData\DPE\RevitMCP\revit-plugin\revit_mcp_plugin\Logs\`.

The runtime performs a status preflight before every non-status Revit command.
If `activeTask` is present, the new command is rejected with a busy message
instead of being sent into Revit. `get_revit_mcp_status` remains the only tool
that may be called while another Revit MCP task is running.

The bundled Revit add-in starts the socket service automatically when Revit
becomes idle after startup. It uses the configured port, then auto-increments
to the next free port up to `+20`, so multiple open Revit processes can listen
on separate ports. The service is stopped during Revit shutdown, which releases
the port. Set `REVIT_MCP_AUTOSTART=0` to disable automatic startup.

While an automation task is running, the add-in shows a `revAgent Status`
window in Revit with the task name, elapsed time, and a warning not to use
Revit until the task finishes. The top-right status area shows the installed
release `Version`, the traceable git `Build`, and whether the workstation is
up to date with the release target; local install time is kept in the tooltip for
support only and is not used as the product version. The window appears in the
Windows taskbar and can be minimized. Completed and failed states are shown
with recent task history and stay visible until the user clicks `OK`. The
window close button is treated as acknowledge/hide after completion; during a
running task it is ignored so closing the status window cannot close or crash
Revit. Recent history uses compact state symbols: `✓` for completed, `!` for
guarded safety blocks, and `✕` for failed tasks. It shows only the total
Revit-side duration plus request size, for example
`17:19:07  ✓  Final metric UI log probe  (2.9s)  [1 MB]`.

Then:

1. Open Revit.
2. If Revit asks about the unsigned add-in publisher, choose `Always Load`.
   This can appear once after a fresh install or DLL update.
3. The MCP socket service starts automatically. The current legacy ribbon
   button label `Revit MCP Switch` is only a manual on/off override for
   revAgent's socket bridge.
4. Click `Settings` in the `mcp-servers-for-revit` ribbon tab if you need to
   enable or review command availability. Treat that tab name as the installed
   add-in manifest identity, not the product name.
5. Run `/skills reload` inside Codex, or restart Codex.

The installer keeps the canonical Codex payload under
`C:\ProgramData\DPE\RevitMCP\codex`. Because Codex currently reads user-profile
skill and `AGENTS.md` locations, the installer may create a junction/hardlink
under `%USERPROFILE%\.codex` as a compatibility integration. Pass
`-SkipCodexUserIntegration` to leave the user profile untouched.
When user-profile integration is enabled, the installer also standardizes the
Codex memory settings in `%USERPROFILE%\.codex\config.toml` without duplicating
existing sections or keys.

## What the installer deploys

The files under `installer/` are source payloads kept in the repo for redistribution.
After install, the same payload is copied into the real system locations below:

- Revit add-in manifest:
  - `C:\ProgramData\Autodesk\Revit\Addins\2022\mcp-servers-for-revit.addin`
- Revit add-in payload:
  - `C:\ProgramData\DPE\RevitMCP\revit-plugin\revit_mcp_plugin\...`
- Dynamic command payload mirror:
  - `C:\ProgramData\DPE\RevitMCP\commands\CommandSet\...`
- Local runtime MCP server bundle:
  - `C:\ProgramData\DPE\RevitMCP\runtime`
- Required docs MCP server:
  - kept under the managed package copy and registered from there by the NAS updater
- Codex skill and workstation role:
  - `C:\ProgramData\DPE\RevitMCP\codex\skills\revit-mcp`
  - `C:\ProgramData\DPE\RevitMCP\codex\AGENTS.md`

Before copying, the installer cleans the known revAgent/RevitMCP install
locations it owns: the exact `mcp-servers-for-revit.addin` manifest, old
`%APPDATA%\Autodesk\Revit\Addins\2022\revit_mcp_plugin`,
old `%LOCALAPPDATA%\revit-mcp-plugin`, the runtime `-ServerTarget`, known
legacy `C:\Projects\...` runtime targets, and stale `revit-mcp.backup-*`
folders under active Codex skills. It also removes old installer-created
`.codex` backup artifacts such
as `AGENTS.md.backup-*`, `config.toml.backup-*`, and the legacy
`.codex\skill-backups` directory. New installs overwrite managed Codex
integration targets directly instead of creating timestamped backups. This
prevents old files from surviving directory/layout changes.
Cleanup is guarded by path checks and does not delete Autodesk Revit program
files, Windows system folders, Revit add-in root folders themselves, or broad
workspace/user directories.

To remove the self-contained install without installing a fresh copy:

```powershell
powershell -ExecutionPolicy Bypass -File "$RepoRoot\installer\install-self-contained.ps1" -RevitVersion 2022 -Uninstall
```

Use `-RemoveAgents` with `-Uninstall` only when you also want to remove the
global and workspace `AGENTS.md` files. If a workstation used an older runtime
directory name, pass it explicitly with `-LegacyServerTargets` so it is cleaned
under the same safety checks.

## Roslyn dependency model

`send_code_to_revit` works through the bundled `RevitMCPCommandSet.dll`, and that DLL is already prebuilt.

End-user installation from this repo does **not** require installing a separate NuGet package.

What the command set depends on:

- `Microsoft.CodeAnalysis.dll`
- `Microsoft.CodeAnalysis.CSharp.dll`
- `System.Collections.Immutable.dll`
- `System.Memory.dll`
- `System.Reflection.Metadata.dll`
- `System.Runtime.CompilerServices.Unsafe.dll`

On a healthy Revit 2022 machine, these assemblies are normally present under the local Autodesk/Revit installation, commonly under either `C:\Program Files\Autodesk\Revit 2022\...` or `C:\Program Files\Autodesk\AECGenerativeDesign 2022\RestDynamoCore\...`.

The installer now verifies that Revit 2022 provides these files and mirrors them next to `RevitMCPCommandSet.dll` in the deployed command folders.

If a target machine throws a missing `Microsoft.CodeAnalysis` or similar runtime error after the installer checks those Autodesk paths, treat that as a machine/install problem, not as a step where the end user should run NuGet.

NuGet is only relevant if you are rebuilding `RevitMCPCommandSet.dll` from source in a separate development project.

## Clean machine checklist

Use this order on a fresh machine. In the office, the preferred path is to
double-click the NAS updater:

```text
\\dpe-nas\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\tools\Install-Revit-MCP-Updater.cmd
```

Manual repo-root install:

1. Install the prerequisites:
   - Autodesk Revit 2022
   - Git for Windows
   - Node.js 20+; Node 24 is supported by the bundled dependency lock
   - Codex Desktop app or another MCP/skill-capable LLM host
2. Clone or download this repo.
3. Close Revit.
4. Capture the repo root and run the installer:

```powershell
$RepoRoot = (Resolve-Path .).Path
powershell -ExecutionPolicy Bypass -File "$RepoRoot\installer\install-self-contained.ps1" -RevitVersion 2022
```

5. Install Node dependencies in the deployed runtime server target:

```powershell
cd C:\ProgramData\DPE\RevitMCP\runtime
npm install --omit=dev --no-audit --no-fund
```

6. Register the runtime MCP server in Codex:

```powershell
codex mcp add revit-mcp -- node "C:\ProgramData\DPE\RevitMCP\runtime\build\index.js"
```

7. Install and register the required docs MCP server:

```powershell
cd "$RepoRoot\installer\revit-api-docs-mcp"
npm install --omit=dev --no-audit --no-fund
powershell -ExecutionPolicy Bypass -File ".\scripts\build-index.ps1" -RevitRoot "C:\Program Files\Autodesk\Revit 2022" -OutputPath "C:\ProgramData\DPE\RevitMCP\state\revit-api-docs\cache\revit-api-docs-2022.json"
codex mcp add revit-api-docs -- node "$RepoRoot\installer\revit-api-docs-mcp\build\index.js"
```

8. Reload Codex skills:

```text
/skills reload
```

The installer already installs the machine-level Codex payload under
`C:\ProgramData\DPE\RevitMCP\codex` and creates user-profile integration unless
`-SkipCodexUserIntegration` is passed.

## Local build and smoke tests

Run the local no-deploy checks before publishing a release:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1

cd .\installer\runtime-mcp-server
npm install --no-audit --no-fund
npm run test

cd ..\revit-api-docs-mcp
npm install --no-audit --no-fund
npm run test
```

Use `scripts\test-all.ps1` to run the non-Revit checks in one command. It
includes installer smoke, usage intelligence, live dashboard helpers,
`@ts-nocheck` policy enforcement, both MCP package test suites, and committed
MCP/Revit payload freshness checks. Revit payload freshness is manifest-based,
so ordinary checkout or merge mtimes do not force a payload refresh.
The runtime MCP test suite includes bridge result contract characterization
checks for dynamic-result double encoding, central C# camelCase response
helpers, `resultContractVersion`, and idempotent legacy normalization.

The protected `main` branch also runs the GitHub Actions `Engineering gates`
job on pull requests and pushes to `main`. Normal development should happen on
a topic branch, then merge through a pull request after the required
`Engineering gates` check is green. A green commit or pull request still does
not deploy to the office NAS; deployment changes only when the NAS publish
script is run intentionally.

When the shared bridge command payload changes and Revit 2022 is available, run the
optional live commandset gate separately:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-commandset-live.ps1
```

This live gate connects to the Revit MCP socket, performs a status preflight
before each non-status command, and validates `transactionMode` behavior,
guarded manual-transaction handling, manual rollback in `none`, and
`Newtonsoft.Json.JsonConvert` dynamic compilation. For bridge result contract
changes, also confirm dynamic object results are not returned as double-encoded
strings, native bridge responses use camelCase `success`, and
`resultContractVersion` is readable from the response payload. It is not included in
`scripts\test-all.ps1` because it requires a running Revit session with an
active document.

9. Open Revit and enable the bundled commands from the `mcp-servers-for-revit` ribbon `Settings` button.
10. Verify that both MCP servers are registered:

```powershell
codex mcp list
```

Expected MCP servers:

- `revit-mcp`
- `revit-api-docs`

11. If the installer stops with a Roslyn runtime error, repair the Revit 2022 installation first. Do not try to fix a normal end-user install by adding NuGet packages into the deployed bundle.

Expected bundled runtime commands: 26 tools registered by the runtime server.

- `list_revit_instances`
- `get_revit_mcp_status`
- `send_code_to_revit`
- `send_code_to_revit_safe`
- `get_revit_session_context`
- `get_active_view_context`
- `list_open_views`
- `activate_view`
- `close_view`
- `get_ui_state`
- `find_elements`
- `open_existing_plan_for_element_level`
- `focus_elements`
- `section_box_elements`
- `create_3d_view_for_elements`
- `export_revit_view_image`
- `export_revit_coordination_image`
- `show_element_in_plan_and_3d`
- `smart_focus_elements`
- `inspect_elements`
- `inspect_sheet_text`
- `inspect_schedules`
- `inspect_parameter_schema`
- `set_element_parameter`
- `set_schedule_cells`
- `set_schedule_cells_by_text`

Expected bundled docs commands:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

## Required companion: Revit API docs server

This repo includes a second MCP server that reads the installed Revit API assemblies and XML doc files directly from the local Revit installation. It is kept as a separate process so the live Revit tool surface stays minimal, but the skill **depends on it** - it is the authoritative source for class and member signatures that the snippet generation step relies on.

Install it after the runtime server (Quick start already shows this step):

```powershell
$RepoRoot = (Resolve-Path .).Path
cd "$RepoRoot\installer\revit-api-docs-mcp"
npm install --omit=dev --no-audit --no-fund
powershell -ExecutionPolicy Bypass -File ".\scripts\build-index.ps1" -RevitRoot "C:\Program Files\Autodesk\Revit 2022" -OutputPath "C:\ProgramData\DPE\RevitMCP\state\revit-api-docs\cache\revit-api-docs-2022.json"
codex mcp add revit-api-docs -- node "$RepoRoot\installer\revit-api-docs-mcp\build\index.js"
```

On first query, the docs server builds a local cache from the installed `RevitAPI*.dll` and matching `RevitAPI*.xml` files under the Revit install folder.
`get_member_details` also resolves common Revit C# convenience aliases such as
`Element.get_Parameter(...)` to the XML-doc member that Autodesk exposes as the
`Element.Parameter` property.

Default cache path:

- `C:\ProgramData\DPE\RevitMCP\state\revit-api-docs\cache`

Bundled docs tools:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

## Repo layout

```text
revit-mcp-skill/
|-- README.md
|-- SKILL.md
|-- AGENTS.md
|-- CHANGELOG.md
|-- config/
|   |-- dynamic-tool-promotion-registry.json
|   |-- dynamic-tool-promotion-rules.json
|   `-- revit-versions.json
|-- docs/
|   |-- ADR-0001-UPDATER-DOTNET-HELPER.md
|   |-- DEVELOPER_RUNBOOK.md
|   |-- PLATFORM_ARCHITECTURE.md
|   |-- REPOSITORY_STRUCTURE.md
|   |-- REVAGENT_USAGE_INTELLIGENCE.md
|   `-- REVIT_IMAGE_EXPORT.md
|-- dashboard/
|   |-- server.mjs
|   |-- smoke-test.mjs
|   `-- public/
|-- references/
|   |-- parameters.md
|   |-- units.md
|   |-- system-classification.md
|   |-- collectors.md
|   |-- linked-models.md
|   `-- patterns/
|       |-- boq-duct.cs
|       |-- boq-pipe.cs
|       |-- segment-friction-loss-duct.cs
|       `-- diffuser-count.cs
|-- evals/
|   `-- evals.json
|-- scripts/
|   |-- build-revit-plugin.ps1
|   |-- test-mcp-build-payload-freshness.ps1
|   |-- test-typescript-nocheck-policy.ps1
|   |-- test-all.ps1
|   `-- test-installer-smoke.ps1
|-- src/
|   `-- revit-plugin/
`-- installer/
    |-- INSTALLATION.md
    |-- install-self-contained.ps1
    |-- lib/
    |-- nas/
    |-- revit-api-docs-mcp/
    |-- revit-plugin/
    |   |-- mcp-servers-for-revit.addin
    |   `-- revit_mcp_plugin/
    |-- command-payload/
    `-- runtime-mcp-server/
```

## Refreshing an existing install

When a new version of the skill lands in this repo, run the refresh script. It detects how the skill was previously installed (git clone, symlink, or plain copy) under each known host location and updates each install with the matching strategy (`git pull` for clones, no-op for symlinks, wipe + resync for copies).

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\refresh-skill.ps1
```

Useful flags:

- `-RepoRoot <path>` - point at a specific local clone (defaults to the parent of the script).
- `-ExtraPaths <path1,path2>` - add project-level installs, e.g. `<project>\.claude\skills\revit-mcp`.
- `-NoConfirm` - skip per-target prompts (for unattended runs).

After the script finishes:

- Codex Desktop: run `/skills reload`.
- Claude Code: start a new session.
- Cursor: restart Cursor.

## Host compatibility

The office installation flow registers MCP servers through the current user's installed Codex Desktop command on Windows, with a direct `config.toml` update fallback when that command helper is missing. It also writes the standard Codex memory configuration idempotently under `%USERPROFILE%\.codex\config.toml`. The skill itself is host-agnostic: any MCP/skill-capable LLM host can use it if both MCP servers are registered:

- `revit-mcp` for live Revit execution and inspection
- `revit-api-docs` for required API class/member lookup

Host-specific notes:

- **Claude Code**: copy the repo root into `~/.claude/skills/revit-mcp/` and register both MCP servers with `claude mcp add`. The `send_code_to_revit` tool will surface as `mcp__revit-mcp__send_code_to_revit`.
- **Cursor**: place the repo under your skills/rules location and register both MCP servers in Cursor's MCP settings.
- **Codex Desktop**: see the Quick start section above.

`SKILL.md` does not hardcode any host-specific tool name.

## Bundled runtime tool surface

The runtime MCP server registers 26 tools in
`installer/runtime-mcp-server/src/tools/register.ts`. They intentionally cover a
small production surface instead of many narrow one-off commands.

| Area | Tools | Write behavior and use |
| --- | --- | --- |
| Instance and status | `list_revit_instances`, `get_revit_mcp_status` | Read-only. `get_revit_mcp_status` is the only runtime tool intended to run while another Revit task is active. |
| Dynamic execution | `send_code_to_revit`, `send_code_to_revit_safe` | Raw `send_code_to_revit` can write if the supplied C# writes. `transactionMode: "auto"` opens a wrapper-managed transaction and guards manual transaction snippets; `transactionMode: "none"` executes without an outer transaction. `send_code_to_revit_safe` is for read/preview work, rejects write-looking snippets, and uses `none`. |
| Model context | `get_revit_session_context`, `get_active_view_context`, `inspect_elements`, `inspect_sheet_text`, `inspect_schedules`, `inspect_parameter_schema` | Read-only model/session/element/sheet/schedule/parameter inspection before engineering decisions or writes. `get_active_view_context` reports both sheet `viewports` and `scheduleSheetInstances`. `inspect_sheet_text` is the bounded DrawingSheet text-note and placed-schedule inventory path for large projects and should be used instead of broad custom C# sheet scans. `inspect_schedules` is the bounded schedule name/cell inspection path for large projects and should be used instead of broad custom C# schedule scans. |
| Controlled data writes | `set_element_parameter`, `set_schedule_cells`, `set_schedule_cells_by_text` | `set_element_parameter` is the production-safe single-parameter set/clear path. It defaults to `mode="dryRun"` and `operation="set"`, performs exact `inspect_parameter_schema`-style identity resolution, blocks duplicate display names/read-only parameters/type writes without explicit approval, commits only with `mode="commit"`, and verifies the value by reading it back. `operation="clear"` attempts Revit `Parameter.ClearValue` for a true no-value state and reports `clear_value_not_supported` instead of faking clear with an empty string when Revit does not support it. `set_schedule_cells` writes exact schedule cells only by `scheduleId`, `section`, `row`, and `column`; it defaults to dry-run, can require `expectedCurrentText`, guards non-writable standard schedule body cells as `non_writable_standard_body_cell`, commits through the wrapper transaction, and verifies committed cell text. `set_schedule_cells_by_text` is the higher-level schedule workflow for bounded sheet/schedule scope plus row-text matching; it blocks ambiguous matches by default, supports `expectedCurrentText`, defaults to dry-run, guards the same standard body-cell restriction, and verifies commit readback. |
| Live view navigation | `list_open_views`, `activate_view`, `close_view`, `get_ui_state`, `find_elements`, `open_existing_plan_for_element_level`, `focus_elements`, `show_element_in_plan_and_3d`, `smart_focus_elements` | UI/navigation and discovery helpers. They do not create physical MEP elements. |
| View-data writes | `section_box_elements`, `create_3d_view_for_elements` | Can modify project view data by applying section boxes or creating/reusing 3D review views. Use explicit intent and verify afterward. |
| Image artifacts | `export_revit_view_image`, `export_revit_coordination_image` | `export_revit_view_image` supports active/requested views, DrawingSheet export, and direct Schedule export through a temporary sheet that is deleted before the wrapper transaction commits. Ordinary view/sheet exports are read-only. `export_revit_coordination_image` writes only review view settings and image export settings, never ducts, pipes, fittings, terminals, or other physical model elements; if requested `elementIds` are all missing it returns guarded `no_requested_elements_found` unless `allowFullViewFallback=true` is explicit. `cleanupAfterExport=true` deletes a review view created by that export after the image file is produced. It can still leave Revit's document dirty flag set because temporary review view data was created/deleted inside a transaction. |

The Revit add-in command payload still provides the low-level dynamic execution
bridge internally. Common discovery, UI focus, plan/3D view workflow, parameter
inspection, and visual QA paths are exposed as dedicated runtime tools so most
production tasks can be audited before any broad custom C# write is used.
The bridge result boundary is intentionally small: Revit DLL payloads emit
canonical camelCase result objects with `resultContractVersion`, while the
TypeScript normalizer keeps a legacy path for older DLLs and raw dynamic
snippet payloads.

Runtime commands perform a lightweight internal `mcp_status` preflight before sending non-status work to Revit and fail fast when another task is active. Agent workflows should still call `get_revit_mcp_status` explicitly before each Revit operation so the user can see what is running and why a command is being delayed.

Tool intent is intentionally split. Live "show/open/zoom/select in Revit"
requests should use `focus_elements`, `smart_focus_elements`,
`create_3d_view_for_elements`, or `show_element_in_plan_and_3d`. Image
artifact requests such as PNG/JPEG/report/LLM evidence should use
`export_revit_view_image` for raw view/sheet evidence or
`export_revit_coordination_image` for element-specific evidence. Do not use
`export_revit_coordination_image` as the primary tool for live Revit view
navigation; navigate/focus first, then optionally export the active view.
When element ids are supplied for evidence, an all-missing target set is
guarded by default; request `allowFullViewFallback=true` only for deliberate
full-view context exports.

`find_elements` is discovery-only. Treat its compact response as insufficient
for writes until `inspect_elements` and `inspect_parameter_schema` have
confirmed the exact element and stable parameter identity. Use
`set_element_parameter` for ordinary parameter writes. It may accept a visible
parameter name as the user's target, but it enumerates the schema first and
will not write through a direct display-name shortcut; duplicate display names
are blocked. Use `builtInParameterId` when available and `expectedCurrentRaw`
for compare-and-set safety. When the intent is to restore a true no-value
state, use `operation="clear"`; writing `value=""` only makes the visible value
empty and may leave Revit `HasValue=true`.

For sheet text work, use `inspect_sheet_text` before raw dynamic code. It
performs read-only bounded DrawingSheet text-note search and placed schedule
inventory. Start with `sheetQuery` or exact `sheetIds`; enable
`scanScheduleCells` only when the target text may be inside placed schedules.

For schedule work, use `inspect_schedules` before raw dynamic code. It performs
read-only bounded schedule discovery and cell inspection with `nameQuery`,
`cellQuery`, `scheduleIds`, section selection, and row/column limits. In large
projects, avoid broad cell scans without `nameQuery` or explicit `scheduleIds`.
For schedule text edits, use `set_schedule_cells` after exact row/column targets
are known. When the work starts from a visible row label or sheet/schedule text
search, use `set_schedule_cells_by_text`: bound it with `sheetQuery`,
`sheetIds`, `scheduleNameQuery`, or `scheduleIds`, provide row text terms, review
the dry-run matches, then commit only after ambiguity and current text checks are
clear. Raw dynamic C# schedule loops are a fallback for unsupported cases, not
the normal production path. Standard schedule body cells are not directly
writable through Revit `SetCellText`; the schedule write tools should guard
them as `non_writable_standard_body_cell` before commit.

This runtime set is reflected in the Node MCP wrapper. The installer still copies the bundled Revit command payload required by the wrapper.

The required docs server is separate and exposes its own API lookup tools:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

Together, these tools define the current production runtime surface: live Revit
execution, session/context discovery, view navigation, focused visual QA,
parameter inspection, schedule-cell editing, and safe custom-code workflows.

## revAgent usage intelligence

The runtime MCP server records silent telemetry events so real office usage can
drive product and production decisions. The first layer records runtime session
starts, top-level MCP tool calls, Revit bridge command calls, dynamic C#
execution summaries, timing, success/guarded/failure state, parameter shapes,
bounded text values, and dynamic-code previews. High-frequency
`get_revit_mcp_status` polling is skipped by default.

Each useful tool/command also emits a higher-level `production.context` event
without sending an extra Revit request. It extracts the assistant's `taskName`,
query/intent, project title/path, active view, level/room/space when available,
target/selection ids, categories, discipline hint, generated files, duration,
and result state. This gives the future dashboard/master-LLM layer a production
timeline that can be grouped by worker, machine, project, view, level, room,
discipline, tool, and outcome.

Telemetry is intentionally quiet but not over-redacted: this is an
office-internal signal stream, so useful task names, search text, paths, and
bounded code previews are retained for later dashboard and LLM analysis. It
still avoids full Revit response payloads, model geometry dumps, and exported
images.

Local events are written under
`C:\ProgramData\DPE\RevitMCP\state\telemetry\events`. When workstation updater
configuration contains `reportsRoot`, best-effort NAS copies are also written
under `reports\events`. Telemetry failures are swallowed and must not affect
Revit work. See `docs/REVAGENT_USAGE_INTELLIGENCE.md` for schema and controls.

For the live dashboard, the runtime also writes a non-blocking UI feed under
`reports\live\machines\<machine>`. `status.json` is the fast 2-5 second polling
surface with the active task, recent activity, and the latest Revit add-in
`mcp_status.recentTasks` snapshot, while `activity\YYYY-MM-DD.ndjson` records
started/completed/guarded/failed live activity lines. Live writes are
fire-and-forget with a bounded in-flight limit; slow or unavailable NAS writes
are dropped instead of delaying Revit work.

The read-only live dashboard can be started on the coordinator workstation with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-live-dashboard.ps1
```

It serves `http://127.0.0.1:8765`, reads only `reports\machines`,
`reports\live`, `reports\summaries`, and the stable channel manifest, and
refreshes the browser every 3 seconds. The coordinator dashboard may also be
published through the office Cloudflare Tunnel as
`https://dashboard.revagent.app`, forwarding only this read-only local HTTP
surface. Put Cloudflare Access or an equivalent access policy in front of it
before sharing it beyond trusted office users.

The browser UI is designed for desktop and iPhone Safari/Chrome. It shows a
left-side Machine Status Windows list, a right-side All Status Activity stream
with all/one/multiple-machine filters, and System/Light/Dark theme selection.
Machine cards keep independent state badges instead of one combined label:
connection is `Online`, `Stale`, or `Offline`; version is `Up to date`,
`Outdated`, or `Unknown`; task state is `Running` or `Idle`; update exceptions
are shown only as `Update failed` or `Pending restart`.

Connection freshness is calculated from the live heartbeat: `Online` is within
`staleSeconds` (default 60 seconds), `Stale` is older but still within
`offlineSeconds` (default 300 seconds), and `Offline` means no live file or an
older heartbeat. Recent task rows prefer the Revit add-in status history when
available, so result state, duration, payload size, and ordering match the
local revAgent status window. All Status Activity shows the latest 50 selected
live records by default and can be expanded to 200 records from the page. The
activity scroll position is preserved during refresh while the user is reading
older rows. It never sends Revit commands, writes telemetry, or changes NAS
release state.

The dashboard polling surface is production-bounded: `/api/overview` returns
only the compact fields needed by the UI, daily live activity reads are tail
limited, browser refreshes do not overlap and time out, and raw dynamic-code
payload details stay in durable telemetry/summary artifacts instead of being
sent to the dashboard every few seconds.
The dashboard API still exposes compact live metrics for LLM handoff and
diagnostics, but the browser UI intentionally keeps the main monitoring page
focused on machine state and status activity.

The dashboard also exposes a read-only LLM handoff at `/api/brief`. If a
workstation was offline from NAS while still writing local live files, run
`scripts\publish-live-backfill.ps1` on that workstation to merge its local
live status/activity files back into `reports\live`. Use
`scripts\test-live-dashboard.ps1` for the non-Revit dashboard regression check.

The first reader layer is `scripts/summarize-usage-intelligence.ps1`. It reads
`reports\machines` plus one UTC day of `reports\events` and emits
`revagent.usage.summary.v1` JSON with machine health, tool usage, project and
discipline rollups, guarded/failed/slow operation samples, generated-output
counts, and dynamic-code pattern summaries for dashboard and master-LLM review.
`scripts/publish-usage-summary.ps1` publishes that summary under
`reports\summaries\daily` and refreshes `reports\summaries\latest.json` plus a
short Markdown support view.
Install `scripts/install-usage-summary-task.ps1` on exactly one coordinator
workstation to run the publisher daily. The scheduled publisher uses
`reports\summaries\publish.lock` and writes logs under `reports\summaries\logs`.

## Why `send_code_to_revit` remains available

Dedicated runtime tools are the default path for known production workflows:
status/context checks, sheet and schedule inspection, schedule-cell writes,
element parameter writes, live navigation, and image export. Agents should check
for a dedicated tool before falling back to raw dynamic code.

`send_code_to_revit` remains the broad-control escape hatch for unsupported
cases that still need Revit API flexibility, such as linked model lookup, room
matching, nearest-room fallback, custom filters, unusual type/instance parameter
fallbacks, bulk exports, or CSV/XLSX output preparation.

When raw execution is needed, the agent should state the missing capability,
verify non-trivial API symbols through `revit-api-docs`, keep the snippet small,
use `send_code_to_revit_safe` for read-only probes and previews, and promote
repeated raw-code patterns into native runtime tools.

## Skill maintenance direction

`SKILL.md` and `AGENTS.md` should strongly document:

- call `get_revit_mcp_status` before every non-status Revit MCP runtime task
- use dedicated runtime tools before raw dynamic code
- use `inspect_sheet_text`, `inspect_schedules`, `set_schedule_cells`,
  `set_schedule_cells_by_text`, and `set_element_parameter` for their covered
  workflows
- use `resolve_api_symbols_bulk` before non-trivial raw snippets
- use `send_code_to_revit_safe` for read-only probes and previews
- keep raw `send_code_to_revit` as the explicit broad-control escape hatch
- promote repeated raw-code patterns into native runtime tools
- keep visual QA, export, usage intelligence, and deployment guidance aligned
  with the current runtime surface

## Installer note

The self-contained installer also copies the `command-payload` payload so the shared bridge command set works after a clean install without manual DLL repair steps.

It now also mirrors the required Roslyn runtime assemblies from the local Revit 2022 installation into the deployed command folders, and it fails early if those files are missing.

The copied command manifests are kept in sync with the bundled Revit low-level commands required by the Node runtime tools.

The docs server remains under `installer\revit-api-docs-mcp`; register it as a required companion MCP server after running the installer.

## Note

This repo remains self-contained for distribution. The Revit plugin payload, runtime MCP server build, and docs MCP server are vendored here.

Node dependencies still need to be installed on the target machine with:

```powershell
npm install --omit=dev --no-audit --no-fund
```

The bundled runtime server pins `better-sqlite3` to a Node 24-compatible
version so clean Windows installs do not need Python or Visual Studio Build
Tools just to compile that native dependency.
