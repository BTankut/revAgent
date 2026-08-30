import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { isAbsolute, parse, resolve } from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

import {
  parseRbpFrame,
  rbpEnvelopeErrors,
  validateRbpEnvelope,
  type HelloAckEnvelope,
  type HelloEnvelope,
  type RbpEnvelope,
} from "@revagent/protocol";
import WebSocket from "ws";

export type BridgeBindingKind = "wss" | "streamable_http_sse";
export type GatewayEndpointPolicy =
  | "production"
  | "loopback_test_readiness"
  | "loopback_test_tls";
export type GatewayTransportFailureClass =
  | "retryable_network"
  | "auth"
  | "version"
  | "trust"
  | "protocol";

export interface GatewayCloseInfo {
  readonly code: number;
  readonly reason: string;
}

export class GatewayTransportError extends Error {
  public readonly faultClass: GatewayTransportFailureClass;
  public readonly closeCode: number | null;
  public readonly closeReason: string | null;
  public readonly httpStatus: number | null;
  public readonly protocolMin: number | null;
  public readonly protocolMax: number | null;
  public readonly manifestUrl: string | null;
  public readonly retryAfterMs: number | null;

  public constructor(
    message: string,
    options: {
      readonly faultClass: GatewayTransportFailureClass;
      readonly closeCode?: number;
      readonly closeReason?: string;
      readonly httpStatus?: number;
      readonly protocolMin?: number;
      readonly protocolMax?: number;
      readonly manifestUrl?: string;
      readonly retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = "GatewayTransportError";
    this.faultClass = options.faultClass;
    this.closeCode = options.closeCode ?? null;
    this.closeReason = options.closeReason ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.protocolMin = options.protocolMin ?? null;
    this.protocolMax = options.protocolMax ?? null;
    this.manifestUrl = options.manifestUrl ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface GatewayBinding {
  readonly kind: BridgeBindingKind;
  readonly connectionId: string | null;
  readonly bufferedAmount: number;
  open(hello: HelloEnvelope): Promise<HelloAckEnvelope>;
  send(envelope: RbpEnvelope): Promise<void>;
  /**
   * Test-simulator seam for sending one deliberately invalid chunk frame over
   * the already negotiated binding. Production Bridge flows never call this.
   */
  sendChunkConformanceFrame?(
    frame: unknown,
  ): Promise<GatewayChunkConformanceFaultEvidence>;
  sendChunkConformanceFrames?(
    frames: readonly unknown[],
  ): Promise<GatewayChunkConformanceFaultEvidence>;
  messages(): AsyncIterable<RbpEnvelope>;
  close(): Promise<void>;
}

export interface GatewayChunkConformanceFaultEvidence {
  readonly binding: BridgeBindingKind;
  readonly accepted: false;
  readonly source: "gateway_error_envelope_and_close" | "authenticated_http_response";
  readonly faultClass: GatewayTransportFailureClass;
  readonly httpStatus: number | null;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  readonly message: string;
}

export interface BindingOptions {
  readonly baseUrl: string;
  readonly deviceToken: string;
  readonly versionsHeader?: string;
  /**
   * Defaults to production. Test policies accept only explicit-port numeric
   * loopback: cleartext T5 readiness or pinned-certificate WSS conformance.
   */
  readonly endpointPolicy?: GatewayEndpointPolicy;
  readonly openTimeoutMs?: number;
  readonly sendTimeoutMs?: number;
  readonly fetchTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * A narrow conformance-only trust root and leaf pin. This is accepted only
   * for numeric-loopback WSS under `loopback_test_tls`.
   */
  readonly testTlsTrust?: LoopbackTestTlsTrust;
  /** Test-adapter seam; production callers leave this unset. */
  readonly webSocketFactory?: (
    url: string,
    options: WebSocket.ClientOptions,
  ) => WebSocket;
}

export interface LoopbackTestTlsTrust {
  /** Absolute path to the public CA/certificate bytes supplied to the current test stack. */
  readonly caCertificatePath: string;
  /** SHA-256 of the exact file bytes at `caCertificatePath`. */
  readonly caCertificateSha256: string;
  /** SHA-256 of the DER leaf certificate presented by the current Gateway process. */
  readonly serverCertificateSha256: string;
}

export interface LoopbackTestTlsTrustEvidence {
  readonly caCertificatePath: string;
  readonly caCertificateSha256: string;
  readonly serverCertificateSha256: string;
}

const DEFAULT_OPEN_TIMEOUT_MS = 5_000;
const DEFAULT_SEND_TIMEOUT_MS = 5_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const MAX_RBP_WIRE_FRAME_BYTES = 48 * 1024 * 1024;
const MAX_HTTP_ERROR_BODY_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 15 * 60 * 1_000;
const MAX_TEST_CA_BYTES = 64 * 1024;

interface QueueWaiter<T> {
  readonly resolve: (value: IteratorResult<T>) => void;
  readonly reject: (error: Error) => void;
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: QueueWaiter<T>[] = [];
  #closed = false;
  #error: Error | null = null;

  public push(item: T): void {
    if (this.#closed) throw new Error("message queue is closed");
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter.resolve({ done: false, value: item });
  }

  public close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#error === null) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(this.#error);
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) return { done: false, value: item };
        if (this.#closed) {
          if (this.#error !== null) throw this.#error;
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new RangeError(`${label} must be an integer from 1 through 120000 milliseconds`);
  }
  return timeout;
}

function assertGatewayUrl(
  value: string,
  productionProtocol: "https:" | "wss:",
  testProtocol: "http:" | "ws:",
  endpointPolicy: GatewayEndpointPolicy,
): URL {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Gateway URL must omit userinfo");
  if (url.search || url.hash) throw new Error("Gateway base URL cannot contain query or fragment");
  if (endpointPolicy === "production") {
    if (url.protocol !== productionProtocol) {
      throw new Error(`Production Gateway ${productionProtocol} URL required`);
    }
    if (isIP(url.hostname) !== 0 || !url.hostname.includes(".")) {
      throw new Error("Production Gateway URL must use an authenticated DNS name");
    }
  } else if (endpointPolicy === "loopback_test_readiness") {
    if (url.protocol !== testProtocol) {
      throw new Error(`Loopback test readiness URL must use ${testProtocol}`);
    }
    if (!isNumericUrlLoopback(url.hostname) || url.port.length === 0) {
      throw new Error("Loopback test readiness URL must use numeric loopback and an explicit port");
    }
  } else {
    if (url.protocol !== productionProtocol) {
      throw new Error(`Loopback test TLS URL must use ${productionProtocol}`);
    }
    if (!isNumericUrlLoopback(url.hostname) || url.port.length === 0) {
      throw new Error("Loopback test TLS URL must use numeric loopback and an explicit port");
    }
  }
  return url;
}

function isNumericUrlLoopback(host: string): boolean {
  const normalizedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(normalizedHost);
  if (family === 4) return normalizedHost.split(".")[0] === "127";
  if (family !== 6) return false;
  const normalized = normalizedHost.toLowerCase();
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertedSha256(value: string, label: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 digest`);
  }
  return value;
}

function loadLoopbackTestTlsTrust(input: LoopbackTestTlsTrust): {
  readonly ca: Buffer;
  readonly evidence: LoopbackTestTlsTrustEvidence;
} {
  if (
    typeof input.caCertificatePath !== "string" ||
    input.caCertificatePath.length < 1 ||
    input.caCertificatePath.length > 4_096 ||
    input.caCertificatePath.trim() !== input.caCertificatePath ||
    /[\u0000-\u001f\u007f]/u.test(input.caCertificatePath) ||
    !isAbsolute(input.caCertificatePath)
  ) {
    throw new Error("test TLS CA certificate path must be a bounded absolute path");
  }
  const candidate = resolve(input.caCertificatePath);
  if (parse(candidate).root === candidate) {
    throw new Error("test TLS CA certificate path must not be a filesystem root");
  }
  const path = realpathSync(candidate);
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_TEST_CA_BYTES) {
    throw new Error(`test TLS CA certificate must be a regular file of at most ${MAX_TEST_CA_BYTES} bytes`);
  }
  const ca = readFileSync(path);
  if (
    !ca.includes(Buffer.from("-----BEGIN CERTIFICATE-----", "ascii")) ||
    ca.includes(Buffer.from("PRIVATE KEY", "ascii"))
  ) {
    throw new Error("test TLS CA file must contain public certificate PEM only");
  }
  const caCertificateSha256 = assertedSha256(
    input.caCertificateSha256,
    "test TLS CA certificate digest",
  );
  if (sha256(ca) !== caCertificateSha256) {
    throw new Error("test TLS CA certificate digest does not match the exact file bytes");
  }
  const serverCertificateSha256 = assertedSha256(
    input.serverCertificateSha256,
    "test TLS server certificate digest",
  );
  return {
    ca,
    evidence: {
      caCertificatePath: path,
      caCertificateSha256,
      serverCertificateSha256,
    },
  };
}

function classForCloseCode(code: number): GatewayTransportFailureClass {
  if (code === 4401 || code === 4403) return "auth";
  if (code === 4426) return "version";
  if (code === 1002 || code === 1003 || code === 1007 || code === 1008 || code === 1009) {
    return "protocol";
  }
  if (code === 4400 || (code >= 4000 && code <= 4999)) return "protocol";
  return "retryable_network";
}

type HttpStatusPhase = "wss_upgrade" | "connection_create" | "events_open" | "message_send";

function classForHttpStatus(status: number, phase: HttpStatusPhase): GatewayTransportFailureClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 426) return "version";
  if ([408, 429, 502, 503, 504].includes(status)) return "retryable_network";
  if ((phase === "events_open" || phase === "message_send") && (status === 404 || status === 410)) {
    return "retryable_network";
  }
  // Redirects, successful-but-unexpected codes, and all other authenticated
  // HTTP responses are contract failures. They must never select fallback.
  return "protocol";
}

function closeError(phase: string, code: number, reasonBytes: Buffer): GatewayTransportError {
  const reason = reasonBytes.toString("utf8");
  const detail = reason.length === 0 ? "no reason" : reason;
  return new GatewayTransportError(
    `WSS ${phase} closed with code ${code}: ${detail}`,
    { faultClass: classForCloseCode(code), closeCode: code, closeReason: reason },
  );
}

interface HttpFailureMetadata {
  readonly protocolMin?: number;
  readonly protocolMax?: number;
  readonly manifestUrl?: string;
  readonly retryAfterMs?: number;
}

function httpStatusError(
  phase: string,
  status: number,
  statusPhase: HttpStatusPhase,
  metadata: HttpFailureMetadata = {},
): GatewayTransportError {
  return new GatewayTransportError(
    `${phase} received HTTP ${status}`,
    { faultClass: classForHttpStatus(status, statusPhase), httpStatus: status, ...metadata },
  );
}

function retryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null || value.trim() !== value || value.length === 0) return undefined;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return undefined;
    const delay = seconds * 1_000;
    return delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  const delay = Math.ceil(dateMs - nowMs);
  return delay >= 0 && delay <= MAX_RETRY_AFTER_MS ? delay : undefined;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpFailureMetadata(
  status: number,
  headers: { get(name: string): string | null },
  bytes: Uint8Array,
): HttpFailureMetadata {
  const retry = retryAfterMs(headers.get("retry-after"));
  if (status !== 426 || bytes.byteLength === 0) {
    return retry === undefined ? {} : { retryAfterMs: retry };
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!isJsonRecord(value)) return retry === undefined ? {} : { retryAfterMs: retry };
    const protocolMin = value.min_protocol;
    const protocolMax = value.max_protocol;
    const manifestUrl = value.manifest_url;
    return {
      ...(Number.isSafeInteger(protocolMin) && Number(protocolMin) > 0
        ? { protocolMin: Number(protocolMin) }
        : {}),
      ...(Number.isSafeInteger(protocolMax) && Number(protocolMax) > 0
        ? { protocolMax: Number(protocolMax) }
        : {}),
      ...(typeof manifestUrl === "string" && manifestUrl.length > 0 && manifestUrl.length <= 2_048 &&
        !/[\u0000-\u001f\u007f]/u.test(manifestUrl)
        ? { manifestUrl }
        : {}),
      ...(retry === undefined ? {} : { retryAfterMs: retry }),
    };
  } catch {
    return retry === undefined ? {} : { retryAfterMs: retry };
  }
}

function normalizedTransportError(error: unknown, phase: string): GatewayTransportError {
  if (error instanceof GatewayTransportError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const details: string[] = [];
  const codes: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && cursor !== null && cursor !== undefined; depth += 1) {
    if (cursor instanceof Error) details.push(cursor.message);
    if (typeof cursor !== "object") break;
    if ("code" in cursor && typeof cursor.code === "string") codes.push(cursor.code);
    cursor = "cause" in cursor ? cursor.cause : null;
  }
  const normalized = `${details.join(" ")} ${codes.join(" ")}`.toLowerCase();
  const statusMatch = /unexpected server response:\s*(\d{3})/u.exec(normalized);
  if (statusMatch !== null) {
    const status = Number(statusMatch[1]);
    return httpStatusError(phase, status, "wss_upgrade");
  }
  const faultClass = /certificate|tls|trust|self.signed|cert_|self_signed|unable_to_verify|depth_zero/u.test(normalized)
    ? "trust"
    : /protocol|validation|invalid envelope|utf[ -]?8|invalid websocket frame/u.test(normalized)
      ? "protocol"
      : "retryable_network";
  return new GatewayTransportError(`${phase}: ${message}`, { faultClass });
}

export function classifyGatewayTransportFailure(error: unknown): GatewayTransportFailureClass {
  return normalizedTransportError(error, "Gateway transport failure").faultClass;
}

function assertPreNegotiationEnvelope(envelope: HelloEnvelope | HelloAckEnvelope): void {
  const envelopeType = envelope.type;
  if (Object.hasOwn(envelope, "v") || Object.hasOwn(envelope, "rsid") || Object.hasOwn(envelope, "seq")) {
    throw new Error(`${envelope.type} must omit v/rsid/seq before negotiation`);
  }
  if (!validateRbpEnvelope(envelope)) {
    throw new Error(`${envelopeType} failed RBP validation: ${JSON.stringify(rbpEnvelopeErrors())}`);
  }
}

function rawDataBytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function parseEnvelope(bytes: Uint8Array): RbpEnvelope {
  if (bytes.byteLength > MAX_RBP_WIRE_FRAME_BYTES) {
    throw new Error(`Gateway frame exceeds ${MAX_RBP_WIRE_FRAME_BYTES} raw bytes`);
  }
  return parseRbpFrame(bytes);
}

async function readBoundedIncomingBytes(
  response: IncomingMessage,
  phase: string,
): Promise<Uint8Array> {
  const advertisedValue = response.headers["content-length"];
  if (advertisedValue !== undefined) {
    const advertised = Number(Array.isArray(advertisedValue) ? advertisedValue[0] : advertisedValue);
    if (!Number.isSafeInteger(advertised) || advertised < 0) {
      response.destroy();
      throw new Error(`${phase} has an invalid Content-Length`);
    }
    if (advertised > MAX_HTTP_ERROR_BODY_BYTES) {
      response.destroy();
      throw new Error(`${phase} exceeds ${MAX_HTTP_ERROR_BODY_BYTES} error bytes`);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > MAX_HTTP_ERROR_BODY_BYTES) {
      response.destroy();
      throw new Error(`${phase} exceeds ${MAX_HTTP_ERROR_BODY_BYTES} error bytes`);
    }
    chunks.push(bytes);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

function helloAck(
  value: RbpEnvelope,
  expectedConnectionId?: string,
  hello?: HelloEnvelope,
): HelloAckEnvelope {
  if (value.type !== "hello_ack") throw new Error("Gateway first response must be hello_ack");
  assertPreNegotiationEnvelope(value);
  if (
    expectedConnectionId !== undefined &&
    value.payload.connection_id !== expectedConnectionId
  ) {
    throw new Error("hello_ack connection id does not match transport binding");
  }
  if (hello !== undefined) {
    if (
      value.payload.protocol < hello.payload.min_protocol ||
      value.payload.protocol > hello.payload.max_protocol
    ) {
      throw new Error("hello_ack selected a protocol outside the Bridge interval");
    }
    if (value.payload.granted_capabilities.some(
      (capability) => !hello.payload.capabilities.includes(capability),
    )) {
      throw new Error("hello_ack granted a capability the Bridge did not offer");
    }
  }
  return value;
}

function authHeaders(options: BindingOptions): Record<string, string> {
  if (options.deviceToken.length < 1 || /[\r\n]/u.test(options.deviceToken)) {
    throw new Error("device token is required and cannot contain line breaks");
  }
  return {
    Authorization: `Bearer ${options.deviceToken}`,
    "X-RBP-Versions": options.versionsHeader ?? "1",
  };
}

export function gatewayCompatibilityWindow(currentProtocol: number): readonly number[] {
  if (!Number.isSafeInteger(currentProtocol) || currentProtocol < 1) {
    throw new RangeError("current protocol must be a positive safe integer");
  }
  return currentProtocol === 1 ? [1] : [currentProtocol, currentProtocol - 1];
}

export function selectHighestCompatibleProtocol(input: {
  readonly bridgeMin: number;
  readonly bridgeMax: number;
  readonly gatewayCurrent: number;
}): number | null {
  if (
    !Number.isSafeInteger(input.bridgeMin) ||
    !Number.isSafeInteger(input.bridgeMax) ||
    input.bridgeMin < 1 ||
    input.bridgeMax < input.bridgeMin
  ) {
    throw new RangeError("invalid bridge protocol interval");
  }
  return (
    gatewayCompatibilityWindow(input.gatewayCurrent).find(
      (version) => version >= input.bridgeMin && version <= input.bridgeMax,
    ) ?? null
  );
}

export class WssGatewayBinding implements GatewayBinding {
  readonly #options: BindingOptions;
  readonly #testTlsTrust: {
    readonly ca: Buffer;
    readonly evidence: LoopbackTestTlsTrustEvidence;
  } | null;
  readonly #queue = new AsyncMessageQueue<RbpEnvelope>();
  #socket: WebSocket | null = null;
  #connectionId: string | null = null;
  #closeInfo: GatewayCloseInfo | null = null;

  public constructor(options: BindingOptions) {
    this.#options = options;
    const endpointPolicy = options.endpointPolicy ?? "production";
    const url = assertGatewayUrl(
      options.baseUrl,
      "wss:",
      "ws:",
      endpointPolicy,
    );
    if (url.pathname !== "/bridge/v1" && url.pathname !== "/bridge/v1/") {
      throw new Error("WSS binding path must be /bridge/v1");
    }
    if (endpointPolicy === "loopback_test_tls") {
      if (options.testTlsTrust === undefined) {
        throw new Error("loopback_test_tls requires explicit testTlsTrust");
      }
      if (options.webSocketFactory !== undefined) {
        throw new Error("loopback_test_tls cannot be combined with a WebSocket factory");
      }
      this.#testTlsTrust = loadLoopbackTestTlsTrust(options.testTlsTrust);
    } else {
      if (options.testTlsTrust !== undefined) {
        throw new Error("testTlsTrust is accepted only by loopback_test_tls WSS");
      }
      this.#testTlsTrust = null;
    }
    positiveTimeout(options.openTimeoutMs, DEFAULT_OPEN_TIMEOUT_MS, "WSS open timeout");
    positiveTimeout(options.sendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS, "WSS send timeout");
  }

  public get kind(): "wss" {
    return "wss";
  }

  public get connectionId(): string | null {
    return this.#connectionId;
  }

  public get bufferedAmount(): number {
    return this.#socket?.bufferedAmount ?? 0;
  }

  public get closeInfo(): GatewayCloseInfo | null {
    return this.#closeInfo === null ? null : { ...this.#closeInfo };
  }

  public get testTlsTrustEvidence(): LoopbackTestTlsTrustEvidence | null {
    return this.#testTlsTrust === null ? null : { ...this.#testTlsTrust.evidence };
  }

  public async open(hello: HelloEnvelope): Promise<HelloAckEnvelope> {
    if (this.#socket !== null) throw new Error("WSS binding already opened");
    assertPreNegotiationEnvelope(hello);
    const openTimeoutMs = positiveTimeout(
      this.#options.openTimeoutMs,
      DEFAULT_OPEN_TIMEOUT_MS,
      "WSS open timeout",
    );
    const testTlsTrust = this.#testTlsTrust;
    const verifyPinnedTestServer = (host: string, certificate: PeerCertificate): Error | undefined => {
      const identityError = checkServerIdentity(host, certificate);
      if (identityError !== undefined) return identityError;
      const actual = sha256(certificate.raw);
      if (actual === testTlsTrust?.evidence.serverCertificateSha256) return undefined;
      const error = new Error(
        "Gateway test TLS server certificate does not match the pinned current-stack digest",
      ) as Error & { code?: string };
      error.code = "ERR_REVAGENT_TEST_CERTIFICATE_MISMATCH";
      return error;
    };
    const socketOptions: WebSocket.ClientOptions = {
      headers: authHeaders(this.#options),
      maxPayload: MAX_RBP_WIRE_FRAME_BYTES,
      ...(testTlsTrust === null
        ? {}
        : {
            ca: testTlsTrust.ca,
            rejectUnauthorized: true,
            // @types/ws currently overrides Node's TLS callback with a server-
            // side CertMeta/boolean signature. At runtime ws forwards this
            // option directly to tls.connect, whose contract is
            // PeerCertificate -> Error | undefined.
            checkServerIdentity: verifyPinnedTestServer as unknown as NonNullable<
              WebSocket.ClientOptions["checkServerIdentity"]
            >,
          }),
    };
    const socket = (this.#options.webSocketFactory ?? ((url, options) => new WebSocket(url, options)))(
      this.#options.baseUrl,
      socketOptions,
    );
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: GatewayTransportError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("unexpected-response", onUnexpectedResponse);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onOpen = (): void => {
        finish();
      };
      const onError = (error: Error): void => {
        finish(normalizedTransportError(error, "WSS open failed"));
      };
      const onClose = (code: number, reason: Buffer): void => {
        this.#closeInfo = { code, reason: reason.toString("utf8") };
        finish(closeError("open", code, reason));
      };
      const onUnexpectedResponse = (_request: unknown, response: IncomingMessage): void => {
        void (async () => {
          const status = response.statusCode ?? 500;
          let metadata: HttpFailureMetadata = {};
          try {
            const bytes = await readBoundedIncomingBytes(response, "WSS upgrade rejection");
            metadata = httpFailureMetadata(status, {
              get: (name) => {
                const value = response.headers[name.toLowerCase()];
                return Array.isArray(value) ? value[0] ?? null : value ?? null;
              },
            }, bytes);
          } catch {
            // The bounded metadata is optional. The authenticated HTTP status
            // remains authoritative when the peer sends an invalid/oversize body.
          }
          finish(httpStatusError("WSS upgrade", status, "wss_upgrade", metadata));
          socket.once("error", () => undefined);
          socket.terminate();
        })();
      };
      const timeout = setTimeout(() => {
        finish(new GatewayTransportError(
          `WSS open timed out after ${openTimeoutMs}ms`,
          { faultClass: "retryable_network" },
        ));
        socket.once("error", () => undefined);
        socket.terminate();
      }, openTimeoutMs);
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpectedResponse);
    });
    return new Promise<HelloAckEnvelope>((resolve, reject) => {
      let ackSettled = false;
      const timeout = setTimeout(() => {
        failBeforeAck(new GatewayTransportError(
          `WSS hello_ack timed out after ${openTimeoutMs}ms`,
          { faultClass: "retryable_network" },
        ));
        socket.terminate();
      }, openTimeoutMs);
      const settleAck = (ack: HelloAckEnvelope): void => {
        if (ackSettled) return;
        ackSettled = true;
        clearTimeout(timeout);
        this.#connectionId = ack.payload.connection_id;
        resolve(ack);
      };
      const failBeforeAck = (error: GatewayTransportError): void => {
        if (!ackSettled) {
          ackSettled = true;
          clearTimeout(timeout);
          reject(error);
        }
        this.#queue.close(error);
      };
      const onMessage = (data: WebSocket.RawData, binary: boolean): void => {
        try {
          if (binary) throw new Error("RBP WSS requires text frames");
          const envelope = parseEnvelope(rawDataBytes(data));
          if (!ackSettled) settleAck(helloAck(envelope, undefined, hello));
          else this.#queue.push(envelope);
        } catch (error) {
          const failure = new GatewayTransportError(
            `WSS protocol frame rejected: ${error instanceof Error ? error.message : String(error)}`,
            { faultClass: "protocol" },
          );
          failBeforeAck(failure);
          socket.close(4400, "protocol error");
        }
      };
      const onClose = (code: number, reason: Buffer): void => {
        this.#closeInfo = { code, reason: reason.toString("utf8") };
        const error = closeError(ackSettled ? "steady transport" : "before hello_ack", code, reason);
        if (!ackSettled) failBeforeAck(error);
        else if (code === 1000) this.#queue.close();
        else this.#queue.close(error);
      };
      const onError = (error: Error): void => {
        const failure = normalizedTransportError(error, "WSS transport failed");
        if (!ackSettled) failBeforeAck(failure);
        else this.#queue.close(failure);
      };
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
      socket.send(JSON.stringify(hello), (error) => {
        if (error === undefined || error === null) return;
        failBeforeAck(normalizedTransportError(error, "WSS hello send failed"));
        socket.terminate();
      });
    });
  }

  public async send(envelope: RbpEnvelope): Promise<void> {
    if (this.#socket?.readyState !== WebSocket.OPEN || this.#connectionId === null) {
      throw new Error("WSS binding is not steady");
    }
    if (!validateRbpEnvelope(envelope)) throw new Error("invalid outbound RBP envelope");
    const socket = this.#socket;
    const sendTimeoutMs = positiveTimeout(
      this.#options.sendTimeoutMs,
      DEFAULT_SEND_TIMEOUT_MS,
      "WSS send timeout",
    );
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error === undefined) resolve();
        else reject(error);
      };
      const timeout = setTimeout(() => {
        finish(new GatewayTransportError(
          `WSS send timed out after ${sendTimeoutMs}ms`,
          { faultClass: "retryable_network" },
        ));
        socket.terminate();
      }, sendTimeoutMs);
      socket.send(JSON.stringify(envelope), (error) => {
        if (error === undefined || error === null) finish();
        else finish(normalizedTransportError(error, "WSS send failed"));
      });
    });
  }

  public async sendChunkConformanceFrame(
    frame: unknown,
  ): Promise<GatewayChunkConformanceFaultEvidence> {
    return await this.sendChunkConformanceFrames([frame]);
  }

  public async sendChunkConformanceFrames(
    frames: readonly unknown[],
  ): Promise<GatewayChunkConformanceFaultEvidence> {
    if (this.#socket?.readyState !== WebSocket.OPEN || this.#connectionId === null) {
      throw new Error("WSS binding is not steady");
    }
    if (frames.length === 0) throw new Error("WSS conformance frame sequence is empty");
    const socket = this.#socket;
    const bodies = frames.map((frame) => JSON.stringify(frame));
    if (bodies.some((body) => Buffer.byteLength(body, "utf8") > MAX_RBP_WIRE_FRAME_BYTES)) {
      throw new Error(`WSS conformance frame sequence exceeds ${MAX_RBP_WIRE_FRAME_BYTES} raw bytes`);
    }
    const sendTimeoutMs = positiveTimeout(
      this.#options.sendTimeoutMs,
      DEFAULT_SEND_TIMEOUT_MS,
      "WSS send timeout",
    );
    return await new Promise<GatewayChunkConformanceFaultEvidence>((resolve, reject) => {
      let settled = false;
      let remoteFault: GatewayTransportError | null = null;
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off("message", onMessage);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onMessage = (data: WebSocket.RawData, binary: boolean): void => {
        try {
          if (binary) return;
          const envelope = parseEnvelope(rawDataBytes(data));
          if (envelope.type !== "error" || envelope.payload.fault_class !== "protocol") return;
          remoteFault = new GatewayTransportError(envelope.payload.message, {
            faultClass: "protocol",
          });
        } catch {
          // The normal binding listener owns general transport parsing. This
          // narrow observer retains only an authenticated protocol fault.
        }
      };
      const onClose = (code: number, reason: Buffer): void => {
        if (settled) return;
        if (remoteFault === null) {
          fail(new Error("chunk conformance close lacked an authenticated Gateway error envelope"));
          return;
        }
        const fault = remoteFault;
        if (fault.faultClass !== "protocol" || classForCloseCode(code) !== "protocol") {
          fail(new Error(`chunk conformance frame closed with ${fault.faultClass}`));
          return;
        }
        settled = true;
        cleanup();
        resolve({
          binding: "wss",
          accepted: false,
          source: "gateway_error_envelope_and_close",
          faultClass: fault.faultClass,
          httpStatus: null,
          closeCode: code,
          closeReason: reason.toString("utf8").slice(0, 600),
          message: fault.message.slice(0, 600),
        });
      };
      const onError = (error: Error): void => fail(normalizedTransportError(error, "WSS conformance send failed"));
      const timeout = setTimeout(() => {
        fail(new GatewayTransportError(
          `WSS conformance fault timed out after ${sendTimeoutMs}ms`,
          { faultClass: "retryable_network" },
        ));
        socket.terminate();
      }, sendTimeoutMs);
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
      let nextBody = 0;
      const sendNext = (): void => {
        if (
          settled ||
          remoteFault !== null ||
          socket.readyState !== WebSocket.OPEN ||
          nextBody >= bodies.length
        ) return;
        const body = bodies[nextBody++]!;
        try {
          socket.send(body, (error) => {
            if (error !== undefined && error !== null) {
              fail(normalizedTransportError(error, "WSS conformance send failed"));
              return;
            }
            sendNext();
          });
        } catch (error) {
          fail(normalizedTransportError(error, "WSS conformance send failed"));
        }
      };
      sendNext();
    });
  }

  public messages(): AsyncIterable<RbpEnvelope> {
    return this.#queue;
  }

  public async close(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#connectionId = null;
    if (socket === null || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off("close", finish);
        socket.off("error", finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        socket.terminate();
        finish();
      }, 1_000);
      socket.once("close", finish);
      socket.once("error", finish);
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.close(1000, "bridge simulator close");
    });
  }
}

function oneLineSseData(line: string): RbpEnvelope {
  if (line.includes("\r") || line.includes("\n")) throw new Error("SSE RBP data must be one line");
  return parseEnvelope(Buffer.from(line, "utf8"));
}

function sseStreamError(error: unknown): GatewayTransportError {
  if (error instanceof GatewayTransportError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const protocolFailure = /(?:SSE|RBP|JSON|UTF-8|duplicate|envelope|frame|incomplete event)/iu.test(message);
  return new GatewayTransportError(`HTTP/SSE events failed: ${message}`, {
    faultClass: protocolFailure ? "protocol" : "retryable_network",
  });
}

async function timedFetch(
  fetcher: typeof globalThis.fetch,
  input: URL,
  init: RequestInit,
  timeoutMs: number,
  phase: string,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init.signal;
  const relayAbort = (): void => controller.abort(upstream?.reason);
  if (upstream?.aborted === true) relayAbort();
  else upstream?.addEventListener("abort", relayAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${phase} timeout`));
  }, timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new GatewayTransportError(
        `${phase} timed out after ${timeoutMs}ms`,
        { faultClass: "retryable_network" },
      );
    }
    throw normalizedTransportError(error, `${phase} failed`);
  } finally {
    clearTimeout(timeout);
    upstream?.removeEventListener("abort", relayAbort);
  }
}

type ReaderOutcome =
  | { readonly kind: "read"; readonly value: ReadableStreamReadResult<Uint8Array> }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReaderOutcome> {
  return await new Promise<ReaderOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ReaderOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(outcome);
    };
    const timeout = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    void reader.read().then(
      (value) => finish({ kind: "read", value }),
      (error: unknown) => finish({ kind: "error", error }),
    );
  });
}

async function readBoundedResponseBytes(
  response: Response,
  phase: string,
  timeoutMs: number,
  maxBytes = MAX_RBP_WIRE_FRAME_BYTES,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const advertised = Number(contentLength);
    if (!Number.isSafeInteger(advertised) || advertised < 0) {
      void response.body?.cancel("invalid Content-Length");
      throw new Error(`${phase} has an invalid Content-Length`);
    }
    if (advertised > maxBytes) {
      void response.body?.cancel("response exceeds raw byte cap");
      throw new Error(`${phase} exceeds ${maxBytes} raw bytes`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let readPending = false;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        readPending = true;
        void reader.cancel(`${phase} body timeout`).catch(() => undefined);
        throw new GatewayTransportError(
          `${phase} body timed out after ${timeoutMs}ms`,
          { faultClass: "retryable_network" },
        );
      }
      const outcome = await readWithDeadline(reader, remainingMs);
      if (outcome.kind === "timeout") {
        readPending = true;
        void reader.cancel(`${phase} body timeout`).catch(() => undefined);
        throw new GatewayTransportError(
          `${phase} body timed out after ${timeoutMs}ms`,
          { faultClass: "retryable_network" },
        );
      }
      if (outcome.kind === "error") throw outcome.error;
      const next = outcome.value;
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel("response exceeds raw byte cap").catch(() => undefined);
        throw new Error(`${phase} exceeds ${maxBytes} raw bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    if (!readPending) reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
}

async function httpResponseError(
  response: Response,
  phase: string,
  statusPhase: HttpStatusPhase,
  timeoutMs: number,
): Promise<GatewayTransportError> {
  let bytes = new Uint8Array();
  try {
    bytes = new Uint8Array(
      await readBoundedResponseBytes(response, phase, timeoutMs, MAX_HTTP_ERROR_BODY_BYTES),
    );
  } catch {
    // Preserve status classification even when optional diagnostics are malformed.
  }
  return httpStatusError(
    phase,
    response.status,
    statusPhase,
    httpFailureMetadata(response.status, response.headers, bytes),
  );
}

function httpSessionOrderKey(envelope: RbpEnvelope): string | null {
  if ("rsid" in envelope && typeof envelope.rsid === "string") return envelope.rsid;
  if (envelope.type === "session_resume" || envelope.type === "session_unregister") {
    return envelope.payload.rsid;
  }
  return null;
}

function usesHttpLifecycleFence(envelope: RbpEnvelope): boolean {
  return envelope.type === "session_register" ||
    envelope.type === "session_resume" ||
    envelope.type === "session_unregister" ||
    envelope.type === "heartbeat";
}

export class HttpSseGatewayBinding implements GatewayBinding {
  readonly #options: BindingOptions;
  readonly #base: URL;
  readonly #createUrl: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #queue = new AsyncMessageQueue<RbpEnvelope>();
  readonly #sessionSendChains = new Map<string, Promise<void>>();
  #lifecycleSendChain: Promise<void> | null = null;
  #connectionId: string | null = null;
  #abort: AbortController | null = null;
  #unacceptedBytes = 0;

  public constructor(options: BindingOptions) {
    this.#options = options;
    const endpointPolicy = options.endpointPolicy ?? "production";
    if (endpointPolicy === "loopback_test_tls" || options.testTlsTrust !== undefined) {
      throw new Error("test TLS trust is restricted to the numeric-loopback WSS binding");
    }
    const endpoint = assertGatewayUrl(options.baseUrl, "https:", "http:", endpointPolicy);
    if (endpointPolicy === "production") {
      if (endpoint.pathname !== "/" && endpoint.pathname !== "") {
        throw new Error("Production HTTP/SSE binding base URL must not contain a path");
      }
      this.#base = endpoint;
      this.#createUrl = new URL("/bridge/v1/http/connections", endpoint);
    } else {
      if (endpoint.pathname !== "/bridge/v1/http/connections") {
        throw new Error("Loopback HTTP readiness URL must end at /bridge/v1/http/connections");
      }
      this.#base = new URL("/", endpoint);
      this.#createUrl = endpoint;
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    positiveTimeout(options.fetchTimeoutMs, DEFAULT_FETCH_TIMEOUT_MS, "HTTP/SSE fetch timeout");
  }

  public get kind(): "streamable_http_sse" {
    return "streamable_http_sse";
  }

  public get connectionId(): string | null {
    return this.#connectionId;
  }

  public get bufferedAmount(): number {
    return this.#unacceptedBytes;
  }

  public async open(hello: HelloEnvelope): Promise<HelloAckEnvelope> {
    if (this.#connectionId !== null) throw new Error("HTTP/SSE binding already opened");
    assertPreNegotiationEnvelope(hello);
    const headers = authHeaders(this.#options);
    const fetchTimeoutMs = positiveTimeout(
      this.#options.fetchTimeoutMs,
      DEFAULT_FETCH_TIMEOUT_MS,
      "HTTP/SSE fetch timeout",
    );
    const response = await timedFetch(this.#fetch, this.#createUrl, {
      method: "POST",
      headers: { ...headers, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(hello),
      redirect: "error",
    }, fetchTimeoutMs, "HTTP/SSE create");
    if (response.status !== 201) {
      throw await httpResponseError(response, "HTTP/SSE create", "connection_create", fetchTimeoutMs);
    }
    const connectionId = response.headers.get("RBP-Connection-Id");
    if (connectionId === null || connectionId.length === 0 || /[\r\n/]/u.test(connectionId)) {
      throw new Error("fallback create omitted a valid RBP-Connection-Id");
    }
    const ack = helloAck(
      parseEnvelope(await readBoundedResponseBytes(response, "HTTP/SSE hello_ack", fetchTimeoutMs)),
      connectionId,
      hello,
    );

    const abort = new AbortController();
    const eventsUrl = new URL(
      `/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/events`,
      this.#base,
    );
    const events = await timedFetch(this.#fetch, eventsUrl, {
      method: "GET",
      headers: { ...headers, Accept: "text/event-stream" },
      redirect: "error",
      signal: abort.signal,
    }, fetchTimeoutMs, "HTTP/SSE events open");
    if (events.status !== 200 || !events.body) {
      const failure = await httpResponseError(events, "HTTP/SSE events open", "events_open", fetchTimeoutMs);
      abort.abort();
      throw failure;
    }
    const contentType = events.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "text/event-stream") {
      abort.abort();
      await events.body.cancel("events content type rejected");
      throw new Error("fallback events response is not text/event-stream");
    }
    this.#connectionId = connectionId;
    this.#abort = abort;
    void this.#consumeEvents(events.body, abort.signal);
    return ack;
  }

  public async send(envelope: RbpEnvelope): Promise<void> {
    const connectionId = this.#connectionId;
    if (connectionId === null) throw new Error("HTTP/SSE binding is not steady");
    if (!validateRbpEnvelope(envelope)) throw new Error("invalid outbound RBP envelope");
    const body = JSON.stringify(envelope);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    this.#unacceptedBytes += bodyBytes;
    const orderKey = httpSessionOrderKey(envelope);
    const lifecycleFenced = usesHttpLifecycleFence(envelope);
    if (orderKey === null && !lifecycleFenced) {
      try {
        await this.#sendImmediately(connectionId, body);
      } finally {
        this.#unacceptedBytes -= bodyBytes;
      }
      return;
    }
    const sessionPrevious = orderKey === null
      ? Promise.resolve()
      : this.#sessionSendChains.get(orderKey) ?? Promise.resolve();
    const lifecyclePrevious = lifecycleFenced
      ? this.#lifecycleSendChain ?? Promise.resolve()
      : Promise.resolve();
    const pending = Promise.all([sessionPrevious, lifecyclePrevious])
      .then(async () => await this.#sendImmediately(connectionId, body));
    if (orderKey !== null) this.#sessionSendChains.set(orderKey, pending);
    if (lifecycleFenced) this.#lifecycleSendChain = pending;
    try {
      await pending;
    } finally {
      if (orderKey !== null && this.#sessionSendChains.get(orderKey) === pending) {
        this.#sessionSendChains.delete(orderKey);
      }
      if (lifecycleFenced && this.#lifecycleSendChain === pending) this.#lifecycleSendChain = null;
      this.#unacceptedBytes -= bodyBytes;
    }
  }

  public async sendChunkConformanceFrame(
    frame: unknown,
  ): Promise<GatewayChunkConformanceFaultEvidence> {
    return await this.sendChunkConformanceFrames([frame]);
  }

  public async sendChunkConformanceFrames(
    frames: readonly unknown[],
  ): Promise<GatewayChunkConformanceFaultEvidence> {
    if (frames.length === 0) throw new Error("HTTP/SSE conformance frame sequence is empty");
    for (const frame of frames) {
      const fault = await this.#sendChunkConformanceFrameOnce(frame);
      if (fault !== null) return fault;
    }
    throw new Error("HTTP/SSE Gateway unexpectedly accepted every invalid chunk conformance frame");
  }

  async #sendChunkConformanceFrameOnce(
    frame: unknown,
  ): Promise<GatewayChunkConformanceFaultEvidence | null> {
    const connectionId = this.#connectionId;
    if (connectionId === null) throw new Error("HTTP/SSE binding is not steady");
    const body = JSON.stringify(frame);
    if (Buffer.byteLength(body, "utf8") > MAX_RBP_WIRE_FRAME_BYTES) {
      throw new Error(`HTTP/SSE conformance frame exceeds ${MAX_RBP_WIRE_FRAME_BYTES} raw bytes`);
    }
    const fetchTimeoutMs = positiveTimeout(
      this.#options.fetchTimeoutMs,
      DEFAULT_FETCH_TIMEOUT_MS,
      "HTTP/SSE fetch timeout",
    );
    const response = await timedFetch(
      this.#fetch,
      new URL(`/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/messages`, this.#base),
      {
        method: "POST",
        headers: {
          ...authHeaders(this.#options),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body,
        redirect: "error",
      },
      fetchTimeoutMs,
      "HTTP/SSE conformance message send",
    );
    if (response.status === 202) {
      return null;
    }
    const faultClass = classForHttpStatus(response.status, "message_send");
    if (faultClass !== "protocol") {
      throw await httpResponseError(
        response,
        "HTTP/SSE conformance message send",
        "message_send",
        fetchTimeoutMs,
      );
    }
    const bytes = await readBoundedResponseBytes(
      response,
      "HTTP/SSE conformance fault",
      fetchTimeoutMs,
      MAX_HTTP_ERROR_BODY_BYTES,
    );
    let message = `HTTP/SSE conformance message send received HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      if (isJsonRecord(parsed) && typeof parsed.error === "string") {
        message = parsed.error;
      }
    } catch {
      // The authenticated status remains the factual protocol-fault evidence.
    }
    return {
      binding: "streamable_http_sse",
      accepted: false,
      source: "authenticated_http_response",
      faultClass,
      httpStatus: response.status,
      closeCode: null,
      closeReason: null,
      message: message.slice(0, 600),
    };
  }

  async #sendImmediately(connectionId: string, body: string): Promise<void> {
    if (this.#connectionId !== connectionId) {
      throw new Error("HTTP/SSE binding changed before queued message send");
    }
    const response = await timedFetch(
      this.#fetch,
      new URL(`/bridge/v1/http/connections/${encodeURIComponent(connectionId)}/messages`, this.#base),
      {
        method: "POST",
        headers: {
          ...authHeaders(this.#options),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body,
        redirect: "error",
      },
      positiveTimeout(
        this.#options.fetchTimeoutMs,
        DEFAULT_FETCH_TIMEOUT_MS,
        "HTTP/SSE fetch timeout",
      ),
      "HTTP/SSE message send",
    );
    if (response.status !== 202) {
      const failure = await httpResponseError(
        response,
        "HTTP/SSE message send",
        "message_send",
        positiveTimeout(
          this.#options.fetchTimeoutMs,
          DEFAULT_FETCH_TIMEOUT_MS,
          "HTTP/SSE fetch timeout",
        ),
      );
      if (response.status === 404 || response.status === 410) {
        this.#abort?.abort();
        this.#abort = null;
        this.#connectionId = null;
      }
      throw failure;
    }
  }

  public messages(): AsyncIterable<RbpEnvelope> {
    return this.#queue;
  }

  public async close(): Promise<void> {
    this.#abort?.abort();
    this.#abort = null;
    this.#connectionId = null;
    this.#queue.close();
  }

  async #consumeEvents(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = stream.getReader();
    const cancelReader = (): void => {
      void reader.cancel("HTTP/SSE binding closed");
    };
    signal.addEventListener("abort", cancelReader, { once: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let pendingBytes = 0;
    let eventName = "";
    let data: string[] = [];
    let eventDataBytes = 0;
    const dispatch = (): void => {
      if (eventName === "" && data.length === 0) return;
      if (eventName !== "rbp" || data.length !== 1) {
        throw new Error("fallback SSE event must be exactly event: rbp plus one data line");
      }
      this.#queue.push(oneLineSseData(data[0] as string));
      eventName = "";
      data = [];
      eventDataBytes = 0;
    };
    const processPendingLines = (): void => {
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const consumed = pending.slice(0, newline + 1);
        let line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        pendingBytes -= Buffer.byteLength(consumed, "utf8");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (Buffer.byteLength(line, "utf8") > MAX_RBP_WIRE_FRAME_BYTES) {
          throw new Error(`fallback SSE line exceeds ${MAX_RBP_WIRE_FRAME_BYTES} raw bytes`);
        }
        if (line === "") {
          dispatch();
        } else if (line.startsWith(":")) {
          continue;
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trimStart();
        } else if (line.startsWith("data:")) {
          const value = line.slice(5).trimStart();
          eventDataBytes += Buffer.byteLength(value, "utf8");
          if (eventDataBytes > MAX_RBP_WIRE_FRAME_BYTES) {
            throw new Error(`fallback SSE data exceeds ${MAX_RBP_WIRE_FRAME_BYTES} raw bytes`);
          }
          data.push(value);
        }
      }
      if (pendingBytes > MAX_RBP_WIRE_FRAME_BYTES) {
        throw new Error(`fallback SSE line exceeds ${MAX_RBP_WIRE_FRAME_BYTES} raw bytes`);
      }
    };
    try {
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done) break;
        const decoded = decoder.decode(next.value, { stream: true });
        pending += decoded;
        pendingBytes += Buffer.byteLength(decoded, "utf8");
        processPendingLines();
      }
      if (!signal.aborted) {
        const decoded = decoder.decode();
        pending += decoded;
        pendingBytes += Buffer.byteLength(decoded, "utf8");
        processPendingLines();
        if (pending.length > 0 || eventName.length > 0 || data.length > 0) {
          throw new Error("fallback SSE stream ended with an incomplete event");
        }
      }
      if (!signal.aborted) {
        this.#queue.close(new GatewayTransportError("fallback SSE stream ended", {
          faultClass: "retryable_network",
        }));
      }
    } catch (error) {
      if (!signal.aborted) this.#queue.close(sseStreamError(error));
    } finally {
      signal.removeEventListener("abort", cancelReader);
      reader.releaseLock();
    }
  }
}

export async function openPrimaryThenFallback(input: {
  readonly hello: HelloEnvelope;
  readonly wss: GatewayBinding;
  readonly fallback?: GatewayBinding;
  readonly fallbackProvisioned: boolean;
  readonly classifyWssFailure: (error: unknown) => GatewayTransportFailureClass;
}): Promise<{ readonly binding: GatewayBinding; readonly helloAck: HelloAckEnvelope }> {
  try {
    return { binding: input.wss, helloAck: await input.wss.open(input.hello) };
  } catch (error) {
    try {
      await input.wss.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "failed WSS primary could not be closed before transport selection",
      );
    }
    const failure = error instanceof GatewayTransportError
      ? error.faultClass
      : input.classifyWssFailure(error);
    if (
      !input.fallbackProvisioned ||
      input.fallback === undefined ||
      failure !== "retryable_network" ||
      !input.hello.payload.capabilities.includes("transport_streamable_http")
    ) {
      throw error;
    }
    const helloAck = await input.fallback.open(input.hello);
    if (!helloAck.payload.granted_capabilities.includes("transport_streamable_http")) {
      await input.fallback.close();
      throw new GatewayTransportError(
        "HTTP/SSE fallback hello_ack omitted transport_streamable_http grant",
        { faultClass: "protocol" },
      );
    }
    return { binding: input.fallback, helloAck };
  }
}
