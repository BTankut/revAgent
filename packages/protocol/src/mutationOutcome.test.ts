import { describe, expect, it } from "vitest";

import {
  classifyMutationError,
  knownNotDispatched,
  parseAddinMutationOutcomeEvidence,
  validateMutationOutcomeEvidence,
  type EffectState,
  type MutationOutcomeEvidence,
} from "./mutationOutcome.js";

function evidence(
  effectState: EffectState,
  dispatchState: MutationOutcomeEvidence["dispatchState"] = "response_observed",
): MutationOutcomeEvidence {
  return {
    dispatchState,
    schema: "revagent.mutation-outcome/v1",
    effectState,
    transactionMode: "auto",
    evidence: { source: "execute_dynamic_code", transactionStatus: effectState },
  };
}

describe("DC-02 mutation outcome evidence", () => {
  it("reserves KnownNotDispatched for the exact not-started pair", () => {
    expect(knownNotDispatched(evidence("not_started", "not_started"))).toBe(true);
    expect(knownNotDispatched(evidence("not_started"))).toBe(false);
    expect(knownNotDispatched(evidence("unknown", "may_have_reached_addin"))).toBe(false);
  });

  it.each([
    ["not_started", "known_non_committing"],
    ["rolled_back", "known_non_committing"],
    ["read_only", "journal_indeterminate"],
    ["committed", "journal_indeterminate"],
    ["unknown", "journal_indeterminate"],
  ] as const)("classifies mutation error effect %s", (effectState, expected) => {
    expect(classifyMutationError(evidence(effectState))).toBe(expected);
  });

  it("rejects missing, extra, mismatched, and oversized add-in evidence", () => {
    const valid = evidence("rolled_back");
    const addin = {
      schema: valid.schema,
      effectState: valid.effectState,
      transactionMode: valid.transactionMode,
      evidence: valid.evidence,
    };
    expect(parseAddinMutationOutcomeEvidence(addin)).not.toBeNull();
    expect(parseAddinMutationOutcomeEvidence({ ...addin, extra: true })).toBeNull();
    expect(parseAddinMutationOutcomeEvidence({
      ...addin,
      evidence: { ...valid.evidence, transactionStatus: "committed" },
    })).toBeNull();
    expect(parseAddinMutationOutcomeEvidence({
      ...addin,
      evidence: { source: `x${"a".repeat(2_100)}`, transactionStatus: "rolled_back" },
    })).toBeNull();
  });

  it("rejects contradictory dispatch/effect combinations", () => {
    expect(() => validateMutationOutcomeEvidence(evidence("committed", "may_have_reached_addin")))
      .toThrow(/committed effect/);
    expect(() => validateMutationOutcomeEvidence(evidence("unknown", "not_started")))
      .toThrow(/not_started dispatch/);
  });
});
