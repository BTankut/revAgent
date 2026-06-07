# revAgent Live-Test Feedback Hotfix Plan

Status: proposed hotfix plan; implementation not started.
Owner: revAgent runtime wrapper + Revit commandset + API docs server.
Source signal: operator live tests after the 2026-06-07 roadmap completion and
stable deploy `2026.06.07.319-1c6f6a0`.

## Goal

Convert the operator's live-test findings into a bounded hotfix sequence that
improves trust, readability, and repeatability without weakening the dedicated
tool-first workflow.

This plan is intentionally not a new product roadmap. It is a hotfix bundle for
known rough edges observed in real use.

## Non-Goals

- Do not add broad model-writing behavior without dry-run, explicit commit, and
  verification semantics.
- Do not replace dedicated tools with raw `send_code_to_revit` fallbacks.
- Do not make high-volume tools return larger default payloads.
- Do not stable-deploy any DLL or command-payload change without operator live
  validation and explicit deploy approval.

## Findings And Triage

| Finding | User impact | Hotfix direction | Gate |
| --- | --- | --- | --- |
| High-volume outputs are too long and repetitive. | Operators and agents lose the useful rows inside repeated candidates, evidence, and API details. | Add default compact responses, evidence/candidate dedupe, bounded candidate rows, and explicit full/debug mode for `find_elements`, `inspect_schedules`, `set_schedule_cells_by_text`, `reconcile_schedule_excel`, and API docs type detail output. | Runtime/docs-server tests; no Revit live gate unless a wrapper calls Revit differently. |
| Guard audit traces are inconsistent. | Client-side guards can disappear from visible history, and wrapper parent task names can be lost under subtask names. | Add MCP-side guard history fields and preserve `parentTaskId`/`parentTaskName` through wrapper calls. Do not fake Revit-side recentTasks for calls that never reached Revit; expose them as runtime/live-feed/client guard records. | Runtime tests; live dashboard smoke if feed changes. |
| `inspect_sheet_text` canonical stop reason can obscure raw cap type. | `scanStoppedReason=max_items` with `rawScanStoppedReason=max_sheets` is technically canonical but not self-explanatory. | Keep canonical vocabulary stable, but add explicit detail such as `scanStoppedReasonDetail: "max_sheets"` and next-scope hints that say the sheet cap was hit. | Runtime/native fixture tests; live gate if native response shape changes. |
| `inspect_sheet_text` mixes inventory rows with text-query matches. | Revision schedule inventory can look like a text match even when `textQuery=PIPING` did not match it. | Matched rows stay in `evidenceRows`; inventory-only rows move to `inventoryRows` or carry `matchedTextQuery=false`. Preserve backward compatibility with notices for clients expecting inventory in the old location. | Native real-shape fixtures and live sheet test. |
| `count_annotations` cannot count viewport text notes found by `inspect_sheet_text`. | Annotation inventory is incomplete for placed-view text notes. | Add a `viewport_text_notes` source with bounded placed-view traversal. Start opt-in; consider adding to default sources only after live performance is proven. | Native tests and operator live gate. |
| `reconcile_schedule_excel` schema is hard to use from outside. | Users see guarded schema failures but do not know the expected `rows` shape or required `columnMapping` fields. | Improve tool description and guarded response examples; fill `suggestedNextScopes`; accept a safe rows-array shorthand if it can be made unambiguous, otherwise return an example object with `kind:"rows"` and required `identity`/`comparisonText` mapping. | Runtime deterministic tests; no Revit live gate. |
| Parameter rollback to true no-value is not obvious. | A successful write to a built-in non-shared parameter may not be reversible to prior `HasValue=false`. | Add preflight warning fields when a write starts from `HasValue=false` and true clear/restore may not be supported. Keep current behavior: never fake clear with an empty string. | Runtime/native parameter contract tests; targeted live dry-run/commit if Revit behavior changes. |
| Turkish `vana` search is broad in Pipe Fittings. | Valve searches can include elbows/transitions as low-confidence noise. | For valve/vana intent, rank pipe accessories and family/name/type valve signals before fittings fallback; demote fittings-only matches and make confidence reason visible. | Runtime search policy tests and live search spot check. |
| Cleanup tools are missing. | Operators need raw fallback to delete test review views or clear final selection. | Add `clear_selection` and a guarded `delete_review_view`/`cleanup_created_views` tool. Deletion defaults to dry-run and only targets explicit ids or revAgent-created review views. | Live Revit gate; write behavior requires explicit operator approval. |

## Binding Decisions

### 1. Default Compact Output

High-volume tools should default to compact responses. Full/debug output remains
available by explicit request.

Required behavior:

- repeated evidence rows are deduped by a stable source key;
- candidate rows are capped by default and report omitted counts;
- summaries include enough continuation/scoping hints to make the next call;
- full/debug mode restores verbose diagnostics without changing the default;
- tests prove default compact output is smaller and still preserves required
  contract fields.

Candidate naming should follow existing local conventions where a tool already
has a detail option. Where there is no existing option, use a single shared
`responseMode: "compact" | "full" | "debug"` option rather than one-off flags.

### 2. Guard And Parent Task Audit

Client-side/runtime guards must be visible somewhere, but they must not be
misrepresented as Revit-side tasks.

Required behavior:

- wrapper results preserve the operator-visible parent `taskName`;
- nested sub-operations keep `parentTaskId` and `parentTaskName`;
- runtime-side guards emit a compact history/live-feed record with
  `guardSource: "runtime"` or `guardSource: "client"`;
- Revit `mcp_status.recentTasks` remains Revit-side truth for commands that
  reached the add-in.

### 3. Scan Semantics And Annotation Coverage

`inspect_sheet_text` and `count_annotations` should share evidence semantics
without pretending inventory is a text match.

Required behavior:

- `evidenceRows` means rows that matched the search/count request;
- inventory-only rows are separate or explicitly marked as not matching the
  text query;
- canonical stop reasons remain stable, while raw cap details are visible;
- `count_annotations` can count viewport text notes through an explicit source;
- bounded traversal and partial stop reasons are preserved.

### 4. Review-First Reconciliation UX

`reconcile_schedule_excel` stays write-free. The hotfix only makes its schema
and guard responses easier to act on.

Required behavior:

- guarded schema failures return concrete examples;
- required `columnMapping.identity` and `columnMapping.comparisonText` are
  named in the response;
- `suggestedNextScopes` is populated for shape, mapping, sheet/range, and
  budget guards;
- deterministic tests cover both valid object-form rows input and invalid
  shorthand/mapping failures.

### 5. Cleanup Tool Safety

Cleanup tools are convenience tools, not broad delete tools.

Required behavior:

- `clear_selection` performs only a UI selection clear and does not modify model
  elements;
- view cleanup defaults to dry-run;
- committed cleanup requires explicit view ids or a strict revAgent review-view
  marker/prefix;
- deletion returns before/after verification and blocked reasons for unsafe
  targets;
- cleanup tools follow the Revit MCP status preflight and no-parallel runtime
  rule.

## Implementation Order

### PR 0 - Plan Approval

Doc-only. This file is the approval checkpoint. Do not implement code before it
is reviewed and approved.

### PR 1 - Runtime Ergonomics And Schema Guards

Scope:

- compact/default response mode and dedupe for high-volume runtime wrappers;
- `reconcile_schedule_excel` schema/guard examples and `suggestedNextScopes`;
- parameter rollback warning metadata where this can be expressed in the
  runtime contract without changing native write semantics;
- API docs type detail compact/default response if the bloat is in the docs MCP
  server.

Gate:

- `npm test` in affected MCP packages;
- `scripts/test-ci.ps1`;
- no live Revit gate unless wrapper behavior changes require a spot check.

### PR 2 - Guard History And Parent Task Preservation

Scope:

- runtime/client-side guard history records;
- parent task id/name propagation through wrapper subcalls;
- live-dashboard or telemetry smoke if a feed shape changes.

Gate:

- runtime tests for parent task and guard-source fields;
- `scripts/test-live-dashboard.ps1` if live feed output changes;
- `scripts/test-ci.ps1`;
- no Revit DLL gate unless the add-in status UI is changed.

### PR 3 - Native Scan Semantics And Annotation Coverage

Scope:

- `inspect_sheet_text` stop detail and inventory-vs-match separation;
- `count_annotations` `viewport_text_notes` source;
- real-shape fixtures for the PIPING/revision-schedule case and viewport text
  note count case.

Gate:

- native fixture/contract tests;
- `npm test`;
- `scripts/test-ci.ps1`;
- operator live Revit gate before merge, because this changes native traversal
  or command-payload behavior.

### PR 4 - Search Precision And Cleanup Tools

Scope:

- valve/vana search ranking improvements;
- `clear_selection`;
- guarded `delete_review_view` or `cleanup_created_views`.

Gate:

- runtime tests for search ranking and cleanup guards;
- live Revit gate for selection clear and review-view deletion dry-run/commit;
- `scripts/test-ci.ps1`;
- no stable deploy until operator approval.

## Live Validation Checklist

Use the same operator-controlled pattern as prior native work:

1. close Revit;
2. install branch payload when a DLL/command payload changes;
3. open the live test model;
4. run bounded read-only tests first;
5. run cleanup write tests only with explicit operator approval;
6. approve or reject merge.

Minimum live checks:

- `inspect_sheet_text` with `textQuery=PIPING` does not show revision schedule
  inventory as a text match;
- `inspect_sheet_text` sheet cap reports canonical stop plus sheet-cap detail;
- `count_annotations` can count a viewport text note with the new source;
- `find_elements` for Turkish `vana` ranks valve/accessory signals above broad
  fittings fallback;
- `clear_selection` leaves no selection;
- review-view cleanup dry-run blocks unsafe targets and commit deletes only the
  requested safe review view;
- parameter write warning appears when a prior no-value state may not be
  restorable.

## Deployment Policy

- Runtime-only PRs may merge after CI and review, without Revit live gate.
- DLL/command-payload PRs require operator live gate before merge.
- Stable deploy is a separate operator-approved step.
- If PR 3 fixes a production-blocking annotation/count issue, the operator may
  approve an intermediate hotfix deploy. Otherwise batch stable deploy after
  the hotfix sequence is complete.

## Documentation Updates Required By Implementation

- `SKILL.md` and `AGENTS.md`: update routing for cleanup tools and compact/full
  response usage.
- `README.md`: update tool surface count and runtime tool table if new tools
  are added.
- `docs/PLATFORM_ARCHITECTURE.md`: update runtime surface, guard-history model,
  scan evidence semantics, and cleanup safety model.
- `docs/DEVELOPER_RUNBOOK.md`: add live validation checklist for native scan
  semantics and cleanup tools.
- `CHANGELOG.md`: add shipped behavior under the next release heading.
