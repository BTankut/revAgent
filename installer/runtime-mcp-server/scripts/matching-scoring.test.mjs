import assert from "node:assert/strict";
import { ingestExcelSource } from "../build/tools/reconcile_excel_ingestion.js";
import { adaptScheduleSource } from "../build/tools/reconcile_schedule_adapter.js";
import {
  reconcileScheduleExcelRecords,
  scoreReconciliationPair,
} from "../build/tools/reconcile_matching.js";

async function buildExcelResult(rows) {
  return ingestExcelSource({
    kind: "rows",
    sheetName: "Excel",
    rows,
    columnMapping: {
      identity: "Identity",
      comparisonText: "Description",
      unit: "Unit",
    },
  });
}

async function buildScheduleResult(rows) {
  return adaptScheduleSource({
    kind: "inspect_schedules_result",
    result: {
      success: true,
      partial: false,
      scanStoppedReason: "completed",
      schedules: [
        {
          id: 9001,
          name: "Reconciliation Schedule",
          sections: [
            {
              section: "header",
              rows: [
                {
                  row: 0,
                  cells: [
                    { column: 0, text: "Identity" },
                    { column: 1, text: "Description" },
                    { column: 2, text: "Unit" },
                    { column: 3, text: "System" },
                    { column: 4, text: "Quantity" },
                    { column: 5, text: "Discipline" },
                  ],
                },
              ],
            },
            {
              section: "body",
              rows: rows.map((row, index) => ({
                row: index + 1,
                cells: [
                  { column: 0, text: row.Identity ?? "" },
                  { column: 1, text: row.Description ?? "" },
                  { column: 2, text: row.Unit ?? "" },
                  { column: 3, text: row.System ?? "" },
                  { column: 4, text: row.Quantity ?? "" },
                  { column: 5, text: row.Discipline ?? "" },
                ],
              })),
            },
          ],
        },
      ],
    },
  });
}

async function reconcileCase(excelRows, scheduleRows, config) {
  const excelResult = await buildExcelResult(excelRows);
  const scheduleResult = await buildScheduleResult(scheduleRows);
  assert.equal(excelResult.success, true);
  assert.equal(excelResult.guarded, false);
  assert.equal(scheduleResult.success, true);
  assert.equal(scheduleResult.guarded, false);
  return reconcileScheduleExcelRecords({ excelResult, scheduleResult, config });
}

function onlyRow(result, bucket) {
  const rows = result.reviewRows.filter((row) => row.bucket === bucket);
  assert.equal(rows.length, 1, `expected exactly one ${bucket}, got ${rows.length}`);
  return rows[0];
}

const exact = await reconcileCase(
  [{ Identity: "EX-01", Description: "Fan coil DN100", Unit: "PCS" }],
  [{ Identity: "EX-01", Description: "Fan coil DN100", Unit: "PCS" }],
);
assert.equal(exact.success, true);
assert.equal(exact.state, "review_ready");
assert.equal(exact.reconciliationContractVersion, 1);
assert.equal(exact.summary.exactMatches, 1);
assert.equal(onlyRow(exact, "exactMatches").score, 100);
assert.equal(exact.reviewTable.rows.length, exact.reviewRows.length);

const highConfidence = await reconcileCase(
  [{ Identity: "HC-01", Description: "Fan coil supply DN100 1,5 l/s", Unit: "PCS" }],
  [
    { Identity: "HC-01", Description: "Supply fan coil DN100 1.5 L/S", Unit: "PCS" },
    { Identity: "HC-01", Description: "Different terminal DN200 1.5 L/S", Unit: "PCS" },
  ],
);
const highRow = onlyRow(highConfidence, "highConfidenceMatches");
assert.equal(highRow.score >= 86 && highRow.score <= 99, true);
assert.equal(highRow.reason, "high_confidence_score_and_gap");
assert.equal(highRow.candidateRows.length >= 2, true);
assert.equal(highRow.candidateRows[0].score - highRow.candidateRows[1].score >= 8, true);

const possibleRename = await reconcileCase(
  [{ Identity: "RN-01", Description: "Fan coil DN100", Unit: "PCS" }],
  [{ Identity: "RN-01", Description: "Cassette terminal DN100", Unit: "PCS" }],
);
const renameRow = onlyRow(possibleRename, "possibleRenames");
assert.equal(renameRow.score >= 72 && renameRow.score <= 85, true);
assert.equal(renameRow.recommendedNextAction, "rename_excel_or_schedule_text");

const highScoreRename = await reconcileCase(
  [{ Identity: "HR-01", Description: "Fan coil cassette DN100", Unit: "PCS" }],
  [{ Identity: "HR-01", Description: "Fan coil terminal DN100", Unit: "PCS" }],
);
const highRenameRow = onlyRow(highScoreRename, "possibleRenames");
assert.equal(highRenameRow.score >= 86, true);
assert.equal(highRenameRow.reason, "shared_key_tokens_with_description_change");

const duplicateKey = await reconcileCase(
  [
    { Identity: "DUP-01", Description: "Fan coil DN100", Unit: "PCS" },
    { Identity: "DUP-01", Description: "Fan coil DN100", Unit: "PCS" },
  ],
  [{ Identity: "DUP-01", Description: "Fan coil DN100", Unit: "PCS" }],
);
assert.equal(duplicateKey.summary.ambiguousMatches, 2);
assert.equal(duplicateKey.reviewRows.every((row) => row.bucket === "ambiguousMatches" && row.reason === "duplicate_exact_key"), true);

const tieWithinGap = await reconcileCase(
  [{ Identity: "TIE-01", Description: "Fan coil Alpha Beta DN100", Unit: "PCS" }],
  [
    { Identity: "TIE-01", Description: "Fan coil Alpha DN100", Unit: "PCS" },
    { Identity: "TIE-01", Description: "Fan coil Beta DN100", Unit: "PCS" },
  ],
);
const tieRow = onlyRow(tieWithinGap, "ambiguousMatches");
assert.equal(tieRow.reason, "best_score_tie");
assert.equal(tieRow.candidateRows.length, 2);

const conflictingDimension = await reconcileCase(
  [{ Identity: "DIM-01", Description: "Fan coil DN100", Unit: "PCS" }],
  [{ Identity: "DIM-01", Description: "Fan coil DN200", Unit: "PCS" }],
);
const dimensionRow = onlyRow(conflictingDimension, "ambiguousMatches");
assert.equal(dimensionRow.score, 60);
assert.deepEqual(dimensionRow.hardConflicts, ["conflicting_dimension"]);

const conflictingCode = await reconcileCase(
  [{ Identity: "COD-01", Description: "Fan coil DN100", Unit: "PCS" }],
  [{ Identity: "COD-02", Description: "Fan coil DN100", Unit: "PCS" }],
);
const codeRow = onlyRow(conflictingCode, "ambiguousMatches");
assert.equal(codeRow.score, 64);
assert.deepEqual(codeRow.hardConflicts, ["conflicting_code"]);

const unitMismatch = await reconcileCase(
  [{ Identity: "UNIT-01", Description: "Fan coil", Unit: "MM" }],
  [{ Identity: "UNIT-01", Description: "Fan coil", Unit: "CM" }],
);
const unitRow = onlyRow(unitMismatch, "ambiguousMatches");
assert.equal(unitRow.score, 79);
assert.deepEqual(unitRow.hardConflicts, ["unit_mismatch"]);

const scheduleReuse = reconcileScheduleExcelRecords({
  excelRecords: [
    { recordId: "claim-exact", identityText: "", comparisonText: "Fan coil DN100" },
    { recordId: "claim-reuse", identityText: "", comparisonText: "Fan coil supply DN100" },
  ],
  scheduleRecords: [
    { recordId: "claim-schedule", identityText: "", comparisonText: "Fan coil DN100" },
  ],
});
assert.equal(scheduleReuse.summary.exactMatches, 1);
const reusedRow = onlyRow(scheduleReuse, "ambiguousMatches");
assert.equal(reusedRow.reason, "schedule_row_already_claimed");

const missingBothSides = await reconcileCase(
  [{ Identity: "MISS-X", Description: "Only excel side", Unit: "PCS" }],
  [{ Identity: "MISS-S", Description: "Only schedule side", Unit: "PCS" }],
);
assert.equal(missingBothSides.summary.missingInSchedule, 1);
assert.equal(missingBothSides.summary.missingInExcel, 1);
assert.equal(onlyRow(missingBothSides, "missingInSchedule").recommendedNextAction, "create_schedule_row");
assert.equal(onlyRow(missingBothSides, "missingInExcel").recommendedNextAction, "remove_or_ignore_schedule_row");

const possibleRenameWithTighterThreshold = await reconcileCase(
  [{ Identity: "CFG-01", Description: "Fan coil DN100", Unit: "PCS" }],
  [{ Identity: "CFG-01", Description: "Cassette terminal DN100", Unit: "PCS" }],
  {
    thresholds: {
      candidateMin: 80,
      possibleRenameMin: 80,
    },
  },
);
assert.equal(possibleRenameWithTighterThreshold.summary.possibleRenames, 0);
assert.equal(possibleRenameWithTighterThreshold.summary.missingInSchedule, 1);
assert.equal(possibleRenameWithTighterThreshold.summary.missingInExcel, 1);

const directCapScore = scoreReconciliationPair(
  {
    excelRowId: "Direct!1",
    identityText: "CAP-01",
    comparisonText: "Fan coil DN100",
    mappedValues: { unit: "PCS" },
  },
  {
    scheduleRowId: "9001:body:1",
    identityText: "CAP-01",
    comparisonText: "Fan coil DN200",
    mappedValues: { unit: "PCS" },
  },
);
assert.equal(directCapScore.score, 60);
assert.equal(directCapScore.rawScore > directCapScore.score, true);

const prefixUnitConflict = scoreReconciliationPair(
  {
    excelRowId: "Direct!2",
    identityText: "UNIT-DIM",
    comparisonText: "Fan coil DN100",
  },
  {
    scheduleRowId: "9001:body:2",
    identityText: "UNIT-DIM",
    comparisonText: "Fan coil 100MM",
  },
);
assert.equal(prefixUnitConflict.hardConflicts.includes("conflicting_dimension"), true);
assert.equal(prefixUnitConflict.hardConflicts.includes("unit_mismatch"), true);

const nonExactHundred = await reconcileCase(
  [{ Identity: "NEX-01", Description: "Fan coil supply DN100", Unit: "PCS" }],
  [{ Identity: "NEX-01", Description: "Supply fan coil DN100", Unit: "PCS" }],
  {
    score: {
      diceTokenOverlap: 100,
      code: 100,
      dimension: 100,
      order: 100,
      context: 100,
    },
  },
);
assert.equal(nonExactHundred.summary.exactMatches, 0);

const genericIds = reconcileScheduleExcelRecords({
  excelRecords: [
    { recordId: "excel-generic-1", identityText: "GEN-01", comparisonText: "Fan coil" },
  ],
  scheduleRecords: [
    { recordId: "schedule-generic-1", identityText: "GEN-01", comparisonText: "Fan coil" },
  ],
});
assert.equal(genericIds.reviewRows[0].excelRow.recordId, "excel-generic-1");
assert.equal(genericIds.reviewRows[0].scheduleRow.recordId, "schedule-generic-1");
assert.equal(genericIds.evidenceRows[0].excelRowId, "excel-generic-1");
assert.equal(genericIds.evidenceRows[0].scheduleRowId, "schedule-generic-1");
assert.equal(genericIds.reviewTable.rows[0].excelRowId, "excel-generic-1");
assert.equal(genericIds.reviewTable.rows[0].scheduleRowId, "schedule-generic-1");

const fallbackIds = reconcileScheduleExcelRecords({
  excelRecords: [
    { identityText: "", comparisonText: "" },
    { identityText: "", comparisonText: "" },
  ],
  scheduleRecords: [],
});
assert.deepEqual(
  fallbackIds.reviewRows.map((row) => row.excelRow.recordId),
  ["excel:row:0", "excel:row:1"],
);

console.log("matching scoring tests passed");
