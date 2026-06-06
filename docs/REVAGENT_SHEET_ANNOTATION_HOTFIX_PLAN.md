# revAgent Native Sheet Annotation Hotfix Plan

Status: in progress
Owner: revAgent Revit commandset + runtime wrapper
Source signal: 2026-06-03 and 2026-06-04 usage-intelligence, plus the L08 SPL / Uzel A side-chat workflow.

## Goal

Rebuild `inspect_sheet_text` as a native Revit commandset workflow, not as a
runtime-generated dynamic C# snippet.

The production problem is larger than a timeout. Users are asking revAgent to
compare schedule rows, plan annotations, placed views, customer notes, visual
evidence, and Excel-style reporting. The current runtime tool reads
DrawingSheet `TextNote` elements and placed schedule instances through dynamic
C#, but it does not cover text notes and tags inside the views placed on the
sheet. That gap pushes the LLM into raw or safe custom code.

The hotfix should provide a native, testable evidence surface:

- sheet text notes
- placed schedule instances and bounded schedule cells
- viewport-linked plan/view text notes
- optional viewport-linked tags
- sheet/view/viewport coordinates and ids
- native elapsed budgets and scan caps
- partial results before transport timeout
- guarded broad-search responses before expensive Revit work

## Product Principle

Do not make useful engineering searches impossible. Broad searches can be
intentional and valuable. The product standard is:

1. Infer or request a practical sheet/view scope first.
2. Scan in bounded chunks.
3. Return partial evidence instead of timing out.
4. Clearly report what was scanned, skipped, truncated, deferred, or stopped.

## Architecture Decision

This hotfix must move the core work into the Revit commandset, similar in shape
to `find_elements`.

Runtime TypeScript should become a thin tool wrapper:

- keep the MCP tool name `inspect_sheet_text`
- keep backward-compatible parameters where possible
- add the new parameters described below
- perform cheap pre-Revit guard checks when possible
- call the native commandset command
- normalize/format the native result

Native commandset must own:

- argument parsing and validation
- guard policy that depends on Revit-side context
- elapsed budget and deadline checks
- per-loop scan caps
- partial-result state
- sheet, viewport, view, text note, schedule, and optional tag scanning
- stable result contract fields

Rationale:

- Dynamic C# cannot be characterized well enough by CI.
- Budget and partial behavior must be enforced inside the long-running Revit
  loops, not only at the socket layer.
- Native commandset code can be smoke-tested, compiled, payload-manifested, and
  live-gated with the same discipline as `find_elements`.

## Scope

In scope:

- native Revit commandset command, event handler, result model, and helpers for
  sheet annotation inspection
- runtime `inspect_sheet_text` wrapper update
- command registry / payload wiring
- CI-safe characterization tests
- Revit plugin DLL rebuild
- `installer/revit-payload-manifest.json` refresh
- live Revit read-only validation
- Revit-closed installer/deploy loop
- docs and runbook updates
- `CHANGELOG.md`
- runtime tool surface bump

Expected file areas:

- `src/revit-plugin/RevitMCPCommandSet/Commands/...`
- `installer/runtime-mcp-server/src/tools/inspect_sheet_text.ts`
- `installer/revit-plugin/.../commandRegistry.json`
- `installer/command-payload/...`
- `installer/revit-payload-manifest.json`
- `scripts/test-installer-smoke.ps1`
- `scripts/test-commandset-live.ps1`

Out of scope:

- SPL schedule-plan comparison as a domain-specific native audit tool
- QHK / 310.170 / DR01-DR06 code audit tool
- native Excel report generator
- CAD reference family creation
- QA view override / coloring workflow

## Phase 0 - Native Pattern Audit

Tasks:

- Re-read the native `find_elements` command path:
  - runtime wrapper
  - command registry
  - command parser
  - event handler
  - helper/result models
  - live test coverage
- Re-read current dynamic `inspect_sheet_text` behavior and preserve compatible
  output fields where practical.
- Re-read 2026-06-04 usage samples for Level 08 SPL / Uzel A / QHK patterns.

Acceptance:

- The implementation PR names this as "native sheet + viewport annotation
  inspection", not "dynamic C# timeout patch".
- The plan identifies the commandset files that will own budget/partial/guard.

## Phase 1 - Contract And Parameters

Preserve existing parameters:

- `query` / `sheetQuery`
- `textQuery`
- `sheetIds`
- `includeTextNotes`
- `includeScheduleInstances`
- `scanScheduleCells`
- `allowExpensiveSearch`
- `maxSheets`
- `maxTextNotesPerSheet`
- `maxScheduleInstancesPerSheet`
- `maxRowsPerSchedule`
- `maxColumnsPerSchedule`
- `maxTextChars`
- `timeoutMs`

Add parameters:

- `searchBudget`: `fast | balanced | deep`
- `maxElapsedMs`
- `includeViewportTextNotes`
- `includeViewportTags`
- `viewNameQuery`
- `maxViewportsPerSheet`
- `maxViewportTextNotesPerView`
- `maxViewportTagsPerView`
- `maxTextNotesScanned`
- `maxTagsScanned`
- `maxScheduleInstancesScanned`
- `maxScheduleCellsScanned`

Add response fields:

- `success`
- `guarded`
- `state`
- `action`
- `reason`
- `message`
- `partial`
- `scanStoppedReason`
- `scanPolicy`
- `suggestedNextScopes`
- `scannedSheetCount`
- `scannedViewportCount`
- `scannedTextNoteCount`
- `scannedTagCount`
- `scannedScheduleInstanceCount`
- `scannedScheduleCellCount`
- `estimatedResponseBytes`
- `maxResponseBytes`
- `warnings`
- `notices`

Acceptance:

- The runtime tool schema exposes the new parameters.
- The native result follows the shared lower-case minimal result contract.
- The native output is a strict superset of the current dynamic
  `inspect_sheet_text` output. Existing sheet text and placed schedule
  workflows must keep the same field names and semantics, with new fields added
  on top.
- Every sheet text/schedule query that works today continues to work against
  the native implementation with the same response field names.

## Phase 2 - Native Commandset Scaffolding

Tasks:

- Add a native commandset command for sheet annotation inspection.
- Add a dedicated event handler for Revit API work.
- Add argument parsing with clamped defaults.
- Add result DTOs that serialize cleanly through the bridge.
- Wire command registry and runtime wrapper to call the native command.
- Remove or bypass the runtime-generated dynamic C# scan path for ordinary
  `inspect_sheet_text` execution.

Acceptance:

- The tool no longer builds the core Revit scan as a dynamic C# string.
- CI smoke can grep/characterize native handler behavior.
- Commandset build succeeds.

## Phase 3 - Native Guard Policy

Rules:

- No sheet scope + broad text search -> `guarded=true`, `reason=needs_scope`.
- No sheet scope + viewport text scan -> `guarded=true`,
  `reason=needs_scope`.
- No sheet scope + schedule cell scan -> guarded as today.
- No sheet scope + tag scan -> guarded unless `allowExpensiveSearch=true`.
- Exact `sheetIds` or useful `sheetQuery` allows bounded viewport scans.
- `allowExpensiveSearch=true` permits broader scans, but budgets and partial
  results still apply.

Guard response should include:

- `suggestedNextScopes`: `sheetQuery`, `sheetIds`, `viewNameQuery`,
  `maxSheets`, `allowExpensiveSearch`
- `scanPolicy`
- `reason=needs_scope`
- a message that explains cost without blocking intentional engineering work

Acceptance:

- Broad no-scope request returns guarded before expensive Revit loops.
- Guarded responses are treated as protected behavior, not failed operations.
- Runtime and native responses agree on the minimal result contract.

## Phase 4 - Native Budget And Partial Results

Native handler must enforce:

- one `deadlineUtc` derived from `maxElapsedMs`
- deadline checks inside sheet, viewport, text note, schedule instance,
  schedule cell, and optional tag loops
- global caps across the full operation
- per-sheet/per-view caps for response size
- a cumulative response byte budget while collecting results

Stable stop reasons:

- `max_elapsed`
- `max_scanned`
- `max_bytes`
- `max_sheets`
- `max_viewports`
- `max_text_notes`
- `max_tags`
- `max_schedule_cells`
- `needs_scope`

Acceptance:

- Small `maxElapsedMs` returns `success=true`, `partial=true`, and
  `scanStoppedReason=max_elapsed`.
- Global scan caps return partial output without throwing.
- When accumulated result content approaches the bridge response-size ceiling,
  the handler stops collecting large evidence records and returns
  `success=true`, `partial=true`, and `scanStoppedReason=max_bytes` instead of
  throwing or producing a hard socket/bridge response error.
- Revit-side elapsed budget is meaningfully below socket timeout.

Response byte budget detail:

- Item-count caps are not enough; thousands of long text notes or tag labels can
  still exceed the bridge response ceiling.
- The native handler should estimate cumulative serialized response size while
  adding evidence records.
- Stop before the bridge `MAX_RESPONSE_BYTES` ceiling is reached.
- Keep the result useful by returning already collected evidence, scan counters,
  warnings, and the `max_bytes` stop reason.

## Phase 5 - Native Sheet And Schedule Scan

Preserve and harden current behavior:

- sheet `TextNote` scan
- placed `ScheduleSheetInstance` inventory
- bounded placed schedule body-cell scan
- Turkish/diacritic/Cyrillic-U normalization
- text trimming
- id, unique id, point, and bounding box evidence

Acceptance:

- Existing sheet text workflows continue to pass.
- Existing dynamic-tool output fields for sheet text and placed schedule
  inventory remain present with the same names.
- Schedule cell scan is bounded by row/column/global caps.
- Schedule scan returns partial results instead of socket timeout.

## Phase 6 - Native Viewport Text Notes

Behavior:

- For each matching sheet, collect viewports.
- Resolve each viewport's placed `View`.
- If `viewNameQuery` is supplied, only inspect matching views.
- Use a view-scoped collector for `TextNote` in the placed view.
- Return sheet, viewport, view, element id, text, point, and bounding box when
  available.

Flat evidence record shape:

```json
{
  "kind": "viewportTextNote",
  "sheetId": 123,
  "sheetNumber": "A-101",
  "viewportId": 456,
  "viewId": 789,
  "viewName": "Level 08 Mechanical Plan",
  "elementId": 111,
  "uniqueId": "...",
  "text": "54.SPL",
  "textNormalized": "54.spl",
  "point": {},
  "box": {}
}
```

Acceptance:

- `sheetQuery` or exact `sheetIds` plus `includeViewportTextNotes=true`
  returns viewport text-note evidence.
- Project-wide viewport text-note scans without scope are guarded unless
  `allowExpensiveSearch=true`.
- Viewport text-note scan respects native budget and caps.

## Phase 7 - Viewport Tags Opt-In Evidence

Tag support remains opt-in and bounded by sheet/view scope, elapsed budget,
scan caps, and response-size budget. Revit API differences should degrade to
warnings or notices for the affected tag rows rather than failing the whole
inspection.

Preferred behavior:

- Add `includeViewportTags`.
- Inspect tag-like annotation elements in placed views with bounded limits.
- Capture tag text where available through safe tag APIs and common label/name
  fallbacks.
- Return element id, category, tag text, tagged element ids when available,
  sheet id, viewport id, and view id.

Fallback behavior for individual tag limitations:

- Keep readable tag rows even when tagged element metadata cannot be resolved.
- Report missing tag text, tagged element lookup failures, or unsupported tag
  API paths through `warnings` or `notices`.
- Keep the code path opt-in and non-breaking.

Acceptance:

- Tags are never broad-scanned by default.
- Tag support either works with caps and budget, or is explicitly deferred with
  a stable documented reason.

## Phase 8 - LLM And Excel-Friendly Output

Return both:

- nested `sheets[]` for detailed evidence
- flat `matches[]` for comparison/report generation

Stable `kind` values:

- `sheetTextNote`
- `viewportTextNote`
- `viewportTag`
- `scheduleCell`
- `scheduleInstance`

Acceptance:

- An LLM can compare schedule rows and plan annotations without writing custom
  Revit collectors.
- Output includes enough ids and labels to create a one-page Excel report with
  sheet/view evidence.

## Phase 9 - CI And Local Gates

Required local gates:

- build runtime package
- build Revit commandset/plugin
- refresh `installer/revit-payload-manifest.json`
- `npm test`
- `scripts/test-ci.ps1`
- `scripts/test-mcp-build-payload-freshness.ps1`
- `scripts/test-installer-smoke.ps1`

Smoke/characterization coverage:

- runtime tool schema exposes new params
- runtime wrapper calls native commandset path
- native handler source includes deadline checks
- native handler source includes `partial` and `scanStoppedReason`
- broad no-scope viewport scan guard is covered
- payload freshness is content-manifest clean
- runtime tool surface version is bumped

Acceptance:

- CI does not need Revit open to verify the native code structure.
- DLL and manifest are committed together.
- MCP build freshness behavior remains unchanged except for the intended Revit
  payload manifest update.

## Phase 10 - Pre-Merge Live Revit Gate

Live validation is read-only and gates merge because this PR changes the Revit
commandset DLL.

Required pre-merge sequence:

1. Build Revit plugin/commandset on the branch.
2. Refresh `installer/revit-payload-manifest.json` on the branch.
3. Run local non-Revit gates.
4. Ask operator to close Revit.
5. Install the branch build locally while Revit is closed.
6. Ask operator to reopen Revit and the test model.
7. Run the read-only live checks below.
8. Only merge after these checks pass and Engineering gates are green.

Required checks:

- broad no-scope viewport text request -> `guarded=true`, `reason=needs_scope`
- exact `sheetIds` or `sheetQuery` + `includeViewportTextNotes=true` ->
  bounded result
- forced small `maxElapsedMs` -> `partial=true`,
  `scanStoppedReason=max_elapsed`
- forced response-size pressure -> `partial=true`, `scanStoppedReason=max_bytes`
- schedule cell scan cap -> partial result, not timeout
- tag scan:
  - if implemented: bounded result or clear empty result
  - readable tag text appears as `viewportTag` evidence

Acceptance:

- No model writes.
- No socket timeout for bounded scans.
- Recent task status confirms elapsed time stays near the requested budget.
- Pre-merge live validation result is recorded in the PR before merge.

## Phase 11 - Post-Merge Revit-Closed Stable Deploy Loop

Phase 11 starts only after merge. It is the stable publish loop, not the first
live validation gate.

Because this change modifies the Revit commandset DLL, stable deploy must follow
the Revit-closed payload cycle.

Required sequence:

1. Merge only after Engineering gates and Phase 10 pre-merge live gate are
   clean.
2. Fresh-checkout main and run deploy preflight.
3. Ask operator to close Revit before local install/deploy validation.
4. Run installer/update validation with Revit closed.
5. Reopen Revit only if a final post-merge smoke is needed.
6. Publish stable.
7. Verify NAS channel manifest, versioned manifest, ZIP, and SHA256.

Acceptance:

- No payload-refresh follow-up PR is needed after merge.
- Fresh main checkout deploy preflight passes without mtime false positives.
- Stable deploy package contains the updated DLL and manifest.

## Phase 12 - Follow-Up Native Tools

Create planned backlog items after the hotfix lands:

1. SPL collector schedule-plan audit native tool.
2. QHK / 310.170 / DR01-DR06 sheet code audit native tool.
3. Excel report generator for schedule-plan annotation audits.
4. CAD reference family controlled creation tool.
5. QA view override / coloring workflow tool.

These should not block the hotfix. The hotfix supplies the safe native evidence
surface that those tools can build on.

## Tracking Rule

Keep this plan open until the following are done:

- `inspect_sheet_text` core scan is native commandset code, not dynamic C#.
- Native handler owns guard, budget, and partial result behavior.
- `inspect_sheet_text` has viewport text-note support.
- `inspect_sheet_text` has bounded tag support or a documented stable defer.
- DLL and `installer/revit-payload-manifest.json` are refreshed and committed.
- Docs and skill guidance reflect native sheet + viewport annotation inspection.
- Stable deploy is published after Revit-closed validation.
- Usage-intelligence shows fewer Level 08 sheet/text timeout failures without a
  spike in unsafe broad scans.
