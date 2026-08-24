import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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
        async (selectedBinding) => await startRealTrioRuntimeFixture(selectedBinding, {
          evidenceDirectory, c39D0PostWriteFault: true,
        }),
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
          const normalOriginSuppressed = await c39NormalOriginIsSuppressed(client, {
            name: "conformance.fixture.c39_multifile",
            arguments: {
              scenario: "valid_multifile", fileCount: 1, bytesPerFile: 1024,
              contentType: "application/octet-stream",
            },
            requestId: `wp12-c39-origin-${binding}`,
          });
          expect(normalOriginSuppressed).toBe(true);

          // One fully drained fixture snapshot proves D0 provenance/count;
          // continuation pages release the fixture slot before D1 polling.
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
          const originEvidence = await readCompleteFixtureEvidence(runtime);
          const origin = c39OriginFromEvidence(originEvidence);
          expect(origin.requestId).toMatch(UUID_V7);
          const recovery = await waitForC39Recovery(client, runtime, origin, binding, 45_000);
          const result = recovery.content.result as Record<string, unknown>;
          expect(result).toMatchObject({ kind: "result_ref", digest: expect.stringMatching(SHA256) });
          expect(result).not.toHaveProperty("payload");
          expect(result).not.toHaveProperty("result");
          const uri = result.uri;
          expect(typeof uri).toBe("string");
          const ownerRead = await client.readResource({ uri: uri as string, requestId: `wp12-c39-owner-read-${binding}` });
          expect(ownerRead).toMatchObject({ response: expect.any(Object) });
          const ownerReadSucceeded = object(ownerRead.response) !== null;
          expect(ownerReadSucceeded).toBe(true);

          let samePrincipalDenied = false;
          const rebound = await runtime.issueReboundNorthCredential();
          assertDistinctBoundSessions(runtime.credential, rebound, "same-principal rebound");
          expect(rebound.bearer).toBe(runtime.credential.bearer);
          await withRealTrioNorthMcpClient({
            endpoint: runtime.endpoint,
            certificateSha256: runtime.certificateSha256,
            credential: rebound,
          }, async (samePrincipalNewSession) => {
            const resourceDenied = await c39ResourceReadDenied(samePrincipalNewSession, {
              uri: uri as string, requestId: `wp12-c39-rebound-read-${binding}`,
            });
            const recoveryDenied = await expectC39RecoveryDenied(samePrincipalNewSession, origin, binding, "rebound");
            expect(resourceDenied && recoveryDenied).toBe(true);
            samePrincipalDenied = resourceDenied && recoveryDenied;
          });

          let foreignDenied = false;
          const foreignCredential = await runtime.issueForeignNorthCredential();
          assertDistinctBoundSessions(runtime.credential, foreignCredential, "foreign principal");
          expect(foreignCredential.bearer).not.toBe(runtime.credential.bearer);
          await withRealTrioNorthMcpClient({
            endpoint: runtime.endpoint,
            certificateSha256: runtime.certificateSha256,
            credential: foreignCredential,
          }, async (foreign) => {
            const resourceDenied = await c39ResourceReadDenied(foreign, {
              uri: uri as string, requestId: `wp12-c39-foreign-read-${binding}`,
            });
            const recoveryDenied = await expectC39RecoveryDenied(foreign, origin, binding, "foreign");
            expect(resourceDenied && recoveryDenied).toBe(true);
            foreignDenied = resourceDenied && recoveryDenied;
          });

          // A retry is the same public fixed-argument tool, never a private
          // replay control; it must not call the attested fixture again.
          const retry = await client.toolCall({
            name: realTrioNorthToolForCase("O1-C39").toolName,
            arguments: { origin_invocation_id: origin.requestId, expected_result_digest: origin.responseDigest },
            requestId: `wp12-c39-retry-${binding}`,
          });
          expect(retry.content).toMatchObject({ state: "completed" });
          expect(executionCount(originEvidence, origin.requestId)).toBe(1);

          const observed = await waitForObservedC39Recovery(
            runtime, origin, result.digest as `sha256:${string}`, 45_000,
          );

          await runtime.supervisor.restartBridge();
          await runtime.verifyNorthDispatchFence();
          const restartResourceDenied = await c39ResourceReadDenied(client, {
            uri: uri as string, requestId: `wp12-c39-post-rebind-read-${binding}`,
          });
          const restartRecoveryDenied = await expectC39RecoveryDenied(client, origin, binding, "restart");
          const bindingDriftDenied = restartResourceDenied && restartRecoveryDenied;
          expect(bindingDriftDenied).toBe(true);
          const finalEvidence = await readCompleteFixtureEvidence(runtime);
          expect(executionCount(finalEvidence, origin.requestId)).toBe(1);

          const originExecutionCount = executionCount(finalEvidence, origin.requestId);
          expect(originExecutionCount).toBe(1);
          const cleanup = finalEvidence;
          expect(cleanup).toMatchObject({ openSocketCount: 0, pendingStalls: [] });
          await runtime.stop();
          writeC39SuccessSummary({
            binding,
            origin,
            originExecutionCount,
            observed,
            normalOriginSuppressed,
            client: Object.freeze({
              ownerReadSucceeded,
              samePrincipalDenied,
              foreignDenied,
              bindingDriftDenied,
            }),
            attestation: runtime.supervisor.attestation,
          });
        });
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

interface ObservedC39Recovery {
  readonly omittedReplayObserved: boolean;
  readonly exactCarrierAckOrder: boolean;
  readonly oneCarrierIdentity: boolean;
  readonly restartResendExact: boolean;
  readonly protectedC2Completed: boolean;
  readonly resultRefDigest: `sha256:${string}`;
  readonly partialCount: number;
  readonly workerEventCount: number;
}

function c39AuditHash(domain: "origin" | "recovery", value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`revagent/c39-audit/${domain}\0`, "utf8").update(value, "utf8").digest("hex")}`;
}

function c39ArtifactDirectory(binding: "wss" | "streamable_http_sse"): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return path.join(repoRoot, ".orchestration", "artifacts", "WP-12", "C39", "e-real-trio", binding);
}

function writeC39SuccessSummary(input: {
  readonly binding: "wss" | "streamable_http_sse";
  readonly origin: C39OriginProvenance;
  readonly originExecutionCount: number;
  readonly observed: ObservedC39Recovery;
  readonly normalOriginSuppressed: boolean;
  readonly client: Readonly<{
    readonly ownerReadSucceeded: boolean;
    readonly samePrincipalDenied: boolean;
    readonly foreignDenied: boolean;
    readonly bindingDriftDenied: boolean;
  }>;
  readonly attestation: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>["supervisor"]["attestation"];
}): void {
  const output = c39ArtifactDirectory(input.binding);
  mkdirSync(output, { recursive: true });
  const components = input.attestation.components.map((component) => Object.freeze({
    componentId: component.componentId,
    executableSha256: component.executableSha256,
    stdoutSha256: component.stdoutSha256,
    stderrSha256: component.stderrSha256,
    exitCode: component.exitCode,
  }));
  const summary = Object.freeze({
    schemaVersion: "revagent.wp12-c39-real-trio-success/v2",
    binding: input.binding,
    components,
    buildDigests: Object.freeze({
      csharpPublishSha256: input.attestation.csharpPublishSha256,
      gatewayBuildSha256: input.attestation.gatewayBuildSha256,
      fixtureBuildSha256: input.attestation.fixtureBuildSha256,
    }),
    counts: Object.freeze({
      originExecutionCount: input.originExecutionCount,
      partialCount: input.observed.partialCount,
      workerEventCount: input.observed.workerEventCount,
      originDigestPresent: SHA256.test(input.origin.responseDigest),
    }),
    digests: Object.freeze({
      originDigest: input.origin.responseDigest,
      resultRefDigest: input.observed.resultRefDigest,
    }),
    assertions: Object.freeze({
      normalOriginSuppressed: input.normalOriginSuppressed,
      omittedReplayObserved: input.observed.omittedReplayObserved,
      exactCarrierAckOrder: input.observed.exactCarrierAckOrder,
      oneCarrierIdentity: input.observed.oneCarrierIdentity,
      restartResendExact: input.observed.restartResendExact,
      encryptedResultReferenceOwnerRead: input.observed.protectedC2Completed && input.client.ownerReadSucceeded,
      samePrincipalOtherSessionDenied: input.client.samePrincipalDenied,
      foreignPrincipalDenied: input.client.foreignDenied,
      bindingDriftDenied: input.client.bindingDriftDenied,
    }),
  });
  const temporary = path.join(output, "summary.json.tmp");
  const destination = path.join(output, "summary.json");
  writeFileSync(temporary, `${JSON.stringify(summary)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, destination);
}

function objectArray(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return Object.freeze(value.map((entry) => {
    const row = object(entry);
    if (row === null) throw new Error(`${label} contains a non-object`);
    return row;
  }));
}

function observedC39Recovery(
  audit: Record<string, unknown>,
  worker: Awaited<ReturnType<Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>["supervisor"]["readRecoveryCarrierObservations"]>>,
  origin: C39OriginProvenance,
  resultRefDigest: `sha256:${string}`,
): ObservedC39Recovery | null {
  const recovery = object(audit.c39Recovery);
  if (recovery === null || recovery.status !== "joined") return null;
  const rows = objectArray(recovery.rows, "C39 Gateway audit rows");
  const originIdHash = c39AuditHash("origin", origin.requestId);
  const matches = rows.filter((row) => row.originIdHash === originIdHash && row.originDigest === origin.responseDigest);
  if (matches.length !== 1) throw new Error("C39 Gateway audit has missing or duplicate origin correlation");
  const row = matches[0]!;
  if (typeof row.recoveryIdHash !== "string" || !SHA256.test(row.recoveryIdHash) ||
      row.resultRefDigest !== resultRefDigest || !SHA256.test(row.resultRefDigest)) {
    throw new Error("C39 Gateway audit has an invalid recovery or result-reference digest");
  }
  const partials = objectArray(row.partials, "C39 Gateway audit partials");
  if (partials.length < 1) throw new Error("C39 Gateway audit has no partial carrier evidence");
  let previousSequence = 0;
  for (const [index, partial] of partials.entries()) {
    if (partial.chunkIndex !== index || !Number.isSafeInteger(partial.seq) || Number(partial.seq) <= previousSequence ||
        typeof partial.plainDigest !== "string" || !SHA256.test(partial.plainDigest) || partial.state !== "active") {
      throw new Error("C39 Gateway audit has a carrier partial gap, duplicate, or digest mismatch");
    }
    previousSequence = Number(partial.seq);
  }
  const terminal = object(row.terminal);
  if (terminal === null || !Number.isSafeInteger(terminal.seq) || Number(terminal.seq) <= previousSequence ||
      terminal.originDigest !== origin.responseDigest || terminal.state !== "completed") {
    throw new Error("C39 Gateway audit terminal is not coherent with the exact origin");
  }
  const carrierHash = row.recoveryIdHash as `sha256:${string}`;
  const oneCarrierIdentity = worker.length > 0 && worker.every((entry) => entry.hashedRecoveryId === carrierHash);
  if (!oneCarrierIdentity) {
    throw new Error("C39 Worker IPC has missing or cross-carrier observations");
  }
  const materialized = worker.filter((entry) => entry.phase === "materialized");
  const writes = worker.filter((entry) => entry.phase === "write");
  const acknowledgements = worker.filter((entry) => entry.phase === "ack");
  if (materialized.length < 1 || new Set(worker.map((entry) => entry.ordinal)).size !== worker.length ||
      worker.some((entry, index) => index > 0 && entry.ordinal <= worker[index - 1]!.ordinal)) {
    throw new Error("C39 Worker IPC has duplicate or unordered observation ordinals");
  }
  const expectedSequences = [...partials.map((partial) => Number(partial.seq)), Number(terminal.seq)];
  const exactCarrierAckOrder = expectedSequences.every((sequence) => {
    const sent = writes.filter((entry) => entry.sequence === sequence);
    const acked = acknowledgements.filter((entry) => entry.sequence === sequence);
    const finalWrite = sent.at(-1);
    return sent.length >= 1 && acked.length === 1 && finalWrite !== undefined &&
      acked[0]!.ordinal > finalWrite.ordinal &&
      acked[0]!.outerDigest === finalWrite.outerDigest;
  }) && acknowledgements.length === expectedSequences.length;
  if (!exactCarrierAckOrder) {
    throw new Error("C39 Worker IPC did not prove one ordered acknowledgement per carrier sequence");
  }
  const omittedReplayObserved = row.originDigest === origin.responseDigest &&
    terminal.originDigest === origin.responseDigest && terminal.state === "completed";
  if (!omittedReplayObserved) {
    throw new Error("C39 Gateway audit did not prove the exact omitted replay");
  }
  if (writes.length < expectedSequences.length || acknowledgements.length !== expectedSequences.length) {
    throw new Error("C39 Worker IPC has an unexpected carrier frame count");
  }
  const restarts = worker.filter((entry) => entry.phase === "restart_resend");
  const restartResendExact = restarts.length > 0 && restarts.every((entry) => {
    const original = writes.find((write) => write.sequence === entry.sequence);
    return original !== undefined && original.outerDigest === entry.outerDigest && entry.ordinal > original.ordinal;
  });
  if (!restartResendExact) throw new Error("C39 Worker IPC restart resend changed sequence or outer digest");
  return Object.freeze({
    omittedReplayObserved,
    exactCarrierAckOrder,
    oneCarrierIdentity,
    restartResendExact,
    protectedC2Completed: row.resultRefDigest === resultRefDigest && SHA256.test(row.resultRefDigest),
    resultRefDigest,
    partialCount: partials.length,
    workerEventCount: worker.length,
  });
}

async function waitForObservedC39Recovery(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  origin: C39OriginProvenance,
  resultRefDigest: `sha256:${string}`,
  timeoutMs: number,
): Promise<ObservedC39Recovery> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const audit = object(await runtime.supervisor.readRealCaseAudit());
    if (audit === null) throw new Error("C39 Gateway audit is not an object");
    const worker = await runtime.supervisor.readRecoveryCarrierObservations();
    const observed = observedC39Recovery(audit, worker, origin, resultRefDigest);
    if (observed !== null) return observed;
    if (Date.now() >= deadline) throw new Error("C39 observed recovery evidence did not become coherent");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
}

async function c39NormalOriginIsSuppressed(
  client: RealTrioNorthMcpClient,
  input: Parameters<RealTrioNorthMcpClient["toolCall"]>[0],
): Promise<boolean> {
  try { return (await client.toolCall(input)).content.state !== "completed"; } catch { return true; }
}

async function expectC39RecoveryDenied(
  client: RealTrioNorthMcpClient,
  origin: C39OriginProvenance,
  binding: "wss" | "streamable_http_sse",
  subject: "rebound" | "foreign" | "restart",
): Promise<boolean> {
  try {
    const result = await client.toolCall({
      name: realTrioNorthToolForCase("O1-C39").toolName,
      arguments: { origin_invocation_id: origin.requestId, expected_result_digest: origin.responseDigest },
      requestId: `wp12-c39-${subject}-recovery-${binding}`,
    });
    return result.content.state !== "completed";
  } catch { return true; }
}

async function c39ResourceReadDenied(
  client: RealTrioNorthMcpClient,
  input: Parameters<RealTrioNorthMcpClient["readResource"]>[0],
): Promise<boolean> {
  try { await client.readResource(input); return false; } catch { return true; }
}

function assertDistinctBoundSessions(
  owner: { readonly serverMcpSessionId?: string },
  candidate: { readonly serverMcpSessionId?: string },
  label: string,
): void {
  if (typeof owner.serverMcpSessionId !== "string" || typeof candidate.serverMcpSessionId !== "string" ||
      owner.serverMcpSessionId === candidate.serverMcpSessionId) {
    throw new Error(`${label} did not receive a distinct server-bound MCP session`);
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function executionCount(snapshot: Record<string, unknown>, requestId: string): number {
  const counts = Array.isArray(snapshot.executionCounts) ? snapshot.executionCounts : [];
  const row = counts.map(object).find((entry) => entry?.requestId === requestId);
  return typeof row?.count === "number" ? row.count : 0;
}

function c39OriginFromEvidence(snapshot: Record<string, unknown>): C39OriginProvenance {
    const rows = Array.isArray(snapshot.c39OriginResponses) ? snapshot.c39OriginResponses : [];
    const candidates = rows.map(object).filter((row): row is Record<string, unknown> =>
      typeof row?.requestId === "string" && typeof row.responseDigest === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(row.responseDigest),
    );
    if (candidates.length !== 1) throw new Error("real C39 fixture origin provenance is not singular");
    const candidate = candidates[0]!;
    const requestId = candidate.requestId as string;
    if (executionCount(snapshot, requestId) !== 1) throw new Error("real C39 fixture origin count is not one");
    return Object.freeze({ requestId, responseDigest: candidate.responseDigest as `sha256:${string}` });
}

async function readCompleteFixtureEvidence(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
): Promise<Record<string, unknown>> {
  const pages: Record<string, unknown>[] = [];
  let page = object(await runtime.supervisor.fixtureControl("snapshot_evidence"));
  if (page === null) throw new Error("fixture evidence page is invalid");
  for (let index = 0; index < 16; index += 1) {
    pages.push(page);
    if (page.complete === true) {
      const first = pages[0]!;
      const aggregate: Record<string, unknown> = { ...first };
      for (const field of ["observations", "executionCounts", "methodExecutionCounts", "pendingStalls", "c39OriginResponses"] as const) {
        aggregate[field] = pages.flatMap((entry) => Array.isArray(entry[field]) ? entry[field] : []);
      }
      if (JSON.stringify(aggregate).length > 65_536) throw new Error("fixture evidence aggregate exceeds bound");
      return aggregate;
    }
    if (typeof page.snapshotId !== "string" || object(page.nextCursor) === null) {
      throw new Error("fixture evidence cursor is invalid or incomplete");
    }
    page = object(await runtime.supervisor.fixtureControl("snapshot_evidence", {
      snapshotId: page.snapshotId, cursor: page.nextCursor as Record<string, unknown>,
    }));
    if (page === null) throw new Error("fixture evidence continuation is invalid");
  }
  throw new Error("fixture evidence did not complete within page bound");
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
    const audit = object(await runtime.supervisor.readRealCaseAudit());
    if (object(audit?.c39Recovery)?.status === "joined") {
      await runtime.verifyNorthDispatchFence();
      const result = await client.toolCall({
        name: realTrioNorthToolForCase("O1-C39").toolName,
        arguments: { origin_invocation_id: origin.requestId, expected_result_digest: origin.responseDigest },
        requestId: `wp12-c39-recovery-${binding}`,
      });
      if (result.content.state === "completed") return result;
    }
    if (Date.now() >= deadline) throw new Error("real C39 public recovery did not complete");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
}
