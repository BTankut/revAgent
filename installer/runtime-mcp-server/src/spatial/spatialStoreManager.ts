import {
    SpatialRTreeUnavailableError,
    SpatialStore,
    SpatialStorePathError,
    type SpatialStoreSchemaVersion,
} from "./spatialStore.js";

export interface SpatialStoreCapability {
    available: boolean;
    state: "ready" | "guarded" | "not_initialized";
    reason: string | null;
    schemaVersion: SpatialStoreSchemaVersion | null;
    rtreeAvailable: boolean;
}

export class SpatialStoreCapabilityError extends Error {
    public readonly reason: string;

    public constructor(reason: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SpatialStoreCapabilityError";
        this.reason = reason;
    }
}

let store: SpatialStore | null = null;
let capability: SpatialStoreCapability = {
    available: false,
    state: "not_initialized",
    reason: null,
    schemaVersion: null,
    rtreeAvailable: false,
};
let shutdownHookRegistered = false;

function guardedReason(error: unknown) {
    if (error instanceof SpatialRTreeUnavailableError) {
        return "spatial_rtree_unavailable";
    }
    if (error instanceof SpatialStorePathError) {
        return error.reason === "network_path"
            ? "spatial_store_network_path_rejected"
            : error.reason === "managed_package_path"
                ? "spatial_store_managed_path_rejected"
                : "spatial_store_artifact_path_rejected";
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/better_sqlite3|bindings file|native module/i.test(message)) {
        return "spatial_sqlite_native_binding_unavailable";
    }
    if (/migration/i.test(message)) {
        return "spatial_store_migration_failed";
    }
    if (/integrity|quick_check|malformed|corrupt/i.test(message)) {
        return "spatial_store_recovery_failed";
    }
    return "spatial_store_unavailable";
}

function closeStore() {
    try {
        store?.close();
    } catch {
        // Process shutdown is best-effort. WAL recovery runs on next startup.
    }
    store = null;
}

export function initializeSpatialStore(): SpatialStoreCapability {
    if (capability.state !== "not_initialized") {
        return { ...capability };
    }
    try {
        store = new SpatialStore();
        const schemaVersion = store.getSchemaVersion();
        const rtreeAvailable = store.isRTreeAvailable();
        capability = {
            available: true,
            state: "ready",
            reason: null,
            schemaVersion,
            rtreeAvailable,
        };
        if (!shutdownHookRegistered) {
            process.once("exit", closeStore);
            shutdownHookRegistered = true;
        }
    } catch (error) {
        closeStore();
        capability = {
            available: false,
            state: "guarded",
            reason: guardedReason(error),
            schemaVersion: null,
            rtreeAvailable: false,
        };
    }
    return { ...capability };
}

export function getSpatialStoreCapability(): SpatialStoreCapability {
    return capability.state === "not_initialized" ? initializeSpatialStore() : { ...capability };
}

export function getSpatialStore(): SpatialStore {
    const current = getSpatialStoreCapability();
    if (!current.available || !store) {
        throw new SpatialStoreCapabilityError(
            current.reason || "spatial_store_unavailable",
            "The durable spatial store is unavailable. Capture was guarded before any snapshot became visible.",
        );
    }
    return store;
}
