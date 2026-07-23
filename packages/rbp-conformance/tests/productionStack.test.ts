import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  canonicalManifest,
  evaluateSupervisedCaseExecutions,
  executeProductionCaseBothBindings,
  productionComponentLaunchConfigs,
  sha256File,
} from "../src/index.js";
import type {
  Binding,
  ExecutionPlan,
  ParentOwnedCaseEvaluator,
  ProcessObservationRecord,
} from "../src/index.js";
import { createPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(caseId: string): ExecutionPlan {
  const plan = createPlan();
  plan.runId = `production-${caseId.toLowerCase()}`;
  const launchConfigs = productionComponentLaunchConfigs(repoRoot);
  for (const component of plan.components) {
    const selected = launchConfigs.find(({ id }) => id === component.id);
    if (selected === undefined) throw new Error(`missing production launch config for ${component.id}`);
    component.expectedIdentity.executableSha256 = sha256File(
      path.join(repoRoot, selected.entrypointPath),
    );
    component.command = structuredClone(selected.command);
  }
  return plan;
}

function payload(record: ProcessObservationRecord): Record<string, unknown> {
  return record.payload as Record<string, unknown>;
}

function control(
  records: readonly ProcessObservationRecord[],
  stepId: string,
): Record<string, unknown> | undefined {
  return records
    .filter(({ kind }) => kind === "control_result")
    .map(payload)
    .find((entry) => entry.stepId === stepId);
}

function snapshots(
  records: readonly ProcessObservationRecord[],
  kind: ProcessObservationRecord["kind"],
): Array<Record<string, unknown>> {
  return records.filter((record) => record.kind === kind).map(payload);
}

function hasBidirectionalWire(records: readonly ProcessObservationRecord[]): boolean {
  const wire = records.filter(({ kind }) => kind === "wire_event");
  return ["gateway_stub", "bridge_simulator"].every((componentId) =>
    wire.some((record) => {
      if (record.componentId !== componentId) return false;
      const frame = payload(record).frame as Record<string, unknown>;
      if (frame.kind === "parent_tcp_capture_composite") {
        const gateway = frame.gateway as Record<string, unknown>;
        return Number(gateway.bytes) > 0;
      }
      return Number(frame.bytes) > 0;
    }));
}

function allBindings(
  records: readonly ProcessObservationRecord[],
  predicate: (binding: Binding, rows: readonly ProcessObservationRecord[]) => boolean,
): boolean {
  return (["wss", "streamable_http_sse"] as const).every((binding) =>
    predicate(binding, records.filter((record) => record.binding === binding)));
}

function evaluator(caseId: "O1-C01" | "O1-C05"): ParentOwnedCaseEvaluator {
  const assertionIds = canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => id);
  const bindingPredicate = (binding: Binding, rows: readonly ProcessObservationRecord[]): boolean => {
    const prefix = caseId.toLowerCase();
    const open = control(rows, `${prefix}.open`);
    const registration = control(rows, `${prefix}.register`);
    const gateway = snapshots(rows, "gateway_snapshot").at(-1);
    const bridge = snapshots(rows, "bridge_snapshot").at(-1);
    const gatewaySessions = gateway?.sessions as Record<string, unknown> | undefined;
    const bridgeSessions = bridge?.sessions as unknown[] | undefined;
    const openResponse = open?.response as Record<string, unknown> | undefined;
    const openResult = openResponse?.result as Record<string, unknown> | undefined;
    const openTlsTrust = openResult?.testTlsTrust;
    const bridgeTransport = bridge?.transport as Record<string, unknown> | undefined;
    const bridgeTlsTrust = bridgeTransport?.testTlsTrust;
    const tlsBound = binding === "wss"
      ? openTlsTrust !== null &&
        typeof openTlsTrust === "object" &&
        bridgeTlsTrust !== null &&
        typeof bridgeTlsTrust === "object" &&
        JSON.stringify(openTlsTrust) === JSON.stringify(bridgeTlsTrust)
      : openTlsTrust === null && bridgeTlsTrust === null;
    const base =
      open !== undefined &&
      registration !== undefined &&
      gatewaySessions !== undefined &&
      Object.keys(gatewaySessions).length === 1 &&
      Array.isArray(bridgeSessions) &&
      bridgeSessions.length === 1 &&
      tlsBound &&
      hasBidirectionalWire(rows);
    if (!base || binding !== rows[0]?.binding) return false;
    if (caseId === "O1-C01") {
      const response = open.response as Record<string, unknown>;
      const result = response.result as Record<string, unknown>;
      const helloAck = result.helloAck as Record<string, unknown>;
      const helloPayload = helloAck.payload as Record<string, unknown>;
      return helloPayload.protocol === 1 &&
        Array.isArray(helloPayload.granted_capabilities) &&
        helloPayload.granted_capabilities.length === 4;
    }
    const poll = control(rows, "o1-c05.poll-context");
    const response = poll?.response as Record<string, unknown> | undefined;
    const result = response?.result as Record<string, unknown> | undefined;
    const sessions = Object.values(gatewaySessions);
    const documents = (sessions[0] as Record<string, unknown> | undefined)?.documents;
    return result?.pushed === true &&
      Array.isArray(documents) &&
      documents.some((document) =>
        (document as Record<string, unknown>).document_id === "conformance-document");
  };
  return {
    caseId,
    probes(records) {
      const ids = records.map(({ observationId }) => observationId);
      return assertionIds.map((assertionId) => ({
        assertionId,
        observationIds: ids,
        evaluate: (selected: readonly ProcessObservationRecord[]) =>
          allBindings(selected, bindingPredicate),
      }));
    },
    bindingPassed: bindingPredicate,
  };
}

describe("production three-process case stack", () => {
  it.each(["O1-C01", "O1-C05"] as const)(
    "runs %s through both real Gateway bindings and parent-owned predicates",
    async (caseId) => {
      const plan = productionPlan(caseId);
      const executions = await executeProductionCaseBothBindings({
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
        evaluator: evaluator(caseId),
      });
      expect(evaluated.status).toBe("passed");
      expect(evaluated.bindings.map(({ status }) => status)).toEqual(["passed", "passed"]);
      expect(evaluated.assertions.every(({ passed, actual }) => passed === true && actual === true)).toBe(true);

      for (const execution of executions) {
        const captures = execution.evidence.captures;
        if (execution.binding === "wss") {
          expect(String(captures["gateway.ready.ws_url"])).toMatch(/^wss:\/\/127\.0\.0\.1:/u);
          expect(captures["gateway.ready.ca_certificate_sha256"]).toMatch(/^sha256:[0-9a-f]{64}$/u);
          expect(captures["gateway.ready.server_certificate_sha256"]).toMatch(/^sha256:[0-9a-f]{64}$/u);
          const caPath = String(captures["gateway.ready.ca_certificate_path"]);
          expect(path.isAbsolute(caPath)).toBe(true);
          expect(existsSync(caPath)).toBe(false);
        } else {
          expect(String(captures["gateway.ready.http_connection_url"])).toMatch(
            /^http:\/\/127\.0\.0\.1:/u,
          );
          expect(captures["gateway.ready.ca_certificate_path"]).toBeNull();
        }
        const lifecycles = execution.evidence.observations.filter(({ kind }) => kind === "process_lifecycle");
        const stopped = lifecycles.filter((record) => payload(record).phase === "stopped");
        expect(stopped).toHaveLength(3);
        expect(new Set(stopped.map((record) =>
          Number((payload(record).process as Record<string, unknown>).pid))).size).toBe(3);
        expect(stopped.every((record) =>
          payload(record).orphanProcessCount === 0 &&
          payload(record).killEscalated === false)).toBe(true);
      }
    },
    90_000,
  );
});
