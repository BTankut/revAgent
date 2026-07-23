import {
  assertValidCaseControlStepSemantics,
  type CaseControlStep,
  type CaseObservationRequirement,
  type StepCaptureMetadata,
  type StepExpectedOutcome,
} from "./casePrograms.js";
import { assertObservationOnlyBatch } from "./adapters.js";
import type { JsonObject, JsonValue } from "./processHarness.js";
import { stableJson } from "./stableJson.js";
import {
  BINDINGS,
  COMPONENT_IDS,
  type Binding,
  type ComponentId,
  type ProcessObservationRecord,
} from "./types.js";

const OBSERVATION_KINDS = [
  "control_result",
  "wire_event",
  "gateway_snapshot",
  "bridge_snapshot",
  "fixture_snapshot",
  "fixture_execution_count",
  "resource_sample",
  "process_lifecycle",
] as const satisfies readonly ProcessObservationRecord["kind"][];

const OBSERVATION_KEYS = [
  "schemaVersion",
  "observationId",
  "runId",
  "caseId",
  "binding",
  "componentId",
  "kind",
  "at",
  "payload",
] as const;

const CAPTURE_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]*$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EXACT_SUBSTITUTION = /^\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}$/u;
const EMBEDDED_SUBSTITUTION = /\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/gu;
const OBSERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export type RawStepOutcome =
  | {
      kind: "success";
      result: JsonValue;
      observations?: ProcessObservationRecord[];
    }
  | {
      kind: "control_error";
      code: string;
      message: string;
      details?: JsonValue;
      observations?: ProcessObservationRecord[];
    }
  | {
      kind: "http_response";
      status: number;
      headers: Readonly<Record<string, string>>;
      body: JsonValue;
      observations?: ProcessObservationRecord[];
    }
  | {
      kind: "close";
      code: number;
      reason: string;
      observations?: ProcessObservationRecord[];
    };

export interface ParentStepDriverRequest {
  runId: string;
  caseId: string;
  binding: Binding;
  stepId: string;
  phase: CaseControlStep["phase"];
  channel: CaseControlStep["channel"];
  componentId: ComponentId | null;
  action: CaseControlStep["action"];
  executionMode: CaseControlStep["execution"]["mode"];
  dispatchMode: "sequential" | "concurrent";
  deadlineAtMs: number;
  signal: AbortSignal;
  arguments: JsonObject;
}

/**
 * A driver reports transport/control facts only. The parent step engine owns
 * expected-outcome matching and the parent case evaluator owns conformance
 * verdicts.
 */
export type ParentStepDriver = (request: Readonly<ParentStepDriverRequest>) => Promise<RawStepOutcome>;

export interface ParentStepDrivers {
  gateway_http_control: ParentStepDriver;
  bridge_jsonl_control: ParentStepDriver;
  fixture_jsonl_control: ParentStepDriver;
  parent_harness: ParentStepDriver;
  abortAndDrain(context: ParentStepAbortContext): Promise<void>;
}

export type RawBindingStepHooks = Partial<Record<Binding, ParentStepDriver>>;

export interface ParentStepAbortContext {
  runId: string;
  caseId: string;
  binding: Binding;
  reason: Error;
  activeRequests: readonly ParentStepDriverRequest[];
  deadlineAtMs: number;
  signal: AbortSignal;
}

export interface ParentStepExecutionInput {
  runId: string;
  caseId: string;
  binding: Binding;
  steps: readonly CaseControlStep[];
  drivers: ParentStepDrivers;
  variables?: Readonly<Record<string, JsonValue>>;
  now?: () => string;
  signal?: AbortSignal;
  drainTimeoutMs?: number;
}

/**
 * Deliberately contains no top-level verdict/status field. Opaque protocol
 * payloads may use ordinary domain keys named actual or passed, but these raw
 * execution facts must still be evaluated by a parent-owned case evaluator.
 */
export interface ParentStepExecutionEvidence {
  observations: ProcessObservationRecord[];
  captures: Readonly<Record<string, JsonValue>>;
  completedStepIds: string[];
  stepObservations: StepObservationLineage[];
}

export interface StepObservationLineage {
  stepId: string;
  observationIds: string[];
}

interface StartedStep {
  handle: string | null;
  step: CaseControlStep;
  request: ParentStepDriverRequest;
  settled: Promise<SettledStep>;
  controller: AbortController;
  driverOutcome: Promise<RawStepOutcome>;
}

type SettledStep =
  | {
      step: CaseControlStep;
      request: ParentStepDriverRequest;
      outcome: RawStepOutcome;
    }
  | {
      step: CaseControlStep;
      request: ParentStepDriverRequest;
      error: Error;
    };

interface PreparedStep {
  stepId: string;
  captures: Array<[string, JsonValue]>;
  observations: ProcessObservationRecord[];
}

export class ParentStepOutcomeError extends Error {
  constructor(
    readonly stepId: string,
    readonly expectedKind: StepExpectedOutcome["kind"],
    readonly observedKind: RawStepOutcome["kind"],
    detail: string,
  ) {
    super(`${stepId} expected ${expectedKind}, observed ${observedKind}: ${detail}`);
    this.name = "ParentStepOutcomeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key));
}

function assertJsonValue(value: unknown, path = "$"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} is not a finite JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}/${index}`));
    return;
  }
  if (!isRecord(value)) throw new Error(`${path} is not a JSON value`);
  for (const [key, entry] of Object.entries(value)) {
    assertJsonValue(entry, `${path}/${key}`);
  }
}

function assertDateTimeString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !RFC3339_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} is not an RFC 3339 date-time string`);
  }
}

function assertStrictObservation(
  value: ProcessObservationRecord,
  expected: { runId: string; caseId: string; binding: Binding },
): void {
  if (!isRecord(value)) throw new Error("raw step observation must be a plain object");
  const keys = Object.keys(value).sort();
  const expectedKeys = [...OBSERVATION_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("raw step observation has unknown or missing top-level fields");
  }
  if (value.schemaVersion !== "rbp-process-observation/v2" ||
    typeof value.observationId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.caseId !== "string" ||
    typeof value.binding !== "string" ||
    typeof value.componentId !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.at !== "string") {
    throw new Error("raw step observation identity fields have invalid types");
  }
  if (!OBSERVATION_ID.test(value.observationId)) {
    throw new Error(`raw step observation has invalid id ${value.observationId}`);
  }
  if (!(COMPONENT_IDS as readonly string[]).includes(value.componentId) ||
    !(OBSERVATION_KINDS as readonly string[]).includes(value.kind)) {
    throw new Error(`raw step observation ${value.observationId} has an invalid component or kind`);
  }
  assertDateTimeString(value.at, `raw step observation ${value.observationId} timestamp`);
  assertJsonValue(value.payload, `/observations/${value.observationId}/payload`);
  if (Buffer.byteLength(stableJson(value.payload), "utf8") > 64 * 1024) {
    throw new Error(`raw step observation ${value.observationId} payload exceeds 64 KiB`);
  }
  assertObservationOnlyBatch({ observations: [value] }, expected);
}

const HARNESS_OBSERVATION_PROVENANCE: Readonly<Record<
  Extract<CaseControlStep, { channel: "parent_harness" }>["action"],
  {
    pairs: ReadonlyArray<readonly [ComponentId, ProcessObservationRecord["kind"]]>;
  }
>> = {
  restart_case_stack: {
    pairs: COMPONENT_IDS.map((component) => [component, "process_lifecycle"] as const),
  },
  stop_case_stack: {
    pairs: COMPONENT_IDS.map((component) => [component, "process_lifecycle"] as const),
  },
  begin_wire_capture: {
    pairs: COMPONENT_IDS.map((component) => [component, "wire_event"] as const),
  },
  end_wire_capture: {
    pairs: COMPONENT_IDS.map((component) => [component, "wire_event"] as const),
  },
  await_condition: {
    pairs: [
      ["gateway_stub", "gateway_snapshot"],
      ["bridge_simulator", "bridge_snapshot"],
      ["addin_loopback_fixture", "fixture_snapshot"],
      ["addin_loopback_fixture", "fixture_execution_count"],
    ],
  },
  send_binding_frame: {
    pairs: [
      ["gateway_stub", "wire_event"],
      ["bridge_simulator", "wire_event"],
    ],
  },
  send_fixture_frame: {
    pairs: [
      ["bridge_simulator", "wire_event"],
      ["addin_loopback_fixture", "wire_event"],
    ],
  },
  send_split_fixture_frame: {
    pairs: [
      ["bridge_simulator", "wire_event"],
      ["addin_loopback_fixture", "wire_event"],
    ],
  },
  send_coalesced_fixture_frames: {
    pairs: [
      ["bridge_simulator", "wire_event"],
      ["addin_loopback_fixture", "wire_event"],
    ],
  },
  restart_component: {
    pairs: COMPONENT_IDS.map((component) => [component, "process_lifecycle"] as const),
  },
  spawn_fixture_bind_probe: {
    pairs: [
      ["addin_loopback_fixture", "wire_event"],
      ["addin_loopback_fixture", "process_lifecycle"],
    ],
  },
  execute_product_artifact_scenario: {
    pairs: [
      ["bridge_simulator", "bridge_snapshot"],
    ],
  },
  capture_resource_sample: {
    pairs: COMPONENT_IDS.map((component) => [component, "resource_sample"] as const),
  },
};

function componentObservationKinds(step: Exclude<CaseControlStep, { channel: "parent_harness" }>): readonly ProcessObservationRecord["kind"][] {
  if (step.channel === "gateway_http_control") {
    return step.action === "snapshot" ? ["gateway_snapshot"] : ["wire_event"];
  }
  if (step.channel === "bridge_jsonl_control") {
    return step.action === "snapshot_evidence" ? ["bridge_snapshot"] : ["wire_event"];
  }
  return step.action === "snapshot_evidence"
    ? ["fixture_snapshot", "fixture_execution_count"]
    : ["wire_event"];
}

function assertObservationProvenance(step: CaseControlStep, observation: ProcessObservationRecord): void {
  if (step.channel === "parent_harness") {
    const allowed = HARNESS_OBSERVATION_PROVENANCE[step.action];
    if (!allowed.pairs.some(([component, kind]) =>
      component === observation.componentId && kind === observation.kind)) {
      throw new Error(
        `${step.stepId} observation ${observation.observationId} is outside parent-harness action provenance`,
      );
    }
    return;
  }
  const allowedKinds = componentObservationKinds(step);
  if (observation.componentId !== step.componentId || !allowedKinds.includes(observation.kind)) {
    throw new Error(
      `${step.stepId} observation ${observation.observationId} is outside ${step.channel} provenance`,
    );
  }
}

function assertRawStepOutcome(
  value: unknown,
  expected: { runId: string; caseId: string; binding: Binding },
): asserts value is RawStepOutcome {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("step driver outcome must be a discriminated object");
  }
  const optionalObservations = ["observations"];
  switch (value.kind) {
    case "success":
      if (!exactKeys(value, ["kind", "result"], optionalObservations)) {
        throw new Error("success outcome has unknown or missing fields");
      }
      assertJsonValue(value.result, "/outcome/result");
      break;
    case "control_error":
      if (!exactKeys(value, ["kind", "code", "message"], ["details", ...optionalObservations]) ||
        typeof value.code !== "string" || value.code.length === 0 ||
        typeof value.message !== "string" || value.message.length === 0) {
        throw new Error("control-error outcome has unknown, missing, or invalid fields");
      }
      if (Object.prototype.hasOwnProperty.call(value, "details")) {
        assertJsonValue(value.details, "/outcome/details");
      }
      break;
    case "http_response":
      if (!exactKeys(value, ["kind", "status", "headers", "body"], optionalObservations) ||
        !Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599 ||
        !isRecord(value.headers)) {
        throw new Error("HTTP outcome has unknown, missing, or invalid fields");
      }
      for (const [header, headerValue] of Object.entries(value.headers)) {
        if (!HTTP_HEADER_NAME.test(header) || typeof headerValue !== "string") {
          throw new Error("HTTP outcome headers are invalid");
        }
      }
      assertJsonValue(value.body, "/outcome/body");
      break;
    case "close":
      if (!exactKeys(value, ["kind", "code", "reason"], optionalObservations) ||
        !Number.isInteger(value.code) || Number(value.code) < 1000 || Number(value.code) > 4999 ||
        typeof value.reason !== "string") {
        throw new Error("close outcome has unknown, missing, or invalid fields");
      }
      break;
    default:
      throw new Error(`step driver returned unknown outcome kind ${value.kind}`);
  }
  if (Object.prototype.hasOwnProperty.call(value, "observations")) {
    if (!Array.isArray(value.observations)) throw new Error("step driver observations must be an array");
    for (const observation of value.observations) {
      assertStrictObservation(observation as ProcessObservationRecord, expected);
    }
  }
}

function responseValue(outcome: RawStepOutcome): JsonObject {
  switch (outcome.kind) {
    case "success":
      return { kind: outcome.kind, result: structuredClone(outcome.result) };
    case "control_error":
      return {
        kind: outcome.kind,
        code: outcome.code,
        message: outcome.message,
        ...(outcome.details === undefined ? {} : { details: structuredClone(outcome.details) }),
      };
    case "http_response":
      return {
        kind: outcome.kind,
        status: outcome.status,
        headers: { ...outcome.headers },
        body: structuredClone(outcome.body),
      };
    case "close":
      return { kind: outcome.kind, code: outcome.code, reason: outcome.reason };
  }
}

function assertExpectedOutcome(step: CaseControlStep, outcome: RawStepOutcome): void {
  const expected = step.expectedOutcome;
  if (expected.kind === "success" && outcome.kind === "success") return;
  if (expected.kind === "control_error" && outcome.kind === "control_error" &&
    outcome.code === expected.code &&
    (expected.messageIncludes === undefined || outcome.message.includes(expected.messageIncludes))) return;
  if (expected.kind === "http_status" && outcome.kind === "http_response" &&
    outcome.status === expected.status) return;
  if (expected.kind === "close" && outcome.kind === "close" &&
    outcome.code === expected.code &&
    (expected.reasonIncludes === undefined || outcome.reason.includes(expected.reasonIncludes))) return;

  let detail = "outcome kind did not match";
  if (expected.kind === "control_error" && outcome.kind === "control_error") {
    detail = `code/message did not match (${outcome.code}: ${outcome.message})`;
  } else if (expected.kind === "http_status" && outcome.kind === "http_response") {
    detail = `HTTP status ${outcome.status} did not match ${expected.status}`;
  } else if (expected.kind === "close" && outcome.kind === "close") {
    detail = `close ${outcome.code} ${outcome.reason} did not match`;
  }
  throw new ParentStepOutcomeError(step.stepId, expected.kind, outcome.kind, detail);
}

function decodePointerSegment(segment: string): string {
  if (segment.includes("~") && /~(?![01])/u.test(segment)) {
    throw new Error(`invalid JSON pointer escape in ${segment}`);
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function jsonPointer(value: JsonValue, pointer: string, label: string): JsonValue {
  if (pointer === "") return structuredClone(value);
  if (!pointer.startsWith("/")) throw new Error(`${label} JSON pointer must begin with /`);
  let current: JsonValue = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) throw new Error(`${label} JSON pointer contains a reserved segment`);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) throw new Error(`${label} JSON pointer array index is invalid`);
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) throw new Error(`${label} JSON pointer does not resolve`);
      current = current[index]!;
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment] as JsonValue;
    } else {
      throw new Error(`${label} JSON pointer does not resolve`);
    }
  }
  return structuredClone(current);
}

function captureValue(capture: StepCaptureMetadata, outcome: RawStepOutcome, stepId: string): JsonValue {
  switch (capture.source) {
    case "result":
      if (outcome.kind !== "success") throw new Error(`${stepId} result capture requires a success outcome`);
      return jsonPointer(outcome.result, capture.jsonPointer, `${stepId}/${capture.name}`);
    case "control_error":
      if (outcome.kind !== "control_error") throw new Error(`${stepId} control-error capture requires a control error`);
      return jsonPointer({
        code: outcome.code,
        message: outcome.message,
        ...(outcome.details === undefined ? {} : { details: outcome.details }),
      }, capture.jsonPointer, `${stepId}/${capture.name}`);
    case "http_body":
      if (outcome.kind !== "http_response") throw new Error(`${stepId} HTTP-body capture requires an HTTP response`);
      return jsonPointer(outcome.body, capture.jsonPointer, `${stepId}/${capture.name}`);
    case "http_header": {
      if (outcome.kind !== "http_response") throw new Error(`${stepId} HTTP-header capture requires an HTTP response`);
      const header = Object.entries(outcome.headers)
        .find(([name]) => name.toLowerCase() === capture.header.toLowerCase())?.[1];
      if (header === undefined) throw new Error(`${stepId} HTTP header ${capture.header} is absent`);
      return header;
    }
    case "close":
      if (outcome.kind !== "close") throw new Error(`${stepId} close capture requires a close outcome`);
      return capture.field === "code" ? outcome.code : outcome.reason;
  }
}

function tokenValue(
  token: string,
  variables: Readonly<Record<string, JsonValue>>,
  captures: ReadonlyMap<string, JsonValue>,
): JsonValue {
  if (!CAPTURE_TOKEN.test(token)) throw new Error(`invalid substitution token ${token}`);
  const exactCapture = captures.get(token);
  if (exactCapture !== undefined) return structuredClone(exactCapture);
  const segments = token.split(".");
  if (segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    throw new Error(`substitution token ${token} contains a reserved segment`);
  }
  let current: unknown = variables;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      throw new Error(`unresolved substitution token ${token}`);
    }
    current = current[segment];
  }
  assertJsonValue(current, `/variables/${token}`);
  return structuredClone(current);
}

function substituteValue(
  value: unknown,
  variables: Readonly<Record<string, JsonValue>>,
  captures: ReadonlyMap<string, JsonValue>,
  path = "$",
): JsonValue {
  if (typeof value === "string") {
    const exact = EXACT_SUBSTITUTION.exec(value);
    if (exact !== null) return tokenValue(exact[1]!, variables, captures);
    return value.replace(EMBEDDED_SUBSTITUTION, (_match, token: string) => {
      const replacement = tokenValue(token, variables, captures);
      if (replacement === null || typeof replacement === "object") {
        throw new Error(`${path} cannot embed non-scalar substitution ${token}`);
      }
      return String(replacement);
    });
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} is not a finite JSON number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => substituteValue(entry, variables, captures, `${path}/${index}`));
  }
  if (!isRecord(value)) throw new Error(`${path} is not substitutable JSON`);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      substituteValue(entry, variables, captures, `${path}/${key}`),
    ]),
  );
}

function stepArguments(
  step: CaseControlStep,
  binding: Binding,
  variables: Readonly<Record<string, JsonValue>>,
  captures: ReadonlyMap<string, JsonValue>,
): JsonObject {
  const merged = {
    ...(step.arguments.common ?? {}),
    ...(step.arguments[binding] ?? {}),
  };
  const substituted = substituteValue(merged, variables, captures, `/steps/${step.stepId}/arguments`);
  if (!isRecord(substituted)) throw new Error(`${step.stepId} arguments must resolve to an object`);
  return substituted as JsonObject;
}

function argumentTemplate(step: CaseControlStep, binding: Binding): Readonly<Record<string, unknown>> {
  return {
    ...(step.arguments.common ?? {}),
    ...(step.arguments[binding] ?? {}),
  };
}

function seedValue(
  token: string,
  variables: Readonly<Record<string, JsonValue>>,
): JsonValue {
  return tokenValue(token, variables, new Map());
}

function assertSubstitutionPreflight(
  value: unknown,
  variables: Readonly<Record<string, JsonValue>>,
  availableCaptures: ReadonlySet<string>,
  path: string,
): void {
  if (typeof value === "string") {
    const matches = [...value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/gu)];
    const remainder = value.replace(/\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/gu, "");
    if (remainder.includes("{{") || remainder.includes("}}")) {
      throw new Error(`${path} contains malformed substitution syntax`);
    }
    const exact = EXACT_SUBSTITUTION.exec(value);
    for (const match of matches) {
      const token = match[1]!;
      if (availableCaptures.has(token)) {
        continue;
      }
      const resolved = seedValue(token, variables);
      if (exact === null && (resolved === null || typeof resolved === "object")) {
        throw new Error(`${path} cannot embed non-scalar substitution ${token}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSubstitutionPreflight(entry, variables, availableCaptures, `${path}/${index}`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertSubstitutionPreflight(entry, variables, availableCaptures, `${path}/${key}`);
    }
    return;
  }
  assertJsonValue(value, path);
}

function addCaptureNames(target: Set<string>, steps: readonly CaseControlStep[]): void {
  for (const step of steps) {
    for (const capture of step.captures) {
      if (target.has(capture.name)) {
        throw new Error(`capture ${capture.name} is declared more than once in the step plan`);
      }
      target.add(capture.name);
    }
  }
}

function preflightStepPlan(input: ParentStepExecutionInput): void {
  const variables = input.variables ?? {};
  for (const channel of [
    "gateway_http_control",
    "bridge_jsonl_control",
    "fixture_jsonl_control",
    "parent_harness",
  ] as const) {
    if (typeof input.drivers[channel] !== "function") {
      throw new Error(`parent step driver ${channel} is missing`);
    }
  }
  if (typeof input.drivers.abortAndDrain !== "function") {
    throw new Error("parent step abort-and-drain handler is missing");
  }
  const stepIds = new Set<string>();
  const allCaptureNames = new Set<string>();
  addCaptureNames(allCaptureNames, input.steps);
  for (const captureName of allCaptureNames) {
    try {
      seedValue(captureName, variables);
      throw new Error(`capture ${captureName} would shadow an initial variable`);
    } catch (error) {
      if (error instanceof Error && error.message === `capture ${captureName} would shadow an initial variable`) {
        throw error;
      }
      if (!(error instanceof Error) || !error.message.includes("unresolved substitution token")) throw error;
    }
  }

  const availableCaptures = new Set<string>();
  const pending = new Map<string, readonly string[]>();
  const usedHandles = new Set<string>();
  const makeAvailable = (names: readonly string[]): void => names.forEach((name) => availableCaptures.add(name));
  const consume = (handles: "all" | readonly string[]): readonly string[][] => {
    const selected = handles === "all" ? [...pending.keys()] : [...handles];
    return selected.map((handle) => {
      const names = pending.get(handle);
      if (names === undefined) throw new Error(`async handle ${handle} is joined before it is started`);
      pending.delete(handle);
      return [...names];
    });
  };

  for (const step of input.steps) {
    if (stepIds.has(step.stepId)) throw new Error(`duplicate step id ${step.stepId}`);
    stepIds.add(step.stepId);
    assertValidCaseControlStepSemantics(step);

    if (step.execution.mode === "barrier") {
      consume(step.execution.handles).forEach(makeAvailable);
    }
    assertSubstitutionPreflight(
      argumentTemplate(step, input.binding),
      variables,
      availableCaptures,
      `/steps/${step.stepId}/arguments`,
    );

    switch (step.execution.mode) {
      case "sequential":
      case "barrier":
        makeAvailable(step.captures.map(({ name }) => name));
        break;
      case "async_start":
        if (usedHandles.has(step.execution.handle)) {
          throw new Error(`async handle ${step.execution.handle} is declared more than once`);
        }
        usedHandles.add(step.execution.handle);
        pending.set(step.execution.handle, step.captures.map(({ name }) => name));
        break;
      case "async_join":
        consume(step.execution.handles).forEach(makeAvailable);
        makeAvailable(step.captures.map(({ name }) => name));
        break;
    }
  }
  if (pending.size > 0) {
    throw new Error(`unjoined async handles remain: ${[...pending.keys()].join(", ")}`);
  }
}

function driverFor(drivers: ParentStepDrivers, channel: CaseControlStep["channel"]): ParentStepDriver {
  return drivers[channel];
}

function parentRequestByteLimit(step: CaseControlStep): number {
  if (step.channel === "parent_harness" && (
    step.action === "send_binding_frame" ||
    step.action === "send_fixture_frame" ||
    step.action === "send_split_fixture_frame" ||
    step.action === "send_coalesced_fixture_frames"
  )) {
    // Canonical C16 must cross the 4 MiB params boundary and later vectors may
    // exercise the 32 MiB result boundary. Raw hooks stream the frame and
    // retain only bounded digest/length metadata as observations.
    return 40 * 1024 * 1024;
  }
  return 64 * 1024;
}

/**
 * Routes raw transport injection through a binding-specific WSS or
 * Streamable-HTTP/SSE hook while retaining an explicit fallback for all other
 * parent-harness controls.
 */
export function createHarnessStepDriverWithRawBindingHooks(
  fallback: ParentStepDriver,
  hooks: RawBindingStepHooks,
): ParentStepDriver {
  return async (request) => {
    if (request.action !== "send_binding_frame") return await fallback(request);
    const hook = hooks[request.binding];
    if (hook === undefined) {
      throw new Error(`no raw ${request.binding} binding hook is installed`);
    }
    return await hook(request);
  };
}

export class ParentStepEngine {
  readonly #captures = new Map<string, JsonValue>();
  readonly #observations: ProcessObservationRecord[] = [];
  readonly #observationIds = new Set<string>();
  readonly #completedStepIds: string[] = [];
  readonly #stepObservations: StepObservationLineage[] = [];
  readonly #pending = new Map<string, StartedStep>();
  readonly #active = new Set<StartedStep>();
  #observationOrdinal = 0;
  private readonly input: ParentStepExecutionInput;

  constructor(input: ParentStepExecutionInput) {
    this.input = {
      ...input,
      steps: structuredClone(input.steps),
      variables: structuredClone(input.variables ?? {}),
      drivers: {
        gateway_http_control: input.drivers.gateway_http_control,
        bridge_jsonl_control: input.drivers.bridge_jsonl_control,
        fixture_jsonl_control: input.drivers.fixture_jsonl_control,
        parent_harness: input.drivers.parent_harness,
        abortAndDrain: input.drivers.abortAndDrain,
      },
      signal: input.signal,
      now: input.now,
    };
    if (typeof this.input.runId !== "string" || typeof this.input.caseId !== "string" ||
      !RUN_ID.test(this.input.runId) || !/^O1-C(?:0[1-9]|[1-3][0-9]|40)$/u.test(this.input.caseId) ||
      !(BINDINGS as readonly string[]).includes(this.input.binding)) {
      throw new Error("parent step execution run/case identity is invalid");
    }
    const now = this.input.now?.() ?? new Date().toISOString();
    assertDateTimeString(now, "parent step execution clock value");
    const drainTimeoutMs = this.input.drainTimeoutMs ?? 10_000;
    if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 60_000) {
      throw new Error("parent abort-and-drain timeout must be an integer from 1 through 60000 milliseconds");
    }
    for (const [name, value] of Object.entries(this.input.variables ?? {})) {
      if (FORBIDDEN_PATH_SEGMENTS.has(name)) throw new Error(`variable root ${name} is reserved`);
      assertJsonValue(value, `/variables/${name}`);
    }
  }

  #start(
    step: CaseControlStep,
    argumentsValue: JsonObject,
    handle: string | null,
    dispatchMode: ParentStepDriverRequest["dispatchMode"],
  ): StartedStep {
    const requestBytes = Buffer.byteLength(stableJson(argumentsValue), "utf8");
    const requestByteLimit = parentRequestByteLimit(step);
    if (requestBytes > requestByteLimit) {
      throw new Error(`${step.stepId} substituted request exceeds ${requestByteLimit} bytes`);
    }
    const timeoutMs = step.parentTimeoutMs;
    const controller = new AbortController();
    const deadlineAtMs = Date.now() + timeoutMs;
    const request: ParentStepDriverRequest = {
      runId: this.input.runId,
      caseId: this.input.caseId,
      binding: this.input.binding,
      stepId: step.stepId,
      phase: step.phase,
      channel: step.channel,
      componentId: step.componentId,
      action: step.action,
      executionMode: step.execution.mode,
      dispatchMode,
      deadlineAtMs,
      signal: controller.signal,
      arguments: argumentsValue,
    };
    // The retained request and the adapter-facing request never share mutable
    // object identity. A buggy adapter cannot rewrite the request evidence
    // after dispatch.
    const driverRequest: ParentStepDriverRequest = {
      ...request,
      arguments: structuredClone(request.arguments),
      signal: controller.signal,
    };
    const parentAbort = (): void => controller.abort(
      this.input.signal?.reason ?? new Error("parent step execution was aborted"),
    );
    if (this.input.signal?.aborted === true) parentAbort();
    else this.input.signal?.addEventListener("abort", parentAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new Error(`${step.stepId} exceeded the parent-owned ${timeoutMs} ms deadline`));
    }, timeoutMs);
    const aborted = new Promise<RawStepOutcome>((_resolve, reject) => {
      const rejectAbort = (): void => {
        const reason = controller.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? "step execution aborted")));
      };
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const driverOutcome = Promise.resolve().then(async () => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error ? reason : new Error(String(reason ?? "step execution aborted"));
      }
      const outcome = await driverFor(this.input.drivers, step.channel)(driverRequest);
      assertRawStepOutcome(outcome, {
        runId: this.input.runId,
        caseId: this.input.caseId,
        binding: this.input.binding,
      });
      return structuredClone(outcome);
    });
    void driverOutcome.catch(() => undefined);
    const settled: Promise<SettledStep> = Promise.race([driverOutcome, aborted]).then(
      (outcome) => ({ step, request, outcome }),
      (error: unknown) => ({
        step,
        request,
        error: error instanceof Error ? error : new Error(String(error)),
      }),
    ).finally(() => {
      clearTimeout(timer);
      this.input.signal?.removeEventListener("abort", parentAbort);
    });
    const started = { handle, step, request, settled, controller, driverOutcome };
    this.#active.add(started);
    void driverOutcome.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.#active.delete(started);
    });
    return started;
  }

  #controlObservation(settled: Extract<SettledStep, { outcome: RawStepOutcome }>): ProcessObservationRecord | null {
    if (settled.step.componentId === null) return null;
    const request = {
      action: settled.step.action,
      arguments: structuredClone(settled.request.arguments),
    };
    const response = responseValue(settled.outcome);
    return {
      schemaVersion: "rbp-process-observation/v2",
      observationId: `${this.input.runId}:${this.input.caseId}:${this.input.binding}:${++this.#observationOrdinal}`,
      runId: this.input.runId,
      caseId: this.input.caseId,
      binding: this.input.binding,
      componentId: settled.step.componentId,
      kind: "control_result",
      at: this.input.now?.() ?? new Date().toISOString(),
      payload: {
        schemaVersion: "rbp-step-control-observation/v1",
        stepId: settled.step.stepId,
        phase: settled.step.phase,
        channel: settled.step.channel,
        executionMode: settled.step.execution.mode,
        dispatchMode: settled.request.dispatchMode,
        request,
        response,
        requestBytes: Buffer.byteLength(stableJson(request), "utf8"),
        responseBytes: Buffer.byteLength(stableJson(response), "utf8"),
      },
    };
  }

  #prepare(settled: SettledStep): PreparedStep {
    if ("error" in settled) {
      throw new Error(`${settled.step.stepId} driver failed: ${settled.error.message}`, { cause: settled.error });
    }
    assertRawStepOutcome(settled.outcome, {
      runId: this.input.runId,
      caseId: this.input.caseId,
      binding: this.input.binding,
    });
    assertExpectedOutcome(settled.step, settled.outcome);
    for (const observation of settled.outcome.observations ?? []) {
      assertObservationProvenance(settled.step, observation);
    }
    const controlObservation = this.#controlObservation(settled);
    const observations = [
      ...(controlObservation === null ? [] : [controlObservation]),
      ...(settled.outcome.observations ?? []).map((observation) => structuredClone(observation)),
    ];
    for (const observation of observations) {
      assertStrictObservation(observation, {
        runId: this.input.runId,
        caseId: this.input.caseId,
        binding: this.input.binding,
      });
    }
    return {
      stepId: settled.step.stepId,
      captures: settled.step.captures.map((capture) => [
        capture.name,
        captureValue(capture, settled.outcome, settled.step.stepId),
      ]),
      observations,
    };
  }

  #applyPrepared(prepared: readonly PreparedStep[]): void {
    const captureNames = new Set(this.#captures.keys());
    const observationIds = new Set(this.#observationIds);
    for (const completion of prepared) {
      for (const [name] of completion.captures) {
        if (captureNames.has(name)) throw new Error(`capture ${name} would overwrite prior evidence`);
        captureNames.add(name);
      }
      for (const observation of completion.observations) {
        if (observationIds.has(observation.observationId)) {
          throw new Error(`duplicate step observation id ${observation.observationId}`);
        }
        observationIds.add(observation.observationId);
      }
    }
    for (const completion of prepared) {
      completion.captures.forEach(([name, value]) => this.#captures.set(name, structuredClone(value)));
      completion.observations.forEach((observation) => {
        this.#observations.push(structuredClone(observation));
        this.#observationIds.add(observation.observationId);
      });
      this.#completedStepIds.push(completion.stepId);
      this.#stepObservations.push({
        stepId: completion.stepId,
        observationIds: completion.observations.map(({ observationId }) => observationId),
      });
    }
  }

  async #complete(started: readonly StartedStep[]): Promise<void> {
    const settled = await Promise.all(started.map(async ({ settled: result }) => await result));
    const prepared = settled.map((result) => this.#prepare(result));
    this.#applyPrepared(prepared);
  }

  #selectedHandles(handles: "all" | readonly string[]): StartedStep[] {
    const names = handles === "all" ? [...this.#pending.keys()] : [...handles];
    return names.map((handle) => {
      const started = this.#pending.get(handle);
      if (started === undefined) throw new Error(`async handle ${handle} is unknown or already joined`);
      return started;
    });
  }

  #removeHandles(started: readonly StartedStep[]): void {
    for (const entry of started) {
      if (entry.handle !== null) this.#pending.delete(entry.handle);
    }
  }

  async #abortAndDrain(reason: Error): Promise<void> {
    const active = [...this.#active];
    active.forEach(({ controller }) => controller.abort(reason));
    let drainFailure: Error | undefined;
    const timeoutMs = this.input.drainTimeoutMs ?? 10_000;
    const controller = new AbortController();
    const deadlineAtMs = Date.now() + timeoutMs;
    const timer = setTimeout(() => {
      controller.abort(new Error(`parent abort-and-drain exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    const aborted = new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        const abortReason = controller.signal.reason;
        reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason)));
      }, { once: true });
    });
    try {
      await Promise.race([
        this.input.drivers.abortAndDrain({
          runId: this.input.runId,
          caseId: this.input.caseId,
          binding: this.input.binding,
          reason,
          activeRequests: active.map(({ request }) => ({
            ...request,
            arguments: structuredClone(request.arguments),
            signal: request.signal,
          })),
          deadlineAtMs,
          signal: controller.signal,
        }),
        aborted,
      ]);
    } catch (error) {
      drainFailure = error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
    this.#active.clear();
    this.#pending.clear();
    if (drainFailure !== undefined) {
      throw new AggregateError(
        [reason, drainFailure],
        `step execution failed and parent abort-and-drain did not complete: ${drainFailure.message}`,
      );
    }
  }

  async #runPreflighted(): Promise<ParentStepExecutionEvidence> {
    for (const step of this.input.steps) {
      switch (step.execution.mode) {
        case "sequential": {
          const started = this.#start(
            step,
            stepArguments(step, this.input.binding, this.input.variables ?? {}, this.#captures),
            null,
            "sequential",
          );
          await this.#complete([started]);
          break;
        }
        case "async_start": {
          if (this.#pending.has(step.execution.handle)) {
            throw new Error(`async handle ${step.execution.handle} is already pending`);
          }
          const started = this.#start(
            step,
            stepArguments(step, this.input.binding, this.input.variables ?? {}, this.#captures),
            step.execution.handle,
            "concurrent",
          );
          this.#pending.set(step.execution.handle, started);
          break;
        }
        case "async_join": {
          const pending = this.#selectedHandles(step.execution.handles);
          const current = this.#start(
            step,
            stepArguments(step, this.input.binding, this.input.variables ?? {}, this.#captures),
            null,
            "concurrent",
          );
          try {
            await this.#complete([...pending, current]);
          } finally {
            this.#removeHandles(pending);
          }
          break;
        }
        case "barrier": {
          const pending = this.#selectedHandles(step.execution.handles);
          try {
            await this.#complete(pending);
          } finally {
            this.#removeHandles(pending);
          }
          const current = this.#start(
            step,
            stepArguments(step, this.input.binding, this.input.variables ?? {}, this.#captures),
            null,
            "sequential",
          );
          await this.#complete([current]);
          break;
        }
      }
    }
    if (this.#pending.size > 0) {
      throw new Error(`unjoined async handles remain: ${[...this.#pending.keys()].join(", ")}`);
    }
    return {
      observations: this.#observations.map((observation) => structuredClone(observation)),
      captures: Object.fromEntries(
        [...this.#captures].map(([name, value]) => [name, structuredClone(value)]),
      ),
      completedStepIds: [...this.#completedStepIds],
      stepObservations: this.#stepObservations.map((lineage) => ({
        stepId: lineage.stepId,
        observationIds: [...lineage.observationIds],
      })),
    };
  }

  async run(): Promise<ParentStepExecutionEvidence> {
    preflightStepPlan(this.input);
    if (this.input.signal?.aborted === true) {
      const reason = this.input.signal.reason;
      throw reason instanceof Error ? reason : new Error(String(reason ?? "parent step execution was aborted"));
    }
    try {
      return await this.#runPreflighted();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.#abortAndDrain(failure);
      throw failure;
    }
  }
}

export async function executeParentSteps(input: ParentStepExecutionInput): Promise<ParentStepExecutionEvidence> {
  return await new ParentStepEngine(input).run();
}

/**
 * Resolves a catalog requirement exclusively through parent-attached step
 * lineage. A raw observation attached to a different step cannot satisfy the
 * requirement even when its component and kind happen to match.
 */
export function observationsForRequirement(
  evidence: ParentStepExecutionEvidence,
  requirement: CaseObservationRequirement,
): ProcessObservationRecord[] {
  const lineage = new Map(evidence.stepObservations.map(({ stepId, observationIds }) => [
    stepId,
    observationIds,
  ]));
  const allowedIds = new Set(requirement.sourceStepIds.flatMap((stepId) => lineage.get(stepId) ?? []));
  const selected = evidence.observations.filter((observation) =>
    allowedIds.has(observation.observationId) &&
    observation.componentId === requirement.componentId &&
    observation.kind === requirement.kind);
  for (const observation of selected) {
    assertJsonValue(observation.payload, `/observations/${observation.observationId}/payload`);
    for (const pointer of requirement.requiredJsonPointers) {
      jsonPointer(observation.payload, pointer, `${requirement.alias}/${observation.observationId}`);
    }
  }
  return selected.map((observation) => structuredClone(observation));
}
