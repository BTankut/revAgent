import { describe, expect, it } from "vitest";

import {
  ASSERTION_EVIDENCE_BINDINGS,
  CaseObservationLedger,
} from "../src/observationLedger.js";
import { canonicalManifest } from "../src/manifest.js";
import type { ProcessObservationRecord } from "../src/types.js";

describe("same-case process observation binding", () => {
  it("maps every one of the 167 frozen assertions to explicit component/binding/kind coverage", () => {
    const count = Object.values(canonicalManifest.requiredAssertions).reduce((sum, assertions) => sum + assertions.length, 0);
    expect(count).toBe(167);
    expect(ASSERTION_EVIDENCE_BINDINGS.size).toBe(count);
  });

  it("computes pass in the runner only after all required raw process evidence resolves", () => {
    const caseId = "O1-C08";
    const assertion = canonicalManifest.requiredAssertions[caseId]![0]!;
    const binding = ASSERTION_EVIDENCE_BINDINGS.get(assertion.id)!;
    const ledger = new CaseObservationLedger("run-1", caseId);
    const ids: string[] = [];
    let ordinal = 0;
    for (const transport of binding.requiredBindings) {
      for (const component of binding.requiredComponents) {
        for (const kind of binding.requiredKinds) {
          const observationId = `obs-${++ordinal}`;
          ids.push(observationId);
          ledger.add({
            schemaVersion: "rbp-process-observation/v1",
            observationId,
            runId: "run-1",
            caseId,
            binding: transport,
            componentId: component,
            kind,
            at: "2026-07-22T00:00:00.000Z",
            payload: { observed: true },
          });
        }
      }
    }
    const results = ledger.evaluate([{ assertionId: assertion.id, actual: true, observationIds: ids }]);
    expect(results.find(({ assertionId }) => assertionId === assertion.id)?.passed).toBe(true);
    expect(results.filter(({ passed }) => passed).length).toBe(1);
  });

  it("rejects a child-supplied pass bit and cross-case observation identity", () => {
    const ledger = new CaseObservationLedger("run-1", "O1-C01");
    const wrong = {
      schemaVersion: "rbp-process-observation/v1",
      observationId: "wrong-case",
      runId: "run-1",
      caseId: "O1-C02",
      binding: "wss",
      componentId: "gateway_stub",
      kind: "wire_event",
      at: "2026-07-22T00:00:00.000Z",
      payload: {},
    } as ProcessObservationRecord;
    expect(() => ledger.add(wrong)).toThrow(/not bound/u);
    expect(() => ledger.evaluate([{
      assertionId: canonicalManifest.requiredAssertions["O1-C01"]![0]!.id,
      actual: true,
      observationIds: [],
      passed: true,
    } as never])).toThrow(/must not carry/u);
  });
});
