# revAgent Usage Intelligence

revAgent usage intelligence is the office feedback and production-analysis
pipeline for learning from real usage without interrupting production work. It
records structured runtime events that can later be aggregated for dashboards
and LLM analysis.

The goal is not raw log collection. The goal is to answer product questions
from real usage evidence:

- Which tools are used most often?
- Which commands produce the most guarded, failed, or slow outcomes?
- Which repeated `send_code_to_revit` patterns should become native tools?
- Which workflows need better UI, documentation, or safer defaults?
- Which issues deserve hotfix priority because they repeat across machines?
- Which project/session/floor/work-area patterns show production friction or
  staffing bottlenecks?

## Event Sources

The first implemented source is the Node runtime MCP server. It records:

- runtime session start events
- top-level MCP tool calls, excluding noisy status polling by default
- bridge command calls sent through `sendRevitCommand`
- dynamic C# calls sent through `executeRevitCode`
- raw `send_code_to_revit` calls
- production-context events inferred from each useful tool/command response

Installer and updater status reports continue to use the existing
`reports/machines/<machine>/latest.json` and per-machine log retention flow.
Those reports are the machine health layer; runtime telemetry is the product
usage layer.

## Storage

Events are written as newline-delimited JSON.

Local spool:

```text
C:\ProgramData\DPE\revAgent\state\telemetry\events\YYYY-MM-DD.ndjson
```

Remote NAS event store, when `reportsRoot` is available from updater config:

```text
<reportsRoot>\events\YYYY\MM\DD\<machine>\<sessionId>.ndjson
```

Remote writes are best effort and silent. A NAS outage must never fail or slow a
Revit operation from the user's point of view.

## Daily Summary

The first deterministic reader layer is
`addons/usage-intelligence/scripts/summarize-usage-intelligence.ps1`. It reads
the machine health reports and runtime event store for one UTC day and produces
compact JSON for dashboards and LLM review. The root
`scripts/summarize-usage-intelligence.ps1` file is a compatibility wrapper that
delegates to this add-on script.

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\summarize-usage-intelligence.ps1 `
  -ReportsRoot "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports" `
  -DateUtc "2026-05-27" `
  -OutputPath "C:\ProgramData\DPE\revAgent\debug\usage-summary-2026-05-27.json"
```

The summary schema is `revagent.usage.summary.v1`. It includes:

- latest machine install/update status from `reports\machines`
- event totals by type, machine, user, and session
- MCP tool and Revit command usage with duration and result counts
- production-context rollups by machine/user, project, discipline, level, and
  category
- guarded, failed, and slow operation samples
- `send_code_to_revit` / `send_code_to_revit_safe` code-preview summaries,
  write-pattern counts, and manual transaction counts
- promotion tracking fields: `promotionCandidates`, `nativeToolCandidates`,
  `hotfixCandidates`, `reconciliationCandidates`,
  `annotationInventoryCandidates`, `evidenceStrength`, and
  `humanReviewRequired`

This layer intentionally does not call an LLM. It prepares a bounded,
dashboard-ready and LLM-ready evidence packet from the office-internal event
store.

Friction samples prefer `production.context` because it carries project, view,
level, room, category, and output context. When a raw `mcp.tool` or
`revit.command` event has no matching production context, the summarizer still
uses that raw event for guarded, failed, and slow samples so counts and sample
lists stay consistent. Raw `mcp.tool` and `revit.command` samples that describe
the same logical operation are grouped before friction samples are emitted, so
one failed schedule edit does not appear twice only because it crossed both the
MCP wrapper and Revit bridge layers.

Summary readers and writers use UTF-8 explicitly. If task names contain Turkish
characters, the daily JSON/Markdown should preserve the original text rather
than mojibake such as `Ã¼` or `Ä±`. Dynamic-code write-pattern detection also
recognizes schedule cell edits such as `SetCellText` and schedule table edits,
so repeated schedule-write snippets can be promoted into native tools.

Promotion tracking is deterministic and review-first. The summarizer maps
repeated raw/safe code patterns to `nativeToolCandidates`, repeated
timeout/partial-result friction to `hotfixCandidates`, repeated annotation
counting requests to `annotationInventoryCandidates`, repeated
schedule-spreadsheet reconciliation requests to `reconciliationCandidates`, and
manual transaction/write-guard patterns to the general `promotionCandidates`.
Each candidate carries an `evidenceSnippet`, `sessionContext`, `toolContext`,
`evidenceStrength`, and `humanReviewRequired=true`. Weak or small-sample
evidence is marked as `evidenceStrength: "weak"` instead of being escalated
automatically; promotion only surfaces a candidate for human review.

The publish script is
`addons/usage-intelligence/scripts/publish-usage-summary.ps1`. It runs the
summarizer and writes stable NAS outputs. The root
`scripts/publish-usage-summary.ps1` wrapper remains available for local
developer compatibility:

```text
<reportsRoot>\summaries\daily\YYYY-MM-DD.json
<reportsRoot>\summaries\daily\YYYY-MM-DD.md
<reportsRoot>\summaries\latest.json
<reportsRoot>\summaries\latest.md
<reportsRoot>\summaries\publish-latest.json
```

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-usage-summary.ps1 `
  -ReportsRoot "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports" `
  -DateUtc "2026-05-27"
```

`latest.json` is the stable machine-readable input for the next dashboard or
master-LLM layer. Markdown files are only a compact human support view.

On the single coordinator workstation, install the daily scheduled publisher:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-usage-summary-task.ps1 `
  -ReportsRoot "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports" `
  -DailyAt "20:30" `
  -RunNow
```

The add-on-owned task installer is
`addons/usage-intelligence/scripts/install-usage-summary-task.ps1`; the root
script delegates to it.
For an installed admin add-on payload that does not depend on the source repo
path, use `scripts/install-usage-intelligence-addon.ps1` or the add-on-owned
`addons/usage-intelligence/installer/install-usage-intelligence-addon.ps1`.
The installed payload runs from
`C:\ProgramData\DPE\revAgent\addons\usage-intelligence` and stores task state
under that add-on root.

The task name is `revAgent Usage Summary Publish`. It should be installed on
one machine only. The publisher uses `reports\summaries\publish.lock` to avoid
overlapping runs and writes logs under `reports\summaries\logs`.

## Event Shape

Runtime command events use schema `revagent.telemetry.v1` and include:

- event identity: `eventId`, `timestampUtc`, `sessionId`, `sequence`
- workstation identity: `machineName`, `userName`
- runtime identity: installed version and build hash when available
- command identity: `commandName`, `logicalToolName`, `executionKind`
- task metadata: `taskName`, whether a `taskId` was present
- timing: `durationMs`
- result summary: success, guarded state, action/state, compact error summary
- parameter summary: key names, counts, booleans/enums, bounded text values,
  and code hash/size/preview data

Top-level `mcp.tool` events use the same schema and add `toolName`, duration,
top-level `taskName`, parameter shape, and compact result status.
`get_revit_mcp_status` is skipped unless `REVAGENT_TELEMETRY_INCLUDE_STATUS=1`
is set because agents poll it frequently during safe Revit coordination.

Production-context events use `eventType: "production.context"` and
`contextSchemaVersion: "revagent.production.context.v1"`. They are generated
without sending an extra Revit request; the runtime infers them from the
already available tool parameters and command responses. They include:

- related operation: source event type, tool/command/logical tool name, run id
- operation intent: `taskName`, query text, action, duration, result state
- project identity: title, model path when available, project id hash
- view identity: active/before/after views and active-view change state
- work location: level, room, and space fields when available
- element context: target ids, selection ids, category names, discipline hint,
  and a bounded sample of element summaries
- output context: export directory, file prefix, and generated file summaries

This is the bridge toward the future master LLM/dashboard layer: the raw
tool/command events remain useful for technical debugging, while
`production.context` gives a higher-level project-production timeline that can
be grouped by user, machine, project, view, level, room/space, discipline,
tool, and outcome.

## Signal And Noise Boundaries

Telemetry is office-internal signal, not a public analytics stream. It now keeps
bounded text where that text helps later semantic analysis, including task
names, search text, useful paths, and dynamic-code previews. Dynamic code is
stored with a hash, character count, line count, write-pattern names, and a
bounded preview. The default preview limits are intentionally large enough for
LLM clustering while still preventing accidental multi-megabyte event records.

Telemetry still does not collect:

- full Revit command response payloads
- full model geometry or element dumps
- exported images

The pipeline is silent by default. Telemetry failures are swallowed. Operators
should not see dialogs, status noise, or failed Revit commands because telemetry
could not write.

## Environment Controls

- `REVAGENT_TELEMETRY_DISABLED=1`: disable runtime telemetry.
- `REVAGENT_TELEMETRY_LOCAL_ONLY=1`: write local spool only, no NAS event store.
- `REVAGENT_TELEMETRY_INCLUDE_STATUS=1`: include status-polling tool calls.
- `REVAGENT_TELEMETRY_TEXT_CHARS=<n>`: limit stored free-form text per
  parameter. Defaults to 1000, max 10000, `0` disables text copies.
- `REVAGENT_TELEMETRY_CODE_CHARS=<n>`: limit stored dynamic-code preview text.
  Defaults to 4000, max 100000, `0` disables code previews.
- `REVAGENT_TELEMETRY_CONTEXT_ELEMENTS=<n>`: limit element samples in
  `production.context`. Defaults to 12, max 100, `0` disables element samples.
- `REVAGENT_TELEMETRY_ROOT=<path>`: override the local spool root.
- `REVAGENT_REPORTS_ROOT=<path>`: override the remote reports/event root.
- `REVAGENT_UPDATER_CONFIG=<path>`: override updater config discovery.
- `REVAGENT_LIVE_STATUS_DISABLED=1`: disable the live dashboard feed.
- `REVAGENT_LIVE_STATUS_LOCAL_ONLY=1`: write live files locally only.
- `REVAGENT_LIVE_STATUS_ROOT=<path>`: override the remote live root. Defaults
  to `<reportsRoot>\live`.
- `REVAGENT_LIVE_STATUS_LOCAL_ROOT=<path>`: override the local live root.
  Defaults to `<telemetryRoot>\live`.
- `REVAGENT_LIVE_STATUS_HEARTBEAT_MS=<n>`: heartbeat interval for `status.json`.
  Defaults to 5000 ms; `0` disables heartbeat-only writes.
- `REVAGENT_LIVE_STATUS_RECENT=<n>`: number of recent activity rows kept in
  `status.json`. Defaults to 50, max 200.
- `REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT=<n>`: maximum concurrent live feed writes
  before new live writes are dropped. Defaults to 32.

## Implemented Layers

The current usage-intelligence stack includes:

1. A live dashboard feed under `reports\live\machines\<machine>` with
   non-blocking `status.json` snapshots and daily activity NDJSON for 2-5
   second dashboard polling.
2. A read-only web dashboard in `addons/dashboard` with a Machine Status
   Windows list, deployment health per machine, and a revAgent-status-style All
   Status Activity stream. The browser UI intentionally stays simple: machine status
   cards in the left column and the filtered activity stream in the wider right
   column. Machine cards show separate connection, version, task, and
   update-exception badges instead of one combined state. All Status Activity
   is limited to 50 visible records by default with expansion to 200, preserves
   manual scroll position during refresh, and supports all/one/multiple-machine
   monitoring filters without changing the live feed.
   The admin/coordinator install script is
   `addons/dashboard/installer/install-dashboard-addon.ps1`; the root
   `scripts/install-dashboard-addon.ps1` wrapper delegates to it. The optional
   Cloudflare tunnel migration is owned by
   `addons/dashboard/installer/install-dashboard-tunnel.ps1` with root wrapper
   `scripts/install-dashboard-tunnel.ps1`. If Windows blocks logon scheduled
   task creation from a non-elevated coordinator session, dashboard and tunnel
   installers fall back to per-user HKCU startup entries and report that
   registration method.
3. A compact `/api/brief` dashboard export for separate analyst/LLM sessions.
4. `scripts\publish-live-backfill.ps1`, a repair task that backfills local live
   spool files when NAS was offline.
5. Master-LLM/product analysis over `reports\summaries\latest.json` and the
   bounded dashboard brief, not full raw logs by default.

The live dashboard UI polling endpoint is intentionally compact. It keeps
raw dynamic-code payload details, params, and long previews out of
`/api/overview` so the browser can poll every few seconds without moving large
telemetry blobs. Those richer details remain available in durable telemetry and
daily summaries for offline analysis.

The dashboard API still exposes compact current-state metrics for `/api/brief`
and diagnostics, but the browser's main monitoring page no longer displays top
metric cards, tool usage, or friction panels. Scheduled daily summaries remain
the slower analytic layer for trend and LLM review.

## Live Dashboard Feed

The runtime writes a best-effort live feed for dashboard polling:

```text
<reportsRoot>\live\machines\<machine>\status.json
<reportsRoot>\live\machines\<machine>\activity\YYYY-MM-DD.ndjson
```

Local fallback uses:

```text
C:\ProgramData\DPE\revAgent\state\telemetry\live\machines\<machine>\
```

`status.json` uses schema `revagent.live.status.v1` and is the dashboard fast
path. It includes the current active task, active task list, recent activity,
the latest Revit add-in `mcp_status.recentTasks` snapshot, runtime identity,
process identity, heartbeat time, and live-write health.

Activity lines use schema `revagent.live.activity.v1` and record `started`,
`completed`, `guarded`, and `failed` phases for top-level MCP tools and Revit
bridge/dynamic commands.

The dashboard Recent Tasks projection prefers the Revit add-in status snapshot
when available, because that is the same source shown in the local revAgent
status window. Runtime live activity remains the fallback and diagnostic layer.

Connection state is derived from the live heartbeat, not from version/update
status: `Online` is within the stale threshold, `Stale` is older but still
inside the offline threshold, and `Offline` means no live heartbeat or a
heartbeat older than the offline threshold. Version state is independent
(`Up to date`, `Outdated`, `Unknown`), and task state is independent
(`Running`, `Idle`).

The coordinator dashboard can be exposed as
`https://dashboard.revagent.app` through a Cloudflare Tunnel to the local
read-only server. This changes only access to the dashboard; it does not add a
new writer or direct Revit polling path. On the admin machine, tunnel ownership
belongs to the dashboard add-on under
`C:\ProgramData\DPE\revAgent\addons\dashboard\tunnel`; the standard user
package does not install or migrate Cloudflare tunnel files.

Dashboard and usage-intelligence are admin/coordinator add-ons. They are not
part of the standard workstation package, and source-free user pack guards treat
the repository `addons` folder as a non-workstation artifact.

The live feed is intentionally not the durable audit record. It is a UI feed.
Writes are fire-and-forget, bounded by `REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT`,
and failure-silent. Slow or unavailable NAS writes must be dropped instead of
blocking a Revit operation.
