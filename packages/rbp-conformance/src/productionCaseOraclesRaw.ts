import type {
  CanonicalAssertionOracle,
  CanonicalAssertionOracleContext,
  CanonicalAssertionOracleRegistry,
} from "./canonicalEvaluators.js";
import { canonicalManifest } from "./manifest.js";
import {
  C27_RECONNECT_JITTER_UNITS,
  RAW_PRODUCTION_CASES,
  rawProductionCaseVariables,
  rawProductionFrameFact,
} from "./productionCaseSeedsRaw.js";
import type { ProcessObservationRecord } from "./types.js";

type ObjectValue = Record<string, unknown>;
type ObservationKind = ProcessObservationRecord["kind"];

const FORBIDDEN_VERDICT_KEYS = new Set(["actual", "passed", "verdict"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function objectValue(value: unknown): ObjectValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null
    ? value as ObjectValue
    : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pathValue(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    const object = objectValue(cursor);
    if (object === null || !Object.prototype.hasOwnProperty.call(object, segment)) return undefined;
    cursor = object[segment];
  }
  return cursor;
}

function visitObjects(
  value: unknown,
  predicate: (candidate: Readonly<ObjectValue>) => boolean,
): boolean {
  if (Array.isArray(value)) return value.some((entry) => visitObjects(entry, predicate));
  const object = objectValue(value);
  if (object === null) return false;
  if (Object.keys(object).some((key) => FORBIDDEN_VERDICT_KEYS.has(key))) {
    const retained = Object.fromEntries(
      Object.entries(object).filter(([key]) => !FORBIDDEN_VERDICT_KEYS.has(key)),
    );
    if (predicate(retained)) return true;
  } else if (predicate(object)) {
    return true;
  }
  return Object.entries(object).some(([key, entry]) =>
    !FORBIDDEN_VERDICT_KEYS.has(key) && visitObjects(entry, predicate));
}

function observations(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind?: ObservationKind,
): readonly ProcessObservationRecord[] {
  return context.observations.filter((observation) =>
    observation.caseId === context.caseId &&
    observation.binding === context.binding &&
    (kind === undefined || observation.kind === kind));
}

function hasDomainObject(
  context: Readonly<CanonicalAssertionOracleContext>,
  kinds: readonly ObservationKind[],
  predicate: (candidate: Readonly<ObjectValue>) => boolean,
): boolean {
  return observations(context)
    .filter(({ kind }) => kinds.includes(kind))
    .some(({ payload }) => visitObjects(payload, predicate));
}

function stepIdOf(payload: ObjectValue): string | null {
  return stringValue(payload.stepId);
}

function rawWire(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const fact = rawProductionFrameFact(stepId);
  if (fact === undefined || fact.caseId !== context.caseId) return null;
  const matches = observations(context, "wire_event").filter(({ payload }) => {
    const object = objectValue(payload);
    return object !== null && stepIdOf(object) === stepId;
  });
  if (matches.length !== 1) return null;
  const payload = objectValue(matches[0]!.payload);
  if (
    payload === null ||
    payload.action !== "send_binding_frame" ||
    payload.direction !== "parent_to_gateway" ||
    payload.binding !== context.binding
  ) {
    return null;
  }
  const serialized = objectValue(payload.serialized);
  const frame = objectValue(payload.frame);
  const remote = objectValue(payload.remoteOutcome);
  if (
    serialized === null ||
    frame === null ||
    remote === null ||
    serialized.bytes !== fact.bytes ||
    serialized.sha256 !== fact.sha256 ||
    frame.source !== fact.source ||
    frame.type !== fact.type ||
    payload.credentialSource !== fact.credentialSource
  ) {
    return null;
  }
  const expectedRemoteKind = context.binding === "wss"
    ? "wss_exchange"
    : "streamable_http_sse_exchange";
  return remote.kind === expectedRemoteKind ? payload : null;
}

function parsedRemoteFrames(remote: ObjectValue): readonly ObjectValue[] {
  const direct = arrayValue(remote.receivedFrames);
  const sse = objectValue(remote.sse);
  const fromSse = sse === null ? [] : arrayValue(sse.receivedFrames);
  return [...direct, ...fromSse]
    .map((frame) => objectValue(frame))
    .filter((frame): frame is ObjectValue => frame !== null)
    .filter((frame) => frame.parseState === "parsed")
    .map((frame) => objectValue(frame.parsed))
    .filter((frame): frame is ObjectValue => frame !== null);
}

function remoteMessages(remote: ObjectValue): string[] {
  const messages: string[] = [];
  for (const frame of parsedRemoteFrames(remote)) {
    const payload = objectValue(frame.payload);
    const message = stringValue(payload?.message);
    if (message !== null) messages.push(message);
  }
  for (const responseName of ["createResponse", "messagesResponse"] as const) {
    const response = objectValue(remote[responseName]);
    const body = objectValue(response?.body);
    const parsed = objectValue(body?.parsed);
    for (const candidate of [parsed?.error, parsed?.message]) {
      if (typeof candidate === "string") messages.push(candidate);
    }
  }
  const close = objectValue(remote.close);
  const closeReason = stringValue(close?.reason);
  if (closeReason !== null) messages.push(closeReason);
  return messages;
}

function remoteFaultClass(remote: ObjectValue): string | null {
  for (const frame of parsedRemoteFrames(remote)) {
    if (frame.type !== "error") continue;
    const faultClass = stringValue(objectValue(frame.payload)?.fault_class);
    if (faultClass !== null) return faultClass;
  }
  const close = objectValue(remote.close);
  if (close?.remote === true && close.code === 4400) return "protocol";
  if (close?.remote === true && close.code === 4403) return "auth";
  return null;
}

function rawRemote(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(rawWire(context, stepId)?.remoteOutcome);
}

function rawHasResponseType(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  expectedType: string,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null) return false;
  if (parsedRemoteFrames(remote).some((frame) => frame.type === expectedType)) return true;
  const created = objectValue(pathValue(remote, ["createResponse", "body", "parsed"]));
  return created?.type === expectedType;
}

function rawAcceptedWithoutResponse(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null) return false;
  if (context.binding === "streamable_http_sse") {
    return pathValue(remote, ["messagesResponse", "status"]) === 202;
  }
  const close = objectValue(remote.close);
  return close === null || close.remote !== true || close.code === 1000;
}

function rawGoodbyeAccepted(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null) return false;
  if (context.binding === "streamable_http_sse") {
    return pathValue(remote, ["messagesResponse", "status"]) === 202;
  }
  const close = objectValue(remote.close);
  return close?.remote === true && close.code === 1000;
}

function rawFault(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  faultClass: "protocol" | "auth",
  message: RegExp,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null || remoteFaultClass(remote) !== faultClass) return false;
  if (!remoteMessages(remote).some((candidate) => message.test(candidate))) return false;
  if (context.binding === "wss") {
    const close = objectValue(remote.close);
    return close?.remote === true && close.code === (faultClass === "auth" ? 4403 : 4400);
  }
  return pathValue(remote, ["messagesResponse", "status"]) === 400 ||
    pathValue(remote, ["createResponse", "status"]) === 400;
}

function rawPostSchema(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  type: string,
): boolean {
  const directionallyAccepted = rawFault(
    context,
    stepId,
    "protocol",
    new RegExp(`directionally invalid ${type}`, "iu"),
  );
  const authorizedAfterSchema = rawFault(
    context,
    stepId,
    "auth",
    /resume|token|session|device|binding|authorization|credential|foreign/i,
  );
  return directionallyAccepted || authorizedAfterSchema || rawAcceptedWithoutResponse(context, stepId);
}

function rawSchemaRejected(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  detail: RegExp = /invalid|schema|required|must|envelope|base64|digest|safe integer|sequence|chunk|payload/i,
): boolean {
  const remote = rawRemote(context, stepId);
  if (remote === null) return false;
  const protocolFault = remoteFaultClass(remote) === "protocol" ||
    (
      context.binding === "streamable_http_sse" &&
      pathValue(remote, ["createResponse", "status"]) === 400
    );
  if (!protocolFault) return false;
  const messages = remoteMessages(remote);
  return messages.some((message) =>
    detail.test(message) &&
    !/directionally invalid|does not match the active|foreign session/i.test(message));
}

function controlResult(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const response = controlResponse(context, stepId);
  if (response === null) return null;
  return Object.prototype.hasOwnProperty.call(response, "result")
    ? objectValue(response.result)
    : objectValue(response.details) ?? response;
}

function controlObservation(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const matches = observations(context, "control_result").filter(({ payload }) => {
    const object = objectValue(payload);
    return object?.schemaVersion === "rbp-step-control-observation/v1" &&
      object.stepId === stepId;
  });
  if (matches.length !== 1) return null;
  const payload = objectValue(matches[0]!.payload);
  const request = objectValue(payload?.request);
  const response = objectValue(payload?.response);
  if (
    payload === null ||
    request === null ||
    response === null ||
    typeof request.action !== "string"
  ) {
    return null;
  }
  return payload;
}

function controlResponse(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(controlObservation(context, stepId)?.response);
}

function controlArguments(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(pathValue(controlObservation(context, stepId), ["request", "arguments"]));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function c30JournalBindingRejected(
  context: Readonly<CanonicalAssertionOracleContext>,
  scenario: "policy" | "scope" | "clearance",
): boolean {
  const baselineStepId = `o1-c30.journal-${scenario}-baseline`;
  const changedStepId = `o1-c30.journal-${scenario}-changed`;
  const baselineResult = controlResult(context, baselineStepId);
  const changedResult = controlResult(context, changedStepId);
  const baselineEnvelope = objectValue(controlArguments(context, baselineStepId)?.envelope);
  const changedEnvelope = objectValue(controlArguments(context, changedStepId)?.envelope);
  const baselinePayload = objectValue(baselineEnvelope?.payload);
  const changedPayload = objectValue(changedEnvelope?.payload);
  const baselineOutcome = objectValue(baselineResult?.outcome);
  const changedOutcome = objectValue(changedResult?.outcome);
  const baselineSteps = arrayValue(baselinePayload?.steps);
  const changedSteps = arrayValue(changedPayload?.steps);
  const baselineStep = objectValue(baselineSteps[0]);
  const changedStep = objectValue(changedSteps[0]);
  if (
    baselineEnvelope === null ||
    changedEnvelope === null ||
    baselinePayload === null ||
    changedPayload === null ||
    baselineOutcome === null ||
    changedOutcome === null ||
    baselineStep === null ||
    changedStep === null ||
    baselineSteps.length !== 1 ||
    changedSteps.length !== 1 ||
    baselineResult?.crashed !== false ||
    changedResult?.crashed !== false ||
    baselineOutcome.kind !== "batch" ||
    baselineOutcome.status !== "completed" ||
    baselineOutcome.batchId !== baselinePayload.batch_id ||
    changedOutcome.kind !== "error" ||
    changedOutcome.batchId !== changedPayload.batch_id ||
    changedOutcome.faultClass !== "protocol" ||
    changedOutcome.message !== "batch binding changed on redelivery" ||
    baselinePayload.batch_id !== changedPayload.batch_id ||
    baselineStep.invocation_id !== changedStep.invocation_id ||
    baselineStep.method !== changedStep.method ||
    !sameJson(baselineStep.params, changedStep.params) ||
    baselineStep.params_digest !== changedStep.params_digest ||
    baselineStep.mutating !== changedStep.mutating ||
    baselinePayload.atomic !== changedPayload.atomic ||
    baselinePayload.timeout_ms !== changedPayload.timeout_ms ||
    baselinePayload.batch_digest === changedPayload.batch_digest ||
    baselineEnvelope.rsid !== changedEnvelope.rsid ||
    typeof baselineEnvelope.rsid !== "string" ||
    baselineEnvelope.rsid.length === 0 ||
    baselineEnvelope.ack !== changedEnvelope.ack ||
    numberValue(baselineEnvelope.seq) === null ||
    changedEnvelope.seq !== (numberValue(baselineEnvelope.seq) as number) + 1
  ) {
    return false;
  }
  if (scenario === "policy") {
    return !sameJson(baselineStep.policy, changedStep.policy) &&
      sameJson(baselineStep.mutation_scope, changedStep.mutation_scope) &&
      sameJson(baselinePayload.recovery_clearances, changedPayload.recovery_clearances);
  }
  if (scenario === "scope") {
    return sameJson(baselineStep.policy, changedStep.policy) &&
      !sameJson(baselineStep.mutation_scope, changedStep.mutation_scope) &&
      sameJson(baselinePayload.recovery_clearances, changedPayload.recovery_clearances);
  }
  return sameJson(baselineStep.policy, changedStep.policy) &&
    sameJson(baselineStep.mutation_scope, changedStep.mutation_scope) &&
    !sameJson(baselinePayload.recovery_clearances, changedPayload.recovery_clearances);
}

function semanticControl(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  predicate: (result: Readonly<ObjectValue>) => boolean,
): boolean {
  const result = controlResult(context, stepId);
  return result !== null && predicate(result);
}

function transportOpened(
  context: Readonly<CanonicalAssertionOracleContext>,
  requestedKind: "wss" | "streamable_http_sse",
): boolean {
  return observations(context, "control_result").some(({ payload }) => {
    const root = objectValue(payload);
    const request = objectValue(root?.request);
    const requestArguments = objectValue(request?.arguments);
    const response = objectValue(root?.response);
    const result = objectValue(response?.result);
    const helloAck = objectValue(result?.helloAck);
    return request?.action === "open_transport" &&
      requestArguments?.kind === requestedKind &&
      result?.requestedKind === requestedKind &&
      result.selectedKind === requestedKind &&
      typeof result.connectionId === "string" &&
      helloAck?.type === "hello_ack";
  });
}

function snapshots(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: Extract<ObservationKind, "gateway_snapshot" | "bridge_snapshot" | "fixture_snapshot" | "fixture_execution_count">,
): readonly ObjectValue[] {
  return observations(context, kind)
    .map(({ payload }) => objectValue(payload))
    .filter((payload): payload is ObjectValue => payload !== null);
}

function snapshotHas(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: Extract<ObservationKind, "gateway_snapshot" | "bridge_snapshot" | "fixture_snapshot" | "fixture_execution_count">,
  predicate: (candidate: Readonly<ObjectValue>) => boolean,
): boolean {
  return snapshots(context, kind).some((snapshot) => visitObjects(snapshot, predicate));
}

function safe(predicate: CanonicalAssertionOracle): CanonicalAssertionOracle {
  return (context) => {
    try {
      return predicate(context) === true;
    } catch {
      return false;
    }
  };
}

function exactRawFault(
  stepId: string,
  faultClass: "protocol" | "auth",
  message: RegExp,
): CanonicalAssertionOracle {
  return safe((context) => rawFault(context, stepId, faultClass, message));
}

function exactSchemaAccepted(stepId: string, type: string): CanonicalAssertionOracle {
  return safe((context) => rawPostSchema(context, stepId, type));
}

function exactSchemaRejected(stepId: string, detail?: RegExp): CanonicalAssertionOracle {
  return safe((context) => rawSchemaRejected(context, stepId, detail));
}

function exactHelloAccepted(stepId: string): CanonicalAssertionOracle {
  return safe((context) => rawHasResponseType(context, stepId, "hello_ack"));
}

function semanticEvent(
  kinds: readonly ObservationKind[],
  predicate: (candidate: Readonly<ObjectValue>) => boolean,
): CanonicalAssertionOracle {
  return safe((context) => hasDomainObject(context, kinds, predicate));
}

function fixtureCount(
  context: Readonly<CanonicalAssertionOracleContext>,
  invocation: RegExp,
  expected: number,
): boolean {
  return snapshotHas(context, "fixture_execution_count", (candidate) =>
    Object.entries(candidate).some(([key, value]) =>
      invocation.test(key) && value === expected));
}

interface C27SnapshotEvidence {
  readonly payload: ObjectValue;
  readonly reconnect: ObjectValue;
  readonly peer: ObjectValue;
  readonly attempts: readonly ObjectValue[];
  readonly steady: readonly ObjectValue[];
}

function c27SnapshotAt(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): C27SnapshotEvidence | null {
  const matches = observations(context, "bridge_snapshot").filter((record) => {
    const payload = objectValue(record.payload);
    return record.componentId === "bridge_simulator" &&
      payload?.stepId === stepId &&
      payload.action === "snapshot_evidence";
  });
  if (matches.length !== 1) return null;
  const payload = objectValue(matches[0]!.payload);
  const reconnect = objectValue(payload?.reconnectConformance);
  const peer = objectValue(payload?.peer);
  if (
    payload === null ||
    reconnect === null ||
    peer === null ||
    payload.componentContract !== "bridge-simulator-control/v1" ||
    reconnect.schemaVersion !== "rbp-reconnect-conformance/v1" ||
    reconnect.mode !== "deterministic_virtual_clock"
  ) {
    return null;
  }
  const attempts = arrayValue(reconnect.attempts)
    .map((entry) => objectValue(entry))
    .filter((entry): entry is ObjectValue => entry !== null);
  const steady = arrayValue(reconnect.steadyObservations)
    .map((entry) => objectValue(entry))
    .filter((entry): entry is ObjectValue => entry !== null);
  if (
    attempts.length !== arrayValue(reconnect.attempts).length ||
    steady.length !== arrayValue(reconnect.steadyObservations).length
  ) {
    return null;
  }
  return { payload, reconnect, peer, attempts, steady };
}

function c27BackoffLimit(attemptIndex: number): number {
  return attemptIndex >= 6 ? 60_000 : 1_000 * (2 ** attemptIndex);
}

function exactC27AttemptTrace(evidence: C27SnapshotEvidence): boolean {
  if (
    evidence.reconnect.configuredSampleCount !== C27_RECONNECT_JITTER_UNITS.length ||
    evidence.reconnect.consumedSampleCount !== C27_RECONNECT_JITTER_UNITS.length ||
    evidence.reconnect.pendingSample !== null ||
    evidence.attempts.length !== C27_RECONNECT_JITTER_UNITS.length
  ) {
    return false;
  }
  let previousClockAfter: number | null = null;
  for (const [attemptIndex, attempt] of evidence.attempts.entries()) {
    const jitterUnit = C27_RECONNECT_JITTER_UNITS[attemptIndex]!;
    const limit = c27BackoffLimit(attemptIndex);
    const expectedDelay = Math.floor(jitterUnit * (limit + 1));
    const clockBefore = numberValue(attempt.clockBeforeSleepMs);
    const clockAfter = numberValue(attempt.clockAfterSleepMs);
    if (
      attempt.attemptIndex !== attemptIndex ||
      attempt.jitterUnit !== jitterUnit ||
      attempt.backoffLimitMs !== limit ||
      attempt.delayMs !== expectedDelay ||
      clockBefore === null ||
      clockAfter === null ||
      !Number.isSafeInteger(clockBefore) ||
      !Number.isSafeInteger(clockAfter) ||
      clockAfter - clockBefore !== expectedDelay ||
      (previousClockAfter !== null && clockBefore !== previousClockAfter)
    ) {
      return false;
    }
    previousClockAfter = clockAfter;
    const failed = attemptIndex < C27_RECONNECT_JITTER_UNITS.length - 1;
    if (failed) {
      if (
        attempt.outcome !== "opening_failed" ||
        attempt.faultClass !== "retryable_network" ||
        typeof attempt.errorMessage !== "string" ||
        attempt.errorMessage.length < 1 ||
        attempt.connectionId !== null
      ) {
        return false;
      }
    } else if (
      attempt.outcome !== "connected" ||
      attempt.faultClass !== null ||
      attempt.errorMessage !== null ||
      typeof attempt.connectionId !== "string" ||
      attempt.connectionId.length < 1
    ) {
      return false;
    }
  }
  const terminal = evidence.attempts.at(-1)!;
  return evidence.reconnect.successfulReconnectAtMs === terminal.clockAfterSleepMs &&
    evidence.peer.connectionId === terminal.connectionId &&
    evidence.peer.retrySuppressedFault === null &&
    evidence.peer.runLoopError === null;
}

function exactSteadyObservation(
  value: ObjectValue,
  input: {
    readonly durationMs: number;
    readonly attemptBefore: number;
    readonly attemptAfter: number;
    readonly reset: boolean;
  },
): boolean {
  const clockMs = numberValue(value.clockMs);
  const lastHeartbeatAckAtMs = numberValue(value.lastHeartbeatAckAtMs);
  return clockMs !== null &&
    lastHeartbeatAckAtMs !== null &&
    Number.isSafeInteger(clockMs) &&
    Number.isSafeInteger(lastHeartbeatAckAtMs) &&
    lastHeartbeatAckAtMs <= clockMs &&
    clockMs - lastHeartbeatAckAtMs < 35_000 &&
    value.steadyDurationMs === input.durationMs &&
    value.livenessBeforeTick === "steady" &&
    value.livenessAfterTick === "steady" &&
    value.reconnectAttemptIndexBefore === input.attemptBefore &&
    value.reconnectAttemptIndexAfter === input.attemptAfter &&
    value.reset === input.reset;
}

type C29VectorName = "mixed_non_atomic" | "atomic_terminal" | "atomic_indeterminate";

interface C29DispatchPair {
  readonly initial: ObjectValue;
  readonly redelivery: ObjectValue;
  readonly payload: ObjectValue;
  readonly batchId: string;
  readonly rsid: string;
  readonly stepIds: readonly string[];
}

interface C29TerminalEvidence {
  readonly gateway: ObjectValue;
  readonly session: ObjectValue;
  readonly terminal: ObjectValue;
  readonly envelope: ObjectValue;
  readonly payload: ObjectValue;
}

const C29_VARIABLES = rawProductionCaseVariables("O1-C29");

function exactKeys(value: ObjectValue, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function c29ExpectedPayload(name: C29VectorName): ObjectValue | null {
  const vectors = objectValue(C29_VARIABLES.vectors);
  const c29 = objectValue(vectors?.c29);
  const envelope = objectValue(c29?.[name]);
  return objectValue(envelope?.payload);
}

function c29SnapshotAt(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: Extract<
    ObservationKind,
    "gateway_snapshot" | "bridge_snapshot" | "fixture_snapshot" | "fixture_execution_count"
  >,
  stepId: string,
): ObjectValue | null {
  const matches = snapshots(context, kind).filter((snapshot) =>
    snapshot.stepId === stepId);
  return matches.length === 1 ? matches[0]! : null;
}

function c29DispatchPair(
  context: Readonly<CanonicalAssertionOracleContext>,
  initialStepId: string,
  redeliveryStepId: string,
  vectorName: C29VectorName,
): C29DispatchPair | null {
  const initial = controlResult(context, initialStepId);
  const redelivery = controlResult(context, redeliveryStepId);
  const expected = c29ExpectedPayload(vectorName);
  const initialPayload = objectValue(initial?.payload);
  const redeliveryPayload = objectValue(redelivery?.payload);
  const initialSeq = numberValue(initial?.seq);
  const redeliverySeq = numberValue(redelivery?.seq);
  const initialAck = numberValue(initial?.ack);
  const redeliveryAck = numberValue(redelivery?.ack);
  const initialId = stringValue(initial?.id);
  const redeliveryId = stringValue(redelivery?.id);
  const rsid = stringValue(initial?.rsid);
  if (
    initial === null ||
    redelivery === null ||
    expected === null ||
    initialPayload === null ||
    redeliveryPayload === null ||
    initial.v !== 1 ||
    redelivery.v !== 1 ||
    initial.type !== "invoke_batch" ||
    redelivery.type !== "invoke_batch" ||
    initialSeq === null ||
    redeliverySeq === null ||
    initialAck === null ||
    redeliveryAck === null ||
    !Number.isSafeInteger(initialSeq) ||
    !Number.isSafeInteger(redeliverySeq) ||
    !Number.isSafeInteger(initialAck) ||
    !Number.isSafeInteger(redeliveryAck) ||
    redeliverySeq !== initialSeq + 1 ||
    initialId === null ||
    redeliveryId === null ||
    initialId === redeliveryId ||
    rsid === null ||
    rsid.length < 1 ||
    redelivery.rsid !== rsid ||
    !sameJson(initialPayload, expected) ||
    !sameJson(redeliveryPayload, expected)
  ) {
    return null;
  }
  const batchId = stringValue(initialPayload.batch_id);
  const digest = stringValue(initialPayload.batch_digest);
  const rawSteps = arrayValue(initialPayload.steps);
  const steps = rawSteps
    .map((step) => objectValue(step))
    .filter((step): step is ObjectValue => step !== null);
  const stepIds = steps
    .map((step) => stringValue(step.invocation_id))
    .filter((stepId): stepId is string => stepId !== null);
  if (
    batchId === null ||
    digest === null ||
    !SHA256_PATTERN.test(digest) ||
    steps.length !== rawSteps.length ||
    stepIds.length !== steps.length ||
    new Set(stepIds).size !== stepIds.length
  ) {
    return null;
  }
  return {
    initial,
    redelivery,
    payload: initialPayload,
    batchId,
    rsid,
    stepIds,
  };
}

function c29TerminalEvidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  dispatch: C29DispatchPair,
): C29TerminalEvidence | null {
  const gateway = c29SnapshotAt(
    context,
    "gateway_snapshot",
    "o1-c29.final-gateway-evidence",
  );
  const sessions = objectValue(gateway?.sessions);
  if (
    gateway === null ||
    sessions === null ||
    Object.keys(sessions).length !== 1
  ) {
    return null;
  }
  const session = objectValue(sessions[dispatch.rsid]);
  const terminals = objectValue(session?.terminalOutcomes);
  const terminal = objectValue(terminals?.[dispatch.batchId]);
  const envelope = objectValue(terminal?.envelope);
  const payload = objectValue(envelope?.payload);
  const envelopeSeq = numberValue(envelope?.seq);
  const envelopeAck = numberValue(envelope?.ack);
  if (
    session === null ||
    terminals === null ||
    terminal === null ||
    envelope === null ||
    payload === null ||
    terminal.correlationId !== dispatch.batchId ||
    terminal.classification !== "result" ||
    envelope.v !== 1 ||
    envelope.type !== "result" ||
    envelope.rsid !== dispatch.rsid ||
    envelopeSeq === null ||
    !Number.isSafeInteger(envelopeSeq) ||
    envelopeAck === null ||
    envelopeAck !== dispatch.redelivery.seq ||
    payload.batch_id !== dispatch.batchId
  ) {
    return null;
  }
  return { gateway, session, terminal, envelope, payload };
}

function c29FixtureCount(snapshot: ObjectValue | null, requestId: string): number {
  if (snapshot === null) return -1;
  const rows = arrayValue(snapshot.executionCounts)
    .map((entry) => objectValue(entry))
    .filter((entry): entry is ObjectValue => entry !== null)
    .filter((entry) => entry.requestId === requestId);
  if (rows.length === 0) return 0;
  return rows.length === 1 && Number.isSafeInteger(rows[0]!.count)
    ? Number(rows[0]!.count)
    : -1;
}

function c29BridgeInvocation(snapshot: ObjectValue | null, invocationId: string): ObjectValue | null {
  if (snapshot === null) return null;
  const matches = arrayValue(snapshot.invocations)
    .map((entry) => objectValue(entry))
    .filter((entry): entry is ObjectValue => entry !== null)
    .filter((entry) => entry.invocationId === invocationId);
  return matches.length === 1 ? matches[0]! : null;
}

function c29CrashSnapshot(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  point:
    | "after_non_atomic_step_terminal_before_batch_terminal"
    | "after_executing_before_addin_write",
): ObjectValue | null {
  const snapshot = c29SnapshotAt(context, "bridge_snapshot", stepId);
  const crash = objectValue(snapshot?.crash);
  return snapshot !== null &&
      snapshot.componentContract === "bridge-simulator-control/v1" &&
      crash?.crashed === true &&
      crash.point === point
    ? snapshot
    : null;
}

function c29BatchSteps(payload: ObjectValue): readonly ObjectValue[] | null {
  const raw = arrayValue(payload.steps);
  const steps = raw
    .map((entry) => objectValue(entry))
    .filter((entry): entry is ObjectValue => entry !== null);
  return steps.length === raw.length ? steps : null;
}

function exactC29MixedNonAtomic(
  context: Readonly<CanonicalAssertionOracleContext>,
): boolean {
  const dispatch = c29DispatchPair(
    context,
    "o1-c29.mixed-initial",
    "o1-c29.mixed-redelivery",
    "mixed_non_atomic",
  );
  if (dispatch === null || dispatch.stepIds.length !== 3) return false;
  const terminal = c29TerminalEvidence(context, dispatch);
  const crash = c29CrashSnapshot(
    context,
    "o1-c29.mixed-crash-evidence",
    "after_non_atomic_step_terminal_before_batch_terminal",
  );
  const counts = c29SnapshotAt(
    context,
    "fixture_execution_count",
    "o1-c29.mixed-execution-evidence",
  );
  if (terminal === null || crash === null || counts === null) return false;
  const steps = c29BatchSteps(terminal.payload);
  if (
    steps === null ||
    steps.length !== 3 ||
    !exactKeys(terminal.payload, [
      "kind",
      "batch_id",
      "atomic",
      "status",
      "transaction_state",
      "failed_step_index",
      "steps",
      "replayed",
    ]) ||
    terminal.payload.kind !== "batch" ||
    terminal.payload.atomic !== false ||
    terminal.payload.status !== "failed" ||
    terminal.payload.transaction_state !== "not_applicable" ||
    terminal.payload.failed_step_index !== 1 ||
    terminal.payload.replayed !== true
  ) {
    return false;
  }
  const [read, failure, suffix] = steps as [ObjectValue, ObjectValue, ObjectValue];
  const error = objectValue(failure.error);
  const result = objectValue(read.result);
  if (
    !exactKeys(read, [
      "index",
      "invocation_id",
      "status",
      "replayed",
      "result",
      "result_digest",
    ]) ||
    read.index !== 0 ||
    read.invocation_id !== dispatch.stepIds[0] ||
    read.status !== "completed" ||
    read.replayed !== true ||
    result === null ||
    !SHA256_PATTERN.test(String(read.result_digest)) ||
    !exactKeys(failure, ["index", "invocation_id", "status", "replayed", "error"]) ||
    failure.index !== 1 ||
    failure.invocation_id !== dispatch.stepIds[1] ||
    failure.status !== "failed" ||
    failure.replayed !== true ||
    error === null ||
    !exactKeys(error, [
      "retryable",
      "fault_class",
      "message",
      "outcome",
      "verification_required",
      "replayed",
    ]) ||
    error.retryable !== false ||
    error.fault_class !== "revit_api" ||
    error.message !== "C29 known non-atomic mutation failure" ||
    error.outcome !== "known" ||
    error.verification_required !== false ||
    error.replayed !== true ||
    !exactKeys(suffix, ["index", "invocation_id", "status", "replayed"]) ||
    suffix.index !== 2 ||
    suffix.invocation_id !== dispatch.stepIds[2] ||
    suffix.status !== "not_started" ||
    suffix.replayed !== false ||
    c29FixtureCount(counts, dispatch.stepIds[0]!) !== 1 ||
    c29FixtureCount(counts, dispatch.stepIds[1]!) !== 1 ||
    c29FixtureCount(counts, dispatch.stepIds[2]!) !== 0
  ) {
    return false;
  }
  const crashRead = c29BridgeInvocation(crash, dispatch.stepIds[0]!);
  const crashFailure = c29BridgeInvocation(crash, dispatch.stepIds[1]!);
  const crashSuffix = c29BridgeInvocation(crash, dispatch.stepIds[2]!);
  return crashRead?.state === "completed" &&
    crashRead.dispatchMayHaveStarted === true &&
    SHA256_PATTERN.test(String(crashRead.terminalOutcomeDigest)) &&
    crashFailure?.state === "failed" &&
    crashFailure.mutating === true &&
    crashFailure.dispatchMayHaveStarted === true &&
    crashFailure.verificationHoldId === null &&
    SHA256_PATTERN.test(String(crashFailure.terminalOutcomeDigest)) &&
    crashSuffix?.state === "received" &&
    crashSuffix.dispatchMayHaveStarted === false &&
    crashSuffix.terminalOutcomeDigest === null &&
    arrayValue(crash.holds).length === 0;
}

function exactC29AtomicTerminalReplay(
  context: Readonly<CanonicalAssertionOracleContext>,
): boolean {
  const dispatch = c29DispatchPair(
    context,
    "o1-c29.atomic-terminal",
    "o1-c29.atomic-replay",
    "atomic_terminal",
  );
  if (dispatch === null || dispatch.stepIds.length !== 2) return false;
  const terminal = c29TerminalEvidence(context, dispatch);
  const counts = c29SnapshotAt(
    context,
    "fixture_execution_count",
    "o1-c29.atomic-replay-execution-evidence",
  );
  if (terminal === null || counts === null) return false;
  const steps = c29BatchSteps(terminal.payload);
  if (
    steps === null ||
    steps.length !== 2 ||
    !exactKeys(terminal.payload, [
      "kind",
      "batch_id",
      "atomic",
      "status",
      "transaction_state",
      "failed_step_index",
      "steps",
      "replayed",
    ]) ||
    terminal.payload.kind !== "batch" ||
    terminal.payload.atomic !== true ||
    terminal.payload.status !== "completed" ||
    terminal.payload.transaction_state !== "committed" ||
    terminal.payload.failed_step_index !== null ||
    terminal.payload.replayed !== true ||
    c29FixtureCount(counts, dispatch.batchId) !== 1 ||
    dispatch.stepIds.some((stepId) => c29FixtureCount(counts, stepId) !== 1)
  ) {
    return false;
  }
  const digests = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (
      !exactKeys(step, [
        "index",
        "invocation_id",
        "status",
        "replayed",
        "result",
        "result_digest",
      ]) ||
      step.index !== index ||
      step.invocation_id !== dispatch.stepIds[index] ||
      step.status !== "completed" ||
      step.replayed !== true ||
      objectValue(step.result) === null ||
      !SHA256_PATTERN.test(String(step.result_digest))
    ) {
      return false;
    }
    digests.add(String(step.result_digest));
  }
  return digests.size === 1;
}

function exactC29AtomicIndeterminateRecovery(
  context: Readonly<CanonicalAssertionOracleContext>,
): boolean {
  const dispatch = c29DispatchPair(
    context,
    "o1-c29.atomic-indeterminate-initial",
    "o1-c29.atomic-indeterminate-redelivery",
    "atomic_indeterminate",
  );
  if (dispatch === null || dispatch.stepIds.length !== 2) return false;
  const terminal = c29TerminalEvidence(context, dispatch);
  const crash = c29CrashSnapshot(
    context,
    "o1-c29.atomic-crash-evidence",
    "after_executing_before_addin_write",
  );
  const beforeRestart = c29SnapshotAt(
    context,
    "fixture_execution_count",
    "o1-c29.atomic-pre-restart-execution-evidence",
  );
  const afterRedelivery = c29SnapshotAt(
    context,
    "fixture_execution_count",
    "o1-c29.final-execution-evidence",
  );
  if (
    terminal === null ||
    crash === null ||
    beforeRestart === null ||
    afterRedelivery === null
  ) {
    return false;
  }
  const steps = c29BatchSteps(terminal.payload);
  if (
    steps === null ||
    steps.length !== 2 ||
    !exactKeys(terminal.payload, [
      "kind",
      "batch_id",
      "atomic",
      "status",
      "transaction_state",
      "failed_step_index",
      "steps",
      "replayed",
    ]) ||
    terminal.payload.kind !== "batch" ||
    terminal.payload.atomic !== true ||
    terminal.payload.status !== "indeterminate" ||
    terminal.payload.transaction_state !== "indeterminate" ||
    terminal.payload.failed_step_index !== 0 ||
    terminal.payload.replayed !== true
  ) {
    return false;
  }
  const [read, mutation] = steps as [ObjectValue, ObjectValue];
  const readError = objectValue(read.error);
  const mutationError = objectValue(mutation.error);
  if (
    !exactKeys(read, ["index", "invocation_id", "status", "replayed", "error"]) ||
    read.index !== 0 ||
    read.invocation_id !== dispatch.stepIds[0] ||
    read.status !== "failed" ||
    read.replayed !== true ||
    readError === null ||
    !exactKeys(readError, [
      "retryable",
      "fault_class",
      "message",
      "outcome",
      "verification_required",
      "replayed",
    ]) ||
    readError.retryable !== true ||
    readError.fault_class !== "environment" ||
    readError.message !== "atomic batch read result is unavailable after interrupted dispatch" ||
    readError.outcome !== "known" ||
    readError.verification_required !== false ||
    readError.replayed !== true ||
    !exactKeys(mutation, ["index", "invocation_id", "status", "replayed", "error"]) ||
    mutation.index !== 1 ||
    mutation.invocation_id !== dispatch.stepIds[1] ||
    mutation.status !== "indeterminate" ||
    mutation.replayed !== true ||
    mutationError === null ||
    !exactKeys(mutationError, [
      "retryable",
      "fault_class",
      "message",
      "outcome",
      "verification_required",
      "replayed",
      "verification_hold_id",
      "mutation_scope",
    ]) ||
    mutationError.retryable !== false ||
    mutationError.fault_class !== "journal_indeterminate" ||
    mutationError.message !== "invocation outcome is indeterminate after Bridge restart" ||
    mutationError.outcome !== "indeterminate" ||
    mutationError.verification_required !== true ||
    mutationError.replayed !== true ||
    !/^vh:[0-9a-f]{64}$/u.test(String(mutationError.verification_hold_id)) ||
    !sameJson(mutationError.mutation_scope, { kind: "session" })
  ) {
    return false;
  }
  const crashRead = c29BridgeInvocation(crash, dispatch.stepIds[0]!);
  const crashMutation = c29BridgeInvocation(crash, dispatch.stepIds[1]!);
  if (
    crashRead?.state !== "executing" ||
    crashRead.dispatchMayHaveStarted !== true ||
    crashRead.terminalOutcomeDigest !== null ||
    crashMutation?.state !== "executing" ||
    crashMutation.mutating !== true ||
    crashMutation.dispatchMayHaveStarted !== true ||
    crashMutation.terminalOutcomeDigest !== null ||
    arrayValue(crash.holds).length !== 0
  ) {
    return false;
  }
  // This is the frozen no-step-retry proof: the one-frame atomic request and
  // both nested step ids are absent before restart and remain absent after the
  // fresh-sequence recovery delivery.
  return [dispatch.batchId, ...dispatch.stepIds].every((requestId) =>
    c29FixtureCount(beforeRestart, requestId) === 0 &&
    c29FixtureCount(afterRedelivery, requestId) === 0);
}

function c29TerminalPayloads(
  context: Readonly<CanonicalAssertionOracleContext>,
): readonly ObjectValue[] | null {
  const specs = [
    [
      "o1-c29.mixed-initial",
      "o1-c29.mixed-redelivery",
      "mixed_non_atomic",
    ],
    [
      "o1-c29.atomic-terminal",
      "o1-c29.atomic-replay",
      "atomic_terminal",
    ],
    [
      "o1-c29.atomic-indeterminate-initial",
      "o1-c29.atomic-indeterminate-redelivery",
      "atomic_indeterminate",
    ],
  ] as const;
  const payloads: ObjectValue[] = [];
  for (const [initial, redelivery, vector] of specs) {
    const dispatch = c29DispatchPair(context, initial, redelivery, vector);
    if (dispatch === null) return null;
    const terminal = c29TerminalEvidence(context, dispatch);
    if (terminal === null) return null;
    payloads.push(terminal.payload);
  }
  return payloads;
}

function c29NestedErrors(
  context: Readonly<CanonicalAssertionOracleContext>,
): readonly ObjectValue[] | null {
  const payloads = c29TerminalPayloads(context);
  if (payloads === null) return null;
  const errors: ObjectValue[] = [];
  for (const payload of payloads) {
    const steps = c29BatchSteps(payload);
    if (steps === null) return null;
    for (const step of steps) {
      if (!Object.prototype.hasOwnProperty.call(step, "error")) continue;
      const error = objectValue(step.error);
      if (error === null) return null;
      errors.push(error);
    }
  }
  return errors;
}

function exactC29NestedOutcomeFields(
  context: Readonly<CanonicalAssertionOracleContext>,
): boolean {
  const errors = c29NestedErrors(context);
  if (errors === null || errors.length !== 3) return false;
  return errors.every((error) => {
    const indeterminate = error.outcome === "indeterminate";
    return exactKeys(error, indeterminate
      ? [
          "retryable",
          "fault_class",
          "message",
          "outcome",
          "verification_required",
          "replayed",
          "verification_hold_id",
          "mutation_scope",
        ]
      : [
          "retryable",
          "fault_class",
          "message",
          "outcome",
          "verification_required",
          "replayed",
        ]) &&
      typeof error.retryable === "boolean" &&
      typeof error.fault_class === "string" &&
      (error.outcome === "known" || indeterminate) &&
      typeof error.message === "string" &&
      error.message.length >= 1 &&
      error.message.length <= 240 &&
      error.replayed === true;
  });
}

function exactC29NestedVerificationFields(
  context: Readonly<CanonicalAssertionOracleContext>,
): boolean {
  const errors = c29NestedErrors(context);
  if (errors === null || errors.length !== 3) return false;
  const indeterminate = errors.filter((error) => error.outcome === "indeterminate");
  const known = errors.filter((error) => error.outcome === "known");
  return known.length === 2 &&
    known.every((error) =>
      error.verification_required === false &&
      !Object.prototype.hasOwnProperty.call(error, "verification_hold_id") &&
      !Object.prototype.hasOwnProperty.call(error, "mutation_scope")) &&
    indeterminate.length === 1 &&
    indeterminate[0]!.verification_required === true &&
    /^vh:[0-9a-f]{64}$/u.test(String(indeterminate[0]!.verification_hold_id)) &&
    sameJson(indeterminate[0]!.mutation_scope, { kind: "session" });
}

function exactC29AffectedScopeHolds(
  context: Readonly<CanonicalAssertionOracleContext>,
): boolean {
  const dispatch = c29DispatchPair(
    context,
    "o1-c29.atomic-indeterminate-initial",
    "o1-c29.atomic-indeterminate-redelivery",
    "atomic_indeterminate",
  );
  if (dispatch === null || dispatch.stepIds.length !== 2) return false;
  const terminal = c29TerminalEvidence(context, dispatch);
  const bridge = c29SnapshotAt(
    context,
    "bridge_snapshot",
    "o1-c29.final-bridge-evidence",
  );
  if (terminal === null || bridge === null) return false;
  const terminalSteps = c29BatchSteps(terminal.payload);
  const mutationError = objectValue(terminalSteps?.[1]?.error);
  const holdId = stringValue(mutationError?.verification_hold_id);
  const origin = `${dispatch.rsid}/${dispatch.stepIds[1]}`;
  const gatewayHoldsRoot = objectValue(terminal.gateway.mutationHolds);
  const gatewayHolds = arrayValue(gatewayHoldsRoot?.holds)
    .map((entry) => objectValue(entry))
    .filter((entry): entry is ObjectValue => entry !== null);
  const bridgeHolds = arrayValue(bridge.holds)
    .map((entry) => objectValue(entry))
    .filter((entry): entry is ObjectValue => entry !== null);
  if (
    terminalSteps === null ||
    mutationError === null ||
    holdId === null ||
    gatewayHolds.length !== 1 ||
    bridgeHolds.length !== 1
  ) {
    return false;
  }
  const gatewayHold = gatewayHolds[0]!;
  const bridgeHold = bridgeHolds[0]!;
  const bridgeInvocation = c29BridgeInvocation(bridge, dispatch.stepIds[1]!);
  return gatewayHold.rsid === dispatch.rsid &&
    gatewayHold.holdId === holdId &&
    gatewayHold.scopeKey === "{\"kind\":\"session\"}" &&
    sameJson(gatewayHold.mutationScope, { kind: "session" }) &&
    sameJson(gatewayHold.originIdempotencyKeys, [origin]) &&
    gatewayHold.state === "active" &&
    gatewayHold.selectedEvidence === null &&
    gatewayHold.resolution === null &&
    gatewayHold.clearedBy === null &&
    bridgeHold.rsid === dispatch.rsid &&
    bridgeHold.holdId === holdId &&
    bridgeHold.scopeKey === "{\"kind\":\"session\"}" &&
    sameJson(bridgeHold.originIdempotencyKeys, [origin]) &&
    bridgeHold.state === "active" &&
    sameJson(bridgeHold.evidenceDigests, []) &&
    bridgeHold.clearedBy === null &&
    bridgeInvocation?.state === "indeterminate" &&
    bridgeInvocation.mutating === true &&
    bridgeInvocation.verificationHoldId === holdId &&
    sameJson(mutationError.mutation_scope, { kind: "session" });
}

const entries: Array<readonly [string, CanonicalAssertionOracle]> = [];

function define(assertionId: string, oracle: CanonicalAssertionOracle): void {
  if (entries.some(([existing]) => existing === assertionId)) {
    throw new Error(`duplicate raw production oracle ${assertionId}`);
  }
  entries.push([assertionId, safe(oracle)]);
}

define(
  "O1-C25-CROSS-DEVICE-RESUME-REJECT",
  exactRawFault("o1-c25.cross-device-resume", "auth", /device|credential|resume token/i),
);
define(
  "O1-C25-CROSS-RSID-RESUME-REJECT",
  exactRawFault("o1-c25.cross-rsid-resume", "auth", /rsid|session|resume token/i),
);
define(
  "O1-C25-INVOCATION-AUTHORIZATION-REJECT",
  semanticEvent(["control_result", "gateway_snapshot", "wire_event"], (candidate) =>
    (candidate.stepId === "o1-c25.unknown-session-invoke" ||
      candidate.rsid === "rs_unregistered") &&
    (
      candidate.faultClass === "auth" ||
      candidate.fault_class === "auth" ||
      /not registered|unknown session|foreign session/i.test(String(candidate.message ?? candidate.error ?? ""))
    )),
);

define("O1-C26-N-COMPATIBLE", exactHelloAccepted("o1-c26.version-n"));
define("O1-C26-N-MINUS-ONE-COMPATIBLE", exactHelloAccepted("o1-c26.version-n-minus-one"));
define("O1-C26-ADDITIVE-CHANGE-ACCEPTED", exactHelloAccepted("o1-c26.additive"));
define("O1-C26-BREAKING-CHANGE-REJECTED", exactSchemaRejected(
  "o1-c26.breaking",
  /addin_versions|required|invalid|schema|hello/i,
));

define(
  "O1-C27-FULL-JITTER-BOUNDS",
  (context) => {
    const evidence = c27SnapshotAt(context, "o1-c27.after-attempts");
    return evidence !== null &&
      exactC27AttemptTrace(evidence) &&
      evidence.reconnect.clockMs === evidence.reconnect.successfulReconnectAtMs &&
      evidence.peer.reconnectAttemptIndex === C27_RECONNECT_JITTER_UNITS.length &&
      evidence.peer.liveness === "steady" &&
      evidence.steady.length === 0;
  },
);
define(
  "O1-C27-SIXTY-SECOND-CAP",
  (context) => {
    const evidence = c27SnapshotAt(context, "o1-c27.after-attempts");
    if (evidence === null || !exactC27AttemptTrace(evidence)) return false;
    const attemptFive = evidence.attempts[5];
    const capped = evidence.attempts.slice(6);
    return attemptFive?.backoffLimitMs === 32_000 &&
      attemptFive.delayMs === 32_000 &&
      capped.length === 3 &&
      capped.every((attempt) =>
        attempt.backoffLimitMs === 60_000 &&
        attempt.delayMs === 60_000);
  },
);
define(
  "O1-C27-NO-EARLY-RESET",
  (context) => {
    const evidence = c27SnapshotAt(context, "o1-c27.before-reset");
    if (
      evidence === null ||
      !exactC27AttemptTrace(evidence) ||
      evidence.steady.length !== 4 ||
      evidence.peer.reconnectAttemptIndex !== C27_RECONNECT_JITTER_UNITS.length ||
      evidence.peer.liveness !== "steady"
    ) {
      return false;
    }
    const durations = [30_000, 60_000, 90_000, 119_999];
    return evidence.steady.every((entry, index) =>
      exactSteadyObservation(entry, {
        durationMs: durations[index]!,
        attemptBefore: C27_RECONNECT_JITTER_UNITS.length,
        attemptAfter: C27_RECONNECT_JITTER_UNITS.length,
        reset: false,
      })) &&
      evidence.reconnect.clockMs ===
        Number(evidence.reconnect.successfulReconnectAtMs) + 119_999;
  },
);
define(
  "O1-C27-RESET-AFTER-STEADY",
  (context) => {
    const evidence = c27SnapshotAt(context, "o1-c27.after-reset");
    if (
      evidence === null ||
      !exactC27AttemptTrace(evidence) ||
      evidence.steady.length !== 5 ||
      evidence.peer.reconnectAttemptIndex !== 0 ||
      evidence.peer.liveness !== "steady"
    ) {
      return false;
    }
    const priorDurations = [30_000, 60_000, 90_000, 119_999];
    const priorSteady = evidence.steady.slice(0, 4).every((entry, index) =>
      exactSteadyObservation(entry, {
        durationMs: priorDurations[index]!,
        attemptBefore: C27_RECONNECT_JITTER_UNITS.length,
        attemptAfter: C27_RECONNECT_JITTER_UNITS.length,
        reset: false,
      }));
    const reset = exactSteadyObservation(evidence.steady[4]!, {
      durationMs: 120_000,
      attemptBefore: C27_RECONNECT_JITTER_UNITS.length,
      attemptAfter: 0,
      reset: true,
    });
    return priorSteady &&
      reset &&
      evidence.reconnect.clockMs ===
        Number(evidence.reconnect.successfulReconnectAtMs) + 120_000;
  },
);

define(
  "O1-C28-HOLD-INSTALLED",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    typeof (candidate.holdId ?? candidate.hold_id) === "string" &&
    (candidate.state === "active" ||
      candidate.state === "evidence_recorded" ||
      candidate.state === "resolved_pending_bridge" ||
      candidate.state === "cleared") &&
    (
      candidate.scopeKey === "session" ||
      objectValue(candidate.mutationScope ?? candidate.mutation_scope)?.kind === "session"
    ) &&
    arrayValue(candidate.originIdempotencyKeys ?? candidate.origin_invocation_ids).length > 0),
);
define(
  "O1-C28-FRESH-ID-BLOCKED",
  semanticEvent(["control_result", "gateway_snapshot"], (candidate) =>
    (candidate.stepId === "o1-c28.fresh-id" || candidate.kind === "blocked") &&
    /hold|journal_indeterminate|conflict/i.test(String(candidate.reason ?? candidate.faultClass ?? candidate.message ?? ""))),
);
define(
  "O1-C28-BATCH-WRITE-BLOCKED",
  semanticEvent(["control_result", "gateway_snapshot"], (candidate) =>
    (candidate.stepId === "o1-c28.batch" || candidate.kind === "blocked") &&
    /hold|journal_indeterminate|conflict/i.test(String(candidate.reason ?? candidate.faultClass ?? candidate.message ?? ""))),
);
define(
  "O1-C28-INCONCLUSIVE-READ-RETAINS",
  semanticEvent(["control_result", "gateway_snapshot"], (candidate) =>
    (candidate.kind === "inconclusive_recorded" || candidate.conclusion === "inconclusive") &&
    candidate.state !== "cleared"),
);
define(
  "O1-C28-CONCLUSIVE-READ-CLEARS",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    candidate.state === "cleared" &&
    (
      candidate.decision === "postcondition_verified" ||
      objectValue(candidate.resolution)?.decision === "postcondition_verified"
    )),
);
define(
  "O1-C28-LATE-TERMINAL-TRANSITION",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    candidate.basis === "late_terminal" &&
    typeof (candidate.evidenceDigest ?? candidate.evidence_digest) === "string" &&
    (candidate.state === "evidence_recorded" || candidate.state === "cleared")),
);
define(
  "O1-C28-INVALID-CLEARANCE-BLOCKED",
  safe((context) =>
    semanticControl(context, "o1-c28.invalid", (result) =>
      result.kind === "rejected" &&
      ["foreign_hold", "scope_mismatch", "journal_binding_mismatch", "evidence_digest_mismatch"]
        .includes(String(result.reason))) &&
    !hasDomainObject(context, ["fixture_snapshot", "fixture_execution_count"], (candidate) =>
      candidate.invalidClearanceDispatched === true)),
);

define(
  "O1-C29-MIXED-NONATOMIC-REDELIVERY",
  exactC29MixedNonAtomic,
);
define(
  "O1-C29-ATOMIC-TERMINAL-REPLAY",
  exactC29AtomicTerminalReplay,
);
define(
  "O1-C29-ATOMIC-INDETERMINATE-RECOVERY",
  exactC29AtomicIndeterminateRecovery,
);
define(
  "O1-C29-NESTED-OUTCOME-FIELDS",
  exactC29NestedOutcomeFields,
);
define(
  "O1-C29-NESTED-VERIFICATION-FIELDS",
  exactC29NestedVerificationFields,
);
define(
  "O1-C29-AFFECTED-SCOPE-HOLDS",
  exactC29AffectedScopeHolds,
);

for (const [suffix, assertion] of [
  ["property-order", "PROPERTY-ORDER"],
  ["number-formatting", "NUMBER-FORMATTING"],
  ["unicode", "UNICODE"],
  ["escapes", "ESCAPES"],
] as const) {
  define(
    `O1-C30-${assertion}`,
    exactSchemaAccepted(`o1-c30.${suffix}`, "invoke_batch"),
  );
}
define("O1-C30-STEP-OMISSION", exactSchemaRejected("o1-c30.step-omission", /steps|minItems|non-empty|required|invalid/i));
define("O1-C30-PARAMS-DIGEST-MISMATCH", exactSchemaRejected(
  "o1-c30.params-digest-mismatch",
  /params_digest|digest|invalid/i,
));
define("O1-C30-PER-STEP-DIGEST", exactSchemaRejected(
  "o1-c30.per-step-digest",
  /params_digest|step|digest|invalid/i,
));
define("O1-C30-BATCH-DIGEST", exactSchemaRejected(
  "o1-c30.batch-digest",
  /batch_digest|digest|invalid/i,
));
for (const [scenario, assertion] of [
  ["policy", "CHANGED-POLICY"],
  ["scope", "CHANGED-SCOPE"],
  ["clearance", "CHANGED-CLEARANCE"],
] as const) {
  define(
    `O1-C30-${assertion}`,
    safe((context) => c30JournalBindingRejected(context, scenario)),
  );
}
define(
  "O1-C30-HARMLESS-RESERIALIZATION",
  exactSchemaAccepted("o1-c30.harmless-reserialization", "invoke_batch"),
);

for (const [suffix, assertion, type] of [
  ["heartbeat_ack_positive", "HEARTBEAT-ACK-POSITIVE", "heartbeat_ack"],
  ["session_register_positive", "REGISTER-POSITIVE", "session_register"],
  ["session_unregister_positive", "UNREGISTER-POSITIVE", "session_unregister"],
  ["session_resume_positive", "RESUME-POSITIVE", "session_resume"],
  ["cancel_positive", "CANCEL-POSITIVE", "cancel"],
  ["manifest_positive", "MANIFEST-POSITIVE", "manifest_check"],
] as const) {
  define(`O1-C31-${assertion}`, exactSchemaAccepted(`o1-c31.${suffix}`, type));
}
define(
  "O1-C31-GOODBYE-POSITIVE",
  safe((context) => rawGoodbyeAccepted(context, "o1-c31.goodbye_positive")),
);
for (const [suffix, assertion] of [
  ["heartbeat_ack_negative", "HEARTBEAT-ACK-NEGATIVE"],
  ["session_register_negative", "REGISTER-NEGATIVE"],
  ["session_unregister_negative", "UNREGISTER-NEGATIVE"],
  ["session_resume_negative", "RESUME-NEGATIVE"],
  ["cancel_negative", "CANCEL-NEGATIVE"],
  ["goodbye_negative", "GOODBYE-NEGATIVE"],
  ["manifest_negative", "MANIFEST-NEGATIVE"],
] as const) {
  define(`O1-C31-${assertion}`, exactSchemaRejected(`o1-c31.${suffix}`));
}

define("O1-C32-BASE64-ALPHABET", exactSchemaRejected("o1-c32.base64_alphabet", /base64|alphabet|invalid/i));
define("O1-C32-BASE64-PADDING", exactSchemaRejected("o1-c32.base64_padding", /base64|padding|invalid/i));
define("O1-C32-STREAM-IDENTITY", exactSchemaRejected("o1-c32.stream_identity", /stream|artifact|identity|invalid/i));
define(
  "O1-C32-STREAM-INDEXING",
  safe((context) =>
    rawFault(context, "o1-c32.stream_indexing", "protocol", /chunk index|gap|zero|contiguous/i) ||
    hasDomainObject(context, ["gateway_snapshot"], (candidate) =>
      candidate.reason === "chunk_gap" &&
      candidate.expectedChunkIndex === 0 &&
      candidate.receivedChunkIndex === 1)),
);
define("O1-C32-DECODED-LIMIT", exactSchemaRejected("o1-c32.decoded_limit", /decoded|chunk|1 MiB|1048576|oversize/i));
define(
  "O1-C32-RECONSTRUCTION-SIZE",
  safe((context) =>
    rawFault(context, "o1-c32.reconstruction_size", "protocol", /size|total_size|reconstruct/i) ||
    hasDomainObject(context, ["gateway_snapshot"], (candidate) =>
      candidate.reason === "descriptor_size" && candidate.complete === false)),
);
define(
  "O1-C32-CONTENT-DIGEST",
  safe((context) =>
    rawFault(context, "o1-c32.content_digest", "protocol", /digest|sha256|content/i) ||
    hasDomainObject(context, ["gateway_snapshot"], (candidate) =>
      candidate.reason === "descriptor_digest" && candidate.complete === false)),
);

export const RAW_PRODUCTION_EXTERNAL_DEPENDENCIES: ReadonlyMap<string, string> = new Map([
  ["O1-C33-LOOPBACK-ACCEPTED", "supervisor.loopback-probe/v1"],
  ["O1-C33-WILDCARD-REJECTED", "supervisor.loopback-probe/v1"],
  ["O1-C33-LAN-REJECTED", "supervisor.loopback-probe/v1"],
  ["O1-C33-HOSTNAME-REMOTE-REJECTED", "supervisor.loopback-probe/v1"],
  ["O1-C33-OVERRIDE-REJECTED", "supervisor.loopback-probe/v1"],
  ["O1-C40-RAW-PATH-REJECTED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-LOCAL-PATH-REJECTED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-TRAVERSAL-REJECTED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-REPARSE-REJECTED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-ARTIFACT-ID-MAPPING", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-ARTIFACT-INDEX-MAPPING", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-INDEPENDENT-STREAMS", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-DESCRIPTOR-VERIFIED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-DIGEST-VERIFIED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-SIZE-VERIFIED", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-RETRANSMISSION-IDENTITY", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-ALL-OR-NOTHING", "supervisor.product-artifact-evidence/v1"],
  ["O1-C40-NO-NORTH-CLAIM", "supervisor.product-artifact-evidence/v1"],
]);

function exactSupervisorEvidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  schemaVersion: string,
  stepId: string,
): ObjectValue | null {
  const matches = observations(context).filter(({ payload }) => {
    const candidate = objectValue(payload);
    return candidate?.schemaVersion === schemaVersion && candidate.stepId === stepId;
  });
  return matches.length === 1 ? objectValue(matches[0]!.payload) : null;
}

function exactArray(value: unknown, length: number): readonly unknown[] | null {
  return Array.isArray(value) && value.length === length ? value : null;
}

function targetIs(value: unknown, host: string, port?: number): boolean {
  const target = objectValue(value);
  return target !== null &&
    target.host === host &&
    (port === undefined || target.port === port);
}

function rejectedBeforeProbe(
  attempt: ObjectValue | null,
  host: string,
): boolean {
  if (
    attempt === null ||
    attempt.sessionCount !== 0 ||
    exactArray(attempt.acceptedTargets, 0) === null ||
    attempt.tempRegistryReads !== 0 ||
    attempt.filesystemLocksCreated !== 0
  ) {
    return false;
  }
  const probed = exactArray(attempt.probedTargets, 1);
  const rejected = exactArray(attempt.rejectedTargets, 1);
  const rejection = rejected === null ? null : objectValue(rejected[0]);
  return probed !== null &&
    targetIs(probed[0], host) &&
    rejection !== null &&
    targetIs(rejection.target, host) &&
    typeof rejection.reason === "string" &&
    /numeric IP loopback required before probe/u.test(rejection.reason);
}

function fixtureBindRejected(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  host: string,
  allowUnsafeBind: boolean,
  failureClass: string,
): boolean {
  const evidence = exactSupervisorEvidence(
    context,
    "supervisor.loopback-probe/v1",
    stepId,
  );
  return evidence !== null &&
    evidence.probeKind === "fixture_bind_process" &&
    evidence.processSpawned === true &&
    evidence.requestedHost === host &&
    evidence.allowUnsafeBind === allowUnsafeBind &&
    evidence.exitCode === 1 &&
    evidence.timedOut === false &&
    evidence.outputExceeded === false &&
    evidence.readyObserved === false &&
    evidence.survivingProcess === false &&
    evidence.failureClass === failureClass &&
    numberValue(evidence.stderrBytes) !== null &&
    Number(evidence.stderrBytes) > 0 &&
    typeof evidence.stdoutSha256 === "string" &&
    SHA256_PATTERN.test(evidence.stdoutSha256) &&
    typeof evidence.stderrSha256 === "string" &&
    SHA256_PATTERN.test(evidence.stderrSha256) &&
    typeof evidence.executableSha256 === "string" &&
    /^[0-9a-f]{64}$/u.test(evidence.executableSha256);
}

define(
  "O1-C33-LOOPBACK-ACCEPTED",
  safe((context) => {
    const evidence = exactSupervisorEvidence(
      context,
      "supervisor.loopback-probe/v1",
      "o1-c33.loopback",
    );
    const attempt = objectValue(evidence?.attempt);
    const probed = exactArray(attempt?.probedTargets, 1);
    const accepted = exactArray(attempt?.acceptedTargets, 1);
    return evidence !== null &&
      evidence.probeKind === "product_discovery" &&
      evidence.targetClass === "numeric_loopback" &&
      targetIs(evidence.requestedTarget, "127.0.0.1") &&
      attempt !== null &&
      attempt.sessionCount === 1 &&
      attempt.tempRegistryReads === 0 &&
      attempt.filesystemLocksCreated === 0 &&
      probed !== null &&
      accepted !== null &&
      exactArray(attempt.rejectedTargets, 0) !== null &&
      targetIs(probed[0], "127.0.0.1") &&
      targetIs(accepted[0], "127.0.0.1");
  }),
);
define(
  "O1-C33-WILDCARD-REJECTED",
  safe((context) =>
    fixtureBindRejected(
      context,
      "o1-c33.wildcard",
      "0.0.0.0",
      false,
      "numeric_loopback_required",
    )),
);
define(
  "O1-C33-LAN-REJECTED",
  safe((context) => {
    const evidence = exactSupervisorEvidence(
      context,
      "supervisor.loopback-probe/v1",
      "o1-c33.lan",
    );
    return evidence !== null &&
      evidence.probeKind === "product_discovery" &&
      evidence.targetClass === "non_loopback_lan" &&
      targetIs(evidence.requestedTarget, "192.0.2.10", 48_298) &&
      rejectedBeforeProbe(objectValue(evidence.attempt), "192.0.2.10");
  }),
);
define(
  "O1-C33-HOSTNAME-REMOTE-REJECTED",
  safe((context) => {
    const evidence = exactSupervisorEvidence(
      context,
      "supervisor.loopback-probe/v1",
      "o1-c33.hostname",
    );
    const controlled = objectValue(evidence?.controlledResolution);
    const addresses = exactArray(controlled?.addresses, 1);
    return evidence !== null &&
      evidence.probeKind === "hostname_resolved_remote" &&
      evidence.targetClass === "hostname" &&
      evidence.requestedHostname === "raw-nonloopback.invalid" &&
      controlled?.source === "parent_static_test_net" &&
      addresses?.[0] === "192.0.2.10" &&
      rejectedBeforeProbe(
        objectValue(evidence.hostnameAttempt),
        "raw-nonloopback.invalid",
      ) &&
      rejectedBeforeProbe(
        objectValue(evidence.resolvedAddressAttempt),
        "192.0.2.10",
      );
  }),
);
define(
  "O1-C33-OVERRIDE-REJECTED",
  safe((context) =>
    fixtureBindRejected(
      context,
      "o1-c33.override",
      "127.0.0.1",
      true,
      "unsafe_override_forbidden",
    )),
);

function productEvidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  scenario: string,
): ObjectValue | null {
  const evidence = exactSupervisorEvidence(
    context,
    "supervisor.product-artifact-evidence/v1",
    `o1-c40.${scenario}`,
  );
  return evidence?.scenario === scenario ? evidence : null;
}

function zeroFilesystemDelta(evidence: ObjectValue): boolean {
  const delta = objectValue(evidence.filesystemDelta);
  return delta?.fileCount === 0 && delta.totalBytes === 0;
}

function rejectedArtifactSurface(
  context: Readonly<CanonicalAssertionOracleContext>,
  scenario: "raw_path" | "traversal_path" | "reparse_path",
  surfaceKind: string,
  reparsePointObserved: boolean,
): boolean {
  const evidence = productEvidence(context, scenario);
  const surface = objectValue(evidence?.surface);
  const outcome = objectValue(evidence?.bridgeOutcome);
  const spool = objectValue(evidence?.bridgeSpool);
  return evidence !== null &&
    surface?.kind === surfaceKind &&
    surface.created === true &&
    surface.resolvedInsideSpool === false &&
    surface.reparsePointObserved === reparsePointObserved &&
    typeof surface.sourcePathSha256 === "string" &&
    SHA256_PATTERN.test(surface.sourcePathSha256) &&
    outcome?.schemaVersion === "bridge-artifact-invocation-evidence/v1" &&
    outcome.outcomeKind === "error" &&
    outcome.faultClass === "parameter" &&
    outcome.addinContacted === true &&
    outcome.replayed === false &&
    spool?.rootPathRedacted === true &&
    spool.rawPathExposed === false &&
    spool.carrierCountForInvocation === 0 &&
    exactArray(spool.carriers, 0) !== null &&
    zeroFilesystemDelta(evidence);
}

function carrierEvidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  scenario = "valid_multifile",
): {
  evidence: ObjectValue;
  outcome: ObjectValue;
  carrier: ObjectValue;
  references: readonly unknown[];
  descriptors: readonly unknown[];
  partials: readonly unknown[];
  spoolCarrier: ObjectValue;
  filesystemFiles: readonly unknown[];
} | null {
  const evidence = productEvidence(context, scenario);
  const outcome = objectValue(evidence?.bridgeOutcome);
  const carrier = objectValue(outcome?.carrier);
  const references = exactArray(carrier?.references, 2);
  const descriptors = exactArray(carrier?.descriptors, 2);
  const partials = exactArray(carrier?.partials, 4);
  const spool = objectValue(evidence?.bridgeSpool);
  const spoolCarriers = exactArray(spool?.carriers, 1);
  const spoolCarrier = spoolCarriers === null ? null : objectValue(spoolCarriers[0]);
  const filesystem = objectValue(evidence?.filesystemAfter);
  const filesystemFiles = arrayValue(filesystem?.files);
  if (
    evidence === null ||
    outcome === null ||
    carrier === null ||
    references === null ||
    descriptors === null ||
    partials === null ||
    spoolCarrier === null ||
    spool?.rootPathRedacted !== true ||
    spool.rawPathExposed !== false ||
    spool.carrierCountForInvocation !== 1 ||
    filesystem?.schemaVersion !== "supervisor.product-artifact-filesystem/v1" ||
    filesystem.rootPathRedacted !== true
  ) {
    return null;
  }
  return {
    evidence,
    outcome,
    carrier,
    references,
    descriptors,
    partials,
    spoolCarrier,
    filesystemFiles,
  };
}

function descriptorRows(facts: NonNullable<ReturnType<typeof carrierEvidence>>): ObjectValue[] | null {
  const rows = facts.descriptors.map(objectValue);
  return rows.every((entry): entry is ObjectValue => entry !== null) ? rows : null;
}

function partialRows(facts: NonNullable<ReturnType<typeof carrierEvidence>>): ObjectValue[] | null {
  const rows = facts.partials.map(objectValue);
  return rows.every((entry): entry is ObjectValue => entry !== null) ? rows : null;
}

define(
  "O1-C40-RAW-PATH-REJECTED",
  safe((context) =>
    rejectedArtifactSurface(
      context,
      "raw_path",
      "outside_regular_file",
      false,
    )),
);
define(
  "O1-C40-LOCAL-PATH-REJECTED",
  safe((context) => {
    const evidence = productEvidence(context, "local_path");
    const surface = objectValue(evidence?.surface);
    const outcome = objectValue(evidence?.bridgeOutcome);
    const result = objectValue(outcome?.sanitizedResult);
    const files = exactArray(result?.files, 1);
    const reference = files === null ? null : objectValue(files[0]);
    const spool = objectValue(evidence?.bridgeSpool);
    return evidence !== null &&
      surface?.kind === "managed_regular_file" &&
      surface.created === true &&
      surface.lexicalInsideSpool === true &&
      surface.resolvedInsideSpool === true &&
      surface.reparsePointObserved === false &&
      outcome?.schemaVersion === "bridge-artifact-invocation-evidence/v1" &&
      outcome.outcomeKind === "result" &&
      outcome.status === "completed" &&
      result?.rawPathFieldCount === 0 &&
      result.localPathStringCount === 0 &&
      reference !== null &&
      typeof reference.artifactId === "string" &&
      reference.artifactIndex === 0 &&
      spool?.rootPathRedacted === true &&
      spool.rawPathExposed === false &&
      spool.carrierCountForInvocation === 1;
  }),
);
define(
  "O1-C40-TRAVERSAL-REJECTED",
  safe((context) =>
    rejectedArtifactSurface(
      context,
      "traversal_path",
      "traversal_regular_file",
      false,
    )),
);
define(
  "O1-C40-REPARSE-REJECTED",
  safe((context) =>
    rejectedArtifactSurface(
      context,
      "reparse_path",
      "managed_reparse_file",
      true,
    )),
);
define(
  "O1-C40-ARTIFACT-ID-MAPPING",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    if (facts === null || descriptors === null) return false;
    const references = facts.references.map(objectValue);
    const ids = descriptors.map(({ artifactId }) => artifactId);
    return references.every((entry): entry is ObjectValue => entry !== null) &&
      ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/u.test(id)) &&
      new Set(ids).size === 2 &&
      references.every((reference, index) =>
        reference.artifactId === ids[index] &&
        reference.artifactIndex === index);
  }),
);
define(
  "O1-C40-ARTIFACT-INDEX-MAPPING",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    return descriptors !== null &&
      descriptors.every((descriptor, index) => descriptor.artifactIndex === index);
  }),
);
define(
  "O1-C40-INDEPENDENT-STREAMS",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    const partials = facts === null ? null : partialRows(facts);
    if (descriptors === null || partials === null) return false;
    const streamIds = descriptors.map(({ streamId }) => streamId);
    if (new Set(streamIds).size !== 2) return false;
    return descriptors.every((descriptor) => {
      const stream = partials.filter(({ streamId }) => streamId === descriptor.streamId);
      return stream.length === 2 &&
        stream.map(({ chunkIndex }) => chunkIndex).join(",") === "0,1" &&
        stream.every((partial) =>
          partial.artifactId === descriptor.artifactId &&
          partial.artifactIndex === descriptor.artifactIndex &&
          partial.invocationId === facts!.carrier.invocationId);
    });
  }),
);
define(
  "O1-C40-DESCRIPTOR-VERIFIED",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    const streams = facts === null ? null : exactArray(facts.spoolCarrier.streams, 2);
    if (descriptors === null || streams === null) return false;
    return descriptors.every((descriptor, index) => {
      const stream = objectValue(streams[index]);
      return stream !== null &&
        stream.artifactId === descriptor.artifactId &&
        stream.artifactIndex === descriptor.artifactIndex &&
        stream.streamId === descriptor.streamId &&
        stream.filename === descriptor.filename &&
        stream.contentType === descriptor.contentType &&
        stream.totalChunks === descriptor.totalChunks &&
        stream.totalSize === descriptor.totalSize &&
        stream.sha256 === descriptor.sha256;
    });
  }),
);
define(
  "O1-C40-DIGEST-VERIFIED",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    if (descriptors === null) return false;
    return descriptors.every((descriptor) =>
      typeof descriptor.sha256 === "string" &&
      SHA256_PATTERN.test(descriptor.sha256) &&
      facts!.filesystemFiles.filter((file) => {
        const row = objectValue(file);
        return row !== null &&
          row.sha256 === descriptor.sha256 &&
          row.bytes === descriptor.totalSize &&
          row.regularFile === true &&
          row.reparsePoint === false;
      }).length === 1);
  }),
);
define(
  "O1-C40-SIZE-VERIFIED",
  safe((context) => {
    const facts = carrierEvidence(context);
    const descriptors = facts === null ? null : descriptorRows(facts);
    const partials = facts === null ? null : partialRows(facts);
    if (facts === null || descriptors === null || partials === null) return false;
    const combined = descriptors.reduce((sum, descriptor) =>
      sum + Number(descriptor.totalSize), 0);
    return combined === 2_097_154 &&
      descriptors.every((descriptor) =>
        Number(descriptor.totalSize) === partials
          .filter(({ streamId }) => streamId === descriptor.streamId)
          .reduce((sum, partial) => sum + Number(partial.decodedBytes), 0)) &&
      objectValue(facts.evidence.filesystemDelta)?.totalBytes === combined;
  }),
);
define(
  "O1-C40-RETRANSMISSION-IDENTITY",
  safe((context) => {
    const first = carrierEvidence(context);
    const replay = carrierEvidence(context, "retransmission");
    if (first === null || replay === null) return false;
    const replayDelta = objectValue(replay.evidence.filesystemDelta);
    return first.outcome.replayed === false &&
      first.outcome.addinContacted === true &&
      replay.outcome.replayed === true &&
      replay.outcome.addinContacted === false &&
      first.carrier.invocationId === replay.carrier.invocationId &&
      JSON.stringify(first.carrier) === JSON.stringify(replay.carrier) &&
      JSON.stringify(first.spoolCarrier) === JSON.stringify(replay.spoolCarrier) &&
      replayDelta?.fileCount === 0 &&
      replayDelta.totalBytes === 0;
  }),
);
define(
  "O1-C40-ALL-OR-NOTHING",
  safe((context) => {
    const evidence = productEvidence(context, "invalid_member");
    const outcome = objectValue(evidence?.bridgeOutcome);
    const spool = objectValue(evidence?.bridgeSpool);
    return evidence !== null &&
      outcome?.schemaVersion === "bridge-artifact-invocation-evidence/v1" &&
      outcome.outcomeKind === "error" &&
      outcome.faultClass === "parameter" &&
      !Object.prototype.hasOwnProperty.call(outcome, "carrier") &&
      spool?.carrierCountForInvocation === 0 &&
      exactArray(spool.carriers, 0) !== null &&
      zeroFilesystemDelta(evidence);
  }),
);
define(
  "O1-C40-NO-NORTH-CLAIM",
  safe((context) =>
    [
      "raw_path",
      "local_path",
      "traversal_path",
      "reparse_path",
      "valid_multifile",
      "retransmission",
      "invalid_member",
    ].every((scenario) => {
      const evidence = productEvidence(context, scenario);
      return evidence !== null &&
        evidence.evidenceScope === "rbp_only" &&
        evidence.northClientObservationCount === 0 &&
        exactArray(evidence.northClientSurfaces, 0) !== null;
    })),
);

define(
  "O1-C34-DOCUMENT-SCHEMA",
  safe((context) =>
    rawHasResponseType(context, "o1-c34.document-schema", "session_registered") &&
    snapshotHas(context, "gateway_snapshot", (candidate) => {
      if (
        typeof candidate.document_id !== "string" ||
        typeof candidate.title !== "string" ||
        typeof candidate.is_workshared !== "boolean" ||
        typeof candidate.is_active !== "boolean"
      ) {
        return false;
      }
      return candidate.path_digest === null ||
        (typeof candidate.path_digest === "string" && SHA256_PATTERN.test(candidate.path_digest));
    })),
);
define(
  "O1-C34-SEAT-SPOOF-REJECTED",
  safe((context) =>
    rawFault(context, "o1-c34.seat-spoof", "auth", /seat|identity|claim|principal/i) &&
    hasDomainObject(context, ["gateway_snapshot", "wire_event"], (candidate) =>
      candidate.auditEvent === "identity_claim_rejected" && candidate.claim === "seat")),
);
define(
  "O1-C34-USER-SPOOF-REJECTED",
  safe((context) =>
    rawFault(context, "o1-c34.user-spoof", "auth", /user|identity|claim|principal/i) &&
    hasDomainObject(context, ["gateway_snapshot", "wire_event"], (candidate) =>
      candidate.auditEvent === "identity_claim_rejected" && candidate.claim === "user")),
);

define(
  "O1-C35-MAX-SAFE-SEQ",
  safe((context) =>
    rawPostSchema(context, "o1-c35.max_safe_seq", "doc_context_update") ||
    snapshotHas(context, "gateway_snapshot", (candidate) =>
      candidate.lastRxSeq === 9_007_199_254_740_991)),
);
define("O1-C35-UNSAFE-SEQ", exactSchemaRejected("o1-c35.unsafe_two_pow_53", /safe integer|sequence|maximum|invalid/i));
define(
  "O1-C35-NO-WRAP-RENEWAL",
  semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
    (candidate.reason === "sequence_exhaustion" || candidate.renewalReason === "sequence_exhaustion") &&
    (candidate.renewed === true || candidate.phase === "renewing") &&
    candidate.wrapped !== true),
);
define(
  "O1-C35-DUPLICATE",
  semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
    candidate.kind === "duplicate" &&
    (candidate.executed === false || candidate.dispatchCount === 0)),
);
define(
  "O1-C35-GAP",
  semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
    (candidate.kind === "gap" || candidate.reason === "forward_sequence_gap") &&
    numberValue(candidate.expectedSeq) !== null &&
    numberValue(candidate.receivedSeq) !== null &&
    candidate.accepted !== true),
);

define(
  "O1-C36-WSS-LIFECYCLE",
  safe((context) =>
    transportOpened(context, "wss") &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      Array.isArray(candidate.sessions) &&
      candidate.sessions.length > 0) &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      candidate.runLoopActive === true)),
);
define(
  "O1-C36-HTTP-SSE-LIFECYCLE",
  safe((context) =>
    transportOpened(context, "streamable_http_sse") &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      Array.isArray(candidate.sessions) &&
      candidate.sessions.length > 0) &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      candidate.runLoopActive === true) &&
    hasDomainObject(context, ["wire_event", "bridge_snapshot"], (candidate) =>
      (
        candidate.createStatus === 201 &&
        candidate.eventsStatus === 200 &&
        candidate.messagesStatus === 202
      ) ||
      (
        candidate.kind === "streamable_http_sse" &&
        candidate.open === true &&
        typeof candidate.connectionId === "string"
      ))),
);
define(
  "O1-C36-JOURNAL-PARITY",
  safe((context) => {
    const bridgeCanonical = snapshots(context, "bridge_snapshot").some((snapshot) =>
      Array.isArray(snapshot.invocations) &&
      snapshot.invocations.length === 0 &&
      Array.isArray(snapshot.holds) &&
      snapshot.holds.length === 0);
    const gatewayCanonical = snapshots(context, "gateway_snapshot").some((snapshot) => {
      const sessions = objectValue(snapshot.sessions);
      const holds = arrayValue(objectValue(snapshot.mutationHolds)?.holds);
      if (sessions === null || Object.keys(sessions).length === 0 || holds.length !== 0) return false;
      return Object.values(sessions).every((value) => {
        const session = objectValue(value);
        return session !== null &&
          session.inFlight === null &&
          Object.keys(objectValue(session.terminalOutcomes) ?? {}).length === 0 &&
          Object.keys(objectValue(session.omittedPayloadRecoveries) ?? {}).length === 0 &&
          Object.keys(objectValue(session.expiredOrigins) ?? {}).length === 0;
      });
    });
    return bridgeCanonical && gatewayCanonical;
  }),
);
define(
  "O1-C36-RESUME-PARITY",
  safe((context) => {
    const bridgeCanonical = snapshots(context, "bridge_snapshot").some((snapshot) => {
      const sessions = arrayValue(snapshot.sessions);
      const peerSessions = arrayValue(objectValue(snapshot.peer)?.sessions);
      return sessions.length > 0 &&
        peerSessions.length === sessions.length &&
        sessions.every((value) => typeof objectValue(value)?.rsid === "string") &&
        peerSessions.every((value) => {
          const session = objectValue(value);
          return session?.phase === "registered" &&
            session.resumeAllowed === true &&
            session.dispatchAllowed === true;
        });
    });
    const gatewayCanonical = snapshots(context, "gateway_snapshot").some((snapshot) => {
      const sessions = objectValue(snapshot.sessions);
      return sessions !== null &&
        Object.keys(sessions).length > 0 &&
        Object.values(sessions).every((value) => {
          const session = objectValue(value);
          return session?.revoked === false &&
            session.resumeTokenRedacted === true &&
            objectValue(session.lifecycle)?.phase === "registered";
        });
    });
    return bridgeCanonical && gatewayCanonical;
  }),
);
define(
  "O1-C36-OPENING-ERRORS",
  safe((context) => {
    const remote = rawRemote(context, "o1-c36.capture-opening-fault");
    const openingError = objectValue(remote?.openingError);
    return openingError?.status === 503 &&
      openingError.retryAfter === "1" &&
      openingError.retryable === true;
  }),
);
define(
  "O1-C36-PROXY-BUFFERING",
  safe((context) =>
    snapshotHas(context, "gateway_snapshot", (candidate) =>
      Array.isArray(candidate.bufferedSseConnections) &&
      candidate.bufferedSseConnections.length === 0 &&
      candidate.heldOutboundFrames === 0) &&
    snapshotHas(context, "bridge_snapshot", (candidate) =>
      candidate.kind === "streamable_http_sse" && candidate.open === true)),
);

function c37Evidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  token: string,
): {
  readonly rsid: string;
  readonly invocationId: string;
  readonly gatewaySession: ObjectValue;
} | null {
  const unregister = controlResult(context, `o1-c37.${token}.unregister`);
  const dispatch = controlArguments(context, `o1-c37.${token}.dispatch`);
  const request = objectValue(dispatch?.request);
  const payload = objectValue(request?.payload);
  const rsid = stringValue(unregister?.rsid);
  const invocationId = stringValue(payload?.invocation_id);
  if (
    rsid === null ||
    invocationId === null ||
    unregister?.reason !== token ||
    request?.rsid !== rsid
  ) {
    return null;
  }
  for (const snapshot of snapshots(context, "gateway_snapshot")) {
    const session = objectValue(objectValue(snapshot.sessions)?.[rsid]);
    const lifecycle = objectValue(session?.lifecycle);
    if (
      session?.revoked === true &&
      lifecycle?.phase === "unregistered" &&
      lifecycle.unregisterReason === token
    ) {
      return { rsid, invocationId, gatewaySession: session };
    }
  }
  return null;
}

function c37RevokedSession(
  evidence: NonNullable<ReturnType<typeof c37Evidence>>,
  token: string,
): boolean {
  const lifecycle = objectValue(evidence.gatewaySession.lifecycle);
  return evidence.gatewaySession.revoked === true &&
    lifecycle?.phase === "unregistered" &&
    lifecycle.unregisterReason === token;
}

function exactControlError(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  code: string,
  detail: RegExp,
): boolean {
  const response = controlResponse(context, stepId);
  return response?.kind === "control_error" &&
    response.code === code &&
    detail.test(String(response.message ?? ""));
}

for (const reason of ["REVIT-EXITED", "BRIDGE-SHUTDOWN", "SESSION-REPLACED", "OPERATOR-REQUESTED"] as const) {
  const token = reason.toLowerCase().replaceAll("-", "_");
  define(
    `O1-C37-${reason}-RESUME`,
    safe((context) => {
      const evidence = c37Evidence(context, token);
      return evidence !== null &&
        c37RevokedSession(evidence, token) &&
        exactControlError(
          context,
          `o1-c37.${token}.resume`,
          "bridge_control_invalid_control_request",
          /not resumable/i,
        );
    }),
  );
  define(
    `O1-C37-${reason}-DISPATCH`,
    safe((context) => {
      const evidence = c37Evidence(context, token);
      return evidence !== null &&
        c37RevokedSession(evidence, token) &&
        exactControlError(
          context,
          `o1-c37.${token}.new-dispatch`,
          "gateway_control_http_403",
          /revoked/i,
        );
    }),
  );
  define(
    `O1-C37-${reason}-INDETERMINATE`,
    safe((context) => {
      const evidence = c37Evidence(context, token);
      if (evidence === null || !c37RevokedSession(evidence, token)) return false;
      const terminal = objectValue(
        objectValue(evidence.gatewaySession.terminalOutcomes)?.[evidence.invocationId],
      );
      const expired = objectValue(
        objectValue(evidence.gatewaySession.expiredOrigins)?.[evidence.invocationId],
      );
      const bridgeIndeterminate = snapshots(context, "bridge_snapshot").some((snapshot) =>
        arrayValue(snapshot.invocations).some((value) => {
          const invocation = objectValue(value);
          return invocation?.rsid === evidence.rsid &&
            invocation.invocationId === evidence.invocationId &&
            invocation.state === "indeterminate" &&
            invocation.mutating === true &&
            invocation.dispatchMayHaveStarted === true;
        }));
      const fixtureStarted = snapshots(context, "fixture_execution_count").some((snapshot) =>
        arrayValue(snapshot.executionCounts).some((value) => {
          const row = objectValue(value);
          return row?.requestId === evidence.invocationId && row.count === 1;
        }));
      return terminal?.classification === "journal_indeterminate" &&
        expired?.correlationId === evidence.invocationId &&
        arrayValue(expired.mutationEntries).length === 1 &&
        bridgeIndeterminate &&
        fixtureStarted;
    }),
  );
}

define(
  "O1-C38-VALID-GUARDED-REASON",
  semanticEvent(["bridge_snapshot", "wire_event"], (candidate) =>
    candidate.status === "guarded" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(String(candidate.guarded_reason ?? candidate.guardedReason ?? ""))),
);
define(
  "O1-C38-MISSING-GUARDED-REASON",
  exactSchemaRejected("o1-c38.missing-reason", /guarded_reason|required|guarded|invalid/i),
);
define(
  "O1-C38-FIRST-DELIVERY-STOPS",
  safe((context) =>
    semanticControl(context, "o1-c38.first-delivery", (result) =>
      result.atomic === false &&
      result.status === "guarded" &&
      result.failed_step_index === 0) &&
    fixtureCount(context, /O1-C38:guarded:0|guarded:0/i, 1)),
);
define(
  "O1-C38-SUCCESSORS-NOT-STARTED",
  safe((context) =>
    hasDomainObject(context, ["bridge_snapshot", "wire_event"], (candidate) =>
      candidate.status === "not_started" &&
      numberValue(candidate.index) !== null &&
      (candidate.index as number) > 0) &&
    !snapshotHas(context, "fixture_execution_count", (candidate) =>
      Object.entries(candidate).some(([key, value]) =>
        /O1-C38:guarded:[12]|guarded:[12]/i.test(key) && typeof value === "number" && value > 0))),
);

define(
  "O1-C39-REPLAY-ONLY",
  semanticEvent(["gateway_snapshot", "bridge_snapshot", "wire_event"], (candidate) =>
    candidate.payload_omitted === true &&
    candidate.replayed === true &&
    typeof candidate.result_digest === "string"),
);
define("O1-C39-NONREPLAY-REJECTED", exactSchemaRejected("o1-c39.nonreplay", /payload_omitted|replayed|replay|invalid/i));
define("O1-C39-DIGEST-REQUIRED", exactSchemaRejected("o1-c39.missing_digest", /payload_omitted|result_digest|required|invalid/i));
define("O1-C39-RESULT-ABSENT", exactSchemaRejected("o1-c39.inline_result", /payload_omitted|result|forbid|invalid/i));
define(
  "O1-C39-AUDITED-READ-RECOVERY",
  semanticEvent(["gateway_snapshot", "bridge_snapshot"], (candidate) =>
    candidate.state === "recovered" &&
    typeof candidate.auditId === "string" &&
    typeof candidate.recoveryInvocationId === "string" &&
    typeof candidate.recoveryResultDigest === "string" &&
    candidate.mutating === false),
);

const expectedRawAssertionIds = RAW_PRODUCTION_CASES.flatMap((caseId) =>
  canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => id));
const expectedRawAssertionSet = new Set(expectedRawAssertionIds);
const observedRawAssertionIds = entries.map(([assertionId]) => assertionId);
const unknownRawAssertionIds = observedRawAssertionIds.filter((assertionId) =>
  !expectedRawAssertionSet.has(assertionId));
const missingRawAssertionIds = expectedRawAssertionIds.filter((assertionId) =>
  !observedRawAssertionIds.includes(assertionId));
if (
  unknownRawAssertionIds.length > 0 ||
  missingRawAssertionIds.length > 0 ||
  new Set(observedRawAssertionIds).size !== observedRawAssertionIds.length
) {
  throw new Error([
    "raw production oracle registry does not exactly cover C25-C40",
    `missing: ${missingRawAssertionIds.join(", ") || "none"}`,
    `unknown: ${unknownRawAssertionIds.join(", ") || "none"}`,
  ].join("; "));
}

export const RAW_PRODUCTION_ORACLES: CanonicalAssertionOracleRegistry = new Map(entries);
