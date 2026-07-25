import { describe, expect, it } from "vitest";

import { assertPlansShareExactCandidate } from "../src/cli.js";
import type { ExecutionPlan } from "../src/types.js";
import { createPlan } from "./helpers.js";

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

describe("aggregate plan candidate binding", { timeout: 90_000 }, () => {
  it("rejects independently current plans that name different stacks", () => {
    const base = createPlan();
    const plans = ([1, 2, 3] as const).map((sequence) =>
      planSequence(base, sequence)) as [
        ExecutionPlan,
        ExecutionPlan,
        ExecutionPlan,
      ];
    plans[1].components[0]!.expectedIdentity.version = "alternate-candidate";

    expect(() =>
      assertPlansShareExactCandidate(plans),
    ).toThrow(/do not share one exact candidate stack identity/u);
  });
});
