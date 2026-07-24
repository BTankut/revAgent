import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { buildCanonicalParentEvaluatorRegistry } from "./canonicalEvaluators.js";
import { retainSupervisedCaseEvidence } from "./caseEvidenceWriter.js";
import { runReportToJUnitXml } from "./junit.js";
import { canonicalManifest } from "./manifest.js";
import { observationObject } from "./observationQueries.js";
import { PRODUCTION_CASE_COMPOSITION } from "./productionCaseComposition.js";
import { assertTrustedProductionLaunch } from "./productionLaunchAttestation.js";
import {
  CANONICAL_RESOURCE_POLICY,
  evaluateResourceSamples,
} from "./resourceMetrics.js";
import { createUnexecutedRunReport } from "./scaffold.js";
import { SecureEvidenceStore } from "./secureEvidenceStore.js";
import { stableJson } from "./stableJson.js";
import { evaluateSupervisedCaseExecutions } from "./suiteRunner.js";
import {
  assertPassingRunReport,
  validateRunReportStructure,
} from "./validator.js";
import type { ParentStepExecutionEvidence } from "./parentStepEngine.js";
import type {
  ArtifactEvidence,
  Binding,
  ComponentId,
  ComponentIdentity,
  ComponentLogRecord,
  ExecutionPlan,
  LeakMetricsDocument,
  ProcessEvidence,
  ProcessObservationRecord,
  ResourceProfile,
  ResourceSample,
  RunReport,
} from "./types.js";

const MAX_NON_SOAK_SUITE_MS = 10 * 60 * 1_000;

export interface ProductionCaseBindingEvidence {
  readonly binding: Binding;
  readonly evidence: ParentStepExecutionEvidence;
  readonly durationMs: number;
}

export type ProductionCaseExecutor = (input: {
  plan: ExecutionPlan;
  repoRoot: string;
  caseId: string;
  clockIso?: string;
}) => Promise<ProductionCaseBindingEvidence[]>;

export interface ProductionSuiteRunInput {
  readonly plan: ExecutionPlan;
  readonly repoRoot: string;
  readonly artifactRoot: string;
  readonly seed: string;
}

export interface ProductionSuiteRunResult {
  readonly report: RunReport;
  readonly reportPath: string;
}

export interface ExecutedCaseEvidence {
  readonly caseId: string;
  readonly observations: ProcessObservationRecord[];
}

interface LifecycleFact {
  readonly componentId: ComponentId;
  readonly action: string;
  readonly processRole: "canonical_component" | "auxiliary_fixture";
  readonly identity: ComponentIdentity;
  readonly process: ProcessEvidence;
  readonly orphanProcessCount: number;
  readonly survivingPids: number[];
  readonly killEscalated: boolean;
}

const PRODUCTION_SUITE_INPUT_FIELDS = new Set<PropertyKey>([
  "plan",
  "repoRoot",
  "artifactRoot",
  "seed",
]);
const REQUIRED_PRODUCTION_SUITE_INPUT_FIELDS = [
  "plan",
  "repoRoot",
  "artifactRoot",
  "seed",
] as const;

// Capture the canonical functions while this module initializes. The runner
// never consults caller-owned dependency values and never exposes this
// retained registry copy for mutation.
const PRODUCTION_ORACLES = new Map(PRODUCTION_CASE_COMPOSITION.oracles);
const PRODUCTION_CASE_EXECUTOR = PRODUCTION_CASE_COMPOSITION.executeCase;
const productionWallNowMs = Date.now.bind(Date);
const productionMonotonicNowMs = performance.now.bind(performance);

function assertNoProductionSuiteOverrides(input: object): void {
  const ownKeys = Reflect.ownKeys(input);
  const forbidden = ownKeys
    .filter((key) => !PRODUCTION_SUITE_INPUT_FIELDS.has(key))
    .map(String);
  if (forbidden.length > 0) {
    throw new Error(
      `production suite forbids synthetic dependency overrides: ${forbidden.join(", ")}`,
    );
  }
  const missing = REQUIRED_PRODUCTION_SUITE_INPUT_FIELDS.filter(
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
      "production suite requires exact own data fields; " +
      `missing: ${missing.join(", ") || "none"}; ` +
      `accessors: ${accessors.join(", ") || "none"}`,
    );
  }
}

function retained(relative: string): string {
  return `${canonicalManifest.retainedEvidence.root}/${relative}`;
}

function applyTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return retained(Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, value),
    template,
  ));
}

function artifact(
  store: SecureEvidenceStore,
  kind: ArtifactEvidence["kind"],
  path: string,
  contents: string | Buffer,
  mediaType: string,
): ArtifactEvidence {
  const stored = store.write(path, contents);
  return {
    kind,
    path,
    sha256: createHash("sha256").update(stored.bytes).digest("hex"),
    bytes: stored.bytes.length,
    mediaType,
  };
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

export function serializedWallDurationMs(
  startedWallMs: number,
  finishedWallMs: number,
  label = "wall interval",
): number {
  const started = safeInteger(startedWallMs, `${label} start`);
  const finished = safeInteger(finishedWallMs, `${label} finish`);
  if (finished < started) {
    throw new Error(`${label} finish precedes start`);
  }
  return finished - started;
}

export function retainAccountedCaseEvidence(input: {
  artifactRoot: string;
  runId: string;
  result: RunReport["cases"][number];
  observations: ProcessObservationRecord[];
  executedCases: ExecutedCaseEvidence[];
  retentionFailures: Error[];
}): void {
  input.executedCases.push({
    caseId: input.result.caseId,
    observations: input.observations,
  });
  try {
    retainSupervisedCaseEvidence({
      artifactRoot: input.artifactRoot,
      runId: input.runId,
      result: input.result,
      observations: input.observations,
    });
  } catch (caught) {
    const cause = caught instanceof Error ? caught : new Error(String(caught));
    input.retentionFailures.push(new Error(
      `${input.result.caseId} supervised evidence retention failed: ${cause.message}`,
      { cause },
    ));
  }
}

function lifecycleFact(observation: ProcessObservationRecord): LifecycleFact | undefined {
  if (observation.kind !== "process_lifecycle") return undefined;
  const payload = observationObject(observation.payload, `${observation.observationId} lifecycle payload`);
  if (payload.schemaVersion !== "rbp-supervised-process-lifecycle/v2" || payload.phase !== "stopped") {
    return undefined;
  }
  const identity = observationObject(payload.identity, `${observation.observationId} identity`);
  const process = observationObject(payload.process, `${observation.observationId} process`);
  if (
    typeof payload.action !== "string" ||
    (payload.processRole !== "canonical_component" && payload.processRole !== "auxiliary_fixture") ||
    typeof identity.version !== "string" ||
    identity.protocolVersion !== canonicalManifest.spec.version ||
    typeof identity.commitSha !== "string" ||
    typeof identity.treeSha !== "string" ||
    typeof identity.executableSha256 !== "string" ||
    !Number.isSafeInteger(process.pid) ||
    typeof process.startedAt !== "string" ||
    typeof process.readyAt !== "string" ||
    typeof process.stoppedAt !== "string" ||
    process.exitCode !== 0 ||
    !Array.isArray(payload.survivingPids) ||
    !payload.survivingPids.every((pid) => Number.isSafeInteger(pid)) ||
    typeof payload.killEscalated !== "boolean"
  ) {
    throw new Error(`${observation.observationId} has malformed stopped lifecycle evidence`);
  }
  return {
    componentId: observation.componentId,
    action: payload.action,
    processRole: payload.processRole,
    identity: identity as unknown as ComponentIdentity,
    process: process as unknown as ProcessEvidence,
    orphanProcessCount: safeInteger(
      payload.orphanProcessCount,
      `${observation.observationId} orphanProcessCount`,
    ),
    survivingPids: payload.survivingPids.map(Number),
    killEscalated: payload.killEscalated,
  };
}

function bindRepresentativeComponents(
  report: RunReport,
  observations: readonly ProcessObservationRecord[],
): { orphanProcessCount: number } {
  const facts = observations.flatMap((observation) => {
    const fact = lifecycleFact(observation);
    return fact === undefined ? [] : [fact];
  });
  let orphanProcessCount = 0;
  for (const component of report.components) {
    // Restart and bind-probe actions can legitimately add stopped lifecycle
    // records inside a case. Cardinality and representative process identity
    // are anchored only to the one terminal stack cleanup per binding/case.
    const componentFacts = facts.filter(({ componentId, action, processRole }) =>
      componentId === component.id &&
      action === "stop_case_stack" &&
      processRole === "canonical_component");
    if (componentFacts.length !== canonicalManifest.cases.length * 2) {
      throw new Error(
        `${component.id} has ${componentFacts.length} stopped lifecycles; expected ${canonicalManifest.cases.length * 2}`,
      );
    }
    for (const fact of componentFacts) {
      if (
        stableJson(fact.identity) !== stableJson(component.expectedIdentity) ||
        fact.orphanProcessCount !== 0 ||
        fact.survivingPids.length !== 0 ||
        fact.killEscalated
      ) {
        throw new Error(`${component.id} lifecycle identity or cleanup evidence is not clean`);
      }
      orphanProcessCount += fact.orphanProcessCount;
    }
    const representative = componentFacts.at(-1)!;
    component.observedIdentity = structuredClone(representative.identity);
    component.process = structuredClone(representative.process);
  }
  return { orphanProcessCount };
}

function resourceGroups(
  observations: readonly ProcessObservationRecord[],
): Array<{
  atMs: number;
  residentBytes: number;
  openFileDescriptorCount: number;
  journalPendingCount: number;
}> {
  const groups = new Map<string, {
    atMs: number;
    components: Set<ComponentId>;
    residentBytes: number;
    openFileDescriptorCount: number;
    journalPendingCount: number;
  }>();
  for (const observation of observations) {
    if (observation.kind !== "resource_sample") continue;
    const payload = observationObject(observation.payload, `${observation.observationId} resource payload`);
    if (payload.schemaVersion !== "rbp-parent-resource-sample/v1" || typeof payload.stepId !== "string") {
      throw new Error(`${observation.observationId} has an unknown resource sample contract`);
    }
    const key = `${observation.caseId}\u0000${observation.binding}\u0000${payload.stepId}`;
    const entry = groups.get(key) ?? {
      atMs: Date.parse(observation.at),
      components: new Set<ComponentId>(),
      residentBytes: 0,
      openFileDescriptorCount: 0,
      journalPendingCount: 0,
    };
    if (!Number.isFinite(entry.atMs) || entry.components.has(observation.componentId)) {
      throw new Error(`${observation.observationId} duplicates or invalidates a resource sample group`);
    }
    entry.components.add(observation.componentId);
    entry.atMs = Math.max(entry.atMs, Date.parse(observation.at));
    entry.residentBytes += safeInteger(payload.residentBytes, `${observation.observationId} residentBytes`);
    entry.openFileDescriptorCount += safeInteger(
      payload.openFileDescriptorCount,
      `${observation.observationId} openFileDescriptorCount`,
    );
    entry.journalPendingCount += safeInteger(
      payload.journalPendingCount,
      `${observation.observationId} journalPendingCount`,
    );
    groups.set(key, entry);
  }
  return [...groups.values()].map((entry) => {
    if (entry.components.size !== canonicalManifest.requiredComponents.length) {
      throw new Error("resource sample group does not contain the exact canonical component set");
    }
    return {
      atMs: entry.atMs,
      residentBytes: entry.residentBytes,
      openFileDescriptorCount: entry.openFileDescriptorCount,
      journalPendingCount: entry.journalPendingCount,
    };
  }).sort((left, right) => left.atMs - right.atMs);
}

function measuredResourceProfile(
  observations: readonly ProcessObservationRecord[],
  runStartedMs: number,
  orphanProcessCount: number,
): ResourceProfile {
  let previousOffset = -1;
  const samples: ResourceSample[] = resourceGroups(observations).map((entry, index) => {
    const observedOffset = Math.max(0, entry.atMs - runStartedMs);
    // RFC3339 observations have millisecond precision. Preserve deterministic
    // ordering when two adjacent groups share that same timestamp tick.
    const offsetMs = Math.max(observedOffset, previousOffset + 1);
    previousOffset = offsetMs;
    return {
      index,
      offsetMs,
      residentBytes: entry.residentBytes,
      openFileDescriptorCount: entry.openFileDescriptorCount,
      journalPendingCount: entry.journalPendingCount,
    };
  });
  const profile: ResourceProfile = {
    schemaVersion: "rbp-resource-profile/v1",
    samplingMode: "bounded_slope",
    sampleIntervalMs: 250,
    policy: { ...CANONICAL_RESOURCE_POLICY },
    gcConfirmedComponents: [],
    samples,
    evaluation: null,
  };
  profile.evaluation = evaluateResourceSamples(profile, orphanProcessCount);
  return profile;
}

function retainRunArtifacts(report: RunReport, artifactRoot: string): void {
  const store = new SecureEvidenceStore(artifactRoot);
  for (const component of report.components) {
    if (component.observedIdentity === null) {
      throw new Error(`${component.id} cannot retain a component log without observed identity`);
    }
    const record: ComponentLogRecord = {
      schemaVersion: "rbp-component-log/v1",
      runId: report.run.runId,
      componentId: component.id,
      interfaceVersion: component.interfaceVersion,
      identity: structuredClone(component.observedIdentity),
      process: structuredClone(component.process),
    };
    report.artifacts.push(artifact(
      store,
      "component_log",
      applyTemplate(canonicalManifest.retainedEvidence.componentLog, {
        run_id: report.run.runId,
        component_id: component.id,
      }),
      `${JSON.stringify(record)}\n`,
      "application/x-ndjson",
    ));
  }
  const metrics: LeakMetricsDocument = {
    schemaVersion: "rbp-conformance-leaks/v1",
    runId: report.run.runId,
    timing: structuredClone(report.timing),
    leaks: structuredClone(report.leaks),
    resources: structuredClone(report.resources),
  };
  report.artifacts.push(artifact(
    store,
    "leak_metrics",
    applyTemplate(canonicalManifest.retainedEvidence.leakMetrics, { run_id: report.run.runId }),
    stableJson(metrics),
    "application/json",
  ));
  report.artifacts.push(artifact(
    store,
    "junit",
    applyTemplate(canonicalManifest.retainedEvidence.junit, { run_id: report.run.runId }),
    runReportToJUnitXml(report),
    "application/xml",
  ));
}

function markCaseError(
  result: RunReport["cases"][number],
  startedWallMs: number,
  finishedWallMs: number,
  durationMs: number,
  error: Error,
): void {
  result.status = "error";
  result.startedAt = new Date(startedWallMs).toISOString();
  result.finishedAt = new Date(finishedWallMs).toISOString();
  result.durationMs = durationMs;
  result.bindings = result.bindings.map((entry) => ({
    ...entry,
    status: "error",
    durationMs: null,
  }));
  result.assertions = result.assertions.map((assertion) => ({
    ...assertion,
    passed: false,
    actual: false,
    observationIds: [],
    evidenceSha256: null,
    message: "case execution did not reach parent evaluation",
  }));
  result.failure = { code: "supervised_case_error", message: error.message };
}

/**
 * Executes the complete canonical forty-case suite. The function refuses to
 * start unless all 167 parent-owned assertion predicates are present.
 */
export async function executeProductionConformanceRun(
  input: ProductionSuiteRunInput,
): Promise<ProductionSuiteRunResult> {
  assertNoProductionSuiteOverrides(input);
  assertTrustedProductionLaunch(input.repoRoot, "cli-bootstrap");
  const plan = structuredClone(input.plan);
  const repoRoot = input.repoRoot;
  const artifactRoot = input.artifactRoot;
  const seed = input.seed;
  const evaluators = buildCanonicalParentEvaluatorRegistry(PRODUCTION_ORACLES);
  const report = createUnexecutedRunReport(plan);
  const runStartedWallMs = productionWallNowMs();
  const runStartedMonotonicMs = productionMonotonicNowMs();
  report.run = {
    ...report.run,
    status: "running",
    seed,
    startedAt: new Date(runStartedWallMs).toISOString(),
  };
  const executedCases: ExecutedCaseEvidence[] = [];
  const retentionFailures: Error[] = [];
  let caseExecutionFailureCount = 0;
  let firstCaseStartedWallMs: number | undefined;
  let lastCaseFinishedWallMs: number | undefined;
  let firstCaseStartedMonotonicMs: number | undefined;
  let lastCaseFinishedMonotonicMs: number | undefined;

  for (const result of report.cases) {
    const caseStartedWallMs = productionWallNowMs();
    const caseStartedMonotonicMs = productionMonotonicNowMs();
    firstCaseStartedWallMs ??= caseStartedWallMs;
    firstCaseStartedMonotonicMs ??= caseStartedMonotonicMs;
    result.status = "running";
    result.startedAt = new Date(caseStartedWallMs).toISOString();
    try {
      const executions = await PRODUCTION_CASE_EXECUTOR({
        plan,
        repoRoot,
        caseId: result.caseId,
        clockIso: result.startedAt,
      });
      const evaluated = evaluateSupervisedCaseExecutions({
        runId: report.run.runId,
        caseId: result.caseId,
        executions: executions.map(({ binding, evidence, durationMs }) => ({
          binding,
          observations: evidence.observations,
          durationMs,
        })),
        evaluator: evaluators.get(result.caseId)!,
      });
      const caseFinishedWallMs = productionWallNowMs();
      const caseFinishedMonotonicMs = productionMonotonicNowMs();
      result.finishedAt = new Date(caseFinishedWallMs).toISOString();
      result.durationMs = serializedWallDurationMs(
        caseStartedWallMs,
        caseFinishedWallMs,
        `${result.caseId} case`,
      );
      result.status = evaluated.status;
      result.failure = evaluated.failure;
      result.assertions = evaluated.assertions;
      result.bindings = evaluated.bindings;
      retainAccountedCaseEvidence({
        artifactRoot,
        runId: report.run.runId,
        result,
        observations: evaluated.observations,
        executedCases,
        retentionFailures,
      });
      lastCaseFinishedWallMs = caseFinishedWallMs;
      lastCaseFinishedMonotonicMs = caseFinishedMonotonicMs;
    } catch (caught) {
      caseExecutionFailureCount += 1;
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const caseFinishedWallMs = productionWallNowMs();
      const caseFinishedMonotonicMs = productionMonotonicNowMs();
      markCaseError(
        result,
        caseStartedWallMs,
        caseFinishedWallMs,
        serializedWallDurationMs(
          caseStartedWallMs,
          caseFinishedWallMs,
          `${result.caseId} case`,
        ),
        error,
      );
      lastCaseFinishedWallMs = caseFinishedWallMs;
      lastCaseFinishedMonotonicMs = caseFinishedMonotonicMs;
    }
  }

  const allObservations = executedCases.flatMap(({ observations }) => observations);
  let infrastructureFailure: Error | undefined = retentionFailures[0];
  try {
    const cleanup = bindRepresentativeComponents(report, allObservations);
    report.resources = measuredResourceProfile(
      allObservations,
      runStartedWallMs,
      cleanup.orphanProcessCount,
    );
    const evaluation = report.resources.evaluation!;
    report.leaks = {
      openFileDescriptorDelta: evaluation.openFileDescriptorGrowth,
      residentBytesDelta: evaluation.residentGrowthBytes,
      journalPendingDelta: evaluation.journalPendingGrowth,
      orphanProcessCount: evaluation.orphanProcessCount,
    };
  } catch (caught) {
    if (infrastructureFailure === undefined && caseExecutionFailureCount === 0) {
      infrastructureFailure = caught instanceof Error ? caught : new Error(String(caught));
    }
  }

  const runFinishedWallMs = productionWallNowMs();
  const runFinishedMonotonicMs = productionMonotonicNowMs();
  const caseStartWallMs = firstCaseStartedWallMs ?? runStartedWallMs;
  const caseFinishWallMs = lastCaseFinishedWallMs ?? runFinishedWallMs;
  const caseStartMonotonicMs =
    firstCaseStartedMonotonicMs ?? runStartedMonotonicMs;
  const caseFinishMonotonicMs =
    lastCaseFinishedMonotonicMs ?? runFinishedMonotonicMs;
  const suiteDurationForGateMs = Math.floor(
    caseFinishMonotonicMs - caseStartMonotonicMs,
  );
  const suiteDurationMs = serializedWallDurationMs(
    caseStartWallMs,
    caseFinishWallMs,
    "suite",
  );
  report.timing = {
    setupDurationMs: serializedWallDurationMs(
      runStartedWallMs,
      caseStartWallMs,
      "suite setup",
    ),
    suiteDurationMs,
    teardownDurationMs: serializedWallDurationMs(
      caseFinishWallMs,
      runFinishedWallMs,
      "suite teardown",
    ),
  };
  const casesPassed = report.cases.every(({ status }) => status === "passed");
  const resourcesPassed = report.resources.evaluation?.passed === true;
  const durationPassed = suiteDurationForGateMs < MAX_NON_SOAK_SUITE_MS;
  report.run = {
    ...report.run,
    status: infrastructureFailure === undefined && casesPassed && resourcesPassed && durationPassed
      ? "passed"
      : infrastructureFailure === undefined ? "failed" : "error",
    finishedAt: new Date(runFinishedWallMs).toISOString(),
    durationMs: serializedWallDurationMs(
      runStartedWallMs,
      runFinishedWallMs,
      "run",
    ),
    exitCode: infrastructureFailure === undefined && casesPassed && resourcesPassed && durationPassed ? 0 : 1,
  };

  if (infrastructureFailure === undefined) {
    retainRunArtifacts(report, artifactRoot);
  }
  const reportPath = applyTemplate(canonicalManifest.retainedEvidence.runReport, {
    run_id: report.run.runId,
  });
  const structure = validateRunReportStructure(report);
  if (!structure.ok && report.run.status === "passed") {
    throw new Error(`passing production run failed structural validation: ${stableJson(structure.issues)}`);
  }
  if (report.run.status === "passed") {
    assertPassingRunReport(report, {
      expectedCommitSha: plan.source.commitSha,
      expectedTreeSha: plan.source.treeSha,
      artifactRoot,
      verifyArtifactFiles: true,
    });
  }
  new SecureEvidenceStore(artifactRoot).write(reportPath, stableJson(report));
  if (infrastructureFailure !== undefined) {
    throw new Error(`production suite infrastructure failed: ${infrastructureFailure.message}`, {
      cause: infrastructureFailure,
    });
  }
  return { report, reportPath };
}
