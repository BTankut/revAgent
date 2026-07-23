import { describe, expect, it, vi } from "vitest";

import { assertProductionExecutionPlanCurrent } from "../src/productionExecutionPlan.js";
import type {
  ComponentBuildProvenanceIdentity,
  ComponentId,
} from "../src/types.js";
import { createPlan } from "./helpers.js";

function provenance(seed: number): ComponentBuildProvenanceIdentity {
  const hash = seed.toString(16).padStart(64, "0");
  return {
    schemaVersion: "rbp-production-build-provenance/v1",
    buildContractVersion: "rbp-production-typescript-build/v1",
    sidecarPath: `packages/component-${String(seed)}/dist/rbp-build-provenance.json`,
    sidecarSha256: hash,
    compileInputsSha256: hash,
    runtimeArtifactsSha256: hash,
    toolchain: {
      nodeVersion: "v22.0.0",
      typescriptVersion: "5.8.2",
      typescriptEntrypointPath: "node_modules/typescript/lib/tsc.js",
      typescriptEntrypointSha256: hash,
    },
  };
}

describe("production execution plan source gate", () => {
  it("accepts only the exact clean source identity resolved at execution time", () => {
    const plan = createPlan();
    const verified = new Map<ComponentId, ComponentBuildProvenanceIdentity>();
    plan.components.forEach((component, index) => {
      const identity = provenance(index + 1);
      component.expectedIdentity.buildProvenance = identity;
      verified.set(component.id, structuredClone(identity));
    });
    const resolver = vi.fn(() => structuredClone(plan.source));
    const verifier = vi.fn(() => verified);
    expect(() =>
      assertProductionExecutionPlanCurrent(plan, "C:/repo", resolver, verifier),
    ).not.toThrow();
    expect(resolver).toHaveBeenCalledWith("C:/repo");
    expect(verifier).toHaveBeenCalledWith("C:/repo", plan.source);

    expect(() =>
      assertProductionExecutionPlanCurrent(plan, "C:/repo", () => ({
        ...structuredClone(plan.source),
        treeSha: "b".repeat(40),
      }), verifier),
    ).toThrow(/does not match clean repository source/u);
  });

  it("requires every production plan identity to match verified provenance", () => {
    const plan = createPlan();
    const verified = new Map<ComponentId, ComponentBuildProvenanceIdentity>();
    plan.components.forEach((component, index) => {
      const identity = provenance(index + 1);
      component.expectedIdentity.buildProvenance = identity;
      verified.set(component.id, structuredClone(identity));
    });
    delete plan.components[0]!.expectedIdentity.buildProvenance;
    expect(() =>
      assertProductionExecutionPlanCurrent(
        plan,
        "C:/repo",
        () => structuredClone(plan.source),
        () => verified,
      ),
    ).toThrow(/lacks required build provenance/u);

    plan.components[0]!.expectedIdentity.buildProvenance = provenance(1);
    verified.set("gateway_stub", provenance(99));
    expect(() =>
      assertProductionExecutionPlanCurrent(
        plan,
        "C:/repo",
        () => structuredClone(plan.source),
        () => verified,
      ),
    ).toThrow(/does not match the execution plan/u);
  });
});
