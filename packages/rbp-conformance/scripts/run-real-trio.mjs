import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runRealTrioPreflight } from "./real-trio-runner-preflight.mjs";

const vitestCli = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
if (!existsSync(vitestCli)) {
  throw new Error(`Vitest CLI is unavailable at the canonical workspace path: ${vitestCli}`);
}

runRealTrioPreflight();
const result = spawnSync(process.execPath, [
  vitestCli,
  "run",
  "--config",
  "vitest.real-trio.config.ts",
  ...process.argv.slice(2),
], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: process.env, stdio: "inherit", windowsHide: true });
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
