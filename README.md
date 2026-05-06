# Revit MCP Skill Package - Self-Contained And Upstream Aligned

This repo packages a Revit MCP skill, bundled plugin payload, bundled local runtime MCP server, and required companion Revit API docs MCP server in one place.

It is designed so the skill can be installed and used without forcing a separate upstream clone flow.

## What this repo provides

- `SKILL.md`: Codex skill instructions for Revit MEP work
- `kurulum/revit-plugin/`: bundled Revit add-in payload
- `kurulum/Custom_DLL/`: command set DLL and manifest backup
- `kurulum/mcp-server/`: bundled local runtime MCP server build for live Revit execution
- `kurulum/revit-api-docs-mcp/`: required companion local MCP server for Revit API DLL + XML documentation search
- `kurulum/install-self-contained.ps1`: self-contained installer script
- `evals/evals.json`: eval set aligned to the current `send_code_to_revit` contract

## Technical direction

This repo stays self-contained, but keeps its execution contract aligned with current upstream Revit MCP behavior:

- `send_code_to_revit` expects code for `Execute(Document document, object[] parameters)`
- the bundled Revit payload is vendor-copied from a working upstream-compatible installation
- the bundled Node wrapper forwards `transactionMode`, but the tested plugin
  build still manages write transactions itself; snippets should not open
  their own `Transaction.Start()` unless that exact installed build has been
  verified
- the runtime MCP server exposes raw dynamic execution plus read-only context
  primitives for session, active view, elements, and parameter schema
- the required docs server resolves class/member signatures before non-trivial snippets are generated, including bulk symbol resolution

## Requirements

- Windows 10 or 11
- Autodesk Revit 2022
- Git for Windows, if you want to pull future updates from this repo
- Node.js 20+; Node 24 is supported by the bundled runtime dependency lock
- Codex CLI

On proxy-limited networks, make sure terminal tools can reach the internet
before running `npm install`:

```powershell
[Environment]::SetEnvironmentVariable("HTTP_PROXY", "http://192.168.90.10:6588", "User")
[Environment]::SetEnvironmentVariable("HTTPS_PROXY", "http://192.168.90.10:6588", "User")
[Environment]::SetEnvironmentVariable("ALL_PROXY", "http://192.168.90.10:6588", "User")
[Environment]::SetEnvironmentVariable("NO_PROXY", "localhost,127.0.0.1,::1", "User")
```

## Quick start

Run these commands from the repo root. Close Revit before running the installer.

```powershell
$RepoRoot = (Resolve-Path .).Path

powershell -ExecutionPolicy Bypass -File "$RepoRoot\kurulum\install-self-contained.ps1" -RevitVersion 2022 -ServerTarget C:\Projects\revit-mcp

cd C:\Projects\revit-mcp
npm install --omit=dev
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"

cd "$RepoRoot\kurulum\revit-api-docs-mcp"
npm install --omit=dev
npm run build-index
codex mcp add revit-api-docs -- node "$RepoRoot\kurulum\revit-api-docs-mcp\build\index.js"
```

Both MCP servers are required — the runtime server executes code, the docs server resolves the API surface against the locally installed Revit DLLs and XML. The skill assumes both are connected.

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
with recent task history and stay visible until the user clicks `OK`.

Then:

1. Open Revit.
2. If Revit asks about the unsigned add-in publisher, choose `Always Load`.
   This can appear once after a fresh install or DLL update.
3. The MCP socket service starts automatically; the `Revit MCP Switch` button is
   only a manual on/off override.
4. Click `Settings` in the `mcp-servers-for-revit` ribbon tab if you need to
   enable or review command availability.
5. Run `/skills reload` inside Codex, or restart Codex.

The installer copies this repo into `%USERPROFILE%\.codex\skills\revit-mcp`
and installs `AGENTS.md` globally at `%USERPROFILE%\.codex\AGENTS.md`.
It also installs the same workstation role file at the workspace root next to
the runtime target, defaulting to `C:\Projects\AGENTS.md` when `-ServerTarget`
is `C:\Projects\revit-mcp`.
If an existing non-empty global `AGENTS.md` is present, the installer backs it
up before replacing it; the workspace `AGENTS.md` is backed up the same way.
Pass `-SkipCodexSkillInstall` to skip that behavior.

## What the installer deploys

The files under `kurulum/` are source payloads kept in the repo for redistribution.
After install, the same payload is copied into the real system locations below:

- Revit add-in manifest:
  - `%APPDATA%\Autodesk\Revit\Addins\2022\mcp-servers-for-revit.addin`
- Revit add-in payload:
  - `%APPDATA%\Autodesk\Revit\Addins\2022\revit_mcp_plugin\...`
- Dynamic command payload mirror:
  - `%LOCALAPPDATA%\revit-mcp-plugin\commands\CommandSet\...`
- Local runtime MCP server bundle:
  - the `-ServerTarget` path you chose, for example `C:\Projects\revit-mcp`
- Required docs MCP server:
  - kept under `kurulum\revit-api-docs-mcp` and registered from the repo root
- Codex skill and workstation role:
  - `%USERPROFILE%\.codex\skills\revit-mcp`
  - `%USERPROFILE%\.codex\AGENTS.md`
  - `C:\Projects\AGENTS.md` by default

The installer removes any previous `%APPDATA%\Autodesk\Revit\Addins\2022\revit_mcp_plugin` tree before copying, so the add-in payload is not left nested under `revit_mcp_plugin\revit_mcp_plugin`.

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

Use this order on a fresh machine from the repo root:

1. Install the prerequisites:
   - Autodesk Revit 2022
   - Git for Windows
   - Node.js 20+; Node 24 is supported by the bundled dependency lock
   - Codex CLI
2. Clone or download this repo.
3. Close Revit.
4. Capture the repo root and run the installer:

```powershell
$RepoRoot = (Resolve-Path .).Path
powershell -ExecutionPolicy Bypass -File "$RepoRoot\kurulum\install-self-contained.ps1" -RevitVersion 2022 -ServerTarget C:\Projects\revit-mcp
```

5. Install Node dependencies in the deployed runtime server target:

```powershell
cd C:\Projects\revit-mcp
npm install --omit=dev
```

6. Register the runtime MCP server in Codex:

```powershell
codex mcp add revit-mcp -- node "C:\Projects\revit-mcp\build\index.js"
```

7. Install and register the required docs MCP server:

```powershell
cd "$RepoRoot\kurulum\revit-api-docs-mcp"
npm install --omit=dev
npm run build-index
codex mcp add revit-api-docs -- node "$RepoRoot\kurulum\revit-api-docs-mcp\build\index.js"
```

8. Reload Codex skills:

```text
/skills reload
```

The installer already installs the global Codex skill and global
`AGENTS.md`. If you skipped that with `-SkipCodexSkillInstall`, copy this repo
root to `%USERPROFILE%\.codex\skills\revit-mcp` and copy `AGENTS.md` to
`%USERPROFILE%\.codex\AGENTS.md` manually.

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
cd "$RepoRoot\kurulum\revit-api-docs-mcp"
npm install --omit=dev
npm run build-index
codex mcp add revit-api-docs -- node "$RepoRoot\kurulum\revit-api-docs-mcp\build\index.js"
```

On first query, the docs server builds a local cache from the installed `RevitAPI*.dll` and matching `RevitAPI*.xml` files under the Revit install folder.

Default cache path:

- `%LOCALAPPDATA%\revit-api-docs-mcp\cache`

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
`-- kurulum/
    |-- KURULUM.md
    |-- install-self-contained.ps1
    |-- revit-api-docs-mcp/
    |-- revit-plugin/
    |   |-- mcp-servers-for-revit.addin
    |   `-- revit_mcp_plugin/
    |-- Custom_DLL/
    `-- mcp-server/
```

## Refreshing an existing install

When a new version of the skill lands in this repo, run the refresh script. It detects how the skill was previously installed (git clone, symlink, or plain copy) under each known host location and updates each install with the matching strategy (`git pull` for clones, no-op for symlinks, backup + resync for copies).

```powershell
powershell -ExecutionPolicy Bypass -File .\kurulum\refresh-skill.ps1
```

Useful flags:

- `-RepoRoot <path>` — point at a specific local clone (defaults to the parent of the script).
- `-ExtraPaths <path1,path2>` — add project-level installs, e.g. `<project>\.claude\skills\revit-mcp`.
- `-NoConfirm` — skip per-target prompts (for unattended runs).

After the script finishes:

- Codex CLI: run `/skills reload`.
- Claude Code: start a new session.
- Cursor: restart Cursor.

## Host compatibility

The installation steps above are written for Codex CLI on Windows, but the skill itself is host-agnostic. Every host must register both MCP servers:

- `revit-mcp` for live Revit execution and inspection
- `revit-api-docs` for required API class/member lookup

Host-specific notes:

- **Claude Code**: copy the repo root into `~/.claude/skills/revit-mcp/` and register both MCP servers with `claude mcp add`. The `send_code_to_revit` tool will surface as `mcp__revit-mcp__send_code_to_revit`.
- **Cursor**: place the repo under your skills/rules location and register both MCP servers in Cursor's MCP settings.
- **Codex CLI**: see the Quick start section above.

`SKILL.md` does not hardcode any host-specific tool name.

## Bundled runtime tool surface

The runtime MCP server intentionally exposes raw dynamic execution plus a small set of high-value context primitives:

- `list_revit_instances`
- `get_revit_mcp_status`
- `send_code_to_revit`
- `send_code_to_revit_safe`
- `get_revit_session_context`
- `get_active_view_context`
- `inspect_elements`
- `inspect_parameter_schema`

The Revit add-in command payload still provides the low-level `send_code_to_revit`, selection, and active-view commands internally. The public MCP surface favors the higher-value Node context tools above.

This runtime set is reflected in the Node MCP wrapper. The installer still copies the bundled Revit command payload required by the wrapper.

The required docs server is separate and exposes its own API lookup tools:

- `search_api`
- `get_type_details`
- `get_member_details`
- `list_namespace`
- `resolve_api_symbols_bulk`

There are no task-specific static runtime tools in the bundled distribution.

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

The self-contained installer also copies the `Custom_DLL` payload so dynamic code execution works after a clean install without manual DLL repair steps.

It now also mirrors the required Roslyn runtime assemblies from the local Revit 2022 installation into the deployed command folders, and it fails early if those files are missing.

The copied command manifests are kept in sync with the bundled Revit low-level commands required by the Node runtime tools.

The docs server remains under `kurulum\revit-api-docs-mcp`; register it as a required companion MCP server after running the installer.

## Note

This repo remains self-contained for distribution. The Revit plugin payload, runtime MCP server build, and docs MCP server are vendored here.

Node dependencies still need to be installed on the target machine with:

```powershell
npm install --omit=dev
```

The bundled runtime server pins `better-sqlite3` to a Node 24-compatible
version so clean Windows installs do not need Python or Visual Studio Build
Tools just to compile that native dependency.
