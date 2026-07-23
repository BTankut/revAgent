import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type {
  CaseStackSupervisor,
  GatewayStartupOverrides,
  ParentCaptureSummary,
} from "./caseStackSupervisor.js";
import type {
  ParentStepDriver,
  ParentStepDriverRequest,
  ParentStepDrivers,
  RawStepOutcome,
} from "./parentStepEngine.js";
import type { JsonObject, JsonValue } from "./processHarness.js";
import type {
  ComponentId,
  ProcessObservationRecord,
} from "./types.js";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function observation(
  request: ParentStepDriverRequest,
  componentId: ComponentId,
  kind: ProcessObservationRecord["kind"],
  suffix: string,
  payload: JsonObject,
): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${request.runId}:${request.caseId}:${request.binding}:${request.stepId}:${componentId}:${suffix}`,
    runId: request.runId,
    caseId: request.caseId,
    binding: request.binding,
    componentId,
    kind,
    at: new Date().toISOString(),
    payload,
  };
}

function snapshotPayload(
  request: ParentStepDriverRequest,
  schemaVersion: string,
  source: JsonObject,
): JsonObject {
  const rawSchemaVersion = source.schemaVersion ?? source.evidenceVersion ?? null;
  return {
    ...structuredClone(source),
    schemaVersion,
    sourceSchemaVersion: rawSchemaVersion,
    stepId: request.stepId,
    action: request.action,
  };
}

function fixtureCountPayload(request: ParentStepDriverRequest, snapshot: JsonObject): JsonObject {
  return {
    schemaVersion: "rbp-fixture-execution-count-observation/v1",
    stepId: request.stepId,
    action: request.action,
    executionCounts: Array.isArray(snapshot.executionCounts)
      ? structuredClone(snapshot.executionCounts)
      : [],
    methodExecutionCounts: Array.isArray(snapshot.methodExecutionCounts)
      ? structuredClone(snapshot.methodExecutionCounts)
      : [],
  };
}

function captureFrame(summary: ParentCaptureSummary): JsonObject {
  const serialized = JSON.stringify(summary);
  return {
    kind: "parent_tcp_capture_summary",
    bytes: summary.clientToTarget.bytes + summary.targetToClient.bytes,
    sha256: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    semanticDecoded: false,
    controlPlaneOnly: false,
    acceptedConnections: summary.acceptedConnections,
    activeConnections: summary.activeConnections,
    clientToTarget: summary.clientToTarget,
    targetToClient: summary.targetToClient,
  };
}

function wireObservation(
  request: ParentStepDriverRequest,
  componentId: ComponentId,
  capture: ParentCaptureSummary | { gateway: ParentCaptureSummary; fixture: ParentCaptureSummary },
): ProcessObservationRecord {
  const isComposite = "gateway" in capture;
  const frame = isComposite
    ? {
        kind: "parent_tcp_capture_composite",
        gateway: captureFrame(capture.gateway),
        fixture: captureFrame(capture.fixture),
        semanticDecoded: false,
        controlPlaneOnly: false,
      }
    : captureFrame(capture);
  const atMonotonicMs = isComposite
    ? Math.max(capture.gateway.finishedAtMonotonicMs, capture.fixture.finishedAtMonotonicMs)
    : capture.finishedAtMonotonicMs;
  return observation(request, componentId, "wire_event", "wire", {
    schemaVersion: "rbp-parent-wire-capture/v1",
    stepId: request.stepId,
    action: request.action,
    direction: componentId === "gateway_stub"
      ? "bridge_to_gateway_and_response"
      : componentId === "addin_loopback_fixture"
        ? "bridge_to_addin_loopback_fixture_and_response"
        : "bridge_bidirectional_transport",
    binding: request.binding,
    serialized: "bounded_length_and_sha256",
    frame,
    atMonotonicMs,
  });
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, label));
  if (!isObject(value)) throw new Error(`${label} is not a JSON value`);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, `${label}.${key}`)]),
  );
}

function gatewayOverrides(argumentsValue: JsonObject): GatewayStartupOverrides | undefined {
  const value = argumentsValue.startupOverrides;
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error("restart_case_stack startupOverrides must be an object");
  const strings = (field: string): string[] | undefined => {
    const entries = value[field];
    if (entries === undefined) return undefined;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new Error(`restart_case_stack startupOverrides.${field} must be a string array`);
    }
    return [...entries] as string[];
  };
  const protocols = value.supportedProtocols;
  if (protocols !== undefined && (
    !Array.isArray(protocols) ||
    protocols.some((entry) => !Number.isSafeInteger(entry) || Number(entry) < 1)
  )) {
    throw new Error("restart_case_stack startupOverrides.supportedProtocols must be positive integers");
  }
  return {
    sessionCapabilities: strings("sessionCapabilities"),
    connectionCapabilities: strings("connectionCapabilities"),
    supportedProtocols: protocols === undefined ? undefined : protocols.map(Number),
  };
}

function asSuccess(result: unknown, observations?: ProcessObservationRecord[]): RawStepOutcome {
  return {
    kind: "success",
    result: jsonValue(result, "driver result"),
    ...(observations === undefined || observations.length === 0 ? {} : { observations }),
  };
}

function deadlineTimeout(request: ParentStepDriverRequest): number {
  return Math.max(1, request.deadlineAtMs - Date.now());
}

function linuxMetrics(pid: number): { residentBytes: number; descriptorCount: number } {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const resident = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
  if (resident === null) throw new Error(`process ${pid} does not expose VmRSS`);
  return {
    residentBytes: Number(resident[1]) * 1024,
    descriptorCount: readdirSync(`/proc/${pid}/fd`).length,
  };
}

function windowsMetrics(pids: readonly number[]): Map<number, { residentBytes: number; descriptorCount: number }> {
  const literal = pids.join(",");
  const script = [
    `$ids=@(${literal})`,
    "$rows=Get-Process -Id $ids -ErrorAction Stop | Select-Object Id,WorkingSet64,Handles",
    "$rows | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Windows process sampling failed: ${String(result.stderr).trim()}`);
  }
  const parsed = JSON.parse(String(result.stdout)) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const metrics = new Map<number, { residentBytes: number; descriptorCount: number }>();
  for (const row of rows) {
    if (!isObject(row) || !Number.isSafeInteger(row.Id) ||
      !Number.isSafeInteger(row.WorkingSet64) || !Number.isSafeInteger(row.Handles)) {
      throw new Error("Windows process sampling returned malformed rows");
    }
    metrics.set(Number(row.Id), {
      residentBytes: Number(row.WorkingSet64),
      descriptorCount: Number(row.Handles),
    });
  }
  return metrics;
}

function processMetrics(pids: readonly number[]): Map<number, { residentBytes: number; descriptorCount: number }> {
  if (process.platform === "win32") return windowsMetrics(pids);
  if (process.platform === "linux" && existsSync("/proc/self/status")) {
    return new Map(pids.map((pid) => [pid, linuxMetrics(pid)]));
  }
  throw new Error(`process resource sampling is unsupported on ${process.platform}`);
}

function pendingJournalCount(snapshot: JsonObject): number {
  const invocations = Array.isArray(snapshot.invocations) ? snapshot.invocations : [];
  return invocations.filter((entry) =>
    isObject(entry) && entry.state !== "completed" && entry.state !== "failed" && entry.state !== "guarded").length;
}

function createGatewayDriver(supervisor: CaseStackSupervisor): ParentStepDriver {
  return async (request) => {
    const result = await supervisor.gatewayControl(request.action, request.arguments);
    const observations = request.action === "snapshot" && isObject(result)
      ? [observation(
          request,
          "gateway_stub",
          "gateway_snapshot",
          "snapshot",
          snapshotPayload(request, "rbp-gateway-snapshot-observation/v1", result),
        )]
      : [];
    return asSuccess(result, observations);
  };
}

function createBridgeDriver(supervisor: CaseStackSupervisor): ParentStepDriver {
  return async (request) => {
    const result = request.action === "snapshot_evidence"
      ? await supervisor.aggregateSnapshot("bridge_simulator")
      : await supervisor.jsonlControl(
          "bridge_simulator",
          request.action,
          request.arguments,
          deadlineTimeout(request),
        );
    const observations = request.action === "snapshot_evidence" && isObject(result)
      ? [observation(
          request,
          "bridge_simulator",
          "bridge_snapshot",
          "snapshot",
          snapshotPayload(request, "rbp-bridge-snapshot-observation/v1", result),
        )]
      : [];
    return asSuccess(result, observations);
  };
}

function createFixtureDriver(supervisor: CaseStackSupervisor): ParentStepDriver {
  return async (request) => {
    const result = request.action === "snapshot_evidence"
      ? await supervisor.aggregateSnapshot("addin_loopback_fixture")
      : await supervisor.jsonlControl(
          "addin_loopback_fixture",
          request.action,
          request.arguments,
          deadlineTimeout(request),
        );
    const observations = request.action === "snapshot_evidence" && isObject(result)
      ? [
          observation(
            request,
            "addin_loopback_fixture",
            "fixture_snapshot",
            "snapshot",
            snapshotPayload(request, "rbp-fixture-snapshot-observation/v1", result),
          ),
          observation(
            request,
            "addin_loopback_fixture",
            "fixture_execution_count",
            "counts",
            fixtureCountPayload(request, result),
          ),
        ]
      : [];
    return asSuccess(result, observations);
  };
}

function conditionObservation(
  request: ParentStepDriverRequest,
  result: JsonObject,
): ProcessObservationRecord[] {
  const snapshot = result.snapshot;
  if (!isObject(snapshot)) return [];
  const payload = snapshotPayload(request, "rbp-await-condition-snapshot-observation/v1", snapshot);
  if (request.arguments.source === "bridge.snapshot_evidence" ||
    request.arguments.source === "bridge_reconnect_schedule") {
    return [observation(request, "bridge_simulator", "bridge_snapshot", "await", payload)];
  }
  if (request.arguments.source === "fixture.snapshot_evidence") {
    return [
      observation(request, "addin_loopback_fixture", "fixture_snapshot", "await", payload),
      observation(
        request,
        "addin_loopback_fixture",
        "fixture_execution_count",
        "await-counts",
        fixtureCountPayload(request, snapshot),
      ),
    ];
  }
  if (request.arguments.source === "gateway.snapshot") {
    return [observation(request, "gateway_stub", "gateway_snapshot", "await", payload)];
  }
  return [];
}

function createHarnessDriver(supervisor: CaseStackSupervisor): ParentStepDriver {
  return async (request) => {
    switch (request.action) {
      case "restart_case_stack": {
        const restarted = await supervisor.restartCaseStack({
          caseId: String(request.arguments.caseId),
          binding: request.binding,
          preserveState: request.arguments.preserveState === true,
          startupOverrides: gatewayOverrides(request.arguments),
        }, request.stepId, request.action);
        return asSuccess(restarted.result, restarted.observations);
      }
      case "stop_case_stack": {
        const stopped = await supervisor.stopCaseStack(request.stepId, request.action);
        return asSuccess(stopped.result, stopped.observations);
      }
      case "begin_wire_capture":
        return asSuccess(supervisor.beginWireCapture());
      case "end_wire_capture": {
        const capture = supervisor.wireCapture();
        return asSuccess(
          { captureComplete: true, gateway: capture.gateway, fixture: capture.fixture },
          [
            wireObservation(request, "gateway_stub", capture.gateway),
            wireObservation(request, "bridge_simulator", capture),
            wireObservation(request, "addin_loopback_fixture", capture.fixture),
          ],
        );
      }
      case "await_condition": {
        const timeoutMs = Number(request.arguments.timeoutMs);
        const result = await supervisor.awaitCondition({
          source: String(request.arguments.source),
          jsonPointer: String(request.arguments.jsonPointer),
          operator: String(request.arguments.operator),
          ...(request.arguments.expected === undefined
            ? {}
            : { expected: request.arguments.expected }),
          timeoutMs,
        });
        return asSuccess(result, conditionObservation(request, result));
      }
      case "capture_resource_sample": {
        const components = ([
          "gateway_stub",
          "bridge_simulator",
          "addin_loopback_fixture",
        ] as const).map((componentId) => supervisor.component(componentId));
        const metrics = processMetrics(components.map(({ pid }) => pid));
        const bridge = await supervisor.aggregateSnapshot("bridge_simulator");
        const observations = components.map((component) => {
          const sample = metrics.get(component.pid);
          if (sample === undefined) throw new Error(`resource sample is missing process ${component.pid}`);
          return observation(request, component.componentId, "resource_sample", component.componentId, {
            schemaVersion: "rbp-parent-resource-sample/v1",
            stepId: request.stepId,
            action: request.action,
            pid: component.pid,
            residentBytes: sample.residentBytes,
            openFileDescriptorCount: sample.descriptorCount,
            journalPendingCount: pendingJournalCount(bridge),
          });
        });
        return asSuccess({
          sampledPids: components.map(({ pid }) => pid),
          sampleCount: observations.length,
        }, observations);
      }
      case "send_binding_frame":
        throw new Error(
          "unsupported_raw_binding_driver: parent-observed remoteOutcome is required before raw binding injection",
        );
      case "restart_component":
        throw new Error("restart_component is not implemented by the first production-driver slice");
      case "send_fixture_frame":
      case "send_split_fixture_frame":
      case "send_coalesced_fixture_frames":
      case "spawn_fixture_bind_probe":
        throw new Error(`${request.action} is not implemented by the first production-driver slice`);
    }
    throw new Error(`unsupported parent harness action: ${String(request.action)}`);
  };
}

export function createProductionCaseDrivers(supervisor: CaseStackSupervisor): ParentStepDrivers {
  return {
    gateway_http_control: createGatewayDriver(supervisor),
    bridge_jsonl_control: createBridgeDriver(supervisor),
    fixture_jsonl_control: createFixtureDriver(supervisor),
    parent_harness: createHarnessDriver(supervisor),
    abortAndDrain: async () => {
      if (supervisor.active) {
        await supervisor.stopCaseStack("abort-and-drain", "abort_and_drain");
      }
    },
  };
}
