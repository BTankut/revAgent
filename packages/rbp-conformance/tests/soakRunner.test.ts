import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { evaluatePassingSoak } from "../src/soak.js";
import { runReconnectSoak, type SoakClock } from "../src/soakRunner.js";

describe("executable reconnect/proxy-churn soak runner", () => {
  it("retains raw cycle metrics and validates a runner-computed smoke result", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-soak-"));
    let wallNow = Date.UTC(2026, 6, 22, 0, 0, 0);
    let monotonicNow = 1_000;
    const clock: SoakClock = {
      nowMs: () => wallNow,
      monotonicMs: () => monotonicNow,
      sleep: async (ms) => {
        monotonicNow += ms;
        // A wall-clock correction must not shorten or lengthen the soak gate.
        wallNow -= 5_000;
      },
    };
    let samples = 0;
    let closed = false;
    const commitSha = "1".repeat(40);
    const treeSha = "2".repeat(40);
    try {
      const { report } = await runReconnectSoak({
        mode: "smoke",
        runId: "smoke-test",
        requestedDurationMs: 30_000,
        cycleIntervalMs: 4_000,
        sampleIntervalMs: 1_000,
        artifactRoot: root,
        source: { repository: "revAgent", commitSha, treeSha, dirty: false },
        components: canonicalManifest.requiredComponents.map((component, index) => ({
          ...component,
          identity: {
            version: `1.0.${index}`,
            protocolVersion: "1.0-rc.1",
            commitSha,
            treeSha,
            executableSha256: String(index + 1).padStart(64, "0"),
          },
        })),
        adapter: {
          churn: async () => ({ reconnects: 1, proxyChurns: 1, heartbeatAcks: 1, controlRoundTrips: 2, journalPending: 0 }),
          sampleResources: async () => ({
            residentBytes: 100_000_000 + samples++ * 1024,
            openFileDescriptorCount: 20,
            journalPendingCount: 0,
          }),
          close: async () => { closed = true; },
          orphanProcessCount: async () => 0,
        },
        clock,
      });
      expect(report.status).toBe("passed");
      expect(report.actualDurationMs).toBe(30_000);
      expect(closed).toBe(true);
      expect(report.cycles.map(({ binding }) => binding)).toEqual(expect.arrayContaining(["wss", "streamable_http_sse"]));
      expect(evaluatePassingSoak(report, { verifyArtifactFiles: true, artifactRoot: root }).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
