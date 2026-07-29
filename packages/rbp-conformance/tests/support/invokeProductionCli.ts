import { spawn } from "node:child_process";

import {
  sanitizedProductionRuntimeEnvironment,
} from "../../src/productionRuntimeIdentity.js";
import {
  canonicalProductionCliArguments,
  exactSystemPowerShell,
} from "../canonicalProductionLauncher.js";

const IDLE_TIMEOUT_MS = 120_000;
const ABSOLUTE_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MARGIN_MS = 60_000;
const OUTPUT_TAIL_CHARACTERS = 2_048;

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
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  }).on("error", () => {
    /* the process tree is already gone */
  });
}

/**
 * Invoke the protected production CLI with one shared liveness contract.
 *
 * Output refreshes the idle budget, while the absolute ceiling still prevents
 * a launcher that chatters forever from hanging the suite. The 300 s ceiling
 * stays well above the observed ~173 s cost on the shared Windows runner.
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
    let timeoutKind: "idle" | "absolute" | undefined;
    let idleTimer: NodeJS.Timeout | undefined;

    const expire = (kind: "idle" | "absolute"): void => {
      if (timeoutKind !== undefined) return;
      timeoutKind = kind;
      killProcessTree(child.pid);
    };
    const armIdleTimer = (): void => {
      if (timeoutKind !== undefined) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => expire("idle"), IDLE_TIMEOUT_MS);
    };
    const absoluteTimer = setTimeout(
      () => expire("absolute"),
      ABSOLUTE_TIMEOUT_MS,
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
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
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      const elapsedMs = Date.now() - startedAt;
      resolve({
        status,
        signal,
        stdout,
        stderr,
        error: timeoutKind === undefined
          ? launchError
          : new Error(
            `${input.label} timed out on the ${timeoutKind} budget after ` +
              `${String(elapsedMs)}ms (idle budget ${String(IDLE_TIMEOUT_MS)}ms, ` +
              `absolute budget ${String(ABSOLUTE_TIMEOUT_MS)}ms); ` +
              `stdout tail: ${JSON.stringify(stdout.slice(-OUTPUT_TAIL_CHARACTERS))}; ` +
              `stderr tail: ${JSON.stringify(stderr.slice(-OUTPUT_TAIL_CHARACTERS))}`,
          ),
      });
    });
  });
}
