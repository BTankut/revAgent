import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { MIDDLE_PRODUCTION_ORACLES } from "../src/productionCaseOraclesMiddle.js";
import {
  executeMiddleProductionCaseBothBindings,
} from "../src/productionCaseRunnerMiddle.js";
import {
  MIDDLE_PRODUCTION_CASES,
} from "../src/productionCaseSeedsMiddle.js";
import { evaluateSupervisedCaseExecutions } from "../src/suiteRunner.js";
import type { CanonicalAssertionOracleContext } from "../src/canonicalEvaluators.js";
import type {
  Binding,
  ExecutionPlan,
  ManifestAssertion,
  ProcessObservationRecord,
} from "../src/types.js";
import type { ParentOwnedCaseEvaluator } from "../src/suiteRunner.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(caseId: string): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    `production-middle-${caseId.toLowerCase()}`,
  );
}

function oracleContext(
  caseId: string,
  binding: Binding,
  assertion: ManifestAssertion,
  observations: readonly ProcessObservationRecord[],
): CanonicalAssertionOracleContext {
  return {
    caseId,
    binding,
    assertion: structuredClone(assertion),
    observations: observations
      .filter((record) => record.binding === binding)
      .map((record) => structuredClone(record)),
  };
}

function middleEvaluator(caseId: string): ParentOwnedCaseEvaluator {
  const manifestCase = canonicalManifest.cases.find(({ id }) => id === caseId);
  if (manifestCase === undefined) throw new Error(`unknown case ${caseId}`);
  const assertions = canonicalManifest.requiredAssertions[caseId]!;
  const bindingPassed = (
    binding: Binding,
    observations: readonly ProcessObservationRecord[],
  ): boolean =>
    manifestCase.bindings.includes(binding) &&
    assertions.every((assertion) =>
      MIDDLE_PRODUCTION_ORACLES.get(assertion.id)?.(
        oracleContext(caseId, binding, assertion, observations),
      ) === true);
  return {
    caseId,
    probes(observations) {
      const observationIds = observations.map(({ observationId }) => observationId);
      return assertions.map((assertion) => ({
        assertionId: assertion.id,
        observationIds,
        evaluate: (selected: readonly ProcessObservationRecord[]) =>
          manifestCase.bindings.every((binding) =>
            MIDDLE_PRODUCTION_ORACLES.get(assertion.id)?.(
              oracleContext(caseId, binding, assertion, selected),
            ) === true),
        message: "middle production semantic oracle failed",
      }));
    },
    bindingPassed,
  };
}

function recordPayload(record: ProcessObservationRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

describe("middle production oracle registry", () => {
  it("exactly covers C15 through C24 and fails closed without observations", () => {
    const expected = MIDDLE_PRODUCTION_CASES.flatMap((caseId) =>
      canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => id));
    expect([...MIDDLE_PRODUCTION_ORACLES.keys()]).toEqual(expected);

    for (const caseId of MIDDLE_PRODUCTION_CASES) {
      for (const assertion of canonicalManifest.requiredAssertions[caseId]!) {
        const oracle = MIDDLE_PRODUCTION_ORACLES.get(assertion.id);
        expect(oracle, assertion.id).toBeTypeOf("function");
        for (const binding of ["wss", "streamable_http_sse"] as const) {
          expect(
            oracle?.(oracleContext(caseId, binding, assertion, [])),
            `${assertion.id}/${binding} accepted empty evidence`,
          ).toBe(false);
        }
      }
    }
  });
});

describe.sequential("middle production three-process case stack", () => {
  it.each(MIDDLE_PRODUCTION_CASES)(
    "runs %s through both real Gateway bindings with semantic oracles",
    async (caseId) => {
      const plan = productionPlan(caseId);
      const executions = await executeMiddleProductionCaseBothBindings({
        plan,
        repoRoot,
        caseId,
      });
      const evaluated = evaluateSupervisedCaseExecutions({
        runId: plan.runId,
        caseId,
        executions: executions.map(({ binding, evidence, durationMs }) => ({
          binding,
          observations: evidence.observations,
          durationMs,
        })),
        evaluator: middleEvaluator(caseId),
      });

      expect(evaluated.status, JSON.stringify({
        bindings: evaluated.bindings,
        assertions: evaluated.assertions.map(({ assertionId, passed, actual, message }) => ({
          assertionId,
          passed,
          actual,
          message,
        })),
        wireDiagnostics: executions.flatMap(({ binding, evidence }) =>
          evidence.observations
            .filter(({ kind }) => kind === "wire_event")
            .map((record) => recordPayload(record))
            .filter((payload) => typeof payload.stepId === "string")
            .map((payload) => ({
              binding,
              stepId: payload.stepId,
              frame: payload.frame,
              serialized: payload.serialized,
              remoteOutcome: payload.remoteOutcome,
            }))),
        semanticDiagnostics: executions.flatMap(({ binding, evidence }) =>
          evidence.observations
            .filter(({ kind }) =>
              kind === "control_result" ||
              kind === "gateway_snapshot" ||
              kind === "fixture_snapshot")
            .map((record) => ({
              binding,
              kind: record.kind,
              stepId: recordPayload(record).stepId,
              response: recordPayload(record).response,
              sessions: recordPayload(record).sessions,
              documentContextEvidence: recordPayload(record).documentContextEvidence,
            }))
            .filter(({ stepId }) =>
              typeof stepId === "string" &&
              (stepId.includes("context") ||
                stepId.includes("poll") ||
                stepId.endsWith("fixture-snapshot")))),
      })).toBe("passed");
      expect(evaluated.bindings.map(({ status }) => status)).toEqual(["passed", "passed"]);
      expect(evaluated.assertions.every(({ passed, actual }) =>
        passed === true && actual === true)).toBe(true);

      for (const execution of executions) {
        if (caseId === "O1-C15") {
          const proof = execution.evidence.observations.find((record) =>
            record.componentId === "gateway_stub" &&
            record.kind === "gateway_snapshot" &&
            recordPayload(record).stepId === "o1-c15.parent-artifact-bytes");
          expect(proof).toBeDefined();
          const serialized = JSON.stringify(proof!.payload);
          expect(serialized).not.toContain("bytesBase64");
          expect(serialized).not.toContain("\\state\\gateway.json");
          expect(serialized).not.toContain("/state/gateway.json");
          expect(recordPayload(proof!)).toMatchObject({
            schemaVersion: "supervisor.gateway-artifact-byte-evidence/v1",
            source: "parent_runner_direct_durable_state_read",
            statePathRedacted: true,
            artifactCount: 2,
            totalDecodedBytes: 8_388_608,
          });

          const assertion = canonicalManifest.requiredAssertions["O1-C15"]!
            .find(({ id }) => id === "O1-C15-DIGEST-VERIFIED")!;
          const tampered = structuredClone(execution.evidence.observations);
          const tamperedProof = tampered.find(({ observationId }) =>
            observationId === proof!.observationId)!;
          const rows = recordPayload(tamperedProof).artifacts as Array<Record<string, unknown>>;
          rows[0]!.parentSha256 = `sha256:${"0".repeat(64)}`;
          expect(MIDDLE_PRODUCTION_ORACLES.get(assertion.id)?.(
            oracleContext(caseId, execution.binding, assertion, tampered),
          )).toBe(false);
        }

        const captures = execution.evidence.captures;
        if (execution.binding === "wss") {
          expect(String(captures["gateway.ready.ws_url"])).toMatch(/^wss:\/\/127\.0\.0\.1:/u);
          expect(captures["gateway.ready.ca_certificate_sha256"]).toMatch(
            /^sha256:[0-9a-f]{64}$/u,
          );
          expect(captures["gateway.ready.server_certificate_sha256"]).toMatch(
            /^sha256:[0-9a-f]{64}$/u,
          );
          const caPath = String(captures["gateway.ready.ca_certificate_path"]);
          expect(path.isAbsolute(caPath)).toBe(true);
          expect(existsSync(caPath)).toBe(false);
        } else {
          expect(String(captures["gateway.ready.http_connection_url"])).toMatch(
            /^http:\/\/127\.0\.0\.1:/u,
          );
          expect(captures["gateway.ready.ca_certificate_path"]).toBeNull();
        }

        const stopped = execution.evidence.observations
          .filter(({ kind }) => kind === "process_lifecycle")
          .filter((record) => recordPayload(record).phase === "stopped");
        expect(stopped).toHaveLength(3);
        expect(new Set(stopped.map((record) =>
          Number((recordPayload(record).process as Record<string, unknown>).pid))).size)
          .toBe(3);
        expect(stopped.every((record) =>
          recordPayload(record).orphanProcessCount === 0 &&
          recordPayload(record).killEscalated === false)).toBe(true);
      }
    },
    240_000,
  );
});
