import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSourceIdentity } from "../src/executionPlan.js";
import {
  createProductionBuildProvenanceSidecars,
  productionBuildOutputRoots,
} from "../src/productionBuildProvenance.js";
import {
  buildProductionExecutionPlan,
} from "../src/productionExecutionPlan.js";
import {
  resolveGitExecutableOnPath,
  resolveProductionGitIdentity,
} from "../src/productionGitIdentity.js";
import { sanitizedProductionRuntimeEnvironment } from "../src/productionRuntimeIdentity.js";
import { stableJson } from "../src/stableJson.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const planFile = path.join(
  repoRoot,
  "artifacts",
  "conformance",
  "rbp-v1",
  "1.0",
  "test-support",
  "current-production-plan.json",
);

function npmEntrypoint(): string {
  const candidates = [
    process.env.npm_execpath,
    process.env.NPM_EXECPATH,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ];
  const selected = candidates.find(
    (candidate): candidate is string =>
      candidate !== undefined &&
      path.isAbsolute(candidate) &&
      existsSync(candidate),
  );
  if (selected === undefined) {
    throw new Error(
      "production test setup could not resolve the exact npm launcher",
    );
  }
  return selected;
}

function removeBuildOutputs(): void {
  const realRoot = realpathSync(repoRoot);
  for (const relative of productionBuildOutputRoots()) {
    const target = path.resolve(realRoot, relative);
    const fromRoot = path.relative(realRoot, target);
    if (
      fromRoot.startsWith("..") ||
      path.isAbsolute(fromRoot) ||
      fromRoot.replaceAll("\\", "/") !== relative
    ) {
      throw new Error(`test build output escaped repository: ${relative}`);
    }
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink()) {
        throw new Error(`test build output is linked: ${relative}`);
      }
      const realTarget = realpathSync(target);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw new Error(`test build output resolves outside repository: ${relative}`);
      }
      rmSync(target, { recursive: true, force: true });
    }
  }
}

function runNode(args: readonly string[], label: string): void {
  const result = spawnSync(
    process.execPath,
    args,
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: sanitizedProductionRuntimeEnvironment(),
      shell: false,
      timeout: 180_000,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `${label} failed (exit ${String(result.status)})`,
        String(result.stdout).trim(),
        String(result.stderr).trim(),
      ].filter((entry) => entry.length > 0).join("\n"),
    );
  }
}

export default function setup(): void {
  const sourceBefore = resolveSourceIdentity(repoRoot);
  removeBuildOutputs();
  runNode(
    [path.join(repoRoot, "packages/protocol/scripts/generate-types.mjs")],
    "protocol test generation",
  );
  runNode(
    [path.join(repoRoot, "packages/protocol/scripts/clean.mjs")],
    "protocol test clean",
  );
  const tsc = path.join(repoRoot, "node_modules/typescript/lib/tsc.js");
  for (
    const workspace of [
      "protocol",
      "rbp-conformance",
      "addin-loopback-fixture",
      "gateway-stub",
      "bridge-simulator",
    ]
  ) {
    runNode(
      [
        tsc,
        "-p",
        path.join(repoRoot, `packages/${workspace}/tsconfig.json`),
        "--pretty",
        "false",
      ],
      `${workspace} test build`,
    );
  }
  runNode(
    [path.join(packageRoot, "scripts/smoke-better-sqlite3.mjs")],
    "better-sqlite3 test smoke",
  );
  const git = resolveProductionGitIdentity(resolveGitExecutableOnPath());
  const sourceAfter = resolveSourceIdentity(repoRoot, git);
  if (stableJson(sourceAfter) !== stableJson(sourceBefore)) {
    throw new Error("production test build changed clean source identity");
  }
  createProductionBuildProvenanceSidecars(repoRoot, sourceAfter, {
    buildNodeExecutable: process.execPath,
    runtimeNodeExecutable: process.execPath,
    npmExecutable: npmEntrypoint(),
    gitExecutable: git.path,
  });
  const plan = buildProductionExecutionPlan({
    repoRoot,
    runId: "rbp-conformance-test-current-production",
    sequence: 1,
    nodeExecutable: process.execPath,
    gitExecutable: git.path,
  });
  mkdirSync(path.dirname(planFile), { recursive: true });
  writeFileSync(planFile, stableJson(plan), "utf8");
  process.env.RBP_TEST_PRODUCTION_PLAN = planFile;
  process.env.RBP_TEST_REPO_ROOT = repoRoot;
}
