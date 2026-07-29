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

// @ts-expect-error -- the runtime bootstrap has no TypeScript declaration file.
import { productionLaunchPowerShellArguments } from "../scripts/production-launch-bootstrap.mjs";
import {
  sanitizedProductionRuntimeEnvironment,
} from "../src/productionRuntimeIdentity.js";
import { stableJson } from "../src/stableJson.js";
import type { ExecutionPlan } from "../src/types.js";
import {
  exactSystemPowerShell,
} from "./canonicalProductionLauncher.js";
import { createCurrentProductionPlan } from "./helpers.js";
import {
  invokeProductionCli,
  productionCliTestTimeoutMs,
  type ProductionCliInvocationResult,
} from "./support/invokeProductionCli.js";

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

function invokeCurrentCli(input: {
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProductionCliInvocationResult> {
  return invokeProductionCli({
    ...input,
    repoRoot,
    label: "validator launcher",
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
  expect(existsSync(compiledCli)).toBe(true);
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PASS-capable validator production identity", () => {
  it("rejects a caller-selected alternate Node before the canonical host starts", () => {
    const root = temporaryRoot("rbp-validation-alternate-node-");
    const alternateNode = path.join(
      root,
      "node_modules",
      ".bound-node",
      process.platform === "win32" ? "node.exe" : "node",
    );
    mkdirSync(path.dirname(alternateNode), { recursive: true });
    copyFileSync(process.execPath, alternateNode);
    expect(() =>
      productionLaunchPowerShellArguments({
        repoRoot,
        role: "cli-bootstrap",
        expectedCommit: "0".repeat(40),
        expectedTree: "0".repeat(40),
        commandArguments: ["validate-run", "missing-report.json"],
        powershellExecutable: exactSystemPowerShell,
        nodeExecutable: alternateNode,
      })
    ).toThrow(/encoded-bootstrap payload is invalid/u);
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
    // Above 3x the launcher's own ceiling, so the inner, diagnosable timeout
    // always fires before this outer one. An opaque vitest timeout here would
    // tell us nothing about which of the three commands stalled.
  }, productionCliTestTimeoutMs(3));

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
  }, productionCliTestTimeoutMs(1));

});
