import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { executeRawProductionCaseBothBindings } from "../src/productionCaseRunnerRaw.js";
import { RAW_PRODUCTION_FRAME_FACTS } from "../src/productionCaseSeedsRaw.js";
import { productionComponentLaunchConfigs } from "../src/productionExecutionPlan.js";
import { sha256File } from "../src/executionPlan.js";
import type { ExecutionPlan, ProcessObservationRecord } from "../src/types.js";
import { createPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(caseId = "O1-C30"): ExecutionPlan {
  const plan = createPlan();
  plan.runId = `raw-runner-${caseId.toLowerCase()}`;
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
  it.each(["O1-C25", "O1-C34"] as const)(
    "executes %s on both authenticated product bindings with exact parent-owned identity oracles",
    async (caseId) => {
      const executions = await executeRawProductionCaseBothBindings({
        plan: productionPlan(caseId),
        repoRoot,
        caseId,
      });
      expect(executions.map(({ binding }) => binding)).toEqual([
        "wss",
        "streamable_http_sse",
      ]);
      const assertions = canonicalManifest.requiredAssertions[caseId]!;
      for (const execution of executions) {
        for (const assertion of assertions) {
          const oracle = RAW_PRODUCTION_ORACLES.get(assertion.id);
          expect(oracle, assertion.id).toBeDefined();
          const passed = oracle!({
            caseId,
            binding: execution.binding,
            assertion,
            observations: execution.evidence.observations,
          });
          expect(passed, `${assertion.id}/${execution.binding}`).toBe(true);
        }
        const stops = execution.evidence.observations.filter(stoppedLifecycle);
        expect(stops).toHaveLength(3);
        for (const stop of stops) {
          expect(stop.payload).toMatchObject({
            orphanProcessCount: 0,
            survivingPids: [],
          });
        }
        expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
          /"(?:actual|passed|verdict)"\s*:/u,
        );
      }
    },
    180_000,
  );

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
      const assertions = canonicalManifest.requiredAssertions["O1-C30"]!;
      for (const execution of executions) {
        const rawStepIds = execution.evidence.observations
          .filter(({ kind }) => kind === "wire_event")
          .map(({ payload }) => payload as Record<string, unknown>)
          .filter(({ direction }) => direction === "parent_to_gateway")
          .map(({ stepId }) => String(stepId))
          .sort();
        expect(rawStepIds).toEqual(expectedStepIds);
        for (const assertion of assertions) {
          const oracle = RAW_PRODUCTION_ORACLES.get(assertion.id);
          expect(oracle, assertion.id).toBeDefined();
          expect(oracle!({
            caseId: "O1-C30",
            binding: execution.binding,
            assertion,
            observations: execution.evidence.observations,
          }), `${assertion.id}/${execution.binding}`).toBe(true);
        }
        expect(execution.evidence.observations.filter(stoppedLifecycle)).toHaveLength(3);
        expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
          /"(?:actual|passed|verdict)"\s*:/u,
        );
      }
    },
    180_000,
  );
});
