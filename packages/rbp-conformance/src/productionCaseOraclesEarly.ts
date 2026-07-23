import type {
  CanonicalAssertionOracle,
  CanonicalAssertionOracleContext,
  CanonicalAssertionOracleRegistry,
} from "./canonicalEvaluators.js";
import { canonicalManifest } from "./manifest.js";
import { EARLY_PRODUCTION_CASES } from "./productionCaseSeedsEarly.js";
import type { ProcessObservationRecord } from "./types.js";

type ObjectValue = Record<string, unknown>;
type SnapshotKind = Extract<
  ProcessObservationRecord["kind"],
  "gateway_snapshot" | "bridge_snapshot" | "fixture_snapshot" | "fixture_execution_count"
>;

function objectValue(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : null;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function pathValue(value: unknown, path: readonly string[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (Array.isArray(cursor)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return undefined;
      cursor = cursor[Number(segment)];
      continue;
    }
    const object = objectValue(cursor);
    if (object === null || !Object.prototype.hasOwnProperty.call(object, segment)) return undefined;
    cursor = object[segment];
  }
  return cursor;
}

function records(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind?: ProcessObservationRecord["kind"],
): readonly ProcessObservationRecord[] {
  return context.observations.filter((record) =>
    record.caseId === context.caseId &&
    record.binding === context.binding &&
    (kind === undefined || record.kind === kind));
}

function payload(record: ProcessObservationRecord): ObjectValue | null {
  return objectValue(record.payload);
}

function controlResponse(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const selected = records(context, "control_result")
    .map(payload)
    .find((candidate) => candidate?.stepId === stepId);
  return objectValue(selected?.response);
}

function successfulResult(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const response = controlResponse(context, stepId);
  return response?.kind === "success" ? objectValue(response.result) : null;
}

function invokeOutcome(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  return objectValue(successfulResult(context, stepId)?.outcome);
}

function snapshots(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: SnapshotKind,
): ObjectValue[] {
  return records(context, kind)
    .map(payload)
    .filter((candidate): candidate is ObjectValue => candidate !== null);
}

function latestSnapshot(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: SnapshotKind,
): ObjectValue | null {
  return snapshots(context, kind).at(-1) ?? null;
}

function stepSnapshot(
  context: Readonly<CanonicalAssertionOracleContext>,
  kind: SnapshotKind,
  stepId: string,
): ObjectValue | null {
  return snapshots(context, kind).find((candidate) => candidate.stepId === stepId) ?? null;
}

function remoteOutcome(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const matches = records(context, "wire_event")
    .map(payload)
    .filter((candidate) => candidate?.stepId === stepId);
  return matches.length === 1 ? objectValue(matches[0]?.remoteOutcome) : null;
}

function openingResponse(
  context: Readonly<CanonicalAssertionOracleContext>,
  stepId: string,
): ObjectValue | null {
  const remote = remoteOutcome(context, stepId);
  if (remote === null) return null;
  return context.binding === "wss"
    ? objectValue(remote.upgradeResponse)
    : objectValue(remote.createResponse);
}

function fixtureMethodCount(snapshot: ObjectValue | null, method: string): number | null {
  for (const row of arrayValue(snapshot?.methodExecutionCounts)) {
    const candidate = objectValue(row);
    if (candidate?.method === method && Number.isSafeInteger(candidate.count)) {
      return Number(candidate.count);
    }
  }
  return 0;
}

function fixtureRequestCount(snapshot: ObjectValue | null, requestId: string): number | null {
  for (const row of arrayValue(snapshot?.executionCounts)) {
    const candidate = objectValue(row);
    if (candidate?.requestId === requestId && Number.isSafeInteger(candidate.count)) {
      return Number(candidate.count);
    }
  }
  return 0;
}

function gatewaySessions(snapshot: ObjectValue | null): ObjectValue[] {
  const sessions = objectValue(snapshot?.sessions);
  return sessions === null
    ? []
    : Object.values(sessions)
        .map(objectValue)
        .filter((candidate): candidate is ObjectValue => candidate !== null);
}

function bridgeInvocations(snapshot: ObjectValue | null): ObjectValue[] {
  return arrayValue(snapshot?.invocations)
    .map(objectValue)
    .filter((candidate): candidate is ObjectValue => candidate !== null);
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

const entries: Array<readonly [string, CanonicalAssertionOracle]> = [];
function define(assertionId: string, oracle: CanonicalAssertionOracle): void {
  entries.push([assertionId, safe(oracle)]);
}

define("O1-C02-MANIFEST-POINTER", (context) => {
  const response = openingResponse(context, "o1-c02.version-probe");
  const parsed = objectValue(pathValue(response, ["body", "parsed"]));
  return response?.status === 426 &&
    parsed?.min_protocol === 1 &&
    parsed.max_protocol === 1 &&
    parsed.manifest_url === "/bridge/update/manifest";
});
define("O1-C02-BOUNDED-RECONNECT", (context) => {
  const wire = records(context, "wire_event")
    .map(payload)
    .filter((candidate) => candidate?.stepId === "o1-c02.version-probe");
  const remote = remoteOutcome(context, "o1-c02.version-probe");
  return wire.length === 1 &&
    openingResponse(context, "o1-c02.version-probe")?.status === 426 &&
    (context.binding === "wss" ? remote?.opened === false : remote?.connectionIdPresent === false);
});

define("O1-C03-REVOKED-CREDENTIAL-REFUSED", (context) => {
  const response = openingResponse(context, "o1-c03.revoked-probe");
  const status = Number(response?.status);
  const gateway = latestSnapshot(context, "gateway_snapshot");
  const remote = remoteOutcome(context, "o1-c03.revoked-probe");
  return (status === 401 || status === 403) &&
    gatewaySessions(gateway).length === 0 &&
    (context.binding === "wss" ? remote?.opened === false : remote?.connectionIdPresent === false);
});

define("O1-C04-BOUNDED-MULTI-SESSION-SCAN", (context) => {
  const result = successfulResult(context, "o1-c04.bounded-discovery");
  const evidence = objectValue(result?.evidence);
  const sessions = arrayValue(result?.sessions);
  const probed = arrayValue(evidence?.probedTargets);
  const accepted = arrayValue(evidence?.acceptedTargets);
  return sessions.length === 2 &&
    accepted.length === 2 &&
    probed.length >= accepted.length &&
    probed.length <= 6 &&
    evidence?.source === "bounded_scan";
});
define("O1-C04-NO-TEMP-REGISTRY-READ", (context) => {
  const discovery = successfulResult(context, "o1-c04.bounded-discovery");
  const evidence = objectValue(discovery?.evidence);
  const bridge = latestSnapshot(context, "bridge_snapshot");
  const finalEvidence = objectValue(bridge?.discovery);
  return evidence?.tempRegistryReads === 0 &&
    evidence.filesystemLocksCreated === 0 &&
    finalEvidence?.tempRegistryReads === 0 &&
    finalEvidence.filesystemLocksCreated === 0;
});

define("O1-C06-HEARTBEAT-35S", (context) => {
  const result = successfulResult(context, "o1-c06.tick-35s");
  return result?.livenessBeforeActions === "degraded" && result.liveness === "degraded";
});
define("O1-C06-HEARTBEAT-65S", (context) => {
  const result = successfulResult(context, "o1-c06.tick-65s");
  return result?.livenessBeforeActions === "disconnected";
});
define("O1-C06-MISSING-ACK-RECONNECT", (context) => {
  const opened = successfulResult(context, "o1-c06.open");
  const awaited = stepSnapshot(context, "bridge_snapshot", "o1-c06.await-reconnect");
  const peer = objectValue(awaited?.peer);
  const transport = objectValue(awaited?.transport);
  return typeof opened?.connectionId === "string" &&
    typeof peer?.connectionId === "string" &&
    peer.connectionId !== opened.connectionId &&
    peer.runLoopError === null &&
    transport?.open === true;
});

define("O1-C07-GATEWAY-RESTART", (context) => {
  const lifecycle = records(context, "process_lifecycle")
    .filter(({ componentId }) => componentId === "gateway_stub")
    .map(payload)
    .filter((candidate) => candidate?.stepId === "o1-c07.restart-gateway");
  const phases = new Set(lifecycle.map((candidate) => candidate?.phase));
  const pids = lifecycle.map((candidate) => Number(pathValue(candidate, ["process", "pid"])))
    .filter(Number.isSafeInteger);
  return lifecycle.length === 2 &&
    lifecycle.every((candidate) => candidate?.preserveState === true) &&
    pids.length === 2 &&
    pids[0] !== pids[1] &&
    phases.has("stopped") &&
    phases.has("started");
});
define("O1-C07-SESSION-RESUME", (context) => {
  const before = stepSnapshot(context, "bridge_snapshot", "o1-c07.await-durable-uplink");
  const after = latestSnapshot(context, "bridge_snapshot");
  const beforeSessions = arrayValue(before?.sessions).map(objectValue)
    .filter((candidate): candidate is ObjectValue => candidate !== null);
  const afterSessions = arrayValue(after?.sessions).map(objectValue)
    .filter((candidate): candidate is ObjectValue => candidate !== null);
  const peerSessions = arrayValue(objectValue(after?.peer)?.sessions).map(objectValue)
    .filter((candidate): candidate is ObjectValue => candidate !== null);
  return beforeSessions.length === 1 &&
    afterSessions.length === 1 &&
    beforeSessions[0]?.rsid === afterSessions[0]?.rsid &&
    peerSessions.some((session) =>
      session.rsid === afterSessions[0]?.rsid &&
      session.phase === "registered" &&
      session.resumeAllowed === true &&
      session.dispatchAllowed === true);
});
define("O1-C07-UPLINK-RETRANSMISSION", (context) => {
  const before = stepSnapshot(context, "bridge_snapshot", "o1-c07.await-durable-uplink");
  const outbox = arrayValue(pathValue(before, ["sequences", "0", "outbox"]))
    .map(objectValue)
    .filter((candidate): candidate is ObjectValue => candidate !== null);
  const maximum = Math.max(...outbox.map((candidate) => Number(candidate.seq)));
  const gateway = latestSnapshot(context, "gateway_snapshot");
  return outbox.length >= 1 &&
    Number.isSafeInteger(maximum) &&
    gatewaySessions(gateway).some((session) =>
      Number(pathValue(session, ["sequence", "lastRxSeq"])) >= maximum);
});
define("O1-C07-DOWNLINK-RETRANSMISSION", (context) => {
  const dispatched = successfulResult(context, "o1-c07.retransmit");
  const awaited = stepSnapshot(context, "bridge_snapshot", "o1-c07.await-bridge-retransmit");
  const invocation = bridgeInvocations(awaited)[0];
  const fixture = latestSnapshot(context, "fixture_snapshot");
  const invocationId = objectValue(dispatched?.payload)?.invocation_id;
  return dispatched?.type === "invoke" &&
    Number.isSafeInteger(dispatched.seq) &&
    invocation?.invocationId === invocationId &&
    invocation.state === "completed" &&
    typeof invocationId === "string" &&
    fixtureRequestCount(fixture, invocationId) === 1;
});

define("O1-C08-TERMINAL-REPLAY", (context) => {
  const replay = invokeOutcome(context, "o1-c08.redeliver");
  return replay?.kind === "result" &&
    replay.status === "completed" &&
    replay.replayed === true &&
    replay.addinContacted === false;
});
define("O1-C08-EXECUTION-COUNT-ONE", (context) =>
  fixtureMethodCount(latestSnapshot(context, "fixture_snapshot"), "fixture_echo") === 1);

define("O1-C09-JOURNAL-INDETERMINATE", (context) => {
  const first = successfulResult(context, "o1-c09.first");
  const replay = invokeOutcome(context, "o1-c09.redeliver");
  const bridge = latestSnapshot(context, "bridge_snapshot");
  return first?.crashed === true &&
    first.point === "after_executing_before_addin_write" &&
    replay?.kind === "error" &&
    replay.faultClass === "journal_indeterminate" &&
    replay.outcome === "indeterminate" &&
    replay.verificationRequired === true &&
    replay.replayed === true &&
    bridgeInvocations(bridge).some((invocation) => invocation.state === "indeterminate");
});
define("O1-C09-ZERO-REEXECUTION", (context) =>
  fixtureMethodCount(latestSnapshot(context, "fixture_snapshot"), "send_code_to_revit") === 0 &&
  invokeOutcome(context, "o1-c09.redeliver")?.addinContacted === false);

define("O1-C10-READ-AT-MOST-ONE-REEXECUTION", (context) => {
  const first = successfulResult(context, "o1-c10.first");
  const replay = invokeOutcome(context, "o1-c10.redeliver");
  const count = fixtureMethodCount(latestSnapshot(context, "fixture_snapshot"), "fixture_echo");
  return first?.crashed === true &&
    first.point === "after_addin_response_before_terminal" &&
    count !== null && count >= 1 && count <= 2 &&
    replay !== null &&
    (replay.kind === "result" || replay.kind === "error");
});

define("O1-C11-DIGEST-MISMATCH-PROTOCOL", (context) => {
  const mismatch = invokeOutcome(context, "o1-c11.digest-mismatch");
  return mismatch?.kind === "error" &&
    mismatch.faultClass === "protocol" &&
    /binding_mismatch|digest/iu.test(String(mismatch.message)) &&
    mismatch.addinContacted === false &&
    fixtureMethodCount(latestSnapshot(context, "fixture_snapshot"), "fixture_echo") === 1;
});

define("O1-C12-SAME-RSID-WINDOW-REJECT", (context) => {
  const response = controlResponse(context, "o1-c12.same-rsid-second");
  return response?.kind === "control_error" &&
    response.code === "gateway_control_http_500" &&
    /window|in-flight/iu.test(String(response.message));
});
define("O1-C12-CROSS-RSID-PARALLEL-SUCCESS", (context) => {
  const gateway = latestSnapshot(context, "gateway_snapshot");
  const classifications = gatewaySessions(gateway).flatMap((session) =>
    Object.values(objectValue(session.terminalOutcomes) ?? {})
      .map(objectValue)
      .filter((candidate): candidate is ObjectValue => candidate !== null)
      .map((terminal) => terminal.classification));
  return gatewaySessions(gateway).length === 2 &&
    classifications.filter((classification) => classification === "result").length === 2;
});

define("O1-C13-NO-NORMAL-PREFLIGHT", (context) => {
  const before = stepSnapshot(context, "fixture_snapshot", "o1-c13.pre-invoke-fixture-snapshot");
  const after = latestSnapshot(context, "fixture_snapshot");
  return fixtureMethodCount(before, "mcp_status") === fixtureMethodCount(after, "mcp_status") &&
    fixtureMethodCount(after, "fixture_echo") === 1;
});

define("O1-C14-SIMULATED-FAILURE", (context) => {
  const gateway = latestSnapshot(context, "gateway_snapshot");
  const terminals = gatewaySessions(gateway).flatMap((session) =>
    Object.values(objectValue(session.terminalOutcomes) ?? {})
      .map(objectValue)
      .filter((candidate): candidate is ObjectValue => candidate !== null));
  return fixtureMethodCount(latestSnapshot(context, "fixture_snapshot"), "fixture_echo") === 1 &&
    terminals.some((terminal) =>
      terminal.classification === "error" &&
      pathValue(terminal, ["envelope", "payload", "fault_class"]) === "revit_timeout");
});
define("O1-C14-POST-FAILURE-MCP-STATUS", (context) => {
  const before = stepSnapshot(context, "fixture_snapshot", "o1-c14.pre-failure-fixture-snapshot");
  const after = latestSnapshot(context, "fixture_snapshot");
  const beforeCount = fixtureMethodCount(before, "mcp_status");
  const afterCount = fixtureMethodCount(after, "mcp_status");
  const observations = arrayValue(after?.observations).map(objectValue)
    .filter((candidate): candidate is ObjectValue => candidate !== null);
  const failureSequence = Math.max(...observations
    .filter((entry) => entry.method === "fixture_echo" && entry.phase === "response_sent")
    .map((entry) => Number(entry.sequence)));
  const laterStatus = observations.some((entry) =>
    entry.method === "mcp_status" &&
    entry.phase === "dispatch_started" &&
    Number(entry.sequence) > failureSequence);
  return beforeCount !== null &&
    afterCount === beforeCount + 1 &&
    Number.isSafeInteger(failureSequence) &&
    laterStatus;
});
define("O1-C14-ENRICHED-FAILURE", (context) => {
  const bridge = latestSnapshot(context, "bridge_snapshot");
  const invocation = bridgeInvocations(bridge)[0];
  const gateway = latestSnapshot(context, "gateway_snapshot");
  const errorEnvelope = gatewaySessions(gateway).flatMap((session) =>
    Object.values(objectValue(session.terminalOutcomes) ?? {}))
    .map(objectValue)
    .find((terminal) => terminal?.classification === "error");
  const message = pathValue(errorEnvelope, ["envelope", "payload", "message"]);
  return invocation?.state === "failed" &&
    pathValue(errorEnvelope, ["envelope", "payload", "fault_class"]) === "revit_timeout" &&
    typeof message === "string" &&
    /timeout/iu.test(message);
});

const expectedIds = EARLY_PRODUCTION_CASES.flatMap((caseId) =>
  canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => id));
const expectedSet = new Set(expectedIds);
const observedIds = entries.map(([assertionId]) => assertionId);
const missing = expectedIds.filter((assertionId) => !observedIds.includes(assertionId));
const unknown = observedIds.filter((assertionId) => !expectedSet.has(assertionId));
if (missing.length > 0 || unknown.length > 0 || new Set(observedIds).size !== observedIds.length) {
  throw new Error([
    "early production oracle registry does not exactly cover C02-C04/C06-C14",
    `missing: ${missing.join(", ") || "none"}`,
    `unknown: ${unknown.join(", ") || "none"}`,
  ].join("; "));
}

export const EARLY_PRODUCTION_ORACLES: CanonicalAssertionOracleRegistry = new Map(entries);
