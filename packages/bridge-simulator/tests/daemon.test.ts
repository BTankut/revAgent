import { Buffer } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { atomicBatch, mutationInvoke, readInvoke, uuid } from "./helpers.js";

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

function child(
  script: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const inheritedEnvironment = { ...process.env };
  delete inheritedEnvironment.REVAGENT_BRIDGE_STATE_ROOT;
  return spawn(process.execPath, [script, ...args], {
    cwd: packageRoot,
    env: { ...inheritedEnvironment, ...environment },
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
const stateRoots: string[] = [];

afterEach(async () => {
  for (const processHandle of children.splice(0)) {
    if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill();
    if (processHandle.exitCode === null && processHandle.signalCode === null) {
      await once(processHandle, "exit").catch(() => undefined);
    }
  }
  for (const stateRoot of stateRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("long-lived Bridge JSONL daemon", () => {
  it("removes its temporary state root after SIGTERM, including forced Windows termination", async () => {
    const bridge = child(bridgeCli, ["daemon"]);
    children.push(bridge);
    const channel = new JsonLineReader(bridge);
    const ready = await channel.next();
    expect(ready).toMatchObject({
      ready: true,
      preserveState: false,
      stateRootSource: "temporary",
    });
    const stateRoot = String(ready.stateRoot);
    stateRoots.push(stateRoot);
    expect(existsSync(stateRoot)).toBe(true);

    const exited = once(bridge, "exit");
    expect(bridge.kill("SIGTERM")).toBe(true);
    await exited;
    const deadline = Date.now() + 10_000;
    while (existsSync(stateRoot) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(stateRoot)).toBe(false);
  }, 15_000);

  it("exposes granular controls, durable restart evidence, and leak-free shutdown", async () => {
    const fixture = child(fixtureCli, ["--port", "0"]);
    children.push(fixture);
    const fixtureChannel = new JsonLineReader(fixture);
    const fixtureReady = await fixtureChannel.next();
    expect(fixtureReady).toMatchObject({ ready: true, contract: "addin-loopback/v1" });

    const stateRoot = mkdtempSync(join(tmpdir(), "bridge-daemon-state-"));
    stateRoots.push(stateRoot);
    const bridge = child(bridgeCli, ["daemon", "--state-root", stateRoot]);
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
      stateRoot,
      preserveState: true,
      stateRootSource: "argument",
      transportTrust: {
        loopbackTestTlsPolicy: "loopback_test_tls",
        caIdentity: "absolute_path_and_exact_byte_sha256",
        serverIdentity: "leaf_der_sha256",
        numericLoopbackOnly: true,
        rejectUnauthorized: true,
      },
    });
    expect(ready.actions).toEqual([
      "discover_fixture",
      "attach_fixture_session",
      "open_transport",
      "start_run_loop",
      "session_register",
      "session_resume",
      "session_unregister",
      "prime_sequence_for_conformance",
      "send_heartbeat_for_conformance",
      "renew_exhausted_session",
      "tick",
      "poll_document_context",
      "flush_outbound",
      "invoke_local",
      "read_journal_record_for_conformance",
      "record_verification_attempt",
      "record_late_evidence",
      "resolve_hold",
      "clearance_for_hold",
      "inject_crash",
      "restart_simulator",
      "configure_reconnect_conformance",
      "advance_reconnect_conformance_clock",
      "send_chunk_conformance",
      "snapshot_soak_status",
      "snapshot_evidence",
      "shutdown",
    ]);

    await expect(bridgeChannel.send(control("soak-status", "snapshot_soak_status")))
      .resolves.toMatchObject({
        id: "soak-status",
        ok: true,
        result: {
          schemaVersion: "bridge-simulator-soak-status/v1",
          journalPendingCount: 0,
          peer: null,
        },
      });

    bridge.stdin.write(
      '{"controlVersion":1,"id":"duplicate","action":"snapshot_evidence","action":"shutdown"}\n',
    );
    await expect(bridgeChannel.next()).resolves.toMatchObject({
      id: null,
      ok: false,
      error: { code: "control_duplicate_key" },
    });

    await expect(bridgeChannel.send(control("invalid-endpoint-policy", "open_transport", {
      kind: "wss",
      deviceToken: "fixture-device-token",
      wssUrl: "wss://gateway.example.invalid/bridge/v1",
      endpointPolicy: "production",
      hello: {
        id: "fixture-hello",
        ts: "2026-07-22T00:00:00.000Z",
        bridgeVersion: "0.0.0",
        deviceId: "fixture-device",
        hostname: "fixture-host",
        os: "fixture-os",
      },
    }))).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_control_request",
        message: "endpointPolicy must equal loopback_test_readiness or loopback_test_tls when supplied",
      },
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
    const invocation = mutationInvoke({ rsid, seq: 2 });
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

    const batch = atomicBatch(rsid, 1);
    await expect(bridgeChannel.send(control("batch-crash", "invoke_local", {
      envelope: batch,
      crashAt: "after_received_before_dispatch",
    }))).resolves.toMatchObject({
      ok: true,
      result: { crashed: true, point: "after_received_before_dispatch" },
    });
    await expect(bridgeChannel.send(control("batch-restart", "restart_simulator"))).resolves.toMatchObject({
      ok: true,
      result: {
        restarted: true,
        restoredSessionCount: 1,
        previousCrashPoint: "after_received_before_dispatch",
      },
    });

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
    const invocationRedelivery = { ...invocation, id: uuid(), seq: 3 };
    await expect(bridgeChannel.send(control("redelivery", "invoke_local", {
      envelope: invocationRedelivery,
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
    const holds = afterRestart.flatMap((page) => page.holds as JsonObject[]);
    expect(holds).toHaveLength(1);
    const holdId = String(holds[0]?.holdId);

    const verificationBase = readInvoke({
      rsid,
      seq: 4,
      method: "fixture_counter",
    });
    const verification = {
      ...verificationBase,
      payload: {
        ...verificationBase.payload,
        verification: {
          hold_id: holdId,
          mutation_scope: invocation.payload.mutation_scope,
          purpose: "resolve_indeterminate" as const,
        },
      },
    };
    const verificationResponse = await bridgeChannel.send(control("verification", "invoke_local", {
      envelope: verification,
    }));
    expect(verificationResponse).toMatchObject({ ok: true, result: { outcome: { kind: "result" } } });
    const verificationOutcome = (verificationResponse.result as JsonObject).outcome as JsonObject;
    const evidenceDigest = String(verificationOutcome.resultDigest);
    expect(evidenceDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    await expect(bridgeChannel.send(control("evidence-extra", "record_verification_attempt", {
      rsid,
      holdId,
      verificationInvocationId: verification.payload.invocation_id,
      evidenceDigest,
      conclusion: "non_execution_proven",
      atMs: 1_721_600_000_001,
      unexpected: true,
    }))).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_control_request", message: expect.stringContaining("Unknown control field") },
    });
    await expect(bridgeChannel.send(control("evidence", "record_verification_attempt", {
      rsid,
      holdId,
      verificationInvocationId: verification.payload.invocation_id,
      evidenceDigest,
      conclusion: "non_execution_proven",
      atMs: 1_721_600_000_001,
    }))).resolves.toMatchObject({
      ok: true,
      result: { recorded: true, hold: { holdId, state: "evidence_recorded" } },
    });
    const authorizedDispatchIdentity = `sha256:${"a".repeat(64)}`;
    await expect(bridgeChannel.send(control("resolve", "resolve_hold", {
      rsid,
      holdId,
      basis: "verification_read",
      verificationInvocationId: verification.payload.invocation_id,
      evidenceDigest,
      decision: "non_execution_proven",
      resolutionId: "0197a3c2-0000-7000-8000-000000000901",
      auditId: "0197a3c2-0000-7000-8000-000000000902",
      authorizedDispatchIdentity,
      atMs: 1_721_600_000_002,
    }))).resolves.toMatchObject({
      ok: true,
      result: { resolved: true, hold: { holdId, state: "resolved_pending_bridge" } },
    });
    await expect(bridgeChannel.send(control("clearance", "clearance_for_hold", {
      rsid,
      holdId,
    }))).resolves.toMatchObject({
      ok: true,
      result: {
        clearance: {
          hold_id: holdId,
          basis: "verification_read",
          evidence_digest: evidenceDigest,
          decision: "non_execution_proven",
        },
      },
    });

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
    expect(existsSync(join(stateRoot, "bridge.db"))).toBe(true);

    const restartedBridge = child(bridgeCli, ["daemon", "--state-root", stateRoot]);
    children.push(restartedBridge);
    const restartedChannel = new JsonLineReader(restartedBridge);
    await expect(restartedChannel.next()).resolves.toMatchObject({
      ready: true,
      stateRoot,
      preserveState: true,
    });
    const restartedEvidence = await collectSnapshot(restartedChannel, "process-restart-evidence");
    expect(restartedEvidence.flatMap((page) => page.invocations as JsonObject[])).toContainEqual(
      expect.objectContaining({ invocationId: invocation.payload.invocation_id, state: "indeterminate" }),
    );
    await expect(restartedChannel.send(control("restarted-shutdown", "shutdown"))).resolves.toMatchObject({
      ok: true,
      result: { journalClosed: true },
    });
    await once(restartedBridge, "exit");
    expect(restartedBridge.exitCode).toBe(0);
    expect(existsSync(stateRoot)).toBe(true);

    await expect(fixtureChannel.send(control("fixture-shutdown", "shutdown"))).resolves.toMatchObject({
      ok: true,
      result: { stopped: true, openSocketCount: 0, pendingStallCount: 0 },
    });
    await once(fixture, "exit");
    expect(fixture.exitCode).toBe(0);
  }, 30_000);

  it("removes its private temporary state root after stdin EOF", async () => {
    const bridge = child(bridgeCli, ["daemon"]);
    children.push(bridge);
    const bridgeChannel = new JsonLineReader(bridge);
    const ready = await bridgeChannel.next();
    expect(ready).toMatchObject({
      ready: true,
      preserveState: false,
      stateRootSource: "temporary",
    });
    const stateRoot = String(ready.stateRoot);
    expect(existsSync(stateRoot)).toBe(true);
    bridge.stdin.end();
    await once(bridge, "exit");
    expect(bridge.exitCode).toBe(0);
    expect(existsSync(stateRoot)).toBe(false);
  });

  it("accepts a bounded absolute persistent state root from the environment", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "bridge-daemon-env-state-"));
    stateRoots.push(stateRoot);
    const bridge = child(bridgeCli, ["daemon"], {
      REVAGENT_BRIDGE_STATE_ROOT: stateRoot,
    });
    children.push(bridge);
    const bridgeChannel = new JsonLineReader(bridge);
    await expect(bridgeChannel.next()).resolves.toMatchObject({
      ready: true,
      stateRoot,
      preserveState: true,
      stateRootSource: "environment",
    });
    await expect(bridgeChannel.send(control("environment-shutdown", "shutdown"))).resolves.toMatchObject({
      ok: true,
      result: { journalClosed: true },
    });
    await once(bridge, "exit");
    expect(bridge.exitCode).toBe(0);
    expect(existsSync(join(stateRoot, "bridge.db"))).toBe(true);
  });
});
