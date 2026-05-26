# revAgent Usage Intelligence

revAgent usage intelligence is the product feedback pipeline for learning from
real office usage without interrupting production work. It records compact,
structured runtime events that can later be aggregated for dashboards and LLM
analysis.

The goal is not raw log collection. The goal is to answer product questions
from real usage evidence:

- Which tools are used most often?
- Which commands produce the most guarded, failed, or slow outcomes?
- Which repeated `send_code_to_revit` patterns should become native tools?
- Which workflows need better UI, documentation, or safer defaults?
- Which issues deserve hotfix priority because they repeat across machines?

## Event Sources

The first implemented source is the Node runtime MCP server. It records:

- runtime session start events
- top-level MCP tool calls, excluding noisy status polling by default
- bridge command calls sent through `sendRevitCommand`
- dynamic C# calls sent through `executeRevitCode`
- raw `send_code_to_revit` calls

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
- parameter summary: key names, counts, booleans/enums, code hash/size

Top-level `mcp.tool` events use the same schema and add `toolName`, duration,
parameter shape, and compact result status. `get_revit_mcp_status` is skipped
unless `REVAGENT_TELEMETRY_INCLUDE_STATUS=1` is set because agents poll it
frequently during safe Revit coordination.

## Privacy And Noise Boundaries

Telemetry intentionally does not collect:

- full C# code text
- full Revit command response payloads
- full model geometry or element dumps
- full project paths
- exported images

Dynamic code is summarized with a hash, character count, line count, and write
pattern names. Search text and other free-form strings are hashed and length
counted instead of stored verbatim. Error text is truncated and obvious local or
UNC paths are redacted.

The pipeline is silent by default. Telemetry failures are swallowed. Operators
should not see dialogs, status noise, or failed Revit commands because telemetry
could not write.

## Environment Controls

- `REVAGENT_TELEMETRY_DISABLED=1`: disable runtime telemetry.
- `REVAGENT_TELEMETRY_LOCAL_ONLY=1`: write local spool only, no NAS event store.
- `REVAGENT_TELEMETRY_INCLUDE_STATUS=1`: include status-polling tool calls.
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
