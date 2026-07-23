import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  runAsyncCli,
  runCli,
  runPrepareProductionAsyncCli,
  runProductionAsyncCli,
  runSoakAsyncCli,
} from "../src/cli.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const directInvocationError = /require direct invocation of the canonical CLI/u;

describe("production CLI import guard", () => {
  it.each([
    [
      "validate-run",
      [
        "validate-run",
        "missing-run.json",
        "--plan",
        "missing-plan.json",
        "--repo-root",
        repoRoot,
      ],
    ],
    [
      "validate-aggregate",
      [
        "validate-aggregate",
        "missing-aggregate.json",
        "--plan-1",
        "missing-plan-1.json",
        "--plan-2",
        "missing-plan-2.json",
        "--plan-3",
        "missing-plan-3.json",
        "--repo-root",
        repoRoot,
      ],
    ],
    [
      "validate-soak",
      [
        "validate-soak",
        "missing-soak.json",
        "--plan",
        "missing-soak-plan.json",
        "--aggregate",
        "missing-aggregate.json",
        "--plan-1",
        "missing-plan-1.json",
        "--plan-2",
        "missing-plan-2.json",
        "--plan-3",
        "missing-plan-3.json",
        "--repo-root",
        repoRoot,
      ],
    ],
    [
      "aggregate",
      [
        "aggregate",
        "missing-run-1.json",
        "missing-run-2.json",
        "missing-run-3.json",
        "--plan-1",
        "missing-plan-1.json",
        "--plan-2",
        "missing-plan-2.json",
        "--plan-3",
        "missing-plan-3.json",
        "--repo-root",
        repoRoot,
      ],
    ],
  ])("blocks imported runCli %s before it can emit PASS", (_command, args) => {
    const stdout = vi.spyOn(process.stdout, "write");
    try {
      expect(() => runCli(args)).toThrow(directInvocationError);
      expect(
        stdout.mock.calls.some(([value]) => String(value).includes("PASS")),
      ).toBe(false);
    } finally {
      stdout.mockRestore();
    }
  });

  it("blocks every imported asynchronous production runner", async () => {
    const invocations = [
      () => runPrepareProductionAsyncCli([
        "prepare-production",
        "missing-plan.json",
        "--run-id",
        "import-guard",
        "--sequence",
        "1",
        "--git-executable",
        process.execPath,
        "--repo-root",
        repoRoot,
      ]),
      () => runProductionAsyncCli([
        "run-production",
        "missing-plan.json",
        "--repo-root",
        repoRoot,
      ]),
      () => runAsyncCli([
        "run-c19",
        "missing-plan.json",
        "--repo-root",
        repoRoot,
      ]),
      () => runSoakAsyncCli([
        "run-soak",
        "missing-plan.json",
        "--mode",
        "smoke",
        "--repo-root",
        repoRoot,
      ]),
    ];

    for (const invoke of invocations) {
      await expect(invoke()).rejects.toThrow(directInvocationError);
    }
  });
});
