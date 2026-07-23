import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalManifest,
  executeProductionConformanceRun,
  evaluatePassingRun,
} from "../src/index.js";
import type {
  CanonicalAssertionOracleRegistry,
  ComponentId,
  ProcessObservationRecord,
  ProductionCaseExecutor,
} from "../src/index.js";
import { createPlan } from "./helpers.js";

function observation(input: {
  runId: string;
  caseId: string;
  binding: "wss" | "streamable_http_sse";
  componentId: ComponentId;
  kind: ProcessObservationRecord["kind"];
  suffix: string;
  at: string;
  payload: Record<string, unknown>;
}): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${input.runId}:${input.caseId}:${input.binding}:${input.componentId}:${input.kind}:${input.suffix}`,
    runId: input.runId,
    caseId: input.caseId,
    binding: input.binding,
    componentId: input.componentId,
    kind: input.kind,
    at: input.at,
    payload: input.payload,
  };
}

function fakeExecutor(
  clock: { value: number; pid: number },
  plan: ReturnType<typeof createPlan>,
): ProductionCaseExecutor {
  return async ({ caseId, plan: runPlan }) => {
    expect(runPlan).toBe(plan);
    return (["wss", "streamable_http_sse"] as const).map((binding) => {
      clock.value += 10;
      const at = new Date(clock.value).toISOString();
      const observations: ProcessObservationRecord[] = [];
      for (const component of plan.components) {
        const base = { runId: plan.runId, caseId, binding, componentId: component.id, at };
        if (caseId === "O1-C07") {
          observations.push(observation({
            ...base,
            kind: "process_lifecycle",
            suffix: "restart-lifecycle",
            payload: {
              schemaVersion: "rbp-supervised-process-lifecycle/v2",
              stepId: "c07.restart-stack",
              action: "restart_case_stack",
              spawnOwner: "parent_runner",
              phase: "stopped",
              instanceRootId: "sha256:test-restart",
              identity: component.expectedIdentity,
              process: {
                pid: ++clock.pid,
                startedAt: at,
                readyAt: at,
                stoppedAt: at,
                exitCode: 0,
              },
              orphanProcessCount: 0,
              survivingPids: [],
              killEscalated: false,
              stopOrder: ["bridge_simulator", "gateway_stub", "addin_loopback_fixture"],
            },
          }));
        }
        observations.push(
          observation({
            ...base,
            kind: "control_result",
            suffix: "control",
            payload: { schemaVersion: "test-control/v1" },
          }),
          observation({
            ...base,
            kind: "wire_event",
            suffix: "wire",
            payload: { schemaVersion: "test-wire/v1" },
          }),
          observation({
            ...base,
            kind: "resource_sample",
            suffix: "resource",
            payload: {
              schemaVersion: "rbp-parent-resource-sample/v1",
              stepId: `${caseId.toLowerCase()}.resource-sample`,
              residentBytes: 16 * 1024 * 1024,
              openFileDescriptorCount: 8,
              journalPendingCount: 0,
            },
          }),
          observation({
            ...base,
            kind: "process_lifecycle",
            suffix: "lifecycle",
            payload: {
              schemaVersion: "rbp-supervised-process-lifecycle/v2",
              stepId: `${caseId.toLowerCase()}.stop-stack`,
              action: "stop_case_stack",
              spawnOwner: "parent_runner",
              phase: "stopped",
              instanceRootId: "sha256:test",
              identity: component.expectedIdentity,
              process: {
                pid: ++clock.pid,
                startedAt: at,
                readyAt: at,
                stoppedAt: at,
                exitCode: 0,
              },
              orphanProcessCount: 0,
              survivingPids: [],
              killEscalated: false,
              stopOrder: ["bridge_simulator", "gateway_stub", "addin_loopback_fixture"],
            },
          }),
        );
      }
      observations.push(
        observation({
          runId: plan.runId,
          caseId,
          binding,
          componentId: "bridge_simulator",
          kind: "bridge_snapshot",
          suffix: "bridge-snapshot",
          at,
          payload: { schemaVersion: "test-bridge-snapshot/v1" },
        }),
        observation({
          runId: plan.runId,
          caseId,
          binding,
          componentId: "addin_loopback_fixture",
          kind: "fixture_snapshot",
          suffix: "fixture-snapshot",
          at,
          payload: { schemaVersion: "test-fixture-snapshot/v1" },
        }),
        observation({
          runId: plan.runId,
          caseId,
          binding,
          componentId: "addin_loopback_fixture",
          kind: "fixture_execution_count",
          suffix: "fixture-count",
          at,
          payload: { schemaVersion: "test-fixture-count/v1" },
        }),
      );
      return {
        binding,
        durationMs: 10,
        evidence: {
          observations,
          captures: {},
          completedStepIds: [],
          stepObservations: [],
        },
      };
    });
  };
}

function testOracles(): CanonicalAssertionOracleRegistry {
  return new Map(canonicalManifest.cases.flatMap(({ id: caseId }) =>
    canonicalManifest.requiredAssertions[caseId]!.map(({ id }) => [id, () => true] as const)));
}

describe("complete production suite report assembly", () => {
  it("retains forty terminal cases, exact lifecycle cardinality, resources, and reopenable evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-suite-"));
    const plan = createPlan();
    plan.runId = "production-suite-1";
    const clock = { value: Date.UTC(2026, 6, 23, 5, 0, 0), pid: 10_000 };
    try {
      const result = await executeProductionConformanceRun({
        plan,
        repoRoot: root,
        artifactRoot: root,
        seed: "production-suite-test",
        oracles: testOracles(),
        executeCase: fakeExecutor(clock, plan),
        nowMs: () => clock.value,
      });
      expect(result.report.run).toMatchObject({ status: "passed", exitCode: 0 });
      expect(result.report.cases).toHaveLength(40);
      expect(result.report.cases.every(({ status }) => status === "passed")).toBe(true);
      expect(result.report.cases.flatMap(({ bindings }) => bindings)).toHaveLength(80);
      expect(result.report.resources.samples).toHaveLength(80);
      expect(result.report.resources.evaluation?.passed).toBe(true);
      expect(result.report.artifacts.filter(({ kind }) => kind === "component_log")).toHaveLength(3);
      expect(evaluatePassingRun(result.report, {
        expectedCommitSha: plan.source.commitSha,
        expectedTreeSha: plan.source.treeSha,
        artifactRoot: root,
        verifyArtifactFiles: true,
      }).issues).toEqual([]);
      expect(JSON.parse(readFileSync(path.join(root, result.reportPath), "utf8"))).toEqual(result.report);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
