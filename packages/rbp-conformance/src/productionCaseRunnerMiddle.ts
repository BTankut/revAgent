import { CaseStackSupervisor } from "./caseStackSupervisor.js";
import { caseProgram } from "./casePrograms.js";
import { executeParentSteps } from "./parentStepEngine.js";
import { createMiddleProductionCaseDrivers } from "./productionDriversMiddle.js";
import {
  middleProductionCaseVariables,
  MIDDLE_PRODUCTION_CASES,
} from "./productionCaseSeedsMiddle.js";
import type { ParentStepExecutionEvidence } from "./parentStepEngine.js";
import type { Binding, ExecutionPlan } from "./types.js";

export interface MiddleProductionBindingExecution {
  binding: Binding;
  evidence: ParentStepExecutionEvidence;
  durationMs: number;
}

const SUPPORTED = new Set<string>(MIDDLE_PRODUCTION_CASES);

export async function executeMiddleProductionCaseBinding(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  binding: Binding;
  clockIso?: string;
}): Promise<MiddleProductionBindingExecution> {
  if (!SUPPORTED.has(input.caseId)) {
    throw new Error(`middle production case runner does not support ${input.caseId}`);
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
      drivers: createMiddleProductionCaseDrivers(supervisor),
      variables: middleProductionCaseVariables(
        input.caseId,
        input.binding,
        input.clockIso,
      ),
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

export async function executeMiddleProductionCaseBothBindings(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  clockIso?: string;
}): Promise<MiddleProductionBindingExecution[]> {
  const executions: MiddleProductionBindingExecution[] = [];
  for (const binding of ["wss", "streamable_http_sse"] as const) {
    executions.push(await executeMiddleProductionCaseBinding({ ...input, binding }));
  }
  return executions;
}
