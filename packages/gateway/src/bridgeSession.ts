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
  type ArtifactReference,
  type TerminalStreamManifest,
} from "@revagent/protocol";

import {
  isCanonicalMachineFingerprint,
  machineFingerprintClaimsEqual,
  type DeviceAuthContext,
  type GatewayMachineFingerprint,
  type IdentityPort,
} from "./authContext.js";
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
  GatewayBridgeNoSendReceipt,
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
  ObjectStorePort,
  StoreExpectation,
  StoreOutcome,
  StoreTransaction,
  StoredRecord,
} from "./store.js";
import type {
  EffectiveMcpRequestScopeV1,
  GatewayInvocationRoute,
} from "./invocationContext.js";
import { createGatewayDispatchProofAuthority } from "./invocationContext.js";
import {
  BridgeCarrierTerminalAborted,
  BRIDGE_CARRIER_COMMIT_OK,
} from "./resourceAuthority.js";
import {
  documentContextDigest,
  isDocumentContextDigest,
} from "./documentContextDigest.js";
import type {
  BridgeCarrierCommitResult,
  BridgeCarrierCommitMode,
  GatewayResourceAuthority,
  GatewayResourceScope,
} from "./resourceAuthority.js";
import type {
  IdentityDeviceV2,
  IdentityRevocationEventV1,
  IdentityResyncSnapshot,
  IdentityTenantSeatV1,
  ProductionIdentityAuthority,
} from "./productionIdentityStore.js";

export const GATEWAY_RBP_SESSION_NAMESPACE =
  "gateway.rbp-session/v1" as const;
export const GATEWAY_RBP_UNREGISTER_NAMESPACE =
  "gateway.rbp-unregister/v1" as const;
export const GATEWAY_RBP_SESSION_V2_NAMESPACE = "gateway.rbp-session/v2" as const;
/** The v2 authority switch.  A v2 root without this marker is staging only. */
export const GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE =
  "gateway.rbp-session-cutover/v2" as const;
/** Private, marker-less startup migration state. Its presence is deny-only. */
export const GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE =
  "gateway.rbp-session-migration/v1" as const;
const GATEWAY_RBP_SESSION_V2_EVIDENCE_NAMESPACE =
  "gateway.rbp-session-evidence/v2" as const;
const GATEWAY_RBP_SESSION_V2_EGRESS_NAMESPACE =
  "gateway.rbp-session-egress/v2" as const;
const GATEWAY_RBP_SESSION_V2_CONFLICT_INDEX_NAMESPACE =
  "gateway.rbp-session-conflict-index/v2" as const;
export const GATEWAY_MUTATION_RESOLUTION_NAMESPACE = "gateway.mutation-resolution/v1" as const;
/**
 * Terminal carriers that arrive after durable unregister authority are kept in
 * this append-only, digest-only lane.  It is deliberately outside the normal
 * session aggregate: revocation must never be "re-opened" merely to record a
 * late carrier observation.
 */
const GATEWAY_RBP_LATE_TERMINAL_NAMESPACE =
  "gateway.rbp-late-terminal/v1" as const;
/** Test-only observer for prequeue carrier-admission ordering. */
export const TEST_RSID_CARRIER_RECEIVE_TAIL_OBSERVER = Symbol(
  "revagent.gateway.test.rsid-carrier-receive-tail-observer",
);

const RESUME_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const INVOCATION_TIMEOUT_MS = 120_000;
const SEND_RESERVATION_TTL_MS = 5_000;
const UNREGISTER_DRAIN_TIMEOUT_MS = 5_000;
const MAX_AUTHORIZATION_CAS_ATTEMPTS = 8;
const MAX_NORMALIZED_CONFLICT_INDEX_ENTRIES = 256;
const PROTOCOL_STORE_TRANSACTION_WRITE_LIMIT = 128;
const MAX_RECOVERABLE_MUTATION_SCOPES =
  PROTOCOL_STORE_TRANSACTION_WRITE_LIMIT / 2;
const MAX_HOLD_AUDIT_ENTRIES = 256;
const MAX_DURABLE_STRING_LENGTH = 4_096;
const MAX_IDENTITY_EVENT_BATCH = 1_000;
const MAX_IDENTITY_EVENT_BATCHES = 32;
const MAX_IDENTITY_SESSION_RESYNC = 10_000;
const MAX_REVOKED_CONNECTION_TOMBSTONES = 10_000;
const DEFAULT_MAX_ACTIVE_SEAT_REASSIGNMENTS = 16;
const MAX_CONFIGURED_ACTIVE_SEAT_REASSIGNMENTS = 256;
const DEFAULT_SEAT_REASSIGNMENT_TIMEOUT_MS = 30_000;
const MAX_SEAT_REASSIGNMENT_TIMEOUT_MS = 300_000;
const DEFAULT_SEAT_REASSIGNMENT_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const MAX_SEAT_REASSIGNMENT_CLOSE_DRAIN_TIMEOUT_MS = 60_000;
const MAX_SEAT_REASSIGNMENT_ATTEMPTS = 2;
const MAX_RSID_CARRIER_RECEIVE_TAIL_BYTES = 8 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HOLD_ID_PATTERN = /^vh:[0-9a-f]{64}$/u;
/**
 * RBP/1 grants capabilities in two non-interchangeable authority domains.
 * Connection capabilities are negotiated by `hello`; session capabilities are
 * negotiated only by `session_register`.
 */
const IMPLEMENTED_CONNECTION_CAPABILITIES = Object.freeze([
  "journal_v1",
  "chunked_results",
  "artifact_result_v1",
  "transport_streamable_http",
] as const);

const IMPLEMENTED_SESSION_CAPABILITIES = Object.freeze([
  "batch_atomic",
  "doc_context_cached_v1",
] as const);

function grantCapabilities(
  implemented: readonly string[],
  provisioned: readonly string[] | undefined,
  requestedOrProbed: readonly string[],
): string[] {
  const provisionedSet = new Set(provisioned ?? []);
  const requestedOrProbedSet = new Set(requestedOrProbed);
  return implemented.filter(
    (capability) =>
      provisionedSet.has(capability) && requestedOrProbedSet.has(capability),
  );
}

type BindingKind = "wss" | "http_sse";

type BridgeLifecycleState = "closed" | "opening" | "open" | "closing" | "failed";
type BridgeLifecycleResourceState = "closed" | "open" | "unknown";

interface DurableIdentityAuthority {
  readonly machineFingerprint: GatewayMachineFingerprint;
  readonly deviceTokenDigest: `sha256:${string}`;
  readonly authorizationVersion: number;
  readonly identityRecordVersion: number;
  readonly connectionCapabilityVersion: number;
  readonly sessionCapabilityVersion: number;
  readonly seatAuthorityVersion: number;
  readonly seatRecordVersion: number;
}

interface TenantIdentitySnapshot {
  readonly headSequence: number;
  readonly authorityDigest: `sha256:${string}`;
  readonly devices: ReadonlyMap<string, IdentityDeviceV2>;
  readonly seats: ReadonlyMap<string, IdentityTenantSeatV1>;
}

interface TenantAuthorityTicket {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly connectionId: string;
  readonly tenantBlockGeneration: number;
  readonly deviceGeneration: number;
  readonly seatGeneration: number;
  readonly identityAuthority: DurableIdentityAuthority | null;
}

type ScopedAuthorityStatus = "active" | "revoked" | "blocked";

interface DeviceAuthorityFence {
  readonly generation: number;
  readonly status: ScopedAuthorityStatus;
  readonly authorizationVersion: number | null;
  readonly identityRecordVersion: number | null;
  readonly connectionCapabilityVersion: number | null;
  readonly sessionCapabilityVersion: number | null;
  readonly seatId: string | null;
  readonly reason: "device_revoked" | "seat_revoked" | null;
}

interface SeatAuthorityFence {
  readonly generation: number;
  readonly status: ScopedAuthorityStatus;
  readonly seatAuthorityVersion: number | null;
  readonly seatRecordVersion: number | null;
  readonly deviceId: string | null;
  readonly reason: "seat_revoked" | null;
}

interface SeatReassignmentOperation {
  readonly token: string;
  readonly tenantId: string;
  readonly seatId: string;
  readonly priorDeviceId: string;
  readonly incomingDeviceId: string;
  readonly tenantBlockGeneration: number;
  readonly priorDeviceFence: DeviceAuthorityFence;
  readonly incomingDeviceFence: DeviceAuthorityFence;
  readonly seatFence: SeatAuthorityFence;
}

interface SeatReassignmentAttemptState {
  attemptsStarted: number;
  state:
    | "active"
    | "timed_out_cleanup_pending"
    | "cancelled_cleanup_pending"
    | "quarantined";
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly lifecycleGeneration: number;
}

type SeatReassignmentTaskOutcome =
  | "succeeded"
  | "quarantined"
  | "cancelled";

interface SeatReassignmentTask {
  readonly operation: SeatReassignmentOperation;
  readonly lifecycleGeneration: number;
  readonly attempt: number;
  cancelled: boolean;
  cancellationKind: "authority" | "lifecycle" | null;
  outcomeSettled: boolean;
  drainSettled: boolean;
  readonly outcome: Promise<SeatReassignmentTaskOutcome>;
  readonly resolveOutcome: (outcome: SeatReassignmentTaskOutcome) => void;
  readonly cancellation: Promise<void>;
  readonly resolveCancellation: () => void;
  readonly drain: Promise<void>;
  readonly resolveDrain: () => void;
}

type CarrierReceiveTailObserver = (event: {
  readonly stage: "denied_prequeue" | "tail_installed" | "tail_released";
  readonly rsid: string;
  readonly queuedBytes: number;
}) => void;

/**
 * Value-free test/diagnostic seam. It is deliberately limited to the outcome
 * stage and inbound sequence: no rsid, payload, identity, or route detail is
 * ever exposed through this callback.
 */
export type GatewayDocumentContextObservation = Readonly<{
  /** Only accepted payloads are correlated; rejection has no durable route. */
  readonly stage: "accepted";
  readonly sequence: number;
  /** Bare lower-case SHA-256, matching the real C# worker observation. */
  readonly contextDigest: string;
}>;

type GatewayDocumentContextObserver = (
  observation: GatewayDocumentContextObservation,
) => void;

interface DurablePendingDispatch {
  readonly envelopeDigest: `sha256:${string}`;
  readonly gatewaySequence: number;
  readonly invocationId: string;
  readonly mutating: boolean;
  /** Optional only for true pre-WP-02 rows; journal bindings are the fallback. */
  readonly mutationEntries?: readonly DurablePendingMutation[];
  readonly journalRecords: readonly InvocationJournalRecord[];
  /**
   * Gateway-authored coordinates retained before the adapter invocation
   * boundary. They are audit material only: absence on an older row is never
   * authority to replay that row after a restart.
   */
  readonly dispatchReceipt?: {
    readonly version: 1;
    readonly tenantId: string;
    readonly invocationId: string;
    readonly correlationId: string;
    readonly proofDigest: `sha256:${string}`;
    readonly routeSnapshotDigest: `sha256:${string}`;
    readonly egressEpoch: number;
    readonly leaseTicket: number;
    readonly intent: "dispatch";
  } | null;
  /** Reservation-time Gateway authority; never supplied by carrier/receipt. */
  readonly expectedNoSendAuthorityDigest?: `sha256:${string}` | null;
  /** Exact immutable north ingress scope; absent only on pre-WP-11 rows. */
  readonly effectiveMcpRequestScope?: EffectiveMcpRequestScopeV1;
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
  /** Terminal truth is retained even when identity revocation suppresses delivery. */
  readonly terminalTruth?: DurableTerminalTruth | null;
  /** Domain-separated terminal admission digest for exact CAS replay proof. */
  readonly terminalDigest?: `sha256:${string}` | null;
  readonly terminalCarrierDigest?: `sha256:${string}` | null;
  /**
   * Gateway-authored proof that a particular reserved dispatch was cancelled
   * before the carrier invocation boundary.  This deliberately contains
   * digests and durable lease coordinates only; no executable payload or
   * dispatch proof object is retained.
   */
  readonly noSendReceipt?: DurableNoSendReceipt | null;
  readonly noSendAuthorityDigest?: `sha256:${string}` | null;
}

type DurableNoSendReceipt = GatewayBridgeNoSendReceipt;

interface DurableTerminalTruth {
  readonly state: "completed" | "guarded" | "failed";
  readonly resultDigest: `sha256:${string}` | null;
  readonly errorCode: string | null;
  readonly payloadRetained: boolean;
}

interface DurableLateTerminalEvidence {
  readonly schema: typeof GATEWAY_RBP_LATE_TERMINAL_NAMESPACE;
  readonly tenantId: string;
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly connectionId: string;
  readonly correlationId: string;
  readonly terminalSequence: number;
  readonly terminalCarrierDigest: `sha256:${string}`;
  readonly terminalDigest: `sha256:${string}`;
  readonly dispatchReceiptDigest: `sha256:${string}`;
  readonly terminalTruth: DurableTerminalTruth;
  readonly recordedAtMs: number;
}

interface TerminalAdmission {
  readonly tenantId: string;
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly connectionId: string;
  readonly correlationId: string;
  readonly terminalSequence: number;
  readonly pendingEnvelopeDigest: `sha256:${string}`;
  readonly pendingGatewaySequence: number;
  readonly dispatchReceiptDigest: `sha256:${string}`;
  readonly terminalCarrierDigest: `sha256:${string}`;
  readonly terminalDigest: `sha256:${string}`;
  readonly terminalTruth: DurableTerminalTruth;
}

interface DurableLiveDocumentRoute {
  readonly sessionDocumentId: string;
  readonly observedConnectionId: string;
  readonly observedSequence: number;
  /** Diagnostic-only correlate for the admitted payload, never north input. */
  readonly contextDigest: string;
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
  /** Null only for deterministic legacy adapters without versioned authority. */
  readonly identityAuthority?: DurableIdentityAuthority | null;
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

interface DurableRbpSessionV2 {
  readonly schema: typeof GATEWAY_RBP_SESSION_V2_NAMESPACE;
  readonly generation: 2;
  /** Logical aggregate generation. Store record versions are adapter-private. */
  readonly rootVersion: number;
  readonly tenantId: string;
  readonly rsid: string;
  readonly identity: Pick<DurableRbpSession, "userId" | "deviceId" | "seatId" | "identityAuthority">;
  readonly binding: Pick<DurableRbpSession, "sessionBindingId" | "sessionVersion" | "connectionId" | "binding" | "resumeTokenDigest" | "resumeExpiresAtMs" | "grantedCapabilities">;
  readonly lifecycle: Pick<DurableRbpSession, "connectionLifecycle" | "sessionLifecycle" | "lastHeartbeatAtMs" | "liveDocumentRoute" | "createdAtMs" | "updatedAtMs" | "recordVersion">;
  readonly sequence: Pick<DurableRbpSession, "sequence" | "pending">;
  readonly migration: {
    readonly sourceVersionDigest: `sha256:${string}`;
    readonly legacyDigest: `sha256:${string}`;
    readonly counts: { readonly holds: number; readonly conflicts: number; readonly resolutions: number };
    readonly deletionReceipt: { readonly state: "retained" | "deleted"; readonly verifiedAtMs: number | null };
  };
  readonly childRefs: readonly DurableSessionV2ChildRef[];
  readonly childrenDigest: `sha256:${string}`;
}

interface DurableSessionV2ChildRef {
  readonly namespace: string;
  readonly key: string;
  readonly digest: `sha256:${string}`;
  readonly version: number;
}

interface DurableSessionCutoverV2 {
  readonly schema: typeof GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE;
  readonly generation: 2;
  readonly tenantId: string;
  readonly rsid: string;
  readonly sourceLegacyDigest: `sha256:${string}`;
  readonly rootVersion: number;
  readonly rootDigest: `sha256:${string}`;
  readonly childrenDigest: `sha256:${string}`;
  readonly migratedAtMs: number;
}

interface DurableSessionV2EvidenceChild {
  readonly schema: typeof GATEWAY_RBP_SESSION_V2_EVIDENCE_NAMESPACE;
  readonly tenantId: string;
  readonly rsid: string;
  readonly invocationId: string;
  readonly entry: DurableDispatchEvidence;
}

interface DurableSessionV2EgressChild {
  readonly schema: typeof GATEWAY_RBP_SESSION_V2_EGRESS_NAMESPACE;
  readonly tenantId: string;
  readonly rsid: string;
  readonly fence: DurableEgressFence;
}

interface DurableSessionV2ConflictIndexChild {
  readonly schema: typeof GATEWAY_RBP_SESSION_V2_CONFLICT_INDEX_NAMESPACE;
  readonly tenantId: string;
  readonly rsid: string;
  readonly index: DurableNormalizedConflictIndex;
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
  /** v2 only: a Gateway-owned nominal dispatch proof, never wire material. */
  readonly proofDigest?: `sha256:${string}` | null;
  /** v2 only: binds the exact route snapshot independently of the envelope. */
  readonly routeSnapshotDigest?: `sha256:${string}` | null;
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

/**
 * A cancellation intent is deliberately durable and value-free.  It pins the
 * exact reserved lease and the Gateway-authored no-send authority digest
 * before a queue/connection is allowed to report a pre-send outcome.  The
 * receipt itself is written only by the second CAS below.
 */
interface DurableEgressCancellation {
  readonly leaseId: string;
  readonly leaseTicket: number;
  readonly envelopeDigest: `sha256:${string}`;
  readonly expectedNoSendAuthorityDigest: `sha256:${string}`;
  readonly receiptIntentDigest: `sha256:${string}`;
  readonly requestedAtMs: number;
}

interface DurableEgressFence {
  readonly version: 1;
  readonly state: "open" | "cancellation_pending" | "revocation_pending";
  readonly epoch: number;
  readonly nextTicket: number;
  readonly lease: DurableEgressLease | null;
  readonly revocation: DurableEgressRevocation | null;
  readonly cancellation: DurableEgressCancellation | null;
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
  readonly migration?: DurableSessionMigrationBinding;
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
  readonly migration?: DurableSessionMigrationBinding;
}

interface DurableSessionMigrationSource {
  readonly namespace: string;
  readonly key: string;
  readonly version: number;
  readonly digest: `sha256:${string}`;
}

/** Immutable provenance carried by every legacy-imported normalized child. */
interface DurableSessionMigrationBinding {
  readonly migrationId: `sha256:${string}`;
  readonly source: DurableSessionMigrationSource;
}

interface DurableSessionMigrationPlan {
  readonly schema: typeof GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE;
  readonly tenantId: string;
  readonly rsid: string;
  readonly migrationId: `sha256:${string}`;
  readonly sessionSource: DurableSessionMigrationSource;
  readonly recoverySource: DurableSessionMigrationSource | null;
  readonly legacyDigest: `sha256:${string}`;
  readonly scopes: readonly {
    readonly holdId: `vh:${string}`;
    readonly scopeDigest: `sha256:${string}`;
    readonly holdDigest: `sha256:${string}`;
    readonly conflictDigest: `sha256:${string}`;
  }[];
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
  auth: DeviceAuthContext;
  readonly machineHostname: string;
  tenantBlockGeneration: number;
  deviceGeneration: number;
  seatGeneration: number;
  readonly grantedCapabilities: readonly string[];
  readonly lifecycle: ConnectionLifecycleState;
  send(serialized: string): Promise<void>;
  sendDispatchStarted?(serialized: string, handoff: DispatchTransportHandoff): {
    readonly started: Promise<void>;
    readonly completion: Promise<void>;
    /** true only if the carrier has definitely not invoked transport. */
    cancel(): Promise<boolean>;
  };
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
  readonly tenantId: string;
  readonly rsid: string;
  readonly mutating: boolean;
}

interface DurableEgressReservation {
  readonly tenantId: string;
  readonly rsid: string;
  readonly lease: DurableEgressLease;
  readonly record: DurableRbpSession;
  /** In-memory only; must never be serialized into a lease or envelope. */
  readonly dispatchProof?: object;
}

/**
 * A dispatch carrier has two distinct pre-transport transitions: the durable
 * reservation may be promoted, or the reservation may be cancelled.  These
 * operations deliberately race on the same durable CAS fence, but callers
 * must never race two in-memory cleanups around that fence.  In particular,
 * a slow queue cancellation is allowed to make the caller unavailable while
 * its one exact cleanup remains in flight; it is not allowed to reopen the
 * route or to start a second cleanup for a newer lease.
 *
 * This is module-private on purpose.  The coordinator carries no wire data
 * and its identity is one-shot for one `#sendWithDurableReservation` call.
 */
class PreStartCancellationCoordinator {
  #cancelRequested = false;
  #cancellation: Promise<DispatchPreStartCancellation> | null = null;
  #promotion: Promise<DurableEgressReservation> | null = null;

  public constructor(
    private readonly releaseReserved: () => Promise<DispatchPreStartCancellation>,
  ) {}

  public requestCancel(): Promise<DispatchPreStartCancellation> {
    this.#cancelRequested = true;
    if (this.#cancellation === null) {
      this.#cancellation = this.releaseReserved();
    }
    return this.#cancellation;
  }

  public async promote(
    promoteReserved: () => Promise<DurableEgressReservation>,
  ): Promise<DurableEgressReservation> {
    if (this.#cancelRequested) {
      throw new GatewayRbpFault(
        "unavailable",
        "dispatch carrier cancelled before promotion",
        503,
        1011,
      );
    }
    if (this.#promotion === null) {
      this.#promotion = (async () => {
        // Do not put a timer or a caller-wait bound here.  The durable
        // promotion/cancellation CAS determines truth; a bound only governs
        // when a caller stops awaiting that truth.
        if (this.#cancelRequested) {
          throw new GatewayRbpFault(
            "unavailable",
            "dispatch carrier cancelled before promotion",
            503,
            1011,
          );
        }
        const promoted = await promoteReserved();
        if (this.#cancelRequested) {
          // Promotion won (or its post-commit state is all we can observe).
          // Never release a started/uncertain lease from a cancellation path.
          throw new GatewayRbpFault(
            "unavailable",
            "dispatch carrier cancellation lost durable promotion",
            503,
            1011,
          );
        }
        return promoted;
      })();
    }
    return await this.#promotion;
  }
}

/** In-memory-only dispatch handoff; no proof or lease data crosses the carrier. */
export interface DispatchTransportHandoff {
  readonly revalidate: (signal: AbortSignal) => Promise<void>;
  /**
   * True is only a local adapter observation. The authority rechecks the
   * exact durable no-send receipt before treating it as semantic settlement.
   */
  readonly cancelBeforeStart: () => Promise<boolean>;
}

export type DispatchPreStartCancellation =
  | "settled_no_send"
  | "cancellation_pending"
  | "promotion_won";

interface ReservedResumeAck extends DurableEgressReservation {
  readonly serialized: string;
}

interface PendingRevocationAuthority {
  readonly stored: StoredRecord<GatewayJsonValue>;
  readonly record: DurableRbpSession;
  readonly revocation: DurableEgressRevocation;
  readonly candidates: readonly NormalizedHoldCandidate[];
}

interface TrustedRecoveryAdmission {
  readonly dispatch: GatewayRecoveryPendingDispatch | null;
  readonly holdIds: ReadonlySet<string>;
  readonly originRedelivery: boolean;
}

export interface BridgeConnectionChannel {
  send(serialized: string): Promise<void>;
  /** Dispatch-only two-promise handoff; lifecycle traffic remains on send(). */
  sendDispatchStarted?(serialized: string, handoff: DispatchTransportHandoff): {
    readonly started: Promise<void>;
    readonly completion: Promise<void>;
    cancel(): Promise<boolean>;
  };
  close(code: number, reason: string): Promise<void>;
}

export interface BridgeConnectionOpening {
  readonly connectionId: string;
  readonly helloAck: HelloAckEnvelope;
}

export interface GatewayBridgeSessionLifecycleSnapshot {
  readonly state: BridgeLifecycleState;
  readonly protocolStore: BridgeLifecycleResourceState;
  readonly identity: BridgeLifecycleResourceState;
  readonly protocolStoreManagedBy: "bridge" | "identity";
}

/**
 * Value-free, read-only current-route evidence.  It is intentionally not a
 * dispatch route and contains no RSID, connection ID, document ID, or session
 * binding value.  The conformance host may read it only to join a C# emitted
 * context digest to the Gateway's already-authoritative current route.
 */
export interface GatewayCurrentDocumentRouteAuditSnapshot {
  readonly rsidHash: `sha256:${string}`;
  readonly observedSequence: number;
  readonly contextDigest: string;
  readonly routeDigest: `sha256:${string}`;
  readonly recordDigest: `sha256:${string}`;
  readonly sessionBindingDigest: `sha256:${string}`;
  readonly connectionDigest: `sha256:${string}`;
  readonly sessionRecordVersion: number;
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

function artifactReferencesFromResult(value: unknown, output: ArtifactReference[], depth = 0): void {
  if (depth > 32 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) artifactReferencesFromResult(item, output, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.artifact_id === "string" && Number.isSafeInteger(record.artifact_index)) {
    output.push({ artifact_id: record.artifact_id, artifact_index: record.artifact_index as number });
  }
  for (const child of Object.values(record)) artifactReferencesFromResult(child, output, depth + 1);
}

function artifactManifestFor(
  envelope: Extract<RbpEnvelope, { type: "result" }>,
): Extract<TerminalStreamManifest, { kind: "artifact_result" }> | null {
  if (envelope.payload.kind !== "invocation" || !Array.isArray(envelope.payload.artifacts)) {
    return null;
  }
  const artifactReferences: ArtifactReference[] = [];
  artifactReferencesFromResult(envelope.payload.result, artifactReferences);
  return {
    kind: "artifact_result",
    artifactReferences,
    descriptors: envelope.payload.artifacts,
  };
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asProductionIdentityAuthority(
  identity: IdentityPort,
): ProductionIdentityAuthority | null {
  const candidate = identity as Partial<ProductionIdentityAuthority>;
  if (
    identity.kind !== "oidc" ||
    typeof candidate.open !== "function" ||
    typeof candidate.close !== "function" ||
    typeof candidate.lifecycle !== "function" ||
    typeof candidate.managedResources !== "function" ||
    typeof candidate.usesStore !== "function" ||
    typeof candidate.consumeRevocationEvents !== "function" ||
    typeof candidate.prepareTenantResync !== "function" ||
    typeof candidate.commitTenantResync !== "function" ||
    typeof candidate.provisionDevice !== "function" ||
    typeof candidate.revokeDevice !== "function" ||
    typeof candidate.revokeSeat !== "function"
  ) {
    return null;
  }
  return identity as ProductionIdentityAuthority;
}

function durableIdentityAuthority(
  auth: DeviceAuthContext,
): DurableIdentityAuthority | null {
  if (
    !isCanonicalMachineFingerprint(auth.machineFingerprint) ||
    !DIGEST_PATTERN.test(auth.deviceTokenDigest) ||
    !isSafePositiveInteger(auth.authorizationVersion) ||
    !isSafePositiveInteger(auth.identityRecordVersion) ||
    !isSafePositiveInteger(auth.connectionCapabilityVersion) ||
    !isSafePositiveInteger(auth.sessionCapabilityVersion) ||
    !isSafePositiveInteger(auth.seatAuthorityVersion) ||
    !isSafePositiveInteger(auth.seatRecordVersion)
  ) {
    return null;
  }
  return Object.freeze({
    machineFingerprint: auth.machineFingerprint,
    deviceTokenDigest: auth.deviceTokenDigest,
    authorizationVersion: auth.authorizationVersion,
    identityRecordVersion: auth.identityRecordVersion,
    connectionCapabilityVersion: auth.connectionCapabilityVersion,
    sessionCapabilityVersion: auth.sessionCapabilityVersion,
    seatAuthorityVersion: auth.seatAuthorityVersion,
    seatRecordVersion: auth.seatRecordVersion,
  });
}

function sameDurableIdentityAuthority(
  auth: DeviceAuthContext,
  expected: DurableIdentityAuthority | null | undefined,
): boolean {
  if (expected === undefined || expected === null) {
    return durableIdentityAuthority(auth) === null;
  }
  const current = durableIdentityAuthority(auth);
  return (
    current !== null &&
    machineFingerprintClaimsEqual(
      current.machineFingerprint,
      expected.machineFingerprint,
    ) &&
    current.deviceTokenDigest === expected.deviceTokenDigest &&
    current.authorizationVersion === expected.authorizationVersion &&
    current.identityRecordVersion === expected.identityRecordVersion &&
    current.connectionCapabilityVersion === expected.connectionCapabilityVersion &&
    current.sessionCapabilityVersion === expected.sessionCapabilityVersion &&
    current.seatAuthorityVersion === expected.seatAuthorityVersion &&
    current.seatRecordVersion === expected.seatRecordVersion
  );
}

function identitySnapshot(
  snapshot: IdentityResyncSnapshot,
): TenantIdentitySnapshot {
  const devices = new Map(snapshot.devices.map((device) => [device.deviceId, device]));
  const seats = new Map(snapshot.seats.map((seat) => [seat.seatId, seat]));
  if (
    !isSafeNonNegativeInteger(snapshot.headSequence) ||
    !DIGEST_PATTERN.test(snapshot.authorityDigest) ||
    devices.size !== snapshot.devices.length ||
    seats.size !== snapshot.seats.length ||
    snapshot.devices.some((device) => device.tenantId !== snapshot.tenantId) ||
    snapshot.seats.some((seat) => seat.tenantId !== snapshot.tenantId)
  ) {
    throw new Error("identity resync snapshot is malformed");
  }
  return Object.freeze({
    headSequence: snapshot.headSequence,
    authorityDigest: snapshot.authorityDigest,
    devices,
    seats,
  });
}

function identityIndexKey(tenantId: string, authorityId: string): string {
  return `${tenantId}\u0000${authorityId}`;
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

function isUniqueOriginKeysInOrder(
  value: unknown,
  maximum: number,
  rsid: string,
): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    return false;
  }
  const observed = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      !candidate.startsWith(`${rsid}/`) ||
      candidate.length <= rsid.length + 1 ||
      observed.has(candidate)
    ) {
      return false;
    }
    observed.add(candidate);
  }
  return true;
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
    cancellation: null,
  };
}

function emptyNormalizedConflictIndex(): DurableNormalizedConflictIndex {
  return { version: 1, state: "complete", scopeDigests: [] };
}

function parseEgressLease(value: unknown): DurableEgressLease {
  const legacyKeys = [
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
  ] as const;
  const v2Keys = [...legacyKeys, "proofDigest", "routeSnapshotDigest"] as const;
  if (!isRecord(value) || (!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, v2Keys))) {
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
    (Object.hasOwn(value, "proofDigest") &&
      (typeof value.proofDigest !== "string" || !DIGEST_PATTERN.test(value.proofDigest))) ||
    (Object.hasOwn(value, "routeSnapshotDigest") &&
      (typeof value.routeSnapshotDigest !== "string" || !DIGEST_PATTERN.test(value.routeSnapshotDigest))) ||
    (phase !== "reserved" && phase !== "started") ||
    !isSafeNonNegativeInteger(value.reservedAtMs) ||
    !isSafeNonNegativeInteger(value.reserveExpiresAtMs) ||
    value.reserveExpiresAtMs !== value.reservedAtMs + SEND_RESERVATION_TTL_MS ||
    (phase === "reserved"
      ? value.startedAtMs !== null
      : !isSafeNonNegativeInteger(value.startedAtMs) ||
        value.startedAtMs < value.reservedAtMs ||
        value.startedAtMs >= value.reserveExpiresAtMs)
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

function parseEgressCancellation(value: unknown): DurableEgressCancellation {
  if (!isRecord(value) || !hasExactKeys(value, [
    "leaseId",
    "leaseTicket",
    "envelopeDigest",
    "expectedNoSendAuthorityDigest",
    "receiptIntentDigest",
    "requestedAtMs",
  ])) {
    throw new Error("malformed egress cancellation");
  }
  if (
    !isBoundedNonEmptyString(value.leaseId) ||
    !isGatewayUuidV7(value.leaseId) ||
    !isSafePositiveInteger(value.leaseTicket) ||
    typeof value.envelopeDigest !== "string" ||
    !DIGEST_PATTERN.test(value.envelopeDigest) ||
    typeof value.expectedNoSendAuthorityDigest !== "string" ||
    !DIGEST_PATTERN.test(value.expectedNoSendAuthorityDigest) ||
    typeof value.receiptIntentDigest !== "string" ||
    !DIGEST_PATTERN.test(value.receiptIntentDigest) ||
    !isSafeNonNegativeInteger(value.requestedAtMs)
  ) {
    throw new Error("malformed egress cancellation");
  }
  return value as unknown as DurableEgressCancellation;
}

function parseEgressFence(value: unknown): DurableEgressFence {
  const legacyKeys = [
    "version",
    "state",
    "epoch",
    "nextTicket",
    "lease",
    "revocation",
  ] as const;
  const cancellationKeys = [...legacyKeys, "cancellation"] as const;
  if (!isRecord(value) || (!hasExactKeys(value, legacyKeys) && !hasExactKeys(value, cancellationKeys))) {
    throw new Error("malformed egress fence");
  }
  if (
    value.version !== 1 ||
    (value.state !== "open" && value.state !== "cancellation_pending" && value.state !== "revocation_pending") ||
    !isSafeNonNegativeInteger(value.epoch) ||
    !isSafePositiveInteger(value.nextTicket)
  ) {
    throw new Error("malformed egress fence");
  }
  const lease = value.lease === null ? null : parseEgressLease(value.lease);
  const revocation = value.revocation === null
    ? null
    : parseEgressRevocation(value.revocation);
  const cancellation = Object.hasOwn(value, "cancellation")
    ? value.cancellation === null ? null : parseEgressCancellation(value.cancellation)
    : null;
  if (
    (value.state === "open" && (revocation !== null || cancellation !== null)) ||
    (value.state === "cancellation_pending" && (revocation !== null || cancellation === null)) ||
    (value.state === "revocation_pending" && revocation === null) ||
    (value.state === "revocation_pending" && cancellation !== null) ||
    (value.state === "revocation_pending" && lease?.phase === "reserved") ||
    (value.state === "cancellation_pending" &&
      (lease === null || lease.phase !== "reserved" ||
        lease.leaseId !== cancellation?.leaseId ||
        lease.ticket !== cancellation?.leaseTicket ||
        lease.envelopeDigest !== cancellation?.envelopeDigest)) ||
    (lease !== null && lease.ticket >= value.nextTicket)
  ) {
    throw new Error("malformed egress fence");
  }
  return { ...value, lease, revocation, cancellation } as DurableEgressFence;
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

function parseSessionIdentityAuthority(
  value: unknown,
): DurableIdentityAuthority | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "machineFingerprint",
      "deviceTokenDigest",
      "authorizationVersion",
      "identityRecordVersion",
      "connectionCapabilityVersion",
      "sessionCapabilityVersion",
      "seatAuthorityVersion",
      "seatRecordVersion",
    ]) ||
    !isCanonicalMachineFingerprint(value.machineFingerprint) ||
    typeof value.deviceTokenDigest !== "string" ||
    !DIGEST_PATTERN.test(value.deviceTokenDigest) ||
    !isSafePositiveInteger(value.authorizationVersion) ||
    !isSafePositiveInteger(value.identityRecordVersion) ||
    !isSafePositiveInteger(value.connectionCapabilityVersion) ||
    !isSafePositiveInteger(value.sessionCapabilityVersion) ||
    !isSafePositiveInteger(value.seatAuthorityVersion) ||
    !isSafePositiveInteger(value.seatRecordVersion)
  ) {
    throw new Error("malformed durable identity authority");
  }
  return value as unknown as DurableIdentityAuthority;
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
  parseSessionIdentityAuthority(candidate.identityAuthority);
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

function hasRecoverableMutationCapacity(
  record: DurableRbpSession,
  candidates: readonly NormalizedHoldCandidate[],
): boolean {
  if (candidates.length > MAX_RECOVERABLE_MUTATION_SCOPES) return false;
  const index = sessionConflictIndex(record);
  const candidateDigests = candidates.map((candidate) =>
    conflictScopeDigest(candidate.mutationScopeJcs),
  );
  if (index.state === "overflow") {
    return candidateDigests.every((scopeDigest) =>
      index.scopeDigests.includes(scopeDigest),
    );
  }
  return new Set([...index.scopeDigests, ...candidateDigests]).size <=
    MAX_NORMALIZED_CONFLICT_INDEX_ENTRIES;
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
  if (!isRecord(stored.value) || !(
    hasExactKeys(stored.value, [
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
    ]) || hasExactKeys(stored.value, [
      "schema", "tenantId", "createdAtMs", "updatedAtMs", "recordVersion",
      "holdId", "rsid", "mutationScopeJcs", "originIdempotencyKeys", "state",
      "evidenceIds", "evidenceDigests", "resolutionIds", "migration",
    ])
  )) {
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
    !isUniqueOriginKeysInOrder(
      candidate.originIdempotencyKeys,
      MAX_HOLD_AUDIT_ENTRIES,
      rsid,
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
  if (candidate.migration !== undefined) parseSessionMigrationBinding(candidate.migration);
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
  if (!isRecord(stored.value) || !(
    hasExactKeys(stored.value, [
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
    ]) || hasExactKeys(stored.value, [
      "schema", "tenantId", "createdAtMs", "updatedAtMs", "recordVersion",
      "rsid", "scopeDigest", "holdId", "mutationScopeJcs", "active", "migration",
    ])
  )) {
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
  if (candidate.migration !== undefined) parseSessionMigrationBinding(candidate.migration);
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

function parseSessionCutoverV2(
  stored: StoredRecord<GatewayJsonValue>,
  tenantId: string,
  rsid: string,
): DurableSessionCutoverV2 {
  if (!isRecord(stored.value) || !hasExactKeys(stored.value, [
    "schema", "generation", "tenantId", "rsid", "sourceLegacyDigest",
    "rootVersion", "rootDigest", "childrenDigest", "migratedAtMs",
  ])) throw new Error("malformed v2 session cutover marker");
  const value = stored.value;
  if (
    stored.namespace !== GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE ||
    stored.tenantId !== tenantId || stored.key !== rsid ||
    value.schema !== GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE ||
    value.generation !== 2 || value.tenantId !== tenantId || value.rsid !== rsid ||
    typeof value.sourceLegacyDigest !== "string" || !DIGEST_PATTERN.test(value.sourceLegacyDigest) ||
    !isSafePositiveInteger(value.rootVersion) ||
    typeof value.rootDigest !== "string" || !DIGEST_PATTERN.test(value.rootDigest) ||
    typeof value.childrenDigest !== "string" || !DIGEST_PATTERN.test(value.childrenDigest) ||
    !isSafeNonNegativeInteger(value.migratedAtMs)
  ) throw new Error("malformed v2 session cutover marker");
  return value as unknown as DurableSessionCutoverV2;
}

function parseSessionMigrationSource(value: unknown): DurableSessionMigrationSource {
  if (!isRecord(value) || !hasExactKeys(value, ["namespace", "key", "version", "digest"]) ||
    !isBoundedNonEmptyString(value.namespace) || !isBoundedNonEmptyString(value.key) ||
    !isSafePositiveInteger(value.version) || typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest)) {
    throw new Error("malformed session migration source");
  }
  return value as unknown as DurableSessionMigrationSource;
}

function parseSessionMigrationBinding(value: unknown): DurableSessionMigrationBinding {
  if (!isRecord(value) || !hasExactKeys(value, ["migrationId", "source"]) ||
    typeof value.migrationId !== "string" || !DIGEST_PATTERN.test(value.migrationId)) {
    throw new Error("malformed session migration binding");
  }
  return { migrationId: value.migrationId as `sha256:${string}`, source: parseSessionMigrationSource(value.source) };
}

function parseSessionMigrationPlan(
  stored: StoredRecord<GatewayJsonValue>,
  tenantId: string,
  rsid: string,
): DurableSessionMigrationPlan {
  if (!isRecord(stored.value) || !hasExactKeys(stored.value, [
    "schema", "tenantId", "rsid", "migrationId", "sessionSource", "recoverySource", "legacyDigest", "scopes",
  ]) || stored.namespace !== GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE ||
    stored.tenantId !== tenantId || stored.key !== rsid) {
    throw new Error("malformed session migration plan");
  }
  const value = stored.value;
  if (value.schema !== GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE || value.tenantId !== tenantId || value.rsid !== rsid ||
    typeof value.migrationId !== "string" || !DIGEST_PATTERN.test(value.migrationId) ||
    typeof value.legacyDigest !== "string" || !DIGEST_PATTERN.test(value.legacyDigest) || !Array.isArray(value.scopes) ||
    value.scopes.length > MAX_RECOVERABLE_MUTATION_SCOPES) {
    throw new Error("malformed session migration plan");
  }
  const sessionSource = parseSessionMigrationSource(value.sessionSource);
  const recoverySource = value.recoverySource === null ? null : parseSessionMigrationSource(value.recoverySource);
  const scopes = value.scopes.map((scope) => {
    if (!isRecord(scope) || !hasExactKeys(scope, ["holdId", "scopeDigest", "holdDigest", "conflictDigest"]) ||
      typeof scope.holdId !== "string" || !HOLD_ID_PATTERN.test(scope.holdId) ||
      typeof scope.scopeDigest !== "string" || !DIGEST_PATTERN.test(scope.scopeDigest) ||
      typeof scope.holdDigest !== "string" || !DIGEST_PATTERN.test(scope.holdDigest) ||
      typeof scope.conflictDigest !== "string" || !DIGEST_PATTERN.test(scope.conflictDigest)) {
      throw new Error("malformed session migration scope");
    }
    return scope as unknown as DurableSessionMigrationPlan["scopes"][number];
  });
  if (scopes.some((scope, index) => index > 0 && scope.scopeDigest <= scopes[index - 1]!.scopeDigest)) {
    throw new Error("session migration scopes are not deterministically sorted");
  }
  return {
    schema: value.schema as typeof GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE,
    tenantId, rsid, migrationId: value.migrationId as `sha256:${string}`,
    sessionSource, recoverySource, legacyDigest: value.legacyDigest as `sha256:${string}`,
    scopes,
  };
}

function migrationSource(record: StoredRecord<GatewayJsonValue>): DurableSessionMigrationSource {
  return Object.freeze({
    namespace: record.namespace,
    key: record.key,
    version: record.version,
    digest: digest(canonicalizeJson(record.value as JsonValue)),
  });
}

function sameMigrationSource(
  actual: StoredRecord<GatewayJsonValue> | null,
  expected: DurableSessionMigrationSource | null,
): boolean {
  return actual !== null && expected !== null && actual.namespace === expected.namespace &&
    actual.key === expected.key && actual.version === expected.version &&
    digest(canonicalizeJson(actual.value as JsonValue)) === expected.digest;
}

interface ValidatedLegacyHold {
  readonly holdId: string;
  readonly state: "active" | "evidence_recorded" | "resolved_pending_bridge" | "cleared";
  readonly mutationScope: MutationScope;
  readonly originIdempotencyKeys: readonly string[];
  readonly hasResolution: boolean;
  readonly resolutionId: string | null;
  readonly digestFact: JsonValue;
}

function legacyResolutionId(value: unknown): string | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, [
    "resolutionId",
    "basis",
    "verificationInvocationId",
    "evidenceDigest",
    "decision",
    "auditId",
    "authorizedDispatchIdentity",
    "journalBindingDigest",
    "journalOutcomeDigest",
    "terminalKind",
    "terminalStatus",
  ])) {
    throw new Error("malformed legacy recovery resolution");
  }
  if (
    !isBoundedNonEmptyString(value.resolutionId) ||
    !isGatewayUuidV7(value.resolutionId) ||
    (value.basis !== "verification_read" && value.basis !== "late_terminal") ||
    (value.verificationInvocationId !== null &&
      (!isBoundedNonEmptyString(value.verificationInvocationId) ||
        !isGatewayUuidV7(value.verificationInvocationId))) ||
    typeof value.evidenceDigest !== "string" ||
    !DIGEST_PATTERN.test(value.evidenceDigest) ||
    (value.decision !== "non_execution_proven" &&
      value.decision !== "postcondition_verified") ||
    !isBoundedNonEmptyString(value.auditId) ||
    !isGatewayUuidV7(value.auditId) ||
    typeof value.authorizedDispatchIdentity !== "string" ||
    !DIGEST_PATTERN.test(value.authorizedDispatchIdentity) ||
    typeof value.journalBindingDigest !== "string" ||
    !DIGEST_PATTERN.test(value.journalBindingDigest) ||
    typeof value.journalOutcomeDigest !== "string" ||
    !DIGEST_PATTERN.test(value.journalOutcomeDigest) ||
    (value.terminalKind !== "terminal" && value.terminalKind !== "late_terminal") ||
    (value.terminalStatus !== "completed" &&
      value.terminalStatus !== "failed" &&
      value.terminalStatus !== "guarded" &&
      value.terminalStatus !== "cancelled")
  ) {
    throw new Error("malformed legacy recovery resolution");
  }
  return value.resolutionId;
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
  const parsed = holds.map((raw) => {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "rsid",
        "mutationScope",
        "scopeKey",
        "holdId",
        "originIdempotencyKeys",
        "state",
        "evidenceAttempts",
        "selectedEvidence",
        "resolution",
        "clearedBy",
      ]) ||
      !isRecord(raw.mutationScope)
    ) {
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
      !isUniqueOriginKeysInOrder(
        raw.originIdempotencyKeys,
        MAX_HOLD_AUDIT_ENTRIES,
        rsid,
      ) ||
      !Array.isArray(raw.evidenceAttempts) ||
      raw.evidenceAttempts.length > MAX_HOLD_AUDIT_ENTRIES ||
      (raw.selectedEvidence !== null && !isRecord(raw.selectedEvidence)) ||
      (raw.resolution !== null && !isRecord(raw.resolution)) ||
      (raw.clearedBy !== null &&
        (typeof raw.clearedBy !== "string" ||
          !DIGEST_PATTERN.test(raw.clearedBy))) ||
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
    const state = raw.state as ValidatedLegacyHold["state"];
    const resolutionId = legacyResolutionId(raw.resolution);
    if (
      ((state === "active" || state === "evidence_recorded") &&
        resolutionId !== null) ||
      ((state === "resolved_pending_bridge" || state === "cleared") &&
        resolutionId === null) ||
      (state === "resolved_pending_bridge" && raw.clearedBy !== null) ||
      (state === "cleared" &&
        (!isRecord(raw.resolution) ||
          raw.clearedBy !== raw.resolution.authorizedDispatchIdentity))
    ) {
      throw new Error("legacy recovery resolution state is inconsistent");
    }
    return {
      holdId: raw.holdId,
      state,
      mutationScope: scope,
      originIdempotencyKeys: [...raw.originIdempotencyKeys] as string[],
      hasResolution: raw.resolution !== null,
      resolutionId,
      digestFact: {
        cleared_by: raw.clearedBy as JsonValue,
        evidence_attempts: structuredClone(raw.evidenceAttempts) as JsonValue,
        hold_id: raw.holdId,
        mutation_scope: structuredClone(scope) as unknown as JsonValue,
        origin_idempotency_keys: [...raw.originIdempotencyKeys] as string[],
        resolution: structuredClone(raw.resolution) as JsonValue,
        selected_evidence: structuredClone(raw.selectedEvidence) as JsonValue,
        state,
      },
    };
  });
  if (
    parsed.some(
      (hold, index) => index > 0 && hold.holdId <= parsed[index - 1]!.holdId,
    )
  ) {
    throw new Error("legacy recovery holds are not strictly sorted");
  }
  return parsed;
}

interface LegacyCutoverFacts {
  readonly holds: readonly ValidatedLegacyHold[];
  readonly legacyDigest: `sha256:${string}`;
  readonly importedHoldCount: number;
  readonly importedConflictCount: number;
  readonly importedResolutionCount: number;
  readonly activeScopeDigests: readonly `sha256:${string}`[];
}

function legacyPendingDigestFact(record: DurableRbpSession): JsonValue {
  if (record.pending === null) return null;
  if (
    typeof record.pending.mutating !== "boolean" ||
    !isBoundedNonEmptyString(record.pending.envelopeDigest) ||
    !DIGEST_PATTERN.test(record.pending.envelopeDigest) ||
    !isBoundedNonEmptyString(record.pending.invocationId)
  ) {
    throw new Error("legacy pending dispatch is malformed");
  }
  const entries = durablePendingMutationEntries(record)
    .map((entry) => ({
      invocation_id: entry.invocationId,
      mutation_scope_jcs: mutationScopeKey(entry.mutationScope),
      origin_idempotency_key: entry.originIdempotencyKey,
    }))
    .sort((left, right) =>
      left.origin_idempotency_key.localeCompare(right.origin_idempotency_key),
    );
  if (
    entries.some(
      (entry, index) =>
        !entry.origin_idempotency_key.startsWith(`${record.rsid}/`) ||
        (index > 0 &&
          entry.origin_idempotency_key ===
            entries[index - 1]!.origin_idempotency_key),
    )
  ) {
    throw new Error("legacy pending mutation identities are malformed");
  }
  return {
    envelope_digest: record.pending.envelopeDigest,
    invocation_id: record.pending.invocationId,
    mutating: record.pending.mutating,
    mutation_entries: entries,
  };
}

function legacyCutoverFacts(
  record: DurableRbpSession,
  holds: readonly ValidatedLegacyHold[],
): LegacyCutoverFacts {
  const activeScopeDigests = holds
    .filter((hold) => hold.state !== "cleared")
    .map((hold) => conflictScopeDigest(mutationScopeKey(hold.mutationScope)))
    .sort();
  if (
    activeScopeDigests.some(
      (scopeDigest, index) =>
        index > 0 && scopeDigest === activeScopeDigests[index - 1],
    )
  ) {
    throw new Error("legacy recovery has duplicate active conflict scopes");
  }
  const material: JsonValue = {
    holds: holds.map((hold) => hold.digestFact),
    pending: legacyPendingDigestFact(record),
    rsid: record.rsid,
  };
  return {
    holds,
    legacyDigest: digest(canonicalizeJson(material)),
    importedHoldCount: holds.length,
    importedConflictCount: holds.length,
    importedResolutionCount: holds.filter((hold) => hold.hasResolution).length,
    activeScopeDigests,
  };
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
  const allOrigins = [...new Set(entries.map((entry) => entry.originIdempotencyKey))];
  const groups = entries.some((entry) => entry.mutationScope.kind === "session")
    ? [{ mutationScope: { kind: "session" } as MutationScope, origins: allOrigins }]
    : [...new Map(entries.map((entry) => [
        mutationScopeKey(entry.mutationScope),
        entry.mutationScope,
      ])).entries()].map(([scopeJcs, mutationScope]) => ({
        mutationScope,
        origins: entries
          .filter((entry) => mutationScopeKey(entry.mutationScope) === scopeJcs)
          .map((entry) => entry.originIdempotencyKey),
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
  if (pending.mutationEntries !== undefined) {
    if (!Array.isArray(pending.mutationEntries)) {
      throw new Error("legacy pending mutation entries are malformed");
    }
    if (pending.mutationEntries.length > 0) return pending.mutationEntries;
  }
  if (!Array.isArray(pending.journalRecords)) {
    throw new Error("legacy pending journal records are malformed");
  }
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

function trustedRecoveryAdmission(
  dispatch: GatewayRecoveryPendingDispatch | null,
  envelope: InvokeEnvelope | InvokeBatchEnvelope,
  entries: readonly DurablePendingMutation[],
  envelopeDigest: `sha256:${string}`,
  mutating: boolean,
): TrustedRecoveryAdmission {
  if (dispatch === null) {
    if (envelope.payload.recovery_clearances.length !== 0) {
      throw new GatewayRbpFault(
        "protocol",
        "caller-authored recovery clearances are not dispatch authority",
        409,
        4400,
      );
    }
    return {
      dispatch: null,
      holdIds: new Set<string>(),
      originRedelivery: false,
    };
  }
  if (
    !Array.isArray(dispatch.mutationEntries) ||
    !Array.isArray(dispatch.recoveryHoldIds) ||
    !Array.isArray(dispatch.recoveryClearances)
  ) {
    throw new GatewayRbpFault(
      "protocol",
      "recovery dispatch metadata is incomplete",
      409,
      4400,
    );
  }
  const projected = dispatch.mutationEntries.map((entry) => ({
    invocationId: entry.invocationId,
    mutationScope: entry.mutationScope,
    originIdempotencyKey: entry.idempotencyKey,
  }));
  const clearanceHoldIds = envelope.payload.recovery_clearances.map(
    (clearance) => clearance.hold_id,
  );
  if (
    dispatch.envelopeDigest !== envelopeDigest ||
    dispatch.gatewaySequence !== envelope.seq ||
    !sameJson(dispatch.envelope, envelope) ||
    !sameJson(projected, entries) ||
    !sameJson(dispatch.recoveryClearances, envelope.payload.recovery_clearances) ||
    !isStrictSortedUniqueStrings(
      dispatch.recoveryHoldIds,
      MAX_HOLD_AUDIT_ENTRIES,
      (holdId) => HOLD_ID_PATTERN.test(holdId),
    ) ||
    (mutating ? dispatch.kind !== "mutation" : dispatch.kind !== "verification") ||
    (!mutating &&
      (dispatch.originRedelivery || dispatch.recoveryHoldIds.length !== 0)) ||
    (!dispatch.originRedelivery &&
      !sameJson(dispatch.recoveryHoldIds, clearanceHoldIds))
  ) {
    throw new GatewayRbpFault(
      "protocol",
      "recovery dispatch metadata is not internally authorized",
      409,
      4400,
    );
  }
  return {
    dispatch,
    holdIds: new Set(dispatch.recoveryHoldIds),
    originRedelivery: dispatch.originRedelivery,
  };
}

function liveDocumentRouteFrom(
  payload: DocContextUpdate,
  connectionId: string,
  sequence: number,
  contextDigest: string,
): DurableLiveDocumentRoute | null {
  if (!isDocumentContextDigest(contextDigest)) {
    throw new GatewayRbpFault("protocol", "document context digest is invalid", 400, 4400);
  }
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
    contextDigest,
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

function durableTerminalTruth(
  envelope: Extract<RbpEnvelope, { type: "result" | "error" }>,
): DurableTerminalTruth {
  if (envelope.type === "error") {
    return Object.freeze({
      state: "failed" as const,
      resultDigest:
        typeof envelope.payload.result_digest === "string" &&
        DIGEST_PATTERN.test(envelope.payload.result_digest)
          ? envelope.payload.result_digest as `sha256:${string}`
          : null,
      errorCode: envelope.payload.fault_class,
      payloadRetained: false,
    });
  }
  const resultDigest =
    typeof envelope.payload.result_digest === "string" &&
    DIGEST_PATTERN.test(envelope.payload.result_digest)
      ? envelope.payload.result_digest as `sha256:${string}`
      : makeParamsDigest(envelope.payload as unknown as JsonValue);
  const state = envelope.payload.status === "guarded"
    ? "guarded" as const
    : envelope.payload.status === "completed"
      ? "completed" as const
      : "failed" as const;
  return Object.freeze({
    state,
    resultDigest,
    errorCode: state === "failed" ? envelope.payload.status : null,
    payloadRetained:
      envelope.payload.kind === "invocation" &&
      envelope.payload.payload_omitted !== true &&
      envelope.payload.chunked !== true,
  });
}

function terminalCorrelationId(
  envelope: Extract<RbpEnvelope, { type: "result" | "error" }>,
): string | null {
  if (envelope.type === "error") return envelope.payload.invocation_id ?? null;
  return envelope.payload.kind === "invocation"
    ? envelope.payload.invocation_id
    : envelope.payload.batch_id;
}

/** A terminal identity is never inferred from mutable route or pending state. */
function terminalAdmissionFor(
  record: DurableRbpSession,
  connectionId: string,
  envelope: Extract<RbpEnvelope, { type: "result" | "error" }>,
): TerminalAdmission {
  const pending = record.pending;
  const correlationId = terminalCorrelationId(envelope);
  const receipt = pending?.dispatchReceipt ?? null;
  const terminalSequence = envelope.seq;
  if (
    pending === null ||
    correlationId === null ||
    pending.invocationId !== correlationId ||
    record.connectionId !== connectionId ||
    receipt === null ||
    receipt.version !== 1 ||
    receipt.tenantId !== record.tenantId ||
    receipt.invocationId !== pending.invocationId ||
    receipt.correlationId !== pending.invocationId ||
    receipt.intent !== "dispatch" ||
    !DIGEST_PATTERN.test(receipt.proofDigest) ||
    !DIGEST_PATTERN.test(receipt.routeSnapshotDigest) ||
    !Number.isSafeInteger(receipt.egressEpoch) ||
    receipt.egressEpoch < 0 ||
    !Number.isSafeInteger(receipt.leaseTicket) ||
    receipt.leaseTicket < 1 ||
    !isSafePositiveInteger(terminalSequence)
  ) {
    throw new Error("carrier terminal lacks an exact original dispatch admission");
  }
  const terminalCarrierDigest = immutableEnvelopeDigest(envelope);
  const dispatchReceiptDigest = digest(canonicalizeJson({
    domain: "revagent.gateway.dispatch-receipt/v1",
    tenantId: receipt.tenantId,
    invocationId: receipt.invocationId,
    correlationId: receipt.correlationId,
    proofDigest: receipt.proofDigest,
    routeSnapshotDigest: receipt.routeSnapshotDigest,
    egressEpoch: receipt.egressEpoch,
    leaseTicket: receipt.leaseTicket,
    intent: receipt.intent,
  } as unknown as JsonValue));
  const terminalTruth = durableTerminalTruth(envelope);
  const terminalDigest = digest(canonicalizeJson({
    domain: "revagent.gateway.terminal-persistence/v1",
    tenantId: record.tenantId,
    rsid: record.rsid,
    sessionBindingId: record.sessionBindingId,
    connectionId,
    correlationId,
    terminalSequence,
    pendingEnvelopeDigest: pending.envelopeDigest,
    pendingGatewaySequence: pending.gatewaySequence,
    dispatchReceiptDigest,
    terminalCarrierDigest,
    terminalTruth,
  } as unknown as JsonValue));
  return Object.freeze({
    tenantId: record.tenantId,
    rsid: record.rsid,
    sessionBindingId: record.sessionBindingId,
    connectionId,
    correlationId,
    terminalSequence,
    pendingEnvelopeDigest: pending.envelopeDigest,
    pendingGatewaySequence: pending.gatewaySequence,
    dispatchReceiptDigest,
    terminalCarrierDigest,
    terminalDigest,
    terminalTruth,
  });
}

function lateTerminalKey(admission: TerminalAdmission): string {
  return `${admission.rsid}:${admission.terminalDigest.slice("sha256:".length)}`;
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

function noSendAuthorityDigest(input: Omit<DurableNoSendReceipt, "authorityDigest" | "recordedAtMs"> & {
  readonly binding: BindingKind;
}): `sha256:${string}` {
  return digest(canonicalizeJson({
    domain: "revagent.gateway.no-send-authority/v1",
    ...input,
  } as unknown as JsonValue));
}

function noSendReceipt(input: {
  readonly record: DurableRbpSession;
  readonly fence: DurableEgressFence;
  readonly lease: DurableEgressLease;
  readonly recordedAtMs: number;
}): DurableNoSendReceipt {
  const pending = input.record.pending;
  const receipt = pending?.dispatchReceipt ?? null;
  if (
    pending === null ||
    receipt === null ||
    input.fence.lease === null ||
    !sameJson(input.fence.lease, input.lease) ||
    input.lease.operation !== "dispatch" ||
    input.lease.phase !== "reserved" ||
    input.lease.proofDigest === undefined ||
    input.lease.proofDigest === null ||
    input.lease.routeSnapshotDigest === undefined ||
    input.lease.routeSnapshotDigest === null ||
    pending.envelopeDigest !== input.lease.envelopeDigest ||
    receipt.version !== 1 ||
    receipt.tenantId !== input.record.tenantId ||
    receipt.invocationId !== pending.invocationId ||
    receipt.correlationId !== pending.invocationId ||
    receipt.proofDigest !== input.lease.proofDigest ||
    receipt.routeSnapshotDigest !== input.lease.routeSnapshotDigest ||
    receipt.egressEpoch !== input.fence.epoch ||
    receipt.leaseTicket !== input.lease.ticket ||
    receipt.intent !== "dispatch" ||
    pending.effectiveMcpRequestScope === undefined ||
    pending.expectedNoSendAuthorityDigest === undefined ||
    pending.expectedNoSendAuthorityDigest === null
  ) {
    throw new Error("no-send receipt lacks exact dispatch lease authority");
  }
  const scope = pending.effectiveMcpRequestScope;
  const effectiveScopeDigest = digest(canonicalizeJson(scope as unknown as JsonValue));
  const intentDigest = digest(canonicalizeJson({
    correlationId: pending.invocationId,
    envelopeDigest: pending.envelopeDigest,
    intent: receipt.intent,
    invocationId: pending.invocationId,
    scopeDigest: effectiveScopeDigest,
  }));
  const coordinates = {
    schema: "gateway.dispatch-no-send/v1",
    tenantId: input.record.tenantId,
    rsid: input.record.rsid,
    effectiveMcpSessionId: scope.effectiveMcpSessionId,
    principalKey: scope.principalKey,
    effectiveScopeDigest,
    sessionBindingId: input.record.sessionBindingId,
    acceptedConnectionId: input.record.connectionId,
    durableSessionVersion: input.record.sessionVersion,
    invocationId: pending.invocationId,
    correlationId: pending.invocationId,
    envelopeDigest: pending.envelopeDigest,
    gatewaySequence: pending.gatewaySequence,
    durableSequenceVersion: input.record.sessionVersion,
    egressEpoch: input.fence.epoch,
    leaseVersion: 1,
    leaseTicket: input.lease.ticket,
    leaseHolderInstanceId: input.lease.holderInstanceId,
    proofDigest: input.lease.proofDigest,
    routeSnapshotDigest: input.lease.routeSnapshotDigest,
    intentDigest,
    transportStarted: false,
    cumulativeAck: null,
  } as const;
  const authorityDigest = noSendAuthorityDigest({
    ...coordinates,
    binding: input.record.binding,
  });
  if (authorityDigest !== pending.expectedNoSendAuthorityDigest) {
    throw new Error("no-send receipt authority digest does not match reservation");
  }
  return Object.freeze({ ...coordinates, authorityDigest, recordedAtMs: input.recordedAtMs });
}

/**
 * A process that is resuming a session did not own a pre-existing dispatch
 * lease. A reserved lease is consequently a proved pre-invocation orphan: no
 * adapter call can have occurred before the durable promotion to `started`.
 * A started lease is the opposite. It remains fenced and is classified
 * fail-closed below; it is never handed to the generic retransmit outbox.
 */
function orphanReservedNoSendEvidence(input: {
  readonly tenantId: string;
  readonly record: DurableRbpSession;
  readonly lease: DurableEgressLease;
  readonly nowMs: number;
}): DurableDispatchEvidence | null {
  const pending = input.record.pending;
  if (
    pending === null ||
    input.lease.operation !== "dispatch" ||
    input.lease.phase !== "reserved" ||
    pending.envelopeDigest !== input.lease.envelopeDigest
  ) {
    return null;
  }
  const journals = pending.journalRecords.map((journal) =>
    handleJournalSessionUnregister(journal, true, null).record,
  );
  if (journals.length === 0) return null;
  const existing = input.record.evidence.find(
    (candidate) => candidate.envelopeDigest === pending.envelopeDigest,
  );
  return {
    envelopeDigest: pending.envelopeDigest,
    acceptance: null,
    journal: {
      kind: "known_terminal",
      rsid: input.record.rsid,
      sessionBindingId: input.record.sessionBindingId,
      envelopeDigest: pending.envelopeDigest,
      journalRecords: journals,
      batchTerminal: null,
      durableJournalVersion: input.record.sessionVersion,
      recordedAtMs: input.nowMs,
    },
    terminalTruth: existing?.terminalTruth ?? null,
    noSendAuthorityDigest: pending.expectedNoSendAuthorityDigest ?? null,
    noSendReceipt: noSendReceipt({
      record: input.record,
      fence: sessionEgressFence(input.record),
      lease: input.lease,
      recordedAtMs: input.nowMs,
    }),
  };
}

function sessionV2EvidenceChildren(record: DurableRbpSession): readonly {
  readonly key: string;
  readonly value: DurableSessionV2EvidenceChild;
  readonly ref: DurableSessionV2ChildRef;
}[] {
  return record.evidence.map((entry) => {
    const invocationId = entry.journal?.journalRecords[0]?.binding.invocationId ?? entry.envelopeDigest;
    const key = `${record.rsid}/${invocationId}`;
    const value: DurableSessionV2EvidenceChild = {
      schema: GATEWAY_RBP_SESSION_V2_EVIDENCE_NAMESPACE,
      tenantId: record.tenantId,
      rsid: record.rsid,
      invocationId,
      entry,
    };
    return { key, value, ref: { namespace: GATEWAY_RBP_SESSION_V2_EVIDENCE_NAMESPACE, key, version: 0, digest: digest(canonicalizeJson(value as unknown as JsonValue)) } };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

/** Marker-gated normalized session repository. v1 is a serving source only
 * until the v2 marker commits; it is never read after that point. */
class SessionAggregateRepository {
  public constructor(private readonly backing: GatewayProtocolStore) {}
  public get kind(): GatewayProtocolStore["kind"] { return this.backing.kind; }
  public get contractVersion(): typeof this.backing.contractVersion { return this.backing.contractVersion; }
  public get startupCoordinator(): GatewayProtocolStore["startupCoordinator"] { return this.backing.startupCoordinator; }
  public open(): Promise<StoreOutcome<void>> { return this.backing.open(); }
  public close(): Promise<StoreOutcome<void>> { return this.backing.close(); }

  /** Read-only authority seam for recovery transactions. Tombstone is always
   * checked before the marker; a valid marker makes any v1 read unreachable. */
  public async readAuthoritative(
    tx: Pick<StoreTransaction, "read" | "list">,
    tenantId: string,
    rsid: string,
  ): Promise<StoredRecord<GatewayJsonValue> | null> {
    const tombstone = await tx.read<GatewayJsonValue>(GATEWAY_RBP_UNREGISTER_NAMESPACE, rsid);
    if (tombstone !== null) parseUnregisterTombstone(tombstone.value, { tenantId, rsid, stored: tombstone });
    const marker = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE, rsid);
    if (marker === null) {
      // A pre-marker migration may have committed a bounded child batch.  Such
      // children are a union-deny fence, never a reason to serve the old row.
      const migration = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE, rsid);
      if (migration !== null) {
        parseSessionMigrationPlan(migration, tenantId, rsid);
        throw new Error("legacy session migration is not yet cut over");
      }
      return await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid);
    }
    const parsedMarker = parseSessionCutoverV2(marker, tenantId, rsid);
    const root = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_V2_NAMESPACE, rsid);
    if (root === null) throw new Error("v2 session marker has no root");
    return await this.#loadMarked(tx, root, parsedMarker, tenantId, rsid);
  }

  public async transact<T>(
    scope: { readonly tenantId: string },
    work: (tx: StoreTransaction) => Promise<T> | T,
    options: { readonly allowUnmarkedMigration?: boolean } = {},
  ): Promise<StoreOutcome<T>> {
    return this.backing.transact(scope, async (raw) => {
      const staged = new Map<string, { readonly value: GatewayJsonValue | null; readonly expect: StoreExpectation }>();
      const loaded = new Map<string, StoredRecord<GatewayJsonValue> | null>();
      const overlay = new Map<string, { readonly value: GatewayJsonValue | null }>();
      let rawStageCount = 0;
      const overlayKey = (namespace: string, key: string) => `${namespace}\u0000${key}`;
      const stageRaw = (write: { readonly namespace: string; readonly key: string; readonly value: GatewayJsonValue | null; readonly expect: StoreExpectation }): void => {
        rawStageCount += 1;
        raw.stage(write);
      };
      const readOverlay = async <TValue extends GatewayJsonValue>(namespace: string, key: string): Promise<StoredRecord<TValue> | null> => {
        const stagedValue = overlay.get(overlayKey(namespace, key));
        if (stagedValue !== undefined) {
          if (stagedValue.value === null) return null;
          const current = await raw.read<TValue>(namespace, key);
          return { namespace, tenantId: scope.tenantId, key, value: stagedValue.value as TValue, version: (current?.version ?? 0) + 1, updatedAtMs: current?.updatedAtMs ?? 0 };
        }
        return await raw.read<TValue>(namespace, key);
      };
      const normalizedRaw: StoreTransaction = {
        read: readOverlay,
        list: async (namespace) => await raw.list(namespace),
        stage: stageRaw,
      };
      const load = async (rsid: string): Promise<StoredRecord<GatewayJsonValue> | null> => {
        if (loaded.has(rsid)) return loaded.get(rsid) ?? null;
        const authoritative = options.allowUnmarkedMigration === true
          ? await raw.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid)
          : await this.readAuthoritative(raw, scope.tenantId, rsid);
        loaded.set(rsid, authoritative);
        return authoritative;
      };
      const tx: StoreTransaction = {
        read: async <TValue extends GatewayJsonValue>(namespace: string, key: string) =>
          namespace === GATEWAY_RBP_SESSION_NAMESPACE
            ? await load(key) as StoredRecord<TValue> | null
            : await readOverlay<TValue>(namespace, key),
        list: async (namespace: string) => {
          if (namespace !== GATEWAY_RBP_SESSION_NAMESPACE) return await raw.list(namespace);
          const [legacy, markers] = await Promise.all([
            raw.list(GATEWAY_RBP_SESSION_NAMESPACE), raw.list(GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE),
          ]);
          const marked = await Promise.all(markers.map(async (marker) => await load(marker.key)));
          const markedKeys = new Set(markers.map((marker) => marker.key));
          return [...legacy.filter((row) => !markedKeys.has(row.key)), ...marked.filter((row): row is StoredRecord<GatewayJsonValue> => row !== null)]
            .sort((a, b) => a.key.localeCompare(b.key));
        },
        stage: (write) => {
          if (write.namespace === GATEWAY_RBP_SESSION_NAMESPACE) staged.set(write.key, { value: write.value, expect: write.expect });
          else {
            overlay.set(overlayKey(write.namespace, write.key), { value: write.value });
            stageRaw(write);
          }
        },
      };
      const value = await work(tx);
      for (const [rsid, stage] of staged) {
        await this.#stageNormalized(normalizedRaw, scope.tenantId, rsid, stage, await load(rsid), rawStageCount);
      }
      return value;
    });
  }

  /**
   * Carrier Tx-B/Tx-C begins on the resource authority's shared raw store.
   * Normalize the session aggregate inside that same transaction so receipt,
   * acknowledgement, and inbound sequence can never commit independently.
   */
  public async stageAuthoritativeOnRaw(
    raw: StoreTransaction,
    tenantId: string,
    rsid: string,
    mutate: (stored: StoredRecord<GatewayJsonValue>, record: DurableRbpSession) => DurableRbpSession,
  ): Promise<DurableRbpSession> {
    const stored = await this.readAuthoritative(raw, tenantId, rsid);
    if (stored === null) throw new Error("carrier session is missing");
    const record = parseStoredSession(stored, tenantId, rsid);
    const next = mutate(stored, record);
    await this.#stageNormalized(
      raw,
      tenantId,
      rsid,
      { value: asJson(next), expect: { kind: "version", version: stored.version } },
      stored,
      0,
    );
    return next;
  }

  async #stageNormalized(raw: StoreTransaction, tenantId: string, rsid: string, stage: { readonly value: GatewayJsonValue | null; readonly expect: StoreExpectation }, existing: StoredRecord<GatewayJsonValue> | null, priorStageCount: number): Promise<void> {
    if (stage.value === null) throw new Error("normalized session roots are retained; unregister is tombstone authority");
    const record = parseStoredSession({ namespace: GATEWAY_RBP_SESSION_NAMESPACE, tenantId, key: rsid, value: stage.value, version: Number.MAX_SAFE_INTEGER, updatedAtMs: 0 }, tenantId, rsid);
    const currentRoot = await raw.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_V2_NAMESPACE, rsid);
    const marker = await raw.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE, rsid);
    if (marker !== null) parseSessionCutoverV2(marker, tenantId, rsid);
    // An unmarked v2 row is staging debris, never authority.  It may be an
    // older rejected facade and is overwritten atomically by the migration.
    const priorRoot = marker === null || currentRoot === null
      ? null
      : this.#parseRoot(currentRoot, tenantId, rsid);
    const children = await this.#childrenFor(raw, record);
    const priorOwned = priorRoot?.childRefs.filter((ref) => this.#isOwned(ref.namespace)) ?? [];
    const nextOwned = new Map(children.owned.map((child) => [this.#refId(child.ref), child]));
    const staleOwned = priorOwned.filter((prior) => !nextOwned.has(this.#refId(prior)));
    for (const prior of priorOwned) {
      if (!nextOwned.has(this.#refId(prior))) {
        const current = await raw.read<GatewayJsonValue>(prior.namespace, prior.key);
        if (current === null) throw new Error("stale normalized child is already missing");
        raw.stage({ namespace: prior.namespace, key: prior.key, value: null, expect: { kind: "version", version: current.version } });
      }
    }
    for (const child of children.owned) {
      const previous = await raw.read<GatewayJsonValue>(child.ref.namespace, child.ref.key);
      raw.stage({ namespace: child.ref.namespace, key: child.ref.key, value: child.value, expect: previous === null ? { kind: "absent" } : { kind: "version", version: previous.version } });
    }
    const legacySource = marker === null
      ? await raw.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid)
      : null;
    const legacyRecovery = marker === null
      ? await raw.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, rsid)
      : null;
    const holdMarker = await raw.read<GatewayJsonValue>(GATEWAY_HOLD_CUTOVER_NAMESPACE, rsid);
    const plannedWrites = priorStageCount + children.owned.length + staleOwned.length + 2 +
      (holdMarker === null ? 1 : 0) + (legacySource === null ? 0 : 1) +
      (legacyRecovery === null ? 0 : 1);
    if (plannedWrites > PROTOCOL_STORE_TRANSACTION_WRITE_LIMIT) {
      throw new Error("normalized session write plan exceeds the durable transaction limit");
    }
    const legacyFacts = legacySource === null
      ? null
      : legacyCutoverFacts(
          parseStoredSession(legacySource, tenantId, rsid),
          legacyRecovery === null ? [] : parseLegacyRecoveryHolds(legacyRecovery.value, rsid),
        );
    const migration = priorRoot?.migration ?? {
      sourceVersionDigest: legacySource === null
        ? digest(canonicalizeJson({ source: "no_legacy_session", tenantId, rsid } as unknown as JsonValue))
        : digest(canonicalizeJson({ version: legacySource.version, value: legacySource.value } as unknown as JsonValue)),
      legacyDigest: legacyFacts === null
        ? digest(canonicalizeJson({ source: "no_legacy_session", tenantId, rsid } as unknown as JsonValue))
        : legacyFacts.legacyDigest,
      counts: legacyFacts === null
        ? { holds: 0, conflicts: 0, resolutions: 0 }
        : {
            holds: legacyFacts.importedHoldCount,
            conflicts: legacyFacts.importedConflictCount,
            resolutions: legacyFacts.importedResolutionCount,
          },
      deletionReceipt: legacySource === null
        ? { state: "retained" as const, verifiedAtMs: null }
        : { state: "deleted" as const, verifiedAtMs: record.updatedAtMs },
    };
    const rootVersion = priorRoot === null ? 1 : priorRoot.rootVersion + 1;
    const root = this.#rootFor(record, migration, children.refs, rootVersion);
    raw.stage({ namespace: GATEWAY_RBP_SESSION_V2_NAMESPACE, key: rsid, value: asJson(root), expect: currentRoot === null ? { kind: "absent" } : { kind: "version", version: currentRoot.version } });
    // This older marker remains exclusively a proof that legacy recovery holds
    // were normalized. It is not, and is never consulted as, session authority.
    if (holdMarker === null && migration.counts.holds > 0) {
      const nowMs = record.updatedAtMs;
      const holdCutover: DurableHoldCutover = {
        schema: GATEWAY_HOLD_CUTOVER_NAMESPACE, tenantId, rsid,
        createdAtMs: nowMs, updatedAtMs: nowMs, recordVersion: 1,
        legacyDigest: migration.legacyDigest, importedHoldCount: migration.counts.holds,
        importedConflictCount: migration.counts.conflicts, importedResolutionCount: migration.counts.resolutions,
        targetGeneration: "normalized-v1", state: "normalized_authoritative", cutoverAtMs: nowMs,
      };
      raw.stage({ namespace: GATEWAY_HOLD_CUTOVER_NAMESPACE, key: rsid, value: asJson(holdCutover), expect: { kind: "absent" } });
    }
    // A legacy source is removed only together with its normalized root and
    // receipt. The final unregister tombstone is deliberately outside this
    // cleanup and remains independently durable.
    if (legacySource !== null) raw.stage({ namespace: GATEWAY_RBP_SESSION_NAMESPACE, key: rsid, value: null, expect: { kind: "version", version: legacySource.version } });
    if (legacyRecovery !== null) raw.stage({ namespace: GATEWAY_RECOVERY_NAMESPACE, key: rsid, value: null, expect: { kind: "version", version: legacyRecovery.version } });
    const cutover: DurableSessionCutoverV2 = {
      schema: GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE, generation: 2, tenantId, rsid,
      sourceLegacyDigest: migration.legacyDigest, rootVersion,
      rootDigest: digest(canonicalizeJson(root as unknown as JsonValue)), childrenDigest: root.childrenDigest,
      migratedAtMs: record.updatedAtMs,
    };
    // Marker is the last staged write: partial v2 rows can never become authority.
    raw.stage({ namespace: GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE, key: rsid, value: asJson(cutover), expect: marker === null ? { kind: "absent" } : { kind: "version", version: marker.version } });
  }

  #isOwned(namespace: string): boolean {
    return namespace === GATEWAY_RBP_SESSION_V2_EVIDENCE_NAMESPACE || namespace === GATEWAY_RBP_SESSION_V2_EGRESS_NAMESPACE || namespace === GATEWAY_RBP_SESSION_V2_CONFLICT_INDEX_NAMESPACE;
  }
  #refId(ref: DurableSessionV2ChildRef): string { return `${ref.namespace}\u0000${ref.key}`; }
  #ref(stored: StoredRecord<GatewayJsonValue>): DurableSessionV2ChildRef {
    return { namespace: stored.namespace, key: stored.key, version: stored.version, digest: digest(canonicalizeJson(stored.value as JsonValue)) };
  }
  #owned(namespace: string, key: string, value: GatewayJsonValue): { readonly ref: DurableSessionV2ChildRef; readonly value: GatewayJsonValue } {
    return { ref: { namespace, key, version: 0, digest: digest(canonicalizeJson(value as JsonValue)) }, value };
  }

  async #childrenFor(raw: StoreTransaction, record: DurableRbpSession): Promise<{ readonly refs: readonly DurableSessionV2ChildRef[]; readonly owned: readonly { readonly ref: DurableSessionV2ChildRef; readonly value: GatewayJsonValue }[] }> {
    const owned: { readonly ref: DurableSessionV2ChildRef; readonly value: GatewayJsonValue }[] = [];
    for (const child of sessionV2EvidenceChildren(record)) owned.push(this.#owned(child.ref.namespace, child.ref.key, asJson(child.value)));
    const egress: DurableSessionV2EgressChild = { schema: GATEWAY_RBP_SESSION_V2_EGRESS_NAMESPACE, tenantId: record.tenantId, rsid: record.rsid, fence: sessionEgressFence(record) };
    const index: DurableSessionV2ConflictIndexChild = { schema: GATEWAY_RBP_SESSION_V2_CONFLICT_INDEX_NAMESPACE, tenantId: record.tenantId, rsid: record.rsid, index: sessionConflictIndex(record) };
    owned.push(this.#owned(GATEWAY_RBP_SESSION_V2_EGRESS_NAMESPACE, `${record.rsid}/egress`, asJson(egress)));
    owned.push(this.#owned(GATEWAY_RBP_SESSION_V2_CONFLICT_INDEX_NAMESPACE, `${record.rsid}/conflict-index`, asJson(index)));
    const versionedOwned = await Promise.all(owned.map(async (child) => {
      const current = await raw.read<GatewayJsonValue>(child.ref.namespace, child.ref.key);
      return {
        ...child,
        ref: { ...child.ref, version: current === null ? 1 : current.version + 1 },
      };
    }));
    const refs: DurableSessionV2ChildRef[] = versionedOwned.map((child) => child.ref);
    // Tombstone is always probed first; its exact digest/version becomes part of the root proof.
    const tombstone = await raw.read<GatewayJsonValue>(GATEWAY_RBP_UNREGISTER_NAMESPACE, record.rsid);
    if (tombstone !== null) refs.push(this.#ref(tombstone));
    for (const scopeDigest of sessionConflictIndex(record).scopeDigests) {
      const conflict = await raw.read<GatewayJsonValue>(GATEWAY_MUTATION_CONFLICT_NAMESPACE, conflictRecordKey(record.rsid, scopeDigest));
      // The WP-02 companion pair can be staged later in this same atomic
      // transaction.  Do not manufacture a reference before it is visible;
      // the next committed root must contain the exact pair and load-time
      // admission still fails closed if an indexed pair is absent.
      if (conflict === null) continue;
      refs.push(this.#ref(conflict));
      const parsed = parseMutationConflict(conflict, record.tenantId, record.rsid);
      const hold = await raw.read<GatewayJsonValue>(GATEWAY_MUTATION_HOLD_NAMESPACE, parsed.conflict.holdId);
      if (hold === null) throw new Error("normalized conflict references a missing hold");
      parseMutationHold(hold, record.tenantId, record.rsid);
      refs.push(this.#ref(hold));
    }
    return { refs: refs.sort((a, b) => this.#refId(a).localeCompare(this.#refId(b))), owned: versionedOwned };
  }

  #rootFor(record: DurableRbpSession, migration: DurableRbpSessionV2["migration"], refs: readonly DurableSessionV2ChildRef[], rootVersion: number): DurableRbpSessionV2 {
    const childRefs = [...refs].sort((a, b) => this.#refId(a).localeCompare(this.#refId(b)));
    return {
      schema: GATEWAY_RBP_SESSION_V2_NAMESPACE, generation: 2, rootVersion, tenantId: record.tenantId, rsid: record.rsid,
      identity: { userId: record.userId, deviceId: record.deviceId, seatId: record.seatId, identityAuthority: record.identityAuthority },
      binding: { sessionBindingId: record.sessionBindingId, sessionVersion: record.sessionVersion, connectionId: record.connectionId, binding: record.binding, resumeTokenDigest: record.resumeTokenDigest, resumeExpiresAtMs: record.resumeExpiresAtMs, grantedCapabilities: record.grantedCapabilities },
      lifecycle: { connectionLifecycle: record.connectionLifecycle, sessionLifecycle: record.sessionLifecycle, lastHeartbeatAtMs: record.lastHeartbeatAtMs, liveDocumentRoute: record.liveDocumentRoute, recordVersion: record.recordVersion, createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs },
      sequence: { sequence: record.sequence, pending: record.pending }, migration, childRefs,
      childrenDigest: digest(canonicalizeJson(childRefs as unknown as JsonValue)),
    };
  }

  #parseRoot(stored: StoredRecord<GatewayJsonValue>, tenantId: string, rsid: string): DurableRbpSessionV2 {
    if (stored.namespace !== GATEWAY_RBP_SESSION_V2_NAMESPACE || stored.tenantId !== tenantId || stored.key !== rsid || !isRecord(stored.value)) throw new Error("malformed v2 session root identity");
    const root = stored.value as unknown as DurableRbpSessionV2;
    if (!hasExactKeys(stored.value, [
      "schema", "generation", "rootVersion", "tenantId", "rsid", "identity", "binding",
      "lifecycle", "sequence", "migration", "childRefs", "childrenDigest",
    ]) || root.schema !== GATEWAY_RBP_SESSION_V2_NAMESPACE || root.generation !== 2 || !isSafePositiveInteger(root.rootVersion) || root.tenantId !== tenantId || root.rsid !== rsid || !isRecord(root.identity) || !isRecord(root.binding) || !isRecord(root.lifecycle) || !isRecord(root.sequence) || !isRecord(root.migration) || !Array.isArray(root.childRefs) || root.childrenDigest !== digest(canonicalizeJson(root.childRefs as unknown as JsonValue))) throw new Error("malformed normalized v2 session root");
    const migration = root.migration;
    if (!hasExactKeys(migration, ["sourceVersionDigest", "legacyDigest", "counts", "deletionReceipt"]) ||
      typeof migration.sourceVersionDigest !== "string" || !DIGEST_PATTERN.test(migration.sourceVersionDigest) ||
      typeof migration.legacyDigest !== "string" || !DIGEST_PATTERN.test(migration.legacyDigest) ||
      !isRecord(migration.counts) || !hasExactKeys(migration.counts, ["holds", "conflicts", "resolutions"]) ||
      !isSafeNonNegativeInteger(migration.counts.holds) || !isSafeNonNegativeInteger(migration.counts.conflicts) || !isSafeNonNegativeInteger(migration.counts.resolutions) ||
      !isRecord(migration.deletionReceipt) || !hasExactKeys(migration.deletionReceipt, ["state", "verifiedAtMs"]) ||
      (migration.deletionReceipt.state !== "retained" && migration.deletionReceipt.state !== "deleted") ||
      !(migration.deletionReceipt.verifiedAtMs === null || isSafeNonNegativeInteger(migration.deletionReceipt.verifiedAtMs)) ||
      (migration.deletionReceipt.state === "retained" && migration.deletionReceipt.verifiedAtMs !== null) ||
      (migration.deletionReceipt.state === "deleted" && !isSafeNonNegativeInteger(migration.deletionReceipt.verifiedAtMs))
    ) throw new Error("malformed normalized v2 migration proof");
    const sorted = [...root.childRefs].sort((a, b) => this.#refId(a).localeCompare(this.#refId(b)));
    if (!sameJson(sorted as unknown as JsonValue, root.childRefs as unknown as JsonValue) || root.childRefs.some((ref) => !isRecord(ref) || typeof ref.namespace !== "string" || typeof ref.key !== "string" || !DIGEST_PATTERN.test(String(ref.digest)) || !isSafeNonNegativeInteger(ref.version))) throw new Error("malformed v2 child references");
    return root;
  }

  async #loadMarked(raw: Pick<StoreTransaction, "read" | "list">, stored: StoredRecord<GatewayJsonValue>, marker: DurableSessionCutoverV2, tenantId: string, rsid: string): Promise<StoredRecord<GatewayJsonValue>> {
    const root = this.#parseRoot(stored, tenantId, rsid);
    if (root.rootVersion !== marker.rootVersion || digest(canonicalizeJson(stored.value as JsonValue)) !== marker.rootDigest || root.childrenDigest !== marker.childrenDigest) throw new Error("v2 marker proof does not match root");
    if (root.migration.deletionReceipt.state === "deleted") {
      const [legacy, recovery] = await Promise.all([
        raw.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid),
        raw.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, rsid),
      ]);
      if (legacy !== null || recovery !== null) throw new Error("v2 deletion receipt disagrees with legacy source");
    }
    // Authority is the marker-indexed manifest only. An unindexed row cannot
    // grant or alter authority and is left for bounded maintenance GC; this
    // avoids a tenant-wide list during dispatch/unregister hot paths.
    const values = new Map<string, StoredRecord<GatewayJsonValue>>();
    // Tombstone is read before all other refs to preserve unregister authority ordering.
    const tombstoneRef = root.childRefs.find((ref) => ref.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE);
    if (tombstoneRef !== undefined) {
      const tombstone = await raw.read<GatewayJsonValue>(tombstoneRef.namespace, tombstoneRef.key);
      if (tombstone === null) throw new Error("v2 session tombstone reference is missing");
      values.set(this.#refId(tombstoneRef), tombstone);
    }
    for (const ref of root.childRefs) {
      if (values.has(this.#refId(ref))) continue;
      const child = await raw.read<GatewayJsonValue>(ref.namespace, ref.key);
      if (child === null) throw new Error("v2 session child is missing");
      values.set(this.#refId(ref), child);
    }
    for (const ref of root.childRefs) {
      const child = values.get(this.#refId(ref))!;
      if (child.namespace !== ref.namespace || child.tenantId !== tenantId || child.key !== ref.key || child.version !== ref.version || digest(canonicalizeJson(child.value as JsonValue)) !== ref.digest) throw new Error("v2 session child proof is stale or corrupt");
    }
    const evidence: DurableDispatchEvidence[] = [];
    let fence: DurableEgressFence | undefined;
    let index: DurableNormalizedConflictIndex | undefined;
    for (const ref of root.childRefs) {
      const child = values.get(this.#refId(ref))!;
      if (!isRecord(child.value)) throw new Error("malformed v2 session child");
      if (ref.namespace === GATEWAY_RBP_SESSION_V2_EVIDENCE_NAMESPACE) {
        const value = child.value as unknown as DurableSessionV2EvidenceChild;
        if (value.schema !== GATEWAY_RBP_SESSION_V2_EVIDENCE_NAMESPACE || value.tenantId !== tenantId || value.rsid !== rsid || typeof value.invocationId !== "string") throw new Error("malformed v2 evidence child");
        evidence.push(value.entry);
      } else if (ref.namespace === GATEWAY_RBP_SESSION_V2_EGRESS_NAMESPACE) {
        const value = child.value as unknown as DurableSessionV2EgressChild;
        if (value.schema !== GATEWAY_RBP_SESSION_V2_EGRESS_NAMESPACE || value.tenantId !== tenantId || value.rsid !== rsid) throw new Error("malformed v2 egress child");
        fence = value.fence;
      } else if (ref.namespace === GATEWAY_RBP_SESSION_V2_CONFLICT_INDEX_NAMESPACE) {
        const value = child.value as unknown as DurableSessionV2ConflictIndexChild;
        if (value.schema !== GATEWAY_RBP_SESSION_V2_CONFLICT_INDEX_NAMESPACE || value.tenantId !== tenantId || value.rsid !== rsid) throw new Error("malformed v2 conflict index child");
        index = value.index;
      }
    }
    if (fence === undefined || index === undefined) throw new Error("v2 session mandatory child is missing");
    const record: DurableRbpSession = {
      schema: GATEWAY_RBP_SESSION_NAMESPACE, tenantId, rsid, ...root.identity, ...root.binding, ...root.lifecycle, ...root.sequence,
      evidence: evidence.sort((a, b) => a.envelopeDigest.localeCompare(b.envelopeDigest)), egressFence: fence, normalizedConflictIndex: index,
    };
    const parsed = parseStoredSession({ namespace: GATEWAY_RBP_SESSION_NAMESPACE, tenantId, key: rsid, value: asJson(record), version: stored.version, updatedAtMs: stored.updatedAtMs }, tenantId, rsid);
    return { namespace: GATEWAY_RBP_SESSION_NAMESPACE, tenantId, key: rsid, value: asJson(parsed), version: stored.version, updatedAtMs: stored.updatedAtMs };
  }
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
  readonly #rsidCarrierReceiveTailBytes = new Map<string, number>();
  readonly #carrierReceiveTailObserver: CarrierReceiveTailObserver | undefined;
  readonly #documentContextObserver: GatewayDocumentContextObserver | undefined;
  readonly #sessionAuthorizationTails = new Map<string, Promise<void>>();
  readonly #tenantIdentityTails = new Map<string, Promise<void>>();
  readonly #tenantRevocationTails = new Map<string, Promise<void>>();
  readonly #tenantBlockGenerations = new Map<string, number>();
  readonly #blockedTenants = new Set<string>();
  readonly #deviceAuthorityFences = new Map<string, DeviceAuthorityFence>();
  readonly #seatAuthorityFences = new Map<string, SeatAuthorityFence>();
  readonly #seatReassignmentOperations = new Map<
    string,
    SeatReassignmentOperation
  >();
  readonly #seatReassignmentAttempts = new Map<
    string,
    SeatReassignmentAttemptState
  >();
  readonly #inFlightSeatReassignments = new Map<
    string,
    SeatReassignmentTask
  >();
  readonly #seatReassignmentDrains = new Set<Promise<void>>();
  readonly #seatReassignmentDrainTasks = new Set<SeatReassignmentTask>();
  readonly #revokedConnectionIds = new Set<string>();
  readonly #knownTenants = new Set<string>();
  readonly #tenantIdentitySnapshots = new Map<string, TenantIdentitySnapshot>();
  readonly #deviceConnections = new Map<string, Set<string>>();
  readonly #seatConnections = new Map<string, Set<string>>();
  readonly #deviceSessions = new Map<string, Set<string>>();
  readonly #seatSessions = new Map<string, Set<string>>();
  readonly #sessionRepository: SessionAggregateRepository;
  readonly #resourceAuthority: GatewayResourceAuthority | undefined;
  readonly #productionIdentity: ProductionIdentityAuthority | null;
  readonly #clock: () => number;
  readonly #instanceId: string;
  /** Private per-process authority; no proof object leaves this class. */
  readonly #dispatchProofAuthority = createGatewayDispatchProofAuthority();
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #maxActiveSeatReassignments: number;
  readonly #seatReassignmentTimeoutMs: number;
  readonly #seatReassignmentCloseDrainTimeoutMs: number;
  #lifecycleState: BridgeLifecycleState = "closed";
  #lifecycleGeneration = 0;
  #closeDrainTimedOut = false;
  #protocolStoreState: BridgeLifecycleResourceState = "closed";
  #identityState: BridgeLifecycleResourceState = "closed";
  #protocolStoreManagedBy: "bridge" | "identity" = "bridge";
  #openPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;
  #startupReadiness = false;

  public constructor(
    readonly store: GatewayProtocolStore,
    readonly identity: IdentityPort,
    options: {
      readonly clock?: () => number;
      readonly instanceId?: string;
      readonly wait?: (milliseconds: number) => Promise<void>;
      readonly maxActiveSeatReassignments?: number;
      readonly seatReassignmentTimeoutMs?: number;
      readonly seatReassignmentCloseDrainTimeoutMs?: number;
      /** Optional until a composition has proved one shared store/object store. */
      readonly resourceAuthority?: GatewayResourceAuthority;
      /** Value-free diagnostic only; never participates in route authority. */
      readonly onDocumentContextObservation?: GatewayDocumentContextObserver;
    } = {},
  ) {
    this.#sessionRepository = new SessionAggregateRepository(store);
    this.#resourceAuthority = options.resourceAuthority;
    const carrierTailObserver = Object.getOwnPropertyDescriptor(
      options,
      TEST_RSID_CARRIER_RECEIVE_TAIL_OBSERVER,
    )?.value;
    this.#carrierReceiveTailObserver =
      typeof carrierTailObserver === "function" ? carrierTailObserver : undefined;
    this.#documentContextObserver = options.onDocumentContextObservation;
    this.#productionIdentity = asProductionIdentityAuthority(identity);
    this.#clock = options.clock ?? Date.now;
    this.#instanceId = options.instanceId ?? gatewayUuidV7(this.#clock());
    if (!isGatewayUuidV7(this.#instanceId)) {
      throw new TypeError("Gateway instanceId must be a UUIDv7");
    }
    this.#wait = options.wait ?? (async (milliseconds) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    });
    this.#maxActiveSeatReassignments =
      options.maxActiveSeatReassignments ??
      DEFAULT_MAX_ACTIVE_SEAT_REASSIGNMENTS;
    this.#seatReassignmentTimeoutMs =
      options.seatReassignmentTimeoutMs ??
      DEFAULT_SEAT_REASSIGNMENT_TIMEOUT_MS;
    this.#seatReassignmentCloseDrainTimeoutMs =
      options.seatReassignmentCloseDrainTimeoutMs ??
      DEFAULT_SEAT_REASSIGNMENT_CLOSE_DRAIN_TIMEOUT_MS;
    if (
      !isSafePositiveInteger(this.#maxActiveSeatReassignments) ||
      this.#maxActiveSeatReassignments >
        MAX_CONFIGURED_ACTIVE_SEAT_REASSIGNMENTS
    ) {
      throw new TypeError(
        "maxActiveSeatReassignments must be a bounded positive integer",
      );
    }
    if (
      !isSafePositiveInteger(this.#seatReassignmentTimeoutMs) ||
      this.#seatReassignmentTimeoutMs > MAX_SEAT_REASSIGNMENT_TIMEOUT_MS
    ) {
      throw new TypeError(
        "seatReassignmentTimeoutMs must be a bounded positive integer",
      );
    }
    if (
      !isSafePositiveInteger(this.#seatReassignmentCloseDrainTimeoutMs) ||
      this.#seatReassignmentCloseDrainTimeoutMs >
        MAX_SEAT_REASSIGNMENT_CLOSE_DRAIN_TIMEOUT_MS
    ) {
      throw new TypeError(
        "seatReassignmentCloseDrainTimeoutMs must be a bounded positive integer",
      );
    }
  }

  #carrierReady(): boolean {
    return this.#resourceAuthority?.isBridgeCarrierReady(this.store) === true;
  }

  /**
   * Composition-only identity check.  Carrier capabilities must be backed by
   * the one protocol/object-store pair installed in the host, never merely by
   * a similarly configured authority.
   */
  public hasExactCarrierComposition(
    resourceAuthority: GatewayResourceAuthority,
    objectStore: ObjectStorePort,
  ): boolean {
    return this.#resourceAuthority === resourceAuthority &&
      resourceAuthority.isBridgeCarrierReady(this.store, objectStore);
  }

  #carrierScope(record: DurableRbpSession): {
    readonly scope: GatewayResourceScope;
    readonly effective: EffectiveMcpRequestScopeV1;
  } {
    const persisted = record.pending?.effectiveMcpRequestScope;
    if (persisted === undefined) {
      throw new GatewayRbpFault("protocol", "carrier lacks an effective MCP request scope", 400, 4400);
    }
    // Structured persistence deliberately strips object freezing. Rehydrate the
    // exact four-field ingress carrier before presenting it to the resource
    // authority; a mutable recovered record is never authority evidence.
    const effective = Object.freeze({
      contractVersion: persisted.contractVersion,
      principalKey: persisted.principalKey,
      effectiveMcpSessionId: persisted.effectiveMcpSessionId,
      transportMcpSessionId: persisted.transportMcpSessionId,
      identityMcpSessionId: persisted.identityMcpSessionId,
    }) as EffectiveMcpRequestScopeV1;
    return {
      scope: Object.freeze({
        tenantId: record.tenantId,
        actorId: record.userId,
        principalKey: effective.principalKey,
        mcpSessionId: effective.effectiveMcpSessionId,
      }),
      effective,
    };
  }

  public lifecycle(): GatewayBridgeSessionLifecycleSnapshot {
    return Object.freeze({
      state: this.#lifecycleState,
      protocolStore: this.#protocolStoreState,
      identity: this.#identityState,
      protocolStoreManagedBy: this.#protocolStoreManagedBy,
    });
  }

  /** Value-free live ownership evidence for bounded lifecycle oracles. */
  public liveCardinality(): Readonly<{ connections: number; sessions: number }> {
    return Object.freeze({
      connections: this.#connections.size,
      sessions: this.#active.size,
    });
  }

  public open(): Promise<void> {
    if (this.#lifecycleState === "open") return Promise.resolve();
    if (this.#closeDrainTimedOut) {
      return Promise.reject(
        new GatewayRbpFault(
          "unavailable",
          "Gateway close must be retried after reassignment cleanup drains",
          503,
          1011,
        ),
      );
    }
    if (this.#openPromise !== null) return this.#openPromise;
    if (this.#closePromise !== null) {
      return this.#closePromise.then(() => this.open());
    }
    this.#openPromise = this.#performOpen().finally(() => {
      this.#openPromise = null;
    });
    return this.#openPromise;
  }

  async #callLifecycle(
    action: () => Promise<StoreOutcome<void>>,
  ): Promise<StoreOutcome<void>> {
    try {
      return await action();
    } catch {
      return Object.freeze({
        ok: false as const,
        code: "unavailable" as const,
        message: "Gateway lifecycle dependency threw",
      });
    }
  }

  async #performOpen(): Promise<void> {
    if (this.#lifecycleState === "failed") {
      await this.#closeLifecycleResources();
    }
    if (this.identity.kind === "oidc" && this.#productionIdentity === null) {
      this.#lifecycleState = "closed";
      throw new GatewayRbpFault(
        "unavailable",
        "OIDC identity authority is missing the production lifecycle and revocation contract",
        503,
        1011,
      );
    }
    this.#lifecycleState = "opening";
    const identity = this.#productionIdentity;
    if (identity !== null) {
      let identityUsesStore: boolean;
      let identityOwnsStore: boolean;
      try {
        identityUsesStore = identity.usesStore(this.store);
        identityOwnsStore =
          identityUsesStore && identity.managedResources().tenantStore.managed;
      } catch {
        this.#lifecycleState = "failed";
        throw new GatewayRbpFault(
          "unavailable",
          "production identity lifecycle metadata is unavailable",
          503,
          1011,
        );
      }
      this.#protocolStoreManagedBy = identityOwnsStore ? "identity" : "bridge";
    } else {
      this.#protocolStoreManagedBy = "bridge";
    }

    if (this.#protocolStoreManagedBy === "bridge") {
      const opened = await this.#callLifecycle(() => this.store.open());
      if (!opened.ok) {
        this.#protocolStoreState = "unknown";
        const rollback = await this.#callLifecycle(() => this.store.close());
        this.#protocolStoreState = rollback.ok ? "closed" : "unknown";
        this.#lifecycleState = rollback.ok ? "closed" : "failed";
        throw new GatewayRbpFault("unavailable", opened.message, 503, 1011);
      }
      this.#protocolStoreState = "open";
    }

    if (identity !== null) {
      const opened = await this.#callLifecycle(() => identity.open());
      if (!opened.ok) {
        try {
          this.#identityState =
            identity.lifecycle().state === "closed" ? "closed" : "unknown";
        } catch {
          this.#identityState = "unknown";
        }
        const rollback = await this.#callLifecycle(() => identity.close());
        this.#identityState = rollback.ok ? "closed" : "unknown";
        if (
          rollback.ok &&
          this.#protocolStoreManagedBy === "bridge" &&
          this.#protocolStoreState !== "closed"
        ) {
          const storeRollback = await this.#callLifecycle(() => this.store.close());
          this.#protocolStoreState = storeRollback.ok ? "closed" : "unknown";
        }
        if (this.#protocolStoreManagedBy === "identity" && rollback.ok) {
          this.#protocolStoreState = "closed";
        }
        this.#lifecycleState =
          this.#identityState === "closed" && this.#protocolStoreState === "closed"
            ? "closed"
            : "failed";
        throw new GatewayRbpFault("unavailable", opened.message, 503, 1011);
      }
      this.#identityState = "open";
      if (this.#protocolStoreManagedBy === "identity") {
        this.#protocolStoreState = "open";
      }
    } else {
      this.#identityState = "open";
    }
    if (!this.#startupReadiness) {
      const coordinator = this.store.startupCoordinator;
      const readiness = await coordinator.runExclusive(async () => {
        const tenants = await coordinator.listTenantIds(10_000);
        if (!tenants.ok) return tenants;
        for (const tenantId of tenants.value) {
          const sessions = await coordinator.listKeys(
            tenantId,
            GATEWAY_RBP_SESSION_NAMESPACE,
            10_000,
          );
          if (!sessions.ok) return sessions;
          for (const rsid of sessions.value) {
            const imported = await this.#importLegacySessionAtStartup(tenantId, rsid);
            if (!imported.ok) return imported;
          }
        }
        return Object.freeze({ ok: true as const, value: undefined });
      });
      if (!readiness.ok) {
        await this.#closeLifecycleResources();
        throw new GatewayRbpFault("unavailable", readiness.message, 503, 1011);
      }
      this.#startupReadiness = true;
    }
    this.#lifecycleState = "open";
  }

  public close(): Promise<void> {
    if (this.#lifecycleState === "closed") return Promise.resolve();
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#openPromise !== null) {
      return this.#openPromise.then(
        () => this.close(),
        () => this.close(),
      );
    }
    this.#closePromise = this.#performClose().finally(() => {
      this.#closePromise = null;
    });
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#lifecycleState = "closing";
    this.#lifecycleGeneration += 1;
    for (const task of [...this.#inFlightSeatReassignments.values()]) {
      this.#cancelSeatReassignmentTask(task);
    }
    const seatReassignmentDrain = Promise.allSettled([
      ...this.#seatReassignmentDrains,
    ]);
    let closeDrainTimeout: ReturnType<typeof setTimeout> | null = null;
    const reassignmentDrained = await Promise.race([
      seatReassignmentDrain.then(() => true),
      new Promise<false>((resolve) => {
        closeDrainTimeout = setTimeout(
          () => resolve(false),
          this.#seatReassignmentCloseDrainTimeoutMs,
        );
      }),
    ]);
    if (closeDrainTimeout !== null) clearTimeout(closeDrainTimeout);
    if (!reassignmentDrained) {
      this.#closeDrainTimedOut = true;
      this.#lifecycleState = "failed";
      throw new GatewayRbpFault(
        "unavailable",
        "Gateway close timed out while reassignment cleanup remained active",
        503,
        1011,
      );
    }
    this.#closeDrainTimedOut = false;
    await Promise.allSettled([
      ...this.#receiveTails.values(),
      ...this.#sessionAuthorizationTails.values(),
      ...this.#tenantIdentityTails.values(),
      ...this.#tenantRevocationTails.values(),
    ]);
    this.#seatReassignmentOperations.clear();
    this.#seatReassignmentAttempts.clear();
    this.#inFlightSeatReassignments.clear();
    this.#seatReassignmentDrains.clear();
    this.#seatReassignmentDrainTasks.clear();
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
    this.#deviceConnections.clear();
    this.#seatConnections.clear();
    this.#deviceSessions.clear();
    this.#seatSessions.clear();
    this.#revokedConnectionIds.clear();
    this.#active.clear();
    for (const waiter of this.#waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.#indeterminateOutcome(waiter.mutating));
    }
    this.#waiters.clear();
    const drained = await Promise.allSettled(
      connections.map(async (connection) => {
        try {
          if (this.#connectionIsCurrentlyAuthorized(connection)) {
            await connection.send(
              JSON.stringify({
                v: 1,
                type: "goodbye",
                id: gatewayUuidV7(this.#clock()),
                ts: nowIso(this.#clock()),
                payload: { reason: "server_draining", retry_after_ms: 1_000 },
              } satisfies RbpEnvelope),
            );
          }
        } finally {
          await connection.close(1001, "server draining");
        }
      }),
    );
    try {
      await this.#closeLifecycleResources();
    } catch (error) {
      shutdownError ??= error;
    }
    const drainFailure = drained.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (shutdownError !== null) throw shutdownError;
    if (drainFailure !== undefined) throw drainFailure.reason;
  }

  async #closeLifecycleResources(): Promise<void> {
    const identity = this.#productionIdentity;
    if (identity !== null && this.#identityState !== "closed") {
      const closed = await this.#callLifecycle(() => identity.close());
      if (!closed.ok) {
        this.#identityState = "unknown";
        this.#lifecycleState = "failed";
        throw new GatewayRbpFault("unavailable", closed.message, 503, 1011);
      }
      this.#identityState = "closed";
      if (this.#protocolStoreManagedBy === "identity") {
        this.#protocolStoreState = "closed";
      }
    } else if (identity === null) {
      this.#identityState = "closed";
    }
    if (
      this.#protocolStoreManagedBy === "bridge" &&
      this.#protocolStoreState !== "closed"
    ) {
      const closed = await this.#callLifecycle(() => this.store.close());
      if (!closed.ok) {
        this.#protocolStoreState = "unknown";
        this.#lifecycleState = "failed";
        throw new GatewayRbpFault("unavailable", closed.message, 503, 1011);
      }
      this.#protocolStoreState = "closed";
    }
    this.#lifecycleState = "closed";
  }

  #assertOpen(): void {
    if (this.#lifecycleState !== "open") {
      throw new GatewayRbpFault(
        "unavailable",
        "Gateway identity and protocol authority are not ready",
        503,
        1011,
      );
    }
  }

  #trackConnection(connection: LiveConnection): void {
    this.#knownTenants.add(connection.auth.actor.tenantId);
    const add = (index: Map<string, Set<string>>, key: string): void => {
      const existing = index.get(key) ?? new Set<string>();
      existing.add(connection.connectionId);
      index.set(key, existing);
    };
    add(
      this.#deviceConnections,
      identityIndexKey(
        connection.auth.actor.tenantId,
        connection.auth.actor.deviceId,
      ),
    );
    add(
      this.#seatConnections,
      identityIndexKey(
        connection.auth.actor.tenantId,
        connection.auth.actor.seatId,
      ),
    );
  }

  #untrackConnection(connection: LiveConnection): void {
    const remove = (index: Map<string, Set<string>>, key: string): void => {
      const existing = index.get(key);
      if (existing === undefined) return;
      existing.delete(connection.connectionId);
      if (existing.size === 0) index.delete(key);
    };
    remove(
      this.#deviceConnections,
      identityIndexKey(
        connection.auth.actor.tenantId,
        connection.auth.actor.deviceId,
      ),
    );
    remove(
      this.#seatConnections,
      identityIndexKey(
        connection.auth.actor.tenantId,
        connection.auth.actor.seatId,
      ),
    );
    this.#maybeForgetTenant(connection.auth.actor.tenantId);
  }

  #trackSession(record: DurableRbpSession): void {
    const add = (index: Map<string, Set<string>>, key: string): void => {
      const existing = index.get(key) ?? new Set<string>();
      existing.add(record.rsid);
      index.set(key, existing);
    };
    add(
      this.#deviceSessions,
      identityIndexKey(record.tenantId, record.deviceId),
    );
    add(
      this.#seatSessions,
      identityIndexKey(record.tenantId, record.seatId),
    );
  }

  #untrackSession(record: DurableRbpSession): void {
    const remove = (index: Map<string, Set<string>>, key: string): void => {
      const existing = index.get(key);
      if (existing === undefined) return;
      existing.delete(record.rsid);
      if (existing.size === 0) index.delete(key);
    };
    remove(
      this.#deviceSessions,
      identityIndexKey(record.tenantId, record.deviceId),
    );
    remove(
      this.#seatSessions,
      identityIndexKey(record.tenantId, record.seatId),
    );
    this.#maybeForgetTenant(record.tenantId);
  }

  #maybeForgetTenant(tenantId: string): void {
    const hasConnection = [...this.#connections.values()].some(
      (connection) => connection.auth.actor.tenantId === tenantId,
    );
    const hasSession = [...this.#active.values()].some(
      (active) => active.tenantId === tenantId,
    );
    if (hasConnection || hasSession) return;
    this.#knownTenants.delete(tenantId);
    this.#tenantIdentitySnapshots.delete(tenantId);
  }

  async #withTenantIdentityAuthority<T>(
    tenantId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#tenantIdentityTails.get(tenantId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tenantIdentityTails.set(tenantId, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tenantIdentityTails.get(tenantId) === tail) {
        this.#tenantIdentityTails.delete(tenantId);
      }
    }
  }

  async #withTenantRevocationRun<T>(
    tenantId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.#tenantRevocationTails.get(tenantId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tenantRevocationTails.set(tenantId, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tenantRevocationTails.get(tenantId) === tail) {
        this.#tenantRevocationTails.delete(tenantId);
      }
    }
  }

  #advanceTenantBlockGeneration(tenantId: string): number {
    const next = (this.#tenantBlockGenerations.get(tenantId) ?? 0) + 1;
    this.#tenantBlockGenerations.set(tenantId, next);
    return next;
  }

  #setDeviceAuthorityFence(
    tenantId: string,
    deviceId: string,
    input: Omit<DeviceAuthorityFence, "generation">,
  ): DeviceAuthorityFence {
    const key = identityIndexKey(tenantId, deviceId);
    const prior = this.#deviceAuthorityFences.get(key);
    const unchanged =
      prior !== undefined &&
      prior.status === input.status &&
      prior.authorizationVersion === input.authorizationVersion &&
      prior.identityRecordVersion === input.identityRecordVersion &&
      prior.connectionCapabilityVersion === input.connectionCapabilityVersion &&
      prior.sessionCapabilityVersion === input.sessionCapabilityVersion &&
      prior.seatId === input.seatId &&
      prior.reason === input.reason;
    const next = Object.freeze({
      ...input,
      generation: unchanged ? prior.generation : (prior?.generation ?? 0) + 1,
    });
    this.#deviceAuthorityFences.set(key, next);
    return next;
  }

  #setSeatAuthorityFence(
    tenantId: string,
    seatId: string,
    input: Omit<SeatAuthorityFence, "generation">,
  ): SeatAuthorityFence {
    const key = identityIndexKey(tenantId, seatId);
    const prior = this.#seatAuthorityFences.get(key);
    const unchanged =
      prior !== undefined &&
      prior.status === input.status &&
      prior.seatAuthorityVersion === input.seatAuthorityVersion &&
      prior.seatRecordVersion === input.seatRecordVersion &&
      prior.deviceId === input.deviceId &&
      prior.reason === input.reason;
    const next = Object.freeze({
      ...input,
      generation: unchanged ? prior.generation : (prior?.generation ?? 0) + 1,
    });
    this.#seatAuthorityFences.set(key, next);
    return next;
  }

  #deviceFence(tenantId: string, deviceId: string): DeviceAuthorityFence | null {
    return this.#deviceAuthorityFences.get(identityIndexKey(tenantId, deviceId)) ?? null;
  }

  #seatFence(tenantId: string, seatId: string): SeatAuthorityFence | null {
    return this.#seatAuthorityFences.get(identityIndexKey(tenantId, seatId)) ?? null;
  }

  #removeSeatReassignmentOperation(
    operation: SeatReassignmentOperation,
  ): void {
    const key = identityIndexKey(operation.tenantId, operation.seatId);
    if (this.#seatReassignmentOperations.get(key)?.token === operation.token) {
      this.#seatReassignmentOperations.delete(key);
    }
    if (!this.#hasUnresolvedSeatReassignmentDrain(operation.token)) {
      this.#seatReassignmentAttempts.delete(operation.token);
    }
  }

  #hasUnresolvedSeatReassignmentDrain(token: string): boolean {
    return [...this.#seatReassignmentDrainTasks].some(
      (task) => task.operation.token === token && !task.drainSettled,
    );
  }

  #pruneSeatReassignmentOperations(): void {
    const nowMs = this.#clock();
    for (const operation of this.#seatReassignmentOperations.values()) {
      const attempt = this.#seatReassignmentAttempts.get(operation.token);
      if (
        this.#hasUnresolvedSeatReassignmentDrain(operation.token) ||
        (attempt !== undefined && attempt.expiresAtMs >= nowMs)
      ) {
        continue;
      }
      this.#removeSeatReassignmentOperation(operation);
    }
    const recordLimit = this.#maxActiveSeatReassignments * 4;
    while (this.#seatReassignmentOperations.size >= recordLimit) {
      const oldest = [...this.#seatReassignmentOperations.values()]
        .filter(
          (operation) =>
            !this.#hasUnresolvedSeatReassignmentDrain(operation.token),
        )
        .sort(
          (left, right) =>
            (this.#seatReassignmentAttempts.get(left.token)?.createdAtMs ?? 0) -
            (this.#seatReassignmentAttempts.get(right.token)?.createdAtMs ?? 0),
        )[0];
      if (oldest === undefined) break;
      this.#removeSeatReassignmentOperation(oldest);
    }
  }

  #assertSeatReassignmentCapacity(): void {
    this.#pruneSeatReassignmentOperations();
    if (
      this.#lifecycleState !== "open" ||
      this.#seatReassignmentDrainTasks.size >=
        this.#maxActiveSeatReassignments ||
      this.#seatReassignmentOperations.size >=
        this.#maxActiveSeatReassignments * 4
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "seat reassignment authority is at its bounded capacity",
        503,
        1011,
      );
    }
  }

  #registerSeatReassignmentTask(
    operation: SeatReassignmentOperation,
    attempt: SeatReassignmentAttemptState,
  ): SeatReassignmentTask {
    if (
      this.#lifecycleState !== "open" ||
      this.#seatReassignmentDrainTasks.size >=
        this.#maxActiveSeatReassignments ||
      attempt.lifecycleGeneration !== this.#lifecycleGeneration ||
      this.#inFlightSeatReassignments.has(operation.token)
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "seat reassignment lifecycle registration is stale",
        503,
        1011,
      );
    }
    let resolveOutcome!: (outcome: SeatReassignmentTaskOutcome) => void;
    const outcome = new Promise<SeatReassignmentTaskOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    let resolveCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    let resolveDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const task: SeatReassignmentTask = {
      operation,
      lifecycleGeneration: this.#lifecycleGeneration,
      attempt: attempt.attemptsStarted,
      cancelled: false,
      cancellationKind: null,
      outcomeSettled: false,
      drainSettled: false,
      outcome,
      resolveOutcome,
      cancellation,
      resolveCancellation,
      drain,
      resolveDrain,
    };
    this.#inFlightSeatReassignments.set(operation.token, task);
    this.#seatReassignmentDrains.add(drain);
    this.#seatReassignmentDrainTasks.add(task);
    return task;
  }

  #settleSeatReassignmentTask(
    task: SeatReassignmentTask,
    outcome: SeatReassignmentTaskOutcome,
  ): void {
    if (!task.outcomeSettled) {
      task.outcomeSettled = true;
      task.resolveOutcome(outcome);
    }
    if (
      this.#inFlightSeatReassignments.get(task.operation.token) === task
    ) {
      this.#inFlightSeatReassignments.delete(task.operation.token);
    }
    if (outcome !== "succeeded") {
      this.#quarantineSeatReassignment(task.operation);
    }
  }

  #finishSeatReassignmentDrain(task: SeatReassignmentTask): void {
    if (task.drainSettled) return;
    task.drainSettled = true;
    this.#seatReassignmentDrains.delete(task.drain);
    this.#seatReassignmentDrainTasks.delete(task);
    const attempt = this.#seatReassignmentAttempts.get(task.operation.token);
    if (
      attempt?.state === "timed_out_cleanup_pending" ||
      attempt?.state === "cancelled_cleanup_pending"
    ) {
      attempt.state = "quarantined";
    }
    const key = identityIndexKey(
      task.operation.tenantId,
      task.operation.seatId,
    );
    if (
      this.#seatReassignmentOperations.get(key)?.token !==
      task.operation.token
    ) {
      this.#seatReassignmentAttempts.delete(task.operation.token);
    }
    task.resolveDrain();
  }

  #cancelSeatReassignmentTask(
    task: SeatReassignmentTask,
    kind: "authority" | "lifecycle" = "lifecycle",
  ): void {
    if (!task.cancelled) {
      task.cancelled = true;
      task.cancellationKind = kind;
      const attempt = this.#seatReassignmentAttempts.get(task.operation.token);
      if (attempt !== undefined) {
        attempt.state = "cancelled_cleanup_pending";
      }
      task.resolveCancellation();
    }
    this.#settleSeatReassignmentTask(task, "cancelled");
  }

  #invalidateSeatReassignmentOperation(
    operation: SeatReassignmentOperation,
    options: { readonly quarantine?: boolean } = {},
  ): void {
    if (options.quarantine === false) {
      this.#removeSeatReassignmentOperation(operation);
    }
    const task = this.#inFlightSeatReassignments.get(operation.token);
    if (task !== undefined) {
      this.#cancelSeatReassignmentTask(task, "authority");
    }
    if (options.quarantine !== false) {
      this.#removeSeatReassignmentOperation(operation);
    }
  }

  #sameDeviceAuthorityFence(
    current: DeviceAuthorityFence | null,
    expected: DeviceAuthorityFence,
  ): boolean {
    return (
      current !== null &&
      current.generation === expected.generation &&
      current.status === expected.status &&
      current.authorizationVersion === expected.authorizationVersion &&
      current.identityRecordVersion === expected.identityRecordVersion &&
      current.connectionCapabilityVersion ===
        expected.connectionCapabilityVersion &&
      current.sessionCapabilityVersion === expected.sessionCapabilityVersion &&
      current.seatId === expected.seatId &&
      current.reason === expected.reason
    );
  }

  #sameSeatAuthorityFence(
    current: SeatAuthorityFence | null,
    expected: SeatAuthorityFence,
  ): boolean {
    return (
      current !== null &&
      current.generation === expected.generation &&
      current.status === expected.status &&
      current.seatAuthorityVersion === expected.seatAuthorityVersion &&
      current.seatRecordVersion === expected.seatRecordVersion &&
      current.deviceId === expected.deviceId &&
      current.reason === expected.reason
    );
  }

  #connectionMatchesSeatReassignment(
    connection: LiveConnection,
    operation: SeatReassignmentOperation,
  ): boolean {
    const durable = durableIdentityAuthority(connection.auth);
    return (
      durable !== null &&
      connection.auth.actor.tenantId === operation.tenantId &&
      connection.auth.actor.deviceId === operation.incomingDeviceId &&
      connection.auth.actor.seatId === operation.seatId &&
      durable.authorizationVersion ===
        operation.incomingDeviceFence.authorizationVersion &&
      durable.identityRecordVersion ===
        operation.incomingDeviceFence.identityRecordVersion &&
      durable.connectionCapabilityVersion ===
        operation.incomingDeviceFence.connectionCapabilityVersion &&
      durable.sessionCapabilityVersion ===
        operation.incomingDeviceFence.sessionCapabilityVersion &&
      durable.seatAuthorityVersion ===
        operation.seatFence.seatAuthorityVersion &&
      durable.seatRecordVersion === operation.seatFence.seatRecordVersion
    );
  }

  #connectionSupersedesSeatReassignment(
    connection: LiveConnection,
    operation: SeatReassignmentOperation,
  ): DurableIdentityAuthority | null {
    const durable = durableIdentityAuthority(connection.auth);
    const expectedDevice = operation.incomingDeviceFence;
    const expectedSeat = operation.seatFence;
    if (
      durable === null ||
      connection.auth.actor.tenantId !== operation.tenantId ||
      connection.auth.actor.deviceId !== operation.incomingDeviceId ||
      connection.auth.actor.seatId !== operation.seatId ||
      expectedDevice.authorizationVersion === null ||
      expectedDevice.identityRecordVersion === null ||
      expectedDevice.connectionCapabilityVersion === null ||
      expectedDevice.sessionCapabilityVersion === null ||
      expectedSeat.seatAuthorityVersion === null ||
      expectedSeat.seatRecordVersion === null
    ) {
      return null;
    }
    const deviceExact =
      durable.authorizationVersion === expectedDevice.authorizationVersion &&
      durable.identityRecordVersion === expectedDevice.identityRecordVersion &&
      durable.connectionCapabilityVersion ===
        expectedDevice.connectionCapabilityVersion &&
      durable.sessionCapabilityVersion ===
        expectedDevice.sessionCapabilityVersion;
    const deviceHigher =
      durable.authorizationVersion > expectedDevice.authorizationVersion &&
      durable.identityRecordVersion > expectedDevice.identityRecordVersion &&
      durable.connectionCapabilityVersion >=
        expectedDevice.connectionCapabilityVersion &&
      durable.sessionCapabilityVersion >=
        expectedDevice.sessionCapabilityVersion;
    const seatExact =
      durable.seatAuthorityVersion === expectedSeat.seatAuthorityVersion &&
      durable.seatRecordVersion === expectedSeat.seatRecordVersion;
    const seatHigher =
      durable.seatAuthorityVersion > expectedSeat.seatAuthorityVersion &&
      durable.seatRecordVersion > expectedSeat.seatRecordVersion;
    return (
      (deviceExact || deviceHigher) &&
      (seatExact || seatHigher) &&
      (deviceHigher || seatHigher)
    )
      ? durable
      : null;
  }

  #seatReassignmentFencesAreCurrent(
    operation: SeatReassignmentOperation,
  ): boolean {
    return (
      this.#seatReassignmentOperations.get(
        identityIndexKey(operation.tenantId, operation.seatId),
      )?.token === operation.token &&
      !this.#blockedTenants.has(operation.tenantId) &&
      (this.#tenantBlockGenerations.get(operation.tenantId) ?? 0) ===
        operation.tenantBlockGeneration &&
      this.#sameDeviceAuthorityFence(
        this.#deviceFence(operation.tenantId, operation.priorDeviceId),
        operation.priorDeviceFence,
      ) &&
      this.#sameDeviceAuthorityFence(
        this.#deviceFence(operation.tenantId, operation.incomingDeviceId),
        operation.incomingDeviceFence,
      ) &&
      this.#sameSeatAuthorityFence(
        this.#seatFence(operation.tenantId, operation.seatId),
        operation.seatFence,
      )
    );
  }

  #seatReassignmentIsCurrent(
    connection: LiveConnection,
    operation: SeatReassignmentOperation,
  ): boolean {
    return (
      this.#seatReassignmentFencesAreCurrent(operation) &&
      this.#connectionMatchesSeatReassignment(connection, operation)
    );
  }

  #seatReassignmentTaskIsCurrent(
    connection: LiveConnection,
    task: SeatReassignmentTask,
  ): boolean {
    return (
      this.#lifecycleState === "open" &&
      this.#lifecycleGeneration === task.lifecycleGeneration &&
      !task.cancelled &&
      this.#inFlightSeatReassignments.get(task.operation.token) === task &&
      this.#seatReassignmentIsCurrent(connection, task.operation)
    );
  }

  #quarantineSeatReassignment(operation: SeatReassignmentOperation): void {
    const key = identityIndexKey(operation.tenantId, operation.seatId);
    if (this.#seatReassignmentOperations.get(key)?.token !== operation.token) {
      return;
    }
    const current = this.#seatFence(operation.tenantId, operation.seatId);
    if (current?.status !== "active") return;
    this.#setSeatAuthorityFence(operation.tenantId, operation.seatId, {
      status: "blocked",
      seatAuthorityVersion: current.seatAuthorityVersion,
      seatRecordVersion: current.seatRecordVersion,
      deviceId: current.deviceId,
      reason: current.reason,
    });
  }

  #admitAuthenticatedScope(connection: LiveConnection): {
    readonly kind: "admitted";
    readonly deviceGeneration: number;
    readonly seatGeneration: number;
  } | {
    readonly kind: "seat_reassignment";
    readonly operation: SeatReassignmentOperation;
    readonly task: SeatReassignmentTask;
    readonly role: "leader" | "replay";
  } {
    const tenantId = connection.auth.actor.tenantId;
    const durable = durableIdentityAuthority(connection.auth);
    const devicePrior = this.#deviceFence(tenantId, connection.auth.actor.deviceId);
    const seatPrior = this.#seatFence(tenantId, connection.auth.actor.seatId);
    const seatKey = identityIndexKey(tenantId, connection.auth.actor.seatId);
    const pendingReassignment = this.#seatReassignmentOperations.get(seatKey);
    if (
      pendingReassignment !== undefined &&
      this.#seatReassignmentIsCurrent(connection, pendingReassignment)
    ) {
      const attempt = this.#seatReassignmentAttempts.get(
        pendingReassignment.token,
      );
      if (
        attempt === undefined ||
        attempt.lifecycleGeneration !== this.#lifecycleGeneration ||
        attempt.expiresAtMs < this.#clock() ||
        attempt.attemptsStarted >= MAX_SEAT_REASSIGNMENT_ATTEMPTS
      ) {
        throw new GatewayRbpFault(
          "auth",
          "seat reassignment retry authority is exhausted",
          403,
          4403,
        );
      }
      if (
        attempt.state === "timed_out_cleanup_pending" ||
        attempt.state === "cancelled_cleanup_pending"
      ) {
        throw new GatewayRbpFault(
          "unavailable",
          "seat reassignment cleanup is still draining",
          503,
          1011,
        );
      }
      const activeTask = this.#inFlightSeatReassignments.get(
        pendingReassignment.token,
      );
      attempt.attemptsStarted += 1;
      if (activeTask !== undefined) {
        return {
          kind: "seat_reassignment",
          operation: pendingReassignment,
          task: activeTask,
          role: "replay",
        };
      }
      let retryTask: SeatReassignmentTask;
      const priorState = attempt.state;
      attempt.state = "active";
      try {
        retryTask = this.#registerSeatReassignmentTask(
          pendingReassignment,
          attempt,
        );
      } catch (error) {
        attempt.attemptsStarted -= 1;
        attempt.state = priorState;
        throw error;
      }
      return {
        kind: "seat_reassignment",
        operation: pendingReassignment,
        task: retryTask,
        role: "leader",
      };
    }
    if (
      pendingReassignment !== undefined &&
      this.#seatReassignmentFencesAreCurrent(pendingReassignment)
    ) {
      const superseding = this.#connectionSupersedesSeatReassignment(
        connection,
        pendingReassignment,
      );
      if (superseding !== null) {
        this.#setDeviceAuthorityFence(
          tenantId,
          connection.auth.actor.deviceId,
          {
            status: "blocked",
            authorizationVersion: superseding.authorizationVersion,
            identityRecordVersion: superseding.identityRecordVersion,
            connectionCapabilityVersion:
              superseding.connectionCapabilityVersion,
            sessionCapabilityVersion: superseding.sessionCapabilityVersion,
            seatId: connection.auth.actor.seatId,
            reason: null,
          },
        );
        this.#setSeatAuthorityFence(
          tenantId,
          connection.auth.actor.seatId,
          {
            status: "blocked",
            seatAuthorityVersion: superseding.seatAuthorityVersion,
            seatRecordVersion: superseding.seatRecordVersion,
            deviceId: connection.auth.actor.deviceId,
            reason: null,
          },
        );
        this.#invalidateSeatReassignmentOperation(pendingReassignment);
        throw new GatewayRbpFault(
          "auth",
          "newer seat reassignment authority requires resynchronization",
          403,
          4403,
        );
      }
    }
    const deviceVersion = durable?.authorizationVersion ?? null;
    const identityRecordVersion = durable?.identityRecordVersion ?? null;
    const seatVersion = durable?.seatAuthorityVersion ?? null;
    const seatRecordVersion = durable?.seatRecordVersion ?? null;
    const seatOwnerChanged =
      seatPrior?.deviceId !== null &&
      seatPrior?.deviceId !== undefined &&
      seatPrior.deviceId !== connection.auth.actor.deviceId;
    const seatVersionsEqual =
      seatPrior !== null &&
      seatPrior.seatAuthorityVersion === seatVersion &&
      seatPrior.seatRecordVersion === seatRecordVersion;
    const seatVersionsHigher =
      seatPrior !== null &&
      seatPrior.seatAuthorityVersion !== null &&
      seatPrior.seatRecordVersion !== null &&
      seatVersion !== null &&
      seatRecordVersion !== null &&
      seatVersion > seatPrior.seatAuthorityVersion &&
      seatRecordVersion > seatPrior.seatRecordVersion;
    const deviceCanActivate =
      devicePrior === null ||
      (devicePrior.status === "active" &&
        devicePrior.authorizationVersion === deviceVersion &&
        devicePrior.identityRecordVersion === identityRecordVersion) ||
      (devicePrior.status === "active" &&
        deviceVersion !== null &&
        identityRecordVersion !== null &&
        (devicePrior.authorizationVersion === null ||
          deviceVersion > devicePrior.authorizationVersion) &&
        (devicePrior.identityRecordVersion === null ||
          identityRecordVersion > devicePrior.identityRecordVersion)) ||
      (devicePrior.status === "revoked" &&
        devicePrior.authorizationVersion !== null &&
        devicePrior.identityRecordVersion !== null &&
        deviceVersion !== null &&
        identityRecordVersion !== null &&
        deviceVersion > devicePrior.authorizationVersion &&
        identityRecordVersion > devicePrior.identityRecordVersion);
    const seatCanActivate =
      seatPrior === null ||
      (seatPrior.status === "active" &&
        !seatOwnerChanged &&
        seatVersionsEqual) ||
      (seatPrior.status === "active" &&
        seatVersionsHigher) ||
      (seatPrior.status === "revoked" &&
        seatVersionsHigher);
    if (!deviceCanActivate || !seatCanActivate) {
      throw new GatewayRbpFault(
        "auth",
        "authenticated identity is stale against scoped authority",
        403,
        4403,
      );
    }
    if (seatOwnerChanged) {
      if (!seatVersionsHigher || seatPrior?.deviceId === null) {
        throw new GatewayRbpFault(
          "auth",
          "seat owner change requires a strictly newer coherent authority",
          403,
          4403,
        );
      }
      this.#assertSeatReassignmentCapacity();
      const createdAtMs = this.#clock();
      const operationToken = gatewayUuidV7(createdAtMs);
      const tenantBlockGeneration =
        this.#tenantBlockGenerations.get(tenantId) ?? 0;
      const oldDevice = this.#deviceFence(tenantId, seatPrior.deviceId);
      const priorDeviceFence = this.#setDeviceAuthorityFence(
        tenantId,
        seatPrior.deviceId,
        {
          status: "blocked",
          authorizationVersion: oldDevice?.authorizationVersion ?? null,
          identityRecordVersion: oldDevice?.identityRecordVersion ?? null,
          connectionCapabilityVersion:
            oldDevice?.connectionCapabilityVersion ?? null,
          sessionCapabilityVersion: oldDevice?.sessionCapabilityVersion ?? null,
          seatId: connection.auth.actor.seatId,
          reason: "seat_revoked",
        },
      );
      const incomingDeviceFence = this.#setDeviceAuthorityFence(
        tenantId,
        connection.auth.actor.deviceId,
        {
          status: "blocked",
          authorizationVersion: deviceVersion,
          identityRecordVersion,
          connectionCapabilityVersion:
            durable?.connectionCapabilityVersion ?? null,
          sessionCapabilityVersion:
            durable?.sessionCapabilityVersion ?? null,
          seatId: connection.auth.actor.seatId,
          reason: null,
        },
      );
      const seatFence = this.#setSeatAuthorityFence(
        tenantId,
        connection.auth.actor.seatId,
        {
          status: "blocked",
          seatAuthorityVersion: seatVersion,
          seatRecordVersion,
          deviceId: connection.auth.actor.deviceId,
          reason: null,
        },
      );
      const operation = Object.freeze({
        token: operationToken,
        tenantId,
        seatId: connection.auth.actor.seatId,
        priorDeviceId: seatPrior.deviceId,
        incomingDeviceId: connection.auth.actor.deviceId,
        tenantBlockGeneration,
        priorDeviceFence,
        incomingDeviceFence,
        seatFence,
      });
      this.#seatReassignmentOperations.set(seatKey, operation);
      const attempt: SeatReassignmentAttemptState = {
        attemptsStarted: 1,
        state: "active",
        createdAtMs,
        expiresAtMs: Math.min(
          Number.MAX_SAFE_INTEGER,
          createdAtMs + Math.max(this.#seatReassignmentTimeoutMs * 4, 1_000),
        ),
        lifecycleGeneration: this.#lifecycleGeneration,
      };
      this.#seatReassignmentAttempts.set(operation.token, attempt);
      let task: SeatReassignmentTask;
      try {
        task = this.#registerSeatReassignmentTask(operation, attempt);
      } catch (error) {
        this.#removeSeatReassignmentOperation(operation);
        throw error;
      }
      return {
        kind: "seat_reassignment",
        operation,
        task,
        role: "leader",
      };
    }
    const device = this.#setDeviceAuthorityFence(
      tenantId,
      connection.auth.actor.deviceId,
      {
        status: "active",
        authorizationVersion: deviceVersion,
        identityRecordVersion,
        connectionCapabilityVersion:
          durable?.connectionCapabilityVersion ?? null,
        sessionCapabilityVersion: durable?.sessionCapabilityVersion ?? null,
        seatId: connection.auth.actor.seatId,
        reason: null,
      },
    );
    const seat = this.#setSeatAuthorityFence(
      tenantId,
      connection.auth.actor.seatId,
      {
        status: "active",
        seatAuthorityVersion: seatVersion,
        seatRecordVersion,
        deviceId: connection.auth.actor.deviceId,
        reason: null,
      },
    );
    return {
      kind: "admitted",
      deviceGeneration: device.generation,
      seatGeneration: seat.generation,
    };
  }

  #applyDeviceSnapshot(device: IdentityDeviceV2): DeviceAuthorityFence {
    const prior = this.#deviceFence(device.tenantId, device.deviceId);
    const status: ScopedAuthorityStatus =
      device.status === "active" ? "active" : "revoked";
    if (
      prior !== null &&
      ((prior.authorizationVersion !== null &&
        device.authorizationVersion < prior.authorizationVersion) ||
        (prior.identityRecordVersion !== null &&
          device.recordVersion < prior.identityRecordVersion))
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "device snapshot regressed scoped authority versions",
        503,
        1011,
      );
    }
    if (status === "active" && prior !== null) {
      const versionIsOlder =
        (prior.authorizationVersion !== null &&
          device.authorizationVersion < prior.authorizationVersion) ||
        (prior.identityRecordVersion !== null &&
          device.recordVersion < prior.identityRecordVersion);
      const revokedWasNotSuperseded =
        prior.status === "revoked" &&
        (prior.authorizationVersion === null ||
          prior.identityRecordVersion === null ||
          device.authorizationVersion <= prior.authorizationVersion ||
          device.recordVersion <= prior.identityRecordVersion);
      if (versionIsOlder || revokedWasNotSuperseded) {
        throw new GatewayRbpFault(
          "unavailable",
          "active device snapshot did not supersede its scoped fence",
          503,
          1011,
        );
      }
    }
    return this.#setDeviceAuthorityFence(device.tenantId, device.deviceId, {
      status,
      authorizationVersion: device.authorizationVersion,
      identityRecordVersion: device.recordVersion,
      connectionCapabilityVersion: device.connectionCapabilityVersion,
      sessionCapabilityVersion: device.sessionCapabilityVersion,
      seatId: device.seatId,
      reason: status === "active" ? null : prior?.reason ?? "device_revoked",
    });
  }

  #applySeatSnapshot(seat: IdentityTenantSeatV1): SeatAuthorityFence {
    const prior = this.#seatFence(seat.tenantId, seat.seatId);
    const status: ScopedAuthorityStatus =
      seat.status === "active" ? "active" : "revoked";
    if (
      prior !== null &&
      ((prior.seatAuthorityVersion !== null &&
        seat.seatAuthorityVersion < prior.seatAuthorityVersion) ||
        (prior.seatRecordVersion !== null &&
          seat.recordVersion < prior.seatRecordVersion))
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "seat snapshot regressed scoped authority versions",
        503,
        1011,
      );
    }
    if (
      status === "active" &&
      prior?.status === "active" &&
      prior.deviceId !== null &&
      prior.deviceId !== seat.deviceId &&
      (prior.seatAuthorityVersion === null ||
        prior.seatRecordVersion === null ||
        seat.seatAuthorityVersion <= prior.seatAuthorityVersion ||
        seat.recordVersion <= prior.seatRecordVersion)
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "seat owner changed without a higher coherent authority version",
        503,
        1011,
      );
    }
    if (status === "active" && prior !== null) {
      const versionIsOlder =
        (prior.seatAuthorityVersion !== null &&
          seat.seatAuthorityVersion < prior.seatAuthorityVersion) ||
        (prior.seatRecordVersion !== null &&
          seat.recordVersion < prior.seatRecordVersion);
      const revokedWasNotSuperseded =
        prior.status === "revoked" &&
        (prior.seatAuthorityVersion === null ||
          prior.seatRecordVersion === null ||
          seat.seatAuthorityVersion <= prior.seatAuthorityVersion ||
          seat.recordVersion <= prior.seatRecordVersion);
      if (versionIsOlder || revokedWasNotSuperseded) {
        throw new GatewayRbpFault(
          "unavailable",
          "active seat snapshot did not supersede its scoped fence",
          503,
          1011,
        );
      }
    }
    const next = this.#setSeatAuthorityFence(seat.tenantId, seat.seatId, {
      status,
      seatAuthorityVersion: seat.seatAuthorityVersion,
      seatRecordVersion: seat.recordVersion,
      deviceId: seat.deviceId,
      reason: status === "active" ? null : prior?.reason ?? "seat_revoked",
    });
    const reassignment = this.#seatReassignmentOperations.get(
      identityIndexKey(seat.tenantId, seat.seatId),
    );
    if (reassignment !== undefined) {
      this.#invalidateSeatReassignmentOperation(reassignment, {
        quarantine: false,
      });
    }
    return next;
  }

  #applyEventFences(
    tenantId: string,
    events: readonly IdentityRevocationEventV1[],
  ): void {
    for (const event of events) {
      const priorSeat =
        event.seatId === null ? null : this.#seatFence(tenantId, event.seatId);
      if (
        event.seatId !== null &&
        event.seatAuthorityVersion !== null &&
        priorSeat?.seatAuthorityVersion !== null &&
        priorSeat?.seatAuthorityVersion !== undefined &&
        event.seatAuthorityVersion < priorSeat.seatAuthorityVersion
      ) {
        throw new GatewayRbpFault(
          "unavailable",
          "identity event regressed seat authority version",
          503,
          1011,
        );
      }
      if (
        event.action === "seat_reassigned" &&
        event.seatId !== null &&
        priorSeat?.deviceId !== null &&
        priorSeat?.deviceId !== undefined &&
        priorSeat.deviceId !== event.deviceId
      ) {
        if (
          event.seatAuthorityVersion === null ||
          priorSeat.seatAuthorityVersion === null ||
          event.seatAuthorityVersion <= priorSeat.seatAuthorityVersion
        ) {
          throw new GatewayRbpFault(
            "unavailable",
            "seat reassignment event lacks a higher authority version",
            503,
            1011,
          );
        }
        const oldDevice = this.#deviceFence(tenantId, priorSeat.deviceId);
        this.#setDeviceAuthorityFence(tenantId, priorSeat.deviceId, {
          status: "blocked",
          authorizationVersion: oldDevice?.authorizationVersion ?? null,
          identityRecordVersion: oldDevice?.identityRecordVersion ?? null,
          connectionCapabilityVersion:
            oldDevice?.connectionCapabilityVersion ?? null,
          sessionCapabilityVersion:
            oldDevice?.sessionCapabilityVersion ?? null,
          seatId: event.seatId,
          reason: "seat_revoked",
        });
      }
      if (event.deviceId !== null) {
        const prior = this.#deviceFence(tenantId, event.deviceId);
        if (
          event.authorizationVersion !== null &&
          prior?.authorizationVersion !== null &&
          prior?.authorizationVersion !== undefined &&
          event.authorizationVersion < prior.authorizationVersion
        ) {
          throw new GatewayRbpFault(
            "unavailable",
            "identity event regressed device authority version",
            503,
            1011,
          );
        }
        this.#setDeviceAuthorityFence(tenantId, event.deviceId, {
          status: event.action === "seat_reassigned" ? "blocked" : "revoked",
          authorizationVersion:
            event.authorizationVersion ?? prior?.authorizationVersion ?? null,
          identityRecordVersion: prior?.identityRecordVersion ?? null,
          connectionCapabilityVersion:
            prior?.connectionCapabilityVersion ?? null,
          sessionCapabilityVersion: prior?.sessionCapabilityVersion ?? null,
          seatId: event.seatId ?? prior?.seatId ?? null,
          reason:
            event.action === "seat_reassigned" ? null : event.action,
        });
      }
      if (event.action !== "device_revoked" && event.seatId !== null) {
        const prior = this.#seatFence(tenantId, event.seatId);
        this.#setSeatAuthorityFence(tenantId, event.seatId, {
          status: event.action === "seat_reassigned" ? "blocked" : "revoked",
          seatAuthorityVersion:
            event.seatAuthorityVersion ?? prior?.seatAuthorityVersion ?? null,
          seatRecordVersion: prior?.seatRecordVersion ?? null,
          deviceId: event.deviceId ?? prior?.deviceId ?? null,
          reason: event.action === "seat_reassigned" ? null : "seat_revoked",
        });
      }
    }
  }

  #applyScopedSnapshot(
    snapshot: TenantIdentitySnapshot,
    events: readonly IdentityRevocationEventV1[],
    wholeTenant: boolean,
  ): void {
    if (wholeTenant) {
      for (const device of snapshot.devices.values()) {
        this.#applyDeviceSnapshot(device);
      }
      for (const seat of snapshot.seats.values()) {
        this.#applySeatSnapshot(seat);
      }
      return;
    }
    for (const event of events) {
      if (event.deviceId !== null) {
        const device = snapshot.devices.get(event.deviceId);
        if (device === undefined) {
          throw new GatewayRbpFault(
            "unavailable",
            "identity event device is absent from the authority snapshot",
            503,
            1011,
          );
        }
        this.#applyDeviceSnapshot(device);
      }
      if (event.action !== "device_revoked" && event.seatId !== null) {
        const seat = snapshot.seats.get(event.seatId);
        if (seat === undefined) {
          throw new GatewayRbpFault(
            "unavailable",
            "identity event seat is absent from the authority snapshot",
            503,
            1011,
          );
        }
        this.#applySeatSnapshot(seat);
      }
    }
  }

  async #acquireConnectionAuthorityTicket(
    connection: LiveConnection,
    options: { readonly requireMembership?: boolean } = {},
  ): Promise<TenantAuthorityTicket> {
    this.#assertOpen();
    const tenantId = connection.auth.actor.tenantId;
    if (this.#productionIdentity !== null) {
      await this.synchronizeIdentityRevocations(tenantId);
    }
    const phase = await this.#withTenantIdentityAuthority(tenantId, async () => {
      this.#assertOpen();
      if (
        this.#blockedTenants.has(tenantId) ||
        connection.auth.deviceStatus !== "active" ||
        (options.requireMembership !== false &&
          this.#connections.get(connection.connectionId) !== connection)
      ) {
        throw new GatewayRbpFault(
          "auth",
          "connection identity authority is fenced",
          403,
          4403,
        );
      }
      if (this.#productionIdentity !== null) {
        const snapshot = this.#tenantIdentitySnapshots.get(tenantId);
        if (
          snapshot === undefined ||
          !this.#connectionMatchesSnapshot(connection, snapshot)
        ) {
          throw new GatewayRbpFault(
            "auth",
            "connection identity authority changed",
            403,
            4403,
          );
        }
      }
      const scoped = this.#admitAuthenticatedScope(connection);
      if (scoped.kind === "seat_reassignment") return scoped;
      const tenantBlockGeneration =
        this.#tenantBlockGenerations.get(tenantId) ?? 0;
      connection.tenantBlockGeneration = tenantBlockGeneration;
      connection.deviceGeneration = scoped.deviceGeneration;
      connection.seatGeneration = scoped.seatGeneration;
      return Object.freeze({
        tenantId,
        deviceId: connection.auth.actor.deviceId,
        seatId: connection.auth.actor.seatId,
        connectionId: connection.connectionId,
        tenantBlockGeneration,
        deviceGeneration: scoped.deviceGeneration,
        seatGeneration: scoped.seatGeneration,
        identityAuthority: durableIdentityAuthority(connection.auth),
      });
    });
    if ("tenantId" in phase) return phase;
    if (phase.role === "replay") {
      await phase.task.outcome;
      throw new GatewayRbpFault(
        "auth",
        "seat reassignment replay does not own finalization",
        403,
        4403,
      );
    }
    return await this.#runSeatReassignment(connection, phase.task);
  }

  async #runSeatReassignment(
    connection: LiveConnection,
    task: SeatReassignmentTask,
  ): Promise<TenantAuthorityTicket> {
    const operation = task.operation;
    // The tenant tail is released before old-owner rsid cleanup.
    const cleanup = this.#reconcileExplicitIdentityRevocation({
      tenantId: operation.tenantId,
      kind: "device",
      deviceId: operation.priorDeviceId,
      seatId: operation.seatId,
      affectedDeviceIds: new Set([operation.priorDeviceId]),
    }).then(
      () => ({ kind: "clean" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ kind: "timeout" }),
        this.#seatReassignmentTimeoutMs,
      );
    });
    const first = await Promise.race([
      cleanup,
      task.cancellation.then(() => ({ kind: "cancelled" as const })),
      timeout,
    ]);
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    if (first.kind === "timeout") {
      const attempt = this.#seatReassignmentAttempts.get(operation.token);
      if (attempt !== undefined) {
        attempt.state = "timed_out_cleanup_pending";
      }
      this.#settleSeatReassignmentTask(task, "quarantined");
      void cleanup.then(() => this.#finishSeatReassignmentDrain(task));
      throw new GatewayRbpFault(
        "unavailable",
        "seat reassignment cleanup timed out",
        503,
        1011,
      );
    }
    if (first.kind === "cancelled") {
      this.#settleSeatReassignmentTask(task, "cancelled");
      await cleanup;
      this.#finishSeatReassignmentDrain(task);
      if (task.cancellationKind === "authority") {
        throw new GatewayRbpFault(
          "auth",
          "seat reassignment authority was superseded",
          403,
          4403,
        );
      }
      throw new GatewayRbpFault(
        "unavailable",
        "seat reassignment lifecycle was cancelled",
        503,
        1011,
      );
    }
    if (first.kind === "failed") {
      const attempt = this.#seatReassignmentAttempts.get(operation.token);
      if (attempt !== undefined) attempt.state = "quarantined";
      this.#settleSeatReassignmentTask(task, "quarantined");
      this.#finishSeatReassignmentDrain(task);
      throw first.error;
    }
    try {
      return await this.#withTenantIdentityAuthority(
        operation.tenantId,
        async () => {
          const durable = durableIdentityAuthority(connection.auth);
          if (
            durable === null ||
            !this.#seatReassignmentTaskIsCurrent(connection, task)
          ) {
            throw new GatewayRbpFault(
              "auth",
              "seat reassignment authority changed during old-owner cleanup",
              403,
              4403,
            );
          }
          this.#setDeviceAuthorityFence(
            operation.tenantId,
            operation.priorDeviceId,
            {
              status: "revoked",
              authorizationVersion:
                operation.priorDeviceFence.authorizationVersion,
              identityRecordVersion:
                operation.priorDeviceFence.identityRecordVersion,
              connectionCapabilityVersion:
                operation.priorDeviceFence.connectionCapabilityVersion,
              sessionCapabilityVersion:
                operation.priorDeviceFence.sessionCapabilityVersion,
              seatId: operation.seatId,
              reason: "seat_revoked",
            },
          );
          const device = this.#setDeviceAuthorityFence(
            operation.tenantId,
            operation.incomingDeviceId,
            {
              status: "active",
              authorizationVersion:
                operation.incomingDeviceFence.authorizationVersion,
              identityRecordVersion:
                operation.incomingDeviceFence.identityRecordVersion,
              connectionCapabilityVersion:
                operation.incomingDeviceFence.connectionCapabilityVersion,
              sessionCapabilityVersion:
                operation.incomingDeviceFence.sessionCapabilityVersion,
              seatId: operation.seatId,
              reason: null,
            },
          );
          const activeSeat = this.#setSeatAuthorityFence(
            operation.tenantId,
            operation.seatId,
            {
              status: "active",
              seatAuthorityVersion: operation.seatFence.seatAuthorityVersion,
              seatRecordVersion: operation.seatFence.seatRecordVersion,
              deviceId: operation.incomingDeviceId,
              reason: null,
            },
          );
          this.#removeSeatReassignmentOperation(operation);
          this.#settleSeatReassignmentTask(task, "succeeded");
          const tenantBlockGeneration = operation.tenantBlockGeneration;
          connection.tenantBlockGeneration = tenantBlockGeneration;
          connection.deviceGeneration = device.generation;
          connection.seatGeneration = activeSeat.generation;
          return Object.freeze({
            tenantId: operation.tenantId,
            deviceId: operation.incomingDeviceId,
            seatId: operation.seatId,
            connectionId: connection.connectionId,
            tenantBlockGeneration,
            deviceGeneration: device.generation,
            seatGeneration: activeSeat.generation,
            identityAuthority: durable,
          });
        },
      );
    } catch (error: unknown) {
      const attempt = this.#seatReassignmentAttempts.get(operation.token);
      if (attempt !== undefined && !task.cancelled) {
        attempt.state = "quarantined";
      }
      this.#settleSeatReassignmentTask(
        task,
        task.cancelled || this.#lifecycleState !== "open"
          ? "cancelled"
          : "quarantined",
      );
      throw error;
    } finally {
      this.#finishSeatReassignmentDrain(task);
    }
  }

  #assertAuthorityTicket(
    ticket: TenantAuthorityTicket,
    connection: LiveConnection,
    options: {
      readonly session?: DurableRbpSession;
      readonly requireConnectionMembership?: boolean;
      readonly requireSessionMembership?: boolean;
    } = {},
  ): void {
    const session = options.session;
    const device = this.#deviceFence(ticket.tenantId, ticket.deviceId);
    const seat = this.#seatFence(ticket.tenantId, ticket.seatId);
    this.#assertOpen();
    if (
      ticket.tenantId !== connection.auth.actor.tenantId ||
      ticket.deviceId !== connection.auth.actor.deviceId ||
      ticket.seatId !== connection.auth.actor.seatId ||
      ticket.connectionId !== connection.connectionId ||
      ticket.tenantBlockGeneration !==
        (this.#tenantBlockGenerations.get(ticket.tenantId) ?? 0) ||
      ticket.deviceGeneration !== (device?.generation ?? 0) ||
      ticket.seatGeneration !== (seat?.generation ?? 0) ||
      device?.status !== "active" ||
      seat?.status !== "active" ||
      connection.tenantBlockGeneration !== ticket.tenantBlockGeneration ||
      connection.deviceGeneration !== ticket.deviceGeneration ||
      connection.seatGeneration !== ticket.seatGeneration ||
      !sameDurableIdentityAuthority(
        connection.auth,
        ticket.identityAuthority,
      ) ||
      this.#blockedTenants.has(ticket.tenantId) ||
      (options.requireConnectionMembership !== false &&
        this.#connections.get(ticket.connectionId) !== connection) ||
      (session !== undefined &&
        (session.tenantId !== ticket.tenantId ||
          session.deviceId !== ticket.deviceId ||
          session.seatId !== ticket.seatId ||
          session.connectionId !== ticket.connectionId ||
          !sameJson(
            parseSessionIdentityAuthority(session.identityAuthority),
            ticket.identityAuthority,
          ) ||
          (options.requireSessionMembership !== false &&
            (this.#active.get(session.rsid)?.record.connectionId !==
              ticket.connectionId ||
              this.#active.get(session.rsid)?.record.sessionBindingId !==
                session.sessionBindingId))))
    ) {
      throw new GatewayRbpFault(
        "auth",
        "identity authority ticket is stale",
        403,
        4403,
      );
    }
  }

  #ticketScopeIsRevokedOrBlocked(ticket: TenantAuthorityTicket): boolean {
    return (
      this.#blockedTenants.has(ticket.tenantId) ||
      this.#deviceFence(ticket.tenantId, ticket.deviceId)?.status !== "active" ||
      this.#seatFence(ticket.tenantId, ticket.seatId)?.status !== "active"
    );
  }

  public assertConnectionOutbound(connectionId: string): void {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) {
      throw new GatewayRbpFault(
        "auth",
        this.#revokedConnectionIds.has(connectionId)
          ? "connection authority was revoked"
          : "unknown connection",
        this.#revokedConnectionIds.has(connectionId) ? 403 : 404,
        this.#revokedConnectionIds.has(connectionId) ? 4403 : 4401,
      );
    }
    this.#assertAuthorityTicket(
      {
        tenantId: connection.auth.actor.tenantId,
        deviceId: connection.auth.actor.deviceId,
        seatId: connection.auth.actor.seatId,
        connectionId,
        tenantBlockGeneration: connection.tenantBlockGeneration,
        deviceGeneration: connection.deviceGeneration,
        seatGeneration: connection.seatGeneration,
        identityAuthority: durableIdentityAuthority(connection.auth),
      },
      connection,
    );
  }

  #connectionMatchesSnapshot(
    connection: LiveConnection,
    snapshot: TenantIdentitySnapshot,
  ): boolean {
    const auth = connection.auth;
    const durable = durableIdentityAuthority(auth);
    if (durable === null) return false;
    const device = snapshot.devices.get(auth.actor.deviceId);
    const seat = snapshot.seats.get(auth.actor.seatId);
    return (
      device !== undefined &&
      seat !== undefined &&
      device.status === "active" &&
      seat.status === "active" &&
      device.tenantId === auth.actor.tenantId &&
      device.userId === auth.actor.userId &&
      device.seatId === auth.actor.seatId &&
      seat.userId === auth.actor.userId &&
      seat.deviceId === auth.actor.deviceId &&
      machineFingerprintClaimsEqual(
        device.machineFingerprint,
        durable.machineFingerprint,
      ) &&
      device.deviceTokenDigest === durable.deviceTokenDigest &&
      device.authorizationVersion === durable.authorizationVersion &&
      device.recordVersion === durable.identityRecordVersion &&
      device.connectionCapabilityVersion === durable.connectionCapabilityVersion &&
      device.sessionCapabilityVersion === durable.sessionCapabilityVersion &&
      seat.seatAuthorityVersion === durable.seatAuthorityVersion &&
      seat.recordVersion === durable.seatRecordVersion
    );
  }

  #connectionSnapshotDisposition(
    connection: LiveConnection,
    snapshot: TenantIdentitySnapshot,
  ): "current" | "stale_active" | "revoked" {
    if (this.#connectionMatchesSnapshot(connection, snapshot)) return "current";
    const auth = connection.auth;
    const device = snapshot.devices.get(auth.actor.deviceId);
    const seat = snapshot.seats.get(auth.actor.seatId);
    return device !== undefined &&
      seat !== undefined &&
      device.status === "active" &&
      seat.status === "active" &&
      device.userId === auth.actor.userId &&
      device.seatId === auth.actor.seatId &&
      seat.userId === auth.actor.userId &&
      seat.deviceId === auth.actor.deviceId
      ? "stale_active"
      : "revoked";
  }

  #sessionMatchesSnapshot(
    session: DurableRbpSession,
    snapshot: TenantIdentitySnapshot,
  ): boolean {
    const identity = parseSessionIdentityAuthority(session.identityAuthority);
    if (identity === null) return false;
    const device = snapshot.devices.get(session.deviceId);
    const seat = snapshot.seats.get(session.seatId);
    return (
      device !== undefined &&
      seat !== undefined &&
      device.status === "active" &&
      seat.status === "active" &&
      device.userId === session.userId &&
      device.seatId === session.seatId &&
      seat.userId === session.userId &&
      seat.deviceId === session.deviceId &&
      machineFingerprintClaimsEqual(
        device.machineFingerprint,
        identity.machineFingerprint,
      ) &&
      device.deviceTokenDigest === identity.deviceTokenDigest &&
      device.authorizationVersion === identity.authorizationVersion &&
      device.recordVersion === identity.identityRecordVersion &&
      device.connectionCapabilityVersion === identity.connectionCapabilityVersion &&
      device.sessionCapabilityVersion === identity.sessionCapabilityVersion &&
      seat.seatAuthorityVersion === identity.seatAuthorityVersion &&
      seat.recordVersion === identity.seatRecordVersion
    );
  }

  #sessionSnapshotDisposition(
    session: DurableRbpSession,
    snapshot: TenantIdentitySnapshot,
  ): "current" | "stale_active" | "revoked" {
    if (this.#sessionMatchesSnapshot(session, snapshot)) return "current";
    const device = snapshot.devices.get(session.deviceId);
    const seat = snapshot.seats.get(session.seatId);
    return device !== undefined &&
      seat !== undefined &&
      device.status === "active" &&
      seat.status === "active" &&
      device.userId === session.userId &&
      device.seatId === session.seatId &&
      seat.userId === session.userId &&
      seat.deviceId === session.deviceId
      ? "stale_active"
      : "revoked";
  }

  #closeConnectionForRevocation(connection: LiveConnection): void {
    this.#connections.delete(connection.connectionId);
    this.#untrackConnection(connection);
    this.#revokedConnectionIds.add(connection.connectionId);
    while (this.#revokedConnectionIds.size > MAX_REVOKED_CONNECTION_TOMBSTONES) {
      const oldest = this.#revokedConnectionIds.values().next().value;
      if (oldest === undefined) break;
      this.#revokedConnectionIds.delete(oldest);
    }
    let closeOperation: Promise<void>;
    try {
      closeOperation = connection.close(4403, "identity authority revoked");
    } catch {
      closeOperation = Promise.reject(new Error("revocation close threw"));
    }
    void closeOperation
      .catch(() => undefined)
      .finally(() => this.detach(connection.connectionId).catch(() => undefined));
  }

  #suppressSessionWaiters(tenantId: string, rsids: ReadonlySet<string>): void {
    for (const [invocationId, waiter] of this.#waiters) {
      if (waiter.tenantId !== tenantId || !rsids.has(waiter.rsid)) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(invocationId);
      waiter.resolve({
        state: "failed",
        error: {
          code: "executor_unavailable",
          message: "identity revocation suppressed terminal or resource delivery",
        },
      });
    }
  }

  async #revokeIdentitySession(record: DurableRbpSession): Promise<void> {
    const identity = parseSessionIdentityAuthority(record.identityAuthority);
    const synthetic: LiveConnection = {
      connectionId: record.connectionId,
      binding: record.binding,
      auth: {
        contractVersion: "revagent.auth-context/v1",
        actor: {
          type: "device",
          tenantId: record.tenantId,
          userId: record.userId,
          deviceId: record.deviceId,
          seatId: record.seatId,
        },
        connectionId: record.connectionId,
        deviceStatus: "revoked",
        ...(identity === null
          ? {}
          : {
              machineFingerprint: identity.machineFingerprint,
              authorizationVersion: identity.authorizationVersion,
              identityRecordVersion: identity.identityRecordVersion,
              connectionCapabilityVersion: identity.connectionCapabilityVersion,
              sessionCapabilityVersion: identity.sessionCapabilityVersion,
              seatAuthorityVersion: identity.seatAuthorityVersion,
              seatRecordVersion: identity.seatRecordVersion,
              deviceTokenDigest: identity.deviceTokenDigest,
            }),
        grantedSessionCapabilities: record.grantedCapabilities,
        deviceTokenDigest:
          identity?.deviceTokenDigest ?? `sha256:${"0".repeat(64)}`,
      },
      machineHostname: "identity-revocation",
      tenantBlockGeneration:
        this.#tenantBlockGenerations.get(record.tenantId) ?? 0,
      deviceGeneration:
        this.#deviceFence(record.tenantId, record.deviceId)?.generation ?? 0,
      seatGeneration:
        this.#seatFence(record.tenantId, record.seatId)?.generation ?? 0,
      grantedCapabilities: record.grantedCapabilities,
      lifecycle: record.connectionLifecycle,
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };
    await this.#withSessionAuthorization(record.rsid, async () => {
      const existing = await this.#sessionRepository.transact(
        { tenantId: record.tenantId },
        async (tx) =>
          tx.read<GatewayJsonValue>(
            GATEWAY_RBP_UNREGISTER_NAMESPACE,
            record.rsid,
          ),
      );
      if (!existing.ok) {
        throw new GatewayRbpFault(
          "unavailable",
          existing.message,
          503,
          1011,
        );
      }
      if (existing.value !== null) {
        const tombstone = parseUnregisterTombstone(existing.value.value, {
          tenantId: record.tenantId,
          rsid: record.rsid,
          stored: existing.value,
        });
        if (!sameTombstoneOwner(tombstone.owner, record)) {
          throw new GatewayRbpFault(
            "unavailable",
            "identity revocation observed a foreign tombstone owner",
            503,
            1011,
          );
        }
        this.#completeLocalUnregister(
          record.rsid,
          this.#active.get(record.rsid)?.record.pending ?? null,
          tombstone.pendingDisposition === "none",
        );
        return;
      }
      await this.#unregisterNow(synthetic, {
        rsid: record.rsid,
        reason: "session_replaced",
      });
    });
  }

  async #reconcileIdentitySnapshot(
    tenantId: string,
    snapshot: TenantIdentitySnapshot,
    events: readonly IdentityRevocationEventV1[],
  ): Promise<void> {
    const affectedDevices = new Set(
      events.flatMap((event) => event.deviceId === null ? [] : [event.deviceId]),
    );
    const affectedSeats = new Set(
      events.flatMap((event) =>
        event.action === "device_revoked" || event.seatId === null
          ? []
          : [event.seatId],
      ),
    );
    const listed = await this.#sessionRepository.transact(
      { tenantId },
      async (tx) => ({
        sessions: await tx.list(GATEWAY_RBP_SESSION_NAMESPACE),
        tombstones: await tx.list(GATEWAY_RBP_UNREGISTER_NAMESPACE),
      }),
    );
    if (!listed.ok) {
      throw new GatewayRbpFault("unavailable", listed.message, 503, 1011);
    }
    if (
      listed.value.sessions.length > MAX_IDENTITY_SESSION_RESYNC ||
      listed.value.tombstones.length > MAX_IDENTITY_SESSION_RESYNC
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "identity session resync exceeded its bounded record limit",
        503,
        1011,
      );
    }
    const tombstonedRsids = new Set<string>();
    for (const tombstone of listed.value.tombstones) {
      parseUnregisterTombstone(tombstone.value, {
        tenantId,
        rsid: tombstone.key,
        stored: tombstone,
      });
      tombstonedRsids.add(tombstone.key);
    }
    const sessions: DurableRbpSession[] = [];
    for (const stored of listed.value.sessions) {
      const parsed = parseStoredSession(stored, tenantId, stored.key);
      if (tombstonedRsids.has(parsed.rsid)) continue;
      if (
        events.length === 0 ||
        affectedDevices.has(parsed.deviceId) ||
        affectedSeats.has(parsed.seatId) ||
        !this.#sessionMatchesSnapshot(parsed, snapshot)
      ) {
        sessions.push(parsed);
      }
    }
    const revokedRsids = new Set<string>();
    for (const session of sessions) {
      if (this.#sessionSnapshotDisposition(session, snapshot) !== "revoked") {
        continue;
      }
      await this.#revokeIdentitySession(session);
      revokedRsids.add(session.rsid);
    }
    this.#suppressSessionWaiters(tenantId, revokedRsids);
    for (const connection of [...this.#connections.values()]) {
      if (
        connection.auth.actor.tenantId === tenantId &&
        this.#connectionSnapshotDisposition(connection, snapshot) === "revoked"
      ) {
        this.#closeConnectionForRevocation(connection);
      }
    }
  }

  public async synchronizeIdentityRevocations(tenantId: string): Promise<void> {
    this.#assertOpen();
    const identity = this.#productionIdentity;
    if (identity === null) return;
    await this.#withTenantRevocationRun(tenantId, async () => {
      let affectedDevices = new Set<string>();
      let affectedSeats = new Set<string>();
      let wholeTenant = true;
      let tenantBlockGeneration: number | null = null;
      try {
        const phaseOne = await this.#withTenantIdentityAuthority(
          tenantId,
          async () => {
            const events: IdentityRevocationEventV1[] = [];
            let observedHeadSequence = -1;
            let cursorBlocked = false;
            for (let batch = 0; batch < MAX_IDENTITY_EVENT_BATCHES; batch += 1) {
              const consumed = await identity.consumeRevocationEvents({
                tenantId,
                maxEvents: MAX_IDENTITY_EVENT_BATCH,
              });
              if (!consumed.ok) {
                throw new GatewayRbpFault(
                  "unavailable",
                  consumed.message,
                  503,
                  1011,
                );
              }
              observedHeadSequence = consumed.headSequence;
              if (consumed.kind === "blocked") {
                cursorBlocked = true;
                break;
              }
              events.push(...consumed.events);
              if (consumed.complete) break;
              if (batch === MAX_IDENTITY_EVENT_BATCHES - 1) {
                throw new GatewayRbpFault(
                  "unavailable",
                  "identity event consumption exceeded its bounded batch limit",
                  503,
                  1011,
                );
              }
            }
            const currentSnapshot = this.#tenantIdentitySnapshots.get(tenantId);
            let eventStreamCorrupt = false;
            for (let index = 0; index < events.length; index += 1) {
              const event = events[index]!;
              const prior = events[index - 1];
              if (
                event.tenantId !== tenantId ||
                (prior !== undefined && event.sequence !== prior.sequence + 1)
              ) {
                eventStreamCorrupt = true;
                events.splice(0);
                break;
              }
            }
            if (
              !cursorBlocked &&
              !eventStreamCorrupt &&
              events.length === 0 &&
              currentSnapshot !== undefined &&
              currentSnapshot.headSequence === observedHeadSequence
            ) {
              return null;
            }
            wholeTenant =
              cursorBlocked || eventStreamCorrupt || events.length === 0;
            affectedDevices = new Set(
              events.flatMap((event) =>
                event.deviceId === null ? [] : [event.deviceId],
              ),
            );
            affectedSeats = new Set(
              events.flatMap((event) =>
                event.action === "device_revoked" || event.seatId === null
                  ? []
                  : [event.seatId],
              ),
            );
            if (wholeTenant) {
              tenantBlockGeneration =
                this.#advanceTenantBlockGeneration(tenantId);
              this.#blockedTenants.add(tenantId);
            } else {
              this.#applyEventFences(tenantId, events);
            }
            const prepared = await identity.prepareTenantResync({ tenantId });
            if (!prepared.ok) {
              throw new GatewayRbpFault(
                "unavailable",
                prepared.message,
                503,
                1011,
              );
            }
            if (prepared.snapshot.tenantId !== tenantId) {
              throw new GatewayRbpFault(
                "unavailable",
                "identity resync returned a cross-tenant snapshot",
                503,
                1011,
              );
            }
            const snapshot = identitySnapshot(prepared.snapshot);
            if (wholeTenant) {
              for (const device of snapshot.devices.values()) {
                affectedDevices.add(device.deviceId);
              }
              for (const seat of snapshot.seats.values()) {
                affectedSeats.add(seat.seatId);
              }
              for (const connection of this.#connections.values()) {
                if (connection.auth.actor.tenantId !== tenantId) continue;
                affectedDevices.add(connection.auth.actor.deviceId);
                affectedSeats.add(connection.auth.actor.seatId);
              }
              for (const active of this.#active.values()) {
                if (active.tenantId !== tenantId) continue;
                affectedDevices.add(active.record.deviceId);
                affectedSeats.add(active.record.seatId);
              }
            }
            this.#applyScopedSnapshot(snapshot, events, wholeTenant);
            return Object.freeze({
              tenantBlockGeneration,
              wholeTenant,
              snapshot,
              events: Object.freeze([...events]),
              deviceIds: affectedDevices,
              seatIds: affectedSeats,
            });
          },
        );
        if (phaseOne === null) return;
        tenantBlockGeneration = phaseOne.tenantBlockGeneration;
        wholeTenant = phaseOne.wholeTenant;
        affectedDevices = phaseOne.deviceIds;
        affectedSeats = phaseOne.seatIds;

        // No tenant lock is held while rsid tails are acquired one at a time.
        await this.#reconcileIdentitySnapshot(
          tenantId,
          phaseOne.snapshot,
          phaseOne.events,
        );

        await this.#withTenantIdentityAuthority(tenantId, async () => {
          if (
            phaseOne.wholeTenant &&
            this.#tenantBlockGenerations.get(tenantId) !==
              phaseOne.tenantBlockGeneration
          ) {
            throw new GatewayRbpFault(
              "unavailable",
              "tenant block generation changed during resync",
              503,
              1011,
            );
          }
          const committed = await identity.commitTenantResync({
            tenantId,
            expectedAuthorityDigest: phaseOne.snapshot.authorityDigest,
          });
          if (!committed.ok) {
            throw new GatewayRbpFault(
              "unavailable",
              committed.message,
              503,
              1011,
            );
          }
          if (
            committed.snapshot.tenantId !== tenantId ||
            committed.snapshot.authorityDigest !==
              phaseOne.snapshot.authorityDigest ||
            committed.cursor.tenantId !== tenantId ||
            committed.cursor.status !== "current" ||
            committed.cursor.lastContiguousSequence !==
              committed.snapshot.headSequence
          ) {
            throw new GatewayRbpFault(
              "unavailable",
              "identity resync commit returned incoherent authority",
              503,
              1011,
            );
          }
          const committedSnapshot = identitySnapshot(committed.snapshot);
          this.#applyScopedSnapshot(
            committedSnapshot,
            phaseOne.events,
            phaseOne.wholeTenant,
          );
          this.#tenantIdentitySnapshots.set(
            tenantId,
            committedSnapshot,
          );
          if (phaseOne.wholeTenant) this.#blockedTenants.delete(tenantId);
        });
      } catch (error: unknown) {
        await this.#withTenantIdentityAuthority(tenantId, async () => {
          if (wholeTenant) {
            if (tenantBlockGeneration === null) {
              tenantBlockGeneration =
                this.#advanceTenantBlockGeneration(tenantId);
            }
            this.#blockedTenants.add(tenantId);
          }
        });
        for (const connection of [...this.#connections.values()]) {
          if (
            connection.auth.actor.tenantId === tenantId &&
            (wholeTenant ||
              affectedDevices.has(connection.auth.actor.deviceId) ||
              affectedSeats.has(connection.auth.actor.seatId))
          ) {
            this.#closeConnectionForRevocation(connection);
          }
        }
        throw error;
      }
    });
  }

  async #reconcileExplicitIdentityRevocation(input: {
    readonly tenantId: string;
    readonly kind: "device" | "seat";
    readonly deviceId?: string;
    readonly seatId?: string;
    readonly affectedDeviceIds: ReadonlySet<string>;
  }): Promise<void> {
    const listed = await this.#sessionRepository.transact(
      { tenantId: input.tenantId },
      async (tx) => ({
        sessions: await tx.list(GATEWAY_RBP_SESSION_NAMESPACE),
        tombstones: await tx.list(GATEWAY_RBP_UNREGISTER_NAMESPACE),
      }),
    );
    if (!listed.ok) {
      throw new GatewayRbpFault("unavailable", listed.message, 503, 1011);
    }
    if (
      listed.value.sessions.length > MAX_IDENTITY_SESSION_RESYNC ||
      listed.value.tombstones.length > MAX_IDENTITY_SESSION_RESYNC
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "identity revocation exceeded its bounded session limit",
        503,
        1011,
      );
    }
    const tombstoned = new Set<string>();
    for (const row of listed.value.tombstones) {
      parseUnregisterTombstone(row.value, {
        tenantId: input.tenantId,
        rsid: row.key,
        stored: row,
      });
      tombstoned.add(row.key);
    }
    const revokedRsids = new Set<string>();
    for (const stored of listed.value.sessions) {
      const session = parseStoredSession(stored, input.tenantId, stored.key);
      if (
        tombstoned.has(session.rsid) ||
        (input.kind === "device" &&
          !input.affectedDeviceIds.has(session.deviceId)) ||
        (input.kind === "seat" &&
          session.seatId !== input.seatId &&
          !input.affectedDeviceIds.has(session.deviceId))
      ) {
        continue;
      }
      // No tenant tail is held while this rsid tail is acquired.
      await this.#revokeIdentitySession(session);
      revokedRsids.add(session.rsid);
    }
    this.#suppressSessionWaiters(input.tenantId, revokedRsids);
    const connectionIds = new Set<string>();
    for (const deviceId of input.affectedDeviceIds) {
      for (const connectionId of
        this.#deviceConnections.get(identityIndexKey(input.tenantId, deviceId)) ?? []) {
        connectionIds.add(connectionId);
      }
    }
    if (input.kind === "seat" && input.seatId !== undefined) {
      for (const connectionId of
        this.#seatConnections.get(
          identityIndexKey(input.tenantId, input.seatId),
        ) ?? []) {
        connectionIds.add(connectionId);
      }
    }
    for (const connectionId of connectionIds) {
      const connection = this.#connections.get(connectionId);
      if (connection !== undefined) this.#closeConnectionForRevocation(connection);
    }
  }

  public async revokeIdentityAuthority(input: {
    readonly tenantId: string;
    readonly kind?: "device" | "seat";
    readonly deviceId: string;
    readonly seatId: string;
    readonly authorizationVersion: number;
    readonly identityRecordVersion: number;
    readonly connectionCapabilityVersion: number;
    readonly sessionCapabilityVersion: number;
    readonly seatAuthorityVersion?: number;
    readonly seatRecordVersion?: number;
  }): Promise<void> {
    this.#assertOpen();
    const kind = input.kind ?? "device";
    if (
      input.tenantId.length === 0 ||
      input.deviceId.length === 0 ||
      input.seatId.length === 0 ||
      input.authorizationVersion === undefined ||
      input.identityRecordVersion === undefined ||
      input.connectionCapabilityVersion === undefined ||
      input.sessionCapabilityVersion === undefined ||
      (kind === "seat" &&
        (input.seatAuthorityVersion === undefined ||
          input.seatRecordVersion === undefined)) ||
      [
        input.authorizationVersion,
        input.identityRecordVersion,
        input.connectionCapabilityVersion,
        input.sessionCapabilityVersion,
        input.seatAuthorityVersion,
        input.seatRecordVersion,
      ].some((version) =>
        version !== undefined && !isSafePositiveInteger(version),
      )
    ) {
      throw new GatewayRbpFault("auth", "identity revocation scope is invalid", 403, 4403);
    }
    await this.#withTenantRevocationRun(input.tenantId, async () => {
      const affectedDeviceIds = new Set<string>();
      let phaseMutated = false;
      try {
        const phase = await this.#withTenantIdentityAuthority(
          input.tenantId,
          async () => {
            const deviceNotificationIsStaleOrReplay = (
              deviceId: string,
            ): "advance" | "noop" => {
              const prior = this.#deviceFence(input.tenantId, deviceId);
              if (prior?.authorizationVersion !== null &&
                  prior?.authorizationVersion !== undefined) {
                if (input.authorizationVersion! < prior.authorizationVersion) {
                  return "noop";
                }
                if (input.authorizationVersion === prior.authorizationVersion) {
                  const exactReplay =
                    prior.status === "revoked" &&
                    prior.reason ===
                      (kind === "seat" ? "seat_revoked" : "device_revoked") &&
                    prior.identityRecordVersion === input.identityRecordVersion &&
                    prior.connectionCapabilityVersion ===
                      input.connectionCapabilityVersion &&
                    prior.sessionCapabilityVersion ===
                      input.sessionCapabilityVersion &&
                    prior.seatId === input.seatId;
                  if (exactReplay) return "noop";
                  throw new GatewayRbpFault(
                    "auth",
                    "equal device authority version conflicts with existing state",
                    409,
                    4403,
                  );
                }
                if (
                  (prior.identityRecordVersion !== null &&
                    input.identityRecordVersion! <= prior.identityRecordVersion) ||
                  (prior.connectionCapabilityVersion !== null &&
                    input.connectionCapabilityVersion <
                      prior.connectionCapabilityVersion) ||
                  (prior.sessionCapabilityVersion !== null &&
                    input.sessionCapabilityVersion <
                      prior.sessionCapabilityVersion)
                ) {
                  throw new GatewayRbpFault(
                    "auth",
                    "device authority versions are not coherently increasing",
                    409,
                    4403,
                  );
                }
              }
              return "advance";
            };
            if (kind === "seat") {
              const prior = this.#seatFence(input.tenantId, input.seatId!);
              if (prior?.seatAuthorityVersion !== null &&
                  prior?.seatAuthorityVersion !== undefined) {
                if (input.seatAuthorityVersion! < prior.seatAuthorityVersion) {
                  return "noop" as const;
                }
                if (input.seatAuthorityVersion === prior.seatAuthorityVersion) {
                  const priorDevice =
                    input.deviceId === undefined
                      ? null
                      : this.#deviceFence(input.tenantId, input.deviceId);
                  const exactReplay =
                    prior.status === "revoked" &&
                    prior.reason === "seat_revoked" &&
                    prior.seatRecordVersion === input.seatRecordVersion &&
                    input.deviceId !== undefined &&
                    prior.deviceId === input.deviceId &&
                    priorDevice?.status === "revoked" &&
                    priorDevice.reason === "seat_revoked" &&
                    priorDevice.authorizationVersion ===
                      input.authorizationVersion &&
                    priorDevice.identityRecordVersion ===
                      input.identityRecordVersion &&
                    priorDevice.connectionCapabilityVersion ===
                      input.connectionCapabilityVersion &&
                    priorDevice.sessionCapabilityVersion ===
                      input.sessionCapabilityVersion;
                  if (exactReplay) return "noop" as const;
                  throw new GatewayRbpFault(
                    "auth",
                    "equal seat authority version conflicts with existing state",
                    409,
                    4403,
                  );
                }
                if (
                  prior.seatRecordVersion !== null &&
                  input.seatRecordVersion! <= prior.seatRecordVersion
                ) {
                  throw new GatewayRbpFault(
                    "auth",
                    "seat authority versions are not coherently increasing",
                    409,
                    4403,
                  );
                }
              }
            }
            if (input.deviceId !== undefined) {
              affectedDeviceIds.add(input.deviceId);
            }
            if (kind === "seat") {
              const seatKey = identityIndexKey(input.tenantId, input.seatId!);
              for (const connectionId of this.#seatConnections.get(seatKey) ?? []) {
                const connection = this.#connections.get(connectionId);
                if (connection !== undefined) {
                  affectedDeviceIds.add(connection.auth.actor.deviceId);
                }
              }
              for (const rsid of this.#seatSessions.get(seatKey) ?? []) {
                const active = this.#active.get(rsid);
                if (active !== undefined) {
                  affectedDeviceIds.add(active.record.deviceId);
                }
              }
              const snapshotSeat = this.#tenantIdentitySnapshots
                .get(input.tenantId)
                ?.seats.get(input.seatId!);
              if (snapshotSeat?.deviceId !== null && snapshotSeat?.deviceId !== undefined) {
                affectedDeviceIds.add(snapshotSeat.deviceId);
              }
            }
            for (const deviceId of affectedDeviceIds) {
              if (deviceNotificationIsStaleOrReplay(deviceId) === "noop") {
                return "noop" as const;
              }
            }
            phaseMutated = true;
            for (const deviceId of affectedDeviceIds) {
              const prior = this.#deviceFence(input.tenantId, deviceId);
              this.#setDeviceAuthorityFence(input.tenantId, deviceId, {
                status: "blocked",
                authorizationVersion:
                  deviceId === input.deviceId
                    ? input.authorizationVersion ??
                      prior?.authorizationVersion ?? null
                    : prior?.authorizationVersion ?? null,
                identityRecordVersion:
                  deviceId === input.deviceId
                    ? input.identityRecordVersion ??
                      prior?.identityRecordVersion ?? null
                    : prior?.identityRecordVersion ?? null,
                connectionCapabilityVersion:
                  input.connectionCapabilityVersion,
                sessionCapabilityVersion:
                  input.sessionCapabilityVersion,
                seatId: input.seatId ?? prior?.seatId ?? null,
                reason: kind === "seat" ? "seat_revoked" : "device_revoked",
              });
            }
            if (kind === "seat") {
              const prior = this.#seatFence(input.tenantId, input.seatId!);
              this.#setSeatAuthorityFence(input.tenantId, input.seatId!, {
                status: "blocked",
                seatAuthorityVersion:
                  input.seatAuthorityVersion ??
                  prior?.seatAuthorityVersion ?? null,
                seatRecordVersion:
                  input.seatRecordVersion ?? prior?.seatRecordVersion ?? null,
                deviceId: input.deviceId ?? prior?.deviceId ?? null,
                reason: "seat_revoked",
              });
            }
            return "advance" as const;
          },
        );
        if (phase === "noop") return;
        await this.#reconcileExplicitIdentityRevocation({
          ...input,
          kind,
          affectedDeviceIds,
        });
        await this.#withTenantIdentityAuthority(input.tenantId, async () => {
          for (const deviceId of affectedDeviceIds) {
            const prior = this.#deviceFence(input.tenantId, deviceId);
            this.#setDeviceAuthorityFence(input.tenantId, deviceId, {
              status: "revoked",
              authorizationVersion: prior?.authorizationVersion ?? null,
              identityRecordVersion: prior?.identityRecordVersion ?? null,
              connectionCapabilityVersion:
                prior?.connectionCapabilityVersion ?? null,
              sessionCapabilityVersion: prior?.sessionCapabilityVersion ?? null,
              seatId: prior?.seatId ?? input.seatId ?? null,
              reason: kind === "seat" ? "seat_revoked" : "device_revoked",
            });
          }
          if (kind === "seat") {
            const prior = this.#seatFence(input.tenantId, input.seatId!);
            this.#setSeatAuthorityFence(input.tenantId, input.seatId!, {
              status: "revoked",
              seatAuthorityVersion: prior?.seatAuthorityVersion ?? null,
              seatRecordVersion: prior?.seatRecordVersion ?? null,
              deviceId: prior?.deviceId ?? input.deviceId ?? null,
              reason: "seat_revoked",
            });
          }
        });
      } catch (error: unknown) {
        for (const connection of phaseMutated
          ? [...this.#connections.values()]
          : []) {
          if (
            connection.auth.actor.tenantId === input.tenantId &&
            (affectedDeviceIds.has(connection.auth.actor.deviceId) ||
              (kind === "seat" &&
                connection.auth.actor.seatId === input.seatId))
          ) {
            this.#closeConnectionForRevocation(connection);
          }
        }
        throw error;
      }
    });
  }

  #sameConnectionPrincipal(
    expected: DeviceAuthContext,
    current: DeviceAuthContext,
  ): boolean {
    return (
      current.deviceStatus === "active" &&
      current.actor.tenantId === expected.actor.tenantId &&
      current.actor.userId === expected.actor.userId &&
      current.actor.deviceId === expected.actor.deviceId &&
      current.actor.seatId === expected.actor.seatId &&
      current.deviceTokenDigest === expected.deviceTokenDigest &&
      (expected.machineFingerprint === undefined ||
        machineFingerprintClaimsEqual(
          expected.machineFingerprint,
          current.machineFingerprint,
        ))
    );
  }

  #connectionScopedAuthorityIsActive(connection: LiveConnection): boolean {
    const tenantId = connection.auth.actor.tenantId;
    return (
      !this.#blockedTenants.has(tenantId) &&
      this.#deviceFence(tenantId, connection.auth.actor.deviceId)?.status ===
        "active" &&
      this.#seatFence(tenantId, connection.auth.actor.seatId)?.status ===
        "active"
    );
  }

  async #assertCurrentConnectionAuthority(
    connection: LiveConnection,
  ): Promise<TenantAuthorityTicket> {
    return await this.#acquireConnectionAuthorityTicket(connection);
  }

  #connectionIsCurrentlyAuthorized(connection: LiveConnection | undefined): boolean {
    if (connection === undefined || connection.auth.deviceStatus !== "active") {
      return false;
    }
    const tenantId = connection.auth.actor.tenantId;
    const device = this.#deviceFence(tenantId, connection.auth.actor.deviceId);
    const seat = this.#seatFence(tenantId, connection.auth.actor.seatId);
    if (
      this.#blockedTenants.has(tenantId) ||
      device?.status !== "active" ||
      seat?.status !== "active" ||
      connection.tenantBlockGeneration !==
        (this.#tenantBlockGenerations.get(tenantId) ?? 0) ||
      connection.deviceGeneration !== device.generation ||
      connection.seatGeneration !== seat.generation
    ) return false;
    if (this.#productionIdentity === null) return true;
    const snapshot = this.#tenantIdentitySnapshots.get(tenantId);
    return snapshot !== undefined && this.#connectionMatchesSnapshot(connection, snapshot);
  }

  public async openConnection(input: {
    readonly deviceToken: string | undefined;
    readonly binding: BindingKind;
    readonly hello: HelloEnvelope;
    readonly channel: BridgeConnectionChannel;
  }): Promise<BridgeConnectionOpening> {
    this.#assertOpen();
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
      claimedDeviceId: input.hello.payload.device_id,
      machineFingerprint: input.hello.payload.machine.fingerprint,
      machineHostname: input.hello.payload.machine.hostname,
    });
    if (!authenticated.ok) {
      const claimBoundRefusal =
        (this.identity.kind === "preproduction" ||
          this.#productionIdentity !== null) &&
        isCanonicalMachineFingerprint(input.hello.payload.machine.fingerprint);
      throw new GatewayRbpFault(
        "auth",
        authenticated.message,
        claimBoundRefusal ? 403 : 401,
        claimBoundRefusal ? 4403 : 4401,
      );
    }
    if (authenticated.value.deviceStatus !== "active") {
      throw new GatewayRbpFault("auth", "device or seat is not active", 403, 4403);
    }
    if (authenticated.value.actor.deviceId !== input.hello.payload.device_id) {
      throw new GatewayRbpFault("auth", "hello device identity does not match credential", 403, 4403);
    }
    const granted = grantCapabilities(
      IMPLEMENTED_CONNECTION_CAPABILITIES,
      authenticated.value.grantedConnectionCapabilities,
      input.hello.payload.capabilities,
    ).filter((capability) =>
      (capability !== "chunked_results" && capability !== "artifact_result_v1") ||
      this.#carrierReady(),
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
      machineHostname: input.hello.payload.machine.hostname,
      tenantBlockGeneration: 0,
      deviceGeneration: 0,
      seatGeneration: 0,
      grantedCapabilities: granted,
      lifecycle: steadyConnectionLifecycle(granted),
      async send(serialized): Promise<void> {
        await input.channel.send(serialized);
      },
      ...(input.channel.sendDispatchStarted === undefined ? {} : {
        sendDispatchStarted(serialized: string, handoff: DispatchTransportHandoff) {
          return input.channel.sendDispatchStarted!(serialized, handoff);
        },
      }),
      async close(code, reason): Promise<void> {
        await input.channel.close(code, reason);
      },
    };
    const authorityTicket = await this.#acquireConnectionAuthorityTicket(
      connection,
      { requireMembership: false },
    );
    this.#assertAuthorityTicket(authorityTicket, connection, {
      requireConnectionMembership: false,
    });
    this.#connections.set(connectionId, connection);
    this.#trackConnection(connection);
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
    this.#assertOpen();
    const connection = this.#connections.get(connectionId);
    if (connection === undefined) {
      if (this.#revokedConnectionIds.has(connectionId)) {
        throw new GatewayRbpFault("auth", "connection authority was revoked", 403, 4403);
      }
      throw new GatewayRbpFault("auth", "unknown connection", 404, 4401);
    }
    try {
      await this.#assertCurrentConnectionAuthority(connection);
    } catch (error: unknown) {
      if (!this.#connectionScopedAuthorityIsActive(connection)) throw error;
      // Active higher-version authority may refresh an HTTP credential because
      // this boundary still has the raw bearer. WSS never retains that bearer.
    }
    const priorAuth = connection.auth;
    const authenticated = await this.identity.authenticateDevice({
      deviceToken,
      connectionId,
      claimedDeviceId: priorAuth.actor.deviceId,
      establishedScope: {
        tenantId: priorAuth.actor.tenantId,
        deviceId: priorAuth.actor.deviceId,
      },
      machineFingerprint: priorAuth.machineFingerprint,
      machineHostname: connection.machineHostname,
    });
    if (
      !authenticated.ok ||
      !this.#sameConnectionPrincipal(priorAuth, authenticated.value)
    ) {
      throw new GatewayRbpFault("auth", "connection credential mismatch", 403, 4403);
    }
    connection.auth = { ...authenticated.value, connectionId };
    const authorityTicket = await this.#assertCurrentConnectionAuthority(connection);
    this.#assertAuthorityTicket(authorityTicket, connection);
    return connection;
  }

  public async receive(
    connectionId: string,
    envelope: RbpEnvelope,
  ): Promise<void> {
    this.#assertOpen();
    // Heartbeats do not consume the per-rsid carrier tail. They retain their
    // own durable authorization path and remain serviceable while a large
    // receipt is awaiting object-store durability.
    if (envelope.type === "heartbeat") {
      await this.#receiveNow(connectionId, envelope);
      return;
    }
    if (envelope.type === "partial" && envelope.payload.kind === "chunk") {
      this.#assertCarrierPartialAdmissionBeforeQueue(connectionId, envelope);
    }
    let carrierBytes = 0;
    let rsid: string | null = null;
    if (envelope.type === "partial" && envelope.payload.kind === "chunk") {
      carrierBytes = Buffer.byteLength(envelope.payload.data, "base64");
      rsid = envelope.rsid;
    }
    if (rsid !== null) {
      const queued = this.#rsidCarrierReceiveTailBytes.get(rsid) ?? 0;
      if (queued + carrierBytes > MAX_RSID_CARRIER_RECEIVE_TAIL_BYTES) {
        throw new GatewayRbpFault(
          "unavailable",
          "carrier receive tail exceeds the 8 MiB per-rsid limit",
          503,
          1013,
        );
      }
      this.#rsidCarrierReceiveTailBytes.set(rsid, queued + carrierBytes);
      this.#carrierReceiveTailObserver?.({
        stage: "tail_installed",
        rsid,
        queuedBytes: queued + carrierBytes,
      });
    }
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
      if (rsid !== null) {
        const remaining = (this.#rsidCarrierReceiveTailBytes.get(rsid) ?? 0) - carrierBytes;
        if (remaining > 0) this.#rsidCarrierReceiveTailBytes.set(rsid, remaining);
        else this.#rsidCarrierReceiveTailBytes.delete(rsid);
        this.#carrierReceiveTailObserver?.({
          stage: "tail_released",
          rsid,
          queuedBytes: Math.max(remaining, 0),
        });
      }
      release();
      if (this.#receiveTails.get(connectionId) === tail) {
        this.#receiveTails.delete(connectionId);
      }
    }
  }

  /** In-memory-only admission check; no decoder, tail, or durable state is touched. */
  #assertCarrierPartialAdmissionBeforeQueue(
    connectionId: string,
    envelope: Extract<RbpEnvelope, { type: "partial"; rsid: string }>,
  ): void {
    const active = this.#active.get(envelope.rsid);
    const connection = this.#connections.get(connectionId);
    if (
      active === undefined ||
      connection === undefined ||
      active.record.connectionId !== connectionId ||
      active.tenantId !== connection.auth.actor.tenantId
    ) {
      return;
    }
    const partial = envelope.payload as { readonly stream_id: string };
    const requiresArtifactCapability = partial.stream_id.startsWith("artifact:");
    if (
      !connection.grantedCapabilities.includes("chunked_results") ||
      (requiresArtifactCapability &&
        !connection.grantedCapabilities.includes("artifact_result_v1")) ||
      !this.#carrierReady()
    ) {
      this.#carrierReceiveTailObserver?.({
        stage: "denied_prequeue",
        rsid: envelope.rsid,
        queuedBytes: this.#rsidCarrierReceiveTailBytes.get(envelope.rsid) ?? 0,
      });
      throw new GatewayRbpFault("unsupported", "chunk carrier was not granted", 403, 4403);
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
    const authorityTicket = await this.#assertCurrentConnectionAuthority(connection);
    this.#assertAuthorityTicket(authorityTicket, connection);
    switch (envelope.type) {
      case "session_register":
        await this.#register(connection, envelope.payload, authorityTicket);
        return;
      case "session_resume":
        await this.#resume(connection, envelope.payload, authorityTicket);
        return;
      case "session_unregister":
        await this.#unregister(connection, envelope.payload, authorityTicket);
        return;
      case "heartbeat":
        await this.#heartbeat(connection, envelope.payload.acks, authorityTicket);
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
        try {
          await this.#withSessionAuthorization(envelope.rsid, async () =>
            this.#acceptData(
              connection,
              envelope as Extract<RbpEnvelope, { rsid: string }>,
              authorityTicket,
            ),
          );
          if (envelope.type === "doc_context_update") {
            // Production RBP ingress has already parsed this payload through
            // parseRbpFrame, including recursive duplicate-key rejection.
            // Never compute a correlate from a last-wins JSON.parse value at
            // an unguarded admission boundary.
            this.#observeDocumentContext(envelope.seq, documentContextDigest(
              envelope.payload as unknown as JsonValue,
            ));
          }
        } catch (error) {
          throw error;
        }
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

  #observeDocumentContext(
    sequence: number,
    contextDigest: string,
  ): void {
    if (!isDocumentContextDigest(contextDigest)) return;
    try {
      this.#documentContextObserver?.(Object.freeze({
        stage: "accepted",
        sequence,
        contextDigest,
      }));
    } catch {
      // Diagnostic sinks cannot affect protocol acceptance or acknowledgement.
    }
  }

  public async detach(connectionId: string): Promise<void> {
    const connection = this.#connections.get(connectionId);
    this.#connections.delete(connectionId);
    if (connection !== undefined) this.#untrackConnection(connection);
    for (const [rsid, active] of this.#active) {
      if (active.record.connectionId === connectionId) {
        await this.#markConnectionLost(active);
        this.#active.delete(rsid);
        this.#untrackSession(active.record);
      }
    }
  }

  public async sweepLiveness(): Promise<readonly string[]> {
    this.#assertOpen();
    for (const tenantId of [...this.#knownTenants]) {
      await this.synchronizeIdentityRevocations(tenantId);
    }
    const disconnected: string[] = [];
    for (const [rsid, active] of this.#active) {
      const silenceMs = Math.max(0, this.#clock() - active.record.lastHeartbeatAtMs);
      if (silenceMs < RBP_HEARTBEAT_DEGRADED_AFTER_MS) continue;
      const connection = this.#connections.get(active.record.connectionId);
      if (connection === undefined) continue;
      const authorityTicket = await this.#acquireConnectionAuthorityTicket(connection);
      const updated = await this.#withSessionAuthorization(rsid, async () => {
        this.#assertAuthorityTicket(authorityTicket, connection, {
          session: active.record,
        });
        const next = await this.#updateSession(active.tenantId, rsid, (record) => ({
          ...record,
          connectionLifecycle: connectionTransition(record.connectionLifecycle, {
            type: "heartbeat_silence",
            silenceMs,
          }),
          updatedAtMs: this.#clock(),
        }));
        try {
          this.#assertAuthorityTicket(authorityTicket, connection, {
            session: next,
          });
        } catch (error: unknown) {
          if (this.#ticketScopeIsRevokedOrBlocked(authorityTicket)) {
            await this.#revokeStaleAuthorizedSession(connection, rsid);
          }
          throw error;
        }
        return next;
      });
      active.record = updated;
      if (silenceMs >= RBP_HEARTBEAT_DISCONNECTED_AFTER_MS) {
        disconnected.push(rsid);
        this.#active.delete(rsid);
        this.#untrackSession(active.record);
      }
    }
    return disconnected;
  }

  public createExecutor(): GatewayExecutor {
    return new BridgeSessionExecutor(this);
  }

  /**
   * Returns one current, already-authorized route in digest-only form for the
   * conformance audit join. This method cannot create, select, dispatch, or
   * recover a route: ambiguity and liveness loss return null.
   */
  public readCurrentDocumentRouteAuditSnapshot(input: {
    readonly tenantId: string;
  }): GatewayCurrentDocumentRouteAuditSnapshot | null {
    const candidates = [...this.#active.values()].filter((active) => {
      const record = active.record;
      const connection = this.#connections.get(record.connectionId);
      return record.tenantId === input.tenantId &&
        this.#connectionIsCurrentlyAuthorized(connection) &&
        record.sessionLifecycle.dispatchAllowed &&
        (record.connectionLifecycle.phase === "steady" ||
          record.connectionLifecycle.phase === "degraded") &&
        record.liveDocumentRoute !== null &&
        record.liveDocumentRoute !== undefined &&
        record.liveDocumentRoute.observedConnectionId === record.connectionId;
    });
    if (candidates.length !== 1) return null;
    const record = candidates[0]!.record;
    const route = record.liveDocumentRoute!;
    if (!isDocumentContextDigest(route.contextDigest) ||
        !isSafePositiveInteger(record.recordVersion)) return null;
    try {
      return Object.freeze({
        rsidHash: digest(record.rsid),
        observedSequence: route.observedSequence,
        contextDigest: route.contextDigest,
        routeDigest: digest(canonicalizeJson(route as unknown as JsonValue)),
        recordDigest: digest(canonicalizeJson(record as unknown as JsonValue)),
        sessionBindingDigest: digest(canonicalizeJson({
          sessionBindingId: record.sessionBindingId,
          sessionVersion: record.sessionVersion,
        })),
        connectionDigest: digest(canonicalizeJson({
          binding: record.binding,
          connectionId: record.connectionId,
        })),
        sessionRecordVersion: record.recordVersion,
      });
    } catch {
      return null;
    }
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
    readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  }): GatewayInvocationRoute {
    const candidates = [...this.#active.values()].filter((active) => {
      const record = active.record;
      const connection = this.#connections.get(record.connectionId);
      return (
        record.tenantId === input.tenantId &&
        record.userId === input.userId &&
        record.deviceId === input.deviceId &&
        this.#connectionIsCurrentlyAuthorized(connection) &&
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
    // Keep the principal binding off legacy route serializations while making
    // it an own, immutable field for the dispatcher authority check.
    const route = {
      tenantId: input.tenantId,
      mcpSessionId: input.effectiveMcpRequestScope.effectiveMcpSessionId,
      effectiveMcpRequestScope: input.effectiveMcpRequestScope,
      rsid: selected.rsid,
      documentIdentity: {
        kind: "live",
        session_document_id: selected.liveDocumentRoute!.sessionDocumentId,
      },
    } as GatewayInvocationRoute;
    Object.defineProperty(route, "principalKey", {
      value: input.effectiveMcpRequestScope.principalKey,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return Object.freeze(route);
  }

  public buildEnvelope(request: GatewayExecutorRequest): {
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: InvokeEnvelope;
    readonly expected: GatewayExpectedMutationDispatch;
  } {
    const active = this.#active.get(request.context.rsid);
    const connection = active === undefined
      ? undefined
      : this.#connections.get(active.record.connectionId);
    if (
      active === undefined ||
      active.tenantId !== request.context.actor.tenantId ||
      !this.#connectionIsCurrentlyAuthorized(connection)
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
    const connection = active === undefined
      ? undefined
      : this.#connections.get(active.record.connectionId);
    if (
      active === undefined ||
      active.tenantId !== first.context.actor.tenantId ||
      !this.#connectionIsCurrentlyAuthorized(connection) ||
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
      effectiveMcpRequestScope: request.context.effectiveMcpRequestScope,
      dispatchContext: request.context,
      recoveryDispatch: prepared ?? null,
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
      effectiveMcpRequestScope: first.context.effectiveMcpRequestScope,
      dispatchContext: first.context,
      recoveryDispatch: prepared,
      envelope: prepared.envelope,
      journalRecords: prepared.journalRecords,
    });
  }

  async #executeDispatch(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly correlationId: string;
    readonly mutating: boolean;
    readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1 | undefined;
    readonly dispatchContext: GatewayExecutorRequest["context"];
    readonly recoveryDispatch: GatewayRecoveryPendingDispatch | null;
    readonly envelope: unknown;
    readonly journalRecords: readonly InvocationJournalRecord[];
  }): Promise<GatewayExecutorOutcome> {
    const active = this.#active.get(input.rsid);
    const connection = active === undefined
      ? undefined
      : this.#connections.get(active.record.connectionId);
    if (
      active === undefined ||
      active.tenantId !== input.tenantId ||
      connection === undefined
    ) {
      return this.#indeterminateOutcome(input.mutating);
    }
    let authorityTicket: TenantAuthorityTicket;
    try {
      authorityTicket = await this.#acquireConnectionAuthorityTicket(connection);
    } catch {
      return {
        state: "failed",
        error: {
          code: "executor_unavailable",
          message: "identity authority denied dispatch",
        },
      };
    }
    const started = await this.#withSessionAuthorization(input.rsid, async () =>
      this.#beginDispatch(input, connection, authorityTicket),
    );
    // The per-rsid authorization tail protects selection/authentication and
    // the durable reservation commit only.  Carrier start can await a bounded
    // queue/revalidation and must not prevent this same authority from
    // unregistering that exact reserved lease.
    return await started.start();
  }

  async #beginDispatch(
    input: {
      readonly tenantId: string;
      readonly rsid: string;
      readonly correlationId: string;
      readonly mutating: boolean;
      readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1 | undefined;
      readonly dispatchContext: GatewayExecutorRequest["context"];
      readonly recoveryDispatch: GatewayRecoveryPendingDispatch | null;
      readonly envelope: unknown;
      readonly journalRecords: readonly InvocationJournalRecord[];
    },
    connection: LiveConnection,
    authorityTicket: TenantAuthorityTicket,
  ): Promise<{ readonly start: () => Promise<GatewayExecutorOutcome> }> {
    const active = this.#active.get(input.rsid);
    if (active === undefined || active.tenantId !== input.tenantId) {
      return { start: async () => ({ state: "failed", error: { code: "executor_unavailable", message: "registered rsid is not active" } }) };
    }
    try {
      this.#assertAuthorityTicket(authorityTicket, connection, {
        session: active.record,
      });
    } catch {
      return {
        start: async () => ({
          state: "failed",
          error: {
            code: "executor_unavailable",
            message: "identity authority denied dispatch",
          },
        }),
      };
    }
    const envelope = input.envelope as InvokeEnvelope | InvokeBatchEnvelope;
    const expectedDigest = immutableEnvelopeDigest(envelope);
    const journals = input.recoveryDispatch?.originRedelivery === true
      ? input.journalRecords
      : input.journalRecords.map(markJournalExecuting);
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
    const holdCandidates = normalizedHoldCandidates(
      input.rsid,
      mutationEntries,
    );
    const ownHoldIds = new Set(holdCandidates.map((candidate) => candidate.holdId));
    const recovery = trustedRecoveryAdmission(
      input.recoveryDispatch,
      envelope,
      mutationEntries,
      expectedDigest,
      input.mutating,
    );
    // A dispatch proof is minted only after the authenticated connection,
    // immutable effective scope, and current live route have all been
    // selected.  It is process-local object identity; only these digests are
    // persisted, never proof material.
    if (
      input.effectiveMcpRequestScope === undefined
    ) {
      return { start: async () => ({ state: "failed", error: {
        code: "executor_unavailable",
        message: "dispatch lacks an authoritative effective scope",
      } }) };
    }
    const effectiveMcpRequestScope = input.effectiveMcpRequestScope;
    const proofPolicy: JsonValue = {
      class: input.dispatchContext.policyClass,
      decision: input.dispatchContext.policyDecision,
      confirmation_id: input.dispatchContext.confirmationId,
      preview_invocation_id: input.dispatchContext.originatingPreviewInvocationId,
    };
    const dispatchProof = this.#dispatchProofAuthority.mint({
      tenantId: input.tenantId,
      rsid: input.rsid,
      effectiveMcpSessionId: input.effectiveMcpRequestScope.effectiveMcpSessionId,
      sessionBindingId: active.record.sessionBindingId,
      connectionId: active.record.connectionId,
      routeSnapshot: {
        live: active.record.liveDocumentRoute,
        document: input.dispatchContext.documentIdentity,
      } as unknown as JsonValue,
      documentHash: digest(canonicalizeJson(input.dispatchContext.documentIdentity as unknown as JsonValue)),
      documentSequence: active.record.liveDocumentRoute?.observedSequence ?? active.record.sequence.lastRxSeq,
      documentAck: active.record.sequence.lastRxSeq,
      gatewayProcessEpoch: this.#instanceId,
      gatewayProcessOrdinal: sessionEgressFence(active.record).epoch,
      effectiveScope: input.effectiveMcpRequestScope as unknown as JsonValue,
      invocationId: input.correlationId,
      correlationId: input.correlationId,
      envelopeDigest: expectedDigest,
      toolName: input.dispatchContext.toolName,
      toolVersion: input.dispatchContext.toolVersion,
      argsDigest: input.dispatchContext.paramsDigest,
      policy: proofPolicy,
      confirmationId: input.dispatchContext.confirmationId,
    });
    const proofDigest = this.#dispatchProofAuthority.digest(dispatchProof);
    const routeSnapshotDigest = this.#dispatchProofAuthority.routeSnapshotDigest(dispatchProof);
    const leaseId = gatewayUuidV7(this.#clock());
    let reservation: DurableEgressReservation | null = null;
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
        readonly lease: DurableEgressLease;
      } | null } = { current: null };
      const persisted = await this.#sessionRepository.transact({ tenantId: input.tenantId }, async (tx) => {
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
        this.#assertAuthorityTicket(authorityTicket, connection, {
          session: active.record,
        });
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
          record.pending !== null ||
          (recovery.dispatch !== null &&
            (recovery.dispatch.sessionBindingId !== record.sessionBindingId ||
              recovery.dispatch.preparedConnectionId !== record.connectionId ||
              recovery.dispatch.authorizedSessionVersion !== record.sessionVersion))
        ) {
          return { kind: "blocked" as const };
        }
        if (
          input.mutating &&
          (!hasRecoverableMutationCapacity(record, holdCandidates) ||
            !(await this.#assertMutationAdmission(
              tx,
              input.tenantId,
              input.rsid,
              record,
              mutationScopes,
              ownHoldIds,
              recovery.holdIds,
              recovery.originRedelivery,
            )))
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
          proofDigest,
          routeSnapshotDigest,
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
              ...(input.effectiveMcpRequestScope === undefined
                ? {}
                : { effectiveMcpRequestScope: input.effectiveMcpRequestScope }),
              mutationEntries,
              journalRecords: journals,
              dispatchReceipt: {
                version: 1,
                tenantId: input.tenantId,
                invocationId: input.correlationId,
                correlationId: input.correlationId,
                proofDigest,
                routeSnapshotDigest,
                egressEpoch: fence.epoch + 1,
                leaseTicket: lease.ticket,
                intent: "dispatch",
              },
              expectedNoSendAuthorityDigest: noSendAuthorityDigest({
                schema: "gateway.dispatch-no-send/v1",
                tenantId: input.tenantId,
                rsid: input.rsid,
                effectiveMcpSessionId: effectiveMcpRequestScope.effectiveMcpSessionId,
                principalKey: effectiveMcpRequestScope.principalKey,
                effectiveScopeDigest: digest(canonicalizeJson(effectiveMcpRequestScope as unknown as JsonValue)),
                sessionBindingId: record.sessionBindingId,
                acceptedConnectionId: record.connectionId,
                durableSessionVersion: record.sessionVersion,
                invocationId: input.correlationId,
                correlationId: input.correlationId,
                envelopeDigest: expectedDigest,
                gatewaySequence: envelope.seq,
                durableSequenceVersion: record.sessionVersion,
                egressEpoch: fence.epoch + 1,
                leaseVersion: 1,
                leaseTicket: lease.ticket,
                leaseHolderInstanceId: lease.holderInstanceId,
                proofDigest,
                routeSnapshotDigest,
                intentDigest: digest(canonicalizeJson({
                  correlationId: input.correlationId,
                  envelopeDigest: expectedDigest,
                  intent: "dispatch",
                  invocationId: input.correlationId,
                  scopeDigest: digest(canonicalizeJson(effectiveMcpRequestScope as unknown as JsonValue)),
                })),
                transportStarted: false,
                cumulativeAck: null,
                binding: record.binding,
              }),
            },
            egressFence: {
              version: 1,
              state: "open",
              epoch: fence.epoch + 1,
              nextTicket: fence.nextTicket + 1,
              lease,
              revocation: null,
              cancellation: null,
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
          return { start: async () => ({ state: "failed", error: { code: "executor_unavailable", message: "registered rsid has unresolved durable authority" } }) };
        }
        reservation = {
          tenantId: input.tenantId,
          rsid: input.rsid,
          record: persisted.value.record,
          lease: persisted.value.lease,
          dispatchProof,
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
            dispatchProof,
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

    return { start: async (): Promise<GatewayExecutorOutcome> => {
      const outcome: { current: Promise<GatewayExecutorOutcome> | null } = {
        current: null,
      };
      try {
      await this.#sendWithDurableReservation(
        connection,
        reservation,
        JSON.stringify(envelope),
        authorityTicket,
        () => {
          outcome.current = new Promise<GatewayExecutorOutcome>((resolve) => {
            const timer = setTimeout(() => {
              this.#waiters.delete(input.correlationId);
              resolve(this.#indeterminateOutcome(input.mutating));
            }, INVOCATION_TIMEOUT_MS);
            timer.unref();
            this.#waiters.set(input.correlationId, {
              resolve,
              timer,
              tenantId: input.tenantId,
              rsid: input.rsid,
              mutating: input.mutating,
            });
          });
        },
      );
      } catch {
        if (outcome.current === null) {
          await this.#settleLocalFinalTombstoneIfPresent(
            input.tenantId,
            input.rsid,
          );
          return {
            state: "failed",
            error: {
              code: "executor_unavailable",
              message: "dispatch did not begin before durable revocation",
            },
          };
        }
        const waiter = this.#waiters.get(input.correlationId);
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          this.#waiters.delete(input.correlationId);
          waiter.resolve(this.#indeterminateOutcome(input.mutating));
        }
      }
      if (outcome.current === null) {
        throw new GatewayRbpFault(
          "unavailable",
          "dispatch send did not install its waiter",
          503,
          1011,
        );
      }
      return await outcome.current;
    } };
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
      const promoted = await this.#sessionRepository.transact(
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
            (lease.operation === "dispatch" &&
              (lease.proofDigest === undefined || lease.proofDigest === null ||
                lease.routeSnapshotDigest === undefined || lease.routeSnapshotDigest === null)) ||
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
      const released = await this.#sessionRepository.transact(
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

  /**
   * A carrier that is cancelled before its invocation boundary has not
   * performed any transport I/O.  Release only the exact still-reserved
   * fence: the durable outbound sequence/pending record remains the recovery
   * authority and must never be guessed or replayed from an in-memory queue.
   */
  async #markReservedEgressCancellationPending(
    reservation: DurableEgressReservation,
  ): Promise<"marked" | "cancellation_pending" | "promotion_won"> {
    if (reservation.lease.operation !== "dispatch") return "marked";
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
      } | null } = { current: null };
      const marked = await this.#sessionRepository.transact(
        { tenantId: reservation.tenantId },
        async (tx) => {
          const stored = await tx.read<GatewayJsonValue>(
            GATEWAY_RBP_SESSION_NAMESPACE,
            reservation.rsid,
          );
          if (stored === null) return { kind: "cancellation_pending" as const };
          const record = parseStoredSession(stored, reservation.tenantId, reservation.rsid);
          const fence = sessionEgressFence(record);
          const pending = record.pending;
          const exactLease = fence.lease !== null &&
            fence.lease.phase === "reserved" &&
            sameJson(fence.lease, reservation.lease) &&
            fence.lease.holderInstanceId === this.#instanceId;
          const exactPending = pending !== null &&
            pending.envelopeDigest === reservation.lease.envelopeDigest &&
            pending.expectedNoSendAuthorityDigest !== undefined &&
            pending.expectedNoSendAuthorityDigest !== null;
          if (!exactLease || !exactPending) {
            // A changed lease/pending/authority is never evidence that this
            // cancellation won.  In particular, do not reopen a fence after a
            // racing promotion or a foreign durable writer.
            return {
              kind: fence.lease?.phase === "started" ? "promotion_won" as const : "cancellation_pending" as const,
            };
          }
          const expectedNoSendAuthorityDigest = pending.expectedNoSendAuthorityDigest!;
          if (fence.state === "cancellation_pending") {
            const existing = fence.cancellation;
            return existing !== null &&
              existing.leaseId === reservation.lease.leaseId &&
              existing.leaseTicket === reservation.lease.ticket &&
              existing.envelopeDigest === reservation.lease.envelopeDigest &&
              existing.expectedNoSendAuthorityDigest === expectedNoSendAuthorityDigest
              ? { kind: "pending" as const }
              : { kind: "cancellation_pending" as const };
          }
          if (fence.state !== "open" || fence.revocation !== null || fence.cancellation !== null) {
            return { kind: "cancellation_pending" as const };
          }
          const cancellation: DurableEgressCancellation = {
            leaseId: reservation.lease.leaseId,
            leaseTicket: reservation.lease.ticket,
            envelopeDigest: reservation.lease.envelopeDigest,
            expectedNoSendAuthorityDigest,
            receiptIntentDigest: digest(canonicalizeJson({
              domain: "revagent.gateway.dispatch-cancellation-intent/v1",
              rsid: reservation.rsid,
              leaseId: reservation.lease.leaseId,
              leaseTicket: reservation.lease.ticket,
              envelopeDigest: reservation.lease.envelopeDigest,
              expectedNoSendAuthorityDigest,
              invocationId: pending.invocationId,
            })),
            requestedAtMs: this.#clock(),
          };
          const next = nextSessionRecord(
            stored,
            record,
            {
              ...record,
              // Phase one is an irreversible promotion fence.  Preserve the
              // lease epoch so the already-minted receipt authority remains
              // exact; the versioned session row records cancellation intent.
              egressFence: {
                ...fence,
                state: "cancellation_pending",
                cancellation,
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
          return { kind: "marked" as const, next };
        },
      );
      if (marked.ok) {
        if (marked.value.kind !== "marked" && marked.value.kind !== "pending") {
          return marked.value.kind;
        }
        if (marked.value.kind === "marked") this.#syncActiveRecord(marked.value.next);
        return "marked";
      }
      if (marked.code === "conflict") continue;
      if (marked.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(reservation.tenantId, reservation.rsid);
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          this.#syncActiveRecord(parseStoredSession(readBack, reservation.tenantId, reservation.rsid));
          return "marked";
        }
        // Durability uncertainty is not a conflict retry. The durable fence
        // stays fail-closed until a later recovery/resume can prove it.
        return "cancellation_pending";
      }
      return "cancellation_pending";
    }
    return "cancellation_pending";
  }

  async #settleReservedEgressCancellation(
    reservation: DurableEgressReservation,
  ): Promise<DispatchPreStartCancellation> {
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
      } | null } = { current: null };
      const released = await this.#sessionRepository.transact(
        { tenantId: reservation.tenantId },
        async (tx) => {
          const stored = await tx.read<GatewayJsonValue>(
            GATEWAY_RBP_SESSION_NAMESPACE,
            reservation.rsid,
          );
          if (stored === null) return { kind: "cancellation_pending" as const };
          const record = parseStoredSession(stored, reservation.tenantId, reservation.rsid);
          const fence = sessionEgressFence(record);
          const cancellation = fence.cancellation;
          if (
            fence.lease === null ||
            fence.lease.phase !== "reserved" ||
            !sameJson(fence.lease, reservation.lease) ||
            fence.lease.holderInstanceId !== this.#instanceId ||
            (reservation.lease.operation === "dispatch" &&
              (fence.state !== "cancellation_pending" ||
                cancellation === null ||
                cancellation.leaseId !== reservation.lease.leaseId ||
                cancellation.leaseTicket !== reservation.lease.ticket ||
                cancellation.envelopeDigest !== reservation.lease.envelopeDigest ||
                cancellation.expectedNoSendAuthorityDigest !==
                  record.pending?.expectedNoSendAuthorityDigest ||
                cancellation.receiptIntentDigest !== digest(canonicalizeJson({
                  domain: "revagent.gateway.dispatch-cancellation-intent/v1",
                  rsid: reservation.rsid,
                  leaseId: reservation.lease.leaseId,
                  leaseTicket: reservation.lease.ticket,
                  envelopeDigest: reservation.lease.envelopeDigest,
                  expectedNoSendAuthorityDigest:
                    record.pending?.expectedNoSendAuthorityDigest ?? null,
                  invocationId: record.pending?.invocationId ?? null,
                })))) ||
            (reservation.lease.operation !== "dispatch" && fence.state !== "open")
          ) return {
            kind: fence.lease?.phase === "started" ? "promotion_won" as const : "cancellation_pending" as const,
          };
          const cancelledPending =
            record.pending?.envelopeDigest === reservation.lease.envelopeDigest
              ? record.pending
              : null;
          const nowMs = this.#clock();
          const cancelledEvidence: DurableDispatchEvidence | null =
            cancelledPending === null
              ? null
              : (() => {
                  const journals = cancelledPending.journalRecords.map(
                    (journal) =>
                      handleJournalSessionUnregister(journal, true, null).record,
                  );
                  const existing = record.evidence.find(
                    (candidate) =>
                      candidate.envelopeDigest === cancelledPending.envelopeDigest,
                  );
                  return {
                    envelopeDigest: cancelledPending.envelopeDigest,
                    // No carrier byte crossed the invocation boundary, so an
                    // inbound bridge acknowledgement can never authorize this
                    // cancellation receipt.
                    acceptance: null,
                    journal:
                      journals.length === 0
                        ? null
                        : {
                            kind: "known_terminal",
                            rsid: record.rsid,
                            sessionBindingId: record.sessionBindingId,
                            envelopeDigest: cancelledPending.envelopeDigest,
                            journalRecords: journals,
                            batchTerminal: null,
                            durableJournalVersion: record.sessionVersion,
                            recordedAtMs: nowMs,
                          },
                    terminalTruth: existing?.terminalTruth ?? null,
                    noSendAuthorityDigest:
                      cancelledPending.expectedNoSendAuthorityDigest ?? null,
                    noSendReceipt: noSendReceipt({
                      record,
                      fence,
                      lease: reservation.lease,
                      recordedAtMs: nowMs,
                    }),
                  };
                })();
          const next = nextSessionRecord(
            stored,
            record,
            {
              ...record,
              // A proved pre-start cancellation has no transport ambiguity:
              // clear only the pending record bound to this exact lease
              // envelope. A different/newer pending dispatch remains fenced.
              pending:
                cancelledPending === null ? record.pending : null,
              evidence:
                cancelledEvidence === null
                  ? record.evidence
                  : [
                      ...record.evidence.filter(
                        (candidate) =>
                          candidate.envelopeDigest !==
                          cancelledEvidence.envelopeDigest,
                      ),
                      cancelledEvidence,
                    ],
              egressFence: {
                ...fence,
                state: "open",
                epoch: fence.epoch + 1,
                lease: null,
                cancellation: null,
              },
            },
            nowMs,
          );
          attempted.current = { prior: stored, next };
          tx.stage({
            namespace: GATEWAY_RBP_SESSION_NAMESPACE,
            key: reservation.rsid,
            value: asJson(next),
            expect: { kind: "version", version: stored.version },
          });
          return { kind: "released" as const, next };
        },
      );
      if (released.ok) {
        if (released.value.kind !== "released") return released.value.kind;
        this.#syncActiveRecord(released.value.next);
        return "settled_no_send";
      }
      if (released.code === "conflict") continue;
      if (released.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(reservation.tenantId, reservation.rsid);
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          this.#syncActiveRecord(parseStoredSession(readBack, reservation.tenantId, reservation.rsid));
          return "settled_no_send";
        }
        // A reservation whose release cannot be proven is an unavailable
        // dispatch path, never a license to retry or replay it in memory.
      }
      return "cancellation_pending";
    }
    return "cancellation_pending";
  }

  async #releaseReservedEgressLease(
    reservation: DurableEgressReservation,
  ): Promise<DispatchPreStartCancellation> {
    // Phase one must complete before the no-send receipt may be minted. A
    // caller's timeout is only an observation bound; this shared promise
    // continues through phase two in the background coordinator.
    const marked = await this.#markReservedEgressCancellationPending(reservation);
    if (marked === "promotion_won" || marked === "cancellation_pending") return marked;
    return await this.#settleReservedEgressCancellation(reservation);
  }

  /**
   * A legacy adapter Boolean is only an observation about its local queue.
   * Treat it as settled only after the durable v2 row proves the exact
   * receipt/journal/fence transition; otherwise retain the fail-closed
   * cancellation-pending outcome for recovery.
   */
  async #confirmNoSendCancellation(
    reservation: DurableEgressReservation,
  ): Promise<DispatchPreStartCancellation> {
    const stored = await this.#readStoredSession(reservation.tenantId, reservation.rsid);
    if (stored === null) return "cancellation_pending";
    let record: DurableRbpSession;
    try {
      record = parseStoredSession(stored, reservation.tenantId, reservation.rsid);
    } catch {
      return "cancellation_pending";
    }
    const fence = sessionEgressFence(record);
    if (fence.lease?.phase === "started") return "promotion_won";
    const evidence = record.evidence.find(
      (candidate) => candidate.envelopeDigest === reservation.lease.envelopeDigest,
    );
    const receipt = evidence?.noSendReceipt ?? null;
    if (
      fence.state !== "open" ||
      fence.lease !== null ||
      fence.cancellation !== null ||
      record.pending !== null ||
      evidence?.acceptance !== null ||
      evidence?.journal?.kind !== "known_terminal" ||
      receipt === null ||
      receipt.envelopeDigest !== reservation.lease.envelopeDigest ||
      receipt.leaseTicket !== reservation.lease.ticket ||
      receipt.leaseHolderInstanceId !== reservation.lease.holderInstanceId ||
      receipt.transportStarted !== false ||
      receipt.cumulativeAck !== null ||
      evidence.noSendAuthorityDigest !== receipt.authorityDigest
    ) {
      return "cancellation_pending";
    }
    const { authorityDigest: _authorityDigest, recordedAtMs: _recordedAtMs, ...coordinates } = receipt;
    return noSendAuthorityDigest({ ...coordinates, binding: record.binding }) === receipt.authorityDigest
      ? "settled_no_send"
      : "cancellation_pending";
  }

  async #sendWithDurableReservation(
    connection: LiveConnection,
    reservation: DurableEgressReservation,
    serialized: string,
    authorityTicket: TenantAuthorityTicket,
    beforeSend?: () => void,
  ): Promise<void> {
    try {
      this.#assertAuthorityTicket(authorityTicket, connection, {
        session: reservation.record,
      });
    } catch (error: unknown) {
      if (this.#ticketScopeIsRevokedOrBlocked(authorityTicket)) {
        await this.#revokeStaleAuthorizedSession(connection, reservation.rsid);
      }
      throw error;
    }
    let sendFailure: unknown = null;
    let releaseFailure: unknown = null;
    let sendBegan = false;
    let completedAndVerified = false;
    let cancellationOutcome: DispatchPreStartCancellation | null = null;
    let started: DurableEgressReservation | null = null;
    const preStartCancellation = new PreStartCancellationCoordinator(
      async () => await this.#releaseReservedEgressLease(reservation),
    );
    try {
      const startedDispatch = connection.sendDispatchStarted?.(serialized, {
        revalidate: async (signal: AbortSignal) => {
          if (signal.aborted) {
            await preStartCancellation.requestCancel();
            throw new GatewayRbpFault("unavailable", "dispatch carrier cancelled before promotion", 503, 1011);
          }
          // This closure remains nominal/in-memory only.  It is run by the
          // adapter immediately before websocket.send()/response.write(), not
          // when the dispatch was merely queued.  The next source statement in
          // the adapter invokes the transport after this promise resolves.
          started = await preStartCancellation.promote(
            async () => await this.#promoteEgressReservation(reservation),
          );
          if (signal.aborted) {
            // At this point promotion has won.  The started lease stays
            // fenced for terminal/recovery handling rather than being
            // incorrectly released as a no-send dispatch.
            throw new GatewayRbpFault("unavailable", "dispatch carrier cancelled after promotion", 503, 1011);
          }
          await this.#assertDispatchReservationCurrent(connection, started, authorityTicket);
          if (signal.aborted) throw new GatewayRbpFault("unavailable", "dispatch carrier cancelled before invocation", 503, 1011);
          this.#assertAuthorityTicket(authorityTicket, connection, { session: started.record });
        },
        cancelBeforeStart: async () =>
          (await preStartCancellation.requestCancel()) === "settled_no_send",
      });
      if (startedDispatch === undefined) {
        started = await this.#promoteEgressReservation(reservation);
        await this.#assertDispatchReservationCurrent(connection, started, authorityTicket);
        this.#assertAuthorityTicket(authorityTicket, connection, { session: started.record });
        const sendOperation = connection.send(serialized);
        sendBegan = true;
        beforeSend?.();
        await sendOperation;
      } else {
        // `started` is resolved only by the concrete WSS/SSE invocation, not
        // by enqueueing. Thus a cancelled or starving queue cannot acquire a
        // waiter or a mutation-indeterminate result.
        let startTimer: ReturnType<typeof setTimeout> | null = null;
        try {
        await Promise.race([
            startedDispatch.started,
            new Promise<void>((_, reject) => {
              startTimer = setTimeout(
                () => reject(new GatewayRbpFault("unavailable", "dispatch carrier start timed out", 503, 1011)),
                SEND_RESERVATION_TTL_MS,
              );
            }),
          ]);
        } catch (error) {
          // cancel() is linearized with the adapter invocation boundary.  A
          // true result proves no bytes were handed to transport; a false
          // result means the outcome is already started/indeterminate.
          const cancellation = await startedDispatch.cancel();
          cancellationOutcome = cancellation
            ? await this.#confirmNoSendCancellation(reservation)
            : "cancellation_pending";
          throw error;
        } finally {
          if (startTimer !== null) clearTimeout(startTimer);
        }
        sendBegan = true;
        beforeSend?.();
        await startedDispatch.completion;
      }
      if (started === null) {
        throw new GatewayRbpFault("unavailable", "dispatch carrier resolved without a started lease", 503, 1011);
      }
      const completionAuthority = await this.#assertDispatchReservationCurrent(
        connection,
        started,
        authorityTicket,
        { allowRevocationAfterStart: true },
      );
      completedAndVerified = true;
      if (completionAuthority === "revoked_after_start") {
        throw new GatewayRbpFault(
          "unavailable",
          "dispatch completed after durable revocation",
          503,
          1011,
        );
      }
    } catch (error) {
      sendFailure = error;
    } finally {
      try {
        // Only a successfully completed and post-send verified transport can
        // release a started lease.  Completion failure, timeout, uncertain
        // cancellation, or a changed route retains the fence/pending record
        // for terminal/recovery handling; mutating work remains held.
        if (started !== null && completedAndVerified) {
          await this.#releaseStartedEgressLease(started);
        } else if (started === null && cancellationOutcome === "settled_no_send") {
          // cancelBeforeStart already performed the exact durable release.
        }
      } catch (error) {
        releaseFailure = error;
      }
    }
    if (releaseFailure !== null) throw releaseFailure;
    if (
      sendFailure !== null &&
      !sendBegan &&
      this.#ticketScopeIsRevokedOrBlocked(authorityTicket)
    ) {
      await this.#revokeStaleAuthorizedSession(connection, reservation.rsid);
    }
    if (sendFailure !== null) throw sendFailure;
  }

  /** Re-checks the exact durable reservation immediately around transport I/O. */
  async #assertDispatchReservationCurrent(
    connection: LiveConnection,
    reservation: DurableEgressReservation,
    authorityTicket: TenantAuthorityTicket,
    options: { readonly allowRevocationAfterStart?: boolean } = {},
  ): Promise<"current" | "revoked_after_start"> {
    const active = this.#active.get(reservation.rsid);
    const stored = await this.#readStoredSession(reservation.tenantId, reservation.rsid);
    if (active === undefined || active.tenantId !== reservation.tenantId ||
        active.record.connectionId !== connection.connectionId || stored === null) {
      throw new GatewayRbpFault("unavailable", "dispatch route changed during reserved send", 503, 1011);
    }
    const record = parseStoredSession(stored, reservation.tenantId, reservation.rsid);
    const lease = sessionEgressFence(record).lease;
    if (lease?.operation === "dispatch") {
      if (reservation.dispatchProof === undefined) {
        throw new GatewayRbpFault("unavailable", "dispatch proof is unavailable after reservation", 503, 1011);
      }
      this.#dispatchProofAuthority.assert(reservation.dispatchProof);
      if (
        lease.proofDigest !== this.#dispatchProofAuthority.digest(reservation.dispatchProof) ||
        lease.routeSnapshotDigest !== this.#dispatchProofAuthority.routeSnapshotDigest(reservation.dispatchProof)
      ) {
        throw new GatewayRbpFault("unavailable", "dispatch proof no longer matches durable route authority", 503, 1011);
      }
    }
    const fence = sessionEgressFence(record);
    const revokedAfterStart =
      options.allowRevocationAfterStart === true &&
      fence.state === "revocation_pending" &&
      fence.revocation !== null &&
      lease !== null &&
      lease.phase === "started" &&
      sameJson(lease, reservation.lease) &&
      record.connectionId === connection.connectionId &&
      record.sessionBindingId === reservation.record.sessionBindingId;
    if (revokedAfterStart) {
      // Bytes already crossed the adapter's invocation boundary. Preserve the
      // exact durable lease long enough to release it by CAS, then let the
      // pending unregister finalize as indeterminate rather than replaying.
      return "revoked_after_start";
    }
    if (record.connectionId !== connection.connectionId ||
        record.sessionBindingId !== reservation.record.sessionBindingId ||
        !record.sessionLifecycle.dispatchAllowed ||
        // Public north routing never creates a reservation without a live
        // route. Keep old internal lifecycle tests distinct: they may have
        // no north route, but can never carry a north proof into this path.
        (reservation.record.liveDocumentRoute !== null &&
          (record.liveDocumentRoute === null ||
            !sameJson(record.liveDocumentRoute, reservation.record.liveDocumentRoute))) ||
        lease === null || lease.phase !== "started" ||
        (lease.operation === "dispatch" &&
          (lease.proofDigest === undefined || lease.proofDigest === null ||
            lease.routeSnapshotDigest === undefined || lease.routeSnapshotDigest === null)) ||
        !sameJson(lease, reservation.lease)) {
      throw new GatewayRbpFault("unavailable", "dispatch reservation no longer authorizes its route", 503, 1011);
    }
    this.#assertAuthorityTicket(authorityTicket, connection, { session: record });
    return "current";
  }

  async #revokeStaleAuthorizedSession(
    connection: LiveConnection,
    rsid: string,
  ): Promise<void> {
    try {
      await this.#unregisterNow(connection, {
        rsid,
        reason: "session_replaced",
      });
    } finally {
      this.#closeConnectionForRevocation(connection);
    }
  }

  async #reserveResumeAck(
    connection: LiveConnection,
    payload: {
      readonly rsid: string;
      readonly resume_token: string;
      readonly last_rx_seq: number;
    },
    authorityTicket: TenantAuthorityTicket,
  ): Promise<ReservedResumeAck> {
    this.#assertAuthorityTicket(authorityTicket, connection);
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
      const reserved = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
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
        this.#assertAuthorityTicket(authorityTicket, connection);
        const initialFence = sessionEgressFence(record);
        const nowMs = this.#clock();
        let recovered = record;
        let fence = initialFence;

        if (
          initialFence.lease?.operation === "dispatch" &&
          initialFence.lease.phase === "reserved"
        ) {
          let noSend: DurableDispatchEvidence | null;
          try {
            noSend = orphanReservedNoSendEvidence({
              tenantId,
              record,
              lease: initialFence.lease,
              nowMs,
            });
          } catch {
            // A legacy/malformed proof receipt is not a substitute for the
            // exact Gateway-authored receipt. Keep it fenced and fail closed.
            return { kind: "recovery_blocked" as const };
          }
          if (noSend === null) {
            return { kind: "recovery_blocked" as const };
          }
          recovered = {
            ...record,
            pending: null,
            evidence: [
              ...record.evidence.filter(
                (candidate) =>
                  candidate.envelopeDigest !== noSend.envelopeDigest,
              ),
              noSend,
            ],
            egressFence: {
              ...initialFence,
              state: "open",
              epoch: initialFence.epoch + 1,
              lease: null,
              cancellation: null,
            },
          };
          fence = sessionEgressFence(recovered);
        }

        if (
          initialFence.lease?.operation === "dispatch" &&
          initialFence.lease.phase === "started"
        ) {
          const pending = record.pending;
          if (
            pending === null ||
            pending.envelopeDigest !== initialFence.lease.envelopeDigest
          ) {
            return { kind: "recovery_blocked" as const };
          }
          let candidates: readonly NormalizedHoldCandidate[];
          try {
            candidates = pending.mutating
              ? normalizedHoldCandidates(
                  record.rsid,
                  durablePendingMutationEntries(record),
                )
              : [];
            if (
              (pending.mutating && candidates.length === 0) ||
              candidates.length > MAX_RECOVERABLE_MUTATION_SCOPES ||
              !hasRecoverableMutationCapacity(record, candidates)
            ) {
              return { kind: "recovery_blocked" as const };
            }
            for (const candidate of candidates) {
              await this.#ensureNormalizedConflictPair(
                tx,
                tenantId,
                record.rsid,
                candidate,
                nowMs,
              );
            }
            const journals = pending.journalRecords.map((journal) => {
              const holdId = journal.binding.mutating
                ? candidates.find(
                    (candidate) =>
                      candidate.mutationScopeJcs ===
                      mutationScopeKey(journal.binding.mutationScope!),
                  )?.holdId ?? null
                : null;
              return handleJournalSessionUnregister(journal, false, holdId)
                .record;
            });
            const evidence: DurableDispatchEvidence = {
              envelopeDigest: pending.envelopeDigest,
              acceptance:
                record.evidence.find(
                  (candidate) =>
                    candidate.envelopeDigest === pending.envelopeDigest,
                )?.acceptance ?? null,
              journal: {
                kind: candidates.length > 0 ? "indeterminate" : "known_terminal",
                rsid: record.rsid,
                sessionBindingId: record.sessionBindingId,
                envelopeDigest: pending.envelopeDigest,
                journalRecords: journals,
                batchTerminal: null,
                durableJournalVersion: record.sessionVersion,
                recordedAtMs: nowMs,
              },
            };
            recovered = {
              ...record,
              // Keep the exact started lease and pending dispatch fenced. The
              // retained journal/hold evidence is enough for recovery, but no
              // resumed transport may replay this ambiguous invocation.
              evidence: [
                ...record.evidence.filter(
                  (candidate) =>
                    candidate.envelopeDigest !== pending.envelopeDigest,
                ),
                evidence,
              ],
              normalizedConflictIndex: extendConflictIndex(
                sessionConflictIndex(record),
                candidates.map((candidate) =>
                  conflictScopeDigest(candidate.mutationScopeJcs),
                ),
              ),
            };
          } catch {
            return { kind: "recovery_blocked" as const };
          }
          const next = nextSessionRecord(stored, record, recovered, nowMs);
          tx.stage({
            namespace: GATEWAY_RBP_SESSION_NAMESPACE,
            key: payload.rsid,
            value: asJson(next),
            expect: { kind: "version", version: stored.version },
          });
          return { kind: "recovery_blocked" as const };
        }
        if (
          fence.state !== "open" ||
          fence.revocation !== null ||
          fence.lease?.phase === "started" ||
          (fence.lease?.phase === "reserved" &&
            fence.lease.reserveExpiresAtMs > nowMs) ||
          recovered.deviceId !== connection.auth.actor.deviceId ||
          recovered.userId !== connection.auth.actor.userId ||
          recovered.seatId !== connection.auth.actor.seatId ||
          !sameDurableIdentityAuthority(
            connection.auth,
            recovered.identityAuthority,
          ) ||
          recovered.resumeTokenDigest !== digest(payload.resume_token) ||
          recovered.resumeExpiresAtMs <= nowMs ||
          !recovered.sessionLifecycle.resumeAllowed
        ) {
          return { kind: "blocked" as const };
        }
        const acknowledged = applyCumulativeAck(recovered.sequence, payload.last_rx_seq);
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
          recovered.sessionLifecycle.phase === "disconnected"
            ? recovered.sessionLifecycle
            : sessionTransition(recovered.sessionLifecycle, { type: "connection_lost" });
        let sessionLifecycle = sessionTransition(disconnectedLifecycle, {
          type: "resume_requested",
        });
        sessionLifecycle = sessionTransition(sessionLifecycle, { type: "resumed" });
        const resumed: DurableRbpSession = {
          ...recovered,
          connectionId: connection.connectionId,
          binding: connection.binding,
          sessionVersion: recovered.sessionVersion + 1,
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
              cancellation: null,
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
        if (reserved.value.kind === "recovery_blocked") {
          throw new GatewayRbpFault(
            "unavailable",
            "orphaned dispatch remains durably fenced for recovery",
            503,
            1011,
          );
        }
        if (reserved.value.kind === "blocked") {
          throw new GatewayRbpFault(
            "auth",
            "resume authorization rejected",
            403,
            4403,
          );
        }
        this.#assertAuthorityTicket(authorityTicket, connection, {
          session: reserved.value.record,
          requireSessionMembership: false,
        });
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
    connection: LiveConnection,
    authorityTicket: TenantAuthorityTicket,
  ): Promise<DurableEgressReservation> {
    this.#assertAuthorityTicket(authorityTicket, connection);
    const leaseId = gatewayUuidV7(this.#clock());
    const envelopeDigest = digest(serialized);
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
        readonly lease: DurableEgressLease;
      } | null } = { current: null };
      const reserved = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
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
        this.#assertAuthorityTicket(authorityTicket, connection, {
          session: record,
        });
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
              cancellation: null,
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
    const stored = await this.#readRecoveryAuthoritative(tx, expected.rsid);
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
    const expectedJournalBindingsPresent = evidence.journal === null ||
      !expected.invocationBindings.some((binding) =>
        !evidence.journal!.journalRecords.some(
          (record) =>
            record.bindingDigest === binding.bindingDigest &&
            `${record.binding.rsid}/${record.binding.invocationId}` ===
              binding.idempotencyKey,
        ),
      );
    const noSend = evidence.noSendReceipt ?? null;
    if (noSend !== null) {
      // No-send is a distinct terminal proof, not an ACK with a null value.
      // It must bind the exact public recovery coordinates and retain the
      // no-invocation facts; acceptance is prohibited on this branch.
      if (
        evidence.acceptance !== null ||
        evidence.journal?.kind !== "known_terminal" ||
        noSend.gatewaySequence !== expected.gatewaySequence ||
        noSend.envelopeDigest !== expected.envelopeDigest ||
        noSend.sessionBindingId !== expected.sessionBindingId ||
        noSend.transportStarted !== false ||
        noSend.cumulativeAck !== null ||
        !expectedJournalBindingsPresent
      ) {
        return { kind: "protocol_fault", reason: "dispatch_evidence_mismatch" };
      }
      if (
        evidence.noSendAuthorityDigest === undefined ||
        evidence.noSendAuthorityDigest === null ||
        evidence.noSendAuthorityDigest !== noSend.authorityDigest ||
        (() => {
          const { authorityDigest: _authorityDigest, recordedAtMs: _recordedAtMs, ...coordinates } = noSend;
          return noSendAuthorityDigest({ ...coordinates, binding: session.binding }) !==
            noSend.authorityDigest;
        })()
      ) {
        return { kind: "protocol_fault", reason: "no_send_authority_mismatch" };
      }
    } else if (
      evidence.acceptance?.gatewaySequence !== expected.gatewaySequence ||
      !expectedJournalBindingsPresent
    ) {
      return { kind: "protocol_fault", reason: "dispatch_evidence_mismatch" };
    }
    return {
      kind: "found",
      observation: {
        acceptance: evidence.acceptance,
        journal: evidence.journal,
        noSend: evidence.noSendReceipt ?? null,
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
      const stored = await this.#readRecoveryAuthoritative(tx, expected.rsid);
      if (stored === null) return { kind: "not_authorized", reason: "unknown_rsid" };
      const session = parseStoredSession(stored, stored.tenantId, expected.rsid);
      const fence = sessionEgressFence(session);
      if (fence.state !== "open" || fence.revocation !== null) {
        return { kind: "not_authorized", reason: "session_revoking" };
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

  async #readRecoveryAuthoritative(
    tx: Pick<StoreTransaction, "read" | "list">,
    rsid: string,
  ): Promise<StoredRecord<GatewayJsonValue> | null> {
    const marker = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE, rsid);
    if (marker !== null) {
      const tenantId = isRecord(marker.value) && typeof marker.value.tenantId === "string"
        ? marker.value.tenantId
        : "";
      return await this.#sessionRepository.readAuthoritative(tx, tenantId, rsid);
    }
    const legacy = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid);
    if (legacy === null) return null;
    return await this.#sessionRepository.readAuthoritative(tx, legacy.tenantId, rsid);
  }

  async #register(
    connection: LiveConnection,
    payload: SessionRegister,
    authorityTicket: TenantAuthorityTicket,
  ): Promise<void> {
    this.#assertAuthorityTicket(authorityTicket, connection);
    if (
      connection.auth.machineFingerprint !== undefined &&
      !machineFingerprintClaimsEqual(
        connection.auth.machineFingerprint,
        payload.machine.fingerprint,
      )
    ) {
      throw new GatewayRbpFault(
        "auth",
        "session registration machine claim does not match credential",
        403,
        4403,
      );
    }
    const rsid = gatewayUuidV7(this.#clock());
    await this.#withSessionAuthorization(rsid, async () => {
    const resumeToken = token();
    const nowMs = this.#clock();
    const grantedCapabilities = grantCapabilities(
      IMPLEMENTED_SESSION_CAPABILITIES,
      connection.auth.grantedSessionCapabilities,
      payload.session_capabilities,
    );
    const record: DurableRbpSession = {
      schema: GATEWAY_RBP_SESSION_NAMESPACE,
      recordVersion: 1,
      createdAtMs: nowMs,
      tenantId: connection.auth.actor.tenantId,
      userId: connection.auth.actor.userId,
      deviceId: connection.auth.actor.deviceId,
      seatId: connection.auth.actor.seatId,
      identityAuthority: durableIdentityAuthority(connection.auth),
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
    const saved = await this.#sessionRepository.transact(
      { tenantId: record.tenantId },
      async (tx) => {
        this.#assertAuthorityTicket(authorityTicket, connection);
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
    try {
      this.#assertAuthorityTicket(authorityTicket, connection);
    } catch (error: unknown) {
      if (this.#ticketScopeIsRevokedOrBlocked(authorityTicket)) {
        await this.#unregisterNow(connection, {
          rsid,
          reason: "session_replaced",
        });
        this.#closeConnectionForRevocation(connection);
      }
      throw error;
    }
    await this.#activate(record);
    try {
      this.#assertAuthorityTicket(authorityTicket, connection, {
        session: record,
      });
    } catch (error: unknown) {
      if (this.#ticketScopeIsRevokedOrBlocked(authorityTicket)) {
        await this.#revokeStaleAuthorizedSession(connection, rsid);
      }
      throw error;
    }
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
    });
  }

  async #resume(
    connection: LiveConnection,
    payload: { readonly rsid: string; readonly resume_token: string; readonly last_rx_seq: number },
    authorityTicket: TenantAuthorityTicket,
  ): Promise<void> {
    // Keep the rsid tail only through the authoritative resume transition and
    // durable reservation.  The returned continuation is immutable and the
    // exact durable lease remains the race linearizer while transport waits.
    const reservedAck = await this.#withSessionAuthorization(
      payload.rsid,
      async () => await this.#resumeNow(connection, payload, authorityTicket),
    );
    try {
      await this.#sendWithDurableReservation(
        connection,
        reservedAck,
        reservedAck.serialized,
        authorityTicket,
      );
    } catch (error) {
      if (
        this.#active.get(payload.rsid)?.record.connectionId ===
        connection.connectionId
      ) {
        const active = this.#active.get(payload.rsid);
        this.#active.delete(payload.rsid);
        if (active !== undefined) this.#untrackSession(active.record);
      }
      throw error;
    }
    for (const retained of retransmitOutbox(reservedAck.record.sequence, {
      ack: reservedAck.record.sequence.lastRxSeq,
      ts: nowIso(this.#clock()),
    })) {
      const serialized = JSON.stringify(retained);
      // Each retransmit obtains a new durable lease under the tail, then
      // releases it before transport. A phase-one unregister therefore either
      // rejects this reservation or drains this exact started lease.
      const reservation = await this.#withSessionAuthorization(
        payload.rsid,
        async () => await this.#reserveResumeRetransmit(
          reservedAck.tenantId,
          reservedAck.rsid,
          connection.connectionId,
          serialized,
          connection,
          authorityTicket,
        ),
      );
      await this.#sendWithDurableReservation(
        connection,
        reservation,
        serialized,
        authorityTicket,
      );
    }
  }

  async #resumeNow(
    connection: LiveConnection,
    payload: { readonly rsid: string; readonly resume_token: string; readonly last_rx_seq: number },
    authorityTicket: TenantAuthorityTicket,
  ): Promise<ReservedResumeAck> {
    this.#assertAuthorityTicket(authorityTicket, connection);
    let reservedAck: ReservedResumeAck;
    try {
      reservedAck = await this.#reserveResumeAck(
        connection,
        payload,
        authorityTicket,
      );
    } catch (error: unknown) {
      try {
        this.#assertAuthorityTicket(authorityTicket, connection);
      } catch {
        if (this.#ticketScopeIsRevokedOrBlocked(authorityTicket)) {
          await this.#revokeStaleAuthorizedSession(connection, payload.rsid);
        }
      }
      throw error;
    }
    await this.#activate(reservedAck.record);
    return reservedAck;
  }

  async #unregister(
    connection: LiveConnection,
    payload: SessionUnregister,
    authorityTicket: TenantAuthorityTicket,
  ): Promise<void> {
    this.#assertAuthorityTicket(authorityTicket, connection);
    // The exact repository CAS, not a tail held across transport, linearizes
    // phase-one revocation against a concurrently reserved/started carrier.
    await this.#unregisterNow(connection, payload);
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
    const localPendingAtStart = this.#active.get(payload.rsid)?.record.pending ?? null;
    let canceledBeforeSend = false;
    let phaseOne: PendingRevocationAuthority | null = null;
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: {
        readonly prior: StoredRecord<GatewayJsonValue>;
        readonly next: DurableRbpSession;
      } | null } = { current: null };
      const persisted = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
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
          const authority = await this.#pendingRevocationSnapshot(
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
        const pendingBeforeRevocation = record.pending;
        const canceledBeforeSend =
          fence.lease?.phase === "reserved" &&
          fence.lease.operation === "dispatch" &&
          pendingBeforeRevocation !== null &&
          fence.lease.envelopeDigest === pendingBeforeRevocation.envelopeDigest;
        const cancellationLease = fence.lease;
        let pending = pendingBeforeRevocation;
        let evidence = record.evidence;
        if (
          canceledBeforeSend &&
          pendingBeforeRevocation !== null &&
          cancellationLease !== null
        ) {
          const journals = pendingBeforeRevocation.journalRecords.map((journal) =>
            handleJournalSessionUnregister(journal, true, null).record,
          );
          if (journals.length > 0) {
            evidence = [
              ...record.evidence.filter(
                (candidate) =>
                  candidate.envelopeDigest !== pendingBeforeRevocation.envelopeDigest,
              ),
              {
                envelopeDigest: pendingBeforeRevocation.envelopeDigest,
                acceptance: null,
                journal: {
                  kind: "known_terminal",
                  rsid: record.rsid,
                  sessionBindingId: record.sessionBindingId,
                  envelopeDigest: pendingBeforeRevocation.envelopeDigest,
                  journalRecords: journals,
                  batchTerminal: null,
                  durableJournalVersion: record.sessionVersion,
                  recordedAtMs: nowMs,
                },
                noSendAuthorityDigest:
                  pendingBeforeRevocation.expectedNoSendAuthorityDigest ?? null,
                noSendReceipt: noSendReceipt({
                  record,
                  fence,
                  lease: cancellationLease,
                  recordedAtMs: nowMs,
                }),
              },
            ];
          }
          pending = null;
        }
        let candidates: readonly NormalizedHoldCandidate[] = [];
        let unclassifiable = false;
        try {
          candidates = normalizedHoldCandidates(
            record.rsid,
            pending === null
              ? []
              : durablePendingMutationEntries({ ...record, pending }),
          );
          unclassifiable =
            (pending?.mutating === true && candidates.length === 0) ||
            candidates.length > MAX_RECOVERABLE_MUTATION_SCOPES;
        } catch {
          unclassifiable = true;
        }
        const scopeDigests = candidates.map((candidate) =>
          conflictScopeDigest(candidate.mutationScopeJcs),
        );
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
            pending,
            evidence,
            egressFence: {
              version: 1,
              state: "revocation_pending",
              epoch: fence.epoch + 1,
              nextTicket: fence.nextTicket,
              lease: fence.lease?.phase === "started" ? fence.lease : null,
              revocation,
              cancellation: null,
            },
            normalizedConflictIndex: unclassifiable
              ? {
                  ...sessionConflictIndex(record),
                  state: "overflow",
                }
              : extendConflictIndex(sessionConflictIndex(record), scopeDigests),
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
          canceledBeforeSend,
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
          this.#completeLocalUnregister(
            payload.rsid,
            localPendingAtStart,
            localPendingAtStart !== null && replay.pendingDisposition === "none",
          );
          return;
        }
        phaseOne = {
          stored: persisted.value.stored,
          record: persisted.value.record,
          revocation: persisted.value.revocation,
          candidates: persisted.value.candidates,
        };
        canceledBeforeSend =
          ("canceledBeforeSend" in persisted.value &&
            persisted.value.canceledBeforeSend === true) ||
          (localPendingAtStart !== null && persisted.value.record.pending === null);
        break;
      }
      if (persisted.code === "conflict") continue;
      if (persisted.code === "durability_uncertain" && attempted.current !== null) {
        const evidence = attempted.current;
        const readBack = await this.#readStoredSession(tenantId, payload.rsid);
        if (readBack !== null && sameJson(readBack.value, evidence.next)) {
          const record = parseStoredSession(readBack, tenantId, payload.rsid);
          const authority = await this.#pendingRevocationSnapshot(
            record,
            owner,
            payload.reason,
          );
          phaseOne = { stored: readBack, record, ...authority };
          canceledBeforeSend =
            localPendingAtStart !== null && record.pending === null;
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
        if (finalized !== null) {
          this.#completeLocalUnregister(
            payload.rsid,
            localPendingAtStart,
            localPendingAtStart !== null &&
              finalized.pendingDisposition === "none",
          );
          return;
        }
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

    phaseOne = await this.#installPendingRevocationCompanions(
      tenantId,
      payload.rsid,
      owner,
      payload.reason,
    );

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
      const finalized = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
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
    this.#completeLocalUnregister(
      payload.rsid,
      localPendingAtStart,
      canceledBeforeSend,
    );
  }

  async #heartbeat(
    connection: LiveConnection,
    acks: readonly { readonly rsid: string; readonly seq: number }[],
    authorityTicket: TenantAuthorityTicket,
  ): Promise<void> {
    this.#assertAuthorityTicket(authorityTicket, connection);
    const returned: { rsid: string; seq: number }[] = [];
    for (const ack of acks) {
      const active = this.#active.get(ack.rsid);
      if (active === undefined || active.record.connectionId !== connection.connectionId) {
        throw new GatewayRbpFault("auth", "heartbeat references an unbound rsid", 403, 4403);
      }
      const updated = await this.#withSessionAuthorization(ack.rsid, async () => {
        this.#assertAuthorityTicket(authorityTicket, connection, {
          session: active.record,
        });
        const next = await this.#updateSession(active.tenantId, ack.rsid, (record) => {
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
        try {
          this.#assertAuthorityTicket(authorityTicket, connection, {
            session: next,
          });
        } catch (error: unknown) {
          if (this.#ticketScopeIsRevokedOrBlocked(authorityTicket)) {
            await this.#revokeStaleAuthorizedSession(connection, ack.rsid);
          }
          throw error;
        }
        return next;
      });
      active.record = updated;
      returned.push({ rsid: ack.rsid, seq: updated.sequence.lastRxSeq });
    }
    this.#assertAuthorityTicket(authorityTicket, connection);
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

  async #commitCarrierChunk(
    tx: StoreTransaction,
    active: ActiveSession,
    connection: LiveConnection,
    envelope: Extract<RbpEnvelope, { rsid: string; type: "partial" }>,
    authorityTicket: TenantAuthorityTicket,
    committed: { current: DurableRbpSession | null },
  ): Promise<void> {
    committed.current = await this.#sessionRepository.stageAuthoritativeOnRaw(
      tx,
      active.tenantId,
      active.rsid,
      (stored, record) => {
        this.#assertAuthorityTicket(authorityTicket, connection, { session: record });
        if (record.pending === null || record.pending.invocationId !== envelope.payload.invocation_id) {
          throw new Error("carrier receipt does not match the active invocation");
        }
        const accepted = acceptInboundData(record.sequence, envelope as DataEnvelopeSnapshot);
        if (accepted.kind === "protocol_fault" || accepted.kind === "gap") {
          throw new Error("carrier receipt sequence is not acceptable");
        }
        if (accepted.kind === "duplicate") return record;
        return nextSessionRecord(stored, record, {
          ...record,
          sequence: accepted.state,
        }, this.#clock());
      },
    );
  }

  async #commitCarrierTerminal(
    tx: StoreTransaction,
    active: ActiveSession,
    connection: LiveConnection,
    envelope: Extract<RbpEnvelope, { rsid: string; type: "result" }>,
    authorityTicket: TenantAuthorityTicket,
    admission: TerminalAdmission,
    mode: BridgeCarrierCommitMode,
    committed: { current: DurableRbpSession | null },
    completion: { current: GatewayExecutorOutcome | null },
  ): Promise<BridgeCarrierCommitResult> {
    // Re-read final unregister authority in the *shared* resource Tx-C before
    // staging any session, ACK, or activation row.  A matching tombstone is a
    // normal terminal abort; a mismatched tombstone is never attributable to
    // this carrier and remains an auth failure.
    const tombstoneStored = await tx.read<GatewayJsonValue>(
      GATEWAY_RBP_UNREGISTER_NAMESPACE,
      admission.rsid,
    );
    if (tombstoneStored !== null) {
      const tombstone = parseUnregisterTombstone(tombstoneStored.value, {
        tenantId: admission.tenantId,
        rsid: admission.rsid,
        stored: tombstoneStored,
      });
      if (
        tombstone.sessionBindingId === admission.sessionBindingId &&
        tombstone.acceptedConnectionId === admission.connectionId
      ) {
        return { kind: "aborted", reason: "terminal_revoked" };
      }
      throw new Error("carrier terminal tombstone does not match admission");
    }
    const preflightStored = await this.#sessionRepository.readAuthoritative(
      tx,
      admission.tenantId,
      admission.rsid,
    );
    if (preflightStored === null) throw new Error("carrier terminal session is missing");
    const preflight = parseStoredSession(preflightStored, admission.tenantId, admission.rsid);
    const preflightFence = sessionEgressFence(preflight);
    if (preflightFence.state === "revocation_pending") {
      if (
        preflight.sessionBindingId === admission.sessionBindingId &&
        preflight.connectionId === admission.connectionId
      ) {
        return { kind: "aborted", reason: "terminal_revoked" };
      }
      throw new Error("carrier terminal revoked session does not match admission");
    }
    if (preflightFence.state !== "open") throw new Error("carrier terminal session is not open");
    if (preflight.pending === null) {
      const accepted = acceptInboundData(preflight.sequence, envelope as DataEnvelopeSnapshot);
      const replay = preflight.evidence.some((entry) =>
        entry.terminalCarrierDigest === admission.terminalCarrierDigest &&
        entry.terminalDigest === admission.terminalDigest &&
        sameJson(entry.terminalTruth ?? null, admission.terminalTruth),
      );
      if (!replay || accepted.kind !== "duplicate") {
        throw new Error("carrier terminal no longer matches the active exact dispatch");
      }
      committed.current = preflight;
      completion.current = terminalOutcome(envelope);
      return BRIDGE_CARRIER_COMMIT_OK;
    }
    if (mode === "verify") {
      throw new Error("carrier activation exists without its exact Bridge terminal");
    }
    const preflightAdmission = terminalAdmissionFor(preflight, connection.connectionId, envelope);
    if (!sameJson(preflightAdmission, admission)) {
      throw new Error("carrier terminal admission changed before stage C");
    }
    committed.current = await this.#sessionRepository.stageAuthoritativeOnRaw(
      tx,
      active.tenantId,
      active.rsid,
      (stored, record) => {
        this.#assertAuthorityTicket(authorityTicket, connection, { session: record });
        if (sessionEgressFence(record).state !== "open") {
          throw new Error("carrier terminal session was revoked during stage C");
        }
        const accepted = acceptInboundData(record.sequence, envelope as DataEnvelopeSnapshot);
        if (accepted.kind === "protocol_fault" || accepted.kind === "gap") {
          throw new Error("carrier terminal sequence is not acceptable");
        }
        if (accepted.kind === "duplicate") return record;
        const pending = record.pending;
        if (pending === null || pending.invocationId !== envelope.payload.invocation_id) {
          throw new Error("carrier terminal does not match the active invocation");
        }
        const currentAdmission = terminalAdmissionFor(record, connection.connectionId, envelope);
        if (!sameJson(currentAdmission, admission)) {
          throw new Error("carrier terminal admission changed during stage C");
        }
        const existing = record.evidence.find((candidate) => candidate.envelopeDigest === pending.envelopeDigest);
        const dispatchReceipt = pending.dispatchReceipt ?? null;
        const acceptance = envelope.ack !== undefined && envelope.ack >= pending.gatewaySequence
          ? (() => {
              if (
                dispatchReceipt === null ||
                dispatchReceipt.version !== 1 ||
                dispatchReceipt.tenantId !== record.tenantId ||
                dispatchReceipt.invocationId !== pending.invocationId ||
                dispatchReceipt.correlationId !== pending.invocationId ||
                dispatchReceipt.intent !== "dispatch"
              ) {
                throw new Error("legacy or malformed dispatch receipt cannot authorize terminal acknowledgement");
              }
              return {
                source: "durable_rbp_sequence" as const,
                receiptVersion: 1 as const,
                tenantId: dispatchReceipt.tenantId,
                rsid: record.rsid,
                sessionBindingId: record.sessionBindingId,
                acceptedConnectionId: record.connectionId,
                authorizedSessionVersion: record.sessionVersion,
                invocationId: dispatchReceipt.invocationId,
                correlationId: dispatchReceipt.correlationId,
                proofDigest: dispatchReceipt.proofDigest,
                routeSnapshotDigest: dispatchReceipt.routeSnapshotDigest,
                egressEpoch: dispatchReceipt.egressEpoch,
                leaseTicket: dispatchReceipt.leaseTicket,
                intent: "dispatch" as const,
                gatewaySequence: pending.gatewaySequence,
                cumulativeAck: envelope.ack,
                envelopeDigest: pending.envelopeDigest,
                durableSequenceVersion: record.sessionVersion,
                acceptedAtMs: this.#clock(),
              };
            })()
          : existing?.acceptance ?? null;
        const journals = terminalJournalRecords(pending.journalRecords, envelope);
        const journal: GatewayVerifiedBridgeJournalEvidence | null = journals.length === 0
          ? null
          : {
              kind: "known_terminal", rsid: record.rsid, sessionBindingId: record.sessionBindingId,
              envelopeDigest: pending.envelopeDigest, journalRecords: journals, batchTerminal: null,
              durableJournalVersion: record.sessionVersion, recordedAtMs: this.#clock(),
            };
        const evidence: DurableDispatchEvidence = {
          envelopeDigest: pending.envelopeDigest,
          acceptance,
          journal,
          terminalTruth: admission.terminalTruth,
          terminalDigest: admission.terminalDigest,
          terminalCarrierDigest: admission.terminalCarrierDigest,
        };
        completion.current = terminalOutcome(envelope);
        return nextSessionRecord(stored, record, {
          ...record,
          sequence: accepted.state,
          pending: null,
          evidence: [
            ...record.evidence.filter((candidate) => candidate.envelopeDigest !== pending.envelopeDigest),
            evidence,
          ],
        }, this.#clock());
      },
    );
    return BRIDGE_CARRIER_COMMIT_OK;
  }

  /**
   * Terminal persistence is a separate CAS domain from delivery.  In
   * particular, unregister may win after the carrier was admitted but before
   * its terminal CAS.  Retrying only a version conflict is safe; all other
   * uncertainty remains fail-closed.
   */
  async #commitTerminalWithRevocationCas(
    active: ActiveSession,
    connection: LiveConnection,
    envelope: Extract<RbpEnvelope, { rsid: string; type: "result" | "error" }>,
    authorityTicket: TenantAuthorityTicket,
  ): Promise<
    | { readonly kind: "committed"; readonly record: DurableRbpSession; readonly completion: GatewayExecutorOutcome }
    | { readonly kind: "suppressed" }
  > {
    const terminalCarrierDigest = immutableEnvelopeDigest(envelope);
    if (active.record.pending === null) {
      const accepted = acceptInboundData(active.record.sequence, envelope as DataEnvelopeSnapshot);
      const replay = active.record.evidence.some((entry) =>
        entry.terminalCarrierDigest === terminalCarrierDigest &&
        sameJson(entry.terminalTruth ?? null, durableTerminalTruth(envelope)),
      );
      if (replay && accepted.kind === "duplicate") {
        return { kind: "committed", record: active.record, completion: terminalOutcome(envelope) };
      }
      throw new GatewayRbpFault("auth", "terminal admission has no active exact dispatch", 403, 4403);
    }
    const original = terminalAdmissionFor(active.record, connection.connectionId, envelope);
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const attempted: { current: { readonly prior: StoredRecord<GatewayJsonValue>; readonly next: DurableRbpSession } | null } = { current: null };
      const persisted = await this.#sessionRepository.transact({ tenantId: original.tenantId }, async (tx) => {
        const tombstone = await tx.read<GatewayJsonValue>(GATEWAY_RBP_UNREGISTER_NAMESPACE, original.rsid);
        if (tombstone !== null) {
          const parsed = parseUnregisterTombstone(tombstone.value, {
            tenantId: original.tenantId, rsid: original.rsid, stored: tombstone,
          });
          if (
            parsed.sessionBindingId !== original.sessionBindingId ||
            parsed.acceptedConnectionId !== original.connectionId
          ) return { kind: "rejected" as const };
          return { kind: "revoked" as const };
        }
        const stored = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, original.rsid);
        if (stored === null) return { kind: "rejected" as const };
        const record = parseStoredSession(stored, original.tenantId, original.rsid);
        const fence = sessionEgressFence(record);
        if (fence.state === "revocation_pending") {
          if (
            record.sessionBindingId !== original.sessionBindingId ||
            record.connectionId !== original.connectionId
          ) return { kind: "rejected" as const };
          return { kind: "revoked" as const };
        }
        if (fence.state !== "open") return { kind: "rejected" as const };
        if (record.pending === null) {
          const accepted = acceptInboundData(record.sequence, envelope as DataEnvelopeSnapshot);
          const replay = record.evidence.some((entry) =>
            entry.terminalCarrierDigest === terminalCarrierDigest &&
            sameJson(entry.terminalTruth ?? null, original.terminalTruth),
          );
          return replay && accepted.kind === "duplicate"
            ? { kind: "committed" as const, record }
            : { kind: "rejected" as const };
        }
        const admission = terminalAdmissionFor(record, connection.connectionId, envelope);
        if (!sameJson(admission, original)) return { kind: "rejected" as const };
        this.#assertAuthorityTicket(authorityTicket, connection, { session: record });
        const accepted = acceptInboundData(record.sequence, envelope as DataEnvelopeSnapshot);
        if (accepted.kind === "protocol_fault" || accepted.kind === "gap") {
          return { kind: "rejected" as const };
        }
        if (accepted.kind === "duplicate") {
          return { kind: "rejected" as const };
        }
        const existing = record.evidence.find((candidate) => candidate.envelopeDigest === record.pending!.envelopeDigest);
        const receipt = record.pending!.dispatchReceipt!;
        const acceptance = envelope.ack !== undefined && envelope.ack >= record.pending!.gatewaySequence
          ? {
              source: "durable_rbp_sequence" as const,
              receiptVersion: 1 as const,
              tenantId: receipt.tenantId,
              rsid: record.rsid,
              sessionBindingId: record.sessionBindingId,
              acceptedConnectionId: record.connectionId,
              authorizedSessionVersion: record.sessionVersion,
              invocationId: receipt.invocationId,
              correlationId: receipt.correlationId,
              proofDigest: receipt.proofDigest,
              routeSnapshotDigest: receipt.routeSnapshotDigest,
              egressEpoch: receipt.egressEpoch,
              leaseTicket: receipt.leaseTicket,
              intent: "dispatch" as const,
              gatewaySequence: record.pending!.gatewaySequence,
              cumulativeAck: envelope.ack,
              envelopeDigest: record.pending!.envelopeDigest,
              durableSequenceVersion: record.sessionVersion,
              acceptedAtMs: this.#clock(),
            }
          : existing?.acceptance ?? null;
        const journals = terminalJournalRecords(record.pending!.journalRecords, envelope);
        const batchTerminal = envelope.type === "result" && envelope.payload.kind === "batch"
          ? { result: structuredClone(envelope.payload) as BatchResult, resultDigest: makeParamsDigest(envelope.payload as unknown as JsonValue) }
          : null;
        const journal: GatewayVerifiedBridgeJournalEvidence | null = journals.length === 0 ? null : {
          kind: "known_terminal", rsid: record.rsid, sessionBindingId: record.sessionBindingId,
          envelopeDigest: record.pending!.envelopeDigest, journalRecords: journals, batchTerminal,
          durableJournalVersion: record.sessionVersion, recordedAtMs: this.#clock(),
        };
        const next = nextSessionRecord(stored, record, {
          ...record,
          sequence: accepted.state,
          pending: null,
          evidence: [
            ...record.evidence.filter((candidate) => candidate.envelopeDigest !== record.pending!.envelopeDigest),
            {
              envelopeDigest: record.pending!.envelopeDigest,
              acceptance,
              journal,
              terminalTruth: original.terminalTruth,
              terminalDigest: original.terminalDigest,
              terminalCarrierDigest: original.terminalCarrierDigest,
            },
          ],
        }, this.#clock());
        attempted.current = { prior: stored, next };
        tx.stage({
          namespace: GATEWAY_RBP_SESSION_NAMESPACE, key: original.rsid, value: asJson(next),
          expect: { kind: "version", version: stored.version },
        });
        // Keep the committed evidence visible to the raw-store test seam that
        // deliberately interleaves post-commit revocation before readback.
        return { kind: "committed" as const, record: next, evidence: next.evidence };
      });
      if (persisted.ok) {
        if (persisted.value.kind === "committed") {
          return { kind: "committed", record: persisted.value.record, completion: terminalOutcome(envelope) };
        }
        if (persisted.value.kind === "revoked") {
          await this.#persistLateTerminalEvidence(original);
          return { kind: "suppressed" };
        }
        throw new GatewayRbpFault("auth", "terminal admission no longer matches its original dispatch", 403, 4403);
      }
      if (persisted.code === "conflict") continue;
      if (persisted.code === "durability_uncertain" && attempted.current !== null) {
        const readBack = await this.#readStoredSession(original.tenantId, original.rsid);
        if (readBack !== null) {
          const record = parseStoredSession(readBack, original.tenantId, original.rsid);
          const exact = record.evidence.some((entry) =>
            entry.envelopeDigest === original.pendingEnvelopeDigest &&
            entry.terminalDigest === original.terminalDigest &&
            sameJson(entry.terminalTruth ?? null, original.terminalTruth),
          );
          if (exact && record.pending === null) {
            return { kind: "committed", record, completion: terminalOutcome(envelope) };
          }
          if (sessionEgressFence(record).state === "revocation_pending") {
            await this.#persistLateTerminalEvidence(original);
            return { kind: "suppressed" };
          }
        }
      }
      throw new GatewayRbpFault("unavailable", persisted.message, 503, 1011);
    }
    throw new GatewayRbpFault("unavailable", "terminal persistence CAS retry bound was exhausted", 503, 1011);
  }

  async #persistLateTerminalEvidence(admission: TerminalAdmission): Promise<void> {
    const value: DurableLateTerminalEvidence = Object.freeze({
      schema: GATEWAY_RBP_LATE_TERMINAL_NAMESPACE,
      tenantId: admission.tenantId,
      rsid: admission.rsid,
      sessionBindingId: admission.sessionBindingId,
      connectionId: admission.connectionId,
      correlationId: admission.correlationId,
      terminalSequence: admission.terminalSequence,
      terminalCarrierDigest: admission.terminalCarrierDigest,
      terminalDigest: admission.terminalDigest,
      dispatchReceiptDigest: admission.dispatchReceiptDigest,
      terminalTruth: admission.terminalTruth,
      recordedAtMs: this.#clock(),
    });
    const key = lateTerminalKey(admission);
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const persisted = await this.#sessionRepository.transact({ tenantId: admission.tenantId }, async (tx) => {
        const tombstoneStored = await tx.read<GatewayJsonValue>(GATEWAY_RBP_UNREGISTER_NAMESPACE, admission.rsid);
        const sessionStored = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, admission.rsid);
        if (sessionStored === null) return "rejected" as const;
        const session = parseStoredSession(sessionStored, admission.tenantId, admission.rsid);
        const tombstone = tombstoneStored === null ? null : parseUnregisterTombstone(tombstoneStored.value, {
          tenantId: admission.tenantId, rsid: admission.rsid, stored: tombstoneStored,
        });
        if (
          (tombstone === null && sessionEgressFence(session).state !== "revocation_pending") ||
          session.sessionBindingId !== admission.sessionBindingId ||
          session.connectionId !== admission.connectionId ||
          (tombstone !== null &&
            (tombstone.sessionBindingId !== admission.sessionBindingId ||
              tombstone.acceptedConnectionId !== admission.connectionId))
        ) return "rejected" as const;
        const prior = await tx.read<GatewayJsonValue>(GATEWAY_RBP_LATE_TERMINAL_NAMESPACE, key);
        if (prior !== null) {
          const existing = prior.value as unknown as Partial<DurableLateTerminalEvidence>;
          return (
            existing.schema === value.schema &&
            existing.tenantId === value.tenantId &&
            existing.rsid === value.rsid &&
            existing.sessionBindingId === value.sessionBindingId &&
            existing.connectionId === value.connectionId &&
            existing.correlationId === value.correlationId &&
            existing.terminalSequence === value.terminalSequence &&
            existing.terminalCarrierDigest === value.terminalCarrierDigest &&
            existing.terminalDigest === value.terminalDigest &&
            existing.dispatchReceiptDigest === value.dispatchReceiptDigest &&
            sameJson(existing.terminalTruth ?? null, value.terminalTruth)
          ) ? "replay" as const : "rejected" as const;
        }
        tx.stage({ namespace: GATEWAY_RBP_LATE_TERMINAL_NAMESPACE, key, value: asJson(value), expect: { kind: "absent" } });
        return "created" as const;
      });
      if (persisted.ok && (persisted.value === "created" || persisted.value === "replay")) return;
      if (persisted.ok) {
        throw new GatewayRbpFault("auth", "late terminal no longer matches revoked session authority", 403, 4403);
      }
      if (persisted.code === "conflict") continue;
      throw new GatewayRbpFault("unavailable", persisted.message, 503, 1011);
    }
    throw new GatewayRbpFault("unavailable", "late terminal persistence CAS retry bound was exhausted", 503, 1011);
  }

  async #acceptData(
    connection: LiveConnection,
    envelope: Extract<RbpEnvelope, { rsid: string }>,
    authorityTicket: TenantAuthorityTicket,
  ): Promise<void> {
    const active = this.#active.get(envelope.rsid);
    if (
      active === undefined ||
      active.record.connectionId !== connection.connectionId ||
      active.tenantId !== connection.auth.actor.tenantId
    ) {
      throw new GatewayRbpFault("auth", "rsid is not bound to this connection", 403, 4403);
    }
    this.#assertAuthorityTicket(authorityTicket, connection, {
      session: active.record,
    });
    if (envelope.type === "partial" && envelope.payload.kind === "chunk") {
      const requiresArtifactCapability = envelope.payload.stream_id.startsWith("artifact:");
      if (
        !connection.grantedCapabilities.includes("chunked_results") ||
        (requiresArtifactCapability &&
          !connection.grantedCapabilities.includes("artifact_result_v1")) ||
        !this.#carrierReady() ||
        this.#resourceAuthority === undefined
      ) {
        throw new GatewayRbpFault("unsupported", "chunk carrier was not granted", 403, 4403);
      }
      const { scope, effective } = this.#carrierScope(active.record);
      const committed: { current: DurableRbpSession | null } = { current: null };
      await this.#resourceAuthority.acceptBridgeChunk({
        scope,
        effectiveMcpRequestScope: effective,
        rsid: active.rsid,
        invocationId: envelope.payload.invocation_id,
        sequence: envelope.seq,
        chunk: envelope.payload,
        commitBridge: async (tx) => await this.#commitCarrierChunk(tx, active, connection, envelope, authorityTicket, committed),
      });
      if (committed.current === null) {
        throw new GatewayRbpFault("unavailable", "carrier receipt commit was not observable", 503, 1011);
      }
      active.record = committed.current;
      return;
    }
    if (envelope.type === "result" && envelope.payload.kind === "invocation" && envelope.payload.chunked === true) {
      const manifest = artifactManifestFor(envelope);
      const requiredCapability = manifest === null ? "chunked_results" : "artifact_result_v1";
      if (!connection.grantedCapabilities.includes(requiredCapability) || !this.#carrierReady() || this.#resourceAuthority === undefined) {
        throw new GatewayRbpFault("unsupported", "result carrier was not granted", 403, 4403);
      }
      const { scope, effective } = this.#carrierScope(active.record);
      // Freeze immutable admission and resource scope before Stage C.  Retries
      // reuse this exact proof; they never rerun the Bridge or mint handles.
      const admission = terminalAdmissionFor(active.record, connection.connectionId, envelope);
      const committed: { current: DurableRbpSession | null } = { current: null };
      const completion: { current: GatewayExecutorOutcome | null } = { current: null };
      try {
        if (manifest === null) {
          const chunked = envelope.payload as typeof envelope.payload & {
            readonly stream_id: "result";
            readonly content_type: string;
            readonly total_chunks: number;
            readonly total_size: number;
            readonly sha256: string;
          };
          const carrierResult = await this.#resourceAuthority.acceptBridgeChunkedResultTerminal({
            scope,
            effectiveMcpRequestScope: effective,
            rsid: active.rsid,
            invocationId: envelope.payload.invocation_id,
            manifest: {
              kind: "chunked_result",
              descriptor: {
                stream_id: chunked.stream_id,
                content_type: chunked.content_type,
                total_chunks: chunked.total_chunks,
                total_size: chunked.total_size,
                sha256: chunked.sha256,
              },
            },
            commitBridge: async (tx, mode) => await this.#commitCarrierTerminal(tx, active, connection, envelope, authorityTicket, admission, mode, committed, completion),
          });
          completion.current = envelope.payload.status === "guarded"
            ? { state: "guarded", reason: envelope.payload.guarded_reason, result: carrierResult }
            : { state: "completed", result: carrierResult };
        } else {
          await this.#resourceAuthority.acceptBridgeTerminal({
            scope,
            effectiveMcpRequestScope: effective,
            rsid: active.rsid,
            invocationId: envelope.payload.invocation_id,
            manifest,
            commitBridge: async (tx, mode) => await this.#commitCarrierTerminal(tx, active, connection, envelope, authorityTicket, admission, mode, committed, completion),
          });
        }
      } catch (error: unknown) {
        if (error instanceof BridgeCarrierTerminalAborted) {
          await this.#persistLateTerminalEvidence(admission);
          return;
        }
        throw error;
      }
      if (committed.current === null || completion.current === null) {
        throw new GatewayRbpFault("unavailable", "carrier terminal commit was not observable", 503, 1011);
      }
      active.record = committed.current;
      let deliveryAuthorized = true;
      try {
        this.#assertAuthorityTicket(authorityTicket, connection, { session: committed.current });
      } catch {
        deliveryAuthorized = false;
      }
      if (!deliveryAuthorized && this.#ticketScopeIsRevokedOrBlocked(authorityTicket)) {
        await this.#revokeStaleAuthorizedSession(connection, envelope.rsid);
      }
      const waiter = this.#waiters.get(envelope.payload.invocation_id);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(envelope.payload.invocation_id);
        waiter.resolve(deliveryAuthorized
          ? completion.current
          : { state: "failed", error: { code: "executor_unavailable", message: "identity revocation suppressed terminal delivery" } });
      }
      return;
    }
    if (
      (envelope.type === "error" || envelope.type === "result") &&
      !(envelope.type === "result" && envelope.payload.kind === "invocation" && envelope.payload.chunked === true)
    ) {
      const terminal = await this.#commitTerminalWithRevocationCas(
        active,
        connection,
        envelope,
        authorityTicket,
      );
      if (terminal.kind === "suppressed") return;
      active.record = terminal.record;
      let deliveryAuthorized = true;
      try {
        this.#assertAuthorityTicket(authorityTicket, connection, { session: terminal.record });
      } catch {
        deliveryAuthorized = false;
      }
      if (!deliveryAuthorized && this.#ticketScopeIsRevokedOrBlocked(authorityTicket)) {
        await this.#revokeStaleAuthorizedSession(connection, envelope.rsid);
      }
      const terminalWaiterId = terminalCorrelationId(envelope) ?? "";
      const waiter = this.#waiters.get(terminalWaiterId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(terminalWaiterId);
        waiter.resolve(deliveryAuthorized
          ? terminal.completion
          : { state: "failed", error: { code: "executor_unavailable", message: "identity revocation suppressed terminal delivery" } });
      }
      return;
    }
    const nextLiveDocumentRoute =
      envelope.type === "doc_context_update"
        ? liveDocumentRouteFrom(
            envelope.payload,
            connection.connectionId,
            envelope.seq,
            documentContextDigest(envelope.payload as unknown as JsonValue),
          )
        : undefined;
    const updated = await this.#updateSession(active.tenantId, active.rsid, (record) => {
      this.#assertAuthorityTicket(authorityTicket, connection, {
        session: active.record,
      });
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
        const receipt = pending.dispatchReceipt ?? null;
        if (
          receipt === null ||
          receipt.version !== 1 ||
          receipt.tenantId !== record.tenantId ||
          receipt.invocationId !== pending.invocationId ||
          receipt.correlationId !== pending.invocationId ||
          receipt.intent !== "dispatch" ||
          receipt.proofDigest.length !== 71 ||
          receipt.routeSnapshotDigest.length !== 71 ||
          receipt.egressEpoch < 0 ||
          !Number.isSafeInteger(receipt.egressEpoch) ||
          receipt.leaseTicket < 1 ||
          !Number.isSafeInteger(receipt.leaseTicket)
        ) {
          throw new Error("legacy or malformed dispatch receipt cannot authorize acknowledgement");
        }
        const existing = evidence.find(
          (candidate) => candidate.envelopeDigest === pending!.envelopeDigest,
        );
        const acceptance = {
          source: "durable_rbp_sequence" as const,
          receiptVersion: 1 as const,
          tenantId: receipt.tenantId,
          rsid: record.rsid,
          sessionBindingId: record.sessionBindingId,
          acceptedConnectionId: record.connectionId,
          authorizedSessionVersion: record.sessionVersion,
          invocationId: receipt.invocationId,
          correlationId: receipt.correlationId,
          proofDigest: receipt.proofDigest,
          routeSnapshotDigest: receipt.routeSnapshotDigest,
          egressEpoch: receipt.egressEpoch,
          leaseTicket: receipt.leaseTicket,
          intent: "dispatch" as const,
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
          terminalTruth: existing?.terminalTruth ?? null,
        };
        evidence = [
          ...evidence.filter(
            (candidate) => candidate.envelopeDigest !== pending!.envelopeDigest,
          ),
          next,
        ];
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
    let deliveryAuthorized = true;
    try {
      this.#assertAuthorityTicket(authorityTicket, connection, {
        session: updated,
      });
    } catch {
      deliveryAuthorized = false;
    }
    if (
      !deliveryAuthorized &&
      this.#ticketScopeIsRevokedOrBlocked(authorityTicket)
    ) {
      await this.#revokeStaleAuthorizedSession(connection, envelope.rsid);
    }
    if (!deliveryAuthorized) {
      throw new GatewayRbpFault(
        "auth",
        "identity revocation suppressed inbound delivery",
        403,
        4403,
      );
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
    if (prior !== undefined) this.#untrackSession(prior.record);
    this.#active.set(record.rsid, {
      tenantId: record.tenantId,
      rsid: record.rsid,
      record,
    });
    this.#trackSession(record);
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
    const result = await this.#sessionRepository.transact({ tenantId }, async (tx) =>
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

  async #settleLocalFinalTombstoneIfPresent(
    tenantId: string,
    rsid: string,
  ): Promise<void> {
    const observed = await this.#sessionRepository.transact({ tenantId }, async (tx) =>
      tx.read<GatewayJsonValue>(GATEWAY_RBP_UNREGISTER_NAMESPACE, rsid),
    );
    if (!observed.ok) {
      throw new GatewayRbpFault("unavailable", observed.message, 503, 1011);
    }
    if (observed.value === null) return;
    const tombstone = parseUnregisterTombstone(observed.value.value, {
      tenantId,
      rsid,
      stored: observed.value,
    });
    const verified = await this.#verifyFinalTombstone(
      tenantId,
      rsid,
      tombstone.owner,
      tombstone.reason,
    );
    if (verified === null) {
      throw new GatewayRbpFault(
        "unavailable",
        "final tombstone disappeared during local settlement",
        503,
        1011,
      );
    }
    this.#completeLocalUnregister(
      rsid,
      this.#active.get(rsid)?.record.pending ?? null,
      true,
    );
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

  /** Startup-only, restart-safe legacy import.  A plan is written only after
   * the complete source has been parsed and bounded.  Its staged children are
   * deny-only until the v2 marker is the final write of the final CAS. */
  async #importLegacySessionAtStartup(tenantId: string, rsid: string): Promise<StoreOutcome<void>> {
    const planned = await this.store.transact({ tenantId }, async (tx) => {
      const marker = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE, rsid);
      if (marker !== null) { parseSessionCutoverV2(marker, tenantId, rsid); return null; }
      const existing = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE, rsid);
      const sessionStored = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid);
      if (sessionStored === null) {
        if (existing !== null) throw new Error("orphaned session migration plan");
        return null;
      }
      const session = parseStoredSession(sessionStored, tenantId, rsid);
      const recovery = await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, rsid);
      const holds = recovery === null ? [] : parseLegacyRecoveryHolds(recovery.value, rsid);
      // The preflight happens before a single stage.  Exactly 64 scopes fit
      // in one 128-write pair batch; 65 fails with zero migration writes.
      if (holds.length > MAX_RECOVERABLE_MUTATION_SCOPES) {
        throw new Error("startup legacy migration exceeds 64 scopes");
      }
      const facts = legacyCutoverFacts(session, holds);
      const sessionSource = migrationSource(sessionStored);
      const recoverySource = recovery === null ? null : migrationSource(recovery);
      const migrationId = digest(canonicalizeJson({
        tenantId, rsid, sessionSource, recoverySource, legacyDigest: facts.legacyDigest,
      } as unknown as JsonValue));
      const source = recoverySource ?? sessionSource;
      const scopes = holds.map((legacy) => {
        const scopeDigest = conflictScopeDigest(mutationScopeKey(legacy.mutationScope));
        const migration: DurableSessionMigrationBinding = { migrationId, source };
        const nowMs = session.updatedAtMs;
        const hold: DurableMutationHold = {
          schema: GATEWAY_MUTATION_HOLD_NAMESPACE, tenantId, createdAtMs: nowMs, updatedAtMs: nowMs,
          recordVersion: 1, holdId: legacy.holdId as `vh:${string}`, rsid,
          mutationScopeJcs: mutationScopeKey(legacy.mutationScope),
          originIdempotencyKeys: legacy.originIdempotencyKeys, state: legacy.state,
          evidenceIds: [], evidenceDigests: [],
          resolutionIds: legacy.resolutionId === null ? [] : [legacy.resolutionId], migration,
        };
        const conflict: DurableMutationConflict = {
          schema: GATEWAY_MUTATION_CONFLICT_NAMESPACE, tenantId, createdAtMs: nowMs, updatedAtMs: nowMs,
          recordVersion: 1, rsid, scopeDigest, holdId: hold.holdId,
          mutationScopeJcs: hold.mutationScopeJcs, active: legacy.state !== "cleared", migration,
        };
        return {
          holdId: hold.holdId, scopeDigest,
          holdDigest: digest(canonicalizeJson(hold as unknown as JsonValue)),
          conflictDigest: digest(canonicalizeJson(conflict as unknown as JsonValue)),
        };
      }).sort((left, right) => left.scopeDigest.localeCompare(right.scopeDigest));
      const plan: DurableSessionMigrationPlan = {
        schema: GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE, tenantId, rsid, migrationId,
        sessionSource, recoverySource, legacyDigest: facts.legacyDigest, scopes,
      };
      if (existing === null) {
        tx.stage({ namespace: GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE, key: rsid, value: asJson(plan), expect: { kind: "absent" } });
        return plan;
      }
      const parsed = parseSessionMigrationPlan(existing, tenantId, rsid);
      if (!sameJson(parsed as unknown as JsonValue, plan as unknown as JsonValue)) {
        throw new Error("legacy migration source drift or non-identical replay");
      }
      return parsed;
    });
    if (!planned.ok) return planned;
    if (planned.value === null) return Object.freeze({ ok: true as const, value: undefined });
    const plan = planned.value;
    for (let start = 0; start < plan.scopes.length; start += MAX_RECOVERABLE_MUTATION_SCOPES) {
      const batch = plan.scopes.slice(start, start + MAX_RECOVERABLE_MUTATION_SCOPES);
      const staged = await this.#stageLegacyMigrationBatch(tenantId, rsid, plan, batch);
      if (!staged.ok) return staged;
    }
    return await this.#finalizeLegacyMigration(tenantId, rsid, plan);
  }

  async #stageLegacyMigrationBatch(
    tenantId: string, rsid: string, plan: DurableSessionMigrationPlan,
    batch: readonly DurableSessionMigrationPlan["scopes"][number][],
  ): Promise<StoreOutcome<void>> {
    return this.store.transact({ tenantId }, async (tx) => {
      const currentPlan = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE, rsid);
      if (currentPlan === null || !sameJson(parseSessionMigrationPlan(currentPlan, tenantId, rsid) as unknown as JsonValue, plan as unknown as JsonValue)) {
        throw new Error("legacy migration plan changed during batching");
      }
      const session = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid);
      const recovery = await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, rsid);
      if (!sameMigrationSource(session, plan.sessionSource) ||
        (plan.recoverySource === null ? recovery !== null : !sameMigrationSource(recovery, plan.recoverySource))) {
        throw new Error("legacy migration source drift during batching");
      }
      if (session === null) throw new Error("legacy migration session disappeared during batching");
      const legacySession = parseStoredSession(session, tenantId, rsid);
      const holds = recovery === null ? [] : parseLegacyRecoveryHolds(recovery.value, rsid);
      const source = plan.recoverySource ?? plan.sessionSource;
      const byDigest = new Map(holds.map((hold) => [conflictScopeDigest(mutationScopeKey(hold.mutationScope)), hold]));
      for (const scope of batch) {
        const legacy = byDigest.get(scope.scopeDigest);
        if (legacy === undefined) throw new Error("migration plan scope is absent from legacy source");
        const migration: DurableSessionMigrationBinding = { migrationId: plan.migrationId, source };
        const nowMs = legacySession.updatedAtMs;
        const hold: DurableMutationHold = {
          schema: GATEWAY_MUTATION_HOLD_NAMESPACE, tenantId, createdAtMs: nowMs, updatedAtMs: nowMs,
          recordVersion: 1, holdId: legacy.holdId as `vh:${string}`, rsid,
          mutationScopeJcs: mutationScopeKey(legacy.mutationScope), originIdempotencyKeys: legacy.originIdempotencyKeys,
          state: legacy.state, evidenceIds: [], evidenceDigests: [],
          resolutionIds: legacy.resolutionId === null ? [] : [legacy.resolutionId], migration,
        };
        const conflict: DurableMutationConflict = {
          schema: GATEWAY_MUTATION_CONFLICT_NAMESPACE, tenantId, createdAtMs: nowMs, updatedAtMs: nowMs,
          recordVersion: 1, rsid, scopeDigest: scope.scopeDigest, holdId: hold.holdId,
          mutationScopeJcs: hold.mutationScopeJcs, active: legacy.state !== "cleared", migration,
        };
        if (digest(canonicalizeJson(hold as unknown as JsonValue)) !== scope.holdDigest ||
          digest(canonicalizeJson(conflict as unknown as JsonValue)) !== scope.conflictDigest) throw new Error("migration plan digest mismatch");
        for (const [namespace, key, value, expectedDigest] of [
          [GATEWAY_MUTATION_HOLD_NAMESPACE, hold.holdId, asJson(hold), scope.holdDigest],
          [GATEWAY_MUTATION_CONFLICT_NAMESPACE, conflictRecordKey(rsid, scope.scopeDigest), asJson(conflict), scope.conflictDigest],
        ] as const) {
          const present = await tx.read<GatewayJsonValue>(namespace, key);
          if (present === null) tx.stage({ namespace, key, value, expect: { kind: "absent" } });
          else if (present.version !== 1 || digest(canonicalizeJson(present.value as JsonValue)) !== expectedDigest) {
            throw new Error("non-identical staged migration child");
          }
        }
      }
      return undefined;
    });
  }

  async #finalizeLegacyMigration(tenantId: string, rsid: string, plan: DurableSessionMigrationPlan): Promise<StoreOutcome<void>> {
    return this.#sessionRepository.transact({ tenantId }, async (tx) => {
      const marker = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE, rsid);
      if (marker !== null) { parseSessionCutoverV2(marker, tenantId, rsid); return undefined; }
      const currentPlan = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_MIGRATION_NAMESPACE, rsid);
      if (currentPlan === null || !sameJson(parseSessionMigrationPlan(currentPlan, tenantId, rsid) as unknown as JsonValue, plan as unknown as JsonValue)) {
        throw new Error("legacy migration plan changed before finalization");
      }
      const sessionStored = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid);
      const recovery = await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, rsid);
      if (!sameMigrationSource(sessionStored, plan.sessionSource) ||
        (plan.recoverySource === null ? recovery !== null : !sameMigrationSource(recovery, plan.recoverySource))) {
        throw new Error("legacy migration source drift before finalization");
      }
      if (sessionStored === null) throw new Error("legacy migration session disappeared before finalization");
      const session = parseStoredSession(sessionStored, tenantId, rsid);
      const facts = legacyCutoverFacts(session, recovery === null ? [] : parseLegacyRecoveryHolds(recovery.value, rsid));
      if (facts.legacyDigest !== plan.legacyDigest) throw new Error("legacy migration proof drifted before finalization");
      for (const scope of plan.scopes) {
        const hold = await tx.read<GatewayJsonValue>(GATEWAY_MUTATION_HOLD_NAMESPACE, scope.holdId);
        const conflict = await tx.read<GatewayJsonValue>(GATEWAY_MUTATION_CONFLICT_NAMESPACE, conflictRecordKey(rsid, scope.scopeDigest));
        if (hold === null || conflict === null || hold.version !== 1 || conflict.version !== 1 ||
          digest(canonicalizeJson(hold.value as JsonValue)) !== scope.holdDigest ||
          digest(canonicalizeJson(conflict.value as JsonValue)) !== scope.conflictDigest) {
          throw new Error("staged migration manifest proof is incomplete");
        }
      }
      const nextSession: DurableRbpSession = {
        ...session,
        normalizedConflictIndex: { version: 1, state: "complete", scopeDigests: facts.activeScopeDigests },
      };
      tx.stage({ namespace: GATEWAY_RBP_SESSION_NAMESPACE, key: rsid, value: asJson(nextSession), expect: { kind: "version", version: sessionStored.version } });
      // SessionAggregateRepository emits the root and makes the dedicated v2
      // cutover marker its last write, atomically deleting the verified legacy
      // session/recovery source with the v2 receipt.
      return undefined;
    }, { allowUnmarkedMigration: true });
  }

  async #assertCutoverSemanticProof(
    tx: Pick<StoreTransaction, "read">,
    tenantId: string,
    rsid: string,
    record: DurableRbpSession,
    marker: DurableHoldCutover,
    legacyHolds: readonly ValidatedLegacyHold[],
    legacyAuthorityExists: boolean,
  ): Promise<void> {
    if (record.normalizedConflictIndex === undefined) {
      throw new Error("cutover marker lacks a normalized conflict index");
    }
    const index = sessionConflictIndex(record);
    if (index.state !== "complete") {
      throw new Error("cutover marker requires a complete normalized index");
    }
    const indexedPairs = new Map<string, {
      readonly hold: DurableMutationHold;
      readonly conflict: DurableMutationConflict;
      readonly scope: MutationScope;
    }>();
    for (const scopeDigest of index.scopeDigests) {
      const pair = await this.#readConflictPairByDigest(
        tx,
        tenantId,
        rsid,
        scopeDigest,
      );
      if (pair === null || pair.conflict.active !== true) {
        throw new Error("cutover index has no exact active conflict pair");
      }
      indexedPairs.set(scopeDigest, pair);
    }
    if (!legacyAuthorityExists) {
      return;
    }
    const proof = legacyCutoverFacts(record, legacyHolds);
    if (marker.legacyDigest !== proof.legacyDigest) {
      throw new Error("cutover marker does not match canonical legacy facts");
    }
    if (
      marker.importedHoldCount !== proof.importedHoldCount ||
      marker.importedConflictCount !== proof.importedConflictCount ||
      marker.importedResolutionCount !== proof.importedResolutionCount
    ) {
      throw new Error("cutover marker does not match canonical legacy counts");
    }
    for (const legacy of legacyHolds) {
      const pair = await this.#readConflictPairByHoldId(
        tx,
        tenantId,
        rsid,
        legacy.holdId as `vh:${string}`,
      );
      const active = legacy.state !== "cleared";
      if (
        pair.hold.state !== legacy.state ||
        pair.conflict.active !== active ||
        mutationScopeKey(pair.scope) !== mutationScopeKey(legacy.mutationScope) ||
        !sameJson(
          pair.hold.originIdempotencyKeys,
          legacy.originIdempotencyKeys,
        ) ||
        !sameJson(
          pair.hold.resolutionIds,
          legacy.resolutionId === null ? [] : [legacy.resolutionId],
        ) ||
        index.scopeDigests.includes(pair.scopeDigest) !== active
      ) {
        throw new Error("cutover import disagrees with normalized authority");
      }
      indexedPairs.delete(pair.scopeDigest);
    }
    for (const pair of indexedPairs.values()) {
      if (
        pair.hold.createdAtMs <= marker.cutoverAtMs ||
        pair.hold.resolutionIds.length !== 0
      ) {
        throw new Error("cutover index contains an unaccounted imported pair");
      }
    }
  }

  async #assertMutationAdmission(
    tx: Pick<StoreTransaction, "read">,
    tenantId: string,
    rsid: string,
    record: DurableRbpSession,
    scopes: readonly MutationScope[],
    ownHoldIds: ReadonlySet<string>,
    trustedHoldIds: ReadonlySet<string>,
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
      if (index.state === "complete" && pair.conflict.active && !indexed) {
        throw new Error("normalized active conflict is absent from its index");
      }
      if (indexed && pair.conflict.active !== true) {
        throw new Error("normalized conflict index references a cleared pair");
      }
      if (
        pair.conflict.active &&
        !(
          originRedelivery &&
          ownHoldIds.has(pair.hold.holdId) &&
          trustedHoldIds.has(pair.hold.holdId)
        )
      ) {
        return false;
      }
    }

    const recovery = await tx.read<GatewayJsonValue>(
      GATEWAY_RECOVERY_NAMESPACE,
      rsid,
    );
    let legacyHolds: readonly ValidatedLegacyHold[] = [];
    if (recovery !== null) {
      if (
        recovery.namespace !== GATEWAY_RECOVERY_NAMESPACE ||
        recovery.tenantId !== tenantId ||
        recovery.key !== rsid
      ) {
        throw new Error("legacy recovery authority key or tenant mismatch");
      }
      legacyHolds = parseLegacyRecoveryHolds(recovery.value, rsid);
    }
    if (cutover !== null) {
      await this.#assertCutoverSemanticProof(
        tx,
        tenantId,
        rsid,
        record,
        cutover,
        legacyHolds,
        recovery !== null,
      );
      return true;
    }
    return !legacyHolds.some((hold) =>
      hold.state !== "cleared" &&
      scopes.some((scope) => mutationScopesConflict(hold.mutationScope, scope)) &&
      !(
        originRedelivery &&
        ownHoldIds.has(hold.holdId) &&
        trustedHoldIds.has(hold.holdId)
      ) &&
      !(
        !originRedelivery &&
        hold.state === "resolved_pending_bridge" &&
        trustedHoldIds.has(hold.holdId)
      ),
    );
  }

  #pendingRevocationSnapshot(
    record: DurableRbpSession,
    owner: DurableEgressRevocation["owner"],
    reason: SessionUnregister["reason"],
  ): {
    readonly revocation: DurableEgressRevocation;
    readonly candidates: readonly NormalizedHoldCandidate[];
  } {
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
      record.rsid,
      durablePendingMutationEntries(record),
    );
    return { revocation, candidates };
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
    const { revocation, candidates } = await this.#pendingRevocationSnapshot(
      record,
      owner,
      reason,
    );
    if (record.pending?.mutating === true && candidates.length === 0) {
      throw new Error("pending mutation has no recoverable legacy scope");
    }
    if (candidates.length > MAX_RECOVERABLE_MUTATION_SCOPES) {
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
    const verified = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
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

  async #installPendingRevocationCompanions(
    tenantId: string,
    rsid: string,
    owner: DurableEgressRevocation["owner"],
    reason: SessionUnregister["reason"],
  ): Promise<PendingRevocationAuthority> {
    for (let attempt = 0; attempt < MAX_AUTHORIZATION_CAS_ATTEMPTS; attempt += 1) {
      const installed = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
        const stored = await tx.read<GatewayJsonValue>(
          GATEWAY_RBP_SESSION_NAMESPACE,
          rsid,
        );
        if (stored === null) throw new Error("pending unregister session is missing");
        const record = parseStoredSession(stored, tenantId, rsid);
        const authority = await this.#pendingRevocationSnapshot(
          record,
          owner,
          reason,
        );
        if (
          (record.pending?.mutating === true && authority.candidates.length === 0) ||
          authority.candidates.length > MAX_RECOVERABLE_MUTATION_SCOPES
        ) {
          throw new Error("pending mutation exceeds recoverable companion capacity");
        }
        for (const candidate of authority.candidates) {
          await this.#ensureNormalizedConflictPair(
            tx,
            tenantId,
            rsid,
            candidate,
            this.#clock(),
          );
        }
        return authority.candidates.length;
      });
      if (installed.ok) {
        return await this.#verifyPendingRevocation(
          tenantId,
          rsid,
          owner,
          reason,
        );
      }
      if (installed.code === "conflict") continue;
      if (installed.code === "durability_uncertain") {
        const classified = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
          const stored = await tx.read<GatewayJsonValue>(
            GATEWAY_RBP_SESSION_NAMESPACE,
            rsid,
          );
          if (stored === null) return "partial" as const;
          const record = parseStoredSession(stored, tenantId, rsid);
          const authority = await this.#pendingRevocationSnapshot(
            record,
            owner,
            reason,
          );
          let observed = 0;
          for (const candidate of authority.candidates) {
            const hold = await tx.read<GatewayJsonValue>(
              GATEWAY_MUTATION_HOLD_NAMESPACE,
              candidate.holdId,
            );
            const scopeDigest = conflictScopeDigest(candidate.mutationScopeJcs);
            const conflict = await tx.read<GatewayJsonValue>(
              GATEWAY_MUTATION_CONFLICT_NAMESPACE,
              conflictRecordKey(rsid, scopeDigest),
            );
            if (hold === null && conflict === null) continue;
            observed += 1;
            if (hold === null || conflict === null) return "partial" as const;
            const pair = await this.#readConflictPairByDigest(
              tx,
              tenantId,
              rsid,
              scopeDigest,
            );
            if (
              pair === null ||
              pair.hold.holdId !== candidate.holdId ||
              pair.hold.mutationScopeJcs !== candidate.mutationScopeJcs ||
              !sameJson(
                pair.hold.originIdempotencyKeys,
                candidate.originIdempotencyKeys,
              )
            ) {
              return "partial" as const;
            }
          }
          return observed === 0
            ? "absent" as const
            : observed === authority.candidates.length
              ? "complete" as const
              : "partial" as const;
        });
        if (!classified.ok) {
          throw new GatewayRbpFault(
            "unavailable",
            classified.message,
            503,
            1011,
          );
        }
        if (classified.value === "complete") {
          return await this.#verifyPendingRevocation(
            tenantId,
            rsid,
            owner,
            reason,
          );
        }
        if (classified.value === "absent") continue;
        throw new GatewayRbpFault(
          "unavailable",
          "pending unregister companion write is partial",
          503,
          1011,
        );
      }
      throw new GatewayRbpFault("unavailable", installed.message, 503, 1011);
    }
    throw new GatewayRbpFault(
      "unavailable",
      "pending unregister companion retry bound was exhausted",
      503,
      1011,
    );
  }

  async #verifyFinalTombstone(
    tenantId: string,
    rsid: string,
    owner: DurableEgressRevocation["owner"],
    reason: SessionUnregister["reason"],
  ): Promise<DurableUnregisterTombstone | null> {
    const verified = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
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
      for (const scopeDigest of index.scopeDigests) {
        const pair = await this.#readConflictPairByDigest(
          tx,
          tenantId,
          rsid,
          scopeDigest,
        );
        if (pair === null || pair.conflict.active !== true) {
          throw new Error("final session index has no exact active pair");
        }
      }
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
      const journalHoldIds = [...new Set(
        session.evidence.flatMap((entry) =>
          entry.journal !== null &&
          entry.journal.recordedAtMs >= tombstone.createdAtMs
            ? entry.journal.journalRecords.flatMap((journal) =>
                journal.verificationHoldId === null
                  ? []
                  : [journal.verificationHoldId],
              )
            : [],
        ),
      )].sort();
      if (
        journalHoldIds.length > 0 &&
        !sameJson(journalHoldIds, tombstone.holdIds)
      ) {
        throw new Error("tombstone holds disagree with durable journal evidence");
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

  #completeLocalUnregister(
    rsid: string,
    pending: DurablePendingDispatch | null,
    knownNotDispatched: boolean,
  ): void {
    const active = this.#active.get(rsid);
    this.#active.delete(rsid);
    if (active !== undefined) this.#untrackSession(active.record);
    if (pending === null) return;
    const waiter = this.#waiters.get(pending.invocationId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.#waiters.delete(pending.invocationId);
    waiter.resolve(
      knownNotDispatched
        ? {
            state: "failed",
            error: {
              code: "executor_unavailable",
              message: "dispatch was revoked before transport send",
            },
          }
        : this.#indeterminateOutcome(pending.mutating),
    );
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
    const result = await this.#sessionRepository.transact({ tenantId }, async (tx) => {
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
