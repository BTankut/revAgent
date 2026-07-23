import { assertObservationOnlyBatch } from "./adapters.js";
import { canonicalManifest } from "./manifest.js";
import { CaseObservationLedger, type ParentAssertionProbe } from "./observationLedger.js";
import { executeSupervisedC19Run } from "./supervisedC19.js";
import type {
  AssertionResult,
  Binding,
  BindingResult,
  CaseStatus,
  FailureEvidence,
  ProcessObservationRecord,
} from "./types.js";
import type { SupervisedC19RunInput, SupervisedC19RunResult } from "./supervisedC19.js";

export type ConformanceRunInput = SupervisedC19RunInput;
export type ConformanceRunResult = SupervisedC19RunResult;

/** Observation-only result of one parent-supervised binding execution. */
export interface SupervisedBindingExecution {
  binding: Binding;
  observations: ProcessObservationRecord[];
  durationMs: number;
  error?: Error;
}

/** Trusted runner code owns all assertion and binding predicates. */
export interface ParentOwnedCaseEvaluator {
  readonly caseId: string;
  probes(observations: readonly ProcessObservationRecord[]): readonly ParentAssertionProbe[];
  bindingPassed(binding: Binding, observations: readonly ProcessObservationRecord[]): boolean;
}

export type ParentCaseEvaluatorRegistry = ReadonlyMap<string, ParentOwnedCaseEvaluator>;

export interface EvaluatedSupervisedCase {
  assertions: AssertionResult[];
  bindings: BindingResult[];
  status: Extract<CaseStatus, "passed" | "failed" | "error">;
  failure: FailureEvidence | null;
  observations: ProcessObservationRecord[];
}

export function validateParentCaseEvaluatorRegistry(registry: ParentCaseEvaluatorRegistry): void {
  for (const [registeredCaseId, evaluator] of registry) {
    if (evaluator.caseId !== registeredCaseId || !canonicalManifest.cases.some(({ id }) => id === registeredCaseId)) {
      throw new Error(`parent evaluator registry has an unknown or mismatched case ${registeredCaseId}`);
    }
    if (typeof evaluator.probes !== "function" || typeof evaluator.bindingPassed !== "function") {
      throw new Error(`parent evaluator ${registeredCaseId} lacks runner-owned predicates`);
    }
  }
}

export function assertCompleteParentCaseEvaluatorRegistry(registry: ParentCaseEvaluatorRegistry): void {
  validateParentCaseEvaluatorRegistry(registry);
  const missing = canonicalManifest.cases
    .map(({ id }) => id)
    .filter((caseId) => !registry.has(caseId));
  if (missing.length > 0 || registry.size !== canonicalManifest.cases.length) {
    throw new Error(`parent evaluator registry is not a complete 40-case suite; missing: ${missing.join(", ")}`);
  }
}

/**
 * Reusable full-suite seam: validate observation-only binding batches, bind
 * them to a same-case ledger, then evaluate exclusively with parent code.
 */
export function evaluateSupervisedCaseExecutions(input: {
  runId: string;
  caseId: string;
  executions: readonly SupervisedBindingExecution[];
  evaluator: ParentOwnedCaseEvaluator;
}): EvaluatedSupervisedCase {
  const manifestCase = canonicalManifest.cases.find(({ id }) => id === input.caseId);
  if (manifestCase === undefined || input.evaluator.caseId !== input.caseId) {
    throw new Error(`cannot evaluate unknown or mismatched supervised case ${input.caseId}`);
  }
  if (input.executions.length !== manifestCase.bindings.length ||
    new Set(input.executions.map(({ binding }) => binding)).size !== input.executions.length ||
    manifestCase.bindings.some((binding) => !input.executions.some((execution) => execution.binding === binding))) {
    throw new Error(`supervised case ${input.caseId} does not contain the exact canonical binding set`);
  }

  const ledger = new CaseObservationLedger(input.runId, input.caseId);
  for (const execution of input.executions) {
    const batch = { observations: execution.observations };
    assertObservationOnlyBatch(batch, {
      runId: input.runId,
      caseId: input.caseId,
      binding: execution.binding,
    });
    batch.observations.forEach((observation) => ledger.add(observation));
  }
  const observations = ledger.records();
  const assertions = ledger.evaluate(input.evaluator.probes(observations));
  const bindings: BindingResult[] = input.executions.map((execution) => ({
    binding: execution.binding,
    status: execution.error !== undefined
      ? "error"
      : input.evaluator.bindingPassed(execution.binding, execution.observations) ? "passed" : "failed",
    durationMs: execution.durationMs,
  }));
  const status = bindings.every(({ status: bindingStatus }) => bindingStatus === "passed") &&
    assertions.every(({ passed }) => passed === true)
    ? "passed"
    : input.executions.some(({ error }) => error !== undefined) ? "error" : "failed";
  return {
    assertions,
    bindings,
    status,
    failure: status === "passed" ? null : {
      code: input.executions.some(({ error }) => error !== undefined)
        ? "supervised_process_error"
        : "parent_predicate_failed",
      message: input.executions.find(({ error }) => error !== undefined)?.error?.message ??
        "one or more parent-owned predicates failed",
    },
    observations,
  };
}

// O1-T6 currently has one executable supervised slice. This public entry point
// returns exitCode 1 while the other 39 canonical cases remain explicit not_run.
export async function executeConformanceRun(input: ConformanceRunInput): Promise<ConformanceRunResult> {
  return await executeSupervisedC19Run(input);
}
