import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const realTrioRepoRoot = path.resolve(packageRoot, "..", "..");
export const REAL_TRIO_PREFLIGHT_ENVIRONMENT = "REVAGENT_REAL_TRIO_PREFLIGHT";
export const REAL_TRIO_REQUIRED_ARTIFACTS = Object.freeze([
  "packages/gateway/dist/productionConformanceHostCli.js",
  "packages/addin-loopback-fixture/dist/cli.js",
  "packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/bin/Release/net9.0/win-x64/publish/RevAgent.Bridge.RealWorkerHost.exe",
]);

const FORBIDDEN_REAL_TRIO_REFERENCES = Object.freeze([
  /\bcaseStackSupervisor\b/u,
  /\bglobalSetup\b/u,
  /\b(?:gateway_stub|bridge_simulator|GatewayStubProcess)\b/u,
]);

function sha256File(target) {
  return createHash("sha256").update(readFileSync(target)).digest("hex");
}

function shellEnvironment() {
  const nodeDirectory = path.dirname(process.execPath);
  const separator = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${nodeDirectory}${separator}${process.env.PATH ?? ""}`,
  };
}

function requiredProgramFilesExecutable(...segments) {
  const programFiles = process.env.ProgramFiles;
  if (programFiles === undefined || programFiles.length === 0) {
    throw new Error("real-trio preflight could not resolve Program Files");
  }
  const executable = path.join(programFiles, ...segments);
  if (!existsSync(executable)) {
    throw new Error(`real-trio preflight required executable is missing: ${executable}`);
  }
  return executable;
}

function git(repoRoot, args) {
  const executable = requiredProgramFilesExecutable("Git", "bin", "git.exe");
  const result = execFileSync(executable, ["-C", repoRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: shellEnvironment(),
  });
  return String(result).trim();
}

export function assertRealTrioNode24(runtime = process.versions) {
  const major = Number(String(runtime.node ?? "").split(".", 1)[0]);
  if (!Number.isInteger(major) || major < 24 || String(runtime.modules) !== "137") {
    throw new Error(
      `real-trio runner requires Node >=24 with ABI 137; received Node ${String(runtime.node)} ABI ${String(runtime.modules)}`,
    );
  }
}

export function assertCleanRealTrioSource(status, commit, tree) {
  if (typeof status !== "string" || status.length !== 0) {
    throw new Error("real-trio preflight requires a clean committed worktree");
  }
  for (const [label, value] of [["commit", commit], ["tree", tree]]) {
    if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/u.test(value)) {
      throw new Error(`real-trio preflight received an invalid HEAD ${label}`);
    }
  }
}

export function assertNoForbiddenRealTrioReferences(source, label = "real-trio source") {
  for (const forbidden of FORBIDDEN_REAL_TRIO_REFERENCES) {
    if (forbidden.test(source)) {
      throw new Error(`${label} imports or identifies a forbidden legacy/stub component`);
    }
  }
}

function assertRealTrioSourceIsolation(repoRoot) {
  const sources = [
    "packages/rbp-conformance/tests/realTrioRuntime.test.ts",
    "packages/rbp-conformance/tests/realTrioRuntimeFixture.ts",
    "packages/rbp-conformance/src/realTrioCaseDriver.ts",
    "packages/rbp-conformance/src/realTrioMcpClient.ts",
    "packages/rbp-conformance/src/realTrioProcessHarness.ts",
    "packages/rbp-conformance/src/realTrioSupervisor.ts",
  ];
  for (const relative of sources) {
    const candidate = path.join(repoRoot, relative);
    if (!existsSync(candidate)) {
      throw new Error(`real-trio preflight source is missing: ${relative}`);
    }
    assertNoForbiddenRealTrioReferences(readFileSync(candidate, "utf8"), relative);
  }
}

function buildRealTrioArtifacts(repoRoot) {
  const npmCli = requiredProgramFilesExecutable("nodejs", "node_modules", "npm", "bin", "npm-cli.js");
  const dotnet = requiredProgramFilesExecutable("dotnet", "dotnet.exe");
  const run = (executable, args) => {
    const result = spawnSync(executable, args, {
      cwd: repoRoot,
      env: shellEnvironment(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `real-trio build failed: ${executable} ${args.join(" ")}\n${String(result.stderr ?? "").trim()}`,
      );
    }
  };
  for (const workspace of ["@revagent/protocol", "@revagent/addin-loopback-fixture", "@revagent/gateway"]) {
    run(process.execPath, [npmCli, "run", "build", "--workspace", workspace]);
  }
  const artifactsPath = mkdtempSync(path.join(tmpdir(), "revagent-wp12-real-trio-preflight-"));
  const project = "packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/RevAgent.Bridge.RealWorkerHost.csproj";
  run(dotnet, [
    "restore",
    project,
    "--locked-mode",
    "--runtime", "win-x64",
    "--artifacts-path", artifactsPath,
  ]);
  run(dotnet, [
    "build",
    project,
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--no-restore",
    "--artifacts-path", artifactsPath,
  ]);
  const output = path.join(artifactsPath, "publish");
  run(dotnet, [
    "publish",
    project,
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--self-contained", "false",
    "-p:UseAppHost=true",
    "--no-restore",
    "--artifacts-path", artifactsPath,
    "--output", output,
  ]);
  return path.join(output, "RevAgent.Bridge.RealWorkerHost.exe");
}

export function realTrioArtifactHashes(repoRoot = realTrioRepoRoot, workerPath = undefined) {
  const hashes = {};
  for (const relative of REAL_TRIO_REQUIRED_ARTIFACTS) {
    const candidate = relative.endsWith("RevAgent.Bridge.RealWorkerHost.exe") && workerPath !== undefined
      ? workerPath
      : path.join(repoRoot, relative);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new Error(`real-trio preflight required artifact is missing: ${relative}`);
    }
    hashes[relative] = sha256File(realpathSync(candidate));
  }
  return Object.freeze(hashes);
}

function identity(repoRoot) {
  const status = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const commit = git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const tree = git(repoRoot, ["rev-parse", "--verify", "HEAD^{tree}"]);
  assertCleanRealTrioSource(status, commit, tree);
  return { commit, tree };
}

export function runRealTrioPreflight({ repoRoot = realTrioRepoRoot } = {}) {
  assertRealTrioNode24();
  const source = identity(repoRoot);
  assertRealTrioSourceIsolation(repoRoot);
  const workerPath = buildRealTrioArtifacts(repoRoot);
  // A publish that edits a lockfile or another tracked source receipt cannot
  // become evidence for the commit we anchored above. Re-read the exact source
  // identity before admitting any child process.
  const afterBuild = identity(repoRoot);
  if (afterBuild.commit !== source.commit || afterBuild.tree !== source.tree) {
    throw new Error("real-trio build changed the exact source identity");
  }
  const artifacts = realTrioArtifactHashes(repoRoot, workerPath);
  const handoff = Object.freeze({
    schemaVersion: "revagent.wp12-real-trio-preflight/v1",
    repoRoot: realpathSync(repoRoot),
    ...source,
    workerPath: realpathSync(workerPath),
    artifacts,
  });
  process.env[REAL_TRIO_PREFLIGHT_ENVIRONMENT] = JSON.stringify(handoff);
  return handoff;
}

export function verifyRealTrioPreflightHandoff({ repoRoot = realTrioRepoRoot, environment = process.env } = {}) {
  const raw = environment[REAL_TRIO_PREFLIGHT_ENVIRONMENT];
  if (raw === undefined || raw.length === 0) return null;
  let handoff;
  try {
    handoff = JSON.parse(raw);
  } catch {
    throw new Error("real-trio preflight handoff is not valid JSON");
  }
  assertRealTrioNode24();
  const source = identity(repoRoot);
  if (
    handoff?.schemaVersion !== "revagent.wp12-real-trio-preflight/v1" ||
    handoff.repoRoot !== realpathSync(repoRoot) ||
    typeof handoff.workerPath !== "string" ||
    handoff.commit !== source.commit ||
    handoff.tree !== source.tree ||
    JSON.stringify(handoff.artifacts) !== JSON.stringify(realTrioArtifactHashes(repoRoot, handoff.workerPath))
  ) {
    throw new Error("real-trio preflight handoff no longer matches this exact clean source/build");
  }
  assertRealTrioSourceIsolation(repoRoot);
  return handoff;
}
