import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import type { ParentStepExecutionEvidence } from "../src/parentStepEngine.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import {
  executeRawProductionCaseBinding,
} from "../src/productionCaseRunnerRaw.js";
import type {
  Binding,
  ExecutionPlan,
  ManifestAssertion,
  ProcessObservationRecord,
} from "../src/types.js";
import type { CanonicalAssertionOracleContext } from "../src/canonicalEvaluators.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const caseId = "O1-C27";

interface C27Execution {
  readonly binding: Binding;
  readonly evidence: ParentStepExecutionEvidence;
}

function productionPlan(): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    "production-o1-c27-backoff",
  );
}

async function executeBinding(
  plan: ExecutionPlan,
  binding: Binding,
): Promise<C27Execution> {
  const execution = await executeRawProductionCaseBinding({
    plan,
    repoRoot,
    caseId,
    binding,
  });
  return {
    binding: execution.binding,
    evidence: execution.evidence,
  };
}

function oracleContext(
  execution: C27Execution,
  assertion: ManifestAssertion,
): CanonicalAssertionOracleContext {
  return {
    caseId,
    binding: execution.binding,
    assertion: structuredClone(assertion),
    observations: execution.evidence.observations
      .filter(({ binding }) => binding === execution.binding)
      .map((observation) => structuredClone(observation)),
  };
}

function payload(record: ProcessObservationRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

describe.sequential("C27 production reconnect backoff", () => {
  it("fails all four semantic oracles closed without Bridge evidence", () => {
    for (const assertion of canonicalManifest.requiredAssertions[caseId]!) {
      const oracle = RAW_PRODUCTION_ORACLES.get(assertion.id);
      expect(oracle, assertion.id).toBeTypeOf("function");
      for (const binding of ["wss", "streamable_http_sse"] as const) {
        expect(oracle?.({
          caseId,
          binding,
          assertion,
          observations: [],
        }), `${assertion.id}/${binding} accepted empty evidence`).toBe(false);
      }
    }
  });

  it(
    "proves attempts 0..8, the 60-second cap, and the exact 120-second reset on both bindings",
    async () => {
      const plan = productionPlan();
      const executions: C27Execution[] = [];
      for (const binding of ["wss", "streamable_http_sse"] as const) {
        executions.push(await executeBinding(plan, binding));
      }

      for (const execution of executions) {
        const results = canonicalManifest.requiredAssertions[caseId]!.map((assertion) => ({
          assertionId: assertion.id,
          passed: RAW_PRODUCTION_ORACLES.get(assertion.id)?.(
            oracleContext(execution, assertion),
          ) === true,
        }));
        const snapshots = execution.evidence.observations
          .filter(({ kind }) => kind === "bridge_snapshot")
          .map((record) => ({
            stepId: payload(record).stepId,
            reconnectConformance: payload(record).reconnectConformance,
            peer: payload(record).peer,
          }));
        expect(
          results.every(({ passed }) => passed),
          JSON.stringify({ binding: execution.binding, results, snapshots }),
        ).toBe(true);

        const stopped = execution.evidence.observations
          .filter(({ kind }) => kind === "process_lifecycle")
          .filter((record) => payload(record).phase === "stopped");
        expect(stopped).toHaveLength(3);
        expect(new Set(stopped.map((record) =>
          Number((payload(record).process as Record<string, unknown>).pid))).size)
          .toBe(3);
        expect(stopped.every((record) =>
          payload(record).orphanProcessCount === 0 &&
          payload(record).killEscalated === false)).toBe(true);
        expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
          /"(?:actual|passed|verdict)"\s*:/u,
        );
      }
    },
    180_000,
  );
});
