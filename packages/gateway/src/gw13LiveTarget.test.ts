import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(sourceDirectory, "../scripts/gw13-live-smoke.mjs");
const tokenEnvironmentVariable = "REVAGENT_GW13_LIVE_TARGET_TEST_TOKEN";
const commonArguments = Object.freeze([
  "--endpoint",
  "https://gateway.invalid/mcp",
  "--client",
  "selected-codex-desktop",
  "--client-build",
  "test-build",
  "--token-env",
  tokenEnvironmentVariable,
]);

function runScript(...arguments_: readonly string[]) {
  const environment = { ...process.env };
  delete environment[tokenEnvironmentVariable];
  return spawnSync(process.execPath, [scriptPath, ...arguments_], {
    encoding: "utf8",
    env: environment,
  });
}

describe("GW-13 caller-supplied live target", () => {
  it("keeps the CI-safe dry run targetless", () => {
    const result = runScript(...commonArguments);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      execute: false,
      target: null,
      state: "dry_run_ready",
    });
  });

  it("refuses execute without a target before credential or network use", () => {
    const result = runScript("--execute", ...commonArguments);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--target is required");
    expect(result.stderr).not.toContain("credential environment variable is absent");
    expect(result.stderr).not.toContain("ENOTFOUND");
  });
});
