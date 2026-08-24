import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { isDeepStrictEqual } from "node:util";

export const REAL_TRIO_NORTH_EVIDENCE_SCHEMA = "rbp-real-trio-north-evidence/v1" as const;
const MAX_NORTH_RESPONSE_BYTES = 256 * 1024;
const MAX_FALLBACK_TEXT_BYTES = 64 * 1024;
const SESSION_ID = /^[-A-Za-z0-9._:]{1,512}$/u;
const SAFE_TOOL_DIAGNOSTIC_ENUMS = new Set([
  "completed", "failed", "guarded", "indeterminate", "unknown",
  "result_delivery_unavailable", "journal_indeterminate", "delivered",
  "not_delivered", "pending", "unavailable", "post_dispatch",
  "not_reclassified", "dispatch_unavailable",
]);
const DISPATCH_UNAVAILABLE_PHASES = new Set([
  "window_acquire", "executor", "result_normalize", "window_release",
  "audit_finish",
]);
const DISPATCH_UNAVAILABLE_CLASSES = new Set([
  "gateway_rbp_fault", "abort", "error", "unknown",
]);
const GATEWAY_RBP_FAULT_CODES = new Set([
  "auth", "protocol", "unsupported", "unavailable",
]);

export interface RealTrioNorthCredential {
  readonly bearer: string;
  readonly audience: string;
  readonly credentialProvenance: "gateway_production_conformance";
  readonly identityContract: "revagent.auth-context/v1";
  /** Optional server-bound conformance session; never copied into evidence. */
  readonly serverMcpSessionId?: string;
}

export interface RealTrioNorthWireEvidence {
  readonly schemaVersion: typeof REAL_TRIO_NORTH_EVIDENCE_SCHEMA;
  readonly requestSha256: `sha256:${string}`;
  readonly responseSha256: `sha256:${string}`;
  readonly methodSha256: `sha256:${string}`;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly statusCode: number;
  readonly jsonRpcErrorCode: number | null;
  readonly mcpSessionHeaderPresent: boolean;
}

export class RealTrioNorthMcpError extends Error {
  public constructor(
    message: string,
    readonly evidence: RealTrioNorthWireEvidence | null,
    readonly toolResultEvidence: RealTrioNorthToolResultEvidence | null = null,
  ) {
    super(message);
    this.name = "RealTrioNorthMcpError";
  }
}

export interface RealTrioNorthToolResultEvidence {
  readonly httpStatus: number;
  readonly responseBytes: number;
  readonly responseSha256: `sha256:${string}`;
  /** Fixed result-shape presence bits; arbitrary result keys are never retained. */
  readonly resultKeyPresence: Readonly<{
    readonly isError: boolean;
    readonly structuredContent: boolean;
    readonly content: boolean;
  }> | null;
  readonly isError: boolean | null;
  readonly contentCount: number | null;
  readonly contentItems: readonly Readonly<{
    readonly type: "text" | "other" | null;
    readonly textUtf8Bytes: number | null;
    readonly textSha256: `sha256:${string}` | null;
  }>[];
  /**
   * Error-only diagnostic classification. Values are allowlisted enum strings
   * or `unclassified`; no error message, arbitrary key, or tool payload is
   * retained. These observations never turn an isError result into success.
   */
  readonly diagnostic: Readonly<{
    readonly source: "structured_content" | "fallback_text" | "none";
    readonly structuredContentPresent: boolean;
    readonly structuredContentObject: boolean;
    readonly fallbackTextPresent: boolean;
    readonly fallbackTextObject: boolean;
    readonly statePresent: boolean;
    readonly reasonPresent: boolean;
    readonly codePresent: boolean;
    readonly errorCodePresent: boolean;
    readonly nestedErrorCodePresent: boolean;
    readonly phasePresent: boolean;
    readonly classPresent: boolean;
    readonly upstreamCodePresent: boolean;
    readonly deliveryOutcomePresent: boolean;
    readonly deliveryPhasePresent: boolean;
    readonly mutationDispositionPresent: boolean;
    readonly state: string | null;
    readonly reason: string | null;
    readonly code: string | null;
    readonly errorCode: string | null;
    readonly nestedErrorCode: string | null;
    readonly phase: string | null;
    readonly class: string | null;
    readonly upstreamCode: string | null;
    readonly deliveryOutcome: string | null;
    readonly deliveryPhase: string | null;
    readonly mutationDisposition: string | null;
  }>;
}

export class RealTrioNorthToolResultError extends Error {
  public constructor(readonly evidence: RealTrioNorthToolResultEvidence) {
    super("real trio MCP tool result rejected");
    this.name = "RealTrioNorthToolResultError";
  }
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Accept exactly one normal JSON response or one SSE data message. */
function parseWireResponse(bytes: Buffer): unknown {
  if (bytes.byteLength === 0) throw new Error("real trio MCP response is empty");
  const text = bytes.toString("utf8");
  if (!text.startsWith("event:") && !text.startsWith("data:")) return JSON.parse(text) as unknown;
  const messages = text.split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0);
  if (messages.length !== 1) throw new Error("real trio MCP SSE response must contain exactly one data message");
  return JSON.parse(messages[0]!) as unknown;
}

function jsonRpcErrorCode(value: unknown): number | null {
  try {
    const envelope = record(value, "real trio MCP response");
    if (!("error" in envelope)) return null;
    const error = record(envelope.error, "real trio MCP response error");
    return Number.isSafeInteger(error.code) ? Number(error.code) : null;
  } catch { return null; }
}

function responseSessionId(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw new Error("real trio MCP response has an invalid mcp-session-id header");
  return value;
}

function permitsEmptyNotificationResponse(method: string, statusCode: number, responseBytes: number): boolean {
  return method === "notifications/initialized" && responseBytes === 0 &&
    (statusCode === 202 || statusCode === 204);
}

function assertResponseStatus(method: string, statusCode: number, responseBytes: number): void {
  if (statusCode === 200 || permitsEmptyNotificationResponse(method, statusCode, responseBytes)) return;
  throw new Error(`real trio MCP ${method} returned unexpected HTTP status ${statusCode}`);
}

/**
 * A strict Streamable HTTP MCP client for the real-trio carrier. Session
 * identity is exclusively Gateway-issued during initialize; callers cannot
 * inject, continue, or forge an effective MCP session id.
 */
export class RealTrioNorthMcpClient {
  private constructor(
    private readonly endpoint: URL,
    private readonly certificateSha256: string,
    private readonly credential: RealTrioNorthCredential,
    private sessionId: string | null,
    private closed = false,
  ) {}

  public static async connect(input: {
    readonly endpoint: string;
    readonly certificateSha256: string;
    readonly credential: RealTrioNorthCredential;
    /** An explicit Gateway-bound identity is the only allowed header mode. */
    readonly expectedMcpSessionId?: string;
  }): Promise<RealTrioNorthMcpClient> {
    const endpoint = strictEndpoint(input.endpoint);
    const initialization = await rawRequest({
      endpoint,
      certificateSha256: input.certificateSha256,
      credential: input.credential,
      sessionId: input.expectedMcpSessionId ?? input.credential.serverMcpSessionId ?? null,
      method: "initialize",
      payload: Object.freeze({
        jsonrpc: "2.0",
        id: "real-trio-initialize",
        method: "initialize",
        params: Object.freeze({
          protocolVersion: "2025-03-26",
          capabilities: Object.freeze({}),
          clientInfo: Object.freeze({ name: "revagent-rbp-real-trio", version: "1" }),
        }),
      }),
    });
    assertJsonRpcSuccess(initialization.response, "initialize");
    const expected = input.expectedMcpSessionId;
    if (expected !== undefined && !SESSION_ID.test(expected)) throw new Error("configured MCP session identity is invalid");
    const issued = initialization.sessionId;
    if (issued !== null && (!SESSION_ID.test(issued) || expected === undefined || issued !== expected)) {
      throw new RealTrioNorthMcpError("real trio MCP returned an unexpected mcp-session-id", initialization.evidence);
    }
    // A conformance-issued session is server-bound by authenticated ingress
    // before initialize. The MCP library may remain stateless and omit an
    // echo header; a present header must still match exactly.
    const client = new RealTrioNorthMcpClient(
      endpoint, input.certificateSha256, input.credential, expected ?? issued,
    );
    await client.notification("notifications/initialized", Object.freeze({}));
    return client;
  }

  public get usesMcpSessionHeader(): boolean { return this.sessionId !== null; }

  public async request(request: Readonly<Record<string, unknown>>): Promise<{ readonly response: unknown; readonly evidence: RealTrioNorthWireEvidence }> {
    this.assertOpen();
    const method = request.method;
    if (typeof method !== "string" || method === "initialize" || method === "notifications/initialized") {
      throw new Error("real trio MCP client only accepts post-initialize requests");
    }
    const result = await rawRequest({ endpoint: this.endpoint, certificateSha256: this.certificateSha256,
      credential: this.credential, sessionId: this.sessionId, method, payload: request });
    this.assertResponseSession(result.sessionId, result.evidence);
    assertJsonRpcSuccess(result.response, method, result.evidence);
    return Object.freeze({ response: result.response, evidence: result.evidence });
  }

  public async toolCall(input: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>>; readonly requestId: string }): Promise<{ readonly content: Record<string, unknown>; readonly evidence: RealTrioNorthWireEvidence }> {
    const result = await this.request(Object.freeze({
      jsonrpc: "2.0", id: input.requestId, method: "tools/call",
      params: Object.freeze({ name: input.name, arguments: input.arguments }),
    }));
    try {
      return Object.freeze({ content: strictToolContent(result.response), evidence: result.evidence });
    } catch {
      throw new RealTrioNorthToolResultError(boundedToolResultEvidence(result.response, result.evidence));
    }
  }

  /** Uses only the carrier-advertised public tool after exact version verification. */
  public async recoverOmittedPayload(input: {
    readonly carrier: unknown;
    readonly advertisedTool: { readonly name: string; readonly version: string };
    readonly requestId: string;
  }): Promise<{ readonly content: Record<string, unknown>; readonly evidence: RealTrioNorthWireEvidence }> {
    const carrier = parseOmittedPayloadCoordinateCarrier(input.carrier);
    if (
      carrier === null ||
      input.advertisedTool.name !== carrier.recovery_tool ||
      input.advertisedTool.version !== carrier.recovery_tool_version
    ) {
      throw new Error("C39 omitted-payload carrier does not match the advertised public tool");
    }
    return await this.toolCall({
      name: carrier.recovery_tool,
      arguments: Object.freeze({
        origin_invocation_id: carrier.origin_invocation_id,
        expected_result_digest: carrier.expected_result_digest,
      }),
      requestId: input.requestId,
    });
  }

  public async readResource(input: { readonly uri: string; readonly requestId: string }): Promise<{ readonly response: unknown; readonly evidence: RealTrioNorthWireEvidence }> {
    return await this.request(Object.freeze({ jsonrpc: "2.0", id: input.requestId,
      method: "resources/read", params: Object.freeze({ uri: input.uri }) }));
  }

  public close(): void { this.closed = true; this.sessionId = ""; }

  private async notification(method: string, params: Readonly<Record<string, unknown>>): Promise<void> {
    this.assertOpen();
    const result = await rawRequest({ endpoint: this.endpoint, certificateSha256: this.certificateSha256,
      credential: this.credential, sessionId: this.sessionId, method, payload: Object.freeze({ jsonrpc: "2.0", method, params }) });
    this.assertResponseSession(result.sessionId, result.evidence);
  }

  private assertOpen(): void { if (this.closed) throw new Error("real trio MCP client is closed"); }
  private assertResponseSession(observed: string | null, evidence: RealTrioNorthWireEvidence): void {
    if (observed !== null && observed !== this.sessionId) {
      throw new RealTrioNorthMcpError("real trio MCP response mcp-session-id does not match configured identity", evidence);
    }
  }
}

export async function withRealTrioNorthMcpClient<T>(input: {
  readonly endpoint: string;
  readonly certificateSha256: string;
  readonly credential: RealTrioNorthCredential;
  readonly expectedMcpSessionId?: string;
}, action: (client: RealTrioNorthMcpClient) => Promise<T>): Promise<T> {
  const client = await RealTrioNorthMcpClient.connect({
    ...input,
    expectedMcpSessionId: input.expectedMcpSessionId ?? input.credential.serverMcpSessionId,
  });
  try { return await action(client); } finally { client.close(); }
}

function strictEndpoint(value: string): URL {
  const url = new URL("/mcp", value);
  if (url.protocol !== "https:" || url.hostname !== "127.0.0.1" || url.port.length === 0) {
    throw new Error("real trio north MCP endpoint must be numeric loopback TLS");
  }
  return url;
}

function assertJsonRpcSuccess(value: unknown, method: string, evidence?: RealTrioNorthWireEvidence): void {
  const envelope = record(value, "real trio MCP response");
  if ("error" in envelope) {
    const code = jsonRpcErrorCode(value);
    throw new RealTrioNorthMcpError(`real trio MCP ${method} returned JSON-RPC error ${code ?? "invalid"}`, evidence ?? null,
      method === "tools/call" && evidence !== undefined ? boundedToolResultEvidence(value, evidence) : null);
  }
  if (!("result" in envelope)) throw new RealTrioNorthMcpError(`real trio MCP ${method} lacks result`, evidence ?? null);
}

/** Explicit structured and legacy text forms may coexist only when they agree exactly. */
export function strictToolContent(response: unknown): Record<string, unknown> {
  const envelope = record(response, "real trio MCP response");
  const result = record(envelope.result, "real trio MCP response result");
  if ("isError" in result && typeof result.isError !== "boolean") {
    throw new Error("real trio MCP tool result has invalid isError");
  }
  if (result.isError === true) throw new Error("real trio MCP tool result is marked isError");
  const structured = "structuredContent" in result
    ? record(result.structuredContent, "real trio MCP structured content") : null;
  if (structured !== null && !("content" in result)) return structured;
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    throw new Error("real trio MCP tool result requires one fallback text content item");
  }
  const item = record(result.content[0], "real trio MCP fallback content");
  if (item.type !== "text" || typeof item.text !== "string" || item.text.length === 0 ||
      Buffer.byteLength(item.text, "utf8") > MAX_FALLBACK_TEXT_BYTES) {
    throw new Error("real trio MCP tool fallback content is invalid");
  }
  try {
    const fallback = record(JSON.parse(item.text) as unknown, "real trio MCP fallback JSON");
    if (structured !== null && !isDeepStrictEqual(structured, fallback)) {
      throw new Error("real trio MCP structured and fallback content differ");
    }
    return structured ?? fallback;
  }
  catch { throw new Error("real trio MCP tool fallback text is not a JSON object"); }
}

export interface RealTrioOmittedPayloadCoordinateCarrier {
  readonly code: "payload_omitted";
  readonly origin_invocation_id: string;
  readonly expected_result_digest: `sha256:${string}`;
  readonly recovery_tool: "core.dispatch.payload_recovery";
  readonly recovery_tool_version: "1.0.0";
  readonly carrier_version: "c39.omitted-recovery-coordinate/v1";
}

/** Exact public C39 carrier parser; this never accepts a fixture identifier. */
export function parseOmittedPayloadCoordinateCarrier(
  value: unknown,
): RealTrioOmittedPayloadCoordinateCarrier | null {
  const candidate = asStrictObject(value);
  if (candidate === null) return null;
  const keys = Object.keys(candidate).sort();
  const expected = ["carrier_version", "code", "expected_result_digest", "origin_invocation_id", "recovery_tool", "recovery_tool_version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  return candidate.code === "payload_omitted" &&
    typeof candidate.origin_invocation_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(candidate.origin_invocation_id) &&
    typeof candidate.expected_result_digest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(candidate.expected_result_digest) &&
    candidate.recovery_tool === "core.dispatch.payload_recovery" &&
    candidate.recovery_tool_version === "1.0.0" &&
    candidate.carrier_version === "c39.omitted-recovery-coordinate/v1"
    ? Object.freeze(candidate as unknown as RealTrioOmittedPayloadCoordinateCarrier)
    : null;
}

/** A parse failure carries only bounded structural metadata, never tool text or payloads. */
export function boundedToolResultEvidence(
  response: unknown,
  wire: RealTrioNorthWireEvidence,
): RealTrioNorthToolResultEvidence {
  let result: Record<string, unknown> | null = null;
  try {
    const envelope = record(response, "real trio MCP response");
    result = "result" in envelope ? record(envelope.result, "real trio MCP response result") : null;
  } catch { /* malformed envelopes intentionally reduce to null shape evidence */ }
  const content = result !== null && Array.isArray(result.content) ? result.content : null;
  const diagnostic = boundedToolDiagnostic(result, content);
  return Object.freeze({
    httpStatus: wire.statusCode,
    responseBytes: wire.responseBytes,
    responseSha256: wire.responseSha256,
    resultKeyPresence: result === null ? null : Object.freeze({
      isError: "isError" in result,
      structuredContent: "structuredContent" in result,
      content: "content" in result,
    }),
    isError: result === null || typeof result.isError !== "boolean" ? null : result.isError,
    contentCount: content === null ? null : content.length,
    contentItems: Object.freeze((content ?? []).slice(0, 8).map((value) => {
      const item = value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
      const text = item !== null && typeof item.text === "string" ? item.text : null;
      return Object.freeze({ type: item === null || typeof item.type !== "string" ? null : item.type === "text" ? "text" : "other",
        textUtf8Bytes: text === null ? null : Buffer.byteLength(text, "utf8"),
        textSha256: text === null ? null : sha256(Buffer.from(text, "utf8")) });
    })),
    diagnostic,
  });
}

function asStrictObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function boundedDiagnosticEnum(value: unknown): string {
  return typeof value === "string" && value.length <= 64 && SAFE_TOOL_DIAGNOSTIC_ENUMS.has(value)
    ? value : "unclassified";
}

function boundedDiagnosticDispatchPhase(value: unknown): string {
  return typeof value === "string" && DISPATCH_UNAVAILABLE_PHASES.has(value)
    ? value
    : "unclassified";
}

function boundedDiagnosticDispatchClass(value: unknown): string {
  return typeof value === "string" && DISPATCH_UNAVAILABLE_CLASSES.has(value)
    ? value
    : "unclassified";
}

function boundedDiagnosticGatewayRbpFaultCode(value: unknown): string {
  return typeof value === "string" && GATEWAY_RBP_FAULT_CODES.has(value)
    ? value
    : "unclassified";
}

/**
 * This function intentionally does not compare or trust tool result content:
 * isError was already rejected by strictToolContent. It only classifies a
 * fixed allowlist of fields for failure diagnosis.
 */
function boundedToolDiagnostic(
  result: Record<string, unknown> | null,
  content: unknown[] | null,
): RealTrioNorthToolResultEvidence["diagnostic"] {
  const structuredContentPresent = result !== null && "structuredContent" in result;
  const structured = structuredContentPresent ? asStrictObject(result!.structuredContent) : null;
  const fallbackTextPresent = content?.length === 1 && (() => {
    const item = asStrictObject(content[0]);
    return item?.type === "text" && typeof item.text === "string" &&
      item.text.length > 0 && Buffer.byteLength(item.text, "utf8") <= MAX_FALLBACK_TEXT_BYTES;
  })();
  let fallback: Record<string, unknown> | null = null;
  if (fallbackTextPresent) {
    const text = (content![0] as Record<string, unknown>).text as string;
    try { fallback = asStrictObject(JSON.parse(text) as unknown); } catch { /* invalid fallback stays unclassified */ }
  }
  const source = structured !== null ? "structured_content" : fallback !== null ? "fallback_text" : "none";
  const diagnostic = structured ?? fallback;
  const error = diagnostic !== null && "error" in diagnostic ? asStrictObject(diagnostic.error) : null;
  const delivery = diagnostic !== null && "delivery" in diagnostic ? asStrictObject(diagnostic.delivery) : null;
  const value = (key: "state" | "reason" | "code" | "errorCode" | "deliveryOutcome"): string | null =>
    diagnostic !== null && key in diagnostic ? boundedDiagnosticEnum(diagnostic[key]) : null;
  return Object.freeze({
    source,
    structuredContentPresent,
    structuredContentObject: structured !== null,
    fallbackTextPresent: fallbackTextPresent === true,
    fallbackTextObject: fallback !== null,
    statePresent: diagnostic !== null && "state" in diagnostic,
    reasonPresent: diagnostic !== null && "reason" in diagnostic,
    codePresent: diagnostic !== null && "code" in diagnostic,
    errorCodePresent: diagnostic !== null && "errorCode" in diagnostic,
    nestedErrorCodePresent: error !== null && "code" in error,
    phasePresent: error !== null && "phase" in error,
    classPresent: error !== null && "class" in error,
    upstreamCodePresent: error !== null && "upstreamCode" in error,
    deliveryOutcomePresent: diagnostic !== null && "deliveryOutcome" in diagnostic,
    deliveryPhasePresent: delivery !== null && "phase" in delivery,
    mutationDispositionPresent: delivery !== null && "mutationDisposition" in delivery,
    state: value("state"),
    reason: value("reason"),
    code: value("code"),
    errorCode: value("errorCode"),
    nestedErrorCode: error !== null && "code" in error ? boundedDiagnosticEnum(error.code) : null,
    phase: error !== null && "phase" in error
      ? boundedDiagnosticDispatchPhase(error.phase) : null,
    class: error !== null && "class" in error
      ? boundedDiagnosticDispatchClass(error.class) : null,
    upstreamCode: error !== null && "upstreamCode" in error
      ? boundedDiagnosticGatewayRbpFaultCode(error.upstreamCode) : null,
    deliveryOutcome: value("deliveryOutcome"),
    deliveryPhase: delivery !== null && "phase" in delivery
      ? boundedDiagnosticEnum(delivery.phase) : null,
    mutationDisposition: delivery !== null && "mutationDisposition" in delivery
      ? boundedDiagnosticEnum(delivery.mutationDisposition) : null,
  });
}

async function rawRequest(input: {
  readonly endpoint: URL;
  readonly certificateSha256: string;
  readonly credential: RealTrioNorthCredential;
  readonly sessionId: string | null;
  readonly method: string;
  readonly payload: Readonly<Record<string, unknown>>;
}): Promise<{ readonly response: unknown; readonly evidence: RealTrioNorthWireEvidence; readonly sessionId: string | null }> {
  const payload = Buffer.from(JSON.stringify(input.payload), "utf8");
  return await new Promise((resolve, reject) => {
    const operation = httpsRequest({ hostname: input.endpoint.hostname, port: input.endpoint.port,
      path: input.endpoint.pathname, method: "POST", rejectUnauthorized: false,
      headers: { authorization: `Bearer ${input.credential.bearer}`, accept: "application/json, text/event-stream",
        "content-type": "application/json", "content-length": payload.byteLength,
        ...(input.sessionId === null ? {} : { "mcp-session-id": input.sessionId }) },
    }, (response) => {
      const peer = (response.socket as TLSSocket).getPeerCertificate(true).raw as Buffer | undefined;
      if (peer === undefined || sha256(peer) !== input.certificateSha256) {
        response.resume(); reject(new Error("real trio north MCP TLS pin mismatch")); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size <= MAX_NORTH_RESPONSE_BYTES) chunks.push(chunk); });
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        if (size > MAX_NORTH_RESPONSE_BYTES) { reject(new Error("real trio MCP response exceeds bounded size")); return; }
        try {
          const statusCode = response.statusCode ?? 0;
          assertResponseStatus(input.method, statusCode, bytes.byteLength);
          const responseValue = permitsEmptyNotificationResponse(input.method, statusCode, bytes.byteLength)
            ? null : parseWireResponse(bytes);
          const evidence = Object.freeze({ schemaVersion: REAL_TRIO_NORTH_EVIDENCE_SCHEMA,
            requestSha256: sha256(payload), responseSha256: sha256(bytes), methodSha256: sha256(Buffer.from(input.method, "utf8")),
            requestBytes: payload.byteLength, responseBytes: bytes.byteLength, statusCode,
            jsonRpcErrorCode: jsonRpcErrorCode(responseValue), mcpSessionHeaderPresent: input.sessionId !== null });
          resolve(Object.freeze({ response: responseValue, evidence,
            sessionId: responseSessionId(response.headers["mcp-session-id"]) }));
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    operation.once("error", reject); operation.end(payload);
  });
}
