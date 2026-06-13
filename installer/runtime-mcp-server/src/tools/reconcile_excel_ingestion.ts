import * as nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as XLSX from "@e965/xlsx";
import { parse as parseCsvSync } from "csv-parse/sync";
import { z } from "zod";
import {
    buildBroadScanFailureResult,
    buildBroadScanGuardedResult,
    normalizeBroadScanResult,
    type BroadScanStopReason,
} from "../utils/broadScanResult.js";
import {
    buildReconciliationTokenProfile,
    cleanReconciliationText,
    normalizeReconciliationAlias,
    normalizeReconciliationHeader,
    RECONCILIATION_ALL_ROLES,
    RECONCILIATION_REQUIRED_ROLES,
    RECONCILIATION_ROLE_ALIASES,
    type ReconciliationColumnRole,
} from "./reconcile_normalization.js";

type JsonObject = Record<string, any>;
type ColumnRole = ReconciliationColumnRole;
type ColumnRef = string | number;
type XlsxSheetRef = {
    name: string;
    worksheet: XLSX.WorkSheet;
};

XLSX.set_fs(nodeFs);

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

export type ExcelIngestionSource = z.infer<typeof excelIngestionSourceSchema>;
export type ExcelColumnMapping = z.infer<typeof excelColumnMappingSchema>;
export type ExcelIngestionBudgets = Required<z.infer<typeof excelIngestionBudgetsSchema>>;

type TableCell = {
    value: unknown;
    text: string;
    address?: string;
    formulaWithoutCachedValue?: boolean;
    formulaWithCachedValue?: boolean;
};

type TableData = {
    sheetName: string;
    sourceRange: string;
    headerRow: number;
    dataStartRow: number;
    startColumn: number;
    headers: string[];
    rows: Array<{
        rowNumber: number;
        cells: TableCell[];
    }>;
    notices: string[];
    warnings: string[];
    formulaCachedValueCount: number;
    formulaWithoutCachedValueCount: number;
    scannedCells: number;
    partial: boolean;
    scanStoppedReason: BroadScanStopReason;
    lastReadRow: number | null;
    lastReadColumn: number | null;
};

type ResolvedMapping = {
    mapping: Partial<Record<ColumnRole, number>>;
    warnings: string[];
    notices: string[];
};

type AliasMatch = {
    header: string;
    index: number;
    priority: number;
};

type PrelimitedRows = {
    partial: boolean;
    scanStoppedReason: BroadScanStopReason;
};

function cleanText(value: unknown): string {
    return cleanReconciliationText(value);
}

function normalizeHeader(value: unknown): string {
    return normalizeReconciliationHeader(value);
}

function normalizeAlias(value: string): string {
    return normalizeReconciliationAlias(value);
}

function resolveBudgets(input?: z.infer<typeof excelIngestionBudgetsSchema>): ExcelIngestionBudgets {
    return {
        maxWorkbookBytes: clampBudget(input?.maxWorkbookBytes, DEFAULT_BUDGETS.maxWorkbookBytes, HARD_BUDGETS.maxWorkbookBytes),
        maxSheets: clampBudget(input?.maxSheets, DEFAULT_BUDGETS.maxSheets, HARD_BUDGETS.maxSheets),
        maxRows: clampBudget(input?.maxRows, DEFAULT_BUDGETS.maxRows, HARD_BUDGETS.maxRows),
        maxColumns: clampBudget(input?.maxColumns, DEFAULT_BUDGETS.maxColumns, HARD_BUDGETS.maxColumns),
        maxCells: clampBudget(input?.maxCells, DEFAULT_BUDGETS.maxCells, HARD_BUDGETS.maxCells),
        maxElapsedMs: clampBudget(input?.maxElapsedMs, DEFAULT_BUDGETS.maxElapsedMs, HARD_BUDGETS.maxElapsedMs),
    };
}

function clampBudget(value: unknown, fallback: number, hardMax: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(Math.floor(value), hardMax));
}

function inferFormat(filePath: string, explicitFormat?: string): "xlsx" | "csv" | "tsv" | "xls" | "unsupported" {
    const raw = (explicitFormat || path.extname(filePath).replace(/^\./, "")).trim().toLowerCase();
    if (raw === "xlsx" || raw === "csv" || raw === "tsv" || raw === "xls") {
        return raw;
    }
    return "unsupported";
}

function buildGuardedResult(reason: string, message: string, extra: JsonObject = {}) {
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

function buildFailureResult(error: string, extra: JsonObject = {}) {
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

function buildCompletedResult(options: {
    sourceKind: string;
    format: string;
    table: TableData;
    records: JsonObject[];
    budgets: ExcelIngestionBudgets;
    mapping: Partial<Record<ColumnRole, number>>;
    mappingNotices: string[];
    mappingWarnings: string[];
    elapsedMs: number;
}) {
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

function roleMappingToLabels(mapping: Partial<Record<ColumnRole, number>>, table: TableData): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const role of ALL_ROLES) {
        const index = mapping[role];
        if (typeof index === "number") {
            labels[role] = table.headers[index] || columnNumberToLetters(table.startColumn + index);
        }
    }
    return labels;
}

function columnNumberToLetters(columnNumber: number): string {
    let current = Math.max(1, Math.floor(columnNumber));
    let letters = "";
    while (current > 0) {
        const remainder = (current - 1) % 26;
        letters = String.fromCharCode(65 + remainder) + letters;
        current = Math.floor((current - 1) / 26);
    }
    return letters;
}

function columnLettersToNumber(value: string): number | null {
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

function parseRange(range: string | undefined, fallback: { startRow: number; startColumn: number; endRow: number; endColumn: number }) {
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

function formatRange(startRow: number, startColumn: number, endRow: number, endColumn: number): string {
    return `${columnNumberToLetters(startColumn)}${startRow}:${columnNumberToLetters(endColumn)}${endRow}`;
}

function isEmptyCellText(text: string): boolean {
    return cleanText(text).length === 0;
}

function isEmptyRow(cells: TableCell[]): boolean {
    return cells.every((cell) => isEmptyCellText(cell.text));
}

function makeHeaderKeys(cells: TableCell[], startColumn: number): string[] {
    const seen = new Map<string, number>();
    return cells.map((cell, index) => {
        const fallback = `Column ${columnNumberToLetters(startColumn + index)}`;
        const base = cleanText(cell.text) || fallback;
        const normalized = normalizeHeader(base) || normalizeHeader(fallback);
        const count = seen.get(normalized) || 0;
        seen.set(normalized, count + 1);
        return count === 0 ? base : `${base} ${count + 1}`;
    });
}

function cellValueToText(value: unknown): string {
    if (value === null || value === undefined) {
        return "";
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? "" : value.toISOString();
    }
    if (typeof value === "object") {
        const objectValue = value as JsonObject;
        if (Array.isArray(objectValue.richText)) {
            return cleanText(objectValue.richText.map((part: JsonObject) => String(part.text ?? "")).join(""));
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

function readXlsxCell(worksheet: XLSX.WorkSheet, rowNumber: number, columnNumber: number, sheetName: string): TableCell {
    const cellAddress = XLSX.utils.encode_cell({ r: rowNumber - 1, c: columnNumber - 1 });
    const address = `${sheetName}!${cellAddress}`;
    const cell = worksheet[cellAddress] as XLSX.CellObject | undefined;
    if (!cell) {
        return {
            value: "",
            text: "",
            address,
        };
    }

    const isFormula = typeof cell.f === "string" && cell.f.length > 0;
    if (isFormula) {
        const hasCachedValue = cell.v !== undefined
            && cell.v !== null
            && !(typeof cell.v === "string" && cell.v.length === 0 && (cell.w === undefined || cell.w === ""));
        if (hasCachedValue) {
            return {
                value: cell.v,
                text: cellValueToText(cell.v) || cleanText(cell.w),
                address,
                formulaWithCachedValue: true,
            };
        }
        return {
            value: "",
            text: "",
            address,
            formulaWithoutCachedValue: true,
        };
    }

    const value = cell.v ?? "";
    return {
        value,
        text: cellValueToText(value) || cleanText(cell.w),
        address,
    };
}

function readMatrixCell(value: unknown, rowNumber: number, columnNumber: number, sheetName: string): TableCell {
    return {
        value,
        text: cellValueToText(value),
        address: `${sheetName}!${columnNumberToLetters(columnNumber)}${rowNumber}`,
    };
}

function elapsedExceeded(startedAt: number, budgets: ExcelIngestionBudgets): boolean {
    return performance.now() - startedAt > budgets.maxElapsedMs;
}

function resolveColumnMapping(headers: string[], startColumn: number, explicitMapping?: ExcelColumnMapping): ResolvedMapping | { error: JsonObject } {
    const warnings: string[] = [];
    const notices: string[] = [];
    const mapping: Partial<Record<ColumnRole, number>> = {};
    const assignedIndices = new Set<number>();
    const explicitlyMappedRoles = new Set<ColumnRole>();

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
            .map((role) => `${role}=${headers[mapping[role] as number] || columnNumberToLetters(startColumn + (mapping[role] as number))}`)
            .join(", ");
        notices.push(`column_mapping_inferred_from_headers: ${inferredLabels}. Review or pass explicit columnMapping when first-pass reconciliation looks surprising.`);
    }

    return { mapping, warnings, notices };
}

function buildColumnMappingSuggestion(headers: string[], startColumn: number): JsonObject {
    const candidates: JsonObject = {};
    const example: JsonObject = {};
    const assignedIndices = new Set<number>();
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

function getAliasPriority(role: ColumnRole, header: string): number {
    const normalized = normalizeAlias(header);
    const aliases = ROLE_ALIASES[role];
    for (let index = 0; index < aliases.length; index++) {
        if (normalizeAlias(aliases[index]) === normalized) {
            return index;
        }
    }
    return Number.POSITIVE_INFINITY;
}

function findAllColumnAliases(role: ColumnRole, headers: string[]): AliasMatch[] {
    return headers
        .map((header, index) => ({ header, index, priority: getAliasPriority(role, header) }))
        .filter((match) => Number.isFinite(match.priority));
}

function selectAliasMatch(matches: AliasMatch[], assignedIndices: Set<number>): { kind: "resolved"; match: AliasMatch } | { kind: "ambiguous"; candidates: string[] } {
    const unassignedMatches = matches.filter((match) => !assignedIndices.has(match.index));
    const candidates = unassignedMatches.length > 0 ? unassignedMatches : matches;
    const bestPriority = Math.min(...candidates.map((match) => match.priority));
    const bestCandidates = candidates.filter((match) => match.priority === bestPriority);
    if (bestCandidates.length === 1) {
        return { kind: "resolved", match: bestCandidates[0] };
    }
    return { kind: "ambiguous", candidates: bestCandidates.map((match) => match.header) };
}

function resolveColumnRef(ref: ColumnRef, headers: string[], startColumn: number): number | null {
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

function buildRecords(table: TableData, mapping: Partial<Record<ColumnRole, number>>) {
    const records: JsonObject[] = [];
    for (const row of table.rows) {
        if (isEmptyRow(row.cells)) {
            continue;
        }
        const rawValues: JsonObject = {};
        for (const [indexText, header] of table.headers.entries()) {
            rawValues[header] = row.cells[indexText]?.text ?? "";
        }
        const mappedValues: JsonObject = {};
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

async function loadXlsxTable(source: z.infer<typeof excelFileSourceSchema>, budgets: ExcelIngestionBudgets, startedAt: number): Promise<TableData | JsonObject> {
    const workbook = XLSX.readFile(source.path, { cellDates: true, cellFormula: true, cellText: true, nodim: true });
    const sheets: XlsxSheetRef[] = workbook.SheetNames.map((name) => ({
        name,
        worksheet: workbook.Sheets[name] || {},
    }));
    const selection = source.selection || {};
    const exactSheetSelected = Boolean(selection.sheetName || selection.sheetIndex);
    const nonEmptySheets = sheets.filter((sheet) => xlsxWorksheetHasCells(sheet.worksheet));
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

function selectWorksheet(workbook: XLSX.WorkBook, selection: z.infer<typeof excelSelectionSchema>, nonEmptySheets: XlsxSheetRef[]): XlsxSheetRef | null {
    if (selection.sheetName) {
        const worksheet = workbook.Sheets[selection.sheetName];
        return worksheet ? { name: selection.sheetName, worksheet } : null;
    }
    if (selection.sheetIndex) {
        const name = workbook.SheetNames[selection.sheetIndex - 1];
        return name && workbook.Sheets[name] ? { name, worksheet: workbook.Sheets[name] } : null;
    }
    return nonEmptySheets.length === 1 ? nonEmptySheets[0] : null;
}

function readWorksheetTable(sheet: XlsxSheetRef, selection: z.infer<typeof excelSelectionSchema>, budgets: ExcelIngestionBudgets, startedAt: number): TableData {
    const bounds = findWorksheetBounds(sheet.worksheet);
    return readTabularCells({
        sheetName: sheet.name,
        fallbackRange: bounds,
        selection,
        budgets,
        startedAt,
        readCell: (rowNumber, columnNumber) => readXlsxCell(sheet.worksheet, rowNumber, columnNumber, sheet.name),
    });
}

function xlsxWorksheetHasCells(worksheet: XLSX.WorkSheet): boolean {
    return Object.keys(worksheet).some((key) => !key.startsWith("!"));
}

function findWorksheetBounds(worksheet: XLSX.WorkSheet) {
    let minRow = Number.POSITIVE_INFINITY;
    let minColumn = Number.POSITIVE_INFINITY;
    let maxRow = 1;
    let maxColumn = 1;
    for (const address of Object.keys(worksheet)) {
        if (address.startsWith("!")) {
            continue;
        }
        try {
            const decoded = XLSX.utils.decode_cell(address);
            minRow = Math.min(minRow, decoded.r + 1);
            minColumn = Math.min(minColumn, decoded.c + 1);
            maxRow = Math.max(maxRow, decoded.r + 1);
            maxColumn = Math.max(maxColumn, decoded.c + 1);
        }
        catch {
            continue;
        }
    }
    if (!Number.isFinite(minRow) || !Number.isFinite(minColumn)) {
        return { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 };
    }
    return {
        startRow: minRow,
        startColumn: minColumn,
        endRow: maxRow,
        endColumn: maxColumn,
    };
}

async function loadDelimitedTable(source: z.infer<typeof excelFileSourceSchema>, budgets: ExcelIngestionBudgets, startedAt: number, format: "csv" | "tsv"): Promise<TableData> {
    const text = await fs.readFile(source.path, "utf8");
    const limit = delimitedRecordLimit(source.selection || {}, budgets);
    const rows = parseCsvSync(text, {
        bom: true,
        delimiter: format === "tsv" ? "\t" : ",",
        relax_column_count: true,
        skip_empty_lines: false,
        to: limit.recordLimit + 1,
    }) as unknown[][];
    const prelimited = rows.length > limit.recordLimit
        ? { partial: true, scanStoppedReason: limit.scanStoppedReason }
        : undefined;
    const limitedRows = prelimited ? rows.slice(0, limit.recordLimit) : rows;
    const sheetName = source.selection?.sheetName || (format === "tsv" ? "TSV" : "CSV");
    return readMatrixTable(limitedRows, sheetName, source.selection || {}, budgets, startedAt, prelimited);
}

function delimitedRecordLimit(selection: z.infer<typeof excelSelectionSchema>, budgets: ExcelIngestionBudgets): { recordLimit: number; scanStoppedReason: BroadScanStopReason } {
    const parsedRange = parseRange(selection.range, { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 });
    const rangeStartRow = parsedRange?.startRow || 1;
    const headerRow = selection.headerRow || rangeStartRow;
    const dataStartRow = selection.dataStartRow || headerRow + 1;
    return {
        recordLimit: Math.max(rangeStartRow, headerRow, dataStartRow + budgets.maxRows - 1),
        scanStoppedReason: "max_rows",
    };
}

function loadRowsTable(source: z.infer<typeof excelRowsSourceSchema>, budgets: ExcelIngestionBudgets, startedAt: number): TableData {
    const sheetName = source.sheetName || "Rows";
    const keys = collectRowKeys(source.rows);
    const headerRow = source.selection?.headerRow || 1;
    const dataStartRow = source.selection?.dataStartRow || headerRow + 1;
    const matrix: unknown[][] = [];
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

function collectRowKeys(rows: Array<Record<string, unknown>>): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
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

function readMatrixTable(matrix: unknown[][], sheetName: string, selection: z.infer<typeof excelSelectionSchema>, budgets: ExcelIngestionBudgets, startedAt: number, prelimited?: PrelimitedRows): TableData {
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

function readTabularCells(options: {
    sheetName: string;
    fallbackRange: { startRow: number; startColumn: number; endRow: number; endColumn: number };
    selection: z.infer<typeof excelSelectionSchema>;
    budgets: ExcelIngestionBudgets;
    startedAt: number;
    prelimited?: PrelimitedRows;
    readCell: (rowNumber: number, columnNumber: number) => TableCell;
}): TableData {
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
    let scanStoppedReason: BroadScanStopReason = options.prelimited?.scanStoppedReason || "completed";
    if (endColumn - parsedRange.startColumn + 1 > options.budgets.maxColumns) {
        endColumn = parsedRange.startColumn + options.budgets.maxColumns - 1;
        partial = true;
        scanStoppedReason = "max_columns";
    }

    const headerCells: TableCell[] = [];
    let scannedCells = 0;
    let formulaCachedValueCount = 0;
    let formulaWithoutCachedValueCount = 0;
    const warnings: string[] = [];
    const notices: string[] = [];
    for (let column = parsedRange.startColumn; column <= endColumn; column++) {
        const cell = options.readCell(headerRow, column);
        headerCells.push(cell);
        scannedCells++;
        if (cell.formulaWithCachedValue) formulaCachedValueCount++;
        if (cell.formulaWithoutCachedValue) {
            formulaWithoutCachedValueCount++;
            warnings.push(`Formula cell ${cell.address || `${options.sheetName}!${columnNumberToLetters(column)}${headerRow}`} has no cached value and was read as blank.`);
        }
    }

    const headers = makeHeaderKeys(headerCells, parsedRange.startColumn);
    const rows: TableData["rows"] = [];
    let lastReadRow: number | null = null;
    let lastReadColumn: number | null = null;

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
        const cells: TableCell[] = [];
        for (let column = parsedRange.startColumn; column <= endColumn; column++) {
            const cell = options.readCell(rowNumber, column);
            cells.push(cell);
            scannedCells++;
            lastReadRow = rowNumber;
            lastReadColumn = column;
            if (cell.formulaWithCachedValue) formulaCachedValueCount++;
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

function isResultEnvelope(value: any): boolean {
    return Boolean(value && typeof value === "object" && value.action === ACTION && value.stage === INGESTION_STAGE);
}

export async function ingestExcelSource(rawInput: ExcelIngestionSource): Promise<JsonObject> {
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
        const table = tableResult as TableData;
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
    } catch (error) {
        return buildFailureResult(error instanceof Error ? error.message : String(error), {
            scanPolicy: { budgets },
        });
    }
}

async function loadTableForSource(source: ExcelIngestionSource, budgets: ExcelIngestionBudgets, startedAt: number): Promise<TableData | JsonObject> {
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
