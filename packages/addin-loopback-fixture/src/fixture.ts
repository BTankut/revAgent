import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";

import {
  ABSOLUTE_MAX_REQUEST_PAYLOAD_BYTES,
  DEFAULT_MAX_REQUEST_PAYLOAD_BYTES,
  FrameDecoder,
  MAX_RESPONSE_PAYLOAD_BYTES,
  MIN_REQUEST_PAYLOAD_BYTES,
  PayloadLimitError,
  encodeJsonFrame,
  jsonPayloadBytes,
} from "./framing.js";
import {
  BATCH_MAX_INLINE_RESULT_BYTES,
  BATCHABLE_DESCRIPTORS,
  ContractValidationError,
  LoopbackContractValidator,
} from "./schemaValidation.js";
import { parseStrictJsonBytes } from "./strictJson.js";
import { TestTransactionGroup } from "./transactionGroup.js";
import type {
  DocumentContextEvent,
  DocumentContextSnapshot,
  Effect,
  FaultPlan,
  FixtureAddress,
  FixtureHandler,
  FixtureEvidenceSnapshot,
  FixtureObservation,
  FixtureOptions,
  HandlerContext,
  HandlerOutcome,
  HandlerRegistration,
  JsonObject,
  JsonValue,
  MultiFileArtifact,
  ObservationPhase,
} from "./types.js";

interface MutableTaskInfo {
  id: string;
  requestId: string;
  method: string;
  taskName: string;
  state: "running" | "completed" | "guarded" | "failed";
  startedAtUtc: string;
  finishedAtUtc: string | null;
  elapsedMs: number;
  port: number;
  error: string | null;
  framing: "length-prefixed";
  requestBytes: number;
  receiveMs: number;
  parseMs: number;
  executeMs: number | null;
  responseBytes: number | null;
}

interface BatchStep {
  index: number;
  invocationId: string;
  method: string;
  params: JsonObject;
  paramsDigest: string;
  effect: Effect;
}

interface ExecutedStep {
  readonly step: BatchStep;
  readonly outcome: HandlerOutcome;
}

interface BatchStepOutcome extends JsonObject {
  index: number;
  invocationId: string;
  method: string;
  executionState: "completed" | "guarded" | "failed" | "not_started";
  effectState:
    | "read_only"
    | "committed"
    | "rolled_back"
    | "discarded"
    | "not_started"
    | "indeterminate";
}

interface StallLatch {
  readonly promise: Promise<boolean>;
  readonly release: () => void;
  readonly cancel: () => void;
}

interface DispatchResult {
  readonly response: JsonObject;
  readonly executionOrdinal: number;
}

interface JsonValidationBudget {
  nodes: number;
}

const MAX_FAULTS_PER_REQUEST = 64;
const MAX_TOTAL_QUEUED_FAULTS = 4096;
const STANDARD_JSON_RPC_CODES = new Set([-32700, -32600, -32601, -32602, -32603]);
const HANDLER_ERROR_CODES = new Set([
  "command_failure",
  "revit_api",
  "invalid_result",
  "response_payload_limit",
]);
const FAULT_PLAN_KEYS = new Set([
  "busy",
  "delayMs",
  "stall",
  "disconnect",
  "afterResponseBytes",
  "crash",
  "rollbackFailure",
  "finalBatchResponseFault",
  "injectedOutcome",
  "jsonRpcError",
]);

const DEFAULT_DOCUMENT_CONTEXT: DocumentContextSnapshot = {
  resultContractVersion: 2,
  documentContextContractVersion: 1,
  capturedAtUtc: "2026-07-22T00:00:00.000Z",
  revision: 1,
  cacheState: "ready",
  unavailableReason: null,
  documents: [
    {
      documentId: "fixture-document-1",
      title: "Fixture Model",
      pathDigest: null,
      isWorkshared: false,
      isActive: true,
    },
  ],
  activeDocumentId: "fixture-document-1",
  activeView: {
    documentId: "fixture-document-1",
    id: "1001",
    name: "Fixture View",
    type: "FloorPlan",
    level: "Level 01",
  },
  disciplineHint: "mechanical",
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.length === 0 ? "Unknown fixture error" : message.slice(0, 600);
}

function guardedReasonToken(value: string): string {
  const token = value.toLowerCase().replaceAll(/[^a-z0-9_]/gu, "_").replace(/^_+/u, "");
  if (token.length === 0) return "guarded";
  const prefixed = /^[a-z]/u.test(token) ? token : `guarded_${token}`;
  return prefixed.slice(0, 64);
}

function invalidResult(message: unknown): HandlerOutcome {
  return {
    state: "failed",
    error: { code: "invalid_result", message: boundedMessage(message) },
  };
}

function hasDeclaredArtifactShape(value: JsonValue): boolean {
  if (!isObject(value) || !Array.isArray(value.files) || value.files.length === 0) return false;
  return value.files.some((entry) =>
    isObject(entry) &&
    (typeof entry.path === "string" ||
      typeof entry.fileName === "string" ||
      typeof entry.contentBase64 === "string")
  );
}

function jsonValueError(
  value: unknown,
  path = "$",
  depth = 0,
  seen = new WeakSet<object>(),
  budget: JsonValidationBudget = { nodes: 0 },
): string | null {
  budget.nodes += 1;
  if (budget.nodes > 100_000) return "result exceeds the 100000-node validation budget";
  if (depth > 64) return `${path} exceeds the maximum JSON depth`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : `${path} is not a finite number`;
  if (typeof value !== "object") return `${path} is not a JSON value`;
  if (seen.has(value)) return `${path} contains a circular reference`;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return `${path}[${index}] is an array hole`;
      const error = jsonValueError(value[index], `${path}[${index}]`, depth + 1, seen, budget);
      if (error) return error;
    }
    seen.delete(value);
    return null;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return `${path} is not a plain JSON object`;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return `${path} contains symbol keys`;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set) {
      return `${path}.${key} is not an enumerable data property`;
    }
    const error = jsonValueError(descriptor.value, `${path}.${key}`, depth + 1, seen, budget);
    if (error) return error;
  }
  seen.delete(value);
  return null;
}

function isNumericLoopback(host: string): boolean {
  const family = isIP(host);
  if (family === 4) return host.split(".")[0] === "127";
  if (family === 6) {
    const normalized = host.toLowerCase().split("%")[0];
    return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  }
  return false;
}

function stableJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => stableJsonValue(entry));
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function validateFaultPlan(plan: FaultPlan): void {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new TypeError("Fault plan must be an object");
  }
  const unknownKey = Object.keys(plan).find((key) => !FAULT_PLAN_KEYS.has(key));
  if (unknownKey) throw new Error(`Unknown fault-plan field: ${unknownKey}`);
  for (const key of ["busy", "stall", "rollbackFailure"] as const) {
    if (plan[key] !== undefined && typeof plan[key] !== "boolean") {
      throw new TypeError(`${key} must be boolean`);
    }
  }
  if (
    plan.delayMs !== undefined &&
    (!Number.isSafeInteger(plan.delayMs) || plan.delayMs < 0 || plan.delayMs > 600_000)
  ) {
    throw new RangeError("delayMs must be an integer from 0 through 600000");
  }
  if (
    plan.disconnect !== undefined &&
    !["before_dispatch", "after_dispatch", "after_response_bytes"].includes(plan.disconnect)
  ) {
    throw new Error("disconnect has an invalid phase");
  }
  if (
    plan.crash !== undefined &&
    !["before_dispatch", "after_dispatch"].includes(plan.crash)
  ) {
    throw new Error("crash has an invalid phase");
  }
  if (plan.disconnect !== undefined && plan.crash !== undefined) {
    throw new Error("disconnect and crash fault modes are mutually exclusive");
  }
  if (plan.disconnect === "after_response_bytes") {
    if (
      !Number.isSafeInteger(plan.afterResponseBytes) ||
      Number(plan.afterResponseBytes) < 1 ||
      Number(plan.afterResponseBytes) > MAX_RESPONSE_PAYLOAD_BYTES + 3
    ) {
      throw new RangeError(
        "afterResponseBytes must be from 1 through max response frame bytes minus one",
      );
    }
  } else if (plan.afterResponseBytes !== undefined) {
    throw new Error("afterResponseBytes requires disconnect=after_response_bytes");
  }
  if (
    plan.finalBatchResponseFault !== undefined &&
    plan.finalBatchResponseFault !== "omit_batch_digest"
  ) {
    throw new Error("finalBatchResponseFault has an invalid value");
  }
  if (plan.injectedOutcome !== undefined) {
    const outcome = plan.injectedOutcome;
    if (!isExplicitOutcome(outcome) || (outcome as { state: string }).state === "completed") {
      throw new Error("injectedOutcome must be a guarded or failed handler outcome");
    }
    if (
      outcome.state === "guarded" &&
      !Object.keys(outcome).every((key) => ["state", "guardedReason"].includes(key))
    ) {
      throw new Error("guarded injectedOutcome contains an unknown field");
    }
    if (
      outcome.state === "guarded" &&
      (outcome.guardedReason.length < 1 || outcome.guardedReason.length > 256)
    ) {
      throw new RangeError("guarded injectedOutcome reason must contain from 1 through 256 characters");
    }
    if (outcome.state === "failed") {
      if (!Object.keys(outcome).every((key) => ["state", "error"].includes(key))) {
        throw new Error("failed injectedOutcome contains an unknown field");
      }
      if (
        !Object.keys(outcome.error).every((key) =>
          [
            "code",
            "message",
            "maxResponsePayloadBytes",
            "tentativeResponsePayloadBytes",
          ].includes(key),
        )
      ) {
        throw new Error("failed injectedOutcome.error contains an unknown field");
      }
      if (!HANDLER_ERROR_CODES.has(outcome.error.code)) {
        throw new Error("failed injectedOutcome.error.code is unsupported");
      }
      if (outcome.error.message.length < 1 || outcome.error.message.length > 600) {
        throw new RangeError("failed injectedOutcome error message must contain from 1 through 600 characters");
      }
      if (outcome.error.code === "response_payload_limit") {
        if (
          outcome.error.maxResponsePayloadBytes !== MAX_RESPONSE_PAYLOAD_BYTES ||
          !Number.isSafeInteger(outcome.error.tentativeResponsePayloadBytes) ||
          Number(outcome.error.tentativeResponsePayloadBytes) <= MAX_RESPONSE_PAYLOAD_BYTES
        ) {
          throw new Error("response_payload_limit injectedOutcome lacks exact byte evidence");
        }
      } else if (
        outcome.error.maxResponsePayloadBytes !== undefined ||
        outcome.error.tentativeResponsePayloadBytes !== undefined
      ) {
        throw new Error("non-limit injectedOutcome must not carry response byte evidence");
      }
    }
  }
  if (plan.jsonRpcError !== undefined) {
    const error = plan.jsonRpcError;
    if (!isObject(error) || !Object.keys(error).every((key) => ["code", "message", "data"].includes(key))) {
      throw new TypeError("jsonRpcError must contain only code, message, and optional data");
    }
    if (!STANDARD_JSON_RPC_CODES.has(Number(error.code))) {
      throw new Error("jsonRpcError.code is not a standard add-in loopback code");
    }
    if (typeof error.message !== "string" || error.message.length < 1 || error.message.length > 600) {
      throw new RangeError("jsonRpcError.message must contain from 1 through 600 characters");
    }
    if (error.data !== undefined) {
      const dataError = jsonValueError(error.data);
      if (dataError) throw new TypeError(`jsonRpcError.data ${dataError}`);
    }
  }
  const terminalModes = [
    plan.busy === true,
    plan.injectedOutcome !== undefined,
    plan.jsonRpcError !== undefined,
  ].filter(Boolean).length;
  if (terminalModes > 1) {
    throw new Error("busy, injectedOutcome, and jsonRpcError are mutually exclusive");
  }
}

function assertFixtureOptions(options: FixtureOptions): void {
  const host = options.host ?? "127.0.0.1";
  if (options.allowUnsafeBind === true) {
    throw new Error("Unsafe bind override is forbidden by add-in loopback v1");
  }
  if (!isNumericLoopback(host)) {
    throw new Error(`Listener host must be a numeric IP loopback address: ${host}`);
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be an integer from 0 through 65535");
  }
  const maxRequest = options.maxRequestPayloadBytes ?? DEFAULT_MAX_REQUEST_PAYLOAD_BYTES;
  if (
    !Number.isInteger(maxRequest) ||
    maxRequest < MIN_REQUEST_PAYLOAD_BYTES ||
    maxRequest > ABSOLUTE_MAX_REQUEST_PAYLOAD_BYTES
  ) {
    throw new RangeError("maxRequestPayloadBytes must be from 1 MiB through 128 MiB");
  }
  if (options.addinVersion !== undefined && (options.addinVersion.length < 1 || options.addinVersion.length > 128)) {
    throw new RangeError("addinVersion must contain from 1 through 128 characters");
  }
  if (options.revitVersion !== undefined && !/^[0-9]{4}$/u.test(options.revitVersion)) {
    throw new Error("revitVersion must be a four-digit version");
  }
  if (options.revitBuild !== undefined && (options.revitBuild.length < 1 || options.revitBuild.length > 128)) {
    throw new RangeError("revitBuild must contain from 1 through 128 characters");
  }
  if (options.processId !== undefined && (!Number.isInteger(options.processId) || options.processId < 1)) {
    throw new RangeError("processId must be a positive integer");
  }
}

function isExplicitOutcome(value: unknown): value is HandlerOutcome {
  if (!isObject(value) || typeof value.state !== "string") return false;
  if (value.state === "completed") return "result" in value;
  if (value.state === "guarded") return typeof value.guardedReason === "string";
  if (value.state === "failed") return isObject(value.error) && typeof value.error.message === "string";
  return false;
}

function findNestedFailure(value: unknown, depth = 0): HandlerOutcome | null {
  if (depth > 8 || !isObject(value)) return null;
  if (
    value.guarded === true ||
    value.state === "guarded" ||
    value.success === false && typeof value.guardedReason === "string"
  ) {
    const reason =
      typeof value.guardedReason === "string"
        ? value.guardedReason
        : typeof value.reason === "string"
          ? value.reason
          : "guarded";
    return { state: "guarded", guardedReason: guardedReasonToken(reason) };
  }
  if (value.success === false || value.state === "failed") {
    const error = isObject(value.error) ? value.error : null;
    const message = error?.message ?? value.reason ?? "Nested command failure";
    return {
      state: "failed",
      error: { code: "command_failure", message: boundedMessage(message) },
    };
  }
  for (const key of ["result", "data", "payload"]) {
    if (key in value) {
      const nested = findNestedFailure(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeHandlerOutcome(value: unknown): HandlerOutcome {
  if (isExplicitOutcome(value)) {
    if (value.state === "guarded") {
      return { state: "guarded", guardedReason: guardedReasonToken(value.guardedReason) };
    }
    if (value.state === "failed") {
      const allowedCodes = new Set([
        "command_failure",
        "revit_api",
        "invalid_result",
        "response_payload_limit",
      ]);
      if (!allowedCodes.has(value.error.code)) {
        return invalidResult("handler failure contains an unsupported error code");
      }
      if (
        value.error.code === "response_payload_limit" &&
        (value.error.maxResponsePayloadBytes !== MAX_RESPONSE_PAYLOAD_BYTES ||
          !Number.isSafeInteger(value.error.tentativeResponsePayloadBytes) ||
          Number(value.error.tentativeResponsePayloadBytes) <= MAX_RESPONSE_PAYLOAD_BYTES)
      ) {
        return invalidResult("response_payload_limit handler result lacks valid byte evidence");
      }
      return {
        state: "failed",
        error: {
          code: value.error.code,
          message: boundedMessage(value.error.message),
          ...(value.error.code === "response_payload_limit"
            ? {
                maxResponsePayloadBytes: value.error.maxResponsePayloadBytes,
                tentativeResponsePayloadBytes: value.error.tentativeResponsePayloadBytes,
              }
            : {}),
        },
      };
    }
    const error = jsonValueError(value.result);
    return error
      ? invalidResult(error)
      : { state: "completed", result: structuredClone(value.result) };
  }
  if (
    isObject(value) &&
    (value.state === "completed" || value.state === "guarded" || value.state === "failed")
  ) {
    return invalidResult(`malformed ${String(value.state)} handler outcome`);
  }
  const nested = findNestedFailure(value);
  if (nested) return nested;
  const error = jsonValueError(value);
  return error
    ? invalidResult(error)
    : { state: "completed", result: structuredClone(value) as JsonValue };
}

function jsonRpcError(
  id: string | null,
  code: -32700 | -32600 | -32601 | -32602 | -32603,
  message: string,
  data?: JsonValue,
): JsonObject {
  const error: JsonObject = { code, message: message.slice(0, 600) };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function ordinarySuccess(id: string, outcome: HandlerOutcome): JsonObject {
  let result: JsonObject;
  if (outcome.state === "completed") {
    result = isObject(outcome.result)
      ? { ...outcome.result, resultContractVersion: 2 }
      : { resultContractVersion: 2, value: outcome.result };
  } else if (outcome.state === "guarded") {
    result = {
      resultContractVersion: 2,
      success: false,
      guarded: true,
      state: "guarded",
      guardedReason: outcome.guardedReason,
    };
  } else {
    result = {
      resultContractVersion: 2,
      success: false,
      guarded: false,
      state: "failed",
      error: { code: outcome.error.code, message: outcome.error.message },
    };
  }
  return { jsonrpc: "2.0", id, result };
}

function sha256(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export class AddinLoopbackFixture {
  readonly #options: Required<
    Pick<
      FixtureOptions,
      "host" | "port" | "maxRequestPayloadBytes" | "addinVersion" | "revitVersion" | "revitBuild" | "processId"
    >
  >;
  readonly #validator: LoopbackContractValidator;
  readonly #handlers = new Map<string, HandlerRegistration>();
  readonly #faults = new Map<string, FaultPlan[]>();
  readonly #stallLatches = new Map<string, StallLatch[]>();
  readonly #dispatchCounts = new Map<string, number>();
  readonly #methodCounts = new Map<string, number>();
  readonly #observations: FixtureObservation[] = [];
  readonly #modelState = new Map<string, JsonValue>();
  readonly #sockets = new Set<Socket>();
  readonly #recentTasks: MutableTaskInfo[] = [];
  #server: Server | null = null;
  #address: FixtureAddress | null = null;
  #observationSequence = 0;
  #executionSequence = 0;
  #activeTask: MutableTaskInfo | null = null;
  #documentContext: DocumentContextSnapshot;
  #crashed = false;

  public constructor(options: FixtureOptions = {}) {
    assertFixtureOptions(options);
    this.#options = {
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      maxRequestPayloadBytes:
        options.maxRequestPayloadBytes ?? DEFAULT_MAX_REQUEST_PAYLOAD_BYTES,
      addinVersion: options.addinVersion ?? "fixture-1.0.0",
      revitVersion: options.revitVersion ?? "2025",
      revitBuild: options.revitBuild ?? "fixture-build",
      processId: options.processId ?? process.pid,
    };
    this.#validator = new LoopbackContractValidator(this.#options.maxRequestPayloadBytes);
    this.#documentContext = structuredClone(options.documentContext ?? DEFAULT_DOCUMENT_CONTEXT);
    this.#validateDocumentContext(this.#documentContext);
    this.#registerDefaultHandlers();
  }

  public get address(): FixtureAddress | null {
    return this.#address;
  }

  public get crashed(): boolean {
    return this.#crashed;
  }

  public get observations(): readonly FixtureObservation[] {
    return structuredClone(this.#observations);
  }

  public get modelState(): ReadonlyMap<string, JsonValue> {
    return new Map([...this.#modelState].map(([key, value]) => [key, structuredClone(value)]));
  }

  public get documentContext(): DocumentContextSnapshot {
    return structuredClone(this.#documentContext);
  }

  public getExecutionCount(requestId: string): number {
    return this.#dispatchCounts.get(requestId) ?? 0;
  }

  public getMethodExecutionCount(method: string): number {
    return this.#methodCounts.get(method) ?? 0;
  }

  public snapshotEvidence(): FixtureEvidenceSnapshot {
    const modelEntries = [...this.#modelState]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => [key, stableJsonValue(value)] as const);
    return {
      evidenceVersion: 1,
      fixtureContract: "addin-loopback/v1",
      observations: structuredClone(this.#observations),
      executionCounts: [...this.#dispatchCounts]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([requestId, count]) => ({ requestId, count })),
      methodExecutionCounts: [...this.#methodCounts]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([method, count]) => ({ method, count })),
      modelStateDigest: sha256(Buffer.from(JSON.stringify(modelEntries), "utf8")),
      modelStateEntryCount: modelEntries.length,
      pendingStalls: [...this.#stallLatches]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([requestId, queue]) => ({ requestId, count: queue.length })),
      openSocketCount: this.#sockets.size,
      crashed: this.#crashed,
    };
  }

  public registerHandler(method: string, effect: Effect, handler: FixtureHandler): void {
    if (!/^[a-z][a-z0-9_]{0,127}$/u.test(method)) throw new Error(`Invalid method token: ${method}`);
    const descriptor = BATCHABLE_DESCRIPTORS.find((entry) => entry.method === method);
    if (descriptor && descriptor.effect !== effect) {
      throw new Error(`${method} must retain advertised ${descriptor.effect} effect`);
    }
    this.#handlers.set(method, { effect, handler });
  }

  public planFault(requestId: string, plan: FaultPlan): void {
    if (requestId.length < 1 || requestId.length > 128) {
      throw new Error("Fault request id must contain from 1 through 128 characters");
    }
    validateFaultPlan(plan);
    const queue = this.#faults.get(requestId) ?? [];
    if (queue.length >= MAX_FAULTS_PER_REQUEST) {
      throw new Error(`Fault queue for ${requestId} reached ${MAX_FAULTS_PER_REQUEST}`);
    }
    const totalQueued = [...this.#faults.values()].reduce((sum, entries) => sum + entries.length, 0);
    if (totalQueued >= MAX_TOTAL_QUEUED_FAULTS) {
      throw new Error(`Fixture reached ${MAX_TOTAL_QUEUED_FAULTS} queued faults`);
    }
    queue.push(structuredClone(plan));
    this.#faults.set(requestId, queue);
  }

  public releaseStall(requestId: string): boolean {
    const queue = this.#stallLatches.get(requestId);
    const latch = queue?.shift();
    if (!latch || !queue) return false;
    latch.release();
    if (queue.length === 0) this.#stallLatches.delete(requestId);
    return true;
  }

  public getPendingStallCount(requestId: string): number {
    return this.#stallLatches.get(requestId)?.length ?? 0;
  }

  public applyDocumentContextEvent(event: DocumentContextEvent): DocumentContextSnapshot {
    if (this.#documentContext.revision >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("document context revision cannot increase safely");
    }
    const candidate: DocumentContextSnapshot = {
      ...structuredClone(event),
      resultContractVersion: 2,
      documentContextContractVersion: 1,
      revision: this.#documentContext.revision + 1,
    };
    this.#validateDocumentContext(candidate);
    this.#documentContext = candidate;
    return structuredClone(candidate);
  }

  public async start(): Promise<FixtureAddress> {
    if (this.#server) throw new Error("Fixture listener is already started");
    if (this.#crashed) throw new Error("A crashed fixture instance cannot be restarted");
    assertFixtureOptions(this.#options);

    const server = createServer((socket) => this.#accept(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.#options.host, port: this.#options.port, exclusive: true });
    });

    const actual = server.address();
    if (!actual || typeof actual === "string" || !isNumericLoopback(actual.address)) {
      await this.stop();
      throw new Error("Operating system returned a non-loopback listener address");
    }
    this.#address = { host: actual.address, port: actual.port };
    return this.#address;
  }

  public async stop(): Promise<void> {
    this.#cancelAllStalls();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    this.#address = null;
    if (!server || !server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #registerDefaultHandlers(): void {
    this.registerHandler("fixture_echo", "read_only", (params) => ({
      state: "completed",
      result: { success: true, echoed: params },
    }));
    this.registerHandler("fixture_counter", "read_only", (_params, context) => ({
      state: "completed",
      result: { success: true, executionOrdinal: context.executionOrdinal },
    }));
    this.registerHandler("fixture_multi_file_output", "read_only", () => ({
      state: "completed",
      result: { success: true, files: this.#multiFileArtifacts() as unknown as JsonValue },
    }));
    this.registerHandler("send_code_to_revit", "model_transaction", (params) => ({
      state: "completed",
      result: { success: true, fixtureOnly: true, echoed: params },
    }));
    for (const descriptor of BATCHABLE_DESCRIPTORS) {
      this.registerHandler(descriptor.method, descriptor.effect, (params, context) => {
        if (descriptor.effect === "model_transaction") {
          context.transactionGroup?.stage(
            `delete_review_view:${context.requestId}`,
            { method: descriptor.method, params },
          );
        }
        return {
          state: "completed",
          result: { success: true, method: descriptor.method, echoed: params },
        };
      });
    }
  }

  #multiFileArtifacts(): MultiFileArtifact[] {
    return [
      ["fixture-report.json", "application/json", Buffer.from('{"fixture":true}\n', "utf8")],
      ["fixture-evidence.txt", "text/plain", Buffer.from("revAgent fixture evidence\n", "utf8")],
    ].map(([fileName, contentType, content], artifactIndex) => {
      const bytes = content as Buffer;
      return {
        artifactIndex,
        fileName: fileName as string,
        contentType: contentType as string,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        contentBase64: bytes.toString("base64"),
      };
    });
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    const decoder = new FrameDecoder(this.#options.maxRequestPayloadBytes);
    let chain = Promise.resolve();
    const enqueue = (frame: Buffer): void => {
      chain = chain.then(() => this.#handleFrame(socket, frame)).catch((error: unknown) => {
        if (!socket.destroyed) socket.destroy(error instanceof Error ? error : undefined);
      });
    };
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      let frames: readonly Buffer[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        if (!(error instanceof PayloadLimitError)) {
          socket.destroy(error instanceof Error ? error : undefined);
          return;
        }
        frames = error.completedFrames;
        for (const frame of frames) enqueue(frame);
        chain = chain.then(async () => {
          const response = jsonRpcError(null, -32600, "Request payload exceeds advertised cap", {
            advertisedBytes: error.advertisedBytes,
            maxRequestPayloadBytes: error.maxPayloadBytes,
          });
          if (!socket.destroyed) {
            socket.end(encodeJsonFrame(response, MAX_RESPONSE_PAYLOAD_BYTES));
          }
        });
        return;
      }
      for (const frame of frames) enqueue(frame);
    });
  }

  async #handleFrame(socket: Socket, payload: Buffer): Promise<void> {
    if (socket.destroyed || this.#crashed) return;
    this.#observe(null, null, "frame_received", null, payload.byteLength, null);
    let parsed: unknown;
    try {
      parsed = parseStrictJsonBytes(payload, this.#options.maxRequestPayloadBytes);
    } catch {
      await this.#send(socket, null, null, jsonRpcError(null, -32700, "Parse error"), "read_only");
      return;
    }

    const recoveredId =
      isObject(parsed) &&
      typeof parsed.id === "string" &&
      parsed.id.length >= 1 &&
      parsed.id.length <= 128
        ? parsed.id
        : null;
    const recoveredMethod = isObject(parsed) && typeof parsed.method === "string" ? parsed.method : null;
    let request;
    try {
      request = this.#validator.validateRequest(parsed, payload.byteLength);
    } catch (error) {
      const code =
        error instanceof ContractValidationError && error.kind === "invalid_params" ? -32602 : -32600;
      await this.#send(
        socket,
        recoveredId,
        recoveredMethod,
        jsonRpcError(recoveredId, code, boundedMessage(error)),
        "read_only",
      );
      return;
    }
    this.#observe(request.id, request.method, "validated", null, payload.byteLength, null);

    const fault = this.#takeFault(request.id);
    if (fault.disconnect === "before_dispatch") {
      this.#observe(request.id, request.method, "disconnected", null, payload.byteLength, "before_dispatch");
      socket.destroy();
      return;
    }
    if (fault.crash === "before_dispatch") {
      await this.#crash(request.id, request.method, "before_dispatch");
      return;
    }

    const task = this.#beginTask(request.id, request.method, payload.byteLength);
    try {
      if (fault.delayMs && fault.delayMs > 0) await this.#delay(fault.delayMs);
      if (fault.stall === true && !(await this.#stall(request.id))) {
        const outcome: HandlerOutcome = {
          state: "failed",
          error: { code: "command_failure", message: "Fixture stopped while delivery was stalled" },
        };
        this.#finishTask(task, outcome, null);
        return;
      }

      if (fault.busy === true && !["mcp_status", "get_document_context", "execute_batch"].includes(request.method)) {
        const ordinal = this.#beginExecution(request.id, request.method);
        const outcome: HandlerOutcome = { state: "guarded", guardedReason: "busy" };
        this.#observe(request.id, request.method, "guarded", ordinal, payload.byteLength, "busy");
        this.#finishTask(task, outcome, null);
        await this.#send(
          socket,
          request.id,
          request.method,
          ordinarySuccess(request.id, outcome),
          "read_only",
          fault,
          ordinal,
        );
        return;
      }

      const responsePromise = this.#dispatch(request.id, request.method, request.params, fault);
      if (fault.disconnect === "after_dispatch") {
        this.#observe(request.id, request.method, "disconnected", null, payload.byteLength, "after_dispatch");
        socket.destroy();
      }
      if (fault.crash === "after_dispatch") {
        await this.#crash(request.id, request.method, "after_dispatch");
      }

      const { response, executionOrdinal } = await responsePromise;
      const responseBytes = jsonPayloadBytes(response).byteLength;
      const outcome = this.#responseOutcome(response);
      this.#finishTask(task, outcome, responseBytes);
      if (socket.destroyed || this.#crashed) {
        this.#observe(
          request.id,
          request.method,
          "late_outcome",
          executionOrdinal,
          responseBytes,
          "terminal outcome was not delivered",
        );
        return;
      }
      const registration = this.#handlers.get(request.method);
      await this.#send(
        socket,
        request.id,
        request.method,
        response,
        registration?.effect ?? "read_only",
        fault,
        executionOrdinal,
      );
    } catch (error) {
      const response = jsonRpcError(request.id, -32603, "Internal error", {
        message: boundedMessage(error),
      });
      this.#finishTask(
        task,
        { state: "failed", error: { code: "command_failure", message: boundedMessage(error) } },
        jsonPayloadBytes(response).byteLength,
      );
      if (!socket.destroyed && !this.#crashed) {
        await this.#send(socket, request.id, request.method, response, "read_only");
      } else {
        this.#observe(request.id, request.method, "late_outcome", null, null, boundedMessage(error));
      }
    }
  }

  async #dispatch(
    requestId: string,
    method: string,
    params: JsonObject,
    fault: FaultPlan,
  ): Promise<DispatchResult> {
    const ordinal = this.#beginExecution(requestId, method);
    if (fault.injectedOutcome !== undefined) {
      const outcome = normalizeHandlerOutcome(fault.injectedOutcome);
      this.#recordOutcome(requestId, method, ordinal, outcome);
      return { executionOrdinal: ordinal, response: ordinarySuccess(requestId, outcome) };
    }
    if (fault.jsonRpcError !== undefined) {
      const injected = fault.jsonRpcError;
      const outcome: HandlerOutcome = {
        state: "failed",
        error: { code: "command_failure", message: injected.message },
      };
      this.#recordOutcome(requestId, method, ordinal, outcome);
      return {
        executionOrdinal: ordinal,
        response: jsonRpcError(
          injected.code === -32700 ? null : requestId,
          injected.code,
          injected.message,
          injected.data,
        ),
      };
    }
    if (method === "mcp_status") {
      return {
        executionOrdinal: ordinal,
        response: { jsonrpc: "2.0", id: requestId, result: this.#statusResult() },
      };
    }
    if (method === "get_document_context") {
      return {
        executionOrdinal: ordinal,
        response: {
          jsonrpc: "2.0",
          id: requestId,
          result: structuredClone(this.#documentContext) as unknown as JsonObject,
        },
      };
    }
    if (method === "execute_batch") {
      return {
        executionOrdinal: ordinal,
        response: await this.#executeBatch(requestId, params, fault),
      };
    }
    const registration = this.#handlers.get(method);
    if (!registration) {
      return {
        executionOrdinal: ordinal,
        response: jsonRpcError(requestId, -32601, "Method not found"),
      };
    }
    const context: HandlerContext = {
      requestId,
      method,
      executionOrdinal: ordinal,
      transactionGroup: null,
      stepIndex: null,
    };
    const outcome = await this.#callHandler(registration.handler, params, context);
    this.#recordOutcome(requestId, method, ordinal, outcome);
    return { executionOrdinal: ordinal, response: ordinarySuccess(requestId, outcome) };
  }

  async #executeBatch(requestId: string, params: JsonObject, fault: FaultPlan): Promise<JsonObject> {
    const batchId = String(params.batchId);
    const batchDigest = String(params.batchDigest);
    const steps = (params.steps as unknown[]).map((entry) => entry as BatchStep);
    const maxAggregateResultBytes = Number(params.maxAggregateResultBytes);
    const group = new TestTransactionGroup(this.#modelState, fault.rollbackFailure === true);
    group.start();
    const executed: ExecutedStep[] = [];
    let triggerIndex: number | null = null;

    for (const step of steps) {
      const registration = this.#handlers.get(step.method);
      if (!registration) {
        executed.push({
          step,
          outcome: {
            state: "failed",
            error: { code: "command_failure", message: "Advertised handler is unavailable" },
          },
        });
        triggerIndex = step.index;
        break;
      }
      const stepFault = this.#takeFault(step.invocationId);
      if (stepFault.delayMs && stepFault.delayMs > 0) await this.#delay(stepFault.delayMs);
      if (stepFault.stall === true && !(await this.#stall(step.invocationId))) {
        executed.push({
          step,
          outcome: {
            state: "failed",
            error: { code: "command_failure", message: "Fixture stopped while batch step was stalled" },
          },
        });
        triggerIndex = step.index;
        break;
      }
      const ordinal = this.#beginExecution(step.invocationId, step.method);
      const context: HandlerContext = {
        requestId: step.invocationId,
        method: step.method,
        executionOrdinal: ordinal,
        transactionGroup: group,
        stepIndex: step.index,
      };
      let outcome: HandlerOutcome;
      if (stepFault.busy === true) {
        outcome = { state: "guarded", guardedReason: "busy" };
      } else if (stepFault.injectedOutcome !== undefined) {
        outcome = normalizeHandlerOutcome(stepFault.injectedOutcome);
      } else if (stepFault.jsonRpcError !== undefined) {
        outcome = {
          state: "failed",
          error: { code: "command_failure", message: stepFault.jsonRpcError.message },
        };
      } else {
        outcome = await this.#callHandler(registration.handler, step.params, context);
      }
      if (outcome.state === "completed") {
        const inlineBytes = jsonPayloadBytes(outcome.result).byteLength;
        if (hasDeclaredArtifactShape(outcome.result)) {
          outcome = invalidResult("batch-inline-only command returned artifact data");
        } else if (inlineBytes > BATCH_MAX_INLINE_RESULT_BYTES) {
          outcome = invalidResult(
            `batch-inline-only command result exceeds ${BATCH_MAX_INLINE_RESULT_BYTES} bytes`,
          );
        }
      }
      this.#recordOutcome(step.invocationId, step.method, ordinal, outcome);
      executed.push({ step, outcome });
      if (outcome.state !== "completed") {
        triggerIndex = step.index;
        break;
      }

      const projection = this.#batchProjection(batchId, batchDigest, steps, executed);
      const tentativeBytes = jsonPayloadBytes({ jsonrpc: "2.0", id: requestId, result: projection }).byteLength;
      if (tentativeBytes > maxAggregateResultBytes) {
        executed[executed.length - 1] = {
          step,
          outcome: {
            state: "failed",
            error: {
              code: "response_payload_limit",
              message: "Tentative batch response exceeds aggregate cap",
              maxResponsePayloadBytes: maxAggregateResultBytes,
              tentativeResponsePayloadBytes: tentativeBytes,
            },
          },
        };
        triggerIndex = step.index;
        break;
      }
    }

    let result: JsonObject;
    if (triggerIndex === null) {
      const completed = this.#completedBatchResult(batchId, batchDigest, executed);
      if (fault.finalBatchResponseFault === "omit_batch_digest") delete completed.batchDigest;
      const candidateResponse: JsonObject = { jsonrpc: "2.0", id: requestId, result: completed };
      const contractError = this.#responseContractError("execute_batch", requestId, candidateResponse);
      if (contractError === null) {
        group.assimilate();
        return candidateResponse;
      }
      const trigger = executed[executed.length - 1];
      if (!trigger) throw new Error("Completed batch has no validation trigger step");
      triggerIndex = trigger.step.index;
      executed[executed.length - 1] = {
        step: trigger.step,
        outcome: invalidResult(`final batch response is invalid: ${contractError}`),
      };
      this.#observe(
        trigger.step.invocationId,
        trigger.step.method,
        "failed",
        this.#executionOrdinalFor(trigger.step.invocationId),
        null,
        contractError,
      );
    }

    const trigger = executed[executed.length - 1];
    if (!trigger || triggerIndex === null) throw new Error("Batch trigger is unavailable");
    try {
      group.rollback();
      result = this.#rolledBackBatchResult(batchId, batchDigest, steps, executed, triggerIndex);
    } catch (error) {
      result = this.#indeterminateBatchResult(
        batchId,
        batchDigest,
        steps,
        executed,
        triggerIndex,
        boundedMessage(error),
      );
    }
    const response: JsonObject = { jsonrpc: "2.0", id: requestId, result };
    const finalError = this.#responseContractError("execute_batch", requestId, response);
    if (finalError !== null) {
      return jsonRpcError(requestId, -32603, "Invalid rolled-back batch result", {
        validationError: finalError,
      });
    }
    return response;
  }

  #batchProjection(
    batchId: string,
    batchDigest: string,
    steps: readonly BatchStep[],
    executed: readonly ExecutedStep[],
  ): JsonObject {
    const outcomes: JsonValue[] = executed.map(({ step, outcome }) =>
      outcome.state === "completed"
        ? {
            index: step.index,
            invocationId: step.invocationId,
            method: step.method,
            executionState: "completed",
            effectState: step.effect === "model_transaction" ? "committed" : "read_only",
            result: outcome.result,
          }
        : this.#triggerOutcome(step, outcome, "batch_rolled_back"),
    );
    for (let index = executed.length; index < steps.length; index += 1) {
      outcomes.push(this.#notStarted(steps[index] as BatchStep));
    }
    return {
      resultContractVersion: 2,
      batchContractVersion: 1,
      batchId,
      batchDigest,
      atomic: true,
      status: "completed",
      transactionState: "committed",
      failedStepIndex: null,
      steps: outcomes,
      rollback: {
        attempted: false,
        succeeded: null,
        triggerStepIndex: null,
        triggerState: null,
      },
    };
  }

  #completedBatchResult(
    batchId: string,
    batchDigest: string,
    executed: readonly ExecutedStep[],
  ): JsonObject {
    return {
      resultContractVersion: 2,
      batchContractVersion: 1,
      batchId,
      batchDigest,
      atomic: true,
      status: "completed",
      transactionState: "committed",
      failedStepIndex: null,
      steps: executed.map(({ step, outcome }): JsonValue => {
        if (outcome.state !== "completed") throw new Error("Committed batch contains non-success");
        return {
          index: step.index,
          invocationId: step.invocationId,
          method: step.method,
          executionState: "completed",
          effectState: step.effect === "model_transaction" ? "committed" : "read_only",
          result: outcome.result,
        };
      }),
      rollback: {
        attempted: false,
        succeeded: null,
        triggerStepIndex: null,
        triggerState: null,
      },
    };
  }

  #rolledBackBatchResult(
    batchId: string,
    batchDigest: string,
    steps: readonly BatchStep[],
    executed: readonly ExecutedStep[],
    triggerIndex: number,
  ): JsonObject {
    const trigger = executed[executed.length - 1];
    if (!trigger || trigger.outcome.state === "completed") throw new Error("Rollback trigger is invalid");
    const outcomes: JsonValue[] = executed.map(({ step, outcome }) =>
      outcome.state === "completed"
        ? {
            index: step.index,
            invocationId: step.invocationId,
            method: step.method,
            executionState: "completed",
            effectState: step.effect === "model_transaction" ? "rolled_back" : "discarded",
            resultSuppressed: "batch_rolled_back",
          }
        : this.#triggerOutcome(step, outcome, "batch_rolled_back"),
    );
    for (let index = executed.length; index < steps.length; index += 1) {
      outcomes.push(this.#notStarted(steps[index] as BatchStep));
    }
    return {
      resultContractVersion: 2,
      batchContractVersion: 1,
      batchId,
      batchDigest,
      atomic: true,
      status: trigger.outcome.state,
      transactionState: "rolled_back",
      failedStepIndex: triggerIndex,
      steps: outcomes,
      rollback: {
        attempted: true,
        succeeded: true,
        triggerStepIndex: triggerIndex,
        triggerState: trigger.outcome.state,
      },
    };
  }

  #indeterminateBatchResult(
    batchId: string,
    batchDigest: string,
    steps: readonly BatchStep[],
    executed: readonly ExecutedStep[],
    triggerIndex: number,
    rollbackMessage: string,
  ): JsonObject {
    const trigger = executed[executed.length - 1];
    if (!trigger || trigger.outcome.state === "completed") throw new Error("Rollback trigger is invalid");
    const outcomes: JsonValue[] = executed.map(({ step, outcome }) => {
      const base: BatchStepOutcome = {
        index: step.index,
        invocationId: step.invocationId,
        method: step.method,
        executionState: outcome.state,
        effectState: step.effect === "model_transaction" ? "indeterminate" : "discarded",
        resultSuppressed: "batch_indeterminate",
      };
      if (outcome.state === "guarded") base.guardedReason = outcome.guardedReason;
      if (outcome.state === "failed") base.error = outcome.error as unknown as JsonObject;
      return base;
    });
    for (let index = executed.length; index < steps.length; index += 1) {
      outcomes.push(this.#notStarted(steps[index] as BatchStep));
    }
    return {
      resultContractVersion: 2,
      batchContractVersion: 1,
      batchId,
      batchDigest,
      atomic: true,
      status: "indeterminate",
      transactionState: "indeterminate",
      failedStepIndex: triggerIndex,
      steps: outcomes,
      rollback: {
        attempted: true,
        succeeded: false,
        triggerStepIndex: triggerIndex,
        triggerState: trigger.outcome.state,
        error: { code: "rollback_failure", message: rollbackMessage },
      },
    };
  }

  #triggerOutcome(
    step: BatchStep,
    outcome: Exclude<HandlerOutcome, { state: "completed" }>,
    suppression: "batch_rolled_back" | "batch_indeterminate",
  ): BatchStepOutcome {
    const result: BatchStepOutcome = {
      index: step.index,
      invocationId: step.invocationId,
      method: step.method,
      executionState: outcome.state,
      effectState:
        suppression === "batch_indeterminate"
          ? step.effect === "model_transaction"
            ? "indeterminate"
            : "discarded"
          : step.effect === "model_transaction"
            ? "rolled_back"
            : "discarded",
      resultSuppressed: suppression,
    };
    if (outcome.state === "guarded") result.guardedReason = outcome.guardedReason;
    if (outcome.state === "failed") {
      result.error = {
        code: outcome.error.code,
        message: outcome.error.message,
        ...(outcome.error.code === "response_payload_limit"
          ? {
              maxResponsePayloadBytes: outcome.error.maxResponsePayloadBytes as number,
              tentativeResponsePayloadBytes: outcome.error.tentativeResponsePayloadBytes as number,
            }
          : {}),
      };
    }
    return result;
  }

  #notStarted(step: BatchStep): BatchStepOutcome {
    return {
      index: step.index,
      invocationId: step.invocationId,
      method: step.method,
      executionState: "not_started",
      effectState: "not_started",
    };
  }

  async #callHandler(
    handler: FixtureHandler,
    params: JsonObject,
    context: HandlerContext,
  ): Promise<HandlerOutcome> {
    let raw: unknown;
    try {
      raw = await handler(structuredClone(params), context);
    } catch (error) {
      return {
        state: "failed",
        error: { code: "command_failure", message: boundedMessage(error) },
      };
    }
    try {
      return normalizeHandlerOutcome(raw);
    } catch (error) {
      return invalidResult(error);
    }
  }

  #beginExecution(requestId: string, method: string): number {
    this.#executionSequence += 1;
    this.#dispatchCounts.set(requestId, (this.#dispatchCounts.get(requestId) ?? 0) + 1);
    this.#methodCounts.set(method, (this.#methodCounts.get(method) ?? 0) + 1);
    this.#observe(requestId, method, "dispatch_started", this.#executionSequence, null, null);
    return this.#executionSequence;
  }

  #recordOutcome(
    requestId: string,
    method: string,
    ordinal: number,
    outcome: HandlerOutcome,
  ): void {
    const phase: ObservationPhase =
      outcome.state === "completed" ? "dispatch_finished" : outcome.state;
    const detail =
      outcome.state === "guarded"
        ? outcome.guardedReason
        : outcome.state === "failed"
          ? outcome.error.message
          : null;
    this.#observe(requestId, method, phase, ordinal, null, detail);
  }

  #responseOutcome(response: JsonObject): HandlerOutcome {
    if ("error" in response) {
      const error = isObject(response.error) ? response.error : {};
      return {
        state: "failed",
        error: { code: "command_failure", message: boundedMessage(error.message) },
      };
    }
    const result = isObject(response.result) ? response.result : {};
    if (result.status === "guarded" || result.guarded === true || result.state === "guarded") {
      return {
        state: "guarded",
        guardedReason:
          typeof result.guardedReason === "string" ? result.guardedReason : "guarded",
      };
    }
    if (result.status === "failed" || result.status === "indeterminate" || result.state === "failed") {
      return {
        state: "failed",
        error: { code: "command_failure", message: String(result.status ?? result.state) },
      };
    }
    return { state: "completed", result };
  }

  async #send(
    socket: Socket,
    requestId: string | null,
    method: string | null,
    response: JsonObject,
    effect: Effect,
    fault: FaultPlan = {},
    executionOrdinal: number | null = null,
  ): Promise<void> {
    const responseError = isObject(response.error) ? response.error : null;
    const isUncorrelatedParseError =
      response.id === null && responseError?.code === -32700;
    if (requestId !== null && method !== null && !isUncorrelatedParseError) {
      try {
        this.#validator.validateResponse(method, requestId, response);
      } catch (error) {
        response = jsonRpcError(requestId, -32603, "Fixture generated an invalid response", {
          validationError: boundedMessage(error),
        });
      }
    }
    let payload = jsonPayloadBytes(response);
    if (payload.byteLength > MAX_RESPONSE_PAYLOAD_BYTES) {
      this.#observe(
        requestId,
        method,
        "response_overflow",
        null,
        payload.byteLength,
        effect === "model_transaction" ? "indeterminate_verification_required" : "read_only_failure",
      );
      response = jsonRpcError(requestId, -32603, "Response payload exceeds advertised cap", {
        maxResponsePayloadBytes: MAX_RESPONSE_PAYLOAD_BYTES,
        responsePayloadBytes: payload.byteLength,
        effectDisposition:
          effect === "model_transaction" ? "indeterminate_verification_required" : "failed",
      });
      payload = jsonPayloadBytes(response);
    }
    if (socket.destroyed) return;
    const frame = encodeJsonFrame(response, MAX_RESPONSE_PAYLOAD_BYTES);
    if (fault.disconnect === "after_response_bytes") {
      const requestedBytes = Number(fault.afterResponseBytes);
      const prefixBytes = Math.min(requestedBytes, frame.byteLength - 1);
      await new Promise<void>((resolve, reject) => {
        socket.write(frame.subarray(0, prefixBytes), (error) =>
          error ? reject(error) : resolve(),
        );
      });
      socket.destroy();
      this.#observe(
        requestId,
        method,
        "disconnected",
        executionOrdinal,
        prefixBytes,
        `after_response_bytes:${prefixBytes}`,
      );
      this.#observe(
        requestId,
        method,
        "late_outcome",
        executionOrdinal,
        payload.byteLength,
        "terminal outcome was only partially delivered",
      );
      return;
    }
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (error) => (error ? reject(error) : resolve()));
    });
    this.#observe(requestId, method, "response_sent", null, payload.byteLength, null);
  }

  #statusResult(): JsonObject {
    if (!this.#address) throw new Error("Fixture address is unavailable");
    const result = {
      resultContractVersion: 2,
      addinLoopbackContractVersion: 1,
      addinVersion: this.#options.addinVersion,
      revit: {
        version: this.#options.revitVersion,
        build: this.#options.revitBuild,
        processId: this.#options.processId,
      },
      service: {
        isRunning: true,
        port: this.#address.port,
        binding: "loopback_only",
        boundAddresses: [this.#address.host],
        framing: {
          protocol: "length_prefixed_jsonrpc_v1",
          headerBytes: 4,
          byteOrder: "big_endian",
          payloadEncoding: "utf-8",
          maxRequestPayloadBytes: this.#options.maxRequestPayloadBytes,
          maxResponsePayloadBytes: MAX_RESPONSE_PAYLOAD_BYTES,
        },
      },
      sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
      capabilityContracts: {
        batch_atomic: {
          contractVersion: 1,
          method: "execute_batch",
          maxSteps: 64,
          maxRequestPayloadBytes: this.#options.maxRequestPayloadBytes,
          maxResponsePayloadBytes: MAX_RESPONSE_PAYLOAD_BYTES,
          transactionBoundary: "revit_transaction_group",
          rollbackPolicy: "rollback_on_non_success",
          batchableCommands: BATCHABLE_DESCRIPTORS,
        },
        doc_context_cached_v1: {
          contractVersion: 1,
          method: "get_document_context",
          source: "application_events_cache",
          pollIntervalMs: 15000,
          uiThreadRoundTrip: false,
        },
      },
      activeTask: this.#activeTask ? structuredClone(this.#activeTask) : null,
      recentTasks: structuredClone(this.#recentTasks),
      recentHistoryCount: this.#recentTasks.length,
      recentHistoryCapacity: 100,
      plan: { pending: [], completed: ["O1-T3 fixture"] },
    };
    return result as unknown as JsonObject;
  }

  #responseContractError(method: string, requestId: string, response: JsonObject): string | null {
    const jsonError = jsonValueError(response);
    if (jsonError) return jsonError;
    const payloadBytes = jsonPayloadBytes(response).byteLength;
    if (payloadBytes > MAX_RESPONSE_PAYLOAD_BYTES) {
      return `response payload ${payloadBytes} exceeds cap ${MAX_RESPONSE_PAYLOAD_BYTES}`;
    }
    try {
      this.#validator.validateResponse(method, requestId, response);
      return null;
    } catch (error) {
      return boundedMessage(error);
    }
  }

  #validateDocumentContext(snapshot: DocumentContextSnapshot): void {
    const requestId = "fixture-document-context-validation";
    const response: JsonObject = {
      jsonrpc: "2.0",
      id: requestId,
      result: snapshot as unknown as JsonObject,
    };
    const error = this.#responseContractError("get_document_context", requestId, response);
    if (error) throw new ContractValidationError("invalid_response", error);
  }

  #beginTask(requestId: string, method: string, requestBytes: number): MutableTaskInfo {
    const task: MutableTaskInfo = {
      id: `fixture-task-${this.#observationSequence + 1}`,
      requestId,
      method,
      taskName: `fixture:${method}`,
      state: "running",
      startedAtUtc: new Date().toISOString(),
      finishedAtUtc: null,
      elapsedMs: 0,
      port: this.#address?.port ?? 1,
      error: null,
      framing: "length-prefixed",
      requestBytes,
      receiveMs: 0,
      parseMs: 0,
      executeMs: null,
      responseBytes: null,
    };
    if (method !== "mcp_status") this.#activeTask = task;
    return task;
  }

  #finishTask(task: MutableTaskInfo, outcome: HandlerOutcome, responseBytes: number | null): void {
    task.state = outcome.state;
    task.finishedAtUtc = new Date().toISOString();
    task.executeMs = 0;
    task.responseBytes = responseBytes;
    if (outcome.state === "failed") task.error = outcome.error.message;
    if (this.#activeTask === task) this.#activeTask = null;
    this.#recentTasks.unshift(structuredClone(task));
    if (this.#recentTasks.length > 100) this.#recentTasks.length = 100;
  }

  #observe(
    requestId: string | null,
    method: string | null,
    phase: ObservationPhase,
    executionOrdinal: number | null,
    payloadBytes: number | null,
    detail: string | null,
  ): void {
    this.#observationSequence += 1;
    this.#observations.push({
      sequence: this.#observationSequence,
      requestId,
      method,
      phase,
      executionOrdinal,
      payloadBytes,
      detail,
    });
  }

  #executionOrdinalFor(requestId: string): number | null {
    for (let index = this.#observations.length - 1; index >= 0; index -= 1) {
      const observation = this.#observations[index];
      if (
        observation?.requestId === requestId &&
        observation.phase === "dispatch_started"
      ) {
        return observation.executionOrdinal;
      }
    }
    return null;
  }

  #takeFault(requestId: string): FaultPlan {
    const queue = this.#faults.get(requestId);
    const fault = queue?.shift();
    if (!queue || queue.length === 0) this.#faults.delete(requestId);
    return fault ?? {};
  }

  async #stall(requestId: string): Promise<boolean> {
    let settle: (released: boolean) => void = () => undefined;
    const promise = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const release = (): void => settle(true);
    const cancel = (): void => settle(false);
    const queue = this.#stallLatches.get(requestId) ?? [];
    queue.push({ promise, release, cancel });
    this.#stallLatches.set(requestId, queue);
    return promise;
  }

  #cancelAllStalls(): void {
    for (const queue of this.#stallLatches.values()) {
      for (const latch of queue) latch.cancel();
    }
    this.#stallLatches.clear();
  }

  async #crash(requestId: string, method: string, phase: string): Promise<void> {
    this.#crashed = true;
    this.#observe(requestId, method, "crashed", null, null, phase);
    this.#cancelAllStalls();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    this.#address = null;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }
}
