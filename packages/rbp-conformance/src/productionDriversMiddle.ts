import { createConnection, type Socket } from "node:net";

import type { CaseStackSupervisor } from "./caseStackSupervisor.js";
import {
  createRawHttpSseBindingDriver,
  createRawWssBindingDriver,
  type RawBindingTlsTrust,
} from "./rawBindingDrivers.js";
import { createProductionCaseDrivers } from "./productionDrivers.js";
import type {
  ParentStepDriver,
  ParentStepDriverRequest,
  ParentStepDrivers,
  RawStepOutcome,
} from "./parentStepEngine.js";
import type { JsonObject, JsonValue } from "./processHarness.js";
import type {
  ComponentId,
  ProcessObservationRecord,
} from "./types.js";

const MAX_FIXTURE_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_FIXTURE_RESPONSES = 16;
// Boundary-fault vectors must retain both the opening acknowledgement and the
// terminal protocol error under a loaded full-suite run. The raw drivers stop
// after a quiet window, so use a longer production evidence window than the
// generic interactive default.
const BOUNDARY_RESPONSE_SETTLE_MS = 1_000;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, label));
  if (!isObject(value)) throw new Error(`${label} is not a JSON value`);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, `${label}.${key}`)]),
  );
}

function success(
  result: unknown,
  observations: ProcessObservationRecord[] = [],
): RawStepOutcome {
  return {
    kind: "success",
    result: jsonValue(result, "middle driver result"),
    ...(observations.length === 0 ? {} : { observations }),
  };
}

function observation(
  request: Readonly<ParentStepDriverRequest>,
  componentId: ComponentId,
  kind: ProcessObservationRecord["kind"],
  suffix: string,
  payload: JsonObject,
): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${request.runId}:${request.caseId}:${request.binding}:${request.stepId}:${componentId}:${suffix}`,
    runId: request.runId,
    caseId: request.caseId,
    binding: request.binding,
    componentId,
    kind,
    at: new Date().toISOString(),
    payload,
  };
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function requestObject(request: Readonly<ParentStepDriverRequest>): JsonObject {
  const value = request.arguments.request;
  if (!isObject(value)) throw new Error(`${request.stepId} dispatch request must be an object`);
  return value;
}

function dispatchIdentity(request: Readonly<ParentStepDriverRequest>): {
  rsid: string;
  correlationId: string;
} {
  const dispatch = requestObject(request);
  const payload = dispatch.payload;
  if (typeof dispatch.rsid !== "string" || !isObject(payload)) {
    throw new Error(`${request.stepId} dispatch request lacks rsid/payload`);
  }
  const correlationId = request.action === "dispatch_batch"
    ? payload.batch_id
    : payload.invocation_id;
  if (typeof correlationId !== "string") {
    throw new Error(`${request.stepId} dispatch request lacks its correlation id`);
  }
  return { rsid: dispatch.rsid, correlationId };
}

async function awaitDispatchTerminal(
  supervisor: CaseStackSupervisor,
  request: Readonly<ParentStepDriverRequest>,
  dispatched: JsonValue,
): Promise<RawStepOutcome> {
  const { rsid, correlationId } = dispatchIdentity(request);
  const remaining = Math.max(1, request.deadlineAtMs - Date.now());
  const awaited = await supervisor.awaitCondition({
    source: "gateway.compact_snapshot",
    jsonPointer: `/sessions/${pointerSegment(rsid)}/terminalOutcomes/${pointerSegment(correlationId)}`,
    operator: "exists",
    timeoutMs: remaining,
  });
  return success({
    dispatched,
    rsid,
    correlationId,
    terminal: awaited.observed ?? null,
    awaitAttempts: awaited.attempts ?? null,
  });
}

function gatewaySnapshotObservation(
  request: Readonly<ParentStepDriverRequest>,
  snapshot: JsonObject,
  suffix = "compact-snapshot",
): ProcessObservationRecord {
  return observation(
    request,
    "gateway_stub",
    "gateway_snapshot",
    suffix,
    {
      ...structuredClone(snapshot),
      schemaVersion: "rbp-gateway-snapshot-observation/v1",
      sourceSchemaVersion: snapshot.schemaVersion ?? null,
      stepId: request.stepId,
      action: request.action,
    },
  );
}

function tlsTrust(value: unknown): RawBindingTlsTrust {
  if (!isObject(value) ||
    typeof value.caCertificatePath !== "string" ||
    typeof value.caCertificateSha256 !== "string" ||
    typeof value.serverCertificateSha256 !== "string") {
    throw new Error("raw WSS endpoint lacks complete test TLS trust");
  }
  return {
    caCertificatePath: value.caCertificatePath,
    caCertificateSha256: value.caCertificateSha256,
    serverCertificateSha256: value.serverCertificateSha256,
  };
}

async function rawBindingOutcome(
  supervisor: CaseStackSupervisor,
  request: Readonly<ParentStepDriverRequest>,
): Promise<RawStepOutcome> {
  const endpoint = supervisor.rawBindingEndpoint();
  if (request.binding === "wss") {
    if (typeof endpoint.wsUrl !== "string") throw new Error("raw WSS endpoint is unavailable");
    return await createRawWssBindingDriver({
      url: endpoint.wsUrl,
      deviceToken: "test-device-token",
      tlsTrust: tlsTrust(endpoint.tlsTrust),
      limits: { settleMs: BOUNDARY_RESPONSE_SETTLE_MS },
    })(request);
  }
  if (typeof endpoint.httpConnectionUrl !== "string") {
    throw new Error("raw HTTP/SSE endpoint is unavailable");
  }
  return await createRawHttpSseBindingDriver({
    connectionUrl: endpoint.httpConnectionUrl,
    deviceToken: "test-device-token",
    limits: { settleMs: BOUNDARY_RESPONSE_SETTLE_MS },
  })(request);
}

function frame(value: unknown, label: string): {
  bytes: Buffer;
  requestId: string;
} {
  const validated = jsonValue(value, label);
  if (!isObject(validated) || typeof validated.id !== "string") {
    throw new Error(`${label} must be a correlated JSON-RPC object`);
  }
  const bytes = Buffer.from(JSON.stringify(validated), "utf8");
  if (bytes.length < 1 || bytes.length > MAX_FIXTURE_FRAME_BYTES) {
    throw new Error(`${label} exceeds the fixture frame bound`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return {
    bytes: Buffer.concat([header, bytes]),
    requestId: validated.id,
  };
}

function boundedOffsets(value: unknown, length: number): number[] {
  if (!Array.isArray(value) ||
    value.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 1 || Number(entry) >= length)) {
    throw new Error("splitOffsets must contain in-frame safe integer offsets");
  }
  const offsets = value.map(Number);
  if (new Set(offsets).size !== offsets.length ||
    offsets.some((entry, index) => index > 0 && entry <= offsets[index - 1]!)) {
    throw new Error("splitOffsets must be unique and ascending");
  }
  return offsets;
}

function connectFixture(
  host: string,
  port: number,
  request: Readonly<ParentStepDriverRequest>,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const onAbort = (): void => {
      socket.destroy(
        request.signal.reason instanceof Error
          ? request.signal.reason
          : new Error(`${request.stepId} was aborted`),
      );
    };
    const timer = setTimeout(() => {
      socket.destroy(new Error(`${request.stepId} fixture exchange timed out`));
    }, Math.max(1, request.deadlineAtMs - Date.now()));
    const cleanup = (): void => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.once("connect", () => {
      cleanup();
      socket.removeAllListeners("error");
      socket.on("error", () => undefined);
      resolve(socket);
    });
  });
}

async function writeChunk(socket: Socket, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

async function fixtureExchange(
  supervisor: CaseStackSupervisor,
  request: Readonly<ParentStepDriverRequest>,
): Promise<RawStepOutcome> {
  const readiness = supervisor.readiness().fixture;
  if (
    (readiness.host !== "127.0.0.1" && readiness.host !== "::1") ||
    !Number.isSafeInteger(readiness.port)
  ) {
    throw new Error("fixture exchange requires numeric-loopback readiness");
  }
  const vector = request.arguments.vector;
  if (typeof vector !== "string" || vector.length === 0) {
    throw new Error("fixture exchange vector is required");
  }
  const encoded = request.action === "send_coalesced_fixture_frames"
    ? (() => {
        if (!Array.isArray(request.arguments.frames) ||
          request.arguments.frames.length < 2 ||
          request.arguments.frames.length > MAX_FIXTURE_RESPONSES) {
          throw new Error("coalesced fixture frames must contain 2 through 16 requests");
        }
        return request.arguments.frames.map((entry, index) =>
          frame(entry, `frames[${index}]`));
      })()
    : [frame(request.arguments.frame, "frame")];
  const wireFrames = encoded.map(({ bytes }) => bytes);
  let writes: Buffer[];
  if (request.action === "send_split_fixture_frame") {
    const offsets = boundedOffsets(request.arguments.splitOffsets, wireFrames[0]!.length);
    writes = [];
    let start = 0;
    for (const offset of offsets) {
      writes.push(wireFrames[0]!.subarray(start, offset));
      start = offset;
    }
    writes.push(wireFrames[0]!.subarray(start));
  } else if (request.action === "send_coalesced_fixture_frames") {
    writes = [Buffer.concat(wireFrames)];
  } else {
    writes = wireFrames;
  }

  const socket = await connectFixture(
    String(readiness.host),
    Number(readiness.port),
    request,
  );
  const responseIds: string[] = [];
  const responsePayloadBytes: number[] = [];
  const responseHeaderHexes: string[] = [];
  let buffered = Buffer.alloc(0);
  try {
    const responses = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${request.stepId} fixture response timed out`)),
        Math.max(1, request.deadlineAtMs - Date.now()),
      );
      socket.on("data", (chunk: Buffer) => {
        try {
          buffered = Buffer.concat([buffered, chunk]);
          while (buffered.length >= 4) {
            const payloadLength = buffered.readUInt32BE(0);
            if (payloadLength < 1 || payloadLength > MAX_FIXTURE_FRAME_BYTES) {
              throw new Error("fixture response declared an invalid payload length");
            }
            if (buffered.length < payloadLength + 4) break;
            const header = buffered.subarray(0, 4);
            const payload = buffered.subarray(4, payloadLength + 4);
            buffered = buffered.subarray(payloadLength + 4);
            const parsed = JSON.parse(payload.toString("utf8")) as unknown;
            if (!isObject(parsed) || typeof parsed.id !== "string") {
              throw new Error("fixture response is not a correlated JSON-RPC object");
            }
            responseIds.push(parsed.id);
            responsePayloadBytes.push(payloadLength);
            responseHeaderHexes.push(header.toString("hex"));
          }
          if (responseIds.length === encoded.length) {
            clearTimeout(timer);
            resolve();
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    for (const bytes of writes) await writeChunk(socket, bytes);
    await responses;
  } finally {
    socket.destroy();
  }
  const requestIds = encoded.map(({ requestId }) => requestId);
  if (responseIds.join("\u0000") !== requestIds.join("\u0000") || buffered.length !== 0) {
    throw new Error("fixture response correlation/order is not exact");
  }
  const capture: JsonObject = {
    schemaVersion: "rbp-c19-wire-event/v2",
    stepId: request.stepId,
    action: request.action,
    vector,
    direction: "parent_runner_to_addin_loopback_fixture_and_response",
    requestIds,
    payloadBytes: wireFrames.map((entry) => entry.length - 4),
    requestHeaderHexes: wireFrames.map((entry) => entry.subarray(0, 4).toString("hex")),
    writeChunkSizes: writes.map(({ length }) => length),
    responseIds,
    responsePayloadBytes,
    responseHeaderHexes,
    atMonotonicMs: performance.now(),
  };
  return success(capture, [
    observation(request, "bridge_simulator", "wire_event", `${vector}-bridge`, capture),
    observation(request, "addin_loopback_fixture", "wire_event", `${vector}-fixture`, capture),
  ]);
}

function backpressureObservation(
  supervisor: CaseStackSupervisor,
  request: Readonly<ParentStepDriverRequest>,
): RawStepOutcome {
  if (typeof request.arguments.enabled !== "boolean") {
    throw new Error("set_gateway_proxy_backpressure enabled must be boolean");
  }
  const state = supervisor.setGatewayProxyBackpressure(request.arguments.enabled);
  const capture = supervisor.wireCapture().gateway;
  const payload: JsonObject = {
    schemaVersion: "rbp-parent-proxy-backpressure/v1",
    stepId: request.stepId,
    action: request.action,
    direction: "bridge_to_gateway",
    binding: request.binding,
    enabled: state.enabled,
    activeConnections: state.activeConnections,
    capture: {
      acceptedConnections: capture.acceptedConnections,
      activeConnections: capture.activeConnections,
      clientToTargetBytes: capture.clientToTarget.bytes,
      targetToClientBytes: capture.targetToClient.bytes,
      atMonotonicMs: capture.finishedAtMonotonicMs,
    },
  };
  return success(payload, [
    observation(request, "gateway_stub", "wire_event", "proxy-backpressure-gateway", payload),
    observation(request, "bridge_simulator", "wire_event", "proxy-backpressure-bridge", payload),
  ]);
}

function gatewayArtifactByteObservation(
  supervisor: CaseStackSupervisor,
  request: Readonly<ParentStepDriverRequest>,
): RawStepOutcome {
  if (
    typeof request.arguments.rsid !== "string" ||
    typeof request.arguments.invocationId !== "string"
  ) {
    throw new Error("inspect_gateway_artifact_bytes requires rsid and invocationId");
  }
  const evidence = supervisor.inspectGatewayArtifactBytes({
    rsid: request.arguments.rsid,
    invocationId: request.arguments.invocationId,
  });
  const payload: JsonObject = {
    ...evidence,
    stepId: request.stepId,
    action: request.action,
  };
  return success(payload, [
    observation(
      request,
      "gateway_stub",
      "gateway_snapshot",
      "parent-artifact-byte-evidence",
      payload,
    ),
  ]);
}

function lastPeerClock(snapshot: JsonObject): number {
  const peer = snapshot.peer;
  if (!isObject(peer)) throw new Error("Bridge snapshot lacks peer evidence");
  const values = [peer.lastHeartbeatSentAtMs, peer.lastHeartbeatAckAtMs]
    .filter((value): value is number => Number.isSafeInteger(value));
  if (values.length === 0) throw new Error("Bridge snapshot lacks a heartbeat clock");
  return Math.max(...values);
}

export function createDriveBridgeOutboundProductionDriver(
  supervisor: CaseStackSupervisor,
  base: ParentStepDriver,
): ParentStepDriver {
  let drivenBridgeClockMs: number | null = null;
  return async (request) => {
    if (request.action !== "drive_bridge_outbound") {
      return await base(request);
    }
    if (!Number.isSafeInteger(request.arguments.advanceByMs)) {
      throw new Error("drive_bridge_outbound advanceByMs must be a safe integer");
    }
    const advanceByMs = Number(request.arguments.advanceByMs);
    if (advanceByMs < 1 || advanceByMs > 60_000) {
      throw new Error("drive_bridge_outbound advanceByMs must be from 1 through 60000");
    }
    if (drivenBridgeClockMs === null) {
      drivenBridgeClockMs = lastPeerClock(
        await supervisor.aggregateSnapshot("bridge_simulator"),
      );
    }
    drivenBridgeClockMs += advanceByMs;
    const tick = await supervisor.jsonlControl(
      "bridge_simulator",
      "tick",
      { nowMs: drivenBridgeClockMs },
      Math.max(1, request.deadlineAtMs - Date.now()),
    );
    const acknowledgement = await supervisor.awaitCondition({
      source: "bridge.snapshot_evidence",
      jsonPointer: "/peer/heartbeatAckDeadlineAtMs",
      operator: "equals",
      expected: null,
      timeoutMs: Math.max(1, request.deadlineAtMs - Date.now()),
    });
    const flushed = await supervisor.jsonlControl(
      "bridge_simulator",
      "flush_outbound",
      {},
      Math.max(1, request.deadlineAtMs - Date.now()),
    );
    const tickPeer = isObject(tick) && isObject(tick.peer) ? tick.peer : {};
    const flushPeer = isObject(flushed) && isObject(flushed.peer) ? flushed.peer : {};
    const payload: JsonObject = {
      schemaVersion: "rbp-parent-driven-outbound/v1",
      stepId: request.stepId,
      action: request.action,
      direction: "bridge_to_gateway",
      binding: request.binding,
      nowMs: drivenBridgeClockMs,
      acknowledgementAttempts: acknowledgement.attempts ?? null,
      tickLiveness: isObject(tick) ? tick.liveness ?? null : null,
      tickLivenessBeforeActions: isObject(tick)
        ? tick.livenessBeforeActions ?? null
        : null,
      bufferedAmountAfterFlush: flushPeer.bufferedAmount ?? tickPeer.bufferedAmount ?? null,
      flushed: isObject(flushed) ? flushed.flushed ?? null : null,
    };
    return success(payload, [
      observation(request, "gateway_stub", "wire_event", "driven-outbound-gateway", payload),
      observation(request, "bridge_simulator", "wire_event", "driven-outbound-bridge", payload),
    ]);
  };
}

export function createMiddleProductionCaseDrivers(
  supervisor: CaseStackSupervisor,
): ParentStepDrivers {
  const base = createProductionCaseDrivers(supervisor);
  const driveBridgeOutbound = createDriveBridgeOutboundProductionDriver(
    supervisor,
    base.parent_harness,
  );
  return {
    ...base,
    gateway_http_control: async (request) => {
      if (request.action === "snapshot") {
        const snapshot = await supervisor.compactGatewaySnapshot();
        return success(snapshot, [gatewaySnapshotObservation(request, snapshot)]);
      }
      const outcome = await base.gateway_http_control(request);
      if (
        outcome.kind !== "success" ||
        (request.action !== "dispatch_invoke" && request.action !== "dispatch_batch")
      ) {
        return outcome;
      }
      return await awaitDispatchTerminal(supervisor, request, outcome.result);
    },
    bridge_jsonl_control: base.bridge_jsonl_control,
    parent_harness: async (request) => {
      if (request.action === "set_gateway_proxy_backpressure") {
        return backpressureObservation(supervisor, request);
      }
      if (request.action === "inspect_gateway_artifact_bytes") {
        return gatewayArtifactByteObservation(supervisor, request);
      }
      if (request.action === "send_binding_frame") {
        return await rawBindingOutcome(supervisor, request);
      }
      if (
        request.action === "send_fixture_frame" ||
        request.action === "send_split_fixture_frame" ||
        request.action === "send_coalesced_fixture_frames"
      ) {
        return await fixtureExchange(supervisor, request);
      }
      if (
        request.action === "await_condition" &&
        request.arguments.source === "gateway.compact_snapshot"
      ) {
        const result = await supervisor.awaitCondition({
          source: "gateway.compact_snapshot",
          jsonPointer: String(request.arguments.jsonPointer),
          operator: String(request.arguments.operator),
          ...(request.arguments.expected === undefined
            ? {}
            : { expected: request.arguments.expected }),
          timeoutMs: Number(request.arguments.timeoutMs),
        });
        const snapshot = result.snapshot;
        return success(result, isObject(snapshot)
          ? [gatewaySnapshotObservation(request, snapshot, "await-compact")]
          : []);
      }
      return await driveBridgeOutbound(request);
    },
  };
}
