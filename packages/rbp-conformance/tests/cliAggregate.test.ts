import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalManifest, evaluatePassingAggregate, runCli } from "../src/index.js";
import type { AggregateReport } from "../src/index.js";
import { materializePassingRunInputs } from "./helpers.js";

describe("aggregate CLI retained-evidence flow", () => {
  it("writes and binds aggregate JUnit, then passes its own full validator", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-cli-aggregate-"));
    try {
      const inputs = materializePassingRunInputs(root);
      const output = path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        canonicalManifest.retainedEvidence.aggregateReport,
      );
      expect(() =>
        runCli(["aggregate", ...inputs.map(({ reportPath }) => reportPath), "--output", path.join(root, "outside.json")], root),
      ).toThrow();
      runCli(["aggregate", ...inputs.map(({ reportPath }) => reportPath), "--artifact-root", root], root);

      const aggregate = JSON.parse(readFileSync(output, "utf8")) as AggregateReport;
      expect(aggregate.reportPath).toBe(
        `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateReport}`,
      );
      expect(aggregate.artifacts).toHaveLength(1);
      expect(aggregate.artifacts[0]).toMatchObject({
        kind: "aggregate_junit",
        path: `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateJunit}`,
        mediaType: "application/xml",
      });
      expect(
        evaluatePassingAggregate(aggregate, {
          verifyArtifactFiles: true,
          artifactRoot: root,
          aggregateReportFile: output,
        }).ok,
      ).toBe(true);
      expect(() => runCli(["validate-aggregate", output, "--artifact-root", root], root)).not.toThrow();

      const copiedOutput = path.join(root, "copied-aggregate.json");
      copyFileSync(output, copiedOutput);
      expect(() => runCli(["validate-aggregate", copiedOutput, "--artifact-root", root], root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
