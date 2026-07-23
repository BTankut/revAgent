#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createThreeRunAggregate, renderAggregateSummary } from "./aggregate.js";
import { aggregateReportToJUnitXml, runReportToJUnitXml } from "./junit.js";
import { canonicalManifest } from "./manifest.js";
import { stableJson } from "./stableJson.js";
import { executeSupervisedC19Run } from "./supervisedC19.js";
import { createProductionReconnectSoakAdapter } from "./productionSoakAdapter.js";
import { PRODUCTION_CASE_COMPOSITION } from "./productionCaseComposition.js";
import { assertProductionExecutionPlanCurrent } from "./productionExecutionPlan.js";
import { prepareProductionExecutionPlan } from "./productionPreparation.js";
import { executeProductionConformanceRun } from "./productionSuiteRunner.js";
import { runReconnectSoak } from "./soakRunner.js";
import { assertPassingSoakReport } from "./soak.js";
import type { AggregateInput, AggregateReport, ExecutionPlan, PassingValidationOptions, RunReport } from "./types.js";
import {
  assertPassingAggregateReport,
  assertPassingRunReport,
  ConformanceValidationError,
  validateAggregateReportStructure,
  validateRunReportStructure,
} from "./validator.js";

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  rbp-conformance prepare-production <execution-plan.json> --run-id <id> --sequence <1|2|3> [--repo-root <path>] [--node-executable <path>]",
      "  rbp-conformance run-production <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]",
      "  rbp-conformance run-c19 <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]",
      "  rbp-conformance run-soak <execution-plan.json> --mode <smoke|one_hour> [--repo-root <path>] [--artifact-root <path>] [--duration-ms <ms>] [--cycle-interval-ms <ms>]",
      "  rbp-conformance validate-run <run-report.json> [--expected-commit <sha>] [--expected-tree <sha>] [--artifact-root <path>]",
      "  rbp-conformance validate-aggregate <aggregate.json> [--expected-commit <sha>] [--expected-tree <sha>] [--artifact-root <path>]",
      "  rbp-conformance validate-soak <soak-report.json> [--expected-commit <sha>] [--expected-tree <sha>] [--artifact-root <path>]",
      "  rbp-conformance junit <run-report.json> <junit.xml>",
      "  rbp-conformance aggregate <run-1.json> <run-2.json> <run-3.json> [--artifact-root <path>] [--expected-commit <sha>] [--expected-tree <sha>]",
      "  rbp-conformance summary <aggregate.json> <summary.md>",
    ].join("\n"),
  );
}

function assertCanonicalPlanTarget(repoRoot: string, target: string): void {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  const normalized = relative.replaceAll("\\", "/");
  if (!normalized.startsWith("artifacts/conformance/")) {
    throw new Error(
      "an in-repository production execution plan must be below artifacts/conformance/",
    );
  }
}

export async function runPrepareProductionAsyncCli(
  args: string[],
  cwd: string = process.cwd(),
): Promise<void> {
  const [command, planFile, ...flags] = args;
  if (command !== "prepare-production" || planFile === undefined) usage();
  let repoRoot = cwd;
  let runId: string | undefined;
  let sequence: 1 | 2 | 3 | undefined;
  let nodeExecutable: string | undefined;
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    const value = flags[index + 1];
    if (value === undefined) usage();
    if (name === "--repo-root") repoRoot = resolveFrom(cwd, value);
    else if (name === "--run-id") runId = value;
    else if (
      name === "--sequence" &&
      (value === "1" || value === "2" || value === "3")
    ) {
      sequence = Number(value) as 1 | 2 | 3;
    } else if (name === "--node-executable") nodeExecutable = resolveFrom(cwd, value);
    else usage();
  }
  if (runId === undefined || sequence === undefined) usage();
  const target = resolveFrom(cwd, planFile);
  assertCanonicalPlanTarget(repoRoot, target);
  const plan = prepareProductionExecutionPlan({
    repoRoot,
    runId,
    sequence,
    ...(nodeExecutable === undefined ? {} : { nodeExecutable }),
  });
  writeText(target, stableJson(plan), cwd);
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  process.stdout.write(`${stableJson({
    planPath: target,
    runId: plan.runId,
    sequence: plan.sequence,
    commitSha: plan.source.commitSha,
    treeSha: plan.source.treeSha,
    components: plan.components.map(({ id, expectedIdentity }) => ({
      id,
      executableSha256: expectedIdentity.executableSha256,
      sidecarSha256: expectedIdentity.buildProvenance?.sidecarSha256 ?? null,
      compileInputsSha256:
        expectedIdentity.buildProvenance?.compileInputsSha256 ?? null,
      runtimeArtifactsSha256:
        expectedIdentity.buildProvenance?.runtimeArtifactsSha256 ?? null,
      runtimeDependenciesSha256:
        expectedIdentity.buildProvenance?.runtimeDependenciesSha256 ?? null,
      harnessArtifactsSha256:
        expectedIdentity.buildProvenance?.harnessArtifactsSha256 ?? null,
      harnessRuntimeDependenciesSha256:
        expectedIdentity.buildProvenance?.harnessRuntimeDependenciesSha256 ?? null,
    })),
  })}\n`);
}

export async function runProductionAsyncCli(
  args: string[],
  cwd: string = process.cwd(),
): Promise<void> {
  const [command, planFile, ...flags] = args;
  if (command !== "run-production" || planFile === undefined) usage();
  let repoRoot = cwd;
  let artifactRoot = cwd;
  let seed = `production:${Date.now()}`;
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    const value = flags[index + 1];
    if (value === undefined) usage();
    if (name === "--repo-root") repoRoot = resolveFrom(cwd, value);
    else if (name === "--artifact-root") artifactRoot = resolveFrom(cwd, value);
    else if (name === "--seed") seed = value;
    else usage();
  }
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  const result = await executeProductionConformanceRun({
    plan,
    repoRoot,
    artifactRoot,
    seed,
    oracles: PRODUCTION_CASE_COMPOSITION.oracles,
    executeCase: PRODUCTION_CASE_COMPOSITION.executeCase,
  });
  process.stdout.write(`${stableJson({
    reportPath: result.reportPath,
    runStatus: result.report.run.status,
    exitCode: result.report.run.exitCode,
    caseCount: result.report.cases.length,
    passedCount: result.report.cases.filter(({ status }) => status === "passed").length,
    failedCases: result.report.cases
      .filter(({ status }) => status !== "passed")
      .map(({ caseId, status, failure }) => ({
        caseId,
        status,
        failureCode: failure?.code ?? null,
      })),
  })}\n`);
  process.exitCode = result.report.run.exitCode ?? 1;
}

export async function runAsyncCli(args: string[], cwd: string = process.cwd()): Promise<void> {
  const [command, planFile, ...flags] = args;
  if (command !== "run-c19" || planFile === undefined) usage();
  let repoRoot = cwd;
  let artifactRoot = cwd;
  let seed = `supervised-c19:${Date.now()}`;
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    const value = flags[index + 1];
    if (value === undefined) usage();
    if (name === "--repo-root") repoRoot = resolveFrom(cwd, value);
    else if (name === "--artifact-root") artifactRoot = resolveFrom(cwd, value);
    else if (name === "--seed") seed = value;
    else usage();
  }
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  const result = await executeSupervisedC19Run({
    plan,
    repoRoot,
    artifactRoot,
    seed,
  });
  process.stdout.write(`${stableJson({
    reportPath: result.reportPath,
    runStatus: result.report.run.status,
    exitCode: result.report.run.exitCode,
    executedCases: result.report.cases.filter(({ status }) => status !== "not_run").map(({ caseId, status }) => ({ caseId, status })),
    notRunCount: result.report.cases.filter(({ status }) => status === "not_run").length,
  })}\n`);
  process.exitCode = result.report.run.exitCode ?? 1;
}

export async function runSoakAsyncCli(args: string[], cwd: string = process.cwd()): Promise<void> {
  const [command, planFile, ...flags] = args;
  if (command !== "run-soak" || planFile === undefined) usage();
  let repoRoot = cwd;
  let artifactRoot = cwd;
  let mode: "smoke" | "one_hour" | undefined;
  let requestedDurationMs: number | undefined;
  let cycleIntervalMs: number | undefined;
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    const value = flags[index + 1];
    if (value === undefined) usage();
    if (name === "--repo-root") repoRoot = resolveFrom(cwd, value);
    else if (name === "--artifact-root") artifactRoot = resolveFrom(cwd, value);
    else if (name === "--mode" && (value === "smoke" || value === "one_hour")) mode = value;
    else if (name === "--duration-ms") requestedDurationMs = Number(value);
    else if (name === "--cycle-interval-ms") cycleIntervalMs = Number(value);
    else usage();
  }
  if (mode === undefined) usage();
  if (mode === "one_hour" && requestedDurationMs !== undefined) {
    throw new Error("one_hour soak duration is fixed and does not accept --duration-ms");
  }
  if (requestedDurationMs !== undefined && !Number.isSafeInteger(requestedDurationMs)) usage();
  if (cycleIntervalMs !== undefined && !Number.isSafeInteger(cycleIntervalMs)) usage();
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  const adapter = await createProductionReconnectSoakAdapter({ plan, repoRoot });
  const result = await runReconnectSoak({
    mode,
    runId: plan.runId,
    ...(requestedDurationMs === undefined ? {} : { requestedDurationMs }),
    ...(cycleIntervalMs === undefined ? {} : { cycleIntervalMs }),
    artifactRoot,
    source: structuredClone(plan.source),
    components: plan.components.map((component) => ({
      id: component.id,
      interfaceVersion: component.interfaceVersion,
      identity: structuredClone(component.expectedIdentity),
    })),
    adapter,
  });
  process.stdout.write(`${stableJson({
    reportPath: result.reportPath,
    status: result.report.status,
    actualDurationMs: result.report.actualDurationMs,
    cycleCount: result.report.cycles.length,
  })}\n`);
  process.exitCode = result.report.status === "passed" ? 0 : 1;
}

function resolveFrom(cwd: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(cwd, file);
}

function readJson(file: string, cwd: string): unknown {
  return JSON.parse(readFileSync(resolveFrom(cwd, file), "utf8")) as unknown;
}

function writeText(file: string, contents: string, cwd: string): void {
  const target = resolveFrom(cwd, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function validationOptions(args: string[], cwd: string): PassingValidationOptions {
  const options: PassingValidationOptions = { verifyArtifactFiles: true, artifactRoot: cwd };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      usage();
    }
    if (name === "--expected-commit") {
      options.expectedCommitSha = value;
    } else if (name === "--expected-tree") {
      options.expectedTreeSha = value;
    } else if (name === "--artifact-root") {
      options.artifactRoot = resolveFrom(cwd, value);
    } else {
      usage();
    }
    index += 1;
  }
  return options;
}

function runInput(file: string, cwd: string, artifactRoot: string): AggregateInput {
  const resolvedFile = resolveFrom(cwd, file);
  const bytes = readFileSync(resolvedFile);
  const report = JSON.parse(bytes.toString("utf8")) as unknown;
  const validation = validateRunReportStructure(report);
  if (!validation.ok || validation.value === undefined) {
    throw new ConformanceValidationError(`Invalid run report ${file}`, validation.issues);
  }
  const reportPath = path.relative(artifactRoot, resolvedFile).replaceAll("\\", "/");
  if (reportPath.startsWith("..") || path.isAbsolute(reportPath)) {
    throw new Error(`Run report must be retained below the artifact root: ${file}`);
  }
  return {
    report: validation.value,
    reportPath,
    reportSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function runCli(args: string[], cwd: string = process.cwd()): void {
  const [command, ...rest] = args;
  if (command === "validate-run") {
    const [file, ...flags] = rest;
    if (file === undefined) usage();
    const report = readJson(file, cwd);
    assertPassingRunReport(report, validationOptions(flags, cwd));
    process.stdout.write("RBP conformance run: PASS\n");
    return;
  }
  if (command === "validate-aggregate") {
    const [file, ...flags] = rest;
    if (file === undefined) usage();
    const report = readJson(file, cwd);
    const options = validationOptions(flags, cwd);
    options.aggregateReportFile = resolveFrom(cwd, file);
    assertPassingAggregateReport(report, options);
    process.stdout.write("RBP conformance three-run aggregate: PASS\n");
    return;
  }
  if (command === "validate-soak") {
    const [file, ...flags] = rest;
    if (file === undefined) usage();
    const report = readJson(file, cwd);
    const options = validationOptions(flags, cwd);
    options.soakReportFile = resolveFrom(cwd, file);
    assertPassingSoakReport(report, options);
    process.stdout.write("RBP reconnect/proxy-churn soak: PASS\n");
    return;
  }
  if (command === "junit") {
    if (rest.length !== 2) usage();
    const report = readJson(rest[0]!, cwd) as RunReport;
    const validation = validateRunReportStructure(report);
    if (!validation.ok || validation.value === undefined) {
      throw new ConformanceValidationError("Cannot map an invalid run report", validation.issues);
    }
    writeText(rest[1]!, runReportToJUnitXml(validation.value), cwd);
    return;
  }
  if (command === "aggregate") {
    if (rest.length < 3) usage();
    const options = validationOptions(rest.slice(3), cwd);
    const artifactRoot = path.resolve(options.artifactRoot ?? cwd);
    const inputs = rest.slice(0, 3).map((file) => runInput(file, cwd, artifactRoot));
    inputs.forEach(({ report }) => assertPassingRunReport(report, { ...options, artifactRoot }));
    const aggregate = createThreeRunAggregate(inputs);
    const junitXml = aggregateReportToJUnitXml(aggregate);
    const junitPath = `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateJunit}`;
    const junitBytes = Buffer.from(junitXml, "utf8");
    aggregate.artifacts.push({
      kind: "aggregate_junit",
      path: junitPath,
      sha256: createHash("sha256").update(junitBytes).digest("hex"),
      bytes: junitBytes.length,
      mediaType: "application/xml",
    });
    writeText(junitPath, junitXml, artifactRoot);
    const aggregateReportFile = path.resolve(artifactRoot, aggregate.reportPath);
    assertPassingAggregateReport(aggregate, { ...options, artifactRoot, aggregateReportFile });
    writeText(aggregate.reportPath, stableJson(aggregate), artifactRoot);
    return;
  }
  if (command === "summary") {
    if (rest.length !== 2) usage();
    const aggregate = readJson(rest[0]!, cwd);
    const validation = validateAggregateReportStructure(aggregate);
    if (!validation.ok || validation.value === undefined) {
      throw new ConformanceValidationError("Cannot summarize an invalid aggregate", validation.issues);
    }
    writeText(rest[1]!, renderAggregateSummary(validation.value as AggregateReport), cwd);
    return;
  }
  usage();
}

const isDirectInvocation = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectInvocation) {
  const main = async (): Promise<void> => {
    if (process.argv[2] === "prepare-production") {
      await runPrepareProductionAsyncCli(process.argv.slice(2));
    } else if (process.argv[2] === "run-production") {
      await runProductionAsyncCli(process.argv.slice(2));
    } else if (process.argv[2] === "run-c19") await runAsyncCli(process.argv.slice(2));
    else if (process.argv[2] === "run-soak") await runSoakAsyncCli(process.argv.slice(2));
    else runCli(process.argv.slice(2));
  };
  main().catch((error) => {
    if (error instanceof ConformanceValidationError) {
      process.stderr.write(`${error.message}\n${stableJson({ issues: error.issues })}`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
