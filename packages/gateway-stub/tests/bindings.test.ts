import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import type { RbpEnvelope } from "@revagent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function postControl(handle: GatewayStubHandle, body: unknown): Promise<Response> {
  return fetch(handle.controlUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rbp-test-control": handle.controlToken,
    },
    body: JSON.stringify(body),
  });
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
  it("rejects bridge-claimed seat and user authority on authenticated WSS paths without retaining values", async () => {
    const handle = await start("authorization-audit-server-path");
    const spoofVectors = [
      {
        field: "seat_id",
        secret: "server-path-attacker-seat",
        payload: {
          ...sessionRegister(),
          seat_id: "server-path-attacker-seat",
        },
      },
      {
        field: "user_hint.user_id",
        secret: "server-path-attacker-user",
        payload: {
          ...sessionRegister(),
          user_hint: {
            ...sessionRegister().user_hint,
            user_id: "server-path-attacker-user",
          },
        },
      },
    ] as const;

    for (const [index, vector] of spoofVectors.entries()) {
      const socket = await openRawWebSocket(handle);
      try {
        socket.send(JSON.stringify(hello(340 + index * 2)));
        await nextRawMessage(socket);
        const fault = nextRawMessage(socket);
        const closed = nextClose(socket);
        socket.send(JSON.stringify(controlEnvelope(
          "session_register",
          vector.payload,
          341 + index * 2,
        )));
        await expect(fault).resolves.toMatchObject({
          type: "error",
          payload: {
            fault_class: "auth",
            message: "session registration contains bridge-claimed principal or seat authority",
          },
        });
        await expect(closed).resolves.toMatchObject({ code: 4403 });
      } finally {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }
    }

    const snapshot = handle.core.snapshot().authorizationAudit;
    expect(snapshot).toMatchObject({
      evidenceVersion: 1,
      capacity: 256,
      totalEventCount: 4,
      droppedEventCount: 0,
      secretsRedacted: true,
    });
    expect(snapshot.entries.filter((entry) => entry.decision === "rejected")).toEqual(
      spoofVectors.map((vector) => expect.objectContaining({
        operation: "session_register",
        reason: "claimed_identity",
        claimedIdentityFields: [vector.field],
      })),
    );
    const serialized = JSON.stringify(snapshot);
    for (const vector of spoofVectors) expect(serialized).not.toContain(vector.secret);
    expect(serialized).not.toContain(TOKEN);
  });

  it("returns one shared close promise to every concurrent caller, including rejection", async () => {
    const successful = await start("shared-close-success");
    const first = successful.close();
    const second = successful.close();
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    const failing = await start("shared-close-rejection");
    handles.splice(handles.indexOf(failing), 1);
    const failure = new Error("injected core close failure");
    vi.spyOn(failing.core, "close").mockRejectedValueOnce(failure);
    const rejectedFirst = failing.close();
    const rejectedSecond = failing.close();
    expect(rejectedSecond).toBe(rejectedFirst);
    await expect(rejectedFirst).rejects.toBe(failure);
    await expect(rejectedSecond).rejects.toBe(failure);
  });

  it("keeps the shared handle close pending until an actual deferred callback exits", async () => {
    const handle = await start("shared-close-delivery-barrier");
    let startCallback: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { startCallback = resolve; });
    let releaseCallback: () => void = () => undefined;
    const release = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let callbackFinished = false;
    handle.core.faults.enqueueFrame({
      direction: "bridge_to_gateway",
      binding: "http_sse",
      action: "delay",
      messageType: "heartbeat",
      delayMs: 0,
    });
    const delivery = await handle.core.faults.apply(
      "synthetic-connection",
      "http_sse",
      "bridge_to_gateway",
      "heartbeat",
      async () => {
        startCallback();
        await release;
        callbackFinished = true;
      },
    );
    await within(started, "synthetic deferred callback start");

    let closeFinished = false;
    const closing = handle.close().then(() => { closeFinished = true; });
    await expect(delivery.completion).resolves.toMatchObject({ state: "cancelled" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(closeFinished).toBe(false);
    expect(callbackFinished).toBe(false);
    expect(handle.core.snapshot().runtime.activeDeliveries).toBe(1);

    releaseCallback();
    await within(closing, "shared close delivery barrier");
    expect(callbackFinished).toBe(true);
    expect(handle.core.snapshot().runtime.activeDeliveries).toBe(0);
  });

  it("keeps an explicit connection close behind that connection's real callback barrier", async () => {
    const handle = await start("connection-close-delivery-barrier");
    const peer = await ssePeer(handle);
    const connectionId = peer.helloAck.payload.connection_id;
    if (typeof connectionId !== "string") throw new Error("fallback hello_ack omitted connection_id");
    let startCallback: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { startCallback = resolve; });
    let releaseCallback: () => void = () => undefined;
    const release = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let callbackFinished = false;
    handle.core.faults.enqueueFrame({
      direction: "bridge_to_gateway",
      binding: "http_sse",
      action: "delay",
      messageType: "heartbeat",
      delayMs: 0,
    });
    const delivery = await handle.core.faults.apply(
      connectionId,
      "http_sse",
      "bridge_to_gateway",
      "heartbeat",
      async () => {
        startCallback();
        await release;
        callbackFinished = true;
      },
    );
    await within(started, "connection callback start");

    let disconnectFinished = false;
    const disconnect = postControl(handle, { action: "disconnect", connection_id: connectionId })
      .then((response) => {
        disconnectFinished = true;
        return response;
      });
    await expect(delivery.completion).resolves.toMatchObject({ state: "cancelled" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(disconnectFinished).toBe(false);
    expect(callbackFinished).toBe(false);

    releaseCallback();
    expect((await within(disconnect, "connection close callback barrier")).status).toBe(200);
    expect(callbackFinished).toBe(true);
    expect(handle.core.snapshot().runtime).toMatchObject({ activeDeliveries: 0, openConnections: 0 });
    await peer.close();
  });

  it("runs listener and core barriers even when one connection close fails", async () => {
    const handle = await start("all-settled-handle-close");
    await ssePeer(handle);
    const failure = new Error("synthetic disconnect failure");
    const disconnect = vi.spyOn(handle.core, "disconnectConnection").mockRejectedValueOnce(failure);
    const coreClose = vi.spyOn(handle.core, "close");

    await expect(handle.close()).rejects.toThrow("synthetic disconnect failure");
    expect(coreClose).toHaveBeenCalledOnce();
    await expect(fetch(handle.controlUrl)).rejects.toThrow();
    disconnect.mockRestore();
    handles.splice(handles.indexOf(handle), 1);
  });

  it("observes peer-EOF cleanup rejection and reports it from the shared handle close", async () => {
    const handle = await start("observed-peer-eof-failure");
    const peer = await ssePeer(handle);
    const failure = new Error("synthetic eof cleanup failure");
    const disconnect = vi.spyOn(handle.core, "disconnectConnection").mockRejectedValueOnce(failure);

    await peer.close();
    await waitFor(() => disconnect.mock.calls.length >= 1);
    disconnect.mockRestore();
    await expect(handle.close()).rejects.toThrow("synthetic eof cleanup failure");
    await expect(fetch(handle.controlUrl)).rejects.toThrow();
    handles.splice(handles.indexOf(handle), 1);
  });

  it("observes WSS protocol-failure cleanup rejection and reports it from handle close", async () => {
    const handle = await start("observed-wss-protocol-close-failure");
    const socket = await openRawWebSocket(handle);
    const helloAck = nextRawMessage(socket);
    socket.send(JSON.stringify(hello(300)));
    await helloAck;

    const failure = new Error("synthetic WSS protocol cleanup failure");
    let rejectDisconnect: (error: Error) => void = () => undefined;
    const pendingDisconnect = new Promise<void>((_resolve, reject) => {
      rejectDisconnect = reject;
    });
    const disconnect = vi.spyOn(handle.core, "disconnectConnection").mockReturnValueOnce(pendingDisconnect);
    const closed = nextCloseCode(socket);
    socket.send(Buffer.from([0x01]), { binary: true });
    expect(await closed).toBe(4400);
    await waitFor(() => disconnect.mock.calls.length === 1);
    let closeFinished = false;
    const closing = handle.close().finally(() => { closeFinished = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(closeFinished).toBe(false);
    rejectDisconnect(failure);
    disconnect.mockRestore();

    await expect(closing).rejects.toThrow("synthetic WSS protocol cleanup failure");
    await expect(fetch(handle.controlUrl)).rejects.toThrow();
    handles.splice(handles.indexOf(handle), 1);
  });

  it("observes automatic liveness-sweep cleanup rejection and reports it from handle close", async () => {
    const handle = await start("observed-liveness-sweep-close-failure", {
      livenessSweepMs: 5,
    });
    const peer = await ssePeer(handle);
    const connectionId = peer.helloAck.payload.connection_id;
    if (typeof connectionId !== "string") throw new Error("fallback hello_ack omitted connection_id");

    const failure = new Error("synthetic liveness cleanup failure");
    const disconnect = vi.spyOn(handle.core, "disconnectConnection").mockRejectedValueOnce(failure);
    const sweep = vi.spyOn(handle.core, "livenessSweep").mockResolvedValueOnce([connectionId]);
    await waitFor(() => disconnect.mock.calls.length >= 1);
    sweep.mockRestore();
    disconnect.mockRestore();

    await expect(handle.close()).rejects.toThrow("synthetic liveness cleanup failure");
    await expect(fetch(handle.controlUrl)).rejects.toThrow();
    handles.splice(handles.indexOf(handle), 1);
  });

  it("reports simultaneous liveness close failures once each without an aggregate wrapper duplicate", async () => {
    const handle = await start("deduped-liveness-close-failures", { livenessSweepMs: 5 });
    const firstPeer = await ssePeer(handle);
    const secondPeer = await ssePeer(handle);
    const firstId = firstPeer.helloAck.payload.connection_id;
    const secondId = secondPeer.helloAck.payload.connection_id;
    if (typeof firstId !== "string" || typeof secondId !== "string") {
      throw new Error("fallback hello_ack omitted connection_id");
    }
    const firstFailure = new Error("first liveness cleanup failure");
    const secondFailure = new Error("second liveness cleanup failure");
    const disconnect = vi.spyOn(handle.core, "disconnectConnection")
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(secondFailure);
    const sweep = vi.spyOn(handle.core, "livenessSweep").mockResolvedValueOnce([firstId, secondId]);

    await waitFor(() => disconnect.mock.calls.length >= 2);
    sweep.mockRestore();
    disconnect.mockRestore();
    let closeError: unknown;
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
    expect(closeError).toBeInstanceOf(AggregateError);
    expect((closeError as AggregateError).errors).toEqual([firstFailure, secondFailure]);
    handles.splice(handles.indexOf(handle), 1);
  });

  it("drains a fallback create paused after durable hello without arming a shutdown deadline", async () => {
    const handle = await start("fallback-create-shutdown-race", { sseAttachTimeoutMs: 25 });
    const originalAcceptHello = handle.core.acceptHello.bind(handle.core);
    let markAccepted: () => void = () => undefined;
    const accepted = new Promise<void>((resolve) => { markAccepted = resolve; });
    let releaseAccept: () => void = () => undefined;
    const release = new Promise<void>((resolve) => { releaseAccept = resolve; });
    vi.spyOn(handle.core, "acceptHello").mockImplementationOnce(async (...arguments_) => {
      const ack = await originalAcceptHello(...arguments_);
      markAccepted();
      await release;
      return ack;
    });
    const disconnect = vi.spyOn(handle.core, "disconnectConnection");
    const creating = fetch(handle.httpConnectionUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "x-rbp-versions": "1",
      },
      body: JSON.stringify(hello(302)),
    });
    void creating.catch(() => undefined);
    await within(accepted, "durable fallback hello");

    let closeFinished = false;
    const closing = handle.close().finally(() => { closeFinished = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(closeFinished).toBe(false);
    releaseAccept();
    await closing;
    const createStatus = await creating.then((response) => response.status, () => 0);
    expect([0, 503]).toContain(createStatus);
    const disconnectCallsAfterClose = disconnect.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(disconnect.mock.calls.length).toBe(disconnectCallsAfterClose);
    expect(handle.core.snapshot().runtime).toMatchObject({ openConnections: 0, activeDeliveries: 0 });
    await expect(fetch(handle.controlUrl)).rejects.toThrow();
    handles.splice(handles.indexOf(handle), 1);
  });

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
      const dispatchResponse = await postControl(handle, {
        action: "dispatch_invoke",
        request: { rsid, payload: readInvoke(invocationId) },
      });
      expect(dispatchResponse.status).toBe(200);
      const dispatched = await dispatchResponse.json() as RbpEnvelope;
      expect(handle.core.snapshot().runtime).toMatchObject({ heldOutboundFrames: 1 });
      expect(await handle.core.faults.flushHeld(connectionId)).toEqual({
        selected: 1,
        delivered: 1,
        cancelled: 0,
        failed: 0,
      });
      expect(await peer.next()).toEqual(dispatched);
      expect(handle.core.snapshot().runtime).toMatchObject({ heldOutboundFrames: 0 });

      const queuedHold = await postControl(handle, {
        action: "enqueue_frame_fault",
        rule: {
          direction: "bridge_to_gateway",
          binding: "http_sse",
          action: "hold",
          messageType: "chunk",
          remaining: 2,
        },
      });
      expect(queuedHold.status).toBe(200);
      expect(await queuedHold.json()).toEqual({ queued: true });
      const bytes = Buffer.from("hello world", "utf8");
      const chunks = [bytes.subarray(0, 5), bytes.subarray(5)];
      const pendingChunkPosts = chunks.map(async (chunk, chunkIndex) =>
        peer.send({
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
        }));
      await waitFor(() => handle.core.snapshot().runtime.heldInboundFrames === 2);
      expect(handle.core.snapshot().sessions[rsid]).toMatchObject({
        inFlight: { correlationId: invocationId },
        sequence: { lastRxSeq: 0 },
        liveness: "steady",
      });
      expect(handle.core.snapshot().runtime).toMatchObject({ heldInboundFrames: 2 });

      const flushed = await postControl(handle, { action: "flush_held", connection_id: connectionId });
      expect(flushed.status).toBe(200);
      expect(await flushed.json()).toEqual({ selected: 2, flushed: 2, cancelled: 0, failed: 0 });
      await expect(Promise.all(pendingChunkPosts)).resolves.toEqual([undefined, undefined]);
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

  it("keeps delayed HTTP acceptance pending until durable processing completes", async () => {
    const handle = await start("delayed-http-uplink");
    const peer = await ssePeer(handle);
    try {
      const queued = await postControl(handle, {
        action: "enqueue_frame_fault",
        rule: {
          direction: "bridge_to_gateway",
          binding: "http_sse",
          action: "delay",
          delayMs: 50,
          messageType: "session_register",
        },
      });
      expect(queued.status).toBe(200);
      const pending = peer.send(controlEnvelope("session_register", sessionRegister(), 218));
      await waitFor(() => handle.core.snapshot().runtime.activeTimers === 1);
      expect(Object.keys(handle.core.snapshot().sessions)).toEqual([]);
      await expect(pending).resolves.toBeUndefined();
      expect((await peer.next()).type).toBe("session_registered");
      expect(handle.core.snapshot().runtime.activeTimers).toBe(0);
    } finally {
      await peer.close();
    }
  });

  it("does not report a held HTTP frame accepted when shutdown cancels it, and restart restores no phantom delivery", async () => {
    const retainedStatePath = await statePath("held-http-shutdown");
    const handle = await startGatewayStub({
      statePath: retainedStatePath,
      tokenTable,
      livenessSweepMs: 0,
    });
    handles.push(handle);
    const peer = await ssePeer(handle);
    try {
      const queued = await postControl(handle, {
        action: "enqueue_frame_fault",
        rule: {
          direction: "bridge_to_gateway",
          binding: "http_sse",
          action: "hold",
          messageType: "session_register",
        },
      });
      expect(queued.status).toBe(200);
      const pending = peer.send(controlEnvelope("session_register", sessionRegister(), 219));
      void pending.catch(() => undefined);
      await waitFor(() => handle.core.snapshot().runtime.heldInboundFrames === 1);

      await handle.close();
      await expect(pending).rejects.toThrow();
      expect(handle.core.snapshot().runtime.heldInboundFrames).toBe(0);
      expect(Object.keys(handle.core.snapshot().sessions)).toEqual([]);

      const reopened = await startGatewayStub({
        statePath: retainedStatePath,
        tokenTable,
        livenessSweepMs: 0,
      });
      handles.push(reopened);
      expect(reopened.core.snapshot().runtime.heldInboundFrames).toBe(0);
      expect(Object.keys(reopened.core.snapshot().sessions)).toEqual([]);
    } finally {
      await peer.close();
    }
  });

  it("propagates a deferred WSS processing failure and closes acceptance-unknown transport state", async () => {
    const handle = await start("deferred-wss-failure");
    const socket = await openRawWebSocket(handle);
    try {
      socket.send(JSON.stringify(hello(220)));
      const helloAck = await nextRawMessage(socket);
      const connectionId = helloAck.payload.connection_id as string;
      socket.send(JSON.stringify(controlEnvelope("session_register", sessionRegister(), 221)));
      const registered = await nextRawMessage(socket) as Extract<RbpEnvelope, { type: "session_registered" }>;
      const rsid = registered.payload.rsid;
      const invocationId = uuid7(222);
      await handle.core.dispatchInvoke({ rsid, payload: readInvoke(invocationId) });
      await nextRawMessage(socket);

      handle.core.faults.enqueueFrame({
        direction: "bridge_to_gateway",
        binding: "wss",
        action: "hold",
        messageType: "result",
      });
      socket.send(JSON.stringify(resultEnvelope(rsid, invocationId, 2, 1, 223)));
      await waitFor(() => handle.core.snapshot().runtime.heldInboundFrames === 1);
      const fault = nextRawMessage(socket);
      const closed = nextClose(socket);
      const flushed = await postControl(handle, { action: "flush_held", connection_id: connectionId });
      expect(flushed.status).toBe(200);
      expect(await flushed.json()).toEqual({ selected: 1, flushed: 0, cancelled: 0, failed: 1 });
      expect(await within(fault, "deferred WSS connection fault")).toMatchObject({
        type: "error",
        payload: {
          fault_class: "protocol",
          message: "forward sequence gap: expected 1, received 2",
        },
      });
      expect((await within(closed, "deferred WSS close")).code).toBe(4400);
      await waitFor(() => handle.core.snapshot().runtime.openConnections === 0);
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  });

  it("serializes back-to-back WSS unregister and heartbeat processing in receive order", async () => {
    const handle = await start("ordered-wss-unregister-heartbeat");
    const socket = await openRawWebSocket(handle);
    let releaseUnregister!: () => void;
    let markUnregisterEntered!: () => void;
    const unregisterGate = new Promise<void>((resolve) => { releaseUnregister = resolve; });
    const unregisterEntered = new Promise<void>((resolve) => { markUnregisterEntered = resolve; });
    const originalReceive = handle.core.receiveFrame.bind(handle.core);
    const receive = vi.spyOn(handle.core, "receiveFrame").mockImplementation(
      async (connectionId, frame) => {
        const envelope = JSON.parse(Buffer.from(frame).toString("utf8")) as RbpEnvelope;
        if (envelope.type === "session_unregister") {
          markUnregisterEntered();
          await unregisterGate;
        }
        return await originalReceive(connectionId, frame);
      },
    );
    try {
      socket.send(JSON.stringify(hello(225)));
      await nextRawMessage(socket);
      socket.send(JSON.stringify(controlEnvelope("session_register", sessionRegister(), 226)));
      const registered = await nextRawMessage(socket) as Extract<RbpEnvelope, { type: "session_registered" }>;
      const rsid = registered.payload.rsid;

      socket.send(JSON.stringify(controlEnvelope("session_unregister", {
        rsid,
        reason: "operator_requested",
      }, 227)));
      socket.send(JSON.stringify(controlEnvelope("heartbeat", {
        bridge_version: "0.1.0-test",
        acks: [],
        sessions: [],
      }, 228)));
      await unregisterEntered;
      const heartbeatAck = nextRawMessage(socket);
      releaseUnregister();

      expect(await heartbeatAck).toMatchObject({
        type: "heartbeat_ack",
        payload: { acks: [] },
      });
      expect(handle.core.snapshot().sessions[rsid]).toMatchObject({
        revoked: true,
        lifecycle: { phase: "unregistered", unregisterReason: "operator_requested" },
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      receive.mockRestore();
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  });

  it("contains an oversized WSS frame to one connection without crashing the Gateway", async () => {
    const handle = await start("oversized-wss-frame");
    const socket = await openRawWebSocket(handle);
    try {
      socket.send(JSON.stringify(hello(229)));
      await nextRawMessage(socket);
      const closed = nextCloseCode(socket);
      socket.send("x".repeat(48 * 1024 * 1024 + 1));
      expect([1009, 4400]).toContain(await within(closed, "oversized WSS close", 5_000));
      await waitFor(() => handle.core.snapshot().runtime.openConnections === 0, 5_000);

      const survivor = await openRawWebSocket(handle);
      try {
        survivor.send(JSON.stringify(hello(230)));
        expect(await nextRawMessage(survivor)).toMatchObject({ type: "hello_ack" });
      } finally {
        survivor.terminate();
      }
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
  }, 15_000);

  it("destroys HTTP acceptance and its SSE connection on a generic durable-processing failure", async () => {
    const handle = await start("generic-http-processing-failure");
    const peer = await ssePeer(handle);
    const receive = vi.spyOn(handle.core, "receiveFrame")
      .mockRejectedValueOnce(new Error("synthetic durable I/O failure"));
    try {
      await expect(peer.send(controlEnvelope("heartbeat", { sessions: [] }, 224))).rejects.toThrow();
      await waitFor(() => handle.core.snapshot().runtime.openConnections === 0);
    } finally {
      receive.mockRestore();
      await peer.close();
    }
  });

  it("retains a swallowed HTTP acceptance-cleanup rejection for shared handle close", async () => {
    const handle = await start("observed-http-acceptance-close-failure");
    const peer = await ssePeer(handle);
    const connectionId = peer.helloAck.payload.connection_id;
    if (typeof connectionId !== "string") throw new Error("fallback hello_ack omitted connection_id");
    const failure = new Error("synthetic HTTP acceptance cleanup failure");
    const disconnect = vi.spyOn(handle.core, "disconnectConnection").mockRejectedValueOnce(failure);

    const response = await fetch(
      `${handle.httpConnectionUrl}/${encodeURIComponent(connectionId)}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "text/plain",
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(415);
    await waitFor(() => disconnect.mock.calls.length >= 1);
    disconnect.mockRestore();

    await expect(handle.close()).rejects.toThrow("synthetic HTTP acceptance cleanup failure");
    await expect(fetch(handle.controlUrl)).rejects.toThrow();
    handles.splice(handles.indexOf(handle), 1);
  });

  it("closes the paired SSE stream for every authenticated local uplink validation failure", async () => {
    for (const [name, contentType, body, expectedStatus, emitsConnectionFault] of [
      ["media-type", "application/json-evil", "{}", 415, false],
      ["malformed-frame", "application/json", "{", 400, true],
    ] as const) {
      const handle = await start(`local-http-${name}`);
      const peer = await ssePeer(handle);
      const connectionId = peer.helloAck.payload.connection_id;
      if (typeof connectionId !== "string") throw new Error("fallback hello_ack omitted connection_id");
      try {
        const response = await fetch(
          `${handle.httpConnectionUrl}/${encodeURIComponent(connectionId)}/messages`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": contentType,
            },
            body,
          },
        );
        expect(response.status, name).toBe(expectedStatus);
        await waitFor(() => handle.core.snapshot().runtime.openConnections === 0);
        if (emitsConnectionFault) {
          expect(await within(peer.next(), `${name} connection fault`)).toMatchObject({
            type: "error",
            payload: { fault_class: "protocol" },
          });
        }
        await expect(within(peer.next(), `${name} SSE close`)).rejects.toThrow(/SSE stream ended/u);
      } finally {
        await peer.close();
      }
    }
  });

  it("rejects non-exact and invalid test-control fault commands with 400", async () => {
    const handle = await start("invalid-control-faults");
    const invalidCommands = [
      { action: "unknown_action" },
      {
        action: "enqueue_frame_fault",
        rule: { direction: "bridge_to_gateway", action: "dropp", messageType: "result" },
      },
      {
        action: "enqueue_frame_fault",
        rule: { direction: "sideways", action: "drop", messageType: "result" },
      },
      {
        action: "enqueue_frame_fault",
        rule: { direction: "bridge_to_gateway", binding: "http", action: "drop", messageType: "result" },
      },
      {
        action: "enqueue_frame_fault",
        rule: { direction: "bridge_to_gateway", action: "drop", messageType: "not_an_rbp_message" },
      },
      {
        action: "enqueue_frame_fault",
        rule: { direction: "bridge_to_gateway", action: "drop", messageType: "partial" },
      },
      {
        action: "enqueue_frame_fault",
        rule: { direction: "gateway_to_bridge", action: "drop", messageType: "session_register" },
      },
      {
        action: "enqueue_frame_fault",
        rule: { direction: "bridge_to_gateway", action: "hold", messageType: "result", delayMs: 1 },
      },
      {
        action: "enqueue_frame_fault",
        rule: { direction: "bridge_to_gateway", action: "drop", messageType: "result", unexpected: true },
      },
      {
        action: "enqueue_opening_fault",
        rule: { binding: "other", status: 503 },
      },
      {
        action: "enqueue_opening_fault",
        rule: { binding: "http_sse", status: 503, retryAfter: "\r\nX-Injected: yes" },
      },
      {
        action: "enqueue_opening_fault",
        rule: { binding: "http_sse", status: 503, retryAfter: "tomorrow" },
      },
      { action: "dispatch_invoke", request: {} },
      { action: "dispatch_batch", request: {} },
      { action: "dispatch_cancel", request: {} },
      { action: "dispatch_payload_recovery", request: {} },
      { action: "record_verification_evidence", request: {} },
      { action: "record_late_terminal_evidence", request: {} },
      {
        action: "install_hold",
        rsid: "rs_ghost",
        mutation_scope: { kind: "session" },
        origin_invocation_ids: [],
      },
    ];
    for (const command of invalidCommands) {
      const response = await postControl(handle, command);
      expect(response.status, JSON.stringify(command)).toBe(400);
    }
    const ghostBuffering = await postControl(handle, {
      action: "set_sse_buffering",
      connection_id: "ghost-connection",
      enabled: true,
    });
    expect(ghostBuffering.status).toBe(404);
    const ghostDisconnect = await postControl(handle, {
      action: "disconnect",
      connection_id: "ghost-connection",
    });
    expect(ghostDisconnect.status).toBe(404);
    const ghostFlush = await postControl(handle, {
      action: "flush_held",
      connection_id: "ghost-connection",
    });
    expect(ghostFlush.status).toBe(404);
    const unknownAuth = await postControl(handle, {
      action: "set_auth_status",
      token: "ghost-token",
      status: "revoked",
    });
    expect(unknownAuth.status).toBe(404);
    expect(handle.core.snapshot().runtime).toMatchObject({
      heldInboundFrames: 0,
      heldOutboundFrames: 0,
      activeTimers: 0,
      bufferedSseConnections: [],
    });
    expect(Object.keys(handle.core.snapshot().sessions)).toEqual([]);
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

  it("keeps the RBP/1 bootstrap exception honest and fails v2-only wire closed with exact pointers", async () => {
    const handle = await start("rbp1-bootstrap-window");
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "x-rbp-versions": "1",
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
      headers: { ...headers, "x-rbp-versions": "2" },
      body: JSON.stringify(v2Hello),
    });
    expect(v2Http.status).toBe(426);
    expect(await v2Http.json()).toEqual({
      error: "no mutually supported RBP version",
      min_protocol: 1,
      max_protocol: 1,
      manifest_url: "/bridge/update/manifest",
    });

    const v2Socket = await openRawWebSocket(handle, "1");
    const v2Close = nextClose(v2Socket);
    v2Socket.send(JSON.stringify(v2Hello));
    expect(await v2Close).toEqual({
      code: 4426,
      reason: JSON.stringify({
        min_protocol: 1,
        max_protocol: 1,
        manifest_url: "/bridge/update/manifest",
      }),
    });

    const upgrade = await websocketUpgradeRefusal(handle, "3");
    expect(upgrade.status).toBe(426);
    expect(upgrade.headers["content-type"]).toBe("application/json");
    expect(upgrade.body).toEqual({
      error: "no mutually supported RBP version",
      min_protocol: 1,
      max_protocol: 1,
      manifest_url: "/bridge/update/manifest",
    });
    await expect(startGatewayStub({
      statePath: await statePath("fake-rbp2-adapter"),
      tokenTable,
      supportedProtocols: [2, 1],
    })).rejects.toThrow(/only RBP\/1/u);
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
