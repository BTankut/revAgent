# revAgent Spatial Context Engine — Phase 1b Acceptance

Status: Gates A-E passed on 2026-07-12. Phase 1b is accepted. Phase 1c is not
started or authorized by this record.

This document defines the acceptance boundary for Phase 1b deterministic
queries and snapshot diff. Evidence is recorded only after the corresponding
gate runs successfully. A fixture definition, green unit test, or draft pull
request is not production acceptance by itself.

## Capability boundary under test

Phase 1b remains read-only with respect to Revit model data. It adds the public
`query_spatial_context`, `compare_spatial_snapshots`, and
`summarize_spatial_state` tools over atomically committed spatial snapshots.
The native SpatialSnapshot v0.3 extraction contract must provide the stable
system, profile, insulation/envelope, connector-adjacency, and versioned
fingerprint evidence needed by those runtime tools. It must not infer topology
from coincident connector coordinates.

The first analytic-distance support boundary is straight round swept profiles
with an explicit diameter and insulation envelope. SpatialSnapshot v0.3 does
not carry a sufficient rectangular-profile orientation basis for an exact
analytic distance. Rectangular cases therefore return completed AABB candidate
evidence with `basis=aabb`, `precisionClass=candidate`, and
`verdictCapability=screening_only`; a candidate separation may be reported but
is not an exact analytic measurement or clearance verdict. Rectangular cases
are not included in the measured-distance support claim.

`query_spatial_context` supports bounded retrieval plus deterministic
`relation_between`, `nearest_elements`, `elements_within`,
`clearance_between`, `trace_connectivity`, `locate_in_space`, and
`above_below` operations. Every operation echoes its inputs and reports its
evidence basis, precision class, verdict capability, snapshot id, revision
fingerprint, and liveness. `context_only` or `screening_only` output is never a
live clearance or clash verdict.

`compare_spatial_snapshots` accepts only complete, compatible snapshots and
distinguishes source availability, transform, movement, geometry, property,
connector, connectivity, and affected-neighborhood proximity changes.
Different revisions are expected; an incompatible scope, coordinate policy,
unsupported schema-minor transition, or partial snapshot must fail closed.
AABB-only elements have no rotation-invariant primitive: detectable AABB or
geometry-fingerprint drift is reported under `geometryIndeterminate`, and any
snapshot-specific AABB-only gap forces `capabilityCoverage.full=false` rather
than silently claiming a complete geometry classification.

`summarize_spatial_state` is a compact, bounded, advisory view for local
reasoning. It is never quotable as verification. Spatial geometry, model names,
element/connector ids, raw fixture pages, and real-project eval transcripts
remain local and must not enter release packages or usage-intelligence events.

## Non-negotiable exit criteria

Phase 1b may be accepted only when all of the following are true:

1. The frozen operation gold set has zero wrong containment, direction, or
   topology results, including false containment inside a Room hole and false
   connectivity from coincident but disconnected connectors.
2. Every supported analytic-distance class has Revit-measured ground truth and
   every observed absolute error is at most 1 mm. Unsupported geometry returns
   an explicit unsupported/indeterminate result rather than an invented value.
3. Public-handler bounded query latency has p95 at or below 750 ms for every
   measured operation class. An aggregate average may not hide a slower class.
4. Public-handler reference-level diff latency has p95 at or below 3 seconds.
5. Spatial Grounding Protocol agent eval groups 1, 2, 4, 5, and 6 all pass
   their required variants. Static JSON validation alone is not an agent-eval
   pass.
6. `partial`, `stale`, and `unknown` evidence never supports a current-state
   claim; historical diff wording cites both snapshot and revision identities.
7. No Phase 1b tool emits `live_verdict`, "clearance verified", "clash-free",
   or equivalent language.
8. Gates A-E below all pass. Phase 1c remains unstarted.

## Gate A — generated payloads and native contract

After source changes stabilize:

```powershell
cd .\installer\runtime-mcp-server
npm ci
npm run build:release
cd ..\..

powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2022
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2023 -SkipPayloadCopy
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2024 -SkipPayloadCopy
powershell -ExecutionPolicy Bypass -File .\scripts\build-revit-plugin.ps1 -RevitVersion 2025 -SkipPayloadCopy
```

Required results:

- SpatialSnapshot v0.3 source, committed build, hardened release schemas,
  Revit 2022 DLL payload, command manifests, and
  `installer/revit-payload-manifest.json` move together.
- v0.1 and v0.2 capture/store compatibility remains explicitly tested.
- v0.3 connector adjacency is stable, sorted, deduplicated, and never inferred
  from location alone.
- Placement, geometry/shape, property, and topology fingerprints are versioned
  and independently meaningful.
- Revit 2023-2025 compile-only success is not reported as deployed live
  support.

Evidence status: passed on 2026-07-12. The runtime release bundle, Revit 2022
payload, command manifests, and payload manifest were refreshed together; the
Revit 2022 build completed with zero warnings and zero errors.

## Gate B — targeted CI-safe contracts and gold fixtures

From `installer/runtime-mcp-server` after `npm run build`:

```powershell
npm run spatial-phase0-contract-test
npm run spatial-phase1a-contract-test
npm run spatial-phase1a-store-test
npm run spatial-phase1a-capture-test
npm run spatial-phase1b-contract-test
npm run spatial-phase1b-store-test
npm run spatial-phase1b-fingerprint-test
npm run spatial-phase1b-query-test
npm run spatial-phase1b-diff-test
npm run spatial-phase1b-summary-test
npm run spatial-phase1b-golden-test
npm run spatial-phase1b-eval-contract-test
npm run spatial-phase1b-agent-evidence-test
```

Then from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer-smoke.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-mcp-build-payload-freshness.ps1
```

Required CI-safe assertions include:

- strict v0.3 normalized contracts and explicit v0.2-to-v0.3 capability
  adaptation without fabricated missing fields;
- transactional store migration/recovery, committed-only visibility, R*Tree
  candidate completeness, purge/retention of any edge or cached-relation data,
  and no production full-table fallback;
- canonical fingerprint invariance under key/input ordering, with translation,
  resize, property change, and topology change affecting only their intended
  classifications;
- deterministic ordering, opaque snapshot-bound cursors, bounded result size,
  no duplicate/omitted rows, and exact normalized golden outputs;
- Room boundary/hole/vertical containment, direction tolerance, nearest tie
  ordering, connector branches/cycles/disconnected coincidence, supported
  straight-round analytic distances, rectangular-profile screening-only
  behavior, and unsupported-geometry fail-closed behavior;
- complete-scope diff classification for link reload/add/remove/unload,
  placement transform, moved elements, resized-but-unmoved ducts, system
  properties, connector rewiring, journal gaps, and partial/incompatible guards;
- advisory-only state summaries and telemetry exclusion of spatial content;
- structural presence of all required agent eval variants and their hard-fail
  rules; strict v2 evidence-schema checks; and mutation tests that reject v1
  evidence, self-declared pass booleans, transcript/metadata/final-response
  tampering, missing required tools, forbidden tools, missing status preflights,
  and unsupported current/clearance/no-clash claims.

The repository fixtures are synthetic/sanitized contract evidence. Real model
geometry or identities must not be committed to Git.

Evidence status: passed on 2026-07-12. The full runtime test chain, Phase 1b
gold/contract/evidence suites, installer smoke, and committed payload freshness
checks all passed.

## Gate C — aggregate local and protected-CI equivalent

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-all.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-ci.ps1
```

`test-ci.ps1` must restore dependencies in isolated temporary copies with
normal npm lifecycle scripts, compile strict TypeScript, run the complete
runtime test chain, and verify generated payload freshness. Neither command
deploys, publishes, writes ProgramData, or changes NAS stable.

Evidence status: passed on 2026-07-12. Final `test-all.ps1` and `test-ci.ps1`
runs completed successfully in 231.0 seconds and 227.8 seconds respectively.

## Gate D — frozen reference, Revit ground truth, performance, and agent evals

This gate is separate from `test-all.ps1` and `test-ci.ps1`. It requires the
matching built runtime and Revit payload, an operator-approved disposable or
frozen Revit 2022 fixture, and a retained local database outside the repository.
Before every non-status revAgent call, run `get_revit_mcp_status`; do not overlap
Revit commands.

### Actual-agent evidence assembly

All 11 evals must run as real Codex Desktop subagent turns named
`/root/phase1b_actual_eval_<evalId>`. The task trigger must contain the exact
repository prompt, the generated `REVAGENT_PHASE1B_AGENT_EVAL:` identity marker,
and the exact canonical `REVAGENT_PHASE1B_EVAL_CASE:` payload containing the
prompt, context, expected output, hard-fail rules, assertions, and tool rules. Use
the permanent preparation command to produce that marker and the only approved
platform execution source for the run:

```powershell
$argsPath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\eval-101-request.json"
$taskSpecPath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\eval-101-task-spec.json"
$databasePath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\acceptance.db"
node .\scripts\spatial-phase1b-agent-evidence.mjs prepare `
  --eval-id 101 `
  --fixture "$env:LOCALAPPDATA\revAgent\spatial\phase1b\phase1b-fixture.rvt" `
  --database $databasePath `
  --args $argsPath `
  --output $taskSpecPath
```

Codex Desktop stores the parent task payload as `encrypted_content`; the JSONL
plaintext contains only the `NEW_TASK` envelope. The assembler does not pretend
to decrypt or substring-match that prompt. Its trust root is the depth-1
`thread_spawn.parent_thread_id`/agent path, manifest-selected session and turn
ids, plus the collector invocation's plaintext full canonical `evalCase`
payload and matching hash. The markers remain instructions to the agent; the
exact case is independently recomputed from `evals/evals.json` at assembly.

Send `taskTrigger` as the parent-to-subagent task message, and execute
`collectorExecSource` once, verbatim, through the platform `exec` tool. The
assembler treats either no terminal line ending or exactly one terminal LF or
CRLF as the same platform serialization boundary; the generated
`collectorExecSource` itself remains byte-for-byte unchanged and has no line
ending. Two line endings, a trailing space, tab, bare CR, semicolon, or any
other appended source fail closed. No other `custom_tool_call` is allowed in
the selected turn. The permanent collector itself invokes
`get_revit_mcp_status`, verifies that `activeTask` is clear, validates the
target request with the real public Zod schema, then invokes the one required
public handler and atomically writes an immutable v2 trace directly under the
local `agent-evidence` directory. Both status and
target are locked to `tcp://localhost:8080` where applicable. The collector
binds the canonical explicit Phase 1b database path, sets
`REVAGENT_SPATIAL_DB_PATH` before importing any runtime handler/store module,
and records the same path hash in its invocation, stdout result, and trace. It
also hashes the exact fixture bytes, its source closure, the full executed
runtime `build/` tree, both handler responses, and the trace bytes. It resolves
every referenced snapshot from the retained SQLite store and records exact
host document key, scope fingerprint, source-binding fingerprint, and revision
fingerprint.

The assembler parses the platform `custom_tool_call` and
`custom_tool_call_output` pair by `call_id`. It decodes the collector stdout
sentinel and requires exact agreement among the command request, stdout,
immutable trace bytes, public request/response hashes, timestamps, and
invocation nonce. Merely mentioning a trace path or SHA-256 in a turn does not
bind evidence. `raw-agent-run-trace.v1`, `agent-response-attestation.v1`, temp
finalizers, legacy self-booleans, unpaired outputs, extra inspection commands,
raw Revit code, model-write tools, and deploy/update commands fail closed.
Required and forbidden tools come directly from `evals/evals.json`.

The live harness reopens every recorded snapshot in the same retained explicit
database and compares those bindings to its operator-approved frozen-fixture
capture and current status runtime identity. A sidecar fixture hash, a remote
endpoint, another active model, a stale transitive build module, or a snapshot
from another document/scope/source family cannot satisfy Gate D.

Create one local assembly manifest using schema
`revagent.spatial.phase1b.agent-evidence-assembly.v1`:

```json
{
  "schemaVersion": "revagent.spatial.phase1b.agent-evidence-assembly.v1",
  "parentThreadId": "<session_meta thread_spawn.parent_thread_id UUID>",
  "fixturePath": "C:\\...\\phase1b-fixture.rvt",
  "databasePath": "C:\\...\\acceptance.db",
  "evalContractPath": "C:\\...\\revAgent\\evals\\evals.json",
  "runtimePackagePath": "C:\\...\\revAgent\\installer\\runtime-mcp-server\\package.json",
  "runs": [
    {
      "evalId": 101,
      "agentRunId": "<session_meta.payload.id UUID>",
      "turnId": "<task_started/task_complete turn UUID>",
      "transcriptPath": "C:\\Users\\...\\.codex\\sessions\\...\\rollout-...jsonl"
    }
  ]
}
```

`runs` must contain exactly one entry for each required eval id
`101, 102, 103, 104, 105, 201, 202, 401, 501, 502, 601`. Then assemble and
independently revalidate the detailed local evidence:

```powershell
$agentEvalEvidencePath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\phase1b-agent-evals-v2.json"
$assemblyManifestPath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\agent-evidence-assembly.json"
$fixturePath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\phase1b-fixture.rvt"

node .\scripts\spatial-phase1b-agent-evidence.mjs assemble `
  --manifest $assemblyManifestPath `
  --output $agentEvalEvidencePath

node .\scripts\spatial-phase1b-agent-evidence.mjs validate `
  --evidence $agentEvalEvidencePath `
  --fixture $fixturePath `
  --database $databasePath
```

After validation, set the operator-reviewed ground-truth manifest's
`agentEvalEvidenceSha256` to the lowercase, unprefixed SHA-256 of this exact v2
evidence file. Any regenerated evidence invalidates the old manifest binding.

The output schema is `revagent.spatial.phase1b.agent-evals.v2`. Every run carries
the transcript-derived provider, model, exact agent run id and turn id, raw
transcript/turn/task hashes, complete platform-call inventory, final response,
public-handler trace, collector/runtime/fixture hashes, and deterministically
recomputed tool, response, trace-verdict, entity-grounding, and forbidden-claim
checks. Labels such as `Duct-A` are rejected unless that exact label is present
in the bound public tool response; caller-controlled request text such as
`taskName`, filters, or prompt aliases is not entity evidence. Contrast clauses
are audited independently, so wording such as `not verification, but ...` does
not disclaim the claim after `but`. Stale/unknown recovery evidence must be one
successful, unguarded, completed, atomic, current, non-partial, complete capture
whose top-level and nested snapshot trust fields, snapshot id, and revision
agree. Relation-citation evals also require an approved deterministic relation
operation and an affirmative citation of its exact computed relation; provenance
alone or a disclaimed relation is insufficient. The
assembly-manifest path and exact bytes are also hash-bound and re-read during
validation. Top-level or run-level `actualAgentRun`, `passed`,
`toolTracePassed`, `forbiddenClaimCheckPassed`, and manually supplied
`claimAudit` fields are rejected. Existing v1 evidence and evidence produced by
the old temp recorder are invalid and all affected evals must be rerun. A
hard-coded response recorder, fabricated JSONL, path/hash string mention, or
static JSON is never an agent-eval pass.

The required harness location is:

```powershell
$databasePath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\acceptance.db"
$evidencePath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\phase1b-live-evidence-latest.json"
$groundTruthManifestPath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\ground-truth.json"
$fixturePath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\phase1b-fixture.rvt"
$agentEvalEvidencePath = Join-Path $env:LOCALAPPDATA "revAgent\spatial\phase1b\phase1b-agent-evals-v2.json"

powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-spatial-phase1b-live.ps1 `
  -LevelNames "<exact host Level name>" `
  -FixturePath $fixturePath `
  -DatabasePath $databasePath `
  -EvidencePath $evidencePath `
  -GroundTruthManifestPath $groundTruthManifestPath `
  -AgentEvalEvidencePath $agentEvalEvidencePath `
  -RepeatCount 20
```

If the harness is missing, if the retained database is absent, or if an
operator-approved ground-truth manifest has not been evaluated, Gate D remains
pending. The harness itself must not write the Revit model. Any base/head model
state preparation is a separate, explicitly approved disposable-fixture action.

The live evidence must prove:

1. v0.3 system/profile/insulation/fingerprint fields and reciprocal connector
   adjacency are present for the declared supported cases.
2. The same source through two link placements retains distinct placement-aware
   node identities and correct host transforms.
3. Every operation-gold case returns its exact normalized expected result, with
   `wrongGoldAnswerCount=0` separately reported for containment, direction, and
   topology.
4. Revit-measured analytic-distance evidence covers every declared supported
   profile class and reports `maxAbsoluteErrorMm <= 1`. The initial class is
   straight round-to-round swept profiles; rectangular cases must stay
   completed AABB `candidate`/`screening_only` evidence with no exact-distance
   or clearance-verdict claim.
5. At least one warm-up precedes at least 20 measured public-handler samples.
   Per-operation p50/p95/max, the worst operation p95, diff p50/p95/max, sample
   counts, node/connector counts, runtime/tool/schema versions, and fixture
   identity hash are recorded. Every operation p95 is <=750 ms and reference
   diff p95 is <=3000 ms.
6. Partial, stale, unknown, unsupported, ambiguous, and incompatible inputs fail
   closed without current-state, completeness, topology, or clearance claims.
   For stale/unknown agent evals, the recovery `capture_spatial_snapshot` may
   correctly return complete/current; the agent must still abstain from the
   requested relation until a node-bound deterministic query is run.
7. Actual agent runs for protocol eval groups 1, 2, 4, 5, and 6 pass. For every
   run, provider, model, agent run id, turn id, agent path, final response, and
   completion state are extracted from the completed Codex Desktop JSONL turn;
   the raw transcript and public-handler trace hashes match; the full runtime
   build tree, local endpoint, retained snapshot document/scope/source/revision
   family, and current runtime identity match the live harness; required and
   forbidden calls come from `evals/evals.json`; and response, entity-grounding,
   trace-verdict, and forbidden-claim checks are deterministically recomputed.
   Linting `evals/evals.json` is only a prerequisite.

Detailed evidence stays outside Git. A reviewed summary may record only coarse
counts, durations, case ids, pass/fail state, and hashes; it must not include
model names, element ids, connector ids, coordinates, Room data, raw snapshots,
or prompts containing live project data.

Evidence status: passed on 2026-07-12. The frozen 32-node/20-connector fixture
produced zero wrong containment, direction, or topology gold answers; supported
analytic distance error was 0 mm; worst public-operation p95 was 74.809 ms and
reference diff p95 was 4.656 ms. All 11 required real Codex Desktop agent
variants passed transcript, tool-trace, entity-grounding, response-protocol,
and forbidden-claim recomputation. The sanitized local evidence SHA-256 is
`3bab1f91d6f3fb120ef09c8443bf0ccf1068c73a28fd483f2c3f368559336a47`.

## Gate E — protected delivery boundary

After Gates A-D pass:

1. Commit source and all matching generated payloads on one topic branch.
2. Open the pull request as draft. Iterate while the fast Engineering gates run.
3. Mark ready only after local acceptance is complete; trigger the risk-tiered
   Claude review once and arm squash auto-merge.
4. Merge only after Engineering gates, GitGuardian, Claude review, and all
   actionable comments are clear.
5. Protected `main` automatically builds and validates the signed source-free
   release root. That run does not authorize NAS stable publication.
6. Production publish requires separate human approval and manual
   `workflow_dispatch` with `publish_to_nas=true`.
7. Verify signed readiness, stable version/sequence/hash, representative Revit
   2022 smoke, and the final rollout-readiness audit.
8. Update only powered-on workstations in the accepted rollout scope. Powered-
   off workstations remain explicitly named as pending scheduled uptake and do
   not block the scoped closure audit. A reachable workstation with Revit open
   may be explicitly safe-deferred only when the signed updater proves
   `deferred-revit-close-required`, Revit is not closed automatically, and the
   machine remains named for normal scheduled uptake.

Never publish from a topic branch, dirty tree, red CI run, incomplete Gate D,
or unreviewed agent-eval result.

Evidence status: passed on 2026-07-12.

- PR #219 passed Engineering gates, GitGuardian, and the risk-tiered Claude
  review with no blocking issue, then squash-merged as
  `e0f8fc32dcec0ef8554d9c154c23049d8ee045f6`.
- Automatic signed build/validation run `29205583929` passed. Separately
  approved production run `29205836154` published
  `2026.07.12.534-e0f8fc32` with release sequence `20260712193201`.
- Signed readiness returned `readyForEnforce=true`. Stable and release manifest
  metadata agreed, both detached signatures were present, and the stable,
  manifest, and actual ZIP SHA-256 all equaled
  `9E60BA952BB5ACFF885380B61546B69D0539C349FA9038B1F3551C89E86AC0E3`.
- Final-tree Gate D live evidence SHA-256
  `3BAB1F91D6F3FB120EF09C8443BF0CCF1068C73A28FD483F2C3F368559336A47`
  remained accepted and proved the installed Revit 2022 commandset/plugin
  hashes matched the repository payload later signed from the merge.
- Post-publish HAFIZE Revit 2022 sample-model smoke passed the repository's
  standard commandset integration chain. Revit initially stopped at its
  existing `TaskDialog_Security_Unsigned_File_Loading` publisher modal. UI
  Automation re-verified the exact revAgent DLL path and signed-manifest SHA
  before selecting only `Load Once`; `persistentTrust=false` and `Always Load`
  was not selected. The canonical NAS smoke evidence SHA-256 is
  `66498919D2D3F3E6A2D9DC502A645B41583DA9C9E46AF69733588567BD5DA14D`;
  it records `passed=true`, Revit 2022, model `rme_basic_sample_project`, stable
  `2026.07.12.534-e0f8fc32`, and merge commit `e0f8fc32`. All temporary smoke
  and UI task/stage artifacts were removed; Revit was not force-closed.
- HAFIZE, MARINA, and WS3 updated through the signed interactive-user updater.
  Each reported `integrityState=verified`, the target release sequence/hash,
  source-free evidence `ok`, desktop-launcher evidence `ok`, and confirmed
  temporary task/stage cleanup.
- NET01 was reachable with Revit open. The signed updater returned
  `deferred-revit-close-required` and left version `532` and Revit untouched;
  it remains pending normal scheduled uptake after Revit closes.
- EMIN, OGUZHAN, OMER, SERDAR, and YASAR were powered off and remain pending
  normal scheduled uptake when next online.
- The final scoped closure record
  `C:\ProgramData\DPE\revAgentOps\readiness\rollout-readiness-20260712-231753.json`
  has SHA-256
  `4C0415239482025751CEDDB7B9F6706CDEB4ACBE6BF134423A769DB7E7515C69`
  and reports `ready=true`, `upToDateCount=3`, `outdatedCount=0`, live evidence
  `verified` from the post-publish HAFIZE smoke, and `actionRequiredCount=0`.

## Completion record

- Generated runtime/Revit payloads: passed
- Targeted CI-safe contracts and gold fixtures: passed
- Aggregate `test-all` and `test-ci`: passed
- Frozen operation gold set: passed; zero wrong containment/direction/topology answers
- Revit-measured analytic distance <=1 mm: passed; maximum error 0 mm
- Query p95 <=750 ms per operation: passed; worst p95 74.809 ms
- Reference-level diff p95 <=3 seconds: passed; p95 4.656 ms
- Spatial Grounding Protocol eval groups 1, 2, 4, 5, and 6: passed; 11/11 variants
- Protected PR/CI/review/merge: passed; PR #219 / merge `e0f8fc32`
- Signed build/validation and separately approved NAS publish: passed; stable
  `2026.07.12.534-e0f8fc32`
- Representative post-publish HAFIZE Revit 2022 commandset smoke and scoped
  rollout closure: passed; closure `ready=true`, `actionRequiredCount=0`

Phase 1b is accepted. Phase 1c has not started and is not authorized by this
record.
