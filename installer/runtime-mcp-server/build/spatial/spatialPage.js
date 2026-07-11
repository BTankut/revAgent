import { validateSpatialExtractionPageContract } from "./spatialPageSchema.js";
export const SPATIAL_SNAPSHOT_SCHEMA_VERSION = "0.1";
export const SPATIAL_COORDINATE_FRAME = "host_internal_mm";
export const SPATIAL_PAGE_CONTRACT_VERSION = "spatial-extraction-page.v0.1";
const canonicalStopReasons = new Set([
    "completed",
    "max_elapsed",
    "max_items",
    "max_bytes",
    "read_failed",
    "needs_scope",
]);
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function readField(value, ...names) {
    if (!isObject(value)) {
        return undefined;
    }
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(value, name)) {
            return value[name];
        }
    }
    const entries = Object.entries(value);
    for (const name of names) {
        const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
        if (match) {
            return match[1];
        }
    }
    return undefined;
}
function finiteInteger(value) {
    if (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        const parsed = Number.parseInt(value, 10);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}
function finiteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function cleanStrings(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0);
}
function normalizeStopReason(value, hasMore, success) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (canonicalStopReasons.has(raw)) {
        return raw;
    }
    if (!success) {
        return "read_failed";
    }
    return hasMore ? "max_items" : "completed";
}
function isSha256(value) {
    return typeof value === "string" && /^sha256:[a-f0-9]{64}$/i.test(value);
}
function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
export function normalizeSpatialPage(payload, elapsedMs) {
    const source = isObject(payload) ? payload : {};
    const rawPage = readField(source, "page");
    const page = isObject(rawPage) ? rawPage : {};
    const nodesValue = readField(source, "nodes");
    const omissionsValue = readField(source, "omissions");
    const nodes = Array.isArray(nodesValue) ? nodesValue : [];
    const omissions = Array.isArray(omissionsValue) ? omissionsValue : [];
    const rawSuccess = readField(source, "success");
    const success = typeof rawSuccess === "boolean" ? rawSuccess : true;
    const guarded = readField(source, "guarded") === true;
    const state = String(readField(source, "state") || (guarded ? "guarded" : success ? "completed" : "failed"));
    const nextCursorValue = readField(source, "nextCursor") ?? readField(page, "nextCursor");
    const nextCursor = typeof nextCursorValue === "string" && nextCursorValue.length > 0
        ? nextCursorValue
        : null;
    const rawHasMore = readField(page, "hasMore");
    const hasMore = typeof rawHasMore === "boolean" ? rawHasMore : nextCursor !== null;
    const pageOrdinal = finiteInteger(readField(page, "ordinal", "pageOrdinal") ?? readField(source, "pageOrdinal"));
    const targetBytes = finiteInteger(readField(page, "targetBytes"));
    const pagePayloadBytes = finiteInteger(readField(page, "payloadBytes"));
    const logicalPayloadBytes = finiteInteger(readField(source, "payloadBytes"));
    const legacyRecordCount = finiteInteger(readField(page, "recordCount"));
    const omissionCount = finiteInteger(readField(page, "omissionCount"));
    const nodeCount = finiteInteger(readField(page, "nodeCount")) ?? legacyRecordCount ?? nodes.length;
    const rowCount = finiteInteger(readField(page, "rowCount")) ?? nodeCount + (omissionCount ?? omissions.length);
    const pageHash = readField(page, "pageSha256", "pageHash") ?? readField(source, "pageHash");
    const priorPageHashValue = readField(page, "priorPageSha256", "priorPageHash") ?? readField(source, "priorPageHash");
    const priorPageHash = typeof priorPageHashValue === "string" && priorPageHashValue.trim().length > 0
        ? priorPageHashValue
        : null;
    const partialValue = readField(source, "partial");
    const partial = typeof partialValue === "boolean" ? partialValue : hasMore;
    const scanStoppedReason = normalizeStopReason(readField(source, "scanStoppedReason"), hasMore, success);
    const normalizedElapsedMs = finiteNumber(readField(source, "elapsedMs")) ?? finiteNumber(elapsedMs);
    const suggestedNextScopes = cleanStrings(readField(source, "suggestedNextScopes"));
    if (hasMore && !suggestedNextScopes.includes("cursor")) {
        suggestedNextScopes.push("cursor");
    }
    const normalizedPage = {
        ...page,
        ordinal: pageOrdinal,
        targetBytes,
        payloadBytes: pagePayloadBytes,
        recordCount: legacyRecordCount ?? nodeCount,
        rowCount,
        nodeCount,
        omissionCount: omissionCount ?? omissions.length,
        hasMore,
        pageSha256: pageHash ?? null,
        priorPageSha256: priorPageHash,
        nextCursor,
    };
    const normalized = {
        ...source,
        success,
        guarded,
        state,
        action: "capture_spatial_snapshot",
        warnings: cleanStrings(readField(source, "warnings")),
        notices: cleanStrings(readField(source, "notices")),
        nodes,
        omissions,
        page: normalizedPage,
        pageOrdinal,
        rowCount,
        nodeCount,
        omissionCount: omissionCount ?? omissions.length,
        payloadBytes: logicalPayloadBytes,
        pagePayloadBytes,
        pageHash: pageHash ?? null,
        priorPageHash,
        nextCursor,
        partial,
        scanStoppedReason,
        suggestedNextScopes,
        elapsedMs: normalizedElapsedMs,
    };
    normalized.snapshot = {
        snapshotId: readField(source, "snapshotId") ?? readField(source, "captureId"),
        capturedAt: readField(source, "capturedAt"),
        sourceRevisions: readField(source, "sourceRevisions"),
        scope: readField(source, "scope"),
        scopeFingerprint: readField(source, "scopeFingerprint"),
        revisionFingerprint: readField(source, "revisionFingerprint"),
        coordinateFrame: readField(source, "coordinateFrame"),
        lengthUnit: readField(source, "lengthUnit"),
        schemaVersion: readField(source, "schemaVersion"),
        extractorVersion: readField(source, "extractorVersion"),
        counts: readField(source, "counts"),
        partial,
        scanStoppedReason,
        suggestedNextScopes: normalized.suggestedNextScopes,
        pageCount: finiteInteger(readField(source, "pageCount")),
        payloadBytes: finiteInteger(readField(source, "payloadBytes")),
    };
    if (!success || guarded) {
        return {
            payload: normalized,
            valid: true,
            errors: [],
        };
    }
    const extractionPageValidation = validateSpatialExtractionPageContract(source);
    const errors = [...extractionPageValidation.errors];
    if (readField(source, "schemaVersion") !== SPATIAL_SNAPSHOT_SCHEMA_VERSION) {
        errors.push("schemaVersion must be 0.1");
    }
    if (readField(source, "coordinateFrame") !== SPATIAL_COORDINATE_FRAME) {
        errors.push("coordinateFrame must be host_internal_mm");
    }
    if (readField(source, "lengthUnit") !== "mm") {
        errors.push("lengthUnit must be mm");
    }
    if (!nonEmptyString(readField(source, "extractorVersion"))) {
        errors.push("extractorVersion is required");
    }
    if (!nonEmptyString(readField(source, "captureId"))) {
        errors.push("captureId is required");
    }
    if (!nonEmptyString(readField(source, "snapshotId") ?? readField(source, "captureId"))) {
        errors.push("snapshotId is required");
    }
    if (!nonEmptyString(readField(source, "capturedAt"))) {
        errors.push("capturedAt is required");
    }
    if (!isObject(readField(source, "scope"))) {
        errors.push("scope must be an object");
    }
    if (!isSha256(readField(source, "scopeFingerprint"))) {
        errors.push("scopeFingerprint must use sha256:<64 hex>");
    }
    if (!isSha256(readField(source, "revisionFingerprint"))) {
        errors.push("revisionFingerprint must use sha256:<64 hex>");
    }
    if (!Array.isArray(readField(source, "sourceRevisions"))) {
        errors.push("sourceRevisions must be an array");
    }
    if (!isObject(readField(source, "counts"))) {
        errors.push("counts must be an object");
    }
    const pageCount = finiteInteger(readField(source, "pageCount"));
    if (pageCount === null || pageCount < 1) {
        errors.push("pageCount must be a positive integer");
    }
    const totalPayloadBytes = finiteInteger(readField(source, "payloadBytes"));
    if (totalPayloadBytes === null || totalPayloadBytes < 0) {
        errors.push("payloadBytes must be a non-negative integer");
    }
    if (readField(source, "liveness") !== "unknown") {
        errors.push("Phase 0 liveness must be unknown");
    }
    if (readField(source, "atomic") !== false) {
        errors.push("Phase 0 atomic must be false");
    }
    if (!nonEmptyString(readField(source, "revisionBasisCaveat"))) {
        errors.push("revisionBasisCaveat is required");
    }
    if (!Array.isArray(nodesValue)) {
        errors.push("nodes must be an array");
    }
    if (!isObject(rawPage)) {
        errors.push("page must be an object");
    }
    if (pageOrdinal === null || pageOrdinal < 0) {
        errors.push("page.ordinal must be a non-negative integer");
    }
    if (targetBytes === null || targetBytes <= 0) {
        errors.push("page.targetBytes must be a positive integer");
    }
    if (pagePayloadBytes === null || pagePayloadBytes < 0) {
        errors.push("page.payloadBytes must be a non-negative integer");
    }
    if (logicalPayloadBytes === null || logicalPayloadBytes < 0) {
        errors.push("payloadBytes must be a non-negative logical capture total");
    }
    if (nodeCount < 0 || nodeCount !== nodes.length) {
        errors.push("page.nodeCount/recordCount must equal nodes.length");
    }
    if (omissionCount === null || omissionCount < 0 || omissionCount !== omissions.length) {
        errors.push("page.omissionCount must equal omissions.length");
    }
    if (rowCount < 0 || rowCount !== nodes.length + omissions.length) {
        errors.push("page.rowCount must equal nodes.length + omissions.length");
    }
    if (!isSha256(pageHash)) {
        errors.push("page.pageSha256 must use sha256:<64 hex>");
    }
    if ((pageOrdinal ?? 0) > 0 && !isSha256(priorPageHash)) {
        errors.push("page.priorPageSha256 must use sha256:<64 hex> after page 0");
    }
    if (hasMore && nextCursor === null) {
        errors.push("page.nextCursor is required when page.hasMore is true");
    }
    if (!hasMore && nextCursor !== null) {
        errors.push("page.nextCursor must be null when page.hasMore is false");
    }
    if (hasMore && !partial) {
        errors.push("partial must be true while page.hasMore is true");
    }
    normalized.contractValidation = {
        version: SPATIAL_PAGE_CONTRACT_VERSION,
        schemaId: extractionPageValidation.schemaId,
        valid: errors.length === 0,
        errors,
    };
    normalized.pageEvidence = buildSpatialPageEvidence(normalized);
    return {
        payload: normalized,
        valid: errors.length === 0,
        errors,
    };
}
export function buildSpatialPageEvidence(payload) {
    const source = isObject(payload) ? payload : {};
    const page = isObject(readField(source, "page")) ? readField(source, "page") : {};
    const captureId = readField(source, "captureId");
    const nextCursor = readField(source, "nextCursor") ?? readField(page, "nextCursor");
    return {
        captureId: typeof captureId === "string" ? captureId : null,
        pageOrdinal: finiteInteger(readField(page, "ordinal") ?? readField(source, "pageOrdinal")),
        pageHash: readField(page, "pageSha256") ?? readField(source, "pageHash") ?? null,
        priorPageHash: readField(page, "priorPageSha256") ?? readField(source, "priorPageHash") ?? null,
        rowCount: finiteInteger(readField(page, "rowCount") ?? readField(source, "rowCount")),
        nodeCount: finiteInteger(readField(page, "nodeCount", "recordCount") ?? readField(source, "nodeCount")),
        omissionCount: finiteInteger(readField(page, "omissionCount")),
        pagePayloadBytes: finiteInteger(readField(page, "payloadBytes") ?? readField(source, "pagePayloadBytes")),
        payloadBytes: finiteInteger(readField(source, "payloadBytes")),
        hasMore: readField(page, "hasMore") === true,
        nextCursorPresent: typeof nextCursor === "string" && nextCursor.length > 0,
    };
}
