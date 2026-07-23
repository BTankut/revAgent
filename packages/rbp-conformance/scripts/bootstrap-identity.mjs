import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

const BOOTSTRAP_IDENTITY_SCHEMA_VERSION =
  "rbp-production-bootstrap-build-dependencies/v1";
const NPM_BOOTSTRAP_IDENTITY_SCHEMA_VERSION =
  "rbp-production-npm-bootstrap-dependency/v1";
const CONTROLLER_RUNTIME_IDENTITY_SCHEMA_VERSION =
  "rbp-production-controller-runtime-dependencies/v1";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isInside(parentValue, childValue) {
  const parent = realpathSync(parentValue);
  const child = realpathSync(childValue);
  const relative = path.relative(parent, child);
  return relative === "" || (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function assertAbsoluteRegularFile(value, label) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const lexical = path.resolve(value);
  if (!existsSync(lexical)) {
    throw new Error(`${label} does not exist: ${lexical}`);
  }
  const lexicalStat = lstatSync(lexical);
  if (lexicalStat.isSymbolicLink() || !lexicalStat.isFile()) {
    throw new Error(`${label} must be a regular non-symbolic-link file: ${lexical}`);
  }
  return lexical;
}

function objectOfStrings(value, label) {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${label} must contain only nonempty string ranges`);
  }
  return Object.fromEntries(entries);
}

function readPackage(packageRootValue) {
  const packageRoot = realpathSync(packageRootValue);
  const packageFile = path.join(packageRoot, "package.json");
  if (!statSync(packageFile).isFile()) {
    throw new Error(`bootstrap dependency lacks package.json: ${packageRoot}`);
  }
  const value = JSON.parse(readFileSync(packageFile, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new Error(`bootstrap dependency package.json is malformed: ${packageFile}`);
  }
  return { packageRoot, packageFile, value };
}

function walkPackageFiles(
  packageRootValue,
  { includeNodeModules = false } = {},
) {
  const packageRoot = realpathSync(packageRootValue);
  const records = [];
  const visit = (directory, relativeDirectory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (
        !includeNodeModules &&
        entry.isDirectory() &&
        entry.name === "node_modules"
      ) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = normalizePath(path.join(relativeDirectory, entry.name));
      if (entry.isSymbolicLink()) {
        throw new Error(
          `bootstrap dependency package contains a symbolic link: ${relative}`,
        );
      }
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const file = statSync(absolute);
        records.push({
          path: relative,
          bytes: file.size,
          sha256: sha256File(absolute),
        });
      } else {
        throw new Error(
          `bootstrap dependency package contains a non-file entry: ${relative}`,
        );
      }
    }
  };
  visit(packageRoot, "");
  if (records.length === 0) {
    throw new Error(`bootstrap dependency package is empty: ${packageRoot}`);
  }
  return records;
}

function packageIdentity(repoRoot, packageRootValue) {
  const packageRoot = realpathSync(packageRootValue);
  if (!isInside(repoRoot, packageRoot)) {
    throw new Error(`bootstrap dependency escapes the repository: ${packageRoot}`);
  }
  const manifest = readPackage(packageRoot);
  const files = walkPackageFiles(packageRoot);
  return {
    name: manifest.value.name,
    version: manifest.value.version,
    packagePath: normalizePath(path.relative(repoRoot, packageRoot)),
    fileCount: files.length,
    filesSha256: sha256Bytes(stableJson(files)),
    files,
  };
}

function dependencyDeclarations(manifest) {
  const dependencies = objectOfStrings(manifest.dependencies, "dependencies");
  const optionalDependencies = objectOfStrings(
    manifest.optionalDependencies,
    "optionalDependencies",
  );
  const peerDependencies = objectOfStrings(
    manifest.peerDependencies,
    "peerDependencies",
  );
  const peerMetadata = manifest.peerDependenciesMeta;
  if (
    peerMetadata !== undefined &&
    (peerMetadata === null ||
      typeof peerMetadata !== "object" ||
      Array.isArray(peerMetadata))
  ) {
    throw new Error("peerDependenciesMeta must be an object");
  }
  const optionalPeers = new Set(
    Object.entries(peerMetadata ?? {})
      .filter(([, metadata]) =>
        metadata !== null &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        metadata.optional === true)
      .map(([name]) => name),
  );
  const rows = [];
  for (const dependencyName of Object.keys(dependencies).sort(compareText)) {
    if (Object.hasOwn(optionalDependencies, dependencyName)) continue;
    rows.push({
      dependencyName,
      dependencyRange: dependencies[dependencyName],
      kind: "dependency",
      optional: false,
    });
  }
  for (const dependencyName of Object.keys(optionalDependencies).sort(compareText)) {
    rows.push({
      dependencyName,
      dependencyRange: optionalDependencies[dependencyName],
      kind: "optional_dependency",
      optional: true,
    });
  }
  for (const dependencyName of Object.keys(peerDependencies).sort(compareText)) {
    const optional = optionalPeers.has(dependencyName);
    rows.push({
      dependencyName,
      dependencyRange: peerDependencies[dependencyName],
      kind: optional ? "optional_peer_dependency" : "peer_dependency",
      optional,
    });
  }
  return rows;
}

function dependencyCandidate(repoRootValue, requesterRootValue, dependencyName) {
  const repoRoot = realpathSync(repoRootValue);
  let cursor = realpathSync(requesterRootValue);
  const dependencySegments = dependencyName.split("/");
  while (isInside(repoRoot, cursor)) {
    const candidate = path.join(cursor, "node_modules", ...dependencySegments);
    if (existsSync(path.join(candidate, "package.json"))) {
      const lexical = lstatSync(candidate);
      if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
        throw new Error(
          `bootstrap dependency must be a physical directory: ${dependencyName}`,
        );
      }
      const resolved = realpathSync(candidate);
      if (!isInside(repoRoot, resolved)) {
        throw new Error(`bootstrap dependency escapes repository: ${dependencyName}`);
      }
      return { lexical: candidate, resolved };
    }
    if (cursor === repoRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

function owningPackageRoot(repoRoot, resolvedFileValue, expectedName) {
  const resolvedFile = realpathSync(resolvedFileValue);
  let cursor = statSync(resolvedFile).isDirectory()
    ? resolvedFile
    : path.dirname(resolvedFile);
  while (isInside(repoRoot, cursor)) {
    if (existsSync(path.join(cursor, "package.json"))) {
      const manifest = readPackage(cursor);
      if (manifest.value.name === expectedName) return manifest.packageRoot;
    }
    if (cursor === repoRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(
    `Node resolution for ${expectedName} has no matching physical package root`,
  );
}

function verifyNodePackageResolution(
  repoRoot,
  requesterRoot,
  dependencyName,
  expectedRoot,
) {
  const require = createRequire(path.join(requesterRoot, "package.json"));
  let resolved;
  try {
    resolved = require.resolve(dependencyName);
  } catch (entrypointError) {
    try {
      resolved = require.resolve(`${dependencyName}/package.json`);
    } catch {
      /*
       * Some declaration-only packages intentionally have no runtime
       * entrypoint and some packages block package.json through exports. The
       * node_modules ascent used above is Node's physical package lookup; in
       * that narrow case the exact manifest and full package bytes remain the
       * fail-closed identity.
       */
      if (entrypointError?.code !== "MODULE_NOT_FOUND") throw entrypointError;
      return;
    }
  }
  const actualRoot = owningPackageRoot(repoRoot, resolved, dependencyName);
  if (actualRoot !== realpathSync(expectedRoot)) {
    throw new Error(
      `Node resolved ${dependencyName} to a different physical package`,
    );
  }
}

function generatorDependencyClosure(repoRootValue) {
  const repoRoot = realpathSync(repoRootValue);
  const protocolRoot = realpathSync(path.join(repoRoot, "packages", "protocol"));
  const protocol = readPackage(protocolRoot);
  const devDependencies = objectOfStrings(
    protocol.value.devDependencies,
    "protocol devDependencies",
  );
  const rootRange = devDependencies["json-schema-to-typescript"];
  if (rootRange === undefined) {
    throw new Error(
      "protocol generator dependency json-schema-to-typescript is undeclared",
    );
  }
  const rootCandidate = dependencyCandidate(
    repoRoot,
    protocolRoot,
    "json-schema-to-typescript",
  );
  if (rootCandidate === undefined) {
    throw new Error(
      "protocol generator dependency json-schema-to-typescript is not installed",
    );
  }
  verifyNodePackageResolution(
    repoRoot,
    protocolRoot,
    "json-schema-to-typescript",
    rootCandidate.resolved,
  );
  const rootPackage = readPackage(rootCandidate.resolved);
  if (rootPackage.value.name !== "json-schema-to-typescript") {
    throw new Error("protocol generator resolved the wrong root package");
  }

  const queue = [rootCandidate.resolved];
  const visited = new Set();
  const packages = new Map();
  const resolutions = [{
    requesterName: protocol.value.name,
    requesterPath: normalizePath(path.relative(repoRoot, protocolRoot)),
    dependencyName: "json-schema-to-typescript",
    dependencyRange: rootRange,
    kind: "dev_dependency",
    status: "installed",
    resolvedPackagePath: normalizePath(
      path.relative(repoRoot, rootCandidate.resolved),
    ),
    resolvedVersion: rootPackage.value.version,
  }];

  while (queue.length > 0) {
    const requesterRoot = queue.shift();
    if (visited.has(requesterRoot)) continue;
    visited.add(requesterRoot);
    const requester = readPackage(requesterRoot);
    const requesterPath = normalizePath(path.relative(repoRoot, requesterRoot));
    packages.set(
      requesterRoot,
      packageIdentity(repoRoot, requesterRoot),
    );
    for (const declaration of dependencyDeclarations(requester.value)) {
      const candidate = dependencyCandidate(
        repoRoot,
        requesterRoot,
        declaration.dependencyName,
      );
      if (candidate === undefined) {
        if (!declaration.optional) {
          throw new Error(
            `${requester.value.name} required bootstrap dependency is missing: ` +
            declaration.dependencyName,
          );
        }
        resolutions.push({
          requesterName: requester.value.name,
          requesterPath,
          dependencyName: declaration.dependencyName,
          dependencyRange: declaration.dependencyRange,
          kind: declaration.kind,
          status: "absent_optional",
          resolvedPackagePath: null,
          resolvedVersion: null,
        });
        continue;
      }
      const resolved = readPackage(candidate.resolved);
      if (resolved.value.name !== declaration.dependencyName) {
        throw new Error(
          `${requester.value.name} resolved ${declaration.dependencyName} ` +
          `to ${resolved.value.name}`,
        );
      }
      verifyNodePackageResolution(
        repoRoot,
        requesterRoot,
        declaration.dependencyName,
        candidate.resolved,
      );
      resolutions.push({
        requesterName: requester.value.name,
        requesterPath,
        dependencyName: declaration.dependencyName,
        dependencyRange: declaration.dependencyRange,
        kind: declaration.kind,
        status: "installed",
        resolvedPackagePath: normalizePath(
          path.relative(repoRoot, candidate.resolved),
        ),
        resolvedVersion: resolved.value.version,
      });
      if (!visited.has(candidate.resolved)) queue.push(candidate.resolved);
    }
  }

  resolutions.sort((left, right) =>
    compareText(
      [
        left.requesterPath,
        left.dependencyName,
        left.kind,
        left.resolvedPackagePath ?? "",
      ].join("\0"),
      [
        right.requesterPath,
        right.dependencyName,
        right.kind,
        right.resolvedPackagePath ?? "",
      ].join("\0"),
    ));
  return {
    root: {
      name: rootPackage.value.name,
      version: rootPackage.value.version,
      packagePath: normalizePath(path.relative(repoRoot, rootCandidate.resolved)),
      dependencyRange: rootRange,
    },
    resolutions,
    packages: [...packages.values()]
      .sort((left, right) => compareText(left.packagePath, right.packagePath)),
  };
}

function typescriptPackageIdentity(repoRootValue) {
  const repoRoot = realpathSync(repoRootValue);
  const lexicalRoot = path.join(repoRoot, "node_modules", "typescript");
  if (!existsSync(lexicalRoot)) {
    throw new Error("installed TypeScript package is missing");
  }
  const lexical = lstatSync(lexicalRoot);
  if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
    throw new Error("installed TypeScript package must be a physical directory");
  }
  const packageRoot = realpathSync(lexicalRoot);
  const manifest = readPackage(packageRoot);
  if (manifest.value.name !== "typescript") {
    throw new Error("installed TypeScript package identity is cross-wired");
  }
  const entrypoint = assertAbsoluteRegularFile(
    path.join(packageRoot, "lib", "tsc.js"),
    "TypeScript compiler entrypoint",
  );
  if (!isInside(packageRoot, entrypoint)) {
    throw new Error("TypeScript compiler entrypoint escapes its package");
  }
  return {
    ...packageIdentity(repoRoot, packageRoot),
    entrypointPath: normalizePath(path.relative(repoRoot, entrypoint)),
    entrypointSha256: sha256File(entrypoint),
  };
}

export function captureProductionBootstrapIdentity(repoRootValue) {
  const repoRoot = realpathSync(repoRootValue);
  const payload = {
    schemaVersion: BOOTSTRAP_IDENTITY_SCHEMA_VERSION,
    typescript: typescriptPackageIdentity(repoRoot),
    generatorDependencies: generatorDependencyClosure(repoRoot),
  };
  return {
    ...payload,
    digestSha256: sha256Bytes(stableJson(payload)),
  };
}

function externalOwningPackageRoot(fileValue, expectedName) {
  const file = realpathSync(fileValue);
  let cursor = path.dirname(file);
  while (true) {
    const packageFile = path.join(cursor, "package.json");
    if (existsSync(packageFile)) {
      const manifest = readPackage(cursor);
      if (manifest.value.name === expectedName) return manifest.packageRoot;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`${fileValue} is not owned by installed package ${expectedName}`);
}

export function captureProductionNpmBootstrapIdentity(npmEntrypointValue) {
  const entrypoint = assertAbsoluteRegularFile(
    npmEntrypointValue,
    "npm bootstrap entrypoint",
  );
  const packageRoot = externalOwningPackageRoot(entrypoint, "npm");
  const manifest = readPackage(packageRoot);
  const files = walkPackageFiles(packageRoot, { includeNodeModules: true });
  const entrypointRelativePath = normalizePath(
    path.relative(packageRoot, entrypoint),
  );
  if (
    entrypointRelativePath === ".." ||
    entrypointRelativePath.startsWith("../") ||
    path.isAbsolute(entrypointRelativePath)
  ) {
    throw new Error("npm bootstrap entrypoint escapes its package");
  }
  const payload = {
    schemaVersion: NPM_BOOTSTRAP_IDENTITY_SCHEMA_VERSION,
    name: manifest.value.name,
    version: manifest.value.version,
    entrypointRelativePath,
    entrypointSha256: sha256File(entrypoint),
    fileCount: files.length,
    filesSha256: sha256Bytes(stableJson(files)),
  };
  return {
    ...payload,
    digestSha256: sha256Bytes(stableJson(payload)),
  };
}

export function assertProductionNpmBootstrapIdentityCurrent(
  npmEntrypoint,
  expected,
) {
  const current = captureProductionNpmBootstrapIdentity(npmEntrypoint);
  if (stableJson(current) !== stableJson(expected)) {
    throw new Error(
      "production npm bootstrap dependency identity changed during canonical preparation",
    );
  }
  return current;
}

function controllerRuntimeDependencyClosure(repoRootValue) {
  const repoRoot = realpathSync(repoRootValue);
  const controllerRoot = realpathSync(
    path.join(repoRoot, "packages", "rbp-conformance"),
  );
  const controller = readPackage(controllerRoot);
  const declarations = dependencyDeclarations(controller.value)
    .filter((entry) => entry.dependencyName !== "@revagent/protocol");
  const queue = [];
  const resolutions = [];
  for (const declaration of declarations) {
    const candidate = dependencyCandidate(
      repoRoot,
      controllerRoot,
      declaration.dependencyName,
    );
    if (candidate === undefined) {
      if (!declaration.optional) {
        throw new Error(
          `controller runtime dependency is missing: ${declaration.dependencyName}`,
        );
      }
      resolutions.push({
        requesterName: controller.value.name,
        requesterPath: normalizePath(path.relative(repoRoot, controllerRoot)),
        dependencyName: declaration.dependencyName,
        dependencyRange: declaration.dependencyRange,
        kind: declaration.kind,
        status: "absent_optional",
        resolvedPackagePath: null,
        resolvedVersion: null,
      });
      continue;
    }
    verifyNodePackageResolution(
      repoRoot,
      controllerRoot,
      declaration.dependencyName,
      candidate.resolved,
    );
    const resolved = readPackage(candidate.resolved);
    resolutions.push({
      requesterName: controller.value.name,
      requesterPath: normalizePath(path.relative(repoRoot, controllerRoot)),
      dependencyName: declaration.dependencyName,
      dependencyRange: declaration.dependencyRange,
      kind: declaration.kind,
      status: "installed",
      resolvedPackagePath: normalizePath(path.relative(repoRoot, candidate.resolved)),
      resolvedVersion: resolved.value.version,
    });
    queue.push(candidate.resolved);
  }

  const visited = new Set();
  const packages = new Map();
  while (queue.length > 0) {
    const requesterRoot = queue.shift();
    if (visited.has(requesterRoot)) continue;
    visited.add(requesterRoot);
    const requester = readPackage(requesterRoot);
    const requesterPath = normalizePath(path.relative(repoRoot, requesterRoot));
    packages.set(requesterRoot, packageIdentity(repoRoot, requesterRoot));
    for (const declaration of dependencyDeclarations(requester.value)) {
      const candidate = dependencyCandidate(
        repoRoot,
        requesterRoot,
        declaration.dependencyName,
      );
      if (candidate === undefined) {
        if (!declaration.optional) {
          throw new Error(
            `${requester.value.name} required runtime dependency is missing: ` +
              declaration.dependencyName,
          );
        }
        resolutions.push({
          requesterName: requester.value.name,
          requesterPath,
          dependencyName: declaration.dependencyName,
          dependencyRange: declaration.dependencyRange,
          kind: declaration.kind,
          status: "absent_optional",
          resolvedPackagePath: null,
          resolvedVersion: null,
        });
        continue;
      }
      const resolved = readPackage(candidate.resolved);
      if (resolved.value.name !== declaration.dependencyName) {
        throw new Error(
          `${requester.value.name} resolved ${declaration.dependencyName} ` +
            `to ${resolved.value.name}`,
        );
      }
      verifyNodePackageResolution(
        repoRoot,
        requesterRoot,
        declaration.dependencyName,
        candidate.resolved,
      );
      resolutions.push({
        requesterName: requester.value.name,
        requesterPath,
        dependencyName: declaration.dependencyName,
        dependencyRange: declaration.dependencyRange,
        kind: declaration.kind,
        status: "installed",
        resolvedPackagePath: normalizePath(
          path.relative(repoRoot, candidate.resolved),
        ),
        resolvedVersion: resolved.value.version,
      });
      if (!visited.has(candidate.resolved)) queue.push(candidate.resolved);
    }
  }
  resolutions.sort((left, right) =>
    compareText(
      [
        left.requesterPath,
        left.dependencyName,
        left.kind,
        left.resolvedPackagePath ?? "",
      ].join("\0"),
      [
        right.requesterPath,
        right.dependencyName,
        right.kind,
        right.resolvedPackagePath ?? "",
      ].join("\0"),
    )
  );
  return {
    root: {
      name: controller.value.name,
      version: controller.value.version,
      packagePath: normalizePath(path.relative(repoRoot, controllerRoot)),
    },
    resolutions,
    packages: [...packages.values()]
      .sort((left, right) => compareText(left.packagePath, right.packagePath)),
  };
}

export function captureProductionControllerRuntimeIdentity(repoRootValue) {
  const repoRoot = realpathSync(repoRootValue);
  const payload = {
    schemaVersion: CONTROLLER_RUNTIME_IDENTITY_SCHEMA_VERSION,
    dependencyClosure: controllerRuntimeDependencyClosure(repoRoot),
  };
  return {
    ...payload,
    digestSha256: sha256Bytes(stableJson(payload)),
  };
}

export function assertProductionControllerRuntimeIdentityCurrent(
  repoRoot,
  expected,
) {
  const current = captureProductionControllerRuntimeIdentity(repoRoot);
  if (stableJson(current) !== stableJson(expected)) {
    throw new Error(
      "production controller runtime dependency identity changed during canonical preparation",
    );
  }
  return current;
}

export function assertProductionBootstrapIdentityCurrent(
  repoRoot,
  expected,
) {
  const current = captureProductionBootstrapIdentity(repoRoot);
  if (stableJson(current) !== stableJson(expected)) {
    throw new Error(
      "production bootstrap build dependency identity changed during canonical preparation",
    );
  }
  return current;
}

function isGitExecutableArgument(value) {
  return value === "--git-executable" || value.startsWith("--git-executable=");
}

export function parsePrepareBootstrapArguments(argv) {
  const forwardedArgs = [];
  let npmExecutable;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (isGitExecutableArgument(value)) {
      throw new Error(
        "--git-executable is selected by the canonical preparation wrapper",
      );
    }
    if (value === "--npm-executable") {
      const candidate = argv[index + 1];
      if (candidate === undefined || npmExecutable !== undefined) {
        throw new Error("--npm-executable requires exactly one absolute path");
      }
      npmExecutable = candidate;
      index += 1;
    } else {
      forwardedArgs.push(value);
    }
  }
  if (npmExecutable === undefined) {
    throw new Error("canonical production preparation requires --npm-executable");
  }
  if (!path.isAbsolute(npmExecutable)) {
    throw new Error("--npm-executable requires exactly one absolute path");
  }
  return { forwardedArgs, npmExecutable };
}

export function innerPrepareArguments(forwardedArgs, gitExecutable) {
  if (!path.isAbsolute(gitExecutable)) {
    throw new Error("canonical Git executable must be absolute");
  }
  if (forwardedArgs.some((value) => isGitExecutableArgument(value))) {
    throw new Error(
      "--git-executable is selected by the canonical preparation wrapper",
    );
  }
  return [
    "prepare-production",
    ...forwardedArgs,
    "--git-executable",
    gitExecutable,
  ];
}

export function canonicalWindowsWhereExecutable(environment = process.env) {
  const systemRoot = environment.SystemRoot ?? environment.WINDIR;
  if (systemRoot === undefined || !path.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable for Git resolution");
  }
  return path.resolve(systemRoot, "System32", "where.exe");
}
