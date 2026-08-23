import { createHash } from "node:crypto";

import {
  HttpSseGatewayBinding,
  WssGatewayBinding,
  type GatewayBinding,
} from "../../bridge-simulator/dist/index.js";
import {
  createReceivedJournalRecord,
  dataEnvelopeImmutableDigest,
  RBP_MAX_DECODED_CHUNK_BYTES,
  RBP_MAX_INLINE_RESULT_BYTES,
  RBP_MAX_INVOCATION_PARAMS_BYTES,
  type DataEnvelopeSnapshot,
  type HelloEnvelope,
  type RbpEnvelope,
  type SessionRegisteredEnvelope,
} from "@revagent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type DeviceAuthContext,
  type IdentityPort,
} from "./authContext.js";
import {
  GatewayBridgeSessionAuthority,
  GatewayRbpFault,
  type BridgeConnectionChannel,
} from "./bridgeSession.js";
import type {
  GatewayExecutorRequest,
  GatewayJsonObject,
} from "./dispatch.js";
import { gatewayUuidV7 } from "./identifiers.js";
import type { GatewayRecoveryPendingDispatch } from "./recoveryAuthority.js";
import {
  RBP_OPENING_REFUSAL_OBSERVER_CONTRACT,
  RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
  createProductionRbpIngressHost,
  type RbpOpeningRefusalObservation,
  type RbpWssInternalDiagnostic,
} from "./rbpIngress.js";
import {
  createFailClosedPorts,
  startGatewayServer,
  type GatewayServerHandle,
} from "./server.js";
import { createRestartableTestStore } from "./testAdapters.js";
import type { GatewayConfig } from "./config.js";
import { E5_TOOL_BINDINGS } from "./toolBindings.js";

let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);

function hello(options: { readonly deviceId?: string } = {}): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["transport_streamable_http", "partial_progress"],
      bridge_version: "gw12-test",
      device_id: options.deviceId ?? "device-gw12",
      machine: { hostname: "gw12-test", os: "windows" },
      addin_versions: ["gw12-test"],
    },
  };
}

function registration(): Extract<RbpEnvelope, { type: "session_register" }> {
  return {
    v: 1,
    type: "session_register",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      local_session_key: "local-gw12",
      user_hint: { name: "fixture" },
      machine: {
        hostname: "gw12-test",
        fingerprint: `sha256:${"2".repeat(64)}`,
      },
      revit: { version: "2025", build: "fixture", pid: 1234 },
      addin_version: "gw12-test",
      result_contract_version: 1,
      session_capabilities: ["transport_streamable_http", "partial_progress"],
      bridge_version: "gw12-test",
      documents: [],
      port: 48884,
    },
  };
}

function identity(
  grantedSessionCapabilities: readonly string[] = [
    "transport_streamable_http",
    "partial_progress",
  ],
  options: {
    readonly deviceToken?: string;
    readonly deviceId?: string;
    readonly tenantId?: string;
    readonly deviceStatus?: DeviceAuthContext["deviceStatus"];
    readonly beforeDeviceResult?: () => Promise<void>;
  } = {},
): IdentityPort {
  const deviceToken = options.deviceToken ?? "device-token";
  const deviceId = options.deviceId ?? "device-gw12";
  const tokenDigest = `sha256:${createHash("sha256").update(deviceToken).digest("hex")}` as const;
  return {
    kind: "fake" as const,
    async authenticateNorthRequest() {
      return {
        ok: false as const,
        port: "identity" as const,
        code: "not_configured" as const,
        message: "north identity is outside this fixture",
      };
    },
    async authenticateDevice(input) {
      await options.beforeDeviceResult?.();
      if (input.deviceToken !== deviceToken) {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "unknown device token",
        };
      }
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: {
          type: "device",
          tenantId: options.tenantId ?? "tenant-gw12",
          userId: "user-gw12",
          deviceId,
          seatId: "seat-gw12",
        },
        connectionId: input.connectionId,
        deviceStatus: options.deviceStatus ?? "active",
        grantedSessionCapabilities,
        deviceTokenDigest: tokenDigest,
      };
      return { ok: true as const, value: context };
    },
  };
}

function request(
  rsid: string,
  options: {
    readonly method?: string;
    readonly toolName?: string;
    readonly mutating?: boolean;
  } = {},
): GatewayExecutorRequest {
  const args: GatewayJsonObject = { probe: "gw12" };
  const invocationId = id();
  const method = options.method ?? "get_revit_mcp_status";
  const toolName = options.toolName ?? "core.get_revit_status";
  const mutating = options.mutating ?? false;
  return {
    toolName,
    toolVersion: "1.0.0",
    executorMethod: method,
    policyClass: "auto",
    mutationScopePolicy: mutating ? "session" : "none",
    args,
    context: {
      invocationId,
      idempotencyKey: `${rsid}/${invocationId}`,
      principalKey: "tenant-gw12:user-gw12",
      actor: { tenantId: "tenant-gw12", userId: "user-gw12", role: "user" },
      gatewaySessionId: "gateway-session-gw12",
      oauthClientId: "oauth-client-gw12",
      mcpSessionId: "mcp-session-gw12",
      rsid,
      toolName,
      toolVersion: "1.0.0",
      policyClass: "auto",
      policyDecision: "auto",
      confirmationId: null,
      originatingPreviewInvocationId: null,
      mutationScopePolicy: mutating ? "session" : "none",
      mutating,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: "doc-gw12" },
      paramsDigest: `sha256:${"1".repeat(64)}`,
      mutationScope: mutating ? { kind: "session" } : null,
      startedAtMs: Date.now(),
    },
  };
}

function terminal(
  rsid: string,
  invocationId: string,
  seq: number,
  ack: number,
): Extract<RbpEnvelope, { type: "result" }> {
  return {
    v: 1,
    type: "result",
    id: id(),
    rsid,
    seq,
    ack,
    ts: new Date().toISOString(),
    payload: {
      kind: "invocation",
      invocation_id: invocationId,
      status: "completed",
      result: { success: true, source: "gw12-fixture" },
      metrics: {
        execute_ms: 1,
        request_bytes: 1,
        response_bytes: 1,
        framing: "length-prefixed",
      },
    },
  };
}

async function next(binding: GatewayBinding): Promise<RbpEnvelope> {
  const result = await binding.messages()[Symbol.asyncIterator]().next();
  if (result.done) throw new Error("binding closed before the expected frame");
  return result.value;
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolved) => {
    resolve = resolved;
  });
  return { promise, resolve };
}

function captureNextServerSocket(): Deferred<WebSocket> {
  const accepted = deferred<WebSocket>();
  const original = WebSocketServer.prototype.handleUpgrade;
  vi.spyOn(WebSocketServer.prototype, "handleUpgrade").mockImplementation(function (
    this: WebSocketServer,
    request,
    socket,
    head,
    callback,
  ): void {
    original.call(this, request, socket, head, (websocket, upgradedRequest) => {
      accepted.resolve(websocket);
      callback(websocket, upgradedRequest);
    });
  });
  return accepted;
}

interface RawWssClient {
  readonly socket: WebSocket;
  readonly messages: RbpEnvelope[];
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
}

async function openRawWss(
  port: number,
  deviceToken = "device-token",
): Promise<RawWssClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/bridge/v1`, {
    headers: {
      Authorization: `Bearer ${deviceToken}`,
      "X-RBP-Versions": "1",
    },
  });
  const messages: RbpEnvelope[] = [];
  socket.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()) as RbpEnvelope);
  });
  const closed = new Promise<{ readonly code: number; readonly reason: string }>(
    (resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
  socket.on("error", () => {
    // The server-side survival tests deliberately fault transports.
  });
  return { socket, messages, closed };
}

const LOCAL_WSS_FRAME_BUDGET_BYTES =
  64 * 1024 +
  Math.max(
    RBP_MAX_INVOCATION_PARAMS_BYTES,
    4 * Math.ceil(RBP_MAX_DECODED_CHUNK_BYTES / 3),
    RBP_MAX_INLINE_RESULT_BYTES,
  );

function jsonObjectWithExactBytes(byteSize: number): string {
  const prefix = '{"payload":"';
  const suffix = '"}';
  const fixedBytes = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
  if (byteSize < fixedBytes) throw new RangeError("byteSize is smaller than JSON framing");
  const serialized = `${prefix}${"x".repeat(byteSize - fixedBytes)}${suffix}`;
  if (Buffer.byteLength(serialized) !== byteSize) {
    throw new Error("exact JSON byte fixture drifted");
  }
  return serialized;
}

function assertCanaryAbsentFromRemote(
  client: RawWssClient,
  closed: { readonly code: number; readonly reason: string },
  canary: string,
): void {
  expect(JSON.stringify(client.messages)).not.toContain(canary);
  expect(closed.reason).not.toContain(canary);
}

function holdWebSocketSendCallbacks(socket: WebSocket): {
  readonly callbacks: Array<(error?: Error) => void>;
  readonly restore: () => void;
} {
  const callbacks: Array<(error?: Error) => void> = [];
  const heldSend = ((
    _data: unknown,
    optionsOrCallback?: unknown,
    callback?: unknown,
  ): void => {
    const completion =
      typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
    if (typeof completion === "function") {
      callbacks.push(completion as (error?: Error) => void);
    }
  }) as typeof socket.send;
  const spy = vi.spyOn(socket, "send").mockImplementation(heldSend);
  return { callbacks, restore: () => spy.mockRestore() };
}

const config: GatewayConfig = {
  nodeEnv: "development",
  logLevel: "fatal",
  http: { bindHost: "127.0.0.1", port: 0 },
  publicUrl: "http://127.0.0.1",
  objectStore: { driver: "fs", root: null },
  credentialsPresent: { databaseUrl: true },
  ingress: { northMcpMountPath: "/mcp", rbpMountPrefix: "/bridge/v1" },
};

const SYNTHETIC_REFUSAL_CANARIES = Object.freeze({
  token: "SYNTHETIC-NORTH-BEARER-MUST-NOT-APPEAR",
  device: "SYNTHETIC-DEVICE-MUST-NOT-APPEAR",
  hostname: "SYNTHETIC-HOSTNAME-MUST-NOT-APPEAR",
  endpoint: "SYNTHETIC-ENDPOINT-MUST-NOT-APPEAR",
  header: "SYNTHETIC-HEADER-MUST-NOT-APPEAR",
  message: "SYNTHETIC-MESSAGE-MUST-NOT-APPEAR",
  error: "SYNTHETIC-ERROR-MUST-NOT-APPEAR",
});

function revokedHello(): HelloEnvelope {
  const envelope = hello();
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      bridge_version: SYNTHETIC_REFUSAL_CANARIES.endpoint,
      device_id: SYNTHETIC_REFUSAL_CANARIES.device,
      machine: {
        hostname: SYNTHETIC_REFUSAL_CANARIES.hostname,
        os: SYNTHETIC_REFUSAL_CANARIES.header,
      },
      addin_versions: [
        SYNTHETIC_REFUSAL_CANARIES.message,
        SYNTHETIC_REFUSAL_CANARIES.error,
      ],
    },
  };
}

function expectedOpeningRefusal(
  correlationId: string,
  binding: RbpOpeningRefusalObservation["binding"],
): RbpOpeningRefusalObservation {
  return {
    contractVersion: RBP_OPENING_REFUSAL_OBSERVER_CONTRACT,
    event: "gateway.rbp_opening_refused",
    correlationId,
    binding,
    faultClass: "auth",
    httpStatus: 403,
    closeCode: 4403,
    decision: "refused",
  };
}

function assertValueFreeObservation(observation: RbpOpeningRefusalObservation): void {
  expect(Object.isFrozen(observation)).toBe(true);
  expect(Object.keys(observation)).toStrictEqual([
    "contractVersion",
    "event",
    "correlationId",
    "binding",
    "faultClass",
    "httpStatus",
    "closeCode",
    "decision",
  ]);
  const serialized = JSON.stringify(observation);
  for (const canary of Object.values(SYNTHETIC_REFUSAL_CANARIES)) {
    expect(serialized).not.toContain(canary);
  }
  expect(serialized).not.toContain("token");
  expect(serialized).not.toContain("message");
  expect(serialized).not.toContain("error");
  expect(serialized).not.toContain("endpoint");
  expect(serialized).not.toContain("device");
  expect(serialized).not.toContain("header");
}

describe("GW-12 production RBP ingress", () => {
  const handles: GatewayServerHandle[] = [];
  const bindings: GatewayBinding[] = [];

  afterEach(async () => {
    await Promise.allSettled(bindings.splice(0).map(async (binding) => binding.close()));
    await Promise.allSettled(handles.splice(0).map(async (handle) => handle.close()));
    vi.restoreAllMocks();
  });

  it("emits one value-free correlated observer record for a revoked HTTP opening", async () => {
    const restartable = createRestartableTestStore();
    const revokedIdentity = identity(
      ["transport_streamable_http", "partial_progress"],
      {
        deviceToken: SYNTHETIC_REFUSAL_CANARIES.token,
        deviceId: SYNTHETIC_REFUSAL_CANARIES.device,
        deviceStatus: "revoked",
      },
    );
    const authority = new GatewayBridgeSessionAuthority(restartable.store, revokedIdentity);
    const observations: RbpOpeningRefusalObservation[] = [];
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: revokedIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onOpeningRefusalObservation: (observation) => observations.push(observation),
        }),
      },
    });
    handles.push(server);
    const opening = revokedHello();

    const response = await fetch(
      `http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SYNTHETIC_REFUSAL_CANARIES.token}`,
          "Content-Type": "application/json",
          "X-RBP-Versions": "1",
          "X-Synthetic-Observer-Canary": SYNTHETIC_REFUSAL_CANARIES.header,
        },
        body: JSON.stringify(opening),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ fault_class: "auth" });
    expect(observations).toStrictEqual([
      expectedOpeningRefusal(opening.id, "http_sse"),
    ]);
    assertValueFreeObservation(observations[0]!);
  });

  it("emits one value-free correlated observer record for a revoked WSS opening", async () => {
    const restartable = createRestartableTestStore();
    const revokedIdentity = identity(
      ["transport_streamable_http", "partial_progress"],
      {
        deviceToken: SYNTHETIC_REFUSAL_CANARIES.token,
        deviceId: SYNTHETIC_REFUSAL_CANARIES.device,
        deviceStatus: "revoked",
      },
    );
    const authority = new GatewayBridgeSessionAuthority(restartable.store, revokedIdentity);
    const observations: RbpOpeningRefusalObservation[] = [];
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: revokedIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onOpeningRefusalObservation: (observation) => observations.push(observation),
        }),
      },
    });
    handles.push(server);
    const opening = revokedHello();
    const binding = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${String(server.port)}/bridge/v1`,
      deviceToken: SYNTHETIC_REFUSAL_CANARIES.token,
      endpointPolicy: "loopback_test_readiness",
    });
    bindings.push(binding);

    await expect(binding.open(opening)).rejects.toMatchObject({
      faultClass: "auth",
      closeCode: 4403,
    });
    expect(binding.closeInfo).toMatchObject({ code: 4403 });
    expect(observations).toStrictEqual([expectedOpeningRefusal(opening.id, "wss")]);
    assertValueFreeObservation(observations[0]!);
  });

  it("rejects queued frames after the first hello refusal and isolates observer failure", async () => {
    const restartable = createRestartableTestStore();
    let authenticateDeviceCalls = 0;
    const authenticationStarted = deferred();
    const releaseAuthentication = deferred();
    const revokedIdentity = identity(
      ["transport_streamable_http", "partial_progress"],
      {
        deviceToken: SYNTHETIC_REFUSAL_CANARIES.token,
        deviceId: SYNTHETIC_REFUSAL_CANARIES.device,
        deviceStatus: "revoked",
        beforeDeviceResult: async () => {
          authenticateDeviceCalls += 1;
          authenticationStarted.resolve();
          await releaseAuthentication.promise;
        },
      },
    );
    const authority = new GatewayBridgeSessionAuthority(restartable.store, revokedIdentity);
    const receive = vi.spyOn(authority, "receive");
    const opening = revokedHello();
    let observationCount = 0;
    const serializedObservations: string[] = [];
    let releaseObservationFailures!: () => void;
    const observationFailures = new Promise<void>((resolve) => {
      releaseObservationFailures = resolve;
    });
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: revokedIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          writeOpeningRefusalLog: async (serializedObservation) => {
            serializedObservations.push(serializedObservation);
            await observationFailures;
            throw new Error(SYNTHETIC_REFUSAL_CANARIES.message);
          },
          onOpeningRefusalObservation: async () => {
            observationCount += 1;
            await observationFailures;
            throw new Error(SYNTHETIC_REFUSAL_CANARIES.error);
          },
        }),
      },
    });
    handles.push(server);
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(server.port)}/bridge/v1`,
      {
        headers: {
          Authorization: `Bearer ${SYNTHETIC_REFUSAL_CANARIES.token}`,
          "X-RBP-Versions": "1",
        },
      },
    );
    const closed = new Promise<{ readonly code: number; readonly reason: string }>(
      (resolve, reject) => {
        socket.once("error", reject);
        socket.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString("utf8") });
        });
      },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    try {
      socket.send(JSON.stringify(opening));
      socket.send(JSON.stringify(registration()));
      await authenticationStarted.promise;
      releaseAuthentication.resolve();

      await expect(closed).resolves.toMatchObject({ code: 4403 });
      expect(authenticateDeviceCalls).toBe(1);
      expect(receive).not.toHaveBeenCalled();
      expect(observationCount).toBe(1);
      expect(serializedObservations).toHaveLength(1);
      expect(JSON.parse(serializedObservations[0]!)).toStrictEqual(
        expectedOpeningRefusal(opening.id, "wss"),
      );
      expect(serializedObservations[0]).not.toContain("hostname");
    } finally {
      releaseAuthentication.resolve();
      releaseObservationFailures();
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  });

  it("validates the frozen WSS queue configuration bounds", () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());

    for (const queuedFrames of [0, 257, 1.5]) {
      expect(() =>
        createProductionRbpIngressHost({ authority, wssQueue: { queuedFrames } }),
      ).toThrow("wssQueue.queuedFrames");
    }
    for (const queuedBytes of [
      LOCAL_WSS_FRAME_BUDGET_BYTES - 1,
      2 * LOCAL_WSS_FRAME_BUDGET_BYTES + 1,
    ]) {
      expect(() =>
        createProductionRbpIngressHost({ authority, wssQueue: { queuedBytes } }),
      ).toThrow("wssQueue.queuedBytes");
    }
    expect(() =>
      createProductionRbpIngressHost({
        authority,
        wssQueue: {
          queuedFrames: 1,
          queuedBytes: LOCAL_WSS_FRAME_BUDGET_BYTES,
        },
      }),
    ).not.toThrow();
    expect(() =>
      createProductionRbpIngressHost({
        authority,
        wssQueue: {
          queuedFrames: 256,
          queuedBytes: 2 * LOCAL_WSS_FRAME_BUDGET_BYTES,
        },
      }),
    ).not.toThrow();
    expect(() =>
      createProductionRbpIngressHost({
        authority,
        wssEgress: {
          queuedFrames: 0,
          queuedBytes: 0,
          sendCompletionTimeoutMs: 0,
        },
      }),
    ).not.toThrow();
    expect(() =>
      createProductionRbpIngressHost({
        authority,
        wssEgress: {
          queuedFrames: 1_000,
          queuedBytes: 10 * LOCAL_WSS_FRAME_BUDGET_BYTES,
          sendCompletionTimeoutMs: 1_000_000,
        },
      }),
    ).not.toThrow();
    for (const wssEgress of [
      { queuedFrames: 1.5 },
      { queuedBytes: 1.5 },
      { sendCompletionTimeoutMs: 1.5 },
    ]) {
      expect(() => createProductionRbpIngressHost({ authority, wssEgress })).toThrow(
        "must be a safe integer",
      );
    }
  });

  it("serializes two valid hello arrivals into one authenticate/open claim", async () => {
    const restartable = createRestartableTestStore();
    let authenticateDeviceCalls = 0;
    const authenticationStarted = deferred();
    const releaseAuthentication = deferred();
    const delayedIdentity = identity(undefined, {
      beforeDeviceResult: async () => {
        authenticateDeviceCalls += 1;
        authenticationStarted.resolve();
        await releaseAuthentication.promise;
      },
    });
    const authority = new GatewayBridgeSessionAuthority(restartable.store, delayedIdentity);
    const openConnection = vi.spyOn(authority, "openConnection");
    const detach = vi.spyOn(authority, "detach");
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: delayedIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssQueue: { queuedFrames: 2 },
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    let arrivals = 0;
    const bothArrived = deferred();
    serverSocket.on("message", () => {
      arrivals += 1;
      if (arrivals === 2) bothArrived.resolve();
    });

    try {
      client.socket.send(JSON.stringify(hello()));
      client.socket.send(JSON.stringify(hello()));
      await Promise.all([authenticationStarted.promise, bothArrived.promise]);
      releaseAuthentication.resolve();

      await expect(client.closed).resolves.toMatchObject({ code: 4400 });
      expect(authenticateDeviceCalls).toBe(1);
      expect(openConnection).toHaveBeenCalledTimes(1);
      expect(detach).toHaveBeenCalledTimes(1);
      expect(client.messages.filter((message) => message.type === "hello_ack")).toHaveLength(1);
    } finally {
      releaseAuthentication.resolve();
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
    }
  });

  it("preserves hello-ack before an already-arrived registration", async () => {
    const restartable = createRestartableTestStore();
    const authenticationStarted = deferred();
    const releaseAuthentication = deferred();
    const delayedIdentity = identity(undefined, {
      beforeDeviceResult: async () => {
        authenticationStarted.resolve();
        await releaseAuthentication.promise;
      },
    });
    const authority = new GatewayBridgeSessionAuthority(restartable.store, delayedIdentity);
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: delayedIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    let arrivals = 0;
    const bothArrived = deferred();
    serverSocket.on("message", () => {
      arrivals += 1;
      if (arrivals === 2) bothArrived.resolve();
    });

    try {
      client.socket.send(JSON.stringify(hello()));
      client.socket.send(JSON.stringify(registration()));
      await Promise.all([authenticationStarted.promise, bothArrived.promise]);
      releaseAuthentication.resolve();
      await vi.waitFor(() => {
        expect(client.messages.map((message) => message.type)).toStrictEqual([
          "hello_ack",
          "session_registered",
        ]);
      });
      client.socket.close(1000, "test complete");
      await client.closed;
    } finally {
      releaseAuthentication.resolve();
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
    }
  });

  it("rejects the queued-frame bound plus one with 1013", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const openConnection = vi.spyOn(authority, "openConnection");
    const receive = vi.spyOn(authority, "receive");
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssQueue: { queuedFrames: 2 },
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    let arrivals = 0;
    const threeArrived = deferred();
    serverSocket.on("message", () => {
      arrivals += 1;
      if (arrivals === 3) threeArrived.resolve();
    });

    try {
      client.socket.send(JSON.stringify(hello()));
      client.socket.send("{}");
      client.socket.send("{}");
      await vi.waitFor(() => expect(arrivals).toBe(3));
      await threeArrived.promise;

      await expect(client.closed).resolves.toMatchObject({ code: 1013 });
      expect(receive).not.toHaveBeenCalled();
      expect(openConnection.mock.calls.length).toBeLessThanOrEqual(1);
      expect(client.messages).toHaveLength(0);
    } finally {
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
    }
  });

  it.each([
    { delta: 0, expectedCode: 4400, label: "exact bound" },
    { delta: 1, expectedCode: 1013, label: "bound plus one" },
  ])("enforces the raw queued-byte $label", async ({ delta, expectedCode }) => {
    const restartable = createRestartableTestStore();
    const authenticationStarted = deferred();
    const releaseAuthentication = deferred();
    const delayedIdentity = identity(undefined, {
      beforeDeviceResult: async () => {
        authenticationStarted.resolve();
        await releaseAuthentication.promise;
      },
    });
    const authority = new GatewayBridgeSessionAuthority(restartable.store, delayedIdentity);
    const detach = vi.spyOn(authority, "detach");
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: delayedIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssQueue: {
            queuedFrames: 2,
            queuedBytes: LOCAL_WSS_FRAME_BUDGET_BYTES,
          },
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    let arrivals = 0;
    const bothArrived = deferred();
    serverSocket.on("message", () => {
      arrivals += 1;
      if (arrivals === 2) bothArrived.resolve();
    });
    const serializedHello = JSON.stringify(hello());
    const secondFrameBytes =
      LOCAL_WSS_FRAME_BUDGET_BYTES - Buffer.byteLength(serializedHello) + delta;

    try {
      client.socket.send(serializedHello);
      client.socket.send(Buffer.alloc(secondFrameBytes, 0x20), { binary: false });
      await Promise.all([authenticationStarted.promise, bothArrived.promise]);
      releaseAuthentication.resolve();

      await expect(client.closed).resolves.toMatchObject({ code: expectedCode });
      expect(detach).toHaveBeenCalledTimes(1);
      expect(client.messages.filter((message) => message.type === "hello_ack")).toHaveLength(
        delta === 0 ? 1 : 0,
      );
    } finally {
      releaseAuthentication.resolve();
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
    }
  });

  it("pauses at the 75 percent byte watermark and resumes only below 50 percent", async () => {
    const pause = vi.spyOn(WebSocket.prototype, "pause");
    const resume = vi.spyOn(WebSocket.prototype, "resume");
    const restartable = createRestartableTestStore();
    const authenticationStarted = deferred();
    const releaseAuthentication = deferred();
    const delayedIdentity = identity(undefined, {
      beforeDeviceResult: async () => {
        authenticationStarted.resolve();
        await releaseAuthentication.promise;
      },
    });
    const authority = new GatewayBridgeSessionAuthority(restartable.store, delayedIdentity);
    const receive = vi.spyOn(authority, "receive").mockResolvedValue(undefined);
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: delayedIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssQueue: { queuedBytes: LOCAL_WSS_FRAME_BUDGET_BYTES },
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    let arrivals = 0;
    const bothArrived = deferred();
    serverSocket.on("message", () => {
      arrivals += 1;
      if (arrivals === 2) bothArrived.resolve();
    });
    const largeResult = terminal(id(), id(), 1, 0);
    largeResult.payload.result = "x".repeat(
      Math.ceil(LOCAL_WSS_FRAME_BUDGET_BYTES * 0.76),
    );

    try {
      client.socket.send(JSON.stringify(hello()));
      client.socket.send(JSON.stringify(largeResult));
      await Promise.all([authenticationStarted.promise, bothArrived.promise]);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(resume).not.toHaveBeenCalled();
      releaseAuthentication.resolve();

      await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
      client.socket.close(1000, "test complete");
      await client.closed;
    } finally {
      releaseAuthentication.resolve();
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
    }
  });

  it("allows a 4 MiB current frame at exact backlog and blocks only over backlog", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    let channel!: BridgeConnectionChannel;
    const originalOpen = authority.openConnection.bind(authority);
    vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
      channel = input.channel;
      return originalOpen(input);
    });
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    const backlog = vi
      .spyOn(serverSocket, "bufferedAmount", "get")
      .mockReturnValue(1024 * 1024);
    const transportSend = vi.spyOn(serverSocket, "send");
    const fourMiBFrame = jsonObjectWithExactBytes(4 * 1024 * 1024);

    await expect(channel.send(fourMiBFrame)).resolves.toBeUndefined();
    expect(transportSend).toHaveBeenCalledTimes(1);
    backlog.mockReturnValue(1024 * 1024 + 1);
    await expect(channel.send(JSON.stringify({ blocked: true }))).rejects.toThrow(
      "backlog exceeds",
    );
    expect(transportSend).toHaveBeenCalledTimes(1);
    backlog.mockRestore();
    client.socket.close(1000, "test complete");
    await client.closed;
  });

  it("bounds concurrent application egress frames and releases accounting after settle", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    let channel!: BridgeConnectionChannel;
    const originalOpen = authority.openConnection.bind(authority);
    vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
      channel = input.channel;
      return originalOpen(input);
    });
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssEgress: { queuedFrames: 2, sendCompletionTimeoutMs: 100 },
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    const held = holdWebSocketSendCallbacks(serverSocket);

    const runExactWave = async (wave: number): Promise<void> => {
      const first = channel.send(JSON.stringify({ wave, frame: 1 }));
      const second = channel.send(JSON.stringify({ wave, frame: 2 }));
      await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
      held.callbacks.shift()!();
      await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
      held.callbacks.shift()!();
      await expect(Promise.all([first, second])).resolves.toStrictEqual([
        undefined,
        undefined,
      ]);
    };
    await runExactWave(1);
    await runExactWave(2);

    const first = channel.send(JSON.stringify({ overload: 1 }));
    const second = channel.send(JSON.stringify({ overload: 2 }));
    const acceptedOutcomes = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
    await expect(channel.send(JSON.stringify({ overload: 3 }))).rejects.toThrow(
      "application egress queue overloaded",
    );
    expect(held.callbacks).toHaveLength(1);
    held.callbacks.shift()!();
    await acceptedOutcomes;
    const closed = await client.closed;
    expect(closed).toMatchObject({ code: 1013, reason: "RBP application egress overloaded" });
    expect(held.callbacks).toHaveLength(0);
    held.restore();
  });

  it("bounds concurrent application egress bytes at exact F and rejects plus one", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    let channel!: BridgeConnectionChannel;
    const originalOpen = authority.openConnection.bind(authority);
    vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
      channel = input.channel;
      return originalOpen(input);
    });
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssEgress: {
            queuedFrames: 4,
            queuedBytes: LOCAL_WSS_FRAME_BUDGET_BYTES,
            sendCompletionTimeoutMs: 100,
          },
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    const held = holdWebSocketSendCallbacks(serverSocket);
    const firstFrame = jsonObjectWithExactBytes(
      Math.floor(LOCAL_WSS_FRAME_BUDGET_BYTES / 2),
    );
    const secondFrame = jsonObjectWithExactBytes(
      LOCAL_WSS_FRAME_BUDGET_BYTES - Buffer.byteLength(firstFrame),
    );

    const runExactWave = async (): Promise<void> => {
      const first = channel.send(firstFrame);
      const second = channel.send(secondFrame);
      await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
      held.callbacks.shift()!();
      await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
      held.callbacks.shift()!();
      await expect(Promise.all([first, second])).resolves.toStrictEqual([
        undefined,
        undefined,
      ]);
    };
    await runExactWave();
    await runExactWave();

    const first = channel.send(firstFrame);
    const second = channel.send(secondFrame);
    const acceptedOutcomes = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
    await expect(channel.send("x")).rejects.toThrow("application egress queue overloaded");
    expect(held.callbacks).toHaveLength(1);
    held.callbacks.shift()!();
    await acceptedOutcomes;
    const closed = await client.closed;
    expect(closed).toMatchObject({ code: 1013, reason: "RBP application egress overloaded" });
    expect(held.callbacks).toHaveLength(0);
    held.restore();
  });

  it("times out a stuck normal send, terminates, detaches once, and ignores its late callback", async () => {
    const timeoutMs = 25;
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    let channel!: BridgeConnectionChannel;
    const originalOpen = authority.openConnection.bind(authority);
    vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
      channel = input.channel;
      return originalOpen(input);
    });
    const detach = vi.spyOn(authority, "detach");
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssEgress: { sendCompletionTimeoutMs: timeoutMs },
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    const terminate = vi.spyOn(serverSocket, "terminate");
    const held = holdWebSocketSendCallbacks(serverSocket);
    const stuck = channel.send(JSON.stringify({ stuck: true }));
    const stuckOutcome = expect(stuck).rejects.toThrow("send cancelled for teardown");
    await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
    const lateCallback = held.callbacks[0]!;
    const startedAt = Date.now();
    client.socket.send('{"v":1,"type":"session_register","id":"malformed"');

    const closed = await client.closed;
    await stuckOutcome;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(closed.code).toBe(1006);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(client.messages.map((message) => message.type)).toStrictEqual(["hello_ack"]);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.detail.includes("send completion timed out"),
      ),
    ).toBe(true);

    lateCallback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(client.messages.map((message) => message.type)).toStrictEqual(["hello_ack"]);
    held.restore();
  });

  it("preempts a stuck hello-ack send before serial cleanup on socket error", async () => {
    const timeoutMs = 50;
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const detach = vi.spyOn(authority, "detach");
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssEgress: { sendCompletionTimeoutMs: timeoutMs },
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    const close = vi.spyOn(serverSocket, "close");
    const terminate = vi.spyOn(serverSocket, "terminate");
    const held = holdWebSocketSendCallbacks(serverSocket);

    try {
      client.socket.send(JSON.stringify(hello()));
      await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
      const lateCallback = held.callbacks[0]!;
      const startedAt = Date.now();
      serverSocket.emit("error", new Error("synthetic hello-ack transport error"));

      const closed = await client.closed;
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(closed).toMatchObject({ code: 1011, reason: "RBP internal error" });
      expect(close.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(terminate).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledTimes(1);
      expect(client.messages).toHaveLength(0);
      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.detail.includes("egress accounting released frames=0 bytes=0"),
        ),
      ).toBe(true);
      expect(unhandled).toStrictEqual([]);
      const closeCallsAtTerminal = close.mock.calls.length;

      lateCallback();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).toHaveBeenCalledTimes(closeCallsAtTerminal);
      expect(terminate).not.toHaveBeenCalled();
      expect(detach).toHaveBeenCalledTimes(1);
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      held.restore();
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
    }
  });

  it("watchdogs a stuck heartbeat-ack serial tail on socket close and ignores late completion", async () => {
    const timeoutMs = 30;
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const stubbornTail = deferred();
    const receiveSettled = deferred();
    const originalReceive = authority.receive.bind(authority);
    vi.spyOn(authority, "receive").mockImplementation(async (...args) => {
      try {
        await originalReceive(...args);
      } catch {
        await stubbornTail.promise;
      } finally {
        receiveSettled.resolve();
      }
    });
    const detach = vi.spyOn(authority, "detach");
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          wssEgress: { sendCompletionTimeoutMs: timeoutMs },
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    const close = vi.spyOn(serverSocket, "close");
    const terminate = vi.spyOn(serverSocket, "terminate");
    const held = holdWebSocketSendCallbacks(serverSocket);

    try {
      client.socket.send(
        JSON.stringify({
          v: 1,
          type: "heartbeat",
          id: id(),
          ts: new Date().toISOString(),
          payload: { bridge_version: "gw12-test", acks: [], sessions: [] },
        } satisfies RbpEnvelope),
      );
      await vi.waitFor(() => expect(held.callbacks).toHaveLength(1));
      const lateCallback = held.callbacks[0]!;
      const startedAt = Date.now();
      serverSocket.emit("close", 1000, Buffer.from("synthetic close"));

      const closed = await client.closed;
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(closed.code).toBe(1006);
      expect(close).not.toHaveBeenCalled();
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(detach).toHaveBeenCalledTimes(1);
      expect(client.messages.map((message) => message.type)).toStrictEqual(["hello_ack"]);
      expect(
        diagnostics.some((diagnostic) =>
          diagnostic.detail.includes("egress accounting released frames=0 bytes=0"),
        ),
      ).toBe(true);
      expect(unhandled).toStrictEqual([]);

      lateCallback();
      stubbornTail.resolve();
      await receiveSettled.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).not.toHaveBeenCalled();
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(detach).toHaveBeenCalledTimes(1);
      expect(unhandled).toStrictEqual([]);
    } finally {
      stubbornTail.resolve();
      process.off("unhandledRejection", onUnhandled);
      held.restore();
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
    }
  });

  it("sends one safe schema error before close and rejects every later normal frame", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    let channel!: BridgeConnectionChannel;
    const originalOpen = authority.openConnection.bind(authority);
    vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
      channel = input.channel;
      return originalOpen(input);
    });
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const eventOrder: string[] = [];
    client.socket.on("message", (raw) => {
      eventOrder.push((JSON.parse(raw.toString()) as { readonly type?: string }).type ?? "unknown");
    });
    client.socket.once("close", () => eventOrder.push("close"));
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    client.socket.send('{"v":1,"type":"session_register","id":"malformed"');

    const closed = await client.closed;
    expect(closed).toMatchObject({ code: 4400, reason: "RBP protocol error" });
    expect(eventOrder).toStrictEqual(["hello_ack", "error", "close"]);
    expect(client.messages[1]).toMatchObject({
      type: "error",
      payload: { fault_class: "protocol", message: "RBP protocol error" },
    });
    expect(client.messages.filter((message) => message.type === "error")).toHaveLength(1);
    await expect(channel.send(JSON.stringify({ late: true }))).rejects.toThrow(
      "normal egress is closed",
    );
  });

  it("observes a normal send callback failure without putting its detail on the wire", async () => {
    const canary = "SYNTHETIC-NORMAL-SEND-CALLBACK-CANARY";
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    let channel!: BridgeConnectionChannel;
    const originalOpen = authority.openConnection.bind(authority);
    vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
      channel = input.channel;
      return originalOpen(input);
    });
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    const failingSend = ((
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: unknown,
    ): void => {
      const completion =
        typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      if (typeof completion === "function") {
        (completion as (error?: Error) => void)(new Error(canary));
      }
    }) as typeof serverSocket.send;
    const send = vi.spyOn(serverSocket, "send").mockImplementation(failingSend);

    await expect(channel.send(JSON.stringify({ callback: "failure" }))).rejects.toThrow(canary);
    expect(JSON.stringify(client.messages)).not.toContain(canary);
    expect(diagnostics).toContainEqual({
      contractVersion: RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
      event: "gateway.rbp_wss_internal_diagnostic",
      phase: "egress",
      faultClass: "internal",
      closeCode: 1011,
      detail: canary,
    });
    send.mockRestore();
    client.socket.close(1000, "test complete");
    await client.closed;
  });

  it("closes safely when the one terminal error send callback fails", async () => {
    const canary = "SYNTHETIC-TERMINAL-SEND-CALLBACK-CANARY";
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    const failingSend = ((
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: unknown,
    ): void => {
      const completion =
        typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      if (typeof completion === "function") {
        (completion as (error?: Error) => void)(new Error(canary));
      }
    }) as typeof serverSocket.send;
    vi.spyOn(serverSocket, "send").mockImplementation(failingSend);
    client.socket.send('{"v":1,"type":"session_register","id":"malformed"');

    const closed = await client.closed;
    expect(closed).toMatchObject({ code: 4400, reason: "RBP protocol error" });
    expect(client.messages.map((message) => message.type)).toStrictEqual(["hello_ack"]);
    assertCanaryAbsentFromRemote(client, closed, canary);
    expect(diagnostics).toContainEqual({
      contractVersion: RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
      event: "gateway.rbp_wss_internal_diagnostic",
      phase: "egress",
      faultClass: "internal",
      closeCode: 4400,
      detail: canary,
    });
  });

  it("contains synthetic socket errors, detaches once, and keeps the Gateway alive", async () => {
    const canary = "SYNTHETIC-INTERNAL-SOCKET-CANARY";
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    let channel!: BridgeConnectionChannel;
    const originalOpen = authority.openConnection.bind(authority);
    vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
      channel = input.channel;
      return originalOpen(input);
    });
    const detach = vi.spyOn(authority, "detach");
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const accepted = captureNextServerSocket();
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    const serverSocket = await accepted.promise;

    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    expect(() => serverSocket.emit("error", new Error(canary))).not.toThrow();
    expect(() => serverSocket.emit("error", new Error("duplicate socket fault"))).not.toThrow();

    const closed = await client.closed;
    expect(closed.code).toBe(1011);
    expect(client.messages.map((message) => message.type)).toStrictEqual([
      "hello_ack",
      "error",
    ]);
    expect(client.messages[1]).toMatchObject({
      type: "error",
      payload: { fault_class: "protocol", message: "RBP internal error" },
    });
    expect(client.messages.filter((message) => message.type === "error")).toHaveLength(1);
    assertCanaryAbsentFromRemote(client, closed, canary);
    expect(diagnostics).toContainEqual({
      contractVersion: RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
      event: "gateway.rbp_wss_internal_diagnostic",
      phase: "transport",
      faultClass: "internal",
      closeCode: 1011,
      detail: canary,
    });
    expect(detach).toHaveBeenCalledTimes(1);
    await expect(channel.send(JSON.stringify({ late: true }))).rejects.toThrow(
      "normal egress is closed",
    );

    const survivor = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${String(server.port)}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    bindings.push(survivor);
    await expect(survivor.open(hello())).resolves.toMatchObject({ type: "hello_ack" });
  });

  it.each([
    {
      label: "missing credential",
      deviceToken: "wrong-device-token",
      opening: (): HelloEnvelope => hello(),
      expectedCode: 4401,
      injectedFault: false,
    },
    {
      label: "unsupported version",
      deviceToken: "device-token",
      opening: (): HelloEnvelope => hello(),
      expectedCode: 4426,
      injectedFault: true,
    },
  ])("uses the frozen close code for $label", async ({
    deviceToken,
    opening,
    expectedCode,
    injectedFault,
  }) => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    if (injectedFault) {
      vi.spyOn(authority, "openConnection").mockRejectedValueOnce(
        new GatewayRbpFault(
          "unsupported",
          "no mutually supported RBP version",
          426,
          4426,
        ),
      );
    }
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port, deviceToken);
    client.socket.send(JSON.stringify(opening()));

    await expect(client.closed).resolves.toMatchObject({ code: expectedCode });
  });

  it("keeps an authentication canary only in the protected diagnostic", async () => {
    const canary = "SYNTHETIC-AUTH-DETAIL-CANARY";
    const restartable = createRestartableTestStore();
    const baseIdentity = identity();
    const canaryIdentity: IdentityPort = {
      ...baseIdentity,
      async authenticateDevice() {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: canary,
        };
      },
    };
    const authority = new GatewayBridgeSessionAuthority(restartable.store, canaryIdentity);
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: canaryIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    client.socket.send(JSON.stringify(hello()));

    const closed = await client.closed;
    expect(closed).toMatchObject({ code: 4401, reason: "RBP authentication failed" });
    assertCanaryAbsentFromRemote(client, closed, canary);
    expect(diagnostics).toContainEqual({
      contractVersion: RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
      event: "gateway.rbp_wss_internal_diagnostic",
      phase: "opening",
      faultClass: "auth",
      closeCode: 4401,
      detail: canary,
    });
  });

  it("uses 1001 for controlled drain", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));

    await authority.close();
    await expect(client.closed).resolves.toMatchObject({ code: 1001 });
  });

  it("contains a rejecting detach without an unhandled rejection", async () => {
    const canary = "SYNTHETIC-REAL-DETACH-REJECTION-CANARY";
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const detach = vi.spyOn(authority, "detach").mockRejectedValue(new Error(canary));
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    let connectionId: string | null = null;

    try {
      client.socket.send(JSON.stringify(hello()));
      await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
      connectionId = (
        client.messages[0] as Extract<RbpEnvelope, { type: "hello_ack" }>
      ).payload.connection_id;
      client.socket.close(1000, "test close");
      const closed = await client.closed;
      await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toStrictEqual([]);
      assertCanaryAbsentFromRemote(client, closed, canary);
      expect(diagnostics).toContainEqual({
        contractVersion: RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
        event: "gateway.rbp_wss_internal_diagnostic",
        phase: "teardown",
        faultClass: "internal",
        closeCode: 1011,
        detail: canary,
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
      detach.mockRestore();
      if (connectionId !== null) await authority.detach(connectionId);
    }
  });

  it.each(["close", "error"] as const)(
    "does not orphan authority when transport %s arrives during open",
    async (event) => {
      const restartable = createRestartableTestStore();
      const authenticationStarted = deferred();
      const releaseAuthentication = deferred();
      const delayedIdentity = identity(undefined, {
        beforeDeviceResult: async () => {
          authenticationStarted.resolve();
          await releaseAuthentication.promise;
        },
      });
      const authority = new GatewayBridgeSessionAuthority(restartable.store, delayedIdentity);
      const openConnection = vi.spyOn(authority, "openConnection");
      const detach = vi.spyOn(authority, "detach");
      const accepted = captureNextServerSocket();
      const server = await startGatewayServer({
        config,
        ports: {
          ...createFailClosedPorts(),
          identity: delayedIdentity,
          protocolStore: restartable.store,
          rbpIngress: createProductionRbpIngressHost({ authority }),
        },
      });
      handles.push(server);
      const client = await openRawWss(server.port);
      const serverSocket = await accepted.promise;

      try {
        client.socket.send(JSON.stringify(hello()));
        await authenticationStarted.promise;
        if (event === "close") {
          const serverClosed = deferred();
          serverSocket.once("close", () => serverClosed.resolve());
          client.socket.terminate();
          await serverClosed.promise;
        } else {
          serverSocket.emit("error", new Error("synthetic opening error"));
        }
        releaseAuthentication.resolve();
        await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1));
        expect(openConnection).toHaveBeenCalledTimes(1);
        expect(client.messages).toHaveLength(0);
        if (event === "error") {
          await expect(client.closed).resolves.toMatchObject({ code: 1011 });
        }
      } finally {
        releaseAuthentication.resolve();
        if (client.socket.readyState !== WebSocket.CLOSED) client.socket.terminate();
      }
    },
  );

  it("maps an unexpected opening-handler failure to 1011 and survives", async () => {
    const canary = "SYNTHETIC-OPENING-HANDLER-CANARY";
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const openConnection = vi
      .spyOn(authority, "openConnection")
      .mockRejectedValueOnce(new Error(canary));
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    client.socket.send(JSON.stringify(hello()));

    const closed = await client.closed;
    expect(closed).toMatchObject({ code: 1011, reason: "RBP internal error" });
    assertCanaryAbsentFromRemote(client, closed, canary);
    expect(diagnostics.some((diagnostic) => diagnostic.detail === canary)).toBe(true);
    expect(openConnection).toHaveBeenCalledTimes(1);
    openConnection.mockRestore();

    const survivor = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${String(server.port)}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    bindings.push(survivor);
    await expect(survivor.open(hello())).resolves.toMatchObject({ type: "hello_ack" });
  });

  it("maps an unexpected steady-state handler failure to 1011", async () => {
    const canary = "SYNTHETIC-RECEIVE-HANDLER-CANARY";
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const receive = vi
      .spyOn(authority, "receive")
      .mockRejectedValueOnce(new Error(canary));
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    client.socket.send(JSON.stringify(registration()));

    const closed = await client.closed;
    expect(closed).toMatchObject({ code: 1011, reason: "RBP internal error" });
    expect(client.messages.map((message) => message.type)).toStrictEqual([
      "hello_ack",
      "error",
    ]);
    expect(client.messages[1]).toMatchObject({
      type: "error",
      payload: { fault_class: "protocol", message: "RBP internal error" },
    });
    assertCanaryAbsentFromRemote(client, closed, canary);
    expect(diagnostics).toContainEqual({
      contractVersion: RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
      event: "gateway.rbp_wss_internal_diagnostic",
      phase: "receive",
      faultClass: "internal",
      closeCode: 1011,
      detail: canary,
    });
    expect(receive).toHaveBeenCalledTimes(1);
  });

  it("maps a durable store registration failure to 1011", async () => {
    const canary = "SYNTHETIC-STORE-FAILURE-CANARY";
    const restartable = createRestartableTestStore();
    vi.spyOn(restartable.store, "transact").mockResolvedValueOnce({
      ok: false,
      code: "unavailable",
      message: canary,
    } as never);
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const diagnostics: RbpWssInternalDiagnostic[] = [];
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onWssInternalDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    client.socket.send(JSON.stringify(registration()));

    const closed = await client.closed;
    expect(closed).toMatchObject({ code: 1011, reason: "RBP internal error" });
    expect(client.messages.map((message) => message.type)).toStrictEqual([
      "hello_ack",
      "error",
    ]);
    assertCanaryAbsentFromRemote(client, closed, canary);
    expect(diagnostics.some((diagnostic) => diagnostic.detail === canary)).toBe(true);
  });

  it("survives a transport-level oversize frame and accepts the next socket", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    client.socket.send(Buffer.alloc(48 * 1024 * 1024 + 1, 0x20), { binary: false });

    await expect(client.closed).resolves.toMatchObject({ code: 1009 });
    const survivor = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${String(server.port)}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    bindings.push(survivor);
    await expect(survivor.open(hello())).resolves.toMatchObject({ type: "hello_ack" });
  });

  for (const kind of ["wss", "http_sse"] as const) {
    it(`routes register and dispatch through the shared ${kind} authority`, async () => {
      const restartable = createRestartableTestStore();
      const activeIdentity = identity();
      const authenticateDevice = vi.spyOn(activeIdentity, "authenticateDevice");
      const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
      const ingress = createProductionRbpIngressHost({ authority });
      const server = await startGatewayServer({
        config,
        ports: { ...createFailClosedPorts(), identity: activeIdentity, protocolStore: restartable.store, rbpIngress: ingress },
      });
      handles.push(server);
      const binding: GatewayBinding =
        kind === "wss"
          ? new WssGatewayBinding({
              baseUrl: `ws://127.0.0.1:${String(server.port)}/bridge/v1`,
              deviceToken: "device-token",
              endpointPolicy: "loopback_test_readiness",
            })
          : new HttpSseGatewayBinding({
              baseUrl: `http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`,
              deviceToken: "device-token",
              endpointPolicy: "loopback_test_readiness",
            });
      bindings.push(binding);

      const ack = await binding.open(hello());
      if (kind === "http_sse") {
        // HTTP/SSE admits against the authenticated tenant/device scope before
        // the authority claims the connection, then re-validates at the shared
        // transport-neutral authority boundary.
        expect(authenticateDevice).toHaveBeenCalledTimes(4);
      }
      expect(ack.payload.connection_id).toBe(binding.connectionId);
      expect(ack.payload.granted_capabilities).toContain("transport_streamable_http");
      if (kind === "wss" && (binding as WssGatewayBinding).closeInfo !== null) {
        throw new Error(
          `WSS closed after hello: ${JSON.stringify((binding as WssGatewayBinding).closeInfo)}`,
        );
      }
      await binding.send(registration());
      if (kind === "http_sse") {
        expect(authenticateDevice).toHaveBeenCalledTimes(5);
      }
      const registered = (await next(binding)) as SessionRegisteredEnvelope;

      const executor = authority.createExecutor();
      const invocation = request(registered.payload.rsid);
      const outcomePromise = executor.execute(invocation);
      const invoke = await next(binding);
      expect(invoke).toMatchObject({
        type: "invoke",
        rsid: registered.payload.rsid,
        payload: { method: "get_revit_mcp_status" },
      });
      await binding.send(
        terminal(
          registered.payload.rsid,
          invocation.context.invocationId,
          1,
          (invoke as Extract<RbpEnvelope, { type: "invoke" }>).seq,
        ),
      );
      if (kind === "http_sse") {
        expect(authenticateDevice).toHaveBeenCalledTimes(6);
      }
      await expect(outcomePromise).resolves.toEqual({
        state: "completed",
        result: { success: true, source: "gw12-fixture" },
      });
      await expect(
        binding.sendChunkConformanceFrame!({
          v: 1,
          type: "partial",
          id: id(),
          rsid: registered.payload.rsid,
          seq: 2,
          ts: new Date().toISOString(),
          payload: { kind: "chunk", invocation_id: "missing-required-fields" },
        }),
      ).resolves.toMatchObject({
        accepted: false,
        faultClass: "protocol",
        binding: kind === "wss" ? "wss" : "streamable_http_sse",
      });
      if (kind === "http_sse") {
        expect(authenticateDevice).toHaveBeenCalledTimes(7);
      }
    });
  }

  it("closes and removes an active HTTP/SSE binding on identity revoke, then returns 410", async () => {
    const restartable = createRestartableTestStore();
    let revoked = false;
    const baseIdentity = identity();
    const activeIdentity: IdentityPort = {
      ...baseIdentity,
      async authenticateDevice(input) {
        const result = await baseIdentity.authenticateDevice(input);
        return !result.ok
          ? result
          : {
              ok: true as const,
              value: {
                ...result.value,
                deviceStatus: revoked ? ("revoked" as const) : ("active" as const),
              },
            };
      },
    };
    const authority = new GatewayBridgeSessionAuthority(
      restartable.store,
      activeIdentity,
    );
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const headers = {
      Authorization: "Bearer device-token",
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-RBP-Versions": "1",
    };
    const created = await fetch(`${baseUrl}/bridge/v1/http/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify(hello()),
    });
    expect(created.status).toBe(201);
    const connectionId = created.headers.get("RBP-Connection-Id");
    if (connectionId === null) throw new Error("HTTP create omitted connection id");
    const events = await fetch(
      `${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/events`,
      { headers: { Authorization: headers.Authorization, Accept: "text/event-stream" } },
    );
    expect(events.status).toBe(200);
    if (events.body === null) throw new Error("SSE response omitted its body");
    const reader = events.body.getReader();
    const registered = await fetch(
      `${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/messages`,
      { method: "POST", headers, body: JSON.stringify(registration()) },
    );
    expect(registered.status).toBe(202);

    revoked = true;
    await authority.revokeIdentityAuthority({
      tenantId: "tenant-gw12",
      deviceId: "device-gw12",
      seatId: "seat-gw12",
      authorizationVersion: 2,
      identityRecordVersion: 2,
      connectionCapabilityVersion: 2,
      sessionCapabilityVersion: 2,
    });
    let streamClosed = false;
    for (let reads = 0; reads < 4 && !streamClosed; reads += 1) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("revoked SSE stream did not close")), 2_000),
        ),
      ]);
      streamClosed = result.done;
    }
    expect(streamClosed).toBe(true);

    const messageAfterRevoke = await fetch(
      `${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/messages`,
      { method: "POST", headers, body: JSON.stringify(registration()) },
    );
    expect(messageAfterRevoke.status).toBe(410);
    const eventsAfterRevoke = await fetch(
      `${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/events`,
      { headers: { Authorization: headers.Authorization, Accept: "text/event-stream" } },
    );
    expect(eventsAfterRevoke.status).toBe(410);
  });

  it("reserves HTTP/SSE caps before authority open, releases TTL entries, and distinguishes 404 from 410", async () => {
    let nowMs = 0;
    let sweep!: () => void;
    const restartable = createRestartableTestStore();
    const first = identity();
    const second = identity(undefined, {
      deviceToken: "device-token-second",
      deviceId: "device-gw12-second",
      tenantId: "tenant-gw12-second",
    });
    const multiDeviceIdentity: IdentityPort = {
      ...first,
      async authenticateDevice(input) {
        return input.deviceToken === "device-token-second"
          ? second.authenticateDevice(input)
          : first.authenticateDevice(input);
      },
    };
    const authority = new GatewayBridgeSessionAuthority(restartable.store, multiDeviceIdentity);
    const ingress = createProductionRbpIngressHost({
      authority,
      httpSseLifecycleRuntime: {
        clock: () => nowMs,
        setInterval: (callback) => {
          sweep = callback;
          return 0 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {},
      },
    });
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: multiDeviceIdentity,
        protocolStore: restartable.store,
        rbpIngress: ingress,
      },
    });
    handles.push(server);
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-RBP-Versions": "1",
    });
    const create = async (token = "device-token", deviceId = "device-gw12") =>
      fetch(`${baseUrl}/bridge/v1/http/connections`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify(hello({ deviceId })),
      });

    const created: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const response = await create();
      expect(response.status).toBe(201);
      const connectionId = response.headers.get("RBP-Connection-Id");
      if (connectionId === null) throw new Error("HTTP create omitted connection id");
      created.push(connectionId);
    }
    await expect(create()).resolves.toMatchObject({ status: 429 });
    // A saturated tenant/device scope must not consume a different tenant's quota.
    await expect(create("device-token-second", "device-gw12-second")).resolves.toMatchObject({
      status: 201,
    });
    await expect(
      fetch(`${baseUrl}/bridge/v1/http/connections/not-a-connection/events`, {
        headers: { Authorization: "Bearer device-token", Accept: "text/event-stream" },
      }),
    ).resolves.toMatchObject({ status: 404 });

    nowMs = 30_001;
    sweep();
    await expect(
      fetch(
        `${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(created[0]!)}/messages`,
        { method: "POST", headers: headers("device-token"), body: JSON.stringify(registration()) },
      ),
    ).resolves.toMatchObject({ status: 410 });
    // Counter release happens before slow authority detach, so the exact cap is reusable.
    await expect(create()).resolves.toMatchObject({ status: 201 });
  });

  it("releases a reserved HTTP/SSE admission when authority open fails", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const openConnection = vi.spyOn(authority, "openConnection");
    openConnection.mockRejectedValueOnce(new Error("synthetic opening failure"));
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const create = () =>
      fetch(`http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`, {
        method: "POST",
        headers: {
          Authorization: "Bearer device-token",
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-RBP-Versions": "1",
        },
        body: JSON.stringify(hello()),
      });
    await expect(create()).resolves.toMatchObject({ status: 500 });
    await expect(create()).resolves.toMatchObject({ status: 201 });
  });

  it("fails closed and releases admission when identity drifts between reservation and authority binding", async () => {
    const restartable = createRestartableTestStore();
    const first = identity();
    const second = identity(undefined, { tenantId: "tenant-drift" });
    let authenticationCalls = 0;
    const driftingIdentity: IdentityPort = {
      ...first,
      async authenticateDevice(input) {
        authenticationCalls += 1;
        return authenticationCalls === 1
          ? first.authenticateDevice(input)
          : second.authenticateDevice(input);
      },
    };
    const authority = new GatewayBridgeSessionAuthority(restartable.store, driftingIdentity);
    const detach = vi.spyOn(authority, "detach");
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: driftingIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const create = () =>
      fetch(`http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`, {
        method: "POST",
        headers: {
          Authorization: "Bearer device-token",
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-RBP-Versions": "1",
        },
        body: JSON.stringify(hello()),
      });
    await expect(create()).resolves.toMatchObject({ status: 403 });
    expect(detach).toHaveBeenCalledTimes(1);
    // All later authentication calls return the same principal, so a new
    // opening proves the drift rejection did not retain its reservation.
    await expect(create()).resolves.toMatchObject({ status: 201 });
  });

  it("disposes registered no-SSE overflow immediately and contains later terminal paths", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    let channel: BridgeConnectionChannel | null = null;
    const originalOpen = authority.openConnection.bind(authority);
    vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
      channel = input.channel;
      return await originalOpen(input);
    });
    const detach = vi.spyOn(authority, "detach");
    const ingress = createProductionRbpIngressHost({ authority });
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: ingress,
      },
    });
    handles.push(server);
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const headers = {
      Authorization: "Bearer device-token",
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-RBP-Versions": "1",
    };
    const created = await fetch(`${baseUrl}/bridge/v1/http/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify(hello()),
    });
    expect(created.status).toBe(201);
    const connectionId = created.headers.get("RBP-Connection-Id");
    if (connectionId === null || channel === null) throw new Error("HTTP opening evidence unavailable");
    await expect(
      fetch(`${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(registration()),
      }),
    ).resolves.toMatchObject({ status: 202 });
    await expect((channel as unknown as BridgeConnectionChannel).send("x".repeat(1024 * 1024 + 1))).rejects.toThrow(
      "SSE attach backlog exceeds the bounded transport window",
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1));
    ingress.beginDrain?.();
    expect(detach).toHaveBeenCalledTimes(1);
    await expect(
      fetch(`${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/events`, {
        headers: { Authorization: headers.Authorization, Accept: "text/event-stream" },
      }),
    ).resolves.toMatchObject({ status: 410 });
  });

  it("disposes a live HTTP/SSE entry on credential failure and keeps the tombstone terminal", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const detach = vi.spyOn(authority, "detach");
    const ingress = createProductionRbpIngressHost({ authority });
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: ingress,
      },
    });
    handles.push(server);
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const headers = {
      Authorization: "Bearer device-token",
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-RBP-Versions": "1",
    };
    const created = await fetch(`${baseUrl}/bridge/v1/http/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify(hello()),
    });
    expect(created.status).toBe(201);
    const connectionId = created.headers.get("RBP-Connection-Id");
    if (connectionId === null) throw new Error("HTTP create omitted connection id");
    await expect(
      fetch(`${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/messages`, {
        method: "POST",
        headers: { ...headers, Authorization: "Bearer wrong-token" },
        body: JSON.stringify(registration()),
      }),
    ).resolves.toMatchObject({ status: 403 });
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1));
    ingress.beginDrain?.();
    expect(detach).toHaveBeenCalledTimes(1);
    await expect(
      fetch(`${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/events`, {
        headers: { Authorization: headers.Authorization, Accept: "text/event-stream" },
      }),
    ).resolves.toMatchObject({ status: 410 });
  });

  it("contains a racing HTTP/SSE detach rejection through the one disposer", async () => {
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const detach = vi.spyOn(authority, "detach").mockRejectedValue(new Error("synthetic detach failure"));
    const ingress = createProductionRbpIngressHost({ authority });
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: ingress,
      },
    });
    handles.push(server);
    const baseUrl = `http://127.0.0.1:${String(server.port)}`;
    const headers = {
      Authorization: "Bearer device-token",
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-RBP-Versions": "1",
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const created = await fetch(`${baseUrl}/bridge/v1/http/connections`, {
        method: "POST",
        headers,
        body: JSON.stringify(hello()),
      });
      expect(created.status).toBe(201);
      const connectionId = created.headers.get("RBP-Connection-Id");
      if (connectionId === null) throw new Error("HTTP create omitted connection id");
      if (ingress.beginDrain === undefined) throw new Error("production ingress cannot drain");
      ingress.beginDrain();
      await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(unhandled).toEqual([]);
      await expect(
        fetch(`${baseUrl}/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/events`, {
          headers: { Authorization: headers.Authorization, Accept: "text/event-stream" },
        }),
      ).resolves.toMatchObject({ status: 410 });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      detach.mockRestore();
    }
  });

  it("leaves zero HTTP/SSE entries and admissions after 1000 fake-clock TTL cycles", async () => {
    let nowMs = 0;
    let sweep!: () => void;
    let latest = { entries: -1, globalAdmissions: -1, tenantAdmissions: -1, deviceAdmissions: -1 };
    const restartable = createRestartableTestStore();
    const activeIdentity = identity();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, activeIdentity);
    const detach = vi.spyOn(authority, "detach");
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          httpSseLifecycleRuntime: {
            clock: () => nowMs,
            setInterval: (callback) => {
              sweep = callback;
              return 0 as unknown as ReturnType<typeof setInterval>;
            },
            clearInterval() {},
            onLifecycleSnapshot: (snapshot) => {
              latest = snapshot;
            },
          },
        }),
      },
    });
    handles.push(server);
    const url = `http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`;
    const connectionIds: string[] = [];
    for (let cycle = 0; cycle < 1_000; cycle += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer device-token",
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-RBP-Versions": "1",
        },
        body: JSON.stringify(hello()),
      });
      expect(response.status).toBe(201);
      const connectionId = response.headers.get("RBP-Connection-Id");
      if (connectionId === null) throw new Error("HTTP create omitted connection id");
      connectionIds.push(connectionId);
      nowMs += 30_001;
      sweep();
    }
    expect(latest).toEqual({
      entries: 0,
      globalAdmissions: 0,
      tenantAdmissions: 0,
      deviceAdmissions: 0,
    });
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1_000), { timeout: 30_000 });
    for (const connectionId of connectionIds) {
      expect(() => authority.assertConnectionOutbound(connectionId)).toThrow(GatewayRbpFault);
    }
  }, 30_000);

  it("enforces exact tenant and global HTTP/SSE caps, fair admission, and one detach per drain", async () => {
    const restartable = createRestartableTestStore();
    const baseIdentity = identity();
    const scopedIdentity: IdentityPort = {
      ...baseIdentity,
      async authenticateDevice(input) {
        const authenticated = await baseIdentity.authenticateDevice(input);
        if (!authenticated.ok) return authenticated;
        const claimed = input.claimedDeviceId ?? "tenant-cap/device-cap";
        const [claimedTenantId] = claimed.split("/", 1);
        const tenantId = input.establishedScope?.tenantId ?? claimedTenantId;
        const deviceId = input.establishedScope?.deviceId ?? claimed;
        if (tenantId === undefined || deviceId === undefined) {
          throw new Error("cap fixture requires tenant/device scope");
        }
        return {
          ok: true as const,
          value: {
            ...authenticated.value,
            actor: {
              ...authenticated.value.actor,
              tenantId,
              deviceId,
              seatId: `seat-${deviceId}`,
            },
          },
        };
      },
    };
    const authority = new GatewayBridgeSessionAuthority(restartable.store, scopedIdentity);
    const detach = vi.spyOn(authority, "detach");
    let latest = { entries: -1, globalAdmissions: -1, tenantAdmissions: -1, deviceAdmissions: -1 };
    const ingress = createProductionRbpIngressHost({
      authority,
      httpSseLifecycleRuntime: {
        onLifecycleSnapshot: (snapshot) => {
          latest = snapshot;
        },
      },
    });
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: scopedIdentity,
        protocolStore: restartable.store,
        rbpIngress: ingress,
      },
    });
    handles.push(server);
    const create = async (scope: string) =>
      fetch(`http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`, {
        method: "POST",
        headers: {
          Authorization: "Bearer device-token",
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-RBP-Versions": "1",
        },
        body: JSON.stringify(hello({ deviceId: scope })),
      });

    for (let index = 0; index < 128; index += 1) {
      await expect(create(`tenant-a/device-${String(index)}`)).resolves.toMatchObject({ status: 201 });
    }
    await expect(create("tenant-a/device-over")).resolves.toMatchObject({ status: 429 });
    await expect(create("tenant-b/device-fair")).resolves.toMatchObject({ status: 201 });
    for (let index = 0; index < 895; index += 1) {
      await expect(create(`tenant-${String(index + 2)}/device-${String(index)}`)).resolves.toMatchObject({ status: 201 });
    }
    expect(latest.globalAdmissions).toBe(1_024);
    await expect(create("tenant-global/device-over")).resolves.toMatchObject({ status: 429 });

    if (ingress.beginDrain === undefined) throw new Error("production ingress cannot drain");
    ingress.beginDrain();
    expect(latest).toEqual({
      entries: 0,
      globalAdmissions: 0,
      tenantAdmissions: 0,
      deviceAdmissions: 0,
    });
    await vi.waitFor(() => expect(detach).toHaveBeenCalledTimes(1_024), { timeout: 30_000 });
  }, 60_000);

  it("closes an active WSS binding with 4403 after durable identity revoke", async () => {
    const restartable = createRestartableTestStore();
    let revoked = false;
    const baseIdentity = identity();
    const activeIdentity: IdentityPort = {
      ...baseIdentity,
      async authenticateDevice(input) {
        const result = await baseIdentity.authenticateDevice(input);
        return !result.ok
          ? result
          : {
              ok: true as const,
              value: {
                ...result.value,
                deviceStatus: revoked ? ("revoked" as const) : ("active" as const),
              },
            };
      },
    };
    const authority = new GatewayBridgeSessionAuthority(
      restartable.store,
      activeIdentity,
    );
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: activeIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      },
    });
    handles.push(server);
    const client = await openRawWss(server.port);
    client.socket.send(JSON.stringify(hello()));
    await vi.waitFor(() => expect(client.messages[0]?.type).toBe("hello_ack"));
    client.socket.send(JSON.stringify(registration()));
    await vi.waitFor(() =>
      expect(client.messages.some((message) => message.type === "session_registered")).toBe(true),
    );

    revoked = true;
    await authority.revokeIdentityAuthority({
      tenantId: "tenant-gw12",
      deviceId: "device-gw12",
      seatId: "seat-gw12",
      authorizationVersion: 2,
      identityRecordVersion: 2,
      connectionCapabilityVersion: 2,
      sessionCapabilityVersion: 2,
    });
    await expect(client.closed).resolves.toMatchObject({
      code: 4403,
      reason: "RBP authorization failed",
    });
  });

  it.each(["wss", "http_sse"] as const)(
    "suppresses %s hello_ack when revocation wins after openConnection",
    async (kind) => {
      const restartable = createRestartableTestStore();
      const activeIdentity = identity();
      const authority = new GatewayBridgeSessionAuthority(
        restartable.store,
        activeIdentity,
      );
      const originalOpen = authority.openConnection.bind(authority);
      vi.spyOn(authority, "openConnection").mockImplementation(async (input) => {
        const opened = await originalOpen(input);
        await authority.revokeIdentityAuthority({
          tenantId: "tenant-gw12",
          deviceId: "device-gw12",
          seatId: "seat-gw12",
          authorizationVersion: 2,
          identityRecordVersion: 2,
          connectionCapabilityVersion: 2,
          sessionCapabilityVersion: 2,
        });
        return opened;
      });
      const server = await startGatewayServer({
        config,
        ports: {
          ...createFailClosedPorts(),
          identity: activeIdentity,
          protocolStore: restartable.store,
          rbpIngress: createProductionRbpIngressHost({ authority }),
        },
      });
      handles.push(server);
      if (kind === "wss") {
        const client = await openRawWss(server.port);
        client.socket.send(JSON.stringify(hello()));
        await expect(client.closed).resolves.toMatchObject({ code: 4403 });
        expect(client.messages.some((message) => message.type === "hello_ack")).toBe(false);
        return;
      }
      const response = await fetch(
        `http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer device-token",
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-RBP-Versions": "1",
          },
          body: JSON.stringify(hello()),
        },
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("RBP-Connection-Id")).toBeNull();
    },
  );

  it("keeps progress non-terminal and maps an acknowledged cancellation without duplicate dispatch", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    await authority.open();
    const sent: RbpEnvelope[] = [];
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sent.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });

    try {
      await authority.receive(opening.connectionId, registration());
      const registered = sent.shift() as SessionRegisteredEnvelope;
      const invocation = request(registered.payload.rsid);
      let settled = false;
      const outcomePromise = authority.createExecutor().execute(invocation);
      void outcomePromise.finally(() => {
        settled = true;
      });
      while (sent.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const invoke = sent.shift() as Extract<RbpEnvelope, { type: "invoke" }>;

      await authority.receive(opening.connectionId, {
        v: 1,
        type: "partial",
        id: id(),
        rsid: registered.payload.rsid,
        seq: 1,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "progress",
          invocation_id: invocation.context.invocationId,
          progress: { elapsed_ms: 100, note: "waiting_for_revit" },
        },
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await authority.receive(opening.connectionId, {
        v: 1,
        type: "error",
        id: id(),
        rsid: registered.payload.rsid,
        seq: 2,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          invocation_id: invocation.context.invocationId,
          retryable: false,
          fault_class: "cancelled",
          outcome: "known",
          verification_required: false,
          replayed: false,
          message: "cancel acknowledged",
        },
      });
      await expect(outcomePromise).resolves.toEqual({
        state: "failed",
        error: { code: "cancelled", message: "cancel acknowledged" },
      });
      expect(sent).toHaveLength(0);
    } finally {
      await authority.close();
    }
  });

  it("refuses HTTP/SSE unless the fallback capability was provisioned and granted", async () => {
    const restartable = createRestartableTestStore();
    const noFallbackIdentity = identity([]);
    const observations: RbpOpeningRefusalObservation[] = [];
    const authority = new GatewayBridgeSessionAuthority(
      restartable.store,
      noFallbackIdentity,
    );
    const server = await startGatewayServer({
      config,
      ports: {
        ...createFailClosedPorts(),
        identity: noFallbackIdentity,
        protocolStore: restartable.store,
        rbpIngress: createProductionRbpIngressHost({
          authority,
          onOpeningRefusalObservation: (observation) => observations.push(observation),
        }),
      },
    });
    handles.push(server);
    const response = await fetch(
      `http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer device-token",
          "Content-Type": "application/json",
          "X-RBP-Versions": "1",
        },
        body: JSON.stringify(hello()),
      },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      fault_class: "unsupported",
    });
    expect(observations).toStrictEqual([]);
  });

  it("routes every bridge-bound runtime method and keeps discovery internal", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    await authority.open();
    const sent: RbpEnvelope[] = [];
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sent.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sent.pop() as SessionRegisteredEnvelope;
    const allRuntimeTools = E5_TOOL_BINDINGS.filter(
      (row) => row.module === "runtime",
    );
    expect(allRuntimeTools).toHaveLength(35);
    expect(
      allRuntimeTools.find((row) => row.tool === "list_revit_instances"),
    ).toMatchObject({ executor: "internal_mcp" });
    const runtimeTools = allRuntimeTools.filter(
      (row) => row.tool !== "list_revit_instances",
    );
    expect(runtimeTools).toHaveLength(34);

    let bridgeSequence = 0;
    for (const row of runtimeTools) {
      const invocation = request(registered.payload.rsid, {
        method: row.tool,
        toolName: row.target,
      });
      const pending = authority.createExecutor().execute(invocation);
      while (sent.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const invoke = sent.shift() as Extract<RbpEnvelope, { type: "invoke" }>;
      expect(invoke.payload.method).toBe(row.tool);
      bridgeSequence += 1;
      await authority.receive(
        opening.connectionId,
        terminal(
          registered.payload.rsid,
          invocation.context.invocationId,
          bridgeSequence,
          invoke.seq,
        ),
      );
      await expect(pending).resolves.toMatchObject({ state: "completed" });
    }
    await authority.close();
  });

  it("exposes only committed bridge acceptance and terminal journal evidence", async () => {
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    await authority.open();
    const sent: RbpEnvelope[] = [];
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sent.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sent.pop() as SessionRegisteredEnvelope;
    const invocation = request(registered.payload.rsid, { mutating: true });
    const executor = authority.createExecutor();
    const draft = executor.buildMutationDispatch!(invocation);
    const envelope = draft.envelope as Extract<RbpEnvelope, { type: "invoke" }>;
    const journal = createReceivedJournalRecord(draft.expected.bindings[0]!);
    const envelopeDigest = dataEnvelopeImmutableDigest(
      envelope as DataEnvelopeSnapshot,
    );
    const prepared: GatewayRecoveryPendingDispatch = {
      kind: "mutation",
      envelope,
      envelopeDigest,
      gatewaySequence: envelope.seq,
      sessionBindingId: draft.sessionBindingId,
      preparedConnectionId: draft.connectionId,
      authorizedSessionVersion: 1,
      requiredSessionCapabilities: [],
      mutationEntries: [
        {
          invocationId: invocation.context.invocationId,
          idempotencyKey: invocation.context.idempotencyKey,
          mutationScope: { kind: "session" },
          journalBindingDigest: journal.bindingDigest,
        },
      ],
      journalRecords: [journal],
      journalAttestation: null,
      batchTerminal: null,
      recoveryHoldIds: [],
      recoveryClearances: [],
      verificationHoldId: null,
      originRedelivery: false,
      bridgeAcceptance: null,
      preparedAtMs: Date.now(),
    };
    const pending = executor.executePreparedMutation!(invocation, prepared);
    while (sent.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const dispatched = sent.shift() as Extract<RbpEnvelope, { type: "invoke" }>;
    await authority.receive(
      opening.connectionId,
      terminal(
        registered.payload.rsid,
        invocation.context.invocationId,
        1,
        dispatched.seq,
      ),
    );
    await expect(pending).resolves.toMatchObject({ state: "completed" });

    const lookup = await restartable.store.transact(
      { tenantId: "tenant-gw12" },
      async (tx) =>
        authority.inspectDispatch(tx, {
          rsid: registered.payload.rsid,
          sessionBindingId: draft.sessionBindingId,
          gatewaySequence: dispatched.seq,
          envelopeDigest,
          invocationBindings: [
            {
              idempotencyKey: invocation.context.idempotencyKey,
              bindingDigest: journal.bindingDigest,
            },
          ],
        }),
    );
    expect(lookup).toMatchObject({
      ok: true,
      value: {
        kind: "found",
        observation: {
          acceptance: { cumulativeAck: dispatched.seq },
          journal: { kind: "known_terminal" },
        },
      },
    });
    await authority.close();
  });

  it("uses the frozen heartbeat thresholds for degraded and disconnected dispatch", async () => {
    let nowMs = 0;
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(
      restartable.store,
      identity(),
      { clock: () => nowMs },
    );
    await authority.open();
    const sent: RbpEnvelope[] = [];
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sent.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sent.pop() as SessionRegisteredEnvelope;

    nowMs = 35_000;
    await expect(authority.sweepLiveness()).resolves.toEqual([]);
    expect(() => authority.buildEnvelope(request(registered.payload.rsid))).not.toThrow();

    nowMs = 65_000;
    await expect(authority.sweepLiveness()).resolves.toEqual([
      registered.payload.rsid,
    ]);
    expect(() => authority.buildEnvelope(request(registered.payload.rsid))).toThrow(
      "registered rsid is not connected",
    );
    await authority.close();
  });

  it("resumes one active binding after restart and retransmits the durable outbox", async () => {
    const restartable = createRestartableTestStore();
    const sentBeforeRestart: RbpEnvelope[] = [];
    const authority = new GatewayBridgeSessionAuthority(restartable.store, identity());
    await authority.open();
    const opening = await authority.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sentBeforeRestart.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await authority.receive(opening.connectionId, registration());
    const registered = sentBeforeRestart.at(-1) as SessionRegisteredEnvelope;
    const invocation = request(registered.payload.rsid, { mutating: true });
    const pending = authority.createExecutor().execute(invocation);
    while (!sentBeforeRestart.some((candidate) => candidate.type === "invoke")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const invoke = sentBeforeRestart.find(
      (candidate) => candidate.type === "invoke",
    ) as Extract<RbpEnvelope, { type: "invoke" }>;
    await authority.close();
    await expect(pending).resolves.toMatchObject({
      state: "failed",
      error: { code: "journal_indeterminate" },
    });

    const sentAfterRestart: RbpEnvelope[] = [];
    const restarted = new GatewayBridgeSessionAuthority(restartable.restart(), identity());
    await restarted.open();
    const second = await restarted.openConnection({
      deviceToken: "device-token",
      binding: "wss",
      hello: hello(),
      channel: {
        async send(serialized) {
          sentAfterRestart.push(JSON.parse(serialized) as RbpEnvelope);
        },
        async close() {},
      },
    });
    await restarted.receive(second.connectionId, {
      v: 1,
      type: "session_resume",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        rsid: registered.payload.rsid,
        resume_token: registered.payload.resume_token,
        last_rx_seq: 0,
      },
    });
    expect(sentAfterRestart.map((candidate) => candidate.type)).toEqual([
      "resume_ack",
      "invoke",
    ]);
    expect(
      dataEnvelopeImmutableDigest(
        sentAfterRestart[1] as unknown as DataEnvelopeSnapshot,
      ),
    ).toBe(
      dataEnvelopeImmutableDigest(invoke as unknown as DataEnvelopeSnapshot),
    );
    await restarted.close();
  });
});
