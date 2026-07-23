import { CaseStackSupervisor } from "./caseStackSupervisor.js";
import { caseProgram } from "./casePrograms.js";
import {
  createHarnessStepDriverWithRawBindingHooks,
  executeParentSteps,
  type ParentStepDriverRequest,
  type ParentStepExecutionEvidence,
  type RawBindingStepHooks,
} from "./parentStepEngine.js";
import { RAW_PRODUCTION_CASES, rawProductionCaseVariables } from "./productionCaseSeedsRaw.js";
import { createEarlyProductionCaseDrivers } from "./productionDriversEarly.js";
import { createExternalEvidenceProductionDrivers } from "./productionDriversExternalEvidence.js";
import { createRawProductionBindingStepHooks } from "./productionDriversRaw.js";
import type { JsonObject } from "./processHarness.js";
import type { RawBindingTlsTrust } from "./rawBindingDrivers.js";
import type { Binding, ExecutionPlan } from "./types.js";

export interface RawProductionBindingExecution {
  binding: Binding;
  evidence: ParentStepExecutionEvidence;
  durationMs: number;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function currentTlsTrust(endpoint: JsonObject): RawBindingTlsTrust | undefined {
  const trust = objectValue(endpoint.tlsTrust, "current raw binding TLS trust");
  if (trust.enabled !== true) return undefined;
  return {
    caCertificatePath: requiredString(
      trust.caCertificatePath,
      "current raw binding CA certificate path",
    ),
    caCertificateSha256: requiredString(
      trust.caCertificateSha256,
      "current raw binding CA certificate digest",
    ),
    serverCertificateSha256: requiredString(
      trust.serverCertificateSha256,
      "current raw binding server certificate digest",
    ),
  };
}

/**
 * Resolves one raw driver immediately before each frame is sent. A restart can
 * replace the Gateway listener and ephemeral certificate, so retaining an
 * endpoint captured during setup would exercise a stale transport.
 */
function currentRawHooks(
  supervisor: CaseStackSupervisor,
  request: Readonly<ParentStepDriverRequest>,
): RawBindingStepHooks {
  const endpoint = supervisor.rawBindingEndpoint();
  if (endpoint.binding !== request.binding) {
    throw new Error(
      `${request.stepId} active stack binding ${String(endpoint.binding)} does not match ${request.binding}`,
    );
  }
  const deviceToken = typeof request.arguments.credential === "string"
    ? request.arguments.credential
    : "test-device-token";
  const trust = currentTlsTrust(endpoint);
  if (request.binding === "wss") {
    if (trust === undefined) {
      throw new Error(`${request.stepId} active WSS stack has no pinned TLS identity`);
    }
    return createRawProductionBindingStepHooks({
      wss: {
        url: requiredString(endpoint.wsUrl, "current raw WSS URL"),
        deviceToken,
        tlsTrust: trust,
        limits: { settleMs: 250 },
      },
    });
  }
  const connectionUrl = requiredString(
    endpoint.httpConnectionUrl,
    "current raw HTTP/SSE connection URL",
  );
  return createRawProductionBindingStepHooks({
    streamableHttpSse: {
      connectionUrl,
      deviceToken,
      ...(trust === undefined ? {} : { tlsTrust: trust }),
      limits: { settleMs: 250 },
    },
  });
}

function dynamicRawHooks(supervisor: CaseStackSupervisor): RawBindingStepHooks {
  return {
    wss: async (request) => {
      const hook = currentRawHooks(supervisor, request).wss;
      if (hook === undefined) throw new Error(`${request.stepId} did not resolve a WSS hook`);
      return await hook(request);
    },
    streamable_http_sse: async (request) => {
      const hook = currentRawHooks(supervisor, request).streamable_http_sse;
      if (hook === undefined) {
        throw new Error(`${request.stepId} did not resolve a Streamable HTTP/SSE hook`);
      }
      return await hook(request);
    },
  };
}

export async function executeRawProductionCaseBinding(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  binding: Binding;
  clockIso?: string;
}): Promise<RawProductionBindingExecution> {
  if (!(RAW_PRODUCTION_CASES as readonly string[]).includes(input.caseId)) {
    throw new Error(`raw production runner does not support ${input.caseId}`);
  }
  const program = caseProgram(input.caseId);
  if (!program.bindings.includes(input.binding)) {
    throw new Error(`${input.caseId} does not support binding ${input.binding}`);
  }
  const supervisor = new CaseStackSupervisor({
    plan: input.plan,
    repoRoot: input.repoRoot,
  });
  const base = createExternalEvidenceProductionDrivers(
    supervisor,
    createEarlyProductionCaseDrivers(supervisor),
  );
  const drivers = {
    ...base,
    parent_harness: createHarnessStepDriverWithRawBindingHooks(
      base.parent_harness,
      dynamicRawHooks(supervisor),
    ),
  };
  const startedAt = Date.now();
  try {
    const evidence = await executeParentSteps({
      runId: input.plan.runId,
      caseId: input.caseId,
      binding: input.binding,
      steps: program.steps,
      drivers,
      variables: rawProductionCaseVariables(input.caseId as (typeof RAW_PRODUCTION_CASES)[number], {
        binding: input.binding,
      }),
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

export async function executeRawProductionCaseBothBindings(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  clockIso?: string;
}): Promise<RawProductionBindingExecution[]> {
  const executions: RawProductionBindingExecution[] = [];
  for (const binding of ["wss", "streamable_http_sse"] as const) {
    executions.push(await executeRawProductionCaseBinding({ ...input, binding }));
  }
  return executions;
}
