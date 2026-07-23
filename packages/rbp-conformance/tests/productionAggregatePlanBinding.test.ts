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
): ExecutionPlan {
  return {
    ...structuredClone(plan),
    runId: `run-${String(sequence)}`,
    sequence,
  };
}

afterEach(cleanupProductionProvenanceFixtures);

describe("aggregate plan candidate binding", { timeout: 90_000 }, () => {
  it("rejects independently current plans that name different stacks", () => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const base = buildFixturePlan(value);
    const plans = ([1, 2, 3] as const).map((sequence) =>
      planSequence(base, sequence)) as [
        ExecutionPlan,
        ExecutionPlan,
        ExecutionPlan,
      ];
    plans[1].components[0]!.expectedIdentity.version = "alternate-candidate";
    const planFiles = plans.map((plan, index) => {
      const relative =
        `node_modules/.test-plans/aggregate-${String(index + 1)}.json`;
      writeFixtureFile(value.root, relative, stableJson(plan));
      return path.join(value.root, relative);
    }) as [string, string, string];

    expect(() =>
      runCli([
        "validate-aggregate",
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
