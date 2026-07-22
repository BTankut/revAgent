import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { evaluatePassingAggregate, stableJson, validateAggregateReportStructure } from "../src/index.js";
import { materializePassingAggregate } from "./helpers.js";

function withAggregate<T>(action: (root: string, aggregate: ReturnType<typeof materializePassingAggregate>["aggregate"]) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), "rbp-aggregate-"));
  try {
    return action(root, materializePassingAggregate(root).aggregate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("aggregate source-report content binding", () => {
  it("accepts three exact local source reports with identical stacks and strict chronology", () => {
    withAggregate((root, aggregate) => {
      const validation = evaluatePassingAggregate(aggregate, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation).toMatchObject({ ok: true });
    });
  });

  it("rejects a hand-crafted timestamp reference even when its interval remains internally valid", () => {
    withAggregate((root, aggregate) => {
      const ref = aggregate.runs[0]!;
      ref.startedAt = new Date(Date.parse(ref.startedAt!) + 1).toISOString();
      ref.finishedAt = new Date(Date.parse(ref.finishedAt!) + 1).toISOString();
      const validation = evaluatePassingAggregate(aggregate, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("aggregate.reference_mismatch");
    });
  });

  it("rejects mixed component builds before reading artifacts", () => {
    withAggregate((_root, aggregate) => {
      aggregate.runs[1]!.components[0]!.identity!.version = "different-build";
      const validation = validateAggregateReportStructure(aggregate);
      expect(validation.issues.map(({ code }) => code)).toContain("aggregate.mixed_stack");
    });
  });

  it("rejects a changed source report even if a hand-crafted reference updates its hash", () => {
    withAggregate((root, aggregate) => {
      const ref = aggregate.runs[0]!;
      const file = path.join(root, ref.reportPath);
      const retained = JSON.parse(readFileSync(file, "utf8")) as { source: { commitSha: string } };
      retained.source.commitSha = "9".repeat(40);
      const contents = stableJson(retained);
      writeFileSync(file, contents, "utf8");
      ref.reportSha256 = createHash("sha256").update(contents, "utf8").digest("hex");
      const validation = evaluatePassingAggregate(aggregate, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("aggregate.invalid_run");
    });
  });

  it("requires exact case statuses from each retained report", () => {
    withAggregate((root, aggregate) => {
      aggregate.cases[0]!.runStatuses[0] = "failed";
      aggregate.cases[0]!.passedAllRuns = false;
      aggregate.runs[0]!.status = "failed";
      aggregate.summary.passingRuns = 2;
      aggregate.summary.failedRuns = 1;
      aggregate.status = "failed";
      const validation = evaluatePassingAggregate(aggregate, { verifyArtifactFiles: true, artifactRoot: root });
      expect(validation.issues.map(({ code }) => code)).toContain("aggregate.case_content_mismatch");
    });
  });

  it("rejects overlap, including equal finish/start boundary timestamps", () => {
    withAggregate((_root, aggregate) => {
      aggregate.runs[1]!.startedAt = aggregate.runs[0]!.finishedAt;
      aggregate.runs[1]!.finishedAt = new Date(
        Date.parse(aggregate.runs[1]!.startedAt!) + aggregate.runs[1]!.durationMs!,
      ).toISOString();
      const validation = validateAggregateReportStructure(aggregate);
      expect(validation.issues.map(({ code }) => code)).toContain("aggregate.consecutive");
    });
  });
});
