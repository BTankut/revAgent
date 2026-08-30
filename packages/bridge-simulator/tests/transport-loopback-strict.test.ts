import { Buffer } from "node:buffer";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FrameDecoder,
  encodeFrame,
  type JsonObject,
} from "@revagent/addin-loopback-fixture";
import {
  type HelloAckEnvelope,
  type HelloEnvelope,
  type RbpEnvelope,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { PersistentAddinClient } from "../src/loopback.js";
import {
  GatewayTransportError,
  HttpSseGatewayBinding,
  WssGatewayBinding,
  classifyGatewayTransportFailure,
  openPrimaryThenFallback,
  type GatewayBinding,
} from "../src/transport.js";
import { createTestTlsIdentity } from "./tlsFixture.js";

let idCounter = 10_000;

const TEST_TLS_HOSTNAME = "gateway.revagent.test";

function uuid(): string {
  idCounter += 1;
  return `0197a3c2-0000-7000-8000-${idCounter.toString().padStart(12, "0")}`;
}

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

function helloAck(connectionId: string): HelloAckEnvelope {
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

function goodbye(): RbpEnvelope {
  return {
    v: 1,
    type: "goodbye",
    id: uuid(),
    ts: "2026-07-22T00:00:02.000Z",
    payload: { reason: "shutdown" },
  };
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function testTlsTrust(root: string, certificate: string) {
  const caCertificatePath = join(root, "gateway-test-ca.pem");
  writeFileSync(caCertificatePath, certificate, { encoding: "utf8", flag: "wx" });
  return {
    caCertificatePath,
    caCertificateSha256: sha256(certificate),
    serverCertificateSha256: sha256(new X509Certificate(certificate).raw),
  };
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeAllConnections();
  });
}

describe("strict Gateway transport boundaries", () => {
  it("connects real WSS on numeric loopback only through an exact CA and leaf pin", async () => {
    const identity = createTestTlsIdentity("127.0.0.1");
    const root = mkdtempSync(join(tmpdir(), "bridge-wss-trust-"));
    const trust = testTlsTrust(root, identity.certificate);
    const server = createHttpsServer({
      cert: identity.certificate,
      key: identity.privateKey,
    });
    const websocketServer = new WebSocketServer({ server });
    websocketServer.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer device-token");
      socket.once("message", () => socket.send(JSON.stringify(helloAck("loopback-tls"))));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const binding = new WssGatewayBinding({
      baseUrl: `wss://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_tls",
      testTlsTrust: trust,
    });
    try {
      expect(binding.testTlsTrustEvidence).toEqual(trust);
      await expect(binding.open(hello())).resolves.toMatchObject({
        payload: { connection_id: "loopback-tls" },
      });
    } finally {
      await binding.close();
      websocketServer.close();
      await closeHttpServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the wrong explicit CA and classifies the failure as terminal trust", async () => {
    const identity = createTestTlsIdentity("127.0.0.1");
    const wrongCa = createTestTlsIdentity("127.0.0.1");
    const root = mkdtempSync(join(tmpdir(), "bridge-wss-wrong-ca-"));
    const trust = {
      ...testTlsTrust(root, wrongCa.certificate),
      serverCertificateSha256: sha256(new X509Certificate(identity.certificate).raw),
    };
    const server = createHttpsServer({
      cert: identity.certificate,
      key: identity.privateKey,
    });
    const websocketServer = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const binding = new WssGatewayBinding({
      baseUrl: `wss://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_tls",
      testTlsTrust: trust,
    });
    try {
      await expect(binding.open(hello())).rejects.toMatchObject({ faultClass: "trust" });
    } finally {
      await binding.close();
      websocketServer.close();
      await closeHttpServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a valid CA with the wrong current-stack leaf pin", async () => {
    const identity = createTestTlsIdentity("127.0.0.1");
    const otherIdentity = createTestTlsIdentity("127.0.0.1");
    const root = mkdtempSync(join(tmpdir(), "bridge-wss-wrong-leaf-"));
    const trust = {
      ...testTlsTrust(root, identity.certificate),
      serverCertificateSha256: sha256(new X509Certificate(otherIdentity.certificate).raw),
    };
    const server = createHttpsServer({
      cert: identity.certificate,
      key: identity.privateKey,
    });
    const websocketServer = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const binding = new WssGatewayBinding({
      baseUrl: `wss://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_tls",
      testTlsTrust: trust,
    });
    try {
      await expect(binding.open(hello())).rejects.toMatchObject({ faultClass: "trust" });
    } finally {
      await binding.close();
      websocketServer.close();
      await closeHttpServer(server);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects LAN and hostname targets before reading a loopback test TLS trust file", () => {
    const missingTrust = {
      caCertificatePath: join(tmpdir(), "must-not-be-read.pem"),
      caCertificateSha256: `sha256:${"0".repeat(64)}`,
      serverCertificateSha256: `sha256:${"0".repeat(64)}`,
    };
    for (const host of ["192.168.90.154", "localhost"]) {
      expect(() => new WssGatewayBinding({
        baseUrl: `wss://${host}:443/bridge/v1`,
        deviceToken: "device-token",
        endpointPolicy: "loopback_test_tls",
        testTlsTrust: missingTrust,
      })).toThrow(/numeric loopback/u);
    }
  });

  it("cannot reuse the loopback TLS trust object as a production, cleartext, HTTP, or factory bypass", () => {
    const identity = createTestTlsIdentity("127.0.0.1");
    const root = mkdtempSync(join(tmpdir(), "bridge-wss-no-bypass-"));
    const trust = testTlsTrust(root, identity.certificate);
    try {
      expect(() => new WssGatewayBinding({
        baseUrl: "wss://gateway.revagent.test/bridge/v1",
        deviceToken: "device-token",
        testTlsTrust: trust,
      })).toThrow(/accepted only by loopback_test_tls WSS/u);
      expect(() => new WssGatewayBinding({
        baseUrl: "ws://127.0.0.1:8443/bridge/v1",
        deviceToken: "device-token",
        endpointPolicy: "loopback_test_readiness",
        testTlsTrust: trust,
      })).toThrow(/accepted only by loopback_test_tls WSS/u);
      expect(() => new HttpSseGatewayBinding({
        baseUrl: "http://127.0.0.1:8443/bridge/v1/http/connections",
        deviceToken: "device-token",
        endpointPolicy: "loopback_test_readiness",
        testTlsTrust: trust,
      })).toThrow(/restricted to the numeric-loopback WSS binding/u);
      expect(() => new WssGatewayBinding({
        baseUrl: "wss://127.0.0.1:8443/bridge/v1",
        deviceToken: "device-token",
        endpointPolicy: "loopback_test_tls",
        testTlsTrust: trust,
        webSocketFactory: () => {
          throw new Error("must not be called");
        },
      })).toThrow(/cannot be combined with a WebSocket factory/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("completes a real trusted TLS WebSocket hello and data handshake", async () => {
    const identity = createTestTlsIdentity(TEST_TLS_HOSTNAME);
    const server = createHttpsServer({
      cert: identity.certificate,
      key: identity.privateKey,
    });
    const websocketServer = new WebSocketServer({ server });
    websocketServer.on("connection", (socket, request) => {
      expect(request.headers.authorization).toBe("Bearer device-token");
      expect((request.socket as unknown as { readonly servername?: string }).servername).toBe(TEST_TLS_HOSTNAME);
      socket.on("message", (data, binary) => {
        expect(binary).toBe(false);
        const envelope = JSON.parse(data.toString("utf8")) as RbpEnvelope;
        if (envelope.type === "hello") socket.send(JSON.stringify(helloAck("tls-connection")));
        else socket.send(JSON.stringify(goodbye()));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const binding = new WssGatewayBinding({
      baseUrl: `wss://${TEST_TLS_HOSTNAME}:${port}/bridge/v1`,
      deviceToken: "device-token",
      webSocketFactory: (url, options) => {
        expect(url).toBe(`wss://${TEST_TLS_HOSTNAME}:${port}/bridge/v1`);
        const tlsOptions = {
          ...options,
          ca: identity.certificate,
          rejectUnauthorized: true,
          servername: TEST_TLS_HOSTNAME,
        } as WebSocket.ClientOptions & { readonly servername: string };
        return new WebSocket(`wss://127.0.0.1:${port}/bridge/v1`, tlsOptions);
      },
    });
    try {
      await expect(binding.open(hello())).resolves.toMatchObject({
        payload: { connection_id: "tls-connection" },
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
    } finally {
      await binding.close();
      websocketServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
        server.closeAllConnections();
      });
    }
  });

  it("uses T5 numeric-loopback readiness URLs only under the explicit test policy", async () => {
    let resolveSseClosed: () => void = () => undefined;
    const sseClosed = new Promise<void>((resolve) => {
      resolveSseClosed = resolve;
    });
    const server = createHttpServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://loopback.invalid").pathname;
      if (request.method === "POST" && path === "/bridge/v1/http/connections") {
        response.writeHead(201, {
          "Content-Type": "application/json",
          "RBP-Connection-Id": "http-connection",
        });
        response.end(JSON.stringify(helloAck("http-connection")));
        return;
      }
      if (request.method === "GET" && path === "/bridge/v1/http/connections/http-connection/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.once("close", resolveSseClosed);
        response.write(`event: rbp\ndata: ${JSON.stringify(goodbye())}\n\n`);
        return;
      }
      if (request.method === "POST" && path === "/bridge/v1/http/connections/http-connection/messages") {
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const websocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify(helloAck("ws-connection")));
        socket.send(JSON.stringify(goodbye()));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const readiness = {
      ws_url: `ws://127.0.0.1:${port}/bridge/v1`,
      http_connection_url: `http://127.0.0.1:${port}/bridge/v1/http/connections`,
    };
    expect(() => new WssGatewayBinding({
      baseUrl: readiness.ws_url,
      deviceToken: "device-token",
    })).toThrow(/Production Gateway wss:/u);
    expect(() => new HttpSseGatewayBinding({
      baseUrl: readiness.http_connection_url,
      deviceToken: "device-token",
    })).toThrow(/Production Gateway https:/u);
    expect(() => new WssGatewayBinding({
      baseUrl: `ws://gateway.example:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    })).toThrow(/numeric loopback/u);

    const wss = new WssGatewayBinding({
      baseUrl: readiness.ws_url,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    const fallback = new HttpSseGatewayBinding({
      baseUrl: readiness.http_connection_url,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    try {
      await expect(wss.open(hello())).resolves.toMatchObject({
        payload: { connection_id: "ws-connection" },
      });
      await expect(wss.messages()[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        value: { type: "goodbye" },
      });
      await expect(fallback.open(hello())).resolves.toMatchObject({
        payload: { connection_id: "http-connection" },
      });
      await expect(fallback.messages()[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        value: { type: "goodbye" },
      });
      await fallback.send({
        v: 1,
        type: "heartbeat",
        id: uuid(),
        ts: "2026-07-22T00:00:03.000Z",
        payload: { bridge_version: "bridge-test", acks: [], sessions: [] },
      });
      await fallback.close();
      await Promise.race([
        sseClosed,
        new Promise<never>((_resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("SSE cleanup was not observed")), 1_000);
          timeout.unref();
        }),
      ]);
    } finally {
      await wss.close();
      await fallback.close();
      websocketServer.close();
      await closeHttpServer(server);
    }
  });

  it.each([
    [4401, "device revoked", "auth"],
    [4403, "seat denied", "auth"],
    [4426, "unsupported version", "version"],
  ] as const)("preserves terminal WSS close %i and never falls back", async (code, reason, faultClass) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    server.on("connection", (socket) => socket.once("message", () => socket.close(code, reason)));
    const binding = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    let fallbackOpenCount = 0;
    const fallback = fakeBinding(async () => {
      fallbackOpenCount += 1;
      return helloAck("fallback");
    });
    try {
      const selected = openPrimaryThenFallback({
        hello: hello(),
        wss: binding,
        fallback,
        fallbackProvisioned: true,
        classifyWssFailure: () => "retryable_network",
      });
      await expect(selected).rejects.toMatchObject({
        name: "GatewayTransportError",
        faultClass,
        closeCode: code,
        closeReason: reason,
      });
      expect(binding.closeInfo).toEqual({ code, reason });
      expect(fallbackOpenCount).toBe(0);
    } finally {
      await binding.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it("preserves bounded HTTP 426 version metadata and Retry-After without fallback", async () => {
    const server = createHttpServer();
    server.on("upgrade", (_request, socket) => {
      const body = JSON.stringify({
        min_protocol: 2,
        max_protocol: 3,
        manifest_url: "/bridge/update/manifest/next",
      });
      socket.end(
        "HTTP/1.1 426 Upgrade Required\r\n" +
        "Connection: close\r\n" +
        "Content-Type: application/json\r\n" +
        "Retry-After: 12\r\n" +
        `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const binding = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    try {
      const opening = binding.open(hello());
      await expect(opening).rejects.toMatchObject({
        faultClass: "version",
        httpStatus: 426,
        protocolMin: 2,
        protocolMax: 3,
        manifestUrl: "/bridge/update/manifest/next",
        retryAfterMs: 12_000,
      });
      await opening.catch((error: unknown) => {
        expect(classifyGatewayTransportFailure(error)).toBe("version");
      });
    } finally {
      await binding.close();
      await closeHttpServer(server);
    }
  });

  it("rejects duplicate Gateway keys and oversize control frames at the raw WSS boundary", async () => {
    const frames = [
      JSON.stringify(helloAck("duplicate")).replace(
        '"type":"hello_ack"',
        '"type":"hello_ack","type":"hello_ack"',
      ),
      JSON.stringify({
        ...helloAck("oversize"),
        payload: {
          ...helloAck("oversize").payload,
          manifest: { latest_bridge_version: "bridge-test", manifest_url: `/${"x".repeat(70_000)}` },
        },
      }),
    ];
    for (const frame of frames) {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const port = (server.address() as AddressInfo).port;
      server.on("connection", (socket) => socket.once("message", () => socket.send(frame)));
      const binding = new WssGatewayBinding({
        baseUrl: `ws://127.0.0.1:${port}/bridge/v1`,
        deviceToken: "device-token",
        endpointPolicy: "loopback_test_readiness",
      });
      try {
        await expect(binding.open(hello())).rejects.toMatchObject({ faultClass: "protocol" });
      } finally {
        await binding.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error === undefined ? resolve() : reject(error));
        });
      }
    }
  });

  it("uses fatal UTF-8 decoding for the HTTP hello_ack body", async () => {
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetch: async () => new Response(Uint8Array.from([0xc3, 0x28]), {
        status: 201,
        headers: { "RBP-Connection-Id": "invalid-utf8" },
      }),
    });
    await expect(binding.open(hello())).rejects.toMatchObject({ code: "invalid_utf8" });
  });

  it("retains HTTP/SSE create 426 metadata and ignores an out-of-window Retry-After", async () => {
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetch: async () => new Response(JSON.stringify({
        min_protocol: 2,
        max_protocol: 4,
        manifest_url: "/bridge/update/manifest/rbp4",
      }), {
        status: 426,
        headers: { "Content-Type": "application/json", "Retry-After": "901" },
      }),
    });
    await expect(binding.open(hello())).rejects.toMatchObject({
      faultClass: "version",
      httpStatus: 426,
      protocolMin: 2,
      protocolMax: 4,
      manifestUrl: "/bridge/update/manifest/rbp4",
      retryAfterMs: null,
    });
  });

  it("treats an invalid UTF-8 WSS hello_ack frame as terminal protocol and never falls back", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    server.on("connection", (socket) => socket.once("message", () => {
      socket.send(Buffer.from([0xc3, 0x28]), { binary: false });
    }));
    const primary = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    let fallbackOpenCount = 0;
    const fallback = fakeBinding(async () => {
      fallbackOpenCount += 1;
      return helloAck("must-not-open");
    });
    try {
      await expect(openPrimaryThenFallback({
        hello: hello(),
        wss: primary,
        fallback,
        fallbackProvisioned: true,
        classifyWssFailure: () => "retryable_network",
      })).rejects.toMatchObject({ faultClass: "protocol" });
      expect(fallbackOpenCount).toBe(0);
    } finally {
      await primary.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it("rejects fallback selection when its hello_ack omits the transport grant", async () => {
    let fallbackCloseCount = 0;
    const primary: GatewayBinding = {
      kind: "wss",
      connectionId: null,
      bufferedAmount: 0,
      open: async () => {
        throw new GatewayTransportError("network reset", { faultClass: "retryable_network" });
      },
      send: async () => undefined,
      messages: () => ({
        async *[Symbol.asyncIterator](): AsyncIterator<RbpEnvelope> { return; },
      }),
      close: async () => undefined,
    };
    const ack = helloAck("missing-fallback-grant");
    ack.payload.granted_capabilities = ["journal_v1", "chunked_results"];
    const fallback: GatewayBinding = {
      ...fakeBinding(async () => ack),
      close: async () => { fallbackCloseCount += 1; },
    };
    await expect(openPrimaryThenFallback({
      hello: hello(),
      wss: primary,
      fallback,
      fallbackProvisioned: true,
      classifyWssFailure: () => "retryable_network",
    })).rejects.toMatchObject({ faultClass: "protocol" });
    expect(fallbackCloseCount).toBe(1);
  });

  it("bounds the WSS hello_ack wait and releases the live socket", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    server.on("connection", (socket) => socket.on("message", () => undefined));
    const binding = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      openTimeoutMs: 25,
    });
    try {
      await expect(binding.open(hello())).rejects.toMatchObject({
        faultClass: "retryable_network",
        message: expect.stringContaining("hello_ack timed out"),
      });
    } finally {
      await binding.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it("bounds HTTP create and send waits while exposing and clearing backpressure", async () => {
    const neverFetch: typeof fetch = async (_input, init = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const opening = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetchTimeoutMs: 20,
      fetch: neverFetch,
    });
    await expect(opening.open(hello())).rejects.toMatchObject({
      faultClass: "retryable_network",
      message: expect.stringContaining("create timed out"),
    });

    let call = 0;
    let eventReaderCancelled = false;
    const fetchMock: typeof fetch = async (_input, init = {}) => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify(helloAck("backpressure")), {
          status: 201,
          headers: { "RBP-Connection-Id": "backpressure" },
        });
      }
      if (call === 2) {
        return new Response(new ReadableStream<Uint8Array>({
          cancel() {
            eventReaderCancelled = true;
          },
        }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetchTimeoutMs: 20,
      fetch: fetchMock,
    });
    await binding.open(hello());
    const sending = binding.send({
      v: 1,
      type: "heartbeat",
      id: uuid(),
      ts: "2026-07-22T00:00:03.000Z",
      payload: { bridge_version: "bridge-test", acks: [], sessions: [] },
    });
    expect(binding.bufferedAmount).toBeGreaterThan(0);
    await expect(sending).rejects.toMatchObject({
      faultClass: "retryable_network",
      message: expect.stringContaining("message send timed out"),
    });
    expect(binding.bufferedAmount).toBe(0);
    await binding.close();
    expect(eventReaderCancelled).toBe(true);
  });

  it("retains the singular HTTP chunk fault and leaves ordinary sends fail-closed", async () => {
    const sentBodies: JsonObject[] = [];
    let eventReaderCancelled = false;
    let call = 0;
    const fetchMock: typeof fetch = async (_input, init = {}) => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify(helloAck("chunk-fault")), {
          status: 201,
          headers: { "RBP-Connection-Id": "chunk-fault" },
        });
      }
      if (call === 2) {
        return new Response(new ReadableStream<Uint8Array>({
          cancel() { eventReaderCancelled = true; },
        }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      sentBodies.push(JSON.parse(String(init.body)) as JsonObject);
      return new Response(JSON.stringify({ error: "authenticated early HTTP chunk fault" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    };
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetch: fetchMock,
    });
    try {
      await binding.open(hello());
      await expect(binding.sendChunkConformanceFrame?.({
        type: "result", vector: "invalid-target",
      })).resolves.toEqual({
        binding: "streamable_http_sse",
        accepted: false,
        source: "authenticated_http_response",
        faultClass: "protocol",
        httpStatus: 400,
        closeCode: null,
        closeReason: null,
        message: "authenticated early HTTP chunk fault",
      });
      expect(sentBodies).toEqual([{ type: "result", vector: "invalid-target" }]);

      await expect(binding.send({
        v: 1,
        type: "heartbeat",
        id: uuid(),
        ts: "2026-07-22T00:00:03.000Z",
        payload: { bridge_version: "bridge-test", acks: [], sessions: [] },
      })).rejects.toMatchObject({
        faultClass: "protocol",
        httpStatus: 400,
      });
      expect(sentBodies).toHaveLength(2);
    } finally {
      await binding.close();
    }
    expect(eventReaderCancelled).toBe(true);
  });

  it("orders same-session data before unregister without globally serializing HTTP uplink", async () => {
    const firstRsid = uuid();
    const secondRsid = uuid();
    const started: string[] = [];
    let releaseFirstData!: () => void;
    let markFirstDataStarted!: () => void;
    const firstDataGate = new Promise<void>((resolve) => { releaseFirstData = resolve; });
    const firstDataStarted = new Promise<void>((resolve) => { markFirstDataStarted = resolve; });
    let call = 0;
    const fetchMock: typeof fetch = async (_input, init = {}) => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify(helloAck("session-ordering")), {
          status: 201,
          headers: { "RBP-Connection-Id": "session-ordering" },
        });
      }
      if (call === 2) {
        return new Response(new ReadableStream<Uint8Array>(), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      const envelope = JSON.parse(String(init.body)) as RbpEnvelope;
      const rsid = "rsid" in envelope
        ? envelope.rsid
        : envelope.type === "session_unregister"
          ? envelope.payload.rsid
          : "connection";
      started.push(`${envelope.type}:${rsid}`);
      if (envelope.type === "doc_context_update" && envelope.rsid === firstRsid) {
        markFirstDataStarted();
        await firstDataGate;
      }
      return new Response(null, { status: 202 });
    };
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetch: fetchMock,
    });
    const context = (rsid: string, seq: number): RbpEnvelope => ({
      v: 1,
      type: "doc_context_update",
      id: uuid(),
      rsid,
      seq,
      ack: 0,
      ts: "2026-07-22T00:00:03.000Z",
      payload: {
        documents: [],
        active_document: null,
        active_view: null,
      },
    });

    await binding.open(hello());
    const firstData = binding.send(context(firstRsid, 1));
    await firstDataStarted;
    const unregister = binding.send({
      v: 1,
      type: "session_unregister",
      id: uuid(),
      ts: "2026-07-22T00:00:04.000Z",
      payload: { rsid: firstRsid, reason: "operator_requested" },
    });
    const secondData = binding.send(context(secondRsid, 1));
    const heartbeat = binding.send({
      v: 1,
      type: "heartbeat",
      id: uuid(),
      ts: "2026-07-22T00:00:05.000Z",
      payload: { bridge_version: "bridge-test", acks: [], sessions: [] },
    });
    const register = binding.send({
      v: 1,
      type: "session_register",
      id: uuid(),
      ts: "2026-07-22T00:00:06.000Z",
      payload: {
        local_session_key: "port:55999:pid:42",
        user_hint: { name: "fixture-user" },
        machine: { hostname: "fixture-host", fingerprint: `sha256:${"0".repeat(64)}` },
        revit: { version: "2025", build: "fixture-build", pid: 42 },
        addin_version: "fixture-1.0.0",
        result_contract_version: 2,
        session_capabilities: [],
        bridge_version: "bridge-test",
        documents: [],
        port: 55999,
      },
    });

    await secondData;
    expect(started).toContain(`doc_context_update:${secondRsid}`);
    expect(started).not.toContain(`session_unregister:${firstRsid}`);
    expect(started).not.toContain("heartbeat:connection");
    expect(started).not.toContain("session_register:connection");

    releaseFirstData();
    await Promise.all([firstData, unregister, heartbeat, register]);
    expect(started.indexOf(`session_unregister:${firstRsid}`)).toBeGreaterThan(
      started.indexOf(`doc_context_update:${firstRsid}`),
    );
    expect(started.indexOf("heartbeat:connection")).toBeGreaterThan(
      started.indexOf(`session_unregister:${firstRsid}`),
    );
    expect(started.indexOf("session_register:connection")).toBeGreaterThan(
      started.indexOf("heartbeat:connection"),
    );
    await binding.close();
  });

  it("classifies a real nested HTTP TLS failure as terminal trust", async () => {
    const identity = createTestTlsIdentity(TEST_TLS_HOSTNAME);
    const server = createHttpsServer({ cert: identity.certificate, key: identity.privateKey }, (_request, response) => {
      response.writeHead(201);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const binding = new HttpSseGatewayBinding({
      baseUrl: `https://${TEST_TLS_HOSTNAME}`,
      deviceToken: "device-token",
      fetchTimeoutMs: 1_000,
      fetch: async (_input, init) => await fetch(
        `https://127.0.0.1:${port}/bridge/v1/http/connections`,
        init,
      ),
    });
    try {
      await expect(binding.open(hello())).rejects.toMatchObject({ faultClass: "trust" });
    } finally {
      await binding.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
        server.closeAllConnections();
      });
    }
  });

  it("bounds header-complete HTTP hello and error bodies that never reach EOF", async () => {
    let helloCancelled = false;
    const helloBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(JSON.stringify(helloAck("open-body")), "utf8"));
      },
      cancel() {
        helloCancelled = true;
      },
    });
    const helloBinding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetchTimeoutMs: 20,
      fetch: async () => new Response(helloBody, {
        status: 201,
        headers: { "RBP-Connection-Id": "open-body" },
      }),
    });
    await expect(helloBinding.open(hello())).rejects.toMatchObject({
      faultClass: "retryable_network",
      message: expect.stringContaining("body timed out"),
    });
    expect(helloCancelled).toBe(true);

    let errorCancelled = false;
    const errorBinding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetchTimeoutMs: 20,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          errorCancelled = true;
        },
      }), { status: 503 }),
    });
    await expect(errorBinding.open(hello())).rejects.toMatchObject({
      faultClass: "retryable_network",
      httpStatus: 503,
    });
    expect(errorCancelled).toBe(true);
  });

  it.each([408, 429] as const)("treats WSS HTTP %i as fallback-eligible", async (status) => {
    const server = createHttpServer();
    server.on("upgrade", (_request, socket) => {
      socket.end(
        `HTTP/1.1 ${status} Retry\r\nConnection: close\r\nRetry-After: 30\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const primary = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    let fallbackOpenCount = 0;
    const fallback = fakeBinding(async () => {
      fallbackOpenCount += 1;
      return helloAck(`fallback-${status}`);
    });
    try {
      await expect(openPrimaryThenFallback({
        hello: hello(),
        wss: primary,
        fallback,
        fallbackProvisioned: true,
        classifyWssFailure: classifyGatewayTransportFailure,
      })).resolves.toMatchObject({ binding: fallback });
      expect(fallbackOpenCount).toBe(1);
    } finally {
      await primary.close();
      await closeHttpServer(server);
    }
  });

  it.each([200, 302] as const)("treats unexpected WSS HTTP %i as terminal protocol without fallback", async (status) => {
    const server = createHttpServer();
    server.on("upgrade", (_request, socket) => {
      const reason = status === 200 ? "OK" : "Found";
      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const primary = new WssGatewayBinding({
      baseUrl: `ws://127.0.0.1:${port}/bridge/v1`,
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
    });
    let fallbackOpenCount = 0;
    const fallback = fakeBinding(async () => {
      fallbackOpenCount += 1;
      return helloAck(`fallback-${status}`);
    });
    try {
      await expect(openPrimaryThenFallback({
        hello: hello(),
        wss: primary,
        fallback,
        fallbackProvisioned: true,
        classifyWssFailure: classifyGatewayTransportFailure,
      })).rejects.toMatchObject({
        faultClass: "protocol",
        httpStatus: status,
      });
      expect(fallbackOpenCount).toBe(0);
    } finally {
      await primary.close();
      await closeHttpServer(server);
    }
  });

  it.each([404, 410] as const)("treats HTTP/SSE events HTTP %i as retryable connection expiry", async (status) => {
    let call = 0;
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetch: async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify(helloAck("expired-events")), {
            status: 201,
            headers: { "RBP-Connection-Id": "expired-events", "Content-Type": "application/json" },
          });
        }
        return new Response(null, { status });
      },
    });

    await expect(binding.open(hello())).rejects.toMatchObject({
      faultClass: "retryable_network",
      httpStatus: status,
    });
    expect(binding.connectionId).toBeNull();
    await binding.close();
  });

  it.each([404, 410] as const)("invalidates HTTP/SSE connection after messages HTTP %i", async (status) => {
    let call = 0;
    let eventsCancelled = false;
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetch: async () => {
        call += 1;
        if (call === 1) {
          return new Response(JSON.stringify(helloAck("expired-send")), {
            status: 201,
            headers: { "RBP-Connection-Id": "expired-send", "Content-Type": "application/json" },
          });
        }
        if (call === 2) {
          return new Response(new ReadableStream<Uint8Array>({
            cancel() { eventsCancelled = true; },
          }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        return new Response(null, { status });
      },
    });
    await binding.open(hello());
    await expect(binding.send({
      v: 1,
      type: "heartbeat",
      id: uuid(),
      ts: "2026-07-22T00:00:03.000Z",
      payload: { bridge_version: "bridge-test", acks: [], sessions: [] },
    })).rejects.toMatchObject({
      faultClass: "retryable_network",
      httpStatus: status,
    });
    expect(binding.connectionId).toBeNull();
    expect(eventsCancelled).toBe(true);
    await binding.close();
  });

  it("retains bounded Retry-After on HTTP/SSE 429", async () => {
    const binding = new HttpSseGatewayBinding({
      baseUrl: "http://127.0.0.1:32767/bridge/v1/http/connections",
      deviceToken: "device-token",
      endpointPolicy: "loopback_test_readiness",
      fetch: async () => new Response(null, {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    });
    await expect(binding.open(hello())).rejects.toMatchObject({
      faultClass: "retryable_network",
      httpStatus: 429,
      retryAfterMs: 30_000,
    });
  });
});

function fakeBinding(open: () => Promise<HelloAckEnvelope>): GatewayBinding {
  return {
    kind: "streamable_http_sse",
    connectionId: null,
    bufferedAmount: 0,
    open,
    send: async () => undefined,
    messages: () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<RbpEnvelope> {
        return;
      },
    }),
    close: async () => undefined,
  };
}

async function withLoopbackResponse<T>(
  response: (request: JsonObject, port: number) => Uint8Array,
  action: (client: PersistentAddinClient) => Promise<T>,
): Promise<T> {
  const server = createNetServer((socket) => {
    const decoder = new FrameDecoder(1024 * 1024);
    let responded = false;
    socket.on("data", (chunk) => {
      if (responded) return;
      const frames = decoder.push(chunk);
      const frame = frames[0];
      if (frame === undefined) return;
      responded = true;
      const request = JSON.parse(frame.toString("utf8")) as JsonObject;
      const port = (server.address() as AddressInfo).port;
      socket.end(encodeFrame(response(request, port)));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const client = await PersistentAddinClient.connect({ host: "127.0.0.1", port });
  try {
    return await action(client);
  } finally {
    client.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
}

function strictStatusResponse(id: string, port: number, advertisedPort: number | string = port): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultContractVersion: 2,
      addinLoopbackContractVersion: 1,
      addinVersion: "fixture",
      revit: { version: "2026", build: "test", processId: 1234 },
      service: {
        isRunning: true,
        port: advertisedPort,
        binding: "loopback_only",
        boundAddresses: ["127.0.0.1"],
        framing: {
          protocol: "length_prefixed_jsonrpc_v1",
          headerBytes: 4,
          byteOrder: "big_endian",
          payloadEncoding: "utf-8",
          maxRequestPayloadBytes: 16 * 1024 * 1024,
          maxResponsePayloadBytes: 32 * 1024 * 1024,
        },
      },
      sessionCapabilities: [],
      capabilityContracts: {},
      activeTask: null,
      recentTasks: [],
      recentHistoryCount: 0,
      recentHistoryCapacity: 100,
      plan: { pending: [], completed: [] },
    },
  };
}

function strictDocumentResponse(id: string, revision: number | string = 0): JsonObject {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultContractVersion: 2,
      documentContextContractVersion: 1,
      capturedAtUtc: "2026-07-22T00:00:00.000Z",
      revision,
      cacheState: "ready",
      unavailableReason: null,
      documents: [],
      activeDocumentId: null,
      activeView: null,
      disciplineHint: null,
    },
  };
}

describe("strict add-in loopback response boundary", () => {
  it("rejects duplicate JSON keys and malformed UTF-8 before response projection", async () => {
    const candidates = [
      Buffer.from(
        '{"jsonrpc":"2.0","id":"strict","result":{"resultContractVersion":2,"value":1,"value":2}}',
        "utf8",
      ),
      Uint8Array.from([0xc3, 0x28]),
    ];
    const codes = ["duplicate_key", "invalid_utf8"];
    for (const [index, candidate] of candidates.entries()) {
      await withLoopbackResponse(
        () => candidate as Uint8Array,
        async (client) => {
          await expect(client.request("strict", "get_ui_state", {})).rejects.toMatchObject({
            code: codes[index],
          });
        },
      );
    }
  });

  it("requires resultContractVersion on every successful ordinary add-in response", async () => {
    await withLoopbackResponse(
      (request) => Buffer.from(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { value: true },
      }), "utf8"),
      async (client) => {
        await expect(client.request("ordinary", "get_ui_state", {})).rejects.toThrow(
          /ordinary success violates JSON-RPC v1 shape/u,
        );
      },
    );
  });

  it("validates canonical mcp_status and get_document_context shapes without coercion", async () => {
    await withLoopbackResponse(
      (request, port) => Buffer.from(JSON.stringify(
        strictStatusResponse(String(request.id), port, String(port)),
      ), "utf8"),
      async (client) => {
        await expect(client.request("status", "mcp_status", {})).rejects.toThrow(/must be integer/u);
      },
    );
    await withLoopbackResponse(
      (request) => Buffer.from(JSON.stringify(
        strictDocumentResponse(String(request.id), "0"),
      ), "utf8"),
      async (client) => {
        await expect(client.request("document", "get_document_context", {})).rejects.toThrow(
          /must be integer/u,
        );
      },
    );
  });

  it("accepts exact canonical status and document responses", async () => {
    await withLoopbackResponse(
      (request, port) => Buffer.from(JSON.stringify(strictStatusResponse(String(request.id), port)), "utf8"),
      async (client) => {
        await expect(client.request("status-ok", "mcp_status", {})).resolves.toMatchObject({
          message: { result: { resultContractVersion: 2 } },
        });
      },
    );
    await withLoopbackResponse(
      (request) => Buffer.from(JSON.stringify(strictDocumentResponse(String(request.id))), "utf8"),
      async (client) => {
        await expect(client.request("document-ok", "get_document_context", {})).resolves.toMatchObject({
          message: { result: { documentContextContractVersion: 1, revision: 0 } },
        });
      },
    );
  });

  it("exposes structured transport faults for caller classification", () => {
    const error = new GatewayTransportError("seat denied", {
      faultClass: "auth",
      closeCode: 4403,
      closeReason: "seat denied",
    });
    expect(classifyGatewayTransportFailure(error)).toBe("auth");
  });
});
