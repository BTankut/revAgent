import { z } from "zod";
import { connectionTargetSchema, executionOptionsFromArgs, formatJsonContent, sendRevitCommand, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
import { captureSpatialSnapshotAtomic, DEFAULT_SPATIAL_CAPTURE_MAX_ELAPSED_MS, MAX_SPATIAL_CAPTURE_MAX_ELAPSED_MS, } from "../spatial/spatialCapture.js";
import { getSpatialStore, SpatialStoreCapabilityError, } from "../spatial/spatialStoreManager.js";
export const DEFAULT_SPATIAL_PAGE_TARGET_BYTES = 4 * 1024 * 1024;
export const MIN_SPATIAL_PAGE_TARGET_BYTES = 64 * 1024;
export const MAX_SPATIAL_PAGE_TARGET_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SPATIAL_MAX_ELEMENTS = 5000;
export const MAX_SPATIAL_MAX_ELEMENTS = 25000;
export const DEFAULT_SPATIAL_MAX_ELAPSED_MS = 1800;
export const MAX_SPATIAL_MAX_ELAPSED_MS = 5000;
export const DEFAULT_SPATIAL_TIMEOUT_MS = 12000;
export const MAX_SPATIAL_TIMEOUT_MS = 60000;
function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}
function cleanStrings(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(values
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0))]
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}
function cleanIntegerIds(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(values
            .map((value) => /^\d+$/.test(String(value ?? "").trim())
            ? Number.parseInt(String(value).trim(), 10)
            : Number.NaN)
            .filter((value) => Number.isSafeInteger(value) && value > 0))]
        .sort((left, right) => left - right);
}
function cleanLinkedSourceLevelSelectors(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    const selectors = values.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return [];
        }
        const source = value;
        const linkInstanceUniqueId = String(source.linkInstanceUniqueId ?? "").trim();
        const rawLevelId = String(source.levelId ?? "").trim();
        const levelId = /^\d+$/.test(rawLevelId) && Number.parseInt(rawLevelId, 10) > 0
            ? Number.parseInt(rawLevelId, 10)
            : null;
        const levelUniqueId = String(source.levelUniqueId ?? "").trim();
        const levelName = String(source.levelName ?? "").trim();
        if (!linkInstanceUniqueId || (levelId === null && !levelUniqueId && !levelName)) {
            return [];
        }
        return [{
                linkInstanceUniqueId,
                levelId,
                levelUniqueId: levelUniqueId || null,
                levelName: levelName || null,
            }];
    });
    return [...new Map(selectors.map((selector) => [
            `${selector.linkInstanceUniqueId}\u001f${selector.levelId ?? ""}\u001f${selector.levelUniqueId ?? ""}\u001f${(selector.levelName ?? "").toUpperCase()}`,
            selector,
        ])).values()].sort((left, right) => {
        const leftKey = `${left.linkInstanceUniqueId}\u001f${left.levelId ?? ""}\u001f${left.levelUniqueId ?? ""}\u001f${left.levelName ?? ""}`;
        const rightKey = `${right.linkInstanceUniqueId}\u001f${right.levelId ?? ""}\u001f${right.levelUniqueId ?? ""}\u001f${right.levelName ?? ""}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}
export function resolveSpatialCapturePolicy(args = {}) {
    const pageTargetBytes = clampInteger(args.pageTargetBytes, DEFAULT_SPATIAL_PAGE_TARGET_BYTES, MIN_SPATIAL_PAGE_TARGET_BYTES, MAX_SPATIAL_PAGE_TARGET_BYTES);
    const maxElements = clampInteger(args.maxElements, DEFAULT_SPATIAL_MAX_ELEMENTS, 1, MAX_SPATIAL_MAX_ELEMENTS);
    const maxElapsedMs = clampInteger(args.maxElapsedMs, DEFAULT_SPATIAL_MAX_ELAPSED_MS, 250, MAX_SPATIAL_MAX_ELAPSED_MS);
    const timeoutMs = clampInteger(args.timeoutMs, Math.max(DEFAULT_SPATIAL_TIMEOUT_MS, maxElapsedMs + 15000), Math.max(1000, maxElapsedMs + 1000), MAX_SPATIAL_TIMEOUT_MS);
    return {
        pageTargetBytes,
        maxElements,
        maxElapsedMs,
        timeoutMs,
        maxCaptureElapsedMs: clampInteger(args.maxCaptureElapsedMs, DEFAULT_SPATIAL_CAPTURE_MAX_ELAPSED_MS, 1000, MAX_SPATIAL_CAPTURE_MAX_ELAPSED_MS),
    };
}
export function buildSpatialCaptureParams(args, policy = resolveSpatialCapturePolicy(args)) {
    return {
        levelIds: cleanIntegerIds(args.levelIds),
        levelNames: cleanStrings(args.levelNames),
        sourceScope: args.sourceScope || "hostAndLinked",
        linkInstanceIds: cleanIntegerIds(args.linkInstanceIds),
        linkInstanceUniqueIds: cleanStrings(args.linkInstanceUniqueIds),
        linkedSourceLevels: cleanLinkedSourceLevelSelectors(args.linkedSourceLevels),
        linkedSourceLevelNames: cleanStrings(args.linkedSourceLevelNames),
        includeHostMep: args.includeHostMep !== false,
        includeRoomsSpaces: args.includeRoomsSpaces !== false,
        includeLinkedObstructions: args.includeLinkedObstructions !== false,
        belowLevelMm: args.belowLevelMm,
        aboveLevelMm: args.aboveLevelMm,
        pageTargetBytes: policy.pageTargetBytes,
        maxElements: policy.maxElements,
        maxElapsedMs: policy.maxElapsedMs,
        timeoutMs: policy.timeoutMs,
        suppressTaskStatusWindow: true,
        taskName: "Capture spatial snapshot page",
        taskId: undefined,
    };
}
function hasExplicitLevelScope(params) {
    return params.levelIds.length > 0 || params.levelNames.length > 0;
}
function guardedNeedsScope(policy) {
    return {
        success: true,
        guarded: true,
        state: "guarded",
        action: "capture_spatial_snapshot",
        reason: "needs_scope",
        message: "capture_spatial_snapshot requires an explicit level scope. Pass levelIds and/or levelNames; broad whole-model extraction is not available.",
        partial: false,
        scanStoppedReason: "needs_scope",
        scanPolicy: policy,
        suggestedNextScopes: ["levelIds", "levelNames"],
        warnings: [],
        notices: ["No Revit command was sent."],
        nextCursor: null,
    };
}
export function registerCaptureSpatialSnapshotTool(server) {
    server.tool("capture_spatial_snapshot", "[SPATIAL_CAPTURE_READ_ONLY] Capture one explicit host-level scope as a durable SpatialSnapshot v0.2. The runtime owns opaque native paging, validates the revision/hash chain, stages every page in the user-local spatial store, and exposes the snapshot only after one atomic commit. A DocumentChanged sequence interruption discards staging and retries at most twice; mixed revisions never commit. The host scope remains a physical host-Z band. Use placement-qualified linkedSourceLevels when linked Room/Space rows must match an exact source Level; linked obstructions remain physical band-overlap evidence. Returns current/stale/unknown liveness, explicit coverage, counts, page totals, and bounded performance evidence. This tool never writes the Revit model.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        levelIds: z.array(z.union([z.number().int().positive(), z.string()])).max(20).optional().describe("Explicit host Revit level ids. At least one levelIds or levelNames entry is required."),
        levelNames: z.array(z.string().min(1)).max(20).optional().describe("Explicit host Revit level names. At least one levelIds or levelNames entry is required."),
        sourceScope: z.enum(["hostOnly", "linkedOnly", "hostAndLinked"]).optional().describe("Source-document policy. Defaults hostAndLinked."),
        linkInstanceIds: z.array(z.union([z.number().int().positive(), z.string()])).max(100).optional().describe("Optional exact RevitLinkInstance ids inside the explicit level scope."),
        linkInstanceUniqueIds: z.array(z.string().min(1)).max(100).optional().describe("Optional exact RevitLinkInstance unique ids inside the explicit level scope."),
        linkedSourceLevels: z.array(z.object({
            linkInstanceUniqueId: z.string().min(1),
            levelId: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).optional(),
            levelUniqueId: z.string().min(1).optional(),
            levelName: z.string().min(1).optional(),
        }).refine((value) => value.levelId !== undefined || value.levelUniqueId !== undefined || value.levelName !== undefined, "Each linked source level selector requires levelId, levelUniqueId, and/or levelName.")).max(100).optional().describe("Optional placement-qualified exact linked source Level selectors for linked Room/Space rows. Use inspect_levels to obtain linkInstanceUniqueId plus level id/unique id/name. Applied in addition to the required host-Z level band; linked obstructions remain physical band-overlap evidence."),
        linkedSourceLevelNames: z.array(z.string().min(1)).max(100).optional().describe("Optional exact source Level names for linked Room/Space rows, matched case-insensitively across selected links. Applied in addition to the required host-Z level band; use placement-qualified linkedSourceLevels for unambiguous audit identity."),
        includeHostMep: z.boolean().optional().describe("Include supported host-model MEP evidence. Defaults true."),
        includeRoomsSpaces: z.boolean().optional().describe("Include supported Room/Space evidence from the selected source scope. Defaults true."),
        includeLinkedObstructions: z.boolean().optional().describe("Include supported linked structural/architectural obstruction evidence. Defaults true."),
        belowLevelMm: z.number().min(0).max(10000).optional().describe("Optional bounded extent below each selected level, in millimetres. Defaults 1000; native cap 10000."),
        aboveLevelMm: z.number().min(100).max(30000).optional().describe("Optional bounded extent above each selected level, in millimetres. Defaults 6000; native cap 30000."),
        pageTargetBytes: z.number().int().min(MIN_SPATIAL_PAGE_TARGET_BYTES).max(MAX_SPATIAL_PAGE_TARGET_BYTES).optional().describe("Native page target in bytes. Defaults 4 MiB; hard-capped at 8 MiB below the 32 MiB bridge ceiling."),
        maxElements: z.number().int().positive().max(MAX_SPATIAL_MAX_ELEMENTS).optional().describe("Maximum source elements considered by this native page call. Defaults 5000; hard-capped at 25000."),
        maxElapsedMs: z.number().int().min(250).max(MAX_SPATIAL_MAX_ELAPSED_MS).optional().describe("Maximum Revit UI occupancy target for one native page/chunk. Defaults 1800 ms; hard-capped at 5000 ms."),
        maxCaptureElapsedMs: z.number().int().min(1000).max(MAX_SPATIAL_CAPTURE_MAX_ELAPSED_MS).optional().describe("Total bound for one full staged capture attempt. Defaults 45000 ms; hard-capped at 120000 ms."),
        timeoutMs: z.number().int().min(2000).max(MAX_SPATIAL_TIMEOUT_MS).optional().describe("Socket timeout for this one page. Defaults to at least 12000 ms with 15000 ms headroom above maxElapsedMs; hard-capped at 60000 ms."),
    }, async (args) => {
        const policy = resolveSpatialCapturePolicy(args);
        const params = buildSpatialCaptureParams(args, policy);
        if (!hasExplicitLevelScope(params)) {
            return formatJsonContent(guardedNeedsScope(policy));
        }
        try {
            const store = getSpatialStore();
            const result = await captureSpatialSnapshotAtomic({
                nativeParams: params,
                scanPolicy: policy,
                maxCaptureElapsedMs: policy.maxCaptureElapsedMs,
            }, {
                store,
                sendPage: async (pageParams) => await sendRevitCommand("extract_spatial_snapshot", pageParams, {
                    ...executionOptionsFromArgs({
                        target: args.target,
                        host: args.host,
                        port: args.port,
                        timeoutMs: policy.timeoutMs,
                        taskName: "Capture spatial snapshot page",
                    }, "Capture spatial snapshot page"),
                    toolName: "capture_spatial_snapshot",
                    timeoutMs: policy.timeoutMs,
                }),
                probeLiveness: async (sourceRevisions) => {
                    const rawRevisions = sourceRevisions.map((source) => source.metadata || source);
                    const response = await sendRevitCommand("get_spatial_change_state", {
                        sourceRevisions: rawRevisions,
                        expectedTrackerSessionId: sourceRevisions.find((source) => source.trackerSessionId)?.trackerSessionId,
                        timeoutMs: Math.min(policy.timeoutMs, 10000),
                        suppressTaskStatusWindow: true,
                        taskName: "Read spatial change state",
                    }, {
                        ...executionOptionsFromArgs({
                            target: args.target,
                            host: args.host,
                            port: args.port,
                            timeoutMs: Math.min(policy.timeoutMs, 10000),
                            taskName: "Read spatial change state",
                        }, "Read spatial change state"),
                        toolName: "capture_spatial_snapshot",
                        timeoutMs: Math.min(policy.timeoutMs, 10000),
                    });
                    return response && response.result ? response.result : response;
                },
            });
            return formatJsonContent(result);
        }
        catch (error) {
            const guarded = error instanceof SpatialStoreCapabilityError;
            return formatJsonContent({
                success: guarded,
                guarded,
                state: guarded ? "guarded" : "failed",
                action: "capture_spatial_snapshot",
                reason: guarded ? error.reason : "read_failed",
                error: error instanceof Error ? error.message : String(error),
                committed: false,
                partial: false,
                scanStoppedReason: "read_failed",
                scanPolicy: policy,
                suggestedNextScopes: [],
                warnings: [],
                notices: [],
                nextCursor: null,
            });
        }
    });
}
