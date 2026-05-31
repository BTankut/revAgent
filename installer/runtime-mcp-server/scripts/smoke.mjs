import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerTools } from "../build/tools/register.js";
import { resolveAutoTargetVisualStyle } from "../build/tools/export_revit_coordination_image.js";
import {
  formatJsonContent,
  normalizeRevitExecutionResponse,
  truncateText,
} from "../build/utils/revitToolHelpers.js";
import {
  recordTelemetryEvent,
  extractProductionContext,
  resolveTelemetryTargets,
  sanitizeTelemetryPathSegment,
  summarizeTelemetryParams,
  summarizeTelemetryResponse,
} from "../build/utils/telemetry.js";

const tools = new Map();
const server = {
  tool(name, description, schema, handler) {
    if (typeof description === "object") {
      handler = schema;
      schema = description;
      description = "";
    }
    tools.set(name, { description, schema, handler });
  },
};

await registerTools(server);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, "..");
const srcToolsDir = path.join(runtimeRoot, "src", "tools");
const registerSource = fs.readFileSync(path.join(srcToolsDir, "register.ts"), "utf8");
const registeredToolModules = new Set(
  [...registerSource.matchAll(/from\s+["']\.\/([^"']+)\.js["']/g)]
    .map((match) => match[1])
    .sort(),
);
const sourceToolModules = fs
  .readdirSync(srcToolsDir)
  .filter((fileName) =>
    fileName.endsWith(".ts") &&
    fileName !== "register.ts" &&
    !fileName.endsWith(".guard-test.ts")
  )
  .map((fileName) => fileName.replace(/\.ts$/, ""))
  .sort();
const unregisteredServerToolModules = sourceToolModules.filter((moduleName) => {
  const source = fs.readFileSync(path.join(srcToolsDir, `${moduleName}.ts`), "utf8");
  return /server\.tool\s*\(/.test(source) && !registeredToolModules.has(moduleName);
});
assert.deepEqual(
  unregisteredServerToolModules,
  [],
  "Every source module that defines server.tool(...) must be imported by src/tools/register.ts.",
);

const expectedTools = [
  "list_revit_instances",
  "get_revit_mcp_status",
  "send_code_to_revit",
  "send_code_to_revit_safe",
  "get_revit_session_context",
  "get_active_view_context",
  "list_open_views",
  "activate_view",
  "close_view",
  "get_ui_state",
  "find_elements",
  "open_existing_plan_for_element_level",
  "focus_elements",
  "section_box_elements",
  "create_3d_view_for_elements",
  "export_revit_view_image",
  "export_revit_coordination_image",
  "show_element_in_plan_and_3d",
  "smart_focus_elements",
  "inspect_elements",
  "inspect_parameter_schema",
];

assert.deepEqual([...tools.keys()], expectedTools);

const create3dDescription = tools.get("create_3d_view_for_elements").description;
const showPlan3dDescription = tools.get("show_element_in_plan_and_3d").description;
const coordinationDescription = tools.get("export_revit_coordination_image").description;
assert.match(create3dDescription, /LIVE_VIEW_NAVIGATION_PRIMITIVE/);
assert.match(showPlan3dDescription, /LIVE_VIEW_WORKFLOW_WRAPPER/);
assert.match(coordinationDescription, /VISUAL_ARTIFACT_EXPORT_ONLY/);
assert.match(coordinationDescription, /Do not use this as the primary tool for live view navigation/);
assert.match(coordinationDescription, /Use qa_high_contrast explicitly/);

const autoStyleExpectations = {
  raw_evidence: "raw",
  coordination_overlay: "outline_only",
  system_focus: "technical_report",
  clash_clearance: "technical_report",
};
for (const [intent, expectedStyle] of Object.entries(autoStyleExpectations)) {
  const resolvedStyle = resolveAutoTargetVisualStyle(intent);
  assert.equal(resolvedStyle, expectedStyle);
  assert.notEqual(resolvedStyle, "qa_high_contrast");
}

const chooseExpectedToolForIntent = (utterance) => {
  const text = utterance.toLocaleLowerCase("tr-TR");
  if (/(png|jpeg|jpg|export|çıktı|görsel|rapor|evidence)/.test(text)) {
    return "export_revit_coordination_image";
  }
  if (/(plan).*(3d)|(3d).*(plan)/.test(text)) {
    return "show_element_in_plan_and_3d";
  }
  if (/(3d|yakından|zoom|seç|göster|ekranda|aç)/.test(text)) {
    return "create_3d_view_for_elements";
  }
  return null;
};
assert.equal(
  chooseExpectedToolForIntent("seçili elemanı yeni 3D'de açıp zoomla"),
  "create_3d_view_for_elements",
);
assert.notEqual(
  chooseExpectedToolForIntent("seçili elemanı yeni 3D'de açıp zoomla"),
  "export_revit_coordination_image",
);
assert.equal(
  chooseExpectedToolForIntent("bu eleman için rapora PNG görsel çıktı al"),
  "export_revit_coordination_image",
);

const normalized = normalizeRevitExecutionResponse({
  result: JSON.stringify({ success: true, count: 2 }),
});
assert.equal(normalized.result.success, true);
assert.equal(normalized.result.count, 2);

const content = formatJsonContent({ success: true });
assert.equal(content.content[0].type, "text");
assert.match(content.content[0].text, /"success": true/);
assert.doesNotMatch(content.content[0].text, /"Success":/);

const successAliasContent = formatJsonContent({
  Success: true,
  nested: { success: false },
});
const successAliasPayload = JSON.parse(successAliasContent.content[0].text);
assert.equal(successAliasPayload.success, true);
assert.equal("Success" in successAliasPayload, false);
assert.equal(successAliasPayload.nested.success, false);
assert.equal("Success" in successAliasPayload.nested, false);

const trimmed = truncateText("abcdef", 3);
assert.equal(trimmed.truncated, true);
assert.match(trimmed.text, /truncated 3 chars/);

assert.equal(sanitizeTelemetryPathSegment("HAFIZE"), "HAFIZE");
assert.equal(sanitizeTelemetryPathSegment("MARINA"), "MARINA");
assert.equal(sanitizeTelemetryPathSegment("office machine/name"), "office_machine_name");

const telemetryParamSummary = summarizeTelemetryParams({
  code: "using (var t = new Transaction(document, \"x\")) { t.Start(); t.Commit(); }",
  elementIds: [1, 2, 3],
  transactionMode: "none",
  query: "sensitive search text",
});
assert.equal(telemetryParamSummary.code.lineCount, 1);
assert.equal(telemetryParamSummary.code.hasManualTransaction, true);
assert.match(telemetryParamSummary.code.preview, /Transaction/);
assert.equal(telemetryParamSummary.elementIds.count, 3);
assert.equal(telemetryParamSummary.transactionMode, "none");
assert.equal(typeof telemetryParamSummary.query.hash, "string");
assert.equal(telemetryParamSummary.query.text, "sensitive search text");

const telemetryResponseSummary = summarizeTelemetryResponse({
  result: {
    success: false,
    state: "guarded",
    error: "C:\\Projects\\Secret\\model.rvt blocked by safety",
  },
});
assert.equal(telemetryResponseSummary.success, false);
assert.equal(telemetryResponseSummary.guarded, true);
assert.match(telemetryResponseSummary.errorMessage, /Secret/);

const wrapperFailureSummary = summarizeTelemetryResponse({
  success: false,
  result: null,
  errorMessage: "Execution failed inside Revit wrapper",
});
assert.equal(wrapperFailureSummary.success, false);
assert.equal(wrapperFailureSummary.errorMessage, "Execution failed inside Revit wrapper");

const safeRejectionSummary = summarizeTelemetryResponse({
  success: false,
  error: "Rejected write-looking code for intent 'writePreview'.",
});
assert.equal(safeRejectionSummary.guarded, true);

const productionContext = extractProductionContext({
  sourceEventType: "revit.command",
  commandName: "find_elements",
  logicalToolName: "find_elements",
  executionKind: "bridgeCommand",
  taskName: "Find ducts on Level 02 Room 204",
  taskId: "run-204",
  durationMs: 42,
  params: {
    taskName: "Find ducts on Level 02 Room 204",
    query: "supply duct room 204",
    categoryNames: ["Ducts"],
    elementIds: [101, 102],
  },
  response: {
    success: true,
    Action: "find_elements",
    DocumentTitle: "Office Tower",
    DocumentPath: "C:\\Projects\\Office Tower\\MEP.rvt",
    ActiveView: { Id: 7, Name: "Level 02 - Mechanical", ViewType: "FloorPlan" },
    LevelName: "Level 02",
    SelectionIds: [101],
    Elements: [
      { Id: 101, Name: "Supply Duct", Category: "Ducts", LevelName: "Level 02", RoomNumber: "204" },
    ],
  },
});
assert.equal(productionContext.eventType, "production.context");
assert.equal(productionContext.runId, "run-204");
assert.equal(productionContext.operation.taskName, "Find ducts on Level 02 Room 204");
assert.equal(productionContext.project.documentTitle, "Office Tower");
assert.match(productionContext.project.documentPath, /Office Tower/);
assert.equal(productionContext.view.active.name, "Level 02 - Mechanical");
assert.equal(productionContext.location.levelName, "Level 02");
assert.deepEqual(productionContext.elements.targetElementIds, [101, 102]);
assert.deepEqual(productionContext.elements.selectionIds, [101]);
assert.equal(productionContext.elements.disciplineHint, "mechanical_hvac");
assert.equal(productionContext.elements.samples[0].roomNumber, "204");

const telemetryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-telemetry-"));
process.env.REVAGENT_TELEMETRY_ROOT = telemetryRoot;
process.env.REVAGENT_TELEMETRY_LOCAL_ONLY = "1";
await recordTelemetryEvent({
  eventType: "runtime.test",
  timestampUtc: "2026-05-27T00:00:00.000Z",
});
const telemetryTargets = resolveTelemetryTargets({
  timestampUtc: "2026-05-27T00:00:00.000Z",
  machineName: "HAFIZE",
  sessionId: "session",
});
assert.equal(telemetryTargets.length, 1);
assert.match(telemetryTargets[0].path, /2026-05-27\.ndjson$/);
const telemetryFile = path.join(telemetryRoot, "events", "2026-05-27.ndjson");
assert.equal(fs.existsSync(telemetryFile), true);
const telemetryLine = fs.readFileSync(telemetryFile, "utf8").trim();
assert.equal(JSON.parse(telemetryLine).eventType, "runtime.test");
delete process.env.REVAGENT_TELEMETRY_LOCAL_ONLY;
process.env.REVAGENT_REPORTS_ROOT = path.join(telemetryRoot, "reports");
const remoteTargets = resolveTelemetryTargets({
  timestampUtc: "2026-05-27T00:00:00.000Z",
  machineName: "hafize",
  sessionId: "session",
});
assert.equal(remoteTargets.some((target) => target.kind === "remote" && target.path.includes(`${path.sep}HAFIZE${path.sep}`)), true);

const orderedIndexes = Array.from({ length: 20 }, (_, index) => index);
await Promise.all(orderedIndexes.map((index) => recordTelemetryEvent({
  eventType: "ordered.test",
  timestampUtc: "2026-05-28T00:00:00.000Z",
  order: index,
})));
const orderedLocalFile = path.join(telemetryRoot, "events", "2026-05-28.ndjson");
const orderedLocalLines = fs.readFileSync(orderedLocalFile, "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((line) => line.eventType === "ordered.test");
assert.deepEqual(orderedLocalLines.map((line) => line.order), orderedIndexes);
assert.deepEqual(
  orderedLocalLines.map((line) => line.sequence),
  [...orderedLocalLines].sort((a, b) => a.sequence - b.sequence).map((line) => line.sequence),
);
const orderedRemoteDayRoot = path.join(telemetryRoot, "reports", "events", "2026", "05", "28");
const orderedRemoteFiles = fs.readdirSync(orderedRemoteDayRoot)
  .flatMap((machineName) => fs.readdirSync(path.join(orderedRemoteDayRoot, machineName))
    .filter((fileName) => fileName.endsWith(".ndjson"))
    .map((fileName) => path.join(orderedRemoteDayRoot, machineName, fileName)));
assert.equal(orderedRemoteFiles.length > 0, true);
const orderedRemoteLines = orderedRemoteFiles.flatMap((fileName) =>
  fs.readFileSync(fileName, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
).filter((line) => line.eventType === "ordered.test");
assert.deepEqual(orderedRemoteLines.map((line) => line.order), orderedIndexes);

const safeTool = tools.get("send_code_to_revit_safe");
const rejection = await safeTool.handler({
  code: "document.Delete(new ElementId(1));",
  intent: "writeCommit",
  taskName: "Write preview for Level 02 Room 204",
});
const rejectionPayload = JSON.parse(rejection.content[0].text);
assert.equal(rejectionPayload.success, false);
assert.equal(rejectionPayload.guarded, true);
assert.match(rejectionPayload.error, /does not support writeCommit/);
await new Promise((resolve) => setTimeout(resolve, 150));
const telemetryFiles = fs.readdirSync(path.join(telemetryRoot, "events"))
  .filter((fileName) => fileName.endsWith(".ndjson"))
  .map((fileName) => path.join(telemetryRoot, "events", fileName));
const telemetryLines = telemetryFiles.flatMap((fileName) =>
  fs.readFileSync(fileName, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
);
const toolTelemetry = telemetryLines.find((line) => line.eventType === "mcp.tool" && line.toolName === "send_code_to_revit_safe");
assert.equal(toolTelemetry.result.success, false);
assert.equal(toolTelemetry.result.guarded, true);
assert.equal(toolTelemetry.taskName, "Write preview for Level 02 Room 204");
assert.equal(toolTelemetry.params.code.writePatternCount > 0, true);
const productionTelemetry = telemetryLines.find((line) => line.eventType === "production.context" && line.related?.toolName === "send_code_to_revit_safe");
assert.equal(productionTelemetry.operation.taskName, "Write preview for Level 02 Room 204");
assert.equal(productionTelemetry.operation.guarded, true);
delete process.env.REVAGENT_TELEMETRY_ROOT;
delete process.env.REVAGENT_REPORTS_ROOT;

console.error("runtime MCP smoke passed");
