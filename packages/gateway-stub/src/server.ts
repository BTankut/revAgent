import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";

import {
  journalRecordIsIntact,
  RbpFrameError,
  validateRbpEnvelope,
  type InvocationJournalRecord,
  type MutationScope,
} from "@revagent/protocol";
import { WebSocket, WebSocketServer } from "ws";

import { GatewayStubCore, GatewayStubFault } from "./core.js";
import { isFrameFaultMessageType } from "./faults.js";
import { parseVersionHint } from "./negotiation.js";
import { parseHelloFrame, serializeHelloAck } from "./preNegotiation.js";
import type {
  AuthStatus,
  AuthenticatedDevice,
  DispatchBatchRequest,
  DispatchCancelRequest,
  DispatchInvokeRequest,
  DispatchPayloadRecoveryRequest,
  FrameFaultRule,
  GatewayStubHandle,
  GatewayStubServerOptions,
  GatewayClock,
  LateTerminalEvidenceRequest,
  OpeningFaultRule,
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
    readonly offeredProtocols: readonly number[],
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
    readonly offeredProtocols: readonly number[],
  ) {
    this.tokenDigest = device.tokenDigest;
  }

  readonly binding = "http_sse" as const;

  get attached(): boolean {
    return this.response !== null;
  }

  attach(response: ServerResponse): void {
    if (this.response !== null) {
      throw new HttpRequestError(409, "SSE stream already attached");
    }
    this.response = response;
    this.active = true;
  }

  async sendSerialized(serialized: string): Promise<void> {
    const response = this.response;
    if (response === null || response.destroyed || response.writableEnded) {
      throw new Error("SSE transport is not open");
    }
    const frame = `event: rbp\ndata: ${serialized}\n\n`;
    if (!response.write(frame)) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          response.off("drain", onDrain);
          response.off("error", onError);
          response.off("close", onClose);
        };
        const settle = (error?: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error === undefined) resolve();
          else reject(error);
        };
        const onDrain = (): void => settle();
        const onError = (error: Error): void => settle(error);
        const onClose = (): void => settle(new Error("SSE transport closed before buffered delivery drained"));
        response.once("drain", onDrain);
        response.once("error", onError);
        response.once("close", onClose);
        if (response.destroyed || response.writableEnded) onClose();
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

function assertVersionHint(core: GatewayStubCore, request: IncomingMessage): number[] {
  const versions = parseVersionHint(request.headers["x-rbp-versions"]);
  if (versions.length === 0) {
    throw new HttpRequestError(426, "missing or invalid X-RBP-Versions");
  }
  if (!core.supportedProtocols.some((version) => versions.includes(version))) {
    throw new HttpRequestError(426, "no mutually supported RBP version");
  }
  return versions;
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
  | { action: "enqueue_frame_fault"; rule: FrameFaultRule }
  | { action: "enqueue_opening_fault"; rule: OpeningFaultRule }
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
  | {
      action: "prime_sequence_for_conformance";
      rsid: string;
      mode: "bridge_to_gateway_near_exhaustion" | "gateway_to_bridge_gap_after_one";
    }
  | { action: "set_clock"; now_ms: number }
  | { action: "liveness_sweep" }
  | { action: "snapshot" };

function controlObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpRequestError(400, `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactControlKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "control command",
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new HttpRequestError(
      400,
      `${label} fields are invalid; missing=[${missing.join(",")}] unknown=[${unknown.join(",")}]`,
    );
  }
}

function controlString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new HttpRequestError(400, `${label} must be a non-empty bounded string`);
  }
  return value;
}

function positiveControlInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HttpRequestError(400, `${label} must be a positive safe integer`);
  }
  return value as number;
}

function controlStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new HttpRequestError(400, `${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new HttpRequestError(400, `${label} entries must be unique`);
  }
  return value as string[];
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const VERIFICATION_HOLD_PATTERN = /^vh:[0-9a-f]{64}$/u;
const RETRY_AFTER_SECONDS_PATTERN = /^(?:0|[1-9][0-9]{0,9})$/u;
const IMF_FIXDATE_PATTERN = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u;
const CONTROL_VALIDATION_ID = "018f0000-0000-7000-8000-000000000000";
const CONTROL_VALIDATION_TS = "2026-07-22T00:00:00.000Z";

function controlRsid(value: unknown, label = "rsid"): string {
  const parsed = controlString(value, label);
  if (parsed.length > 256) throw new HttpRequestError(400, `${label} exceeds the RBP rsid limit`);
  return parsed;
}

function controlUuidV7(value: unknown, label: string): string {
  const parsed = controlString(value, label);
  if (!UUID_V7_PATTERN.test(parsed)) throw new HttpRequestError(400, `${label} must be a UUIDv7`);
  return parsed;
}

function controlSha256(value: unknown, label: string): string {
  const parsed = controlString(value, label);
  if (!SHA256_PATTERN.test(parsed)) throw new HttpRequestError(400, `${label} must be a canonical sha256 digest`);
  return parsed;
}

function controlVerificationHoldId(value: unknown, label: string): string {
  const parsed = controlString(value, label);
  if (!VERIFICATION_HOLD_PATTERN.test(parsed)) {
    throw new HttpRequestError(400, `${label} must be a canonical verification hold id`);
  }
  return parsed;
}

function controlMutationScope(value: unknown, label = "mutation_scope"): MutationScope {
  const scope = controlObject(value, label);
  if (scope.kind === "session") {
    exactControlKeys(scope, ["kind"], [], `${label} session scope`);
    return { kind: "session" };
  }
  if (scope.kind === "document") {
    exactControlKeys(scope, ["kind", "document_id"], [], `${label} document scope`);
    return { kind: "document", document_id: controlString(scope.document_id, `${label} document_id`) };
  }
  throw new HttpRequestError(400, `${label} kind must be session or document`);
}

function controlInvokePayload(
  value: unknown,
  rsid: string,
  label: string,
): DispatchInvokeRequest["payload"] {
  const candidate = {
    v: 1,
    type: "invoke",
    id: CONTROL_VALIDATION_ID,
    rsid,
    seq: 1,
    ack: 0,
    ts: CONTROL_VALIDATION_TS,
    payload: value,
  };
  if (!validateRbpEnvelope(candidate)) {
    throw new HttpRequestError(400, `${label} is not a valid RBP/1 invoke payload`);
  }
  return value as DispatchInvokeRequest["payload"];
}

function controlBatchPayload(
  value: unknown,
  rsid: string,
  label: string,
): DispatchBatchRequest["payload"] {
  const candidate = {
    v: 1,
    type: "invoke_batch",
    id: CONTROL_VALIDATION_ID,
    rsid,
    seq: 1,
    ack: 0,
    ts: CONTROL_VALIDATION_TS,
    payload: value,
  };
  if (!validateRbpEnvelope(candidate)) {
    throw new HttpRequestError(400, `${label} is not a valid RBP/1 invoke_batch payload`);
  }
  return value as DispatchBatchRequest["payload"];
}

function assertControlCancelPayload(rsid: string, invocationId: string, reason: string): void {
  if (!validateRbpEnvelope({
    v: 1,
    type: "cancel",
    id: CONTROL_VALIDATION_ID,
    rsid,
    seq: 1,
    ack: 0,
    ts: CONTROL_VALIDATION_TS,
    payload: { invocation_id: invocationId, reason },
  })) {
    throw new HttpRequestError(400, "dispatch_cancel request is not a valid RBP/1 cancel payload");
  }
}

function controlConclusion(value: unknown): VerificationEvidenceRequest["conclusion"] {
  if (
    value !== "non_execution_proven" &&
    value !== "postcondition_verified" &&
    value !== "inconclusive" &&
    value !== "failed" &&
    value !== "omitted" &&
    value !== "ambiguous"
  ) {
    throw new HttpRequestError(400, "evidence conclusion is invalid");
  }
  return value;
}

function controlJournalRecord(value: unknown): InvocationJournalRecord {
  const record = controlObject(value, "journalRecord") as unknown as InvocationJournalRecord;
  if (!journalRecordIsIntact(record)) {
    throw new HttpRequestError(400, "journalRecord is malformed or fails its integrity digests");
  }
  return record;
}

function controlRetryAfter(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\r\n]/u.test(value)) {
    throw new HttpRequestError(400, "opening fault retryAfter must be a bounded HTTP Retry-After value");
  }
  if (RETRY_AFTER_SECONDS_PATTERN.test(value)) return value;
  if (IMF_FIXDATE_PATTERN.test(value) && Number.isFinite(Date.parse(value))) return value;
  throw new HttpRequestError(400, "opening fault retryAfter must be delay-seconds or IMF-fixdate");
}

function parseControlCommand(value: unknown): ControlCommand {
  const command = controlObject(value, "control command");
  const action = controlString(command.action, "control action");
  switch (action) {
    case "enqueue_frame_fault": {
      exactControlKeys(command, ["action", "rule"]);
      const rule = controlObject(command.rule, "frame fault rule");
      exactControlKeys(
        rule,
        ["direction", "action"],
        ["binding", "messageType", "remaining", "delayMs"],
        "frame fault rule",
      );
      if (rule.direction !== "gateway_to_bridge" && rule.direction !== "bridge_to_gateway") {
        throw new HttpRequestError(400, "frame fault direction is invalid");
      }
      if (rule.action !== "drop" && rule.action !== "duplicate" && rule.action !== "delay" && rule.action !== "hold") {
        throw new HttpRequestError(400, "frame fault action is invalid");
      }
      if (rule.binding !== undefined && rule.binding !== "wss" && rule.binding !== "http_sse") {
        throw new HttpRequestError(400, "frame fault binding is invalid");
      }
      if (rule.messageType !== undefined &&
        (typeof rule.messageType !== "string" || !isFrameFaultMessageType(rule.direction, rule.messageType))) {
        throw new HttpRequestError(400, "frame fault messageType cannot match the selected direction");
      }
      const remaining = rule.remaining === undefined
        ? undefined
        : positiveControlInteger(rule.remaining, "frame fault remaining");
      if (rule.action === "delay") {
        if (!Number.isSafeInteger(rule.delayMs) || (rule.delayMs as number) < 0) {
          throw new HttpRequestError(400, "delay frame fault requires a non-negative safe delayMs");
        }
      } else if (rule.delayMs !== undefined) {
        throw new HttpRequestError(400, "delayMs is valid only for a delay frame fault");
      }
      return {
        action,
        rule: {
          direction: rule.direction,
          action: rule.action,
          ...(rule.binding === undefined ? {} : { binding: rule.binding }),
          ...(rule.messageType === undefined ? {} : { messageType: rule.messageType }),
          ...(remaining === undefined ? {} : { remaining }),
          ...(rule.delayMs === undefined ? {} : { delayMs: rule.delayMs as number }),
        },
      };
    }
    case "enqueue_opening_fault": {
      exactControlKeys(command, ["action", "rule"]);
      const rule = controlObject(command.rule, "opening fault rule");
      exactControlKeys(rule, ["binding", "status"], ["retryAfter", "remaining"], "opening fault rule");
      if (rule.binding !== "wss" && rule.binding !== "http_sse") {
        throw new HttpRequestError(400, "opening fault binding is invalid");
      }
      if (!Number.isSafeInteger(rule.status) || (rule.status as number) < 400 || (rule.status as number) > 599) {
        throw new HttpRequestError(400, "opening fault status must be an HTTP error status");
      }
      const retryAfter = rule.retryAfter === undefined ? undefined : controlRetryAfter(rule.retryAfter);
      const remaining = rule.remaining === undefined
        ? undefined
        : positiveControlInteger(rule.remaining, "opening fault remaining");
      return {
        action,
        rule: {
          binding: rule.binding,
          status: rule.status as number,
          ...(retryAfter === undefined ? {} : { retryAfter }),
          ...(remaining === undefined ? {} : { remaining }),
        },
      };
    }
    case "flush_held":
      exactControlKeys(command, ["action"], ["connection_id"]);
      return {
        action,
        ...(command.connection_id === undefined
          ? {}
          : { connection_id: controlString(command.connection_id, "flush_held connection_id") }),
      };
    case "set_sse_buffering":
      exactControlKeys(command, ["action", "connection_id", "enabled"]);
      if (typeof command.enabled !== "boolean") throw new HttpRequestError(400, "set_sse_buffering enabled must be boolean");
      return { action, connection_id: controlString(command.connection_id, "connection_id"), enabled: command.enabled };
    case "disconnect":
      exactControlKeys(command, ["action", "connection_id"]);
      return { action, connection_id: controlString(command.connection_id, "connection_id") };
    case "set_auth_status":
      exactControlKeys(command, ["action", "token", "status"]);
      if (command.status !== "active" && command.status !== "revoked" && command.status !== "seat_denied") {
        throw new HttpRequestError(400, "set_auth_status status is invalid");
      }
      return { action, token: controlString(command.token, "set_auth_status token"), status: command.status };
    case "expire_pending":
      exactControlKeys(command, ["action", "rsid"]);
      return { action, rsid: controlRsid(command.rsid, "expire_pending rsid") };
    case "install_hold":
      exactControlKeys(command, ["action", "rsid", "mutation_scope", "origin_invocation_ids"]);
      {
        const originInvocationIds = controlStringArray(command.origin_invocation_ids, "origin_invocation_ids")
          .map((entry) => controlUuidV7(entry, "origin_invocation_ids entry"));
        if (originInvocationIds.length === 0) {
          throw new HttpRequestError(400, "origin_invocation_ids must contain at least one invocation id");
        }
      return {
        action,
        rsid: controlRsid(command.rsid, "install_hold rsid"),
        mutation_scope: controlMutationScope(command.mutation_scope, "install_hold mutation_scope"),
          origin_invocation_ids: originInvocationIds,
      };
      }
    case "record_verification_evidence": {
      exactControlKeys(command, ["action", "request"]);
      const request = controlObject(command.request, `${action} request`);
      exactControlKeys(request, [
        "rsid",
        "holdId",
        "mutationScope",
        "verificationInvocationId",
        "evidenceDigest",
        "conclusion",
        "journalRecord",
      ], [], `${action} request`);
      return {
        action,
        request: {
          rsid: controlRsid(request.rsid),
          holdId: controlVerificationHoldId(request.holdId, "holdId"),
          mutationScope: controlMutationScope(request.mutationScope, "mutationScope"),
          verificationInvocationId: controlUuidV7(request.verificationInvocationId, "verificationInvocationId"),
          evidenceDigest: controlSha256(request.evidenceDigest, "evidenceDigest"),
          conclusion: controlConclusion(request.conclusion),
          journalRecord: controlJournalRecord(request.journalRecord),
        },
      };
    }
    case "record_late_terminal_evidence": {
      exactControlKeys(command, ["action", "request"]);
      const request = controlObject(command.request, `${action} request`);
      exactControlKeys(request, [
        "rsid",
        "holdId",
        "originIdempotencyKey",
        "evidenceDigest",
        "conclusion",
        "journalRecord",
      ], [], `${action} request`);
      return {
        action,
        request: {
          rsid: controlRsid(request.rsid),
          holdId: controlVerificationHoldId(request.holdId, "holdId"),
          originIdempotencyKey: controlString(request.originIdempotencyKey, "originIdempotencyKey"),
          evidenceDigest: controlSha256(request.evidenceDigest, "evidenceDigest"),
          conclusion: controlConclusion(request.conclusion),
          journalRecord: controlJournalRecord(request.journalRecord),
        },
      };
    }
    case "dispatch_invoke": {
      exactControlKeys(command, ["action", "request"]);
      const request = controlObject(command.request, `${action} request`);
      exactControlKeys(request, ["rsid", "payload"], [], `${action} request`);
      const rsid = controlRsid(request.rsid);
      return { action, request: { rsid, payload: controlInvokePayload(request.payload, rsid, `${action} payload`) } };
    }
    case "dispatch_batch": {
      exactControlKeys(command, ["action", "request"]);
      const request = controlObject(command.request, `${action} request`);
      exactControlKeys(request, ["rsid", "payload"], [], `${action} request`);
      const rsid = controlRsid(request.rsid);
      return { action, request: { rsid, payload: controlBatchPayload(request.payload, rsid, `${action} payload`) } };
    }
    case "dispatch_cancel": {
      exactControlKeys(command, ["action", "request"]);
      const request = controlObject(command.request, `${action} request`);
      exactControlKeys(request, ["rsid", "invocationId", "reason"], [], `${action} request`);
      const rsid = controlRsid(request.rsid);
      const invocationId = controlUuidV7(request.invocationId, "invocationId");
      if (
        request.reason !== "user_requested" &&
        request.reason !== "client_disconnected" &&
        request.reason !== "deadline_exceeded" &&
        request.reason !== "gateway_shutdown"
      ) {
        throw new HttpRequestError(400, "dispatch_cancel reason is invalid");
      }
      assertControlCancelPayload(rsid, invocationId, request.reason);
      return { action, request: { rsid, invocationId, reason: request.reason } };
    }
    case "dispatch_payload_recovery": {
      exactControlKeys(command, ["action", "request"]);
      const request = controlObject(command.request, `${action} request`);
      exactControlKeys(request, [
        "rsid",
        "originInvocationId",
        "omittedResultDigest",
        "auditId",
        "payload",
      ], [], `${action} request`);
      const rsid = controlRsid(request.rsid);
      return {
        action,
        request: {
          rsid,
          originInvocationId: controlUuidV7(request.originInvocationId, "originInvocationId"),
          omittedResultDigest: controlSha256(request.omittedResultDigest, "omittedResultDigest"),
          auditId: controlString(request.auditId, "auditId"),
          payload: controlInvokePayload(request.payload, rsid, `${action} payload`),
        },
      };
    }
    case "prime_sequence_for_conformance": {
      exactControlKeys(command, ["action", "rsid", "mode"]);
      if (
        command.mode !== "bridge_to_gateway_near_exhaustion" &&
        command.mode !== "gateway_to_bridge_gap_after_one"
      ) {
        throw new HttpRequestError(400, "prime_sequence_for_conformance mode is invalid");
      }
      return {
        action,
        rsid: controlRsid(command.rsid, "prime_sequence_for_conformance rsid"),
        mode: command.mode,
      };
    }
    case "set_clock":
      exactControlKeys(command, ["action", "now_ms"]);
      if (!Number.isSafeInteger(command.now_ms) || (command.now_ms as number) < 0) {
        throw new HttpRequestError(400, "set_clock now_ms must be a non-negative safe integer");
      }
      return { action, now_ms: command.now_ms as number };
    case "liveness_sweep":
    case "snapshot":
      exactControlKeys(command, ["action"]);
      return { action };
    default:
      throw new HttpRequestError(400, `unknown control action: ${action}`);
  }
}

function isControllableClock(
  clock: GatewayClock | undefined,
): clock is GatewayClock & { setNowMs(value: number): void } {
  return clock !== undefined &&
    "setNowMs" in clock &&
    typeof (clock as { setNowMs?: unknown }).setNowMs === "function";
}

export async function startGatewayStub(options: GatewayStubServerOptions): Promise<GatewayStubHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("the test-only Gateway stub may bind only to loopback");
  }
  const port = options.port ?? 0;
  const controlToken = options.controlToken ?? "rbp-test-control";
  const core = await GatewayStubCore.create(options);
  const transports = new Map<string, ServerTransport>();
  const connectionClosePromises = new Map<string, Promise<void>>();
  const backgroundCloseErrors: unknown[] = [];
  const backgroundTasks = new Set<Promise<void>>();
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
  let closePromise: Promise<void> | undefined;
  let sweepTimer: NodeJS.Timeout | null = null;

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    observeBackgroundTask(route(request, response).catch((error: unknown) => {
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
    }));
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

  function pushUniqueError(errors: unknown[], error: unknown): void {
    if (!errors.includes(error)) errors.push(error);
  }

  function observeBackgroundTask(promise: Promise<void>): void {
    backgroundTasks.add(promise);
    void promise.then(
      () => backgroundTasks.delete(promise),
      (error: unknown) => {
        pushUniqueError(backgroundCloseErrors, error);
        backgroundTasks.delete(promise);
      },
    );
  }

  async function drainBackgroundTasks(): Promise<void> {
    while (backgroundTasks.size > 0) {
      await Promise.allSettled([...backgroundTasks]);
    }
  }

  function collectRejected(results: PromiseSettledResult<unknown>[], errors: unknown[]): void {
    for (const result of results) {
      if (result.status === "rejected") pushUniqueError(errors, result.reason);
    }
  }

  async function drainConnectionClosures(errors: unknown[]): Promise<void> {
    while (transports.size > 0 || connectionClosePromises.size > 0) {
      const closures = new Set<Promise<void>>(connectionClosePromises.values());
      for (const connectionId of [...transports.keys()]) {
        closures.add(closeConnection(connectionId, "stub_shutdown"));
      }
      if (closures.size === 0) return;
      collectRejected(await Promise.allSettled([...closures]), errors);
    }
  }

  function closeConnection(connectionId: string, reason: string, code = 1001): Promise<void> {
    const existing = connectionClosePromises.get(connectionId);
    if (existing !== undefined) return existing;

    let resolveClose!: () => void;
    let rejectClose!: (reason?: unknown) => void;
    const closePromiseForConnection = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    connectionClosePromises.set(connectionId, closePromiseForConnection);

    const transport = transports.get(connectionId);
    transports.delete(connectionId);
    clearConnectionDeadline(connectionId);
    markConnectionExpired(connectionId);
    core.faults.cancelConnection(connectionId);
    if (transport !== undefined) {
      transport.active = false;
    }

    void (async () => {
      const errors: unknown[] = [];
      if (transport !== undefined) {
        try {
          await transport.close(code, reason);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await core.faults.waitForConnection(connectionId);
      } catch (error) {
        errors.push(error);
      }
      try {
        await core.disconnectConnection(connectionId, reason);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `connection close failed: ${connectionId}`);
    })().then(resolveClose, rejectClose);

    void closePromiseForConnection.finally(() => {
      if (connectionClosePromises.get(connectionId) === closePromiseForConnection) {
        connectionClosePromises.delete(connectionId);
      }
    }).catch(() => undefined);
    return closePromiseForConnection;
  }

  function observeConnectionClose(promise: Promise<void>): void {
    observeBackgroundTask(promise);
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
      observeConnectionClose(closeConnection(connectionId, reason, code));
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
        json(response, openingFault.status, openingFault.status === 426
          ? {
              error: "injected_opening_fault",
              min_protocol: Math.min(...core.supportedProtocols),
              max_protocol: Math.max(...core.supportedProtocols),
              manifest_url: "/bridge/update/manifest",
            }
          : { error: "injected_opening_fault" }, headers);
        return;
      }
      if (!isJsonMediaType(request.headers["content-type"])) {
        throw new HttpRequestError(415, "fallback create requires Content-Type: application/json");
      }
      if (!(request.headers.accept ?? "").toString().toLowerCase().split(",").map((value) => value.trim()).includes("application/json")) {
        throw new HttpRequestError(406, "fallback create requires Accept: application/json");
      }
      const offeredProtocols = assertVersionHint(core, request);
      const { device } = authenticateRequest(core, request);
      const frame = await readBody(request, 64 * 1024);
      const hello = parseHelloFrame(frame);
      if (closed) {
        throw new HttpRequestError(503, "Gateway stub is shutting down");
      }
      const connectionId = await core.allocateConnectionId(device);
      if (closed) {
        throw new HttpRequestError(503, "Gateway stub is shutting down");
      }
      const transport = new SseTransport(connectionId, device, offeredProtocols);
      transports.set(connectionId, transport);
      core.attachConnection(transport);
      try {
        const ack = await core.acceptHello(connectionId, hello);
        if (closed || transports.get(connectionId) !== transport) {
          await closeConnection(connectionId, "stub_shutdown");
          throw new HttpRequestError(503, "Gateway stub is shutting down");
        }
        armConnectionDeadline(connectionId, sseAttachTimeoutMs, "sse_attach_timeout", 4400);
        json(response, 201, JSON.parse(serializeHelloAck(ack)), {
          "rbp-connection-id": connectionId,
        });
      } catch (error) {
        await closeConnection(connectionId, "hello_failed");
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
      if (transport.attached) {
        throw new HttpRequestError(409, "SSE stream already attached");
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
          observeConnectionClose(closeConnection(connectionId, "sse_eof"));
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
      let failureClose: Promise<void> | null = null;
      const closeForUnknownAcceptance = (): Promise<void> => {
        if (failureClose === null) {
          failureClose = closeConnection(connectionId, "uplink_acceptance_unknown");
          observeConnectionClose(failureClose);
        }
        return failureClose;
      };
      const onPrematureRequestEnd = (): void => {
        void closeForUnknownAcceptance().catch(() => undefined);
      };
      const onPrematureResponseClose = (): void => {
        if (!response.writableFinished) onPrematureRequestEnd();
      };
      request.once("aborted", onPrematureRequestEnd);
      response.once("close", onPrematureResponseClose);
      try {
        if (!isJsonMediaType(request.headers["content-type"])) {
          throw new HttpRequestError(415, "fallback uplink requires application/json");
        }
        const frame = await readBody(request, MAX_HTTP_MESSAGE_BYTES);
        const delivery = await core.receiveFrame(connectionId, frame);
        if (delivery.outcome === "dropped") {
          await closeForUnknownAcceptance();
          response.destroy();
          return;
        }
        if (delivery.outcome === "deferred") {
          const completion = await delivery.completion;
          if (completion.state === "failed") throw completion.error;
          if (completion.state !== "delivered") {
            await closeForUnknownAcceptance();
            response.destroy();
            return;
          }
        }
        if (failureClose !== null || request.aborted || response.destroyed) {
          await closeForUnknownAcceptance().catch(() => undefined);
          if (!response.destroyed) response.destroy();
          return;
        }
      } catch (error) {
        if (error instanceof GatewayStubFault) {
          await core.sendConnectionFault(connectionId, error).catch(() => undefined);
          if (failureClose === null) {
            failureClose = closeConnection(connectionId, error.message);
            observeConnectionClose(failureClose);
          }
          await failureClose.catch(() => undefined);
          throw new HttpRequestError(400, error.message);
        }
        await closeForUnknownAcceptance().catch(() => undefined);
        if (error instanceof HttpRequestError) throw error;
        response.destroy(error instanceof Error ? error : undefined);
        return;
      } finally {
        request.off("aborted", onPrematureRequestEnd);
        response.off("close", onPrematureResponseClose);
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
      if (!isJsonMediaType(request.headers["content-type"])) {
        throw new HttpRequestError(415, "test control requires Content-Type: application/json");
      }
      const rawBody = Buffer.from(await readBody(request, MAX_CONTROL_BODY_BYTES)).toString("utf8");
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody) as unknown;
      } catch {
        throw new HttpRequestError(400, "test control body must be valid JSON");
      }
      const body = parseControlCommand(parsedBody);
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
          if (
            body.connection_id !== undefined &&
            !transports.has(body.connection_id)
          ) {
            throw new HttpRequestError(
              expiredConnectionIds.has(body.connection_id) ? 410 : 404,
              "unknown transport connection",
            );
          }
          {
            const flushed = await core.faults.flushHeld(body.connection_id);
            result = {
              selected: flushed.selected,
              flushed: flushed.delivered,
              cancelled: flushed.cancelled,
              failed: flushed.failed,
            };
          }
          break;
        case "set_sse_buffering":
          if (!(transports.get(body.connection_id) instanceof SseTransport)) {
            throw new HttpRequestError(
              expiredConnectionIds.has(body.connection_id) ? 410 : 404,
              "unknown fallback connection",
            );
          }
          core.faults.setSseBuffering(body.connection_id, body.enabled);
          result = { enabled: body.enabled };
          break;
        case "disconnect":
          if (!transports.has(body.connection_id)) {
            throw new HttpRequestError(
              expiredConnectionIds.has(body.connection_id) ? 410 : 404,
              "unknown transport connection",
            );
          }
          await closeConnection(body.connection_id, "injected_disconnect");
          result = { disconnected: true };
          break;
        case "set_auth_status":
          {
            let affected: string[];
            try {
              affected = core.setAuthStatus(body.token, body.status);
            } catch (error) {
              if (error instanceof Error && error.message === "unknown static test token") {
                throw new HttpRequestError(404, error.message);
              }
              throw error;
            }
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
        case "prime_sequence_for_conformance":
          result = await core.primeSequenceForConformance(body.rsid, body.mode);
          break;
        case "set_clock":
          if (!isControllableClock(options.clock)) {
            throw new HttpRequestError(409, "Gateway stub was not started with a controllable clock");
          }
          if (!Number.isSafeInteger(body.now_ms) || body.now_ms < 0) {
            throw new HttpRequestError(400, "set_clock now_ms must be a non-negative safe integer");
          }
          options.clock.setNowMs(body.now_ms);
          result = { now_ms: options.clock.nowMs() };
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
        default:
          throw new HttpRequestError(400, "unknown control action");
      }
      json(response, 200, result);
      return;
    }

    throw new HttpRequestError(404, "not found");
  }

  server.on("upgrade", (request, socket, head) => {
    observeBackgroundTask((async () => {
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
        rawUpgradeResponse(socket, openingFault.status, openingFault.status === 426
          ? {
              error: "injected_opening_fault",
              min_protocol: Math.min(...core.supportedProtocols),
              max_protocol: Math.max(...core.supportedProtocols),
              manifest_url: "/bridge/update/manifest",
            }
          : { error: "injected_opening_fault" }, headers);
        return;
      }
      let device: AuthenticatedDevice;
      let offeredProtocols: number[];
      try {
        offeredProtocols = assertVersionHint(core, request);
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
      if (closed) {
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        const transport = new WsTransport(
          connectionId,
          device,
          websocket,
          offeredProtocols,
        );
        transports.set(connectionId, transport);
        core.attachConnection(transport);
        if (closed) {
          observeConnectionClose(closeConnection(connectionId, "stub_shutdown"));
          return;
        }
        armConnectionDeadline(connectionId, helloTimeoutMs, "hello_timeout", 4400);
        let firstFrame = true;
        let receiveFailed = false;
        let receiveChain: Promise<void> = Promise.resolve();
        websocket.on("message", (data, isBinary) => {
          const received = receiveChain.then(async () => {
            if (receiveFailed) return;
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
              const delivery = await core.receiveFrame(connectionId, frame);
              if (delivery.outcome === "deferred") {
                const completion = await delivery.completion;
                if (completion.state === "failed") {
                  throw completion.error;
                }
                if (completion.state === "cancelled") {
                  throw new GatewayStubFault(
                    `deferred WSS acceptance is unknown: ${completion.reason}`,
                    "protocol",
                    4400,
                  );
                }
              }
            }
          }).catch(async (error: unknown) => {
            receiveFailed = true;
            const fault = error instanceof GatewayStubFault
              ? error
              : new GatewayStubFault(error instanceof Error ? error.message : "protocol failure", "protocol", 4400);
            await core.sendConnectionFault(connectionId, fault).catch(() => undefined);
            const closeReason = fault.closeCode === 4426
              ? JSON.stringify({
                  min_protocol: Math.min(...core.supportedProtocols),
                  max_protocol: Math.max(...core.supportedProtocols),
                  manifest_url: "/bridge/update/manifest",
                })
              : fault.message;
            await closeConnection(connectionId, closeReason, fault.closeCode);
          });
          receiveChain = received;
          observeBackgroundTask(received);
        });
        websocket.on("error", (error: Error & { code?: string }) => {
          receiveFailed = true;
          const payloadTooLarge = error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ||
            /payload size|message too big/iu.test(error.message);
          observeConnectionClose(closeConnection(
            connectionId,
            payloadTooLarge ? "wss_payload_too_large" : "wss_transport_error",
            payloadTooLarge ? 1009 : 4400,
          ));
        });
        websocket.once("close", () => {
          if (!closed) observeConnectionClose(closeConnection(connectionId, "wss_closed"));
        });
      });
    })().catch(() => {
      socket.destroy();
    }));
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
      observeBackgroundTask((async () => {
        const connectionIds = await core.livenessSweep();
        const closures = connectionIds.map(
          (connectionId) => closeConnection(connectionId, "heartbeat_timeout"),
        );
        for (const closure of closures) observeConnectionClose(closure);
        await Promise.allSettled(closures);
      })());
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
    close(): Promise<void> {
      closePromise ??= (async () => {
        closed = true;
        const errors: unknown[] = [];
        if (sweepTimer !== null) {
          clearInterval(sweepTimer);
          sweepTimer = null;
        }
        for (const deadline of connectionDeadlines.values()) clearTimeout(deadline);
        connectionDeadlines.clear();

        const serverClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => error === undefined ? resolve() : reject(error));
        });
        const websocketClosed = new Promise<void>((resolve) => {
          websocketServer.close(() => resolve());
        });
        await drainConnectionClosures(errors);
        server.closeAllConnections();
        await drainBackgroundTasks();
        await drainConnectionClosures(errors);
        for (const deadline of connectionDeadlines.values()) clearTimeout(deadline);
        connectionDeadlines.clear();
        collectRejected(await Promise.allSettled([serverClosed, websocketClosed]), errors);
        await drainBackgroundTasks();
        await drainConnectionClosures(errors);
        try {
          await core.close();
        } catch (error) {
          errors.push(error);
        }
        for (const error of backgroundCloseErrors.splice(0)) pushUniqueError(errors, error);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Gateway stub server close failed");
      })();
      return closePromise;
    },
  };
}
