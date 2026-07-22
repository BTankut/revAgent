import type { RbpEnvelope } from "@revagent/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startGatewayStub } from "../src/server.js";
import type {
  GatewayStubHandle,
  GatewayStubServerOptions,
} from "../src/types.js";
import {
  controlEnvelope,
  hello,
  readInvoke,
  resultEnvelope,
  sessionRegister,
  statePath,
  TOKEN,
  tokenTable,
  uuid7,
} from "./helpers.js";

interface Peer {
  readonly helloAck: RbpEnvelope;
  send(envelope: RbpEnvelope): Promise<void>;
  next(): Promise<RbpEnvelope>;
  close(): Promise<void>;
}

const handles: GatewayStubHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close();
  }
});

async function start(
  name: string,
  overrides: Partial<GatewayStubServerOptions> = {},
): Promise<GatewayStubHandle> {
  const handle = await startGatewayStub({
    statePath: await statePath(name),
    tokenTable,
    livenessSweepMs: 0,
    ...overrides,
  });
  handles.push(handle);
  return handle;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Gateway state");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function openRawWebSocket(handle: GatewayStubHandle): Promise<WebSocket> {
  const socket = new WebSocket(handle.wsUrl, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-rbp-versions": "1",
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function nextRawMessage(socket: WebSocket): Promise<RbpEnvelope> {
  return new Promise<RbpEnvelope>((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as RbpEnvelope));
    socket.once("error", reject);
  });
}

async function nextCloseCode(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    socket.once("close", (code) => resolve(code));
  });
}

async function websocketPeer(handle: GatewayStubHandle): Promise<Peer> {
  const socket = new WebSocket(handle.wsUrl, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-rbp-versions": "1",
    },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const queued: RbpEnvelope[] = [];
  const waiters: Array<(value: RbpEnvelope) => void> = [];
  socket.on("message", (data) => {
    const envelope = JSON.parse(data.toString()) as RbpEnvelope;
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(envelope);
    else waiter(envelope);
  });
  const next = async (): Promise<RbpEnvelope> => {
    const available = queued.shift();
    if (available !== undefined) return available;
    return new Promise<RbpEnvelope>((resolve) => waiters.push(resolve));
  };
  socket.send(JSON.stringify(hello()));
  const helloAck = await next();
  return {
    helloAck,
    async send(envelope): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        socket.send(JSON.stringify(envelope), (error) =>
          error === undefined || error === null ? resolve() : reject(error));
      });
    },
    next,
    async close(): Promise<void> {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.close();
      });
    },
  };
}

async function ssePeer(handle: GatewayStubHandle): Promise<Peer> {
  const created = await fetch(handle.httpConnectionUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "x-rbp-versions": "1",
    },
    body: JSON.stringify(hello()),
  });
  expect(created.status).toBe(201);
  const helloAck = await created.json() as RbpEnvelope;
  const connectionId = created.headers.get("rbp-connection-id");
  if (connectionId === null) throw new Error("fallback create omitted RBP-Connection-Id");

  const abort = new AbortController();
  const events = await fetch(`${handle.httpConnectionUrl}/${encodeURIComponent(connectionId)}/events`, {
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    },
    signal: abort.signal,
  });
  expect(events.status).toBe(200);
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const next = async (): Promise<RbpEnvelope> => {
    while (true) {
      const separator = buffered.indexOf("\n\n");
      if (separator >= 0) {
        const event = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        const data = event.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data !== undefined) return JSON.parse(data) as RbpEnvelope;
      }
      const read = await reader.read();
      if (read.done) throw new Error("SSE stream ended before the next RBP event");
      buffered += decoder.decode(read.value, { stream: true }).replaceAll("\r\n", "\n");
    }
  };

  return {
    helloAck,
    async send(envelope): Promise<void> {
      const response = await fetch(`${handle.httpConnectionUrl}/${encodeURIComponent(connectionId)}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(envelope),
      });
      if (response.status !== 202) {
        throw new Error(`fallback uplink returned ${response.status}: ${await response.text()}`);
      }
    },
    next,
    async close(): Promise<void> {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

for (const [binding, connect] of [
  ["WSS", websocketPeer],
  ["HTTP/SSE", ssePeer],
] as const) {
  describe(`${binding} binding`, () => {
    it("runs the same hello, registration, dispatch, ack, and terminal semantics", async () => {
      const handle = await start(`binding-${binding.toLowerCase().replaceAll("/", "-")}`);
      const peer = await connect(handle);
      try {
        expect(peer.helloAck).toMatchObject({
          type: "hello_ack",
          payload: { protocol: 1 },
        });
        expect("v" in peer.helloAck).toBe(false);

        await peer.send(controlEnvelope("session_register", sessionRegister(), 10));
        const registered = await peer.next() as Extract<RbpEnvelope, { type: "session_registered" }>;
        expect(registered.type).toBe("session_registered");
        const rsid = registered.payload.rsid;
        const invocationId = uuid7(binding === "WSS" ? 110 : 111);

        const dispatched = await handle.core.dispatchInvoke({
          rsid,
          payload: readInvoke(invocationId),
        });
        expect(await peer.next()).toEqual(dispatched);
        await peer.send(resultEnvelope(rsid, invocationId));
        await waitFor(() => handle.core.snapshot().sessions[rsid]?.inFlight === null);

        const session = handle.core.snapshot().sessions[rsid]!;
        expect(session.sequence).toMatchObject({ lastRxSeq: 1, lastPeerAck: 1 });
        expect(session.sequence.outbox).toEqual([]);
        expect(session.dispatchWindow.active).toEqual([]);
        expect(session.terminalOutcomes[invocationId]).toMatchObject({
          classification: "result",
        });
        await peer.close();
        await waitFor(() => handle.core.snapshot().sessions[rsid]?.liveness === "disconnected");
        expect(handle.core.snapshot().sessions[rsid]!.lifecycle.dispatchAllowed).toBe(false);
      } finally {
        await peer.close();
      }
    });
  });
}

describe("opening and proxy fault controls", () => {
  it("injects exact HTTP opening errors with Retry-After and buffers SSE until explicitly flushed", async () => {
    const handle = await start("fault-controls");
    handle.core.faults.enqueueOpening({
      binding: "http_sse",
      status: 503,
      retryAfter: "7",
    });
    const refused = await fetch(handle.httpConnectionUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-rbp-versions": "1",
      },
      body: JSON.stringify(hello()),
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("7");

    const peer = await ssePeer(handle);
    let resumedPeer: Peer | null = null;
    try {
      await peer.send(controlEnvelope("session_register", sessionRegister(), 11));
      const registered = await peer.next() as Extract<RbpEnvelope, { type: "session_registered" }>;
      const rsid = registered.payload.rsid;
      const resumeToken = registered.payload.resume_token;
      const connectionId = peer.helloAck.payload.connection_id as string;
      handle.core.faults.setSseBuffering(connectionId, true);
      const dispatched = await handle.core.dispatchInvoke({
        rsid,
        payload: readInvoke(uuid7(112)),
      });
      expect(handle.core.snapshot().runtime).toMatchObject({ heldOutboundFrames: 1 });
      expect(await handle.core.faults.flushHeld(connectionId)).toBe(1);
      expect(await peer.next()).toEqual(dispatched);
      expect(handle.core.snapshot().runtime).toMatchObject({ heldOutboundFrames: 0 });

      handle.core.faults.enqueueFrame({
        direction: "bridge_to_gateway",
        binding: "http_sse",
        action: "drop",
        messageType: "result",
      });
      const terminal = resultEnvelope(rsid, uuid7(112));
      await expect(peer.send(terminal)).rejects.toThrow();
      expect(handle.core.snapshot().sessions[rsid]).toMatchObject({
        inFlight: { correlationId: uuid7(112) },
        sequence: { lastRxSeq: 0 },
        liveness: "disconnected",
      });

      resumedPeer = await ssePeer(handle);
      const resumedConnectionId = resumedPeer.helloAck.payload.connection_id as string;
      await resumedPeer.send(controlEnvelope("session_resume", {
        rsid,
        resume_token: resumeToken,
        last_rx_seq: 1,
      }, 12));
      expect(await resumedPeer.next()).toMatchObject({
        type: "resume_ack",
        payload: { rsid, last_rx_seq: 0 },
      });
      await resumedPeer.send(terminal);
      expect(handle.core.snapshot().sessions[rsid]).toMatchObject({
        inFlight: null,
        sequence: { lastRxSeq: 1 },
      });

      const revoked = await fetch(handle.controlUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rbp-test-control": handle.controlToken,
        },
        body: JSON.stringify({ action: "set_auth_status", token: TOKEN, status: "revoked" }),
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ status: "revoked", disconnected: [resumedConnectionId] });
      await waitFor(() => handle.core.snapshot().sessions[rsid]?.liveness === "disconnected");
    } finally {
      await resumedPeer?.close();
      await peer.close();
    }
  });

  it("refuses bad static credentials, incompatible versions, and non-loopback listeners", async () => {
    const handle = await start("opening-refusals");
    const baseHeaders = {
      accept: "application/json",
      "content-type": "application/json",
      "x-rbp-versions": "1",
    };
    const unauthorized = await fetch(handle.httpConnectionUrl, {
      method: "POST",
      headers: { ...baseHeaders, authorization: "Bearer wrong-token" },
      body: JSON.stringify(hello()),
    });
    expect(unauthorized.status).toBe(401);

    const incompatible = await fetch(handle.httpConnectionUrl, {
      method: "POST",
      headers: {
        ...baseHeaders,
        authorization: `Bearer ${TOKEN}`,
        "x-rbp-versions": "2",
      },
      body: JSON.stringify(hello()),
    });
    expect(incompatible.status).toBe(426);
    expect(await incompatible.json()).toMatchObject({
      min_protocol: 1,
      max_protocol: 1,
      manifest_url: "/bridge/update/manifest",
    });

    await expect(startGatewayStub({
      statePath: await statePath("non-loopback"),
      tokenTable,
      host: "0.0.0.0",
    })).rejects.toThrow(/loopback/);
    await expect(startGatewayStub({
      statePath: await statePath("hostname-loopback"),
      tokenTable,
      host: "localhost",
    })).rejects.toThrow(/loopback/);
  });

  it("requires the exact JSON media type on fallback request bodies", async () => {
    const handle = await start("fallback-media-type");
    const response = await fetch(handle.httpConnectionUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json-evil",
        "x-rbp-versions": "1",
      },
      body: JSON.stringify(hello(207)),
    });
    expect(response.status).toBe(415);
    expect(handle.core.snapshot().runtime.openConnections).toBe(0);
  });
});

describe("capability and connection-lifecycle guards", () => {
  const createFallback = async (
    handle: GatewayStubHandle,
    helloEnvelope: ReturnType<typeof hello>,
  ): Promise<Response> => fetch(handle.httpConnectionUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "x-rbp-versions": "1",
    },
    body: JSON.stringify(helloEnvelope),
  });

  it("requires fallback provisioning, declaration, and Gateway grant independently", async () => {
    const unprovisionedTable = structuredClone(tokenTable);
    unprovisionedTable[TOKEN]!.provisionedCapabilities = [
      "journal_v1",
      "chunked_results",
      "artifact_result_v1",
    ];
    const unprovisioned = await start("fallback-unprovisioned", {
      tokenTable: unprovisionedTable,
    });
    const undeclared = await start("fallback-undeclared");
    const ungranted = await start("fallback-ungranted", {
      connectionCapabilities: ["journal_v1", "chunked_results", "artifact_result_v1"],
    });

    const undeclaredHello = hello(201);
    undeclaredHello.payload.capabilities = undeclaredHello.payload.capabilities.filter(
      (capability) => capability !== "transport_streamable_http",
    );
    for (const [handle, frame] of [
      [unprovisioned, hello(200)],
      [undeclared, undeclaredHello],
      [ungranted, hello(202)],
    ] as const) {
      const response = await createFallback(handle, frame);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringMatching(/provisioned, declared, and granted/),
      });
      expect(handle.core.snapshot().runtime.openConnections).toBe(0);
    }
  });

  it("preserves WSS protocol close codes, closes on goodbye, and expires pre-hello sockets", async () => {
    const versionHandle = await start("wss-version-close");
    const versionSocket = await openRawWebSocket(versionHandle);
    const versionClosed = nextCloseCode(versionSocket);
    const incompatibleHello = hello(203);
    incompatibleHello.payload.min_protocol = 2;
    incompatibleHello.payload.max_protocol = 2;
    versionSocket.send(JSON.stringify(incompatibleHello));
    expect(await versionClosed).toBe(4426);
    await waitFor(() => versionHandle.core.snapshot().runtime.openConnections === 0);

    const goodbyeHandle = await start("wss-goodbye-close");
    const goodbyeSocket = await openRawWebSocket(goodbyeHandle);
    const helloAck = nextRawMessage(goodbyeSocket);
    goodbyeSocket.send(JSON.stringify(hello(204)));
    expect(await helloAck).toMatchObject({ type: "hello_ack", payload: { protocol: 1 } });
    const goodbyeClosed = nextCloseCode(goodbyeSocket);
    goodbyeSocket.send(JSON.stringify(controlEnvelope("goodbye", {
      reason: "shutdown",
      message: "test complete",
    }, 205)));
    expect(await goodbyeClosed).toBe(1000);
    await waitFor(() => goodbyeHandle.core.snapshot().runtime.openConnections === 0);

    const timeoutHandle = await start("wss-hello-timeout", { helloTimeoutMs: 30 });
    const timeoutSocket = await openRawWebSocket(timeoutHandle);
    expect(await nextCloseCode(timeoutSocket)).toBe(4400);
    await waitFor(() => timeoutHandle.core.snapshot().runtime.openConnections === 0);
  });

  it("expires an HTTP connection that never attaches SSE and returns 410 thereafter", async () => {
    const handle = await start("sse-attach-timeout", { sseAttachTimeoutMs: 30 });
    const created = await createFallback(handle, hello(206));
    expect(created.status).toBe(201);
    const connectionId = created.headers.get("rbp-connection-id");
    expect(connectionId).not.toBeNull();
    expect(handle.core.snapshot().runtime.openConnections).toBe(1);
    await waitFor(() => handle.core.snapshot().runtime.openConnections === 0);

    const events = await fetch(
      `${handle.httpConnectionUrl}/${encodeURIComponent(connectionId!)}/events`,
      {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${TOKEN}`,
        },
      },
    );
    expect(events.status).toBe(410);
  });
});
