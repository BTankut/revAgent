import { write } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
  parseRbpFrame,
  RBP_MAX_DECODED_CHUNK_BYTES,
  RBP_MAX_INLINE_RESULT_BYTES,
  RBP_MAX_INVOCATION_PARAMS_BYTES,
  type HelloEnvelope,
  type RbpEnvelope,
} from "@revagent/protocol";
import type { FastifyInstance } from "fastify";
import { WebSocket, WebSocketServer, type RawData } from "ws";

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
const RBP_WSS_FRAME_OVERHEAD_BYTES = 64 * 1024;
const RBP_WSS_DEFAULT_QUEUED_FRAMES = 32;
const RBP_WSS_MIN_QUEUED_FRAMES = 1;
const RBP_WSS_MAX_QUEUED_FRAMES = 256;

type WssConnectionState = "opening" | "open" | "closing" | "closed" | "faulted";

interface WssFrameCeilings {
  readonly maxParamsBytes: number;
  readonly maxPartialBytes: number;
  readonly maxInlineTerminalBytes: number;
}

export interface RbpWssQueueConfig {
  readonly queuedFrames?: number;
  readonly queuedBytes?: number;
}

export const RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT =
  "revagent.gateway-rbp-wss-internal-diagnostic/v1" as const;

export interface RbpWssInternalDiagnostic {
  readonly contractVersion: typeof RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT;
  readonly event: "gateway.rbp_wss_internal_diagnostic";
  readonly phase: "opening" | "receive" | "egress" | "transport" | "queue" | "teardown";
  readonly faultClass: "protocol" | "auth" | "authorization" | "version" | "internal";
  readonly closeCode: number;
  /** Protected diagnostic detail. It must never be copied to a wire response. */
  readonly detail: string;
}

export interface ProductionRbpIngressOptions {
  readonly authority: GatewayBridgeSessionAuthority;
  readonly wssQueue?: RbpWssQueueConfig;
  readonly writeOpeningRefusalLog?: (serializedObservation: string) => void;
  readonly onOpeningRefusalObservation?: (
    observation: RbpOpeningRefusalObservation,
  ) => void;
  readonly onWssInternalDiagnostic?: (diagnostic: RbpWssInternalDiagnostic) => void;
}

interface PublicWssFault {
  readonly closeCode: number;
  readonly closeReason: string;
  readonly message: string;
  readonly wireFaultClass: "protocol" | "auth";
  readonly diagnosticFaultClass: RbpWssInternalDiagnostic["faultClass"];
}

function publicWssFault(fault: GatewayRbpFault): PublicWssFault {
  switch (fault.closeCode) {
    case 4401:
      return {
        closeCode: 4401,
        closeReason: "RBP authentication failed",
        message: "RBP authentication failed",
        wireFaultClass: "auth",
        diagnosticFaultClass: "auth",
      };
    case 4403:
      return {
        closeCode: 4403,
        closeReason: "RBP authorization failed",
        message: "RBP authorization failed",
        wireFaultClass: "auth",
        diagnosticFaultClass: "authorization",
      };
    case 4426:
      return {
        closeCode: 4426,
        closeReason: "RBP version negotiation failed",
        message: "RBP version negotiation failed",
        wireFaultClass: "protocol",
        diagnosticFaultClass: "version",
      };
    case 1011:
      return {
        closeCode: 1011,
        closeReason: "RBP internal error",
        message: "RBP internal error",
        // RBP/1 permits only protocol/auth on connection-level error frames.
        // The protected diagnostic below carries the truthful internal class.
        wireFaultClass: "protocol",
        diagnosticFaultClass: "internal",
      };
    default:
      return {
        closeCode: 4400,
        closeReason: "RBP protocol error",
        message: "RBP protocol error",
        wireFaultClass: "protocol",
        diagnosticFaultClass: "protocol",
      };
  }
}

function wssFrameBudget(ceilings: WssFrameCeilings): number {
  return (
    RBP_WSS_FRAME_OVERHEAD_BYTES +
    Math.max(
      ceilings.maxParamsBytes,
      4 * Math.ceil(ceilings.maxPartialBytes / 3),
      ceilings.maxInlineTerminalBytes,
    )
  );
}

const LOCAL_WSS_FRAME_BUDGET_BYTES = wssFrameBudget({
  maxParamsBytes: RBP_MAX_INVOCATION_PARAMS_BYTES,
  maxPartialBytes: RBP_MAX_DECODED_CHUNK_BYTES,
  maxInlineTerminalBytes: RBP_MAX_INLINE_RESULT_BYTES,
});

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a safe integer in [${String(minimum)}, ${String(maximum)}]`,
    );
  }
  return value;
}

function configuredQueueBytes(configured: number | undefined, frameBudget: number): number {
  return boundedInteger(
    configured ?? 2 * frameBudget,
    frameBudget,
    2 * frameBudget,
    "wssQueue.queuedBytes",
  );
}

function rawFrame(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

export const RBP_OPENING_REFUSAL_OBSERVER_CONTRACT =
  "revagent.m4-rbp-refusal-observer/v1" as const;

const RBP_OPENING_REFUSAL_EVENT = "gateway.rbp_opening_refused" as const;

export interface RbpOpeningRefusalObservation {
  readonly contractVersion: typeof RBP_OPENING_REFUSAL_OBSERVER_CONTRACT;
  readonly event: typeof RBP_OPENING_REFUSAL_EVENT;
  readonly correlationId: string;
  readonly binding: "wss" | "http_sse";
  readonly faultClass: "auth";
  readonly httpStatus: 403;
  readonly closeCode: 4403;
  readonly decision: "refused";
}

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

function openingRefusalObservation(
  error: GatewayRbpFault,
  correlationId: string,
  binding: RbpOpeningRefusalObservation["binding"],
): RbpOpeningRefusalObservation | null {
  if (error.code !== "auth" || error.httpStatus !== 403 || error.closeCode !== 4403) {
    return null;
  }
  return Object.freeze({
    contractVersion: RBP_OPENING_REFUSAL_OBSERVER_CONTRACT,
    event: RBP_OPENING_REFUSAL_EVENT,
    correlationId,
    binding,
    faultClass: "auth",
    httpStatus: 403,
    closeCode: 4403,
    decision: "refused",
  });
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

export function createProductionRbpIngressHost(
  options: ProductionRbpIngressOptions,
): ProductionRbpIngressHost {
  const { authority } = options;
  const queuedFrameLimit = boundedInteger(
    options.wssQueue?.queuedFrames ?? RBP_WSS_DEFAULT_QUEUED_FRAMES,
    RBP_WSS_MIN_QUEUED_FRAMES,
    RBP_WSS_MAX_QUEUED_FRAMES,
    "wssQueue.queuedFrames",
  );
  const configuredQueuedByteLimit = options.wssQueue?.queuedBytes;
  const localQueuedByteLimit = configuredQueueBytes(
    configuredQueuedByteLimit,
    LOCAL_WSS_FRAME_BUDGET_BYTES,
  );
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_HTTP_MESSAGE_BYTES,
  });
  const httpChannels = new Map<string, HttpSseChannel>();
  let draining = false;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;

  const bestEffort = (operation: () => unknown): void => {
    try {
      void Promise.resolve(operation()).catch(() => {
        // Async observation failure is isolated from protocol lifecycle too.
      });
    } catch {
      // Observability cannot own authorization or connection lifecycle.
    }
  };

  const observeOpeningRefusal = (observation: RbpOpeningRefusalObservation): void => {
    const serialized = JSON.stringify(observation);
    bestEffort(() => {
      if (options.writeOpeningRefusalLog !== undefined) {
        return options.writeOpeningRefusalLog(serialized);
      }
      write(process.stderr.fd, `${serialized}\n`, (error) => {
        // The fd result is deliberately terminal here: neither an immediate
        // nor callback-time log failure may own the refusal lifecycle.
        void error;
      });
    });
    if (options.onOpeningRefusalObservation !== undefined) {
      bestEffort(() => options.onOpeningRefusalObservation!(observation));
    }
  };

  const observeWssInternalDiagnostic = (
    diagnostic: RbpWssInternalDiagnostic,
  ): void => {
    if (options.onWssInternalDiagnostic === undefined) return;
    bestEffort(() => options.onWssInternalDiagnostic!(Object.freeze(diagnostic)));
  };

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
          let openingCorrelationId: string | null = null;
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
            openingCorrelationId = hello.id;
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
              if (openingCorrelationId !== null) {
                const observation = openingRefusalObservation(
                  error,
                  openingCorrelationId,
                  "http_sse",
                );
                if (observation !== null) observeOpeningRefusal(observation);
              }
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
          let state: WssConnectionState = "opening";
          let authorityConnectionId: string | null = null;
          let openingCorrelationId: string | null = null;
          let openingRefusalObserved = false;
          let queuedFrames = 0;
          let queuedBytes = 0;
          let queuedByteLimit = localQueuedByteLimit;
          let pauseAtBytes = Math.ceil((queuedByteLimit * 3) / 4);
          let resumeBelowBytes = Math.ceil(queuedByteLimit / 2);
          let readsPaused = false;
          let serialTail: Promise<void> = Promise.resolve();
          let egressTail: Promise<void> = Promise.resolve();
          let terminalEgressClaimed = false;
          let terminalErrorAttempted = false;
          let teardownTask: Promise<void> | null = null;

          const internalFault = (error: unknown): GatewayRbpFault =>
            new GatewayRbpFault(
              "unavailable",
              error instanceof Error ? error.message : String(error),
              500,
              1011,
            );

          const append = (operation: () => Promise<void>): Promise<void> => {
            const task = serialTail.then(operation);
            serialTail = task.catch(() => {
              // Every socket-owned task has a rejection observer. Individual
              // operations translate failures into the first teardown below.
            });
            return task;
          };

          const appendEgress = (operation: () => Promise<void>): Promise<void> => {
            const task = egressTail.then(operation);
            egressTail = task.catch(() => {
              // The caller owns the observed task; the tail remains fulfilled
              // so one failed write cannot create an unhandled rejection.
            });
            return task;
          };

          const observeDiagnostic = (
            phase: RbpWssInternalDiagnostic["phase"],
            faultClass: RbpWssInternalDiagnostic["faultClass"],
            closeCode: number,
            error: unknown,
          ): void => {
            observeWssInternalDiagnostic({
              contractVersion: RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
              event: "gateway.rbp_wss_internal_diagnostic",
              phase,
              faultClass,
              closeCode,
              detail: error instanceof Error ? error.message : String(error),
            });
          };

          const sendRaw = async (serialized: string): Promise<void> => {
            if (websocket.readyState !== WebSocket.OPEN) {
              throw new Error("WSS transport is not open");
            }
            // The negotiated current frame owns its own protocol byte limit.
            // This guard measures only backlog that existed before this send.
            if (websocket.bufferedAmount > MAX_PENDING_TRANSPORT_BYTES) {
              throw new Error("WSS backlog exceeds the bounded transport window");
            }
            await new Promise<void>((resolve, reject) => {
              websocket.send(serialized, (error) =>
                error === undefined || error === null ? resolve() : reject(error),
              );
            });
          };

          const sendSerialized = async (serialized: string): Promise<void> => {
            if (
              terminalEgressClaimed ||
              state === "closing" ||
              state === "faulted" ||
              state === "closed"
            ) {
              throw new Error("WSS normal egress is closed");
            }
            try {
              await appendEgress(async () => {
                if (
                  terminalEgressClaimed ||
                  state === "closing" ||
                  state === "faulted" ||
                  state === "closed"
                ) {
                  throw new Error("WSS normal egress is closed");
                }
                await sendRaw(serialized);
              });
            } catch (error) {
              observeDiagnostic("egress", "internal", 1011, error);
              throw error;
            }
          };

          const sendTerminalError = async (serialized: string): Promise<void> => {
            if (terminalErrorAttempted) return;
            terminalErrorAttempted = true;
            await appendEgress(async () => {
              await sendRaw(serialized);
            });
          };

          const safeChannelCloseReason = (code: number): string =>
            code === 1001
              ? "server draining"
              : code === 4401
                ? "RBP authentication failed"
                : code === 4403
                  ? "RBP authorization failed"
                  : code === 4426
                    ? "RBP version negotiation failed"
                    : code === 1011
                      ? "RBP internal error"
                      : "RBP connection closed";

          const scheduleTeardown = (input: {
            readonly closeCode: number | null;
            readonly closeReason: string;
            readonly publicFault: PublicWssFault | null;
            readonly sendFaultFrame: boolean;
          }): Promise<void> => {
            if (teardownTask !== null) return teardownTask;
            terminalEgressClaimed = true;
            if (state !== "faulted" && state !== "closed") state = "closing";
            const task = append(async () => {
              try {
                if (readsPaused) {
                  try {
                    websocket.resume();
                  } catch {
                    // A transport that cannot resume is terminated below if
                    // the orderly close cannot be initiated.
                  }
                  readsPaused = false;
                }
                if (
                  input.publicFault !== null &&
                  input.sendFaultFrame &&
                  websocket.readyState === WebSocket.OPEN
                ) {
                  try {
                    await sendTerminalError(
                      JSON.stringify({
                        v: 1,
                        type: "error",
                        id: gatewayUuidV7(Date.now()),
                        ts: new Date().toISOString(),
                        payload: {
                          retryable: false,
                          fault_class: input.publicFault.wireFaultClass,
                          outcome: "known",
                          verification_required: false,
                          message: input.publicFault.message,
                        },
                      } satisfies RbpEnvelope),
                    );
                  } catch (error) {
                    observeDiagnostic(
                      "egress",
                      "internal",
                      input.closeCode ?? 1011,
                      error,
                    );
                  }
                }
                if (
                  input.closeCode !== null &&
                  websocket.readyState === WebSocket.OPEN
                ) {
                  try {
                    websocket.close(input.closeCode, input.closeReason.slice(0, 123));
                  } catch (error) {
                    observeDiagnostic("teardown", "internal", 1011, error);
                    websocket.terminate();
                  }
                }
              } finally {
                if (authorityConnectionId !== null) {
                  try {
                    await authority.detach(authorityConnectionId);
                  } catch (error) {
                    observeDiagnostic("teardown", "internal", 1011, error);
                  }
                }
                state = "closed";
              }
            });
            teardownTask = task.catch((error: unknown) => {
              observeDiagnostic("teardown", "internal", 1011, error);
              state = "closed";
              if (websocket.readyState !== WebSocket.CLOSED) websocket.terminate();
            });
            return teardownTask;
          };

          const fail = (
            fault: GatewayRbpFault,
            phase: RbpWssInternalDiagnostic["phase"],
          ): void => {
            if (state === "closing" || state === "closed" || state === "faulted") return;
            const sendFaultFrame = state === "open";
            const publicFault = publicWssFault(fault);
            observeDiagnostic(
              phase,
              publicFault.diagnosticFaultClass,
              publicFault.closeCode,
              fault,
            );
            const observation =
              state === "opening" && openingCorrelationId !== null
                ? openingRefusalObservation(fault, openingCorrelationId, "wss")
                : null;
            if (!openingRefusalObserved && observation !== null) {
              openingRefusalObserved = true;
              observeOpeningRefusal(observation);
            }
            terminalEgressClaimed = true;
            state = "faulted";
            void scheduleTeardown({
              closeCode: publicFault.closeCode,
              closeReason: publicFault.closeReason,
              publicFault,
              sendFaultFrame,
            });
          };

          const overload = (): void => {
            if (state === "closing" || state === "closed" || state === "faulted") return;
            terminalEgressClaimed = true;
            state = "faulted";
            void scheduleTeardown({
              closeCode: 1013,
              closeReason: "RBP inbound queue overloaded",
              publicFault: null,
              sendFaultFrame: false,
            });
          };

          const releaseQueueCharge = (bytes: number): void => {
            queuedFrames -= 1;
            queuedBytes -= bytes;
            if (
              readsPaused &&
              queuedBytes < resumeBelowBytes &&
              (state === "opening" || state === "open")
            ) {
              try {
                websocket.resume();
                readsPaused = false;
              } catch (error) {
                fail(internalFault(error), "queue");
              }
            }
          };

          const applyNegotiatedQueueLimits = (opened: {
            readonly helloAck: {
              readonly payload: {
                readonly limits: {
                  readonly max_params_bytes: number;
                  readonly max_partial_bytes: number;
                  readonly max_result_bytes: number;
                };
              };
            };
          }): boolean => {
            const negotiatedFrameBudget = wssFrameBudget({
              maxParamsBytes: opened.helloAck.payload.limits.max_params_bytes,
              maxPartialBytes: opened.helloAck.payload.limits.max_partial_bytes,
              maxInlineTerminalBytes: opened.helloAck.payload.limits.max_result_bytes,
            });
            queuedByteLimit = configuredQueueBytes(
              configuredQueuedByteLimit,
              negotiatedFrameBudget,
            );
            pauseAtBytes = Math.ceil((queuedByteLimit * 3) / 4);
            resumeBelowBytes = Math.ceil(queuedByteLimit / 2);
            if (queuedFrames > queuedFrameLimit || queuedBytes > queuedByteLimit) {
              overload();
              return false;
            }
            return true;
          };

          const channel: BridgeConnectionChannel = {
            send: sendSerialized,
            async close(code, reason): Promise<void> {
              observeDiagnostic(
                "teardown",
                code === 1011 ? "internal" : "protocol",
                code,
                reason,
              );
              terminalEgressClaimed = true;
              if (state !== "faulted" && state !== "closed") state = "closing";
              await scheduleTeardown({
                closeCode: code,
                closeReason: safeChannelCloseReason(code),
                publicFault: null,
                sendFaultFrame: false,
              });
            },
          };

          const processFrame = async (bytes: Buffer, binary: boolean): Promise<void> => {
            if (binary) {
              throw new GatewayRbpFault(
                "protocol",
                "RBP WSS requires text frames",
                400,
                4400,
              );
            }
            let envelope: RbpEnvelope;
            try {
              envelope = parseRbpFrame(bytes);
            } catch (error) {
              throw new GatewayRbpFault(
                "protocol",
                error instanceof Error ? error.message : String(error),
                400,
                4400,
              );
            }
            if (state === "opening") {
              if (envelope.type !== "hello") {
                throw new GatewayRbpFault(
                  "protocol",
                  "first WSS frame must be hello",
                  400,
                  4400,
                );
              }
              openingCorrelationId = envelope.id;
              const opened = await authority.openConnection({
                deviceToken: bearer(request.headers.authorization),
                binding: "wss",
                hello: envelope,
                channel,
              });
              if (authorityConnectionId !== null) {
                throw new Error("WSS socket attempted to claim a second authority connection");
              }
              authorityConnectionId = opened.connectionId;
              if (state !== "opening") return;
              if (!applyNegotiatedQueueLimits(opened)) return;
              await channel.send(JSON.stringify(opened.helloAck));
              if (state === "opening") state = "open";
              return;
            }
            if (state !== "open") return;
            if (envelope.type === "hello") {
              throw new GatewayRbpFault(
                "protocol",
                "hello is only valid as the first WSS frame",
                400,
                4400,
              );
            }
            if (authorityConnectionId === null) {
              throw new Error("open WSS socket has no authority connection");
            }
            await authority.receive(authorityConnectionId, envelope);
          };

          const enqueueFrame = (raw: RawData, binary: boolean): void => {
            if (state !== "opening" && state !== "open") return;
            let bytes: Buffer;
            try {
              bytes = rawFrame(raw);
            } catch (error) {
              fail(internalFault(error), "queue");
              return;
            }
            const nextFrames = queuedFrames + 1;
            const nextBytes = queuedBytes + bytes.byteLength;
            if (nextFrames > queuedFrameLimit || nextBytes > queuedByteLimit) {
              overload();
              return;
            }
            queuedFrames = nextFrames;
            queuedBytes = nextBytes;
            if (!readsPaused && queuedBytes >= pauseAtBytes) {
              try {
                websocket.pause();
                readsPaused = true;
              } catch (error) {
                releaseQueueCharge(bytes.byteLength);
                fail(internalFault(error), "queue");
                return;
              }
            }
            const task = append(async () => {
              try {
                if (state !== "opening" && state !== "open") return;
                await processFrame(bytes, binary);
              } catch (error) {
                fail(
                  error instanceof GatewayRbpFault ? error : internalFault(error),
                  state === "opening" ? "opening" : "receive",
                );
              } finally {
                releaseQueueCharge(bytes.byteLength);
              }
            });
            void task.catch(() => {
              // append() has already installed the queue-tail rejection sink.
            });
          };

          websocket.on("error", (error) => {
            fail(internalFault(error), "transport");
          });
          websocket.once("close", () => {
            terminalEgressClaimed = true;
            if (state !== "faulted" && state !== "closed") state = "closing";
            void scheduleTeardown({
              closeCode: null,
              closeReason: "WSS transport closed",
              publicFault: null,
              sendFaultFrame: false,
            });
          });
          websocket.on("message", enqueueFrame);
        });
      })().catch((error: unknown) => {
        observeWssInternalDiagnostic({
          contractVersion: RBP_WSS_INTERNAL_DIAGNOSTIC_CONTRACT,
          event: "gateway.rbp_wss_internal_diagnostic",
          phase: "opening",
          faultClass: "internal",
          closeCode: 1011,
          detail: error instanceof Error ? error.message : String(error),
        });
        rawResponse(socket, 503, { error: "RBP upgrade unavailable" });
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
