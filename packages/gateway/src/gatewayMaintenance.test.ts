import { describe, expect, it, vi } from "vitest";

import {
  GATEWAY_MAINTENANCE_MAX_OPERATIONS,
  GatewayMaintenanceCoordinator,
} from "./gatewayMaintenance.js";

describe("GatewayMaintenanceCoordinator", () => {
  it("publishes one exact pass and never overlaps callers", async () => {
    let current = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = vi.fn();
    const coordinator = new GatewayMaintenanceCoordinator({
      owner: { identity: "owner-a", epoch: 1, isCurrent: () => current },
      now: () => 0,
      async runStep({ cursor }) {
        entered();
        await gate;
        return {
          operations: 1,
          cursor,
          progressed: false,
          retryNeeded: false,
        };
      },
    });
    coordinator.start();
    const first = coordinator.runNow();
    const second = coordinator.runNow();
    expect(second).toBe(first);
    release();
    await first;
    expect(entered).toHaveBeenCalledTimes(5);
    current = false;
    await coordinator.stop();
  });

  it("enforces the exact 64-operation pass budget", async () => {
    const coordinator = new GatewayMaintenanceCoordinator({
      owner: { identity: "owner-a", epoch: 1, isCurrent: () => true },
      now: () => 0,
      async runStep({ cursor, remainingOperations }) {
        return {
          operations: remainingOperations,
          cursor,
          progressed: true,
          retryNeeded: false,
        };
      },
    });
    coordinator.start();
    const pass = await coordinator.runNow();
    expect(pass.operations).toBe(GATEWAY_MAINTENANCE_MAX_OPERATIONS);
    expect(pass.stoppedReason).toBe("operation_budget");
    await coordinator.stop();
  });

  it("stops at the 250 ms cooperative deadline", async () => {
    let nowMs = 0;
    const coordinator = new GatewayMaintenanceCoordinator({
      owner: { identity: "owner-a", epoch: 1, isCurrent: () => true },
      now: () => nowMs,
      async runStep({ cursor }) {
        nowMs = 250;
        return { operations: 1, cursor, progressed: true, retryNeeded: false };
      },
    });
    coordinator.start();
    await expect(coordinator.runNow()).resolves.toMatchObject({
      operations: 1,
      stoppedReason: "cooperative_budget",
    });
    await coordinator.stop();
  });

  it("round-robins past a retry-needed first lane and drains before stop resolves", async () => {
    const lanes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let enteredSecond!: () => void;
    const secondEntered = new Promise<void>((resolve) => { enteredSecond = resolve; });
    const coordinator = new GatewayMaintenanceCoordinator({
      owner: { identity: "owner-a", epoch: 1, isCurrent: () => true },
      now: () => 0,
      async runStep({ cursor }) {
        lanes.push(cursor.lane);
        if (lanes.length === 1) {
          return { operations: 0, cursor, progressed: false, retryNeeded: true };
        }
        enteredSecond();
        await gate;
        return { operations: 0, cursor, progressed: false, retryNeeded: false };
      },
    });
    coordinator.start();
    const pass = coordinator.runNow();
    await secondEntered;
    const stopping = coordinator.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await pass;
    expect(lanes.slice(0, 2)).toStrictEqual([
      "session_retention",
      "session_migration_cleanup",
    ]);
    expect(coordinator.state).toBe("stopped");
  });

  it("refuses startup and stops new steps immediately after owner loss", async () => {
    let current = false;
    const coordinator = new GatewayMaintenanceCoordinator({
      owner: { identity: "owner-a", epoch: 1, isCurrent: () => current },
      now: () => 0,
      async runStep({ cursor }) {
        return { operations: 1, cursor, progressed: true, retryNeeded: false };
      },
    });
    expect(() => coordinator.start()).toThrow("owner is unavailable");
    current = true;
    coordinator.start();
    current = false;
    await expect(coordinator.runNow()).resolves.toMatchObject({
      operations: 0,
      stoppedReason: "owner_lost",
    });
    await coordinator.stop();
  });
});
