import type { CaseStackSupervisor, ProductArtifactScenario } from "./caseStackSupervisor.js";
import { createProductionCaseDrivers } from "./productionDrivers.js";
import type {
  ParentStepDriverRequest,
  ParentStepDrivers,
  RawStepOutcome,
} from "./parentStepEngine.js";
import type { JsonObject, JsonValue } from "./processHarness.js";
import type { ComponentId, ProcessObservationRecord } from "./types.js";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function observation(
  request: ParentStepDriverRequest,
  componentId: ComponentId,
  kind: ProcessObservationRecord["kind"],
  suffix: string,
  payload: JsonObject,
): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId:
      `${request.runId}:${request.caseId}:${request.binding}:${request.stepId}:${componentId}:${suffix}`,
    runId: request.runId,
    caseId: request.caseId,
    binding: request.binding,
    componentId,
    kind,
    at: new Date().toISOString(),
    payload,
  };
}

function discoverySummary(value: JsonObject): JsonObject {
  const evidence = value.evidence;
  if (!Array.isArray(value.sessions) || !isObject(evidence)) {
    throw new Error("C33 Bridge discovery result is malformed");
  }
  const arrays = (field: string): JsonValue[] => {
    const candidate = evidence[field];
    if (!Array.isArray(candidate)) {
      throw new Error(`C33 Bridge discovery evidence lacks ${field}`);
    }
    return structuredClone(candidate);
  };
  return {
    source: evidence.source ?? null,
    sessionCount: value.sessions.length,
    probedTargets: arrays("probedTargets"),
    acceptedTargets: arrays("acceptedTargets"),
    rejectedTargets: arrays("rejectedTargets"),
    tempRegistryReads: evidence.tempRegistryReads ?? null,
    filesystemLocksCreated: evidence.filesystemLocksCreated ?? null,
  };
}

function withObservation(
  outcome: RawStepOutcome,
  record: ProcessObservationRecord,
): RawStepOutcome {
  if (outcome.kind !== "success") {
    throw new Error("external evidence decorator requires a successful control operation");
  }
  return {
    ...outcome,
    observations: [...(outcome.observations ?? []), record],
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function requiredPort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`${label} must be a valid TCP port`);
  }
  return Number(value);
}

/**
 * Decorates the normal supervised drivers with the two parent-owned evidence
 * seams that cannot be delegated to a child process: C33 loopback policy and
 * C40 managed artifact filesystem inspection.
 */
export function createExternalEvidenceProductionDrivers(
  supervisor: CaseStackSupervisor,
  base: ParentStepDrivers = createProductionCaseDrivers(supervisor),
): ParentStepDrivers {
  return {
    ...base,
    bridge_jsonl_control: async (request) => {
      const outcome = await base.bridge_jsonl_control(request);
      if (
        request.caseId !== "O1-C33" ||
        request.action !== "discover_fixture" ||
        !["o1-c33.loopback", "o1-c33.lan", "o1-c33.hostname"].includes(request.stepId)
      ) {
        return outcome;
      }
      if (outcome.kind !== "success" || !isObject(outcome.result)) {
        throw new Error(`${request.stepId} did not return Bridge discovery evidence`);
      }
      const host = requiredString(request.arguments.host, `${request.stepId}.host`);
      const port = requiredPort(request.arguments.port, `${request.stepId}.port`);
      let payload: JsonObject;
      if (request.stepId === "o1-c33.hostname") {
        const resolvedAddress = "192.0.2.10";
        const resolved = await supervisor.jsonlControl(
          "bridge_simulator",
          "discover_fixture",
          {
            host: resolvedAddress,
            port,
            probeTimeoutMs: 100,
          },
          Math.max(1, request.deadlineAtMs - Date.now()),
        );
        if (!isObject(resolved)) {
          throw new Error("C33 controlled resolved-address discovery result is malformed");
        }
        payload = {
          schemaVersion: "supervisor.loopback-probe/v1",
          stepId: request.stepId,
          action: request.action,
          probeKind: "hostname_resolved_remote",
          targetClass: "hostname",
          requestedHostname: host,
          controlledResolution: {
            source: "parent_static_test_net",
            addresses: [resolvedAddress],
          },
          hostnameAttempt: discoverySummary(outcome.result),
          resolvedAddressAttempt: discoverySummary(resolved),
        };
      } else {
        payload = {
          schemaVersion: "supervisor.loopback-probe/v1",
          stepId: request.stepId,
          action: request.action,
          probeKind: "product_discovery",
          targetClass: request.stepId === "o1-c33.loopback"
            ? "numeric_loopback"
            : "non_loopback_lan",
          requestedTarget: { host, port },
          attempt: discoverySummary(outcome.result),
        };
      }
      return withObservation(
        outcome,
        observation(request, "bridge_simulator", "wire_event", "loopback-policy", payload),
      );
    },
    parent_harness: async (request) => {
      if (request.caseId === "O1-C33" && request.action === "spawn_fixture_bind_probe") {
        const host = requiredString(request.arguments.host, `${request.stepId}.host`);
        if (host !== "0.0.0.0" && host !== "127.0.0.1") {
          throw new Error("C33 fixture bind probe host is outside the canonical vector set");
        }
        if (request.arguments.expected !== "reject") {
          throw new Error("C33 fixture bind probe must retain expected=reject");
        }
        const evidence = await supervisor.probeFixtureBindPolicy({
          host,
          allowUnsafeBind: request.arguments.allowUnsafeBind === true,
        });
        const result: JsonObject = {
          evidenceRecorded: true,
          probeKind: "fixture_bind_process",
        };
        return {
          kind: "success",
          result,
          observations: [
            observation(
              request,
              "addin_loopback_fixture",
              "wire_event",
              "fixture-bind-policy",
              {
                ...evidence,
                stepId: request.stepId,
                action: request.action,
              },
            ),
          ],
        };
      }
      if (
        request.caseId === "O1-C40" &&
        request.action === "execute_product_artifact_scenario"
      ) {
        const scenario = requiredString(
          request.arguments.scenario,
          `${request.stepId}.scenario`,
        ) as ProductArtifactScenario;
        const envelope = request.arguments.envelope;
        if (!isObject(envelope)) {
          throw new Error(`${request.stepId}.envelope must be an object`);
        }
        const evidence = await supervisor.executeProductArtifactScenario({
          scenario,
          envelope,
          stepId: request.stepId,
        });
        const result: JsonObject = {
          evidenceRecorded: true,
          scenario,
        };
        return {
          kind: "success",
          result,
          observations: [
            observation(
              request,
              "bridge_simulator",
              "bridge_snapshot",
              "product-artifact",
              evidence,
            ),
          ],
        };
      }
      return await base.parent_harness(request);
    },
  };
}
