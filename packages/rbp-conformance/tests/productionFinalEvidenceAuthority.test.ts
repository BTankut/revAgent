import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliSource = readFileSync(
  path.join(packageRoot, "src", "cli.ts"),
  "utf8",
);
const finalWorkflowStart = cliSource.indexOf(
  "export async function runFinalEvidenceAsyncCli(",
);
const finalWorkflowEnd = cliSource.indexOf(
  "\nfunction resolveFrom(",
  finalWorkflowStart,
);
const finalWorkflow = cliSource.slice(finalWorkflowStart, finalWorkflowEnd);

describe("authoritative final-evidence composition", () => {
  it("has one literal PASS source and routes it only through the final command", () => {
    expect(finalWorkflowStart).toBeGreaterThanOrEqual(0);
    expect(finalWorkflowEnd).toBeGreaterThan(finalWorkflowStart);
    expect(cliSource.match(/PASS/gu)).toHaveLength(1);
    expect(finalWorkflow).toContain(
      'process.stdout.write("RBP FINAL EVIDENCE: PASS\\n")',
    );
    expect(cliSource).toContain(
      'args[0] === "run-final-evidence"',
    );
  });

  it("composes real run, aggregate, and fixed one-hour soak in one process", () => {
    const runIndex = finalWorkflow.indexOf(
      "await executeProductionConformanceRun({",
    );
    const aggregateIndex = finalWorkflow.indexOf(
      "createThreeRunAggregate(runInputs)",
    );
    const soakIndex = finalWorkflow.indexOf("await runReconnectSoak({");
    const finalValidationIndex = finalWorkflow.lastIndexOf(
      "assertAggregateAndSoakShareExactCandidate(",
    );
    const passIndex = finalWorkflow.indexOf("RBP FINAL EVIDENCE: PASS");

    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(finalWorkflow.match(/executeProductionConformanceRun/gu))
      .toHaveLength(1);
    expect(finalWorkflow).toMatch(
      /for \(const \[index, plan\] of context\.runPlans\.entries\(\)\)/u,
    );
    expect(aggregateIndex).toBeGreaterThan(runIndex);
    expect(soakIndex).toBeGreaterThan(aggregateIndex);
    expect(finalWorkflow.slice(soakIndex)).toContain('mode: "one_hour"');
    expect(finalValidationIndex).toBeGreaterThan(soakIndex);
    expect(passIndex).toBeGreaterThan(finalValidationIndex);
  });

  it("uses returned objects and exact retained bytes without production seams", () => {
    expect(finalWorkflow).toContain("result.report");
    expect(finalWorkflow).toContain("soakResult.report");
    expect(finalWorkflow.match(/readExactRetainedJson/gu)?.length)
      .toBeGreaterThanOrEqual(6);
    expect(finalWorkflow.match(/assertFinalPlanSnapshotsCurrent/gu)?.length)
      .toBeGreaterThanOrEqual(4);
    expect(finalWorkflow).not.toContain("readJson(");
    for (const forbidden of [
      "requestedDurationMs",
      "cycleIntervalMs",
      "adapter:",
      "clock:",
      "executor:",
      "oracle:",
    ]) {
      expect(finalWorkflow).not.toContain(forbidden);
    }
  });
});
