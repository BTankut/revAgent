import { SpatialStore, } from "./spatialStore.js";
class SpatialStoreCliUsageError extends Error {
    constructor(message) {
        super(message);
        this.name = "SpatialStoreCliUsageError";
    }
}
function requireOptionValue(args, index, option) {
    const value = args[index + 1];
    if (typeof value !== "string" || value.trim().length === 0 || value.startsWith("--")) {
        throw new SpatialStoreCliUsageError(`${option} requires one non-empty value.`);
    }
    return value.trim();
}
function parseSpatialStoreCliArgs(args) {
    const command = args[0];
    if (command !== "preview" && command !== "purge") {
        throw new SpatialStoreCliUsageError("Expected command preview or purge.");
    }
    let all = false;
    let documentKey = null;
    const snapshotIds = [];
    let confirm = false;
    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--all") {
            if (all)
                throw new SpatialStoreCliUsageError("--all may be specified only once.");
            all = true;
            continue;
        }
        if (arg === "--confirm") {
            if (confirm)
                throw new SpatialStoreCliUsageError("--confirm may be specified only once.");
            confirm = true;
            continue;
        }
        if (arg === "--document-key") {
            if (documentKey !== null) {
                throw new SpatialStoreCliUsageError("--document-key may be specified only once.");
            }
            documentKey = requireOptionValue(args, index, arg);
            index += 1;
            continue;
        }
        if (arg === "--snapshot-id") {
            snapshotIds.push(requireOptionValue(args, index, arg));
            index += 1;
            continue;
        }
        throw new SpatialStoreCliUsageError(`Unknown spatial-store argument: ${arg}`);
    }
    if (command === "preview" && confirm) {
        throw new SpatialStoreCliUsageError("--confirm is valid only with purge.");
    }
    const selectorCount = Number(all) + Number(documentKey !== null) + Number(snapshotIds.length > 0);
    if (selectorCount !== 1) {
        throw new SpatialStoreCliUsageError("Exactly one selector is required: --all, --document-key <key>, or one or more --snapshot-id <id>.");
    }
    if (all) {
        return {
            command,
            selector: { all: true },
            selectorSummary: { kind: "all" },
            confirm,
        };
    }
    if (documentKey !== null) {
        return {
            command,
            selector: { documentKey },
            selectorSummary: { kind: "document_key", documentKey },
            confirm,
        };
    }
    const uniqueSnapshotIds = [...new Set(snapshotIds)];
    return {
        command,
        selector: { snapshotIds: uniqueSnapshotIds },
        selectorSummary: { kind: "snapshot_ids", snapshotIds: uniqueSnapshotIds },
        confirm,
    };
}
function emitJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function previewResult(parsed, preview) {
    return {
        contractVersion: "spatial-store-cli.v1",
        success: true,
        guarded: false,
        state: "completed",
        action: "spatial_store_preview",
        mutated: false,
        selector: parsed.selectorSummary,
        preview,
    };
}
export function runSpatialStoreCli(args, output = emitJson, dependencies = {}) {
    let store = null;
    try {
        const parsed = parseSpatialStoreCliArgs(args);
        store = dependencies.createStore?.() ?? new SpatialStore({
            retentionPolicy: false,
            cleanupExpiredStagingOnOpen: false,
        });
        const preview = store.previewPurge(parsed.selector);
        if (parsed.command === "preview") {
            output(previewResult(parsed, preview));
            return 0;
        }
        if (!parsed.confirm) {
            output({
                contractVersion: "spatial-store-cli.v1",
                success: true,
                guarded: true,
                state: "guarded",
                action: "spatial_store_purge",
                reason: "confirmation_required",
                message: "No data was changed. Re-run the same explicit selector with --confirm to purge.",
                mutated: false,
                selector: parsed.selectorSummary,
                preview,
            });
            return 2;
        }
        const purge = store.purge(parsed.selector);
        if (purge.artifactWarnings.length > 0) {
            output({
                contractVersion: "spatial-store-cli.v1",
                success: false,
                guarded: false,
                state: "failed",
                action: "spatial_store_purge",
                reason: "purge_cleanup_incomplete",
                message: "Database rows were purged, but one or more artifact or recovery-backup cleanup steps did not complete.",
                mutated: purge.purgedSnapshotCount > 0 || purge.purgedStagingCaptureCount > 0,
                partial: true,
                selector: parsed.selectorSummary,
                previewBefore: preview,
                purge,
            });
            return 3;
        }
        output({
            contractVersion: "spatial-store-cli.v1",
            success: true,
            guarded: false,
            state: "completed",
            action: "spatial_store_purge",
            mutated: purge.purgedSnapshotCount > 0 || purge.purgedStagingCaptureCount > 0,
            partial: false,
            selector: parsed.selectorSummary,
            previewBefore: preview,
            purge,
        });
        return 0;
    }
    catch (error) {
        const usageError = error instanceof SpatialStoreCliUsageError;
        output({
            contractVersion: "spatial-store-cli.v1",
            success: false,
            guarded: false,
            state: "failed",
            action: "spatial_store_maintenance",
            reason: usageError ? "invalid_arguments" : "spatial_store_unavailable",
            message: error instanceof Error ? error.message : String(error),
            mutated: false,
        });
        return usageError ? 2 : 1;
    }
    finally {
        try {
            store?.close();
        }
        catch {
        }
    }
}
