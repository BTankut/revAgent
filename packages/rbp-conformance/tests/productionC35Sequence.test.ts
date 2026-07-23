import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { executeRawProductionCaseBothBindings } from "../src/productionCaseRunnerRaw.js";
import type { ExecutionPlan } from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    "sequence-boundary-o1-c35",
  );
}

describe("O1-C35 production sequence boundary", () => {
  it(
    "passes every frozen assertion on both real Gateway bindings",
    async () => {
      const executions = await executeRawProductionCaseBothBindings({
        plan: productionPlan(),
        repoRoot,
        caseId: "O1-C35",
      });
      const assertions = canonicalManifest.requiredAssertions["O1-C35"]!;
      for (const execution of executions) {
        for (const assertion of assertions) {
          const oracle = RAW_PRODUCTION_ORACLES.get(assertion.id);
          expect(oracle, assertion.id).toBeTypeOf("function");
          expect(oracle!({
            caseId: "O1-C35",
            binding: execution.binding,
            assertion,
            observations: execution.evidence.observations,
          }), `${execution.binding}/${assertion.id}`).toBe(true);
        }
        expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
          /"(?:actual|passed|verdict)"\s*:/u,
        );
      }
    },
    180_000,
  );
});
