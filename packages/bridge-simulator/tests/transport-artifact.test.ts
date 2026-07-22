import { Buffer } from "node:buffer";
import { once } from "node:events";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import {
  type HelloAckEnvelope,
  type HelloEnvelope,
  type RbpEnvelope,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  ArtifactReconstructor,
  ArtifactSpool,
  DeterministicUuid7Source,
} from "../src/artifacts.js";
import { BridgeSimulator } from "../src/bridgeSimulator.js";
import { DurableBridgeJournal } from "../src/journal.js";
import {
  HttpSseGatewayBinding,
  WssGatewayBinding,
  gatewayCompatibilityWindow,
  openPrimaryThenFallback,
  selectHighestCompatibleProtocol,
  type GatewayBinding,
} from "../src/transport.js";
import { temporaryRoot, uuid } from "./helpers.js";

function hello(): HelloEnvelope {
  return {
    type: "hello",
    id: uuid(),
    ts: "2026-07-22T00:00:00.000Z",
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["journal_v1", "chunked_results", "transport_streamable_http"],
      bridge_version: "bridge-test",
      device_id: "device-01",
      machine: { hostname: "WS01", os: "Windows 11" },
      addin_versions: ["fixture"],
    },
  };
}

function helloAck(connectionId = "connection-01"): HelloAckEnvelope {
  return {
    type: "hello_ack",
    id: uuid(),
    ts: "2026-07-22T00:00:01.000Z",
    payload: {
      protocol: 1,
      connection_id: connectionId,
      granted_capabilities: ["journal_v1", "chunked_results"],
      heartbeat_interval_ms: 15_000,
      limits: {
        max_params_bytes: 4_194_304,
        max_result_bytes: 33_554_432,
        max_partial_bytes: 1_048_576,
      },
      manifest: { latest_bridge_version: "bridge-test", manifest_url: "/bridge/update/manifest" },
    },
  };
}

describe("transport bindings", () => {
  it("runs the WSS hello/text-frame lifecycle through an executable WebSocket peer", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const received: RbpEnvelope[] = [];
    server.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer device-token");
      expect(request.headers["x-rbp-versions"]).toBe("1");
      socket.on("message", (data, binary) => {
        expect(binary).toBe(false);
        const envelope = JSON.parse(data.toString()) as RbpEnvelope;
        received.push(envelope);
        if (envelope.type === "hello") socket.send(JSON.stringify(helloAck("wss-connection")));
        else {
          socket.send(JSON.stringify({
            v: 1,
            type: "goodbye",
            id: uuid(),
            ts: "2026-07-22T00:00:02.000Z",
            payload: { reason: "shutdown" },
          } satisfies RbpEnvelope));
        }
      });
    });
    const binding = new WssGatewayBinding({
      baseUrl: "wss://gateway.revagent.test/bridge/v1",
      deviceToken: "device-token",
      webSocketFactory: (url, options) => {
        expect(url).toBe("wss://gateway.revagent.test/bridge/v1");
        return new WebSocket(`ws://127.0.0.1:${address.port}`, options);
      },
    });
    try {
      await expect(binding.open(hello())).resolves.toMatchObject({
        payload: { connection_id: "wss-connection" },
      });
      await binding.send({
        v: 1,
        type: "heartbeat",
        id: uuid(),
        ts: "2026-07-22T00:00:01.500Z",
        payload: { bridge_version: "bridge-test", acks: [], sessions: [] },
      });
      await expect(binding.messages()[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        value: { type: "goodbye" },
      });
      expect(received.map((entry) => entry.type)).toEqual(["hello", "heartbeat"]);
    } finally {
      await binding.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("implements the exact create/events/messages HTTP/SSE lifecycle", async () => {
    const calls: Array<{ readonly url: string; readonly method: string; readonly headers: Headers }> = [];
    const eventEnvelope: RbpEnvelope = {
      v: 1,
      type: "goodbye",
      id: uuid(),
      ts: "2026-07-22T00:00:01.500Z",
      payload: { reason: "shutdown" },
    };
    const fetchMock: typeof fetch = async (input, init = {}) => {
      const url = input instanceof URL ? input.toString() : String(input);
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      calls.push({ url, method, headers });
      if (url.endsWith("/bridge/v1/http/connections")) {
        const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(sent).not.toHaveProperty("v");
        return new Response(JSON.stringify(helloAck()), {
          status: 201,
          headers: { "RBP-Connection-Id": "connection-01", "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/events")) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: rbp\ndata: ${JSON.stringify(eventEnvelope)}\n\n`));
            controller.close();
          },
        }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8" },
        });
      }
      if (url.endsWith("/messages")) return new Response(null, { status: 202 });
      return new Response(null, { status: 404 });
    };
    const binding = new HttpSseGatewayBinding({
      baseUrl: "https://gateway.revagent.app",
      deviceToken: "device-token",
      fetch: fetchMock,
    });
    expect(await binding.open(hello())).toMatchObject({ type: "hello_ack", payload: { connection_id: "connection-01" } });
    await expect(binding.messages()[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: { type: "goodbye", payload: { reason: "shutdown" } },
    });
    await binding.send({
      v: 1,
      type: "cancel",
      id: uuid(),
      rsid: uuid(),
      seq: 1,
      ts: "2026-07-22T00:00:02.000Z",
      payload: { invocation_id: uuid(), reason: "user_requested" },
    });
    await binding.close();
    expect(calls.map((call) => [new URL(call.url).pathname, call.method])).toEqual([
      ["/bridge/v1/http/connections", "POST"],
      ["/bridge/v1/http/connections/connection-01/events", "GET"],
      ["/bridge/v1/http/connections/connection-01/messages", "POST"],
    ]);
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer device-token")).toBe(true);
    expect(calls.every((call) => call.headers.get("x-rbp-versions") === "1")).toBe(true);
  });

  it("negotiates only gateway N/N-1 and falls back only on provisioned retryable network failure", async () => {
    expect(gatewayCompatibilityWindow(4)).toEqual([4, 3]);
    expect(selectHighestCompatibleProtocol({ bridgeMin: 2, bridgeMax: 3, gatewayCurrent: 4 })).toBe(3);
    expect(selectHighestCompatibleProtocol({ bridgeMin: 1, bridgeMax: 2, gatewayCurrent: 4 })).toBeNull();
    const ack = helloAck();
    let primaryCloseCount = 0;
    const primary = fakeBinding(
      "wss",
      async () => { throw new Error("network down"); },
      async () => { primaryCloseCount += 1; },
    );
    const fallback = fakeBinding("streamable_http_sse", async () => ack);
    const result = await openPrimaryThenFallback({
      hello: hello(),
      wss: primary,
      fallback,
      fallbackProvisioned: true,
      classifyWssFailure: () => "retryable_network",
    });
    expect(result.binding.kind).toBe("streamable_http_sse");
    expect(primaryCloseCount).toBe(1);
    await expect(openPrimaryThenFallback({
      hello: hello(),
      wss: primary,
      fallback,
      fallbackProvisioned: true,
      classifyWssFailure: () => "auth",
    })).rejects.toThrow("network down");
    expect(primaryCloseCount).toBe(2);
  });
});

function fakeBinding(
  kind: GatewayBinding["kind"],
  open: (value: HelloEnvelope) => Promise<HelloAckEnvelope>,
  close: () => Promise<void> = async () => undefined,
): GatewayBinding {
  return {
    kind,
    connectionId: null,
    bufferedAmount: 0,
    open,
    send: async () => undefined,
    messages: () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<RbpEnvelope> {
        return;
      },
    }),
    close,
  };
}

describe("artifact, outbox, resume, and backoff", () => {
  it("reconstructs multi-file output and cleans durable spool only after ack, including after restart", () => {
    const root = temporaryRoot();
    const spoolRoot = join(root.path, "spool");
    let ids = new DeterministicUuid7Source();
    let spool = new ArtifactSpool(spoolRoot, () => ids.next());
    const invocationId = uuid();
    const carrier = spool.retain(invocationId, [
      { filename: "report.json", contentType: "application/json", bytes: Buffer.from('{"ok":true}\n') },
      { filename: "evidence.txt", contentType: "text/plain", bytes: Buffer.from("evidence\n") },
    ]);
    const reconstruct = new ArtifactReconstructor(invocationId);
    carrier.partials.forEach((chunk) => reconstruct.append(chunk));
    const completed = reconstruct.finalize(carrier.result.artifacts, carrier.descriptors);
    expect(completed.map((stream) => Buffer.from(stream.bytes).toString("utf8"))).toEqual([
      '{"ok":true}\n',
      "evidence\n",
    ]);

    const journalPath = join(root.path, "bridge.db");
    let journal = new DurableBridgeJournal(journalPath);
    let simulator = new BridgeSimulator(journal, spool);
    const rsid = uuid();
    const queued = simulator.queueOutbound(rsid, {
      type: "result",
      id: uuid(),
      ts: "2026-07-22T00:00:00.000Z",
      payload: { invocation_id: invocationId },
    }, carrier);
    expect(existsSync(carrier.retainedDirectory)).toBe(true);
    expect(() => simulator.queueOutbound(rsid, {
      type: "result",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: {},
    })).toThrow(/window=1/u);
    simulator.close();
    journal.close();

    journal = new DurableBridgeJournal(journalPath);
    ids = new DeterministicUuid7Source();
    spool = new ArtifactSpool(spoolRoot, () => ids.next());
    simulator = new BridgeSimulator(journal, spool);
    expect(simulator.retransmit(rsid, "2026-07-22T00:00:02.000Z")).toMatchObject([
      { seq: queued.seq, payload: queued.payload },
    ]);
    expect(existsSync(carrier.retainedDirectory)).toBe(true);
    expect(simulator.acknowledgeOutbound(rsid, queued.seq)).toEqual([queued.seq]);
    expect(existsSync(carrier.retainedDirectory)).toBe(false);
    const next = simulator.queueOutbound(rsid, {
      type: "result",
      id: uuid(),
      ts: "2026-07-22T00:00:03.000Z",
      payload: {},
    });
    expect(next.seq).toBe(queued.seq + 1);
    expect(simulator.reconnectDelay(0, 0)).toBe(0);
    expect(simulator.reconnectDelay(0, 0.999999)).toBe(1000);
    expect(simulator.shouldResetReconnect(119_999)).toBe(false);
    expect(simulator.shouldResetReconnect(120_000)).toBe(true);
    simulator.close();
    journal.close();
    root.cleanup();
  });
});
