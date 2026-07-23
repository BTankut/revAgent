import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { CaseStackSupervisor } from "./caseStackSupervisor.js";
import { boundProductionPowerShellExecutable } from "./productionExecutionPlan.js";
import { sanitizedProductionRuntimeEnvironment } from "./productionRuntimeIdentity.js";
import type { ReconnectSoakAdapter, SoakCycleObservation } from "./soakRunner.js";
import type { JsonObject, JsonValue } from "./processHarness.js";
import type { Binding, ExecutionPlan, ResourceSample } from "./types.js";

const BINDINGS = ["wss", "streamable_http_sse"] as const;
const CLOCK_START_MS = Date.UTC(2026, 6, 23, 0, 0, 0);
const HEARTBEAT_STEP_MS = 16_000;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function helloId(binding: Binding, cycle: number): string {
  const slot = binding === "wss" ? cycle * 2 + 1 : cycle * 2 + 2;
  return `019f0b00-0000-7000-8000-${String(slot).padStart(12, "0")}`;
}

function pendingJournalCount(snapshot: JsonObject): number {
  const invocations = Array.isArray(snapshot.invocations) ? snapshot.invocations : [];
  return invocations.filter((entry) =>
    isObject(entry) &&
    entry.state !== "completed" &&
    entry.state !== "failed" &&
    entry.state !== "guarded").length;
}

function linuxMetric(pid: number): { residentBytes: number; descriptorCount: number } {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const resident = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
  if (resident === null) throw new Error(`process ${pid} does not expose VmRSS`);
  return {
    residentBytes: Number(resident[1]) * 1024,
    descriptorCount: readdirSync(`/proc/${pid}/fd`).length,
  };
}

export function sampleProductionSoakWindowsMetrics(
  pids: readonly number[],
  powershellExecutable: string,
): Map<number, { residentBytes: number; descriptorCount: number }> {
  const result = spawnSync(
    powershellExecutable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        `$ids=@(${pids.join(",")})`,
        "$rows=Get-Process -Id $ids -ErrorAction Stop | Select-Object Id,WorkingSet64,Handles",
        "$rows | ConvertTo-Json -Compress",
      ].join("; "),
    ],
    {
      encoding: "utf8",
      env: sanitizedProductionRuntimeEnvironment(),
      shell: false,
      windowsHide: true,
      timeout: 10_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Windows process sampling failed: ${String(result.stderr).trim()}`);
  }
  const parsed = JSON.parse(String(result.stdout)) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const metrics = new Map<number, { residentBytes: number; descriptorCount: number }>();
  for (const row of rows) {
    if (
      !isObject(row) ||
      !Number.isSafeInteger(row.Id) ||
      !Number.isSafeInteger(row.WorkingSet64) ||
      !Number.isSafeInteger(row.Handles)
    ) {
      throw new Error("Windows process sampling returned malformed rows");
    }
    metrics.set(Number(row.Id), {
      residentBytes: Number(row.WorkingSet64),
      descriptorCount: Number(row.Handles),
    });
  }
  return metrics;
}

function processMetrics(
  pids: readonly number[],
  plan: ExecutionPlan,
): Map<number, { residentBytes: number; descriptorCount: number }> {
  if (process.platform === "win32") {
    return sampleProductionSoakWindowsMetrics(
      pids,
      boundProductionPowerShellExecutable(plan),
    );
  }
  if (process.platform === "linux" && existsSync("/proc/self/status")) {
    return new Map(pids.map((pid) => [pid, linuxMetric(pid)]));
  }
  throw new Error(`process resource sampling is unsupported on ${process.platform}`);
}

function numeric(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

export class ProductionReconnectSoakAdapter implements ReconnectSoakAdapter {
  readonly #plan: ExecutionPlan;
  readonly #supervisors: ReadonlyMap<Binding, CaseStackSupervisor>;
  readonly #clockMs = new Map<Binding, number>();
  #closed = false;
  #orphanProcessCount = 0;

  private constructor(
    plan: ExecutionPlan,
    supervisors: ReadonlyMap<Binding, CaseStackSupervisor>,
  ) {
    this.#plan = plan;
    this.#supervisors = supervisors;
    for (const binding of BINDINGS) this.#clockMs.set(binding, CLOCK_START_MS);
  }

  static async create(input: {
    plan: ExecutionPlan;
    repoRoot: string;
    runtimeLaunchGuard?: (plan: ExecutionPlan, repoRoot: string) => void;
  }): Promise<ProductionReconnectSoakAdapter> {
    const supervisors = new Map<Binding, CaseStackSupervisor>();
    const adapter = new ProductionReconnectSoakAdapter(input.plan, supervisors);
    try {
      for (const binding of BINDINGS) {
        const supervisor = new CaseStackSupervisor({
          plan: input.plan,
          repoRoot: input.repoRoot,
          ...(input.runtimeLaunchGuard === undefined
            ? {}
            : { runtimeLaunchGuard: input.runtimeLaunchGuard }),
        });
        supervisors.set(binding, supervisor);
        await supervisor.restartCaseStack({
          caseId: `SOAK-${binding}`,
          binding,
          preserveState: false,
          startupOverrides: { clockStartMs: CLOCK_START_MS },
        }, `soak.${binding}.start`, "restart_case_stack");
        await adapter.#discoverAndOpen(binding, 0, true);
      }
      return adapter;
    } catch (error) {
      await adapter.close().catch(() => undefined);
      throw error;
    }
  }

  async churn(binding: Binding, cycle: number): Promise<SoakCycleObservation> {
    if (this.#closed) throw new Error("production soak adapter is closed");
    if (!Number.isSafeInteger(cycle) || cycle < 1) throw new Error("soak cycle must be one based");
    const supervisor = this.#supervisor(binding);
    supervisor.beginWireCapture();
    const pause = supervisor.setGatewayProxyBackpressure(true);
    let released = false;
    const nextClock = this.#clock(binding) + HEARTBEAT_STEP_MS;
    this.#clockMs.set(binding, nextClock);
    try {
      await supervisor.gatewayControl("set_clock", { now_ms: nextClock });
      const tick = supervisor.jsonlControl("bridge_simulator", "tick", { nowMs: nextClock });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      supervisor.setGatewayProxyBackpressure(false);
      released = true;
      await tick;
      await supervisor.awaitCondition({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/peer/lastHeartbeatAckAtMs",
        operator: "equals",
        expected: nextClock,
        timeoutMs: 5_000,
      });
    } finally {
      if (!released) supervisor.setGatewayProxyBackpressure(false);
    }
    const capture = supervisor.wireCapture().gateway;
    const restartedValue = await supervisor.jsonlControl(
      "bridge_simulator",
      "restart_simulator",
      {},
    );
    const restarted = isObject(restartedValue) ? restartedValue : {};
    const opened = await this.#discoverAndOpen(binding, cycle, false);
    const gatewaySnapshotValue = await supervisor.compactGatewaySnapshot();
    const bridgeSnapshot = await supervisor.aggregateSnapshot("bridge_simulator");
    const sessions = isObject(gatewaySnapshotValue.sessions)
      ? Object.keys(gatewaySnapshotValue.sessions)
      : [];
    const peer = isObject(bridgeSnapshot.peer) ? bridgeSnapshot.peer : {};
    const reconnects =
      numeric(restarted.restoredSessionCount, "restoredSessionCount") >= 1 &&
      opened.selectedKind === binding &&
      sessions.length >= 1 &&
      peer.runLoopActive === true
        ? 1
        : 0;
    const proxyBytes = capture.clientToTarget.bytes + capture.targetToClient.bytes;
    return {
      reconnects,
      proxyChurns: pause.activeConnections > 0 && proxyBytes > 0 ? 1 : 0,
      heartbeatAcks: peer.lastHeartbeatAckAtMs === nextClock ? 1 : 0,
      controlRoundTrips: 2,
      journalPending: pendingJournalCount(bridgeSnapshot),
    };
  }

  async sampleResources(): Promise<Omit<ResourceSample, "index" | "offsetMs">> {
    if (this.#closed) throw new Error("cannot sample a closed production soak adapter");
    const pids = [...this.#supervisors.values()].flatMap((supervisor) => supervisor.pids);
    if (pids.length !== 6 || new Set(pids).size !== 6) {
      throw new Error(`production soak requires exactly six live component PIDs, observed ${pids.length}`);
    }
    const metrics = processMetrics(pids, this.#plan);
    let residentBytes = 0;
    let openFileDescriptorCount = 0;
    for (const pid of pids) {
      const sample = metrics.get(pid);
      if (sample === undefined) throw new Error(`resource sample is missing PID ${pid}`);
      residentBytes += sample.residentBytes;
      openFileDescriptorCount += sample.descriptorCount;
    }
    const snapshots = await Promise.all([...this.#supervisors.values()].map(async (supervisor) =>
      await supervisor.aggregateSnapshot("bridge_simulator")));
    return {
      residentBytes,
      openFileDescriptorCount,
      journalPendingCount: snapshots.reduce((sum, snapshot) => sum + pendingJournalCount(snapshot), 0),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const errors: Error[] = [];
    for (const [binding, supervisor] of [...this.#supervisors].reverse()) {
      if (!supervisor.active) continue;
      try {
        const stopped = await supervisor.stopCaseStack(
          `soak.${binding}.stop`,
          "soak_cleanup",
        );
        this.#orphanProcessCount += numeric(
          stopped.result.orphanProcessCount,
          `${binding} orphanProcessCount`,
        );
      } catch (error) {
        this.#orphanProcessCount += 1;
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "production soak cleanup failed");
  }

  async orphanProcessCount(): Promise<number> {
    if (!this.#closed) throw new Error("orphan count is available only after production soak cleanup");
    return this.#orphanProcessCount;
  }

  #supervisor(binding: Binding): CaseStackSupervisor {
    const supervisor = this.#supervisors.get(binding);
    if (supervisor === undefined) throw new Error(`soak supervisor is missing ${binding}`);
    return supervisor;
  }

  #clock(binding: Binding): number {
    const value = this.#clockMs.get(binding);
    if (value === undefined) throw new Error(`soak clock is missing ${binding}`);
    return value;
  }

  async #discoverAndOpen(
    binding: Binding,
    cycle: number,
    register: boolean,
  ): Promise<JsonObject> {
    const supervisor = this.#supervisor(binding);
    const readiness = supervisor.readiness();
    if (register) {
      await supervisor.jsonlControl("bridge_simulator", "discover_fixture", {
        host: String(readiness.fixture.host),
        port: Number(readiness.fixture.port),
        probeTimeoutMs: 1_000,
      });
    }
    const hello = {
      id: helloId(binding, cycle),
      ts: new Date(this.#clock(binding)).toISOString(),
      bridgeVersion: "0.0.0",
      deviceId: "device-01",
      hostname: "conformance-soak",
      os: process.platform,
      fingerprint: `sha256:${"0".repeat(64)}`,
    } satisfies JsonObject;
    let openValue: JsonValue;
    if (binding === "wss") {
      const trust = isObject(readiness.gateway.tlsTrust) ? readiness.gateway.tlsTrust : {};
      openValue = await supervisor.jsonlControl("bridge_simulator", "open_transport", {
        kind: "wss",
        endpointPolicy: "loopback_test_tls",
        deviceToken: "test-device-token",
        wssUrl: String(readiness.gateway.ws_url),
        tlsTrust: {
          caCertificatePath: trust.caCertificatePath!,
          caCertificateSha256: trust.caCertificateSha256!,
          serverCertificateSha256: trust.serverCertificateSha256!,
        },
        clockStartMs: this.#clock(binding),
        hello,
      });
    } else {
      openValue = await supervisor.jsonlControl("bridge_simulator", "open_transport", {
        kind: "streamable_http_sse",
        endpointPolicy: "loopback_test_readiness",
        deviceToken: "test-device-token",
        fallbackUrl: String(readiness.gateway.http_connection_url),
        clockStartMs: this.#clock(binding),
        hello,
      });
    }
    if (!isObject(openValue)) throw new Error(`${binding} open_transport returned a non-object`);
    await supervisor.jsonlControl("bridge_simulator", "start_run_loop", {});
    if (register) {
      await supervisor.jsonlControl("bridge_simulator", "session_register", {
        probeIndex: 0,
        userHint: "conformance-soak",
        hostname: "conformance-soak",
        fingerprint: `sha256:${"0".repeat(64)}`,
        bridgeVersion: "0.0.0",
      });
      await supervisor.awaitCondition({
        source: "bridge.snapshot_evidence",
        jsonPointer: "/sessions/0/rsid",
        operator: "exists",
        timeoutMs: 5_000,
      });
    }
    await supervisor.awaitCondition({
      source: "bridge.snapshot_evidence",
      jsonPointer: "/peer/runLoopActive",
      operator: "equals",
      expected: true,
      timeoutMs: 5_000,
    });
    return openValue;
  }
}

export async function createProductionReconnectSoakAdapter(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  runtimeLaunchGuard?: (plan: ExecutionPlan, repoRoot: string) => void;
}): Promise<ProductionReconnectSoakAdapter> {
  return await ProductionReconnectSoakAdapter.create(input);
}
