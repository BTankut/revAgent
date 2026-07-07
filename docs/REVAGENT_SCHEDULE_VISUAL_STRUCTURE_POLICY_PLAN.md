# Schedule visual structure and policy plan

This is the P2 planning package that follows the classified weekly usage
review in
`docs/REVAGENT_USAGE_INTELLIGENCE_SEND_CODE_BACKLOG_2026-06-29_TO_2026-07-05.md`.
It does not implement a runtime tool and does not publish or deploy anything.

## Decision Summary

The next product work should not create a separate tool for every schedule,
table, PDF, image, or save request. The evidence supports one guarded design
spike for schedule visual structure, plus explicit policy decisions for model
save and PDF/print behavior.

Recommended split:

1. Schedule visual structure contract: proceed to design spike.
2. Model save: policy gate before any tool.
3. PDF/print: policy gate before any tool.
4. View/image asset workflow: planned, but separate from print/PDF and separate
   from simple image export.
5. Routing/tuning: keep the small prompt/tool-description improvements
   separate from the visual structure implementation.

## Schedule Visual Structure

### Evidence

The weekly review found 160 daily `send_code` calls classified as
`schedule_visual_structure`, with 45 candidate rows. Examples include:

- manual/native schedule creation from Excel-like sources
- borders, grid lines, spacer rows, merged cells, and black-background cell
  repair
- font, color, row height, and column width adjustments
- placed schedule fit and movement on sheets
- table blocks copied between schedules

This is a real capability gap, but the right product surface is a parameterized
schedule/table layout workflow, not many one-off commands.

### Proposed Product Shape

Use one schedule visual operation surface with modes or operation lists. A
future native tool can be named later, but the contract should follow this
shape:

```json
{
  "scheduleIds": [123],
  "sheetIds": [456],
  "placedScheduleInstanceIds": [789],
  "mode": "dryRun",
  "operations": [
    {
      "type": "set_cell_style",
      "section": "body",
      "row": 1,
      "column": 2,
      "style": {
        "fontName": "Arial",
        "fontSizeMm": 3,
        "textColor": "#000000",
        "backgroundColor": "#ffffff",
        "horizontalAlignment": "center",
        "verticalAlignment": "middle"
      }
    },
    {
      "type": "set_borders",
      "section": "body",
      "rowRange": [1, 20],
      "columnRange": [1, 6],
      "lineWeight": "thin"
    },
    {
      "type": "merge_cells",
      "section": "body",
      "rowRange": [3, 4],
      "columnRange": [1, 1]
    },
    {
      "type": "set_row_height",
      "section": "body",
      "rowRange": [1, 20],
      "heightMm": 6
    }
  ],
  "verification": {
    "readBackCells": true,
    "exportScheduleImage": false,
    "exportSheetImage": false
  }
}
```

This is intentionally operation-list based. It allows one tool to cover many
observed workflows while keeping the context cost bounded.

### Implementation Contract V1

The first implementation should expose one schedule visual operation surface,
not separate tools for borders, fonts, colors, merges, and sheet placement. The
working name is provisional; the important contract is the shape below.

Inputs:

- `mode`: `dryRun` by default, `commit` only with `confirmCommit=true`.
- `scope`: at least one exact `scheduleIds[]`, `placedScheduleInstanceIds[]`,
  or paired `sheetIds[]` plus `scheduleIds[]`. Name-only lookup is not accepted
  by this tool; callers must resolve names with `inspect_schedules` first.
- `operations[]`: ordered list, capped in the first implementation to keep
  review and verification readable.
- `operationBatchId`: optional caller id for audit and repeated dry-run/commit
  comparison.
- `verification`: read-back settings only. Image export remains a separate
  follow-up with existing export tools.

Supported operation families:

| Operation family | Required target | First contract behavior |
| --- | --- | --- |
| `set_cell_style` | exact section, row/column or row/column range | Validate style keys, section support, and cell range before commit. |
| `set_borders` | exact section and cell range | Treat as cell-style override. Reject unsupported line weights/styles before commit. |
| `merge_cells` / `unmerge_cells` | exact rectangular cell range | Dry-run must detect overlapping or invalid merged ranges before any write. |
| `set_row_height` | exact section and row/range | Normalize mm to Revit internal units and read back representative rows. |
| `set_column_width` | exact section and column/range | Normalize mm to Revit internal units and read back representative columns. |
| `move_placed_schedule` | exact placed schedule instance on exact sheet | Preview old/new sheet point; commit only when the instance is uniquely resolved. |

Excluded from V1:

- text value writes that are already covered by `set_schedule_cells` and
  `set_schedule_cells_by_text`
- schedule creation from Excel, copied table blocks, and broad reconstruction
- PDF/print settings
- image asset placement, reload, crop, or replacement
- implicit model save
- project-wide schedule discovery or formatting scan

Result contract:

```json
{
  "success": true,
  "guarded": false,
  "state": "completed",
  "action": "schedule_visual_structure",
  "mode": "dryRun",
  "committed": false,
  "operationBatchId": "optional-caller-id",
  "affectedScheduleIds": [123],
  "affectedSheetIds": [456],
  "operationCount": 3,
  "supportedOperationCount": 2,
  "unsupportedOperationCount": 1,
  "operations": [
    {
      "index": 0,
      "type": "set_cell_style",
      "state": "previewed",
      "scheduleId": 123,
      "section": "body",
      "range": { "rowStart": 1, "rowEnd": 1, "columnStart": 2, "columnEnd": 2 },
      "before": { "textColor": "#000000" },
      "after": { "textColor": "#ffffff", "backgroundColor": "#000000" }
    }
  ],
  "unsupportedOperations": [
    {
      "index": 2,
      "type": "merge_cells",
      "reason": "standard_schedule_body_merge_not_supported"
    }
  ],
  "verification": {
    "readBack": [],
    "verificationWarnings": []
  },
  "warnings": []
}
```

Guards:

- `needs_scope` when no exact schedule/sheet/placed instance identity is
  provided.
- `ambiguous_scope` when a supplied sheet/schedule pair resolves to multiple
  placed schedule instances and no placed instance id is provided.
- `unsupported_operation` when an operation family is outside V1.
- `unsupported_section_or_cell` when Revit does not allow the requested table
  section/cell operation.
- `text_write_routing_required` when an operation only changes cell text.
- `commit_confirmation_required` when `mode="commit"` lacks
  `confirmCommit=true`.

### Revit API Support Matrix

The implementation PR must verify this matrix against the target Revit
versions before enabling commit behavior. Until verified, unsupported or
uncertain rows stay dry-run/guarded.

| Workflow | Revit API surface to verify | V1 stance |
| --- | --- | --- |
| Cell text writes | `TableSectionData.SetCellText` | Existing tools own this. Route to `set_schedule_cells*`. |
| Cell style overrides | `TableSectionData.GetCellStyle` / `SetCellStyle` and style override support checks | Candidate for V1 after dry-run support checks. |
| Border/grid styling | cell style border properties where exposed by Revit API | Candidate for V1, guarded when the API cannot represent the requested border. |
| Merged cells | table merged-cell APIs such as `SetMergedCell` / merged-cell readback | Candidate for manual/header-style sections; standard body cells guarded until proven writable. |
| Row and column sizing | table section row/column size APIs and schedule field width APIs | Candidate for V1 with mm-to-internal-unit normalization and readback. |
| Placed schedule movement | `ScheduleSheetInstance` identity and point/move behavior | Candidate for V1 only with exact placed instance id or unique sheet/schedule pair. |
| Schedule creation/reconstruction | `ViewSchedule` and `ScheduleDefinition` mutation APIs | Excluded from V1; separate design after visual edit contract is proven. |
| Model save | `Document.Save()` | Excluded; owned by model-save policy. |
| PDF/print | `PrintManager` and print setup APIs | Excluded; owned by PDF/print policy. |

### First Prototype Cut

The next code PR should be a dry-run/read-back prototype unless live Revit API
verification proves a smaller commit path is safe. The preferred cut is:

1. Add schema validation and deterministic operation planning for the V1
   operation families.
2. Resolve exact schedules and placed schedule instances only from supplied ids
   or unique supplied sheet/schedule pairs.
3. Return the result contract with `mode="dryRun"` and per-operation guarded
   reasons.
4. Add tests for supported validation, ambiguous scope, text-write routing, and
   unsupported operations.
5. Enable `commit` only after native Revit read-back verification exists for
   each operation family being committed.

This keeps the context load bounded: one operation-list surface, one result
contract, and one set of guards. It avoids accumulating a separate tool and
prompt burden for each visual formatting request.

### Scope Rules

- Require exact `scheduleIds`, exact `placedScheduleInstanceIds`, or an exact
  sheet/schedule scope resolved by prior `inspect_schedules`.
- No project-wide schedule formatting search in the first implementation.
- Default to `mode="dryRun"`.
- Require explicit `mode="commit"` and a confirmation flag for writes.
- Preserve existing schedule-cell text write guards. If a request only changes
  body text, route to `set_schedule_cells` or `set_schedule_cells_by_text`.
- Formatting and layout writes must report unsupported cells/sections before
  commit instead of partially mutating without warning.
- Do not save the model. Leave save behavior to the model-save policy.

### Verification Contract

The result should expose:

- `success`, `guarded`, `state`, `action`
- `mode`, `committed`, `affectedScheduleIds`, `affectedSheetIds`
- `operationCount`, `supportedOperationCount`, `unsupportedOperationCount`
- `unsupportedOperations[]` with reason and location
- `verification.readBack[]` for representative cells/styles
- optional exported evidence image paths when explicitly requested
- `warnings[]` for Revit API limitations and standard schedule restrictions

Visual QA should use existing export tools after status preflight. For schedule
evidence, prefer `export_revit_view_image` on the schedule or sheet after the
write. Do not overload the schedule formatting tool with image export by
default.

### Design Spike Acceptance Gates

The design spike is ready for implementation only when it answers:

- Which schedule sections and cell-style operations are supported by the Revit
  API across the target Revit versions?
- Which operations are safe for standard schedule body cells, and which are
  manual-schedule-only?
- How are row/column units normalized and verified?
- How are merged-cell requests validated before commit?
- How does the tool avoid broad scans and force exact scope?
- What is the smallest representative fixture/test matrix?

## Model Save Policy

### Evidence

The week showed 27 `model_save_policy` calls, usually after schedule/table edit
flows. Users and Codex treated `document.Save()` as a normal cleanup step, but
save is a model-wide side effect and has office workflow implications.

### Policy Recommendation

- Normal revAgent tools must not save the model.
- Write tools may report `documentModifiedBefore`, `documentModifiedAfter`,
  `documentPath`, and a user-facing reminder that the model needs normal Revit
  save handling.
- A future save tool, if accepted, must be explicit, separately named, and
  require exact confirmation. It should not be invoked implicitly after another
  workflow.
- The save tool should be blocked for detached/unsaved/cloud/workshared cases
  until those policies are written.

Decision needed before implementation: whether revAgent is allowed to expose an
explicit model-save tool at all.

## PDF And Print Policy

### Evidence

The week showed 54 `pdf_print_settings_policy` calls. These included print
color settings, PDF verification, and high-resolution sheet/isometry output.
Existing `export_revit_view_image` covers image evidence, but it does not define
PDF or Revit `PrintManager` policy.

### Policy Recommendation

- Keep `export_revit_view_image` as the supported evidence/export path for now.
- Do not change Revit print settings or printer/PDF settings through raw code.
- Treat PDF generation as a separate product decision because it can depend on
  installed printers, office PDF drivers, sheet sets, and color/blackline
  conventions.
- If a PDF export tool is approved later, it must have explicit sheet/view
  scope, dry-run preview, output path control, no global print-setting drift,
  and read-back verification of generated files.

Decision needed before implementation: whether PDF output belongs in revAgent
core, an add-on, or remains outside automation for now.

## View And Image Asset Workflow

The week showed 18 `view_image_asset_workflow` calls. These should not be mixed
with PDF/print policy. There are two separate intents:

- evidence export: already mostly covered by `export_revit_view_image` and
  `export_revit_coordination_image`
- model/sheet image asset mutation: place, reload, crop, resize, or replace
  raster images on sheets/views

Image asset mutation is a model write. If implemented, it needs exact sheet or
view scope, explicit image path validation, placement coordinates, dry-run,
commit confirmation, and visual verification.

## Routing And Tuning Follow-up

The weekly evidence found only 3 `routing_miss` and 2 `tool_tuning_gap` daily
send-code calls. These should be handled cheaply and separately from the
schedule visual structure implementation:

- Keep the assistant-facing descriptions for `set_schedule_cells`,
  `set_schedule_cells_by_text`, `inspect_sheet_text`, and `inspect_schedules`
  explicit that schedule cell text writes are not a reason for raw code.
- Consider a local TSV/Excel read-output adapter for inspection tools before
  adding any Revit-side export tool.
- Do not fold routing/tuning changes into the schedule visual write contract.

## Explicit Non-goals

- No one tool per schedule, user, sheet, or project.
- No implicit model save.
- No PDF/print setting mutation without policy approval.
- No broad project-wide formatting scan.
- No deploy or NAS publish as part of this planning package.

## Next Implementation Order

1. Merge this contract/policy split as the schedule visual design spike.
2. Implement the smallest schedule visual dry-run/read-back prototype behind a
   new native tool or internal adapter.
3. Add fixture tests for supported and guarded schedule operations.
4. Decide model save and PDF policy before writing any save/PDF runtime code.
