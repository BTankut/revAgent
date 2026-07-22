import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import { CANONICAL_RESOURCE_POLICY, evaluateResourceSamples } from "./resourceMetrics.js";
import { stableJson } from "./stableJson.js";
import type {
  Binding,
  ComponentIdentity,
  ComponentId,
  ResourceSample,
  SoakMetricRecord,
  SoakMode,
  SoakReport,
  SourceIdentity,
} from "./types.js";

export interface SoakCycleObservation {
  reconnects: number;
  proxyChurns: number;
  heartbeatAcks: number;
  controlRoundTrips: number;
  journalPending: number;
}

export interface ReconnectSoakAdapter {
  churn(binding: Binding, cycle: number): Promise<SoakCycleObservation>;
  sampleResources(): Promise<Omit<ResourceSample, "index" | "offsetMs">>;
  orphanProcessCount(): Promise<number>;
}

export interface SoakClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: SoakClock = {
  nowMs: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function exactObservation(value: SoakCycleObservation): void {
  const expected = ["controlRoundTrips", "heartbeatAcks", "journalPending", "proxyChurns", "reconnects"];
  const actual = Object.keys(value).sort();
  if (actual.join("|") !== expected.join("|") || Object.values(value).some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new Error("soak adapter returned a malformed or child-asserted cycle result");
  }
}

function template(value: string, mode: SoakMode, runId: string): string {
  return `${canonicalManifest.retainedEvidence.root}/${value}`
    .replaceAll("{mode}", mode)
    .replaceAll("{run_id}", runId);
}

export async function runReconnectSoak(input: {
  mode: SoakMode;
  runId: string;
  requestedDurationMs?: number;
  cycleIntervalMs?: number;
  sampleIntervalMs?: number;
  artifactRoot: string;
  source: SourceIdentity;
  components: Array<{ id: ComponentId; interfaceVersion: string; identity: ComponentIdentity }>;
  adapter: ReconnectSoakAdapter;
  clock?: SoakClock;
}): Promise<{ report: SoakReport; reportPath: string }> {
  const clock = input.clock ?? realClock;
  const requestedDurationMs = input.mode === "one_hour" ? 3_600_000 : input.requestedDurationMs ?? 60_000;
  if (input.mode === "smoke" && (requestedDurationMs < 30_000 || requestedDurationMs > 600_000)) {
    throw new Error("smoke soak duration must be from 30 seconds through 10 minutes");
  }
  const cycleIntervalMs = input.cycleIntervalMs ?? 5_000;
  const sampleIntervalMs = input.sampleIntervalMs ?? 1_000;
  if (cycleIntervalMs < 100 || sampleIntervalMs < 100) throw new Error("soak intervals must be at least 100 ms");
  const startedMs = clock.nowMs();
  const cycles: SoakReport["cycles"] = [];
  const samples: ResourceSample[] = [];
  const metrics: SoakMetricRecord[] = [];
  let cycle = 0;
  let failure: SoakReport["failure"] = null;

  while (clock.nowMs() - startedMs < requestedDurationMs) {
    const cycleStarted = clock.nowMs();
    const binding: Binding = cycle % 2 === 0 ? "wss" : "streamable_http_sse";
    cycle += 1;
    try {
      const observation = await input.adapter.churn(binding, cycle);
      exactObservation(observation);
      const passed =
        observation.reconnects >= 1 &&
        observation.proxyChurns >= 1 &&
        observation.heartbeatAcks >= 1 &&
        observation.controlRoundTrips >= 1 &&
        observation.journalPending === 0;
      const cycleFinished = clock.nowMs();
      cycles.push({
        cycle,
        binding,
        startedAt: new Date(cycleStarted).toISOString(),
        finishedAt: new Date(cycleFinished).toISOString(),
        ...observation,
        passed,
      });
      if (!passed) {
        failure = { code: "soak_cycle_failed", message: `cycle ${cycle} did not preserve reconnect/proxy/journal invariants` };
        break;
      }
      const sample = await input.adapter.sampleResources();
      const resourceSample: ResourceSample = {
        index: samples.length,
        offsetMs: clock.nowMs() - startedMs,
        ...sample,
      };
      samples.push(resourceSample);
      metrics.push({
        schemaVersion: "rbp-reconnect-soak-metric/v1",
        runId: input.runId,
        mode: input.mode,
        cycle,
        binding,
        at: new Date(clock.nowMs()).toISOString(),
        ...observation,
        resourceSample,
      });
      await clock.sleep(Math.min(cycleIntervalMs, Math.max(0, requestedDurationMs - (clock.nowMs() - startedMs))));
    } catch (error) {
      failure = { code: "soak_adapter_error", message: error instanceof Error ? error.message : String(error) };
      break;
    }
  }
  const finishedMs = clock.nowMs();
  const resources: SoakReport["resources"] = {
    schemaVersion: "rbp-resource-profile/v1",
    samplingMode: "bounded_slope",
    sampleIntervalMs,
    policy: { ...CANONICAL_RESOURCE_POLICY },
    gcConfirmedComponents: [],
    samples,
    evaluation: null,
  };
  const orphanProcessCount = await input.adapter.orphanProcessCount();
  resources.evaluation = evaluateResourceSamples(resources, orphanProcessCount);
  if (!resources.evaluation.passed && failure === null) {
    failure = { code: "soak_resource_bound", message: "resource growth, slope, descriptor, journal, or orphan threshold was exceeded" };
  }

  const metricsPath = template(canonicalManifest.retainedEvidence.soakMetrics, input.mode, input.runId);
  const metricsBytes = Buffer.from(metrics.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const metricsTarget = path.resolve(input.artifactRoot, metricsPath);
  mkdirSync(path.dirname(metricsTarget), { recursive: true });
  writeFileSync(metricsTarget, metricsBytes);
  const actualDurationMs = finishedMs - startedMs;
  const report: SoakReport = {
    schemaVersion: "rbp-reconnect-soak/v1",
    manifest: { ...canonicalManifestIdentity },
    mode: input.mode,
    runId: input.runId,
    status: failure === null && actualDurationMs >= requestedDurationMs ? "passed" : "failed",
    source: input.source,
    components: input.components,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    requestedDurationMs,
    actualDurationMs,
    cycles,
    resources,
    artifacts: [{
      kind: "soak_metrics",
      path: metricsPath,
      sha256: createHash("sha256").update(metricsBytes).digest("hex"),
      bytes: metricsBytes.length,
      mediaType: "application/x-ndjson",
    }],
    failure,
  };
  const reportPath = template(canonicalManifest.retainedEvidence.soakReport, input.mode, input.runId);
  const reportTarget = path.resolve(input.artifactRoot, reportPath);
  mkdirSync(path.dirname(reportTarget), { recursive: true });
  writeFileSync(reportTarget, stableJson(report), "utf8");
  return { report, reportPath };
}
