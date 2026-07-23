import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ControlResponseError, StrictJsonlProcess } from "../src/processHarness.js";
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
      requiredActions: ["ping", "fail", "stall", "release", "shutdown"],
    });
    const result = await child.request("ping", { value: "observed" });
    expect(result).toEqual({ echoed: "observed", observation: "raw" });
    const stopped = await child.stop();
    expect(stopped.exitCode).toBe(0);
    expect(child.process.pid).toBeGreaterThan(0);
    expect(child.transcript.some((entry) => entry.stream === "stdout" && entry.line.includes('"echoed":"observed"'))).toBe(true);
    expect(child.transcript.some((entry) => entry.stream === "stderr" && entry.line === "ping:observed")).toBe(true);
  });

  it("keeps the control chain usable after an expected control error", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "fail", "shutdown"],
    });
    const expectedFailure = child.startConcurrentRequest("fail");
    const concurrentSuccess = child.startConcurrentRequest("ping", { value: "concurrent-after-error" });
    await expect(expectedFailure.response).rejects.toMatchObject({
      name: "ControlResponseError",
      code: "planned_error",
      controlMessage: "planned failure",
    } satisfies Partial<ControlResponseError>);
    await expect(concurrentSuccess.response).resolves.toEqual({
      echoed: "concurrent-after-error",
      observation: "raw",
    });
    await expect(child.request("ping", { value: "after-error" })).resolves.toEqual({
      echoed: "after-error",
      observation: "raw",
    });
    await expect(child.stop()).resolves.toMatchObject({ exitCode: 0 });
  });

  it("supports explicit non-awaited concurrent requests while preserving FIFO response order", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["stall", "release", "shutdown"],
    });
    const stalled = child.startConcurrentRequest("stall", { value: "first" });
    const release = child.startConcurrentRequest("release");
    expect(stalled.id).not.toBe(release.id);
    await expect(stalled.response).resolves.toEqual({ released: "first" });
    await expect(release.response).resolves.toEqual({ releasedId: stalled.id });
    await expect(child.stop()).resolves.toMatchObject({ exitCode: 0 });
  });

  it("fails closed when a concurrent component violates strict FIFO response order", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("out-of-order"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["stall", "release", "shutdown"],
    });
    const stalled = child.startConcurrentRequest("stall", { value: "first" });
    const release = child.startConcurrentRequest("release");
    const settled = await Promise.allSettled([stalled.response, release.response]);
    expect(settled).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/out-of-order/u) }) }),
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/out-of-order/u) }) }),
    ]);
    await expect(child.stop()).resolves.toMatchObject({ exitCode: expect.any(Number) });
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
