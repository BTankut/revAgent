import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
import { buildBroadScanFailureResult, buildBroadScanGuardedResult, normalizeBroadScanResult, readNativeResultArray, readNativeResultField, readNativeResultObject, } from "../utils/broadScanResult.js";
const budgetDefaults = {
    fast: { maxElapsedMs: 4500, timeoutMs: 12000, maxMatches: 1000 },
    balanced: { maxElapsedMs: 15000, timeoutMs: 30000, maxMatches: 5000 },
    deep: { maxElapsedMs: 45000, timeoutMs: 60000, maxMatches: 20000 },
};
const suggestedNextScopes = [
    "sheetQuery",
    "sheetIds",
    "viewNameQuery",
    "sources",
    "profiles",
    "countMode",
    "groupBy",
    "maxSheets",
    "maxViewports",
    "maxMatches",
    "maxResponseBytes",
    "allowExpensiveSearch",
];
function clampIntArg(value, fallback, min, max) {
    if (value === undefined || value === null || value === "") {
        return fallback;
    }
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}
function resolveBudget(args) {
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
        maxMatches: clampIntArg(args.maxMatches, defaults.maxMatches, 1, 200000),
    };
}
function normalizeSource(value) {
    const normalized = String(value ?? "").trim();
    if (/^sheet_?text_?notes?$/i.test(normalized) || /^sheetTextNotes?$/i.test(normalized)) {
        return "sheet_text_notes";
    }
    if (/^viewport_?tags?$/i.test(normalized) || /^viewportTags?$/i.test(normalized)) {
        return "viewport_tags";
    }
    if (/^viewport_?text_?notes?$/i.test(normalized) || /^viewportTextNotes?$/i.test(normalized) || /^view_?text_?notes?$/i.test(normalized) || /^viewTextNotes?$/i.test(normalized)) {
        return "viewport_text_notes";
    }
    if (/^placed_?schedule_?cells?$/i.test(normalized) || /^placedScheduleCells?$/i.test(normalized) || /^schedule_?cells?$/i.test(normalized) || /^scheduleCells?$/i.test(normalized)) {
        return "placed_schedule_cells";
    }
    return normalized;
}
function normalizeCountMode(value) {
    const normalized = String(value ?? "").trim();
    if (/^unique_?text$/i.test(normalized))
        return "uniqueText";
    if (/^unique_?tag$/i.test(normalized))
        return "uniqueTag";
    if (/^unique_?tagged_?element$/i.test(normalized))
        return "uniqueTaggedElement";
    return "occurrence";
}
function isTagCountMode(countMode) {
    return countMode === "uniqueTag" || countMode === "uniqueTaggedElement";
}
function defaultGlobalCap(searchBudget, fast, balanced, deep) {
    if (searchBudget === "deep")
        return deep;
    if (searchBudget === "balanced")
        return balanced;
    return fast;
}
function resolveSources(args) {
    const countMode = normalizeCountMode(args.countMode);
    const rawSources = Array.isArray(args.sources) ? args.sources : [];
    const sources = [...new Set(rawSources.map(normalizeSource).filter((source) => source.length > 0))];
    if (sources.length > 0) {
        return sources;
    }
    return isTagCountMode(countMode)
        ? ["viewport_tags"]
        : ["sheet_text_notes", "viewport_text_notes", "placed_schedule_cells", "viewport_tags"];
}
function hasExplicitSources(args) {
    return Array.isArray(args.sources) && args.sources.length > 0;
}
function hasSheetScope(args) {
    return Boolean((Array.isArray(args.sheetIds) && args.sheetIds.length > 0) ||
        String(args.sheetQuery || "").trim());
}
function buildCountScanPolicy(args) {
    const budget = resolveBudget(args);
    return {
        searchBudget: budget.searchBudget,
        allowExpensiveSearch: args.allowExpensiveSearch === true,
        sources: resolveSources(args),
        countMode: normalizeCountMode(args.countMode),
        groupBy: Array.isArray(args.groupBy) ? args.groupBy : [],
        maxElapsedMs: budget.maxElapsedMs,
        timeoutMs: budget.timeoutMs,
        maxSheets: clampIntArg(args.maxSheets, 30, 1, 200),
        maxViewportsPerSheet: clampIntArg(args.maxViewportsPerSheet ?? args.maxViewports, 20, 0, 200),
        maxTextNotesScanned: clampIntArg(args.maxTextNotesScanned, defaultGlobalCap(budget.searchBudget, 1000, 5000, 20000), 1, 200000),
        maxTagsScanned: clampIntArg(args.maxTagsScanned ?? args.maxTags, defaultGlobalCap(budget.searchBudget, 500, 2500, 10000), 1, 100000),
        maxScheduleInstancesPerSheet: clampIntArg(args.maxScheduleInstancesPerSheet, 20, 0, 200),
        maxRowsPerSchedule: clampIntArg(args.maxRowsPerSchedule, 250, 1, 2000),
        maxColumnsPerSchedule: clampIntArg(args.maxColumnsPerSchedule, 20, 1, 200),
        maxScheduleInstancesScanned: clampIntArg(args.maxScheduleInstancesScanned, defaultGlobalCap(budget.searchBudget, 200, 1000, 5000), 1, 20000),
        maxScheduleCellsScanned: clampIntArg(args.maxScheduleCellsScanned, defaultGlobalCap(budget.searchBudget, 1000, 5000, 20000), 1, 200000),
        maxMatches: budget.maxMatches,
        maxTextChars: clampIntArg(args.maxTextChars, 240, 1, 1000),
        maxRegexPatternLength: clampIntArg(args.maxRegexPatternLength, 240, 1, 1000),
        regexTimeoutMs: clampIntArg(args.regexTimeoutMs, 25, 1, 250),
        maxResponseBytes: clampIntArg(args.maxResponseBytes, 4 * 1024 * 1024, 4096, 16 * 1024 * 1024),
        sheetScoped: hasSheetScope(args),
    };
}
function buildNativeParams(args, budget) {
    return {
        query: args.query,
        regex: args.regex,
        normalizedRegex: args.normalizedRegex,
        matchMode: args.matchMode,
        sheetQuery: args.sheetQuery,
        sheetIds: args.sheetIds,
        viewNameQuery: args.viewNameQuery,
        sources: resolveSources(args),
        profiles: args.profiles,
        profileName: args.profileName,
        countMode: normalizeCountMode(args.countMode),
        groupBy: args.groupBy,
        allowExpensiveSearch: args.allowExpensiveSearch,
        searchBudget: budget.searchBudget,
        maxElapsedMs: budget.maxElapsedMs,
        maxSheets: args.maxSheets,
        maxViewportsPerSheet: args.maxViewportsPerSheet,
        maxViewports: args.maxViewports,
        maxTextNotesScanned: args.maxTextNotesScanned,
        maxTagsScanned: args.maxTagsScanned,
        maxTags: args.maxTags,
        maxScheduleInstancesPerSheet: args.maxScheduleInstancesPerSheet,
        maxRowsPerSchedule: args.maxRowsPerSchedule,
        maxColumnsPerSchedule: args.maxColumnsPerSchedule,
        maxScheduleInstancesScanned: args.maxScheduleInstancesScanned,
        maxScheduleCellsScanned: args.maxScheduleCellsScanned,
        maxMatches: budget.maxMatches,
        maxTextChars: args.maxTextChars,
        maxRegexPatternLength: args.maxRegexPatternLength,
        regexTimeoutMs: args.regexTimeoutMs,
        maxResponseBytes: args.maxResponseBytes,
        timeoutMs: budget.timeoutMs,
        taskName: args.taskName || "Count Revit annotations",
        taskId: args.taskId,
    };
}
function sourceTypeForAnnotationEvidence(row) {
    const rawSourceType = String(readNativeResultField(row, "sourceType") || "");
    const kind = String(readNativeResultField(row, "kind") || "");
    const candidates = [rawSourceType, kind];
    if (candidates.some((candidate) => candidate === "viewportTag" || candidate === "viewport_tags"))
        return "viewportTag";
    if (candidates.some((candidate) => candidate === "viewportTextNote" || candidate === "viewport_text_notes"))
        return "viewportTextNote";
    if (candidates.some((candidate) => candidate === "sheetTextNote" || candidate === "sheet_text_notes"))
        return "sheetTextNote";
    if (candidates.some((candidate) => candidate === "placedScheduleCell" || candidate === "placed_schedule_cells" || candidate === "scheduleCell"))
        return "placedScheduleCell";
    return rawSourceType || kind || "annotation";
}
function buildCountEvidenceRows(payload) {
    const nativeEvidenceRows = readNativeResultArray(payload, "evidenceRows");
    const sourceRows = nativeEvidenceRows.length > 0
        ? nativeEvidenceRows
        : readNativeResultArray(payload, "matches");
    return sourceRows.map((row) => ({
        ...row,
        sourceType: sourceTypeForAnnotationEvidence(row),
    }));
}
function normalizeGroupKeyName(value) {
    const normalized = String(value ?? "").trim();
    if (/^source_?type$/i.test(normalized))
        return "sourceType";
    if (/^(profile|profileName)$/i.test(normalized))
        return "profile";
    if (/^(pattern|patternName)$/i.test(normalized))
        return "pattern";
    if (/^(matchedCode|matchedText|uniqueText)$/i.test(normalized))
        return "matchedText";
    if (/^tagFamilyType$/i.test(normalized))
        return "tagFamilyType";
    if (/^(taggedElement|taggedElementId)$/i.test(normalized))
        return "taggedElement";
    if (/^view$/i.test(normalized))
        return "view";
    if (/^sheet$/i.test(normalized))
        return "sheet";
    return normalized;
}
function groupFieldsForRow(row, groupBy) {
    const fields = {};
    if (groupBy.length === 0) {
        fields.group = "all";
        return fields;
    }
    for (const rawGroup of groupBy) {
        const group = normalizeGroupKeyName(rawGroup);
        if (group === "sheet") {
            fields.sheetId = readNativeResultField(row, "sheetId") ?? null;
            fields.sheetNumber = readNativeResultField(row, "sheetNumber") ?? null;
        }
        else if (group === "view") {
            fields.viewId = readNativeResultField(row, "viewId") ?? null;
            fields.viewName = readNativeResultField(row, "viewName") ?? null;
        }
        else if (group === "sourceType") {
            fields.sourceType = sourceTypeForAnnotationEvidence(row);
        }
        else if (group === "profile") {
            fields.profileName = readNativeResultField(row, "profileName") ?? null;
        }
        else if (group === "pattern") {
            fields.patternName = readNativeResultField(row, "patternName") ?? null;
        }
        else if (group === "matchedText") {
            fields.matchedTextNormalized = readNativeResultField(row, "matchedTextNormalized") ?? null;
        }
        else if (group === "tagFamilyType") {
            fields.tagFamilyName = readNativeResultField(row, "tagFamilyName") ?? null;
            fields.tagTypeName = readNativeResultField(row, "tagTypeName") ?? null;
        }
        else if (group === "taggedElement") {
            fields.taggedElementId = readNativeResultField(row, "taggedElementId") ?? null;
        }
    }
    if (Object.keys(fields).length === 0) {
        fields.group = "all";
    }
    return fields;
}
function groupKeyForFields(fields) {
    return Object.keys(fields)
        .sort()
        .map((key) => `${key}=${String(fields[key] ?? "")}`)
        .join("|");
}
function countTokenForRow(row, countMode) {
    const sourceType = sourceTypeForAnnotationEvidence(row);
    if (countMode === "occurrence") {
        return "";
    }
    if (countMode === "uniqueText") {
        return `profile:${String(readNativeResultField(row, "profileName") ?? "").trim()}|text:${String(readNativeResultField(row, "matchedTextNormalized") ?? readNativeResultField(row, "textNormalized") ?? "").trim()}`;
    }
    if (countMode === "uniqueTag") {
        if (sourceType !== "viewportTag")
            return "";
        const tagId = String(readNativeResultField(row, "tagId") ?? "").trim();
        return tagId ? `tag:${tagId}` : "";
    }
    if (countMode === "uniqueTaggedElement") {
        if (sourceType !== "viewportTag")
            return "";
        const resolved = readNativeResultField(row, "taggedElementResolved");
        const taggedElementId = String(readNativeResultField(row, "taggedElementId") ?? "").trim();
        if (!resolved || !taggedElementId)
            return "";
        return `taggedElement:${taggedElementId}`;
    }
    return "";
}
function computeFallbackCounts(rows, countMode, groupBy) {
    const groups = new Map();
    const countedKeys = new Set();
    let count = 0;
    let occurrenceCounter = 0;
    const evidenceRows = rows.map((row) => {
        const normalizedRow = {
            ...row,
            sourceType: sourceTypeForAnnotationEvidence(row),
        };
        const fields = groupFieldsForRow(normalizedRow, groupBy);
        const groupKey = groupKeyForFields(fields);
        let group = groups.get(groupKey);
        if (!group) {
            group = {
                groupKey,
                ...fields,
                count: 0,
                occurrenceCount: 0,
                evidenceRowCount: 0,
            };
            groups.set(groupKey, group);
        }
        group.occurrenceCount += 1;
        group.evidenceRowCount += 1;
        const countToken = countMode === "occurrence"
            ? `occurrence:${occurrenceCounter++}`
            : countTokenForRow(normalizedRow, countMode);
        const counted = Boolean(countToken) && !countedKeys.has(`${groupKey}||${countToken}`);
        if (counted) {
            countedKeys.add(`${groupKey}||${countToken}`);
            group.count += 1;
            count += 1;
        }
        return {
            ...normalizedRow,
            groupKey,
            countKey: countToken,
            counted,
            countMode,
        };
    });
    return {
        count,
        evidenceRows,
        groups: [...groups.values()].sort((a, b) => String(a.groupKey).localeCompare(String(b.groupKey))),
    };
}
function groupByForPayload(payload, args) {
    const scanPolicy = readNativeResultObject(payload, "scanPolicy");
    const rawGroupBy = readNativeResultField(scanPolicy, "groupBy") ?? readNativeResultField(payload, "groupBy") ?? args?.groupBy;
    return Array.isArray(rawGroupBy) ? rawGroupBy.map(String) : [];
}
function countModeForPayload(payload, args) {
    return normalizeCountMode(readNativeResultField(payload, "countMode") ?? readNativeResultField(readNativeResultObject(payload, "summary"), "countMode") ?? args?.countMode);
}
function buildCountSummary(payload, args) {
    const evidenceRows = buildCountEvidenceRows(payload);
    const countMode = countModeForPayload(payload, args);
    const fallback = computeFallbackCounts(evidenceRows, countMode, groupByForPayload(payload, args));
    return {
        count: readNativeResultField(payload, "count") ?? fallback.count,
        countMode,
        occurrenceCount: readNativeResultField(payload, "matchedOccurrenceCount") ?? fallback.evidenceRows.length,
        matchCount: fallback.evidenceRows.length,
        evidenceRowCount: fallback.evidenceRows.length,
        groupCount: readNativeResultArray(payload, "groups").length || fallback.groups.length,
        scannedSheetCount: readNativeResultField(payload, "scannedSheetCount") ?? null,
        scannedViewportCount: readNativeResultField(payload, "scannedViewportCount") ?? null,
        scannedTextNoteCount: readNativeResultField(payload, "scannedTextNoteCount") ?? null,
        scannedTagCount: readNativeResultField(payload, "scannedTagCount") ?? null,
        scannedScheduleInstanceCount: readNativeResultField(payload, "scannedScheduleInstanceCount") ?? null,
        scannedScheduleCellCount: readNativeResultField(payload, "scannedScheduleCellCount") ?? null,
        partial: readNativeResultField(payload, "partial") === true,
        scanStoppedReason: readNativeResultField(payload, "scanStoppedReason") ?? "completed",
    };
}
function inferCountLastRead(payload) {
    const evidenceRows = buildCountEvidenceRows(payload);
    const lastEvidence = evidenceRows.length > 0 ? evidenceRows[evidenceRows.length - 1] : null;
    return {
        lastReadSection: readNativeResultField(payload, "lastReadSection") ?? null,
        lastReadRow: readNativeResultField(payload, "lastReadRow") ?? null,
        lastReadColumn: readNativeResultField(payload, "lastReadColumn") ?? null,
        lastReadSheetId: readNativeResultField(lastEvidence, "sheetId") ?? readNativeResultField(payload, "lastReadSheetId") ?? null,
        lastReadViewId: readNativeResultField(lastEvidence, "viewId") ?? readNativeResultField(payload, "lastReadViewId") ?? null,
        lastReadViewportId: readNativeResultField(lastEvidence, "viewportId") ?? readNativeResultField(payload, "lastReadViewportId") ?? null,
        lastReadItemId: readNativeResultField(lastEvidence, "tagId")
            ?? readNativeResultField(lastEvidence, "elementId")
            ?? readNativeResultField(lastEvidence, "scheduleInstanceId")
            ?? readNativeResultField(lastEvidence, "scheduleId")
            ?? readNativeResultField(lastEvidence, "id")
            ?? readNativeResultField(payload, "lastReadItemId")
            ?? null,
    };
}
function preserveCountCompatibilityFields(result, args) {
    const countMode = countModeForPayload(result, args);
    const fallback = computeFallbackCounts(buildCountEvidenceRows(result), countMode, groupByForPayload(result, args));
    const nativeGroups = readNativeResultArray(result, "groups");
    result.countMode = countMode;
    result.evidenceRows = fallback.evidenceRows;
    result.matches = readNativeResultArray(result, "matches").length > 0
        ? readNativeResultArray(result, "matches")
        : result.evidenceRows;
    result.groups = nativeGroups.length > 0 ? nativeGroups : fallback.groups;
    result.count = readNativeResultField(result, "count") ?? readNativeResultField(result.summary, "count") ?? fallback.count;
    result.summary = {
        ...buildCountSummary(result, args),
        ...(readNativeResultObject(result, "summary") || {}),
        count: readNativeResultField(result.summary, "count") ?? result.count,
        countMode,
        matchCount: readNativeResultField(result.summary, "matchCount") ?? result.evidenceRows.length,
        groupCount: readNativeResultField(result.summary, "groupCount") ?? result.groups.length,
    };
    return result;
}
export function normalizeCountAnnotationsResult(payload, args = {}, elapsedMs) {
    return preserveCountCompatibilityFields(normalizeBroadScanResult(payload, {
        action: "count_annotations",
        elapsedMs,
        scanPolicy: buildCountScanPolicy(args),
        summary: (nativePayload) => buildCountSummary(nativePayload, args),
        evidenceRows: buildCountEvidenceRows,
        lastRead: inferCountLastRead,
        suggestedNextScopes,
    }), args);
}
function buildGuardedNeedsScope(args, budget) {
    return buildBroadScanGuardedResult({
        action: "count_annotations",
        reason: "needs_scope",
        message: "Annotation counting can scan many sheets and placed views. Pass sheetQuery/sheetIds, or set allowExpensiveSearch=true with bounded caps.",
        suggestedNextScopes,
        scanPolicy: buildCountScanPolicy({ ...args, maxElapsedMs: budget.maxElapsedMs, timeoutMs: budget.timeoutMs }),
        summary: {
            count: 0,
            countMode: normalizeCountMode(args.countMode),
            matchCount: 0,
            groupCount: 0,
        },
    });
}
function buildGuardedInvalidCountMode(args) {
    return buildBroadScanGuardedResult({
        action: "count_annotations",
        reason: "invalid_count_mode_for_sources",
        message: "uniqueTag and uniqueTaggedElement count modes require viewport_tags as the only source. Omit sources to let the tool default to viewport_tags.",
        suggestedNextScopes,
        scanPolicy: buildCountScanPolicy(args),
        summary: {
            count: 0,
            countMode: normalizeCountMode(args.countMode),
            matchCount: 0,
            groupCount: 0,
        },
    });
}
export function registerCountAnnotationsTool(server) {
    server.tool("count_annotations", "[ANNOTATION_COUNT_READ_ONLY] Read-only native Revit annotation inventory/count for DrawingSheet text notes, viewport text notes, placed schedule cells, and viewport tag evidence. Use sheetQuery/sheetIds first; project-wide annotation counts require allowExpensiveSearch=true. Supports occurrence, uniqueText, uniqueTag, and uniqueTaggedElement count modes with bounded regex profiles.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        query: z.string().optional().describe("Anonymous text query. Defaults to contains matching unless matchMode is supplied."),
        regex: z.string().optional().describe("Anonymous raw regex pattern. Regex matching is bounded by maxRegexPatternLength and regexTimeoutMs."),
        normalizedRegex: z.string().optional().describe("Anonymous regex pattern evaluated against normalized annotation text."),
        matchMode: z.enum(["exact", "contains", "startsWith", "regex", "normalizedRegex"]).optional().describe("Match mode for query when using the anonymous profile."),
        profileName: z.string().optional().describe("Optional anonymous profile name when query/regex is used without profiles."),
        profiles: z.array(z.any()).optional().describe("Explicit profile objects with profileName/name and patterns. Patterns support exact, contains, startsWith, regex, and normalizedRegex."),
        sheetQuery: z.string().optional().describe("Sheet number/name scope. Use this first in large projects."),
        sheetIds: z.array(z.union([z.number(), z.string()])).optional().describe("Exact ViewSheet element ids to inspect. Preferred when known."),
        viewNameQuery: z.string().optional().describe("Optional placed-view name filter before viewport tag inspection."),
        sources: z.array(z.enum(["sheet_text_notes", "viewport_text_notes", "viewport_text_note", "placed_schedule_cells", "placed_schedule_cell", "viewport_tags", "sheetTextNotes", "viewportTextNotes", "viewportTextNote", "view_text_notes", "viewTextNotes", "placedScheduleCells", "placedScheduleCell", "schedule_cells", "schedule_cell", "scheduleCells", "scheduleCell", "viewportTags"])).optional().describe("Annotation sources. Defaults to sheet_text_notes + viewport_text_notes + placed_schedule_cells + viewport_tags except tag-specific count modes, which default to viewport_tags."),
        countMode: z.enum(["occurrence", "uniqueText", "uniqueTag", "uniqueTaggedElement"]).optional().describe("Count semantics. Tag-specific modes require viewport_tags as the only explicit source."),
        groupBy: z.array(z.enum(["sheet", "view", "sourceType", "profile", "profileName", "pattern", "patternName", "matchedText", "matchedCode", "tagFamilyType", "taggedElement", "taggedElementId"])).optional().describe("Optional grouping dimensions for count rows."),
        allowExpensiveSearch: z.boolean().optional().describe("Explicit approval for project-wide sheet and placed-view annotation counting without sheetIds/sheetQuery. Defaults false."),
        searchBudget: z.enum(["fast", "balanced", "deep"]).optional().describe("Native Revit-side scan budget preset. fast is default; deep still respects maxElapsedMs and response-size caps."),
        maxElapsedMs: z.number().int().positive().max(119000).optional().describe("Native Revit-side elapsed budget. It is clamped below timeoutMs so partial results can return before transport timeout."),
        maxSheets: z.number().int().positive().max(200).optional().describe("Maximum matching sheets to inspect. Defaults 30."),
        maxViewportsPerSheet: z.number().int().min(0).max(200).optional().describe("Maximum placed viewports inspected per sheet. Defaults 20."),
        maxViewports: z.number().int().min(0).max(200).optional().describe("Alias for maxViewportsPerSheet."),
        maxTextNotesScanned: z.number().int().positive().max(200000).optional().describe("Global native cap across sheet text notes."),
        maxScheduleInstancesPerSheet: z.number().int().min(0).max(200).optional().describe("Maximum placed schedule instances inspected per sheet. Defaults 20."),
        maxRowsPerSchedule: z.number().int().positive().max(2000).optional().describe("Maximum body rows scanned per placed schedule. Defaults 250."),
        maxColumnsPerSchedule: z.number().int().positive().max(200).optional().describe("Maximum body columns scanned per placed schedule. Defaults 20."),
        maxScheduleInstancesScanned: z.number().int().positive().max(20000).optional().describe("Global native cap across placed schedule instances."),
        maxScheduleCellsScanned: z.number().int().positive().max(200000).optional().describe("Global native cap across placed schedule body cells before scanStoppedReason=max_cells."),
        maxTags: z.number().int().positive().max(100000).optional().describe("Alias for maxTagsScanned. Global native cap across viewport tags."),
        maxTagsScanned: z.number().int().positive().max(100000).optional().describe("Global native cap across viewport tags."),
        maxMatches: z.number().int().positive().max(200000).optional().describe("Maximum returned matching evidence rows before scanStoppedReason=max_items."),
        maxTextChars: z.number().int().min(1).max(1000).optional().describe("Maximum characters retained and matched per annotation candidate. Defaults 240."),
        maxRegexPatternLength: z.number().int().min(1).max(1000).optional().describe("Maximum regex pattern length. Defaults 240."),
        regexTimeoutMs: z.number().int().min(1).max(250).optional().describe("Per-candidate regex timeout in milliseconds. Defaults 25."),
        maxResponseBytes: z.number().int().min(4096).max(16 * 1024 * 1024).optional().describe("Advanced response-size budget. The native handler stops with scanStoppedReason=max_bytes before the bridge response becomes too large."),
        timeoutMs: z.number().int().positive().max(120000).optional().describe("Socket timeout in milliseconds. Defaults from searchBudget with headroom above maxElapsedMs."),
    }, async (args) => {
        const startedAtMs = Date.now();
        try {
            const budget = resolveBudget(args);
            const sources = resolveSources(args);
            const countMode = normalizeCountMode(args.countMode);
            if (isTagCountMode(countMode) && hasExplicitSources(args) && sources.some((source) => source !== "viewport_tags")) {
                return formatJsonContent(buildGuardedInvalidCountMode(args));
            }
            if (!hasSheetScope(args) && args.allowExpensiveSearch !== true) {
                return formatJsonContent(buildGuardedNeedsScope(args, budget));
            }
            const response = await sendRevitCommand("count_annotations", buildNativeParams(args, budget), {
                ...executionOptionsFromArgs({
                    ...args,
                    timeoutMs: budget.timeoutMs,
                }, "Count Revit annotations"),
                toolName: "count_annotations",
            });
            return formatJsonContent(normalizeCountAnnotationsResult(response && response.result ? response.result : response, args, Date.now() - startedAtMs));
        }
        catch (error) {
            return formatJsonContent(buildBroadScanFailureResult({
                action: "count_annotations",
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: Date.now() - startedAtMs,
                suggestedNextScopes,
            }));
        }
    });
}
