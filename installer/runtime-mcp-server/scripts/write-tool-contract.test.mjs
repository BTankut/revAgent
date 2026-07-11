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

function assertDoesNotContain(source, text, message) {
  assert.equal(source.includes(text), false, message);
}

const liveRegisterToolScripts = new Set([
  "live-junk-model-smoke.mjs",
]);

for (const fileName of fs.readdirSync(path.join(packageRoot, "scripts")).filter((name) => name.endsWith(".mjs")).sort()) {
  const source = readSource(path.join("scripts", fileName));
  if (!source.includes("registerTools")) {
    continue;
  }
  if (liveRegisterToolScripts.has(fileName)) {
    continue;
  }
  assert.ok(
    source.includes("REVAGENT_TELEMETRY_DISABLED") || source.includes("REVAGENT_TELEMETRY_ROOT"),
    `${fileName} uses registerTools and must disable or isolate telemetry so tests cannot write to the live dashboard.`,
  );
}

const setElementParameter = readSource("src/tools/set_element_parameter.ts");
assertContains(setElementParameter, "[PRODUCTION_PARAMETER_WRITE]", "set_element_parameter must stay marked as a production write tool.");
assertContains(setElementParameter, "runtimeGuarded", "set_element_parameter must use the shared runtime guarded result contract for JS-side guards.");
assertContains(setElementParameter, "runtimeFailure", "set_element_parameter must use the shared runtime failure result contract for JS-side failures.");
assertContains(setElementParameter, 'mode: z.enum(["dryRun", "commit"]).optional().default("dryRun")', "set_element_parameter must default to dryRun.");
assertContains(setElementParameter, 'transactionMode: mode === "commit" ? "auto" : "none"', "set_element_parameter must only use auto transaction mode for commit.");
assertContains(setElementParameter, 'operation: z.enum(["set", "clear", "clearVisibleValue"])', "set_element_parameter must expose explicit true-clear and visible-clear operations.");
assertContains(setElementParameter, "expectedCurrentRaw", "set_element_parameter must keep compare-and-set current value protection.");
assertContains(setElementParameter, "allowTypeParameterWrite", "set_element_parameter must keep explicit type parameter write approval.");
assertContains(setElementParameter, "expected_current_raw_mismatch", "set_element_parameter must guard stale current values.");
assertContains(setElementParameter, "verified = rawVerified", "set_element_parameter must verify committed readback.");
assertContains(setElementParameter, "rollbackSafety", "set_element_parameter must expose rollback safety metadata.");
assertContains(setElementParameter, "rollbackTrueNoValueMayBeUnsupported", "set_element_parameter must warn when true no-value rollback may not be supported.");
assertContains(setElementParameter, "prior_no_value_state_may_not_be_restorable_for_non_shared_parameter", "set_element_parameter must warn before writes that may not restore prior HasValue=false state.");
assertContains(setElementParameter, "normalizeParameterOperation", "set_element_parameter must normalize the public operation before generating C#.");
assertContains(setElementParameter, "clear_value_requires_shared_parameter", "set_element_parameter must guard non-shared true no-value clears before commit.");
assertContains(setElementParameter, "clear_value_requires_hide_when_no_value", "set_element_parameter must guard shared parameters that cannot hide no-value state.");
assertContains(setElementParameter, "clear_value_hide_when_no_value_unverified", "set_element_parameter must guard shared clears when HideWhenNoValue cannot be verified.");
assertContains(setElementParameter, "SharedParameterElement", "set_element_parameter must resolve bound shared parameter metadata through SharedParameterElement.");
assertContains(setElementParameter, "ShouldHideWhenNoValue", "set_element_parameter must verify the Revit shared-parameter hide flag before clear commit.");
assertContains(setElementParameter, "canRestoreTrueNoValue = false", "set_element_parameter clear guards must disclose that true HasValue=false restore is impossible for this parameter kind.");
assertContains(setElementParameter, "attemptedClearValue = true", "set_element_parameter clear failures must report that ClearValue was actually attempted.");
assertContains(setElementParameter, "attemptedClearValue = false", "set_element_parameter non-shared clear guards must avoid pretending ClearValue was tried.");
assertContains(setElementParameter, "clear_visible_value_sets_empty_string_and_does_not_restore_revit_has_value_false", "set_element_parameter visible clears must disclose that HasValue=false is not restored.");
assertContains(setElementParameter, "visible_clear_requires_string_parameter", "set_element_parameter visible clears must guard non-string parameters.");
assertContains(setElementParameter, 'visibleEmptyClearOperation = "clearVisibleValue"', "set_element_parameter parameter identity must advertise the visible clear operation.");
assertContains(setElementParameter, 'noValueState = !p.HasValue', "set_element_parameter parameter identity must distinguish true no-value from visible empty string.");

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
for (const field of ["actualAfter", "projectedAfter", "wouldChange", "actualAfterBasis", "projectedAfterBasis"]) {
  assertContains(setScheduleCells, `${field} =`, `set_schedule_cells change rows must expose explicit ${field} semantics.`);
}
assertContains(setScheduleCells, 'deprecatedLegacyFields = new string[] { "after", "changed" }', "set_schedule_cells must mark ambiguous legacy change fields as deprecated without removing them.");
assertContains(setScheduleCells, "changeFieldContract = ChangeFieldContract()", "set_schedule_cells responses with change rows must publish the explicit field contract.");
assert.match(
  setScheduleCells,
  /string actualAfter = readable \? before : null;[\s\S]*string projectedAfter = !blocked && readable \? requestedValue : null;[\s\S]*bool wouldChange = !blocked && cellWouldChange;/,
  "set_schedule_cells dry-run must distinguish the current observed value from the requested projected value and block-ineligible changes.",
);
assertContains(
  setScheduleCells,
  "planned.Add(CellResult(i, row, column, requestedValue, before, before, actualAfter, projectedAfter, readable, cellWouldChange, wouldChange, actualAfterBasis, projectedAfterBasis, false, blocked, reason, error));",
  "set_schedule_cells dry-run must keep legacy after/before behavior while returning requestedValue through projectedAfter and the explicit wouldChange result.",
);
assertContains(
  setScheduleCells,
  'committedChanges.Add(CellResult(i, row, column, requestedValue, before, after, after, requestedValue, readableBefore, changed, changed, actualAfterBasis, "requested_value_committed_target", verified, !verified, verified ? "" : "verification_failed", writeError));',
  "set_schedule_cells commit rows must expose verified readback as actualAfter and the requested target as projectedAfter.",
);

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
assertContains(setScheduleCellsByText, "responseMode", "set_schedule_cells_by_text must expose compact/full response shaping.");
assertContains(setScheduleCellsByText, "omittedMatchCount", "set_schedule_cells_by_text compact response must report omitted matches.");

const sendCodeSafe = readSource("src/tools/send_code_to_revit_safe.ts");
assertContains(sendCodeSafe, "runtimeGuarded", "send_code_to_revit_safe must report protected paths through the shared guarded result contract.");
assertContains(sendCodeSafe, "runtimeSuccess", "send_code_to_revit_safe must report successful safe execution through the shared result contract.");
assertContains(sendCodeSafe, "runtimeFailure", "send_code_to_revit_safe must report runtime failures through the shared result contract.");

const inspectSheetText = readSource("src/tools/inspect_sheet_text.ts");
assertContains(inspectSheetText, "[SHEET_TEXT_INSPECTION_READ_ONLY]", "inspect_sheet_text must stay marked as a read-only sheet text inspection tool.");
assertContains(inspectSheetText, 'sendRevitCommand("inspect_sheet_text"', "inspect_sheet_text must call the native commandset command.");
assertContains(inspectSheetText, "normalizeBroadScanResult", "inspect_sheet_text must normalize through the shared broad-scan result contract.");
assertContains(inspectSheetText, "buildBroadScanGuardedResult", "inspect_sheet_text guarded paths must use the shared broad-scan result contract.");
assertContains(inspectSheetText, "readNativeResultArray(payload, \"matches\")", "inspect_sheet_text must read native Matches/matches through the shared casing-robust ingest helper.");
assertContains(inspectSheetText, "export function normalizeSheetTextResult", "inspect_sheet_text native-result normalization must be directly fixture-testable.");
assert.match(inspectSheetText, /\.\.\.row,[\s\S]*sourceType: sourceTypeForSheetEvidence\(row\)/, "inspect_sheet_text evidence rows must apply normalized sourceType after spreading raw row fields.");
assertContains(inspectSheetText, "includeViewportTextNotes", "inspect_sheet_text must expose viewport text-note inspection.");
assertContains(inspectSheetText, "includeViewportTags", "inspect_sheet_text must expose viewport tag inspection.");
assertContains(inspectSheetText, "maxTags", "inspect_sheet_text must expose a bounded viewport tag cap.");
assertContains(inspectSheetText, "maxViewports", "inspect_sheet_text must expose the roadmap viewport cap alias.");
assertContains(inspectSheetText, "maxResponseBytes", "inspect_sheet_text must expose the native response-size guard.");
assertDoesNotContain(inspectSheetText, "viewport_tags_deferred", "inspect_sheet_text must not regress viewport tags to the old deferred contract.");

const inspectSchedules = readSource("src/tools/inspect_schedules.ts");
assertContains(inspectSchedules, "[SCHEDULE_INSPECTION_READ_ONLY]", "inspect_schedules must stay marked as a read-only schedule inspection tool.");
assertContains(inspectSchedules, "normalizeBroadScanResult", "inspect_schedules must normalize through the shared broad-scan result contract.");
assertContains(inspectSchedules, "buildBroadScanGuardedResult", "inspect_schedules guarded paths must use the shared broad-scan result contract.");
assertContains(inspectSchedules, "buildScheduleEvidenceRows", "inspect_schedules must expose assistant-readable schedule evidence rows.");
assertContains(inspectSchedules, "export function normalizeScheduleResult", "inspect_schedules native-result normalization must be directly fixture-testable.");
assertContains(inspectSchedules, 'sendRevitCommand("inspect_schedules"', "inspect_schedules must use the native commandset bridge instead of generated dynamic C#.");
assertContains(inspectSchedules, "readNativeResultField(payload, \"success\") === false", "inspect_schedules failed native payloads must stop as read_failed.");
assertContains(inspectSchedules, "schedules.filter(isObject)", "inspect_schedules must ignore non-object schedule entries before reading sections.");
assertContains(inspectSchedules, "readNativeResultArray(schedule, \"sections\")", "inspect_schedules must ignore non-object section entries before reading matches.");
assertContains(inspectSchedules, "readNativeResultField(lastEvidence, \"scheduleId\") ?? readNativeResultField(lastSchedule, \"id\") ?? null", "inspect_schedules must keep last scanned schedule id when no cell evidence matched.");
assertContains(inspectSchedules, "clampIntArg(args.maxRowsPerSection, 80, 0, 1000)", "inspect_schedules must preserve valid zero row limits.");
assertContains(inspectSchedules, "clampIntArg(args.maxColumnsPerSection, 30, 0, 200)", "inspect_schedules must preserve valid zero column limits.");
assertContains(inspectSchedules, "nameMatched: inventoryMode ? false", "inspect_schedules inventory mode must not expose schedule names as matches.");
assertContains(inspectSchedules, "result.matches = []", "inspect_schedules inventory mode must clear legacy top-level matches.");
assertContains(inspectSchedules, "maxElapsedMs", "inspect_schedules must expose native elapsed-budget control.");
assertContains(inspectSchedules, "maxCells", "inspect_schedules must expose native cell-budget control.");
assertContains(inspectSchedules, "maxResponseBytes", "inspect_schedules must expose native response-byte budget control.");
assertContains(inspectSchedules, "startRow", "inspect_schedules must expose row continuation scope.");
assertContains(inspectSchedules, "startColumn", "inspect_schedules must expose column continuation scope.");
assertContains(inspectSchedules, "responseMode", "inspect_schedules must expose compact/full response shaping.");
assertContains(inspectSchedules, "use responseMode=full", "inspect_schedules must tell callers how to request full schedule cells.");

const countAnnotations = readSource("src/tools/count_annotations.ts");
assertContains(countAnnotations, "[ANNOTATION_COUNT_READ_ONLY]", "count_annotations must stay marked as a read-only annotation count tool.");
assertContains(countAnnotations, 'sendRevitCommand("count_annotations"', "count_annotations must call the native commandset command.");
assertContains(countAnnotations, "normalizeBroadScanResult", "count_annotations must normalize through the shared broad-scan result contract.");
assertContains(countAnnotations, "readNativeResultArray(payload, \"evidenceRows\")", "count_annotations must read native EvidenceRows/evidenceRows through the shared casing-robust ingest helper.");
assertContains(countAnnotations, "export function normalizeCountAnnotationsResult", "count_annotations native-result normalization must be directly fixture-testable.");
assertContains(countAnnotations, "invalid_count_mode_for_sources", "count_annotations must guard tag-specific count modes when non-tag sources are explicit.");
assertContains(countAnnotations, "maxRegexPatternLength", "count_annotations must bound regex profile size.");
assertContains(countAnnotations, "regexTimeoutMs", "count_annotations must expose per-candidate bounded regex matching.");
assertContains(countAnnotations, "computeFallbackCounts", "count_annotations must keep count semantics fixture-testable through the canonical normalizer.");
assertContains(countAnnotations, "viewport_text_notes", "count_annotations must expose viewport text-note source aliases.");
assertContains(countAnnotations, "viewportTextNote", "count_annotations wrapper must normalize viewport text-note evidence source types.");

const broadScanResult = readSource("src/utils/broadScanResult.ts");
assertContains(broadScanResult, "finiteNumberOrNull", "Shared broad-scan contract must not coerce null elapsedMs to zero.");
assertContains(broadScanResult, "readNativeResultField", "Shared broad-scan contract must own casing-robust native result ingest.");
assertContains(broadScanResult, "readNativeResultArray", "Shared broad-scan contract must expose casing-robust native array reads.");
for (const reason of ["completed", "max_elapsed", "max_rows", "max_columns", "max_cells", "max_items", "max_bytes", "read_failed", "needs_scope"]) {
  assertContains(broadScanResult, `"${reason}"`, `Shared broad-scan stop reason '${reason}' must stay defined in one place.`);
}
for (const field of ["summary", "evidenceRows", "lastReadSection", "lastReadRow", "lastReadColumn", "lastReadSheetId", "lastReadViewId", "lastReadViewportId", "lastReadItemId"]) {
  assertContains(broadScanResult, `"${field}"`, `Shared broad-scan field '${field}' must stay defined in one place.`);
}

const revitToolHelpers = readSource("src/utils/revitToolHelpers.ts");
assertContains(revitToolHelpers, "parentTaskName", "Runtime Revit helper must preserve parent task names for wrapper sub-operations.");
assertContains(revitToolHelpers, "parentTaskId", "Runtime Revit helper must preserve parent task ids for wrapper sub-operations.");
assertContains(revitToolHelpers, "applyParentTaskMetadata", "Runtime Revit helper must centralize parent task propagation.");
assertContains(revitToolHelpers, "applyWrapperActionMetadata", "Runtime Revit helper must centralize wrapper action propagation.");
assertContains(revitToolHelpers, "toolName = task.wrapperAction || task.logicalToolName", "Compact Revit status history must expose wrapper tool names before bridge method names.");
assertContains(revitToolHelpers, "commandName", "Compact Revit status history must preserve the native bridge method as commandName.");
assertContains(revitToolHelpers, "parseJsonResult?: boolean", "Dynamic execution helper must let callers preserve raw results when parsing is disabled.");
assertContains(revitToolHelpers, "parseJsonResult === false", "Dynamic execution helper must skip result parsing when requested.");
assertContains(revitToolHelpers, "parseResultStrings: true", "Dynamic execution normalization must parse nested JSON-looking result strings.");
assertContains(revitToolHelpers, "commandParams.wrapperAction", "Wrapper subcalls must forward wrapper action names to bridge params.");
assertContains(revitToolHelpers, "commandParams.logicalToolName", "Wrapper subcalls must forward logical tool names to bridge params.");
assertContains(revitToolHelpers, "commandParams.parentTaskName", "Wrapper subcalls must forward parent task names to live telemetry/bridge params.");

const sendCodeToRevit = readSource("src/tools/send_code_to_revit.ts");
assertContains(sendCodeToRevit, "parseResultStrings: true", "Raw send_code_to_revit parseJsonResult=true must parse canonical nested result strings.");
assertContains(sendCodeToRevit, "args.parseJsonResult === false", "Raw send_code_to_revit must preserve raw wire results when parseJsonResult=false.");
assertContains(sendCodeToRevit, "args.parseJsonResult === false || args.reportErrorResultAsFailure === false", "Raw send_code_to_revit must not re-parse raw results through error-like failure handling when parseJsonResult=false.");

const sendCodeToRevitSafe = readSource("src/tools/send_code_to_revit_safe.ts");
assertContains(sendCodeToRevitSafe, "parseJsonResult: args.parseJsonResult !== false", "Safe dynamic execution must propagate parseJsonResult=false into the lower helper.");

const telemetry = readSource("src/utils/telemetry.ts");
assertContains(telemetry, "guardSource", "Telemetry/live feed must expose guardSource for client/runtime guarded records.");
assertContains(telemetry, "normalizeGuardSource", "Telemetry/live feed must normalize guardSource values.");
assertContains(telemetry, "parentTaskName", "Telemetry/live feed must expose parent task names.");
assertContains(telemetry, "getLiveRuntimeActivityStatus", "Telemetry/live feed must expose compact runtime activity snapshots for status responses.");
assertContains(telemetry, "wrapperAction", "Telemetry/live feed must preserve wrapper action metadata from Revit status snapshots.");
assertContains(telemetry, "RuntimeActivityMode", "Telemetry/live feed must expose summary/full runtime activity modes.");
assertContains(telemetry, 'item.phase !== "started"', "Summary runtime activity must omit started rows to avoid start/completed duplication.");
assertContains(telemetry, "compactRuntimeActivityResult", "Summary runtime activity must trim verbose result payloads such as responseKeys.");

const getRevitMcpStatus = readSource("src/tools/get_revit_mcp_status.ts");
assertContains(getRevitMcpStatus, "includeRuntimeActivity", "get_revit_mcp_status must expose client/runtime guarded history controls.");
assertContains(getRevitMcpStatus, "runtimeActivityLimit", "get_revit_mcp_status must bound runtime activity rows.");
assertContains(getRevitMcpStatus, "runtimeActivityMode", "get_revit_mcp_status must let callers request summary or full runtime activity.");
assertContains(getRevitMcpStatus, "getLiveRuntimeActivityStatus", "get_revit_mcp_status must attach runtime/client activity to status responses.");

const inspectParameterSchema = readSource("src/tools/inspect_parameter_schema.ts");
assertContains(inspectParameterSchema, "noValueState", "inspect_parameter_schema must report the parameter no-value state.");
assertContains(inspectParameterSchema, "visible_empty_has_value", "inspect_parameter_schema must distinguish visible empty strings from true no-value.");
assertContains(inspectParameterSchema, "clearability", "inspect_parameter_schema must report true-clear and visible-clear capability metadata.");
assertContains(inspectParameterSchema, 'visibleEmptyClearOperation = "clearVisibleValue"', "inspect_parameter_schema must point callers to the explicit visible clear operation.");
assertContains(inspectParameterSchema, "ShouldHideWhenNoValue", "inspect_parameter_schema must verify SharedParameterElement HideWhenNoValue before advertising true no-value clear support.");

const viewOperationResult = readSource("src/tools/view_operation_result.ts");
for (const field of ["dryRun", "deleted", "confirmDelete", "targetIsReviewView", "reviewSignals", "deletedElementCount"]) {
  assertContains(viewOperationResult, `"${field}"`, `Navigation view responses must strip cleanup-only field '${field}'.`);
}
for (const toolPath of ["src/tools/activate_view.ts", "src/tools/close_view.ts", "src/tools/list_open_views.ts"]) {
  const source = readSource(toolPath);
  assertContains(source, "stripViewCleanupFields", `${toolPath} must not leak delete_review_view cleanup-only fields.`);
}

const deleteReviewView = readSource("src/tools/delete_review_view.ts");
assertContains(deleteReviewView, "compactDeleteReviewViewResult", "delete_review_view must group cleanup-specific fields in compact responses.");
assertContains(deleteReviewView, 'responseMode: z.enum(["compact", "full"])', "delete_review_view must expose compact/full response shaping.");
assertContains(deleteReviewView, 'responseMode=\\"full\\"', "delete_review_view compact notices must explain how to request raw cleanup diagnostics.");
assertContains(deleteReviewView, "args.confirmDelete", "delete_review_view compact cleanup confirmation should fall back to wrapper args.");

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
