import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  sanitizedProductionRuntimeEnvironment,
} from "../src/productionRuntimeIdentity.js";
import { stableJson } from "../src/stableJson.js";
import type { ExecutionPlan } from "../src/types.js";
import { createCurrentProductionPlan } from "./helpers.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const compiledCli = path.join(
  repoRoot,
  "packages",
  "rbp-conformance",
  "dist",
  "src",
  "cli.js",
);
const cliBootstrap = path.join(
  packageRoot,
  "scripts",
  "production-cli-bootstrap.mjs",
);
const productionLauncher = path.join(
  packageRoot,
  "scripts",
  "invoke-production.ps1",
);
const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
if (windowsRoot === undefined) {
  throw new Error("validator launcher tests require SystemRoot");
}
const systemPowerShell = path.join(
  windowsRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

interface CliInvocationResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

function invokeCurrentCli(input: {
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
}): Promise<CliInvocationResult> {
  const child = spawn(
    systemPowerShell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      productionLauncher,
      "-NodeExecutable",
      input.nodeExecutable ?? process.execPath,
      "-Entrypoint",
      cliBootstrap,
      ...input.args,
    ],
    {
      cwd: input.cwd,
      shell: false,
      env: input.env ?? sanitizedProductionRuntimeEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let launchError: Error | undefined;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 90_000);
    child.on("error", (error) => {
      launchError = error;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({
        status,
        signal,
        stdout,
        stderr,
        error: timedOut
          ? new Error("validator launcher timed out after 90000ms")
          : launchError,
      });
    });
  });
}

function planSequence(
  plan: ExecutionPlan,
  sequence: 1 | 2 | 3,
  runId = `run-${String(sequence)}`,
): ExecutionPlan {
  return {
    ...structuredClone(plan),
    runId,
    sequence,
  };
}

const temporaryRoots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function writeTemporaryFile(
  root: string,
  relative: string,
  contents: string,
): string {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
  return target;
}

function writePlan(root: string, name: string, plan: ExecutionPlan): string {
  const relative = `node_modules/.test-plans/${name}`;
  return writeTemporaryFile(root, relative, stableJson(plan));
}

function aggregatePlanFlags(
  currentRepoRoot: string,
  planFiles: readonly [string, string, string],
): string[] {
  return [
    "--plan-1",
    planFiles[0],
    "--plan-2",
    planFiles[1],
    "--plan-3",
    planFiles[2],
    "--repo-root",
    currentRepoRoot,
  ];
}

beforeAll(() => {
  expect(existsSync(systemPowerShell)).toBe(true);
  expect(existsSync(productionLauncher)).toBe(true);
  expect(existsSync(compiledCli)).toBe(true);
  expect(existsSync(cliBootstrap)).toBe(true);
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PASS-capable validator production identity", { timeout: 120_000 }, () => {
  it("rejects an alternate real Node executable as the validation controller", async () => {
    const root = temporaryRoot("rbp-validation-alternate-node-");
    const alternateNode = path.join(
      root,
      "node_modules",
      ".bound-node",
      process.platform === "win32" ? "node.exe" : "node",
    );
    mkdirSync(path.dirname(alternateNode), { recursive: true });
    copyFileSync(process.execPath, alternateNode);
    const planFile = writePlan(
      root,
      "current-production.json",
      createCurrentProductionPlan(
        repoRoot,
        "alternate-node-controller-test",
      ),
    );
    const result = await invokeCurrentCli({
      cwd: root,
      nodeExecutable: alternateNode,
      args: [
        "validate-run",
        path.join(root, "missing-report.json"),
        "--plan",
        planFile,
        "--repo-root",
        repoRoot,
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(
      /production controller Node does not match the plan-bound runtime Node identity/u,
    );
    expect(String(result.stderr)).not.toMatch(/ENOENT|no such file/u);
    expect(String(result.stdout)).not.toContain("PASS");
  });

  it("clears hostile parent NODE_OPTIONS before every validator loads JavaScript", async () => {
    const root = temporaryRoot("rbp-validation-node-options-");
    const base = createCurrentProductionPlan(
      repoRoot,
      "node-options-run-1",
    );
    const planFiles = ([1, 2, 3] as const).map((sequence) =>
      writePlan(
        root,
        `plan-${String(sequence)}.json`,
        planSequence(base, sequence),
      )) as [string, string, string];
    const soakPlan = writePlan(
      root,
      "soak-plan.json",
      planSequence(base, 1, "node-options-soak"),
    );
    const attacker = path.join(
      root,
      "node_modules/.hostile-controller/node-options-attacker.cjs",
    );
    const attackerMarker = path.join(
      root,
      "node_modules/.hostile-controller/node-options-attacker.loaded",
    );
    writeTemporaryFile(
      root,
      "node_modules/.hostile-controller/node-options-attacker.cjs",
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(attackerMarker)}, 'loaded');`,
        "process.stderr.write('NODE_OPTIONS_FIXTURE_LOADED\\n');",
        "",
      ].join("\n"),
    );
    const missingReport = path.join(root, "missing-report.json");
    const missingAggregate = path.join(root, "missing-aggregate.json");
    const commands = [
      {
        name: "validate-run",
        expectedMissing: missingReport,
        args: [
          "validate-run",
          missingReport,
          "--plan",
          planFiles[0],
          "--repo-root",
          repoRoot,
        ],
      },
      {
        name: "validate-aggregate",
        expectedMissing: missingAggregate,
        args: [
          "validate-aggregate",
          missingAggregate,
          ...aggregatePlanFlags(repoRoot, planFiles),
        ],
      },
      {
        name: "validate-soak",
        expectedMissing: missingAggregate,
        args: [
          "validate-soak",
          missingReport,
          "--plan",
          soakPlan,
          "--aggregate",
          missingAggregate,
          ...aggregatePlanFlags(repoRoot, planFiles),
        ],
      },
    ];
    for (const command of commands) {
      const result = await invokeCurrentCli({
        args: command.args,
        cwd: root,
        env: {
          ...sanitizedProductionRuntimeEnvironment(),
          NODE_OPTIONS: `--require=${attacker.replaceAll("\\", "/")}`,
        },
      });
      expect(result.error, command.name).toBeUndefined();
      expect(result.status, command.name).not.toBe(0);
      expect(String(result.stderr)).not.toContain("NODE_OPTIONS_FIXTURE_LOADED");
      expect(String(result.stderr)).not.toMatch(
        /production controller environment cannot set NODE_OPTIONS/u,
      );
      expect(String(result.stderr)).toContain(path.basename(command.expectedMissing));
      expect(String(result.stderr)).toMatch(
        /ENOENT|no such file/u,
      );
      expect(String(result.stdout)).not.toContain("PASS");
      expect(existsSync(attackerMarker)).toBe(false);
    }
  }, 180_000);

  it("does not consult hostile npm script-shell, user config, or node.cmd", async () => {
    const root = temporaryRoot("rbp-validation-hostile-npm-");
    const planFile = writePlan(
      root,
      "plan.json",
      createCurrentProductionPlan(repoRoot, "hostile-npm-test"),
    );
    const hostileRoot = path.join(
      root,
      "node_modules/.hostile-controller",
    );
    const marker = path.join(hostileRoot, "launcher-hijack.txt");
    writeTemporaryFile(
      root,
      "node_modules/.hostile-controller/node.cmd",
      `@echo hijacked>${marker}\r\n@exit /b 99\r\n`,
    );
    writeTemporaryFile(
      root,
      "node_modules/.hostile-controller/script-shell.cmd",
      `@echo hijacked>${marker}\r\n@exit /b 99\r\n`,
    );
    writeTemporaryFile(
      root,
      "node_modules/.hostile-controller/hostile.npmrc",
      `script-shell=${path.join(hostileRoot, "script-shell.cmd")}\n`,
    );
    const missingReport = path.join(root, "missing-report.json");
    const result = await invokeCurrentCli({
      cwd: root,
      args: [
        "validate-run",
        missingReport,
        "--plan",
        planFile,
        "--repo-root",
        repoRoot,
      ],
      env: {
        ...sanitizedProductionRuntimeEnvironment(),
        PATH: `${hostileRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_config_script_shell: path.join(hostileRoot, "script-shell.cmd"),
        NPM_CONFIG_USERCONFIG: path.join(hostileRoot, "hostile.npmrc"),
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(/ENOENT|no such file/u);
    expect(String(result.stderr)).toContain(path.basename(missingReport));
    expect(String(result.stdout)).not.toContain("PASS");
    expect(existsSync(marker)).toBe(false);
  });

});
