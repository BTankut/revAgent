import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { CanonicalAssertionOracleContext } from "../src/canonicalEvaluators.js";
import { canonicalManifest } from "../src/manifest.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { executeRawProductionCaseBothBindings } from "../src/productionCaseRunnerRaw.js";
import type {
  ExecutionPlan,
  ManifestAssertion,
  ProcessObservationRecord,
} from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const caseIds = ["O1-C28", "O1-C38", "O1-C39"] as const;

function productionPlan(caseId: (typeof caseIds)[number]): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    `production-${caseId.toLowerCase()}-recovery`,
  );
}

function oracleContext(
  caseId: (typeof caseIds)[number],
  execution: {
    readonly binding: "wss" | "streamable_http_sse";
    readonly evidence: { readonly observations: readonly ProcessObservationRecord[] };
  },
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

describe.sequential("C28/C38/C39 production recovery regressions", () => {
  it.each(caseIds)(
    "%s passes every frozen assertion on both real Gateway bindings",
    async (caseId) => {
      const executions = await executeRawProductionCaseBothBindings({
        plan: productionPlan(caseId),
        repoRoot,
        caseId,
      });

      for (const execution of executions) {
        const results = canonicalManifest.requiredAssertions[caseId]!.map((assertion) => ({
          assertionId: assertion.id,
          passed: RAW_PRODUCTION_ORACLES.get(assertion.id)?.(
            oracleContext(caseId, execution, assertion),
          ) === true,
        }));
        const controls = execution.evidence.observations
          .filter(({ kind }) => kind === "control_result")
          .map((record) => ({
            stepId: payload(record).stepId,
            response: payload(record).response,
          }));
        expect(
          results.every(({ passed }) => passed),
          JSON.stringify({ caseId, binding: execution.binding, results, controls }),
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
    300_000,
  );
});
