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
assertContains(setScheduleCells, "Schedule cell verification failed", "set_schedule_cells must verify committed cell text.");

const setScheduleCellsByText = readSource("src/tools/set_schedule_cells_by_text.ts");
assertContains(setScheduleCellsByText, "[PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT]", "set_schedule_cells_by_text must stay marked as a production row-text schedule write tool.");
assertContains(setScheduleCellsByText, "missing_bounded_scope", "set_schedule_cells_by_text must require bounded schedule/sheet scope.");
assertContains(setScheduleCellsByText, "missing_row_text_query", "set_schedule_cells_by_text must require row text evidence before matching rows.");
assertContains(setScheduleCellsByText, "multiple_matching_rows", "set_schedule_cells_by_text must guard ambiguous row matches by default.");
assertContains(setScheduleCellsByText, "expectedCurrentText", "set_schedule_cells_by_text must keep compare-and-set current text protection.");
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

console.log("write tool contract tests passed");
