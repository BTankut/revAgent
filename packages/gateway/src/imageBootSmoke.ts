import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/**
 * Proves the built image actually boots and reports healthy (GW-2).
 *
 * The acceptance criterion says the container boots and health is green, and
 * the Gateway CI workflow builds the image but never runs it. Rather than edit
 * that workflow — which this task is not allowed to do — the proof runs inside
 * the Dockerfile's runtime stage, which the existing image-build step already
 * executes. A failure here therefore reddens CI with no workflow change at all.
 *
 * This covers five things nothing else does: the entry point path resolves;
 * ESM resolution works from `dist/` in the runtime stage, where only the
 * package's own manifest is copied and the workspace root manifest is not;
 * the entry point has no top-level throw; the production non-loopback bind rule
 * does not block boot; and SIGTERM drains cleanly.
 */
const PORT = 8080;
const DEADLINE_MS = 20_000;
const POLL_MS = 250;
const SHUTDOWN_MS = 5_000;

function fail(reason: string): never {
  process.stderr.write(`image boot smoke failed: ${reason}\n`);
  process.exit(1);
}

// Resolved from this module rather than the working directory: the image
// runs it from /app while a local run starts in the package.
const entryPoint = fileURLToPath(new URL("./main.js", import.meta.url));

const child = spawn(process.execPath, [entryPoint], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    GATEWAY_BIND_HOST: "0.0.0.0",
    PORT: String(PORT),
    GATEWAY_PUBLIC_URL: "https://smoke.invalid",
    LOG_LEVEL: "info",
  },
  stdio: "inherit",
});

let exited: number | null = null;
child.on("exit", (code) => {
  exited = code ?? 1;
});

const startedAt = Date.now();
let healthy = false;
while (Date.now() - startedAt < DEADLINE_MS) {
  if (exited !== null) {
    fail(`the process exited with code ${String(exited)} before reporting healthy`);
  }
  try {
    const response = await fetch(`http://127.0.0.1:${String(PORT)}/healthz`);
    if (response.status === 200) {
      const body: unknown = await response.json();
      if (JSON.stringify(body) !== JSON.stringify({ status: "ok" })) {
        fail(`/healthz returned an unexpected body: ${JSON.stringify(body)}`);
      }
      healthy = true;
      break;
    }
  } catch {
    // Not listening yet.
  }
  await delay(POLL_MS);
}

if (!healthy) {
  fail(`/healthz did not return 200 {"status":"ok"} within ${String(DEADLINE_MS)}ms`);
}

child.kill("SIGTERM");
const shutdownStartedAt = Date.now();
while (Date.now() - shutdownStartedAt < SHUTDOWN_MS) {
  if (exited !== null) {
    break;
  }
  await delay(POLL_MS);
}

if (exited === null) {
  child.kill("SIGKILL");
  fail(`the process did not exit within ${String(SHUTDOWN_MS)}ms of SIGTERM`);
}

// Windows has no real SIGTERM: `child.kill` calls TerminateProcess, the handler
// never runs, and the exit code is 1 no matter how clean the shutdown path is.
// The graceful-drain assertion is therefore made only where the signal exists —
// which is the platform this smoke gates, since it runs inside the Linux image
// build. On Windows it still proves boot and health, which is what makes it
// useful to run locally while developing.
if (process.platform !== "win32" && exited !== 0) {
  fail(`the process exited with code ${String(exited)} after SIGTERM`);
}

process.stdout.write("image boot smoke passed\n");
