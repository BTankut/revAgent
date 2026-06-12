import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import ExcelJS from "exceljs";
import { parse as parseCsvSync } from "csv-parse/sync";
import { z } from "zod";
import { buildBroadScanFailureResult, buildBroadScanGuardedResult, normalizeBroadScanResult, } from "../utils/broadScanResult.js";
import { buildReconciliationTokenProfile, cleanReconciliationText, normalizeReconciliationAlias, normalizeReconciliationHeader, RECONCILIATION_ALL_ROLES, RECONCILIATION_REQUIRED_ROLES, RECONCILIATION_ROLE_ALIASES, } from "./reconcile_normalization.js";
const ACTION = "reconcile_schedule_excel";
const INGESTION_STAGE = "excel_ingestion";
const DEFAULT_BUDGETS = {
    maxWorkbookBytes: 25 * 1024 * 1024,
    maxSheets: 20,
    maxRows: 5000,
    maxColumns: 100,
    maxCells: 250000,
    maxElapsedMs: 5000,
};
const HARD_BUDGETS = {
    maxWorkbookBytes: 100 * 1024 * 1024,
    maxSheets: 200,
    maxRows: 50000,
    maxColumns: 300,
    maxCells: 1000000,
    maxElapsedMs: 119000,
};
const REQUIRED_ROLES = RECONCILIATION_REQUIRED_ROLES;
const ALL_ROLES = RECONCILIATION_ALL_ROLES;
const ROLE_ALIASES = RECONCILIATION_ROLE_ALIASES;
export const excelSelectionSchema = z.object({
    sheetName: z.string().min(1).optional(),
    sheetIndex: z.number().int().positive().optional(),
    range: z.string().min(1).optional(),
    headerRow: z.number().int().positive().optional(),
    dataStartRow: z.number().int().positive().optional(),
}).strict();
export const excelColumnMappingSchema = z.object({
    identity: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    comparisonText: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    code: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    description: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    quantity: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    unit: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    system: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    discipline: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    notes: z.union([z.string().min(1), z.number().int().positive()]).optional(),
}).strict();
export const excelIngestionBudgetsSchema = z.object({
    maxWorkbookBytes: z.number().int().positive().optional(),
    maxSheets: z.number().int().positive().optional(),
    maxRows: z.number().int().nonnegative().optional(),
    maxColumns: z.number().int().positive().optional(),
    maxCells: z.number().int().positive().optional(),
    maxElapsedMs: z.number().int().positive().optional(),
}).strict();
export const excelFileSourceSchema = z.object({
    kind: z.literal("file"),
    path: z.string().min(1),
    format: z.enum(["xlsx", "csv", "tsv", "xls"]).optional(),
    selection: excelSelectionSchema.optional(),
    columnMapping: excelColumnMappingSchema.optional(),
    budgets: excelIngestionBudgetsSchema.optional(),
}).strict();
export const excelRowsSourceSchema = z.object({
    kind: z.literal("rows"),
    sheetName: z.string().min(1).optional(),
    rows: z.array(z.record(z.unknown())),
    selection: z.object({
        headerRow: z.number().int().positive().optional(),
        dataStartRow: z.number().int().positive().optional(),
    }).strict().optional(),
    columnMapping: excelColumnMappingSchema.optional(),
    budgets: excelIngestionBudgetsSchema.optional(),
}).strict();
export const excelIngestionSourceSchema = z.discriminatedUnion("kind", [
    excelFileSourceSchema,
    excelRowsSourceSchema,
]);
function cleanText(value) {
    return cleanReconciliationText(value);
}
function normalizeHeader(value) {
    return normalizeReconciliationHeader(value);
}
function normalizeAlias(value) {
    return normalizeReconciliationAlias(value);
}
function resolveBudgets(input) {
    return {
        maxWorkbookBytes: clampBudget(input?.maxWorkbookBytes, DEFAULT_BUDGETS.maxWorkbookBytes, HARD_BUDGETS.maxWorkbookBytes),
        maxSheets: clampBudget(input?.maxSheets, DEFAULT_BUDGETS.maxSheets, HARD_BUDGETS.maxSheets),
        maxRows: clampBudget(input?.maxRows, DEFAULT_BUDGETS.maxRows, HARD_BUDGETS.maxRows),
        maxColumns: clampBudget(input?.maxColumns, DEFAULT_BUDGETS.maxColumns, HARD_BUDGETS.maxColumns),
        maxCells: clampBudget(input?.maxCells, DEFAULT_BUDGETS.maxCells, HARD_BUDGETS.maxCells),
        maxElapsedMs: clampBudget(input?.maxElapsedMs, DEFAULT_BUDGETS.maxElapsedMs, HARD_BUDGETS.maxElapsedMs),
    };
}
function clampBudget(value, fallback, hardMax) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(Math.floor(value), hardMax));
}
function inferFormat(filePath, explicitFormat) {
    const raw = (explicitFormat || path.extname(filePath).replace(/^\./, "")).trim().toLowerCase();
    if (raw === "xlsx" || raw === "csv" || raw === "tsv" || raw === "xls") {
        return raw;
    }
    return "unsupported";
}
function buildGuardedResult(reason, message, extra = {}) {
    const { warnings = [], notices = [], suggestedNextScopes = [], ...extraWithoutMessages } = extra;
    return buildBroadScanGuardedResult({
        action: ACTION,
        reason,
        message,
        extra: {
            stage: INGESTION_STAGE,
            ingestionContractVersion: 1,
            ...extraWithoutMessages,
        },
        summary: extra.summary || {},
        evidenceRows: [],
        scanPolicy: extra.scanPolicy || {},
        suggestedNextScopes,
        warnings,
        notices,
    });
}
function buildFailureResult(error, extra = {}) {
    const { warnings = [], notices = [], ...extraWithoutMessages } = extra;
    return buildBroadScanFailureResult({
        action: ACTION,
        error,
        extra: {
            stage: INGESTION_STAGE,
            ingestionContractVersion: 1,
            ...extraWithoutMessages,
        },
        summary: extra.summary || {},
        evidenceRows: [],
        scanPolicy: extra.scanPolicy || {},
        warnings,
        notices,
    });
}
function buildCompletedResult(options) {
    const warnings = options.table.warnings.concat(options.mappingWarnings);
    const notices = options.table.notices.concat(options.mappingNotices);
    const partial = options.table.partial;
    const scanStoppedReason = options.table.scanStoppedReason;
    const evidenceRows = options.records.map((record) => ({
        sourceType: "excelRecord",
        excelRowId: record.excelRowId,
        sheetName: record.sheetName,
        rowNumber: record.rowNumber,
        identityText: record.identityText,
        comparisonText: record.comparisonText,
        normalizedKey: record.normalizedKey,
    }));
    return normalizeBroadScanResult({
        success: true,
        guarded: false,
        state: "completed",
        action: ACTION,
        stage: INGESTION_STAGE,
        ingestionContractVersion: 1,
        sourceKind: options.sourceKind,
        format: options.format,
        sheetName: options.table.sheetName,
        excelRecords: options.records,
        partial,
        scanStoppedReason,
        elapsedMs: options.elapsedMs,
    }, {
        action: ACTION,
        partial,
        scanStoppedReason,
        elapsedMs: options.elapsedMs,
        scanPolicy: {
            budgets: options.budgets,
            sourceKind: options.sourceKind,
            format: options.format,
            sheetName: options.table.sheetName,
            sourceRange: options.table.sourceRange,
            headerRow: options.table.headerRow,
            dataStartRow: options.table.dataStartRow,
            columnMapping: roleMappingToLabels(options.mapping, options.table),
        },
        summary: {
            sourceKind: options.sourceKind,
            format: options.format,
            sheetName: options.table.sheetName,
            sourceRange: options.table.sourceRange,
            headerCount: options.table.headers.length,
            scannedRows: options.table.rows.length,
            scannedCells: options.table.scannedCells,
            excelRows: options.records.length,
            excelRecordCount: options.records.length,
            emptyExcelRows: options.table.rows.length - options.records.length,
            formulaCachedValueCount: options.table.formulaCachedValueCount,
            formulaWithoutCachedValueCount: options.table.formulaWithoutCachedValueCount,
            partial,
            scanStoppedReason,
        },
        evidenceRows,
        warnings,
        notices,
        lastRead: {
            lastReadRow: options.table.lastReadRow,
            lastReadColumn: options.table.lastReadColumn,
            lastReadItemId: options.records.length > 0 ? options.records[options.records.length - 1].excelRowId : null,
        },
    });
}
function roleMappingToLabels(mapping, table) {
    const labels = {};
    for (const role of ALL_ROLES) {
        const index = mapping[role];
        if (typeof index === "number") {
            labels[role] = table.headers[index] || columnNumberToLetters(table.startColumn + index);
        }
    }
    return labels;
}
function columnNumberToLetters(columnNumber) {
    let current = Math.max(1, Math.floor(columnNumber));
    let letters = "";
    while (current > 0) {
        const remainder = (current - 1) % 26;
        letters = String.fromCharCode(65 + remainder) + letters;
        current = Math.floor((current - 1) / 26);
    }
    return letters;
}
function columnLettersToNumber(value) {
    const letters = value.trim().toUpperCase();
    if (!/^[A-Z]+$/.test(letters)) {
        return null;
    }
    let result = 0;
    for (const letter of letters) {
        result = result * 26 + (letter.charCodeAt(0) - 64);
    }
    return result;
}
function parseRange(range, fallback) {
    if (!range) {
        return fallback;
    }
    const match = range.trim().toUpperCase().match(/^([A-Z]+)([0-9]+)(?::([A-Z]+)([0-9]+))?$/);
    if (!match) {
        return null;
    }
    const startColumn = columnLettersToNumber(match[1]);
    const startRow = Number(match[2]);
    const endColumn = match[3] ? columnLettersToNumber(match[3]) : startColumn;
    const endRow = match[4] ? Number(match[4]) : startRow;
    if (!startColumn || !endColumn || startRow < 1 || endRow < startRow || endColumn < startColumn) {
        return null;
    }
    return { startRow, startColumn, endRow, endColumn };
}
function formatRange(startRow, startColumn, endRow, endColumn) {
    return `${columnNumberToLetters(startColumn)}${startRow}:${columnNumberToLetters(endColumn)}${endRow}`;
}
function isEmptyCellText(text) {
    return cleanText(text).length === 0;
}
function isEmptyRow(cells) {
    return cells.every((cell) => isEmptyCellText(cell.text));
}
function makeHeaderKeys(cells, startColumn) {
    const seen = new Map();
    return cells.map((cell, index) => {
        const fallback = `Column ${columnNumberToLetters(startColumn + index)}`;
        const base = cleanText(cell.text) || fallback;
        const normalized = normalizeHeader(base) || normalizeHeader(fallback);
        const count = seen.get(normalized) || 0;
        seen.set(normalized, count + 1);
        return count === 0 ? base : `${base} ${count + 1}`;
    });
}
function cellValueToText(value) {
    if (value === null || value === undefined) {
        return "";
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    }
    if (typeof value === "object") {
        const objectValue = value;
        if (Array.isArray(objectValue.richText)) {
            return cleanText(objectValue.richText.map((part) => String(part.text ?? "")).join(""));
        }
        if (objectValue.text !== undefined) {
            return cleanText(objectValue.text);
        }
        if (objectValue.result !== undefined) {
            return cellValueToText(objectValue.result);
        }
        return "";
    }
    return cleanText(value);
}
function readExcelCell(cell, sheetName) {
    const value = cell.value;
    const isFormula = Boolean(value && typeof value === "object" && ("formula" in value || "sharedFormula" in value));
    if (isFormula) {
        if (Object.prototype.hasOwnProperty.call(value, "result") && value.result !== undefined && value.result !== null) {
            return {
                value: value.result,
                text: cellValueToText(value.result),
                address: `${sheetName}!${cell.address}`,
                formulaWithCachedValue: true,
            };
        }
        return {
            value: "",
            text: "",
            address: `${sheetName}!${cell.address}`,
            formulaWithoutCachedValue: true,
        };
    }
    return {
        value,
        text: cellValueToText(value),
        address: `${sheetName}!${cell.address}`,
    };
}
function readMatrixCell(value, rowNumber, columnNumber, sheetName) {
    return {
        value,
        text: cellValueToText(value),
        address: `${sheetName}!${columnNumberToLetters(columnNumber)}${rowNumber}`,
    };
}
function elapsedExceeded(startedAt, budgets) {
    return performance.now() - startedAt > budgets.maxElapsedMs;
}
function resolveColumnMapping(headers, startColumn, explicitMapping) {
    const warnings = [];
    const notices = [];
    const mapping = {};
    const assignedIndices = new Set();
    const explicitlyMappedRoles = new Set();
    for (const role of ALL_ROLES) {
        const explicit = explicitMapping?.[role];
        if (explicit !== undefined) {
            const resolved = resolveColumnRef(explicit, headers, startColumn);
            if (resolved === null) {
                return { error: { role, reason: "unresolved_column_ref", value: explicit } };
            }
            mapping[role] = resolved;
            assignedIndices.add(resolved);
            explicitlyMappedRoles.add(role);
        }
    }
    for (const role of ALL_ROLES) {
        if (mapping[role] !== undefined) {
            continue;
        }
        const matches = findAllColumnAliases(role, headers);
        if (matches.length === 0) {
            continue;
        }
        const selected = selectAliasMatch(matches, assignedIndices);
        if (selected.kind === "ambiguous") {
            return { error: { role, reason: "ambiguous_alias", candidates: selected.candidates } };
        }
        if (selected.kind === "resolved") {
            mapping[role] = selected.match.index;
            assignedIndices.add(selected.match.index);
        }
    }
    for (const role of REQUIRED_ROLES) {
        if (mapping[role] === undefined) {
            return { error: { role, reason: "missing_required_role" } };
        }
    }
    const inferredRequiredRoles = REQUIRED_ROLES.filter((role) => !explicitlyMappedRoles.has(role));
    if (inferredRequiredRoles.length > 0) {
        const inferredLabels = inferredRequiredRoles
            .map((role) => `${role}=${headers[mapping[role]] || columnNumberToLetters(startColumn + mapping[role])}`)
            .join(", ");
        notices.push(`column_mapping_inferred_from_headers: ${inferredLabels}. Review or pass explicit columnMapping when first-pass reconciliation looks surprising.`);
    }
    return { mapping, warnings, notices };
}
function buildColumnMappingSuggestion(headers, startColumn) {
    const candidates = {};
    const example = {};
    const assignedIndices = new Set();
    for (const role of REQUIRED_ROLES) {
        const matches = findAllColumnAliases(role, headers)
            .filter((match) => !assignedIndices.has(match.index))
            .sort((left, right) => left.priority - right.priority || left.index - right.index);
        candidates[role] = matches.map((match) => ({
            header: match.header,
            column: columnNumberToLetters(startColumn + match.index),
            priority: match.priority,
        }));
        if (matches.length > 0) {
            example[role] = matches[0].header;
            assignedIndices.add(matches[0].index);
        }
    }
    return {
        requiredRoles: REQUIRED_ROLES,
        candidates,
        suggestedColumnMapping: example,
    };
}
function getAliasPriority(role, header) {
    const normalized = normalizeAlias(header);
    const aliases = ROLE_ALIASES[role];
    for (let index = 0; index < aliases.length; index++) {
        if (normalizeAlias(aliases[index]) === normalized) {
            return index;
        }
    }
    return Number.POSITIVE_INFINITY;
}
function findAllColumnAliases(role, headers) {
    return headers
        .map((header, index) => ({ header, index, priority: getAliasPriority(role, header) }))
        .filter((match) => Number.isFinite(match.priority));
}
function selectAliasMatch(matches, assignedIndices) {
    const unassignedMatches = matches.filter((match) => !assignedIndices.has(match.index));
    const candidates = unassignedMatches.length > 0 ? unassignedMatches : matches;
    const bestPriority = Math.min(...candidates.map((match) => match.priority));
    const bestCandidates = candidates.filter((match) => match.priority === bestPriority);
    if (bestCandidates.length === 1) {
        return { kind: "resolved", match: bestCandidates[0] };
    }
    return { kind: "ambiguous", candidates: bestCandidates.map((match) => match.header) };
}
function resolveColumnRef(ref, headers, startColumn) {
    if (typeof ref === "number") {
        const index = ref - 1;
        return index >= 0 && index < headers.length ? index : null;
    }
    const trimmed = ref.trim();
    const normalized = normalizeHeader(trimmed);
    const matches = headers
        .map((header, index) => ({ header, index }))
        .filter((item) => normalizeHeader(item.header) === normalized);
    if (matches.length === 1) {
        return matches[0].index;
    }
    const columnNumber = columnLettersToNumber(trimmed);
    if (columnNumber !== null) {
        const index = columnNumber - startColumn;
        return index >= 0 && index < headers.length ? index : null;
    }
    return null;
}
function buildRecords(table, mapping) {
    const records = [];
    for (const row of table.rows) {
        if (isEmptyRow(row.cells)) {
            continue;
        }
        const rawValues = {};
        for (const [indexText, header] of table.headers.entries()) {
            rawValues[header] = row.cells[indexText]?.text ?? "";
        }
        const mappedValues = {};
        for (const role of ALL_ROLES) {
            const index = mapping[role];
            if (typeof index === "number") {
                mappedValues[role] = row.cells[index]?.text ?? "";
            }
        }
        const identityText = cleanText(mappedValues.identity);
        const comparisonText = cleanText(mappedValues.comparisonText);
        const tokenProfile = buildReconciliationTokenProfile([identityText, comparisonText]);
        const normalizedKey = tokenProfile.normalizedKey;
        const excelRowId = `${table.sheetName}!${row.rowNumber}`;
        records.push({
            excelRowId,
            sheetName: table.sheetName,
            rowNumber: row.rowNumber,
            sourceRange: table.sourceRange,
            rawValues,
            mappedValues,
            identityText,
            comparisonText,
            normalizedKey,
            tokenProfile,
        });
    }
    return records;
}
async function loadXlsxTable(source, budgets, startedAt) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(source.path);
    const sheets = workbook.worksheets;
    const selection = source.selection || {};
    const exactSheetSelected = Boolean(selection.sheetName || selection.sheetIndex);
    const nonEmptySheets = sheets.filter((sheet) => sheet.actualRowCount > 0 || sheet.actualColumnCount > 0);
    if (!exactSheetSelected && sheets.length > budgets.maxSheets && nonEmptySheets.length !== 1) {
        return buildGuardedResult("max_items", "Workbook sheet count exceeds maxSheets and cannot be auto-scoped to one non-empty sheet. Provide sheetName or sheetIndex.", {
            partial: true,
            scanStoppedReason: "max_items",
            summary: { workbookSheets: sheets.length, nonEmptySheets: nonEmptySheets.length, maxSheets: budgets.maxSheets },
            scanPolicy: { budgets },
            suggestedNextScopes: ["excel.selection.sheetName", "excel.selection.sheetIndex", "excel.budgets.maxSheets"],
        });
    }
    const selectedSheet = selectWorksheet(workbook, selection, nonEmptySheets);
    if (!selectedSheet) {
        return buildGuardedResult("excel_sheet_selection_required", "Select a worksheet with sheetName or 1-based sheetIndex.", {
            summary: { workbookSheets: sheets.length, sheetNames: sheets.map((sheet) => sheet.name) },
            scanPolicy: { budgets, selection },
            suggestedNextScopes: ["excel.selection.sheetName", "excel.selection.sheetIndex"],
        });
    }
    const table = readWorksheetTable(selectedSheet, selection, budgets, startedAt);
    if (!exactSheetSelected && nonEmptySheets.length === 1) {
        table.notices.push("Selected the only non-empty worksheet.");
    }
    return table;
}
function selectWorksheet(workbook, selection, nonEmptySheets) {
    if (selection.sheetName) {
        return workbook.getWorksheet(selection.sheetName) || null;
    }
    if (selection.sheetIndex) {
        return workbook.worksheets[selection.sheetIndex - 1] || null;
    }
    return nonEmptySheets.length === 1 ? nonEmptySheets[0] : null;
}
function readWorksheetTable(worksheet, selection, budgets, startedAt) {
    const bounds = findWorksheetBounds(worksheet);
    return readTabularCells({
        sheetName: worksheet.name,
        fallbackRange: bounds,
        selection,
        budgets,
        startedAt,
        readCell: (rowNumber, columnNumber) => readExcelCell(worksheet.getCell(rowNumber, columnNumber), worksheet.name),
    });
}
function findWorksheetBounds(worksheet) {
    let minRow = Number.POSITIVE_INFINITY;
    let minColumn = Number.POSITIVE_INFINITY;
    let maxRow = 1;
    let maxColumn = 1;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (_cell, columnNumber) => {
            minRow = Math.min(minRow, rowNumber);
            minColumn = Math.min(minColumn, columnNumber);
            maxRow = Math.max(maxRow, rowNumber);
            maxColumn = Math.max(maxColumn, columnNumber);
        });
    });
    if (!Number.isFinite(minRow) || !Number.isFinite(minColumn)) {
        return { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 };
    }
    return { startRow: minRow, startColumn: minColumn, endRow: maxRow, endColumn: maxColumn };
}
async function loadDelimitedTable(source, budgets, startedAt, format) {
    const text = await fs.readFile(source.path, "utf8");
    const limit = delimitedRecordLimit(source.selection || {}, budgets);
    const rows = parseCsvSync(text, {
        bom: true,
        delimiter: format === "tsv" ? "\t" : ",",
        relax_column_count: true,
        skip_empty_lines: false,
        to: limit.recordLimit + 1,
    });
    const prelimited = rows.length > limit.recordLimit
        ? { partial: true, scanStoppedReason: limit.scanStoppedReason }
        : undefined;
    const limitedRows = prelimited ? rows.slice(0, limit.recordLimit) : rows;
    const sheetName = source.selection?.sheetName || (format === "tsv" ? "TSV" : "CSV");
    return readMatrixTable(limitedRows, sheetName, source.selection || {}, budgets, startedAt, prelimited);
}
function delimitedRecordLimit(selection, budgets) {
    const parsedRange = parseRange(selection.range, { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 });
    const rangeStartRow = parsedRange?.startRow || 1;
    const headerRow = selection.headerRow || rangeStartRow;
    const dataStartRow = selection.dataStartRow || headerRow + 1;
    return {
        recordLimit: Math.max(rangeStartRow, headerRow, dataStartRow + budgets.maxRows - 1),
        scanStoppedReason: "max_rows",
    };
}
function loadRowsTable(source, budgets, startedAt) {
    const sheetName = source.sheetName || "Rows";
    const keys = collectRowKeys(source.rows);
    const headerRow = source.selection?.headerRow || 1;
    const dataStartRow = source.selection?.dataStartRow || headerRow + 1;
    const matrix = [];
    while (matrix.length < headerRow - 1) {
        matrix.push([]);
    }
    matrix.push(keys);
    while (matrix.length < dataStartRow - 1) {
        matrix.push([]);
    }
    for (const row of source.rows) {
        matrix.push(keys.map((key) => row[key]));
    }
    return readMatrixTable(matrix, sheetName, { headerRow, dataStartRow }, budgets, startedAt);
}
function collectRowKeys(rows) {
    const keys = [];
    const seen = new Set();
    for (const row of rows) {
        for (const key of Object.keys(row)) {
            if (!seen.has(key)) {
                seen.add(key);
                keys.push(key);
            }
        }
    }
    return keys;
}
function readMatrixTable(matrix, sheetName, selection, budgets, startedAt, prelimited) {
    const maxColumns = matrix.reduce((max, row) => Math.max(max, row.length), 1);
    const fallbackRange = {
        startRow: 1,
        startColumn: 1,
        endRow: Math.max(matrix.length, 1),
        endColumn: Math.max(maxColumns, 1),
    };
    return readTabularCells({
        sheetName,
        fallbackRange,
        selection,
        budgets,
        startedAt,
        prelimited,
        readCell: (rowNumber, columnNumber) => readMatrixCell(matrix[rowNumber - 1]?.[columnNumber - 1], rowNumber, columnNumber, sheetName),
    });
}
function readTabularCells(options) {
    const parsedRange = parseRange(options.selection.range, options.fallbackRange);
    if (!parsedRange) {
        throw new Error(`Invalid range selection: ${options.selection.range}`);
    }
    const headerRow = options.selection.headerRow || parsedRange.startRow;
    const dataStartRow = options.selection.dataStartRow || headerRow + 1;
    if (dataStartRow <= headerRow) {
        throw new Error("dataStartRow must be greater than headerRow.");
    }
    let endColumn = parsedRange.endColumn;
    let partial = options.prelimited?.partial || false;
    let scanStoppedReason = options.prelimited?.scanStoppedReason || "completed";
    if (endColumn - parsedRange.startColumn + 1 > options.budgets.maxColumns) {
        endColumn = parsedRange.startColumn + options.budgets.maxColumns - 1;
        partial = true;
        scanStoppedReason = "max_columns";
    }
    const headerCells = [];
    let scannedCells = 0;
    let formulaCachedValueCount = 0;
    let formulaWithoutCachedValueCount = 0;
    const warnings = [];
    const notices = [];
    for (let column = parsedRange.startColumn; column <= endColumn; column++) {
        const cell = options.readCell(headerRow, column);
        headerCells.push(cell);
        scannedCells++;
        if (cell.formulaWithCachedValue)
            formulaCachedValueCount++;
        if (cell.formulaWithoutCachedValue) {
            formulaWithoutCachedValueCount++;
            warnings.push(`Formula cell ${cell.address || `${options.sheetName}!${columnNumberToLetters(column)}${headerRow}`} has no cached value and was read as blank.`);
        }
    }
    const headers = makeHeaderKeys(headerCells, parsedRange.startColumn);
    const rows = [];
    let lastReadRow = null;
    let lastReadColumn = null;
    const firstDataRow = Math.max(dataStartRow, parsedRange.startRow);
    for (let rowNumber = firstDataRow; rowNumber <= parsedRange.endRow; rowNumber++) {
        if (rows.length >= options.budgets.maxRows) {
            partial = true;
            scanStoppedReason = scanStoppedReason === "completed" ? "max_rows" : scanStoppedReason;
            break;
        }
        if (elapsedExceeded(options.startedAt, options.budgets)) {
            partial = true;
            scanStoppedReason = "max_elapsed";
            break;
        }
        if (scannedCells + headers.length > options.budgets.maxCells) {
            partial = true;
            scanStoppedReason = scanStoppedReason === "completed" ? "max_cells" : scanStoppedReason;
            break;
        }
        const cells = [];
        for (let column = parsedRange.startColumn; column <= endColumn; column++) {
            const cell = options.readCell(rowNumber, column);
            cells.push(cell);
            scannedCells++;
            lastReadRow = rowNumber;
            lastReadColumn = column;
            if (cell.formulaWithCachedValue)
                formulaCachedValueCount++;
            if (cell.formulaWithoutCachedValue) {
                formulaWithoutCachedValueCount++;
                warnings.push(`Formula cell ${cell.address || `${options.sheetName}!${columnNumberToLetters(column)}${rowNumber}`} has no cached value and was read as blank.`);
            }
        }
        rows.push({ rowNumber, cells });
    }
    return {
        sheetName: options.sheetName,
        sourceRange: formatRange(parsedRange.startRow, parsedRange.startColumn, parsedRange.endRow, endColumn),
        headerRow,
        dataStartRow,
        startColumn: parsedRange.startColumn,
        headers,
        rows,
        notices,
        warnings,
        formulaCachedValueCount,
        formulaWithoutCachedValueCount,
        scannedCells,
        partial,
        scanStoppedReason,
        lastReadRow,
        lastReadColumn,
    };
}
function isResultEnvelope(value) {
    return Boolean(value && typeof value === "object" && value.action === ACTION && value.stage === INGESTION_STAGE);
}
export async function ingestExcelSource(rawInput) {
    const startedAt = performance.now();
    const parsed = excelIngestionSourceSchema.safeParse(rawInput);
    if (!parsed.success) {
        return buildGuardedResult("needs_scope", "Excel ingestion input failed schema validation.", {
            validationIssues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
            suggestedNextScopes: ["excel.kind", "excel.rows", "excel.path", "excel.selection", "excel.columnMapping.identity", "excel.columnMapping.comparisonText"],
        });
    }
    const source = parsed.data;
    const budgets = resolveBudgets(source.budgets);
    try {
        const tableResult = await loadTableForSource(source, budgets, startedAt);
        if (isResultEnvelope(tableResult)) {
            return tableResult;
        }
        const table = tableResult;
        const resolvedMapping = resolveColumnMapping(table.headers, table.startColumn, source.columnMapping);
        if ("error" in resolvedMapping) {
            return buildGuardedResult("excel_column_mapping_required", "Resolve identity and comparisonText column mapping before ingestion.", {
                mappingError: resolvedMapping.error,
                mappingSuggestion: buildColumnMappingSuggestion(table.headers, table.startColumn),
                summary: {
                    sheetName: table.sheetName,
                    headers: table.headers,
                },
                scanPolicy: { budgets },
                suggestedNextScopes: ["excel.columnMapping.identity", "excel.columnMapping.comparisonText"],
                warnings: table.warnings,
                notices: table.notices,
            });
        }
        const records = buildRecords(table, resolvedMapping.mapping);
        return buildCompletedResult({
            sourceKind: source.kind,
            format: source.kind === "file" ? inferFormat(source.path, source.format) : "rows",
            table,
            records,
            budgets,
            mapping: resolvedMapping.mapping,
            mappingNotices: resolvedMapping.notices,
            mappingWarnings: resolvedMapping.warnings,
            elapsedMs: performance.now() - startedAt,
        });
    }
    catch (error) {
        return buildFailureResult(error instanceof Error ? error.message : String(error), {
            scanPolicy: { budgets },
        });
    }
}
async function loadTableForSource(source, budgets, startedAt) {
    if (source.kind === "rows") {
        return loadRowsTable(source, budgets, startedAt);
    }
    const format = inferFormat(source.path, source.format);
    if (format === "xls") {
        return buildGuardedResult("unsupported_excel_format", ".xls is not supported. Save the workbook as .xlsx, .csv, or .tsv.", {
            format,
            scanPolicy: { budgets },
            suggestedNextScopes: ["excel.path", "excel.format"],
        });
    }
    if (format === "unsupported") {
        return buildGuardedResult("unsupported_excel_format", "Unsupported spreadsheet format. Use .xlsx, .csv, or .tsv.", {
            format,
            scanPolicy: { budgets },
            suggestedNextScopes: ["excel.path", "excel.format"],
        });
    }
    const stat = await fs.stat(source.path);
    if (stat.size > budgets.maxWorkbookBytes) {
        return buildGuardedResult("max_bytes", "Workbook exceeds maxWorkbookBytes.", {
            format,
            partial: true,
            scanStoppedReason: "max_bytes",
            summary: { workbookBytes: stat.size, maxWorkbookBytes: budgets.maxWorkbookBytes },
            scanPolicy: { budgets },
            suggestedNextScopes: ["excel.budgets.maxWorkbookBytes", "excel.selection.sheetName", "excel.selection.range"],
        });
    }
    if (format === "xlsx") {
        return loadXlsxTable(source, budgets, startedAt);
    }
    return loadDelimitedTable(source, budgets, startedAt, format);
}
