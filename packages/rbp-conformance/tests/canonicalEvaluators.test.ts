import { describe, expect, it, vi } from "vitest";

import {
  assertCompleteCanonicalAssertionOracleRegistry,
  buildCanonicalParentEvaluatorRegistry,
  composeCanonicalAssertionOracleRegistry,
  type CanonicalAssertionOracle,
} from "../src/canonicalEvaluators.js";
import { canonicalManifest } from "../src/manifest.js";
import { assertCompleteParentCaseEvaluatorRegistry } from "../src/suiteRunner.js";
import type { Binding, ProcessObservationRecord } from "../src/types.js";

function allAssertionIds(): string[] {
  return canonicalManifest.cases.flatMap(({ id }) =>
    canonicalManifest.requiredAssertions[id]!.map(({ id: assertionId }) => assertionId));
}

function completeOracles(
  oracle: CanonicalAssertionOracle = () => true,
): Map<string, CanonicalAssertionOracle> {
  return new Map(allAssertionIds().map((assertionId) => [assertionId, oracle]));
}

function observation(caseId: string, binding: Binding): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${caseId}-${binding}`,
    runId: "canonical-evaluator-test",
    caseId,
    binding,
    componentId: "gateway_stub",
    kind: "control_result",
    at: "2026-07-23T00:00:00.000Z",
    payload: { raw: true },
  };
}

describe("canonical parent evaluators", () => {
  it("requires explicit runner-owned predicates for all 167 assertions", () => {
    const complete = completeOracles();
    expect(allAssertionIds()).toHaveLength(167);
    expect(() => assertCompleteCanonicalAssertionOracleRegistry(complete)).not.toThrow();

    complete.delete(allAssertionIds()[0]!);
    expect(() => assertCompleteCanonicalAssertionOracleRegistry(complete)).toThrow(/missing:/u);
  });

  it("rejects unknown oracle ids instead of treating them as extensions", () => {
    const oracles = completeOracles();
    oracles.set("O1-C99-INVENTED", () => true);
    expect(() => buildCanonicalParentEvaluatorRegistry(oracles)).toThrow(/unknown:/u);
  });

  it("composes independent slices without silent assertion replacement", () => {
    const entries = [...completeOracles()];
    const first = new Map(entries.slice(0, 80));
    const second = new Map(entries.slice(80));
    expect(composeCanonicalAssertionOracleRegistry(first, second).size).toBe(167);

    second.set(entries[0]![0], () => true);
    expect(() => composeCanonicalAssertionOracleRegistry(first, second)).toThrow(
      /duplicate canonical assertion oracle/u,
    );
  });

  it("builds exactly forty parent evaluators and invokes each oracle per binding", () => {
    const called = vi.fn<CanonicalAssertionOracle>(() => true);
    const registry = buildCanonicalParentEvaluatorRegistry(completeOracles(called));
    expect(() => assertCompleteParentCaseEvaluatorRegistry(registry)).not.toThrow();
    expect(registry.size).toBe(40);

    const caseId = "O1-C01";
    const observations = canonicalManifest.cases.find(({ id }) => id === caseId)!.bindings
      .map((binding) => observation(caseId, binding));
    const evaluator = registry.get(caseId)!;
    const probes = evaluator.probes(observations);
    expect(probes).toHaveLength(3);
    expect(probes.every((probe) => probe.evaluate(observations) === true)).toBe(true);
    expect(called).toHaveBeenCalledTimes(6);
    expect(called.mock.calls.map(([context]) => context.binding)).toEqual([
      "wss",
      "streamable_http_sse",
      "wss",
      "streamable_http_sse",
      "wss",
      "streamable_http_sse",
    ]);
  });

  it("keeps binding evaluation fail-closed when a predicate returns false", () => {
    const firstAssertion = canonicalManifest.requiredAssertions["O1-C01"]![0]!.id;
    const oracles = completeOracles();
    oracles.set(firstAssertion, ({ binding }) => binding !== "wss");
    const evaluator = buildCanonicalParentEvaluatorRegistry(oracles).get("O1-C01")!;

    expect(evaluator.bindingPassed("wss", [observation("O1-C01", "wss")])).toBe(false);
    expect(evaluator.bindingPassed(
      "streamable_http_sse",
      [observation("O1-C01", "streamable_http_sse")],
    )).toBe(true);
  });

  it("passes cloned observations so an oracle cannot mutate retained evidence", () => {
    const original = observation("O1-C01", "wss");
    const mutatingOracle: CanonicalAssertionOracle = ({ observations }) => {
      (observations[0]!.payload as { raw: boolean }).raw = false;
      return true;
    };
    const evaluator = buildCanonicalParentEvaluatorRegistry(completeOracles(mutatingOracle)).get("O1-C01")!;
    expect(evaluator.bindingPassed("wss", [original])).toBe(true);
    expect(original.payload).toEqual({ raw: true });
  });
});
