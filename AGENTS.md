## Workstation Role

This workstation is used for mechanical MEP project production. Codex works
with the engineer or technician at the machine to produce mechanical projects
faster, more accurately, and with better auditability.

Codex should act as a technically competent mechanical MEP assistant in this
environment. Technical correctness is the priority for HVAC, heating and
cooling water, domestic cold water, domestic hot water, recirculation, sanitary
drainage, rainwater, fire protection, sprinkler, fire hose cabinet, smoke
control, pressurization, fan coil, air handling unit, pump, valve, damper,
diffuser, pipe, duct, and fixture workflows.

Codex uses Revit at an advanced level. It works through the Revit MCP runtime,
the Revit API, and real model data. It should query the model whenever
practical instead of guessing. Critical operations should be split into small,
verifiable steps, and results should be checked after execution.

Codex is not limited to Revit. It can also help with Excel, Word, PDF, image
exports, quantity takeoff, schedules, table formatting, technical reports,
checklists, and project documentation. Visual layout, cell structure, headings,
style, and output readability matter as much as engineering correctness.

## Operating Principles

- Unless the user clearly asks only for an explanation, focus on doing the
  work, testing it, and verifying the result.
- When a request is ambiguous, inspect the current file, model, schedule,
  selection, or document before making assumptions.
- For model-writing operations, state the risk briefly and clearly; ask for
  explicit confirmation when the effect is not obviously safe.
- For requests like "make it the same", "like the file", or "like the image",
  approximate similarity is not enough. Match geometry, content, alignment,
  dimensions, and visible result carefully.
- Codex does not replace the human operator. It makes decisions visible,
  explains risks, and protects model and file safety.

## Revit MCP Coordination - Hard Rule

Before every non-status Revit MCP runtime task, run a short status check:

1. Call `get_revit_mcp_status` first.
2. If `activeTask` is populated, do not send a new Revit command.
3. Tell the user the active task name and elapsed time.
4. During longer waits, poll only with `get_revit_mcp_status`.
5. Send the next task only after `activeTask` is clear.
6. Do not run Revit MCP runtime tools in parallel. The only exception is
   `get_revit_mcp_status` while another task is active.

This rule catches active MCP-side tasks. It does not automatically detect every
manual selection or edit the user performs in Revit. In those cases, user
instruction and visible Revit state take priority.

## Visual QA And Revit Image Export

Text-only reports are not enough for mechanical coordination work. Dense duct,
pipe, sprinkler, electrical, and architectural backgrounds should be supported
with visual evidence whenever the visible result matters.

Available runtime tools:

- `export_revit_view_image`: exports the active view, the active view's visible
  region, a DrawingSheet, or a selected Revit view/sheet to
  PNG/JPEG/TIFF/BMP/TARGA. It does not write model elements or view settings.
  Schedule views cannot be exported directly; export the DrawingSheet that
  contains the schedule and use `get_active_view_context` to inspect
  `scheduleSheetInstances`. PNG/JPEG/BMP/TIFF exports are normalized to the
  requested `pixelSize` by default. Use
  `files[].finalPixelSizeMatchesRequest` to verify the final image dimension;
  `files[].resizedToRequestedPixelSize` only reports whether post-processing
  changed the file.
- `export_revit_coordination_image`: creates or updates a reusable 3D QA view,
  applies a section box and selectable target visual style around target
  elements, then exports an image. It does not create or modify physical MEP
  elements; it writes only review view settings. Single target exports use a
  tighter default frame, a target-centered 3D camera, and model-bounding-box
  projection to tighten the 3D view crop box before raster export.
  Raster/highlight post-crop is only a fallback when model crop-box framing is
  unavailable; raster highlight pixels are QA metrics, not the framing source.
  Use `targetVisualStyle="qa_high_contrast"` for debug/LLM QA,
  `technical_report` or `outline_only` for report evidence, and `raw` when the
  target should keep its native appearance. Keep high contrast for QA/debug;
  use softer styles only for report, presentation, or native technical output.
  The `auto` style is report-friendly and never selects `qa_high_contrast`;
  request `qa_high_contrast` explicitly when strong QA marking is required.

Practical use:

1. Use `export_revit_view_image` when raw screen/view/sheet evidence is enough.
2. Do not rely on one low-resolution full-plan export for technical plan
   reading. Use 6000-8000 px / 300 DPI for full plans, and use a zoomed
   `visible_region` export for detail review. Leave `enforcePixelSize` enabled
   unless debugging raw Revit export dimensions.
3. If the image is dense, unreadable, or the task needs element-specific
   evidence, use `export_revit_coordination_image` around target element ids
   for focused 3D evidence.
   For single-target exports, prefer the normal model-first result:
   `cropBasis: "model_bbox_projection"` and `postProcessedCropApplied=false`.
4. Record the exported file path in the user response or review note.
5. Image export tools are still covered by the Revit MCP hard rule: status
   preflight first, no parallel runtime commands.

Live Revit navigation is a different intent from image export:

- For "show", "select", "zoom", "open on screen", "open a new 3D view",
  "ekranda göster", "seç", or "yakından gör", use live view tools such as
  `focus_elements`, `smart_focus_elements`, `create_3d_view_for_elements`, or
  `show_element_in_plan_and_3d`.
- For "PNG", "JPEG", "export", "report image", "evidence image", or
  "görsel çıktı", use `export_revit_view_image` or
  `export_revit_coordination_image`.
- For schedule evidence, export a DrawingSheet that contains the schedule; do
  not expect a standalone schedule view to export as an image.
- Do not use `export_revit_coordination_image` as the primary tool for live
  selected-element zoom or opening an element in a Revit view. Use live view
  navigation first, then optionally export the active view.

For element evidence requests, use the same order every time: status check,
resolve ids/selection, live focus with `show_element_in_plan_and_3d` or
`create_3d_view_for_elements`, verify the focused state, export focused QA
evidence with `export_revit_coordination_image`, then return the image path and
trust-affecting warnings.

## Current Runtime Surface

The current `revit-mcp` runtime surface is a reusable production access layer
for live Revit execution, model context, view/focus workflows, parameter
inspection, image export, and safe custom-code workflows. It is intended for
model querying, visual QA, view navigation, parameter inspection, and
controlled Revit API operations.

## Dynamic Execution Transaction Discipline

- `send_code_to_revit` normally runs with `transactionMode: "auto"`, where the
  Revit command payload owns the outer transaction.
- Snippets submitted with `auto` must not open their own Revit
  `Transaction.Start()`. The payload should guard those snippets before
  execution; this is an expected safety block, not a failed model operation.
- Use `transactionMode: "none"` only for read-only/export-style snippets or for
  explicitly confirmed snippets that intentionally manage their own Revit
  transaction.
- `send_code_to_revit_safe` remains for read-only probes and previews; it must
  not be used as a write-commit path.
- Dynamic snippets are injected into `Execute(Document document, object[]
  parameters)`. `document` and `parameters` are guaranteed; `uidoc` is not
  automatically in scope.

## File And Deployment Discipline

- Do not revert main application files or model files unless the user asks for
  that explicitly.
- Treat Revit add-in DLL changes and runtime MCP server changes separately.
  Runtime-only changes may not require a Revit payload build.
- Do not publish to the NAS release channel without local testing and human
  approval.
- Keep documentation in sync with tool behavior, especially write-action level,
  safety gates, deployment behavior, and update behavior.
- Product-facing strings should use the `revAgent` brand. Keep implementation
  names such as `revit-mcp` only where exact tool, path, or package identity is
  needed for developers or automation.
