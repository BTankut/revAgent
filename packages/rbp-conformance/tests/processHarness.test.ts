import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { StrictJsonlProcess } from "../src/processHarness.js";
import type { ProcessCommandDescriptor } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "jsonl-component.mjs");

function command(mode = "good"): ProcessCommandDescriptor {
  return {
    executable: process.execPath,
    args: [fixture, mode],
    workingDirectory: "packages/rbp-conformance",
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "ready", timeoutMs: 5_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 5_000 },
  };
}

describe("strict JSONL process control", () => {
  it("requires exact readiness and correlates FIFO responses under the 64 KiB cap", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "shutdown"],
    });
    const result = await child.request("ping", { value: "observed" });
    expect(result).toEqual({ echoed: "observed", passed: true });
    const stopped = await child.stop();
    expect(stopped.exitCode).toBe(0);
    expect(child.process.pid).toBeGreaterThan(0);
  });

  it("fails closed when a required daemon control is absent", async () => {
    await expect(StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("missing-action"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "shutdown"],
    })).rejects.toThrow(/missing controls/u);
  });
});
