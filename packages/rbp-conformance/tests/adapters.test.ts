import { describe, expect, it } from "vitest";

import {
  assertCompleteObservationOnlyAdapterRegistry,
  assertObservationOnlyBatch,
  validateObservationOnlyAdapterRegistry,
  type ObservationOnlyCaseAdapter,
} from "../src/adapters.js";
import { canonicalManifest } from "../src/manifest.js";
import {
  assertCompleteParentCaseEvaluatorRegistry,
  evaluateSupervisedCaseExecutions,
  validateParentCaseEvaluatorRegistry,
  type ParentOwnedCaseEvaluator,
} from "../src/suiteRunner.js";
import type { Binding, ComponentId, ProcessObservationRecord } from "../src/types.js";

const caseId = "O1-C19";

function observation(
  binding: Binding,
  componentId: ComponentId,
  kind: ProcessObservationRecord["kind"],
  ordinal: number,
): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${binding}-${componentId}-${kind}-${ordinal}`,
    runId: "run-observation-only",
    caseId,
    binding,
    componentId,
    kind,
    at: "2026-07-23T00:00:00.000Z",
    payload: { event: "raw_fixture_observation" },
  };
}

function bindingObservations(binding: Binding): ProcessObservationRecord[] {
  return [
    observation(binding, "gateway_stub", "process_lifecycle", 1),
    observation(binding, "bridge_simulator", "process_lifecycle", 2),
    observation(binding, "addin_loopback_fixture", "process_lifecycle", 3),
    observation(binding, "addin_loopback_fixture", "wire_event", 4),
    observation(binding, "addin_loopback_fixture", "fixture_execution_count", 5),
  ];
}

describe("observation-only full-suite extension seam", () => {
  it("accepts canonical raw batches and rejects child-supplied assertion outcomes", () => {
    const valid = { observations: bindingObservations("wss") };
    expect(() => assertObservationOnlyBatch(valid, {
      runId: "run-observation-only",
      caseId,
      binding: "wss",
    })).not.toThrow();

    const opaquePayload = structuredClone(valid) as unknown as {
      observations: Array<ProcessObservationRecord & { payload: { actual: boolean; passed: boolean } }>;
    };
    opaquePayload.observations[0]!.payload = { actual: true, passed: true };
    expect(() => assertObservationOnlyBatch(opaquePayload, {
      runId: "run-observation-only",
      caseId,
      binding: "wss",
    })).not.toThrow();
    const selfAsserted = structuredClone(valid) as unknown as {
      observations: Array<ProcessObservationRecord & { actual: boolean; passed: boolean }>;
    };
    selfAsserted.observations[0]!.actual = true;
    selfAsserted.observations[0]!.passed = true;
    expect(() => assertObservationOnlyBatch(selfAsserted, {
      runId: "run-observation-only",
      caseId,
      binding: "wss",
    })).toThrow(/observation-envelope actual or passed/u);
    expect(() => assertObservationOnlyBatch({ ...valid, passed: true }, {
      runId: "run-observation-only",
      caseId,
      binding: "wss",
    })).toThrow(/observations only/u);
  });

  it("retains registries and parent-owned evaluation for future canonical cases", () => {
    const manifestCase = canonicalManifest.cases.find(({ id }) => id === caseId)!;
    const adapter: ObservationOnlyCaseAdapter = {
      caseId,
      supportedBindings: [...manifestCase.bindings],
      requiredComponents: [...manifestCase.requiredComponents],
      observe: async () => ({ observations: [] }),
    };
    expect(() => validateObservationOnlyAdapterRegistry(new Map([[caseId, adapter]]))).not.toThrow();
    expect(() => assertCompleteObservationOnlyAdapterRegistry(new Map([[caseId, adapter]]))).toThrow(/not a complete 40-case suite/u);

    const evaluator: ParentOwnedCaseEvaluator = {
      caseId,
      probes: (observations) => canonicalManifest.requiredAssertions[caseId]!.map((assertion) => ({
        assertionId: assertion.id,
        observationIds: observations.map(({ observationId }) => observationId),
        evaluate: () => true,
      })),
      bindingPassed: () => true,
    };
    expect(() => validateParentCaseEvaluatorRegistry(new Map([[caseId, evaluator]]))).not.toThrow();
    expect(() => assertCompleteParentCaseEvaluatorRegistry(new Map([[caseId, evaluator]]))).toThrow(/not a complete 40-case suite/u);
    const evaluated = evaluateSupervisedCaseExecutions({
      runId: "run-observation-only",
      caseId,
      evaluator,
      executions: manifestCase.bindings.map((binding) => ({
        binding,
        observations: bindingObservations(binding),
        durationMs: 1,
      })),
    });
    expect(evaluated.status).toBe("passed");
    expect(evaluated.assertions.every(({ passed, actual }) => passed === true && actual === true)).toBe(true);
  });
});
