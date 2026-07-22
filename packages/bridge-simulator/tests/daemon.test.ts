import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { mutationInvoke } from "./helpers.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureCli = resolve(packageRoot, "..", "addin-loopback-fixture", "dist", "cli.js");
const bridgeCli = resolve(packageRoot, "dist", "cli.js");

interface JsonObject {
  [key: string]: unknown;
}

class JsonLineReader {
  #buffer = Buffer.alloc(0);
  readonly #queued: JsonObject[] = [];
  readonly #waiters: Array<{
    readonly resolve: (value: JsonObject) => void;
    readonly reject: (error: Error) => void;
    readonly timeout: NodeJS.Timeout;
  }> = [];

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.#consume(chunk));
    child.once("exit", (code, signal) => {
      const error = new Error(`JSONL child exited: code=${String(code)} signal=${String(signal)}`);
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    });
  }

  public async next(timeoutMs = 5_000): Promise<JsonObject> {
    const queued = this.#queued.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolveValue, rejectValue) => {
      const timeout = setTimeout(() => {
        const index = this.#waiters.findIndex((entry) => entry.resolve === resolveValue);
        if (index >= 0) this.#waiters.splice(index, 1);
        rejectValue(new Error("timed out waiting for JSONL record"));
      }, timeoutMs);
      this.#waiters.push({ resolve: resolveValue, reject: rejectValue, timeout });
    });
  }

  public async send(record: JsonObject): Promise<JsonObject> {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
    const response = await this.next();
    expect(response.id).toBe(record.id);
    return response;
  }

  #consume(chunk: Buffer): void {
    this.#buffer = this.#buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const value = JSON.parse(line.toString("utf8")) as JsonObject;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#queued.push(value);
      else {
        clearTimeout(waiter.timeout);
        waiter.resolve(value);
      }
      newline = this.#buffer.indexOf(0x0a);
    }
  }
}

function child(script: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [script, ...args], {
    cwd: packageRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function control(id: string, action: string, fields: JsonObject = {}): JsonObject {
  return { controlVersion: 1, id, action, ...fields };
}

async function collectSnapshot(channel: JsonLineReader, firstId: string): Promise<JsonObject[]> {
  const pages: JsonObject[] = [];
  let response = await channel.send(control(firstId, "snapshot_evidence"));
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    expect(response.ok).toBe(true);
    const result = response.result as JsonObject;
    pages.push(result);
    if (result.complete === true) return pages;
    response = await channel.send(control(`${firstId}-${pageNumber + 1}`, "snapshot_evidence", {
      snapshotId: result.snapshotId,
      cursor: result.nextCursor,
    }));
  }
  throw new Error("bridge evidence snapshot did not terminate");
}

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const processHandle of children.splice(0)) {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
    if (processHandle.exitCode === null) await once(processHandle, "exit").catch(() => undefined);
  }
});

describe("long-lived Bridge JSONL daemon", () => {
  it("exposes granular controls, durable restart evidence, and leak-free shutdown", async () => {
    const fixture = child(fixtureCli, ["--port", "0"]);
    children.push(fixture);
    const fixtureChannel = new JsonLineReader(fixture);
    const fixtureReady = await fixtureChannel.next();
    expect(fixtureReady).toMatchObject({ ready: true, contract: "addin-loopback/v1" });

    const bridge = child(bridgeCli, ["daemon"]);
    children.push(bridge);
    const bridgeChannel = new JsonLineReader(bridge);
    const ready = await bridgeChannel.next();
    expect(ready).toMatchObject({
      ready: true,
      component: "bridge-simulator",
      componentRole: "O1-T4",
      contract: "bridge-simulator-control/v1",
      controlVersion: 1,
      maxControlLineBytes: 65_536,
    });
    expect(ready.actions).toEqual([
      "discover_fixture",
      "attach_fixture_session",
      "open_transport",
      "start_run_loop",
      "session_register",
      "session_resume",
      "session_unregister",
      "tick",
      "poll_document_context",
      "flush_outbound",
      "invoke_local",
      "inject_crash",
      "restart_simulator",
      "snapshot_evidence",
      "shutdown",
    ]);

    bridge.stdin.write(
      '{"controlVersion":1,"id":"duplicate","action":"snapshot_evidence","action":"shutdown"}\n',
    );
    await expect(bridgeChannel.next()).resolves.toMatchObject({
      id: null,
      ok: false,
      error: { code: "control_duplicate_key" },
    });

    const discovery = await bridgeChannel.send(control("discover", "discover_fixture", {
      host: fixtureReady.host,
      port: fixtureReady.port,
    }));
    expect(discovery).toMatchObject({
      ok: true,
      result: {
        sessions: [{ probeIndex: 0, target: { host: "127.0.0.1", port: fixtureReady.port } }],
        evidence: { tempRegistryReads: 0, filesystemLocksCreated: 0 },
      },
    });

    const rsid = "0197a3c2-0000-7000-8000-000000000301";
    const invocation = mutationInvoke({ rsid, seq: 1 });
    const attached = await bridgeChannel.send(control("attach", "attach_fixture_session", {
      probeIndex: 0,
      rsid,
      resumeToken: "fixture-resume-token",
      resumeExpiresAt: "2026-07-23T00:00:00.000Z",
      userHint: "fixture-user",
      hostname: "fixture-host",
      fingerprint: `sha256:${"0".repeat(64)}`,
      bridgeVersion: "0.0.0",
    }));
    expect(attached).toMatchObject({ ok: true, result: { attached: true, rsid } });

    await expect(bridgeChannel.send(control("crash-plan", "inject_crash", {
      point: "after_addin_response_before_terminal",
    }))).resolves.toMatchObject({ ok: true, result: { queued: true } });
    await expect(bridgeChannel.send(control("invoke-crash", "invoke_local", {
      envelope: invocation,
    }))).resolves.toMatchObject({
      ok: true,
      result: { crashed: true, point: "after_addin_response_before_terminal" },
    });

    const beforeRestart = await collectSnapshot(bridgeChannel, "evidence-before");
    expect(beforeRestart.flatMap((page) => page.invocations as JsonObject[])).toContainEqual(
      expect.objectContaining({
        rsid,
        invocationId: invocation.payload.invocation_id,
        state: "executing",
        dispatchMayHaveStarted: true,
      }),
    );
    expect(beforeRestart[0]).not.toHaveProperty("passed");
    expect(beforeRestart[0]).not.toHaveProperty("run_case");

    await expect(bridgeChannel.send(control("restart", "restart_simulator"))).resolves.toMatchObject({
      ok: true,
      result: {
        restarted: true,
        restoredSessionCount: 1,
        indeterminateInvocationCount: 1,
        previousCrashPoint: "after_addin_response_before_terminal",
        transportOpen: false,
      },
    });
    await expect(bridgeChannel.send(control("redelivery", "invoke_local", {
      envelope: invocation,
    }))).resolves.toMatchObject({
      ok: true,
      result: {
        crashed: false,
        outcome: {
          kind: "error",
          faultClass: "journal_indeterminate",
          verificationRequired: true,
          addinContacted: false,
        },
      },
    });

    const afterRestart = await collectSnapshot(bridgeChannel, "evidence-after");
    expect(afterRestart.flatMap((page) => page.invocations as JsonObject[])).toContainEqual(
      expect.objectContaining({ state: "indeterminate", verificationHoldId: expect.any(String) }),
    );
    expect(afterRestart.flatMap((page) => page.holds as JsonObject[])).toHaveLength(1);

    const shutdown = await bridgeChannel.send(control("bridge-shutdown", "shutdown"));
    expect(shutdown).toMatchObject({
      ok: true,
      result: {
        stopped: true,
        openLoopbackClientCount: 0,
        transportOpen: false,
        runLoopActive: false,
        journalClosed: true,
        pendingControlCount: 0,
        activeEvidenceSnapshotCount: 0,
      },
    });
    await once(bridge, "exit");
    expect(bridge.exitCode).toBe(0);

    await expect(fixtureChannel.send(control("fixture-shutdown", "shutdown"))).resolves.toMatchObject({
      ok: true,
      result: { stopped: true, openSocketCount: 0, pendingStallCount: 0 },
    });
    await once(fixture, "exit");
    expect(fixture.exitCode).toBe(0);
  }, 30_000);
});
