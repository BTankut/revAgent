# revAgent Live Dashboard Plan

This plan defines the first dashboard layer for live revAgent office monitoring.
It builds on the existing usage-intelligence pipeline and adds a low-latency,
non-blocking live feed that a dashboard can poll every 2-5 seconds.

## Goals

- Show each workstation's current revAgent activity.
- Show the same kind of task names users see in the revAgent status window.
- Keep machine health, version state, usage summaries, and live activity in one
  dashboard surface.
- Keep all live publishing best effort and invisible to production users.
- Never let live dashboard publishing block, slow, or fail a Revit/MCP task.

## Non-Goals For The First Pass

- No database service.
- No internet service.
- No Revit-side binary refactor.
- No direct polling from the dashboard into each workstation's Revit process.
- No requirement that every live activity event is durable; daily telemetry
  remains the durable source of truth.

## Existing Layers

Already implemented:

- Machine health reports:
  `reports\machines\<machine>\latest.json`
- Runtime telemetry:
  local spool plus NAS `reports\events\YYYY\MM\DD\<machine>\<session>.ndjson`
- Derived `production.context` events for project/view/level/room/category
  analysis.
- Daily deterministic summaries:
  `scripts\summarize-usage-intelligence.ps1`
- NAS summary publisher:
  `scripts\publish-usage-summary.ps1`
- Coordinator scheduled task:
  `revAgent Usage Summary Publish`
- Read-only analyst skill:
  `revagent-usage-analyst`

## New Live Feed Layer

Each runtime writes lightweight live files under:

```text
<reportsRoot>\live\machines\<machine>\
```

Primary dashboard file:

```text
<reportsRoot>\live\machines\<machine>\status.json
```

Append-only activity feed:

```text
<reportsRoot>\live\machines\<machine>\activity\YYYY-MM-DD.ndjson
```

Local fallback mirrors the same shape under:

```text
C:\ProgramData\DPE\RevitMCP\state\telemetry\live\machines\<machine>\
```

## status.json Shape

The dashboard should treat `status.json` as the fast path.

Expected fields:

- `schemaVersion`: `revagent.live.status.v1`
- `generatedAtUtc`
- `lastHeartbeatUtc`
- `machineName`
- `userName`
- `sessionId`
- `runtime`
- `process`
- `activeTask`
- `activeTasks`
- `recentActivity`
- `writeHealth`

`activeTask` is the best single task to display for the machine. Prefer a live
`revit.command` over a wrapper-level `mcp.tool` when both are active.

`recentActivity` is a bounded in-memory list intended for dashboard display. The
daily telemetry and summaries remain the durable analytic record.

## Activity Event Shape

Each line in the daily activity file is JSON:

- `schemaVersion`: `revagent.live.activity.v1`
- `phase`: `started`, `completed`, `guarded`, or `failed`
- `state`: `running`, `completed`, `guarded`, or `failed`
- `scope`: `mcp.tool` or `revit.command`
- `toolName` / `commandName` / `logicalToolName`
- `taskName`
- `taskIdPresent`
- `startedAtUtc`
- `finishedAtUtc`
- `durationMs`
- `result`
- `machineName`, `userName`, `sessionId`, `runtime`

## Non-Blocking Safety Contract

Live publishing must obey these rules:

- Never `await` live file writes from a tool handler or Revit command path.
- NAS writes are best effort and failure-silent.
- Slow or unavailable NAS writes must be dropped, not queued forever.
- A bounded in-flight write limit protects runtime memory.
- `status.json` writes are snapshots; losing one is acceptable because the next
  heartbeat or activity updates it.
- The live feed is not the audit source of truth. Durable telemetry and daily
  summaries remain authoritative.

## Refresh Model

The dashboard can poll:

- `reports\live\machines\*\status.json` every 2-5 seconds.
- `reports\machines\*\latest.json` every 30-60 seconds.
- `reports\summaries\latest.json` every 30-60 seconds or on demand.

A machine is stale when:

- `status.json` is missing, or
- `lastHeartbeatUtc` is older than a configurable threshold, initially 60
  seconds.

## MVP Dashboard Panels

- Machine status windows: online/stale, version, user, active task, and a
  bounded status-history style activity list per machine.
- All-machine status activity: recent activity from every machine, limited to
  50 visible records by default and expandable to 200 records.
- Status-window semantics: dashboard activity is a user-facing task projection,
  not a raw event log. It collapses `started`/terminal lifecycle pairs and
  wrapper-level `mcp.tool` plus nested `send_code_to_revit` events into one
  task row while keeping raw telemetry intact for analysis.
- Desktop layout: the left two-thirds column contains All Status Activity,
  Tool Usage, and Friction stacked vertically; the right one-third column is
  reserved for stacked Machine Status Windows.
- Focus mode: one selected machine stream fills the dashboard surface.
- Theme mode: System, Light, and Dark.
- Guarded/failed strip: safety blocks and failures in the last N minutes.
- Summary strip: today/latest sessions, production operations, tool usage.
- Top activity metrics: Live Operations, Guarded, and Failed are derived from
  terminal user-facing task rows in the current live feed, not from the
  scheduled daily summary or raw duplicate event rows.
- Deployment health: installed vs stable version and latest update status.

## Implementation Phases

### Phase 1 - Live Feed Publisher

- Implemented live activity started/completed writes in the runtime telemetry
  layer.
- Records wrapper-level `mcp.tool` tasks.
- Records bridge/dynamic `revit.command` tasks.
- Writes `status.json` snapshots and daily activity ndjson.
- Tests prove the write path is non-awaited and produces the expected
  files.

### Phase 2 - Read-Only Dashboard MVP

- Implemented by `dashboard/server.mjs`, `dashboard/public/*`, and
  `scripts/start-live-dashboard.ps1`.
- Builds a local web dashboard that reads only NAS JSON/NDJSON files.
- Uses 3 second browser refresh against `/api/overview`; the server reads
  `reports\live`, `reports\machines`, `reports\summaries`, and
  `channels\stable.json`.
- Shows revAgent-status-style per-machine history windows, an all-machine
  activity window, active task, deployment state, latest summary metrics,
  tool usage, and guarded/failed/slow friction samples.
- The dashboard server projects raw live activity into status-window style rows
  before sending `/api/overview`; grouped rows carry `groupedEventCount` and
  `groupedScopes` for diagnostics.
- Uses a 2/1 desktop layout: All Status Activity, Tool Usage, and Friction
  stay in the left column; Machine Status Windows stay stacked in the right
  column.
- Keeps the all-machine activity window bounded by showing 50 live records by
  default, with an explicit expansion path to 200 records.
- Provides single-machine focus mode for detailed live monitoring.
- Provides System/Light/Dark theme selection.
- Does not write to Revit, NAS release state, or telemetry.
- Covered by `dashboard/smoke-test.mjs`, `scripts/test-live-dashboard.ps1`,
  and `scripts/test-all.ps1`.

### Phase 2B - Production Hardening

- Implemented compact `/api/overview` responses for 3 second polling; raw
  live activity payloads such as params and dynamic-code previews are not sent
  to the browser.
- Keeps durable telemetry and daily summaries as the source for deeper LLM
  analysis; the dashboard response is a bounded UI surface.
- Bounds daily activity NDJSON reads to the tail of the file before applying
  the activity count limit.
- Uses compact JSON responses and `x-content-type-options: nosniff` headers.
- Browser refreshes are single-flight and use a timeout so slow NAS reads or
  network issues do not build up overlapping refreshes.
- Production layout and polling contracts are guarded by
  `scripts/test-live-dashboard.ps1`.

### Phase 3 - Analyst Integration

- Implemented by `/api/brief` in `dashboard/server.mjs`.
- Exports compact read-only JSON with machine state, active/latest activity,
  latest usage summary, tool usage, and friction samples.
- Keeps actual LLM analysis in a separate analyst workflow/session.
- Uses daily summaries first, with live activity included only as a bounded
  current-state signal.

### Phase 4 - Backfill And Repair

- Implemented by `scripts\publish-live-backfill.ps1`.
- Merges a workstation's local live status/activity spool back into
  `reports\live\machines\<machine>` when NAS writes were unavailable.
- Copies `status.json` only when local status is newer unless `-Force` is used.
- Merges daily activity NDJSON without duplicating identical lines.
- Kept separate from live dashboard publishing and covered by
  `scripts/test-live-dashboard.ps1`.

## Release Guidance

Phase 1 is runtime-only. It should not require a Revit add-in payload rebuild.
Before deployment:

- Run runtime build/tests.
- Run installer smoke tests.
- Confirm Revit payload hash is unchanged in the release manifest.
- Deploy through the normal NAS stable release flow.
