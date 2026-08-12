import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  sanitizedProductionRuntimeEnvironment,
} from "../../src/productionRuntimeIdentity.js";
import {
  canonicalProductionCliArguments,
  exactSystemPowerShell,
} from "../canonicalProductionLauncher.js";

const ABSOLUTE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MARGIN_MS = 60_000;
const OUTPUT_TAIL_CHARACTERS = 2_048;

function exactSystemTaskkill(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (systemRoot === undefined) {
    throw new Error("production CLI test watchdog requires SystemRoot");
  }
  const executable = path.join(systemRoot, "System32", "taskkill.exe");
  if (!existsSync(executable)) {
    throw new Error(
      `production CLI test watchdog executable is missing: ${executable}`,
    );
  }
  return executable;
}

export interface ProductionCliInvocationResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

export interface ProductionCliInvocation {
  repoRoot: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
}

/**
 * Keep the outer Vitest timeout above every diagnosable per-launch ceiling.
 */
export function productionCliTestTimeoutMs(invocationCount: number): number {
  if (!Number.isSafeInteger(invocationCount) || invocationCount < 1) {
    throw new Error("production CLI invocation count must be a positive integer");
  }
  return ABSOLUTE_TIMEOUT_MS * invocationCount + TEST_TIMEOUT_MARGIN_MS;
}

/**
 * `child.kill()` on Windows terminates only `powershell.exe`. The production
 * Node grandchild survives, keeps the inherited stdio pipes open, and the
 * `close` event never fires. Kill the complete process tree instead.
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
  const taskkill = spawn(exactSystemTaskkill(), ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  taskkill.on("error", () => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
  taskkill.on("close", (status) => {
    if (status === 0) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
}

/**
 * Invoke the protected production CLI with one shared liveness contract.
 *
 * The protected launcher is intentionally silent while it anchors source,
 * builds, and attests the production plan. Output is therefore not a liveness
 * signal: an idle watchdog can kill healthy work before the aggregate command
 * reaches its byte/hash assertions. The absolute ceiling still prevents both
 * silent and chatty launchers from hanging the suite, and stays well above the
 * observed ~173 s cost on the shared Windows runner.
 */
export function invokeProductionCli(
  input: ProductionCliInvocation,
): Promise<ProductionCliInvocationResult> {
  const child = spawn(
    exactSystemPowerShell,
    canonicalProductionCliArguments(input.repoRoot, input.args),
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

    const expire = (): void => {
      if (timedOut) return;
      timedOut = true;
      killProcessTree(child.pid);
    };
    const absoluteTimer = setTimeout(
      expire,
      ABSOLUTE_TIMEOUT_MS,
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      launchError = error;
    });
    child.on("close", (status, signal) => {
      clearTimeout(absoluteTimer);
      const elapsedMs = Date.now() - startedAt;
      resolve({
        status,
        signal,
        stdout,
        stderr,
        error: !timedOut
          ? launchError
          : new Error(
            `${input.label} timed out on the absolute budget after ` +
              `${String(elapsedMs)}ms (absolute budget ${String(ABSOLUTE_TIMEOUT_MS)}ms); ` +
              `stdout tail: ${JSON.stringify(stdout.slice(-OUTPUT_TAIL_CHARACTERS))}; ` +
              `stderr tail: ${JSON.stringify(stderr.slice(-OUTPUT_TAIL_CHARACTERS))}`,
          ),
      });
    });
  });
}
