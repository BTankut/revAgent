import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

import { RbpFrameError, type MutationScope } from "@revagent/protocol";
import { WebSocket, WebSocketServer } from "ws";

import { GatewayStubCore, GatewayStubFault } from "./core.js";
import { parseVersionHint, selectProtocolVersion } from "./negotiation.js";
import { parseHelloFrame, serializeHelloAck } from "./preNegotiation.js";
import type {
  AuthStatus,
  AuthenticatedDevice,
  DispatchBatchRequest,
  DispatchCancelRequest,
  DispatchInvokeRequest,
  DispatchPayloadRecoveryRequest,
  GatewayStubHandle,
  GatewayStubServerOptions,
  LateTerminalEvidenceRequest,
  TestTransportConnection,
  VerificationEvidenceRequest,
} from "./types.js";

const MAX_HTTP_MESSAGE_BYTES = 48 * 1024 * 1024;
const MAX_CONTROL_BODY_BYTES = 256 * 1024;
const MAX_EXPIRED_CONNECTION_IDS = 1_024;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_SSE_ATTACH_TIMEOUT_MS = 10_000;

class HttpRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpRequestError";
  }
}

interface ServerTransport extends TestTransportConnection {
  readonly tokenDigest: string;
}

class WsTransport implements ServerTransport {
  selectedProtocol = 0;
  active = false;
  readonly tokenDigest: string;

  constructor(
    readonly connectionId: string,
    readonly device: AuthenticatedDevice,
    readonly socket: WebSocket,
  ) {
    this.tokenDigest = device.tokenDigest;
  }

  readonly binding = "wss" as const;

  async sendSerialized(serialized: string): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WSS transport is not open");
    }
    await new Promise<void>((resolve, reject) => {
      this.socket.send(serialized, (error) =>
        error === undefined || error === null ? resolve() : reject(error));
    });
  }

  async close(code: number, reason: string): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 250);
      timer.unref();
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.socket.once("close", finish);
      this.socket.close(code >= 1000 && code <= 4999 ? code : 1011, reason.slice(0, 123));
    });
  }
}

class SseTransport implements ServerTransport {
  selectedProtocol = 0;
  active = false;
  readonly tokenDigest: string;
  private response: ServerResponse | null = null;

  constructor(
    readonly connectionId: string,
    readonly device: AuthenticatedDevice,
  ) {
    this.tokenDigest = device.tokenDigest;
  }

  readonly binding = "http_sse" as const;

  attach(response: ServerResponse): void {
    if (this.response !== null) {
      throw new HttpRequestError(409, "SSE stream already attached");
    }
    this.response = response;
    this.active = true;
  }

  async sendSerialized(serialized: string): Promise<void> {
    if (this.response === null || this.response.destroyed || this.response.writableEnded) {
      throw new Error("SSE transport is not open");
    }
    const frame = `event: rbp\ndata: ${serialized}\n\n`;
    if (!this.response.write(frame)) {
      await new Promise<void>((resolve, reject) => {
        this.response!.once("drain", resolve);
        this.response!.once("error", reject);
      });
    }
  }

  async close(): Promise<void> {
    if (this.response !== null && !this.response.writableEnded) {
      this.response.end();
    }
    this.active = false;
    this.response = null;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(normalized);
  return (family === 4 && normalized.startsWith("127.")) || (family === 6 && normalized === "::1");
}

function isJsonMediaType(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function requestPath(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://rbp-test.invalid");
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || authorization.length <= 7) {
    throw new HttpRequestError(401, "missing device credential");
  }
  return authorization.slice(7);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > limit) {
      throw new HttpRequestError(413, "request body exceeds test endpoint limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(serialized)),
    "content-type": "application/json",
    ...headers,
  });
  response.end(serialized);
}

function rawUpgradeResponse(socket: Duplex, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const reason = status === 401
    ? "Unauthorized"
    : status === 403
      ? "Forbidden"
      : status === 426
        ? "Upgrade Required"
        : "Bad Gateway";
  const serialized = JSON.stringify(body);
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(serialized)}`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    "",
    serialized,
  ];
  socket.end(lines.join("\r\n"));
}

function assertVersionHint(core: GatewayStubCore, request: IncomingMessage): void {
  const versions = parseVersionHint(request.headers["x-rbp-versions"]);
  if (versions.length === 0) {
    throw new HttpRequestError(426, "missing or invalid X-RBP-Versions");
  }
  const minimum = Math.min(...versions);
  const maximum = Math.max(...versions);
  try {
    selectProtocolVersion(core.supportedProtocols, minimum, maximum);
  } catch {
    throw new HttpRequestError(426, "no mutually supported RBP version");
  }
}

function authenticateRequest(core: GatewayStubCore, request: IncomingMessage): { token: string; device: AuthenticatedDevice } {
  const token = bearerToken(request);
  try {
    return { token, device: core.authenticate(token) };
  } catch (error) {
    if (error instanceof GatewayStubFault) {
      throw new HttpRequestError(error.closeCode === 4403 ? 403 : 401, error.message);
    }
    throw error;
  }
}

function sameCredential(transport: ServerTransport, device: AuthenticatedDevice): boolean {
  return transport.device.deviceId === device.deviceId && transport.tokenDigest === device.tokenDigest;
}

type ControlCommand =
  | { action: "enqueue_frame_fault"; rule: Parameters<GatewayStubCore["faults"]["enqueueFrame"]>[0] }
  | { action: "enqueue_opening_fault"; rule: Parameters<GatewayStubCore["faults"]["enqueueOpening"]>[0] }
  | { action: "flush_held"; connection_id?: string }
  | { action: "set_sse_buffering"; connection_id: string; enabled: boolean }
  | { action: "disconnect"; connection_id: string }
  | { action: "set_auth_status"; token: string; status: AuthStatus }
  | { action: "expire_pending"; rsid: string }
  | { action: "install_hold"; rsid: string; mutation_scope: MutationScope; origin_invocation_ids: string[] }
  | { action: "record_verification_evidence"; request: VerificationEvidenceRequest }
  | { action: "record_late_terminal_evidence"; request: LateTerminalEvidenceRequest }
  | { action: "dispatch_invoke"; request: DispatchInvokeRequest }
  | { action: "dispatch_batch"; request: DispatchBatchRequest }
  | { action: "dispatch_cancel"; request: DispatchCancelRequest }
  | { action: "dispatch_payload_recovery"; request: DispatchPayloadRecoveryRequest }
  | { action: "liveness_sweep" }
  | { action: "snapshot" };

export async function startGatewayStub(options: GatewayStubServerOptions): Promise<GatewayStubHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("the test-only Gateway stub may bind only to loopback");
  }
  const port = options.port ?? 0;
  const controlToken = options.controlToken ?? "rbp-test-control";
  const core = await GatewayStubCore.create(options);
  const transports = new Map<string, ServerTransport>();
  const expiredConnectionIds = new Set<string>();
  const expiredConnectionOrder: string[] = [];
  const connectionDeadlines = new Map<string, NodeJS.Timeout>();
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const sseAttachTimeoutMs = options.sseAttachTimeoutMs ?? DEFAULT_SSE_ATTACH_TIMEOUT_MS;
  for (const [name, value] of [["helloTimeoutMs", helloTimeoutMs], ["sseAttachTimeoutMs", sseAttachTimeoutMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }

  let closed = false;
  let sweepTimer: NodeJS.Timeout | null = null;

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.writableEnded) {
          response.end();
        }
        return;
      }
      if (error instanceof HttpRequestError) {
        const body = error.status === 426
          ? {
              error: error.message,
              min_protocol: Math.min(...core.supportedProtocols),
              max_protocol: Math.max(...core.supportedProtocols),
              manifest_url: "/bridge/update/manifest",
            }
          : { error: error.message };
        json(response, error.status, body);
        return;
      }
      if (error instanceof RbpFrameError) {
        json(response, 400, { error: error.message, code: error.code });
        return;
      }
      if (error instanceof GatewayStubFault) {
        const status = error.closeCode === 4426
          ? 426
          : error.closeCode === 4401
            ? 401
            : error.closeCode === 4403
              ? 403
              : 400;
        const body = status === 426
          ? {
              error: error.message,
              min_protocol: Math.min(...core.supportedProtocols),
              max_protocol: Math.max(...core.supportedProtocols),
              manifest_url: "/bridge/update/manifest",
            }
          : { error: error.message };
        json(response, status, body);
        return;
      }
      json(response, 500, { error: error instanceof Error ? error.message : "internal test stub error" });
    });
  };

  const server = options.tls === undefined
    ? createHttpServer(requestHandler)
    : createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, requestHandler);
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_HTTP_MESSAGE_BYTES });

  function clearConnectionDeadline(connectionId: string): void {
    const deadline = connectionDeadlines.get(connectionId);
    if (deadline !== undefined) {
      clearTimeout(deadline);
      connectionDeadlines.delete(connectionId);
    }
  }

  function markConnectionExpired(connectionId: string): void {
    if (expiredConnectionIds.has(connectionId)) {
      return;
    }
    expiredConnectionIds.add(connectionId);
    expiredConnectionOrder.push(connectionId);
    while (expiredConnectionOrder.length > MAX_EXPIRED_CONNECTION_IDS) {
      const oldest = expiredConnectionOrder.shift();
      if (oldest !== undefined) {
        expiredConnectionIds.delete(oldest);
      }
    }
  }

  async function cleanupConnection(connectionId: string, reason: string): Promise<void> {
    clearConnectionDeadline(connectionId);
    transports.delete(connectionId);
    markConnectionExpired(connectionId);
    core.faults.clearConnection(connectionId);
    await core.disconnectConnection(connectionId, reason);
  }

  async function closeConnection(connectionId: string, reason: string, code = 1001): Promise<void> {
    const transport = transports.get(connectionId);
    if (transport !== undefined) {
      transports.delete(connectionId);
      clearConnectionDeadline(connectionId);
      markConnectionExpired(connectionId);
      core.faults.clearConnection(connectionId);
      await transport.close(code, reason);
    }
    await core.disconnectConnection(connectionId, reason);
  }

  function armConnectionDeadline(
    connectionId: string,
    timeoutMs: number,
    reason: string,
    code: number,
  ): void {
    clearConnectionDeadline(connectionId);
    const deadline = setTimeout(() => {
      connectionDeadlines.delete(connectionId);
      void closeConnection(connectionId, reason, code).catch(() => undefined);
    }, timeoutMs);
    deadline.unref();
    connectionDeadlines.set(connectionId, deadline);
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = requestPath(request);
    if (url.pathname === "/bridge/v1/http/connections" && request.method === "POST") {
      const openingFault = core.faults.consumeOpening("http_sse");
      if (openingFault !== null) {
        const headers: Record<string, string> = openingFault.retryAfter === undefined
          ? {}
          : { "retry-after": openingFault.retryAfter };
        json(response, openingFault.status, { error: "injected_opening_fault" }, headers);
        return;
      }
      if (!isJsonMediaType(request.headers["content-type"])) {
        throw new HttpRequestError(415, "fallback create requires Content-Type: application/json");
      }
      if (!(request.headers.accept ?? "").toString().toLowerCase().split(",").map((value) => value.trim()).includes("application/json")) {
        throw new HttpRequestError(406, "fallback create requires Accept: application/json");
      }
      assertVersionHint(core, request);
      const { device } = authenticateRequest(core, request);
      const frame = await readBody(request, 64 * 1024);
      const hello = parseHelloFrame(frame);
      const connectionId = await core.allocateConnectionId(device);
      const transport = new SseTransport(connectionId, device);
      transports.set(connectionId, transport);
      core.attachConnection(transport);
      try {
        const ack = await core.acceptHello(connectionId, hello);
        armConnectionDeadline(connectionId, sseAttachTimeoutMs, "sse_attach_timeout", 4400);
        json(response, 201, JSON.parse(serializeHelloAck(ack)), {
          "rbp-connection-id": connectionId,
        });
      } catch (error) {
        transports.delete(connectionId);
        await core.disconnectConnection(connectionId, "hello_failed");
        throw error;
      }
      return;
    }

    const eventsMatch = /^\/bridge\/v1\/http\/connections\/([^/]+)\/events$/.exec(url.pathname);
    if (eventsMatch !== null && request.method === "GET") {
      const connectionId = decodeURIComponent(eventsMatch[1]!);
      const transport = transports.get(connectionId);
      if (!(transport instanceof SseTransport)) {
        throw new HttpRequestError(expiredConnectionIds.has(connectionId) ? 410 : 404, "unknown fallback connection");
      }
      const { device } = authenticateRequest(core, request);
      if (!sameCredential(transport, device)) {
        throw new HttpRequestError(403, "fallback connection is bound to another device credential");
      }
      if (request.headers.accept !== "text/event-stream") {
        throw new HttpRequestError(406, "SSE events require Accept: text/event-stream");
      }
      response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
      });
      response.flushHeaders();
      transport.attach(response);
      clearConnectionDeadline(connectionId);
      core.activateConnection(connectionId);
      response.once("close", () => {
        if (!closed) {
          void cleanupConnection(connectionId, "sse_eof");
        }
      });
      return;
    }

    const messagesMatch = /^\/bridge\/v1\/http\/connections\/([^/]+)\/messages$/.exec(url.pathname);
    if (messagesMatch !== null && request.method === "POST") {
      const connectionId = decodeURIComponent(messagesMatch[1]!);
      const transport = transports.get(connectionId);
      if (!(transport instanceof SseTransport)) {
        throw new HttpRequestError(expiredConnectionIds.has(connectionId) ? 410 : 404, "unknown fallback connection");
      }
      const { device } = authenticateRequest(core, request);
      if (!sameCredential(transport, device)) {
        throw new HttpRequestError(403, "fallback connection is bound to another device credential");
      }
      if (!transport.active) {
        throw new HttpRequestError(409, "SSE stream must be established before fallback uplink");
      }
      if (!isJsonMediaType(request.headers["content-type"])) {
        throw new HttpRequestError(415, "fallback uplink requires application/json");
      }
      const frame = await readBody(request, MAX_HTTP_MESSAGE_BYTES);
      try {
        const acceptance = await core.receiveFrame(connectionId, frame);
        if (acceptance !== "delivered") {
          await closeConnection(connectionId, "uplink_acceptance_unknown");
          response.destroy();
          return;
        }
      } catch (error) {
        if (error instanceof GatewayStubFault) {
          await core.sendConnectionFault(connectionId, error);
          await closeConnection(connectionId, error.message);
          throw new HttpRequestError(400, error.message);
        }
        throw error;
      }
      response.writeHead(202, { "content-length": "0" });
      response.end();
      return;
    }

    if (url.pathname === "/__rbp_test/control" && (request.method === "GET" || request.method === "POST")) {
      if (request.headers["x-rbp-test-control"] !== controlToken) {
        throw new HttpRequestError(403, "invalid test-control credential");
      }
      if (request.method === "GET") {
        json(response, 200, core.snapshot());
        return;
      }
      const body = JSON.parse(Buffer.from(await readBody(request, MAX_CONTROL_BODY_BYTES)).toString("utf8")) as ControlCommand;
      let result: unknown;
      switch (body.action) {
        case "enqueue_frame_fault":
          core.faults.enqueueFrame(body.rule);
          result = { queued: true };
          break;
        case "enqueue_opening_fault":
          core.faults.enqueueOpening(body.rule);
          result = { queued: true };
          break;
        case "flush_held":
          result = { flushed: await core.faults.flushHeld(body.connection_id) };
          break;
        case "set_sse_buffering":
          core.faults.setSseBuffering(body.connection_id, body.enabled);
          result = { enabled: body.enabled };
          break;
        case "disconnect":
          await closeConnection(body.connection_id, "injected_disconnect");
          result = { disconnected: true };
          break;
        case "set_auth_status":
          {
            const affected = core.setAuthStatus(body.token, body.status);
            if (body.status !== "active") {
              for (const connectionId of affected) {
                await closeConnection(
                  connectionId,
                  `auth_${body.status}`,
                  body.status === "seat_denied" ? 4403 : 4401,
                );
              }
            }
            result = { status: body.status, disconnected: affected };
          }
          break;
        case "expire_pending":
          await core.expirePendingNow(body.rsid);
          result = { expired: true };
          break;
        case "install_hold":
          result = await core.installSyntheticHold(body.rsid, body.mutation_scope, body.origin_invocation_ids);
          break;
        case "record_verification_evidence":
          result = await core.recordVerificationHoldEvidence(body.request);
          break;
        case "record_late_terminal_evidence":
          result = await core.recordLateTerminalHoldEvidence(body.request);
          break;
        case "dispatch_invoke":
          result = await core.dispatchInvoke(body.request);
          break;
        case "dispatch_batch":
          result = await core.dispatchBatch(body.request);
          break;
        case "dispatch_cancel":
          result = await core.dispatchCancel(body.request);
          break;
        case "dispatch_payload_recovery":
          result = await core.dispatchPayloadRecovery(body.request);
          break;
        case "liveness_sweep": {
          const connectionIds = await core.livenessSweep();
          for (const connectionId of connectionIds) {
            await closeConnection(connectionId, "heartbeat_timeout");
          }
          result = { disconnected: connectionIds };
          break;
        }
        case "snapshot":
          result = core.snapshot();
          break;
      }
      json(response, 200, result);
      return;
    }

    throw new HttpRequestError(404, "not found");
  }

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = requestPath(request);
      if (url.pathname !== "/bridge/v1") {
        rawUpgradeResponse(socket, 404, { error: "not_found" });
        return;
      }
      const openingFault = core.faults.consumeOpening("wss");
      if (openingFault !== null) {
        const headers: Record<string, string> = openingFault.retryAfter === undefined
          ? {}
          : { "Retry-After": openingFault.retryAfter };
        rawUpgradeResponse(socket, openingFault.status, { error: "injected_opening_fault" }, headers);
        return;
      }
      let device: AuthenticatedDevice;
      try {
        assertVersionHint(core, request);
        ({ device } = authenticateRequest(core, request));
      } catch (error) {
        const status = error instanceof HttpRequestError ? error.status : 500;
        rawUpgradeResponse(socket, status, status === 426
          ? {
              error: error instanceof Error ? error.message : "version mismatch",
              min_protocol: Math.min(...core.supportedProtocols),
              max_protocol: Math.max(...core.supportedProtocols),
              manifest_url: "/bridge/update/manifest",
            }
          : { error: error instanceof Error ? error.message : "opening failure" });
        return;
      }
      const connectionId = await core.allocateConnectionId(device);
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        const transport = new WsTransport(connectionId, device, websocket);
        transports.set(connectionId, transport);
        core.attachConnection(transport);
        armConnectionDeadline(connectionId, helloTimeoutMs, "hello_timeout", 4400);
        let firstFrame = true;
        websocket.on("message", (data, isBinary) => {
          void (async () => {
            if (isBinary) {
              throw new GatewayStubFault("RBP WSS accepts text frames only", "protocol", 4400);
            }
            const frame = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data);
            if (firstFrame) {
              firstFrame = false;
              const hello = parseHelloFrame(frame);
              const ack = await core.acceptHello(connectionId, hello);
              clearConnectionDeadline(connectionId);
              await core.sendHelloAck(connectionId, ack);
              core.activateConnection(connectionId);
            } else {
              await core.receiveFrame(connectionId, frame);
            }
          })().catch(async (error: unknown) => {
            const fault = error instanceof GatewayStubFault
              ? error
              : new GatewayStubFault(error instanceof Error ? error.message : "protocol failure", "protocol", 4400);
            await core.sendConnectionFault(connectionId, fault).catch(() => undefined);
            await closeConnection(connectionId, fault.message, fault.closeCode);
          });
        });
        websocket.once("close", () => {
          void cleanupConnection(connectionId, "wss_closed");
        });
      });
    })().catch(() => {
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Gateway stub did not acquire a TCP address");
  }
  const displayHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  const scheme = options.tls === undefined ? "http" : "https";
  const wsScheme = options.tls === undefined ? "ws" : "wss";
  const origin = `${scheme}://${displayHost}:${address.port}`;

  const sweepMs = options.livenessSweepMs ?? 1_000;
  if (sweepMs > 0) {
    sweepTimer = setInterval(() => {
      void core.livenessSweep().then(async (connectionIds) => {
        for (const connectionId of connectionIds) {
          await closeConnection(connectionId, "heartbeat_timeout");
        }
      });
    }, sweepMs);
    sweepTimer.unref();
  }

  return {
    origin,
    wsUrl: `${wsScheme}://${displayHost}:${address.port}/bridge/v1`,
    httpConnectionUrl: `${origin}/bridge/v1/http/connections`,
    controlUrl: `${origin}/__rbp_test/control`,
    controlToken,
    core,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      for (const connectionId of [...transports.keys()]) {
        await closeConnection(connectionId, "stub_shutdown");
      }
      websocketServer.close();
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
      server.closeAllConnections();
      await serverClosed;
      await core.close();
    },
  };
}
