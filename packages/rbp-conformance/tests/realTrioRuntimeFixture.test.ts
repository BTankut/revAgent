import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  REAL_TRIO_FIXTURE_DOCUMENT_ID,
  REAL_TRIO_RUNTIME_FAILURE_SCHEMA,
  RealTrioDocumentContextFailureError,
  correlatedDocumentContextSendSince,
  createRealTrioDocumentContextFailure,
  hasGatewayAcceptedDocumentContextRoute,
  hasDurableDocumentContextHeartbeatAckSince,
  hasRealTrioLiveDocumentRoute,
  probeRealTrioFixtureDocumentContext,
  realTrioWorkerBuildPlan,
  realTrioFixtureDocumentContextEvent,
  writeRealTrioDocumentContextFailure,
  writeRealTrioRuntimeFailure,
} from "./realTrioRuntimeFixture.js";

describe("WP-12 real-trio fixture document route gate", () => {
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
      sendTranscriptIndex: 3, sendRecordedAt: null };
    const audit = (rsidHash: string, observedSequence: number) => ({ documentContextUpdates: [{
      contractVersion: "revagent.wp12-document-context-audit/v1",
      event: "gateway.doc_context_update_observation", stage: "accepted", rsidHash, observedSequence,
    }] });
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, expected.sequence), expected)).toBe(true);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(expected.rsidHash, 6), expected)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(`sha256:${"b".repeat(64)}`, 7), expected)).toBe(false);
    expect(hasGatewayAcceptedDocumentContextRoute(audit(`sha256:${"A".repeat(64)}`, 7), expected)).toBe(false);
  });

  it("selects only the controlled post-ACK send and rejects a borrowed historical route", () => {
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
    expect(correlatedDocumentContextSendSince(transcript, 5)).toBeNull();
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
