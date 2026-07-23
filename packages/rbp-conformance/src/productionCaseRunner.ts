import { CaseStackSupervisor } from "./caseStackSupervisor.js";
import { caseProgram } from "./casePrograms.js";
import { executeParentSteps } from "./parentStepEngine.js";
import { createProductionCaseDrivers } from "./productionDrivers.js";
import {
  productionCaseVariables,
  SUPPORTED_PRODUCTION_CASES,
} from "./productionCaseSeeds.js";
import type {
  ParentStepExecutionEvidence,
} from "./parentStepEngine.js";
import type {
  Binding,
  ExecutionPlan,
} from "./types.js";

export interface ProductionBindingExecution {
  binding: Binding;
  evidence: ParentStepExecutionEvidence;
  durationMs: number;
}

export async function executeProductionCaseBinding(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  binding: Binding;
  clockIso?: string;
}): Promise<ProductionBindingExecution> {
  if (!(SUPPORTED_PRODUCTION_CASES as readonly string[]).includes(input.caseId)) {
    throw new Error(`production case runner does not support ${input.caseId}`);
  }
  const program = caseProgram(input.caseId);
  if (!program.bindings.includes(input.binding)) {
    throw new Error(`${input.caseId} does not support binding ${input.binding}`);
  }
  const supervisor = new CaseStackSupervisor({
    plan: input.plan,
    repoRoot: input.repoRoot,
  });
  const startedAt = Date.now();
  try {
    const evidence = await executeParentSteps({
      runId: input.plan.runId,
      caseId: input.caseId,
      binding: input.binding,
      steps: program.steps,
      drivers: createProductionCaseDrivers(supervisor),
      variables: productionCaseVariables(input.caseId, input.binding, input.clockIso),
    });
    if (supervisor.active) {
      throw new Error(`${input.caseId}/${input.binding} completed without stop_case_stack`);
    }
    return {
      binding: input.binding,
      evidence,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (supervisor.active) {
      try {
        await supervisor.stopCaseStack(
          `${input.caseId.toLowerCase()}.abort-stop`,
          "abort_and_drain",
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${input.caseId}/${input.binding} failed and supervised cleanup also failed`,
        );
      }
    }
    throw error;
  }
}

export async function executeProductionCaseBothBindings(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  clockIso?: string;
}): Promise<ProductionBindingExecution[]> {
  const executions: ProductionBindingExecution[] = [];
  for (const binding of ["wss", "streamable_http_sse"] as const) {
    executions.push(await executeProductionCaseBinding({ ...input, binding }));
  }
  return executions;
}
