import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CaseStackSupervisor,
  runFixtureBindPolicyProcess,
} from "../src/caseStackSupervisor.js";
import { caseProgram } from "../src/casePrograms.js";
import { canonicalManifest } from "../src/manifest.js";
import { executeParentSteps } from "../src/parentStepEngine.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { rawProductionCaseVariables } from "../src/productionCaseSeedsRaw.js";
import { createExternalEvidenceProductionDrivers } from "../src/productionDriversExternalEvidence.js";
import type {
  Binding,
  ExecutionPlan,
  ProcessObservationRecord,
} from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const THREE_COMPONENT_STACK_START_GUARD_CALLS = 3 * 2;
const STACK_STOP_GUARD_CALLS = 1;
const FIXTURE_BIND_PROBE_GUARD_CALLS = 2;
const CLEAN_RESOURCE_LIFECYCLE_GUARD_CALLS =
  (THREE_COMPONENT_STACK_START_GUARD_CALLS * 2) + (STACK_STOP_GUARD_CALLS * 2);

function productionPlan(caseId: "O1-C33" | "O1-C40"): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    `external-evidence-${caseId.toLowerCase()}`,
  );
}

async function execute(
  caseId: "O1-C33" | "O1-C40",
  binding: Binding,
): Promise<{ observations: ProcessObservationRecord[]; runtimeGuardCalls: number }> {
  const plan = productionPlan(caseId);
  let runtimeGuardCalls = 0;
  const supervisor = new CaseStackSupervisor({
    plan,
    repoRoot,
    runtimeLaunchGuard() {
      runtimeGuardCalls += 1;
    },
  });
  try {
    const evidence = await executeParentSteps({
      runId: plan.runId,
      caseId,
      binding,
      steps: caseProgram(caseId).steps,
      drivers: createExternalEvidenceProductionDrivers(supervisor),
      variables: rawProductionCaseVariables(caseId, { binding }),
    });
    expect(supervisor.active).toBe(false);
    return { observations: evidence.observations, runtimeGuardCalls };
  } finally {
    if (supervisor.active) {
      await supervisor.stopCaseStack(`${caseId.toLowerCase()}.test-abort`, "abort_and_drain");
    }
  }
}

function payload(record: ProcessObservationRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

function containsForbiddenVerdictKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenVerdictKey);
  if (value === null || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return Object.keys(object).some((key) =>
    key === "actual" || key === "passed" || key === "verdict") ||
    Object.values(object).some(containsForbiddenVerdictKey);
}

describe("C33/C40 external production evidence", () => {
  it("turns a direct-probe spawn error into a deterministic launch failure", async () => {
    await expect(runFixtureBindPolicyProcess({
      command: {
        executable: path.join(repoRoot, ".missing-c33-probe-executable"),
        args: [],
        workingDirectory: ".",
        environmentKeys: [],
        readiness: {
          kind: "stdout_pattern",
          value: "json",
          timeoutMs: 1_000,
        },
        shutdown: {
          signal: "SIGTERM",
          timeoutMs: 1_000,
        },
      },
      cwd: repoRoot,
      environment: {},
      probe: {
        host: "0.0.0.0",
        allowUnsafeBind: false,
      },
    })).rejects.toThrow(/fixture bind policy probe failed to launch:.*ENOENT/u);
  });

  it("fails closed when the C33 direct probe post-exit guard detects drift", async () => {
    const plan = productionPlan("O1-C33");
    let runtimeGuardCalls = 0;
    const supervisor = new CaseStackSupervisor({
      plan,
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
        if (runtimeGuardCalls === 8) {
          throw new Error("planned C33 post-exit runtime drift");
        }
      },
    });
    try {
      await supervisor.restartCaseStack({
        caseId: "O1-C33",
        binding: "streamable_http_sse",
        preserveState: false,
      }, "c33.guard-stack", "restart_case_stack");
      expect(runtimeGuardCalls).toBe(6);

      await expect(supervisor.probeFixtureBindPolicy({
        host: "0.0.0.0",
        allowUnsafeBind: false,
      })).rejects.toThrow(/planned C33 post-exit runtime drift/u);
      expect(runtimeGuardCalls).toBe(8);
      expect(supervisor.pids).toHaveLength(3);
    } finally {
      if (supervisor.active) {
        await supervisor.stopCaseStack("c33.guard-stop", "abort_and_drain");
      }
    }
  }, 30_000);

  it.each(["O1-C33", "O1-C40"] as const)(
    "runs %s against both real bindings with fail-closed parent oracles",
    async (caseId) => {
      for (const binding of ["wss", "streamable_http_sse"] as const) {
        const { observations, runtimeGuardCalls } = await execute(caseId, binding);
        // C33 adds two direct bind probes, each guarded before and after execution.
        const expectedRuntimeGuardCalls = CLEAN_RESOURCE_LIFECYCLE_GUARD_CALLS +
          (caseId === "O1-C33" ? FIXTURE_BIND_PROBE_GUARD_CALLS * 2 : 0);
        expect(runtimeGuardCalls).toBe(expectedRuntimeGuardCalls);
        const assertions = canonicalManifest.requiredAssertions[caseId]!;
        for (const assertion of assertions) {
          const oracle = RAW_PRODUCTION_ORACLES.get(assertion.id)!;
          expect(oracle({
            caseId,
            binding,
            assertion,
            observations,
          }), `${binding}/${assertion.id}`).toBe(true);
        }

        const schema = caseId === "O1-C33"
          ? "supervisor.loopback-probe/v1"
          : "supervisor.product-artifact-evidence/v1";
        const retained = observations.filter((record) => payload(record).schemaVersion === schema);
        expect(retained).toHaveLength(caseId === "O1-C33" ? 5 : 7);
        expect(retained.every((record) => !containsForbiddenVerdictKey(record.payload))).toBe(true);
        if (caseId === "O1-C40") {
          const serialized = JSON.stringify(retained.map(({ payload: value }) => value));
          expect(serialized).not.toMatch(/[A-Za-z]:[\\/](?![0-9a-f]{64})/u);
          expect(serialized).not.toContain("\\..\\");
          expect(serialized).not.toContain("/../");
        }

        const stopped = observations.filter((record) =>
          record.kind === "process_lifecycle" && payload(record).phase === "stopped");
        const stoppedAt = (stepId: string) => stopped.filter((record) =>
          payload(record).processRole === "canonical_component" &&
          payload(record).stepId === stepId);
        expect(stoppedAt(`${caseId.toLowerCase()}.resource-baseline-stop`))
          .toHaveLength(3);
        expect(stoppedAt(`${caseId.toLowerCase()}.stack-stop`))
          .toHaveLength(3);
        expect(stopped.every((record) =>
          payload(record).orphanProcessCount === 0 &&
          payload(record).killEscalated === false)).toBe(true);
      }
    },
    180_000,
  );
});
