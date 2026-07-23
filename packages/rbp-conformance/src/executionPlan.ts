import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
import {
  resolveProductionGitIdentity,
  runBoundGit,
  runBoundGitOptional,
  verifyProductionGitIdentityCurrent,
  type ProductionGitIdentity,
} from "./productionGitIdentity.js";
import { validateExecutionPlanStructure } from "./validator.js";
import type {
  ComponentId,
  ExecutionPlan,
  ProcessCommandDescriptor,
  SourceIdentity,
} from "./types.js";

export interface ComponentLaunchConfig {
  id: ComponentId;
  version: string;
  entrypointPath: string;
  command: ProcessCommandDescriptor;
}

function confinedFile(repoRoot: string, candidate: string): string {
  const realRoot = realpathSync(repoRoot);
  const realCandidate = realpathSync(path.resolve(repoRoot, candidate));
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`component entrypoint escapes the source repository: ${candidate}`);
  }
  return realCandidate;
}

export function resolveSourceIdentity(
  repoRoot: string,
  gitExecutable?: string | ProductionGitIdentity,
): SourceIdentity {
  const gitIdentity = typeof gitExecutable === "object"
    ? verifyProductionGitIdentityCurrent(gitExecutable)
    : resolveProductionGitIdentity(gitExecutable);
  const dirty = runBoundGit(
    repoRoot,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    gitIdentity,
  ).stdout.trim();
  if (dirty.length > 0) throw new Error("conformance execution requires an exactly clean source tree");
  const repository = runBoundGitOptional(
    repoRoot,
    ["config", "--get", "remote.origin.url"],
    gitIdentity,
  ) ?? path.basename(repoRoot);
  return {
    repository,
    commitSha: runBoundGit(repoRoot, ["rev-parse", "HEAD"], gitIdentity).stdout.trim(),
    treeSha: runBoundGit(
      repoRoot,
      ["rev-parse", "HEAD^{tree}"],
      gitIdentity,
    ).stdout.trim(),
    dirty: false,
  };
}

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function buildExecutionPlan(input: {
  repoRoot: string;
  runId: string;
  sequence: 1 | 2 | 3;
  components: readonly ComponentLaunchConfig[];
  gitExecutable?: string | ProductionGitIdentity;
}): ExecutionPlan {
  const source = resolveSourceIdentity(input.repoRoot, input.gitExecutable);
  const expectedIds = canonicalManifest.requiredComponents.map(({ id }) => id);
  if (input.components.map(({ id }) => id).join("|") !== expectedIds.join("|")) {
    throw new Error(`component launch order must be ${expectedIds.join(", ")}`);
  }
  const plan: ExecutionPlan = {
    schemaVersion: "rbp-conformance-execution-plan/v1",
    manifest: { ...canonicalManifestIdentity },
    runId: input.runId,
    sequence: input.sequence,
    source,
    components: input.components.map((component, index) => ({
      id: component.id,
      interfaceVersion: canonicalManifest.requiredComponents[index]!.interfaceVersion,
      expectedIdentity: {
        version: component.version,
        protocolVersion: canonicalManifest.spec.version,
        commitSha: source.commitSha,
        treeSha: source.treeSha,
        executableSha256: sha256File(confinedFile(input.repoRoot, component.entrypointPath)),
      },
      command: component.command,
    })),
  };
  const validation = validateExecutionPlanStructure(plan);
  if (!validation.ok) {
    throw new Error(`generated execution plan is invalid: ${validation.issues.map(({ path: issuePath, message }) => `${issuePath} ${message}`).join("; ")}`);
  }
  return plan;
}
