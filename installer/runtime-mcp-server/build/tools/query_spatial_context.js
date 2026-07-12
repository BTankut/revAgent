import { z } from "zod";
import { querySpatialContext } from "../spatial/spatialQuery.js";
import { getSpatialStore, SpatialStoreCapabilityError, } from "../spatial/spatialStoreManager.js";
import { connectionTargetSchema, formatJsonContent, taskMetadataSchema, } from "../utils/revitToolHelpers.js";
import { probeSnapshotTrust, spatialToolFailure, MAX_SPATIAL_CONTEXT_TIMEOUT_MS, } from "./spatial_context_tool_helpers.js";
const point3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const aabb = z.object({
    minMm: point3,
    maxMm: point3,
}).strict();
const filters = z.object({
    nodeIds: z.array(z.string().min(1)).max(2000).optional(),
    nodeKinds: z.array(z.string().min(1)).max(20).optional(),
    categories: z.array(z.string().min(1)).max(100).optional(),
    builtInCategories: z.array(z.string().min(1)).max(100).optional(),
    categoryRoles: z.array(z.string().min(1)).max(50).optional(),
    levelNames: z.array(z.string().min(1)).max(100).optional(),
    levelUniqueIds: z.array(z.string().min(1)).max(100).optional(),
    systemKeys: z.array(z.string().min(1)).max(100).optional(),
    ownerNodeIds: z.array(z.string().min(1)).max(1000).optional(),
    aabb: aabb.optional(),
    elevationBandMm: z.object({
        minZ: z.number().finite(),
        maxZ: z.number().finite(),
    }).strict().optional(),
    withinSpaceNodeIds: z.array(z.string().min(1)).max(100).optional(),
}).strict();
const operationFilters = filters.omit({
    nodeIds: true,
    ownerNodeIds: true,
    withinSpaceNodeIds: true,
});
const operation = z.discriminatedUnion("name", [
    z.object({
        name: z.literal("relation_between"),
        sourceNodeId: z.string().min(1),
        targetNodeId: z.string().min(1),
    }).strict(),
    z.object({
        name: z.literal("nearest_elements"),
        anchorNodeId: z.string().min(1),
        maxDistanceMm: z.number().finite().nonnegative().max(1_000_000),
        limit: z.number().int().positive().max(1000).optional(),
        filters: operationFilters.optional(),
    }).strict(),
    z.object({
        name: z.literal("elements_within"),
        anchorNodeId: z.string().min(1),
        distanceMm: z.number().finite().nonnegative().max(1_000_000),
        limit: z.number().int().positive().max(1000).optional(),
        filters: operationFilters.optional(),
    }).strict(),
    z.object({
        name: z.literal("clearance_between"),
        sourceNodeId: z.string().min(1),
        targetNodeId: z.string().min(1),
    }).strict(),
    z.object({
        name: z.literal("trace_connectivity"),
        startNodeId: z.string().min(1),
        targetNodeId: z.string().min(1).optional(),
        maxDepth: z.number().int().min(0).max(100).optional(),
        maxNodes: z.number().int().positive().max(5000).optional(),
    }).strict(),
    z.object({
        name: z.literal("locate_in_space"),
        nodeId: z.string().min(1),
        spaceNodeIds: z.array(z.string().min(1)).max(2000).optional(),
        maxSpaces: z.number().int().positive().max(1000).optional(),
    }).strict(),
    z.object({
        name: z.literal("above_below"),
        sourceNodeId: z.string().min(1),
        targetNodeId: z.string().min(1),
        toleranceMm: z.number().finite().nonnegative().max(10_000).optional(),
    }).strict(),
]);
export function registerQuerySpatialContextTool(server) {
    server.tool("query_spatial_context", "[SPATIAL_QUERY_READ_ONLY] Query one explicit, complete, currently-live spatial snapshot. mode=retrieve returns a bounded filtered subgraph; mode=operation runs one deterministic relation operation (relation_between, nearest_elements, elements_within, clearance_between, trace_connectivity, locate_in_space, or above_below). Geometry and topology are computed by the runtime, never by the LLM. Every operation echoes inputs and reports basis, precisionClass, verdictCapability, and evidence ids. Phase 1b clearance is context/screening evidence only and never a live clash or clearance verdict. This tool never writes Revit.", {
        ...connectionTargetSchema(z),
        ...taskMetadataSchema(z),
        snapshotId: z.string().min(1).describe("Exact committed snapshot id. The snapshot must be complete and freshly probed as current."),
        mode: z.enum(["retrieve", "operation"]),
        filters: filters.optional().describe("Bounded retrieve filters. Filtresiz whole-snapshot dumps are guarded."),
        includeEdges: z.boolean().optional().describe("Include stored topology edges in retrieve mode. Defaults false."),
        relationTypes: z.array(z.string().min(1)).max(20).optional(),
        limit: z.number().int().positive().max(1000).optional(),
        edgeLimit: z.number().int().positive().max(2000).optional(),
        cursor: z.string().min(1).optional().describe("Opaque process-session cursor returned by a prior matching retrieve call."),
        operation: operation.optional(),
        timeoutMs: z.number().int().min(2000).max(MAX_SPATIAL_CONTEXT_TIMEOUT_MS).optional(),
    }, async (args = {}) => {
        try {
            if (args.mode === "operation" && !args.operation) {
                return formatJsonContent({
                    success: true,
                    guarded: true,
                    state: "guarded",
                    action: "query_spatial_context",
                    reason: "invalid_operation",
                    message: "mode=operation requires one explicit deterministic operation payload.",
                    partial: false,
                    truncated: false,
                    scanStoppedReason: "needs_scope",
                    scanPolicy: {},
                    suggestedNextScopes: ["operation"],
                    warnings: [],
                    notices: ["No Revit command was sent."],
                    nextCursor: null,
                    counts: { nodeCount: 0, edgeCount: 0, computedCount: 0 },
                    elapsedMs: 0,
                });
            }
            const store = getSpatialStore();
            const trust = await probeSnapshotTrust(store, String(args.snapshotId), args, "query_spatial_context");
            const trustEvidence = {
                liveness: trust.liveness,
                evaluatedAt: trust.evaluatedAt,
                warnings: trust.warnings,
            };
            const input = args.mode === "retrieve"
                ? {
                    snapshotId: String(args.snapshotId),
                    mode: "retrieve",
                    requireCurrent: true,
                    trust: trustEvidence,
                    filters: args.filters,
                    includeEdges: args.includeEdges,
                    relationTypes: args.relationTypes,
                    limit: args.limit,
                    edgeLimit: args.edgeLimit,
                    cursor: args.cursor,
                }
                : {
                    snapshotId: String(args.snapshotId),
                    mode: "operation",
                    requireCurrent: true,
                    trust: trustEvidence,
                    operation: args.operation,
                };
            return formatJsonContent(querySpatialContext(store, input));
        }
        catch (error) {
            if (error instanceof SpatialStoreCapabilityError) {
                return formatJsonContent({
                    success: true,
                    guarded: true,
                    state: "guarded",
                    action: "query_spatial_context",
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
                    counts: { nodeCount: 0, edgeCount: 0, computedCount: 0 },
                    elapsedMs: 0,
                });
            }
            return formatJsonContent(spatialToolFailure("query_spatial_context", error));
        }
    });
}
