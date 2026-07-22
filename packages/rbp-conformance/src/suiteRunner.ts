import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runReportToJUnitXml } from "./junit.js";
import { canonicalManifest } from "./manifest.js";
import { CaseObservationLedger, type AssertionMeasurement } from "./observationLedger.js";
import { CANONICAL_RESOURCE_POLICY, evaluateResourceSamples } from "./resourceMetrics.js";
import { createUnexecutedRunReport } from "./scaffold.js";
import { stableJson } from "./stableJson.js";
import type {
  ArtifactEvidence,
  Binding,
  ComponentEvidence,
  ExecutionPlan,
  ProcessObservationRecord,
  ResourceSample,
  RunReport,
} from "./types.js";

export interface BindingExecutionEvidence {
  observations: ProcessObservationRecord[];
  measurements: AssertionMeasurement[];
}

export interface CaseExecutionSupport {
  supported: boolean;
  reason?: string;
}

export interface LiveConformanceStack {
  components: ComponentEvidence[];
  caseSupport(caseId: string, binding: Binding): CaseExecutionSupport;
  executeBinding(caseId: string, binding: Binding): Promise<BindingExecutionEvidence>;
  sampleResources(): Promise<Omit<ResourceSample, "index" | "offsetMs">>;
  stop(): Promise<{ orphanProcessCount: number }>;
}

export interface ThreeProcessSuiteDriver {
  start(plan: ExecutionPlan, artifactRoot: string): Promise<LiveConformanceStack>;
}

function retained(relative: string): string {
  return `${canonicalManifest.retainedEvidence.root}/${relative}`;
}

function writeArtifact(
  artifactRoot: string,
  kind: ArtifactEvidence["kind"],
  relativePath: string,
  contents: string | Buffer,
  mediaType: string,
): ArtifactEvidence {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const target = path.resolve(artifactRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return {
    kind,
    path: relativePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    mediaType,
  };
}

function assertionRecord(assertion: RunReport["cases"][number]["assertions"][number]) {
  return {
    assertionId: assertion.assertionId,
    subvectorId: assertion.subvectorId,
    statement: assertion.statement,
    category: assertion.category,
    passed: assertion.passed === true,
    expected: assertion.expected,
    actual: assertion.actual,
    observationIds: assertion.observationIds,
  };
}

function combineMeasurements(
  caseId: string,
  bindingEvidence: readonly BindingExecutionEvidence[],
): AssertionMeasurement[] {
  return canonicalManifest.requiredAssertions[caseId]!.map((assertion) => {
    const contributions = bindingEvidence.flatMap(({ measurements }) =>
      measurements.filter(({ assertionId }) => assertionId === assertion.id));
    const actual = contributions.length === bindingEvidence.length &&
      contributions.every((entry) => stableJson(entry.actual) === stableJson(assertion.expected));
    return {
      assertionId: assertion.id,
      actual,
      observationIds: [...new Set(contributions.flatMap(({ observationIds }) => observationIds))],
      message: contributions.length === bindingEvidence.length
        ? undefined
        : `received ${contributions.length} binding measurements; expected ${bindingEvidence.length}`,
    };
  });
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function executeConformanceRun(input: {
  plan: ExecutionPlan;
  artifactRoot: string;
  driver: ThreeProcessSuiteDriver;
  seed: string;
}): Promise<{ report: RunReport; reportPath: string }> {
  const report = createUnexecutedRunReport(input.plan);
  const runStartedMs = Date.now();
  report.run = {
    ...report.run,
    status: "running",
    seed: input.seed,
    startedAt: new Date(runStartedMs).toISOString(),
  };
  const setupStartedMs = Date.now();
  const stack = await input.driver.start(input.plan, input.artifactRoot);
  const setupFinishedMs = Date.now();
  let stopAttempted = false;
  let runError: unknown;
  const stopStack = async (): Promise<{ orphanProcessCount: number }> => {
    stopAttempted = true;
    return await stack.stop();
  };
  try {
  if (stack.components.map(({ id }) => id).join("|") !== input.plan.components.map(({ id }) => id).join("|")) {
    throw new Error("suite driver did not start the exact canonical three-process stack");
  }
  for (const [index, component] of stack.components.entries()) {
    if (stableJson(component.expectedIdentity) !== stableJson(input.plan.components[index]!.expectedIdentity) ||
      stableJson(component.observedIdentity) !== stableJson(input.plan.components[index]!.expectedIdentity) ||
      component.process.pid === null || component.process.readyAt === null) {
      throw new Error(`suite driver component ${component.id} lacks exact executable/source/readiness identity`);
    }
  }
  report.components = stack.components;
  const resourceSamples: ResourceSample[] = [];
  const suiteStartedMs = Date.now();

  for (const [caseIndex, manifestCase] of canonicalManifest.cases.entries()) {
    const result = report.cases[caseIndex]!;
    const caseStartedMs = Date.now();
    result.startedAt = new Date(caseStartedMs).toISOString();
    result.status = "running";
    const ledger = new CaseObservationLedger(report.run.runId, manifestCase.id);
    const bindingEvidence: BindingExecutionEvidence[] = [];
    let failure: Error | undefined;
    let unsupportedReason: string | undefined;
    for (const [bindingIndex, binding] of manifestCase.bindings.entries()) {
      const bindingStartedMs = Date.now();
      let support: CaseExecutionSupport;
      try {
        support = stack.caseSupport(manifestCase.id, binding);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        result.bindings[bindingIndex] = {
          binding,
          status: "error",
          durationMs: Date.now() - bindingStartedMs,
        };
        break;
      }
      if (support.supported !== true) {
        unsupportedReason = support.reason?.trim() || `suite driver does not support ${manifestCase.id}/${binding}`;
        result.bindings[bindingIndex] = {
          binding,
          status: "not_run",
          durationMs: Date.now() - bindingStartedMs,
        };
        break;
      }
      try {
        const evidence = await stack.executeBinding(manifestCase.id, binding);
        evidence.observations.forEach((observation) => ledger.add(observation));
        bindingEvidence.push(evidence);
        result.bindings[bindingIndex] = {
          binding,
          status: "passed",
          durationMs: Date.now() - bindingStartedMs,
        };
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        result.bindings[bindingIndex] = {
          binding,
          status: "error",
          durationMs: Date.now() - bindingStartedMs,
        };
        break;
      }
    }
    result.assertions = ledger.evaluate(combineMeasurements(manifestCase.id, bindingEvidence));
    const caseFinishedMs = Date.now();
    result.finishedAt = new Date(caseFinishedMs).toISOString();
    result.durationMs = caseFinishedMs - caseStartedMs;
    result.status = unsupportedReason === undefined && failure === undefined && result.bindings.every(({ status }) => status === "passed") &&
      result.assertions.every(({ passed }) => passed === true) ? "passed" : failure === undefined ? "failed" : "error";
    result.failure = result.status === "passed" ? null : {
      code: unsupportedReason !== undefined ? "unsupported_case" : failure === undefined ? "assertion_failed" : "case_driver_error",
      message: unsupportedReason ?? failure?.message ?? "one or more runner-computed assertions did not meet canonical semantics",
    };

    for (const binding of manifestCase.bindings) {
      const observations = ledger.records().filter((record) => record.binding === binding);
      const rows = observations.length === 0
        ? [{
            schemaVersion: "rbp-wire-trace/v1",
            runId: report.run.runId,
            caseId: manifestCase.id,
            binding,
            event: "no_process_observation",
            at: result.finishedAt,
            status: result.status,
            assertions: [],
          }]
        : observations.map((observation) => ({
            schemaVersion: "rbp-wire-trace/v1",
            runId: report.run.runId,
            caseId: manifestCase.id,
            binding,
            event: observation.observationId,
            at: observation.at,
            status: result.status,
            assertions: [],
          }));
      result.artifacts.push(writeArtifact(
        input.artifactRoot,
        "wire_trace",
        retained(`runs/${report.run.runId}/wire/${manifestCase.id}-${binding}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        "application/x-ndjson",
      ));
    }
    const journalContents = stableJson({
      schemaVersion: "rbp-case-evidence/v1",
      runId: report.run.runId,
      caseId: manifestCase.id,
      source: "journal_snapshot",
      observations: ledger.records(),
      assertions: result.assertions.map(assertionRecord),
    });
    const journal = writeArtifact(
      input.artifactRoot,
      "journal_snapshot",
      retained(`runs/${report.run.runId}/journal/${manifestCase.id}.json`),
      journalContents,
      "application/json",
    );
    result.artifacts.push(journal);
    result.assertions.forEach((assertion) => { assertion.evidenceSha256 = journal.sha256; });

    if (caseIndex % 5 === 4) {
      const sample = await stack.sampleResources();
      const offsetMs = Date.now() - runStartedMs;
      if (resourceSamples.length === 0 || offsetMs > resourceSamples.at(-1)!.offsetMs) {
        resourceSamples.push({ index: resourceSamples.length, offsetMs, ...sample });
      }
    }
  }
  const suiteFinishedMs = Date.now();
  while (resourceSamples.length < CANONICAL_RESOURCE_POLICY.warmupSamples + CANONICAL_RESOURCE_POLICY.minimumMeasuredSamples) {
    await wait(250);
    const sample = await stack.sampleResources();
    resourceSamples.push({ index: resourceSamples.length, offsetMs: Date.now() - runStartedMs, ...sample });
  }
  const teardownStartedMs = Date.now();
  const stopped = await stopStack();
  const teardownFinishedMs = Date.now();
  report.resources = {
    schemaVersion: "rbp-resource-profile/v1",
    samplingMode: "bounded_slope",
    sampleIntervalMs: 250,
    policy: { ...CANONICAL_RESOURCE_POLICY },
    gcConfirmedComponents: [],
    samples: resourceSamples,
    evaluation: null,
  };
  report.resources.evaluation = evaluateResourceSamples(report.resources, stopped.orphanProcessCount);
  report.leaks = {
    openFileDescriptorDelta: report.resources.evaluation.openFileDescriptorGrowth,
    residentBytesDelta: report.resources.evaluation.residentGrowthBytes,
    journalPendingDelta: report.resources.evaluation.journalPendingGrowth,
    orphanProcessCount: report.resources.evaluation.orphanProcessCount,
  };
  report.timing = {
    setupDurationMs: setupFinishedMs - setupStartedMs,
    suiteDurationMs: suiteFinishedMs - suiteStartedMs,
    teardownDurationMs: teardownFinishedMs - teardownStartedMs,
  };
  const runFinishedMs = Date.now();
  report.run.finishedAt = new Date(runFinishedMs).toISOString();
  report.run.durationMs = runFinishedMs - runStartedMs;
  report.run.status = report.cases.every(({ status }) => status === "passed") && report.resources.evaluation.passed ? "passed" : "failed";
  report.run.exitCode = report.run.status === "passed" ? 0 : 1;

  for (const component of report.components) {
    report.artifacts.push(writeArtifact(
      input.artifactRoot,
      "component_log",
      retained(`runs/${report.run.runId}/components/${component.id}.log`),
      `${JSON.stringify({
        schemaVersion: "rbp-component-log/v1",
        runId: report.run.runId,
        componentId: component.id,
        interfaceVersion: component.interfaceVersion,
        identity: component.observedIdentity,
        process: component.process,
      })}\n`,
      "application/x-ndjson",
    ));
  }
  report.artifacts.push(writeArtifact(
    input.artifactRoot,
    "leak_metrics",
    retained(`runs/${report.run.runId}/metrics/leaks.json`),
    stableJson({
      schemaVersion: "rbp-conformance-leaks/v1",
      runId: report.run.runId,
      timing: report.timing,
      leaks: report.leaks,
      resources: report.resources,
    }),
    "application/json",
  ));
  report.artifacts.push(writeArtifact(
    input.artifactRoot,
    "junit",
    retained(`runs/${report.run.runId}/junit.xml`),
    runReportToJUnitXml(report),
    "application/xml",
  ));
  const reportPath = retained(`runs/${report.run.runId}/run-report.json`);
  const reportTarget = path.resolve(input.artifactRoot, reportPath);
  mkdirSync(path.dirname(reportTarget), { recursive: true });
  writeFileSync(reportTarget, stableJson(report), "utf8");
  return { report, reportPath };
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    if (!stopAttempted) {
      try {
        await stopStack();
      } catch (cleanupError) {
        if (runError === undefined) throw cleanupError;
      }
    }
  }
}
