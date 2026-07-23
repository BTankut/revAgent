import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureCli = resolve(packageRoot, "..", "addin-loopback-fixture", "dist", "cli.js");
const bridgeCli = resolve(packageRoot, "dist", "cli.js");
const INVOCATION_ID = "0197a3c2-0000-7000-8000-000000000002";

interface JsonObject {
  [key: string]: unknown;
}

class JsonLineReader {
  #buffer = Buffer.alloc(0);
  readonly #queued: Array<{ readonly value: JsonObject; readonly bytes: number }> = [];
  readonly #waiters: Array<{
    readonly resolve: (entry: { readonly value: JsonObject; readonly bytes: number }) => void;
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

  public async next(timeoutMs = 5_000): Promise<{ readonly value: JsonObject; readonly bytes: number }> {
    const queued = this.#queued.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolveEntry, rejectEntry) => {
      const timeout = setTimeout(() => {
        const index = this.#waiters.findIndex((entry) => entry.resolve === resolveEntry);
        if (index >= 0) this.#waiters.splice(index, 1);
        rejectEntry(new Error("timed out waiting for JSONL record"));
      }, timeoutMs);
      this.#waiters.push({ resolve: resolveEntry, reject: rejectEntry, timeout });
    });
  }

  public async send(record: JsonObject): Promise<{ readonly value: JsonObject; readonly bytes: number }> {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
    const response = await this.next();
    expect(response.value.id).toBe(record.id);
    return response;
  }

  #consume(chunk: Buffer): void {
    this.#buffer = this.#buffer.byteLength === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.#buffer, chunk]);
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const entry = {
        value: JSON.parse(line.toString("utf8")) as JsonObject,
        bytes: line.byteLength + 1,
      };
      const waiter = this.#waiters.shift();
      if (waiter === undefined) this.#queued.push(entry);
      else {
        clearTimeout(waiter.timeout);
        waiter.resolve(entry);
      }
      newline = this.#buffer.indexOf(0x0a);
    }
  }
}

describe("three-process Bridge crash evidence", () => {
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });

  it("uses fixture JSONL control/evidence around a separate Bridge process", async () => {
    const fixture = spawn(process.execPath, [fixtureCli, "--host", "127.0.0.1", "--port", "0"], {
      stdio: "pipe",
      windowsHide: true,
    });
    children.push(fixture);
    let fixtureErrors = "";
    fixture.stderr.on("data", (chunk: Buffer) => { fixtureErrors += chunk.toString("utf8"); });
    const channel = new JsonLineReader(fixture);
    const ready = (await channel.next()).value;
    expect(ready).toMatchObject({
      ready: true,
      contract: "addin-loopback/v1",
      controlVersion: 1,
      host: "127.0.0.1",
    });
    const port = Number(ready.port);
    expect(Number.isInteger(port)).toBe(true);
    await channel.send({
      controlVersion: 1,
      id: "plan-bridge-mutation",
      action: "plan_fault",
      requestId: INVOCATION_ID,
      fault: { delayMs: 1 },
    });

    const bridge = spawn(process.execPath, [
      bridgeCli,
      "crash-recovery",
      "--fixture-host",
      "127.0.0.1",
      "--fixture-port",
      String(port),
    ], { stdio: "pipe", windowsHide: true });
    children.push(bridge);
    let bridgeOutput = "";
    let bridgeErrors = "";
    bridge.stdout.on("data", (chunk: Buffer) => { bridgeOutput += chunk.toString("utf8"); });
    bridge.stderr.on("data", (chunk: Buffer) => { bridgeErrors += chunk.toString("utf8"); });
    const [bridgeCode, bridgeSignal] = (await once(bridge, "exit")) as [number | null, NodeJS.Signals | null];
    expect({ bridgeCode, bridgeSignal, bridgeErrors }).toEqual({ bridgeCode: 0, bridgeSignal: null, bridgeErrors: "" });
    const bridgeEvidence = JSON.parse(bridgeOutput) as JsonObject;
    expect(bridgeEvidence).toMatchObject({
      scenario: "crash-recovery",
      externalFixture: true,
      crashPoint: "after_addin_response_before_terminal",
      addinExecutionCount: null,
      redelivery: {
        kind: "error",
        faultClass: "journal_indeterminate",
        outcome: "indeterminate",
        verificationRequired: true,
        addinContacted: false,
      },
      freshInvocationBlocked: true,
      unclearedHoldCount: 1,
      tempRegistryReads: 0,
      filesystemLocksCreated: 0,
    });

    const pages: JsonObject[] = [];
    let evidenceResponse = await channel.send({
      controlVersion: 1,
      id: "bridge-evidence",
      action: "snapshot_evidence",
    });
    expect(evidenceResponse.bytes).toBeLessThanOrEqual(64 * 1024);
    let page = evidenceResponse.value.result as JsonObject;
    pages.push(page);
    let pageNumber = 1;
    while (page.complete !== true) {
      evidenceResponse = await channel.send({
        controlVersion: 1,
        id: `bridge-evidence-page-${pageNumber}`,
        action: "snapshot_evidence",
        snapshotId: "bridge-evidence",
        cursor: page.nextCursor,
      });
      expect(evidenceResponse.bytes).toBeLessThanOrEqual(64 * 1024);
      page = evidenceResponse.value.result as JsonObject;
      pages.push(page);
      pageNumber += 1;
    }
    const requestCounts = pages.flatMap((entry) => entry.executionCounts as JsonObject[]);
    expect(requestCounts.filter((entry) => entry.requestId === INVOCATION_ID)).toEqual([
      { requestId: INVOCATION_ID, count: 1 },
    ]);
    expect(pages[0]).toMatchObject({
      evidenceVersion: 1,
      fixtureContract: "addin-loopback/v1",
      openSocketCount: 0,
      pendingStalls: [],
    });
    expect(JSON.stringify(pages)).not.toContain("modelState\":{");

    const shutdown = await channel.send({
      controlVersion: 1,
      id: "shutdown-fixture",
      action: "shutdown",
    });
    expect(shutdown.value).toMatchObject({
      ok: true,
      result: { stopped: true, openSocketCount: 0, pendingStallCount: 0 },
    });
    fixture.stdin.end();
    if (fixture.exitCode === null && fixture.signalCode === null) await once(fixture, "exit");
    expect(fixtureErrors).toBe("");
  }, 15_000);
});
