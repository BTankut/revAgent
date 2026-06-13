import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTools } from "../build/tools/register.js";

const tools = new Map();
await registerTools({
  tool(name, description, schema, handler) {
    tools.set(name, { description, schema, handler });
  },
});

function parseToolResult(result) {
  assert.equal(result.content?.[0]?.type, "text", "tool response must be text content");
  return JSON.parse(result.content[0].text);
}

async function statusPreflight(nextTool) {
  const status = parseToolResult(await tools.get("get_revit_mcp_status").handler({
    recentLimit: 3,
    runtimeActivityLimit: 3,
    timeoutMs: 5000,
  }));
  if (!status.service?.isRunning) {
    throw new Error("Revit MCP service is not running.");
  }
  if (status.activeTask) {
    const taskName = status.activeTask.taskName || status.activeTask.method || "unknown";
    throw new Error(`Revit MCP is busy with ${taskName}; wait before running ${nextTool}.`);
  }
  return status;
}

async function callTool(name, args = {}) {
  const tool = tools.get(name);
  assert.ok(tool, `tool registered: ${name}`);
  await statusPreflight(name);
  return parseToolResult(await tool.handler(args));
}

function assertSuccess(payload, label) {
  assert.equal(payload.success, true, `${label} should succeed`);
  assert.notEqual(payload.state, "failed", `${label} should not fail`);
}

async function findJunkTarget(prefix) {
  const payload = await callTool("find_elements", {
    categoryNames: ["Mechanical Equipment", "Ducts", "Pipes", "Air Terminals"],
    planCandidateMode: "none",
    searchBudget: "fast",
    maxElementsScanned: 5000,
    maxElapsedMs: 3000,
    timeoutMs: 10000,
    limit: 1,
    taskName: `${prefix} target seed`,
  });
  assertSuccess(payload, "target seed search");
  const row = payload.elements?.[0] || payload.Elements?.[0];
  assert.ok(row?.id || row?.Id, "junk smoke requires at least one MEP element in the active test model");
  return Number(row.id ?? row.Id);
}

async function smokeSafeCodeGuard(prefix, summary) {
  const payload = await callTool("send_code_to_revit_safe", {
    intent: "writePreview",
    transactionMode: "none",
    code: "using (var tx = new Transaction(document, \"blocked\")) { tx.Start(); tx.Commit(); } return \"blocked\";",
    taskName: `${prefix} safe code guard`,
  });
  assert.equal(payload.success, false, "safe code write-looking snippet should not succeed");
  assert.equal(payload.guarded, true, "safe code write-looking snippet should be guarded");
  assert.equal(payload.reason, "safe_wrapper_rejected_write_looking_code");
  summary.safeCodeGuard = "guarded";
}

async function smokeParameterSetRestore(prefix, elementId, summary) {
  const marker = `revAgent live smoke ${Date.now()}`;
  const dryRun = await callTool("set_element_parameter", {
    elementId,
    parameterName: "Comments",
    mode: "dryRun",
    operation: "set",
    value: marker,
    taskName: `${prefix} parameter dry-run`,
    timeoutMs: 20000,
  });
  if (dryRun.guarded) {
    summary.parameterSetRestore = `skipped: ${dryRun.reason || dryRun.guardReason || "guarded"}`;
    return;
  }
  assertSuccess(dryRun, "parameter dry-run");
  const visibleClearDryRun = await callTool("set_element_parameter", {
    elementId,
    parameterName: "Comments",
    mode: "dryRun",
    operation: "clearVisibleValue",
    taskName: `${prefix} parameter visible clear dry-run`,
    timeoutMs: 20000,
  });
  assertSuccess(visibleClearDryRun, "parameter visible clear dry-run");
  assert.equal(visibleClearDryRun.requested?.clearValueSupport, "not_applicable_visible_clear_uses_empty_string_set");
  assert.match((visibleClearDryRun.warnings || []).join("\n"), /does_not_restore_revit_has_value_false/);
  if (dryRun.before?.hasValue !== true) {
    summary.parameterSetRestore = "skipped: Comments had no prior value; true no-value restore is not forced by smoke";
    return;
  }

  const priorRaw = String(dryRun.before.raw ?? "");
  const setResult = await callTool("set_element_parameter", {
    elementId,
    parameterName: "Comments",
    mode: "commit",
    operation: "set",
    expectedCurrentRaw: priorRaw,
    value: marker,
    taskName: `${prefix} parameter commit`,
    timeoutMs: 30000,
  });
  assertSuccess(setResult, "parameter commit");
  assert.equal(setResult.committed, true, "parameter commit should write");
  assert.equal(setResult.verification?.verified, true, "parameter commit should verify");

  const restoreResult = await callTool("set_element_parameter", {
    elementId,
    parameterName: "Comments",
    mode: "commit",
    operation: "set",
    expectedCurrentRaw: marker,
    value: priorRaw,
    taskName: `${prefix} parameter restore`,
    timeoutMs: 30000,
  });
  assertSuccess(restoreResult, "parameter restore");
  assert.equal(restoreResult.committed, true, "parameter restore should write");
  assert.equal(restoreResult.verification?.verified, true, "parameter restore should verify");
  summary.parameterSetRestore = "committed_and_restored";
}

async function smokeScheduleBodyWriteGuard(prefix, summary) {
  const schedules = await callTool("inspect_schedules", {
    allowExpensiveSearch: true,
    includeCells: true,
    sections: ["body"],
    maxSchedules: 5,
    maxRowsPerSection: 2,
    maxColumnsPerSection: 2,
    maxCells: 20,
    responseMode: "full",
    searchBudget: "fast",
    timeoutMs: 15000,
    taskName: `${prefix} schedule seed`,
  });
  assertSuccess(schedules, "schedule seed");
  const schedule = (schedules.schedules || schedules.Schedules || []).find((item) =>
    (item.sections || item.Sections || []).some((section) => String(section.section || section.Section).toLowerCase() === "body")
  );
  if (!schedule) {
    summary.scheduleBodyWriteGuard = "skipped: no body schedule fixture found";
    return;
  }
  const section = (schedule.sections || schedule.Sections || []).find((item) => String(item.section || item.Section).toLowerCase() === "body");
  const row = Number(section?.cells?.[0]?.row ?? section?.Cells?.[0]?.Row ?? 0);
  const firstCell = section?.cells?.[0]?.cells?.[0] || section?.Cells?.[0]?.Cells?.[0];
  const column = Number(firstCell?.column ?? firstCell?.Column ?? 0);
  const expectedCurrentText = String(firstCell?.text ?? firstCell?.Text ?? "");
  const guardProbeValue = expectedCurrentText === "__revAgent_schedule_guard_probe__"
    ? "__revAgent_schedule_guard_probe_alt__"
    : "__revAgent_schedule_guard_probe__";
  const guard = await callTool("set_schedule_cells", {
    scheduleId: schedule.id ?? schedule.Id,
    section: "body",
    cells: [{ row, column, value: guardProbeValue, expectedCurrentText }],
    mode: "dryRun",
    allowCurrentMismatch: false,
    taskName: `${prefix} schedule body write guard`,
    timeoutMs: 20000,
  });
  assert.equal(guard.success, false, "standard schedule body write should be guarded in ordinary schedules");
  assert.equal(guard.guarded, true, "standard schedule body write should be guarded");
  assert.equal(guard.reason || guard.guardReason, "non_writable_standard_body_cell");
  summary.scheduleBodyWriteGuard = "guarded";
}

async function smokeFocusExportCleanup(prefix, elementId, summary) {
  const focus = await callTool("focus_elements", {
    elementIds: [elementId],
    select: true,
    zoom: false,
    fitToScreen: false,
    timeoutMs: 10000,
    taskName: `${prefix} focus`,
  });
  assertSuccess(focus, "focus");

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "revagent-live-junk-smoke-"));
  try {
    const viewExport = await callTool("export_revit_view_image", {
      range: "current_view",
      format: "png",
      pixelSize: 600,
      outputDir,
      filePrefix: "view-smoke",
      taskName: `${prefix} view export`,
      timeoutMs: 60000,
    });
    assertSuccess(viewExport, "view export");
    assert.ok((viewExport.files || []).length > 0, "view export should produce at least one file");

    const coordination = await callTool("export_revit_coordination_image", {
      elementIds: [elementId],
      viewName: `revAgent_QA_LIVE_SMOKE_${Date.now()}`,
      targetVisualStyle: "qa_high_contrast",
      cleanupAfterExport: true,
      pixelSize: 600,
      outputDir,
      filePrefix: "coordination-smoke",
      taskName: `${prefix} coordination export`,
      timeoutMs: 90000,
    });
    assertSuccess(coordination, "coordination export");
    assert.ok((coordination.files || []).length > 0, "coordination export should produce at least one file");

    const clear = await callTool("clear_selection", {
      taskName: `${prefix} clear selection`,
      timeoutMs: 10000,
    });
    assertSuccess(clear, "clear selection");
    assert.equal(clear.selectionCountAfter, 0, "clear_selection should leave no selected elements");
    summary.focusViewExportCoordinationCleanup = "completed";
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
    summary.outputDirCleaned = true;
  }
}

const prefix = "live junk model smoke";
const summary = {};
const targetElementId = await findJunkTarget(prefix);
summary.targetElementId = targetElementId;

await smokeSafeCodeGuard(prefix, summary);
await smokeParameterSetRestore(prefix, targetElementId, summary);
await smokeScheduleBodyWriteGuard(prefix, summary);
await smokeFocusExportCleanup(prefix, targetElementId, summary);

console.log(JSON.stringify({
  success: true,
  action: "live_junk_model_smoke",
  summary,
}, null, 2));
