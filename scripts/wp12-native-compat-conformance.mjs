import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This is intentionally a standalone, fail-closed compatibility probe.  It is
// run after CI has rebuilt the workspace native module; it does not accept a
// prebuilt binary as evidence on Linux.
const BETTER_SQLITE3 = Object.freeze({
  version: "13.0.3",
  integrity: "sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==",
  gitHead: "dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb",
});
const LEGACY = Object.freeze({
  version: "12.9.0",
  integrity: "sha512-wqUv4Gm3toFpHDQmaKD4QhZm3g1DjUBI0yzS4UBl6lElUmXFYdTQmmEDpAFa5o8FiFiymURypEnfVHzILKaxqQ==",
});
const NODE_ADDON_API = Object.freeze({
  version: "8.9.2",
  integrity: "sha512-VijLXbi3UACN69I0JVXJsX4tjACjNoQDgv2gTF6sx2wWEi8tkSg2eX8p5gSIFi8z2+DL3oHmY6OyKce38SDolg==",
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayOwnerPackageJson = join(root, "packages", "gateway", "package.json");
const cleanupRoots = [];
let trustedNpm = null;
const results = {
  schemaVersion: "wp12-native-compat-conformance/v1",
  nodeMajor: Number.parseInt(process.versions.node.split(".")[0], 10),
  platform: process.platform,
  betterSqlite3: BETTER_SQLITE3.version,
  lock: false,
  installed: false,
  linuxSourceRebuild: process.platform === "linux" ? false : null,
  nativeSmoke: false,
  legacyReopen: false,
  walFullCas: false,
  competingLeaseRounds: 0,
  childExits: 0,
  workerTerminates: 0,
  teardownOpenCloses: 0,
};

function fail(message) {
  throw new Error(`WP-12 native compatibility conformance failed: ${message}`);
}

function normalizeChildDiagnostic(value, redactValues = []) {
  let normalized = String(value ?? "").replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  normalized = normalized
    .replace(/(?:\\\\\?\\)?[A-Za-z]:\\[^\r\n"']+/gu, "<path>")
    .replace(/\/(?:tmp|home|Users|workspace)\/[^\s"']+/gu, "<path>");
  const redactions = new Set([
    root,
    tmpdir(),
    ...cleanupRoots,
    ...Object.values(process.env),
    ...redactValues,
  ].filter((item) => typeof item === "string" && item.length >= 4));
  for (const secret of redactions) normalized = normalized.replaceAll(secret, "<redacted>");
  return normalized.slice(0, 2048);
}

function classifyChildFailure(stderr, error) {
  const diagnostic = `${stderr ?? ""}\n${error?.message ?? ""}`;
  if (diagnostic.includes("NODE_MODULE_VERSION") || diagnostic.includes("ERR_DLOPEN_FAILED")) return "node-abi-mismatch";
  if (diagnostic.includes("Could not locate the bindings file")) return "native-binding-unavailable";
  if (diagnostic.includes("Cannot find module")) return "module-resolution";
  if (diagnostic.includes("ELIFECYCLE")) return "lifecycle";
  return "unknown";
}

function failedChildMessage(command, completed, redactValues = []) {
  const exit = completed.status === null ? "none" : String(completed.status);
  const signal = completed.signal ?? "none";
  const category = classifyChildFailure(completed.stderr, completed.error);
  const output = normalizeChildDiagnostic(
    `stdout=${String(completed.stdout ?? "")} stderr=${String(completed.stderr ?? "")}`,
    redactValues,
  );
  return `subprocess ${basename(command)} failed (exit=${exit}; signal=${signal}; category=${category}; output=${output || "<empty>"})`;
}

function assertDiagnosticRedaction() {
  const sentinel = "WP12_DIAGNOSTIC_SECRET_SENTINEL";
  const raw = `stderr ${root} ${join(tmpdir(), "wp12-secret-path")} ${sentinel} ${"x".repeat(4096)}`;
  const normalized = normalizeChildDiagnostic(raw, [sentinel]);
  if (normalized.includes(root) || normalized.includes(sentinel) || normalized.length > 2048) {
    fail("child diagnostic redaction regression");
  }
}

function expectRejected(operation, label) {
  try {
    operation();
  } catch {
    return;
  }
  fail(`native trust self-test accepted ${label}`);
}

function assertNativeTrustSelfTests() {
  const trustedRoot = process.platform === "win32" ? "C:\\trusted" : "/trusted";
  const foreignRoot = process.platform === "win32" ? "C:\\foreign" : "/foreign";
  const separator = process.platform === "win32" ? "\\" : "/";
  assertNoNpmOverride(undefined);
  expectRejected(() => assertNoNpmOverride(`${foreignRoot}${separator}npm-cli.js`), "REVAGENT_NPM_CLI override");
  assertNoNodePath(undefined);
  expectRejected(() => assertNoNodePath(`${foreignRoot}${separator}node_modules`), "NODE_PATH override");
  assertContained(`${trustedRoot}${separator}npm${separator}bin${separator}npm-cli.js`, trustedRoot, "valid npm context");
  expectRejected(() => assertContained(`${foreignRoot}${separator}npm-cli.js`, trustedRoot, "foreign npm context"), "foreign npm context");
  expectRejected(() => assertCanonicalPath(`${trustedRoot}${separator}link${separator}npm-cli.js`, `${trustedRoot}${separator}real${separator}npm-cli.js`, "npm_execpath"), "npm symlink");
  expectRejected(() => assertContained(`${foreignRoot}${separator}package.json`, `${trustedRoot}${separator}repo`, "native owner package.json"), "foreign owner");
  assertModuleVersion(BETTER_SQLITE3.version, BETTER_SQLITE3.version, "valid workspace owner");
  assertModuleVersion(LEGACY.version, LEGACY.version, "valid temporary owner");
  expectRejected(() => assertModuleVersion("12.9.0", BETTER_SQLITE3.version, "better-sqlite3"), "version mismatch");
}

function isContained(path, container) {
  const difference = relative(container, path);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

function assertContained(path, container, label) {
  if (!isContained(path, container)) fail(`${label} escapes its trusted container`);
}

function assertNoNodePath(value) {
  if (typeof value === "string" && value.length > 0) fail("NODE_PATH is forbidden for native module conformance");
}

function assertNoNpmOverride(value) {
  if (value !== undefined) fail("REVAGENT_NPM_CLI is forbidden; invoke through the paired trusted npm executable");
}

function assertCanonicalPath(input, canonical, label) {
  if (resolve(input) !== canonical) fail(`${label} must not be a symlink or alternate path`);
}

function assertModuleVersion(value, expected, label) {
  if (value !== expected) fail(`${label} version mismatch`);
}

async function resolveTrustedNpmContext() {
  assertNoNpmOverride(process.env.REVAGENT_NPM_CLI);
  assertNoNodePath(process.env.NODE_PATH);
  const npmExecPath = process.env.npm_execpath;
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0) {
    fail("trusted npm context is required; invoke via the paired npm executable (npm exec -- node scripts/wp12-native-compat-conformance.mjs)");
  }
  const nodeExecutable = await realpath(process.execPath);
  const npmExecutable = await realpath(npmExecPath);
  assertCanonicalPath(npmExecPath, npmExecutable, "npm_execpath");
  if (basename(npmExecutable) !== "npm-cli.js") fail("npm_execpath is not npm-cli.js");
  const nodeDirectory = dirname(nodeExecutable);
  const distributionRoot = basename(nodeDirectory).toLowerCase() === "bin" ? dirname(nodeDirectory) : nodeDirectory;
  assertContained(npmExecutable, distributionRoot, "npm_execpath");
  const npmPackageJson = join(dirname(dirname(npmExecutable)), "package.json");
  const npmPackageJsonReal = await realpath(npmPackageJson);
  assertCanonicalPath(npmPackageJson, npmPackageJsonReal, "npm package.json");
  assertContained(npmPackageJsonReal, distributionRoot, "npm package.json");
  const npmPackage = await readJson(npmPackageJsonReal);
  if (npmPackage.name !== "npm" || typeof npmPackage.version !== "string" || npmPackage.version.length === 0) {
    fail("npm_execpath package identity is invalid");
  }
  return Object.freeze({ executable: npmExecutable, packageJson: npmPackageJsonReal, distributionRoot });
}

function run(command, args, options = {}) {
  const isNpm = command === "npm";
  if (isNpm && trustedNpm === null) fail("trusted npm context was not established before npm invocation");
  const executable = isNpm ? process.execPath : command;
  const commandArgs = isNpm ? [trustedNpm.executable, ...args] : args;
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const pairedNodePath = isNpm ? {
    [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ""}`,
  } : {};
  const completed = spawnSync(executable, commandArgs, {
    cwd: options.cwd,
    env: { ...process.env, ...pairedNodePath, ...options.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (completed.status !== 0 || completed.signal !== null || completed.error !== undefined) {
    fail(failedChildMessage(command, completed, Object.values(options.env ?? {})));
  }
  return completed.stdout;
}

async function resolveInstalledModule(ownerPackageJson, ownerRoot, expectedVersion, expectedModuleRoot = undefined) {
  const ownerRootReal = await realpath(ownerRoot);
  const owner = await realpath(ownerPackageJson);
  assertCanonicalPath(ownerPackageJson, owner, "native owner package.json");
  assertContained(owner, ownerRootReal, "native owner package.json");
  const entry = await realpath(createRequire(owner).resolve("better-sqlite3"));
  const packageRoot = await realpath(dirname(dirname(entry)));
  assertContained(packageRoot, ownerRootReal, "better-sqlite3 package");
  if (expectedModuleRoot !== undefined && packageRoot !== expectedModuleRoot) {
    fail("better-sqlite3 package resolved outside its approved native owner");
  }
  const packageJson = await realpath(join(packageRoot, "package.json"));
  assertContained(packageJson, packageRoot, "better-sqlite3 package.json");
  const manifest = await readJson(packageJson);
  assertModuleVersion(manifest.version, expectedVersion, "installed better-sqlite3");
  return Object.freeze({ ownerPackageJson: owner, ownerRoot: ownerRootReal, entry, packageRoot, packageJson });
}

function verifyNativeLoad(native) {
  const code = `${childNativeLoaderSource()} const db = new Database(':memory:'); try { if (db.prepare('SELECT 1 AS value').get()?.value !== 1) process.exitCode = 24; } finally { db.close(); }`;
  run(process.execPath, ["-e", code], { env: childNativeEnvironment(native) });
}

function childNativeEnvironment(native, extra = {}) {
  const environment = {
    ...process.env,
    REVAGENT_SQLITE_OWNER_PACKAGE_JSON: native.ownerPackageJson,
    REVAGENT_SQLITE_ENTRY: native.entry,
    REVAGENT_SQLITE_OWNER_ROOT: native.ownerRoot,
    REVAGENT_SQLITE_MODULE_ROOT: native.packageRoot,
    ...extra,
  };
  delete environment.NODE_PATH;
  return environment;
}

async function cleanupArtifacts() {
  for (const path of cleanupRoots) {
    let lastError;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rm(path, { recursive: true, force: true, maxRetries: 0 });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100 * (attempt + 1)));
      }
    }
    if (lastError !== undefined) fail("bounded temporary native artifact cleanup failed");
  }
}

function assertPackage(record, expected, label) {
  if (record === undefined || record.version !== expected.version || record.integrity !== expected.integrity) {
    fail(`${label} provenance does not match the approved exact version and integrity`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function validateProvenance() {
  const repoRoot = await realpath(root);
  assertCanonicalPath(root, repoRoot, "repository root");
  const lock = await readJson(join(root, "package-lock.json"));
  const packagePaths = [
    "packages/gateway/node_modules/better-sqlite3",
    "packages/bridge-simulator/node_modules/better-sqlite3",
  ];
  for (const packagePath of packagePaths) {
    const record = lock.packages?.[packagePath];
    assertPackage(record, BETTER_SQLITE3, packagePath);
    if (record.resolved !== `https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-${BETTER_SQLITE3.version}.tgz`) {
      fail(`${packagePath} resolved outside the approved npm artifact`);
    }
    const dependencies = record.dependencies ?? {};
    if (dependencies["node-addon-api"] !== "^8.0.0" || "bindings" in dependencies || "prebuild-install" in dependencies) {
      fail(`${packagePath} has an obsolete native-loader closure`);
    }
  }
  assertPackage(lock.packages?.["node_modules/node-addon-api"], NODE_ADDON_API, "node-addon-api");
  const publishedGitHead = JSON.parse(run("npm", ["view", `better-sqlite3@${BETTER_SQLITE3.version}`, "gitHead", "--json"]));
  if (publishedGitHead !== BETTER_SQLITE3.gitHead) {
    fail("better-sqlite3 registry gitHead differs from the approved source revision");
  }
  results.lock = true;

  const gateway = await resolveInstalledModule(gatewayOwnerPackageJson, repoRoot, BETTER_SQLITE3.version);
  const bridge = await resolveInstalledModule(join(root, "packages", "bridge-simulator", "package.json"), repoRoot, BETTER_SQLITE3.version);
  const gatewayPackage = await readJson(gateway.packageJson);
  const bridgePackage = await readJson(bridge.packageJson);
  for (const installed of [gatewayPackage, bridgePackage]) {
    if (installed.version !== BETTER_SQLITE3.version || installed.dependencies?.["node-addon-api"] !== "^8.0.0") {
      fail("installed better-sqlite3 package differs from the approved closure");
    }
    if ("bindings" in (installed.dependencies ?? {}) || "prebuild-install" in (installed.dependencies ?? {})) {
      fail("installed better-sqlite3 package retains an obsolete native loader");
    }
  }
  results.installed = true;
  return Object.freeze({ ...gateway, repoRoot });
}

async function createLegacySandbox() {
  const sandbox = await mkdtemp(join(tmpdir(), "revagent-wp12-sqlite-legacy-"));
  cleanupRoots.push(sandbox);
  await writeFile(join(sandbox, "package.json"), JSON.stringify({
    private: true,
    type: "commonjs",
    dependencies: { "better-sqlite3": LEGACY.version },
  }), "utf8");
  // Build the old reader from source as well. The lock proves the received
  // tarball before npm is allowed to lay out node_modules.
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: sandbox });
  const lock = await readJson(join(sandbox, "package-lock.json"));
  assertPackage(lock.packages?.["node_modules/better-sqlite3"], LEGACY, "legacy better-sqlite3");
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: sandbox });
  run("npm", ["rebuild", "better-sqlite3", "--ignore-scripts=false", "--foreground-scripts"], {
    cwd: sandbox,
    env: { npm_config_build_from_source: "true" },
  });
  const sandboxRoot = await realpath(sandbox);
  const expectedModuleRoot = await realpath(join(sandboxRoot, "node_modules", "better-sqlite3"));
  const owner = await resolveInstalledModule(
    join(sandboxRoot, "package.json"),
    sandboxRoot,
    LEGACY.version,
    expectedModuleRoot,
  );
  verifyNativeLoad(owner);
  return { sandbox: sandboxRoot, native: owner };
}

function childNativeLoaderSource() {
  return String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const { createRequire } = require("node:module");
    if (process.env.NODE_PATH) throw new Error("NODE_PATH forbidden in native child");
    const contained = (candidate, container) => { const difference = path.relative(container, candidate); return difference === "" || (!difference.startsWith(".." + path.sep) && difference !== ".." && !path.isAbsolute(difference)); };
    const owner = fs.realpathSync(process.env.REVAGENT_SQLITE_OWNER_PACKAGE_JSON);
    const ownerRoot = fs.realpathSync(process.env.REVAGENT_SQLITE_OWNER_ROOT);
    const expectedEntry = fs.realpathSync(process.env.REVAGENT_SQLITE_ENTRY);
    const expectedModuleRoot = fs.realpathSync(process.env.REVAGENT_SQLITE_MODULE_ROOT);
    if (!contained(owner, ownerRoot)) throw new Error("native owner escaped trusted root");
    const resolvedEntry = fs.realpathSync(createRequire(owner).resolve("better-sqlite3"));
    const moduleRoot = fs.realpathSync(path.dirname(path.dirname(resolvedEntry)));
    if (resolvedEntry !== expectedEntry || moduleRoot !== expectedModuleRoot || !contained(moduleRoot, ownerRoot)) throw new Error("native child trusted entry mismatch");
    const Database = createRequire(owner)("better-sqlite3");
  `;
}

function runDatabaseChild(native, databasePath, mode) {
  const code = String.raw`
    ${childNativeLoaderSource()}
    const db = new Database(process.env.REVAGENT_SQLITE_DB);
    try {
      if (process.env.REVAGENT_SQLITE_MODE === "seed") {
        db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
        db.exec("CREATE TABLE IF NOT EXISTS values_table (k TEXT PRIMARY KEY, v TEXT NOT NULL, version INTEGER NOT NULL)");
        db.prepare("INSERT OR REPLACE INTO values_table(k, v, version) VALUES (?, ?, ?)").run("legacy", "v12", 1);
      } else {
        const row = db.prepare("SELECT v, version FROM values_table WHERE k = ?").get("legacy");
        if (!row || row.v !== "v13" || row.version !== 2) process.exitCode = 23;
      }
    } finally { db.close(); }
  `;
  run(process.execPath, ["-e", code], {
    env: childNativeEnvironment(native, {
      REVAGENT_SQLITE_DB: databasePath,
      REVAGENT_SQLITE_MODE: mode,
    }),
  });
}

function runConcurrentLeaseRound(native, databasePath, round) {
  const code = String.raw`
    ${childNativeLoaderSource()}
    const db = new Database(process.env.REVAGENT_SQLITE_DB);
    let winner = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      const changed = db.prepare("UPDATE leases SET holder = ?, epoch = epoch + 1 WHERE id = ? AND epoch = ?").run(process.env.REVAGENT_HOLDER, "lease", Number(process.env.REVAGENT_EPOCH)).changes;
      db.exec("COMMIT"); winner = changed === 1;
    } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
    finally { db.close(); }
    process.stdout.write(winner ? "winner" : "loser");
  `;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["-e", code], {
      env: {
        ...childNativeEnvironment(native),
        REVAGENT_SQLITE_DB: databasePath,
        REVAGENT_HOLDER: `round-${round}-${Math.random().toString(16).slice(2)}`,
        REVAGENT_EPOCH: String(round),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += String(value); });
    child.stderr.on("data", (value) => { stderr += String(value); });
    child.once("error", (error) => rejectPromise(new Error(normalizeChildDiagnostic(
      `lease contender spawn failed (category=${classifyChildFailure(stderr, error)}; stdout=${stdout}; stderr=${stderr})`,
      [native.ownerPackageJson, native.entry, databasePath],
    ))));
    child.once("exit", (codeValue, signal) => {
      if (codeValue === 0 && signal === null && (stdout === "winner" || stdout === "loser")) resolvePromise(stdout);
      else rejectPromise(new Error(normalizeChildDiagnostic(
        `lease contender failed (exit=${codeValue ?? "none"}; signal=${signal ?? "none"}; category=${classifyChildFailure(stderr)}; stdout=${stdout}; stderr=${stderr})`,
        [native.ownerPackageJson, native.entry, databasePath],
      )));
    });
  });
}

async function runDatabaseCompatibility(current) {
  const stateRoot = await mkdtemp(join(tmpdir(), "revagent-wp12-sqlite-state-"));
  cleanupRoots.push(stateRoot);
  const databasePath = join(stateRoot, "compat.db");
  const legacy = await createLegacySandbox();
  runDatabaseChild(legacy.native, databasePath, "seed");

  const Database = createRequire(current.ownerPackageJson)("better-sqlite3");
  const db = new Database(databasePath);
  try {
    db.pragma("journal_mode = WAL", { simple: true });
    // Query the persisted value below rather than relying on a setter return.
    db.pragma("synchronous = FULL", { simple: true });
    if (db.pragma("journal_mode", { simple: true }) !== "wal" || Number(db.pragma("synchronous", { simple: true })) !== 2) {
      fail("SQLite did not retain required WAL/FULL semantics");
    }
    db.exec("BEGIN IMMEDIATE");
    const changed = db.prepare("UPDATE values_table SET v = ?, version = version + 1 WHERE k = ? AND version = ?").run("v13", "legacy", 1).changes;
    if (changed !== 1) fail("forward CAS did not commit exactly once");
    db.exec("COMMIT");
    db.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, holder TEXT NOT NULL, epoch INTEGER NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO leases(id, holder, epoch) VALUES (?, ?, ?)").run("lease", "seed", 0);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
  runDatabaseChild(legacy.native, databasePath, "verify");
  results.legacyReopen = true;
  results.walFullCas = true;

  for (let round = 0; round < 8; round += 1) {
    const contenders = await Promise.all(Array.from({ length: 4 }, () => runConcurrentLeaseRound(current, databasePath, round)));
    if (contenders.filter((value) => value === "winner").length !== 1) fail("BEGIN IMMEDIATE lease CAS admitted an invalid winner count");
    results.competingLeaseRounds += 1;
  }
}

async function runLifecycleStress(native) {
  const childCode = `${childNativeLoaderSource()} const db=new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();`;
  for (let index = 0; index < 100; index += 1) {
    run(process.execPath, ["-e", childCode], { env: childNativeEnvironment(native) });
    results.childExits += 1;
  }
  const workerCode = String.raw`
    const { parentPort } = require("node:worker_threads");
    ${childNativeLoaderSource()}
    const db = new Database(":memory:");
    db.prepare("SELECT 1").get(); db.close(); parentPort.postMessage("ready"); setInterval(() => {}, 1000);
  `;
  const workerFileRoot = await mkdtemp(join(tmpdir(), "revagent-wp12-sqlite-workers-"));
  cleanupRoots.push(workerFileRoot);
  const workerFile = join(workerFileRoot, "worker.cjs");
  await writeFile(workerFile, workerCode, "utf8");
  const { Worker } = await import("node:worker_threads");
  for (let batch = 0; batch < 10; batch += 1) {
    const workers = await Promise.all(Array.from({ length: 10 }, async () => {
      const worker = new Worker(workerFile, { env: childNativeEnvironment(native) });
      await new Promise((resolvePromise, rejectPromise) => {
        worker.once("message", (value) => value === "ready" ? resolvePromise() : rejectPromise(new Error("worker readiness drift")));
        worker.once("error", rejectPromise);
      });
      await worker.terminate();
      results.workerTerminates += 1;
    }));
    await Promise.all(workers);
  }
  const Database = createRequire(native.ownerPackageJson)("better-sqlite3");
  for (let index = 0; index < 100; index += 1) {
    const db = new Database(":memory:");
    db.prepare("SELECT 1").get();
    db.close();
    results.teardownOpenCloses += 1;
  }
}

async function main() {
  if (!Number.isInteger(results.nodeMajor) || results.nodeMajor < 22) fail("Node 22 or newer is required");
  assertDiagnosticRedaction();
  assertNativeTrustSelfTests();
  trustedNpm = await resolveTrustedNpmContext();
  const current = await validateProvenance();
  verifyNativeLoad(current);
  const packageRoot = dirname(dirname(current.entry));
  const Database = createRequire(current.ownerPackageJson)("better-sqlite3");
  const smoke = new Database(":memory:");
  try {
    if (smoke.prepare("SELECT 42 AS answer").get()?.answer !== 42) fail("native SQLite query did not return expected value");
  } finally { smoke.close(); }
  if (process.platform === "linux") {
    const binding = join(packageRoot, "build", "Release", "better_sqlite3.node");
    if (!existsSync(binding) || !(await stat(binding)).isFile()) fail("Linux native source rebuild binding is absent");
    results.linuxSourceRebuild = true;
  }
  results.nativeSmoke = true;
  await runDatabaseCompatibility(current);
  await runLifecycleStress(current);
}

let completed = false;
try {
  await main();
  completed = true;
} finally {
  await cleanupArtifacts();
}
if (completed) {
  process.stdout.write(`${JSON.stringify(results)}\n`);
}
