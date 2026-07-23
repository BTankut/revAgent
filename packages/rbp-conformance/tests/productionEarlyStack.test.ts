import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  executeEarlyProductionCaseBothBindings,
} from "../src/productionCaseRunnerEarly.js";
import { EARLY_PRODUCTION_ORACLES } from "../src/productionCaseOraclesEarly.js";
import {
  EARLY_PRODUCTION_CASES,
} from "../src/productionCaseSeedsEarly.js";
import { canonicalManifest } from "../src/manifest.js";
import type { ExecutionPlan } from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(caseId: string): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    `early-production-${caseId.toLowerCase()}`,
  );
}

describe("early production case stack", () => {
  it.each(EARLY_PRODUCTION_CASES)(
    "runs %s through both real bindings without unresolved tokens or orphan processes",
    async (caseId) => {
      const executions = await executeEarlyProductionCaseBothBindings({
        plan: productionPlan(caseId),
        repoRoot,
        caseId,
      });
      expect(executions.map(({ binding }) => binding)).toEqual([
        "wss",
        "streamable_http_sse",
      ]);
      for (const execution of executions) {
        expect(execution.evidence.completedStepIds.at(-1)).toBe(`${caseId.toLowerCase()}.stack-stop`);
        const stopped = execution.evidence.observations.filter(({ kind, payload }) =>
          kind === "process_lifecycle" &&
          payload.phase === "stopped" &&
          payload.action === "stop_case_stack");
        expect(stopped.filter(({ payload }) =>
          payload.processRole === "canonical_component")).toHaveLength(3);
        const stopFailures = stopped
          .filter(({ payload }) =>
            payload.orphanProcessCount !== 0 ||
            payload.killEscalated !== false ||
            typeof payload.process !== "object" ||
            payload.process === null ||
            Array.isArray(payload.process) ||
            payload.process.exitCode !== 0)
          .map(({ componentId, payload }) => ({
            componentId,
            processRole: payload.processRole,
            orphanProcessCount: payload.orphanProcessCount,
            killEscalated: payload.killEscalated,
            exitCode: typeof payload.process === "object" &&
              payload.process !== null &&
              !Array.isArray(payload.process)
              ? payload.process.exitCode
              : null,
          }));
        const bridgePeerBeforeStop = execution.evidence.observations
          .filter(({ kind }) => kind === "bridge_snapshot")
          .at(-1)?.payload.peer ?? null;
        expect(
          stopFailures,
          JSON.stringify({
            caseId,
            binding: execution.binding,
            stopFailures,
            bridgePeerBeforeStop,
          }, null, 2),
        ).toEqual([]);
        for (const assertion of canonicalManifest.requiredAssertions[caseId]!) {
          const oracle = EARLY_PRODUCTION_ORACLES.get(assertion.id);
          expect(oracle, assertion.id).toBeTypeOf("function");
          expect(oracle!({
            caseId,
            binding: execution.binding,
            assertion,
            observations: execution.evidence.observations,
          }), assertion.id).toBe(true);
        }
      }
    },
    180_000,
  );
});
