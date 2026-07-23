import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { stableJson } from "../src/stableJson.js";
import type { ExecutionPlan } from "../src/types.js";
import {
  buildFixturePlan,
  cleanupProductionProvenanceFixtures,
  createFixtureSidecars,
  productionProvenanceFixture,
  writeFixtureFile,
} from "./productionProvenanceFixture.js";

function planSequence(
  plan: ExecutionPlan,
  sequence: 1 | 2 | 3,
  runId = `run-${String(sequence)}`,
): ExecutionPlan {
  return {
    ...structuredClone(plan),
    runId,
    sequence,
  };
}

function writePlan(root: string, name: string, plan: ExecutionPlan): string {
  const relative = `node_modules/.test-plans/${name}`;
  writeFixtureFile(root, relative, stableJson(plan));
  return path.join(root, relative);
}

afterEach(cleanupProductionProvenanceFixtures);

describe("final aggregate and soak candidate binding", { timeout: 120_000 }, () => {
  it("rejects a soak plan whose stack differs from all aggregate plans", () => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const base = buildFixturePlan(value);
    const aggregatePlans = ([1, 2, 3] as const).map((sequence) =>
      planSequence(base, sequence)) as [
        ExecutionPlan,
        ExecutionPlan,
        ExecutionPlan,
      ];
    const planFiles = aggregatePlans.map((plan, index) =>
      writePlan(value.root, `final-${String(index + 1)}.json`, plan)) as [
        string,
        string,
        string,
      ];
    const soakPlan = planSequence(base, 1, "soak-run");
    soakPlan.components[0]!.expectedIdentity.version = "alternate-soak-candidate";
    const soakPlanFile = writePlan(value.root, "soak-plan.json", soakPlan);

    expect(() =>
      runCli([
        "validate-soak",
        path.join(value.root, "missing-soak.json"),
        "--plan",
        soakPlanFile,
        "--aggregate",
        path.join(value.root, "missing-aggregate.json"),
        "--plan-1",
        planFiles[0],
        "--plan-2",
        planFiles[1],
        "--plan-3",
        planFiles[2],
        "--repo-root",
        value.root,
      ], value.root)).toThrow(/do not share one exact candidate stack identity/u);
  });
});
