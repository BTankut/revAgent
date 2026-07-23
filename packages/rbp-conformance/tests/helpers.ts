import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  aggregateReportToJUnitXml,
  canonicalManifest,
  canonicalManifestIdentity,
  createThreeRunAggregate,
  createUnexecutedRunReport,
  runReportToJUnitXml,
  stableJson,
} from "../src/index.js";
import type {
  AggregateReport,
  AggregateInput,
  ArtifactEvidence,
  ExecutionPlan,
  RunReport,
} from "../src/index.js";
import { evaluateResourceSamples } from "../src/resourceMetrics.js";

const COMMIT_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);

function hashFor(value: number): string {
  return value.toString(16).padStart(64, "0");
}

export function createPlan(sequence: 1 | 2 | 3 = 1): ExecutionPlan {
  return {
    schemaVersion: "rbp-conformance-execution-plan/v1",
    manifest: { ...canonicalManifestIdentity },
    runId: `run-${sequence}`,
    sequence,
    source: {
      repository: "revAgent",
      commitSha: COMMIT_SHA,
      treeSha: TREE_SHA,
      dirty: false,
    },
    components: canonicalManifest.requiredComponents.map((component, index) => ({
      ...component,
      expectedIdentity: {
        version: `1.0.${index}`,
        protocolVersion: canonicalManifest.spec.version,
        commitSha: COMMIT_SHA,
        treeSha: TREE_SHA,
        executableSha256: hashFor(index + 1),
      },
      command: {
        executable: "node",
        args: [`${component.id}.js`],
        workingDirectory: `packages/${component.id}`,
        environmentKeys: ["RBP_TEST_PORT"],
        readiness: {
          kind: "stdout_pattern",
          value: "READY",
          timeoutMs: 10000,
        },
        shutdown: {
          signal: "SIGTERM",
          timeoutMs: 5000,
        },
      },
    })),
  };
}

export function createCurrentProductionPlan(
  repoRoot: string,
  runId: string,
  sequence: 1 | 2 | 3 = 1,
): ExecutionPlan {
  const configuredRepoRoot = process.env.RBP_TEST_REPO_ROOT;
  const planFile = process.env.RBP_TEST_PRODUCTION_PLAN;
  if (
    configuredRepoRoot === undefined ||
    path.resolve(configuredRepoRoot) !== path.resolve(repoRoot) ||
    planFile === undefined
  ) {
    throw new Error(
      "canonical production test plan was not prepared by Vitest global setup",
    );
  }
  const plan = JSON.parse(readFileSync(planFile, "utf8")) as ExecutionPlan;
  plan.runId = runId;
  plan.sequence = sequence;
  return plan;
}

export function artifact(kind: ArtifactEvidence["kind"], path: string, hashSeed: number): ArtifactEvidence {
  const mediaTypes: Partial<Record<ArtifactEvidence["kind"], string>> = {
    wire_trace: "application/x-ndjson",
    component_log: "application/x-ndjson",
    journal_snapshot: "application/json",
    case_evidence: "application/json",
    leak_metrics: "application/json",
    junit: "application/xml",
    aggregate_junit: "application/xml",
  };
  return {
    kind,
    path,
    sha256: hashFor(hashSeed),
    bytes: 100 + hashSeed,
    mediaType: mediaTypes[kind] ?? "application/json",
  };
}

export function createPassingReport(
  sequence: 1 | 2 | 3 = 1,
  plan?: ExecutionPlan,
): RunReport {
  const report = createUnexecutedRunReport(
    plan === undefined ? createPlan(sequence) : structuredClone(plan),
  );
  const start = new Date(Date.UTC(2026, 6, 22, 10, sequence * 10, 0));
  const finish = new Date(start.getTime() + 1100);
  report.run = {
    ...report.run,
    status: "passed",
    seed: `seed-${sequence}`,
    startedAt: start.toISOString(),
    finishedAt: finish.toISOString(),
    durationMs: 1100,
    exitCode: 0,
  };
  report.components = report.components.map((component, index) => ({
    ...component,
    observedIdentity: { ...component.expectedIdentity },
    process: {
      pid: 1000 + index,
      startedAt: start.toISOString(),
      readyAt: new Date(start.getTime() + 10).toISOString(),
      stoppedAt: finish.toISOString(),
      exitCode: 0,
    },
  }));
  report.cases = report.cases.map((entry, caseIndex) => {
    const evidence = [
      artifact(
        "wire_trace",
        `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/wire/${entry.caseId}-wss.jsonl`,
        1000 + caseIndex * 3,
      ),
      artifact(
        "wire_trace",
        `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/wire/${entry.caseId}-streamable_http_sse.jsonl`,
        1001 + caseIndex * 3,
      ),
      artifact(
        "journal_snapshot",
        `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/journal/${entry.caseId}.json`,
        1002 + caseIndex * 3,
      ),
    ];
    return {
      ...entry,
      status: "passed" as const,
      startedAt: new Date(start.getTime() + 100 + caseIndex * 10).toISOString(),
      finishedAt: new Date(start.getTime() + 110 + caseIndex * 10).toISOString(),
      durationMs: 10,
      bindings: entry.bindings.map((binding) => ({ ...binding, status: "passed" as const, durationMs: 5 })),
      assertions: entry.assertions.map((assertion, assertionIndex) => ({
        ...assertion,
        passed: true,
        expected: true,
        actual: true,
        observationIds: [`${entry.caseId}-observation-${assertionIndex + 1}`],
        evidenceSha256: evidence[0]!.sha256,
        message: null,
      })),
      artifacts: evidence,
      failure: null,
    };
  });
  report.timing = { suiteDurationMs: 1000, setupDurationMs: 50, teardownDurationMs: 50 };
  report.resources.samples = Array.from({ length: 8 }, (_, index) => ({
    index,
    offsetMs: index * 250,
    residentBytes: 100_000_000 + index * 1024,
    openFileDescriptorCount: 12,
    journalPendingCount: 0,
  }));
  report.resources.evaluation = evaluateResourceSamples(report.resources, 0);
  report.leaks = {
    openFileDescriptorDelta: report.resources.evaluation.openFileDescriptorGrowth,
    residentBytesDelta: report.resources.evaluation.residentGrowthBytes,
    journalPendingDelta: report.resources.evaluation.journalPendingGrowth,
    orphanProcessCount: report.resources.evaluation.orphanProcessCount,
  };
  report.artifacts = [
    ...report.components.map((component, index) =>
      artifact(
        "component_log",
        `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/components/${component.id}.log`,
        2000 + index,
      ),
    ),
    artifact("junit", `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/junit.xml`, 2010),
    artifact("leak_metrics", `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/metrics/leaks.json`, 2011),
  ];
  return report;
}

export function aggregateInputs(): AggregateInput[] {
  return ([1, 2, 3] as const).map((sequence) => ({
    report: createPassingReport(sequence),
    reportPath: `${canonicalManifest.retainedEvidence.root}/runs/run-${sequence}/run-report.json`,
    reportSha256: hashFor(3000 + sequence),
  }));
}

export function aggregateJunitArtifact(): ArtifactEvidence {
  return artifact(
    "aggregate_junit",
    `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateJunit}`,
    4000,
  );
}

function writeEvidence(root: string, artifactValue: ArtifactEvidence, content: string): void {
  const bytes = Buffer.from(content, "utf8");
  artifactValue.bytes = bytes.length;
  artifactValue.sha256 = createHash("sha256").update(bytes).digest("hex");
  const target = path.join(root, artifactValue.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

export function materializeRunEvidence(report: RunReport, root: string): RunReport {
  for (const result of report.cases) {
    for (const artifactValue of result.artifacts) {
      if (artifactValue.kind === "wire_trace") {
        const binding = artifactValue.path.endsWith("-wss.jsonl") ? "wss" : "streamable_http_sse";
        const bindingResult = result.bindings.find((entry) => entry.binding === binding)!;
        const record = {
          schemaVersion: "rbp-wire-trace/v1",
          runId: report.run.runId,
          caseId: result.caseId,
          binding,
          event: "case_complete",
          at: result.finishedAt,
          status: bindingResult.status,
          assertions: [],
        };
        writeEvidence(root, artifactValue, `${JSON.stringify(record)}\n`);
      }
    }
    const journal = result.artifacts.find(({ kind }) => kind === "journal_snapshot")!;
    const journalContent = stableJson({
      schemaVersion: "rbp-case-evidence/v1",
      runId: report.run.runId,
      caseId: result.caseId,
      source: "journal_snapshot",
      observations: result.assertions.map((assertion, assertionIndex) => ({
        schemaVersion: "rbp-process-observation/v1",
        observationId: assertion.observationIds[0],
        runId: report.run.runId,
        caseId: result.caseId,
        binding: "wss",
        componentId: "bridge_simulator",
        kind: "bridge_snapshot",
        at: result.finishedAt,
        payload: { assertionIndex },
      })),
      assertions: result.assertions.map(({ assertionId, subvectorId, statement, category, passed, expected, actual }) => ({
        assertionId,
        subvectorId,
        statement,
        category,
        passed,
        expected,
        actual,
        observationIds: result.assertions.find((entry) => entry.assertionId === assertionId)!.observationIds,
      })),
    });
    writeEvidence(root, journal, journalContent);
    result.assertions.forEach((assertion) => {
      assertion.evidenceSha256 = journal.sha256;
    });
  }

  report.components.forEach((component) => {
    const log = report.artifacts.find(({ kind, path: artifactPath }) => kind === "component_log" && artifactPath.endsWith(`/${component.id}.log`))!;
    writeEvidence(
      root,
      log,
      `${JSON.stringify({
        schemaVersion: "rbp-component-log/v1",
        runId: report.run.runId,
        componentId: component.id,
        interfaceVersion: component.interfaceVersion,
        identity: component.observedIdentity,
        process: component.process,
      })}\n`,
    );
  });
  const leaks = report.artifacts.find(({ kind }) => kind === "leak_metrics")!;
  writeEvidence(
    root,
    leaks,
    stableJson({ schemaVersion: "rbp-conformance-leaks/v1", runId: report.run.runId, timing: report.timing, leaks: report.leaks, resources: report.resources }),
  );
  const junit = report.artifacts.find(({ kind }) => kind === "junit")!;
  writeEvidence(root, junit, runReportToJUnitXml(report));
  return report;
}

export function materializePassingRunInputs(
  root: string,
  plans?: readonly [ExecutionPlan, ExecutionPlan, ExecutionPlan],
): AggregateInput[] {
  return ([1, 2, 3] as const).map((sequence) => {
    const report = materializeRunEvidence(
      createPassingReport(sequence, plans?.[sequence - 1]),
      root,
    );
    const reportPath = `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/run-report.json`;
    const contents = stableJson(report);
    const target = path.join(root, reportPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
    return {
      report,
      reportPath,
      reportSha256: createHash("sha256").update(contents, "utf8").digest("hex"),
    };
  });
}

export function materializePassingAggregate(root: string): { aggregate: AggregateReport; inputs: AggregateInput[] } {
  const inputs = materializePassingRunInputs(root);
  const aggregateArtifact = aggregateJunitArtifact();
  const aggregate = createThreeRunAggregate(inputs, [aggregateArtifact]);
  writeEvidence(root, aggregateArtifact, aggregateReportToJUnitXml(aggregate));
  return { aggregate, inputs };
}

export function rewriteArtifact(root: string, artifactValue: ArtifactEvidence, content: string): void {
  writeEvidence(root, artifactValue, content);
}
