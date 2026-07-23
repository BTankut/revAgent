import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalManifest } from "../src/manifest.js";
import { evaluatePassingSoak } from "../src/soak.js";
import {
  ONE_HOUR_SOAK_CYCLE_INTERVAL_MS,
  ONE_HOUR_SOAK_DURATION_MS,
  runReconnectSoak,
  type SoakClock,
} from "../src/soakRunner.js";

function stackIdentity(commitSha: string, treeSha: string) {
  return canonicalManifest.requiredComponents.map((component, index) => ({
    ...component,
    identity: {
      version: "0.0.0",
      protocolVersion: canonicalManifest.spec.version,
      commitSha,
      treeSha,
      executableSha256: String(index + 1).padStart(64, "0"),
    },
  }));
}

describe("final one-hour soak cadence", () => {
  it("rejects every direct one_hour timing override", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-override-"));
    const commitSha = "1".repeat(40);
    const treeSha = "2".repeat(40);
    const base = {
      mode: "one_hour" as const,
      runId: "one-hour-override",
      artifactRoot: root,
      source: {
        repository: "revAgent",
        commitSha,
        treeSha,
        dirty: false as const,
      },
      components: stackIdentity(commitSha, treeSha),
      adapter: {
        churn: async () => ({
          reconnects: 1,
          proxyChurns: 1,
          heartbeatAcks: 1,
          controlRoundTrips: 1,
          journalPending: 0,
        }),
        sampleResources: async () => ({
          residentBytes: 1,
          openFileDescriptorCount: 1,
          journalPendingCount: 0,
        }),
        close: async () => undefined,
        orphanProcessCount: async () => 0,
      },
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains exact per-cycle monotonic sample cadence for final evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-cadence-"));
    let monotonicNow = 10_000;
    const wallNow = Date.UTC(2026, 6, 22, 0, 0, 0);
    const clock: SoakClock = {
      nowMs: () => wallNow,
      monotonicMs: () => monotonicNow,
      sleep: async (milliseconds) => {
        monotonicNow += milliseconds;
      },
    };
    const commitSha = "3".repeat(40);
    const treeSha = "4".repeat(40);
    try {
      const { report } = await runReconnectSoak({
        mode: "one_hour",
        runId: "one-hour-cadence",
        artifactRoot: root,
        source: {
          repository: "revAgent",
          commitSha,
          treeSha,
          dirty: false,
        },
        components: stackIdentity(commitSha, treeSha),
        adapter: {
          churn: async () => ({
            reconnects: 1,
            proxyChurns: 1,
            heartbeatAcks: 1,
            controlRoundTrips: 1,
            journalPending: 0,
          }),
          sampleResources: async () => ({
            residentBytes: 100_000_000,
            openFileDescriptorCount: 20,
            journalPendingCount: 0,
          }),
          close: async () => undefined,
          orphanProcessCount: async () => 0,
        },
        clock,
      });

      expect(report.requestedDurationMs).toBe(ONE_HOUR_SOAK_DURATION_MS);
      expect(report.actualDurationMs).toBe(ONE_HOUR_SOAK_DURATION_MS);
      expect(report.resources.sampleIntervalMs)
        .toBe(ONE_HOUR_SOAK_CYCLE_INTERVAL_MS);
      expect(report.resources.samples).toHaveLength(
        ONE_HOUR_SOAK_DURATION_MS / ONE_HOUR_SOAK_CYCLE_INTERVAL_MS,
      );
      expect(
        report.resources.samples.slice(1).every((sample, index) =>
          sample.offsetMs - report.resources.samples[index]!.offsetMs ===
            ONE_HOUR_SOAK_CYCLE_INTERVAL_MS),
      ).toBe(true);
      expect(
        evaluatePassingSoak(report, {
          verifyArtifactFiles: true,
          artifactRoot: root,
        }).ok,
      ).toBe(true);

      const falseCadence = structuredClone(report);
      falseCadence.resources.sampleIntervalMs = 1_000;
      expect(evaluatePassingSoak(falseCadence).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "soak.sample_interval" }),
        ]),
      );

      const missingSample = structuredClone(report);
      missingSample.resources.samples.pop();
      expect(evaluatePassingSoak(missingSample).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "soak.sample_cardinality" }),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
