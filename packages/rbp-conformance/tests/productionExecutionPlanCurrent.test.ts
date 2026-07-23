import { describe, expect, it, vi } from "vitest";

import { assertProductionExecutionPlanCurrent } from "../src/productionExecutionPlan.js";
import { createPlan } from "./helpers.js";

describe("production execution plan source gate", () => {
  it("accepts only the exact clean source identity resolved at execution time", () => {
    const plan = createPlan();
    const resolver = vi.fn(() => structuredClone(plan.source));
    expect(() =>
      assertProductionExecutionPlanCurrent(plan, "C:/repo", resolver),
    ).not.toThrow();
    expect(resolver).toHaveBeenCalledWith("C:/repo");

    expect(() =>
      assertProductionExecutionPlanCurrent(plan, "C:/repo", () => ({
        ...structuredClone(plan.source),
        treeSha: "b".repeat(40),
      })),
    ).toThrow(/does not match clean repository source/u);
  });
});
