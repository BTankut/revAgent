import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  REAL_TRIO_FIXTURE_DOCUMENT_ID,
  REAL_TRIO_RUNTIME_FAILURE_SCHEMA,
  RealTrioDocumentContextFailureError,
  correlatedDocumentContextSendSince,
  correlatedDocumentContextSendFromCursor,
  createRealTrioDocumentContextFailure,
  gatewayAuditBaseline,
  hasGatewayAcceptedDocumentContextRoute,
  hasDurableDocumentContextHeartbeatAckSince,
  hasDurableDocumentContextHeartbeatAckFromCursor,
  hasRealTrioLiveDocumentRoute,
  probeRealTrioFixtureDocumentContext,
  realTrioWorkerBuildPlan,
  realTrioFixtureDocumentContextEvent,
  selectCurrentDocumentContextSendFromCursor,
  writeRealTrioDocumentContextFailure,
  writeRealTrioRuntimeFailure,
  unmatchedDocumentContextProbe,
} from "./realTrioRuntimeFixture.js";

describe("WP-12 real-trio fixture document route gate", () => {
  const cursorRow = (cursor: string, stage: string, outcome: string, sequence: number | null,
    hash = `sha256:${"a".repeat(64)}`) => ({ cursor, at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({
      event: "bridge.document_context_observation", stage, outcome, rsidHash: hash, sequence,
    }) });

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
    expect(hasDurableDocumentContextHeartbeatAckFromCursor([
      cursorRow("8", "ack", "durably_acknowledged", 9, hash),
    ], selected!)).toBe(true);
    expect(hasDurableDocumentContextHeartbeatAckFromCursor([
      cursorRow("8", "ack", "durably_acknowledged", 8, hash),
    ], selected!)).toBe(false);
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

  it("selects only the current coherent route lifecycle when seq1 advances to seq2", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const digest1 = `sha256:${"b".repeat(64)}`;
    const digest2 = `sha256:${"c".repeat(64)}`;
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const row = (cursor: number, stage: string, sequence: number, routeDigest: string) => cursorRow(
      String(cursor), stage, stage === "probe" ? "started" : stage === "snapshot" ? "ready" :
        stage === "queue" ? "durably_queued" : "sent", sequence, hash,
    ).line;
    const lifecycle = (start: number, sequence: number, routeDigest: string) => ["probe", "snapshot", "queue", "send"].map((stage, offset) => ({
      cursor: String(start + offset), at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({
        ...JSON.parse(row(start + offset, stage, sequence, routeDigest)),
        ...(stage === "send" ? { routeDigest } : {}),
      }),
    }));
    const audit = (sequence: number, routeDigest: string, version = 3) => ({
      documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
      documentContextProcessEpoch: epoch,
      documentContextGeneration: 1,
      documentContextObservationHighWaterOrdinal: 9,
      documentContextCurrentRoute: { processEpoch: epoch, rsidHash: hash, observedSequence: sequence, routeDigest, sessionRecordVersion: version },
      documentContextUpdates: [{
        contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted",
        processEpoch: epoch, rsidHash: hash, observedSequence: sequence, routeDigest, sessionRecordVersion: version, observationOrdinal: 9,
      }],
    });
    const select = (rows: readonly ReturnType<typeof lifecycle>[number][], value: unknown) => selectCurrentDocumentContextSendFromCursor({
      rows, generation: 1, controlCursor: "0", precedingProbe: null, audit: value,
      baseline: { processEpoch: epoch, observationOrdinal: 4 },
    });
    const both = [...lifecycle(1, 1, digest1), ...lifecycle(5, 2, digest2)];
    expect(select(both, audit(2, digest2))).toMatchObject({ sequence: 2, sendCursor: "8", routeDigest: digest2 });
    expect(select(lifecycle(1, 1, digest1), audit(2, digest2))).toBeNull();
    expect(select(both, audit(2, `sha256:${"d".repeat(64)}`))).toBeNull();
    expect(select(both, { ...audit(2, digest2), documentContextGeneration: 2 })).toBeNull();
    expect(select([{ ...both[0]!, cursor: "2" }, ...both.slice(1)], audit(2, digest2))).toBeNull();
  });

  it("fails closed on duplicate lifecycle, ambiguous audit, ACK-before-send, and record-version race", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const digest = `sha256:${"b".repeat(64)}`;
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const event = (cursor: number, stage: string, outcome: string, sequence: number) => ({ cursor: String(cursor), at: "2026-08-24T00:00:01.000Z", line: JSON.stringify({
      event: "bridge.document_context_observation", stage, outcome, rsidHash: hash, sequence,
      ...(stage === "send" ? { routeDigest: digest } : {}),
    }) });
    const flow = [event(1, "probe", "started", 2), event(2, "snapshot", "ready", 2), event(3, "queue", "durably_queued", 2), event(4, "send", "sent", 2)];
    const current = { processEpoch: epoch, rsidHash: hash, observedSequence: 2, routeDigest: digest, sessionRecordVersion: 4 };
    const audit = (updates: readonly unknown[] = [{ contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, observationOrdinal: 5 }]) => ({
      documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1", documentContextProcessEpoch: epoch,
      documentContextGeneration: 1, documentContextObservationHighWaterOrdinal: 5, documentContextCurrentRoute: current,
      documentContextUpdates: updates,
    });
    const select = (rows: readonly typeof flow[number][], value: unknown) => selectCurrentDocumentContextSendFromCursor({ rows, generation: 1, controlCursor: "0", precedingProbe: null, audit: value, baseline: { processEpoch: epoch, observationOrdinal: 4 } });
    expect(select([event(1, "ack", "durably_acknowledged", 2), ...flow], audit())).toBeNull();
    expect(select([flow[0]!, flow[1]!, flow[1]!, flow[2]!, flow[3]!], audit())).toBeNull();
    expect(select(flow, audit([{ contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, observationOrdinal: 5 }, { contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, observationOrdinal: 5 }]))).toBeNull();
    expect(select(flow, audit([{ contractVersion: "revagent.wp12-document-context-audit/v1", event: "gateway.doc_context_update_observation", stage: "accepted", ...current, sessionRecordVersion: 3, observationOrdinal: 5 }]))).toBeNull();
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
      sendTranscriptIndex: 3, sendRecordedAt: "2026-08-24T00:00:01.000Z" };
    const epoch = "123e4567-e89b-42d3-a456-426614174000";
    const baseline = gatewayAuditBaseline({ documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1",
      documentContextProcessEpoch: epoch, documentContextObservationHighWaterOrdinal: 4 })!;
    const audit = (rsidHash: string, observedSequence: number, observationOrdinal = 5,
      observedAtUtc = "2026-08-24T00:00:01.000Z", highWater = observationOrdinal, processEpoch = epoch,
      sessionRecordVersion = 4, routeDigest = expected.routeDigest) => ({ documentContextEpochSchema: "revagent.wp12-document-context-epoch/v1", documentContextProcessEpoch: processEpoch, documentContextGeneration: 1, documentContextObservationHighWaterOrdinal: highWater,
      documentContextCurrentRoute: { processEpoch, rsidHash, observedSequence, routeDigest, sessionRecordVersion }, documentContextUpdates: [{
      contractVersion: "revagent.wp12-document-context-audit/v1",
      event: "gateway.doc_context_update_observation", stage: "accepted", processEpoch, rsidHash, observedSequence, routeDigest, sessionRecordVersion, observationOrdinal, observedAtUtc,
    }] });
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, expected.sequence), expected, baseline)).toBe(true);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 6), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(`sha256:${"b".repeat(64)}`, 7), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(`sha256:${"A".repeat(64)}`, 7), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 7, 4), expected, baseline)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 7, 5, "2026-08-24T00:00:00.999Z"), expected, baseline)).toBe(false);
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
      childState: { childExited: false, processDiagnostics: [] },
    });
    const artifact = path.join(mkdtempSync(path.join(tmpdir(), "wp12-doc-evidence-")), "failure.json");
    writeRealTrioDocumentContextFailure(artifact, failure);
    const persisted = readFileSync(artifact, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({
      schemaVersion: "rbp-real-trio-document-context-failure/v1",
      reason: "stage_timeout",
      fixtureSnapshot: { cacheReadCount: 3, pollRequestCount: 2, cachedContextHashPresent: true },
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
      childState: { childExited: true, processDiagnostics: [{
        componentId: "bridge_worker", phase: "document_context_failure", exitCode: 1,
        stdout: [], stderr: ["token=[redacted]"],
      }] },
    });
    const error = new RealTrioDocumentContextFailureError("child exited", failure, new Error("raw cause"));
    expect(error.failureEvidence).toMatchObject({
      reason: "child_exit",
      childState: { childExited: true },
    });
    expect(JSON.stringify(error.failureEvidence)).not.toContain("raw cause");
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
});
