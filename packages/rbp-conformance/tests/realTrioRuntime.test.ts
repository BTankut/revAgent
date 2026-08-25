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
  parseOmittedPayloadCoordinateCarrier,
  RealTrioOmittedPayloadCoordinateError,
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
        async (selectedBinding) => await startRealTrioRuntimeFixture(selectedBinding, { evidenceDirectory }),
      );
      const runtime = launched.result;
      try {
        expect(runtime.supervisor.bridgeReadiness.c39Profile).toBe("none");
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
        async (selectedBinding) => await startRealTrioRuntimeFixture(selectedBinding, {
          evidenceDirectory, c39D0PostWriteFault: true,
        }),
      );
      const runtime = launched.result;
      try {
        expect(runtime.supervisor.bridgeReadiness.c39Profile).toBe("d0_postwrite_once");
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
          const originPromise = client.toolCall({
            name: "conformance.fixture.c39_multifile",
            arguments: {
              scenario: "valid_multifile", fileCount: 1, bytesPerFile: 1024,
              contentType: "application/octet-stream",
            },
            requestId: `wp12-c39-origin-${binding}`,
          });
          const initialProvenance = await waitForC39OriginProvenance(runtime, 45_000);
          await waitForC39ReconnectWatch(runtime, 45_000);
          let originSettledBeforeRouteEdge = false;
          void originPromise.then(
            () => { originSettledBeforeRouteEdge = true; },
            () => { originSettledBeforeRouteEdge = true; },
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          expect(originSettledBeforeRouteEdge).toBe(false);
          const routeEdge = await runtime.refreshNorthDispatchFenceAfterControl();
          expect(routeEdge).toMatchObject({
            revision: runtime.documentContextAudit.revision + 1,
            activeDocumentIdentityHash: expect.stringMatching(SHA256),
          });
          const carrier = await c39OriginCarrierFromPromise(originPromise);
          const origin = Object.freeze({ requestId: carrier.origin_invocation_id, responseDigest: carrier.expected_result_digest });
          expect(origin.requestId).toMatch(UUID_V7);
          assertC39OriginProvenance(initialProvenance, origin.responseDigest, 1);
          const recovery = await waitForC39Recovery(client, runtime, carrier, binding, 45_000);
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
          assertC39OriginProvenance(
            readC39OriginProvenance(await runtime.supervisor.fixtureControl("read_c39_origin_provenance")),
            origin.responseDigest, 1,
          );

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
          const finalProvenance = readC39OriginProvenance(await runtime.supervisor.fixtureControl("read_c39_origin_provenance"));
          assertC39OriginProvenance(finalProvenance, origin.responseDigest, 1);
          const originExecutionCount = finalProvenance.count;
          expect(originExecutionCount).toBe(1);
          const cleanup = await readCompleteFixtureEvidence(runtime);
          expect(cleanup).toMatchObject({ openSocketCount: 0, pendingStalls: [] });
          await runtime.stop();
          writeC39SuccessSummary({
            binding,
            origin,
            originExecutionCount,
            observed,
            normalOriginSuppressed: carrier.code === "payload_omitted",
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

async function c39OriginCarrierFromPromise(
  originPromise: Promise<{ readonly content: Record<string, unknown> }>,
): Promise<NonNullable<ReturnType<typeof parseOmittedPayloadCoordinateCarrier>>> {
  try {
    const result = await originPromise;
    const carrier = parseOmittedPayloadCoordinateCarrier(result.content);
    if (carrier === null) throw new Error("C39 origin did not return the strict public omitted-payload coordinate carrier");
    return carrier;
  } catch (error) {
    if (error instanceof RealTrioOmittedPayloadCoordinateError) return error.carrier;
    throw error;
  }
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

interface C39FixtureProvenance {
  readonly version: 1;
  readonly method: "fixture_multi_file_output";
  readonly count: number;
  readonly ready: boolean;
  readonly latestDigest: `sha256:${string}` | null;
  readonly domainHash: `sha256:${string}`;
}

function readC39OriginProvenance(value: unknown): C39FixtureProvenance {
  const record = object(value);
  const keys = record === null ? [] : Object.keys(record).sort();
  const expected = ["count", "domainHash", "latestDigest", "method", "ready", "version"];
  if (record === null || keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      record.version !== 1 || record.method !== "fixture_multi_file_output" ||
      !Number.isSafeInteger(record.count) || Number(record.count) < 0 || typeof record.ready !== "boolean" ||
      !(record.latestDigest === null || (typeof record.latestDigest === "string" && SHA256.test(record.latestDigest))) ||
      typeof record.domainHash !== "string" || !SHA256.test(record.domainHash)) {
    throw new Error("C39 fixture origin provenance control is malformed");
  }
  return Object.freeze(record as unknown as C39FixtureProvenance);
}

function assertC39OriginProvenance(
  provenance: C39FixtureProvenance,
  expectedDigest: `sha256:${string}`,
  expectedCount: number,
): void {
  const expectedDomainHash = `sha256:${createHash("sha256")
    .update(`revagent/c39-origin-provenance/v1\0fixture_multi_file_output\0${String(expectedCount)}\0${expectedDigest}`, "utf8")
    .digest("hex")}`;
  if (provenance.count !== expectedCount || provenance.ready !== (expectedCount === 1) ||
      provenance.latestDigest !== expectedDigest || provenance.domainHash !== expectedDomainHash) {
    throw new Error("C39 fixture origin provenance did not match the strict public coordinate carrier");
  }
}

async function waitForC39OriginProvenance(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  timeoutMs: number,
): Promise<C39FixtureProvenance> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const provenance = readC39OriginProvenance(
      await runtime.supervisor.fixtureControl("read_c39_origin_provenance"),
    );
    if (provenance.count === 1 && provenance.ready && provenance.latestDigest !== null) return provenance;
    if (provenance.count > 1) throw new Error("C39 fixture origin provenance exceeded one execution before route edge");
    if (Date.now() >= deadline) throw new Error("C39 fixture origin provenance did not reach one execution before route edge");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForC39ReconnectWatch(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await runtime.supervisor.readReconnectWatchObservations();
    if (new Set(rows.map((row) => row.ordinal)).size !== rows.length ||
        rows.some((row, index) => index > 0 && row.ordinal <= rows[index - 1]!.ordinal)) {
      throw new Error("C39 reconnect watch has duplicate or unordered ordinals");
    }
    for (const acknowledged of rows.filter((row) => row.phase === "resume_ack_applied")) {
      const watcher = rows.find((row) => row.phase === "watcher_started" &&
        row.generation === acknowledged.generation && row.ordinal > acknowledged.ordinal &&
        row.rsidHash === acknowledged.rsidHash &&
        row.sessionBindingDigest === acknowledged.sessionBindingDigest &&
        row.connectionDigest === acknowledged.connectionDigest);
      if (watcher !== undefined) return;
    }
    if (Date.now() >= deadline) throw new Error("C39 reconnect watch did not reach resume acknowledgement and watcher start");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
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
  carrier: NonNullable<ReturnType<typeof parseOmittedPayloadCoordinateCarrier>>,
  binding: "wss" | "streamable_http_sse",
  timeoutMs: number,
): Promise<{ readonly content: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  let partialCarrierCommitFailure = "none";
  for (;;) {
    try {
      // Keep the current authenticated MCP client/session.  Post-control D2
      // evidence can be durable before its matching heartbeat acknowledgement
      // reaches the strict fence; retry that same fence under this deadline.
      await runtime.verifyNorthDispatchFence();
      break;
    } catch { /* D2 fence is not coherent yet. */ }
    if (Date.now() >= deadline) throw new Error("real C39 public recovery did not complete");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  const recovery = client.recoverOmittedPayload({
    carrier,
    advertisedTool: { name: carrier.recovery_tool, version: carrier.recovery_tool_version },
    requestId: `wp12-c39-recovery-${binding}`,
  });
  for (;;) {
    const audit = object(await runtime.supervisor.readRealCaseAudit());
    const candidate = audit?.c39PartialCarrierCommitFailure;
    if (
      candidate === "ticket" ||
      candidate === "pending" ||
      candidate === "sequence_gap" ||
      candidate === "sequence_ack_beyond_sent" ||
      candidate === "sequence_wrong_rsid" ||
      candidate === "sequence_unsafe" ||
      candidate === "sequence_duplicate_identity_mismatch" ||
      candidate === "sequence_exhausted" ||
      candidate === "sequence_other" ||
      candidate === "normalized_plan_or_cas" ||
      candidate === "storage_callback"
    ) partialCarrierCommitFailure = candidate;
    const worker = await runtime.supervisor.readRecoveryCarrierObservations();
    if (object(audit?.c39Recovery)?.status === "joined" && worker.length > 0) {
      const result = await recovery;
      if (result.content.state === "completed") return result;
      throw new Error("real C39 one-shot recovery did not complete");
    }
    if (Date.now() >= deadline) throw new Error(`real C39 recovery evidence did not become coherent [${partialCarrierCommitFailure}]`);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
}
