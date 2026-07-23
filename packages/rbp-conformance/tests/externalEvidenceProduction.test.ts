import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CaseStackSupervisor } from "../src/caseStackSupervisor.js";
import { caseProgram } from "../src/casePrograms.js";
import { canonicalManifest } from "../src/manifest.js";
import { executeParentSteps } from "../src/parentStepEngine.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { rawProductionCaseVariables } from "../src/productionCaseSeedsRaw.js";
import { createExternalEvidenceProductionDrivers } from "../src/productionDriversExternalEvidence.js";
import { productionComponentLaunchConfigs } from "../src/productionExecutionPlan.js";
import { sha256File } from "../src/executionPlan.js";
import type {
  Binding,
  ExecutionPlan,
  ProcessObservationRecord,
} from "../src/types.js";
import { createPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(caseId: "O1-C33" | "O1-C40"): ExecutionPlan {
  const plan = createPlan();
  plan.runId = `external-evidence-${caseId.toLowerCase()}`;
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

async function execute(
  caseId: "O1-C33" | "O1-C40",
  binding: Binding,
): Promise<ProcessObservationRecord[]> {
  const plan = productionPlan(caseId);
  const supervisor = new CaseStackSupervisor({ plan, repoRoot });
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
    return evidence.observations;
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
  it.each(["O1-C33", "O1-C40"] as const)(
    "runs %s against both real bindings with fail-closed parent oracles",
    async (caseId) => {
      for (const binding of ["wss", "streamable_http_sse"] as const) {
        const observations = await execute(caseId, binding);
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
        expect(stopped).toHaveLength(3);
        expect(stopped.every((record) =>
          payload(record).orphanProcessCount === 0 &&
          payload(record).killEscalated === false)).toBe(true);
      }
    },
    180_000,
  );
});
