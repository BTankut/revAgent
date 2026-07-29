import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createThreeRunAggregate } from "../src/aggregate.js";
import { canonicalManifest } from "../src/index.js";
import { aggregateReportToJUnitXml } from "../src/junit.js";
import { stableJson } from "../src/stableJson.js";
import {
  createCurrentProductionPlan,
  materializePassingRunInputs,
} from "./helpers.js";
import {
  invokeProductionCli,
  productionCliTestTimeoutMs,
} from "./support/invokeProductionCli.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const compiledCli = path.join(packageRoot, "dist", "src", "cli.js");

function invokeCurrentCli(
  args: readonly string[],
  cwd: string,
): ReturnType<typeof invokeProductionCli> {
  return invokeProductionCli({
    repoRoot,
    args,
    cwd,
    label: "aggregate CLI launcher",
  });
}

function localPathAsAdminShare(value: string): string {
  const resolved = path.win32.resolve(value);
  const parsed = path.win32.parse(resolved);
  const driveLetter = parsed.root.match(/^([A-Za-z]):\\$/u)?.[1];
  if (driveLetter === undefined) {
    throw new Error(`UNC alias regression requires a drive-letter path: ${value}`);
  }
  return `\\\\localhost\\${driveLetter}$\\${resolved.slice(parsed.root.length)}`;
}

describe("aggregate CLI retained-evidence flow", () => {
  it("validates and summarizes aggregate bytes without writing any output", async () => {
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
      const canonicalOutput = path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        canonicalManifest.retainedEvidence.aggregateReport,
      );
      const canonicalJunit = path.join(
        root,
        canonicalManifest.retainedEvidence.root,
        canonicalManifest.retainedEvidence.aggregateJunit,
      );
      expect(existsSync(compiledCli)).toBe(true);
      const evidenceEntriesBefore = readdirSync(root, { recursive: true })
        .map(String)
        .sort();

      const aggregateResult = await invokeCurrentCli(
        [
          "aggregate",
          ...inputs.map(({ reportPath }) => path.join(root, reportPath)),
          ...planFlags,
          "--artifact-root",
          root,
        ],
        root,
      );
      expect(aggregateResult.error).toBeUndefined();
      expect(aggregateResult.status, aggregateResult.stderr).toBe(0);
      expect(String(aggregateResult.stdout)).toContain(
        "VALID (NON-AUTHORITATIVE)",
      );
      expect(String(aggregateResult.stdout)).not.toContain("PASS");
      expect(existsSync(canonicalOutput)).toBe(false);
      expect(existsSync(canonicalJunit)).toBe(false);

      const expectedAggregate = createThreeRunAggregate(inputs);
      const expectedJunit = aggregateReportToJUnitXml(expectedAggregate);
      const expectedJunitBytes = Buffer.from(expectedJunit, "utf8");
      expectedAggregate.artifacts.push({
        kind: "aggregate_junit",
        path: `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateJunit}`,
        sha256: createHash("sha256").update(expectedJunitBytes).digest("hex"),
        bytes: expectedJunitBytes.length,
        mediaType: "application/xml",
      });
      const expectedAggregateBytes = Buffer.from(
        stableJson(expectedAggregate),
        "utf8",
      );
      expect(String(aggregateResult.stdout)).not.toContain(
        expectedAggregateBytes.toString("utf8"),
      );
      expect(String(aggregateResult.stdout)).not.toContain(expectedJunit);
      const stdout = String(aggregateResult.stdout);
      const summaryLabel =
        "RBP conformance aggregate reconstruction: VALID (NON-AUTHORITATIVE)";
      const summaryLabelIndex = stdout.indexOf(summaryLabel);
      expect(summaryLabelIndex).toBeGreaterThanOrEqual(0);
      const summaryStart = stdout.indexOf(
        "{",
        summaryLabelIndex + summaryLabel.length,
      );
      const summaryEnd = stdout.lastIndexOf("}");
      expect(summaryStart).toBeGreaterThan(summaryLabelIndex);
      expect(summaryEnd).toBeGreaterThan(summaryStart);
      expect(
        JSON.parse(stdout.slice(summaryStart, summaryEnd + 1)),
      ).toEqual({
        schemaVersion: "rbp-conformance-aggregate-audit-summary/v1",
        aggregateBytes: expectedAggregateBytes.length,
        aggregateSha256: createHash("sha256")
          .update(expectedAggregateBytes)
          .digest("hex"),
        junitBytes: expectedJunitBytes.length,
        junitSha256: createHash("sha256")
          .update(expectedJunitBytes)
          .digest("hex"),
        runCount: 3,
        caseCount: canonicalManifest.cases.length,
        testcaseCount: canonicalManifest.cases.length * 3,
      });

      for (const [flag, target] of [
        ["--output", localPathAsAdminShare(canonicalOutput)],
        ["--junit-output", localPathAsAdminShare(canonicalJunit)],
      ] as const) {
        const rejectedWrite = await invokeCurrentCli(
          [
            "aggregate",
            ...inputs.map(({ reportPath }) => reportPath),
            ...planFlags,
            "--artifact-root",
            root,
            flag,
            target,
          ],
          root,
        );
        expect(rejectedWrite.error).toBeUndefined();
        expect(rejectedWrite.status).not.toBe(0);
        expect(String(rejectedWrite.stderr)).toContain("Usage:");
        expect(String(rejectedWrite.stdout)).not.toContain("PASS");
        expect(existsSync(canonicalOutput)).toBe(false);
        expect(existsSync(canonicalJunit)).toBe(false);
      }
      expect(
        readdirSync(root, { recursive: true }).map(String).sort(),
      ).toEqual(evidenceEntriesBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, productionCliTestTimeoutMs(3));
});
