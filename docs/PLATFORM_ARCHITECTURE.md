# revAgent Platform Architecture

This repo is a self-contained workstation deployment platform for revAgent.
The production technology choices stay the same: C# Revit add-in, local Node
MCP servers, and PowerShell installer/updater orchestration.

Use **revAgent** for product-facing wording. Keep `revit-mcp`, `RevitMCP*`,
`mcp-servers-for-revit`, and `C:\ProgramData\DPE\RevitMCP` only where an exact
server, package, assembly, manifest, or installed path is being named.

## Runtime Components

- `src/revit-plugin/`: C# Revit add-in source. The add-in hosts the local Revit
  socket service, command registry, status window, and command execution bridge.
- `installer/revit-plugin/`: bundled Revit add-in payload copied to
  `C:\ProgramData\DPE\RevitMCP\revit-plugin`.
- `installer/command-payload/`: bundled shared bridge command set and Roslyn
  runtime assemblies used by `send_code_to_revit`.
- `installer/revit-plugin/revit_mcp_plugin/Commands/RevitMCPCommandSet/`:
  bundled shared Revit bridge command set for dynamic execution, lightweight
  model context, UI view state, selection, focus, view navigation, focused 3D
  review views, and 3D section boxes. Focus/view activation commands avoid the
  dynamic code transaction wrapper; section box and 3D view changes use normal
  Revit transactions against project view data.
- `installer/runtime-mcp-server/src/`: TypeScript source for the live Revit MCP
  runtime server. `npm run build` emits `build/`, which remains the installer
  and Codex registration contract.
- `installer/revit-api-docs-mcp/src/`: TypeScript source for the Revit API docs
  MCP server. It indexes local Revit API DLL/XML files and serves API lookup
  tools from `build/index.js`.

## Bridge Commands vs MCP Tools

The Revit Settings window shows installed **bridge command sets**, not the
Codex-facing MCP tool surface. Bridge commands are low-level C# commands loaded
inside Revit by the add-in and invoked over the local socket. Runtime MCP tools
live in the local Node server and may call one bridge command, run a dynamic C#
snippet through `send_code_to_revit`, read socket status, or orchestrate several
bridge commands into a workflow.

The current shared Revit bridge is a single installed command set,
`RevitMCPCommandSet`, with 13 bridge commands: `send_code_to_revit`,
`get_current_view_elements`, `get_current_view_info`,
`get_selected_elements`, `list_open_views`, `activate_view`, `close_view`,
`get_ui_state`, `find_elements`, `open_existing_plan_for_element_level`,
`focus_elements`, `section_box_elements`, and
`create_3d_view_for_elements`.

The runtime MCP surface is intentionally larger than the bridge. It exposes
agent-friendly tools such as `send_code_to_revit_safe`,
`get_revit_session_context`, `inspect_elements`,
`export_revit_coordination_image`, `show_element_in_plan_and_3d`, and
`smart_focus_elements` on top of the shared bridge. Future architectural,
structural, and electrical modules should add module-specific MCP tools in the
runtime layer while reusing this shared Revit bridge for common execution,
context, selection, view, and navigation operations.

The current runtime server registers 21 tools:

- status and targeting: `list_revit_instances`, `get_revit_mcp_status`
- dynamic execution: `send_code_to_revit`, `send_code_to_revit_safe`
- model/session context: `get_revit_session_context`,
  `get_active_view_context`, `inspect_elements`, `inspect_parameter_schema`
- live view workflows: `list_open_views`, `activate_view`, `close_view`,
  `get_ui_state`, `find_elements`, `open_existing_plan_for_element_level`,
  `focus_elements`, `show_element_in_plan_and_3d`, `smart_focus_elements`
- project view-data operations: `section_box_elements`,
  `create_3d_view_for_elements`
- image evidence: `export_revit_view_image`,
  `export_revit_coordination_image`

The companion docs server registers 5 lookup tools: `search_api`,
`get_type_details`, `get_member_details`, `list_namespace`, and
`resolve_api_symbols_bulk`.

Dynamic execution is split between the Node wrapper and the bundled C# command
payload:

- `send_code_to_revit` supports `transactionMode: "auto"` and
  `transactionMode: "none"`.
- `auto` opens a wrapper-managed transaction for ordinary write snippets.
- `none` executes without an outer transaction and is reserved for read-only
  probes, export-style calls, and explicitly confirmed snippets that manage
  their own transaction.
- manual Revit `Transaction` snippets submitted with `auto` are returned as
  `guarded` safety blocks, not failed model operations.
- dynamic compilation de-duplicates loaded assembly references by assembly name
  so multiple loaded Newtonsoft versions do not break `JsonConvert` snippets.

## Runtime Transport And Status

The Node runtime and Revit add-in communicate over the local Revit MCP socket.
New clients send length-prefixed JSON-RPC frames: a 4-byte big-endian payload
length followed by the UTF-8 JSON payload. The add-in keeps legacy raw JSON
support so older clients can still reach the socket during rolling updates.

The default request frame limit is 16 MB. It can be raised per workstation with
`REVIT_MCP_MAX_MESSAGE_BYTES`, capped at 128 MB. Oversized or invalid frames
return a clear JSON-RPC error and close the client connection instead of
leaving the caller waiting for the generic command timeout.

Every completed task records transport metrics in the status model:

- `framing`
- `requestBytes`
- `receiveMs`
- `parseMs`
- `executeMs`
- `responseBytes`

The Revit status window intentionally shows only the state symbol, task name,
total Revit-side duration, and request size. Guarded safety blocks are displayed
as warning states with `!` in recent history rather than red failures. Detailed
metrics are written to the add-in log under the installed payload `Logs\` folder.

## Usage Intelligence

The runtime MCP server also emits silent usage-intelligence events for product
feedback and production analysis. These events are structured NDJSON records,
not raw model dumps. They capture runtime session starts, top-level MCP tool
calls, bridge command calls, dynamic C# execution summaries, timing,
success/guarded/failure state, parameter shapes, bounded text values, and
dynamic-code hashes/previews. Noisy `get_revit_mcp_status` polling is skipped
by default. They still avoid full Revit responses, model geometry dumps, and
exported images.

The runtime also derives `production.context` events from already available
tool parameters and Revit command responses. These events do not perform an
extra Revit query. They provide a dashboard/LLM-oriented work timeline with the
assistant task name, project/view/location hints, target and selected elements,
category/discipline hints, output files, duration, and result state.

Local spool files live under
`C:\ProgramData\DPE\RevitMCP\state\telemetry\events`. When the updater config
provides `reportsRoot`, the runtime also writes best-effort NAS copies under
`reports\events\YYYY\MM\DD\<machine>\<sessionId>.ndjson`. Telemetry write
failures are swallowed; a NAS outage must not fail a Revit operation or show UI
noise.

See `docs/REVAGENT_USAGE_INTELLIGENCE.md` for the event schema, signal
boundaries, and environment controls.

The deterministic daily reader is
`scripts/summarize-usage-intelligence.ps1`. It combines
`reports\machines\<machine>\latest.json` with one UTC day of
`reports\events` into `revagent.usage.summary.v1` JSON for dashboards and
future master-LLM review.
`scripts/publish-usage-summary.ps1` is the publishing wrapper that writes the
daily JSON/Markdown files and refreshes `reports\summaries\latest.json`.

## Deployment Components

- `installer/install-self-contained.ps1`: repo/package installer. Public
  parameters and file name are kept stable.
- `installer/nas/install-updater-task.ps1`: workstation updater bootstrap and
  scheduled task registration.
- `installer/nas/update-from-nas.ps1`: NAS channel updater.
- `installer/nas/Install-Revit-MCP-Updater-GUI.ps1`: revAgent GUI bootstrap
  wrapper.
- `installer/nas/Revit MCP Updater STABLE.cmd`: standalone stable launcher.
- `installer/nas/publish-nas-release.ps1`: release packaging tool. Do not run
  it during local modernization or smoke-test work.

## Shared PowerShell Modules

Shared helpers live under `installer/lib/` and are copied beside local updater
tools under `C:\ProgramData\DPE\RevitMCP\updater\lib` and NAS `tools\lib`.
The Revit version matrix is copied beside those tools as `config\`.

- `RevitMcp.HiddenLauncher.psm1`: single-line VBS hidden launcher generation
  with child exit-code propagation.
- `RevitMcp.ScheduledTask.psm1`: scheduled task action repair to WScript.
- `RevitMcp.Permissions.psm1`: targeted permission repair plan and execution.
- `RevitMcp.Package.psm1`: release path, package layout, and ZIP extraction.
- `RevitMcp.RevitVersions.psm1`: Revit version matrix loading and install-root
  discovery.
- `RevitMcp.UpdatePolicy.psm1`: Revit-open defer vs non-Revit update decision.
- `RevitMcp.Proxy.psm1`: proxy URL normalization helpers.
- `RevitMcp.CodexRegistration.psm1`: Codex `config.toml` MCP registration
  helpers.
- `RevitMcp.Reporting.psm1`: JSON report helpers.

## Revit Version Matrix

`config/revit-versions.json` is the central model for Revit version metadata:

- Revit version and label
- target framework and build configuration
- install-root candidate patterns and registry roots
- all-users add-in path pattern
- API package mapping
- installer payload path expectations
- `installerPayloadAvailable` gate

This branch and the stable deploy line currently support only the Revit 2022
payload. Revit 2023/2024/2025 are modeled for future expansion; installer and
deploy gates must stay closed for those versions until real artifacts are
produced and validated.

## Compatibility Entrypoints

These public entrypoints must keep their names and existing 2022 behavior:

- `installer/nas/Revit MCP Updater STABLE.cmd`
- `installer/nas/Install-Revit-MCP-Updater-GUI.ps1`
- `installer/nas/install-updater-task.ps1`
- `installer/nas/update-from-nas.ps1`
- `installer/install-self-contained.ps1`
- `scripts/build-revit-plugin.ps1`

## Local Validation

No-deploy validation for this platform layer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1

cd .\installer\runtime-mcp-server
npm install --no-audit --no-fund
npm run test

cd ..\revit-api-docs-mcp
npm install --no-audit --no-fund
npm run test
```

Optional aggregate command from repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
```

Revit add-in build check:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

The full payload-refresh build without `-SkipPayloadCopy` should be reserved for
intentional payload update work.
