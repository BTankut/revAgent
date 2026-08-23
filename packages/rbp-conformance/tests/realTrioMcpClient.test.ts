import { createServer } from "node:https";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createEphemeralLoopbackTlsIdentity } from "../src/ephemeralTlsIdentity.js";
import {
  RealTrioNorthMcpError,
  RealTrioNorthToolResultError,
  strictToolContent,
  withRealTrioNorthMcpClient,
} from "../src/realTrioMcpClient.js";

const credential = Object.freeze({ bearer: "test-only-bearer", audience: "https://127.0.0.1/mcp",
  credentialProvenance: "gateway_production_conformance" as const, identityContract: "revagent.auth-context/v1" as const });

interface RecordedRequest { readonly method: string; readonly authorization: string | undefined; readonly session: string | undefined; readonly hasId: boolean; }
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(async (close) => await close())); });

async function testServer(input: { readonly mode?: "ok" | "tool_error" | "tool_is_error" | "tool_bad_text"; readonly initializeSessionHeader?: string } = {}): Promise<{ readonly endpoint: string; readonly certificateSha256: string; readonly requests: RecordedRequest[] }> {
  const root = mkdtempSync(path.join(tmpdir(), "wp12-mcp-client-"));
  mkdirSync(path.join(root, "tls-root"));
  const tls = createEphemeralLoopbackTlsIdentity(realpathSync(path.join(root, "tls-root")));
  const requests: RecordedRequest[] = [];
  const server = createServer({ cert: readFileSync(tls.certificatePath), key: readFileSync(tls.privateKeyPath) }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method?: unknown; id?: unknown };
      const method = typeof body.method === "string" ? body.method : "";
      requests.push(Object.freeze({ method, authorization: request.headers.authorization,
        session: typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined,
        hasId: "id" in body }));
      const result = method === "initialize"
        ? { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }
        : input.mode === "tool_error" && method === "tools/call"
          ? { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "redacted" } }
          : input.mode === "tool_is_error" && method === "tools/call"
            ? { jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "{\"redacted\":true}" }] } }
            : input.mode === "tool_bad_text" && method === "tools/call"
              ? { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "not-json" }] } }
          : { jsonrpc: "2.0", id: body.id, result: method === "tools/call"
            ? { structuredContent: { state: "completed", requestId: "server-request" } } : {} };
      response.writeHead(200, { "content-type": "application/json", ...(method === "initialize" && input.initializeSessionHeader !== undefined ? { "mcp-session-id": input.initializeSessionHeader } : {}) });
      response.end(JSON.stringify(result));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test TLS server did not bind TCP");
  return Object.freeze({ endpoint: `https://127.0.0.1:${address.port}`, certificateSha256: tls.serverCertificateSha256, requests });
}

describe("strict real-trio Streamable HTTP MCP client", () => {
  it("uses the actual stateless Streamable HTTP ordering with no MCP session header", async () => {
    const server = await testServer();
    await withRealTrioNorthMcpClient({ ...server, credential }, async (client) => {
      expect(client.usesMcpSessionHeader).toBe(false);
      const result = await client.toolCall({ name: "core.ui.state", arguments: {}, requestId: "tool-1" });
      expect(result.content).toEqual({ state: "completed", requestId: "server-request" });
      expect(result.evidence.methodSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(result.evidence.jsonRpcErrorCode).toBeNull();
    });
    expect(server.requests).toEqual([
      { method: "initialize", authorization: "Bearer test-only-bearer", session: undefined, hasId: true },
      { method: "notifications/initialized", authorization: "Bearer test-only-bearer", session: undefined, hasId: false },
      { method: "tools/call", authorization: "Bearer test-only-bearer", session: undefined, hasId: true },
    ]);
  });

  it("rejects an unexpected Gateway session header unless an explicit identity binding matches", async () => {
    const server = await testServer({ initializeSessionHeader: "gateway-issued-session-7" });
    await expect(withRealTrioNorthMcpClient({ ...server, credential }, async () => undefined))
      .rejects.toThrow(/unexpected mcp-session-id/u);
    await expect(withRealTrioNorthMcpClient({ ...server, credential,
      expectedMcpSessionId: "different-bound-session" }, async () => undefined))
      .rejects.toThrow(/unexpected mcp-session-id/u);
  });

  it("retains only bounded wire and shape evidence when Gateway returns a JSON-RPC error", async () => {
    const server = await testServer({ mode: "tool_error" });
    await expect(withRealTrioNorthMcpClient({ ...server, credential }, async (client) =>
      await client.toolCall({ name: "core.ui.state", arguments: {}, requestId: "tool-error" }),
    )).rejects.toMatchObject({ name: "RealTrioNorthMcpError", evidence: expect.objectContaining({ jsonRpcErrorCode: -32001, methodSha256: expect.any(String) }), toolResultEvidence: expect.objectContaining({ resultKeySet: null, contentCount: null }) } satisfies Partial<RealTrioNorthMcpError>);
  });

  it("rejects isError before fallback parsing and retains bounded tool-result evidence", async () => {
    const server = await testServer({ mode: "tool_is_error" });
    await expect(withRealTrioNorthMcpClient({ ...server, credential }, async (client) =>
      await client.toolCall({ name: "core.ui.state", arguments: {}, requestId: "tool-is-error" }),
    )).rejects.toMatchObject({ name: "RealTrioNorthToolResultError", evidence: {
      httpStatus: 200, isError: true, contentCount: 1,
      contentItems: [{ type: "text", textUtf8Bytes: 17, textSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) }],
    } } satisfies Partial<RealTrioNorthToolResultError>);
  });

  it("retains text size and hash, but never plain fallback text, when fallback parsing fails", async () => {
    const server = await testServer({ mode: "tool_bad_text" });
    await expect(withRealTrioNorthMcpClient({ ...server, credential }, async (client) =>
      await client.toolCall({ name: "core.ui.state", arguments: {}, requestId: "tool-bad-text" }),
    )).rejects.toMatchObject({ name: "RealTrioNorthToolResultError", evidence: {
      resultKeySet: ["content"], isError: null, contentCount: 1,
      contentItems: [{ type: "text", textUtf8Bytes: 8, textSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) }],
    } } satisfies Partial<RealTrioNorthToolResultError>);
  });

  it("requires matching structured and plain-text objects, otherwise fails closed", () => {
    expect(strictToolContent({ result: { structuredContent: { ok: true }, content: [{ type: "text", text: "{\"ok\":true}" }] } })).toEqual({ ok: true });
    expect(strictToolContent({ result: { content: [{ type: "text", text: "{\"ok\":true}" }] } })).toEqual({ ok: true });
    for (const value of [
      { result: { structuredContent: [] } }, { result: { content: [] } },
      { result: { isError: true, content: [{ type: "text", text: "not-json" }] } },
      { result: { structuredContent: { ok: true }, content: [{ type: "text", text: "{\"ok\":false}" }] } },
      { result: { content: [{ type: "image", text: "{}" }] } },
      { result: { content: [{ type: "text", text: "[]" }] } },
      { result: { content: [{ type: "text", text: "not-json" }] } },
    ]) expect(() => strictToolContent(value)).toThrow();
  });
});
