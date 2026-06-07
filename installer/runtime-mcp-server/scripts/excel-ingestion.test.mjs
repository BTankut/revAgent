import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { ingestExcelSource } from "../build/tools/reconcile_excel_ingestion.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "revagent-excel-ingest-"));

async function writeWorkbook(filePath, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const sheetSpec of sheets) {
    const sheet = workbook.addWorksheet(sheetSpec.name);
    for (const row of sheetSpec.rows) {
      sheet.addRow(row);
    }
    if (sheetSpec.configure) {
      sheetSpec.configure(sheet);
    }
  }
  await workbook.xlsx.writeFile(filePath);
}

const workbookPath = path.join(tempRoot, "single-sheet.xlsx");
await writeWorkbook(workbookPath, [{
  name: "Items",
  rows: [
    ["Identity", "Description", "Qty"],
    ["FCU-01", "Fan coil", 1],
    ["FCU-02", "", 2],
    ["", "", ""],
    ["FCU-03", "Terminal unit", 3],
  ],
  configure(sheet) {
    sheet.getCell("B3").value = { formula: "CONCAT(\"Cached\", \" value\")", result: "Cached value" };
    sheet.getCell("B5").value = { formula: "CONCAT(\"No\", \" cache\")" };
  },
}]);

const xlsxResult = await ingestExcelSource({
  kind: "file",
  path: workbookPath,
  format: "xlsx",
  selection: { sheetName: "Items", headerRow: 1 },
  columnMapping: { identity: "Identity", comparisonText: "Description", quantity: "Qty" },
});

assert.equal(xlsxResult.success, true);
assert.equal(xlsxResult.guarded, false);
assert.equal(xlsxResult.partial, false);
assert.equal(xlsxResult.scanStoppedReason, "completed");
assert.equal(xlsxResult.excelRecords.length, 3);
assert.equal(xlsxResult.excelRecords[0].excelRowId, "Items!2");
assert.equal(xlsxResult.excelRecords[1].comparisonText, "Cached value");
assert.equal(xlsxResult.excelRecords[2].comparisonText, "");
assert.equal(xlsxResult.summary.emptyExcelRows, 1);
assert.equal(xlsxResult.summary.formulaCachedValueCount, 1);
assert.equal(xlsxResult.summary.formulaWithoutCachedValueCount, 1);
assert.match(xlsxResult.warnings.join("\n"), /Items!B5/);

const autoSheetResult = await ingestExcelSource({
  kind: "file",
  path: workbookPath,
  format: "xlsx",
  columnMapping: { identity: "Identity", comparisonText: "Description" },
});
assert.equal(autoSheetResult.success, true);
assert.equal(autoSheetResult.guarded, false);
assert.match(autoSheetResult.notices.join("\n"), /only non-empty worksheet/);

const multiSheetPath = path.join(tempRoot, "multi-sheet.xlsx");
await writeWorkbook(multiSheetPath, [
  { name: "A", rows: [["Identity", "Description"], ["A1", "Alpha"]] },
  { name: "B", rows: [["Identity", "Description"], ["B1", "Beta"]] },
]);

const multiSheetResult = await ingestExcelSource({
  kind: "file",
  path: multiSheetPath,
  format: "xlsx",
  columnMapping: { identity: "Identity", comparisonText: "Description" },
});

assert.equal(multiSheetResult.success, true);
assert.equal(multiSheetResult.guarded, true);
assert.equal(multiSheetResult.reason, "excel_sheet_selection_required");
assert.equal(multiSheetResult.scanStoppedReason, "needs_scope");

const csvPath = path.join(tempRoot, "quoted.csv");
await fs.writeFile(csvPath, "Identity,Description\n\"FCU, 1\",\"Desc \"\"Quoted\"\"\"\n", "utf8");
const csvResult = await ingestExcelSource({
  kind: "file",
  path: csvPath,
  format: "csv",
  columnMapping: { identity: "Identity", comparisonText: "Description" },
});
assert.equal(csvResult.success, true);
assert.equal(csvResult.excelRecords.length, 1);
assert.equal(csvResult.excelRecords[0].identityText, "FCU, 1");
assert.equal(csvResult.excelRecords[0].comparisonText, "Desc \"Quoted\"");

const tsvPath = path.join(tempRoot, "quoted.tsv");
await fs.writeFile(tsvPath, "Identity\tDescription\nT-01\t\"Tab quoted\"\n", "utf8");
const tsvResult = await ingestExcelSource({
  kind: "file",
  path: tsvPath,
  format: "tsv",
  columnMapping: { identity: "Identity", comparisonText: "Description" },
});
assert.equal(tsvResult.success, true);
assert.equal(tsvResult.excelRecords[0].comparisonText, "Tab quoted");

const xlsResult = await ingestExcelSource({
  kind: "file",
  path: path.join(tempRoot, "legacy.xls"),
  format: "xls",
  columnMapping: { identity: "Identity", comparisonText: "Description" },
});
assert.equal(xlsResult.success, true);
assert.equal(xlsResult.guarded, true);
assert.equal(xlsResult.reason, "unsupported_excel_format");
assert.equal(xlsResult.scanStoppedReason, "needs_scope");

const mappingGuard = await ingestExcelSource({
  kind: "rows",
  sheetName: "Rows",
  rows: [{ Unknown: "A", Other: "B" }],
});
assert.equal(mappingGuard.success, true);
assert.equal(mappingGuard.guarded, true);
assert.equal(mappingGuard.reason, "excel_column_mapping_required");

const rowsBudget = await ingestExcelSource({
  kind: "rows",
  sheetName: "Rows",
  rows: [
    { Identity: "A", Description: "Alpha" },
    { Identity: "B", Description: "Beta" },
  ],
  columnMapping: { identity: "Identity", comparisonText: "Description" },
  budgets: { maxRows: 1 },
});
assert.equal(rowsBudget.success, true);
assert.equal(rowsBudget.guarded, false);
assert.equal(rowsBudget.partial, true);
assert.equal(rowsBudget.scanStoppedReason, "max_rows");
assert.equal(rowsBudget.excelRecords.length, 1);

const maxBytesResult = await ingestExcelSource({
  kind: "file",
  path: workbookPath,
  format: "xlsx",
  columnMapping: { identity: "Identity", comparisonText: "Description" },
  budgets: { maxWorkbookBytes: 1 },
});
assert.equal(maxBytesResult.success, true);
assert.equal(maxBytesResult.guarded, true);
assert.equal(maxBytesResult.reason, "max_bytes");
assert.equal(maxBytesResult.scanStoppedReason, "max_bytes");

await fs.rm(tempRoot, { recursive: true, force: true });
console.log("excel ingestion tests passed");
