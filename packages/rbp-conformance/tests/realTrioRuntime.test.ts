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
  RealTrioNorthMcpError,
  RealTrioOmittedPayloadCoordinateError,
  withRealTrioNorthMcpClient,
  type RealTrioNorthMcpClient,
} from "../src/realTrioMcpClient.js";
import { runRealTrioCli } from "../src/realTrioCli.js";
import {
  buildRealTrioRuntimeFixture,
  rethrowRealTrioC38Failure,
  resolveRealTrioC39WorkerProfile,
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
const C39_PROTECTED_RESOURCE_READ_OUTCOMES = new Set([
  "owner_scope_mismatch",
  "completion_missing_or_mismatch",
  "activation_mismatch",
  "recovery_reauthorize_denied",
  "protected_store_read_failed",
  "protected_integrity_mismatch",
  "success",
] as const);
type C39ProtectedResourceReadOutcome =
  | "owner_scope_mismatch"
  | "completion_missing_or_mismatch"
  | "activation_mismatch"
  | "recovery_reauthorize_denied"
  | "protected_store_read_failed"
  | "protected_integrity_mismatch"
  | "success";

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

describe("C39 real trio fixture profiles", () => {
  it("keeps D0 compatibility, selects terminal pre-peer, and rejects combined profiles", () => {
    expect(resolveRealTrioC39WorkerProfile({})).toBe("none");
    expect(resolveRealTrioC39WorkerProfile({ c39D0PostWriteFault: true })).toBe("d0_postwrite_once");
    expect(resolveRealTrioC39WorkerProfile({ c39TerminalPrePeerFault: true })).toBe("c39_terminal_prepeer_once");
    expect(() => resolveRealTrioC39WorkerProfile({
      c39D0PostWriteFault: true,
      c39TerminalPrePeerFault: true,
    })).toThrow("C39 real trio worker fault profiles are mutually exclusive");
  });
});

describe("C39 recovery timeout diagnostics", () => {
  it("formats only fixed audit, commit, and canonical phase counts", () => {
    const worker = [
      c39WorkerObservation(`sha256:${"a".repeat(64)}`, "materialized", 9, 1, "b"),
      c39WorkerObservation(`sha256:${"a".repeat(64)}`, "write", 9, 2, "b"),
      c39WorkerObservation(`sha256:${"a".repeat(64)}`, "ack", 9, 3, "b"),
    ];
    const reconnect = [
      { phase: "resume_ack_applied" },
      { phase: "watcher_started" },
      { phase: "watcher_started" },
    ] as unknown as C39ReconnectWatchObservations;
    const message = c39RecoveryTimeoutMessage(true, "pending", worker, reconnect);
    expect(message).toBe("real C39 recovery evidence did not become coherent [audit_joined=true;partial_carrier_commit_failure=pending;materialized=1;write=1;restart_resend=0;ack=1;total=3;resume_ack_applied=1;watcher_started=2]");
    expect(message).not.toContain("sha256:");
    expect(message).not.toContain("b".repeat(64));
  });
});

describe("C39 route-rebind audit projection", () => {
  const digest = (character: string): `sha256:${string}` =>
    `sha256:${character.repeat(64)}` as `sha256:${string}`;

  it("accepts only the bounded digest-only current authority tuple", () => {
    const current = {
      status: "current",
      candidateCount: 1,
      capabilityGranted: true,
      receiptCurrent: true,
      resumeCasCurrent: true,
      routeProvenanceCurrent: true,
      currentConnection: true,
      routeAuthorityCheckpoint: digest("a"),
      connectionDigest: digest("b"),
      serverProofDigest: digest("c"),
      authorityGenerationDigest: digest("d"),
      proofCasRecordVersion: 7,
    } as const;
    const nonCurrent = {
      ...current,
      status: "not_current",
      candidateCount: 0,
      capabilityGranted: false,
      receiptCurrent: false,
      resumeCasCurrent: false,
      routeProvenanceCurrent: false,
      currentConnection: false,
      routeAuthorityCheckpoint: null,
      connectionDigest: null,
      serverProofDigest: null,
      authorityGenerationDigest: null,
      proofCasRecordVersion: null,
    } as const;
    expect(readC39RouteRebindAudit(current)).toMatchObject({ status: "current", candidateCount: 1 });
    expect(readC39RouteRebindAudit(nonCurrent)).toMatchObject({ status: "not_current", candidateCount: 0 });

    const missingKey: Record<string, unknown> = { ...current };
    delete missingKey.receiptCurrent;
    expect(() => readC39RouteRebindAudit(missingKey)).toThrow(/malformed or unredacted/u);
    expect(() => readC39RouteRebindAudit({ ...current, rawRsid: "must-not-escape" }))
      .toThrow(/malformed or unredacted/u);
    expect(() => readC39RouteRebindAudit({ ...current, routeAuthorityCheckpoint: null }))
      .toThrow(/malformed or unredacted/u);
    expect(() => readC39RouteRebindAudit({ ...current, connectionDigest: "sha256:invalid" }))
      .toThrow(/malformed or unredacted/u);
    expect(() => readC39RouteRebindAudit({ ...current, proofCasRecordVersion: 0 }))
      .toThrow(/malformed or unredacted/u);
    expect(() => readC39RouteRebindAudit({ ...current, proofCasRecordVersion: -1 }))
      .toThrow(/malformed or unredacted/u);

    const inconsistentCurrentStates = [
      ["zero candidates", { ...current, candidateCount: 0 }],
      ["ambiguous candidates", { ...current, candidateCount: 2 }],
      ["capability not granted", { ...current, capabilityGranted: false }],
      ["receipt not current", { ...current, receiptCurrent: false }],
      ["resume CAS not current", { ...current, resumeCasCurrent: false }],
      ["route provenance not current", { ...current, routeProvenanceCurrent: false }],
      ["connection not current", { ...current, currentConnection: false }],
    ] as const;
    for (const [, inconsistentCurrent] of inconsistentCurrentStates) {
      expect(() => readC39RouteRebindAudit(inconsistentCurrent))
        .toThrow(/malformed or unredacted/u);
    }
  });

  it("rejects proofless, substituted, and causally unordered terminal traces", () => {
    const checkpoint = digest("a");
    const connection = digest("b");
    const audit = readC39RouteRebindAudit({
      status: "current", candidateCount: 1, capabilityGranted: true,
      receiptCurrent: true, resumeCasCurrent: true, routeProvenanceCurrent: true,
      currentConnection: true, routeAuthorityCheckpoint: checkpoint, connectionDigest: connection,
      serverProofDigest: digest("c"), authorityGenerationDigest: digest("d"), proofCasRecordVersion: 7,
    });
    const row = {
      terminal: { seq: 9, originDigest: digest("e"), state: "completed" },
      routeAuthority: {
        routeAuthorityCheckpoint: checkpoint, connectionDigest: connection,
        serverProofDigest: digest("c"), authorityGenerationDigest: digest("d"),
        resultantSessionVersion: 2, proofCasRecordVersion: 7,
        provenance: "session_resume_route_rebind_v1",
      },
    };
    const observation = (phase: C39RecoveryCarrierObservations[number]["phase"], causalOrdinal: number) => ({
      phase, hashedRecoveryId: digest("f"), sequence: 9, outerDigest: digest("0"), ordinal: causalOrdinal,
      routeAuthorityCheckpoint: checkpoint, connectionDigest: connection,
      routeRebindProofGranted: true, causalOrdinal,
    });
    const reconnect = [{
      phase: "resume_ack_applied", generation: 2, ordinal: 1, rsidHash: digest("1"),
      sessionBindingDigest: digest("2"), connectionDigest: connection,
      routeAuthorityCheckpoint: checkpoint, routeRebindProofGranted: true, causalOrdinal: 1,
    }] as const;
    const exact = [observation("restart_resend", 2), observation("ack", 3)];
    expect(() => assertC39CausalRouteAuthority(row, audit, exact, reconnect)).not.toThrow();

    const historicalCheckpoint = digest("4");
    const historicalConnection = digest("5");
    const historicalObservation = (
      phase: C39RecoveryCarrierObservations[number]["phase"],
      causalOrdinal: number,
    ) => ({
      ...observation(phase, causalOrdinal),
      routeAuthorityCheckpoint: historicalCheckpoint,
      connectionDigest: historicalConnection,
    });
    const reconnectWithHistoricalPrefix = [{
      ...reconnect[0], generation: 1, ordinal: 1,
      routeAuthorityCheckpoint: historicalCheckpoint,
      connectionDigest: historicalConnection, causalOrdinal: 1,
    }, {
      ...reconnect[0], generation: 2, ordinal: 2, causalOrdinal: 4,
    }] as const;
    const exactWithHistoricalPrefix = [
      historicalObservation("materialized", 2),
      historicalObservation("write", 3),
      observation("restart_resend", 5),
      observation("ack", 6),
    ];
    expect(() => assertC39CausalRouteAuthority(
      row,
      audit,
      exactWithHistoricalPrefix,
      reconnectWithHistoricalPrefix,
    )).not.toThrow();
    expect(() => assertC39CausalRouteAuthority(row, audit, [
      ...exactWithHistoricalPrefix,
      historicalObservation("ack", 7),
    ], reconnectWithHistoricalPrefix)).toThrow(/proofless, stale, or substituted/u);
    expect(() => assertC39CausalRouteAuthority(row, audit, [
      { ...historicalObservation("write", 3), routeRebindProofGranted: false },
      observation("restart_resend", 5), observation("ack", 6),
    ], reconnectWithHistoricalPrefix)).toThrow(/proofless, stale, or substituted/u);
    expect(() => assertC39CausalRouteAuthority(row, audit, [
      observation("materialized", 3), observation("restart_resend", 5), observation("ack", 6),
    ], reconnectWithHistoricalPrefix)).toThrow(/proofless, stale, or substituted/u);
    expect(() => assertC39CausalRouteAuthority(row, audit, [
      { ...observation("restart_resend", 2), routeAuthorityCheckpoint: null }, observation("ack", 3),
    ], reconnect)).toThrow(/proofless, stale, or substituted/u);
    expect(() => assertC39CausalRouteAuthority(row, audit, [
      observation("ack", 2), observation("restart_resend", 3),
    ], reconnect)).toThrow(/resume_ack_applied < restart_resend < terminal ack/u);
    expect(() => assertC39CausalRouteAuthority({
      ...row,
      routeAuthority: { ...row.routeAuthority, connectionDigest: digest("9") },
    }, audit, exact, reconnect)).toThrow(/exact current Gateway route-authority tuple/u);
    const inconsistentCurrent = {
      status: "current", candidateCount: 1, capabilityGranted: true,
      receiptCurrent: false, resumeCasCurrent: true, routeProvenanceCurrent: true,
      currentConnection: true, routeAuthorityCheckpoint: checkpoint, connectionDigest: connection,
      serverProofDigest: digest("c"), authorityGenerationDigest: digest("d"), proofCasRecordVersion: 7,
    } as const;
    expect(() => assertC39CausalRouteAuthority(
      row,
      readC39RouteRebindAudit(inconsistentCurrent),
      exact,
      reconnect,
    )).toThrow(/malformed or unredacted/u);
  });
});

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
          evidenceDirectory, c39TerminalPrePeerFault: true,
        }),
      );
      const runtime = launched.result;
      try {
        expect(runtime.supervisor.bridgeReadiness.c39Profile).toBe("c39_terminal_prepeer_once");
        expect((await runtime.supervisor.readRecoveryCarrierObservationState()).routeRebindProofGranted).toBe(true);
        await withRealTrioNorthMcpClient({
          endpoint: runtime.endpoint,
          certificateSha256: runtime.certificateSha256,
          credential: runtime.credential,
        }, async (client) => {
          // The terminal profile faults only after its durable Bridge write
          // observation and before peer delivery. The public origin call therefore need not return a
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
          // The recovery-proof CAS must be current before the retained
          // terminal can be observed or retried. Settlement timing is
          // deliberately not used: the later causal assertion proves the
          // identical Gateway tuple and resume_ack_applied < restart_resend
          // < terminal ACK ordering, alongside the proofless, stale, and
          // substituted-route negatives. In particular, C39 no longer uses a
          // sequenced document-context edge to escape N-1.
          const routeAuthorityBeforeOwnerRead = await waitForC39RouteRebindCurrent(runtime, 45_000);
          const carrier = await c39OriginCarrierFromPromise(originPromise);
          const origin = Object.freeze({ requestId: carrier.origin_invocation_id, responseDigest: carrier.expected_result_digest });
          expect(origin.requestId).toMatch(UUID_V7);
          assertC39OriginProvenance(initialProvenance, origin.responseDigest, 1);
          const recovery = await waitForC39Recovery(
            client,
            runtime,
            carrier,
            routeAuthorityBeforeOwnerRead,
            binding,
            45_000,
          );
          const result = recovery.content.result as Record<string, unknown>;
          expect(result).toMatchObject({ kind: "result_ref", digest: expect.stringMatching(SHA256) });
          expect(result).not.toHaveProperty("payload");
          expect(result).not.toHaveProperty("result");
          const uri = result.uri;
          expect(typeof uri).toBe("string");
          // Owner reads are permitted only after the complete recovery proof,
          // including the restart-resend byte identity, has settled.  The
          // route-proof tuple is re-read, rather than applying another
          // sequenced document context behind the retained terminal.
          const observed = await waitForC39ObservedRecoveryAndRouteFence(
            waitForObservedC39Recovery(runtime, origin, result.digest as `sha256:${string}`, 45_000),
            async () => {
              expect(await waitForC39RouteRebindCurrent(runtime, 45_000))
                .toEqual(routeAuthorityBeforeOwnerRead);
            },
          );
          let ownerRead;
          try {
            ownerRead = await client.readResource({ uri: uri as string, requestId: `wp12-c39-owner-read-${binding}` });
          } catch (error) {
            // This is the sole C39 owner resource-read diagnostic. The audit is
            // deliberately queried before runtime teardown, and only its fixed
            // conformance stage enum can annotate the original wire failure.
            const audit = await readC39OwnerResourceReadAudit(runtime);
            throw withC39OwnerResourceReadDiagnostic(error, audit);
          }
          expect(ownerRead).toMatchObject({ response: expect.any(Object) });
          const ownerReadSucceeded = object(ownerRead.response) !== null;
          expect(ownerReadSucceeded).toBe(true);
          // The terminal audit join and the owner-read fence must retain the
          // exact same immutable Gateway tuple; neither path may backfill or
          // substitute a later proof/current connection.
          expect(await waitForC39RouteRebindCurrent(runtime, 45_000))
            .toEqual(routeAuthorityBeforeOwnerRead);

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
          await waitForC39RouteRebindCurrent(runtime, 45_000);

          await runtime.supervisor.restartBridge();
          expect((await runtime.supervisor.readRecoveryCarrierObservationState()).routeRebindProofGranted).toBe(true);
          // Bridge restart establishes a fresh route-proof epoch.  Its
          // current tuple is independently required before denial checks, but
          // it must not be compared with the pre-owner-read epoch.
          await waitForC39RouteRebindCurrent(runtime, 45_000);
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

describe("C39 owner resource-read diagnostics", () => {
  it("keeps only allowlisted audit outcomes and preserves absent or malformed values as null", () => {
    expect(c39OwnerResourceReadOutcome({
      c39ProtectedResourceReadFirst: "owner_scope_mismatch",
      c39ProtectedResourceReadLast: "success",
      leaked: "must-not-escape",
    })).toBe("success");
    expect(c39OwnerResourceReadOutcome({
      c39ProtectedResourceReadFirst: "activation_mismatch",
      c39ProtectedResourceReadLast: "untrusted-detail",
    })).toBe("activation_mismatch");
    expect(c39OwnerResourceReadOutcome({
      c39ProtectedResourceReadFirst: { unexpected: "value" },
      c39ProtectedResourceReadLast: ["untrusted-detail"],
    })).toBeNull();
  });

  it("retains the original MCP error class and wire code while adding one fixed outcome suffix", () => {
    const evidence = Object.freeze({
      schemaVersion: "rbp-real-trio-north-evidence/v1" as const,
      requestSha256: `sha256:${"a".repeat(64)}` as const,
      responseSha256: `sha256:${"b".repeat(64)}` as const,
      methodSha256: `sha256:${"c".repeat(64)}` as const,
      requestBytes: 1,
      responseBytes: 1,
      statusCode: 404,
      jsonRpcErrorCode: -32_001,
      mcpSessionHeaderPresent: true,
    });
    const original = new RealTrioNorthMcpError("real trio MCP resources/read returned JSON-RPC error -32001", evidence);
    const diagnostic = withC39OwnerResourceReadDiagnostic(original, "protected_store_read_failed");
    expect(diagnostic).toBeInstanceOf(RealTrioNorthMcpError);
    expect((diagnostic as RealTrioNorthMcpError).evidence).toBe(evidence);
    expect(diagnostic.message).toBe("real trio MCP resources/read returned JSON-RPC error -32001 [protected_store_read_failed]");
  });
});

describe("C39 terminal settlement before owner resource read", () => {
  const origin = Object.freeze({
    requestId: "00000000-0000-7000-8000-000000000001",
    responseDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
  });
  const carrierHash = `sha256:${"b".repeat(64)}` as `sha256:${string}`;

  it("requires one ordered terminal acknowledgement with the matching outer digest", () => {
    const settlement = c39TerminalSettlement(c39TerminalAudit(origin, carrierHash, 9), origin);
    expect(settlement).toEqual({ carrierHash, terminalSequence: 9 });
    expect(settlement).not.toHaveProperty("payload");
    expect(settlement).not.toHaveProperty("uri");

    expect(c39TerminalAckSettled([
      c39WorkerObservation(carrierHash, "ack", 9, 12, "c"),
      c39WorkerObservation(carrierHash, "write", 9, 13, "c"),
    ], settlement)).toBe(false);
    expect(c39TerminalAckSettled([
      c39WorkerObservation(carrierHash, "write", 9, 12, "c"),
      c39WorkerObservation(carrierHash, "ack", 9, 13, "d"),
    ], settlement)).toBe(false);
    expect(c39TerminalAckSettled([
      c39WorkerObservation(carrierHash, "write", 9, 12, "c"),
      c39WorkerObservation(carrierHash, "ack", 9, 13, "c"),
      c39WorkerObservation(carrierHash, "ack", 9, 14, "c"),
    ], settlement)).toBe(false);
    expect(c39TerminalAckSettled([
      c39WorkerObservation(carrierHash, "write", 8, 12, "c"),
      c39WorkerObservation(carrierHash, "ack", 8, 13, "c"),
    ], settlement)).toBe(false);
    expect(c39TerminalAckSettled([
      c39WorkerObservation(carrierHash, "write", 9, 12, "c"),
      c39WorkerObservation(carrierHash, "ack", 9, 13, "c"),
    ], settlement)).toBe(true);
  });

  it("rechecks the C39 route fence after settlement without creating a route edge", async () => {
    const settlementAudit = c39TerminalAudit(origin, carrierHash, 9);
    const settledWorker = [
      c39WorkerObservation(carrierHash, "write", 9, 12, "c"),
      c39WorkerObservation(carrierHash, "ack", 9, 13, "c"),
    ];
    const steps: string[] = [];
    let fenceAttempts = 0;
    await waitForC39TerminalSettlementAndRouteFence(
      c39SettlementRuntime(
        settlementAudit,
        settledWorker,
      ),
      origin,
      async () => {
        steps.push("verify-route");
        fenceAttempts += 1;
      },
      1,
      { now: () => 0, sleep: async () => {} },
    );
    expect(fenceAttempts).toBe(1);
    expect(steps).toEqual(["verify-route"]);
  });

  it("does not verify the C39 route fence before settlement and retains its failure", async () => {
    const settlementAudit = c39TerminalAudit(origin, carrierHash, 9);
    const steps: string[] = [];
    await expect(waitForC39TerminalSettlementAndRouteFence(
      c39SettlementRuntime(settlementAudit, [
        c39WorkerObservation(carrierHash, "write", 8, 12, "c"),
        c39WorkerObservation(carrierHash, "ack", 8, 13, "c"),
      ]),
      origin,
      async () => { steps.push("verify-route"); },
      0,
      { now: () => 0, sleep: async () => {} },
    )).rejects.toThrow("C39 terminal settlement or C39 route fence did not become ready");
    expect(steps).toEqual([]);

    await expect(waitForC39TerminalSettlementAndRouteFence(
      c39SettlementRuntime(settlementAudit, [
        c39WorkerObservation(carrierHash, "write", 9, 12, "c"),
        c39WorkerObservation(carrierHash, "ack", 9, 13, "c"),
      ]),
      origin,
      async () => { throw new Error("bounded route-fence failure"); },
      1,
      { now: () => 0, sleep: async () => {} },
    )).rejects.toThrow("bounded route-fence failure");
    expect(steps).toEqual([]);
  });

  it("does not release the owner-read route fence until observed recovery, then verifies once", async () => {
    const steps: string[] = [];
    let resolveObserved: ((value: ObservedC39Recovery) => void) | undefined;
    const observed = new Promise<ObservedC39Recovery>((resolve) => { resolveObserved = resolve; });
    const fenced = waitForC39ObservedRecoveryAndRouteFence(observed, async () => { steps.push("verify-route"); });
    await Promise.resolve();
    expect(steps).toEqual([]);
    resolveObserved?.({
      omittedReplayObserved: true,
      exactCarrierAckOrder: true,
      oneCarrierIdentity: true,
      restartResendExact: true,
      protectedC2Completed: true,
      resultRefDigest: `sha256:${"d".repeat(64)}`,
      partialCount: 1,
      workerEventCount: 3,
    });
    await fenced;
    expect(steps).toEqual(["verify-route"]);
  });

  it("propagates a post-observation C39 route-fence failure", async () => {
    const observed = Promise.resolve<ObservedC39Recovery>({
      omittedReplayObserved: true,
      exactCarrierAckOrder: true,
      oneCarrierIdentity: true,
      restartResendExact: true,
      protectedC2Completed: true,
      resultRefDigest: `sha256:${"e".repeat(64)}`,
      partialCount: 1,
      workerEventCount: 3,
    });
    await expect(waitForC39ObservedRecoveryAndRouteFence(
      observed,
      async () => { throw new Error("exact route tuple drift"); },
    )).rejects.toThrow("exact route tuple drift");
  });
});

describe("C39 worker ACK-order diagnostics", () => {
  const carrierHash = `sha256:${"e".repeat(64)}` as `sha256:${string}`;
  const expectedSequences = [5, 6] as const;
  const observation = (
    phase: C39RecoveryCarrierObservations[number]["phase"],
    sequence: number,
    ordinal: number,
    digestCharacter: string,
  ) => c39WorkerObservation(carrierHash, phase, sequence, ordinal, digestCharacter);
  const materialized = () => observation("materialized", 5, 1, "a");

  it("classifies every fixed ACK-order failure without emitting worker values", () => {
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("ack", 5, 2, "a"), observation("write", 6, 3, "b"), observation("ack", 6, 4, "b"),
    ], expectedSequences)).toBe("partial_write_missing");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("write", 5, 2, "a"), observation("write", 6, 3, "b"), observation("ack", 6, 4, "b"),
    ], expectedSequences)).toBe("partial_ack_missing");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a"), observation("ack", 6, 4, "b"),
    ], expectedSequences)).toBe("terminal_write_missing");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a"), observation("write", 6, 4, "b"),
    ], expectedSequences)).toBe("terminal_ack_missing");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a"), observation("ack", 5, 4, "a"),
      observation("write", 6, 5, "b"), observation("ack", 6, 6, "b"),
    ], expectedSequences)).toBe("duplicate_ack");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("ack", 5, 2, "a"), observation("write", 5, 3, "b"),
      observation("write", 6, 4, "c"), observation("ack", 6, 5, "c"),
    ], expectedSequences)).toBe("ack_before_write");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "b"),
      observation("write", 6, 4, "c"), observation("ack", 6, 5, "c"),
    ], expectedSequences)).toBe("outer_digest_mismatch");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a"),
      observation("write", 6, 4, "b"), observation("ack", 6, 5, "b"), observation("ack", 7, 6, "d"),
    ], expectedSequences)).toBe("unexpected_ack");
    expect(c39WorkerAckOrderDiagnostic([
      observation("write", 5, 2, "a"), observation("ack", 7, 2, "d"),
    ], expectedSequences)).toBe("observation_order_invalid");
    expect(c39WorkerAckOrderDiagnostic([
      observation("write", 5, 1, "a"), observation("ack", 5, 2, "a"),
      observation("write", 6, 3, "b"), observation("ack", 6, 4, "b"),
    ], expectedSequences)).toBe("other");
  });

  it("uses the documented stable preference order", () => {
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("write", 5, 2, "a"), observation("ack", 7, 2, "d"),
    ], expectedSequences)).toBe("observation_order_invalid");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("ack", 7, 2, "d"), observation("write", 6, 3, "b"),
    ], expectedSequences)).toBe("unexpected_ack");
    expect(c39WorkerAckOrderDiagnostic([
      materialized(), observation("ack", 5, 2, "a"), observation("write", 5, 3, "b"),
      observation("write", 6, 4, "c"), observation("ack", 6, 5, "c"),
    ], expectedSequences)).toBe("ack_before_write");
  });

  it("permits only a legal ordered prefix to remain pending", () => {
    expect(c39WorkerRecoveryTraceState([], expectedSequences)).toEqual({ state: "pending", reason: "empty_worker" });
    expect(c39WorkerRecoveryTraceState([
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a"),
      observation("materialized", 6, 4, "b"), observation("write", 6, 5, "b"),
    ], expectedSequences)).toEqual({ state: "pending", reason: "terminal_ack_missing" });
    const terminalRestartAwaitingAck = [
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a"),
      observation("materialized", 6, 4, "b"), observation("write", 6, 5, "b"),
      observation("materialized", 6, 6, "b"), observation("restart_resend", 6, 7, "b"),
    ];
    expect(c39WorkerRecoveryTraceState(
      terminalRestartAwaitingAck,
      expectedSequences,
    )).toEqual({ state: "pending", reason: "terminal_ack_missing" });
    expect(c39WorkerRecoveryTraceState([
      ...terminalRestartAwaitingAck,
      observation("ack", 6, 8, "b"),
    ], expectedSequences)).toEqual({ state: "exact" });
    expect(c39WorkerRecoveryTraceState([
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a"),
      observation("materialized", 6, 4, "b"), observation("write", 6, 5, "b"),
      observation("materialized", 6, 6, "b"), observation("write", 6, 7, "b"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      materialized(), observation("write", 5, 2, "a"), observation("materialized", 6, 3, "b"), observation("write", 6, 4, "b"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "partial_ack_missing" });
    expect(c39WorkerRecoveryTraceState([
      observation("ack", 5, 1, "a"), observation("materialized", 6, 2, "b"), observation("write", 6, 3, "b"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "partial_write_missing" });
    expect(c39WorkerRecoveryTraceState([
      materialized(), observation("write", 5, 2, "a"), observation("materialized", 6, 3, "b"), observation("write", 6, 4, "b"),
      observation("ack", 6, 5, "b"), observation("ack", 5, 6, "a"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      materialized(), observation("write", 7, 2, "a"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      observation("write", 5, 1, "a"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    const fullAcknowledged = [
      materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a"),
      observation("materialized", 6, 4, "b"), observation("write", 6, 5, "b"), observation("ack", 6, 6, "b"),
    ];
    expect(c39WorkerRecoveryTraceState(fullAcknowledged, expectedSequences)).toEqual({ state: "pending", reason: "restart_missing" });
    expect(c39WorkerRecoveryTraceState([
      ...fullAcknowledged,
      observation("materialized", 5, 7, "b"), observation("restart_resend", 5, 8, "b"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      ...fullAcknowledged,
      observation("materialized", 7, 7, "z"), observation("restart_resend", 7, 8, "z"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      materialized(), observation("restart_resend", 5, 2, "a"), observation("materialized", 5, 3, "a"), observation("write", 5, 4, "a"),
      observation("ack", 5, 5, "a"), observation("materialized", 6, 6, "b"), observation("write", 6, 7, "b"), observation("ack", 6, 8, "b"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      ...fullAcknowledged,
      observation("materialized", 5, 7, "a"), observation("restart_resend", 5, 8, "a"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "ack_before_write" });
    expect(c39WorkerRecoveryTraceState([
      materialized(), observation("write", 5, 2, "a"), observation("materialized", 5, 3, "a"), observation("restart_resend", 5, 4, "a"),
      observation("ack", 5, 5, "a"), observation("materialized", 6, 6, "b"), observation("write", 6, 7, "b"), observation("ack", 6, 8, "b"),
    ], expectedSequences)).toEqual({ state: "exact" });
    expect(c39WorkerRecoveryTraceState([
      observation("write", 5, 1, "a"), observation("materialized", 5, 2, "a"), observation("ack", 5, 3, "a"),
      observation("write", 6, 4, "b"), observation("ack", 6, 5, "b"), observation("restart_resend", 5, 6, "a"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      observation("materialized", 7, 1, "z"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      observation("materialized", 5, 1, "b"), observation("write", 5, 2, "a"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
    expect(c39WorkerRecoveryTraceState([
      materialized(), observation("write", 5, 2, "a"), observation("materialized", 5, 3, "a"), observation("write", 5, 4, "a"),
    ], expectedSequences)).toEqual({ state: "invalid", diagnostic: "other" });
  });

  it("formats only fixed pending reasons and canonical phase counts", () => {
    const worker = [materialized(), observation("write", 5, 2, "a"), observation("ack", 5, 3, "a")];
    for (const reason of [
      "pre_audit_not_joined", "empty_worker", "unconsumed_materialization", "partial_write_missing",
      "partial_ack_missing", "terminal_write_missing", "terminal_ack_missing", "restart_missing",
    ] as const) {
      const message = c39PendingTimeoutMessage(reason, worker);
      expect(message).toBe(`C39 observed recovery evidence did not become coherent [${reason};materialized=1;write=1;restart_resend=0;ack=1;total=3]`);
      expect(message).not.toContain(carrierHash);
      expect(message).not.toContain("sha256:");
    }
  });
});

async function readC39OwnerResourceReadAudit(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
): Promise<C39ProtectedResourceReadOutcome | null> {
  try {
    return c39OwnerResourceReadOutcome(await runtime.supervisor.readRealCaseAudit());
  } catch {
    return null;
  }
}

function c39OwnerResourceReadOutcome(value: unknown): C39ProtectedResourceReadOutcome | null {
  const audit = object(value);
  if (audit === null) return null;
  const first = c39ProtectedResourceReadOutcome(audit.c39ProtectedResourceReadFirst);
  const last = c39ProtectedResourceReadOutcome(audit.c39ProtectedResourceReadLast);
  return last ?? first;
}

function c39ProtectedResourceReadOutcome(value: unknown): C39ProtectedResourceReadOutcome | null {
  return typeof value === "string" && C39_PROTECTED_RESOURCE_READ_OUTCOMES.has(value as C39ProtectedResourceReadOutcome)
    ? value as C39ProtectedResourceReadOutcome
    : null;
}

function withC39OwnerResourceReadDiagnostic(
  error: unknown,
  outcome: C39ProtectedResourceReadOutcome | null,
): Error {
  const suffix = outcome ?? "null";
  if (error instanceof RealTrioNorthMcpError) {
    return new RealTrioNorthMcpError(`${error.message} [${suffix}]`, error.evidence, error.toolResultEvidence);
  }
  return new Error(`C39 owner resources/read failed [${suffix}]`, { cause: error });
}

type C39RecoveryCarrierObservations = Awaited<ReturnType<
  Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>["supervisor"]["readRecoveryCarrierObservations"]
>>;
type C39ReconnectWatchObservations = Awaited<ReturnType<
  Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>["supervisor"]["readReconnectWatchObservations"]
>>;
type C39TerminalSettlementRuntime = Pick<
  Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  "supervisor"
>;
type C39RouteFence = () => Promise<void>;

interface C39TerminalSettlement {
  readonly carrierHash: `sha256:${string}`;
  readonly terminalSequence: number;
}

interface C39TerminalSettlementWaitOptions {
  readonly now?: () => number;
  readonly sleep?: () => Promise<void>;
}

async function waitForC39ObservedRecoveryAndRouteFence<T>(
  observedRecovery: Promise<T>,
  verifyC39RouteFence: C39RouteFence,
): Promise<T> {
  const observed = await observedRecovery;
  await verifyC39RouteFence();
  return observed;
}

async function waitForC39TerminalSettlementAndRouteFence(
  runtime: C39TerminalSettlementRuntime,
  origin: C39OriginProvenance,
  verifyC39RouteFence: C39RouteFence,
  timeoutMs: number,
  options: C39TerminalSettlementWaitOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (async () => await new Promise<void>((resolve) => setTimeout(resolve, 200)));
  const deadline = now() + timeoutMs;
  for (;;) {
    const audit = object(await runtime.supervisor.readRealCaseAudit());
    if (audit === null) throw new Error("C39 Gateway audit is not an object");
    const terminal = c39TerminalSettlement(audit, origin);
    const worker = await runtime.supervisor.readRecoveryCarrierObservations();
    const terminalSettled = terminal !== null && c39TerminalAckSettled(worker, terminal);
    if (terminalSettled) {
      // Do not retry through a sequenced data-route fence.  The route-fence
      // callback either proves the exact current authority or propagates its
      // failure before an owner read can occur.
      await verifyC39RouteFence();
      return;
    }
    if (now() >= deadline) {
      throw new Error("C39 terminal settlement or C39 route fence did not become ready");
    }
    await sleep();
  }
}

function c39TerminalSettlement(
  audit: Record<string, unknown>,
  origin: C39OriginProvenance,
): C39TerminalSettlement | null {
  const recovery = object(audit.c39Recovery);
  if (recovery === null || recovery.status !== "joined") return null;
  const originIdHash = c39AuditHash("origin", origin.requestId);
  const rows = objectArray(recovery.rows, "C39 Gateway audit rows");
  const matches = rows.filter((row) => row.originIdHash === originIdHash && row.originDigest === origin.responseDigest);
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("C39 Gateway audit has missing or duplicate origin correlation");
  const row = matches[0]!;
  const terminal = object(row.terminal);
  if (terminal === null || terminal.originDigest !== origin.responseDigest || terminal.state !== "completed" ||
      !Number.isSafeInteger(terminal.seq) || Number(terminal.seq) < 1 ||
      typeof row.recoveryIdHash !== "string" || !SHA256.test(row.recoveryIdHash)) {
    return null;
  }
  return Object.freeze({ carrierHash: row.recoveryIdHash as `sha256:${string}`, terminalSequence: Number(terminal.seq) });
}

function c39TerminalAckSettled(
  worker: C39RecoveryCarrierObservations,
  terminal: C39TerminalSettlement | null,
): boolean {
  if (terminal === null || worker.length === 0 ||
      new Set(worker.map((entry) => entry.ordinal)).size !== worker.length ||
      worker.some((entry, index) => index > 0 && entry.ordinal <= worker[index - 1]!.ordinal)) {
    return false;
  }
  const writes = worker.filter((entry) => entry.phase === "write" &&
    entry.hashedRecoveryId === terminal.carrierHash && entry.sequence === terminal.terminalSequence);
  const acknowledgements = worker.filter((entry) => entry.phase === "ack" &&
    entry.hashedRecoveryId === terminal.carrierHash && entry.sequence === terminal.terminalSequence);
  if (acknowledgements.length !== 1) return false;
  const acknowledgement = acknowledgements[0]!;
  return writes.some((write) => write.outerDigest === acknowledgement.outerDigest && write.ordinal < acknowledgement.ordinal);
}

function c39TerminalAudit(
  origin: C39OriginProvenance,
  carrierHash: `sha256:${string}`,
  terminalSequence: number,
): Record<string, unknown> {
  return Object.freeze({ c39Recovery: Object.freeze({
    status: "joined",
    rows: Object.freeze([Object.freeze({
      originIdHash: c39AuditHash("origin", origin.requestId),
      originDigest: origin.responseDigest,
      recoveryIdHash: carrierHash,
      terminal: Object.freeze({ originDigest: origin.responseDigest, state: "completed", seq: terminalSequence }),
    })]),
  }) });
}

function c39WorkerObservation(
  carrierHash: `sha256:${string}`,
  phase: C39RecoveryCarrierObservations[number]["phase"],
  sequence: number,
  ordinal: number,
  digestCharacter: string,
): C39RecoveryCarrierObservations[number] {
  return Object.freeze({
    phase,
    hashedRecoveryId: carrierHash,
    sequence,
    outerDigest: `sha256:${digestCharacter.repeat(64)}` as `sha256:${string}`,
    ordinal,
    routeAuthorityCheckpoint: null,
    connectionDigest: null,
    routeRebindProofGranted: false,
    causalOrdinal: ordinal,
  });
}

function c39SettlementRuntime(
  audit: Record<string, unknown>,
  worker: C39RecoveryCarrierObservations,
): C39TerminalSettlementRuntime {
  return Object.freeze({
    supervisor: Object.freeze({
      readRealCaseAudit: async () => audit,
      readRecoveryCarrierObservations: async () => worker,
    }),
  }) as unknown as C39TerminalSettlementRuntime;
}

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

interface C39TerminalRouteAuthority {
  readonly routeAuthorityCheckpoint: `sha256:${string}`;
  readonly connectionDigest: `sha256:${string}`;
  readonly serverProofDigest: `sha256:${string}`;
  readonly authorityGenerationDigest: `sha256:${string}`;
  readonly resultantSessionVersion: number;
  readonly proofCasRecordVersion: number;
  readonly provenance: "session_resume_route_rebind_v1";
}

function readC39TerminalRouteAuthority(value: unknown): C39TerminalRouteAuthority {
  const record = object(value);
  const expected = [
    "authorityGenerationDigest", "connectionDigest", "proofCasRecordVersion", "provenance",
    "resultantSessionVersion", "routeAuthorityCheckpoint", "serverProofDigest",
  ];
  if (record === null || Object.keys(record).sort().join("\u0000") !== expected.join("\u0000") ||
      typeof record.routeAuthorityCheckpoint !== "string" || !SHA256.test(record.routeAuthorityCheckpoint) ||
      typeof record.connectionDigest !== "string" || !SHA256.test(record.connectionDigest) ||
      typeof record.serverProofDigest !== "string" || !SHA256.test(record.serverProofDigest) ||
      typeof record.authorityGenerationDigest !== "string" || !SHA256.test(record.authorityGenerationDigest) ||
      !Number.isSafeInteger(record.resultantSessionVersion) || Number(record.resultantSessionVersion) < 1 ||
      !Number.isSafeInteger(record.proofCasRecordVersion) || Number(record.proofCasRecordVersion) < 1 ||
      record.provenance !== "session_resume_route_rebind_v1") {
    throw new Error("C39 terminal route authority is malformed or unredacted");
  }
  return Object.freeze(record as unknown as C39TerminalRouteAuthority);
}

function assertC39CausalRouteAuthority(
  row: Record<string, unknown>,
  routeRebind: C39RouteRebindAudit,
  worker: C39RecoveryCarrierObservations,
  reconnect: C39ReconnectWatchObservations,
): void {
  const terminal = object(row.terminal);
  const routeAuthority = readC39TerminalRouteAuthority(row.routeAuthority);
  if (terminal === null || !Number.isSafeInteger(terminal.seq) || Number(terminal.seq) < 1 ||
      routeRebind.status !== "current" || routeRebind.routeAuthorityCheckpoint === null ||
      routeRebind.connectionDigest === null || routeRebind.serverProofDigest === null ||
      routeRebind.authorityGenerationDigest === null || routeRebind.proofCasRecordVersion === null ||
      routeAuthority.routeAuthorityCheckpoint !== routeRebind.routeAuthorityCheckpoint ||
      routeAuthority.connectionDigest !== routeRebind.connectionDigest ||
      routeAuthority.serverProofDigest !== routeRebind.serverProofDigest ||
      routeAuthority.authorityGenerationDigest !== routeRebind.authorityGenerationDigest ||
      routeAuthority.proofCasRecordVersion !== routeRebind.proofCasRecordVersion) {
    throw new Error("C39 terminal evidence is not the exact current Gateway route-authority tuple");
  }
  const sameTuple = (entry: {
    readonly routeAuthorityCheckpoint: `sha256:${string}` | null;
    readonly connectionDigest: `sha256:${string}` | null;
    readonly routeRebindProofGranted: boolean;
  }): boolean => entry.routeRebindProofGranted &&
    entry.routeAuthorityCheckpoint === routeAuthority.routeAuthorityCheckpoint &&
    entry.connectionDigest === routeAuthority.connectionDigest;
  const resumeAcknowledgements = reconnect.filter((entry) =>
    entry.phase === "resume_ack_applied" && sameTuple(entry));
  const restarts = worker.filter((entry) => entry.phase === "restart_resend" && sameTuple(entry));
  const terminalAcknowledgements = worker.filter((entry) =>
    entry.phase === "ack" && entry.sequence === terminal.seq && sameTuple(entry));
  const invalidWorkerAuthority = worker.filter((entry) =>
    !entry.routeRebindProofGranted || entry.routeAuthorityCheckpoint === null ||
    entry.connectionDigest === null || entry.causalOrdinal < 1);
  const resumeRows = reconnect.filter((entry) => entry.phase === "resume_ack_applied");
  const invalidResumeAuthority = resumeRows.filter((entry) =>
    !entry.routeRebindProofGranted || entry.routeAuthorityCheckpoint === null ||
    entry.causalOrdinal < 1);
  if (invalidWorkerAuthority.length > 0 || invalidResumeAuthority.length > 0) {
    throw new Error("C39 recovery trace contains a proofless, stale, or substituted route authority tuple");
  }
  if (resumeAcknowledgements.length !== 1 || restarts.length < 1 || terminalAcknowledgements.length !== 1) {
    throw new Error("C39 causal route authority lacks resume_ack_applied < restart_resend < terminal ack");
  }
  const currentResume = resumeAcknowledgements[0]!;
  // Carrier writes and partial acknowledgements from the interrupted connection
  // are immutable historical prefix evidence. They need not equal the newly
  // accepted route tuple, but no historical tuple may appear at or after the
  // current resume acknowledgement, and no current-tuple carrier event may
  // precede that acknowledgement.
  const staleWorkerAfterResume = worker.some((entry) =>
    !sameTuple(entry) && entry.causalOrdinal >= currentResume.causalOrdinal);
  const currentWorkerBeforeResume = worker.some((entry) =>
    sameTuple(entry) && entry.causalOrdinal <= currentResume.causalOrdinal);
  const staleResumeAfterCurrent = resumeRows.some((entry) =>
    !sameTuple(entry) && entry.causalOrdinal >= currentResume.causalOrdinal);
  if (staleWorkerAfterResume || currentWorkerBeforeResume || staleResumeAfterCurrent) {
    throw new Error("C39 recovery trace contains a proofless, stale, or substituted route authority tuple");
  }
  if (!restarts.some((restart) =>
    currentResume.causalOrdinal < restart.causalOrdinal &&
    restart.causalOrdinal < terminalAcknowledgements[0]!.causalOrdinal)) {
    throw new Error("C39 causal route authority lacks resume_ack_applied < restart_resend < terminal ack");
  }
}

function observedC39Recovery(
  audit: Record<string, unknown>,
  worker: Awaited<ReturnType<Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>["supervisor"]["readRecoveryCarrierObservations"]>>,
  reconnect: C39ReconnectWatchObservations,
  origin: C39OriginProvenance,
  resultRefDigest: `sha256:${string}`,
): ObservedC39Recovery | C39RecoveryPending {
  const recovery = object(audit.c39Recovery);
  if (recovery === null || recovery.status !== "joined") return c39Pending("pre_audit_not_joined");
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
  if (worker.length === 0) return c39Pending("empty_worker");
  const oneCarrierIdentity = worker.length > 0 && worker.every((entry) => entry.hashedRecoveryId === carrierHash);
  if (!oneCarrierIdentity) {
    throw new Error("C39 Worker IPC has missing or cross-carrier observations");
  }
  const writes = worker.filter((entry) => entry.phase === "write");
  const acknowledgements = worker.filter((entry) => entry.phase === "ack");
  const expectedSequences = [...partials.map((partial) => Number(partial.seq)), Number(terminal.seq)];
  const trace = c39WorkerRecoveryTraceState(worker, expectedSequences);
  if (trace.state === "pending") return c39Pending(trace.reason);
  if (trace.state === "invalid") {
    throw new Error(`C39 Worker IPC did not prove one ordered acknowledgement per carrier sequence [${trace.diagnostic}]`);
  }
  assertC39CausalRouteAuthority(row, readC39RouteRebindAudit(audit.c39RouteRebind), worker, reconnect);
  const exactCarrierAckOrder = true;
  const omittedReplayObserved = row.originDigest === origin.responseDigest &&
    terminal.originDigest === origin.responseDigest && terminal.state === "completed";
  if (!omittedReplayObserved) {
    throw new Error("C39 Gateway audit did not prove the exact omitted replay");
  }
  if (writes.length < expectedSequences.length || acknowledgements.length !== expectedSequences.length) {
    throw new Error("C39 Worker IPC has an unexpected carrier frame count");
  }
  const restartResendExact = true;
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

type C39WorkerAckOrderDiagnostic =
  | "partial_write_missing"
  | "partial_ack_missing"
  | "terminal_write_missing"
  | "terminal_ack_missing"
  | "duplicate_ack"
  | "ack_before_write"
  | "outer_digest_mismatch"
  | "unexpected_ack"
  | "observation_order_invalid"
  | "other";

function c39WorkerAckOrderDiagnostic(
  worker: C39RecoveryCarrierObservations,
  expectedSequences: readonly number[],
): C39WorkerAckOrderDiagnostic {
  if (new Set(worker.map((entry) => entry.ordinal)).size !== worker.length ||
      worker.some((entry, index) => index > 0 && entry.ordinal <= worker[index - 1]!.ordinal)) {
    return "observation_order_invalid";
  }
  const writes = worker.filter((entry) => entry.phase === "write");
  const acknowledgements = worker.filter((entry) => entry.phase === "ack");
  if (acknowledgements.some((entry) => !expectedSequences.includes(entry.sequence))) return "unexpected_ack";
  const partialSequences = expectedSequences.slice(0, -1);
  const terminalSequence = expectedSequences.at(-1);
  for (const sequence of partialSequences) {
    if (!writes.some((entry) => entry.sequence === sequence)) return "partial_write_missing";
    if (!acknowledgements.some((entry) => entry.sequence === sequence)) return "partial_ack_missing";
  }
  if (terminalSequence === undefined || !writes.some((entry) => entry.sequence === terminalSequence)) {
    return "terminal_write_missing";
  }
  if (!acknowledgements.some((entry) => entry.sequence === terminalSequence)) return "terminal_ack_missing";
  if (expectedSequences.some((sequence) => acknowledgements.filter((entry) => entry.sequence === sequence).length !== 1)) {
    return "duplicate_ack";
  }
  for (const sequence of expectedSequences) {
    const finalWrite = writes.filter((entry) => entry.sequence === sequence).at(-1);
    const acknowledgement = acknowledgements.find((entry) => entry.sequence === sequence);
    if (finalWrite === undefined || acknowledgement === undefined) return "other";
    if (acknowledgement.ordinal <= finalWrite.ordinal) return "ack_before_write";
    if (acknowledgement.outerDigest !== finalWrite.outerDigest) return "outer_digest_mismatch";
  }
  return "other";
}

type C39WorkerRecoveryTraceState =
  | Readonly<{ readonly state: "pending"; readonly reason: C39PendingReason }>
  | Readonly<{ readonly state: "exact" }>
  | Readonly<{ readonly state: "invalid"; readonly diagnostic: C39WorkerAckOrderDiagnostic }>;

function c39WorkerRecoveryTraceState(
  worker: C39RecoveryCarrierObservations,
  expectedSequences: readonly number[],
): C39WorkerRecoveryTraceState {
  if (worker.length === 0) return Object.freeze({ state: "pending", reason: "empty_worker" });
  const invalid = (diagnostic: C39WorkerAckOrderDiagnostic): C39WorkerRecoveryTraceState =>
    Object.freeze({ state: "invalid", diagnostic });
  if (worker.filter((entry) => entry.phase === "materialized").length < 1) return invalid("other");
  if (new Set(worker.map((entry) => entry.ordinal)).size !== worker.length ||
      worker.some((entry, index) => index > 0 && entry.ordinal <= worker[index - 1]!.ordinal)) {
    return invalid("observation_order_invalid");
  }
  const writes = worker.filter((entry) => entry.phase === "write");
  const acknowledgements = worker.filter((entry) => entry.phase === "ack");
  const restarts = worker.filter((entry) => entry.phase === "restart_resend");
  const materialized = worker.filter((entry) => entry.phase === "materialized");
  if (materialized.some((entry) => !expectedSequences.includes(entry.sequence)) ||
      writes.some((entry) => !expectedSequences.includes(entry.sequence)) ||
      restarts.some((entry) => !expectedSequences.includes(entry.sequence))) return invalid("other");
  if (acknowledgements.some((entry) => !expectedSequences.includes(entry.sequence))) return invalid("unexpected_ack");
  // Production emits Materialized before each Write or RestartResend. Its
  // post-materialization durable confirmation can await while an earlier ACK
  // arrives, so ACKs may interleave; another carrier-send observation may not.
  let awaitingMaterialization: C39RecoveryCarrierObservations[number] | null = null;
  const ordinaryWrites = new Map<number, number>();
  for (const entry of worker) {
    if (entry.phase === "materialized") {
      if (awaitingMaterialization !== null) return invalid("other");
      awaitingMaterialization = entry;
      continue;
    }
    if (entry.phase !== "write" && entry.phase !== "restart_resend") continue;
    const source = awaitingMaterialization;
    if (source === null || source.sequence !== entry.sequence ||
        source.outerDigest !== entry.outerDigest || source.ordinal >= entry.ordinal) return invalid("other");
    awaitingMaterialization = null;
    if (entry.phase === "write") {
      const count = (ordinaryWrites.get(entry.sequence) ?? 0) + 1;
      if (count !== 1) return invalid("other");
      ordinaryWrites.set(entry.sequence, count);
    }
  }
  if (awaitingMaterialization !== null) return Object.freeze({ state: "pending", reason: "unconsumed_materialization" });
  for (const entry of restarts) {
    const original = writes.find((write) => write.sequence === entry.sequence);
    if (original === undefined || original.outerDigest !== entry.outerDigest || entry.ordinal <= original.ordinal) {
      return invalid("other");
    }
  }
  let previousAcknowledgementOrdinal = 0;
  for (const [index, sequence] of expectedSequences.entries()) {
    const sent = writes.filter((entry) => entry.sequence === sequence);
    const acked = acknowledgements.filter((entry) => entry.sequence === sequence);
    const laterSequenceObserved = worker.some((entry) =>
      (entry.phase === "write" || entry.phase === "ack" || entry.phase === "restart_resend") &&
      expectedSequences.slice(index + 1).includes(entry.sequence));
    const diagnostic = index === expectedSequences.length - 1
      ? { write: "terminal_write_missing", ack: "terminal_ack_missing" } as const
      : { write: "partial_write_missing", ack: "partial_ack_missing" } as const;
    const restartForSequence = restarts.some((entry) => entry.sequence === sequence);
    if (ordinaryWrites.get(sequence) !== 1 || sent.length !== 1) {
      return laterSequenceObserved || acked.length > 0 || restartForSequence
        ? invalid(diagnostic.write)
        : Object.freeze({ state: "pending", reason: diagnostic.write });
    }
    if (acked.length === 0) {
      if (laterSequenceObserved) return invalid(diagnostic.ack);
      // A restart resend and its cumulative peer acknowledgement are observed
      // on different asynchronous edges. Until that ACK arrives, the exact
      // terminal resend is a legal prefix and must remain pollable rather than
      // being misclassified as a permanently invalid trace.
      return Object.freeze({ state: "pending", reason: diagnostic.ack });
    }
    if (acked.length !== 1) return invalid("duplicate_ack");
    const latestEmission = worker.filter((entry) => (entry.phase === "write" || entry.phase === "restart_resend") &&
      entry.sequence === sequence).at(-1)!;
    const acknowledgement = acked[0]!;
    if (acknowledgement.ordinal <= latestEmission.ordinal) return invalid("ack_before_write");
    if (acknowledgement.outerDigest !== latestEmission.outerDigest) return invalid("outer_digest_mismatch");
    if (acknowledgement.ordinal <= previousAcknowledgementOrdinal) return invalid("other");
    previousAcknowledgementOrdinal = acknowledgement.ordinal;
  }
  return restarts.length === 0
    ? Object.freeze({ state: "pending", reason: "restart_missing" })
    : Object.freeze({ state: "exact" });
}

type C39PendingReason =
  | "pre_audit_not_joined"
  | "empty_worker"
  | "unconsumed_materialization"
  | "partial_write_missing"
  | "partial_ack_missing"
  | "terminal_write_missing"
  | "terminal_ack_missing"
  | "restart_missing";

interface C39RecoveryPending { readonly pendingReason: C39PendingReason; }

function c39Pending(pendingReason: C39PendingReason): C39RecoveryPending {
  return Object.freeze({ pendingReason });
}

function c39PendingTimeoutMessage(reason: C39PendingReason, worker: C39RecoveryCarrierObservations): string {
  const count = (phase: C39RecoveryCarrierObservations[number]["phase"]): number =>
    worker.filter((entry) => entry.phase === phase).length;
  return `C39 observed recovery evidence did not become coherent [${reason};materialized=${String(count("materialized"))};write=${String(count("write"))};restart_resend=${String(count("restart_resend"))};ack=${String(count("ack"))};total=${String(worker.length)}]`;
}

async function waitForObservedC39Recovery(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  origin: C39OriginProvenance,
  resultRefDigest: `sha256:${string}`,
  timeoutMs: number,
): Promise<ObservedC39Recovery> {
  const deadline = Date.now() + timeoutMs;
  let latestPending: C39PendingReason = "pre_audit_not_joined";
  let latestWorker: C39RecoveryCarrierObservations = Object.freeze([]);
  for (;;) {
    const audit = object(await runtime.supervisor.readRealCaseAudit());
    if (audit === null) throw new Error("C39 Gateway audit is not an object");
    const worker = await runtime.supervisor.readRecoveryCarrierObservations();
    const reconnect = await runtime.supervisor.readReconnectWatchObservations();
    const observed = observedC39Recovery(audit, worker, reconnect, origin, resultRefDigest);
    if (!("pendingReason" in observed)) return observed;
    latestPending = observed.pendingReason;
    latestWorker = worker;
    if (Date.now() >= deadline) throw new Error(c39PendingTimeoutMessage(latestPending, latestWorker));
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

interface C39RouteRebindAudit {
  readonly status: "current" | "none" | "ambiguous" | "invalid" | "not_current";
  readonly candidateCount: 0 | 1 | 2;
  readonly capabilityGranted: boolean;
  readonly receiptCurrent: boolean;
  readonly resumeCasCurrent: boolean;
  readonly routeProvenanceCurrent: boolean;
  readonly currentConnection: boolean;
  readonly routeAuthorityCheckpoint: `sha256:${string}` | null;
  readonly connectionDigest: `sha256:${string}` | null;
  readonly serverProofDigest: `sha256:${string}` | null;
  readonly authorityGenerationDigest: `sha256:${string}` | null;
  readonly proofCasRecordVersion: number | null;
}

function readC39RouteRebindAudit(value: unknown): C39RouteRebindAudit {
  const record = object(value);
  const expected = [
    "candidateCount",
    "capabilityGranted",
    "currentConnection",
    "routeAuthorityCheckpoint",
    "connectionDigest",
    "serverProofDigest",
    "authorityGenerationDigest",
    "proofCasRecordVersion",
    "receiptCurrent",
    "resumeCasCurrent",
    "routeProvenanceCurrent",
    "status",
  ].sort();
  if (record === null ||
      Object.keys(record).sort().join("\u0000") !== expected.join("\u0000") ||
      (record.status !== "current" && record.status !== "none" && record.status !== "ambiguous" &&
        record.status !== "invalid" && record.status !== "not_current") ||
      (record.candidateCount !== 0 && record.candidateCount !== 1 && record.candidateCount !== 2) ||
      typeof record.capabilityGranted !== "boolean" ||
      typeof record.receiptCurrent !== "boolean" ||
      typeof record.resumeCasCurrent !== "boolean" ||
      typeof record.routeProvenanceCurrent !== "boolean" ||
      typeof record.currentConnection !== "boolean" ||
      !(record.routeAuthorityCheckpoint === null ||
        (typeof record.routeAuthorityCheckpoint === "string" && SHA256.test(record.routeAuthorityCheckpoint))) ||
      !(record.connectionDigest === null ||
        (typeof record.connectionDigest === "string" && SHA256.test(record.connectionDigest))) ||
      !(record.serverProofDigest === null ||
        (typeof record.serverProofDigest === "string" && SHA256.test(record.serverProofDigest))) ||
      !(record.authorityGenerationDigest === null ||
        (typeof record.authorityGenerationDigest === "string" && SHA256.test(record.authorityGenerationDigest))) ||
      !(record.proofCasRecordVersion === null ||
        (Number.isSafeInteger(record.proofCasRecordVersion) && Number(record.proofCasRecordVersion) > 0)) ||
      (record.status === "current" && (
        record.candidateCount !== 1 || !record.capabilityGranted || !record.receiptCurrent ||
        !record.resumeCasCurrent || !record.routeProvenanceCurrent || !record.currentConnection ||
        record.routeAuthorityCheckpoint === null || record.connectionDigest === null ||
        record.serverProofDigest === null || record.authorityGenerationDigest === null ||
        record.proofCasRecordVersion === null
      ))) {
    throw new Error("C39 route-rebind audit projection is malformed or unredacted");
  }
  return Object.freeze(record as unknown as C39RouteRebindAudit);
}

async function waitForC39RouteRebindCurrent(
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  timeoutMs: number,
): Promise<C39RouteRebindAudit> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const audit = object(await runtime.supervisor.readRealCaseAudit());
    const routeRebind = readC39RouteRebindAudit(audit?.c39RouteRebind);
    if (routeRebind.status === "current") {
      if (routeRebind.candidateCount !== 1 || !routeRebind.capabilityGranted ||
          !routeRebind.receiptCurrent || !routeRebind.resumeCasCurrent ||
          !routeRebind.routeProvenanceCurrent || !routeRebind.currentConnection ||
          routeRebind.routeAuthorityCheckpoint === null || routeRebind.connectionDigest === null ||
          routeRebind.serverProofDigest === null || routeRebind.authorityGenerationDigest === null ||
          routeRebind.proofCasRecordVersion === null) {
        throw new Error("C39 route-rebind audit reports a non-current proof CAS");
      }
      return routeRebind;
    }
    if (routeRebind.status === "ambiguous" || routeRebind.status === "invalid") {
      throw new Error("C39 route-rebind audit failed closed before retained terminal evidence");
    }
    if (Date.now() >= deadline) {
      throw new Error("C39 route-rebind proof CAS did not become current before retained terminal evidence");
    }
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

type C39PartialCarrierCommitFailure =
  | "none"
  | "ticket"
  | "pending"
  | "sequence_gap"
  | "sequence_ack_beyond_sent"
  | "sequence_wrong_rsid"
  | "sequence_unsafe"
  | "sequence_duplicate_identity_mismatch"
  | "sequence_exhausted"
  | "sequence_other"
  | "normalized_plan_or_cas"
  | "storage_callback";

function c39RecoveryTimeoutMessage(
  auditJoined: boolean,
  partialCarrierCommitFailure: C39PartialCarrierCommitFailure,
  worker: C39RecoveryCarrierObservations,
  reconnect: C39ReconnectWatchObservations,
): string {
  const workerCount = (phase: C39RecoveryCarrierObservations[number]["phase"]): number =>
    worker.filter((entry) => entry.phase === phase).length;
  const reconnectCount = (phase: C39ReconnectWatchObservations[number]["phase"]): number =>
    reconnect.filter((entry) => entry.phase === phase).length;
  return "real C39 recovery evidence did not become coherent " +
    `[audit_joined=${String(auditJoined)};partial_carrier_commit_failure=${partialCarrierCommitFailure};` +
    `materialized=${String(workerCount("materialized"))};write=${String(workerCount("write"))};` +
    `restart_resend=${String(workerCount("restart_resend"))};ack=${String(workerCount("ack"))};total=${String(worker.length)};` +
    `resume_ack_applied=${String(reconnectCount("resume_ack_applied"))};watcher_started=${String(reconnectCount("watcher_started"))}]`;
}

async function waitForC39Recovery(
  client: RealTrioNorthMcpClient,
  runtime: Awaited<ReturnType<typeof startRealTrioRuntimeFixture>>,
  carrier: NonNullable<ReturnType<typeof parseOmittedPayloadCoordinateCarrier>>,
  routeAuthorityBeforeOwnerRead: C39RouteRebindAudit,
  binding: "wss" | "streamable_http_sse",
  timeoutMs: number,
): Promise<{ readonly content: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  let partialCarrierCommitFailure: C39PartialCarrierCommitFailure = "none";
  let auditJoined = false;
  let latestWorker: C39RecoveryCarrierObservations = Object.freeze([]);
  // The recovery proof is the only post-origin route authority.  It is
  // re-read before the public recovery request, and must still be the exact
  // pre-owner-read tuple; no sequenced document-context or D2 fence is used.
  expect(await waitForC39RouteRebindCurrent(runtime, timeoutMs))
    .toEqual(routeAuthorityBeforeOwnerRead);
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
    latestWorker = worker;
    auditJoined = object(audit?.c39Recovery)?.status === "joined";
    const routeRebind = readC39RouteRebindAudit(audit?.c39RouteRebind);
    const routeRebindCurrent = routeRebind.status === "current" &&
      routeRebind.candidateCount === 1 && routeRebind.capabilityGranted &&
      routeRebind.receiptCurrent && routeRebind.resumeCasCurrent &&
      routeRebind.routeProvenanceCurrent && routeRebind.currentConnection &&
      routeRebind.routeAuthorityCheckpoint !== null && routeRebind.connectionDigest !== null &&
      routeRebind.serverProofDigest !== null && routeRebind.authorityGenerationDigest !== null &&
      routeRebind.proofCasRecordVersion !== null;
    if (auditJoined && routeRebindCurrent && worker.length > 0) {
      const result = await recovery;
      if (result.content.state === "completed") return result;
      throw new Error("real C39 one-shot recovery did not complete");
    }
    if (Date.now() >= deadline) {
      const reconnect = await runtime.supervisor.readReconnectWatchObservations();
      throw new Error(c39RecoveryTimeoutMessage(auditJoined, partialCarrierCommitFailure, latestWorker, reconnect));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
}
