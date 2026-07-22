import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluatePassingRun, runReportToJUnitXml, stableJson } from "../src/index.js";
import type { ArtifactEvidence } from "../src/index.js";
import { artifact, createPassingReport, materializeRunEvidence, rewriteArtifact } from "./helpers.js";

function withEvidence<T>(action: (root: string, report: ReturnType<typeof createPassingReport>) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), "rbp-evidence-"));
  try {
    return action(root, materializeRunEvidence(createPassingReport(), root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function requiredArtifact(report: ReturnType<typeof createPassingReport>, kind: ArtifactEvidence["kind"]): ArtifactEvidence {
  return [...report.artifacts, ...report.cases.flatMap(({ artifacts }) => artifacts)].find((entry) => entry.kind === kind)!;
}

describe("retained run evidence content", () => {
  it("accepts nonempty, hashed, semantically bound local evidence", () => {
    withEvidence((root, report) => {
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation).toMatchObject({ ok: true });
    });
  });

  it.each(["wire_trace", "journal_snapshot", "junit", "leak_metrics", "component_log"] as const)(
    "rejects a zero-byte %s even when its empty digest and size are declared honestly",
    (kind) => {
      withEvidence((root, report) => {
        const emptyArtifact = requiredArtifact(report, kind);
        rewriteArtifact(root, emptyArtifact, "");
        if (kind === "journal_snapshot") {
          report.cases[0]!.assertions.forEach((assertion) => {
            assertion.evidenceSha256 = emptyArtifact.sha256;
          });
        }
        const result = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
        expect(result.ok).toBe(false);
        expect(result.issues.map(({ code }) => code)).toContain("artifact.zero_bytes");
      });
    },
  );

  it("does not accept expected/actual booleans without matching retained assertion content", () => {
    withEvidence((root, report) => {
      const result = report.cases[0]!;
      const journal = result.artifacts.find(({ kind }) => kind === "journal_snapshot")!;
      rewriteArtifact(
        root,
        journal,
        stableJson({
          schemaVersion: "rbp-case-evidence/v1",
          runId: report.run.runId,
          caseId: result.caseId,
          source: "journal_snapshot",
          assertions: [],
        }),
      );
      result.assertions.forEach((assertion) => {
        assertion.evidenceSha256 = journal.sha256;
      });
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.ok).toBe(false);
      expect(validation.issues.map(({ code }) => code)).toContain("assertion.content_mismatch");
    });
  });

  it("binds canonical assertion ids and statements into retained evidence content", () => {
    withEvidence((root, report) => {
      const result = report.cases[39]!;
      const journal = result.artifacts.find(({ kind }) => kind === "journal_snapshot")!;
      const content = JSON.parse(readFileSync(path.join(root, journal.path), "utf8")) as {
        assertions: Array<{ assertionId: string; statement: string }>;
      };
      content.assertions[0]!.assertionId = "O1-C40-GENERIC";
      content.assertions[0]!.statement = "generic artifact assertion";
      rewriteArtifact(root, journal, stableJson(content));
      result.assertions.forEach((assertion) => {
        assertion.evidenceSha256 = journal.sha256;
      });
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("assertion.content_mismatch");
    });
  });

  it("parses JUnit totals and case statuses instead of trusting its hash", () => {
    withEvidence((root, report) => {
      const junit = requiredArtifact(report, "junit");
      const changed = runReportToJUnitXml(report)
        .replace('tests="40"', 'tests="39"')
        .replace(/(<testcase[^\n]+)\/>/u, '$1><skipped message="forged"/></testcase>');
      rewriteArtifact(root, junit, changed);
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toEqual(
        expect.arrayContaining(["artifact.junit_totals", "artifact.junit_case_mismatch", "artifact.junit_nondeterministic"]),
      );
    });
  });

  it("parses leak/timing metrics and binds them to report summary fields", () => {
    withEvidence((root, report) => {
      const metrics = requiredArtifact(report, "leak_metrics");
      rewriteArtifact(
        root,
        metrics,
        stableJson({
          schemaVersion: "rbp-conformance-leaks/v1",
          runId: report.run.runId,
          timing: report.timing,
          leaks: { ...report.leaks, residentBytesDelta: 1 },
        }),
      );
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("artifact.leak_metrics_mismatch");
    });
  });

  it("parses component identity/process logs instead of trusting nonempty bytes", () => {
    withEvidence((root, report) => {
      const log = requiredArtifact(report, "component_log");
      const current = JSON.parse(readFileSync(path.join(root, log.path), "utf8")) as Record<string, unknown>;
      current.interfaceVersion = "stale-interface";
      rewriteArtifact(root, log, `${JSON.stringify(current)}\n`);
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("artifact.component_log_mismatch");
    });
  });

  it("rejects malformed nonempty wire JSON Lines", () => {
    withEvidence((root, report) => {
      rewriteArtifact(root, requiredArtifact(report, "wire_trace"), "not-json\n");
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("artifact.invalid_json");
    });
  });

  it("rejects a retained path that escapes through a directory symlink or Windows junction", () => {
    withEvidence((root, report) => {
      const wire = requiredArtifact(report, "wire_trace");
      const wireDirectory = path.dirname(path.join(root, wire.path));
      const outsideDirectory = path.join(root, "outside-retained-wire");
      renameSync(wireDirectory, outsideDirectory);
      symlinkSync(outsideDirectory, wireDirectory, process.platform === "win32" ? "junction" : "dir");
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("artifact.reparse_escape");
    });
  });

  it("rejects assertion evidence placed outside the canonical retained root", () => {
    withEvidence((root, report) => {
      const result = report.cases[0]!;
      const outside = artifact("case_evidence", "outside/assertion.json", 9000);
      rewriteArtifact(
        root,
        outside,
        stableJson({
          schemaVersion: "rbp-case-evidence/v1",
          runId: report.run.runId,
          caseId: result.caseId,
          source: "case_evidence",
          assertions: result.assertions.map(({ assertionId, subvectorId, statement, category, passed, expected, actual }) => ({
            assertionId,
            subvectorId,
            statement,
            category,
            passed,
            expected,
            actual,
          })),
        }),
      );
      result.artifacts.push(outside);
      result.assertions[0]!.evidenceSha256 = outside.sha256;
      const validation = evaluatePassingRun(report, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("artifact.outside_retained_root");
    });
  });
});

describe("run/process timestamp evidence", () => {
  it("rejects reversed or duration-mismatched run timestamps", () => {
    const report = createPassingReport();
    report.run.finishedAt = new Date(Date.parse(report.run.startedAt!) - 1).toISOString();
    const codes = evaluatePassingRun(report).issues.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining(["timing.reversed", "timing.duration_mismatch"]));
  });

  it("rejects component intervals outside the run and ready-before-started ordering", () => {
    const report = createPassingReport();
    report.components[0]!.process.readyAt = new Date(Date.parse(report.components[0]!.process.startedAt!) - 1).toISOString();
    report.components[1]!.process.startedAt = new Date(Date.parse(report.run.startedAt!) - 1).toISOString();
    const codes = evaluatePassingRun(report).issues.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining(["timing.process_order", "timing.process_outside_run"]));
  });

  it("rejects case intervals outside their run", () => {
    const report = createPassingReport();
    report.cases[0]!.startedAt = new Date(Date.parse(report.run.startedAt!) - 10).toISOString();
    report.cases[0]!.finishedAt = report.run.startedAt;
    const codes = evaluatePassingRun(report).issues.map(({ code }) => code);
    expect(codes).toContain("timing.outside_run");
  });
});
