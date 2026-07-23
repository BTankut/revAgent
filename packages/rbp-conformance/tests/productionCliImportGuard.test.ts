import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const compiledCli = path.join(packageRoot, "dist", "src", "cli.js");
const compiledPreparation = path.join(
  packageRoot,
  "dist",
  "src",
  "productionPreparation.js",
);
const launcherError = /require the tracked external PowerShell launcher/u;

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
      expect(() => runCli(args)).toThrow(launcherError);
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
      await expect(invoke()).rejects.toThrow(launcherError);
    }
  });

  it("rejects direct Node and npm/bin execution before evidence consumption", () => {
    expect(existsSync(compiledCli)).toBe(true);
    const args = [
      "validate-run",
      "missing-run.json",
      "--plan",
      "missing-plan.json",
      "--repo-root",
      repoRoot,
    ];
    const direct = spawnSync(process.execPath, [compiledCli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    expect(direct.status).not.toBe(0);
    expect(String(direct.stderr)).toMatch(launcherError);
    expect(String(direct.stdout)).not.toContain("PASS");

    const npmEntrypoint = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    expect(existsSync(npmEntrypoint)).toBe(true);
    const npm = spawnSync(
      process.execPath,
      [
        npmEntrypoint,
        "exec",
        "--workspace",
        "@revagent/rbp-conformance",
        "--",
        "rbp-conformance",
        ...args,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 60_000,
      },
    );
    expect(npm.status, String(npm.stderr)).not.toBe(0);
    expect(`${String(npm.stdout)}\n${String(npm.stderr)}`).toMatch(launcherError);
    expect(String(npm.stdout)).not.toContain("PASS");
  }, 90_000);

  it("rejects imported CLI runners even after process.argv spoofing", () => {
    const source = [
      `const cli = await import(${JSON.stringify(pathToFileURL(compiledCli).href)});`,
      `process.argv[1] = ${JSON.stringify(compiledCli)};`,
      "try {",
      `  cli.runCli(${JSON.stringify([
        "validate-run",
        "missing-run.json",
        "--plan",
        "missing-plan.json",
        "--repo-root",
        repoRoot,
      ])});`,
      "} catch (error) {",
      "  process.stderr.write(String(error?.message ?? error));",
      "  process.exitCode = 41;",
      "}",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: repoRoot,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
    );
    expect(result.status).toBe(41);
    expect(String(result.stderr)).toMatch(launcherError);
    expect(String(result.stdout)).not.toContain("PASS");
  });

  it("rejects direct prepare-core calls despite a spoofed npm handoff marker", () => {
    expect(existsSync(compiledPreparation)).toBe(true);
    const source = [
      `const module = await import(${
        JSON.stringify(pathToFileURL(compiledPreparation).href)
      });`,
      "try {",
      "  module.prepareProductionExecutionPlan({",
      `    repoRoot: ${JSON.stringify(repoRoot)},`,
      "    runId: 'prepare-bypass',",
      "    sequence: 1,",
      "    gitExecutable: process.execPath,",
      "  });",
      "} catch (error) {",
      "  process.stderr.write(String(error?.message ?? error));",
      "  process.exitCode = 42;",
      "}",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      {
        cwd: repoRoot,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          RBP_PRODUCTION_NPM_EXECUTABLE: process.execPath,
        },
      },
    );
    expect(result.status).toBe(42);
    expect(String(result.stderr)).toMatch(launcherError);
    expect(String(result.stdout)).not.toContain("PASS");
  });
});
