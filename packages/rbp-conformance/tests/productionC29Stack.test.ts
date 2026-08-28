import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
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
import {
  createCurrentProductionPlan,
  withProductionRuntimeLaunchEpoch,
} from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const caseId = "O1-C29";
const teardownEvidenceRoot = process.env.REVAGENT_RBP_C29_TEARDOWN_EVIDENCE_ROOT;

function retainedTeardownEvidence(root: string): Record<string, unknown>[] {
  const files = readdirSync(root, { recursive: true })
    .filter((entry) => typeof entry === "string" && entry.endsWith(".json"))
    .map((entry) => path.join(root, entry));
  return files.map((file) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
}

function productionPlan(): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    "production-o1-c29-redelivery",
  );
}

function oracleContext(
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

describe.sequential("C29 production batch redelivery and crash recovery", () => {
  it("fails all six frozen semantic oracles closed without production evidence", () => {
    expect(canonicalManifest.requiredAssertions[caseId]).toHaveLength(6);
    for (const assertion of canonicalManifest.requiredAssertions[caseId]!) {
      const oracle = RAW_PRODUCTION_ORACLES.get(assertion.id);
      expect(oracle, assertion.id).toBeTypeOf("function");
      for (const binding of ["wss", "streamable_http_sse"] as const) {
        expect(oracle?.({
          caseId,
          binding,
          assertion,
          observations: [],
        }), `${assertion.id}/${binding} accepted empty evidence`).toBe(false);
      }
    }
  });

  it(
    "proves exact mixed redelivery, atomic replay, and indeterminate recovery on both bindings",
    async () => {
      const plan = productionPlan();
      const executions = await withProductionRuntimeLaunchEpoch(
        plan,
        repoRoot,
        () => executeRawProductionCaseBothBindings({
          plan,
          repoRoot,
          caseId,
          ...(teardownEvidenceRoot === undefined
            ? {}
            : { teardownEvidenceRoot }),
        }),
      );

      for (const execution of executions) {
        const results = canonicalManifest.requiredAssertions[caseId]!.map((assertion) => ({
          assertionId: assertion.id,
          passed: RAW_PRODUCTION_ORACLES.get(assertion.id)?.(
            oracleContext(execution, assertion),
          ) === true,
        }));
        const snapshots = execution.evidence.observations
          .filter(({ kind }) =>
            kind === "bridge_snapshot" ||
            kind === "gateway_snapshot" ||
            kind === "fixture_execution_count")
          .map((record) => ({
            kind: record.kind,
            stepId: payload(record).stepId,
            crash: payload(record).crash,
            invocations: payload(record).invocations,
            holds: payload(record).holds,
            sessions: payload(record).sessions,
            mutationHolds: payload(record).mutationHolds,
            executionCounts: payload(record).executionCounts,
          }));
        const controls = execution.evidence.observations
          .filter(({ kind }) => kind === "control_result")
          .filter((record) => /^o1-c29\.(?:mixed-(?:initial|redelivery)|atomic-(?:terminal|replay|indeterminate-initial|indeterminate-redelivery))$/u
            .test(String(payload(record).stepId)))
          .map((record) => {
            const root = payload(record);
            const response = root.response as Record<string, unknown>;
            const result = response.result as Record<string, unknown>;
            const batch = result.payload as Record<string, unknown>;
            return {
              stepId: root.stepId,
              responseKind: response.kind,
              type: result.type,
              seq: result.seq,
              ack: result.ack,
              batchId: batch.batch_id,
            };
          });
        expect(
          results.every(({ passed }) => passed),
          JSON.stringify({ binding: execution.binding, results, controls, snapshots }),
        ).toBe(true);

        const stopped = execution.evidence.observations
          .filter(({ kind }) => kind === "process_lifecycle")
          .filter((record) => payload(record).phase === "stopped");
        const stoppedAt = (stepId: string) => stopped.filter((record) =>
          payload(record).processRole === "canonical_component" &&
          payload(record).stepId === stepId);
        expect(stoppedAt(`${caseId.toLowerCase()}.resource-baseline-stop`))
          .toHaveLength(3);
        const terminalStopped = stoppedAt(`${caseId.toLowerCase()}.stack-stop`);
        expect(terminalStopped).toHaveLength(3);
        expect(new Set(terminalStopped.map((record) =>
          Number((payload(record).process as Record<string, unknown>).pid))).size)
          .toBe(3);
        expect(stopped.every((record) =>
          payload(record).orphanProcessCount === 0 &&
          payload(record).killEscalated === false)).toBe(true);
        expect(JSON.stringify(execution.evidence.observations)).not.toMatch(
          /"(?:actual|passed|verdict)"\s*:/u,
        );
      }

      if (teardownEvidenceRoot !== undefined) {
        const retained = retainedTeardownEvidence(teardownEvidenceRoot);
        expect(retained).toHaveLength(4);
        for (const document of retained) {
          expect(document).toMatchObject({
            schemaVersion: "rbp-c29-teardown-evidence/v1",
            caseId,
            orphanProcessCount: 0,
            survivors: [],
            proxyDrain: {
              gatewayProxyStopped: true,
              fixtureProxyStopped: true,
            },
          });
          const components = document.components as Array<Record<string, unknown>>;
          expect(components).toHaveLength(3);
          const gateway = components.find(({ componentId }) => componentId === "gateway_stub");
          expect(gateway).toMatchObject({
            stop: {
              observed: true,
              killEscalated: false,
              telemetry: {
                correlationKind: "ipc_stop_nonce",
                acknowledgement: "closed",
              },
            },
          });
          const telemetry = (gateway?.stop as Record<string, unknown>).telemetry as Record<string, unknown>;
          expect(telemetry.correlationId).toEqual(expect.any(String));
          expect(telemetry.acknowledgedAt).toEqual(expect.any(String));
          expect(JSON.stringify(document)).not.toMatch(/(?:[A-Za-z]:\\|"token"\s*:|"proof"\s*:)/u);
        }
      }
    },
    180_000,
  );
});
