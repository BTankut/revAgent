import { composeCanonicalAssertionOracleRegistry } from "./canonicalEvaluators.js";
import { canonicalManifest } from "./manifest.js";
import { CORE_PRODUCTION_ORACLES } from "./productionCaseOraclesCore.js";
import { EARLY_PRODUCTION_ORACLES } from "./productionCaseOraclesEarly.js";
import { MIDDLE_PRODUCTION_ORACLES } from "./productionCaseOraclesMiddle.js";
import { RAW_PRODUCTION_ORACLES } from "./productionCaseOraclesRaw.js";
import { executeProductionCaseBothBindings } from "./productionCaseRunner.js";
import { executeEarlyProductionCaseBothBindings } from "./productionCaseRunnerEarly.js";
import { executeMiddleProductionCaseBothBindings } from "./productionCaseRunnerMiddle.js";
import { executeRawProductionCaseBothBindings } from "./productionCaseRunnerRaw.js";
import { SUPPORTED_PRODUCTION_CASES } from "./productionCaseSeeds.js";
import { EARLY_PRODUCTION_CASES } from "./productionCaseSeedsEarly.js";
import { MIDDLE_PRODUCTION_CASES } from "./productionCaseSeedsMiddle.js";
import { RAW_PRODUCTION_CASES } from "./productionCaseSeedsRaw.js";
import type { CanonicalAssertionOracleRegistry } from "./canonicalEvaluators.js";
import type {
  ProductionCaseBindingEvidence,
  ProductionCaseExecutor,
} from "./productionSuiteRunner.js";

export interface ProductionCaseSlice {
  readonly name: string;
  readonly caseIds: readonly string[];
  readonly oracles: CanonicalAssertionOracleRegistry;
  readonly executeCase: ProductionCaseExecutor;
}

export interface ProductionCaseComposition {
  readonly caseOwners: ReadonlyMap<string, string>;
  readonly oracles: CanonicalAssertionOracleRegistry;
  readonly executeCase: ProductionCaseExecutor;
}

function exactAssertionsForCases(caseIds: readonly string[]): string[] {
  return caseIds.flatMap((caseId) =>
    canonicalManifest.requiredAssertions[caseId]?.map(({ id }) => id) ?? []);
}

function assertExactSliceOracles(slice: ProductionCaseSlice): void {
  const expected = exactAssertionsForCases(slice.caseIds);
  const expectedSet = new Set(expected);
  const observed = [...slice.oracles.keys()];
  const missing = expected.filter((assertionId) => !slice.oracles.has(assertionId));
  const unknown = observed.filter((assertionId) => !expectedSet.has(assertionId));
  if (
    missing.length > 0 ||
    unknown.length > 0 ||
    new Set(observed).size !== observed.length ||
    observed.length !== expected.length
  ) {
    throw new Error([
      `production case slice ${slice.name} has an invalid oracle boundary`,
      `missing: ${missing.join(", ") || "none"}`,
      `unknown: ${unknown.join(", ") || "none"}`,
    ].join("; "));
  }
}

function assertExactBindingExecutions(
  caseId: string,
  executions: readonly ProductionCaseBindingEvidence[],
): void {
  const bindings = executions.map(({ binding }) => binding);
  const expected = canonicalManifest.cases.find(({ id }) => id === caseId)?.bindings ?? [];
  if (
    bindings.length !== expected.length ||
    new Set(bindings).size !== bindings.length ||
    expected.some((binding, index) => bindings[index] !== binding)
  ) {
    throw new Error(
      `${caseId} executor returned bindings ${bindings.join(", ") || "none"}; expected ${expected.join(", ")}`,
    );
  }
}

/**
 * Joins independently implemented production slices while enforcing both
 * ownership boundaries: every canonical case has exactly one executor and
 * every canonical assertion has exactly one parent-owned oracle.
 */
export function createProductionCaseComposition(
  slices: readonly ProductionCaseSlice[],
): ProductionCaseComposition {
  if (slices.length === 0) throw new Error("production case composition requires at least one slice");
  const canonicalCases = canonicalManifest.cases.map(({ id }) => id);
  const canonicalSet = new Set(canonicalCases);
  const owners = new Map<string, ProductionCaseSlice>();
  for (const slice of slices) {
    if (slice.name.length === 0 || slice.caseIds.length === 0) {
      throw new Error("production case slices require a name and at least one case");
    }
    assertExactSliceOracles(slice);
    for (const caseId of slice.caseIds) {
      if (!canonicalSet.has(caseId)) {
        throw new Error(`production case slice ${slice.name} owns unknown case ${caseId}`);
      }
      const prior = owners.get(caseId);
      if (prior !== undefined) {
        throw new Error(
          `production case ${caseId} is owned by both ${prior.name} and ${slice.name}`,
        );
      }
      owners.set(caseId, slice);
    }
  }
  const missing = canonicalCases.filter((caseId) => !owners.has(caseId));
  if (missing.length > 0 || owners.size !== canonicalCases.length) {
    throw new Error(
      `production case composition does not exactly own O1-C01..C40; missing: ${missing.join(", ") || "none"}`,
    );
  }
  const oracles = composeCanonicalAssertionOracleRegistry(
    ...slices.map(({ oracles: registry }) => registry),
  );
  const executeCase: ProductionCaseExecutor = async (input) => {
    const slice = owners.get(input.caseId);
    if (slice === undefined) {
      throw new Error(`production case dispatcher has no owner for ${input.caseId}`);
    }
    const executions = await slice.executeCase(input);
    assertExactBindingExecutions(input.caseId, executions);
    return executions;
  };
  return {
    caseOwners: new Map(canonicalCases.map((caseId) => [caseId, owners.get(caseId)!.name])),
    oracles,
    executeCase,
  };
}

/**
 * The only executable production catalog. Construction itself proves exact
 * C01-C40 ownership and exact 167-oracle coverage before any process starts.
 */
export const PRODUCTION_CASE_COMPOSITION = createProductionCaseComposition([
  {
    name: "core",
    caseIds: SUPPORTED_PRODUCTION_CASES,
    oracles: CORE_PRODUCTION_ORACLES,
    executeCase: executeProductionCaseBothBindings,
  },
  {
    name: "early",
    caseIds: EARLY_PRODUCTION_CASES,
    oracles: EARLY_PRODUCTION_ORACLES,
    executeCase: executeEarlyProductionCaseBothBindings,
  },
  {
    name: "middle",
    caseIds: MIDDLE_PRODUCTION_CASES,
    oracles: MIDDLE_PRODUCTION_ORACLES,
    executeCase: executeMiddleProductionCaseBothBindings,
  },
  {
    name: "raw",
    caseIds: RAW_PRODUCTION_CASES,
    oracles: RAW_PRODUCTION_ORACLES,
    executeCase: executeRawProductionCaseBothBindings,
  },
]);
