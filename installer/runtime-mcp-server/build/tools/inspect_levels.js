import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
import { buildBroadScanFailureResult, normalizeBroadScanResult, readNativeResultArray, readNativeResultField, } from "../utils/broadScanResult.js";
const DEFAULT_MAX_RESULTS = 500;
const MAX_RESULTS = 5000;
const DEFAULT_TIMEOUT_MS = 30000;
function clampInt(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed)
        ? Math.max(minimum, Math.min(maximum, parsed))
        : fallback;
}
function cleanPositiveIds(value) {
    return [...new Set((Array.isArray(value) ? value : [])
            .map((item) => Number.parseInt(String(item ?? ""), 10))
            .filter((item) => Number.isSafeInteger(item) && item > 0))]
        .sort((left, right) => left - right);
}
function cleanExactStrings(value) {
    return [...new Set((Array.isArray(value) ? value : [])
            .map((item) => String(item ?? "").trim())
            .filter((item) => item.length > 0))]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}
function resolveSourceScope(value) {
    const sourceScope = String(value ?? "");
    return ["hostOnly", "linkedOnly", "hostAndLinked"].includes(sourceScope)
        ? sourceScope
        : "hostAndLinked";
}
function resolveNameMatchMode(value) {
    return String(value ?? "") === "exact" ? "exact" : "contains";
}
export function buildInspectLevelsParams(args) {
    return {
        sourceScope: resolveSourceScope(args.sourceScope),
        linkInstanceIds: cleanPositiveIds(args.linkInstanceIds),
        linkInstanceUniqueIds: cleanExactStrings(args.linkInstanceUniqueIds),
        nameQuery: String(args.nameQuery ?? "").trim(),
        nameMatchMode: resolveNameMatchMode(args.nameMatchMode),
        maxResults: clampInt(args.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS),
        timeoutMs: clampInt(args.timeoutMs, DEFAULT_TIMEOUT_MS, 2000, 60000),
        taskName: args.taskName || "Inspect Revit levels",
        taskId: args.taskId,
    };
}
function buildScanPolicy(args) {
    const params = buildInspectLevelsParams(args);
    return {
        sourceScope: params.sourceScope,
        linkInstanceSelectorMode: "exact_id_or_unique_id",
        nameMatchMode: params.nameMatchMode,
        maxResults: params.maxResults,
        deterministicSortBasis: [
            "sourceKind(host_before_link)",
            "linkInstanceUniqueId(ordinal)",
            "linkInstanceId",
            "sourceProjectElevationMm",
            "name(ordinal)",
            "levelUniqueId(ordinal)",
            "levelId",
        ],
        maxResultsAppliedAfterDeterministicSort: true,
    };
}
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function normalizeLinkedSourceLevelSelector(value) {
    if (!isObject(value))
        return null;
    return {
        linkInstanceUniqueId: readNativeResultField(value, "linkInstanceUniqueId") ?? null,
        levelId: readNativeResultField(value, "levelId") ?? null,
        levelUniqueId: readNativeResultField(value, "levelUniqueId") ?? null,
        levelName: readNativeResultField(value, "levelName") ?? null,
    };
}
function normalizeLevelRow(row) {
    return {
        sourceKind: readNativeResultField(row, "sourceKind") ?? null,
        documentKey: readNativeResultField(row, "documentKey") ?? null,
        documentSessionId: readNativeResultField(row, "documentSessionId") ?? null,
        levelId: readNativeResultField(row, "levelId") ?? null,
        levelUniqueId: readNativeResultField(row, "levelUniqueId") ?? null,
        name: readNativeResultField(row, "name") ?? null,
        sourceProjectElevationMm: readNativeResultField(row, "sourceProjectElevationMm") ?? null,
        sourceProjectElevationFrame: readNativeResultField(row, "sourceProjectElevationFrame") ?? null,
        hostElevationMm: readNativeResultField(row, "hostElevationMm") ?? null,
        hostElevationFrame: readNativeResultField(row, "hostElevationFrame") ?? null,
        hostElevationTransformBasis: readNativeResultField(row, "hostElevationTransformBasis") ?? null,
        linkInstanceId: readNativeResultField(row, "linkInstanceId") ?? null,
        linkInstanceUniqueId: readNativeResultField(row, "linkInstanceUniqueId") ?? null,
        linkedSourceLevelSelector: normalizeLinkedSourceLevelSelector(readNativeResultField(row, "linkedSourceLevelSelector")),
    };
}
function normalizedLevelRows(payload) {
    return readNativeResultArray(payload, "levels").map(normalizeLevelRow);
}
function unavailableSourceCount(payload) {
    const value = Number(readNativeResultField(payload, "unavailableSourceCount") ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
function inferPartial(payload) {
    return unavailableSourceCount(payload) > 0 ||
        readNativeResultField(payload, "partial") === true ||
        readNativeResultField(payload, "truncated") === true;
}
function inferScanStoppedReason(payload) {
    if (unavailableSourceCount(payload) > 0)
        return "read_failed";
    if (readNativeResultField(payload, "truncated") === true)
        return "max_items";
    return String(readNativeResultField(payload, "scanStoppedReason") ?? (inferPartial(payload) ? "max_items" : "completed"));
}
function buildSummary(payload) {
    const levels = normalizedLevelRows(payload);
    return {
        sourceScope: readNativeResultField(payload, "sourceScope") ?? null,
        nameQuery: readNativeResultField(payload, "nameQuery") ?? null,
        nameMatchMode: readNativeResultField(payload, "nameMatchMode") ?? null,
        effectiveSourceCount: readNativeResultField(payload, "effectiveSourceCount") ?? null,
        selectedLinkCount: readNativeResultField(payload, "selectedLinkCount") ?? null,
        loadedSelectedLinkCount: readNativeResultField(payload, "loadedSelectedLinkCount") ?? null,
        unavailableSourceCount: unavailableSourceCount(payload),
        scannedLevelCount: readNativeResultField(payload, "scannedLevelCount") ?? null,
        matchedLevelCount: readNativeResultField(payload, "matchedLevelCount") ?? null,
        returnedCount: readNativeResultField(payload, "returnedCount") ?? levels.length,
        partial: inferPartial(payload),
        scanStoppedReason: inferScanStoppedReason(payload),
    };
}
export function normalizeInspectLevelsResult(payload, args, elapsedMs) {
    const levels = normalizedLevelRows(payload);
    const lastLevel = levels.length > 0 ? levels[levels.length - 1] : null;
    const result = normalizeBroadScanResult(payload, {
        action: "inspect_levels",
        elapsedMs,
        partial: inferPartial(payload),
        scanStoppedReason: inferScanStoppedReason(payload),
        scanPolicy: buildScanPolicy(args),
        suggestedNextScopes: ["sourceScope", "linkInstanceIds", "linkInstanceUniqueIds", "nameQuery", "nameMatchMode", "maxResults"],
        summary: buildSummary,
        evidenceRows: levels,
        lastRead: {
            lastReadItemId: lastLevel?.levelId ?? null,
        },
    });
    result.levels = levels;
    delete result.Levels;
    return result;
}
export function registerInspectLevelsTool(server) {
    server.tool("inspect_levels", "[LEVEL_INSPECTION_READ_ONLY] List deterministic host and loaded-linked Revit Level evidence without modifying the model. Use sourceScope plus exact linkInstanceIds/linkInstanceUniqueIds to discover linked source level names and transformed host elevations before capture_spatial_snapshot or other level-scoped reads. Optional nameQuery supports exact or contains matching. sourceProjectElevationMm uses the shared Level.ProjectElevation-compatible resolver. Linked hostElevationMm is based on RevitLinkInstance.GetTransform applied to the source-origin point (0,0,project elevation), and each linked row includes a copy-ready linkedSourceLevelSelector. maxResults is applied only after deterministic sorting and reports partial/max_items when truncated. Missing, unloaded, or unreadable selected links report unavailableSourceCount and partial/read_failed instead of a complete inventory. Prefer this tool over custom C# level/link loops.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        sourceScope: z.enum(["hostOnly", "linkedOnly", "hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked."),
        linkInstanceIds: z.array(z.union([z.number().int().positive(), z.string()])).max(100).optional().describe("Optional exact RevitLinkInstance element ids. Selectors restrict linked sources and are ignored for hostOnly."),
        linkInstanceUniqueIds: z.array(z.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance UniqueIds. Selectors restrict linked sources and are ignored for hostOnly."),
        nameQuery: z.string().optional().describe("Optional Level name filter. Empty returns all levels in the selected sources."),
        nameMatchMode: z.enum(["exact", "contains"]).optional().describe("Level-name matching policy. Defaults contains; matching is ordinal case-insensitive natively."),
        maxResults: z.number().int().positive().max(MAX_RESULTS).optional().describe("Maximum deterministically sorted Level rows returned. Defaults 500; truncation reports partial/max_items."),
        timeoutMs: z.number().int().min(2000).max(60000).optional().describe("Socket timeout in milliseconds. Defaults 30000."),
    }, async (args) => {
        const startedAtMs = Date.now();
        const params = buildInspectLevelsParams(args);
        try {
            const response = await sendRevitCommand("inspect_levels", params, {
                ...executionOptionsFromArgs(args, "Inspect Revit levels"),
                toolName: "inspect_levels",
                timeoutMs: params.timeoutMs,
            });
            return formatJsonContent(normalizeInspectLevelsResult(response && response.result ? response.result : response, args, Date.now() - startedAtMs));
        }
        catch (error) {
            return formatJsonContent(buildBroadScanFailureResult({
                action: "inspect_levels",
                error: error instanceof Error ? error.message : String(error),
                elapsedMs: Date.now() - startedAtMs,
                scanPolicy: buildScanPolicy(args),
                suggestedNextScopes: ["sourceScope", "linkInstanceIds", "linkInstanceUniqueIds", "nameQuery", "nameMatchMode", "maxResults"],
                extra: {
                    sourceScope: params.sourceScope,
                    nameQuery: params.nameQuery,
                    nameMatchMode: params.nameMatchMode,
                    lengthUnit: "mm",
                    hostCoordinateFrame: "host_internal_mm",
                    maxResults: params.maxResults,
                    unavailableSourceCount: 0,
                    levels: [],
                },
            }));
        }
    });
}
