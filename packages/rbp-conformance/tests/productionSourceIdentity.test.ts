import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSourceIdentity } from "../src/executionPlan.js";

const roots: string[] = [];

function git(root: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return String(result.stdout).trim();
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "rbp-source-identity-"));
  roots.push(root);
  git(root, ["init"]);
  writeFileSync(path.join(root, ".gitignore"), "ignored/\n", "utf8");
  writeFileSync(path.join(root, "tracked.txt"), "protected\n", "utf8");
  git(root, ["add", "."]);
  git(root, [
    "-c",
    "user.name=Conformance Test",
    "-c",
    "user.email=conformance@example.invalid",
    "commit",
    "-m",
    "protected source",
  ]);
  return root;
}

function withEnvironment<T>(
  overrides: Readonly<Record<string, string>>,
  action: () => T,
): T {
  const prior = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return action();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("protected HEAD source identity", () => {
  it("rejects assume-unchanged before hashing a modified tracked file", () => {
    const root = repository();
    git(root, ["update-index", "--assume-unchanged", "tracked.txt"]);
    appendFileSync(path.join(root, "tracked.txt"), "hidden mutation\n", "utf8");

    expect(() => resolveSourceIdentity(root))
      .toThrow(/rejects assume-unchanged index state: tracked\.txt/u);
  });

  it("rejects skip-worktree before hashing a modified tracked file", () => {
    const root = repository();
    git(root, ["update-index", "--skip-worktree", "tracked.txt"]);
    appendFileSync(path.join(root, "tracked.txt"), "hidden mutation\n", "utf8");

    expect(() => resolveSourceIdentity(root))
      .toThrow(/rejects skip-worktree index state: tracked\.txt/u);
  });

  it("hashes actual tracked bytes despite hostile global config and local fsmonitor", () => {
    const root = repository();
    const hostileConfig = path.join(root, "hostile-global.gitconfig");
    writeFileSync(
      hostileConfig,
      [
        "[core]",
        "\tfsmonitor = true",
        "\tignorestat = true",
        "\tpreloadindex = true",
        "\ttrustctime = false",
        "",
      ].join("\n"),
      "utf8",
    );
    git(root, ["config", "--local", "core.fsmonitor", "true"]);
    appendFileSync(path.join(root, "tracked.txt"), "hidden mutation\n", "utf8");

    expect(() =>
      withEnvironment(
        {
          GIT_CONFIG_GLOBAL: hostileConfig,
          GIT_CONFIG_SYSTEM: hostileConfig,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.fsmonitor",
          GIT_CONFIG_VALUE_0: "true",
        },
        () => resolveSourceIdentity(root),
      )).toThrow(/tracked bytes do not match protected HEAD: tracked\.txt/u);
  });

  it("rejects CRLF worktree bytes even when tracked attributes normalize to LF", () => {
    const root = repository();
    writeFileSync(path.join(root, ".gitattributes"), "* text eol=lf\n", "utf8");
    git(root, ["add", ".gitattributes"]);
    git(root, [
      "-c",
      "user.name=Conformance Test",
      "-c",
      "user.email=conformance@example.invalid",
      "commit",
      "-m",
      "normalize text",
    ]);
    writeFileSync(path.join(root, "tracked.txt"), "protected\r\n", "utf8");

    expect(() => resolveSourceIdentity(root))
      .toThrow(/tracked bytes do not match protected HEAD: tracked\.txt/u);
  });

  it("rejects a tracked clean-filter rule backed by repository-local config", () => {
    const root = repository();
    writeFileSync(
      path.join(root, ".gitattributes"),
      "tracked.txt filter=canonical\n",
      "utf8",
    );
    git(root, ["add", ".gitattributes"]);
    git(root, [
      "-c",
      "user.name=Conformance Test",
      "-c",
      "user.email=conformance@example.invalid",
      "commit",
      "-m",
      "declare clean filter",
    ]);
    git(root, ["config", "--local", "filter.canonical.clean", "node attacker.js"]);
    appendFileSync(path.join(root, "tracked.txt"), "hidden mutation\n", "utf8");

    expect(() => resolveSourceIdentity(root))
      .toThrow(/rejects repository-local Git filters/u);
  });

  it("rejects replacement commits and binds the original protected tree", () => {
    const root = repository();
    const originalCommit = git(root, ["rev-parse", "HEAD"]);
    const originalTree = git(root, [
      "--no-replace-objects",
      "rev-parse",
      `${originalCommit}^{tree}`,
    ]);
    writeFileSync(path.join(root, "tracked.txt"), "replacement\n", "utf8");
    git(root, ["add", "tracked.txt"]);
    git(root, [
      "-c",
      "user.name=Conformance Test",
      "-c",
      "user.email=conformance@example.invalid",
      "commit",
      "-m",
      "replacement source",
    ]);
    const replacementCommit = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "--detach", originalCommit]);
    git(root, ["replace", originalCommit, replacementCommit]);

    expect(() => resolveSourceIdentity(root))
      .toThrow(/rejects Git replace refs/u);

    git(root, ["replace", "-d", originalCommit]);
    git(root, ["checkout", "--detach", "--force", originalCommit]);
    writeFileSync(path.join(root, "tracked.txt"), "protected\n", "utf8");
    const identity = resolveSourceIdentity(root);
    expect(identity.commitSha).toBe(originalCommit);
    expect(identity.treeSha).toBe(originalTree);
  });

  it("rejects legacy graft history overrides", () => {
    const root = repository();
    const commitSha = git(root, ["rev-parse", "HEAD"]);
    const grafts = path.join(root, ".git", "info", "grafts");
    mkdirSync(path.dirname(grafts), { recursive: true });
    writeFileSync(grafts, `${commitSha}\n`, "utf8");

    expect(() => resolveSourceIdentity(root))
      .toThrow(/rejects legacy Git grafts/u);
  });

  it("rejects repository-local content filters and untracked info attributes", () => {
    const filtered = repository();
    git(filtered, ["config", "--local", "filter.evil.clean", "node attacker.js"]);
    expect(() => resolveSourceIdentity(filtered))
      .toThrow(/rejects repository-local Git filters/u);

    const attributed = repository();
    const info = path.join(attributed, ".git", "info");
    mkdirSync(info, { recursive: true });
    writeFileSync(
      path.join(info, "attributes"),
      "tracked.txt filter=evil\n",
      "utf8",
    );
    expect(() => resolveSourceIdentity(attributed))
      .toThrow(/rejects untracked info\/attributes rules/u);
  });
});
