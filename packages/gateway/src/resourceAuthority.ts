import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  appendStreamChunk,
  createStreamAssembler,
  finalizeStreams,
  type RbpStreamChunk,
  type TerminalStreamManifest,
} from "@revagent/protocol";

import type { AuthContext } from "./authContext.js";
import type { GatewayJsonValue } from "./dispatch.js";
import type { EffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import type { GatewayProtocolStore, ObjectStorePort, ProtectedObjectBinding, ProtectedObjectStorePort, StoreTransaction } from "./store.js";
import type { ProtectedObjectLiveKeyInventoryPort } from "./protectedObjectKeyProvider.js";

const RESOURCE_NAMESPACE = "gateway_resource_v1";
/** DC-10 durable carrier state.  These are deliberately separate from the
 * north-facing gateway_resource_v1 rows: no partially received carrier can be
 * addressed through the resource URI surface. */
const RESOURCE_SET_NAMESPACE = "gateway.resource-set/v1";
const CARRIER_CHUNK_NAMESPACE = "gateway.carrier-chunk/v1";
const RESOURCE_SET_MEMBER_NAMESPACE = "gateway.resource-set-member/v1";
const CARRIER_ACK_NAMESPACE = "gateway.carrier-ack/v1";
const CARRIER_IDENTITY_NAMESPACE = "gateway.carrier-identity/v1";
const CARRIER_TERMINAL_NAMESPACE = "gateway.carrier-terminal/v1";
const RECOVERY_CHUNK_NAMESPACE = "gateway.recovery-chunk/v1";
const RECOVERY_COMPLETION_NAMESPACE = "gateway.recovery-completion/v1";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const SHA256_HEX_SENTINEL = "0".repeat(64);
const SAFE_FILENAME_PATTERN = /^[^\\/:<>"|?*\u0000-\u001f\u007f]+$/u;
const TEST_SCOPE_URI_COMPARISON_OBSERVER =
  "__revAgentTestObserveScopedUriComparison";

export const GW9_ALLOWED_UPLOAD_CONTENT_TYPES = Object.freeze([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/tab-separated-values",
] as const);

export const GW9_ALLOWED_OUTPUT_CONTENT_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/x-tga",
] as const);

export interface GatewayResourceScope {
  readonly tenantId: string;
  readonly actorId: string;
  readonly principalKey: string;
  readonly mcpSessionId: string;
}

export function resourceScopeFromAuth(
  auth: AuthContext,
  mcpSessionId: string,
): GatewayResourceScope {
  return Object.freeze({
    tenantId: auth.actor.tenantId,
    actorId: auth.actor.userId,
    principalKey: auth.principalKey,
    mcpSessionId,
  });
}

/** Keeps resource authority on the ingress-created effective MCP scope. */
export function resourceScopeFromEffectiveMcpRequestScope(
  auth: AuthContext,
  scope: EffectiveMcpRequestScopeV1,
): GatewayResourceScope {
  if (scope.principalKey !== auth.principalKey) {
    fail("scope_denied", "effective MCP scope principal does not match auth");
  }
  return resourceScopeFromAuth(auth, scope.effectiveMcpSessionId);
}

export type GatewayResourceKind = "artifact_ref" | "result_ref";

interface ResourceRecordBase {
  readonly schemaVersion: "revagent-gateway-resource/v1";
  readonly kind: GatewayResourceKind;
  readonly refId: string;
  readonly actorId: string;
  readonly principalKey: string;
  readonly mcpSessionId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  /**
   * Resource bytes never become readable until their metadata reaches active.
   * Earlier v1 rows predate this field and are treated as active for a
   * backwards-compatible, one-way import.
   */
  readonly lifecycle?: "allocating" | "assembling" | "verified" | "active" | "gc_claimed" | "deleting";
  readonly gcLease?: {
    readonly owner: string;
    readonly claimToken: string;
    readonly expiresAtMs: number;
  };
}

interface ArtifactRecord extends ResourceRecordBase {
  readonly kind: "artifact_ref";
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly storageKey: string;
  readonly quarantineStatus: "quarantined" | "released";
  readonly source: "north_upload" | "rbp_output";
  readonly invocationId: string | null;
  readonly artifactIndex: number | null;
  /** Private carrier provenance for fenced expiry cleanup; never exposed north. */
  readonly carrierSetId?: string;
}

interface ResultRecord extends ResourceRecordBase {
  readonly kind: "result_ref";
  readonly contentType: "application/json";
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly storageKey: string;
  /** Present only for C39 encrypted omitted-payload recovery results. */
  readonly protectedRecovery?: RecoveryProtectedRef;
}

type ResourceRecord = ArtifactRecord | ResultRecord;

export type GatewayResourceErrorCode =
  | "invalid_input"
  | "content_type_denied"
  | "oversize"
  | "digest_mismatch"
  | "quarantined"
  | "not_found"
  | "expired"
  | "scope_denied"
  | "protocol_fault"
  | "incomplete"
  | "storage_unavailable";

export class GatewayResourceError extends Error {
  public constructor(
    readonly code: GatewayResourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayResourceError";
  }
}

export interface GatewayArtifactRef {
  readonly kind: "artifact_ref";
  readonly refId: string;
  readonly uri: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly expiresAtMs: number;
}

export interface GatewayResultRef {
  readonly kind: "result_ref";
  readonly refId: string;
  readonly uri: string;
  readonly contentType: "application/json";
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly pageCount: number;
  readonly expiresAtMs: number;
}

export interface GatewayResourceRead {
  readonly uri: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly nextPageUri: string | null;
}

export interface GatewayResourceAuthorityOptions {
  readonly protocolStore: GatewayProtocolStore;
  readonly objectStore: ObjectStorePort;
  readonly now?: () => number;
  readonly newRefId?: () => string;
  readonly maxUploadBytes?: number;
  readonly maxResultBytes?: number;
  readonly maxResultPageBytes?: number;
  readonly defaultTtlMs?: number;
  /** Deterministic owner for bounded, fenced expiry collection. */
  readonly gcOwnerId?: string;
  /** C39 is disabled unless both the cryptographic store and reauth fence are supplied. */
  readonly protectedObjectStore?: ProtectedObjectStorePort;
  /** Must return the currently bound session identity/version, or null. */
  readonly reauthorizeRecoveryScope?: (input: RecoveryOwner) => Promise<RecoveryCurrentAuthorization | null> | RecoveryCurrentAuthorization | null;
}

export interface RecoveryOwner {
  readonly tenantId: string;
  readonly userId: string;
  readonly principalKey: string;
  readonly effectiveMcpSessionId: string;
  readonly sessionBindingId: string;
  readonly sessionBindingVersion: number;
  readonly rsid: string;
  readonly recoveryInvocationId: string;
  readonly originInvocationId: string;
  readonly originResultDigest: `sha256:${string}`;
}

export interface RecoveryCurrentAuthorization {
  readonly sessionBindingId: string;
  readonly sessionBindingVersion: number;
}

export interface StageRecoveryChunkInput {
  readonly scope: GatewayResourceScope;
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly owner: RecoveryOwner;
  readonly bridgeSequence: number;
  readonly chunkIndex: number;
  /** Canonical base64 only; recovery never accepts a JSON object here. */
  readonly data: string;
  readonly contentType: "application/json";
  readonly expiresAtMs?: number;
  /** Gateway-only ACK commit after encrypted receipt activation. */
  readonly commitBridge?: (tx: StoreTransaction) => Promise<void>;
}

export interface FinalizeRecoveryResultInput {
  readonly scope: GatewayResourceScope;
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly owner: RecoveryOwner;
  readonly terminalChunkCount: number;
  readonly terminalByteLength: number;
  readonly expiresAtMs?: number;
  /** Gateway-only terminal ACK commit after ref/completion activation. */
  readonly commitBridge?: (tx: StoreTransaction) => Promise<void>;
}

interface RecoveryProtectedRef {
  readonly schemaVersion: "revagent-gateway-recovery/v1";
  readonly owner: RecoveryOwner;
  readonly kid: string;
  readonly storageKey: string;
  readonly plainDigest: `sha256:${string}`;
  readonly resultRefDigest: `sha256:${string}`;
  readonly plainLength: number;
  readonly bridgeSequence: number;
  readonly chunkIndex: number;
  readonly activatedSessionBindingId?: string;
  readonly activatedSessionBindingVersion?: number;
}

interface RecoveryChunkRecord {
  readonly schemaVersion: "revagent-gateway-recovery/v1";
  readonly state: "writing" | "active" | "deleting";
  readonly owner: RecoveryOwner;
  readonly bridgeSequence: number;
  readonly chunkIndex: number;
  readonly kid: string;
  readonly storageKey: string;
  readonly plainDigest: `sha256:${string}`;
  readonly resultRefDigest: `sha256:${string}`;
  readonly plainLength: number;
  readonly expiresAtMs: number;
  readonly deletionClaim?: { readonly id: string; readonly version: number };
}

interface RecoveryCompletionRecord {
  readonly schemaVersion: "revagent-gateway-recovery/v1";
  readonly state: "writing" | "active";
  readonly owner: RecoveryOwner;
  readonly refId: string;
  readonly expiresAtMs: number;
  readonly activatedSessionBindingId?: string;
  readonly activatedSessionBindingVersion?: number;
}

export interface GatewayResourceGcResult {
  readonly scanned: number;
  readonly claimed: number;
  readonly deleted: number;
  readonly retained: number;
}

export interface UploadArtifactInput {
  readonly scope: GatewayResourceScope;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly quarantineStatus: "quarantined" | "released";
  readonly expectedDigest?: `sha256:${string}`;
  readonly expiresAtMs?: number;
}

export interface IngestRbpArtifactCarrierInput {
  readonly scope: GatewayResourceScope;
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  /** Durable bridge session binding.  WP-11 is the only activation caller. */
  readonly rsid: string;
  readonly invocationId: string;
  readonly chunks: readonly RbpStreamChunk[];
  readonly manifest: Extract<TerminalStreamManifest, { kind: "artifact_result" }>;
  readonly expiresAtMs?: number;
}

/**
 * The bridge does not call this until WP-11.  It is deliberately public now
 * so a carrier can durably acknowledge an individual receipt without also
 * giving it a north-facing resource URI.
 */
export interface StageCarrierChunkInput {
  readonly scope: GatewayResourceScope;
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly setId: string;
  readonly rsid: string;
  readonly invocationId: string;
  readonly streamDigest: string;
  readonly chunkIndex: number;
  readonly sequence: number;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly streamId: string;
  readonly contentType: string;
  readonly artifactId: string | null;
  readonly artifactIndex: number | null;
  readonly expiresAtMs?: number;
}

/**
 * The bridge only receives this callback inside the same durable transaction
 * that records its carrier acknowledgement.  It is intentionally an internal
 * integration seam, not a north-facing resource operation.
 */
/**
 * Stage-C callers can decline admission without throwing through the storage
 * adapter.  This is deliberately a value, rather than an exception: adapters
 * correctly collapse callback exceptions into generic storage failures, which
 * would make a revocation abort indistinguishable from durability loss.
 */
export type BridgeCarrierCommitResult =
  | { readonly kind: "committed" }
  | { readonly kind: "aborted"; readonly reason: "terminal_revoked" };

export const BRIDGE_CARRIER_COMMIT_OK: BridgeCarrierCommitResult = Object.freeze({
  kind: "committed",
});

/** A typed, non-retryable result from Tx-C; no north-facing rows committed. */
export class BridgeCarrierTerminalAborted extends Error {
  public constructor() {
    super("carrier terminal admission was revoked before stage C");
    this.name = "BridgeCarrierTerminalAborted";
  }
}

export type BridgeCarrierCommitMode = "activate" | "verify";

export type BridgeCarrierCommit = (
  tx: StoreTransaction,
  mode: BridgeCarrierCommitMode,
) => Promise<void | BridgeCarrierCommitResult> | void | BridgeCarrierCommitResult;

function bridgeCommitAborted(result: void | BridgeCarrierCommitResult): boolean {
  return result !== undefined && result.kind === "aborted";
}

export interface BridgeCarrierChunkInput {
  readonly scope: GatewayResourceScope;
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly rsid: string;
  readonly invocationId: string;
  readonly sequence: number;
  readonly chunk: RbpStreamChunk;
  readonly expiresAtMs?: number;
  readonly commitBridge: BridgeCarrierCommit;
}

export interface BridgeCarrierTerminalInput {
  readonly scope: GatewayResourceScope;
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly rsid: string;
  readonly invocationId: string;
  readonly manifest: Extract<TerminalStreamManifest, { kind: "artifact_result" }>;
  readonly commitBridge: BridgeCarrierCommit;
}

export interface BridgeChunkedResultTerminalInput {
  readonly scope: GatewayResourceScope;
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly rsid: string;
  readonly invocationId: string;
  readonly manifest: Extract<TerminalStreamManifest, { kind: "chunked_result" }>;
  readonly commitBridge: BridgeCarrierCommit;
}

type CarrierSetState = "declared" | "assembling" | "verified" | "active" | "cleanup_pending" | "gc_claimed";
const CARRIER_MAX_RECEIPTS = 1_024;
type CarrierMemberState = "intent" | "verified" | "active";

interface CarrierSetRecord {
  readonly schemaVersion: "revagent-gateway-carrier/v1";
  readonly setId: string;
  readonly rsid: string;
  readonly invocationId: string;
  readonly tenantId: string;
  readonly principalKey: string;
  readonly effectiveMcpSessionId: string;
  readonly state: CarrierSetState;
  readonly expiresAtMs: number;
  readonly receivedChunkCount: number;
  readonly receivedByteCount: number;
  readonly cleanupGeneration?: number;
  readonly gcLease?: { readonly owner: string; readonly token: string; readonly expiresAtMs: number; readonly claimVersion: string };
}

interface CarrierIdentityRecord {
  readonly schemaVersion: "revagent-gateway-carrier/v1";
  readonly setId: string;
  readonly rsid: string;
  readonly invocationId: string;
  readonly tenantId: string;
  readonly principalKey: string;
  readonly effectiveMcpSessionId: string;
}

interface CarrierTerminalRecord {
  readonly schemaVersion: "revagent-gateway-carrier/v1";
  readonly setId: string;
  readonly rsid: string;
  readonly invocationId: string;
  readonly manifest: TerminalStreamManifest;
}

interface CarrierChunkRecord {
  readonly schemaVersion: "revagent-gateway-carrier/v1";
  readonly setId: string;
  readonly streamDigest: string;
  readonly chunkIndex: number;
  readonly sequence: number;
  readonly rsid: string;
  readonly invocationId: string;
  readonly tenantId: string;
  readonly principalKey: string;
  readonly effectiveMcpSessionId: string;
  readonly streamId: string;
  readonly contentType: string;
  readonly artifactId: string | null;
  readonly artifactIndex: number | null;
  readonly chunkIdentity: `sha256:${string}`;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly state: "pending" | "durable";
}

interface CarrierMemberRecord {
  readonly schemaVersion: "revagent-gateway-carrier/v1";
  readonly setId: string;
  readonly memberIndex: number;
  readonly rsid: string;
  readonly invocationId: string;
  readonly tenantId: string;
  readonly principalKey: string;
  readonly effectiveMcpSessionId: string;
  readonly refId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly digest: `sha256:${string}`;
  readonly byteSize: number;
  readonly expectedChunkCount: number;
  readonly streamDigest: string;
  readonly storageKey: string;
  readonly state: CarrierMemberState;
}

export type BoundedGatewayResult =
  | { readonly kind: "inline"; readonly value: GatewayJsonValue }
  | GatewayResultRef;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fail(code: GatewayResourceErrorCode, message: string): never {
  throw new GatewayResourceError(code, message);
}

function safeFilename(filename: string): boolean {
  if (
    filename.length < 1 ||
    filename.length > 255 ||
    filename !== filename.trim() ||
    !SAFE_FILENAME_PATTERN.test(filename) ||
    filename.includes("..") ||
    filename.startsWith(".") ||
    /[. ]$/u.test(filename)
  ) {
    return false;
  }
  const stem = filename.split(".", 1)[0]?.toUpperCase() ?? "";
  return !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u.test(
    stem,
  );
}

function assertScope(scope: GatewayResourceScope): void {
  for (const [name, value] of Object.entries(scope)) {
    if (value.length < 1 || value.length > 512 || /[\u0000\r\n]/u.test(value)) {
      fail("invalid_input", `${name} is invalid`);
    }
  }
}

function asJsonRecord(value: unknown): ResourceRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<ResourceRecord>;
  const sharedInvalid =
    record.schemaVersion !== "revagent-gateway-resource/v1" ||
    (record.kind !== "artifact_ref" && record.kind !== "result_ref") ||
    typeof record.refId !== "string" || record.refId.length < 1 ||
    typeof record.actorId !== "string" || record.actorId.length < 1 ||
    typeof record.principalKey !== "string" || record.principalKey.length < 1 ||
    typeof record.mcpSessionId !== "string" || record.mcpSessionId.length < 1 ||
    !Number.isSafeInteger(record.createdAtMs) || record.createdAtMs! < 0 ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    record.expiresAtMs! <= record.createdAtMs!;
  if (sharedInvalid) {
    return null;
  }
  if (
    record.lifecycle !== undefined &&
    record.lifecycle !== "allocating" &&
    record.lifecycle !== "assembling" &&
    record.lifecycle !== "verified" &&
    record.lifecycle !== "active" &&
    record.lifecycle !== "gc_claimed" &&
    record.lifecycle !== "deleting"
  ) {
    return null;
  }
  if (record.gcLease !== undefined && (
    (record.lifecycle !== "gc_claimed" && record.lifecycle !== "deleting") ||
    typeof record.gcLease.owner !== "string" ||
    record.gcLease.owner.length < 1 ||
    typeof record.gcLease.claimToken !== "string" ||
    record.gcLease.claimToken.length < 1 ||
    !Number.isSafeInteger(record.gcLease.expiresAtMs) ||
    record.gcLease.expiresAtMs < 0
  )) {
    return null;
  }
  if (record.kind === "artifact_ref") {
    if (
      typeof record.filename !== "string" ||
      !safeFilename(record.filename) ||
      typeof record.contentType !== "string" ||
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize! < 0 ||
      typeof record.digest !== "string" ||
      !SHA256_PATTERN.test(record.digest) ||
      typeof record.storageKey !== "string" ||
      record.storageKey.length < 1 ||
      (record.quarantineStatus !== "quarantined" &&
        record.quarantineStatus !== "released") ||
      (record.source !== "north_upload" && record.source !== "rbp_output") ||
      (record.source === "north_upload" &&
        (record.invocationId !== null || record.artifactIndex !== null)) ||
      (record.source === "rbp_output" &&
        (typeof record.invocationId !== "string" ||
          record.invocationId.length < 1 ||
          !Number.isSafeInteger(record.artifactIndex) ||
          record.artifactIndex! < 0)) ||
      (record.invocationId !== null && typeof record.invocationId !== "string") ||
      (record.artifactIndex !== null &&
        (!Number.isSafeInteger(record.artifactIndex) || record.artifactIndex! < 0))
    ) {
      return null;
    }
    return record as ArtifactRecord;
  }
  const result = record as Partial<ResultRecord>;
  if (
    result.contentType !== "application/json" ||
    !Number.isSafeInteger(record.byteSize) ||
    record.byteSize! < 0 ||
    typeof record.digest !== "string" ||
    !SHA256_PATTERN.test(record.digest) ||
    !Number.isSafeInteger(result.pageSize) ||
    result.pageSize! < 1 ||
    !Number.isSafeInteger(result.pageCount) ||
    result.pageCount! < 1 ||
    typeof record.storageKey !== "string" ||
    record.storageKey.length < 1
  ) {
    return null;
  }
  if (result.protectedRecovery !== undefined && !validRecoveryProtectedRef(result.protectedRecovery)) {
    return null;
  }
  return record as ResultRecord;
}

function validRecoveryOwner(value: unknown): value is RecoveryOwner {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<RecoveryOwner>;
  return typeof owner.tenantId === "string" && typeof owner.userId === "string" && typeof owner.principalKey === "string" && typeof owner.effectiveMcpSessionId === "string" && typeof owner.sessionBindingId === "string" && Number.isSafeInteger(owner.sessionBindingVersion) && owner.sessionBindingVersion! >= 1 && typeof owner.rsid === "string" && typeof owner.recoveryInvocationId === "string" && typeof owner.originInvocationId === "string" && typeof owner.originResultDigest === "string" && owner.tenantId.length > 0 && owner.userId.length > 0 && owner.principalKey.length > 0 && owner.effectiveMcpSessionId.length > 0 && owner.sessionBindingId.length > 0 && owner.rsid.length > 0 && UUID_V7_PATTERN.test(owner.recoveryInvocationId) && UUID_V7_PATTERN.test(owner.originInvocationId) && SHA256_PATTERN.test(owner.originResultDigest);
}

function sameRecoveryOwner(left: RecoveryOwner, right: RecoveryOwner): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId && left.principalKey === right.principalKey && left.effectiveMcpSessionId === right.effectiveMcpSessionId && left.sessionBindingId === right.sessionBindingId && left.sessionBindingVersion === right.sessionBindingVersion && left.rsid === right.rsid && left.recoveryInvocationId === right.recoveryInvocationId && left.originInvocationId === right.originInvocationId && left.originResultDigest === right.originResultDigest;
}

function validRecoveryProtectedRef(value: unknown): value is RecoveryProtectedRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RecoveryProtectedRef>;
  return record.schemaVersion === "revagent-gateway-recovery/v1" && validRecoveryOwner(record.owner) && typeof record.kid === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(record.kid) && typeof record.storageKey === "string" && SHA256_PATTERN.test(record.storageKey) && typeof record.plainDigest === "string" && SHA256_PATTERN.test(record.plainDigest) && typeof record.resultRefDigest === "string" && SHA256_PATTERN.test(record.resultRefDigest) && record.plainDigest !== record.resultRefDigest && Number.isSafeInteger(record.plainLength) && record.plainLength! >= 0 && Number.isSafeInteger(record.bridgeSequence) && record.bridgeSequence! >= 0 && Number.isSafeInteger(record.chunkIndex) && record.chunkIndex! >= 0 && ((record.activatedSessionBindingId === undefined && record.activatedSessionBindingVersion === undefined) || (typeof record.activatedSessionBindingId === "string" && record.activatedSessionBindingId.length > 0 && Number.isSafeInteger(record.activatedSessionBindingVersion) && record.activatedSessionBindingVersion! >= 1));
}

function asRecoveryChunk(value: unknown): RecoveryChunkRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<RecoveryChunkRecord>;
  if (record.schemaVersion !== "revagent-gateway-recovery/v1" || (record.state !== "writing" && record.state !== "active" && record.state !== "deleting") || !validRecoveryOwner(record.owner) || typeof record.kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(record.kid) || typeof record.storageKey !== "string" || !SHA256_PATTERN.test(record.storageKey) || typeof record.plainDigest !== "string" || !SHA256_PATTERN.test(record.plainDigest) || typeof record.resultRefDigest !== "string" || !SHA256_PATTERN.test(record.resultRefDigest) || record.resultRefDigest === record.plainDigest || !Number.isSafeInteger(record.plainLength) || record.plainLength! < 0 || record.plainLength! > 1_048_576 || !Number.isSafeInteger(record.bridgeSequence) || record.bridgeSequence! < 0 || !Number.isSafeInteger(record.chunkIndex) || record.chunkIndex! < 0 || !Number.isSafeInteger(record.expiresAtMs) || record.expiresAtMs! < 1 || ((record.state === "deleting") !== (record.deletionClaim !== undefined)) || (record.deletionClaim !== undefined && (!/^[A-Za-z0-9._:-]{1,256}$/u.test(record.deletionClaim.id) || !Number.isSafeInteger(record.deletionClaim.version) || record.deletionClaim.version < 1))) return null;
  return record as RecoveryChunkRecord;
}

function asRecoveryCompletion(value: unknown): RecoveryCompletionRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<RecoveryCompletionRecord>;
  return record.schemaVersion === "revagent-gateway-recovery/v1" && (record.state === "writing" || record.state === "active") && validRecoveryOwner(record.owner) && typeof record.refId === "string" && record.refId.length > 0 && record.refId.length <= 200 && !/[\u0000\r\n/\\]/u.test(record.refId) && Number.isSafeInteger(record.expiresAtMs) && record.expiresAtMs! > 0 && ((record.state === "writing" && record.activatedSessionBindingId === undefined && record.activatedSessionBindingVersion === undefined) || (record.state === "active" && record.activatedSessionBindingId === record.owner.sessionBindingId && record.activatedSessionBindingVersion === record.owner.sessionBindingVersion)) ? record as RecoveryCompletionRecord : null;
}

function sameRecoveryChunk(record: RecoveryChunkRecord, owner: RecoveryOwner, sequence: number, index: number, digest: string, length: number): boolean {
  return sameRecoveryOwner(record.owner, owner) && record.bridgeSequence === sequence && record.chunkIndex === index && record.plainDigest === digest && record.plainLength === length;
}

function decodeRecoveryChunk(data: string): Uint8Array {
  if (typeof data !== "string" || data.length === 0 || data.length > 1_398_104) fail("protocol_fault", "recovery chunk is invalid");
  const bytes = Buffer.from(data, "base64");
  try {
    if (bytes.byteLength > 1_048_576 || bytes.toString("base64") !== data) fail("protocol_fault", "recovery chunk is invalid");
    return new Uint8Array(bytes);
  } finally { bytes.fill(0); }
}

export function recoveryResultRefDigest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update("revagent/c39-result-ref/v1\0", "utf8").update(bytes).digest("hex")}`;
}

function recoveryBinding(owner: RecoveryOwner, bridgeSequence: number, chunkIndex: number, plainDigest: `sha256:${string}`, resultRefDigest: `sha256:${string}`, plainLength: number, expiresAtMs: number): ProtectedObjectBinding {
  return Object.freeze({ tenantId: owner.tenantId, userId: owner.userId, principalKey: owner.principalKey, effectiveMcpSessionId: owner.effectiveMcpSessionId, sessionBindingId: owner.sessionBindingId, sessionBindingVersion: owner.sessionBindingVersion, rsid: owner.rsid, recoveryInvocationId: owner.recoveryInvocationId, originInvocationId: owner.originInvocationId, originResultDigest: owner.originResultDigest, resultRefDigest, bridgeSequence, chunkIndex, plainDigest, plainLength, purpose: "dispatch_payload_recovery", expiresAtMs });
}

function recoveryIdentityHash(owner: RecoveryOwner): string { return createHash("sha256").update(JSON.stringify([owner.tenantId, owner.userId, owner.principalKey, owner.effectiveMcpSessionId, owner.sessionBindingId, owner.sessionBindingVersion, owner.rsid, owner.recoveryInvocationId, owner.originInvocationId, owner.originResultDigest])).digest("hex"); }
function recoveryChunkKey(owner: RecoveryOwner, index: number): string { return `r:${recoveryIdentityHash(owner)}/chunk:${String(index)}`; }
function recoveryCompletionKey(owner: RecoveryOwner): string { return `r:${recoveryIdentityHash(owner)}/completion`; }
function recoveryStorageKey(owner: RecoveryOwner, kind: "chunk" | "result", index: number): `sha256:${string}` { return `sha256:${createHash("sha256").update(`revagent.c39/${kind}/${recoveryIdentityHash(owner)}/${String(index)}`).digest("hex")}`; }

/**
 * The key provider receives no caller-controlled key names.  It derives its
 * mandatory rotation inventory from durable C39 rows, including crash-window
 * `writing` objects.  Any inventory uncertainty fails closed as `null`.
 */
export class ResourceAuthorityProtectedKeyInventoryPort implements ProtectedObjectLiveKeyInventoryPort {
  readonly kind = "durable" as const;
  readonly #store: GatewayProtocolStore;
  readonly #now: () => number;
  public constructor(store: GatewayProtocolStore, options: { readonly now?: () => number } = {}) { this.#store = store; this.#now = options.now ?? Date.now; }
  async listLiveKids(): Promise<readonly string[] | null> {
    const tenants = await this.#store.startupCoordinator.listTenantIds(10_000);
    if (!tenants.ok) return null;
    const kids = new Set<string>();
    for (const tenantId of tenants.value) {
      const rows = await this.#store.transact({ tenantId }, async (tx) => ({
        chunks: await tx.list(RECOVERY_CHUNK_NAMESPACE),
        refs: await tx.list(RESOURCE_NAMESPACE),
      }));
      if (!rows.ok) return null;
      for (const row of rows.value.chunks) {
        const chunk = asRecoveryChunk(row.value);
        if (chunk === null) return null;
        // A deletion claim still owns ciphertext until the object-store delete
        // has confirmed; preserve its kid through that final crash window.
        if (chunk.state === "deleting" || ((chunk.state === "writing" || chunk.state === "active") && chunk.expiresAtMs > this.#now())) kids.add(chunk.kid);
      }
      for (const row of rows.value.refs) {
        const resource = asJsonRecord(row.value);
        if (resource === null) return null;
        if (resource.kind === "result_ref" && resource.protectedRecovery !== undefined && ((resource.lifecycle ?? "active") === "deleting" || resource.expiresAtMs > this.#now())) kids.add(resource.protectedRecovery.kid);
      }
    }
    return Object.freeze([...kids].sort());
  }
}

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ScopedUriComparisonSlot = "p" | "s" | "t" | "a";
type ScopedUriComparisonObserver = (slot: ScopedUriComparisonSlot) => void;

function sameHash(
  expected: string,
  supplied: string,
  slot: ScopedUriComparisonSlot,
  observer: ScopedUriComparisonObserver | undefined,
): boolean {
  const suppliedIsHash = SHA256_HEX_PATTERN.test(supplied);
  const normalizedSupplied = suppliedIsHash ? supplied : SHA256_HEX_SENTINEL;
  // All scope positions compare exactly 32 bytes, even when the supplied URI
  // component is malformed. Never return before the fixed-width comparison.
  const matches = timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(normalizedSupplied, "hex"),
  );
  observer?.(slot);
  return matches && suppliedIsHash;
}

function assertEffectiveScope(
  scope: GatewayResourceScope,
  effectiveMcpRequestScope: EffectiveMcpRequestScopeV1,
): void {
  if (
    !Object.isFrozen(effectiveMcpRequestScope) ||
    effectiveMcpRequestScope.contractVersion !==
      "revagent.effective-mcp-request-scope/v1" ||
    effectiveMcpRequestScope.principalKey !== scope.principalKey ||
    effectiveMcpRequestScope.effectiveMcpSessionId !== scope.mcpSessionId
  ) {
    fail("scope_denied", "resource authority scope does not match ingress scope");
  }
}

function decodeCarrierChunk(chunk: RbpStreamChunk): Uint8Array {
  const decoded = Buffer.from(chunk.data, "base64");
  if (decoded.byteLength > 1_048_576 || decoded.toString("base64") !== chunk.data) {
    fail("protocol_fault", "carrier chunk is not canonical bounded base64");
  }
  return new Uint8Array(decoded);
}

function isGatewayJsonValue(value: unknown, seen = new WeakSet<object>()): value is GatewayJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isGatewayJsonValue(item, seen))
    : Object.entries(value).every(([key, item]) => key.length > 0 && isGatewayJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function parseCarrierJson(bytes: Uint8Array): GatewayJsonValue {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!isGatewayJsonValue(value)) throw new Error("not JSON");
    return structuredClone(value);
  } catch {
    fail("protocol_fault", "chunked result bytes are not a bounded JSON value");
  }
}

function recordKey(
  scope: GatewayResourceScope,
  kind: GatewayResourceKind,
  refId: string,
): string {
  // Scope hashes make a foreign principal/session miss metadata before an
  // object-store lookup and avoid persisting raw session or principal values.
  return recordKeyFromHash(scope, kind, scopeHash(refId));
}

function recordKeyFromHash(
  scope: GatewayResourceScope,
  kind: GatewayResourceKind,
  refHash: string,
): string {
  return `p:${scopeHash(scope.principalKey)}/s:${scopeHash(scope.mcpSessionId)}/a:${scopeHash(scope.actorId)}/${kind}/r:${refHash}`;
}

function storageKey(
  scope: GatewayResourceScope,
  kind: GatewayResourceKind,
  refId: string,
  digest: `sha256:${string}`,
): string {
  const tenant = scopeHash(scope.tenantId);
  const principal = scopeHash(scope.principalKey);
  const session = scopeHash(scope.mcpSessionId);
  const actor = scopeHash(scope.actorId);
  const opaqueRef = createHash("sha256").update(`${refId}\u0000${digest}`).digest("hex");
  return `p:${principal}/s:${session}/t:${tenant}/a:${actor}/${kind}/r:${opaqueRef}`;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function uuidV7(nowMs: number): string {
  const timestamp = Math.max(0, Math.floor(nowMs)).toString(16).padStart(12, "0").slice(-12);
  const random = randomBytes(10).toString("hex");
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(0, 3)}-${(8 + (Number.parseInt(random.slice(3, 4), 16) & 3)).toString(16)}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

function assertSetId(setId: string): void {
  if (!UUID_V7_PATTERN.test(setId)) {
    fail("invalid_input", "carrier setId must be an explicit UUIDv7");
  }
}

function carrierIdentityKey(scope: GatewayResourceScope, rsid: string, invocationId: string): string {
  return `p:${scopeHash(scope.principalKey)}/s:${scopeHash(scope.mcpSessionId)}/r:${scopeHash(rsid)}/i:${scopeHash(invocationId)}`;
}

function carrierSetKey(setId: string): string { return `set:${setId}`; }
function carrierChunkKey(setId: string, streamDigest: string, chunkIndex: number): string {
  return `set:${setId}/stream:${streamDigest}/chunk:${String(chunkIndex)}`;
}
function carrierMemberKey(setId: string, memberIndex: number): string {
  return `set:${setId}/member:${String(memberIndex)}`;
}
function carrierAckKey(scope: GatewayResourceScope, rsid: string, seq: string): string {
  return `p:${scopeHash(scope.principalKey)}/s:${scopeHash(scope.mcpSessionId)}/r:${scopeHash(rsid)}/ack:${seq}`;
}
function carrierStreamDigest(streamId: string): string { return scopeHash(streamId); }
function carrierChunkObjectKey(scope: GatewayResourceScope, setId: string, streamDigest: string, chunkIndex: number): string {
  return `carrier/quarantine/t:${scopeHash(scope.tenantId)}/p:${scopeHash(scope.principalKey)}/s:${scopeHash(scope.mcpSessionId)}/set:${setId}/stream:${streamDigest}/chunk:${String(chunkIndex)}`;
}

function assertCarrierId(name: string, value: string): void {
  if (value.length < 1 || value.length > 512 || /[\u0000\r\n]/u.test(value)) {
    fail("invalid_input", `${name} is invalid`);
  }
}

function artifactUri(scope: GatewayResourceScope, refId: string): string {
  return `revagent://artifact/p/${scopeHash(scope.principalKey)}/s/${scopeHash(scope.mcpSessionId)}/t/${scopeHash(scope.tenantId)}/a/${scopeHash(scope.actorId)}/r/${scopeHash(refId)}`;
}

function resultUri(scope: GatewayResourceScope, refId: string, page = 0): string {
  return `revagent://result/p/${scopeHash(scope.principalKey)}/s/${scopeHash(scope.mcpSessionId)}/t/${scopeHash(scope.tenantId)}/a/${scopeHash(scope.actorId)}/r/${scopeHash(refId)}/page/${String(page)}`;
}

interface ParsedScopedResourceUri {
  readonly kind: GatewayResourceKind;
  readonly refHash: string;
  readonly page: number;
}

/**
 * Rejects legacy/unscoped URIs before touching protocol metadata or object
 * storage.  Hash comparisons deliberately stay constant-time so foreign
 * session probes cannot distinguish an otherwise valid resource locator.
 */
function parseScopedResourceUri(
  scope: GatewayResourceScope,
  effectiveMcpRequestScope: EffectiveMcpRequestScopeV1,
  uri: URL,
  comparisonObserver: ScopedUriComparisonObserver | undefined,
): ParsedScopedResourceUri {
  assertScope(scope);
  assertEffectiveScope(scope, effectiveMcpRequestScope);
  const parts = uri.pathname.split("/").filter(Boolean);
  const expectedPrincipal = scopeHash(scope.principalKey);
  const expectedSession = scopeHash(scope.mcpSessionId);
  const expectedTenant = scopeHash(scope.tenantId);
  const expectedActor = scopeHash(scope.actorId);
  const parsedPrincipal = parts[1] ?? "";
  const parsedSession = parts[3] ?? "";
  const parsedTenant = parts[5] ?? "";
  const parsedActor = parts[7] ?? "";
  const parsedRef = parts[9] ?? "";
  let invalid =
    Number(uri.protocol !== "revagent:") |
    Number(parts[0] !== "p") |
    Number(parts[2] !== "s") |
    Number(parts[4] !== "t") |
    Number(parts[6] !== "a") |
    Number(parts[8] !== "r") |
    Number(!SHA256_HEX_PATTERN.test(parsedRef));
  invalid |= Number(
    !sameHash(
      expectedPrincipal,
      parsedPrincipal,
      "p",
      comparisonObserver,
    ),
  );
  invalid |= Number(
    !sameHash(expectedSession, parsedSession, "s", comparisonObserver),
  );
  invalid |= Number(
    !sameHash(expectedTenant, parsedTenant, "t", comparisonObserver),
  );
  invalid |= Number(
    !sameHash(expectedActor, parsedActor, "a", comparisonObserver),
  );
  if (invalid !== 0) {
    fail("scope_denied", "resource URI is not bound to the effective MCP scope");
  }
  if (uri.hostname === "artifact" && parts.length === 10) {
    return Object.freeze({ kind: "artifact_ref" as const, refHash: parsedRef, page: 0 });
  }
  if (uri.hostname === "result" && parts.length === 12) {
    const page = Number(parts[11]);
    if (!Number.isSafeInteger(page) || page < 0 || String(page) !== parts[11]) {
      fail("not_found", "result_ref page was not found");
    }
    return Object.freeze({ kind: "result_ref" as const, refHash: parsedRef, page });
  }
  fail("not_found", "resource URI does not match a scoped artifact or result ref");
}

function splitResultBytes(bytes: Uint8Array, pageSize: number): readonly Uint8Array[] {
  const pages: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += pageSize) {
    pages.push(bytes.slice(offset, Math.min(offset + pageSize, bytes.byteLength)));
  }
  return pages.length === 0 ? [new Uint8Array()] : pages;
}

export class GatewayResourceAuthority {
  readonly #protocolStore: GatewayProtocolStore;
  readonly #objectStore: ObjectStorePort;
  readonly #now: () => number;
  readonly #newRefId: () => string;
  readonly #maxUploadBytes: number;
  readonly #maxResultBytes: number;
  readonly #maxResultPageBytes: number;
  readonly #defaultTtlMs: number;
  readonly #gcOwnerId: string;
  readonly #scopeUriComparisonObserver: ScopedUriComparisonObserver | undefined;
  readonly #protectedObjectStore: ProtectedObjectStorePort | undefined;
  readonly #reauthorizeRecoveryScope: ((input: RecoveryOwner) => Promise<RecoveryCurrentAuthorization | null> | RecoveryCurrentAuthorization | null) | undefined;

  public constructor(options: GatewayResourceAuthorityOptions) {
    this.#protocolStore = options.protocolStore;
    this.#objectStore = options.objectStore;
    this.#now = options.now ?? Date.now;
    this.#newRefId = options.newRefId ?? randomUUID;
    this.#maxUploadBytes = options.maxUploadBytes ?? 2 * 1024 * 1024;
    this.#maxResultBytes = options.maxResultBytes ?? 32 * 1024 * 1024;
    this.#maxResultPageBytes = options.maxResultPageBytes ?? 512 * 1024;
    this.#defaultTtlMs = options.defaultTtlMs ?? 15 * 60 * 1_000;
    this.#gcOwnerId = options.gcOwnerId ?? `gateway-resource-gc:${randomUUID()}`;
    this.#protectedObjectStore = options.protectedObjectStore;
    this.#reauthorizeRecoveryScope = options.reauthorizeRecoveryScope;
    const observer = Object.getOwnPropertyDescriptor(
      options,
      TEST_SCOPE_URI_COMPARISON_OBSERVER,
    )?.value;
    this.#scopeUriComparisonObserver =
      typeof observer === "function" ? observer : undefined;
    for (const [name, value] of Object.entries({
      maxUploadBytes: this.#maxUploadBytes,
      maxResultBytes: this.#maxResultBytes,
      maxResultPageBytes: this.#maxResultPageBytes,
      defaultTtlMs: this.#defaultTtlMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    if (this.#gcOwnerId.length < 1 || this.#gcOwnerId.length > 512 || /[\u0000\r\n]/u.test(this.#gcOwnerId)) {
      throw new RangeError("gcOwnerId must be a bounded non-empty string");
    }
  }

  /**
   * Stages one omitted-payload receipt.  It is intentionally not a generic
   * object upload: the caller presents the complete recovery owner tuple and
   * a strictly ordered bridge receipt.  No URI or plaintext is returned.
   */
  public async stageRecoveryChunk(input: StageRecoveryChunkInput): Promise<void> {
    assertScope(input.scope);
    assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    this.#assertRecoveryOwner(input.scope, input.owner);
    const protectedStore = this.#recoveryStore();
    if (input.contentType !== "application/json" || !Number.isSafeInteger(input.bridgeSequence) || input.bridgeSequence < 0 || !Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) {
      fail("protocol_fault", "recovery chunk identity is invalid");
    }
    const bytes = decodeRecoveryChunk(input.data);
    try {
    const expiresAtMs = this.#recoveryExpiry(input.expiresAtMs);
    const key = recoveryChunkKey(input.owner, input.chunkIndex);
    const storageKey = recoveryStorageKey(input.owner, "chunk", input.chunkIndex);
    const digest = sha256(bytes);
    const existing = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RECOVERY_CHUNK_NAMESPACE, key));
    if (!existing.ok) fail("storage_unavailable", "recovery receipt unavailable");
    const previous = asRecoveryChunk(existing.value?.value);
    if (previous !== null) {
      if (!sameRecoveryChunk(previous, input.owner, input.bridgeSequence, input.chunkIndex, digest, bytes.byteLength) || previous.expiresAtMs !== expiresAtMs) {
        fail("not_found", "recovery receipt unavailable");
      }
      if (previous.state === "active") return;
      await this.#writeProtectedRecoveryChunk(input.scope, protectedStore, previous, bytes, input.commitBridge);
      return;
    }
    if (input.chunkIndex > 0) {
      const prior = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RECOVERY_CHUNK_NAMESPACE, recoveryChunkKey(input.owner, input.chunkIndex - 1)));
      const priorRecord = prior.ok ? asRecoveryChunk(prior.value?.value) : null;
      if (priorRecord === null || priorRecord.state !== "active" || priorRecord.bridgeSequence >= input.bridgeSequence) fail("not_found", "recovery receipt unavailable");
    }
    const kid = await protectedStore.activeKid();
    if (kid === null) fail("storage_unavailable", "recovery key is unavailable");
    const record: RecoveryChunkRecord = Object.freeze({ schemaVersion: "revagent-gateway-recovery/v1", state: "writing", owner: input.owner, bridgeSequence: input.bridgeSequence, chunkIndex: input.chunkIndex, kid, storageKey, plainDigest: digest, resultRefDigest: recoveryResultRefDigest(bytes), plainLength: bytes.byteLength, expiresAtMs });
    const reserved = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => {
      tx.stage({ namespace: RECOVERY_CHUNK_NAMESPACE, key, value: record as unknown as GatewayJsonValue, expect: { kind: "absent" } });
    });
    if (reserved.ok) {
      await this.#writeProtectedRecoveryChunk(input.scope, protectedStore, record, bytes, input.commitBridge);
      return;
    }
    // A CAS loser never reports a transient write as failure without reading
    // the exact durable receipt: identical callers join the same lifecycle.
    const joined = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RECOVERY_CHUNK_NAMESPACE, key));
    const winner = joined.ok ? asRecoveryChunk(joined.value?.value) : null;
    if (winner === null || !sameRecoveryChunk(winner, input.owner, input.bridgeSequence, input.chunkIndex, digest, bytes.byteLength) || winner.expiresAtMs !== expiresAtMs) fail("not_found", "recovery receipt unavailable");
    if (winner.state !== "active") await this.#writeProtectedRecoveryChunk(input.scope, protectedStore, winner, bytes, input.commitBridge);
    } finally { bytes.fill(0); }
  }

  /**
   * Produces a normal scoped result_ref only after all receipts are durable,
   * decryptable, exact-digest verified, and reauthorized at the post-stream
   * boundary.  It returns reference metadata only.
   */
  public async finalizeRecoveryResultRef(input: FinalizeRecoveryResultInput): Promise<GatewayResultRef> {
    assertScope(input.scope); assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    this.#assertRecoveryOwner(input.scope, input.owner);
    const protectedStore = this.#recoveryStore();
    if (!Number.isSafeInteger(input.terminalChunkCount) || input.terminalChunkCount < 1 || !Number.isSafeInteger(input.terminalByteLength) || input.terminalByteLength < 0 || input.terminalByteLength > this.#maxResultBytes) fail("protocol_fault", "recovery terminal is invalid");
    const chunks = await this.#loadRecoveryChunks(input.scope, input.owner, input.terminalChunkCount);
    // A recovered ref can never outlive any of its raw receipts; the terminal
    // caller may shorten but cannot extend that bounded lifetime.
    const expiry = Math.min(this.#recoveryExpiry(input.expiresAtMs), ...chunks.map((chunk) => chunk.expiresAtMs));
    const completionKey = recoveryCompletionKey(input.owner);
    const prior = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RECOVERY_COMPLETION_NAMESPACE, completionKey));
    if (!prior.ok) fail("storage_unavailable", "recovery completion unavailable");
    const previous = asRecoveryCompletion(prior.value?.value);
    if (previous !== null) {
      if (!sameRecoveryOwner(previous.owner, input.owner) || previous.expiresAtMs !== expiry) fail("not_found", "recovery completion unavailable");
      if (previous.state === "active") return this.#deliverRecoveryResultRef(input.scope, input.owner, previous.refId);
      return this.#resumeRecoveryFinalize(input, protectedStore, previous);
    }
    const bytes = await this.#readRecoveryBytes(input.scope, protectedStore, chunks);
    try {
      if (bytes.byteLength !== input.terminalByteLength || sha256(bytes) !== input.owner.originResultDigest) fail("not_found", "recovery terminal unavailable");
      const refId = this.#validatedRefId();
      const completion: RecoveryCompletionRecord = Object.freeze({ schemaVersion: "revagent-gateway-recovery/v1", state: "writing", owner: input.owner, refId, expiresAtMs: expiry });
      const stored = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => {
        tx.stage({ namespace: RECOVERY_COMPLETION_NAMESPACE, key: completionKey, value: completion as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      });
      if (stored.ok) return await this.#resumeRecoveryFinalize(input, protectedStore, completion, bytes);
      const joined = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RECOVERY_COMPLETION_NAMESPACE, completionKey));
      const winner = joined.ok ? asRecoveryCompletion(joined.value?.value) : null;
      if (winner === null || !sameRecoveryOwner(winner.owner, input.owner) || winner.expiresAtMs !== expiry) fail("not_found", "recovery completion unavailable");
      if (winner.state === "active") return this.#deliverRecoveryResultRef(input.scope, input.owner, winner.refId);
      return await this.#resumeRecoveryFinalize(input, protectedStore, winner, bytes);
    } finally { bytes.fill(0); }
  }

  /**
   * A capability is not evidence of a carrier.  The bridge may grant carrier
   * capabilities only when this exact authority owns its exact protocol store
   * and has a non-stub object-store port.  No serving path calls this as a
   * production readiness assertion.
   */
  public isBridgeCarrierReady(
    protocolStore: GatewayProtocolStore,
    objectStore?: ObjectStorePort,
  ): boolean {
    return this.#protocolStore === protocolStore &&
      (objectStore === undefined || this.#objectStore === objectStore) &&
      this.#objectStore.kind !== "unavailable";
  }

  /** Durable receipt/ack plus Bridge inbound sequence in one Tx-B commit. */
  public async acceptBridgeChunk(input: BridgeCarrierChunkInput): Promise<void> {
    assertScope(input.scope);
    assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    assertCarrierId("rsid", input.rsid);
    assertCarrierId("invocationId", input.invocationId);
    const chunk = input.chunk;
    const bytes = decodeCarrierChunk(chunk);
    const setId = await this.#setIdFor(
      input.scope,
      input.rsid,
      input.invocationId,
      input.expiresAtMs,
    );
    await this.#persistCarrierChunk({
      scope: input.scope,
      effectiveMcpRequestScope: input.effectiveMcpRequestScope,
      setId,
      rsid: input.rsid,
      invocationId: input.invocationId,
      streamDigest: carrierStreamDigest(chunk.stream_id),
      chunkIndex: chunk.chunk_index,
      sequence: input.sequence,
      bytes,
      digest: sha256(bytes),
      streamId: chunk.stream_id,
      contentType: chunk.content_type,
      artifactId: (chunk as RbpStreamChunk & { artifact_id?: string }).artifact_id ?? null,
      artifactIndex: (chunk as RbpStreamChunk & { artifact_index?: number }).artifact_index ?? null,
      expiresAtMs: input.expiresAtMs,
    }, input.commitBridge);
  }

  /** Stage C atomically makes artifacts, terminal ack, and Bridge terminal visible. */
  public async acceptBridgeTerminal(input: BridgeCarrierTerminalInput): Promise<readonly GatewayArtifactRef[]> {
    assertScope(input.scope);
    assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    assertCarrierId("rsid", input.rsid);
    assertCarrierId("invocationId", input.invocationId);
    const setId = await this.#setIdFor(input.scope, input.rsid, input.invocationId, undefined);
    await this.#stageCarrierTerminal(input.scope, setId, input.rsid, input.invocationId, input.manifest);
    return await this.#resumeCarrier(input.scope, input.effectiveMcpRequestScope, setId, input.commitBridge);
  }

  /** A chunked invocation result remains private until its terminal Tx-C commits. */
  public async acceptBridgeChunkedResultTerminal(
    input: BridgeChunkedResultTerminalInput,
  ): Promise<GatewayJsonValue> {
    assertScope(input.scope);
    assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    assertCarrierId("rsid", input.rsid);
    assertCarrierId("invocationId", input.invocationId);
    const setId = await this.#setIdFor(input.scope, input.rsid, input.invocationId, undefined);
    await this.#stageCarrierTerminal(input.scope, setId, input.rsid, input.invocationId, input.manifest);
    return await this.#activateChunkedResult(input.scope, setId, input.manifest, input.commitBridge);
  }

  public async uploadArtifact(input: UploadArtifactInput): Promise<GatewayArtifactRef> {
    assertScope(input.scope);
    if (!safeFilename(input.filename)) {
      fail("invalid_input", "filename is not a safe leaf name");
    }
    if (!(GW9_ALLOWED_UPLOAD_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      fail("content_type_denied", "upload content type is not allowlisted");
    }
    const bytes = new Uint8Array(input.bytes);
    if (bytes.byteLength > this.#maxUploadBytes) {
      fail("oversize", "upload exceeds the configured byte limit");
    }
    const digest = sha256(bytes);
    if (input.expectedDigest !== undefined && input.expectedDigest !== digest) {
      fail("digest_mismatch", "upload digest does not match expectedDigest");
    }
    return this.#storeArtifact({
      scope: input.scope,
      filename: input.filename,
      contentType: input.contentType,
      bytes,
      digest,
      expiresAtMs: this.#expiry(input.expiresAtMs),
      quarantineStatus: input.quarantineStatus,
      source: "north_upload",
      invocationId: null,
      artifactIndex: null,
    });
  }

  public async ingestRbpArtifactCarrier(
    input: IngestRbpArtifactCarrierInput,
  ): Promise<readonly GatewayArtifactRef[]> {
    assertScope(input.scope);
    assertCarrierId("rsid", input.rsid);
    assertCarrierId("invocationId", input.invocationId);
    if (input.manifest.descriptors.some((item) => !safeFilename(item.filename))) {
      fail("invalid_input", "RBP artifact filename is not a safe leaf name");
    }
    assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    const effectiveMcpRequestScope = input.effectiveMcpRequestScope;
    const setId = await this.#setIdFor(input.scope, input.rsid, input.invocationId, input.expiresAtMs);
    // Receipt is independently durable.  A terminal can be replayed after a
    // restart, but never turns a receipt into a public ref by itself.
    for (const [sequence, chunk] of input.chunks.entries()) {
      const bytes = decodeCarrierChunk(chunk);
      await this.stageChunk({
        scope: input.scope, effectiveMcpRequestScope, setId, rsid: input.rsid,
        invocationId: input.invocationId, streamDigest: carrierStreamDigest(chunk.stream_id),
        chunkIndex: chunk.chunk_index, sequence, bytes,
        digest: sha256(bytes), streamId: chunk.stream_id, contentType: chunk.content_type,
        artifactId: (chunk as RbpStreamChunk & { artifact_id?: string }).artifact_id ?? null,
        artifactIndex: (chunk as RbpStreamChunk & { artifact_index?: number }).artifact_index ?? null,
        expiresAtMs: input.expiresAtMs,
      });
    }
    await this.#stageCarrierTerminal(input.scope, setId, input.rsid, input.invocationId, input.manifest);
    return this.#resumeCarrier(input.scope, effectiveMcpRequestScope, setId);
  }

  public async stageChunk(input: StageCarrierChunkInput): Promise<void> {
    assertScope(input.scope);
    assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    assertSetId(input.setId);
    assertCarrierId("rsid", input.rsid); assertCarrierId("invocationId", input.invocationId);
    if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0 ||
        !Number.isSafeInteger(input.sequence) || input.sequence < 0 ||
        input.streamDigest !== carrierStreamDigest(input.streamId) ||
        (input.streamId === "result"
          ? input.artifactId !== null || input.artifactIndex !== null
          : input.streamId !== `artifact:${input.artifactId ?? ""}` || input.artifactId === null || input.artifactIndex === null || !Number.isSafeInteger(input.artifactIndex) || input.artifactIndex < 0) ||
        input.bytes.byteLength > 1_048_576 || sha256(input.bytes) !== input.digest) {
      fail("protocol_fault", "carrier chunk identity is invalid");
    }
    await this.#persistCarrierChunk(input);
  }

  /** Restart entrypoint: resumes verified work and only publishes in stage C. */
  public async recoverIncomplete(input: {
    readonly scope: GatewayResourceScope;
    readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
    readonly setId?: string;
  }): Promise<readonly GatewayArtifactRef[]> {
    assertScope(input.scope); assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    const sets = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, async (tx) =>
      (await tx.list(RESOURCE_SET_NAMESPACE)).map((row) => row.value as unknown as CarrierSetRecord)
        .filter((set) => set.tenantId === input.scope.tenantId && set.principalKey === input.scope.principalKey &&
          set.effectiveMcpSessionId === input.scope.mcpSessionId && set.state !== "active" && set.state !== "cleanup_pending" && set.state !== "gc_claimed" &&
          (input.setId === undefined || set.setId === input.setId)),
    );
    if (!sets.ok) fail("storage_unavailable", sets.message);
    const refs: GatewayArtifactRef[] = [];
    for (const set of sets.value) {
      const terminal = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(CARRIER_TERMINAL_NAMESPACE, carrierSetKey(set.setId)));
      if (!terminal.ok) fail("storage_unavailable", terminal.message);
      if (terminal.value === null) { await this.#cleanPrivateCarrierSet(input.scope, set.setId); continue; }
      try {
        refs.push(...await this.#resumeCarrier(input.scope, input.effectiveMcpRequestScope, set.setId));
      } catch (error) {
        if (set.state === "verified") throw error;
        await this.#cleanPrivateCarrierSet(input.scope, set.setId);
      }
    }
    return Object.freeze(refs);
  }

  /** WP-11 may call this one bounded recovery surface after bridge restart. */
  public async recoverAll(input: {
    readonly scope: GatewayResourceScope;
    readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  }): Promise<readonly GatewayArtifactRef[]> {
    return this.recoverIncomplete(input);
  }

  public async boundResult(input: {
    readonly scope: GatewayResourceScope;
    readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
    readonly value: GatewayJsonValue;
    readonly maxInlineBytes: number;
    readonly expiresAtMs?: number;
  }): Promise<BoundedGatewayResult> {
    assertScope(input.scope);
    assertEffectiveScope(input.scope, input.effectiveMcpRequestScope);
    if (!Number.isSafeInteger(input.maxInlineBytes) || input.maxInlineBytes < 0) {
      fail("invalid_input", "maxInlineBytes must be a non-negative safe integer");
    }
    const bytes = Buffer.from(JSON.stringify(input.value), "utf8");
    if (bytes.byteLength <= input.maxInlineBytes) {
      return Object.freeze({ kind: "inline" as const, value: input.value });
    }
    if (bytes.byteLength > this.#maxResultBytes) {
      fail("oversize", "structured result exceeds the configured byte limit");
    }
    const refId = this.#validatedRefId();
    await this.#assertRefAbsent(input.scope, "result_ref", refId);
    const digest = sha256(bytes);
    const key = storageKey(input.scope, "result_ref", refId, digest);
    const pages = splitResultBytes(bytes, this.#maxResultPageBytes);
    const record: ResultRecord = Object.freeze({
      schemaVersion: "revagent-gateway-resource/v1",
      kind: "result_ref",
      refId,
      actorId: input.scope.actorId,
      principalKey: input.scope.principalKey,
      mcpSessionId: input.scope.mcpSessionId,
      createdAtMs: this.#now(),
      expiresAtMs: this.#expiry(input.expiresAtMs),
      contentType: "application/json",
      byteSize: bytes.byteLength,
      digest,
      pageSize: this.#maxResultPageBytes,
      pageCount: pages.length,
      storageKey: key,
      lifecycle: "allocating" as const,
    });
    if (!await this.#writeRecords(input.scope, [record])) {
      fail("storage_unavailable", "result_ref allocation metadata was not durably accepted");
    }
    const put = await this.#objectStore.put({
      tenantId: input.scope.tenantId,
      storageKey: key,
      bytes,
      contentType: "application/json",
    });
    if (!put.ok) {
      await this.#deleteRecords(input.scope, [record]);
      fail("storage_unavailable", put.message);
    }
    if (put.value.storageKey !== key) {
      await this.#objectStore.delete({
        tenantId: input.scope.tenantId,
        storageKey: key,
      });
      await this.#deleteRecords(input.scope, [record]);
      fail("storage_unavailable", "object store changed the requested storage key");
    }
    if (!await this.#activateRecord(input.scope, record)) {
      await this.#objectStore.delete({ tenantId: input.scope.tenantId, storageKey: key });
      await this.#deleteRecords(input.scope, [record]);
      fail("storage_unavailable", "result_ref verification metadata was not durably accepted");
    }
    return Object.freeze({
      kind: "result_ref" as const,
      refId,
      uri: resultUri(input.scope, refId),
      contentType: "application/json" as const,
      byteSize: bytes.byteLength,
      digest,
      pageCount: pages.length,
      expiresAtMs: record.expiresAtMs,
    });
  }

  public async consumeArtifact(
    scope: GatewayResourceScope,
    effectiveMcpRequestScope: EffectiveMcpRequestScopeV1,
    refId: string,
  ): Promise<GatewayResourceRead> {
    return this.readResource(
      scope,
      effectiveMcpRequestScope,
      new URL(artifactUri(scope, refId)),
    );
  }

  public async readResource(
    scope: GatewayResourceScope,
    effectiveMcpRequestScope: EffectiveMcpRequestScopeV1,
    uri: URL,
  ): Promise<GatewayResourceRead> {
    const parsed = parseScopedResourceUri(
      scope,
      effectiveMcpRequestScope,
      uri,
      this.#scopeUriComparisonObserver,
    );
    const record = await this.#readRecord(scope, parsed.kind, parsed.refHash);
    if (record.kind !== "artifact_ref") {
      if (record.kind !== "result_ref") {
        fail("not_found", "artifact_ref was not found");
      }
    }
    if (record.kind === "artifact_ref") {
      const bytes = await this.#verifiedBytes(scope, record);
      return Object.freeze({
        uri: artifactUri(scope, record.refId),
        contentType: record.contentType,
        bytes,
        digest: record.digest,
        nextPageUri: null,
      });
    }
    if (!Number.isSafeInteger(parsed.page) || parsed.page < 0 || parsed.page >= record.pageCount) {
      fail("not_found", "result_ref page was not found");
    }
    const allBytes = await this.#verifiedBytes(scope, record);
    try {
      const start = parsed.page * record.pageSize;
      // `slice` makes the page the caller-owned transfer buffer; the complete
      // protected result is wiped before this method returns.
      const bytes = new Uint8Array(allBytes.subarray(start, Math.min(start + record.pageSize, allBytes.byteLength)));
      return Object.freeze({
        uri: resultUri(scope, record.refId, parsed.page),
        contentType: record.contentType,
        bytes,
        digest: sha256(bytes),
        nextPageUri: parsed.page + 1 < record.pageCount
          ? resultUri(scope, record.refId, parsed.page + 1)
          : null,
      });
    } finally { allBytes.fill(0); }
  }

  /**
   * Claims at most 100 expired refs with a 60-second fenced lease.  Metadata
   * is removed only after an idempotent object delete; a failed delete leaves
   * the claim for a later collector once the lease expires.
   */
  public async collectExpired(input: {
    readonly tenantId: string;
    readonly limit?: number;
  }): Promise<GatewayResourceGcResult> {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || input.tenantId.length < 1) {
      fail("invalid_input", "resource GC requires a tenant and a limit from 1 to 100");
    }
    const now = this.#now();
    const candidates = await this.#protocolStore.transact({ tenantId: input.tenantId }, async (tx) =>
      (await tx.list(RESOURCE_NAMESPACE)).filter((stored) => {
        const record = asJsonRecord(stored.value);
        return record !== null && record.expiresAtMs <= now;
      }).slice(0, limit),
    );
    if (!candidates.ok) fail("storage_unavailable", candidates.message);
    let claimed = 0;
    let deleted = 0;
    let retained = 0;
    for (const candidate of candidates.value) {
      const claim = await this.#claimExpired(input.tenantId, candidate.key, candidate.version, now);
      if (claim === null) { retained += 1; continue; }
      claimed += 1;
      const removed = claim.record.kind === "result_ref" && claim.record.protectedRecovery !== undefined
        ? await this.#deleteProtectedRecoveryObject(claim.record.protectedRecovery, claim.record.expiresAtMs, Object.freeze({ id: claim.record.gcLease!.claimToken, version: claim.version }))
        : await this.#objectStore.delete({ tenantId: input.tenantId, storageKey: claim.record.storageKey });
      // Object stores must make delete retry/not-found success. A non-success
      // response is deliberately retained for retry rather than losing the
      // metadata proof while bytes may still exist.
      if (!removed.ok) { retained += 1; continue; }
      const finalized = await this.#protocolStore.transact({ tenantId: input.tenantId }, async (tx) => {
        const current = await tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, candidate.key);
        if (current === null || current.version !== claim.version) return false;
        const currentRecord = asJsonRecord(current.value);
        if (
          currentRecord === null ||
          (currentRecord.lifecycle !== "gc_claimed" && currentRecord.lifecycle !== "deleting") ||
          currentRecord.gcLease?.owner !== this.#gcOwnerId ||
          currentRecord.gcLease.claimToken !== claim.record.gcLease?.claimToken ||
          currentRecord.gcLease.expiresAtMs !== claim.record.gcLease?.expiresAtMs
        ) return false;
        tx.stage({ namespace: RESOURCE_NAMESPACE, key: candidate.key, value: null, expect: { kind: "version", version: current.version } });
        return true;
      });
      if (!finalized.ok || !finalized.value) { retained += 1; continue; }
      deleted += 1;
    }
    const remaining = Math.max(0, limit - candidates.value.length);
    const carrier = await this.#collectExpiredCarrierSets(input.tenantId, remaining, now);
    const recovery = await this.#collectExpiredRecovery(input.tenantId, Math.max(0, remaining - carrier.scanned), now);
    return Object.freeze({ scanned: candidates.value.length + carrier.scanned + recovery.scanned, claimed: claimed + carrier.claimed + recovery.claimed, deleted: deleted + carrier.deleted + recovery.deleted, retained: retained + carrier.retained + recovery.retained });
  }

  /** C39 cleanup has no replay path: delete encrypted bytes before removing a
   * terminally expired private receipt, then remove its completion marker. */
  async #collectExpiredRecovery(tenantId: string, limit: number, now: number): Promise<GatewayResourceGcResult> {
    if (limit < 1) return Object.freeze({ scanned: 0, claimed: 0, deleted: 0, retained: 0 });
    const listed = await this.#protocolStore.transact({ tenantId }, async (tx) => (await tx.list(RECOVERY_CHUNK_NAMESPACE)).map((row) => ({ row, record: asRecoveryChunk(row.value) })).filter((item) => item.record !== null && item.record.expiresAtMs <= now).slice(0, Math.min(100, limit)));
    if (!listed.ok) fail("storage_unavailable", "recovery GC unavailable");
    let claimed = 0; let deleted = 0; let retained = 0;
    for (const item of listed.value) {
      const record = item.record!;
      if (record.state === "active") {
        const completion = await this.#protocolStore.transact({ tenantId }, (tx) => tx.read<GatewayJsonValue>(RECOVERY_COMPLETION_NAMESPACE, recoveryCompletionKey(record.owner)));
        const terminal = completion.ok ? asRecoveryCompletion(completion.value?.value) : null;
        // A terminal in progress owns its active receipts for restart.  Once
        // active, resource GC has already fenced the public ref before this
        // private-chunk collector can remove the ciphertext.
        if (terminal !== null && terminal.state !== "active") { retained += 1; continue; }
      }
      const claim = await this.#protocolStore.transact({ tenantId }, async (tx): Promise<RecoveryChunkRecord | null> => {
        const current = await tx.read<GatewayJsonValue>(RECOVERY_CHUNK_NAMESPACE, item.row.key);
        const candidate = asRecoveryChunk(current?.value);
        if (current === null || candidate === null || candidate.expiresAtMs > now) return null;
        if (candidate.state === "deleting") return candidate;
        const deleting: RecoveryChunkRecord = Object.freeze({ ...candidate, state: "deleting", deletionClaim: Object.freeze({ id: randomUUID(), version: current.version + 1 }) });
        tx.stage({ namespace: RECOVERY_CHUNK_NAMESPACE, key: current.key, value: deleting as unknown as GatewayJsonValue, expect: { kind: "version", version: current.version } });
        return deleting;
      });
      if (!claim.ok || claim.value === null) { retained += 1; continue; }
      claimed += 1;
      const removed = await this.#deleteProtectedRecoveryObject(claim.value, claim.value.expiresAtMs, claim.value.deletionClaim!);
      // `missing` is idempotent only after this exact row has been CAS-marked
      // deleting.  Tamper/key/decrypt failures remain opaque non-success.
      if (!removed.ok) { retained += 1; continue; }
      const finalized = await this.#protocolStore.transact({ tenantId }, async (tx) => {
        const current = await tx.read<GatewayJsonValue>(RECOVERY_CHUNK_NAMESPACE, item.row.key);
        const deleting = asRecoveryChunk(current?.value);
        if (current === null || deleting?.state !== "deleting" || deleting.deletionClaim?.id !== claim.value!.deletionClaim!.id || deleting.deletionClaim.version !== claim.value!.deletionClaim!.version) return false;
        tx.stage({ namespace: RECOVERY_CHUNK_NAMESPACE, key: current.key, value: null, expect: { kind: "version", version: current.version } });
        return true;
      });
      if (!finalized.ok || !finalized.value) { retained += 1; continue; }
      deleted += 1;
    }
    const completions = await this.#protocolStore.transact({ tenantId }, async (tx) => {
      const chunks = (await tx.list(RECOVERY_CHUNK_NAMESPACE)).map((row) => asRecoveryChunk(row.value)).filter((record): record is RecoveryChunkRecord => record !== null);
      for (const row of await tx.list(RECOVERY_COMPLETION_NAMESPACE)) {
        const completion = asRecoveryCompletion(row.value);
        if (completion !== null && completion.expiresAtMs <= now && !chunks.some((chunk) => sameRecoveryOwner(chunk.owner, completion.owner))) tx.stage({ namespace: RECOVERY_COMPLETION_NAMESPACE, key: row.key, value: null, expect: { kind: "version", version: row.version } });
      }
    });
    if (!completions.ok) retained += 1;
    return Object.freeze({ scanned: listed.value.length, claimed, deleted, retained });
  }

  /** Carrier expiry is independently fenced: bytes first, then every private
   * namespace and finally the private identity index.  Not-found deletes are
   * success; uncertain deletes preserve the cleanup claim for retry. */
  async #collectExpiredCarrierSets(tenantId: string, limit: number, now: number): Promise<GatewayResourceGcResult> {
    if (limit < 1) return Object.freeze({ scanned: 0, claimed: 0, deleted: 0, retained: 0 });
    const listed = await this.#protocolStore.transact({ tenantId }, async (tx) =>
      (await tx.list(RESOURCE_SET_NAMESPACE)).map((row) => ({ row, set: row.value as unknown as CarrierSetRecord }))
        .filter(({ set }) => set.tenantId === tenantId && set.expiresAtMs <= now).slice(0, Math.min(100, limit)),
    );
    if (!listed.ok) fail("storage_unavailable", listed.message);
    let claimed = 0; let deleted = 0; let retained = 0;
    for (const candidate of listed.value) {
      const token = randomUUID();
      const claim = await this.#protocolStore.transact({ tenantId }, async (tx) => {
        const row = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, candidate.row.key); if (row === null || row.version !== candidate.row.version) return false;
        const set = row.value as unknown as CarrierSetRecord;
        if ((set.state === "cleanup_pending" || set.state === "gc_claimed") && set.gcLease !== undefined && set.gcLease.expiresAtMs > now) return false;
        tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: row.key, value: { ...set, state: "gc_claimed", gcLease: { owner: this.#gcOwnerId, token, expiresAtMs: now + 60_000, claimVersion: row.version }, cleanupGeneration: (set.cleanupGeneration ?? 0) + 1 } as unknown as GatewayJsonValue, expect: { kind: "version", version: row.version } }); return true;
      });
      if (!claim.ok || !claim.value) { retained += 1; continue; }
      claimed += 1;
      const keys = await this.#protocolStore.transact({ tenantId }, async (tx) => {
        const chunks = (await tx.list(CARRIER_CHUNK_NAMESPACE)).map((r) => r.value as unknown as CarrierChunkRecord).filter((r) => r.setId === candidate.set.setId).map((r) => r.storageKey);
        const members = (await tx.list(RESOURCE_SET_MEMBER_NAMESPACE)).map((r) => r.value as unknown as CarrierMemberRecord).filter((r) => r.setId === candidate.set.setId).map((r) => r.storageKey);
        return [...chunks, ...members];
      });
      if (!keys.ok) { retained += 1; continue; }
      let allDeleted = true;
      for (const storageKey of keys.value) { const removed = await this.#objectStore.delete({ tenantId, storageKey }); if (!removed.ok) allDeleted = false; }
      if (!allDeleted) { retained += 1; continue; }
      const finalized = await this.#protocolStore.transact({ tenantId }, async (tx) => {
        const setRow = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, candidate.row.key); const set = setRow?.value as unknown as CarrierSetRecord | undefined;
        if (setRow === null || set?.state !== "gc_claimed" || set.gcLease?.owner !== this.#gcOwnerId || set.gcLease.token !== token || set.gcLease.claimVersion.length < 1) return false;
        for (const namespace of [CARRIER_CHUNK_NAMESPACE, RESOURCE_SET_MEMBER_NAMESPACE, CARRIER_ACK_NAMESPACE, CARRIER_TERMINAL_NAMESPACE, RESOURCE_NAMESPACE] as const) {
          for (const row of await tx.list(namespace)) {
            const value = row.value as { setId?: string; carrierSetId?: string };
            if (value.setId === candidate.set.setId || value.carrierSetId === candidate.set.setId) tx.stage({ namespace, key: row.key, value: null, expect: { kind: "version", version: row.version } });
          }
        }
        tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: setRow.key, value: null, expect: { kind: "version", version: setRow.version } });
        for (const row of await tx.list(CARRIER_IDENTITY_NAMESPACE)) if ((row.value as unknown as CarrierIdentityRecord).setId === candidate.set.setId) tx.stage({ namespace: CARRIER_IDENTITY_NAMESPACE, key: row.key, value: null, expect: { kind: "version", version: row.version } });
        return true;
      });
      if (!finalized.ok || !finalized.value) { retained += 1; continue; }
      deleted += 1;
    }
    return Object.freeze({ scanned: listed.value.length, claimed, deleted, retained });
  }

  /** Used only for terminal-less/failed non-public recovery.  Objects are
   * deleted before metadata; uncertainty leaves the private evidence intact. */
  async #cleanPrivateCarrierSet(scope: GatewayResourceScope, setId: string): Promise<void> {
    const owner = `${this.#gcOwnerId}:recovery`;
    const token = randomUUID();
    const claimed = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const set = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId));
      if (set === null) return false;
      const current = set.value as unknown as CarrierSetRecord;
      if (current.state === "active" || current.state === "verified" || current.state === "gc_claimed" || (current.state === "cleanup_pending" && (current.gcLease?.expiresAtMs ?? 0) > this.#now())) return false;
      tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: set.key, value: { ...current, state: "cleanup_pending", gcLease: { owner, token, expiresAtMs: this.#now() + 60_000, claimVersion: set.version }, cleanupGeneration: (current.cleanupGeneration ?? 0) + 1 } as unknown as GatewayJsonValue, expect: { kind: "version", version: set.version } });
      return true;
    });
    if (!claimed.ok || !claimed.value) fail("storage_unavailable", "carrier private cleanup claim was not accepted");
    const inventory = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => ({
      chunks: (await tx.list(CARRIER_CHUNK_NAMESPACE)).filter((row) => (row.value as unknown as CarrierChunkRecord).setId === setId),
      members: (await tx.list(RESOURCE_SET_MEMBER_NAMESPACE)).filter((row) => (row.value as unknown as CarrierMemberRecord).setId === setId),
    }));
    if (!inventory.ok) fail("storage_unavailable", inventory.message);
    for (const row of [...inventory.value.chunks, ...inventory.value.members]) {
      const storageKey = (row.value as unknown as { storageKey: string }).storageKey;
      const removed = await this.#objectStore.delete({ tenantId: scope.tenantId, storageKey });
      if (!removed.ok) fail("storage_unavailable", "carrier private cleanup is uncertain");
    }
    const deleted = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      for (const namespace of [CARRIER_CHUNK_NAMESPACE, RESOURCE_SET_MEMBER_NAMESPACE, CARRIER_ACK_NAMESPACE, CARRIER_TERMINAL_NAMESPACE] as const) {
        for (const row of await tx.list(namespace)) if ((row.value as { setId?: string }).setId === setId) tx.stage({ namespace, key: row.key, value: null, expect: { kind: "version", version: row.version } });
      }
      const set = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId));
      const current = set?.value as unknown as CarrierSetRecord | undefined;
      if (set === null || current?.state !== "cleanup_pending" || current.gcLease?.owner !== owner || current.gcLease.token !== token || current.gcLease.claimVersion.length < 1) return false;
      tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: set.key, value: null, expect: { kind: "version", version: set.version } });
      for (const row of await tx.list(CARRIER_IDENTITY_NAMESPACE)) if ((row.value as unknown as CarrierIdentityRecord).setId === setId) tx.stage({ namespace: CARRIER_IDENTITY_NAMESPACE, key: row.key, value: null, expect: { kind: "version", version: row.version } });
      return true;
    });
    if (!deleted.ok || !deleted.value) fail("storage_unavailable", "carrier private cleanup was not accepted");
  }

  async #setIdFor(scope: GatewayResourceScope, rsid: string, invocationId: string, requestedExpiry: number | undefined): Promise<string> {
    const identityKey = carrierIdentityKey(scope, rsid, invocationId);
    const allocated = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const existing = await tx.read<GatewayJsonValue>(CARRIER_IDENTITY_NAMESPACE, identityKey);
      if (existing !== null) {
        const identity = existing.value as unknown as CarrierIdentityRecord;
        if (identity.rsid !== rsid || identity.invocationId !== invocationId || identity.tenantId !== scope.tenantId || identity.principalKey !== scope.principalKey || identity.effectiveMcpSessionId !== scope.mcpSessionId) return false;
        const set = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(identity.setId));
        return set === null ? false : identity.setId;
      }
      const setId = uuidV7(this.#now());
      const identity: CarrierIdentityRecord = { schemaVersion: "revagent-gateway-carrier/v1", setId, rsid, invocationId, tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId };
      const set: CarrierSetRecord = { schemaVersion: "revagent-gateway-carrier/v1", setId, rsid, invocationId, tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId, state: "declared", expiresAtMs: this.#expiry(requestedExpiry), receivedChunkCount: 0, receivedByteCount: 0 };
      tx.stage({ namespace: CARRIER_IDENTITY_NAMESPACE, key: identityKey, value: identity as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: carrierSetKey(setId), value: set as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      return setId;
    });
    if (allocated.ok && allocated.value !== false) return allocated.value;
    // A competing identical first receipt can win the absent-CAS.  It is not
    // a protocol fault: reload its identity and prove the complete binding
    // before joining that one UUIDv7 set.  A bounded retry avoids turning a
    // damaged store into an unbounded request path.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const winner = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
        const row = await tx.read<GatewayJsonValue>(CARRIER_IDENTITY_NAMESPACE, identityKey);
        if (row === null) return null;
        const identity = row.value as unknown as CarrierIdentityRecord;
        if (identity.rsid !== rsid || identity.invocationId !== invocationId || identity.tenantId !== scope.tenantId || identity.principalKey !== scope.principalKey || identity.effectiveMcpSessionId !== scope.mcpSessionId || !UUID_V7_PATTERN.test(identity.setId)) return false;
        const set = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(identity.setId));
        const current = set?.value as unknown as CarrierSetRecord | undefined;
        return current !== undefined && current.setId === identity.setId && current.rsid === rsid && current.invocationId === invocationId && current.tenantId === scope.tenantId && current.principalKey === scope.principalKey && current.effectiveMcpSessionId === scope.mcpSessionId
          ? identity.setId : false;
      });
      if (winner.ok && typeof winner.value === "string") return winner.value;
      if (winner.ok && winner.value === false) break;
    }
    fail("protocol_fault", "carrier identity allocation conflicts with durable state");
  }

  async #persistCarrierChunk(input: StageCarrierChunkInput, commitBridge?: BridgeCarrierCommit): Promise<void> {
    const { scope, setId, rsid, invocationId } = input;
    const key = carrierChunkKey(setId, input.streamDigest, input.chunkIndex);
    const objectKey = carrierChunkObjectKey(scope, setId, input.streamDigest, input.chunkIndex);
    const identity = sha256(Buffer.from(JSON.stringify({ setId, rsid, invocationId, streamDigest: input.streamDigest, chunkIndex: input.chunkIndex, sequence: input.sequence, digest: input.digest, streamId: input.streamId, contentType: input.contentType, artifactId: input.artifactId, artifactIndex: input.artifactIndex }), "utf8"));
    const staged = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const identityRow = await tx.read<GatewayJsonValue>(CARRIER_IDENTITY_NAMESPACE, carrierIdentityKey(scope, rsid, invocationId));
      if (identityRow === null) tx.stage({ namespace: CARRIER_IDENTITY_NAMESPACE, key: carrierIdentityKey(scope, rsid, invocationId), value: { schemaVersion: "revagent-gateway-carrier/v1", setId, rsid, invocationId, tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId } as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      else { const currentIdentity = identityRow.value as unknown as CarrierIdentityRecord; if (currentIdentity.setId !== setId || currentIdentity.rsid !== rsid || currentIdentity.invocationId !== invocationId || currentIdentity.tenantId !== scope.tenantId || currentIdentity.principalKey !== scope.principalKey || currentIdentity.effectiveMcpSessionId !== scope.mcpSessionId) return false; }
      const set = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId));
      if (set === null) tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: carrierSetKey(setId), value: { schemaVersion: "revagent-gateway-carrier/v1", setId, rsid, invocationId, tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId, state: "declared", expiresAtMs: this.#expiry(input.expiresAtMs), receivedChunkCount: 1, receivedByteCount: input.bytes.byteLength } as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      else { const current = set.value as unknown as CarrierSetRecord; if (current.rsid !== rsid || current.invocationId !== invocationId || current.tenantId !== scope.tenantId || current.principalKey !== scope.principalKey || current.effectiveMcpSessionId !== scope.mcpSessionId || current.state === "cleanup_pending" || current.state === "gc_claimed") return false; }
      const existing = await tx.read<GatewayJsonValue>(CARRIER_CHUNK_NAMESPACE, key);
      if (existing !== null) return (existing.value as unknown as CarrierChunkRecord).chunkIdentity === identity ? (existing.value as unknown as CarrierChunkRecord).state : false;
      if (set !== null) {
        const current = set.value as unknown as CarrierSetRecord;
        const nextCount = (current.receivedChunkCount ?? 0) + 1;
        const nextBytes = (current.receivedByteCount ?? 0) + input.bytes.byteLength;
        const maxBytes = input.streamId === "result" ? this.#maxResultBytes : 2 * 1024 * 1024;
        if (nextCount > CARRIER_MAX_RECEIPTS || nextBytes > maxBytes) return false;
        tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: set.key, value: { ...current, receivedChunkCount: nextCount, receivedByteCount: nextBytes } as unknown as GatewayJsonValue, expect: { kind: "version", version: set.version } });
      }
      const record: CarrierChunkRecord = { schemaVersion: "revagent-gateway-carrier/v1", setId, streamDigest: input.streamDigest, chunkIndex: input.chunkIndex, sequence: input.sequence, rsid, invocationId, tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId, streamId: input.streamId, contentType: input.contentType, artifactId: input.artifactId, artifactIndex: input.artifactIndex, chunkIdentity: identity, storageKey: objectKey, byteSize: input.bytes.byteLength, digest: input.digest, state: "pending" };
      tx.stage({ namespace: CARRIER_CHUNK_NAMESPACE, key, value: record as unknown as GatewayJsonValue, expect: { kind: "absent" } }); return "pending";
    });
    if (!staged.ok || staged.value === false) fail("protocol_fault", "carrier chunk conflicts with durable state");
    if (staged.value === "pending") { const put = await this.#objectStore.put({ tenantId: scope.tenantId, storageKey: objectKey, bytes: input.bytes, contentType: "application/octet-stream" }); if (!put.ok || put.value.storageKey !== objectKey) fail("storage_unavailable", put.ok ? "carrier object key changed" : put.message); }
    const durable = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const current = await tx.read<GatewayJsonValue>(CARRIER_CHUNK_NAMESPACE, key); if (current === null || (current.value as unknown as CarrierChunkRecord).chunkIdentity !== identity) return false;
      const chunk = current.value as unknown as CarrierChunkRecord;
      if (chunk.state !== "durable") tx.stage({ namespace: CARRIER_CHUNK_NAMESPACE, key, value: { ...chunk, state: "durable" } as unknown as GatewayJsonValue, expect: { kind: "version", version: current.version } });
      const ackKey = carrierAckKey(scope, rsid, String(input.sequence)); const ack = await tx.read(CARRIER_ACK_NAMESPACE, ackKey);
      if (ack === null) tx.stage({ namespace: CARRIER_ACK_NAMESPACE, key: ackKey, value: { schemaVersion: "revagent-gateway-carrier/v1", setId, rsid, invocationId, seq: input.sequence, chunkIdentity: identity, tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId, state: "chunk_durable" } as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      else { const value = ack.value as { setId?: string; invocationId?: string; chunkIdentity?: string; state?: string; tenantId?: string; principalKey?: string; effectiveMcpSessionId?: string }; if (value.setId !== setId || value.invocationId !== invocationId || value.chunkIdentity !== identity || value.state !== "chunk_durable" || value.tenantId !== scope.tenantId || value.principalKey !== scope.principalKey || value.effectiveMcpSessionId !== scope.mcpSessionId) return false; }
      await commitBridge?.(tx, "activate");
      return true;
    });
    if (!durable.ok || !durable.value) fail("storage_unavailable", "carrier chunk durability acknowledgement was not accepted");
  }

  async #stageCarrierTerminal(scope: GatewayResourceScope, setId: string, rsid: string, invocationId: string, manifest: TerminalStreamManifest): Promise<void> {
    const outcome = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const set = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId));
      if (set === null) return false;
      const currentSet = set.value as unknown as CarrierSetRecord;
      if (currentSet.rsid !== rsid || currentSet.invocationId !== invocationId || currentSet.tenantId !== scope.tenantId || currentSet.principalKey !== scope.principalKey || currentSet.effectiveMcpSessionId !== scope.mcpSessionId || currentSet.state === "cleanup_pending" || currentSet.state === "gc_claimed") return false;
      const row = await tx.read<GatewayJsonValue>(CARRIER_TERMINAL_NAMESPACE, carrierSetKey(setId));
      if (row === null) { tx.stage({ namespace: CARRIER_TERMINAL_NAMESPACE, key: carrierSetKey(setId), value: { schemaVersion: "revagent-gateway-carrier/v1", setId, rsid, invocationId, manifest } as unknown as GatewayJsonValue, expect: { kind: "absent" } }); return true; }
      return JSON.stringify((row.value as unknown as CarrierTerminalRecord).manifest) === JSON.stringify(manifest);
    });
    if (!outcome.ok || !outcome.value) fail("incomplete", "carrier terminal conflicts with durable state");
  }

  /**
   * Chunked JSON has no public object URI in WP-11.  Rebuild from the private
   * receipts, validate the terminal digest, then commit terminal ack/set state
   * with the Bridge state callback before returning its sanitized JSON value.
   */
  async #activateChunkedResult(
    scope: GatewayResourceScope,
    setId: string,
    manifest: Extract<TerminalStreamManifest, { kind: "chunked_result" }>,
    commitBridge: BridgeCarrierCommit,
  ): Promise<GatewayJsonValue> {
    const loaded = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => ({
      set: await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId)),
      chunks: await tx.list(CARRIER_CHUNK_NAMESPACE),
    }));
    if (!loaded.ok || loaded.value.set === null) fail("storage_unavailable", loaded.ok ? "chunked carrier set is absent" : loaded.message);
    const set = loaded.value.set.value as unknown as CarrierSetRecord;
    if (set.rsid === "" || set.tenantId !== scope.tenantId || set.principalKey !== scope.principalKey || set.effectiveMcpSessionId !== scope.mcpSessionId) {
      fail("scope_denied", "chunked carrier set scope does not match");
    }
    let assembler = createStreamAssembler(set.invocationId, { maxInvocationBytes: this.#maxResultBytes });
    const receipts = loaded.value.chunks
      .map((row) => row.value as unknown as CarrierChunkRecord)
      .filter((chunk) => chunk.setId === setId)
      .sort((left, right) => left.streamId.localeCompare(right.streamId) || left.chunkIndex - right.chunkIndex);
    const sequences = new Set<number>();
    for (const chunk of receipts) {
      if (chunk.state !== "durable" || chunk.streamId !== "result" || chunk.artifactId !== null || chunk.artifactIndex !== null || sequences.has(chunk.sequence)) {
        fail("incomplete", "chunked result receipts are not one durable result stream");
      }
      sequences.add(chunk.sequence);
      const object = await this.#objectStore.get({ tenantId: scope.tenantId, storageKey: chunk.storageKey });
      if (!object.ok || object.value.bytes.byteLength !== chunk.byteSize || sha256(object.value.bytes) !== chunk.digest) {
        fail("storage_unavailable", "chunked result receipt object is missing or corrupt");
      }
      const appended = appendStreamChunk(assembler, {
        kind: "chunk",
        invocation_id: chunk.invocationId,
        stream_id: "result",
        chunk_index: chunk.chunkIndex,
        encoding: "base64",
        content_type: chunk.contentType,
        data: Buffer.from(object.value.bytes).toString("base64"),
      });
      assembler = appended.state;
      if (appended.kind === "gap") fail("incomplete", "chunked result has a receipt gap");
      if (appended.kind === "oversize") fail("oversize", "chunked result exceeds carrier limits");
      if (appended.kind === "protocol_fault") fail("protocol_fault", `chunked result receipt invalid: ${appended.reason}`);
    }
    const finalized = finalizeStreams(assembler, manifest);
    if (finalized.kind !== "complete" || finalized.streams.length !== 1) {
      fail(finalized.kind === "incomplete" ? "incomplete" : finalized.kind === "oversize" ? "oversize" : "protocol_fault", "chunked result terminal is incomplete or invalid");
    }
    const result = parseCarrierJson(finalized.streams[0]!.bytes);
    const committed = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const setRow = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId));
      if (setRow === null) return false;
      const current = setRow.value as unknown as CarrierSetRecord;
      if (current.tenantId !== scope.tenantId || current.principalKey !== scope.principalKey || current.effectiveMcpSessionId !== scope.mcpSessionId || (current.state !== "declared" && current.state !== "active")) return false;
      // The Bridge admission is the sole revocation-sensitive authority.  It
      // must run before *any* Stage-C write is staged, so an abort leaves the
      // set and private receipt objects invisible and GC-safe.
      if (bridgeCommitAborted(await commitBridge(tx, current.state === "active" ? "verify" : "activate"))) return "aborted" as const;
      const ackKey = carrierAckKey(scope, current.rsid, "terminal");
      const ack = await tx.read<GatewayJsonValue>(CARRIER_ACK_NAMESPACE, ackKey);
      if (ack === null) {
        tx.stage({ namespace: CARRIER_ACK_NAMESPACE, key: ackKey, value: { schemaVersion: "revagent-gateway-carrier/v1", setId, rsid: current.rsid, invocationId: current.invocationId, seq: "terminal", tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId, state: "terminal_accepted" } as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      } else if ((ack.value as { setId?: string; state?: string }).setId !== setId || (ack.value as { state?: string }).state !== "terminal_accepted") {
        return false;
      }
      if (current.state === "declared") tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: setRow.key, value: { ...current, state: "active" } as unknown as GatewayJsonValue, expect: { kind: "version", version: setRow.version } });
      return "committed" as const;
    });
    if (committed.ok && committed.value === "aborted") throw new BridgeCarrierTerminalAborted();
    if (!committed.ok || committed.value !== "committed") fail("storage_unavailable", committed.ok ? "chunked result stage C was not accepted" : committed.message);
    return result;
  }

  async #resumeCarrier(scope: GatewayResourceScope, effective: EffectiveMcpRequestScopeV1, setId: string, commitBridge?: BridgeCarrierCommit): Promise<readonly GatewayArtifactRef[]> {
    assertEffectiveScope(scope, effective);
    const loaded = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const set = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId));
      const terminal = await tx.read<GatewayJsonValue>(CARRIER_TERMINAL_NAMESPACE, carrierSetKey(setId));
      return { set: set?.value as unknown as CarrierSetRecord | undefined, terminal: terminal?.value as unknown as CarrierTerminalRecord | undefined };
    });
    if (!loaded.ok) fail("storage_unavailable", loaded.message);
    const { set, terminal } = loaded.value;
    if (set === undefined || terminal === undefined || set.tenantId !== scope.tenantId || set.principalKey !== scope.principalKey || set.effectiveMcpSessionId !== scope.mcpSessionId) fail("incomplete", "carrier set has no durable terminal");
    if (terminal.manifest.kind !== "artifact_result") fail("protocol_fault", "artifact carrier resumed with a non-artifact terminal");
    if (set.state === "verified") {
      await this.#validateVerifiedCarrierSet(scope, set, terminal.manifest);
      return this.#activateCarrierSet(scope, setId, commitBridge);
    }
    if (set.state === "active") return this.#activateCarrierSet(scope, setId, commitBridge);
    await this.#prepareCarrierSet(scope, set, terminal.manifest);
    await this.#verifyCarrierSet(scope, setId, terminal.manifest);
    return this.#activateCarrierSet(scope, setId, commitBridge);
  }

  /** A restart after B must prove the private final objects before C, without
   * attempting the intent-only stream reconstruction path again. */
  async #validateVerifiedCarrierSet(scope: GatewayResourceScope, set: CarrierSetRecord, manifest: Extract<TerminalStreamManifest, { kind: "artifact_result" }>): Promise<void> {
    const members = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) =>
      (await tx.list(RESOURCE_SET_MEMBER_NAMESPACE)).map((row) => row.value as unknown as CarrierMemberRecord)
        .filter((member) => member.setId === set.setId).sort((a, b) => a.memberIndex - b.memberIndex));
    if (!members.ok || members.value.length !== manifest.descriptors.length) fail("storage_unavailable", "verified carrier member inventory is invalid");
    for (const [index, descriptor] of manifest.descriptors.entries()) {
      const member = members.value[index];
      if (member === undefined || member.state !== "verified" || member.rsid !== set.rsid || member.invocationId !== set.invocationId || member.tenantId !== scope.tenantId || member.principalKey !== scope.principalKey || member.effectiveMcpSessionId !== scope.mcpSessionId || member.memberIndex !== index || member.expectedChunkCount !== descriptor.total_chunks || member.digest !== descriptor.sha256 || member.byteSize !== descriptor.total_size || member.streamDigest !== carrierStreamDigest(descriptor.stream_id)) fail("storage_unavailable", "verified carrier member binding is invalid");
      const object = await this.#objectStore.get({ tenantId: scope.tenantId, storageKey: member.storageKey });
      if (!object.ok || object.value.contentType !== member.contentType || object.value.bytes.byteLength !== member.byteSize || sha256(object.value.bytes) !== member.digest) fail("storage_unavailable", "verified carrier final object is unavailable");
    }
  }

  /** Stage A: a single CAS creates every opaque member intent with the set transition. */
  async #prepareCarrierSet(scope: GatewayResourceScope, set: CarrierSetRecord, manifest: Extract<TerminalStreamManifest, { kind: "artifact_result" }>): Promise<void> {
    const outcome = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const row = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(set.setId));
      if (row === null) return false;
      const current = row.value as unknown as CarrierSetRecord;
      if (current.state === "active" || current.state === "verified" || current.state === "assembling") return true;
      if (current.state !== "declared") return false;
      for (const [memberIndex, descriptor] of manifest.descriptors.entries()) {
        if (!safeFilename(descriptor.filename) || !(GW9_ALLOWED_OUTPUT_CONTENT_TYPES as readonly string[]).includes(descriptor.content_type) || descriptor.artifact_index !== memberIndex) return false;
        const refId = this.#validatedRefId();
        const member: CarrierMemberRecord = { schemaVersion: "revagent-gateway-carrier/v1", setId: set.setId, memberIndex, rsid: set.rsid, invocationId: set.invocationId, tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId, refId, filename: descriptor.filename, contentType: descriptor.content_type, digest: descriptor.sha256 as `sha256:${string}`, byteSize: descriptor.total_size, expectedChunkCount: descriptor.total_chunks, streamDigest: carrierStreamDigest(descriptor.stream_id), storageKey: storageKey(scope, "artifact_ref", refId, descriptor.sha256 as `sha256:${string}`), state: "intent" };
        tx.stage({ namespace: RESOURCE_SET_MEMBER_NAMESPACE, key: carrierMemberKey(set.setId, memberIndex), value: member as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      }
      tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: row.key, value: { ...current, state: "assembling" } as unknown as GatewayJsonValue, expect: { kind: "version", version: row.version } }); return true;
    });
    if (!outcome.ok || !outcome.value) fail("storage_unavailable", "carrier stage A was not accepted");
  }

  /** Stage B: only durable, contiguous receipts are read.  Nothing is public here. */
  async #verifyCarrierSet(scope: GatewayResourceScope, setId: string, manifest: Extract<TerminalStreamManifest, { kind: "artifact_result" }>): Promise<void> {
    const durable = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) =>
      (await tx.list(CARRIER_CHUNK_NAMESPACE)).map((row) => row.value as unknown as CarrierChunkRecord)
        .filter((chunk) => chunk.setId === setId && chunk.tenantId === scope.tenantId && chunk.principalKey === scope.principalKey && chunk.effectiveMcpSessionId === scope.mcpSessionId),
    );
    if (!durable.ok) fail("storage_unavailable", durable.message);
    let assembler = createStreamAssembler((durable.value[0] as CarrierChunkRecord | undefined)?.invocationId ?? "missing", { maxInvocationBytes: this.#maxResultBytes });
    const byStream = [...durable.value].sort((a, b) => a.streamId.localeCompare(b.streamId) || a.chunkIndex - b.chunkIndex);
    const sequences = new Set<number>();
    for (const chunk of byStream) {
      if (chunk.state !== "durable" || !SHA256_PATTERN.test(chunk.digest) || sequences.has(chunk.sequence)) fail("incomplete", "carrier contains an invalid durable receipt");
      sequences.add(chunk.sequence);
      const object = await this.#objectStore.get({ tenantId: scope.tenantId, storageKey: chunk.storageKey });
      if (!object.ok || object.value.bytes.byteLength !== chunk.byteSize || sha256(object.value.bytes) !== chunk.digest) fail("storage_unavailable", "carrier chunk object is missing or corrupt");
      const common = { kind: "chunk" as const, invocation_id: chunk.invocationId, chunk_index: chunk.chunkIndex, encoding: "base64" as const, content_type: chunk.contentType, data: Buffer.from(object.value.bytes).toString("base64") };
      const rebuilt: RbpStreamChunk = chunk.artifactId === null
        ? { ...common, stream_id: "result" }
        : { ...common, stream_id: `artifact:${chunk.artifactId}`, artifact_id: chunk.artifactId, artifact_index: chunk.artifactIndex! };
      const appended = appendStreamChunk(assembler, rebuilt); assembler = appended.state;
      if (appended.kind === "gap") fail("incomplete", "carrier durable chunks are not contiguous");
      if (appended.kind === "oversize") fail("oversize", "carrier durable chunks exceed limits");
      if (appended.kind === "protocol_fault") fail("protocol_fault", `carrier durable chunks invalid: ${appended.reason}`);
    }
    const finalized = finalizeStreams(assembler, manifest);
    if (finalized.kind !== "complete") fail(finalized.kind === "incomplete" ? "incomplete" : finalized.kind === "oversize" ? "oversize" : "protocol_fault", `carrier terminal rejected: ${finalized.reason}`);
    const intents = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const rows = [] as CarrierMemberRecord[];
      for (const [index, stream] of finalized.streams.entries()) {
        const memberRow = await tx.read<GatewayJsonValue>(RESOURCE_SET_MEMBER_NAMESPACE, carrierMemberKey(setId, index)); if (memberRow === null) return null;
        const member = memberRow.value as unknown as CarrierMemberRecord;
        if (member.state !== "intent" || member.digest !== stream.sha256 || member.byteSize !== stream.bytes.byteLength || member.expectedChunkCount !== stream.totalChunks || member.contentType !== stream.contentType) return null;
        rows.push(member);
      }
      return rows;
    });
    if (!intents.ok || intents.value === null) fail("storage_unavailable", "carrier member intents are unavailable");
    // Final objects are intentionally written and read-back verified before
    // the metadata CAS.  Orphans remain private and are fenced-GC eligible.
    for (const [index, stream] of finalized.streams.entries()) {
      const member = intents.value[index]!;
      const put = await this.#objectStore.put({ tenantId: scope.tenantId, storageKey: member.storageKey, bytes: stream.bytes, contentType: member.contentType });
      const head = put.ok && put.value.storageKey === member.storageKey
        ? await this.#objectStore.head({ tenantId: scope.tenantId, storageKey: member.storageKey }) : null;
      if (head === null || !head.ok || head.value.byteSize !== stream.bytes.byteLength) fail("storage_unavailable", "carrier final object was not durably verified");
    }
    const verified = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const setRow = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId)); if (setRow === null) return false;
      const set = setRow.value as unknown as CarrierSetRecord; if (set.state === "verified" || set.state === "active") return true; if (set.state !== "assembling") return false;
      for (const [index, stream] of finalized.streams.entries()) {
        const memberRow = await tx.read<GatewayJsonValue>(RESOURCE_SET_MEMBER_NAMESPACE, carrierMemberKey(setId, index)); if (memberRow === null) return false;
        const member = memberRow.value as unknown as CarrierMemberRecord;
        if (member.state !== "intent" || member.digest !== stream.sha256 || member.byteSize !== stream.bytes.byteLength || member.expectedChunkCount !== stream.totalChunks || member.contentType !== stream.contentType) return false;
        tx.stage({ namespace: RESOURCE_SET_MEMBER_NAMESPACE, key: memberRow.key, value: { ...member, state: "verified" } as unknown as GatewayJsonValue, expect: { kind: "version", version: memberRow.version } });
      }
      tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: setRow.key, value: { ...set, state: "verified" } as unknown as GatewayJsonValue, expect: { kind: "version", version: setRow.version } }); return true;
    });
    if (!verified.ok || !verified.value) fail("storage_unavailable", "carrier stage B was not accepted");
  }

  /** Stage C: the set, all north metadata, terminal ack and members become visible in one transaction. */
  async #activateCarrierSet(scope: GatewayResourceScope, setId: string, commitBridge?: BridgeCarrierCommit): Promise<readonly GatewayArtifactRef[]> {
    const activated = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const setRow = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId)); if (setRow === null) return false;
      const set = setRow.value as unknown as CarrierSetRecord;
      const members = (await tx.list(RESOURCE_SET_MEMBER_NAMESPACE)).map((row) => ({ row, member: row.value as unknown as CarrierMemberRecord })).filter(({ member }) => member.setId === setId).sort((a, b) => a.member.memberIndex - b.member.memberIndex);
      if (set.state === "active") {
        const ack = await tx.read<GatewayJsonValue>(CARRIER_ACK_NAMESPACE, carrierAckKey(scope, set.rsid, "terminal"));
        const terminal = ack?.value as { setId?: string; rsid?: string; invocationId?: string; seq?: string; state?: string } | undefined;
        if (members.length < 1 || members.some(({ member }) => member.state !== "active") || terminal?.setId !== setId || terminal.rsid !== set.rsid || terminal.invocationId !== set.invocationId || terminal.seq !== "terminal" || terminal.state !== "terminal_accepted") return false;
        for (const { member } of members) {
          const stored = await tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, recordKey(scope, "artifact_ref", member.refId));
          const record = stored === null ? null : asJsonRecord(stored.value);
          if (record === null || record.kind !== "artifact_ref" || record.lifecycle !== "active" || record.refId !== member.refId || record.storageKey !== member.storageKey || record.digest !== member.digest || record.byteSize !== member.byteSize || record.carrierSetId !== setId) return false;
        }
        if (commitBridge !== undefined && bridgeCommitAborted(await commitBridge(tx, "verify"))) return null;
        return members.map(({ member }) => this.#carrierRef(scope, member, set.expiresAtMs));
      }
      if (set.state !== "verified" || members.length < 1 || members.some(({ member }) => member.state !== "verified")) return false;
      // This callback owns the revocation-sensitive session terminal.  Run it
      // before staging resource activation, terminal ACK, or set visibility.
      if (commitBridge !== undefined && bridgeCommitAborted(await commitBridge(tx, "activate"))) return null;
      for (const { row, member } of members) {
        const record: ArtifactRecord = { schemaVersion: "revagent-gateway-resource/v1", kind: "artifact_ref", refId: member.refId, actorId: scope.actorId, principalKey: scope.principalKey, mcpSessionId: scope.mcpSessionId, createdAtMs: this.#now(), expiresAtMs: set.expiresAtMs, filename: member.filename, contentType: member.contentType, byteSize: member.byteSize, digest: member.digest, storageKey: member.storageKey, quarantineStatus: "released", source: "rbp_output", invocationId: set.invocationId, artifactIndex: member.memberIndex, carrierSetId: setId, lifecycle: "active" };
        tx.stage({ namespace: RESOURCE_NAMESPACE, key: recordKey(scope, "artifact_ref", member.refId), value: record as unknown as GatewayJsonValue, expect: { kind: "absent" } });
        tx.stage({ namespace: RESOURCE_SET_MEMBER_NAMESPACE, key: row.key, value: { ...member, state: "active" } as unknown as GatewayJsonValue, expect: { kind: "version", version: row.version } });
      }
      const ackKey = carrierAckKey(scope, set.rsid, "terminal"); const ack = await tx.read(CARRIER_ACK_NAMESPACE, ackKey);
      if (ack === null) tx.stage({ namespace: CARRIER_ACK_NAMESPACE, key: ackKey, value: { schemaVersion: "revagent-gateway-carrier/v1", setId, rsid: set.rsid, invocationId: set.invocationId, seq: "terminal", tenantId: scope.tenantId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId, state: "terminal_accepted" } as unknown as GatewayJsonValue, expect: { kind: "absent" } });
      else { const value = ack.value as { setId?: string; rsid?: string; invocationId?: string; seq?: string; tenantId?: string; principalKey?: string; effectiveMcpSessionId?: string; state?: string }; if (value.setId !== setId || value.rsid !== set.rsid || value.invocationId !== set.invocationId || value.seq !== "terminal" || value.tenantId !== scope.tenantId || value.principalKey !== scope.principalKey || value.effectiveMcpSessionId !== scope.mcpSessionId || value.state !== "terminal_accepted") return false; }
      tx.stage({ namespace: RESOURCE_SET_NAMESPACE, key: setRow.key, value: { ...set, state: "active" } as unknown as GatewayJsonValue, expect: { kind: "version", version: setRow.version } });
      return members.map(({ member }) => this.#carrierRef(scope, member, set.expiresAtMs));
    });
    if (activated.ok) {
      if (activated.value === null) throw new BridgeCarrierTerminalAborted();
      if (activated.value !== false) {
        const refs: readonly GatewayArtifactRef[] = activated.value;
        return Object.freeze(refs);
      }
    }
    // A durability-uncertain Tx-C is never recovered from a resource-only
    // readback: that cannot prove the paired Bridge terminal.  Keep the
    // invocation fail-closed; only a definitive competing CAS can have a
    // coherent already-active winner.
    if (!activated.ok && activated.code !== "conflict") {
      fail("storage_unavailable", activated.message);
    }
    // A concurrent identical replay may have won stage C's absent-CAS for
    // every north row.  Re-read only an already-active, fully bound set.
    const winner = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const setRow = await tx.read<GatewayJsonValue>(RESOURCE_SET_NAMESPACE, carrierSetKey(setId));
      const set = setRow?.value as unknown as CarrierSetRecord | undefined;
      if (set?.state !== "active" || set.tenantId !== scope.tenantId || set.principalKey !== scope.principalKey || set.effectiveMcpSessionId !== scope.mcpSessionId) return null;
      const members = (await tx.list(RESOURCE_SET_MEMBER_NAMESPACE)).map((row) => row.value as unknown as CarrierMemberRecord).filter((member) => member.setId === setId).sort((a, b) => a.memberIndex - b.memberIndex);
      return members.length > 0 && members.every((member) => member.state === "active") ? members.map((member) => this.#carrierRef(scope, member, set.expiresAtMs)) : null;
    });
    if (winner.ok && winner.value !== null) return Object.freeze(winner.value);
    fail("storage_unavailable", "carrier stage C was not accepted");
  }

  #carrierRef(scope: GatewayResourceScope, member: CarrierMemberRecord, expiresAtMs: number): GatewayArtifactRef {
    return Object.freeze({ kind: "artifact_ref", refId: member.refId, uri: artifactUri(scope, member.refId), filename: member.filename, contentType: member.contentType, byteSize: member.byteSize, digest: member.digest, expiresAtMs });
  }

  async #storeArtifact(input: {
    readonly scope: GatewayResourceScope;
    readonly filename: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly expiresAtMs: number;
    readonly quarantineStatus: ArtifactRecord["quarantineStatus"];
    readonly source: ArtifactRecord["source"];
    readonly invocationId: string | null;
    readonly artifactIndex: number | null;
  }): Promise<GatewayArtifactRef> {
    const [ref] = await this.#storeArtifactSet([input]);
    if (ref === undefined) {
      fail("storage_unavailable", "artifact_ref metadata was not accepted");
    }
    return ref;
  }

  async #storeArtifactSet(inputs: readonly {
    readonly scope: GatewayResourceScope;
    readonly filename: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly expiresAtMs: number;
    readonly quarantineStatus: ArtifactRecord["quarantineStatus"];
    readonly source: ArtifactRecord["source"];
    readonly invocationId: string | null;
    readonly artifactIndex: number | null;
  }[]): Promise<readonly GatewayArtifactRef[]> {
    if (inputs.length < 1) {
      fail("invalid_input", "artifact set must not be empty");
    }
    const scope = inputs[0]!.scope;
    if (inputs.some((input) => JSON.stringify(input.scope) !== JSON.stringify(scope))) {
      fail("scope_denied", "one artifact set cannot mix authorization scopes");
    }
    const records: ArtifactRecord[] = [];
    const refIds = new Set<string>();
    for (const input of inputs) {
      const refId = this.#validatedRefId();
      if (refIds.has(refId)) {
        await this.#deleteStored(scope, records);
        fail("invalid_input", "generated resource refs must be unique");
      }
      refIds.add(refId);
      await this.#assertRefAbsent(scope, "artifact_ref", refId);
      const key = storageKey(scope, "artifact_ref", refId, input.digest);
      records.push(Object.freeze({
        schemaVersion: "revagent-gateway-resource/v1",
        kind: "artifact_ref",
        refId,
        actorId: scope.actorId,
        principalKey: scope.principalKey,
        mcpSessionId: scope.mcpSessionId,
        createdAtMs: this.#now(),
        expiresAtMs: input.expiresAtMs,
        filename: input.filename,
        contentType: input.contentType,
        byteSize: input.bytes.byteLength,
        digest: input.digest,
        storageKey: key,
        quarantineStatus: input.quarantineStatus,
        source: input.source,
        invocationId: input.invocationId,
        artifactIndex: input.artifactIndex,
        lifecycle: "allocating" as const,
      }));
    }
    const stored = await this.#writeRecords(scope, records);
    if (!stored) {
      fail("storage_unavailable", "artifact set metadata was not durably accepted");
    }
    for (const [index, record] of records.entries()) {
      const input = inputs[index]!;
      const put = await this.#objectStore.put({
        tenantId: scope.tenantId,
        storageKey: record.storageKey,
        bytes: input.bytes,
        contentType: input.contentType,
      });
      if (!put.ok || put.value.storageKey !== record.storageKey) {
        await this.#deleteStored(scope, records);
        await this.#deleteRecords(scope, records);
        fail("storage_unavailable", put.ok ? "object store changed the requested storage key" : put.message);
      }
    }
    for (const record of records) {
      if (!await this.#activateRecord(scope, record)) {
        await this.#deleteStored(scope, records);
        await this.#deleteRecords(scope, records);
        fail("storage_unavailable", "artifact verification metadata was not durably accepted");
      }
    }
    return Object.freeze(records.map((record) => Object.freeze({
      kind: "artifact_ref" as const,
      refId: record.refId,
      uri: artifactUri(scope, record.refId),
      filename: record.filename,
      contentType: record.contentType,
      byteSize: record.byteSize,
      digest: record.digest,
      expiresAtMs: record.expiresAtMs,
    })));
  }

  async #writeRecords(
    scope: GatewayResourceScope,
    records: readonly ResourceRecord[],
  ): Promise<boolean> {
    const outcome = await this.#protocolStore.transact(
      { tenantId: scope.tenantId },
      (tx) => {
        for (const record of records) {
          tx.stage({
            namespace: RESOURCE_NAMESPACE,
            key: recordKey(scope, record.kind, record.refId),
            value: record as unknown as GatewayJsonValue,
            expect: { kind: "absent" },
          });
        }
      },
    );
    return outcome.ok;
  }

  async #activateRecord(scope: GatewayResourceScope, record: ResourceRecord): Promise<boolean> {
    const outcome = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const stored = await tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, recordKey(scope, record.kind, record.refId));
      if (stored === null) return false;
      const current = asJsonRecord(stored.value);
      if (current === null || current.lifecycle !== "allocating" || current.storageKey !== record.storageKey) return false;
      tx.stage({
        namespace: RESOURCE_NAMESPACE,
        key: stored.key,
        value: { ...current, lifecycle: "active" } as unknown as GatewayJsonValue,
        expect: { kind: "version", version: stored.version },
      });
      return true;
    });
    return outcome.ok && outcome.value;
  }

  async #deleteRecords(
    scope: GatewayResourceScope,
    records: readonly ResourceRecord[],
  ): Promise<void> {
    await Promise.allSettled(records.map(async (record) => {
      await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
        const stored = await tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, recordKey(scope, record.kind, record.refId));
        if (stored === null) return;
        tx.stage({ namespace: RESOURCE_NAMESPACE, key: stored.key, value: null, expect: { kind: "version", version: stored.version } });
      });
    }));
  }

  async #assertRefAbsent(
    scope: GatewayResourceScope,
    kind: GatewayResourceKind,
    refId: string,
  ): Promise<void> {
    const outcome = await this.#protocolStore.transact(
      { tenantId: scope.tenantId },
      (tx) => tx.read(RESOURCE_NAMESPACE, recordKey(scope, kind, refId)),
    );
    if (!outcome.ok) {
      fail("storage_unavailable", outcome.message);
    }
    if (outcome.value !== null) {
      fail("invalid_input", "generated resource ref already exists");
    }
  }

  async #readRecord(
    scope: GatewayResourceScope,
    kind: GatewayResourceKind,
    refHash: string,
  ): Promise<ResourceRecord> {
    assertScope(scope);
    if (!SHA256_HEX_PATTERN.test(refHash)) {
      fail("not_found", "resource ref is invalid");
    }
    const outcome = await this.#protocolStore.transact(
      { tenantId: scope.tenantId },
      (tx) => tx.read(RESOURCE_NAMESPACE, recordKeyFromHash(scope, kind, refHash)),
    );
    if (!outcome.ok) {
      fail("storage_unavailable", outcome.message);
    }
    const record = asJsonRecord(outcome.value?.value);
    if (record === null || record.kind !== kind) {
      fail("not_found", "resource ref was not found");
    }
    // The scope-hashed metadata key above is the primary isolation barrier.
    // Keep this defensive invariant in case a backing store is corrupted.
    if (
      record.actorId !== scope.actorId ||
      record.principalKey !== scope.principalKey ||
      record.mcpSessionId !== scope.mcpSessionId
    ) {
      fail("not_found", "resource ref was not found");
    }
    if (this.#now() >= record.expiresAtMs) {
      fail("expired", "resource ref has expired");
    }
    if ((record.lifecycle ?? "active") !== "active") {
      fail("not_found", "resource ref is not active");
    }
    if (record.kind === "artifact_ref" && record.quarantineStatus !== "released") {
      fail("quarantined", "artifact_ref is not released from quarantine");
    }
    return record;
  }

  async #verifiedBytes(
    scope: GatewayResourceScope,
    record: ArtifactRecord | ResultRecord,
  ): Promise<Uint8Array> {
    if (record.kind === "result_ref" && record.protectedRecovery !== undefined) {
      const protectedStore = this.#recoveryStore();
      const recovery = record.protectedRecovery;
      // A resource URI remains insufficient by itself: every read repeats the
      // live owner/binding decision before decrypting the protected result.
      const completion = await this.#protocolStore.transact({ tenantId: scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RECOVERY_COMPLETION_NAMESPACE, recoveryCompletionKey(recovery.owner)));
      const terminal = completion.ok ? asRecoveryCompletion(completion.value?.value) : null;
      if (!sameRecoveryOwner(recovery.owner, { ...recovery.owner, tenantId: scope.tenantId, userId: scope.actorId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId }) || terminal === null || terminal.state !== "active" || terminal.refId !== record.refId || terminal.activatedSessionBindingId !== recovery.owner.sessionBindingId || terminal.activatedSessionBindingVersion !== recovery.owner.sessionBindingVersion || recovery.activatedSessionBindingId !== recovery.owner.sessionBindingId || recovery.activatedSessionBindingVersion !== recovery.owner.sessionBindingVersion || await this.#reauthorize(recovery.owner) === null) {
        fail("not_found", "resource ref was not found");
      }
      const stored = await protectedStore.getProtected({ storageKey: recovery.storageKey, contentType: record.contentType, binding: recoveryBinding(recovery.owner, recovery.bridgeSequence, recovery.chunkIndex, recovery.plainDigest, recovery.resultRefDigest, recovery.plainLength, record.expiresAtMs) });
      if (!stored.ok || stored.value.bytes.byteLength !== record.byteSize || sha256(stored.value.bytes) !== recovery.plainDigest || recoveryResultRefDigest(stored.value.bytes) !== recovery.resultRefDigest || record.digest !== recovery.resultRefDigest) fail("not_found", "resource ref was not found");
      // Explicit ownership transfer to the authorized reader/finalizer.
      return stored.value.bytes;
    }
    const stored = await this.#objectStore.get({
      tenantId: scope.tenantId,
      storageKey: record.storageKey,
    });
    if (!stored.ok) {
      fail("storage_unavailable", stored.message);
    }
    if (
      stored.value.contentType !== record.contentType ||
      stored.value.bytes.byteLength !== record.byteSize ||
      sha256(stored.value.bytes) !== record.digest
    ) {
      fail("digest_mismatch", "stored resource bytes do not match durable metadata");
    }
    return new Uint8Array(stored.value.bytes);
  }

  async #deleteStored(
    scope: GatewayResourceScope,
    records: readonly Pick<ArtifactRecord | ResultRecord, "storageKey">[],
  ): Promise<void> {
    await Promise.allSettled(
      records.map((record) =>
        this.#objectStore.delete({
          tenantId: scope.tenantId,
          storageKey: record.storageKey,
        }),
      ),
    );
  }

  async #claimExpired(
    tenantId: string,
    key: string,
    expectedVersion: number,
    now: number,
  ): Promise<{ readonly record: ResourceRecord; readonly version: number } | null> {
    const claim = await this.#protocolStore.transact({ tenantId }, async (tx) => {
      const stored = await tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, key);
      if (stored === null || stored.version !== expectedVersion) return null;
      const record = asJsonRecord(stored.value);
      if (record === null || record.expiresAtMs > now) return null;
      if (
        (record.lifecycle === "gc_claimed" || record.lifecycle === "deleting") &&
        record.gcLease !== undefined &&
        record.gcLease.expiresAtMs > now &&
        record.gcLease.owner !== this.#gcOwnerId
      ) return null;
      const next = Object.freeze({
        ...record,
        lifecycle: record.kind === "result_ref" && record.protectedRecovery !== undefined ? "deleting" as const : "gc_claimed" as const,
        gcLease: Object.freeze({
          owner: this.#gcOwnerId,
          claimToken: randomUUID(),
          expiresAtMs: now + 60_000,
        }),
      });
      tx.stage({ namespace: RESOURCE_NAMESPACE, key, value: next as unknown as GatewayJsonValue, expect: { kind: "version", version: stored.version } });
      return next;
    });
    if (!claim.ok) return null;
    if (claim.value === null) return null;
    const observed = await this.#protocolStore.transact({ tenantId }, (tx) => tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, key));
    if (!observed.ok || observed.value === null) return null;
    return { record: claim.value, version: observed.value.version };
  }

  #recoveryStore(): ProtectedObjectStorePort {
    if (this.#protectedObjectStore === undefined || this.#reauthorizeRecoveryScope === undefined) {
      fail("storage_unavailable", "recovery authority is not configured");
    }
    return this.#protectedObjectStore;
  }

  async #deleteProtectedRecoveryObject(
    record: Pick<RecoveryProtectedRef | RecoveryChunkRecord, "owner" | "kid" | "storageKey" | "plainDigest" | "resultRefDigest" | "plainLength" | "bridgeSequence" | "chunkIndex">,
    expiresAtMs: number,
    deletionClaim: { readonly id: string; readonly version: number },
  ): Promise<{ readonly ok: boolean }> {
    const removed = await this.#recoveryStore().deleteProtected({
      storageKey: record.storageKey,
      contentType: "application/json",
      expectedKid: record.kid,
      deletionClaim,
      binding: recoveryBinding(record.owner, record.bridgeSequence, record.chunkIndex, record.plainDigest, record.resultRefDigest, record.plainLength, expiresAtMs),
    });
    return removed.ok ? Object.freeze({ ok: true }) : Object.freeze({ ok: false });
  }

  #assertRecoveryOwner(scope: GatewayResourceScope, owner: RecoveryOwner): void {
    if (!validRecoveryOwner(owner) || owner.tenantId !== scope.tenantId || owner.userId !== scope.actorId || owner.principalKey !== scope.principalKey || owner.effectiveMcpSessionId !== scope.mcpSessionId) {
      fail("scope_denied", "recovery owner is not bound to the current scope");
    }
  }

  async #reauthorize(owner: RecoveryOwner): Promise<RecoveryCurrentAuthorization | null> {
    try {
      const current = await this.#reauthorizeRecoveryScope!(owner);
      return current !== null && current.sessionBindingId === owner.sessionBindingId && current.sessionBindingVersion === owner.sessionBindingVersion ? current : null;
    } catch { return null; }
  }

  #recoveryExpiry(requested: number | undefined): number {
    const expiry = this.#expiry(requested);
    return expiry;
  }

  async #writeProtectedRecoveryChunk(
    scope: GatewayResourceScope,
    protectedStore: ProtectedObjectStorePort,
    record: RecoveryChunkRecord,
    bytes: Uint8Array,
    commitBridge?: (tx: StoreTransaction) => Promise<void>,
  ): Promise<void> {
    if (bytes.byteLength !== record.plainLength || sha256(bytes) !== record.plainDigest) fail("not_found", "recovery receipt unavailable");
    const written = await protectedStore.putProtected({ storageKey: record.storageKey, contentType: "application/json", bytes, kid: record.kid, binding: recoveryBinding(record.owner, record.bridgeSequence, record.chunkIndex, record.plainDigest, record.resultRefDigest, record.plainLength, record.expiresAtMs) });
    if (!written.ok || written.value.storageKey !== record.storageKey) fail("storage_unavailable", "recovery object was not durably written");
    const activated = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const current = await tx.read<GatewayJsonValue>(RECOVERY_CHUNK_NAMESPACE, recoveryChunkKey(record.owner, record.chunkIndex));
      const candidate = asRecoveryChunk(current?.value);
      if (current === null || candidate === null || !sameRecoveryChunk(candidate, record.owner, record.bridgeSequence, record.chunkIndex, record.plainDigest, record.plainLength)) return false;
      if (candidate.state === "active") {
        await commitBridge?.(tx);
        return true;
      }
      tx.stage({ namespace: RECOVERY_CHUNK_NAMESPACE, key: current.key, value: { ...candidate, state: "active" } as unknown as GatewayJsonValue, expect: { kind: "version", version: current.version } });
      await commitBridge?.(tx);
      return true;
    });
    if (activated.ok && activated.value) return;
    // Concurrent byte-identical retries may lose the activation CAS after the
    // winner made the receipt active. Join only that exact durable winner.
    const joined = await this.#protocolStore.transact({ tenantId: scope.tenantId }, (tx) =>
      tx.read<GatewayJsonValue>(RECOVERY_CHUNK_NAMESPACE, recoveryChunkKey(record.owner, record.chunkIndex)),
    );
    const winner = joined.ok ? asRecoveryChunk(joined.value?.value) : null;
    if (winner === null || winner.state !== "active" || !sameRecoveryChunk(winner, record.owner, record.bridgeSequence, record.chunkIndex, record.plainDigest, record.plainLength)) {
      fail("storage_unavailable", "recovery receipt was not activated");
    }
  }

  async #loadRecoveryChunks(scope: GatewayResourceScope, owner: RecoveryOwner, count: number): Promise<readonly RecoveryChunkRecord[]> {
    const loaded = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const values: RecoveryChunkRecord[] = [];
      let total = 0;
      let previousSequence = -1;
      for (let index = 0; index < count; index += 1) {
        const current = asRecoveryChunk((await tx.read<GatewayJsonValue>(RECOVERY_CHUNK_NAMESPACE, recoveryChunkKey(owner, index)))?.value);
        if (current === null || current.state !== "active" || !sameRecoveryOwner(current.owner, owner) || current.chunkIndex !== index || current.bridgeSequence <= previousSequence) return null;
        total += current.plainLength;
        if (total > this.#maxResultBytes) return null;
        previousSequence = current.bridgeSequence;
        values.push(current);
      }
      return Object.freeze(values);
    });
    if (!loaded.ok || loaded.value === null) fail("not_found", "recovery terminal unavailable");
    return loaded.value;
  }

  async #readRecoveryBytes(scope: GatewayResourceScope, protectedStore: ProtectedObjectStorePort, chunks: readonly RecoveryChunkRecord[]): Promise<Uint8Array> {
    const pieces: Uint8Array[] = [];
    let total = 0;
    try {
      for (const chunk of chunks) {
        const recovered = await protectedStore.getProtected({ storageKey: chunk.storageKey, contentType: "application/json", binding: recoveryBinding(chunk.owner, chunk.bridgeSequence, chunk.chunkIndex, chunk.plainDigest, chunk.resultRefDigest, chunk.plainLength, chunk.expiresAtMs) });
        if (!recovered.ok || recovered.value.contentType !== "application/json" || recovered.value.bytes.byteLength !== chunk.plainLength || sha256(recovered.value.bytes) !== chunk.plainDigest) {
          if (recovered.ok) recovered.value.bytes.fill(0);
          fail("not_found", "recovery terminal unavailable");
        }
        total += recovered.value.bytes.byteLength;
        if (total > this.#maxResultBytes) { recovered.value.bytes.fill(0); fail("oversize", "recovery terminal exceeds configured limit"); }
        const piece = new Uint8Array(recovered.value.bytes);
        recovered.value.bytes.fill(0);
        pieces.push(piece);
      }
      const result = new Uint8Array(total);
      let offset = 0;
      for (const piece of pieces) { result.set(piece, offset); offset += piece.byteLength; }
      return result;
    } finally { for (const piece of pieces) piece.fill(0); }
  }

  async #resumeRecoveryFinalize(input: FinalizeRecoveryResultInput, protectedStore: ProtectedObjectStorePort, completion: RecoveryCompletionRecord, knownBytes?: Uint8Array): Promise<GatewayResultRef> {
    const chunks = knownBytes === undefined ? await this.#loadRecoveryChunks(input.scope, input.owner, input.terminalChunkCount) : [];
    const bytes = knownBytes ?? await this.#readRecoveryBytes(input.scope, protectedStore, chunks);
    try {
      if (bytes.byteLength !== input.terminalByteLength || sha256(bytes) !== input.owner.originResultDigest) fail("not_found", "recovery terminal unavailable");
      const existing = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, recordKey(input.scope, "result_ref", completion.refId)));
      if (!existing.ok) fail("storage_unavailable", "recovery result unavailable");
      let record = asJsonRecord(existing.value?.value);
      if (record !== null && (record.kind !== "result_ref" || record.protectedRecovery === undefined || !sameRecoveryOwner(record.protectedRecovery.owner, input.owner))) fail("not_found", "recovery result unavailable");
      if (record === null) {
        const kid = await protectedStore.activeKid();
        if (kid === null) fail("storage_unavailable", "recovery key is unavailable");
        const protectedRecovery: RecoveryProtectedRef = Object.freeze({ schemaVersion: "revagent-gateway-recovery/v1", owner: input.owner, kid, storageKey: recoveryStorageKey(input.owner, "result", 0), plainDigest: input.owner.originResultDigest, resultRefDigest: recoveryResultRefDigest(bytes), plainLength: bytes.byteLength, bridgeSequence: chunks.at(-1)?.bridgeSequence ?? input.terminalChunkCount - 1, chunkIndex: input.terminalChunkCount });
        const next: ResultRecord = Object.freeze({ schemaVersion: "revagent-gateway-resource/v1", kind: "result_ref", refId: completion.refId, actorId: input.scope.actorId, principalKey: input.scope.principalKey, mcpSessionId: input.scope.mcpSessionId, createdAtMs: this.#now(), expiresAtMs: completion.expiresAtMs, contentType: "application/json", byteSize: bytes.byteLength, digest: protectedRecovery.resultRefDigest, pageSize: this.#maxResultPageBytes, pageCount: Math.max(1, Math.ceil(bytes.byteLength / this.#maxResultPageBytes)), storageKey: protectedRecovery.storageKey, lifecycle: "allocating", protectedRecovery });
        const reserved = await this.#writeRecords(input.scope, [next]);
        if (reserved) record = next;
        else {
          const joined = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, recordKey(input.scope, "result_ref", completion.refId)));
          const winner = joined.ok ? asJsonRecord(joined.value?.value) : null;
          if (winner === null || winner.kind !== "result_ref" || winner.protectedRecovery === undefined || !sameRecoveryOwner(winner.protectedRecovery.owner, input.owner) || winner.protectedRecovery.resultRefDigest !== recoveryResultRefDigest(bytes)) fail("not_found", "recovery result unavailable");
          record = winner;
        }
      }
      if ((record.lifecycle ?? "active") !== "active") {
        const protectedRecovery = record.protectedRecovery!;
        const written = await protectedStore.putProtected({ storageKey: protectedRecovery.storageKey, contentType: "application/json", bytes, kid: protectedRecovery.kid, binding: recoveryBinding(protectedRecovery.owner, protectedRecovery.bridgeSequence, protectedRecovery.chunkIndex, protectedRecovery.plainDigest, protectedRecovery.resultRefDigest, protectedRecovery.plainLength, record.expiresAtMs) });
        if (!written.ok || written.value.storageKey !== protectedRecovery.storageKey) fail("storage_unavailable", "recovery result was not written");
      }
      // This is the post-stream authorization fence: encrypted bytes may
      // exist, but they remain unreadable until this current binding is CASed.
      const authorization = await this.#reauthorize(input.owner);
      if (authorization === null || !await this.#activateRecoveryResult(input.scope, record, authorization)) fail("scope_denied", "recovery scope is no longer authorized");
      const completed = await this.#protocolStore.transact({ tenantId: input.scope.tenantId }, async (tx) => {
        const current = await tx.read<GatewayJsonValue>(RECOVERY_COMPLETION_NAMESPACE, recoveryCompletionKey(input.owner));
        const candidate = asRecoveryCompletion(current?.value);
        if (current === null || candidate === null || candidate.refId !== completion.refId || !sameRecoveryOwner(candidate.owner, input.owner)) return false;
        if (candidate.state === "active") {
          if (candidate.activatedSessionBindingId !== authorization.sessionBindingId || candidate.activatedSessionBindingVersion !== authorization.sessionBindingVersion) return false;
          await input.commitBridge?.(tx);
          return true;
        }
        tx.stage({ namespace: RECOVERY_COMPLETION_NAMESPACE, key: current.key, value: { ...candidate, state: "active", activatedSessionBindingId: authorization.sessionBindingId, activatedSessionBindingVersion: authorization.sessionBindingVersion } as unknown as GatewayJsonValue, expect: { kind: "version", version: current.version } });
        await input.commitBridge?.(tx);
        return true;
      });
      if (!completed.ok || !completed.value) fail("storage_unavailable", "recovery completion was not activated");
      return this.#deliverRecoveryResultRef(input.scope, input.owner, completion.refId);
    } finally { if (knownBytes === undefined) bytes.fill(0); }
  }

  async #recoveryResultRef(scope: GatewayResourceScope, refId: string): Promise<GatewayResultRef> {
    const record = await this.#readRecord(scope, "result_ref", scopeHash(refId));
    if (record.kind !== "result_ref" || record.protectedRecovery === undefined) fail("not_found", "recovery result unavailable");
    return Object.freeze({ kind: "result_ref", refId: record.refId, uri: resultUri(scope, record.refId), contentType: "application/json", byteSize: record.byteSize, digest: record.digest, pageCount: record.pageCount, expiresAtMs: record.expiresAtMs });
  }

  async #activateRecoveryResult(scope: GatewayResourceScope, record: ResultRecord, authorization: RecoveryCurrentAuthorization): Promise<boolean> {
    const activated = await this.#protocolStore.transact({ tenantId: scope.tenantId }, async (tx) => {
      const current = await tx.read<GatewayJsonValue>(RESOURCE_NAMESPACE, recordKey(scope, "result_ref", record.refId));
      const candidate = asJsonRecord(current?.value);
      if (current === null || candidate === null || candidate.kind !== "result_ref" || candidate.protectedRecovery === undefined || !sameRecoveryOwner(candidate.protectedRecovery.owner, record.protectedRecovery!.owner)) return false;
      const currentActivation = candidate.protectedRecovery.activatedSessionBindingId;
      if ((candidate.lifecycle ?? "active") === "active") return currentActivation === authorization.sessionBindingId && candidate.protectedRecovery.activatedSessionBindingVersion === authorization.sessionBindingVersion;
      tx.stage({ namespace: RESOURCE_NAMESPACE, key: current.key, value: { ...candidate, lifecycle: "active", protectedRecovery: { ...candidate.protectedRecovery, activatedSessionBindingId: authorization.sessionBindingId, activatedSessionBindingVersion: authorization.sessionBindingVersion } } as unknown as GatewayJsonValue, expect: { kind: "version", version: current.version } });
      return true;
    });
    return activated.ok && activated.value;
  }

  async #deliverRecoveryResultRef(scope: GatewayResourceScope, owner: RecoveryOwner, refId: string): Promise<GatewayResultRef> {
    const completion = await this.#protocolStore.transact({ tenantId: scope.tenantId }, (tx) => tx.read<GatewayJsonValue>(RECOVERY_COMPLETION_NAMESPACE, recoveryCompletionKey(owner)));
    if (!completion.ok) fail("not_found", "recovery result unavailable");
    const current = asRecoveryCompletion(completion.value?.value);
    if (current === null || current.state !== "active" || current.refId !== refId || !sameRecoveryOwner(current.owner, owner) || current.activatedSessionBindingId !== owner.sessionBindingId || current.activatedSessionBindingVersion !== owner.sessionBindingVersion || await this.#reauthorize(owner) === null) fail("not_found", "recovery result unavailable");
    return this.#recoveryResultRef(scope, refId);
  }

  #expiry(requested: number | undefined): number {
    const now = this.#now();
    const expiry = requested ?? now + this.#defaultTtlMs;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiry) || expiry <= now) {
      fail("invalid_input", "resource expiry must be a future safe integer");
    }
    return expiry;
  }

  #validatedRefId(): string {
    const refId = this.#newRefId();
    if (refId.length < 1 || refId.length > 200 || /[\u0000\r\n/\\]/u.test(refId)) {
      fail("invalid_input", "generated resource ref is invalid");
    }
    return refId;
  }
}
