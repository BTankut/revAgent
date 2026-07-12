import crypto from "node:crypto";
import { canonicalJson, cleanText, isJsonObject, sha256Canonical } from "./spatialCanonical.js";

const CURSOR_PREFIX = "spatial-query-cursor-v1";
const CURSOR_VERSION = "1";
const MAX_CURSOR_LENGTH = 16_384;
const queryCursorSecret = crypto.randomBytes(32);

export interface SpatialQueryCursorEnvelope {
    cursorVersion: "1";
    snapshotId: string;
    revisionFingerprint: string;
    queryFingerprint: string;
    lastNodeId: string | null;
    nodePageEndId: string | null;
    lastEdgeId: string | null;
}

export class SpatialQueryCursorError extends Error {
    public readonly reason = "invalid_cursor";

    public constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SpatialQueryCursorError";
    }
}

function sign(payload: Buffer): Buffer {
    return crypto.createHmac("sha256", queryCursorSecret).update(payload).digest();
}

export function buildSpatialQueryFingerprint(value: unknown): string {
    return sha256Canonical(value);
}

export function encodeSpatialQueryCursor(
    envelope: Omit<SpatialQueryCursorEnvelope, "cursorVersion">,
): string {
    const normalized: SpatialQueryCursorEnvelope = {
        cursorVersion: CURSOR_VERSION,
        snapshotId: envelope.snapshotId,
        revisionFingerprint: envelope.revisionFingerprint,
        queryFingerprint: envelope.queryFingerprint,
        lastNodeId: envelope.lastNodeId,
        nodePageEndId: envelope.nodePageEndId,
        lastEdgeId: envelope.lastEdgeId,
    };
    const payload = Buffer.from(canonicalJson(normalized), "utf8");
    const encoded = `${CURSOR_PREFIX}.${payload.toString("base64url")}.${sign(payload).toString("base64url")}`;
    if (encoded.length > MAX_CURSOR_LENGTH) {
        throw new SpatialQueryCursorError("Spatial query cursor exceeds the bounded encoded size.");
    }
    return encoded;
}

export function decodeSpatialQueryCursor(
    cursor: string,
    expected: Pick<SpatialQueryCursorEnvelope, "snapshotId" | "revisionFingerprint" | "queryFingerprint">,
): SpatialQueryCursorEnvelope {
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
        throw new SpatialQueryCursorError("Spatial query cursor is missing or outside the supported size.");
    }
    const parts = cursor.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) {
        throw new SpatialQueryCursorError("Spatial query cursor prefix or segment count is invalid.");
    }
    let payload: Buffer;
    let suppliedSignature: Buffer;
    try {
        payload = Buffer.from(parts[1], "base64url");
        suppliedSignature = Buffer.from(parts[2], "base64url");
    } catch (error) {
        throw new SpatialQueryCursorError("Spatial query cursor encoding is invalid.", { cause: error });
    }
    const expectedSignature = sign(payload);
    if (suppliedSignature.length !== expectedSignature.length
        || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) {
        throw new SpatialQueryCursorError("Spatial query cursor signature is invalid.");
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(payload.toString("utf8"));
    } catch (error) {
        throw new SpatialQueryCursorError("Spatial query cursor JSON is invalid.", { cause: error });
    }
    if (!isJsonObject(decoded)) {
        throw new SpatialQueryCursorError("Spatial query cursor envelope is invalid.");
    }
    const envelope: SpatialQueryCursorEnvelope = {
        cursorVersion: decoded.cursorVersion === CURSOR_VERSION ? CURSOR_VERSION : "1",
        snapshotId: cleanText(decoded.snapshotId) ?? "",
        revisionFingerprint: cleanText(decoded.revisionFingerprint) ?? "",
        queryFingerprint: cleanText(decoded.queryFingerprint) ?? "",
        lastNodeId: cleanText(decoded.lastNodeId),
        nodePageEndId: cleanText(decoded.nodePageEndId),
        lastEdgeId: cleanText(decoded.lastEdgeId),
    };
    if (decoded.cursorVersion !== CURSOR_VERSION
        || envelope.snapshotId !== expected.snapshotId
        || envelope.revisionFingerprint !== expected.revisionFingerprint
        || envelope.queryFingerprint !== expected.queryFingerprint) {
        throw new SpatialQueryCursorError("Spatial query cursor does not match the requested snapshot, revision, or filters.");
    }
    const allowed = new Set([
        "cursorVersion",
        "snapshotId",
        "revisionFingerprint",
        "queryFingerprint",
        "lastNodeId",
        "nodePageEndId",
        "lastEdgeId",
    ]);
    if (Object.keys(decoded).some((key) => !allowed.has(key))) {
        throw new SpatialQueryCursorError("Spatial query cursor contains unsupported fields.");
    }
    if ((envelope.nodePageEndId === null) !== (envelope.lastEdgeId === null)) {
        throw new SpatialQueryCursorError("Spatial query cursor edge continuation state is incomplete.");
    }
    return envelope;
}
