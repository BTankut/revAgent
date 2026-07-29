import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Test support may construct the canonical host arguments from the exact
// checked-out commit. Production evidence still requires an independently
// reviewed authority vector retained outside the checkout.
// @ts-expect-error -- the runtime bootstrap has no TypeScript declaration file.
import { productionLaunchPowerShellArguments } from "../scripts/production-launch-bootstrap.mjs";

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
  const programFiles = process.env.ProgramFiles;
  if (programFiles === undefined) {
    throw new Error("production test setup could not resolve Program Files");
  }
  const executable = path.join(
    programFiles,
    "nodejs",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!existsSync(executable)) {
    throw new Error(
      `production test setup could not find exact Program Files npm: ${executable}`,
    );
  }
  return executable;
}

function systemPowerShell(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (windowsRoot === undefined) {
    throw new Error("production test setup could not resolve SystemRoot");
  }
  const executable = path.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!existsSync(executable)) {
    throw new Error(
      `production test setup could not find exact Windows PowerShell: ${executable}`,
    );
  }
  return executable;
}

function systemGit(): string {
  const programFiles = process.env.ProgramFiles;
  if (programFiles === undefined) {
    throw new Error("production test setup could not resolve Program Files");
  }
  const executable = path.join(programFiles, "Git", "bin", "git.exe");
  if (!existsSync(executable)) {
    throw new Error(
      `production test setup could not find exact Program Files Git: ${executable}`,
    );
  }
  return executable;
}

function repositoryIdentity(): { commit: string; tree: string } {
  const readRevision = (revision: string): string => {
    const result = spawnSync(
      systemGit(),
      ["-C", repoRoot, "rev-parse", "--verify", revision],
      {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `production test setup could not resolve ${revision}: ${String(
          result.stderr,
        ).trim()}`,
      );
    }
    return String(result.stdout).trim();
  };
  return {
    commit: readRevision("HEAD^{commit}"),
    tree: readRevision("HEAD^{tree}"),
  };
}

function testLauncherEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "NPM_EXECPATH" ||
      normalized === "NPM_NODE_EXECPATH" ||
      normalized.startsWith("NPM_LIFECYCLE_")
    ) {
      delete environment[key];
    }
  }
  return environment;
}

export default function setup(): void {
  const powershell = systemPowerShell();
  const identity = repositoryIdentity();
  const commandArguments = [
    "--npm-executable",
    npmEntrypoint(),
    planFile,
    "--run-id",
    "rbp-conformance-test-current-production",
    "--sequence",
    "1",
    "--repo-root",
    repoRoot,
    "--node-executable",
    process.execPath,
  ];
  // Record how long this actually took. Without it, a timeout here reports
  // only that a budget was exceeded and never how close the healthy runs were,
  // which is what made the earlier 180 s expiry impossible to interpret.
  const startedAt = Date.now();
  const result = spawnSync(
    powershell,
    productionLaunchPowerShellArguments({
      repoRoot,
      role: "prepare-wrapper",
      expectedCommit: identity.commit,
      expectedTree: identity.tree,
      commandArguments,
      powershellExecutable: powershell,
    }),
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: testLauncherEnvironment(),
      shell: false,
      // The measured cost of this bootstrap on the Windows runner has reached
      // ~173 s, so the previous 180 s budget left a few percent of headroom and
      // turned any host slowdown straight into a red build. Sized against the
      // observed worst case with room to spare instead.
      timeout: 420_000,
      windowsHide: true,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  if (result.error !== undefined) {
    throw new Error(
      `canonical production test preparation failed after ${String(elapsedMs)}ms ` +
        `(budget 420000ms): ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `canonical production test preparation failed (exit ${String(result.status)}) ` +
          `after ${String(elapsedMs)}ms`,
        String(result.stdout).trim(),
        String(result.stderr).trim(),
      ].filter((entry) => entry.length > 0).join("\n"),
    );
  }
  console.log(`[globalSetup] canonical production preparation took ${String(elapsedMs)}ms`);
  process.env.RBP_TEST_PRODUCTION_PLAN = planFile;
  process.env.RBP_TEST_REPO_ROOT = repoRoot;
}
