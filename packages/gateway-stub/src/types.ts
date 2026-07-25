import type {
  DispatchWindowLedger,
  ConnectionPhase,
  HoldEvidenceConclusion,
  InvocationJournalRecord,
  Invoke,
  InvokeBatch,
  MutationHoldLedger,
  MutationScope,
  RbpEnvelope,
  RbpSequenceState,
  RecoveryClearance,
  SessionRegister,
  SessionLifecycleState,
  StreamAssemblerState,
} from "@revagent/protocol";

import type { GatewayStubCore } from "./core.js";

export type BindingKind = "wss" | "http_sse";

export type AuthStatus = "active" | "revoked" | "seat_denied";

export interface StaticDeviceIdentity {
  status: AuthStatus;
  deviceId: string;
  tenantId: string;
  userId: string;
  seatId: string;
  machineFingerprint: string;
  provisionedCapabilities: string[];
}

export type StaticTokenTable = Readonly<Record<string, StaticDeviceIdentity>>;

export interface AuthenticatedDevice extends StaticDeviceIdentity {
  tokenDigest: string;
}

export interface PreNegotiationEnvelope<TType extends string, TPayload> {
  type: TType;
  id: string;
  ts: string;
  payload: TPayload;
  [key: string]: unknown;
}

export interface HelloPayload {
  min_protocol: number;
  max_protocol: number;
  capabilities: string[];
  bridge_version: string;
  device_id: string;
  machine: {
    hostname: string;
    os: string;
    [key: string]: unknown;
  };
  addin_versions: string[];
  [key: string]: unknown;
}

export interface HelloAckPayload {
  protocol: number;
  connection_id: string;
  granted_capabilities: string[];
  heartbeat_interval_ms: number;
  limits: {
    max_params_bytes: number;
    max_result_bytes: number;
    max_partial_bytes: number;
  };
  manifest: {
    latest_bridge_version: string;
    manifest_url: string;
  };
  [key: string]: unknown;
}

export type HelloEnvelope = PreNegotiationEnvelope<"hello", HelloPayload>;
export type HelloAckEnvelope = PreNegotiationEnvelope<"hello_ack", HelloAckPayload>;

/** JSON-safe form of the T2 stream assembler's Uint8Array chunks. */
export interface PersistedStreamAssembler {
  invocationId: string;
  decodedBytes: number;
  limits: StreamAssemblerState["limits"];
  streams: Array<{
    streamId: string;
    contentType: string;
    artifactId: string | null;
    artifactIndex: number | null;
    decodedBytes: number;
    chunks: Array<{
      chunkIndex: number;
      identityDigest: `sha256:${string}`;
      bytesBase64: string;
    }>;
  }>;
}

export interface PersistedArtifact {
  artifactId: string;
  artifactIndex: number;
  streamId: string;
  filename: string;
  contentType: string;
  totalChunks: number;
  totalSize: number;
  sha256: string;
  bytesBase64: string;
}

export interface PersistedChunkedResult {
  streamId: "result";
  contentType: string;
  totalChunks: number;
  totalSize: number;
  sha256: string;
  bytesBase64: string;
}

export interface PersistedTerminalOutcome {
  correlationId: string;
  envelope: RbpEnvelope | null;
  classification: "result" | "payload_omitted" | "cancelled" | "error" | "environment" | "journal_indeterminate";
  acceptedAtMs: number;
}

export interface PersistedOmittedPayloadRecovery {
  originInvocationId: string;
  parentCorrelationId: string;
  omittedResultDigest: string;
  mutating: boolean;
  mutationScope: MutationScope | null;
  state: "awaiting_correlated_read" | "read_dispatched" | "recovered";
  auditId: string | null;
  recoveryInvocationId: string | null;
  recoveryResultDigest: string | null;
  createdAtMs: number;
  completedAtMs: number | null;
}

export interface PersistedLateTerminalEvidence {
  correlationId: string;
  envelope: RbpEnvelope;
  envelopeDigest: string;
  classification: "result" | "payload_omitted" | "error";
  source: "gateway_expiry" | "bridge_late_replay" | "cancel_suppressed";
  acceptedAtMs: number;
}

export interface PersistedInFlight {
  kind: "invoke" | "batch";
  correlationId: string;
  memberInvocationIds: string[];
  /** Immutable digest of the exact queued RBP data envelope. */
  dispatchIdentity: string;
  /** Frozen batch request binding; null for an ordinary invocation. */
  batchAtomic: boolean | null;
  batchDigest: string | null;
  gatewaySeq: number;
  dispatchedAtMs: number;
  mutationEntries: Array<{
    invocationId: string;
    idempotencyKey: string;
    mutationScope: MutationScope;
  }>;
  verificationHoldId: string | null;
  omittedPayloadRecovery: {
    originInvocationId: string;
    omittedResultDigest: string;
    auditId: string;
  } | null;
  pendingRecoveryClearances: RecoveryClearance[];
  cancelRequested: boolean;
}

export interface PersistedExpiredOrigin {
  kind: PersistedInFlight["kind"];
  correlationId: string;
  memberInvocationIds: string[];
  dispatchIdentity: string;
  batchAtomic: boolean | null;
  batchDigest: string | null;
  mutationEntries: PersistedInFlight["mutationEntries"];
  expiredAtMs: number;
}

export interface PersistedSession {
  rsid: string;
  deviceId: string;
  tenantId: string;
  userId: string;
  seatId: string;
  localSessionKey: string;
  userHint: SessionRegister["user_hint"];
  machine: SessionRegister["machine"];
  revit: SessionRegister["revit"];
  addinVersion: string;
  resultContractVersion: number;
  bridgeVersion: string;
  port: number;
  resumeToken: string;
  resumeExpiresAtMs: number;
  revoked: boolean;
  documents: Array<Record<string, unknown>>;
  activeDocument: string | null;
  activeView: Record<string, unknown> | null;
  disciplineHint: string | null;
  grantedSessionCapabilities: string[];
  lifecycle: SessionLifecycleState;
  sequence: RbpSequenceState;
  dispatchWindow: DispatchWindowLedger;
  inFlight: PersistedInFlight | null;
  streamAssemblers: Record<string, PersistedStreamAssembler>;
  chunkedResults: Record<string, PersistedChunkedResult>;
  artifacts: Record<string, PersistedArtifact[]>;
  terminalOutcomes: Record<string, PersistedTerminalOutcome>;
  omittedPayloadRecoveries: Record<string, PersistedOmittedPayloadRecovery>;
  expiredOrigins: Record<string, PersistedExpiredOrigin>;
  lateTerminalEvidence: Record<string, PersistedLateTerminalEvidence[]>;
  verificationDispatches: Record<string, {
    holdId: string;
    mutationScope: MutationScope;
    dispatchIdentity: string;
  }>;
  lastHeartbeatAtMs: number;
  disconnectedAtMs: number | null;
  liveness: "steady" | "degraded" | "disconnected";
}

export interface PersistedGatewayState {
  schemaVersion: 1;
  nextId: number;
  sessions: Record<string, PersistedSession>;
  mutationHolds: MutationHoldLedger;
}

export interface SessionSnapshot extends Omit<PersistedSession, "resumeToken"> {
  resumeTokenRedacted: true;
}

export interface AuthorizationAuditEntry {
  sequence: number;
  atMs: number;
  operation: "hello" | "session_register" | "session_resume" | "session_unregister" | "heartbeat" | "bridge_data";
  decision: "allowed" | "rejected";
  reason:
    | "enrollment_bound"
    | "claimed_identity"
    | "machine_fingerprint_mismatch"
    | "connection_or_session_authority"
    | "credential_or_seat_status";
  connectionIdDigest: `sha256:${string}`;
  deviceIdDigest: `sha256:${string}`;
  claimedIdentityFields: string[];
}

export interface GatewayStubSnapshot {
  schemaVersion: 1;
  sessions: Record<string, SessionSnapshot>;
  mutationHolds: MutationHoldLedger;
  authorizationAudit: {
    evidenceVersion: 1;
    capacity: number;
    totalEventCount: number;
    droppedEventCount: number;
    secretsRedacted: true;
    entries: AuthorizationAuditEntry[];
  };
  runtime: {
    openConnections: number;
    connectionPhases: Record<string, ConnectionPhase>;
    activeTimers: number;
    activeDeliveries: number;
    bufferedSseConnections: string[];
    heldInboundFrames: number;
    heldOutboundFrames: number;
  };
}

export interface DispatchInvokeRequest {
  rsid: string;
  payload: Invoke;
}

export interface DispatchBatchRequest {
  rsid: string;
  payload: InvokeBatch;
}

export interface DispatchCancelRequest {
  rsid: string;
  invocationId: string;
  reason: "user_requested" | "client_disconnected" | "deadline_exceeded" | "gateway_shutdown";
}

export interface DispatchPayloadRecoveryRequest {
  rsid: string;
  originInvocationId: string;
  omittedResultDigest: string;
  auditId: string;
  payload: Invoke;
}

export interface VerificationEvidenceRequest {
  rsid: string;
  holdId: string;
  mutationScope: MutationScope;
  verificationInvocationId: string;
  evidenceDigest: string;
  conclusion: HoldEvidenceConclusion;
  journalRecord: InvocationJournalRecord;
}

export interface LateTerminalEvidenceRequest {
  rsid: string;
  holdId: string;
  originIdempotencyKey: string;
  evidenceDigest: string;
  conclusion: HoldEvidenceConclusion;
  journalRecord: InvocationJournalRecord;
}

export type FaultDirection = "gateway_to_bridge" | "bridge_to_gateway";
export type FrameFaultAction = "drop" | "duplicate" | "delay" | "hold";

export interface FrameFaultRule {
  direction: FaultDirection;
  action: FrameFaultAction;
  binding?: BindingKind;
  messageType?: string;
  remaining?: number;
  delayMs?: number;
}

export interface OpeningFaultRule {
  binding: BindingKind;
  status: number;
  retryAfter?: string;
  remaining?: number;
}

export interface TestTransportConnection {
  readonly connectionId: string;
  readonly binding: BindingKind;
  readonly device: AuthenticatedDevice;
  readonly offeredProtocols: readonly number[];
  selectedProtocol: number;
  active: boolean;
  sendSerialized(serialized: string): Promise<void>;
  close(code: number, reason: string): Promise<void>;
}

export interface GatewayClock {
  nowMs(): number;
}

export interface GatewayStubCoreOptions {
  statePath: string;
  tokenTable: StaticTokenTable;
  supportedProtocols?: readonly number[];
  connectionCapabilities?: readonly string[];
  sessionCapabilities?: readonly string[];
  clock?: GatewayClock;
  /** Test-only durable state fault points. */
  stateStoreTestHooks?: {
    beforeCanonicalReplace?: () => void | Promise<void>;
    afterCanonicalReplace?: () => void | Promise<void>;
  };
}

export interface TlsServerOptions {
  cert: string | Buffer;
  key: string | Buffer;
}

export interface GatewayStubServerOptions extends GatewayStubCoreOptions {
  host?: string;
  port?: number;
  controlToken?: string;
  tls?: TlsServerOptions;
  livenessSweepMs?: number;
  /** Test-only upper bound for receiving WSS hello after upgrade. */
  helloTimeoutMs?: number;
  /** Test-only upper bound between HTTP connection creation and SSE attachment. */
  sseAttachTimeoutMs?: number;
}

export interface GatewayStubHandle {
  readonly origin: string;
  readonly wsUrl: string;
  readonly httpConnectionUrl: string;
  readonly controlUrl: string;
  readonly controlToken: string;
  readonly core: GatewayStubCore;
  close(): Promise<void>;
}
