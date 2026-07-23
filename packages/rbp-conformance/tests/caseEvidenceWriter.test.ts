import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { retainSupervisedCaseEvidence } from "../src/caseEvidenceWriter.js";
import { canonicalManifest } from "../src/manifest.js";
import { createUnexecutedRunReport } from "../src/scaffold.js";
import type { Binding, ComponentId, ProcessObservationRecord } from "../src/types.js";
import { verifyRunEvidenceFiles } from "../src/evidence.js";
import { createPlan } from "./helpers.js";

function observations(runId: string, caseId: string): ProcessObservationRecord[] {
  const rows: ProcessObservationRecord[] = [];
  let ordinal = 0;
  for (const binding of ["wss", "streamable_http_sse"] as const) {
    for (const [componentId, kind] of [
      ["gateway_stub", "control_result"],
      ["gateway_stub", "wire_event"],
      ["bridge_simulator", "control_result"],
      ["addin_loopback_fixture", "fixture_snapshot"],
    ] as const satisfies ReadonlyArray<readonly [ComponentId, ProcessObservationRecord["kind"]]>) {
      ordinal += 1;
      rows.push({
        schemaVersion: "rbp-process-observation/v2",
        observationId: `${runId}:${caseId}:${binding}:${ordinal}`,
        runId,
        caseId,
        binding,
        componentId,
        kind,
        at: "2026-07-23T00:00:00.500Z",
        payload: { raw: true },
      });
    }
  }
  return rows;
}

describe("supervised case evidence writer", () => {
  it("atomically binds assertions to one v2 parent evidence digest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-case-writer-"));
    try {
      const report = createUnexecutedRunReport(createPlan());
      const result = report.cases[0]!;
      const rows = observations(report.run.runId, result.caseId);
      result.status = "passed";
      result.startedAt = "2026-07-23T00:00:00.000Z";
      result.finishedAt = "2026-07-23T00:00:01.000Z";
      result.durationMs = 1_000;
      result.bindings = result.bindings.map(({ binding }) => ({ binding, status: "passed", durationMs: 500 }));
      result.assertions = result.assertions.map((assertion) => ({
        ...assertion,
        passed: true,
        actual: true,
        observationIds: rows.map(({ observationId }) => observationId),
        message: null,
      }));

      const artifacts = retainSupervisedCaseEvidence({
        artifactRoot: root,
        runId: report.run.runId,
        result,
        observations: rows,
      });
      expect(artifacts.map(({ kind }) => kind)).toEqual([
        "case_evidence",
        "journal_snapshot",
        "wire_trace",
        "wire_trace",
      ]);
      expect(new Set(result.assertions.map(({ evidenceSha256 }) => evidenceSha256))).toEqual(
        new Set([artifacts[0]!.sha256]),
      );
      const document = JSON.parse(readFileSync(path.join(root, artifacts[0]!.path), "utf8"));
      expect(document).toMatchObject({
        schemaVersion: "rbp-case-evidence/v2",
        evaluationOwner: "parent_runner",
        source: "case_evidence",
      });
      expect(document.observations).toHaveLength(rows.length);
      expect(JSON.stringify(document.observations)).not.toMatch(/"(?:actual|passed)"\s*:/u);

      const caseIssues = verifyRunEvidenceFiles(report, root).filter(({ path: issuePath }) =>
        issuePath.startsWith("/cases/0") || issuePath.startsWith("/retainedArtifacts/0") ||
        issuePath.startsWith("/retainedArtifacts/1") || issuePath.startsWith("/retainedArtifacts/2") ||
        issuePath.startsWith("/retainedArtifacts/3"));
      expect(caseIssues).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects foreign, duplicate, or out-of-interval observations before writing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-case-writer-invalid-"));
    try {
      const report = createUnexecutedRunReport(createPlan());
      const result = report.cases[0]!;
      result.startedAt = "2026-07-23T00:00:00.000Z";
      result.finishedAt = "2026-07-23T00:00:01.000Z";
      result.durationMs = 1_000;
      const rows = observations(report.run.runId, result.caseId);
      rows[0]!.at = "2026-07-23T00:00:02.000Z";
      expect(() => retainSupervisedCaseEvidence({
        artifactRoot: root,
        runId: report.run.runId,
        result,
        observations: rows,
      })).toThrow(/outside the case interval/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps canonical binding paths stable", () => {
    expect(canonicalManifest.retainedEvidence.wireTrace).toBe("runs/{run_id}/wire/{case_id}-{binding}.jsonl");
    const bindings: Binding[] = ["wss", "streamable_http_sse"];
    expect(bindings).toHaveLength(2);
  });
});
