import path from "node:path";

import {
  buildExecutionPlan,
  resolveSourceIdentity,
  type ComponentLaunchConfig,
} from "./executionPlan.js";
import {
  verifyProductionBuildProvenance,
  verifyProductionRuntimeBuildProvenance,
  type ProductionProvenanceVerificationOptions,
} from "./productionBuildProvenance.js";
import {
  assertProductionControllerEnvironmentSafe,
  normalizeExecutablePath,
  resolveCurrentProcessNodeIdentity,
  verifyPowerShellIdentityCurrent,
  type NodeRuntimeMetadataResolver,
  type ProductionNodeExecutableIdentity,
} from "./productionRuntimeIdentity.js";
import type { ProductionGitIdentity } from "./productionGitIdentity.js";
import { stableJson } from "./stableJson.js";
import type {
  ComponentBuildProvenanceIdentity,
  ComponentId,
  ExecutionPlan,
  ProcessCommandDescriptor,
  SourceIdentity,
} from "./types.js";
import { validateExecutionPlanStructure } from "./validator.js";

function command(
  nodeExecutable: string,
  entrypoint: string,
  args: readonly string[],
): ProcessCommandDescriptor {
  return {
    executable: nodeExecutable,
    args: [entrypoint, ...args],
    workingDirectory: ".",
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "json", timeoutMs: 15_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 10_000 },
  };
}

/**
 * Canonical production component commands. Paths stay repository-relative so
 * buildExecutionPlan can confine and hash the exact built entrypoints.
 */
export function productionComponentLaunchConfigs(
  repoRoot: string,
  nodeExecutable = process.execPath,
): ComponentLaunchConfig[] {
  if (!path.isAbsolute(nodeExecutable)) {
    throw new Error("production runtime Node executable must be an absolute path");
  }
  const canonicalNodeExecutable = normalizeExecutablePath(nodeExecutable);
  const configs: ComponentLaunchConfig[] = [
    {
      id: "gateway_stub",
      version: "0.0.0",
      entrypointPath: "packages/gateway-stub/dist/cli.js",
      command: command(canonicalNodeExecutable, "packages/gateway-stub/dist/cli.js", [
        "--state",
        "{{instance_root}}/state/gateway.json",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--control-token",
        "rbp-test-control",
      ]),
    },
    {
      id: "bridge_simulator",
      version: "0.0.0",
      entrypointPath: "packages/bridge-simulator/dist/cli.js",
      command: command(canonicalNodeExecutable, "packages/bridge-simulator/dist/cli.js", [
        "daemon",
        "--state-root",
        "{{instance_root}}/state/bridge",
      ]),
    },
    {
      id: "addin_loopback_fixture",
      version: "0.0.0",
      entrypointPath: "packages/addin-loopback-fixture/dist/cli.js",
      command: command(canonicalNodeExecutable, "packages/addin-loopback-fixture/dist/cli.js", [
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ]),
    },
  ];
  for (const config of configs) {
    const absolute = path.resolve(repoRoot, config.entrypointPath);
    const relative = path.relative(path.resolve(repoRoot), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`production component path escapes the repository: ${config.entrypointPath}`);
    }
  }
  return configs;
}

/**
 * Builds an executable production plan only from an exactly clean Git tree.
 * resolveSourceIdentity, entrypoint confinement and exact hashes are enforced
 * by buildExecutionPlan.
 */
export function buildProductionExecutionPlan(input: {
  repoRoot: string;
  runId: string;
  sequence: 1 | 2 | 3;
  nodeExecutable?: string;
  gitExecutable?: string;
  nodeMetadataResolver?: NodeRuntimeMetadataResolver;
}): ExecutionPlan {
  const runtimeNodeExecutable = input.nodeExecutable ?? process.execPath;
  const source = resolveSourceIdentity(input.repoRoot, input.gitExecutable);
  const provenance = verifyProductionBuildProvenance(input.repoRoot, source, {
    expectedRuntimeNodeExecutable: runtimeNodeExecutable,
    ...(input.gitExecutable === undefined
      ? {}
      : { expectedGitExecutable: input.gitExecutable }),
    ...(input.nodeMetadataResolver === undefined
      ? {}
      : { nodeMetadataResolver: input.nodeMetadataResolver }),
  });
  const gitExecutables = new Set(
    [...provenance.values()].map(({ toolchain }) => toolchain.git.path),
  );
  if (gitExecutables.size !== 1) {
    throw new Error("production sidecars disagree on the build Git executable");
  }
  const plan = buildExecutionPlan({
    repoRoot: input.repoRoot,
    runId: input.runId,
    sequence: input.sequence,
    components: productionComponentLaunchConfigs(input.repoRoot, runtimeNodeExecutable),
    gitExecutable: [...gitExecutables][0]!,
  });
  for (const component of plan.components) {
    const identity = provenance.get(component.id);
    if (identity === undefined) {
      throw new Error(`production build provenance is missing for ${component.id}`);
    }
    component.expectedIdentity.buildProvenance = structuredClone(identity);
  }
  assertProductionExecutionPlanCurrent(
    plan,
    input.repoRoot,
    resolveSourceIdentity,
    verifyProductionBuildProvenance,
    input.nodeMetadataResolver === undefined
      ? {}
      : { nodeMetadataResolver: input.nodeMetadataResolver },
  );
  return plan;
}

export type ProductionSourceIdentityResolver = (
  repoRoot: string,
  gitExecutable?: string | ProductionGitIdentity,
) => SourceIdentity;
export type ProductionBuildProvenanceVerifier = (
  repoRoot: string,
  source: SourceIdentity,
  options?: ProductionProvenanceVerificationOptions,
) => ReadonlyMap<ComponentId, ComponentBuildProvenanceIdentity>;

function plannedProvenance(
  plan: ExecutionPlan,
): Map<ComponentId, ComponentBuildProvenanceIdentity> {
  const result = new Map<ComponentId, ComponentBuildProvenanceIdentity>();
  for (const component of plan.components) {
    const identity = component.expectedIdentity.buildProvenance;
    if (identity === undefined) {
      throw new Error(
        `${component.id} production execution plan lacks required build provenance`,
      );
    }
    result.set(component.id, identity);
  }
  return result;
}

function assertCanonicalProductionCommands(
  plan: ExecutionPlan,
  repoRoot: string,
): string {
  const executables = new Set(
    plan.components.map(({ command: componentCommand }) =>
      normalizeExecutablePath(componentCommand.executable)),
  );
  if (executables.size !== 1) {
    throw new Error("production components do not share one bound runtime Node executable");
  }
  const runtimeNodeExecutable = [...executables][0]!;
  if (!path.isAbsolute(runtimeNodeExecutable)) {
    throw new Error("production runtime Node executable is not absolute");
  }
  const canonical = new Map(
    productionComponentLaunchConfigs(repoRoot, runtimeNodeExecutable)
      .map((config) => [config.id, config.command]),
  );
  for (const component of plan.components) {
    if (stableJson(component.command) !== stableJson(canonical.get(component.id))) {
      throw new Error(
        `${component.id} command does not match the canonical production descriptor`,
      );
    }
  }
  return runtimeNodeExecutable;
}

function plannedGitIdentity(plan: ExecutionPlan): ProductionGitIdentity {
  const identities = plannedProvenance(plan);
  const gitIdentities = new Set(
    [...identities.values()].map(({ toolchain }) => stableJson(toolchain.git)),
  );
  if (gitIdentities.size !== 1) {
    throw new Error("production components disagree on the bound Git identity");
  }
  return [...identities.values()][0]!.toolchain.git;
}

function plannedRuntimeNodeIdentity(
  plan: ExecutionPlan,
): ProductionNodeExecutableIdentity {
  const identities = [...plannedProvenance(plan).values()]
    .map(({ toolchain }) => toolchain.runtimeNode);
  const serialized = new Set(identities.map((identity) => stableJson(identity)));
  if (serialized.size !== 1) {
    throw new Error("production components disagree on the bound runtime Node identity");
  }
  return identities[0]!;
}

export function assertProductionControllerRuntimeCurrent(
  plan: ExecutionPlan,
  resolveCurrent: () => ProductionNodeExecutableIdentity =
    resolveCurrentProcessNodeIdentity,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  assertProductionControllerEnvironmentSafe(environment);
  const planned = plannedRuntimeNodeIdentity(plan);
  const current = resolveCurrent();
  if (stableJson(current) !== stableJson(planned)) {
    throw new Error(
      "production controller Node does not match the plan-bound runtime Node identity",
    );
  }
}

/**
 * Refuses to consume a stale plan or a plan while the repository is dirty.
 * resolveSourceIdentity owns the clean-tree check; exact source equality then
 * binds execution to the commit/tree for which the plan was generated.
 */
export function assertProductionExecutionPlanCurrent(
  plan: ExecutionPlan,
  repoRoot: string,
  resolveCurrent: ProductionSourceIdentityResolver = resolveSourceIdentity,
  verifyCurrentProvenance: ProductionBuildProvenanceVerifier =
    verifyProductionBuildProvenance,
  options: { nodeMetadataResolver?: NodeRuntimeMetadataResolver } = {},
): void {
  const validation = validateExecutionPlanStructure(plan);
  if (!validation.ok) {
    throw new Error(
      `production execution plan is invalid: ${validation.issues
        .map(({ path: issuePath, message }) => `${issuePath} ${message}`)
        .join("; ")}`,
    );
  }
  const runtimeNodeExecutable = assertCanonicalProductionCommands(plan, repoRoot);
  const gitIdentity = plannedGitIdentity(plan);
  const current = resolveCurrent(repoRoot, gitIdentity);
  if (stableJson(current) !== stableJson(plan.source)) {
    throw new Error(
      `production execution plan source ${plan.source.commitSha}/${plan.source.treeSha} ` +
      `does not match clean repository source ${current.commitSha}/${current.treeSha}`,
    );
  }
  const currentProvenance = verifyCurrentProvenance(repoRoot, current, {
    expectedRuntimeNodeExecutable: runtimeNodeExecutable,
    expectedGitExecutable: gitIdentity.path,
    ...(options.nodeMetadataResolver === undefined
      ? {}
      : { nodeMetadataResolver: options.nodeMetadataResolver }),
  });
  const planned = plannedProvenance(plan);
  for (const component of plan.components) {
    const plannedIdentity = planned.get(component.id)!;
    const verified = currentProvenance.get(component.id);
    if (verified === undefined) {
      throw new Error(`${component.id} production build provenance is missing`);
    }
    if (stableJson(plannedIdentity) !== stableJson(verified)) {
      throw new Error(
        `${component.id} production build provenance does not match the execution plan`,
      );
    }
  }
  const currentAfterVerification = resolveCurrent(repoRoot, gitIdentity);
  if (stableJson(currentAfterVerification) !== stableJson(current)) {
    throw new Error("clean repository source changed during production provenance verification");
  }
}

/**
 * Lightweight execution-time gate. It deliberately omits compiler/npm hashing
 * but rechecks every byte that the controller or a component can load.
 */
export function assertProductionRuntimeLaunchCurrent(
  plan: ExecutionPlan,
  repoRoot: string,
  options: { nodeMetadataResolver?: NodeRuntimeMetadataResolver } = {},
): void {
  const validation = validateExecutionPlanStructure(plan);
  if (!validation.ok) {
    throw new Error(
      `production execution plan is invalid: ${validation.issues
        .map(({ path: issuePath, message }) => `${issuePath} ${message}`)
        .join("; ")}`,
    );
  }
  const runtimeNodeExecutable = assertCanonicalProductionCommands(plan, repoRoot);
  const gitIdentity = plannedGitIdentity(plan);
  const current = resolveSourceIdentity(repoRoot, gitIdentity);
  if (stableJson(current) !== stableJson(plan.source)) {
    throw new Error("production source changed before component launch");
  }
  verifyProductionRuntimeBuildProvenance(repoRoot, current, {
    expectedRuntimeNodeExecutable: runtimeNodeExecutable,
    plannedIdentities: plannedProvenance(plan),
    ...(options.nodeMetadataResolver === undefined
      ? {}
      : { nodeMetadataResolver: options.nodeMetadataResolver }),
  });
  const currentAfterVerification = resolveSourceIdentity(repoRoot, gitIdentity);
  if (stableJson(currentAfterVerification) !== stableJson(current)) {
    throw new Error("clean repository source changed during runtime provenance verification");
  }
}

export function boundProductionPowerShellExecutable(plan: ExecutionPlan): string {
  const identities = plan.components.map(
    ({ expectedIdentity }) => expectedIdentity.buildProvenance?.toolchain.powershell,
  );
  if (identities.some((identity) => identity === undefined)) {
    throw new Error("production plan lacks bound PowerShell provenance");
  }
  const serialized = new Set(identities.map((identity) => stableJson(identity)));
  if (serialized.size !== 1) {
    throw new Error("production components disagree on the bound PowerShell identity");
  }
  const planned = identities[0];
  if (planned === undefined || planned === null) {
    throw new Error("PowerShell is not part of this production platform identity");
  }
  const current = verifyPowerShellIdentityCurrent(planned);
  if (stableJson(current) !== stableJson(planned)) {
    throw new Error("bound PowerShell executable changed after plan creation");
  }
  return planned.path;
}
