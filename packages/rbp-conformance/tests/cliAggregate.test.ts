import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalManifest, evaluatePassingAggregate, runCli } from "../src/index.js";
import type { AggregateReport } from "../src/index.js";
import { stableJson } from "../src/stableJson.js";
import {
  createCurrentProductionPlan,
  materializePassingRunInputs,
} from "./helpers.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");

describe("aggregate CLI retained-evidence flow", () => {
  it("writes and binds aggregate JUnit, then passes its own full validator", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-cli-aggregate-"));
    try {
      const plans = ([1, 2, 3] as const).map((sequence) =>
        createCurrentProductionPlan(
          repoRoot,
          `run-${String(sequence)}`,
          sequence,
        )) as [
          ReturnType<typeof createCurrentProductionPlan>,
          ReturnType<typeof createCurrentProductionPlan>,
          ReturnType<typeof createCurrentProductionPlan>,
        ];
      const planFiles = plans.map((plan, index) => {
        const target = path.join(root, `plan-${String(index + 1)}.json`);
        writeFileSync(target, stableJson(plan), "utf8");
        return target;
      }) as [string, string, string];
      const planFlags = [
        "--plan-1",
        planFiles[0],
        "--plan-2",
        planFiles[1],
        "--plan-3",
        planFiles[2],
        "--repo-root",
        repoRoot,
      ];
      const inputs = materializePassingRunInputs(root, plans);
      const output = path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        canonicalManifest.retainedEvidence.aggregateReport,
      );
      expect(() =>
        runCli([
          "aggregate",
          ...inputs.map(({ reportPath }) => reportPath),
          ...planFlags,
          "--output",
          path.join(root, "outside.json"),
        ], root),
      ).toThrow();
      runCli([
        "aggregate",
        ...inputs.map(({ reportPath }) => reportPath),
        ...planFlags,
        "--artifact-root",
        root,
      ], root);

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
      expect(() =>
        runCli([
          "validate-aggregate",
          output,
          ...planFlags,
          "--artifact-root",
          root,
        ], root)).not.toThrow();

      const copiedOutput = path.join(root, "copied-aggregate.json");
      copyFileSync(output, copiedOutput);
      expect(() =>
        runCli([
          "validate-aggregate",
          copiedOutput,
          ...planFlags,
          "--artifact-root",
          root,
        ], root)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
