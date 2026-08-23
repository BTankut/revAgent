import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

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
  readonly effectiveMcpSessionId: string;
}

export class RealTrioNorthMcpError extends Error {
  public constructor(
    message: string,
    readonly evidence: RealTrioNorthWireEvidence | null,
  ) {
    super(message);
    this.name = "RealTrioNorthMcpError";
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
    private sessionId: string,
    private closed = false,
  ) {}

  public static async connect(input: {
    readonly endpoint: string;
    readonly certificateSha256: string;
    readonly credential: RealTrioNorthCredential;
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
    const issued = initialization.sessionId;
    if (issued === null || !SESSION_ID.test(issued)) {
      throw new RealTrioNorthMcpError("real trio MCP initialize did not issue a valid mcp-session-id", initialization.evidence);
    }
    const client = new RealTrioNorthMcpClient(endpoint, input.certificateSha256, input.credential, issued);
    await client.notification("notifications/initialized", Object.freeze({}));
    return client;
  }

  public get effectiveMcpSessionId(): string { return this.sessionId; }

  public async request(request: Readonly<Record<string, unknown>>): Promise<{ readonly response: unknown; readonly evidence: RealTrioNorthWireEvidence }> {
    this.assertOpen();
    const method = request.method;
    if (typeof method !== "string" || method === "initialize" || method === "notifications/initialized") {
      throw new Error("real trio MCP client only accepts post-initialize requests");
    }
    const result = await rawRequest({ endpoint: this.endpoint, certificateSha256: this.certificateSha256,
      credential: this.credential, sessionId: this.sessionId, method, payload: request });
    assertJsonRpcSuccess(result.response, method, result.evidence);
    return Object.freeze({ response: result.response, evidence: result.evidence });
  }

  public async toolCall(input: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>>; readonly requestId: string }): Promise<{ readonly content: Record<string, unknown>; readonly evidence: RealTrioNorthWireEvidence }> {
    const result = await this.request(Object.freeze({
      jsonrpc: "2.0", id: input.requestId, method: "tools/call",
      params: Object.freeze({ name: input.name, arguments: input.arguments }),
    }));
    return Object.freeze({ content: strictToolContent(result.response), evidence: result.evidence });
  }

  public async readResource(input: { readonly uri: string; readonly requestId: string }): Promise<{ readonly response: unknown; readonly evidence: RealTrioNorthWireEvidence }> {
    return await this.request(Object.freeze({ jsonrpc: "2.0", id: input.requestId,
      method: "resources/read", params: Object.freeze({ uri: input.uri }) }));
  }

  public close(): void { this.closed = true; this.sessionId = ""; }

  private async notification(method: string, params: Readonly<Record<string, unknown>>): Promise<void> {
    this.assertOpen();
    await rawRequest({ endpoint: this.endpoint, certificateSha256: this.certificateSha256,
      credential: this.credential, sessionId: this.sessionId, method, payload: Object.freeze({ jsonrpc: "2.0", method, params }) });
  }

  private assertOpen(): void { if (this.closed) throw new Error("real trio MCP client is closed"); }
}

export async function withRealTrioNorthMcpClient<T>(input: {
  readonly endpoint: string;
  readonly certificateSha256: string;
  readonly credential: RealTrioNorthCredential;
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
    throw new RealTrioNorthMcpError(`real trio MCP ${method} returned JSON-RPC error ${code ?? "invalid"}`, evidence ?? null);
  }
  if (!("result" in envelope)) throw new RealTrioNorthMcpError(`real trio MCP ${method} lacks result`, evidence ?? null);
}

/** Structured content is authoritative; legacy text is accepted only as one bounded JSON object. */
export function strictToolContent(response: unknown): Record<string, unknown> {
  const envelope = record(response, "real trio MCP response");
  const result = record(envelope.result, "real trio MCP response result");
  if ("structuredContent" in result) return record(result.structuredContent, "real trio MCP structured content");
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    throw new Error("real trio MCP tool result requires one fallback text content item");
  }
  const item = record(result.content[0], "real trio MCP fallback content");
  if (item.type !== "text" || typeof item.text !== "string" || item.text.length === 0 ||
      Buffer.byteLength(item.text, "utf8") > MAX_FALLBACK_TEXT_BYTES) {
    throw new Error("real trio MCP tool fallback content is invalid");
  }
  try { return record(JSON.parse(item.text) as unknown, "real trio MCP fallback JSON"); }
  catch { throw new Error("real trio MCP tool fallback text is not a JSON object"); }
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
            jsonRpcErrorCode: jsonRpcErrorCode(responseValue), effectiveMcpSessionId: input.sessionId ?? "issued_during_initialize" });
          const header = response.headers["mcp-session-id"];
          resolve(Object.freeze({ response: responseValue, evidence, sessionId: typeof header === "string" ? header : null }));
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    operation.once("error", reject); operation.end(payload);
  });
}
