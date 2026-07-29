import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { executeRawProductionCaseBinding } from "../src/productionCaseRunnerRaw.js";
import type { ExecutionPlan, ProcessObservationRecord } from "../src/types.js";
import {
  createCurrentProductionPlan,
  withProductionRuntimeLaunchEpoch,
} from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const CURRENT_STACK_BINDINGS = ["wss", "streamable_http_sse"] as const;

function productionPlan(): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    "registered-session-o1-c32",
  );
}

function stoppedLifecycleAt(stepId: string): (observation: ProcessObservationRecord) => boolean {
  return (observation) => {
    if (observation.kind !== "process_lifecycle") return false;
    const payload = observation.payload as Record<string, unknown>;
    return payload.phase === "stopped" &&
      payload.action === "stop_case_stack" &&
      payload.processRole === "canonical_component" &&
      payload.stepId === stepId;
  };
}

describe("O1-C32 registered-session production conformance", () => {
  it.each(CURRENT_STACK_BINDINGS)(
    "passes every exact chunk assertion on the %s current-stack binding",
    async (binding) => {
      const plan = productionPlan();
      const execution = await withProductionRuntimeLaunchEpoch(
        plan,
        repoRoot,
        () => executeRawProductionCaseBinding({
          plan,
          repoRoot,
          caseId: "O1-C32",
          binding,
        }),
      );
      const assertions = canonicalManifest.requiredAssertions["O1-C32"]!;
      const report: Array<{ binding: string; assertionId: string; passed: boolean }> = [];
      for (const assertion of assertions) {
        const oracle = RAW_PRODUCTION_ORACLES.get(assertion.id)!;
        report.push({
          binding: execution.binding,
          assertionId: assertion.id,
          passed: oracle({
            caseId: "O1-C32",
            binding: execution.binding,
            assertion,
            observations: execution.evidence.observations,
          }),
        });
      }
      const actionEvidence = execution.evidence.observations
        .filter(({ kind, payload }) =>
          kind === "control_result" &&
          (payload as Record<string, unknown>).stepId === "o1-c32.base64_alphabet")
        .map(({ payload }) => payload as Record<string, unknown>);
      const restartTiming = execution.evidence.captures[
        "o1-c32.resource-baseline-start.restart-timing"
      ] as {
        schemaVersion: string;
        totalElapsedMs: number;
        phases: Array<{ phase: string; durationMs: number }>;
      };
      expect(execution.binding).toBe(binding);
      expect(report, JSON.stringify(actionEvidence, null, 2)).toEqual(
        report.map((entry) => ({ ...entry, passed: true })),
      );
      expect(restartTiming.schemaVersion).toBe("rbp-restart-phase-timing/v1");
      expect(restartTiming.phases.map(({ phase }) => phase)).toEqual([
        "restart_case_stack.prepare_instance",
        "restart_case_stack.addin_loopback_fixture.readiness",
        "restart_case_stack.fixture.ParentTcpCaptureProxy.start",
        "restart_case_stack.gateway_stub.readiness",
        "restart_case_stack.gateway.ParentTcpCaptureProxy.start",
        "restart_case_stack.bridge_simulator.readiness",
        "restart_case_stack.finalize",
      ]);
      console.log(
        `[rbp-conformance] restart_case_stack timing binding=${binding} ` +
        `step=o1-c32.resource-baseline-start totalElapsedMs=${String(restartTiming.totalElapsedMs)} ` +
        `phases=${restartTiming.phases.map(
          ({ phase, durationMs }) => `${phase}:${String(durationMs)}ms`,
        ).join(",")}`,
      );
      expect(execution.evidence.observations.filter(
        stoppedLifecycleAt("o1-c32.resource-baseline-stop"),
      )).toHaveLength(3);
      expect(execution.evidence.observations.filter(
        stoppedLifecycleAt("o1-c32.stack-stop"),
      )).toHaveLength(3);
      expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
        /"(?:actual|passed|verdict)"\s*:/u,
      );
      // Seven fresh registered-session stacks recheck the exact production
      // runtime before and after every component launch and at stop.
    },
    900_000,
  );
});
