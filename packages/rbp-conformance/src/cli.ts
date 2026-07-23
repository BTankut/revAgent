#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createThreeRunAggregate, renderAggregateSummary } from "./aggregate.js";
import { aggregateReportToJUnitXml, runReportToJUnitXml } from "./junit.js";
import { canonicalManifest } from "./manifest.js";
import { stableJson } from "./stableJson.js";
import { executeSupervisedC19Run } from "./supervisedC19.js";
import {
  assertProductionCliHarnessBound,
  assertProductionCliModulePath,
  assertProductionControllerRuntimeCurrent,
  assertProductionExecutionPlanCurrent,
} from "./productionExecutionPlan.js";
import { prepareProductionExecutionPlan } from "./productionPreparation.js";
import { executeProductionConformanceRun } from "./productionSuiteRunner.js";
import { runReconnectSoak } from "./soakRunner.js";
import { assertPassingSoakReport } from "./soak.js";
import type {
  AggregateInput,
  AggregateReport,
  ExecutionPlan,
  PassingValidationOptions,
  RunReport,
  SoakReport,
} from "./types.js";
import {
  assertPassingAggregateReport,
  assertPassingRunReport,
  ConformanceValidationError,
  validateAggregateReportStructure,
  validateRunReportStructure,
} from "./validator.js";

const CLI_MODULE_FILE = fileURLToPath(import.meta.url);
const CLI_ENTRY_FILE =
  process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
const isDirectInvocation =
  CLI_ENTRY_FILE !== undefined &&
  (
    pathToFileURL(CLI_ENTRY_FILE).href === import.meta.url ||
    (() => {
      try {
        return path.relative(
          realpathSync(CLI_ENTRY_FILE),
          realpathSync(CLI_MODULE_FILE),
        ) === "";
      } catch {
        return false;
      }
    })()
  );

function assertDirectProductionCliPath(repoRoot: string): void {
  if (!isDirectInvocation || CLI_ENTRY_FILE === undefined) {
    throw new Error(
      "production evidence commands require direct invocation of the canonical CLI; " +
      "imported CLI runners cannot produce or validate production evidence",
    );
  }
  assertProductionCliModulePath(repoRoot, CLI_ENTRY_FILE);
  assertProductionCliModulePath(repoRoot, CLI_MODULE_FILE);
}

function assertDirectProductionCliBound(
  plan: ExecutionPlan,
  repoRoot: string,
): void {
  if (!isDirectInvocation) {
    throw new Error(
      "production evidence commands require direct invocation of the canonical CLI",
    );
  }
  assertProductionCliHarnessBound(plan, repoRoot, CLI_MODULE_FILE);
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  rbp-conformance prepare-production <execution-plan.json> --run-id <id> --sequence <1|2|3> --git-executable <absolute path> [--repo-root <path>] [--node-executable <path>]",
      "  rbp-conformance run-production <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]",
      "  rbp-conformance run-c19 <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]",
      "  rbp-conformance run-soak <execution-plan.json> --mode smoke [--repo-root <path>] [--artifact-root <path>] [--duration-ms <ms>] [--cycle-interval-ms <ms>]",
      "  rbp-conformance run-soak <execution-plan.json> --mode one_hour [--repo-root <path>] [--artifact-root <path>]",
      "  rbp-conformance validate-run <run-report.json> --plan <execution-plan.json> --repo-root <path> [--artifact-root <path>]",
      "  rbp-conformance validate-aggregate <aggregate.json> --plan-1 <plan.json> --plan-2 <plan.json> --plan-3 <plan.json> --repo-root <path> [--artifact-root <path>]",
      "  rbp-conformance validate-soak <soak-report.json> --plan <soak-plan.json> --aggregate <aggregate.json> --plan-1 <plan.json> --plan-2 <plan.json> --plan-3 <plan.json> --repo-root <path> [--artifact-root <path>]",
      "  rbp-conformance junit <run-report.json> <junit.xml>",
      "  rbp-conformance aggregate <run-1.json> <run-2.json> <run-3.json> --plan-1 <plan.json> --plan-2 <plan.json> --plan-3 <plan.json> --repo-root <path> [--artifact-root <path>]",
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
  let gitExecutable: string | undefined;
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
    else if (name === "--git-executable") {
      if (gitExecutable !== undefined) {
        throw new Error("--git-executable must be provided exactly once");
      }
      if (!path.isAbsolute(value)) {
        throw new Error("--git-executable requires an absolute path");
      }
      gitExecutable = path.resolve(value);
    } else usage();
  }
  if (
    runId === undefined ||
    sequence === undefined ||
    gitExecutable === undefined
  ) {
    usage();
  }
  const target = resolveFrom(cwd, planFile);
  assertDirectProductionCliPath(repoRoot);
  assertCanonicalPlanTarget(repoRoot, target);
  const plan = prepareProductionExecutionPlan({
    repoRoot,
    runId,
    sequence,
    gitExecutable,
    ...(nodeExecutable === undefined ? {} : { nodeExecutable }),
  });
  writeText(target, stableJson(plan), cwd);
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  assertDirectProductionCliBound(plan, repoRoot);
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
      buildGeneratorDependenciesSha256:
        expectedIdentity.buildProvenance?.buildGeneratorDependenciesSha256 ?? null,
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
  assertDirectProductionCliPath(repoRoot);
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  assertDirectProductionCliBound(plan, repoRoot);
  assertProductionControllerRuntimeCurrent(plan);
  const result = await executeProductionConformanceRun({
    plan,
    repoRoot,
    artifactRoot,
    seed,
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
  assertDirectProductionCliPath(repoRoot);
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  assertDirectProductionCliBound(plan, repoRoot);
  assertProductionControllerRuntimeCurrent(plan);
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
  if (
    mode === "one_hour" &&
    (requestedDurationMs !== undefined || cycleIntervalMs !== undefined)
  ) {
    throw new Error(
      "one_hour soak duration and cycle cadence are fixed; " +
      "--duration-ms and --cycle-interval-ms are forbidden",
    );
  }
  if (requestedDurationMs !== undefined && !Number.isSafeInteger(requestedDurationMs)) usage();
  if (cycleIntervalMs !== undefined && !Number.isSafeInteger(cycleIntervalMs)) usage();
  assertDirectProductionCliPath(repoRoot);
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  assertDirectProductionCliBound(plan, repoRoot);
  assertProductionControllerRuntimeCurrent(plan);
  const result = await runReconnectSoak({
    mode,
    plan,
    repoRoot,
    ...(requestedDurationMs === undefined ? {} : { requestedDurationMs }),
    ...(mode === "smoke" && cycleIntervalMs !== undefined
      ? { cycleIntervalMs }
      : {}),
    artifactRoot,
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

interface ProductionValidationContext {
  options: PassingValidationOptions;
  plans: ExecutionPlan[];
  repoRoot: string;
}

interface ProductionFinalEvidenceContext {
  options: PassingValidationOptions;
  aggregatePlans: [ExecutionPlan, ExecutionPlan, ExecutionPlan];
  soakPlan: ExecutionPlan;
  aggregateFile: string;
}

export function assertDistinctFinalExecutionPlanFiles(
  planFiles: readonly [string, string, string, string],
): void {
  const planRealPaths = planFiles.map((planFile) => realpathSync(planFile));
  if (
    new Set(planRealPaths.map((planFile) => path.normalize(planFile))).size !==
      4
  ) {
    throw new Error(
      "final evidence requires four distinct execution-plan file realpaths",
    );
  }
}

export function assertFinalExecutionPlanIdentities(
  aggregatePlans: readonly [ExecutionPlan, ExecutionPlan, ExecutionPlan],
  soakPlan: ExecutionPlan,
): void {
  if (soakPlan.sequence !== 1) {
    throw new Error("final one-hour soak execution plan must use sequence 1");
  }
  if (aggregatePlans.some(({ runId }) => runId === soakPlan.runId)) {
    throw new Error(
      "final one-hour soak runId must be distinct from all aggregate runIds",
    );
  }
}

export function assertPlansShareExactCandidate(
  plans: readonly ExecutionPlan[],
): void {
  if (plans.length === 0) throw new Error("at least one production plan is required");
  const candidate = stableJson({
    manifest: plans[0]!.manifest,
    source: plans[0]!.source,
    components: plans[0]!.components.map((component) => ({
      id: component.id,
      interfaceVersion: component.interfaceVersion,
      expectedIdentity: component.expectedIdentity,
      command: component.command,
    })),
  });
  if (plans.some((plan) => stableJson({
    manifest: plan.manifest,
    source: plan.source,
    components: plan.components.map((component) => ({
      id: component.id,
      interfaceVersion: component.interfaceVersion,
      expectedIdentity: component.expectedIdentity,
      command: component.command,
    })),
  }) !== candidate)) {
    throw new Error("production plans do not share one exact candidate stack identity");
  }
  if (
    plans.length === 3 &&
    plans.map(({ sequence }) => sequence).join("|") !== "1|2|3"
  ) {
    throw new Error("three-run validation requires plans in sequence 1, 2, 3");
  }
}

function productionValidationContext(
  args: string[],
  cwd: string,
  planCount: 1 | 3,
): ProductionValidationContext {
  const options: PassingValidationOptions = { verifyArtifactFiles: true, artifactRoot: cwd };
  const planFiles = new Map<number, string>();
  let repoRoot: string | undefined;
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
    } else if (name === "--repo-root") {
      repoRoot = resolveFrom(cwd, value);
    } else if (planCount === 1 && name === "--plan") {
      planFiles.set(1, resolveFrom(cwd, value));
    } else if (
      planCount === 3 &&
      (name === "--plan-1" || name === "--plan-2" || name === "--plan-3")
    ) {
      planFiles.set(Number(name.at(-1)), resolveFrom(cwd, value));
    } else {
      usage();
    }
    index += 1;
  }
  if (repoRoot === undefined || planFiles.size !== planCount) usage();
  assertDirectProductionCliPath(repoRoot);
  const plans = Array.from({ length: planCount }, (_, index) => {
    const planFile = planFiles.get(index + 1);
    if (planFile === undefined) usage();
    const plan = readJson(planFile, cwd) as ExecutionPlan;
    assertProductionExecutionPlanCurrent(plan, repoRoot);
    assertDirectProductionCliBound(plan, repoRoot);
    assertProductionControllerRuntimeCurrent(plan);
    return plan;
  });
  assertPlansShareExactCandidate(plans);
  const source = plans[0]!.source;
  if (
    options.expectedCommitSha !== undefined &&
    options.expectedCommitSha !== source.commitSha
  ) {
    throw new Error("--expected-commit does not match the gated production plan");
  }
  if (
    options.expectedTreeSha !== undefined &&
    options.expectedTreeSha !== source.treeSha
  ) {
    throw new Error("--expected-tree does not match the gated production plan");
  }
  options.expectedCommitSha = source.commitSha;
  options.expectedTreeSha = source.treeSha;
  return { options, plans, repoRoot };
}

function productionFinalEvidenceContext(
  args: string[],
  cwd: string,
): ProductionFinalEvidenceContext {
  const options: PassingValidationOptions = {
    verifyArtifactFiles: true,
    artifactRoot: cwd,
  };
  const aggregatePlanFiles = new Map<number, string>();
  let soakPlanFile: string | undefined;
  let aggregateFile: string | undefined;
  let repoRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) usage();
    if (name === "--expected-commit") {
      options.expectedCommitSha = value;
    } else if (name === "--expected-tree") {
      options.expectedTreeSha = value;
    } else if (name === "--artifact-root") {
      options.artifactRoot = resolveFrom(cwd, value);
    } else if (name === "--repo-root") {
      repoRoot = resolveFrom(cwd, value);
    } else if (name === "--plan") {
      soakPlanFile = resolveFrom(cwd, value);
    } else if (name === "--aggregate") {
      aggregateFile = resolveFrom(cwd, value);
    } else if (
      name === "--plan-1" ||
      name === "--plan-2" ||
      name === "--plan-3"
    ) {
      aggregatePlanFiles.set(Number(name.at(-1)), resolveFrom(cwd, value));
    } else {
      usage();
    }
    index += 1;
  }
  if (
    repoRoot === undefined ||
    soakPlanFile === undefined ||
    aggregateFile === undefined ||
    aggregatePlanFiles.size !== 3
  ) {
    usage();
  }
  assertDirectProductionCliPath(repoRoot);
  const planFiles = [
    aggregatePlanFiles.get(1)!,
    aggregatePlanFiles.get(2)!,
    aggregatePlanFiles.get(3)!,
    soakPlanFile,
  ] as [string, string, string, string];
  assertDistinctFinalExecutionPlanFiles(planFiles);
  const gatePlan = (planFile: string): ExecutionPlan => {
    const plan = readJson(planFile, cwd) as ExecutionPlan;
    assertProductionExecutionPlanCurrent(plan, repoRoot);
    assertDirectProductionCliBound(plan, repoRoot);
    assertProductionControllerRuntimeCurrent(plan);
    return plan;
  };
  const aggregatePlans = ([1, 2, 3] as const).map((sequence) =>
    gatePlan(aggregatePlanFiles.get(sequence)!)) as [
      ExecutionPlan,
      ExecutionPlan,
      ExecutionPlan,
    ];
  const soakPlan = gatePlan(soakPlanFile);
  assertPlansShareExactCandidate(aggregatePlans);
  assertPlansShareExactCandidate([...aggregatePlans, soakPlan]);
  assertFinalExecutionPlanIdentities(aggregatePlans, soakPlan);
  const source = aggregatePlans[0].source;
  if (
    options.expectedCommitSha !== undefined &&
    options.expectedCommitSha !== source.commitSha
  ) {
    throw new Error("--expected-commit does not match the gated production plans");
  }
  if (
    options.expectedTreeSha !== undefined &&
    options.expectedTreeSha !== source.treeSha
  ) {
    throw new Error("--expected-tree does not match the gated production plans");
  }
  options.expectedCommitSha = source.commitSha;
  options.expectedTreeSha = source.treeSha;
  return { options, aggregatePlans, soakPlan, aggregateFile };
}

function assertRunMatchesPlan(report: RunReport, plan: ExecutionPlan): void {
  const expectedComponents = plan.components.map((component) => ({
    id: component.id,
    interfaceVersion: component.interfaceVersion,
    expectedIdentity: component.expectedIdentity,
  }));
  const actualComponents = report.components.map((component) => ({
    id: component.id,
    interfaceVersion: component.interfaceVersion,
    expectedIdentity: component.expectedIdentity,
  }));
  if (
    report.run.runId !== plan.runId ||
    report.run.sequence !== plan.sequence ||
    stableJson(report.manifest) !== stableJson(plan.manifest) ||
    stableJson(report.source) !== stableJson(plan.source) ||
    stableJson(actualComponents) !== stableJson(expectedComponents)
  ) {
    throw new Error("run report does not match its exact gated execution plan");
  }
}

function assertSoakMatchesPlan(
  report: SoakReport,
  plan: ExecutionPlan,
): void {
  const expectedComponents = plan.components.map((component) => ({
    id: component.id,
    interfaceVersion: component.interfaceVersion,
    identity: component.expectedIdentity,
  }));
  if (
    report.runId !== plan.runId ||
    stableJson(report.manifest) !== stableJson(plan.manifest) ||
    stableJson(report.source) !== stableJson(plan.source) ||
    stableJson(report.components) !== stableJson(expectedComponents)
  ) {
    throw new Error("soak report does not match its exact gated execution plan");
  }
}

export function assertFinalSoakReportMode(
  report: Pick<SoakReport, "mode">,
): void {
  if (report.mode !== "one_hour") {
    throw new Error(
      "final soak validation requires a canonical one_hour soak report",
    );
  }
}

function assertAggregateMatchesPlans(
  report: AggregateReport,
  plans: readonly ExecutionPlan[],
): void {
  const expectedRuns = plans.map((plan) => ({
    runId: plan.runId,
    sequence: plan.sequence,
    source: plan.source,
    components: plan.components.map((component) => ({
      id: component.id,
      interfaceVersion: component.interfaceVersion,
      identity: component.expectedIdentity,
    })),
  }));
  const actualRuns = report.runs.map((run) => ({
    runId: run.runId,
    sequence: run.sequence,
    source: run.source,
    components: run.components,
  }));
  if (
    stableJson(report.manifest) !== stableJson(plans[0]!.manifest) ||
    stableJson(report.source) !== stableJson(plans[0]!.source) ||
    stableJson(actualRuns) !== stableJson(expectedRuns)
  ) {
    throw new Error("aggregate report does not match the three exact gated plans");
  }
}

function runInput(
  file: string,
  cwd: string,
  artifactRoot: string,
  plan: ExecutionPlan,
): AggregateInput {
  const resolvedFile = resolveFrom(cwd, file);
  const bytes = readFileSync(resolvedFile);
  const report = JSON.parse(bytes.toString("utf8")) as unknown;
  const validation = validateRunReportStructure(report);
  if (!validation.ok || validation.value === undefined) {
    throw new ConformanceValidationError(`Invalid run report ${file}`, validation.issues);
  }
  assertRunMatchesPlan(validation.value, plan);
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
    const context = productionValidationContext(flags, cwd, 1);
    const report = readJson(file, cwd);
    assertPassingRunReport(report, context.options);
    assertRunMatchesPlan(report as RunReport, context.plans[0]!);
    process.stdout.write("RBP conformance run: PASS\n");
    return;
  }
  if (command === "validate-aggregate") {
    const [file, ...flags] = rest;
    if (file === undefined) usage();
    const context = productionValidationContext(flags, cwd, 3);
    const report = readJson(file, cwd);
    const options = context.options;
    options.aggregateReportFile = resolveFrom(cwd, file);
    assertPassingAggregateReport(report, options);
    assertAggregateMatchesPlans(report as AggregateReport, context.plans);
    process.stdout.write("RBP conformance three-run aggregate: PASS\n");
    return;
  }
  if (command === "validate-soak") {
    const [file, ...flags] = rest;
    if (file === undefined) usage();
    const context = productionFinalEvidenceContext(flags, cwd);
    const aggregate = readJson(context.aggregateFile, cwd);
    context.options.aggregateReportFile = context.aggregateFile;
    assertPassingAggregateReport(aggregate, context.options);
    assertAggregateMatchesPlans(
      aggregate as AggregateReport,
      context.aggregatePlans,
    );
    const report = readJson(file, cwd);
    context.options.soakReportFile = resolveFrom(cwd, file);
    assertPassingSoakReport(report, context.options);
    assertFinalSoakReportMode(report as SoakReport);
    assertSoakMatchesPlan(
      report as SoakReport,
      context.soakPlan,
    );
    process.stdout.write("RBP final aggregate and soak evidence set: PASS\n");
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
    const context = productionValidationContext(rest.slice(3), cwd, 3);
    const options = context.options;
    const artifactRoot = path.resolve(options.artifactRoot ?? cwd);
    const inputs = rest.slice(0, 3).map((file, index) =>
      runInput(file, cwd, artifactRoot, context.plans[index]!));
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
    assertAggregateMatchesPlans(aggregate, context.plans);
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
