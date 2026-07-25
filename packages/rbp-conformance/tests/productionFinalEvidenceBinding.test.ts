import { describe, expect, it } from "vitest";

import { assertPlansShareExactCandidate } from "../src/cli.js";
import type { ExecutionPlan } from "../src/types.js";
import { createPlan } from "./helpers.js";

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

describe("final aggregate and soak candidate binding", { timeout: 120_000 }, () => {
  it("rejects a soak plan whose stack differs from all aggregate plans", () => {
    const base = createPlan();
    const aggregatePlans = ([1, 2, 3] as const).map((sequence) =>
      planSequence(base, sequence)) as [
        ExecutionPlan,
        ExecutionPlan,
        ExecutionPlan,
      ];
    const soakPlan = planSequence(base, 1, "soak-run");
    soakPlan.components[0]!.expectedIdentity.version = "alternate-soak-candidate";

    expect(() =>
      assertPlansShareExactCandidate([...aggregatePlans, soakPlan]),
    ).toThrow(/do not share one exact candidate stack identity/u);
  });
});
