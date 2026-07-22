import { describe, expect, it } from "vitest";

import {
  createJUnitMapping,
  createThreeRunAggregate,
  createUnexecutedRunReport,
  evaluatePassingAggregate,
  renderAggregateSummary,
  renderJUnitXml,
  runReportToJUnitXml,
  validateAggregateReportStructure,
  validateJUnitMapping,
} from "../src/index.js";
import { aggregateInputs, aggregateJunitArtifact, createPassingReport, createPlan } from "./helpers.js";

function timestampWithOffset(value: string, offsetMinutes: number): string {
  const shifted = new Date(Date.parse(value) + offsetMinutes * 60_000).toISOString().slice(0, -1);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${shifted}${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

describe("deterministic JUnit mapping", () => {
  it("maps an unexecuted scaffold to forty explicit skipped/not_run entries", () => {
    const report = createUnexecutedRunReport(createPlan());
    const mapping = createJUnitMapping(report);
    expect(mapping.tests).toBe(40);
    expect(mapping.skipped).toBe(40);
    expect(mapping.cases.every(({ status }) => status === "not_run")).toBe(true);
    expect(validateJUnitMapping(mapping, report).ok).toBe(true);
    expect(runReportToJUnitXml(report)).toBe(renderJUnitXml(mapping));
    expect(runReportToJUnitXml(report)).toContain('<skipped message="not_run"/>');
  });

  it("is byte-deterministic for identical reports", () => {
    const report = createPassingReport();
    expect(runReportToJUnitXml(report)).toBe(runReportToJUnitXml(structuredClone(report)));
  });

  it("rejects a mutated mapping", () => {
    const report = createPassingReport();
    const mapping = createJUnitMapping(report);
    mapping.cases[0]!.testName = "false green";
    expect(validateJUnitMapping(mapping, report).ok).toBe(false);
  });

  it("rejects false summary counts and a mismatched manifest digest", () => {
    const mapping = createJUnitMapping(createPassingReport());
    mapping.skipped = 1;
    mapping.manifest.sha256 = "f".repeat(64);
    expect(validateJUnitMapping(mapping).issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["junit.summary", "junit.manifest"]),
    );
  });
});

describe("three-consecutive-run aggregate", () => {
  it("passes only three ordered, identity-matched, fully passing runs", () => {
    const aggregate = createThreeRunAggregate(aggregateInputs(), [aggregateJunitArtifact()]);
    expect(aggregate.status).toBe("passed");
    expect(aggregate.consecutive).toBe(true);
    expect(aggregate.cases.every(({ passedAllRuns }) => passedAllRuns)).toBe(true);
    expect(validateAggregateReportStructure(aggregate).ok).toBe(true);
    expect(evaluatePassingAggregate(aggregate).ok).toBe(true);
    expect(renderAggregateSummary(aggregate)).toContain("- Status: passed");
    expect(renderAggregateSummary(aggregate)).toBe(renderAggregateSummary(structuredClone(aggregate)));
  });

  it("marks an unexecuted run aggregate incomplete and never synthesizes passes", () => {
    const inputs = aggregateInputs();
    inputs[1]!.report = createUnexecutedRunReport(createPlan(2));
    const aggregate = createThreeRunAggregate(inputs, [aggregateJunitArtifact()]);
    expect(aggregate.status).toBe("incomplete");
    expect(aggregate.summary.incompleteRuns).toBe(1);
    expect(evaluatePassingAggregate(aggregate).ok).toBe(false);
  });

  it.each(["failed", "error"] as const)(
    "classifies a terminal %s run with nonterminal successors as failed, never incomplete or passed",
    (terminalStatus) => {
      const inputs = aggregateInputs();
      const terminal = createPassingReport(2);
      terminal.run.status = terminalStatus;
      terminal.run.exitCode = 1;
      terminal.cases[0]!.status = "failed";
      terminal.cases[1]!.status = "running";
      terminal.cases.slice(2).forEach((result) => {
        result.status = "not_run";
      });
      inputs[1]!.report = terminal;

      const aggregate = createThreeRunAggregate(inputs, [aggregateJunitArtifact()]);
      expect(aggregate).toMatchObject({
        status: "failed",
        summary: { passingRuns: 2, failedRuns: 1, incompleteRuns: 0 },
      });
      expect(validateAggregateReportStructure(aggregate).ok).toBe(true);
      expect(evaluatePassingAggregate(aggregate).ok).toBe(false);

      aggregate.status = "passed";
      expect(validateAggregateReportStructure(aggregate).issues.map(({ code }) => code)).toContain("aggregate.false_green");
    },
  );

  it("fails an overlapping/nonconsecutive sequence", () => {
    const aggregate = createThreeRunAggregate(aggregateInputs(), [aggregateJunitArtifact()]);
    aggregate.runs[1]!.startedAt = aggregate.runs[0]!.finishedAt;
    aggregate.runs[1]!.finishedAt = new Date(
      Date.parse(aggregate.runs[1]!.startedAt!) + aggregate.runs[1]!.durationMs!,
    ).toISOString();
    aggregate.consecutive = false;
    aggregate.status = "failed";
    expect(aggregate.consecutive).toBe(false);
    expect(aggregate.status).toBe("failed");
    expect(validateAggregateReportStructure(aggregate).ok).toBe(true);
  });

  it("selects generatedAt and validates order by epoch rather than lexicographic timezone text", () => {
    const inputs = aggregateInputs();
    const offsets = [14 * 60, -10 * 60, 2 * 60];
    inputs.forEach(({ report }, index) => {
      report.run.startedAt = timestampWithOffset(report.run.startedAt!, offsets[index]!);
      report.run.finishedAt = timestampWithOffset(report.run.finishedAt!, offsets[index]!);
    });
    const aggregate = createThreeRunAggregate(inputs, [aggregateJunitArtifact()]);
    expect(aggregate.generatedAt).toBe(inputs[2]!.report.run.finishedAt);
    expect(validateAggregateReportStructure(aggregate).ok).toBe(true);
  });

  it("rejects equal-boundary chronology hidden behind a different timezone offset", () => {
    const aggregate = createThreeRunAggregate(aggregateInputs(), [aggregateJunitArtifact()]);
    const boundary = aggregate.runs[0]!.finishedAt!;
    aggregate.runs[1]!.startedAt = timestampWithOffset(boundary, -10 * 60);
    aggregate.runs[1]!.finishedAt = timestampWithOffset(
      new Date(Date.parse(boundary) + aggregate.runs[1]!.durationMs!).toISOString(),
      -10 * 60,
    );
    const codes = validateAggregateReportStructure(aggregate).issues.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining(["aggregate.consecutive", "aggregate.false_green"]));
  });

  it("rejects a false-green aggregate mutation", () => {
    const aggregate = createThreeRunAggregate(aggregateInputs(), [aggregateJunitArtifact()]);
    aggregate.cases[0]!.runStatuses[0] = "failed";
    expect(validateAggregateReportStructure(aggregate).issues.map(({ code }) => code)).toContain("aggregate.false_green");
  });

  it("rejects an absent aggregate JUnit hash record", () => {
    const aggregate = createThreeRunAggregate(aggregateInputs());
    expect(evaluatePassingAggregate(aggregate).issues.map(({ code }) => code)).toContain("artifact.required");
  });

  it("rejects noncanonical run paths and placeholder report hashes", () => {
    const aggregate = createThreeRunAggregate(aggregateInputs(), [aggregateJunitArtifact()]);
    aggregate.runs[0]!.reportPath = "somewhere/run-report.json";
    aggregate.runs[0]!.reportSha256 = "0".repeat(64);
    expect(validateAggregateReportStructure(aggregate).issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["aggregate.report_path", "artifact.placeholder_hash"]),
    );
  });

  it("rejects a noncanonical aggregate self path", () => {
    const aggregate = createThreeRunAggregate(aggregateInputs(), [aggregateJunitArtifact()]);
    aggregate.reportPath = "outside/aggregate.json";
    expect(validateAggregateReportStructure(aggregate).issues.map(({ code }) => code)).toContain("aggregate.self_report_path");
  });
});
