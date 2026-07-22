import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluatePassingRun, validateRunReportStructure } from "../src/index.js";
import { createPassingReport } from "./helpers.js";

function codes(value: unknown): string[] {
  return evaluatePassingRun(value).issues.map(({ code }) => code);
}

describe("fail-closed run validation", () => {
  it("accepts a fully evidenced synthetic shape used only by the validator tests", () => {
    expect(evaluatePassingRun(createPassingReport()).ok).toBe(true);
  });

  it.each([
    ["missing case", (report: ReturnType<typeof createPassingReport>) => report.cases.pop(), "schema.minItems"],
    ["duplicate case", (report: ReturnType<typeof createPassingReport>) => { report.cases[1] = structuredClone(report.cases[0]!); }, "case.duplicate"],
    ["unknown case", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.caseId = "O1-C41"; }, "schema.pattern"],
    ["skipped case", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.status = "skipped"; }, "case.not_passed"],
    ["nonterminal case", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.status = "running"; }, "case.not_passed"],
    ["manifest version mismatch", (report: ReturnType<typeof createPassingReport>) => { (report.manifest as { specVersion: string }).specVersion = "0.9"; }, "schema.const"],
    ["stale component version", (report: ReturnType<typeof createPassingReport>) => { report.components[0]!.observedIdentity!.version = "stale"; }, "component.stale"],
    ["missing observed component", (report: ReturnType<typeof createPassingReport>) => { report.components[0]!.observedIdentity = null; }, "component.not_observed"],
    ["placeholder artifact hash", (report: ReturnType<typeof createPassingReport>) => { report.artifacts[0]!.sha256 = "0".repeat(64); }, "artifact.placeholder_hash"],
    ["false assertion", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.assertions[0]!.passed = false; }, "assertion.false_green"],
    ["renamed assertion id", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.assertions[0]!.assertionId = "O1-C01-GENERIC"; }, "case.assertion_contract"],
    ["generic assertion statement", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.assertions[0]!.statement = "generic pass"; }, "case.assertion_contract"],
    ["changed expected semantics", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.assertions[0]!.expected = false; }, "case.assertion_contract"],
    ["unmet expected semantics", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.assertions[0]!.actual = false; }, "assertion.unmet_expected"],
    ["omitted C40 sub-vector", (report: ReturnType<typeof createPassingReport>) => { report.cases[39]!.assertions.pop(); }, "case.assertion_contract"],
    ["missing assertion evidence", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.assertions[0]!.evidenceSha256 = null; }, "assertion.missing_evidence"],
    ["missing required wire trace", (report: ReturnType<typeof createPassingReport>) => { report.cases[0]!.artifacts.shift(); }, "artifact.required"],
    ["fd leak", (report: ReturnType<typeof createPassingReport>) => {
      report.resources.samples.at(-1)!.openFileDescriptorCount += 1;
      report.resources.evaluation!.openFileDescriptorGrowth = 1;
      report.resources.evaluation!.passed = false;
      report.leaks.openFileDescriptorDelta = 1;
    }, "run.resource_leak"],
    ["false run exit", (report: ReturnType<typeof createPassingReport>) => { report.run.exitCode = 1; }, "run.incomplete"],
  ])("rejects %s", (_name, mutate, expectedCode) => {
    const report = createPassingReport();
    mutate(report);
    expect(codes(report)).toContain(expectedCode);
  });

  it("rejects an absent required hash field at schema level", () => {
    const report = createPassingReport() as unknown as { artifacts: Array<Record<string, unknown>> };
    delete report.artifacts[0]!.sha256;
    expect(validateRunReportStructure(report).issues.map(({ code }) => code)).toContain("schema.required");
  });

  it("optionally verifies retained files instead of trusting declared hashes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-conformance-"));
    try {
      const result = evaluatePassingRun(createPassingReport(), { verifyArtifactFiles: true, artifactRoot: root });
      expect(result.ok).toBe(false);
      expect(result.issues.some(({ code }) => code === "artifact.missing")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
