import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ONE_HOUR_SOAK_CYCLE_INTERVAL_MS,
  ONE_HOUR_SOAK_DURATION_MS,
  runReconnectSoak,
} from "../src/soakRunner.js";
import type { ReconnectSoakRunInput } from "../src/soakRunner.js";
import { createPlan } from "./helpers.js";

describe("final one-hour soak cadence", () => {
  it("rejects every direct one_hour timing override", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-override-"));
    const base: ReconnectSoakRunInput = {
      mode: "one_hour",
      plan: createPlan(),
      repoRoot: root,
      artifactRoot: root,
    };
    try {
      await expect(
        runReconnectSoak({ ...base, requestedDurationMs: ONE_HOUR_SOAK_DURATION_MS }),
      ).rejects.toThrow(/cannot be overridden/u);
      await expect(
        runReconnectSoak({ ...base, cycleIntervalMs: ONE_HOUR_SOAK_CYCLE_INTERVAL_MS }),
      ).rejects.toThrow(/cannot be overridden/u);
      await expect(
        runReconnectSoak({ ...base, sampleIntervalMs: ONE_HOUR_SOAK_CYCLE_INTERVAL_MS }),
      ).rejects.toThrow(/cannot be overridden/u);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cannot fast-forward one_hour with a custom monotonic clock or emit validator input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-fast-forward-"));
    let clockCalls = 0;
    const injected = {
      mode: "one_hour",
      plan: createPlan(),
      repoRoot: root,
      artifactRoot: root,
      clock: {
        nowMs: () => {
          clockCalls += 1;
          return Date.UTC(2026, 6, 23);
        },
        monotonicMs: () => {
          clockCalls += 1;
          return ONE_HOUR_SOAK_DURATION_MS;
        },
        sleep: async () => {
          clockCalls += 1;
        },
      },
    } as unknown as ReconnectSoakRunInput;

    try {
      await expect(runReconnectSoak(injected)).rejects.toThrow(
        /forbids synthetic dependency or identity overrides: clock/u,
      );
      expect(clockCalls).toBe(0);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
