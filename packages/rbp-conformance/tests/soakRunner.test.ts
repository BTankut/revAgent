import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runReconnectSoak } from "../src/soakRunner.js";
import type { ReconnectSoakRunInput } from "../src/soakRunner.js";
import { createPlan } from "./helpers.js";

describe("production reconnect/proxy-churn soak dependency boundary", () => {
  it("rejects custom adapter and clock seams before running or retaining smoke evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-soak-injection-"));
    const calls = { adapter: 0, clock: 0 };
    const injected = {
      mode: "smoke",
      plan: createPlan(),
      repoRoot: root,
      artifactRoot: root,
      requestedDurationMs: 30_000,
      adapter: {
        churn: async () => {
          calls.adapter += 1;
          return {
            reconnects: 1,
            proxyChurns: 1,
            heartbeatAcks: 1,
            controlRoundTrips: 1,
            journalPending: 0,
          };
        },
        sampleResources: async () => {
          calls.adapter += 1;
          return {
            residentBytes: 1,
            openFileDescriptorCount: 1,
            journalPendingCount: 0,
          };
        },
        close: async () => {
          calls.adapter += 1;
        },
        orphanProcessCount: async () => {
          calls.adapter += 1;
          return 0;
        },
      },
      clock: {
        nowMs: () => {
          calls.clock += 1;
          return 0;
        },
        monotonicMs: () => {
          calls.clock += 1;
          return 0;
        },
        sleep: async () => {
          calls.clock += 1;
        },
      },
    } as unknown as ReconnectSoakRunInput;

    try {
      await expect(runReconnectSoak(injected)).rejects.toThrow(
        /forbids synthetic dependency or identity overrides: adapter, clock/u,
      );
      expect(calls).toEqual({ adapter: 0, clock: 0 });
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
