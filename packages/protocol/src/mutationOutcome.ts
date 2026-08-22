export const MUTATION_OUTCOME_SCHEMA = "revagent.mutation-outcome/v1" as const;

export type DispatchState =
  | "not_started"
  | "may_have_reached_addin"
  | "response_observed";

export type EffectState =
  | "not_started"
  | "read_only"
  | "rolled_back"
  | "committed"
  | "unknown";

export type TransactionMode = "auto" | "none" | "native" | "not_applicable";

export interface AddinMutationOutcomeEvidence {
  readonly schema: typeof MUTATION_OUTCOME_SCHEMA;
  readonly effectState: EffectState;
  readonly transactionMode: TransactionMode;
  readonly evidence: {
    readonly source: string;
    readonly transactionStatus: EffectState;
  };
}

export interface MutationOutcomeEvidence extends AddinMutationOutcomeEvidence {
  readonly dispatchState: DispatchState;
}

export type MutationErrorDisposition =
  | "known_non_committing"
  | "journal_indeterminate";

const effects = new Set<EffectState>([
  "not_started",
  "read_only",
  "rolled_back",
  "committed",
  "unknown",
]);
const modes = new Set<TransactionMode>(["auto", "none", "native", "not_applicable"]);
const dispatches = new Set<DispatchState>([
  "not_started",
  "may_have_reached_addin",
  "response_observed",
]);
const codePattern = /^[a-z][a-z0-9_]{0,63}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

export function parseAddinMutationOutcomeEvidence(
  value: unknown,
): AddinMutationOutcomeEvidence | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["schema", "effectState", "transactionMode", "evidence"])) {
    return null;
  }
  if (
    candidate.schema !== MUTATION_OUTCOME_SCHEMA ||
    !effects.has(candidate.effectState as EffectState) ||
    !modes.has(candidate.transactionMode as TransactionMode)
  ) {
    return null;
  }
  const witness = candidate.evidence;
  if (witness === null || typeof witness !== "object" || Array.isArray(witness)) return null;
  const evidence = witness as Record<string, unknown>;
  if (
    !exactKeys(evidence, ["source", "transactionStatus"]) ||
    typeof evidence.source !== "string" ||
    !codePattern.test(evidence.source) ||
    evidence.transactionStatus !== candidate.effectState
  ) {
    return null;
  }
  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 2_048) return null;
  return structuredClone(candidate) as unknown as AddinMutationOutcomeEvidence;
}

export function knownNotDispatched(evidence: MutationOutcomeEvidence): boolean {
  return evidence.dispatchState === "not_started" && evidence.effectState === "not_started";
}

export function classifyMutationError(
  evidence: MutationOutcomeEvidence,
): MutationErrorDisposition {
  return evidence.effectState === "not_started" || evidence.effectState === "rolled_back"
    ? "known_non_committing"
    : "journal_indeterminate";
}

export function validateMutationOutcomeEvidence(evidence: MutationOutcomeEvidence): void {
  if (!dispatches.has(evidence.dispatchState)) {
    throw new TypeError("dispatchState is outside the DC-02 taxonomy");
  }
  const addinEvidence: AddinMutationOutcomeEvidence = {
    schema: evidence.schema,
    effectState: evidence.effectState,
    transactionMode: evidence.transactionMode,
    evidence: evidence.evidence,
  };
  if (parseAddinMutationOutcomeEvidence(addinEvidence) === null) {
    throw new TypeError("outcome evidence is not exact and bounded");
  }
  if (evidence.dispatchState === "not_started" && evidence.effectState !== "not_started") {
    throw new TypeError("not_started dispatch requires not_started effect");
  }
  if (evidence.effectState === "committed" && evidence.dispatchState !== "response_observed") {
    throw new TypeError("committed effect requires response-observed evidence");
  }
}
