import type {
  CanonicalAssertionOracle,
  CanonicalAssertionOracleContext,
  CanonicalAssertionOracleRegistry,
} from "./canonicalEvaluators.js";
import { canonicalManifest } from "./manifest.js";
import { MIDDLE_PRODUCTION_CASES } from "./productionCaseSeedsMiddle.js";
import type { ProcessObservationRecord } from "./types.js";

type ObjectValue = Record<string, unknown>;
type SnapshotKind = Extract<
  ProcessObservationRecord["kind"],
  "gateway_snapshot" | "bridge_snapshot" | "fixture_snapshot"
>;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

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

function observations(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind?: ProcessObservationRecord["kind"],
): readonly ProcessObservationRecord[] {
  return context.observations.filter((record) =>
    record.caseId === context.caseId &&
    record.binding === context.binding &&
    (kind === undefined || record.kind === kind));
}

function payload(
  record: ProcessObservationRecord | null | undefined,
): ObjectValue | null {
  return objectValue(record?.payload);
}

function recordAtStep(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: ProcessObservationRecord["kind"],
  stepId: string,
  componentId?: ProcessObservationRecord["componentId"],
): ProcessObservationRecord | null {
  const matches = observations(context, kind).filter((record) => {
    const root = payload(record);
    return root?.stepId === stepId &&
      (componentId === undefined || record.componentId === componentId);
  });
  return matches.length === 1 ? matches[0] as ProcessObservationRecord : null;
}

function controlRoot(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return payload(recordAtStep(context, "control_result", stepId));
}

function controlRequest(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(controlRoot(context, stepId)?.request);
}

function controlResponse(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(controlRoot(context, stepId)?.response);
}

function successfulResult(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const response = controlResponse(context, stepId);
  if (response?.kind !== "success") return null;
  return objectValue(response.result);
}

function snapshotAt(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: SnapshotKind,
  stepId: string,
): ObjectValue | null {
  return payload(recordAtStep(context, kind, stepId));
}

function finalSnapshot(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: SnapshotKind,
): ObjectValue | null {
  const suffix = kind === "gateway_snapshot"
    ? "gateway-snapshot"
    : kind === "bridge_snapshot"
      ? "bridge-snapshot"
      : "fixture-snapshot";
  return snapshotAt(context, kind, `${context.caseId.toLowerCase()}.${suffix}`);
}

interface DispatchEvidence {
  readonly rsid: string;
  readonly correlationId: string;
  readonly dispatched: ObjectValue;
  readonly terminal: ObjectValue;
  readonly terminalEnvelope: ObjectValue | null;
  readonly terminalPayload: ObjectValue | null;
  readonly gatewaySession: ObjectValue;
}

function dispatchEvidence(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): DispatchEvidence | null {
  const result = successfulResult(context, stepId);
  const rsid = stringValue(result?.rsid);
  const correlationId = stringValue(result?.correlationId);
  const dispatched = objectValue(result?.dispatched);
  const terminal = objectValue(result?.terminal);
  if (rsid === null || correlationId === null || dispatched === null || terminal === null) {
    return null;
  }
  const gateway = finalSnapshot(context, "gateway_snapshot");
  const sessions = objectValue(gateway?.sessions);
  const session = objectValue(sessions?.[rsid]);
  const terminalOutcomes = objectValue(session?.terminalOutcomes);
  const retained = objectValue(terminalOutcomes?.[correlationId]);
  if (
    session === null ||
    retained === null ||
    retained.classification !== terminal.classification
  ) {
    return null;
  }
  const terminalEnvelope = objectValue(terminal.envelope);
  const retainedEnvelope = objectValue(retained.envelope);
  if (
    (terminalEnvelope === null) !== (retainedEnvelope === null) ||
    (
      terminalEnvelope !== null &&
      retainedEnvelope !== null &&
      (
        terminalEnvelope.type !== retainedEnvelope.type ||
        JSON.stringify(terminalEnvelope.payload) !== JSON.stringify(retainedEnvelope.payload)
      )
    )
  ) {
    return null;
  }
  return {
    rsid,
    correlationId,
    dispatched,
    terminal,
    terminalEnvelope,
    terminalPayload: objectValue(terminalEnvelope?.payload),
    gatewaySession: session,
  };
}

function bridgeInvocation(
  context: Readonly<CanonicalAssertionOracleContext>,
  invocationId: string,
): ObjectValue | null {
  const invocations = arrayValue(finalSnapshot(context, "bridge_snapshot")?.invocations)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null)
    .filter((entry) => entry.invocationId === invocationId);
  return invocations.length === 1 ? invocations[0] as ObjectValue : null;
}

function fixtureSnapshot(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId?: string,
): ObjectValue | null {
  return stepId === undefined
    ? finalSnapshot(context, "fixture_snapshot")
    : snapshotAt(context, "fixture_snapshot", stepId);
}

function fixtureExecutionCount(snapshot: ObjectValue | null, requestId: string): number {
  if (snapshot === null) return 0;
  const rows = arrayValue(snapshot.executionCounts)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null)
    .filter((entry) => entry.requestId === requestId);
  if (rows.length === 0) return 0;
  return rows.length === 1 && Number.isSafeInteger(rows[0]?.count)
    ? Number(rows[0]?.count)
    : -1;
}

function fixtureMethodCount(snapshot: ObjectValue | null, method: string): number {
  if (snapshot === null) return 0;
  const rows = arrayValue(snapshot.methodExecutionCounts)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null)
    .filter((entry) => entry.method === method);
  if (rows.length === 0) return 0;
  return rows.length === 1 && Number.isSafeInteger(rows[0]?.count)
    ? Number(rows[0]?.count)
    : -1;
}

function fixtureObservations(snapshot: ObjectValue | null): ObjectValue[] {
  return arrayValue(snapshot?.observations)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null);
}

function requestArguments(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(controlRequest(context, stepId)?.arguments);
}

function dispatchRequestPayload(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(objectValue(requestArguments(context, stepId)?.request)?.payload);
}

function batchStepIds(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): string[] {
  return arrayValue(dispatchRequestPayload(context, stepId)?.steps)
    .map(objectValue)
    .map((entry) => stringValue(entry?.invocation_id))
    .filter((entry): entry is string => entry !== null);
}

function exactStatuses(value: unknown, statuses: readonly string[]): boolean {
  const steps = arrayValue(value).map(objectValue);
  return steps.length === statuses.length && steps.every((step, index) =>
    step?.index === index && step.status === statuses[index]);
}

function finalSequence(
  context: Readonly<CanonicalAssertionOracleContext>,
  rsid: string,
): ObjectValue | null {
  const matches = arrayValue(finalSnapshot(context, "bridge_snapshot")?.sequences)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null)
    .filter((entry) => entry.rsid === rsid);
  return matches.length === 1 ? matches[0] as ObjectValue : null;
}

function acceptedSequenceExactlyOnce(sequence: ObjectValue | null, seq: number): boolean {
  return arrayValue(sequence?.acceptedInbound)
    .map(objectValue)
    .filter((entry) => entry?.seq === seq)
    .length === 1;
}

function rawWire(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const record = recordAtStep(context, "wire_event", stepId, "gateway_stub");
  const root = payload(record as ProcessObservationRecord);
  if (
    root === null ||
    root.direction !== "parent_to_gateway" ||
    root.binding !== context.binding
  ) {
    return null;
  }
  const remote = objectValue(root.remoteOutcome);
  const expectedKind = context.binding === "wss"
    ? "wss_exchange"
    : "streamable_http_sse_exchange";
  return remote?.kind === expectedKind ? root : null;
}

function parsedRemoteFrames(remote: ObjectValue): ObjectValue[] {
  const direct = arrayValue(remote.receivedFrames);
  const sse = objectValue(remote.sse);
  return [...direct, ...arrayValue(sse?.receivedFrames)]
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null)
    .filter((entry) => entry.parseState === "parsed")
    .map((entry) => objectValue(entry.parsed))
    .filter((entry): entry is ObjectValue => entry !== null);
}

function exactBoundaryFault(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  type: "invoke" | "result",
  boundaryBytes: number,
  message: RegExp,
): boolean {
  const wire = rawWire(context, stepId);
  const serialized = objectValue(wire?.serialized);
  const frame = objectValue(wire?.frame);
  const remote = objectValue(wire?.remoteOutcome);
  if (
    wire === null ||
    serialized === null ||
    frame?.type !== type ||
    remote === null ||
    !SHA256.test(String(serialized.sha256)) ||
    !(Number(serialized.bytes) > boundaryBytes)
  ) {
    return false;
  }
  return parsedRemoteFrames(remote).some((entry) => {
    const error = objectValue(entry.payload);
    return entry.type === "error" &&
      error?.fault_class === "protocol" &&
      error.retryable === false &&
      error.outcome === "known" &&
      error.verification_required === false &&
      message.test(String(error.message));
  });
}

function c19CapturePair(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  vector: string,
): ObjectValue | null {
  const matches = observations(context, "wire_event").filter((record) => {
    const root = payload(record);
    return root?.stepId === stepId &&
      root.schemaVersion === "rbp-c19-wire-event/v2" &&
      root.vector === vector;
  });
  if (
    matches.length !== 2 ||
    !matches.some(({ componentId }) => componentId === "bridge_simulator") ||
    !matches.some(({ componentId }) => componentId === "addin_loopback_fixture")
  ) {
    return null;
  }
  const left = payload(matches[0] as ProcessObservationRecord);
  const right = payload(matches[1] as ProcessObservationRecord);
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right)
    ? left
    : null;
}

function bigEndianHeader(payloadBytes: number): string {
  return payloadBytes.toString(16).padStart(8, "0");
}

function c19Correlated(capture: ObjectValue): boolean {
  const requestIds = arrayValue(capture.requestIds);
  const responseIds = arrayValue(capture.responseIds);
  return requestIds.length > 0 &&
    requestIds.length === responseIds.length &&
    requestIds.every((id, index) => typeof id === "string" && id === responseIds[index]);
}

function c19CountsExactlyOnce(
  context: Readonly<CanonicalAssertionOracleContext>,
  capture: ObjectValue,
): boolean {
  const snapshot = fixtureSnapshot(context);
  return arrayValue(capture.requestIds).every((requestId) =>
    typeof requestId === "string" && fixtureExecutionCount(snapshot, requestId) === 1);
}

function mappedError(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  expectedFaultClass: string,
  message: RegExp,
): boolean {
  const evidence = dispatchEvidence(context, stepId);
  const terminal = evidence?.terminalPayload;
  const journal = evidence === null
    ? null
    : bridgeInvocation(context, evidence.correlationId);
  const fixtureFailure = fixtureObservations(fixtureSnapshot(context))
    .some((entry) =>
      entry.requestId === evidence?.correlationId &&
      entry.phase === "failed" &&
      message.test(String(entry.detail)));
  return evidence !== null &&
    evidence.terminal.classification === "error" &&
    evidence.terminalEnvelope?.type === "error" &&
    terminal?.invocation_id === evidence.correlationId &&
    terminal.fault_class === expectedFaultClass &&
    terminal.outcome === "known" &&
    terminal.verification_required === false &&
    terminal.replayed === false &&
    fixtureFailure &&
    journal?.state === "failed" &&
    SHA256.test(String(journal.terminalOutcomeDigest));
}

function configuredFrameFault(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
  action: "duplicate" | "hold",
): boolean {
  const request = controlRequest(context, stepId);
  const argumentsValue = objectValue(request?.arguments);
  const rule = objectValue(argumentsValue?.rule);
  const response = controlResponse(context, stepId);
  return request?.action === "enqueue_frame_fault" &&
    rule?.direction === "gateway_to_bridge" &&
    rule.action === action &&
    rule.remaining === 1 &&
    rule.binding === (context.binding === "wss" ? "wss" : "http_sse") &&
    response?.kind === "success";
}

function safe(oracle: CanonicalAssertionOracle): CanonicalAssertionOracle {
  return (context) => {
    try {
      return oracle(context) === true;
    } catch {
      return false;
    }
  };
}

const orderedChunks: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c15.dispatch");
  const artifacts = dispatch === null
    ? []
    : arrayValue(objectValue(dispatch.gatewaySession.artifacts)?.[dispatch.correlationId])
      .map(objectValue);
  return dispatch !== null &&
    dispatch.terminal.classification === "result" &&
    dispatch.terminalPayload?.status === "completed" &&
    artifacts.length === 2 &&
    artifacts.every((artifact, index) =>
      artifact?.artifactIndex === index &&
      typeof artifact.artifactId === "string" &&
      typeof artifact.streamId === "string" &&
      artifact.totalChunks === 4 &&
      artifact.totalSize === 4_194_304) &&
    new Set(artifacts.map((artifact) => artifact?.artifactId)).size === 2 &&
    new Set(artifacts.map((artifact) => artifact?.streamId)).size === 2;
};

const digestVerified: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c15.dispatch");
  const artifacts = dispatch === null
    ? []
    : arrayValue(objectValue(dispatch.gatewaySession.artifacts)?.[dispatch.correlationId])
      .map(objectValue);
  return dispatch !== null &&
    SHA256.test(String(dispatch.terminalPayload?.result_digest)) &&
    artifacts.length === 2 &&
    artifacts.every((artifact) =>
      artifact?.totalSize === 4_194_304 &&
      artifact.totalChunks === 4 &&
      SHA256.test(String(artifact.sha256)));
};

const progressDelivered: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c15.dispatch");
  const peer = objectValue(finalSnapshot(context, "bridge_snapshot")?.peer);
  const delivery = objectValue(peer?.deliveryProgress);
  const records = arrayValue(delivery?.records)
    .map(objectValue)
    .filter((entry) => entry?.invocationId === dispatch?.correlationId);
  const record = records.length === 1 ? records[0] : null;
  return dispatch !== null &&
    delivery?.evidenceVersion === 1 &&
    record?.chunkFramesSent === 8 &&
    record.artifactChunkFramesSent === 8 &&
    record.resultChunkFramesSent === 0 &&
    record.progressFramesSent === 2 &&
    record.terminalFramesSent === 1 &&
    Number.isSafeInteger(record.lastSentSeq);
};

const backpressureControlled: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c15.dispatch");
  const blocked = snapshotAt(
    context,
    "bridge_snapshot",
    "o1-c15.await-bounded-chunk",
  );
  const blockedPeer = objectValue(blocked?.peer);
  const blockedBackpressure = objectValue(blockedPeer?.backpressure);
  const blockedDeliveries = arrayValue(
    objectValue(blockedPeer?.deliveryProgress)?.records,
  ).map(objectValue);
  const blockedDelivery = blockedDeliveries.length === 1
    ? blockedDeliveries[0]
    : null;
  const blockedSequences = arrayValue(blocked?.sequences)
    .map(objectValue)
    .filter((entry) => entry?.rsid === dispatch?.rsid);
  const blockedSequence = blockedSequences.length === 1
    ? blockedSequences[0]
    : null;
  const serviceable = snapshotAt(
    context,
    "gateway_snapshot",
    "o1-c15.control-serviceable",
  );
  const serviceSessions = objectValue(serviceable?.sessions);
  const serviceSession = dispatch === null ? null : objectValue(serviceSessions?.[dispatch.rsid]);
  const serviceTerminal = dispatch === null
    ? null
    : objectValue(objectValue(serviceSession?.terminalOutcomes)?.[dispatch.correlationId]);
  const finalBackpressure = objectValue(
    objectValue(finalSnapshot(context, "bridge_snapshot")?.peer)?.backpressure,
  );
  const on = observations(context, "wire_event")
    .map(payload)
    .find((entry) =>
      entry?.stepId === "o1-c15.backpressure-on" &&
      entry.schemaVersion === "rbp-parent-proxy-backpressure/v1");
  const off = observations(context, "wire_event")
    .map(payload)
    .find((entry) =>
      entry?.stepId === "o1-c15.backpressure-off" &&
      entry.schemaVersion === "rbp-parent-proxy-backpressure/v1");
  const bindingBounded = context.binding === "wss"
    ? blockedDelivery !== null &&
      blockedDelivery.invocationId === dispatch?.correlationId &&
      blockedDelivery.chunkFramesSent === 1 &&
      blockedDelivery.progressFramesSent === 0 &&
      blockedDelivery.terminalFramesSent === 0 &&
      arrayValue(blockedSequence?.outbox).length === 1
    : Number(blockedBackpressure?.currentBufferedAmount) >= 1 &&
      Number(blockedPeer?.queuedDataCount) >= 10 &&
      blockedDeliveries.length === 0;
  return dispatch !== null &&
    on?.enabled === true &&
    Number(on.activeConnections) >= 1 &&
    off?.enabled === false &&
    Number(off.activeConnections) >= 1 &&
    bindingBounded &&
    Number(blockedBackpressure?.currentBufferedAmount) <=
      Number(blockedBackpressure?.highWaterBytes) &&
    Number(finalBackpressure?.maxObservedBufferedAmount) <=
      Number(finalBackpressure?.highWaterBytes) &&
    Number(finalBackpressure?.sampleCount) > 0 &&
    objectValue(serviceSession?.inFlight)?.correlationId === dispatch.correlationId &&
    serviceTerminal === null &&
    Number(objectValue(serviceable?.runtime)?.openConnections) >= 1;
};

const paramsOversize: CanonicalAssertionOracle = (context) =>
  exactBoundaryFault(
    context,
    "o1-c16.params-oversize",
    "invoke",
    4_194_304,
    /\/payload\/params is 4194305 UTF-8 bytes; limit is 4194304/u,
  );

const resultOversize: CanonicalAssertionOracle = (context) =>
  exactBoundaryFault(
    context,
    "o1-c16.result-oversize",
    "result",
    33_554_432,
    /combined invocation result is 33554433 bytes; limit is 33554432/u,
  );

const cancellationDelivered: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c17.dispatch");
  const cancel = successfulResult(context, "o1-c17.cancel");
  const cancelPayload = objectValue(cancel?.payload);
  const journal = dispatch === null
    ? null
    : bridgeInvocation(context, dispatch.correlationId);
  const invokeSeq = numberValue(dispatch?.dispatched.seq);
  const cancelSeq = numberValue(cancel?.seq);
  const sequence = dispatch === null ? null : finalSequence(context, dispatch.rsid);
  return dispatch !== null &&
    cancel?.type === "cancel" &&
    cancel?.rsid === dispatch.rsid &&
    cancelPayload?.invocation_id === dispatch.correlationId &&
    cancelPayload.reason === "user_requested" &&
    invokeSeq !== null &&
    cancelSeq !== null &&
    cancelSeq > invokeSeq &&
    acceptedSequenceExactlyOnce(sequence, cancelSeq) &&
    journal?.abandoned === true &&
    dispatch.terminal.classification === "cancelled";
};

const lateOutcomePreserved: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c17.dispatch");
  const journal = dispatch === null
    ? null
    : bridgeInvocation(context, dispatch.correlationId);
  const fixture = fixtureSnapshot(context);
  const phases = fixtureObservations(fixture)
    .filter((entry) => entry.requestId === dispatch?.correlationId)
    .map((entry) => entry.phase);
  return dispatch !== null &&
    dispatch.terminal.classification === "cancelled" &&
    (
      dispatch.terminalEnvelope === null ||
      (
        dispatch.terminalEnvelope.type === "error" &&
        dispatch.terminalPayload?.fault_class === "cancelled"
      )
    ) &&
    journal?.abandoned === true &&
    ["completed", "guarded", "failed"].includes(String(journal.state)) &&
    SHA256.test(String(journal.terminalOutcomeDigest)) &&
    phases.includes("dispatch_started") &&
    phases.some((phase) => phase === "dispatch_finished" || phase === "guarded" || phase === "failed") &&
    fixtureExecutionCount(fixture, dispatch.correlationId) === 1;
};

const methodNotFoundMapped: CanonicalAssertionOracle = (context) =>
  mappedError(context, "o1-c18.invoke-method", "unsupported", /method not found/i);

const invalidParamsMapped: CanonicalAssertionOracle = (context) =>
  mappedError(context, "o1-c18.invoke-params", "parameter", /invalid params/i);

const addinExceptionMapped: CanonicalAssertionOracle = (context) =>
  mappedError(context, "o1-c18.invoke-exception", "revit_api", /injected add-in exception/i);

const guardedResultMapped: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c18.invoke-guarded");
  const journal = dispatch === null
    ? null
    : bridgeInvocation(context, dispatch.correlationId);
  return dispatch !== null &&
    dispatch.terminal.classification === "result" &&
    dispatch.terminalEnvelope?.type === "result" &&
    dispatch.terminalPayload?.invocation_id === dispatch.correlationId &&
    dispatch.terminalPayload.status === "guarded" &&
    dispatch.terminalPayload.guarded_reason === "busy" &&
    dispatch.terminalPayload.replayed === false &&
    SHA256.test(String(dispatch.terminalPayload.result_digest)) &&
    journal?.state === "guarded" &&
    SHA256.test(String(journal.terminalOutcomeDigest));
};

const failureShapedResultMapped: CanonicalAssertionOracle = (context) =>
  mappedError(
    context,
    "o1-c18.invoke-failure-shaped",
    "revit_api",
    /failure-shaped add-in result/i,
  );

const bigEndianPrefix: CanonicalAssertionOracle = (context) => {
  const capture = c19CapturePair(context, "o1-c19.big-endian", "big_endian");
  if (capture === null || !c19Correlated(capture) || !c19CountsExactlyOnce(context, capture)) {
    return false;
  }
  const requestBytes = arrayValue(capture.payloadBytes);
  const requestHeaders = arrayValue(capture.requestHeaderHexes);
  const responseBytes = arrayValue(capture.responsePayloadBytes);
  const responseHeaders = arrayValue(capture.responseHeaderHexes);
  return requestBytes.length === 1 &&
    responseBytes.length === 1 &&
    requestHeaders[0] === bigEndianHeader(Number(requestBytes[0])) &&
    responseHeaders[0] === bigEndianHeader(Number(responseBytes[0]));
};

const splitRead: CanonicalAssertionOracle = (context) => {
  const capture = c19CapturePair(context, "o1-c19.split", "split_read");
  if (capture === null || !c19Correlated(capture) || !c19CountsExactlyOnce(context, capture)) {
    return false;
  }
  const payloadBytes = Number(arrayValue(capture.payloadBytes)[0]);
  const writes = arrayValue(capture.writeChunkSizes).map(Number);
  return Number.isSafeInteger(payloadBytes) &&
    writes.length === 4 &&
    writes[0] === 1 &&
    writes[1] === 2 &&
    writes[2] === 4 &&
    writes[3] === payloadBytes + 4 - 7 &&
    writes.reduce((sum, value) => sum + value, 0) === payloadBytes + 4;
};

const coalescedRead: CanonicalAssertionOracle = (context) => {
  const capture = c19CapturePair(context, "o1-c19.coalesced", "coalesced_read");
  if (capture === null || !c19Correlated(capture) || !c19CountsExactlyOnce(context, capture)) {
    return false;
  }
  const payloadBytes = arrayValue(capture.payloadBytes).map(Number);
  const writes = arrayValue(capture.writeChunkSizes).map(Number);
  return payloadBytes.length === 2 &&
    writes.length === 1 &&
    writes[0] === payloadBytes.reduce((sum, value) => sum + value + 4, 0);
};

const former8192Case: CanonicalAssertionOracle = (context) => {
  const capture = c19CapturePair(context, "o1-c19.former-8192", "former_8192");
  if (capture === null || !c19Correlated(capture) || !c19CountsExactlyOnce(context, capture)) {
    return false;
  }
  return arrayValue(capture.payloadBytes)[0] === 8_192 &&
    arrayValue(capture.requestHeaderHexes)[0] === "00002000" &&
    arrayValue(capture.writeChunkSizes)[0] === 8_196;
};

const nonAtomicOrderedFanout: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c20.batch");
  const request = dispatchRequestPayload(context, "o1-c20.batch");
  const stepIds = batchStepIds(context, "o1-c20.batch");
  const fixture = fixtureSnapshot(context);
  const started = fixtureObservations(fixture)
    .filter((entry) =>
      entry.phase === "dispatch_started" &&
      typeof entry.requestId === "string" &&
      stepIds.includes(entry.requestId))
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .map((entry) => entry.requestId);
  return dispatch !== null &&
    dispatch.terminalPayload !== null &&
    request?.atomic === false &&
    exactStatuses(dispatch.terminalPayload.steps, ["completed", "failed", "not_started"]) &&
    stepIds.length === 3 &&
    fixtureExecutionCount(fixture, stepIds[0] as string) === 1 &&
    fixtureExecutionCount(fixture, stepIds[1] as string) === 1 &&
    fixtureExecutionCount(fixture, stepIds[2] as string) === 0 &&
    JSON.stringify(started) === JSON.stringify(stepIds.slice(0, 2));
};

const nonAtomicFailureIndex: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c20.batch");
  const steps = arrayValue(dispatch?.terminalPayload?.steps).map(objectValue);
  const failed = steps[1];
  const error = objectValue(failed?.error);
  return dispatch !== null &&
    dispatch.terminal.classification === "result" &&
    dispatch.terminalPayload?.status === "failed" &&
    dispatch.terminalPayload.failed_step_index === 1 &&
    failed?.index === 1 &&
    failed.status === "failed" &&
    error?.fault_class === "parameter" &&
    error.outcome === "known" &&
    error.verification_required === false;
};

const unsupportedWithoutCapability: CanonicalAssertionOracle = (context) => {
  const response = controlResponse(context, "o1-c21.batch");
  const gateway = finalSnapshot(context, "gateway_snapshot");
  const sessions = objectValue(gateway?.sessions);
  const session = objectValue(Object.values(sessions ?? {})[0]);
  const bridgeSession = objectValue(arrayValue(finalSnapshot(context, "bridge_snapshot")?.sessions)[0]);
  return response?.kind === "control_error" &&
    response.code === "gateway_control_http_400" &&
    response.message === "atomic batch is not granted for this session" &&
    Array.isArray(session?.grantedSessionCapabilities) &&
    !session.grantedSessionCapabilities.includes("batch_atomic") &&
    Array.isArray(bridgeSession?.grantedSessionCapabilities) &&
    !bridgeSession.grantedSessionCapabilities.includes("batch_atomic") &&
    session?.inFlight === null;
};

const zeroAtomicStepExecution: CanonicalAssertionOracle = (context) => {
  const payloadValue = dispatchRequestPayload(context, "o1-c21.batch");
  const batchId = stringValue(payloadValue?.batch_id);
  const stepIds = batchStepIds(context, "o1-c21.batch");
  const fixture = fixtureSnapshot(context);
  const gateway = finalSnapshot(context, "gateway_snapshot");
  const sessions = objectValue(gateway?.sessions);
  const session = objectValue(Object.values(sessions ?? {})[0]);
  return batchId !== null &&
    stepIds.length === 2 &&
    fixtureExecutionCount(fixture, batchId) === 0 &&
    fixtureMethodCount(fixture, "execute_batch") === 0 &&
    stepIds.every((stepId) => fixtureExecutionCount(fixture, stepId) === 0) &&
    objectValue(session?.terminalOutcomes)?.[batchId] === undefined &&
    session?.inFlight === null;
};

const atomicCapabilityGated: CanonicalAssertionOracle = (context) => {
  const commit = dispatchEvidence(context, "o1-c22.commit");
  const rollback = dispatchEvidence(context, "o1-c22.rollback");
  const bridgeSessions = arrayValue(finalSnapshot(context, "bridge_snapshot")?.sessions)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null);
  return commit !== null &&
    rollback !== null &&
    Array.isArray(commit.gatewaySession.grantedSessionCapabilities) &&
    commit.gatewaySession.grantedSessionCapabilities.includes("batch_atomic") &&
    bridgeSessions.length === 1 &&
    Array.isArray(bridgeSessions[0]?.grantedSessionCapabilities) &&
    bridgeSessions[0]?.grantedSessionCapabilities.includes("batch_atomic") &&
    dispatchRequestPayload(context, "o1-c22.commit")?.atomic === true &&
    dispatchRequestPayload(context, "o1-c22.rollback")?.atomic === true;
};

const atomicOneFrameCommit: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c22.commit");
  const request = dispatchRequestPayload(context, "o1-c22.commit");
  const batchId = stringValue(request?.batch_id);
  const stepIds = batchStepIds(context, "o1-c22.commit");
  const afterCommit = fixtureSnapshot(context, "o1-c22.after-commit");
  const validated = fixtureObservations(afterCommit)
    .filter((entry) =>
      entry.requestId === batchId &&
      entry.method === "execute_batch" &&
      entry.phase === "validated");
  const stepValidated = fixtureObservations(afterCommit)
    .filter((entry) => stepIds.includes(String(entry.requestId)) && entry.phase === "validated");
  return dispatch !== null &&
    dispatch.terminalPayload !== null &&
    batchId !== null &&
    request?.atomic === true &&
    dispatch.terminalPayload.status === "completed" &&
    dispatch.terminalPayload.failed_step_index === null &&
    exactStatuses(dispatch.terminalPayload.steps, ["completed", "completed", "completed"]) &&
    fixtureExecutionCount(afterCommit, batchId) === 1 &&
    fixtureMethodCount(afterCommit, "execute_batch") === 1 &&
    stepIds.length === 3 &&
    stepIds.every((stepId) => fixtureExecutionCount(afterCommit, stepId) === 1) &&
    validated.length === 1 &&
    stepValidated.length === 0 &&
    afterCommit?.modelStateEntryCount === 1 &&
    SHA256.test(String(afterCommit?.modelStateDigest));
};

const atomicOneFrameRollback: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c22.rollback");
  const request = dispatchRequestPayload(context, "o1-c22.rollback");
  const batchId = stringValue(request?.batch_id);
  const stepIds = batchStepIds(context, "o1-c22.rollback");
  const afterCommit = fixtureSnapshot(context, "o1-c22.after-commit");
  const afterRollback = fixtureSnapshot(context, "o1-c22.after-rollback");
  const validated = fixtureObservations(afterRollback)
    .filter((entry) =>
      entry.requestId === batchId &&
      entry.method === "execute_batch" &&
      entry.phase === "validated");
  const stepValidated = fixtureObservations(afterRollback)
    .filter((entry) => stepIds.includes(String(entry.requestId)) && entry.phase === "validated");
  const terminalSteps = arrayValue(dispatch?.terminalPayload?.steps).map(objectValue);
  const firstResult = objectValue(terminalSteps[0]?.result);
  const secondResult = objectValue(terminalSteps[1]?.result);
  return dispatch !== null &&
    dispatch.terminalPayload !== null &&
    batchId !== null &&
    request?.atomic === true &&
    dispatch.terminalPayload.status === "failed" &&
    dispatch.terminalPayload.failed_step_index === 2 &&
    exactStatuses(dispatch.terminalPayload.steps, ["completed", "completed", "failed"]) &&
    firstResult?.effect_state === "discarded" &&
    firstResult.result_suppressed === "batch_rolled_back" &&
    secondResult?.effect_state === "rolled_back" &&
    secondResult.result_suppressed === "batch_rolled_back" &&
    fixtureExecutionCount(afterRollback, batchId) === 1 &&
    fixtureMethodCount(afterRollback, "execute_batch") === 2 &&
    stepIds.length === 3 &&
    stepIds.every((stepId) => fixtureExecutionCount(afterRollback, stepId) === 1) &&
    validated.length === 1 &&
    stepValidated.length === 0 &&
    SHA256.test(String(afterCommit?.modelStateDigest)) &&
    afterRollback?.modelStateDigest === afterCommit?.modelStateDigest &&
    afterRollback?.modelStateEntryCount === afterCommit?.modelStateEntryCount;
};

const contextWithin15Seconds: CanonicalAssertionOracle = (context) => {
  const poll = successfulResult(context, "o1-c23.poll");
  const awaitedRecord = recordAtStep(
    context,
    "gateway_snapshot",
    "o1-c23.await-context",
    "gateway_stub",
  );
  const awaited = payload(awaitedRecord as ProcessObservationRecord);
  const sessions = objectValue(awaited?.sessions);
  const session = objectValue(Object.values(sessions ?? {})[0]);
  const documents = arrayValue(session?.documents).map(objectValue);
  const fixture = fixtureSnapshot(context);
  const evidence = objectValue(fixture?.documentContextEvidence);
  const timeline = arrayValue(evidence?.timeline)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null);
  const update = timeline.find((entry) =>
    entry.kind === "application_event_cache_update" && entry.revision === 2);
  const read = timeline.find((entry) =>
    entry.kind === "cache_read" &&
    entry.revision === 2 &&
    Number(entry.sequence) > Number(update?.sequence));
  const eventRecord = recordAtStep(
    context,
    "control_result",
    "o1-c23.context-event",
    "addin_loopback_fixture",
  );
  const elapsedWallMs = awaitedRecord === null || eventRecord === null
    ? Number.POSITIVE_INFINITY
    : Date.parse(awaitedRecord.at) - Date.parse(eventRecord.at);
  return poll?.pushed === true &&
    documents.some((document) =>
      document?.document_id === "conformance-document" &&
      document.title === "Conformance Fixture Revision 2") &&
    update !== undefined &&
    read !== undefined &&
    Number(read.atMonotonicMs) - Number(update.atMonotonicMs) >= 0 &&
    Number(read.atMonotonicMs) - Number(update.atMonotonicMs) <= 15_000 &&
    elapsedWallMs >= 0 &&
    elapsedWallMs <= 15_000;
};

const noExternalEventPolling: CanonicalAssertionOracle = (context) => {
  const fixture = fixtureSnapshot(context);
  const evidence = objectValue(fixture?.documentContextEvidence);
  const timeline = arrayValue(evidence?.timeline).map(objectValue);
  return evidence?.evidenceVersion === 1 &&
    evidence.currentRevision === 2 &&
    evidence.applicationEventCacheUpdateCount === 1 &&
    Number(evidence.cacheReadCount) >= 2 &&
    Number(evidence.pollRequestCount) >= 2 &&
    evidence.externalEventRaiseCount === 0 &&
    timeline.every((entry) =>
      entry !== null &&
      ["cache_initialized", "application_event_cache_update", "cache_read"]
        .includes(String(entry.kind)));
};

const duplicateDataFrame: CanonicalAssertionOracle = (context) => {
  const dispatch = dispatchEvidence(context, "o1-c24.dispatch-a");
  const seq = numberValue(dispatch?.dispatched.seq);
  const sequence = dispatch === null ? null : finalSequence(context, dispatch.rsid);
  const journal = dispatch === null
    ? null
    : bridgeInvocation(context, dispatch.correlationId);
  const fixture = fixtureSnapshot(context);
  return configuredFrameFault(context, "o1-c24.duplicate", "duplicate") &&
    dispatch !== null &&
    seq !== null &&
    dispatch.terminal.classification === "result" &&
    dispatch.terminalPayload?.status === "completed" &&
    acceptedSequenceExactlyOnce(sequence, seq) &&
    fixtureExecutionCount(fixture, dispatch.correlationId) === 1 &&
    journal?.state === "completed" &&
    SHA256.test(String(journal.terminalOutcomeDigest));
};

const reorderedAcrossReconnect: CanonicalAssertionOracle = (context) => {
  const first = dispatchEvidence(context, "o1-c24.dispatch-a");
  const second = dispatchEvidence(context, "o1-c24.dispatch-b");
  const firstSeq = numberValue(first?.dispatched.seq);
  const secondSeq = numberValue(second?.dispatched.seq);
  const awaitResume = snapshotAt(
    context,
    "bridge_snapshot",
    "o1-c24.await-resume-ack",
  );
  const awaitPeer = objectValue(awaitResume?.peer);
  const resumedSessions = arrayValue(awaitPeer?.sessions)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null)
    .filter((entry) => entry.rsid === first?.rsid);
  const finalBridge = finalSnapshot(context, "bridge_snapshot");
  const finalPeer = objectValue(finalBridge?.peer);
  const sequence = first === null ? null : finalSequence(context, first.rsid);
  const accepted = arrayValue(sequence?.acceptedInbound)
    .map(objectValue)
    .filter((entry): entry is ObjectValue => entry !== null)
    .map((entry) => Number(entry.seq));
  const disconnect = successfulResult(context, "o1-c24.disconnect");
  const open = successfulResult(context, "o1-c24.open");
  const reopen = successfulResult(context, "o1-c24.reopen");
  const oldConnectionId = stringValue(open?.connectionId);
  const newConnectionId = stringValue(reopen?.connectionId);
  return configuredFrameFault(context, "o1-c24.hold-first", "hold") &&
    first !== null &&
    second !== null &&
    first.rsid === second.rsid &&
    firstSeq !== null &&
    secondSeq === firstSeq + 1 &&
    disconnect !== null &&
    oldConnectionId !== null &&
    newConnectionId !== null &&
    newConnectionId !== oldConnectionId &&
    awaitPeer?.connectionId === newConnectionId &&
    resumedSessions.length === 1 &&
    resumedSessions[0]?.phase === "registered" &&
    finalPeer?.connectionId === newConnectionId &&
    acceptedSequenceExactlyOnce(sequence, firstSeq) &&
    acceptedSequenceExactlyOnce(sequence, secondSeq) &&
    accepted.every((seq, index) => index === 0 || seq > Number(accepted[index - 1])) &&
    Number(sequence?.lastRxSeq) >= secondSeq &&
    fixtureExecutionCount(fixtureSnapshot(context), second.correlationId) === 1 &&
    second.terminal.classification === "result" &&
    second.terminalPayload?.status === "completed";
};

const entries: Array<readonly [string, CanonicalAssertionOracle]> = [
  ["O1-C15-ORDERED-CHUNKS", safe(orderedChunks)],
  ["O1-C15-DIGEST-VERIFIED", safe(digestVerified)],
  ["O1-C15-PROGRESS", safe(progressDelivered)],
  ["O1-C15-BACKPRESSURE", safe(backpressureControlled)],
  ["O1-C16-PARAMS-OVERSIZE", safe(paramsOversize)],
  ["O1-C16-RESULT-OVERSIZE", safe(resultOversize)],
  ["O1-C17-CANCELLATION", safe(cancellationDelivered)],
  ["O1-C17-LATE-OUTCOME-PRESERVED", safe(lateOutcomePreserved)],
  ["O1-C18-METHOD-NOT-FOUND", safe(methodNotFoundMapped)],
  ["O1-C18-INVALID-PARAMS", safe(invalidParamsMapped)],
  ["O1-C18-ADDIN-EXCEPTION", safe(addinExceptionMapped)],
  ["O1-C18-GUARDED-RESULT", safe(guardedResultMapped)],
  ["O1-C18-FAILURE-SHAPED-RESULT", safe(failureShapedResultMapped)],
  ["O1-C19-BIG-ENDIAN-PREFIX", safe(bigEndianPrefix)],
  ["O1-C19-SPLIT-READ", safe(splitRead)],
  ["O1-C19-COALESCED-READ", safe(coalescedRead)],
  ["O1-C19-FORMER-8192-CASE", safe(former8192Case)],
  ["O1-C20-ORDERED-FANOUT", safe(nonAtomicOrderedFanout)],
  ["O1-C20-FAILURE-INDEX", safe(nonAtomicFailureIndex)],
  ["O1-C21-UNSUPPORTED-WITHOUT-CAPABILITY", safe(unsupportedWithoutCapability)],
  ["O1-C21-ZERO-STEP-EXECUTION", safe(zeroAtomicStepExecution)],
  ["O1-C22-CAPABILITY-GATED", safe(atomicCapabilityGated)],
  ["O1-C22-ONE-FRAME-COMMIT", safe(atomicOneFrameCommit)],
  ["O1-C22-ONE-FRAME-ROLLBACK", safe(atomicOneFrameRollback)],
  ["O1-C23-CONTEXT-WITHIN-15S", safe(contextWithin15Seconds)],
  ["O1-C23-NO-EXTERNAL-EVENT-POLLING", safe(noExternalEventPolling)],
  ["O1-C24-DUPLICATE-DATA-FRAME", safe(duplicateDataFrame)],
  ["O1-C24-REORDERED-DATA-FRAME", safe(reorderedAcrossReconnect)],
];

const expectedAssertionIds = MIDDLE_PRODUCTION_CASES.flatMap((caseId) =>
  canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => id));
const expectedAssertionSet = new Set(expectedAssertionIds);
const observedAssertionIds = entries.map(([assertionId]) => assertionId);
const unknownAssertionIds = observedAssertionIds.filter((assertionId) =>
  !expectedAssertionSet.has(assertionId));
const missingAssertionIds = expectedAssertionIds.filter((assertionId) =>
  !observedAssertionIds.includes(assertionId));
const nonFunctionAssertionIds = entries
  .filter(([, oracle]) => typeof oracle !== "function")
  .map(([assertionId]) => assertionId);

if (
  unknownAssertionIds.length > 0 ||
  missingAssertionIds.length > 0 ||
  nonFunctionAssertionIds.length > 0 ||
  new Set(observedAssertionIds).size !== observedAssertionIds.length ||
  observedAssertionIds.length !== expectedAssertionIds.length
) {
  throw new Error([
    "middle production oracle registry does not exactly cover O1-C15 through O1-C24",
    `missing: ${missingAssertionIds.join(", ") || "none"}`,
    `unknown: ${unknownAssertionIds.join(", ") || "none"}`,
    `non-functions: ${nonFunctionAssertionIds.join(", ") || "none"}`,
  ].join("; "));
}

export const MIDDLE_PRODUCTION_ORACLES: CanonicalAssertionOracleRegistry =
  new Map(entries);
