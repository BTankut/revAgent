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

async function testServer(input: {
  readonly mode?: "ok" | "tool_error" | "tool_is_error" | "tool_bad_text";
  readonly toolCallResult?: Readonly<Record<string, unknown>>;
  readonly initializeSessionHeader?: string;
  readonly notificationSessionHeader?: string;
  readonly emptyResponseMethod?: "initialize" | "notifications/initialized" | "tools/call";
  readonly emptyResponseStatus?: 200 | 202 | 204;
  readonly notificationResponseStatus?: 200 | 202 | 204;
} = {}): Promise<{ readonly endpoint: string; readonly certificateSha256: string; readonly requests: RecordedRequest[] }> {
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
            ? input.toolCallResult ?? { structuredContent: { state: "completed", requestId: "server-request" } } : {} };
      const empty = method === input.emptyResponseMethod;
      response.writeHead(empty ? input.emptyResponseStatus ?? 204 :
        method === "notifications/initialized" ? input.notificationResponseStatus ?? 200 : 200, {
        "content-type": "application/json",
        ...(method === "initialize" && input.initializeSessionHeader !== undefined ? { "mcp-session-id": input.initializeSessionHeader } : {}),
        ...(method === "notifications/initialized" && input.notificationSessionHeader !== undefined ? { "mcp-session-id": input.notificationSessionHeader } : {}),
      });
      response.end(empty ? undefined : JSON.stringify(result));
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

  it.each([202, 204] as const)("accepts a zero-byte %i initialized notification only", async (status) => {
    const server = await testServer({ emptyResponseMethod: "notifications/initialized", emptyResponseStatus: status });
    await withRealTrioNorthMcpClient({ ...server, credential }, async (client) => {
      await expect(client.toolCall({ name: "core.ui.state", arguments: {}, requestId: `notification-${status}` }))
        .resolves.toMatchObject({ content: { state: "completed" } });
    });
  });

  it.each([202, 204] as const)("accepts a zero-byte %i initialized notification with an exact bound session", async (status) => {
    const server = await testServer({ initializeSessionHeader: "bound-session", notificationSessionHeader: "bound-session",
      emptyResponseMethod: "notifications/initialized", emptyResponseStatus: status });
    await expect(withRealTrioNorthMcpClient({ ...server, credential, expectedMcpSessionId: "bound-session" }, async () => undefined))
      .resolves.toBeUndefined();
  });

  it("rejects a mismatched session header on an otherwise permitted empty notification in bound mode", async () => {
    const server = await testServer({ initializeSessionHeader: "bound-session", notificationSessionHeader: "other-session",
      emptyResponseMethod: "notifications/initialized", emptyResponseStatus: 204 });
    await expect(withRealTrioNorthMcpClient({ ...server, credential, expectedMcpSessionId: "bound-session" }, async () => undefined))
      .rejects.toThrow(/mcp-session-id/u);
  });

  it("rejects zero-byte initialize and tool responses even when their status is otherwise successful", async () => {
    const initialize = await testServer({ emptyResponseMethod: "initialize", emptyResponseStatus: 200 });
    await expect(withRealTrioNorthMcpClient({ ...initialize, credential }, async () => undefined))
      .rejects.toThrow(/response is empty/u);
    const tool = await testServer({ emptyResponseMethod: "tools/call", emptyResponseStatus: 200 });
    await expect(withRealTrioNorthMcpClient({ ...tool, credential }, async (client) =>
      await client.toolCall({ name: "core.ui.state", arguments: {}, requestId: "empty-tool" }),
    )).rejects.toThrow(/response is empty/u);
  });

  it("rejects notification non-200 statuses unless they are empty 202 or 204, and still checks its session header", async () => {
    const nonEmpty = await testServer({ notificationResponseStatus: 202 });
    await expect(withRealTrioNorthMcpClient({ ...nonEmpty, credential }, async () => undefined))
      .rejects.toThrow(/unexpected HTTP status 202/u);
    // A malformed session header on a permitted empty status must still fail
    // before any subsequent tool dispatch.
    const header = await testServer({ emptyResponseMethod: "notifications/initialized", emptyResponseStatus: 204,
      notificationSessionHeader: "unexpected-session" });
    await expect(withRealTrioNorthMcpClient({ ...header, credential }, async () => undefined))
      .rejects.toThrow(/mcp-session-id/u);
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
    )).rejects.toMatchObject({ name: "RealTrioNorthMcpError", evidence: expect.objectContaining({ jsonRpcErrorCode: -32001, methodSha256: expect.any(String) }), toolResultEvidence: expect.objectContaining({ resultKeyPresence: null, contentCount: null }) } satisfies Partial<RealTrioNorthMcpError>);
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
      resultKeyPresence: { isError: false, structuredContent: false, content: true }, isError: null, contentCount: 1,
      contentItems: [{ type: "text", textUtf8Bytes: 8, textSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) }],
    } } satisfies Partial<RealTrioNorthToolResultError>);
  });

  it("fails closed on isError before fallback parsing while retaining only fixed diagnostic classifications", async () => {
    const secret = "do-not-retain-".repeat(20);
    const server = await testServer({ toolCallResult: {
      isError: true,
      structuredContent: {
        state: "completed",
        reason: "result_delivery_unavailable",
        code: "journal_indeterminate",
        errorCode: "unknown",
        deliveryOutcome: "result_delivery_unavailable",
        error: { code: "unknown", message: secret, payload: { secret } },
        message: secret,
        arbitrary: secret,
      },
      // Deliberately invalid text proves the isError path never falls through
      // to fallback parsing or structured/text equality.
      content: [{ type: "text", text: "not-json" }],
    } });
    await expect(withRealTrioNorthMcpClient({ ...server, credential }, async (client) =>
      await client.toolCall({ name: "core.ui.state", arguments: {}, requestId: "diagnostic-is-error" }),
    )).rejects.toMatchObject({ name: "RealTrioNorthToolResultError", evidence: {
      isError: true,
      resultKeyPresence: { isError: true, structuredContent: true, content: true },
      contentCount: 1,
      diagnostic: {
        source: "structured_content",
        structuredContentPresent: true, structuredContentObject: true,
        fallbackTextPresent: true, fallbackTextObject: false,
        statePresent: true, reasonPresent: true, codePresent: true, errorCodePresent: true,
        nestedErrorCodePresent: true, deliveryOutcomePresent: true,
        state: "completed", reason: "result_delivery_unavailable", code: "journal_indeterminate",
        errorCode: "unknown", nestedErrorCode: "unknown", deliveryOutcome: "result_delivery_unavailable",
      },
    } } satisfies Partial<RealTrioNorthToolResultError>);
  });

  it("keeps post-dispatch delivery diagnostics allowlisted while isError remains fatal", async () => {
    const server = await testServer({ toolCallResult: {
      isError: true,
      structuredContent: {
        state: "failed",
        error: { code: "result_delivery_unavailable" },
        delivery: { phase: "post_dispatch", mutationDisposition: "not_reclassified" },
      },
      content: [{ type: "text", text: JSON.stringify({
        state: "failed",
        error: { code: "result_delivery_unavailable" },
        delivery: { phase: "post_dispatch", mutationDisposition: "not_reclassified" },
      }) }],
    } });
    await expect(withRealTrioNorthMcpClient({ ...server, credential }, async (client) =>
      await client.toolCall({ name: "core.ui.state", arguments: {}, requestId: "post-dispatch-diagnostic" }),
    )).rejects.toMatchObject({ name: "RealTrioNorthToolResultError", evidence: {
      isError: true,
      diagnostic: {
        state: "failed",
        nestedErrorCode: "result_delivery_unavailable",
        deliveryPhasePresent: true,
        mutationDispositionPresent: true,
        deliveryPhase: "post_dispatch",
        mutationDisposition: "not_reclassified",
      },
    } } satisfies Partial<RealTrioNorthToolResultError>);
  });

  it("classifies only allowlisted short fallback diagnostic enums and redacts malicious values", async () => {
    const server = await testServer({ toolCallResult: {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({
        reason: "result_delivery_unavailable", code: "journal_indeterminate", errorCode: "unknown",
        state: "x".repeat(65), deliveryOutcome: { raw: "not-an-enum" },
        error: { code: "still-not-an-enum", message: "never-retain" }, message: "never-retain",
      }) }],
    } });
    await expect(withRealTrioNorthMcpClient({ ...server, credential }, async (client) =>
      await client.toolCall({ name: "core.ui.state", arguments: {}, requestId: "fallback-diagnostic-is-error" }),
    )).rejects.toMatchObject({ name: "RealTrioNorthToolResultError", evidence: {
      diagnostic: {
        source: "fallback_text", structuredContentPresent: false, structuredContentObject: false,
        fallbackTextPresent: true, fallbackTextObject: true,
        reason: "result_delivery_unavailable", code: "journal_indeterminate", errorCode: "unknown",
        state: "unclassified", deliveryOutcome: "unclassified", nestedErrorCode: "unclassified",
      },
    } } satisfies Partial<RealTrioNorthToolResultError>);
  });

  it("requires matching structured and plain-text objects, otherwise fails closed", () => {
    expect(strictToolContent({ result: { structuredContent: { ok: true }, content: [{ type: "text", text: "{\"ok\":true}" }] } })).toEqual({ ok: true });
    expect(strictToolContent({ result: { content: [{ type: "text", text: "{\"ok\":true}" }] } })).toEqual({ ok: true });
    for (const value of [
      { result: { structuredContent: [] } }, { result: { content: [] } },
      { result: { isError: true, content: [{ type: "text", text: "not-json" }] } },
      { result: { isError: "false", structuredContent: { ok: true } } },
      { result: { isError: { value: false }, structuredContent: { ok: true } } },
      { result: { isError: null, structuredContent: { ok: true } } },
      { result: { structuredContent: { ok: true }, content: [{ type: "text", text: "{\"ok\":false}" }] } },
      { result: { content: [{ type: "image", text: "{}" }] } },
      { result: { content: [{ type: "text", text: "[]" }] } },
      { result: { content: [{ type: "text", text: "not-json" }] } },
    ]) expect(() => strictToolContent(value)).toThrow();
  });
});
