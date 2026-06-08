# revAgent Live Test Feedback Hotfix Round 2 Plan

Status: active implementation plan, stored under `_retired` with prior planning
artifacts so `docs/` keeps only application-facing documentation.

## Source Feedback

Operator live testing found six remaining product issues:

- `delete_review_view` does not recognize a 3D review view created by
  `create_3d_view_for_elements` with a name such as
  `revAgent_QA_DELETE_TEST_386031`.
- `reconcile_schedule_excel responseMode=compact` still returns verbose
  debug-shaped fields such as token profiles, raw cells, and nested candidate
  rows.
- Client/runtime-side guards that do not reach Revit are not visible in Revit
  status history.
- `set_schedule_cells_by_text` appears in status history as
  `send_code_to_revit`, weakening wrapper/tool traceability.
- `find_elements responseMode=compact` repeats plan candidate details per
  element.
- `send_code_to_revit` and `send_code_to_revit_safe` can still leave a JSON
  string in nested `result` fields even when `parseJsonResult=true`.

## PR Plan

### PR1 - Review View Cleanup Policy Alignment

Goal: make review-view creation and cleanup share the same recognition policy.

Scope:

- Treat 3D views created for live/QA workflows, including `revAgent_QA_*`,
  `3D - Focus ...`, coordination export, and Revit MCP focus names, as cleanup
  candidates when explicitly addressed by `viewId` or `viewName`.
- Keep existing production safety guards: non-3D/template views, active views,
  open views, non-review views, and sheet-placed review views remain blocked.
- Add deterministic installer/source smoke coverage for the shared naming
  policy.
- Add live commandset coverage that creates a `revAgent_QA_DELETE_TEST_*` 3D
  review view, dry-runs it, confirms cleanup, and verifies deletion.

Gate:

- Native DLL changes are expected.
- Run CI-safe gates.
- Stop for operator Revit close/open as needed.
- Run live commandset gate before merge.

### PR2 - Compact Response Trimming

Goal: make compact responses genuinely compact.

Scope:

- `reconcile_schedule_excel responseMode=compact` returns summary,
  reviewTable, evidenceRows, and count/omitted metadata; token profiles, raw
  cells, and nested candidateRows are reserved for `full`/debug.
- `find_elements responseMode=compact` deduplicates repeated plan candidate
  details and returns a compact candidate summary.
- Preserve `full` response behavior for audit/debug workflows.

Gate:

- Runtime-only.
- CI-safe deterministic tests.
- No live Revit gate unless PR2 unexpectedly touches native payload.

### PR3 - Runtime Guard Audit And Wrapper Identity

Goal: make non-Revit runtime guards and wrapper tool identity visible to audit
surfaces.

Scope:

- Add a runtime/client action history for guard-only tasks that do not reach
  Revit.
- Preserve wrapper action/tool identity for wrappers such as
  `set_schedule_cells_by_text`, while keeping nested Revit commands available
  as sub-operations.
- Extend status/telemetry tests so guard-only tasks and wrapper actions are
  visible in dashboard/report consumers.

Gate:

- Runtime-only.
- CI-safe deterministic tests.
- No live Revit gate unless native payload changes.

### PR4 - JSON Result Normalization And Documentation

Goal: remove the need for callers to parse JSON-looking nested result strings
after requesting JSON parsing.

Scope:

- Normalize nested dynamic execution result payloads when
  `parseJsonResult=true` so JSON-looking result strings become objects where
  practical.
- Preserve raw text when parsing is disabled or parsing fails.
- Update `SKILL.md`, `AGENTS.md`, `README.md`, runbook, and changelog for the
  new compact/audit/normalization behavior.

Gate:

- Runtime/docs-only unless implementation discovers a native bridge dependency.
- CI-safe deterministic tests.

## Deployment Rule

PR1 is native and must pass the pre-merge live gate. PR2-PR4 are intended to be
runtime/docs focused. Do not stable deploy per PR. After all four PRs are
merged, publish one cumulative stable NAS release with manifest and SHA
verification. If a runtime-only PR needs urgent deployment before PR1, get
separate operator approval first.
