import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { runReportToJUnitXml } from "./junit.js";
import { canonicalManifest } from "./manifest.js";
import { CaseObservationLedger, type ParentAssertionProbe } from "./observationLedger.js";
import {
  StrictJsonlProcess,
  StrictReadyProcess,
  type JsonObject,
  type JsonValue,
} from "./processHarness.js";
import {
  assertProductionRuntimeLaunchCurrent,
  canonicalProductionComponentVersion,
} from "./productionExecutionPlan.js";
import { createUnexecutedRunReport } from "./scaffold.js";
import { validateSchema } from "./schemas.js";
import { SecureEvidenceStore } from "./secureEvidenceStore.js";
import { sha256File } from "./executionPlan.js";
import { stableJson } from "./stableJson.js";
import type {
  ArtifactEvidence,
  Binding,
  ComponentId,
  ComponentIdentity,
  EvidenceAssertionRecord,
  ExecutionPlan,
  PlannedComponent,
  ProcessCommandDescriptor,
  ProcessEvidence,
  ProcessObservationRecord,
  RunReport,
} from "./types.js";

const C19_ID = "O1-C19";
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;

type C19Vector = "big_endian" | "split_read" | "coalesced_read" | "former_8192";

interface StartedComponent {
  componentId: ComponentId;
  identity: ComponentIdentity;
  pid: number;
  process: ProcessEvidence;
  readiness: JsonObject;
  jsonl?: StrictJsonlProcess;
  stop(): Promise<void>;
}

interface FixtureCount {
  requestId: string;
  count: number;
}

interface BindingExecution {
  binding: Binding;
  observations: ProcessObservationRecord[];
  durationMs: number;
  error?: Error;
}

interface ExchangeCapture {
  requestIds: string[];
  payloadBytes: number[];
  requestHeaderHexes: string[];
  writeChunkSizes: number[];
  responseIds: string[];
  responsePayloadBytes: number[];
  responseHeaderHexes: string[];
}

export interface SupervisedC19RunInput {
  plan: ExecutionPlan;
  repoRoot: string;
  artifactRoot: string;
  seed: string;
  runtimeLaunchGuard?: (plan: ExecutionPlan, repoRoot: string) => void;
  instanceRootRemover?: (instanceRoot: string) => void;
}

export interface SupervisedC19RunResult {
  report: RunReport;
  reportPath: string;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} is not a safe integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function retained(relative: string): string {
  return `${canonicalManifest.retainedEvidence.root}/${relative}`;
}

async function artifact(
  store: SecureEvidenceStore,
  kind: ArtifactEvidence["kind"],
  relativePath: string,
  contents: string | Buffer,
  mediaType: string,
): Promise<ArtifactEvidence> {
  const bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return await store.writeAccepted(relativePath, bytes, (candidate) => candidate.acceptExact({ logicalPath: relativePath, absolutePath: store.resolve(relativePath), bytes, sha256 }, {
    kind,
    path: relativePath,
    sha256,
    bytes: bytes.length,
    mediaType,
  }));
}

function privateTempDirectory(runId: string, binding: Binding): string {
  const root = mkdtempSync(path.join(tmpdir(), `rbp-c19-${runId}-${binding}-`));
  chmodSync(root, PRIVATE_DIRECTORY_MODE);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error("supervised C19 instance root is not a plain directory");
  }
  return root;
}

function replaceTokens(value: string, tokens: Readonly<Record<string, string>>): string {
  return Object.entries(tokens).reduce(
    (result, [name, replacement]) => result.replaceAll(`{{${name}}}`, replacement),
    value,
  );
}

function expandedCommand(
  command: ProcessCommandDescriptor,
  tokens: Readonly<Record<string, string>>,
): ProcessCommandDescriptor {
  return {
    ...command,
    executable: replaceTokens(command.executable, tokens),
    args: command.args.map((entry) => replaceTokens(entry, tokens)),
    workingDirectory: replaceTokens(command.workingDirectory, tokens),
    environmentKeys: [...command.environmentKeys],
    readiness: { ...command.readiness, value: replaceTokens(command.readiness.value, tokens) },
    shutdown: { ...command.shutdown },
  };
}

function workingDirectory(repoRoot: string, command: ProcessCommandDescriptor): string {
  const root = path.resolve(repoRoot);
  const candidate = path.resolve(root, command.workingDirectory);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !existsSync(candidate) || !lstatSync(candidate).isDirectory()) {
    throw new Error(`component working directory escapes or is missing: ${command.workingDirectory}`);
  }
  return candidate;
}

function entrypointPath(command: ProcessCommandDescriptor, cwd: string): string {
  const argument = command.args.find((entry) => {
    const candidate = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    return existsSync(candidate) && lstatSync(candidate).isFile();
  });
  if (argument !== undefined) return path.isAbsolute(argument) ? argument : path.resolve(cwd, argument);
  const executable = path.isAbsolute(command.executable) ? command.executable : path.resolve(cwd, command.executable);
  if (existsSync(executable) && lstatSync(executable).isFile()) return executable;
  throw new Error("component command does not expose a hash-verifiable executable entrypoint");
}

function observedIdentity(component: PlannedComponent, command: ProcessCommandDescriptor, cwd: string): ComponentIdentity {
  const digest = sha256File(entrypointPath(command, cwd));
  if (digest !== component.expectedIdentity.executableSha256) {
    throw new Error(`${component.id} executable digest does not match the execution plan`);
  }
  return {
    ...component.expectedIdentity,
    version: canonicalProductionComponentVersion(cwd, component.id),
    executableSha256: digest,
  };
}

async function stopAfterLaunchFailure(
  processHandle: { stop(): Promise<unknown> },
  error: unknown,
  label: string,
): Promise<never> {
  try {
    await processHandle.stop();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `${label} failed launch verification and cleanup`,
    );
  }
  throw error;
}

function numericLoopback(host: unknown): string {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("fixture readiness is not numeric loopback");
  return host;
}

async function startComponent(input: {
  component: PlannedComponent;
  plan: ExecutionPlan;
  repoRoot: string;
  tokens: Readonly<Record<string, string>>;
  runtimeLaunchGuard: (plan: ExecutionPlan, repoRoot: string) => void;
}): Promise<StartedComponent> {
  const command = expandedCommand(input.component.command, input.tokens);
  const cwd = workingDirectory(input.repoRoot, command);
  const identity = observedIdentity(input.component, command, cwd);
  if (command.readiness.kind !== "stdout_pattern") {
    throw new Error(`${input.component.id} must expose supervised JSON stdout readiness`);
  }
  input.runtimeLaunchGuard(input.plan, input.repoRoot);

  if (input.component.id === "gateway_stub") {
    const process = await StrictReadyProcess.start({
      componentId: input.component.id,
      command,
      absoluteWorkingDirectory: cwd,
      useTestSignalProxy: true,
      validateReadiness(value) {
        if (
          value.event !== "ready" ||
          value.component !== "@revagent/gateway-stub" ||
          value.control_contract_version !== 1 ||
          typeof value.pid !== "number"
        ) {
          throw new Error("Gateway readiness does not match the O1-T5 process contract");
        }
      },
    });
    try {
      if (process.readiness.pid !== process.pid) {
        throw new Error("Gateway readiness PID does not match the spawned child");
      }
      input.runtimeLaunchGuard(input.plan, input.repoRoot);
    } catch (error) {
      return await stopAfterLaunchFailure(process, error, "Gateway");
    }
    return {
      componentId: input.component.id,
      identity,
      pid: process.pid,
      process: process.process,
      readiness: process.readiness,
      stop: async () => {
        await process.stop(command.shutdown.signal === "SIGINT" ? "SIGINT" : "SIGTERM", command.shutdown.timeoutMs);
      },
    };
  }

  const isBridge = input.component.id === "bridge_simulator";
  const process = await StrictJsonlProcess.start({
    componentId: input.component.id,
    command,
    absoluteWorkingDirectory: cwd,
    expectedReadinessFields: isBridge
      ? {
          component: "bridge-simulator",
          componentRole: "O1-T4",
          contract: "bridge-simulator-control/v1",
        }
      : { contract: "addin-loopback/v1" },
    requiredActions: isBridge ? ["snapshot_evidence", "shutdown"] : ["snapshot_evidence", "shutdown"],
  });
  try {
    if (isBridge && process.readiness.pid !== process.pid) {
      throw new Error("Bridge readiness PID does not match the spawned child");
    }
    if (!isBridge) {
      numericLoopback(process.readiness.host);
      safeInteger(process.readiness.port, "fixture readiness port", 1, 65535);
    }
    input.runtimeLaunchGuard(input.plan, input.repoRoot);
  } catch (error) {
    return await stopAfterLaunchFailure(process, error, input.component.id);
  }
  return {
    componentId: input.component.id,
    identity,
    pid: process.pid,
    process: process.process,
    readiness: process.readiness,
    jsonl: process,
    stop: async () => { await process.stop(); },
  };
}

function uuid7(binding: Binding, ordinal: number): string {
  const bindingDigit = binding === "wss" ? "1" : "2";
  return `01900000-0000-7000-8000-${bindingDigit}${String(ordinal).padStart(11, "0")}`;
}

function request(id: string, method: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: "2.0", id, method, params };
}

function exactRequestPayload(id: string, targetBytes: number): JsonObject {
  const base = request(id, "fixture_echo", { padding: "" });
  const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
  const remaining = targetBytes - overhead;
  if (remaining < 0) throw new Error("exact request target is too small");
  const padding = "ğ".repeat(Math.floor(remaining / 2)) + (remaining % 2 === 0 ? "" : "x");
  const value = request(id, "fixture_echo", { padding });
  if (Buffer.byteLength(JSON.stringify(value), "utf8") !== targetBytes) {
    throw new Error("could not construct the exact 8192-byte request payload");
  }
  return value;
}

function framed(value: JsonObject): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length < 1 || payload.length > MAX_FRAME_BYTES) throw new Error("C19 request payload exceeds the parent bound");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

async function connected(host: string, port: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setNoDelay(true);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function writeChunk(socket: Socket, bytes: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

async function exchange(
  host: string,
  port: number,
  frames: readonly Buffer[],
  writes: readonly Buffer[],
  requestIds: readonly string[],
): Promise<ExchangeCapture> {
  const socket = await connected(host, port);
  let buffer = Buffer.alloc(0);
  const responseIds: string[] = [];
  const responsePayloadBytes: number[] = [];
  const responseHeaderHexes: string[] = [];
  try {
    const response = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("C19 fixture response timed out")), 10_000);
      const fail = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", fail);
      socket.on("data", (chunk: Buffer) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > MAX_FRAME_BYTES) throw new Error("C19 response buffer exceeds 32 MiB");
          while (buffer.length >= 4) {
            const length = buffer.readUInt32BE(0);
            if (length < 1 || length > MAX_FRAME_BYTES) throw new Error("C19 response header is outside the parent bound");
            if (buffer.length < length + 4) break;
            const header = buffer.subarray(0, 4);
            const payload = buffer.subarray(4, length + 4);
            buffer = buffer.subarray(length + 4);
            const parsed = JSON.parse(payload.toString("utf8")) as unknown;
            if (!isObject(parsed) || typeof parsed.id !== "string") throw new Error("C19 response is not a correlated JSON-RPC object");
            responseIds.push(parsed.id);
            responsePayloadBytes.push(length);
            responseHeaderHexes.push(header.toString("hex"));
          }
          if (responseIds.length === requestIds.length) {
            clearTimeout(timer);
            resolve();
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    for (const bytes of writes) await writeChunk(socket, bytes);
    await response;
    if (responseIds.join("|") !== requestIds.join("|")) throw new Error("C19 fixture response correlation/order mismatch");
    if (buffer.length !== 0) throw new Error("C19 fixture returned trailing partial response bytes");
    return {
      requestIds: [...requestIds],
      payloadBytes: frames.map((frame) => frame.length - 4),
      requestHeaderHexes: frames.map((frame) => frame.subarray(0, 4).toString("hex")),
      writeChunkSizes: writes.map(({ length }) => length),
      responseIds,
      responsePayloadBytes,
      responseHeaderHexes,
    };
  } finally {
    socket.destroy();
  }
}

function wireObservation(
  runId: string,
  binding: Binding,
  vector: C19Vector,
  capture: ExchangeCapture,
): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${C19_ID}-${binding}-${vector}`,
    runId,
    caseId: C19_ID,
    binding,
    componentId: "addin_loopback_fixture",
    kind: "wire_event",
    at: new Date().toISOString(),
    payload: {
      schemaVersion: "rbp-c19-wire-event/v2",
      vector,
      direction: "parent_runner_to_addin_loopback_fixture_and_response",
      ...capture,
    },
  };
}

async function collectFixtureCounts(fixture: StrictJsonlProcess): Promise<FixtureCount[]> {
  const counts: FixtureCount[] = [];
  let fields: Readonly<Record<string, JsonValue>> = {};
  for (let pageIndex = 0; pageIndex < 64; pageIndex += 1) {
    const value = await fixture.request("snapshot_evidence", fields);
    if (!isObject(value) || !Array.isArray(value.executionCounts)) throw new Error("fixture evidence page lacks executionCounts");
    for (const entry of value.executionCounts) {
      if (!isObject(entry) || typeof entry.requestId !== "string") throw new Error("fixture execution count is malformed");
      counts.push({ requestId: entry.requestId, count: safeInteger(entry.count, "fixture execution count") });
    }
    if (value.complete === true) return counts;
    if (typeof value.snapshotId !== "string" || !isObject(value.nextCursor)) {
      throw new Error("fixture evidence continuation is malformed");
    }
    fields = { snapshotId: value.snapshotId, cursor: value.nextCursor };
  }
  throw new Error("fixture evidence pagination exceeded 64 pages");
}

function lifecycleObservation(
  runId: string,
  binding: Binding,
  component: StartedComponent,
): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${C19_ID}-${binding}-${component.componentId}-process`,
    runId,
    caseId: C19_ID,
    binding,
    componentId: component.componentId,
    kind: "process_lifecycle",
    at: component.process.stoppedAt ?? new Date().toISOString(),
    payload: {
      schemaVersion: "rbp-supervised-process-lifecycle/v2",
      spawnOwner: "parent_runner",
      identity: component.identity,
      process: { ...component.process },
    },
  };
}

function fixtureCountObservation(runId: string, binding: Binding, counts: FixtureCount[]): ProcessObservationRecord {
  return {
    schemaVersion: "rbp-process-observation/v2",
    observationId: `${C19_ID}-${binding}-fixture-execution-counts`,
    runId,
    caseId: C19_ID,
    binding,
    componentId: "addin_loopback_fixture",
    kind: "fixture_execution_count",
    at: new Date().toISOString(),
    payload: {
      schemaVersion: "rbp-c19-fixture-counts/v2",
      executionCounts: counts,
    },
  };
}

async function executeVectors(
  runId: string,
  binding: Binding,
  fixture: StartedComponent,
): Promise<ProcessObservationRecord[]> {
  const host = numericLoopback(fixture.readiness.host);
  const port = safeInteger(fixture.readiness.port, "fixture readiness port", 1, 65535);
  const ids = {
    big: uuid7(binding, 1),
    split: uuid7(binding, 2),
    coalescedFirst: uuid7(binding, 3),
    coalescedSecond: uuid7(binding, 4),
    former8192: uuid7(binding, 5),
  };

  const bigFrame = framed(request(ids.big, "fixture_echo", { vector: "big_endian" }));
  const big = await exchange(host, port, [bigFrame], [bigFrame], [ids.big]);

  const splitFrame = framed(request(ids.split, "fixture_counter"));
  const splitWrites = [
    splitFrame.subarray(0, 1),
    splitFrame.subarray(1, 3),
    splitFrame.subarray(3, 7),
    splitFrame.subarray(7),
  ];
  const split = await exchange(host, port, [splitFrame], splitWrites, [ids.split]);

  const coalescedFrames = [
    framed(request(ids.coalescedFirst, "fixture_counter")),
    framed(request(ids.coalescedSecond, "fixture_counter")),
  ];
  const coalesced = await exchange(
    host,
    port,
    coalescedFrames,
    [Buffer.concat(coalescedFrames)],
    [ids.coalescedFirst, ids.coalescedSecond],
  );

  const former8192Frame = framed(exactRequestPayload(ids.former8192, 8192));
  const former8192 = await exchange(
    host,
    port,
    [former8192Frame],
    [former8192Frame],
    [ids.former8192],
  );
  return [
    wireObservation(runId, binding, "big_endian", big),
    wireObservation(runId, binding, "split_read", split),
    wireObservation(runId, binding, "coalesced_read", coalesced),
    wireObservation(runId, binding, "former_8192", former8192),
  ];
}

function eventPayload(record: ProcessObservationRecord): JsonObject | undefined {
  return isObject(record.payload) ? record.payload : undefined;
}

function processEvidenceIsClean(records: readonly ProcessObservationRecord[], binding: Binding): boolean {
  const lifecycle = records.filter((record) => record.binding === binding && record.kind === "process_lifecycle");
  if (lifecycle.length !== 3 || new Set(lifecycle.map(({ componentId }) => componentId)).size !== 3) return false;
  const pids = new Set<number>();
  for (const record of lifecycle) {
    const payload = eventPayload(record);
    const process = payload !== undefined && isObject(payload.process) ? payload.process : undefined;
    if (payload?.spawnOwner !== "parent_runner" || process === undefined) return false;
    const pid = safeInteger(process.pid, "process lifecycle pid", 1);
    if (pids.has(pid) || process.exitCode !== 0 || typeof process.startedAt !== "string" ||
      typeof process.readyAt !== "string" || typeof process.stoppedAt !== "string") return false;
    if (Date.parse(process.startedAt) > Date.parse(process.readyAt) || Date.parse(process.readyAt) > Date.parse(process.stoppedAt)) return false;
    pids.add(pid);
  }
  return true;
}

function countFor(records: readonly ProcessObservationRecord[], binding: Binding, requestId: string): number | undefined {
  const countRecord = records.find((record) => record.binding === binding && record.kind === "fixture_execution_count");
  const payload = countRecord === undefined ? undefined : eventPayload(countRecord);
  if (!Array.isArray(payload?.executionCounts)) return undefined;
  const entry = payload.executionCounts.find((candidate) => isObject(candidate) && candidate.requestId === requestId);
  return isObject(entry) && Number.isSafeInteger(entry.count) ? Number(entry.count) : undefined;
}

function validHeaders(payload: JsonObject): boolean {
  if (!Array.isArray(payload.payloadBytes) || !Array.isArray(payload.requestHeaderHexes) ||
    !Array.isArray(payload.responsePayloadBytes) || !Array.isArray(payload.responseHeaderHexes)) return false;
  const requestHeaders = payload.requestHeaderHexes;
  const responseHeaders = payload.responseHeaderHexes;
  const payloadBytes = payload.payloadBytes;
  const responsePayloadBytes = payload.responsePayloadBytes;
  return requestHeaders.length === payloadBytes.length && responseHeaders.length === responsePayloadBytes.length &&
    requestHeaders.every((header, index) => {
      if (typeof header !== "string" || !Number.isSafeInteger(payloadBytes[index])) return false;
      const expected = Buffer.alloc(4);
      expected.writeUInt32BE(Number(payloadBytes[index]));
      return header === expected.toString("hex");
    }) &&
    responseHeaders.every((header, index) => {
      if (typeof header !== "string" || !Number.isSafeInteger(responsePayloadBytes[index])) return false;
      const expected = Buffer.alloc(4);
      expected.writeUInt32BE(Number(responsePayloadBytes[index]));
      return header === expected.toString("hex");
    });
}

function vectorPasses(
  assertionId: string,
  records: readonly ProcessObservationRecord[],
  binding: Binding,
): boolean {
  if (!processEvidenceIsClean(records, binding)) return false;
  const vectorByAssertion: Readonly<Record<string, C19Vector>> = {
    "O1-C19-BIG-ENDIAN-PREFIX": "big_endian",
    "O1-C19-SPLIT-READ": "split_read",
    "O1-C19-COALESCED-READ": "coalesced_read",
    "O1-C19-FORMER-8192-CASE": "former_8192",
  };
  const vector = vectorByAssertion[assertionId];
  const observation = records.find((record) => record.binding === binding && record.kind === "wire_event" && eventPayload(record)?.vector === vector);
  const payload = observation === undefined ? undefined : eventPayload(observation);
  if (payload === undefined || payload.schemaVersion !== "rbp-c19-wire-event/v2" || !validHeaders(payload) ||
    !Array.isArray(payload.requestIds) || !Array.isArray(payload.responseIds) ||
    payload.requestIds.join("|") !== payload.responseIds.join("|")) return false;
  const requestIds = payload.requestIds.filter((entry): entry is string => typeof entry === "string");
  if (requestIds.length !== payload.requestIds.length || requestIds.some((id) => countFor(records, binding, id) !== 1)) return false;

  if (vector === "big_endian") {
    return requestIds.length === 1 && Array.isArray(payload.requestHeaderHexes) && payload.requestHeaderHexes[0] !== undefined;
  }
  if (vector === "split_read") {
    return requestIds.length === 1 && Array.isArray(payload.writeChunkSizes) &&
      payload.writeChunkSizes.length === 4 && payload.writeChunkSizes[0] === 1 &&
      payload.writeChunkSizes[1] === 2 && payload.writeChunkSizes[2] === 4;
  }
  if (vector === "coalesced_read") {
    return requestIds.length === 2 && Array.isArray(payload.writeChunkSizes) && payload.writeChunkSizes.length === 1;
  }
  return requestIds.length === 1 && Array.isArray(payload.payloadBytes) && Array.isArray(payload.requestHeaderHexes) &&
    payload.payloadBytes[0] === 8192 && payload.requestHeaderHexes[0] === "00002000";
}

function parentProbes(records: readonly ProcessObservationRecord[]): ParentAssertionProbe[] {
  return canonicalManifest.requiredAssertions[C19_ID]!.map((assertion) => ({
    assertionId: assertion.id,
    observationIds: records.map(({ observationId }) => observationId),
    evaluate: (observations: readonly ProcessObservationRecord[]) =>
      canonicalManifest.cases.find(({ id }) => id === C19_ID)!.bindings.every((binding) =>
        vectorPasses(assertion.id, observations, binding)),
  }));
}

function assertionRecord(assertion: RunReport["cases"][number]["assertions"][number]): EvidenceAssertionRecord {
  return {
    assertionId: assertion.assertionId,
    subvectorId: assertion.subvectorId,
    statement: assertion.statement,
    category: assertion.category,
    passed: assertion.passed === true,
    expected: assertion.expected,
    actual: assertion.actual,
    observationIds: [...assertion.observationIds],
  };
}

async function runBinding(input: {
  plan: ExecutionPlan;
  repoRoot: string;
  binding: Binding;
  runtimeLaunchGuard: (plan: ExecutionPlan, repoRoot: string) => void;
  instanceRootRemover: (instanceRoot: string) => void;
}): Promise<BindingExecution> {
  const startedMs = Date.now();
  const instanceRoot = privateTempDirectory(input.plan.runId, input.binding);
  const started: StartedComponent[] = [];
  const observations: ProcessObservationRecord[] = [];
  let primaryError: Error | undefined;
  const cleanupErrors: Error[] = [];
  try {
    const tokens: Record<string, string> = {
      run_id: input.plan.runId,
      case_id: C19_ID,
      binding: input.binding,
      instance_root: instanceRoot,
    };
    const fixturePlan = input.plan.components.find(({ id }) => id === "addin_loopback_fixture")!;
    const fixture = await startComponent({
      component: fixturePlan,
      plan: input.plan,
      repoRoot: input.repoRoot,
      tokens,
      runtimeLaunchGuard: input.runtimeLaunchGuard,
    });
    started.push(fixture);
    tokens.fixture_host = String(fixture.readiness.host);
    tokens.fixture_port = String(fixture.readiness.port);

    const gatewayPlan = input.plan.components.find(({ id }) => id === "gateway_stub")!;
    const gateway = await startComponent({
      component: gatewayPlan,
      plan: input.plan,
      repoRoot: input.repoRoot,
      tokens,
      runtimeLaunchGuard: input.runtimeLaunchGuard,
    });
    started.push(gateway);
    for (const [key, value] of Object.entries(gateway.readiness)) {
      if (typeof value === "string") tokens[`gateway_${key}`] = value;
    }

    const bridgePlan = input.plan.components.find(({ id }) => id === "bridge_simulator")!;
    const bridge = await startComponent({
      component: bridgePlan,
      plan: input.plan,
      repoRoot: input.repoRoot,
      tokens,
      runtimeLaunchGuard: input.runtimeLaunchGuard,
    });
    started.push(bridge);
    observations.push(...await executeVectors(input.plan.runId, input.binding, fixture));

    const fixtureControl = fixture.jsonl;
    if (fixtureControl === undefined) throw new Error("supervisor did not retain the fixture JSONL control handle");
    observations.push(fixtureCountObservation(
      input.plan.runId,
      input.binding,
      await collectFixtureCounts(fixtureControl),
    ));
  } catch (caught) {
    primaryError = caught instanceof Error ? caught : new Error(String(caught));
  } finally {
    for (const component of [...started].reverse()) {
      try {
        await component.stop();
      } catch (caught) {
        cleanupErrors.push(caught instanceof Error ? caught : new Error(String(caught)));
      }
    }
    observations.push(...started.map((component) => lifecycleObservation(
      input.plan.runId,
      input.binding,
      component,
    )));
    try {
      input.runtimeLaunchGuard(input.plan, input.repoRoot);
    } catch (caught) {
      cleanupErrors.push(caught instanceof Error ? caught : new Error(String(caught)));
    }
    try {
      input.instanceRootRemover(instanceRoot);
    } catch (caught) {
      cleanupErrors.push(caught instanceof Error ? caught : new Error(String(caught)));
    }
  }
  let error: Error | undefined;
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    error = new AggregateError(
      [primaryError, ...cleanupErrors],
      `supervised C19 binding failed and cleanup was incomplete: ${primaryError.message}; ` +
      `cleanup failures: ${cleanupErrors.map(({ message }) => message).join("; ")}`,
    );
  } else if (primaryError !== undefined) {
    error = primaryError;
  } else if (cleanupErrors.length === 1) {
    error = cleanupErrors[0];
  } else if (cleanupErrors.length > 1) {
    error = new AggregateError(
      cleanupErrors,
      `supervised C19 binding shutdown/cleanup failed: ${
        cleanupErrors.map(({ message }) => message).join("; ")
      }`,
    );
  }
  return { binding: input.binding, observations, durationMs: Date.now() - startedMs, ...(error === undefined ? {} : { error }) };
}

export async function executeSupervisedC19Run(input: SupervisedC19RunInput): Promise<SupervisedC19RunResult> {
  const report = createUnexecutedRunReport(input.plan);
  const store = new SecureEvidenceStore(input.artifactRoot);
  const runStartedMs = Date.now();
  report.run = {
    ...report.run,
    status: "running",
    seed: input.seed,
    startedAt: new Date(runStartedMs).toISOString(),
  };
  const result = report.cases.find(({ caseId }) => caseId === C19_ID)!;
  const caseStartedMs = Date.now();
  result.status = "running";
  result.startedAt = new Date(caseStartedMs).toISOString();
  const executions: BindingExecution[] = [];
  const runtimeLaunchGuard =
    input.runtimeLaunchGuard ?? assertProductionRuntimeLaunchCurrent;
  const instanceRootRemover =
    input.instanceRootRemover ??
    ((instanceRoot: string) => rmSync(instanceRoot, { recursive: true, force: true }));
  for (const binding of result.bindings.map(({ binding }) => binding)) {
    executions.push(await runBinding({
      plan: input.plan,
      repoRoot: input.repoRoot,
      binding,
      runtimeLaunchGuard,
      instanceRootRemover,
    }));
  }

  const ledger = new CaseObservationLedger(report.run.runId, C19_ID);
  const observations = executions.flatMap(({ observations: rows }) => rows);
  observations.forEach((observation) => ledger.add(observation));
  result.assertions = ledger.evaluate(parentProbes(observations));
  result.bindings = executions.map((execution) => ({
    binding: execution.binding,
    status: execution.error !== undefined
      ? "error"
      : canonicalManifest.requiredAssertions[C19_ID]!.every((assertion) =>
          vectorPasses(assertion.id, execution.observations, execution.binding)) ? "passed" : "failed",
    durationMs: execution.durationMs,
  }));
  const caseFinishedMs = Date.now();
  result.finishedAt = new Date(caseFinishedMs).toISOString();
  result.durationMs = caseFinishedMs - caseStartedMs;
  result.status = result.bindings.every(({ status }) => status === "passed") && result.assertions.every(({ passed }) => passed === true)
    ? "passed"
    : executions.some(({ error }) => error !== undefined) ? "error" : "failed";
  result.failure = result.status === "passed" ? null : {
    code: executions.some(({ error }) => error !== undefined) ? "supervised_process_error" : "parent_predicate_failed",
    message: executions.find(({ error }) => error !== undefined)?.error?.message ?? "one or more parent-owned C19 predicates failed",
  };

  const evidencePath = retained(`runs/${report.run.runId}/cases/${C19_ID}/supervised-evidence-v2.json`);
  const evidenceDocument = {
    schemaVersion: "rbp-case-evidence/v2",
    runId: report.run.runId,
    caseId: C19_ID,
    source: "case_evidence",
    evaluationOwner: "parent_runner",
    observations: ledger.records(),
    evaluations: result.assertions.map(assertionRecord),
  } as const;
  const evidenceIssues = validateSchema("caseEvidenceV2", evidenceDocument);
  if (evidenceIssues.length > 0) {
    throw new Error(`parent-generated C19 evidence v2 is invalid: ${stableJson(evidenceIssues)}`);
  }
  const evidence = await artifact(
    store,
    "case_evidence",
    evidencePath,
    stableJson(evidenceDocument),
    "application/json",
  );
  result.artifacts.push(evidence);
  result.assertions.forEach((assertion) => { assertion.evidenceSha256 = evidence.sha256; });

  const runFinishedMs = Date.now();
  report.run.finishedAt = new Date(runFinishedMs).toISOString();
  report.run.durationMs = runFinishedMs - runStartedMs;
  // This runner intentionally executes only C19. The remaining 39 canonical
  // cases stay explicit not_run, so this can never masquerade as O1-T6 green.
  report.run.status = "failed";
  report.run.exitCode = 1;
  report.timing = {
    setupDurationMs: 0,
    suiteDurationMs: result.durationMs,
    teardownDurationMs: 0,
  };
  const junitPath = retained(`runs/${report.run.runId}/junit.xml`);
  report.artifacts.push(await artifact(store, "junit", junitPath, runReportToJUnitXml(report), "application/xml"));
  const reportPath = retained(`runs/${report.run.runId}/run-report.json`);
  const reportBytes = Buffer.from(stableJson(report), "utf8");
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  await store.writeAccepted(reportPath, reportBytes, (candidate) => candidate.acceptExact({ logicalPath: reportPath, absolutePath: store.resolve(reportPath), bytes: reportBytes, sha256: reportSha256 }, undefined));
  return { report, reportPath };
}
