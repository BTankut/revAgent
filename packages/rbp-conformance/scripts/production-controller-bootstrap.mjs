import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import {
  createRequire,
  isBuiltin,
  registerHooks,
  syncBuiltinESMExports,
} from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertProductionBootstrapIdentityCurrent,
  assertProductionControllerRuntimeIdentityCurrent,
  assertProductionNpmBootstrapIdentityCurrent,
  captureProductionBootstrapIdentity,
  captureProductionControllerRuntimeIdentity,
  captureProductionNpmBootstrapIdentity,
} from "./bootstrap-identity.mjs";
import { assertTrustedProductionSourceCurrent } from
  "./production-launch-attestation.mjs";

const BOOTSTRAP_PIN_SCHEMA = "rbp-production-bootstrap-identity-pin/v1";
const ACTIVE_HOOKS = [];
const RESOLUTION_ENVIRONMENT_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "WS_NO_BUFFER_UTIL",
  "WS_NO_UTF_8_VALIDATE",
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedPath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizedPath(left) === normalizedPath(right);
}

function isInside(parentValue, childValue) {
  const relative = path.relative(path.resolve(parentValue), path.resolve(childValue));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function childEnvironment() {
  const result = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (
      RESOLUTION_ENVIRONMENT_KEYS.has(normalized) ||
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

function assertNoReparsePathSegments(value, label, { allowMissingLeaf = false } = {}) {
  const absolute = path.resolve(value);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  let cursor = root;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    if (!existsSync(cursor)) {
      if (allowMissingLeaf && index === segments.length - 1) return absolute;
      throw new Error(`${label} path segment does not exist: ${cursor}`);
    }
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${label} path contains a reparse point: ${cursor}`);
    }
  }
  return absolute;
}

function exactPhysicalDirectory(value, label) {
  const lexical = assertNoReparsePathSegments(value, label);
  const stat = lstatSync(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory`);
  }
  const real = realpathSync(lexical);
  if (!samePath(real, lexical)) {
    throw new Error(`${label} final path is not its lexical path`);
  }
  return real;
}

function readBootstrapPin(repoRoot) {
  const pinFile = path.join(
    repoRoot,
    "packages",
    "rbp-conformance",
    "scripts",
    "production-bootstrap-identity.json",
  );
  assertNoReparsePathSegments(pinFile, "production bootstrap identity pin");
  const stat = lstatSync(pinFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("production bootstrap identity pin must be a physical file");
  }
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinFile, "utf8"));
  } catch {
    throw new Error("production bootstrap identity pin is malformed");
  }
  if (
    pin === null ||
    typeof pin !== "object" ||
    pin.schemaVersion !== BOOTSTRAP_PIN_SCHEMA ||
    pin.minimumNodeVersion !== "22.15.0" ||
    pin.compilerAndGenerator === null ||
    typeof pin.compilerAndGenerator !== "object" ||
    pin.controllerRuntime === null ||
    typeof pin.controllerRuntime !== "object" ||
    pin.npm === null ||
    typeof pin.npm !== "object"
  ) {
    throw new Error("production bootstrap identity pin contract is invalid");
  }
  return pin;
}

function assertPinnedControllerRuntimeIdentity(repoRoot, pin) {
  const current = captureProductionControllerRuntimeIdentity(repoRoot);
  if (
    current.schemaVersion !== pin.controllerRuntime.schemaVersion ||
    current.digestSha256 !== pin.controllerRuntime.digestSha256 ||
    current.dependencyClosure.packages.length !==
      pin.controllerRuntime.packageCount
  ) {
    throw new Error(
      "production controller runtime closure does not match the tracked pin",
    );
  }
  return current;
}

function assertPinnedCompilerIdentity(repoRoot, pin) {
  const current = captureProductionBootstrapIdentity(repoRoot);
  if (
    current.schemaVersion !== pin.compilerAndGenerator.schemaVersion ||
    current.digestSha256 !== pin.compilerAndGenerator.digestSha256 ||
    current.typescript.version !== pin.compilerAndGenerator.typescriptVersion ||
    current.generatorDependencies.root.version !==
      pin.compilerAndGenerator.generatorVersion
  ) {
    throw new Error(
      "production compiler/generator closure does not match the tracked pin",
    );
  }
  return current;
}

function assertPinnedNpmIdentity(npmExecutable, pin) {
  if (npmExecutable === undefined) return undefined;
  const current = captureProductionNpmBootstrapIdentity(npmExecutable);
  const expectedKeys = [
    "schemaVersion",
    "name",
    "version",
    "entrypointRelativePath",
    "entrypointSha256",
    "fileCount",
    "filesSha256",
    "digestSha256",
  ];
  if (expectedKeys.some((key) => current[key] !== pin.npm[key])) {
    throw new Error("production npm closure does not match the tracked pin");
  }
  return current;
}

function cleanExactOutput(repoRoot, relativePath, label) {
  const output = path.resolve(repoRoot, ...relativePath.split("/"));
  const expected = path.join(repoRoot, ...relativePath.split("/"));
  if (!samePath(output, expected) || !isInside(repoRoot, output)) {
    throw new Error(`${label} output path is not canonical`);
  }
  assertNoReparsePathSegments(path.dirname(output), `${label} parent`);
  if (!existsSync(output)) return;
  assertNoReparsePathSegments(output, label);
  const stat = lstatSync(output);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} output must be a physical directory`);
  }
  if (!samePath(realpathSync(output), output)) {
    throw new Error(`${label} output resolves outside its canonical path`);
  }
  rmSync(output, { recursive: true, force: true });
}

function runBoundNode({
  args,
  bootstrapIdentity,
  controllerRuntimeIdentity,
  label,
  npmExecutable,
  npmIdentity,
  pin,
  repoRoot,
}) {
  assertTrustedProductionSourceCurrent({ repoRoot });
  assertProductionBootstrapIdentityCurrent(repoRoot, bootstrapIdentity);
  assertPinnedCompilerIdentity(repoRoot, pin);
  assertProductionControllerRuntimeIdentityCurrent(
    repoRoot,
    controllerRuntimeIdentity,
  );
  assertPinnedControllerRuntimeIdentity(repoRoot, pin);
  if (npmExecutable !== undefined && npmIdentity !== undefined) {
    assertProductionNpmBootstrapIdentityCurrent(npmExecutable, npmIdentity);
    assertPinnedNpmIdentity(npmExecutable, pin);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnvironment(),
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  assertProductionBootstrapIdentityCurrent(repoRoot, bootstrapIdentity);
  assertPinnedCompilerIdentity(repoRoot, pin);
  assertProductionControllerRuntimeIdentityCurrent(
    repoRoot,
    controllerRuntimeIdentity,
  );
  assertPinnedControllerRuntimeIdentity(repoRoot, pin);
  if (npmExecutable !== undefined && npmIdentity !== undefined) {
    assertProductionNpmBootstrapIdentityCurrent(npmExecutable, npmIdentity);
    assertPinnedNpmIdentity(npmExecutable, pin);
  }
  assertTrustedProductionSourceCurrent({ repoRoot });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.status)}`);
  }
}

function captureClosureRoot(
  rootValue,
  label,
  {
    javascriptFormat = "module",
    skipNodeModules = false,
  } = {},
) {
  const root = exactPhysicalDirectory(rootValue, label);
  const records = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (
        skipNodeModules &&
        entry.isDirectory() &&
        entry.name === "node_modules"
      ) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${label} contains a non-file entry: ${absolute}`);
      }
      const real = realpathSync(absolute);
      if (!samePath(real, absolute) || !isInside(root, real)) {
        throw new Error(`${label} file escapes its physical root: ${absolute}`);
      }
      const bytes = readFileSync(real);
      const after = lstatSync(absolute);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        !samePath(realpathSync(absolute), real)
      ) {
        throw new Error(`${label} file changed while it was captured: ${absolute}`);
      }
      records.push({
        path: absolute,
        normalizedPath: normalizedPath(absolute),
        relativePath: path.relative(root, absolute).replaceAll("\\", "/"),
        size: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        bytes,
        javascriptFormat,
      });
    }
  };
  visit(root);
  if (records.length === 0) {
    throw new Error(`${label} is empty after the canonical build`);
  }
  return {
    root,
    normalizedRoot: normalizedPath(root),
    records,
    captureOptions: { javascriptFormat, skipNodeModules },
  };
}

function anchoredSourceRecords(repoRoot, sourceAnchor) {
  return sourceAnchor.sources.map((source) => {
    const absolute = path.join(repoRoot, ...source.relativePath.split("/"));
    assertNoReparsePathSegments(absolute, `anchored source ${source.relativePath}`);
    const bytes = readFileSync(absolute);
    const sha256 = sha256Bytes(bytes);
    if (sha256 !== source.sha256) {
      throw new Error(`anchored source changed: ${source.relativePath}`);
    }
    return {
      path: absolute,
      normalizedPath: normalizedPath(absolute),
      relativePath: source.relativePath,
      size: bytes.byteLength,
      sha256,
      bytes,
      javascriptFormat: path.extname(absolute).toLowerCase() === ".cjs"
        ? "commonjs"
        : "module",
    };
  });
}

function closureFileMap(closures, additionalRecords = []) {
  const result = new Map();
  for (const records of [
    ...closures.map((closure) => closure.records),
    additionalRecords,
  ]) {
    for (const record of records) {
      if (result.has(record.normalizedPath)) {
        throw new Error(`duplicate production closure path: ${record.path}`);
      }
      result.set(record.normalizedPath, record);
    }
  }
  return result;
}

function assertClosureCurrent(closures, recordsByPath) {
  const currentClosures = closures.map((closure) =>
    captureClosureRoot(
      closure.root,
      "production controller/protocol closure",
      closure.captureOptions,
    )
  );
  const current = closureFileMap(currentClosures);
  if (current.size !== recordsByPath.size) {
    throw new Error("production controller/protocol closure path set changed");
  }
  for (const [key, expected] of recordsByPath) {
    const actual = current.get(key);
    if (
      actual === undefined ||
      actual.size !== expected.size ||
      actual.sha256 !== expected.sha256
    ) {
      throw new Error(
        `production controller/protocol closure changed: ${expected.path}`,
      );
    }
  }
}

function parseCapturedPackageCatalog(recordsByPath) {
  const packagesByRoot = new Map();
  const packagesByName = new Map();
  for (const record of recordsByPath.values()) {
    if (path.basename(record.path).toLowerCase() !== "package.json") continue;
    let manifest;
    try {
      manifest = JSON.parse(record.bytes.toString("utf8"));
    } catch {
      throw new Error(`captured package manifest is malformed: ${record.path}`);
    }
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      typeof manifest.name !== "string" ||
      manifest.name.length === 0
    ) {
      continue;
    }
    const root = path.dirname(record.path);
    const key = normalizedPath(root);
    if (packagesByRoot.has(key)) {
      throw new Error(`duplicate captured package root: ${root}`);
    }
    const packageValue = { root, normalizedRoot: key, manifest };
    packagesByRoot.set(key, packageValue);
    const named = packagesByName.get(manifest.name) ?? [];
    named.push(packageValue);
    packagesByName.set(manifest.name, named);
  }
  for (const named of packagesByName.values()) {
    named.sort((left, right) =>
      compareText(left.normalizedRoot, right.normalizedRoot)
    );
  }
  return { packagesByRoot, packagesByName };
}

function packageSpecifierParts(specifier) {
  if (
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)
  ) {
    return undefined;
  }
  const parts = specifier.split("/");
  const packageName = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
  const consumed = specifier.startsWith("@") ? 2 : 1;
  if (
    packageName.length === 0 ||
    (specifier.startsWith("@") && parts.length < 2)
  ) {
    return undefined;
  }
  const remainder = parts.slice(consumed).join("/");
  return {
    packageName,
    subpath: remainder.length === 0 ? "." : `./${remainder}`,
  };
}

export function classifyProductionModuleSpecifier(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0) {
    throw new Error("production module specifier is invalid");
  }
  if (isBuiltin(specifier)) {
    return {
      kind: "builtin",
      url: specifier.startsWith("node:") ? specifier : `node:${specifier}`,
    };
  }
  if (specifier.startsWith("file:")) {
    let url;
    try {
      url = new URL(specifier);
    } catch {
      throw new Error(`production module specifier is invalid: ${specifier}`);
    }
    if (
      url.protocol !== "file:" ||
      url.search.length !== 0 ||
      url.hash.length !== 0
    ) {
      throw new Error(`production module rejected URL: ${url.href}`);
    }
    return { kind: "file", url };
  }
  if (path.isAbsolute(specifier)) {
    return { kind: "absolute_path", path: path.resolve(specifier) };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) {
    throw new Error(`production module rejected scheme: ${specifier}`);
  }
  const packageParts = packageSpecifierParts(specifier);
  if (packageParts !== undefined) {
    return { kind: "package", ...packageParts };
  }
  return { kind: "relative", specifier };
}

function selectConditionalTarget(value, conditions) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const selected = selectConditionalTarget(entry, conditions);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const [condition, target] of Object.entries(value)) {
    if (condition === "default" || conditions.has(condition)) {
      const selected = selectConditionalTarget(target, conditions);
      if (selected !== undefined) return selected;
    }
  }
  return undefined;
}

function capturedExportTarget(exportsValue, subpath, conditions) {
  if (
    typeof exportsValue === "string" ||
    Array.isArray(exportsValue) ||
    exportsValue === null
  ) {
    return subpath === "."
      ? selectConditionalTarget(exportsValue, conditions)
      : undefined;
  }
  if (typeof exportsValue !== "object") return undefined;
  const entries = Object.entries(exportsValue);
  if (entries.every(([key]) => !key.startsWith("."))) {
    return subpath === "."
      ? selectConditionalTarget(exportsValue, conditions)
      : undefined;
  }
  if (Object.hasOwn(exportsValue, subpath)) {
    return selectConditionalTarget(exportsValue[subpath], conditions);
  }
  const patterns = entries
    .filter(([key]) => key.startsWith("./") && key.includes("*"))
    .sort(([left], [right]) => right.length - left.length);
  for (const [pattern, target] of patterns) {
    const star = pattern.indexOf("*");
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const replacement = subpath.slice(prefix.length, subpath.length - suffix.length);
    const selected = selectConditionalTarget(target, conditions);
    if (selected !== undefined) return selected.replaceAll("*", replacement);
  }
  return undefined;
}

function capturedRecordAt(recordsByPath, candidate) {
  return recordsByPath.get(normalizedPath(candidate));
}

function resolveCapturedPath({
  candidate,
  conditions,
  packageCatalog,
  recordsByPath,
  seen = new Set(),
}) {
  const absolute = path.resolve(candidate);
  const seenKey = normalizedPath(absolute);
  if (seen.has(seenKey)) {
    throw new Error(`captured module resolution cycle at ${absolute}`);
  }
  seen.add(seenKey);
  const exact = capturedRecordAt(recordsByPath, absolute);
  if (exact !== undefined) return exact;
  if (path.extname(absolute).length === 0) {
    for (const extension of [".js", ".json", ".cjs", ".mjs"]) {
      const extended = capturedRecordAt(recordsByPath, `${absolute}${extension}`);
      if (extended !== undefined) return extended;
    }
  }
  const packageValue = packageCatalog.packagesByRoot.get(normalizedPath(absolute));
  if (packageValue !== undefined) {
    let target;
    if (Object.hasOwn(packageValue.manifest, "exports")) {
      target = capturedExportTarget(
        packageValue.manifest.exports,
        ".",
        conditions,
      );
      if (target === undefined) {
        throw new Error(
          `captured package has no matching root export: ${packageValue.manifest.name}`,
        );
      }
    } else if (
      typeof packageValue.manifest.main === "string" &&
      packageValue.manifest.main.length > 0
    ) {
      target = packageValue.manifest.main;
    }
    if (target !== undefined) {
      if (!target.startsWith("./") && !target.startsWith("../")) {
        target = `./${target}`;
      }
      const targetPath = path.resolve(packageValue.root, target);
      if (!isInside(packageValue.root, targetPath)) {
        throw new Error(
          `captured package root target escapes package: ${packageValue.manifest.name}`,
        );
      }
      return resolveCapturedPath({
        candidate: targetPath,
        conditions,
        packageCatalog,
        recordsByPath,
        seen,
      });
    }
  }
  for (const name of ["index.js", "index.json", "index.cjs", "index.mjs"]) {
    const indexed = capturedRecordAt(recordsByPath, path.join(absolute, name));
    if (indexed !== undefined) return indexed;
  }
  return undefined;
}

function capturedPackageForSpecifier({
  packageName,
  parentFile,
  packageCatalog,
}) {
  let cursor = path.dirname(parentFile);
  const root = path.parse(cursor).root;
  const packageSegments = packageName.split("/");
  while (true) {
    const candidate = path.join(cursor, "node_modules", ...packageSegments);
    const found = packageCatalog.packagesByRoot.get(normalizedPath(candidate));
    if (found !== undefined) return found;
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const workspaceCandidates = (packageCatalog.packagesByName.get(packageName) ?? [])
    .filter((packageValue) =>
      isCapturedWorkspacePackageRoot(packageValue.normalizedRoot)
    );
  if (workspaceCandidates.length === 1) return workspaceCandidates[0];
  return undefined;
}

export function isCapturedWorkspacePackageRoot(rootValue) {
  return !path.resolve(rootValue)
    .split(path.sep)
    .some((segment) => segment.toLowerCase() === "node_modules");
}

function resolveCapturedPackage({
  conditions,
  packageCatalog,
  packageName,
  parentFile,
  recordsByPath,
  subpath,
}) {
  const packageValue = capturedPackageForSpecifier({
    packageName,
    parentFile,
    packageCatalog,
  });
  if (packageValue === undefined) {
    throw new Error(`production module package is not captured: ${packageName}`);
  }
  let target;
  if (Object.hasOwn(packageValue.manifest, "exports")) {
    target = capturedExportTarget(
      packageValue.manifest.exports,
      subpath,
      conditions,
    );
    if (target === undefined) {
      throw new Error(
        `captured package export is unavailable: ${packageName} ${subpath}`,
      );
    }
  } else if (subpath !== ".") {
    target = subpath;
  } else if (
    typeof packageValue.manifest.main === "string" &&
    packageValue.manifest.main.length > 0
  ) {
    target = packageValue.manifest.main;
  } else {
    target = "./index.js";
  }
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new Error(`captured package target is invalid: ${packageName}`);
  }
  const targetPath = path.resolve(packageValue.root, target);
  if (!isInside(packageValue.root, targetPath)) {
    throw new Error(`captured package target escapes package: ${packageName}`);
  }
  const record = resolveCapturedPath({
    candidate: targetPath,
    conditions,
    packageCatalog,
    recordsByPath,
  });
  if (record === undefined) {
    throw new Error(
      `captured package target is missing: ${packageName} ${subpath}`,
    );
  }
  return record;
}

function capturedModuleResolution({
  context,
  packageCatalog,
  recordsByPath,
  specifier,
}) {
  const classified = classifyProductionModuleSpecifier(specifier);
  if (classified.kind === "builtin") {
    return { url: classified.url, shortCircuit: true };
  }
  if (
    typeof context?.parentURL !== "string" ||
    !context.parentURL.startsWith("file:")
  ) {
    if (classified.kind !== "file" && classified.kind !== "absolute_path") {
      throw new Error(
        `production module has no captured file parent: ${specifier}`,
      );
    }
  }
  const conditions = new Set(
    Array.isArray(context?.conditions) ? context.conditions : [],
  );
  const parentFile = typeof context?.parentURL === "string"
    ? fileURLToPath(context.parentURL)
    : process.execPath;
  let record;
  if (classified.kind === "package") {
    record = resolveCapturedPackage({
      conditions,
      packageCatalog,
      packageName: classified.packageName,
      parentFile,
      recordsByPath,
      subpath: classified.subpath,
    });
  } else {
    let candidateUrl;
    try {
      candidateUrl = classified.kind === "file"
        ? classified.url
        : classified.kind === "absolute_path"
          ? pathToFileURL(classified.path)
          : new URL(classified.specifier, context.parentURL);
    } catch {
      throw new Error(`production module specifier is invalid: ${specifier}`);
    }
    if (
      candidateUrl.protocol !== "file:" ||
      candidateUrl.search.length !== 0 ||
      candidateUrl.hash.length !== 0
    ) {
      throw new Error(`production module rejected URL: ${candidateUrl.href}`);
    }
    record = resolveCapturedPath({
      candidate: fileURLToPath(candidateUrl),
      conditions,
      packageCatalog,
      recordsByPath,
    });
    if (record === undefined) {
      throw new Error(
        `production module resolved an uncaptured file: ${candidateUrl.href}`,
      );
    }
  }
  const extension = path.extname(record.path).toLowerCase();
  const format = extension === ".json"
    ? "json"
    : extension === ".cjs"
      ? "commonjs"
      : extension === ".mjs"
        ? "module"
        : extension === ".js"
          ? record.javascriptFormat
          : undefined;
  if (format === undefined) {
    throw new Error(
      `production closure cannot resolve captured ${extension} files`,
    );
  }
  return {
    url: pathToFileURL(record.path).href,
    format,
    shortCircuit: true,
  };
}

async function installVerifiedClosureHooks(recordsByPath) {
  if (typeof registerHooks !== "function") {
    throw new Error(
      "production controller requires Node 22.15+ synchronous module.registerHooks",
    );
  }
  const initialHandoffKey = Symbol.for(
    "rbp.production.initial-loader-handoff",
  );
  const initialHandoff = globalThis[initialHandoffKey];
  if (typeof initialHandoff !== "function") {
    throw new Error(
      "production controller initial in-memory loader handoff is unavailable",
    );
  }
  initialHandoff();
  if (globalThis[initialHandoffKey] !== undefined) {
    throw new Error(
      "production controller initial in-memory loader did not retire",
    );
  }
  let importResolveObserved = false;
  let importLoadObserved = false;
  let requireResolveObserved = false;
  const probeUrl =
    `data:text/javascript,export default ${JSON.stringify(process.pid)}`;
  const probeHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === probeUrl) importResolveObserved = true;
      if (specifier === "node:querystring") requireResolveObserved = true;
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === probeUrl) importLoadObserved = true;
      return nextLoad(url, context);
    },
  });
  if (
    probeHooks === null ||
    typeof probeHooks !== "object" ||
    typeof probeHooks.deregister !== "function"
  ) {
    throw new Error("production Node returned an invalid hook probe handle");
  }
  try {
    await import(probeUrl);
    createRequire(import.meta.url)("node:querystring");
  } finally {
    probeHooks.deregister();
  }
  if (
    !importResolveObserved ||
    !importLoadObserved ||
    !requireResolveObserved
  ) {
    throw new Error(
      "production Node synchronous hooks did not observe import and createRequire",
    );
  }

  const packageCatalog = parseCapturedPackageCatalog(recordsByPath);
  const resolutionBindings = new Map();
  const hooks = registerHooks({
    resolve(specifier, context) {
      const conditions = Array.isArray(context?.conditions)
        ? [...context.conditions].sort(compareText).join("\0")
        : "";
      const bindingKey = [
        context?.parentURL ?? "",
        specifier,
        conditions,
      ].join("\0");
      const existing = resolutionBindings.get(bindingKey);
      if (existing !== undefined) return existing;
      const result = capturedModuleResolution({
        context,
        packageCatalog,
        recordsByPath,
        specifier,
      });
      resolutionBindings.set(bindingKey, result);
      return result;
    },
    load(url, context, nextLoad) {
      if (typeof url !== "string") {
        throw new Error("production module load returned no canonical URL");
      }
      if (url.startsWith("node:")) {
        return nextLoad(url, context);
      }
      if (!url.startsWith("file:")) {
        throw new Error(`production module load rejected non-file URL: ${url}`);
      }
      const parsed = new URL(url);
      const file = fileURLToPath(parsed);
      if (parsed.search.length !== 0 || parsed.hash.length !== 0) {
        throw new Error("production closure loads cannot use URL search or hash");
      }
      const record = recordsByPath.get(normalizedPath(file));
      if (record === undefined) {
        throw new Error(`production closure attempted to load an uncaptured file: ${file}`);
      }
      const extension = path.extname(file).toLowerCase();
      if (extension === ".json") {
        return { format: "json", source: record.bytes, shortCircuit: true };
      }
      if (extension === ".cjs") {
        return { format: "commonjs", source: record.bytes, shortCircuit: true };
      }
      if (extension === ".mjs") {
        return {
          format: "module",
          source: record.bytes,
          shortCircuit: true,
        };
      }
      if (extension === ".js") {
        return {
          format: record.javascriptFormat,
          source: record.bytes,
          shortCircuit: true,
        };
      }
      throw new Error(`production closure cannot execute captured ${extension} files`);
    },
  });
  if (
    hooks === null ||
    typeof hooks !== "object" ||
    typeof hooks.deregister !== "function"
  ) {
    throw new Error("production Node returned an invalid synchronous hook handle");
  }
  ACTIVE_HOOKS.push(hooks);
  const moduleBuiltin = createRequire(import.meta.url)("node:module");
  const rejectAdditionalHook = () => {
    throw new Error(
      "production controller forbids additional Node module-loader hooks",
    );
  };
  Object.defineProperty(moduleBuiltin, "registerHooks", {
    configurable: false,
    enumerable: true,
    value: rejectAdditionalHook,
    writable: false,
  });
  Object.defineProperty(moduleBuiltin, "register", {
    configurable: false,
    enumerable: true,
    value: rejectAdditionalHook,
    writable: false,
  });
  syncBuiltinESMExports();
  return hooks;
}

export async function buildAndImportTrustedProductionController({
  repoRoot: repoRootValue,
  npmExecutable,
}) {
  const repoRoot = exactPhysicalDirectory(
    path.resolve(repoRootValue),
    "production repository root",
  );
  const initialAnchor = assertTrustedProductionSourceCurrent({ repoRoot });
  const pin = readBootstrapPin(repoRoot);
  const bootstrapIdentity = assertPinnedCompilerIdentity(repoRoot, pin);
  const controllerRuntimeIdentity = assertPinnedControllerRuntimeIdentity(
    repoRoot,
    pin,
  );
  const npmIdentity = assertPinnedNpmIdentity(npmExecutable, pin);

  cleanExactOutput(
    repoRoot,
    "packages/protocol/dist",
    "protocol bootstrap output",
  );
  cleanExactOutput(
    repoRoot,
    "packages/rbp-conformance/dist",
    "rbp-conformance bootstrap output",
  );

  const runStep = (args, label) => runBoundNode({
    args,
    bootstrapIdentity,
    controllerRuntimeIdentity,
    label,
    npmExecutable,
    npmIdentity,
    pin,
    repoRoot,
  });
  runStep(
    [path.join(repoRoot, "packages/protocol/scripts/generate-types.mjs")],
    "protocol bootstrap generation",
  );
  runStep(
    [path.join(repoRoot, "packages/protocol/scripts/clean.mjs")],
    "protocol bootstrap clean",
  );
  const typescriptEntrypoint = path.join(
    repoRoot,
    "node_modules",
    "typescript",
    "lib",
    "tsc.js",
  );
  runStep(
    [
      typescriptEntrypoint,
      "-p",
      path.join(repoRoot, "packages/protocol/tsconfig.json"),
    ],
    "protocol bootstrap TypeScript build",
  );
  runStep(
    [
      typescriptEntrypoint,
      "-p",
      path.join(repoRoot, "packages/rbp-conformance/tsconfig.json"),
    ],
    "rbp-conformance direct TypeScript build",
  );

  const closures = [
    captureClosureRoot(
      path.join(repoRoot, "packages/protocol/dist"),
      "fresh protocol closure",
    ),
    captureClosureRoot(
      path.join(repoRoot, "packages/rbp-conformance/dist"),
      "fresh rbp-conformance controller closure",
    ),
    ...controllerRuntimeIdentity.dependencyClosure.packages.map((packageValue) => {
      const packageRoot = path.join(
        repoRoot,
        ...packageValue.packagePath.split("/"),
      );
      const manifest = JSON.parse(
        readFileSync(path.join(packageRoot, "package.json"), "utf8"),
      );
      return captureClosureRoot(
        packageRoot,
        `pinned controller runtime package ${packageValue.name}`,
        {
          javascriptFormat: manifest.type === "module" ? "module" : "commonjs",
          skipNodeModules: true,
        },
      );
    }),
  ];
  const closureRecordsByPath = closureFileMap(closures);
  const recordsByPath = closureFileMap(
    closures,
    anchoredSourceRecords(repoRoot, initialAnchor),
  );
  const cli = path.join(repoRoot, "packages/rbp-conformance/dist/src/cli.js");
  if (!recordsByPath.has(normalizedPath(cli))) {
    throw new Error("fresh production controller closure does not contain cli.js");
  }
  assertClosureCurrent(closures, closureRecordsByPath);
  assertProductionControllerRuntimeIdentityCurrent(
    repoRoot,
    controllerRuntimeIdentity,
  );
  assertTrustedProductionSourceCurrent({ repoRoot, expected: initialAnchor });
  await installVerifiedClosureHooks(recordsByPath);
  const module = await import(pathToFileURL(cli).href);
  assertClosureCurrent(closures, closureRecordsByPath);
  assertProductionControllerRuntimeIdentityCurrent(
    repoRoot,
    controllerRuntimeIdentity,
  );
  assertTrustedProductionSourceCurrent({ repoRoot, expected: initialAnchor });
  return {
    module,
    sourceAnchor: initialAnchor,
    bootstrapIdentity,
    npmIdentity,
  };
}
