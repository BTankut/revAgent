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
C:\ProgramData\DPE\RevitMCP\state\telemetry\events\YYYY-MM-DD.ndjson
```

Remote NAS event store, when `reportsRoot` is available from updater config:

```text
<reportsRoot>\events\YYYY\MM\DD\<machine>\<sessionId>.ndjson
```

Remote writes are best effort and silent. A NAS outage must never fail or slow a
Revit operation from the user's point of view.

## Daily Summary

The first deterministic reader layer is
`scripts/summarize-usage-intelligence.ps1`. It reads the machine health reports
and runtime event store for one UTC day and produces compact JSON for dashboards
and LLM review.

Example:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\summarize-usage-intelligence.ps1 `
  -ReportsRoot "\\DPE-NAS\Dpe-Ortak\Baris Tankut\revit-mcp-deploy\reports" `
  -DateUtc "2026-05-27" `
  -OutputPath "C:\ProgramData\DPE\RevitMCP\debug\usage-summary-2026-05-27.json"
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

This layer intentionally does not call an LLM. It prepares a bounded,
dashboard-ready and LLM-ready evidence packet from the office-internal event
store.

Friction samples prefer `production.context` because it carries project, view,
level, room, category, and output context. When a raw `mcp.tool` or
`revit.command` event has no matching production context, the summarizer still
uses that raw event for guarded, failed, and slow samples so counts and sample
lists stay consistent.

The publish wrapper is `scripts/publish-usage-summary.ps1`. It runs the
summarizer and writes stable NAS outputs:

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
2. A read-only web dashboard in `dashboard/` with revAgent-status-style
   per-machine task history windows, an all-machine activity window, deployment
   health, tool usage, and friction samples. The dashboard keeps activity,
   tool usage, and friction in the left analysis column, stacks machine status
   windows in the right column, and limits All Status Activity to 50 visible
   records by default with expansion to 200.
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

The dashboard's top activity metrics use the current live feed. Live
Operations, Guarded, and Failed count terminal `mcp.tool` events from today's
live activity tail, so they reflect what is happening on the dashboard now.
Scheduled daily summaries remain the slower analytic layer for trend and LLM
review.

## Live Dashboard Feed

The runtime writes a best-effort live feed for dashboard polling:

```text
<reportsRoot>\live\machines\<machine>\status.json
<reportsRoot>\live\machines\<machine>\activity\YYYY-MM-DD.ndjson
```

Local fallback uses:

```text
C:\ProgramData\DPE\RevitMCP\state\telemetry\live\machines\<machine>\
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

The live feed is intentionally not the durable audit record. It is a UI feed.
Writes are fire-and-forget, bounded by `REVAGENT_LIVE_STATUS_MAX_IN_FLIGHT`,
and failure-silent. Slow or unavailable NAS writes must be dropped instead of
blocking a Revit operation.
