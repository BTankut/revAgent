import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CORE_PRODUCTION_ORACLES,
  canonicalManifest,
  evaluateSupervisedCaseExecutions,
  executeProductionCaseBothBindings,
} from "../src/index.js";
import type {
  Binding,
  ExecutionPlan,
  ParentOwnedCaseEvaluator,
  ProcessObservationRecord,
} from "../src/index.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(caseId: string): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    `production-${caseId.toLowerCase()}`,
  );
}

function payload(record: ProcessObservationRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

function allBindings(
  records: readonly ProcessObservationRecord[],
  predicate: (binding: Binding, rows: readonly ProcessObservationRecord[]) => boolean,
): boolean {
  return (["wss", "streamable_http_sse"] as const).every((binding) =>
    predicate(binding, records.filter((record) => record.binding === binding)));
}

function evaluator(caseId: "O1-C01" | "O1-C05"): ParentOwnedCaseEvaluator {
  const assertionIds = canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => id);
  const bindingPredicate = (binding: Binding, rows: readonly ProcessObservationRecord[]): boolean =>
    binding === rows[0]?.binding && assertionIds.every((assertionId) =>
      CORE_PRODUCTION_ORACLES.get(assertionId)!({
        caseId,
        binding,
        assertion: canonicalManifest.requiredAssertions[caseId]!.find(({ id }) => id === assertionId)!,
        observations: rows,
      }));
  return {
    caseId,
    probes(records) {
      const ids = records.map(({ observationId }) => observationId);
      return assertionIds.map((assertionId) => ({
        assertionId,
        observationIds: ids,
        evaluate: (selected: readonly ProcessObservationRecord[]) => {
          const assertion = canonicalManifest.requiredAssertions[caseId]!.find(({ id }) => id === assertionId)!;
          const oracle = CORE_PRODUCTION_ORACLES.get(assertionId)!;
          return allBindings(selected, (binding, rows) => oracle({
            caseId,
            binding,
            assertion,
            observations: rows,
          }));
        },
      }));
    },
    bindingPassed: bindingPredicate,
  };
}

describe("production three-process case stack", () => {
  it.each(["O1-C01", "O1-C05"] as const)(
    "runs %s through both real Gateway bindings and parent-owned predicates",
    async (caseId) => {
      const plan = productionPlan(caseId);
      const executions = await executeProductionCaseBothBindings({
        plan,
        repoRoot,
        caseId,
      });
      const evaluated = evaluateSupervisedCaseExecutions({
        runId: plan.runId,
        caseId,
        executions: executions.map(({ binding, evidence, durationMs }) => ({
          binding,
          observations: evidence.observations,
          durationMs,
        })),
        evaluator: evaluator(caseId),
      });
      expect(evaluated.status).toBe("passed");
      expect(evaluated.bindings.map(({ status }) => status)).toEqual(["passed", "passed"]);
      expect(evaluated.assertions.every(({ passed, actual }) => passed === true && actual === true)).toBe(true);

      for (const execution of executions) {
        const captures = execution.evidence.captures;
        if (execution.binding === "wss") {
          expect(String(captures["gateway.ready.ws_url"])).toMatch(/^wss:\/\/127\.0\.0\.1:/u);
          expect(captures["gateway.ready.ca_certificate_sha256"]).toMatch(/^sha256:[0-9a-f]{64}$/u);
          expect(captures["gateway.ready.server_certificate_sha256"]).toMatch(/^sha256:[0-9a-f]{64}$/u);
          const caPath = String(captures["gateway.ready.ca_certificate_path"]);
          expect(path.isAbsolute(caPath)).toBe(true);
          expect(existsSync(caPath)).toBe(false);
        } else {
          expect(String(captures["gateway.ready.http_connection_url"])).toMatch(
            /^http:\/\/127\.0\.0\.1:/u,
          );
          expect(captures["gateway.ready.ca_certificate_path"]).toBeNull();
        }
        const lifecycles = execution.evidence.observations.filter(({ kind }) => kind === "process_lifecycle");
        const stopped = lifecycles.filter((record) => payload(record).phase === "stopped");
        const stoppedAt = (stepId: string) => stopped.filter((record) =>
          payload(record).processRole === "canonical_component" &&
          payload(record).stepId === stepId);
        expect(stoppedAt(`${caseId.toLowerCase()}.resource-baseline-stop`))
          .toHaveLength(3);
        const terminalStopped = stoppedAt(`${caseId.toLowerCase()}.stack-stop`);
        expect(terminalStopped).toHaveLength(3);
        expect(new Set(terminalStopped.map((record) =>
          Number((payload(record).process as Record<string, unknown>).pid))).size).toBe(3);
        expect(stopped.every((record) =>
          payload(record).orphanProcessCount === 0 &&
          payload(record).killEscalated === false)).toBe(true);
      }
    },
    90_000,
  );
});
