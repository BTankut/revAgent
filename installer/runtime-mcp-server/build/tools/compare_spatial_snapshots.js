import { z } from "zod";
import { compareSpatialSnapshots } from "../spatial/spatialDiff.js";
import { getSpatialStore, SpatialStoreCapabilityError, } from "../spatial/spatialStoreManager.js";
import { formatJsonContent, taskMetadataSchema } from "../utils/revitToolHelpers.js";
import { spatialToolFailure } from "./spatial_context_tool_helpers.js";
export function registerCompareSpatialSnapshotsTool(server) {
    server.tool("compare_spatial_snapshots", "[SPATIAL_DIFF_READ_ONLY] Deterministically compare two explicit immutable complete snapshots with compatible scopes. Classifies added/removed elements, source availability, transforms/movement, geometry, properties, connectors, connectivity, and affected-neighborhood proximity changes. Stale or unknown snapshots remain valid historical inputs; the result cites both snapshot and revision ids and never claims current state. Partial snapshots and incompatible scopes fail closed. This tool never writes Revit.", {
        ...taskMetadataSchema(z),
        baseSnapshotId: z.string().min(1),
        headSnapshotId: z.string().min(1),
        allowLegacyV02: z.boolean().optional().describe("Allow an explicitly capability-limited historical comparison when both snapshots are legacy v0.2. Mixed v0.2/v0.3 comparisons remain unsupported because their fingerprint algorithms are not comparable."),
        maxChanges: z.number().int().positive().max(50_000).optional(),
        proximityRadiusMm: z.number().finite().nonnegative().max(10_000).optional(),
        maxProximityPairs: z.number().int().positive().max(100_000).optional(),
    }, async (args = {}) => {
        try {
            const store = getSpatialStore();
            const input = {
                baseSnapshotId: String(args.baseSnapshotId),
                headSnapshotId: String(args.headSnapshotId),
                allowLegacyV02: args.allowLegacyV02,
                maxChanges: args.maxChanges,
                proximityRadiusMm: args.proximityRadiusMm,
                maxProximityPairs: args.maxProximityPairs,
            };
            return formatJsonContent(compareSpatialSnapshots(store, input));
        }
        catch (error) {
            if (error instanceof SpatialStoreCapabilityError) {
                return formatJsonContent({
                    success: true,
                    guarded: true,
                    state: "guarded",
                    action: "compare_spatial_snapshots",
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
                    counts: { totalChangeCount: 0 },
                    elapsedMs: 0,
                });
            }
            return formatJsonContent(spatialToolFailure("compare_spatial_snapshots", error));
        }
    });
}
