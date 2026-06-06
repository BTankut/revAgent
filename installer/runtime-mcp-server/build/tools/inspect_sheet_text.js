import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
import { buildBroadScanFailureResult, buildBroadScanGuardedResult, normalizeBroadScanResult, } from "../utils/broadScanResult.js";
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
        maxViewportTextNotesPerView: args.maxViewportTextNotesPerView,
        maxViewportTagsPerView: args.maxViewportTagsPerView,
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
    const kind = String(row.kind || row.sourceType || "");
    if (kind === "scheduleCell")
        return "placedScheduleCell";
    if (kind === "scheduleInstance")
        return "placedScheduleInstance";
    return kind || "sheetTextNote";
}
function buildSheetTextEvidenceRows(payload) {
    const matches = Array.isArray(payload.matches) ? payload.matches : [];
    return matches
        .filter((row) => Boolean(row) && typeof row === "object" && !Array.isArray(row))
        .map((row) => ({
        ...row,
        sourceType: sourceTypeForSheetEvidence(row),
    }));
}
function buildSheetTextSummary(payload) {
    const evidenceRows = Array.isArray(payload.evidenceRows)
        ? payload.evidenceRows
        : buildSheetTextEvidenceRows(payload);
    return {
        sheetQuery: payload.sheetQuery ?? null,
        textQuery: payload.textQuery ?? null,
        totalSheets: payload.totalSheets ?? null,
        candidateCount: payload.candidateCount ?? null,
        returnedCount: payload.returnedCount ?? (Array.isArray(payload.sheets) ? payload.sheets.length : null),
        matchCount: evidenceRows.length,
        partial: payload.partial === true,
        scanStoppedReason: payload.scanStoppedReason ?? "completed",
        scannedSheetCount: payload.scannedSheetCount ?? null,
        scannedViewportCount: payload.scannedViewportCount ?? null,
        scannedTextNoteCount: payload.scannedTextNoteCount ?? null,
        scannedTagCount: payload.scannedTagCount ?? null,
        scannedScheduleInstanceCount: payload.scannedScheduleInstanceCount ?? null,
        scannedScheduleCellCount: payload.scannedScheduleCellCount ?? null,
    };
}
function inferSheetTextLastRead(payload) {
    const evidenceRows = Array.isArray(payload.evidenceRows)
        ? payload.evidenceRows
        : buildSheetTextEvidenceRows(payload);
    const lastEvidence = evidenceRows.length > 0 ? evidenceRows[evidenceRows.length - 1] : null;
    const sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
    const lastSheet = sheets.length > 0 ? sheets[sheets.length - 1] : null;
    return {
        lastReadSection: lastEvidence?.section ?? null,
        lastReadRow: lastEvidence?.row ?? null,
        lastReadColumn: lastEvidence?.column ?? null,
        lastReadSheetId: lastEvidence?.sheetId ?? lastSheet?.id ?? null,
        lastReadViewId: lastEvidence?.viewId ?? null,
        lastReadViewportId: lastEvidence?.viewportId ?? null,
        lastReadItemId: lastEvidence?.elementId ?? lastEvidence?.tagId ?? lastEvidence?.instanceId ?? lastEvidence?.id ?? null,
    };
}
function normalizeSheetTextResult(payload, elapsedMs) {
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
    server.tool("inspect_sheet_text", "[SHEET_TEXT_INSPECTION_READ_ONLY] Read-only native sheet + viewport annotation inspection for DrawingSheet text notes, placed schedule instances, bounded schedule cells, and viewport-linked text notes. Prefer this over generic send_code_to_revit for sheet and plan annotation searches in large projects. Use sheetQuery/sheetIds first; project-wide text, viewport, tag, or placed-schedule cell scans require allowExpensiveSearch=true.", {
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
        includeViewportTags: z.boolean().optional().describe("Opt-in viewport tag scan. Currently returns stable viewport_tags_deferred unless a later native tag scanner is enabled."),
        viewNameQuery: z.string().optional().describe("Optional placed-view name filter used before viewport text-note inspection."),
        maxSheets: z.number().int().positive().max(200).optional().describe("Maximum sheets to inspect/return. Defaults 30."),
        maxTextNotesPerSheet: z.number().int().min(0).max(1000).optional().describe("Maximum matching sheet text notes returned per sheet. Defaults 200."),
        maxScheduleInstancesPerSheet: z.number().int().min(0).max(300).optional().describe("Maximum schedule instances returned per sheet. Defaults 100."),
        maxRowsPerSchedule: z.number().int().min(0).max(500).optional().describe("Maximum schedule body rows to scan when scanScheduleCells=true. Defaults 80."),
        maxColumnsPerSchedule: z.number().int().min(0).max(100).optional().describe("Maximum schedule body columns to scan when scanScheduleCells=true. Defaults 30."),
        maxTextChars: z.number().int().min(20).max(1000).optional().describe("Maximum characters retained per returned text value. Defaults 240."),
        maxViewportsPerSheet: z.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),
        maxViewportTextNotesPerView: z.number().int().min(0).max(1000).optional().describe("Maximum matching viewport text notes returned per placed view. Defaults 200."),
        maxViewportTagsPerView: z.number().int().min(0).max(500).optional().describe("Reserved cap for opt-in viewport tag scanning. Defaults 100."),
        maxTextNotesScanned: z.number().int().positive().max(200000).optional().describe("Global native cap across sheet and viewport text notes."),
        maxTagsScanned: z.number().int().positive().max(100000).optional().describe("Global native cap for future opt-in tag scanning."),
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
