import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
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
const bridgeRequire = createRequire(join(root, "packages", "bridge-simulator", "package.json"));
const cleanupRoots = [];
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

function run(command, args, options = {}) {
  const npmCli = command === "npm" ? process.env.REVAGENT_NPM_CLI : undefined;
  if (npmCli !== undefined && !npmCli.startsWith("/") && !/^[A-Za-z]:\\/u.test(npmCli)) {
    fail("REVAGENT_NPM_CLI must be an absolute npm-cli.js path when set");
  }
  const useWindowsCommandProcessor = npmCli === undefined && process.platform === "win32" && command === "npm";
  const executable = npmCli === undefined ?
    (useWindowsCommandProcessor ? (process.env.ComSpec ?? "cmd.exe") : command) : process.execPath;
  const commandArgs = npmCli === undefined ?
    (useWindowsCommandProcessor ? ["/d", "/s", "/c", "npm.cmd", ...args] : args) : [npmCli, ...args];
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const pairedNodePath = npmCli === undefined ? {} : {
    [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ""}`,
  };
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

function resolveInstalledModule(ownerPackageJson) {
  const owner = resolve(ownerPackageJson);
  const entry = createRequire(owner).resolve("better-sqlite3");
  return { ownerPackageJson: owner, entry };
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

  const gateway = resolveInstalledModule(gatewayOwnerPackageJson);
  const gatewayEntry = gateway.entry;
  const bridgeEntry = bridgeRequire.resolve("better-sqlite3");
  const gatewayPackage = await readJson(join(dirname(dirname(gatewayEntry)), "package.json"));
  const bridgePackage = await readJson(join(dirname(dirname(bridgeEntry)), "package.json"));
  for (const installed of [gatewayPackage, bridgePackage]) {
    if (installed.version !== BETTER_SQLITE3.version || installed.dependencies?.["node-addon-api"] !== "^8.0.0") {
      fail("installed better-sqlite3 package differs from the approved closure");
    }
    if ("bindings" in (installed.dependencies ?? {}) || "prebuild-install" in (installed.dependencies ?? {})) {
      fail("installed better-sqlite3 package retains an obsolete native loader");
    }
  }
  results.installed = true;
  return gateway;
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
  const owner = resolveInstalledModule(join(sandbox, "package.json"));
  return { sandbox, ownerPackageJson: owner.ownerPackageJson };
}

function runDatabaseChild(ownerPackageJson, databasePath, mode) {
  const code = String.raw`
    const { createRequire } = require("node:module");
    const Database = createRequire(process.env.REVAGENT_SQLITE_OWNER_PACKAGE_JSON)("better-sqlite3");
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
    env: {
      REVAGENT_SQLITE_OWNER_PACKAGE_JSON: ownerPackageJson,
      REVAGENT_SQLITE_DB: databasePath,
      REVAGENT_SQLITE_MODE: mode,
    },
  });
}

function runConcurrentLeaseRound(ownerPackageJson, databasePath, round) {
  const code = String.raw`
    const { createRequire } = require("node:module");
    const Database = createRequire(process.env.REVAGENT_SQLITE_OWNER_PACKAGE_JSON)("better-sqlite3");
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
        ...process.env,
        REVAGENT_SQLITE_OWNER_PACKAGE_JSON: ownerPackageJson,
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
      [ownerPackageJson, databasePath],
    ))));
    child.once("exit", (codeValue, signal) => {
      if (codeValue === 0 && signal === null && (stdout === "winner" || stdout === "loser")) resolvePromise(stdout);
      else rejectPromise(new Error(normalizeChildDiagnostic(
        `lease contender failed (exit=${codeValue ?? "none"}; signal=${signal ?? "none"}; category=${classifyChildFailure(stderr)}; stdout=${stdout}; stderr=${stderr})`,
        [ownerPackageJson, databasePath],
      )));
    });
  });
}

async function runDatabaseCompatibility(currentOwnerPackageJson) {
  const stateRoot = await mkdtemp(join(tmpdir(), "revagent-wp12-sqlite-state-"));
  cleanupRoots.push(stateRoot);
  const databasePath = join(stateRoot, "compat.db");
  const legacy = await createLegacySandbox();
  runDatabaseChild(legacy.ownerPackageJson, databasePath, "seed");

  const Database = createRequire(currentOwnerPackageJson)("better-sqlite3");
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
  runDatabaseChild(legacy.ownerPackageJson, databasePath, "verify");
  results.legacyReopen = true;
  results.walFullCas = true;

  for (let round = 0; round < 8; round += 1) {
    const contenders = await Promise.all(Array.from({ length: 4 }, () => runConcurrentLeaseRound(currentOwnerPackageJson, databasePath, round)));
    if (contenders.filter((value) => value === "winner").length !== 1) fail("BEGIN IMMEDIATE lease CAS admitted an invalid winner count");
    results.competingLeaseRounds += 1;
  }
}

async function runLifecycleStress(ownerPackageJson) {
  const childCode = "const {createRequire}=require('node:module'); const D=createRequire(process.env.REVAGENT_SQLITE_OWNER_PACKAGE_JSON)('better-sqlite3'); const db=new D(':memory:'); db.prepare('SELECT 1').get(); db.close();";
  for (let index = 0; index < 100; index += 1) {
    run(process.execPath, ["-e", childCode], { env: { REVAGENT_SQLITE_OWNER_PACKAGE_JSON: ownerPackageJson } });
    results.childExits += 1;
  }
  const workerCode = String.raw`
    const { parentPort } = require("node:worker_threads");
    const { createRequire } = require("node:module");
    const D = createRequire(process.env.REVAGENT_SQLITE_OWNER_PACKAGE_JSON)("better-sqlite3"); const db = new D(":memory:");
    db.prepare("SELECT 1").get(); db.close(); parentPort.postMessage("ready"); setInterval(() => {}, 1000);
  `;
  const workerFileRoot = await mkdtemp(join(tmpdir(), "revagent-wp12-sqlite-workers-"));
  cleanupRoots.push(workerFileRoot);
  const workerFile = join(workerFileRoot, "worker.cjs");
  await writeFile(workerFile, workerCode, "utf8");
  const { Worker } = await import("node:worker_threads");
  for (let batch = 0; batch < 10; batch += 1) {
    const workers = await Promise.all(Array.from({ length: 10 }, async () => {
      const worker = new Worker(workerFile, { env: { ...process.env, REVAGENT_SQLITE_OWNER_PACKAGE_JSON: ownerPackageJson } });
      await new Promise((resolvePromise, rejectPromise) => {
        worker.once("message", (value) => value === "ready" ? resolvePromise() : rejectPromise(new Error("worker readiness drift")));
        worker.once("error", rejectPromise);
      });
      await worker.terminate();
      results.workerTerminates += 1;
    }));
    await Promise.all(workers);
  }
  const Database = createRequire(ownerPackageJson)("better-sqlite3");
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
  const current = await validateProvenance();
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
  await runDatabaseCompatibility(current.ownerPackageJson);
  await runLifecycleStress(current.ownerPackageJson);
  process.stdout.write(`${JSON.stringify(results)}\n`);
}

try {
  await main();
} finally {
  await Promise.all(cleanupRoots.map((path) => rm(path, { recursive: true, force: true })));
}
