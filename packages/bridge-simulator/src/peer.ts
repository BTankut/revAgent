import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import {
  RBP_HEARTBEAT_DEGRADED_AFTER_MS,
  RBP_HEARTBEAT_DISCONNECTED_AFTER_MS,
  canonicalizeJson,
  createSessionLifecycle,
  transitionSession,
  validateRbpEnvelope,
  type BatchStepResult,
  type DataEnvelopeSnapshot,
  type DocContextUpdate,
  type HeartbeatAckEnvelope,
  type HeartbeatEnvelope,
  type HelloAckEnvelope,
  type InvokeBatchEnvelope,
  type InvokeEnvelope,
  type JsonValue,
  type RbpEnvelope,
  type ResumeAckEnvelope,
  type SessionLifecycleState,
  type SessionRegister,
  type SessionRegisteredEnvelope,
  type SessionUnregister,
} from "@revagent/protocol";

import type { ArtifactCarrier } from "./artifacts.js";
import type {
  BridgeSimulator,
  BridgeBatchOutcome,
  BridgeInvocationOutcome,
} from "./bridgeSimulator.js";
import type { ProbedAddinSession } from "./loopback.js";
import { GatewayTransportError, type GatewayBinding } from "./transport.js";

export const BRIDGE_OUTBOUND_HIGH_WATER_BYTES = 8 * 1024 * 1024;
export const BRIDGE_DOCUMENT_CONTEXT_POLL_MS = 15_000;

export type BridgePeerLiveness = "steady" | "degraded" | "disconnected";

interface PendingRegistration {
  readonly probe: ProbedAddinSession;
  readonly registration: SessionRegister;
}

interface QueuedDataDraft {
  readonly type: string;
  readonly id: string;
  readonly ts: string;
  readonly payload: JsonValue;
  readonly artifactCarrier: ArtifactCarrier | null;
}

export interface BridgeGatewayPeerOptions {
  readonly heartbeatIntervalMs?: number;
  readonly nowMs?: () => number;
  readonly idFactory?: () => string;
  readonly reconnect?: (input: {
    readonly attemptIndex: number;
    readonly delayMs: number;
  }) => Promise<{ readonly binding: GatewayBinding; readonly helloAck: HelloAckEnvelope }>;
  readonly reconnectJitter?: () => number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export interface BridgeGatewayPeerSnapshot {
  readonly bindingKind: GatewayBinding["kind"];
  readonly connectionId: string | null;
  readonly bufferedAmount: number;
  readonly liveness: BridgePeerLiveness;
  readonly lastHeartbeatAckAtMs: number;
  readonly lastHeartbeatSentAtMs: number;
  readonly runLoopActive: boolean;
  readonly closed: boolean;
  readonly sessions: readonly SessionLifecycleState[];
  readonly pendingRegistrationCount: number;
  readonly pendingResumeCount: number;
  readonly queuedDataCount: number;
  readonly sentSeqs: readonly { readonly rsid: string; readonly seq: number }[];
  readonly reconnectAttemptIndex: number;
  readonly heartbeatAckDeadlineAtMs: number | null;
}

function defaultId(): string {
  return `0197a3c2-0000-7000-8000-${randomBytes(6).toString("hex")}`;
}

function transitionOrThrow(
  state: SessionLifecycleState,
  event: Parameters<typeof transitionSession>[1],
): SessionLifecycleState {
  const transition = transitionSession(state, event);
  if (transition.kind !== "transitioned") {
    throw new Error(`invalid session transition ${state.phase}/${event.type}`);
  }
  return transition.state;
}

function registeredLifecycle(
  localSessionKey: string,
  rsid: string,
): SessionLifecycleState {
  let state = createSessionLifecycle(localSessionKey);
  state = transitionOrThrow(state, { type: "register_requested" });
  return transitionOrThrow(state, { type: "registered", rsid });
}

function metrics(): {
  readonly execute_ms: number;
  readonly request_bytes: number;
  readonly response_bytes: number;
  readonly framing: "length-prefixed";
} {
  return { execute_ms: 0, request_bytes: 0, response_bytes: 0, framing: "length-prefixed" };
}

function errorDetail(
  outcome: Extract<BridgeInvocationOutcome, { readonly kind: "error" }>,
  mutationScope: InvokeEnvelope["payload"]["mutation_scope"],
): Record<string, JsonValue> {
  return {
    retryable: outcome.retryable,
    fault_class: outcome.faultClass,
    message: outcome.message,
    outcome: outcome.outcome,
    verification_required: outcome.verificationRequired,
    replayed: outcome.replayed,
    ...(outcome.verificationHoldId === null
      ? {}
      : {
          verification_hold_id: outcome.verificationHoldId,
          ...(outcome.outcome === "indeterminate" && mutationScope !== null
            ? { mutation_scope: mutationScope as unknown as JsonValue }
            : {}),
        }),
  };
}

function resultPayload(
  invocationId: string,
  outcome: Extract<BridgeInvocationOutcome, { readonly kind: "result" }>,
): Record<string, JsonValue> {
  const base: Record<string, JsonValue> = {
    kind: "invocation",
    invocation_id: invocationId,
    status: outcome.status,
    replayed: outcome.replayed,
    metrics: metrics() as unknown as JsonValue,
    ...(outcome.status === "guarded" ? { guarded_reason: outcome.guardedReason as string } : {}),
    ...(outcome.lateAfterIndeterminate
      ? {
          late_after_indeterminate: true,
          verification_hold_id: outcome.verificationHoldId as string,
        }
      : {}),
  };
  if (outcome.payloadOmitted) {
    return { ...base, payload_omitted: true, result_digest: outcome.resultDigest };
  }
  if (outcome.artifactCarrier !== null) {
    return {
      ...base,
      result: (outcome.result ?? null) as JsonValue,
      result_digest: outcome.resultDigest,
      chunked: true,
      artifacts: outcome.artifactCarrier.descriptors as unknown as JsonValue,
    };
  }
  const resultChunks = outcome.partials.filter((partial) => partial.stream_id === "result");
  if (resultChunks.length > 0) {
    const bytes = Buffer.concat(resultChunks.map((partial) => Buffer.from(partial.data, "base64")));
    return {
      ...base,
      result_digest: outcome.resultDigest,
      chunked: true,
      stream_id: "result",
      content_type: resultChunks[0]?.content_type ?? "application/json",
      total_chunks: resultChunks.length,
      total_size: bytes.byteLength,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  }
  return {
    ...base,
    result: (outcome.result ?? null) as JsonValue,
    result_digest: outcome.resultDigest,
  };
}

function invocationDrafts(
  envelope: InvokeEnvelope,
  outcome: BridgeInvocationOutcome,
  id: () => string,
  ts: () => string,
): QueuedDataDraft[] {
  const drafts: QueuedDataDraft[] = [];
  if (outcome.kind === "result") {
    for (const partial of outcome.partials) {
      drafts.push({
        type: "partial",
        id: id(),
        ts: ts(),
        payload: partial as unknown as JsonValue,
        artifactCarrier: null,
      });
    }
    drafts.push({
      type: "result",
      id: id(),
      ts: ts(),
      payload: resultPayload(envelope.payload.invocation_id, outcome) as unknown as JsonValue,
      artifactCarrier: outcome.artifactCarrier,
    });
    return drafts;
  }
  if (outcome.kind === "not_started") return drafts;
  drafts.push({
    type: "error",
    id: id(),
    ts: ts(),
    payload: {
      invocation_id: envelope.payload.invocation_id,
      ...errorDetail(outcome, envelope.payload.mutation_scope),
    } as unknown as JsonValue,
    artifactCarrier: null,
  });
  return drafts;
}

function batchStep(
  outcome: BridgeInvocationOutcome,
  index: number,
  envelope: InvokeBatchEnvelope,
): BatchStepResult {
  const invocationId = envelope.payload.steps[index]?.invocation_id ?? `missing-${index}`;
  if (outcome.kind === "not_started") {
    return {
      index,
      invocation_id: invocationId,
      status: "not_started",
      replayed: outcome.replayed,
    } as BatchStepResult;
  }
  if (outcome.kind === "result") {
    return {
      index,
      invocation_id: invocationId,
      status: outcome.status,
      replayed: outcome.replayed,
      ...(outcome.payloadOmitted
        ? { payload_omitted: true, result_digest: outcome.resultDigest }
        : { result: outcome.result ?? null, result_digest: outcome.resultDigest }),
      ...(outcome.status === "guarded" ? { guarded_reason: outcome.guardedReason as string } : {}),
      ...(outcome.lateAfterIndeterminate
        ? {
            late_after_indeterminate: true,
            verification_hold_id: outcome.verificationHoldId as string,
          }
        : {}),
    } as BatchStepResult;
  }
  const status = outcome.outcome === "indeterminate"
    ? "indeterminate"
    : outcome.faultClass === "cancelled"
      ? "cancelled"
      : "failed";
  return {
    index,
    invocation_id: invocationId,
    status,
    replayed: outcome.replayed,
    error: errorDetail(
      outcome,
      envelope.payload.steps[index]?.mutation_scope ?? null,
    ),
  } as BatchStepResult;
}

function batchDraft(
  envelope: InvokeBatchEnvelope,
  outcome: BridgeBatchOutcome,
  id: string,
  ts: string,
): QueuedDataDraft {
  if (outcome.kind === "error") {
    return {
      type: "error",
      id,
      ts,
      payload: {
        batch_id: outcome.batchId,
        retryable: false,
        fault_class: outcome.faultClass ?? "protocol",
        message: outcome.message ?? "batch rejected",
        outcome: outcome.faultClass === "journal_indeterminate" ? "indeterminate" : "known",
        verification_required: outcome.faultClass === "journal_indeterminate",
        replayed: false,
        ...(outcome.faultClass === "journal_indeterminate"
          ? {
              verification_hold_id: outcome.verificationHoldId as string,
              mutation_scope: outcome.mutationScope as unknown as JsonValue,
            }
          : {}),
      },
      artifactCarrier: null,
    };
  }
  const steps = (outcome.steps ?? []).map((step, index) => batchStep(step, index, envelope));
  return {
    type: "result",
    id,
    ts,
    payload: {
      kind: "batch",
      batch_id: outcome.batchId,
      atomic: envelope.payload.atomic,
      status: outcome.status as string,
      transaction_state: outcome.transactionState as string,
      failed_step_index: outcome.failedStepIndex ?? null,
      steps: steps as unknown as JsonValue,
      replayed: outcome.replayed ?? false,
    },
    artifactCarrier: null,
  };
}

export class BridgeGatewayPeer {
  readonly #simulator: BridgeSimulator;
  #binding: GatewayBinding;
  #heartbeatIntervalMs: number;
  readonly #nowMs: () => number;
  readonly #id: () => string;
  readonly #reconnect: BridgeGatewayPeerOptions["reconnect"];
  readonly #reconnectJitter: () => number;
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #sessions = new Map<string, SessionLifecycleState>();
  readonly #pendingRegistrations = new Map<string, PendingRegistration>();
  readonly #pendingResumes = new Set<string>();
  readonly #lastContext = new Map<string, string>();
  readonly #lastContextPollAt = new Map<string, number>();
  readonly #queuedData = new Map<string, QueuedDataDraft[]>();
  readonly #sentSeq = new Map<string, number>();
  readonly #resumeRetransmit = new Set<string>();
  readonly #inboundTasks = new Set<Promise<void>>();
  readonly #pumpChains = new Map<string, Promise<void>>();
  #lastHeartbeatSentAtMs: number;
  #lastHeartbeatAckAtMs: number;
  #heartbeatAckDeadlineAtMs: number | null = null;
  #heartbeatTimedOut = false;
  #connectedAtMs: number;
  #reconnectAttemptIndex = 0;
  #reconnectTask: Promise<boolean> | null = null;
  #inboundError: unknown = null;
  #runLoopActive = false;
  #closed = false;

  public constructor(
    simulator: BridgeSimulator,
    binding: GatewayBinding,
    helloAck: HelloAckEnvelope,
    options: BridgeGatewayPeerOptions = {},
  ) {
    if (binding.connectionId !== helloAck.payload.connection_id) {
      throw new Error("Gateway binding and hello_ack connection ids differ");
    }
    this.#simulator = simulator;
    this.#binding = binding;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? helloAck.payload.heartbeat_interval_ms;
    this.#nowMs = options.nowMs ?? Date.now;
    this.#id = options.idFactory ?? defaultId;
    this.#reconnect = options.reconnect;
    this.#reconnectJitter = options.reconnectJitter ?? Math.random;
    this.#sleep = options.sleep ?? (async (delayMs) => await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }));
    const now = this.#nowMs();
    this.#connectedAtMs = now;
    this.#lastHeartbeatSentAtMs = now;
    this.#lastHeartbeatAckAtMs = now;
    this.#applyHelloAckLimits(helloAck);
    for (const session of simulator.registeredSessions()) {
      this.#sessions.set(session.rsid, registeredLifecycle(session.probe.localSessionKey, session.rsid));
    }
  }

  public snapshot(nowMs = this.#nowMs()): BridgeGatewayPeerSnapshot {
    return {
      bindingKind: this.#binding.kind,
      connectionId: this.#binding.connectionId,
      bufferedAmount: this.#binding.bufferedAmount,
      liveness: this.livenessAt(nowMs),
      lastHeartbeatAckAtMs: this.#lastHeartbeatAckAtMs,
      lastHeartbeatSentAtMs: this.#lastHeartbeatSentAtMs,
      runLoopActive: this.#runLoopActive,
      closed: this.#closed,
      sessions: [...this.#sessions.values()].map((state) => structuredClone(state)),
      pendingRegistrationCount: this.#pendingRegistrations.size,
      pendingResumeCount: this.#pendingResumes.size,
      queuedDataCount: [...this.#queuedData.values()].reduce((sum, queue) => sum + queue.length, 0),
      sentSeqs: [...this.#sentSeq].map(([rsid, seq]) => ({ rsid, seq })),
      reconnectAttemptIndex: this.#reconnectAttemptIndex,
      heartbeatAckDeadlineAtMs: this.#heartbeatAckDeadlineAtMs,
    };
  }

  public livenessAt(nowMs = this.#nowMs()): BridgePeerLiveness {
    if (this.#heartbeatTimedOut) return "disconnected";
    const silence = Math.max(0, nowMs - this.#lastHeartbeatAckAtMs);
    if (silence >= RBP_HEARTBEAT_DISCONNECTED_AFTER_MS) return "disconnected";
    if (silence >= RBP_HEARTBEAT_DEGRADED_AFTER_MS) return "degraded";
    return "steady";
  }

  public async run(signal?: AbortSignal): Promise<void> {
    if (this.#runLoopActive) throw new Error("Bridge Gateway run loop is already active");
    this.#runLoopActive = true;
    try {
      while (!this.#shouldStop(signal)) {
        const observedBinding = this.#binding;
        let transportFailure: unknown = null;
        try {
          for await (const envelope of observedBinding.messages()) {
            if (this.#shouldStop(signal) || observedBinding !== this.#binding) break;
            if (envelope.type === "invoke" || envelope.type === "invoke_batch" || envelope.type === "cancel") {
              this.#trackInbound(this.handleInbound(envelope));
            } else {
              await this.handleInbound(envelope);
            }
            if (this.#inboundError !== null) break;
          }
        } catch (error) {
          transportFailure = error;
        }
        if (this.#inboundError !== null) throw this.#inboundError;
        if (this.#shouldStop(signal)) break;
        if (observedBinding !== this.#binding) continue;
        try {
          await observedBinding.close();
        } catch (error) {
          if (transportFailure === null) transportFailure = error;
        }
        if (
          transportFailure !== null &&
          (!(transportFailure instanceof GatewayTransportError) || transportFailure.faultClass !== "retryable_network")
        ) {
          throw transportFailure;
        }
        const reconnected = await this.#attemptReconnect();
        if (!reconnected && this.#reconnect === undefined) {
          if (transportFailure !== null) throw transportFailure;
          break;
        }
      }
      await Promise.allSettled([...this.#inboundTasks]);
      if (this.#inboundError !== null) throw this.#inboundError;
    } finally {
      this.#runLoopActive = false;
    }
  }

  public async registerSession(input: {
    readonly probe: ProbedAddinSession;
    readonly registration: SessionRegister;
  }): Promise<string> {
    this.#assertOpen();
    const id = this.#id();
    let lifecycle = createSessionLifecycle(input.probe.localSessionKey);
    lifecycle = transitionOrThrow(lifecycle, { type: "register_requested" });
    this.#pendingRegistrations.set(id, input);
    this.#sessions.set(input.probe.localSessionKey, lifecycle);
    await this.#sendControl({
      v: 1,
      type: "session_register",
      id,
      ts: this.#nowIso(),
      payload: input.registration,
    });
    return id;
  }

  public async resumeAll(): Promise<void> {
    for (const session of this.#simulator.registeredSessions()) await this.resumeSession(session.rsid);
  }

  public async resumeSession(rsid: string): Promise<void> {
    this.#assertOpen();
    const session = this.#simulator.getSession(rsid);
    const state = this.#sessions.get(rsid);
    if (session === null || state === undefined || !state.resumeAllowed || state.phase === "unregistered") {
      throw new Error(`session ${rsid} is not resumable`);
    }
    let disconnected = state;
    if (disconnected.phase === "registered") {
      disconnected = transitionOrThrow(disconnected, { type: "connection_lost" });
    }
    const resuming = transitionOrThrow(disconnected, { type: "resume_requested" });
    this.#sessions.set(rsid, resuming);
    this.#pendingResumes.add(rsid);
    const sequence = this.#simulator.journal.loadSequence(rsid);
    await this.#sendControl({
      v: 1,
      type: "session_resume",
      id: this.#id(),
      ts: this.#nowIso(),
      payload: {
        rsid,
        resume_token: session.resumeToken,
        last_rx_seq: sequence.lastRxSeq,
      },
    });
  }

  public async unregisterSession(
    rsid: string,
    reason: SessionUnregister["reason"],
  ): Promise<ReturnType<BridgeSimulator["unregisterSession"]>> {
    const state = this.#sessions.get(rsid);
    if (state === undefined) throw new Error(`unknown rsid: ${rsid}`);
    this.#sessions.set(rsid, transitionOrThrow(state, { type: "unregister", reason }));
    this.#pendingResumes.delete(rsid);
    this.#queuedData.delete(rsid);
    this.#sentSeq.delete(rsid);
    this.#resumeRetransmit.delete(rsid);
    const decisions = this.#simulator.unregisterSession(rsid, reason);
    await this.#sendControl({
      v: 1,
      type: "session_unregister",
      id: this.#id(),
      ts: this.#nowIso(),
      payload: { rsid, reason },
    });
    return decisions;
  }

  public async pollDocumentContext(rsid: string, force = false): Promise<boolean> {
    const state = this.#sessions.get(rsid);
    if (state?.dispatchAllowed !== true) return false;
    const context = await this.#simulator.documentContext(rsid, this.#id());
    const normalized = canonicalizeJson(context as unknown as JsonValue);
    this.#lastContextPollAt.set(rsid, this.#nowMs());
    if (!force && this.#lastContext.get(rsid) === normalized) return false;
    this.#lastContext.set(rsid, normalized);
    this.#enqueueData(rsid, {
      type: "doc_context_update",
      id: this.#id(),
      ts: this.#nowIso(),
      payload: context as unknown as JsonValue,
      artifactCarrier: null,
    });
    await this.flushOutbound(rsid);
    return true;
  }

  public async sendHeartbeat(): Promise<void> {
    this.#assertOpen();
    const envelope: HeartbeatEnvelope = {
      v: 1,
      type: "heartbeat",
      id: this.#id(),
      ts: this.#nowIso(),
      payload: await this.#simulator.heartbeat(),
    };
    await this.#sendControl(envelope);
    this.#lastHeartbeatSentAtMs = this.#nowMs();
    // A later heartbeat must not extend the deadline of an earlier
    // unacknowledged heartbeat.  This matters when a Gateway negotiates an
    // interval shorter than the fixed ten-second acknowledgement window.
    if (this.#heartbeatAckDeadlineAtMs === null) {
      this.#heartbeatAckDeadlineAtMs = this.#lastHeartbeatSentAtMs + 10_000;
    }
  }

  public async tick(nowMs = this.#nowMs()): Promise<BridgePeerLiveness> {
    this.#assertOpen();
    if (
      this.#heartbeatAckDeadlineAtMs !== null &&
      nowMs >= this.#heartbeatAckDeadlineAtMs
    ) {
      this.#heartbeatTimedOut = true;
      await this.#binding.close();
      const reconnected = await this.#attemptReconnect();
      if (!reconnected) return "disconnected";
    }
    if (!this.#heartbeatTimedOut && this.#reconnectAttemptIndex > 0 && nowMs - this.#connectedAtMs >= 120_000) {
      this.#reconnectAttemptIndex = 0;
    }
    const liveness = this.livenessAt(nowMs);
    if (liveness === "disconnected") {
      await this.#binding.close();
      return liveness;
    }
    if (nowMs - this.#lastHeartbeatSentAtMs >= this.#heartbeatIntervalMs) {
      await this.sendHeartbeat();
    }
    for (const state of this.#sessions.values()) {
      if (state.rsid === null || !state.dispatchAllowed) continue;
      const last = this.#lastContextPollAt.get(state.rsid) ?? Number.NEGATIVE_INFINITY;
      if (nowMs - last >= BRIDGE_DOCUMENT_CONTEXT_POLL_MS) {
        await this.pollDocumentContext(state.rsid);
      }
    }
    await this.flushOutbound();
    return liveness;
  }

  public async handleInbound(envelope: RbpEnvelope): Promise<void> {
    this.#assertOpen();
    if (!validateRbpEnvelope(envelope)) throw new Error("invalid inbound Gateway envelope");
    switch (envelope.type) {
      case "session_registered":
        await this.#handleRegistered(envelope);
        return;
      case "resume_ack":
        await this.#handleResumeAck(envelope);
        return;
      case "heartbeat_ack":
        await this.#handleHeartbeatAck(envelope);
        return;
      case "invoke":
        await this.#handleInvoke(envelope);
        return;
      case "invoke_batch":
        await this.#handleBatch(envelope);
        return;
      case "cancel": {
        const accepted = this.#simulator.acceptInboundEnvelope(
          envelope as unknown as DataEnvelopeSnapshot,
        );
        if (accepted.kind === "protocol_fault" || accepted.kind === "gap") {
          throw new Error(`cancel sequence rejected: ${accepted.kind}`);
        }
        const outcome = this.#simulator.cancel(envelope.rsid, envelope.payload.invocation_id);
        if (outcome === null) return;
        const invokeLike = {
          ...envelope,
          type: "invoke",
          payload: {
            invocation_id: envelope.payload.invocation_id,
            method: "cancel",
            params: {},
            timeout_ms: 1,
            mutating: false,
            mutation_scope: null,
            policy: { class: "auto", decision: "auto", confirmation_id: null },
            verification: null,
            recovery_clearances: [],
          },
        } as InvokeEnvelope;
        this.#enqueueMany(envelope.rsid, invocationDrafts(invokeLike, outcome, this.#id, () => this.#nowIso()));
        await this.flushOutbound(envelope.rsid);
        return;
      }
      case "goodbye":
        await this.close();
        return;
      default:
        throw new Error(
          `unsupported Gateway-to-Bridge message: ${String((envelope as unknown as { type?: unknown }).type)}`,
        );
    }
  }

  public async flushOutbound(rsid?: string): Promise<void> {
    const sessionIds = rsid === undefined
      ? new Set([
          ...this.#queuedData.keys(),
          ...this.#simulator.registeredSessions().map((session) => session.rsid),
        ])
      : new Set([rsid]);
    await Promise.all([...sessionIds].map(async (sessionId) => await this.#schedulePump(sessionId)));
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#binding.close();
    this.#simulator.close();
  }

  public async shutdown(): Promise<void> {
    for (const session of [...this.#simulator.registeredSessions()]) {
      try {
        await this.unregisterSession(session.rsid, "bridge_shutdown");
      } catch {
        this.#simulator.unregisterSession(session.rsid, "bridge_shutdown");
      }
    }
    await this.close();
  }

  async #handleRegistered(envelope: SessionRegisteredEnvelope): Promise<void> {
    // RBP control-envelope ids are sender-owned; session_registered does not
    // echo the Bridge request id. The Gateway processes registration controls
    // in stream order, so correlate to the oldest outstanding registration.
    const pendingEntry = this.#pendingRegistrations.entries().next().value as
      | [string, PendingRegistration]
      | undefined;
    if (pendingEntry === undefined) throw new Error("uncorrelated session_registered");
    const [requestId, pending] = pendingEntry;
    this.#pendingRegistrations.delete(requestId);
    const previous = this.#sessions.get(pending.probe.localSessionKey);
    if (previous === undefined) throw new Error("registration lifecycle is missing");
    const session = this.#simulator.attachSession({
      rsid: envelope.payload.rsid,
      resumeToken: envelope.payload.resume_token,
      resumeExpiresAt: envelope.payload.resume_expires_at,
      grantedSessionCapabilities: envelope.payload.granted_session_capabilities,
      probe: pending.probe,
      registration: pending.registration,
    });
    this.#sessions.delete(pending.probe.localSessionKey);
    this.#sessions.set(
      session.rsid,
      transitionOrThrow(previous, { type: "registered", rsid: session.rsid }),
    );
    await this.pollDocumentContext(session.rsid, true);
  }

  async #handleResumeAck(envelope: ResumeAckEnvelope): Promise<void> {
    const rsid = envelope.payload.rsid;
    if (!this.#pendingResumes.delete(rsid)) throw new Error("uncorrelated resume_ack");
    const state = this.#sessions.get(rsid);
    if (state === undefined) throw new Error("resume lifecycle is missing");
    this.#simulator.acknowledgeOutbound(rsid, envelope.payload.last_rx_seq);
    this.#sentSeq.delete(rsid);
    this.#simulator.updateResumeExpiry(rsid, envelope.payload.resume_expires_at);
    this.#sessions.set(rsid, transitionOrThrow(state, { type: "resumed" }));
    this.#resumeRetransmit.add(rsid);
    await this.flushOutbound(rsid);
    await this.pollDocumentContext(rsid, true);
  }

  async #handleHeartbeatAck(envelope: HeartbeatAckEnvelope): Promise<void> {
    this.#lastHeartbeatAckAtMs = this.#nowMs();
    this.#heartbeatAckDeadlineAtMs = null;
    this.#heartbeatTimedOut = false;
    for (const entry of envelope.payload.acks) {
      const acknowledged = this.#simulator.acknowledgeOutbound(entry.rsid, entry.seq);
      if (acknowledged.includes(this.#sentSeq.get(entry.rsid) ?? -1)) {
        this.#sentSeq.delete(entry.rsid);
      }
      await this.flushOutbound(entry.rsid);
    }
  }

  async #handleInvoke(envelope: InvokeEnvelope): Promise<void> {
    if (this.#sessions.get(envelope.rsid)?.dispatchAllowed !== true) {
      throw new Error(`dispatch is revoked for ${envelope.rsid}`);
    }
    const outcome = await this.#simulator.invoke(envelope);
    if (envelope.ack !== undefined) {
      this.#simulator.acknowledgeOutbound(envelope.rsid, envelope.ack);
      this.#sentSeq.delete(envelope.rsid);
    }
    this.#enqueueMany(
      envelope.rsid,
      invocationDrafts(envelope, outcome, this.#id, () => this.#nowIso()),
    );
    await this.flushOutbound(envelope.rsid);
  }

  async #handleBatch(envelope: InvokeBatchEnvelope): Promise<void> {
    if (this.#sessions.get(envelope.rsid)?.dispatchAllowed !== true) {
      throw new Error(`dispatch is revoked for ${envelope.rsid}`);
    }
    const outcome = await this.#simulator.invokeBatch(envelope);
    if (envelope.ack !== undefined) {
      this.#simulator.acknowledgeOutbound(envelope.rsid, envelope.ack);
      this.#sentSeq.delete(envelope.rsid);
    }
    this.#enqueueData(
      envelope.rsid,
      batchDraft(envelope, outcome, this.#id(), this.#nowIso()),
    );
    await this.flushOutbound(envelope.rsid);
  }

  #enqueueMany(rsid: string, drafts: readonly QueuedDataDraft[]): void {
    for (const draft of drafts) this.#enqueueData(rsid, draft);
  }

  #enqueueData(rsid: string, draft: QueuedDataDraft): void {
    const queue = this.#queuedData.get(rsid) ?? [];
    queue.push(draft);
    this.#queuedData.set(rsid, queue);
  }

  async #pumpSession(rsid: string): Promise<void> {
    if (this.#closed || this.#binding.bufferedAmount > BRIDGE_OUTBOUND_HIGH_WATER_BYTES) return;
    const sequence = this.#simulator.journal.loadSequence(rsid);
    const retained = sequence.outbox[0];
    if (retained !== undefined) {
      if (this.#sentSeq.get(rsid) === retained.envelope.seq) return;
      const envelope = this.#resumeRetransmit.delete(rsid)
        ? this.#simulator.retransmit(rsid, this.#nowIso())[0] ?? retained.envelope
        : retained.envelope;
      await this.#binding.send(envelope as unknown as RbpEnvelope);
      this.#sentSeq.set(rsid, envelope.seq);
      return;
    }
    const queue = this.#queuedData.get(rsid);
    const draft = queue?.shift();
    if (draft === undefined) return;
    if (queue?.length === 0) this.#queuedData.delete(rsid);
    const envelope = this.#simulator.queueOutbound(
      rsid,
      { type: draft.type, id: draft.id, ts: draft.ts, payload: draft.payload },
      draft.artifactCarrier,
    );
    if (!validateRbpEnvelope(envelope)) {
      throw new Error(`Bridge created an invalid ${draft.type} data envelope`);
    }
    await this.#binding.send(envelope as unknown as RbpEnvelope);
    this.#sentSeq.set(rsid, envelope.seq);
  }

  async #schedulePump(rsid: string): Promise<void> {
    const previous = this.#pumpChains.get(rsid) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => await this.#pumpSession(rsid));
    this.#pumpChains.set(rsid, next);
    try {
      await next;
    } finally {
      if (this.#pumpChains.get(rsid) === next) this.#pumpChains.delete(rsid);
    }
  }

  #trackInbound(task: Promise<void>): void {
    this.#inboundTasks.add(task);
    void task.catch(async (error: unknown) => {
      if (this.#inboundError === null) this.#inboundError = error;
      try {
        await this.#binding.close();
      } catch {
        // The original inbound error remains authoritative.
      }
    }).finally(() => this.#inboundTasks.delete(task));
  }

  #applyHelloAckLimits(helloAck: HelloAckEnvelope): void {
    this.#simulator.applyNegotiatedLimits({
      maxParamsBytes: helloAck.payload.limits.max_params_bytes,
      maxResultBytes: helloAck.payload.limits.max_result_bytes,
      maxPartialBytes: helloAck.payload.limits.max_partial_bytes,
    });
  }

  async #attemptReconnect(): Promise<boolean> {
    if (this.#closed || this.#reconnect === undefined) return false;
    if (this.#reconnectTask !== null) return await this.#reconnectTask;
    this.#reconnectTask = (async () => {
      const attemptIndex = this.#reconnectAttemptIndex;
      const delayMs = this.#simulator.reconnectDelay(attemptIndex, this.#reconnectJitter());
      this.#reconnectAttemptIndex += 1;
      await this.#sleep(delayMs);
      if (this.#closed) return false;
      let nextBinding: GatewayBinding | null = null;
      try {
        const next = await this.#reconnect?.({ attemptIndex, delayMs });
        if (next === undefined) return false;
        nextBinding = next.binding;
        if (next.binding.connectionId !== next.helloAck.payload.connection_id) {
          await next.binding.close();
          nextBinding = null;
          throw new Error("reconnected Gateway binding and hello_ack ids differ");
        }
        this.#binding = next.binding;
        this.#heartbeatIntervalMs = next.helloAck.payload.heartbeat_interval_ms;
        this.#applyHelloAckLimits(next.helloAck);
        const now = this.#nowMs();
        this.#connectedAtMs = now;
        this.#lastHeartbeatSentAtMs = now;
        this.#lastHeartbeatAckAtMs = now;
        this.#heartbeatAckDeadlineAtMs = null;
        this.#heartbeatTimedOut = false;
        this.#sentSeq.clear();
        this.#prepareSessionsForReconnect();
        await this.#resendPendingRegistrations();
        await this.resumeAll();
        return true;
      } catch {
        if (nextBinding !== null) {
          try {
            await nextBinding.close();
          } catch {
            // The retry state remains disconnected even when cleanup fails.
          }
        }
        this.#heartbeatTimedOut = true;
        return false;
      }
    })();
    try {
      return await this.#reconnectTask;
    } finally {
      this.#reconnectTask = null;
    }
  }

  #prepareSessionsForReconnect(): void {
    this.#pendingResumes.clear();
    for (const [rsid, state] of this.#sessions) {
      if (state.phase === "registered") {
        this.#sessions.set(rsid, transitionOrThrow(state, { type: "connection_lost" }));
      } else if (state.phase === "resuming") {
        this.#sessions.set(rsid, {
          ...state,
          phase: "disconnected",
          dispatchAllowed: false,
        });
      }
    }
  }

  async #resendPendingRegistrations(): Promise<void> {
    if (this.#pendingRegistrations.size === 0) return;
    const pending = [...this.#pendingRegistrations.values()];
    this.#pendingRegistrations.clear();
    const resends = pending.map((entry) => ({ id: this.#id(), entry }));
    for (const resend of resends) this.#pendingRegistrations.set(resend.id, resend.entry);
    for (const resend of resends) {
      await this.#sendControl({
        v: 1,
        type: "session_register",
        id: resend.id,
        ts: this.#nowIso(),
        payload: resend.entry.registration,
      });
    }
  }

  async #sendControl(envelope: RbpEnvelope): Promise<void> {
    const envelopeType = envelope.type;
    if (!validateRbpEnvelope(envelope)) {
      throw new Error(`invalid outbound control envelope ${envelopeType}`);
    }
    await this.#binding.send(envelope);
  }

  #nowIso(): string {
    return new Date(this.#nowMs()).toISOString();
  }

  #shouldStop(signal?: AbortSignal): boolean {
    return signal?.aborted === true || this.#closed;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Bridge Gateway peer is closed");
  }
}

export function documentContextDigest(context: DocContextUpdate): string {
  return createHash("sha256")
    .update(canonicalizeJson(context as unknown as JsonValue), "utf8")
    .digest("hex");
}

export type { GatewayBinding };
