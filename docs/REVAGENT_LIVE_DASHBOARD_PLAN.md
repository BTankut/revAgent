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

- Machine terminal windows: online/stale, version, user, active task, and a
  bounded live activity stream per machine.
- All-machine terminal stream: recent activity from every machine.
- Focus mode: one selected machine stream fills the dashboard surface.
- Guarded/failed strip: safety blocks and failures in the last N minutes.
- Summary strip: today/latest sessions, production operations, tool usage.
- Deployment health: installed vs stable version and latest update status.

## Implementation Phases

### Phase 1 - Live Feed Publisher

- Add live activity started/completed writes to the runtime telemetry layer.
- Record wrapper-level `mcp.tool` tasks.
- Record bridge/dynamic `revit.command` tasks.
- Write `status.json` snapshots and daily activity ndjson.
- Add tests proving the write path is non-awaited and produces the expected
  files.

### Phase 2 - Read-Only Dashboard MVP

- Implemented by `dashboard/server.mjs`, `dashboard/public/*`, and
  `scripts/start-live-dashboard.ps1`.
- Builds a local web dashboard that reads only NAS JSON/NDJSON files.
- Uses 3 second browser refresh against `/api/overview`; the server reads
  `reports\live`, `reports\machines`, `reports\summaries`, and
  `channels\stable.json`.
- Shows terminal-style per-machine streams, an all-machine stream, active task,
  deployment state, latest summary metrics, tool usage, and
  guarded/failed/slow friction samples.
- Provides single-machine focus mode for detailed live monitoring.
- Does not write to Revit, NAS release state, or telemetry.
- Covered by `dashboard/smoke-test.mjs`, `scripts/test-live-dashboard.ps1`,
  and `scripts/test-all.ps1`.

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
