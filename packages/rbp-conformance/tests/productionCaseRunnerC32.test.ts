import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { executeRawProductionCaseBothBindings } from "../src/productionCaseRunnerRaw.js";
import type { ExecutionPlan, ProcessObservationRecord } from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    "registered-session-o1-c32",
  );
}

function stoppedLifecycle(observation: ProcessObservationRecord): boolean {
  if (observation.kind !== "process_lifecycle") return false;
  const payload = observation.payload as Record<string, unknown>;
  return payload.phase === "stopped" &&
    payload.action === "stop_case_stack" &&
    payload.processRole === "canonical_component";
}

describe("O1-C32 registered-session production conformance", () => {
  it("passes every exact chunk assertion on both current-stack bindings", async () => {
    const executions = await executeRawProductionCaseBothBindings({
      plan: productionPlan(),
      repoRoot,
      caseId: "O1-C32",
    });
    const assertions = canonicalManifest.requiredAssertions["O1-C32"]!;
    const report: Array<{ binding: string; assertionId: string; passed: boolean }> = [];
    for (const execution of executions) {
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
    }
    const actionEvidence = executions.flatMap((execution) =>
      execution.evidence.observations
        .filter(({ kind, payload }) =>
          kind === "control_result" &&
          (payload as Record<string, unknown>).stepId === "o1-c32.base64_alphabet")
        .map(({ payload }) => payload as Record<string, unknown>)
        .map((payload) => ({ binding: execution.binding, payload })));
    expect(executions.map(({ binding }) => binding)).toEqual([
      "wss",
      "streamable_http_sse",
    ]);
    expect(report, JSON.stringify(actionEvidence, null, 2)).toEqual(
      report.map((entry) => ({ ...entry, passed: true })),
    );
    for (const execution of executions) {
      expect(execution.evidence.observations.filter(stoppedLifecycle)).toHaveLength(3);
      expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
        /"(?:actual|passed|verdict)"\s*:/u,
      );
    }
  }, 180_000);
});
