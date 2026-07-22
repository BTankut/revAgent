import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalManifest, canonicalManifestIdentity } from "./manifest.js";
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

function git(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return String(result.stdout).trim();
}

function optionalGit(repoRoot: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", shell: false });
  return result.status === 0 ? String(result.stdout).trim() || undefined : undefined;
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

export function resolveSourceIdentity(repoRoot: string): SourceIdentity {
  const dirty = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty.length > 0) throw new Error("conformance execution requires an exactly clean source tree");
  const repository = optionalGit(repoRoot, ["config", "--get", "remote.origin.url"]) ?? path.basename(repoRoot);
  return {
    repository,
    commitSha: git(repoRoot, ["rev-parse", "HEAD"]),
    treeSha: git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
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
}): ExecutionPlan {
  const source = resolveSourceIdentity(input.repoRoot);
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
