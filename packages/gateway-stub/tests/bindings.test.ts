import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

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
  NOW,
  TOKEN,
  tokenTable,
  uuid7,
} from "./helpers.js";
import { loopbackTestCertificate } from "./testCertificate.js";

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

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function openRawWebSocket(handle: GatewayStubHandle, versions = "1"): Promise<WebSocket> {
  const socket = new WebSocket(handle.wsUrl, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-rbp-versions": versions,
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

async function nextClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

async function websocketUpgradeRefusal(
  handle: GatewayStubHandle,
  versions: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown }> {
  const socket = new WebSocket(handle.wsUrl, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "x-rbp-versions": versions,
    },
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        socket.removeListener("error", reject);
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
      });
    });
  });
}

async function secureRequest(
  url: string,
  certificate: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: init.method,
      headers: init.headers,
      ca: certificate,
      rejectUnauthorized: true,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.once("error", reject);
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

async function openSecureSse(
  url: string,
  certificate: string,
  headers: Record<string, string>,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "GET",
      headers,
      ca: certificate,
      rejectUnauthorized: true,
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}

async function nextSseEnvelope(response: IncomingMessage): Promise<RbpEnvelope> {
  let buffered = "";
  for await (const chunk of response) {
    buffered += Buffer.from(chunk as Uint8Array).toString("utf8").replaceAll("\r\n", "\n");
    const separator = buffered.indexOf("\n\n");
    if (separator < 0) continue;
    const data = buffered.slice(0, separator).split("\n")
      .find((line) => line.startsWith("data: "))?.slice(6);
    if (data !== undefined) return JSON.parse(data) as RbpEnvelope;
  }
  throw new Error("secure SSE stream ended before an RBP envelope");
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
    try {
      await peer.send(controlEnvelope("session_register", sessionRegister(), 11));
      const registered = await peer.next() as Extract<RbpEnvelope, { type: "session_registered" }>;
      const rsid = registered.payload.rsid;
      const connectionId = peer.helloAck.payload.connection_id as string;
      handle.core.faults.setSseBuffering(connectionId, true);
      const invocationId = uuid7(112);
      const dispatched = await handle.core.dispatchInvoke({
        rsid,
        payload: readInvoke(invocationId),
      });
      expect(handle.core.snapshot().runtime).toMatchObject({ heldOutboundFrames: 1 });
      expect(await handle.core.faults.flushHeld(connectionId)).toBe(1);
      expect(await peer.next()).toEqual(dispatched);
      expect(handle.core.snapshot().runtime).toMatchObject({ heldOutboundFrames: 0 });

      handle.core.faults.enqueueFrame({
        direction: "bridge_to_gateway",
        binding: "http_sse",
        action: "hold",
        messageType: "chunk",
        remaining: 2,
      });
      const bytes = Buffer.from("hello world", "utf8");
      const chunks = [bytes.subarray(0, 5), bytes.subarray(5)];
      for (const [chunkIndex, chunk] of chunks.entries()) {
        await expect(peer.send({
          v: 1,
          type: "partial",
          id: uuid7(113 + chunkIndex),
          rsid,
          seq: chunkIndex + 1,
          ack: 1,
          ts: NOW,
          payload: {
            kind: "chunk",
            invocation_id: invocationId,
            stream_id: "result",
            chunk_index: chunkIndex,
            encoding: "base64",
            content_type: "text/plain",
            data: chunk.toString("base64"),
          },
        })).resolves.toBeUndefined();
      }
      expect(handle.core.snapshot().sessions[rsid]).toMatchObject({
        inFlight: { correlationId: invocationId },
        sequence: { lastRxSeq: 0 },
        liveness: "steady",
      });
      expect(handle.core.snapshot().runtime).toMatchObject({ heldInboundFrames: 2 });

      expect(await handle.core.faults.flushHeld(connectionId)).toBe(2);
      expect(handle.core.snapshot().sessions[rsid]).toMatchObject({
        inFlight: { correlationId: invocationId },
        sequence: { lastRxSeq: 2 },
      });
      expect(handle.core.snapshot().runtime).toMatchObject({ heldInboundFrames: 0 });

      const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      await peer.send({
        v: 1,
        type: "result",
        id: uuid7(115),
        rsid,
        seq: 3,
        ack: 1,
        ts: NOW,
        payload: {
          kind: "invocation",
          invocation_id: invocationId,
          status: "completed",
          replayed: false,
          chunked: true,
          stream_id: "result",
          content_type: "text/plain",
          total_chunks: 2,
          total_size: bytes.byteLength,
          sha256,
          metrics: {
            execute_ms: 1,
            request_bytes: 2,
            response_bytes: bytes.byteLength,
            framing: "length-prefixed",
          },
        },
      });
      await waitFor(() => handle.core.snapshot().sessions[rsid]?.inFlight === null);
      expect(handle.core.snapshot().sessions[rsid]).toMatchObject({
        sequence: { lastRxSeq: 3 },
        chunkedResults: {
          [invocationId]: { totalChunks: 2, totalSize: bytes.byteLength, sha256 },
        },
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
      expect(await revoked.json()).toMatchObject({ status: "revoked", disconnected: [connectionId] });
      await waitFor(() => handle.core.snapshot().sessions[rsid]?.liveness === "disconnected");
    } finally {
      await peer.close();
    }
  });

  it("keeps a dropped HTTP uplink acceptance unknown while held uplinks remain accepted", async () => {
    const handle = await start("dropped-http-uplink");
    const peer = await ssePeer(handle);
    try {
      await peer.send(controlEnvelope("session_register", sessionRegister(), 116));
      const registered = await peer.next() as Extract<RbpEnvelope, { type: "session_registered" }>;
      const rsid = registered.payload.rsid;
      const invocationId = uuid7(117);
      const dispatched = await handle.core.dispatchInvoke({ rsid, payload: readInvoke(invocationId) });
      expect(await peer.next()).toEqual(dispatched);

      handle.core.faults.enqueueFrame({
        direction: "bridge_to_gateway",
        binding: "http_sse",
        action: "drop",
        messageType: "result",
      });
      await expect(peer.send(resultEnvelope(rsid, invocationId))).rejects.toThrow();
      expect(handle.core.snapshot().sessions[rsid]).toMatchObject({
        inFlight: { correlationId: invocationId },
        sequence: { lastRxSeq: 0 },
        liveness: "disconnected",
      });
      expect(handle.core.snapshot().runtime.openConnections).toBe(0);
    } finally {
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

  it("serves RBP/1 inside a [2,1] deployment window and fails v2-only wire closed with exact pointers", async () => {
    const handle = await start("n-minus-one-window", { supportedProtocols: [2, 1] });
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "x-rbp-versions": "2,1",
    };

    const v1 = await fetch(handle.httpConnectionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(hello(208)),
    });
    expect(v1.status).toBe(201);
    expect(await v1.json()).toMatchObject({
      type: "hello_ack",
      payload: { protocol: 1 },
    });

    const v2Hello = hello(209);
    v2Hello.payload.min_protocol = 2;
    v2Hello.payload.max_protocol = 2;
    const v2Http = await fetch(handle.httpConnectionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(v2Hello),
    });
    expect(v2Http.status).toBe(426);
    expect(await v2Http.json()).toEqual({
      error: "RBP/2 wire adapter is not implemented by the O1-T5 v1 stub",
      min_protocol: 1,
      max_protocol: 2,
      manifest_url: "/bridge/update/manifest",
    });

    const v2Socket = await openRawWebSocket(handle, "2,1");
    const v2Close = nextClose(v2Socket);
    v2Socket.send(JSON.stringify(v2Hello));
    expect(await v2Close).toEqual({
      code: 4426,
      reason: JSON.stringify({
        min_protocol: 1,
        max_protocol: 2,
        manifest_url: "/bridge/update/manifest",
      }),
    });

    const upgrade = await websocketUpgradeRefusal(handle, "3");
    expect(upgrade.status).toBe(426);
    expect(upgrade.headers["content-type"]).toBe("application/json");
    expect(upgrade.body).toEqual({
      error: "no mutually supported RBP version",
      min_protocol: 1,
      max_protocol: 2,
      manifest_url: "/bridge/update/manifest",
    });
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

  it("rejects a second live SSE attachment with 409 without disturbing the first stream", async () => {
    const handle = await start("sse-single-attachment");
    const created = await fetch(handle.httpConnectionUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-rbp-versions": "1",
      },
      body: JSON.stringify(hello(210)),
    });
    expect(created.status).toBe(201);
    const connectionId = created.headers.get("rbp-connection-id");
    expect(connectionId).not.toBeNull();
    const eventsUrl = `${handle.httpConnectionUrl}/${encodeURIComponent(connectionId!)}/events`;
    const firstAbort = new AbortController();
    const first = await fetch(eventsUrl, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
      signal: firstAbort.signal,
    });
    expect(first.status).toBe(200);

    try {
      const second = await fetch(eventsUrl, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${TOKEN}`,
        },
      });
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "SSE stream already attached" });
      expect(handle.core.snapshot().runtime.openConnections).toBe(1);
    } finally {
      firstAbort.abort();
      await first.body?.cancel().catch(() => undefined);
    }
  });

  it("maps an unsupported wire feature to a schema-valid protocol connection fault", async () => {
    const handle = await start("unsupported-wire-fault", {
      connectionCapabilities: ["journal_v1", "transport_streamable_http"],
    });
    const socket = await openRawWebSocket(handle);
    const helloAck = nextRawMessage(socket);
    socket.send(JSON.stringify(hello(211)));
    expect(await within(helloAck, "unsupported test hello_ack")).toMatchObject({
      type: "hello_ack",
      payload: { granted_capabilities: ["journal_v1", "transport_streamable_http"] },
    });

    const sessionRegistered = nextRawMessage(socket);
    socket.send(JSON.stringify(controlEnvelope("session_register", sessionRegister(), 212)));
    const registered = await within(
      sessionRegistered,
      "unsupported test session_registered",
    ) as Extract<RbpEnvelope, { type: "session_registered" }>;
    const rsid = registered.payload.rsid;
    const invocationId = uuid7(213);
    const invoke = nextRawMessage(socket);
    const dispatched = await handle.core.dispatchInvoke({ rsid, payload: readInvoke(invocationId) });
    expect(await within(invoke, "unsupported test invoke")).toEqual(dispatched);

    const fault = nextRawMessage(socket);
    const closed = nextClose(socket);
    socket.send(JSON.stringify({
      v: 1,
      type: "partial",
      id: uuid7(214),
      rsid,
      seq: 1,
      ack: 1,
      ts: NOW,
      payload: {
        kind: "chunk",
        invocation_id: invocationId,
        stream_id: "result",
        chunk_index: 0,
        encoding: "base64",
        content_type: "text/plain",
        data: Buffer.from("unsupported").toString("base64"),
      },
    }));
    expect(await within(fault, "unsupported connection error")).toMatchObject({
      type: "error",
      payload: {
        retryable: false,
        fault_class: "protocol",
        message: "partial requires granted connection capability chunked_results",
      },
    });
    expect((await within(closed, "unsupported connection close")).code).toBe(4400);
  });

  it("serves real certificate-validated WSS and HTTPS/SSE bindings", async () => {
    const tls = loopbackTestCertificate();
    const handle = await start("tls-bindings", { tls });
    expect(handle.wsUrl).toMatch(/^wss:\/\//u);
    expect(handle.httpConnectionUrl).toMatch(/^https:\/\//u);

    const socket = new WebSocket(handle.wsUrl, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-rbp-versions": "1",
      },
      ca: tls.cert,
      rejectUnauthorized: true,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify(hello(215)));
    expect(await nextRawMessage(socket)).toMatchObject({
      type: "hello_ack",
      payload: { protocol: 1 },
    });
    const socketClosed = nextClose(socket);
    socket.close(1000, "test complete");
    expect((await socketClosed).code).toBe(1000);

    const createBody = JSON.stringify(hello(216));
    const created = await secureRequest(handle.httpConnectionUrl, tls.cert, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(createBody)),
        "x-rbp-versions": "1",
      },
      body: createBody,
    });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body.toString("utf8"))).toMatchObject({
      type: "hello_ack",
      payload: { protocol: 1 },
    });
    const connectionId = created.headers["rbp-connection-id"];
    expect(typeof connectionId).toBe("string");
    const events = await openSecureSse(
      `${handle.httpConnectionUrl}/${encodeURIComponent(connectionId as string)}/events`,
      tls.cert,
      {
        accept: "text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
    );
    expect(events.statusCode).toBe(200);

    try {
      const registration = JSON.stringify(controlEnvelope("session_register", sessionRegister(), 217));
      const accepted = await secureRequest(
        `${handle.httpConnectionUrl}/${encodeURIComponent(connectionId as string)}/messages`,
        tls.cert,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(registration)),
          },
          body: registration,
        },
      );
      expect(accepted.status).toBe(202);
      expect(await nextSseEnvelope(events)).toMatchObject({
        type: "session_registered",
        payload: { granted_session_capabilities: ["batch_atomic", "doc_context_cached_v1"] },
      });
    } finally {
      events.destroy();
    }
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
