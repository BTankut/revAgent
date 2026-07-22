import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { aggregateReportToJUnitXml, runReportToJUnitXml } from "./junit.js";
import { canonicalManifest } from "./manifest.js";
import { stableJson } from "./stableJson.js";
import type {
  AggregateReport,
  ArtifactEvidence,
  AssertionResult,
  CaseResult,
  ComponentLogRecord,
  EvidenceAssertionRecord,
  LeakMetricsDocument,
  ProcessObservationRecord,
  RunReport,
  ValidationIssue,
} from "./types.js";

interface LoadedFile {
  bytes: Buffer;
  text: string;
  realPath: string;
}

interface LoadResult {
  file?: LoadedFile;
  issues: ValidationIssue[];
}

interface ParsedCaseEvidence {
  artifact: ArtifactEvidence;
  assertions: EvidenceAssertionRecord[];
  observationIds: Set<string>;
}

const NONEMPTY_KINDS = new Set<ArtifactEvidence["kind"]>([
  "wire_trace",
  "journal_snapshot",
  "junit",
  "leak_metrics",
  "component_log",
  "case_evidence",
  "aggregate_junit",
]);

const MEDIA_TYPES: Partial<Record<ArtifactEvidence["kind"], string>> = {
  wire_trace: "application/x-ndjson",
  component_log: "application/x-ndjson",
  journal_snapshot: "application/json",
  case_evidence: "application/json",
  leak_metrics: "application/json",
  junit: "application/xml",
  aggregate_junit: "application/xml",
};

function push(issues: ValidationIssue[], pathValue: string, code: string, message: string): void {
  issues.push({ path: pathValue, code, message });
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function loadConfinedEvidenceFile(
  relativePath: string,
  artifactRoot: string,
  expectedSha256: string,
  expectedBytes: number | undefined,
  issuePath: string,
): LoadResult {
  const issues: ValidationIssue[] = [];
  const normalizedPrefix = `${canonicalManifest.retainedEvidence.root}/`;
  if (!relativePath.startsWith(normalizedPrefix)) {
    push(issues, issuePath, "artifact.outside_retained_root", `path must remain below ${canonicalManifest.retainedEvidence.root}`);
    return { issues };
  }

  try {
    const lexicalRoot = path.resolve(artifactRoot);
    const lexicalRetainedRoot = path.resolve(lexicalRoot, canonicalManifest.retainedEvidence.root);
    const lexicalCandidate = path.resolve(lexicalRoot, relativePath);
    if (!isInside(lexicalRetainedRoot, lexicalCandidate)) {
      push(issues, issuePath, "artifact.outside_retained_root", "lexical artifact path escapes the retained root");
      return { issues };
    }

    const realArtifactRoot = realpathSync(lexicalRoot);
    const realRetainedRoot = realpathSync(lexicalRetainedRoot);
    if (!isInside(realArtifactRoot, realRetainedRoot)) {
      push(issues, issuePath, "artifact.reparse_escape", "retained evidence root resolves outside artifactRoot");
      return { issues };
    }
    const realCandidate = realpathSync(lexicalCandidate);
    if (!isInside(realRetainedRoot, realCandidate)) {
      push(issues, issuePath, "artifact.reparse_escape", "artifact resolves outside the retained evidence root through a symlink, junction, or reparse point");
      return { issues };
    }
    if (!statSync(realCandidate).isFile()) {
      push(issues, issuePath, "artifact.not_file", "retained artifact is not a regular file");
      return { issues };
    }

    const bytes = readFileSync(realCandidate);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
      push(issues, issuePath, "artifact.size_mismatch", `retained file has ${bytes.length} bytes; report declares ${expectedBytes}`);
    }
    if (digest !== expectedSha256) {
      push(issues, issuePath, "artifact.hash_mismatch", "retained file digest does not match report");
    }
    return { file: { bytes, text: bytes.toString("utf8"), realPath: realCandidate }, issues };
  } catch (error) {
    push(issues, issuePath, "artifact.missing", error instanceof Error ? error.message : "artifact could not be read");
    return { issues };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function parseJson(text: string, issuePath: string, issues: ValidationIssue[]): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    push(issues, issuePath, "artifact.invalid_json", error instanceof Error ? error.message : "invalid JSON");
    return undefined;
  }
}

function parseJsonLines(text: string, issuePath: string, issues: ValidationIssue[]): unknown[] {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    push(issues, issuePath, "artifact.empty_jsonl", "JSON Lines artifact must contain at least one record");
    return [];
  }
  return lines.flatMap((line, index) => {
    const parsed = parseJson(line, `${issuePath}/line/${index + 1}`, issues);
    return parsed === undefined ? [] : [parsed];
  });
}

function parseEvidenceAssertions(value: unknown, issuePath: string, issues: ValidationIssue[]): EvidenceAssertionRecord[] {
  if (!Array.isArray(value)) {
    push(issues, issuePath, "artifact.assertions", "assertions must be an array");
    return [];
  }
  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || !exactKeys(entry, ["assertionId", "subvectorId", "statement", "category", "passed", "expected", "actual", "observationIds"])) {
      push(issues, `${issuePath}/${index}`, "artifact.assertion_shape", "evidence assertion has unknown or missing fields");
      return [];
    }
    if (
      typeof entry.assertionId !== "string" ||
      typeof entry.subvectorId !== "string" ||
      typeof entry.statement !== "string" ||
      typeof entry.category !== "string" ||
      entry.passed !== true ||
      !Array.isArray(entry.observationIds) ||
      entry.observationIds.length < 1 ||
      !entry.observationIds.every((id) => typeof id === "string") ||
      new Set(entry.observationIds).size !== entry.observationIds.length
    ) {
      push(issues, `${issuePath}/${index}`, "artifact.assertion_value", "evidence assertion requires canonical identity/statement/category fields and passed=true");
      return [];
    }
    return [entry as unknown as EvidenceAssertionRecord];
  });
}

function parseObservations(
  value: unknown,
  report: RunReport,
  result: CaseResult,
  issuePath: string,
  issues: ValidationIssue[],
): ProcessObservationRecord[] {
  if (!Array.isArray(value)) {
    push(issues, issuePath, "artifact.observations", "observations must be an array");
    return [];
  }
  const observations = value.flatMap((entry, index) => {
    const rowPath = `${issuePath}/${index}`;
    if (!isRecord(entry) || !exactKeys(entry, ["schemaVersion", "observationId", "runId", "caseId", "binding", "componentId", "kind", "at", "payload"])) {
      push(issues, rowPath, "artifact.observation_shape", "process observation has unknown or missing fields");
      return [];
    }
    if (
      entry.schemaVersion !== "rbp-process-observation/v1" ||
      typeof entry.observationId !== "string" ||
      entry.runId !== report.run.runId ||
      entry.caseId !== result.caseId ||
      entry.binding !== "wss" && entry.binding !== "streamable_http_sse" ||
      !["gateway_stub", "bridge_simulator", "addin_loopback_fixture"].includes(String(entry.componentId)) ||
      !["control_result", "wire_event", "gateway_snapshot", "bridge_snapshot", "fixture_snapshot", "fixture_execution_count", "resource_sample"].includes(String(entry.kind)) ||
      typeof entry.at !== "string" || Number.isNaN(Date.parse(entry.at))
    ) {
      push(issues, rowPath, "artifact.observation_identity", "process observation identity is not bound to this run/case/stack");
      return [];
    }
    const at = Date.parse(entry.at);
    const started = result.startedAt === null ? Number.NaN : Date.parse(result.startedAt);
    const finished = result.finishedAt === null ? Number.NaN : Date.parse(result.finishedAt);
    if (!Number.isNaN(started) && !Number.isNaN(finished) && (at < started || at > finished)) {
      push(issues, `${rowPath}/at`, "artifact.observation_time", "process observation falls outside its case interval");
    }
    return [entry as unknown as ProcessObservationRecord];
  });
  if (new Set(observations.map(({ observationId }) => observationId)).size !== observations.length) {
    push(issues, issuePath, "artifact.duplicate_observation", "process observation ids must be unique within one evidence document");
  }
  return observations;
}

function parseCaseEvidenceDocument(
  artifact: ArtifactEvidence,
  file: LoadedFile,
  report: RunReport,
  result: CaseResult,
  issuePath: string,
  issues: ValidationIssue[],
): ParsedCaseEvidence | undefined {
  const parsed = parseJson(file.text, issuePath, issues);
  if (!isRecord(parsed) || !exactKeys(parsed, ["schemaVersion", "runId", "caseId", "source", "observations", "assertions"])) {
    push(issues, issuePath, "artifact.case_evidence_shape", "case evidence must use the exact rbp-case-evidence/v1 shape");
    return undefined;
  }
  const expectedSource = artifact.kind === "journal_snapshot" ? "journal_snapshot" : "case_evidence";
  if (
    parsed.schemaVersion !== "rbp-case-evidence/v1" ||
    parsed.runId !== report.run.runId ||
    parsed.caseId !== result.caseId ||
    parsed.source !== expectedSource
  ) {
    push(issues, issuePath, "artifact.case_evidence_identity", "case evidence identity/source does not match its run and case");
  }
  const observations = parseObservations(parsed.observations, report, result, `${issuePath}/observations`, issues);
  return {
    artifact,
    assertions: parseEvidenceAssertions(parsed.assertions, `${issuePath}/assertions`, issues),
    observationIds: new Set(observations.map(({ observationId }) => observationId)),
  };
}

function parseWireTrace(
  artifact: ArtifactEvidence,
  file: LoadedFile,
  report: RunReport,
  result: CaseResult,
  binding: string,
  issuePath: string,
  issues: ValidationIssue[],
): ParsedCaseEvidence {
  const assertions: EvidenceAssertionRecord[] = [];
  for (const [index, parsed] of parseJsonLines(file.text, issuePath, issues).entries()) {
    const rowPath = `${issuePath}/line/${index + 1}`;
    if (!isRecord(parsed) || !exactKeys(parsed, ["schemaVersion", "runId", "caseId", "binding", "event", "at", "status", "assertions"])) {
      push(issues, rowPath, "artifact.wire_shape", "wire record must use the exact rbp-wire-trace/v1 shape");
      continue;
    }
    if (
      parsed.schemaVersion !== "rbp-wire-trace/v1" ||
      parsed.runId !== report.run.runId ||
      parsed.caseId !== result.caseId ||
      parsed.binding !== binding ||
      parsed.status !== result.status ||
      typeof parsed.event !== "string" ||
      typeof parsed.at !== "string" ||
      Number.isNaN(Date.parse(parsed.at))
    ) {
      push(issues, rowPath, "artifact.wire_identity", "wire record identity, status, event, or timestamp does not match its case/binding");
    }
    const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    const caseStart = result.startedAt === null ? Number.NaN : Date.parse(result.startedAt);
    const caseFinish = result.finishedAt === null ? Number.NaN : Date.parse(result.finishedAt);
    if (!Number.isNaN(at) && !Number.isNaN(caseStart) && !Number.isNaN(caseFinish) && (at < caseStart || at > caseFinish)) {
      push(issues, `${rowPath}/at`, "artifact.wire_time", "wire evidence timestamp falls outside its case interval");
    }
    assertions.push(...parseEvidenceAssertions(parsed.assertions, `${rowPath}/assertions`, issues));
  }
  return { artifact, assertions, observationIds: new Set() };
}

function validateComponentLog(
  file: LoadedFile,
  report: RunReport,
  componentIndex: number,
  issuePath: string,
  issues: ValidationIssue[],
): void {
  const rows = parseJsonLines(file.text, issuePath, issues);
  if (rows.length !== 1) {
    push(issues, issuePath, "artifact.component_log_count", "component log must contain exactly one terminal summary record");
    return;
  }
  const parsed = rows[0];
  const component = report.components[componentIndex];
  if (!isRecord(parsed) || !exactKeys(parsed, ["schemaVersion", "runId", "componentId", "interfaceVersion", "identity", "process"])) {
    push(issues, issuePath, "artifact.component_log_shape", "component log must use the exact rbp-component-log/v1 summary shape");
    return;
  }
  const expected: ComponentLogRecord = {
    schemaVersion: "rbp-component-log/v1",
    runId: report.run.runId,
    componentId: component!.id,
    interfaceVersion: component!.interfaceVersion,
    identity: component!.observedIdentity!,
    process: component!.process,
  };
  if (stableJson(parsed) !== stableJson(expected)) {
    push(issues, issuePath, "artifact.component_log_mismatch", "component log summary does not match observed identity/process evidence");
  }
}

function validateLeakMetrics(file: LoadedFile, report: RunReport, issuePath: string, issues: ValidationIssue[]): void {
  const parsed = parseJson(file.text, issuePath, issues);
  if (!isRecord(parsed) || !exactKeys(parsed, ["schemaVersion", "runId", "timing", "leaks", "resources"])) {
    push(issues, issuePath, "artifact.leak_metrics_shape", "leak metrics must use the exact rbp-conformance-leaks/v1 shape");
    return;
  }
  const expected: LeakMetricsDocument = {
    schemaVersion: "rbp-conformance-leaks/v1",
    runId: report.run.runId,
    timing: report.timing,
    leaks: report.leaks,
    resources: report.resources,
  };
  if (stableJson(parsed) !== stableJson(expected)) {
    push(issues, issuePath, "artifact.leak_metrics_mismatch", "leak/timing metrics do not match the run report summary fields");
  }
}

function xmlAttribute(source: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u").exec(source)?.[1];
}

function validateJUnitXml(
  text: string,
  expectedXml: string,
  expectedCases: Array<{ id: string; status: string }>,
  issuePath: string,
  issues: ValidationIssue[],
): void {
  const suite = /<testsuite\b([^>]*)>/u.exec(text);
  if (suite === null) {
    push(issues, issuePath, "artifact.junit_parse", "JUnit testsuite element is missing");
    return;
  }
  const caseMatches = [...text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)];
  const statuses = caseMatches.map((match) => {
    const body = match[2] ?? "";
    return body.includes("<failure") ? "failed" : body.includes("<error") ? "error" : body.includes("<skipped") ? "skipped" : "passed";
  });
  const ids = caseMatches.map((match) => xmlAttribute(match[1] ?? "", "data-case-id") ?? xmlAttribute(match[1] ?? "", "name")?.split(" ")[0]);
  const failures = statuses.filter((status) => status === "failed").length;
  const errors = statuses.filter((status) => status === "error").length;
  const skipped = statuses.filter((status) => status === "skipped").length;
  if (
    Number(xmlAttribute(suite[1] ?? "", "tests")) !== expectedCases.length ||
    Number(xmlAttribute(suite[1] ?? "", "failures")) !== failures ||
    Number(xmlAttribute(suite[1] ?? "", "errors")) !== errors ||
    Number(xmlAttribute(suite[1] ?? "", "skipped")) !== skipped ||
    caseMatches.length !== expectedCases.length
  ) {
    push(issues, issuePath, "artifact.junit_totals", "JUnit totals do not match parsed testcase outcomes");
  }
  expectedCases.forEach((entry, index) => {
    const expectedStatus = entry.status === "passed" || entry.status === "failed" || entry.status === "error" ? entry.status : "skipped";
    if (ids[index] !== entry.id || statuses[index] !== expectedStatus) {
      push(issues, `${issuePath}/testcase/${index}`, "artifact.junit_case_mismatch", `JUnit case ${index + 1} does not match ${entry.id}/${expectedStatus}`);
    }
  });
  if (text !== expectedXml) {
    push(issues, issuePath, "artifact.junit_nondeterministic", "JUnit bytes do not match the deterministic report mapping");
  }
}

function assertionEvidenceMatches(assertion: AssertionResult, record: EvidenceAssertionRecord): boolean {
  return stableJson({
    assertionId: assertion.assertionId,
    subvectorId: assertion.subvectorId,
    statement: assertion.statement,
    category: assertion.category,
    passed: assertion.passed,
    expected: assertion.expected,
    actual: assertion.actual,
    observationIds: assertion.observationIds,
  }) === stableJson(record);
}

export function verifyRunEvidenceFiles(report: RunReport, artifactRoot: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const artifacts = [...report.artifacts, ...report.cases.flatMap(({ artifacts }) => artifacts)];
  const loaded = new Map<string, LoadedFile>();
  artifacts.forEach((artifact, index) => {
    const base = `/retainedArtifacts/${index}`;
    if (NONEMPTY_KINDS.has(artifact.kind) && artifact.bytes === 0) {
      push(issues, `${base}/bytes`, "artifact.zero_bytes", `${artifact.kind} evidence cannot be empty`);
    }
    const expectedMediaType = MEDIA_TYPES[artifact.kind];
    if (expectedMediaType !== undefined && artifact.mediaType !== expectedMediaType) {
      push(issues, `${base}/mediaType`, "artifact.media_type", `${artifact.kind} must use ${expectedMediaType}`);
    }
    if (artifact.kind === "run_report" || artifact.kind === "aggregate_report" || artifact.kind === "aggregate_junit") {
      push(issues, `${base}/kind`, "artifact.self_reference", `${artifact.kind} is not valid inside one run report`);
    }
    const result = loadConfinedEvidenceFile(artifact.path, artifactRoot, artifact.sha256, artifact.bytes, `${base}/path`);
    issues.push(...result.issues);
    if (result.file !== undefined) loaded.set(artifact.path, result.file);
  });

  report.components.forEach((component, index) => {
    const expectedPath = `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/components/${component.id}.log`;
    const artifact = report.artifacts.find((entry) => entry.kind === "component_log" && entry.path === expectedPath);
    const file = artifact === undefined ? undefined : loaded.get(artifact.path);
    if (file !== undefined) validateComponentLog(file, report, index, `/components/${index}/log`, issues);
  });

  const junitPath = `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/junit.xml`;
  const junitArtifact = report.artifacts.find((entry) => entry.kind === "junit" && entry.path === junitPath);
  const junitFile = junitArtifact === undefined ? undefined : loaded.get(junitArtifact.path);
  if (junitFile !== undefined) {
    validateJUnitXml(
      junitFile.text,
      runReportToJUnitXml(report),
      report.cases.map((entry) => ({ id: entry.caseId, status: entry.status })),
      "/artifacts/junit",
      issues,
    );
  }

  const leakPath = `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/metrics/leaks.json`;
  const leakArtifact = report.artifacts.find((entry) => entry.kind === "leak_metrics" && entry.path === leakPath);
  const leakFile = leakArtifact === undefined ? undefined : loaded.get(leakArtifact.path);
  if (leakFile !== undefined) validateLeakMetrics(leakFile, report, "/artifacts/leak_metrics", issues);

  report.cases.forEach((result, caseIndex) => {
    const parsedEvidence: ParsedCaseEvidence[] = [];
    result.artifacts.forEach((artifact, artifactIndex) => {
      const file = loaded.get(artifact.path);
      if (file === undefined) return;
      const base = `/cases/${caseIndex}/artifacts/${artifactIndex}`;
      if (artifact.kind === "wire_trace") {
        const binding = result.bindings.find(({ binding: candidate }) => artifact.path.endsWith(`-${candidate}.jsonl`))?.binding;
        if (binding === undefined) {
          push(issues, base, "artifact.wire_binding", "wire trace path does not identify a required binding");
        } else {
          parsedEvidence.push(parseWireTrace(artifact, file, report, result, binding, base, issues));
        }
      } else if (artifact.kind === "journal_snapshot" || artifact.kind === "case_evidence") {
        if (artifact.kind === "case_evidence") {
          const expectedPrefix = `${canonicalManifest.retainedEvidence.root}/runs/${report.run.runId}/cases/${result.caseId}/`;
          if (!artifact.path.startsWith(expectedPrefix) || !artifact.path.endsWith(".json")) {
            push(issues, `${base}/path`, "artifact.case_evidence_path", `case evidence must be retained below ${expectedPrefix}`);
          }
        }
        const parsed = parseCaseEvidenceDocument(artifact, file, report, result, base, issues);
        if (parsed !== undefined) parsedEvidence.push(parsed);
      } else {
        push(issues, `${base}/kind`, "artifact.invalid_case_kind", `${artifact.kind} cannot be case assertion evidence`);
      }
    });

    result.assertions.forEach((assertion, assertionIndex) => {
      const matches = parsedEvidence.filter(({ artifact }) => artifact.sha256 === assertion.evidenceSha256);
      if (matches.length !== 1) {
        push(issues, `/cases/${caseIndex}/assertions/${assertionIndex}/evidenceSha256`, "assertion.unbound_evidence", "assertion digest must identify exactly one parsed artifact in the same case");
        if (matches.length === 0) {
          push(issues, `/cases/${caseIndex}/assertions/${assertionIndex}`, "assertion.content_mismatch", "retained evidence content does not contain the canonical assertion and its process observations");
        }
        return;
      }
      if (!matches[0]!.assertions.some((record) => assertionEvidenceMatches(assertion, record))) {
        push(issues, `/cases/${caseIndex}/assertions/${assertionIndex}`, "assertion.content_mismatch", "retained evidence content does not contain the exact canonical assertion identity/statement/category/outcome/expected/actual tuple");
      }
      if (assertion.observationIds.length < 1 || assertion.observationIds.some((id) => !matches[0]!.observationIds.has(id))) {
        push(issues, `/cases/${caseIndex}/assertions/${assertionIndex}/observationIds`, "assertion.unbound_observation", "every assertion observation id must resolve inside the same retained case evidence artifact");
      }
    });
  });

  return issues;
}

export function verifyAggregateEvidenceFiles(report: AggregateReport, artifactRoot: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  report.artifacts.forEach((artifact, index) => {
    const base = `/artifacts/${index}`;
    if (artifact.kind !== "aggregate_junit") {
      push(issues, `${base}/kind`, "artifact.invalid_aggregate_kind", "aggregate evidence list may contain only aggregate_junit");
      return;
    }
    if (artifact.bytes === 0) push(issues, `${base}/bytes`, "artifact.zero_bytes", "aggregate JUnit cannot be empty");
    if (artifact.mediaType !== "application/xml") push(issues, `${base}/mediaType`, "artifact.media_type", "aggregate JUnit must use application/xml");
    const loaded = loadConfinedEvidenceFile(artifact.path, artifactRoot, artifact.sha256, artifact.bytes, `${base}/path`);
    issues.push(...loaded.issues);
    if (loaded.file !== undefined) {
      validateJUnitXml(
        loaded.file.text,
        aggregateReportToJUnitXml(report),
        report.runs.flatMap((run, runIndex) => report.cases.map((entry) => ({ id: `run-${run.sequence}/${entry.caseId}`, status: entry.runStatuses[runIndex]! }))),
        base,
        issues,
      );
    }
  });
  return issues;
}
