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
import {
  BATCH_MAX_INLINE_RESULT_BYTES,
  type JsonObject,
} from "@revagent/addin-loopback-fixture";

import type {
  ArtifactSpool,
  ArtifactCarrier,
  ArtifactInput,
  ChunkedResultCarrier,
  DurableResultCarrier,
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

export interface BridgeNegotiatedLimits {
  readonly maxParamsBytes: number;
  readonly maxResultBytes: number;
  readonly maxPartialBytes: number;
}

export interface RecoverableDurableDelivery {
  readonly rsid: string;
  readonly invocationId: string;
  readonly mutationScope: InvokeEnvelope["payload"]["mutation_scope"];
  readonly outcome: Extract<BridgeInvocationOutcome, { readonly kind: "result" }>;
}

export type BridgeCrashPoint =
  | "after_received_before_dispatch"
  | "after_executing_before_addin_write"
  | "after_addin_response_before_terminal"
  | "after_non_atomic_step_terminal_before_batch_terminal";

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
      readonly resultCarrier: ChunkedResultCarrier | null;
      readonly addinContacted: boolean;
    }
  | {
      readonly kind: "error";
      readonly faultClass:
        | "protocol"
        | "auth"
        | "policy"
        | "unsupported"
        | "parameter"
        | "environment"
        | "revit_busy"
        | "revit_timeout"
        | "revit_api"
        | "addin_unreachable"
        | "journal_indeterminate"
        | "oversize"
        | "cancelled";
      readonly retryable: boolean;
      readonly outcome: "known" | "indeterminate";
      readonly verificationRequired: boolean;
      readonly verificationHoldId: string | null;
      readonly replayed: boolean;
      readonly lateAfterIndeterminate: boolean;
      readonly resultDigest: string | null;
      readonly addinContacted: boolean;
      readonly effectState?: "read_only" | "committed" | "not_committed";
      readonly message: string;
    }
  | {
      readonly kind: "not_started";
      readonly replayed: boolean;
      readonly addinContacted: false;
    };

export interface BridgeBatchOutcome {
  readonly kind: "batch" | "error";
  readonly batchId: string;
  readonly status?: "completed" | "guarded" | "failed" | "cancelled" | "indeterminate";
  readonly transactionState?: "committed" | "rolled_back" | "not_applicable" | "indeterminate";
  readonly failedStepIndex?: number | null;
  readonly steps?: readonly BridgeInvocationOutcome[];
  readonly replayed?: boolean;
  readonly faultClass?: "protocol" | "unsupported" | "journal_indeterminate" | "oversize";
  readonly message?: string;
  readonly verificationHoldId?: string;
  readonly mutationScope?: MutationScope;
}

interface ActiveInvocation {
  readonly rsid: string;
  readonly invocationId: string;
}

interface AddinFailureStatusEvidence {
  readonly state: "reachable_busy" | "reachable_idle" | "unreachable";
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

function addinFailureClass(response: RawAddinResponse): {
  readonly faultClass: Extract<BridgeInvocationOutcome, { kind: "error" }>['faultClass'];
  readonly message: string;
  readonly retryable: boolean;
} {
  const error = isObject(response.message.error) ? response.message.error : null;
  const result = isObject(response.message.result) ? response.message.result : null;
  const code = error?.code ?? (isObject(result?.error) ? result.error.code : result?.code);
  const rawMessage = error?.message ?? (isObject(result?.error) ? result.error.message : result?.message);
  const message = typeof rawMessage === "string" && rawMessage.length > 0
    ? rawMessage.slice(0, 240)
    : "add-in returned a failure outcome";
  if (code === -32601 || code === "method_not_found" || code === "unsupported_method") {
    return { faultClass: "unsupported", message, retryable: false };
  }
  if (
    code === -32700 || code === -32600 || code === -32602 ||
    code === "invalid_params" || code === "invalid_request" || code === "parse_error"
  ) {
    return { faultClass: "parameter", message, retryable: false };
  }
  if (code === "timeout" || code === "deadline_exceeded" || /\b(?:timed? ?out|deadline)\b/iu.test(message)) {
    return { faultClass: "revit_timeout", message, retryable: true };
  }
  if (code === "busy" || code === "revit_busy" || /\bbusy\b/iu.test(message)) {
    return { faultClass: "revit_busy", message, retryable: true };
  }
  return { faultClass: "revit_api", message, retryable: false };
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
  options: {
    readonly retryable?: boolean;
    readonly replayed?: boolean;
    readonly lateAfterIndeterminate?: boolean;
    readonly verificationHoldId?: string | null;
    readonly resultDigest?: string | null;
    readonly addinContacted?: boolean;
    readonly effectState?: "read_only" | "committed" | "not_committed";
  } = {},
): BridgeInvocationOutcome {
  return {
    kind: "error",
    faultClass,
    retryable: options.retryable ?? false,
    outcome: "known",
    verificationRequired: false,
    verificationHoldId: options.verificationHoldId ?? null,
    replayed: options.replayed ?? false,
    lateAfterIndeterminate: options.lateAfterIndeterminate ?? false,
    resultDigest: options.resultDigest ?? null,
    addinContacted: options.addinContacted ?? false,
    ...(options.effectState === undefined ? {} : { effectState: options.effectState }),
    message: message.slice(0, 240),
  };
}

function replayedBatchOutcome(outcome: BridgeBatchOutcome): BridgeBatchOutcome {
  if (outcome.kind !== "batch" || outcome.steps === undefined) return { ...outcome, replayed: true };
  return {
    ...outcome,
    replayed: true,
    steps: outcome.steps.map((step) => step.kind === "not_started"
      ? { ...step, replayed: false }
      : { ...step, replayed: true }),
  };
}

function summarizeBatchOutcomes(outcomes: readonly BridgeInvocationOutcome[]): {
  readonly status: "completed" | "guarded" | "failed" | "cancelled" | "indeterminate";
  readonly failedStepIndex: number | null;
} {
  const failedStepIndex = outcomes.findIndex((outcome) =>
    outcome.kind === "error" || (outcome.kind === "result" && outcome.status !== "completed"),
  );
  if (failedStepIndex < 0) return { status: "completed", failedStepIndex: null };
  const outcome = outcomes[failedStepIndex] as BridgeInvocationOutcome;
  if (outcome.kind === "result") return { status: "guarded", failedStepIndex };
  if (outcome.kind === "not_started") return { status: "failed", failedStepIndex };
  if (outcome.faultClass === "journal_indeterminate") {
    return { status: "indeterminate", failedStepIndex };
  }
  if (outcome.faultClass === "cancelled") return { status: "cancelled", failedStepIndex };
  return { status: "failed", failedStepIndex };
}

interface ValidAtomicBatchResult {
  readonly result: JsonObject;
  readonly rows: readonly JsonObject[];
  readonly status: "completed" | "guarded" | "failed" | "indeterminate";
  readonly transactionState: "committed" | "rolled_back" | "indeterminate";
  readonly failedStepIndex: number | null;
}

function owns(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasDeclaredArtifactShape(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.files) || value.files.length === 0) return false;
  return value.files.some((entry) =>
    isObject(entry) &&
    (typeof entry.path === "string" ||
      typeof entry.fileName === "string" ||
      typeof entry.contentBase64 === "string")
  );
}

function validAddinStepError(value: unknown, maxAggregateResultBytes: number): value is JsonObject {
  if (!isObject(value) || typeof value.code !== "string" || typeof value.message !== "string") return false;
  if (value.code === "rollback_failure") return false;
  if (value.code === "response_payload_limit") {
    return value.maxResponsePayloadBytes === maxAggregateResultBytes &&
      Number.isSafeInteger(value.tentativeResponsePayloadBytes) &&
      Number(value.tentativeResponsePayloadBytes) > maxAggregateResultBytes;
  }
  return value.code === "command_failure" || value.code === "revit_api" || value.code === "invalid_result";
}

function validateAtomicBatchResult(
  value: unknown,
  envelope: InvokeBatchEnvelope,
  resultContractVersion: number,
  maxAggregateResultBytes: number,
): ValidAtomicBatchResult | null {
  if (!isObject(value) || !Array.isArray(value.steps) || !isObject(value.rollback)) return null;
  if (
    Buffer.byteLength(canonicalizeJson({
      jsonrpc: "2.0",
      id: envelope.payload.batch_id,
      result: value,
    }), "utf8") > maxAggregateResultBytes
  ) return null;
  const status = value.status;
  const transactionState = value.transactionState;
  const failedStepIndex = value.failedStepIndex;
  if (
    value.resultContractVersion !== resultContractVersion ||
    value.batchContractVersion !== 1 ||
    value.batchId !== envelope.payload.batch_id ||
    value.batchDigest !== envelope.payload.batch_digest ||
    value.atomic !== true ||
    value.steps.length !== envelope.payload.steps.length ||
    !["completed", "guarded", "failed", "indeterminate"].includes(String(status))
  ) return null;
  if (
    failedStepIndex !== null &&
    (!Number.isSafeInteger(failedStepIndex) || Number(failedStepIndex) < 0 || Number(failedStepIndex) >= value.steps.length)
  ) return null;

  const rows: JsonObject[] = [];
  for (let index = 0; index < value.steps.length; index += 1) {
    const row = value.steps[index];
    const step = envelope.payload.steps[index];
    if (
      !isObject(row) || step === undefined ||
      row.index !== index || row.invocationId !== step.invocation_id || row.method !== step.method
    ) return null;
    rows.push(row);
  }
  const firstNonSuccess = rows.findIndex((row) => row.executionState !== "completed");
  const rollback = value.rollback;
  if (status === "completed") {
    if (
      transactionState !== "committed" || failedStepIndex !== null || firstNonSuccess !== -1 ||
      rollback.attempted !== false || rollback.succeeded !== null ||
      rollback.triggerStepIndex !== null || rollback.triggerState !== null || owns(rollback, "error")
    ) return null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] as JsonObject;
      const step = envelope.payload.steps[index] as InvokeBatchEnvelope["payload"]["steps"][number];
      if (
        row.effectState !== (step.mutating ? "committed" : "read_only") ||
        !owns(row, "result") || owns(row, "resultSuppressed") || owns(row, "guardedReason") || owns(row, "error")
      ) return null;
      if (
        hasDeclaredArtifactShape(row.result) ||
        Buffer.byteLength(canonicalizeJson(row.result as JsonValue), "utf8") > BATCH_MAX_INLINE_RESULT_BYTES
      ) return null;
    }
    return { result: value, rows, status: "completed", transactionState: "committed", failedStepIndex: null };
  }

  if (failedStepIndex === null) return null;
  const failureIndex = Number(failedStepIndex);
  if (firstNonSuccess !== failureIndex) return null;
  const trigger = rows[failureIndex];
  if (trigger === undefined) return null;
  const triggerState = trigger.executionState;
  if (
    rollback.attempted !== true || rollback.triggerStepIndex !== failureIndex || rollback.triggerState !== triggerState
  ) return null;
  if (status === "guarded" || status === "failed") {
    if (
      transactionState !== "rolled_back" || rollback.succeeded !== true || owns(rollback, "error") ||
      triggerState !== status
    ) return null;
  } else if (
    status !== "indeterminate" || transactionState !== "indeterminate" || rollback.succeeded !== false ||
    !isObject(rollback.error) || rollback.error.code !== "rollback_failure" ||
    typeof rollback.error.message !== "string" ||
    !["guarded", "failed", "indeterminate"].includes(String(triggerState))
  ) return null;
  if (
    status === "indeterminate" &&
    !rows.some((row, index) => envelope.payload.steps[index]?.mutating === true && row.executionState !== "not_started")
  ) return null;

  const suppression = status === "indeterminate" ? "batch_indeterminate" : "batch_rolled_back";
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as JsonObject;
    const step = envelope.payload.steps[index] as InvokeBatchEnvelope["payload"]["steps"][number];
    if (index > failureIndex) {
      if (
        row.executionState !== "not_started" || row.effectState !== "not_started" ||
        owns(row, "result") || owns(row, "resultSuppressed") || owns(row, "guardedReason") || owns(row, "error")
      ) return null;
      continue;
    }
    const expectedEffect = step.mutating
      ? status === "indeterminate" ? "indeterminate" : "rolled_back"
      : "discarded";
    if (row.effectState !== expectedEffect || row.resultSuppressed !== suppression || owns(row, "result")) return null;
    if (index < failureIndex) {
      if (row.executionState !== "completed" || owns(row, "guardedReason") || owns(row, "error")) return null;
      continue;
    }
    if (row.executionState === "guarded") {
      if (
        typeof row.guardedReason !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/u.test(row.guardedReason) ||
        owns(row, "error")
      ) return null;
    } else if (row.executionState === "failed" || row.executionState === "indeterminate") {
      if (!validAddinStepError(row.error, maxAggregateResultBytes) || owns(row, "guardedReason")) return null;
    } else {
      return null;
    }
  }
  return {
    result: value,
    rows,
    status: status as ValidAtomicBatchResult["status"],
    transactionState: transactionState as ValidAtomicBatchResult["transactionState"],
    failedStepIndex: failureIndex,
  };
}

export class BridgeSimulator {
  readonly #journal: DurableBridgeJournal;
  readonly #spool: ArtifactSpool;
  readonly #sessions = new Map<string, RegisteredBridgeSession>();
  readonly #active = new Map<string, ActiveInvocation>();
  #window: DispatchWindowLedger = createDispatchWindowLedger();
  #limits: BridgeNegotiatedLimits = {
    maxParamsBytes: MAX_PARAMS_BYTES,
    maxResultBytes: MAX_RESULT_BYTES,
    maxPartialBytes: INLINE_JOURNAL_PAYLOAD_BYTES,
  };
  #grantedConnectionCapabilities = new Set([
    "journal_v1",
    "chunked_results",
    "artifact_result_v1",
    "transport_streamable_http",
  ]);

  public constructor(journal: DurableBridgeJournal, spool: ArtifactSpool) {
    this.#journal = journal;
    this.#spool = spool;
    for (const retained of journal.deliveryCarriersNeedingExpiry()) {
      const carrier = JSON.parse(retained.carrierJson) as DurableResultCarrier;
      spool.expire(carrier);
      journal.markDeliveryCarrierExpired(retained.cleanupId);
    }
    for (const retained of journal.deliveryCarriersNeedingCleanup()) {
      const carrier = JSON.parse(retained.carrierJson) as DurableResultCarrier;
      spool.acknowledge(carrier);
      journal.markDeliveryCarrierCleaned(retained.rsid, retained.seq);
    }
    const referencedDirectories = new Set<string>();
    for (const carrierJson of journal.retainedDeliveryCarrierJsons()) {
      const carrier = JSON.parse(carrierJson) as DurableResultCarrier;
      referencedDirectories.add(carrier.retainedDirectory);
    }
    for (const record of journal.listInvocations()) {
      for (const terminal of [record.terminalOutcome, record.lateTerminalOutcome]) {
        const payload = terminal?.payload;
        if (!isObject(payload)) continue;
        for (const key of ["artifact_carrier", "result_carrier"] as const) {
          const carrier = payload[key];
          if (isObject(carrier) && typeof carrier.retainedDirectory === "string") {
            referencedDirectories.add(carrier.retainedDirectory);
          }
        }
      }
    }
    spool.reconcileOrphans(referencedDirectories);
  }

  public get journal(): DurableBridgeJournal {
    return this.#journal;
  }

  public applyNegotiatedLimits(limits: BridgeNegotiatedLimits): void {
    const values = [limits.maxParamsBytes, limits.maxResultBytes, limits.maxPartialBytes];
    if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError("negotiated Bridge limits must be positive safe integers");
    }
    if (
      limits.maxParamsBytes > MAX_PARAMS_BYTES ||
      limits.maxResultBytes > MAX_RESULT_BYTES ||
      limits.maxPartialBytes > INLINE_JOURNAL_PAYLOAD_BYTES
    ) {
      throw new RangeError("negotiated Bridge limits exceed the RBP/1 implementation caps");
    }
    this.#limits = { ...limits };
  }

  public applyNegotiatedCapabilities(capabilities: readonly string[]): void {
    this.#grantedConnectionCapabilities = new Set(capabilities);
  }

  /**
   * Rehydrates terminal artifact outcomes that were committed before their
   * sequence-independent delivery plan could be staged.  This closes the
   * process-crash window after add-in completion and before peer enqueue: the
   * inbound sequence may already be durable, so Gateway redelivery is not a
   * reliable recovery trigger.
   */
  public recoverableDurableDeliveries(): readonly RecoverableDurableDelivery[] {
    const recovered: RecoverableDurableDelivery[] = [];
    for (const record of this.#journal.listInvocations()) {
      const disposition = this.#journal.durableDeliveryDisposition(
        record.binding.rsid,
        record.binding.invocationId,
      );
      if (
        record.binding.batchId !== undefined ||
        record.terminalOutcome === null ||
        disposition !== null
      ) continue;
      const retained = record.terminalOutcome.payload;
      if (
        !isObject(retained) ||
        (!isObject(retained.artifact_carrier) && !isObject(retained.result_carrier))
      ) continue;
      const outcome = this.#replayOutcome(
        record.terminalOutcome,
        false,
        record.verificationHoldId,
        { rsid: record.binding.rsid, invocationId: record.binding.invocationId },
      );
      if (
        outcome.kind !== "result" ||
        (outcome.artifactCarrier === null && outcome.resultCarrier === null)
      ) {
        throw new Error(
          `undelivered durable carrier is unavailable for ${record.binding.rsid}/${record.binding.invocationId}`,
        );
      }
      recovered.push({
        rsid: record.binding.rsid,
        invocationId: record.binding.invocationId,
        mutationScope: record.binding.mutationScope,
        outcome,
      });
    }
    return recovered;
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
    for (const retained of this.#journal.deliveryCarriersNeedingExpiry()) {
      const carrier = JSON.parse(retained.carrierJson) as DurableResultCarrier;
      this.#spool.expire(carrier);
      this.#journal.markDeliveryCarrierExpired(retained.cleanupId);
    }
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
    const sequence = this.acceptInboundEnvelope(envelope as unknown as DataEnvelopeSnapshot);
    if (sequence.kind === "protocol_fault" || sequence.kind === "gap") {
      return knownError("protocol", `inbound sequence rejected: ${sequence.kind}`);
    }
    const computedParamsDigest = makeParamsDigest(envelope.payload.params as JsonValue);
    const transmittedParamsDigest = envelope.payload.params_digest;
    if (
      transmittedParamsDigest !== undefined &&
      (typeof transmittedParamsDigest !== "string" || transmittedParamsDigest !== computedParamsDigest)
    ) {
      return knownError("protocol", "transmitted params_digest does not match RFC 8785 params bytes");
    }
    const paramsBytes = Buffer.byteLength(canonicalizeJson(envelope.payload.params as JsonValue), "utf8");
    if (paramsBytes > this.#limits.maxParamsBytes) {
      return knownError("oversize", `params exceed negotiated ${this.#limits.maxParamsBytes} byte limit`);
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
        lateAfterIndeterminate: false,
        resultDigest: null,
        addinContacted: false,
        message: "conflicting mutation recovery hold is active",
      };
    }
    if (accepted.kind === "protocol_fault") return knownError("protocol", accepted.reason);
    if (accepted.kind === "replay_terminal") {
      return this.#replayOutcome(accepted.outcome, false, accepted.record.verificationHoldId, {
        rsid: accepted.record.binding.rsid,
        invocationId: accepted.record.binding.invocationId,
      });
    }
    if (accepted.kind === "replay_late_terminal") {
      return this.#replayOutcome(accepted.outcome, true, accepted.verificationHoldId, {
        rsid: accepted.record.binding.rsid,
        invocationId: accepted.record.binding.invocationId,
      });
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
        lateAfterIndeterminate: false,
        resultDigest: null,
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
      if (accepted.kind === "accepted") {
        this.#journal.recordTerminal(envelope.rsid, invocationId, {
          status: "failed",
          payloadRetained: true,
          payload: {
            fault_class: "protocol",
            message: "per-session dispatch window is occupied",
          },
        });
      }
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
            lateAfterIndeterminate: false,
            resultDigest: null,
            addinContacted: true,
            message: "add-in response was lost after mutation dispatch",
          };
        }
        const status = await this.#failureStatus(session, `${invocationId}-failure-status`);
        const message = error instanceof Error ? error.message.slice(0, 240) : "add-in request failed";
        const faultClass = status.state === "reachable_busy"
          ? "revit_busy"
          : status.state === "unreachable"
            ? "addin_unreachable"
            : /\b(?:timed? ?out|deadline)\b/iu.test(message)
              ? "revit_timeout"
              : "environment";
        const payload: JsonValue = {
          fault_class: faultClass,
          message,
        };
        this.#journal.recordTerminal(envelope.rsid, invocationId, {
          status: "failed",
          payloadRetained: true,
          payload,
          ...(envelope.payload.verification === null ? {} : { resultDigest: makeParamsDigest(payload) }),
        });
        return knownError(faultClass, message, {
          retryable: true,
          addinContacted: true,
        });
      }
      if (options.crashAt === "after_addin_response_before_terminal") {
        throw new InjectedBridgeCrash(options.crashAt);
      }
      const failureStatus = addinOutcome(response).status === "failed"
        ? await this.#failureStatus(session, `${invocationId}-failure-status`)
        : null;
      return this.#commitResponse(session, envelope, response, failureStatus);
    } finally {
      this.#active.delete(envelope.rsid);
      this.#window = closeDispatchWindow(this.#window, envelope.rsid, invocationId);
    }
  }

  public async invokeBatch(
    envelope: InvokeBatchEnvelope,
    options: { readonly crashAt?: BridgeCrashPoint } = {},
  ): Promise<BridgeBatchOutcome> {
    if (!validateRbpEnvelope(envelope) || envelope.type !== "invoke_batch") {
      return { kind: "error", batchId: envelope.payload?.batch_id ?? "invalid", faultClass: "protocol", message: "invalid batch envelope" };
    }
    const session = this.#sessions.get(envelope.rsid);
    if (session === undefined) {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "batch targets an unregistered rsid" };
    }
    const sequence = acceptInboundData(
      this.#journal.loadSequence(envelope.rsid),
      envelope as unknown as DataEnvelopeSnapshot,
    );
    if (sequence.kind === "protocol_fault" || sequence.kind === "gap") {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: `inbound batch sequence rejected: ${sequence.kind}` };
    }
    if (sequence.kind === "accepted") this.#journal.saveSequence(sequence.state);
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
      const paramsBytes = Buffer.byteLength(canonicalizeJson(step.params as JsonValue), "utf8");
      if (paramsBytes > this.#limits.maxParamsBytes) {
        return {
          kind: "error",
          batchId: envelope.payload.batch_id,
          faultClass: "oversize",
          message: `batch step params exceed negotiated ${this.#limits.maxParamsBytes} byte limit`,
        };
      }
    }
    if (envelope.payload.atomic && !session.grantedSessionCapabilities.includes("batch_atomic")) {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "unsupported", message: "atomic batch requires batch_atomic" };
    }
    for (const step of envelope.payload.steps) {
      const descriptor = session.probe.batchableCommands.find((entry) => entry.method === step.method);
      const expectedEffect = step.mutating ? "model_transaction" : "read_only";
      if (
        descriptor === undefined ||
        descriptor.effect !== expectedEffect ||
        descriptor.resultDelivery !== "inline_only"
      ) {
        return {
          kind: "error",
          batchId: envelope.payload.batch_id,
          faultClass: "unsupported",
          message: "batch method/effect/inline-only output was not attested by the add-in probe",
        };
      }
    }

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
      return replayedBatchOutcome(replay);
    }
    const coordination = this.#journal.getBatchCoordination(envelope.payload.batch_id);
    if (envelope.payload.atomic && coordination?.state === "indeterminate") {
      return this.#atomicBatchIndeterminate(
        envelope,
        "atomic add-in dispatch was interrupted before a durable terminal carrier",
        bindingStatus === "replayed",
      );
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
      atomic: envelope.payload.atomic,
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
        replayed: bindingStatus === "replayed",
      };
    }
    if (accepted.kind === "protocol_fault") {
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: accepted.reason };
    }

    const outcomes: Array<BridgeInvocationOutcome | undefined> = accepted.decisions.map(
      (decision: BatchInvocationDecision): BridgeInvocationOutcome | undefined => {
        if (decision.kind === "accepted" || decision.kind === "reexecute_read") return undefined;
        if (decision.kind === "replay_terminal") {
          return this.#replayOutcome(decision.outcome, false, decision.record.verificationHoldId, {
            rsid: decision.record.binding.rsid,
            invocationId: decision.record.binding.invocationId,
          });
        }
        if (decision.kind === "replay_late_terminal") {
          return this.#replayOutcome(decision.outcome, true, decision.verificationHoldId, {
            rsid: decision.record.binding.rsid,
            invocationId: decision.record.binding.invocationId,
          });
        }
        if (decision.kind === "read_recovery_already_consumed") {
          return knownError("environment", "batch read recovery already consumed", { replayed: true });
        }
        if (decision.kind === "not_started") {
          return undefined;
        }
        return {
          kind: "error",
          faultClass: "journal_indeterminate",
          retryable: false,
          outcome: "indeterminate",
          verificationRequired: true,
          verificationHoldId: decision.record.verificationHoldId,
          replayed: true,
          lateAfterIndeterminate: false,
          resultDigest: null,
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
      if (accepted.decisions.every((decision) => decision.kind === "accepted")) {
        const payload: JsonValue = {
          fault_class: "protocol",
          message: "per-session dispatch window is occupied",
        };
        this.#journal.recordTerminals(envelope.payload.steps.map((step) => ({
          rsid: envelope.rsid,
          invocationId: step.invocation_id,
          outcome: { status: "failed", payloadRetained: true, payload },
        })));
        const rejected: BridgeBatchOutcome = {
          kind: "error",
          batchId: envelope.payload.batch_id,
          faultClass: "protocol",
          message: "per-session dispatch window is occupied",
        };
        this.#journal.commitBatchTerminal({
          batchId: envelope.payload.batch_id,
          rsid: envelope.rsid,
          batchDigest: envelope.payload.batch_digest,
          terminalJson: JSON.stringify(rejected),
        });
      }
      return { kind: "error", batchId: envelope.payload.batch_id, faultClass: "protocol", message: "per-session dispatch window is occupied" };
    }
    this.#window = opened.ledger;
    this.#active.set(envelope.rsid, { rsid: envelope.rsid, invocationId: envelope.payload.batch_id });
    try {
      if (envelope.payload.atomic) {
        if (options.crashAt === "after_received_before_dispatch") {
          throw new InjectedBridgeCrash(options.crashAt);
        }
        return await this.#invokeAtomicBatch(session, envelope, accepted.decisions, options);
      }
      return await this.#invokeNonAtomicBatch(
        session,
        envelope,
        accepted.decisions,
        outcomes,
        bindingStatus === "replayed",
        dispatchIdentity,
        options,
      );
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
    dispatchIdentity: string,
    options: { readonly crashAt?: BridgeCrashPoint },
  ): Promise<BridgeBatchOutcome> {
    const outcomes = [...initialOutcomes];
    const carrierOverheadReserve = 65_536 + envelope.payload.steps.length * 2_048;
    let consumedCarrierBytes = carrierOverheadReserve + outcomes.reduce((total, outcome) => {
      if (outcome?.kind !== "result" || outcome.payloadOmitted) return total;
      return total + Buffer.byteLength(canonicalizeJson(outcome.result ?? null), "utf8");
    }, 0);
    let stop = false;
    for (const [index, step] of envelope.payload.steps.entries()) {
      const previous = outcomes[index];
      if (previous !== undefined) {
        if (
          previous.kind === "error" ||
          previous.kind === "not_started" ||
          (previous.kind === "result" && previous.status !== "completed")
        ) stop = true;
        continue;
      }
      if (stop) {
        outcomes[index] = { kind: "not_started", replayed: false, addinContacted: false };
        continue;
      }
      const decision = decisions[index] as BatchInvocationDecision;
      if (decision.kind === "accepted") {
        this.#journal.markExecuting(envelope.rsid, step.invocation_id);
      } else if (decision.kind === "not_started") {
        const binding: InvocationJournalBinding = {
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
        };
        const claimed = this.#journal.claimNonAtomicBatchSuccessor({ binding, dispatchIdentity });
        if (claimed.kind === "blocked") {
          const hold = claimed.holds[0];
          outcomes[index] = {
            kind: "error",
            faultClass: "journal_indeterminate",
            retryable: false,
            outcome: "indeterminate",
            verificationRequired: true,
            verificationHoldId: hold?.holdId ?? null,
            replayed: false,
            lateAfterIndeterminate: false,
            resultDigest: null,
            addinContacted: false,
            message: "batch successor is blocked by a mutation recovery hold",
          };
          stop = true;
          continue;
        }
        if (claimed.kind === "protocol_fault") {
          const payload: JsonValue = { fault_class: "protocol", message: claimed.reason };
          this.#journal.recordTerminal(envelope.rsid, step.invocation_id, {
            status: "failed",
            payloadRetained: true,
            payload,
          });
          outcomes[index] = knownError("protocol", claimed.reason);
          stop = true;
          continue;
        }
      }
      const stepEnvelope = this.#batchStepEnvelope(envelope, index);
      const inlineResultLimit = session.probe.batchableCommands.find(
        (entry) => entry.method === step.method,
      )?.maxInlineResultBytes;
      if (inlineResultLimit === undefined) {
        throw new Error("accepted batch step lost its inline-only descriptor");
      }
      const remainingCarrierBytes = this.#limits.maxResultBytes - consumedCarrierBytes;
      if (remainingCarrierBytes <= 0) {
        const effectState = step.mutating ? "not_committed" : "read_only";
        const message = "aggregate batch result budget was exhausted before this step dispatched";
        this.#journal.recordTerminal(envelope.rsid, step.invocation_id, {
          status: "failed",
          payloadRetained: true,
          payload: { fault_class: "protocol", message, effect_state: effectState },
        });
        outcomes[index] = knownError("protocol", message, { effectState });
        stop = true;
        continue;
      }
      let crashAfterDurableStep = false;
      try {
        const response = await session.probe.client.request(
          step.invocation_id,
          step.method,
          step.params as JsonObject,
          envelope.payload.timeout_ms,
        );
        const outcome = this.#commitResponse(
          session,
          stepEnvelope,
          response,
          null,
          "batch_inline_only",
          Math.min(inlineResultLimit, remainingCarrierBytes),
        );
        outcomes[index] = outcome;
        if (outcome.kind === "result" && !outcome.payloadOmitted) {
          consumedCarrierBytes += Buffer.byteLength(
            canonicalizeJson(outcome.result ?? null),
            "utf8",
          );
        }
        crashAfterDurableStep =
          options.crashAt === "after_non_atomic_step_terminal_before_batch_terminal" &&
          outcome.kind === "error" &&
          outcome.effectState !== undefined;
        if (outcome.kind === "error" || (outcome.kind === "result" && outcome.status !== "completed")) stop = true;
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
            lateAfterIndeterminate: false,
            resultDigest: null,
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
      if (crashAfterDurableStep) {
        throw new InjectedBridgeCrash("after_non_atomic_step_terminal_before_batch_terminal");
      }
    }
    const completed = outcomes.map((outcome) =>
      outcome ?? { kind: "not_started" as const, replayed: false, addinContacted: false as const },
    );
    const summary = summarizeBatchOutcomes(completed);
    const result: BridgeBatchOutcome = {
      kind: "batch",
      batchId: envelope.payload.batch_id,
      status: summary.status,
      transactionState: "not_applicable",
      failedStepIndex: summary.failedStepIndex,
      steps: completed,
      replayed: bindingReplayed && completed.every((outcome) =>
        outcome.kind === "not_started" || outcome.replayed
      ),
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
    _decisions: readonly BatchInvocationDecision[],
    options: { readonly crashAt?: BridgeCrashPoint },
  ): Promise<BridgeBatchOutcome> {
    this.#journal.markAtomicBatchDispatched({
      batchId: envelope.payload.batch_id,
      rsid: envelope.rsid,
      batchDigest: envelope.payload.batch_digest,
      invocationIds: envelope.payload.steps.map((step) => step.invocation_id),
    });
    if (options.crashAt === "after_executing_before_addin_write") {
      throw new InjectedBridgeCrash(options.crashAt);
    }
    const params: JsonObject = {
      batchContractVersion: 1,
      batchId: envelope.payload.batch_id,
      batchDigest: envelope.payload.batch_digest,
      atomic: true,
      rollbackPolicy: "rollback_on_non_success",
      maxAggregateResultBytes: this.#limits.maxResultBytes,
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
    if (options.crashAt === "after_addin_response_before_terminal") {
      throw new InjectedBridgeCrash(options.crashAt);
    }
    const validated = validateAtomicBatchResult(
      response.message.result,
      envelope,
      session.probe.resultContractVersion,
      this.#limits.maxResultBytes,
    );
    if (validated === null) {
      return this.#atomicBatchIndeterminate(envelope, "execute_batch response correlation failed");
    }
    const { status, transactionState, failedStepIndex, rows } = validated;
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
        const row = rows[index] as JsonObject;
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
            lateAfterIndeterminate: false,
            resultDigest: null,
            addinContacted: true,
            message: "atomic batch rollback outcome is indeterminate",
          };
        }
        if (row.executionState === "not_started") {
          knownEntries.push({
            invocationId: step.invocation_id,
            outcome: this.#terminalOutcome("cancelled", { batch: "not_started" }, digest(response.payload)),
          });
          return { kind: "not_started", replayed: false, addinContacted: false };
        }
        if (row.executionState === "completed") {
          const result = {
            execution_state: "completed",
            effect_state: String(row.effectState),
            result_suppressed: String(row.resultSuppressed),
          } as JsonValue;
          knownEntries.push({
            invocationId: step.invocation_id,
            outcome: this.#terminalOutcome("completed", result, digest(response.payload)),
          });
          return {
            kind: "result",
            status: "completed",
            result,
            replayed: false,
            payloadOmitted: false,
            resultDigest: digest(response.payload),
            lateAfterIndeterminate: false,
            verificationHoldId: null,
            partials: [],
            artifactCarrier: null,
            resultCarrier: null,
            addinContacted: true,
          };
        }
        const rowError = isObject(row.error) ? row.error : {};
        const message = typeof rowError.message === "string"
          ? rowError.message.slice(0, 240)
          : "atomic batch result suppressed";
        const errorPayload = { fault_class: "revit_api", message } as JsonValue;
        knownEntries.push({
          invocationId: step.invocation_id,
          outcome: this.#terminalOutcome("failed", errorPayload, digest(response.payload)),
        });
        return knownError("revit_api", message, { addinContacted: true });
      });
      const summary = summarizeBatchOutcomes(outcomes);
      if (summary.status !== "indeterminate" || summary.failedStepIndex === null) {
        throw new Error("atomic indeterminate mapping lost its first uncertain mutation");
      }
      const batch: BridgeBatchOutcome = {
        kind: "batch",
        batchId: envelope.payload.batch_id,
        status: "indeterminate",
        transactionState: "indeterminate",
        failedStepIndex: summary.failedStepIndex,
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
          resultCarrier: null,
          addinContacted: true,
        };
      }
      const isGuarded = row.executionState === "guarded";
      if (row.executionState === "not_started") {
        stepTerminals.push({
          invocationId: step.invocation_id,
          outcome: this.#terminalOutcome("cancelled", { batch: "not_started" }, rawDigest),
        });
        return { kind: "not_started", replayed: false, addinContacted: false };
      }
      if (index < (failedStepIndex as number)) {
        const result = {
          execution_state: "completed",
          effect_state: String(row.effectState),
          result_suppressed: String(row.resultSuppressed),
        } as JsonValue;
        stepTerminals.push({
          invocationId: step.invocation_id,
          outcome: this.#terminalOutcome("completed", result, rawDigest),
        });
        return {
          kind: "result",
          status: "completed",
          result,
          replayed: false,
          payloadOmitted: false,
          resultDigest: rawDigest,
          lateAfterIndeterminate: false,
          verificationHoldId: null,
          partials: [],
          artifactCarrier: null,
          resultCarrier: null,
          addinContacted: true,
        };
      }
      const terminalStatus = isGuarded
        ? "guarded"
        : "failed";
      const reason = isGuarded ? guardedReason(row) : undefined;
      const rowError = isObject(row.error) ? row.error : {};
      const message = typeof rowError.message === "string"
        ? rowError.message.slice(0, 240)
        : "atomic batch rolled back";
      const failureClass = rowError.code === "response_payload_limit" ? "oversize" : "revit_api";
      const terminalPayload = isGuarded
        ? row as unknown as JsonValue
        : { fault_class: failureClass, message } as JsonValue;
      stepTerminals.push({
        invocationId: step.invocation_id,
        outcome: this.#terminalOutcome(
          terminalStatus,
          terminalPayload,
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
          resultCarrier: null,
          addinContacted: true,
        };
      }
      return knownError(
        failureClass,
        message,
        { addinContacted: true },
      );
    });
    const summary = summarizeBatchOutcomes(outcomes);
    if (summary.status !== status || summary.failedStepIndex !== failedStepIndex) {
      throw new Error("atomic batch carrier mapping disagrees with the validated first non-success step");
    }
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
    replayed = false,
  ): BridgeBatchOutcome {
    const firstMutation = envelope.payload.steps.findIndex((step) => step.mutating);
    const readUnavailableMessage =
      `atomic batch read result is unavailable because the terminal carrier is unknown: ${message}`
        .slice(0, 240);
    const readFailurePayload = {
      fault_class: "environment",
      message: readUnavailableMessage,
    } as JsonValue;
    const mutatingRecords = envelope.payload.steps
      .filter((step) => step.mutating)
      .map((step) => this.#journal.getInvocation(envelope.rsid, step.invocation_id))
      .filter((record): record is NonNullable<typeof record> => record !== null);
    const promote = mutatingRecords
      .filter((record) => record.state === "received" || record.state === "executing")
      .map((record) => ({ rsid: envelope.rsid, invocationId: record.binding.invocationId }));
    const held = promote.length === 0 ? [] : this.#journal.markIndeterminateMany(promote);
    const heldByInvocation = new Map(
      [...mutatingRecords.filter((record) => record.state === "indeterminate"), ...held]
        .map((record) => [record.binding.invocationId, record]),
    );
    const readTerminals = envelope.payload.steps
      .map((step) => ({ step }))
      .filter(({ step }) => !step.mutating)
      .filter(({ step }) => {
        const record = this.#journal.getInvocation(envelope.rsid, step.invocation_id);
        return record !== null && record.terminalOutcome === null && record.state !== "indeterminate";
      })
      .map(({ step }) => ({
        invocationId: step.invocation_id,
        outcome: {
          status: "failed" as const,
          payloadRetained: true,
          payload: readFailurePayload,
        },
      }));
    const outcomes = envelope.payload.steps.map((step): BridgeInvocationOutcome => {
      const record = heldByInvocation.get(step.invocation_id);
      if (record === undefined) {
        return knownError("environment", readUnavailableMessage, {
          retryable: true,
          replayed,
          addinContacted: false,
        });
      }
      return {
        kind: "error",
        faultClass: "journal_indeterminate",
        retryable: false,
        outcome: "indeterminate",
        verificationRequired: true,
        verificationHoldId: record.verificationHoldId,
        replayed,
        lateAfterIndeterminate: false,
        resultDigest: null,
        addinContacted: true,
        message: "atomic batch response is not durably knowable",
      };
    });
    const summary = summarizeBatchOutcomes(outcomes);
    const firstMutationOutcome = firstMutation < 0 ? undefined : outcomes[firstMutation];
    if (
      summary.failedStepIndex === null ||
      (firstMutation >= 0 && firstMutationOutcome?.kind !== "error") ||
      (firstMutationOutcome?.kind === "error" && firstMutationOutcome.outcome !== "indeterminate") ||
      (firstMutation < 0 && summary.status !== "failed")
    ) throw new Error("atomic indeterminate carrier lost its unknown read or mutation state");
    const batch: BridgeBatchOutcome = {
      kind: "batch",
      batchId: envelope.payload.batch_id,
      status: firstMutation >= 0 ? "indeterminate" : "failed",
      transactionState: firstMutation >= 0 ? "indeterminate" : "rolled_back",
      failedStepIndex: summary.failedStepIndex,
      steps: outcomes,
      replayed,
    };
    this.#journal.commitBatchTerminal({
      batchId: envelope.payload.batch_id,
      rsid: envelope.rsid,
      batchDigest: envelope.payload.batch_digest,
      terminalJson: JSON.stringify(batch),
      steps: readTerminals,
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

  public cancel(rsid: string, invocationId: string): BridgeInvocationOutcome | null {
    const decision = this.#journal.requestCancellation(rsid, invocationId);
    if (decision.kind === "cancelled_before_dispatch") {
      return knownError("cancelled", "invocation cancelled before dispatch");
    }
    if (decision.kind === "already_terminal") {
      return null;
    }
    return null;
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
    deliveryCarrier: DurableResultCarrier | null = null,
    durableDeliveryDraft: {
      readonly deliveryId: string;
      readonly ordinal: number;
      readonly draftJson: string;
    } | null = null,
  ): DataEnvelopeSnapshot {
    if (deliveryCarrier !== null && deliveryCarrier.rsid !== rsid) {
      throw new Error("durable result carrier rsid does not match its outbound session");
    }
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
    if (!validateRbpEnvelope(queued.envelope as unknown as RbpEnvelope)) {
      throw new Error(`Bridge attempted to persist an invalid ${draft.type} data envelope`);
    }
    if (durableDeliveryDraft !== null) {
      this.#journal.saveSequenceAndConsumeDeliveryDraft({
        state: queued.state,
        seq: queued.envelope.seq,
        deliveryId: durableDeliveryDraft.deliveryId,
        ordinal: durableDeliveryDraft.ordinal,
        draftJson: durableDeliveryDraft.draftJson,
        ...(deliveryCarrier === null
          ? {}
          : { terminalCarrierJson: JSON.stringify(this.#spool.compact(deliveryCarrier)) }),
      });
    } else if (deliveryCarrier === null) this.#journal.saveSequence(queued.state);
    else {
      this.#journal.saveSequenceWithCarrier(
        queued.state,
        queued.envelope.seq,
        JSON.stringify(this.#spool.compact(deliveryCarrier)),
      );
    }
    return queued.envelope;
  }

  public acknowledgeOutbound(rsid: string, ack: number): readonly number[] {
    const result = applyCumulativeAck(this.#journal.loadSequence(rsid), ack);
    if (result.kind === "protocol_fault") throw new Error(`invalid cumulative ack: ${result.reason}`);
    this.#journal.saveSequence(result.state);
    for (const retained of this.#journal.ackedDeliveryCarriers(rsid, ack)) {
      const carrier = JSON.parse(retained.carrierJson) as DurableResultCarrier;
      this.#spool.acknowledge(carrier);
      this.#journal.markDeliveryCarrierCleaned(rsid, retained.seq);
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

  async #failureStatus(
    session: RegisteredBridgeSession,
    id: string,
  ): Promise<AddinFailureStatusEvidence> {
    try {
      const response = await requestAddinSideChannel(session.probe, id, "mcp_status");
      return {
        state: isObject(response.message.result) && response.message.result.activeTask !== null
          ? "reachable_busy"
          : "reachable_idle",
      };
    } catch {
      return { state: "unreachable" };
    }
  }

  #recordLateResponse(envelope: InvokeEnvelope, response: RawAddinResponse): void {
    try {
      const record = this.#journal.getInvocation(envelope.rsid, envelope.payload.invocation_id);
      if (record?.state !== "indeterminate" || !envelope.payload.mutating) return;
      const classified = addinOutcome(response);
      const resultDigest = digest(response.payload);
      const payload = classified.status === "failed"
        ? (() => {
            const failure = addinFailureClass(response);
            return { fault_class: failure.faultClass, message: failure.message } as JsonValue;
          })()
        : { bridge_result: classified.result } as JsonValue;
      const payloadRetained =
        !hasDeclaredArtifactShape(classified.result) &&
        Buffer.byteLength(canonicalizeJson(payload), "utf8") <= INLINE_JOURNAL_PAYLOAD_BYTES;
      this.#journal.recordTerminal(envelope.rsid, envelope.payload.invocation_id, {
        status: classified.status,
        payloadRetained,
        ...(payloadRetained ? { payload } : {}),
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
    enrichment: AddinFailureStatusEvidence | null = null,
    deliveryMode: "streamable" | "batch_inline_only" = "streamable",
    batchInlineResultLimit = this.#limits.maxResultBytes,
  ): BridgeInvocationOutcome {
    const classified = addinOutcome(response);
    const resultDigest = digest(response.payload);
    if (classified.status === "failed") {
      const classifiedFailure = addinFailureClass(response);
      const enrichableFailure = classifiedFailure.faultClass === "revit_api" ||
        classifiedFailure.faultClass === "revit_timeout";
      const failure = enrichment?.state === "reachable_busy" && enrichableFailure
        ? { faultClass: "revit_busy" as const, message: classifiedFailure.message, retryable: true }
        : enrichment?.state === "unreachable" && enrichableFailure
          ? { faultClass: "addin_unreachable" as const, message: classifiedFailure.message, retryable: true }
          : classifiedFailure;
      const payload: JsonValue = {
        fault_class: failure.faultClass,
        message: failure.message,
      };
      if (
        envelope.payload.mutating &&
        (failure.faultClass === "revit_timeout" ||
          failure.faultClass === "addin_unreachable" ||
          failure.faultClass === "environment")
      ) {
        const indeterminate = this.#journal.markIndeterminate(
          envelope.rsid,
          envelope.payload.invocation_id,
        );
        this.#journal.recordTerminal(envelope.rsid, envelope.payload.invocation_id, {
          status: "failed",
          payloadRetained: true,
          payload,
          resultDigest,
        });
        return {
          kind: "error",
          faultClass: "journal_indeterminate",
          retryable: false,
          outcome: "indeterminate",
          verificationRequired: true,
          verificationHoldId: indeterminate.verificationHoldId,
          replayed: false,
          lateAfterIndeterminate: false,
          resultDigest: null,
          addinContacted: true,
          message: "mutation deadline/unreachability left the add-in effect indeterminate",
        };
      }
      const terminal = this.#journal.recordTerminal(envelope.rsid, envelope.payload.invocation_id, {
        status: "failed",
        payloadRetained: true,
        payload,
        resultDigest,
      });
      if (terminal.abandoned) {
        return knownError("cancelled", "late add-in failure retained after cancellation", {
          addinContacted: true,
        });
      }
      return knownError(failure.faultClass, failure.message, {
        retryable: failure.retryable,
        addinContacted: true,
      });
    }

    let artifactCarrier: ArtifactCarrier | null = null;
    let resultCarrier: ChunkedResultCarrier | null = null;
    let result = classified.result;
    let partials: readonly Extract<RbpPartial, { kind: "chunk" }>[] = [];
    try {
      if (deliveryMode === "batch_inline_only" && hasDeclaredArtifactShape(classified.result)) {
        return this.#batchInlineContractViolation(
          envelope,
          classified,
          resultDigest,
          "batch-inline-only add-in contract returned artifact data",
        );
      }
      const fixtureArtifacts = this.#fixtureArtifacts(classified.result);
      if (deliveryMode === "batch_inline_only" && fixtureArtifacts !== null) {
        return this.#batchInlineContractViolation(
          envelope,
          classified,
          resultDigest,
          "batch-inline-only add-in contract returned artifact data",
        );
      }
      if (fixtureArtifacts?.kind === "inline") {
        if (
          !this.#grantedConnectionCapabilities.has("artifact_result_v1") ||
          !this.#grantedConnectionCapabilities.has("chunked_results")
        ) {
          throw new Error("artifact/chunk capability was not granted for this connection");
        }
        artifactCarrier = this.#spool.retain(
          envelope.rsid,
          envelope.payload.invocation_id,
          fixtureArtifacts.inputs,
          this.#limits.maxPartialBytes,
        );
        result = {
          ...fixtureArtifacts.source,
          files: artifactCarrier.result.artifacts,
        } as unknown as JsonValue;
        this.#assertArtifactResultLimit(result, artifactCarrier);
        partials = artifactCarrier.partials;
      } else if (fixtureArtifacts?.kind === "paths") {
        if (
          !this.#grantedConnectionCapabilities.has("artifact_result_v1") ||
          !this.#grantedConnectionCapabilities.has("chunked_results")
        ) {
          throw new Error("artifact/chunk capability was not granted for this connection");
        }
        artifactCarrier = this.#spool.captureDeclaredPaths(
          envelope.rsid,
          envelope.payload.invocation_id,
          fixtureArtifacts.paths,
          this.#limits.maxPartialBytes,
        );
        result = {
          ...fixtureArtifacts.source,
          files: artifactCarrier.result.artifacts,
        } as unknown as JsonValue;
        this.#assertArtifactResultLimit(result, artifactCarrier);
        partials = artifactCarrier.partials;
      } else {
        const bytes = Buffer.from(canonicalizeJson(classified.result), "utf8");
        const resultLimit = deliveryMode === "batch_inline_only"
          ? Math.min(this.#limits.maxResultBytes, batchInlineResultLimit)
          : this.#limits.maxResultBytes;
        if (bytes.byteLength > resultLimit) {
          if (deliveryMode === "batch_inline_only") {
            return this.#batchInlineContractViolation(
              envelope,
              classified,
              resultDigest,
              `batch inline result exceeds attested ${resultLimit} byte limit`,
            );
          }
          throw new RangeError(`result exceeds negotiated ${this.#limits.maxResultBytes} byte limit`);
        }
        if (
          deliveryMode === "streamable" &&
          bytes.byteLength > this.#limits.maxPartialBytes &&
          this.#grantedConnectionCapabilities.has("chunked_results")
        ) {
          resultCarrier = this.#spool.retainChunkedResult(
            envelope.rsid,
            envelope.payload.invocation_id,
            bytes,
            this.#limits.maxPartialBytes,
          );
          partials = resultCarrier.partials;
        }
      }
    } catch (error) {
      if (artifactCarrier !== null) this.#spool.expire(artifactCarrier);
      if (resultCarrier !== null) this.#spool.expire(resultCarrier);
      const message = error instanceof Error ? error.message.slice(0, 240) : "artifact/result validation failed";
      const faultClass = error instanceof RangeError
        ? "oversize"
        : /was not granted for this connection/u.test(message)
          ? "unsupported"
          : "parameter";
      const payload: JsonValue = { fault_class: faultClass, message };
      this.#journal.recordTerminal(envelope.rsid, envelope.payload.invocation_id, {
        status: "failed",
        payloadRetained: true,
        payload,
        resultDigest,
      });
      return knownError(faultClass, message, { addinContacted: true });
    }

    const retainedPayload = {
      ...(resultCarrier === null ? { bridge_result: result } : {}),
      partials: artifactCarrier === null && resultCarrier === null ? partials : [],
      ...(artifactCarrier === null
        ? {}
        : { artifact_carrier: this.#spool.compact(artifactCarrier) }),
      ...(resultCarrier === null
        ? {}
        : { result_carrier: this.#spool.compact(resultCarrier) }),
    } as unknown as JsonValue;
    const retained = artifactCarrier !== null || resultCarrier !== null ||
      Buffer.byteLength(canonicalizeJson(retainedPayload), "utf8") <= INLINE_JOURNAL_PAYLOAD_BYTES;
    const terminal = this.#journal.recordTerminal(envelope.rsid, envelope.payload.invocation_id, {
      status: classified.status,
      payloadRetained: retained,
      ...(retained ? { payload: retainedPayload } : {}),
      resultDigest,
      ...(classified.status === "guarded" ? { guardedReason: classified.guardedReason } : {}),
    });
    if (terminal.abandoned) {
      if (artifactCarrier !== null) this.#spool.expire(artifactCarrier);
      if (resultCarrier !== null) this.#spool.expire(resultCarrier);
      return knownError("cancelled", "late add-in outcome retained after cancellation", {
        addinContacted: true,
      });
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
      resultCarrier,
      addinContacted: true,
    };
  }

  #batchInlineContractViolation(
    envelope: InvokeEnvelope,
    classified: {
      readonly status: "completed" | "guarded" | "failed";
      readonly result: JsonValue;
      readonly guardedReason?: string;
    },
    resultDigest: string,
    message: string,
  ): BridgeInvocationOutcome {
    if (classified.status === "failed") {
      throw new Error("failed add-in outcomes must be classified before delivery handling");
    }
    const effectState = envelope.payload.mutating
      ? classified.status === "completed" ? "committed" : "not_committed"
      : "read_only";
    const retainedMessage = message.slice(0, 240);
    this.#journal.recordTerminal(envelope.rsid, envelope.payload.invocation_id, {
      status: "failed",
      payloadRetained: true,
      payload: {
        fault_class: "protocol",
        message: retainedMessage,
        effect_state: effectState,
      },
      resultDigest,
    });
    return knownError("protocol", retainedMessage, {
      addinContacted: true,
      effectState,
      resultDigest,
    });
  }

  #fixtureArtifacts(result: JsonValue):
    | {
        readonly kind: "inline";
        readonly inputs: readonly ArtifactInput[];
        readonly source: JsonObject;
      }
    | {
        readonly kind: "paths";
        readonly paths: readonly { readonly path: string; readonly contentType: string }[];
        readonly source: JsonObject;
      }
    | null {
    if (!isObject(result) || !Array.isArray(result.files) || result.files.length === 0) return null;
    const inputs: ArtifactInput[] = [];
    const paths: Array<{ readonly path: string; readonly contentType: string }> = [];
    for (const entry of result.files) {
      if (!isObject(entry) || typeof entry.contentType !== "string") {
        throw new Error("declared artifact member has an invalid shape");
      }
      if (typeof entry.path === "string" && !owns(entry, "fileName") && !owns(entry, "contentBase64")) {
        if (inputs.length > 0) throw new Error("declared artifact members cannot mix path and inline forms");
        paths.push({ path: entry.path, contentType: entry.contentType });
        continue;
      }
      if (
        typeof entry.fileName !== "string" ||
        typeof entry.contentBase64 !== "string" ||
        owns(entry, "path")
      ) throw new Error("declared artifact member has an invalid shape");
      if (paths.length > 0) throw new Error("declared artifact members cannot mix path and inline forms");
      const bytes = Buffer.from(entry.contentBase64, "base64");
      if (bytes.toString("base64") !== entry.contentBase64) {
        throw new Error("fixture artifact Base64 is not canonical");
      }
      inputs.push({ filename: entry.fileName, contentType: entry.contentType, bytes });
    }
    const source = structuredClone(result);
    delete source.files;
    return paths.length > 0 ? { kind: "paths", paths, source } : { kind: "inline", inputs, source };
  }

  #assertArtifactResultLimit(result: JsonValue, carrier: ArtifactCarrier): void {
    const structuredBytes = Buffer.byteLength(canonicalizeJson(result), "utf8");
    const artifactBytes = carrier.descriptors.reduce((sum, descriptor) => sum + descriptor.total_size, 0);
    if (structuredBytes + artifactBytes > this.#limits.maxResultBytes) {
      throw new RangeError(`result exceeds negotiated ${this.#limits.maxResultBytes} byte limit`);
    }
  }

  #replayOutcome(
    outcome: TerminalJournalOutcome,
    lateAfterIndeterminate: boolean,
    verificationHoldId: string | null,
    expectedIdentity?: { readonly rsid: string; readonly invocationId: string },
  ): BridgeInvocationOutcome {
    if (outcome.status === "failed" || outcome.status === "cancelled") {
      const payload = isObject(outcome.payload) ? outcome.payload : {};
      const retainedClass = typeof payload.fault_class === "string" ? payload.fault_class : "revit_api";
      const allowed = new Set([
        "protocol", "auth", "policy", "unsupported", "parameter", "environment", "revit_busy",
        "revit_timeout", "revit_api", "addin_unreachable", "journal_indeterminate", "oversize", "cancelled",
      ]);
      const faultClass = outcome.status === "cancelled"
        ? "cancelled"
        : allowed.has(retainedClass)
          ? retainedClass as Extract<BridgeInvocationOutcome, { kind: "error" }>["faultClass"]
          : "revit_api";
      const message = typeof payload.message === "string" ? payload.message : "terminal journal outcome replay";
      const effectState = payload.effect_state === "read_only" ||
        payload.effect_state === "committed" ||
        payload.effect_state === "not_committed"
        ? payload.effect_state
        : undefined;
      return knownError(faultClass, message, {
        replayed: true,
        retryable: faultClass === "environment" || faultClass === "revit_busy" || faultClass === "revit_timeout" || faultClass === "addin_unreachable",
        lateAfterIndeterminate,
        verificationHoldId: lateAfterIndeterminate ? verificationHoldId : null,
        resultDigest: lateAfterIndeterminate ? outcome.resultDigest ?? null : null,
        ...(effectState === undefined ? {} : { effectState }),
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
        resultCarrier: null,
        addinContacted: false,
      };
    }
    const payload = outcome.payload;
    const retained = isObject(payload) ? payload : {};
    const legacyMessage = isObject(retained.result) ? retained : null;
    const result = owns(retained, "bridge_result")
      ? retained.bridge_result as JsonValue
      : owns(retained, "result_carrier")
        ? null
      : legacyMessage !== null
        ? legacyMessage.result as JsonValue
        : payload as JsonValue;
    let artifactCarrier = isObject(retained.artifact_carrier)
      ? retained.artifact_carrier as unknown as ArtifactCarrier
      : null;
    let resultCarrier = isObject(retained.result_carrier)
      ? retained.result_carrier as unknown as ChunkedResultCarrier
      : null;
    let partials = Array.isArray(retained.partials)
      ? retained.partials as unknown as readonly Extract<RbpPartial, { kind: "chunk" }>[]
      : artifactCarrier?.partials ?? resultCarrier?.partials ?? [];
    const durableCarrier = artifactCarrier ?? resultCarrier;
    if (
      durableCarrier !== null && expectedIdentity !== undefined &&
      (durableCarrier.rsid !== expectedIdentity.rsid ||
        durableCarrier.invocationId !== expectedIdentity.invocationId)
    ) {
      artifactCarrier = null;
      resultCarrier = null;
      partials = [];
      return {
        kind: "result",
        status: outcome.status,
        ...(outcome.status === "guarded" ? { guardedReason: outcome.guardedReason } : {}),
        replayed: true,
        payloadOmitted: true,
        resultDigest: outcome.resultDigest as string,
        lateAfterIndeterminate,
        verificationHoldId,
        partials,
        artifactCarrier,
        resultCarrier,
        addinContacted: false,
      };
    }
    if ((artifactCarrier !== null || resultCarrier !== null) && partials.length === 0) {
      try {
        const carrier = this.#spool.rehydrate(artifactCarrier ?? resultCarrier as ChunkedResultCarrier);
        if (carrier.kind === "artifacts") artifactCarrier = carrier;
        else resultCarrier = carrier;
        partials = carrier.partials;
      } catch {
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
          resultCarrier: null,
          addinContacted: false,
        };
      }
    }
    return {
      kind: "result",
      status: outcome.status,
      result,
      ...(outcome.status === "guarded" ? { guardedReason: outcome.guardedReason } : {}),
      replayed: true,
      payloadOmitted: false,
      resultDigest: outcome.resultDigest as string,
      lateAfterIndeterminate,
      verificationHoldId,
      partials,
      artifactCarrier,
      resultCarrier,
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
