import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  parseRbpFrame,
  type HelloEnvelope,
  type RbpEnvelope,
} from "@revagent/protocol";
import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer } from "ws";

import {
  GatewayRbpFault,
  type BridgeConnectionChannel,
  type GatewayBridgeSessionAuthority,
} from "./bridgeSession.js";
import { gatewayUuidV7 } from "./identifiers.js";
import {
  portNotImplemented,
  type GatewayPortAdapterKind,
  type GatewayPortRefusal,
} from "./gatewayPorts.js";

export const RBP_INGRESS_MOUNT_PREFIX = "/bridge/v1" as const;

export const RBP_INGRESS_HTTP_FALLBACK_PATHS = Object.freeze([
  "/bridge/v1/http/connections",
  "/bridge/v1/http/connections/:connection_id/events",
  "/bridge/v1/http/connections/:connection_id/messages",
] as const);

const MAX_HTTP_MESSAGE_BYTES = 48 * 1024 * 1024;
const MAX_PENDING_TRANSPORT_BYTES = 1024 * 1024;

export interface RbpIngressHost {
  readonly kind: GatewayPortAdapterKind;
  readonly mountPrefix: typeof RBP_INGRESS_MOUNT_PREFIX;
  readonly enabled: boolean;
  /** Inspectable when the host owns a live Bridge session authority. */
  readonly authority?: GatewayBridgeSessionAuthority;
  refuse(input: {
    readonly path: string;
    readonly kind: "http" | "upgrade";
  }): GatewayPortRefusal;
  start?(): Promise<void>;
  mount?(app: FastifyInstance): void;
  handleUpgrade?(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void;
  beginDrain?(): void;
  close?(): Promise<void>;
}

export interface ProductionRbpIngressHost extends RbpIngressHost {
  readonly kind: "postgres";
  readonly enabled: true;
  readonly authority: GatewayBridgeSessionAuthority;
}

class HttpSseChannel implements BridgeConnectionChannel {
  readonly #pending: string[] = [];
  #response: ServerResponse | null = null;
  #pendingBytes = 0;

  public attach(response: ServerResponse): void {
    if (this.#response !== null) {
      throw new GatewayRbpFault("protocol", "SSE stream is already attached", 409, 4400);
    }
    this.#response = response;
    for (const serialized of this.#pending.splice(0)) {
      response.write(`event: rbp\ndata: ${serialized}\n\n`);
    }
    this.#pendingBytes = 0;
  }

  public async send(serialized: string): Promise<void> {
    const response = this.#response;
    if (response === null) {
      const nextBytes = this.#pendingBytes + Buffer.byteLength(serialized);
      if (nextBytes > MAX_PENDING_TRANSPORT_BYTES) {
        throw new Error("SSE attach backlog exceeds the bounded transport window");
      }
      this.#pendingBytes = nextBytes;
      this.#pending.push(serialized);
      return;
    }
    if (response.destroyed || response.writableEnded) {
      throw new Error("SSE stream is closed");
    }
    if (!response.write(`event: rbp\ndata: ${serialized}\n\n`)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => finish();
        const onClose = (): void => finish(new Error("SSE stream closed before drain"));
        const onError = (error: Error): void => finish(error);
        const finish = (error?: Error): void => {
          response.off("drain", onDrain);
          response.off("close", onClose);
          response.off("error", onError);
          if (error === undefined) resolve();
          else reject(error);
        };
        response.once("drain", onDrain);
        response.once("close", onClose);
        response.once("error", onError);
      });
    }
  }

  public async close(): Promise<void> {
    if (this.#response !== null && !this.#response.writableEnded) {
      this.#response.end();
    }
    this.#response = null;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }
}

function bearer(authorization: string | undefined): string | undefined {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const value = authorization.slice("Bearer ".length);
  return value.length === 0 ? undefined : value;
}

function versionOneOffered(request: IncomingMessage): boolean {
  const raw = request.headers["x-rbp-versions"];
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  return value
    ?.split(",")
    .map((candidate) => candidate.trim())
    .includes("1") === true;
}

function frame(body: unknown): RbpEnvelope {
  if (Buffer.isBuffer(body)) return parseRbpFrame(body);
  return parseRbpFrame(Buffer.from(JSON.stringify(body), "utf8"));
}

function faultBody(error: GatewayRbpFault): {
  readonly error: string;
  readonly fault_class: string;
} {
  return { error: error.message, fault_class: error.code };
}

function rawResponse(
  socket: Duplex,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 426
          ? "Upgrade Required"
          : status === 503
            ? "Service Unavailable"
            : "Bad Request";
  const serialized = JSON.stringify(body);
  socket.end(
    [
      `HTTP/1.1 ${String(status)} ${reason}`,
      "Connection: close",
      "Content-Type: application/json",
      `Content-Length: ${String(Buffer.byteLength(serialized))}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      "",
      serialized,
    ].join("\r\n"),
  );
}

export function createProductionRbpIngressHost(options: {
  readonly authority: GatewayBridgeSessionAuthority;
}): ProductionRbpIngressHost {
  const { authority } = options;
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_HTTP_MESSAGE_BYTES,
  });
  const httpChannels = new Map<string, HttpSseChannel>();
  let draining = false;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;

  const host: ProductionRbpIngressHost = {
    kind: "postgres" as const,
    mountPrefix: RBP_INGRESS_MOUNT_PREFIX,
    enabled: true as const,
    authority,
    refuse(input): GatewayPortRefusal {
      return portNotImplemented(
        "rbp_ingress",
        `${input.kind} ${input.path} is outside the exact production RBP ingress corpus`,
      );
    },
    async start(): Promise<void> {
      await authority.open();
      livenessTimer = setInterval(() => {
        void authority.sweepLiveness().catch(() => {
          // Losing durable liveness authority is a fail-closed condition: keep
          // existing sockets available for shutdown evidence, but admit no new
          // connection that could be mistaken for authorized dispatch state.
          draining = true;
        });
      }, 5_000);
      livenessTimer.unref();
    },
    mount(app): void {
      app.post(
        "/bridge/v1/http/connections",
        { bodyLimit: MAX_HTTP_MESSAGE_BYTES },
        async (request, reply) => {
          if (draining) return reply.code(503).send({ error: "server_draining" });
          try {
            if (!versionOneOffered(request.raw)) {
              return reply
                .header("X-RBP-Supported-Versions", "1")
                .code(426)
                .send({ error: "no mutually supported RBP version" });
            }
            const hello = frame(request.body);
            if (hello.type !== "hello") {
              throw new GatewayRbpFault("protocol", "create body must be hello", 400, 4400);
            }
            const channel = new HttpSseChannel();
            const opened = await authority.openConnection({
              deviceToken: bearer(request.headers.authorization),
              binding: "http_sse",
              hello: hello as HelloEnvelope,
              channel,
            });
            httpChannels.set(opened.connectionId, channel);
            return reply
              .header("RBP-Connection-Id", opened.connectionId)
              .header("Cache-Control", "no-store")
              .code(201)
              .send(opened.helloAck);
          } catch (error) {
            if (error instanceof GatewayRbpFault) {
              return reply.code(error.httpStatus).send(faultBody(error));
            }
            throw error;
          }
        },
      );

      app.get(
        "/bridge/v1/http/connections/:connection_id/events",
        async (request, reply) => {
          const connectionId = (request.params as { connection_id: string }).connection_id;
          try {
            await authority.assertConnectionCredential(
              connectionId,
              bearer(request.headers.authorization),
            );
            const channel = httpChannels.get(connectionId);
            if (channel === undefined) {
              throw new GatewayRbpFault("auth", "unknown connection", 404, 4401);
            }
            reply.hijack();
            reply.raw.writeHead(200, {
              "Cache-Control": "no-cache, no-store",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream",
              "X-Accel-Buffering": "no",
            });
            reply.raw.flushHeaders();
            channel.attach(reply.raw);
            // Last-Event-ID is deliberately ignored. RBP sequence state is the
            // only replay authority and lives in the durable session record.
            reply.raw.once("close", () => {
              void authority.detach(connectionId);
            });
          } catch (error) {
            if (error instanceof GatewayRbpFault) {
              return reply.code(error.httpStatus).send(faultBody(error));
            }
            throw error;
          }
        },
      );

      app.post(
        "/bridge/v1/http/connections/:connection_id/messages",
        { bodyLimit: MAX_HTTP_MESSAGE_BYTES },
        async (request, reply) => {
          const connectionId = (request.params as { connection_id: string }).connection_id;
          try {
            await authority.assertConnectionCredential(
              connectionId,
              bearer(request.headers.authorization),
            );
            const envelope = frame(request.body);
            await authority.receive(connectionId, envelope);
            // receive() commits sequence/journal changes before resolving.
            return reply.code(202).send({ accepted: true });
          } catch (error) {
            if (error instanceof GatewayRbpFault) {
              return reply.code(error.httpStatus).send(faultBody(error));
            }
            return reply.code(409).send({
              error: error instanceof Error ? error.message : String(error),
              fault_class: "protocol",
            });
          }
        },
      );
    },
    handleUpgrade(request, socket, head): void {
      void (async () => {
        const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
        if (draining) {
          rawResponse(socket, 503, { error: "server_draining" });
          return;
        }
        if (path !== "/bridge/v1" && path !== "/bridge/v1/") {
          rawResponse(socket, 400, { error: "unknown RBP upgrade path" });
          return;
        }
        if (!versionOneOffered(request)) {
          rawResponse(
            socket,
            426,
            { error: "no mutually supported RBP version" },
            { "X-RBP-Supported-Versions": "1" },
          );
          return;
        }
        websocketServer.handleUpgrade(request, socket, head, (websocket) => {
          let connectionId: string | null = null;
          let opening = true;
          const channel: BridgeConnectionChannel = {
            async send(serialized): Promise<void> {
              if (websocket.readyState !== WebSocket.OPEN) {
                throw new Error("WSS transport is not open");
              }
              if (
                websocket.bufferedAmount + Buffer.byteLength(serialized) >
                MAX_PENDING_TRANSPORT_BYTES
              ) {
                throw new Error("WSS backlog exceeds the bounded transport window");
              }
              await new Promise<void>((resolve, reject) => {
                websocket.send(serialized, (error) =>
                  error === undefined || error === null
                    ? resolve()
                    : reject(error),
                );
              });
            },
            async close(code, reason): Promise<void> {
              if (websocket.readyState === WebSocket.CLOSED) return;
              websocket.close(code, reason.slice(0, 123));
            },
          };
          websocket.on("message", (raw, binary) => {
            void (async () => {
              try {
                if (binary) {
                  throw new GatewayRbpFault("protocol", "RBP WSS requires text frames", 400, 4400);
                }
                const envelope = parseRbpFrame(
                  Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
                );
                if (opening) {
                  if (envelope.type !== "hello") {
                    throw new GatewayRbpFault("protocol", "first WSS frame must be hello", 400, 4400);
                  }
                  const opened = await authority.openConnection({
                    deviceToken: bearer(request.headers.authorization),
                    binding: "wss",
                    hello: envelope,
                    channel,
                  });
                  connectionId = opened.connectionId;
                  opening = false;
                  await channel.send(JSON.stringify(opened.helloAck));
                  return;
                }
                await authority.receive(connectionId!, envelope);
              } catch (error) {
                const fault =
                  error instanceof GatewayRbpFault
                    ? error
                    : new GatewayRbpFault(
                        "protocol",
                        error instanceof Error ? error.message : String(error),
                        400,
                        4400,
                      );
                if (!opening && websocket.readyState === WebSocket.OPEN) {
                  try {
                    await channel.send(
                      JSON.stringify({
                        v: 1,
                        type: "error",
                        id: gatewayUuidV7(Date.now()),
                        ts: new Date().toISOString(),
                        payload: {
                          retryable: false,
                          fault_class: fault.code === "auth" ? "auth" : "protocol",
                          outcome: "known",
                          verification_required: false,
                          message: fault.message,
                        },
                      } satisfies RbpEnvelope),
                    );
                  } catch {
                    // The authenticated close code remains authoritative when
                    // the peer cannot accept the final control frame.
                  }
                }
                websocket.close(fault.closeCode, fault.message.slice(0, 123));
              }
            })();
          });
          websocket.once("close", () => {
            if (connectionId !== null) void authority.detach(connectionId);
          });
        });
      })().catch((error: unknown) => {
        rawResponse(socket, 503, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    beginDrain(): void {
      draining = true;
    },
    async close(): Promise<void> {
      draining = true;
      if (livenessTimer !== null) {
        clearInterval(livenessTimer);
        livenessTimer = null;
      }
      for (const channel of httpChannels.values()) await channel.close();
      httpChannels.clear();
      websocketServer.close();
      await authority.close();
    },
  };
  return host;
}

export function createUnavailableRbpIngressHost(): RbpIngressHost {
  const host: RbpIngressHost = {
    kind: "unavailable" as const,
    mountPrefix: RBP_INGRESS_MOUNT_PREFIX,
    enabled: false,
    refuse(input): GatewayPortRefusal {
      return portNotImplemented(
        "rbp_ingress",
        `${input.kind} ${input.path} is reserved for the production RBP ingress`,
      );
    },
  };
  return Object.freeze(host);
}
