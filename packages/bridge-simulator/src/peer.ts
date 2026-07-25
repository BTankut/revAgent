import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import {
  RBP_HEARTBEAT_DEGRADED_AFTER_MS,
  RBP_HEARTBEAT_DISCONNECTED_AFTER_MS,
  acceptInboundData,
  canonicalizeJson,
  createSessionLifecycle,
  rbpEnvelopeErrors,
  sequenceRenewalStatus,
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

import type { DurableResultCarrier } from "./artifacts.js";
import type {
  BridgeSimulator,
  BridgeBatchOutcome,
  BridgeCrashPoint,
  BridgeInvocationOutcome,
} from "./bridgeSimulator.js";
import type { ProbedAddinSession } from "./loopback.js";
import { GatewayTransportError, type GatewayBinding } from "./transport.js";

export const BRIDGE_OUTBOUND_HIGH_WATER_BYTES = 8 * 1024 * 1024;
export const BRIDGE_DOCUMENT_CONTEXT_POLL_MS = 15_000;
const MAX_DELIVERY_PROGRESS_RECORDS = 128;
const MAX_SEQUENCE_TRANSPORT_EVENTS = 64;
const MAX_SEQUENCE_RENEWAL_EVENTS = 16;

export type BridgePeerLiveness = "steady" | "degraded" | "disconnected";

interface PendingRegistration {
  readonly probe: ProbedAddinSession;
  readonly registration: SessionRegister;
  readonly renewalOldRsid: string | null;
}

interface QueuedDataDraft {
  readonly type: string;
  readonly id: string;
  readonly ts: string;
  readonly payload: JsonValue;
  readonly deliveryCarrier: DurableResultCarrier | null;
}

interface InvocationReplyContext {
  readonly invocationId: string;
  readonly mutationScope: InvokeEnvelope["payload"]["mutation_scope"];
}

interface BatchReplyContext {
  readonly batchId: string;
  readonly atomic: boolean;
  readonly steps: readonly InvocationReplyContext[];
}

interface MutableDeliveryProgress {
  rsid: string;
  invocationId: string;
  chunkFramesSent: number;
  artifactChunkFramesSent: number;
  resultChunkFramesSent: number;
  progressFramesSent: number;
  terminalFramesSent: number;
  lastSentSeq: number;
}

interface SequenceTransportEvent {
  readonly ordinal: number;
  readonly observedAtMs: number;
  readonly rsid: string;
  readonly kind: "duplicate" | "gap";
  readonly receivedSeq: number;
  readonly expectedSeq: number | null;
  readonly accepted: false;
}

interface SequenceRenewalEvent {
  readonly ordinal: number;
  readonly observedAtMs: number;
  readonly reason: "sequence_exhaustion";
  readonly oldRsid: string;
  readonly newRsid: string;
  readonly oldHighestTxSeq: number;
  readonly oldLastPeerAck: number;
  readonly oldOutboxCount: 0;
  readonly newInitialNextTxSeq: 1;
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
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /**
   * Conformance-only one-shot crash selector. Production callers omit it; the
   * daemon control surface uses it to exercise the real inbound Gateway path.
   */
  readonly takeInboundCrashPoint?: () => BridgeCrashPoint | null;
  /** Unit-fixture escape hatch only. Production bindings must prove authority with resume_ack. */
  readonly unsafeAssumeCurrentBindingForTests?: boolean;
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
  readonly pendingUnregisterCount: number;
  readonly queuedDataCount: number;
  readonly sentSeqs: readonly { readonly rsid: string; readonly seq: number }[];
  readonly reconnectAttemptIndex: number;
  readonly heartbeatAckDeadlineAtMs: number | null;
  readonly grantedCapabilities: readonly string[];
  readonly retrySuppressedFault: "auth" | "version" | "trust" | "protocol" | null;
  readonly reconnectDelayFloorMs: number;
  readonly backpressure: {
    readonly evidenceVersion: 1;
    readonly source: "transport.bufferedAmount";
    readonly highWaterBytes: number;
    readonly currentBufferedAmount: number;
    readonly maxObservedBufferedAmount: number;
    readonly sampleCount: number;
    readonly blockedPumpCount: number;
    readonly active: boolean;
    readonly controlFramesSentWhileBackpressured: number;
  };
  readonly deliveryProgress: {
    readonly evidenceVersion: 1;
    readonly capacity: number;
    readonly totalRecordCount: number;
    readonly droppedRecordCount: number;
    readonly records: readonly {
      readonly rsid: string;
      readonly invocationId: string;
      readonly chunkFramesSent: number;
      readonly artifactChunkFramesSent: number;
      readonly resultChunkFramesSent: number;
      readonly progressFramesSent: number;
      readonly terminalFramesSent: number;
      readonly lastSentSeq: number;
    }[];
  };
  readonly sequenceTransportEvents: {
    readonly evidenceVersion: 1;
    readonly capacity: number;
    readonly totalEventCount: number;
    readonly droppedEventCount: number;
    readonly records: readonly SequenceTransportEvent[];
  };
  readonly sequenceRenewalEvents: {
    readonly evidenceVersion: 1;
    readonly capacity: number;
    readonly totalEventCount: number;
    readonly droppedEventCount: number;
    readonly records: readonly SequenceRenewalEvent[];
  };
}

function defaultId(): string {
  return `0197a3c2-0000-7000-8000-${randomBytes(6).toString("hex")}`;
}

async function sleepUntil(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
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
    ...(outcome.lateAfterIndeterminate
      ? {
          late_after_indeterminate: true,
          result_digest: outcome.resultDigest as string,
        }
      : {}),
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
  invocation: InvocationReplyContext,
  outcome: BridgeInvocationOutcome,
  id: () => string,
  ts: () => string,
): QueuedDataDraft[] {
  const drafts: QueuedDataDraft[] = [];
  if (outcome.kind === "result") {
    const progressRequested =
      typeof outcome.result === "object" &&
      outcome.result !== null &&
      !Array.isArray(outcome.result) &&
      (outcome.result as Record<string, unknown>).fixtureArtifactProgress === true;
    const totalChunks = outcome.partials.length;
    let chunksSent = 0;
    for (let index = 0; index < outcome.partials.length; index += 1) {
      const partial = outcome.partials[index] as (typeof outcome.partials)[number];
      drafts.push({
        type: "partial",
        id: id(),
        ts: ts(),
        payload: partial as unknown as JsonValue,
        deliveryCarrier: null,
      });
      chunksSent += 1;
      const next = outcome.partials[index + 1];
      if (progressRequested && (next === undefined || next.stream_id !== partial.stream_id)) {
        drafts.push({
          type: "partial",
          id: id(),
          ts: ts(),
          payload: {
            kind: "progress",
            invocation_id: invocation.invocationId,
            progress: {
              elapsed_ms: 0,
              note: "bridge_chunk_delivery",
              chunks_sent: chunksSent,
              total_chunks: totalChunks,
              stream_id: partial.stream_id,
            },
          },
          deliveryCarrier: null,
        });
      }
    }
    drafts.push({
      type: "result",
      id: id(),
      ts: ts(),
      payload: resultPayload(invocation.invocationId, outcome) as unknown as JsonValue,
      deliveryCarrier: outcome.artifactCarrier === null && outcome.resultCarrier === null
        ? null
        : { ...(outcome.artifactCarrier ?? outcome.resultCarrier as DurableResultCarrier), partials: [] },
    });
    return drafts;
  }
  if (outcome.kind === "not_started" || outcome.kind === "transport_duplicate") return drafts;
  drafts.push({
    type: "error",
    id: id(),
    ts: ts(),
    payload: {
      invocation_id: invocation.invocationId,
      ...errorDetail(outcome, invocation.mutationScope),
    } as unknown as JsonValue,
    deliveryCarrier: null,
  });
  return drafts;
}

function batchStep(
  outcome: BridgeInvocationOutcome,
  index: number,
  context: BatchReplyContext,
): BatchStepResult {
  const invocationId = context.steps[index]?.invocationId ?? `missing-${index}`;
  if (outcome.kind === "not_started") {
    return {
      index,
      invocation_id: invocationId,
      status: "not_started",
      replayed: outcome.replayed,
    } as BatchStepResult;
  }
  if (outcome.kind === "transport_duplicate") {
    throw new Error("transport duplicate cannot be a batch step result");
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
    ...(outcome.effectState === undefined ? {} : { effect_state: outcome.effectState }),
    error: errorDetail(
      outcome,
      context.steps[index]?.mutationScope ?? null,
    ),
    ...(outcome.lateAfterIndeterminate
      ? {
          late_after_indeterminate: true,
          verification_hold_id: outcome.verificationHoldId as string,
          result_digest: outcome.resultDigest as string,
        }
      : {}),
  } as BatchStepResult;
}

function batchDraft(
  context: BatchReplyContext,
  outcome: BridgeBatchOutcome,
  id: string,
  ts: string,
): QueuedDataDraft {
  if (outcome.kind === "transport_duplicate") {
    throw new Error("transport duplicate must not produce an RBP batch result");
  }
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
        replayed: outcome.replayed ?? false,
        ...(outcome.faultClass === "journal_indeterminate"
          ? {
              verification_hold_id: outcome.verificationHoldId as string,
              mutation_scope: outcome.mutationScope as unknown as JsonValue,
            }
          : {}),
      },
      deliveryCarrier: null,
    };
  }
  const steps = (outcome.steps ?? []).map((step, index) => batchStep(step, index, context));
  return {
    type: "result",
    id,
    ts,
    payload: {
      kind: "batch",
      batch_id: outcome.batchId,
      atomic: context.atomic,
      status: outcome.status as string,
      transaction_state: outcome.transactionState as string,
      failed_step_index: outcome.failedStepIndex ?? null,
      steps: steps as unknown as JsonValue,
      replayed: outcome.replayed ?? false,
    },
    deliveryCarrier: null,
  };
}

function batchReplyContext(envelope: InvokeBatchEnvelope): BatchReplyContext {
  return {
    batchId: envelope.payload.batch_id,
    atomic: envelope.payload.atomic,
    steps: envelope.payload.steps.map((step) => ({
      invocationId: step.invocation_id,
      mutationScope: step.mutation_scope,
    })),
  };
}

function parseInvocationReplyContext(value: string): InvocationReplyContext {
  const parsed = JSON.parse(value) as Partial<{
    readonly invocation_id: string;
    readonly mutation_scope: InvokeEnvelope["payload"]["mutation_scope"];
  }>;
  if (typeof parsed.invocation_id !== "string" || !("mutation_scope" in parsed)) {
    throw new Error("durable invocation reply context is invalid");
  }
  return {
    invocationId: parsed.invocation_id,
    mutationScope: parsed.mutation_scope ?? null,
  };
}

function parseBatchReplyContext(value: string): BatchReplyContext {
  const parsed = JSON.parse(value) as {
    readonly batch_id?: unknown;
    readonly atomic?: unknown;
    readonly steps?: unknown;
  };
  if (
    typeof parsed.batch_id !== "string" ||
    typeof parsed.atomic !== "boolean" ||
    !Array.isArray(parsed.steps)
  ) {
    throw new Error("durable batch reply context is invalid");
  }
  const steps = parsed.steps.map((step): InvocationReplyContext => {
    if (
      typeof step !== "object" || step === null ||
      !("invocation_id" in step) || typeof step.invocation_id !== "string" ||
      !("mutation_scope" in step)
    ) {
      throw new Error("durable batch reply step context is invalid");
    }
    return {
      invocationId: step.invocation_id,
      mutationScope: step.mutation_scope as InvokeEnvelope["payload"]["mutation_scope"],
    };
  });
  return { batchId: parsed.batch_id, atomic: parsed.atomic, steps };
}

export class BridgeGatewayPeer {
  readonly #simulator: BridgeSimulator;
  #binding: GatewayBinding;
  #heartbeatIntervalMs: number;
  readonly #nowMs: () => number;
  readonly #id: () => string;
  readonly #reconnect: BridgeGatewayPeerOptions["reconnect"];
  readonly #reconnectJitter: () => number;
  readonly #sleep: NonNullable<BridgeGatewayPeerOptions["sleep"]>;
  readonly #closeAbort = new AbortController();
  readonly #takeInboundCrashPoint: BridgeGatewayPeerOptions["takeInboundCrashPoint"];
  readonly #sessions = new Map<string, SessionLifecycleState>();
  readonly #pendingRegistrations = new Map<string, PendingRegistration>();
  readonly #pendingResumes = new Set<string>();
  readonly #unregisterSentOnBinding = new Set<string>();
  readonly #unregisterHeartbeatConfirmations = new Set<string>();
  #unregisterHeartbeatExpectedAckRsids: Set<string> | null = null;
  readonly #lastContext = new Map<string, string>();
  readonly #lastContextPollAt = new Map<string, number>();
  readonly #queuedData = new Map<string, QueuedDataDraft[]>();
  readonly #sentSeq = new Map<string, number>();
  readonly #deliveryProgress = new Map<string, MutableDeliveryProgress>();
  readonly #resumeRetransmit = new Set<string>();
  readonly #inboundTasks = new Set<Promise<void>>();
  readonly #pumpChains = new Map<string, Promise<void>>();
  #lastHeartbeatSentAtMs: number;
  #lastHeartbeatAckAtMs: number;
  #heartbeatAckDeadlineAtMs: number | null = null;
  #nextHeartbeatFlightToken = 0;
  #activeHeartbeatFlightToken: number | null = null;
  #activeHeartbeatFlightBinding: GatewayBinding | null = null;
  #activeHeartbeatFlightGeneration: number | null = null;
  #heartbeatAckProcessing = false;
  #bindingGeneration = 0;
  #sessionSyncDeadlineAtMs: number | null = null;
  #heartbeatTimedOut = false;
  #connectedAtMs: number;
  #reconnectAttemptIndex = 0;
  #reconnectTask: Promise<boolean> | null = null;
  #grantedCapabilities = new Set<string>();
  #retrySuppressedFault: "auth" | "version" | "trust" | "protocol" | null = null;
  #reconnectDelayFloorMs = 0;
  #maxObservedBufferedAmount = 0;
  #bufferedAmountSampleCount = 0;
  #backpressureBlockedPumpCount = 0;
  #controlFramesSentWhileBackpressured = 0;
  #deliveryProgressTotalRecordCount = 0;
  #deliveryProgressDroppedRecordCount = 0;
  readonly #sequenceTransportEvents: SequenceTransportEvent[] = [];
  #sequenceTransportEventCount = 0;
  readonly #sequenceRenewalEvents: SequenceRenewalEvent[] = [];
  #sequenceRenewalEventCount = 0;
  #inboundError: unknown = null;
  #asyncTransportFailure: GatewayTransportError | null = null;
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
    this.#sleep = options.sleep ?? sleepUntil;
    this.#takeInboundCrashPoint = options.takeInboundCrashPoint;
    const now = this.#nowMs();
    this.#connectedAtMs = now;
    this.#lastHeartbeatSentAtMs = now;
    this.#lastHeartbeatAckAtMs = now;
    this.#applyHelloAckLimits(helloAck);
    const assumeCurrentBinding = options.unsafeAssumeCurrentBindingForTests === true;
    for (const session of simulator.registeredSessions()) {
      const registered = registeredLifecycle(session.probe.localSessionKey, session.rsid);
      const pendingUnregister = simulator.journal.getPendingSessionUnregister(session.rsid);
      if (pendingUnregister !== null) {
        this.#sessions.set(
          session.rsid,
          transitionOrThrow(registered, {
            type: "unregister",
            reason: pendingUnregister.reason,
          }),
        );
      } else if (assumeCurrentBinding) {
        this.#sessions.set(session.rsid, registered);
      } else {
        this.#sessions.set(
          session.rsid,
          transitionOrThrow(registered, { type: "connection_lost" }),
        );
      }
    }
    if (!assumeCurrentBinding && (
      simulator.registeredSessions().length > 0 ||
      simulator.journal.listPendingSessionUnregisters().length > 0
    )) {
      this.#armSessionSyncDeadline();
    }
    this.#recoverInboundReplies();
    this.#recoverDurableDeliveries();
  }

  public snapshot(nowMs = this.#nowMs()): BridgeGatewayPeerSnapshot {
    const bufferedAmount = this.#sampleBufferedAmount(this.#binding);
    return {
      bindingKind: this.#binding.kind,
      connectionId: this.#binding.connectionId,
      bufferedAmount,
      liveness: this.livenessAt(nowMs),
      lastHeartbeatAckAtMs: this.#lastHeartbeatAckAtMs,
      lastHeartbeatSentAtMs: this.#lastHeartbeatSentAtMs,
      runLoopActive: this.#runLoopActive,
      closed: this.#closed,
      sessions: [...this.#sessions.values()].map((state) => structuredClone(state)),
      pendingRegistrationCount: this.#pendingRegistrations.size,
      pendingResumeCount: this.#pendingResumes.size,
      pendingUnregisterCount: this.#simulator.journal.listPendingSessionUnregisters().length,
      queuedDataCount: [...this.#queuedData.values()].reduce((sum, queue) => sum + queue.length, 0) +
        this.#simulator.journal.pendingDurableDeliveryDraftCount(),
      sentSeqs: [...this.#sentSeq].map(([rsid, seq]) => ({ rsid, seq })),
      reconnectAttemptIndex: this.#reconnectAttemptIndex,
      heartbeatAckDeadlineAtMs: this.#heartbeatAckDeadlineAtMs,
      grantedCapabilities: [...this.#grantedCapabilities].sort(),
      retrySuppressedFault: this.#retrySuppressedFault,
      reconnectDelayFloorMs: this.#reconnectDelayFloorMs,
      backpressure: {
        evidenceVersion: 1,
        source: "transport.bufferedAmount",
        highWaterBytes: BRIDGE_OUTBOUND_HIGH_WATER_BYTES,
        currentBufferedAmount: bufferedAmount,
        maxObservedBufferedAmount: this.#maxObservedBufferedAmount,
        sampleCount: this.#bufferedAmountSampleCount,
        blockedPumpCount: this.#backpressureBlockedPumpCount,
        active: bufferedAmount > BRIDGE_OUTBOUND_HIGH_WATER_BYTES,
        controlFramesSentWhileBackpressured: this.#controlFramesSentWhileBackpressured,
      },
      deliveryProgress: {
        evidenceVersion: 1,
        capacity: MAX_DELIVERY_PROGRESS_RECORDS,
        totalRecordCount: this.#deliveryProgressTotalRecordCount,
        droppedRecordCount: this.#deliveryProgressDroppedRecordCount,
        records: [...this.#deliveryProgress.values()].map((entry) => ({ ...entry })),
      },
      sequenceTransportEvents: {
        evidenceVersion: 1,
        capacity: MAX_SEQUENCE_TRANSPORT_EVENTS,
        totalEventCount: this.#sequenceTransportEventCount,
        droppedEventCount: Math.max(
          0,
          this.#sequenceTransportEventCount - this.#sequenceTransportEvents.length,
        ),
        records: this.#sequenceTransportEvents.map((entry) => ({ ...entry })),
      },
      sequenceRenewalEvents: {
        evidenceVersion: 1,
        capacity: MAX_SEQUENCE_RENEWAL_EVENTS,
        totalEventCount: this.#sequenceRenewalEventCount,
        droppedEventCount: Math.max(
          0,
          this.#sequenceRenewalEventCount - this.#sequenceRenewalEvents.length,
        ),
        records: this.#sequenceRenewalEvents.map((entry) => ({ ...entry })),
      },
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
              this.#trackInbound(this.handleInbound(envelope, observedBinding), observedBinding);
            } else {
              await this.handleInbound(envelope, observedBinding);
            }
            if (this.#inboundError !== null) break;
          }
        } catch (error) {
          transportFailure = error;
        }
        if (this.#inboundError !== null) throw this.#inboundError;
        if (transportFailure === null && this.#asyncTransportFailure !== null) {
          transportFailure = this.#asyncTransportFailure;
        }
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
        if (reconnected) this.#asyncTransportFailure = null;
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
    return await this.#beginRegistration(input, null);
  }

  public async renewExhaustedSession(rsid: string): Promise<string> {
    this.#assertOpen();
    const session = this.#simulator.getSession(rsid);
    const lifecycle = this.#sessions.get(rsid);
    if (
      session === null ||
      lifecycle?.phase !== "registered" ||
      lifecycle.dispatchAllowed !== true
    ) {
      throw new Error(`session ${rsid} is not eligible for sequence renewal`);
    }
    if (sequenceRenewalStatus(this.#simulator.journal.loadSequence(rsid)) !== "ready_for_new_rsid") {
      throw new Error("sequence renewal requires a fully drained exhausted sender");
    }
    if (
      (this.#queuedData.get(rsid)?.length ?? 0) !== 0 ||
      this.#simulator.journal.pendingDurableDeliveryDraftCount(rsid) !== 0
    ) {
      throw new Error("sequence renewal requires no queued application data");
    }
    return await this.#beginRegistration({
      probe: session.probe,
      registration: session.registration,
    }, rsid);
  }

  async #beginRegistration(
    input: {
      readonly probe: ProbedAddinSession;
      readonly registration: SessionRegister;
    },
    renewalOldRsid: string | null,
  ): Promise<string> {
    this.#assertOpen();
    if (renewalOldRsid !== null && this.#pendingRegistrations.size !== 0) {
      throw new Error("sequence renewal requires no other pending registration");
    }
    const id = this.#id();
    let lifecycle = createSessionLifecycle(input.probe.localSessionKey);
    lifecycle = transitionOrThrow(lifecycle, { type: "register_requested" });
    this.#pendingRegistrations.set(id, { ...input, renewalOldRsid });
    this.#sessions.set(input.probe.localSessionKey, lifecycle);
    this.#armSessionSyncDeadline();
    try {
      await this.#sendControl({
        v: 1,
        type: "session_register",
        id,
        ts: this.#nowIso(),
        payload: input.registration,
      });
    } catch (error) {
      this.#pendingRegistrations.delete(id);
      this.#sessions.delete(input.probe.localSessionKey);
      this.#clearSessionSyncDeadlineIfCorrelated();
      throw error;
    }
    return id;
  }

  public async resumeAll(): Promise<void> {
    for (const pending of this.#simulator.journal.listPendingSessionUnregisters()) {
      if (pending.phase === "confirmed") {
        this.#simulator.finalizeSessionUnregister(pending.rsid);
        this.#forgetFinalizedSession(pending.rsid);
        continue;
      }
      await this.#sendPendingUnregister(pending.rsid);
    }
    for (const session of this.#simulator.registeredSessions()) {
      if (this.#simulator.journal.getPendingSessionUnregister(session.rsid) !== null) continue;
      await this.resumeSession(session.rsid);
    }
    // A cold start can contain only confirmed unregister tombstones. Their
    // cleanup completes locally and sends no resume/registration frame, so no
    // later ACK exists to clear the constructor's synchronization deadline.
    this.#clearSessionSyncDeadlineIfCorrelated();
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
    this.#armSessionSyncDeadline();
    await this.#sendControl({
      v: 1,
      type: "session_resume",
      id: this.#id(),
      ts: this.#nowIso(),
      payload: {
        rsid,
        resume_token: session.resumeToken,
        last_rx_seq: this.#simulator.journal.acknowledgeableRxSeq(rsid),
      },
    });
  }

  public async unregisterSession(
    rsid: string,
    reason: SessionUnregister["reason"],
  ): Promise<ReturnType<BridgeSimulator["unregisterSession"]>> {
    const state = this.#sessions.get(rsid);
    if (state === undefined) throw new Error(`unknown rsid: ${rsid}`);
    if (state.phase === "unregistered" && state.unregisterReason !== reason) {
      throw new Error(`session unregister reason changed for ${rsid}`);
    }
    const revokeLocal = (): void => {
      const current = this.#sessions.get(rsid);
      if (current !== undefined && current.phase !== "unregistered") {
        this.#sessions.set(rsid, transitionOrThrow(current, { type: "unregister", reason }));
      }
      this.#pendingResumes.delete(rsid);
      this.#armSessionSyncDeadline();
      this.#queuedData.delete(rsid);
      this.#sentSeq.delete(rsid);
      this.#resumeRetransmit.delete(rsid);
    };
    let decisions: ReturnType<BridgeSimulator["unregisterSession"]>;
    try {
      decisions = this.#simulator.unregisterSession(rsid, reason);
    } catch (error) {
      // COMMIT may have succeeded even when the subsequent fsync surfaced an
      // error. Re-read the tombstone: observed exact intent must revoke local
      // authority fail-closed, while an absent/different intent leaves the
      // pre-call lifecycle untouched.
      try {
        const pending = this.#simulator.journal.getPendingSessionUnregister(rsid);
        if (pending?.reason === reason) revokeLocal();
      } catch {
        // The original durability failure remains authoritative.
      }
      throw error;
    }
    revokeLocal();
    try {
      await this.#sendPendingUnregister(rsid);
    } catch (error) {
      if (!(error instanceof GatewayTransportError) || error.faultClass !== "retryable_network") {
        throw error;
      }
      this.#heartbeatTimedOut = true;
      try {
        await this.#binding.close();
      } catch {
        // Preserve the retryable send failure as the reconnect cause.
      }
      const reconnected = await this.#attemptReconnect();
      if (!reconnected && this.#reconnect === undefined) throw error;
    }
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
    deliveryCarrier: null,
    });
    await this.flushOutbound(rsid);
    return true;
  }

  public async sendHeartbeat(): Promise<void> {
    this.#assertOpen();
    // heartbeat_ack does not echo a heartbeat id. Keep exactly one heartbeat
    // in flight so the next acknowledgement has one unambiguous fence.
    if (this.#heartbeatAckDeadlineAtMs !== null || this.#heartbeatAckProcessing) return;
    const exactRsids = this.#heartbeatExactSet();
    if (exactRsids === null) return;
    const payload = await this.#simulator.heartbeat(exactRsids);
    // Registration, resume, unregister, and reconnect state can change while
    // add-in status is collected. Recheck the complete exact-set authority
    // immediately before handing the payload to the ordered transport.
    const currentExactRsids = this.#heartbeatExactSet();
    if (
      currentExactRsids === null ||
      JSON.stringify([...currentExactRsids].sort()) !== JSON.stringify([...exactRsids].sort())
    ) return;
    // Another concurrent caller may have installed a flight while this caller
    // awaited local status. Recheck in the same synchronous section that
    // installs the token so a later caller can never overwrite that flight.
    if (this.#heartbeatAckDeadlineAtMs !== null || this.#heartbeatAckProcessing) return;
    // Lifecycle state may also have changed while status was collected. Take
    // the unregister fence immediately before the send and install the whole
    // flight atomically before the first transport await. A binding is allowed
    // to deliver heartbeat_ack from inside send(), before send() resolves.
    const pendingConfirmation = this.#pendingUnregistersSentOnCurrentBinding();
    const envelope: HeartbeatEnvelope = {
      v: 1,
      type: "heartbeat",
      id: this.#id(),
      ts: this.#nowIso(),
      payload,
    };
    const previousLastHeartbeatSentAtMs = this.#lastHeartbeatSentAtMs;
    const sentAtMs = this.#nowMs();
    const flightToken = ++this.#nextHeartbeatFlightToken;
    this.#activeHeartbeatFlightToken = flightToken;
    this.#activeHeartbeatFlightBinding = this.#binding;
    this.#activeHeartbeatFlightGeneration = this.#bindingGeneration;
    this.#lastHeartbeatSentAtMs = sentAtMs;
    this.#heartbeatAckDeadlineAtMs = sentAtMs + 10_000;
    for (const rsid of pendingConfirmation) {
      this.#unregisterHeartbeatConfirmations.add(rsid);
    }
    if (pendingConfirmation.length > 0) {
      this.#unregisterHeartbeatExpectedAckRsids = new Set(exactRsids);
    }
    try {
      await this.#sendControl(envelope);
    } catch (error) {
      // Roll back only this still-current flight. If an acknowledgement was
      // delivered during send(), it already consumed the token and is the
      // authoritative processing evidence; never re-arm stale state here.
      if (this.#activeHeartbeatFlightToken === flightToken) {
        this.#activeHeartbeatFlightToken = null;
        this.#activeHeartbeatFlightBinding = null;
        this.#activeHeartbeatFlightGeneration = null;
        this.#lastHeartbeatSentAtMs = previousLastHeartbeatSentAtMs;
        this.#heartbeatAckDeadlineAtMs = null;
        this.#unregisterHeartbeatConfirmations.clear();
        this.#unregisterHeartbeatExpectedAckRsids = null;
      }
      throw error;
    }
  }

  #heartbeatExactSet(): Set<string> | null {
    if (
      this.#pendingRegistrations.size > 0 ||
      this.#pendingResumes.size > 0 ||
      (this.#reconnectTask !== null && this.#sessionSyncOutstanding())
    ) return null;
    const durableSessions = this.#simulator.registeredSessions();
    const pendingUnregisters = this.#simulator.journal.listPendingSessionUnregisters();
    if (pendingUnregisters.some((pending) => pending.phase === "confirmed")) return null;
    if (pendingUnregisters.some((pending) => !this.#unregisterSentOnBinding.has(pending.rsid))) {
      return null;
    }
    const currentBindingRsids = new Set<string>();
    for (const session of durableSessions) {
      const pending = this.#simulator.journal.getPendingSessionUnregister(session.rsid);
      if (pending !== null) {
        if (!this.#unregisterSentOnBinding.has(session.rsid)) return null;
        continue;
      }
      const state = this.#sessions.get(session.rsid);
      if (state?.phase !== "registered" || !state.dispatchAllowed) return null;
      currentBindingRsids.add(session.rsid);
    }
    return currentBindingRsids;
  }

  #armSessionSyncDeadline(): void {
    this.#sessionSyncDeadlineAtMs ??= this.#nowMs() + 10_000;
  }

  #clearSessionSyncDeadlineIfCorrelated(): void {
    if (!this.#sessionSyncOutstanding()) {
      this.#sessionSyncDeadlineAtMs = null;
    }
  }

  #sessionSyncOutstanding(): boolean {
    if (this.#pendingRegistrations.size > 0 || this.#pendingResumes.size > 0) return true;
    const durableSessions = this.#simulator.registeredSessions();
    if (this.#simulator.journal.listPendingSessionUnregisters().some(
      (pending) => pending.phase === "confirmed" || !this.#unregisterSentOnBinding.has(pending.rsid),
    )) return true;
    return durableSessions.some((session) => {
      if (this.#simulator.journal.getPendingSessionUnregister(session.rsid) !== null) {
        return !this.#unregisterSentOnBinding.has(session.rsid);
      }
      const state = this.#sessions.get(session.rsid);
      return state?.phase !== "registered" || !state.dispatchAllowed;
    });
  }

  #pendingUnregistersSentOnCurrentBinding(): string[] {
    return this.#simulator.journal.listPendingSessionUnregisters()
      .filter((pending) => pending.phase === "pending")
      .map((pending) => pending.rsid)
      .filter((rsid) => this.#unregisterSentOnBinding.has(rsid))
      .filter((rsid) => !this.#unregisterHeartbeatConfirmations.has(rsid))
      .sort();
  }

  async #sendPendingUnregister(rsid: string): Promise<void> {
    const pending = this.#simulator.journal.getPendingSessionUnregister(rsid);
    if (pending === null) throw new Error(`session ${rsid} has no pending unregister intent`);
    if (pending.phase !== "pending") {
      throw new Error(`session ${rsid} unregister is already confirmed`);
    }
    if (this.#unregisterSentOnBinding.has(rsid)) return;
    await this.#sendControl({
      v: 1,
      type: "session_unregister",
      id: this.#id(),
      ts: this.#nowIso(),
      payload: { rsid, reason: pending.reason },
    });
    this.#unregisterSentOnBinding.add(rsid);
    this.#clearSessionSyncDeadlineIfCorrelated();
    await this.sendHeartbeat();
  }

  public async tick(nowMs = this.#nowMs()): Promise<BridgePeerLiveness> {
    this.#assertOpen();
    const earliestConnectionDeadlineAtMs = [
      this.#heartbeatAckDeadlineAtMs,
      this.#sessionSyncDeadlineAtMs,
    ].reduce<number | null>((earliest, deadline) => {
      if (deadline === null) return earliest;
      return earliest === null ? deadline : Math.min(earliest, deadline);
    }, null);
    if (earliestConnectionDeadlineAtMs !== null && nowMs >= earliestConnectionDeadlineAtMs) {
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

  public async handleInbound(
    envelope: RbpEnvelope,
    originBinding: GatewayBinding = this.#binding,
  ): Promise<void> {
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
        await this.#handleHeartbeatAck(envelope, originBinding);
        return;
      case "invoke":
        await this.#handleInvoke(envelope);
        return;
      case "invoke_batch":
        await this.#handleBatch(envelope);
        return;
      case "cancel": {
        if (this.#sessions.get(envelope.rsid)?.phase === "unregistered") return;
        if (this.#sessions.get(envelope.rsid)?.dispatchAllowed !== true) {
          throw new Error(`dispatch is revoked for ${envelope.rsid}`);
        }
        if (this.#preflightInboundTransport(envelope, "cancel") === "duplicate") {
          await this.flushOutbound(envelope.rsid);
          return;
        }
        const outcome = this.#simulator.cancelEnvelope(envelope);
        if (outcome?.kind === "transport_duplicate") {
          this.#applyInboundAck(envelope);
          await this.flushOutbound(envelope.rsid);
          return;
        }
        this.#applyInboundAck(envelope);
        if (outcome === null) {
          await this.flushOutbound(envelope.rsid);
          return;
        }
        this.#stageInboundDrafts(envelope, invocationDrafts({
          invocationId: envelope.payload.invocation_id,
          mutationScope: null,
        }, outcome, this.#id, () => this.#nowIso()));
        await this.flushOutbound(envelope.rsid);
        return;
      }
      case "goodbye":
        if (envelope.payload.reason === "shutdown") {
          await this.close();
          return;
        }
        if (envelope.payload.reason === "auth_revoked") {
          this.#retrySuppressedFault = "auth";
          await this.close();
          return;
        }
        if (
          envelope.payload.reason === "update" ||
          envelope.payload.reason === "server_draining"
        ) {
          this.#reconnectDelayFloorMs = Math.max(
            this.#reconnectDelayFloorMs,
            envelope.payload.retry_after_ms ?? 0,
          );
        }
        this.#heartbeatTimedOut = true;
        this.#heartbeatAckDeadlineAtMs = null;
        await this.#binding.close();
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
    this.#closeAbort.abort();
    await this.#binding.close();
    this.#simulator.close();
  }

  public async shutdown(): Promise<void> {
    if (this.#closed) return;
    // Shutdown is terminal before the unregister handoff starts. A retryable
    // unregister send must leave its durable tombstone for the next process,
    // never enter the normal reconnect/backoff path while this process exits.
    this.#closed = true;
    this.#closeAbort.abort();
    for (const session of [...this.#simulator.registeredSessions()]) {
      try {
        await this.unregisterSession(session.rsid, "bridge_shutdown");
      } catch {
        this.#simulator.unregisterSession(session.rsid, "bridge_shutdown");
      }
    }
    await this.#binding.close();
    this.#simulator.close();
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
    if (pending.renewalOldRsid !== null) {
      const oldRsid = pending.renewalOldRsid;
      const oldSequence = this.#simulator.journal.loadSequence(oldRsid);
      const newSequence = this.#simulator.journal.loadSequence(session.rsid);
      if (
        oldSequence.outbox.length !== 0 ||
        newSequence.nextTxSeq !== 1 ||
        newSequence.highestTxSeq !== 0
      ) {
        throw new Error("sequence renewal boundary state is not exact");
      }
      this.#simulator.retireSequenceRenewedSession(oldRsid, session.rsid);
      this.#forgetFinalizedSession(oldRsid);
      this.#recordSequenceRenewalEvent({
        ordinal: this.#sequenceRenewalEventCount + 1,
        observedAtMs: this.#nowMs(),
        reason: "sequence_exhaustion",
        oldRsid,
        newRsid: session.rsid,
        oldHighestTxSeq: oldSequence.highestTxSeq,
        oldLastPeerAck: oldSequence.lastPeerAck,
        oldOutboxCount: 0,
        newInitialNextTxSeq: 1,
      });
    }
    this.#clearSessionSyncDeadlineIfCorrelated();
    await this.pollDocumentContext(session.rsid, true);
  }

  async #handleResumeAck(envelope: ResumeAckEnvelope): Promise<void> {
    const rsid = envelope.payload.rsid;
    if (
      this.#sessions.get(rsid)?.phase === "unregistered" ||
      this.#simulator.getSession(rsid) === null
    ) {
      this.#pendingResumes.delete(rsid);
      this.#clearSessionSyncDeadlineIfCorrelated();
      return;
    }
    if (!this.#pendingResumes.delete(rsid)) throw new Error("uncorrelated resume_ack");
    const state = this.#sessions.get(rsid);
    if (state === undefined) throw new Error("resume lifecycle is missing");
    this.#simulator.acknowledgeOutbound(rsid, envelope.payload.last_rx_seq);
    this.#sentSeq.delete(rsid);
    this.#simulator.updateResumeExpiry(rsid, envelope.payload.resume_expires_at);
    this.#sessions.set(rsid, transitionOrThrow(state, { type: "resumed" }));
    this.#resumeRetransmit.add(rsid);
    this.#clearSessionSyncDeadlineIfCorrelated();
    await this.flushOutbound(rsid);
    await this.pollDocumentContext(rsid, true);
  }

  async #handleHeartbeatAck(
    envelope: HeartbeatAckEnvelope,
    originBinding: GatewayBinding,
  ): Promise<void> {
    if (originBinding !== this.#binding) return;
    if (this.#heartbeatAckProcessing) {
      throw new Error("heartbeat_ack processing is already in progress");
    }
    // Consume one immutable flight snapshot synchronously before any flush can
    // yield. A later unregister may install another heartbeat only after this
    // handler finishes, and this ACK can finalize only its captured tombstones.
    const ownsCurrentFlight =
      this.#activeHeartbeatFlightToken !== null &&
      this.#heartbeatAckDeadlineAtMs !== null &&
      this.#activeHeartbeatFlightBinding === originBinding &&
      this.#activeHeartbeatFlightGeneration === this.#bindingGeneration;
    const capturedConfirmations = ownsCurrentFlight
      ? [...this.#unregisterHeartbeatConfirmations].sort()
      : [];
    const capturedExpectedAckRsids = ownsCurrentFlight
      ? new Set(this.#unregisterHeartbeatExpectedAckRsids ?? [])
      : new Set<string>();
    if (ownsCurrentFlight) {
      this.#activeHeartbeatFlightToken = null;
      this.#activeHeartbeatFlightBinding = null;
      this.#activeHeartbeatFlightGeneration = null;
      this.#heartbeatAckDeadlineAtMs = null;
      this.#unregisterHeartbeatConfirmations.clear();
      this.#unregisterHeartbeatExpectedAckRsids = null;
    }
    this.#heartbeatAckProcessing = true;
    try {
      if (capturedConfirmations.length > 0) {
        const expected = [...capturedExpectedAckRsids].sort();
        const actual = envelope.payload.acks.map((entry) => entry.rsid).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error("unregister fence heartbeat_ack does not match the active-session exact set");
        }
      }
      this.#lastHeartbeatAckAtMs = this.#nowMs();
      this.#heartbeatTimedOut = false;
      for (const entry of envelope.payload.acks) {
        if (
          this.#sessions.get(entry.rsid)?.phase === "unregistered" ||
          this.#simulator.getSession(entry.rsid) === null
        ) continue;
        const acknowledged = this.#simulator.acknowledgeOutbound(entry.rsid, entry.seq);
        if (acknowledged.includes(this.#sentSeq.get(entry.rsid) ?? -1)) {
          this.#sentSeq.delete(entry.rsid);
        }
        await this.flushOutbound(entry.rsid);
      }
      for (const rsid of capturedConfirmations) {
        if (!this.#unregisterSentOnBinding.has(rsid)) continue;
        this.#simulator.finalizeSessionUnregister(rsid);
        this.#unregisterSentOnBinding.delete(rsid);
        this.#forgetFinalizedSession(rsid);
      }
      this.#clearSessionSyncDeadlineIfCorrelated();
    } finally {
      this.#heartbeatAckProcessing = false;
    }
    if (this.#pendingUnregistersSentOnCurrentBinding().length > 0) {
      await this.sendHeartbeat();
    }
  }

  async #handleInvoke(envelope: InvokeEnvelope): Promise<void> {
    if (this.#sessions.get(envelope.rsid)?.phase === "unregistered") return;
    if (this.#sessions.get(envelope.rsid)?.dispatchAllowed !== true) {
      throw new Error(`dispatch is revoked for ${envelope.rsid}`);
    }
    if (this.#preflightInboundTransport(envelope, "invoke") === "duplicate") {
      const work = this.#simulator.journal.getInboundWork(envelope.rsid, envelope.seq);
      if (work?.state !== "journaled") {
        await this.flushOutbound(envelope.rsid);
        return;
      }
    }
    const crashAt = this.#takeInboundCrashPoint?.() ?? null;
    const outcome = await this.#simulator.invoke(
      envelope,
      crashAt === null ? {} : { crashAt },
    );
    if (
      this.#sessions.get(envelope.rsid)?.phase === "unregistered" ||
      this.#simulator.getSession(envelope.rsid) === null
    ) return;
    if (outcome.kind === "transport_duplicate") {
      this.#applyInboundAck(envelope);
      await this.flushOutbound(envelope.rsid);
      return;
    }
    this.#applyInboundAck(envelope);
    this.#stageInboundDrafts(
      envelope,
      invocationDrafts({
        invocationId: envelope.payload.invocation_id,
        mutationScope: envelope.payload.mutation_scope,
      }, outcome, this.#id, () => this.#nowIso()),
    );
    await this.flushOutbound(envelope.rsid);
  }

  #forgetFinalizedSession(rsid: string): void {
    this.#sessions.delete(rsid);
    this.#queuedData.delete(rsid);
    this.#sentSeq.delete(rsid);
    this.#resumeRetransmit.delete(rsid);
    this.#lastContext.delete(rsid);
    this.#lastContextPollAt.delete(rsid);
  }

  async #handleBatch(envelope: InvokeBatchEnvelope): Promise<void> {
    if (this.#sessions.get(envelope.rsid)?.phase === "unregistered") return;
    if (this.#sessions.get(envelope.rsid)?.dispatchAllowed !== true) {
      throw new Error(`dispatch is revoked for ${envelope.rsid}`);
    }
    if (this.#preflightInboundTransport(envelope, "invoke_batch") === "duplicate") {
      const work = this.#simulator.journal.getInboundWork(envelope.rsid, envelope.seq);
      if (work?.state !== "journaled") {
        await this.flushOutbound(envelope.rsid);
        return;
      }
    }
    const crashAt = this.#takeInboundCrashPoint?.() ?? null;
    const outcome = await this.#simulator.invokeBatch(
      envelope,
      crashAt === null ? {} : { crashAt },
    );
    if (
      this.#sessions.get(envelope.rsid)?.phase === "unregistered" ||
      this.#simulator.getSession(envelope.rsid) === null
    ) return;
    if (outcome.kind === "transport_duplicate") {
      this.#applyInboundAck(envelope);
      await this.flushOutbound(envelope.rsid);
      return;
    }
    this.#applyInboundAck(envelope);
    this.#stageInboundDrafts(envelope, [
      batchDraft(batchReplyContext(envelope), outcome, this.#id(), this.#nowIso()),
    ]);
    await this.flushOutbound(envelope.rsid);
  }

  #preflightInboundTransport(
    envelope: Extract<RbpEnvelope, { readonly type: "invoke" | "invoke_batch" | "cancel" }>,
    label: "invoke" | "invoke_batch" | "cancel",
  ): "accepted" | "duplicate" {
    const accepted = acceptInboundData(
      this.#simulator.journal.loadSequence(envelope.rsid),
      envelope as unknown as DataEnvelopeSnapshot,
    );
    if (accepted.kind === "gap") {
      this.#recordSequenceTransportEvent({
        ordinal: this.#sequenceTransportEventCount + 1,
        observedAtMs: this.#nowMs(),
        rsid: envelope.rsid,
        kind: "gap",
        receivedSeq: accepted.receivedSeq,
        expectedSeq: accepted.expectedSeq,
        accepted: false,
      });
      throw new Error(`${label} sequence rejected: ${accepted.kind}`);
    }
    if (accepted.kind === "protocol_fault") {
      throw new Error(`${label} sequence rejected: ${accepted.kind}`);
    }
    if (accepted.kind === "duplicate") {
      this.#recordSequenceTransportEvent({
        ordinal: this.#sequenceTransportEventCount + 1,
        observedAtMs: this.#nowMs(),
        rsid: envelope.rsid,
        kind: "duplicate",
        receivedSeq: envelope.seq,
        expectedSeq: null,
        accepted: false,
      });
      this.#simulator.persistInboundDuplicate(
        envelope as unknown as DataEnvelopeSnapshot,
      );
      this.#applyInboundAck(envelope);
    }
    return accepted.kind;
  }

  #recordSequenceTransportEvent(event: SequenceTransportEvent): void {
    this.#simulator.journal.recordSequenceBoundaryEvent(
      event.kind === "duplicate"
        ? "sequence_duplicate_observed"
        : "sequence_gap_observed",
      event.kind === "duplicate"
        ? `${event.rsid}/${event.receivedSeq}`
        : `${event.rsid}/${event.expectedSeq ?? "none"}/${event.receivedSeq}`,
      event.observedAtMs,
    );
    this.#sequenceTransportEventCount += 1;
    this.#sequenceTransportEvents.push(event);
    if (this.#sequenceTransportEvents.length > MAX_SEQUENCE_TRANSPORT_EVENTS) {
      this.#sequenceTransportEvents.shift();
    }
  }

  #recordSequenceRenewalEvent(event: SequenceRenewalEvent): void {
    this.#simulator.journal.recordSequenceBoundaryEvent(
      "sequence_renewal_completed",
      `${event.oldRsid}/${event.newRsid}/${event.oldHighestTxSeq}/${event.oldLastPeerAck}`,
      event.observedAtMs,
    );
    this.#sequenceRenewalEventCount += 1;
    this.#sequenceRenewalEvents.push(event);
    if (this.#sequenceRenewalEvents.length > MAX_SEQUENCE_RENEWAL_EVENTS) {
      this.#sequenceRenewalEvents.shift();
    }
  }

  #applyInboundAck(envelope: { readonly rsid: string; readonly ack?: number }): void {
    if (envelope.ack === undefined) return;
    this.#simulator.acknowledgeOutbound(envelope.rsid, envelope.ack);
    this.#sentSeq.delete(envelope.rsid);
  }

  #stageInboundDrafts(
    envelope: { readonly rsid: string; readonly seq: number },
    drafts: readonly QueuedDataDraft[],
  ): void {
    const work = this.#simulator.journal.getInboundWork(envelope.rsid, envelope.seq);
    if (work?.state === "no_reply") return;
    if (drafts.length === 0) {
      this.#simulator.journal.completeInboundNoReply(envelope.rsid, envelope.seq);
      return;
    }
    this.#assertDraftCapabilities(drafts);
    const terminal = drafts.at(-1) as QueuedDataDraft;
    if (drafts.slice(0, -1).some((draft) => draft.deliveryCarrier !== null)) {
      throw new Error("durable carrier metadata is permitted only on the terminal draft");
    }
    const deliveryId = terminal.deliveryCarrier === null
      ? `${envelope.rsid}/inbound/${envelope.seq}`
      : `${envelope.rsid}/${terminal.deliveryCarrier.invocationId}`;
    this.#simulator.journal.stageDurableDelivery({
      rsid: envelope.rsid,
      deliveryId,
      draftJsons: drafts.map((draft) => JSON.stringify(draft)),
      terminalOrdinal: drafts.length - 1,
      inboundSeq: envelope.seq,
    });
  }

  #enqueueMany(rsid: string, drafts: readonly QueuedDataDraft[]): void {
    this.#assertDraftCapabilities(drafts);
    const terminal = drafts.at(-1);
    if (drafts.slice(0, -1).some((draft) => draft.deliveryCarrier !== null)) {
      throw new Error("durable carrier metadata is permitted only on the terminal draft");
    }
    if (terminal?.deliveryCarrier !== null && terminal?.deliveryCarrier !== undefined) {
      this.#simulator.journal.stageDurableDelivery({
        rsid,
        deliveryId: `${rsid}/${terminal.deliveryCarrier.invocationId}`,
        draftJsons: drafts.map((draft) => JSON.stringify(draft)),
        terminalOrdinal: drafts.length - 1,
      });
      return;
    }
    for (const draft of drafts) this.#enqueueData(rsid, draft);
  }

  #enqueueData(rsid: string, draft: QueuedDataDraft): void {
    this.#assertDraftCapabilities([draft]);
    const queue = this.#queuedData.get(rsid) ?? [];
    queue.push(draft);
    this.#queuedData.set(rsid, queue);
  }

  #recoverDurableDeliveries(): void {
    for (const recovery of this.#simulator.recoverableDurableDeliveries()) {
      const drafts = invocationDrafts({
        invocationId: recovery.invocationId,
        mutationScope: recovery.mutationScope,
      }, recovery.outcome, this.#id, () => this.#nowIso());
      this.#assertDraftCapabilities(drafts);
      this.#enqueueMany(recovery.rsid, drafts);
    }
  }

  #recoverInboundReplies(): void {
    for (const recovery of this.#simulator.recoverableInboundReplies()) {
      if (recovery.type === "invoke" || recovery.type === "cancel") {
        this.#stageInboundDrafts(
          { rsid: recovery.rsid, seq: recovery.seq },
          invocationDrafts(
            parseInvocationReplyContext(recovery.contextJson),
            recovery.outcome as BridgeInvocationOutcome,
            this.#id,
            () => this.#nowIso(),
          ),
        );
        continue;
      }
      this.#stageInboundDrafts(
        { rsid: recovery.rsid, seq: recovery.seq },
        [batchDraft(
          parseBatchReplyContext(recovery.contextJson),
          recovery.outcome as BridgeBatchOutcome,
          this.#id(),
          this.#nowIso(),
        )],
      );
    }
  }

  async #pumpSession(rsid: string): Promise<void> {
    const lifecycle = this.#sessions.get(rsid);
    const binding = this.#binding;
    if (this.#closed || lifecycle?.dispatchAllowed !== true) return;
    if (this.#sampleBufferedAmount(binding) > BRIDGE_OUTBOUND_HIGH_WATER_BYTES) {
      this.#backpressureBlockedPumpCount += 1;
      return;
    }
    const sequence = this.#simulator.journal.loadSequence(rsid);
    const retained = sequence.outbox[0];
    if (retained !== undefined) {
      if (this.#sentSeq.get(rsid) === retained.envelope.seq) return;
      const envelope = this.#resumeRetransmit.delete(rsid)
        ? this.#simulator.retransmit(rsid, this.#nowIso())[0] ?? retained.envelope
        : retained.envelope;
      this.#assertOutboundEnvelopeCapabilities(envelope);
      if (!await this.#sendData(binding, envelope as unknown as RbpEnvelope)) return;
      if (
        binding !== this.#binding ||
        this.#sessions.get(rsid)?.phase === "unregistered" ||
        this.#simulator.getSession(rsid) === null
      ) return;
      this.#sentSeq.set(rsid, envelope.seq);
      return;
    }
    const durable = this.#simulator.journal.nextDurableDeliveryDraft(rsid);
    const queue = this.#queuedData.get(rsid);
    const draft = durable === null
      ? queue?.[0]
      : JSON.parse(durable.draftJson) as QueuedDataDraft;
    if (draft === undefined) return;
    this.#assertDraftCapabilities([draft]);
    if (durable === null) queue?.shift();
    if (durable === null && queue?.length === 0) this.#queuedData.delete(rsid);
    const envelope = this.#simulator.queueOutbound(
      rsid,
      { type: draft.type, id: draft.id, ts: draft.ts, payload: draft.payload },
      draft.deliveryCarrier,
      durable === null
        ? null
        : {
            deliveryId: durable.deliveryId,
            ordinal: durable.ordinal,
            draftJson: durable.draftJson,
          },
    );
    if (!validateRbpEnvelope(envelope)) {
      throw new Error(
        `Bridge created an invalid ${draft.type} data envelope: ${JSON.stringify(rbpEnvelopeErrors())}`,
      );
    }
    this.#assertOutboundEnvelopeCapabilities(envelope);
    if (!await this.#sendData(binding, envelope as unknown as RbpEnvelope)) return;
    if (
      binding !== this.#binding ||
      this.#sessions.get(rsid)?.phase === "unregistered" ||
      this.#simulator.getSession(rsid) === null
    ) return;
    this.#sentSeq.set(rsid, envelope.seq);
  }

  async #sendData(binding: GatewayBinding, envelope: RbpEnvelope): Promise<boolean> {
    if (this.#sampleBufferedAmount(binding) > BRIDGE_OUTBOUND_HIGH_WATER_BYTES) {
      this.#backpressureBlockedPumpCount += 1;
      return false;
    }
    try {
      await binding.send(envelope);
      this.#sampleBufferedAmount(binding);
      this.#recordOutboundData(envelope);
      return true;
    } catch (error) {
      if (error instanceof GatewayTransportError && error.faultClass === "retryable_network") {
        try {
          await binding.close();
        } catch {
          // Preserve the exact transport-send failure as authoritative.
        }
      }
      throw error;
    }
  }

  #sampleBufferedAmount(binding: GatewayBinding): number {
    const sampled = binding.bufferedAmount;
    if (!Number.isSafeInteger(sampled) || sampled < 0) {
      throw new Error("transport bufferedAmount must be a non-negative safe integer");
    }
    this.#bufferedAmountSampleCount += 1;
    this.#maxObservedBufferedAmount = Math.max(this.#maxObservedBufferedAmount, sampled);
    return sampled;
  }

  #recordOutboundData(envelope: RbpEnvelope): void {
    if (envelope.type !== "partial" && envelope.type !== "result") return;
    const payload = envelope.payload;
    if (payload.kind !== "progress" && payload.kind !== "chunk" && payload.kind !== "invocation") return;
    const invocationId = payload.invocation_id;
    const key = `${envelope.rsid}\u0000${invocationId}`;
    let progress = this.#deliveryProgress.get(key);
    if (progress === undefined) {
      if (this.#deliveryProgress.size >= MAX_DELIVERY_PROGRESS_RECORDS) {
        const oldest = this.#deliveryProgress.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          this.#deliveryProgress.delete(oldest);
          this.#deliveryProgressDroppedRecordCount += 1;
        }
      }
      this.#deliveryProgressTotalRecordCount += 1;
      progress = {
        rsid: envelope.rsid,
        invocationId,
        chunkFramesSent: 0,
        artifactChunkFramesSent: 0,
        resultChunkFramesSent: 0,
        progressFramesSent: 0,
        terminalFramesSent: 0,
        lastSentSeq: envelope.seq,
      };
      this.#deliveryProgress.set(key, progress);
    }
    progress.lastSentSeq = envelope.seq;
    if (envelope.type === "result") {
      progress.terminalFramesSent += 1;
      return;
    }
    if (payload.kind === "progress") {
      progress.progressFramesSent += 1;
      return;
    }
    progress.chunkFramesSent += 1;
    if (payload.stream_id === "result") {
      progress.resultChunkFramesSent += 1;
    } else {
      progress.artifactChunkFramesSent += 1;
    }
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

  #trackInbound(task: Promise<void>, originBinding: GatewayBinding): void {
    this.#inboundTasks.add(task);
    void task.catch(async (error: unknown) => {
      if (error instanceof GatewayTransportError && error.faultClass === "retryable_network") {
        if (this.#asyncTransportFailure === null) this.#asyncTransportFailure = error;
      } else if (this.#inboundError === null) {
        this.#inboundError = error;
      }
      try {
        await originBinding.close();
      } catch {
        // The original inbound error remains authoritative.
      }
    }).finally(() => this.#inboundTasks.delete(task));
  }

  #applyHelloAckLimits(
    helloAck: HelloAckEnvelope,
    bindingKind: GatewayBinding["kind"] = this.#binding.kind,
  ): void {
    if (helloAck.payload.heartbeat_interval_ms !== 15_000) {
      throw new GatewayTransportError(
        "hello_ack heartbeat_interval_ms must equal 15000",
        { faultClass: "protocol" },
      );
    }
    const granted = new Set(helloAck.payload.granted_capabilities);
    if (bindingKind === "streamable_http_sse" && !granted.has("transport_streamable_http")) {
      throw new GatewayTransportError(
        "HTTP/SSE binding requires the transport_streamable_http hello_ack grant",
        { faultClass: "protocol" },
      );
    }
    this.#simulator.applyNegotiatedLimits({
      maxParamsBytes: helloAck.payload.limits.max_params_bytes,
      maxResultBytes: helloAck.payload.limits.max_result_bytes,
      maxPartialBytes: helloAck.payload.limits.max_partial_bytes,
    });
    this.#grantedCapabilities = granted;
    this.#simulator.applyNegotiatedCapabilities([...granted]);
  }

  #assertDraftCapabilities(drafts: readonly QueuedDataDraft[]): void {
    if (
      drafts.some((draft) => draft.type === "partial") &&
      !this.#grantedCapabilities.has("chunked_results")
    ) {
      throw new GatewayTransportError(
        "partial emission requires the chunked_results hello_ack grant",
        { faultClass: "protocol" },
      );
    }
    if (
      drafts.some((draft) => draft.deliveryCarrier?.kind === "artifacts") &&
      !this.#grantedCapabilities.has("artifact_result_v1")
    ) {
      throw new GatewayTransportError(
        "artifact emission requires the artifact_result_v1 hello_ack grant",
        { faultClass: "protocol" },
      );
    }
  }

  #assertOutboundEnvelopeCapabilities(envelope: DataEnvelopeSnapshot): void {
    const payload = envelope.payload;
    const record = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (
      (envelope.type === "partial" || record.chunked === true) &&
      !this.#grantedCapabilities.has("chunked_results")
    ) {
      throw new GatewayTransportError(
        "retained chunked data requires the current chunked_results hello_ack grant",
        { faultClass: "protocol" },
      );
    }
    if (Array.isArray(record.artifacts) && !this.#grantedCapabilities.has("artifact_result_v1")) {
      throw new GatewayTransportError(
        "retained artifact data requires the current artifact_result_v1 hello_ack grant",
        { faultClass: "protocol" },
      );
    }
  }

  async #attemptReconnect(): Promise<boolean> {
    if (
      this.#closed ||
      this.#reconnect === undefined ||
      this.#retrySuppressedFault !== null
    ) return false;
    if (this.#reconnectTask !== null) return await this.#reconnectTask;
    this.#reconnectTask = (async () => {
      const attemptIndex = this.#reconnectAttemptIndex;
      const delayMs = Math.max(
        this.#simulator.reconnectDelay(attemptIndex, this.#reconnectJitter()),
        this.#reconnectDelayFloorMs,
      );
      this.#reconnectDelayFloorMs = 0;
      this.#reconnectAttemptIndex += 1;
      await this.#sleep(delayMs, this.#closeAbort.signal);
      if (this.#closed) return false;
      let nextBinding: GatewayBinding | null = null;
      try {
        const next = await this.#reconnect?.({ attemptIndex, delayMs });
        if (next === undefined) return false;
        nextBinding = next.binding;
        if (this.#closed) {
          await nextBinding.close();
          nextBinding = null;
          return false;
        }
        if (next.binding.connectionId !== next.helloAck.payload.connection_id) {
          await next.binding.close();
          nextBinding = null;
          throw new Error("reconnected Gateway binding and hello_ack ids differ");
        }
        this.#applyHelloAckLimits(next.helloAck, next.binding.kind);
        this.#binding = next.binding;
        this.#bindingGeneration += 1;
        this.#recoverInboundReplies();
        this.#recoverDurableDeliveries();
        this.#heartbeatIntervalMs = next.helloAck.payload.heartbeat_interval_ms;
        const now = this.#nowMs();
        this.#connectedAtMs = now;
        this.#lastHeartbeatSentAtMs = now;
        this.#lastHeartbeatAckAtMs = now;
        this.#activeHeartbeatFlightToken = null;
        this.#activeHeartbeatFlightBinding = null;
        this.#activeHeartbeatFlightGeneration = null;
        this.#heartbeatAckDeadlineAtMs = null;
        this.#sessionSyncDeadlineAtMs = null;
        this.#heartbeatTimedOut = false;
        this.#retrySuppressedFault = null;
        this.#sentSeq.clear();
        this.#prepareSessionsForReconnect();
        await this.#resendPendingRegistrations();
        await this.resumeAll();
        return true;
      } catch (error) {
        if (nextBinding !== null) {
          try {
            await nextBinding.close();
          } catch {
            // The retry state remains disconnected even when cleanup fails.
          }
        }
        this.#heartbeatTimedOut = true;
        if (
          error instanceof GatewayTransportError &&
          (error.faultClass === "auth" || error.faultClass === "version" ||
            error.faultClass === "trust" || error.faultClass === "protocol")
        ) {
          this.#retrySuppressedFault = error.faultClass;
          throw error;
        }
        if (error instanceof GatewayTransportError && error.retryAfterMs !== null) {
          this.#reconnectDelayFloorMs = Math.max(this.#reconnectDelayFloorMs, error.retryAfterMs);
        }
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
    this.#activeHeartbeatFlightToken = null;
    this.#activeHeartbeatFlightBinding = null;
    this.#activeHeartbeatFlightGeneration = null;
    this.#unregisterSentOnBinding.clear();
    this.#unregisterHeartbeatConfirmations.clear();
    this.#unregisterHeartbeatExpectedAckRsids = null;
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
    if (
      this.#simulator.registeredSessions().length > 0 ||
      this.#simulator.journal.listPendingSessionUnregisters().length > 0
    ) {
      this.#armSessionSyncDeadline();
    }
  }

  async #resendPendingRegistrations(): Promise<void> {
    if (this.#pendingRegistrations.size === 0) return;
    const pending = [...this.#pendingRegistrations.values()];
    this.#pendingRegistrations.clear();
    const resends = pending.map((entry) => ({ id: this.#id(), entry }));
    for (const resend of resends) this.#pendingRegistrations.set(resend.id, resend.entry);
    this.#armSessionSyncDeadline();
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
    const bufferedBefore = this.#sampleBufferedAmount(this.#binding);
    await this.#binding.send(envelope);
    this.#sampleBufferedAmount(this.#binding);
    if (bufferedBefore > BRIDGE_OUTBOUND_HIGH_WATER_BYTES) {
      this.#controlFramesSentWhileBackpressured += 1;
    }
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
