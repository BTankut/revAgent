import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const vitestCli = fileURLToPath(
  new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
);
if (!existsSync(vitestCli)) {
  throw new Error(`Vitest CLI is unavailable at the canonical workspace path: ${vitestCli}`);
}

const forwardedArguments = process.argv.slice(2);
const invocations = forwardedArguments.length > 0
  ? [["run", ...forwardedArguments]]
  : [
      ["run", "--shard=1/2"],
      ["run", "--shard=2/2"],
    ];

for (const argumentsValue of invocations) {
  const result = spawnSync(process.execPath, [vitestCli, ...argumentsValue], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
