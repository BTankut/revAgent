import { CaseStackSupervisor } from "./caseStackSupervisor.js";
import { earlyProductionCaseProgram } from "./productionCaseProgramsEarly.js";
import {
  assertEarlyProductionCaseVariablesComplete,
  EARLY_PRODUCTION_CASES,
  earlyProductionCaseVariables,
} from "./productionCaseSeedsEarly.js";
import { createEarlyProductionCaseDrivers } from "./productionDriversEarly.js";
import {
  executeParentSteps,
  type ParentStepExecutionEvidence,
} from "./parentStepEngine.js";
import type { Binding, ExecutionPlan } from "./types.js";

export interface EarlyProductionBindingExecution {
  binding: Binding;
  evidence: ParentStepExecutionEvidence;
  durationMs: number;
}

export async function executeEarlyProductionCaseBinding(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  binding: Binding;
  clockIso?: string;
}): Promise<EarlyProductionBindingExecution> {
  if (!(EARLY_PRODUCTION_CASES as readonly string[]).includes(input.caseId)) {
    throw new Error(`early production runner does not support ${input.caseId}`);
  }
  const program = earlyProductionCaseProgram(input.caseId);
  if (!program.bindings.includes(input.binding)) {
    throw new Error(`${input.caseId} does not support binding ${input.binding}`);
  }
  const variables = earlyProductionCaseVariables(
    input.caseId,
    input.binding,
    input.clockIso,
  );
  assertEarlyProductionCaseVariablesComplete(program, variables);
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
      drivers: createEarlyProductionCaseDrivers(supervisor),
      variables,
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

export async function executeEarlyProductionCaseBothBindings(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  clockIso?: string;
}): Promise<EarlyProductionBindingExecution[]> {
  const executions: EarlyProductionBindingExecution[] = [];
  for (const binding of ["wss", "streamable_http_sse"] as const) {
    executions.push(await executeEarlyProductionCaseBinding({ ...input, binding }));
  }
  return executions;
}
