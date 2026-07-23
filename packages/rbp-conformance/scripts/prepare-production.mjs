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

function childEnvironment() {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (
      resolutionEnvironmentKeys.has(normalized) ||
      normalized.startsWith("GIT_") ||
      normalized === "NPM_CONFIG_IGNORE_SCRIPTS" ||
      normalized === "PATH"
    ) {
      continue;
    }
    result[key] = value;
  }
  result.npm_config_ignore_scripts = "false";
  result.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;
  return result;
}

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

const npmEntrypoint = process.env.npm_execpath;
if (npmEntrypoint === undefined) {
  throw new Error(
    "canonical production preparation must be invoked through npm run prepare:rbp-production",
  );
}
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
    ? run("where.exe", ["git.exe"])
    : run("sh", ["-c", "command -v git"]);
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
  const result = run(gitIdentity.real, args);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${String(result.stderr).trim()}`);
  }
  assertSameGit(gitIdentity);
  return result;
}

const status = runGit(
  ["status", "--porcelain=v1", "--untracked-files=all"],
  "Git status",
);
if (String(status.stdout).length > 0) {
  throw new Error("canonical production preparation requires an exactly clean source tree");
}

function runNpm(args, label, options = {}) {
  assertSameFile(npmIdentity, "npm launcher");
  assertSameFile(nodeIdentity, "build Node executable");
  const result = run(process.execPath, [npmIdentity.path, ...args], options);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${String(result.status)}): ${String(result.stderr).trim()}`,
    );
  }
  assertSameFile(npmIdentity, "npm launcher");
  assertSameFile(nodeIdentity, "build Node executable");
  return result;
}

const ignoreScripts = runNpm(
  ["config", "get", "ignore-scripts"],
  "npm lifecycle configuration probe",
);
if (String(ignoreScripts.stdout).trim() !== "false") {
  throw new Error("canonical npm lifecycle scripts are not enabled");
}

const nativeSmoke = run(
  process.execPath,
  ["packages/rbp-conformance/scripts/smoke-better-sqlite3.mjs"],
);
if (nativeSmoke.status !== 0) {
  throw new Error(
    `better-sqlite3 native smoke failed before build: ${String(nativeSmoke.stderr).trim()}`,
  );
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

runNpm(
  ["run", "build:self", "--workspace", "@revagent/protocol"],
  "protocol bootstrap build",
  { stdio: ["ignore", "inherit", "inherit"] },
);
runNpm(
  ["run", "build:self", "--workspace", "@revagent/rbp-conformance"],
  "rbp-conformance build",
  { stdio: ["ignore", "inherit", "inherit"] },
);

const cli = path.join(repoRoot, "packages/rbp-conformance/dist/src/cli.js");
const prepare = run(
  process.execPath,
  [cli, "prepare-production", ...process.argv.slice(2)],
  { stdio: ["ignore", "inherit", "inherit"] },
);
assertSameFile(npmIdentity, "npm launcher");
assertSameFile(nodeIdentity, "build Node executable");
assertSameGit(gitIdentity);
if (prepare.status !== 0) {
  process.exitCode = prepare.status ?? 1;
}
