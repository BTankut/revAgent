import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as XLSX from "@e965/xlsx";
import { strToU8, zipSync } from "fflate";
import { ingestExcelSource } from "../build/tools/reconcile_excel_ingestion.js";

XLSX.set_fs(nodeFs);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "revagent-excel-ingest-"));

async function writeWorkbook(filePath, sheets) {
  const workbook = XLSX.utils.book_new();
  for (const sheetSpec of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet(sheetSpec.rows);
    if (sheetSpec.configure) {
      sheetSpec.configure(sheet);
    }
    XLSX.utils.book_append_sheet(workbook, sheet, sheetSpec.name);
  }
  XLSX.writeFile(workbook, filePath, { bookType: "xlsx" });
}

async function writeFormulaWorkbook(filePath) {
  const files = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C6"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Identity</t></is></c><c r="B1" t="inlineStr"><is><t>Description</t></is></c><c r="C1" t="inlineStr"><is><t>Qty</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>FCU-01</t></is></c><c r="B2" t="inlineStr"><is><t>Fan coil</t></is></c><c r="C2"><v>1</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>FCU-02</t></is></c><c r="B3" t="str"><f>CONCAT(&quot;Cached&quot;, &quot; value&quot;)</f><v>Cached value</v></c><c r="C3"><v>2</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>FCU-03</t></is></c><c r="B5" t="str"><f>CONCAT(&quot;No&quot;, &quot; cache&quot;)</f></c><c r="C5"><v>3</v></c></row><row r="6"><c r="A6" t="inlineStr"><is><t>FCU-04</t></is></c><c r="B6" t="inlineStr"><is><t>Fan coil</t></is></c><c r="C6"><v>4</v></c></row></sheetData></worksheet>'),
  };
  await fs.writeFile(filePath, zipSync(files));
}

async function writeStaleDimensionWorkbook(filePath) {
  const files = {
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Identity</t></is></c><c r="B1" t="inlineStr"><is><t>Description</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>STALE-1</t></is></c><c r="B2" t="inlineStr"><is><t>Present below stale dimension</t></is></c></row></sheetData></worksheet>'),
  };
  await fs.writeFile(filePath, zipSync(files));
}

const workbookPath = path.join(tempRoot, "single-sheet.xlsx");
await writeFormulaWorkbook(workbookPath);

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
assert.equal(xlsxResult.excelRecords.length, 4);
assert.equal(xlsxResult.excelRecords[0].excelRowId, "Items!2");
assert.equal(xlsxResult.excelRecords[1].comparisonText, "Cached value");
assert.equal(xlsxResult.excelRecords[2].comparisonText, "");
assert.equal(xlsxResult.excelRecords[3].comparisonText, "Fan coil");
assert.equal(xlsxResult.summary.emptyExcelRows, 1);
assert.equal(xlsxResult.summary.formulaCachedValueCount, 1);
assert.equal(xlsxResult.summary.formulaWithoutCachedValueCount, 1);
assert.match(xlsxResult.warnings.join("\n"), /Items!B5/);

const staleDimensionPath = path.join(tempRoot, "stale-dimension.xlsx");
await writeStaleDimensionWorkbook(staleDimensionPath);
const staleDimensionResult = await ingestExcelSource({
  kind: "file",
  path: staleDimensionPath,
  format: "xlsx",
  selection: { sheetName: "Items" },
  columnMapping: { identity: "Identity", comparisonText: "Description" },
});
assert.equal(staleDimensionResult.success, true);
assert.equal(staleDimensionResult.excelRecords.length, 1);
assert.equal(staleDimensionResult.excelRecords[0].excelRowId, "Items!2");
assert.equal(staleDimensionResult.excelRecords[0].comparisonText, "Present below stale dimension");

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

const manyBlankSheetsPath = path.join(tempRoot, "many-blank-sheets.xlsx");
const manyBlankWorkbook = XLSX.utils.book_new();
for (let index = 1; index <= 6; index++) {
  XLSX.utils.book_append_sheet(manyBlankWorkbook, XLSX.utils.aoa_to_sheet([]), `Blank ${index}`);
}
const populated = XLSX.utils.aoa_to_sheet([
  ["Identity", "Description"],
  ["ONLY-1", "Only populated sheet"],
]);
XLSX.utils.book_append_sheet(manyBlankWorkbook, populated, "Only Data");
XLSX.writeFile(manyBlankWorkbook, manyBlankSheetsPath, { bookType: "xlsx" });
const manyBlankResult = await ingestExcelSource({
  kind: "file",
  path: manyBlankSheetsPath,
  format: "xlsx",
  columnMapping: { identity: "Identity", comparisonText: "Description" },
  budgets: { maxSheets: 2 },
});
assert.equal(manyBlankResult.success, true);
assert.equal(manyBlankResult.guarded, false);
assert.equal(manyBlankResult.excelRecords[0].excelRowId, "Only Data!2");
assert.match(manyBlankResult.notices.join("\n"), /only non-empty worksheet/);

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

const largeCsvPath = path.join(tempRoot, "large.csv");
await fs.writeFile(
  largeCsvPath,
  ["Identity,Description"].concat(Array.from({ length: 20 }, (_, index) => `R-${index + 1},Row ${index + 1}`)).join("\n"),
  "utf8",
);
const csvBudgetResult = await ingestExcelSource({
  kind: "file",
  path: largeCsvPath,
  format: "csv",
  columnMapping: { identity: "Identity", comparisonText: "Description" },
  budgets: { maxRows: 2 },
});
assert.equal(csvBudgetResult.success, true);
assert.equal(csvBudgetResult.partial, true);
assert.equal(csvBudgetResult.scanStoppedReason, "max_rows");
assert.equal(csvBudgetResult.excelRecords.length, 2);

const rangeClampPath = path.join(tempRoot, "range-clamp.csv");
await fs.writeFile(rangeClampPath, "Identity,Description\nOUT,Outside\nIN-1,Inside 1\nIN-2,Inside 2\n", "utf8");
const rangeClampResult = await ingestExcelSource({
  kind: "file",
  path: rangeClampPath,
  format: "csv",
  selection: { range: "A3:B4", headerRow: 1, dataStartRow: 2 },
  columnMapping: { identity: "Identity", comparisonText: "Description" },
});
assert.equal(rangeClampResult.success, true);
assert.equal(rangeClampResult.excelRecords.length, 2);
assert.equal(rangeClampResult.excelRecords[0].identityText, "IN-1");

const rangeStartLimitPath = path.join(tempRoot, "range-start-limit.csv");
await fs.writeFile(
  rangeStartLimitPath,
  Array.from({ length: 9 }, (_, index) => `SKIP-${index + 1},Skip ${index + 1}`)
    .concat(["Identity,Description", "RANGE-1,Inside range 1", "RANGE-2,Inside range 2", "RANGE-3,Outside budget"])
    .join("\n"),
  "utf8",
);
const rangeStartLimitResult = await ingestExcelSource({
  kind: "file",
  path: rangeStartLimitPath,
  format: "csv",
  selection: { range: "A10:B13" },
  columnMapping: { identity: "Identity", comparisonText: "Description" },
  budgets: { maxRows: 2 },
});
assert.equal(rangeStartLimitResult.success, true);
assert.equal(rangeStartLimitResult.guarded, false);
assert.equal(rangeStartLimitResult.partial, true);
assert.equal(rangeStartLimitResult.scanStoppedReason, "max_rows");
assert.equal(rangeStartLimitResult.excelRecords.length, 2);
assert.equal(rangeStartLimitResult.excelRecords[0].identityText, "RANGE-1");

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
assert.equal(Array.isArray(mappingGuard.mappingSuggestion.requiredRoles), true);
assert.equal(Array.isArray(mappingGuard.mappingSuggestion.candidates.identity), true);
assert.equal(typeof mappingGuard.mappingSuggestion.suggestedColumnMapping, "object");

const disambiguationResult = await ingestExcelSource({
  kind: "rows",
  sheetName: "Rows",
  rows: [{ Name: "FCU-01", Description: "Fan coil unit" }],
});
assert.equal(disambiguationResult.success, true);
assert.equal(disambiguationResult.guarded, false);
assert.equal(disambiguationResult.excelRecords.length, 1);
assert.equal(disambiguationResult.excelRecords[0].identityText, "FCU-01");
assert.equal(disambiguationResult.excelRecords[0].comparisonText, "Fan coil unit");
assert.match(disambiguationResult.notices.join("\n"), /column_mapping_inferred_from_headers/);

const aliasPriorityResult = await ingestExcelSource({
  kind: "rows",
  sheetName: "Rows",
  rows: [{ Id: "ID-01", Name: "Fan coil name", Description: "Fan coil description" }],
});
assert.equal(aliasPriorityResult.success, true);
assert.equal(aliasPriorityResult.guarded, false);
assert.equal(aliasPriorityResult.excelRecords[0].identityText, "ID-01");
assert.equal(aliasPriorityResult.excelRecords[0].comparisonText, "Fan coil description");

const turkishHeader = "A\u00e7\u0131klama";
const turkishAliasResult = await ingestExcelSource({
  kind: "rows",
  sheetName: "Rows",
  rows: [{ Identity: "TR-01", [turkishHeader]: "Turkish description" }],
});
assert.equal(turkishAliasResult.success, true);
assert.equal(turkishAliasResult.guarded, false);
assert.equal(turkishAliasResult.excelRecords[0].comparisonText, "Turkish description");

const invalidDateResult = await ingestExcelSource({
  kind: "rows",
  sheetName: "Rows",
  rows: [{ Identity: "D-01", Description: new Date("not-a-date") }],
  columnMapping: { identity: "Identity", comparisonText: "Description" },
});
assert.equal(invalidDateResult.success, true);
assert.equal(invalidDateResult.guarded, false);
assert.equal(invalidDateResult.excelRecords[0].comparisonText, "");

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
