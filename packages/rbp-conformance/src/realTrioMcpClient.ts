import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";
import { isDeepStrictEqual } from "node:util";

export const REAL_TRIO_NORTH_EVIDENCE_SCHEMA = "rbp-real-trio-north-evidence/v1" as const;
const MAX_NORTH_RESPONSE_BYTES = 256 * 1024;
const MAX_FALLBACK_TEXT_BYTES = 64 * 1024;
const SESSION_ID = /^[-A-Za-z0-9._:]{1,512}$/u;

export interface RealTrioNorthCredential {
  readonly bearer: string;
  readonly audience: string;
  readonly credentialProvenance: "gateway_production_conformance";
  readonly identityContract: "revagent.auth-context/v1";
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
  readonly resultKeySet: readonly string[] | null;
  readonly isError: boolean | null;
  readonly contentCount: number | null;
  readonly contentItems: readonly Readonly<{
    readonly type: string | null;
    readonly textUtf8Bytes: number | null;
    readonly textSha256: `sha256:${string}` | null;
  }>[];
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
      sessionId: null,
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
    if (expected !== undefined && issued === null) {
      throw new RealTrioNorthMcpError("real trio MCP omitted configured mcp-session-id", initialization.evidence);
    }
    const client = new RealTrioNorthMcpClient(endpoint, input.certificateSha256, input.credential, issued);
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
    if (observed !== this.sessionId) {
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
  const client = await RealTrioNorthMcpClient.connect(input);
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
  return Object.freeze({
    httpStatus: wire.statusCode,
    responseBytes: wire.responseBytes,
    responseSha256: wire.responseSha256,
    resultKeySet: result === null ? null : Object.freeze(Object.keys(result).sort().slice(0, 64)),
    isError: result === null || typeof result.isError !== "boolean" ? null : result.isError,
    contentCount: content === null ? null : content.length,
    contentItems: Object.freeze((content ?? []).slice(0, 8).map((value) => {
      const item = value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : null;
      const text = item !== null && typeof item.text === "string" ? item.text : null;
      return Object.freeze({ type: item !== null && typeof item.type === "string" ? item.type : null,
        textUtf8Bytes: text === null ? null : Buffer.byteLength(text, "utf8"),
        textSha256: text === null ? null : sha256(Buffer.from(text, "utf8")) });
    })),
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
          const responseValue = parseWireResponse(bytes);
          const evidence = Object.freeze({ schemaVersion: REAL_TRIO_NORTH_EVIDENCE_SCHEMA,
            requestSha256: sha256(payload), responseSha256: sha256(bytes), methodSha256: sha256(Buffer.from(input.method, "utf8")),
            requestBytes: payload.byteLength, responseBytes: bytes.byteLength, statusCode: response.statusCode ?? 0,
            jsonRpcErrorCode: jsonRpcErrorCode(responseValue), mcpSessionHeaderPresent: input.sessionId !== null });
          resolve(Object.freeze({ response: responseValue, evidence,
            sessionId: responseSessionId(response.headers["mcp-session-id"]) }));
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    operation.once("error", reject); operation.end(payload);
  });
}
