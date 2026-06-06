import assert from "node:assert/strict";

import {
  BROAD_SCAN_STOP_REASONS,
  normalizeBroadScanResult,
  normalizeBroadScanStopReason,
} from "../build/utils/broadScanResult.js";
import {
  normalizeSheetTextResult,
} from "../build/tools/inspect_sheet_text.js";
import {
  normalizeScheduleResult,
} from "../build/tools/inspect_schedules.js";
import { registerTools } from "../build/tools/register.js";

const expectedStopReasons = [
  "completed",
  "max_elapsed",
  "max_rows",
  "max_columns",
  "max_cells",
  "max_items",
  "max_bytes",
  "read_failed",
  "needs_scope",
];

assert.deepEqual(BROAD_SCAN_STOP_REASONS, expectedStopReasons);
assert.equal(normalizeBroadScanStopReason("max_schedule_cells"), "max_cells");
assert.equal(normalizeBroadScanStopReason("max_text_notes"), "max_items");
assert.equal(normalizeBroadScanStopReason("max_viewports"), "max_items");
assert.equal(normalizeBroadScanStopReason("socket_timeout"), "max_elapsed");
assert.equal(normalizeBroadScanStopReason(""), "completed");

const normalized = normalizeBroadScanResult({
  success: true,
  action: "inspect_sheet_text",
  partial: true,
  scanStoppedReason: "max_schedule_cells",
  matches: [{ kind: "scheduleCell", sheetId: 10, row: 2, column: 3, text: "QHK" }],
}, {
  action: "inspect_sheet_text",
  elapsedMs: 12,
  scanPolicy: { maxResponseBytes: 4096 },
  suggestedNextScopes: ["sheetIds"],
  summary: (payload) => ({ matchCount: payload.matches.length }),
  evidenceRows: (payload) => payload.matches,
  lastRead: (payload) => ({
    lastReadSheetId: payload.matches[0].sheetId,
    lastReadRow: payload.matches[0].row,
    lastReadColumn: payload.matches[0].column,
    lastReadItemId: payload.matches[0].sheetId,
  }),
});

assert.equal(normalized.scanStoppedReason, "max_cells");
assert.equal(normalized.rawScanStoppedReason, "max_schedule_cells");
assert.equal(normalized.partial, true);
assert.deepEqual(normalized.suggestedNextScopes, ["sheetIds"]);
assert.deepEqual(normalized.summary, { matchCount: 1 });
assert.equal(normalized.evidenceRows.length, 1);
assert.equal(normalized.lastReadSheetId, 10);
assert.equal(normalized.lastReadRow, 2);
assert.equal(normalized.lastReadColumn, 3);
assert.equal(normalized.lastReadViewId, null);

let summarySawResolvedEvidence = false;
const evidenceBeforeSummary = normalizeBroadScanResult({
  success: true,
}, {
  action: "inspect_sheet_text",
  evidenceRows: () => [{ sourceType: "sheetTextNote", id: 1 }],
  summary: (payload) => {
    summarySawResolvedEvidence = Array.isArray(payload.evidenceRows) && payload.evidenceRows.length === 1;
    return { evidenceCount: payload.evidenceRows.length };
  },
});
assert.equal(summarySawResolvedEvidence, true);
assert.equal(evidenceBeforeSummary.summary.evidenceCount, 1);

const nativeSheetTextPayload = normalizeSheetTextResult({
  Success: true,
  Action: "inspect_sheet_text",
  SheetQuery: "M701",
  TextQuery: "QHK",
  Partial: false,
  ScanStoppedReason: "completed",
  TotalSheets: 2,
  CandidateCount: 1,
  ReturnedCount: 1,
  ScannedSheetCount: 1,
  Matches: [{
    Kind: "scheduleCell",
    SheetId: 1001,
    SheetNumber: "M701",
    SheetName: "Mechanical Schedules",
    ScheduleId: 2002,
    Section: "body",
    Row: 4,
    Column: 2,
    Text: "QHK 310.001",
    sourceType: "raw_untrusted",
  }],
}, 14);
assert.equal(nativeSheetTextPayload.evidenceRows.length, 1);
assert.equal(nativeSheetTextPayload.summary.matchCount, 1);
assert.equal(nativeSheetTextPayload.evidenceRows[0].sourceType, "placedScheduleCell");
assert.equal(nativeSheetTextPayload.lastReadSheetId, 1001);
assert.equal(nativeSheetTextPayload.lastReadRow, 4);
assert.equal(nativeSheetTextPayload.lastReadColumn, 2);

const nativeScheduleFailurePayload = normalizeScheduleResult({
  Success: false,
  Action: "inspect_schedules",
  Error: "Autodesk.Revit.Exceptions.InvalidOperationException: section read failed",
}, {}, 9);
assert.equal(nativeScheduleFailurePayload.success, false);
assert.equal(nativeScheduleFailurePayload.state, "failed");
assert.equal(nativeScheduleFailurePayload.partial, false);
assert.equal(nativeScheduleFailurePayload.scanStoppedReason, "read_failed");
assert.equal(nativeScheduleFailurePayload.summary.scanStoppedReason, "read_failed");

const elapsedNull = normalizeBroadScanResult({
  success: true,
  elapsedMs: null,
}, {
  action: "inspect_schedules",
});
assert.equal(elapsedNull.elapsedMs, null);

const elapsedFalse = normalizeBroadScanResult({
  success: true,
  elapsedMs: false,
}, {
  action: "inspect_schedules",
});
assert.equal(elapsedFalse.elapsedMs, null);

const tools = new Map();
const server = {
  tool(name, description, schema, handler) {
    if (typeof description === "object") {
      handler = schema;
    }
    tools.set(name, { schema, handler });
  },
};

await registerTools(server);

const sheetGuard = await tools.get("inspect_sheet_text").handler({
  textQuery: "QHK",
});
const sheetPayload = JSON.parse(sheetGuard.content[0].text);
assert.equal(sheetPayload.success, true);
assert.equal(sheetPayload.guarded, true);
assert.equal(sheetPayload.state, "guarded");
assert.equal(sheetPayload.action, "inspect_sheet_text");
assert.equal(sheetPayload.partial, false);
assert.equal(sheetPayload.scanStoppedReason, "needs_scope");
assert.equal(Array.isArray(sheetPayload.suggestedNextScopes), true);
assert.equal(typeof sheetPayload.scanPolicy, "object");
assert.equal(typeof sheetPayload.summary, "object");
assert.equal(Array.isArray(sheetPayload.evidenceRows), true);
assert.equal(sheetPayload.evidenceRows.length, 0);
assert.equal(sheetPayload.lastReadSheetId, null);
assert.equal(sheetPayload.lastReadItemId, null);

const scheduleGuard = await tools.get("inspect_schedules").handler({
  includeCells: true,
  maxRowsPerSection: 0,
  maxColumnsPerSection: 0,
});
const schedulePayload = JSON.parse(scheduleGuard.content[0].text);
assert.equal(schedulePayload.success, true);
assert.equal(schedulePayload.guarded, true);
assert.equal(schedulePayload.state, "guarded");
assert.equal(schedulePayload.action, "inspect_schedules");
assert.equal(schedulePayload.partial, false);
assert.equal(schedulePayload.scanStoppedReason, "needs_scope");
assert.equal(Array.isArray(schedulePayload.suggestedNextScopes), true);
assert.equal(typeof schedulePayload.scanPolicy, "object");
assert.equal(schedulePayload.scanPolicy.maxRowsPerSection, 0);
assert.equal(schedulePayload.scanPolicy.maxColumnsPerSection, 0);
assert.equal(typeof schedulePayload.summary, "object");
assert.equal(Array.isArray(schedulePayload.evidenceRows), true);
assert.equal(schedulePayload.evidenceRows.length, 0);
assert.equal(schedulePayload.lastReadSection, null);
assert.equal(schedulePayload.lastReadItemId, null);

console.log("broad scan result contract tests passed");
