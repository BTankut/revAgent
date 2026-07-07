# revAgent send_code evidence review, 2026-06-29 to 2026-07-05

This is the P1 follow-up analysis after PR #202. It uses the new
send-code classification fields to decide whether Codex was avoiding existing
revAgent tools, whether existing tools need tuning, or whether the work is a
real capability or policy gap.

## Evidence Boundary

- Source range: 2026-06-29 through 2026-07-05 UTC.
- Source root: `\\DPE-NAS\Dpe-Ortak\Baris Tankut\revAgent-deploy\reports`.
- Processing mode: regenerated daily summaries, session correlations, and an
  LLM review pack from NAS inputs into a local temp folder only. NAS reports and
  release channels were not modified.
- Coverage in regenerated pack: 7 daily summaries, 40 Codex session contexts,
  40 session correlations, 32 correlations with revAgent events, 4024 revAgent
  events, 1941 production operations, 210 generated files.
- Counting rule: daily summary `sendCode.count` is the factual volume. Session
  correlation `dynamicCodeCount` can overlap because one operation can fall
  into more than one Codex time window.

## Executive Finding

The week does not support the broad claim that Codex mostly ignored existing
revAgent tools. The factual daily total is 437 send-code calls. Only 3 were
classified as clear `routing_miss`, and 2 as `tool_tuning_gap`.

The dominant signal is different: users were asking Codex to do schedule/table
layout, visual formatting, sheet/image/PDF handling, and model-save behavior
that the current native tool layer does not fully cover or has not yet defined
as product policy.

Session correlation counted 606 dynamic-code matches over the same week. That
number is useful for intent linkage, not volume. The 437 daily count is the
number to use in management reporting.

## Weekly Classification

| Classification | Daily calls | Meaning |
| --- | ---: | --- |
| `capability_gap` | 351 | Mostly schedule/table visual structure, unclassified write patterns, view/image asset workflows, and mixed schedule/parameter workflows. |
| `policy_gap` | 81 | Model save and PDF/print-setting behavior needs product policy before tool work. |
| `routing_miss` | 3 | Existing tools likely covered the job, mainly schedule-cell writes. |
| `tool_tuning_gap` | 2 | Existing read tools likely need better export/report ergonomics. |

Subtype detail:

| Subtype | Daily calls | Interpretation |
| --- | ---: | --- |
| `unclassified_write_pattern` | 168 | Needs manual triage before product work. Some patterns are real writes; some may be classifier false positives around local object creation/read adapters. |
| `schedule_visual_structure` | 160 | Strongest real product signal. Requests include creating/manual schedules, borders, merged cells, font/color/row sizing, and fitting placed schedules on sheets. |
| `pdf_print_settings_policy` | 54 | PDF/print color and sheet/image output behavior; image export covers part of the need but not print policy. |
| `model_save_policy` | 27 | Repeated explicit `document.Save()` after write workflows. |
| `view_image_asset_workflow` | 18 | View activation/zoom and image asset placement/reload/crop workflows. |
| `mixed_schedule_parameter_workflow` | 5 | Combined schedule-cell and element-parameter updates. Existing write tools may be enough if composed well. |
| `schedule_cell_write_tool_available` | 2 | Existing `set_schedule_cells` / `set_schedule_cells_by_text` should have been preferred. |
| `manual_transaction_existing_write_tool_available` | 1 | Raw code used a manual transaction where existing guarded write tools should be tried first. |
| `safe_guard_false_positive_review` | 2 | Safe-code guard or read-output ergonomics likely pushed the route away from native read tools. |

## Heavy Work Patterns

| Pattern | Evidence | Classification | Decision |
| --- | --- | --- | --- |
| Schedule visual structure and formatting | 160 daily calls; 45 candidate rows. Examples: L05/L06 cooling schedules, YY group schedules, border repair, font/row sizing, merged spacer cells, black-background cells, and schedule fit-on-sheet work. | `capability_gap` | Product work, but as one scoped design spike, not one tool per request. |
| Unclassified writes | 168 daily calls; examples include `Document.Delete`, `Create API`, `ElementTransformUtils`, schedule movement, and nearest-room/annotation helper snippets. | `capability_gap` with low confidence | Triage first. Do not open a native tool directly from this bucket. |
| Model save after edits | 27 daily calls, concentrated around YY table/schedule edit sessions. | `policy_gap` | Policy decision before implementation. |
| PDF/print/image output behavior | 54 daily calls, including print color settings, high-resolution view export, PDF verification, and placed/cropped images. | `policy_gap` / `capability_gap` | Split policy from view/image workflow design. |
| Existing schedule-cell writes | 2 daily calls. Examples: creating CRSL ECM 23 YY02 schedule and renumbering L06 BQ position cells. | `routing_miss` | Tool routing/training, not a new native tool. |
| Read/export adapters | 2 daily calls. Example: export current L06 MTL ECM 24 schedule cells to TSV after edits. | `tool_tuning_gap` | Improve existing read-tool output shape or add a local report adapter. |

## User And Project Signals

- MARINA / DELL produced the broadest user-intent signal, mainly on
  `11374_OT_KV_ATP_R22_L04-L06_Sgokmen`: L05/L06 cooling/convector/FCU schedule
  checking, Excel reconciliation, sheet schedule edits, spelling/title checks,
  and spec numbering.
- OGUZHAN / user produced heavy schedule-generation and table-formatting
  traffic around FCU detail and YY group tables.
- EMIN / User21 produced the largest correlated dynamic-code session on
  `FCU Detay Modelleri -Deneme`, but the bounded Codex intent snippet is thin
  and partly unrelated. Treat it as volume evidence, not a clean user-intent
  story without deeper source inspection.
- HAFIZE / USER23 showed smaller but production-relevant annotation/schedule
  quantity work around silencer and diffuser/quantity placement.
- NET01 appears as test/validation work, not production workflow evidence.

## Product Backlog

| Priority | Item | Evidence | Recommended scope |
| --- | --- | --- | --- |
| P2-A | Schedule visual structure design spike | 160 daily calls, 45 candidate rows, repeated native candidate for black-background cells. | Design one guarded schedule/table layout surface that can preview and apply text/background color, borders, merges, row/column size, and placed schedule fit. It must have dry-run, exact schedule/sheet scope, and verification. |
| P2-B | Model save policy | 27 daily calls. | Decide whether revAgent ever saves the model, when confirmation is required, and whether a status-only save check should exist. No implementation until policy is explicit. |
| P2-C | PDF/print policy and view/image asset workflow | 54 print/PDF policy calls plus 18 view/image workflow calls. | Separate print/PDF settings from image export/navigation. Avoid treating `export_revit_view_image` as sufficient for PDF or placed-image workflows. |
| P2-D | Existing-tool routing/tuning | 3 routing misses, 2 tuning gaps. | Improve tool descriptions/prompts around `set_schedule_cells`, `set_schedule_cells_by_text`, `inspect_sheet_text`, and `inspect_schedules`; add a standard TSV/Excel read-output adapter if needed. |
| P2-E | Classifier/manual triage for unclassified writes | 168 low-confidence capability-gap calls. | Add a review utility or next classifier pass to distinguish true Revit DB mutation from read-only/local object creation before native-tool promotion. |

## Training Needs

- Codex/tool-routing training: before raw code, try exact schedule/sheet/scope
  reads and existing guarded write tools. This matters most for schedule-cell
  edits and sheet/schedule text lookup.
- User prompt training: ask for the exact sheet, schedule, row/column, Excel
  source, and accepted visual reference when the work is table layout or
  schedule formatting. Most friction came from iterative visual corrections.
- Policy expectation training: model save, PDF print settings, and placed image
  behavior are not yet ordinary safe automation surfaces. Users should know
  these are policy/product-gated until implemented.

## Next PR Package

The next implementation package should not add a tool per request. Start with
P2-A as a design spike and contract proposal for schedule visual structure. In
parallel, prepare P2-B/P2-C policy decisions as short product notes. Deploy or
NAS publish still waits for explicit approval after the full plan is complete.
