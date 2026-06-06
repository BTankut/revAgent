import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
import { buildBroadScanFailureResult, buildBroadScanGuardedResult, normalizeBroadScanResult, readNativeResultArray, readNativeResultField, } from "../utils/broadScanResult.js";
const budgetDefaults = {
    fast: { maxElapsedMs: 4500, timeoutMs: 12000 },
    balanced: { maxElapsedMs: 15000, timeoutMs: 30000 },
    deep: { maxElapsedMs: 45000, timeoutMs: 60000 },
};
function resolveBudget(args) {
    const searchBudget = ["fast", "balanced", "deep"].includes(String(args.searchBudget || ""))
        ? String(args.searchBudget)
        : "fast";
    const defaults = budgetDefaults[searchBudget];
    const parsedElapsed = Number.parseInt(String(args.maxElapsedMs ?? ""), 10);
    const maxElapsedMs = Number.isFinite(parsedElapsed)
        ? Math.max(1, Math.min(119000, parsedElapsed))
        : defaults.maxElapsedMs;
    const parsedTimeout = Number.parseInt(String(args.timeoutMs ?? ""), 10);
    const timeoutMs = Number.isFinite(parsedTimeout)
        ? Math.max(1000, Math.min(120000, parsedTimeout))
        : Math.max(defaults.timeoutMs, Math.min(120000, maxElapsedMs + 5000));
    return {
        searchBudget,
        maxElapsedMs: Math.min(maxElapsedMs, Math.max(1, timeoutMs - 1000)),
        timeoutMs,
    };
}
function hasSheetScope(args) {
    return Boolean((Array.isArray(args.sheetIds) && args.sheetIds.length > 0) ||
        String(args.sheetQuery || args.query || "").trim());
}
function buildGuardedNeedsScope(args, budget) {
    return buildBroadScanGuardedResult({
        action: "inspect_sheet_text",
        reason: "needs_scope",
        message: "Project-wide sheet annotation, viewport text, tag, or placed schedule-cell scans can be expensive in large models. First pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",
        suggestedNextScopes: ["sheetQuery", "sheetIds", "viewNameQuery", "maxSheets", "allowExpensiveSearch", "searchBudget=deep"],
        scanPolicy: {
            searchBudget: budget.searchBudget,
            maxElapsedMs: budget.maxElapsedMs,
            timeoutMs: budget.timeoutMs,
            allowExpensiveSearch: false,
            textQuery: Boolean(String(args.textQuery || "").trim()),
            includeViewportTextNotes: args.includeViewportTextNotes === true,
            includeViewportTags: args.includeViewportTags === true,
            scanScheduleCells: args.scanScheduleCells === true,
            maxTags: args.maxTags ?? args.maxTagsScanned,
            maxViewports: args.maxViewports ?? args.maxViewportsPerSheet,
        },
        summary: {
            sheetQuery: args.sheetQuery ?? args.query ?? null,
            textQuery: args.textQuery ?? null,
            returnedCount: 0,
            matchCount: 0,
        },
    });
}
function buildNativeParams(args, budget) {
    return {
        query: args.query,
        sheetQuery: args.sheetQuery ?? args.query,
        textQuery: args.textQuery,
        sheetIds: args.sheetIds,
        includeTextNotes: args.includeTextNotes,
        includeScheduleInstances: args.includeScheduleInstances,
        scanScheduleCells: args.scanScheduleCells,
        allowExpensiveSearch: args.allowExpensiveSearch,
        searchBudget: budget.searchBudget,
        maxElapsedMs: budget.maxElapsedMs,
        includeViewportTextNotes: args.includeViewportTextNotes,
        includeViewportTags: args.includeViewportTags,
        viewNameQuery: args.viewNameQuery,
        maxSheets: args.maxSheets,
        maxTextNotesPerSheet: args.maxTextNotesPerSheet,
        maxScheduleInstancesPerSheet: args.maxScheduleInstancesPerSheet,
        maxRowsPerSchedule: args.maxRowsPerSchedule,
        maxColumnsPerSchedule: args.maxColumnsPerSchedule,
        maxTextChars: args.maxTextChars,
        maxViewportsPerSheet: args.maxViewportsPerSheet,
        maxViewports: args.maxViewports,
        maxViewportTextNotesPerView: args.maxViewportTextNotesPerView,
        maxViewportTagsPerView: args.maxViewportTagsPerView,
        maxTags: args.maxTags,
        maxTextNotesScanned: args.maxTextNotesScanned,
        maxTagsScanned: args.maxTagsScanned,
        maxScheduleInstancesScanned: args.maxScheduleInstancesScanned,
        maxScheduleCellsScanned: args.maxScheduleCellsScanned,
        maxResponseBytes: args.maxResponseBytes,
        timeoutMs: budget.timeoutMs,
        taskName: args.taskName || "Inspect Revit sheet annotations",
        taskId: args.taskId,
    };
}
function sourceTypeForSheetEvidence(row) {
    const kind = String(readNativeResultField(row, "kind") || readNativeResultField(row, "sourceType") || "");
    if (kind === "scheduleCell")
        return "placedScheduleCell";
    if (kind === "scheduleInstance")
        return "placedScheduleInstance";
    return kind || "sheetTextNote";
}
function buildSheetTextEvidenceRows(payload) {
    const matches = readNativeResultArray(payload, "matches");
    return matches
        .filter((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row))
        .map((row) => ({
        ...row,
        sourceType: sourceTypeForSheetEvidence(row),
    }));
}
function buildSheetTextSummary(payload) {
    const evidenceRows = readNativeResultArray(payload, "evidenceRows").length > 0
        ? readNativeResultArray(payload, "evidenceRows")
        : buildSheetTextEvidenceRows(payload);
    const sheets = readNativeResultArray(payload, "sheets");
    return {
        sheetQuery: readNativeResultField(payload, "sheetQuery") ?? null,
        textQuery: readNativeResultField(payload, "textQuery") ?? null,
        totalSheets: readNativeResultField(payload, "totalSheets") ?? null,
        candidateCount: readNativeResultField(payload, "candidateCount") ?? null,
        returnedCount: readNativeResultField(payload, "returnedCount") ?? (sheets.length > 0 ? sheets.length : null),
        matchCount: evidenceRows.length,
        partial: readNativeResultField(payload, "partial") === true,
        scanStoppedReason: readNativeResultField(payload, "scanStoppedReason") ?? "completed",
        scannedSheetCount: readNativeResultField(payload, "scannedSheetCount") ?? null,
        scannedViewportCount: readNativeResultField(payload, "scannedViewportCount") ?? null,
        scannedTextNoteCount: readNativeResultField(payload, "scannedTextNoteCount") ?? null,
        scannedTagCount: readNativeResultField(payload, "scannedTagCount") ?? null,
        scannedScheduleInstanceCount: readNativeResultField(payload, "scannedScheduleInstanceCount") ?? null,
        scannedScheduleCellCount: readNativeResultField(payload, "scannedScheduleCellCount") ?? null,
    };
}
function inferSheetTextLastRead(payload) {
    const evidenceRows = readNativeResultArray(payload, "evidenceRows").length > 0
        ? readNativeResultArray(payload, "evidenceRows")
        : buildSheetTextEvidenceRows(payload);
    const lastEvidence = evidenceRows.length > 0 ? evidenceRows[evidenceRows.length - 1] : null;
    const sheets = readNativeResultArray(payload, "sheets");
    const lastSheet = sheets.length > 0 ? sheets[sheets.length - 1] : null;
    return {
        lastReadSection: lastEvidence ? readNativeResultField(lastEvidence, "section") ?? null : null,
        lastReadRow: lastEvidence ? readNativeResultField(lastEvidence, "row") ?? null : null,
        lastReadColumn: lastEvidence ? readNativeResultField(lastEvidence, "column") ?? null : null,
        lastReadSheetId: lastEvidence ? readNativeResultField(lastEvidence, "sheetId") ?? readNativeResultField(lastSheet, "id") ?? null : readNativeResultField(lastSheet, "id") ?? null,
        lastReadViewId: lastEvidence ? readNativeResultField(lastEvidence, "viewId") ?? null : null,
        lastReadViewportId: lastEvidence ? readNativeResultField(lastEvidence, "viewportId") ?? null : null,
        lastReadItemId: lastEvidence
            ? readNativeResultField(lastEvidence, "elementId")
                ?? readNativeResultField(lastEvidence, "tagId")
                ?? readNativeResultField(lastEvidence, "instanceId")
                ?? readNativeResultField(lastEvidence, "id")
                ?? null
            : null,
    };
}
export function normalizeSheetTextResult(payload, elapsedMs) {
    return normalizeBroadScanResult(payload, {
        action: "inspect_sheet_text",
        elapsedMs,
        summary: buildSheetTextSummary,
        evidenceRows: buildSheetTextEvidenceRows,
        lastRead: inferSheetTextLastRead,
        suggestedNextScopes: ["sheetQuery", "sheetIds", "viewNameQuery", "maxSheets", "allowExpensiveSearch", "searchBudget=deep"],
    });
}
export function registerInspectSheetTextTool(server) {
    server.tool("inspect_sheet_text", "[SHEET_TEXT_INSPECTION_READ_ONLY] Read-only native sheet + viewport annotation inspection for DrawingSheet text notes, placed schedule instances, bounded schedule cells, viewport-linked text notes, and viewport tags. Prefer this over generic send_code_to_revit for sheet and plan annotation searches in large projects. Use sheetQuery/sheetIds first; project-wide text, viewport, tag, or placed-schedule cell scans require allowExpensiveSearch=true.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        query: z.string().optional().describe("Alias for sheetQuery. Matches sheet number and sheet name with Turkish/diacritic/Cyrillic-U normalization."),
        sheetQuery: z.string().optional().describe("Sheet number/name filter. Use this first in large projects before broad text or viewport annotation search."),
        textQuery: z.string().optional().describe("Optional text to search in sheet text notes, viewport text notes, or placed schedule cells."),
        sheetIds: z.array(z.union([z.number(), z.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),
        includeTextNotes: z.boolean().optional().describe("Include bounded sheet TextNote results. Defaults true."),
        includeScheduleInstances: z.boolean().optional().describe("Include placed ScheduleSheetInstance entries on matching sheets. Defaults true."),
        scanScheduleCells: z.boolean().optional().describe("When true, search bounded body cells of placed schedules for textQuery. Defaults false to avoid broad scans."),
        allowExpensiveSearch: z.boolean().optional().describe("Explicit approval for project-wide sheet, viewport, tag, or placed-schedule cell scans without sheetIds/sheetQuery. Defaults false."),
        searchBudget: z.enum(["fast", "balanced", "deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),
        maxElapsedMs: z.number().int().positive().max(119000).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),
        includeViewportTextNotes: z.boolean().optional().describe("Include bounded TextNote results from views placed on matching sheets. Defaults false."),
        includeViewportTags: z.boolean().optional().describe("Include bounded IndependentTag evidence from views placed on matching sheets. Defaults false."),
        viewNameQuery: z.string().optional().describe("Optional placed-view name filter used before viewport text-note inspection."),
        maxSheets: z.number().int().positive().max(200).optional().describe("Maximum sheets to inspect/return. Defaults 30."),
        maxTextNotesPerSheet: z.number().int().min(0).max(1000).optional().describe("Maximum matching sheet text notes returned per sheet. Defaults 200."),
        maxScheduleInstancesPerSheet: z.number().int().min(0).max(300).optional().describe("Maximum schedule instances returned per sheet. Defaults 100."),
        maxRowsPerSchedule: z.number().int().min(0).max(500).optional().describe("Maximum schedule body rows to scan when scanScheduleCells=true. Defaults 80."),
        maxColumnsPerSchedule: z.number().int().min(0).max(100).optional().describe("Maximum schedule body columns to scan when scanScheduleCells=true. Defaults 30."),
        maxTextChars: z.number().int().min(20).max(1000).optional().describe("Maximum characters retained per returned text value. Defaults 240."),
        maxViewportsPerSheet: z.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),
        maxViewports: z.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet. Maximum placed viewports inspected per sheet."),
        maxViewportTextNotesPerView: z.number().int().min(0).max(1000).optional().describe("Maximum matching viewport text notes returned per placed view. Defaults 200."),
        maxViewportTagsPerView: z.number().int().min(0).max(500).optional().describe("Maximum matching viewport tags returned per placed view. Defaults 100."),
        maxTextNotesScanned: z.number().int().positive().max(200000).optional().describe("Global native cap across sheet and viewport text notes."),
        maxTags: z.number().int().positive().max(100000).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),
        maxTagsScanned: z.number().int().positive().max(100000).optional().describe("Global native cap across viewport tags."),
        maxScheduleInstancesScanned: z.number().int().positive().max(100000).optional().describe("Global native cap across placed schedule instances."),
        maxScheduleCellsScanned: z.number().int().positive().max(500000).optional().describe("Global native cap across placed schedule body cells."),
        maxResponseBytes: z.number().int().min(4096).max(16 * 1024 * 1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs."),
    }, async (args) => {
        const startedAtMs = Date.now();
        try {
            const budget = resolveBudget(args);
            const scoped = hasSheetScope(args);
            const broadTextSearch = Boolean(String(args.textQuery || "").trim()) && !scoped;
            const broadViewportScan = args.includeViewportTextNotes === true && !scoped;
            const broadScheduleCellScan = args.scanScheduleCells === true && !scoped;
            const broadTagScan = args.includeViewportTags === true && !scoped;
            if ((broadTextSearch || broadViewportScan || broadScheduleCellScan || broadTagScan) && args.allowExpensiveSearch !== true) {
                return formatJsonContent(buildGuardedNeedsScope(args, budget));
            }
            const response = await sendRevitCommand("inspect_sheet_text", buildNativeParams(args, budget), {
                ...executionOptionsFromArgs({
                    ...args,
                    timeoutMs: budget.timeoutMs,
                }, "Inspect Revit sheet annotations"),
                toolName: "inspect_sheet_text",
            });
            return formatJsonContent(normalizeSheetTextResult(response && response.result ? response.result : response, Date.now() - startedAtMs));
        }
        catch (error) {
            return formatJsonContent(buildBroadScanFailureResult({
                action: "inspect_sheet_text",
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: Date.now() - startedAtMs,
                suggestedNextScopes: ["sheetQuery", "sheetIds", "viewNameQuery", "maxSheets", "allowExpensiveSearch", "searchBudget=deep"],
            }));
        }
    });
}
