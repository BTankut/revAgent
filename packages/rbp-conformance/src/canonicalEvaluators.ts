import { canonicalManifest } from "./manifest.js";
import type { ParentAssertionProbe } from "./observationLedger.js";
import type {
  ParentCaseEvaluatorRegistry,
  ParentOwnedCaseEvaluator,
} from "./suiteRunner.js";
import type {
  Binding,
  ManifestAssertion,
  ProcessObservationRecord,
} from "./types.js";

/**
 * One runner-owned predicate for one canonical assertion and one binding.
 *
 * The predicate receives immutable raw observations only. It must derive the
 * semantic answer itself; child processes and transport drivers cannot supply
 * an `actual` or `passed` value through this interface.
 */
export interface CanonicalAssertionOracleContext {
  readonly caseId: string;
  readonly binding: Binding;
  readonly assertion: Readonly<ManifestAssertion>;
  readonly observations: readonly ProcessObservationRecord[];
}

export type CanonicalAssertionOracle = (
  context: Readonly<CanonicalAssertionOracleContext>,
) => boolean;

export type CanonicalAssertionOracleRegistry = ReadonlyMap<
  string,
  CanonicalAssertionOracle
>;

function canonicalAssertionEntries(): Array<{
  caseId: string;
  assertion: ManifestAssertion;
}> {
  return canonicalManifest.cases.flatMap(({ id: caseId }) =>
    canonicalManifest.requiredAssertions[caseId]!.map((assertion) => ({
      caseId,
      assertion,
    })),
  );
}

/** Fail closed unless the registry contains every canonical assertion once. */
export function assertCompleteCanonicalAssertionOracleRegistry(
  registry: CanonicalAssertionOracleRegistry,
): void {
  const canonical = canonicalAssertionEntries();
  const knownIds = new Set(canonical.map(({ assertion }) => assertion.id));
  const unknown = [...registry.keys()].filter((assertionId) => !knownIds.has(assertionId));
  const missing = canonical
    .map(({ assertion }) => assertion.id)
    .filter((assertionId) => !registry.has(assertionId));
  const nonFunctions = [...registry.entries()]
    .filter(([, oracle]) => typeof oracle !== "function")
    .map(([assertionId]) => assertionId);

  if (unknown.length > 0 || missing.length > 0 || nonFunctions.length > 0 || registry.size !== canonical.length) {
    throw new Error([
      "canonical assertion oracle registry is incomplete or invalid",
      `missing: ${missing.join(", ") || "none"}`,
      `unknown: ${unknown.join(", ") || "none"}`,
      `non-functions: ${nonFunctions.join(", ") || "none"}`,
    ].join("; "));
  }
}

/**
 * Composes independently owned case slices without allowing one slice to
 * overwrite another. The returned registry is complete by construction.
 */
export function composeCanonicalAssertionOracleRegistry(
  ...registries: readonly CanonicalAssertionOracleRegistry[]
): CanonicalAssertionOracleRegistry {
  const composed = new Map<string, CanonicalAssertionOracle>();
  for (const registry of registries) {
    for (const [assertionId, oracle] of registry) {
      if (composed.has(assertionId)) {
        throw new Error(`duplicate canonical assertion oracle: ${assertionId}`);
      }
      composed.set(assertionId, oracle);
    }
  }
  assertCompleteCanonicalAssertionOracleRegistry(composed);
  return composed;
}

function observationsForBinding(
  observations: readonly ProcessObservationRecord[],
  binding: Binding,
): ProcessObservationRecord[] {
  return observations
    .filter((observation) => observation.binding === binding)
    .map((observation) => structuredClone(observation));
}

function evaluateOracle(
  oracle: CanonicalAssertionOracle,
  caseId: string,
  assertion: ManifestAssertion,
  binding: Binding,
  observations: readonly ProcessObservationRecord[],
): boolean {
  return oracle({
    caseId,
    assertion: structuredClone(assertion),
    binding,
    observations: observationsForBinding(observations, binding),
  }) === true;
}

function probesForCase(
  caseId: string,
  observations: readonly ProcessObservationRecord[],
  oracles: CanonicalAssertionOracleRegistry,
): ParentAssertionProbe[] {
  const manifestCase = canonicalManifest.cases.find(({ id }) => id === caseId)!;
  const observationIds = observations.map(({ observationId }) => observationId);
  return canonicalManifest.requiredAssertions[caseId]!.map((assertion) => {
    const oracle = oracles.get(assertion.id)!;
    return {
      assertionId: assertion.id,
      // Coverage remains a separate ledger gate. Supplying every same-case
      // observation here cannot make a predicate true; it only lets the ledger
      // prove required component/binding/kind coverage for the assertion.
      observationIds: [...observationIds],
      evaluate: (records: readonly ProcessObservationRecord[]) =>
        manifestCase.bindings.every((binding) =>
          evaluateOracle(oracle, caseId, assertion, binding, records)),
      message: "runner-owned canonical assertion predicate failed",
    };
  });
}

function evaluatorForCase(
  caseId: string,
  oracles: CanonicalAssertionOracleRegistry,
): ParentOwnedCaseEvaluator {
  const manifestCase = canonicalManifest.cases.find(({ id }) => id === caseId)!;
  return {
    caseId,
    probes: (observations) => probesForCase(caseId, observations, oracles),
    bindingPassed: (binding, observations) => {
      if (!manifestCase.bindings.includes(binding)) return false;
      return canonicalManifest.requiredAssertions[caseId]!.every((assertion) => {
        const oracle = oracles.get(assertion.id)!;
        return evaluateOracle(oracle, caseId, assertion, binding, observations);
      });
    },
  };
}

/**
 * Build the complete forty-case evaluator registry from explicit assertion
 * predicates. There is deliberately no default or "all controls succeeded"
 * fallback: all 167 semantic assertions must have runner-owned code.
 */
export function buildCanonicalParentEvaluatorRegistry(
  oracles: CanonicalAssertionOracleRegistry,
): ParentCaseEvaluatorRegistry {
  assertCompleteCanonicalAssertionOracleRegistry(oracles);
  return new Map(canonicalManifest.cases.map(({ id: caseId }) => [
    caseId,
    evaluatorForCase(caseId, oracles),
  ]));
}
