import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sha256File } from "../src/executionPlan.js";
import { productionComponentLaunchConfigs } from "../src/productionExecutionPlan.js";
import { createProductionReconnectSoakAdapter } from "../src/productionSoakAdapter.js";
import type { ExecutionPlan } from "../src/types.js";
import {
  attachCurrentProductionToolchainProvenance,
  createPlan,
} from "./helpers.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");

function productionPlan(): ExecutionPlan {
  const plan = attachCurrentProductionToolchainProvenance(createPlan());
  plan.runId = "production-soak-adapter";
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

describe("production reconnect/proxy-churn soak adapter", () => {
  it("keeps two real three-process stacks alive across both binding churn cycles", async () => {
    let runtimeGuardCalls = 0;
    const adapter = await createProductionReconnectSoakAdapter({
      plan: productionPlan(),
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
      },
    });
    try {
      expect(runtimeGuardCalls).toBe(12);
      const before = await adapter.sampleResources();
      expect(before).toMatchObject({ journalPendingCount: 0 });
      expect(before.residentBytes).toBeGreaterThan(0);
      expect(before.openFileDescriptorCount).toBeGreaterThan(0);

      await expect(adapter.churn("wss", 1)).resolves.toEqual({
        reconnects: 1,
        proxyChurns: 1,
        heartbeatAcks: 1,
        controlRoundTrips: 2,
        journalPending: 0,
      });
      await expect(adapter.churn("streamable_http_sse", 2)).resolves.toEqual({
        reconnects: 1,
        proxyChurns: 1,
        heartbeatAcks: 1,
        controlRoundTrips: 2,
        journalPending: 0,
      });
      const after = await adapter.sampleResources();
      expect(after.journalPendingCount).toBe(0);
      expect(runtimeGuardCalls).toBe(14);
    } finally {
      await adapter.close();
    }
    expect(runtimeGuardCalls).toBe(16);
    await expect(adapter.orphanProcessCount()).resolves.toBe(0);
  }, 120_000);

  it("fails closed when a post-cycle runtime guard detects drift", async () => {
    let runtimeGuardCalls = 0;
    const adapter = await createProductionReconnectSoakAdapter({
      plan: productionPlan(),
      repoRoot,
      runtimeLaunchGuard() {
        runtimeGuardCalls += 1;
        if (runtimeGuardCalls === 13) {
          throw new Error("planned soak-cycle runtime drift");
        }
      },
    });
    try {
      expect(runtimeGuardCalls).toBe(12);
      await expect(adapter.churn("wss", 1)).rejects.toThrow(
        /planned soak-cycle runtime drift/u,
      );
      expect(runtimeGuardCalls).toBe(13);
    } finally {
      await adapter.close();
    }
    expect(runtimeGuardCalls).toBe(15);
    await expect(adapter.orphanProcessCount()).resolves.toBe(0);
  }, 120_000);
});
