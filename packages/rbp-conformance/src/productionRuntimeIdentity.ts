import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { sha256File } from "./executionPlan.js";
import {
  resolveProductionGitIdentity,
  type ProductionGitIdentity,
} from "./productionGitIdentity.js";
import { sha256Json } from "./stableJson.js";

export const PRODUCTION_FILE_SET_ALGORITHM =
  "sha256-stable-json-path-file-sha256/v1" as const;
export const INSTALLED_RUNTIME_CLOSURE_SCHEMA_VERSION =
  "rbp-installed-runtime-closure/v1" as const;
export const INSTALLED_RUNTIME_CLOSURE_ALGORITHM =
  "sha256-stable-json-resolved-installed-runtime-closure/v1" as const;
export const TYPESCRIPT_ENTRYPOINT_PATH =
  "node_modules/typescript/lib/tsc.js" as const;

export interface ProvenanceFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ProvenanceFileSet {
  algorithm: typeof PRODUCTION_FILE_SET_ALGORITHM;
  digestSha256: string;
  files: ProvenanceFileRecord[];
}

export interface ProductionPackageContentIdentity {
  name: string;
  version: string;
  packagePath: string;
  contents: ProvenanceFileSet;
  nativeFiles: ProvenanceFileRecord[];
}

export interface ProductionPackageContentSummary {
  name: string;
  version: string;
  packagePath: string;
  fileCount: number;
  filesSha256: string;
  nativeFileCount: number;
  nativeFilesSha256: string;
}

export interface RuntimeDependencyRoot {
  name: string;
  version: string;
  packagePath: string;
}

export type RuntimeDependencyKind =
  | "dependency"
  | "optional_dependency"
  | "peer_dependency"
  | "optional_peer_dependency";

export interface RuntimeDependencyResolution {
  requesterName: string;
  requesterPath: string;
  dependencyName: string;
  dependencyRange: string;
  kind: RuntimeDependencyKind;
  status: "installed" | "workspace" | "absent_optional";
  resolutionPath: string | null;
  resolvedPackagePath: string | null;
  resolvedVersion: string | null;
}

export interface InstalledRuntimeDependencyClosure {
  schemaVersion: typeof INSTALLED_RUNTIME_CLOSURE_SCHEMA_VERSION;
  algorithm: typeof INSTALLED_RUNTIME_CLOSURE_ALGORITHM;
  digestSha256: string;
  roots: RuntimeDependencyRoot[];
  resolutions: RuntimeDependencyResolution[];
  packages: ProductionPackageContentIdentity[];
}

export interface NodeRuntimeMetadata {
  version: string;
  platform: string;
  arch: string;
  modulesAbi: string;
  napiVersion: string | null;
  execPath: string;
}

export type NodeRuntimeMetadataResolver = (
  executable: string,
) => NodeRuntimeMetadata;

export interface ProductionNodeExecutableIdentity {
  path: string;
  realPath: string;
  sha256: string;
  version: string;
  platform: string;
  arch: string;
  modulesAbi: string;
  napiVersion: string | null;
}

export interface ProductionNpmLauncherIdentity {
  path: string;
  realPath: string;
  sha256: string;
  package: ProductionPackageContentIdentity;
}

export interface ProductionPowerShellIdentity {
  path: string;
  realPath: string;
  sha256: string;
  version: string;
}

export interface ProductionTypeScriptIdentity {
  package: ProductionPackageContentIdentity;
  entrypointPath: typeof TYPESCRIPT_ENTRYPOINT_PATH;
  entrypointSha256: string;
}

export interface ProductionToolchainIdentity {
  buildNode: ProductionNodeExecutableIdentity;
  runtimeNode: ProductionNodeExecutableIdentity;
  npmLauncher: ProductionNpmLauncherIdentity;
  typescript: ProductionTypeScriptIdentity;
  git: ProductionGitIdentity;
  powershell: ProductionPowerShellIdentity | null;
}

export interface ProductionToolchainSummary {
  buildNode: ProductionNodeExecutableIdentity;
  runtimeNode: ProductionNodeExecutableIdentity;
  npmLauncher: {
    path: string;
    realPath: string;
    sha256: string;
    package: ProductionPackageContentSummary;
  };
  typescript: {
    package: ProductionPackageContentSummary;
    entrypointPath: typeof TYPESCRIPT_ENTRYPOINT_PATH;
    entrypointSha256: string;
  };
  git: ProductionGitIdentity;
  powershell: ProductionPowerShellIdentity | null;
}

export interface ProductionToolchainInputs {
  buildNodeExecutable: string;
  runtimeNodeExecutable: string;
  npmExecutable: string;
  gitExecutable?: string;
  nodeMetadataResolver?: NodeRuntimeMetadataResolver;
}

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  peerDependenciesMeta?: unknown;
}

const RUNTIME_RESOLUTION_ENVIRONMENT_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "WS_NO_BUFFER_UTIL",
  "WS_NO_UTF_8_VALIDATE",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function assertPortableLogicalPath(value: string, label: string): void {
  const normalized = value.normalize("NFC");
  if (
    value !== normalized ||
    value.length === 0 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((segment) =>
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes(":") ||
      segment.endsWith(".") ||
      segment.endsWith(" "))
  ) {
    throw new Error(`${label} is not a canonical portable logical path: ${value}`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function sanitizedProductionRuntimeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!RUNTIME_RESOLUTION_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (RUNTIME_RESOLUTION_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      throw new Error(`production child environment cannot set ${key}`);
    }
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

function exactPackageManifest(packageRoot: string): {
  name: string;
  version: string;
  value: PackageManifest;
} {
  const packageFile = path.join(packageRoot, "package.json");
  const value = JSON.parse(readFileSync(packageFile, "utf8")) as PackageManifest;
  if (
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new Error(`installed package lacks a name/version: ${packageFile}`);
  }
  return { name: value.name, version: value.version, value };
}

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, range]) => typeof range !== "string" || range.length === 0)) {
    throw new Error(`${label} must contain only nonempty string ranges`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalPeerNames(value: unknown): Set<string> {
  if (value === undefined) return new Set();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("peerDependenciesMeta must be an object");
  }
  return new Set(
    Object.entries(value)
      .filter(([, metadata]) =>
        typeof metadata === "object" &&
        metadata !== null &&
        !Array.isArray(metadata) &&
        (metadata as { optional?: unknown }).optional === true)
      .map(([name]) => name),
  );
}

function walkFiles(
  rootValue: string,
  options: { includeNodeModules: boolean },
): ProvenanceFileRecord[] {
  const root = realpathSync(rootValue);
  if (!statSync(root).isDirectory()) {
    throw new Error(`package content root is not a directory: ${rootValue}`);
  }
  const records: ProvenanceFileRecord[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (!options.includeNodeModules && entry.isDirectory() && entry.name === "node_modules") {
        continue;
      }
      const relative = normalizePath(path.posix.join(relativeDirectory, entry.name));
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`production package content cannot contain a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        assertPortableLogicalPath(relative, "production package content path");
        const file = statSync(absolute);
        records.push({
          path: relative,
          bytes: file.size,
          sha256: sha256File(absolute),
        });
      } else {
        throw new Error(`production package content is not a regular file: ${relative}`);
      }
    }
  };
  visit(root, "");
  if (records.length === 0) {
    throw new Error(`production package content is empty: ${rootValue}`);
  }
  return records;
}

export function provenanceFileSet(
  files: readonly ProvenanceFileRecord[],
): ProvenanceFileSet {
  if (files.length === 0) {
    throw new Error("production provenance file set cannot be empty");
  }
  const ordered = [...files].sort((left, right) => compareText(left.path, right.path));
  const paths = ordered.map(({ path: filePath }) => filePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("production provenance file set contains duplicate paths");
  }
  const aliases = ordered.map(({ path: filePath }) => filePath.normalize("NFC").toLocaleLowerCase("en-US"));
  if (new Set(aliases).size !== aliases.length) {
    throw new Error("production provenance file set contains a case or Unicode path alias");
  }
  return {
    algorithm: PRODUCTION_FILE_SET_ALGORITHM,
    digestSha256: sha256Json(ordered),
    files: ordered,
  };
}

function packageContentIdentity(
  packageRootValue: string,
  packagePath: string,
  options: { includeNodeModules: boolean },
): ProductionPackageContentIdentity {
  const packageRoot = realpathSync(packageRootValue);
  const manifest = exactPackageManifest(packageRoot);
  const files = walkFiles(packageRoot, options);
  const nativeFiles = files
    .filter(({ path: filePath }) => filePath.toLowerCase().endsWith(".node"))
    .map((entry) => ({ ...entry }));
  return {
    name: manifest.name,
    version: manifest.version,
    packagePath: normalizePath(packagePath),
    contents: provenanceFileSet(files),
    nativeFiles,
  };
}

function repoRelativePackagePath(repoRoot: string, packageRoot: string): string {
  const root = realpathSync(repoRoot);
  const candidate = realpathSync(packageRoot);
  if (!isInside(root, candidate)) {
    throw new Error(`installed runtime package escapes the source repository: ${packageRoot}`);
  }
  return normalizePath(path.relative(root, candidate));
}

function dependencyPackageRoot(
  repoRoot: string,
  requesterRootValue: string,
  dependencyName: string,
): { lexical: string; resolved: string } | undefined {
  const root = realpathSync(repoRoot);
  let cursor = realpathSync(requesterRootValue);
  const dependencySegments = dependencyName.split("/");
  while (isInside(root, cursor)) {
    const candidate = path.join(cursor, "node_modules", ...dependencySegments);
    const packageFile = path.join(candidate, "package.json");
    if (existsSync(packageFile)) {
      const lexical = lstatSync(candidate);
      if (!lexical.isDirectory() && !lexical.isSymbolicLink()) {
        throw new Error(`installed dependency is not a directory: ${candidate}`);
      }
      const resolved = realpathSync(candidate);
      if (!isInside(root, resolved)) {
        throw new Error(`installed dependency resolves outside the repository: ${dependencyName}`);
      }
      return { lexical: candidate, resolved };
    }
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

function workspaceRoots(repoRoot: string): ReadonlySet<string> {
  const packagesRoot = path.join(realpathSync(repoRoot), "packages");
  if (!existsSync(packagesRoot)) return new Set();
  const roots = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesRoot, entry.name))
    .filter((candidate) => existsSync(path.join(candidate, "package.json")))
    .map((candidate) => realpathSync(candidate));
  return new Set(roots);
}

function declarationRows(manifest: PackageManifest): Array<{
  dependencyName: string;
  dependencyRange: string;
  kind: RuntimeDependencyKind;
  optional: boolean;
}> {
  const dependencies = stringMap(manifest.dependencies, "dependencies");
  const optionalDependencies = stringMap(
    manifest.optionalDependencies,
    "optionalDependencies",
  );
  const peers = stringMap(manifest.peerDependencies, "peerDependencies");
  const optionalPeers = optionalPeerNames(manifest.peerDependenciesMeta);
  const rows: Array<{
    dependencyName: string;
    dependencyRange: string;
    kind: RuntimeDependencyKind;
    optional: boolean;
  }> = [];
  for (const dependencyName of Object.keys(dependencies).sort(compareText)) {
    if (Object.hasOwn(optionalDependencies, dependencyName)) continue;
    rows.push({
      dependencyName,
      dependencyRange: dependencies[dependencyName]!,
      kind: "dependency",
      optional: false,
    });
  }
  for (const dependencyName of Object.keys(optionalDependencies).sort(compareText)) {
    rows.push({
      dependencyName,
      dependencyRange: optionalDependencies[dependencyName]!,
      kind: "optional_dependency",
      optional: true,
    });
  }
  for (const dependencyName of Object.keys(peers).sort(compareText)) {
    const optional = optionalPeers.has(dependencyName);
    rows.push({
      dependencyName,
      dependencyRange: peers[dependencyName]!,
      kind: optional ? "optional_peer_dependency" : "peer_dependency",
      optional,
    });
  }
  return rows;
}

export function resolveInstalledRuntimeDependencyClosure(
  repoRootValue: string,
  rootPackagePaths: readonly string[],
): InstalledRuntimeDependencyClosure {
  const repoRoot = realpathSync(repoRootValue);
  const workspaces = workspaceRoots(repoRoot);
  const roots = rootPackagePaths.map((relativePath) => {
    const candidate = realpathSync(path.resolve(repoRoot, relativePath));
    if (!isInside(repoRoot, candidate)) {
      throw new Error(`runtime dependency root escapes repository: ${relativePath}`);
    }
    const manifest = exactPackageManifest(candidate);
    return {
      absolute: candidate,
      record: {
        name: manifest.name,
        version: manifest.version,
        packagePath: normalizePath(path.relative(repoRoot, candidate)),
      } satisfies RuntimeDependencyRoot,
    };
  }).sort((left, right) => compareText(left.record.packagePath, right.record.packagePath));

  const queue = roots.map(({ absolute }) => absolute);
  const visited = new Set<string>();
  const resolutions: RuntimeDependencyResolution[] = [];
  const packages = new Map<string, ProductionPackageContentIdentity>();

  while (queue.length > 0) {
    const requesterRoot = queue.shift()!;
    if (visited.has(requesterRoot)) continue;
    visited.add(requesterRoot);
    const requester = exactPackageManifest(requesterRoot);
    const requesterPath = repoRelativePackagePath(repoRoot, requesterRoot);
    for (const declaration of declarationRows(requester.value)) {
      const resolvedPackage = dependencyPackageRoot(
        repoRoot,
        requesterRoot,
        declaration.dependencyName,
      );
      if (resolvedPackage === undefined) {
        if (!declaration.optional) {
          throw new Error(
            `${requester.name} required runtime dependency is not installed: ${declaration.dependencyName}`,
          );
        }
        resolutions.push({
          requesterName: requester.name,
          requesterPath,
          dependencyName: declaration.dependencyName,
          dependencyRange: declaration.dependencyRange,
          kind: declaration.kind,
          status: "absent_optional",
          resolutionPath: null,
          resolvedPackagePath: null,
          resolvedVersion: null,
        });
        continue;
      }
      const resolvedRoot = resolvedPackage.resolved;
      const resolved = exactPackageManifest(resolvedRoot);
      if (resolved.name !== declaration.dependencyName) {
        throw new Error(
          `${requester.name} resolved ${declaration.dependencyName} to unexpected package ${resolved.name}`,
        );
      }
      const resolvedPackagePath = repoRelativePackagePath(repoRoot, resolvedRoot);
      const workspace = workspaces.has(resolvedRoot);
      const lexicalStat = lstatSync(resolvedPackage.lexical);
      if (lexicalStat.isSymbolicLink() && !workspace) {
        throw new Error(
          `${requester.name} external runtime dependency is a symbolic link: ${declaration.dependencyName}`,
        );
      }
      const resolutionPath = normalizePath(path.relative(repoRoot, resolvedPackage.lexical));
      assertPortableLogicalPath(resolutionPath, "runtime dependency resolution path");
      resolutions.push({
        requesterName: requester.name,
        requesterPath,
        dependencyName: declaration.dependencyName,
        dependencyRange: declaration.dependencyRange,
        kind: declaration.kind,
        status: workspace ? "workspace" : "installed",
        resolutionPath,
        resolvedPackagePath,
        resolvedVersion: resolved.version,
      });
      if (!workspace && !packages.has(resolvedRoot)) {
        packages.set(
          resolvedRoot,
          packageContentIdentity(resolvedRoot, resolvedPackagePath, {
            includeNodeModules: false,
          }),
        );
      }
      if (!visited.has(resolvedRoot)) queue.push(resolvedRoot);
    }
  }

  const orderedRoots = roots.map(({ record }) => record);
  const orderedResolutions = resolutions.sort((left, right) =>
    compareText(
      [
        left.requesterPath,
        left.dependencyName,
        left.kind,
        left.resolvedPackagePath ?? "",
      ].join("\u0000"),
      [
        right.requesterPath,
        right.dependencyName,
        right.kind,
        right.resolvedPackagePath ?? "",
      ].join("\u0000"),
    ));
  const orderedPackages = [...packages.values()]
    .sort((left, right) => compareText(left.packagePath, right.packagePath));
  const digestSha256 = sha256Json({
    roots: orderedRoots,
    resolutions: orderedResolutions,
    packages: orderedPackages,
  });
  return {
    schemaVersion: INSTALLED_RUNTIME_CLOSURE_SCHEMA_VERSION,
    algorithm: INSTALLED_RUNTIME_CLOSURE_ALGORITHM,
    digestSha256,
    roots: orderedRoots,
    resolutions: orderedResolutions,
    packages: orderedPackages,
  };
}

function defaultNodeMetadataResolver(executable: string): NodeRuntimeMetadata {
  const script = [
    "process.stdout.write(JSON.stringify({",
    "version:process.version,",
    "platform:process.platform,",
    "arch:process.arch,",
    "modulesAbi:process.versions.modules,",
    "napiVersion:process.versions.napi??null,",
    "execPath:process.execPath",
    "}))",
  ].join("");
  const result = spawnSync(executable, ["--input-type=commonjs", "-e", script], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 15_000,
    env: sanitizedProductionRuntimeEnvironment(),
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Node identity probe failed for ${executable}: ${String(result.stderr).trim()}`,
    );
  }
  const value = JSON.parse(String(result.stdout)) as Partial<NodeRuntimeMetadata>;
  if (
    typeof value.version !== "string" ||
    typeof value.platform !== "string" ||
    typeof value.arch !== "string" ||
    typeof value.modulesAbi !== "string" ||
    (value.napiVersion !== null && typeof value.napiVersion !== "string") ||
    typeof value.execPath !== "string"
  ) {
    throw new Error(`Node identity probe returned malformed metadata for ${executable}`);
  }
  return value as NodeRuntimeMetadata;
}

export function resolveNodeExecutableIdentity(
  executableValue: string,
  metadataResolver: NodeRuntimeMetadataResolver = defaultNodeMetadataResolver,
): ProductionNodeExecutableIdentity {
  if (!path.isAbsolute(executableValue)) {
    throw new Error(`Node executable must be absolute: ${executableValue}`);
  }
  const executable = path.resolve(executableValue);
  if (lstatSync(executable).isSymbolicLink()) {
    throw new Error(`Node executable cannot be a symbolic link: ${executable}`);
  }
  const realExecutable = realpathSync(executable);
  if (!statSync(realExecutable).isFile()) {
    throw new Error(`Node executable is not a regular file: ${executable}`);
  }
  const metadata = metadataResolver(executable);
  if (realpathSync(metadata.execPath) !== realExecutable) {
    throw new Error(
      `Node identity probe executed ${metadata.execPath} instead of ${realExecutable}`,
    );
  }
  return {
    path: normalizePath(executable),
    realPath: normalizePath(realExecutable),
    sha256: sha256File(realExecutable),
    version: metadata.version,
    platform: metadata.platform,
    arch: metadata.arch,
    modulesAbi: metadata.modulesAbi,
    napiVersion: metadata.napiVersion,
  };
}

function owningPackageRoot(fileValue: string, expectedName: string): string {
  const file = realpathSync(fileValue);
  let cursor = path.dirname(file);
  while (true) {
    const packageFile = path.join(cursor, "package.json");
    if (existsSync(packageFile)) {
      const manifest = exactPackageManifest(cursor);
      if (manifest.name === expectedName) return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`${fileValue} is not owned by installed package ${expectedName}`);
}

function npmLauncherIdentity(npmExecutableValue: string): ProductionNpmLauncherIdentity {
  if (!path.isAbsolute(npmExecutableValue)) {
    throw new Error(`npm launcher must be absolute: ${npmExecutableValue}`);
  }
  const executable = path.resolve(npmExecutableValue);
  if (lstatSync(executable).isSymbolicLink()) {
    throw new Error(`npm launcher cannot be a symbolic link: ${executable}`);
  }
  const realExecutable = realpathSync(executable);
  if (!statSync(realExecutable).isFile()) {
    throw new Error(`npm launcher is not a regular file: ${executable}`);
  }
  const packageRoot = owningPackageRoot(realExecutable, "npm");
  return {
    path: normalizePath(executable),
    realPath: normalizePath(realExecutable),
    sha256: sha256File(realExecutable),
    package: packageContentIdentity(packageRoot, normalizePath(packageRoot), {
      includeNodeModules: true,
    }),
  };
}

export function resolvePowerShellIdentity(): ProductionPowerShellIdentity | null {
  if (process.platform !== "win32") return null;
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined || !path.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable for the canonical PowerShell identity");
  }
  const executable = path.resolve(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (lstatSync(executable).isSymbolicLink()) {
    throw new Error(`PowerShell executable cannot be a symbolic link: ${executable}`);
  }
  const realExecutable = realpathSync(executable);
  if (!statSync(realExecutable).isFile()) {
    throw new Error(`PowerShell executable is not a regular file: ${executable}`);
  }
  const result = spawnSync(
    realExecutable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 15_000,
      env: sanitizedProductionRuntimeEnvironment(),
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`PowerShell identity probe failed: ${String(result.stderr).trim()}`);
  }
  const version = String(result.stdout).trim();
  if (!/^[0-9]+\.[0-9]+(?:\.[0-9]+){0,2}$/u.test(version)) {
    throw new Error(`PowerShell identity probe returned an unexpected version: ${version}`);
  }
  return {
    path: normalizePath(executable),
    realPath: normalizePath(realExecutable),
    sha256: sha256File(realExecutable),
    version,
  };
}

/**
 * Revalidates a PowerShell identity without starting another interpreter.
 * The version probe belongs to the prepare/run boundary. Launch-time guards
 * bind the already-recorded version to the same canonical path and bytes.
 */
export function verifyPowerShellIdentityCurrent(
  expected: ProductionPowerShellIdentity,
): ProductionPowerShellIdentity {
  if (process.platform !== "win32") {
    throw new Error("a bound PowerShell identity is invalid on this platform");
  }
  const executable = path.resolve(expected.path);
  if (lstatSync(executable).isSymbolicLink()) {
    throw new Error(`PowerShell executable cannot be a symbolic link: ${executable}`);
  }
  const realExecutable = realpathSync(executable);
  if (!statSync(realExecutable).isFile()) {
    throw new Error(`PowerShell executable is not a regular file: ${executable}`);
  }
  const current = {
    ...expected,
    path: normalizePath(executable),
    realPath: normalizePath(realExecutable),
    sha256: sha256File(realExecutable),
  };
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("bound PowerShell path or bytes changed");
  }
  return current;
}

function typescriptIdentity(repoRootValue: string): ProductionTypeScriptIdentity {
  const repoRoot = realpathSync(repoRootValue);
  const packageRoot = realpathSync(path.join(repoRoot, "node_modules", "typescript"));
  if (!isInside(repoRoot, packageRoot)) {
    throw new Error("installed TypeScript package resolves outside the repository");
  }
  const packagePath = normalizePath(path.relative(repoRoot, packageRoot));
  const entrypoint = realpathSync(path.join(repoRoot, TYPESCRIPT_ENTRYPOINT_PATH));
  if (!isInside(packageRoot, entrypoint) || !statSync(entrypoint).isFile()) {
    throw new Error("TypeScript compiler entrypoint is not inside its installed package");
  }
  return {
    package: packageContentIdentity(packageRoot, packagePath, {
      includeNodeModules: false,
    }),
    entrypointPath: TYPESCRIPT_ENTRYPOINT_PATH,
    entrypointSha256: sha256File(entrypoint),
  };
}

export function resolveProductionToolchainIdentity(
  repoRoot: string,
  input: ProductionToolchainInputs,
): ProductionToolchainIdentity {
  const metadataResolver = input.nodeMetadataResolver ?? defaultNodeMetadataResolver;
  return {
    buildNode: resolveNodeExecutableIdentity(input.buildNodeExecutable, metadataResolver),
    runtimeNode: resolveNodeExecutableIdentity(input.runtimeNodeExecutable, metadataResolver),
    npmLauncher: npmLauncherIdentity(input.npmExecutable),
    typescript: typescriptIdentity(repoRoot),
    git: resolveProductionGitIdentity(input.gitExecutable),
    powershell: resolvePowerShellIdentity(),
  };
}

function summarizePackage(
  value: ProductionPackageContentIdentity,
): ProductionPackageContentSummary {
  return {
    name: value.name,
    version: value.version,
    packagePath: value.packagePath,
    fileCount: value.contents.files.length,
    filesSha256: value.contents.digestSha256,
    nativeFileCount: value.nativeFiles.length,
    nativeFilesSha256: sha256Json(value.nativeFiles),
  };
}

export function summarizeProductionToolchainIdentity(
  value: ProductionToolchainIdentity,
): ProductionToolchainSummary {
  return {
    buildNode: { ...value.buildNode },
    runtimeNode: { ...value.runtimeNode },
    npmLauncher: {
      path: value.npmLauncher.path,
      realPath: value.npmLauncher.realPath,
      sha256: value.npmLauncher.sha256,
      package: summarizePackage(value.npmLauncher.package),
    },
    typescript: {
      package: summarizePackage(value.typescript.package),
      entrypointPath: value.typescript.entrypointPath,
      entrypointSha256: value.typescript.entrypointSha256,
    },
    git: { ...value.git },
    powershell: value.powershell === null ? null : { ...value.powershell },
  };
}

export function normalizeExecutablePath(value: string): string {
  return normalizePath(path.resolve(value));
}
