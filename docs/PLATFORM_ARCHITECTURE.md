# revAgent Platform Architecture

This repo is a self-contained workstation deployment platform for revAgent.
The production technology choices stay the same: C# Revit add-in, local Node
MCP servers, and PowerShell installer/updater orchestration.

Use **revAgent** for product-facing wording. Keep `revit-mcp`, `RevitMCP*`,
`mcp-servers-for-revit`, and `C:\ProgramData\DPE\revAgent` only where an exact
server, package, assembly, manifest, or installed path is being named.

## Runtime Components

- `src/revit-plugin/`: C# Revit add-in source. The add-in hosts the local Revit
  socket service, command registry, status window, and command execution bridge.
- `installer/revit-plugin/`: bundled Revit add-in payload copied to
  `C:\ProgramData\DPE\revAgent\revit-plugin`.
- `installer/command-payload/`: bundled shared bridge command set and Roslyn
  runtime assemblies used by `send_code_to_revit`.
- `installer/revit-plugin/revAgentPlugin/Commands/revAgentCommandSet/`:
  bundled shared Revit bridge command set for dynamic execution, lightweight
  model context, UI view state, selection, focus, view navigation, focused 3D
  review views, and 3D section boxes. Focus/view activation commands avoid the
  dynamic code transaction wrapper; section box and 3D view changes use normal
  Revit transactions against project view data.
- `installer/runtime-mcp-server/src/`: TypeScript source for the live revAgent
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

The current shared Revit bridge is a single installed command set, packaged
under `revAgentCommandSet` while the deep source project remains
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

The current runtime server registers 30 tools:

- status and targeting: `list_revit_instances`, `get_revit_mcp_status`
- dynamic execution: `send_code_to_revit`, `send_code_to_revit_safe`
- model/session context: `get_revit_session_context`,
  `get_active_view_context`, `inspect_elements`, `inspect_sheet_text`,
  `inspect_schedules`, `count_annotations`, `inspect_parameter_schema`
- review/reconciliation: `reconcile_schedule_excel` for deterministic,
  write-free schedule-to-Excel review output
- controlled data writes: `set_element_parameter` for exact-schema
  parameter set/clear operations, `set_schedule_cells` for exact schedule cell
  text writes by schedule id/section/row/column, and
  `set_schedule_cells_by_text` for bounded row-text-driven schedule edits
- live view workflows: `list_open_views`, `activate_view`, `close_view`,
  `clear_selection`, `get_ui_state`, `find_elements`,
  `open_existing_plan_for_element_level`,
  `focus_elements`, `show_element_in_plan_and_3d`, `smart_focus_elements`
- project view-data operations: `section_box_elements`,
  `create_3d_view_for_elements`, `delete_review_view`
- image evidence: `export_revit_view_image`,
  `export_revit_coordination_image`

`get_revit_session_context` defaults to `detailLevel="minimal"` so large-model
document checks do not perform MEP category counts or linked room/space scans.
Callers must opt into `detailLevel="counts"` or `detailLevel="full"` when those
expensive summaries are truly needed.

`find_elements` is the progressive MEP-aware discovery tool for element search.
The runtime infers obvious engineering scope before calling Revit, for example
fan coil/FCU to Mechanical Equipment, valve/vana to pipe accessory/fitting
categories, and duct/pipe/sprinkler/damper/diffuser/pump/AHU terms to bounded
MEP category scopes. The bridge then uses API-level category/view collectors
where possible while level scope remains in the correctness-safe in-memory
post-filter path. API-level level prefiltering for MEP elements is intentionally
deferred until it can preserve duct, pipe, flex, and other fallback-parameter
level matches. Broad linked, verified, or deep searches are explicit through
`allowExpensiveSearch` and `searchBudget`; verified plan visibility is treated
as a separate expensive operation and is limited to exact targets or explicit
approval.

`inspect_sheet_text` is a read-only native commandset workflow for large-project
sheet and placed-view annotation work. It provides bounded sheet text-note
search, placed schedule inventory, bounded placed schedule body-cell scanning,
and optional viewport-linked text notes from views placed on matching sheets so
agents do not have to generate broad ad hoc C# sheet or viewport collectors.
Project-wide sheet text, viewport text, tag, or placed schedule-cell scans
require explicit `allowExpensiveSearch=true`; native elapsed, scan-count, and
response-size budgets return partial evidence before transport timeout. Placed
schedule instances that do not match the requested text remain inventory rows
instead of top-level evidence matches. Viewport tag scanning is opt-in and
returns bounded native `viewportTag` evidence when tag text is readable; tag
API limitations are reported through warnings or notices without failing the
whole sheet inspection.
`inspect_schedules` is a read-only runtime tool for large-project schedule work.
It provides bounded schedule-name discovery and bounded header/body/footer cell
reads/scans so agents do not have to generate broad ad hoc C# loops over every
schedule and every cell. Broad cell scans without `nameQuery` or exact
`scheduleIds` require explicit `allowExpensiveSearch=true`. Schedule traversal
is owned by the native commandset handler and is bounded by `maxElapsedMs`,
`maxCells`, and `maxResponseBytes`; early stops return `partial=true`,
`scanStoppedReason`, and `lastReadSection`/`lastReadRow`/`lastReadColumn`
continuation state instead of relying on socket timeout behavior.
`reconcile_schedule_excel` is the runtime-only schedule-to-Excel reconciliation
surface. It consumes explicit Excel/CSV/rows input and normalized
`inspect_schedules` evidence, normalizes/tokenizes both sides, applies
deterministic scoring, and returns compact review buckets through
`reviewTable`, `evidenceRows`, and count metadata by default. Raw
`reviewRows`, token profiles, raw cells, and nested candidates are reserved for
`responseMode="full"` or `"debug"`. It is review-first and write-free; accepted
corrections are separate confirmed workflows through schedule-cell write tools
or workbook editing paths.
`count_annotations` is a read-only native commandset workflow for general
annotation inventory/count work. Its surface counts DrawingSheet text-note,
viewport text-note, placed schedule-cell, and viewport tag evidence with
explicit profiles, bounded regex matching, grouping, and stable count semantics
(`occurrence`, `uniqueText`, `uniqueTag`, and `uniqueTaggedElement`). Broad
counts without `sheetQuery` or exact `sheetIds` require explicit
`allowExpensiveSearch=true`. Placed schedule-cell traversal is bounded by
schedule instance, row, column, and cell caps, and capped reads report
canonical partial stop reasons instead of returning a silent `completed`
result.
Both broad scan tools are normalized through the shared runtime broad-scan
result contract in `installer/runtime-mcp-server/src/utils/broadScanResult.ts`.
Their top-level result uses the same fields for `partial`, `scanStoppedReason`,
`scanPolicy`, `suggestedNextScopes`, `elapsedMs`, `summary`, `evidenceRows`,
and `lastRead*` continuation state. Canonical stop reasons are `completed`,
`max_elapsed`, `max_rows`, `max_columns`, `max_cells`, `max_items`,
`max_bytes`, `read_failed`, and `needs_scope`; wrapper normalization preserves
legacy native stop reasons as raw diagnostics when needed.
`set_schedule_cells` is the paired write path for known
schedule cells: it never resolves by schedule name, defaults to dry-run, blocks
stale cells with `expectedCurrentText` unless explicitly allowed, commits
through the wrapper transaction, guards non-writable standard schedule body
cells as `non_writable_standard_body_cell`, and verifies the final cell text.
`set_schedule_cells_by_text` covers the common production workflow where the
operator knows a sheet/schedule and visible row label but not exact coordinates:
it requires bounded scope, previews row matches, blocks ambiguous matches by
default, supports `expectedCurrentText`, commits through the wrapper
transaction, uses the same standard body-cell guard, and verifies readback.

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

## Bridge Result Contract

Native Revit bridge command responses are normalized at the Revit host
boundary. `BridgeResultContract.cs` owns the camelCase JSON-RPC result payload
shape and injects `resultContractVersion` so clients can recognize the active
bridge capability per response.

The runtime TypeScript helper layer treats canonical
`resultContractVersion >= 2` payloads as already normalized and idempotent.
Legacy or raw dynamic responses still pass through compatibility parsing and
success-casing fallback so rolling workstation updates do not break clients.
Dynamic snippet object results are preserved as result objects; they must not
be converted into double-encoded JSON strings.

`scripts/test-all.ps1` includes bridge result contract characterization tests
that reject missing `resultContractVersion`, bypassed native camelCase helpers,
double-encoded dynamic object results, and non-idempotent canonical
normalization.

## TypeScript Runtime Hardening

Both MCP packages are strict TypeScript packages. Their `tsconfig.json` files
must keep `strict: true`, and `strict` must not be weakened with local
`noImplicitAny: false` or `useUnknownInCatchVariables: false` overrides.
Source under `installer/runtime-mcp-server/src` and
`installer/revit-api-docs-mcp/src` must not use `@ts-nocheck`; the policy
allowlist is empty.

The former unchecked utility surfaces are now checked by default:
`SocketClient.ts`, `ConnectionManager.ts`, `revitToolHelpers.ts`,
`telemetry.ts`, `database/service.ts`, and the Revit API docs `docIndex.ts`.
This keeps socket framing, Revit connection locking/preflight, bridge response
normalization, live/usage telemetry, database helpers, and API-doc indexing in
the normal compiler path.

`scripts/test-typescript-nocheck-policy.ps1` enforces the strict compiler
settings and the zero-allowlist rule. `scripts/test-mcp-build-payload-freshness.ps1`
and the NAS publish preflight then verify that committed `build/` payloads and
the Revit payload manifest still match source.

## Runtime Transport And Status

The Node runtime and Revit add-in communicate over the local revAgent bridge socket.
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

Runtime/client-side guards are not inserted into Revit-side
`mcp_status.recentTasks` when the command never reached the add-in. They are
instead exposed through runtime telemetry and the live feed as compact activity
records with `state="guarded"` and `guardSource` set to `runtime` or `client`.
Wrapper workflows that run nested Revit commands preserve the operator-visible
parent task with `parentTaskName` and `parentTaskId` while each sub-operation
keeps its own focused `taskName`. This keeps dashboard/history attribution
clear without pretending client-side guards were Revit status-window tasks.

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
`C:\ProgramData\DPE\revAgent\state\telemetry\events`. When the updater config
provides `reportsRoot`, the runtime also writes best-effort NAS copies under
`reports\events\YYYY\MM\DD\<machine>\<sessionId>.ndjson`. Telemetry write
failures are swallowed; a NAS outage must not fail a Revit operation or show UI
noise.

See `docs/REVAGENT_USAGE_INTELLIGENCE.md` for the event schema, signal
boundaries, and environment controls.

Source protection rollout, product know-how boundaries, and distribution
integrity are tracked separately in
`docs/REVAGENT_SIGNED_SOURCE_FREE_CD_ROLLOUT_PLAN.md`,
`docs/REVAGENT_KNOW_HOW_BOUNDARY_REVIEW.md`, and
`docs/REVAGENT_DISTRIBUTION_INTEGRITY_PLAN.md`. Those documents keep Codex
workstation context, live Revit model data, and raw telemetry out of
service-backed product-logic flows while identifying only reusable product
logic as possible future service-boundary candidates. They also define the
signed-release trust model without putting private signing or licensing
material in workstation payloads.

## Live Dashboard

The live dashboard is a read-only monitoring layer on top of the NAS reports
tree. It does not call Revit, does not send MCP commands, and does not write
telemetry or release state.

- Runtime live feed:
  `reports\live\machines\<machine>\status.json` and
  `reports\live\machines\<machine>\activity\YYYY-MM-DD.ndjson`
- Machine install/update health:
  `reports\machines\<machine>\latest.json`
- Summary/LLM handoff inputs:
  `reports\summaries\latest.json` and `/api/brief`
- Stable version comparison:
  `channels\stable.json`

The coordinator starts the local dashboard with
`scripts\start-live-dashboard.ps1`, normally on `http://127.0.0.1:8765`.
The implementation is owned by the admin-only `addons\dashboard` package; the
root script is a repository compatibility launcher and the core workstation
package does not install dashboard or tunnel payloads.
The admin install path is
`C:\ProgramData\DPE\revAgent\addons\dashboard`; install it through
`scripts\install-dashboard-addon.ps1` or the add-on-owned
`addons\dashboard\installer\install-dashboard-addon.ps1`. The installed server
uses only add-on-local dashboard files plus NAS report inputs, so it does not
depend on the source repository path.
If the coordinator session is not elevated and Windows blocks new logon
scheduled tasks, the installer falls back to a per-user HKCU startup entry and
reports that method in the install result.
The admin tunnel path is
`C:\ProgramData\DPE\revAgent\addons\dashboard\tunnel`; install or migrate it
through `scripts\install-dashboard-tunnel.ps1` or by passing `-MigrateTunnel`
to the dashboard add-on installer. The tunnel installer copies the Cloudflare
binary, config, and credential file references into the add-on root, rewrites
path-owned settings such as the log file, and owns the
`revAgent Dashboard Tunnel` scheduled task. Legacy `RevitMCP\cloudflared`
processes and files are left untouched unless the new add-on tunnel is started,
passes health checks, and the operator explicitly opts into legacy stop or
cleanup switches.
The tunnel installer uses the same HKCU startup fallback when logon scheduled
task creation is blocked.
The browser polls `/api/overview` every 3 seconds with bounded responses and
single-flight refreshes. The main UI is intentionally limited to compact
Machine Status Windows and All Status Activity; deeper usage, friction, and
tool metrics stay available through summaries and `/api/brief`.

Machine state is split into independent dimensions so operational state is not
confused with version state:

- connection: `Online`, `Stale`, `Offline`
- version: `Up to date`, `Outdated`, `Unknown`
- task: `Running`, `Idle`
- update exception: `Update failed`, `Pending restart`

Connection thresholds are configurable by dashboard server settings:
`staleSeconds` defaults to 60 seconds and `offlineSeconds` defaults to 300
seconds. A heartbeat older than `offlineSeconds`, a missing `status.json`, or a
missing heartbeat is `Offline`.

The coordinator can optionally expose the same read-only local dashboard through
the Cloudflare Tunnel hostname `https://dashboard.revagent.app`. This is an
access path only; it must not change the no-Revit-command/no-writes safety
contract. Protect the hostname with Cloudflare Access or an equivalent office
policy before broader external sharing.

The deterministic daily reader is
`addons/usage-intelligence/scripts/summarize-usage-intelligence.ps1`. It combines
`reports\machines\<machine>\latest.json` with one UTC day of
`reports\events` into `revagent.usage.summary.v1` JSON for dashboards and
future master-LLM review.
The same summary includes deterministic promotion candidate buckets for
repeated raw/safe code patterns, timeout or partial-result friction, annotation
counting requests, schedule-spreadsheet reconciliation requests, and manual
transaction/write-guard signals. Candidate objects carry bounded evidence
snippets plus session/tool context, `evidenceStrength`, and
`humanReviewRequired=true`; weak evidence is marked for human review instead of
automatically escalating priority.
`addons/usage-intelligence/scripts/publish-usage-summary.ps1` writes the daily
JSON/Markdown files and refreshes `reports\summaries\latest.json`.
`addons/usage-intelligence/scripts/install-usage-summary-task.ps1` installs the
single-machine scheduled publisher, using a hidden launcher, a daily trigger, a
publish lock, and NAS summary logs. The admin install path is
`C:\ProgramData\DPE\revAgent\addons\usage-intelligence`; install it through
`scripts\install-usage-intelligence-addon.ps1` or the add-on-owned
`addons\usage-intelligence\installer\install-usage-intelligence-addon.ps1`.
The installed task uses the add-on-local publisher script and stores task
state/config under the add-on root. The root scripts with the same names remain
compatibility wrappers for local developer workflows.
The publisher prefers the daily scheduled task; a per-user startup fallback is
reported when Windows blocks task creation from the current coordinator session.
Release publishing copies admin add-on payloads under `tools\addons` while the
versioned signed standard user ZIP remains free of dashboard, tunnel, and
usage-intelligence admin payloads.

## Deployment Components

- `installer/install-self-contained.ps1`: repo/package installer. Public
  parameters and file name are kept stable.
- `installer/nas/install-updater-task.ps1`: workstation updater bootstrap and
  scheduled task registration.
- `installer/nas/update-from-nas.ps1`: NAS channel updater.
- `installer/nas/Install-revAgent-Updater-GUI.ps1`: revAgent GUI bootstrap.
  `Install-Revit-MCP-Updater-GUI.ps1` remains only as a legacy wrapper.
- `installer/nas/revAgent Updater STABLE.cmd`: standalone stable launcher.
- `installer/nas/publish-nas-release.ps1`: release packaging tool. Do not run
  it during local modernization or smoke-test work.

## Shared PowerShell Modules

Shared helpers live under `installer/lib/` and are copied beside local updater
tools under `C:\ProgramData\DPE\revAgent\updater\lib` and NAS `tools\lib`.
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

- `installer/nas/revAgent Updater STABLE.cmd`
- `installer/nas/Install-revAgent-Updater-GUI.ps1`
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

The aggregate gate includes installer smoke, usage intelligence, live dashboard
helpers, TypeScript `@ts-nocheck` policy enforcement, both MCP package tests,
and MCP/Revit payload freshness verification.

Revit add-in build check:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022 -SkipPayloadCopy
```

The full payload-refresh build without `-SkipPayloadCopy` should be reserved for
intentional payload update work; it also refreshes
`installer/revit-payload-manifest.json`.
