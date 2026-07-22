import path from "node:path";

import { loadConfinedEvidenceFile, verifyAggregateEvidenceFiles, verifyRunEvidenceFiles } from "./evidence.js";
import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import { classifyRunStatus } from "./runClassification.js";
import { validateSchema } from "./schemas.js";
import { stableJson } from "./stableJson.js";
import type {
  AggregateReport,
  ArtifactEvidence,
  ComponentEvidence,
  ExecutionPlan,
  PassingValidationOptions,
  RunReport,
  ValidationIssue,
  ValidationResult,
} from "./types.js";

const ZERO_SHA256 = "0".repeat(64);

export class ConformanceValidationError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[],
  ) {
    super(message);
    this.name = "ConformanceValidationError";
  }
}

function issue(issues: ValidationIssue[], pathValue: string, code: string, message: string): void {
  issues.push({ path: pathValue, code, message });
}

function manifestIdentityIssues(value: RunReport["manifest"] | AggregateReport["manifest"]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (value.id !== canonicalManifestIdentity.id) {
    issue(issues, "/manifest/id", "manifest.id", "manifest id does not match the canonical section 21 manifest");
  }
  if (value.version !== canonicalManifestIdentity.version) {
    issue(issues, "/manifest/version", "manifest.version", "manifest version does not match the canonical manifest");
  }
  if (value.specVersion !== canonicalManifestIdentity.specVersion) {
    issue(issues, "/manifest/specVersion", "manifest.spec_version", "spec version does not match 1.0-rc.1");
  }
  if (value.sha256 !== canonicalManifestIdentity.sha256) {
    issue(issues, "/manifest/sha256", "manifest.digest", "manifest digest does not match the canonical manifest bytes");
  }
  return issues;
}

function exactSetIssues(
  actual: readonly string[],
  expected: readonly string[],
  pathValue: string,
  code: string,
): ValidationIssue[] {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some((entry, index) => entry !== expected[index])) {
    return [{ path: pathValue, code, message: `expected ordered values ${expected.join(", ")}` }];
  }
  return [];
}

function componentSemanticIssues(
  component: ComponentEvidence,
  index: number,
  report: RunReport,
  requireObserved: boolean,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const expectedManifestComponent = canonicalManifest.requiredComponents[index];
  const base = `/components/${index}`;
  if (component.id !== expectedManifestComponent?.id || component.interfaceVersion !== expectedManifestComponent.interfaceVersion) {
    issue(issues, base, "component.contract", "component order/id/interface version does not match the canonical manifest");
  }
  if (component.expectedIdentity.protocolVersion !== canonicalManifest.spec.version) {
    issue(issues, `${base}/expectedIdentity/protocolVersion`, "component.protocol_version", "expected component protocol version is stale");
  }
  if (component.expectedIdentity.commitSha !== report.source.commitSha || component.expectedIdentity.treeSha !== report.source.treeSha) {
    issue(issues, `${base}/expectedIdentity`, "component.source_identity", "expected component was not built from the report commit/tree");
  }
  if (component.expectedIdentity.executableSha256 === ZERO_SHA256) {
    issue(issues, `${base}/expectedIdentity/executableSha256`, "artifact.placeholder_hash", "all-zero executable digest is not evidence");
  }
  if (component.observedIdentity === null) {
    if (requireObserved) {
      issue(issues, `${base}/observedIdentity`, "component.not_observed", "passing evidence requires observed component identity");
    }
  } else {
    if (stableJson(component.expectedIdentity) !== stableJson(component.observedIdentity)) {
      issue(issues, `${base}/observedIdentity`, "component.stale", "observed component identity differs from the execution plan");
    }
    if (component.observedIdentity.commitSha !== report.source.commitSha || component.observedIdentity.treeSha !== report.source.treeSha) {
      issue(issues, `${base}/observedIdentity`, "component.stale_source", "observed component was not built from the report commit/tree");
    }
  }
  return issues;
}

function artifactRecordIssues(artifacts: ArtifactEvidence[], pathValue: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const paths = new Set<string>();
  for (const [index, artifact] of artifacts.entries()) {
    if (!artifact.path.startsWith(`${canonicalManifest.retainedEvidence.root}/`)) {
      issue(issues, `${pathValue}/${index}/path`, "artifact.outside_retained_root", `artifact must be below ${canonicalManifest.retainedEvidence.root}`);
    }
    if (paths.has(artifact.path)) {
      issue(issues, `${pathValue}/${index}/path`, "artifact.duplicate_path", `duplicate retained artifact path ${artifact.path}`);
    }
    paths.add(artifact.path);
    if (artifact.sha256 === ZERO_SHA256) {
      issue(issues, `${pathValue}/${index}/sha256`, "artifact.placeholder_hash", "all-zero artifact digest is not evidence");
    }
  }
  return issues;
}

function applyTemplate(template: string, replacements: Record<string, string>): string {
  return `${canonicalManifest.retainedEvidence.root}/${Object.entries(replacements).reduce(
    (value, [key, replacement]) => value.replaceAll(`{${key}}`, replacement),
    template,
  )}`;
}

function requireArtifact(
  issues: ValidationIssue[],
  artifacts: ArtifactEvidence[],
  kind: ArtifactEvidence["kind"],
  expectedPath: string,
  pathValue: string,
): void {
  if (!artifacts.some((artifact) => artifact.kind === kind && artifact.path === expectedPath)) {
    issue(issues, pathValue, "artifact.required", `missing ${kind} artifact ${expectedPath}`);
  }
}

function dateMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function timestampIssues(report: RunReport): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const runStart = dateMs(report.run.startedAt);
  const runFinish = dateMs(report.run.finishedAt);
  if ((runStart === undefined) !== (runFinish === undefined) || (runStart === undefined) !== (report.run.durationMs === null)) {
    issue(issues, "/run", "timing.partial_interval", "run start, finish, and duration must be all null or all present");
  } else if (runStart !== undefined && runFinish !== undefined && report.run.durationMs !== null) {
    if (runFinish < runStart) issue(issues, "/run/finishedAt", "timing.reversed", "run finish precedes start");
    if (runFinish - runStart !== report.run.durationMs) issue(issues, "/run/durationMs", "timing.duration_mismatch", "run duration does not equal timestamp interval");
  }

  report.cases.forEach((result, index) => {
    const start = dateMs(result.startedAt);
    const finish = dateMs(result.finishedAt);
    const base = `/cases/${index}`;
    if ((start === undefined) !== (finish === undefined) || (start === undefined) !== (result.durationMs === null)) {
      issue(issues, base, "timing.partial_interval", "case start, finish, and duration must be all null or all present");
    } else if (start !== undefined && finish !== undefined && result.durationMs !== null) {
      if (finish < start) issue(issues, `${base}/finishedAt`, "timing.reversed", "case finish precedes start");
      if (finish - start !== result.durationMs) issue(issues, `${base}/durationMs`, "timing.duration_mismatch", "case duration does not equal timestamp interval");
      if (runStart !== undefined && runFinish !== undefined && (start < runStart || finish > runFinish)) {
        issue(issues, base, "timing.outside_run", "case interval falls outside the run interval");
      }
      result.bindings.forEach((binding, bindingIndex) => {
        if (binding.durationMs !== null && binding.durationMs > result.durationMs!) {
          issue(issues, `${base}/bindings/${bindingIndex}/durationMs`, "timing.binding_duration", "binding duration exceeds its case interval");
        }
      });
    }
  });

  report.components.forEach((component, index) => {
    const base = `/components/${index}/process`;
    const started = dateMs(component.process.startedAt);
    const ready = dateMs(component.process.readyAt);
    const stopped = dateMs(component.process.stoppedAt);
    const values = [component.process.pid, started, ready, stopped, component.process.exitCode];
    const present = values.filter((value) => value !== null && value !== undefined).length;
    if (present !== 0 && present !== values.length) {
      issue(issues, base, "timing.partial_process", "process pid/timestamps/exit must be all null or all present");
    } else if (present === values.length && started !== undefined && ready !== undefined && stopped !== undefined) {
      if (ready < started || stopped < ready) issue(issues, base, "timing.process_order", "process must satisfy started <= ready <= stopped");
      if (runStart !== undefined && runFinish !== undefined && (started < runStart || stopped > runFinish)) {
        issue(issues, base, "timing.process_outside_run", "component process interval falls outside the run interval");
      }
    }
  });

  if (
    report.run.durationMs !== null &&
    report.timing.suiteDurationMs !== null &&
    report.timing.setupDurationMs !== null &&
    report.timing.teardownDurationMs !== null &&
    report.timing.setupDurationMs + report.timing.suiteDurationMs + report.timing.teardownDurationMs > report.run.durationMs
  ) {
    issue(issues, "/timing", "timing.summary_exceeds_run", "setup + suite + teardown exceeds the run duration");
  }
  return issues;
}

function caseAlignmentIssues(report: RunReport, requirePassing: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  for (const [index, result] of report.cases.entries()) {
    const expected = canonicalManifest.cases[index];
    const base = `/cases/${index}`;
    if (!expected) {
      issue(issues, base, "case.unknown", `unknown case ${result.caseId}`);
      continue;
    }
    if (seen.has(result.caseId)) {
      issue(issues, `${base}/caseId`, "case.duplicate", `duplicate case ${result.caseId}`);
    }
    seen.add(result.caseId);
    if (result.caseId !== expected.id) {
      issue(issues, `${base}/caseId`, "case.order", `expected ${expected.id}`);
    }
    if (result.title !== expected.title) {
      issue(issues, `${base}/title`, "case.title", "case title does not match the canonical manifest");
    }
    issues.push(...exactSetIssues(result.requiredComponents, expected.requiredComponents, `${base}/requiredComponents`, "case.components"));
    issues.push(...exactSetIssues(result.bindings.map(({ binding }) => binding), expected.bindings, `${base}/bindings`, "case.bindings"));
    issues.push(...artifactRecordIssues(result.artifacts, `${base}/artifacts`));

    const requiredAssertions = canonicalManifest.requiredAssertions[expected.id]!;
    if (result.assertions.length !== requiredAssertions.length) {
      issue(issues, `${base}/assertions`, "case.assertion_contract", `expected exactly ${requiredAssertions.length} ordered canonical assertions`);
    }
    result.assertions.forEach((assertion, assertionIndex) => {
      const required = requiredAssertions[assertionIndex];
      if (
        required === undefined ||
        assertion.assertionId !== required.id ||
        assertion.subvectorId !== required.subvectorId ||
        assertion.statement !== required.statement ||
        assertion.category !== required.category ||
        stableJson(assertion.expected) !== stableJson(required.expected)
      ) {
        issue(issues, `${base}/assertions/${assertionIndex}`, "case.assertion_contract", "assertion id, sub-vector, statement, category, order, and expected semantics must exactly match the canonical manifest");
      }
    });

    if (requirePassing) {
      if (result.status !== "passed") {
        issue(issues, `${base}/status`, "case.not_passed", `case is ${result.status}; skipped/nonterminal cases cannot pass the gate`);
      }
      if (result.startedAt === null || result.finishedAt === null || result.durationMs === null) {
        issue(issues, base, "case.missing_timing", "passing case requires complete timing evidence");
      }
      for (const [bindingIndex, binding] of result.bindings.entries()) {
        if (binding.status !== "passed" || binding.durationMs === null) {
          issue(issues, `${base}/bindings/${bindingIndex}`, "case.binding_not_passed", `${binding.binding} did not pass with timing evidence`);
        }
        requireArtifact(
          issues,
          result.artifacts,
          "wire_trace",
          applyTemplate(canonicalManifest.retainedEvidence.wireTrace, {
            run_id: report.run.runId,
            case_id: result.caseId,
            binding: binding.binding,
          }),
          `${base}/artifacts`,
        );
      }
      requireArtifact(
        issues,
        result.artifacts,
        "journal_snapshot",
        applyTemplate(canonicalManifest.retainedEvidence.journalSnapshot, {
          run_id: report.run.runId,
          case_id: result.caseId,
        }),
        `${base}/artifacts`,
      );
      const evidenceHashes = new Set(result.artifacts.map(({ sha256 }) => sha256));
      for (const [assertionIndex, assertion] of result.assertions.entries()) {
        if (assertion.passed !== true) {
          issue(issues, `${base}/assertions/${assertionIndex}/passed`, "assertion.false_green", "passing case contains a false, null, or omitted assertion result");
        }
        if (stableJson(assertion.actual) !== stableJson(assertion.expected)) {
          issue(issues, `${base}/assertions/${assertionIndex}/actual`, "assertion.unmet_expected", "passing assertion actual value must exactly equal its canonical expected semantics");
        }
        if (assertion.evidenceSha256 === null || !evidenceHashes.has(assertion.evidenceSha256)) {
          issue(issues, `${base}/assertions/${assertionIndex}/evidenceSha256`, "assertion.missing_evidence", "passing assertion must reference a retained case artifact digest");
        }
      }
      if (result.failure !== null) {
        issue(issues, `${base}/failure`, "case.false_green", "passing case cannot retain a failure object");
      }
    }
  }

  return issues;
}

function passingRunIssues(report: RunReport, options: PassingValidationOptions): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (report.run.status !== "passed") {
    issue(issues, "/run/status", "run.not_passed", `run is ${report.run.status}`);
  }
  if (report.run.startedAt === null || report.run.finishedAt === null || report.run.durationMs === null || report.run.exitCode !== 0) {
    issue(issues, "/run", "run.incomplete", "passing run requires timestamps, duration, and exitCode 0");
  }
  if (report.timing.suiteDurationMs === null || report.timing.setupDurationMs === null || report.timing.teardownDurationMs === null) {
    issue(issues, "/timing", "run.missing_timing", "passing run requires complete timing counters");
  }
  if (Object.values(report.leaks).some((value) => value !== 0)) {
    issue(issues, "/leaks", "run.resource_leak", "all fd/memory/journal/orphan-process leak counters must be zero");
  }
  if (options.expectedCommitSha !== undefined && report.source.commitSha !== options.expectedCommitSha) {
    issue(issues, "/source/commitSha", "source.stale_commit", "report commit does not match the requested commit");
  }
  if (options.expectedTreeSha !== undefined && report.source.treeSha !== options.expectedTreeSha) {
    issue(issues, "/source/treeSha", "source.stale_tree", "report tree does not match the requested tree");
  }
  for (const [index, component] of report.components.entries()) {
    issues.push(...componentSemanticIssues(component, index, report, true));
    if (
      component.process.pid === null ||
      component.process.startedAt === null ||
      component.process.readyAt === null ||
      component.process.stoppedAt === null ||
      component.process.exitCode !== 0
    ) {
      issue(issues, `/components/${index}/process`, "component.process_incomplete", "passing run requires a started, ready, stopped component with exitCode 0");
    }
    requireArtifact(
      issues,
      report.artifacts,
      "component_log",
      applyTemplate(canonicalManifest.retainedEvidence.componentLog, {
        run_id: report.run.runId,
        component_id: component.id,
      }),
      "/artifacts",
    );
  }
  requireArtifact(
    issues,
    report.artifacts,
    "junit",
    applyTemplate(canonicalManifest.retainedEvidence.junit, { run_id: report.run.runId }),
    "/artifacts",
  );
  requireArtifact(
    issues,
    report.artifacts,
    "leak_metrics",
    applyTemplate(canonicalManifest.retainedEvidence.leakMetrics, { run_id: report.run.runId }),
    "/artifacts",
  );
  issues.push(...caseAlignmentIssues(report, true));
  if (options.verifyArtifactFiles === true) {
    issues.push(...verifyRunEvidenceFiles(report, options.artifactRoot ?? process.cwd()));
  }
  return issues;
}

function baseRunSemanticIssues(report: RunReport): ValidationIssue[] {
  const issues: ValidationIssue[] = [...manifestIdentityIssues(report.manifest)];
  issues.push(...exactSetIssues(report.components.map(({ id }) => id), canonicalManifest.requiredComponents.map(({ id }) => id), "/components", "component.order"));
  issues.push(...artifactRecordIssues(report.artifacts, "/artifacts"));
  for (const [index, component] of report.components.entries()) {
    issues.push(...componentSemanticIssues(component, index, report, false));
  }
  issues.push(...caseAlignmentIssues(report, false));
  issues.push(...timestampIssues(report));
  if (report.run.status === "passed") {
    issues.push(...passingRunIssues(report, {}));
  }
  return issues;
}

export function validateExecutionPlanStructure(value: unknown): ValidationResult<ExecutionPlan> {
  const issues = validateSchema("executionPlan", value);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const plan = value as ExecutionPlan;
  issues.push(...manifestIdentityIssues(plan.manifest));
  issues.push(...exactSetIssues(plan.components.map(({ id }) => id), canonicalManifest.requiredComponents.map(({ id }) => id), "/components", "component.order"));
  plan.components.forEach((component, index) => {
    const expected = canonicalManifest.requiredComponents[index];
    if (component.interfaceVersion !== expected?.interfaceVersion) {
      issue(issues, `/components/${index}/interfaceVersion`, "component.contract", "interface version does not match canonical manifest");
    }
    if (component.expectedIdentity.commitSha !== plan.source.commitSha || component.expectedIdentity.treeSha !== plan.source.treeSha) {
      issue(issues, `/components/${index}/expectedIdentity`, "component.source_identity", "planned component does not match source commit/tree");
    }
    if (component.expectedIdentity.executableSha256 === ZERO_SHA256) {
      issue(issues, `/components/${index}/expectedIdentity/executableSha256`, "artifact.placeholder_hash", "all-zero executable digest is not evidence");
    }
  });
  return issues.length === 0 ? { ok: true, value: plan, issues } : { ok: false, issues };
}

export function validateRunReportStructure(value: unknown): ValidationResult<RunReport> {
  const issues = validateSchema("run", value);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const report = value as RunReport;
  issues.push(...baseRunSemanticIssues(report));
  return issues.length === 0 ? { ok: true, value: report, issues } : { ok: false, issues };
}

export function evaluatePassingRun(value: unknown, options: PassingValidationOptions = {}): ValidationResult<RunReport> {
  const structure = validateRunReportStructure(value);
  if (!structure.ok || structure.value === undefined) {
    return structure;
  }
  const issues = passingRunIssues(structure.value, options);
  return issues.length === 0 ? { ok: true, value: structure.value, issues } : { ok: false, issues };
}

export function assertPassingRunReport(value: unknown, options: PassingValidationOptions = {}): asserts value is RunReport {
  const result = evaluatePassingRun(value, options);
  if (!result.ok) {
    throw new ConformanceValidationError("RBP conformance run did not pass closed validation", result.issues);
  }
}

export function validateAggregateReportStructure(value: unknown): ValidationResult<AggregateReport> {
  const issues = validateSchema("aggregate", value);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const report = value as AggregateReport;
  issues.push(...manifestIdentityIssues(report.manifest));
  const expectedReportPath = `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateReport}`;
  if (report.reportPath !== expectedReportPath) {
    issue(issues, "/reportPath", "aggregate.self_report_path", `aggregate report path must be ${expectedReportPath}`);
  }
  issues.push(...exactSetIssues(report.runs.map(({ sequence }) => String(sequence)), ["1", "2", "3"], "/runs", "aggregate.sequence"));
  if (new Set(report.runs.map(({ runId }) => runId)).size !== 3) {
    issue(issues, "/runs", "aggregate.duplicate_run", "aggregate run ids must be unique");
  }
  if (new Set(report.runs.map(({ reportSha256 }) => reportSha256)).size !== 3) {
    issue(issues, "/runs", "aggregate.duplicate_report", "aggregate report digests must be unique");
  }
  report.runs.forEach((run, index) => {
    issues.push(...manifestIdentityIssues(run.manifest).map((entry) => ({ ...entry, path: `/runs/${index}${entry.path}` })));
    const expectedPath = applyTemplate(canonicalManifest.retainedEvidence.runReport, { run_id: run.runId });
    if (run.reportPath !== expectedPath) {
      issue(issues, `/runs/${index}/reportPath`, "aggregate.report_path", `expected retained run report path ${expectedPath}`);
    }
    if (run.reportSha256 === ZERO_SHA256) {
      issue(issues, `/runs/${index}/reportSha256`, "artifact.placeholder_hash", "all-zero run report digest is not evidence");
    }
    if (stableJson(run.source) !== stableJson(report.source)) {
      issue(issues, `/runs/${index}/source`, "aggregate.mixed_source", "run source identity differs from the aggregate source");
    }
    issues.push(...exactSetIssues(run.bindings, ["wss", "streamable_http_sse"], `/runs/${index}/bindings`, "aggregate.bindings"));
    issues.push(...exactSetIssues(run.components.map(({ id }) => id), canonicalManifest.requiredComponents.map(({ id }) => id), `/runs/${index}/components`, "aggregate.components"));
    run.components.forEach((component, componentIndex) => {
      const required = canonicalManifest.requiredComponents[componentIndex];
      if (component.interfaceVersion !== required?.interfaceVersion) {
        issue(issues, `/runs/${index}/components/${componentIndex}/interfaceVersion`, "aggregate.component_contract", "component interface differs from canonical manifest");
      }
      if (run.status === "passed" && component.identity === null) {
        issue(issues, `/runs/${index}/components/${componentIndex}/identity`, "aggregate.component_identity", "passing run reference requires observed component identity");
      }
      if (
        component.identity !== null &&
        (component.identity.commitSha !== run.source.commitSha ||
          component.identity.treeSha !== run.source.treeSha ||
          component.identity.protocolVersion !== run.manifest.specVersion)
      ) {
        issue(issues, `/runs/${index}/components/${componentIndex}/identity`, "aggregate.stale_component", "component identity does not match run source/spec identity");
      }
    });
    const start = dateMs(run.startedAt);
    const finish = dateMs(run.finishedAt);
    if ((start === undefined) !== (finish === undefined) || (start === undefined) !== (run.durationMs === null)) {
      issue(issues, `/runs/${index}`, "timing.partial_interval", "aggregate run start, finish, duration must be all null or all present");
    } else if (start !== undefined && finish !== undefined && run.durationMs !== null) {
      if (finish < start) issue(issues, `/runs/${index}/finishedAt`, "timing.reversed", "aggregate run finish precedes start");
      if (finish - start !== run.durationMs) issue(issues, `/runs/${index}/durationMs`, "timing.duration_mismatch", "aggregate run duration does not match timestamps");
    }
  });
  const stackFingerprint = (run: AggregateReport["runs"][number]): string =>
    stableJson({ manifest: run.manifest, source: run.source, components: run.components, bindings: run.bindings });
  const identicalStack = report.runs.every((run) => stackFingerprint(run) === stackFingerprint(report.runs[0]!));
  if (!identicalStack) {
    issue(issues, "/runs", "aggregate.mixed_stack", "all three runs must use identical manifest/source/component/binding identities");
  }
  issues.push(...artifactRecordIssues(report.artifacts, "/artifacts"));
  report.cases.forEach((result, index) => {
    const expected = canonicalManifest.cases[index];
    if (result.caseId !== expected?.id || result.title !== expected.title) {
      issue(issues, `/cases/${index}`, "aggregate.case_alignment", `expected ${expected?.id ?? "no case"}`);
    }
    if (result.passedAllRuns !== result.runStatuses.every((status) => status === "passed")) {
      issue(issues, `/cases/${index}/passedAllRuns`, "aggregate.false_green", "passedAllRuns disagrees with run statuses");
    }
  });
  report.runs.forEach((run, runIndex) => {
    const statuses = report.cases.map(({ runStatuses }) => runStatuses[runIndex]);
    if (run.status === "passed" && !statuses.every((status) => status === "passed")) {
      issue(issues, `/runs/${runIndex}/status`, "aggregate.run_false_green", "passing run reference contains a non-passing case status");
    }
  });
  const classifications = report.runs.map(({ status }) => classifyRunStatus(status));
  const passingRuns = classifications.filter((classification) => classification === "passed").length;
  const incompleteRuns = classifications.filter((classification) => classification === "incomplete").length;
  const failedRuns = 3 - passingRuns - incompleteRuns;
  const totalDurationMs = report.runs.reduce((sum, run) => sum + (run.durationMs ?? 0), 0);
  if (
    report.summary.passingRuns !== passingRuns ||
    report.summary.incompleteRuns !== incompleteRuns ||
    report.summary.failedRuns !== failedRuns ||
    report.summary.totalDurationMs !== totalDurationMs
  ) {
    issue(issues, "/summary", "aggregate.summary", "aggregate summary does not match run references");
  }
  const observableConsecutive = identicalStack && report.runs.every((run, index) => {
    if (run.startedAt === null || run.finishedAt === null || run.sequence !== index + 1) return false;
    if (index === 0) return true;
    const priorFinish = report.runs[index - 1]?.finishedAt;
    return priorFinish !== null && priorFinish !== undefined && Date.parse(priorFinish) < Date.parse(run.startedAt);
  });
  if (report.consecutive !== observableConsecutive) {
    issue(issues, "/consecutive", "aggregate.consecutive", "consecutive flag disagrees with strict chronology and identical stack identity");
  }
  const allCasesPassing = report.cases.every(({ passedAllRuns }) => passedAllRuns);
  const expectedStatus = incompleteRuns > 0 ? "incomplete" : passingRuns === 3 && observableConsecutive && allCasesPassing ? "passed" : "failed";
  if (report.status !== expectedStatus) {
    issue(issues, "/status", "aggregate.false_green", `aggregate status must be ${expectedStatus}`);
  }
  const finishedTimes = report.runs
    .map(({ finishedAt }) => finishedAt)
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const expectedGeneratedAt = finishedTimes.at(-1) ?? "1970-01-01T00:00:00.000Z";
  if (report.generatedAt !== expectedGeneratedAt) {
    issue(issues, "/generatedAt", "aggregate.generated_at", "generatedAt must deterministically equal the latest run finish time");
  }
  return issues.length === 0 ? { ok: true, value: report, issues } : { ok: false, issues };
}

export function evaluatePassingAggregate(value: unknown, options: PassingValidationOptions = {}): ValidationResult<AggregateReport> {
  const structure = validateAggregateReportStructure(value);
  if (!structure.ok || structure.value === undefined) {
    return structure;
  }
  const report = structure.value;
  const issues: ValidationIssue[] = [];
  if (report.status !== "passed" || !report.consecutive) {
    issue(issues, "/status", "aggregate.not_passed", "aggregate is not three consecutive passing runs");
  }
  if (options.expectedCommitSha !== undefined && report.source.commitSha !== options.expectedCommitSha) {
    issue(issues, "/source/commitSha", "source.stale_commit", "aggregate commit does not match requested commit");
  }
  if (options.expectedTreeSha !== undefined && report.source.treeSha !== options.expectedTreeSha) {
    issue(issues, "/source/treeSha", "source.stale_tree", "aggregate tree does not match requested tree");
  }
  if (options.aggregateReportFile !== undefined) {
    const artifactRoot = path.resolve(options.artifactRoot ?? process.cwd());
    const expectedFile = path.resolve(artifactRoot, report.reportPath);
    const actualFile = path.resolve(options.aggregateReportFile);
    if (actualFile !== expectedFile) {
      issue(issues, "/reportPath", "aggregate.self_report_location", "aggregate JSON file is not located at its declared canonical retained path");
    }
  }
  requireArtifact(
    issues,
    report.artifacts,
    "aggregate_junit",
    `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateJunit}`,
    "/artifacts",
  );
  if (options.verifyArtifactFiles === true) {
    const artifactRoot = options.artifactRoot ?? process.cwd();
    issues.push(...verifyAggregateEvidenceFiles(report, artifactRoot));
    for (const [index, run] of report.runs.entries()) {
      const loaded = loadConfinedEvidenceFile(run.reportPath, artifactRoot, run.reportSha256, undefined, `/runs/${index}/reportPath`);
      issues.push(...loaded.issues);
      if (loaded.file === undefined) {
        continue;
      }
      if (loaded.file.bytes.length === 0) {
        issue(issues, `/runs/${index}/reportPath`, "artifact.zero_bytes", "retained run report cannot be empty");
        continue;
      }
      let retainedReport: unknown;
      try {
        retainedReport = JSON.parse(loaded.file.text) as unknown;
      } catch (error) {
        issue(issues, `/runs/${index}/reportPath`, "artifact.invalid_json", error instanceof Error ? error.message : "run report is not valid JSON");
        continue;
      }
      const retainedValidation = evaluatePassingRun(retainedReport, {
        ...options,
        artifactRoot,
        verifyArtifactFiles: true,
        expectedCommitSha: report.source.commitSha,
        expectedTreeSha: report.source.treeSha,
      });
      if (!retainedValidation.ok || retainedValidation.value === undefined) {
        issue(issues, `/runs/${index}`, "aggregate.invalid_run", "retained run report is not a fully evidenced passing run");
        continue;
      }
      const retained = retainedValidation.value;
      const retainedReference = {
        runId: retained.run.runId,
        sequence: retained.run.sequence,
        status: retained.run.status,
        startedAt: retained.run.startedAt,
        finishedAt: retained.run.finishedAt,
        durationMs: retained.run.durationMs,
        manifest: retained.manifest,
        source: retained.source,
        components: retained.components.map((component) => ({
          id: component.id,
          interfaceVersion: component.interfaceVersion,
          identity: component.observedIdentity,
        })),
        bindings: ["wss", "streamable_http_sse"],
        reportPath: run.reportPath,
        reportSha256: run.reportSha256,
      };
      if (stableJson(retainedReference) !== stableJson(run)) {
        issue(issues, `/runs/${index}`, "aggregate.reference_mismatch", "aggregate run reference does not exactly match retained report identity/timing/stack content");
      }
      retained.cases.forEach((caseResult, caseIndex) => {
        if (report.cases[caseIndex]?.runStatuses[index] !== caseResult.status) {
          issue(issues, `/cases/${caseIndex}/runStatuses/${index}`, "aggregate.case_content_mismatch", "aggregate case status differs from retained run report");
        }
      });
      if (stableJson(retained.manifest) !== stableJson(report.manifest) || stableJson(retained.source) !== stableJson(report.source)) {
        issue(issues, `/runs/${index}`, "aggregate.identity_mismatch", "retained report manifest/spec/source differs from aggregate identity");
      }
    }
  }
  return issues.length === 0 ? { ok: true, value: report, issues } : { ok: false, issues };
}

export function assertPassingAggregateReport(value: unknown, options: PassingValidationOptions = {}): asserts value is AggregateReport {
  const result = evaluatePassingAggregate(value, options);
  if (!result.ok) {
    throw new ConformanceValidationError("RBP conformance aggregate did not pass closed validation", result.issues);
  }
}
