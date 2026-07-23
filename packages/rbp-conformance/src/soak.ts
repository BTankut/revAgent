import path from "node:path";

import { loadConfinedEvidenceFile } from "./evidence.js";
import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import { resourceProfileIssues } from "./resourceMetrics.js";
import { validateSchema } from "./schemas.js";
import {
  ONE_HOUR_SOAK_CYCLE_INTERVAL_MS,
  ONE_HOUR_SOAK_DURATION_MS,
  ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT,
  ONE_HOUR_SOAK_MAX_COMPLETION_LATENESS_MS,
  ONE_HOUR_SOAK_MAX_FINISH_LATENESS_MS,
  ONE_HOUR_SOAK_MAX_SAMPLE_GAP_MS,
  ONE_HOUR_SOAK_MAX_START_LATENESS_MS,
  ONE_HOUR_SOAK_MIN_SAMPLE_GAP_MS,
} from "./soakRunner.js";
import { stableJson } from "./stableJson.js";
import type {
  LeakCounters,
  PassingValidationOptions,
  SoakMetricRecord,
  SoakReport,
  ValidationIssue,
  ValidationResult,
} from "./types.js";
import { ConformanceValidationError } from "./validator.js";

function issue(issues: ValidationIssue[], pathValue: string, code: string, message: string): void {
  issues.push({ path: pathValue, code, message });
}

function canonicalCyclePassed(cycle: SoakReport["cycles"][number]): boolean {
  return (
    cycle.reconnects >= 1 &&
    cycle.proxyChurns >= 1 &&
    cycle.heartbeatAcks >= 1 &&
    cycle.controlRoundTrips >= 1 &&
    cycle.journalPending === 0
  );
}

function retainedPath(template: string, report: SoakReport): string {
  return `${canonicalManifest.retainedEvidence.root}/${template}`
    .replaceAll("{mode}", report.mode)
    .replaceAll("{run_id}", report.runId);
}

function leakSummary(report: SoakReport): LeakCounters {
  const evaluation = report.resources.evaluation;
  return {
    openFileDescriptorDelta: evaluation?.openFileDescriptorGrowth ?? 0,
    residentBytesDelta: evaluation?.residentGrowthBytes ?? 0,
    journalPendingDelta: evaluation?.journalPendingGrowth ?? 0,
    orphanProcessCount: evaluation?.orphanProcessCount ?? 0,
  };
}

function oneHourCadenceIssues(
  report: SoakReport,
  issues: ValidationIssue[],
): void {
  if (report.requestedDurationMs !== ONE_HOUR_SOAK_DURATION_MS) {
    issue(
      issues,
      "/requestedDurationMs",
      "soak.one_hour_duration",
      "one_hour soak must request exactly 3,600,000 monotonic milliseconds",
    );
  }
  if (
    report.actualDurationMs < ONE_HOUR_SOAK_DURATION_MS ||
    report.actualDurationMs >
      ONE_HOUR_SOAK_DURATION_MS + ONE_HOUR_SOAK_MAX_FINISH_LATENESS_MS
  ) {
    issue(
      issues,
      "/actualDurationMs",
      "soak.one_hour_finish",
      "one_hour soak must finish at its monotonic deadline within the canonical lateness bound",
    );
  }
  if (report.cycles.length !== ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT) {
    issue(
      issues,
      "/cycles",
      "soak.one_hour_cycle_count",
      `one_hour soak requires exactly ${ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT} scheduled churn cycles`,
    );
  }
  if (report.resources.samples.length !== ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT) {
    issue(
      issues,
      "/resources/samples",
      "soak.one_hour_sample_count",
      `one_hour soak requires exactly ${ONE_HOUR_SOAK_EXPECTED_CYCLE_COUNT} resource samples`,
    );
  }

  const started = Date.parse(report.startedAt);
  report.cycles.forEach((cycle, index) => {
    const expectedOffsetMs = index * ONE_HOUR_SOAK_CYCLE_INTERVAL_MS;
    const cycleStartOffsetMs = Date.parse(cycle.startedAt) - started;
    const cycleFinishOffsetMs = Date.parse(cycle.finishedAt) - started;
    const expectedBinding =
      index % 2 === 0 ? "wss" : "streamable_http_sse";
    if (cycle.binding !== expectedBinding) {
      issue(
        issues,
        `/cycles/${index}/binding`,
        "soak.binding_sequence",
        "one_hour soak must alternate WSS and Streamable HTTP/SSE for the full run",
      );
    }
    if (
      cycleStartOffsetMs < expectedOffsetMs ||
      cycleStartOffsetMs >
        expectedOffsetMs + ONE_HOUR_SOAK_MAX_START_LATENESS_MS
    ) {
      issue(
        issues,
        `/cycles/${index}/startedAt`,
        "soak.cycle_start_cadence",
        "one_hour cycle start is outside its monotonic schedule window",
      );
    }
    if (
      cycleFinishOffsetMs < cycleStartOffsetMs ||
      cycleFinishOffsetMs >
        expectedOffsetMs + ONE_HOUR_SOAK_MAX_COMPLETION_LATENESS_MS
    ) {
      issue(
        issues,
        `/cycles/${index}/finishedAt`,
        "soak.cycle_completion_cadence",
        "one_hour cycle completion is outside its monotonic schedule window",
      );
    }

    const sample = report.resources.samples[index];
    if (sample === undefined) return;
    if (
      sample.offsetMs < cycleFinishOffsetMs ||
      sample.offsetMs >
        expectedOffsetMs + ONE_HOUR_SOAK_MAX_COMPLETION_LATENESS_MS
    ) {
      issue(
        issues,
        `/resources/samples/${index}/offsetMs`,
        "soak.sample_schedule",
        "one_hour sample must follow its cycle and remain inside the scheduled completion window",
      );
    }
    if (index > 0) {
      const previous = report.resources.samples[index - 1];
      if (previous === undefined) return;
      const gapMs = sample.offsetMs - previous.offsetMs;
      if (
        gapMs < ONE_HOUR_SOAK_MIN_SAMPLE_GAP_MS ||
        gapMs > ONE_HOUR_SOAK_MAX_SAMPLE_GAP_MS
      ) {
        issue(
          issues,
          `/resources/samples/${index}/offsetMs`,
          "soak.sample_cadence",
          "one_hour sample gap is outside the canonical interval/jitter bounds",
        );
      }
    }
  });

  const firstSample = report.resources.samples[0];
  if (
    firstSample === undefined ||
    firstSample.offsetMs > ONE_HOUR_SOAK_MAX_COMPLETION_LATENESS_MS
  ) {
    issue(
      issues,
      "/resources/samples/0",
      "soak.cadence_head",
      "one_hour sampling must begin near the monotonic start",
    );
  }
  const lastSample = report.resources.samples.at(-1);
  if (
    lastSample === undefined ||
    lastSample.offsetMs <
      ONE_HOUR_SOAK_DURATION_MS - ONE_HOUR_SOAK_CYCLE_INTERVAL_MS ||
    lastSample.offsetMs > report.actualDurationMs ||
    report.actualDurationMs - lastSample.offsetMs >
      ONE_HOUR_SOAK_CYCLE_INTERVAL_MS
  ) {
    issue(
      issues,
      "/resources/samples",
      "soak.cadence_tail",
      "one_hour sampling must extend through the final cadence window",
    );
  }
}

function verifyMetrics(report: SoakReport, artifactRoot: string, issues: ValidationIssue[]): void {
  const expectedPath = retainedPath(canonicalManifest.retainedEvidence.soakMetrics, report);
  const artifact = report.artifacts.find(({ kind, path: artifactPath }) =>
    kind === "soak_metrics" && artifactPath === expectedPath);
  if (artifact === undefined) {
    issue(issues, "/artifacts", "soak.missing_metrics", `missing canonical soak metrics ${expectedPath}`);
    return;
  }
  if (artifact.mediaType !== "application/x-ndjson" || artifact.bytes === 0) {
    issue(issues, "/artifacts", "soak.invalid_metrics_artifact", "soak metrics must be nonempty application/x-ndjson");
  }
  const loaded = loadConfinedEvidenceFile(
    artifact.path,
    artifactRoot,
    artifact.sha256,
    artifact.bytes,
    "/artifacts/soak_metrics",
  );
  issues.push(...loaded.issues);
  if (loaded.file === undefined) return;
  const rows: SoakMetricRecord[] = [];
  for (const [index, line] of loaded.file.text.split(/\r?\n/u).filter(Boolean).entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      issue(issues, `/artifacts/soak_metrics/line/${index + 1}`, "artifact.invalid_json", error instanceof Error ? error.message : "invalid JSON");
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      issue(issues, `/artifacts/soak_metrics/line/${index + 1}`, "soak.metric_shape", "metric row must be an object");
      continue;
    }
    const row = parsed as Partial<SoakMetricRecord>;
    const expectedKeys = [
      "schemaVersion", "runId", "mode", "cycle", "binding", "at", "reconnects",
      "proxyChurns", "heartbeatAcks", "controlRoundTrips", "journalPending", "resourceSample",
    ].sort();
    if (Object.keys(row).sort().join("|") !== expectedKeys.join("|") ||
      row.schemaVersion !== "rbp-reconnect-soak-metric/v1" ||
      row.runId !== report.runId || row.mode !== report.mode ||
      typeof row.cycle !== "number" || !Number.isSafeInteger(row.cycle) ||
      row.binding !== "wss" && row.binding !== "streamable_http_sse" ||
      typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) {
      issue(issues, `/artifacts/soak_metrics/line/${index + 1}`, "soak.metric_shape", "metric row has unknown, missing, or mismatched identity fields");
      continue;
    }
    rows.push(row as SoakMetricRecord);
  }
  if (
    rows.length !== report.cycles.length ||
    rows.length !== report.resources.samples.length
  ) {
    issue(
      issues,
      "/artifacts/soak_metrics",
      "soak.sample_cardinality",
      "retained metrics, churn cycles, and resource samples must be one-to-one",
    );
  }
  rows.forEach((row, index) => {
    const sample = report.resources.samples[index];
    const cycle = report.cycles[index];
    if (
      sample === undefined ||
      row.cycle !== index + 1 ||
      stableJson(row.resourceSample) !== stableJson(sample)
    ) {
      issue(
        issues,
        `/artifacts/soak_metrics/line/${index + 1}`,
        "soak.sample_mismatch",
        "retained metric sample must exactly match its same-index report sample",
      );
      return;
    }
    const expectedAt = Date.parse(report.startedAt) + sample.offsetMs;
    if (Date.parse(row.at) !== expectedAt) {
      issue(
        issues,
        `/artifacts/soak_metrics/line/${index + 1}/at`,
        "soak.sample_timestamp",
        "retained metric timestamp must equal its observed monotonic sample offset",
      );
    }
    if (cycle === undefined) {
      issue(
        issues,
        `/artifacts/soak_metrics/line/${index + 1}`,
        "soak.unbound_cycle",
        "each retained metric must bind to the same-index report cycle",
      );
      return;
    }
    const actual = {
      cycle: row.cycle,
      binding: row.binding,
      reconnects: row.reconnects,
      proxyChurns: row.proxyChurns,
      heartbeatAcks: row.heartbeatAcks,
      controlRoundTrips: row.controlRoundTrips,
      journalPending: row.journalPending,
    };
    const expected = {
      cycle: cycle.cycle,
      binding: cycle.binding,
      reconnects: cycle.reconnects,
      proxyChurns: cycle.proxyChurns,
      heartbeatAcks: cycle.heartbeatAcks,
      controlRoundTrips: cycle.controlRoundTrips,
      journalPending: cycle.journalPending,
    };
    if (stableJson(actual) !== stableJson(expected)) {
      issue(
        issues,
        `/artifacts/soak_metrics/line/${index + 1}`,
        "soak.metric_mismatch",
        "retained metric identity and counters must exactly mirror the same-index report cycle",
      );
    }
  });
}

export function validateSoakReport(
  value: unknown,
  options: PassingValidationOptions = {},
): ValidationResult<SoakReport> {
  const issues = validateSchema("soak", value);
  if (issues.length > 0) return { ok: false, issues };
  const report = value as SoakReport;
  if (stableJson(report.manifest) !== stableJson(canonicalManifestIdentity)) {
    issue(issues, "/manifest", "manifest.digest", "soak manifest identity is not canonical");
  }
  const started = Date.parse(report.startedAt);
  const finished = Date.parse(report.finishedAt);
  if (finished < started || finished - started !== report.actualDurationMs) {
    issue(issues, "/actualDurationMs", "soak.duration_mismatch", "actual duration must equal the report timestamp interval");
  }
  const expectedIds = canonicalManifest.requiredComponents.map(({ id }) => id);
  if (report.components.map(({ id }) => id).join("|") !== expectedIds.join("|")) {
    issue(issues, "/components", "component.order", "soak component order must match the canonical stack");
  }
  report.components.forEach((component, index) => {
    const required = canonicalManifest.requiredComponents[index];
    if (component.interfaceVersion !== required?.interfaceVersion ||
      component.identity.commitSha !== report.source.commitSha ||
      component.identity.treeSha !== report.source.treeSha ||
      component.identity.protocolVersion !== report.manifest.specVersion) {
      issue(issues, `/components/${index}`, "component.stale", "soak component identity must match the exact source/spec stack");
    }
  });
  report.cycles.forEach((cycle, index) => {
    if (cycle.cycle !== index + 1) {
      issue(issues, `/cycles/${index}/cycle`, "soak.cycle_order", "soak cycles must be contiguous and one based");
    }
    if (cycle.passed !== canonicalCyclePassed(cycle)) {
      issue(
        issues,
        `/cycles/${index}/passed`,
        "soak.cycle_result_mismatch",
        "cycle passed must exactly match the parent-recomputed reconnect, proxy, heartbeat, control, and zero-pending-journal invariants",
      );
    }
    const cycleStart = Date.parse(cycle.startedAt);
    const cycleFinish = Date.parse(cycle.finishedAt);
    if (cycleStart < started || cycleFinish > finished || cycleFinish < cycleStart) {
      issue(issues, `/cycles/${index}`, "soak.cycle_time", "cycle interval must stay inside the soak interval");
    }
  });
  if (report.resources.samples.length !== report.cycles.length) {
    issue(
      issues,
      "/resources/samples",
      "soak.sample_cardinality",
      "soak sampling is per-cycle and requires exactly one sample per churn cycle",
    );
  }
  if (
    report.mode === "one_hour" &&
    report.resources.sampleIntervalMs !== ONE_HOUR_SOAK_CYCLE_INTERVAL_MS
  ) {
    issue(
      issues,
      "/resources/sampleIntervalMs",
      "soak.sample_interval",
      "one_hour soak must use the canonical fixed per-cycle sample cadence",
    );
  }
  if (report.mode === "one_hour") {
    oneHourCadenceIssues(report, issues);
  }
  report.resources.samples.forEach((sample, index) => {
    if (sample.offsetMs < 0 || sample.offsetMs > report.actualDurationMs) {
      issue(
        issues,
        `/resources/samples/${index}/offsetMs`,
        "soak.sample_time",
        "observed resource sample offset must stay inside the soak interval",
      );
    }
    if (
      report.mode === "smoke" &&
      index > 0 &&
      sample.offsetMs - report.resources.samples[index - 1]!.offsetMs <
        report.resources.sampleIntervalMs
    ) {
      issue(
        issues,
        `/resources/samples/${index}/offsetMs`,
        "soak.sample_cadence",
        "observed per-cycle samples are closer than the recorded minimum cadence",
      );
    }
  });
  issues.push(...resourceProfileIssues(report.resources, leakSummary(report), "/resources"));
  const reportPath = retainedPath(canonicalManifest.retainedEvidence.soakReport, report);
  if (options.soakReportFile !== undefined && path.resolve(options.soakReportFile) !== path.resolve(options.artifactRoot ?? process.cwd(), reportPath)) {
    issue(issues, "/runId", "soak.report_location", "soak report is not at its canonical retained path");
  }
  if (options.verifyArtifactFiles === true) verifyMetrics(report, options.artifactRoot ?? process.cwd(), issues);
  return issues.length === 0 ? { ok: true, value: report, issues } : { ok: false, issues };
}

export function evaluatePassingSoak(
  value: unknown,
  options: PassingValidationOptions = {},
): ValidationResult<SoakReport> {
  const validation = validateSoakReport(value, options);
  if (!validation.ok || validation.value === undefined) return validation;
  const report = validation.value;
  const issues: ValidationIssue[] = [];
  if (report.status !== "passed" || report.failure !== null || report.cycles.some(({ passed }) => !passed)) {
    issue(issues, "/status", "soak.not_passed", "passing soak requires every observed cycle to pass and no failure record");
  }
  if (report.actualDurationMs < report.requestedDurationMs) {
    issue(issues, "/actualDurationMs", "soak.too_short", "soak did not run for the requested duration");
  }
  if (!new Set(report.cycles.map(({ binding }) => binding)).has("wss") ||
    !new Set(report.cycles.map(({ binding }) => binding)).has("streamable_http_sse")) {
    issue(issues, "/cycles", "soak.binding_coverage", "soak must churn both WSS and Streamable HTTP/SSE bindings");
  }
  if (options.expectedCommitSha !== undefined && report.source.commitSha !== options.expectedCommitSha) {
    issue(issues, "/source/commitSha", "source.stale_commit", "soak source commit does not match the requested commit");
  }
  if (options.expectedTreeSha !== undefined && report.source.treeSha !== options.expectedTreeSha) {
    issue(issues, "/source/treeSha", "source.stale_tree", "soak source tree does not match the requested tree");
  }
  return issues.length === 0 ? validation : { ok: false, issues };
}

export function assertPassingSoakReport(
  value: unknown,
  options: PassingValidationOptions = {},
): asserts value is SoakReport {
  const result = evaluatePassingSoak(value, options);
  if (!result.ok) throw new ConformanceValidationError("RBP reconnect/proxy-churn soak did not pass closed validation", result.issues);
}
