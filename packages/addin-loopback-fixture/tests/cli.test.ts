import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_RESPONSE_PAYLOAD_BYTES,
  MAX_CONTROL_LINE_BYTES,
  connectFixture,
  encodeJsonFrame,
  fixtureRequest,
  type JsonObject,
} from "../src/index.js";
import { DIGEST, request, uuid7 } from "./helpers.js";

interface CliReady extends JsonObject {
  ready: true;
  contract: "addin-loopback/v1";
  controlVersion: 1;
  maxControlLineBytes: number;
  actions: string[];
  host: string;
  port: number;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(packageRoot, "dist", "cli.js");

class JsonLineChannel {
  #buffer = Buffer.alloc(0);
  readonly #queued: { value: JsonObject; bytes: number }[] = [];
  readonly #waiters: {
    resolve: (entry: { value: JsonObject; bytes: number }) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }[] = [];

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.#consume(chunk));
    child.once("exit", (code, signal) => {
      const error = new Error(
        `CLI exited with pending JSONL reader: code=${String(code)} signal=${String(signal)}`,
      );
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    });
  }

  public get queuedCount(): number {
    return this.#queued.length;
  }

  public async next(timeoutMs = 5_000): Promise<{ value: JsonObject; bytes: number }> {
    const queued = this.#queued.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#waiters.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("Timed out waiting for CLI JSONL record"));
      }, timeoutMs);
      this.#waiters.push({ resolve, reject, timeout });
    });
  }

  public async send(record: JsonObject): Promise<{ value: JsonObject; bytes: number }> {
    const expectedId = String(record.id);
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
    const response = await this.next();
    expect(response.value.id).toBe(expectedId);
    return response;
  }

  public async sendRaw(line: Buffer): Promise<{ value: JsonObject; bytes: number }> {
    this.child.stdin.write(line);
    return this.next();
  }

  #consume(chunk: Buffer): void {
    this.#buffer =
      this.#buffer.byteLength === 0
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
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.resolve(entry);
      } else {
        this.#queued.push(entry);
      }
      newline = this.#buffer.indexOf(0x0a);
    }
  }
}

async function startCli(host = "127.0.0.1"): Promise<{
  child: ChildProcessWithoutNullStreams;
  ready: CliReady;
  channel: JsonLineChannel;
  stderr: () => string;
}> {
  const child = spawn(process.execPath, [cliPath, "--host", host, "--port", "0"], {
    stdio: "pipe",
    windowsHide: true,
  });
  let errorText = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errorText += chunk.toString("utf8");
  });
  const channel = new JsonLineChannel(child);
  const readyEntry = await channel.next();
  return {
    child,
    ready: readyEntry.value as CliReady,
    channel,
    stderr: () => errorText,
  };
}

async function expectPortClosed(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    const connected = await new Promise<boolean>((resolveConnected) => {
      const socket = connect({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolveConnected(true);
      });
      socket.once("error", () => resolveConnected(false));
    });
    if (!connected) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`CLI listener ${host}:${port} remained reachable after shutdown`);
}

async function closeBytes(socket: Socket): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks)));
  });
}

function control(id: string, action: string, fields: JsonObject = {}): JsonObject {
  return { controlVersion: 1, id, action, ...fields };
}

describe("fixture CLI JSONL control and cleanup", () => {
  const children: ChildProcessWithoutNullStreams[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "closes its listener after %s",
    async (signal) => {
      const { child, ready, stderr } = await startCli();
      children.push(child);
      expect(ready).toMatchObject({
        ready: true,
        contract: "addin-loopback/v1",
        controlVersion: 1,
        maxControlLineBytes: MAX_CONTROL_LINE_BYTES,
      });
      expect(child.kill(signal)).toBe(true);
      const [code, exitSignal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];

      await expectPortClosed(ready.host, ready.port);
      expect(stderr()).toBe("");
      if (process.platform !== "win32") {
        expect(code).toBe(0);
        expect(exitSignal).toBeNull();
      }
    },
    10_000,
  );

  it("drives every bounded control mode and emits paged deterministic evidence", async () => {
    const { child, ready, channel, stderr } = await startCli();
    children.push(child);
    expect(ready.actions).toEqual([
      "plan_fault",
      "release_stall",
      "apply_document_context",
      "snapshot_evidence",
      "shutdown",
    ]);
    const address = { host: ready.host, port: ready.port };

    const duplicate = await channel.sendRaw(
      Buffer.from(
        '{"controlVersion":1,"id":"duplicate","action":"snapshot_evidence","action":"shutdown"}\n',
        "utf8",
      ),
    );
    expect(duplicate.value).toMatchObject({
      id: null,
      ok: false,
      error: { code: "control_duplicate_key" },
    });

    const oversize = await channel.sendRaw(
      Buffer.concat([Buffer.alloc(MAX_CONTROL_LINE_BYTES + 1, 0x78), Buffer.from("\n")]),
    );
    expect(oversize.value).toMatchObject({
      id: null,
      ok: false,
      error: { code: "control_line_too_large" },
    });

    await channel.send(
      control("ctl-context", "apply_document_context", {
        event: {
          capturedAtUtc: "2026-07-22T12:00:00.000Z",
          cacheState: "ready",
          unavailableReason: null,
          documents: [
            {
              documentId: "cli-document",
              title: "CLI Fixture",
              pathDigest: null,
              isWorkshared: false,
              isActive: true,
            },
          ],
          activeDocumentId: "cli-document",
          activeView: {
            documentId: "cli-document",
            id: "3001",
            name: "CLI View",
            type: "ThreeD",
            level: null,
          },
          disciplineHint: "mechanical",
        },
      }),
    );
    const contextSocket = await connectFixture(address);
    const contextResponse = await fixtureRequest(
      contextSocket,
      request(uuid7(500), "get_document_context"),
      16 * 1024 * 1024,
    );
    contextSocket.destroy();
    expect(contextResponse.result).toMatchObject({ revision: 2, activeDocumentId: "cli-document" });

    const busyId = uuid7(501);
    await channel.send(control("ctl-busy", "plan_fault", {
      requestId: busyId,
      fault: { busy: true },
    }));
    const busySocket = await connectFixture(address);
    const busy = await fixtureRequest(
      busySocket,
      request(busyId, "fixture_echo"),
      16 * 1024 * 1024,
    );
    busySocket.destroy();
    expect(busy.result).toMatchObject({ state: "guarded", guardedReason: "busy" });

    for (const [name, injectedOutcome, expected] of [
      [
        "guarded",
        { state: "guarded", guardedReason: "policy_guard" },
        { state: "guarded", guardedReason: "policy_guard" },
      ],
      [
        "failed",
        { state: "failed", error: { code: "revit_api", message: "injected failure" } },
        { state: "failed", error: { code: "revit_api" } },
      ],
    ] as const) {
      const requestId = uuid7(name === "guarded" ? 502 : 503);
      await channel.send(control(`ctl-${name}`, "plan_fault", {
        requestId,
        fault: { injectedOutcome },
      }));
      const socket = await connectFixture(address);
      const response = await fixtureRequest(
        socket,
        request(requestId, "fixture_echo"),
        16 * 1024 * 1024,
      );
      socket.destroy();
      expect(response.result).toMatchObject(expected);
    }

    const errorId = uuid7(504);
    await channel.send(control("ctl-error", "plan_fault", {
      requestId: errorId,
      fault: { jsonRpcError: { code: -32603, message: "injected JSON-RPC error" } },
    }));
    const errorSocket = await connectFixture(address);
    const errorResponse = await fixtureRequest(
      errorSocket,
      request(errorId, "fixture_echo"),
      16 * 1024 * 1024,
    );
    errorSocket.destroy();
    expect(errorResponse.error).toMatchObject({ code: -32603, message: "injected JSON-RPC error" });

    const delayedId = uuid7(505);
    await channel.send(control("ctl-delay", "plan_fault", {
      requestId: delayedId,
      fault: { delayMs: 25 },
    }));
    const delayedSocket = await connectFixture(address);
    const delayedAt = Date.now();
    await fixtureRequest(
      delayedSocket,
      request(delayedId, "fixture_echo"),
      16 * 1024 * 1024,
    );
    delayedSocket.destroy();
    expect(Date.now() - delayedAt).toBeGreaterThanOrEqual(20);

    const stalledId = uuid7(506);
    await channel.send(control("ctl-stall", "plan_fault", {
      requestId: stalledId,
      fault: { stall: true },
    }));
    const stalledSocket = await connectFixture(address);
    const stalledResponse = fixtureRequest(
      stalledSocket,
      request(stalledId, "fixture_echo"),
      16 * 1024 * 1024,
    );
    let released = false;
    for (let attempt = 0; attempt < 50 && !released; attempt += 1) {
      const release = await channel.send(
        control(`ctl-release-${attempt}`, "release_stall", { requestId: stalledId }),
      );
      released = (release.value.result as JsonObject).released === true;
      if (!released) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    expect(released).toBe(true);
    await stalledResponse;
    stalledSocket.destroy();

    const batchId = uuid7(507);
    const stepId = uuid7(508);
    await channel.send(control("ctl-rollback", "plan_fault", {
      requestId: batchId,
      fault: { rollbackFailure: true },
    }));
    await channel.send(control("ctl-batch-guard", "plan_fault", {
      requestId: stepId,
      fault: { injectedOutcome: { state: "guarded", guardedReason: "protected_view" } },
    }));
    const batchSocket = await connectFixture(address);
    const batchResponse = await fixtureRequest(
      batchSocket,
      request(batchId, "execute_batch", {
        batchContractVersion: 1,
        batchId,
        batchDigest: DIGEST,
        atomic: true,
        rollbackPolicy: "rollback_on_non_success",
        maxAggregateResultBytes: MAX_RESPONSE_PAYLOAD_BYTES,
        steps: [
          {
            index: 0,
            invocationId: stepId,
            method: "get_ui_state",
            params: {},
            paramsDigest: DIGEST,
            effect: "read_only",
          },
        ],
      }),
      16 * 1024 * 1024,
    );
    batchSocket.destroy();
    expect(batchResponse.result).toMatchObject({
      status: "indeterminate",
      transactionState: "indeterminate",
      rollback: { attempted: true, succeeded: false, error: { code: "rollback_failure" } },
    });

    for (const [suffix, fault, expectedBytes] of [
      [509, { disconnect: "before_dispatch" }, 0],
      [510, { disconnect: "after_dispatch" }, 0],
      [511, { disconnect: "after_response_bytes", afterResponseBytes: 8 }, 8],
    ] as const) {
      const requestId = uuid7(suffix);
      await channel.send(control(`ctl-disconnect-${suffix}`, "plan_fault", {
        requestId,
        fault,
      }));
      const socket = await connectFixture(address);
      const closed = closeBytes(socket);
      socket.write(encodeJsonFrame(request(requestId, "fixture_echo"), 16 * 1024 * 1024));
      expect((await closed).byteLength).toBe(expectedBytes);
    }

    const evidenceEntry = await channel.send(control("evidence-1", "snapshot_evidence"));
    const evidence = evidenceEntry.value.result as JsonObject;
    expect(evidenceEntry.bytes).toBeLessThanOrEqual(MAX_CONTROL_LINE_BYTES);
    expect(evidence).toMatchObject({
      snapshotId: "evidence-1",
      evidenceVersion: 1,
      fixtureContract: "addin-loopback/v1",
      modelStateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      modelStateEntryCount: 0,
      pendingStalls: [],
    });
    const evidencePages: JsonObject[] = [evidence];
    let currentPage = evidence;
    let pageNumber = 1;
    while (currentPage.complete !== true) {
      const continuation = await channel.send(
        control(`evidence-page-${pageNumber}`, "snapshot_evidence", {
          snapshotId: "evidence-1",
          cursor: currentPage.nextCursor as JsonObject,
        }),
      );
      expect(continuation.bytes).toBeLessThanOrEqual(MAX_CONTROL_LINE_BYTES);
      currentPage = continuation.value.result as JsonObject;
      evidencePages.push(currentPage);
      pageNumber += 1;
    }
    const observations = evidencePages.flatMap(
      (page) => page.observations as JsonObject[],
    );
    expect(observations.map((entry) => Number(entry.sequence))).toEqual(
      [...observations].map((entry) => Number(entry.sequence)).sort((left, right) => left - right),
    );
    expect(new Set(observations.map((entry) => Number(entry.sequence))).size).toBe(
      observations.length,
    );
    const requestCounts = evidencePages.flatMap(
      (page) => page.executionCounts as JsonObject[],
    );
    expect(requestCounts).toContainEqual(expect.objectContaining({ requestId: busyId, count: 1 }));
    expect(evidence).not.toHaveProperty("modelState");
    expect(JSON.stringify(evidencePages)).not.toContain("view:");

    const crashId = uuid7(512);
    await channel.send(control("ctl-crash", "plan_fault", {
      requestId: crashId,
      fault: { crash: "after_dispatch", delayMs: 10 },
    }));
    const crashSocket = await connectFixture(address);
    const crashed = closeBytes(crashSocket);
    crashSocket.write(encodeJsonFrame(request(crashId, "fixture_echo"), 16 * 1024 * 1024));
    await crashed;

    const shutdown = await channel.send(control("ctl-shutdown", "shutdown"));
    expect(shutdown.value).toMatchObject({
      id: "ctl-shutdown",
      ok: true,
      result: { stopped: true, openSocketCount: 0, pendingStallCount: 0 },
    });
    const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);
    expect(signal).toBeNull();
    expect(channel.queuedCount).toBe(0);
    expect(stderr()).toBe("");
    await expectPortClosed(ready.host, ready.port);
  }, 30_000);
});
