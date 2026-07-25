import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runProductionAsyncCli } from "../src/cli.js";
import { resolveSourceIdentity } from "../src/executionPlan.js";
import {
  assertProductionExecutionPlanCurrent,
} from "../src/productionExecutionPlan.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const currentRepoRoot = path.resolve(packageRoot, "..", "..");

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
  }
}

function writeCanonicalComponentManifests(repo: string): void {
  for (const packageDirectory of [
    "gateway-stub",
    "bridge-simulator",
    "addin-loopback-fixture",
  ]) {
    const target = path.join(repo, "packages", packageDirectory, "package.json");
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(
      path.join(currentRepoRoot, "packages", packageDirectory, "package.json"),
      target,
    );
  }
}

describe("run-production CLI gates", () => {
  it("rejects a stale plan against an otherwise clean repository before execution", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-cli-"));
    const repo = path.join(root, "repo");
    try {
      mkdirSync(repo);
      git(repo, ["init"]);
      writeFileSync(path.join(repo, "source.txt"), "clean\n", "utf8");
      writeCanonicalComponentManifests(repo);
      git(repo, ["add", "."]);
      git(repo, [
        "-c",
        "user.name=Conformance Test",
        "-c",
        "user.email=conformance@example.invalid",
        "commit",
        "-m",
        "clean source",
      ]);
      const plan = createCurrentProductionPlan(
        currentRepoRoot,
        "stale-plan-test",
      );
      expect(() =>
        assertProductionExecutionPlanCurrent(plan, repo),
      ).toThrow(/does not match clean repository source/u);
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

  it("rejects run-c19 and run-soak before spawn when sidecars are missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-cli-provenance-"));
    const repo = path.join(root, "repo");
    try {
      mkdirSync(repo);
      git(repo, ["init"]);
      writeFileSync(path.join(repo, "source.txt"), "clean\n", "utf8");
      writeCanonicalComponentManifests(repo);
      git(repo, ["add", "."]);
      git(repo, [
        "-c",
        "user.name=Conformance Test",
        "-c",
        "user.email=conformance@example.invalid",
        "commit",
        "-m",
        "clean source",
      ]);
      const plan = createCurrentProductionPlan(
        currentRepoRoot,
        "missing-sidecars-test",
      );
      plan.source = resolveSourceIdentity(repo);
      for (const component of plan.components) {
        component.expectedIdentity.commitSha = plan.source.commitSha;
        component.expectedIdentity.treeSha = plan.source.treeSha;
      }
      expect(() =>
        assertProductionExecutionPlanCurrent(plan, repo),
      ).toThrow(/sidecar is missing or unreadable/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
