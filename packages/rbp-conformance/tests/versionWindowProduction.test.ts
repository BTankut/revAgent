import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CaseStackSupervisor } from "../src/caseStackSupervisor.js";
import { caseProgram } from "../src/casePrograms.js";
import { canonicalManifest } from "../src/manifest.js";
import { executeParentSteps } from "../src/parentStepEngine.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { rawProductionCaseVariables } from "../src/productionCaseSeedsRaw.js";
import { createEarlyProductionCaseDrivers } from "../src/productionDriversEarly.js";
import type {
  Binding,
  ExecutionPlan,
  ProcessObservationRecord,
} from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const caseId = "O1-C26" as const;

function productionPlan(binding: Binding): ExecutionPlan {
  return createCurrentProductionPlan(repoRoot, `version-window-${binding}`);
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

async function execute(binding: Binding): Promise<ProcessObservationRecord[]> {
  const plan = productionPlan(binding);
  const supervisor = new CaseStackSupervisor({ plan, repoRoot });
  try {
    const evidence = await executeParentSteps({
      runId: plan.runId,
      caseId,
      binding,
      steps: caseProgram(caseId).steps,
      drivers: createEarlyProductionCaseDrivers(supervisor),
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

describe("C26 production version window", () => {
  it("passes all canonical C26 oracles through both real Gateway bindings", async () => {
    for (const binding of ["wss", "streamable_http_sse"] as const) {
      const observations = await execute(binding);
      const assertions = canonicalManifest.requiredAssertions[caseId]!;
      expect(assertions).toHaveLength(4);
      for (const assertion of assertions) {
        const oracle = RAW_PRODUCTION_ORACLES.get(assertion.id);
        expect(oracle, assertion.id).toBeTypeOf("function");
        expect(oracle!({
          caseId,
          binding,
          assertion,
          observations,
        }), `${binding}/${assertion.id}`).toBe(true);
      }

      const rawFrames = observations.filter((record) =>
        record.kind === "wire_event" &&
        payload(record).action === "send_binding_frame");
      expect(rawFrames).toHaveLength(4);
      expect(rawFrames.every((record) => !containsForbiddenVerdictKey(record.payload))).toBe(true);
      expect(rawFrames.map((record) => {
        const remote = payload(record).remoteOutcome as Record<string, unknown>;
        const negotiation = remote.negotiation as Record<string, unknown>;
        return negotiation.versionsHeader;
      })).toEqual(["2", "1", "2", "2"]);

      const stopped = observations.filter((record) =>
        record.kind === "process_lifecycle" &&
        payload(record).phase === "stopped");
      expect(stopped.every((record) =>
        payload(record).orphanProcessCount === 0 &&
        payload(record).killEscalated === false)).toBe(true);
      const canonicalStoppedAt = (stepId: string) => stopped.filter((record) =>
        payload(record).action === "stop_case_stack" &&
        payload(record).processRole === "canonical_component" &&
        payload(record).stepId === stepId);
      expect(canonicalStoppedAt("o1-c26.resource-baseline-stop")).toHaveLength(3);
      expect(canonicalStoppedAt("o1-c26.stack-stop")).toHaveLength(3);
    }
  }, 180_000);
});
