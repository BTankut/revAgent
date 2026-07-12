import { z } from "zod";
import { summarizeSpatialState } from "../spatial/spatialSummary.js";
import { getSpatialStore, SpatialStoreCapabilityError, } from "../spatial/spatialStoreManager.js";
import { connectionTargetSchema, formatJsonContent, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
import { probeSnapshotTrust, spatialToolFailure, MAX_SPATIAL_CONTEXT_TIMEOUT_MS, } from "./spatial_context_tool_helpers.js";
const summaryFilters = z.object({
    nodeIds: z.array(z.string().min(1)).max(2000).optional(),
    nodeKinds: z.array(z.string().min(1)).max(20).optional(),
    categories: z.array(z.string().min(1)).max(100).optional(),
    builtInCategories: z.array(z.string().min(1)).max(100).optional(),
    categoryRoles: z.array(z.string().min(1)).max(50).optional(),
    levelNames: z.array(z.string().min(1)).max(100).optional(),
    levelUniqueIds: z.array(z.string().min(1)).max(100).optional(),
    systemKeys: z.array(z.string().min(1)).max(100).optional(),
    ownerNodeIds: z.array(z.string().min(1)).max(1000).optional(),
}).strict();
export function registerSummarizeSpatialStateTool(server) {
    server.tool("summarize_spatial_state", "[SPATIAL_SUMMARY_ADVISORY_READ_ONLY] Build a compact, deterministic per-level count/extent summary from one explicit complete and currently-live spatial snapshot. The result is advisory context only: advisory=true, verdictCapability=context_only, and quotableAsVerification=false. It never reports clash-free, clearance, occupancy-percentage, or other live verification claims and never writes Revit.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        snapshotId: z.string().min(1),
        filters: summaryFilters.optional(),
        maxNodes: z.number().int().positive().max(50_000).optional(),
        maxLevels: z.number().int().positive().max(100).optional(),
        includeSystems: z.boolean().optional(),
        timeoutMs: z.number().int().min(2000).max(MAX_SPATIAL_CONTEXT_TIMEOUT_MS).optional(),
    }, async (args = {}) => {
        try {
            const store = getSpatialStore();
            const trust = await probeSnapshotTrust(store, String(args.snapshotId), args, "summarize_spatial_state");
            const input = {
                snapshotId: String(args.snapshotId),
                requireCurrent: true,
                trust: {
                    liveness: trust.liveness,
                    evaluatedAt: trust.evaluatedAt,
                    warnings: trust.warnings,
                },
                filters: args.filters,
                maxNodes: args.maxNodes,
                maxLevels: args.maxLevels,
                includeSystems: args.includeSystems,
            };
            return formatJsonContent(summarizeSpatialState(store, input));
        }
        catch (error) {
            if (error instanceof SpatialStoreCapabilityError) {
                return formatJsonContent({
                    success: true,
                    guarded: true,
                    state: "guarded",
                    action: "summarize_spatial_state",
                    reason: error.reason,
                    message: error.message,
                    partial: false,
                    truncated: false,
                    scanStoppedReason: "read_failed",
                    scanPolicy: {},
                    suggestedNextScopes: [],
                    warnings: [],
                    notices: [],
                    nextCursor: null,
                    counts: { nodeCount: 0, levelCount: 0 },
                    elapsedMs: 0,
                });
            }
            return formatJsonContent(spatialToolFailure("summarize_spatial_state", error));
        }
    });
}
