import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { sha256File } from "./executionPlan.js";
import { validateSchema } from "./schemas.js";
import { sha256Json, sha256Text, stableJson } from "./stableJson.js";
import type {
  ComponentBuildProvenanceIdentity,
  ComponentId,
  SourceIdentity,
} from "./types.js";

export const PRODUCTION_BUILD_PROVENANCE_SCHEMA_VERSION =
  "rbp-production-build-provenance/v1" as const;
export const PRODUCTION_BUILD_CONTRACT_VERSION =
  "rbp-production-typescript-build/v1" as const;
export const PRODUCTION_FILE_SET_ALGORITHM =
  "sha256-stable-json-path-file-sha256/v1" as const;
export const TYPESCRIPT_ENTRYPOINT_PATH =
  "node_modules/typescript/lib/tsc.js" as const;

interface FileRecord {
  path: string;
  sha256: string;
}

interface ProvenanceFileSet {
  algorithm: typeof PRODUCTION_FILE_SET_ALGORITHM;
  digestSha256: string;
  files: FileRecord[];
}

interface ProductionToolchainIdentity {
  nodeVersion: string;
  typescriptVersion: string;
  typescriptEntrypointPath: typeof TYPESCRIPT_ENTRYPOINT_PATH;
  typescriptEntrypointSha256: string;
}

export interface ProductionBuildProvenanceSidecar {
  schemaVersion: typeof PRODUCTION_BUILD_PROVENANCE_SCHEMA_VERSION;
  buildContractVersion: typeof PRODUCTION_BUILD_CONTRACT_VERSION;
  componentId: ComponentId;
  source: {
    commitSha: string;
    treeSha: string;
  };
  entrypoint: FileRecord;
  compileInputs: ProvenanceFileSet;
  runtimeArtifacts: ProvenanceFileSet;
  toolchain: ProductionToolchainIdentity;
}

interface ProductionProvenanceSpec {
  id: ComponentId;
  entrypointPath: string;
  sidecarPath: string;
  compilePackages: readonly CompilePackage[];
  runtimeRoots: readonly string[];
}

type CompilePackage =
  | "protocol"
  | "gateway-stub"
  | "bridge-simulator"
  | "addin-loopback-fixture";

const ROOT_COMPILE_INPUTS = [
  "package-lock.json",
  "package.json",
  "tsconfig.base.json",
] as const;

const PROTOCOL_BUILD_SCRIPTS = [
  "packages/protocol/scripts/clean.mjs",
  "packages/protocol/scripts/generate-types.mjs",
] as const;

const PRODUCTION_PROVENANCE_SPECS: readonly ProductionProvenanceSpec[] = [
  {
    id: "gateway_stub",
    entrypointPath: "packages/gateway-stub/dist/cli.js",
    sidecarPath: "packages/gateway-stub/dist/rbp-build-provenance.json",
    compilePackages: ["protocol", "gateway-stub"],
    runtimeRoots: ["packages/protocol/dist", "packages/gateway-stub/dist"],
  },
  {
    id: "bridge_simulator",
    entrypointPath: "packages/bridge-simulator/dist/cli.js",
    sidecarPath: "packages/bridge-simulator/dist/rbp-build-provenance.json",
    compilePackages: ["protocol", "addin-loopback-fixture", "bridge-simulator"],
    runtimeRoots: [
      "packages/protocol/dist",
      "packages/addin-loopback-fixture/dist",
      "packages/bridge-simulator/dist",
    ],
  },
  {
    id: "addin_loopback_fixture",
    entrypointPath: "packages/addin-loopback-fixture/dist/cli.js",
    sidecarPath: "packages/addin-loopback-fixture/dist/rbp-build-provenance.json",
    compilePackages: ["protocol", "addin-loopback-fixture"],
    runtimeRoots: ["packages/protocol/dist", "packages/addin-loopback-fixture/dist"],
  },
] as const;

const ALL_SIDECAR_PATHS = new Set(
  PRODUCTION_PROVENANCE_SPECS.map(({ sidecarPath }) => sidecarPath),
);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function git(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return String(result.stdout);
}

function confinedExistingPath(repoRoot: string, relativePath: string): string {
  const root = realpathSync(repoRoot);
  const candidate = realpathSync(path.resolve(repoRoot, relativePath));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`production provenance path escapes the repository: ${relativePath}`);
  }
  return candidate;
}

function fileRecord(repoRoot: string, relativePath: string): FileRecord {
  const normalized = normalizeRelativePath(relativePath);
  const lexical = path.resolve(repoRoot, normalized);
  if (lstatSync(lexical).isSymbolicLink()) {
    throw new Error(`production provenance input cannot be a symbolic link: ${normalized}`);
  }
  const absolute = confinedExistingPath(repoRoot, normalized);
  if (!statSync(absolute).isFile()) {
    throw new Error(`production provenance input is not a regular file: ${normalized}`);
  }
  return { path: normalized, sha256: sha256File(absolute) };
}

function fileSet(files: FileRecord[]): ProvenanceFileSet {
  if (files.length === 0) {
    throw new Error("production provenance file set cannot be empty");
  }
  const ordered = [...files].sort((left, right) => compareText(left.path, right.path));
  const paths = ordered.map(({ path: filePath }) => filePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("production provenance file set contains duplicate paths");
  }
  return {
    algorithm: PRODUCTION_FILE_SET_ALGORITHM,
    digestSha256: sha256Json(ordered),
    files: ordered,
  };
}

function isPackageCompileInput(relativePath: string, packageName: CompilePackage): boolean {
  const root = `packages/${packageName}/`;
  if (!relativePath.startsWith(root)) return false;
  const withinPackage = relativePath.slice(root.length);
  if (withinPackage === "package.json" || withinPackage === "tsconfig.json") return true;
  if (
    withinPackage.startsWith("src/") &&
    withinPackage.endsWith(".ts") &&
    !withinPackage.endsWith(".test.ts")
  ) {
    return true;
  }
  if (packageName !== "protocol") return false;
  return (
    (withinPackage.startsWith("schemas/") && withinPackage.endsWith(".json")) ||
    withinPackage === "scripts/clean.mjs" ||
    withinPackage === "scripts/generate-types.mjs"
  );
}

function compileInputRecords(
  repoRoot: string,
  spec: ProductionProvenanceSpec,
): FileRecord[] {
  const selectors = [
    ...ROOT_COMPILE_INPUTS,
    ...spec.compilePackages.map((packageName) => `packages/${packageName}`),
  ];
  const tracked = git(repoRoot, ["ls-files", "-z", "--", ...selectors])
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map(normalizeRelativePath)
    .filter((entry) =>
      ROOT_COMPILE_INPUTS.includes(entry as (typeof ROOT_COMPILE_INPUTS)[number]) ||
      spec.compilePackages.some((packageName) => isPackageCompileInput(entry, packageName)),
    )
    .sort(compareText);

  const required = [
    ...ROOT_COMPILE_INPUTS,
    ...spec.compilePackages.flatMap((packageName) => [
      `packages/${packageName}/package.json`,
      `packages/${packageName}/tsconfig.json`,
    ]),
    ...(spec.compilePackages.includes("protocol") ? PROTOCOL_BUILD_SCRIPTS : []),
  ];
  const trackedSet = new Set(tracked);
  for (const requiredPath of required) {
    if (!trackedSet.has(requiredPath)) {
      throw new Error(
        `${spec.id} production compile input is missing or untracked: ${requiredPath}`,
      );
    }
  }
  for (const packageName of spec.compilePackages) {
    const sourcePrefix = `packages/${packageName}/src/`;
    if (!tracked.some((entry) => entry.startsWith(sourcePrefix))) {
      throw new Error(`${spec.id} production compile inputs contain no ${packageName} source`);
    }
  }
  return tracked.map((entry) => fileRecord(repoRoot, entry));
}

function walkRuntimeRoot(
  repoRoot: string,
  relativeRoot: string,
  records: FileRecord[],
): void {
  const absoluteRoot = confinedExistingPath(repoRoot, relativeRoot);
  if (!statSync(absoluteRoot).isDirectory()) {
    throw new Error(`production runtime artifact root is not a directory: ${relativeRoot}`);
  }
  const visit = (absoluteDirectory: string, relativeDirectory: string): void => {
    const entries = readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relative = normalizeRelativePath(path.posix.join(relativeDirectory, entry.name));
      const absolute = path.join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`production runtime artifact cannot be a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile() && !ALL_SIDECAR_PATHS.has(relative)) {
        records.push(fileRecord(repoRoot, relative));
      } else if (!entry.isFile()) {
        throw new Error(`production runtime artifact is not a regular file: ${relative}`);
      }
    }
  };
  visit(absoluteRoot, normalizeRelativePath(relativeRoot));
}

function runtimeArtifactRecords(
  repoRoot: string,
  spec: ProductionProvenanceSpec,
): FileRecord[] {
  const records: FileRecord[] = [];
  for (const runtimeRoot of spec.runtimeRoots) {
    const before = records.length;
    walkRuntimeRoot(repoRoot, runtimeRoot, records);
    if (records.length === before) {
      throw new Error(`${spec.id} production runtime artifact root is empty: ${runtimeRoot}`);
    }
  }
  return records.sort((left, right) => compareText(left.path, right.path));
}

function toolchainIdentity(repoRoot: string): ProductionToolchainIdentity {
  const packageFile = confinedExistingPath(repoRoot, "node_modules/typescript/package.json");
  const packageJson = JSON.parse(readFileSync(packageFile, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("installed TypeScript package does not expose a version");
  }
  return {
    nodeVersion: process.version,
    typescriptVersion: packageJson.version,
    typescriptEntrypointPath: TYPESCRIPT_ENTRYPOINT_PATH,
    typescriptEntrypointSha256: sha256File(
      confinedExistingPath(repoRoot, TYPESCRIPT_ENTRYPOINT_PATH),
    ),
  };
}

function expectedSidecar(
  repoRoot: string,
  source: SourceIdentity,
  spec: ProductionProvenanceSpec,
): ProductionBuildProvenanceSidecar {
  return {
    schemaVersion: PRODUCTION_BUILD_PROVENANCE_SCHEMA_VERSION,
    buildContractVersion: PRODUCTION_BUILD_CONTRACT_VERSION,
    componentId: spec.id,
    source: {
      commitSha: source.commitSha,
      treeSha: source.treeSha,
    },
    entrypoint: fileRecord(repoRoot, spec.entrypointPath),
    compileInputs: fileSet(compileInputRecords(repoRoot, spec)),
    runtimeArtifacts: fileSet(runtimeArtifactRecords(repoRoot, spec)),
    toolchain: toolchainIdentity(repoRoot),
  };
}

function sidecarIdentity(
  sidecarPath: string,
  rawSidecar: string,
  sidecar: ProductionBuildProvenanceSidecar,
): ComponentBuildProvenanceIdentity {
  return {
    schemaVersion: sidecar.schemaVersion,
    buildContractVersion: sidecar.buildContractVersion,
    sidecarPath,
    sidecarSha256: sha256Text(rawSidecar),
    compileInputsSha256: sidecar.compileInputs.digestSha256,
    runtimeArtifactsSha256: sidecar.runtimeArtifacts.digestSha256,
    toolchain: { ...sidecar.toolchain },
  };
}

function parseSidecar(raw: string, sidecarPath: string): ProductionBuildProvenanceSidecar {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `production build provenance sidecar is not JSON (${sidecarPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const issues = validateSchema("buildProvenance", value);
  if (issues.length > 0) {
    throw new Error(
      `production build provenance sidecar is invalid (${sidecarPath}): ${issues
        .map(({ path: issuePath, message }) => `${issuePath} ${message}`)
        .join("; ")}`,
    );
  }
  if (raw !== stableJson(value)) {
    throw new Error(
      `production build provenance sidecar is not canonical deterministic JSON: ${sidecarPath}`,
    );
  }
  return value as ProductionBuildProvenanceSidecar;
}

function specFor(componentId: ComponentId): ProductionProvenanceSpec {
  const spec = PRODUCTION_PROVENANCE_SPECS.find(({ id }) => id === componentId);
  if (spec === undefined) {
    throw new Error(`no production provenance contract exists for ${componentId}`);
  }
  return spec;
}

export function createProductionBuildProvenanceSidecars(
  repoRoot: string,
  source: SourceIdentity,
): ReadonlyMap<ComponentId, ComponentBuildProvenanceIdentity> {
  for (const spec of PRODUCTION_PROVENANCE_SPECS) {
    const sidecar = expectedSidecar(repoRoot, source, spec);
    const target = path.resolve(repoRoot, spec.sidecarPath);
    const parent = confinedExistingPath(repoRoot, path.dirname(spec.sidecarPath));
    if (path.dirname(target) !== parent) {
      throw new Error(`production build provenance sidecar parent mismatch: ${spec.sidecarPath}`);
    }
    writeFileSync(target, stableJson(sidecar), { encoding: "utf8", flag: "w" });
  }
  return verifyProductionBuildProvenance(repoRoot, source);
}

export function verifyProductionBuildProvenance(
  repoRoot: string,
  source: SourceIdentity,
): ReadonlyMap<ComponentId, ComponentBuildProvenanceIdentity> {
  const identities = new Map<ComponentId, ComponentBuildProvenanceIdentity>();
  for (const componentId of PRODUCTION_PROVENANCE_SPECS.map(({ id }) => id)) {
    const spec = specFor(componentId);
    let raw: string;
    try {
      const lexicalSidecar = path.resolve(repoRoot, spec.sidecarPath);
      if (lstatSync(lexicalSidecar).isSymbolicLink()) {
        throw new Error("sidecar cannot be a symbolic link");
      }
      raw = readFileSync(confinedExistingPath(repoRoot, spec.sidecarPath), "utf8");
    } catch (error) {
      throw new Error(
        `production build provenance sidecar is missing or unreadable (${spec.sidecarPath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const sidecar = parseSidecar(raw, spec.sidecarPath);
    const expected = expectedSidecar(repoRoot, source, spec);
    if (stableJson(sidecar.source) !== stableJson(expected.source)) {
      throw new Error(`${componentId} production build provenance source is stale`);
    }
    if (stableJson(sidecar.entrypoint) !== stableJson(expected.entrypoint)) {
      throw new Error(`${componentId} production entrypoint digest is stale or tampered`);
    }
    if (stableJson(sidecar.compileInputs) !== stableJson(expected.compileInputs)) {
      throw new Error(`${componentId} production compile-input provenance is stale`);
    }
    if (stableJson(sidecar.runtimeArtifacts) !== stableJson(expected.runtimeArtifacts)) {
      throw new Error(`${componentId} production runtime artifacts are stale or tampered`);
    }
    if (stableJson(sidecar.toolchain) !== stableJson(expected.toolchain)) {
      throw new Error(`${componentId} production build toolchain provenance is stale`);
    }
    if (stableJson(sidecar) !== stableJson(expected)) {
      throw new Error(`${componentId} production build provenance does not match its contract`);
    }
    identities.set(componentId, sidecarIdentity(spec.sidecarPath, raw, sidecar));
  }
  return identities;
}

export function productionBuildProvenanceSidecarPath(componentId: ComponentId): string {
  return specFor(componentId).sidecarPath;
}

export function productionBuildOutputRoots(): readonly string[] {
  return [
    "packages/protocol/dist",
    "packages/gateway-stub/dist",
    "packages/bridge-simulator/dist",
    "packages/addin-loopback-fixture/dist",
  ];
}
