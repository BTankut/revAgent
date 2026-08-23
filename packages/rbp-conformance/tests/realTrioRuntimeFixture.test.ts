import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  REAL_TRIO_FIXTURE_DOCUMENT_ID,
  REAL_TRIO_RUNTIME_FAILURE_SCHEMA,
  RealTrioDocumentContextFailureError,
  createRealTrioDocumentContextFailure,
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
    expect(hasDurableDocumentContextHeartbeatAckSince([{ line: ack }, { line: send }], 1)).toBe(false);
    expect(hasDurableDocumentContextHeartbeatAckSince([{ line: send }, { line: ack }], 1)).toBe(true);
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
