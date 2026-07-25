import { observationObject } from "./observationQueries.js";
import {
  immutableReadonlyMap,
  type CanonicalAssertionOracle,
  type CanonicalAssertionOracleContext,
  type CanonicalAssertionOracleRegistry,
} from "./canonicalEvaluators.js";
import type { ProcessObservationRecord } from "./types.js";

const CONNECTION_CAPABILITIES = [
  "journal_v1",
  "chunked_results",
  "artifact_result_v1",
  "transport_streamable_http",
] as const;

function payload(record: ProcessObservationRecord): Record<string, unknown> {
  return observationObject(record.payload, `${record.observationId} payload`);
}

function control(
  records: readonly ProcessObservationRecord[],
  stepId: string,
): Record<string, unknown> | undefined {
  return records
    .filter(({ kind }) => kind === "control_result")
    .map(payload)
    .find((entry) => entry.stepId === stepId);
}

function latestSnapshot(
  records: readonly ProcessObservationRecord[],
  kind: ProcessObservationRecord["kind"],
): Record<string, unknown> | undefined {
  const record = records.filter((entry) => entry.kind === kind).at(-1);
  return record === undefined ? undefined : payload(record);
}

function successfulResult(
  records: readonly ProcessObservationRecord[],
  stepId: string,
): Record<string, unknown> | undefined {
  const row = control(records, stepId);
  const response = row?.response;
  if (response === null || typeof response !== "object" || Array.isArray(response)) return undefined;
  const responseObject = response as Record<string, unknown>;
  if (responseObject.kind !== "success") return undefined;
  const result = responseObject.result;
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined;
}

function hasBidirectionalWire(records: readonly ProcessObservationRecord[]): boolean {
  const wire = records.filter(({ kind }) => kind === "wire_event");
  return ["gateway_stub", "bridge_simulator"].every((componentId) =>
    wire.some((record) => {
      if (record.componentId !== componentId) return false;
      const frameValue = payload(record).frame;
      if (frameValue === null || typeof frameValue !== "object" || Array.isArray(frameValue)) return false;
      const frame = frameValue as Record<string, unknown>;
      if (frame.kind === "parent_tcp_capture_composite") {
        const gatewayValue = frame.gateway;
        if (gatewayValue === null || typeof gatewayValue !== "object" || Array.isArray(gatewayValue)) {
          return false;
        }
        return Number((gatewayValue as Record<string, unknown>).bytes) > 0;
      }
      return Number(frame.bytes) > 0;
    }));
}

function exactStringSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry) => typeof entry === "string") &&
    expected.every((entry) => value.includes(entry));
}

function openResult(context: CanonicalAssertionOracleContext): Record<string, unknown> | undefined {
  return successfulResult(context.observations, `${context.caseId.toLowerCase()}.open`);
}

function helloPayload(context: CanonicalAssertionOracleContext): Record<string, unknown> | undefined {
  const helloAckValue = openResult(context)?.helloAck;
  if (helloAckValue === null || typeof helloAckValue !== "object" || Array.isArray(helloAckValue)) {
    return undefined;
  }
  const payloadValue = (helloAckValue as Record<string, unknown>).payload;
  return payloadValue !== null && typeof payloadValue === "object" && !Array.isArray(payloadValue)
    ? payloadValue as Record<string, unknown>
    : undefined;
}

function authenticatedTransport(context: CanonicalAssertionOracleContext): boolean {
  const opened = openResult(context);
  const gateway = latestSnapshot(context.observations, "gateway_snapshot");
  const bridge = latestSnapshot(context.observations, "bridge_snapshot");
  const gatewaySessions = gateway?.sessions;
  const bridgeSessions = bridge?.sessions;
  if (
    opened === undefined ||
    gatewaySessions === null ||
    typeof gatewaySessions !== "object" ||
    Array.isArray(gatewaySessions) ||
    Object.keys(gatewaySessions as Record<string, unknown>).length !== 1 ||
    !Array.isArray(bridgeSessions) ||
    bridgeSessions.length !== 1 ||
    !hasBidirectionalWire(context.observations)
  ) {
    return false;
  }
  const bridgeTransport = bridge?.transport;
  if (bridgeTransport === null || typeof bridgeTransport !== "object" || Array.isArray(bridgeTransport)) {
    return false;
  }
  const openTrust = opened.testTlsTrust;
  const bridgeTrust = (bridgeTransport as Record<string, unknown>).testTlsTrust;
  return context.binding === "wss"
    ? openTrust !== null &&
      typeof openTrust === "object" &&
      bridgeTrust !== null &&
      typeof bridgeTrust === "object" &&
      JSON.stringify(openTrust) === JSON.stringify(bridgeTrust)
    : openTrust === null && bridgeTrust === null;
}

const authenticatedHello: CanonicalAssertionOracle = (context) =>
  authenticatedTransport(context) && helloPayload(context) !== undefined;

const versionNegotiated: CanonicalAssertionOracle = (context) =>
  authenticatedTransport(context) && helloPayload(context)?.protocol === 1;

const capabilitiesNegotiated: CanonicalAssertionOracle = (context) =>
  authenticatedTransport(context) &&
  exactStringSet(helloPayload(context)?.granted_capabilities, CONNECTION_CAPABILITIES);

const registrationAccepted: CanonicalAssertionOracle = (context) => {
  const registered = successfulResult(context.observations, "o1-c05.register");
  const gateway = latestSnapshot(context.observations, "gateway_snapshot");
  const bridge = latestSnapshot(context.observations, "bridge_snapshot");
  const gatewaySessions = gateway?.sessions;
  const bridgeSessions = bridge?.sessions;
  return registered !== undefined &&
    gatewaySessions !== null &&
    typeof gatewaySessions === "object" &&
    !Array.isArray(gatewaySessions) &&
    Object.keys(gatewaySessions as Record<string, unknown>).length === 1 &&
    Array.isArray(bridgeSessions) &&
    bridgeSessions.length === 1 &&
    authenticatedTransport(context);
};

const contextSnapshotAccepted: CanonicalAssertionOracle = (context) => {
  const poll = successfulResult(context.observations, "o1-c05.poll-context");
  const gateway = latestSnapshot(context.observations, "gateway_snapshot");
  const sessionsValue = gateway?.sessions;
  if (
    poll?.pushed !== true ||
    sessionsValue === null ||
    typeof sessionsValue !== "object" ||
    Array.isArray(sessionsValue)
  ) {
    return false;
  }
  const session = Object.values(sessionsValue as Record<string, unknown>)[0];
  if (session === null || typeof session !== "object" || Array.isArray(session)) return false;
  const documents = (session as Record<string, unknown>).documents;
  return Array.isArray(documents) && documents.some((document) =>
    document !== null &&
    typeof document === "object" &&
    !Array.isArray(document) &&
    (document as Record<string, unknown>).document_id === "conformance-document");
};

export const CORE_PRODUCTION_ORACLES: CanonicalAssertionOracleRegistry =
  immutableReadonlyMap([
    ["O1-C01-AUTHENTICATED-HELLO", authenticatedHello],
    ["O1-C01-VERSION-NEGOTIATED", versionNegotiated],
    ["O1-C01-CAPABILITIES-NEGOTIATED", capabilitiesNegotiated],
    ["O1-C05-REGISTRATION", registrationAccepted],
    ["O1-C05-CONTEXT-SNAPSHOT", contextSnapshotAccepted],
  ]);
