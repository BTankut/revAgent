import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { sha256File } from "./executionPlan.js";
import {
  runBoundGit,
  verifyProductionGitIdentityCurrent,
  type ProductionGitIdentity,
} from "./productionGitIdentity.js";
import { assertTrustedProductionLaunch } from "./productionLaunchAttestation.js";
import {
  normalizeExecutablePath,
  provenanceFileSet,
  resolveInstalledBuildGeneratorDependencyClosure,
  resolveInstalledRuntimeDependencyClosure,
  resolveNodeExecutableIdentity,
  resolvePowerShellIdentity,
  resolveProductionToolchainIdentity,
  summarizeProductionToolchainIdentity,
  verifyPowerShellIdentityCurrent,
  type InstalledBuildGeneratorDependencyClosure,
  type InstalledRuntimeDependencyClosure,
  type NodeRuntimeMetadataResolver,
  type ProductionToolchainIdentity,
  type ProvenanceFileRecord,
  type ProvenanceFileSet,
} from "./productionRuntimeIdentity.js";
import { validateSchema } from "./schemas.js";
import { sha256Text, stableJson } from "./stableJson.js";
import type {
  ComponentBuildProvenanceIdentity,
  ComponentId,
  SourceIdentity,
} from "./types.js";

export const PRODUCTION_BUILD_PROVENANCE_SCHEMA_VERSION =
  "rbp-production-build-provenance/v3" as const;
export const PRODUCTION_BUILD_CONTRACT_VERSION =
  "rbp-production-typescript-build/v3" as const;

export { PRODUCTION_FILE_SET_ALGORITHM } from "./productionRuntimeIdentity.js";

const HARNESS_ENTRYPOINT_PATH = "packages/rbp-conformance/dist/src/cli.js";
const HARNESS_RUNTIME_ROOTS = [
  "packages/rbp-conformance/dist",
  "packages/protocol/dist",
] as const;
const HARNESS_RUNTIME_FILES = [
  "packages/rbp-conformance/scripts/bootstrap-identity.mjs",
  "packages/rbp-conformance/scripts/invoke-production.ps1",
  "packages/rbp-conformance/scripts/prepare-production.mjs",
  "packages/rbp-conformance/scripts/production-cli-bootstrap.mjs",
  "packages/rbp-conformance/scripts/production-launch-attestation.mjs",
] as const;
const HARNESS_RUNTIME_PACKAGE_ROOTS = ["packages/rbp-conformance"] as const;

export interface ProductionHarnessIdentity {
  entrypoint: ProvenanceFileRecord;
  runtimeArtifacts: ProvenanceFileSet;
  runtimeDependencies: InstalledRuntimeDependencyClosure;
}

export interface ProductionBuildProvenanceSidecar {
  schemaVersion: typeof PRODUCTION_BUILD_PROVENANCE_SCHEMA_VERSION;
  buildContractVersion: typeof PRODUCTION_BUILD_CONTRACT_VERSION;
  componentId: ComponentId;
  source: {
    commitSha: string;
    treeSha: string;
  };
  entrypoint: ProvenanceFileRecord;
  compileInputs: ProvenanceFileSet;
  buildGeneratorDependencies: InstalledBuildGeneratorDependencyClosure;
  runtimeArtifacts: ProvenanceFileSet;
  runtimeDependencies: InstalledRuntimeDependencyClosure;
  harness: ProductionHarnessIdentity;
  toolchain: ProductionToolchainIdentity;
}

interface ProductionProvenanceSpec {
  id: ComponentId;
  entrypointPath: string;
  sidecarPath: string;
  compilePackages: readonly CompilePackage[];
  runtimeRoots: readonly string[];
  runtimePackageRoots: readonly string[];
}

export interface ProductionProvenanceInputs {
  buildNodeExecutable: string;
  runtimeNodeExecutable: string;
  npmExecutable: string;
  gitExecutable?: string;
  nodeMetadataResolver?: NodeRuntimeMetadataResolver;
}

export interface ProductionProvenanceVerificationOptions {
  expectedRuntimeNodeExecutable?: string;
  expectedGitExecutable?: string;
  nodeMetadataResolver?: NodeRuntimeMetadataResolver;
}

export interface ProductionRuntimeVerificationOptions {
  expectedRuntimeNodeExecutable: string;
  plannedIdentities: ReadonlyMap<ComponentId, ComponentBuildProvenanceIdentity>;
  nodeMetadataResolver?: NodeRuntimeMetadataResolver;
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
    runtimePackageRoots: ["packages/gateway-stub"],
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
    runtimePackageRoots: ["packages/bridge-simulator"],
  },
  {
    id: "addin_loopback_fixture",
    entrypointPath: "packages/addin-loopback-fixture/dist/cli.js",
    sidecarPath: "packages/addin-loopback-fixture/dist/rbp-build-provenance.json",
    compilePackages: ["protocol", "addin-loopback-fixture"],
    runtimeRoots: ["packages/protocol/dist", "packages/addin-loopback-fixture/dist"],
    runtimePackageRoots: ["packages/addin-loopback-fixture"],
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

function confinedExistingPath(repoRoot: string, relativePath: string): string {
  const root = realpathSync(repoRoot);
  const lexical = path.resolve(root, relativePath);
  if (lstatSync(lexical).isSymbolicLink()) {
    throw new Error(`production provenance path cannot be a symbolic link: ${relativePath}`);
  }
  const candidate = realpathSync(lexical);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`production provenance path escapes the repository: ${relativePath}`);
  }
  return candidate;
}

function fileRecord(repoRoot: string, relativePath: string): ProvenanceFileRecord {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = confinedExistingPath(repoRoot, normalized);
  const stat = statSync(absolute);
  if (!stat.isFile()) {
    throw new Error(`production provenance input is not a regular file: ${normalized}`);
  }
  return {
    path: normalized,
    bytes: stat.size,
    sha256: sha256File(absolute),
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
  gitIdentity: ProductionGitIdentity,
): ProvenanceFileRecord[] {
  const selectors = [
    ...ROOT_COMPILE_INPUTS,
    ...spec.compilePackages.map((packageName) => `packages/${packageName}`),
  ];
  const tracked = runBoundGit(
    repoRoot,
    ["ls-files", "-z", "--", ...selectors],
    gitIdentity,
  ).stdout
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
  records: ProvenanceFileRecord[],
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

function runtimeArtifactFileSet(
  repoRoot: string,
  runtimeRoots: readonly string[],
  label: string,
): ProvenanceFileSet {
  const records: ProvenanceFileRecord[] = [];
  for (const runtimeRoot of runtimeRoots) {
    const before = records.length;
    walkRuntimeRoot(repoRoot, runtimeRoot, records);
    if (records.length === before) {
      throw new Error(`${label} production runtime artifact root is empty: ${runtimeRoot}`);
    }
  }
  return provenanceFileSet(records);
}

export function productionHarnessRuntimeArtifacts(repoRoot: string): ProvenanceFileSet {
  const built = runtimeArtifactFileSet(
    repoRoot,
    HARNESS_RUNTIME_ROOTS,
    "conformance harness",
  );
  return provenanceFileSet([
    ...built.files,
    ...HARNESS_RUNTIME_FILES.map((relativePath) =>
      fileRecord(repoRoot, relativePath)),
  ]);
}

export function productionComponentOutputArtifacts(
  repoRoot: string,
  relativeRoot: string,
): ProvenanceFileSet {
  if (!productionComponentBuildOutputRoots().includes(relativeRoot)) {
    throw new Error(`unknown production component output root: ${relativeRoot}`);
  }
  return runtimeArtifactFileSet(repoRoot, [relativeRoot], relativeRoot);
}

function productionHarnessIdentity(
  repoRoot: string,
  runtimeNode: ProductionToolchainIdentity["runtimeNode"],
): ProductionHarnessIdentity {
  return {
    entrypoint: fileRecord(repoRoot, HARNESS_ENTRYPOINT_PATH),
    runtimeArtifacts: productionHarnessRuntimeArtifacts(repoRoot),
    runtimeDependencies: resolveInstalledRuntimeDependencyClosure(
      repoRoot,
      HARNESS_RUNTIME_PACKAGE_ROOTS,
      runtimeNode,
    ),
  };
}

function expectedSidecar(
  repoRoot: string,
  source: SourceIdentity,
  spec: ProductionProvenanceSpec,
  toolchain: ProductionToolchainIdentity,
  harness: ProductionHarnessIdentity,
  buildGeneratorDependencies: InstalledBuildGeneratorDependencyClosure,
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
    compileInputs: provenanceFileSet(
      compileInputRecords(repoRoot, spec, toolchain.git),
    ),
    buildGeneratorDependencies,
    runtimeArtifacts: runtimeArtifactFileSet(repoRoot, spec.runtimeRoots, spec.id),
    runtimeDependencies: resolveInstalledRuntimeDependencyClosure(
      repoRoot,
      spec.runtimePackageRoots,
      toolchain.runtimeNode,
    ),
    harness,
    toolchain,
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
    buildGeneratorDependenciesSha256:
      sidecar.buildGeneratorDependencies.digestSha256,
    runtimeArtifactsSha256: sidecar.runtimeArtifacts.digestSha256,
    runtimeDependenciesSha256: sidecar.runtimeDependencies.digestSha256,
    harnessArtifactsSha256: sidecar.harness.runtimeArtifacts.digestSha256,
    harnessRuntimeDependenciesSha256:
      sidecar.harness.runtimeDependencies.digestSha256,
    toolchain: summarizeProductionToolchainIdentity(sidecar.toolchain),
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

function readSidecars(
  repoRoot: string,
): Map<ComponentId, { raw: string; sidecar: ProductionBuildProvenanceSidecar }> {
  const sidecars = new Map<
    ComponentId,
    { raw: string; sidecar: ProductionBuildProvenanceSidecar }
  >();
  for (const spec of PRODUCTION_PROVENANCE_SPECS) {
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
    if (sidecar.componentId !== spec.id) {
      throw new Error(`${spec.id} production build provenance is cross-wired`);
    }
    sidecars.set(spec.id, { raw, sidecar });
  }
  return sidecars;
}

function inferredInputs(
  sidecars: ReadonlyMap<
    ComponentId,
    { raw: string; sidecar: ProductionBuildProvenanceSidecar }
  >,
  options: ProductionProvenanceVerificationOptions,
): ProductionProvenanceInputs {
  const first = sidecars.get(PRODUCTION_PROVENANCE_SPECS[0]!.id)?.sidecar;
  if (first === undefined) throw new Error("production build provenance set is empty");
  return {
    buildNodeExecutable: first.toolchain.buildNode.path,
    runtimeNodeExecutable:
      options.expectedRuntimeNodeExecutable ?? first.toolchain.runtimeNode.path,
    npmExecutable: first.toolchain.npmLauncher.path,
    ...(options.expectedGitExecutable === undefined
      ? {}
      : { gitExecutable: options.expectedGitExecutable }),
    ...(options.nodeMetadataResolver === undefined
      ? {}
      : { nodeMetadataResolver: options.nodeMetadataResolver }),
  };
}

export function createProductionBuildProvenanceSidecars(
  repoRoot: string,
  source: SourceIdentity,
  inputs: ProductionProvenanceInputs,
): ReadonlyMap<ComponentId, ComponentBuildProvenanceIdentity> {
  // Sidecars turn ignored build output into production-bound evidence. Refuse
  // to inspect or bless any of those bytes unless this process owns the
  // one-shot receipt issued to the canonical prepare wrapper.
  assertTrustedProductionLaunch(repoRoot, "prepare-wrapper");
  const toolchain = resolveProductionToolchainIdentity(repoRoot, inputs);
  const harness = productionHarnessIdentity(repoRoot, toolchain.runtimeNode);
  const buildGeneratorDependencies =
    resolveInstalledBuildGeneratorDependencyClosure(
      repoRoot,
      toolchain.runtimeNode,
    );
  for (const spec of PRODUCTION_PROVENANCE_SPECS) {
    const sidecar = expectedSidecar(
      repoRoot,
      source,
      spec,
      toolchain,
      harness,
      buildGeneratorDependencies,
    );
    const target = path.resolve(repoRoot, spec.sidecarPath);
    const parent = confinedExistingPath(repoRoot, path.dirname(spec.sidecarPath));
    if (path.dirname(target) !== parent) {
      throw new Error(`production build provenance sidecar parent mismatch: ${spec.sidecarPath}`);
    }
    writeFileSync(target, stableJson(sidecar), { encoding: "utf8", flag: "w" });
  }
  return verifyProductionBuildProvenance(repoRoot, source, {
    expectedRuntimeNodeExecutable: inputs.runtimeNodeExecutable,
    expectedGitExecutable: toolchain.git.path,
    ...(inputs.nodeMetadataResolver === undefined
      ? {}
      : { nodeMetadataResolver: inputs.nodeMetadataResolver }),
  });
}

export function verifyProductionBuildProvenance(
  repoRoot: string,
  source: SourceIdentity,
  options: ProductionProvenanceVerificationOptions = {},
): ReadonlyMap<ComponentId, ComponentBuildProvenanceIdentity> {
  const sidecars = readSidecars(repoRoot);
  const toolchain = resolveProductionToolchainIdentity(
    repoRoot,
    inferredInputs(sidecars, options),
  );
  const harness = productionHarnessIdentity(repoRoot, toolchain.runtimeNode);
  const buildGeneratorDependencies =
    resolveInstalledBuildGeneratorDependencyClosure(
      repoRoot,
      toolchain.runtimeNode,
    );
  const identities = new Map<ComponentId, ComponentBuildProvenanceIdentity>();

  for (const spec of PRODUCTION_PROVENANCE_SPECS) {
    const retained = sidecars.get(spec.id)!;
    const expected = expectedSidecar(
      repoRoot,
      source,
      spec,
      toolchain,
      harness,
      buildGeneratorDependencies,
    );
    const sidecar = retained.sidecar;
    if (stableJson(sidecar.source) !== stableJson(expected.source)) {
      throw new Error(`${spec.id} production build provenance source is stale`);
    }
    if (stableJson(sidecar.entrypoint) !== stableJson(expected.entrypoint)) {
      throw new Error(`${spec.id} production entrypoint digest is stale or tampered`);
    }
    if (stableJson(sidecar.compileInputs) !== stableJson(expected.compileInputs)) {
      throw new Error(`${spec.id} production compile-input provenance is stale`);
    }
    if (
      stableJson(sidecar.buildGeneratorDependencies) !==
      stableJson(expected.buildGeneratorDependencies)
    ) {
      throw new Error(
        `${spec.id} build-generator dependency provenance is stale or tampered`,
      );
    }
    if (stableJson(sidecar.runtimeArtifacts) !== stableJson(expected.runtimeArtifacts)) {
      throw new Error(`${spec.id} production runtime artifacts are stale or tampered`);
    }
    if (
      stableJson(sidecar.runtimeDependencies) !==
      stableJson(expected.runtimeDependencies)
    ) {
      throw new Error(`${spec.id} installed runtime dependency closure is stale or tampered`);
    }
    if (stableJson(sidecar.harness) !== stableJson(expected.harness)) {
      throw new Error(`${spec.id} conformance harness provenance is stale or tampered`);
    }
    if (stableJson(sidecar.toolchain) !== stableJson(expected.toolchain)) {
      throw new Error(`${spec.id} production build toolchain provenance is stale`);
    }
    if (stableJson(sidecar) !== stableJson(expected)) {
      throw new Error(`${spec.id} production build provenance does not match its contract`);
    }
    identities.set(
      spec.id,
      sidecarIdentity(spec.sidecarPath, retained.raw, sidecar),
    );
  }
  return identities;
}

/**
 * Rechecks only bytes that can execute during a production run. Compiler/npm
 * provenance remains a prepare/run-boundary gate, while this cheaper check is
 * safe to call immediately before and after every component spawn.
 */
export function verifyProductionRuntimeBuildProvenance(
  repoRoot: string,
  source: SourceIdentity,
  options: ProductionRuntimeVerificationOptions,
): ReadonlyMap<ComponentId, ComponentBuildProvenanceIdentity> {
  const expectedRuntimePath = normalizeExecutablePath(
    options.expectedRuntimeNodeExecutable,
  );
  const runtimeNode = resolveNodeExecutableIdentity(
    options.expectedRuntimeNodeExecutable,
    options.nodeMetadataResolver,
  );
  const plannedValues = [...options.plannedIdentities.values()];
  const plannedGitIdentities = new Set(
    plannedValues.map(({ toolchain }) => stableJson(toolchain.git)),
  );
  if (plannedGitIdentities.size !== 1) {
    throw new Error("production plan components disagree on the bound Git identity");
  }
  const plannedPowerShellIdentities = new Set(
    plannedValues.map(({ toolchain }) => stableJson(toolchain.powershell)),
  );
  if (plannedPowerShellIdentities.size !== 1) {
    throw new Error("production plan components disagree on the bound PowerShell identity");
  }
  const plannedGit = plannedValues[0]?.toolchain.git;
  if (plannedGit === undefined) {
    throw new Error("production plan lacks a bound Git identity");
  }
  const git = verifyProductionGitIdentityCurrent(plannedGit);
  if (stableJson(git) !== stableJson(plannedGit)) {
    throw new Error("bound Git identity changed before runtime verification");
  }
  const plannedPowerShell = plannedValues[0]?.toolchain.powershell;
  if (plannedPowerShell === undefined) {
    throw new Error("production plan lacks a bound PowerShell identity");
  }
  const powershell = plannedPowerShell === null
    ? resolvePowerShellIdentity()
    : verifyPowerShellIdentityCurrent(plannedPowerShell);
  const sidecars = readSidecars(repoRoot);
  const harness = productionHarnessIdentity(repoRoot, runtimeNode);
  const identities = new Map<ComponentId, ComponentBuildProvenanceIdentity>();

  for (const spec of PRODUCTION_PROVENANCE_SPECS) {
    const retained = sidecars.get(spec.id)!;
    const planned = options.plannedIdentities.get(spec.id);
    if (planned === undefined) {
      throw new Error(`${spec.id} production plan lacks runtime provenance`);
    }
    if (sha256Text(retained.raw) !== planned.sidecarSha256) {
      throw new Error(`${spec.id} production sidecar digest changed after plan creation`);
    }
    const sidecar = retained.sidecar;
    if (stableJson(sidecar.source) !== stableJson({
      commitSha: source.commitSha,
      treeSha: source.treeSha,
    })) {
      throw new Error(`${spec.id} production runtime provenance source is stale`);
    }
    if (
      normalizeExecutablePath(sidecar.toolchain.runtimeNode.path) !== expectedRuntimePath ||
      stableJson(sidecar.toolchain.runtimeNode) !== stableJson(runtimeNode)
    ) {
      throw new Error(`${spec.id} runtime Node identity does not match the launched executable`);
    }
    if (stableJson(sidecar.toolchain.powershell) !== stableJson(powershell)) {
      throw new Error(`${spec.id} bound PowerShell identity changed before launch`);
    }
    if (stableJson(sidecar.toolchain.git) !== stableJson(git)) {
      throw new Error(`${spec.id} bound Git identity changed before launch`);
    }
    const entrypoint = fileRecord(repoRoot, spec.entrypointPath);
    if (stableJson(sidecar.entrypoint) !== stableJson(entrypoint)) {
      throw new Error(`${spec.id} production entrypoint changed before launch`);
    }
    const runtimeArtifacts = runtimeArtifactFileSet(
      repoRoot,
      spec.runtimeRoots,
      spec.id,
    );
    if (stableJson(sidecar.runtimeArtifacts) !== stableJson(runtimeArtifacts)) {
      throw new Error(`${spec.id} production runtime artifacts changed before launch`);
    }
    const runtimeDependencies = resolveInstalledRuntimeDependencyClosure(
      repoRoot,
      spec.runtimePackageRoots,
      runtimeNode,
    );
    if (stableJson(sidecar.runtimeDependencies) !== stableJson(runtimeDependencies)) {
      throw new Error(`${spec.id} installed runtime dependencies changed before launch`);
    }
    if (stableJson(sidecar.harness) !== stableJson(harness)) {
      throw new Error("conformance harness bytes or dependencies changed before launch");
    }
    const identity = sidecarIdentity(spec.sidecarPath, retained.raw, sidecar);
    if (stableJson(identity) !== stableJson(planned)) {
      throw new Error(`${spec.id} runtime provenance does not match the execution plan`);
    }
    identities.set(spec.id, identity);
  }
  return identities;
}

export function productionBuildProvenanceSidecarPath(componentId: ComponentId): string {
  return specFor(componentId).sidecarPath;
}

export function productionComponentBuildOutputRoots(): readonly string[] {
  return [
    "packages/protocol/dist",
    "packages/gateway-stub/dist",
    "packages/bridge-simulator/dist",
    "packages/addin-loopback-fixture/dist",
  ];
}

export function productionBuildOutputRoots(): readonly string[] {
  return [
    ...productionComponentBuildOutputRoots(),
    "packages/rbp-conformance/dist",
  ];
}
