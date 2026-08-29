#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createThreeRunAggregate, renderAggregateSummary } from "./aggregate.js";
import { aggregateReportToJUnitXml, runReportToJUnitXml } from "./junit.js";
import { canonicalManifest } from "./manifest.js";
import { SecureEvidenceStore } from "./secureEvidenceStore.js";
import { stableJson } from "./stableJson.js";
import { executeSupervisedC19Run } from "./supervisedC19.js";
import { assertTrustedProductionLaunch } from "./productionLaunchAttestation.js";
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

function assertProductionCliPath(
  repoRoot: string,
  role: "prepare-wrapper" | "cli-bootstrap",
): void {
  assertTrustedProductionLaunch(repoRoot, role);
  assertProductionCliModulePath(repoRoot, CLI_MODULE_FILE);
}

function assertProductionCliBound(
  plan: ExecutionPlan,
  repoRoot: string,
): void {
  assertProductionCliHarnessBound(plan, repoRoot, CLI_MODULE_FILE);
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  rbp-conformance prepare-production <execution-plan.json> --run-id <id> --sequence <1|2|3> --git-executable <absolute path> [--repo-root <path>] [--node-executable <path>]",
      "  rbp-conformance run-production <execution-plan.json> [--repo-root <path>] [--artifact-root <path>] [--seed <seed>]",
      "  rbp-conformance run-final-evidence --plan-1 <plan.json> --plan-2 <plan.json> --plan-3 <plan.json> --soak-plan <plan.json> --repo-root <path> --artifact-root <path> [--expected-commit <sha>] [--expected-tree <sha>]",
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
    if (name === undefined || value === undefined) usage();
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
  assertProductionCliPath(repoRoot, "prepare-wrapper");
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
  assertProductionCliBound(plan, repoRoot);
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
  assertProductionCliPath(repoRoot, "cli-bootstrap");
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  assertProductionCliBound(plan, repoRoot);
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
  assertProductionCliPath(repoRoot, "cli-bootstrap");
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  assertProductionCliBound(plan, repoRoot);
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
  assertProductionCliPath(repoRoot, "cli-bootstrap");
  const plan = readJson(planFile, cwd) as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  assertProductionCliBound(plan, repoRoot);
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

/**
 * The sole authoritative final-evidence workflow. It consumes only four
 * prebuilt plans, executes all three conformance runs and the fixed one-hour
 * soak in this attested process, and emits the final literal only after every
 * in-memory result and retained byte has passed closed validation.
 */
export async function runFinalEvidenceAsyncCli(
  args: string[],
  cwd: string = process.cwd(),
): Promise<void> {
  const context = productionFinalRunContext(args, cwd);
  assertNoPreexistingFinalEvidence(
    context.artifactRoot,
    context.runPlans.map(({ runId }) => runId) as [string, string, string],
    context.soakPlan.runId,
    context.planSnapshots.map(({ file }) => file) as [
      string,
      string,
      string,
      string,
    ],
  );

  const runInputs: AggregateInput[] = [];
  for (const [index, plan] of context.runPlans.entries()) {
    assertFinalPlanSnapshotsCurrent(context);
    const result = await executeProductionConformanceRun({
      plan,
      repoRoot: context.repoRoot,
      artifactRoot: context.artifactRoot,
      seed: `final-evidence:${plan.runId}:sequence-${String(index + 1)}`,
    });
    assertRunMatchesPlan(result.report, plan);
    assertPassingRunReport(result.report, context.options);
    const expectedReportPath = retainedTemplate(
      canonicalManifest.retainedEvidence.runReport,
      { run_id: plan.runId },
    );
    if (result.reportPath !== expectedReportPath) {
      throw new Error(
        `run ${String(index + 1)} returned a noncanonical report path`,
      );
    }
    const retained = readExactRetainedJson(
      context.artifactRoot,
      result.reportPath,
      result.report,
      `run ${String(index + 1)} report`,
    );
    runInputs.push({
      report: result.report,
      reportPath: result.reportPath,
      reportSha256: retained.sha256,
    });
  }

  assertFinalPlanSnapshotsCurrent(context);
  const aggregate = createThreeRunAggregate(runInputs);
  assertAggregateMatchesPlans(aggregate, context.runPlans);
  const aggregateJunit = aggregateReportToJUnitXml(aggregate);
  const aggregateJunitPath =
    `${canonicalManifest.retainedEvidence.root}/${canonicalManifest.retainedEvidence.aggregateJunit}`;
  const aggregateJunitBytes = Buffer.from(aggregateJunit, "utf8");
  aggregate.artifacts.push({
    kind: "aggregate_junit",
    path: aggregateJunitPath,
    sha256: createHash("sha256").update(aggregateJunitBytes).digest("hex"),
    bytes: aggregateJunitBytes.length,
    mediaType: "application/xml",
  });

  const store = new SecureEvidenceStore(context.artifactRoot);
  const aggregateJunitSha256 = createHash("sha256").update(aggregateJunitBytes).digest("hex");
  const storedJunitBytes = await store.writeAccepted(aggregateJunitPath, aggregateJunitBytes, (candidate) => candidate.acceptExact({
    logicalPath: aggregateJunitPath,
    absolutePath: store.resolve(aggregateJunitPath),
    bytes: aggregateJunitBytes,
    sha256: aggregateJunitSha256,
  }, candidate.bytes));
  if (!storedJunitBytes.equals(aggregateJunitBytes)) {
    throw new Error("retained aggregate JUnit bytes differ from the in-memory result");
  }
  if (
    createHash("sha256").update(storedJunitBytes).digest("hex") !==
    aggregate.artifacts[0]!.sha256
  ) {
    throw new Error("retained aggregate JUnit hash differs from the in-memory result");
  }

  const aggregateBytes = Buffer.from(stableJson(aggregate), "utf8");
  const aggregateSha256 = createHash("sha256").update(aggregateBytes).digest("hex");
  const acceptedAggregate = await store.writeAccepted(aggregate.reportPath, aggregateBytes, (candidate) => candidate.acceptExact({
    logicalPath: aggregate.reportPath,
    absolutePath: store.resolve(aggregate.reportPath),
    bytes: aggregateBytes,
    sha256: aggregateSha256,
  }, {
    absolutePath: candidate.absolutePath,
    bytes: candidate.bytes,
    sha256: candidate.sha256,
    parsed: JSON.parse(candidate.bytes.toString("utf8")) as typeof aggregate,
  }));
  if (!acceptedAggregate.bytes.equals(aggregateBytes) || acceptedAggregate.sha256 !== aggregateSha256) {
    throw new Error("retained aggregate JSON bytes differ from the in-memory result");
  }
  if (stableJson(acceptedAggregate.parsed) !== stableJson(aggregate)) {
    throw new Error("accepted aggregate JSON differs from the in-memory result");
  }
  context.options.aggregateReportFile = acceptedAggregate.absolutePath;
  assertPassingAggregateReport(acceptedAggregate.parsed, context.options);
  assertAggregateMatchesPlans(acceptedAggregate.parsed, context.runPlans);

  assertFinalPlanSnapshotsCurrent(context);
  const soakResult = await runReconnectSoak({
    mode: "one_hour",
    plan: context.soakPlan,
    repoRoot: context.repoRoot,
    artifactRoot: context.artifactRoot,
  });
  const expectedSoakReportPath = retainedTemplate(
    canonicalManifest.retainedEvidence.soakReport,
    { mode: "one_hour", run_id: context.soakPlan.runId },
  );
  if (soakResult.reportPath !== expectedSoakReportPath) {
    throw new Error("one-hour soak returned a noncanonical report path");
  }
  assertFinalSoakReportMode(soakResult.report);
  assertSoakMatchesPlan(soakResult.report, context.soakPlan);
  const retainedSoak = readExactRetainedJson(
    context.artifactRoot,
    soakResult.reportPath,
    soakResult.report,
    "one-hour soak report",
  );
  context.options.soakReportFile = retainedSoak.absolutePath;
  assertPassingSoakReport(soakResult.report, context.options);
  assertAggregateAndSoakShareExactCandidate(aggregate, soakResult.report);

  // Reopen and revalidate the entire evidence set after the one-hour boundary.
  // A plan or retained-output mutation during the soak invalidates the set.
  assertFinalPlanSnapshotsCurrent(context);
  readExactRetainedJson(
    context.artifactRoot,
    aggregate.reportPath,
    aggregate,
    "aggregate report",
  );
  for (const input of runInputs) {
    readExactRetainedJson(
      context.artifactRoot,
      input.reportPath,
      input.report,
      `run ${String(input.report.run.sequence)} report`,
    );
  }
  readExactRetainedJson(
    context.artifactRoot,
    soakResult.reportPath,
    soakResult.report,
    "one-hour soak report",
  );
  assertPassingAggregateReport(aggregate, context.options);
  assertAggregateMatchesPlans(aggregate, context.runPlans);
  assertPassingSoakReport(soakResult.report, context.options);
  assertFinalSoakReportMode(soakResult.report);
  assertSoakMatchesPlan(soakResult.report, context.soakPlan);
  assertAggregateAndSoakShareExactCandidate(aggregate, soakResult.report);

  process.stdout.write("RBP FINAL EVIDENCE: PASS\n");
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

interface FinalPlanSnapshot {
  file: string;
  realPath: string;
  bytes: Buffer;
  plan: ExecutionPlan;
}

interface ProductionFinalRunContext {
  options: PassingValidationOptions;
  runPlans: [ExecutionPlan, ExecutionPlan, ExecutionPlan];
  soakPlan: ExecutionPlan;
  planSnapshots: [
    FinalPlanSnapshot,
    FinalPlanSnapshot,
    FinalPlanSnapshot,
    FinalPlanSnapshot,
  ];
  repoRoot: string;
  artifactRoot: string;
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
  if (
    new Set([...aggregatePlans.map(({ runId }) => runId), soakPlan.runId])
      .size !== 4
  ) {
    throw new Error("final evidence requires four distinct execution-plan runIds");
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

function readCanonicalFinalPlanSnapshot(
  planFile: string,
  repoRoot: string,
): FinalPlanSnapshot {
  const file = path.resolve(planFile);
  if (!existsSync(file)) {
    throw new Error(`final evidence execution plan does not exist: ${file}`);
  }
  const lexical = lstatSync(file);
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw new Error(`final evidence execution plan is not a physical file: ${file}`);
  }
  const realPath = realpathSync(file);
  if (!statSync(realPath).isFile()) {
    throw new Error(`final evidence execution plan is not a regular file: ${file}`);
  }
  const bytes = readFileSync(realPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `final evidence execution plan is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Buffer.from(stableJson(parsed), "utf8").equals(bytes)) {
    throw new Error(
      "final evidence execution plan must retain exact canonical stableJson bytes",
    );
  }
  const plan = parsed as ExecutionPlan;
  assertProductionExecutionPlanCurrent(plan, repoRoot);
  assertProductionCliBound(plan, repoRoot);
  assertProductionControllerRuntimeCurrent(plan);
  return { file, realPath, bytes, plan };
}

function assertFinalPlanSnapshotsCurrent(
  context: ProductionFinalRunContext,
): void {
  for (const snapshot of context.planSnapshots) {
    if (
      !existsSync(snapshot.file) ||
      lstatSync(snapshot.file).isSymbolicLink() ||
      realpathSync(snapshot.file) !== snapshot.realPath ||
      !readFileSync(snapshot.realPath).equals(snapshot.bytes)
    ) {
      throw new Error(
        `final evidence execution plan changed during the attested run: ${snapshot.file}`,
      );
    }
    assertProductionExecutionPlanCurrent(snapshot.plan, context.repoRoot);
    assertProductionCliBound(snapshot.plan, context.repoRoot);
    assertProductionControllerRuntimeCurrent(snapshot.plan);
  }
  assertPlansShareExactCandidate(context.runPlans);
  assertPlansShareExactCandidate([
    ...context.runPlans,
    context.soakPlan,
  ]);
  assertFinalExecutionPlanIdentities(context.runPlans, context.soakPlan);
}

function productionFinalRunContext(
  args: string[],
  cwd: string,
): ProductionFinalRunContext {
  const [command, ...flags] = args;
  if (command !== "run-final-evidence") usage();
  const planFiles = new Map<number, string>();
  let soakPlanFile: string | undefined;
  let repoRoot: string | undefined;
  let artifactRoot: string | undefined;
  let expectedCommitSha: string | undefined;
  let expectedTreeSha: string | undefined;
  const seenFlags = new Set<string>();
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index];
    const value = flags[index + 1];
    if (name === undefined || value === undefined) usage();
    const allowed =
      name === "--plan-1" ||
      name === "--plan-2" ||
      name === "--plan-3" ||
      name === "--soak-plan" ||
      name === "--repo-root" ||
      name === "--artifact-root" ||
      name === "--expected-commit" ||
      name === "--expected-tree";
    if (!allowed) {
      // There is deliberately no report, aggregate, soak-result, executor,
      // adapter, clock, or duration input on the authoritative command.
      usage();
    }
    if (seenFlags.has(name)) {
      throw new Error(
        `final evidence CLI flag must be provided at most once: ${name}`,
      );
    }
    seenFlags.add(name);
    if (
      name === "--plan-1" ||
      name === "--plan-2" ||
      name === "--plan-3"
    ) {
      planFiles.set(Number(name.at(-1)), resolveFrom(cwd, value));
    } else if (name === "--soak-plan") {
      soakPlanFile = resolveFrom(cwd, value);
    } else if (name === "--repo-root") {
      repoRoot = resolveFrom(cwd, value);
    } else if (name === "--artifact-root") {
      artifactRoot = resolveFrom(cwd, value);
    } else if (name === "--expected-commit") {
      expectedCommitSha = value;
    } else if (name === "--expected-tree") {
      expectedTreeSha = value;
    }
  }
  if (
    repoRoot === undefined ||
    artifactRoot === undefined ||
    soakPlanFile === undefined ||
    planFiles.size !== 3
  ) {
    usage();
  }

  // Establish the process-private launcher boundary before plan, ignored
  // output, or retained-evidence bytes are read.
  assertProductionCliPath(repoRoot, "cli-bootstrap");
  const allPlanFiles = [
    planFiles.get(1)!,
    planFiles.get(2)!,
    planFiles.get(3)!,
    soakPlanFile,
  ] as [string, string, string, string];
  assertDistinctFinalExecutionPlanFiles(allPlanFiles);
  const planSnapshots = allPlanFiles.map((planFile) =>
    readCanonicalFinalPlanSnapshot(planFile, repoRoot)) as [
      FinalPlanSnapshot,
      FinalPlanSnapshot,
      FinalPlanSnapshot,
      FinalPlanSnapshot,
    ];
  const runPlans = planSnapshots
    .slice(0, 3)
    .map(({ plan }) => plan) as [
      ExecutionPlan,
      ExecutionPlan,
      ExecutionPlan,
    ];
  const soakPlan = planSnapshots[3].plan;
  assertPlansShareExactCandidate(runPlans);
  assertPlansShareExactCandidate([...runPlans, soakPlan]);
  assertFinalExecutionPlanIdentities(runPlans, soakPlan);
  const source = runPlans[0].source;
  if (
    expectedCommitSha !== undefined &&
    expectedCommitSha !== source.commitSha
  ) {
    throw new Error("--expected-commit does not match the gated production plans");
  }
  if (
    expectedTreeSha !== undefined &&
    expectedTreeSha !== source.treeSha
  ) {
    throw new Error("--expected-tree does not match the gated production plans");
  }
  const context: ProductionFinalRunContext = {
    options: {
      verifyArtifactFiles: true,
      artifactRoot,
      expectedCommitSha: source.commitSha,
      expectedTreeSha: source.treeSha,
    },
    runPlans,
    soakPlan,
    planSnapshots,
    repoRoot,
    artifactRoot,
  };
  assertFinalPlanSnapshotsCurrent(context);
  return context;
}

function lexicalPathExists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function normalizedPathIdentity(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function assertPlainExistingDirectory(value: string, label: string): void {
  if (!lexicalPathExists(value)) return;
  const entry = lstatSync(value);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} is not a physical directory: ${value}`);
  }
}

function exactRunIdSegment(runId: string): string {
  if (
    runId.length === 0 ||
    runId === "." ||
    runId === ".." ||
    path.basename(runId) !== runId ||
    /[\\/]/u.test(runId)
  ) {
    throw new Error(`final evidence runId is not a confined path segment: ${runId}`);
  }
  return runId;
}

function retainedTemplate(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return `${canonicalManifest.retainedEvidence.root}/${
    Object.entries(values).reduce(
      (result, [name, value]) => result.replaceAll(`{${name}}`, value),
      template,
    )
  }`;
}

/**
 * A failed or partial final set is never resumed. Plan files below the
 * canonical plans directory may already exist, but each output run directory,
 * the aggregate directory, and the exact one-hour soak run directory must be
 * completely absent before the first case starts.
 */
export function assertNoPreexistingFinalEvidence(
  artifactRootValue: string,
  runIdsValue: readonly [string, string, string],
  soakRunIdValue: string,
  allowedPlanFilesValue: readonly [string, string, string, string],
): void {
  if (
    new Set([...runIdsValue, soakRunIdValue]).size !== 4
  ) {
    throw new Error("final evidence requires four distinct execution-plan runIds");
  }
  const artifactRoot = path.resolve(artifactRootValue);
  const retainedRoot = path.resolve(
    artifactRoot,
    canonicalManifest.retainedEvidence.root,
  );
  const runsRoot = path.join(retainedRoot, "runs");
  const soakRoot = path.join(retainedRoot, "soak");
  const oneHourRoot = path.join(soakRoot, "one_hour");
  const outputRoots = [
    ...runIdsValue.map((runId) =>
      path.join(runsRoot, exactRunIdSegment(runId))),
    path.join(retainedRoot, "aggregate"),
    path.join(oneHourRoot, exactRunIdSegment(soakRunIdValue)),
  ];
  const allowedFiles = new Set<string>();
  const allowedDirectories = new Set<string>([
    normalizedPathIdentity(artifactRoot),
  ]);
  for (const planFileValue of allowedPlanFilesValue) {
    const planFile = path.resolve(planFileValue);
    if (!isPathInsideOrEqual(artifactRoot, planFile)) continue;
    if (normalizedPathIdentity(planFile) === normalizedPathIdentity(artifactRoot)) {
      throw new Error(
        "final evidence plan path cannot equal the artifact root; use a fresh evidence set",
      );
    }
    allowedFiles.add(normalizedPathIdentity(planFile));
    let cursor = path.dirname(planFile);
    while (isPathInsideOrEqual(artifactRoot, cursor)) {
      allowedDirectories.add(normalizedPathIdentity(cursor));
      if (normalizedPathIdentity(cursor) === normalizedPathIdentity(artifactRoot)) {
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  if (!lexicalPathExists(artifactRoot)) {
    if (allowedFiles.size > 0) {
      throw new Error(
        "final evidence plan path is below a missing artifact root; use a fresh evidence set",
      );
    }
    return;
  }
  assertPlainExistingDirectory(artifactRoot, "final evidence artifact root");
  for (const outputRoot of outputRoots) {
    if (lexicalPathExists(outputRoot)) {
      throw new Error(
        `final evidence output already exists; use a fresh evidence set: ${outputRoot}`,
      );
    }
  }

  const seenAllowedFiles = new Set<string>();
  const inspectFreshDirectory = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const entryPath = path.join(directory, name);
      const entryIdentity = normalizedPathIdentity(entryPath);
      const entry = lstatSync(entryPath);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `final evidence root contains a reparse entry; use a fresh evidence set: ${entryPath}`,
        );
      }
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(entryIdentity)) {
          throw new Error(
            `final evidence root contains an unexpected directory; use a fresh evidence set: ${entryPath}`,
          );
        }
        inspectFreshDirectory(entryPath);
        continue;
      }
      if (entry.isFile() && allowedFiles.has(entryIdentity)) {
        seenAllowedFiles.add(entryIdentity);
        continue;
      }
      throw new Error(
        `final evidence root contains an unexpected entry; use a fresh evidence set: ${entryPath}`,
      );
    }
  };
  inspectFreshDirectory(artifactRoot);
  if (
    seenAllowedFiles.size !== allowedFiles.size ||
    [...allowedFiles].some((planFile) => !seenAllowedFiles.has(planFile))
  ) {
    throw new Error(
      "final evidence root does not contain exactly the selected plan files; use a fresh evidence set",
    );
  }
}

function confinedRetainedFile(
  artifactRootValue: string,
  relativePath: string,
  label: string,
): string {
  const artifactRoot = path.resolve(artifactRootValue);
  const retainedRoot = path.resolve(
    artifactRoot,
    canonicalManifest.retainedEvidence.root,
  );
  const target = path.resolve(artifactRoot, relativePath);
  const relative = path.relative(retainedRoot, target);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} escapes the canonical retained-evidence root`);
  }
  if (!lexicalPathExists(target)) {
    throw new Error(`${label} is missing from retained evidence: ${relativePath}`);
  }
  const entry = lstatSync(target);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} is not a physical retained file: ${relativePath}`);
  }
  const artifactRootReal = realpathSync(artifactRoot);
  const targetReal = realpathSync(target);
  const realRelative = path.relative(artifactRootReal, targetReal);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`${label} resolves outside the final artifact root`);
  }
  return targetReal;
}

function readExactRetainedJson<T>(
  artifactRoot: string,
  relativePath: string,
  expected: T,
  label: string,
): { absolutePath: string; bytes: Buffer; sha256: string } {
  const absolutePath = confinedRetainedFile(
    artifactRoot,
    relativePath,
    label,
  );
  const bytes = readFileSync(absolutePath);
  const expectedBytes = Buffer.from(stableJson(expected), "utf8");
  if (!bytes.equals(expectedBytes)) {
    throw new Error(`${label} bytes differ from the returned in-memory result`);
  }
  let retained: unknown;
  try {
    retained = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${label} is not retained JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (stableJson(retained) !== stableJson(expected)) {
    throw new Error(`${label} JSON differs from the returned in-memory result`);
  }
  return {
    absolutePath,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assertAggregateAndSoakShareExactCandidate(
  aggregate: AggregateReport,
  soak: SoakReport,
): void {
  const aggregateCandidate = stableJson({
    manifest: aggregate.manifest,
    source: aggregate.source,
    components: aggregate.runs[0]?.components,
  });
  const soakCandidate = stableJson({
    manifest: soak.manifest,
    source: soak.source,
    components: soak.components,
  });
  if (aggregateCandidate !== soakCandidate) {
    throw new Error(
      "final aggregate and one-hour soak do not share one exact candidate identity",
    );
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
  assertProductionCliPath(repoRoot, "cli-bootstrap");
  const plans = Array.from({ length: planCount }, (_, index) => {
    const planFile = planFiles.get(index + 1);
    if (planFile === undefined) usage();
    const plan = readJson(planFile, cwd) as ExecutionPlan;
    assertProductionExecutionPlanCurrent(plan, repoRoot);
    assertProductionCliBound(plan, repoRoot);
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
  assertProductionCliPath(repoRoot, "cli-bootstrap");
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
    assertProductionCliBound(plan, repoRoot);
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
    process.stdout.write(
      "RBP conformance run audit: VALID (NON-AUTHORITATIVE)\n",
    );
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
    process.stdout.write(
      "RBP conformance aggregate audit: VALID (NON-AUTHORITATIVE)\n",
    );
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
    process.stdout.write(
      "RBP aggregate and soak audit: VALID (NON-AUTHORITATIVE)\n",
    );
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
    const context = productionValidationContext(
      rest.slice(3),
      cwd,
      3,
    );
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
    assertPassingAggregateReport(aggregate, {
      ...options,
      artifactRoot,
      verifyArtifactFiles: false,
    });
    assertAggregateMatchesPlans(aggregate, context.plans);
    const aggregateBytes = Buffer.from(stableJson(aggregate), "utf8");
    process.stdout.write(
      "RBP conformance aggregate reconstruction: VALID (NON-AUTHORITATIVE)\n",
    );
    process.stdout.write(`${stableJson({
      schemaVersion: "rbp-conformance-aggregate-audit-summary/v1",
      aggregateBytes: aggregateBytes.length,
      aggregateSha256: createHash("sha256").update(aggregateBytes).digest("hex"),
      junitBytes: junitBytes.length,
      junitSha256: createHash("sha256").update(junitBytes).digest("hex"),
      runCount: aggregate.runs.length,
      caseCount: aggregate.cases.length,
      testcaseCount: aggregate.cases.reduce(
        (count, entry) => count + entry.runStatuses.length,
        0,
      ),
    })}\n`);
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

export async function runProductionCliMain(args: string[]): Promise<void> {
  try {
    if (args[0] === "prepare-production") {
      await runPrepareProductionAsyncCli(args);
    } else if (args[0] === "run-final-evidence") {
      await runFinalEvidenceAsyncCli(args);
    } else if (args[0] === "run-production") {
      await runProductionAsyncCli(args);
    } else if (args[0] === "run-c19") await runAsyncCli(args);
    else if (args[0] === "run-soak") await runSoakAsyncCli(args);
    else runCli(args);
  } catch (error) {
    if (error instanceof ConformanceValidationError) {
      process.stderr.write(`${error.message}\n${stableJson({ issues: error.issues })}`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}

// Direct execution is retained only to fail closed with the launcher guard.
// The canonical path enters through the tracked pre-controller bootstrap.
if (isDirectInvocation) {
  assertProductionCliPath(process.cwd(), "cli-bootstrap");
  void runProductionCliMain(process.argv.slice(2));
}
