import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import { CANONICAL_RESOURCE_POLICY, evaluateResourceSamples } from "./resourceMetrics.js";
import { SecureEvidenceStore } from "./secureEvidenceStore.js";
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
  close(): Promise<void>;
  orphanProcessCount(): Promise<number>;
}

export interface SoakClock {
  /** Wall-clock milliseconds used only to anchor retained RFC3339 timestamps. */
  nowMs(): number;
  /** Monotonic milliseconds used for every duration and deadline decision. */
  monotonicMs?(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: SoakClock = {
  nowMs: () => Date.now(),
  monotonicMs: () => performance.now(),
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
  const monotonicNow = (): number => clock.monotonicMs?.() ?? clock.nowMs();
  const startedWallMs = clock.nowMs();
  const startedMonotonicMs = monotonicNow();
  const wallAt = (monotonicMs: number): string =>
    new Date(startedWallMs + Math.floor(monotonicMs - startedMonotonicMs)).toISOString();
  const elapsedMs = (): number => Math.floor(monotonicNow() - startedMonotonicMs);
  const cycles: SoakReport["cycles"] = [];
  const samples: ResourceSample[] = [];
  const metrics: SoakMetricRecord[] = [];
  let cycle = 0;
  let failure: SoakReport["failure"] = null;

  while (elapsedMs() < requestedDurationMs) {
    const cycleStarted = monotonicNow();
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
      const cycleFinished = monotonicNow();
      cycles.push({
        cycle,
        binding,
        startedAt: wallAt(cycleStarted),
        finishedAt: wallAt(cycleFinished),
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
        offsetMs: elapsedMs(),
        ...sample,
      };
      samples.push(resourceSample);
      metrics.push({
        schemaVersion: "rbp-reconnect-soak-metric/v1",
        runId: input.runId,
        mode: input.mode,
        cycle,
        binding,
        at: wallAt(monotonicNow()),
        ...observation,
        resourceSample,
      });
      await clock.sleep(Math.min(
        cycleIntervalMs,
        Math.max(0, requestedDurationMs - elapsedMs()),
      ));
    } catch (error) {
      failure = { code: "soak_adapter_error", message: error instanceof Error ? error.message : String(error) };
      break;
    }
  }
  const finishedMonotonicMs = monotonicNow();
  const resources: SoakReport["resources"] = {
    schemaVersion: "rbp-resource-profile/v1",
    samplingMode: "bounded_slope",
    sampleIntervalMs,
    policy: { ...CANONICAL_RESOURCE_POLICY },
    gcConfirmedComponents: [],
    samples,
    evaluation: null,
  };
  let cleanupFailure: Error | undefined;
  try {
    await input.adapter.close();
  } catch (error) {
    cleanupFailure = error instanceof Error ? error : new Error(String(error));
  }
  const orphanProcessCount = await input.adapter.orphanProcessCount();
  if (cleanupFailure !== undefined && failure === null) {
    failure = { code: "soak_cleanup_error", message: cleanupFailure.message };
  }
  resources.evaluation = evaluateResourceSamples(resources, orphanProcessCount);
  if (!resources.evaluation.passed && failure === null) {
    failure = { code: "soak_resource_bound", message: "resource growth, slope, descriptor, journal, or orphan threshold was exceeded" };
  }

  const metricsPath = template(canonicalManifest.retainedEvidence.soakMetrics, input.mode, input.runId);
  const metricsBytes = Buffer.from(metrics.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  const store = new SecureEvidenceStore(input.artifactRoot);
  const storedMetrics = store.write(metricsPath, metricsBytes);
  const actualDurationMs = Math.floor(finishedMonotonicMs - startedMonotonicMs);
  const report: SoakReport = {
    schemaVersion: "rbp-reconnect-soak/v1",
    manifest: { ...canonicalManifestIdentity },
    mode: input.mode,
    runId: input.runId,
    status: failure === null && actualDurationMs >= requestedDurationMs ? "passed" : "failed",
    source: input.source,
    components: input.components,
    startedAt: new Date(startedWallMs).toISOString(),
    finishedAt: wallAt(finishedMonotonicMs),
    requestedDurationMs,
    actualDurationMs,
    cycles,
    resources,
    artifacts: [{
      kind: "soak_metrics",
      path: metricsPath,
      sha256: createHash("sha256").update(storedMetrics.bytes).digest("hex"),
      bytes: storedMetrics.bytes.length,
      mediaType: "application/x-ndjson",
    }],
    failure,
  };
  const reportPath = template(canonicalManifest.retainedEvidence.soakReport, input.mode, input.runId);
  store.write(reportPath, stableJson(report));
  return { report, reportPath };
}
