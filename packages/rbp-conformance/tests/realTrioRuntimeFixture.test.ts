import { linkSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PublicGatewayControlError,
  redactBridgeTranscript,
  RealTrioDocumentContextCursorJournal,
} from "../src/realTrioSupervisor.js";

import {
  REAL_TRIO_FIXTURE_DOCUMENT_ID,
  REAL_TRIO_MCP_TOOL_RESULT_FAILURE_SCHEMA,
  REAL_TRIO_MCP_TOOL_RESULT_WRITE_FAILURE_SCHEMA,
  REAL_TRIO_RUNTIME_FAILURE_SCHEMA,
  RealTrioDocumentContextFailureError,
  RealTrioPreControlCaptureError,
  correlatedDocumentContextSendSince,
  correlatedDocumentContextSendFromCursor,
  capturePreControlDocumentContextBundle,
  createRealTrioDocumentContextFailure,
  gatewayAuditBaseline,
  hasGatewayAcceptedDocumentContextRoute,
  hasDurableDocumentContextHeartbeatAckSince,
  hasDurableDocumentContextHeartbeatAckFromCursor,
  hasRealTrioLiveDocumentRoute,
  probeRealTrioFixtureDocumentContext,
  preControlWatcherSeedFromSnapshot,
  persistRealTrioMcpToolResultFailure,
  realTrioWorkerBuildPlan,
  rethrowRealTrioC38Failure,
  realTrioFixtureDocumentContextEvent,
  selectCurrentDocumentContextSendFromCursor,
  selectCurrentDocumentContextSendReason,
  startRealTrioRuntimeFixture,
  writeRealTrioDocumentContextFailure,
  writeRealTrioRuntimeFailure,
  unmatchedDocumentContextProbe,
  verifiedRealTrioDocumentContextState,
} from "./realTrioRuntimeFixture.js";
import { RealTrioNorthToolResultError } from "../src/realTrioMcpClient.js";

describe("WP-12 real-trio fixture document route gate", () => {
  const cursorRow = (cursor: string, stage: string, outcome: string, sequence: number | null,
    hash = `sha256:${"a".repeat(64)}`) => ({ cursor, at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({
      event: "bridge.document_context_observation", stage, outcome, rsidHash: hash, sequence,
      ...(["snapshot", "queue", "send"].includes(stage) ? {
        contextDigest: "d".repeat(64), sourceRevision: 1,
        cacheIncarnationDigest: `sha256:${"c".repeat(64)}`,
      } : {}),
    }) });

  it("carries only a validated C# context digest through redaction and the cursor journal", () => {
    const rsidHash = `sha256:${"a".repeat(64)}` as const;
    const incarnation = `sha256:${"b".repeat(64)}` as const;
    const contextDigest = "c".repeat(64);
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const raw = (sourceOffset: number, stage: string, outcome: string, sequence: number | null,
      digest: string | null) => ({
      stream: "stderr" as const,
      at: "2026-08-24T00:00:01.000Z",
      sourceOffset,
      line: JSON.stringify({
        contractVersion: "revagent.rbp-document-context-observation/v1",
        event: "bridge.document_context_observation",
        stage, outcome, rsidHash, sequence,
        ...(stage === "snapshot" || stage === "queue" || stage === "send" ? {
          // RealWorkerHost projects this legacy sha256-prefixed payload
          // commitment together with the bare contextDigest; the journal
          // intentionally retains only its presence bit after redaction.
          payloadHash: `sha256:${"9".repeat(64)}`,
          ...(digest === null ? {} : { contextDigest: digest }),
          sourceRevision: 2,
          cacheIncarnationDigest: incarnation,
          documentId: "raw-document-id-must-not-cross",
          payload: "raw-payload-must-not-cross",
          sessionId: "raw-session-id-must-not-cross",
        } : {
          // The C# anonymous projection keeps these members explicit on
          // value-free observations; absence would be a synthetic schema.
          payloadHash: null,
          contextDigest: null,
          sourceRevision: null,
          cacheIncarnationDigest: null,
        }),
      }),
    });
    const lifecycle = (digest: string | null = contextDigest) => [
      raw(1, "probe", "started", null),
      raw(2, "snapshot", "ready", null, digest),
      raw(3, "queue", "durably_queued", 2, digest),
      raw(4, "send", "sent", 2, digest),
    ];
    const route = (sequence: number, digest: string, ordinal: number) => {
      const current = {
        processEpoch: epoch, rsidHash, observedSequence: sequence, contextDigest: digest,
        routeDigest: `sha256:${"d".repeat(64)}`,
        recordDigest: `sha256:${"e".repeat(64)}`,
        sessionBindingDigest: `sha256:${"f".repeat(64)}`,
        connectionDigest: `sha256:${"1".repeat(64)}`,
        sessionRecordVersion: 2,
      };
      return {
        documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
        documentContextProcessEpoch: epoch,
        documentContextGeneration: 1,
        documentContextObservationHighWaterOrdinal: ordinal,
        documentContextCurrentRoute: current,
        documentContextUpdates: [{
          contractVersion: "revagent.wp12-document-context-audit/v1",
          event: "gateway.doc_context_update_observation",
          stage: "accepted",
          ...current,
          observationOrdinal: ordinal,
        }],
      };
    };
    const preControlAudit = route(1, "2".repeat(64), 1);
    const baseline = gatewayAuditBaseline(preControlAudit)!;
    const baselineBeforeFailure = JSON.parse(JSON.stringify(baseline));
    const select = (rows: readonly ReturnType<typeof raw>[]) => {
      const journal = new RealTrioDocumentContextCursorJournal();
      const snapshot = journal.snapshot(rows);
      return selectCurrentDocumentContextSendFromCursor({
        rows: snapshot.rows,
        generation: snapshot.generation,
        controlCursor: "0",
        precedingProbe: null,
        audit: route(2, contextDigest, 2),
        baseline,
        control: { revision: 2, cacheIncarnationDigest: incarnation },
      });
    };
    const redacted = redactBridgeTranscript(lifecycle());
    expect(redacted).toHaveLength(4);
    expect(JSON.parse(lifecycle()[1]!.line)).toMatchObject({
      contractVersion: "revagent.rbp-document-context-observation/v1",
      event: "bridge.document_context_observation",
      stage: "snapshot", outcome: "ready", payloadHash: `sha256:${"9".repeat(64)}`,
      contextDigest, sourceRevision: 2, cacheIncarnationDigest: incarnation,
    });
    expect(JSON.parse(lifecycle()[0]!.line)).toMatchObject({
      stage: "probe", outcome: "started", sequence: null,
      payloadHash: null, contextDigest: null,
      sourceRevision: null, cacheIncarnationDigest: null,
    });
    expect(JSON.parse(redacted[1]!.line)).toMatchObject({
      stage: "snapshot", sequence: null, contextDigest,
      sourceRevision: 2, cacheIncarnationDigest: incarnation,
    });
    expect(JSON.stringify(redacted)).not.toContain("raw-document-id-must-not-cross");
    expect(JSON.stringify(redacted)).not.toContain("raw-payload-must-not-cross");
    expect(JSON.stringify(redacted)).not.toContain("raw-session-id-must-not-cross");
    expect(select(lifecycle())).toMatchObject({ sequence: 2, contextDigest,
      source: { sourceRevision: 2, cacheIncarnationDigest: incarnation } });

    // A failed public-audit read is separate diagnostic metadata. It cannot
    // replace or erase the pre-control causal baseline captured above.
    const failure = createRealTrioDocumentContextFailure({
      reason: "route_timeout", binding: "wss", timeline: ["control_ack"], transcript: [],
      fixtureEvidence: null, gatewayAudit: null, coherentAudit: null,
      coherentAuditControl: { outcome: "failure", error: "tls_pin", statusCode: null,
        okKeyPresent: false, actionKeyPresent: false },
      childState: { childExited: false, processDiagnostics: [] },
    });
    expect(failure.gatewayAuditControl).toEqual({ outcome: "failure", error: "tls_pin", statusCode: null,
      okKeyPresent: false, actionKeyPresent: false });
    expect(baseline).toEqual(baselineBeforeFailure);
    expect(select(lifecycle())).not.toBeNull();

    for (const invalidDigest of [null, "c".repeat(63), "C".repeat(64)]) {
      const redactedInvalid = redactBridgeTranscript(lifecycle(invalidDigest));
      expect(redactedInvalid).toHaveLength(1);
      expect(select(lifecycle(invalidDigest))).toBeNull();
    }
  });

  it("reports each fixed current-route selector reason without changing selected admission", () => {
    const rsidHash = `sha256:${"a".repeat(64)}`;
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const contextDigest = "b".repeat(64);
    const pair = { sourceRevision: 2, cacheIncarnationDigest: `sha256:${"c".repeat(64)}` } as const;
    const routeDigest = `sha256:${"d".repeat(64)}`;
    const current = { processEpoch: epoch, rsidHash, observedSequence: 7, contextDigest, routeDigest,
      recordDigest: `sha256:${"e".repeat(64)}`, sessionBindingDigest: `sha256:${"f".repeat(64)}`,
      connectionDigest: `sha256:${"1".repeat(64)}`, sessionRecordVersion: 2 };
    const accepted = { contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation",
      stage: "accepted", ...current, observationOrdinal: 5 };
    const audit = (overrides: Record<string, unknown> = {}) => ({
      documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1", documentContextProcessEpoch: epoch,
      documentContextGeneration: 1, documentContextObservationHighWaterOrdinal: 5,
      documentContextCurrentRoute: current, documentContextUpdates: [accepted], ...overrides,
    });
    const row = (cursor: number, stage: string, outcome: string, sequence: number | null,
      source: typeof pair | null = pair) => ({ cursor: String(cursor), at: "", line: JSON.stringify({
      event: "bridge.document_context_observation", stage, outcome, rsidHash, sequence,
      ...(["snapshot", "queue", "send"].includes(stage) ? { contextDigest, ...(source === null ? {} : source) } : {}),
    }) });
    const rows = () => [row(1, "probe", "started", null), row(2, "snapshot", "ready", null),
      row(3, "queue", "durably_queued", 7), row(4, "send", "sent", 7)];
    const control = { revision: pair.sourceRevision, cacheIncarnationDigest: pair.cacheIncarnationDigest } as const;
    const input = (overrides: Record<string, unknown> = {}) => ({ rows: rows(), generation: 1, controlCursor: "0",
      precedingProbe: null, audit: audit(), baseline: { processEpoch: epoch, observationOrdinal: 4 }, control, ...overrides });
    const reason = (overrides: Record<string, unknown> = {}) => selectCurrentDocumentContextSendReason(input(overrides) as never).reason;

    expect(reason()).toBe("selected");
    expect(selectCurrentDocumentContextSendFromCursor(input() as never)).toMatchObject({ sendCursor: "4" });
    expect(reason({ baseline: { processEpoch: "bad", observationOrdinal: -1 } })).toBe("baseline_missing");
    expect(reason({ rows: [{ ...rows()[0]!, cursor: "x" }] })).toBe("grammar_invalid");
    expect(reason({ rows: [row(1, "probe", "started", null), row(2, "snapshot", "ready", null, null)] })).toBe("source_pair_missing");
    expect(reason({ control: { ...control, revision: 3 } })).toBe("source_pair_mismatch");
    expect(reason({ audit: {} })).toBe("audit_join_missing");
    expect(reason({ audit: audit({ documentContextProcessEpoch: "123e4567-e89b-42d3-a456-426614174001" }) })).toBe("audit_epoch_mismatch");
    expect(reason({ audit: audit({ documentContextObservationHighWaterOrdinal: 4 }) })).toBe("accepted_ordinal_not_fresh");
    const advancedCurrent = { ...current, observedSequence: 8 };
    expect(reason({ audit: audit({ documentContextCurrentRoute: advancedCurrent,
      documentContextUpdates: [{ ...accepted, ...advancedCurrent }] }) })).toBe("route_identity_mismatch");
    expect(reason({ rows: [row(1, "probe", "started", null)] })).toBe("no_candidate");
    expect(reason({ audit: audit({ documentContextUpdates: [accepted, accepted] }) })).toBe("multiple_candidates");
    expect(reason({ audit: audit({ documentContextGeneration: 2 }) })).toBe("generation_changed");
    expect(reason({ rows: rows().map((value) => ({ ...value, cursor: String(Number(value.cursor) + 1) })) })).toBe("cursor_expired");
  });

  it("uses cursor rows for strict control lifecycle and later ACK, never transcript indices", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const probe = cursorRow("4", "probe", "started", null, hash);
    const selected = correlatedDocumentContextSendFromCursor([
      cursorRow("5", "snapshot", "ready", null, hash),
      cursorRow("6", "queue", "durably_queued", 9, hash),
      cursorRow("7", "send", "sent", 9, hash),
    ], 2, probe);
    expect(selected).toMatchObject({ generation: 2, sendCursor: "7", rsidHash: hash, sequence: 9 });
    expect(selected).not.toBeNull();
  });

  it("rejects cursor lifecycle wrong order, hash, sequence, and duplicate rows", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const flow = [
      cursorRow("1", "probe", "started", null, hash),
      cursorRow("2", "snapshot", "ready", null, hash),
      cursorRow("3", "queue", "durably_queued", 3, hash),
      cursorRow("4", "send", "sent", 3, hash),
    ];
    expect(correlatedDocumentContextSendFromCursor(flow, 1, null)).not.toBeNull();
    expect(correlatedDocumentContextSendFromCursor([flow[1]!, flow[0]!, flow[2]!, flow[3]!], 1, null)).toBeNull();
    expect(correlatedDocumentContextSendFromCursor([
      flow[0]!, flow[1]!, cursorRow("3", "queue", "durably_queued", 3, `sha256:${"b".repeat(64)}`), flow[3]!,
    ], 1, null)).toBeNull();
    expect(correlatedDocumentContextSendFromCursor([
      flow[0]!, flow[1]!, flow[2]!, cursorRow("4", "send", "sent", 4, hash),
    ], 1, null)).toBeNull();
    expect(correlatedDocumentContextSendFromCursor([
      flow[0]!, flow[1]!, flow[2]!, flow[2]!, flow[3]!,
    ], 1, null)).toBeNull();
  });

  it("binds a pre-control lifecycle to the exact acknowledged revision and cache incarnation", () => {
    const rsidHash = `sha256:${"a".repeat(64)}`;
    const incarnation = `sha256:${"b".repeat(64)}`;
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const contextDigest = "c".repeat(64);
    const routeDigest = `sha256:${"d".repeat(64)}`;
    const source = (revision: number, digest = incarnation) => ({ sourceRevision: revision, cacheIncarnationDigest: digest });
    const event = (cursor: number, stage: string, outcome: string, sequence: number | null, pair = source(2)) => ({
      cursor: String(cursor), at: "not-a-clock", line: JSON.stringify({
        event: "bridge.document_context_observation", stage, outcome, rsidHash, sequence,
        ...(["snapshot", "queue", "send"].includes(stage) ? { contextDigest, ...pair } : {}),
      }),
    });
    const audit = {
      documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1", documentContextProcessEpoch: epoch,
      documentContextGeneration: 1, documentContextObservationHighWaterOrdinal: 12,
      documentContextCurrentRoute: { processEpoch: epoch, rsidHash, observedSequence: 3, contextDigest, routeDigest,
        recordDigest: `sha256:${"e".repeat(64)}`, sessionBindingDigest: `sha256:${"f".repeat(64)}`,
        connectionDigest: `sha256:${"1".repeat(64)}`, sessionRecordVersion: 1 },
      documentContextUpdates: [{ contractVersion: "revagent.wp12-document-context-audit/v1",
        event: "gateway.doc_context_update_observation", stage: "accepted", processEpoch: epoch, rsidHash,
        observedSequence: 3, contextDigest, routeDigest, recordDigest: `sha256:${"e".repeat(64)}`,
        sessionBindingDigest: `sha256:${"f".repeat(64)}`, connectionDigest: `sha256:${"1".repeat(64)}`,
        sessionRecordVersion: 1, observationOrdinal: 12 }],
    };
    const select = (pair = source(2), rows = [
      event(6, "probe", "started", null), event(7, "snapshot", "ready", null, pair),
      event(8, "queue", "durably_queued", 3, pair), event(9, "send", "sent", 3, pair),
      event(10, "ack", "durably_acknowledged", 3),
    ]) => selectCurrentDocumentContextSendFromCursor({ rows, generation: 1, controlCursor: "5",
      precedingProbe: null, audit, baseline: { processEpoch: epoch, observationOrdinal: 11 },
      control: { revision: 2, cacheIncarnationDigest: incarnation } });
    // The watcher may begin before ACK; only its post-floor cycle can qualify.
    expect(select()).toMatchObject({ sendCursor: "9", source: source(2) });
    // Identical normalized context cannot borrow an older post-baseline pair.
    expect(select(source(1))).toBeNull();
    expect(select(source(2, `sha256:${"9".repeat(64)}`))).toBeNull();
    expect(select({ sourceRevision: 0, cacheIncarnationDigest: incarnation })).toBeNull();
    expect(select({ sourceRevision: Number.MAX_SAFE_INTEGER + 1, cacheIncarnationDigest: incarnation })).toBeNull();
    expect(select({ sourceRevision: 2, cacheIncarnationDigest: "sha256:bad" } as never)).toBeNull();
  });

  it("selects only the current coherent route lifecycle when seq1 advances to seq2", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const digest2 = `sha256:${"c".repeat(64)}`;
    const context1 = "d".repeat(64);
    const context2 = "e".repeat(64);
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const row = (cursor: number, stage: string, sequence: number) => cursorRow(
      String(cursor), stage, stage === "probe" ? "started" : stage === "snapshot" ? "ready" :
        stage === "queue" ? "durably_queued" : "sent", sequence, hash,
    ).line;
    const lifecycle = (start: number, sequence: number, contextDigest: string) => ["probe", "snapshot", "queue", "send"].map((stage, offset) => ({
      cursor: String(start + offset), at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({
        ...JSON.parse(row(start + offset, stage, stage === "snapshot" ? null : sequence)),
        ...(["snapshot", "queue", "send"].includes(stage) ? {
          contextDigest, sourceRevision: 1, cacheIncarnationDigest: `sha256:${"c".repeat(64)}`,
        } : {}),
      }),
    }));
    const audit = (sequence: number, routeDigest: string, contextDigest: string, version = 3) => ({
      documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
      documentContextProcessEpoch: epoch,
      documentContextGeneration: 1,
      documentContextObservationHighWaterOrdinal: 9,
      documentContextCurrentRoute: { processEpoch: epoch, rsidHash: hash, observedSequence: sequence, contextDigest, routeDigest, recordDigest: `sha256:${"f".repeat(64)}`, sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`, sessionRecordVersion: version },
      documentContextUpdates: [{
        contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted",
        processEpoch: epoch, rsidHash: hash, observedSequence: sequence, contextDigest, routeDigest, recordDigest: `sha256:${"f".repeat(64)}`, sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`, sessionRecordVersion: version, observationOrdinal: 9,
      }],
    });
    const select = (rows: readonly ReturnType<typeof lifecycle>[number][], value: unknown) => selectCurrentDocumentContextSendFromCursor({
      rows, generation: 1, controlCursor: "0", precedingProbe: null, audit: value,
      baseline: { processEpoch: epoch, observationOrdinal: 4 },
      control: { revision: 1, cacheIncarnationDigest: `sha256:${"c".repeat(64)}` },
    });
    const both = [...lifecycle(1, 1, context1), ...lifecycle(5, 2, context2)];
    expect(select(both, audit(2, digest2, context2))).toMatchObject({ sequence: 2, sendCursor: "8", routeDigest: digest2 });
    expect(select(lifecycle(1, 1, context1), audit(2, digest2, context2))).toBeNull();
    expect(select(both, audit(2, `sha256:${"d".repeat(64)}`, context2))).toMatchObject({ routeDigest: `sha256:${"d".repeat(64)}` });
    expect(select(both, audit(2, digest2, context1))).toBeNull();
    expect(select(both, { ...audit(2, digest2, context2), documentContextGeneration: 2 })).toBeNull();
    expect(select([{ ...both[0]!, cursor: "2" }, ...both.slice(1)], audit(2, digest2, context2))).toBeNull();
  });

  it("fails closed on duplicate lifecycle, ambiguous audit, ACK-before-send, and record-version race", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const digest = `sha256:${"b".repeat(64)}`;
    const contextDigest = "d".repeat(64);
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const event = (cursor: number, stage: string, outcome: string, sequence: number) => ({ cursor: String(cursor), at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({
      event: "bridge.document_context_observation", stage, outcome, rsidHash: hash, sequence,
      ...(["snapshot", "queue", "send"].includes(stage) ? {
        contextDigest, sourceRevision: 1, cacheIncarnationDigest: `sha256:${"c".repeat(64)}`,
      } : {}),
    }) });
    const flow = [event(1, "probe", "started", 2), event(2, "snapshot", "ready", null), event(3, "queue", "durably_queued", 2), event(4, "send", "sent", 2)];
    const current = { processEpoch: epoch, rsidHash: hash, observedSequence: 2, contextDigest, routeDigest: digest, recordDigest: `sha256:${"f".repeat(64)}`, sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`, sessionRecordVersion: 4 };
    const audit = (updates: readonly unknown[] = [{ contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, observationOrdinal: 5 }]) => ({
      documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1", documentContextProcessEpoch: epoch,
      documentContextGeneration: 1, documentContextObservationHighWaterOrdinal: 5, documentContextCurrentRoute: current,
      documentContextUpdates: updates,
    });
    const select = (rows: readonly typeof flow[number][], value: unknown) => selectCurrentDocumentContextSendFromCursor({ rows, generation: 1, controlCursor: "0", precedingProbe: null, audit: value, baseline: { processEpoch: epoch, observationOrdinal: 4 }, control: { revision: 1, cacheIncarnationDigest: `sha256:${"c".repeat(64)}` } });
    expect(select([event(1, "ack", "durably_acknowledged", 2), ...flow], audit())).toBeNull();
    expect(select([flow[0]!, flow[1]!, flow[1]!, flow[2]!, flow[3]!], audit())).toBeNull();
    expect(select(flow, audit([{ contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, observationOrdinal: 5 }, { contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, observationOrdinal: 5 }]))).toBeNull();
    expect(select(flow, audit([{ contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, sessionRecordVersion: 3, observationOrdinal: 5 }]))).toBeNull();
    for (const field of ["contextDigest", "routeDigest", "recordDigest", "sessionBindingDigest", "connectionDigest"] as const) {
      expect(select(flow, audit([{ contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, [field]: field === "contextDigest" ? "e".repeat(64) : `sha256:${"9".repeat(64)}`, observationOrdinal: 5 }]))).toBeNull();
      expect(select(flow, { ...audit(), documentContextCurrentRoute: { ...current, [field]: field === "contextDigest" ? "e".repeat(64) : `sha256:${"9".repeat(64)}` } })).toBeNull();
    }
  });

  it("parses the complete ordinal multipoll grammar and gates only the selected ACK", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const otherHash = `sha256:${"b".repeat(64)}`;
    const context1 = "c".repeat(64);
    const context2 = "d".repeat(64);
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const row = (cursor: number, stage: string, outcome: string, sequence: number | null,
      contextDigest: string | null = null, rsidHash = hash) => ({
      cursor: String(cursor), at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({
        event: "bridge.document_context_observation", stage, outcome, rsidHash, sequence,
        ...(contextDigest === null ? {} : {
          contextDigest, sourceRevision: 1, cacheIncarnationDigest: `sha256:${"c".repeat(64)}`,
        }),
      }),
    });
    const probe = (cursor: number, rsidHash = hash) => row(cursor, "probe", "started", null, null, rsidHash);
    const cycle = (start: number, sequence: number, contextDigest: string, rsidHash = hash) => [
      row(start, "snapshot", "ready", null, contextDigest, rsidHash),
      row(start + 1, "queue", "durably_queued", sequence, contextDigest, rsidHash),
      row(start + 2, "send", "sent", sequence, contextDigest, rsidHash),
    ];
    const audit = (sequence = 2, contextDigest = context2) => ({
      documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
      documentContextProcessEpoch: epoch,
      documentContextGeneration: 7,
      documentContextObservationHighWaterOrdinal: 20,
      documentContextCurrentRoute: {
        processEpoch: epoch, rsidHash: hash, observedSequence: sequence, contextDigest,
        routeDigest: `sha256:${"e".repeat(64)}`, recordDigest: `sha256:${"f".repeat(64)}`,
        sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`,
        sessionRecordVersion: 3,
      },
      documentContextUpdates: [{
        contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation",
        stage: "accepted", processEpoch: epoch, rsidHash: hash, observedSequence: sequence, contextDigest,
        routeDigest: `sha256:${"e".repeat(64)}`, recordDigest: `sha256:${"f".repeat(64)}`,
        sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`,
        sessionRecordVersion: 3, observationOrdinal: 20,
      }],
    });
    const select = (rows: readonly ReturnType<typeof row>[], value: unknown = audit()) =>
      selectCurrentDocumentContextSendFromCursor({ rows, generation: 7, controlCursor: "0", precedingProbe: null,
        audit: value, baseline: { processEpoch: epoch, observationOrdinal: 19 },
        control: { revision: 1, cacheIncarnationDigest: `sha256:${"c".repeat(64)}` } });
    const acknowledgement = (cursor: number, sequence: number, rsidHash = hash) =>
      row(cursor, "ack", "durably_acknowledged", sequence, null, rsidHash);

    // One watcher, two cycles: cycle 2 may begin immediately after send 1.
    const ordinary = [probe(1), ...cycle(2, 1, context1), ...cycle(5, 2, context2), acknowledgement(8, 2)];
    expect(select(ordinary)).toMatchObject({ sequence: 2, sendCursor: "7" });
    // A late ACK for cycle 1 is still evidence, including while cycle 2 is active.
    expect(select([probe(1), ...cycle(2, 1, context1), acknowledgement(5, 1), ...cycle(6, 2, context2), acknowledgement(9, 2)])).toMatchObject({ sequence: 2 });
    expect(select([probe(1), ...cycle(2, 1, context1), row(5, "snapshot", "ready", null, context2),
      acknowledgement(6, 1), row(7, "queue", "durably_queued", 2, context2),
      row(8, "send", "sent", 2, context2), acknowledgement(9, 2)])).toMatchObject({ sequence: 2 });

    const selected = select(ordinary)!;
    expect(hasDurableDocumentContextHeartbeatAckSince(ordinary.map((value) => ({ line: value.line })), 0, selected)).toBe(true);
    expect(hasDurableDocumentContextHeartbeatAckFromCursor(ordinary, selected)).toBe(true);
    expect(hasDurableDocumentContextHeartbeatAckSince([{ line: acknowledgement(9, 1).line }], 0, selected)).toBe(false);
    expect(hasDurableDocumentContextHeartbeatAckSince([], 0, selected)).toBe(false);
    expect(select([...ordinary, acknowledgement(9, 2)])).toBeNull();
    expect(select([...ordinary.slice(0, -1), acknowledgement(8, 2), acknowledgement(9, 1)])).toBeNull();

    // Non-document output consumes an ordinal but is not a document fact.
    const nonDocument = { cursor: "5", at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({ event: "child.stdout", message: "inert" }) };
    const withInertOrdinal = [probe(1), ...cycle(2, 1, context1), nonDocument, ...cycle(6, 2, context2), acknowledgement(9, 2)];
    expect(select(withInertOrdinal)).toMatchObject({ sequence: 2 });
    expect(select([{ ...withInertOrdinal[0]!, cursor: "2" }, ...withInertOrdinal.slice(1)])).toBeNull();
    expect(select([...ordinary, row(9, "failure", "send_failed", 2, null)])).toBeNull();
    expect(select([...ordinary, row(9, "future_stage", "future_outcome", 2, null)])).toBeNull();
    const invalid = (cursor: number, stage: string, outcome: string, sequence: unknown) => ({
      cursor: String(cursor), at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({
        event: "bridge.document_context_observation", stage, outcome, rsidHash: hash, sequence,
        contextDigest: context1,
      }),
    });
    // Snapshot carries identity/context only; the durable queue binds sequence.
    expect(select([probe(1), invalid(2, "snapshot", "ready", 1), ...cycle(3, 1, context1)])).toBeNull();
    expect(select([probe(1), invalid(2, "snapshot", "ready", -1), ...cycle(3, 1, context1)])).toBeNull();
    expect(select([probe(1), invalid(2, "snapshot", "ready", "1"), ...cycle(3, 1, context1)])).toBeNull();
    expect(select([probe(1), row(2, "snapshot", "ready", null, context1),
      row(3, "queue", "durably_queued", null, context1), row(4, "send", "sent", 1, context1)])).toBeNull();
    expect(select([probe(1), ...cycle(2, 1, context1), row(5, "snapshot", "ready", null, context2),
      row(6, "queue", "durably_queued", 1, context2), row(7, "send", "sent", 1, context2)])).toBeNull();
    expect(select([probe(1), row(2, "snapshot", "ready", null, context1, otherHash),
      row(3, "queue", "durably_queued", 1, context1, otherHash), row(4, "send", "sent", 1, context1, otherHash)])).toBeNull();
    expect(select([probe(1), ...cycle(2, 1, context1), row(5, "snapshot", "ready", null, context2),
      row(6, "queue", "durably_queued", 2, context1), row(7, "send", "sent", 2, context2)])).toBeNull();

    // A new probe makes previous sends ineligible for ACK; it cannot borrow them.
    expect(select([probe(1), ...cycle(2, 1, context1), probe(5, otherHash), acknowledgement(6, 1),
      ...cycle(7, 1, context2, otherHash)])).toBeNull();
    expect(select([probe(1), ...cycle(2, 2, context1), ...cycle(5, 2, context2)])).toBeNull();
    expect(select([probe(1), ...cycle(2, 2, context1), ...cycle(5, 1, context2)])).toBeNull();
    expect(select(ordinary, { ...audit(), documentContextGeneration: 8 })).toBeNull();
    expect(select(ordinary, audit(1, context1))).toMatchObject({ sequence: 1, sendCursor: "4" });

    // The exact selected ACK remains valid through later cycles in its watcher.
    const cycle1AcknowledgedThenCycle2 = [probe(1), ...cycle(2, 1, context1), acknowledgement(5, 1), ...cycle(6, 2, context2)];
    const selectedCycle1 = select(cycle1AcknowledgedThenCycle2, audit(1, context1))!;
    expect(hasDurableDocumentContextHeartbeatAckFromCursor(cycle1AcknowledgedThenCycle2, selectedCycle1)).toBe(true);
    // The ACK may arrive after cycle 2 starts, provided it references an already-sent cycle 1.
    const cycle2BeforeAck1 = [probe(1), ...cycle(2, 1, context1), row(5, "snapshot", "ready", null, context2),
      acknowledgement(6, 1), row(7, "queue", "durably_queued", 2, context2), row(8, "send", "sent", 2, context2)];
    const lateAck1 = select(cycle2BeforeAck1, audit(1, context1))!;
    expect(hasDurableDocumentContextHeartbeatAckFromCursor(cycle2BeforeAck1, lateAck1)).toBe(true);
    const beforeNewProbe = [probe(1), ...cycle(2, 1, context1), acknowledgement(5, 1)];
    const staleSelected = select(beforeNewProbe, audit(1, context1))!;
    expect(hasDurableDocumentContextHeartbeatAckFromCursor([...beforeNewProbe, probe(6, otherHash), acknowledgement(7, 1)], staleSelected)).toBe(false);
    expect(hasDurableDocumentContextHeartbeatAckFromCursor([...beforeNewProbe, acknowledgement(6, 1)], staleSelected)).toBe(false);
    expect(select([probe(1), acknowledgement(2, 1), ...cycle(3, 1, context1)], audit(1, context1))).toBeNull();
  });

  it("uses only a final unmatched probe from the atomic pre-control snapshot", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    expect(unmatchedDocumentContextProbe({ generation: 1, lowWaterCursor: "1", highWaterCursor: "1", rows: [
      cursorRow("1", "probe", "started", null, hash),
    ] })?.cursor).toBe("1");
    expect(unmatchedDocumentContextProbe({ generation: 1, lowWaterCursor: "1", highWaterCursor: "2", rows: [
      cursorRow("1", "probe", "started", null, hash), cursorRow("2", "probe", "started", null, hash),
    ] })).toBeNull();
  });

  it("seeds only a complete, ACK-settled latest pre-control watcher", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const other = `sha256:${"b".repeat(64)}`;
    const row = (cursor: number, stage: string, outcome: string, sequence: number | null, rsidHash = hash) =>
      cursorRow(String(cursor), stage, outcome, sequence, rsidHash);
    const snapshot = (rows: readonly ReturnType<typeof row>[], lowWater = "1") => ({
      generation: 3, lowWaterCursor: lowWater,
      highWaterCursor: rows.length === 0 ? "0" : rows.at(-1)!.cursor, rows,
    });
    const settled = snapshot([
      row(1, "probe", "started", null), row(2, "snapshot", "ready", null),
      row(3, "queue", "durably_queued", 1), row(4, "send", "sent", 1),
      row(5, "ack", "durably_acknowledged", 1),
    ]);
    expect(preControlWatcherSeedFromSnapshot(settled)).toEqual({
      generation: 3, highWaterCursor: "5", watcherOrdinal: 1, rsidHash: hash, lastSentSequence: 1, lastAckSequence: 1,
    });
    // The latest deterministic watcher is the only carried identity; its
    // earlier watcher is complete and has no influence on a later control.
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      ...settled.rows, row(6, "probe", "started", null, other),
    ]))).toEqual({ generation: 3, highWaterCursor: "6", watcherOrdinal: 2, rsidHash: other,
      lastSentSequence: null, lastAckSequence: null });
    // The seed validates every retained watcher, not just the latest one. A
    // new empty probe cannot hide a prior unacknowledged send.
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      ...settled.rows.slice(0, -1), row(5, "probe", "started", null, other),
    ]))).toBeNull();
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      ...settled.rows, row(6, "probe", "started", null, other),
    ]))).toMatchObject({ watcherOrdinal: 2, rsidHash: other, lastSentSequence: null, lastAckSequence: null });
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      ...settled.rows,
      row(6, "probe", "started", null, other), row(7, "snapshot", "ready", null, other),
      row(8, "queue", "durably_queued", 1, other), row(9, "send", "sent", 1, other),
      row(10, "ack", "durably_acknowledged", 1, other), row(11, "probe", "started", null, hash),
    ]))).toMatchObject({ watcherOrdinal: 3, rsidHash: hash, lastSentSequence: null, lastAckSequence: null });
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      ...settled.rows, row(6, "ack", "durably_acknowledged", 1),
    ]))).toBeNull();
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      ...settled.rows.slice(0, -1), row(5, "ack", "durably_acknowledged", 2),
    ]))).toBeNull();
    // Missing opening probe/ring eviction, gaps, malformed retained facts,
    // mixed watcher rsids, and an outstanding send all fail closed.
    expect(preControlWatcherSeedFromSnapshot(snapshot(settled.rows, "2"))).toBeNull();
    expect(preControlWatcherSeedFromSnapshot(snapshot([{ ...settled.rows[0]!, cursor: "2" }, ...settled.rows.slice(1)]))).toBeNull();
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      row(1, "snapshot", "ready", null), row(2, "queue", "durably_queued", 1), row(3, "send", "sent", 1),
    ]))).toBeNull();
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      row(1, "probe", "started", null), row(2, "snapshot", "ready", null),
      row(3, "queue", "durably_queued", 1, other), row(4, "send", "sent", 1, other),
    ]))).toBeNull();
    expect(preControlWatcherSeedFromSnapshot(snapshot(settled.rows.slice(0, -1)))).toBeNull();
    expect(preControlWatcherSeedFromSnapshot(snapshot([
      row(1, "probe", "started", null), { ...row(2, "snapshot", "ready", null), line: "{" },
    ]))).toBeNull();
  });

  it("captures optimistic A/audit/B pre-control bundles through the heartbeat deadline", async () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const rows = (ack: boolean) => [
      cursorRow("1", "probe", "started", null, hash), cursorRow("2", "snapshot", "ready", null, hash),
      cursorRow("3", "queue", "durably_queued", 1, hash), cursorRow("4", "send", "sent", 1, hash),
      ...(ack ? [cursorRow("5", "ack", "durably_acknowledged", 1, hash)] : []),
    ];
    const snapshot = (values: readonly ReturnType<typeof cursorRow>[]) => ({ generation: 1, lowWaterCursor: "1",
      highWaterCursor: values.at(-1)!.cursor, rows: values });
    const route = { processEpoch: epoch, rsidHash: hash, observedSequence: 1, contextDigest: "d".repeat(64),
      routeDigest: `sha256:${"e".repeat(64)}`, recordDigest: `sha256:${"f".repeat(64)}`,
      sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`,
      sessionRecordVersion: 1 };
    const audit = { documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
      documentContextProcessEpoch: epoch, documentContextObservationHighWaterOrdinal: 1,
      documentContextCurrentRoute: route, documentContextUpdates: [{
        contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation",
        stage: "accepted", ...route, observationOrdinal: 1,
      }] };
    let now = 0;
    let reads = 0;
    let auditReads = 0;
    const sleep = async (milliseconds: number): Promise<void> => { now += milliseconds; };
    // Initial A/B immutable-row churn and one unavailable audit are
    // transient. The accepted initial send receives its ACK only after 300
    // ms, beyond the old 4x50ms window but within the heartbeat deadline.
    const bundle = await capturePreControlDocumentContextBundle({
      supervisor: { readDocumentContextSnapshot: () => {
        reads += 1;
        const value = snapshot(rows(now >= 300));
        return reads === 2 ? { ...value, rows: value.rows.map((row, index) => index === 0 ? { ...row, at: "churn" } : row) } : value;
      } } as never,
      readGatewayAuditOutcome: async () => {
        auditReads += 1;
        if (auditReads === 1) return { outcome: "failure", error: "timeout", statusCode: null,
          okKeyPresent: false, actionKeyPresent: false } as const;
        return { outcome: "success", audit } as const;
      }, timeoutMs: 500, pollIntervalMs: 100,
      now: () => now, sleep,
    });
    expect(bundle.seed).toMatchObject({ generation: 1, rsidHash: hash, lastSentSequence: 1, lastAckSequence: 1 });
    expect(now).toBe(300);
    // An ACK one poll before the deadline remains admissible.
    now = 0;
    const nearBound = await capturePreControlDocumentContextBundle({
      supervisor: { readDocumentContextSnapshot: () => snapshot(rows(now >= 400)) } as never,
      readGatewayAuditOutcome: async () => ({ outcome: "success", audit } as const), timeoutMs: 450, pollIntervalMs: 100,
      now: () => now, sleep,
    });
    expect(nearBound.seed.lastAckSequence).toBe(1);
    expect(now).toBe(400);
    now = 0;
    await expect(capturePreControlDocumentContextBundle({
      supervisor: { readDocumentContextSnapshot: () => snapshot(rows(false)) } as never,
      readGatewayAuditOutcome: async () => ({ outcome: "success", audit } as const), timeoutMs: 250, pollIntervalMs: 100,
      now: () => now, sleep,
    })).rejects.toMatchObject({ reason: "ack_timeout" } satisfies Partial<RealTrioPreControlCaptureError>);
    expect(now).toBe(250);
  });

  it("rejects malformed pre-control ACK history and generation changes without polling", async () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const route = { processEpoch: epoch, rsidHash: hash, observedSequence: 1, contextDigest: "d".repeat(64),
      routeDigest: `sha256:${"e".repeat(64)}`, recordDigest: `sha256:${"f".repeat(64)}`,
      sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`,
      sessionRecordVersion: 1 };
    const audit = { documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
      documentContextProcessEpoch: epoch, documentContextObservationHighWaterOrdinal: 1,
      documentContextCurrentRoute: route, documentContextUpdates: [{
        contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation",
        stage: "accepted", ...route, observationOrdinal: 1,
      }] };
    const wrongAckRows = [
      cursorRow("1", "probe", "started", null, hash), cursorRow("2", "snapshot", "ready", null, hash),
      cursorRow("3", "queue", "durably_queued", 1, hash), cursorRow("4", "send", "sent", 1, hash),
      cursorRow("5", "ack", "durably_acknowledged", 2, hash),
    ];
    const snapshot = (generation: number, rows = wrongAckRows) => ({ generation, lowWaterCursor: "1",
      highWaterCursor: rows.at(-1)!.cursor, rows });
    let sleeps = 0;
    const sleep = async (): Promise<void> => { sleeps += 1; };
    await expect(capturePreControlDocumentContextBundle({
      supervisor: { readDocumentContextSnapshot: () => snapshot(1) } as never,
      readGatewayAuditOutcome: async () => ({ outcome: "success", audit } as const), timeoutMs: 1_000, now: () => 0, sleep,
    })).rejects.toMatchObject({ reason: "invalid_history" } satisfies Partial<RealTrioPreControlCaptureError>);
    expect(sleeps).toBe(0);
    const snapshots = [snapshot(1, wrongAckRows.slice(0, 4)), snapshot(2, wrongAckRows.slice(0, 4))];
    await expect(capturePreControlDocumentContextBundle({
      supervisor: { readDocumentContextSnapshot: () => snapshots.shift()! } as never,
      readGatewayAuditOutcome: async () => ({ outcome: "success", audit } as const), timeoutMs: 1_000, now: () => 0, sleep,
    })).rejects.toMatchObject({ reason: "generation_changed" } satisfies Partial<RealTrioPreControlCaptureError>);
    expect(sleeps).toBe(0);
  });

  it("retries only typed transient audit outcomes and preserves permanent typed reasons", async () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const route = { processEpoch: epoch, rsidHash: hash, observedSequence: 1, contextDigest: "d".repeat(64),
      routeDigest: `sha256:${"e".repeat(64)}`, recordDigest: `sha256:${"f".repeat(64)}`,
      sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`,
      sessionRecordVersion: 1 };
    const audit = { documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
      documentContextProcessEpoch: epoch, documentContextObservationHighWaterOrdinal: 1,
      documentContextCurrentRoute: route, documentContextUpdates: [{
        contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation",
        stage: "accepted", ...route, observationOrdinal: 1,
      }] };
    const rows = [
      cursorRow("1", "probe", "started", null, hash), cursorRow("2", "snapshot", "ready", null, hash),
      cursorRow("3", "queue", "durably_queued", 1, hash), cursorRow("4", "send", "sent", 1, hash),
      cursorRow("5", "ack", "durably_acknowledged", 1, hash),
    ];
    const snapshot = { generation: 1, lowWaterCursor: "1", highWaterCursor: "5", rows };
    const failure = (error: "timeout" | "tls_pin" | "http_status_4xx" | "http_status_5xx" |
      "invalid_shape" | "process_exited" | "ipc_error" | "unknown", statusCode: number | null = null,
      okKeyPresent = false, actionKeyPresent = false) =>
      ({ outcome: "failure", error, statusCode, okKeyPresent, actionKeyPresent } as const);
    for (const value of [
      failure("tls_pin"), failure("invalid_shape"), failure("http_status_4xx", 401, true, true),
      failure("process_exited"), failure("ipc_error"), failure("unknown"),
      failure("http_status_5xx", 500, true, true), failure("http_status_5xx", 503, false, true),
    ]) {
      let sleeps = 0;
      await expect(capturePreControlDocumentContextBundle({
        supervisor: { readDocumentContextSnapshot: () => snapshot } as never,
        readGatewayAuditOutcome: async () => value, timeoutMs: 1_000, now: () => 0,
        sleep: async () => { sleeps += 1; },
      })).rejects.toMatchObject({ reason: `audit_${value.error}` });
      expect(sleeps).toBe(0);
    }
    // A direct public-control error is classified by the same typed path.
    await expect(capturePreControlDocumentContextBundle({
      supervisor: { readDocumentContextSnapshot: () => snapshot } as never,
      readGatewayAuditOutcome: async () => { throw new PublicGatewayControlError("tls_pin"); },
      timeoutMs: 1_000, now: () => 0, sleep: async () => undefined,
    })).rejects.toMatchObject({ reason: "audit_tls_pin" });

    let now = 0;
    let calls = 0;
    const sleep = async (milliseconds: number): Promise<void> => { now += milliseconds; };
    const eligible503 = failure("http_status_5xx", 503, true, true);
    const recovered = await capturePreControlDocumentContextBundle({
      supervisor: { readDocumentContextSnapshot: () => snapshot } as never,
      readGatewayAuditOutcome: async () => calls++ < 3 ? eligible503 : ({ outcome: "success", audit } as const),
      timeoutMs: 500, pollIntervalMs: 100, now: () => now, sleep,
    });
    expect(recovered.seed.lastAckSequence).toBe(1);
    expect(now).toBe(300);
    now = 0;
    await expect(capturePreControlDocumentContextBundle({
      supervisor: { readDocumentContextSnapshot: () => snapshot } as never,
      readGatewayAuditOutcome: async () => eligible503,
      timeoutMs: 250, pollIntervalMs: 100, now: () => now, sleep,
    })).rejects.toMatchObject({ reason: "ack_timeout" });
    expect(now).toBe(250);
  });

  it("keeps verified document proof alive through credential issue and the returned north fence", async () => {
    const rsidHash = `sha256:${"a".repeat(64)}`;
    const cacheIncarnationDigest = `sha256:${"b".repeat(64)}`;
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const contextDigest = "c".repeat(64);
    const route = (sequence: number) => ({ processEpoch: epoch, rsidHash, observedSequence: sequence, contextDigest,
      routeDigest: `sha256:${"d".repeat(64)}`, recordDigest: `sha256:${"e".repeat(64)}`,
      sessionBindingDigest: `sha256:${"f".repeat(64)}`, connectionDigest: `sha256:${"1".repeat(64)}`,
      sessionRecordVersion: sequence });
    const audit = (sequence: number, ordinal: number) => {
      const current = route(sequence);
      return { documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
        documentContextProcessEpoch: epoch, documentContextGeneration: 1,
        documentContextObservationHighWaterOrdinal: ordinal, documentContextCurrentRoute: current,
        documentContextUpdates: [{ contractVersion: "revagent.wp12-document-context-audit/v1",
          event: "gateway.doc_context_update_observation", stage: "accepted", ...current, observationOrdinal: ordinal }] };
    };
    const sourceRow = (cursor: number, stage: "snapshot" | "queue" | "send", sequence: number | null) => ({
      cursor: String(cursor), at: "", line: JSON.stringify({ event: "bridge.document_context_observation", stage,
        outcome: stage === "snapshot" ? "ready" : stage === "queue" ? "durably_queued" : "sent", rsidHash, sequence,
        contextDigest, sourceRevision: 2, cacheIncarnationDigest }),
    });
    const priorRows = [
      cursorRow("1", "probe", "started", null, rsidHash), cursorRow("2", "snapshot", "ready", null, rsidHash),
      cursorRow("3", "queue", "durably_queued", 1, rsidHash), cursorRow("4", "send", "sent", 1, rsidHash),
      cursorRow("5", "ack", "durably_acknowledged", 1, rsidHash),
    ];
    const postRows = [sourceRow(6, "snapshot", null), sourceRow(7, "queue", 2), sourceRow(8, "send", 2),
      cursorRow("9", "ack", "durably_acknowledged", 2, rsidHash)];
    let applied = false;
    let stops = 0;
    const control = { action: "apply_document_context", revision: 2, cacheIncarnationDigest,
      cachedContextHash: `sha256:${"2".repeat(64)}`, activeDocumentIdentityHash: `sha256:${"3".repeat(64)}`,
      acknowledgementHash: `sha256:${"4".repeat(64)}` };
    const supervisor = {
      gatewayReadiness: { endpoint: "https://127.0.0.1:1", tlsCertificateSha256: `sha256:${"5".repeat(64)}` },
      readDocumentContextSnapshot: () => ({ generation: 1, lowWaterCursor: "1", highWaterCursor: "5", rows: priorRows }),
      readDocumentContextSince: () => ({ state: "ok", generation: 1, highWaterCursor: "9", rows: postRows }),
      readDocumentContextFailureState: () => ({ childExited: false, processDiagnostics: [] }),
      readRealCaseAuditOutcome: async () => ({ outcome: "success", audit: audit(applied ? 2 : 1, applied ? 2 : 1) }),
      readRealCaseAudit: async () => audit(2, 2),
      fixtureControl: async (action: string) => {
        if (action === "apply_document_context") { applied = true; return control; }
        return { documentContextEvidence: { currentRevision: 2, cacheIncarnationDigest,
          cachedContextHash: control.cachedContextHash, activeDocumentIdentityHash: control.activeDocumentIdentityHash,
          lastControlAcknowledgementHash: control.acknowledgementHash, cacheReadCount: 1, pollRequestCount: 1 } };
      },
      readDocumentContextDiagnostics: () => [], readDocumentContextFailureStages: () => [], stop: async () => { stops += 1; },
    };
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-verified-state-"));
    const runtime = await startRealTrioRuntimeFixture("wss", { evidenceDirectory, controlledHarness: {
      supervisor: supervisor as never,
      issueNorthCredential: async () => ({ bearer: "controlled-bearer", audience: "https://north.example",
        credentialProvenance: "gateway_production_conformance", identityContract: "revagent.auth-context/v1" }),
    } });
    expect(runtime.credential.bearer).toBe("controlled-bearer");
    await expect(runtime.verifyNorthDispatchFence()).resolves.toBeUndefined();
    await runtime.stop();
    expect(stops).toBe(1);
  });

  it("fails closed when verified document proof state is missing", () => {
    expect(() => verifiedRealTrioDocumentContextState(undefined, undefined)).toThrow(
      "real trio internal-state missing verified document-context proof",
    );
  });

  it("uses a value-free seed for snapshot-first post-control selection and never carries the old pair", () => {
    const oldHash = `sha256:${"a".repeat(64)}`;
    const newHash = `sha256:${"b".repeat(64)}`;
    const incarnation = `sha256:${"c".repeat(64)}`;
    const oldPair = { sourceRevision: 1, cacheIncarnationDigest: incarnation };
    const pair = { sourceRevision: 2, cacheIncarnationDigest: incarnation };
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const context = "d".repeat(64);
    const route = { processEpoch: epoch, rsidHash: oldHash, observedSequence: 2, contextDigest: context,
      routeDigest: `sha256:${"e".repeat(64)}`, recordDigest: `sha256:${"f".repeat(64)}`,
      sessionBindingDigest: `sha256:${"1".repeat(64)}`, connectionDigest: `sha256:${"2".repeat(64)}`,
      sessionRecordVersion: 2 };
    const audit = (overrides: Record<string, unknown> = {}) => ({
      documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1", documentContextProcessEpoch: epoch,
      documentContextGeneration: 4, documentContextObservationHighWaterOrdinal: 2,
      documentContextCurrentRoute: route, documentContextUpdates: [{
        contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation",
        stage: "accepted", ...route, observationOrdinal: 2,
      }], ...overrides,
    });
    const event = (cursor: number, stage: string, sequence: number | null, source = pair, rsidHash = oldHash) => ({
      cursor: String(cursor), at: "", line: JSON.stringify({ event: "bridge.document_context_observation", stage,
        outcome: stage === "snapshot" ? "ready" : stage === "queue" ? "durably_queued" : stage === "send" ? "sent" : "started",
        rsidHash, sequence, ...(["snapshot", "queue", "send"].includes(stage) ? { contextDigest: context, ...source } : {}), }),
    });
    const seed = { generation: 4, highWaterCursor: "5", watcherOrdinal: 1, rsidHash: oldHash, lastSentSequence: 1, lastAckSequence: 1 } as const;
    const input = (rows: readonly ReturnType<typeof event>[], overrides: Record<string, unknown> = {}) => ({ rows,
      generation: 4, controlCursor: "5", precedingProbe: null, precedingSeed: seed, audit: audit(),
      baseline: { processEpoch: epoch, observationOrdinal: 1 },
      control: { revision: pair.sourceRevision, cacheIncarnationDigest: pair.cacheIncarnationDigest }, ...overrides,
    });
    const selected = selectCurrentDocumentContextSendFromCursor(input([
      event(6, "snapshot", null), event(7, "queue", 2), event(8, "send", 2),
    ]) as never);
    expect(selectCurrentDocumentContextSendReason(input([
      event(6, "snapshot", null), event(7, "queue", 2), event(8, "send", 2),
    ]) as never).reason).toBe("selected");
    expect(selected).toMatchObject({ sequence: 2, watcherOrdinal: 1, precedingSeed: seed });
    // No inherited pair can qualify; the new acknowledged control pair is
    // still exact, and equal/decreasing sequences cannot be replayed.
    expect(selectCurrentDocumentContextSendFromCursor(input([
      event(6, "snapshot", null, oldPair), event(7, "queue", 2, oldPair), event(8, "send", 2, oldPair),
    ]) as never)).toBeNull();
    expect(selectCurrentDocumentContextSendFromCursor(input([
      event(6, "snapshot", null), event(7, "queue", 1), event(8, "send", 1),
    ]) as never)).toBeNull();
    expect(selectCurrentDocumentContextSendFromCursor(input([
      event(6, "snapshot", null), event(7, "queue", 0), event(8, "send", 0),
    ]) as never)).toBeNull();
    // A new post-control probe resets the seed and starts a new watcher.
    const resetRoute = { ...route, rsidHash: newHash, observedSequence: 1 };
    const resetAudit = audit({ documentContextCurrentRoute: resetRoute, documentContextUpdates: [{
      contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation",
      stage: "accepted", ...resetRoute, observationOrdinal: 2,
    }] });
    expect(selectCurrentDocumentContextSendFromCursor(input([
      event(6, "probe", null, pair, newHash), event(7, "snapshot", null, pair, newHash),
      event(8, "queue", 1, pair, newHash), event(9, "send", 1, pair, newHash),
    ], { audit: resetAudit }) as never)).toMatchObject({ watcherOrdinal: 2, rsidHash: newHash, sequence: 1 });
    expect(selectCurrentDocumentContextSendFromCursor(input([
      event(7, "snapshot", null), event(8, "queue", 2), event(9, "send", 2),
    ]) as never)).toBeNull();
    expect(selectCurrentDocumentContextSendFromCursor(input([
      event(6, "snapshot", null, pair, newHash), event(7, "queue", 2, pair, newHash), event(8, "send", 2, pair, newHash),
    ]) as never)).toBeNull();
    expect(selectCurrentDocumentContextSendFromCursor(input([
      event(6, "snapshot", null), event(7, "queue", 2), event(8, "send", 2),
    ], { generation: 5 }) as never)).toBeNull();
  });
  it("restores the real C# carrier from its committed lock before isolated build and publish", () => {
    const plan = realTrioWorkerBuildPlan("C:/temp/wp12-real-trio");
    const output = path.join("C:/temp/wp12-real-trio", "publish");
    expect(plan.restore).toEqual(expect.arrayContaining([
      "restore",
      "--locked-mode",
      "--runtime", "win-x64",
      "--artifacts-path", "C:/temp/wp12-real-trio",
    ]));
    expect(plan.build).toEqual(expect.arrayContaining([
      "build", "--no-restore", "--artifacts-path", "C:/temp/wp12-real-trio",
    ]));
    expect(plan.publish).toEqual(expect.arrayContaining([
      "publish", "--no-restore", "--artifacts-path", "C:/temp/wp12-real-trio",
      "--output", output,
    ]));
    expect(plan.worker).toBe(path.join(output, "RevAgent.Bridge.RealWorkerHost.exe"));
  });

  it("uses the exact attested fixture document identity", () => {
    expect(realTrioFixtureDocumentContextEvent()).toMatchObject({
      activeDocumentId: REAL_TRIO_FIXTURE_DOCUMENT_ID,
      activeView: { documentId: REAL_TRIO_FIXTURE_DOCUMENT_ID },
      documents: [{ documentId: REAL_TRIO_FIXTURE_DOCUMENT_ID, isActive: true }],
    });
  });

  it("requires the post-control value-free fixture probe to match its acknowledgement", () => {
    const expected = {
      revision: 2,
      cachedContextHash: `sha256:${"a".repeat(64)}`,
      activeDocumentIdentityHash: `sha256:${"b".repeat(64)}`,
      acknowledgementHash: `sha256:${"c".repeat(64)}`,
    };
    expect(() => probeRealTrioFixtureDocumentContext({
      documentContextEvidence: {
        currentRevision: 2,
        cachedContextHash: expected.cachedContextHash,
        activeDocumentIdentityHash: expected.activeDocumentIdentityHash,
        lastControlAcknowledgementHash: expected.acknowledgementHash,
        cacheReadCount: 1,
        pollRequestCount: 1,
      },
    }, expected)).not.toThrow();
    expect(() => probeRealTrioFixtureDocumentContext({
      documentContextEvidence: {
        currentRevision: 1,
        cachedContextHash: expected.cachedContextHash,
        activeDocumentIdentityHash: expected.activeDocumentIdentityHash,
        lastControlAcknowledgementHash: expected.acknowledgementHash,
      },
    }, expected)).toThrow(/does not confirm/u);
  });

  it("refuses missing or mismatched public route evidence before north dispatch", () => {
    expect(hasRealTrioLiveDocumentRoute({ sessions: [] })).toBe(false);
    expect(hasRealTrioLiveDocumentRoute({ sessions: [{ value: {
      lifecycle: { liveDocumentRoute: { sessionDocumentId: "different-document" } },
    } }] })).toBe(false);
    expect(hasRealTrioLiveDocumentRoute({ sessions: [{ value: {
      lifecycle: { liveDocumentRoute: { sessionDocumentId: REAL_TRIO_FIXTURE_DOCUMENT_ID } },
    } }] })).toBe(true);
  });

  it("keeps a durable ACK emitted during public route observation, but rejects an earlier ACK", () => {
    const ack = JSON.stringify({ event: "bridge.document_context_observation", stage: "ack", outcome: "durably_acknowledged" });
    const send = JSON.stringify({ event: "bridge.document_context_observation", stage: "send", outcome: "sent" });
    const expected = { rsidHash: `sha256:${"a".repeat(64)}` as const, sequence: 7,
      sendTranscriptIndex: 0, sendRecordedAt: "2026-08-24T00:00:01.000Z" };
    const correlatedAck = JSON.stringify({ ...JSON.parse(ack), rsidHash: expected.rsidHash, sequence: expected.sequence });
    expect(hasDurableDocumentContextHeartbeatAckSince([{ line: correlatedAck }, { line: send }], 1, expected)).toBe(false);
    expect(hasDurableDocumentContextHeartbeatAckSince([{ line: send }, { line: correlatedAck }], 0, expected)).toBe(true);
    expect(hasDurableDocumentContextHeartbeatAckSince([{ line: send }, { line: JSON.stringify({ ...JSON.parse(ack), rsidHash: expected.rsidHash, sequence: 6 }) }], 1, expected)).toBe(false);
    expect(hasDurableDocumentContextHeartbeatAckSince([{ line: send }, { line: JSON.stringify({ ...JSON.parse(ack), rsidHash: `sha256:${"b".repeat(64)}`, sequence: 7 }) }], 1, expected)).toBe(false);
  });

  it("requires Gateway accepted-route correlation with the intended send", () => {
    const expected = { rsidHash: `sha256:${"a".repeat(64)}` as const, sequence: 7,
      routeDigest: `sha256:${"b".repeat(64)}` as const,
      contextDigest: "c".repeat(64),
      sendTranscriptIndex: 3, sendRecordedAt: "2026-08-24T00:00:01.000Z" };
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const baseline = gatewayAuditBaseline({ documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
      documentContextProcessEpoch: epoch, documentContextObservationHighWaterOrdinal: 4 })!;
    const audit = (rsidHash: string, observedSequence: number, observationOrdinal = 5,
      observedAtUtc = "2026-08-24T00:00:01.000Z", highWater = observationOrdinal, processEpoch = epoch,
      sessionRecordVersion = 4, routeDigest = expected.routeDigest, contextDigest = expected.contextDigest,
      recordDigest = `sha256:${"d".repeat(64)}`, sessionBindingDigest = `sha256:${"e".repeat(64)}`, connectionDigest = `sha256:${"f".repeat(64)}`) => ({ documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1", documentContextProcessEpoch: processEpoch, documentContextGeneration: 1, documentContextObservationHighWaterOrdinal: highWater,
      documentContextCurrentRoute: { processEpoch, rsidHash, observedSequence, contextDigest, routeDigest, recordDigest, sessionBindingDigest, connectionDigest, sessionRecordVersion }, documentContextUpdates: [{
      contractVersion: "revagent.wp12-document-context-audit/v1",
      event: "gateway.doc_context_update_observation", stage: "accepted", processEpoch, rsidHash, observedSequence, contextDigest, routeDigest, recordDigest, sessionBindingDigest, connectionDigest, sessionRecordVersion, observationOrdinal, observedAtUtc,
    }] });
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, expected.sequence), expected, baseline)).toBe(true);
    // The accepted audit projection is deliberately named rsidHash.  A
    // session-list rsidDigest is a different, legacy summary field and must
    // never be accepted as a substitute by the current-route join.
    const acceptedHash = audit(expected.rsidHash, expected.sequence);
    expect(hasGatewayAcceptedDocumentContextRoute(acceptedHash, expected, baseline)).toBe(true);
    expect(acceptedHash.documentContextUpdates[0]).not.toHaveProperty("rsid");
    expect(acceptedHash.documentContextUpdates[0]).not.toHaveProperty("rsidDigest");
    const [{ rsidHash: _removedRsidHash, ...legacyOnly }] = acceptedHash.documentContextUpdates;
    expect(hasGatewayAcceptedDocumentContextRoute({
      ...acceptedHash,
      documentContextUpdates: [{ ...legacyOnly, rsidDigest: expected.rsidHash }],
    }, expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(
      audit("a".repeat(64), expected.sequence), expected, baseline,
    )).toBe(false);
    const routeMismatch = audit(expected.rsidHash, expected.sequence);
    routeMismatch.documentContextUpdates[0] = {
      ...routeMismatch.documentContextUpdates[0],
      routeDigest: `sha256:${"9".repeat(64)}`,
    };
    expect(hasGatewayAcceptedDocumentContextRoute(routeMismatch, expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 6), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(`sha256:${"b".repeat(64)}`, 7), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(`sha256:${"A".repeat(64)}`, 7), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 7, 4), expected, baseline)).toBe(false);
    // Timestamp order is diagnostic-only: causal order is cursor/ordinal and
    // survives wall-clock skew between the real worker and Gateway.
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 7, 5, "2026-08-24T00:00:00.999Z"), expected, baseline)).toBe(true);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 7, 5, "2026-08-24T00:00:01.000Z", 3), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 7, 0), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 7, 5, "2026-08-24T00:00:01.000Z", 5, "123e4567-e89b-42d3-a456-426614174001"), expected, baseline)).toBe(false);
    const duplicate = audit(expected.rsidHash, 7);
    duplicate.documentContextUpdates.push(duplicate.documentContextUpdates[0]!);
    expect(hasGatewayAcceptedDocumentContextRoute(duplicate, expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute({ documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1", documentContextProcessEpoch: epoch, documentContextGeneration: 1, documentContextObservationHighWaterOrdinal: 6, documentContextUpdates: [] }, expected, baseline)).toBe(false);
  });

  it("selects only the controlled post-ACK send and permits its one-record active probe prefix", () => {
    const observation = (stage: string, rsidHash: string, sequence: number) => ({ line: JSON.stringify({
      event: "bridge.document_context_observation", stage,
      outcome: stage === "probe" ? "started" : stage === "snapshot" ? "ready" :
        stage === "queue" ? "durably_queued" : "sent", rsidHash, sequence,
    }) });
    const historicalHash = `sha256:${"a".repeat(64)}`;
    const controlledHash = `sha256:${"b".repeat(64)}`;
    const transcript = [
      observation("probe", historicalHash, 1), observation("snapshot", historicalHash, 1),
      observation("queue", historicalHash, 1), observation("send", historicalHash, 1),
      observation("probe", controlledHash, 2), observation("snapshot", controlledHash, 2),
      observation("queue", controlledHash, 2), observation("send", controlledHash, 2),
    ];
    expect(correlatedDocumentContextSendSince(transcript, 4)).toMatchObject({ rsidHash: controlledHash, sequence: 2, sendTranscriptIndex: 7 });
    expect(correlatedDocumentContextSendSince(transcript, 5)).toMatchObject({ rsidHash: controlledHash, sequence: 2, sendTranscriptIndex: 7 });
  });

  it("admits exactly one active pre-control probe and rejects ambiguous control-floor prefixes", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const otherHash = `sha256:${"b".repeat(64)}`;
    const event = (stage: string, outcome: string, rsidHash = hash, sequence: number | null = null) => ({
      line: JSON.stringify({ event: "bridge.document_context_observation", stage, outcome, rsidHash, sequence }),
    });
    const postFloor = () => [
      event("snapshot", "ready"), event("queue", "durably_queued", hash, 11), event("send", "sent", hash, 11),
    ];

    // The only permitted cross-floor shape: probe immediately before control,
    // then snapshot/queue/send wholly after it.
    expect(correlatedDocumentContextSendSince([event("probe", "started"), ...postFloor()], 1)).toMatchObject({
      rsidHash: hash, sequence: 11, sendTranscriptIndex: 3,
    });
    // A previous completed lifecycle makes the apparent probe stale.
    expect(correlatedDocumentContextSendSince([
      event("probe", "started"), event("snapshot", "ready"), event("queue", "durably_queued", hash, 3),
      event("send", "sent", hash, 3), event("completed", "done", hash, 3), event("probe", "started"), ...postFloor(),
    ], 6)).toBeNull();
    // Prefix and first post-floor snapshot must carry one canonical RSID.
    expect(correlatedDocumentContextSendSince([
      event("probe", "started"), event("snapshot", "ready", otherHash),
      event("queue", "durably_queued", otherHash, 11), event("send", "sent", otherHash, 11),
    ], 1)).toBeNull();
    // A second pre-floor probe is not a unique active prefix.
    expect(correlatedDocumentContextSendSince([
      event("probe", "started"), event("probe", "started"), ...postFloor(),
    ], 2)).toBeNull();
    // Snapshot/queue/send before the floor cannot be borrowed as a prefix.
    expect(correlatedDocumentContextSendSince([
      event("probe", "started"), event("snapshot", "ready"), event("probe", "started"), ...postFloor(),
    ], 3)).toBeNull();
    // A failed pre-floor lifecycle is terminal, even if a later probe appears valid.
    expect(correlatedDocumentContextSendSince([
      event("probe", "started"), event("failure", "snapshot_failed"), event("probe", "started"), ...postFloor(),
    ], 3)).toBeNull();
    // The ordinary fully post-floor lifecycle still requires all four stages.
    expect(correlatedDocumentContextSendSince([
      event("probe", "started"), event("snapshot", "ready"), event("queue", "durably_queued", hash, 11), event("send", "sent", hash, 11),
    ], 0)).toMatchObject({ rsidHash: hash, sequence: 11, sendTranscriptIndex: 3 });
  });

  it("fails closed on mixed, duplicate, skipped, failed, malformed, and pre-send-ACK lifecycles", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const event = (stage: string, outcome: string, rsidHash = hash, sequence: number | null = null) => ({ line: JSON.stringify({
      event: "bridge.document_context_observation", stage, outcome, rsidHash, sequence,
    }) });
    const flow = () => [event("probe", "started"), event("snapshot", "ready"),
      event("queue", "durably_queued", hash, 9), event("send", "sent", hash, 9)];
    expect(correlatedDocumentContextSendSince(flow(), 0)).toMatchObject({ rsidHash: hash, sequence: 9, sendTranscriptIndex: 3 });
    const mixed = flow(); mixed[2] = event("queue", "durably_queued", `sha256:${"b".repeat(64)}`, 9);
    expect(correlatedDocumentContextSendSince(mixed, 0)).toBeNull();
    const mixedSequence = flow(); mixedSequence[3] = event("send", "sent", hash, 10);
    expect(correlatedDocumentContextSendSince(mixedSequence, 0)).toBeNull();
    expect(correlatedDocumentContextSendSince([event("probe", "started"), event("snapshot", "ready"), event("snapshot", "ready"), ...flow().slice(2)], 0)).toBeNull();
    expect(correlatedDocumentContextSendSince([event("probe", "started"), ...flow().slice(2)], 0)).toBeNull();
    expect(correlatedDocumentContextSendSince([event("probe", "started"), event("failure", "snapshot_failed"), ...flow().slice(1)], 0)).toBeNull();
    expect(correlatedDocumentContextSendSince([event("probe", "started", `sha256:${"A".repeat(64)}`), ...flow().slice(1)], 0)).toBeNull();
    expect(correlatedDocumentContextSendSince([event("probe", "started"), event("snapshot", "ready"), event("queue", "durably_queued", hash, 0), event("send", "sent", hash, 0)], 0)).toBeNull();
    const preSendAck = [event("ack", "durably_acknowledged", hash, 9), ...flow()];
    const selected = correlatedDocumentContextSendSince(preSendAck, 1)!;
    expect(hasDurableDocumentContextHeartbeatAckSince(preSendAck, 0, selected)).toBe(false);
    const acknowledged = [...flow(), event("ack", "durably_acknowledged", hash, 9)];
    const acknowledgedSend = correlatedDocumentContextSendSince(acknowledged, 0)!;
    expect(hasDurableDocumentContextHeartbeatAckSince(acknowledged, 0, acknowledgedSend)).toBe(true);
    expect(hasDurableDocumentContextHeartbeatAckSince([...flow(), event("failure", "send_deferred", hash, 9), event("ack", "durably_acknowledged", hash, 9)], 0, acknowledgedSend)).toBe(false);
    expect(hasDurableDocumentContextHeartbeatAckSince([...flow(), event("queue", "durably_queued", hash, 9), event("ack", "durably_acknowledged", hash, 9)], 0, acknowledgedSend)).toBe(false);
    expect(hasDurableDocumentContextHeartbeatAckSince([...acknowledged, event("probe", "started", hash, null)], 0, acknowledgedSend)).toBe(false);
    expect(hasDurableDocumentContextHeartbeatAckSince([...acknowledged, event("ack", "durably_acknowledged", hash, 9)], 0, acknowledgedSend)).toBe(false);
  });

  it("exports bounded redacted stage-timeout evidence before cleanup", () => {
    const transcript = Array.from({ length: 70 }, (_, index) => ({
      line: JSON.stringify({
        contractVersion: "revagent.rbp-document-context-observation/v1",
        event: "bridge.document_context_observation",
        stage: index % 2 === 0 ? "send" : "ack",
        outcome: index % 2 === 0 ? "sent" : "durably_acknowledged",
        sequence: index,
        rsidHash: `sha256:${"a".repeat(64)}`,
        payloadHash: `sha256:${"b".repeat(64)}`,
        documentId: "must-not-persist",
        payload: "must-not-persist",
      }),
    }));
    const failure = createRealTrioDocumentContextFailure({
      reason: "stage_timeout",
      binding: "wss",
      timeline: ["control_ack"],
      transcript,
      fixtureEvidence: { documentContextEvidence: {
        cacheReadCount: 3,
        pollRequestCount: 2,
        cachedContextHash: `sha256:${"c".repeat(64)}`,
        activeDocumentIdentityHash: `sha256:${"d".repeat(64)}`,
        lastControlAcknowledgementHash: `sha256:${"e".repeat(64)}`,
        documentId: "must-not-persist",
      } },
      gatewayAudit: { sessions: Array.from({ length: 35 }, () => ({ value: {
        lifecycle: { liveDocumentRoute: { sessionDocumentId: "must-not-persist" }, sessionLifecycle: { dispatchAllowed: true } },
        bearer: "must-not-persist",
      } })) },
      coherentAudit: {
        documentContextAuditStatus: "retry_exhausted",
        documentContextAuditLastStatus: "observation_churn",
        documentContextAuditAttemptCount: 3,
        documentContextAuditObservationCount: 1,
        documentContextObservationHighWaterOrdinal: 2,
        secret: "must-not-persist",
      },
      coherentAuditControl: { outcome: "success", audit: {} },
      preControlBaseline: { processEpoch: "123e4567-e89b-42d3-a456-426614174000", observationOrdinal: 1,
        acceptedObservationOrdinal: 1, currentIdentity: `sha256:${"f".repeat(64)}` },
      preControlAudit: { documentContextObservationHighWaterOrdinal: 1, documentContextUpdates: [
        { stage: "accepted", secret: "must-not-persist" },
        { stage: "not_accepted", secret: "must-not-persist" },
      ] },
      selectorReason: "source_pair_missing",
      childState: { childExited: false, processDiagnostics: [] },
    });
    const artifact = path.join(mkdtempSync(path.join(tmpdir(), "wp12-doc-evidence-")), "failure.json");
    writeRealTrioDocumentContextFailure(artifact, failure);
    const persisted = readFileSync(artifact, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({
      schemaVersion: "rbp-real-trio-document-context-failure/v1",
      reason: "stage_timeout",
      fixtureSnapshot: { cacheReadCount: 3, pollRequestCount: 2, cachedContextHashPresent: true },
      gatewayCoherentAudit: { status: "retry_exhausted", lastAttemptStatus: "observation_churn", attemptCount: 3, observationCount: 1, highWaterOrdinal: 2 },
      gatewayAuditControl: { outcome: "success", error: null },
      preControlBaselinePresent: true,
      preControlBaseline: { processEpochPresent: true, observationOrdinalPresent: true, highWaterOrdinalPresent: true, retainedUpdateCount: 2 },
      selectorReason: "source_pair_missing",
    });
    expect(failure.documentStages).toHaveLength(64);
    expect(failure.gatewayRouteAudits).toHaveLength(32);
    expect(persisted).not.toContain("must-not-persist");
  });

  it("attaches child-exit evidence with only child diagnostics", () => {
    const failure = createRealTrioDocumentContextFailure({
      reason: "child_exit",
      binding: "streamable_http_sse",
      timeline: ["control_ack", "ordered_stages"],
      transcript: [],
      fixtureEvidence: null,
      gatewayAudit: null,
      coherentAudit: null,
      coherentAuditControl: { outcome: "failure", error: "process_exited", statusCode: null, okKeyPresent: false, actionKeyPresent: false },
      childState: { childExited: true, processDiagnostics: [{
        componentId: "bridge_worker", phase: "document_context_failure", exitCode: 1,
        stdout: [], stderr: ["token=[redacted]"],
      }] },
    });
    const error = new RealTrioDocumentContextFailureError("child exited", failure, new Error("raw cause"));
    expect(error.failureEvidence).toMatchObject({
      reason: "child_exit",
      gatewayAuditControl: { outcome: "failure", error: "process_exited" },
      childState: { childExited: true },
    });
    expect(JSON.stringify(error.failureEvidence)).not.toContain("raw cause");
  });

  it("keeps an invalid audit shape distinct from an empty successful audit", () => {
    const failure = createRealTrioDocumentContextFailure({
      reason: "route_timeout", binding: "wss", timeline: ["control_ack"], transcript: [],
      fixtureEvidence: null, gatewayAudit: null,
      coherentAudit: { documentContextAuditStatus: "retry_exhausted", documentContextAuditLastStatus: "observation_churn",
        documentContextAuditAttemptCount: 3, documentContextAuditObservationCount: 0, documentContextObservationHighWaterOrdinal: 0,
        raw: "must-not-persist" },
      coherentAuditControl: { outcome: "failure", error: "invalid_shape", statusCode: 200, okKeyPresent: true, actionKeyPresent: false },
      childState: { childExited: false, processDiagnostics: [] },
    });
    expect(failure).toMatchObject({
      gatewayCoherentAudit: { status: "retry_exhausted", lastAttemptStatus: "observation_churn" },
      gatewayAuditControl: { outcome: "failure", error: "invalid_shape", statusCode: 200, okKeyPresent: true, actionKeyPresent: false },
    });
    expect(JSON.stringify(failure)).not.toContain("must-not-persist");
  });

  it("keeps WSS and HTTP-SSE runtime failure artifacts isolated after caller re-wrap", () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-runtime-evidence-"));
    const failure = (binding: "wss" | "streamable_http_sse") => ({
      schemaVersion: REAL_TRIO_RUNTIME_FAILURE_SCHEMA,
      binding,
      phase: "credential_issue" as const,
      commandHash: `sha256:${"f".repeat(64)}`,
      childDiagnostics: [],
      documentContextEvidence: null,
      gatewayAuditPresent: false,
      toolEvidence: { action: "issue_north_credential", outcome: "failed" as const },
    });
    let wrapped: Error | undefined;
    try {
      writeRealTrioRuntimeFailure(evidenceDirectory, failure("wss"));
      throw new Error("simulated caller failure");
    } catch (error) {
      wrapped = new Error("caller re-wrap", { cause: error });
    }
    writeRealTrioRuntimeFailure(evidenceDirectory, failure("streamable_http_sse"));
    expect(wrapped).toBeDefined();
    const wss = JSON.parse(readFileSync(path.join(evidenceDirectory, "wss.runtime-failure.json"), "utf8"));
    const http = JSON.parse(readFileSync(path.join(evidenceDirectory, "streamable_http_sse.runtime-failure.json"), "utf8"));
    expect(wss).toMatchObject({ schemaVersion: REAL_TRIO_RUNTIME_FAILURE_SCHEMA, binding: "wss" });
    expect(http).toMatchObject({ schemaVersion: REAL_TRIO_RUNTIME_FAILURE_SCHEMA, binding: "streamable_http_sse" });
  });

  it("writes C38 MCP isError evidence atomically through the actual catch helper without serializing raw result data", () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-mcp-tool-result-"));
    const error = new RealTrioNorthToolResultError({
      httpStatus: 200,
      responseBytes: 911,
      responseSha256: `sha256:${"a".repeat(64)}`,
      resultKeyPresence: { isError: true, structuredContent: true, content: true },
      isError: true,
      contentCount: 1,
      contentItems: [{ type: "text", textUtf8Bytes: 73, textSha256: `sha256:${"b".repeat(64)}` }],
      diagnostic: {
        source: "structured_content",
        structuredContentPresent: true,
        structuredContentObject: true,
        fallbackTextPresent: true,
        fallbackTextObject: true,
        statePresent: true,
        reasonPresent: true,
        codePresent: true,
        errorCodePresent: true,
        nestedErrorCodePresent: true,
        phasePresent: true,
        classPresent: true,
        upstreamCodePresent: true,
        deliveryOutcomePresent: true,
        state: "failed",
        reason: "result_delivery_unavailable",
        code: "unclassified",
        errorCode: "unclassified",
        nestedErrorCode: "unclassified",
        phase: "executor",
        class: "gateway_rbp_fault",
        upstreamCode: "unavailable",
        deliveryOutcome: "not_delivered",
      },
      // Deliberately malicious additions must never cross the copy boundary.
      rawPayload: "token=must-not-persist",
      arbitraryKeyName: "must-not-persist",
    } as never);

    let caught: unknown;
    try {
      rethrowRealTrioC38Failure({ evidenceDirectory, binding: "wss", error });
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(error);
    const persisted = readFileSync(path.join(evidenceDirectory, "mcp-tool-result-failure.json"), "utf8");
    expect(JSON.parse(persisted)).toEqual({
      schemaVersion: REAL_TRIO_MCP_TOOL_RESULT_FAILURE_SCHEMA,
      binding: "wss",
      stage: "north_tool_call",
      resultKeyPresence: { isError: true, structuredContent: true, content: true },
      isError: true,
      content: { count: 1, items: [{ type: "text", textUtf8Bytes: 73, textSha256: `sha256:${"b".repeat(64)}` }] },
      diagnostic: {
        statePresent: true,
        reasonPresent: true,
        codePresent: true,
        errorCodePresent: true,
        nestedErrorCodePresent: true,
        phasePresent: true,
        classPresent: true,
        upstreamCodePresent: true,
        deliveryOutcomePresent: true,
        state: "failed",
        reason: "result_delivery_unavailable",
        code: "unclassified",
        errorCode: "unclassified",
        nestedErrorCode: "unclassified",
        phase: "executor",
        class: "gateway_rbp_fault",
        upstreamCode: "unavailable",
        deliveryOutcome: "not_delivered",
      },
    });
    expect(persisted).not.toContain("must-not-persist");
    expect(persisted).not.toContain("rawPayload");
    expect(persisted).not.toContain("arbitraryKeyName");
  });

  it("records bounded collision evidence on an MCP artifact collision without masking the original error", () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-mcp-tool-result-secondary-"));
    writeFileSync(path.join(evidenceDirectory, "mcp-tool-result-failure.json"), "{\"preexisting\":true}\n", { encoding: "utf8" });
    const error = new RealTrioNorthToolResultError({
      httpStatus: 200,
      responseBytes: 1,
      responseSha256: `sha256:${"c".repeat(64)}`,
      resultKeyPresence: { isError: true, structuredContent: false, content: false },
      isError: true,
      contentCount: 0,
      contentItems: [],
      diagnostic: {
        source: "none",
        structuredContentPresent: false,
        structuredContentObject: false,
        fallbackTextPresent: false,
        fallbackTextObject: false,
        statePresent: false,
        reasonPresent: false,
        codePresent: false,
        errorCodePresent: false,
        nestedErrorCodePresent: false,
        deliveryOutcomePresent: false,
        state: null,
        reason: null,
        code: null,
        errorCode: null,
        nestedErrorCode: null,
        deliveryOutcome: null,
      },
    });
    let caught: unknown;
    try {
      rethrowRealTrioC38Failure({ evidenceDirectory, binding: "streamable_http_sse", error });
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(error);
    const secondary = JSON.parse(readFileSync(path.join(evidenceDirectory, "mcp-tool-result-failure-collision-0.json"), "utf8"));
    expect(secondary).toMatchObject({
      schemaVersion: REAL_TRIO_MCP_TOOL_RESULT_WRITE_FAILURE_SCHEMA,
      binding: "streamable_http_sse",
      stage: "north_tool_call",
      originalError: "RealTrioNorthToolResultError",
      primaryArtifactOutcome: "collision",
      primaryEvidenceSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(secondary)).not.toContain("preexisting");
  });

  it("keeps one immutable primary under Promise.all contention, caps collision records, and removes every temporary", async () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-mcp-tool-result-race-"));
    const error = new RealTrioNorthToolResultError({
      httpStatus: 200,
      responseBytes: 4,
      responseSha256: `sha256:${"d".repeat(64)}`,
      resultKeyPresence: { isError: true, structuredContent: false, content: false },
      isError: true,
      contentCount: 0,
      contentItems: [],
      diagnostic: {
        source: "none", structuredContentPresent: false, structuredContentObject: false,
        fallbackTextPresent: false, fallbackTextObject: false, statePresent: false,
        reasonPresent: false, codePresent: false, errorCodePresent: false,
        nestedErrorCodePresent: false, deliveryOutcomePresent: false, state: null,
        reason: null, code: null, errorCode: null, nestedErrorCode: null, deliveryOutcome: null,
      },
    });
    const outcomes = await Promise.all(Array.from({ length: 16 }, async () => {
      await Promise.resolve();
      return persistRealTrioMcpToolResultFailure({ evidenceDirectory, binding: "wss", error });
    }));
    expect(outcomes.filter((outcome) => outcome?.primaryWritten === true)).toHaveLength(1);
    const primary = readFileSync(path.join(evidenceDirectory, "mcp-tool-result-failure.json"), "utf8");
    expect(JSON.parse(primary)).toMatchObject({
      schemaVersion: REAL_TRIO_MCP_TOOL_RESULT_FAILURE_SCHEMA,
      binding: "wss",
      isError: true,
    });
    const collisionFiles = readdirSync(evidenceDirectory)
      .filter((filename) => /^mcp-tool-result-failure-collision-[0-7]\.json$/u.test(filename));
    expect(collisionFiles.length).toBeLessThanOrEqual(8);
    expect(collisionFiles.length).toBeGreaterThan(0);
    expect(readdirSync(evidenceDirectory).filter((filename) => filename.endsWith(".tmp"))).toEqual([]);
    expect(readFileSync(path.join(evidenceDirectory, "mcp-tool-result-failure.json"), "utf8")).toBe(primary);
  });

  it("emits bounded write-failure evidence when link publication fails and still cleans the temporary", () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-mcp-tool-result-link-fail-"));
    const error = new RealTrioNorthToolResultError({
      httpStatus: 200,
      responseBytes: 4,
      responseSha256: `sha256:${"e".repeat(64)}`,
      resultKeyPresence: { isError: true, structuredContent: false, content: false },
      isError: true,
      contentCount: 0,
      contentItems: [],
      diagnostic: {
        source: "none", structuredContentPresent: false, structuredContentObject: false,
        fallbackTextPresent: false, fallbackTextObject: false, statePresent: false,
        reasonPresent: false, codePresent: false, errorCodePresent: false,
        nestedErrorCodePresent: false, deliveryOutcomePresent: false, state: null,
        reason: null, code: null, errorCode: null, nestedErrorCode: null, deliveryOutcome: null,
      },
    });
    const result = persistRealTrioMcpToolResultFailure({
      evidenceDirectory,
      binding: "wss",
      error,
      publishForTest: (temporary, destination) => {
        if (destination.endsWith("mcp-tool-result-failure.json")) {
          throw Object.assign(new Error("injected publish failure"), { code: "EPERM" });
        }
        linkSync(temporary, destination);
      },
    });
    expect(result).toMatchObject({ primaryWritten: false, secondaryWritten: true });
    const secondary = JSON.parse(readFileSync(path.join(evidenceDirectory, "mcp-tool-result-failure-write-failure.json"), "utf8"));
    expect(secondary).toMatchObject({
      schemaVersion: REAL_TRIO_MCP_TOOL_RESULT_WRITE_FAILURE_SCHEMA,
      primaryArtifactOutcome: "write_failed",
    });
    expect(readdirSync(evidenceDirectory).filter((filename) => filename.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves non-MCP errors unchanged and writes no MCP failure artifact", () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-mcp-tool-result-non-mcp-"));
    const error = new Error("ordinary runtime failure");
    let caught: unknown;
    try {
      rethrowRealTrioC38Failure({ evidenceDirectory, binding: "wss", error });
    } catch (failure) {
      caught = failure;
    }
    expect(caught).toBe(error);
    expect(() => readFileSync(path.join(evidenceDirectory, "mcp-tool-result-failure.json"), "utf8")).toThrow();
  });
});
