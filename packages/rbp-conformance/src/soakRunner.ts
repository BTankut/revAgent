import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import { assertTrustedProductionLaunch } from "./productionLaunchAttestation.js";
import { createProductionReconnectSoakAdapter } from "./productionSoakAdapter.js";
import { CANONICAL_RESOURCE_POLICY, evaluateResourceSamples } from "./resourceMetrics.js";
import { SecureEvidenceStore } from "./secureEvidenceStore.js";
import { stableJson } from "./stableJson.js";
import type {
  Binding,
  ExecutionPlan,
  ResourceSample,
  SoakMetricRecord,
  SoakMode,
  SoakReport,
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

interface SoakClock {
  /** Wall-clock milliseconds used only to anchor retained RFC3339 timestamps. */
  nowMs(): number;
  /** Monotonic milliseconds used for every duration and deadline decision. */
  monotonicMs?(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: SoakClock = {
  nowMs: Date.now.bind(Date),
  monotonicMs: performance.now.bind(performance),
  sleep,
};

export const ONE_HOUR_SOAK_DURATION_MS = 3_600_000 as const;
export const ONE_HOUR_SOAK_CYCLE_INTERVAL_MS = 5_000 as const;

const RECONNECT_SOAK_INPUT_FIELDS = new Set<PropertyKey>([
  "mode",
  "plan",
  "repoRoot",
  "requestedDurationMs",
  "cycleIntervalMs",
  "sampleIntervalMs",
  "artifactRoot",
]);
const REQUIRED_RECONNECT_SOAK_INPUT_FIELDS = [
  "mode",
  "plan",
  "repoRoot",
  "artifactRoot",
] as const;

export interface ReconnectSoakRunInput {
  readonly mode: SoakMode;
  readonly plan: ExecutionPlan;
  readonly repoRoot: string;
  readonly requestedDurationMs?: number;
  readonly cycleIntervalMs?: number;
  readonly sampleIntervalMs?: number;
  readonly artifactRoot: string;
}

function assertNoReconnectSoakOverrides(input: object): void {
  const ownKeys = Reflect.ownKeys(input);
  const forbidden = ownKeys
    .filter((key) => !RECONNECT_SOAK_INPUT_FIELDS.has(key))
    .map(String);
  if (forbidden.length > 0) {
    throw new Error(
      `production reconnect soak forbids synthetic dependency or identity overrides: ${forbidden.join(", ")}`,
    );
  }
  const missing = REQUIRED_RECONNECT_SOAK_INPUT_FIELDS.filter(
    (key) => !Object.hasOwn(input, key),
  );
  const accessors = ownKeys
    .filter((key): key is string => typeof key === "string")
    .filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor?.get !== undefined || descriptor?.set !== undefined;
    });
  if (missing.length > 0 || accessors.length > 0) {
    throw new Error(
      "production reconnect soak requires exact own data fields; " +
      `missing: ${missing.join(", ") || "none"}; ` +
      `accessors: ${accessors.join(", ") || "none"}`,
    );
  }
}

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

export async function runReconnectSoak(
  input: ReconnectSoakRunInput,
): Promise<{ report: SoakReport; reportPath: string }> {
  assertNoReconnectSoakOverrides(input);
  const mode = input.mode;
  const requestedDurationOverride = input.requestedDurationMs;
  const cycleIntervalOverride = input.cycleIntervalMs;
  const sampleIntervalOverride = input.sampleIntervalMs;
  if (
    mode === "one_hour" &&
    (
      requestedDurationOverride !== undefined ||
      cycleIntervalOverride !== undefined ||
      sampleIntervalOverride !== undefined
    )
  ) {
    throw new Error(
      "one_hour soak duration and sampling cadence are canonical and cannot be overridden",
    );
  }
  const requestedDurationMs = mode === "one_hour"
    ? ONE_HOUR_SOAK_DURATION_MS
    : requestedDurationOverride ?? 60_000;
  if (mode === "smoke" && (requestedDurationMs < 30_000 || requestedDurationMs > 600_000)) {
    throw new Error("smoke soak duration must be from 30 seconds through 10 minutes");
  }
  const cycleIntervalMs = mode === "one_hour"
    ? ONE_HOUR_SOAK_CYCLE_INTERVAL_MS
    : cycleIntervalOverride ?? 5_000;
  if (
    sampleIntervalOverride !== undefined &&
    sampleIntervalOverride !== cycleIntervalMs
  ) {
    throw new Error(
      "per-cycle soak sampling requires sampleIntervalMs to equal cycleIntervalMs",
    );
  }
  const sampleIntervalMs = cycleIntervalMs;
  if (cycleIntervalMs < 100) {
    throw new Error("soak intervals must be at least 100 ms");
  }
  assertTrustedProductionLaunch(input.repoRoot, "cli-bootstrap");
  const plan = structuredClone(input.plan);
  const repoRoot = input.repoRoot;
  const artifactRoot = input.artifactRoot;
  const adapter = await createProductionReconnectSoakAdapter({
    plan,
    repoRoot,
  });
  const clock = realClock;
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
      const observation = await adapter.churn(binding, cycle);
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
      const sample = await adapter.sampleResources();
      const sampleMonotonicMs = monotonicNow();
      const resourceSample: ResourceSample = {
        index: samples.length,
        offsetMs: Math.floor(sampleMonotonicMs - startedMonotonicMs),
        ...sample,
      };
      samples.push(resourceSample);
      metrics.push({
        schemaVersion: "rbp-reconnect-soak-metric/v1",
        runId: plan.runId,
        mode,
        cycle,
        binding,
        at: wallAt(sampleMonotonicMs),
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
    await adapter.close();
  } catch (error) {
    cleanupFailure = error instanceof Error ? error : new Error(String(error));
  }
  const orphanProcessCount = await adapter.orphanProcessCount();
  if (cleanupFailure !== undefined && failure === null) {
    failure = { code: "soak_cleanup_error", message: cleanupFailure.message };
  }
  resources.evaluation = evaluateResourceSamples(resources, orphanProcessCount);
  if (!resources.evaluation.passed && failure === null) {
    failure = { code: "soak_resource_bound", message: "resource growth, slope, descriptor, journal, or orphan threshold was exceeded" };
  }

  const metricsPath = template(
    canonicalManifest.retainedEvidence.soakMetrics,
    mode,
    plan.runId,
  );
  const metricsBytes = Buffer.from(
    metrics.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
  const store = new SecureEvidenceStore(artifactRoot);
  const storedMetrics = store.write(metricsPath, metricsBytes);
  const actualDurationMs = Math.floor(finishedMonotonicMs - startedMonotonicMs);
  const report: SoakReport = {
    schemaVersion: "rbp-reconnect-soak/v1",
    manifest: { ...canonicalManifestIdentity },
    mode,
    runId: plan.runId,
    status: failure === null && actualDurationMs >= requestedDurationMs ? "passed" : "failed",
    source: structuredClone(plan.source),
    components: plan.components.map((component) => ({
      id: component.id,
      interfaceVersion: component.interfaceVersion,
      identity: structuredClone(component.expectedIdentity),
    })),
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
  const reportPath = template(
    canonicalManifest.retainedEvidence.soakReport,
    mode,
    plan.runId,
  );
  store.write(reportPath, stableJson(report));
  return { report, reportPath };
}
