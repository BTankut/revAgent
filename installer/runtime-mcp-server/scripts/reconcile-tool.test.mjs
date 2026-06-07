import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { registerTools } from "../build/tools/register.js";
import { reconcileScheduleExcel } from "../build/tools/reconcile_schedule_excel.js";

const tools = new Map();
const server = {
  tool(name, description, schema, handler) {
    tools.set(name, { description, schema, handler });
  },
};
await registerTools(server);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "revagent-reconcile-tool-"));

try {
function scheduleFixture(rows, options = {}) {
  return {
    Success: true,
    Guarded: false,
    Partial: options.partial === true,
    ScanStoppedReason: options.scanStoppedReason || "completed",
    Warnings: options.warnings || ["representative native PascalCase warning"],
    Schedules: [
      {
        Id: options.scheduleId || 7001,
        Name: options.scheduleName || "Mechanical Equipment Schedule",
        Sections: [
          {
            Section: "Header",
            Rows: [
              {
                Row: 0,
                Cells: [
                  { Column: 0, Text: "Identity" },
                  { Column: 1, Text: "Description" },
                  { Column: 2, Text: "Unit" },
                  { Column: 3, Text: "System" },
                  { Column: 4, Text: "Quantity" },
                  { Column: 5, Text: "Discipline" },
                ],
              },
            ],
          },
          {
            Section: "Body",
            Rows: rows.map((row, index) => ({
              Row: index + 1,
              Cells: [
                { Column: 0, Text: row.Identity || "" },
                { Column: 1, Text: row.Description || "" },
                { Column: 2, Text: row.Unit || "" },
                { Column: 3, Text: row.System || "" },
                { Column: 4, Text: row.Quantity || "" },
                { Column: 5, Text: row.Discipline || "" },
              ],
            })),
          },
        ],
      },
    ],
  };
}

function parseToolResult(result) {
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

function byReason(payload, reason) {
  return payload.reviewRows.find((row) => row.reason === reason);
}

const csvPath = path.join(tempRoot, "representative-reconciliation.csv");
await fs.writeFile(
  csvPath,
  [
    "Identity,Description,Unit,System,Quantity,Discipline",
    "FCU-101,\"Fan coil supply DN100 1,5 l/s\",PCS,HVAC,1,Mechanical",
    "FCU-102,\"Fan coil return DN100 1,5 l/s\",PCS,HVAC,1,Mechanical",
    "QHK-310,Fire damper DN200,PCS,HVAC,2,Mechanical",
    "CHW-777,Chilled water valve DN50,PCS,HVAC,1,Mechanical",
    "DUCT-900,Supply air duct DN250,M,HVAC,6,Mechanical",
    "FCU-101A,\"Fan coil supply DN100 1,5 l/s\",PCS,HVAC,1,Mechanical",
  ].join("\n"),
  "utf8",
);

const representativeSchedule = scheduleFixture([
  { Identity: "FCU-101", Description: "Fan coil supply DN100 1.5 L/S", Unit: "PCS", System: "HVAC", Quantity: "1", Discipline: "Mechanical" },
  { Identity: "FCU-102", Description: "Fan coil return terminal DN100 1.5 L/S", Unit: "PCS", System: "HVAC", Quantity: "1", Discipline: "Mechanical" },
  { Identity: "QHK-310", Description: "Smoke damper DN200", Unit: "PCS", System: "HVAC", Quantity: "2", Discipline: "Mechanical" },
  { Identity: "VAL-050", Description: "Chilled water valve DN50", Unit: "PCS", System: "HVAC", Quantity: "1", Discipline: "Mechanical" },
  { Identity: "SCH-ONLY", Description: "Exhaust air grille DN150", Unit: "PCS", System: "HVAC", Quantity: "3", Discipline: "Mechanical" },
]);

const reconcileTool = tools.get("reconcile_schedule_excel");
assert.equal(Boolean(reconcileTool), true);
assert.match(reconcileTool.description, /write-free/);
assert.equal("excel" in reconcileTool.schema, true);
assert.equal("schedule" in reconcileTool.schema, true);
assert.equal("config" in reconcileTool.schema, true);

const dryRunPayload = parseToolResult(await reconcileTool.handler({
  excel: {
    kind: "file",
    path: csvPath,
    format: "csv",
    columnMapping: {
      identity: "Identity",
      comparisonText: "Description",
      unit: "Unit",
      system: "System",
      quantity: "Quantity",
      discipline: "Discipline",
    },
  },
  schedule: {
    kind: "inspect_schedules_result",
    result: representativeSchedule,
  },
}));

assert.equal(dryRunPayload.success, true);
assert.equal(dryRunPayload.guarded, false);
assert.equal(dryRunPayload.state, "review_ready");
assert.equal(dryRunPayload.action, "reconcile_schedule_excel");
assert.equal(dryRunPayload.reconciliationContractVersion, 1);
assert.equal(dryRunPayload.sourceResults.excel.format, "csv");
assert.equal(dryRunPayload.sourceResults.schedule.visibilityBasis, "displayedScheduleCells");
assert.equal(dryRunPayload.sourceSummary.excel.excelRecordCount, 6);
assert.equal(dryRunPayload.sourceSummary.schedule.scheduleRecordCount, 5);
assert.match(dryRunPayload.warnings.join("\n"), /representative native PascalCase warning/);
assert.equal(dryRunPayload.summary.excelRows, 6);
assert.equal(dryRunPayload.summary.scheduleRows, 5);
assert.equal(dryRunPayload.summary.exactMatches, 1);
assert.equal(dryRunPayload.summary.possibleRenames >= 1, true);
assert.equal(dryRunPayload.summary.ambiguousMatches >= 1, true);
assert.equal(dryRunPayload.summary.missingInSchedule >= 1, true);
assert.equal(dryRunPayload.summary.missingInExcel >= 1, true);
assert.equal(dryRunPayload.reviewTable.rows.length, dryRunPayload.reviewRows.length);
assert.equal(dryRunPayload.scoringConfig.thresholds.highConfidenceMin, 86);
assert.equal(dryRunPayload.scoringConfig.thresholds.candidateGap, 8);
assert.equal(Boolean(byReason(dryRunPayload, "schedule_row_already_claimed")), true);
assert.equal(Boolean(byReason(dryRunPayload, "shared_key_tokens_with_description_change")), true);

const workbookPath = path.join(tempRoot, "representative-reconciliation.xlsx");
const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet("Items");
worksheet.addRow(["Identity", "Description", "Unit", "System"]);
worksheet.addRow(["XLS-001", "Pump DN80", "PCS", "HVAC"]);
await workbook.xlsx.writeFile(workbookPath);

const xlsxPayload = await reconcileScheduleExcel({
  excel: {
    kind: "file",
    path: workbookPath,
    format: "xlsx",
    selection: { sheetName: "Items" },
    columnMapping: {
      identity: "Identity",
      comparisonText: "Description",
      unit: "Unit",
      system: "System",
    },
  },
  schedule: {
    kind: "inspect_schedules_result",
    result: scheduleFixture([
      { Identity: "XLS-001", Description: "Pump DN80", Unit: "PCS", System: "HVAC" },
    ], { warnings: [] }),
  },
});
assert.equal(xlsxPayload.success, true);
assert.equal(xlsxPayload.state, "review_ready");
assert.equal(xlsxPayload.sourceResults.excel.format, "xlsx");
assert.equal(xlsxPayload.summary.exactMatches, 1);

const partialSourcePayload = await reconcileScheduleExcel({
  excel: {
    kind: "rows",
    sheetName: "Rows",
    rows: [{ Identity: "PART-01", Description: "Partial schedule row" }],
    columnMapping: {
      identity: "Identity",
      comparisonText: "Description",
    },
  },
  schedule: {
    kind: "inspect_schedules_result",
    result: scheduleFixture([
      { Identity: "PART-01", Description: "Partial schedule row" },
    ], { partial: true, scanStoppedReason: "max_rows", warnings: [] }),
  },
});
assert.equal(partialSourcePayload.success, true);
assert.equal(partialSourcePayload.state, "review_ready");
assert.equal(partialSourcePayload.partial, true);
assert.equal(partialSourcePayload.scanStoppedReason, "max_rows");

const guardedRevitSchedulePayload = await reconcileScheduleExcel({
  excel: {
    kind: "rows",
    sheetName: "Rows",
    rows: [{ Identity: "LIVE-01", Description: "Live schedule deferred" }],
    columnMapping: {
      identity: "Identity",
      comparisonText: "Description",
    },
  },
  schedule: {
    kind: "revit_schedule",
    scheduleIds: [7001],
    columnMapping: {
      identity: 0,
      comparisonText: 1,
    },
  },
});
assert.equal(guardedRevitSchedulePayload.success, true);
assert.equal(guardedRevitSchedulePayload.guarded, true);
assert.equal(guardedRevitSchedulePayload.state, "guarded");
assert.equal(guardedRevitSchedulePayload.reason, "revit_schedule_bridge_deferred");
assert.equal(guardedRevitSchedulePayload.stage, "schedule_record_adapter");

console.log("reconcile tool tests passed");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
