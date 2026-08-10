import { createHash, randomBytes } from "node:crypto";

import {
  acceptInboundData,
  applyCumulativeAck,
  dataEnvelopeImmutableDigest,
  createReceivedJournalRecord,
  makeBatchDigest,
  makeParamsDigest,
  createConnectionLifecycle,
  createSessionLifecycle,
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
import { gatewayUuidV7 } from "./identifiers.js";
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
import type {
  GatewayProtocolStore,
  StoreTransaction,
} from "./store.js";

export const GATEWAY_RBP_SESSION_NAMESPACE =
  "gateway.rbp-session/v1" as const;

const RESUME_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const INVOCATION_TIMEOUT_MS = 120_000;
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
  readonly journalRecords: readonly InvocationJournalRecord[];
}

interface DurableDispatchEvidence {
  readonly envelopeDigest: `sha256:${string}`;
  readonly acceptance: GatewayDurableDispatchObservation["acceptance"];
  readonly journal: GatewayVerifiedBridgeJournalEvidence | null;
}

interface DurableRbpSession {
  readonly schema: typeof GATEWAY_RBP_SESSION_NAMESPACE;
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
  readonly pending: DurablePendingDispatch | null;
  readonly evidence: readonly DurableDispatchEvidence[];
  readonly updatedAtMs: number;
}

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

function immutableEnvelopeDigest(envelope: RbpEnvelope): `sha256:${string}` {
  if (!("rsid" in envelope) || typeof envelope.rsid !== "string") {
    throw new GatewayRbpFault("protocol", "data envelope required", 400, 4400);
  }
  return dataEnvelopeImmutableDigest(envelope as DataEnvelopeSnapshot);
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
  readonly #clock: () => number;

  public constructor(
    readonly store: GatewayProtocolStore,
    readonly identity: IdentityPort,
    options: { readonly clock?: () => number } = {},
  ) {
    this.#clock = options.clock ?? Date.now;
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
        await this.#unregister(connection, envelope.payload.rsid);
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
      envelope: prepared?.envelope ?? draft!.envelope,
      journalRecords: prepared?.journalRecords ?? [],
    });
  }

  public async executeAtomicBatch(
    request: GatewayAtomicBatchExecutorRequest,
    prepared?: GatewayRecoveryPendingDispatch,
  ): Promise<GatewayExecutorOutcome> {
    const first = request.steps[0];
    if (first === undefined) {
      return {
        state: "failed",
        error: { code: "protocol", message: "atomic batch has no steps" },
      };
    }
    const draft =
      prepared === undefined ? this.buildAtomicBatchEnvelope(request) : null;
    return await this.#executeDispatch({
      tenantId: first.context.actor.tenantId,
      rsid: first.context.rsid,
      correlationId: request.batchId,
      mutating: request.steps.some((step) => step.context.mutating),
      envelope: prepared?.envelope ?? draft!.envelope,
      journalRecords: prepared?.journalRecords ?? [],
    });
  }

  async #executeDispatch(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly correlationId: string;
    readonly mutating: boolean;
    readonly envelope: unknown;
    readonly journalRecords: readonly InvocationJournalRecord[];
  }): Promise<GatewayExecutorOutcome> {
    const active = this.#active.get(input.rsid);
    if (active === undefined || active.tenantId !== input.tenantId) {
      return {
        state: "failed",
        error: { code: "executor_unavailable", message: "registered rsid is not active" },
      };
    }
    const envelope = input.envelope as InvokeEnvelope | InvokeBatchEnvelope;
    const expectedDigest = immutableEnvelopeDigest(envelope);
    const journals = input.journalRecords.map(markJournalExecuting);

    const persisted = await this.#updateSession(active.tenantId, active.rsid, (record) => {
      if (
        record.connectionId !== active.record.connectionId ||
        record.sessionBindingId !== active.record.sessionBindingId
      ) {
        throw new Error("active session binding changed before dispatch");
      }
      if (record.pending !== null) {
        throw new Error("RBP dispatch window already has active work");
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
      return {
        ...record,
        sequence: queued.state,
        pending: {
          envelopeDigest: expectedDigest,
          gatewaySequence: envelope.seq,
          invocationId: input.correlationId,
          mutating: input.mutating,
          journalRecords: journals,
        },
        updatedAtMs: this.#clock(),
      };
    });
    active.record = persisted;

    const connection = this.#connections.get(persisted.connectionId);
    if (connection === undefined) {
      return this.#indeterminateOutcome(input.mutating);
    }

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
      await connection.send(JSON.stringify(envelope));
    } catch {
      const waiter = this.#waiters.get(input.correlationId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(input.correlationId);
        waiter.resolve(this.#indeterminateOutcome(input.mutating));
      }
    }
    return await outcome;
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
    const session = stored.value as unknown as DurableRbpSession;
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
    const stored = await tx.read<GatewayJsonValue>(
      GATEWAY_RBP_SESSION_NAMESPACE,
      expected.rsid,
    );
    if (stored === null) return { kind: "not_authorized", reason: "unknown_rsid" };
    const session = stored.value as unknown as DurableRbpSession;
    if (
      session.sessionBindingId !== expected.sessionBindingId ||
      session.connectionId !== expected.connectionId ||
      session.sequence.nextTxSeq !== expected.gatewaySequence
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
  }

  async #register(connection: LiveConnection, payload: SessionRegister): Promise<void> {
    const rsid = gatewayUuidV7(this.#clock());
    const resumeToken = token();
    const grantedCapabilities = connection.grantedCapabilities.filter((capability) =>
      payload.session_capabilities.includes(capability),
    );
    const record: DurableRbpSession = {
      schema: GATEWAY_RBP_SESSION_NAMESPACE,
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
      resumeExpiresAtMs: this.#clock() + RESUME_LIFETIME_MS,
      grantedCapabilities,
      connectionLifecycle: connection.lifecycle,
      sessionLifecycle: registeredSessionLifecycle(payload.local_session_key, rsid),
      lastHeartbeatAtMs: this.#clock(),
      sequence: {
        rsid,
        nextTxSeq: 1,
        highestTxSeq: 0,
        lastRxSeq: 0,
        lastPeerAck: 0,
        outbox: [],
        acceptedInbound: [],
      },
      pending: null,
      evidence: [],
      updatedAtMs: this.#clock(),
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
    const stored = await this.#readSession(
      connection.auth.actor.tenantId,
      payload.rsid,
    );
    if (
      stored.deviceId !== connection.auth.actor.deviceId ||
      stored.resumeTokenDigest !== digest(payload.resume_token) ||
      stored.resumeExpiresAtMs <= this.#clock()
    ) {
      throw new GatewayRbpFault("auth", "resume authorization rejected", 403, 4403);
    }
    const resumed = await this.#updateSession(stored.tenantId, stored.rsid, (record) => {
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
      return {
        ...record,
        connectionId: connection.connectionId,
        binding: connection.binding,
        sessionVersion: record.sessionVersion + 1,
        sequence: acknowledged.state,
        connectionLifecycle,
        sessionLifecycle,
        lastHeartbeatAtMs: this.#clock(),
        updatedAtMs: this.#clock(),
      };
    });
    await this.#activate(resumed);
    await connection.send(
      JSON.stringify({
        v: 1,
        type: "resume_ack",
        id: gatewayUuidV7(this.#clock()),
        ts: nowIso(this.#clock()),
        payload: {
          rsid: resumed.rsid,
          last_rx_seq: resumed.sequence.lastRxSeq,
          resume_expires_at: nowIso(resumed.resumeExpiresAtMs),
        },
      } satisfies RbpEnvelope),
    );
    for (const retained of retransmitOutbox(resumed.sequence, {
      ack: resumed.sequence.lastRxSeq,
      ts: nowIso(this.#clock()),
    })) {
      await connection.send(JSON.stringify(retained));
    }
  }

  async #unregister(connection: LiveConnection, rsid: string): Promise<void> {
    const active = this.#active.get(rsid);
    if (
      active === undefined ||
      active.record.connectionId !== connection.connectionId
    ) {
      throw new GatewayRbpFault("auth", "session is not bound to this connection", 403, 4403);
    }
    this.#active.delete(rsid);
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
    let completed: GatewayExecutorOutcome | null = null;
    let completedInvocationId: string | null = null;
    const updated = await this.#updateSession(active.tenantId, active.rsid, (record) => {
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
    const updated = await this.#updateSession(active.tenantId, active.rsid, (record) => ({
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
    }));
    active.record = updated;
  }

  async #readSession(tenantId: string, rsid: string): Promise<DurableRbpSession> {
    const result = await this.store.transact({ tenantId }, async (tx) =>
      tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid),
    );
    if (!result.ok) throw new GatewayRbpFault("unavailable", result.message, 503, 1011);
    if (result.value === null) {
      throw new GatewayRbpFault("auth", "unknown rsid", 404, 4403);
    }
    return result.value.value as unknown as DurableRbpSession;
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
      const next = mutate(stored.value as unknown as DurableRbpSession);
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
