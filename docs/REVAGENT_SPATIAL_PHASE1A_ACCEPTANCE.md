# revAgent Spatial Context Engine — Phase 1a Acceptance

Status: implementation complete; local Gates A-C passed on 2026-07-11;
live Gate D and delivery Gate E pending.

This document defines the acceptance path for Phase 1a truth foundations only.
It does not replace the historical Phase 0 acceptance record and does not mark
Phase 1a complete in `REVAGENT_SPATIAL_CONTEXT_ENGINE_PLAN.md`. Record actual
commands, versions, model scope, timings, and artifacts here only after each
gate runs successfully.

## Capability boundary under test

Phase 1a is read-only with respect to Revit model data. The public
`capture_spatial_snapshot` tool requires an explicit host Level scope. The
runtime owns opaque native pagination, validates a single v0.2
scope/revision/hash chain, writes pages to staging, and exposes a snapshot only
after one atomic durable-store commit. Interrupted attempts must discard their
staging rows and must never expose a mixed-revision snapshot.

The default store is `%LOCALAPPDATA%\revAgent\spatial\spatial.db`; tests may
override it with `REVAGENT_SPATIAL_DB_PATH`. The store must prove versioned
migration with backup/recovery, R*Tree availability, retention, expired staging
cleanup, and purge semantics. Spatial content remains local and is excluded
from release packages and usage-intelligence telemetry.

The result fields are independent:

- `committed=true` and `atomic=true` describe durable visibility;
- `partial` and `coverageStatus` describe extraction coverage;
- `liveness=current|stale|unknown` describes the tracked revision binding;
- `scopeFingerprint` and `revisionFingerprint` identify scope and captured
  source state separately.

Phase 1a provides no deterministic spatial query, snapshot diff, clash
screening, or live clash/clearance verdict. No acceptance result may be worded
as "clash-free", "clearance verified", or as a computed spatial relation.

## Gate A — generated payloads

Run after source changes are stable:

```powershell
cd .\installer\runtime-mcp-server
npm ci
npm run build:release
cd ..\..

powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
```

The runtime `src`, committed `build`, hardened `release`, v0.1/v0.2 schemas,
Revit DLL payloads, command manifests, and
`installer/revit-payload-manifest.json` must move together. Revit
2023/2024/2025 remain compile-only modeled targets until their deployment
payload gates are explicitly enabled:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2023 -SkipPayloadCopy
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2024 -SkipPayloadCopy
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2025 -SkipPayloadCopy
```

Evidence status: passed locally on 2026-07-11. `npm ci` and
`npm run build:release` completed successfully; the hardened runtime bundle and
v0.2 schemas were regenerated. Revit 2022 rebuilt and refreshed the committed
installer payload plus `installer/revit-payload-manifest.json`. Revit
2023/2024/2025 compile-only builds also completed with zero errors; the latter
targets emitted compatibility/deprecation warnings but produced their expected
DLLs. No install, deploy, ProgramData write, or NAS publish was performed.

## Gate B — targeted CI-safe contracts

```powershell
cd .\installer\runtime-mcp-server
npm run spatial-phase0-contract-test
npm run spatial-phase1a-contract-test
npm run spatial-phase1a-store-test
npm run spatial-store-cli-test
npm run spatial-phase1a-capture-test
cd ..\..

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-mcp-build-payload-freshness.ps1
```

Required assertions include schema strictness, v0.1 compatibility, atomic
staging invisibility, mixed-revision rejection, bounded retry/discard,
current/stale/unknown and journal-gap behavior, migration rollback/recovery,
retention/purge, and R*Tree indexed lookup without silent full-table fallback.
Identity fixtures must keep scope and revision fingerprints separate and cover
saved standalone, workshared, cloud, linked-placement, and session-only
document-key outcomes. Composite identity tests must also cover the versioned
connector-key strategy and deterministic derived-node identity wherever those
node kinds are emitted; schema presence alone is not acceptance evidence.
Local-path tests must inject Windows drive types and prove that mapped Network,
Unknown, NoRoot, and unready roots fail closed while ready Fixed, Removable,
and RAM roots remain allowed. The `spatial-store` maintenance CLI must prove
non-mutating preview, guarded purge without `--confirm`, exact-selector purge
with confirmation, and database/R*Tree/artifact cleanup consistency.

When an operator explicitly requests maintenance against the installed store,
use the same `node.exe` from the revAgent MCP config and the hardened installed
entrypoint. Preview the exact selector first; never infer purge authorization
from this acceptance checklist:

```powershell
$node = "<same node.exe path used by the revAgent MCP config>"
$runtimeIndex = "$env:ProgramData\DPE\revAgent\package\installer\runtime-mcp-server\build\index.js"
& $node $runtimeIndex spatial-store preview --snapshot-id "<snapshot id>"
& $node $runtimeIndex spatial-store purge --snapshot-id "<snapshot id>" --confirm
```

The purge line is permitted only after the user approves that preview and exact
selector. A warning, nonzero exit, `partial=true`, or artifact cleanup failure
remains incomplete and must not be recorded as successful maintenance.

Evidence status: passed locally on 2026-07-11. Phase 0 compatibility, Phase 1a
schema/contract, store, maintenance CLI, atomic capture, runtime smoke,
installer smoke, and MCP/Revit payload freshness all completed successfully.
The runtime smoke registered 32 revAgent tools. No live Revit assertion is
claimed by this gate.

## Gate C — aggregate local and protected-CI equivalent

From the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-ci.ps1
```

`test-ci.ps1` restores packages with normal `npm ci` in isolated temporary
copies and is the local equivalent of the protected `Engineering gates` job.
Neither command deploys, publishes, writes ProgramData, or touches NAS stable.

Evidence status: passed locally on 2026-07-11. `scripts/test-all.ps1` completed
in 173.2 seconds with `All local non-Revit tests passed.`
`scripts/test-ci.ps1` completed in 177.7 seconds with
`All CI-safe revAgent engineering gates passed.` Both ran with normal npm
lifecycle scripts enabled and restored MCP packages in isolated work copies.
Their signed publish/readiness checks used temporary test roots only; no real
release channel, ProgramData installation, or NAS stable state changed.

## Gate D — live Revit acceptance

This gate is separate from `test-all.ps1` and `test-ci.ps1`. Use the refreshed
matching runtime and DLL payload on an operator-approved disposable or frozen
reference model. Before every non-status call, run `get_revit_mcp_status`; do
not overlap Revit commands.

The live harness is required at:

```powershell
$databasePath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1a\acceptance.db"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-spatial-phase1a-live.ps1 `
  -LevelNames "<exact host Level name>" `
  -DatabasePath $databasePath `
  -TestConcurrentEdit
```

If that harness is absent, incomplete, or has not run against the frozen
reference scope, this gate is pending and Phase 1a cannot be marked complete.
A run without `-DatabasePath` uses a temporary local database, removes it after
emitting baseline evidence, returns Gate D pending, and can never set
`accepted=true`. Full acceptance requires an explicit retained local database
outside the repo so restart/session liveness can be rechecked. Capture and
recheck evidence use separate defaults and never overwrite each other:

- `%LOCALAPPDATA%\revAgent\spatial\phase1a\phase1a-live-capture-evidence-latest.json`
- `%LOCALAPPDATA%\revAgent\spatial\phase1a\phase1a-live-recheck-evidence-latest.json`

UNC paths and mapped network drives are rejected by numeric Windows `DriveInfo`;
only ready Fixed, Removable, or RAM roots may hold the temporary config,
database, or sanitized evidence.

`-TestConcurrentEdit` is required for `accepted=true`. After the first valid
native preparation continuation or nonterminal data page, the harness pauses
and asks the operator to commit one relevant model edit. It then requires the
very next cursor response to be `capture_interrupted_by_change`, runs the atomic
orchestrator with zero retries, and proves that committed snapshot identities
and staging-row counts did not change. Without this switch the repeated frozen
capture may still produce useful sanitized baseline evidence, but the process
returns a pending/non-success exit and cannot satisfy Gate D.

The frozen reference scope must normally contain connector nodes and the same
linked document through at least two distinct link placements. These store
checks are enabled by default. `-RequireConnectorEvidence:$false` or
`-RequireDoublePlacedLinkEvidence:$false` may be used only for a deliberately
narrow diagnostic scope; the corresponding evidence is recorded as `not_run`
and full Gate D acceptance remains false.

To verify the post-capture edit transition without letting the harness write the
model, retain the database and use the interactive pause:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-spatial-phase1a-live.ps1 `
  -LevelNames "<exact host Level name>" `
  -DatabasePath $databasePath `
  -PauseAfterCapture
```

The operator makes and commits one relevant model edit only when prompted. The
harness then requires the persisted record to evaluate `stale` or `unknown`;
the harness itself sends no model-writing command. This `-PauseAfterCapture`
diagnostic is separate from the required concurrent-edit test and cannot by
itself yield full Gate D acceptance. After a Revit/runtime restart, the same
retained record can be checked without a new capture:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-spatial-phase1a-live.ps1 `
  -RecheckExisting `
  -DatabasePath $databasePath `
  -ExpectedRecheckLiveness unknown
```

The harness uses the built runtime public `capture_spatial_snapshot` and
`get_revit_mcp_status` handlers, checks the committed SQLite record and R*Tree,
and performs that public status preflight before each harness-issued non-status
action in addition to the runtime's own preflight. It fails
if the built runtime or connected DLL lacks the Phase 1a contract. Both data-page
and preparation work-continuation timing channels are mandatory; preparation
sample counts and ordered `discover`/`filter`/`extract`/`finalize` phase evidence
must be internally consistent. The gate is never called by `test-all.ps1` or
`test-ci.ps1`.

The CI-safe contracts, live harness, and recorded evidence together must prove:

1. Exact composite identity and canonical host-mm transform behavior for the
   declared host/link scope, including a positive connector-node count, the
   same linked `documentKey` bound to two distinct non-null placement ids, and
   <=0.5 mm transform round-trip error. Only counts are emitted; raw document,
   placement, connector, node, and snapshot ids stay out of evidence.
2. Every committed snapshot is one revision. CI-safe interrupted-capture tests
   prove the deterministic contract, while the operator-assisted live probe
   requires the next cursor to return `capture_interrupted_by_change` with
   `committed=false`, zero retries, unchanged committed snapshot identities,
   and unchanged staging count.
3. A committed edit after capture makes the stored revision evaluate `stale`,
   while restart/session change or a journal gap evaluates `unknown`; neither is
   silently treated as current.
4. Runtime-reported native Revit UI occupancy for both preparation work chunks
   and committed data-page chunks has p95 <=2 seconds and max <=5 seconds.
   Socket round-trip timing is retained separately for both channels and is not
   substituted for native UI occupancy. Aggregate evidence uses the worst
   reported native p95/max across both channels so preparation cannot disappear
   from the SLO result.
5. Total complete frozen reference-level capture has p95 <=45 seconds and the
   harness also records and enforces a bounded total maximum (default 60
   seconds).
6. Final `partial`, `coverageStatus`, omission classifications, page/byte totals,
   and liveness warnings are recorded independently from atomic commit.
7. Revit 2022 live behavior passes. Any broader cross-version support claim
   requires matching live evidence on those versions; compile-only success is
   not deployment support.

Store the evidence outside the repo unless a compact, reviewed summary is
explicitly added here. Do not package model geometry, element identifiers, room
data, or raw snapshot pages in Git or release artifacts.

Evidence status: pending. The refreshed source/runtime/DLL set has not been
installed or exercised against an operator-approved frozen Revit reference
scope. Connector, double-placement, concurrent-edit, post-edit liveness, and
native UI/capture SLO evidence therefore remain unclaimed.

## Gate E — delivery boundary

After Gates A-C pass and Gate D has the required acceptance evidence:

1. Commit source and matching generated payloads together on the topic branch.
2. Open a draft PR; let protected Engineering gates and review run.
3. Merge only after required checks and actionable comments are cleared.
4. Protected `main` automatically builds and validates the signed source-free
   release root; it does not publish NAS stable.
5. Production publish requires separate human approval and manual
   `workflow_dispatch` with `publish_to_nas=true`.
6. Verify the signed CD result, `channels\stable.json`, representative live
   smoke, and rollout closure audit before declaring deployment complete.

Never publish from a topic branch, a dirty tree, a red CI run, or pending live
acceptance evidence.

Evidence status: pending. No commit, push, PR, protected remote CI, signed
release build, deploy, or NAS publish was performed as part of the local
implementation pass.

## Completion record

- CI-safe gates: passed locally on 2026-07-11 (`test-all`, `test-ci`)
- Revit payload freshness: passed locally on 2026-07-11
- Live identity/transform/liveness/concurrent-edit gate: pending
- Performance SLO evidence: pending
- Protected PR/CI: pending
- Signed build/validation: pending
- Manual NAS publish: not authorized by this acceptance checklist

Phase 1a remains unaccepted until the applicable implementation exit gates are
recorded with concrete evidence. Phase 1b work must not be inferred from this
document.
