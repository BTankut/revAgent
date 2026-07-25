import { canonicalManifest } from "./manifest.js";
import { classifyRunStatus } from "./runClassification.js";
import { stableJson } from "./stableJson.js";
import type { AggregateInput, AggregateReport, ArtifactEvidence, RunReport } from "./types.js";
import { validateRunReportStructure } from "./validator.js";

function componentFingerprint(report: RunReport): string {
  return stableJson(
    report.components.map(({ id, interfaceVersion, expectedIdentity, observedIdentity }) => ({
      id,
      interfaceVersion,
      expectedIdentity,
      observedIdentity,
    })),
  );
}

function areConsecutive(inputs: AggregateInput[]): boolean {
  if (inputs.some(({ report }, index) => report.run.sequence !== index + 1)) {
    return false;
  }
  if (new Set(inputs.map(({ report }) => report.run.runId)).size !== 3) {
    return false;
  }
  const source = stableJson(inputs[0]?.report.source);
  const components = componentFingerprint(inputs[0]?.report);
  if (inputs.some(({ report }) => stableJson(report.source) !== source || componentFingerprint(report) !== components)) {
    return false;
  }
  for (let index = 1; index < inputs.length; index += 1) {
    const previousFinished = inputs[index - 1]?.report.run.finishedAt;
    const currentStarted = inputs[index]?.report.run.startedAt;
    if (previousFinished === null || previousFinished === undefined || currentStarted === null || currentStarted === undefined) {
      return false;
    }
    if (Date.parse(previousFinished) >= Date.parse(currentStarted)) {
      return false;
    }
  }
  return true;
}

export function createThreeRunAggregate(inputsValue: AggregateInput[], artifacts: ArtifactEvidence[] = []): AggregateReport {
  if (inputsValue.length !== 3) {
    throw new Error(`Exactly three run reports are required; received ${inputsValue.length}`);
  }
  const inputs = [...inputsValue].sort((left, right) => left.report.run.sequence - right.report.run.sequence);
  for (const [index, input] of inputs.entries()) {
    const validation = validateRunReportStructure(input.report);
    if (!validation.ok) {
      throw new Error(`Run input ${index + 1} is invalid: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    }
  }

  const consecutive = areConsecutive(inputs);
  const classifications = inputs.map(({ report }) => classifyRunStatus(report.run.status));
  const passingRuns = classifications.filter((classification) => classification === "passed").length;
  const incompleteRuns = classifications.filter((classification) => classification === "incomplete").length;
  const failedRuns = 3 - passingRuns - incompleteRuns;
  const allPassing = passingRuns === 3 && consecutive;
  const finishedTimes = inputs
    .map(({ report }) => report.run.finishedAt)
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  return {
    schemaVersion: "rbp-conformance-aggregate/v1",
    manifest: { ...inputs[0]!.report.manifest },
    reportPath: `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateReport}`,
    generatedAt: finishedTimes.at(-1) ?? "1970-01-01T00:00:00.000Z",
    source: { ...inputs[0]!.report.source },
    status: allPassing ? "passed" : incompleteRuns > 0 ? "incomplete" : "failed",
    consecutive,
    runs: inputs.map(({ report, reportPath, reportSha256 }) => ({
      runId: report.run.runId,
      sequence: report.run.sequence,
      status: report.run.status,
      startedAt: report.run.startedAt,
      finishedAt: report.run.finishedAt,
      durationMs: report.run.durationMs,
      manifest: { ...report.manifest },
      source: { ...report.source },
      components: report.components.map((component) => ({
        id: component.id,
        interfaceVersion: component.interfaceVersion,
        identity: component.observedIdentity === null ? null : { ...component.observedIdentity },
      })),
      bindings: ["wss", "streamable_http_sse"],
      reportPath,
      reportSha256,
    })),
    summary: {
      requiredRuns: 3,
      passingRuns,
      failedRuns,
      incompleteRuns,
      totalDurationMs: inputs.reduce((sum, { report }) => sum + (report.run.durationMs ?? 0), 0),
    },
    cases: canonicalManifest.cases.map((manifestCase, index) => {
      const runStatuses = inputs.map(({ report }) => report.cases[index]!.status);
      return {
        caseId: manifestCase.id,
        title: manifestCase.title,
        runStatuses,
        passedAllRuns: runStatuses.every((status) => status === "passed"),
      };
    }),
    artifacts: [...artifacts],
  };
}

export function renderAggregateSummary(report: AggregateReport): string {
  const lines = [
    "# RBP/1 section 21 three-run conformance summary",
    "",
    `- Status: ${report.status}`,
    `- Consecutive: ${String(report.consecutive)}`,
    `- Manifest: ${report.manifest.id}@${report.manifest.version} (${report.manifest.sha256})`,
    `- Spec: ${report.manifest.specVersion}`,
    `- Source: ${report.source.commitSha} / ${report.source.treeSha}`,
    `- Runs: ${report.summary.passingRuns} passed, ${report.summary.failedRuns} failed, ${report.summary.incompleteRuns} incomplete`,
    `- Total duration: ${report.summary.totalDurationMs} ms`,
    "",
    "| Case | Run 1 | Run 2 | Run 3 | All passed |",
    "|---|---|---|---|---|",
    ...report.cases.map(
      (entry) => `| ${entry.caseId} ${entry.title.replaceAll("|", "\\|")} | ${entry.runStatuses[0]} | ${entry.runStatuses[1]} | ${entry.runStatuses[2]} | ${entry.passedAllRuns ? "yes" : "no"} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
