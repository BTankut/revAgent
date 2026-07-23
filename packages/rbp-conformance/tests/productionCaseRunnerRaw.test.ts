import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { executeRawProductionCaseBothBindings } from "../src/productionCaseRunnerRaw.js";
import { RAW_PRODUCTION_FRAME_FACTS } from "../src/productionCaseSeedsRaw.js";
import { productionComponentLaunchConfigs } from "../src/productionExecutionPlan.js";
import { sha256File } from "../src/executionPlan.js";
import type { ExecutionPlan, ProcessObservationRecord } from "../src/types.js";
import { createPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(): ExecutionPlan {
  const plan = createPlan();
  plan.runId = "raw-runner-o1-c30";
  const launchConfigs = productionComponentLaunchConfigs(repoRoot);
  for (const component of plan.components) {
    const selected = launchConfigs.find(({ id }) => id === component.id);
    if (selected === undefined) throw new Error(`missing production launch config for ${component.id}`);
    component.expectedIdentity.executableSha256 = sha256File(
      path.join(repoRoot, selected.entrypointPath),
    );
    component.command = structuredClone(selected.command);
  }
  return plan;
}

function stoppedLifecycle(observation: ProcessObservationRecord): boolean {
  if (observation.kind !== "process_lifecycle") return false;
  const payload = observation.payload as Record<string, unknown>;
  return payload.phase === "stopped" &&
    payload.action === "stop_case_stack" &&
    payload.processRole === "canonical_component";
}

describe("raw production case runner", () => {
  it(
    "executes C30 on both current-stack raw bindings and retains the exact raw frame evidence",
    async () => {
      const executions = await executeRawProductionCaseBothBindings({
        plan: productionPlan(),
        repoRoot,
        caseId: "O1-C30",
      });
      expect(executions.map(({ binding }) => binding)).toEqual([
        "wss",
        "streamable_http_sse",
      ]);
      const expectedStepIds = [...RAW_PRODUCTION_FRAME_FACTS.values()]
        .filter(({ caseId }) => caseId === "O1-C30")
        .map(({ stepId }) => stepId)
        .sort();
      for (const execution of executions) {
        const rawStepIds = execution.evidence.observations
          .filter(({ kind }) => kind === "wire_event")
          .map(({ payload }) => payload as Record<string, unknown>)
          .filter(({ direction }) => direction === "parent_to_gateway")
          .map(({ stepId }) => String(stepId))
          .sort();
        expect(rawStepIds).toEqual(expectedStepIds);
        expect(execution.evidence.observations.filter(stoppedLifecycle)).toHaveLength(3);
        expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
          /"(?:actual|passed|verdict)"\s*:/u,
        );
      }
    },
    180_000,
  );
});
