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
const acceptedAggregateStart = finalWorkflow.indexOf(
  "const acceptedAggregate = await store.writeAccepted(",
);
const acceptedAggregateEnd = finalWorkflow.indexOf(
  "assertFinalPlanSnapshotsCurrent(context);",
  acceptedAggregateStart,
);
const acceptedAggregateFlow = finalWorkflow.slice(
  acceptedAggregateStart,
  acceptedAggregateEnd,
);

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
    expect(finalWorkflow.match(/readExactRetainedJson/gu)).toHaveLength(4);
    expect([
      ...finalWorkflow.matchAll(
        /readExactRetainedJson\(\s*context\.artifactRoot,\s*(\w+\.reportPath)/gu,
      ),
    ].map((match) => match[1])).toEqual([
      "result.reportPath",
      "soakResult.reportPath",
      "input.reportPath",
      "soakResult.reportPath",
    ]);
    expect(acceptedAggregateStart).toBeGreaterThanOrEqual(0);
    expect(acceptedAggregateEnd).toBeGreaterThan(acceptedAggregateStart);
    expect(acceptedAggregateFlow).toContain("candidate.acceptExact({");
    expect(acceptedAggregateFlow).toContain(
      "logicalPath: aggregate.reportPath",
    );
    expect(acceptedAggregateFlow).toContain(
      "absolutePath: store.resolve(aggregate.reportPath)",
    );
    expect(acceptedAggregateFlow).toContain("bytes: aggregateBytes");
    expect(acceptedAggregateFlow).toContain("sha256: aggregateSha256");
    expect(acceptedAggregateFlow).toContain(
      "absolutePath: candidate.absolutePath",
    );
    expect(acceptedAggregateFlow).toContain("bytes: candidate.bytes");
    expect(acceptedAggregateFlow).toContain("sha256: candidate.sha256");
    expect(acceptedAggregateFlow).toContain(
      'parsed: JSON.parse(candidate.bytes.toString("utf8")) as typeof aggregate',
    );
    expect(acceptedAggregateFlow).toContain(
      "acceptedAggregate.bytes.equals(aggregateBytes)",
    );
    expect(acceptedAggregateFlow).toContain(
      "acceptedAggregate.sha256 !== aggregateSha256",
    );
    expect(acceptedAggregateFlow).toContain(
      "context.options.aggregateReportFile = acceptedAggregate.absolutePath",
    );
    expect(acceptedAggregateFlow).toContain(
      "assertPassingAggregateReport(acceptedAggregate.parsed, context.options)",
    );
    expect(acceptedAggregateFlow).not.toContain("readExactRetainedJson(");
    expect(finalWorkflow).not.toMatch(
      /readExactRetainedJson\(\s*context\.artifactRoot,\s*aggregate\.reportPath/gu,
    );
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
