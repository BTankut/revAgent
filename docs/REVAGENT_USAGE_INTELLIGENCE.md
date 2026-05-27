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

## Next Layers

The next useful layers are:

1. A lightweight uploader or repair task that backfills local spool files when
   NAS was offline.
2. A daily aggregator that reads `reports/events/**.ndjson` and produces
   compact JSON summaries for dashboards and LLM review.
3. A web dashboard over machine health, tool usage, failures, guarded states,
   latency, and repeated dynamic-code patterns.
4. An LLM product analyst prompt over the aggregated summaries, not raw logs.
