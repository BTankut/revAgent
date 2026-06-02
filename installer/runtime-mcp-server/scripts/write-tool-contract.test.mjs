import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

function readSource(relativePath) {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function assertContains(source, text, message) {
  assert.ok(source.includes(text), message);
}

const setElementParameter = readSource("src/tools/set_element_parameter.ts");
assertContains(setElementParameter, "[PRODUCTION_PARAMETER_WRITE]", "set_element_parameter must stay marked as a production write tool.");
assertContains(setElementParameter, "runtimeGuarded", "set_element_parameter must use the shared runtime guarded result contract for JS-side guards.");
assertContains(setElementParameter, "runtimeFailure", "set_element_parameter must use the shared runtime failure result contract for JS-side failures.");
assertContains(setElementParameter, 'mode: z.enum(["dryRun", "commit"]).optional().default("dryRun")', "set_element_parameter must default to dryRun.");
assertContains(setElementParameter, 'transactionMode: mode === "commit" ? "auto" : "none"', "set_element_parameter must only use auto transaction mode for commit.");
assertContains(setElementParameter, "expectedCurrentRaw", "set_element_parameter must keep compare-and-set current value protection.");
assertContains(setElementParameter, "allowTypeParameterWrite", "set_element_parameter must keep explicit type parameter write approval.");
assertContains(setElementParameter, "expected_current_raw_mismatch", "set_element_parameter must guard stale current values.");
assertContains(setElementParameter, "verified = rawVerified", "set_element_parameter must verify committed readback.");

const setScheduleCells = readSource("src/tools/set_schedule_cells.ts");
assertContains(setScheduleCells, "[PRODUCTION_SCHEDULE_CELL_WRITE]", "set_schedule_cells must stay marked as a production write tool.");
assertContains(setScheduleCells, "runtimeFailure", "set_schedule_cells must use the shared runtime failure result contract for JS-side failures.");
assertContains(setScheduleCells, 'const mode = args.mode === "commit" ? "commit" : "dryRun"', "set_schedule_cells must default to dryRun.");
assertContains(setScheduleCells, 'transactionMode: mode === "commit" ? "auto" : "none"', "set_schedule_cells must only use auto transaction mode for commit.");
assertContains(setScheduleCells, "expectedCurrentText", "set_schedule_cells must keep expectedCurrentText protection.");
assertContains(setScheduleCells, "allowCurrentMismatch", "set_schedule_cells must keep explicit stale-cell override.");
assertContains(setScheduleCells, "current_value_mismatch", "set_schedule_cells must guard stale cells by default.");
assertContains(setScheduleCells, "non_writable_standard_body_cell", "set_schedule_cells must guard standard schedule body cells before dry-run says they are committable.");
assertContains(setScheduleCells, "IsStandardScheduleBodyCellWriteForbidden", "set_schedule_cells must preflight Revit's standard body cell write restriction.");
assertContains(setScheduleCells, "IsKeySchedule", "set_schedule_cells must keep key schedule body writes out of the standard body-cell guard.");
assertContains(setScheduleCells, "bool standardScheduleBodyCellWriteForbidden = IsStandardScheduleBodyCellWriteForbidden(schedule, sectionType);", "set_schedule_cells must compute the standard body-cell guard once per schedule section.");
assertContains(setScheduleCells, "Schedule cell verification failed", "set_schedule_cells must verify committed cell text.");

const setScheduleCellsByText = readSource("src/tools/set_schedule_cells_by_text.ts");
assertContains(setScheduleCellsByText, "[PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT]", "set_schedule_cells_by_text must stay marked as a production row-text schedule write tool.");
assertContains(setScheduleCellsByText, "missing_bounded_scope", "set_schedule_cells_by_text must require bounded schedule/sheet scope.");
assertContains(setScheduleCellsByText, "missing_row_text_query", "set_schedule_cells_by_text must require row text evidence before matching rows.");
assertContains(setScheduleCellsByText, "multiple_matching_rows", "set_schedule_cells_by_text must guard ambiguous row matches by default.");
assertContains(setScheduleCellsByText, "expectedCurrentText", "set_schedule_cells_by_text must keep compare-and-set current text protection.");
assertContains(setScheduleCellsByText, "non_writable_standard_body_cell", "set_schedule_cells_by_text must guard standard schedule body cells before dry-run says they are committable.");
assertContains(setScheduleCellsByText, "IsStandardScheduleBodyCellWriteForbidden", "set_schedule_cells_by_text must preflight Revit's standard body cell write restriction.");
assertContains(setScheduleCellsByText, "IsKeySchedule", "set_schedule_cells_by_text must keep key schedule body writes out of the standard body-cell guard.");
assertContains(setScheduleCellsByText, "bool standardScheduleBodyCellWriteForbidden = IsStandardScheduleBodyCellWriteForbidden(schedule, sectionType);", "set_schedule_cells_by_text must compute the standard body-cell guard once per schedule.");
assertContains(setScheduleCellsByText, 'transactionMode: mode === "commit" ? "auto" : "none"', "set_schedule_cells_by_text must only use auto transaction mode for commit.");
assertContains(setScheduleCellsByText, "Schedule cell verification failed", "set_schedule_cells_by_text must verify committed cell text.");

const sendCodeSafe = readSource("src/tools/send_code_to_revit_safe.ts");
assertContains(sendCodeSafe, "runtimeGuarded", "send_code_to_revit_safe must report protected paths through the shared guarded result contract.");
assertContains(sendCodeSafe, "runtimeSuccess", "send_code_to_revit_safe must report successful safe execution through the shared result contract.");
assertContains(sendCodeSafe, "runtimeFailure", "send_code_to_revit_safe must report runtime failures through the shared result contract.");

const exportViewImage = readSource("src/tools/export_revit_view_image.ts");
assertContains(exportViewImage, "runtimeFailure", "export_revit_view_image must report JS-side runtime failures through the shared result contract.");
assertContains(exportViewImage, 'action = "export_revit_view_image"', "export_revit_view_image C# responses must carry the shared action field.");

const exportCoordinationImage = readSource("src/tools/export_revit_coordination_image.ts");
assertContains(exportCoordinationImage, "runtimeFailure", "export_revit_coordination_image must report JS-side runtime failures through the shared result contract.");
assertContains(exportCoordinationImage, 'action = "export_revit_coordination_image"', "export_revit_coordination_image C# responses must carry the shared action field.");
assertContains(exportCoordinationImage, "allowFullViewFallback", "export_revit_coordination_image must require explicit full-view fallback for all-missing requested element ids.");
assertContains(exportCoordinationImage, "no_requested_elements_found", "export_revit_coordination_image must expose a stable guard reason for all-missing requested element ids.");
assertContains(exportCoordinationImage, "requestedElementIds.Count > 0 && targetElements.Count == 0 && !allowFullViewFallback", "export_revit_coordination_image must guard all-missing requested element ids before full-view export.");
assertContains(exportCoordinationImage, "parseElementIds", "export_revit_coordination_image must validate supplied elementIds before C# list generation.");
assertContains(exportCoordinationImage, "invalid_element_ids", "export_revit_coordination_image must guard non-numeric supplied elementIds instead of silently exporting full view evidence.");
assertContains(exportCoordinationImage, "Number.isSafeInteger(value)", "export_revit_coordination_image must reject unsafe numeric element ids before C# list generation.");

const smartFocusElements = readSource("src/tools/smart_focus_elements.ts");
assertContains(smartFocusElements, 'action: "smart_focus_elements"', "smart_focus_elements must expose the lowercase shared action field.");
assertContains(smartFocusElements, "state:", "smart_focus_elements must expose the shared state field.");
assertContains(smartFocusElements, "activeOrRequestedViewThen3D", "smart_focus_elements must honor create3d=true after active/requested focus succeeds.");
assertContains(smartFocusElements, "Smart focus optional 3D view after active/requested focus", "smart_focus_elements must make the post-active-focus 3D step auditable.");
assertContains(smartFocusElements, 'mode: args.mode || "unknown"', "smart_focus_elements catch responses must preserve the requested mode when available.");
assertContains(smartFocusElements, "function isGuardedResult", "smart_focus_elements must detect nested guarded focus results.");
assertContains(smartFocusElements, "guarded: isGuardedResult(planFocus)", "smart_focus_elements must propagate guarded fallback-plan failures to the top-level contract.");

const showElementInPlanAnd3D = readSource("src/tools/show_element_in_plan_and_3d.ts");
assertContains(showElementInPlanAnd3D, 'action: "show_element_in_plan_and_3d"', "show_element_in_plan_and_3d must expose the lowercase shared action field.");
assertContains(showElementInPlanAnd3D, "state:", "show_element_in_plan_and_3d must expose the shared state field.");
assertContains(showElementInPlanAnd3D, "workflowPayload", "show_element_in_plan_and_3d must centralize wrapper response contract creation.");
assertContains(showElementInPlanAnd3D, "function isGuardedResult", "show_element_in_plan_and_3d must detect nested guarded plan results.");
assertContains(showElementInPlanAnd3D, "guarded: isGuardedResult(planResult)", "show_element_in_plan_and_3d must propagate guarded plan failures to the top-level contract.");

console.log("write tool contract tests passed");
