import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { ControlResponseError, StrictJsonlProcess, StrictReadyProcess } from "../src/processHarness.js";
import type { ProcessCommandDescriptor } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "jsonl-component.mjs");
const readyIpcFixture = path.join(here, "fixtures", "ready-ipc-shutdown-child.mjs");

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

function readyIpcCommand(mode: string, marker?: string): ProcessCommandDescriptor {
  return {
    executable: process.execPath,
    args: [readyIpcFixture, mode, ...(marker === undefined ? [] : [marker])],
    workingDirectory: "packages/rbp-conformance",
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "ready", timeoutMs: 5_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 5_000 },
  };
}

async function startReadyIpc(mode: string, marker?: string): Promise<StrictReadyProcess> {
  return await StrictReadyProcess.start({
    componentId: "addin_loopback_fixture",
    command: readyIpcCommand(mode, marker),
    absoluteWorkingDirectory: here,
    useTestSignalProxy: true,
    validateReadiness(value) { expect(value).toMatchObject({ ready: true, component: "fixture-test" }); },
  });
}

type TestIpcSend = (message: unknown, callback?: (error: Error | null) => void) => boolean;

function testIpcSend(child: StrictReadyProcess): { send: TestIpcSend } {
  return (child as unknown as { readonly child: { send: TestIpcSend } }).child;
}

describe("strict JSONL process control", () => {
  it("uses one opaque STOP generation, accepts only its exact ack, then parent-disconnects", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-ready-stop-"));
    const marker = path.join(root, "child-stop.json");
    const child = await startReadyIpc("wrong-then-right", marker);
    const first = child.stop("SIGTERM", 2_000);
    const second = child.stop("SIGTERM", 2_000);
    expect(second).toBe(first);
    const stopped = await first;
    expect(stopped).toMatchObject({ exitCode: 0, killEscalated: false });
    expect(stopped.telemetry).toMatchObject({
      correlationKind: "ipc_stop_nonce",
      correlationId: expect.any(String),
      acknowledgement: "closed",
      requestedAt: expect.any(String),
      acknowledgedAt: expect.any(String),
    });
    expect(stopped.evidence).toMatchObject({
      componentId: "addin_loopback_fixture",
      pid: expect.any(Number),
      exitCode: 0,
      stdout: { sha256: expect.stringMatching(/^sha256:/u) },
      stderr: { sha256: expect.stringMatching(/^sha256:/u) },
    });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ stopCount: 1 });
  });

  it("treats a false IPC send return as backpressure while the exact ACK completes naturally", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-ready-backpressure-"));
    const marker = path.join(root, "child-backpressure.json");
    const child = await startReadyIpc("normal", marker);
    const handle = testIpcSend(child);
    const original = handle.send.bind(handle) as TestIpcSend;
    handle.send = ((message, callback) => {
      original(message, callback);
      return false;
    }) as TestIpcSend;
    await expect(child.stop("SIGTERM", 2_000)).resolves.toMatchObject({ exitCode: 0, killEscalated: false });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ stopCount: 1 });
  });

  it("escalates exactly once when false-backpressure is followed by an IPC callback error", async () => {
    const child = await startReadyIpc("normal");
    const handle = testIpcSend(child);
    handle.send = ((_message, callback) => {
      setTimeout(() => callback?.(new Error("planned IPC callback failure")), 1);
      return false;
    }) as TestIpcSend;
    await expect(child.stop("SIGTERM", 2_000)).resolves.toMatchObject({ killEscalated: true });
    expect(child.process.exitCode).not.toBeNull();
  });

  it("escalates once when false-backpressure receives no STOP acknowledgement", async () => {
    const child = await startReadyIpc("missing-ack");
    const handle = testIpcSend(child);
    const original = handle.send.bind(handle) as TestIpcSend;
    handle.send = ((message, callback) => {
      original(message, callback);
      return false;
    }) as TestIpcSend;
    const stopped = await child.stop("SIGTERM", 50);
    expect(stopped).toMatchObject({
      killEscalated: true,
      exitCode: expect.any(Number),
    });
    expect(stopped.telemetry).toMatchObject({
      correlationKind: "ipc_stop_nonce",
      acknowledgement: "failed_or_timed_out",
      requestedAt: expect.any(String),
      acknowledgedAt: expect.any(String),
    });
    expect(child.process.exitCode).not.toBeNull();
  });

  it("leaves no IPC-held child after parent disconnect", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-ready-disconnect-"));
    const marker = path.join(root, "child-disconnect.json");
    const child = await startReadyIpc("normal", marker);
    await expect(child.stop()).resolves.toMatchObject({ exitCode: 0, killEscalated: false });
    expect(existsSync(marker)).toBe(true);
  });

  it("uses the canonical sanitized environment and rejects resolution overrides", async () => {
    const hostileEnvironment = {
      NODE_OPTIONS: "--no-warnings",
      NODE_PATH: "hostile-node-path",
      NODE_PRESERVE_SYMLINKS: "1",
      NODE_COMPILE_CACHE: "hostile-compile-cache",
      NODE_DISABLE_COMPILE_CACHE: "1",
      WS_NO_BUFFER_UTIL: "1",
      WS_NO_UTF_8_VALIDATE: "1",
    } as const;
    const original = new Map(
      Object.keys(hostileEnvironment).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, hostileEnvironment);
      const child = await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command("environment"),
        absoluteWorkingDirectory: here,
        environment: { RBP_EXPLICIT_CHILD_VALUE: "retained" },
        expectedReadinessFields: {
          component: "fixture-test",
          environment: {
            NODE_OPTIONS: null,
            NODE_PATH: null,
            NODE_PRESERVE_SYMLINKS: null,
            NODE_COMPILE_CACHE: null,
            NODE_DISABLE_COMPILE_CACHE: null,
            WS_NO_BUFFER_UTIL: null,
            WS_NO_UTF_8_VALIDATE: null,
            RBP_EXPLICIT_CHILD_VALUE: "retained",
          },
        },
        requiredActions: ["shutdown"],
      });
      await expect(child.stop()).resolves.toMatchObject({ exitCode: 0 });

      await expect(StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command(),
        absoluteWorkingDirectory: here,
        environment: { NODE_OPTIONS: "--no-warnings" },
        expectedReadinessFields: { component: "fixture-test" },
        requiredActions: ["shutdown"],
      })).rejects.toThrow(/cannot set NODE_OPTIONS/u);
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

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

  it("exposes a process-only crash boundary without issuing a private shutdown control", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "shutdown"],
    });
    await expect(child.terminateForConformance()).resolves.toMatchObject({
      exitCode: expect.any(Number),
      killEscalated: false,
    });
    expect(child.process.exitCode).not.toBe(0);
    expect(child.transcript.some((entry) => entry.line.includes('"stopped":true'))).toBe(false);
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

  it("fails closed when readiness controls are absent or startup exits with stderr", async () => {
    await expect(StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("missing-action"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "shutdown"],
    })).rejects.toThrow(/missing controls/u);

    await expect(StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("stderr-exit"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["shutdown"],
    })).rejects.toThrow(
      /exited before readiness \(1\).*EADDRINUSE.*address already in use/u,
    );
  });

  it("persists redacted start evidence before a caller catches and re-wraps the failure", async () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-process-start-evidence-"));
    let observed: Error | undefined;
    try {
      await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command("stderr-exit"),
        absoluteWorkingDirectory: here,
        evidenceDirectory,
        expectedReadinessFields: { component: "fixture-test" },
        requiredActions: ["shutdown"],
      });
    } catch (error) {
      observed = new Error("caller re-wrap", { cause: error });
    }
    expect(observed).toBeDefined();
    const artifact = JSON.parse(readFileSync(path.join(evidenceDirectory, "addin_loopback_fixture.start-failure.json"), "utf8"));
    expect(artifact).toMatchObject({
      schemaVersion: "rbp-real-trio-process-start-failure/v1",
      component: "addin_loopback_fixture",
      phase: "pre_ready",
      pid: expect.any(Number),
      stderr: { hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
    });
    expect(readFileSync(path.join(evidenceDirectory, "addin_loopback_fixture.stderr.log"), "utf8")).toContain("EADDRINUSE");

    await expect(StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("stderr-exit"),
      absoluteWorkingDirectory: here,
      evidenceDirectory,
      validateReadiness: () => undefined,
    })).rejects.toMatchObject({ name: "ReadyProcessStartError" });
    expect(JSON.parse(readFileSync(path.join(evidenceDirectory, "addin_loopback_fixture.start-failure.json"), "utf8"))).toMatchObject({
      component: "addin_loopback_fixture",
      stderr: { safeLines: expect.arrayContaining([expect.stringContaining("EADDRINUSE")]) },
    });
  });
});
