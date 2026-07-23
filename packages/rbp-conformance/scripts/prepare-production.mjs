import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertProductionBootstrapIdentityCurrent,
  canonicalWindowsWhereExecutable,
  captureProductionBootstrapIdentity,
  innerPrepareArguments,
  parsePrepareBootstrapArguments,
} from "./bootstrap-identity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const resolutionEnvironmentKeys = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "WS_NO_BUFFER_UTIL",
  "WS_NO_UTF_8_VALIDATE",
]);

const inheritedResolutionOverride = Object.keys(process.env).find((key) =>
  resolutionEnvironmentKeys.has(key.toUpperCase()));
if (inheritedResolutionOverride !== undefined) {
  throw new Error(
    `canonical production preparation environment cannot set ${inheritedResolutionOverride}`,
  );
}

function childEnvironment() {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (
      resolutionEnvironmentKeys.has(normalized) ||
      normalized.startsWith("GIT_") ||
      normalized.startsWith("NPM_CONFIG_") ||
      normalized === "NPM_EXECPATH" ||
      normalized === "NPM_NODE_EXECPATH" ||
      normalized.startsWith("NPM_LIFECYCLE_") ||
      normalized === "RBP_PRODUCTION_NPM_EXECUTABLE" ||
      normalized === "PATH"
    ) {
      continue;
    }
    result[key] = value;
  }
  result.PATH = "";
  return result;
}

function gitEnvironment() {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...childEnvironment(),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

const hardenedGitConfig = [
  "--no-replace-objects",
  "-c", "core.attributesfile=",
  "-c", "core.autocrlf=input",
  "-c", "core.excludesfile=",
  "-c", "core.fsmonitor=false",
  "-c", "core.ignorestat=false",
  "-c", "core.preloadindex=false",
  "-c", "core.useReplaceRefs=false",
  "-c", "core.safecrlf=false",
  "-c", "core.trustctime=true",
  "-c", "core.untrackedCache=false",
];

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function exactRegularFile(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const lexical = path.resolve(value);
  if (!existsSync(lexical) || !lstatSync(lexical).isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  if (lstatSync(lexical).isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link`);
  }
  const real = realpathSync(lexical);
  return { path: lexical, real, sha256: sha256File(real) };
}

function assertSameFile(expected, label) {
  const current = exactRegularFile(expected.path, label);
  if (current.real !== expected.real || current.sha256 !== expected.sha256) {
    throw new Error(`${label} changed during canonical preparation`);
  }
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: childEnvironment(),
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

if (
  Object.keys(process.env).some((key) =>
    key.toUpperCase() === "NPM_EXECPATH" ||
    key.toUpperCase().startsWith("NPM_LIFECYCLE_"))
) {
  throw new Error(
    "canonical production preparation must be invoked directly with the bound Node executable",
  );
}
const {
  forwardedArgs,
  npmExecutable: npmEntrypoint,
} = parsePrepareBootstrapArguments(process.argv.slice(2));
const npmIdentity = exactRegularFile(npmEntrypoint, "npm launcher");
const nodeIdentity = exactRegularFile(process.execPath, "build Node executable");

function gitVersion(identity) {
  const result = run(identity.real, ["--version"]);
  if (result.status !== 0) {
    throw new Error(`Git identity probe failed: ${String(result.stderr).trim()}`);
  }
  const version = String(result.stdout).trim();
  if (!/^git version [0-9]+\.[0-9]+\.[0-9]+/u.test(version)) {
    throw new Error(`Git identity probe returned an unexpected version: ${version}`);
  }
  return version;
}

function resolveGitIdentity() {
  const locator = process.platform === "win32"
    ? run(
      canonicalWindowsWhereExecutable(),
      ["git.exe"],
      { env: { ...childEnvironment(), PATH: process.env.PATH ?? "" } },
    )
    : run("/bin/sh", ["-c", "command -v git"], {
      env: { ...childEnvironment(), PATH: process.env.PATH ?? "" },
    });
  if (locator.status !== 0) {
    throw new Error(`cannot resolve Git: ${String(locator.stderr).trim()}`);
  }
  const selected = String(locator.stdout)
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (selected === undefined || !path.isAbsolute(selected)) {
    throw new Error("Git resolution did not return an absolute executable");
  }
  const file = exactRegularFile(selected, "Git executable");
  return { ...file, version: gitVersion(file) };
}

function assertSameGit(expected) {
  const currentFile = exactRegularFile(expected.path, "Git executable");
  const current = { ...currentFile, version: gitVersion(currentFile) };
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("Git executable changed during canonical preparation");
  }
}

const gitIdentity = resolveGitIdentity();

function runGit(args, label) {
  assertSameGit(gitIdentity);
  const result = run(gitIdentity.real, [...hardenedGitConfig, ...args], {
    env: gitEnvironment(),
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr).trim()}`);
  }
  assertSameGit(gitIdentity);
  return result;
}

function assertBootstrapSourceClean() {
  const assumed = String(runGit(["ls-files", "-v", "-z"], "Git index flag probe").stdout)
    .split("\0").filter(Boolean).find((record) => /^[a-z] /u.test(record));
  if (assumed !== undefined) {
    throw new Error(`canonical preparation rejects assume-unchanged: ${assumed.slice(2)}`);
  }
  const skipped = String(runGit(["ls-files", "-t", "-z"], "Git sparse flag probe").stdout)
    .split("\0").filter(Boolean).find((record) => record.startsWith("S "));
  if (skipped !== undefined) {
    throw new Error(`canonical preparation rejects skip-worktree: ${skipped.slice(2)}`);
  }
  const filters = run(gitIdentity.real, [
    ...hardenedGitConfig,
    "config",
    "--local",
    "--get-regexp",
    "^filter\\.",
  ], { env: gitEnvironment() });
  if (filters.status === 0 && String(filters.stdout).trim().length > 0) {
    throw new Error("canonical preparation rejects repository-local Git filters");
  }
  if (filters.status !== 0 && filters.status !== 1) {
    throw new Error(`Git local-filter probe failed: ${String(filters.stderr).trim()}`);
  }
  const replaceRefs = String(runGit(
    ["for-each-ref", "--format=%(refname)", "refs/replace"],
    "Git replace-ref probe",
  ).stdout).trim();
  if (replaceRefs.length > 0) {
    throw new Error("canonical preparation rejects Git replace refs");
  }
  const graftsPath = String(runGit(
    ["rev-parse", "--git-path", "info/grafts"],
    "Git graft path",
  ).stdout).trim();
  const absoluteGrafts = path.resolve(repoRoot, graftsPath);
  if (
    existsSync(absoluteGrafts) &&
    readFileSync(absoluteGrafts, "utf8").trim().length > 0
  ) {
    throw new Error("canonical preparation rejects legacy Git grafts");
  }
  const commit = String(runGit(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "Git protected commit",
  ).stdout).trim();
  const treeRows = String(runGit(
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    "Git protected tree",
  ).stdout).split("\0").filter(Boolean);
  const tree = treeRows.map((record) => {
    const match = /^([0-7]{6}) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(record);
    if (match === null || /[\r\n]/u.test(match[3])) {
      throw new Error(`unsupported protected tree entry: ${record}`);
    }
    return { mode: match[1], objectId: match[2], path: match[3] };
  });
  const indexRows = String(runGit(
    ["ls-files", "--stage", "-z"],
    "Git index tree",
  ).stdout).split("\0").filter(Boolean);
  if (indexRows.length !== tree.length) {
    throw new Error("Git index path set does not match protected HEAD");
  }
  indexRows.forEach((record, index) => {
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0\t(.+)$/u.exec(record);
    const expected = tree[index];
    if (
      match === null ||
      expected === undefined ||
      match[1] !== expected.mode ||
      match[2] !== expected.objectId ||
      match[3] !== expected.path
    ) {
      throw new Error(`Git index does not match protected HEAD at row ${String(index)}`);
    }
  });
  const hashResult = run(
    gitIdentity.real,
    [...hardenedGitConfig, "hash-object", "--no-filters", "--stdin-paths"],
    {
      env: gitEnvironment(),
      input: `${tree.map((entry) => entry.path).join("\n")}\n`,
    },
  );
  if (hashResult.status !== 0) {
    throw new Error(`Git tracked-byte hashing failed: ${String(hashResult.stderr).trim()}`);
  }
  const hashes = String(hashResult.stdout).trim().split(/\r?\n/u);
  if (hashes.length !== tree.length) {
    throw new Error("Git did not hash every protected tracked path");
  }
  hashes.forEach((hash, index) => {
    if (hash !== tree[index]?.objectId) {
      throw new Error(`tracked bytes do not match protected HEAD: ${tree[index]?.path}`);
    }
  });
  const untracked = String(runGit(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "Git untracked probe",
  ).stdout).split("\0").filter(Boolean);
  if (untracked.length > 0) {
    throw new Error(`canonical preparation rejects untracked path: ${untracked[0]}`);
  }
}
assertBootstrapSourceClean();
const bootstrapBuildDependencies = captureProductionBootstrapIdentity(repoRoot);

function runBoundNode(args, label, options = {}) {
  assertSameFile(npmIdentity, "npm launcher");
  assertSameFile(nodeIdentity, "build Node executable");
  assertProductionBootstrapIdentityCurrent(repoRoot, bootstrapBuildDependencies);
  let result;
  try {
    result = run(nodeIdentity.real, args, options);
  } finally {
    assertProductionBootstrapIdentityCurrent(repoRoot, bootstrapBuildDependencies);
    assertSameFile(npmIdentity, "npm launcher");
    assertSameFile(nodeIdentity, "build Node executable");
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${String(result.status)}): ${String(result.stderr).trim()}`,
    );
  }
  return result;
}

const harnessDist = path.join(repoRoot, "packages/rbp-conformance/dist");
if (existsSync(harnessDist)) {
  if (lstatSync(harnessDist).isSymbolicLink()) {
    throw new Error("refusing to clean a linked conformance harness output");
  }
  const resolved = realpathSync(harnessDist);
  const expected = path.resolve(repoRoot, "packages/rbp-conformance/dist");
  if (resolved !== expected) {
    throw new Error("conformance harness output resolves outside its canonical path");
  }
  rmSync(harnessDist, { recursive: true, force: true });
}

runBoundNode(
  [path.join(repoRoot, "packages/protocol/scripts/generate-types.mjs")],
  "protocol bootstrap generation",
  { stdio: ["ignore", "inherit", "inherit"] },
);
runBoundNode(
  [path.join(repoRoot, "packages/protocol/scripts/clean.mjs")],
  "protocol bootstrap clean",
  { stdio: ["ignore", "inherit", "inherit"] },
);
const typescriptEntrypoint = path.join(
  repoRoot,
  "node_modules/typescript/lib/tsc.js",
);
runBoundNode(
  [typescriptEntrypoint, "-p", path.join(repoRoot, "packages/protocol/tsconfig.json")],
  "protocol bootstrap TypeScript build",
  { stdio: ["ignore", "inherit", "inherit"] },
);
runBoundNode(
  [
    typescriptEntrypoint,
    "-p",
    path.join(repoRoot, "packages/rbp-conformance/tsconfig.json"),
  ],
  "rbp-conformance direct TypeScript build",
  { stdio: ["ignore", "inherit", "inherit"] },
);

const cli = path.join(repoRoot, "packages/rbp-conformance/dist/src/cli.js");
assertProductionBootstrapIdentityCurrent(repoRoot, bootstrapBuildDependencies);
const prepare = run(
  nodeIdentity.real,
  [cli, ...innerPrepareArguments(forwardedArgs, gitIdentity.path)],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...childEnvironment(),
      RBP_PRODUCTION_NPM_EXECUTABLE: npmIdentity.path,
    },
  },
);
assertSameFile(npmIdentity, "npm launcher");
assertSameFile(nodeIdentity, "build Node executable");
assertSameGit(gitIdentity);
if (prepare.status !== 0) {
  process.exitCode = prepare.status ?? 1;
}
