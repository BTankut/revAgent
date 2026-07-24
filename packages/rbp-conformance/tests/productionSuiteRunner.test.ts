import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import {
  executeProductionConformanceRun,
  retainAccountedCaseEvidence,
  serializedWallDurationMs,
} from "../src/productionSuiteRunner.js";
import type {
  ExecutedCaseEvidence,
  ProductionSuiteRunInput,
} from "../src/productionSuiteRunner.js";
import { createUnexecutedRunReport } from "../src/scaffold.js";
import { createPlan } from "./helpers.js";

describe("production suite dependency boundary", () => {
  it("rejects all-true oracles, a synthetic executor, and a caller clock before retaining evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-injection-"));
    const calls = { executor: 0, clock: 0, oracle: 0 };
    const allTrueOracles = new Map(canonicalManifest.cases.flatMap(({ id: caseId }) =>
      canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => [
        id,
        () => {
          calls.oracle += 1;
          return true;
        },
      ] as const)));
    const injected = {
      plan: createPlan(),
      repoRoot: root,
      artifactRoot: root,
      seed: "synthetic-production-pass",
      oracles: allTrueOracles,
      executeCase: async () => {
        calls.executor += 1;
        return [];
      },
      nowMs: () => {
        calls.clock += 1;
        return Date.UTC(2026, 6, 23);
      },
    } as unknown as ProductionSuiteRunInput;

    try {
      await expect(executeProductionConformanceRun(injected)).rejects.toThrow(
        /forbids synthetic dependency overrides: oracles, executeCase, nowMs/u,
      );
      expect(calls).toEqual({ executor: 0, clock: 0, oracle: 0 });
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes wall-clock intervals independently from nearby monotonic-clock drift", () => {
    const samples = [
      { startedWallMs: 1_000, finishedWallMs: 2_000, monotonicDurationMs: 996 },
      { startedWallMs: 2_000, finishedWallMs: 3_000, monotonicDurationMs: 999 },
      { startedWallMs: 3_000, finishedWallMs: 4_000, monotonicDurationMs: 1_001 },
      { startedWallMs: 4_000, finishedWallMs: 5_000, monotonicDurationMs: 1_004 },
    ];
    for (const sample of samples) {
      expect(sample.monotonicDurationMs).not.toBe(sample.finishedWallMs - sample.startedWallMs);
      expect(serializedWallDurationMs(sample.startedWallMs, sample.finishedWallMs)).toBe(1_000);
    }
    expect(() => serializedWallDurationMs(2_000, 1_999)).toThrow(/finish precedes start/u);
  });

  it("keeps evaluated observations accounted when case-evidence retention fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-retention-"));
    const report = createUnexecutedRunReport(createPlan());
    const result = report.cases[0]!;
    result.status = "passed";
    const executedCases: ExecutedCaseEvidence[] = [];
    const retentionFailures: Error[] = [];

    try {
      retainAccountedCaseEvidence({
        artifactRoot: root,
        runId: report.run.runId,
        result,
        observations: [],
        executedCases,
        retentionFailures,
      });
      expect(executedCases).toEqual([{ caseId: result.caseId, observations: [] }]);
      expect(retentionFailures).toHaveLength(1);
      expect(retentionFailures[0]!.message).toMatch(
        new RegExp(`${result.caseId} supervised evidence retention failed`, "u"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
