// The single attested production preparation for one suite invocation.
//
// This used to live in tests/globalSetup.ts, which vitest runs once per shard.
// scripts/run-tests.mjs launches 5 shards sequentially, so the preparation --
// measured at ~173 s on the Windows runner -- was performed five times, roughly
// 14 minutes of the suite's 42-46 minute wall clock. The runner now calls this
// once and hands the result to every shard.
//
// It is a .mjs module rather than TypeScript because run-tests.mjs is plain
// node and cannot import TS. tests/globalSetup.ts already imports
// scripts/production-launch-bootstrap.mjs across the same boundary.
//
// The preparation itself is unchanged and moved verbatim: same wrapper, same
// arguments, same environment scrubbing, same 420 s budget, same error strings.
// What is added is the plan digest, which is what lets a shard prove the plan
// it reads is the artifact this attested run produced rather than bytes that
// merely look self-consistent.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { productionLaunchPowerShellArguments } from "./production-launch-bootstrap.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = path.resolve(packageRoot, "..", "..");
export const planFile = path.join(
  repoRoot,
  "artifacts",
  "conformance",
  "rbp-v1",
  "1.0",
  "test-support",
  "current-production-plan.json",
);

function npmEntrypoint() {
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

function systemPowerShell() {
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

function systemGit() {
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

export function repositoryIdentity() {
  const readRevision = (revision) => {
    const result = spawnSync(
      systemGit(),
      ["-C", repoRoot, "rev-parse", "--verify", revision],
      { encoding: "utf8", shell: false, windowsHide: true },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `production test setup could not resolve ${revision}: ${String(result.stderr).trim()}`,
      );
    }
    return String(result.stdout).trim();
  };
  return {
    commit: readRevision("HEAD^{commit}"),
    tree: readRevision("HEAD^{tree}"),
  };
}

function testLauncherEnvironment() {
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

/**
 * Runs the attested preparation once and returns the identity a shard must match.
 *
 * `planSha256` is deliberately computed here and never written to disk. A shard
 * compares the plan file's bytes against it, so an attacker who can rewrite the
 * plan -- it is gitignored and freely writable -- cannot also rewrite the value
 * it is checked against. That is what makes the shard-side re-verification a
 * proof rather than a recomputation that a self-consistent forged set satisfies.
 */
export function prepareCurrentProductionPlan({ nodeExecutable = process.execPath } = {}) {
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
    nodeExecutable,
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

  if (!existsSync(planFile)) {
    throw new Error(
      `canonical production test preparation reported success but wrote no plan at ${planFile}`,
    );
  }
  const raw = readFileSync(planFile, "utf8");
  // Must match src/stableJson.ts sha256Text exactly; the shard side hashes with
  // that function and compares against this value.
  const planSha256 = createHash("sha256").update(raw, "utf8").digest("hex");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `canonical production test preparation wrote an unparseable plan at ${planFile}`,
      { cause: error },
    );
  }
  if (
    parsed?.source?.commitSha !== identity.commit ||
    parsed?.source?.treeSha !== identity.tree
  ) {
    throw new Error(
      "canonical production test preparation wrote a plan for a different source: " +
        `plan ${String(parsed?.source?.commitSha)}/${String(parsed?.source?.treeSha)} ` +
        `vs head ${identity.commit}/${identity.tree}`,
    );
  }

  return {
    planFile,
    repoRoot,
    commitSha: identity.commit,
    treeSha: identity.tree,
    planSha256,
    elapsedMs,
  };
}
