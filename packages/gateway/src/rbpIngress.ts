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
import type { DeviceAuthContext } from "./authContext.js";
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
const RBP_WSS_DEFAULT_SEND_COMPLETION_TIMEOUT_MS = 5_000;
const RBP_WSS_MIN_SEND_COMPLETION_TIMEOUT_MS = 1;
const RBP_WSS_MAX_SEND_COMPLETION_TIMEOUT_MS = 60_000;
const HTTP_SSE_GLOBAL_CONNECTION_LIMIT = 1_024;
const HTTP_SSE_TENANT_CONNECTION_LIMIT = 128;
const HTTP_SSE_DEVICE_CONNECTION_LIMIT = 8;
const HTTP_SSE_ATTACH_TTL_MS = 30_000;
const HTTP_SSE_REGISTER_TTL_MS = 60_000;
const HTTP_SSE_SWEEP_INTERVAL_MS = 5_000;
const HTTP_SSE_DISPOSED_TOMBSTONE_TTL_MS = 60_000;

type WssConnectionState = "opening" | "open" | "closing" | "closed" | "faulted";
type HttpConnectionState =
  | "created"
  | "sse_attached"
  | "registered"
  | "disposing"
  | "disposed";

interface HttpAdmissionScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly deviceTokenDigest: DeviceAuthContext["deviceTokenDigest"];
  readonly machineFingerprint: DeviceAuthContext["machineFingerprint"];
  readonly authorizationVersion: DeviceAuthContext["authorizationVersion"];
  readonly identityRecordVersion: DeviceAuthContext["identityRecordVersion"];
  readonly connectionCapabilityVersion: DeviceAuthContext["connectionCapabilityVersion"];
  readonly sessionCapabilityVersion: DeviceAuthContext["sessionCapabilityVersion"];
  readonly seatAuthorityVersion: DeviceAuthContext["seatAuthorityVersion"];
  readonly seatRecordVersion: DeviceAuthContext["seatRecordVersion"];
  readonly grantedConnectionCapabilities: readonly string[] | undefined;
  readonly grantedSessionCapabilities: readonly string[];
}

interface HttpConnectionEntry {
  readonly connectionId: string;
  readonly channel: HttpSseChannel;
  readonly scope: HttpAdmissionScope;
  state: HttpConnectionState;
  expiresAtMs: number;
  disposePromise: Promise<void> | null;
}

interface WssFrameCeilings {
  readonly maxParamsBytes: number;
  readonly maxPartialBytes: number;
  readonly maxInlineTerminalBytes: number;
}

export interface RbpWssQueueConfig {
  readonly queuedFrames?: number;
  readonly queuedBytes?: number;
}

export interface RbpWssEgressConfig {
  readonly queuedFrames?: number;
  readonly queuedBytes?: number;
  readonly sendCompletionTimeoutMs?: number;
}

/** Testable clock/scheduler seam; production always retains the frozen values. */
export interface RbpHttpSseLifecycleRuntime {
  readonly clock?: () => number;
  readonly setInterval?: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  /** Value-free bounded-accounting observation for deterministic lifecycle tests. */
  readonly onLifecycleSnapshot?: (snapshot: {
    readonly entries: number;
    readonly globalAdmissions: number;
    readonly tenantAdmissions: number;
    readonly deviceAdmissions: number;
  }) => void;
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
  readonly wssEgress?: RbpWssEgressConfig;
  readonly httpSseLifecycleRuntime?: RbpHttpSseLifecycleRuntime;
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

function clampedInteger(
  configured: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const value = configured ?? defaultValue;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function configuredEgressQueueBytes(
  configured: number | undefined,
  frameBudget: number,
): number {
  return clampedInteger(
    configured,
    2 * frameBudget,
    frameBudget,
    2 * frameBudget,
    "wssEgress.queuedBytes",
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

/**
 * Non-production carrier for the exact production ingress implementation.
 *
 * This deliberately does not subclass or reimplement any ingress lifecycle:
 * the returned object forwards the production mount/start/upgrade/drain/close
 * functions verbatim and changes only the deployment-admission kind.  That
 * makes a conformance listener observable as such while keeping C28/C29 on
 * the production RBP state machine.
 */
export interface ConformanceRbpIngressHost extends RbpIngressHost {
  readonly kind: "conformance";
  readonly enabled: true;
  readonly authority: GatewayBridgeSessionAuthority;
  readonly delegate: ProductionRbpIngressHost;
}

export function createConformanceRbpIngressHost(
  options: ProductionRbpIngressOptions,
): ConformanceRbpIngressHost {
  const delegate = createProductionRbpIngressHost(options);
  return Object.freeze({
    kind: "conformance" as const,
    mountPrefix: delegate.mountPrefix,
    enabled: true as const,
    authority: delegate.authority,
    delegate,
    refuse: delegate.refuse,
    start: delegate.start,
    mount: delegate.mount,
    handleUpgrade: delegate.handleUpgrade,
    beginDrain: delegate.beginDrain,
    close: delegate.close,
  });
}

class HttpSseChannel implements BridgeConnectionChannel {
  readonly #pending: string[] = [];
  #response: ServerResponse | null = null;
  #pendingBytes = 0;
  #closed = false;

  public constructor(private readonly onClose: () => void) {}

  public get closed(): boolean {
    return this.#closed;
  }

  #fail(error: Error): never {
    this.onClose();
    throw error;
  }

  public attach(response: ServerResponse): void {
    if (this.#closed) {
      this.#fail(new GatewayRbpFault("auth", "SSE authority is revoked", 403, 4403));
    }
    if (this.#response !== null) {
      throw new GatewayRbpFault("protocol", "SSE stream is already attached", 409, 4400);
    }
    this.#response = response;
    response.once("close", this.onClose);
    response.once("error", this.onClose);
    if (response.destroyed || response.writableEnded) {
      this.#fail(new Error("SSE stream is closed"));
    }
    try {
      for (const serialized of this.#pending.splice(0)) {
        if (!response.write(`event: rbp\ndata: ${serialized}\n\n`)) {
          throw new Error("SSE stream applied backpressure while attaching");
        }
      }
    } catch (error) {
      if (error instanceof Error) this.#fail(error);
      this.#fail(new Error(String(error)));
    }
    this.#pendingBytes = 0;
  }

  public async send(serialized: string): Promise<void> {
    if (this.#closed) this.#fail(new Error("SSE stream is closed"));
    const response = this.#response;
    if (response === null) {
      const nextBytes = this.#pendingBytes + Buffer.byteLength(serialized);
      if (nextBytes > MAX_PENDING_TRANSPORT_BYTES) {
        this.#fail(new Error("SSE attach backlog exceeds the bounded transport window"));
      }
      this.#pendingBytes = nextBytes;
      this.#pending.push(serialized);
      return;
    }
    if (response.destroyed || response.writableEnded) {
      this.#fail(new Error("SSE stream is closed"));
    }
    let writable: boolean;
    try {
      writable = response.write(`event: rbp\ndata: ${serialized}\n\n`);
    } catch (error) {
      if (error instanceof Error) this.#fail(error);
      this.#fail(new Error(String(error)));
    }
    if (!writable) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => finish();
        const onClose = (): void => finish(new Error("SSE stream closed before drain"));
        const onError = (error: Error): void => finish(error);
        const finish = (error?: Error): void => {
          response.off("drain", onDrain);
          response.off("close", onClose);
          response.off("error", onError);
          if (error !== undefined) this.onClose();
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
    if (this.#closed) return;
    this.#closed = true;
    let closeError: Error | null = null;
    if (this.#response !== null && !this.#response.writableEnded) {
      try {
        this.#response.end();
      } catch (error) {
        closeError = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.#response = null;
    this.#pending.length = 0;
    this.#pendingBytes = 0;
    this.onClose();
    if (closeError !== null) throw closeError;
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
  const httpSseClock = options.httpSseLifecycleRuntime?.clock ?? Date.now;
  const scheduleHttpSseSweep = options.httpSseLifecycleRuntime?.setInterval ?? setInterval;
  const clearHttpSseSweep = options.httpSseLifecycleRuntime?.clearInterval ?? clearInterval;
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
  const egressQueuedFrameLimit = clampedInteger(
    options.wssEgress?.queuedFrames,
    RBP_WSS_DEFAULT_QUEUED_FRAMES,
    RBP_WSS_MIN_QUEUED_FRAMES,
    RBP_WSS_MAX_QUEUED_FRAMES,
    "wssEgress.queuedFrames",
  );
  const configuredEgressQueuedByteLimit = options.wssEgress?.queuedBytes;
  const localEgressQueuedByteLimit = configuredEgressQueueBytes(
    configuredEgressQueuedByteLimit,
    LOCAL_WSS_FRAME_BUDGET_BYTES,
  );
  const sendCompletionTimeoutMs = clampedInteger(
    options.wssEgress?.sendCompletionTimeoutMs,
    RBP_WSS_DEFAULT_SEND_COMPLETION_TIMEOUT_MS,
    RBP_WSS_MIN_SEND_COMPLETION_TIMEOUT_MS,
    RBP_WSS_MAX_SEND_COMPLETION_TIMEOUT_MS,
    "wssEgress.sendCompletionTimeoutMs",
  );
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_HTTP_MESSAGE_BYTES,
  });
  const httpConnections = new Map<string, HttpConnectionEntry>();
  const httpDisposed = new Map<string, number>();
  const httpTenantCounts = new Map<string, number>();
  const httpDeviceCounts = new Map<string, number>();
  let httpGlobalCount = 0;
  let httpAdmissionTail = Promise.resolve();
  let draining = false;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;

  const observeHttpLifecycle = (): void => {
    options.httpSseLifecycleRuntime?.onLifecycleSnapshot?.(
      Object.freeze({
        entries: httpConnections.size,
        globalAdmissions: httpGlobalCount,
        tenantAdmissions: httpTenantCounts.size,
        deviceAdmissions: httpDeviceCounts.size,
      }),
    );
  };

  const httpAdmission = async <T>(operation: () => Promise<T>): Promise<T> => {
    const prior = httpAdmissionTail;
    let release!: () => void;
    httpAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const releaseHttpAdmission = (scope: HttpAdmissionScope): void => {
    httpGlobalCount -= 1;
    const tenantCount = (httpTenantCounts.get(scope.tenantId) ?? 1) - 1;
    if (tenantCount === 0) httpTenantCounts.delete(scope.tenantId);
    else httpTenantCounts.set(scope.tenantId, tenantCount);
    const deviceKey = `${scope.tenantId}\u0000${scope.deviceId}`;
    const deviceCount = (httpDeviceCounts.get(deviceKey) ?? 1) - 1;
    if (deviceCount === 0) httpDeviceCounts.delete(deviceKey);
    else httpDeviceCounts.set(deviceKey, deviceCount);
    observeHttpLifecycle();
  };

  const reserveHttpAdmission = (scope: HttpAdmissionScope): void => {
    const tenantCount = httpTenantCounts.get(scope.tenantId) ?? 0;
    const deviceKey = `${scope.tenantId}\u0000${scope.deviceId}`;
    const deviceCount = httpDeviceCounts.get(deviceKey) ?? 0;
    if (
      httpGlobalCount >= HTTP_SSE_GLOBAL_CONNECTION_LIMIT ||
      tenantCount >= HTTP_SSE_TENANT_CONNECTION_LIMIT ||
      deviceCount >= HTTP_SSE_DEVICE_CONNECTION_LIMIT
    ) {
      throw new GatewayRbpFault(
        "unavailable",
        "HTTP/SSE connection admission limit reached",
        429,
        1013,
      );
    }
    httpGlobalCount += 1;
    httpTenantCounts.set(scope.tenantId, tenantCount + 1);
    httpDeviceCounts.set(deviceKey, deviceCount + 1);
    observeHttpLifecycle();
  };

  const disposeHttpConnection = (entry: HttpConnectionEntry): Promise<void> => {
    if (entry.disposePromise !== null) return entry.disposePromise;
    entry.state = "disposing";
    // Make this connection invisible to new work before any transport or
    // authority operation. All terminal paths converge here, so counters are
    // released exactly once even when close/error/TTL race each other.
    httpConnections.delete(entry.connectionId);
    releaseHttpAdmission(entry.scope);
    httpDisposed.set(entry.connectionId, httpSseClock() + HTTP_SSE_DISPOSED_TOMBSTONE_TTL_MS);
    let settle!: () => void;
    entry.disposePromise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    void (async () => {
      try {
        await entry.channel.close();
      } catch {
        // A transport failure cannot retain the admission reservation.
      }
      try {
        await authority.detach(entry.connectionId);
      } catch {
        // Detach is containment work; the admission has already been released.
      } finally {
        entry.state = "disposed";
        settle();
      }
    })();
    return entry.disposePromise;
  };

  const disposeHttpCredentialFailure = async (
    entry: HttpConnectionEntry | undefined,
    error: unknown,
  ): Promise<void> => {
    if (
      entry !== undefined &&
      error instanceof GatewayRbpFault &&
      error.httpStatus === 403
    ) {
      await disposeHttpConnection(entry);
    }
  };

  const sweepHttpConnections = (): void => {
    const now = httpSseClock();
    for (const [connectionId, expiresAtMs] of httpDisposed) {
      if (expiresAtMs <= now) httpDisposed.delete(connectionId);
    }
    for (const entry of [...httpConnections.values()]) {
      if (entry.expiresAtMs <= now) void disposeHttpConnection(entry);
    }
  };

  const sameStringList = (
    left: readonly string[] | undefined,
    right: readonly string[] | undefined,
  ): boolean => {
    if (left === undefined || right === undefined) return left === right;
    return left.length === right.length && left.every((value, index) => value === right[index]);
  };

  const admissionScope = (authenticated: DeviceAuthContext): HttpAdmissionScope =>
    Object.freeze({
      tenantId: authenticated.actor.tenantId,
      userId: authenticated.actor.userId,
      deviceId: authenticated.actor.deviceId,
      seatId: authenticated.actor.seatId,
      deviceTokenDigest: authenticated.deviceTokenDigest,
      machineFingerprint: authenticated.machineFingerprint,
      authorizationVersion: authenticated.authorizationVersion,
      identityRecordVersion: authenticated.identityRecordVersion,
      connectionCapabilityVersion: authenticated.connectionCapabilityVersion,
      sessionCapabilityVersion: authenticated.sessionCapabilityVersion,
      seatAuthorityVersion: authenticated.seatAuthorityVersion,
      seatRecordVersion: authenticated.seatRecordVersion,
      grantedConnectionCapabilities: authenticated.grantedConnectionCapabilities,
      grantedSessionCapabilities: authenticated.grantedSessionCapabilities,
    });

  const admissionScopeMatches = (
    expected: HttpAdmissionScope,
    actual: DeviceAuthContext,
  ): boolean =>
    actual.deviceStatus === "active" &&
    actual.actor.tenantId === expected.tenantId &&
    actual.actor.userId === expected.userId &&
    actual.actor.deviceId === expected.deviceId &&
    actual.actor.seatId === expected.seatId &&
    actual.deviceTokenDigest === expected.deviceTokenDigest &&
    actual.machineFingerprint === expected.machineFingerprint &&
    actual.authorizationVersion === expected.authorizationVersion &&
    actual.identityRecordVersion === expected.identityRecordVersion &&
    actual.connectionCapabilityVersion === expected.connectionCapabilityVersion &&
    actual.sessionCapabilityVersion === expected.sessionCapabilityVersion &&
    actual.seatAuthorityVersion === expected.seatAuthorityVersion &&
    actual.seatRecordVersion === expected.seatRecordVersion &&
    sameStringList(expected.grantedConnectionCapabilities, actual.grantedConnectionCapabilities) &&
    sameStringList(expected.grantedSessionCapabilities, actual.grantedSessionCapabilities);

  const preauthenticateHttpScope = async (
    hello: HelloEnvelope,
    deviceToken: string | undefined,
  ): Promise<HttpAdmissionScope> => {
    const authenticated = await authority.identity.authenticateDevice({
      deviceToken,
      connectionId: gatewayUuidV7(httpSseClock()),
      claimedDeviceId: hello.payload.device_id,
      machineFingerprint: hello.payload.machine.fingerprint,
      machineHostname: hello.payload.machine.hostname,
    });
    if (!authenticated.ok) {
      throw new GatewayRbpFault("auth", authenticated.message, 401, 4401);
    }
    if (authenticated.value.deviceStatus !== "active") {
      throw new GatewayRbpFault("auth", "device or seat is not active", 403, 4403);
    }
    if (authenticated.value.actor.deviceId !== hello.payload.device_id) {
      throw new GatewayRbpFault("auth", "hello device identity does not match credential", 403, 4403);
    }
    return admissionScope(authenticated.value);
  };

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
      livenessTimer = scheduleHttpSseSweep(() => {
        sweepHttpConnections();
        void authority.sweepLiveness().catch(() => {
          // Losing durable liveness authority is a fail-closed condition: keep
          // existing sockets available for shutdown evidence, but admit no new
          // connection that could be mistaken for authorized dispatch state.
          draining = true;
        });
      }, HTTP_SSE_SWEEP_INTERVAL_MS);
      (livenessTimer as unknown as { readonly unref?: () => void }).unref?.();
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
            const opened = await httpAdmission(async () => {
              const deviceToken = bearer(request.headers.authorization);
              const scope = await preauthenticateHttpScope(hello as HelloEnvelope, deviceToken);
              reserveHttpAdmission(scope);
              let entry: HttpConnectionEntry | null = null;
              let openedConnectionId: string | null = null;
              const channel = new HttpSseChannel(() => {
                if (entry !== null) void disposeHttpConnection(entry);
              });
              try {
                const opening = await authority.openConnection({
                  deviceToken,
                  binding: "http_sse",
                  hello: hello as HelloEnvelope,
                  channel,
                });
                openedConnectionId = opening.connectionId;
                const boundConnection = await authority.assertConnectionCredential(
                  opening.connectionId,
                  deviceToken,
                );
                if (!admissionScopeMatches(scope, boundConnection.auth)) {
                  throw new GatewayRbpFault(
                    "auth",
                    "HTTP/SSE admission identity changed before connection binding",
                    403,
                    4403,
                  );
                }
                entry = {
                  connectionId: opening.connectionId,
                  channel,
                  scope,
                  state: "created",
                  expiresAtMs: httpSseClock() + HTTP_SSE_ATTACH_TTL_MS,
                  disposePromise: null,
                };
                httpConnections.set(opening.connectionId, entry);
                observeHttpLifecycle();
                authority.assertConnectionOutbound(opening.connectionId);
                return opening;
              } catch (error) {
                if (entry === null) {
                  releaseHttpAdmission(scope);
                  if (openedConnectionId !== null) {
                    try {
                      await authority.detach(openedConnectionId);
                    } catch {
                      // The failed opening is already invisible and uncharged.
                    }
                  }
                } else await disposeHttpConnection(entry);
                throw error;
              }
            });
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
          let entry: HttpConnectionEntry | undefined;
          try {
            entry = httpConnections.get(connectionId);
            if (entry === undefined) {
              throw new GatewayRbpFault(
                "unavailable",
                httpDisposed.has(connectionId) ? "connection is disposed" : "unknown connection",
                httpDisposed.has(connectionId) ? 410 : 404,
                4401,
              );
            }
            const attachedEntry = entry;
            await authority.assertConnectionCredential(
              connectionId,
              bearer(request.headers.authorization),
            );
            authority.assertConnectionOutbound(connectionId);
            reply.hijack();
            reply.raw.writeHead(200, {
              "Cache-Control": "no-cache, no-store",
              Connection: "keep-alive",
              "Content-Type": "text/event-stream",
              "X-Accel-Buffering": "no",
            });
            reply.raw.flushHeaders();
            attachedEntry.channel.attach(reply.raw);
            if (attachedEntry.state !== "registered") {
              attachedEntry.state = "sse_attached";
              attachedEntry.expiresAtMs = httpSseClock() + HTTP_SSE_ATTACH_TTL_MS;
            }
            // Last-Event-ID is deliberately ignored. RBP sequence state is the
            // only replay authority and lives in the durable session record.
            reply.raw.once("close", () => {
              void disposeHttpConnection(attachedEntry);
            });
          } catch (error) {
            await disposeHttpCredentialFailure(entry, error);
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
          let entry: HttpConnectionEntry | undefined;
          try {
            entry = httpConnections.get(connectionId);
            if (entry === undefined) {
              throw new GatewayRbpFault(
                "unavailable",
                httpDisposed.has(connectionId) ? "connection is disposed" : "unknown connection",
                httpDisposed.has(connectionId) ? 410 : 404,
                4401,
              );
            }
            await authority.assertConnectionCredential(
              connectionId,
              bearer(request.headers.authorization),
            );
            const envelope = frame(request.body);
            await authority.receive(connectionId, envelope);
            if (envelope.type === "session_register" || envelope.type === "session_resume") {
              entry.state = "registered";
              entry.expiresAtMs = httpSseClock() + HTTP_SSE_REGISTER_TTL_MS;
            } else if (entry.state === "registered" && envelope.type === "heartbeat") {
              // The entry is already located by connection id, so heartbeat
              // renewal never scans the connection registry.
              entry.expiresAtMs = httpSseClock() + HTTP_SSE_REGISTER_TTL_MS;
            }
            authority.assertConnectionOutbound(connectionId);
            // receive() commits sequence/journal changes before resolving.
            return reply.code(202).send({ accepted: true });
          } catch (error) {
            await disposeHttpCredentialFailure(entry, error);
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
          let applicationEgressFrames = 0;
          let applicationEgressBytes = 0;
          let egressQueuedByteLimit = localEgressQueuedByteLimit;
          let terminalEgressClaimed = false;
          let terminalErrorAttempted = false;
          let teardownTask: Promise<void> | null = null;
          let detachRequested = false;
          let detachedConnectionId: string | null = null;
          let detachTask: Promise<void> | null = null;
          let transportFinalized = false;
          const pendingSendCancellations = new Set<(error: Error) => void>();

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

          const cancelPendingSends = (error: Error): void => {
            for (const cancel of [...pendingSendCancellations]) cancel(error);
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
              let settled = false;
              const finish = (error?: unknown): void => {
                if (settled) return;
                settled = true;
                pendingSendCancellations.delete(cancel);
                if (error === undefined || error === null) resolve();
                else reject(error);
              };
              const cancel = (error: Error): void => finish(error);
              pendingSendCancellations.add(cancel);
              try {
                websocket.send(serialized, (error) => finish(error));
              } catch (error) {
                finish(error);
              }
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
            const serializedBytes = Buffer.byteLength(serialized);
            const nextFrames = applicationEgressFrames + 1;
            const nextBytes = applicationEgressBytes + serializedBytes;
            if (
              nextFrames > egressQueuedFrameLimit ||
              nextBytes > egressQueuedByteLimit
            ) {
              egressOverload();
              throw new Error("WSS application egress queue overloaded");
            }
            applicationEgressFrames = nextFrames;
            applicationEgressBytes = nextBytes;
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
            } finally {
              applicationEgressFrames -= 1;
              applicationEgressBytes -= serializedBytes;
            }
          };

          const settleEgressForTeardown = async (
            terminalSerialized: string | null,
            closeCode: number,
          ): Promise<"settled" | "failed" | "timed_out"> => {
            let timedOut = false;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const operation = (async (): Promise<"settled" | "timed_out"> => {
              await egressTail;
              if (timedOut) return "timed_out";
              if (terminalSerialized !== null && !terminalErrorAttempted) {
                terminalErrorAttempted = true;
                await sendRaw(terminalSerialized);
              }
              return "settled";
            })();
            const observedOperation = operation.catch((error: unknown) => {
              observeDiagnostic("egress", "internal", closeCode, error);
              return timedOut ? ("timed_out" as const) : ("failed" as const);
            });
            const timeout = new Promise<"timed_out">((resolve) => {
              timer = setTimeout(() => {
                timedOut = true;
                cancelPendingSends(new Error("WSS send completion timed out"));
                resolve("timed_out");
              }, sendCompletionTimeoutMs);
            });
            const result = await Promise.race([observedOperation, timeout]);
            if (timer !== null) clearTimeout(timer);
            if (result === "timed_out") {
              cancelPendingSends(new Error("WSS send completion timed out"));
              await egressTail;
            }
            return result;
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

          const detachOnce = (): Promise<void> => {
            detachRequested = true;
            if (authorityConnectionId === null) return Promise.resolve();
            if (detachedConnectionId !== null) return detachTask ?? Promise.resolve();
            detachedConnectionId = authorityConnectionId;
            detachTask = authority.detach(authorityConnectionId).catch((error: unknown) => {
              observeDiagnostic("teardown", "internal", 1011, error);
            });
            return detachTask;
          };

          const finalizeTransportOnce = (
            force: boolean,
            closeCode: number | null,
            closeReason: string,
          ): void => {
            if (transportFinalized) return;
            transportFinalized = true;
            if (websocket.readyState === WebSocket.CLOSED) return;
            if (!force && websocket.readyState === WebSocket.CLOSING) {
              // ws already owns a protocol close (for example maxPayload 1009).
              return;
            }
            if (force || closeCode === null || websocket.readyState !== WebSocket.OPEN) {
              try {
                websocket.terminate();
              } catch (error) {
                observeDiagnostic("teardown", "internal", 1011, error);
              }
              return;
            }
            try {
              websocket.close(closeCode, closeReason.slice(0, 123));
            } catch (error) {
              observeDiagnostic("teardown", "internal", 1011, error);
              try {
                websocket.terminate();
              } catch (terminateError) {
                observeDiagnostic("teardown", "internal", 1011, terminateError);
              }
            }
          };

          const scheduleTeardown = (input: {
            readonly closeCode: number | null;
            readonly closeReason: string;
            readonly publicFault: PublicWssFault | null;
            readonly sendFaultFrame: boolean;
          }): Promise<void> => {
            if (teardownTask !== null) return teardownTask;
            terminalEgressClaimed = true;
            if (state !== "faulted" && state !== "closed") state = "closing";
            const pendingAtClaim = pendingSendCancellations.size;
            const claimedEgressTail = egressTail;
            let accountingObserved = false;
            let watchdogFired = false;
            let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
            const watchdog = new Promise<void>((resolve) => {
              watchdogTimer = setTimeout(() => {
                watchdogFired = true;
                cancelPendingSends(new Error("WSS teardown watchdog expired"));
                observeDiagnostic(
                  "egress",
                  "internal",
                  input.closeCode ?? 1011,
                  new Error("WSS send completion timed out"),
                );
                finalizeTransportOnce(true, input.closeCode, input.closeReason);
                void detachOnce();
                state = "closed";
                resolve();
              }, sendCompletionTimeoutMs);
            });
            // This cancellation must happen before the cleanup is appended
            // behind serialTail: processFrame may itself be awaiting this send.
            cancelPendingSends(new Error("WSS send cancelled for teardown"));
            if (pendingAtClaim > 0) {
              void claimedEgressTail.then(() => {
                if (accountingObserved) return;
                accountingObserved = true;
                observeDiagnostic(
                  "egress",
                  "internal",
                  input.closeCode ?? 1011,
                  new Error(
                    `WSS egress accounting released frames=${String(applicationEgressFrames)} bytes=${String(applicationEgressBytes)}`,
                  ),
                );
              });
            }
            const serializedCleanup = append(async () => {
              if (watchdogFired) return;
              if (readsPaused) {
                try {
                  websocket.resume();
                } catch {
                  // The watchdog owns the force-close fallback.
                }
                readsPaused = false;
              }
              const terminalSerialized =
                input.publicFault !== null && input.sendFaultFrame
                  ? JSON.stringify({
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
                    } satisfies RbpEnvelope)
                  : null;
              const egressResult = await settleEgressForTeardown(
                terminalSerialized,
                input.closeCode ?? 1011,
              );
              if (watchdogFired) return;
              if (egressResult === "timed_out") {
                observeDiagnostic(
                  "egress",
                  "internal",
                  input.closeCode ?? 1011,
                  new Error("WSS send completion timed out"),
                );
                finalizeTransportOnce(true, input.closeCode, input.closeReason);
              } else {
                finalizeTransportOnce(false, input.closeCode, input.closeReason);
              }
              await detachOnce();
              if (!watchdogFired) state = "closed";
            });
            const observedCleanup = serializedCleanup.catch(async (error: unknown) => {
              observeDiagnostic("teardown", "internal", 1011, error);
              finalizeTransportOnce(true, input.closeCode, input.closeReason);
              await detachOnce();
              state = "closed";
            });
            teardownTask = Promise.race([observedCleanup, watchdog]).finally(() => {
              if (watchdogTimer !== null) clearTimeout(watchdogTimer);
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

          function egressOverload(): void {
            if (state === "closing" || state === "closed" || state === "faulted") return;
            terminalEgressClaimed = true;
            state = "faulted";
            void scheduleTeardown({
              closeCode: 1013,
              closeReason: "RBP application egress overloaded",
              publicFault: null,
              sendFaultFrame: false,
            });
          }

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
            egressQueuedByteLimit = configuredEgressQueueBytes(
              configuredEgressQueuedByteLimit,
              negotiatedFrameBudget,
            );
            pauseAtBytes = Math.ceil((queuedByteLimit * 3) / 4);
            resumeBelowBytes = Math.ceil(queuedByteLimit / 2);
            if (queuedFrames > queuedFrameLimit || queuedBytes > queuedByteLimit) {
              overload();
              return false;
            }
            if (
              applicationEgressFrames > egressQueuedFrameLimit ||
              applicationEgressBytes > egressQueuedByteLimit
            ) {
              egressOverload();
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
              if (detachRequested) void detachOnce();
              if (state !== "opening") return;
              if (!applyNegotiatedQueueLimits(opened)) return;
              authority.assertConnectionOutbound(opened.connectionId);
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
      for (const entry of [...httpConnections.values()]) {
        void disposeHttpConnection(entry);
      }
    },
    async close(): Promise<void> {
      draining = true;
      if (livenessTimer !== null) {
        clearHttpSseSweep(livenessTimer);
        livenessTimer = null;
      }
      await Promise.all(
        [...httpConnections.values()].map((entry) => disposeHttpConnection(entry)),
      );
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
