import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  callRealTrioNorthTool,
  realTrioNorthToolForCase,
} from "../src/realTrioCaseDriver.js";
import {
  withRealTrioNorthMcpClient,
  type RealTrioNorthMcpClient,
} from "../src/realTrioMcpClient.js";
import { runRealTrioCli } from "../src/realTrioCli.js";
import {
  buildRealTrioRuntimeFixture,
  rethrowRealTrioC38Failure,
  startRealTrioRuntimeFixture,
} from "./realTrioRuntimeFixture.js";

const AUDIT_RSID_HASH = /^sha256:[0-9a-f]{64}$/u;
const AUDIT_ROUTE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CURRENT_ROUTE_IDENTITY_FIELDS = [
  "processEpoch",
  "rsidHash",
  "observedSequence",
  "contextDigest",
  "routeDigest",
  "recordDigest",
  "sessionBindingDigest",
  "connectionDigest",
  "sessionRecordVersion",
] as const;

function assertAcceptedDocumentContextUpdate(audit: unknown): void {
  expect(audit).toMatchObject({ ok: true, action: "read_real_case_audit" });
  expect(audit).toHaveProperty("documentContextUpdates");
  const updates = (audit as { readonly documentContextUpdates?: unknown }).documentContextUpdates;
  expect(updates).toHaveLength(1);
  const update = (updates as readonly unknown[])[0];
  const currentRoute = (audit as { readonly documentContextCurrentRoute?: unknown })
    .documentContextCurrentRoute;
  expect(update).toMatchObject({
    contractVersion: "revagent.wp12-document-context-audit/v1",
    event: "gateway.doc_context_update_observation",
    stage: "accepted",
    rsidHash: expect.stringMatching(AUDIT_RSID_HASH),
    routeDigest: expect.stringMatching(AUDIT_ROUTE_DIGEST),
  });
  expect(currentRoute).toMatchObject({
    rsidHash: expect.stringMatching(AUDIT_RSID_HASH),
    routeDigest: expect.stringMatching(AUDIT_ROUTE_DIGEST),
  });
  expect(update).not.toHaveProperty("rsid");
  expect(update).not.toHaveProperty("rsidDigest");
  const updateRecord = update as Record<string, unknown>;
  const currentRouteRecord = currentRoute as Record<string, unknown>;
  for (const field of CURRENT_ROUTE_IDENTITY_FIELDS) {
    expect(updateRecord[field]).toBe(currentRouteRecord[field]);
  }
}

describe.sequential("WP-12 direct real trio runtime fixture", () => {
  it.each(["wss", "streamable_http_sse"] as const)(
    "runs C38's public core UI probe against the real %s Worker binding",
    async (binding) => {
      buildRealTrioRuntimeFixture();
      const evidenceDirectory = mkdtempSync(path.join(tmpdir(), `wp12-real-${binding}-`));
      const launched = await runRealTrioCli(
        ["real-trio", binding],
        async (selectedBinding) => await startRealTrioRuntimeFixture(selectedBinding, { evidenceDirectory }),
      );
      const runtime = launched.result;
      try {
        const tool = realTrioNorthToolForCase("O1-C38");
        const result = await callRealTrioNorthTool({
          endpoint: runtime.endpoint,
          certificateSha256: runtime.certificateSha256,
          credential: runtime.credential,
          dispatchGuard: async () => await runtime.verifyNorthDispatchFence(),
          call: { toolName: tool.toolName, args: {}, requestId: `wp12-c38-${binding}` },
        });
        expect(result.state).toBe("completed");
        expect(result.commit).toBeNull();
        const audit = await runtime.supervisor.readRealCaseAudit();
        assertAcceptedDocumentContextUpdate(audit);
      } catch (error) {
        rethrowRealTrioC38Failure({ evidenceDirectory, binding, error });
      } finally {
        await runtime.stop();
      }
    },
    240_000,
  );

  it.each(["wss", "streamable_http_sse"] as const)(
    "drives C39 through the public recovery tool after one genuine omitted %s replay",
    async (binding) => {
      buildRealTrioRuntimeFixture();
      const evidenceDirectory = mkdtempSync(path.join(tmpdir(), `wp12-c39-${binding}-`));
      const launched = await runRealTrioCli(
        ["real-trio", binding],
        async (selectedBinding) => await startRealTrioRuntimeFixture(selectedBinding, { evidenceDirectory }),
      );
      const runtime = launched.result;
      try {
        await withRealTrioNorthMcpClient({
          endpoint: runtime.endpoint,
          certificateSha256: runtime.certificateSha256,
          credential: runtime.credential,
        }, async (client) => {
          // D0 suppresses the normal terminal only after the real C# journal
          // committed it. The public origin call therefore need not return a
          // successful MCP tool result; fixture provenance is the sole origin
          // observation and does not manufacture a replay/result/reference.
          await runtime.verifyNorthDispatchFence();
          await client.toolCall({
            name: "conformance.fixture.c39_multifile",
            arguments: {
              scenario: "valid_multifile", fileCount: 1, bytesPerFile: 1024,
              contentType: "application/octet-stream",
            },
            requestId: `wp12-c39-origin-${binding}`,
          }).catch(() => undefined);

          const origin = await waitForC39Origin(runtime, 45_000);
          const recovery = await waitForC39Recovery(client, runtime, origin, binding, 45_000);
          const result = recovery.content.result as Record<string, unknown>;
          expect(result).toMatchObject({ kind: "result_ref", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
          const uri = result.uri;
          expect(typeof uri).toBe("string");
          await expect(client.readResource({ uri: uri as string, requestId: `wp12-c39-owner-read-${binding}` }))
            .resolves.toMatchObject({ response: expect.any(Object) });

          // A retry is the same public fixed-argument tool, never a private
          // replay control; it must not call the attested fixture again.
          const retry = await client.toolCall({
            name: realTrioNorthToolForCase("O1-C39").toolName,
            arguments: { origin_invocation_id: origin.requestId, expected_result_digest: origin.responseDigest },
            requestId: `wp12-c39-retry-${binding}`,
          });
          expect(retry.content).toMatchObject({ state: "completed" });
          expect(await c39ExecutionCount(runtime, origin.requestId)).toBe(1);

          await runtime.supervisor.restartBridge();
          await runtime.verifyNorthDispatchFence();
          await expect(client.toolCall({
            name: realTrioNorthToolForCase("O1-C39").toolName,
            arguments: { origin_invocation_id: origin.requestId, expected_result_digest: origin.responseDigest },
            requestId: `wp12-c39-restart-retry-${binding}`,
          })).resolves.toMatchObject({ content: { state: "completed" } });
          expect(await c39ExecutionCount(runtime, origin.requestId)).toBe(1);

          await withRealTrioNorthMcpClient({
            endpoint: runtime.endpoint,
            certificateSha256: runtime.certificateSha256,
            credential: runtime.credential,
          }, async (foreign) => {
            await expect(foreign.readResource({ uri: uri as string, requestId: `wp12-c39-foreign-read-${binding}` }))
              .rejects.toThrow();
          });
        });
        const cleanup = await runtime.supervisor.fixtureControl("snapshot_evidence");
        expect(cleanup).toMatchObject({ openSocketCount: 0, pendingStalls: [] });
      } catch (error) {
        rethrowRealTrioC38Failure({ evidenceDirectory, binding, error });
      } finally {
        await runtime.stop();
      }
    },
    300_000,
  );
});

interface C39OriginProvenance {
  readonly requestId: string;
  readonly responseDigest: `sha256:${string}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

async function c39ExecutionCount(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  requestId: string,
): Promise<number> {
  const snapshot = object(await runtime.supervisor.fixtureControl("snapshot_evidence"));
  const counts = Array.isArray(snapshot?.executionCounts) ? snapshot.executionCounts : [];
  const row = counts.map(object).find((entry) => entry?.requestId === requestId);
  return typeof row?.count === "number" ? row.count : 0;
}

async function waitForC39Origin(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  timeoutMs: number,
): Promise<C39OriginProvenance> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = object(await runtime.supervisor.fixtureControl("snapshot_evidence"));
    const rows = Array.isArray(snapshot?.c39OriginResponses) ? snapshot.c39OriginResponses : [];
    const candidates = rows.map(object).filter((row): row is Record<string, unknown> =>
      typeof row?.requestId === "string" && typeof row.responseDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(row.responseDigest),
    );
    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      const requestId = candidate.requestId as string;
      if (await c39ExecutionCount(runtime, requestId) === 1) {
        return Object.freeze({ requestId, responseDigest: candidate.responseDigest as `sha256:${string}` });
      }
    }
    if (Date.now() >= deadline) throw new Error("real C39 fixture origin provenance did not become available");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForC39Recovery(
  client: RealTrioNorthMcpClient,
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  origin: C39OriginProvenance,
  binding: "wss" | "streamable_http_sse",
  timeoutMs: number,
): Promise<{ readonly content: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await runtime.verifyNorthDispatchFence();
    try {
      const result = await client.toolCall({
        name: realTrioNorthToolForCase("O1-C39").toolName,
        arguments: { origin_invocation_id: origin.requestId, expected_result_digest: origin.responseDigest },
        requestId: `wp12-c39-recovery-${binding}`,
      });
      if (result.content.state === "completed") return result;
    } catch { /* The public tool returns a uniform unavailable result until the replay is durable. */ }
    if (Date.now() >= deadline) throw new Error("real C39 public recovery did not complete");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
}
