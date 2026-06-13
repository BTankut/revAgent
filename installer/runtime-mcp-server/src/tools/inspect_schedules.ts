import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    connectionTargetSchema,
    executionOptionsFromArgs,
    formatJsonContent,
    sendRevitCommand,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";
import {
    buildBroadScanFailureResult,
    buildBroadScanGuardedResult,
    normalizeBroadScanResult,
    readNativeResultArray,
    readNativeResultField,
    readNativeResultObject,
} from "../utils/broadScanResult.js";
import {
    boundedPositiveInt,
    compactObjectRows,
    isDetailedResponseMode,
    responseModeSchema,
} from "../utils/responseMode.js";

type JsonObject = Record<string, any>;
const DEFAULT_COMPACT_RESULT_ROWS = 25;
const DEFAULT_COMPACT_MATCH_ROWS = 50;

function clampIntArg(value: unknown, fallback: number, min: number, max: number) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function uniqueSections(values: unknown): string[] {
    const requested = Array.isArray(values) && values.length > 0 ? values : ["header", "body"];
    return [...new Set(requested.map((value: unknown) => String(value || "").toLowerCase()))]
        .filter((value: string) => ["header", "body", "footer"].includes(value));
}

const budgetDefaults: Record<string, { maxElapsedMs: number; timeoutMs: number; maxCells: number }> = {
    fast: { maxElapsedMs: 4500, timeoutMs: 12000, maxCells: 5000 },
    balanced: { maxElapsedMs: 15000, timeoutMs: 30000, maxCells: 25000 },
    deep: { maxElapsedMs: 45000, timeoutMs: 60000, maxCells: 100000 },
};

function resolveBudget(args: JsonObject) {
    const searchBudget = ["fast", "balanced", "deep"].includes(String(args.searchBudget || ""))
        ? String(args.searchBudget)
        : "fast";
    const defaults = budgetDefaults[searchBudget];
    const maxElapsedMs = clampIntArg(args.maxElapsedMs, defaults.maxElapsedMs, 1, 119000);
    const timeoutMs = clampIntArg(args.timeoutMs, Math.max(defaults.timeoutMs, Math.min(120000, maxElapsedMs + 5000)), 1000, 120000);
    return {
        searchBudget,
        maxElapsedMs: Math.min(maxElapsedMs, Math.max(1, timeoutMs - 1000)),
        timeoutMs,
        maxCells: clampIntArg(args.maxCells, defaults.maxCells, 1, 500000),
    };
}

function parseScheduleIds(values: unknown) {
    return (Array.isArray(values) ? values : [])
        .map((value: unknown) => Number.parseInt(String(value), 10))
        .filter((value: number) => Number.isFinite(value) && value > 0);
}

function buildNativeParams(args: JsonObject, budget: ReturnType<typeof resolveBudget>) {
    const scheduleIds = parseScheduleIds(args.scheduleIds);
    const sections = uniqueSections(args.sections);
    return {
        query: args.query,
        nameQuery: args.nameQuery ?? args.query,
        cellQuery: args.cellQuery,
        scheduleIds,
        sections,
        includeCells: args.includeCells,
        scanCells: args.scanCells,
        allowExpensiveSearch: args.allowExpensiveSearch,
        searchBudget: budget.searchBudget,
        maxElapsedMs: budget.maxElapsedMs,
        maxSchedules: clampIntArg(args.maxSchedules, 50, 1, 200),
        maxRowsPerSection: clampIntArg(args.maxRowsPerSection, 80, 0, 1000),
        maxColumnsPerSection: clampIntArg(args.maxColumnsPerSection, 30, 0, 200),
        startRow: clampIntArg(args.startRow, 0, 0, 100000),
        startColumn: clampIntArg(args.startColumn, 0, 0, 10000),
        maxCellTextChars: clampIntArg(args.maxCellTextChars, 180, 20, 1000),
        maxCells: budget.maxCells,
        maxResponseBytes: clampIntArg(args.maxResponseBytes, 4 * 1024 * 1024, 4096, 16 * 1024 * 1024),
        timeoutMs: budget.timeoutMs,
        taskName: args.taskName || "Inspect Revit schedules",
        taskId: args.taskId,
    };
}

function isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
        : [];
}

function scheduleSections(payload: JsonObject) {
    const schedules = readNativeResultArray(payload, "schedules");
    return schedules.filter(isObject).flatMap((schedule) => {
        const sections = readNativeResultArray(schedule, "sections");
        return sections.map((section) => ({ schedule, section }));
    });
}

function hasScheduleCellQuery(payload: JsonObject) {
    return String(readNativeResultField(payload, "cellQuery") ?? "").trim().length > 0;
}

function hasScheduleNameQuery(payload: JsonObject) {
    return String(readNativeResultField(payload, "nameQuery") ?? readNativeResultField(payload, "query") ?? "").trim().length > 0;
}

function buildScheduleEvidenceRows(payload: JsonObject) {
    if (!hasScheduleCellQuery(payload)) {
        return [];
    }
    return scheduleSections(payload).flatMap(({ schedule, section }) => {
        const matches = readNativeResultArray(section, "matches");
        return matches
            .filter(isObject)
            .map((match) => ({
                sourceType: "scheduleCell",
                scheduleId: readNativeResultField(schedule, "id"),
                scheduleName: readNativeResultField(schedule, "name"),
                section: readNativeResultField(match, "section") ?? readNativeResultField(section, "section"),
                row: readNativeResultField(match, "row"),
                column: readNativeResultField(match, "column"),
                text: readNativeResultField(match, "text"),
            }));
    });
}

function inferSchedulePartial(payload: JsonObject) {
    if (readNativeResultField(payload, "partial") === true || readNativeResultField(payload, "truncated") === true) {
        return true;
    }
    return scheduleSections(payload).some(({ section }) => readNativeResultField(section, "rowsTruncated") === true || readNativeResultField(section, "columnsTruncated") === true);
}

function inferScheduleStopReason(payload: JsonObject) {
    if (readNativeResultField(payload, "success") === false || String(readNativeResultField(payload, "state") || "").toLowerCase() === "failed" || readNativeResultField(payload, "error")) {
        return "read_failed";
    }
    if (!inferSchedulePartial(payload)) {
        return "completed";
    }
    if (readNativeResultField(payload, "truncated") === true) {
        return "max_items";
    }
    for (const { section } of scheduleSections(payload)) {
        if (readNativeResultField(section, "rowsTruncated") === true) return "max_rows";
        if (readNativeResultField(section, "columnsTruncated") === true) return "max_columns";
    }
    return "max_cells";
}

function resolveScheduleStopReason(payload: JsonObject) {
    const inferred = inferScheduleStopReason(payload);
    const nativeReason = readNativeResultField(payload, "scanStoppedReason");
    if (!nativeReason || (nativeReason === "completed" && inferred !== "completed")) {
        return inferred;
    }
    return nativeReason;
}

function buildScheduleSummary(payload: JsonObject) {
    const compatibleScan = buildCompatibleScheduleScan(payload);
    const scan = isObject(compatibleScan) ? compatibleScan : {};
    const schedules = readNativeResultArray(payload, "schedules");
    const evidenceRows = readNativeResultArray(payload, "evidenceRows").length > 0
        ? readNativeResultArray(payload, "evidenceRows")
        : buildScheduleEvidenceRows(payload);
    return {
        query: readNativeResultField(payload, "query") ?? null,
        nameQuery: readNativeResultField(payload, "nameQuery") ?? null,
        cellQuery: readNativeResultField(payload, "cellQuery") ?? null,
        totalSchedules: readNativeResultField(payload, "totalSchedules") ?? null,
        candidateCount: readNativeResultField(payload, "candidateCount") ?? null,
        returnedCount: readNativeResultField(payload, "returnedCount") ?? (schedules.length > 0 ? schedules.length : null),
        inventoryMode: !hasScheduleNameQuery(payload) && !hasScheduleCellQuery(payload),
        matchCount: evidenceRows.length,
        totalCellMatches: readNativeResultField(scan, "totalCellMatches") ?? evidenceRows.length,
        scannedScheduleCount: readNativeResultField(scan, "scannedScheduleCount") ?? null,
        partial: inferSchedulePartial(payload),
        scanStoppedReason: resolveScheduleStopReason(payload),
    };
}

function inferScheduleLastRead(payload: JsonObject) {
    const evidenceRows = readNativeResultArray(payload, "evidenceRows").length > 0
        ? readNativeResultArray(payload, "evidenceRows")
        : buildScheduleEvidenceRows(payload);
    const lastEvidence = evidenceRows.length > 0 ? evidenceRows[evidenceRows.length - 1] : null;
    const sections = scheduleSections(payload);
    const lastSection = sections.length > 0 ? sections[sections.length - 1].section : null;
    const schedules = readNativeResultArray(payload, "schedules");
    const lastSchedule = sections.length > 0
        ? sections[sections.length - 1].schedule
        : schedules.length > 0 ? schedules[schedules.length - 1] : null;
    const returnedRows = Number(readNativeResultField(lastSection, "returnedRows") ?? readNativeResultField(lastSection, "scannedRows") ?? 0);
    const returnedColumns = Number(readNativeResultField(lastSection, "returnedColumns") ?? readNativeResultField(lastSection, "scannedColumns") ?? 0);
    const startRow = Number(readNativeResultField(lastSection, "startRow") ?? 0);
    const startColumn = Number(readNativeResultField(lastSection, "startColumn") ?? 0);
    return {
        lastReadSection: readNativeResultField(lastEvidence, "section") ?? readNativeResultField(lastSection, "section") ?? null,
        lastReadRow: readNativeResultField(lastEvidence, "row")
            ?? readNativeResultField(lastSection, "lastReadRow")
            ?? (returnedRows > 0 ? startRow + returnedRows - 1 : null),
        lastReadColumn: readNativeResultField(lastEvidence, "column")
            ?? readNativeResultField(lastSection, "lastReadColumn")
            ?? (returnedColumns > 0 ? startColumn + returnedColumns - 1 : null),
        lastReadSheetId: null,
        lastReadViewId: null,
        lastReadViewportId: null,
        lastReadItemId: readNativeResultField(lastEvidence, "scheduleId") ?? readNativeResultField(lastSchedule, "id") ?? null,
    };
}

function buildScheduleScanPolicy(args: JsonObject) {
    const budget = resolveBudget(args);
    return {
        searchBudget: budget.searchBudget,
        allowExpensiveSearch: args.allowExpensiveSearch === true,
        includeCells: args.includeCells === true,
        scanCells: args.scanCells === true || Boolean(args.cellQuery),
        sections: uniqueSections(args.sections),
        maxElapsedMs: budget.maxElapsedMs,
        maxSchedules: clampIntArg(args.maxSchedules, 50, 1, 200),
        maxRowsPerSection: clampIntArg(args.maxRowsPerSection, 80, 0, 1000),
        maxColumnsPerSection: clampIntArg(args.maxColumnsPerSection, 30, 0, 200),
        startRow: clampIntArg(args.startRow, 0, 0, 100000),
        startColumn: clampIntArg(args.startColumn, 0, 0, 10000),
        maxCells: budget.maxCells,
        maxResponseBytes: clampIntArg(args.maxResponseBytes, 4 * 1024 * 1024, 4096, 16 * 1024 * 1024),
        timeoutMs: budget.timeoutMs,
    };
}

function buildCompatibleSection(section: JsonObject, includeMatches = true) {
    const { matches: _matches, Matches: _pascalMatches, ...rest } = section;
    return {
        ...rest,
        section: readNativeResultField(section, "section"),
        rowCount: readNativeResultField(section, "rowCount"),
        columnCount: readNativeResultField(section, "columnCount"),
        startRow: readNativeResultField(section, "startRow"),
        startColumn: readNativeResultField(section, "startColumn"),
        returnedRows: readNativeResultField(section, "returnedRows"),
        returnedColumns: readNativeResultField(section, "returnedColumns"),
        rowsTruncated: readNativeResultField(section, "rowsTruncated"),
        columnsTruncated: readNativeResultField(section, "columnsTruncated"),
        scannedRows: readNativeResultField(section, "scannedRows"),
        scannedColumns: readNativeResultField(section, "scannedColumns"),
        scannedCells: readNativeResultField(section, "scannedCells"),
        lastReadRow: readNativeResultField(section, "lastReadRow"),
        lastReadColumn: readNativeResultField(section, "lastReadColumn"),
        matches: includeMatches
            ? readNativeResultArray(section, "matches")
                .filter(isObject)
                .map((match) => ({
                    ...match,
                    section: readNativeResultField(match, "section"),
                    row: readNativeResultField(match, "row"),
                    column: readNativeResultField(match, "column"),
                    text: readNativeResultField(match, "text"),
                }))
            : [],
        cells: readNativeResultArray(section, "cells").map((row) => ({
            ...row,
            row: readNativeResultField(row, "row"),
            cells: readNativeResultArray(row, "cells").map((cell) => ({
                ...cell,
                column: readNativeResultField(cell, "column"),
                text: readNativeResultField(cell, "text"),
            })),
        })),
        readFailed: readNativeResultField(section, "readFailed"),
        readError: readNativeResultField(section, "readError"),
    };
}

function buildCompatibleSchedules(result: JsonObject) {
    const inventoryMode = !hasScheduleNameQuery(result) && !hasScheduleCellQuery(result);
    const includeMatches = hasScheduleCellQuery(result);
    return readNativeResultArray(result, "schedules")
        .filter(isObject)
        .map((schedule) => {
            const { nameMatched: _nameMatched, NameMatched: _pascalNameMatched, cellMatchCount: _cellMatchCount, CellMatchCount: _pascalCellMatchCount, sections: _sections, Sections: _pascalSections, ...rest } = schedule;
            return {
                ...rest,
                id: readNativeResultField(schedule, "id"),
                uniqueId: readNativeResultField(schedule, "uniqueId"),
                name: readNativeResultField(schedule, "name"),
                viewType: readNativeResultField(schedule, "viewType"),
                isTemplate: readNativeResultField(schedule, "isTemplate"),
                nameMatched: inventoryMode ? false : readNativeResultField(schedule, "nameMatched"),
                cellMatchCount: includeMatches ? readNativeResultField(schedule, "cellMatchCount") : 0,
                sections: readNativeResultArray(schedule, "sections")
                    .filter(isObject)
                    .map((section) => buildCompatibleSection(section, includeMatches)),
            };
        });
}

function applyCasingNormalization(target: JsonObject, fields: JsonObject) {
    for (const [camelName, value] of Object.entries(fields)) {
        const pascalName = camelName.charAt(0).toUpperCase() + camelName.slice(1);
        target[camelName] = value;
        target[pascalName] = value;
    }
    return target;
}

function buildCompatibleScheduleScan(result: JsonObject) {
    const scan = readNativeResultField(result, "scan");
    if (!scan || typeof scan !== "object" || Array.isArray(scan)) {
        return scan;
    }
    const target = { ...scan };
    const fields: JsonObject = {};
    if (!hasScheduleNameQuery(result)) {
        fields.scheduleNameMatchedCount = 0;
    }
    if (!hasScheduleCellQuery(result)) {
        fields.cellMatchedScheduleCount = 0;
        fields.totalCellMatches = 0;
    }
    return applyCasingNormalization(target, fields);
}

function preserveScheduleCompatibilityFields(result: JsonObject) {
    for (const field of ["query", "nameQuery", "cellQuery", "totalSchedules", "candidateCount", "returnedCount", "truncated", "maxSchedules", "scan", "matches"]) {
        const value = readNativeResultField(result, field);
        if (value !== undefined && result[field] === undefined) {
            result[field] = value;
        }
    }
    result.scan = buildCompatibleScheduleScan(result);
    result.schedules = buildCompatibleSchedules(result);
    if (!hasScheduleCellQuery(result)) {
        result.matches = [];
        delete result.Matches;
    }
    return result;
}

function scheduleKey(schedule: JsonObject): string {
    return String(readNativeResultField(schedule, "id") ?? readNativeResultField(schedule, "uniqueId") ?? readNativeResultField(schedule, "name") ?? "");
}

function compactScheduleSection(section: JsonObject, maxMatchRows: number) {
    const cells = readNativeResultArray(section, "cells");
    const matches = compactObjectRows(readNativeResultArray(section, "matches"), {
        limit: maxMatchRows,
    });
    const { cells: _cells, Cells: _pascalCells, matches: _matches, Matches: _pascalMatches, ...rest } = section;
    return {
        ...rest,
        matches: matches.rows,
        matchCount: matches.totalCount,
        returnedMatchCount: matches.returnedCount,
        omittedMatchCount: matches.omittedCount,
        duplicateMatchCount: matches.duplicateCount,
        cellsOmitted: cells.length > 0,
        cellRowCount: cells.length,
        fullResponseHint: cells.length > 0 ? "Use responseMode=\"full\" when downstream schedule adapters need section.cells/body rows." : undefined,
    };
}

function compactSchedules(result: JsonObject, args: JsonObject): JsonObject {
    const responseMode = args.responseMode || "compact";
    if (isDetailedResponseMode(responseMode)) {
        return {
            ...result,
            responseMode,
        };
    }

    const scheduleLimit = boundedPositiveInt(args.maxResultRows, DEFAULT_COMPACT_RESULT_ROWS, 200);
    const matchLimit = boundedPositiveInt(args.maxEvidenceRows, DEFAULT_COMPACT_MATCH_ROWS, 1000);
    const scheduleRows = compactObjectRows(readNativeResultArray(result, "schedules"), {
        limit: scheduleLimit,
        key: scheduleKey,
    });
    const evidenceRows = compactObjectRows(readNativeResultArray(result, "evidenceRows"), {
        limit: matchLimit,
    });
    return {
        ...result,
        responseMode: "compact",
        schedules: scheduleRows.rows.map((schedule) => ({
            ...schedule,
            sections: readNativeResultArray(schedule, "sections")
                .filter(isObject)
                .map((section) => compactScheduleSection(section, matchLimit)),
        })),
        evidenceRows: evidenceRows.rows,
        summary: {
            ...(result.summary || {}),
            compactResponse: true,
            scheduleRowCount: scheduleRows.totalCount,
            returnedScheduleRowCount: scheduleRows.returnedCount,
            omittedScheduleRowCount: scheduleRows.omittedCount,
            duplicateScheduleRowCount: scheduleRows.duplicateCount,
            evidenceRowCount: evidenceRows.totalCount,
            returnedEvidenceRowCount: evidenceRows.returnedCount,
            omittedEvidenceRowCount: evidenceRows.omittedCount,
        },
        notices: [
            ...cleanStringArray(result.notices),
            "Compact response omits section.cells and bounds evidence rows. Use responseMode=\"full\" for full schedule cell bodies.",
        ],
    };
}

export function normalizeScheduleResult(payload: JsonObject, args: JsonObject, elapsedMs: number) {
    const partial = inferSchedulePartial(payload);
    return compactSchedules(preserveScheduleCompatibilityFields(normalizeBroadScanResult(payload, {
        action: "inspect_schedules",
        elapsedMs,
        partial,
        scanStoppedReason: resolveScheduleStopReason(payload),
        scanPolicy: buildScheduleScanPolicy(args),
        suggestedNextScopes: ["nameQuery", "scheduleIds", "sections", "startRow", "startColumn", "maxRowsPerSection", "maxColumnsPerSection", "maxCells", "maxResponseBytes", "maxElapsedMs", "allowExpensiveSearch"],
        summary: buildScheduleSummary,
        evidenceRows: buildScheduleEvidenceRows,
        lastRead: inferScheduleLastRead,
    })), args);
}

export function registerInspectSchedulesTool(server: ToolServer) {
    server.tool("inspect_schedules", "[SCHEDULE_INSPECTION_READ_ONLY] Read-only native Revit schedule discovery and bounded cell inspection with partial-result continuation state. Prefer this over generic send_code_to_revit when finding schedules or reading schedule cells. For large models, use nameQuery/scheduleIds first; broad cell scans require allowExpensiveSearch=true. Default responseMode=compact omits bulky section.cells; use responseMode=full when the next step needs raw schedule body rows, such as reconcile_schedule_excel schedule adaptation.",
 {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        query: z.string().optional().describe("Alias for nameQuery. Matches schedule names with Turkish/diacritic/Cyrillic-U normalization."),
        nameQuery: z.string().optional().describe("Schedule name filter. Use this first in large projects before scanning cells."),
        cellQuery: z.string().optional().describe("Optional text to search inside bounded schedule cells. Use with nameQuery or scheduleIds for large projects."),
        scheduleIds: z.array(z.union([z.number(), z.string()])).optional().describe("Exact ViewSchedule element ids to inspect. Preferred when known."),
        sections: z.array(z.enum(["header", "body", "footer"])).optional().describe("Schedule sections to read/scan. Defaults to header and body."),
        includeCells: z.boolean().optional().describe("Return a bounded cell snapshot for each returned schedule. Defaults false."),
        scanCells: z.boolean().optional().describe("Scan bounded cells for cellQuery. Defaults true when cellQuery is provided, otherwise false."),
        allowExpensiveSearch: z.boolean().optional().describe("Explicit approval for scanning schedule cells without scheduleIds/nameQuery. Defaults false."),
        searchBudget: z.enum(["fast", "balanced", "deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),
        maxElapsedMs: z.number().int().positive().max(119000).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial schedule results can return before transport timeout."),
        maxSchedules: z.number().int().positive().max(200).optional().describe("Maximum schedules to inspect/return. Defaults 50."),
        maxRowsPerSection: z.number().int().min(0).max(1000).optional().describe("Maximum rows per section to read/scan. Defaults 80."),
        maxColumnsPerSection: z.number().int().min(0).max(200).optional().describe("Maximum columns per section to read/scan. Defaults 30."),
        startRow: z.number().int().min(0).max(100000).optional().describe("Zero-based first schedule row to read in each requested section. Defaults 0."),
        startColumn: z.number().int().min(0).max(10000).optional().describe("Zero-based first schedule column to read in each requested section. Defaults 0."),
        maxCells: z.number().int().positive().max(500000).optional().describe("Global native cap across schedule cells read or scanned. Defaults by searchBudget."),
        maxResponseBytes: z.number().int().min(4096).max(16 * 1024 * 1024).optional().describe("Approximate native response-size cap. Defaults 4 MB."),
        maxCellTextChars: z.number().int().min(20).max(1000).optional().describe("Maximum characters retained per returned cell text. Defaults 180."),
        responseMode: responseModeSchema,
        maxResultRows: z.number().int().positive().max(200).optional().describe("Compact-mode cap for returned schedule entries. Defaults 25; full/debug returns all native rows within maxSchedules."),
        maxEvidenceRows: z.number().int().positive().max(1000).optional().describe("Compact-mode cap for evidenceRows and per-section matches. Defaults 50."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults 120000."),
    }, async (args) => {
        const startedAtMs = Date.now();
        try {
            const hasScheduleScope = Boolean(
                (Array.isArray(args.scheduleIds) && args.scheduleIds.length > 0) ||
                String(args.nameQuery || args.query || "").trim()
            );
            const wantsCells = Boolean(args.includeCells === true || args.scanCells === true || String(args.cellQuery || "").trim());
            if (wantsCells && !hasScheduleScope && args.allowExpensiveSearch !== true) {
                return formatJsonContent(buildBroadScanGuardedResult({
                    action: "inspect_schedules",
                    reason: "needs_scope",
                    message: "Schedule cell scanning without scheduleIds/nameQuery can be expensive in large models. First discover schedules by name, pass exact scheduleIds, or set allowExpensiveSearch=true.",
                    suggestedNextScopes: ["nameQuery", "scheduleIds", "sections", "startRow", "startColumn", "maxRowsPerSection", "maxColumnsPerSection", "maxCells", "maxResponseBytes", "maxElapsedMs", "allowExpensiveSearch"],
                    scanPolicy: buildScheduleScanPolicy(args),
                    elapsedMs: Date.now() - startedAtMs,
                    summary: {
                        nameQuery: args.nameQuery ?? args.query ?? null,
                        cellQuery: args.cellQuery ?? null,
                        returnedCount: 0,
                        matchCount: 0,
                    },
                }));
            }
            const budget = resolveBudget(args);
            const response = await sendRevitCommand("inspect_schedules", buildNativeParams(args, budget), {
                ...executionOptionsFromArgs(args, "Inspect Revit schedules"),
                toolName: "inspect_schedules",
                timeoutMs: budget.timeoutMs,
            });
            return formatJsonContent(normalizeScheduleResult(response && response.result ? response.result : response, args, Date.now() - startedAtMs));
        }
        catch (error) {
            return formatJsonContent(buildBroadScanFailureResult({
                action: "inspect_schedules",
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: Date.now() - startedAtMs,
                scanPolicy: buildScheduleScanPolicy(args),
                suggestedNextScopes: ["nameQuery", "scheduleIds", "sections", "startRow", "startColumn", "maxRowsPerSection", "maxColumnsPerSection", "maxCells", "maxResponseBytes", "maxElapsedMs", "allowExpensiveSearch"],
            }));
        }
    });
}
