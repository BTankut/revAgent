import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  sanitizedProductionRuntimeEnvironment,
} from "../src/productionRuntimeIdentity.js";
import { stableJson } from "../src/stableJson.js";
import type { ExecutionPlan } from "../src/types.js";
import {
  buildFixturePlan,
  cleanupProductionProvenanceFixtures,
  createFixtureSidecars,
  productionProvenanceFixture,
  writeFixtureFile,
} from "./productionProvenanceFixture.js";

let compiledCli = "";
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(packageRoot, "..", "..");

function compileCurrentController(): string {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, "node_modules/typescript/lib/tsc.js"),
    "-p",
    path.join(repoRoot, "packages/rbp-conformance/tsconfig.json"),
    "--pretty",
    "false",
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
    env: sanitizedProductionRuntimeEnvironment(),
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `controller fixture compilation failed: ${String(result.stderr).trim()}`,
    );
  }
  return path.join(repoRoot, "packages/rbp-conformance/dist/src/cli.js");
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

function writePlan(root: string, name: string, plan: ExecutionPlan): string {
  const relative = `node_modules/.test-plans/${name}`;
  writeFixtureFile(root, relative, stableJson(plan));
  return path.join(root, relative);
}

function aggregatePlanFlags(
  root: string,
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
    root,
  ];
}

beforeAll(() => {
  compiledCli = compileCurrentController();
});

afterEach(cleanupProductionProvenanceFixtures);

describe("PASS-capable validator production identity", { timeout: 120_000 }, () => {
  it("rejects an alternate real Node executable as the validation controller", () => {
    const value = productionProvenanceFixture();
    const alternateNode = path.join(
      value.root,
      "node_modules",
      ".bound-node",
      process.platform === "win32" ? "node.exe" : "node",
    );
    mkdirSync(path.dirname(alternateNode), { recursive: true });
    copyFileSync(process.execPath, alternateNode);
    value.nodeExecutable = alternateNode;
    createFixtureSidecars(value);
    const planFile = writePlan(
      value.root,
      "alternate-node.json",
      buildFixturePlan(value),
    );
    const result = spawnSync(process.execPath, [
      compiledCli,
      "validate-run",
      path.join(value.root, "missing-report.json"),
      "--plan",
      planFile,
      "--repo-root",
      value.root,
    ], {
      cwd: value.root,
      encoding: "utf8",
      shell: false,
      env: sanitizedProductionRuntimeEnvironment(),
      timeout: 90_000,
      windowsHide: true,
    });

    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(/controller Node does not match/u);
    expect(String(result.stdout)).not.toContain("PASS");
  });

  it("rejects hostile NODE_OPTIONS in every PASS-capable validator CLI", () => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const base = buildFixturePlan(value);
    const planFiles = ([1, 2, 3] as const).map((sequence) =>
      writePlan(
        value.root,
        `plan-${String(sequence)}.json`,
        planSequence(base, sequence),
      )) as [string, string, string];
    const attacker = path.join(
      value.root,
      "node_modules/.hostile-controller/node-options-attacker.cjs",
    );
    writeFixtureFile(
      value.root,
      "node_modules/.hostile-controller/node-options-attacker.cjs",
      "process.stderr.write('NODE_OPTIONS_FIXTURE_LOADED\\n');\n",
    );
    const missingReport = path.join(value.root, "missing-report.json");
    const missingAggregate = path.join(value.root, "missing-aggregate.json");
    const commands = [
      [
        "validate-run",
        missingReport,
        "--plan",
        planFiles[0],
        "--repo-root",
        value.root,
      ],
      [
        "validate-aggregate",
        missingAggregate,
        ...aggregatePlanFlags(value.root, planFiles),
      ],
      [
        "validate-soak",
        missingReport,
        "--plan",
        planFiles[0],
        "--aggregate",
        missingAggregate,
        ...aggregatePlanFlags(value.root, planFiles),
      ],
    ];
    for (const command of commands) {
      const result = spawnSync(process.execPath, [compiledCli, ...command], {
        cwd: value.root,
        encoding: "utf8",
        shell: false,
        env: {
          ...sanitizedProductionRuntimeEnvironment(),
          NODE_OPTIONS: `--require=${attacker.replaceAll("\\", "/")}`,
        },
        timeout: 90_000,
        windowsHide: true,
      });
      expect(result.status, command[0]).not.toBe(0);
      expect(String(result.stderr)).toContain("NODE_OPTIONS_FIXTURE_LOADED");
      expect(String(result.stderr)).toMatch(
        /production controller environment cannot set NODE_OPTIONS/u,
      );
      expect(String(result.stdout)).not.toContain("PASS");
    }
  });

  it("does not consult hostile npm script-shell, user config, or node.cmd", () => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const planFile = writePlan(value.root, "plan.json", buildFixturePlan(value));
    const hostileRoot = path.join(
      value.root,
      "node_modules/.hostile-controller",
    );
    const marker = path.join(hostileRoot, "launcher-hijack.txt");
    writeFixtureFile(
      value.root,
      "node_modules/.hostile-controller/node.cmd",
      `@echo hijacked>${marker}\r\n@exit /b 99\r\n`,
    );
    writeFixtureFile(
      value.root,
      "node_modules/.hostile-controller/script-shell.cmd",
      `@echo hijacked>${marker}\r\n@exit /b 99\r\n`,
    );
    writeFixtureFile(
      value.root,
      "node_modules/.hostile-controller/hostile.npmrc",
      `script-shell=${path.join(hostileRoot, "script-shell.cmd")}\n`,
    );
    const result = spawnSync(process.execPath, [
      compiledCli,
      "validate-run",
      path.join(value.root, "missing-report.json"),
      "--plan",
      planFile,
      "--repo-root",
      value.root,
    ], {
      cwd: value.root,
      encoding: "utf8",
      shell: false,
      env: {
        ...sanitizedProductionRuntimeEnvironment(),
        PATH: `${hostileRoot}${path.delimiter}${process.env.PATH ?? ""}`,
        npm_config_script_shell: path.join(hostileRoot, "script-shell.cmd"),
        NPM_CONFIG_USERCONFIG: path.join(hostileRoot, "hostile.npmrc"),
      },
      timeout: 90_000,
      windowsHide: true,
    });

    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toMatch(/ENOENT|no such file/u);
    expect(String(result.stdout)).not.toContain("PASS");
    expect(existsSync(marker)).toBe(false);
  });

});
