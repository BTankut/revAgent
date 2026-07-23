import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveSourceIdentity } from "./executionPlan.js";
import {
  createProductionBuildProvenanceSidecars,
  productionComponentBuildOutputRoots,
  productionComponentOutputArtifacts,
  productionHarnessRuntimeArtifacts,
} from "./productionBuildProvenance.js";
import {
  assertProductionExecutionPlanCurrent,
  buildProductionExecutionPlan,
} from "./productionExecutionPlan.js";
import {
  resolveInstalledBuildGeneratorDependencyClosure,
  resolveProductionToolchainIdentity,
  sanitizedProductionRuntimeEnvironment,
  TYPESCRIPT_ENTRYPOINT_PATH,
  type InstalledBuildGeneratorDependencyClosure,
  type ProductionNodeExecutableIdentity,
  type ProductionToolchainIdentity,
} from "./productionRuntimeIdentity.js";
import { stableJson } from "./stableJson.js";
import type { ExecutionPlan } from "./types.js";

export const PRODUCTION_BUILD_STEPS = [
  {
    workspace: "@revagent/protocol",
    outputRoot: "packages/protocol/dist",
  },
  {
    workspace: "@revagent/addin-loopback-fixture",
    outputRoot: "packages/addin-loopback-fixture/dist",
  },
  {
    workspace: "@revagent/gateway-stub",
    outputRoot: "packages/gateway-stub/dist",
  },
  {
    workspace: "@revagent/bridge-simulator",
    outputRoot: "packages/bridge-simulator/dist",
  },
] as const;

export type ProductionBuildWorkspace =
  (typeof PRODUCTION_BUILD_STEPS)[number]["workspace"];

const INTERNAL_NPM_EXECUTABLE_KEY = "RBP_PRODUCTION_NPM_EXECUTABLE";

function npmEntrypoint(): string {
  const value = process.env[INTERNAL_NPM_EXECUTABLE_KEY];
  if (value === undefined || !path.isAbsolute(value)) {
    throw new Error(
      "canonical production preparation requires the direct wrapper and an exact npm identity",
    );
  }
  return value;
}

function buildEnvironment(): NodeJS.ProcessEnv {
  const result = sanitizedProductionRuntimeEnvironment();
  for (const key of Object.keys(result)) {
    if (
      key.toUpperCase().startsWith("GIT_") ||
      key.toUpperCase() === INTERNAL_NPM_EXECUTABLE_KEY
    ) {
      delete result[key];
    }
  }
  result.PATH = "";
  return result;
}

function toolchainIdentity(
  repoRoot: string,
  runtimeNodeExecutable: string,
  npmExecutable: string,
): ProductionToolchainIdentity {
  return resolveProductionToolchainIdentity(repoRoot, {
    buildNodeExecutable: process.execPath,
    runtimeNodeExecutable,
    npmExecutable,
  });
}

function assertToolchainUnchanged(
  expected: ProductionToolchainIdentity,
  actual: ProductionToolchainIdentity,
  phase: string,
): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error(`canonical production toolchain changed ${phase}`);
  }
}

function runBoundNodeChild(input: {
  repoRoot: string;
  npmExecutable: string;
  runtimeNodeExecutable: string;
  expectedToolchain: ProductionToolchainIdentity;
  args: readonly string[];
  label: string;
  capture?: boolean;
}): string {
  assertToolchainUnchanged(
    input.expectedToolchain,
    toolchainIdentity(
      input.repoRoot,
      input.runtimeNodeExecutable,
      input.npmExecutable,
    ),
    `before ${input.label}`,
  );
  const result = spawnSync(input.expectedToolchain.buildNode.realPath, input.args, {
    cwd: input.repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: input.capture === true
      ? ["ignore", "pipe", "pipe"]
      : ["ignore", "inherit", "inherit"],
    env: buildEnvironment(),
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${input.label} failed (exit ${String(result.status)}): ${String(result.stderr).trim()}`,
    );
  }
  assertToolchainUnchanged(
    input.expectedToolchain,
    toolchainIdentity(
      input.repoRoot,
      input.runtimeNodeExecutable,
      input.npmExecutable,
    ),
    `after ${input.label}`,
  );
  return String(result.stdout).trim();
}

function runWorkspaceBuild(input: {
  repoRoot: string;
  npmExecutable: string;
  runtimeNodeExecutable: string;
  expectedToolchain: ProductionToolchainIdentity;
  expectedBuildGeneratorDependencies: InstalledBuildGeneratorDependencyClosure;
  workspace: ProductionBuildWorkspace;
}): void {
  const typescriptEntrypoint = path.resolve(
    input.repoRoot,
    TYPESCRIPT_ENTRYPOINT_PATH,
  );
  if (input.workspace === "@revagent/protocol") {
    executeGuardedProtocolGeneration({
      repoRoot: input.repoRoot,
      runtimeNode: input.expectedToolchain.runtimeNode,
      expected: input.expectedBuildGeneratorDependencies,
      executeGeneration: () => {
        runBoundNodeChild({
          ...input,
          args: [path.resolve(
            input.repoRoot,
            "packages/protocol/scripts/generate-types.mjs",
          )],
          label: "canonical protocol type generation",
        });
      },
    });
    runBoundNodeChild({
      ...input,
      args: [path.resolve(input.repoRoot, "packages/protocol/scripts/clean.mjs")],
      label: "canonical protocol output clean",
    });
  }
  const packageName = input.workspace.slice("@revagent/".length);
  runBoundNodeChild({
    ...input,
    args: [
      typescriptEntrypoint,
      "-p",
      path.resolve(input.repoRoot, `packages/${packageName}/tsconfig.json`),
    ],
    label: `canonical direct TypeScript build for ${input.workspace}`,
  });
}

function assertBuildGeneratorDependenciesUnchanged(input: {
  repoRoot: string;
  runtimeNode: ProductionNodeExecutableIdentity;
  expected: InstalledBuildGeneratorDependencyClosure;
  phase: string;
}): void {
  const current = resolveInstalledBuildGeneratorDependencyClosure(
    input.repoRoot,
    input.runtimeNode,
  );
  if (stableJson(current) !== stableJson(input.expected)) {
    throw new Error(
      `protocol build-generator dependency closure changed ${input.phase}`,
    );
  }
}

export function executeGuardedProtocolGeneration(input: {
  repoRoot: string;
  runtimeNode: ProductionNodeExecutableIdentity;
  expected: InstalledBuildGeneratorDependencyClosure;
  executeGeneration: () => void;
}): void {
  assertBuildGeneratorDependenciesUnchanged({
    ...input,
    phase: "before generation",
  });
  input.executeGeneration();
  assertBuildGeneratorDependenciesUnchanged({
    ...input,
    phase: "after generation",
  });
}

function runNativeDependencySmoke(input: {
  repoRoot: string;
  runtimeNodeExecutable: string;
}): void {
  const script = path.resolve(
    input.repoRoot,
    "packages/rbp-conformance/scripts/smoke-better-sqlite3.mjs",
  );
  const result = spawnSync(input.runtimeNodeExecutable, [script], {
    cwd: input.repoRoot,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildEnvironment(),
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `better-sqlite3 native smoke failed (exit ${String(result.status)}): ` +
      `${String(result.stderr).trim()}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(String(result.stdout)) as unknown;
  } catch {
    throw new Error("better-sqlite3 native smoke did not return JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { ok?: unknown }).ok !== true ||
    (value as { answer?: unknown }).answer !== 42
  ) {
    throw new Error("better-sqlite3 native smoke did not prove query execution");
  }
}

function confinedOutputPath(repoRoot: string, relativePath: string): string {
  const root = realpathSync(repoRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !productionComponentBuildOutputRoots().includes(relativePath)
  ) {
    throw new Error(`refusing to clean non-canonical production output: ${relativePath}`);
  }
  if (existsSync(candidate)) {
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`refusing to clean a linked production output: ${relativePath}`);
    }
    const realCandidate = realpathSync(candidate);
    const realRelative = path.relative(root, realCandidate);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`production output resolves outside the repository: ${relativePath}`);
    }
  }
  return candidate;
}

function cleanProductionBuildOutputs(repoRoot: string): void {
  for (const relativePath of productionComponentBuildOutputRoots()) {
    const target = confinedOutputPath(repoRoot, relativePath);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

export function executeCanonicalProductionBuildDag(input: {
  repoRoot: string;
  bootstrapHarness: ReturnType<typeof productionHarnessRuntimeArtifacts>;
  executeStep: (workspace: ProductionBuildWorkspace) => void;
}): void {
  const completed = new Map<string, string>();
  for (const step of PRODUCTION_BUILD_STEPS) {
    input.executeStep(step.workspace);
    for (const [outputRoot, expectedDigest] of completed) {
      const currentDigest = productionComponentOutputArtifacts(
        input.repoRoot,
        outputRoot,
      ).digestSha256;
      if (currentDigest !== expectedDigest) {
        throw new Error(`${step.workspace} rewrote upstream output ${outputRoot}`);
      }
    }
    const currentDigest = productionComponentOutputArtifacts(
      input.repoRoot,
      step.outputRoot,
    ).digestSha256;
    completed.set(step.outputRoot, currentDigest);
    const currentHarness = productionHarnessRuntimeArtifacts(input.repoRoot);
    if (stableJson(currentHarness) !== stableJson(input.bootstrapHarness)) {
      throw new Error(
        `${step.workspace} changed the bootstrap conformance/protocol harness`,
      );
    }
  }
}

/**
 * The only supported inner production prepare path. The outer wrapper has
 * already cleaned and rebuilt the controller. This function validates the
 * exact toolchain and native module before any clean, builds the four
 * component outputs once in a fixed non-recursive DAG, proves that later DAG
 * steps did not rewrite upstream outputs, and emits bound sidecars and plan.
 */
export function prepareProductionExecutionPlan(input: {
  repoRoot: string;
  runId: string;
  sequence: 1 | 2 | 3;
  nodeExecutable?: string;
}): ExecutionPlan {
  const runtimeNodeExecutable = input.nodeExecutable ?? process.execPath;
  if (!path.isAbsolute(runtimeNodeExecutable)) {
    throw new Error("canonical production runtime Node executable must be absolute");
  }
  const npmExecutable = npmEntrypoint();
  const expectedToolchain = toolchainIdentity(
    input.repoRoot,
    runtimeNodeExecutable,
    npmExecutable,
  );
  const expectedBuildGeneratorDependencies =
    resolveInstalledBuildGeneratorDependencyClosure(
      input.repoRoot,
      expectedToolchain.runtimeNode,
    );
  const sourceBeforeBuild = resolveSourceIdentity(
    input.repoRoot,
    expectedToolchain.git.path,
  );
  const bootstrapHarness = productionHarnessRuntimeArtifacts(input.repoRoot);
  runNativeDependencySmoke({ repoRoot: input.repoRoot, runtimeNodeExecutable });

  cleanProductionBuildOutputs(input.repoRoot);
  executeCanonicalProductionBuildDag({
    repoRoot: input.repoRoot,
    bootstrapHarness,
    executeStep: (workspace) => {
      runWorkspaceBuild({
        workspace,
        repoRoot: input.repoRoot,
        npmExecutable,
        runtimeNodeExecutable,
        expectedToolchain,
        expectedBuildGeneratorDependencies,
      });
    },
  });
  const finalHarness = productionHarnessRuntimeArtifacts(input.repoRoot);
  if (stableJson(finalHarness) !== stableJson(bootstrapHarness)) {
    throw new Error("component build changed the freshly built conformance harness");
  }
  runNativeDependencySmoke({ repoRoot: input.repoRoot, runtimeNodeExecutable });

  const sourceAfterBuild = resolveSourceIdentity(
    input.repoRoot,
    expectedToolchain.git.path,
  );
  if (stableJson(sourceAfterBuild) !== stableJson(sourceBeforeBuild)) {
    throw new Error("canonical production build changed the clean source identity");
  }
  createProductionBuildProvenanceSidecars(input.repoRoot, sourceAfterBuild, {
    buildNodeExecutable: process.execPath,
    runtimeNodeExecutable,
    npmExecutable,
  });
  const plan = buildProductionExecutionPlan({
    ...input,
    nodeExecutable: runtimeNodeExecutable,
    gitExecutable: expectedToolchain.git.path,
  });
  assertProductionExecutionPlanCurrent(plan, input.repoRoot);
  return plan;
}
