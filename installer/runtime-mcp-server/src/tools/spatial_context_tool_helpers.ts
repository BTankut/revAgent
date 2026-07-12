import {
    probeStoredSpatialSnapshotLiveness,
    type SpatialCaptureLivenessResult,
} from "../spatial/spatialCapture.js";
import type { SpatialStore } from "../spatial/spatialStore.js";
import {
    executionOptionsFromArgs,
    sendRevitCommand,
} from "../utils/revitToolHelpers.js";

type JsonObject = Record<string, any>;

export const DEFAULT_SPATIAL_CONTEXT_TIMEOUT_MS = 10_000;
export const MAX_SPATIAL_CONTEXT_TIMEOUT_MS = 30_000;

function clampTimeout(value: unknown): number {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_SPATIAL_CONTEXT_TIMEOUT_MS;
    }
    return Math.max(2_000, Math.min(MAX_SPATIAL_CONTEXT_TIMEOUT_MS, parsed));
}

export async function probeSnapshotTrust(
    store: SpatialStore,
    snapshotId: string,
    args: JsonObject,
    toolName: string,
): Promise<SpatialCaptureLivenessResult> {
    const timeoutMs = clampTimeout(args.timeoutMs);
    return await probeStoredSpatialSnapshotLiveness(
        store,
        snapshotId,
        async (sourceRevisions) => {
            const rawRevisions = sourceRevisions.map((source) => source.metadata || source);
            const response = await sendRevitCommand("get_spatial_change_state", {
                sourceRevisions: rawRevisions,
                expectedTrackerSessionId: sourceRevisions.find((source) => source.trackerSessionId)?.trackerSessionId,
                timeoutMs,
                suppressTaskStatusWindow: true,
                taskName: "Read spatial change state",
            }, {
                ...executionOptionsFromArgs({
                    target: args.target,
                    host: args.host,
                    port: args.port,
                    timeoutMs,
                    taskName: "Read spatial change state",
                }, "Read spatial change state"),
                toolName,
                timeoutMs,
                // Keep SocketClient's command preflight, but avoid overlapping the
                // next bounded spatial operation with a second background status read.
                refreshStatusAfterCommand: false,
            });
            return response && response.result ? response.result : response;
        },
    );
}

export function spatialToolFailure(action: string, error: unknown) {
    return {
        success: false,
        guarded: false,
        state: "failed",
        action,
        reason: "read_failed",
        error: error instanceof Error ? error.message : String(error),
        partial: false,
        truncated: false,
        scanStoppedReason: "read_failed",
        scanPolicy: {},
        suggestedNextScopes: [],
        warnings: [],
        notices: [],
        nextCursor: null,
        counts: {},
        elapsedMs: 0,
    };
}
