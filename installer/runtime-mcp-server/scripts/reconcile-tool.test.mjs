import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "@e965/xlsx";
import { registerTools } from "../build/tools/register.js";
import { reconcileScheduleExcel } from "../build/tools/reconcile_schedule_excel.js";

XLSX.set_fs(nodeFs);

// registerTools wraps handlers with telemetry; contract tests must not touch the live dashboard.
process.env.REVAGENT_TELEMETRY_DISABLED = "1";
process.env.REVAGENT_LIVE_STATUS_DISABLED = "1";

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
assert.equal("responseMode" in reconcileTool.schema, true);

const representativeInput = {
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
};

const dryRunPayload = parseToolResult(await reconcileTool.handler(representativeInput));

assert.equal(dryRunPayload.success, true);
assert.equal(dryRunPayload.guarded, false);
assert.equal(dryRunPayload.state, "review_ready");
assert.equal(dryRunPayload.action, "reconcile_schedule_excel");
assert.equal(dryRunPayload.reconciliationContractVersion, 1);
assert.equal(dryRunPayload.responseMode, "compact");
assert.equal(dryRunPayload.sourceResults.excel.format, "csv");
assert.equal(dryRunPayload.sourceResults.schedule.visibilityBasis, "displayedScheduleCells");
assert.equal(dryRunPayload.sourceResults.excel.recordCount, 6);
assert.equal(dryRunPayload.sourceResults.schedule.recordCount, 5);
assert.equal("sourceSummary" in dryRunPayload, false);
assert.match(dryRunPayload.warnings.join("\n"), /representative native PascalCase warning/);
assert.equal(dryRunPayload.summary.excelRows, 6);
assert.equal(dryRunPayload.summary.scheduleRows, 5);
assert.equal(dryRunPayload.summary.exactMatches, 1);
assert.equal(dryRunPayload.summary.possibleRenames >= 1, true);
assert.equal(dryRunPayload.summary.ambiguousMatches >= 1, true);
assert.equal(dryRunPayload.summary.missingInSchedule >= 1, true);
assert.equal(dryRunPayload.summary.missingInExcel >= 1, true);
assert.equal("reviewRows" in dryRunPayload, false);
assert.equal("scoringConfig" in dryRunPayload, false);
assert.equal(dryRunPayload.reviewTable.rows.length, dryRunPayload.summary.returnedReviewRowCount);
assert.equal(JSON.stringify(dryRunPayload).includes("tokenProfile"), false);
assert.equal(JSON.stringify(dryRunPayload).includes("rawCells"), false);
assert.equal(JSON.stringify(dryRunPayload).includes("candidateRows"), false);

const compactLimitedPayload = parseToolResult(await reconcileTool.handler({
  ...representativeInput,
  responseMode: "compact",
  maxReviewRows: 2,
  maxCandidateRows: 1,
}));
assert.equal(compactLimitedPayload.responseMode, "compact");
assert.equal(compactLimitedPayload.reviewTable.rows.length, 2);
assert.equal(compactLimitedPayload.summary.reviewRowCount, dryRunPayload.summary.reviewRowCount);
assert.equal(compactLimitedPayload.summary.returnedReviewRowCount, 2);
assert.equal(compactLimitedPayload.summary.omittedReviewRowCount > 0, true);
assert.equal("reviewRows" in compactLimitedPayload, false);
assert.equal(JSON.stringify(compactLimitedPayload).includes("candidateRows"), false);
assert.match(compactLimitedPayload.notices.join("\n"), /responseMode="full"/);

const fullPayload = parseToolResult(await reconcileTool.handler({
  ...representativeInput,
  responseMode: "full",
}));
assert.equal(fullPayload.responseMode, "full");
assert.equal(fullPayload.reviewRows.length, dryRunPayload.summary.reviewRowCount);
assert.equal(fullPayload.reviewTable.rows.length, fullPayload.reviewRows.length);
assert.equal(fullPayload.sourceSummary.excel.excelRecordCount, 6);
assert.equal(fullPayload.sourceSummary.schedule.scheduleRecordCount, 5);
assert.equal(fullPayload.scoringConfig.thresholds.highConfidenceMin, 86);
assert.equal(fullPayload.scoringConfig.thresholds.candidateGap, 8);
assert.equal(Boolean(byReason(fullPayload, "schedule_row_already_claimed")), true);
assert.equal(Boolean(byReason(fullPayload, "shared_key_tokens_with_description_change")), true);
assert.equal(fullPayload.reviewRows.some((row) => Array.isArray(row.candidateRows)), true);
assert.equal(JSON.stringify(fullPayload).includes("tokenProfile"), true);

const invalidShapePayload = await reconcileScheduleExcel({
  excel: {
    kind: "rows",
    rows: { Identity: "not-an-array" },
  },
  schedule: {
    kind: "inspect_schedules_result",
    result: representativeSchedule,
  },
});
assert.equal(invalidShapePayload.guarded, true);
assert.equal(invalidShapePayload.reason, "reconciliation_input_required");
assert.equal(Array.isArray(invalidShapePayload.suggestedNextScopes), true);
assert.equal(typeof invalidShapePayload.schemaExamples.rowsSource.excel, "object");
assert.equal(invalidShapePayload.requiredColumnMapping.requiredRoles.includes("identity"), true);

const workbookPath = path.join(tempRoot, "representative-reconciliation.xlsx");
const workbook = XLSX.utils.book_new();
const worksheet = XLSX.utils.aoa_to_sheet([
  ["Identity", "Description", "Unit", "System"],
  ["XLS-001", "Pump DN80", "PCS", "HVAC"],
]);
XLSX.utils.book_append_sheet(workbook, worksheet, "Items");
XLSX.writeFile(workbook, workbookPath, { bookType: "xlsx" });

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
