import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  acceptInboundData,
  applyCumulativeAck,
  canonicalizeJson,
  closeDispatchWindow,
  createDispatchWindowLedger,
  dataEnvelopeImmutableDigest,
  makeBatchDigest,
  makeIdempotencyKey,
  makeParamsDigest,
  openDispatchWindow,
  queueOutboundData,
  reconnectFullJitterDelayMs,
  retransmitOutbox,
  shouldResetReconnectBackoff,
  validateRbpEnvelope,
  type DataEnvelopeSnapshot,
  type DocContextUpdate,
  type DispatchWindowLedger,
  type Heartbeat,
  type HelloEnvelope,
  type InvocationJournalBinding,
  type InvokeBatchEnvelope,
  type InvokeEnvelope,
  type JsonValue,
  type MutationScope,
  type Partial as RbpPartial,
  type RbpEnvelope,
  type RecoveryClearance,
  type SessionRegister,
  type SessionUnregister,
  type TerminalJournalOutcome,
} from "@revagent/protocol";
import type { JsonObject } from "@revagent/addin-loopback-fixture";

import type {
  ArtifactSpool,
  ArtifactCarrier,
  ArtifactInput,
} from "./artifacts.js";
import type {
  DurableBridgeJournal,
  BatchInvocationDecision,
} from "./journal.js";
import {
  requestAddinSideChannel,
  type ProbedAddinSession,
  type RawAddinResponse,
} from "./loopback.js";

const INLINE_JOURNAL_PAYLOAD_BYTES = 1_048_576;
const MAX_PARAMS_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;

export type BridgeCrashPoint =
  | "after_received_before_dispatch"
  | "after_executing_before_addin_write"
  | "after_addin_response_before_terminal";

export class InjectedBridgeCrash extends Error {
  public constructor(public readonly point: BridgeCrashPoint) {
    super(`injected bridge crash: ${point}`);
  }
}

export interface RegisteredBridgeSession {
  readonly rsid: string;
  readonly resumeToken: string;
  readonly resumeExpiresAt: string;
  readonly grantedSessionCapabilities: readonly string[];
  readonly probe: ProbedAddinSession;
  readonly registration: SessionRegister;
}

export type BridgeInvocationOutcome =
  | {
      readonly kind: "result";
      readonly status: "completed" | "guarded";
      readonly result?: JsonValue;
      readonly guardedReason?: string;
      readonly replayed: boolean;
      readonly payloadOmitted: boolean;
      readonly resultDigest: string;
      readonly lateAfterIndeterminate: boolean;
      readonly verificationHoldId: string | null;
      readonly partials: readonly Extract<RbpPartial, { kind: "chunk" }>[];
      readonly artifactCarrier: ArtifactCarrier | null;
      readonly addinContacted: boolean;
    }
  | {
      readonly kind: "error";
      readonly faultClass:
        | "protocol"
        | "unsupported"
        | "environment"
        | "revit_busy"
        | "revit_timeout"
        | "revit_api"
        | "journal_indeterminate"
        | "oversize"
        | "cancelled";
      readonly retryable: boolean;
      readonly outcome: "known" | "indeterminate";
      readonly verificationRequired: boolean;
      readonly verificationHoldId: string | null;
      readonly replayed: boolean;
      readonly addinContacted: boolean;
      readonly message: string;
    };

export interface BridgeBatchOutcome {
  readonly kind: "batch" | "error";
  readonly batchId: string;
  readonly status?: "completed" | "guarded" | "failed" | "cancelled" | "indeterminate";
  readonly transactionState?: "committed" | "rolled_back" | "not_applicable" | "indeterminate";
  readonly failedStepIndex?: number | null;
  readonly steps?: readonly BridgeInvocationOutcome[];
  readonly replayed?: boolean;
  readonly faultClass?: "protocol" | "unsupported" | "journal_indeterminate";
  readonly message?: string;
  readonly verificationHoldId?: string;
  readonly mutationScope?: MutationScope;
}

interface ActiveInvocation {
  readonly rsid: string;
  readonly invocationId: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function guardedReason(result: JsonObject): string {
  const candidate = result.guardedReason ?? result.reason;
  if (typeof candidate === "string") {
    const normalized = candidate
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 64);
    if (/^[a-z][a-z0-9_]{0,63}$/u.test(normalized)) return normalized;
  }
  return "unspecified_guarded";
}

function addinOutcome(response: RawAddinResponse): {
  readonly status: "completed" | "guarded" | "failed";
  readonly result: JsonValue;
  readonly guardedReason?: string;
} {
  const message = response.message;
  if (isObject(message.error)) return { status: "failed", result: message as unknown as JsonValue };
  if (!isObject(message.result)) return { status: "failed", result: message as unknown as JsonValue };
  const result = message.result;
  if (result.guarded === true || result.state === "guarded" || result.status === "guarded") {
    return {
      status: "guarded",
      result: result as unknown as JsonValue,
      guardedReason: guardedReason(result),
    };
  }
  if (result.state === "failed" || result.status === "failed" || result.success === false) {
    return { status: "failed", result: result as unknown as JsonValue };
  }
  return { status: "completed", result: result as unknown as JsonValue };
}

function displayParams(payload: InvokeEnvelope["payload"]): JsonObject {
  if (!isObject(payload.params)) throw new Error("fixture simulator requires object add-in params");
  const params: JsonObject = structuredClone(payload.params);
  const display = payload.display;
  if (display !== undefined) {
    if (display.task_name !== undefined) params.taskName = display.task_name;
    if (display.wrapper_action !== undefined) params.wrapperAction = display.wrapper_action;
    if (display.logical_tool_name !== undefined) params.logicalToolName = display.logical_tool_name;
    if (display.parent_task_name !== undefined) params.parentTaskName = display.parent_task_name;
    if (display.parent_task_id !== undefined) params.parentTaskId = display.parent_task_id;
    if (display.suppress_task_status_window !== undefined) {
      params.suppressTaskStatusWindow = display.suppress_task_status_window;
    }
  }
  return params;
}

function normalizedDocumentContext(value: JsonObject): DocContextUpdate {
  const documents = Array.isArray(value.documents)
    ? value.documents.map((entry) => {
        if (!isObject(entry)) throw new Error("invalid cached document row");
        return {
          document_id: String(entry.documentId),
          title: String(entry.title),
          path_digest: entry.pathDigest === null ? null : String(entry.pathDigest),
          is_workshared: entry.isWorkshared === true,
          is_active: entry.isActive === true,
        };
      })
    : [];
  const rawView = value.activeView;
  const activeView = rawView === null || rawView === undefined
    ? null
    : isObject(rawView)
      ? {
          id: String(rawView.id),
          name: String(rawView.name),
          type: String(rawView.type),
          level: rawView.level === null || rawView.level === undefined ? null : String(rawView.level),
        }
      : (() => { throw new Error("invalid cached active view"); })();
  return {
    documents,
    active_document:
      value.activeDocumentId === null || value.activeDocumentId === undefined
        ? null
        : String(value.activeDocumentId),
    active_view: activeView,
    ...(typeof value.disciplineHint === "string" ? { discipline_hint: value.disciplineHint } : {}),
  };
}

function bindingFromInvoke(payload: InvokeEnvelope["payload"], rsid: string): InvocationJournalBinding {
  return {
    rsid,
    invocationId: payload.invocation_id,
    method: payload.method,
    mutating: payload.mutating,
    mutationScope: structuredClone(payload.mutation_scope),
    paramsDigest: makeParamsDigest(payload.params as JsonValue),
    policy: structuredClone(payload.policy),
    verification: structuredClone(payload.verification),
    recoveryClearances: structuredClone(payload.recovery_clearances),
  };
}

function knownError(
  faultClass: Extract<BridgeInvocationOutcome, { kind: "error" }>["faultClass"],
  message: string,
  options: { readonly retryable?: boolean; readonly replayed?: boolean; readonly addinContacted?: boolean } = {},
): BridgeInvocationOutcome {
  return {
    kind: "error",
    faultClass,
    retryable: options.retryable ?? false,
    outcome: "known",
    verificationRequired: false,
    verificationHoldId: null,
    replayed: options.replayed ?? false,
    addinContacted: options.addinContacted ?? false,
    message: message.slice(0, 240),
  };
}

function summarizeBatchOutcomes(outcomes: readonly BridgeInvocationOutcome[]): {
  readonly status: "completed" | "guarded" | "failed" | "cancelled" | "indeterminate";
  readonly failedStepIndex: number | null;
} {
  const failedStepIndex = outcomes.findIndex((outcome) =>
    outcome.kind === "error" || outcome.status !== "completed",
  );
  if (failedStepIndex < 0) return { status: "completed", failedStepIndex: null };
  const outcome = outcomes[failedStepIndex] as BridgeInvocationOutcome;
  if (outcome.kind === "result") return { status: "guarded", failedStepIndex };
  if (outcome.faultClass === "journal_indeterminate") {
    return { status: "indeterminate", failedStepIndex };
  }
  if (outcome.faultClass === "cancelled") return { status: "cancelled", failedStepIndex };
  return { status: "failed", failedStepIndex };
}

export class BridgeSimulator {
  readonly #journal: DurableBridgeJournal;
  readonly #spool: ArtifactSpool;
  readonly #sessions = new Map<string, RegisteredBridgeSession>();
  readonly #active = new Map<string, ActiveInvocation>();
  #window: DispatchWindowLedger = createDispatchWindowLedger();

  public constructor(journal: DurableBridgeJournal, spool: ArtifactSpool) {
    this.#journal = journal;
    this.#spool = spool;
  }

  public get journal(): DurableBridgeJournal {
    return this.#journal;
  }

  public buildHello(input: {
    readonly id: string;
    readonly ts: string;
    readonly bridgeVersion: string;
    readonly deviceId: string;
    readonly hostname: string;
    readonly os: string;
    readonly fingerprint?: string;
  }): HelloEnvelope {
    const addinVersions = [...new Set([...this.#sessions.values()].map((entry) => entry.probe.addinVersion))];
    return {
      type: "hello",
      id: input.id,
      ts: input.ts,
      payload: {
        min_protocol: 1,
        max_protocol: 1,
        capabilities: [
          "journal_v1",
          "chunked_results",
          "artifact_result_v1",
          "transport_streamable_http",
        ],
        bridge_version: input.bridgeVersion,
        device_id: input.deviceId,
        machine: {
          hostname: input.hostname,
          os: input.os,
          ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
        },
        addin_versions: addinVersions,
      },
    };
  }

  public async registrationForProbe(input: {
    readonly probe: ProbedAddinSession;
    readonly requestId: string;
    readonly userHint: string;
    readonly hostname: string;
    readonly fingerprint: string;
    readonly bridgeVersion: string;
  }): Promise<SessionRegister> {
    const response = await requestAddinSideChannel(
      input.probe,
      input.requestId,
      "get_document_context",
    );
    if (!isObject(response.message.result)) throw new Error("get_document_context probe failed");
    const context = normalizedDocumentContext(response.message.result);
    return {
      local_session_key: input.probe.localSessionKey,
      user_hint: { name: input.userHint },
      machine: { hostname: input.hostname, fingerprint: input.fingerprint },
      revit: {
        version: input.probe.revit.version,
        build: input.probe.revit.build,
        pid: input.probe.revit.processId,
      },
      addin_version: input.probe.addinVersion,
      result_contract_version: input.probe.resultContractVersion,
      session_capabilities: [...input.probe.sessionCapabilities],
      bridge_version: input.bridgeVersion,
      documents: context.documents,
      port: input.probe.target.port,
    };
  }

  public attachSession(input: {
    readonly rsid: string;
    readonly resumeToken: string;
    readonly resumeExpiresAt: string;
    readonly grantedSessionCapabilities: readonly string[];
    readonly probe: ProbedAddinSession;
    readonly registration: SessionRegister;
  }): RegisteredBridgeSession {
    if (this.#sessions.has(input.rsid)) throw new Error(`duplicate rsid: ${input.rsid}`);
    const granted = [...new Set(input.grantedSessionCapabilities)].sort();
    if (granted.some((capability) => !input.probe.sessionCapabilities.includes(
      capability as "batch_atomic" | "doc_context_cached_v1",
    ))) {
      throw new Error("Gateway granted a session capability the add-in did not prove");
    }
    const session: RegisteredBridgeSession = {
      rsid: input.rsid,
      resumeToken: input.resumeToken,
      resumeExpiresAt: input.resumeExpiresAt,
      grantedSessionCapabilities: granted,
      probe: input.probe,
      registration: structuredClone(input.registration),
    };
    this.#sessions.set(input.rsid, session);
    return session;
  }

  public registeredSessions(): readonly RegisteredBridgeSession[] {
    return [...this.#sessions.values()];
  }

  public getSession(rsid: string): RegisteredBridgeSession | null {
    return this.#sessions.get(rsid) ?? null;
  }

  public updateResumeExpiry(rsid: string, resumeExpiresAt: string): RegisteredBridgeSession {
    const current = this.#sessions.get(rsid);
    if (current === undefined) throw new Error(`unknown rsid: ${rsid}`);
    const updated = { ...current, resumeExpiresAt };
    this.#sessions.set(rsid, updated);
    return updated;
  }

  public async documentContext(rsid: string, requestId: string): Promise<DocContextUpdate> {
    const session = this.#sessions.get(rsid);
    if (session === undefined) throw new Error(`unknown rsid: ${rsid}`);
    if (!session.grantedSessionCapabilities.includes("doc_context_cached_v1")) {
      throw new Error("doc_context_cached_v1 is not granted for this session");
    }
    const response = await requestAddinSideChannel(
      session.probe,
      requestId,
      "get_document_context",
    );
    if (!isObject(response.message.result)) throw new Error("get_document_context probe failed");
    return normalizedDocumentContext(response.message.result);
  }

  public unregisterSession(
    rsid: string,
    _reason: SessionUnregister["reason"],
  ): ReturnType<DurableBridgeJournal["unregisterSession"]> {
    void _reason;
    const session = this.#sessions.get(rsid);
    if (session === undefined) return [];
    const decisions = this.#journal.unregisterSession(rsid);
    this.#sessions.delete(rsid);
    session.probe.client.close();
    return decisions;
  }

  public async invoke(
    envelope: InvokeEnvelope,
    options: { readonly crashAt?: BridgeCrashPoint } = {},
  ): Promise<BridgeInvocationOutcome> {
    if (!validateRbpEnvelope(envelope) || envelope.type !== "invoke") {
      return knownError("protocol", "invalid invoke envelope");
    }
    const session = this.#sessions.get(envelope.rsid);
    if (session === undefined) return knownError("protocol", "invoke targets an unregistered rsid");
    const computedParamsDigest = makeParamsDigest(envelope.payload.params as JsonValue);
    const transmittedParamsDigest = envelope.payload.params_digest;
    if (
      transmittedParamsDigest !== undefined &&
      (typeof transmittedParamsDigest !== "string" || transmittedParamsDigest !== computedParamsDigest)
    ) {
      return knownError("protocol", "transmitted params_digest does not match RFC 8785 params bytes");
    }
    const paramsBytes = Buffer.byteLength(canonicalizeJson(envelope.payload.params as JsonValue), "utf8");
    if (paramsBytes > MAX_PARAMS_BYTES) return knownError("oversize", "params exceed 4 MiB");

    const sequence = this.acceptInboundEnvelope(envelope as unknown as DataEnvelopeSnapshot);
    if (sequence.kind === "protocol_fault" || sequence.kind === "gap") {
      return knownError("protocol", `inbound sequence rejected: ${sequence.kind}`);
    }
    const binding = bindingFromInvoke(envelope.payload, envelope.rsid);
    const dispatchIdentity = dataEnvelopeImmutableDigest(envelope as unknown as DataEnvelopeSnapshot);
    let accepted;
    try {
      accepted = this.#journal.acceptInvocation(binding, dispatchIdentity);
    } catch (error) {
      return knownError("protocol", error instanceof Error ? error.message : String(error));
    }

    if (accepted.kind === "blocked") {
      const hold = accepted.holds[0];
      return {
        kind: "error",
        faultClass: "journal_indeterminate",
        retryable: false,
        outcome: "indeterminate",
        verificationRequired: true,
        verificationHoldId: hold?.holdId ?? null,
        replayed: false,
        addinContacted: false,
        message: "conflicting mutation recovery hold is active",
      };
    }
    if (accepted.kind === "protocol_fault") return knownError("protocol", accepted.reason);
    if (accepted.kind === "replay_terminal") {
      return this.#replayOutcome(accepted.outcome, false, accepted.record.verificationHoldId);
    }
    if (accepted.kind === "replay_late_terminal") {
      return this.#replayOutcome(accepted.outcome, true, accepted.verificationHoldId);
    }
    if (
      accepted.kind === "return_indeterminate" ||
      accepted.kind === "promote_mutation_indeterminate"
    ) {
      const holdId = accepted.record.verificationHoldId;
      return {
        kind: "error",
        faultClass: "journal_indeterminate",
        retryable: false,
        outcome: "indeterminate",
        verificationRequired: true,
        verificationHoldId: holdId,
        replayed: true,
        addinContacted: false,
        message: "mutation outcome is indeterminate; verification is required",
      };
    }
    if (accepted.kind === "read_recovery_already_consumed") {
      return knownError("environment", "read recovery was already consumed", {
        replayed: true,
        retryable: false,
      });
    }

    const invocationId = envelope.payload.invocation_id;
    const opened = openDispatchWindow(this.#window, {
      rsid: envelope.rsid,
      invocationId,
      kind: "invoke",
    });
    if (opened.kind === "protocol_fault") {
      return knownError("protocol", "per-session dispatch window is occupied");
    }
    this.#window = opened.ledger;
    this.#active.set(envelope.rsid, { rsid: envelope.rsid, invocationId });
    try {
      if (options.crashAt === "after_received_before_dispatch") {
        throw new InjectedBridgeCrash(options.crashAt);
      }
      if (accepted.kind === "accepted") this.#journal.markExecuting(envelope.rsid, invocationId);
      if (options.crashAt === "after_executing_before_addin_write") {
        throw new InjectedBridgeCrash(options.crashAt);
      }
      let response: RawAddinResponse;
      try {
        response = await session.probe.client.request(
          invocationId,
          envelope.payload.method,
          displayParams(envelope.payload),
          envelope.payload.timeout_ms,
          envelope.payload.mutating
            ? (lateResponse) => this.#recordLateResponse(envelope, lateResponse)
            : undefined,
        );
      } catch (error) {
        if (envelope.payload.mutating) {
          const record = this.#journal.markIndeterminate(envelope.rsid, invocationId);
          return {
            kind: "error",
            faultClass: "journal_indeterminate",
            retryable: false,
            outcome: "indeterminate",
            verificationRequired: true,
            verificationHoldId: record.verificationHoldId,
            replayed: false,
            addinContacted: true,
            message: "add-in response was lost after mutation dispatch",
          };
        }
        const busy = await this.#failureStatus(session, `${invocationId}-failure-status`);
        const payload: JsonValue = {
          fault_class: busy ? "revit_busy" : "environment",
          message: error instanceof Error ? error.message.slice(0, 240) : "add-in request failed",
        };
        this.#journal.recordTerminal(envelope.rsid, invocationId, {
          status: "failed",
          payloadRetained: true,
          payload,
          ...(envelope.payload.verification === null ? {} : { resultDigest: makeParamsDigest(payload) }),
        });
        return knownError(busy ? "revit_busy" : "environment", String((payload as { message: string }).message), {
          retryable: true,
          addinContacted: true,
        });
      }
      if (options.crashAt === "after_addin_response_before_terminal") {
        throw new InjectedBridgeCrash(options.crashAt);
      }
      if (addinOutcome(response).status === "failed") {
        await this.#failureStatus(session, `${invocationId}-failure-status`);
      }
      return this.#commitResponse(session, envelope, response);
    } finally {
      this.#active.delete(envelope.rsid);
      this.#window = closeDispatchWindow(this.#window, envelope.rsid, invocationId);
    }
  }

  public async invokeBatch(envelope: InvokeBatchEnvelope): Promise<BridgeBatchOutcome> {
    if (!validateRbpEnvelope(envelope) || envelope.type !== "invoke_batch") {
      return { kind: "error", batchId: envelope.payload?.batch_id ?? "invalid", faultClass: "protocol", message: "invalid batch envelope" };
    }
    const session = this.#sessions.get(envelope.rsid);
    if (session === undefined) {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "batch targets an unregistered rsid" };
    }
    const semanticDigest = makeBatchDigest({
      atomic: envelope.payload.atomic,
      batch_id: envelope.payload.batch_id,
      recovery_clearances: envelope.payload.recovery_clearances as unknown as JsonValue[],
      steps: envelope.payload.steps.map((step) => ({
        invocation_id: step.invocation_id,
        method: step.method,
        mutating: step.mutating,
        mutation_scope: step.mutation_scope as unknown as JsonValue,
        params_digest: step.params_digest,
        policy: {
          class: step.policy.class,
          confirmation_id: step.policy.confirmation_id,
          decision: step.policy.decision,
        },
      })),
      timeout_ms: envelope.payload.timeout_ms,
    });
    if (semanticDigest !== envelope.payload.batch_digest) {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "batch digest mismatch" };
    }
    for (const step of envelope.payload.steps) {
      if (makeParamsDigest(step.params as JsonValue) !== step.params_digest) {
        return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "batch step params digest mismatch" };
      }
      if (!isObject(step.params)) {
        return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "add-in batch params must be objects" };
      }
    }
    if (envelope.payload.atomic && !session.grantedSessionCapabilities.includes("batch_atomic")) {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "unsupported", message: "atomic batch requires batch_atomic" };
    }
    if (envelope.payload.atomic) {
      for (const step of envelope.payload.steps) {
        const descriptor = session.probe.batchableCommands.find((entry) => entry.method === step.method);
        const expectedEffect = step.mutating ? "model_transaction" : "read_only";
        if (descriptor === undefined || descriptor.effect !== expectedEffect) {
          return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "unsupported", message: "batch method/effect was not attested by the add-in probe" };
        }
      }
    }

    const sequence = acceptInboundData(
      this.#journal.loadSequence(envelope.rsid),
      envelope as unknown as DataEnvelopeSnapshot,
    );
    if (sequence.kind === "protocol_fault" || sequence.kind === "gap") {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: `inbound batch sequence rejected: ${sequence.kind}` };
    }
    if (sequence.kind === "accepted") this.#journal.saveSequence(sequence.state);

    const dispatchIdentity = dataEnvelopeImmutableDigest(envelope as unknown as DataEnvelopeSnapshot);
    const bindingStatus = this.#journal.acceptBatchBinding({
      batchId: envelope.payload.batch_id,
      rsid: envelope.rsid,
      batchDigest: envelope.payload.batch_digest,
      bindingJson: canonicalizeJson(envelope.payload as unknown as JsonValue),
    });
    if (bindingStatus === "protocol_fault") {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "batch binding changed on redelivery" };
    }
    const durableBatchTerminal = this.#journal.getBatchTerminal(envelope.payload.batch_id);
    if (durableBatchTerminal !== null) {
      const replay = JSON.parse(durableBatchTerminal) as BridgeBatchOutcome;
      return { ...replay, replayed: true };
    }
    const bindings: InvocationJournalBinding[] = envelope.payload.steps.map((step, index) => ({
      rsid: envelope.rsid,
      invocationId: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutationScope: structuredClone(step.mutation_scope),
      paramsDigest: step.params_digest,
      policy: structuredClone(step.policy),
      verification: null,
      recoveryClearances: [],
      batchId: envelope.payload.batch_id,
      batchIndex: index,
      batchDigest: envelope.payload.batch_digest,
    }));
    const accepted = this.#journal.acceptBatchInvocations({
      bindings,
      recoveryClearances: envelope.payload.recovery_clearances as RecoveryClearance[],
      dispatchIdentity,
    });
    if (accepted.kind === "blocked") {
      const hold = accepted.holds[0];
      if (hold === undefined) throw new Error("blocked batch omitted its mutation hold");
      return {
        kind: "error",
        batchId: envelope.payload.batch_id,
        faultClass: "journal_indeterminate",
        message: `batch mutation is held: ${hold.holdId}`,
        verificationHoldId: hold.holdId,
        mutationScope: hold.mutationScope,
      };
    }
    if (accepted.kind === "protocol_fault") {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: accepted.reason };
    }

    const outcomes: Array<BridgeInvocationOutcome | undefined> = accepted.decisions.map(
      (decision: BatchInvocationDecision): BridgeInvocationOutcome | undefined => {
        if (decision.kind === "accepted" || decision.kind === "reexecute_read") return undefined;
        if (decision.kind === "replay_terminal") {
          return this.#replayOutcome(decision.outcome, false, decision.record.verificationHoldId);
        }
        if (decision.kind === "replay_late_terminal") {
          return this.#replayOutcome(decision.outcome, true, decision.verificationHoldId);
        }
        if (decision.kind === "read_recovery_already_consumed") {
          return knownError("environment", "batch read recovery already consumed", { replayed: true });
        }
        return {
          kind: "error",
          faultClass: "journal_indeterminate",
          retryable: false,
          outcome: "indeterminate",
          verificationRequired: true,
          verificationHoldId: decision.record.verificationHoldId,
          replayed: true,
          addinContacted: false,
          message: "batch mutation outcome is indeterminate",
        };
      },
    );
    if (outcomes.every((outcome) => outcome !== undefined)) {
      const replayed = outcomes as BridgeInvocationOutcome[];
      const summary = summarizeBatchOutcomes(replayed);
      return {
        kind: "batch",
        batchId: envelope.payload.batch_id,
        status: summary.status,
        transactionState: envelope.payload.atomic
          ? summary.status === "completed" ? "committed" : summary.status === "indeterminate" ? "indeterminate" : "rolled_back"
          : "not_applicable",
        failedStepIndex: summary.failedStepIndex,
        steps: replayed,
        replayed: true,
      };
    }
    if (envelope.payload.atomic && outcomes.some((outcome) => outcome !== undefined)) {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "atomic batch has mixed terminal and dispatchable journal rows" };
    }

    const opened = openDispatchWindow(this.#window, {
      rsid: envelope.rsid,
      invocationId: envelope.payload.batch_id,
      kind: "invoke_batch",
    });
    if (opened.kind === "protocol_fault") {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "per-session dispatch window is occupied" };
    }
    this.#window = opened.ledger;
    this.#active.set(envelope.rsid, { rsid: envelope.rsid, invocationId: envelope.payload.batch_id });
    try {
      if (envelope.payload.atomic) {
        return await this.#invokeAtomicBatch(session, envelope, accepted.decisions);
      }
      return await this.#invokeNonAtomicBatch(session, envelope, accepted.decisions, outcomes, bindingStatus === "replayed");
    } finally {
      this.#active.delete(envelope.rsid);
      this.#window = closeDispatchWindow(this.#window, envelope.rsid, envelope.payload.batch_id);
    }
  }

  async #invokeNonAtomicBatch(
    session: RegisteredBridgeSession,
    envelope: InvokeBatchEnvelope,
    decisions: readonly BatchInvocationDecision[],
    initialOutcomes: Array<BridgeInvocationOutcome | undefined>,
    bindingReplayed: boolean,
  ): Promise<BridgeBatchOutcome> {
    const outcomes = [...initialOutcomes];
    let stop = false;
    for (const [index, step] of envelope.payload.steps.entries()) {
      const previous = outcomes[index];
      if (previous !== undefined) {
        if (previous.kind === "error" || previous.status !== "completed") stop = true;
        continue;
      }
      if (stop) {
        const payload: JsonValue = { batch: "successor_not_started" };
        this.#journal.recordTerminal(envelope.rsid, step.invocation_id, {
          status: "cancelled",
          payloadRetained: true,
          payload,
        });
        outcomes[index] = knownError("cancelled", "batch successor not started");
        continue;
      }
      const decision = decisions[index] as BatchInvocationDecision;
      if (decision.kind === "accepted") {
        this.#journal.markExecuting(envelope.rsid, step.invocation_id);
      }
      const stepEnvelope = this.#batchStepEnvelope(envelope, index);
      try {
        const response = await session.probe.client.request(
          step.invocation_id,
          step.method,
          step.params as JsonObject,
          envelope.payload.timeout_ms,
        );
        const outcome = this.#commitResponse(session, stepEnvelope, response);
        outcomes[index] = outcome;
        if (outcome.kind === "error" || outcome.status !== "completed") stop = true;
      } catch (error) {
        if (step.mutating) {
          const record = this.#journal.markIndeterminate(envelope.rsid, step.invocation_id);
          outcomes[index] = {
            kind: "error",
            faultClass: "journal_indeterminate",
            retryable: false,
            outcome: "indeterminate",
            verificationRequired: true,
            verificationHoldId: record.verificationHoldId,
            replayed: false,
            addinContacted: true,
            message: "batch step response lost after dispatch",
          };
        } else {
          const message = error instanceof Error ? error.message : String(error);
          const payload: JsonValue = { message: message.slice(0, 240) };
          this.#journal.recordTerminal(envelope.rsid, step.invocation_id, {
            status: "failed",
            payloadRetained: true,
            payload,
          });
          outcomes[index] = knownError("environment", message, {
            retryable: true,
            addinContacted: true,
          });
        }
        stop = true;
      }
    }
    const completed = outcomes.map((outcome) =>
      outcome ?? knownError("cancelled", "batch successor not started"),
    );
    const summary = summarizeBatchOutcomes(completed);
    const result: BridgeBatchOutcome = {
      kind: "batch",
      batchId: envelope.payload.batch_id,
      status: summary.status,
      transactionState: "not_applicable",
      failedStepIndex: summary.failedStepIndex,
      steps: completed,
      replayed: bindingReplayed && completed.every((outcome) => outcome.replayed),
    };
    this.#journal.commitBatchTerminal({
      batchId: envelope.payload.batch_id,
      rsid: envelope.rsid,
      batchDigest: envelope.payload.batch_digest,
      terminalJson: JSON.stringify(result),
    });
    return result;
  }

  async #invokeAtomicBatch(
    session: RegisteredBridgeSession,
    envelope: InvokeBatchEnvelope,
    decisions: readonly BatchInvocationDecision[],
  ): Promise<BridgeBatchOutcome> {
    this.#journal.markExecutingMany(
      decisions.flatMap((decision, index) =>
        decision.kind === "accepted"
          ? [{ rsid: envelope.rsid, invocationId: envelope.payload.steps[index]?.invocation_id as string }]
          : [],
      ),
    );
    const params: JsonObject = {
      batchContractVersion: 1,
      batchId: envelope.payload.batch_id,
      batchDigest: envelope.payload.batch_digest,
      atomic: true,
      rollbackPolicy: "rollback_on_non_success",
      steps: envelope.payload.steps.map((step, index) => ({
        index,
        invocationId: step.invocation_id,
        method: step.method,
        params: step.params as JsonObject,
        paramsDigest: step.params_digest,
        effect: step.mutating ? "model_transaction" : "read_only",
      })),
    };
    let response: RawAddinResponse;
    try {
      response = await session.probe.client.request(
        envelope.payload.batch_id,
        "execute_batch",
        params,
        envelope.payload.timeout_ms,
      );
    } catch (error) {
      return this.#atomicBatchIndeterminate(
        envelope,
        error instanceof Error ? error.message : String(error),
      );
    }
    const result = response.message.result;
    if (!isObject(result) || !Array.isArray(result.steps)) {
      return this.#atomicBatchIndeterminate(envelope, "execute_batch response omitted its result matrix");
    }
    const status = result.status;
    const transactionState = result.transactionState;
    const failedStepIndex = result.failedStepIndex;
    const outerValid =
      result.batchContractVersion === 1 &&
      result.batchId === envelope.payload.batch_id &&
      result.batchDigest === envelope.payload.batch_digest &&
      result.atomic === true &&
      result.steps.length === envelope.payload.steps.length &&
      (
        (status === "completed" && transactionState === "committed" && failedStepIndex === null) ||
        ((status === "guarded" || status === "failed") && transactionState === "rolled_back" && Number.isSafeInteger(failedStepIndex)) ||
        (status === "indeterminate" && transactionState === "indeterminate" && Number.isSafeInteger(failedStepIndex))
      );
    const rows = result.steps as JsonValue[];
    const rowsValid = outerValid && rows.every((candidate, index) => {
      if (!isObject(candidate)) return false;
      const step = envelope.payload.steps[index];
      return step !== undefined &&
        candidate.index === index &&
        candidate.invocationId === step.invocation_id &&
        candidate.method === step.method &&
        ["completed", "guarded", "failed", "not_started", "indeterminate"].includes(String(candidate.executionState)) &&
        ["read_only", "committed", "rolled_back", "discarded", "not_started", "indeterminate"].includes(String(candidate.effectState));
    });
    const failureIndex = Number.isSafeInteger(failedStepIndex) ? Number(failedStepIndex) : -1;
    const matrixValid = rowsValid && rows.every((candidate, index) => {
      const row = candidate as JsonObject;
      const step = envelope.payload.steps[index];
      if (step === undefined) return false;
      if (status === "completed") {
        return row.executionState === "completed" &&
          row.effectState === (step.mutating ? "committed" : "read_only");
      }
      if (index > failureIndex) {
        return row.executionState === "not_started" && row.effectState === "not_started";
      }
      const expectedEffect = step.mutating
        ? status === "indeterminate" ? "indeterminate" : "rolled_back"
        : "discarded";
      if (row.effectState !== expectedEffect) return false;
      if (index !== failureIndex) return row.executionState === "completed";
      if (status === "guarded") return row.executionState === "guarded";
      if (status === "failed") return row.executionState === "failed";
      return row.executionState === "guarded" || row.executionState === "failed" || row.executionState === "indeterminate";
    });
    if (!matrixValid) {
      return this.#atomicBatchIndeterminate(envelope, "execute_batch response correlation failed");
    }
    if (status === "indeterminate") {
      const possiblyMutating = envelope.payload.steps.flatMap((step, index) => {
        const row = rows[index];
        return step.mutating && isObject(row) && row.executionState !== "not_started"
          ? [{ rsid: envelope.rsid, invocationId: step.invocation_id }]
          : [];
      });
      const held = this.#journal.markIndeterminateMany(possiblyMutating);
      const heldByInvocation = new Map(held.map((record) => [record.binding.invocationId, record]));
      const knownEntries: Array<{
        invocationId: string;
        outcome: TerminalJournalOutcome;
      }> = [];
      const outcomes = envelope.payload.steps.map((step, index): BridgeInvocationOutcome => {
        const heldRecord = heldByInvocation.get(step.invocation_id);
        if (heldRecord !== undefined) {
          return {
            kind: "error",
            faultClass: "journal_indeterminate",
            retryable: false,
            outcome: "indeterminate",
            verificationRequired: true,
            verificationHoldId: heldRecord.verificationHoldId,
            replayed: false,
            addinContacted: true,
            message: "atomic batch rollback outcome is indeterminate",
          };
        }
        const row = rows[index] as JsonObject;
        const terminalStatus = row.executionState === "not_started" ? "cancelled" : "failed";
        knownEntries.push({
          invocationId: step.invocation_id,
          outcome: this.#terminalOutcome(terminalStatus, row as unknown as JsonValue, digest(response.payload)),
        });
        return knownError(
          terminalStatus === "cancelled" ? "cancelled" : "revit_api",
          terminalStatus === "cancelled" ? "atomic batch step was not started" : "atomic batch result suppressed",
          { addinContacted: true },
        );
      });
      const batch: BridgeBatchOutcome = {
        kind: "batch",
        batchId: envelope.payload.batch_id,
        status: "indeterminate",
        transactionState: "indeterminate",
        failedStepIndex: failedStepIndex as number,
        steps: outcomes,
        replayed: false,
      };
      this.#journal.commitBatchTerminal({
        batchId: envelope.payload.batch_id,
        rsid: envelope.rsid,
        batchDigest: envelope.payload.batch_digest,
        terminalJson: JSON.stringify(batch),
        steps: knownEntries,
      });
      return batch;
    }

    const rawDigest = digest(response.payload);
    const stepTerminals: Array<{ invocationId: string; outcome: TerminalJournalOutcome }> = [];
    const outcomes = envelope.payload.steps.map((step, index): BridgeInvocationOutcome => {
      const row = rows[index] as JsonObject;
      if (status === "completed") {
        stepTerminals.push({
          invocationId: step.invocation_id,
          outcome: this.#terminalOutcome("completed", row as unknown as JsonValue, rawDigest),
        });
        return {
          kind: "result",
          status: "completed",
          result: (row.result ?? null) as JsonValue,
          replayed: false,
          payloadOmitted: false,
          resultDigest: rawDigest,
          lateAfterIndeterminate: false,
          verificationHoldId: null,
          partials: [],
          artifactCarrier: null,
          addinContacted: true,
        };
      }
      const isGuarded = row.executionState === "guarded";
      const terminalStatus = isGuarded
        ? "guarded"
        : row.executionState === "not_started" ? "cancelled" : "failed";
      const reason = isGuarded ? guardedReason(row) : undefined;
      stepTerminals.push({
        invocationId: step.invocation_id,
        outcome: this.#terminalOutcome(
          terminalStatus,
          row as unknown as JsonValue,
          rawDigest,
          reason,
        ),
      });
      if (isGuarded) {
        return {
          kind: "result",
          status: "guarded",
          result: row as unknown as JsonValue,
          guardedReason: reason,
          replayed: false,
          payloadOmitted: false,
          resultDigest: rawDigest,
          lateAfterIndeterminate: false,
          verificationHoldId: null,
          partials: [],
          artifactCarrier: null,
          addinContacted: true,
        };
      }
      return knownError(
        terminalStatus === "cancelled" ? "cancelled" : "revit_api",
        terminalStatus === "cancelled" ? "atomic batch step was not started" : "atomic batch rolled back",
        { addinContacted: true },
      );
    });
    const batch: BridgeBatchOutcome = {
      kind: "batch",
      batchId: envelope.payload.batch_id,
      status: status as "completed" | "guarded" | "failed",
      transactionState: transactionState as "committed" | "rolled_back",
      failedStepIndex: failedStepIndex as number | null,
      steps: outcomes,
      replayed: false,
    };
    this.#journal.commitBatchTerminal({
      batchId: envelope.payload.batch_id,
      rsid: envelope.rsid,
      batchDigest: envelope.payload.batch_digest,
      terminalJson: JSON.stringify(batch),
      steps: stepTerminals,
    });
    return batch;
  }

  #atomicBatchIndeterminate(
    envelope: InvokeBatchEnvelope,
    message: string,
  ): BridgeBatchOutcome {
    const mutating = envelope.payload.steps
      .filter((step) => step.mutating)
      .map((step) => ({ rsid: envelope.rsid, invocationId: step.invocation_id }));
    const held = this.#journal.markIndeterminateMany(mutating);
    const heldByInvocation = new Map(held.map((record) => [record.binding.invocationId, record]));
    const readTerminals = envelope.payload.steps
      .filter((step) => !step.mutating)
      .map((step) => ({
        rsid: envelope.rsid,
        invocationId: step.invocation_id,
        outcome: {
          status: "failed" as const,
          payloadRetained: true,
          payload: { message: message.slice(0, 240) } as JsonValue,
        },
      }));
    this.#journal.recordTerminals(readTerminals);
    const outcomes = envelope.payload.steps.map((step): BridgeInvocationOutcome => {
      const record = heldByInvocation.get(step.invocation_id);
      if (record === undefined) {
        return knownError("environment", message, { retryable: true, addinContacted: true });
      }
      return {
        kind: "error",
        faultClass: "journal_indeterminate",
        retryable: false,
        outcome: "indeterminate",
        verificationRequired: true,
        verificationHoldId: record.verificationHoldId,
        replayed: false,
        addinContacted: true,
        message: "atomic batch response is not durably knowable",
      };
    });
    const firstMutation = envelope.payload.steps.findIndex((step) => step.mutating);
    const batch: BridgeBatchOutcome = {
      kind: "batch",
      batchId: envelope.payload.batch_id,
      status: firstMutation >= 0 ? "indeterminate" : "failed",
      transactionState: firstMutation >= 0 ? "indeterminate" : "rolled_back",
      failedStepIndex: firstMutation >= 0 ? firstMutation : 0,
      steps: outcomes,
      replayed: false,
    };
    this.#journal.commitBatchTerminal({
      batchId: envelope.payload.batch_id,
      rsid: envelope.rsid,
      batchDigest: envelope.payload.batch_digest,
      terminalJson: JSON.stringify(batch),
    });
    return batch;
  }

  #terminalOutcome(
    status: TerminalJournalOutcome["status"],
    payload: JsonValue,
    resultDigest: string,
    guardedReasonValue?: string,
  ): TerminalJournalOutcome {
    const retained = Buffer.byteLength(canonicalizeJson(payload), "utf8") <= INLINE_JOURNAL_PAYLOAD_BYTES;
    return {
      status,
      payloadRetained: retained,
      ...(retained ? { payload } : {}),
      resultDigest,
      ...(status === "guarded" ? { guardedReason: guardedReasonValue ?? "unspecified_guarded" } : {}),
    };
  }

  #batchStepEnvelope(envelope: InvokeBatchEnvelope, index: number): InvokeEnvelope {
    const step = envelope.payload.steps[index];
    if (step === undefined) throw new RangeError("batch step index is out of range");
    return {
      v: 1,
      type: "invoke",
      id: `${envelope.id}-step-${index}`,
      rsid: envelope.rsid,
      seq: envelope.seq,
      ...(envelope.ack === undefined ? {} : { ack: envelope.ack }),
      ts: envelope.ts,
      payload: {
        invocation_id: step.invocation_id,
        method: step.method,
        params: step.params,
        timeout_ms: envelope.payload.timeout_ms,
        mutating: step.mutating,
        mutation_scope: step.mutation_scope,
        policy: step.policy,
        verification: null,
        recovery_clearances: [],
      } as InvokeEnvelope["payload"],
    };
  }

  public cancel(rsid: string, invocationId: string): BridgeInvocationOutcome {
    const decision = this.#journal.requestCancellation(rsid, invocationId);
    if (decision.kind === "cancelled_before_dispatch") {
      return knownError("cancelled", "invocation cancelled before dispatch");
    }
    if (decision.kind === "already_terminal") {
      return knownError("cancelled", "invocation was already terminal", { replayed: true });
    }
    return knownError("cancelled", "cancellation recorded; awaiting the real add-in outcome", {
      addinContacted: true,
    });
  }

  public async heartbeat(): Promise<Heartbeat> {
    const sessions: Heartbeat["sessions"] = [];
    const acks: Heartbeat["acks"] = [];
    for (const session of this.#sessions.values()) {
      const state = this.#journal.loadSequence(session.rsid);
      acks.push({ rsid: session.rsid, seq: state.lastRxSeq });
      let activeTask: Heartbeat["sessions"][number]["revit_status"]["active_task"] = null;
      let reachable = true;
      try {
        const response = await requestAddinSideChannel(
          session.probe,
          `heartbeat-${session.rsid}`,
          "mcp_status",
        );
        const result = response.message.result;
        if (isObject(result) && isObject(result.activeTask)) {
          activeTask = {
            name: String(result.activeTask.taskName ?? result.activeTask.name ?? "active"),
            method: String(result.activeTask.method ?? "unknown"),
            elapsed_ms: Number(result.activeTask.elapsedMs ?? 0),
          };
        }
      } catch {
        reachable = false;
      }
      sessions.push({
        rsid: session.rsid,
        port: session.probe.target.port,
        revit_status: { active_task: activeTask, addin_reachable: reachable },
      });
    }
    return { bridge_version: "bridge-simulator-0.0.0", acks, sessions };
  }

  public queueOutbound(
    rsid: string,
    draft: { readonly type: string; readonly id: string; readonly ts: string; readonly payload: JsonValue },
    artifactCarrier: ArtifactCarrier | null = null,
  ): DataEnvelopeSnapshot {
    const current = this.#journal.loadSequence(rsid);
    if (current.outbox.length !== 0) {
      throw new Error("RBP/1 outbound window=1 is occupied until cumulative ack");
    }
    const queued = queueOutboundData(current, {
      v: 1,
      type: draft.type,
      id: draft.id,
      ts: draft.ts,
      payload: draft.payload,
      ack: current.lastRxSeq,
    });
    if (queued.kind !== "queued") throw new Error("sequence renewal is required");
    if (artifactCarrier === null) this.#journal.saveSequence(queued.state);
    else {
      this.#journal.saveSequenceWithArtifact(
        queued.state,
        queued.envelope.seq,
        JSON.stringify(artifactCarrier),
      );
    }
    return queued.envelope;
  }

  public acknowledgeOutbound(rsid: string, ack: number): readonly number[] {
    const result = applyCumulativeAck(this.#journal.loadSequence(rsid), ack);
    if (result.kind === "protocol_fault") throw new Error(`invalid cumulative ack: ${result.reason}`);
    this.#journal.saveSequence(result.state);
    for (const retained of this.#journal.ackedArtifactCarriers(rsid, ack)) {
      const carrier = JSON.parse(retained.carrierJson) as ArtifactCarrier;
      this.#spool.acknowledge(carrier);
      this.#journal.markArtifactCarrierCleaned(rsid, retained.seq);
    }
    return result.acknowledgedSeqs;
  }

  public retransmit(rsid: string, ts: string): readonly DataEnvelopeSnapshot[] {
    const state = this.#journal.loadSequence(rsid);
    return retransmitOutbox(state, { ack: state.lastRxSeq, ts });
  }

  public reconnectDelay(attemptIndex: number, deterministicUnit: number): number {
    return reconnectFullJitterDelayMs(attemptIndex, () => deterministicUnit);
  }

  public shouldResetReconnect(steadyDurationMs: number): boolean {
    return shouldResetReconnectBackoff(steadyDurationMs);
  }

  public close(): void {
    for (const session of this.#sessions.values()) session.probe.client.close();
    this.#sessions.clear();
  }

  public acceptInboundEnvelope(
    envelope: DataEnvelopeSnapshot,
  ): ReturnType<typeof acceptInboundData> {
    const state = this.#journal.loadSequence(envelope.rsid);
    const accepted = acceptInboundData(state, envelope);
    if (accepted.kind === "accepted") this.#journal.saveSequence(accepted.state);
    return accepted;
  }

  async #failureStatus(session: RegisteredBridgeSession, id: string): Promise<boolean> {
    try {
      const response = await requestAddinSideChannel(session.probe, id, "mcp_status");
      return isObject(response.message.result) && response.message.result.activeTask !== null;
    } catch {
      return false;
    }
  }

  #recordLateResponse(envelope: InvokeEnvelope, response: RawAddinResponse): void {
    try {
      const record = this.#journal.getInvocation(envelope.rsid, envelope.payload.invocation_id);
      if (record?.state !== "indeterminate" || !envelope.payload.mutating) return;
      const classified = addinOutcome(response);
      const resultDigest = digest(response.payload);
      const retained = response.payload.byteLength <= INLINE_JOURNAL_PAYLOAD_BYTES;
      this.#journal.recordTerminal(envelope.rsid, envelope.payload.invocation_id, {
        status: classified.status,
        payloadRetained: retained,
        ...(retained ? { payload: response.message as unknown as JsonValue } : {}),
        resultDigest,
        ...(classified.status === "guarded" ? { guardedReason: classified.guardedReason } : {}),
      });
    } catch {
      // The indeterminate hold remains authoritative if durable late capture
      // cannot complete (for example because the process is shutting down).
    }
  }

  #commitResponse(
    _session: RegisteredBridgeSession,
    envelope: InvokeEnvelope,
    response: RawAddinResponse,
  ): BridgeInvocationOutcome {
    const classified = addinOutcome(response);
    const resultDigest = digest(response.payload);
    const retained = response.payload.byteLength <= INLINE_JOURNAL_PAYLOAD_BYTES;
    const journalOutcome: TerminalJournalOutcome = {
      status: classified.status,
      payloadRetained: retained,
      ...(retained ? { payload: response.message as unknown as JsonValue } : { resultDigest }),
      ...(retained && envelope.payload.verification !== null ? { resultDigest } : {}),
      ...(classified.status === "guarded" ? { guardedReason: classified.guardedReason } : {}),
    };
    const terminal = this.#journal.recordTerminal(
      envelope.rsid,
      envelope.payload.invocation_id,
      journalOutcome,
    );
    if (terminal.abandoned) {
      return knownError("cancelled", "late add-in outcome retained after cancellation", {
        addinContacted: true,
      });
    }
    if (classified.status === "failed") {
      return knownError("revit_api", "add-in returned a failure outcome", { addinContacted: true });
    }

    const fixtureArtifacts = this.#fixtureArtifacts(classified.result);
    let artifactCarrier: ArtifactCarrier | null = null;
    let result = classified.result;
    let partials: readonly Extract<RbpPartial, { kind: "chunk" }>[] = [];
    if (fixtureArtifacts !== null) {
      artifactCarrier = this.#spool.retain(envelope.payload.invocation_id, fixtureArtifacts);
      result = { files: artifactCarrier.result.artifacts } as unknown as JsonValue;
      partials = artifactCarrier.partials;
    } else {
      const bytes = Buffer.from(canonicalizeJson(classified.result), "utf8");
      if (bytes.byteLength > MAX_RESULT_BYTES) {
        return knownError("oversize", "result exceeds 32 MiB", { addinContacted: true });
      }
      if (bytes.byteLength > INLINE_JOURNAL_PAYLOAD_BYTES) {
        const chunks: Extract<RbpPartial, { kind: "chunk" }>[] = [];
        for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += 1_048_576, chunkIndex += 1) {
          chunks.push({
            kind: "chunk",
            invocation_id: envelope.payload.invocation_id,
            stream_id: "result",
            chunk_index: chunkIndex,
            encoding: "base64",
            content_type: "application/json",
            data: bytes.subarray(offset, offset + 1_048_576).toString("base64"),
          });
        }
        partials = chunks;
      }
    }
    return {
      kind: "result",
      status: classified.status,
      result,
      ...(classified.status === "guarded" ? { guardedReason: classified.guardedReason } : {}),
      replayed: false,
      payloadOmitted: false,
      resultDigest,
      lateAfterIndeterminate: false,
      verificationHoldId: null,
      partials,
      artifactCarrier,
      addinContacted: true,
    };
  }

  #fixtureArtifacts(result: JsonValue): readonly ArtifactInput[] | null {
    if (!isObject(result) || !Array.isArray(result.files) || result.files.length === 0) return null;
    const inputs: ArtifactInput[] = [];
    for (const entry of result.files) {
      if (
        !isObject(entry) ||
        typeof entry.fileName !== "string" ||
        typeof entry.contentType !== "string" ||
        typeof entry.contentBase64 !== "string"
      ) {
        return null;
      }
      const bytes = Buffer.from(entry.contentBase64, "base64");
      if (bytes.toString("base64") !== entry.contentBase64) throw new Error("fixture artifact Base64 is not canonical");
      inputs.push({ filename: entry.fileName, contentType: entry.contentType, bytes });
    }
    return inputs;
  }

  #replayOutcome(
    outcome: TerminalJournalOutcome,
    lateAfterIndeterminate: boolean,
    verificationHoldId: string | null,
  ): BridgeInvocationOutcome {
    if (outcome.status === "failed" || outcome.status === "cancelled") {
      return knownError(outcome.status === "cancelled" ? "cancelled" : "revit_api", "terminal journal outcome replay", {
        replayed: true,
      });
    }
    if (!outcome.payloadRetained) {
      return {
        kind: "result",
        status: outcome.status,
        ...(outcome.status === "guarded" ? { guardedReason: outcome.guardedReason } : {}),
        replayed: true,
        payloadOmitted: true,
        resultDigest: outcome.resultDigest as string,
        lateAfterIndeterminate,
        verificationHoldId,
        partials: [],
        artifactCarrier: null,
        addinContacted: false,
      };
    }
    const payload = outcome.payload;
    const message = isObject(payload) ? payload : {};
    const result = isObject(message.result) ? (message.result as unknown as JsonValue) : (payload as JsonValue);
    return {
      kind: "result",
      status: outcome.status,
      result,
      ...(outcome.status === "guarded" ? { guardedReason: outcome.guardedReason } : {}),
      replayed: true,
      payloadOmitted: false,
      resultDigest: outcome.resultDigest ?? makeParamsDigest(result),
      lateAfterIndeterminate,
      verificationHoldId,
      partials: [],
      artifactCarrier: null,
      addinContacted: false,
    };
  }
}

export function buildResumeEvidence(simulator: BridgeSimulator, rsid: string, ts: string): {
  readonly lastRxSeq: number;
  readonly retransmit: readonly DataEnvelopeSnapshot[];
} {
  const state = simulator.journal.loadSequence(rsid);
  return { lastRxSeq: state.lastRxSeq, retransmit: simulator.retransmit(rsid, ts) };
}

export function batchDigestForEnvelope(envelope: InvokeBatchEnvelope): string {
  return makeBatchDigest({
    atomic: envelope.payload.atomic,
    batch_id: envelope.payload.batch_id,
    recovery_clearances: envelope.payload.recovery_clearances as unknown as JsonValue[],
    steps: envelope.payload.steps.map((step) => ({
      invocation_id: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutation_scope: step.mutation_scope as unknown as JsonValue,
      params_digest: step.params_digest,
      policy: {
        class: step.policy.class,
        confirmation_id: step.policy.confirmation_id,
        decision: step.policy.decision,
      },
    })),
    timeout_ms: envelope.payload.timeout_ms,
  });
}

export function idempotencyKeyFor(envelope: InvokeEnvelope): string {
  return makeIdempotencyKey(envelope.rsid, envelope.payload.invocation_id);
}

export function envelopeDigestFor(envelope: InvokeEnvelope | InvokeBatchEnvelope): string {
  return dataEnvelopeImmutableDigest(envelope as unknown as DataEnvelopeSnapshot);
}

export type { RbpEnvelope };
