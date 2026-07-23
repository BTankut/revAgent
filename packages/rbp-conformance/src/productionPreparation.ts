import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveSourceIdentity } from "./executionPlan.js";
import {
  createProductionBuildProvenanceSidecars,
  productionBuildOutputRoots,
} from "./productionBuildProvenance.js";
import {
  assertProductionExecutionPlanCurrent,
  buildProductionExecutionPlan,
} from "./productionExecutionPlan.js";
import { stableJson } from "./stableJson.js";
import type { ExecutionPlan } from "./types.js";

const PRODUCTION_BUILD_WORKSPACES = [
  "@revagent/protocol",
  "@revagent/addin-loopback-fixture",
  "@revagent/gateway-stub",
  "@revagent/bridge-simulator",
] as const;

function confinedOutputPath(repoRoot: string, relativePath: string): string {
  const root = realpathSync(repoRoot);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !productionBuildOutputRoots().includes(relativePath)
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
  for (const relativePath of productionBuildOutputRoots()) {
    const target = confinedOutputPath(repoRoot, relativePath);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

function runWorkspaceBuild(repoRoot: string, workspace: string): void {
  const npmEntrypoint = process.env.npm_execpath;
  if (npmEntrypoint === undefined || !path.isAbsolute(npmEntrypoint)) {
    throw new Error(
      "canonical production preparation must be invoked through npm run prepare:rbp-production",
    );
  }
  const result = spawnSync(
    process.execPath,
    [npmEntrypoint, "run", "build", "--workspace", workspace],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `canonical production build failed for ${workspace} (exit ${String(result.status)})`,
    );
  }
}

/**
 * The only supported production prepare path: start from an exactly clean
 * source identity, delete only the four ignored canonical output roots, build
 * them in a fixed order, write deterministic sidecars, then build and recheck
 * the execution plan against the same source.
 */
export function prepareProductionExecutionPlan(input: {
  repoRoot: string;
  runId: string;
  sequence: 1 | 2 | 3;
  nodeExecutable?: string;
}): ExecutionPlan {
  const sourceBeforeBuild = resolveSourceIdentity(input.repoRoot);
  cleanProductionBuildOutputs(input.repoRoot);
  for (const workspace of PRODUCTION_BUILD_WORKSPACES) {
    runWorkspaceBuild(input.repoRoot, workspace);
  }
  const sourceAfterBuild = resolveSourceIdentity(input.repoRoot);
  if (stableJson(sourceAfterBuild) !== stableJson(sourceBeforeBuild)) {
    throw new Error("canonical production build changed the clean source identity");
  }
  createProductionBuildProvenanceSidecars(input.repoRoot, sourceAfterBuild);
  const plan = buildProductionExecutionPlan(input);
  assertProductionExecutionPlanCurrent(plan, input.repoRoot);
  return plan;
}
