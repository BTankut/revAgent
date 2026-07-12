# revAgent Spatial Context Engine — Phase 1a Acceptance

Status: Gates A-E passed; Phase 1a accepted on 2026-07-12; Phase 1b not
started.

This document defines and records the accepted Phase 1a truth foundations only.
It does not replace the historical Phase 0 acceptance record, and it does not
authorize or imply any Phase 1b implementation. Actual commands, versions,
model scope, timings, and artifacts are recorded here only after each gate runs
successfully.

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

Evidence status: passed locally on 2026-07-11 and refreshed after the final
tracker fix on 2026-07-12. `npm ci` and `npm run build:release` completed
successfully; the hardened runtime bundle and v0.2 schemas were regenerated.
Revit 2022 rebuilt with zero warnings/errors and refreshed the committed
installer payload plus `installer/revit-payload-manifest.json`. Revit
2023/2024/2025 compile-only builds also completed with zero errors on the
initial pass; the latter targets emitted compatibility/deprecation warnings but
produced their expected DLLs. The final matching Revit 2022 payload was
installed locally only for Gate D; no production deploy or NAS publish was
performed.

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

Evidence status: passed locally on 2026-07-11 and rerun after the final fixes on
2026-07-12. Phase 0 compatibility, Phase 1a schema/contract, store, maintenance
CLI, atomic capture, updater native-dependency/cache regressions, runtime smoke,
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

Evidence status: final rerun passed locally on 2026-07-12.
`scripts/test-all.ps1` completed in 185.1 seconds with
`All local non-Revit tests passed.` `scripts/test-ci.ps1` completed in 189.9
seconds with `All CI-safe revAgent engineering gates passed.` Both ran through
the documented Windows PowerShell path with normal npm lifecycle scripts
enabled and restored MCP packages in isolated work copies. Their signed
publish/readiness checks used temporary test roots only; no real release
channel or NAS stable state changed.

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
   same linked `documentKey` and `documentSessionId` bound to two distinct
   non-null placement ids, and <=0.5 mm transform round-trip error. Managed
   Revit wrapper churn must not split one native linked document into multiple
   process-local sessions. Only counts are emitted; raw document, placement,
   connector, node, and snapshot ids stay out of evidence.
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

Evidence status: passed on Revit 2022 on 2026-07-12 against an
operator-approved disposable reference scope with an explicit retained local
database outside the repository. Two stable captures each committed one
complete page containing 3 sources, 909 nodes, 606 connector nodes, 909 R*Tree
entries, and zero omissions. The same linked document was proven through two
distinct placements with one shared document session/revision binding. Maximum
host/link transform round-trip error was 0 mm.

The repeated capture totals were 10.532 seconds and 3.123 seconds; aggregate
p95/max was 10.532 seconds. Worst reported native Revit UI occupancy across
data-page and preparation-work channels was 301 ms; preparation native p95/max
was 259 ms. The required operator-assisted concurrent edit interrupted the
first post-edit work continuation with `capture_interrupted_by_change`, zero
retries, `committed=false`, an unchanged committed snapshot identity set, and
zero staging rows before and after. The immediate post-edit probe returned
`stale` for two changed sources. After discarding the disposable edit, closing,
and reopening the saved fixture, the independent persisted-store recheck passed
with expected/observed `unknown`; the prior open-document session was not
misreported as current. Sanitized detailed capture and recheck evidence remains
outside Git and release artifacts.

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

Evidence status: passed on 2026-07-12.

- Topic commit `3b1c03c1` was delivered through PR #217 and squash-merged to
  protected `main` as
  `45d4d8126d4819c3baa5d4422c42552ae3a397b4`. Engineering gates,
  GitGuardian, and the xhigh Claude review gate passed. Protected `main` CI run
  `29176710402` passed.
- Automatic signed source-free build/validation run `29176710420` passed
  without publishing. The separately approved manual run `29176890563` then
  published the same protected-main payload to canonical NAS stable.
- Stable `2026.07.12.532-45d4d812` identifies merge commit
  `45d4d8126d4819c3baa5d4422c42552ae3a397b4`, release sequence
  `20260712023442`, and ZIP SHA256
  `6684A1269617BBD44348BFE7187462AFC624EF261DB78C855889B28DE2BECD1D`.
  Active-release signed readiness returned `readyForEnforce=true` with key
  `revagent-prod-rsa-2026q3`, no private material, and no source/developer
  artifacts.
- The DESKTOP-OKNV128 Revit 2022 pilot ran the freshly installed runtime
  `2026.07.12.532-45d4d812`, tool surface
  `revit-mcp-runtime-tools.42`, and passed the canonical live commandset smoke.
  Durable smoke evidence is
  `reports\rollout\live-smoke-latest.json` under the canonical NAS root.
- The first closure audit correctly exposed nine outdated standard-user
  workstations. NET01, MARINA, HAFIZE, and WS3 were reachable, updated through
  their interactive user context, and independently reported the signed stable
  version, sequence, ZIP hash, and `integrityState=verified`.
- The operator explicitly accepted an open-workstations-only Phase 1a rollout
  scope. Powered-off EMIN, OGUZHAN, OMER, SERDAR, and YASAR remain named as
  pending normal scheduled stable uptake rather than being reported as updated.
  The immutable scope record is
  `C:\ProgramData\DPE\revAgentOps\rollout-readiness-phase1a-gate-e.json`
  (SHA256
  `08C345544770839DEFA13863FF403A97595F54B1C410D4B20909B1DC9953108F`).
  Final closure snapshot
  `C:\ProgramData\DPE\revAgentOps\readiness\rollout-readiness-20260712-062222.json`
  (SHA256
  `2B301CE857736269620494D386354792C83A8695BEE4210CCA1CE7FED2BFD1B0`)
  returned `ready=true`, `actionRequiredCount=0`, four in-scope/current
  workstations, verified live smoke, canonical channel roots, and compatibility
  retirement readiness.

## Completion record

- CI-safe gates: passed locally on 2026-07-12 (`test-all`, `test-ci`)
- Revit payload freshness: passed locally on 2026-07-12
- Live identity/transform/liveness/concurrent-edit gate: passed on Revit 2022
  on 2026-07-12
- Performance SLO evidence: passed on 2026-07-12
- Protected PR/CI: passed through PR #217 and main CI run `29176710402`
- Signed build/validation: passed in run `29176710420`
- Manual NAS publish: passed in separately approved run `29176890563`
- Representative live smoke and rollout closure: passed for the explicit
  open-workstations-only scope; five powered-off machines remain pending normal
  scheduled uptake

Phase 1a is accepted. Phase 1b has not started and is not authorized by this
record.
