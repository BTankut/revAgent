import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import {
  beginProductionRuntimeLaunchEpoch,
  endProductionRuntimeLaunchEpoch,
} from "./productionExecutionPlan.js";
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
export const ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT =
  ONE_HOUR_SOAK_DURATION_MS / ONE_HOUR_SOAK_CYCLE_INTERVAL_MS;
export const ONE_HOUR_SOAK_MAX_START_LATENESS_MS = 2_500 as const;
export const ONE_HOUR_SOAK_MAX_COMPLETION_LATENESS_MS = 7_500 as const;
export const ONE_HOUR_SOAK_MIN_SAMPLE_GAP_MS = 2_500 as const;
export const ONE_HOUR_SOAK_MAX_SAMPLE_GAP_MS = 7_500 as const;
export const ONE_HOUR_SOAK_MAX_FINISH_LATENESS_MS = 7_500 as const;

export function hasCanonicalOneHourFinalCoverage(
  cycleCount: number,
  samples: readonly Pick<ResourceSample, "offsetMs">[],
  finishedOffsetMs: number,
): boolean {
  const lastSample = samples.at(-1);
  return (
    cycleCount === ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT &&
    samples.length === ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT &&
    finishedOffsetMs >= ONE_HOUR_SOAK_DURATION_MS &&
    finishedOffsetMs <=
      ONE_HOUR_SOAK_DURATION_MS + ONE_HOUR_SOAK_MAX_FINISH_LATENESS_MS &&
    lastSample !== undefined &&
    lastSample.offsetMs <= finishedOffsetMs &&
    finishedOffsetMs - lastSample.offsetMs <=
      ONE_HOUR_SOAK_CYCLE_INTERVAL_MS
  );
}

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
  const runtimeEpoch = beginProductionRuntimeLaunchEpoch(plan, repoRoot);
  let adapter: ReconnectSoakAdapter;
  try {
    adapter = await createProductionReconnectSoakAdapter({
      plan,
      repoRoot,
    });
  } catch (caught) {
    const setupFailure =
      caught instanceof Error ? caught : new Error(String(caught));
    try {
      endProductionRuntimeLaunchEpoch(runtimeEpoch);
    } catch (epochError) {
      throw new AggregateError(
        [
          setupFailure,
          epochError instanceof Error
            ? epochError
            : new Error(String(epochError)),
        ],
        "production soak setup failed and its runtime integrity epoch did not close cleanly",
      );
    }
    throw setupFailure;
  }
  const clock = realClock;
  const monotonicNow = (): number => clock.monotonicMs?.() ?? clock.nowMs();
  const startedWallMs = clock.nowMs();
  const startedMonotonicMs = monotonicNow();
  const wallAt = (monotonicMs: number): string =>
    new Date(startedWallMs + Math.floor(monotonicMs - startedMonotonicMs)).toISOString();
  const elapsedMs = (): number => Math.floor(monotonicNow() - startedMonotonicMs);
  const sleepUntil = async (deadlineMonotonicMs: number): Promise<void> => {
    while (true) {
      const remainingMs = deadlineMonotonicMs - monotonicNow();
      if (remainingMs <= 0) return;
      await clock.sleep(Math.ceil(remainingMs));
    }
  };
  const cycles: SoakReport["cycles"] = [];
  const samples: ResourceSample[] = [];
  const metrics: SoakMetricRecord[] = [];
  let cycle = 0;
  let failure: SoakReport["failure"] = null;
  let finishedMonotonicMs = startedMonotonicMs;
  let finishedOffsetMs = 0;
  let operationFailure: Error | undefined;
  let cleanupFailure: Error | undefined;
  let runtimeEpochFailure: Error | undefined;

  try {
    while (
      mode === "one_hour"
        ? cycle < ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT
        : elapsedMs() < requestedDurationMs
    ) {
      const scheduledOffsetMs = cycle * cycleIntervalMs;
      if (mode === "one_hour") {
        await sleepUntil(startedMonotonicMs + scheduledOffsetMs);
      }
      const cycleStarted = monotonicNow();
      const cycleStartedOffsetMs = Math.floor(cycleStarted - startedMonotonicMs);
      if (
        mode === "one_hour" &&
        (
          cycleStartedOffsetMs < scheduledOffsetMs ||
          cycleStartedOffsetMs >
            scheduledOffsetMs + ONE_HOUR_SOAK_MAX_START_LATENESS_MS
        )
      ) {
        failure = {
          code: "soak_cadence_violation",
          message:
            `cycle ${cycle + 1} started at ${cycleStartedOffsetMs} ms; ` +
            `required ${scheduledOffsetMs}-${scheduledOffsetMs + ONE_HOUR_SOAK_MAX_START_LATENESS_MS} ms`,
        };
        break;
      }
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
        if (mode === "one_hour") {
          const latestCompletionOffsetMs =
            scheduledOffsetMs + ONE_HOUR_SOAK_MAX_COMPLETION_LATENESS_MS;
          const previousSample = samples.at(-2);
          const sampleGapMs =
            previousSample === undefined
              ? undefined
              : resourceSample.offsetMs - previousSample.offsetMs;
          if (
            resourceSample.offsetMs < cycleStartedOffsetMs ||
            resourceSample.offsetMs > latestCompletionOffsetMs ||
            (
              sampleGapMs !== undefined &&
              (
                sampleGapMs < ONE_HOUR_SOAK_MIN_SAMPLE_GAP_MS ||
                sampleGapMs > ONE_HOUR_SOAK_MAX_SAMPLE_GAP_MS
              )
            )
          ) {
            failure = {
              code: "soak_cadence_violation",
              message:
                `cycle ${cycle} completed outside the canonical one-hour cadence ` +
                `(sample offset ${resourceSample.offsetMs} ms${
                  sampleGapMs === undefined ? "" : `, gap ${sampleGapMs} ms`
                })`,
            };
            break;
          }
        } else {
          await clock.sleep(Math.min(
            cycleIntervalMs,
            Math.max(0, requestedDurationMs - elapsedMs()),
          ));
        }
      } catch (error) {
        failure = { code: "soak_adapter_error", message: error instanceof Error ? error.message : String(error) };
        break;
      }
    }
    if (mode === "one_hour" && failure === null) {
      await sleepUntil(startedMonotonicMs + requestedDurationMs);
    }
    finishedMonotonicMs = monotonicNow();
    finishedOffsetMs = Math.floor(finishedMonotonicMs - startedMonotonicMs);
    if (
      mode === "one_hour" &&
      failure === null &&
      !hasCanonicalOneHourFinalCoverage(
        cycles.length,
        samples,
        finishedOffsetMs,
      )
    ) {
      const lastSampleOffsetMs = samples.at(-1)?.offsetMs;
      const finalSampleGapMs =
        lastSampleOffsetMs === undefined
          ? undefined
          : finishedOffsetMs - lastSampleOffsetMs;
      failure = {
        code: "soak_cadence_violation",
        message:
          "one-hour soak did not retain the exact full-duration cycle/sample coverage " +
          `(${cycles.length} cycles, ${samples.length} samples, ${finishedOffsetMs} ms, ` +
          `final sample gap ${finalSampleGapMs === undefined ? "missing" : `${finalSampleGapMs} ms`})`,
      };
    }
  } catch (caught) {
    operationFailure =
      caught instanceof Error ? caught : new Error(String(caught));
  } finally {
    try {
      await adapter.close();
    } catch (caught) {
      cleanupFailure =
        caught instanceof Error ? caught : new Error(String(caught));
    }
    try {
      endProductionRuntimeLaunchEpoch(runtimeEpoch);
    } catch (caught) {
      runtimeEpochFailure =
        caught instanceof Error ? caught : new Error(String(caught));
    }
  }
  if (operationFailure !== undefined) {
    const failures = [
      operationFailure,
      ...(cleanupFailure === undefined ? [] : [cleanupFailure]),
      ...(runtimeEpochFailure === undefined ? [] : [runtimeEpochFailure]),
    ];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "production soak execution failed and cleanup or runtime integrity verification was incomplete",
      );
    }
    throw operationFailure;
  }
  const resources: SoakReport["resources"] = {
    schemaVersion: "rbp-resource-profile/v1",
    samplingMode: "bounded_slope",
    sampleIntervalMs,
    policy: { ...CANONICAL_RESOURCE_POLICY },
    gcConfirmedComponents: [],
    samples,
    evaluation: null,
  };
  const orphanProcessCount = await adapter.orphanProcessCount();
  if (runtimeEpochFailure !== undefined) {
    const priorFailure = failure === null
      ? ""
      : `; prior soak failure ${failure.code}: ${failure.message}`;
    failure = {
      code: "soak_runtime_integrity",
      message: `${runtimeEpochFailure.message}${priorFailure}`,
    };
  }
  if (cleanupFailure !== undefined && failure === null) {
    failure = { code: "soak_cleanup_error", message: cleanupFailure.message };
  }
  resources.evaluation = evaluateResourceSamples(
    resources,
    orphanProcessCount,
    mode === "one_hour"
      ? { openFileDescriptorPhaseCount: 2 }
      : undefined,
  );
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
  const metricsSha256 = createHash("sha256").update(metricsBytes).digest("hex");
  const metricsArtifact = await store.writeAccepted(metricsPath, metricsBytes, (candidate) => candidate.acceptExact({
    logicalPath: metricsPath,
    absolutePath: store.resolve(metricsPath),
    bytes: metricsBytes,
    sha256: metricsSha256,
  }, {
    kind: "soak_metrics" as const,
    path: metricsPath,
    sha256: metricsSha256,
    bytes: metricsBytes.length,
    mediaType: "application/x-ndjson",
  }));
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
    artifacts: [metricsArtifact],
    failure,
  };
  const reportPath = template(
    canonicalManifest.retainedEvidence.soakReport,
    mode,
    plan.runId,
  );
  const reportBytes = Buffer.from(stableJson(report), "utf8");
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  await store.writeAccepted(reportPath, reportBytes, (candidate) => candidate.acceptExact({
    logicalPath: reportPath,
    absolutePath: store.resolve(reportPath),
    bytes: reportBytes,
    sha256: reportSha256,
  }, undefined));
  return { report, reportPath };
}
