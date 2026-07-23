import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { executeProductionConformanceRun } from "../src/productionSuiteRunner.js";
import type { ProductionSuiteRunInput } from "../src/productionSuiteRunner.js";
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
});
