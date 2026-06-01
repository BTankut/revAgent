# revAgent Architecture Hardening Coding Plan

This plan turns the current architecture review into a bounded engineering
workstream. The goal is not to redesign revAgent. The goal is to keep the
existing architecture clean as it grows: small code surfaces, explicit
contracts, better regression gates, and fewer places where hidden drift can
accumulate.

## Principles

- Keep the current two-speed model: stable Revit bridge primitives plus faster
  runtime MCP tools.
- Prefer small guardrails over broad rewrites.
- Do not move Revit-loaded code unless the change clearly belongs there.
- Do not add abstractions unless they shrink real duplication or reduce risk.
- Treat dynamic C# as a prototyping and escape path, not the default home for
  repeated production workflows.
- Every phase must leave the repo in a tested, deployable state.

## Completion Definition

This hardening pass is complete only when all six tracks below have shipped
with code or test enforcement. Documentation alone is not enough.

1. New TypeScript runtime code cannot add `@ts-nocheck` casually.
2. Runtime tool responses have a shared minimal result contract.
3. Repeated or risky dynamic-code patterns have an explicit promotion path.
4. Oversized modules have at least one practical split or ownership boundary.
5. Production write paths have targeted regression gates.
6. Build payload policy is verified instead of assumed.

## Phase 1 - TypeScript Safety Baseline

### Code Work

- Add a lightweight repository check that fails when new runtime/docs MCP source
  files start with `// @ts-nocheck` unless they are listed in a deliberate
  temporary allowlist.
- Keep only the files that currently require real type work in the allowlist,
  and make the list fail on both new and stale `@ts-nocheck` usage.
- Add a "new files must be checked" rule to `scripts/test-all.ps1` through the
  installer smoke suite or a dedicated script.
- Remove `@ts-nocheck` from the lowest-risk files in the same pass:
  `installer/runtime-mcp-server/src/index.ts`,
  `installer/runtime-mcp-server/src/tools/register.ts`,
  `installer/revit-api-docs-mcp/src/index.ts`, and
  `installer/revit-api-docs-mcp/src/tools/register.ts`.

### Acceptance Criteria

- `npm run test` passes in both MCP packages.
- The new no-new-nocheck gate is covered by local tests.
- At least four low-risk files no longer use `@ts-nocheck`.
- The allowlist is reduced to the current hard blockers only:
  runtime connection/socket/helper/telemetry/database service boundaries and
  docs `docIndex`.

### Non-Goals

- Do not switch `strict:true` globally in this phase.
- Do not rewrite tool implementations just to satisfy type purity.

## Phase 2 - Shared Runtime Result Contract

### Code Work

- Add a small shared result helper in the runtime MCP server for these fields:
  `success`, `guarded`, `state`, `action`, `error`, `warnings`, and `notices`.
- Use it first in guard-heavy and write-adjacent tools:
  `send_code_to_revit_safe`, `set_element_parameter`, `set_schedule_cells`,
  `set_schedule_cells_by_text`, `export_revit_view_image`, and
  `export_revit_coordination_image`.
- Add response-shape smoke assertions for guarded, dry-run, failed, and
  successful result paths where they can run without Revit.

### Acceptance Criteria

- Existing response content remains compatible for Codex users.
- New helper reduces duplicated guarded/failure payload creation.
- Tests assert the minimal contract on representative runtime responses.

### Non-Goals

- Do not force every existing C# bridge response into one large schema.
- Do not remove defensive parsing until the bridge/runtime boundary is proven
  stable by tests.

## Phase 3 - Dynamic-To-Native Promotion Rule

### Code Work

- Add a small registry file for promoted or candidate dynamic patterns.
- Extend usage-summary output to surface repeated dynamic-code patterns by hash,
  write-pattern count, manual transaction flag, and candidate action.
- Add a documented rule: a dynamic C# pattern becomes a native runtime tool
  candidate when it repeats, writes model data, creates project view data, or
  needs predictable verification.

### Acceptance Criteria

- Daily usage summaries expose candidate dynamic patterns without reading raw
  model data.
- The rule is machine-checkable enough to show candidates in JSON.

### Non-Goals

- Do not auto-generate native tools from dynamic snippets.
- Do not block one-off read-only dynamic probes.

## Phase 4 - Large Module Boundary Split

### Code Work

- Split `installer/runtime-mcp-server/src/utils/telemetry.ts` along practical
  boundaries:
  telemetry identity and summarization, durable event writing, live status
  writing, and MCP server wrapping.
- Keep public imports stable through a compatibility barrel if needed.
- Add focused tests around live feed and telemetry summary behavior before and
  after the split.

### Acceptance Criteria

- Runtime tests pass.
- Live dashboard tests pass.
- No behavior changes in event schema unless explicitly documented.
- `telemetry.ts` is reduced to an orchestration/export surface instead of a
  broad implementation file.

### Non-Goals

- Do not refactor every large file in one commit.
- Do not touch Revit add-in binaries for this runtime-only split.

## Phase 5 - Production Write Regression Gates

### Code Work

- Add or extend targeted tests for:
  `send_code_to_revit_safe` write rejection,
  `set_element_parameter` dry-run/guard preflight,
  `set_schedule_cells` dry-run/expected-current guard,
  `set_schedule_cells_by_text` bounded row-text and ambiguity guards,
  dynamic manual transaction guard behavior.
- Keep Revit-required tests in `scripts/test-commandset-live.ps1`.
- Keep non-Revit tests in `test-all.ps1`.

### Acceptance Criteria

- Non-Revit tests cover guard logic without requiring a model.
- Live Revit test gate clearly states prerequisites and validates the risky
  transaction/write boundaries.
- Guarded behavior is reported as protected behavior, not a model failure.

### Non-Goals

- Do not create broad end-to-end tests that require an arbitrary production
  model.
- Do not add write tests that can mutate operator-owned project data.

## Phase 6 - Build Payload Policy And Verification

### Code Work

- Add a source-vs-payload verification script for TypeScript build output and
  Revit payload files.
- Keep committed `build/` and DLL payloads for now because the installer and
  NAS package contract consumes them.
- Add a release preflight that fails when source changes require regenerated
  payloads but payload files were not refreshed.
- Document the future condition for removing generated payloads from Git:
  deterministic CI/package generation with hash verification and workstation
  installer coverage.

### Acceptance Criteria

- Local smoke or release preflight can detect stale runtime build output.
- Revit source changes still require payload refresh.
- No deployment path is weakened while cleaning technical debt.

### Non-Goals

- Do not remove committed generated artifacts in this pass.
- Do not introduce CI-only release behavior until local/NAS deployment has a
  verified replacement path.

## Execution Order

1. Phase 1: create the enforcement gate and remove low-risk nocheck markers.
2. Phase 2: introduce shared runtime result helpers and migrate high-risk
   guarded/write-adjacent paths.
3. Phase 5: strengthen write regression gates before deeper refactors.
4. Phase 4: split telemetry after tests protect live/usage behavior.
5. Phase 3: add dynamic promotion visibility using the existing telemetry
   pipeline.
6. Phase 6: add payload freshness checks before any deploy.

This order keeps the repo stable while progressively reducing the places where
growth can turn into hidden technical debt.

## Implementation Status

Status: implemented as a single hardening pass.

### Phase 1 - TypeScript Safety Baseline

- Added `scripts/test-typescript-nocheck-policy.ps1` and wired it into
  `scripts/test-all.ps1`.
- Removed `@ts-nocheck` from all compile-clean MCP source files.
- Current explicit allowlist is six files:
  `ConnectionManager.ts`, `SocketClient.ts`, `revitToolHelpers.ts`,
  `telemetry.ts`, `database/service.ts`, and docs `docIndex.ts`.
- A temporary all-file probe showed the remaining six are real utility/data
  typing debt, not casual unchecked markers.

### Phase 2 - Shared Runtime Result Contract

- Added `installer/runtime-mcp-server/src/utils/runtimeResult.ts`.
- Applied the shared success/guarded/failure contract to
  `send_code_to_revit_safe`, `set_element_parameter`, `set_schedule_cells`,
  `set_schedule_cells_by_text`, `export_revit_view_image`, and
  `export_revit_coordination_image`.
- Added `runtime-result-test` and write/export response-shape assertions.

### Phase 3 - Dynamic-To-Native Promotion Rule

- Added promotion rules and a small registry under `config/`.
- Usage summaries now emit repeat threshold, promotion reasons, registry
  matches, and a candidate action for dynamic-code patterns.

### Phase 4 - Large Module Boundary Split

- Split runtime/install identity helpers into `runtimeIdentity.ts`.
- Split durable telemetry/live-status file writing queues into
  `telemetryWriters.ts`.
- Kept `telemetry.ts` as the compatibility export/orchestration surface for
  existing imports.

### Phase 5 - Production Write Regression Gates

- Added write contract assertions for safe dynamic execution,
  element-parameter writes, schedule-cell writes, and export failure contracts.
- Kept Revit-mutating coverage in the existing live commandset gate.

### Phase 6 - Build Payload Policy And Verification

- Added `scripts/test-mcp-build-payload-freshness.ps1` for TypeScript build
  payload freshness and Revit DLL payload presence/freshness.
- Wired the payload freshness gate into `scripts/test-all.ps1`.
- Wired the same gate into `installer/nas/publish-nas-release.ps1` as a release
  preflight before staging a NAS package.

### Verification Commands

- `npm run test` in `installer/runtime-mcp-server`
- `npm run test` in `installer/revit-api-docs-mcp`
- `scripts/test-usage-intelligence.ps1`
- `scripts/test-typescript-nocheck-policy.ps1`
- `scripts/test-mcp-build-payload-freshness.ps1`
- `scripts/test-all.ps1`
