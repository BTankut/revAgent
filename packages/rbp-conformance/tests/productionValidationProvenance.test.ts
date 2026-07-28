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

// @ts-expect-error -- the runtime bootstrap has no TypeScript declaration file.
import { productionLaunchPowerShellArguments } from "../scripts/production-launch-bootstrap.mjs";
import {
  sanitizedProductionRuntimeEnvironment,
} from "../src/productionRuntimeIdentity.js";
import { stableJson } from "../src/stableJson.js";
import type { ExecutionPlan } from "../src/types.js";
import {
  canonicalProductionCliArguments,
  exactSystemPowerShell,
} from "./canonicalProductionLauncher.js";
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
/** No output at all for this long means the launcher is wedged, not slow. */
const IDLE_TIMEOUT_MS = 120_000;

/**
 * Hard ceiling. It must stay above the sibling `globalSetup` budget for the
 * same PowerShell launcher, whose measured cost on this runner has reached
 * ~173 s; a ceiling below that would fail here first and hide the real signal.
 */
const ABSOLUTE_TIMEOUT_MS = 300_000;

/**
 * `child.kill()` on Windows terminates only `powershell.exe`. The production
 * Node grandchild survives, keeps the inherited stdio pipes open, and the
 * `close` event never fires — silently converting an intended launcher timeout
 * into a much later whole-test timeout with no diagnostic. Kill the tree.
 */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return;
  }
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  }).on("error", () => {
    /* the process tree is already gone */
  });
}

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
}): Promise<CliInvocationResult> {
  const child = spawn(
    exactSystemPowerShell,
    canonicalProductionCliArguments(repoRoot, input.args),
    {
      cwd: input.cwd,
      shell: false,
      env: input.env ?? sanitizedProductionRuntimeEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let launchError: Error | undefined;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    // An inactivity budget, not an absolute one. The old fixed 90 s deadline
    // was armed at spawn and never refreshed, so it asserted machine speed
    // rather than launcher liveness: on a loaded runner a launcher that was
    // making steady progress still got killed. A launcher that is genuinely
    // wedged still trips this, because a wedged launcher emits nothing.
    let idleTimer: NodeJS.Timeout;
    const armIdleTimer = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(expire, IDLE_TIMEOUT_MS);
    };
    // A ceiling still exists so a launcher that chatters forever cannot hang
    // the suite; it is sized well above the measured cost of the heaviest
    // command rather than hand-picked against a quiet machine.
    const absoluteTimer = setTimeout(expire, ABSOLUTE_TIMEOUT_MS);

    function expire(): void {
      if (timedOut) return;
      timedOut = true;
      killProcessTree(child.pid);
    }

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      armIdleTimer();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      armIdleTimer();
    });
    armIdleTimer();
    child.on("error", (error) => {
      launchError = error;
    });
    child.on("close", (status, signal) => {
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      const elapsedMs = Date.now() - startedAt;
      resolve({
        status,
        signal,
        stdout,
        stderr,
        // Carry the evidence. The previous version discarded stdout/stderr
        // context on the timeout path, which is why a timeout in this suite
        // produced no information about what was actually slow.
        error: timedOut
          ? new Error(
              `validator launcher timed out after ${String(elapsedMs)}ms ` +
                `(idle budget ${String(IDLE_TIMEOUT_MS)}ms, ` +
                `absolute budget ${String(ABSOLUTE_TIMEOUT_MS)}ms); ` +
                `stdout tail: ${JSON.stringify(stdout.slice(-2_048))}; ` +
                `stderr tail: ${JSON.stringify(stderr.slice(-2_048))}`,
            )
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
  expect(existsSync(compiledCli)).toBe(true);
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PASS-capable validator production identity", { timeout: 120_000 }, () => {
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
  }, 900_000);

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
