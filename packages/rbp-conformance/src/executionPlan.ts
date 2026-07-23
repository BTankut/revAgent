import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
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

interface GitTreeEntry {
  mode: string;
  objectId: string;
  path: string;
}

function parseTreeEntries(raw: string): GitTreeEntry[] {
  return raw.split("\0").filter(Boolean).map((record) => {
    const match = /^(?<mode>[0-7]{6}) blob (?<objectId>[0-9a-f]{40,64})\t(?<path>.+)$/u.exec(
      record,
    );
    if (match?.groups === undefined) {
      throw new Error(`protected HEAD contains an unsupported tree entry: ${record}`);
    }
    const filePath = match.groups.path!;
    if (
      filePath.includes("\n") ||
      filePath.includes("\r") ||
      filePath.includes("\0") ||
      path.isAbsolute(filePath) ||
      filePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`protected HEAD contains a non-canonical tracked path: ${filePath}`);
    }
    return {
      mode: match.groups.mode!,
      objectId: match.groups.objectId!,
      path: filePath,
    };
  });
}

function parseIndexEntries(raw: string): GitTreeEntry[] {
  return raw.split("\0").filter(Boolean).map((record) => {
    const match =
      /^(?<mode>[0-7]{6}) (?<objectId>[0-9a-f]{40,64}) (?<stage>[0-3])\t(?<path>.+)$/u.exec(
        record,
      );
    if (match?.groups === undefined || match.groups.stage !== "0") {
      throw new Error(`Git index contains an unsupported or unmerged entry: ${record}`);
    }
    return {
      mode: match.groups.mode!,
      objectId: match.groups.objectId!,
      path: match.groups.path!,
    };
  });
}

function assertNoIndexTrustFlags(
  repoRoot: string,
  gitIdentity: ProductionGitIdentity,
): void {
  const assumeTags = runBoundGit(repoRoot, ["ls-files", "-v", "-z"], gitIdentity)
    .stdout.split("\0").filter(Boolean);
  const assumed = assumeTags.find((record) => /^[a-z] /u.test(record));
  if (assumed !== undefined) {
    throw new Error(
      `conformance source identity rejects assume-unchanged index state: ${assumed.slice(2)}`,
    );
  }
  const typeTags = runBoundGit(repoRoot, ["ls-files", "-t", "-z"], gitIdentity)
    .stdout.split("\0").filter(Boolean);
  const skipped = typeTags.find((record) => record.startsWith("S "));
  if (skipped !== undefined) {
    throw new Error(
      `conformance source identity rejects skip-worktree index state: ${skipped.slice(2)}`,
    );
  }
}

function assertNoLocalFilterOverrides(
  repoRoot: string,
  gitIdentity: ProductionGitIdentity,
): void {
  const filters = runBoundGitOptional(
    repoRoot,
    ["config", "--local", "--get-regexp", "^filter\\."],
    gitIdentity,
  );
  if (filters !== undefined) {
    throw new Error("conformance source identity rejects repository-local Git filters");
  }
  const infoAttributes = runBoundGit(
    repoRoot,
    ["rev-parse", "--git-path", "info/attributes"],
    gitIdentity,
  ).stdout.trim();
  const attributesPath = path.resolve(repoRoot, infoAttributes);
  if (existsSync(attributesPath) && readFileSync(attributesPath, "utf8").trim().length > 0) {
    throw new Error("conformance source identity rejects untracked info/attributes rules");
  }
}

function assertIndexMatchesProtectedTree(
  tree: readonly GitTreeEntry[],
  index: readonly GitTreeEntry[],
): void {
  if (tree.length !== index.length) {
    throw new Error("Git index path set does not match protected HEAD");
  }
  for (let item = 0; item < tree.length; item += 1) {
    const expected = tree[item]!;
    const actual = index[item]!;
    if (
      expected.path !== actual.path ||
      expected.mode !== actual.mode ||
      expected.objectId !== actual.objectId
    ) {
      throw new Error(`Git index does not match protected HEAD at ${expected.path}`);
    }
  }
}

function assertWorktreeMatchesProtectedTree(
  repoRoot: string,
  gitIdentity: ProductionGitIdentity,
  tree: readonly GitTreeEntry[],
): void {
  const root = realpathSync(repoRoot);
  for (const entry of tree) {
    const lexical = path.resolve(root, entry.path);
    if (!existsSync(lexical) || lstatSync(lexical).isSymbolicLink()) {
      throw new Error(`tracked path is missing or linked: ${entry.path}`);
    }
    const real = realpathSync(lexical);
    const relative = path.relative(root, real);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !statSync(real).isFile()
    ) {
      throw new Error(`tracked path escapes the protected worktree: ${entry.path}`);
    }
  }
  const hashes = runBoundGit(
    repoRoot,
    ["hash-object", "--stdin-paths"],
    gitIdentity,
    { input: `${tree.map(({ path: filePath }) => filePath).join("\n")}\n` },
  ).stdout.trim().split(/\r?\n/u);
  if (hashes.length !== tree.length) {
    throw new Error("Git did not hash every protected tracked path");
  }
  for (let item = 0; item < tree.length; item += 1) {
    if (hashes[item] !== tree[item]!.objectId) {
      throw new Error(`tracked bytes do not match protected HEAD: ${tree[item]!.path}`);
    }
  }
}

function assertNoRelevantUntrackedFiles(
  repoRoot: string,
  gitIdentity: ProductionGitIdentity,
): void {
  const untracked = runBoundGit(
    repoRoot,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    gitIdentity,
  ).stdout.split("\0").filter(Boolean);
  if (untracked.length > 0) {
    throw new Error(`conformance execution rejects untracked path: ${untracked[0]}`);
  }
}

export function resolveSourceIdentity(
  repoRoot: string,
  gitExecutable?: string | ProductionGitIdentity,
): SourceIdentity {
  const gitIdentity = typeof gitExecutable === "object"
    ? verifyProductionGitIdentityCurrent(gitExecutable)
    : resolveProductionGitIdentity(gitExecutable);
  assertNoIndexTrustFlags(repoRoot, gitIdentity);
  assertNoLocalFilterOverrides(repoRoot, gitIdentity);
  const commitSha = runBoundGit(
    repoRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    gitIdentity,
  ).stdout.trim();
  const treeSha = runBoundGit(
    repoRoot,
    ["rev-parse", `${commitSha}^{tree}`],
    gitIdentity,
  ).stdout.trim();
  const tree = parseTreeEntries(
    runBoundGit(
      repoRoot,
      ["ls-tree", "-r", "-z", "--full-tree", commitSha],
      gitIdentity,
    ).stdout,
  );
  const index = parseIndexEntries(
    runBoundGit(repoRoot, ["ls-files", "--stage", "-z"], gitIdentity).stdout,
  );
  assertIndexMatchesProtectedTree(tree, index);
  assertWorktreeMatchesProtectedTree(repoRoot, gitIdentity, tree);
  assertNoRelevantUntrackedFiles(repoRoot, gitIdentity);
  const commitAfter = runBoundGit(
    repoRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    gitIdentity,
  ).stdout.trim();
  if (commitAfter !== commitSha) {
    throw new Error("protected HEAD changed during source identity verification");
  }
  const repository = runBoundGitOptional(
    repoRoot,
    ["config", "--get", "remote.origin.url"],
    gitIdentity,
  ) ?? path.basename(repoRoot);
  return {
    repository,
    commitSha,
    treeSha,
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
