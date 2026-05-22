# Revit MCP Skill Package - Production Monorepo

This repo packages the Revit MCP skill, Revit add-in source and payload,
bundled local runtime MCP server, required companion Revit API docs MCP server,
installer, NAS updater, and deployment documentation in one place.

It is the single canonical source for production office deployment.

## What this repo provides

- `SKILL.md`: host-agnostic skill instructions for Revit MEP work
- `AGENTS.md`: workstation-wide coordination rules copied during install
- `src/revit-plugin/`: Revit add-in source code
- `config/revit-versions.json`: central Revit version matrix and payload gate
- `scripts/build-revit-plugin.ps1`: builds the add-in source and refreshes the installer payload binaries
- `installer/revit-plugin/`: bundled Revit add-in payload
- `installer/command-payload/`: command set DLL and manifest backup
- `installer/runtime-mcp-server/`: TypeScript source and bundled local runtime MCP server build for live Revit execution
- `docs/REVIT_IMAGE_EXPORT.md`: visual QA export workflow for active views,
  selected views, and coordination-focused 3D review images
- `installer/revit-api-docs-mcp/`: TypeScript source and required companion local MCP server for Revit API DLL + XML documentation search
- `installer/lib/`: shared PowerShell helper modules for installer/updater behavior
- `installer/install-self-contained.ps1`: self-contained installer script
- `installer/nas/`: NAS release publishing, workstation updater, and scheduled update bootstrap scripts
- `docs/`: repository structure and migration notes
- `evals/evals.json`: eval set aligned to the current `send_code_to_revit` contract

## Repository model

Development and production releases both happen from `main` in this repository.
Historical branches in the old repositories are not part of office deployment.
Modernization feature branches are for local build/test work only and must not
publish to the NAS stable channel.

`src/revit-plugin` is source code. `installer/revit-plugin` is install payload.
When the Revit add-in changes, build the source and refresh the payload binaries
with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

Commit the source change and refreshed payload binaries together. See
`docs/REPOSITORY_STRUCTURE.md`, `docs/MONOREPO_MIGRATION.md`, and
`docs/DEVELOPER_RUNBOOK.md`.

## Technical direction

This repo stays self-contained and keeps the live Revit execution contract
explicit:

- `send_code_to_revit` expects code for `Execute(Document document, object[] parameters)`
- the bundled Revit payload is built from the source under `src/revit-plugin`
- the bundled Node wrapper forwards `transactionMode`, but the tested plugin
  build still manages write transactions itself; snippets should not open
  their own `Transaction.Start()` unless that exact installed build has been
  verified
- the runtime MCP server exposes raw dynamic execution plus read-only context
  primitives for session, active view, elements, and parameter schema
- the runtime MCP server also exposes Revit image export tools for visual QA:
  `export_revit_view_image` is read-only, while
  `export_revit_coordination_image` writes only a reusable review view and
  image export settings, never physical model elements
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
- Office releases are published to the stable channel after local/manual testing.
- Workstations run `update-from-nas.ps1`, usually through a scheduled task
  installed by `install-updater-task.ps1`.
- Workstations install under `C:\ProgramData\DPE\RevitMCP`, not under
  `C:\Projects` or user AppData folders.

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
elapsed time, recent completed/failed tasks, and service port. Status calls
bypass the per-port command lock so Codex can query progress during a long
Revit operation.

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

While a Revit MCP command is running, the add-in shows a small topmost status
window in Revit with the task name, elapsed time, and a warning not to use
Revit until the task finishes. Completed and failed states are shown briefly
with recent task history and stay visible until the user clicks `OK`. The
window close button is treated as acknowledge/hide after completion; during a
running task it is ignored so closing the status window cannot close or crash
Revit. Recent history uses compact state symbols (`✓` for completed, `✕` for
failed) and shows only the total Revit-side duration plus request size, for
example `17:19:07  ✓  Final metric UI log probe  (2.9s)  [1 MB]`.

Then:

1. Open Revit.
2. If Revit asks about the unsigned add-in publisher, choose `Always Load`.
   This can appear once after a fresh install or DLL update.
3. The MCP socket service starts automatically; the `Revit MCP Switch` button is
   only a manual on/off override.
4. Click `Settings` in the `mcp-servers-for-revit` ribbon tab if you need to
   enable or review command availability.
5. Run `/skills reload` inside Codex, or restart Codex.

The installer keeps the canonical Codex payload under
`C:\ProgramData\DPE\RevitMCP\codex`. Because Codex currently reads user-profile
skill and `AGENTS.md` locations, the installer may create a junction/hardlink
under `%USERPROFILE%\.codex` as a compatibility integration. Pass
`-SkipCodexUserIntegration` to leave the user profile untouched.

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

Before copying, the installer cleans the known Revit MCP install locations it
owns: the Revit MCP add-in manifest, old `%APPDATA%\Autodesk\Revit\Addins\2022\revit_mcp_plugin`,
old `%LOCALAPPDATA%\revit-mcp-plugin`, the runtime `-ServerTarget`, known
legacy `C:\Projects\...` runtime targets, and stale `revit-mcp.backup-*` folders under active Codex
skills. This prevents old files from surviving directory/layout changes.
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

Use `scripts\test-all.ps1` to run the non-Revit checks in one command.

9. Open Revit and enable the bundled commands from the `mcp-servers-for-revit` ribbon `Settings` button.
10. Verify that both MCP servers are registered:

```powershell
codex mcp list
```

Expected MCP servers:

- `revit-mcp`
- `revit-api-docs`

11. If the installer stops with a Roslyn runtime error, repair the Revit 2022 installation first. Do not try to fix a normal end-user install by adding NuGet packages into the deployed bundle.

Expected bundled runtime commands:

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
- `inspect_parameter_schema`

Expected bundled docs commands:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

## Required companion: Revit API docs server

This repo includes a second MCP server that reads the installed Revit API assemblies and XML doc files directly from the local Revit installation. It is kept as a separate process so the live Revit tool surface stays minimal, but the skill **depends on it** — it is the authoritative source for class and member signatures that the snippet generation step relies on.

Install it after the runtime server (Quick start already shows this step):

```powershell
$RepoRoot = (Resolve-Path .).Path
cd "$RepoRoot\installer\revit-api-docs-mcp"
npm install --omit=dev --no-audit --no-fund
powershell -ExecutionPolicy Bypass -File ".\scripts\build-index.ps1" -RevitRoot "C:\Program Files\Autodesk\Revit 2022" -OutputPath "C:\ProgramData\DPE\RevitMCP\state\revit-api-docs\cache\revit-api-docs-2022.json"
codex mcp add revit-api-docs -- node "$RepoRoot\installer\revit-api-docs-mcp\build\index.js"
```

On first query, the docs server builds a local cache from the installed `RevitAPI*.dll` and matching `RevitAPI*.xml` files under the Revit install folder.

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
`-- installer/
    |-- INSTALLATION.md
    |-- install-self-contained.ps1
    |-- revit-api-docs-mcp/
    |-- revit-plugin/
    |   |-- mcp-servers-for-revit.addin
    |   `-- revit_mcp_plugin/
    |-- command-payload/
    `-- runtime-mcp-server/
```

## Refreshing an existing install

When a new version of the skill lands in this repo, run the refresh script. It detects how the skill was previously installed (git clone, symlink, or plain copy) under each known host location and updates each install with the matching strategy (`git pull` for clones, no-op for symlinks, backup + resync for copies).

```powershell
powershell -ExecutionPolicy Bypass -File .\installer\refresh-skill.ps1
```

Useful flags:

- `-RepoRoot <path>` — point at a specific local clone (defaults to the parent of the script).
- `-ExtraPaths <path1,path2>` — add project-level installs, e.g. `<project>\.claude\skills\revit-mcp`.
- `-NoConfirm` — skip per-target prompts (for unattended runs).

After the script finishes:

- Codex Desktop: run `/skills reload`.
- Claude Code: start a new session.
- Cursor: restart Cursor.

## Host compatibility

The office installation flow registers MCP servers through the current user's installed Codex Desktop command on Windows, with a direct `config.toml` update fallback when that command helper is missing. The skill itself is host-agnostic: any MCP/skill-capable LLM host can use it if both MCP servers are registered:

- `revit-mcp` for live Revit execution and inspection
- `revit-api-docs` for required API class/member lookup

Host-specific notes:

- **Claude Code**: copy the repo root into `~/.claude/skills/revit-mcp/` and register both MCP servers with `claude mcp add`. The `send_code_to_revit` tool will surface as `mcp__revit-mcp__send_code_to_revit`.
- **Cursor**: place the repo under your skills/rules location and register both MCP servers in Cursor's MCP settings.
- **Codex Desktop**: see the Quick start section above.

`SKILL.md` does not hardcode any host-specific tool name.

## Bundled runtime tool surface

The runtime MCP server intentionally exposes raw dynamic execution plus a small set of high-value context primitives:

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
- `inspect_parameter_schema`

The Revit add-in command payload still provides the low-level `send_code_to_revit` and selection commands internally. UI view operations are exposed separately through `list_open_views`, `activate_view`, `close_view`, `get_ui_state`, `find_elements`, `open_existing_plan_for_element_level`, and `focus_elements` so common discovery and view-focus workflows do not need dynamic C# snippets. `find_elements` returns match score, confidence, fields, and ambiguity hints so large projects with many same-named elements can be narrowed before writes. `focus_elements` now checks visibility in the active/requested view before calling Revit `ShowElements`; by default it fails with a suggested existing plan instead of triggering Revit's modal closed-view search dialog. `open_existing_plan_for_element_level` supports explicit `planMode`: `elementLevel` opens an existing plan on the element's level, while `activePlan` keeps the current active plan and reports any level mismatch. If `activePlan` is used on a plan whose level does not match the element level, the command returns `Success: false`, `FocusBlocked: true`, `FocusBlockReason: "elementLevelDoesNotMatchPlanView"`, and a `SuggestedView` instead of calling `ShowElements` and opening Revit's closed-view search prompt. `section_box_elements` and `create_3d_view_for_elements` are also exposed as dedicated UI/view commands because applying or clearing a 3D section box and creating a view are project-data writes that need explicit Revit transactions and verification. `export_revit_view_image` exports the active/requested Revit view without model writes, and `export_revit_coordination_image` creates or updates only a review view before exporting a focused visual QA image. `focus_elements`, `open_existing_plan_for_element_level`, and `create_3d_view_for_elements` report their UI zoom method, support optional `fitToScreen` through Revit `UIView.ZoomToFit`, and separate per-element `HasBoundingBox` from operation-level `BoundingBox` so automation can tell whether a section-box/focus box was computed or Revit UI focus was used. Plan opening responses identify whether the active view was changed to an existing same-level plan, and 3D view creation responses report section box confirmation and view-name conflict resolution. `create_3d_view_for_elements` can also set a simple 3D camera orientation with framing padding without turning on section box. The wrapper-only `show_element_in_plan_and_3d` tool composes safe search, existing-plan focus, and optional 3D focus into one workflow; by default it rejects ambiguous search results instead of guessing. The wrapper-only `smart_focus_elements` tool first tries the active/requested view without modal search, then can fall back to an existing same-level plan and optional 3D view.

Runtime commands perform a lightweight internal `mcp_status` preflight before sending non-status work to Revit and fail fast when another task is active. Agent workflows should still call `get_revit_mcp_status` explicitly before each Revit operation so the user can see what is running and why a command is being delayed.

This runtime set is reflected in the Node MCP wrapper. The installer still copies the bundled Revit command payload required by the wrapper.

The required docs server is separate and exposes its own API lookup tools:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

Together, these tools define the current production runtime surface: live Revit
execution, session/context discovery, view navigation, focused visual QA,
parameter inspection, and safe custom-code workflows.

## Why `send_code_to_revit` stays primary

Real Revit tasks usually need:

- linked model lookup
- room matching
- nearest room fallback
- custom filtering
- type/instance parameter fallback
- bulk export
- CSV/XLSX output safety

In practice, one strong custom-code tool performs better than a large set of narrow tools.

That is why `send_code_to_revit` should remain the first-class runtime tool in both the MCP setup and the skill.

## Skill update direction

`SKILL.md` should strongly document:

- call `get_revit_session_context` first for non-trivial tasks
- use `resolve_api_symbols_bulk` before non-trivial snippets to confirm exact API signatures
- use `send_code_to_revit_safe` for read-only probes and previews
- keep raw `send_code_to_revit` as the explicit broad-control escape hatch
- linked model and room matching workflow
- parameter lookup order
- bulk-query performance patterns
- export and Excel safety rules
- `Mark` + `ElementId` + `Unique_Mark` identity strategy
- single-element -> small sample -> full export debug flow

## Installer note

The self-contained installer also copies the `command-payload` payload so dynamic code execution works after a clean install without manual DLL repair steps.

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
