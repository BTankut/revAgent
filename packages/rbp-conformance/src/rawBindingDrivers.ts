import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isAbsolute, parse, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

import WebSocket from "ws";

import type {
  ParentStepDriver,
  ParentStepDriverRequest,
  RawBindingStepHooks,
  RawStepOutcome,
} from "./parentStepEngine.js";
import type { JsonObject, JsonValue } from "./processHarness.js";
import type { Binding, ProcessObservationRecord } from "./types.js";

const MAX_TEST_CA_BYTES = 64 * 1024;
const MAX_DRIVER_DEADLINE_MS = 5 * 60 * 1_000;
const MAX_OUTBOUND_FRAME_BYTES = 40 * 1024 * 1024;
const MAX_REMOTE_ENTITY_BYTES = 1024 * 1024;
const MAX_CAPTURED_FRAMES = 32;
const MAX_PARSED_CAPTURE_BYTES = 32 * 1024;
const MAX_SETTLE_MS = 2_000;
const MAX_TOKEN_BYTES = 8 * 1024;
const OBSERVATION_PAYLOAD_LIMIT = 60 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERSIONS_HEADER = /^\d+(?:\s*,\s*\d+)*$/u;

export interface RawBindingTlsTrust {
  /** Absolute path to public CA/certificate PEM bytes owned by the current test stack. */
  readonly caCertificatePath: string;
  /** SHA-256 of the exact bytes at `caCertificatePath`. */
  readonly caCertificateSha256: string;
  /** SHA-256 of the DER leaf certificate presented by the current Gateway process. */
  readonly serverCertificateSha256: string;
}

export interface RawBindingDriverLimits {
  readonly maxOutboundFrameBytes?: number;
  readonly maxRemoteEntityBytes?: number;
  readonly maxCapturedFrames?: number;
  readonly maxParsedCaptureBytes?: number;
  readonly settleMs?: number;
}

interface CommonRawBindingDriverOptions {
  readonly deviceToken: string;
  readonly versionsHeader?: string;
  /**
   * Used to establish a fresh connection before a non-hello target frame.
   * A target hello frame is itself the opening frame.
   */
  readonly openingHello?: JsonValue | ((request: Readonly<ParentStepDriverRequest>) => JsonValue);
  readonly limits?: RawBindingDriverLimits;
  readonly now?: () => string;
}

export interface RawWssBindingDriverOptions extends CommonRawBindingDriverOptions {
  readonly url: string;
  readonly tlsTrust: RawBindingTlsTrust;
}

export interface RawHttpSseBindingDriverOptions extends CommonRawBindingDriverOptions {
  readonly connectionUrl: string;
  /**
   * Required for HTTPS. Cleartext HTTP is accepted only on numeric loopback
   * and must omit this field.
   */
  readonly tlsTrust?: RawBindingTlsTrust;
}

export interface RawBindingStepHookOptions {
  readonly wss?: RawWssBindingDriverOptions;
  readonly streamableHttpSse?: RawHttpSseBindingDriverOptions;
}

interface ResolvedLimits {
  readonly maxOutboundFrameBytes: number;
  readonly maxRemoteEntityBytes: number;
  readonly maxCapturedFrames: number;
  readonly maxParsedCaptureBytes: number;
  readonly settleMs: number;
}

interface LoadedTlsTrust {
  readonly ca: Buffer;
  readonly evidence: {
    readonly caCertificatePath: string;
    readonly caCertificateSha256: string;
    readonly serverCertificateSha256: string;
  };
}

interface SerializedFrame {
  readonly text: string;
  readonly bytes: Buffer;
  readonly metadata: JsonObject;
  readonly type: string | null;
}

interface CapturedEntity {
  readonly bytes: number;
  readonly sha256: string;
  readonly parsed: JsonValue | null;
  readonly parseState: "parsed" | "empty" | "invalid_json" | "parse_budget_exhausted";
}

class ParseBudget {
  #remaining: number;

  constructor(bytes: number) {
    this.#remaining = bytes;
  }

  capture(bytes: Buffer): CapturedEntity {
    const metadata = {
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
    if (bytes.byteLength === 0) {
      return { ...metadata, parsed: null, parseState: "empty" };
    }
    if (bytes.byteLength > this.#remaining) {
      return { ...metadata, parsed: null, parseState: "parse_budget_exhausted" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      assertJsonValue(parsed, "remote JSON");
    } catch {
      return { ...metadata, parsed: null, parseState: "invalid_json" };
    }
    this.#remaining -= bytes.byteLength;
    return { ...metadata, parsed, parseState: "parsed" };
  }
}

class ExchangeScope {
  readonly #controller = new AbortController();
  readonly #parentSignal: AbortSignal;
  readonly #parentAbort: () => void;
  readonly #deadline: NodeJS.Timeout;
  #disposed = false;

  constructor(request: Readonly<ParentStepDriverRequest>) {
    const remainingMs = request.deadlineAtMs - Date.now();
    if (!Number.isFinite(request.deadlineAtMs) || remainingMs <= 0 || remainingMs > MAX_DRIVER_DEADLINE_MS) {
      throw new Error("raw binding request has an expired or out-of-range parent deadline");
    }
    this.#parentSignal = request.signal;
    this.#parentAbort = () => {
      this.#controller.abort(
        request.signal.reason ?? new Error(`${request.stepId} raw binding request was aborted`),
      );
    };
    if (request.signal.aborted) this.#parentAbort();
    else request.signal.addEventListener("abort", this.#parentAbort, { once: true });
    this.#deadline = setTimeout(() => {
      this.#controller.abort(new Error(`${request.stepId} raw binding request exceeded its parent deadline`));
    }, remainingMs);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  reason(): Error {
    const reason = this.signal.reason;
    return reason instanceof Error ? reason : new Error(String(reason ?? "raw binding request aborted"));
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw this.reason();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#deadline);
    this.#parentSignal.removeEventListener("abort", this.#parentAbort);
  }
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return selected;
}

function resolvedLimits(input: RawBindingDriverLimits | undefined): ResolvedLimits {
  return {
    maxOutboundFrameBytes: boundedInteger(
      input?.maxOutboundFrameBytes,
      MAX_OUTBOUND_FRAME_BYTES,
      1,
      MAX_OUTBOUND_FRAME_BYTES,
      "maxOutboundFrameBytes",
    ),
    maxRemoteEntityBytes: boundedInteger(
      input?.maxRemoteEntityBytes,
      64 * 1024,
      1,
      MAX_REMOTE_ENTITY_BYTES,
      "maxRemoteEntityBytes",
    ),
    maxCapturedFrames: boundedInteger(
      input?.maxCapturedFrames,
      16,
      1,
      MAX_CAPTURED_FRAMES,
      "maxCapturedFrames",
    ),
    maxParsedCaptureBytes: boundedInteger(
      input?.maxParsedCaptureBytes,
      16 * 1024,
      0,
      MAX_PARSED_CAPTURE_BYTES,
      "maxParsedCaptureBytes",
    ),
    settleMs: boundedInteger(input?.settleMs, 75, 1, MAX_SETTLE_MS, "settleMs"),
  };
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}/${index}`));
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} is not JSON`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} is not a plain JSON object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonValue(entry, `${label}/${key}`);
  }
}

function boundedToken(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw new Error(`${label} must be a non-empty bounded credential without control delimiters`);
  }
  return value;
}

function versionsHeader(value: string | undefined): string {
  const selected = value ?? "1";
  if (selected.length < 1 || selected.length > 128 || !VERSIONS_HEADER.test(selected)) {
    throw new Error("versionsHeader must be a bounded comma-separated list of protocol integers");
  }
  return selected;
}

function numericLoopbackUrl(
  value: string,
  protocols: readonly string[],
  exactPath: string,
  label: string,
): URL {
  const url = new URL(value);
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${label} must use ${protocols.join(" or ")}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must omit userinfo, query, and fragment`);
  }
  if (url.port.length === 0 || !isNumericLoopback(url.hostname)) {
    throw new Error(`${label} must use numeric loopback and an explicit port`);
  }
  if (url.pathname !== exactPath) throw new Error(`${label} path must be ${exactPath}`);
  return url;
}

function isNumericLoopback(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(normalized);
  if (family === 4) return normalized.split(".")[0] === "127";
  if (family !== 6) return false;
  const lower = normalized.toLowerCase();
  return lower === "::1" || lower === "0:0:0:0:0:0:0:1";
}

function assertedDigest(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase sha256 digest`);
  return value;
}

function loadTlsTrust(input: RawBindingTlsTrust): LoadedTlsTrust {
  if (
    typeof input.caCertificatePath !== "string" ||
    input.caCertificatePath.length < 1 ||
    input.caCertificatePath.length > 4_096 ||
    input.caCertificatePath.trim() !== input.caCertificatePath ||
    /[\u0000-\u001f\u007f]/u.test(input.caCertificatePath) ||
    !isAbsolute(input.caCertificatePath)
  ) {
    throw new Error("raw binding CA certificate path must be a bounded absolute path");
  }
  const candidate = resolve(input.caCertificatePath);
  if (parse(candidate).root === candidate) {
    throw new Error("raw binding CA certificate path must not be a filesystem root");
  }
  const path = realpathSync(candidate);
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_TEST_CA_BYTES) {
    throw new Error(`raw binding CA certificate must be a regular file of at most ${MAX_TEST_CA_BYTES} bytes`);
  }
  const ca = readFileSync(path);
  if (
    !ca.includes(Buffer.from("-----BEGIN CERTIFICATE-----", "ascii")) ||
    ca.includes(Buffer.from("PRIVATE KEY", "ascii"))
  ) {
    throw new Error("raw binding CA file must contain public certificate PEM only");
  }
  const caCertificateSha256 = assertedDigest(
    input.caCertificateSha256,
    "raw binding CA certificate digest",
  );
  if (sha256(ca) !== caCertificateSha256) {
    throw new Error("raw binding CA certificate digest does not match the exact file bytes");
  }
  const serverCertificateSha256 = assertedDigest(
    input.serverCertificateSha256,
    "raw binding server certificate digest",
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

function pinnedServerIdentity(trust: LoadedTlsTrust) {
  return (host: string, certificate: PeerCertificate): Error | undefined => {
    const identityError = checkServerIdentity(host, certificate);
    if (identityError !== undefined) return identityError;
    if (sha256(certificate.raw) === trust.evidence.serverCertificateSha256) return undefined;
    const error = new Error(
      "Gateway raw-binding TLS leaf does not match the pinned current-stack digest",
    ) as Error & { code?: string };
    error.code = "ERR_REVAGENT_RAW_BINDING_CERTIFICATE_MISMATCH";
    return error;
  };
}

function serializeFrame(request: Readonly<ParentStepDriverRequest>, limits: ResolvedLimits): SerializedFrame {
  const hasFrame = Object.prototype.hasOwnProperty.call(request.arguments, "frame");
  const hasSerialized = Object.prototype.hasOwnProperty.call(request.arguments, "serializedFrame");
  if (hasFrame === hasSerialized) {
    throw new Error("send_binding_frame requires exactly one of frame or serializedFrame");
  }
  let text: string;
  let type: string | null = null;
  if (hasSerialized) {
    const raw = request.arguments.serializedFrame;
    if (typeof raw !== "string") throw new Error("serializedFrame must be a string");
    text = raw;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        type = (parsed as { type: string }).type;
      }
    } catch {
      // Malformed JSON is an intentional raw conformance vector.
    }
  } else {
    const frame = request.arguments.frame;
    assertJsonValue(frame, "frame");
    text = JSON.stringify(frame);
    if (
      frame !== null &&
      typeof frame === "object" &&
      !Array.isArray(frame) &&
      typeof frame.type === "string"
    ) {
      type = frame.type;
    }
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > limits.maxOutboundFrameBytes) {
    throw new Error(`serialized frame must be from 1 through ${limits.maxOutboundFrameBytes} bytes`);
  }
  return {
    text,
    bytes,
    type,
    metadata: { bytes: bytes.byteLength, sha256: sha256(bytes) },
  };
}

function openingFrame(
  request: Readonly<ParentStepDriverRequest>,
  target: SerializedFrame,
  configured: CommonRawBindingDriverOptions["openingHello"],
  limits: ResolvedLimits,
): { frame: SerializedFrame; targetIsOpening: boolean } {
  const rawTargetIsOpening = request.arguments.targetIsOpeningFrame;
  if (rawTargetIsOpening !== undefined && typeof rawTargetIsOpening !== "boolean") {
    throw new Error("targetIsOpeningFrame must be a boolean when supplied");
  }
  if (target.type === "hello" || rawTargetIsOpening === true) {
    return { frame: target, targetIsOpening: true };
  }
  const requestHello = request.arguments.hello;
  const selected = requestHello ?? (
    typeof configured === "function" ? configured(request) : configured
  );
  if (selected === undefined) {
    throw new Error("a non-hello raw frame requires an explicit openingHello");
  }
  assertJsonValue(selected, "openingHello");
  const text = JSON.stringify(selected);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > limits.maxOutboundFrameBytes) {
    throw new Error(`serialized openingHello must be from 1 through ${limits.maxOutboundFrameBytes} bytes`);
  }
  const type = selected !== null &&
    typeof selected === "object" &&
    !Array.isArray(selected) &&
    typeof selected.type === "string"
    ? selected.type
    : null;
  if (type !== "hello") throw new Error("openingHello must serialize an RBP hello frame");
  return {
    frame: {
      text,
      bytes,
      type,
      metadata: { bytes: bytes.byteLength, sha256: sha256(bytes) },
    },
    targetIsOpening: false,
  };
}

function openingVersionsHeader(
  configured: string | undefined,
  opening: SerializedFrame,
): string {
  if (configured !== undefined) return versionsHeader(configured);
  try {
    const candidate = JSON.parse(opening.text) as unknown;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      return versionsHeader(undefined);
    }
    const payload = (candidate as Record<string, unknown>).payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return versionsHeader(undefined);
    }
    const minimum = (payload as Record<string, unknown>).min_protocol;
    const maximum = (payload as Record<string, unknown>).max_protocol;
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      (minimum as number) < 1 ||
      (maximum as number) < (minimum as number) ||
      (maximum as number) - (minimum as number) > 16
    ) {
      return versionsHeader(undefined);
    }
    return versionsHeader(
      Array.from(
        { length: (maximum as number) - (minimum as number) + 1 },
        (_value, index) => (maximum as number) - index,
      ).join(","),
    );
  } catch {
    return versionsHeader(undefined);
  }
}

function selectedCredential(
  request: Readonly<ParentStepDriverRequest>,
  configured: string,
): { token: string; source: "configured" | "step_override" } {
  if (!Object.prototype.hasOwnProperty.call(request.arguments, "credential")) {
    return { token: configured, source: "configured" };
  }
  return {
    token: boundedToken(request.arguments.credential, "credential"),
    source: "step_override",
  };
}

function selectedHeaders(headers: IncomingHttpHeaders): JsonObject {
  const selected: JsonObject = {};
  for (const name of [
    "cache-control",
    "content-length",
    "content-type",
    "rbp-connection-id",
    "retry-after",
    "x-accel-buffering",
  ]) {
    const value = headers[name];
    if (value === undefined) continue;
    const normalized = (Array.isArray(value) ? value.join(", ") : String(value)).slice(0, 1_024);
    selected[name] = normalized;
  }
  return selected;
}

function capturedFrame(
  bytes: Buffer,
  binary: boolean,
  parseBudget: ParseBudget,
  index: number,
): JsonObject {
  return {
    index,
    binary,
    ...parseBudget.capture(bytes),
  };
}

function boundedReason(reason: Buffer | string): string {
  const text = Buffer.isBuffer(reason) ? reason.toString("utf8") : reason;
  return text.slice(0, 512);
}

function observationId(request: Readonly<ParentStepDriverRequest>, digest: string): string {
  const base = `raw:${request.runId}:${request.caseId}:${request.binding}:${request.stepId}:${digest.slice(7, 19)}`
    .replace(/[^A-Za-z0-9._:-]/gu, "-");
  return base.slice(0, 191);
}

function successOutcome(
  request: Readonly<ParentStepDriverRequest>,
  target: SerializedFrame,
  credentialSource: "configured" | "step_override",
  remoteOutcome: JsonObject,
  atMonotonicMs: number,
  now: () => string,
): RawStepOutcome {
  const payload: JsonObject = {
    stepId: request.stepId,
    action: request.action,
    direction: "parent_to_gateway",
    binding: request.binding,
    serialized: target.metadata,
    frame: {
      type: target.type,
      source: Object.prototype.hasOwnProperty.call(request.arguments, "serializedFrame")
        ? "serializedFrame"
        : "frame",
    },
    credentialSource,
    atMonotonicMs,
    remoteOutcome,
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes > OBSERVATION_PAYLOAD_LIMIT) {
    throw new Error(`raw binding observation payload exceeds ${OBSERVATION_PAYLOAD_LIMIT} bytes`);
  }
  const observation: ProcessObservationRecord = {
    schemaVersion: "rbp-process-observation/v2",
    observationId: observationId(request, String(target.metadata.sha256)),
    runId: request.runId,
    caseId: request.caseId,
    binding: request.binding,
    componentId: "gateway_stub",
    kind: "wire_event",
    at: now(),
    payload,
  };
  return {
    kind: "success",
    result: payload,
    observations: [observation],
  };
}

function delay(ms: number, scope: ExchangeScope): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectDelay(scope.reason());
    };
    const timer = setTimeout(() => {
      scope.signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    if (scope.signal.aborted) onAbort();
    else scope.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertDriverRequest(
  request: Readonly<ParentStepDriverRequest>,
  binding: Binding,
): void {
  if (
    request.action !== "send_binding_frame" ||
    request.channel !== "parent_harness" ||
    request.binding !== binding
  ) {
    throw new Error(`raw ${binding} driver accepts only its send_binding_frame hook`);
  }
}

export function createRawWssBindingDriver(options: RawWssBindingDriverOptions): ParentStepDriver {
  const endpoint = numericLoopbackUrl(options.url, ["wss:"], "/bridge/v1", "raw WSS URL");
  const configuredToken = boundedToken(options.deviceToken, "deviceToken");
  const trust = loadTlsTrust(options.tlsTrust);
  const limits = resolvedLimits(options.limits);
  const now = options.now ?? (() => new Date().toISOString());
  const verifyServer = pinnedServerIdentity(trust);

  return async (request): Promise<RawStepOutcome> => {
    assertDriverRequest(request, "wss");
    const scope = new ExchangeScope(request);
    try {
      scope.throwIfAborted();
      const target = serializeFrame(request, limits);
      const opening = openingFrame(request, target, options.openingHello, limits);
      const versionHint = openingVersionsHeader(options.versionsHeader, opening.frame);
      const credential = selectedCredential(request, configuredToken);
      const parseBudget = new ParseBudget(limits.maxParsedCaptureBytes);
      const remoteOutcome = await new Promise<JsonObject>((resolveOutcome, rejectOutcome) => {
        const frames: JsonValue[] = [];
        let close: JsonObject | null = null;
        let upgradeResponse: JsonObject | null = null;
        let opened = false;
        let targetSent = false;
        let openingSent = false;
        let finalizingLocally = false;
        let finished = false;
        let unexpectedResponse = false;
        let quietTimer: NodeJS.Timeout | null = null;
        let forcedCloseTimer: NodeJS.Timeout | null = null;

        const socketOptions: WebSocket.ClientOptions = {
          headers: {
            authorization: `Bearer ${credential.token}`,
            "x-rbp-versions": versionHint,
          },
          maxPayload: limits.maxRemoteEntityBytes,
          ca: trust.ca,
          rejectUnauthorized: true,
          // @types/ws currently exposes a server-side callback type here, but
          // ws forwards this option to tls.connect at runtime.
          checkServerIdentity: verifyServer as unknown as NonNullable<
            WebSocket.ClientOptions["checkServerIdentity"]
          >,
        };
        const socket = new WebSocket(endpoint, socketOptions);

        const cleanup = (): void => {
          if (quietTimer !== null) clearTimeout(quietTimer);
          if (forcedCloseTimer !== null) clearTimeout(forcedCloseTimer);
          scope.signal.removeEventListener("abort", onAbort);
          socket.removeAllListeners();
        };
        const terminateSilently = (): void => {
          if (socket.readyState === WebSocket.CLOSED) return;
          // ws schedules an error when a CONNECTING socket is terminated. Keep
          // that local teardown signal out of the parent-owned remote facts.
          socket.once("error", () => undefined);
          socket.terminate();
        };
        const result = (): JsonObject => ({
          kind: "wss_exchange",
          endpoint: {
            protocol: "wss:",
            host: endpoint.hostname,
            port: Number(endpoint.port),
            path: endpoint.pathname,
          },
          negotiation: { versionsHeader: versionHint },
          tlsTrust: { ...trust.evidence },
          opened,
          openingFrame: opening.frame.metadata,
          openingSent,
          targetSent,
          receivedFrames: frames,
          close,
          upgradeResponse,
        });
        const finish = (): void => {
          if (finished) return;
          finished = true;
          cleanup();
          resolveOutcome(result());
        };
        const fail = (error: unknown): void => {
          if (finished) return;
          finished = true;
          cleanup();
          terminateSilently();
          rejectOutcome(error instanceof Error ? error : new Error(String(error)));
        };
        const beginLocalFinish = (): void => {
          if (finished || finalizingLocally) return;
          finalizingLocally = true;
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1000, "raw capture complete");
            forcedCloseTimer = setTimeout(() => {
              socket.terminate();
              finish();
            }, Math.min(500, limits.settleMs));
          } else {
            if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
            finish();
          }
        };
        const armQuiet = (): void => {
          if (!targetSent || finished || finalizingLocally) return;
          if (quietTimer !== null) clearTimeout(quietTimer);
          quietTimer = setTimeout(beginLocalFinish, limits.settleMs);
        };
        const sendText = (frame: SerializedFrame, targetFrame: boolean): void => {
          socket.send(frame.text, (error) => {
            if (error !== undefined && error !== null) {
              fail(error);
              return;
            }
            if (frame === opening.frame) openingSent = true;
            if (targetFrame) targetSent = true;
            armQuiet();
          });
        };
        const onAbort = (): void => fail(scope.reason());
        scope.signal.addEventListener("abort", onAbort, { once: true });
        socket.once("open", () => {
          opened = true;
          sendText(opening.frame, opening.targetIsOpening);
        });
        socket.on("message", (data, binary) => {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : Buffer.from(data);
          if (frames.length >= limits.maxCapturedFrames) {
            fail(new Error(`raw WSS response exceeds ${limits.maxCapturedFrames} captured frames`));
            return;
          }
          if (bytes.byteLength > limits.maxRemoteEntityBytes) {
            fail(new Error(`raw WSS response exceeds ${limits.maxRemoteEntityBytes} bytes`));
            return;
          }
          frames.push(capturedFrame(bytes, binary, parseBudget, frames.length));
          if (!opening.targetIsOpening && !targetSent) sendText(target, true);
          else armQuiet();
        });
        socket.once("close", (code, reason) => {
          if (!finalizingLocally) {
            close = { code, reason: boundedReason(reason), remote: true };
          }
          finish();
        });
        socket.once("unexpected-response", (_upgradeRequest, response) => {
          unexpectedResponse = true;
          void readIncomingBody(response, limits.maxRemoteEntityBytes, scope).then(
            (bytes) => {
              upgradeResponse = {
                status: response.statusCode ?? 0,
                headers: selectedHeaders(response.headers),
                body: { ...parseBudget.capture(bytes) },
              };
              finish();
              terminateSilently();
            },
            fail,
          );
        });
        socket.once("error", (error) => {
          if (!unexpectedResponse) fail(error);
        });
        if (scope.signal.aborted) onAbort();
      });
      return successOutcome(
        request,
        target,
        credential.source,
        remoteOutcome,
        performance.now(),
        now,
      );
    } finally {
      scope.dispose();
    }
  };
}

interface HttpResponseCapture {
  readonly status: number;
  readonly headers: JsonObject;
  readonly body: CapturedEntity;
  readonly rawHeaders: IncomingHttpHeaders;
}

function requestOptions(
  url: URL,
  method: string,
  headers: Readonly<Record<string, string>>,
  scope: ExchangeScope,
  trust: LoadedTlsTrust | null,
): RequestOptions {
  return {
    method,
    headers,
    agent: false,
    signal: scope.signal,
    ...(url.protocol === "https:"
      ? {
          ca: trust?.ca,
          rejectUnauthorized: true,
          checkServerIdentity: trust === null ? undefined : pinnedServerIdentity(trust),
        }
      : {}),
  };
}

function readIncomingBody(
  response: IncomingMessage,
  maxBytes: number,
  scope: ExchangeScope,
): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      response.off("data", onData);
      response.off("end", onEnd);
      response.off("error", onError);
      response.off("aborted", onAborted);
      scope.signal.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolveBody(Buffer.concat(chunks, total));
      else rejectBody(error);
    };
    const onData = (chunk: Buffer | Uint8Array): void => {
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) {
        finish(new Error(`remote HTTP body exceeds ${maxBytes} bytes`));
        response.destroy();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onAborted = (): void => finish(new Error("remote HTTP body aborted before completion"));
    const onAbort = (): void => {
      const reason = scope.reason();
      finish(reason);
      response.destroy();
    };
    response.on("data", onData);
    response.once("end", onEnd);
    response.once("error", onError);
    response.once("aborted", onAborted);
    if (scope.signal.aborted) onAbort();
    else scope.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function httpExchange(
  url: URL,
  method: string,
  headers: Readonly<Record<string, string>>,
  body: Buffer | null,
  scope: ExchangeScope,
  limits: ResolvedLimits,
  parseBudget: ParseBudget,
  trust: LoadedTlsTrust | null,
): Promise<HttpResponseCapture> {
  return new Promise((resolveResponse, rejectResponse) => {
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(url, requestOptions(url, method, headers, scope, trust), (response) => {
      void readIncomingBody(response, limits.maxRemoteEntityBytes, scope).then(
        (bytes) => resolveResponse({
          status: response.statusCode ?? 0,
          headers: selectedHeaders(response.headers),
          body: parseBudget.capture(bytes),
          rawHeaders: response.headers,
        }),
        rejectResponse,
      );
    });
    request.once("error", (error) => {
      rejectResponse(scope.signal.aborted ? scope.reason() : error);
    });
    if (body !== null) request.write(body);
    request.end();
  });
}

class SseCollector {
  readonly frames: JsonValue[] = [];
  readonly status: number;
  readonly headers: JsonObject;
  ended = false;
  error: Error | null = null;
  #buffer = "";
  #streamBytes = 0;
  readonly #response: IncomingMessage;
  readonly #request: ReturnType<typeof httpRequest>;
  readonly #limits: ResolvedLimits;
  readonly #parseBudget: ParseBudget;

  constructor(
    request: ReturnType<typeof httpRequest>,
    response: IncomingMessage,
    limits: ResolvedLimits,
    parseBudget: ParseBudget,
  ) {
    this.#request = request;
    this.#response = response;
    this.#limits = limits;
    this.#parseBudget = parseBudget;
    this.status = response.statusCode ?? 0;
    this.headers = selectedHeaders(response.headers);
    response.on("data", (chunk: Buffer | Uint8Array) => this.#consume(Buffer.from(chunk)));
    response.once("end", () => {
      this.ended = true;
      this.#flushBuffer();
    });
    response.once("aborted", () => {
      this.ended = true;
    });
    response.once("error", (error) => {
      this.error = error;
    });
  }

  close(): void {
    this.#response.destroy();
    this.#request.destroy();
  }

  #consume(bytes: Buffer): void {
    if (this.error !== null) return;
    this.#streamBytes += bytes.byteLength;
    if (this.#streamBytes > this.#limits.maxRemoteEntityBytes) {
      this.error = new Error(`SSE stream exceeds ${this.#limits.maxRemoteEntityBytes} captured bytes`);
      this.close();
      return;
    }
    this.#buffer += bytes.toString("utf8").replaceAll("\r\n", "\n");
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#limits.maxRemoteEntityBytes) {
      this.error = new Error(`SSE event exceeds ${this.#limits.maxRemoteEntityBytes} bytes`);
      this.close();
      return;
    }
    let separator = this.#buffer.indexOf("\n\n");
    while (separator >= 0) {
      const event = this.#buffer.slice(0, separator);
      this.#buffer = this.#buffer.slice(separator + 2);
      this.#captureEvent(event);
      separator = this.#buffer.indexOf("\n\n");
    }
  }

  #flushBuffer(): void {
    if (this.#buffer.length > 0) this.#captureEvent(this.#buffer);
    this.#buffer = "";
  }

  #captureEvent(event: string): void {
    if (this.error !== null) return;
    const data = event.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data.length === 0) return;
    if (this.frames.length >= this.#limits.maxCapturedFrames) {
      this.error = new Error(`SSE stream exceeds ${this.#limits.maxCapturedFrames} captured frames`);
      this.close();
      return;
    }
    const bytes = Buffer.from(data, "utf8");
    if (bytes.byteLength > this.#limits.maxRemoteEntityBytes) {
      this.error = new Error(`SSE frame exceeds ${this.#limits.maxRemoteEntityBytes} bytes`);
      this.close();
      return;
    }
    this.frames.push(capturedFrame(bytes, false, this.#parseBudget, this.frames.length));
  }
}

function openSse(
  url: URL,
  headers: Readonly<Record<string, string>>,
  scope: ExchangeScope,
  limits: ResolvedLimits,
  parseBudget: ParseBudget,
  trust: LoadedTlsTrust | null,
): Promise<SseCollector> {
  return new Promise((resolveStream, rejectStream) => {
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      url,
      requestOptions(url, "GET", headers, scope, trust),
      (response) => resolveStream(new SseCollector(request, response, limits, parseBudget)),
    );
    request.once("error", (error) => {
      rejectStream(scope.signal.aborted ? scope.reason() : error);
    });
    request.end();
  });
}

function responseJson(response: HttpResponseCapture): JsonObject {
  return {
    status: response.status,
    headers: response.headers,
    body: { ...response.body },
  };
}

export function createRawHttpSseBindingDriver(options: RawHttpSseBindingDriverOptions): ParentStepDriver {
  const endpoint = numericLoopbackUrl(
    options.connectionUrl,
    ["http:", "https:"],
    "/bridge/v1/http/connections",
    "raw HTTP/SSE connection URL",
  );
  const configuredToken = boundedToken(options.deviceToken, "deviceToken");
  const trust = options.tlsTrust === undefined ? null : loadTlsTrust(options.tlsTrust);
  if (endpoint.protocol === "https:" && trust === null) {
    throw new Error("raw HTTPS/SSE requires explicit pinned tlsTrust");
  }
  if (endpoint.protocol === "http:" && trust !== null) {
    throw new Error("raw cleartext HTTP/SSE must not receive tlsTrust");
  }
  const limits = resolvedLimits(options.limits);
  const now = options.now ?? (() => new Date().toISOString());

  return async (request): Promise<RawStepOutcome> => {
    assertDriverRequest(request, "streamable_http_sse");
    const scope = new ExchangeScope(request);
    let sse: SseCollector | null = null;
    try {
      scope.throwIfAborted();
      const target = serializeFrame(request, limits);
      const opening = openingFrame(request, target, options.openingHello, limits);
      const versionHint = openingVersionsHeader(options.versionsHeader, opening.frame);
      const credential = selectedCredential(request, configuredToken);
      const parseBudget = new ParseBudget(limits.maxParsedCaptureBytes);
      const commonHeaders = {
        authorization: `Bearer ${credential.token}`,
      };
      const created = await httpExchange(
        endpoint,
        "POST",
        {
          ...commonHeaders,
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(opening.frame.bytes.byteLength),
          "x-rbp-versions": versionHint,
        },
        opening.frame.bytes,
        scope,
        limits,
        parseBudget,
        trust,
      );
      const rawConnectionId = created.rawHeaders["rbp-connection-id"];
      const connectionId = Array.isArray(rawConnectionId) ? rawConnectionId[0] : rawConnectionId;
      const remoteOutcome: JsonObject = {
        kind: "streamable_http_sse_exchange",
        endpoint: {
          protocol: endpoint.protocol,
          host: endpoint.hostname,
          port: Number(endpoint.port),
          path: endpoint.pathname,
        },
        negotiation: { versionsHeader: versionHint },
        tlsTrust: trust === null ? null : { ...trust.evidence },
        openingFrame: opening.frame.metadata,
        createResponse: responseJson(created),
        connectionIdPresent: typeof connectionId === "string" && connectionId.length > 0,
        sse: null,
        messagesResponse: null,
      };
      if (created.status !== 201 || typeof connectionId !== "string" || connectionId.length === 0) {
        return successOutcome(
          request,
          target,
          credential.source,
          remoteOutcome,
          performance.now(),
          now,
        );
      }

      const eventsUrl = new URL(
        `${endpoint.pathname}/${encodeURIComponent(connectionId)}/events`,
        endpoint,
      );
      sse = await openSse(
        eventsUrl,
        {
          ...commonHeaders,
          accept: "text/event-stream",
        },
        scope,
        limits,
        parseBudget,
        trust,
      );
      remoteOutcome.sse = {
        status: sse.status,
        headers: sse.headers,
        receivedFrames: sse.frames,
        ended: sse.ended,
      };
      if (sse.status !== 200) {
        await delay(limits.settleMs, scope);
        if (sse.error !== null) throw sse.error;
        return successOutcome(
          request,
          target,
          credential.source,
          remoteOutcome,
          performance.now(),
          now,
        );
      }

      if (!opening.targetIsOpening) {
        const messagesUrl = new URL(
          `${endpoint.pathname}/${encodeURIComponent(connectionId)}/messages`,
          endpoint,
        );
        const accepted = await httpExchange(
          messagesUrl,
          "POST",
          {
            ...commonHeaders,
            "content-type": "application/json",
            "content-length": String(target.bytes.byteLength),
          },
          target.bytes,
          scope,
          limits,
          parseBudget,
          trust,
        );
        remoteOutcome.messagesResponse = responseJson(accepted);
      }
      await delay(limits.settleMs, scope);
      if (sse.error !== null) throw sse.error;
      remoteOutcome.sse = {
        status: sse.status,
        headers: sse.headers,
        receivedFrames: [...sse.frames],
        ended: sse.ended,
      };
      return successOutcome(
        request,
        target,
        credential.source,
        remoteOutcome,
        performance.now(),
        now,
      );
    } finally {
      sse?.close();
      scope.dispose();
    }
  };
}

export function createRawBindingStepHooks(options: RawBindingStepHookOptions): RawBindingStepHooks {
  const hooks: RawBindingStepHooks = {};
  if (options.wss !== undefined) hooks.wss = createRawWssBindingDriver(options.wss);
  if (options.streamableHttpSse !== undefined) {
    hooks.streamable_http_sse = createRawHttpSseBindingDriver(options.streamableHttpSse);
  }
  if (hooks.wss === undefined && hooks.streamable_http_sse === undefined) {
    throw new Error("at least one raw binding driver must be configured");
  }
  return hooks;
}
