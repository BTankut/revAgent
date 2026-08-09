import { Buffer } from "node:buffer";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import {
  applyCumulativeAck,
  type HelloAckEnvelope,
  type HelloEnvelope,
  type JsonValue,
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
      granted_capabilities: ["journal_v1", "chunked_results", "transport_streamable_http"],
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

function inlineResultPayload(invocationId: string): JsonValue {
  return {
    kind: "invocation",
    invocation_id: invocationId,
    status: "completed",
    result: {},
    replayed: false,
    metrics: {
      execute_ms: 0,
      request_bytes: 0,
      response_bytes: 0,
      framing: "length-prefixed",
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
  it.each(["shortcut.lnk", "pointer.URL", "alias.SyMlInK"])(
    "rejects producer-side unsafe artifact suffix %s",
    (filename) => {
      const root = temporaryRoot();
      const spool = new ArtifactSpool(join(root.path, "spool"), () => uuid());
      expect(() => spool.retain(uuid(), uuid(), [{
        filename,
        contentType: "application/octet-stream",
        bytes: Buffer.from("unsafe"),
      }])).toThrow(/invalid artifact basename/u);
      root.cleanup();
    },
  );

  it("validates ordinary drafts before persisting sequence state", () => {
    const root = temporaryRoot();
    const journal = new DurableBridgeJournal(join(root.path, "invalid-outbox.db"));
    const simulator = new BridgeSimulator(journal, new ArtifactSpool(join(root.path, "spool"), () => uuid()));
    const rsid = uuid();

    expect(() => simulator.queueOutbound(rsid, {
      type: "result",
      id: uuid(),
      ts: "2026-07-22T00:00:00.000Z",
      payload: {},
    })).toThrow(/invalid result data envelope/u);
    expect(journal.loadSequence(rsid).outbox).toEqual([]);

    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("reconstructs multi-file output and cleans durable spool only after ack, including after restart", () => {
    const root = temporaryRoot();
    const spoolRoot = join(root.path, "spool");
    let ids = new DeterministicUuid7Source();
    let spool = new ArtifactSpool(spoolRoot, () => ids.next());
    const rsid = uuid();
    const invocationId = uuid();
    const journalPath = join(root.path, "bridge.db");
    let journal = new DurableBridgeJournal(journalPath);
    let simulator = new BridgeSimulator(journal, spool);
    const carrier = spool.retain(rsid, invocationId, [
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
    const inspected = spool.inspectRetained([spool.compact(carrier)]);
    expect(inspected).toMatchObject({
      rootPathRedacted: true,
      rawPathExposed: false,
      carrierCount: 1,
      retainedFileCount: 2,
      totalSize: Buffer.byteLength('{"ok":true}\n') + Buffer.byteLength("evidence\n"),
    });
    expect(JSON.stringify(inspected)).not.toContain(spoolRoot);
    expect(() => spool.inspectRetained(
      Array.from({ length: 129 }, () => spool.compact(carrier)),
    )).toThrow(/retained carrier evidence exceeds 128/u);
    expect(() => spool.inspectRetained([{
      ...spool.compact(carrier),
      retainedDirectory: join(root.path, "outside"),
    }])).toThrow(/path does not match its composite identity/u);
    const queued = simulator.queueOutbound(rsid, {
      type: "result",
      id: uuid(),
      ts: "2026-07-22T00:00:00.000Z",
      payload: inlineResultPayload(invocationId),
    }, carrier);
    expect(existsSync(carrier.retainedDirectory)).toBe(true);
    expect(() => simulator.queueOutbound(rsid, {
      type: "result",
      id: uuid(),
      ts: "2026-07-22T00:00:01.000Z",
      payload: inlineResultPayload(uuid()),
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
      payload: inlineResultPayload(uuid()),
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

  it("rejects reparse escapes and bounds sanitized descriptor text without exposing source paths", () => {
    const root = temporaryRoot();
    const spoolRoot = join(root.path, "spool");
    const outside = join(root.path, "outside-artifacts");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.bin"), Buffer.from("secret"));
    const spool = new ArtifactSpool(spoolRoot, () => uuid());
    const linkedDirectory = join(spoolRoot, "linked-source");
    symlinkSync(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    const escapedPath = join(linkedDirectory, "secret.bin");
    expect(() => spool.captureDeclaredPaths(uuid(), uuid(), [{
      path: escapedPath,
      contentType: "application/octet-stream",
    }])).toThrow("declared artifact source could not be captured");

    const safeSource = join(spoolRoot, "safe-source.bin");
    writeFileSync(safeSource, Buffer.from("safe"));
    const longContentType = `application/x-${"a".repeat(4_082)}`;
    const carrier = spool.captureDeclaredPaths(uuid(), uuid(), [{
      path: safeSource,
      contentType: longContentType,
    }]);
    const evidence = spool.inspectRetained([spool.compact(carrier)]);
    expect(evidence.evidenceVersion).toBe(1);
    expect(evidence.carriers[0]?.streams[0]).toMatchObject({
      contentType: longContentType.slice(0, 128),
      contentTypeTruncated: true,
      contentTypeDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(spoolRoot);
    expect(serialized).not.toContain(escapedPath);
    expect(serialized).not.toContain(safeSource);
    expect(serialized).not.toContain(longContentType);

    root.cleanup();
  });

  it("accepts safe capture and rehydration through an aliased spool ancestor", () => {
    const root = temporaryRoot();
    try {
      const physicalRoot = join(root.path, "physical-root");
      const aliasedRoot = join(root.path, "aliased-root");
      mkdirSync(physicalRoot, { recursive: true });
      symlinkSync(physicalRoot, aliasedRoot, process.platform === "win32" ? "junction" : "dir");

      const spoolRoot = join(aliasedRoot, "spool");
      const spool = new ArtifactSpool(spoolRoot, () => uuid());
      const source = join(spoolRoot, "safe-source.bin");
      writeFileSync(source, Buffer.from("safe-through-alias"));

      const artifactCarrier = spool.captureDeclaredPaths(uuid(), uuid(), [{
        path: source,
        contentType: "application/octet-stream",
      }]);
      const chunkedCarrier = spool.retainChunkedResult(
        uuid(),
        uuid(),
        Buffer.from('{"safe":true}\n'),
      );

      expect(spool.inspectRetained([
        spool.compact(artifactCarrier),
        spool.compact(chunkedCarrier),
      ])).toMatchObject({
        carrierCount: 2,
        retainedFileCount: 2,
      });
    } finally {
      root.cleanup();
    }
  });

  it("finishes ACK cleanup after a crash left only part of the retained directory", () => {
    const root = temporaryRoot();
    const spoolRoot = join(root.path, "spool");
    const journalPath = join(root.path, "partial-cleanup.db");
    const rsid = uuid();
    const invocationId = uuid();
    let journal = new DurableBridgeJournal(journalPath);
    let spool = new ArtifactSpool(spoolRoot, () => uuid());
    let simulator = new BridgeSimulator(journal, spool);
    const carrier = spool.retain(rsid, invocationId, [
      { filename: "first.txt", contentType: "text/plain", bytes: Buffer.from("first") },
      { filename: "second.txt", contentType: "text/plain", bytes: Buffer.from("second") },
    ]);
    const queued = simulator.queueOutbound(rsid, {
      type: "result",
      id: uuid(),
      ts: "2026-07-22T00:00:00.000Z",
      payload: inlineResultPayload(invocationId),
    }, carrier);
    const acknowledged = applyCumulativeAck(journal.loadSequence(rsid), queued.seq);
    if (acknowledged.kind !== "advanced") throw new Error("test cumulative ACK was rejected");
    journal.saveSequence(acknowledged.state);
    rmSync(carrier.retainedFiles[0] as string);
    expect(existsSync(carrier.retainedDirectory)).toBe(true);
    simulator.close();
    journal.close();

    journal = new DurableBridgeJournal(journalPath);
    spool = new ArtifactSpool(spoolRoot, () => uuid());
    expect(() => {
      simulator = new BridgeSimulator(journal, spool);
    }).not.toThrow();
    expect(existsSync(carrier.retainedDirectory)).toBe(false);
    expect(journal.deliveryCarriersNeedingCleanup()).toEqual([]);
    simulator.close();
    journal.close();
    root.cleanup();
  });

  it("reconciles a crash-left unjournaled spool directory before invocation replay", () => {
    const root = temporaryRoot();
    const spoolRoot = join(root.path, "spool");
    const journalPath = join(root.path, "orphan.db");
    const rsid = uuid();
    const invocationId = uuid();
    let journal = new DurableBridgeJournal(journalPath);
    let spool = new ArtifactSpool(spoolRoot, () => uuid());
    let simulator = new BridgeSimulator(journal, spool);
    const orphan = spool.retain(rsid, invocationId, [
      { filename: "orphan.txt", contentType: "text/plain", bytes: Buffer.from("orphan") },
    ]);
    simulator.close();
    journal.close();

    journal = new DurableBridgeJournal(journalPath);
    spool = new ArtifactSpool(spoolRoot, () => uuid());
    simulator = new BridgeSimulator(journal, spool);
    expect(existsSync(orphan.retainedDirectory)).toBe(false);
    expect(() => spool.retain(rsid, invocationId, [
      { filename: "retry.txt", contentType: "text/plain", bytes: Buffer.from("retry") },
    ])).not.toThrow();
    simulator.close();
    journal.close();
    root.cleanup();
  });
});
