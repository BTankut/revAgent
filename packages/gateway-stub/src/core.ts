import { timingSafeEqual } from "node:crypto";

import type {
  BatchResult,
  ConnectionEvent,
  ConnectionLifecycleState,
  DataEnvelopeSnapshot,
  Heartbeat,
  Invoke,
  InvokeBatch,
  JsonValue,
  MutationHold,
  MutationScope,
  Partial,
  RbpEnvelope,
  Result,
  SessionRegister,
  SessionEvent,
  SessionLifecycleState,
  SessionUnregister,
} from "@revagent/protocol";
import {
  acceptInboundData,
  applyCumulativeAck,
  authorizeMutationDispatch,
  closeDispatchWindow,
  conflictingMutationHolds,
  createConnectionLifecycle,
  createDispatchWindowLedger,
  createRbpSequenceState,
  createSessionLifecycle,
  dataEnvelopeImmutableDigest,
  installMutationHolds,
  isOriginRedeliveryExempt,
  makeBatchDigest,
  makeIdempotencyKey,
  makeParamsDigest,
  mutationScopeKey,
  mutationScopesConflict,
  openDispatchWindow,
  queueOutboundData,
  RBP_MAX_CONTROL_FRAME_BYTES,
  RBP_HEARTBEAT_DEGRADED_AFTER_MS,
  RBP_HEARTBEAT_DISCONNECTED_AFTER_MS,
  RBP_MAX_INVOCATION_PARAMS_BYTES,
  RBP_MAX_SAFE_SEQUENCE,
  RbpFrameError,
  recordLateTerminalEvidence,
  recordVerificationEvidence,
  resolveMutationHold,
  retransmitOutbox,
  transitionConnection,
  transitionSession,
  validateRbpEnvelope,
} from "@revagent/protocol";

import {
  CarrierValidationError,
  discardInvocationStreams,
  finalizeInvocationCarrier,
  recordPartial,
} from "./artifactSink.js";
import { FaultController, type FrameDeliveryResult } from "./faults.js";
import {
  allocateUuidV7,
  opaqueId,
  sha256Digest,
} from "./ids.js";
import {
  normalizeSupportedProtocols,
  ProtocolNegotiationError,
  selectProtocolVersion,
} from "./negotiation.js";
import { serializeHelloAck } from "./preNegotiation.js";
import { DurableGatewayStateStore } from "./stateStore.js";
import {
  assertImplementedProtocolWindow,
  parseNegotiatedRbpFrame,
  serializeNegotiatedRbpEnvelope,
} from "./versionAdapter.js";
import type {
  AuthStatus,
  AuthenticatedDevice,
  AuthorizationAuditEntry,
  DispatchBatchRequest,
  DispatchCancelRequest,
  DispatchInvokeRequest,
  DispatchPayloadRecoveryRequest,
  GatewayClock,
  GatewayStubCoreOptions,
  GatewayStubSnapshot,
  HelloAckEnvelope,
  HelloEnvelope,
  LateTerminalEvidenceRequest,
  PersistedGatewayState,
  PersistedInFlight,
  PersistedSession,
  StaticDeviceIdentity,
  StaticEnrollmentGrant,
  TestTransportConnection,
  VerificationEvidenceRequest,
} from "./types.js";

const RESUME_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PENDING_HOLD_MS = 10 * 60 * 1000;
const AUTHORIZATION_AUDIT_CAPACITY = 256;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RESERVED_IDENTITY_FIELDS = new Set([
  "tenant_id",
  "user_id",
  "seat_id",
  "principal",
  "seat",
]);

class SystemClock implements GatewayClock {
  nowMs(): number {
    return Date.now();
  }
}

interface RuntimeConnection {
  transport: TestTransportConnection;
  helloReceived: boolean;
  grantedCapabilities: string[];
  lifecycle: ConnectionLifecycleState;
}

function claimedSessionIdentityFields(payload: unknown): string[] {
  const claimed: string[] = [];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return claimed;
  const record = payload as Record<string, unknown>;
  for (const field of RESERVED_IDENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) claimed.push(field);
  }
  const hint = record.user_hint;
  if (typeof hint === "object" && hint !== null && !Array.isArray(hint)) {
    for (const field of RESERVED_IDENTITY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(hint, field)) claimed.push(`user_hint.${field}`);
    }
  }
  return claimed.sort();
}

const rejectedClaimDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const rejectedClaimEncoder = new TextEncoder();

function preflightRejectedSessionIdentityClaims(
  frame: Uint8Array,
  parseError: unknown,
  selectedProtocol: number,
): string[] {
  // parseRbpFrame reaches invalid_envelope only after strict UTF-8, JSON syntax,
  // duplicate-key, and frame-limit checks. Re-parse solely to identify and
  // remove reserved field names, then require the remainder to pass the
  // unchanged canonical schema before classifying the rejection as auth.
  if (
    !(parseError instanceof RbpFrameError) ||
    parseError.code !== "invalid_envelope" ||
    frame.byteLength > RBP_MAX_CONTROL_FRAME_BYTES
  ) {
    return [];
  }

  let value: unknown;
  try {
    value = JSON.parse(rejectedClaimDecoder.decode(frame)) as unknown;
  } catch {
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== "session_register") return [];
  const payload = envelope.payload;
  const claimedFields = claimedSessionIdentityFields(payload);
  if (
    claimedFields.length === 0 ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return [];
  }

  const sanitizedPayload = { ...(payload as Record<string, unknown>) };
  for (const field of RESERVED_IDENTITY_FIELDS) delete sanitizedPayload[field];
  if (
    typeof sanitizedPayload.user_hint === "object" &&
    sanitizedPayload.user_hint !== null &&
    !Array.isArray(sanitizedPayload.user_hint)
  ) {
    const sanitizedHint = {
      ...(sanitizedPayload.user_hint as Record<string, unknown>),
    };
    for (const field of RESERVED_IDENTITY_FIELDS) delete sanitizedHint[field];
    sanitizedPayload.user_hint = sanitizedHint;
  }

  try {
    const sanitized = parseNegotiatedRbpFrame(
      rejectedClaimEncoder.encode(JSON.stringify({
        ...envelope,
        payload: sanitizedPayload,
      })),
      selectedProtocol,
    ).envelope;
    return sanitized.type === "session_register" ? claimedFields : [];
  } catch {
    return [];
  }
}

function authorizationOperation(envelope: RbpEnvelope): AuthorizationAuditEntry["operation"] {
  switch (envelope.type) {
    case "session_register":
    case "session_resume":
    case "session_unregister":
    case "heartbeat":
      return envelope.type;
    default:
      return "bridge_data";
  }
}

function authorizationReason(fault: GatewayStubFault): AuthorizationAuditEntry["reason"] {
  if (fault.message.includes("bridge-claimed")) return "claimed_identity";
  if (fault.message.includes("machine fingerprint")) return "machine_fingerprint_mismatch";
  if (fault.message.includes("credential") || fault.message.includes("seat authorization")) {
    return "credential_or_seat_status";
  }
  return "connection_or_session_authority";
}

export class GatewayStubFault extends Error {
  constructor(
    message: string,
    readonly faultClass: "protocol" | "auth" | "unsupported" | "environment",
    readonly closeCode: number,
  ) {
    super(message);
    this.name = "GatewayStubFault";
  }
}

export class WindowViolationError extends Error {
  constructor(readonly rsid: string) {
    super(`authoritative window=1 already has an in-flight invocation for ${rsid}`);
    this.name = "WindowViolationError";
  }
}

export class RecoveryHoldConflictError extends Error {
  constructor(readonly holdIds: string[]) {
    super(`mutation conflicts with active recovery hold(s): ${holdIds.join(",")}`);
    this.name = "RecoveryHoldConflictError";
  }
}

function cloneIdentity(identity: StaticDeviceIdentity, token: string): AuthenticatedDevice {
  return {
    ...structuredClone(identity),
    tokenDigest: sha256Digest(token),
  };
}

function secureStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function advanceConnection(
  state: ConnectionLifecycleState,
  event: ConnectionEvent,
): ConnectionLifecycleState {
  const transition = transitionConnection(state, event);
  if (transition.kind !== "transitioned") {
    throw new GatewayStubFault(`invalid connection transition: ${state.phase}/${event.type}`, "protocol", 4400);
  }
  return transition.state;
}

function advanceSession(
  state: SessionLifecycleState,
  event: SessionEvent,
): SessionLifecycleState {
  const transition = transitionSession(state, event);
  if (transition.kind !== "transitioned") {
    throw new GatewayStubFault(`invalid session transition: ${state.phase}/${event.type}`, "protocol", 4400);
  }
  return transition.state;
}

function assertJsonParamsSize(params: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(params);
  } catch {
    throw new GatewayStubFault("invocation params are not JSON serializable", "protocol", 4400);
  }
  if (Buffer.byteLength(serialized, "utf8") > RBP_MAX_INVOCATION_PARAMS_BYTES) {
    throw new GatewayStubFault("invocation params exceed 4 MiB", "protocol", 4400);
  }
}

function assertEnvelope(envelope: RbpEnvelope): void {
  if (!validateRbpEnvelope(envelope)) {
    throw new GatewayStubFault("stub attempted to emit an invalid RBP envelope", "protocol", 4400);
  }
}

function isTerminalResultFor(inFlight: PersistedInFlight, result: Result): boolean {
  return result.kind === "invocation"
    ? inFlight.kind === "invoke" && result.invocation_id === inFlight.correlationId
    : inFlight.kind === "batch" && result.batch_id === inFlight.correlationId;
}

function mutationEntriesForInvoke(rsid: string, payload: Invoke): PersistedInFlight["mutationEntries"] {
  return payload.mutating
    ? [{
        invocationId: payload.invocation_id,
        idempotencyKey: makeIdempotencyKey(rsid, payload.invocation_id),
        mutationScope: payload.mutation_scope,
      }]
    : [];
}

function mutationEntriesForBatch(rsid: string, payload: InvokeBatch): PersistedInFlight["mutationEntries"] {
  return payload.steps
    .filter((step) => step.mutating)
    .map((step) => ({
      invocationId: step.invocation_id,
      idempotencyKey: makeIdempotencyKey(rsid, step.invocation_id),
      mutationScope: step.mutation_scope as MutationScope,
    }));
}

export class GatewayStubCore {
  readonly faults = new FaultController();
  readonly supportedProtocols: readonly number[];
  private readonly store: DurableGatewayStateStore;
  private readonly clock: GatewayClock;
  private readonly connectionCapabilities: readonly string[];
  private readonly sessionCapabilities: readonly string[];
  private readonly tokenTable: Map<string, StaticDeviceIdentity>;
  private readonly enrollmentTokenTable: Map<string, StaticEnrollmentGrant>;
  private readonly usedEnrollmentTokens = new Set<string>();
  private readonly connections = new Map<string, RuntimeConnection>();
  private readonly sessionBindings = new Map<string, string>();
  private readonly authorizationAudit: AuthorizationAuditEntry[] = [];
  private authorizationAuditSequence = 0;

  private constructor(options: GatewayStubCoreOptions, store: DurableGatewayStateStore) {
    this.store = store;
    this.clock = options.clock ?? new SystemClock();
    const supportedProtocols = normalizeSupportedProtocols(options.supportedProtocols ?? [1]);
    assertImplementedProtocolWindow(supportedProtocols);
    this.supportedProtocols = supportedProtocols;
    this.connectionCapabilities = options.connectionCapabilities ?? [
      "journal_v1",
      "transport_streamable_http",
    ];
    this.sessionCapabilities = options.sessionCapabilities ?? [
      "batch_atomic",
      "doc_context_cached_v1",
    ];
    this.tokenTable = new Map(
      Object.entries(options.tokenTable).map(([token, identity]) => [token, structuredClone(identity)]),
    );
    this.enrollmentTokenTable = new Map(
      Object.entries(options.enrollmentTokenTable ?? {}).map(
        ([token, grant]) => [token, structuredClone(grant)],
      ),
    );
  }

  static async create(options: GatewayStubCoreOptions): Promise<GatewayStubCore> {
    const store = await DurableGatewayStateStore.open(
      options.statePath,
      options.stateStoreTestHooks,
    );
    const core = new GatewayStubCore(options, store);
    await core.recoverAfterRestart();
    return core;
  }

  authenticate(token: string): AuthenticatedDevice {
    const identity = this.tokenTable.get(token);
    if (identity === undefined) {
      throw new GatewayStubFault("device credential rejected", "auth", 4401);
    }
    if (identity.status !== "active") {
      throw new GatewayStubFault(
        identity.status === "revoked"
          ? "device credential revoked"
          : "device seat authorization rejected",
        "auth",
        4403,
      );
    }
    return cloneIdentity(identity, token);
  }

  exchangeEnrollment(
    enrollmentToken: string,
    machineFingerprint?: string,
  ): { deviceId: string; deviceToken: string } {
    const grant = this.enrollmentTokenTable.get(enrollmentToken);
    if (grant === undefined) {
      throw new GatewayStubFault("enrollment token rejected", "auth", 4401);
    }
    if (grant.status === "denied") {
      throw new GatewayStubFault("enrollment denied for this device", "auth", 4403);
    }
    if (this.usedEnrollmentTokens.has(enrollmentToken)) {
      throw new GatewayStubFault("enrollment token already used", "auth", 4409);
    }
    this.usedEnrollmentTokens.add(enrollmentToken);
    // A real Gateway binds the fingerprint presented at enrollment to the
    // issued device credential; session_register is later checked against that
    // binding. Keeping only the static table value made every real bridge fail
    // registration with machine_fingerprint_mismatch, because a real bridge
    // derives its fingerprint locally and cannot know the table constant.
    if (machineFingerprint !== undefined) {
      const identity = this.tokenTable.get(grant.deviceToken);
      if (identity !== undefined) {
        identity.machineFingerprint = machineFingerprint;
      }
    }
    return { deviceId: grant.deviceId, deviceToken: grant.deviceToken };
  }

  async setAuthStatus(token: string, status: AuthStatus): Promise<string[]> {
    const identity = this.tokenTable.get(token);
    if (identity === undefined) {
      throw new Error("unknown static test token");
    }
    const affected = [...this.connections.entries()]
      .filter(([, runtime]) => runtime.transport.device.deviceId === identity.deviceId)
      .map(([connectionId]) => connectionId);
    if (status !== "active") {
      const now = this.clock.nowMs();
      const revokedRsids = await this.store.update((draft) => {
        const revoked: string[] = [];
        for (const session of Object.values(draft.sessions)) {
          if (session.deviceId !== identity.deviceId || session.revoked) continue;
          if (session.inFlight !== null) this.expireInFlight(draft, session, now);
          session.revoked = true;
          session.liveness = "disconnected";
          session.disconnectedAtMs = now;
          session.lifecycle = advanceSession(session.lifecycle, {
            type: "unregister",
            reason: "operator_requested",
          });
          revoked.push(session.rsid);
        }
        return revoked;
      });
      for (const rsid of revokedRsids) this.sessionBindings.delete(rsid);
    }
    identity.status = status;
    for (const runtime of this.connections.values()) {
      if (runtime.transport.device.deviceId === identity.deviceId) {
        runtime.transport.device.status = status;
      }
    }
    return affected;
  }

  async allocateConnectionId(device: AuthenticatedDevice): Promise<string> {
    return this.store.update((draft) => {
      const uuid = allocateUuidV7(draft, this.clock.nowMs());
      return opaqueId("conn", `${device.deviceId}/${uuid}`);
    });
  }

  attachConnection(transport: TestTransportConnection): void {
    if (this.connections.has(transport.connectionId)) {
      throw new Error(`duplicate runtime connection id: ${transport.connectionId}`);
    }
    let lifecycle = createConnectionLifecycle();
    lifecycle = advanceConnection(lifecycle, { type: "start" });
    lifecycle = advanceConnection(lifecycle, { type: "transport_opened" });
    lifecycle = advanceConnection(lifecycle, { type: "authentication_accepted" });
    this.connections.set(transport.connectionId, {
      transport,
      helloReceived: false,
      grantedCapabilities: [],
      lifecycle,
    });
  }

  async acceptHello(connectionId: string, hello: HelloEnvelope): Promise<HelloAckEnvelope> {
    const runtime = this.requireConnection(connectionId);
    if (runtime.helloReceived) {
      throw new GatewayStubFault("hello may appear only once", "protocol", 4400);
    }
    if (!secureStringEqual(hello.payload.device_id, runtime.transport.device.deviceId)) {
      this.recordAuthorizationAudit(runtime, "hello", "rejected", "connection_or_session_authority", []);
      throw new GatewayStubFault("hello device_id does not match authenticated enrollment", "auth", 4403);
    }
    const helloFingerprint = hello.payload.machine.fingerprint;
    if (
      typeof helloFingerprint !== "string" ||
      !SHA256_PATTERN.test(helloFingerprint) ||
      !secureStringEqual(
        helloFingerprint,
        runtime.transport.device.machineFingerprint,
      )
    ) {
      this.recordAuthorizationAudit(runtime, "hello", "rejected", "machine_fingerprint_mismatch", []);
      throw new GatewayStubFault(
        "hello machine fingerprint does not match enrollment",
        "auth",
        4403,
      );
    }

    let selected: number;
    try {
      selected = selectProtocolVersion(
        this.supportedProtocols.filter((version) =>
          runtime.transport.offeredProtocols.includes(version)),
        hello.payload.min_protocol,
        hello.payload.max_protocol,
      );
    } catch (error) {
      if (error instanceof ProtocolNegotiationError) {
        throw new GatewayStubFault(error.message, "unsupported", 4426);
      }
      throw error;
    }
    const provisioned = new Set(runtime.transport.device.provisionedCapabilities);
    const requested = new Set(hello.payload.capabilities);
    const granted = this.connectionCapabilities.filter(
      (capability) => provisioned.has(capability) && requested.has(capability),
    );
    if (
      runtime.transport.binding === "http_sse" &&
      !granted.includes("transport_streamable_http")
    ) {
      throw new GatewayStubFault(
        "HTTP/SSE fallback requires provisioned, declared, and granted transport_streamable_http",
        "unsupported",
        4400,
      );
    }
    const ack = await this.store.update((draft) => ({
      type: "hello_ack" as const,
      id: allocateUuidV7(draft, this.clock.nowMs()),
      ts: new Date(this.clock.nowMs()).toISOString(),
      payload: {
        protocol: selected,
        connection_id: connectionId,
        granted_capabilities: granted,
        heartbeat_interval_ms: 15_000,
        limits: {
          max_params_bytes: 4 * 1024 * 1024,
          max_result_bytes: 32 * 1024 * 1024,
          max_partial_bytes: 1024 * 1024,
        },
        manifest: {
          latest_bridge_version: "0.1.0-test",
          manifest_url: "/bridge/update/manifest",
        },
      },
    }));
    runtime.helloReceived = true;
    runtime.grantedCapabilities = granted;
    runtime.transport.selectedProtocol = selected;
    runtime.lifecycle = advanceConnection(runtime.lifecycle, {
      type: "hello_accepted",
      selectedProtocol: selected,
      grantedCapabilities: granted,
    });
    this.recordAuthorizationAudit(runtime, "hello", "allowed", "enrollment_bound", []);
    return ack;
  }

  activateConnection(connectionId: string): void {
    const runtime = this.requireConnection(connectionId);
    if (!runtime.helloReceived) {
      throw new GatewayStubFault("connection cannot activate before hello", "protocol", 4400);
    }
    runtime.transport.active = true;
  }

  async receiveFrame(connectionId: string, frame: Uint8Array): Promise<FrameDeliveryResult> {
    const runtime = this.requireActiveConnection(connectionId);
    let envelope: RbpEnvelope;
    let wireProtocol: number | null;
    try {
      const parsed = parseNegotiatedRbpFrame(
        frame,
        runtime.transport.selectedProtocol,
      );
      envelope = parsed.envelope;
      wireProtocol = parsed.wireProtocol;
    } catch (error) {
      const claimedFields = preflightRejectedSessionIdentityClaims(
        frame,
        error,
        runtime.transport.selectedProtocol,
      );
      if (claimedFields.length > 0) {
        this.recordAuthorizationAudit(
          runtime,
          "session_register",
          "rejected",
          "claimed_identity",
          claimedFields,
        );
        throw new GatewayStubFault(
          "session registration contains bridge-claimed principal or seat authority",
          "auth",
          4403,
        );
      }
      throw new GatewayStubFault(
        error instanceof Error ? error.message : "invalid RBP frame",
        "protocol",
        4400,
      );
    }
    if (envelope.type === "hello" || envelope.type === "hello_ack") {
      throw new GatewayStubFault("pre-negotiation message received after hello exchange", "protocol", 4400);
    }
    if (wireProtocol !== runtime.transport.selectedProtocol) {
      throw new GatewayStubFault("message version differs from selected protocol", "protocol", 4400);
    }
    try {
      return await this.faults.apply(
        connectionId,
        runtime.transport.binding,
        "bridge_to_gateway",
        envelope.type === "partial" ? envelope.payload.kind : envelope.type,
        async () => this.processEnvelope(connectionId, envelope),
      );
    } catch (error) {
      if (error instanceof GatewayStubFault && error.faultClass === "auth") {
        const claimedFields = envelope.type === "session_register"
          ? claimedSessionIdentityFields(envelope.payload)
          : [];
        this.recordAuthorizationAudit(
          runtime,
          authorizationOperation(envelope),
          "rejected",
          authorizationReason(error),
          claimedFields,
        );
      }
      throw error;
    }
  }

  async dispatchInvoke(request: DispatchInvokeRequest): Promise<RbpEnvelope> {
    const { rsid, payload } = request;
    assertJsonParamsSize(payload.params);
    return this.dispatchData(
      rsid,
      "invoke",
      payload,
      payload.invocation_id,
      mutationEntriesForInvoke(rsid, payload),
      payload.verification?.hold_id ?? null,
      null,
    );
  }

  async dispatchBatch(request: DispatchBatchRequest): Promise<RbpEnvelope> {
    const { rsid, payload } = request;
    for (const step of payload.steps) {
      assertJsonParamsSize(step.params);
      const paramsDigest = makeParamsDigest(step.params as never);
      if (paramsDigest !== step.params_digest) {
        throw new GatewayStubFault("batch step params_digest mismatch", "protocol", 4400);
      }
    }
    const digest = makeBatchDigest(payload as never);
    if (digest !== payload.batch_digest) {
      throw new GatewayStubFault("batch_digest mismatch", "protocol", 4400);
    }
    return this.dispatchData(
      rsid,
      "invoke_batch",
      payload,
      payload.batch_id,
      mutationEntriesForBatch(rsid, payload),
      null,
      null,
    );
  }

  async dispatchPayloadRecovery(request: DispatchPayloadRecoveryRequest): Promise<RbpEnvelope> {
    const session = this.requireSession(request.rsid);
    const recovery = session.omittedPayloadRecoveries[request.originInvocationId];
    if (
      recovery === undefined ||
      recovery.state === "recovered" ||
      recovery.omittedResultDigest !== request.omittedResultDigest
    ) {
      throw new GatewayStubFault("payload recovery does not match a pending omitted result", "protocol", 4400);
    }
    if (
      request.payload.mutating ||
      request.payload.verification !== null ||
      request.payload.recovery_clearances.length !== 0 ||
      request.payload.invocation_id === request.originInvocationId ||
      request.auditId.length === 0
    ) {
      throw new GatewayStubFault("payload recovery must be a distinct audited read", "protocol", 4400);
    }
    assertJsonParamsSize(request.payload.params);
    return this.dispatchData(
      request.rsid,
      "invoke",
      request.payload,
      request.payload.invocation_id,
      [],
      null,
      {
        originInvocationId: request.originInvocationId,
        omittedResultDigest: request.omittedResultDigest,
        auditId: request.auditId,
      },
    );
  }

  async dispatchCancel(request: DispatchCancelRequest): Promise<RbpEnvelope> {
    const session = this.requireSession(request.rsid);
    if (session.inFlight === null || session.inFlight.kind !== "invoke" || session.inFlight.correlationId !== request.invocationId) {
      throw new GatewayStubFault("cancel target is not the active invocation", "protocol", 4400);
    }
    const envelope = await this.store.update((draft) => {
      const target = draft.sessions[request.rsid]!;
      if (
        target.inFlight === null ||
        target.inFlight.kind !== "invoke" ||
        target.inFlight.correlationId !== request.invocationId
      ) {
        throw new GatewayStubFault("cancel target is no longer the active invocation", "protocol", 4400);
      }
      target.inFlight.cancelRequested = true;
      return this.appendDataEnvelope(draft, target, "cancel", {
        invocation_id: request.invocationId,
        reason: request.reason,
      });
    });
    await this.sendPersisted(request.rsid, envelope);
    return envelope;
  }

  async recordVerificationHoldEvidence(request: VerificationEvidenceRequest): Promise<MutationHold> {
    return this.store.update((draft) => {
      const session = draft.sessions[request.rsid];
      const dispatch = session?.verificationDispatches[request.verificationInvocationId];
      const terminal = session?.terminalOutcomes[request.verificationInvocationId];
      const terminalPayload = terminal?.envelope?.type === "result"
        ? terminal.envelope.payload
        : null;
      if (
        dispatch === undefined ||
        dispatch.holdId !== request.holdId ||
        mutationScopeKey(dispatch.mutationScope) !== mutationScopeKey(request.mutationScope) ||
        terminal?.classification !== "result" ||
        terminalPayload?.kind !== "invocation" ||
        terminalPayload.invocation_id !== request.verificationInvocationId ||
        terminalPayload.result_digest !== request.evidenceDigest
      ) {
        throw new GatewayStubFault(
          "verification evidence is not correlated to an accepted digest-bound read terminal",
          "protocol",
          4400,
        );
      }
      const result = recordVerificationEvidence(draft.mutationHolds, {
        rsid: request.rsid,
        holdId: request.holdId,
        mutationScope: request.mutationScope,
        verificationInvocationId: request.verificationInvocationId,
        evidenceDigest: request.evidenceDigest,
        conclusion: request.conclusion,
        journalRecord: request.journalRecord,
      });
      if (result.kind === "rejected") {
        throw new GatewayStubFault(`verification evidence rejected: ${result.reason}`, "protocol", 4400);
      }
      draft.mutationHolds = result.ledger;
      return result.hold;
    });
  }

  async recordLateTerminalHoldEvidence(request: LateTerminalEvidenceRequest): Promise<MutationHold> {
    return this.store.update((draft) => {
      const prefix = `${request.rsid}/`;
      const invocationId = request.originIdempotencyKey.startsWith(prefix)
        ? request.originIdempotencyKey.slice(prefix.length)
        : "";
      const retained = draft.sessions[request.rsid]?.lateTerminalEvidence[invocationId]?.some((evidence) => {
        const payload = evidence.envelope.payload;
        return evidence.envelope.type === "result"
          ? payload.kind === "invocation" && payload.result_digest === request.evidenceDigest
          : evidence.envelope.type === "error" && payload.result_digest === request.evidenceDigest;
      }) ?? false;
      if (!retained) {
        throw new GatewayStubFault(
          "late-terminal evidence is not correlated to retained digest-bound wire evidence",
          "protocol",
          4400,
        );
      }
      const result = recordLateTerminalEvidence(draft.mutationHolds, {
        rsid: request.rsid,
        holdId: request.holdId,
        originIdempotencyKey: request.originIdempotencyKey,
        evidenceDigest: request.evidenceDigest,
        conclusion: request.conclusion,
        journalRecord: request.journalRecord,
      });
      if (result.kind === "rejected") {
        throw new GatewayStubFault(`late-terminal evidence rejected: ${result.reason}`, "protocol", 4400);
      }
      draft.mutationHolds = result.ledger;
      return result.hold;
    });
  }

  async installSyntheticHold(
    rsid: string,
    mutationScope: MutationScope,
    originInvocationIds: string[],
  ): Promise<readonly MutationHold[]> {
    return this.store.update((draft) => {
      if (draft.sessions[rsid] === undefined) {
        throw new Error("unknown rsid");
      }
      const result = installMutationHolds(
        draft.mutationHolds,
        rsid,
        originInvocationIds.map((invocationId) => ({
          originIdempotencyKey: makeIdempotencyKey(rsid, invocationId),
          mutationScope,
        })),
      );
      if (result.kind === "blocked") {
        throw new RecoveryHoldConflictError(result.conflictingHolds.map((hold) => hold.holdId));
      }
      draft.mutationHolds = result.ledger;
      return result.holds;
    });
  }

  async expirePendingNow(rsid: string): Promise<void> {
    await this.store.update((draft) => {
      const session = draft.sessions[rsid];
      if (session === undefined) {
        throw new Error("unknown rsid");
      }
      this.expireInFlight(draft, session, this.clock.nowMs());
    });
  }

  /**
   * Strict conformance-only counter seam. It advances an otherwise idle,
   * durable sequence state so the real parser and dispatch paths can exercise
   * JSON-safe exhaustion and forward-gap behavior in bounded wall-clock time.
   */
  async primeSequenceForConformance(
    rsid: string,
    mode: "bridge_to_gateway_near_exhaustion" | "gateway_to_bridge_gap_after_one",
  ): Promise<{
    readonly rsid: string;
    readonly mode: typeof mode;
    readonly nextTxSeq: number | null;
    readonly highestTxSeq: number;
    readonly lastRxSeq: number;
    readonly lastPeerAck: number;
    readonly outboxCount: number;
  }> {
    this.requireSession(rsid);
    if (!this.sessionBindings.has(rsid)) {
      throw new GatewayStubFault("sequence conformance prime requires a connected session", "environment", 1011);
    }
    const state = await this.store.update((draft) => {
      const session = draft.sessions[rsid];
      if (
        session === undefined ||
        session.revoked ||
        !session.lifecycle.dispatchAllowed
      ) {
        throw new GatewayStubFault("sequence conformance prime requires an active session", "auth", 4403);
      }
      if (
        session.inFlight !== null ||
        session.dispatchWindow.active.length !== 0 ||
        session.sequence.outbox.length !== 0
      ) {
        throw new GatewayStubFault("sequence conformance prime requires an idle data window", "protocol", 4400);
      }
      if (mode === "bridge_to_gateway_near_exhaustion") {
        if (
          session.sequence.lastRxSeq !== 1 ||
          session.sequence.nextTxSeq !== 1 ||
          session.sequence.highestTxSeq !== 0 ||
          session.sequence.lastPeerAck !== 0
        ) {
          throw new GatewayStubFault("near-exhaustion prime requires the exact post-registration baseline", "protocol", 4400);
        }
        session.sequence = {
          ...session.sequence,
          lastRxSeq: RBP_MAX_SAFE_SEQUENCE - 1,
        };
      } else if (mode === "gateway_to_bridge_gap_after_one") {
        if (
          session.sequence.nextTxSeq !== 2 ||
          session.sequence.highestTxSeq !== 1 ||
          session.sequence.lastPeerAck !== 1
        ) {
          throw new GatewayStubFault("forward-gap prime requires one completed outbound dispatch", "protocol", 4400);
        }
        session.sequence = {
          ...session.sequence,
          nextTxSeq: 3,
          highestTxSeq: 2,
          lastPeerAck: 2,
          outbox: [],
        };
      } else {
        throw new GatewayStubFault("sequence conformance mode is invalid", "protocol", 4400);
      }
      return structuredClone(session.sequence);
    });
    return {
      rsid,
      mode,
      nextTxSeq: state.nextTxSeq,
      highestTxSeq: state.highestTxSeq,
      lastRxSeq: state.lastRxSeq,
      lastPeerAck: state.lastPeerAck,
      outboxCount: state.outbox.length,
    };
  }

  async livenessSweep(): Promise<string[]> {
    const now = this.clock.nowMs();
    const disconnectConnections = new Set<string>();
    await this.store.update((draft) => {
      for (const session of Object.values(draft.sessions)) {
        if (session.revoked) {
          continue;
        }
        const silence = now - session.lastHeartbeatAtMs;
        const connectionId = this.sessionBindings.get(session.rsid);
        const runtime = connectionId === undefined ? undefined : this.connections.get(connectionId);
        if (
          runtime !== undefined &&
          (runtime.lifecycle.phase === "steady" || runtime.lifecycle.phase === "degraded")
        ) {
          const transition = transitionConnection(runtime.lifecycle, {
            type: "heartbeat_silence",
            silenceMs: silence,
          });
          if (transition.kind === "transitioned") {
            runtime.lifecycle = transition.state;
            if (transition.state.phase === "backoff") {
              disconnectConnections.add(connectionId!);
            }
          }
        }
        if (silence >= RBP_HEARTBEAT_DISCONNECTED_AFTER_MS) {
          session.liveness = "disconnected";
          session.disconnectedAtMs ??= now;
        } else if (silence >= RBP_HEARTBEAT_DEGRADED_AFTER_MS) {
          session.liveness = "degraded";
        } else {
          session.liveness = "steady";
        }
        if (
          session.disconnectedAtMs !== null &&
          now - session.disconnectedAtMs >= PENDING_HOLD_MS &&
          session.inFlight !== null
        ) {
          this.expireInFlight(draft, session, now);
        }
      }
    });
    return [...disconnectConnections];
  }

  async disconnectConnection(connectionId: string, reason = "transport_closed"): Promise<void> {
    const runtime = this.connections.get(connectionId);
    if (runtime === undefined) {
      return;
    }
    this.faults.cancelConnection(connectionId);
    runtime.transport.active = false;
    if (runtime.lifecycle.phase !== "shutdown") {
      const transition = transitionConnection(runtime.lifecycle, {
        type: "connection_failed",
        failure: "environment",
      });
      if (transition.kind === "transitioned") {
        runtime.lifecycle = transition.state;
      }
    }
    this.connections.delete(connectionId);
    const now = this.clock.nowMs();
    const bound = [...this.sessionBindings.entries()]
      .filter(([, value]) => value === connectionId)
      .map(([rsid]) => rsid);
    for (const rsid of bound) {
      this.sessionBindings.delete(rsid);
    }
    await this.store.update((draft) => {
      for (const rsid of bound) {
        const session = draft.sessions[rsid];
        if (session !== undefined) {
          session.disconnectedAtMs ??= now;
          session.liveness = "disconnected";
          if (session.lifecycle.phase === "registered") {
            session.lifecycle = advanceSession(session.lifecycle, { type: "connection_lost" });
          }
        }
      }
    });
    void reason;
  }

  async sendConnectionFault(connectionId: string, fault: GatewayStubFault): Promise<void> {
    const runtime = this.connections.get(connectionId);
    if (runtime === undefined || !runtime.helloReceived) {
      return;
    }
    const envelope = await this.store.update((draft) => this.makeControlEnvelope(draft, "error", {
      retryable: false,
      // O1 connection-level errors are deliberately limited to protocol/auth.
      // Richer classes remain invocation-scoped data faults; an unsupported or
      // environment connection guard therefore closes as a protocol fault.
      fault_class: fault.faultClass === "auth" ? "auth" : "protocol",
      outcome: "known",
      verification_required: false,
      replayed: false,
      late_after_indeterminate: false,
      message: fault.message.slice(0, 4096),
    }));
    await this.sendEnvelope(connectionId, envelope);
  }

  snapshot(): GatewayStubSnapshot {
    const state = this.store.snapshot();
    const sessions = Object.fromEntries(
      Object.entries(state.sessions).map(([rsid, session]) => {
        const { resumeToken, ...visible } = session;
        void resumeToken;
        return [rsid, {
          ...visible,
          resumeTokenRedacted: true as const,
        }];
      }),
    );
    const faultSnapshot = this.faults.snapshot();
    return {
      schemaVersion: 1,
      sessions,
      mutationHolds: structuredClone(state.mutationHolds),
      authorizationAudit: {
        evidenceVersion: 1,
        capacity: AUTHORIZATION_AUDIT_CAPACITY,
        totalEventCount: this.authorizationAuditSequence,
        droppedEventCount: Math.max(0, this.authorizationAuditSequence - this.authorizationAudit.length),
        secretsRedacted: true,
        entries: structuredClone(this.authorizationAudit),
      },
      runtime: {
        openConnections: this.connections.size,
        connectionPhases: Object.fromEntries(
          [...this.connections.entries()].map(([connectionId, runtime]) => [
            connectionId,
            runtime.lifecycle.phase,
          ]),
        ),
        activeTimers: faultSnapshot.activeTimers,
        activeDeliveries: faultSnapshot.activeDeliveries,
        bufferedSseConnections: faultSnapshot.bufferedSseConnections,
        heldInboundFrames: faultSnapshot.heldInboundFrames,
        heldOutboundFrames: faultSnapshot.heldOutboundFrames,
      },
    };
  }

  async close(): Promise<void> {
    const deliveriesClosed = this.faults.clear();
    const errors: unknown[] = [];
    const connections = [...this.connections.values()];
    for (const runtime of connections) {
      try {
        await runtime.transport.close(1001, "stub_shutdown");
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await deliveriesClosed;
    } catch (error) {
      errors.push(error);
    }
    for (const connectionId of [...this.connections.keys()]) {
      try {
        await this.disconnectConnection(connectionId, "stub_shutdown");
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.store.flush();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Gateway stub close failed");
  }

  private async dispatchData(
    rsid: string,
    type: "invoke" | "invoke_batch",
    payload: Invoke | InvokeBatch,
    correlationId: string,
    mutationEntries: PersistedInFlight["mutationEntries"],
    verificationHoldId: string | null,
    omittedPayloadRecovery: PersistedInFlight["omittedPayloadRecovery"],
  ): Promise<RbpEnvelope> {
    const current = this.requireSession(rsid);
    if (current.inFlight !== null || current.dispatchWindow.active.length !== 0) {
      throw new WindowViolationError(rsid);
    }
    if (!current.lifecycle.dispatchAllowed) {
      throw new GatewayStubFault("session lifecycle does not allow dispatch", "environment", 1011);
    }
    const connectionId = this.sessionBindings.get(rsid);
    if (connectionId === undefined) {
      throw new GatewayStubFault("session is not connected", "environment", 1011);
    }
    if (type === "invoke_batch" && (payload as InvokeBatch).atomic && !current.grantedSessionCapabilities.includes("batch_atomic")) {
      throw new GatewayStubFault("atomic batch is not granted for this session", "unsupported", 4400);
    }
    this.assertDispatchDocumentScopes(current, payload, mutationEntries);

    const envelope = await this.store.update((draft) => {
      const session = draft.sessions[rsid]!;
      if (session.revoked || !session.lifecycle.dispatchAllowed) {
        throw new GatewayStubFault("session lifecycle no longer allows dispatch", "auth", 4403);
      }
      if (session.inFlight !== null || session.dispatchWindow.active.length !== 0) {
        throw new WindowViolationError(rsid);
      }
      if (
        type === "invoke_batch" &&
        (payload as InvokeBatch).atomic &&
        !session.grantedSessionCapabilities.includes("batch_atomic")
      ) {
        throw new GatewayStubFault("atomic batch is not granted for this session", "unsupported", 4400);
      }
      this.assertDispatchDocumentScopes(session, payload, mutationEntries);
      if (omittedPayloadRecovery !== null) {
        const recovery = session.omittedPayloadRecoveries[omittedPayloadRecovery.originInvocationId];
        if (
          recovery === undefined ||
          recovery.state !== "awaiting_correlated_read" ||
          recovery.omittedResultDigest !== omittedPayloadRecovery.omittedResultDigest
        ) {
          throw new GatewayStubFault("payload recovery is no longer pending", "protocol", 4400);
        }
      }
      const opened = openDispatchWindow(session.dispatchWindow, {
        rsid,
        invocationId: correlationId,
        kind: type,
      });
      if (opened.kind !== "opened") {
        throw new WindowViolationError(rsid);
      }
      const built = this.appendDataEnvelope(draft, session, type, payload);
      const dispatchIdentity = dataEnvelopeImmutableDigest(built as DataEnvelopeSnapshot);
      let pendingRecoveryClearances: PersistedInFlight["pendingRecoveryClearances"] = [];

      if (verificationHoldId !== null) {
        const verification = (payload as Invoke).verification;
        const hold = draft.mutationHolds.holds.find(
          (candidate) => candidate.rsid === rsid && candidate.holdId === verificationHoldId,
        );
        if (
          hold === undefined ||
          hold.state === "cleared" ||
          verification == null ||
          mutationScopeKey(verification.mutation_scope) !== hold.scopeKey
        ) {
          throw new RecoveryHoldConflictError([verificationHoldId]);
        }
      } else if (mutationEntries.length > 0) {
        let ledger = draft.mutationHolds;
        const mutationScopes = mutationEntries.map((entry) => entry.mutationScope);
        const clearances = payload.recovery_clearances;
        const conflicts = conflictingMutationHolds(ledger, rsid, mutationScopes);
        const originRedelivery = conflicts.length > 0 && conflicts.every((hold) =>
          mutationEntries
            .filter((entry) => mutationScopesConflict(entry.mutationScope, hold.mutationScope))
            .every((entry) => isOriginRedeliveryExempt(ledger, rsid, entry.idempotencyKey)),
        );
        if (originRedelivery) {
          if (clearances.length !== 0) {
            throw new GatewayStubFault("origin redelivery cannot consume recovery clearances", "protocol", 4400);
          }
        } else {
          const clearanceById = new Map(
            clearances.map((clearance) => [clearance.hold_id, clearance]),
          );
          for (const hold of conflicts) {
            if (hold.state !== "evidence_recorded") {
              continue;
            }
            const clearance = clearanceById.get(hold.holdId);
            if (clearance === undefined) {
              continue;
            }
            const resolved = resolveMutationHold(ledger, {
              rsid,
              holdId: hold.holdId,
              basis: clearance.basis,
              verificationInvocationId: clearance.verification_invocation_id,
              evidenceDigest: clearance.evidence_digest,
              decision: clearance.decision,
              resolutionId: clearance.resolution_id,
              auditId: clearance.audit_id,
              authorizedDispatchIdentity: dispatchIdentity,
            });
            if (resolved.kind === "rejected") {
              throw new GatewayStubFault(`hold resolution rejected: ${resolved.reason}`, "protocol", 4400);
            }
            ledger = resolved.ledger;
          }
          const authorization = authorizeMutationDispatch(ledger, {
            rsid,
            mutationScopes,
            recoveryClearances: clearances,
            dispatchIdentity,
          });
          if (authorization.kind === "blocked") {
            throw new RecoveryHoldConflictError(
              authorization.conflictingHolds.map((hold) => hold.holdId),
            );
          }
          if (authorization.kind === "protocol_fault") {
            throw new GatewayStubFault(`recovery clearance rejected: ${authorization.reason}`, "protocol", 4400);
          }
          draft.mutationHolds = ledger;
          pendingRecoveryClearances = authorization.clearedHoldIds.some((holdId) =>
            ledger.holds.some(
              (hold) => hold.holdId === holdId && hold.state === "resolved_pending_bridge",
            ))
            ? structuredClone(clearances)
            : [];
        }
      } else if (payload.recovery_clearances.length !== 0) {
        throw new GatewayStubFault("non-mutating dispatch cannot consume recovery clearances", "protocol", 4400);
      }

      session.dispatchWindow = opened.ledger;
      session.inFlight = {
        kind: type === "invoke" ? "invoke" : "batch",
        correlationId,
        memberInvocationIds: type === "invoke"
          ? [correlationId]
          : (payload as InvokeBatch).steps.map((step) => step.invocation_id),
        dispatchIdentity,
        batchAtomic: type === "invoke_batch" ? (payload as InvokeBatch).atomic : null,
        batchDigest: type === "invoke_batch" ? (payload as InvokeBatch).batch_digest : null,
        gatewaySeq: built.seq!,
        dispatchedAtMs: this.clock.nowMs(),
        mutationEntries,
        verificationHoldId,
        omittedPayloadRecovery,
        pendingRecoveryClearances,
        cancelRequested: false,
      };
      if (omittedPayloadRecovery !== null) {
        const recovery = session.omittedPayloadRecoveries[omittedPayloadRecovery.originInvocationId]!;
        recovery.state = "read_dispatched";
        recovery.auditId = omittedPayloadRecovery.auditId;
        recovery.recoveryInvocationId = correlationId;
      }
      if (verificationHoldId !== null) {
        const verification = (payload as Invoke).verification!;
        session.verificationDispatches[correlationId] = {
          holdId: verificationHoldId,
          mutationScope: structuredClone(verification.mutation_scope),
          dispatchIdentity,
        };
      }
      return built;
    });
    await this.sendPersisted(rsid, envelope);
    return envelope;
  }

  private appendDataEnvelope(
    draft: PersistedGatewayState,
    session: PersistedSession,
    type: "invoke" | "invoke_batch" | "cancel",
    payload: unknown,
  ): RbpEnvelope {
    const queued = queueOutboundData(session.sequence, {
      type,
      id: allocateUuidV7(draft, this.clock.nowMs()),
      ack: session.sequence.lastRxSeq,
      ts: new Date(this.clock.nowMs()).toISOString(),
      payload: payload as JsonValue,
    });
    if (queued.kind === "renewal_required") {
      throw new GatewayStubFault("sequence exhausted; rsid renewal required", "protocol", 4400);
    }
    session.sequence = queued.state;
    const envelope = queued.envelope as RbpEnvelope;
    assertEnvelope(envelope);
    return envelope;
  }

  private async sendPersisted(rsid: string, envelope: RbpEnvelope): Promise<void> {
    const connectionId = this.sessionBindings.get(rsid);
    if (connectionId === undefined) {
      return;
    }
    await this.sendEnvelope(connectionId, envelope);
  }

  private async sendEnvelope(connectionId: string, envelope: RbpEnvelope): Promise<void> {
    const runtime = this.requireActiveConnection(connectionId);
    assertEnvelope(envelope);
    const serialized = serializeNegotiatedRbpEnvelope(
      envelope,
      runtime.transport.selectedProtocol,
    );
    await this.faults.apply(
      connectionId,
      runtime.transport.binding,
      "gateway_to_bridge",
      envelope.type,
      async () => runtime.transport.sendSerialized(serialized),
    );
  }

  async sendHelloAck(connectionId: string, ack: HelloAckEnvelope): Promise<void> {
    const runtime = this.requireConnection(connectionId);
    const serialized = serializeHelloAck(ack);
    await this.faults.apply(
      connectionId,
      runtime.transport.binding,
      "gateway_to_bridge",
      "hello_ack",
      async () => runtime.transport.sendSerialized(serialized),
    );
  }

  private async processEnvelope(connectionId: string, envelope: RbpEnvelope): Promise<void> {
    switch (envelope.type) {
      case "session_register":
        await this.handleSessionRegister(connectionId, envelope.payload);
        return;
      case "session_resume":
        await this.handleSessionResume(connectionId, envelope.payload);
        return;
      case "session_unregister":
        await this.handleSessionUnregister(connectionId, envelope.payload);
        return;
      case "heartbeat":
        await this.handleHeartbeat(connectionId, envelope.payload);
        return;
      case "manifest_check":
        await this.handleManifestCheck(connectionId, envelope.payload);
        return;
      case "goodbye":
        await this.requireActiveConnection(connectionId).transport.close(1000, envelope.payload.reason);
        return;
      case "result":
      case "partial":
      case "doc_context_update":
        await this.handleBridgeData(connectionId, envelope);
        return;
      case "error":
        if (typeof (envelope as { rsid?: unknown }).rsid !== "string") {
          throw new GatewayStubFault(
            envelope.payload.message,
            envelope.payload.fault_class === "auth" ? "auth" : "protocol",
            envelope.payload.fault_class === "auth" ? 4403 : 4400,
          );
        }
        await this.handleBridgeData(
          connectionId,
          envelope as Extract<RbpEnvelope, { rsid: string }>,
        );
        return;
      case "session_registered":
      case "resume_ack":
      case "heartbeat_ack":
      case "invoke":
      case "invoke_batch":
      case "cancel":
      case "manifest_info":
        throw new GatewayStubFault(`bridge sent directionally invalid ${envelope.type}`, "protocol", 4400);
      case "hello":
      case "hello_ack":
        throw new GatewayStubFault("hello exchange already completed", "protocol", 4400);
    }
  }

  private async handleSessionRegister(connectionId: string, payload: SessionRegister): Promise<void> {
    const runtime = this.requireActiveConnection(connectionId);
    const claimedIdentityFields = claimedSessionIdentityFields(payload);
    if (claimedIdentityFields.length > 0) {
      throw new GatewayStubFault(
        "session registration contains bridge-claimed principal or seat authority",
        "auth",
        4403,
      );
    }
    if (!secureStringEqual(payload.machine.fingerprint, runtime.transport.device.machineFingerprint)) {
      throw new GatewayStubFault("session machine fingerprint does not match enrollment", "auth", 4403);
    }
    const now = this.clock.nowMs();
    const output = await this.store.update((draft) => {
      const replacedRsids: string[] = [];
      for (const prior of Object.values(draft.sessions)) {
        if (
          prior.deviceId === runtime.transport.device.deviceId &&
          prior.localSessionKey === payload.local_session_key &&
          !prior.revoked
        ) {
          if (prior.inFlight !== null) {
            this.expireInFlight(draft, prior, now);
          }
          prior.revoked = true;
          prior.liveness = "disconnected";
          prior.disconnectedAtMs = now;
          prior.lifecycle = advanceSession(prior.lifecycle, {
            type: "unregister",
            reason: "session_replaced",
          });
          replacedRsids.push(prior.rsid);
        }
      }
      const allocation = allocateUuidV7(draft, now);
      const rsid = opaqueId("rs", `${runtime.transport.device.deviceId}/${payload.local_session_key}/${allocation}`);
      const resumeToken = opaqueId("resume", `${rsid}/${allocateUuidV7(draft, now)}`);
      const grantedSessionCapabilities = payload.session_capabilities.filter((capability) =>
        this.sessionCapabilities.includes(capability),
      );
      let lifecycle = createSessionLifecycle(payload.local_session_key);
      lifecycle = advanceSession(lifecycle, { type: "register_requested" });
      lifecycle = advanceSession(lifecycle, { type: "registered", rsid });
      draft.sessions[rsid] = {
        rsid,
        deviceId: runtime.transport.device.deviceId,
        tenantId: runtime.transport.device.tenantId,
        userId: runtime.transport.device.userId,
        seatId: runtime.transport.device.seatId,
        localSessionKey: payload.local_session_key,
        userHint: structuredClone(payload.user_hint),
        machine: structuredClone(payload.machine),
        revit: structuredClone(payload.revit),
        addinVersion: payload.addin_version,
        resultContractVersion: payload.result_contract_version,
        bridgeVersion: payload.bridge_version,
        port: payload.port,
        resumeToken,
        resumeExpiresAtMs: now + RESUME_LIFETIME_MS,
        revoked: false,
        documents: structuredClone(payload.documents) as Array<Record<string, unknown>>,
        activeDocument: payload.documents.find((document) => document.is_active)?.document_id ?? null,
        activeView: null,
        disciplineHint: null,
        grantedSessionCapabilities,
        lifecycle,
        sequence: createRbpSequenceState(rsid),
        dispatchWindow: createDispatchWindowLedger(),
        inFlight: null,
        streamAssemblers: {},
        chunkedResults: {},
        artifacts: {},
        terminalOutcomes: {},
        omittedPayloadRecoveries: {},
        expiredOrigins: {},
        lateTerminalEvidence: {},
        verificationDispatches: {},
        lastHeartbeatAtMs: now,
        disconnectedAtMs: null,
        liveness: "steady",
      };
      const response = this.makeControlEnvelope(draft, "session_registered", {
        rsid,
        resume_token: resumeToken,
        resume_expires_at: new Date(now + RESUME_LIFETIME_MS).toISOString(),
        principal: {
          tenant_id: runtime.transport.device.tenantId,
          user_id: runtime.transport.device.userId,
        },
        seat: {
          granted: true,
          seat_id: runtime.transport.device.seatId,
        },
        granted_session_capabilities: grantedSessionCapabilities,
      });
      return { rsid, response, replacedRsids };
    });
    for (const replacedRsid of output.replacedRsids) {
      this.sessionBindings.delete(replacedRsid);
    }
    this.sessionBindings.set(output.rsid, connectionId);
    this.recordAuthorizationAudit(runtime, "session_register", "allowed", "enrollment_bound", []);
    await this.sendEnvelope(connectionId, output.response);
  }

  private async handleSessionResume(
    connectionId: string,
    payload: { rsid: string; resume_token: string; last_rx_seq: number },
  ): Promise<void> {
    const runtime = this.requireActiveConnection(connectionId);
    const now = this.clock.nowMs();
    const output = await this.store.update((draft) => {
      const session = draft.sessions[payload.rsid];
      if (
        session === undefined ||
        session.revoked ||
        session.deviceId !== runtime.transport.device.deviceId ||
        session.tenantId !== runtime.transport.device.tenantId ||
        session.userId !== runtime.transport.device.userId ||
        session.seatId !== runtime.transport.device.seatId ||
        !secureStringEqual(
          session.machine.fingerprint,
          runtime.transport.device.machineFingerprint,
        ) ||
        session.resumeExpiresAtMs <= now ||
        !secureStringEqual(session.resumeToken, payload.resume_token)
      ) {
        throw new GatewayStubFault("resume token/session authorization failed", "auth", 4403);
      }
      if (payload.last_rx_seq > session.sequence.highestTxSeq) {
        throw new GatewayStubFault("resume last_rx_seq exceeds gateway sequence", "protocol", 4400);
      }
      if (payload.last_rx_seq < session.sequence.lastPeerAck) {
        throw new GatewayStubFault("resume last_rx_seq regresses durable bridge acknowledgement", "protocol", 4400);
      }
      this.applyGatewayAck(draft, session, payload.last_rx_seq);
      session.lifecycle = advanceSession(session.lifecycle, { type: "resume_requested" });
      session.lifecycle = advanceSession(session.lifecycle, { type: "resumed" });
      session.lastHeartbeatAtMs = now;
      session.disconnectedAtMs = null;
      session.liveness = "steady";
      const response = this.makeControlEnvelope(draft, "resume_ack", {
        rsid: session.rsid,
        last_rx_seq: session.sequence.lastRxSeq,
        resume_expires_at: new Date(session.resumeExpiresAtMs).toISOString(),
      });
      const retransmit = retransmitOutbox(session.sequence, {
        ack: session.sequence.lastRxSeq,
        ts: new Date(now).toISOString(),
      });
      return { response, retransmit };
    });
    this.sessionBindings.set(payload.rsid, connectionId);
    await this.sendEnvelope(connectionId, output.response);
    for (const entry of output.retransmit) {
      await this.sendEnvelope(connectionId, entry as RbpEnvelope);
    }
  }

  private async handleSessionUnregister(connectionId: string, payload: SessionUnregister): Promise<void> {
    const { rsid } = payload;
    const runtime = this.requireActiveConnection(connectionId);
    const now = this.clock.nowMs();
    await this.store.update((draft) => {
      const session = draft.sessions[rsid];
      if (
        session === undefined ||
        session.deviceId !== runtime.transport.device.deviceId ||
        session.tenantId !== runtime.transport.device.tenantId ||
        session.userId !== runtime.transport.device.userId ||
        session.seatId !== runtime.transport.device.seatId
      ) {
        throw new GatewayStubFault(
          "unknown or cross-owner session unregister",
          "auth",
          4403,
        );
      }
      if (session.revoked) {
        if (
          session.lifecycle.phase !== "unregistered" ||
          session.lifecycle.unregisterReason !== payload.reason
        ) {
          throw new GatewayStubFault(
            "session unregister replay does not match the persisted revocation",
            "auth",
            4403,
          );
        }
        return;
      }
      session.revoked = true;
      session.liveness = "disconnected";
      session.disconnectedAtMs = now;
      session.lifecycle = advanceSession(session.lifecycle, {
        type: "unregister",
        reason: payload.reason,
      });
      if (session.inFlight !== null) {
        this.expireInFlight(draft, session, now);
      }
    });
    this.sessionBindings.delete(rsid);
  }

  private async handleHeartbeat(connectionId: string, payload: Heartbeat): Promise<void> {
    const runtime = this.requireActiveConnection(connectionId);
    const boundRsids = [...this.sessionBindings.entries()]
      .filter(([, value]) => value === connectionId)
      .map(([rsid]) => rsid)
      .sort();
    const reportedRsids = payload.sessions.map((session) => session.rsid).sort();
    if (JSON.stringify(boundRsids) !== JSON.stringify(reportedRsids)) {
      throw new GatewayStubFault("heartbeat sessions do not exactly match connection binding", "auth", 4403);
    }
    const acknowledgedRsids = payload.acks.map((ack) => ack.rsid).sort();
    if (JSON.stringify(boundRsids) !== JSON.stringify(acknowledgedRsids)) {
      throw new GatewayStubFault("heartbeat acknowledgements do not exactly match connection binding", "auth", 4403);
    }
    const now = this.clock.nowMs();
    const response = await this.store.update((draft) => {
      for (const ack of payload.acks) {
        const session = draft.sessions[ack.rsid];
        if (session === undefined || this.sessionBindings.get(ack.rsid) !== connectionId) {
          throw new GatewayStubFault("heartbeat acknowledgement references a foreign session", "auth", 4403);
        }
        this.applyGatewayAck(draft, session, ack.seq);
      }
      for (const reported of payload.sessions) {
        const session = draft.sessions[reported.rsid]!;
        session.lastHeartbeatAtMs = now;
        session.disconnectedAtMs = null;
        session.liveness = "steady";
      }
      return this.makeControlEnvelope(draft, "heartbeat_ack", {
        server_time: new Date(now).toISOString(),
        acks: boundRsids.map((rsid) => ({ rsid, seq: draft.sessions[rsid]!.sequence.lastRxSeq })),
      });
    });
    if (runtime.lifecycle.phase === "degraded") {
      runtime.lifecycle = advanceConnection(runtime.lifecycle, {
        type: "heartbeat_silence",
        silenceMs: 0,
      });
    }
    await this.sendEnvelope(connectionId, response);
  }

  private async handleManifestCheck(connectionId: string, payload: unknown): Promise<void> {
    void payload;
    const response = await this.store.update((draft) => this.makeControlEnvelope(draft, "manifest_info", {
      status: "up_to_date",
      channel: "test",
      latest_version: "0.1.0-test",
      min_supported_version: "0.1.0-test",
      release_sequence: 1,
    }));
    await this.sendEnvelope(connectionId, response);
  }

  private async handleBridgeData(
    connectionId: string,
    envelope: Extract<RbpEnvelope, { rsid: string }>,
  ): Promise<void> {
    this.assertBoundSession(connectionId, envelope.rsid);
    const runtime = this.requireActiveConnection(connectionId);
    await this.store.update((draft) => {
      const session = draft.sessions[envelope.rsid]!;
      this.assertInboundCapabilities(runtime, session, envelope);
      const accepted = acceptInboundData(session.sequence, envelope as DataEnvelopeSnapshot);
      if (accepted.kind === "protocol_fault") {
        throw new GatewayStubFault(`inbound sequence rejected: ${accepted.reason}`, "protocol", 4400);
      }
      if (accepted.kind === "gap") {
        throw new GatewayStubFault(
          `forward sequence gap: expected ${accepted.expectedSeq}, received ${accepted.receivedSeq}`,
          "protocol",
          4400,
        );
      }
      session.sequence = accepted.state;
      this.clearAcknowledgedRecoveryHolds(draft, session, envelope.ack!);
      if (accepted.kind === "duplicate") {
        return;
      }

      switch (envelope.type) {
        case "partial":
          this.processPartial(session, envelope.payload);
          break;
        case "result":
          this.processResult(draft, session, envelope);
          break;
        case "error":
          this.processError(draft, session, envelope);
          break;
        case "doc_context_update":
          session.documents = structuredClone(envelope.payload.documents) as Array<Record<string, unknown>>;
          session.activeDocument = envelope.payload.active_document;
          session.activeView = envelope.payload.active_view === null
            ? null
            : structuredClone(envelope.payload.active_view) as Record<string, unknown>;
          session.disciplineHint = envelope.payload.discipline_hint ?? null;
          break;
      }
    });
  }

  private processPartial(session: PersistedSession, partial: Partial): void {
    if (session.inFlight === null || session.inFlight.kind !== "invoke" || partial.invocation_id !== session.inFlight.correlationId) {
      throw new GatewayStubFault("partial does not belong to the active invocation", "protocol", 4400);
    }
    try {
      recordPartial(session, partial);
    } catch (error) {
      if (error instanceof CarrierValidationError) {
        throw new GatewayStubFault(error.message, "protocol", 4400);
      }
      throw error;
    }
  }

  private processResult(
    draft: PersistedGatewayState,
    session: PersistedSession,
    envelope: Extract<RbpEnvelope, { type: "result" }>,
  ): void {
    const inFlight = session.inFlight;
    if (inFlight === null) {
      if (this.retainLateResultEvidence(draft, session, envelope)) {
        return;
      }
      throw new GatewayStubFault("result does not match the active invocation/batch", "protocol", 4400);
    }
    if (!isTerminalResultFor(inFlight, envelope.payload)) {
      throw new GatewayStubFault("result does not match the active invocation/batch", "protocol", 4400);
    }
    if (inFlight.pendingRecoveryClearances.length !== 0) {
      throw new GatewayStubFault(
        "terminal result does not acknowledge the evidence-bound recovery dispatch",
        "protocol",
        4400,
      );
    }
    if (
      envelope.payload.kind === "batch" &&
      (
        inFlight.batchAtomic === null ||
        inFlight.batchDigest === null ||
        envelope.payload.atomic !== inFlight.batchAtomic
      )
    ) {
      throw new GatewayStubFault("batch result does not match the dispatched atomic/digest binding", "protocol", 4400);
    }
    if (envelope.payload.kind === "invocation") {
      try {
        finalizeInvocationCarrier(session, envelope.payload);
      } catch (error) {
        if (error instanceof CarrierValidationError) {
          throw new GatewayStubFault(error.message, "protocol", 4400);
        }
        throw error;
      }
      this.completeOmittedPayloadRecovery(session, inFlight, envelope.payload);
    } else {
      if (
        envelope.payload.steps.length !== inFlight.memberInvocationIds.length ||
        envelope.payload.steps.some(
          (step, index) =>
            step.index !== index || step.invocation_id !== inFlight.memberInvocationIds[index],
        )
      ) {
        throw new GatewayStubFault("batch result step identities do not match the active batch", "protocol", 4400);
      }
      this.installBatchIndeterminateHolds(draft, session, inFlight, envelope.payload);
    }
    const payloadOmitted = this.recordOmittedPayloadRecoveries(session, inFlight, envelope.payload);
    if (inFlight.cancelRequested) {
      (session.lateTerminalEvidence[inFlight.correlationId] ??= []).push({
        correlationId: inFlight.correlationId,
        envelope,
        envelopeDigest: dataEnvelopeImmutableDigest(envelope as DataEnvelopeSnapshot),
        classification: payloadOmitted ? "payload_omitted" : "result",
        source: "cancel_suppressed",
        acceptedAtMs: this.clock.nowMs(),
      });
      session.terminalOutcomes[inFlight.correlationId] = {
        correlationId: inFlight.correlationId,
        envelope: null,
        classification: "cancelled",
        acceptedAtMs: this.clock.nowMs(),
      };
      session.dispatchWindow = closeDispatchWindow(
        session.dispatchWindow,
        session.rsid,
        inFlight.correlationId,
      );
      session.inFlight = null;
      return;
    }
    session.terminalOutcomes[inFlight.correlationId] = {
      correlationId: inFlight.correlationId,
      envelope,
      classification: payloadOmitted ? "payload_omitted" : "result",
      acceptedAtMs: this.clock.nowMs(),
    };
    session.dispatchWindow = closeDispatchWindow(
      session.dispatchWindow,
      session.rsid,
      inFlight.correlationId,
    );
    session.inFlight = null;
  }

  private processError(
    draft: PersistedGatewayState,
    session: PersistedSession,
    envelope: Extract<RbpEnvelope, { type: "error"; rsid: string }>,
  ): void {
    const inFlight = session.inFlight;
    const invocationId = envelope.payload.invocation_id;
    if (inFlight === null && invocationId !== undefined) {
      if (this.retainLateErrorEvidence(draft, session, envelope, invocationId)) {
        return;
      }
    }
    if (
      inFlight === null ||
      inFlight.kind !== "invoke" ||
      invocationId === undefined ||
      invocationId !== inFlight.correlationId
    ) {
      throw new GatewayStubFault(
        inFlight?.kind === "batch"
          ? "invoke_batch must terminate with one batch result carrier"
          : "error does not match active work",
        "protocol",
        4400,
      );
    }
    if (inFlight.pendingRecoveryClearances.length !== 0) {
      throw new GatewayStubFault(
        "terminal error does not acknowledge the evidence-bound recovery dispatch",
        "protocol",
        4400,
      );
    }
    discardInvocationStreams(session, invocationId);
    if (envelope.payload.fault_class === "journal_indeterminate") {
      const mutationScope = envelope.payload.mutation_scope;
      if (mutationScope === undefined) {
        throw new GatewayStubFault("journal_indeterminate lacks mutation_scope", "protocol", 4400);
      }
      const origins = inFlight.mutationEntries
        .filter((entry) => mutationScopesConflict(entry.mutationScope, mutationScope));
      if (origins.length === 0) {
        throw new GatewayStubFault("journal_indeterminate scope does not match active mutation", "protocol", 4400);
      }
      const installed = this.installUncertainMutations(draft, session.rsid, origins);
      if (!installed.some((hold) => hold.holdId === envelope.payload.verification_hold_id)) {
        throw new GatewayStubFault("journal_indeterminate hold id is not derivable from active work", "protocol", 4400);
      }
    }
    this.releaseFailedOmittedPayloadRecovery(session, inFlight);
    const cancelKnown =
      inFlight.cancelRequested && envelope.payload.fault_class !== "journal_indeterminate";
    if (cancelKnown && envelope.payload.fault_class !== "cancelled") {
      (session.lateTerminalEvidence[inFlight.correlationId] ??= []).push({
        correlationId: inFlight.correlationId,
        envelope,
        envelopeDigest: dataEnvelopeImmutableDigest(envelope as DataEnvelopeSnapshot),
        classification: "error",
        source: "cancel_suppressed",
        acceptedAtMs: this.clock.nowMs(),
      });
    }
    session.terminalOutcomes[inFlight.correlationId] = {
      correlationId: inFlight.correlationId,
      envelope: cancelKnown && envelope.payload.fault_class !== "cancelled" ? null : envelope,
      classification: cancelKnown
        ? "cancelled"
        : envelope.payload.fault_class === "journal_indeterminate"
          ? "journal_indeterminate"
          : "error",
      acceptedAtMs: this.clock.nowMs(),
    };
    session.dispatchWindow = closeDispatchWindow(
      session.dispatchWindow,
      session.rsid,
      inFlight.correlationId,
    );
    session.inFlight = null;
  }

  private recordOmittedPayloadRecoveries(
    session: PersistedSession,
    inFlight: Pick<PersistedInFlight, "correlationId" | "mutationEntries">,
    result: Result,
  ): boolean {
    const omitted = result.kind === "invocation"
      ? result.payload_omitted === true
        ? [{ invocationId: result.invocation_id, resultDigest: result.result_digest }]
        : []
      : result.steps
          .filter((step) => step.payload_omitted === true)
          .map((step) => ({ invocationId: step.invocation_id, resultDigest: step.result_digest }));
    for (const candidate of omitted) {
      if (typeof candidate.resultDigest !== "string") {
        throw new GatewayStubFault("omitted payload lacks its retained result digest", "protocol", 4400);
      }
      const mutation = inFlight.mutationEntries.find(
        (entry) => entry.invocationId === candidate.invocationId,
      );
      const existing = session.omittedPayloadRecoveries[candidate.invocationId];
      if (
        existing !== undefined &&
        (
          existing.parentCorrelationId !== inFlight.correlationId ||
          existing.omittedResultDigest !== candidate.resultDigest
        )
      ) {
        throw new GatewayStubFault("omitted payload recovery binding changed", "protocol", 4400);
      }
      session.omittedPayloadRecoveries[candidate.invocationId] = existing ?? {
        originInvocationId: candidate.invocationId,
        parentCorrelationId: inFlight.correlationId,
        omittedResultDigest: candidate.resultDigest,
        mutating: mutation !== undefined,
        mutationScope: mutation?.mutationScope ?? null,
        state: "awaiting_correlated_read",
        auditId: null,
        recoveryInvocationId: null,
        recoveryResultDigest: null,
        createdAtMs: this.clock.nowMs(),
        completedAtMs: null,
      };
    }
    return omitted.length > 0;
  }

  private completeOmittedPayloadRecovery(
    session: PersistedSession,
    inFlight: PersistedInFlight,
    result: Extract<Result, { kind: "invocation" }>,
  ): void {
    const binding = inFlight.omittedPayloadRecovery;
    if (binding === null) {
      return;
    }
    const recovery = session.omittedPayloadRecoveries[binding.originInvocationId];
    if (
      recovery === undefined ||
      recovery.state !== "read_dispatched" ||
      recovery.recoveryInvocationId !== result.invocation_id ||
      recovery.omittedResultDigest !== binding.omittedResultDigest ||
      recovery.auditId !== binding.auditId
    ) {
      throw new GatewayStubFault("payload recovery terminal is not bound to its audit plan", "protocol", 4400);
    }
    if (result.payload_omitted === true || typeof result.result_digest !== "string") {
      throw new GatewayStubFault(
        "payload recovery requires a retained digest on a full correlated read result",
        "protocol",
        4400,
      );
    }
    recovery.state = "recovered";
    recovery.recoveryResultDigest = result.result_digest;
    recovery.completedAtMs = this.clock.nowMs();
  }

  private releaseFailedOmittedPayloadRecovery(
    session: PersistedSession,
    inFlight: PersistedInFlight,
  ): void {
    const binding = inFlight.omittedPayloadRecovery;
    if (binding === null) {
      return;
    }
    const recovery = session.omittedPayloadRecoveries[binding.originInvocationId];
    if (recovery !== undefined && recovery.state === "read_dispatched") {
      recovery.state = "awaiting_correlated_read";
    }
  }

  private retainLateResultEvidence(
    draft: PersistedGatewayState,
    session: PersistedSession,
    envelope: Extract<RbpEnvelope, { type: "result" }>,
  ): boolean {
    const correlationId = envelope.payload.kind === "invocation"
      ? envelope.payload.invocation_id
      : envelope.payload.batch_id;
    const expired = session.expiredOrigins[correlationId];
    const bridgeLateReplay =
      envelope.payload.kind === "invocation" &&
      envelope.payload.late_after_indeterminate === true;
    if (expired === undefined && !bridgeLateReplay) {
      return false;
    }
    if (expired !== undefined) {
      if (
        (expired.kind === "invoke") !== (envelope.payload.kind === "invocation") ||
        (
          envelope.payload.kind === "batch" &&
          (
            expired.batchAtomic !== envelope.payload.atomic ||
            expired.memberInvocationIds.length !== envelope.payload.steps.length ||
            envelope.payload.steps.some(
              (step, index) =>
                step.index !== index || step.invocation_id !== expired.memberInvocationIds[index],
            )
          )
        )
      ) {
        throw new GatewayStubFault("late terminal result changed its expired dispatch binding", "protocol", 4400);
      }
      for (const mutation of expired.mutationEntries) {
        const hold = draft.mutationHolds.holds.find(
          (candidate) =>
            candidate.rsid === session.rsid &&
            candidate.originIdempotencyKeys.includes(mutation.idempotencyKey) &&
            candidate.state !== "cleared",
        );
        if (hold === undefined) {
          throw new GatewayStubFault("late terminal result lacks its expired-origin hold", "protocol", 4400);
        }
      }
    }
    if (bridgeLateReplay && envelope.payload.kind === "invocation") {
      const originKey = makeIdempotencyKey(session.rsid, envelope.payload.invocation_id);
      const hold = draft.mutationHolds.holds.find(
        (candidate) =>
          candidate.rsid === session.rsid &&
          candidate.holdId === envelope.payload.verification_hold_id &&
          candidate.originIdempotencyKeys.includes(originKey) &&
          candidate.state !== "cleared",
      );
      if (hold === undefined) {
        throw new GatewayStubFault("late terminal result references an unknown origin hold", "protocol", 4400);
      }
    }
    if (envelope.payload.kind === "invocation") {
      try {
        finalizeInvocationCarrier(session, envelope.payload);
      } catch (error) {
        if (error instanceof CarrierValidationError) {
          throw new GatewayStubFault(error.message, "protocol", 4400);
        }
        throw error;
      }
    }
    const omitted = this.recordOmittedPayloadRecoveries(
      session,
      {
        correlationId,
        mutationEntries: expired?.mutationEntries ?? [],
      },
      envelope.payload,
    );
    const evidence = {
      correlationId,
      envelope,
      envelopeDigest: dataEnvelopeImmutableDigest(envelope as DataEnvelopeSnapshot),
      classification: omitted ? "payload_omitted" as const : "result" as const,
      source: bridgeLateReplay ? "bridge_late_replay" as const : "gateway_expiry" as const,
      acceptedAtMs: this.clock.nowMs(),
    };
    (session.lateTerminalEvidence[correlationId] ??= []).push(evidence);
    return true;
  }

  private retainLateErrorEvidence(
    draft: PersistedGatewayState,
    session: PersistedSession,
    envelope: Extract<RbpEnvelope, { type: "error"; rsid: string }>,
    invocationId: string,
  ): boolean {
    const expired = session.expiredOrigins[invocationId];
    const bridgeLateReplay = envelope.payload.late_after_indeterminate === true;
    if (expired === undefined && !bridgeLateReplay) {
      return false;
    }
    if (expired !== undefined && expired.kind !== "invoke") {
      throw new GatewayStubFault("late terminal error changed its expired dispatch binding", "protocol", 4400);
    }
    const originKey = makeIdempotencyKey(session.rsid, invocationId);
    if ((expired?.mutationEntries.length ?? 0) > 0 || bridgeLateReplay) {
      const hold = draft.mutationHolds.holds.find(
        (candidate) =>
          candidate.rsid === session.rsid &&
          candidate.originIdempotencyKeys.includes(originKey) &&
          candidate.state !== "cleared" &&
          (!bridgeLateReplay || candidate.holdId === envelope.payload.verification_hold_id),
      );
      if (hold === undefined) {
        throw new GatewayStubFault("late terminal error references an unknown origin hold", "protocol", 4400);
      }
    }
    discardInvocationStreams(session, invocationId);
    (session.lateTerminalEvidence[invocationId] ??= []).push({
      correlationId: invocationId,
      envelope,
      envelopeDigest: dataEnvelopeImmutableDigest(envelope as DataEnvelopeSnapshot),
      classification: "error",
      source: bridgeLateReplay ? "bridge_late_replay" : "gateway_expiry",
      acceptedAtMs: this.clock.nowMs(),
    });
    return true;
  }

  private installBatchIndeterminateHolds(
    draft: PersistedGatewayState,
    session: PersistedSession,
    inFlight: PersistedInFlight,
    result: BatchResult,
  ): void {
    const stepByInvocationId = new Map(result.steps.map((step) => [step.invocation_id, step]));
    if (result.atomic && result.status === "indeterminate") {
      for (const entry of inFlight.mutationEntries) {
        if (stepByInvocationId.get(entry.invocationId)?.status !== "indeterminate") {
          throw new GatewayStubFault(
            "atomic indeterminate result must mark every possibly executed mutation indeterminate",
            "protocol",
            4400,
          );
        }
      }
    }
    const affected = result.atomic && result.status === "indeterminate"
      ? inFlight.mutationEntries
      : inFlight.mutationEntries.filter(
          (entry) => stepByInvocationId.get(entry.invocationId)?.status === "indeterminate",
        );
    if (affected.length === 0) {
      return;
    }
    const installed = this.installUncertainMutations(draft, session.rsid, affected);
    for (const entry of affected) {
      const step = stepByInvocationId.get(entry.invocationId);
      const hold = installed.find((candidate) =>
        candidate.originIdempotencyKeys.includes(entry.idempotencyKey) &&
        mutationScopesConflict(candidate.mutationScope, entry.mutationScope));
      if (
        step?.status !== "indeterminate" ||
        step.error.fault_class !== "journal_indeterminate" ||
        hold === undefined ||
        step.error.verification_hold_id !== hold.holdId ||
        mutationScopeKey(step.error.mutation_scope) !== mutationScopeKey(entry.mutationScope)
      ) {
        throw new GatewayStubFault(
          "batch indeterminate nested error is not bound to the derived recovery hold",
          "protocol",
          4400,
        );
      }
    }
  }

  private installUncertainMutations(
    draft: PersistedGatewayState,
    rsid: string,
    uncertain: PersistedInFlight["mutationEntries"],
  ): readonly MutationHold[] {
    const installed = installMutationHolds(
      draft.mutationHolds,
      rsid,
      uncertain.map((entry) => ({
        originIdempotencyKey: entry.idempotencyKey,
        mutationScope: entry.mutationScope,
      })),
    );
    if (installed.kind === "blocked") {
      throw new RecoveryHoldConflictError(
        installed.conflictingHolds.map((hold) => hold.holdId),
      );
    }
    draft.mutationHolds = installed.ledger;
    return installed.holds;
  }

  private expireInFlight(
    draft: PersistedGatewayState,
    session: PersistedSession,
    now: number,
  ): void {
    const inFlight = session.inFlight;
    if (inFlight === null) {
      return;
    }
    session.expiredOrigins[inFlight.correlationId] ??= {
      kind: inFlight.kind,
      correlationId: inFlight.correlationId,
      memberInvocationIds: structuredClone(inFlight.memberInvocationIds),
      dispatchIdentity: inFlight.dispatchIdentity,
      batchAtomic: inFlight.batchAtomic,
      batchDigest: inFlight.batchDigest,
      mutationEntries: structuredClone(inFlight.mutationEntries),
      expiredAtMs: now,
    };
    this.releaseFailedOmittedPayloadRecovery(session, inFlight);
    if (inFlight.mutationEntries.length === 0) {
      session.terminalOutcomes[inFlight.correlationId] = {
        correlationId: inFlight.correlationId,
        envelope: null,
        classification: "environment",
        acceptedAtMs: now,
      };
    } else {
      // A recovery dispatch keeps its original scope hold in
      // resolved_pending_bridge until the Bridge durably acknowledges the
      // dispatch. Expiry before that acknowledgement must not try to install a
      // second conflicting hold or accidentally clear the original guard.
      if (inFlight.pendingRecoveryClearances.length === 0) {
        this.installUncertainMutations(draft, session.rsid, inFlight.mutationEntries);
      }
      session.terminalOutcomes[inFlight.correlationId] = {
        correlationId: inFlight.correlationId,
        envelope: null,
        classification: "journal_indeterminate",
        acceptedAtMs: now,
      };
    }
    session.dispatchWindow = closeDispatchWindow(
      session.dispatchWindow,
      session.rsid,
      inFlight.correlationId,
    );
    session.inFlight = null;
  }

  private applyGatewayAck(
    draft: PersistedGatewayState,
    session: PersistedSession,
    ack: number,
  ): void {
    const result = applyCumulativeAck(session.sequence, ack);
    if (result.kind === "protocol_fault") {
      throw new GatewayStubFault(`invalid cumulative acknowledgement: ${result.reason}`, "protocol", 4400);
    }
    session.sequence = result.state;
    this.clearAcknowledgedRecoveryHolds(draft, session, ack);
  }

  private clearAcknowledgedRecoveryHolds(
    draft: PersistedGatewayState,
    session: PersistedSession,
    ack: number,
  ): void {
    const inFlight = session.inFlight;
    if (
      inFlight === null ||
      inFlight.pendingRecoveryClearances.length === 0 ||
      ack < inFlight.gatewaySeq
    ) {
      return;
    }
    const authorization = authorizeMutationDispatch(draft.mutationHolds, {
      rsid: session.rsid,
      mutationScopes: inFlight.mutationEntries.map((entry) => entry.mutationScope),
      recoveryClearances: inFlight.pendingRecoveryClearances,
      dispatchIdentity: inFlight.dispatchIdentity,
    });
    if (authorization.kind !== "allowed") {
      throw new GatewayStubFault(
        `Bridge acknowledgement cannot clear recovery hold: ${authorization.kind}`,
        "protocol",
        4400,
      );
    }
    draft.mutationHolds = authorization.ledger;
    inFlight.pendingRecoveryClearances = [];
  }

  private makeControlEnvelope(
    draft: PersistedGatewayState,
    type: string,
    payload: unknown,
  ): RbpEnvelope {
    const envelope = {
      v: 1,
      type,
      id: allocateUuidV7(draft, this.clock.nowMs()),
      ts: new Date(this.clock.nowMs()).toISOString(),
      payload,
    } as RbpEnvelope;
    assertEnvelope(envelope);
    return envelope;
  }

  private assertDispatchDocumentScopes(
    session: PersistedSession,
    payload: Invoke | InvokeBatch,
    mutationEntries: PersistedInFlight["mutationEntries"],
  ): void {
    const registeredDocumentIds = new Set(
      session.documents
        .map((document) => document.document_id)
        .filter((documentId): documentId is string => typeof documentId === "string"),
    );
    const scopes: MutationScope[] = mutationEntries.map((entry) => entry.mutationScope);
    const verification = (payload as Invoke).verification;
    if (verification !== undefined && verification !== null) {
      scopes.push(verification.mutation_scope);
    }
    for (const clearance of payload.recovery_clearances) {
      scopes.push(clearance.mutation_scope);
    }
    for (const scope of scopes) {
      if (scope.kind === "document" && !registeredDocumentIds.has(scope.document_id)) {
        throw new GatewayStubFault(
          `document mutation scope is not registered for this rsid: ${scope.document_id}`,
          "protocol",
          4400,
        );
      }
    }
  }

  private assertInboundCapabilities(
    runtime: RuntimeConnection,
    session: PersistedSession,
    envelope: Extract<RbpEnvelope, { rsid: string }>,
  ): void {
    const requireConnectionCapability = (capability: string): void => {
      if (!runtime.grantedCapabilities.includes(capability)) {
        throw new GatewayStubFault(
          `${envelope.type} requires granted connection capability ${capability}`,
          "unsupported",
          4400,
        );
      }
    };

    if (envelope.type === "doc_context_update") {
      if (!session.grantedSessionCapabilities.includes("doc_context_cached_v1")) {
        throw new GatewayStubFault(
          "doc_context_update requires granted session capability doc_context_cached_v1",
          "unsupported",
          4400,
        );
      }
      return;
    }
    if (envelope.type === "partial" && envelope.payload.kind === "chunk") {
      requireConnectionCapability("chunked_results");
      if (envelope.payload.stream_id.startsWith("artifact:")) {
        requireConnectionCapability("artifact_result_v1");
      }
      return;
    }
    if (envelope.type === "result" && envelope.payload.kind === "invocation") {
      if (envelope.payload.chunked === true) {
        requireConnectionCapability("chunked_results");
      }
      if (Array.isArray(envelope.payload.artifacts)) {
        requireConnectionCapability("chunked_results");
        requireConnectionCapability("artifact_result_v1");
      }
    }
  }

  private assertBoundSession(connectionId: string, rsid: string): void {
    const session = this.requireSession(rsid);
    const runtime = this.requireActiveConnection(connectionId);
    if (
      session.revoked ||
      session.deviceId !== runtime.transport.device.deviceId ||
      this.sessionBindings.get(rsid) !== connectionId
    ) {
      throw new GatewayStubFault("cross-device or cross-session authorization failure", "auth", 4403);
    }
  }

  private recordAuthorizationAudit(
    runtime: RuntimeConnection,
    operation: AuthorizationAuditEntry["operation"],
    decision: AuthorizationAuditEntry["decision"],
    reason: AuthorizationAuditEntry["reason"],
    claimedIdentityFields: readonly string[],
  ): void {
    this.authorizationAuditSequence += 1;
    this.authorizationAudit.push({
      sequence: this.authorizationAuditSequence,
      atMs: this.clock.nowMs(),
      operation,
      decision,
      reason,
      connectionIdDigest: sha256Digest(runtime.transport.connectionId),
      deviceIdDigest: sha256Digest(runtime.transport.device.deviceId),
      claimedIdentityFields: [...new Set(claimedIdentityFields)].sort(),
    });
    if (this.authorizationAudit.length > AUTHORIZATION_AUDIT_CAPACITY) {
      this.authorizationAudit.splice(
        0,
        this.authorizationAudit.length - AUTHORIZATION_AUDIT_CAPACITY,
      );
    }
  }

  private requireSession(rsid: string): PersistedSession {
    const session = this.store.snapshot().sessions[rsid];
    if (session === undefined || session.revoked) {
      throw new GatewayStubFault("unknown or revoked rsid", "auth", 4403);
    }
    return session;
  }

  private requireConnection(connectionId: string): RuntimeConnection {
    const runtime = this.connections.get(connectionId);
    if (runtime === undefined) {
      throw new GatewayStubFault("unknown or expired connection", "auth", 4401);
    }
    if (runtime.transport.device.status !== "active") {
      throw new GatewayStubFault(
        "device credential is no longer active",
        "auth",
        4403,
      );
    }
    return runtime;
  }

  private requireActiveConnection(connectionId: string): RuntimeConnection {
    const runtime = this.requireConnection(connectionId);
    if (!runtime.transport.active) {
      throw new GatewayStubFault("transport connection is not active", "protocol", 4400);
    }
    return runtime;
  }

  private async recoverAfterRestart(): Promise<void> {
    const now = this.clock.nowMs();
    await this.store.update((draft) => {
      for (const session of Object.values(draft.sessions)) {
        if (!session.revoked) {
          session.liveness = "disconnected";
          session.disconnectedAtMs ??= now;
          if (session.lifecycle.phase === "registered") {
            session.lifecycle = advanceSession(session.lifecycle, { type: "connection_lost" });
          }
        }
      }
    });
  }
}
