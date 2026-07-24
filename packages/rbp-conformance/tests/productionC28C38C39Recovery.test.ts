import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { CanonicalAssertionOracleContext } from "../src/canonicalEvaluators.js";
import { canonicalManifest } from "../src/manifest.js";
import { RAW_PRODUCTION_ORACLES } from "../src/productionCaseOraclesRaw.js";
import { executeRawProductionCaseBothBindings } from "../src/productionCaseRunnerRaw.js";
import type {
  ExecutionPlan,
  ManifestAssertion,
  ProcessObservationRecord,
} from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const caseIds = ["O1-C28", "O1-C38", "O1-C39"] as const;

function productionPlan(caseId: (typeof caseIds)[number]): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    `production-${caseId.toLowerCase()}-recovery`,
  );
}

function oracleContext(
  caseId: (typeof caseIds)[number],
  execution: {
    readonly binding: "wss" | "streamable_http_sse";
    readonly evidence: { readonly observations: readonly ProcessObservationRecord[] };
  },
  assertion: ManifestAssertion,
): CanonicalAssertionOracleContext {
  return {
    caseId,
    binding: execution.binding,
    assertion: structuredClone(assertion),
    observations: execution.evidence.observations
      .filter(({ binding }) => binding === execution.binding)
      .map((observation) => structuredClone(observation)),
  };
}

function payload(record: ProcessObservationRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stepPayload(
  records: readonly ProcessObservationRecord[],
  kind: ProcessObservationRecord["kind"],
  stepId: string,
): Record<string, unknown> | null {
  const matches = records
    .filter((record) => record.kind === kind)
    .map(payload)
    .filter((candidate) => candidate.stepId === stepId);
  return matches.length === 1 ? matches[0]! : null;
}

function pathValue(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    const object = objectValue(current);
    if (object === null) return undefined;
    current = object[segment];
  }
  return current;
}

function c28FailureFacts(records: readonly ProcessObservationRecord[]): Record<string, unknown> {
  const control = (stepId: string) =>
    stepPayload(records, "control_result", stepId);
  const snapshot = (
    kind: Extract<ProcessObservationRecord["kind"], "gateway_snapshot" | "bridge_snapshot">,
    stepId: string,
  ) => stepPayload(records, kind, stepId);
  const origin = pathValue(control("o1-c28.dispatch-origin"), [
    "request", "arguments", "request", "payload", "invocation_id",
  ]);
  const recovery = pathValue(control("o1-c28.dispatch-recovery"), [
    "request", "arguments", "request", "payload", "invocation_id",
  ]);
  const hold = pathValue(control("o1-c28.capture-hold"), [
    "response", "result", "observed",
  ]);
  const rsid = pathValue(control("o1-c28.dispatch-origin"), [
    "request", "arguments", "request", "rsid",
  ]);
  const late = snapshot("gateway_snapshot", "o1-c28.capture-late-digest");
  const finalGateway = snapshot("gateway_snapshot", "o1-c28.gateway-snapshot");
  const finalBridge = snapshot("bridge_snapshot", "o1-c28.bridge-snapshot");
  const fixture = stepPayload(records, "fixture_execution_count", "o1-c28.fixture-snapshot");
  return {
    rsid,
    origin,
    recovery,
    hold,
    holdAtCapture: pathValue(snapshot("gateway_snapshot", "o1-c28.capture-hold"), [
      "mutationHolds", "holds", 0,
    ]),
    lateDigest: pathValue(control("o1-c28.capture-late-digest"), [
      "response", "result", "observed",
    ]),
    lateEvidence: pathValue(late, [
      "sessions", String(rsid), "lateTerminalEvidence", String(origin),
    ]),
    originTerminal: pathValue(late, [
      "sessions", String(rsid), "terminalOutcomes", String(origin),
    ]),
    gatewayLateHold: pathValue(control("o1-c28.late-terminal"), [
      "response", "result",
    ]),
    bridgeLateHold: pathValue(control("o1-c28.bridge-late-terminal"), [
      "response", "result", "hold",
    ]),
    recoveryDispatch: pathValue(control("o1-c28.dispatch-recovery"), [
      "request", "arguments", "request", "payload",
    ]),
    recoveryDispatchIdentity: pathValue(
      control("o1-c28.capture-recovery-dispatch-identity"),
      ["response", "result", "observed"],
    ),
    bridgeResolutionRequest: pathValue(control("o1-c28.resolve-bridge-hold"), [
      "request", "arguments",
    ]),
    bridgeResolutionResult: pathValue(control("o1-c28.resolve-bridge-hold"), [
      "response", "result",
    ]),
    bridgeClearance: pathValue(control("o1-c28.capture-bridge-clearance"), [
      "response", "result", "clearance",
    ]),
    finalGatewayHold: pathValue(finalGateway, ["mutationHolds", "holds", 0]),
    finalBridgeHold: pathValue(finalBridge, ["holds", 0]),
    recoveryTerminal: pathValue(finalGateway, [
      "sessions", String(rsid), "terminalOutcomes", String(recovery),
    ]),
    executionCounts: fixture?.executionCounts ?? null,
  };
}

describe.sequential("C28/C38/C39 production recovery regressions", () => {
  it.each(caseIds)(
    "%s passes every frozen assertion on both real Gateway bindings",
    async (caseId) => {
      const executions = await executeRawProductionCaseBothBindings({
        plan: productionPlan(caseId),
        repoRoot,
        caseId,
      });

      for (const execution of executions) {
        const results = canonicalManifest.requiredAssertions[caseId]!.map((assertion) => ({
          assertionId: assertion.id,
          passed: RAW_PRODUCTION_ORACLES.get(assertion.id)?.(
            oracleContext(caseId, execution, assertion),
          ) === true,
        }));
        const controls = execution.evidence.observations
          .filter(({ kind }) => kind === "control_result")
          .map((record) => ({
            stepId: payload(record).stepId,
            response: payload(record).response,
          }));
        expect(
          results.every(({ passed }) => passed),
          JSON.stringify({
            caseId,
            binding: execution.binding,
            results,
            controls,
            ...(caseId === "O1-C28"
              ? { exactFailureFacts: c28FailureFacts(execution.evidence.observations) }
              : {}),
          }),
        ).toBe(true);

        const stopped = execution.evidence.observations
          .filter(({ kind }) => kind === "process_lifecycle")
          .filter((record) => payload(record).phase === "stopped");
        expect(stopped).toHaveLength(3);
        expect(new Set(stopped.map((record) =>
          Number((payload(record).process as Record<string, unknown>).pid))).size)
          .toBe(3);
        expect(stopped.every((record) =>
          payload(record).orphanProcessCount === 0 &&
          payload(record).killEscalated === false)).toBe(true);
        expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
          /"(?:actual|passed|verdict)"\s*:/u,
        );
      }
    },
    300_000,
  );
});
