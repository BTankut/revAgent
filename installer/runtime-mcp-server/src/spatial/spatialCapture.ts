import { normalizeSpatialPage } from "./spatialPage.js";
import { validateSpatialWorkContinuationContract } from "./spatialPageSchema.js";
import {
    type SpatialAabb,
    type SpatialNodeRecord,
    type SpatialOmissionRecord,
    type SpatialSourceRevisionRecord,
    type SpatialStore,
} from "./spatialStore.js";

type JsonObject = Record<string, any>;

export const PHASE1A_SPATIAL_SCHEMA_VERSION = "0.2";
export const DEFAULT_SPATIAL_CAPTURE_MAX_ELAPSED_MS = 45_000;
export const MAX_SPATIAL_CAPTURE_MAX_ELAPSED_MS = 120_000;
export const SPATIAL_CAPTURE_MAX_RETRIES = 2;
export const SPATIAL_CAPTURE_MAX_PAGES = 10_000;
export const SPATIAL_CAPTURE_MAX_WORK_STEPS = 10_000;

const spatialWorkPhaseRank: Readonly<Record<string, number>> = {
    discover: 0,
    filter: 1,
    extract: 2,
    finalize: 3,
};

export interface SpatialCaptureLivenessResult {
    liveness: "current" | "stale" | "unknown";
    unknownReasons?: readonly string[];
    staleSourceKeys?: readonly string[];
    warnings?: readonly string[];
    evaluatedAt?: string;
}

export interface AtomicSpatialCaptureDependencies {
    store: SpatialStore;
    sendPage: (params: JsonObject) => Promise<unknown>;
    probeLiveness?: (sourceRevisions: readonly SpatialSourceRevisionRecord[]) => Promise<unknown>;
    now?: () => number;
    maxRetries?: number;
    maxPages?: number;
    maxWorkSteps?: number;
    normalizePage?: typeof normalizeSpatialPage;
}

export interface AtomicSpatialCaptureInput {
    nativeParams: JsonObject;
    scanPolicy: JsonObject;
    maxCaptureElapsedMs?: number;
}

function isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readField(value: unknown, ...names: string[]): any {
    if (!isObject(value)) {
        return undefined;
    }
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(value, name)) {
            return value[name];
        }
    }
    for (const [key, item] of Object.entries(value)) {
        if (names.some((name) => key.toLowerCase() === name.toLowerCase())) {
            return item;
        }
    }
    return undefined;
}

function text(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown) {
    if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        const parsed = Number.parseInt(value, 10);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}

function finiteNumber(value: unknown) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    const source = value as JsonObject;
    return `{${Object.keys(source)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
        .join(",")}}`;
}

function parseCapturedAt(value: unknown, fallbackMs: number) {
    const parsed = Date.parse(text(value));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

function tuple3(value: unknown): [number, number, number] | null {
    if (!Array.isArray(value) || value.length !== 3) {
        return null;
    }
    const parsed = value.map(finiteNumber);
    return parsed.every((item) => item !== null)
        ? [parsed[0]!, parsed[1]!, parsed[2]!]
        : null;
}

function readAabb(node: JsonObject): SpatialAabb | null {
    const geometry = readField(node, "geometry");
    const aabb = readField(geometry, "aabb");
    const minMm = tuple3(readField(aabb, "min", "minMm"));
    const maxMm = tuple3(readField(aabb, "max", "maxMm"));
    if (!minMm || !maxMm || minMm.some((value, index) => value > maxMm[index])) {
        return null;
    }
    return { minMm, maxMm };
}

function mapNode(value: unknown): SpatialNodeRecord {
    const node = isObject(value) ? value : {};
    const nodeRef = isObject(readField(node, "nodeRef")) ? readField(node, "nodeRef") as JsonObject : node;
    const elementRef = isObject(readField(node, "elementRef"))
        ? readField(node, "elementRef") as JsonObject
        : isObject(readField(nodeRef, "elementRef"))
            ? readField(nodeRef, "elementRef") as JsonObject
            : {};
    const sourceRefs = Array.isArray(readField(node, "sourceRefs"))
        ? readField(node, "sourceRefs")
        : readField(nodeRef, "sourceRefs");
    const firstSource = Array.isArray(sourceRefs) && isObject(sourceRefs[0]) ? sourceRefs[0] : {};
    const documentKey = text(readField(elementRef, "documentKey")) || text(readField(firstSource, "documentKey"));
    return {
        nodeId: text(readField(node, "nodeId")) || text(readField(nodeRef, "nodeId")),
        documentKey,
        nodeKind: text(readField(node, "nodeKind")) || text(readField(nodeRef, "nodeKind")),
        elementUniqueId: text(readField(elementRef, "elementUniqueId")) || null,
        linkInstanceUniqueId: text(readField(elementRef, "linkInstanceUniqueId"))
            || text(readField(firstSource, "linkInstanceUniqueId"))
            || null,
        aabb: readAabb(node),
        payload: node,
    };
}

function mapOmission(value: unknown): SpatialOmissionRecord {
    const omission = isObject(value) ? value : {};
    const elementRef = readField(omission, "elementRef");
    const sessionEvidence = readField(omission, "sessionEvidence");
    const identity = isObject(elementRef) ? elementRef : isObject(sessionEvidence) ? sessionEvidence : {};
    return {
        documentKey: text(readField(omission, "documentKey")) || text(readField(identity, "documentKey")) || "unknown",
        reason: text(readField(omission, "classification", "reason")) || "unclassified",
        sourceIdentity: text(readField(identity, "elementUniqueId"))
            || text(readField(omission, "linkInstanceUniqueId"))
            || null,
        payload: omission,
    };
}

function mapSourceRevision(value: unknown): SpatialSourceRevisionRecord {
    const source = isObject(value) ? value : {};
    return {
        documentKey: text(readField(source, "documentKey")),
        documentSessionId: text(readField(source, "documentSessionId")),
        trackerSessionId: text(readField(source, "trackerSessionId")) || null,
        loadedVersion: text(readField(source, "loadedVersion")),
        changeSequence: integer(readField(source, "changeSequence")) ?? 0,
        changeSequenceState: text(readField(source, "changeSequenceState")) || null,
        oldestRetainedSequence: integer(readField(source, "oldestRetainedSequence")),
        journalEntryCount: integer(readField(source, "journalEntryCount")),
        journalCapacity: integer(readField(source, "journalCapacity")),
        journalTruncated: readField(source, "journalTruncated") === true,
        linkInstanceUniqueId: text(readField(source, "linkInstanceUniqueId")) || null,
        sourceToHostTransform: readField(source, "sourceToHostTransform"),
        documentKeyResolution: readField(source, "documentKeyResolution"),
        externalLinkUpdateAvailable: readField(source, "externalLinkUpdateAvailable") === true,
        metadata: source,
    };
}

function retryableInterruption(payload: JsonObject) {
    const reason = text(readField(payload, "reason"));
    return reason === "capture_interrupted_by_change"
        || reason === "cursor_revision_mismatch"
        || reason === "expired_capture_session"
        || reason === "capture_session_expired";
}

function isSpatialWorkContinuationCandidate(payload: unknown) {
    return text(readField(payload, "continuationKind")) === "work"
        || text(readField(payload, "state")) === "in_progress";
}

function workCaptureInvariant(payload: JsonObject) {
    return {
        captureId: text(payload.captureId),
        snapshotId: text(payload.snapshotId),
        capturedAt: text(payload.capturedAt),
        schemaVersion: text(payload.schemaVersion),
        extractorVersion: text(payload.extractorVersion),
        coordinateFrame: text(payload.coordinateFrame),
        lengthUnit: text(payload.lengthUnit),
        captureConsistency: text(payload.captureConsistency),
        revisionBasisCaveat: text(payload.revisionBasisCaveat),
        scopeFingerprint: text(payload.scopeFingerprint),
        sourceBindingFingerprint: text(payload.sourceBindingFingerprint),
        scope: payload.scope,
        effectiveSourcePolicy: payload.effectiveSourcePolicy,
        scanPolicy: payload.scanPolicy,
    };
}

function p95(values: readonly number[]) {
    if (values.length === 0) {
        return 0;
    }
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}

function performanceSummary(values: readonly number[]) {
    return {
        count: values.length,
        p95Ms: p95(values),
        maxMs: values.length > 0 ? Math.max(...values) : 0,
        totalMs: values.reduce((sum, value) => sum + value, 0),
    };
}

function unknownLiveness(reason: string, now: () => number): SpatialCaptureLivenessResult {
    return {
        liveness: "unknown",
        unknownReasons: [reason],
        staleSourceKeys: [],
        warnings: [],
        evaluatedAt: new Date(now()).toISOString(),
    };
}

function unwrapProbePayload(value: unknown): JsonObject {
    let current = isObject(value) ? value : {};
    for (let depth = 0; depth < 3; depth += 1) {
        if (readField(current, "success") !== undefined || !isObject(readField(current, "result"))) {
            break;
        }
        current = readField(current, "result") as JsonObject;
    }
    return current;
}

export function validateSpatialLivenessProbe(
    rawProbe: unknown,
    expectedSources: readonly SpatialSourceRevisionRecord[],
    now: () => number = Date.now,
): SpatialCaptureLivenessResult {
    if (expectedSources.length === 0) {
        return unknownLiveness("stored_source_revisions_missing", now);
    }
    if (expectedSources.some((source) => source.changeSequenceState !== "tracked" || !text(source.trackerSessionId))) {
        return unknownLiveness("stored_tracker_binding_incomplete", now);
    }
    const expectedTrackerSessions = new Set(expectedSources.map((source) => text(source.trackerSessionId)));
    if (expectedTrackerSessions.size !== 1) {
        return unknownLiveness("stored_tracker_binding_inconsistent", now);
    }

    const payload = unwrapProbePayload(rawProbe);
    if (readField(payload, "success") !== true
        || readField(payload, "guarded") === true
        || text(readField(payload, "state")).toLowerCase() !== "completed"
        || readField(payload, "trackerSubscribed") !== true
        || text(readField(payload, "trackerSessionId")) !== [...expectedTrackerSessions][0]) {
        return unknownLiveness("live_liveness_probe_failed", now);
    }
    const sourceStates = readField(payload, "sourceStates");
    if (!Array.isArray(sourceStates) || sourceStates.length !== expectedSources.length) {
        return unknownLiveness("live_liveness_probe_incomplete", now);
    }
    if (integer(readField(payload, "expectedSourceRevisionCount")) !== expectedSources.length) {
        return unknownLiveness("live_liveness_probe_incomplete", now);
    }

    const rowLiveness: Array<"current" | "stale" | "unknown"> = [];
    const unknownReasons: string[] = [];
    const staleSourceKeys: string[] = [];
    const seenOrdinals = new Set<number>();
    let externalLinkUpdateAvailableCount = 0;
    for (const rowValue of sourceStates) {
        const row = isObject(rowValue) ? rowValue : {};
        const ordinal = integer(readField(row, "inputOrdinal"));
        if (ordinal === null || ordinal < 0 || ordinal >= expectedSources.length || seenOrdinals.has(ordinal)) {
            return unknownLiveness("live_liveness_probe_incomplete", now);
        }
        seenOrdinals.add(ordinal);
        const expected = expectedSources[ordinal];
        const expectedPlacement = text(expected.linkInstanceUniqueId) || null;
        const receivedPlacement = text(readField(row, "linkInstanceUniqueId")) || null;
        if (text(readField(row, "documentKey")) !== expected.documentKey
            || receivedPlacement !== expectedPlacement) {
            return unknownLiveness("live_liveness_probe_source_mismatch", now);
        }
        const rawLiveness = text(readField(row, "liveness")).toLowerCase();
        const externalLinkUpdateAvailable = readField(row, "externalLinkUpdateAvailable");
        if (typeof externalLinkUpdateAvailable !== "boolean") {
            return unknownLiveness("live_liveness_probe_external_observation_incomplete", now);
        }
        if (externalLinkUpdateAvailable) {
            externalLinkUpdateAvailableCount += 1;
        }
        if (rawLiveness !== "current" && rawLiveness !== "stale" && rawLiveness !== "unknown") {
            return unknownLiveness("live_liveness_probe_invalid_state", now);
        }
        if ((rawLiveness === "current" || rawLiveness === "stale")
            && readField(row, "sourceResolved") !== true) {
            return unknownLiveness("live_liveness_probe_source_mismatch", now);
        }
        rowLiveness.push(rawLiveness);
        const sourceKey = `${expected.documentKey}::${expectedPlacement || "host"}`;
        if (rawLiveness === "unknown") {
            unknownReasons.push(text(readField(row, "reason")) || "unknown_source_state");
        } else if (rawLiveness === "stale") {
            staleSourceKeys.push(sourceKey);
        }
    }

    const aggregate: "current" | "stale" | "unknown" = rowLiveness.includes("unknown")
        ? "unknown"
        : rowLiveness.includes("stale")
            ? "stale"
            : "current";
    const declared = text(readField(payload, "liveness")).toLowerCase();
    const currentCount = rowLiveness.filter((value) => value === "current").length;
    const staleCount = rowLiveness.filter((value) => value === "stale").length;
    const unknownCount = rowLiveness.filter((value) => value === "unknown").length;
    const resolvedCount = sourceStates.filter((row) => isObject(row) && readField(row, "sourceResolved") === true).length;
    if (integer(readField(payload, "externalLinkUpdateAvailableCount")) !== externalLinkUpdateAvailableCount) {
        return unknownLiveness("live_liveness_probe_external_observation_mismatch", now);
    }
    if (declared !== aggregate
        || integer(readField(payload, "currentSourceCount")) !== currentCount
        || integer(readField(payload, "staleSourceCount")) !== staleCount
        || integer(readField(payload, "unknownSourceCount")) !== unknownCount
        || integer(readField(payload, "resolvedSourceCount")) !== resolvedCount) {
        return unknownLiveness("live_liveness_probe_aggregate_mismatch", now);
    }
    return {
        liveness: aggregate,
        unknownReasons: [...new Set(unknownReasons)],
        staleSourceKeys: [...new Set(staleSourceKeys)],
        warnings: externalLinkUpdateAvailableCount > 0
            ? ["external_link_update_available: Newer linked-model source data is available; currently loaded Revit geometry remains authoritative until reload."]
            : [],
        evaluatedAt: new Date(now()).toISOString(),
    };
}

export async function probeStoredSpatialSnapshotLiveness(
    store: Pick<SpatialStore, "getSnapshotSources">,
    snapshotId: string,
    probe?: (sources: readonly SpatialSourceRevisionRecord[]) => Promise<unknown>,
    now: () => number = Date.now,
): Promise<SpatialCaptureLivenessResult> {
    let sourceRevisions: SpatialSourceRevisionRecord[];
    try {
        sourceRevisions = store.getSnapshotSources(snapshotId);
    } catch {
        return unknownLiveness("stored_source_revisions_unreadable", now);
    }
    if (!probe) {
        return unknownLiveness("live_liveness_probe_not_configured", now);
    }
    try {
        const raw = await probe(sourceRevisions);
        return validateSpatialLivenessProbe(raw, sourceRevisions, now);
    } catch {
        return unknownLiveness("live_liveness_probe_failed", now);
    }
}

function nonNegativeCountMap(value: unknown): Record<string, number> | null {
    if (!isObject(value)) {
        return null;
    }
    const result: Record<string, number> = {};
    for (const [key, rawCount] of Object.entries(value)) {
        const count = integer(rawCount);
        if (!key.trim() || count === null || count < 1) {
            return null;
        }
        result[key] = count;
    }
    return result;
}

function countMapTotal(value: Readonly<Record<string, number>>) {
    return Object.values(value).reduce((sum, count) => sum + count, 0);
}

function resolveCommitEvidence(payload: JsonObject): {
    expectedNodeCount: number;
    expectedOmissionCount: number;
    expectedPayloadBytes: number;
    expectedNodesByKind: Record<string, number>;
} | null {
    const counts = isObject(payload.counts) ? payload.counts : {};
    const coverage = isObject(payload.coverage) ? payload.coverage : {};
    const nodesByKindValue = readField(counts, "nodesByKind");
    if (!isObject(nodesByKindValue)) return null;
    const expectedNodesByKind: Record<string, number> = {};
    for (const [nodeKind, countValue] of Object.entries(nodesByKindValue)) {
        const count = integer(countValue);
        if (!nodeKind.trim() || count === null || count < 0) return null;
        expectedNodesByKind[nodeKind] = count;
    }
    const totalNodes = integer(readField(counts, "totalNodes"));
    const extractedSupportedNodes = integer(readField(counts, "extractedSupportedNodes"));
    const omittedSupportedNodes = integer(readField(counts, "omittedSupportedNodes"));
    const expectedSupportedNodes = integer(readField(counts, "expectedSupportedNodes"));
    const sourceAvailabilityOmissions = integer(readField(coverage, "sourceAvailabilityOmissionCount"));
    const totalOrderedRows = integer(readField(coverage, "totalOrderedRowCount"));
    const classifiedOmissionCount = integer(readField(coverage, "classifiedOmissionCount"));
    const unmaterializedOmissionCount = integer(readField(coverage, "unmaterializedOmissionCount"));
    const totalPayloadBytes = integer(readField(payload, "payloadBytes"));
    const elementOmissionsByReason = nonNegativeCountMap(readField(counts, "omissionsByReason"));
    const connectorOmissionsByReason = nonNegativeCountMap(readField(counts, "connectorOmissionsByReason"));
    const coverageElementOmissions = nonNegativeCountMap(readField(coverage, "omittedByClassification"));
    const coverageConnectorOmissions = nonNegativeCountMap(readField(coverage, "connectorOmittedByClassification"));
    const unmaterializedOmissionsByClassification = nonNegativeCountMap(
        readField(coverage, "unmaterializedOmissionsByClassification"),
    );
    const coverageSourceOmissions = nonNegativeCountMap(readField(coverage, "sourceOmittedByClassification"));
    if ([totalNodes, extractedSupportedNodes, omittedSupportedNodes, expectedSupportedNodes,
        sourceAvailabilityOmissions, totalOrderedRows, classifiedOmissionCount,
        unmaterializedOmissionCount, totalPayloadBytes]
        .some((value) => value === null || value! < 0)) {
        return null;
    }
    if (!elementOmissionsByReason || !connectorOmissionsByReason
        || !coverageElementOmissions || !coverageConnectorOmissions
        || !unmaterializedOmissionsByClassification || !coverageSourceOmissions) {
        return null;
    }
    const supportedOmissionCount = countMapTotal(elementOmissionsByReason)
        + countMapTotal(connectorOmissionsByReason);
    const sourceOmissionCount = countMapTotal(coverageSourceOmissions);
    const actualRowOmissionCount = totalOrderedRows! - totalNodes!;
    if (actualRowOmissionCount < 0
        || extractedSupportedNodes !== totalNodes
        || expectedSupportedNodes !== extractedSupportedNodes! + omittedSupportedNodes!
        || unmaterializedOmissionCount! > omittedSupportedNodes!
        || countMapTotal(unmaterializedOmissionsByClassification) !== unmaterializedOmissionCount
        || omittedSupportedNodes! + sourceAvailabilityOmissions! - unmaterializedOmissionCount! !== actualRowOmissionCount
        || supportedOmissionCount !== omittedSupportedNodes
        || sourceOmissionCount !== sourceAvailabilityOmissions
        || classifiedOmissionCount !== omittedSupportedNodes! + sourceAvailabilityOmissions!
        || canonicalJson(elementOmissionsByReason) !== canonicalJson(coverageElementOmissions)
        || canonicalJson(connectorOmissionsByReason) !== canonicalJson(coverageConnectorOmissions)
        || Object.values(expectedNodesByKind).reduce((sum, count) => sum + count, 0) !== totalNodes) {
        return null;
    }
    return {
        expectedNodeCount: totalNodes!,
        expectedOmissionCount: actualRowOmissionCount,
        expectedPayloadBytes: totalPayloadBytes!,
        expectedNodesByKind,
    };
}

function contractFailure(message: string, details: unknown, scanPolicy: JsonObject, elapsedMs: number) {
    return {
        success: false,
        guarded: false,
        state: "failed",
        action: "capture_spatial_snapshot",
        reason: "invalid_spatial_page_contract",
        error: message,
        contractValidation: details,
        partial: false,
        scanStoppedReason: "read_failed",
        scanPolicy,
        suggestedNextScopes: ["levelIds", "levelNames"],
        warnings: [],
        notices: [],
        nextCursor: null,
        elapsedMs,
    };
}

function workContractFailure(message: string, details: unknown, scanPolicy: JsonObject, elapsedMs: number) {
    return {
        ...contractFailure(message, details, scanPolicy, elapsedMs),
        reason: "invalid_spatial_work_contract",
    };
}

export async function captureSpatialSnapshotAtomic(
    input: AtomicSpatialCaptureInput,
    dependencies: AtomicSpatialCaptureDependencies,
): Promise<JsonObject> {
    const now = dependencies.now ?? Date.now;
    const normalizePage = dependencies.normalizePage ?? normalizeSpatialPage;
    const maxRetries = Math.max(0, Math.min(2, dependencies.maxRetries ?? SPATIAL_CAPTURE_MAX_RETRIES));
    const maxPages = Math.max(1, Math.min(SPATIAL_CAPTURE_MAX_PAGES, dependencies.maxPages ?? SPATIAL_CAPTURE_MAX_PAGES));
    const maxWorkSteps = Math.max(
        1,
        Math.min(SPATIAL_CAPTURE_MAX_WORK_STEPS, dependencies.maxWorkSteps ?? SPATIAL_CAPTURE_MAX_WORK_STEPS),
    );
    const maxCaptureElapsedMs = Math.max(
        1_000,
        Math.min(MAX_SPATIAL_CAPTURE_MAX_ELAPSED_MS, input.maxCaptureElapsedMs ?? DEFAULT_SPATIAL_CAPTURE_MAX_ELAPSED_MS),
    );
    const overallStartedAt = now();
    try {
        dependencies.store.applyConfiguredRetention();
    } catch {
        // Retention is best-effort housekeeping before the new capture. It is
        // retried on a later startup/capture and cannot invalidate this attempt.
    }
    let lastInterruption: JsonObject | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const attemptStartedAt = now();
        let cursor: string | undefined;
        let captureId = "";
        let expected: JsonObject | null = null;
        let expectedWorkInvariant: JsonObject | null = null;
        let previousPageHash: string | null = null;
        let previousWorkCursor: string | null = null;
        let previousWorkPhase: string | null = null;
        let previousWorkProcessed: number | null = null;
        let previousWorkTotal: number | null = null;
        let expectedOrdinal = 0;
        let workStepCount = 0;
        let staged = false;
        let interruptedThisAttempt = false;
        const nodeIds = new Set<string>();
        const pageRoundTripsMs: number[] = [];
        const nativeUiOccupancyMs: number[] = [];
        const preparationRoundTripsMs: number[] = [];
        const preparationNativeUiOccupancyMs: number[] = [];
        const preparationPhases: string[] = [];

        try {
            for (let requestOrdinal = 0; requestOrdinal < maxPages + maxWorkSteps; requestOrdinal += 1) {
                if (expectedOrdinal >= maxPages) {
                    if (captureId && staged) dependencies.store.abandonCapture(captureId);
                    return contractFailure(
                        "Spatial capture exceeded the hard page-count bound.",
                        { maxPages },
                        input.scanPolicy,
                        now() - overallStartedAt,
                    );
                }
                if (now() - attemptStartedAt > maxCaptureElapsedMs) {
                    if (captureId) dependencies.store.abandonCapture(captureId);
                    return {
                        success: true,
                        guarded: true,
                        state: "guarded",
                        action: "capture_spatial_snapshot",
                        reason: "max_elapsed",
                        message: "Atomic spatial capture exceeded its total bounded capture time; staging was discarded.",
                        attempts: attempt + 1,
                        committed: false,
                        partial: false,
                        scanStoppedReason: "max_elapsed",
                        scanPolicy: { ...input.scanPolicy, maxCaptureElapsedMs },
                        suggestedNextScopes: ["narrow the explicit level/link/category scope"],
                        warnings: [],
                        notices: [],
                        elapsedMs: now() - overallStartedAt,
                    };
                }

                const pageStartedAt = now();
                const response = await dependencies.sendPage({
                    ...input.nativeParams,
                    cursor,
                });
                const pageRoundTripMs = Math.max(0, now() - pageStartedAt);
                const rawPayload = isObject(response) && isObject(response.result) ? response.result : response;

                if (isSpatialWorkContinuationCandidate(rawPayload)) {
                    const workValidation = validateSpatialWorkContinuationContract(rawPayload);
                    if (!workValidation.valid || !isObject(rawPayload)) {
                        if (captureId && staged) dependencies.store.abandonCapture(captureId);
                        return workContractFailure(
                            "The native extract_spatial_snapshot progress response did not satisfy the strict Phase 1a work-continuation contract.",
                            workValidation.errors,
                            input.scanPolicy,
                            now() - overallStartedAt,
                        );
                    }
                    if (staged || expectedOrdinal > 0) {
                        dependencies.store.abandonCapture(captureId);
                        return workContractFailure(
                            "Spatial preparation resumed after data-page staging had already started.",
                            { expectedOrdinal, workStepCount },
                            input.scanPolicy,
                            now() - overallStartedAt,
                        );
                    }

                    const preparation = rawPayload.preparation as JsonObject;
                    const workInvariant = workCaptureInvariant(rawPayload);
                    if (expectedWorkInvariant && canonicalJson(workInvariant) !== canonicalJson(expectedWorkInvariant)) {
                        return workContractFailure(
                            "Spatial preparation capture/scope/source-binding metadata changed inside one capture.",
                            {
                                expectedCaptureId: expectedWorkInvariant.captureId,
                                receivedCaptureId: workInvariant.captureId,
                                expectedSourceBindingFingerprint: expectedWorkInvariant.sourceBindingFingerprint,
                                receivedSourceBindingFingerprint: workInvariant.sourceBindingFingerprint,
                            },
                            input.scanPolicy,
                            now() - overallStartedAt,
                        );
                    }
                    expectedWorkInvariant = expectedWorkInvariant || workInvariant;
                    captureId = captureId || workInvariant.captureId;

                    const phase = text(preparation.phase);
                    const stepOrdinal = integer(preparation.stepOrdinal);
                    const processed = integer(preparation.processed);
                    const total = preparation.total === null ? null : integer(preparation.total);
                    const nextWorkCursor = text(preparation.nextCursor);
                    const phaseRank = spatialWorkPhaseRank[phase];
                    const previousPhaseRank = previousWorkPhase === null ? -1 : spatialWorkPhaseRank[previousWorkPhase];
                    const invalidStep = stepOrdinal !== workStepCount + 1;
                    const invalidPhase = phaseRank === undefined || previousPhaseRank === undefined || phaseRank < previousPhaseRank;
                    const invalidSamePhaseProgress = previousWorkPhase === phase
                        && (processed === null
                            || previousWorkProcessed === null
                            || processed < previousWorkProcessed
                            || total !== previousWorkTotal);
                    if (invalidStep || invalidPhase || invalidSamePhaseProgress || !nextWorkCursor || nextWorkCursor === previousWorkCursor) {
                        return workContractFailure(
                            "Spatial preparation cursor, phase, or progress monotonicity failed.",
                            {
                                expectedStepOrdinal: workStepCount + 1,
                                receivedStepOrdinal: stepOrdinal,
                                previousPhase: previousWorkPhase,
                                receivedPhase: phase,
                                previousProcessed: previousWorkProcessed,
                                receivedProcessed: processed,
                                previousTotal: previousWorkTotal,
                                receivedTotal: total,
                                cursorAdvanced: Boolean(nextWorkCursor && nextWorkCursor !== previousWorkCursor),
                            },
                            input.scanPolicy,
                            now() - overallStartedAt,
                        );
                    }

                    if (workStepCount >= maxWorkSteps) {
                        return workContractFailure(
                            "Spatial preparation exceeded the hard work-continuation bound.",
                            { maxWorkSteps },
                            input.scanPolicy,
                            now() - overallStartedAt,
                        );
                    }
                    workStepCount += 1;
                    preparationRoundTripsMs.push(pageRoundTripMs);
                    const preparationNativeElapsedMs = finiteNumber(rawPayload.elapsedMs);
                    if (preparationNativeElapsedMs !== null && preparationNativeElapsedMs >= 0) {
                        preparationNativeUiOccupancyMs.push(preparationNativeElapsedMs);
                    }
                    if (!preparationPhases.includes(phase)) {
                        preparationPhases.push(phase);
                    }
                    previousWorkCursor = nextWorkCursor;
                    previousWorkPhase = phase;
                    previousWorkProcessed = processed;
                    previousWorkTotal = total;
                    cursor = nextWorkCursor;
                    continue;
                }

                pageRoundTripsMs.push(pageRoundTripMs);
                const normalized = normalizePage(rawPayload, pageRoundTripMs);
                const payload = normalized.payload;
                const nativeElapsedMs = finiteNumber(readField(payload, "elapsedMs"));
                if (nativeElapsedMs !== null && nativeElapsedMs >= 0) {
                    nativeUiOccupancyMs.push(nativeElapsedMs);
                }

                if (payload.guarded === true) {
                    if (captureId) dependencies.store.abandonCapture(captureId);
                    if (retryableInterruption(payload)) {
                        lastInterruption = payload;
                        interruptedThisAttempt = true;
                        break;
                    }
                    return {
                        ...payload,
                        action: "capture_spatial_snapshot",
                        attempts: attempt + 1,
                        committed: false,
                        elapsedMs: now() - overallStartedAt,
                    };
                }
                if (!normalized.valid) {
                    if (captureId) dependencies.store.abandonCapture(captureId);
                    return contractFailure(
                        "The native extract_spatial_snapshot response did not satisfy the strict versioned extraction-page contract.",
                        payload.contractValidation || normalized.errors,
                        input.scanPolicy,
                        now() - overallStartedAt,
                    );
                }
                if (text(payload.schemaVersion) !== PHASE1A_SPATIAL_SCHEMA_VERSION) {
                    if (captureId) dependencies.store.abandonCapture(captureId);
                    return {
                        success: true,
                        guarded: true,
                        state: "guarded",
                        action: "capture_spatial_snapshot",
                        reason: "phase1a_native_contract_required",
                        message: "The connected Revit add-in exposes the Phase 0 transport contract. Install the matching Phase 1a DLL before durable capture.",
                        committed: false,
                        partial: false,
                        scanStoppedReason: "read_failed",
                        scanPolicy: input.scanPolicy,
                        suggestedNextScopes: [],
                        warnings: [],
                        notices: [],
                        elapsedMs: now() - overallStartedAt,
                    };
                }

                const page = isObject(payload.page) ? payload.page : {};
                const ordinal = integer(page.ordinal);
                const pageHash = text(page.pageSha256 || page.pageHash);
                const priorPageHash = text(page.priorPageSha256 || page.priorPageHash) || null;
                const receivedCaptureId = text(payload.captureId);
                const dataWorkInvariant = workCaptureInvariant(payload);
                if ((captureId && receivedCaptureId !== captureId)
                    || (expectedWorkInvariant && canonicalJson(dataWorkInvariant) !== canonicalJson(expectedWorkInvariant))) {
                    if (captureId && staged) dependencies.store.abandonCapture(captureId);
                    return workContractFailure(
                        "The first spatial data page did not preserve the prepared capture/source-binding invariant.",
                        {
                            expectedCaptureId: captureId || expectedWorkInvariant?.captureId || null,
                            receivedCaptureId,
                            expectedSourceBindingFingerprint: expectedWorkInvariant?.sourceBindingFingerprint || null,
                            receivedSourceBindingFingerprint: dataWorkInvariant.sourceBindingFingerprint,
                        },
                        input.scanPolicy,
                        now() - overallStartedAt,
                    );
                }
                captureId = captureId || receivedCaptureId;
                if (ordinal !== expectedOrdinal || priorPageHash !== previousPageHash) {
                    dependencies.store.abandonCapture(captureId);
                    return contractFailure("Spatial page order/hash continuity failed before staging commit.", {
                        expectedOrdinal,
                        ordinal,
                        expectedPriorPageHash: previousPageHash,
                        priorPageHash,
                    }, input.scanPolicy, now() - overallStartedAt);
                }

                const invariant = {
                    captureId: text(payload.captureId),
                    snapshotId: text(payload.snapshotId || payload.captureId),
                    capturedAt: text(payload.capturedAt),
                    schemaVersion: text(payload.schemaVersion),
                    extractorVersion: text(payload.extractorVersion),
                    coordinateFrame: text(payload.coordinateFrame),
                    lengthUnit: text(payload.lengthUnit),
                    captureConsistency: text(payload.captureConsistency),
                    scopeFingerprint: text(payload.scopeFingerprint),
                    sourceBindingFingerprint: text(payload.sourceBindingFingerprint),
                    revisionFingerprint: text(payload.revisionFingerprint),
                    scope: payload.scope,
                    effectiveSourcePolicy: payload.effectiveSourcePolicy,
                    sourceRevisions: payload.sourceRevisions,
                    counts: payload.counts,
                    pageCount: integer(payload.pageCount),
                    payloadBytes: integer(payload.payloadBytes),
                };
                if (expected && canonicalJson(invariant) !== canonicalJson(expected)) {
                    dependencies.store.abandonCapture(captureId);
                    return contractFailure("Spatial page revision/scope metadata changed inside one capture.", {
                        expectedFingerprint: expected.revisionFingerprint,
                        receivedFingerprint: invariant.revisionFingerprint,
                    }, input.scanPolicy, now() - overallStartedAt);
                }
                expected = expected || invariant;

                if (!staged) {
                    dependencies.store.beginCapture({
                        captureId,
                        snapshotId: invariant.snapshotId,
                        documentKey: text(readField(payload.scope, "hostDocumentKey")),
                        scopeFingerprint: invariant.scopeFingerprint,
                        revisionFingerprint: invariant.revisionFingerprint,
                        schemaVersion: invariant.schemaVersion,
                        extractorVersion: invariant.extractorVersion,
                        scope: payload.scope,
                        counts: payload.counts,
                        effectiveSourcePolicy: payload.effectiveSourcePolicy,
                        coverage: payload.coverage,
                        transformValidation: payload.transformValidation,
                        captureMetadata: {
                            coordinateFrame: payload.coordinateFrame,
                            lengthUnit: payload.lengthUnit,
                            captureConsistency: payload.captureConsistency,
                            sourceBindingFingerprint: invariant.sourceBindingFingerprint,
                        },
                        capturedAtMs: parseCapturedAt(payload.capturedAt, now()),
                    });
                    staged = true;
                }

                const nodes = (Array.isArray(payload.nodes) ? payload.nodes : []).map(mapNode);
                for (const node of nodes) {
                    if (!node.nodeId || !node.documentKey || !node.nodeKind || nodeIds.has(node.nodeId)) {
                        dependencies.store.abandonCapture(captureId);
                        return contractFailure("Spatial page contains a missing or duplicate composite node identity.", {
                            nodeId: node.nodeId || null,
                        }, input.scanPolicy, now() - overallStartedAt);
                    }
                    nodeIds.add(node.nodeId);
                }
                const omissions = (Array.isArray(payload.omissions) ? payload.omissions : []).map(mapOmission);
                dependencies.store.stagePage({
                    captureId,
                    ordinal,
                    priorPageHash,
                    pageHash,
                    hasMore: page.hasMore === true,
                    payloadBytes: integer(page.payloadBytes) ?? 0,
                    nodes,
                    omissions,
                });
                previousPageHash = pageHash;
                expectedOrdinal += 1;

                if (page.hasMore === true) {
                    cursor = text(page.nextCursor || payload.nextCursor);
                    if (!cursor) {
                        dependencies.store.abandonCapture(captureId);
                        return contractFailure("A paginated spatial page did not provide its opaque next cursor.", {}, input.scanPolicy, now() - overallStartedAt);
                    }
                    continue;
                }

                const declaredPageCount = integer(payload.pageCount);
                if (declaredPageCount !== expectedOrdinal) {
                    dependencies.store.abandonCapture(captureId);
                    return contractFailure("Final spatial page count does not match the staged chain.", {
                        declaredPageCount,
                        stagedPageCount: expectedOrdinal,
                    }, input.scanPolicy, now() - overallStartedAt);
                }
                const commitEvidence = resolveCommitEvidence(payload);
                if (!commitEvidence) {
                    dependencies.store.abandonCapture(captureId);
                    return contractFailure(
                        "Final spatial counts/coverage could not be reconciled into atomic commit expectations.",
                        { counts: payload.counts, coverage: payload.coverage, payloadBytes: payload.payloadBytes },
                        input.scanPolicy,
                        now() - overallStartedAt,
                    );
                }
                const sourceRevisions = (Array.isArray(payload.sourceRevisions) ? payload.sourceRevisions : []).map(mapSourceRevision);
                const summary = dependencies.store.commitCapture({
                    captureId,
                    sourceRevisions,
                    counts: payload.counts,
                    effectiveSourcePolicy: payload.effectiveSourcePolicy,
                    coverage: payload.coverage,
                    transformValidation: payload.transformValidation,
                    expectedPageCount: declaredPageCount,
                    expectedPayloadBytes: commitEvidence.expectedPayloadBytes,
                    expectedNodeCount: commitEvidence.expectedNodeCount,
                    expectedOmissionCount: commitEvidence.expectedOmissionCount,
                    expectedNodesByKind: commitEvidence.expectedNodesByKind,
                    partial: payload.partial === true,
                    coverageStatus: payload.coverageStatus || null,
                    scanStoppedReason: text(payload.scanStoppedReason) || "completed",
                    suggestedNextScopes: Array.isArray(payload.suggestedNextScopes) ? payload.suggestedNextScopes.map(String) : [],
                });

                const liveness = await probeStoredSpatialSnapshotLiveness(
                    dependencies.store,
                    summary.snapshotId,
                    dependencies.probeLiveness,
                    now,
                );

                const committedAt = new Date(summary.committedAtMs).toISOString();
                const snapshot = {
                    snapshotId: summary.snapshotId,
                    capturedAt: new Date(summary.capturedAtMs).toISOString(),
                    sourceRevisions: payload.sourceRevisions,
                    scope: payload.scope,
                    scopeFingerprint: summary.scopeFingerprint,
                    sourceBindingFingerprint: text(payload.sourceBindingFingerprint),
                    revisionFingerprint: summary.revisionFingerprint,
                    coordinateFrame: payload.coordinateFrame,
                    lengthUnit: payload.lengthUnit,
                    schemaVersion: summary.schemaVersion,
                    extractorVersion: summary.extractorVersion,
                    atomic: true,
                    liveness: liveness.liveness,
                    livenessBinding: {
                        basis: "document_change_sequence",
                        evaluatedAt: liveness.evaluatedAt || new Date(now()).toISOString(),
                        sourceCount: sourceRevisions.length,
                        unknownReasons: [...new Set(liveness.unknownReasons || [])],
                    },
                    committedAt,
                    counts: payload.counts,
                    partial: summary.partial,
                    coverageStatus: summary.coverageStatus,
                    scanStoppedReason: summary.scanStoppedReason,
                    suggestedNextScopes: Array.isArray(payload.suggestedNextScopes) ? payload.suggestedNextScopes : [],
                    pageCount: summary.pageCount,
                    payloadBytes: summary.payloadBytes,
                };
                return {
                    success: true,
                    guarded: false,
                    state: "completed",
                    action: "capture_spatial_snapshot",
                    message: summary.partial
                        ? "A revision-consistent partial spatial snapshot was atomically committed with explicit coverage limits."
                        : "A complete revision-consistent spatial snapshot was atomically committed to the durable local store.",
                    committed: true,
                    atomic: true,
                    liveness: liveness.liveness,
                    snapshot,
                    snapshotId: summary.snapshotId,
                    scopeFingerprint: summary.scopeFingerprint,
                    sourceBindingFingerprint: text(payload.sourceBindingFingerprint),
                    revisionFingerprint: summary.revisionFingerprint,
                    counts: {
                        ...payload.counts,
                        persistedNodes: summary.nodeCount,
                        persistedOmissions: summary.omissionCount,
                    },
                    coverage: payload.coverage,
                    transformValidation: payload.transformValidation,
                    pageCount: summary.pageCount,
                    payloadBytes: summary.payloadBytes,
                    partial: summary.partial,
                    coverageStatus: summary.coverageStatus,
                    scanStoppedReason: summary.scanStoppedReason,
                    scanPolicy: { ...input.scanPolicy, maxCaptureElapsedMs, maxRetries, maxWorkSteps },
                    suggestedNextScopes: snapshot.suggestedNextScopes,
                    attempts: attempt + 1,
                    pagePerformance: {
                        roundTrip: performanceSummary(pageRoundTripsMs),
                        nativeUiOccupancy: {
                            ...performanceSummary(nativeUiOccupancyMs),
                            p95Within2000Ms: nativeUiOccupancyMs.length > 0 && p95(nativeUiOccupancyMs) <= 2_000,
                            maxWithin5000Ms: nativeUiOccupancyMs.length > 0 && Math.max(...nativeUiOccupancyMs) <= 5_000,
                        },
                    },
                    preparationPerformance: {
                        continuationCount: workStepCount,
                        phases: preparationPhases,
                        lastStepOrdinal: workStepCount > 0 ? workStepCount : null,
                        lastPhase: previousWorkPhase,
                        lastProcessed: previousWorkProcessed,
                        lastTotal: previousWorkTotal,
                        roundTrip: performanceSummary(preparationRoundTripsMs),
                        nativeUiOccupancy: {
                            ...performanceSummary(preparationNativeUiOccupancyMs),
                            p95Within2000Ms: preparationNativeUiOccupancyMs.length > 0
                                && p95(preparationNativeUiOccupancyMs) <= 2_000,
                            maxWithin5000Ms: preparationNativeUiOccupancyMs.length > 0
                                && Math.max(...preparationNativeUiOccupancyMs) <= 5_000,
                        },
                    },
                    warnings: [...new Set([
                        ...(Array.isArray(payload.warnings) ? payload.warnings.map(String) : []),
                        ...(liveness.warnings || []),
                    ])],
                    notices: Array.isArray(payload.notices) ? payload.notices : [],
                    nextCursor: null,
                    elapsedMs: now() - overallStartedAt,
                };
            }

            if (interruptedThisAttempt) {
                if (attempt < maxRetries) {
                    continue;
                }
                break;
            }
            if (captureId) dependencies.store.abandonCapture(captureId);
            return contractFailure("Spatial capture exceeded the hard page-count bound.", { maxPages }, input.scanPolicy, now() - overallStartedAt);
        } catch (error) {
            if (captureId && staged) {
                try {
                    dependencies.store.abandonCapture(captureId);
                } catch {
                    // Preserve the original failure; startup lease cleanup is the fallback.
                }
            }
            return {
                success: false,
                guarded: false,
                state: "failed",
                action: "capture_spatial_snapshot",
                reason: "read_failed",
                error: error instanceof Error ? error.message : String(error),
                committed: false,
                partial: false,
                scanStoppedReason: "read_failed",
                scanPolicy: input.scanPolicy,
                suggestedNextScopes: ["levelIds", "levelNames"],
                warnings: [],
                notices: [],
                nextCursor: null,
                elapsedMs: now() - overallStartedAt,
            };
        }
    }

    return {
        success: true,
        guarded: true,
        state: "guarded",
        action: "capture_spatial_snapshot",
        reason: "capture_interrupted_by_change",
        message: "The model revision changed during all three bounded capture attempts; no mixed-revision snapshot was committed.",
        attempts: maxRetries + 1,
        committed: false,
        partial: false,
        scanStoppedReason: "read_failed",
        scanPolicy: input.scanPolicy,
        suggestedNextScopes: ["wait for model edits to settle, then recapture the same explicit scope"],
        warnings: [],
        notices: [],
        nextCursor: null,
        elapsedMs: now() - overallStartedAt,
    };
}
