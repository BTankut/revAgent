import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalManifest,
  canonicalManifestIdentity,
  evaluatePassingSoak,
} from "../src/index.js";
import {
  CANONICAL_RESOURCE_POLICY,
  evaluateResourceSamples,
} from "../src/resourceMetrics.js";
import {
  ONE_HOUR_SOAK_CYCLE_INTERVAL_MS,
  ONE_HOUR_SOAK_DURATION_MS,
  ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT,
  runReconnectSoak,
} from "../src/soakRunner.js";
import type { ReconnectSoakRunInput } from "../src/soakRunner.js";
import type {
  SoakMetricRecord,
  SoakReport,
} from "../src/types.js";
import { createPlan } from "./helpers.js";

function retainedSoakPath(template: string, report: SoakReport): string {
  return `${canonicalManifest.retainedEvidence.root}/${template}`
    .replaceAll("{mode}", report.mode)
    .replaceAll("{run_id}", report.runId);
}

function metricRows(report: SoakReport): SoakMetricRecord[] {
  const startedMs = Date.parse(report.startedAt);
  return report.cycles.map((cycle, index) => {
    const resourceSample = report.resources.samples[index]!;
    return {
      schemaVersion: "rbp-reconnect-soak-metric/v1",
      runId: report.runId,
      mode: report.mode,
      cycle: cycle.cycle,
      binding: cycle.binding,
      at: new Date(startedMs + resourceSample.offsetMs).toISOString(),
      reconnects: cycle.reconnects,
      proxyChurns: cycle.proxyChurns,
      heartbeatAcks: cycle.heartbeatAcks,
      controlRoundTrips: cycle.controlRoundTrips,
      journalPending: cycle.journalPending,
      resourceSample,
    };
  });
}

function writeMetricRows(
  root: string,
  report: SoakReport,
  rows: readonly SoakMetricRecord[],
): void {
  const bytes = Buffer.from(
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  const artifact = report.artifacts[0]!;
  const target = path.join(root, artifact.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  artifact.bytes = bytes.length;
  artifact.sha256 = createHash("sha256").update(bytes).digest("hex");
}

function canonicalOneHourFixture(root: string): SoakReport {
  const plan = createPlan();
  plan.runId = "one-hour-validator-fixture";
  const startedMs = Date.UTC(2026, 6, 23, 9, 0, 0);
  const cycles: SoakReport["cycles"] = Array.from(
    { length: ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT },
    (_, index) => {
      const scheduledOffsetMs = index * ONE_HOUR_SOAK_CYCLE_INTERVAL_MS;
      return {
        cycle: index + 1,
        binding: index % 2 === 0 ? "wss" : "streamable_http_sse",
        startedAt: new Date(startedMs + scheduledOffsetMs).toISOString(),
        finishedAt: new Date(startedMs + scheduledOffsetMs + 100).toISOString(),
        reconnects: 1,
        proxyChurns: 1,
        heartbeatAcks: 1,
        controlRoundTrips: 1,
        journalPending: 0,
        passed: true,
      };
    },
  );
  const samples: SoakReport["resources"]["samples"] = cycles.map(
    (_cycle, index) => ({
      index,
      offsetMs: index * ONE_HOUR_SOAK_CYCLE_INTERVAL_MS + 200,
      residentBytes: 100_000_000,
      openFileDescriptorCount: 12,
      journalPendingCount: 0,
    }),
  );
  const resources: SoakReport["resources"] = {
    schemaVersion: "rbp-resource-profile/v1",
    samplingMode: "bounded_slope",
    sampleIntervalMs: ONE_HOUR_SOAK_CYCLE_INTERVAL_MS,
    policy: { ...CANONICAL_RESOURCE_POLICY },
    gcConfirmedComponents: [],
    samples,
    evaluation: null,
  };
  resources.evaluation = evaluateResourceSamples(resources, 0);
  const report = {
    schemaVersion: "rbp-reconnect-soak/v1",
    manifest: { ...canonicalManifestIdentity },
    mode: "one_hour",
    runId: plan.runId,
    status: "passed",
    source: structuredClone(plan.source),
    components: plan.components.map((component) => ({
      id: component.id,
      interfaceVersion: component.interfaceVersion,
      identity: structuredClone(component.expectedIdentity),
    })),
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(
      startedMs + ONE_HOUR_SOAK_DURATION_MS,
    ).toISOString(),
    requestedDurationMs: ONE_HOUR_SOAK_DURATION_MS,
    actualDurationMs: ONE_HOUR_SOAK_DURATION_MS,
    cycles,
    resources,
    artifacts: [{
      kind: "soak_metrics",
      path: "",
      sha256: "1".repeat(64),
      bytes: 1,
      mediaType: "application/x-ndjson",
    }],
    failure: null,
  } satisfies SoakReport;
  report.artifacts[0]!.path = retainedSoakPath(
    canonicalManifest.retainedEvidence.soakMetrics,
    report,
  );
  writeMetricRows(root, report, metricRows(report));
  return report;
}

function cadenceCodes(report: SoakReport): string[] {
  return evaluatePassingSoak(report).issues.map(({ code }) => code);
}

function refreshResourceEvaluation(report: SoakReport): void {
  report.resources.evaluation = evaluateResourceSamples(report.resources, 0);
}

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

  it("accepts the complete canonical 720-cycle shape with exact retained metric mirroring", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-shape-"));
    try {
      const report = canonicalOneHourFixture(root);
      expect(evaluatePassingSoak(report, {
        verifyArtifactFiles: true,
        artifactRoot: root,
      })).toMatchObject({ ok: true, issues: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects eight early cycles followed by a long-gap tail", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-long-gap-"));
    try {
      const report = canonicalOneHourFixture(root);
      const tailCycle = structuredClone(report.cycles.at(-1)!);
      const tailSample = structuredClone(report.resources.samples.at(-1)!);
      tailCycle.cycle = 9;
      tailCycle.binding = "wss";
      tailSample.index = 8;
      report.cycles = [...report.cycles.slice(0, 8), tailCycle];
      report.resources.samples = [
        ...report.resources.samples.slice(0, 8),
        tailSample,
      ];
      refreshResourceEvaluation(report);

      expect(cadenceCodes(report)).toEqual(expect.arrayContaining([
        "soak.one_hour_cycle_count",
        "soak.one_hour_sample_count",
        "soak.sample_cadence",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a claimed one-hour finishedAt backed by only early observations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-false-finish-"));
    try {
      const report = canonicalOneHourFixture(root);
      report.cycles = report.cycles.slice(0, 8);
      report.resources.samples = report.resources.samples.slice(0, 8);
      refreshResourceEvaluation(report);

      expect(cadenceCodes(report)).toEqual(expect.arrayContaining([
        "soak.one_hour_cycle_count",
        "soak.one_hour_sample_count",
        "soak.cadence_tail",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a missing final cadence window", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-missing-tail-"));
    try {
      const report = canonicalOneHourFixture(root);
      report.cycles.pop();
      report.resources.samples.pop();
      refreshResourceEvaluation(report);

      expect(cadenceCodes(report)).toEqual(expect.arrayContaining([
        "soak.one_hour_cycle_count",
        "soak.one_hour_sample_count",
        "soak.cadence_tail",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized observed interval inside an otherwise full report", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-wide-gap-"));
    try {
      const report = canonicalOneHourFixture(root);
      report.resources.samples[100]!.offsetMs +=
        ONE_HOUR_SOAK_CYCLE_INTERVAL_MS;
      refreshResourceEvaluation(report);

      expect(cadenceCodes(report)).toContain("soak.sample_cadence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects retained metrics that do not exactly mirror the same-index report cycle", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-one-hour-metric-mirror-"));
    try {
      const report = canonicalOneHourFixture(root);
      const rows = metricRows(report);
      rows[0] = {
        ...rows[0]!,
        binding: "streamable_http_sse",
      };
      writeMetricRows(root, report, rows);

      expect(evaluatePassingSoak(report, {
        verifyArtifactFiles: true,
        artifactRoot: root,
      }).issues.map(({ code }) => code)).toContain("soak.metric_mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
