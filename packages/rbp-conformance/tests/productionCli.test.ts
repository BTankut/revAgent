import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runProductionAsyncCli } from "../src/cli.js";
import { createPlan } from "./helpers.js";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  }
}

describe("run-production CLI gates", () => {
  it("rejects a stale plan against an otherwise clean repository before execution", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-cli-"));
    const repo = path.join(root, "repo");
    const artifactRoot = path.join(root, "artifacts");
    const planFile = path.join(root, "execution-plan.json");
    try {
      mkdirSync(repo);
      git(repo, ["init"]);
      writeFileSync(path.join(repo, "source.txt"), "clean\n", "utf8");
      git(repo, ["add", "source.txt"]);
      git(repo, [
        "-c",
        "user.name=Conformance Test",
        "-c",
        "user.email=conformance@example.invalid",
        "commit",
        "-m",
        "clean source",
      ]);
      writeFileSync(planFile, JSON.stringify(createPlan()), "utf8");

      await expect(runProductionAsyncCli([
        "run-production",
        planFile,
        "--repo-root",
        repo,
        "--artifact-root",
        artifactRoot,
        "--seed",
        "stale-plan-test",
      ], root)).rejects.toThrow(/does not match clean repository source/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown flags without reading or executing a plan", async () => {
    await expect(runProductionAsyncCli([
      "run-production",
      "missing.json",
      "--allow-unbound-oracles",
      "true",
    ])).rejects.toThrow(/Usage:/u);
  });
});
