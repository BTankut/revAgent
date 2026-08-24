import { createHash } from "node:crypto";

import {
  makeParamsDigest,
  type DocContextUpdateEnvelope,
  type HelloEnvelope,
  type RbpEnvelope,
  type SessionRegisteredEnvelope,
} from "@revagent/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type DeviceAuthContext,
  type IdentityPort,
} from "./authContext.js";
import {
  GatewayBridgeSessionAuthority,
  GatewayRbpFault,
  TEST_RSID_CARRIER_RECEIVE_TAIL_OBSERVER,
  type BridgeConnectionChannel,
} from "./bridgeSession.js";
import type { GatewayExecutorRequest, GatewayJsonObject } from "./dispatch.js";
import { gatewayUuidV7 } from "./identifiers.js";
import {
  createEffectiveMcpRequestScopeV1,
  createGatewayDispatchProofAuthority,
} from "./invocationContext.js";
import { GatewayResourceAuthority } from "./resourceAuthority.js";
import { createMemoryObjectStore, createRestartableTestStore } from "./testAdapters.js";

const TENANT_ID = "tenant-route";
const USER_ID = "user-route";
const DEVICE_ID = "device-route";
const MCP_SESSION_ID = "mcp-route";
const DEVICE_TOKEN = "device-token-route";

let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);

function identity(capabilities: {
  readonly connectionCapabilities?: readonly string[];
  readonly sessionCapabilities?: readonly string[];
} = {}): IdentityPort {
  const deviceTokenDigest = `sha256:${createHash("sha256")
    .update(DEVICE_TOKEN)
    .digest("hex")}` as const;
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
      if (input.deviceToken !== DEVICE_TOKEN) {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "device identity is unavailable",
        };
      }
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: {
          type: "device",
          tenantId: TENANT_ID,
          userId: USER_ID,
          deviceId: DEVICE_ID,
          seatId: "seat-route",
        },
        connectionId: input.connectionId,
        deviceStatus: "active",
        grantedConnectionCapabilities: capabilities.connectionCapabilities ?? [],
        grantedSessionCapabilities: capabilities.sessionCapabilities ?? ["partial_progress"],
        deviceTokenDigest,
      };
      return { ok: true as const, value: context };
    },
  };
}

function hello(): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["partial_progress"],
      bridge_version: "m4-route-test",
      device_id: DEVICE_ID,
      machine: { hostname: "petrucci", os: "windows" },
      addin_versions: ["m4-route-test"],
    },
  };
}

function registration(
  localSessionKey: string,
): Extract<RbpEnvelope, { type: "session_register" }> {
  return {
    v: 1,
    type: "session_register",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      local_session_key: localSessionKey,
      user_hint: { name: "fixture" },
      machine: {
        hostname: "petrucci",
        fingerprint: `sha256:${"2".repeat(64)}`,
      },
      revit: { version: "2022", build: "fixture", pid: 4321 },
      addin_version: "m4-route-test",
      result_contract_version: 1,
      session_capabilities: ["partial_progress"],
      bridge_version: "m4-route-test",
      documents: [],
      port: 48884,
    },
  };
}

function document(documentId: string, isActive: boolean) {
  return {
    document_id: documentId,
    title: "M4 route fixture",
    path_digest: null,
    is_workshared: false,
    is_active: isActive,
  };
}

function contextUpdate(input: {
  readonly rsid: string;
  readonly seq: number;
  readonly activeDocument: string | null;
  readonly documents: readonly ReturnType<typeof document>[];
}): DocContextUpdateEnvelope {
  return {
    v: 1,
    type: "doc_context_update",
    id: id(),
    rsid: input.rsid,
    seq: input.seq,
    ts: new Date().toISOString(),
    payload: {
      documents: [...input.documents],
      active_document: input.activeDocument,
      active_view: null,
    },
  };
}

interface TestChannel extends BridgeConnectionChannel {
  readonly frames: RbpEnvelope[];
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function channel(): TestChannel {
  const frames: RbpEnvelope[] = [];
  return {
    frames,
    async send(serialized): Promise<void> {
      frames.push(JSON.parse(serialized) as RbpEnvelope);
    },
    async close(): Promise<void> {},
  };
}

function registeredFrame(channel: TestChannel): SessionRegisteredEnvelope {
  const found = [...channel.frames]
    .reverse()
    .find((frame): frame is SessionRegisteredEnvelope =>
      frame.type === "session_registered",
    );
  if (found === undefined) throw new Error("session_registered was not emitted");
  return found;
}

async function openConnection(
  authority: GatewayBridgeSessionAuthority,
  binding: "wss" | "http_sse" = "wss",
): Promise<{ readonly connectionId: string; readonly channel: TestChannel }> {
  const openedChannel = channel();
  const opened = await authority.openConnection({
    deviceToken: DEVICE_TOKEN,
    binding,
    hello: hello(),
    channel: openedChannel,
  });
  return { connectionId: opened.connectionId, channel: openedChannel };
}

async function register(
  authority: GatewayBridgeSessionAuthority,
  localSessionKey = "local-route",
  binding: "wss" | "http_sse" = "wss",
) {
  const opened = await openConnection(authority, binding);
  await authority.receive(opened.connectionId, registration(localSessionKey));
  const registered = registeredFrame(opened.channel);
  return {
    ...opened,
    rsid: registered.payload.rsid,
    resumeToken: registered.payload.resume_token,
  };
}

function bridgeRequest(
  rsid: string,
  invocationId: string,
): GatewayExecutorRequest {
  const args: GatewayJsonObject = { carrier: "wp11" };
  const effectiveMcpRequestScope = createEffectiveMcpRequestScopeV1({
    principalKey: `${TENANT_ID}:${USER_ID}`,
    transportMcpSessionId: MCP_SESSION_ID,
    identityMcpSessionId: null,
    nowMs: 1_775_000_000_000,
  });
  return {
    toolName: "core.get_status",
    toolVersion: "1.0.0",
    executorMethod: "get_revit_mcp_status",
    policyClass: "auto",
    mutationScopePolicy: "none",
    args,
    context: {
      invocationId,
      idempotencyKey: `${rsid}/${invocationId}`,
      principalKey: `${TENANT_ID}:${USER_ID}`,
      actor: { tenantId: TENANT_ID, userId: USER_ID, role: "user" },
      gatewaySessionId: "gateway-route",
      oauthClientId: "oauth-route",
      mcpSessionId: MCP_SESSION_ID,
      effectiveMcpRequestScope,
      rsid,
      toolName: "core.get_status",
      toolVersion: "1.0.0",
      policyClass: "auto",
      policyDecision: "auto",
      confirmationId: null,
      originatingPreviewInvocationId: null,
      mutationScopePolicy: "none",
      mutating: false,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: "document-carrier" },
      paramsDigest: makeParamsDigest(args as unknown as Parameters<typeof makeParamsDigest>[0]),
      mutationScope: null,
      startedAtMs: 1_775_000_000_000,
    },
  };
}

async function emittedInvoke(channel: TestChannel): Promise<Extract<RbpEnvelope, { type: "invoke" }>> {
  for (let turn = 0; turn < 30; turn += 1) {
    const frame = channel.frames.find(
      (candidate): candidate is Extract<RbpEnvelope, { type: "invoke" }> => candidate.type === "invoke",
    );
    if (frame !== undefined) return frame;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("carrier dispatch did not emit an invoke frame");
}

function resolve(authority: GatewayBridgeSessionAuthority) {
  return authority.resolveLiveInvocationRoute({
    tenantId: TENANT_ID,
    userId: USER_ID,
    deviceId: DEVICE_ID,
    effectiveMcpRequestScope: createEffectiveMcpRequestScopeV1({
      principalKey: `${TENANT_ID}:${USER_ID}`,
      transportMcpSessionId: MCP_SESSION_ID,
      identityMcpSessionId: null,
      nowMs: 1_775_000_000_000,
    }),
  });
}

function expectUnavailable(authority: GatewayBridgeSessionAuthority): void {
  let thrown: unknown;
  try {
    resolve(authority);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(GatewayRbpFault);
  expect(thrown).toMatchObject({
    code: "unavailable",
    message: "live invocation route is unavailable",
    httpStatus: 503,
    closeCode: 1011,
  });
}

describe("GatewayBridgeSessionAuthority live document routing", () => {
  const authorities: GatewayBridgeSessionAuthority[] = [];

  async function authority(): Promise<GatewayBridgeSessionAuthority> {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    authorities.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(authorities.splice(0).map(async (created) => created.close()));
  });

  it("separates connection and session grants and quarantines unavailable result capabilities", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({
        connectionCapabilities: [
          "journal_v1",
          "transport_streamable_http",
          "chunked_results",
          "artifact_result_v1",
        ],
        sessionCapabilities: [
          "batch_atomic",
          "doc_context_cached_v1",
          "partial_progress",
        ],
      }),
    );
    authorities.push(created);
    await created.open();
    const openedChannel = channel();
    const connectionHello = hello();
    connectionHello.payload.capabilities = [
      "journal_v1",
      "transport_streamable_http",
      "partial_progress",
      "chunked_results",
      "artifact_result_v1",
    ];
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: connectionHello,
      channel: openedChannel,
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual([
      "journal_v1",
      "transport_streamable_http",
    ]);

    const registrationFrame = registration("capability-separation");
    registrationFrame.payload.session_capabilities = [
      "batch_atomic",
      "doc_context_cached_v1",
      "partial_progress",
      "journal_v1",
    ];
    await created.receive(opened.connectionId, registrationFrame);
    expect(registeredFrame(openedChannel).payload.granted_session_capabilities).toEqual([
      "batch_atomic",
      "doc_context_cached_v1",
    ]);
  });

  it("grants the complete provisioned HTTP carrier and session capability sets", async () => {
    const fixture = createRestartableTestStore();
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: createMemoryObjectStore(),
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({
        connectionCapabilities: [
          "journal_v1",
          "transport_streamable_http",
          "chunked_results",
          "artifact_result_v1",
        ],
        sessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
      }),
      { resourceAuthority: resources },
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = [
      "journal_v1",
      "transport_streamable_http",
      "chunked_results",
      "artifact_result_v1",
    ];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "http_sse",
      hello: offered,
      channel: openedChannel,
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual([
      "journal_v1",
      "chunked_results",
      "artifact_result_v1",
      "transport_streamable_http",
    ]);
    const register = registration("http-full-grants");
    register.payload.session_capabilities = [
      "batch_atomic",
      "doc_context_cached_v1",
    ];
    await created.receive(opened.connectionId, register);
    expect(registeredFrame(openedChannel).payload.granted_session_capabilities).toEqual([
      "batch_atomic",
      "doc_context_cached_v1",
    ]);
  });

  it("grants carrier capabilities only to an exact-store ready authority", async () => {
    const fixture = createRestartableTestStore();
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: createMemoryObjectStore(),
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({
        connectionCapabilities: ["chunked_results", "artifact_result_v1"],
      }),
      { resourceAuthority: resources },
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = ["chunked_results", "artifact_result_v1"];
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: offered,
      channel: channel(),
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual([
      "chunked_results",
      "artifact_result_v1",
    ]);

    const mismatched = createRestartableTestStore();
    const unready = new GatewayBridgeSessionAuthority(
      mismatched.store,
      identity({ connectionCapabilities: ["chunked_results", "artifact_result_v1"] }),
      { resourceAuthority: resources },
    );
    authorities.push(unready);
    await unready.open();
    const denied = await unready.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: offered,
      channel: channel(),
    });
    expect(denied.helloAck.payload.granted_capabilities).toEqual([]);
  });

  it.each(["wss", "http_sse"] as const)(
    "keeps a chunked result private until Tx-C commits through the shared %s handler",
    async (binding) => {
      const fixture = createRestartableTestStore();
      const objects = createMemoryObjectStore();
      const resources = new GatewayResourceAuthority({
        protocolStore: fixture.store,
        objectStore: objects,
      });
      const created = new GatewayBridgeSessionAuthority(
        fixture.store,
        identity({ connectionCapabilities: ["chunked_results", "transport_streamable_http"] }),
        { resourceAuthority: resources },
      );
      authorities.push(created);
      await created.open();
      const offered = hello();
      offered.payload.capabilities = ["chunked_results", "transport_streamable_http"];
      const openedChannel = channel();
      const opened = await created.openConnection({
        deviceToken: DEVICE_TOKEN,
        binding,
        hello: offered,
        channel: openedChannel,
      });
      await created.receive(opened.connectionId, registration("chunked-carrier"));
      const session = registeredFrame(openedChannel);
      const invocationId = id();
      const request = bridgeRequest(session.payload.rsid, invocationId);
      const outcome = created.createExecutor().execute(request);
      const invoke = await emittedInvoke(openedChannel);
      const bytes = Buffer.from('{"carrier":"complete"}', "utf8");
      const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

      await created.receive(opened.connectionId, {
        v: 1,
        type: "partial",
        id: id(),
        rsid: session.payload.rsid,
        seq: 1,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "chunk",
          invocation_id: invocationId,
          stream_id: "result",
          chunk_index: 0,
          encoding: "base64",
          content_type: "application/json",
          data: bytes.toString("base64"),
        },
      });
      expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);

      await created.receive(opened.connectionId, {
        v: 1,
        type: "result",
        id: id(),
        rsid: session.payload.rsid,
        seq: 2,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation",
          invocation_id: invocationId,
          status: "completed",
          replayed: false,
          chunked: true,
          stream_id: "result",
          content_type: "application/json",
          total_chunks: 1,
          total_size: bytes.byteLength,
          sha256,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: bytes.byteLength, framing: "length-prefixed" },
        },
      });
      await expect(outcome).resolves.toEqual({ state: "completed", result: { carrier: "complete" } });
      expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "terminal_accepted")).toHaveLength(1);
    },
  );

  it("commits an artifact carrier's receipt, terminal, and bridge completion in Tx-B/Tx-C", async () => {
    const fixture = createRestartableTestStore();
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: createMemoryObjectStore(),
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["chunked_results", "artifact_result_v1"] }),
      { resourceAuthority: resources },
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = ["chunked_results", "artifact_result_v1"];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: offered,
      channel: openedChannel,
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual([
      "chunked_results",
      "artifact_result_v1",
    ]);
    await created.receive(opened.connectionId, registration("artifact-carrier"));
    const session = registeredFrame(openedChannel);
    const invocationId = id();
    const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
    const invoke = await emittedInvoke(openedChannel);
    const artifactId = "0197a3c2-0000-7000-8000-000000000911";
    const bytes = Buffer.from([9, 1, 1]);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    await created.receive(opened.connectionId, {
      v: 1,
      type: "partial",
      id: id(),
      rsid: session.payload.rsid,
      seq: 1,
      ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "chunk",
        invocation_id: invocationId,
        stream_id: `artifact:${artifactId}`,
        artifact_id: artifactId,
        artifact_index: 0,
        chunk_index: 0,
        encoding: "base64",
        content_type: "image/png",
        data: bytes.toString("base64"),
      },
    });
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "chunk_durable")).toHaveLength(1);

    await created.receive(opened.connectionId, {
      v: 1,
      type: "result",
      id: id(),
      rsid: session.payload.rsid,
      seq: 2,
      ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "invocation",
        invocation_id: invocationId,
        status: "completed",
        replayed: false,
        chunked: true,
        result: { artifact_id: artifactId, artifact_index: 0 },
        artifacts: [{
          artifact_id: artifactId,
          artifact_index: 0,
          stream_id: `artifact:${artifactId}`,
          filename: "proof.png",
          content_type: "image/png",
          total_chunks: 1,
          total_size: bytes.byteLength,
          sha256,
        }],
        metrics: { execute_ms: 1, request_bytes: 1, response_bytes: bytes.byteLength, framing: "length-prefixed" },
      },
    });
    await expect(outcome).resolves.toEqual({
      state: "completed",
      result: { artifact_id: artifactId, artifact_index: 0 },
    });
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toHaveLength(1);
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "terminal_accepted")).toHaveLength(1);
  });

  it("denies an artifact partial before any carrier side effect without artifact_result_v1", async () => {
    const fixture = createRestartableTestStore();
    const objects = createMemoryObjectStore();
    const resources = new GatewayResourceAuthority({ protocolStore: fixture.store, objectStore: objects });
    const tailEvents: Array<{ stage: string; queuedBytes: number }> = [];
    const options = { resourceAuthority: resources };
    Object.defineProperty(options, TEST_RSID_CARRIER_RECEIVE_TAIL_OBSERVER, {
      value: (event: { readonly stage: string; readonly queuedBytes: number }) => {
        tailEvents.push({ stage: event.stage, queuedBytes: event.queuedBytes });
      },
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["chunked_results"] }),
      options,
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = ["chunked_results", "artifact_result_v1"];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN, binding: "wss", hello: offered, channel: openedChannel,
    });
    expect(opened.helloAck.payload.granted_capabilities).toEqual(["chunked_results"]);
    await created.receive(opened.connectionId, registration("artifact-capability-denied"));
    const session = registeredFrame(openedChannel);
    const invocationId = id();
    void created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
    const invoke = await emittedInvoke(openedChannel);
    const artifactId = "0197a3c2-0000-7000-8000-000000000912";
    await expect(created.receive(opened.connectionId, {
      v: 1, type: "partial", id: id(), rsid: session.payload.rsid, seq: 1, ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "chunk", invocation_id: invocationId, stream_id: `artifact:${artifactId}`,
        artifact_id: artifactId, artifact_index: 0, chunk_index: 0, encoding: "base64",
        content_type: "image/png", data: Buffer.from([1]).toString("base64"),
      },
    })).rejects.toMatchObject({ code: "unsupported", httpStatus: 403 });
    expect(objects.keys()).toEqual([]);
    expect(fixture.snapshot().records.filter((row) =>
      row.namespace === "gateway_resource_v1" ||
      row.namespace.startsWith("gateway.carrier") ||
      row.namespace === "gateway.resource-set/v1",
    )).toEqual([]);
    expect(tailEvents).toEqual([{ stage: "denied_prequeue", queuedBytes: 0 }]);

    // The rejected artifact did not consume seq=1: a result-only chunk with
    // the same sequence is accepted under the independently granted chunk cap.
    await expect(created.receive(opened.connectionId, {
      v: 1, type: "partial", id: id(), rsid: session.payload.rsid, seq: 1, ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "chunk", invocation_id: invocationId, stream_id: "result", chunk_index: 0,
        encoding: "base64", content_type: "application/json", data: Buffer.from("{}").toString("base64"),
      },
    })).resolves.toBeUndefined();
    expect(fixture.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1")).toHaveLength(1);
    expect(tailEvents).toEqual([
      { stage: "denied_prequeue", queuedBytes: 0 },
      { stage: "tail_installed", queuedBytes: 2 },
      { stage: "tail_released", queuedBytes: 0 },
    ]);
  });

  it("caps each rsid carrier tail at 8 MiB while keeping a heartbeat serviceable", async () => {
    const fixture = createRestartableTestStore();
    const baseObjects = createMemoryObjectStore();
    let releasePut!: () => void;
    const putsReleased = new Promise<void>((resolve) => { releasePut = resolve; });
    const resources = new GatewayResourceAuthority({
      protocolStore: fixture.store,
      objectStore: {
        ...baseObjects,
        async put(input) {
          await putsReleased;
          return baseObjects.put(input);
        },
      },
    });
    const created = new GatewayBridgeSessionAuthority(
      fixture.store,
      identity({ connectionCapabilities: ["chunked_results"] }),
      { resourceAuthority: resources },
    );
    authorities.push(created);
    await created.open();
    const offered = hello();
    offered.payload.capabilities = ["chunked_results"];
    const openedChannel = channel();
    const opened = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: offered,
      channel: openedChannel,
    });
    await created.receive(opened.connectionId, registration("carrier-tail"));
    const session = registeredFrame(openedChannel);
    const invocationId = id();
    void created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
    const invoke = await emittedInvoke(openedChannel);
    const megabyte = Buffer.alloc(1024 * 1024, 7).toString("base64");
    const queued = Array.from({ length: 8 }, (_, index) =>
      created.receive(opened.connectionId, {
        v: 1,
        type: "partial",
        id: id(),
        rsid: session.payload.rsid,
        seq: index + 1,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "chunk",
          invocation_id: invocationId,
          stream_id: "result",
          chunk_index: index,
          encoding: "base64",
          content_type: "application/json",
          data: megabyte,
        },
      }),
    );
    await expect(created.receive(opened.connectionId, {
      v: 1,
      type: "partial",
      id: id(),
      rsid: session.payload.rsid,
      seq: 9,
      ack: invoke.seq,
      ts: new Date().toISOString(),
      payload: {
        kind: "chunk",
        invocation_id: invocationId,
        stream_id: "result",
        chunk_index: 8,
        encoding: "base64",
        content_type: "application/json",
        data: megabyte,
      },
    })).rejects.toMatchObject({ code: "unavailable", closeCode: 1013 });
    await expect(created.receive(opened.connectionId, {
      v: 1,
      type: "heartbeat",
      id: id(),
      ts: new Date().toISOString(),
      payload: { bridge_version: "m4-route-test", acks: [], sessions: [] },
    })).resolves.toBeUndefined();
    expect(openedChannel.frames.some((frame) => frame.type === "heartbeat_ack")).toBe(true);
    releasePut();
    await expect(Promise.all(queued)).resolves.toHaveLength(8);
  });

  it("refuses routing until an accepted document context identifies one active document", async () => {
    const created = await authority();
    await register(created);

    expectUnavailable(created);
  });

  it("routes an empty registration after its first accepted document context update", async () => {
    const created = await authority();
    const session = await register(created);

    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-live",
        documents: [document("document-live", true)],
      }),
    );

    expect(resolve(created)).toEqual({
      tenantId: TENANT_ID,
      mcpSessionId: MCP_SESSION_ID,
      effectiveMcpRequestScope: expect.objectContaining({
        principalKey: `${TENANT_ID}:${USER_ID}`,
        effectiveMcpSessionId: MCP_SESSION_ID,
      }),
      rsid: session.rsid,
      documentIdentity: {
        kind: "live",
        session_document_id: "document-live",
      },
    });
    expect(resolve(created).principalKey).toBe(`${TENANT_ID}:${USER_ID}`);
  });

  it.each(["wss", "http_sse"] as const)(
    "persists the %s document route before the next heartbeat-driven acknowledgement",
    async (binding) => {
      const fixture = createRestartableTestStore();
      const observations: Array<{ readonly stage: string; readonly sequence: number; readonly contextDigest: string }> = [];
      const created = new GatewayBridgeSessionAuthority(fixture.store, identity(
        binding === "http_sse"
          ? { connectionCapabilities: ["transport_streamable_http"] }
          : {},
      ), {
        onDocumentContextObservation: (observation) => observations.push(observation),
      });
      authorities.push(created);
      await created.open();
      const openedChannel = channel();
      const offered = hello();
      if (binding === "http_sse") {
        offered.payload.capabilities = ["partial_progress", "transport_streamable_http"];
      }
      const opened = await created.openConnection({
        deviceToken: DEVICE_TOKEN,
        binding,
        hello: offered,
        channel: openedChannel,
      });
      await created.receive(opened.connectionId, registration(`route-before-ack-${binding}`));
      const registered = registeredFrame(openedChannel);
      const session = {
        connectionId: opened.connectionId,
        channel: openedChannel,
        rsid: registered.payload.rsid,
      };

      await created.receive(session.connectionId, contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-route-before-ack",
        documents: [document("document-route-before-ack", true)],
      }));

      // This is the public route authority, independently visible before the
      // worker emits its later heartbeat fence acknowledgement.
      expect(resolve(created).documentIdentity).toEqual({
        kind: "live",
        session_document_id: "document-route-before-ack",
      });
      expect(observations).toEqual([expect.objectContaining({
        stage: "accepted", sequence: 1, contextDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      })]);
      expect(session.channel.frames.filter((frame) => frame.type === "heartbeat_ack")).toEqual([]);

      await created.receive(session.connectionId, {
        v: 1,
        type: "heartbeat",
        id: id(),
        ts: new Date().toISOString(),
        payload: { bridge_version: "m4-route-test", acks: [], sessions: [] },
      });
      expect(session.channel.frames.filter((frame) => frame.type === "heartbeat_ack")).toHaveLength(1);
    },
  );

  it("does not journal a rejected document update without route or acknowledgement", async () => {
    const fixture = createRestartableTestStore();
    const observations: Array<{ readonly stage: string; readonly sequence: number; readonly contextDigest: string }> = [];
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity(), {
      onDocumentContextObservation: (observation) => observations.push(observation),
    });
    authorities.push(created);
    await created.open();
    const session = await register(created, "document-route-rejected");

    await expect(created.receive(session.connectionId, contextUpdate({
      rsid: session.rsid,
      seq: 1,
      activeDocument: "document-a",
      documents: [document("document-a", true), document("document-b", true)],
    }))).rejects.toMatchObject({ code: "protocol", httpStatus: 400 });

    expect(observations).toEqual([]);
    expectUnavailable(created);
    expect(session.channel.frames.filter((frame) => frame.type === "heartbeat_ack")).toEqual([]);
  });

  it("clears the live route when a later accepted context has no active document", async () => {
    const created = await authority();
    const session = await register(created);
    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-live",
        documents: [document("document-live", true)],
      }),
    );

    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 2,
        activeDocument: null,
        documents: [document("document-live", false)],
      }),
    );

    expectUnavailable(created);
  });

  it("rejects inconsistent or ambiguous active-document state without replacing the last route", async () => {
    const created = await authority();
    const session = await register(created);
    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-live",
        documents: [document("document-live", true)],
      }),
    );

    await expect(
      created.receive(
        session.connectionId,
        contextUpdate({
          rsid: session.rsid,
          seq: 2,
          activeDocument: "document-live",
          documents: [
            document("document-live", true),
            document("document-other", true),
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "protocol",
      message: "document context is inconsistent",
      httpStatus: 400,
      closeCode: 4400,
    });
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-live",
    });

    await expect(
      created.receive(
        session.connectionId,
        contextUpdate({
          rsid: session.rsid,
          seq: 2,
          activeDocument: "document-live",
          documents: [
            document("document-live", true),
            document("document-live", false),
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: "protocol",
      message: "document context is inconsistent",
    });
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-live",
    });
  });

  it("keeps duplicate sequence handling idempotent and rejects conflicting reuse", async () => {
    const created = await authority();
    const session = await register(created);
    const accepted = contextUpdate({
      rsid: session.rsid,
      seq: 1,
      activeDocument: "document-live",
      documents: [document("document-live", true)],
    });
    await created.receive(session.connectionId, accepted);

    await created.receive(session.connectionId, accepted);
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-live",
    });

    await expect(
      created.receive(
        session.connectionId,
        contextUpdate({
          rsid: session.rsid,
          seq: 1,
          activeDocument: "document-other",
          documents: [document("document-other", true)],
        }),
      ),
    ).rejects.toBeInstanceOf(GatewayRbpFault);
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-live",
    });
  });

  it("requires a fresh current-connection context after resume", async () => {
    const created = await authority();
    const session = await register(created);
    await created.receive(
      session.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 1,
        activeDocument: "document-before-resume",
        documents: [document("document-before-resume", true)],
      }),
    );
    await created.detach(session.connectionId);

    const resumedConnection = await openConnection(created);
    await created.receive(resumedConnection.connectionId, {
      v: 1,
      type: "session_resume",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        rsid: session.rsid,
        resume_token: session.resumeToken,
        last_rx_seq: 0,
      },
    });

    expectUnavailable(created);

    await created.receive(
      resumedConnection.connectionId,
      contextUpdate({
        rsid: session.rsid,
        seq: 2,
        activeDocument: "document-after-resume",
        documents: [document("document-after-resume", true)],
      }),
    );
    expect(resolve(created).documentIdentity).toEqual({
      kind: "live",
      session_document_id: "document-after-resume",
    });
  });

  it("refuses an ambiguous identity with multiple matching live sessions", async () => {
    const created = await authority();
    const first = await register(created, "local-route-first");
    const second = await register(created, "local-route-second");
    await created.receive(
      first.connectionId,
      contextUpdate({
        rsid: first.rsid,
        seq: 1,
        activeDocument: "document-first",
        documents: [document("document-first", true)],
      }),
    );
    await created.receive(
      second.connectionId,
      contextUpdate({
        rsid: second.rsid,
        seq: 1,
        activeDocument: "document-second",
        documents: [document("document-second", true)],
      }),
    );

    expectUnavailable(created);
  });

  it("fences a blocked resume send at phase one without holding another rsid", async () => {
    const fixture = createRestartableTestStore();
    let nowMs = 1_775_000_100_000;
    const drainEntered = deferred();
    const releaseDrain = deferred();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity(), {
      clock: () => nowMs,
      wait: async () => {
        drainEntered.resolve();
        await releaseDrain.promise;
        nowMs += 5_000;
      },
    });
    authorities.push(created);
    await created.open();
    const original = await register(created, "lock-scope-original");
    await created.detach(original.connectionId);

    const resumeStarted = deferred();
    const releaseResume = deferred();
    const blocked = channel();
    const send = blocked.send.bind(blocked);
    blocked.send = async (serialized): Promise<void> => {
      const frame = JSON.parse(serialized) as RbpEnvelope;
      if (frame.type === "resume_ack") {
        resumeStarted.resolve();
        await releaseResume.promise;
      }
      await send(serialized);
    };
    const replacement = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: hello(),
      channel: blocked,
    });
    const resuming = created.receive(replacement.connectionId, {
      v: 1,
      type: "session_resume",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        rsid: original.rsid,
        resume_token: original.resumeToken,
        last_rx_seq: 0,
      },
    });
    await resumeStarted.promise;

    const revoker = await created.openConnection({
      deviceToken: DEVICE_TOKEN,
      binding: "wss",
      hello: hello(),
      channel: channel(),
    });
    const unregistering = created.receive(revoker.connectionId, {
      v: 1,
      type: "session_unregister",
      id: id(),
      ts: new Date().toISOString(),
      payload: { rsid: original.rsid, reason: "revit_exited" },
    });
    await drainEntered.promise;

    const egress = fixture.snapshot().records.find((row) =>
      row.namespace === "gateway.rbp-session-egress/v2" &&
      typeof row.value === "object" && row.value !== null &&
      "rsid" in row.value && row.value.rsid === original.rsid,
    );
    expect(egress?.value).toMatchObject({
      fence: {
        state: "revocation_pending",
        lease: { operation: "resume_ack", phase: "started" },
      },
    });

    // A distinct rsid is never queued behind the blocked carrier's tail.
    const other = await register(created, "lock-scope-other");
    expect(other.rsid).not.toBe(original.rsid);

    releaseResume.resolve();
    await expect(resuming).rejects.toMatchObject({
      code: "unavailable",
      message: "dispatch completed after durable revocation",
    });
    releaseDrain.resolve();
    await expect(unregistering).resolves.toBeUndefined();
    expect(blocked.frames.filter((frame) => frame.type === "resume_ack")).toHaveLength(1);
  });
});

describe("Gateway dispatch proof nominal authority", () => {
  it("rejects a forged or foreign proof while JCS-equivalent route material remains stable", () => {
    const first = createGatewayDispatchProofAuthority();
    const second = createGatewayDispatchProofAuthority();
    const material = {
      tenantId: "tenant-route", rsid: "rsid-route", effectiveMcpSessionId: "mcp-route",
      sessionBindingId: "binding-route", connectionId: "connection-route",
      routeSnapshot: { b: 2, a: 1 }, documentHash: "sha256:" + "a".repeat(64),
      documentSequence: 2, documentAck: 1, gatewayProcessEpoch: "epoch-route",
      gatewayProcessOrdinal: 4, effectiveScope: { principalKey: "p", effectiveMcpSessionId: "mcp-route" },
      invocationId: "invoke-route", correlationId: "invoke-route",
      envelopeDigest: ("sha256:" + "b".repeat(64)) as `sha256:${string}`,
      toolName: "route_tool", toolVersion: "1", argsDigest: ("sha256:" + "c".repeat(64)) as `sha256:${string}`,
      policy: { decision: "auto" }, confirmationId: null,
    };
    const proof = first.mint(material);
    expect(first.digest(proof)).toMatch(/^sha256:/u);
    expect(first.routeSnapshotDigest(proof)).toBe(first.routeSnapshotDigest(proof));
    expect(() => second.assert(proof)).toThrow(/not owned/u);
    expect(() => first.assert(Object.freeze({}))).toThrow(/not owned/u);
    expect(first.digest(first.mint({ ...material, routeSnapshot: { a: 1, b: 2 } })))
      .toBe(first.digest(proof));
    expect(first.digest(first.mint({ ...material, toolName: "changed" })))
      .not.toBe(first.digest(proof));
  });
});

describe("Gateway omitted-payload recovery admission", () => {
  it("denies an inline terminal without an explicit omission marker", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    try {
      const opened = await openConnection(created);
      await created.receive(opened.connectionId, registration("inline-terminal"));
      const session = registeredFrame(opened.channel);
      const invocationId = id();
      const originResultDigest = `sha256:${"c".repeat(64)}` as const;
      const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
      const invoke = await emittedInvoke(opened.channel);
      await created.receive(opened.connectionId, {
        v: 1, type: "result", id: id(), rsid: session.payload.rsid, seq: 1, ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation", invocation_id: invocationId, status: "completed", replayed: false,
          result: { inline: true }, result_digest: originResultDigest,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 1, framing: "length-prefixed" },
        },
      });
      await expect(outcome).resolves.toEqual({ state: "completed", result: { inline: true } });
      const root = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid);
      const binding = (root?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } }).binding;
      if (binding?.sessionBindingId === undefined || binding.sessionVersion === undefined) throw new Error("missing fixture binding");
      await expect(created.admitOmittedPayloadRecovery({
        tenantId: TENANT_ID, userId: USER_ID, effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid, sessionBindingId: binding.sessionBindingId,
        sessionVersion: binding.sessionVersion, originInvocationId: invocationId, originResultDigest,
      })).resolves.toEqual({ kind: "guarded" });
    } finally {
      await created.close();
    }
  });

  it("fails closed when retained omitted-terminal evidence is corrupted", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    try {
      const opened = await openConnection(created);
      await created.receive(opened.connectionId, registration("corrupt-omitted-evidence"));
      const session = registeredFrame(opened.channel);
      const invocationId = id();
      const originResultDigest = `sha256:${"d".repeat(64)}` as const;
      const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
      const invoke = await emittedInvoke(opened.channel);
      await created.receive(opened.connectionId, {
        v: 1, type: "result", id: id(), rsid: session.payload.rsid, seq: 1, ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation", invocation_id: invocationId, status: "completed", replayed: true,
          payload_omitted: true, result_digest: originResultDigest,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 0, framing: "length-prefixed" },
        },
      });
      await outcome;
      const root = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid);
      const binding = (root?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } }).binding;
      const evidence = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session-evidence/v2" && row.key.startsWith(`${session.payload.rsid}/`));
      if (binding?.sessionBindingId === undefined || binding.sessionVersion === undefined || evidence === undefined) throw new Error("missing omitted fixture evidence");
      await fixture.store.transact({ tenantId: TENANT_ID }, async (tx) => {
        tx.stage({ namespace: evidence.namespace, key: evidence.key, value: {}, expect: { kind: "version", version: evidence.version } });
      });
      await expect(created.admitOmittedPayloadRecovery({
        tenantId: TENANT_ID, userId: USER_ID, effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid, sessionBindingId: binding.sessionBindingId,
        sessionVersion: binding.sessionVersion, originInvocationId: invocationId, originResultDigest,
      })).resolves.toEqual({ kind: "guarded" });
    } finally {
      // The deliberately corrupt durable child also makes shutdown fail closed.
      await created.close().catch(() => undefined);
    }
  });

  it("admits only a genuine omitted terminal for its authenticated current owner and never re-executes origin", async () => {
    const fixture = createRestartableTestStore();
    const created = new GatewayBridgeSessionAuthority(fixture.store, identity());
    await created.open();
    try {
      const opened = await openConnection(created);
      await created.receive(opened.connectionId, registration("omitted-payload"));
      const session = registeredFrame(opened.channel);
      const invocationId = id();
      const originResultDigest = `sha256:${"a".repeat(64)}` as const;
      const outcome = created.createExecutor().execute(bridgeRequest(session.payload.rsid, invocationId));
      const invoke = await emittedInvoke(opened.channel);
      await created.receive(opened.connectionId, {
        v: 1,
        type: "result",
        id: id(),
        rsid: session.payload.rsid,
        seq: 1,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation",
          invocation_id: invocationId,
          status: "completed",
          replayed: true,
          payload_omitted: true,
          result_digest: originResultDigest,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 0, framing: "length-prefixed" },
        },
      });
      await expect(outcome).resolves.toEqual({ state: "completed", result: null });
      const root = fixture.snapshot().records.find((row) =>
        row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid,
      );
      const binding = root?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } };
      expect(binding.binding).toMatchObject({ sessionVersion: 1 });
      const sessionBinding = binding.binding;
      if (sessionBinding?.sessionBindingId === undefined || sessionBinding.sessionVersion === undefined) {
        throw new Error("fixture omitted the current bridge session binding");
      }
      const terminalEvidence = fixture.snapshot().records.find((row) =>
        row.namespace === "gateway.rbp-session-evidence/v2" && row.key.startsWith(`${session.payload.rsid}/`),
      );
      expect(terminalEvidence?.value).toMatchObject({ entry: {
        effectiveMcpSessionId: MCP_SESSION_ID,
        terminalInvocationId: invocationId,
        terminalTruth: { payloadRetained: false, resultDigest: originResultDigest },
      } });
      const input = {
        tenantId: TENANT_ID,
        userId: USER_ID,
        effectiveMcpSessionId: MCP_SESSION_ID,
        rsid: session.payload.rsid,
        sessionBindingId: sessionBinding.sessionBindingId,
        sessionVersion: sessionBinding.sessionVersion,
        originInvocationId: invocationId,
        originResultDigest,
      };
      const claims = await Promise.all(Array.from({ length: 8 }, async () =>
        await created.admitOmittedPayloadRecovery(input),
      ));
      expect(claims.map((claim) => claim.kind).sort()).toEqual([
        "admitted", "resume", "resume", "resume", "resume", "resume", "resume", "resume",
      ]);
      await expect(created.admitOmittedPayloadRecovery({ ...input, userId: "foreign" }))
        .resolves.toEqual({ kind: "guarded" });
      await expect(created.admitOmittedPayloadRecovery({ ...input, originResultDigest: `sha256:${"b".repeat(64)}` }))
        .resolves.toEqual({ kind: "guarded" });
      expect(opened.channel.frames.filter((frame) => frame.type === "invoke")).toHaveLength(1);
      await created.detach(opened.connectionId);
      await expect(created.admitOmittedPayloadRecovery(input)).resolves.toEqual({ kind: "guarded" });
      const rebound = await openConnection(created);
      await created.receive(rebound.connectionId, {
        v: 1,
        type: "session_resume",
        id: id(),
        ts: new Date().toISOString(),
        payload: { rsid: session.payload.rsid, resume_token: session.payload.resume_token, last_rx_seq: 1 },
      });
      await expect(created.admitOmittedPayloadRecovery(input)).resolves.toEqual({ kind: "guarded" });
      const reboundRoot = fixture.snapshot().records.find((row) => row.namespace === "gateway.rbp-session/v2" && row.key === session.payload.rsid);
      const reboundBinding = (reboundRoot?.value as { binding?: { sessionBindingId?: string; sessionVersion?: number } }).binding;
      if (reboundBinding?.sessionBindingId === undefined || reboundBinding.sessionVersion === undefined) throw new Error("missing rebound fixture binding");
      await expect(created.admitOmittedPayloadRecovery({
        ...input, sessionBindingId: reboundBinding.sessionBindingId, sessionVersion: reboundBinding.sessionVersion,
      })).resolves.toEqual({ kind: "guarded" });
      await created.receive(rebound.connectionId, {
        v: 1,
        type: "session_unregister",
        id: id(),
        ts: new Date().toISOString(),
        payload: { rsid: session.payload.rsid, reason: "operator_requested" },
      });
      await expect(created.admitOmittedPayloadRecovery(input)).resolves.toEqual({ kind: "guarded" });
    } finally {
      await created.close();
    }
  });
});
