import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { CaseControlStep } from "../src/casePrograms.js";
import { CaseStackSupervisor } from "../src/caseStackSupervisor.js";
import { executeParentSteps } from "../src/parentStepEngine.js";
import {
  createProductionCaseDrivers,
  gatewayControlErrorOutcome,
} from "../src/productionDrivers.js";
import type { Binding, ExecutionPlan } from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(binding: Binding): ExecutionPlan {
  return createCurrentProductionPlan(
    repoRoot,
    `shared-supervisor-${binding.replaceAll("_", "-")}`,
  );
}

describe("shared production case-stack controls", () => {
  it("retains bounded teardown evidence before successful instance cleanup", async () => {
    const evidenceRoot = mkdtempSync(path.join(tmpdir(), "wp12-c29-teardown-evidence-"));
    const plan = productionPlan("wss");
    const supervisor = new CaseStackSupervisor({
      plan,
      repoRoot,
      teardownEvidenceRoot: evidenceRoot,
      runtimeLaunchGuard() {},
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await supervisor.restartCaseStack({
        caseId: "O1-C29",
        binding: "wss",
        preserveState: false,
      }, "o1-c29.stack-start", "restart_case_stack");
      const stopped = await supervisor.stopCaseStack("o1-c29.stack-stop", "stop_case_stack");
      expect(stopped.result.orphanProcessCount).toBe(0);
      expect(supervisor.active).toBe(false);

      const files = readdirSync(evidenceRoot, { recursive: true })
        .filter((entry) => typeof entry === "string" && entry.endsWith(".json"));
      expect(files).toHaveLength(1);
      const document = JSON.parse(readFileSync(path.join(evidenceRoot, files[0]!), "utf8")) as {
        instanceRootId: string;
        survivors: number[];
        components: Array<{
          componentId: string;
          stop: {
            observed: boolean;
            killEscalated: boolean;
            telemetry: { correlationKind: string | null; acknowledgement: string };
            output: { stdout: { safeLines: string[] }; stderr: { safeLines: string[] } };
          };
        }>;
      };
      expect(document.instanceRootId).toMatch(/^sha256:/u);
      expect(document.survivors).toEqual([]);
      expect(document.components).toHaveLength(3);
      const gateway = document.components.find(({ componentId }) => componentId === "gateway_stub")!;
      expect(gateway.stop.observed).toBe(true);
      expect(gateway.stop.telemetry.correlationKind).toBe("ipc_stop_nonce");
      expect(gateway.stop.output.stdout.safeLines.join("\n")).toContain("\"ws_url\"");
      if (gateway.stop.telemetry.acknowledgement !== "closed") {
        expect(gateway.stop.killEscalated).toBe(true);
      }
      expect(JSON.stringify(document)).not.toContain(evidenceRoot);
      expect(JSON.stringify(document)).not.toMatch(/(?:[A-Za-z]:\\|"token"\s*:|"proof"\s*:)/u);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      if (supervisor.active) {
        await supervisor.stopCaseStack("o1-c29.test-cleanup", "stop_case_stack");
      }
      rmSync(evidenceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(["wss", "streamable_http_sse"] as const)(
    "owns restart, extra-fixture, compact-snapshot, and backpressure seams for %s",
    async (binding) => {
      const plan = productionPlan(binding);
      let runtimeGuardCalls = 0;
      const supervisor = new CaseStackSupervisor({
        plan,
        repoRoot,
        runtimeLaunchGuard(receivedPlan, receivedRepoRoot) {
          expect(receivedPlan.runId).toBe(plan.runId);
          expect(receivedRepoRoot).toBe(repoRoot);
          runtimeGuardCalls += 1;
        },
      });
      try {
        const started = await supervisor.restartCaseStack({
          caseId: "O1-C04",
          binding,
          preserveState: false,
          startupOverrides: { clockStartMs: 1_784_764_800_000 },
        }, "shared.stack", "restart_case_stack");
        expect(started.observations).toHaveLength(3);
        const restartTiming = started.result.restartTiming as {
          schemaVersion: string;
          totalElapsedMs: number;
          phases: Array<{ phase: string; durationMs: number }>;
        };
        expect(restartTiming.schemaVersion).toBe("rbp-restart-phase-timing/v1");
        expect(restartTiming.phases.map(({ phase }) => phase)).toEqual([
          "restart_case_stack.prepare_instance",
          "restart_case_stack.addin_loopback_fixture.readiness",
          "restart_case_stack.fixture.ParentTcpCaptureProxy.start",
          "restart_case_stack.gateway_stub.readiness",
          "restart_case_stack.gateway.ParentTcpCaptureProxy.start",
          "restart_case_stack.bridge_simulator.readiness",
          "restart_case_stack.finalize",
        ]);
        expect(Number.isInteger(restartTiming.totalElapsedMs)).toBe(true);
        expect(restartTiming.totalElapsedMs).toBeGreaterThanOrEqual(0);
        expect(restartTiming.phases.every(
          ({ durationMs }) => Number.isInteger(durationMs) && durationMs >= 0,
        )).toBe(true);
        expect(supervisor.setGatewayProxyBackpressure(true).enabled).toBe(true);
        expect(supervisor.setGatewayProxyBackpressure(false).enabled).toBe(false);

        const compact = await supervisor.compactGatewaySnapshot();
        expect(compact).toMatchObject({
          schemaVersion: "rbp-gateway-compact-snapshot/v1",
          sessions: {},
        });
        expect(await supervisor.gatewaySessionCount()).toBe(0);
        let gatewayControlFailure: unknown;
        try {
          await supervisor.gatewayControl("not-a-control-action", {});
        } catch (error) {
          gatewayControlFailure = error;
        }
        expect(gatewayControlErrorOutcome(gatewayControlFailure)).toMatchObject({
          kind: "control_error",
          code: "gateway_control_http_400",
        });

        const extra = await supervisor.spawnAdditionalFixture(
          "shared.extra-fixture",
          "spawn_fixture_bind_probe",
        );
        expect(extra.result).toMatchObject({
          started: true,
          fixtureIndex: 1,
          expectedSessionCount: 2,
          tempRegistryPath: null,
        });
        const discovered = await supervisor.jsonlControl(
          "bridge_simulator",
          "discover_fixture",
          {
            host: "127.0.0.1",
            firstPort: extra.result.firstPort!,
            lastPort: extra.result.lastPort!,
            probeTimeoutMs: 1_000,
          },
        );
        expect(discovered).toMatchObject({
          evidence: {
            tempRegistryReads: 0,
            filesystemLocksCreated: 0,
          },
        });
        const sessions = (discovered as {
          sessions: Array<{ target: { host: string; port: number } }>;
        }).sessions;
        const discoveredPorts = sessions.map(({ target }) => target.port);
        const firstPort = Number(extra.result.firstPort);
        const lastPort = Number(extra.result.lastPort);
        expect(discoveredPorts).toContain(Number(supervisor.readiness().fixture.port));
        expect(discoveredPorts).toContain(Number(extra.result.port));
        expect(new Set(discoveredPorts).size).toBe(discoveredPorts.length);
        expect(sessions.every(({ target }) =>
          target.host === "127.0.0.1" &&
          target.port >= firstPort &&
          target.port <= lastPort)).toBe(true);
        expect(sessions.length).toBeLessThanOrEqual(lastPort - firstPort + 1);

        const oldGatewayPid = supervisor.component("gateway_stub").pid;
        const gatewayRestart = await supervisor.restartComponent({
          componentId: "gateway_stub",
          preserveState: true,
        }, "shared.restart-gateway", "restart_component");
        expect(gatewayRestart.result.previousPid).toBe(oldGatewayPid);
        expect(gatewayRestart.result.pid).not.toBe(oldGatewayPid);
        expect(gatewayRestart.observations.map(({ payload }) => payload.phase)).toEqual([
          "stopped",
          "started",
        ]);

        const oldBridgePid = supervisor.component("bridge_simulator").pid;
        const bridgeRestart = await supervisor.restartComponent({
          componentId: "bridge_simulator",
          preserveState: true,
        }, "shared.restart-bridge", "restart_component");
        expect(bridgeRestart.result.previousPid).toBe(oldBridgePid);
        expect(bridgeRestart.result.pid).not.toBe(oldBridgePid);
        expect(runtimeGuardCalls).toBe(14);

        const stopped = await supervisor.stopCaseStack("shared.stop", "stop_case_stack");
        expect(runtimeGuardCalls).toBe(15);
        expect(stopped.result).toMatchObject({
          stopped: true,
          orphanProcessCount: 0,
          survivingPids: [],
        });
        expect(stopped.result.stopOrder).toEqual([
          "addin_loopback_fixture",
          "bridge_simulator",
          "gateway_stub",
          "addin_loopback_fixture",
        ]);
        expect(stopped.observations).toHaveLength(4);
        expect(stopped.observations.filter(({ payload }) =>
          payload.processRole === "canonical_component")).toHaveLength(3);
        expect(stopped.observations.filter(({ payload }) =>
          payload.processRole === "auxiliary_fixture" && payload.auxiliaryIndex === 1)).toHaveLength(1);
      } finally {
        if (supervisor.active) {
          await supervisor.stopCaseStack("shared.abort", "abort_and_drain");
        }
      }
    },
    120_000,
  );

  it("stops the new child when post-readiness runtime identity changes", async () => {
    let runtimeGuardCalls = 0;
    const supervisor = new CaseStackSupervisor({
      plan: productionPlan("streamable_http_sse"),
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
        if (runtimeGuardCalls === 2) {
          throw new Error("planned post-readiness runtime drift");
        }
      },
    });
    await expect(supervisor.restartCaseStack({
      caseId: "O1-C04",
      binding: "streamable_http_sse",
      preserveState: false,
    }, "shared.guard-failure", "restart_case_stack")).rejects.toThrow(
      /planned post-readiness runtime drift/u,
    );
    expect(runtimeGuardCalls).toBe(3);
    expect(supervisor.active).toBe(false);
  }, 30_000);

  it("drains an aborted partial stack start before parent execution returns", async () => {
    const controller = new AbortController();
    const removedInstanceRoots: string[] = [];
    let runtimeGuardCalls = 0;
    const plan = productionPlan("streamable_http_sse");
    const supervisor = new CaseStackSupervisor({
      plan,
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
        if (runtimeGuardCalls === 2) {
          controller.abort(new Error("planned partial stack-start abort"));
        }
      },
      instanceRootRemover(instanceRoot) {
        removedInstanceRoots.push(instanceRoot);
        rmSync(instanceRoot, { recursive: true, force: true });
      },
    });
    const restartStep = {
      stepId: "shared.abort-partial-stack",
      phase: "setup",
      channel: "parent_harness",
      componentId: null,
      action: "restart_case_stack",
      arguments: {
        common: {
          caseId: "O1-C04",
          binding: "streamable_http_sse",
          preserveState: false,
        },
      },
      expectedOutcome: { kind: "success" },
      execution: { mode: "sequential" },
      captures: [],
      parentTimeoutMs: 30_000,
    } satisfies CaseControlStep;

    await expect(executeParentSteps({
      runId: plan.runId,
      caseId: "O1-C04",
      binding: "streamable_http_sse",
      steps: [restartStep],
      drivers: createProductionCaseDrivers(supervisor),
      signal: controller.signal,
    })).rejects.toThrow(/planned partial stack-start abort/u);

    expect(runtimeGuardCalls).toBe(3);
    expect(supervisor.active).toBe(false);
    expect(removedInstanceRoots).toHaveLength(1);
    expect(existsSync(removedInstanceRoots[0]!)).toBe(false);
  }, 30_000);

  it("preserves runtime drift as primary when failed-start cleanup also fails", async () => {
    let runtimeGuardCalls = 0;
    const instanceRoots: string[] = [];
    const supervisor = new CaseStackSupervisor({
      plan: productionPlan("streamable_http_sse"),
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
        if (runtimeGuardCalls === 2) {
          throw new Error("planned primary runtime drift");
        }
      },
      instanceRootRemover(instanceRoot) {
        instanceRoots.push(instanceRoot);
        throw new Error("planned instance-root cleanup failure");
      },
    });
    let failure: unknown;
    try {
      try {
        await supervisor.restartCaseStack({
          caseId: "O1-C04",
          binding: "streamable_http_sse",
          preserveState: false,
        }, "shared.aggregate-failure", "restart_case_stack");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors as Error[];
      expect(errors).toHaveLength(2);
      expect(errors[0]!.message).toMatch(/planned primary runtime drift/u);
      expect(errors[1]!.message).toBe("planned instance-root cleanup failure");
      expect(runtimeGuardCalls).toBe(3);
      expect(supervisor.active).toBe(false);
    } finally {
      for (const instanceRoot of instanceRoots) {
        rmSync(instanceRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("fails closed when a component restart completion guard detects drift", async () => {
    let runtimeGuardCalls = 0;
    const supervisor = new CaseStackSupervisor({
      plan: productionPlan("streamable_http_sse"),
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
        if (runtimeGuardCalls === 9) {
          throw new Error("planned component-restart completion drift");
        }
      },
    });
    try {
      await supervisor.restartCaseStack({
        caseId: "O1-C04",
        binding: "streamable_http_sse",
        preserveState: false,
      }, "shared.restart-boundary-stack", "restart_case_stack");
      expect(runtimeGuardCalls).toBe(6);

      await expect(supervisor.restartComponent({
        componentId: "bridge_simulator",
        preserveState: true,
      }, "shared.restart-boundary", "restart_component")).rejects.toThrow(
        /planned component-restart completion drift/u,
      );
      expect(runtimeGuardCalls).toBe(9);
    } finally {
      if (supervisor.active) {
        await supervisor.stopCaseStack(
          "shared.restart-boundary-stop",
          "abort_and_drain",
        );
      }
    }
  }, 30_000);

  it("keeps shutdown-boundary drift primary when instance-root cleanup also fails", async () => {
    let runtimeGuardCalls = 0;
    const instanceRoots: string[] = [];
    const supervisor = new CaseStackSupervisor({
      plan: productionPlan("streamable_http_sse"),
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
        if (runtimeGuardCalls === 7) {
          throw new Error("planned shutdown-boundary runtime drift");
        }
      },
      instanceRootRemover(instanceRoot) {
        instanceRoots.push(instanceRoot);
        throw new Error("planned shutdown instance-root cleanup failure");
      },
    });
    let failure: unknown;
    try {
      await supervisor.restartCaseStack({
        caseId: "O1-C04",
        binding: "streamable_http_sse",
        preserveState: false,
      }, "shared.shutdown-boundary-stack", "restart_case_stack");
      expect(runtimeGuardCalls).toBe(6);

      try {
        await supervisor.stopCaseStack(
          "shared.shutdown-boundary-stop",
          "stop_case_stack",
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors as Error[];
      expect(errors).toHaveLength(2);
      expect(errors[0]).toMatchObject({
        name: "ProductionRuntimeLaunchGuardError",
      });
      expect(errors[0]!.message).toMatch(/planned shutdown-boundary runtime drift/u);
      expect(errors[1]!.message).toBe("planned shutdown instance-root cleanup failure");
      expect(runtimeGuardCalls).toBe(7);
      expect(supervisor.active).toBe(false);
    } finally {
      if (supervisor.active) {
        await supervisor.stopCaseStack(
          "shared.shutdown-boundary-abort",
          "abort_and_drain",
        ).catch(() => undefined);
      }
      for (const instanceRoot of instanceRoots) {
        rmSync(instanceRoot, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("does not retry an additional fixture after its post-readiness guard fails", async () => {
    let runtimeGuardCalls = 0;
    let teardownStarted = false;
    const supervisor = new CaseStackSupervisor({
      plan: productionPlan("streamable_http_sse"),
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
        if (!teardownStarted && runtimeGuardCalls === 8) {
          throw new Error("planned additional-fixture post-readiness drift");
        }
      },
    });
    try {
      await supervisor.restartCaseStack({
        caseId: "O1-C04",
        binding: "streamable_http_sse",
        preserveState: false,
      }, "shared.additional-guard-stack", "restart_case_stack");
      expect(runtimeGuardCalls).toBe(6);

      await expect(supervisor.spawnAdditionalFixture(
        "shared.additional-guard-failure",
        "spawn_fixture_bind_probe",
      )).rejects.toThrow(/planned additional-fixture post-readiness drift/u);
      expect(runtimeGuardCalls).toBe(8);
      expect(supervisor.pids).toHaveLength(3);
    } finally {
      if (supervisor.active) {
        teardownStarted = true;
        await supervisor.stopCaseStack(
          "shared.additional-guard-stop",
          "abort_and_drain",
        );
      }
    }
  }, 30_000);
});
