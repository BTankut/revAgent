import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import { validateSchema } from "./schemas.js";
import { stableJson } from "./stableJson.js";
import type { AggregateReport, JUnitMapping, RunReport, ValidationIssue, ValidationResult } from "./types.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createJUnitMapping(report: RunReport): JUnitMapping {
  const cases = canonicalManifest.cases.map((manifestCase, index) => {
    const result = report.cases[index];
    if (result?.caseId !== manifestCase.id) {
      throw new Error(`Run report case ${index + 1} is not ${manifestCase.id}`);
    }
    const failure =
      result.failure ??
      (result.status === "failed" || result.status === "error"
        ? { code: `case_${result.status}`, message: `${result.caseId} ended ${result.status}` }
        : null);
    return {
      caseId: result.caseId,
      className: "revAgent.rbp.v1.section21" as const,
      testName: `${result.caseId} ${result.title}`,
      status: result.status,
      durationMs: result.durationMs ?? 0,
      failure,
    };
  });

  return {
    schemaVersion: "rbp-conformance-junit/v1",
    manifest: { ...report.manifest },
    runId: report.run.runId,
    suiteName: "RBP/1 section 21 v1.0 freeze",
    tests: 40,
    failures: cases.filter(({ status }) => status === "failed").length,
    errors: cases.filter(({ status }) => status === "error").length,
    skipped: cases.filter(({ status }) => status === "skipped" || status === "not_run" || status === "running").length,
    durationMs: cases.reduce((sum, entry) => sum + entry.durationMs, 0),
    cases,
  };
}

export function validateJUnitMapping(value: unknown, report?: RunReport): ValidationResult<JUnitMapping> {
  const issues = validateSchema("junit", value);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const mapping = value as JUnitMapping;
  const expected = report === undefined ? undefined : createJUnitMapping(report);
  if (stableJson(mapping.manifest) !== stableJson(canonicalManifestIdentity)) {
    issues.push({ path: "/manifest", code: "junit.manifest", message: "JUnit manifest identity does not match the canonical section 21 manifest" });
  }
  if (expected !== undefined && stableJson(mapping) !== stableJson(expected)) {
    issues.push({ path: "/", code: "junit.mismatch", message: "JUnit mapping does not deterministically match the run report" });
  }
  const seen = new Set<string>();
  mapping.cases.forEach((entry, index) => {
    const manifestCase = canonicalManifest.cases[index];
    if (entry.caseId !== manifestCase?.id || entry.testName !== `${manifestCase.id} ${manifestCase.title}`) {
      issues.push({ path: `/cases/${index}`, code: "junit.case_alignment", message: `expected ${manifestCase?.id ?? "no case"}` });
    }
    if (seen.has(entry.caseId)) {
      issues.push({ path: `/cases/${index}/caseId`, code: "junit.duplicate_case", message: `duplicate case ${entry.caseId}` });
    }
    seen.add(entry.caseId);
    if (entry.status === "passed" && entry.failure !== null) {
      issues.push({ path: `/cases/${index}/failure`, code: "junit.false_green", message: "passing JUnit case cannot carry failure evidence" });
    }
    if ((entry.status === "failed" || entry.status === "error") && entry.failure === null) {
      issues.push({ path: `/cases/${index}/failure`, code: "junit.missing_failure", message: `${entry.status} JUnit case requires failure evidence` });
    }
  });
  const expectedFailures = mapping.cases.filter(({ status }) => status === "failed").length;
  const expectedErrors = mapping.cases.filter(({ status }) => status === "error").length;
  const expectedSkipped = mapping.cases.filter(({ status }) => status === "skipped" || status === "not_run" || status === "running").length;
  const expectedDuration = mapping.cases.reduce((sum, entry) => sum + entry.durationMs, 0);
  if (
    mapping.failures !== expectedFailures ||
    mapping.errors !== expectedErrors ||
    mapping.skipped !== expectedSkipped ||
    mapping.durationMs !== expectedDuration
  ) {
    issues.push({ path: "/", code: "junit.summary", message: "JUnit counters or duration disagree with case mappings" });
  }
  return issues.length === 0 ? { ok: true, value: mapping, issues } : { ok: false, issues };
}

export function renderJUnitXml(mapping: JUnitMapping): string {
  const validation = validateJUnitMapping(mapping);
  if (!validation.ok) {
    throw new Error(`Invalid JUnit mapping: ${validation.issues.map((entry: ValidationIssue) => `${entry.path} ${entry.message}`).join("; ")}`);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXml(mapping.suiteName)}" tests="${mapping.tests}" failures="${mapping.failures}" errors="${mapping.errors}" skipped="${mapping.skipped}" time="${(mapping.durationMs / 1000).toFixed(3)}">`,
    `  <properties><property name="manifest.sha256" value="${mapping.manifest.sha256}"/><property name="spec.version" value="${mapping.manifest.specVersion}"/><property name="run.id" value="${escapeXml(mapping.runId)}"/></properties>`,
  ];

  for (const entry of mapping.cases) {
    const open = `  <testcase classname="${entry.className}" name="${escapeXml(entry.testName)}" time="${(entry.durationMs / 1000).toFixed(3)}"`;
    if (entry.status === "passed") {
      lines.push(`${open}/>`);
    } else if (entry.status === "failed") {
      const failure = entry.failure ?? { code: "case_failed", message: "case failed without detail" };
      lines.push(`${open}><failure type="${escapeXml(failure.code)}" message="${escapeXml(failure.message)}">${escapeXml(failure.message)}</failure></testcase>`);
    } else if (entry.status === "error") {
      const failure = entry.failure ?? { code: "case_error", message: "case errored without detail" };
      lines.push(`${open}><error type="${escapeXml(failure.code)}" message="${escapeXml(failure.message)}">${escapeXml(failure.message)}</error></testcase>`);
    } else {
      lines.push(`${open}><skipped message="${escapeXml(entry.status)}"/></testcase>`);
    }
  }

  lines.push("</testsuite>");
  return `${lines.join("\n")}\n`;
}

export function runReportToJUnitXml(report: RunReport): string {
  return renderJUnitXml(createJUnitMapping(report));
}

export function aggregateReportToJUnitXml(report: AggregateReport): string {
  const entries = report.runs.flatMap((run, runIndex) =>
    report.cases.map((entry) => ({
      id: `run-${run.sequence}/${entry.caseId}`,
      name: `run-${run.sequence} ${entry.caseId} ${entry.title}`,
      status: entry.runStatuses[runIndex]!,
    })),
  );
  const failures = entries.filter(({ status }) => status === "failed").length;
  const errors = entries.filter(({ status }) => status === "error").length;
  const skipped = entries.filter(({ status }) => status === "skipped" || status === "not_run" || status === "running").length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="RBP/1 section 21 three-run aggregate" tests="120" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(report.summary.totalDurationMs / 1000).toFixed(3)}">`,
    `  <properties><property name="manifest.sha256" value="${report.manifest.sha256}"/><property name="spec.version" value="${report.manifest.specVersion}"/><property name="aggregate.status" value="${report.status}"/></properties>`,
  ];
  for (const entry of entries) {
    const open = `  <testcase classname="revAgent.rbp.v1.section21.aggregate" name="${escapeXml(entry.name)}" data-case-id="${entry.id}" time="0.000"`;
    if (entry.status === "passed") {
      lines.push(`${open}/>`);
    } else if (entry.status === "failed") {
      lines.push(`${open}><failure type="case_failed" message="${entry.status}">${entry.status}</failure></testcase>`);
    } else if (entry.status === "error") {
      lines.push(`${open}><error type="case_error" message="${entry.status}">${entry.status}</error></testcase>`);
    } else {
      lines.push(`${open}><skipped message="${entry.status}"/></testcase>`);
    }
  }
  lines.push("</testsuite>");
  return `${lines.join("\n")}\n`;
}
