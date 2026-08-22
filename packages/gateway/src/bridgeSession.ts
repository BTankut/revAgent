import { createHash, randomBytes } from "node:crypto";

import {
  acceptInboundData,
  applyCumulativeAck,
  canonicalizeJson,
  dataEnvelopeImmutableDigest,
  createReceivedJournalRecord,
  makeBatchDigest,
  makeMutationHoldId,
  makeParamsDigest,
  mutationScopeKey,
  mutationScopesConflict,
  createConnectionLifecycle,
  createSessionLifecycle,
  handleJournalSessionUnregister,
  markJournalExecuting,
  markJournalIndeterminate,
  queueOutboundData,
  recordJournalTerminal,
  RBP_HEARTBEAT_DISCONNECTED_AFTER_MS,
  RBP_HEARTBEAT_DEGRADED_AFTER_MS,
  retransmitOutbox,
  transitionConnection,
  transitionSession,
  type ConnectionLifecycleState,
  type DataEnvelopeSnapshot,
  type DocContextUpdate,
  type HelloAckEnvelope,
  type HelloEnvelope,
  type InvocationJournalRecord,
  type BatchResult,
  type InvokeBatchEnvelope,
  type InvokeEnvelope,
  type RbpEnvelope,
  type RbpSequenceState,
  type SessionRegister,
  type SessionLifecycleState,
  type SessionUnregister,
  type MutationScope,
  type JsonValue,
} from "@revagent/protocol";

import type { DeviceAuthContext, IdentityPort } from "./authContext.js";
import type {
  GatewayAtomicBatchExecutorRequest,
  GatewayExecutor,
  GatewayExecutorOutcome,
  GatewayExecutorRequest,
  GatewayJsonValue,
} from "./dispatch.js";
import { gatewayUuidV7, isGatewayUuidV7 } from "./identifiers.js";
import type {
  GatewayBridgeEvidenceLookup,
  GatewayBridgeResumeAuthorization,
  GatewayDurableBridgeEvidencePort,
  GatewayDurableDispatchObservation,
  GatewayExpectedDispatchBinding,
  GatewayExpectedDispatchTarget,
  GatewayExpectedMutationDispatch,
  GatewayRecoveryPendingDispatch,
  GatewayVerifiedBridgeJournalEvidence,
} from "./recoveryAuthority.js";
import { GATEWAY_RECOVERY_NAMESPACE } from "./recoveryAuthority.js";
import type {
  GatewayProtocolStore,
  StoreTransaction,
  StoredRecord,
} from "./store.js";
import type { GatewayInvocationRoute } from "./invocationContext.js";

export const GATEWAY_RBP_SESSION_NAMESPACE =
  "gateway.rbp-session/v1" as const;
export const GATEWAY_RBP_UNREGISTER_NAMESPACE =
  "gateway.rbp-unregister/v1" as const;

const RESUME_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const INVOCATION_TIMEOUT_MS = 120_000;
const SEND_RESERVATION_TTL_MS = 5_000;
const UNREGISTER_DRAIN_TIMEOUT_MS = 5_000;
const MAX_AUTHORIZATION_CAS_ATTEMPTS = 8;
const MAX_NORMALIZED_CONFLICT_INDEX_ENTRIES = 256;
const MAX_HOLD_AUDIT_ENTRIES = 256;
const MAX_DURABLE_STRING_LENGTH = 4_096;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HOLD_ID_PATTERN = /^vh:[0-9a-f]{64}$/u;
const SUPPORTED_CAPABILITIES = Object.freeze([
  "transport_streamable_http",
  "batch_atomic",
  "partial_progress",
  "chunked_results",
  "artifact_result_v1",
] as const);

type BindingKind = "wss" | "http_sse";

interface DurablePendingDispatch {
  readonly envelopeDigest: `sha256:${string}`;
  readonly gatewaySequence: number;
  readonly invocationId: string;
  readonly mutating: boolean;
  readonly mutationEntries: readonly DurablePendingMutation[];
  readonly journalRecords: readonly InvocationJournalRecord[];
}

interface DurablePendingMutation {
  readonly invocationId: string;
  readonly originIdempotencyKey: string;
  readonly mutationScope: MutationScope;
}

interface DurableDispatchEvidence {
  readonly envelopeDigest: `sha256:${string}`;
  readonly acceptance: GatewayDurableDispatchObservation["acceptance"];
  readonly journal: GatewayVerifiedBridgeJournalEvidence | null;
}

interface DurableLiveDocumentRoute {
  readonly sessionDocumentId: string;
  readonly observedConnectionId: string;
  readonly observedSequence: number;
}

interface DurableRbpSession {
  readonly schema: typeof GATEWAY_RBP_SESSION_NAMESPACE;
  /** Optional only for pre-WP-02 legacy rows; every new write carries it. */
  readonly recordVersion?: number;
  /** Optional only for pre-WP-02 legacy rows; repaired by the next session CAS. */
  readonly createdAtMs?: number;
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly sessionVersion: number;
  readonly connectionId: string;
  readonly binding: BindingKind;
  readonly resumeTokenDigest: `sha256:${string}`;
  readonly resumeExpiresAtMs: number;
  readonly grantedCapabilities: readonly string[];
  readonly connectionLifecycle: ConnectionLifecycleState;
  readonly sessionLifecycle: SessionLifecycleState;
  readonly lastHeartbeatAtMs: number;
  readonly sequence: RbpSequenceState;
  readonly liveDocumentRoute: DurableLiveDocumentRoute | null;
  readonly pending: DurablePendingDispatch | null;
  readonly evidence: readonly DurableDispatchEvidence[];
  /** Optional only for pre-WP-02 legacy rows. */
  readonly egressFence?: DurableEgressFence;
  /** Optional only for pre-WP-02 legacy rows. */
  readonly normalizedConflictIndex?: DurableNormalizedConflictIndex;
  readonly updatedAtMs: number;
}

type DurableEgressOperation =
  | "dispatch"
  | "resume_ack"
  | "resume_retransmit";

interface DurableEgressLease {
  readonly leaseId: string;
  readonly ticket: number;
  readonly holderInstanceId: string;
  readonly connectionId: string;
  readonly operation: DurableEgressOperation;
  readonly envelopeDigest: `sha256:${string}`;
  readonly phase: "reserved" | "started";
  readonly reservedAtMs: number;
  readonly reserveExpiresAtMs: number;
  readonly startedAtMs: number | null;
}

interface DurableEgressRevocation {
  readonly owner: {
    readonly userId: string;
    readonly deviceId: string;
    readonly seatId: string;
  };
  readonly reason: SessionUnregister["reason"];
  readonly acceptedConnectionId: string;
  readonly requestedAtMs: number;
  readonly drainDeadlineAtMs: number;
}

interface DurableEgressFence {
  readonly version: 1;
  readonly state: "open" | "revocation_pending";
  readonly epoch: number;
  readonly nextTicket: number;
  readonly lease: DurableEgressLease | null;
  readonly revocation: DurableEgressRevocation | null;
}

interface DurableNormalizedConflictIndex {
  readonly version: 1;
  readonly state: "complete" | "overflow";
  readonly scopeDigests: readonly `sha256:${string}`[];
}

/**
 * DC-01 keeps the final tombstone beside the v1 session row. The session's
 * egress fence carries the earlier revocation_pending phase so send authority
 * can be drained before this independently readable final record is created.
 */
interface DurableUnregisterTombstone {
  readonly schema: typeof GATEWAY_RBP_UNREGISTER_NAMESPACE;
  readonly recordVersion: 1;
  readonly tenantId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly owner: {
    readonly userId: string;
    readonly deviceId: string;
    readonly seatId: string;
  };
  readonly reason: SessionUnregister["reason"];
  readonly revokedAtMs: number;
  readonly acceptedConnectionId: string;
  readonly pendingDisposition: "none" | "read_closed" | "mutation_indeterminate";
  readonly holdIds: readonly `vh:${string}`[];
  readonly cleanupState: "retained" | "cleanup_pending";
}

const GATEWAY_MUTATION_HOLD_NAMESPACE = "gateway.mutation-hold/v1" as const;
const GATEWAY_MUTATION_CONFLICT_NAMESPACE = "gateway.mutation-conflict/v1" as const;
const GATEWAY_HOLD_CUTOVER_NAMESPACE = "gateway.hold-cutover/v1" as const;

interface DurableMutationHold {
  readonly schema: typeof GATEWAY_MUTATION_HOLD_NAMESPACE;
  readonly tenantId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly recordVersion: number;
  readonly holdId: `vh:${string}`;
  readonly rsid: string;
  readonly mutationScopeJcs: string;
  readonly originIdempotencyKeys: readonly string[];
  readonly state: "active" | "evidence_recorded" | "resolved_pending_bridge" | "cleared";
  readonly evidenceIds: readonly string[];
  readonly evidenceDigests: readonly string[];
  readonly resolutionIds: readonly string[];
}

interface DurableMutationConflict {
  readonly schema: typeof GATEWAY_MUTATION_CONFLICT_NAMESPACE;
  readonly tenantId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly recordVersion: number;
  readonly rsid: string;
  readonly scopeDigest: `sha256:${string}`;
  readonly holdId: `vh:${string}`;
  readonly mutationScopeJcs: string;
  readonly active: boolean;
}

interface DurableHoldCutover {
  readonly schema: typeof GATEWAY_HOLD_CUTOVER_NAMESPACE;
  readonly tenantId: string;
  readonly rsid: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly recordVersion: number;
  readonly legacyDigest: `sha256:${string}`;
  readonly importedHoldCount: number;
  readonly importedConflictCount: number;
  readonly importedResolutionCount: number;
  readonly targetGeneration: "normalized-v1";
  readonly state: "normalized_authoritative";
  readonly cutoverAtMs: number;
}

type DurableUnregisterWrite =
  | {
      readonly kind: "created";
      readonly tombstone: DurableUnregisterTombstone;
      readonly pendingOutcome: GatewayExecutorOutcome | null;
      readonly pendingCorrelationId: string | null;
    }
  | { readonly kind: "replay"; readonly tombstone: DurableUnregisterTombstone }
  | { readonly kind: "rejected"; readonly reason: string };

interface LiveConnection {
  readonly connectionId: string;
  readonly binding: BindingKind;
  readonly auth: DeviceAuthContext;
  readonly grantedCapabilities: readonly string[];
  readonly lifecycle: ConnectionLifecycleState;
  send(serialized: string): Promise<void>;
  close(code: number, reason: string): Promise<void>;
}

interface ActiveSession {
  readonly tenantId: string;
  readonly rsid: string;
  record: DurableRbpSession;
}

interface PendingWaiter {
  resolve(outcome: GatewayExecutorOutcome): void;
  timer: ReturnType<typeof setTimeout>;
  readonly mutating: boolean;
}

interface DurableEgressReservation {
  readonly tenantId: string;
  readonly rsid: string;
  readonly lease: DurableEgressLease;
  readonly record: DurableRbpSession;
}

interface ReservedResumeAck extends DurableEgressReservation {
  readonly serialized: string;
}

interface PendingRevocationAuthority {
  readonly stored: StoredRecord<GatewayJsonValue>;
  readonly record: DurableRbpSession;
  readonly revocation: DurableEgressRevocation;
  readonly candidates: readonly NormalizedHoldCandidate[];
}

export interface BridgeConnectionChannel {
  send(serialized: string): Promise<void>;
  close(code: number, reason: string): Promise<void>;
}

export interface BridgeConnectionOpening {
  readonly connectionId: string;
  readonly helloAck: HelloAckEnvelope;
}

export class GatewayRbpFault extends Error {
  public constructor(
    public readonly code:
      | "auth"
      | "protocol"
      | "unsupported"
      | "unavailable",
    message: string,
    public readonly httpStatus: number,
    public readonly closeCode: number,
  ) {
    super(message);
    this.name = "GatewayRbpFault";
  }
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function asJson(value: unknown): GatewayJsonValue {
  return structuredClone(value) as GatewayJsonValue;
}

function asProtocolJson(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every(
    (key, index) => key === canonical[index],
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isBoundedNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DURABLE_STRING_LENGTH
  );
}

function isStrictSortedUniqueStrings(
  value: unknown,
  maximum: number,
  member: (candidate: string) => boolean = isBoundedNonEmptyString,
): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  return value.every(
    (candidate, index) =>
      typeof candidate === "string" &&
      member(candidate) &&
      (index === 0 || candidate > (value[index - 1] as string)),
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
  } catch {
    return false;
  }
}

function openEgressFence(): DurableEgressFence {
  return {
    version: 1,
    state: "open",
    epoch: 0,
    nextTicket: 1,
    lease: null,
    revocation: null,
  };
}

function emptyNormalizedConflictIndex(): DurableNormalizedConflictIndex {
  return { version: 1, state: "complete", scopeDigests: [] };
}

function parseEgressLease(value: unknown): DurableEgressLease {
  if (!isRecord(value) || !hasExactKeys(value, [
    "leaseId",
    "ticket",
    "holderInstanceId",
    "connectionId",
    "operation",
    "envelopeDigest",
    "phase",
    "reservedAtMs",
    "reserveExpiresAtMs",
    "startedAtMs",
  ])) {
    throw new Error("malformed egress lease");
  }
  const phase = value.phase;
  if (
    !isBoundedNonEmptyString(value.leaseId) ||
    !isGatewayUuidV7(value.leaseId) ||
    !isSafePositiveInteger(value.ticket) ||
    !isBoundedNonEmptyString(value.holderInstanceId) ||
    !isGatewayUuidV7(value.holderInstanceId) ||
    !isBoundedNonEmptyString(value.connectionId) ||
    (value.operation !== "dispatch" &&
      value.operation !== "resume_ack" &&
      value.operation !== "resume_retransmit") ||
    typeof value.envelopeDigest !== "string" ||
    !DIGEST_PATTERN.test(value.envelopeDigest) ||
    (phase !== "reserved" && phase !== "started") ||
    !isSafeNonNegativeInteger(value.reservedAtMs) ||
    !isSafeNonNegativeInteger(value.reserveExpiresAtMs) ||
    value.reserveExpiresAtMs !== value.reservedAtMs + SEND_RESERVATION_TTL_MS ||
    (phase === "reserved"
      ? value.startedAtMs !== null
      : !isSafeNonNegativeInteger(value.startedAtMs) ||
        value.startedAtMs < value.reservedAtMs)
  ) {
    throw new Error("malformed egress lease");
  }
  return value as unknown as DurableEgressLease;
}

function parseEgressRevocation(value: unknown): DurableEgressRevocation {
  if (!isRecord(value) || !hasExactKeys(value, [
    "owner",
    "reason",
    "acceptedConnectionId",
    "requestedAtMs",
    "drainDeadlineAtMs",
  ])) {
    throw new Error("malformed egress revocation");
  }
  const owner = value.owner;
  if (
    !isRecord(owner) ||
    !hasExactKeys(owner, ["userId", "deviceId", "seatId"]) ||
    !isBoundedNonEmptyString(owner.userId) ||
    !isBoundedNonEmptyString(owner.deviceId) ||
    !isBoundedNonEmptyString(owner.seatId) ||
    !isUnregisterReason(value.reason) ||
    !isBoundedNonEmptyString(value.acceptedConnectionId) ||
    !isSafeNonNegativeInteger(value.requestedAtMs) ||
    !isSafeNonNegativeInteger(value.drainDeadlineAtMs) ||
    value.drainDeadlineAtMs !== value.requestedAtMs + UNREGISTER_DRAIN_TIMEOUT_MS
  ) {
    throw new Error("malformed egress revocation");
  }
  return value as unknown as DurableEgressRevocation;
}

function parseEgressFence(value: unknown): DurableEgressFence {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "state",
    "epoch",
    "nextTicket",
    "lease",
    "revocation",
  ])) {
    throw new Error("malformed egress fence");
  }
  if (
    value.version !== 1 ||
    (value.state !== "open" && value.state !== "revocation_pending") ||
    !isSafeNonNegativeInteger(value.epoch) ||
    !isSafePositiveInteger(value.nextTicket)
  ) {
    throw new Error("malformed egress fence");
  }
  const lease = value.lease === null ? null : parseEgressLease(value.lease);
  const revocation = value.revocation === null
    ? null
    : parseEgressRevocation(value.revocation);
  if (
    (value.state === "open" && revocation !== null) ||
    (value.state === "revocation_pending" && revocation === null) ||
    (value.state === "revocation_pending" && lease?.phase === "reserved") ||
    (lease !== null && lease.ticket >= value.nextTicket)
  ) {
    throw new Error("malformed egress fence");
  }
  return { ...value, lease, revocation } as DurableEgressFence;
}

function parseNormalizedConflictIndex(
  value: unknown,
): DurableNormalizedConflictIndex {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "state",
    "scopeDigests",
  ])) {
    throw new Error("malformed normalized conflict index");
  }
  if (
    value.version !== 1 ||
    (value.state !== "complete" && value.state !== "overflow") ||
    !isStrictSortedUniqueStrings(
      value.scopeDigests,
      MAX_NORMALIZED_CONFLICT_INDEX_ENTRIES,
      (candidate) => DIGEST_PATTERN.test(candidate),
    )
  ) {
    throw new Error("malformed normalized conflict index");
  }
  return value as unknown as DurableNormalizedConflictIndex;
}

function sessionEgressFence(record: DurableRbpSession): DurableEgressFence {
  return record.egressFence === undefined
    ? openEgressFence()
    : parseEgressFence(record.egressFence);
}

function sessionConflictIndex(
  record: DurableRbpSession,
): DurableNormalizedConflictIndex {
  return record.normalizedConflictIndex === undefined
    ? emptyNormalizedConflictIndex()
    : parseNormalizedConflictIndex(record.normalizedConflictIndex);
}

function parseStoredSession(
  stored: StoredRecord<GatewayJsonValue>,
  tenantId: string,
  rsid: string,
): DurableRbpSession {
  if (!isRecord(stored.value)) throw new Error("malformed durable session");
  const candidate = stored.value as unknown as DurableRbpSession;
  if (
    candidate.schema !== GATEWAY_RBP_SESSION_NAMESPACE ||
    candidate.tenantId !== tenantId ||
    stored.tenantId !== tenantId ||
    stored.key !== rsid ||
    candidate.rsid !== rsid ||
    (candidate.recordVersion !== undefined &&
      (!isSafePositiveInteger(candidate.recordVersion) ||
        candidate.recordVersion > stored.version)) ||
    !isSafeNonNegativeInteger(candidate.updatedAtMs) ||
    (candidate.createdAtMs !== undefined &&
      (!isSafeNonNegativeInteger(candidate.createdAtMs) ||
        candidate.createdAtMs > candidate.updatedAtMs))
  ) {
    throw new Error("malformed durable session");
  }
  sessionEgressFence(candidate);
  sessionConflictIndex(candidate);
  return candidate;
}

function nextSessionRecord(
  stored: StoredRecord<GatewayJsonValue>,
  current: DurableRbpSession,
  next: DurableRbpSession,
  nowMs: number,
): DurableRbpSession {
  const createdAtMs = current.createdAtMs ?? current.updatedAtMs;
  const updatedAtMs = Math.max(nowMs, current.updatedAtMs + 1);
  return {
    ...next,
    createdAtMs,
    updatedAtMs,
    recordVersion: stored.version + 1,
    egressFence: sessionEgressFence(next),
    normalizedConflictIndex: sessionConflictIndex(next),
  };
}

function scopeFromCanonicalJcs(value: string): MutationScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("mutation scope JCS is not JSON");
  }
  if (!isRecord(parsed)) throw new Error("mutation scope JCS is invalid");
  let scope: MutationScope;
  if (hasExactKeys(parsed, ["kind"]) && parsed.kind === "session") {
    scope = { kind: "session" };
  } else if (
    hasExactKeys(parsed, ["document_id", "kind"]) &&
    parsed.kind === "document" &&
    isBoundedNonEmptyString(parsed.document_id)
  ) {
    scope = { kind: "document", document_id: parsed.document_id };
  } else {
    throw new Error("mutation scope JCS is invalid");
  }
  if (mutationScopeKey(scope) !== value) {
    throw new Error("mutation scope JCS is not canonical");
  }
  return scope;
}

function conflictScopeDigest(scopeJcs: string): `sha256:${string}` {
  return digest(scopeJcs);
}

function conflictRecordKey(
  rsid: string,
  scopeDigest: `sha256:${string}`,
): string {
  return `${rsid}/${scopeDigest}`;
}

function extendConflictIndex(
  current: DurableNormalizedConflictIndex,
  additions: readonly `sha256:${string}`[],
): DurableNormalizedConflictIndex {
  if (current.state === "overflow") return current;
  const existing = [...current.scopeDigests];
  const missing = [...new Set(additions)]
    .filter((candidate) => !existing.includes(candidate))
    .sort();
  const available = MAX_NORMALIZED_CONFLICT_INDEX_ENTRIES - existing.length;
  const accepted = missing.slice(0, Math.max(0, available));
  return {
    version: 1,
    state: missing.length > accepted.length ? "overflow" : "complete",
    scopeDigests: [...existing, ...accepted].sort(),
  };
}

function connectionTransition(
  state: ConnectionLifecycleState,
  event: Parameters<typeof transitionConnection>[1],
): ConnectionLifecycleState {
  const transitioned = transitionConnection(state, event);
  if (transitioned.kind !== "transitioned") {
    throw new Error(`invalid RBP connection transition: ${transitioned.event}`);
  }
  return transitioned.state;
}

function sessionTransition(
  state: SessionLifecycleState,
  event: Parameters<typeof transitionSession>[1],
): SessionLifecycleState {
  const transitioned = transitionSession(state, event);
  if (transitioned.kind !== "transitioned") {
    throw new Error(`invalid RBP session transition: ${transitioned.event}`);
  }
  return transitioned.state;
}

function steadyConnectionLifecycle(
  capabilities: readonly string[],
): ConnectionLifecycleState {
  let state = createConnectionLifecycle();
  state = connectionTransition(state, { type: "start" });
  state = connectionTransition(state, { type: "transport_opened" });
  state = connectionTransition(state, { type: "authentication_accepted" });
  return connectionTransition(state, {
    type: "hello_accepted",
    selectedProtocol: 1,
    grantedCapabilities: capabilities,
  });
}

function registeredSessionLifecycle(
  localSessionKey: string,
  rsid: string,
): SessionLifecycleState {
  let state = createSessionLifecycle(localSessionKey);
  state = sessionTransition(state, { type: "register_requested" });
  return sessionTransition(state, { type: "registered", rsid });
}

function sameTombstoneOwner(
  owner: DurableUnregisterTombstone["owner"],
  record: Pick<DurableRbpSession, "deviceId" | "userId" | "seatId">,
): boolean {
  return (
    owner.deviceId === record.deviceId &&
    owner.userId === record.userId &&
    owner.seatId === record.seatId
  );
}

function isUnregisterReason(value: unknown): value is SessionUnregister["reason"] {
  return (
    value === "revit_exited" ||
    value === "bridge_shutdown" ||
    value === "session_replaced" ||
    value === "operator_requested"
  );
}

/** Do not interpret malformed durable state as an absent revocation. */
function parseUnregisterTombstone(
  value: unknown,
  expected?: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly stored?: StoredRecord<GatewayJsonValue>;
  },
): DurableUnregisterTombstone {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schema",
    "recordVersion",
    "tenantId",
    "createdAtMs",
    "updatedAtMs",
    "rsid",
    "sessionBindingId",
    "owner",
    "reason",
    "revokedAtMs",
    "acceptedConnectionId",
    "pendingDisposition",
    "holdIds",
    "cleanupState",
  ])) {
    throw new Error("malformed unregister tombstone");
  }
  const candidate = value;
  const owner = candidate.owner;
  const holdIds = candidate.holdIds;
  if (
    candidate.schema !== GATEWAY_RBP_UNREGISTER_NAMESPACE ||
    candidate.recordVersion !== 1 ||
    !isBoundedNonEmptyString(candidate.tenantId) ||
    !isSafeNonNegativeInteger(candidate.createdAtMs) ||
    !isSafeNonNegativeInteger(candidate.updatedAtMs) ||
    candidate.createdAtMs > candidate.updatedAtMs ||
    !isBoundedNonEmptyString(candidate.rsid) ||
    !isBoundedNonEmptyString(candidate.sessionBindingId) ||
    !isRecord(owner) ||
    !hasExactKeys(owner, ["deviceId", "userId", "seatId"]) ||
    !isBoundedNonEmptyString(owner.deviceId) ||
    !isBoundedNonEmptyString(owner.userId) ||
    !isBoundedNonEmptyString(owner.seatId) ||
    !isUnregisterReason(candidate.reason) ||
    !isSafeNonNegativeInteger(candidate.revokedAtMs) ||
    candidate.revokedAtMs < candidate.createdAtMs ||
    candidate.revokedAtMs > candidate.updatedAtMs ||
    !isBoundedNonEmptyString(candidate.acceptedConnectionId) ||
    (candidate.pendingDisposition !== "none" &&
      candidate.pendingDisposition !== "read_closed" &&
      candidate.pendingDisposition !== "mutation_indeterminate") ||
    !isStrictSortedUniqueStrings(
      holdIds,
      MAX_NORMALIZED_CONFLICT_INDEX_ENTRIES,
      (holdId) => HOLD_ID_PATTERN.test(holdId),
    ) ||
    (candidate.pendingDisposition === "mutation_indeterminate" &&
      holdIds.length === 0) ||
    (candidate.pendingDisposition !== "mutation_indeterminate" &&
      holdIds.length !== 0) ||
    (candidate.cleanupState !== "retained" &&
      candidate.cleanupState !== "cleanup_pending")
  ) {
    throw new Error("malformed unregister tombstone");
  }
  if (
    expected !== undefined &&
    (candidate.tenantId !== expected.tenantId ||
      candidate.rsid !== expected.rsid ||
      (expected.stored !== undefined &&
        (expected.stored.namespace !== GATEWAY_RBP_UNREGISTER_NAMESPACE ||
          expected.stored.tenantId !== expected.tenantId ||
          expected.stored.key !== expected.rsid ||
          expected.stored.version < 1)))
  ) {
    throw new Error("unregister tombstone key or tenant mismatch");
  }
  return candidate as unknown as DurableUnregisterTombstone;
}

function parseMutationHold(
  stored: StoredRecord<GatewayJsonValue>,
  tenantId: string,
  rsid: string,
): { readonly hold: DurableMutationHold; readonly scope: MutationScope } {
  if (!isRecord(stored.value) || !hasExactKeys(stored.value, [
    "schema",
    "tenantId",
    "createdAtMs",
    "updatedAtMs",
    "recordVersion",
    "holdId",
    "rsid",
    "mutationScopeJcs",
    "originIdempotencyKeys",
    "state",
    "evidenceIds",
    "evidenceDigests",
    "resolutionIds",
  ])) {
    throw new Error("malformed normalized mutation hold");
  }
  const candidate = stored.value;
  if (
    stored.namespace !== GATEWAY_MUTATION_HOLD_NAMESPACE ||
    stored.tenantId !== tenantId ||
    candidate.schema !== GATEWAY_MUTATION_HOLD_NAMESPACE ||
    candidate.tenantId !== tenantId ||
    candidate.rsid !== rsid ||
    !isBoundedNonEmptyString(candidate.rsid) ||
    !isSafeNonNegativeInteger(candidate.createdAtMs) ||
    !isSafeNonNegativeInteger(candidate.updatedAtMs) ||
    candidate.createdAtMs > candidate.updatedAtMs ||
    !isSafePositiveInteger(candidate.recordVersion) ||
    candidate.recordVersion > stored.version ||
    typeof candidate.holdId !== "string" ||
    !HOLD_ID_PATTERN.test(candidate.holdId) ||
    stored.key !== candidate.holdId ||
    !isBoundedNonEmptyString(candidate.mutationScopeJcs) ||
    !isStrictSortedUniqueStrings(
      candidate.originIdempotencyKeys,
      MAX_HOLD_AUDIT_ENTRIES,
      (origin) =>
        origin.startsWith(`${rsid}/`) && origin.length > rsid.length + 1,
    ) ||
    (candidate.state !== "active" &&
      candidate.state !== "evidence_recorded" &&
      candidate.state !== "resolved_pending_bridge" &&
      candidate.state !== "cleared") ||
    !isStrictSortedUniqueStrings(
      candidate.evidenceIds,
      MAX_HOLD_AUDIT_ENTRIES,
    ) ||
    !isStrictSortedUniqueStrings(
      candidate.evidenceDigests,
      MAX_HOLD_AUDIT_ENTRIES,
      (evidenceDigest) => DIGEST_PATTERN.test(evidenceDigest),
    ) ||
    !isStrictSortedUniqueStrings(
      candidate.resolutionIds,
      MAX_HOLD_AUDIT_ENTRIES,
      (resolutionId) => isGatewayUuidV7(resolutionId),
    )
  ) {
    throw new Error("malformed normalized mutation hold");
  }
  const scope = scopeFromCanonicalJcs(candidate.mutationScopeJcs);
  if (
    makeMutationHoldId(
      rsid,
      scope,
      candidate.originIdempotencyKeys,
    ) !== candidate.holdId
  ) {
    throw new Error("normalized mutation hold identity mismatch");
  }
  return {
    hold: candidate as unknown as DurableMutationHold,
    scope,
  };
}

function parseMutationConflict(
  stored: StoredRecord<GatewayJsonValue>,
  tenantId: string,
  rsid: string,
): { readonly conflict: DurableMutationConflict; readonly scope: MutationScope } {
  if (!isRecord(stored.value) || !hasExactKeys(stored.value, [
    "schema",
    "tenantId",
    "createdAtMs",
    "updatedAtMs",
    "recordVersion",
    "rsid",
    "scopeDigest",
    "holdId",
    "mutationScopeJcs",
    "active",
  ])) {
    throw new Error("malformed normalized mutation conflict");
  }
  const candidate = stored.value;
  if (
    stored.namespace !== GATEWAY_MUTATION_CONFLICT_NAMESPACE ||
    stored.tenantId !== tenantId ||
    candidate.schema !== GATEWAY_MUTATION_CONFLICT_NAMESPACE ||
    candidate.tenantId !== tenantId ||
    candidate.rsid !== rsid ||
    !isSafeNonNegativeInteger(candidate.createdAtMs) ||
    !isSafeNonNegativeInteger(candidate.updatedAtMs) ||
    candidate.createdAtMs > candidate.updatedAtMs ||
    !isSafePositiveInteger(candidate.recordVersion) ||
    candidate.recordVersion > stored.version ||
    typeof candidate.scopeDigest !== "string" ||
    !DIGEST_PATTERN.test(candidate.scopeDigest) ||
    typeof candidate.holdId !== "string" ||
    !HOLD_ID_PATTERN.test(candidate.holdId) ||
    !isBoundedNonEmptyString(candidate.mutationScopeJcs) ||
    typeof candidate.active !== "boolean"
  ) {
    throw new Error("malformed normalized mutation conflict");
  }
  const scope = scopeFromCanonicalJcs(candidate.mutationScopeJcs);
  const expectedDigest = conflictScopeDigest(candidate.mutationScopeJcs);
  if (
    candidate.scopeDigest !== expectedDigest ||
    stored.key !== conflictRecordKey(rsid, expectedDigest)
  ) {
    throw new Error("normalized mutation conflict identity mismatch");
  }
  return {
    conflict: candidate as unknown as DurableMutationConflict,
    scope,
  };
}

function parseHoldCutover(
  stored: StoredRecord<GatewayJsonValue>,
  tenantId: string,
  rsid: string,
): DurableHoldCutover {
  if (!isRecord(stored.value) || !hasExactKeys(stored.value, [
    "schema",
    "tenantId",
    "rsid",
    "createdAtMs",
    "updatedAtMs",
    "recordVersion",
    "legacyDigest",
    "importedHoldCount",
    "importedConflictCount",
    "importedResolutionCount",
    "targetGeneration",
    "state",
    "cutoverAtMs",
  ])) {
    throw new Error("malformed normalized hold cutover marker");
  }
  const candidate = stored.value;
  if (
    stored.namespace !== GATEWAY_HOLD_CUTOVER_NAMESPACE ||
    stored.tenantId !== tenantId ||
    stored.key !== rsid ||
    candidate.schema !== GATEWAY_HOLD_CUTOVER_NAMESPACE ||
    candidate.tenantId !== tenantId ||
    candidate.rsid !== rsid ||
    !isSafeNonNegativeInteger(candidate.createdAtMs) ||
    !isSafeNonNegativeInteger(candidate.updatedAtMs) ||
    !isSafeNonNegativeInteger(candidate.cutoverAtMs) ||
    candidate.createdAtMs > candidate.cutoverAtMs ||
    candidate.cutoverAtMs > candidate.updatedAtMs ||
    !isSafePositiveInteger(candidate.recordVersion) ||
    candidate.recordVersion > stored.version ||
    typeof candidate.legacyDigest !== "string" ||
    !DIGEST_PATTERN.test(candidate.legacyDigest) ||
    !isSafeNonNegativeInteger(candidate.importedHoldCount) ||
    !isSafeNonNegativeInteger(candidate.importedConflictCount) ||
    !isSafeNonNegativeInteger(candidate.importedResolutionCount) ||
    candidate.targetGeneration !== "normalized-v1" ||
    candidate.state !== "normalized_authoritative"
  ) {
    throw new Error("malformed normalized hold cutover marker");
  }
  return candidate as unknown as DurableHoldCutover;
}

interface ValidatedLegacyHold {
  readonly holdId: string;
  readonly state: "active" | "evidence_recorded" | "resolved_pending_bridge" | "cleared";
  readonly mutationScope: MutationScope;
  readonly originIdempotencyKeys: readonly string[];
}

function parseLegacyRecoveryHolds(
  value: unknown,
  rsid: string,
): readonly ValidatedLegacyHold[] {
  if (
    !isRecord(value) ||
    value.contractVersion !== "revagent.gateway-recovery/v1" ||
    value.rsid !== rsid ||
    !isRecord(value.ledger)
  ) {
    throw new Error("malformed legacy recovery authority");
  }
  const holds = value.ledger.holds;
  if (!Array.isArray(holds) || holds.length > MAX_HOLD_AUDIT_ENTRIES) {
    throw new Error("malformed legacy recovery authority");
  }
  return holds.map((raw) => {
    if (!isRecord(raw) || !isRecord(raw.mutationScope)) {
      throw new Error("malformed legacy recovery hold");
    }
    let scope: MutationScope;
    if (
      hasExactKeys(raw.mutationScope, ["kind"]) &&
      raw.mutationScope.kind === "session"
    ) {
      scope = { kind: "session" };
    } else if (
      hasExactKeys(raw.mutationScope, ["document_id", "kind"]) &&
      raw.mutationScope.kind === "document" &&
      isBoundedNonEmptyString(raw.mutationScope.document_id)
    ) {
      scope = { kind: "document", document_id: raw.mutationScope.document_id };
    } else {
      throw new Error("malformed legacy recovery hold");
    }
    if (
      raw.rsid !== rsid ||
      typeof raw.scopeKey !== "string" ||
      raw.scopeKey !== mutationScopeKey(scope) ||
      typeof raw.holdId !== "string" ||
      !HOLD_ID_PATTERN.test(raw.holdId) ||
      !Array.isArray(raw.originIdempotencyKeys) ||
      raw.originIdempotencyKeys.length === 0 ||
      raw.originIdempotencyKeys.length > MAX_HOLD_AUDIT_ENTRIES ||
      (raw.originIdempotencyKeys as unknown[]).some(
        (origin, index) =>
          typeof origin !== "string" ||
          !origin.startsWith(`${rsid}/`) ||
          origin.length <= rsid.length + 1 ||
          (raw.originIdempotencyKeys as unknown[]).indexOf(origin) !== index,
      ) ||
      makeMutationHoldId(
        rsid,
        scope,
        raw.originIdempotencyKeys as string[],
      ) !== raw.holdId ||
      (raw.state !== "active" &&
        raw.state !== "evidence_recorded" &&
        raw.state !== "resolved_pending_bridge" &&
        raw.state !== "cleared")
    ) {
      throw new Error("malformed legacy recovery hold");
    }
    return {
      holdId: raw.holdId,
      state: raw.state,
      mutationScope: scope,
      originIdempotencyKeys: [...raw.originIdempotencyKeys] as string[],
    };
  });
}

interface NormalizedHoldCandidate {
  readonly holdId: `vh:${string}`;
  readonly mutationScope: MutationScope;
  readonly mutationScopeJcs: string;
  readonly originIdempotencyKeys: readonly string[];
}

function normalizedHoldCandidates(
  rsid: string,
  entries: readonly DurablePendingMutation[],
): readonly NormalizedHoldCandidate[] {
  if (entries.length === 0) return [];
  const allOrigins = [...new Set(entries.map((entry) => entry.originIdempotencyKey))].sort();
  const groups = entries.some((entry) => entry.mutationScope.kind === "session")
    ? [{ mutationScope: { kind: "session" } as MutationScope, origins: allOrigins }]
    : [...new Map(entries.map((entry) => [
        mutationScopeKey(entry.mutationScope),
        entry.mutationScope,
      ])).entries()].map(([scopeJcs, mutationScope]) => ({
        mutationScope,
        origins: entries
          .filter((entry) => mutationScopeKey(entry.mutationScope) === scopeJcs)
          .map((entry) => entry.originIdempotencyKey)
          .sort(),
      }));
  return groups.map(({ mutationScope, origins }) => ({
    holdId: makeMutationHoldId(rsid, mutationScope, origins),
    mutationScope,
    mutationScopeJcs: mutationScopeKey(mutationScope),
    originIdempotencyKeys: origins,
  })).sort((left, right) => left.holdId.localeCompare(right.holdId));
}

function immutableEnvelopeDigest(envelope: RbpEnvelope): `sha256:${string}` {
  if (!("rsid" in envelope) || typeof envelope.rsid !== "string") {
    throw new GatewayRbpFault("protocol", "data envelope required", 400, 4400);
  }
  return dataEnvelopeImmutableDigest(envelope as DataEnvelopeSnapshot);
}

function pendingMutationEntries(
  envelope: InvokeEnvelope | InvokeBatchEnvelope,
): readonly DurablePendingMutation[] {
  const steps = envelope.type === "invoke"
    ? [envelope.payload]
    : envelope.payload.steps;
  return steps.flatMap((step) =>
    step.mutating && step.mutation_scope !== null
      ? [{
          invocationId: step.invocation_id,
          originIdempotencyKey: `${envelope.rsid}/${step.invocation_id}`,
          mutationScope: step.mutation_scope,
        }]
      : [],
  );
}

function durablePendingMutationEntries(
  record: DurableRbpSession,
): readonly DurablePendingMutation[] {
  const pending = record.pending;
  if (pending === null) return [];
  if (pending.mutationEntries.length > 0) return pending.mutationEntries;
  return pending.journalRecords.flatMap((journal) =>
    journal.binding.mutating && journal.binding.mutationScope !== null
      ? [{
          invocationId: journal.binding.invocationId,
          originIdempotencyKey: `${record.rsid}/${journal.binding.invocationId}`,
          mutationScope: journal.binding.mutationScope,
        }]
      : [],
  );
}

function liveDocumentRouteFrom(
  payload: DocContextUpdate,
  connectionId: string,
  sequence: number,
): DurableLiveDocumentRoute | null {
  const documentIds = new Set<string>();
  const activeDocuments: string[] = [];
  for (const document of payload.documents) {
    if (documentIds.has(document.document_id)) {
      throw new GatewayRbpFault(
        "protocol",
        "document context is inconsistent",
        400,
        4400,
      );
    }
    documentIds.add(document.document_id);
    if (document.is_active) activeDocuments.push(document.document_id);
  }

  if (payload.active_document === null) {
    if (activeDocuments.length !== 0) {
      throw new GatewayRbpFault(
        "protocol",
        "document context is inconsistent",
        400,
        4400,
      );
    }
    return null;
  }

  if (
    activeDocuments.length !== 1 ||
    activeDocuments[0] !== payload.active_document ||
    !documentIds.has(payload.active_document)
  ) {
    throw new GatewayRbpFault(
      "protocol",
      "document context is inconsistent",
      400,
      4400,
    );
  }

  return {
    sessionDocumentId: payload.active_document,
    observedConnectionId: connectionId,
    observedSequence: sequence,
  };
}

function invocationPolicy(request: GatewayExecutorRequest): InvokeEnvelope["payload"]["policy"] {
  if (request.context.policyClass === "auto") {
    return { class: "auto", decision: "auto", confirmation_id: null };
  }
  if (request.context.policyClass === "confirm") {
    if (request.context.confirmationId === null) {
      throw new GatewayRbpFault("protocol", "confirmed invocation lacks confirmation id", 409, 4400);
    }
    return {
      class: "confirm",
      decision: "confirmed",
      confirmation_id: request.context.confirmationId,
    };
  }
  if (request.context.confirmationId === null) {
    throw new GatewayRbpFault("protocol", "gated invocation lacks approval id", 409, 4400);
  }
  return {
    class: "gated",
    decision: "gated_approved",
    confirmation_id: request.context.confirmationId,
  };
}

function invocationPayload(request: GatewayExecutorRequest): InvokeEnvelope["payload"] {
  return {
    invocation_id: request.context.invocationId,
    method: request.executorMethod,
    params: asJson(request.args),
    mutating: request.context.mutating,
    mutation_scope: request.context.mutationScope,
    policy: invocationPolicy(request),
    timeout_ms: INVOCATION_TIMEOUT_MS,
    verification: null,
    recovery_clearances: [],
  } as InvokeEnvelope["payload"];
}

function atomicBatchPayload(
  request: GatewayAtomicBatchExecutorRequest,
): InvokeBatchEnvelope["payload"] {
  const steps = request.steps.map((step) => {
    const invocation = invocationPayload(step);
    return {
      invocation_id: invocation.invocation_id,
      method: invocation.method,
      params: invocation.params,
      params_digest: step.context.paramsDigest,
      mutating: invocation.mutating,
      mutation_scope: invocation.mutation_scope,
      policy: invocation.policy,
    };
  }) as InvokeBatchEnvelope["payload"]["steps"];
  const digestInput = {
    atomic: true as const,
    batch_id: request.batchId,
    recovery_clearances: [],
    steps: steps.map((step) => ({
      invocation_id: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutation_scope: step.mutation_scope as JsonValue,
      params_digest: step.params_digest,
      policy: step.policy,
    })),
    timeout_ms: INVOCATION_TIMEOUT_MS,
  };
  return {
    batch_id: request.batchId,
    atomic: true,
    timeout_ms: INVOCATION_TIMEOUT_MS,
    recovery_clearances: [],
    steps,
    batch_digest: makeBatchDigest(digestInput),
  };
}

function terminalOutcome(
  envelope: Extract<RbpEnvelope, { type: "result" | "error" }>,
): GatewayExecutorOutcome {
  if (envelope.type === "error") {
    return {
      state: "failed",
      error: {
        code: envelope.payload.fault_class,
        message: envelope.payload.message,
      },
    };
  }
  if (envelope.payload.kind === "batch") {
    if (envelope.payload.status === "completed") {
      return { state: "completed", result: asJson(envelope.payload) };
    }
    if (envelope.payload.status === "guarded") {
      const guarded = envelope.payload.steps.find(
        (step) => step.status === "guarded",
      );
      return guarded === undefined
        ? {
            state: "failed",
            error: {
              code: "protocol",
              message: "guarded batch omitted its guarded step",
            },
          }
        : {
            state: "guarded",
            reason: guarded.guarded_reason,
            result: asJson(envelope.payload),
          };
    }
    return {
      state: "failed",
      error: {
        code:
          envelope.payload.status === "indeterminate"
            ? "journal_indeterminate"
            : envelope.payload.status,
        message: `atomic batch recorded ${envelope.payload.status}`,
      },
    };
  }
  if (envelope.payload.status === "guarded") {
    return {
      state: "guarded",
      reason: envelope.payload.guarded_reason,
      result: asJson(envelope.payload.result ?? null),
    };
  }
  return {
    state: "completed",
    result: asJson(envelope.payload.result ?? null),
  };
}

function terminalJournalRecords(
  records: readonly InvocationJournalRecord[],
  envelope: Extract<RbpEnvelope, { type: "result" | "error" }>,
): readonly InvocationJournalRecord[] {
  if (records.length === 0) return [];
  if (envelope.type === "result" && envelope.payload.kind === "batch") {
    const steps = new Map(
      envelope.payload.steps.map((step) => [step.invocation_id, step]),
    );
    return records.map((record) => {
      const step = steps.get(record.binding.invocationId);
      if (step === undefined) return record;
      if (step.status === "not_started") {
        return createReceivedJournalRecord(record.binding);
      }
      if (step.status === "indeterminate") {
        return markJournalIndeterminate(
          record,
          step.error.verification_hold_id,
        );
      }
      const payloadRetained = step.payload_omitted !== true;
      if (step.status === "completed" || step.status === "guarded") {
        return recordJournalTerminal(record, {
          status: step.status,
          ...(typeof step.result_digest === "string"
            ? { resultDigest: step.result_digest }
            : {}),
          ...(step.status === "guarded"
            ? { guardedReason: step.guarded_reason }
            : {}),
          payloadRetained,
          ...(payloadRetained
            ? { payload: asProtocolJson(step.result ?? null) }
            : {}),
        });
      }
      return recordJournalTerminal(record, {
        status: step.status,
        ...(typeof step.result_digest === "string"
          ? { resultDigest: step.result_digest }
          : {}),
        payloadRetained: true,
        payload: asProtocolJson(step.error),
      });
    });
  }
  if (envelope.type === "result" && envelope.payload.kind === "invocation") {
    const payloadRetained = envelope.payload.payload_omitted !== true;
    return records.map((record) =>
      record.binding.invocationId !== envelope.payload.invocation_id
        ? record
        : recordJournalTerminal(record, {
            status:
              envelope.payload.status === "guarded" ? "guarded" : "completed",
            ...(typeof envelope.payload.result_digest === "string"
              ? { resultDigest: envelope.payload.result_digest }
              : {}),
            ...(envelope.payload.status === "guarded"
              ? {
                  guardedReason:
                    typeof envelope.payload.guarded_reason === "string"
                      ? envelope.payload.guarded_reason
                      : "guarded",
                }
              : {}),
            payloadRetained,
            ...(payloadRetained
              ? { payload: asProtocolJson(envelope.payload.result ?? null) }
              : {}),
          }),
    );
  }
  if (envelope.type === "error" && typeof envelope.payload.invocation_id === "string") {
    return records.map((record) =>
      record.binding.invocationId !== envelope.payload.invocation_id
        ? record
        : envelope.payload.fault_class === "journal_indeterminate"
          ? markJournalIndeterminate(
              record,
              envelope.payload.verification_hold_id,
            )
        : recordJournalTerminal(record, {
            status:
              envelope.payload.fault_class === "cancelled"
                ? "cancelled"
                : "failed",
            ...(typeof envelope.payload.result_digest === "string"
              ? { resultDigest: envelope.payload.result_digest }
              : {}),
            payloadRetained: true,
            payload: asProtocolJson({
              fault_class: envelope.payload.fault_class,
              message: envelope.payload.message,
            }),
          }),
    );
  }
  return records;
}

/**
 * One transport-neutral RBP authority for both primary WSS and HTTP/SSE.
 * All sequence changes are committed before bytes are acknowledged or emitted.
 */
export class GatewayBridgeSessionAuthority implements GatewayDurableBridgeEvidencePort {
  readonly #connections = new Map<string, LiveConnection>();
  readonly #active = new Map<string, ActiveSession>();
  readonly #waiters = new Map<string, PendingWaiter>();
  readonly #receiveTails = new Map<string, Promise<void>>();
  readonly #sessionAuthorizationTails = new Map<string, Promise<void>>();
  readonly #clock: () => number;
  readonly #instanceId: string;
  readonly #wait: (milliseconds: number) => Promise<void>;

  public constructor(
    readonly store: GatewayProtocolStore,
    readonly identity: IdentityPort,
    options: {
      readonly clock?: () => number;
      readonly instanceId?: string;
      readonly wait?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.#clock = options.clock ?? Date.now;
    this.#instanceId = options.instanceId ?? gatewayUuidV7(this.#clock());
    if (!isGatewayUuidV7(this.#instanceId)) {
      throw new TypeError("Gateway instanceId must be a UUIDv7");
    }
    this.#wait = options.wait ?? (async (milliseconds) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    });
  }

  public async open(): Promise<void> {
    const opened = await this.store.open();
    if (!opened.ok) {
      throw new GatewayRbpFault("unavailable", opened.message, 503, 1011);
    }
  }

  public async close(): Promise<void> {
    const connections = [...this.#connections.values()];
    const active = [...this.#active.values()];
    let shutdownError: unknown = null;
    for (const session of active) {
      try {
        await this.#markConnectionLost(session);
      } catch (error) {
        shutdownError ??= error;
      }
    }
    this.#connections.clear();
    this.#active.clear();
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.#indeterminateOutcome(waiter.mutating));
    }
    this.#waiters.clear();
    const drained = await Promise.allSettled(
      connections.map(async (connection) => {
        try {
          await connection.send(
            JSON.stringify({
              v: 1,
              type: "goodbye",
              id: gatewayUuidV7(this.#clock()),
              ts: nowIso(this.#clock()),
              payload: { reason: "server_draining", retry_after_ms: 1_000 },
            } satisfies RbpEnvelope),
          );
        } finally {
          await connection.close(1001, "server draining");
        }
      }),
    );
    const closed = await this.store.close();
    if (!closed.ok) throw new Error(closed.message);
    const drainFailure = drained.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (shutdownError !== null) throw shutdownError;
    if (drainFailure !== undefined) throw drainFailure.reason;
  }

  public async openConnection(input: {
    readonly deviceToken: string | undefined;
    readonly binding: BindingKind;
    readonly hello: HelloEnvelope;
    readonly channel: BridgeConnectionChannel;
  }): Promise<BridgeConnectionOpening> {
    if (
      input.hello.payload.min_protocol > 1 ||
      input.hello.payload.max_protocol < 1
    ) {
      throw new GatewayRbpFault("unsupported", "no mutually supported RBP version", 426, 4426);
    }
    const connectionId = gatewayUuidV7(this.#clock());
    const authenticated = await this.identity.authenticateDevice({
      deviceToken: input.deviceToken,
      connectionId,
    });
    if (!authenticated.ok) {
      throw new GatewayRbpFault("auth", authenticated.message, 401, 4401);
    }
    if (authenticated.value.deviceStatus !== "active") {
      throw new GatewayRbpFault("auth", "device or seat is not active", 403, 4403);
    }
    if (authenticated.value.actor.deviceId !== input.hello.payload.device_id) {
      throw new GatewayRbpFault("auth", "hello device identity does not match credential", 403, 4403);
    }
    const granted = SUPPORTED_CAPABILITIES.filter(
      (capability) =>
        input.hello.payload.capabilities.includes(capability) &&
        authenticated.value.grantedSessionCapabilities.includes(capability),
    );
    if (
      input.binding === "http_sse" &&
      !granted.includes("transport_streamable_http")
    ) {
      throw new GatewayRbpFault(
        "unsupported",
        "HTTP/SSE fallback was not provisioned and granted",
        403,
        4403,
      );
    }
    const connection: LiveConnection = {
      connectionId,
      binding: input.binding,
      auth: { ...authenticated.value, connectionId },
      grantedCapabilities: granted,
      lifecycle: steadyConnectionLifecycle(granted),
      async send(serialized): Promise<void> {
        await input.channel.send(serialized);
      },
      async close(code, reason): Promise<void> {
        await input.channel.close(code, reason);
      },
    };
    this.#connections.set(connectionId, connection);
    const helloAck: HelloAckEnvelope = {
      type: "hello_ack",
      id: gatewayUuidV7(this.#clock()),
      ts: nowIso(this.#clock()),
      payload: {
        protocol: 1,
        connection_id: connectionId,
        granted_capabilities: granted,
        heartbeat_interval_ms: 15_000,
        limits: {
          max_params_bytes: 4 * 1024 * 1024,
          max_result_bytes: 32 * 1024 * 1024,
          max_partial_bytes: 64 * 1024,
        },
        manifest: {
          latest_bridge_version: input.hello.payload.bridge_version,
          manifest_url: "https://gateway.invalid/bridge-manifest.json",
        },
      },
    };
    return { connectionId, helloAck };
  }

  public async assertConnectionCredential(
    connectionId: string,
    deviceToken: string | undefined,
  ): Promise<LiveConnection> {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) {
      throw new GatewayRbpFault("auth", "unknown connection", 404, 4401);
    }
    const authenticated = await this.identity.authenticateDevice({
      deviceToken,
      connectionId,
    });
    if (
      !authenticated.ok ||
      authenticated.value.deviceStatus !== "active" ||
      authenticated.value.actor.tenantId !== connection.auth.actor.tenantId ||
      authenticated.value.actor.deviceId !== connection.auth.actor.deviceId ||
      authenticated.value.deviceTokenDigest !== connection.auth.deviceTokenDigest
    ) {
      throw new GatewayRbpFault("auth", "connection credential mismatch", 403, 4403);
    }
    return connection;
  }

  public async receive(
    connectionId: string,
    envelope: RbpEnvelope,
  ): Promise<void> {
    const prior = this.#receiveTails.get(connectionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#receiveTails.set(connectionId, tail);
    await prior;
    try {
      await this.#receiveNow(connectionId, envelope);
    } finally {
      release();
      if (this.#receiveTails.get(connectionId) === tail) {
        this.#receiveTails.delete(connectionId);
      }
    }
  }

  async #withSessionAuthorization<T>(
    rsid: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#sessionAuthorizationTails.get(rsid) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#sessionAuthorizationTails.set(rsid, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#sessionAuthorizationTails.get(rsid) === tail) {
        this.#sessionAuthorizationTails.delete(rsid);
      }
    }
  }

  async #receiveNow(
    connectionId: string,
    envelope: RbpEnvelope,
  ): Promise<void> {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) {
      throw new GatewayRbpFault("auth", "unknown connection", 404, 4401);
    }
    switch (envelope.type) {
      case "session_register":
        await this.#register(connection, envelope.payload);
        return;
      case "session_resume":
        await this.#resume(connection, envelope.payload);
        return;
      case "session_unregister":
        await this.#unregister(connection, envelope.payload);
        return;
      case "heartbeat":
        await this.#heartbeat(connection, envelope.payload.acks);
        return;
      case "result":
      case "error":
      case "partial":
      case "doc_context_update":
        if (!("rsid" in envelope) || typeof envelope.rsid !== "string") {
          throw new GatewayRbpFault(
            "protocol",
            "bridge sent a connection-level error on an established channel",
            400,
            4400,
          );
        }
        await this.#acceptData(
          connection,
          envelope as Extract<RbpEnvelope, { rsid: string }>,
        );
        return;
      case "manifest_check":
        return;
      default:
        throw new GatewayRbpFault(
          "protocol",
          `bridge may not send ${envelope.type} in the steady state`,
          400,
          4400,
        );
    }
  }

  public async detach(connectionId: string): Promise<void> {
    this.#connections.delete(connectionId);
    for (const [rsid, active] of this.#active) {
      if (active.record.connectionId === connectionId) {
        await this.#markConnectionLost(active);
        this.#active.delete(rsid);
      }
    }
  }

  public async sweepLiveness(): Promise<readonly string[]> {
    const disconnected: string[] = [];
    for (const [rsid, active] of this.#active) {
      const silenceMs = Math.max(0, this.#clock() - active.record.lastHeartbeatAtMs);
      if (silenceMs < RBP_HEARTBEAT_DEGRADED_AFTER_MS) continue;
      const updated = await this.#updateSession(active.tenantId, rsid, (record) => ({
        ...record,
        connectionLifecycle: connectionTransition(record.connectionLifecycle, {
          type: "heartbeat_silence",
          silenceMs,
        }),
        updatedAtMs: this.#clock(),
      }));
      active.record = updated;
      if (silenceMs >= RBP_HEARTBEAT_DISCONNECTED_AFTER_MS) {
        disconnected.push(rsid);
        this.#active.delete(rsid);
      }
    }
    return disconnected;
  }

  public createExecutor(): GatewayExecutor {
    return new BridgeSessionExecutor(this);
  }

  /**
   * Resolves one authenticated north request to exactly one live Bridge
   * document. Zero and multiple candidates share one value-free refusal so
   * route topology is never disclosed to the caller.
   */
  public resolveLiveInvocationRoute(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly mcpSessionId: string;
  }): GatewayInvocationRoute {
    const candidates = [...this.#active.values()].filter((active) => {
      const record = active.record;
      return (
        record.tenantId === input.tenantId &&
        record.userId === input.userId &&
        record.deviceId === input.deviceId &&
        this.#connections.has(record.connectionId) &&
        record.sessionLifecycle.dispatchAllowed &&
        (record.connectionLifecycle.phase === "steady" ||
          record.connectionLifecycle.phase === "degraded") &&
        record.liveDocumentRoute !== null &&
        record.liveDocumentRoute !== undefined &&
        record.liveDocumentRoute.observedConnectionId === record.connectionId
      );
    });
    if (candidates.length !== 1) {
      throw new GatewayRbpFault(
        "unavailable",
        "live invocation route is unavailable",
        503,
        1011,
      );
    }
    const selected = candidates[0]!.record;
    return {
      tenantId: input.tenantId,
      mcpSessionId: input.mcpSessionId,
      rsid: selected.rsid,
      documentIdentity: {
        kind: "live",
        session_document_id: selected.liveDocumentRoute!.sessionDocumentId,
      },
    };
  }

  public buildEnvelope(request: GatewayExecutorRequest): {
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: InvokeEnvelope;
    readonly expected: GatewayExpectedMutationDispatch;
  } {
    const active = this.#active.get(request.context.rsid);
    if (
      active === undefined ||
      active.tenantId !== request.context.actor.tenantId ||
      !this.#connections.has(active.record.connectionId)
      || !active.record.sessionLifecycle.dispatchAllowed
      || (active.record.connectionLifecycle.phase !== "steady" &&
        active.record.connectionLifecycle.phase !== "degraded")
    ) {
      throw new GatewayRbpFault("unavailable", "registered rsid is not connected", 503, 1011);
    }
    const queued = queueOutboundData(active.record.sequence, {
      type: "invoke",
      id: gatewayUuidV7(this.#clock()),
      ack: active.record.sequence.lastRxSeq,
      ts: nowIso(this.#clock()),
      payload: invocationPayload(request) as JsonValue,
    });
    if (queued.kind !== "queued") {
      throw new GatewayRbpFault("protocol", "RBP sequence renewal required", 409, 4400);
    }
    const envelope = queued.envelope as InvokeEnvelope;
    const binding = {
      rsid: request.context.rsid,
      invocationId: request.context.invocationId,
      method: request.executorMethod,
      mutating: request.context.mutating,
      mutationScope: request.context.mutationScope,
      paramsDigest: request.context.paramsDigest,
      policy: envelope.payload.policy,
      verification: envelope.payload.verification,
      recoveryClearances: envelope.payload.recovery_clearances,
    };
    return {
      sessionBindingId: active.record.sessionBindingId,
      connectionId: active.record.connectionId,
      envelope,
      expected: {
        rsid: request.context.rsid,
        correlationId: request.context.invocationId,
        bindings: [binding],
        recoveryClearances: [],
      },
    };
  }

  public buildAtomicBatchEnvelope(request: GatewayAtomicBatchExecutorRequest): {
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: InvokeBatchEnvelope;
    readonly expected: GatewayExpectedMutationDispatch;
  } {
    const first = request.steps[0];
    if (first === undefined) {
      throw new GatewayRbpFault("protocol", "atomic batch has no steps", 409, 4400);
    }
    const active = this.#active.get(first.context.rsid);
    if (
      active === undefined ||
      active.tenantId !== first.context.actor.tenantId ||
      !this.#connections.has(active.record.connectionId) ||
      !active.record.sessionLifecycle.dispatchAllowed ||
      !active.record.grantedCapabilities.includes("batch_atomic") ||
      (active.record.connectionLifecycle.phase !== "steady" &&
        active.record.connectionLifecycle.phase !== "degraded")
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "registered rsid lacks an active atomic-batch grant",
        503,
        1011,
      );
    }
    if (
      request.steps.some(
        (step) =>
          step.context.rsid !== first.context.rsid ||
          step.context.actor.tenantId !== first.context.actor.tenantId ||
          makeParamsDigest(step.args as unknown as JsonValue) !==
            step.context.paramsDigest,
      )
    ) {
      throw new GatewayRbpFault(
        "protocol",
        "atomic batch steps are not bound to one authorized session",
        409,
        4400,
      );
    }
    const queued = queueOutboundData(active.record.sequence, {
      type: "invoke_batch",
      id: gatewayUuidV7(this.#clock()),
      ack: active.record.sequence.lastRxSeq,
      ts: nowIso(this.#clock()),
      payload: atomicBatchPayload(request) as JsonValue,
    });
    if (queued.kind !== "queued") {
      throw new GatewayRbpFault("protocol", "RBP sequence renewal required", 409, 4400);
    }
    const envelope = queued.envelope as InvokeBatchEnvelope;
    return {
      sessionBindingId: active.record.sessionBindingId,
      connectionId: active.record.connectionId,
      envelope,
      expected: {
        rsid: first.context.rsid,
        correlationId: request.batchId,
        bindings: request.steps.map((step, index) => ({
          rsid: step.context.rsid,
          invocationId: step.context.invocationId,
          method: step.executorMethod,
          mutating: step.context.mutating,
          mutationScope: step.context.mutationScope,
          paramsDigest: step.context.paramsDigest,
          policy: envelope.payload.steps[index]!.policy,
          verification: null,
          recoveryClearances: [],
          batchId: request.batchId,
          batchIndex: index,
          batchDigest: envelope.payload.batch_digest,
        })),
        recoveryClearances: [],
      },
    };
  }

  public async execute(
    request: GatewayExecutorRequest,
    prepared?: GatewayRecoveryPendingDispatch,
  ): Promise<GatewayExecutorOutcome> {
    const draft = prepared === undefined ? this.buildEnvelope(request) : null;
    return await this.#executeDispatch({
      tenantId: request.context.actor.tenantId,
      rsid: request.context.rsid,
      correlationId: request.context.invocationId,
      mutating: request.context.mutating,
      originRedelivery: prepared?.originRedelivery ?? false,
      envelope: prepared?.envelope ?? draft!.envelope,
      journalRecords: prepared?.journalRecords ?? [],
    });
  }

  public async executeAtomicBatch(
    request: GatewayAtomicBatchExecutorRequest,
    prepared: GatewayRecoveryPendingDispatch,
  ): Promise<GatewayExecutorOutcome> {
    const first = request.steps[0];
    if (first === undefined) {
      return {
        state: "failed",
        error: { code: "protocol", message: "atomic batch has no steps" },
      };
    }
    return await this.#executeDispatch({
      tenantId: first.context.actor.tenantId,
      rsid: first.context.rsid,
      correlationId: request.batchId,
      mutating: request.steps.some((step) => step.context.mutating),
      originRedelivery: prepared.originRedelivery,
      envelope: prepared.envelope,
      journalRecords: prepared.journalRecords,
    });
  }

  async #executeDispatch(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly correlationId: string;
    readonly mutating: boolean;
    readonly originRedelivery: boolean;
    readonly envelope: unknown;
    readonly journalRecords: readonly InvocationJournalRecord[];
  }): Promise<GatewayExecutorOutcome> {
    const started = await this.#withSessionAuthorization(input.rsid, async () =>
      this.#beginDispatch(input),
    );
    return await started.outcome;
  }

  async #beginDispatch(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly correlationId: string;
    readonly mutating: boolean;
    readonly originRedelivery: boolean;
    readonly envelope: unknown;
    readonly journalRecords: readonly InvocationJournalRecord[];
  }): Promise<{ readonly outcome: Promise<GatewayExecutorOutcome> }> {
    const active = this.#active.get(input.rsid);
    if (active === undefined || active.tenantId !== input.tenantId) {
      return { outcome: Promise.resolve({ state: "failed", error: { code: "executor_unavailable", message: "registered rsid is not active" } }) };
    }
    const connection = this.#connections.get(active.record.connectionId);
    if (connection === undefined) {
      return { outcome: Promise.resolve(this.#indeterminateOutcome(input.mutating)) };
    }
    const envelope = input.envelope as InvokeEnvelope | InvokeBatchEnvelope;
    const expectedDigest = immutableEnvelopeDigest(envelope);
    const journals = input.journalRecords.map(markJournalExecuting);
    const mutationEntries = pendingMutationEntries(envelope);
    if (input.mutating && mutationEntries.length === 0) {
      throw new GatewayRbpFault(
        "protocol",
        "mutating dispatch lacks an exact mutation scope",
        409,
        4400,
      );
    }
    const mutationScopes = [...new Map(
      mutationEntries.map((entry) => [
        mutationScopeKey(entry.mutationScope),
        entry.mutationScope,
      ]),
    ).values()];
    const ownHoldIds = new Set(
      normalizedHoldCandidates(input.rsid, mutationEntries).map(
        (candidate) => candidate.holdId,
      ),
    );
    const leaseId = gatewayUuidV7(this.#clock());
    let reservation: DurableEgressReservation | null = null;
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
        readonly lease: DurableEgressLease;
      } | null } = { current: null };
      const persisted = await this.store.transact({ tenantId: input.tenantId }, async (tx) => {
        const tombstone = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_UNREGISTER_NAMESPACE,
          input.rsid,
        );
        if (tombstone !== null) {
          parseUnregisterTombstone(tombstone.value, {
            tenantId: input.tenantId,
            rsid: input.rsid,
            stored: tombstone,
          });
          return { kind: "blocked" as const };
        }
        const stored = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_SESSION_NAMESPACE,
          input.rsid,
        );
        if (stored === null) return { kind: "blocked" as const };
        const record = parseStoredSession(stored, input.tenantId, input.rsid);
        const fence = sessionEgressFence(record);
        const nowMs = this.#clock();
        if (
          fence.state !== "open" ||
          fence.revocation !== null ||
          fence.lease?.phase === "started" ||
          (fence.lease?.phase === "reserved" &&
            fence.lease.reserveExpiresAtMs > nowMs) ||
          record.connectionId !== active.record.connectionId ||
          record.sessionBindingId !== active.record.sessionBindingId ||
          !record.sessionLifecycle.dispatchAllowed ||
          record.pending !== null
        ) {
          return { kind: "blocked" as const };
        }
        if (
          input.mutating &&
          !(await this.#assertMutationAdmission(
            tx,
            input.tenantId,
            input.rsid,
            record,
            mutationScopes,
            ownHoldIds,
            input.originRedelivery,
          ))
        ) {
          return { kind: "blocked" as const };
        }
        const queued = queueOutboundData(record.sequence, {
          type: envelope.type,
          id: envelope.id,
          ack: envelope.ack,
          ts: envelope.ts,
          payload: envelope.payload as JsonValue,
        });
        if (
          queued.kind !== "queued" ||
          immutableEnvelopeDigest(queued.envelope as RbpEnvelope) !== expectedDigest
        ) {
          throw new Error("prepared envelope does not match durable RBP sequence");
        }
        const lease: DurableEgressLease = {
          leaseId,
          ticket: fence.nextTicket,
          holderInstanceId: this.#instanceId,
          connectionId: record.connectionId,
          operation: "dispatch",
          envelopeDigest: expectedDigest,
          phase: "reserved",
          reservedAtMs: nowMs,
          reserveExpiresAtMs: nowMs + SEND_RESERVATION_TTL_MS,
          startedAtMs: null,
        };
        const next = nextSessionRecord(
          stored,
          record,
          {
            ...record,
            sequence: queued.state,
            pending: {
              envelopeDigest: expectedDigest,
              gatewaySequence: envelope.seq,
              invocationId: input.correlationId,
              mutating: input.mutating,
              mutationEntries,
              journalRecords: journals,
            },
            egressFence: {
              version: 1,
              state: "open",
              epoch: fence.epoch + 1,
              nextTicket: fence.nextTicket + 1,
              lease,
              revocation: null,
            },
          },
          nowMs,
        );
        attempted.current = { prior: stored, next, lease };
        tx.stage({
          namespace: GATEWAY_RBP_SESSION_NAMESPACE,
          key: input.rsid,
          value: asJson(next),
          expect: { kind: "version", version: stored.version },
        });
        return { kind: "reserved" as const, record: next, lease };
      });
      if (persisted.ok) {
        if (persisted.value.kind === "blocked") {
          return { outcome: Promise.resolve({ state: "failed", error: { code: "executor_unavailable", message: "registered rsid has unresolved durable authority" } }) };
        }
        reservation = {
          tenantId: input.tenantId,
          rsid: input.rsid,
          record: persisted.value.record,
          lease: persisted.value.lease,
        };
        break;
      }
      if (persisted.code === "conflict") continue;
      if (persisted.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(input.tenantId, input.rsid);
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          reservation = {
            tenantId: input.tenantId,
            rsid: input.rsid,
            record: parseStoredSession(readBack, input.tenantId, input.rsid),
            lease: evidence.lease,
          };
          break;
        }
        if (
          readBack !== null &&
          readBack.version === evidence.prior.version &&
          sameJson(readBack.value, evidence.prior.value)
        ) {
          continue;
        }
      }
      throw new GatewayRbpFault("unavailable", persisted.message, 503, 1011);
    }
    if (reservation === null) {
      throw new GatewayRbpFault(
        "unavailable",
        "dispatch authorization CAS retry bound was exhausted",
        503,
        1011,
      );
    }
    active.record = reservation.record;

    const outcome = new Promise<GatewayExecutorOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(input.correlationId);
        resolve(this.#indeterminateOutcome(input.mutating));
      }, INVOCATION_TIMEOUT_MS);
      timer.unref();
      this.#waiters.set(input.correlationId, {
        resolve,
        timer,
        mutating: input.mutating,
      });
    });
    try {
      await this.#sendWithDurableReservation(
        connection,
        reservation,
        JSON.stringify(envelope),
      );
    } catch {
      const waiter = this.#waiters.get(input.correlationId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(input.correlationId);
        waiter.resolve(this.#indeterminateOutcome(input.mutating));
      }
    }
    return { outcome };
  }

  async #promoteEgressReservation(
    reservation: DurableEgressReservation,
  ): Promise<DurableEgressReservation> {
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
        readonly lease: DurableEgressLease;
      } | null } = { current: null };
      const promoted = await this.store.transact(
        { tenantId: reservation.tenantId },
        async (tx) => {
          const tombstone = await tx.read<GatewayJsonValue>(
            GATEWAY_RBP_UNREGISTER_NAMESPACE,
            reservation.rsid,
          );
          if (tombstone !== null) {
            parseUnregisterTombstone(tombstone.value, {
              tenantId: reservation.tenantId,
              rsid: reservation.rsid,
              stored: tombstone,
            });
            return { kind: "blocked" as const };
          }
          const stored = await tx.read<GatewayJsonValue>(
            GATEWAY_RBP_SESSION_NAMESPACE,
            reservation.rsid,
          );
          if (stored === null) return { kind: "blocked" as const };
          const record = parseStoredSession(
            stored,
            reservation.tenantId,
            reservation.rsid,
          );
          const fence = sessionEgressFence(record);
          const lease = fence.lease;
          const nowMs = this.#clock();
          if (
            fence.state !== "open" ||
            fence.revocation !== null ||
            lease === null ||
            lease.phase !== "reserved" ||
            lease.reserveExpiresAtMs <= nowMs ||
            !sameJson(lease, reservation.lease)
          ) {
            return { kind: "blocked" as const };
          }
          const startedLease: DurableEgressLease = {
            ...lease,
            phase: "started",
            startedAtMs: nowMs,
          };
          const next = nextSessionRecord(
            stored,
            record,
            {
              ...record,
              egressFence: {
                ...fence,
                epoch: fence.epoch + 1,
                lease: startedLease,
              },
            },
            nowMs,
          );
          attempted.current = { prior: stored, next, lease: startedLease };
          tx.stage({
            namespace: GATEWAY_RBP_SESSION_NAMESPACE,
            key: reservation.rsid,
            value: asJson(next),
            expect: { kind: "version", version: stored.version },
          });
          return { kind: "started" as const, record: next, lease: startedLease };
        },
      );
      if (promoted.ok) {
        if (promoted.value.kind === "blocked") {
          throw new GatewayRbpFault(
            "unavailable",
            "egress reservation was revoked or superseded",
            503,
            1011,
          );
        }
        const result = {
          ...reservation,
          record: promoted.value.record,
          lease: promoted.value.lease,
        };
        this.#syncActiveRecord(result.record);
        return result;
      }
      if (promoted.code === "conflict") continue;
      if (promoted.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(
          reservation.tenantId,
          reservation.rsid,
        );
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          const result = {
            ...reservation,
            record: parseStoredSession(
              readBack,
              reservation.tenantId,
              reservation.rsid,
            ),
            lease: evidence.lease,
          };
          this.#syncActiveRecord(result.record);
          return result;
        }
        if (
          readBack !== null &&
          readBack.version === evidence.prior.version &&
          sameJson(readBack.value, evidence.prior.value)
        ) {
          continue;
        }
      }
      throw new GatewayRbpFault("unavailable", promoted.message, 503, 1011);
    }
    throw new GatewayRbpFault(
      "unavailable",
      "egress promotion CAS retry bound was exhausted",
      503,
      1011,
    );
  }

  async #releaseStartedEgressLease(
    reservation: DurableEgressReservation,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
      } | null } = { current: null };
      const released = await this.store.transact(
        { tenantId: reservation.tenantId },
        async (tx) => {
          const stored = await tx.read<GatewayJsonValue>(
            GATEWAY_RBP_SESSION_NAMESPACE,
            reservation.rsid,
          );
          if (stored === null) throw new Error("egress lease session is missing");
          const record = parseStoredSession(
            stored,
            reservation.tenantId,
            reservation.rsid,
          );
          const fence = sessionEgressFence(record);
          if (
            fence.lease === null ||
            fence.lease.phase !== "started" ||
            !sameJson(fence.lease, reservation.lease) ||
            fence.lease.holderInstanceId !== this.#instanceId
          ) {
            throw new Error("started egress lease ownership mismatch");
          }
          const next = nextSessionRecord(
            stored,
            record,
            {
              ...record,
              egressFence: {
                ...fence,
                epoch: fence.epoch + 1,
                lease: null,
              },
            },
            this.#clock(),
          );
          attempted.current = { prior: stored, next };
          tx.stage({
            namespace: GATEWAY_RBP_SESSION_NAMESPACE,
            key: reservation.rsid,
            value: asJson(next),
            expect: { kind: "version", version: stored.version },
          });
          return next;
        },
      );
      if (released.ok) {
        this.#syncActiveRecord(released.value);
        return;
      }
      if (released.code === "conflict") continue;
      if (released.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(
          reservation.tenantId,
          reservation.rsid,
        );
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          this.#syncActiveRecord(
            parseStoredSession(readBack, reservation.tenantId, reservation.rsid),
          );
          return;
        }
        // Never retry a release whose durability is uncertain. The exact
        // started lease remains blocking until its owner can prove release.
      }
      throw new GatewayRbpFault("unavailable", released.message, 503, 1011);
    }
    throw new GatewayRbpFault(
      "unavailable",
      "egress release CAS retry bound was exhausted",
      503,
      1011,
    );
  }

  async #sendWithDurableReservation(
    connection: LiveConnection,
    reservation: DurableEgressReservation,
    serialized: string,
  ): Promise<void> {
    const started = await this.#promoteEgressReservation(reservation);
    let sendFailure: unknown = null;
    let releaseFailure: unknown = null;
    try {
      // Do not insert an await between the successful durable promotion and
      // invoking the transport: the started lease is the cross-process proof
      // that any final tombstone must wait for this send call to begin.
      const sendOperation = connection.send(serialized);
      await sendOperation;
    } catch (error) {
      sendFailure = error;
    } finally {
      try {
        await this.#releaseStartedEgressLease(started);
      } catch (error) {
        releaseFailure = error;
      }
    }
    if (releaseFailure !== null) throw releaseFailure;
    if (sendFailure !== null) throw sendFailure;
  }

  async #reserveResumeAck(
    connection: LiveConnection,
    payload: {
      readonly rsid: string;
      readonly resume_token: string;
      readonly last_rx_seq: number;
    },
  ): Promise<ReservedResumeAck> {
    const tenantId = connection.auth.actor.tenantId;
    const leaseId = gatewayUuidV7(this.#clock());
    const messageId = gatewayUuidV7(this.#clock());
    const messageTimestamp = nowIso(this.#clock());
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
        readonly lease: DurableEgressLease;
        readonly serialized: string;
      } | null } = { current: null };
      const reserved = await this.store.transact({ tenantId }, async (tx) => {
        const tombstone = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_UNREGISTER_NAMESPACE,
          payload.rsid,
        );
        if (tombstone !== null) {
          parseUnregisterTombstone(tombstone.value, {
            tenantId,
            rsid: payload.rsid,
            stored: tombstone,
          });
          return { kind: "blocked" as const };
        }
        const stored = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_SESSION_NAMESPACE,
          payload.rsid,
        );
        if (stored === null) return { kind: "blocked" as const };
        const record = parseStoredSession(stored, tenantId, payload.rsid);
        const fence = sessionEgressFence(record);
        const nowMs = this.#clock();
        if (
          fence.state !== "open" ||
          fence.revocation !== null ||
          fence.lease?.phase === "started" ||
          (fence.lease?.phase === "reserved" &&
            fence.lease.reserveExpiresAtMs > nowMs) ||
          record.deviceId !== connection.auth.actor.deviceId ||
          record.userId !== connection.auth.actor.userId ||
          record.seatId !== connection.auth.actor.seatId ||
          record.resumeTokenDigest !== digest(payload.resume_token) ||
          record.resumeExpiresAtMs <= nowMs ||
          !record.sessionLifecycle.resumeAllowed
        ) {
          return { kind: "blocked" as const };
        }
        const acknowledged = applyCumulativeAck(record.sequence, payload.last_rx_seq);
        if (acknowledged.kind === "protocol_fault") {
          throw new Error(`resume cumulative ack rejected: ${acknowledged.reason}`);
        }
        let connectionLifecycle = connectionTransition(connection.lifecycle, {
          type: "begin_resume",
        });
        connectionLifecycle = connectionTransition(connectionLifecycle, {
          type: "resume_complete",
        });
        const disconnectedLifecycle =
          record.sessionLifecycle.phase === "disconnected"
            ? record.sessionLifecycle
            : sessionTransition(record.sessionLifecycle, { type: "connection_lost" });
        let sessionLifecycle = sessionTransition(disconnectedLifecycle, {
          type: "resume_requested",
        });
        sessionLifecycle = sessionTransition(sessionLifecycle, { type: "resumed" });
        const resumed: DurableRbpSession = {
          ...record,
          connectionId: connection.connectionId,
          binding: connection.binding,
          sessionVersion: record.sessionVersion + 1,
          sequence: acknowledged.state,
          liveDocumentRoute: null,
          connectionLifecycle,
          sessionLifecycle,
          lastHeartbeatAtMs: nowMs,
          updatedAtMs: nowMs,
        };
        const serialized = JSON.stringify({
          v: 1,
          type: "resume_ack",
          id: messageId,
          ts: messageTimestamp,
          payload: {
            rsid: resumed.rsid,
            last_rx_seq: resumed.sequence.lastRxSeq,
            resume_expires_at: nowIso(resumed.resumeExpiresAtMs),
          },
        } satisfies RbpEnvelope);
        const lease: DurableEgressLease = {
          leaseId,
          ticket: fence.nextTicket,
          holderInstanceId: this.#instanceId,
          connectionId: connection.connectionId,
          operation: "resume_ack",
          envelopeDigest: digest(serialized),
          phase: "reserved",
          reservedAtMs: nowMs,
          reserveExpiresAtMs: nowMs + SEND_RESERVATION_TTL_MS,
          startedAtMs: null,
        };
        const next = nextSessionRecord(
          stored,
          record,
          {
            ...resumed,
            egressFence: {
              version: 1,
              state: "open",
              epoch: fence.epoch + 1,
              nextTicket: fence.nextTicket + 1,
              lease,
              revocation: null,
            },
          },
          nowMs,
        );
        attempted.current = { prior: stored, next, lease, serialized };
        tx.stage({
          namespace: GATEWAY_RBP_SESSION_NAMESPACE,
          key: payload.rsid,
          value: asJson(next),
          expect: { kind: "version", version: stored.version },
        });
        return { kind: "reserved" as const, record: next, lease, serialized };
      });
      if (reserved.ok) {
        if (reserved.value.kind === "blocked") {
          throw new GatewayRbpFault(
            "auth",
            "resume authorization rejected",
            403,
            4403,
          );
        }
        return {
          tenantId,
          rsid: payload.rsid,
          record: reserved.value.record,
          lease: reserved.value.lease,
          serialized: reserved.value.serialized,
        };
      }
      if (reserved.code === "conflict") continue;
      if (reserved.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(tenantId, payload.rsid);
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          return {
            tenantId,
            rsid: payload.rsid,
            record: parseStoredSession(readBack, tenantId, payload.rsid),
            lease: evidence.lease,
            serialized: evidence.serialized,
          };
        }
        if (
          readBack !== null &&
          readBack.version === evidence.prior.version &&
          sameJson(readBack.value, evidence.prior.value)
        ) {
          continue;
        }
      }
      throw new GatewayRbpFault("unavailable", reserved.message, 503, 1011);
    }
    throw new GatewayRbpFault(
      "unavailable",
      "resume acknowledgement CAS retry bound was exhausted",
      503,
      1011,
    );
  }

  async #reserveResumeRetransmit(
    tenantId: string,
    rsid: string,
    connectionId: string,
    serialized: string,
  ): Promise<DurableEgressReservation> {
    const leaseId = gatewayUuidV7(this.#clock());
    const envelopeDigest = digest(serialized);
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
        readonly lease: DurableEgressLease;
      } | null } = { current: null };
      const reserved = await this.store.transact({ tenantId }, async (tx) => {
        const tombstone = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_UNREGISTER_NAMESPACE,
          rsid,
        );
        if (tombstone !== null) {
          parseUnregisterTombstone(tombstone.value, {
            tenantId,
            rsid,
            stored: tombstone,
          });
          return { kind: "blocked" as const };
        }
        const stored = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_SESSION_NAMESPACE,
          rsid,
        );
        if (stored === null) return { kind: "blocked" as const };
        const record = parseStoredSession(stored, tenantId, rsid);
        const fence = sessionEgressFence(record);
        const nowMs = this.#clock();
        if (
          fence.state !== "open" ||
          fence.revocation !== null ||
          fence.lease?.phase === "started" ||
          (fence.lease?.phase === "reserved" &&
            fence.lease.reserveExpiresAtMs > nowMs) ||
          record.connectionId !== connectionId ||
          !record.sessionLifecycle.dispatchAllowed
        ) {
          return { kind: "blocked" as const };
        }
        const lease: DurableEgressLease = {
          leaseId,
          ticket: fence.nextTicket,
          holderInstanceId: this.#instanceId,
          connectionId,
          operation: "resume_retransmit",
          envelopeDigest,
          phase: "reserved",
          reservedAtMs: nowMs,
          reserveExpiresAtMs: nowMs + SEND_RESERVATION_TTL_MS,
          startedAtMs: null,
        };
        const next = nextSessionRecord(
          stored,
          record,
          {
            ...record,
            egressFence: {
              version: 1,
              state: "open",
              epoch: fence.epoch + 1,
              nextTicket: fence.nextTicket + 1,
              lease,
              revocation: null,
            },
          },
          nowMs,
        );
        attempted.current = { prior: stored, next, lease };
        tx.stage({
          namespace: GATEWAY_RBP_SESSION_NAMESPACE,
          key: rsid,
          value: asJson(next),
          expect: { kind: "version", version: stored.version },
        });
        return { kind: "reserved" as const, record: next, lease };
      });
      if (reserved.ok) {
        if (reserved.value.kind === "blocked") {
          throw new GatewayRbpFault(
            "auth",
            "resume retransmit authorization rejected",
            403,
            4403,
          );
        }
        const result = {
          tenantId,
          rsid,
          record: reserved.value.record,
          lease: reserved.value.lease,
        };
        this.#syncActiveRecord(result.record);
        return result;
      }
      if (reserved.code === "conflict") continue;
      if (reserved.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(tenantId, rsid);
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          const result = {
            tenantId,
            rsid,
            record: parseStoredSession(readBack, tenantId, rsid),
            lease: evidence.lease,
          };
          this.#syncActiveRecord(result.record);
          return result;
        }
        if (
          readBack !== null &&
          readBack.version === evidence.prior.version &&
          sameJson(readBack.value, evidence.prior.value)
        ) {
          continue;
        }
      }
      throw new GatewayRbpFault("unavailable", reserved.message, 503, 1011);
    }
    throw new GatewayRbpFault(
      "unavailable",
      "resume retransmit CAS retry bound was exhausted",
      503,
      1011,
    );
  }

  public async inspectDispatch(
    tx: Pick<StoreTransaction, "read" | "list">,
    expected: GatewayExpectedDispatchBinding,
  ): Promise<GatewayBridgeEvidenceLookup> {
    const stored = await tx.read<GatewayJsonValue>(
      GATEWAY_RBP_SESSION_NAMESPACE,
      expected.rsid,
    );
    if (stored === null) return { kind: "not_durable_yet" };
    let session: DurableRbpSession;
    try {
      session = parseStoredSession(stored, stored.tenantId, expected.rsid);
    } catch {
      return { kind: "protocol_fault", reason: "session_record_invalid" };
    }
    if (session.sessionBindingId !== expected.sessionBindingId) {
      return { kind: "protocol_fault", reason: "session_binding_mismatch" };
    }
    const evidence = session.evidence.find(
      (candidate) => candidate.envelopeDigest === expected.envelopeDigest,
    );
    if (evidence === undefined) return { kind: "not_durable_yet" };
    if (
      evidence.acceptance?.gatewaySequence !== expected.gatewaySequence ||
      (evidence.journal !== null &&
        expected.invocationBindings.some((binding) =>
          !evidence.journal!.journalRecords.some(
            (record) =>
              record.bindingDigest === binding.bindingDigest &&
              `${record.binding.rsid}/${record.binding.invocationId}` ===
                binding.idempotencyKey,
          ),
        ))
    ) {
      return { kind: "protocol_fault", reason: "dispatch_evidence_mismatch" };
    }
    return {
      kind: "found",
      observation: {
        acceptance: evidence.acceptance,
        journal: evidence.journal,
      },
    };
  }

  public async authorizeDispatchTarget(
    tx: Pick<StoreTransaction, "read" | "list">,
    expected: GatewayExpectedDispatchTarget,
  ): Promise<GatewayBridgeResumeAuthorization> {
    return await this.#authorizeTarget(tx, expected);
  }

  public async authorizeResumeTarget(
    tx: Pick<StoreTransaction, "read" | "list">,
    expected: GatewayExpectedDispatchTarget,
  ): Promise<GatewayBridgeResumeAuthorization> {
    return await this.#authorizeTarget(tx, expected);
  }

  async #authorizeTarget(
    tx: Pick<StoreTransaction, "read" | "list">,
    expected: GatewayExpectedDispatchTarget,
  ): Promise<GatewayBridgeResumeAuthorization> {
    try {
      const tombstone = await tx.read<GatewayJsonValue>(
        GATEWAY_RBP_UNREGISTER_NAMESPACE,
        expected.rsid,
      );
      if (tombstone !== null) {
        parseUnregisterTombstone(tombstone.value, {
          tenantId: tombstone.tenantId,
          rsid: expected.rsid,
          stored: tombstone,
        });
        return { kind: "not_authorized", reason: "session_unregistered" };
      }
      const stored = await tx.read<GatewayJsonValue>(
        GATEWAY_RBP_SESSION_NAMESPACE,
        expected.rsid,
      );
      if (stored === null) return { kind: "not_authorized", reason: "unknown_rsid" };
      const session = parseStoredSession(stored, stored.tenantId, expected.rsid);
      const fence = sessionEgressFence(session);
      if (
        fence.state !== "open" ||
        !(await this.#assertMutationAdmission(
          tx,
          stored.tenantId,
          expected.rsid,
          session,
          [{ kind: "session" }],
          new Set<string>(),
          false,
        ))
      ) {
        return { kind: "not_authorized", reason: "mutation_hold" };
      }
      if (
        session.sessionBindingId !== expected.sessionBindingId ||
        session.connectionId !== expected.connectionId ||
        session.sequence.nextTxSeq !== expected.gatewaySequence ||
        !session.sessionLifecycle.dispatchAllowed
      ) {
        return { kind: "not_authorized", reason: "dispatch_target_mismatch" };
      }
      if (
        expected.requiredSessionCapabilities.some(
          (capability) => !session.grantedCapabilities.includes(capability),
        )
      ) {
        return { kind: "not_authorized", reason: "capability_not_granted" };
      }
      return { kind: "authorized", sessionVersion: session.sessionVersion };
    } catch (error) {
      return {
        kind: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #register(connection: LiveConnection, payload: SessionRegister): Promise<void> {
    const rsid = gatewayUuidV7(this.#clock());
    const resumeToken = token();
    const nowMs = this.#clock();
    const grantedCapabilities = connection.grantedCapabilities.filter((capability) =>
      payload.session_capabilities.includes(capability),
    );
    const record: DurableRbpSession = {
      schema: GATEWAY_RBP_SESSION_NAMESPACE,
      recordVersion: 1,
      createdAtMs: nowMs,
      tenantId: connection.auth.actor.tenantId,
      userId: connection.auth.actor.userId,
      deviceId: connection.auth.actor.deviceId,
      seatId: connection.auth.actor.seatId,
      rsid,
      sessionBindingId: gatewayUuidV7(this.#clock()),
      sessionVersion: 1,
      connectionId: connection.connectionId,
      binding: connection.binding,
      resumeTokenDigest: digest(resumeToken),
      resumeExpiresAtMs: nowMs + RESUME_LIFETIME_MS,
      grantedCapabilities,
      connectionLifecycle: connection.lifecycle,
      sessionLifecycle: registeredSessionLifecycle(payload.local_session_key, rsid),
      lastHeartbeatAtMs: nowMs,
      sequence: {
        rsid,
        nextTxSeq: 1,
        highestTxSeq: 0,
        lastRxSeq: 0,
        lastPeerAck: 0,
        outbox: [],
        acceptedInbound: [],
      },
      liveDocumentRoute: null,
      pending: null,
      evidence: [],
      egressFence: openEgressFence(),
      normalizedConflictIndex: emptyNormalizedConflictIndex(),
      updatedAtMs: nowMs,
    };
    const saved = await this.store.transact(
      { tenantId: record.tenantId },
      async (tx) => {
        tx.stage({
          namespace: GATEWAY_RBP_SESSION_NAMESPACE,
          key: rsid,
          value: asJson(record),
          expect: { kind: "absent" },
        });
        return record;
      },
    );
    if (!saved.ok) throw new GatewayRbpFault("unavailable", saved.message, 503, 1011);
    await this.#activate(record);
    await connection.send(
      JSON.stringify({
        v: 1,
        type: "session_registered",
        id: gatewayUuidV7(this.#clock()),
        ts: nowIso(this.#clock()),
        payload: {
          rsid,
          resume_token: resumeToken,
          resume_expires_at: nowIso(record.resumeExpiresAtMs),
          principal: {
            tenant_id: record.tenantId,
            user_id: record.userId,
          },
          seat: { granted: true, seat_id: record.seatId },
          granted_session_capabilities: grantedCapabilities,
        },
      } satisfies RbpEnvelope),
    );
  }

  async #resume(
    connection: LiveConnection,
    payload: { readonly rsid: string; readonly resume_token: string; readonly last_rx_seq: number },
  ): Promise<void> {
    await this.#withSessionAuthorization(payload.rsid, async () =>
      this.#resumeNow(connection, payload),
    );
  }

  async #resumeNow(
    connection: LiveConnection,
    payload: { readonly rsid: string; readonly resume_token: string; readonly last_rx_seq: number },
  ): Promise<void> {
    const reservedAck = await this.#reserveResumeAck(connection, payload);
    await this.#activate(reservedAck.record);
    try {
      await this.#sendWithDurableReservation(
        connection,
        reservedAck,
        reservedAck.serialized,
      );
    } catch (error) {
      if (
        this.#active.get(payload.rsid)?.record.connectionId ===
        connection.connectionId
      ) {
        this.#active.delete(payload.rsid);
      }
      throw error;
    }
    for (const retained of retransmitOutbox(reservedAck.record.sequence, {
      ack: reservedAck.record.sequence.lastRxSeq,
      ts: nowIso(this.#clock()),
    })) {
      const serialized = JSON.stringify(retained);
      const reservation = await this.#reserveResumeRetransmit(
        reservedAck.tenantId,
        reservedAck.rsid,
        connection.connectionId,
        serialized,
      );
      await this.#sendWithDurableReservation(
        connection,
        reservation,
        serialized,
      );
    }
  }

  async #unregister(
    connection: LiveConnection,
    payload: SessionUnregister,
  ): Promise<void> {
    await this.#withSessionAuthorization(payload.rsid, async () =>
      this.#unregisterNow(connection, payload),
    );
  }

  async #unregisterNow(
    connection: LiveConnection,
    payload: SessionUnregister,
  ): Promise<void> {
    const tenantId = connection.auth.actor.tenantId;
    const owner = {
      deviceId: connection.auth.actor.deviceId,
      userId: connection.auth.actor.userId,
      seatId: connection.auth.actor.seatId,
    };
    let phaseOne: PendingRevocationAuthority | null = null;
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
      } | null } = { current: null };
      const persisted = await this.store.transact({ tenantId }, async (tx) => {
        const existingTombstone = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_UNREGISTER_NAMESPACE,
          payload.rsid,
        );
        if (existingTombstone !== null) {
          const tombstone = parseUnregisterTombstone(existingTombstone.value, {
            tenantId,
            rsid: payload.rsid,
            stored: existingTombstone,
          });
          if (
            !sameTombstoneOwner(tombstone.owner, owner) ||
            tombstone.reason !== payload.reason
          ) {
            return { kind: "rejected" as const, reason: "unregister_owner_or_reason_mismatch" };
          }
          return { kind: "replay" as const, tombstone };
        }
        const stored = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_SESSION_NAMESPACE,
          payload.rsid,
        );
        if (stored === null) {
          return { kind: "rejected" as const, reason: "unknown_rsid" };
        }
        const record = parseStoredSession(stored, tenantId, payload.rsid);
        if (!sameTombstoneOwner(owner, record)) {
          return { kind: "rejected" as const, reason: "unregister_owner_mismatch" };
        }
        const fence = sessionEgressFence(record);
        if (fence.state === "revocation_pending") {
          if (
            fence.revocation === null ||
            !sameTombstoneOwner(fence.revocation.owner, owner) ||
            fence.revocation.reason !== payload.reason
          ) {
            return { kind: "rejected" as const, reason: "unregister_owner_or_reason_mismatch" };
          }
          const authority = await this.#assertPendingRevocationAuthority(
            tx,
            tenantId,
            payload.rsid,
            record,
            owner,
            payload.reason,
          );
          return { kind: "pending" as const, stored, record, ...authority };
        }
        if (
          !record.sessionLifecycle.dispatchAllowed &&
          !record.sessionLifecycle.resumeAllowed
        ) {
          return { kind: "rejected" as const, reason: "unregister_legacy_state_invalid" };
        }
        const nowMs = this.#clock();
        const candidates = normalizedHoldCandidates(
          record.rsid,
          durablePendingMutationEntries(record),
        );
        if (candidates.length > MAX_NORMALIZED_CONFLICT_INDEX_ENTRIES) {
          throw new Error("pending unregister exceeds the bounded hold set");
        }
        const scopeDigests: `sha256:${string}`[] = [];
        for (const candidate of candidates) {
          scopeDigests.push(await this.#ensureNormalizedConflictPair(
            tx,
            tenantId,
            record.rsid,
            candidate,
            nowMs,
          ));
        }
        const revocation: DurableEgressRevocation = {
          owner,
          reason: payload.reason,
          acceptedConnectionId: connection.connectionId,
          requestedAtMs: nowMs,
          drainDeadlineAtMs: nowMs + UNREGISTER_DRAIN_TIMEOUT_MS,
        };
        const sessionLifecycle = sessionTransition(record.sessionLifecycle, {
          type: "unregister",
          reason: payload.reason,
        });
        const next = nextSessionRecord(
          stored,
          record,
          {
            ...record,
            sessionVersion: record.sessionVersion + 1,
            resumeExpiresAtMs: nowMs,
            sessionLifecycle,
            egressFence: {
              version: 1,
              state: "revocation_pending",
              epoch: fence.epoch + 1,
              nextTicket: fence.nextTicket,
              lease: fence.lease?.phase === "started" ? fence.lease : null,
              revocation,
            },
            normalizedConflictIndex: extendConflictIndex(
              sessionConflictIndex(record),
              scopeDigests,
            ),
          },
          nowMs,
        );
        attempted.current = { prior: stored, next };
        tx.stage({
          namespace: GATEWAY_RBP_SESSION_NAMESPACE,
          key: payload.rsid,
          value: asJson(next),
          expect: { kind: "version", version: stored.version },
        });
        return {
          kind: "pending" as const,
          stored,
          record: next,
          revocation,
          candidates,
        };
      });
      if (persisted.ok) {
        if (persisted.value.kind === "rejected") {
          throw new GatewayRbpFault("auth", persisted.value.reason, 403, 4403);
        }
        if (persisted.value.kind === "replay") {
          const replay = await this.#verifyFinalTombstone(
            tenantId,
            payload.rsid,
            owner,
            payload.reason,
          );
          if (replay === null) {
            throw new GatewayRbpFault(
              "unavailable",
              "unregister replay lost its durable tombstone",
              503,
              1011,
            );
          }
          return;
        }
        phaseOne = await this.#verifyPendingRevocation(
          tenantId,
          payload.rsid,
          owner,
          payload.reason,
        );
        break;
      }
      if (persisted.code === "conflict") continue;
      if (persisted.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(tenantId, payload.rsid);
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          phaseOne = await this.#verifyPendingRevocation(
            tenantId,
            payload.rsid,
            owner,
            payload.reason,
          );
          break;
        }
        if (
          readBack !== null &&
          readBack.version === evidence.prior.version &&
          sameJson(readBack.value, evidence.prior.value)
        ) {
          continue;
        }
        const finalized = await this.#verifyFinalTombstone(
          tenantId,
          payload.rsid,
          owner,
          payload.reason,
        );
        if (finalized !== null) return;
      }
      throw new GatewayRbpFault("unavailable", persisted.message, 503, 1011);
    }
    if (phaseOne === null) {
      throw new GatewayRbpFault(
        "unavailable",
        "unregister revocation CAS retry bound was exhausted",
        503,
        1011,
      );
    }

    this.#active.delete(payload.rsid);
    const pendingAtRevocation = phaseOne.record.pending;
    if (pendingAtRevocation !== null) {
      const waiter = this.#waiters.get(pendingAtRevocation.invocationId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(pendingAtRevocation.invocationId);
        waiter.resolve(this.#indeterminateOutcome(pendingAtRevocation.mutating));
      }
    }

    while (sessionEgressFence(phaseOne.record).lease !== null) {
      const revocation = sessionEgressFence(phaseOne.record).revocation!;
      const nowMs = this.#clock();
      if (nowMs >= revocation.drainDeadlineAtMs) {
        throw new GatewayRbpFault(
          "unavailable",
          "unregister drain timed out with a started egress lease",
          503,
          1011,
        );
      }
      await this.#wait(Math.max(
        1,
        Math.min(25, revocation.drainDeadlineAtMs - nowMs),
      ));
      phaseOne = await this.#verifyPendingRevocation(
        tenantId,
        payload.rsid,
        owner,
        payload.reason,
      );
    }

    let decision: DurableUnregisterWrite | null = null;
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
        readonly tombstone: DurableUnregisterTombstone;
        readonly pendingOutcome: GatewayExecutorOutcome | null;
        readonly pendingCorrelationId: string | null;
      } | null } = { current: null };
      const finalized = await this.store.transact({ tenantId }, async (tx) => {
        const existingTombstone = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_UNREGISTER_NAMESPACE,
          payload.rsid,
        );
        if (existingTombstone !== null) {
          const tombstone = parseUnregisterTombstone(existingTombstone.value, {
            tenantId,
            rsid: payload.rsid,
            stored: existingTombstone,
          });
          if (
            !sameTombstoneOwner(tombstone.owner, owner) ||
            tombstone.reason !== payload.reason
          ) {
            return { kind: "rejected" as const, reason: "unregister_owner_or_reason_mismatch" };
          }
          return { kind: "replay" as const, tombstone };
        }
        const stored = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_SESSION_NAMESPACE,
          payload.rsid,
        );
        if (stored === null) {
          return { kind: "rejected" as const, reason: "unknown_rsid" };
        }
        const record = parseStoredSession(stored, tenantId, payload.rsid);
        const authority = await this.#assertPendingRevocationAuthority(
          tx,
          tenantId,
          payload.rsid,
          record,
          owner,
          payload.reason,
        );
        const fence = sessionEgressFence(record);
        if (fence.lease !== null) {
          return { kind: "not_drained" as const };
        }
        const pending = record.pending;
        const holdIds = authority.candidates.map((candidate) => candidate.holdId).sort();
        const journals = pending?.journalRecords.map((journal) => {
          const nonExecutionProven =
            journal.state === "received" && !journal.dispatchMayHaveStarted;
          const holdId = journal.binding.mutating && !nonExecutionProven
            ? authority.candidates.find((candidate) =>
                candidate.mutationScopeJcs ===
                mutationScopeKey(journal.binding.mutationScope!),
              )?.holdId ?? null
            : null;
          return handleJournalSessionUnregister(
            journal,
            nonExecutionProven,
            holdId,
          ).record;
        }) ?? [];
        const pendingDisposition: DurableUnregisterTombstone["pendingDisposition"] =
          holdIds.length > 0 && pending !== null
            ? "mutation_indeterminate"
            : pending === null ? "none" : "read_closed";
        const journalKind: GatewayVerifiedBridgeJournalEvidence["kind"] =
          holdIds.length > 0 ? "indeterminate" : "known_terminal";
        const nowMs = this.#clock();
        const tombstone: DurableUnregisterTombstone = {
          schema: GATEWAY_RBP_UNREGISTER_NAMESPACE,
          recordVersion: 1,
          tenantId,
          createdAtMs: authority.revocation.requestedAtMs,
          updatedAtMs: nowMs,
          rsid: payload.rsid,
          sessionBindingId: record.sessionBindingId,
          owner,
          reason: payload.reason,
          revokedAtMs: authority.revocation.requestedAtMs,
          acceptedConnectionId: authority.revocation.acceptedConnectionId,
          pendingDisposition,
          holdIds,
          cleanupState: "retained",
        };
        const evidence: readonly DurableDispatchEvidence[] =
          pending === null || journals.length === 0
            ? record.evidence
            : [
                ...record.evidence.filter(
                  (candidate) => candidate.envelopeDigest !== pending.envelopeDigest,
                ),
                {
                  envelopeDigest: pending.envelopeDigest,
                  acceptance:
                    record.evidence.find(
                      (candidate) =>
                        candidate.envelopeDigest === pending.envelopeDigest,
                    )?.acceptance ?? null,
                  journal: {
                    kind: journalKind,
                    rsid: record.rsid,
                    sessionBindingId: record.sessionBindingId,
                    envelopeDigest: pending.envelopeDigest,
                    journalRecords: journals,
                    batchTerminal: null,
                    durableJournalVersion: record.sessionVersion,
                    recordedAtMs: nowMs,
                  },
                },
              ];
        const next = nextSessionRecord(
          stored,
          record,
          {
            ...record,
            pending: null,
            evidence,
          },
          nowMs,
        );
        const pendingOutcome = pending === null
          ? null
          : this.#indeterminateOutcome(pending.mutating);
        const pendingCorrelationId = pending?.invocationId ?? null;
        attempted.current = {
          prior: stored,
          next,
          tombstone,
          pendingOutcome,
          pendingCorrelationId,
        };
        tx.stage({
          namespace: GATEWAY_RBP_UNREGISTER_NAMESPACE,
          key: payload.rsid,
          value: asJson(tombstone),
          expect: { kind: "absent" },
        });
        tx.stage({
          namespace: GATEWAY_RBP_SESSION_NAMESPACE,
          key: payload.rsid,
          value: asJson(next),
          expect: { kind: "version", version: stored.version },
        });
        return {
          kind: "created" as const,
          tombstone,
          pendingOutcome,
          pendingCorrelationId,
        };
      });
      if (finalized.ok) {
        if (finalized.value.kind === "rejected") {
          throw new GatewayRbpFault("auth", finalized.value.reason, 403, 4403);
        }
        if (finalized.value.kind === "not_drained") {
          throw new GatewayRbpFault(
            "unavailable",
            "unregister finalization observed a started egress lease",
            503,
            1011,
          );
        }
        decision = finalized.value;
        break;
      }
      if (finalized.code === "conflict") continue;
      if (finalized.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const observed = await this.#verifyFinalTombstone(
          tenantId,
          payload.rsid,
          owner,
          payload.reason,
        );
        if (observed !== null) {
          decision = {
            kind: "created",
            tombstone: observed,
            pendingOutcome: evidence.pendingOutcome,
            pendingCorrelationId: evidence.pendingCorrelationId,
          };
          break;
        }
        const readBack = await this.#readStoredSession(tenantId, payload.rsid);
        if (
          readBack !== null &&
          readBack.version === evidence.prior.version &&
          sameJson(readBack.value, evidence.prior.value)
        ) {
          continue;
        }
      }
      throw new GatewayRbpFault("unavailable", finalized.message, 503, 1011);
    }
    if (decision === null) {
      throw new GatewayRbpFault(
        "unavailable",
        "unregister finalization CAS retry bound was exhausted",
        503,
        1011,
      );
    }
    const readBack = await this.#verifyFinalTombstone(
      tenantId,
      payload.rsid,
      owner,
      payload.reason,
    );
    if (readBack === null) {
      throw new GatewayRbpFault(
        "unavailable",
        "unregister tombstone was not durably readable",
        503,
        1011,
      );
    }
  }

  async #heartbeat(
    connection: LiveConnection,
    acks: readonly { readonly rsid: string; readonly seq: number }[],
  ): Promise<void> {
    const returned: { rsid: string; seq: number }[] = [];
    for (const ack of acks) {
      const active = this.#active.get(ack.rsid);
      if (active === undefined || active.record.connectionId !== connection.connectionId) {
        throw new GatewayRbpFault("auth", "heartbeat references an unbound rsid", 403, 4403);
      }
      const updated = await this.#updateSession(active.tenantId, ack.rsid, (record) => {
        if (sessionEgressFence(record).state !== "open") {
          throw new Error("heartbeat session is durably revoked");
        }
        const acknowledged = applyCumulativeAck(record.sequence, ack.seq);
        if (acknowledged.kind === "protocol_fault") {
          throw new Error(
            `heartbeat cumulative ack rejected: ${acknowledged.reason}`,
          );
        }
        return {
          ...record,
          sequence: acknowledged.state,
          connectionLifecycle: connectionTransition(record.connectionLifecycle, {
            type: "heartbeat_silence",
            silenceMs: 0,
          }),
          lastHeartbeatAtMs: this.#clock(),
          updatedAtMs: this.#clock(),
        };
      });
      active.record = updated;
      returned.push({ rsid: ack.rsid, seq: updated.sequence.lastRxSeq });
    }
    await connection.send(
      JSON.stringify({
        v: 1,
        type: "heartbeat_ack",
        id: gatewayUuidV7(this.#clock()),
        ts: nowIso(this.#clock()),
        payload: { server_time: nowIso(this.#clock()), acks: returned },
      } satisfies RbpEnvelope),
    );
  }

  async #acceptData(
    connection: LiveConnection,
    envelope: Extract<RbpEnvelope, { rsid: string }>,
  ): Promise<void> {
    const active = this.#active.get(envelope.rsid);
    if (
      active === undefined ||
      active.record.connectionId !== connection.connectionId ||
      active.tenantId !== connection.auth.actor.tenantId
    ) {
      throw new GatewayRbpFault("auth", "rsid is not bound to this connection", 403, 4403);
    }
    const nextLiveDocumentRoute =
      envelope.type === "doc_context_update"
        ? liveDocumentRouteFrom(
            envelope.payload,
            connection.connectionId,
            envelope.seq,
          )
        : undefined;
    let completed: GatewayExecutorOutcome | null = null;
    let completedInvocationId: string | null = null;
    const updated = await this.#updateSession(active.tenantId, active.rsid, (record) => {
      if (sessionEgressFence(record).state !== "open") {
        throw new Error("inbound data session is durably revoked");
      }
      const accepted = acceptInboundData(
        record.sequence,
        envelope as DataEnvelopeSnapshot,
      );
      if (accepted.kind === "protocol_fault") {
        throw new Error(`inbound sequence rejected: ${accepted.reason}`);
      }
      if (accepted.kind === "gap") {
        throw new Error(
          `forward sequence gap: expected ${accepted.expectedSeq}, received ${accepted.receivedSeq}`,
        );
      }
      if (accepted.kind === "duplicate") {
        return { ...record, sequence: accepted.state, updatedAtMs: this.#clock() };
      }
      let pending = record.pending;
      let evidence = [...record.evidence];
      if (pending !== null && envelope.ack !== undefined && envelope.ack >= pending.gatewaySequence) {
        const existing = evidence.find(
          (candidate) => candidate.envelopeDigest === pending!.envelopeDigest,
        );
        const acceptance = {
          source: "durable_rbp_sequence" as const,
          rsid: record.rsid,
          sessionBindingId: record.sessionBindingId,
          acceptedConnectionId: record.connectionId,
          authorizedSessionVersion: record.sessionVersion,
          gatewaySequence: pending.gatewaySequence,
          cumulativeAck: envelope.ack,
          envelopeDigest: pending.envelopeDigest,
          durableSequenceVersion: record.sessionVersion,
          acceptedAtMs: this.#clock(),
        };
        const next: DurableDispatchEvidence = {
          envelopeDigest: pending.envelopeDigest,
          acceptance,
          journal: existing?.journal ?? null,
        };
        evidence = [
          ...evidence.filter(
            (candidate) => candidate.envelopeDigest !== pending!.envelopeDigest,
          ),
          next,
        ];
      }
      if (pending !== null && (envelope.type === "result" || envelope.type === "error")) {
        const correlationId =
          envelope.type === "result" && envelope.payload.kind === "invocation"
            ? envelope.payload.invocation_id
            : envelope.type === "result" && envelope.payload.kind === "batch"
              ? envelope.payload.batch_id
            : envelope.type === "error"
              ? envelope.payload.invocation_id ?? null
              : null;
        if (correlationId !== pending.invocationId) {
          throw new Error("terminal envelope does not match the active invocation");
        }
        const journals = terminalJournalRecords(pending.journalRecords, envelope);
        const existing = evidence.find(
          (candidate) => candidate.envelopeDigest === pending!.envelopeDigest,
        );
        const batchTerminal =
          envelope.type === "result" && envelope.payload.kind === "batch"
            ? {
                result: structuredClone(envelope.payload) as BatchResult,
                resultDigest: makeParamsDigest(
                  envelope.payload as unknown as JsonValue,
                ),
              }
            : null;
        const journal: GatewayVerifiedBridgeJournalEvidence | null =
          journals.length === 0
            ? null
            : {
                kind: "known_terminal",
                rsid: record.rsid,
                sessionBindingId: record.sessionBindingId,
                envelopeDigest: pending.envelopeDigest,
                journalRecords: journals,
                batchTerminal,
                durableJournalVersion: record.sessionVersion,
                recordedAtMs: this.#clock(),
              };
        evidence = [
          ...evidence.filter(
            (candidate) => candidate.envelopeDigest !== pending!.envelopeDigest,
          ),
          {
            envelopeDigest: pending.envelopeDigest,
            acceptance: existing?.acceptance ?? null,
            journal,
          },
        ];
        completed = terminalOutcome(envelope);
        completedInvocationId = pending.invocationId;
        pending = null;
      }
      return {
        ...record,
        sequence: accepted.state,
        liveDocumentRoute:
          envelope.type === "doc_context_update"
            ? nextLiveDocumentRoute!
            : record.liveDocumentRoute ?? null,
        pending,
        evidence,
        updatedAtMs: this.#clock(),
      };
    });
    active.record = updated;
    if (completedInvocationId !== null && completed !== null) {
      const waiter = this.#waiters.get(completedInvocationId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(completedInvocationId);
        waiter.resolve(completed);
      }
    }
  }

  async #activate(record: DurableRbpSession): Promise<void> {
    const prior = this.#active.get(record.rsid);
    if (
      prior !== undefined &&
      prior.record.connectionId !== record.connectionId
    ) {
      const connection = this.#connections.get(prior.record.connectionId);
      await connection?.close(4001, "session replaced");
    }
    this.#active.set(record.rsid, {
      tenantId: record.tenantId,
      rsid: record.rsid,
      record,
    });
  }

  async #markConnectionLost(active: ActiveSession): Promise<void> {
    if (active.record.sessionLifecycle.phase !== "registered") return;
    const durable = await this.#readSession(active.tenantId, active.rsid);
    if (
      sessionEgressFence(durable).state !== "open" ||
      durable.connectionId !== active.record.connectionId
    ) {
      active.record = durable;
      return;
    }
    const updated = await this.#updateSession(active.tenantId, active.rsid, (record) => {
      if (
        sessionEgressFence(record).state !== "open" ||
        record.connectionId !== active.record.connectionId
      ) {
        return record;
      }
      return {
        ...record,
        connectionLifecycle:
          record.connectionLifecycle.phase === "steady" ||
          record.connectionLifecycle.phase === "degraded"
            ? connectionTransition(record.connectionLifecycle, {
                type: "connection_failed",
                failure: "environment",
              })
            : record.connectionLifecycle,
        sessionLifecycle: sessionTransition(record.sessionLifecycle, {
          type: "connection_lost",
        }),
        updatedAtMs: this.#clock(),
      };
    });
    active.record = updated;
  }

  async #readStoredSession(
    tenantId: string,
    rsid: string,
  ): Promise<StoredRecord<GatewayJsonValue> | null> {
    const result = await this.store.transact({ tenantId }, async (tx) =>
      tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid),
    );
    if (!result.ok) {
      throw new GatewayRbpFault("unavailable", result.message, 503, 1011);
    }
    if (result.value !== null) {
      try {
        parseStoredSession(result.value, tenantId, rsid);
      } catch (error) {
        throw new GatewayRbpFault(
          "unavailable",
          error instanceof Error ? error.message : String(error),
          503,
          1011,
        );
      }
    }
    return result.value;
  }

  async #readConflictPairByDigest(
    tx: Pick<StoreTransaction, "read">,
    tenantId: string,
    rsid: string,
    scopeDigest: `sha256:${string}`,
  ): Promise<{
    readonly hold: DurableMutationHold;
    readonly conflict: DurableMutationConflict;
    readonly scope: MutationScope;
  } | null> {
    const key = conflictRecordKey(rsid, scopeDigest);
    const conflictStored = await tx.read<GatewayJsonValue>(
      GATEWAY_MUTATION_CONFLICT_NAMESPACE,
      key,
    );
    if (conflictStored === null) return null;
    const parsedConflict = parseMutationConflict(conflictStored, tenantId, rsid);
    const holdStored = await tx.read<GatewayJsonValue>(
      GATEWAY_MUTATION_HOLD_NAMESPACE,
      parsedConflict.conflict.holdId,
    );
    if (holdStored === null) {
      throw new Error("normalized conflict references a missing hold");
    }
    const parsedHold = parseMutationHold(holdStored, tenantId, rsid);
    if (
      parsedConflict.conflict.scopeDigest !== scopeDigest ||
      parsedConflict.conflict.holdId !== parsedHold.hold.holdId ||
      parsedConflict.conflict.mutationScopeJcs !==
        parsedHold.hold.mutationScopeJcs ||
      mutationScopeKey(parsedConflict.scope) !==
        mutationScopeKey(parsedHold.scope) ||
      parsedConflict.conflict.active !==
        (parsedHold.hold.state !== "cleared")
    ) {
      throw new Error("normalized hold and conflict disagree");
    }
    return {
      hold: parsedHold.hold,
      conflict: parsedConflict.conflict,
      scope: parsedHold.scope,
    };
  }

  async #readConflictPairByHoldId(
    tx: Pick<StoreTransaction, "read">,
    tenantId: string,
    rsid: string,
    holdId: `vh:${string}`,
  ): Promise<{
    readonly hold: DurableMutationHold;
    readonly conflict: DurableMutationConflict;
    readonly scope: MutationScope;
    readonly scopeDigest: `sha256:${string}`;
  }> {
    const holdStored = await tx.read<GatewayJsonValue>(
      GATEWAY_MUTATION_HOLD_NAMESPACE,
      holdId,
    );
    if (holdStored === null) {
      throw new Error("unregister tombstone references a missing hold");
    }
    const parsedHold = parseMutationHold(holdStored, tenantId, rsid);
    const scopeDigest = conflictScopeDigest(parsedHold.hold.mutationScopeJcs);
    const pair = await this.#readConflictPairByDigest(
      tx,
      tenantId,
      rsid,
      scopeDigest,
    );
    if (pair === null || pair.hold.holdId !== holdId) {
      throw new Error("unregister tombstone hold has no exact conflict");
    }
    return { ...pair, scopeDigest };
  }

  async #ensureNormalizedConflictPair(
    tx: Pick<StoreTransaction, "read" | "stage">,
    tenantId: string,
    rsid: string,
    candidate: NormalizedHoldCandidate,
    nowMs: number,
  ): Promise<`sha256:${string}`> {
    const scopeDigest = conflictScopeDigest(candidate.mutationScopeJcs);
    const key = conflictRecordKey(rsid, scopeDigest);
    const conflictStored = await tx.read<GatewayJsonValue>(
      GATEWAY_MUTATION_CONFLICT_NAMESPACE,
      key,
    );
    if (conflictStored !== null) {
      const pair = await this.#readConflictPairByDigest(
        tx,
        tenantId,
        rsid,
        scopeDigest,
      );
      if (
        pair === null ||
        pair.conflict.active !== true ||
        pair.hold.state === "cleared" ||
        pair.hold.holdId !== candidate.holdId ||
        pair.hold.mutationScopeJcs !== candidate.mutationScopeJcs ||
        !sameJson(
          pair.hold.originIdempotencyKeys,
          candidate.originIdempotencyKeys,
        )
      ) {
        throw new Error("existing normalized conflict does not match pending mutation");
      }
      return scopeDigest;
    }
    const holdStored = await tx.read<GatewayJsonValue>(
      GATEWAY_MUTATION_HOLD_NAMESPACE,
      candidate.holdId,
    );
    if (holdStored !== null) {
      // A hold without its exact conflict pair is a partial durable write, not
      // an authority that WP-02 may silently repair or overwrite.
      parseMutationHold(holdStored, tenantId, rsid);
      throw new Error("normalized mutation hold is missing its conflict pair");
    }
    const hold: DurableMutationHold = {
      schema: GATEWAY_MUTATION_HOLD_NAMESPACE,
      tenantId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      recordVersion: 1,
      holdId: candidate.holdId,
      rsid,
      mutationScopeJcs: candidate.mutationScopeJcs,
      originIdempotencyKeys: candidate.originIdempotencyKeys,
      state: "active",
      evidenceIds: [],
      evidenceDigests: [],
      resolutionIds: [],
    };
    const conflict: DurableMutationConflict = {
      schema: GATEWAY_MUTATION_CONFLICT_NAMESPACE,
      tenantId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      recordVersion: 1,
      rsid,
      scopeDigest,
      holdId: candidate.holdId,
      mutationScopeJcs: candidate.mutationScopeJcs,
      active: true,
    };
    tx.stage({
      namespace: GATEWAY_MUTATION_HOLD_NAMESPACE,
      key: hold.holdId,
      value: asJson(hold),
      expect: { kind: "absent" },
    });
    tx.stage({
      namespace: GATEWAY_MUTATION_CONFLICT_NAMESPACE,
      key,
      value: asJson(conflict),
      expect: { kind: "absent" },
    });
    return scopeDigest;
  }

  async #assertMutationAdmission(
    tx: Pick<StoreTransaction, "read">,
    tenantId: string,
    rsid: string,
    record: DurableRbpSession,
    scopes: readonly MutationScope[],
    ownHoldIds: ReadonlySet<string>,
    originRedelivery: boolean,
  ): Promise<boolean> {
    if (scopes.length === 0) return true;
    const index = sessionConflictIndex(record);
    const markerStored = await tx.read<GatewayJsonValue>(
      GATEWAY_HOLD_CUTOVER_NAMESPACE,
      rsid,
    );
    const cutover = markerStored === null
      ? null
      : parseHoldCutover(markerStored, tenantId, rsid);
    if (cutover !== null && record.normalizedConflictIndex === undefined) {
      throw new Error("cutover marker lacks a normalized conflict index");
    }

    const sessionScoped = scopes.some((scope) => scope.kind === "session");
    if (sessionScoped && index.state === "overflow") return false;
    const requestedDigests = sessionScoped
      ? [...index.scopeDigests]
      : [...new Set([
          conflictScopeDigest(mutationScopeKey({ kind: "session" })),
          ...scopes.map((scope) => conflictScopeDigest(mutationScopeKey(scope))),
        ])].sort();
    for (const scopeDigest of requestedDigests) {
      const pair = await this.#readConflictPairByDigest(
        tx,
        tenantId,
        rsid,
        scopeDigest,
      );
      const indexed = index.scopeDigests.includes(scopeDigest);
      if (pair === null) {
        if (indexed) {
          throw new Error("normalized conflict index references a missing pair");
        }
        continue;
      }
      if (index.state === "complete" && !indexed) {
        throw new Error("normalized active conflict is absent from its index");
      }
      if (indexed && pair.conflict.active !== true) {
        throw new Error("normalized conflict index references a cleared pair");
      }
      if (
        pair.conflict.active &&
        !(originRedelivery && ownHoldIds.has(pair.hold.holdId))
      ) {
        return false;
      }
    }

    if (cutover !== null) return true;
    const recovery = await tx.read<GatewayJsonValue>(
      GATEWAY_RECOVERY_NAMESPACE,
      rsid,
    );
    if (recovery === null) return true;
    if (
      recovery.namespace !== GATEWAY_RECOVERY_NAMESPACE ||
      recovery.tenantId !== tenantId ||
      recovery.key !== rsid
    ) {
      throw new Error("legacy recovery authority key or tenant mismatch");
    }
    const legacyHolds = parseLegacyRecoveryHolds(recovery.value, rsid);
    return !legacyHolds.some((hold) =>
      hold.state !== "cleared" &&
      scopes.some((scope) => mutationScopesConflict(hold.mutationScope, scope)) &&
      !(originRedelivery && ownHoldIds.has(hold.holdId)),
    );
  }

  async #assertPendingRevocationAuthority(
    tx: Pick<StoreTransaction, "read">,
    tenantId: string,
    rsid: string,
    record: DurableRbpSession,
    owner: DurableEgressRevocation["owner"],
    reason: SessionUnregister["reason"],
  ): Promise<{
    readonly revocation: DurableEgressRevocation;
    readonly candidates: readonly NormalizedHoldCandidate[];
  }> {
    const fence = sessionEgressFence(record);
    const revocation = fence.revocation;
    if (
      fence.state !== "revocation_pending" ||
      revocation === null ||
      !sameTombstoneOwner(revocation.owner, owner) ||
      revocation.reason !== reason ||
      fence.lease?.phase === "reserved" ||
      record.sessionLifecycle.dispatchAllowed ||
      record.sessionLifecycle.resumeAllowed
    ) {
      throw new Error("pending unregister authority is inconsistent");
    }
    const candidates = normalizedHoldCandidates(
      rsid,
      durablePendingMutationEntries(record),
    );
    if (candidates.length > MAX_NORMALIZED_CONFLICT_INDEX_ENTRIES) {
      throw new Error("pending unregister exceeds the bounded hold set");
    }
    const index = sessionConflictIndex(record);
    for (const scopeDigest of index.scopeDigests) {
      const pair = await this.#readConflictPairByDigest(
        tx,
        tenantId,
        rsid,
        scopeDigest,
      );
      if (pair === null || pair.conflict.active !== true) {
        throw new Error("normalized conflict index is incomplete or stale");
      }
    }
    for (const candidate of candidates) {
      const pair = await this.#readConflictPairByHoldId(
        tx,
        tenantId,
        rsid,
        candidate.holdId,
      );
      if (
        pair.conflict.active !== true ||
        pair.hold.mutationScopeJcs !== candidate.mutationScopeJcs ||
        !sameJson(
          pair.hold.originIdempotencyKeys,
          candidate.originIdempotencyKeys,
        ) ||
        (index.state === "complete" &&
          !index.scopeDigests.includes(pair.scopeDigest))
      ) {
        throw new Error("pending unregister hold authority is inconsistent");
      }
    }
    return { revocation, candidates };
  }

  async #verifyPendingRevocation(
    tenantId: string,
    rsid: string,
    owner: DurableEgressRevocation["owner"],
    reason: SessionUnregister["reason"],
  ): Promise<PendingRevocationAuthority> {
    const verified = await this.store.transact({ tenantId }, async (tx) => {
      const stored = await tx.read<GatewayJsonValue>(
        GATEWAY_RBP_SESSION_NAMESPACE,
        rsid,
      );
      if (stored === null) throw new Error("pending unregister session is missing");
      const record = parseStoredSession(stored, tenantId, rsid);
      const authority = await this.#assertPendingRevocationAuthority(
        tx,
        tenantId,
        rsid,
        record,
        owner,
        reason,
      );
      return { stored, record, ...authority };
    });
    if (!verified.ok) {
      throw new GatewayRbpFault("unavailable", verified.message, 503, 1011);
    }
    return verified.value;
  }

  async #verifyFinalTombstone(
    tenantId: string,
    rsid: string,
    owner: DurableEgressRevocation["owner"],
    reason: SessionUnregister["reason"],
  ): Promise<DurableUnregisterTombstone | null> {
    const verified = await this.store.transact({ tenantId }, async (tx) => {
      const tombstoneStored = await tx.read<GatewayJsonValue>(
        GATEWAY_RBP_UNREGISTER_NAMESPACE,
        rsid,
      );
      if (tombstoneStored === null) return null;
      const tombstone = parseUnregisterTombstone(tombstoneStored.value, {
        tenantId,
        rsid,
        stored: tombstoneStored,
      });
      if (
        !sameTombstoneOwner(tombstone.owner, owner) ||
        tombstone.reason !== reason
      ) {
        throw new Error("unregister tombstone owner or reason mismatch");
      }
      const sessionStored = await tx.read<GatewayJsonValue>(
        GATEWAY_RBP_SESSION_NAMESPACE,
        rsid,
      );
      if (sessionStored === null) {
        throw new Error("unregister tombstone session is missing");
      }
      const session = parseStoredSession(sessionStored, tenantId, rsid);
      const fence = sessionEgressFence(session);
      if (
        fence.state !== "revocation_pending" ||
        fence.revocation === null ||
        fence.lease !== null ||
        !sameTombstoneOwner(fence.revocation.owner, owner) ||
        fence.revocation.reason !== reason ||
        session.pending !== null ||
        session.sessionLifecycle.dispatchAllowed ||
        session.sessionLifecycle.resumeAllowed
      ) {
        throw new Error("final unregister session authority is inconsistent");
      }
      const index = sessionConflictIndex(session);
      for (const holdId of tombstone.holdIds) {
        const pair = await this.#readConflictPairByHoldId(
          tx,
          tenantId,
          rsid,
          holdId,
        );
        if (
          index.state === "complete" &&
          !index.scopeDigests.includes(pair.scopeDigest)
        ) {
          throw new Error("tombstone hold is absent from the session index");
        }
      }
      return tombstone;
    });
    if (!verified.ok) {
      throw new GatewayRbpFault("unavailable", verified.message, 503, 1011);
    }
    return verified.value;
  }

  #syncActiveRecord(record: DurableRbpSession): void {
    const active = this.#active.get(record.rsid);
    if (active !== undefined && active.tenantId === record.tenantId) {
      active.record = record;
    }
  }

  async #readSession(tenantId: string, rsid: string): Promise<DurableRbpSession> {
    const stored = await this.#readStoredSession(tenantId, rsid);
    if (stored === null) {
      throw new GatewayRbpFault("auth", "unknown rsid", 404, 4403);
    }
    return parseStoredSession(stored, tenantId, rsid);
  }

  async #updateSession(
    tenantId: string,
    rsid: string,
    mutate: (record: DurableRbpSession) => DurableRbpSession,
  ): Promise<DurableRbpSession> {
    const result = await this.store.transact({ tenantId }, async (tx) => {
      const stored = await tx.read<GatewayJsonValue>(
        GATEWAY_RBP_SESSION_NAMESPACE,
        rsid,
      );
      if (stored === null) throw new Error("unknown durable rsid");
      const current = parseStoredSession(stored, tenantId, rsid);
      const next = nextSessionRecord(
        stored,
        current,
        mutate(current),
        this.#clock(),
      );
      tx.stage({
        namespace: GATEWAY_RBP_SESSION_NAMESPACE,
        key: rsid,
        value: asJson(next),
        expect: { kind: "version", version: stored.version },
      });
      return next;
    });
    if (!result.ok) throw new GatewayRbpFault("unavailable", result.message, 503, 1011);
    return result.value;
  }

  #indeterminateOutcome(mutating: boolean): GatewayExecutorOutcome {
    return mutating
      ? {
          state: "failed",
          error: {
            code: "journal_indeterminate",
            message: "durable dispatch has no trusted terminal evidence",
          },
        }
      : {
          state: "failed",
          error: {
            code: "revit_timeout",
            message: "read invocation did not return before its deadline",
          },
        };
  }
}

class BridgeSessionExecutor implements GatewayExecutor {
  public readonly binding = "bridge" as const;

  public constructor(private readonly authority: GatewayBridgeSessionAuthority) {}

  public async execute(request: GatewayExecutorRequest): Promise<GatewayExecutorOutcome> {
    return await this.authority.execute(request);
  }

  public async previewConfirmation(
    request: GatewayExecutorRequest,
  ): Promise<GatewayExecutorOutcome & { readonly previewRef?: string }> {
    return await this.authority.execute(request);
  }

  public buildMutationDispatch(request: GatewayExecutorRequest) {
    return this.authority.buildEnvelope(request);
  }

  public async executePreparedMutation(
    request: GatewayExecutorRequest,
    dispatch: GatewayRecoveryPendingDispatch,
  ): Promise<GatewayExecutorOutcome> {
    return await this.authority.execute(request, dispatch);
  }

  public buildAtomicBatchDispatch(request: GatewayAtomicBatchExecutorRequest) {
    return this.authority.buildAtomicBatchEnvelope(request);
  }

  public async executePreparedAtomicBatch(
    request: GatewayAtomicBatchExecutorRequest,
    dispatch: GatewayRecoveryPendingDispatch,
  ): Promise<GatewayExecutorOutcome> {
    return await this.authority.executeAtomicBatch(request, dispatch);
  }
}
