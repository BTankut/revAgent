import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    connectionTargetSchema,
    executionOptionsFromArgs,
    formatJsonContent,
    sendRevitCommand,
    taskMetadataSchema,
} from "../utils/revitToolHelpers.js";

type JsonObject = Record<string, any>;

const budgetDefaults: Record<string, { maxElapsedMs: number; timeoutMs: number }> = {
    fast: { maxElapsedMs: 4500, timeoutMs: 12000 },
    balanced: { maxElapsedMs: 15000, timeoutMs: 30000 },
    deep: { maxElapsedMs: 45000, timeoutMs: 60000 },
};

function resolveBudget(args: JsonObject) {
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

function hasSheetScope(args: JsonObject) {
    return Boolean(
        (Array.isArray(args.sheetIds) && args.sheetIds.length > 0) ||
        String(args.sheetQuery || args.query || "").trim()
    );
}

function buildGuardedNeedsScope(args: JsonObject, budget: ReturnType<typeof resolveBudget>) {
    return {
        success: true,
        guarded: true,
        state: "guarded",
        action: "inspect_sheet_text",
        reason: "needs_scope",
        message: "Project-wide sheet annotation, viewport text, tag, or placed schedule-cell scans can be expensive in large models. First pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",
        partial: false,
        scanStoppedReason: "needs_scope",
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
        warnings: [],
        notices: [],
    };
}

function buildNativeParams(args: JsonObject, budget: ReturnType<typeof resolveBudget>) {
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

export function registerInspectSheetTextTool(server: ToolServer) {
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
            return formatJsonContent(response && response.result ? response.result : response);
        }
        catch (error) {
            return formatJsonContent({
                success: false,
                guarded: false,
                state: "failed",
                action: "inspect_sheet_text",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    });
}
