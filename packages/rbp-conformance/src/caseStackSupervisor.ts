import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer, Socket, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

import { sha256File } from "./executionPlan.js";
import {
  createEphemeralLoopbackTlsIdentity,
  type EphemeralTlsIdentity,
} from "./ephemeralTlsIdentity.js";
import {
  StrictJsonlProcess,
  StrictReadyProcess,
  type JsonObject,
  type JsonValue,
} from "./processHarness.js";
import {
  canonicalProductionComponentVersion,
  assertProductionRuntimeLaunchCurrent,
  boundProductionPowerShellExecutable,
} from "./productionExecutionPlan.js";
import { sanitizedProductionRuntimeEnvironment } from "./productionRuntimeIdentity.js";
import type {
  Binding,
  ComponentId,
  ComponentIdentity,
  ExecutionPlan,
  PlannedComponent,
  ProcessCommandDescriptor,
  ProcessEvidence,
  ProcessObservationRecord,
} from "./types.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_SNAPSHOT_PAGES = 64;
const MAX_AGGREGATED_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_INTERNAL_GATEWAY_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_COMPACT_GATEWAY_SNAPSHOT_BYTES = 60 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const MAX_EXTERNAL_EVIDENCE_BYTES = 48 * 1024;
const MAX_ARTIFACT_EVIDENCE_FILES = 64;
const MAX_ARTIFACT_EVIDENCE_BYTES = 40 * 1024 * 1024;
const MAX_GATEWAY_ARTIFACT_STATE_BYTES = 48 * 1024 * 1024;
const MAX_BIND_PROBE_OUTPUT_BYTES = 8 * 1024;

export interface GatewayStartupOverrides {
  sessionCapabilities?: readonly string[];
  connectionCapabilities?: readonly string[];
  supportedProtocols?: readonly number[];
  clockStartMs?: number;
}

export interface RestartCaseStackOptions {
  caseId: string;
  binding: Binding;
  preserveState: boolean;
  startupOverrides?: GatewayStartupOverrides;
}

export interface SessionResumeAuthorizationProbe {
  readonly frame: JsonObject;
  readonly facts: JsonObject;
}

export interface ParentCaptureSummary {
  proxy: "gateway" | "fixture";
  target: { host: string; port: number };
  listening: { host: string; port: number };
  clientToTarget: {
    chunks: number;
    bytes: number;
    sha256: string;
  };
  targetToClient: {
    chunks: number;
    bytes: number;
    sha256: string;
  };
  acceptedConnections: number;
  activeConnections: number;
  startedAtMonotonicMs: number;
  finishedAtMonotonicMs: number;
}

export interface StartedStackComponent {
  componentId: ComponentId;
  identity: ComponentIdentity;
  pid: number;
  process: ProcessEvidence;
  readiness: JsonObject;
  jsonl?: StrictJsonlProcess;
  stop(): Promise<{ killEscalated: boolean }>;
}

export class GatewayControlRequestError extends Error {
  readonly status: number;
  readonly response: JsonObject;

  constructor(action: string, status: number, response: JsonObject) {
    super(`Gateway control ${action} returned HTTP ${status}`);
    this.name = "GatewayControlRequestError";
    this.status = status;
    this.response = structuredClone(response);
  }
}

interface CaptureCounters {
  chunks: number;
  bytes: number;
  hash: ReturnType<typeof createHash>;
}

function counters(): CaptureCounters {
  return { chunks: 0, bytes: 0, hash: createHash("sha256") };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safePort(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`${label} is not a valid TCP port`);
  }
  return Number(value);
}

function selectedObjectFields(
  value: unknown,
  fields: readonly string[],
): JsonObject | null {
  if (!isObject(value)) return null;
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
      .map((field) => [field, structuredClone(value[field]!)]),
  );
}

function compactTerminalPayload(value: unknown): JsonObject | null {
  return selectedObjectFields(value, [
    "invocation_id",
    "batch_id",
    "status",
    "fault_class",
    "outcome",
    "verification_required",
    "replayed",
    "late_after_indeterminate",
    "payload_omitted",
    "result_digest",
    "guarded_reason",
    "failed_step_index",
    "error",
    "steps",
  ]);
}

function compactGatewaySnapshotValue(snapshot: JsonObject): JsonObject {
  const sessions = isObject(snapshot.sessions) ? snapshot.sessions : {};
  const compactSessions: JsonObject = {};
  for (const [rsid, rawSession] of Object.entries(sessions)) {
    if (!isObject(rawSession)) continue;
    const terminalOutcomes = isObject(rawSession.terminalOutcomes)
      ? Object.fromEntries(
          Object.entries(rawSession.terminalOutcomes)
            .filter(([, outcome]) => isObject(outcome))
            .map(([correlationId, rawOutcome]) => {
              const outcome = rawOutcome as JsonObject;
              const envelope = isObject(outcome.envelope)
                ? {
                    ...(selectedObjectFields(outcome.envelope, [
                      "v",
                      "type",
                      "id",
                      "ts",
                      "rsid",
                      "seq",
                      "ack",
                    ]) ?? {}),
                    payload: compactTerminalPayload(outcome.envelope.payload),
                  }
                : null;
              return [correlationId, {
                correlationId: outcome.correlationId ?? correlationId,
                classification: outcome.classification ?? null,
                acceptedAtMs: outcome.acceptedAtMs ?? null,
                envelope,
              }];
            }),
        )
      : {};
    const artifacts = isObject(rawSession.artifacts)
      ? Object.fromEntries(
          Object.entries(rawSession.artifacts).map(([invocationId, entries]) => [
            invocationId,
            Array.isArray(entries)
              ? entries
                  .filter(isObject)
                  .map((entry) => selectedObjectFields(entry, [
                    "artifactId",
                    "artifactIndex",
                    "streamId",
                    "filename",
                    "contentType",
                    "totalChunks",
                    "totalSize",
                    "sha256",
                  ]))
              : [],
          ]),
        )
      : {};
    const chunkedResults = isObject(rawSession.chunkedResults)
      ? Object.fromEntries(
          Object.entries(rawSession.chunkedResults).map(([invocationId, entry]) => [
            invocationId,
            selectedObjectFields(entry, [
              "streamId",
              "contentType",
              "totalChunks",
              "totalSize",
              "sha256",
            ]),
          ]),
        )
      : {};
    const omittedPayloadRecoveries = isObject(rawSession.omittedPayloadRecoveries)
      ? Object.fromEntries(
          Object.entries(rawSession.omittedPayloadRecoveries).map(([invocationId, entry]) => [
            invocationId,
            selectedObjectFields(entry, [
              "originInvocationId",
              "parentCorrelationId",
              "omittedResultDigest",
              "mutating",
              "mutationScope",
              "state",
              "auditId",
              "recoveryInvocationId",
              "recoveryResultDigest",
              "createdAtMs",
              "completedAtMs",
            ]),
          ]),
        )
      : {};
    compactSessions[rsid] = {
      ...(selectedObjectFields(rawSession, [
        "rsid",
        "deviceId",
        "tenantId",
        "userId",
        "seatId",
        "localSessionKey",
        "grantedSessionCapabilities",
        "lifecycle",
        "sequence",
        "dispatchWindow",
        "inFlight",
        "documents",
        "activeDocument",
        "activeView",
        "disciplineHint",
        "lastHeartbeatAtMs",
        "disconnectedAtMs",
        "liveness",
      ]) ?? {}),
      terminalOutcomes,
      artifacts,
      chunkedResults,
      omittedPayloadRecoveries,
    };
  }
  return {
    schemaVersion: "rbp-gateway-compact-snapshot/v1",
    sourceSchemaVersion: snapshot.schemaVersion ?? null,
    sessions: compactSessions,
    mutationHolds: structuredClone(snapshot.mutationHolds ?? null),
    authorizationAudit: structuredClone(snapshot.authorizationAudit ?? null),
    runtime: structuredClone(snapshot.runtime ?? null),
  };
}

function numericLoopback(value: unknown, label: string): string {
  if (typeof value !== "string" || !LOOPBACK_HOSTS.has(value)) {
    throw new Error(`${label} must be numeric loopback`);
  }
  return value;
}

function replaceTokens(value: string, tokens: Readonly<Record<string, string>>): string {
  const expanded = Object.entries(tokens).reduce(
    (result, [name, replacement]) => result.replaceAll(`{{${name}}}`, replacement),
    value,
  );
  if (/\{\{[^{}]+\}\}/u.test(expanded)) {
    throw new Error(`component command contains an unresolved execution token: ${expanded}`);
  }
  return expanded;
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
    readiness: {
      ...command.readiness,
      value: replaceTokens(command.readiness.value, tokens),
    },
    shutdown: { ...command.shutdown },
  };
}

function confinedWorkingDirectory(repoRoot: string, command: ProcessCommandDescriptor): string {
  const root = realpathSync(repoRoot);
  const candidate = path.resolve(root, command.workingDirectory);
  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory()) {
    throw new Error(`component working directory is missing: ${command.workingDirectory}`);
  }
  const realCandidate = realpathSync(candidate);
  const relative = path.relative(root, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`component working directory escapes the source repository: ${command.workingDirectory}`);
  }
  return realCandidate;
}

function entrypointPath(command: ProcessCommandDescriptor, cwd: string): string {
  const argument = command.args.find((entry) => {
    const candidate = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    return existsSync(candidate) && lstatSync(candidate).isFile();
  });
  if (argument !== undefined) return path.isAbsolute(argument) ? argument : path.resolve(cwd, argument);
  const executable = path.isAbsolute(command.executable)
    ? command.executable
    : path.resolve(cwd, command.executable);
  if (existsSync(executable) && lstatSync(executable).isFile()) return executable;
  throw new Error("component command does not expose a hash-verifiable executable entrypoint");
}

function observedIdentity(
  component: PlannedComponent,
  command: ProcessCommandDescriptor,
  cwd: string,
): ComponentIdentity {
  const executableSha256 = sha256File(entrypointPath(command, cwd));
  if (executableSha256 !== component.expectedIdentity.executableSha256) {
    throw new Error(`${component.id} executable digest does not match the execution plan`);
  }
  return {
    ...component.expectedIdentity,
    version: canonicalProductionComponentVersion(cwd, component.id),
    executableSha256,
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

class ProductionRuntimeLaunchGuardError extends Error {
  constructor(cause: unknown) {
    super(
      `production runtime launch guard failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ProductionRuntimeLaunchGuardError";
  }
}

function retryableFixtureBindError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.some((nested) => retryableFixtureBindError(nested));
  }
  if (!(error instanceof Error)) return false;
  if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return true;
  if (/\bEADDRINUSE\b|address already in use/iu.test(error.message)) return true;
  return error.cause !== undefined && retryableFixtureBindError(error.cause);
}

function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw normalizedError(signal.reason ?? new Error("case stack restart was aborted"));
}

function setCliListArgument(
  args: readonly string[],
  flag: string,
  values: readonly string[] | readonly number[] | undefined,
): string[] {
  if (values === undefined) return [...args];
  const next = [...args];
  const index = next.indexOf(flag);
  const serialized = values.join(",");
  if (index >= 0) {
    if (index + 1 >= next.length) throw new Error(`${flag} lacks its execution-plan value`);
    next[index + 1] = serialized;
  } else {
    next.push(flag, serialized);
  }
  return next;
}

function setCliScalarArgument(
  args: readonly string[],
  flag: string,
  value: string | number | undefined,
): string[] {
  if (value === undefined) return [...args];
  const next = [...args];
  const index = next.indexOf(flag);
  const serialized = String(value);
  if (index >= 0) {
    if (index + 1 >= next.length) throw new Error(`${flag} lacks its execution-plan value`);
    next[index + 1] = serialized;
  } else {
    next.push(flag, serialized);
  }
  return next;
}

function withGatewayOverrides(
  command: ProcessCommandDescriptor,
  overrides: GatewayStartupOverrides | undefined,
  tlsIdentity: EphemeralTlsIdentity | undefined,
): ProcessCommandDescriptor {
  let args = setCliListArgument(command.args, "--session-capabilities", overrides?.sessionCapabilities);
  args = setCliListArgument(args, "--connection-capabilities", overrides?.connectionCapabilities);
  args = setCliListArgument(args, "--supported-protocols", overrides?.supportedProtocols);
  args = setCliScalarArgument(args, "--clock-start-ms", overrides?.clockStartMs);
  if (tlsIdentity !== undefined) {
    if (args.includes("--tls-cert") || args.includes("--tls-key")) {
      throw new Error("execution plan must not pre-provision persistent Gateway TLS material");
    }
    args.push(
      "--tls-cert",
      tlsIdentity.certificatePath,
      "--tls-key",
      tlsIdentity.privateKeyPath,
    );
  }
  return { ...command, args };
}

function parseLoopbackUrl(value: unknown, label: string): URL {
  if (typeof value !== "string") throw new Error(`${label} is not a URL string`);
  const parsed = new URL(value);
  numericLoopback(parsed.hostname, `${label} host`);
  safePort(parsed.port === "" ? undefined : Number(parsed.port), `${label} port`);
  return parsed;
}

function proxyUrl(original: string, listeningPort: number): string {
  const parsed = new URL(original);
  parsed.hostname = "127.0.0.1";
  parsed.port = String(listeningPort);
  return parsed.toString();
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function postHttpsControl(
  controlUrl: string,
  body: Buffer,
  identity: EphemeralTlsIdentity,
  maxResponseBytes: number,
): Promise<{ status: number; bytes: Buffer }> {
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(controlUrl, {
      method: "POST",
      ca: readFileSync(identity.caCertificatePath),
      rejectUnauthorized: true,
      checkServerIdentity(host: string, certificate: PeerCertificate): Error | undefined {
        const identityError = checkServerIdentity(host, certificate);
        if (identityError !== undefined) return identityError;
        const digest = `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}`;
        if (digest === identity.serverCertificateSha256) return undefined;
        return new Error("Gateway control leaf certificate does not match the supervised stack");
      },
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
        "x-rbp-test-control": "rbp-test-control",
      },
      timeout: 30_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxResponseBytes) {
          request.destroy(
            new Error(`Gateway control response exceeds ${maxResponseBytes} bytes`),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          bytes: Buffer.concat(chunks, length),
        });
      });
    });
    request.once("timeout", () => request.destroy(new Error("Gateway control timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

async function waitForNoSurvivors(pids: readonly number[], timeoutMs = 2_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let survivors = pids.filter(processAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    survivors = pids.filter(processAlive);
  }
  return survivors;
}

function sha256Bytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Text(value: string): `sha256:${string}` {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function pathInside(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowRoot && relative.length === 0) ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalBase64Bytes(value: unknown, label: string): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(MAX_ARTIFACT_EVIDENCE_BYTES / 3) * 4
  ) {
    throw new Error(`${label} is not canonical Base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error(`${label} is not a byte-identical canonical Base64 encoding`);
  }
  return bytes;
}

function artifactFilesystemInventory(spoolRoot: string): ArtifactFilesystemInventory {
  const root = path.resolve(spoolRoot);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Bridge artifact spool root is not a plain directory");
  }
  const realRoot = realpathSync.native(root);
  const files: ArtifactFilesystemRow[] = [];
  let directoryCount = 1;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error("Bridge artifact spool inventory encountered a reparse point");
      }
      const realCandidate = realpathSync.native(candidate);
      if (!pathInside(realRoot, realCandidate)) {
        throw new Error("Bridge artifact spool inventory escaped the real spool root");
      }
      if (stat.isDirectory()) {
        directoryCount += 1;
        if (directoryCount > MAX_ARTIFACT_EVIDENCE_FILES * 4) {
          throw new Error("Bridge artifact spool directory evidence exceeds the parent bound");
        }
        pending.push(candidate);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error("Bridge artifact spool inventory encountered a non-file member");
      }
      if (files.length >= MAX_ARTIFACT_EVIDENCE_FILES) {
        throw new Error(`Bridge artifact spool evidence exceeds ${MAX_ARTIFACT_EVIDENCE_FILES} files`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_ARTIFACT_EVIDENCE_BYTES) {
        throw new Error("Bridge artifact spool evidence exceeds the 40 MiB parent bound");
      }
      const bytes = readFileSync(candidate);
      if (bytes.byteLength !== stat.size) {
        throw new Error("Bridge artifact spool member changed during parent inspection");
      }
      const relative = path.relative(root, candidate).replaceAll("\\", "/");
      files.push({
        relativePathSha256: sha256Text(relative),
        depth: relative.split("/").length,
        bytes: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        linkCount: stat.nlink,
        regularFile: true,
        reparsePoint: false,
      });
    }
  }
  files.sort((left, right) =>
    left.relativePathSha256.localeCompare(right.relativePathSha256));
  return {
    schemaVersion: "supervisor.product-artifact-filesystem/v1",
    rootPathRedacted: true,
    directoryCount,
    fileCount: files.length,
    totalBytes,
    files,
  };
}

function replaceFixtureCliArguments(
  command: ProcessCommandDescriptor,
  input: FixtureBindPolicyProbeInput,
): ProcessCommandDescriptor {
  let args = setCliScalarArgument(command.args, "--host", input.host);
  args = setCliScalarArgument(args, "--port", 0);
  args = args.filter((entry) => entry !== "--allow-unsafe-bind");
  if (input.allowUnsafeBind) args.push("--allow-unsafe-bind");
  return { ...command, args };
}

export async function runFixtureBindPolicyProcess(input: {
  command: ProcessCommandDescriptor;
  cwd: string;
  environment: Readonly<Record<string, string | undefined>>;
  probe: FixtureBindPolicyProbeInput;
}): Promise<JsonObject> {
  const child = spawn(input.command.executable, input.command.args, {
    cwd: input.cwd,
    env: sanitizedProductionRuntimeEnvironment(process.env, input.environment),
    shell: false,
    windowsHide: true,
  });
  let launchError: Error | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  const closed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const waitForClose = async (
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; signal: string | null } | null> =>
    await new Promise((resolve) => {
      let settled = false;
      const finish = (
        value: { exitCode: number | null; signal: string | null } | null,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => finish(null), timeoutMs);
      void closed.then(finish);
    });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;
  const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
    if (stream === "stdout") stdoutBytes += chunk.byteLength;
    else stderrBytes += chunk.byteLength;
    if (stdoutBytes + stderrBytes > MAX_BIND_PROBE_OUTPUT_BYTES) {
      outputExceeded = true;
      child.kill("SIGTERM");
      return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
  const pid = child.pid;
  if (pid === undefined) {
    let terminal = await waitForClose(1_000);
    if (terminal === null) {
      child.kill("SIGKILL");
      terminal = await waitForClose(1_000);
    }
    const failure =
      launchError ?? new Error("fixture bind policy probe did not receive a child PID");
    throw new Error(`fixture bind policy probe failed to launch: ${failure.message}`, {
      cause: failure,
    });
  }
  let timedOut = false;
  let terminal = await waitForClose(3_000);
  if (terminal === null) {
    timedOut = true;
    child.kill("SIGTERM");
    terminal = await waitForClose(1_000);
  }
  if (terminal === null || processAlive(pid)) {
    child.kill("SIGKILL");
    terminal = await waitForClose(2_000);
  }
  terminal ??= { exitCode: null, signal: "survived_cleanup" };
  if (launchError !== undefined) {
    throw new Error(`fixture bind policy probe failed to launch: ${launchError.message}`, {
      cause: launchError,
    });
  }
  const stdoutBuffer = Buffer.concat(stdout);
  const stderrBuffer = Buffer.concat(stderr);
  const stderrText = stderrBuffer.toString("utf8");
  const readyObserved = stdoutBuffer.toString("utf8")
    .split(/\r?\n/u)
    .some((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return isObject(parsed) && parsed.ready === true;
      } catch {
        return false;
      }
    });
  const failureClass = /Unsafe bind override is forbidden/u.test(stderrText)
    ? "unsafe_override_forbidden"
    : /numeric IP loopback address/u.test(stderrText)
      ? "numeric_loopback_required"
      : "other";
  return {
    processSpawned: true,
    requestedHost: input.probe.host,
    allowUnsafeBind: input.probe.allowUnsafeBind,
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    timedOut,
    outputExceeded,
    readyObserved,
    survivingProcess: processAlive(pid),
    failureClass,
    stdoutBytes,
    stdoutSha256: sha256Bytes(stdoutBuffer),
    stderrBytes,
    stderrSha256: sha256Bytes(stderrBuffer),
  };
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      resolve(available);
    };
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => finish(error === undefined));
    });
  });
}

class ParentTcpCaptureProxy {
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #clients = new Set<Socket>();
  #clientToTarget = counters();
  #targetToClient = counters();
  #acceptedConnections = 0;
  #clientToTargetBackpressure = false;
  #stopped = false;
  #startedAtMonotonicMs = performance.now();
  #listeningPort = 0;

  private constructor(
    readonly name: "gateway" | "fixture",
    readonly targetHost: string,
    readonly targetPort: number,
  ) {
    this.#server = createServer((client) => this.#relay(client));
  }

  static async start(input: {
    name: "gateway" | "fixture";
    targetHost: string;
    targetPort: number;
  }): Promise<ParentTcpCaptureProxy> {
    numericLoopback(input.targetHost, `${input.name} proxy target`);
    safePort(input.targetPort, `${input.name} proxy target`);
    const proxy = new ParentTcpCaptureProxy(input.name, input.targetHost, input.targetPort);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      proxy.#server.once("error", onError);
      proxy.#server.listen({ host: "127.0.0.1", port: 0 }, () => {
        proxy.#server.off("error", onError);
        const address = proxy.#server.address();
        if (address === null || typeof address === "string") {
          reject(new Error(`${input.name} capture proxy did not bind TCP`));
          return;
        }
        proxy.#listeningPort = address.port;
        resolve();
      });
    });
    return proxy;
  }

  get listeningPort(): number {
    return this.#listeningPort;
  }

  reset(): void {
    this.#clientToTarget = counters();
    this.#targetToClient = counters();
    this.#acceptedConnections = 0;
    this.#startedAtMonotonicMs = performance.now();
  }

  setClientToTargetBackpressure(enabled: boolean): {
    enabled: boolean;
    activeConnections: number;
  } {
    this.#clientToTargetBackpressure = enabled;
    for (const client of this.#clients) {
      if (enabled) client.pause();
      else client.resume();
    }
    return {
      enabled,
      activeConnections: this.#clients.size,
    };
  }

  summary(): ParentCaptureSummary {
    return {
      proxy: this.name,
      target: { host: this.targetHost, port: this.targetPort },
      listening: { host: "127.0.0.1", port: this.#listeningPort },
      clientToTarget: {
        chunks: this.#clientToTarget.chunks,
        bytes: this.#clientToTarget.bytes,
        sha256: `sha256:${this.#clientToTarget.hash.copy().digest("hex")}`,
      },
      targetToClient: {
        chunks: this.#targetToClient.chunks,
        bytes: this.#targetToClient.bytes,
        sha256: `sha256:${this.#targetToClient.hash.copy().digest("hex")}`,
      },
      acceptedConnections: this.#acceptedConnections,
      activeConnections: this.#sockets.size / 2,
      startedAtMonotonicMs: this.#startedAtMonotonicMs,
      finishedAtMonotonicMs: performance.now(),
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  #record(direction: "client_to_target" | "target_to_client", chunk: Buffer): void {
    const target = direction === "client_to_target" ? this.#clientToTarget : this.#targetToClient;
    target.chunks += 1;
    target.bytes += chunk.length;
    target.hash.update(chunk);
  }

  #relay(client: Socket): void {
    this.#acceptedConnections += 1;
    const target = new Socket();
    this.#sockets.add(client);
    this.#sockets.add(target);
    this.#clients.add(client);
    if (this.#clientToTargetBackpressure) client.pause();
    const close = (): void => {
      client.destroy();
      target.destroy();
      this.#sockets.delete(client);
      this.#sockets.delete(target);
      this.#clients.delete(client);
    };
    client.once("error", close);
    target.once("error", close);
    client.once("close", () => {
      target.destroy();
      this.#sockets.delete(client);
      this.#clients.delete(client);
    });
    target.once("close", () => {
      client.destroy();
      this.#sockets.delete(target);
    });
    client.on("data", (chunk: Buffer) => this.#record("client_to_target", chunk));
    target.on("data", (chunk: Buffer) => this.#record("target_to_client", chunk));
    client.pipe(target);
    target.pipe(client);
    target.connect({ host: this.targetHost, port: this.targetPort });
  }
}

interface ActiveStack {
  caseId: string;
  binding: Binding;
  preserveState: boolean;
  instanceRoot: string;
  instanceRootId: string;
  tokens: Record<string, string>;
  startupOverrides?: GatewayStartupOverrides;
  components: Map<ComponentId, StartedStackComponent>;
  extraFixtures: StartedStackComponent[];
  fixtureProxy: ParentTcpCaptureProxy;
  gatewayProxy: ParentTcpCaptureProxy;
  tlsIdentity?: EphemeralTlsIdentity;
  publicReadiness: {
    fixture: JsonObject;
    gateway: JsonObject;
    bridge: JsonObject;
  };
  stopOrder: ComponentId[];
}

export interface CaseStackSupervisorOptions {
  plan: ExecutionPlan;
  repoRoot: string;
  environment?: Readonly<Record<string, string | undefined>>;
  runtimeLaunchGuard?: (plan: ExecutionPlan, repoRoot: string) => void;
  instanceRootRemover?: (instanceRoot: string) => void;
}

export interface FixtureBindPolicyProbeInput {
  host: "0.0.0.0" | "127.0.0.1";
  allowUnsafeBind: boolean;
}

export type ProductArtifactScenario =
  | "raw_path"
  | "local_path"
  | "traversal_path"
  | "reparse_path"
  | "valid_multifile"
  | "retransmission"
  | "invalid_member";

interface ArtifactFilesystemRow {
  relativePathSha256: `sha256:${string}`;
  depth: number;
  bytes: number;
  sha256: `sha256:${string}`;
  linkCount: number;
  regularFile: true;
  reparsePoint: false;
}

interface ArtifactFilesystemInventory {
  schemaVersion: "supervisor.product-artifact-filesystem/v1";
  rootPathRedacted: true;
  directoryCount: number;
  fileCount: number;
  totalBytes: number;
  files: ArtifactFilesystemRow[];
}

interface GatewayArtifactByteEvidence {
  schemaVersion: "supervisor.gateway-artifact-byte-evidence/v1";
  source: "parent_runner_direct_durable_state_read";
  statePathRedacted: true;
  stateSchemaVersion: number;
  stateFileBytes: number;
  stateFileSha256: `sha256:${string}`;
  rsid: string;
  invocationId: string;
  terminalResultDigest: string;
  artifactCount: number;
  totalDecodedBytes: number;
  artifacts: Array<{
    artifactId: string;
    artifactIndex: number;
    streamId: string;
    totalChunks: number;
    reportedTotalSize: number;
    terminalTotalChunks: number;
    terminalTotalSize: number;
    parentDecodedBytes: number;
    reportedSha256: string;
    terminalDescriptorSha256: string;
    parentSha256: `sha256:${string}`;
  }>;
}

export class CaseStackSupervisor {
  readonly #plan: ExecutionPlan;
  readonly #repoRoot: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #runtimeLaunchGuard: (plan: ExecutionPlan, repoRoot: string) => void;
  readonly #instanceRootRemover: (instanceRoot: string) => void;
  #active: ActiveStack | null = null;
  #observationOrdinal = 0;

  constructor(options: CaseStackSupervisorOptions) {
    this.#plan = structuredClone(options.plan);
    this.#repoRoot = realpathSync(options.repoRoot);
    this.#environment = { ...(options.environment ?? {}) };
    this.#runtimeLaunchGuard =
      options.runtimeLaunchGuard ?? assertProductionRuntimeLaunchCurrent;
    this.#instanceRootRemover =
      options.instanceRootRemover ??
      ((instanceRoot) => rmSync(instanceRoot, { recursive: true, force: true }));
  }

  #assertRuntimeLaunchCurrent(): void {
    try {
      this.#runtimeLaunchGuard(this.#plan, this.#repoRoot);
    } catch (error) {
      throw new ProductionRuntimeLaunchGuardError(error);
    }
  }

  get active(): boolean {
    return this.#active !== null;
  }

  get pids(): number[] {
    const stack = this.#stack();
    return [
      ...stack.components.values(),
      ...stack.extraFixtures,
    ].map(({ pid }) => pid);
  }

  productionPowerShellExecutable(): string {
    return boundProductionPowerShellExecutable(this.#plan);
  }

  readiness(): { fixture: JsonObject; gateway: JsonObject; bridge: JsonObject } {
    const readiness = this.#stack().publicReadiness;
    return structuredClone(readiness);
  }

  component(componentId: ComponentId): StartedStackComponent {
    const component = this.#stack().components.get(componentId);
    if (component === undefined) throw new Error(`active stack lacks ${componentId}`);
    return component;
  }

  beginWireCapture(): { started: true; atMonotonicMs: number } {
    const stack = this.#stack();
    stack.gatewayProxy.reset();
    stack.fixtureProxy.reset();
    return { started: true, atMonotonicMs: performance.now() };
  }

  setGatewayProxyBackpressure(enabled: boolean): {
    enabled: boolean;
    activeConnections: number;
  } {
    return this.#stack().gatewayProxy.setClientToTargetBackpressure(enabled);
  }

  wireCapture(): { gateway: ParentCaptureSummary; fixture: ParentCaptureSummary } {
    const stack = this.#stack();
    return {
      gateway: stack.gatewayProxy.summary(),
      fixture: stack.fixtureProxy.summary(),
    };
  }

  rawBindingEndpoint(): JsonObject {
    const stack = this.#stack();
    const tlsTrust = stack.publicReadiness.gateway.tlsTrust;
    return {
      binding: stack.binding,
      wsUrl: stack.publicReadiness.gateway.ws_url ?? null,
      httpConnectionUrl: stack.publicReadiness.gateway.http_connection_url ?? null,
      tlsTrust: isObject(tlsTrust) ? structuredClone(tlsTrust) : null,
    };
  }

  sessionResumeAuthorizationProbe(input: {
    readonly sourceRsid: string;
    readonly targetRsid: string;
    readonly messageId: string;
    readonly ts: string;
  }): SessionResumeAuthorizationProbe {
    const stack = this.#stack();
    for (const [label, value] of Object.entries(input)) {
      if (typeof value !== "string" || value.length < 1 || value.length > 512) {
        throw new Error(`session resume authorization probe ${label} must be bounded text`);
      }
    }
    const statePath = path.join(stack.instanceRoot, "state", "gateway.json");
    const relative = path.relative(stack.instanceRoot, path.resolve(statePath));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("session resume authorization probe state escaped the private stack");
    }
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    if (!isObject(parsed) || !isObject(parsed.sessions)) {
      throw new Error("session resume authorization probe found malformed Gateway state");
    }
    const source = parsed.sessions[input.sourceRsid];
    const target = parsed.sessions[input.targetRsid];
    if (!isObject(source) || !isObject(target)) {
      throw new Error("session resume authorization probe requires two persisted sessions");
    }
    const sourceSequence = source.sequence;
    const targetSequence = target.sequence;
    if (
      source.rsid !== input.sourceRsid ||
      target.rsid !== input.targetRsid ||
      source.revoked === true ||
      target.revoked === true ||
      typeof source.resumeToken !== "string" ||
      typeof target.resumeToken !== "string" ||
      typeof source.deviceId !== "string" ||
      typeof target.deviceId !== "string" ||
      !isObject(sourceSequence) ||
      !isObject(targetSequence) ||
      !Number.isSafeInteger(targetSequence.lastPeerAck)
    ) {
      throw new Error("session resume authorization probe sessions are not active exact state");
    }
    const lastRxSeq = Number(targetSequence.lastPeerAck);
    return {
      frame: {
        v: 1,
        type: "session_resume",
        id: input.messageId,
        ts: input.ts,
        payload: {
          rsid: input.targetRsid,
          resume_token: source.resumeToken,
          last_rx_seq: lastRxSeq,
        },
      },
      facts: {
        schemaVersion: "supervisor.session-resume-authorization-material/v1",
        materialSource: "gateway_persisted_session",
        sourceRsid: input.sourceRsid,
        targetRsid: input.targetRsid,
        sourceDeviceIdSha256: sha256Text(source.deviceId),
        targetDeviceIdSha256: sha256Text(target.deviceId),
        sourceResumeTokenSha256: sha256Text(source.resumeToken),
        targetResumeTokenSha256: sha256Text(target.resumeToken),
        targetLastPeerAck: lastRxSeq,
        sourceAndTargetRsidEqual: input.sourceRsid === input.targetRsid,
        sourceAndTargetDeviceEqual: source.deviceId === target.deviceId,
        sourceAndTargetResumeTokenEqual: source.resumeToken === target.resumeToken,
        secretsRedacted: true,
        rawTokenExposed: false,
      },
    };
  }

  async restartComponent(
    input: {
      componentId: ComponentId;
      preserveState: boolean;
      startupOverrides?: GatewayStartupOverrides;
      transportSecurity?: "preserve" | "cleartext_loopback";
    },
    stepId: string,
    action: string,
  ): Promise<{ result: JsonObject; observations: ProcessObservationRecord[] }> {
    const stack = this.#stack();
    if (input.componentId === "addin_loopback_fixture") {
      throw new Error("restart_component does not replace the canonical fixture process");
    }
    if (
      input.componentId !== "gateway_stub" &&
      input.transportSecurity !== undefined &&
      input.transportSecurity !== "preserve"
    ) {
      throw new Error("restart_component transportSecurity applies only to gateway_stub");
    }
    const previous = this.component(input.componentId);
    const stopped = await previous.stop();
    const survivors = await waitForNoSurvivors([previous.pid]);
    if (survivors.length > 0) {
      throw new Error(`${input.componentId} restart left the prior process alive`);
    }
    const stoppedObservation = this.#lifecycleObservation(
      previous,
      stepId,
      action,
      "stopped",
      {
        orphanProcessCount: 0,
        survivingPids: [],
        killEscalated: stopped.killEscalated,
        stopOrder: [input.componentId],
        preserveState: input.preserveState,
      },
    );
    if (!input.preserveState) this.#removeComponentState(stack, input.componentId);
    const startupOverrides = {
      ...(stack.startupOverrides ?? {}),
      ...(input.startupOverrides ?? {}),
    };
    stack.startupOverrides = structuredClone(startupOverrides);

    if (input.componentId === "gateway_stub") {
      await stack.gatewayProxy.stop();
      const replacementTlsIdentity = input.transportSecurity === "cleartext_loopback"
        ? undefined
        : stack.tlsIdentity;
      const replacement = await this.#startComponent(
        this.#componentPlan("gateway_stub"),
        stack.tokens,
        startupOverrides,
        replacementTlsIdentity,
      );
      let replacementProxy: ParentTcpCaptureProxy | undefined;
      try {
        const gatewayWs = parseLoopbackUrl(replacement.readiness.ws_url, "Gateway ws_url");
        const gatewayHttp = parseLoopbackUrl(
          replacement.readiness.http_connection_url,
          "Gateway http_connection_url",
        );
        if (gatewayWs.hostname !== gatewayHttp.hostname || gatewayWs.port !== gatewayHttp.port) {
          throw new Error("restarted Gateway readiness bindings do not share one loopback listener");
        }
        const expectedSchemes = replacementTlsIdentity === undefined
          ? { ws: "ws:", http: "http:" }
          : { ws: "wss:", http: "https:" };
        if (
          gatewayWs.protocol !== expectedSchemes.ws ||
          gatewayHttp.protocol !== expectedSchemes.http
        ) {
          throw new Error("restarted Gateway transport schemes do not match supervised TLS mode");
        }
        replacementProxy = await ParentTcpCaptureProxy.start({
          name: "gateway",
          targetHost: gatewayWs.hostname,
          targetPort: safePort(Number(gatewayWs.port), "restarted Gateway target port"),
        });
        const gatewayWsUrl = proxyUrl(
          String(replacement.readiness.ws_url),
          replacementProxy.listeningPort,
        );
        const gatewayHttpConnectionUrl = proxyUrl(
          String(replacement.readiness.http_connection_url),
          replacementProxy.listeningPort,
        );
        const gatewayControlUrl = String(replacement.readiness.control_url);
        const publicGatewayReadiness = {
          ...replacement.readiness,
          ws_url: gatewayWsUrl,
          http_connection_url: gatewayHttpConnectionUrl,
          control_url: gatewayControlUrl,
          proxyCapture: true,
          tlsTrust: replacementTlsIdentity === undefined
            ? {
                enabled: false,
                caCertificatePath: null,
                caCertificateSha256: null,
                serverCertificateSha256: null,
              }
            : {
                enabled: true,
                caCertificatePath: replacementTlsIdentity.caCertificatePath,
                caCertificateSha256: replacementTlsIdentity.caCertificateSha256,
                serverCertificateSha256: replacementTlsIdentity.serverCertificateSha256,
              },
        };
        this.#assertRuntimeLaunchCurrent();
        stack.tokens.gateway_ws_url = gatewayWsUrl;
        stack.tokens.gateway_http_connection_url = gatewayHttpConnectionUrl;
        stack.tokens.gateway_control_url = gatewayControlUrl;
        stack.gatewayProxy = replacementProxy;
        stack.publicReadiness.gateway = publicGatewayReadiness;
        if (replacementTlsIdentity === undefined) delete stack.tlsIdentity;
        else stack.tlsIdentity = replacementTlsIdentity;
        stack.components.set(input.componentId, replacement);
      } catch (error) {
        const cleanupErrors: Error[] = [];
        await replacementProxy?.stop().catch((cleanupError: unknown) => {
          cleanupErrors.push(normalizedError(cleanupError));
        });
        await replacement.stop().catch((cleanupError: unknown) => {
          cleanupErrors.push(normalizedError(cleanupError));
        });
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "gateway restart failed and replacement cleanup was incomplete",
          );
        }
        throw error;
      }
      return {
        result: {
          restarted: true,
          componentId: input.componentId,
          preserveState: input.preserveState,
          previousPid: previous.pid,
          pid: replacement.pid,
          readiness: structuredClone(stack.publicReadiness.gateway),
        },
        observations: [
          stoppedObservation,
          this.#lifecycleObservation(replacement, stepId, action, "started", {
            orphanProcessCount: 0,
            survivingPids: [],
            killEscalated: false,
            stopOrder: [],
            preserveState: input.preserveState,
          }),
        ],
      };
    }

    const replacement = await this.#startComponent(
      this.#componentPlan("bridge_simulator"),
      stack.tokens,
      startupOverrides,
    );
    try {
      this.#assertRuntimeLaunchCurrent();
    } catch (error) {
      return await stopAfterLaunchFailure(
        replacement,
        error,
        "Bridge restart lifecycle",
      );
    }
    stack.components.set(input.componentId, replacement);
    stack.publicReadiness.bridge = { ...replacement.readiness };
    return {
      result: {
        restarted: true,
        componentId: input.componentId,
        preserveState: input.preserveState,
        previousPid: previous.pid,
        pid: replacement.pid,
        readiness: structuredClone(stack.publicReadiness.bridge),
      },
      observations: [
        stoppedObservation,
        this.#lifecycleObservation(replacement, stepId, action, "started", {
          orphanProcessCount: 0,
          survivingPids: [],
          killEscalated: false,
          stopOrder: [],
          preserveState: input.preserveState,
        }),
      ],
    };
  }

  async spawnAdditionalFixture(
    stepId: string,
    action: string,
    count = 1,
  ): Promise<{ result: JsonObject; observations: ProcessObservationRecord[] }> {
    const stack = this.#stack();
    if (stack.extraFixtures.length > 0) {
      throw new Error("additional fixtures may be spawned only once per supervised stack");
    }
    if (!Number.isSafeInteger(count) || count < 1 || count > 3) {
      throw new Error("additional fixture count must be an integer from 1 through 3");
    }
    const primaryPort = safePort(
      stack.publicReadiness.fixture.port,
      "primary fixture readiness port",
    );
    const fixturePlan = this.#componentPlan("addin_loopback_fixture");
    let fixtures: StartedStackComponent[] = [];
    let selectedPorts: number[] = [];
    for (let primaryOffset = 0; primaryOffset < 6 && fixtures.length !== count; primaryOffset += 1) {
      const firstPort = primaryPort - primaryOffset;
      const lastPort = firstPort + 5;
      if (firstPort < 1 || lastPort > 65_535) continue;
      const candidates = Array.from({ length: 6 }, (_unused, index) => firstPort + index)
        .filter((port) => port !== primaryPort);
      const available: number[] = [];
      for (const candidate of candidates) {
        if (await loopbackPortAvailable(candidate)) available.push(candidate);
      }
      if (available.length < count) continue;
      const attemptFixtures: StartedStackComponent[] = [];
      const attemptPorts: number[] = [];
      try {
        for (const candidate of available.slice(0, count)) {
          const fixture = await this.#startComponent(
            fixturePlan,
            stack.tokens,
            stack.startupOverrides,
            undefined,
            { "--port": candidate },
          );
          const selectedPort = safePort(
            fixture.readiness.port,
            "additional fixture readiness port",
          );
          if (selectedPort !== candidate) {
            await fixture.stop();
            throw new Error("additional fixture did not bind the parent-selected port");
          }
          attemptFixtures.push(fixture);
          attemptPorts.push(selectedPort);
        }
        fixtures = attemptFixtures;
        selectedPorts = attemptPorts;
      } catch (error) {
        const cleanup = await Promise.allSettled(
          [...attemptFixtures].reverse().map(async (fixture) => await fixture.stop()),
        );
        const cleanupErrors = cleanup.flatMap((result) =>
          result.status === "rejected" ? [normalizedError(result.reason)] : []);
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "additional fixture start failed and cleanup was incomplete",
          );
        }
        if (!retryableFixtureBindError(error)) throw error;
      }
    }
    if (fixtures.length !== count) {
      await Promise.allSettled([...fixtures].reverse().map(async (fixture) => await fixture.stop()));
      throw new Error(`unable to start ${count} additional fixtures in the bounded adjacent port range`);
    }
    stack.extraFixtures.push(...fixtures);
    const orderedPorts = [primaryPort, ...selectedPorts].sort((left, right) => left - right);
    const primaryProbeIndex = orderedPorts.indexOf(primaryPort);
    const auxiliaryProbeIndexes = selectedPorts.map((port) => orderedPorts.indexOf(port));
    return {
      result: {
        started: true,
        fixtureIndex: 1,
        fixtureIndexes: fixtures.map((_fixture, index) => index + 1),
        pid: fixtures[0]!.pid,
        pids: fixtures.map(({ pid }) => pid),
        host: numericLoopback(fixtures[0]!.readiness.host, "additional fixture host"),
        port: selectedPorts[0]!,
        ports: selectedPorts,
        firstPort: orderedPorts[0]!,
        lastPort: orderedPorts.at(-1)!,
        expectedSessionCount: count + 1,
        primaryProbeIndex,
        auxiliaryProbeIndex: auxiliaryProbeIndexes[0]!,
        auxiliaryProbeIndexes,
        tempRegistryPath: null,
      },
      observations: fixtures.map((fixture) =>
        this.#lifecycleObservation(fixture, stepId, action, "started", {
          orphanProcessCount: 0,
          survivingPids: [],
          killEscalated: false,
          stopOrder: [],
        })),
    };
  }

  async probeFixtureBindPolicy(input: FixtureBindPolicyProbeInput): Promise<JsonObject> {
    if (
      (input.host !== "0.0.0.0" && input.host !== "127.0.0.1") ||
      typeof input.allowUnsafeBind !== "boolean"
    ) {
      throw new Error("fixture bind policy probe is outside the exact C33 vector set");
    }
    const stack = this.#stack();
    const component = this.#componentPlan("addin_loopback_fixture");
    const command = replaceFixtureCliArguments(
      expandedCommand(component.command, stack.tokens),
      input,
    );
    const cwd = confinedWorkingDirectory(this.#repoRoot, command);
    const identity = observedIdentity(component, command, cwd);
    const environment: Record<string, string | undefined> = {};
    for (const key of command.environmentKeys) environment[key] = this.#environment[key];
    this.#assertRuntimeLaunchCurrent();
    let processEvidence: JsonObject;
    try {
      processEvidence = await runFixtureBindPolicyProcess({
        command,
        cwd,
        environment,
        probe: input,
      });
    } catch (error) {
      try {
        this.#assertRuntimeLaunchCurrent();
      } catch (guardError) {
        throw new AggregateError(
          [error, guardError],
          "fixture bind policy process failed and post-exit runtime identity changed",
        );
      }
      throw error;
    }
    this.#assertRuntimeLaunchCurrent();
    return {
      schemaVersion: "supervisor.loopback-probe/v1",
      probeKind: "fixture_bind_process",
      executableSha256: identity.executableSha256,
      ...processEvidence,
    };
  }

  inspectGatewayArtifactBytes(input: {
    rsid: string;
    invocationId: string;
  }): GatewayArtifactByteEvidence {
    const stack = this.#stack();
    if (
      stack.caseId !== "O1-C15" ||
      typeof input.rsid !== "string" ||
      input.rsid.length < 1 ||
      input.rsid.length > 128 ||
      typeof input.invocationId !== "string" ||
      input.invocationId.length < 1 ||
      input.invocationId.length > 128
    ) {
      throw new Error("Gateway artifact byte inspection is outside the exact O1-C15 vector");
    }

    const statePath = path.join(stack.instanceRoot, "state", "gateway.json");
    if (!pathInside(stack.instanceRoot, statePath) || !existsSync(statePath)) {
      throw new Error("Gateway durable state is unavailable inside the private case stack");
    }
    const lexicalStat = lstatSync(statePath);
    if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) {
      throw new Error("Gateway durable state is not a plain file");
    }
    const realStatePath = realpathSync.native(statePath);
    if (!pathInside(realpathSync.native(stack.instanceRoot), realStatePath)) {
      throw new Error("Gateway durable state escaped the private case stack");
    }

    const descriptor = openSync(statePath, "r");
    let stateBytes: Buffer;
    let before: ReturnType<typeof fstatSync>;
    let after: ReturnType<typeof fstatSync>;
    try {
      before = fstatSync(descriptor);
      if (!before.isFile() || before.size < 1 || before.size > MAX_GATEWAY_ARTIFACT_STATE_BYTES) {
        throw new Error("Gateway durable state exceeds the parent artifact-inspection bound");
      }
      stateBytes = readFileSync(descriptor);
      after = fstatSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (
      stateBytes.byteLength !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      throw new Error("Gateway durable state changed during parent byte inspection");
    }

    const state = JSON.parse(stateBytes.toString("utf8")) as unknown;
    if (!isObject(state) || state.schemaVersion !== 1 || !isObject(state.sessions)) {
      throw new Error("Gateway durable state has an unsupported schema");
    }
    const session = state.sessions[input.rsid];
    if (!isObject(session) || session.rsid !== input.rsid) {
      throw new Error("Gateway durable state lacks the exact O1-C15 session");
    }
    const artifactsByInvocation = session.artifacts;
    const terminalOutcomes = session.terminalOutcomes;
    if (!isObject(artifactsByInvocation) || !isObject(terminalOutcomes)) {
      throw new Error("Gateway durable state lacks artifact or terminal ledgers");
    }
    const retained = artifactsByInvocation[input.invocationId];
    const terminal = terminalOutcomes[input.invocationId];
    if (
      !Array.isArray(retained) ||
      retained.length < 1 ||
      retained.length > MAX_ARTIFACT_EVIDENCE_FILES ||
      !isObject(terminal) ||
      !isObject(terminal.envelope) ||
      terminal.envelope.type !== "result" ||
      !isObject(terminal.envelope.payload)
    ) {
      throw new Error("Gateway durable state lacks the exact terminal artifact carrier");
    }
    const terminalPayload = terminal.envelope.payload;
    if (
      terminalPayload.invocation_id !== input.invocationId ||
      terminalPayload.status !== "completed" ||
      typeof terminalPayload.result_digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(terminalPayload.result_digest) ||
      !Array.isArray(terminalPayload.artifacts) ||
      terminalPayload.artifacts.length !== retained.length
    ) {
      throw new Error("Gateway terminal artifact descriptor set is malformed or incomplete");
    }
    const terminalDescriptors = terminalPayload.artifacts
      .map((entry) => isObject(entry) ? entry : null)
      .filter((entry): entry is JsonObject => entry !== null);
    if (terminalDescriptors.length !== terminalPayload.artifacts.length) {
      throw new Error("Gateway terminal artifact descriptor is not an object");
    }

    let totalDecodedBytes = 0;
    const artifacts = retained.map((entry, retainedIndex) => {
      if (
        !isObject(entry) ||
        typeof entry.artifactId !== "string" ||
        !Number.isSafeInteger(entry.artifactIndex) ||
        typeof entry.streamId !== "string" ||
        !Number.isSafeInteger(entry.totalChunks) ||
        !Number.isSafeInteger(entry.totalSize) ||
        typeof entry.sha256 !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(entry.sha256)
      ) {
        throw new Error(`Gateway retained artifact ${retainedIndex} is malformed`);
      }
      const terminalDescriptor = terminalDescriptors.find((candidate) =>
        candidate?.artifact_id === entry.artifactId &&
        candidate.artifact_index === entry.artifactIndex &&
        candidate.stream_id === entry.streamId);
      if (
        terminalDescriptor === undefined ||
        !Number.isSafeInteger(terminalDescriptor.total_chunks) ||
        !Number.isSafeInteger(terminalDescriptor.total_size) ||
        typeof terminalDescriptor.sha256 !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(terminalDescriptor.sha256)
      ) {
        throw new Error(`Gateway retained artifact ${retainedIndex} lacks its terminal descriptor`);
      }
      const bytes = canonicalBase64Bytes(
        entry.bytesBase64,
        `Gateway retained artifact ${retainedIndex} bytes`,
      );
      totalDecodedBytes += bytes.byteLength;
      if (totalDecodedBytes > MAX_ARTIFACT_EVIDENCE_BYTES) {
        throw new Error("Gateway retained artifact bytes exceed the 40 MiB parent bound");
      }
      const parentSha256 = sha256Bytes(bytes);
      return {
        artifactId: entry.artifactId,
        artifactIndex: Number(entry.artifactIndex),
        streamId: entry.streamId,
        totalChunks: Number(entry.totalChunks),
        reportedTotalSize: Number(entry.totalSize),
        terminalTotalChunks: Number(terminalDescriptor.total_chunks),
        terminalTotalSize: Number(terminalDescriptor.total_size),
        parentDecodedBytes: bytes.byteLength,
        reportedSha256: entry.sha256,
        terminalDescriptorSha256: terminalDescriptor.sha256,
        parentSha256,
      };
    });
    artifacts.sort((left, right) => left.artifactIndex - right.artifactIndex);
    return {
      schemaVersion: "supervisor.gateway-artifact-byte-evidence/v1",
      source: "parent_runner_direct_durable_state_read",
      statePathRedacted: true,
      stateSchemaVersion: Number(state.schemaVersion),
      stateFileBytes: stateBytes.byteLength,
      stateFileSha256: sha256Bytes(stateBytes),
      rsid: input.rsid,
      invocationId: input.invocationId,
      terminalResultDigest: terminalPayload.result_digest,
      artifactCount: artifacts.length,
      totalDecodedBytes,
      artifacts,
    };
  }

  async executeProductArtifactScenario(input: {
    scenario: ProductArtifactScenario;
    envelope: JsonObject;
    stepId: string;
  }): Promise<JsonObject> {
    const allowed = new Set<ProductArtifactScenario>([
      "raw_path",
      "local_path",
      "traversal_path",
      "reparse_path",
      "valid_multifile",
      "retransmission",
      "invalid_member",
    ]);
    if (!allowed.has(input.scenario) || !/^[a-z0-9._-]{1,128}$/u.test(input.stepId)) {
      throw new Error("product artifact scenario identity is invalid");
    }
    const stack = this.#stack();
    if (stack.caseId !== "O1-C40") {
      throw new Error("product artifact evidence is available only to O1-C40");
    }
    const envelope = structuredClone(input.envelope);
    const sequenceByScenario: Readonly<Record<ProductArtifactScenario, number>> = {
      raw_path: 1,
      local_path: 2,
      traversal_path: 3,
      reparse_path: 4,
      valid_multifile: 5,
      retransmission: 6,
      invalid_member: 7,
    };
    envelope.seq = sequenceByScenario[input.scenario];
    const payload = envelope.payload;
    if (!isObject(payload) || payload.method !== "fixture_multi_file_output") {
      throw new Error("product artifact scenario requires fixture_multi_file_output");
    }
    const params = payload.params;
    if (!isObject(params)) throw new Error("product artifact scenario params must be an object");
    const expectedFixtureScenario = input.scenario === "retransmission"
      ? "valid_multifile"
      : input.scenario;
    if (params.scenario !== expectedFixtureScenario) {
      throw new Error("product artifact scenario does not match its fixture params");
    }
    if (
      expectedFixtureScenario === "valid_multifile" &&
      (params.fileCount !== 2 || params.bytesPerFile !== 1_048_577)
    ) {
      throw new Error("valid multi-file evidence requires the exact two-file, two-chunk vector");
    }
    const invocationId = payload.invocation_id;
    if (typeof invocationId !== "string") {
      throw new Error("product artifact scenario lacks invocation_id");
    }

    const spoolRoot = path.join(stack.instanceRoot, "state", "bridge", "spool");
    if (!pathInside(stack.instanceRoot, spoolRoot) || !existsSync(spoolRoot)) {
      throw new Error("Bridge artifact spool is missing from the active private stack");
    }
    const before = artifactFilesystemInventory(spoolRoot);
    const setupKey = sha256Text(`${stack.instanceRootId}:${input.stepId}`).slice(-16);
    const setupRoot = path.join(stack.instanceRoot, "evidence", `artifact-${setupKey}`);
    if (!pathInside(stack.instanceRoot, setupRoot)) {
      throw new Error("product artifact setup root escaped the private stack");
    }
    mkdirSync(setupRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const cleanupTargets: string[] = [setupRoot];
    let surface: JsonObject = {
      kind: "inline_fixture_bytes",
      created: false,
      lexicalInsideSpool: false,
      resolvedInsideSpool: false,
      reparsePointObserved: false,
      sourceBytes: 0,
      sourceSha256: sha256Bytes(Buffer.alloc(0)),
      sourcePathSha256: null,
    };

    const createRegularSurface = (
      lexicalPath: string,
      bytes: Buffer,
      kind: string,
    ): void => {
      const target = path.resolve(lexicalPath);
      if (!pathInside(stack.instanceRoot, target)) {
        throw new Error("product artifact source escaped the private stack");
      }
      mkdirSync(path.dirname(target), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      writeFileSync(target, bytes, { flag: "wx" });
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("product artifact source is not a regular non-reparse file");
      }
      cleanupTargets.unshift(target);
      const realTarget = realpathSync.native(target);
      surface = {
        kind,
        created: true,
        lexicalInsideSpool: pathInside(spoolRoot, lexicalPath),
        resolvedInsideSpool: pathInside(realpathSync.native(spoolRoot), realTarget),
        reparsePointObserved: false,
        sourceBytes: bytes.byteLength,
        sourceSha256: sha256Bytes(bytes),
        sourcePathSha256: sha256Text(lexicalPath),
      };
      params.path = lexicalPath;
    };

    try {
      const sourceBytes = Buffer.from(`revAgent C40 ${input.scenario} source\n`, "utf8");
      if (input.scenario === "raw_path") {
        createRegularSurface(
          path.join(setupRoot, "raw-output.bin"),
          sourceBytes,
          "outside_regular_file",
        );
      } else if (input.scenario === "local_path") {
        createRegularSurface(
          path.join(spoolRoot, `conformance-local-${setupKey}.bin`),
          sourceBytes,
          "managed_regular_file",
        );
      } else if (input.scenario === "traversal_path") {
        const target = path.resolve(spoolRoot, "..", `traversal-${setupKey}.bin`);
        const lexical = `${spoolRoot}${path.sep}..${path.sep}${path.basename(target)}`;
        createRegularSurface(lexical, sourceBytes, "traversal_regular_file");
      } else if (input.scenario === "reparse_path") {
        const targetDirectory = path.join(setupRoot, "reparse-target");
        mkdirSync(targetDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        const target = path.join(targetDirectory, "reparse-output.bin");
        writeFileSync(target, sourceBytes, { flag: "wx" });
        const link = path.join(spoolRoot, `conformance-reparse-${setupKey}`);
        symlinkSync(
          targetDirectory,
          link,
          process.platform === "win32" ? "junction" : "dir",
        );
        cleanupTargets.unshift(link);
        const linkStat = lstatSync(link);
        const lexical = path.join(link, "reparse-output.bin");
        const realTarget = realpathSync.native(lexical);
        if (!linkStat.isSymbolicLink() || pathInside(realpathSync.native(spoolRoot), realTarget)) {
          throw new Error("product artifact reparse fixture did not resolve outside the spool");
        }
        surface = {
          kind: "managed_reparse_file",
          created: true,
          lexicalInsideSpool: true,
          resolvedInsideSpool: false,
          reparsePointObserved: true,
          sourceBytes: sourceBytes.byteLength,
          sourceSha256: sha256Bytes(sourceBytes),
          sourcePathSha256: sha256Text(lexical),
        };
        params.path = lexical;
      }

      const response = await this.jsonlControl(
        "bridge_simulator",
        "invoke_local",
        {
          envelope,
          responseMode: "artifact_evidence",
        },
        30_000,
      );
      if (!isObject(response) || response.crashed !== false || !isObject(response.outcome)) {
        throw new Error("Bridge artifact evidence response is malformed");
      }

      for (const target of cleanupTargets) {
        if (!existsSync(target)) continue;
        if (!pathInside(stack.instanceRoot, target)) {
          throw new Error("product artifact cleanup target escaped the private stack");
        }
        rmSync(target, {
          recursive: lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink(),
          force: true,
        });
      }
      const after = artifactFilesystemInventory(spoolRoot);
      const snapshot = await this.aggregateSnapshot("bridge_simulator");
      const artifactSpool = snapshot.artifactSpool;
      if (!isObject(artifactSpool) || !Array.isArray(artifactSpool.carriers)) {
        throw new Error("Bridge snapshot lacks sanitized artifact spool evidence");
      }
      const carriers = artifactSpool.carriers.filter((carrier) =>
        isObject(carrier) && carrier.invocationId === invocationId);
      const evidence: JsonObject = {
        schemaVersion: "supervisor.product-artifact-evidence/v1",
        stepId: input.stepId,
        scenario: input.scenario,
        fixtureScenario: expectedFixtureScenario,
        invocationId,
        surface,
        bridgeOutcome: structuredClone(response.outcome),
        bridgeSpool: {
          evidenceVersion: artifactSpool.evidenceVersion ?? null,
          rootPathRedacted: artifactSpool.rootPathRedacted ?? null,
          rawPathExposed: artifactSpool.rawPathExposed ?? null,
          carrierCountForInvocation: carriers.length,
          carriers: structuredClone(carriers) as JsonValue,
        },
        filesystemBefore: before as unknown as JsonObject,
        filesystemAfter: after as unknown as JsonObject,
        filesystemDelta: {
          fileCount: after.fileCount - before.fileCount,
          totalBytes: after.totalBytes - before.totalBytes,
        },
        evidenceScope: "rbp_only",
        northClientObservationCount: 0,
        northClientSurfaces: [],
      };
      const serialized = JSON.stringify(evidence);
      if (
        serialized.includes(stack.instanceRoot) ||
        serialized.includes(spoolRoot) ||
        Buffer.byteLength(serialized, "utf8") > MAX_EXTERNAL_EVIDENCE_BYTES
      ) {
        throw new Error("product artifact evidence is unbounded or exposes a private path");
      }
      return evidence;
    } finally {
      for (const target of cleanupTargets) {
        if (!existsSync(target) || !pathInside(stack.instanceRoot, target)) continue;
        rmSync(target, {
          recursive: lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink(),
          force: true,
        });
      }
    }
  }

  async restartCaseStack(
    options: RestartCaseStackOptions,
    stepId: string,
    action: string,
    signal?: AbortSignal,
  ): Promise<{ result: JsonObject; observations: ProcessObservationRecord[] }> {
    throwIfAborted(signal);
    if (this.#active !== null) {
      await this.stopCaseStack(stepId, "implicit_stop_before_restart");
      throwIfAborted(signal);
    }
    const instanceRoot = this.#privateInstanceRoot(options.caseId, options.binding);
    const instanceRootId = `sha256:${createHash("sha256").update(instanceRoot).digest("hex")}`;
    const components = new Map<ComponentId, StartedStackComponent>();
    const extraFixtures: StartedStackComponent[] = [];
    let fixtureProxy: ParentTcpCaptureProxy | undefined;
    let gatewayProxy: ParentTcpCaptureProxy | undefined;
    try {
      const tokens: Record<string, string> = {
        run_id: this.#plan.runId,
        case_id: options.caseId,
        binding: options.binding,
        instance_root: instanceRoot,
        state_root: path.join(instanceRoot, "state"),
        evidence_root: path.join(instanceRoot, "evidence"),
      };
      mkdirSync(tokens.state_root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      mkdirSync(tokens.evidence_root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      const tlsIdentity = options.binding === "wss"
        ? createEphemeralLoopbackTlsIdentity(instanceRoot)
        : undefined;

      const fixturePlan = this.#componentPlan("addin_loopback_fixture");
      const fixture = await this.#startComponent(fixturePlan, tokens, options.startupOverrides);
      components.set(fixture.componentId, fixture);
      throwIfAborted(signal);
      const fixtureHost = numericLoopback(fixture.readiness.host, "fixture readiness host");
      const fixturePort = safePort(fixture.readiness.port, "fixture readiness port");
      fixtureProxy = await ParentTcpCaptureProxy.start({
        name: "fixture",
        targetHost: fixtureHost,
        targetPort: fixturePort,
      });
      throwIfAborted(signal);
      tokens.fixture_host = "127.0.0.1";
      tokens.fixture_port = String(fixtureProxy.listeningPort);

      const gatewayPlan = this.#componentPlan("gateway_stub");
      const gateway = await this.#startComponent(
        gatewayPlan,
        tokens,
        options.startupOverrides,
        tlsIdentity,
      );
      components.set(gateway.componentId, gateway);
      throwIfAborted(signal);
      const gatewayWs = parseLoopbackUrl(gateway.readiness.ws_url, "Gateway ws_url");
      const gatewayHttp = parseLoopbackUrl(
        gateway.readiness.http_connection_url,
        "Gateway http_connection_url",
      );
      if (gatewayWs.hostname !== gatewayHttp.hostname || gatewayWs.port !== gatewayHttp.port) {
        throw new Error("Gateway readiness bindings do not share one loopback listener");
      }
      const expectedSchemes = tlsIdentity === undefined
        ? { ws: "ws:", http: "http:" }
        : { ws: "wss:", http: "https:" };
      if (gatewayWs.protocol !== expectedSchemes.ws || gatewayHttp.protocol !== expectedSchemes.http) {
        throw new Error("Gateway readiness transport schemes do not match the supervised TLS mode");
      }
      gatewayProxy = await ParentTcpCaptureProxy.start({
        name: "gateway",
        targetHost: gatewayWs.hostname,
        targetPort: safePort(Number(gatewayWs.port), "Gateway proxy target port"),
      });
      throwIfAborted(signal);
      tokens.gateway_ws_url = proxyUrl(String(gateway.readiness.ws_url), gatewayProxy.listeningPort);
      tokens.gateway_http_connection_url = proxyUrl(
        String(gateway.readiness.http_connection_url),
        gatewayProxy.listeningPort,
      );
      tokens.gateway_control_url = String(gateway.readiness.control_url);

      const bridgePlan = this.#componentPlan("bridge_simulator");
      const bridge = await this.#startComponent(bridgePlan, tokens, options.startupOverrides);
      components.set(bridge.componentId, bridge);
      throwIfAborted(signal);

      const publicReadiness = {
        fixture: {
          ...fixture.readiness,
          host: fixtureHost,
          port: fixturePort,
          proxyCapture: false,
          proxyUnavailableReason:
            "fixture discovery binds the advertised endpoint to the probed endpoint",
        },
        gateway: {
          ...gateway.readiness,
          ws_url: tokens.gateway_ws_url,
          http_connection_url: tokens.gateway_http_connection_url,
          control_url: tokens.gateway_control_url,
          proxyCapture: true,
          tlsTrust: tlsIdentity === undefined
            ? {
                enabled: false,
                caCertificatePath: null,
                caCertificateSha256: null,
                serverCertificateSha256: null,
              }
            : {
                enabled: true,
                caCertificatePath: tlsIdentity.caCertificatePath,
                caCertificateSha256: tlsIdentity.caCertificateSha256,
                serverCertificateSha256: tlsIdentity.serverCertificateSha256,
              },
        },
        bridge: { ...bridge.readiness },
      };
      throwIfAborted(signal);
      this.#active = {
        caseId: options.caseId,
        binding: options.binding,
        preserveState: options.preserveState,
        instanceRoot,
        instanceRootId,
        tokens,
        ...(options.startupOverrides === undefined
          ? {}
          : { startupOverrides: structuredClone(options.startupOverrides) }),
        components,
        extraFixtures,
        fixtureProxy,
        gatewayProxy,
        ...(tlsIdentity === undefined ? {} : { tlsIdentity }),
        publicReadiness,
        stopOrder: [],
      };
      const observations = [...components.values()].map((component) =>
        this.#lifecycleObservation(component, stepId, action, "started", {
          orphanProcessCount: 0,
          survivingPids: [],
          killEscalated: false,
          stopOrder: [],
        }));
      return {
        result: {
          restarted: true,
          caseId: options.caseId,
          binding: options.binding,
          instanceRootId,
          readiness: publicReadiness,
          processIdentities: [...components.values()].map((component) => ({
            componentId: component.componentId,
            pid: component.pid,
            identity: component.identity,
          })) as unknown as JsonValue,
        },
        observations,
      };
    } catch (error) {
      const cleanupErrors: Error[] = [];
      for (const component of [...components.values(), ...extraFixtures].reverse()) {
        await component.stop().catch((cleanupError: unknown) => {
          cleanupErrors.push(
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          );
        });
      }
      await gatewayProxy?.stop().catch((cleanupError: unknown) => {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        );
      });
      await fixtureProxy?.stop().catch((cleanupError: unknown) => {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        );
      });
      const survivors = await waitForNoSurvivors(
        [...components.values(), ...extraFixtures].map(({ pid }) => pid),
      );
      if (survivors.length > 0) {
        cleanupErrors.push(
          new Error(`failed stack start left orphan processes: ${survivors.join(", ")}`),
        );
      }
      try {
        this.#assertRuntimeLaunchCurrent();
      } catch (cleanupError) {
        cleanupErrors.push(normalizedError(cleanupError));
      }
      if (survivors.length === 0) {
        try {
          this.#instanceRootRemover(instanceRoot);
        } catch (cleanupError) {
          cleanupErrors.push(normalizedError(cleanupError));
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "case stack start failed and supervised cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  async stopCaseStack(
    stepId: string,
    action: string,
  ): Promise<{ result: JsonObject; observations: ProcessObservationRecord[] }> {
    const stack = this.#stack();
    const killEscalated = new Map<ComponentId, boolean>();
    const teardownErrors: Error[] = [];
    const components = [...stack.components.values(), ...stack.extraFixtures];
    for (const component of [...components].reverse()) {
      stack.stopOrder.push(component.componentId);
      try {
        const stopped = await component.stop();
        killEscalated.set(component.componentId, stopped.killEscalated);
      } catch (error) {
        killEscalated.set(component.componentId, true);
        teardownErrors.push(normalizedError(error));
      }
    }
    await stack.gatewayProxy.stop().catch((error: unknown) => {
      teardownErrors.push(normalizedError(error));
    });
    await stack.fixtureProxy.stop().catch((error: unknown) => {
      teardownErrors.push(normalizedError(error));
    });
    const pids = components.map(({ pid }) => pid);
    const survivors = await waitForNoSurvivors(pids);
    if (survivors.length > 0) {
      teardownErrors.push(
        new Error(`case stack left orphan processes: ${survivors.join(", ")}`),
      );
    }
    try {
      this.#assertRuntimeLaunchCurrent();
    } catch (error) {
      teardownErrors.push(normalizedError(error));
    }
    const observations = components.map((component) =>
      this.#lifecycleObservation(component, stepId, action, "stopped", {
        orphanProcessCount: survivors.length,
        survivingPids: survivors,
        killEscalated: killEscalated.get(component.componentId) ?? true,
        stopOrder: [...stack.stopOrder],
      }));
    const result: JsonObject = {
      stopped: true,
      instanceRootId: stack.instanceRootId,
      stopOrder: [...stack.stopOrder],
      orphanProcessCount: survivors.length,
      survivingPids: survivors,
      killEscalated: Object.fromEntries(killEscalated) as unknown as JsonValue,
    };
    this.#active = null;
    if (!stack.preserveState && survivors.length === 0) {
      try {
        this.#instanceRootRemover(stack.instanceRoot);
      } catch (error) {
        teardownErrors.push(normalizedError(error));
      }
    }
    if (teardownErrors.length === 1) throw teardownErrors[0];
    if (teardownErrors.length > 1) {
      throw new AggregateError(
        teardownErrors,
        "case stack teardown encountered multiple failures",
      );
    }
    return { result, observations };
  }

  async gatewayControl(
    action: string,
    argumentsValue: JsonObject,
    maxResponseBytes = 64 * 1024,
  ): Promise<JsonValue> {
    if (
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > MAX_INTERNAL_GATEWAY_SNAPSHOT_BYTES
    ) {
      throw new Error("Gateway control response bound is outside the parent-owned limit");
    }
    const stack = this.#stack();
    const controlUrl = stack.publicReadiness.gateway.control_url;
    if (typeof controlUrl !== "string") throw new Error("Gateway readiness lacks control_url");
    const body = Buffer.from(JSON.stringify({ action, ...argumentsValue }), "utf8");
    let status: number;
    let bytes: Buffer;
    if (controlUrl.startsWith("https:")) {
      if (stack.tlsIdentity === undefined) {
        throw new Error("HTTPS Gateway control lacks supervised TLS identity");
      }
      ({ status, bytes } = await postHttpsControl(
        controlUrl,
        body,
        stack.tlsIdentity,
        maxResponseBytes,
      ));
    } else {
      const response = await fetch(controlUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rbp-test-control": "rbp-test-control",
        },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      status = response.status;
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length > maxResponseBytes) {
      throw new Error(`Gateway control response exceeds ${maxResponseBytes} bytes`);
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!isObject(parsed)) throw new Error("Gateway control response is not a JSON object");
    if (status !== 200) {
      throw new GatewayControlRequestError(action, status, parsed);
    }
    return parsed;
  }

  async compactGatewaySnapshot(): Promise<JsonObject> {
    const raw = await this.gatewayControl(
      "snapshot",
      {},
      MAX_INTERNAL_GATEWAY_SNAPSHOT_BYTES,
    );
    if (!isObject(raw)) throw new Error("Gateway snapshot is not an object");
    const compact = compactGatewaySnapshotValue(raw);
    if (Buffer.byteLength(JSON.stringify(compact), "utf8") > MAX_COMPACT_GATEWAY_SNAPSHOT_BYTES) {
      throw new Error("compact Gateway snapshot exceeds the 60 KiB observation bound");
    }
    return compact;
  }

  async gatewaySessionCount(): Promise<number> {
    const raw = await this.gatewayControl(
      "snapshot",
      {},
      MAX_INTERNAL_GATEWAY_SNAPSHOT_BYTES,
    );
    if (!isObject(raw)) throw new Error("Gateway snapshot is not an object");
    return isObject(raw.sessions) ? Object.keys(raw.sessions).length : 0;
  }

  async soakBridgeSnapshot(): Promise<JsonObject> {
    const raw = await this.jsonlControl("bridge_simulator", "snapshot_soak_status", {});
    if (
      !isObject(raw) ||
      raw.schemaVersion !== "bridge-simulator-soak-status/v1" ||
      !Number.isSafeInteger(raw.journalPendingCount) ||
      Number(raw.journalPendingCount) < 0 ||
      !Object.hasOwn(raw, "peer")
    ) {
      throw new Error("bridge_simulator soak status is malformed");
    }
    return raw;
  }

  async jsonlControl(
    componentId: "bridge_simulator" | "addin_loopback_fixture",
    action: string,
    argumentsValue: JsonObject,
    timeoutMs = 30_000,
  ): Promise<JsonValue> {
    if (componentId === "addin_loopback_fixture") {
      return await this.fixtureJsonlControl(0, action, argumentsValue, timeoutMs);
    }
    const control = this.component(componentId).jsonl;
    if (control === undefined) throw new Error(`${componentId} lacks JSONL control`);
    return await control.request(action, argumentsValue, timeoutMs);
  }

  async fixtureJsonlControl(
    fixtureIndex: number,
    action: string,
    argumentsValue: JsonObject,
    timeoutMs = 30_000,
  ): Promise<JsonValue> {
    if (!Number.isSafeInteger(fixtureIndex) || fixtureIndex < 0) {
      throw new Error("fixture control index must be a non-negative safe integer");
    }
    const stack = this.#stack();
    const component = fixtureIndex === 0
      ? stack.components.get("addin_loopback_fixture")
      : stack.extraFixtures[fixtureIndex - 1];
    if (component === undefined || component.componentId !== "addin_loopback_fixture") {
      throw new Error(`active stack lacks fixture control index ${fixtureIndex}`);
    }
    const control = component.jsonl;
    if (control === undefined) throw new Error(`fixture control index ${fixtureIndex} lacks JSONL control`);
    return await control.request(action, argumentsValue, timeoutMs);
  }

  async aggregateSnapshot(
    componentId: "bridge_simulator" | "addin_loopback_fixture",
    fixtureIndex = 0,
  ): Promise<JsonObject> {
    const arrayFields = componentId === "bridge_simulator"
      ? ["invocations", "holds", "durabilityEvents", "sessions", "sequences"]
      : ["observations", "executionCounts", "methodExecutionCounts", "pendingStalls"];
    let fields: Readonly<Record<string, JsonValue>> = {};
    let aggregate: JsonObject | undefined;
    for (let pageIndex = 0; pageIndex < MAX_SNAPSHOT_PAGES; pageIndex += 1) {
      const page = componentId === "addin_loopback_fixture"
        ? await this.fixtureJsonlControl(fixtureIndex, "snapshot_evidence", fields)
        : await this.jsonlControl(componentId, "snapshot_evidence", fields);
      if (!isObject(page)) throw new Error(`${componentId} snapshot page is not an object`);
      if (aggregate === undefined) {
        aggregate = structuredClone(page);
        for (const field of arrayFields) aggregate[field] = [];
        if (componentId === "bridge_simulator") {
          const artifactSpool = aggregate.artifactSpool;
          if (!isObject(artifactSpool) || !Array.isArray(artifactSpool.carriers)) {
            throw new Error("bridge_simulator snapshot page lacks artifactSpool.carriers");
          }
          artifactSpool.carriers = [];
        }
      }
      for (const field of arrayFields) {
        const values = page[field];
        if (!Array.isArray(values)) throw new Error(`${componentId} snapshot page lacks ${field}`);
        (aggregate[field] as JsonValue[]).push(...structuredClone(values));
      }
      if (componentId === "bridge_simulator") {
        const pageSpool = page.artifactSpool;
        const aggregateSpool = aggregate.artifactSpool;
        if (
          !isObject(pageSpool) ||
          !Array.isArray(pageSpool.carriers) ||
          !isObject(aggregateSpool) ||
          !Array.isArray(aggregateSpool.carriers)
        ) {
          throw new Error("bridge_simulator artifact spool pagination is malformed");
        }
        aggregateSpool.carriers.push(...structuredClone(pageSpool.carriers));
        aggregateSpool.carrierOffset = 0;
        aggregateSpool.carrierPageCount = aggregateSpool.carriers.length;
      }
      if (Buffer.byteLength(JSON.stringify(aggregate), "utf8") > MAX_AGGREGATED_SNAPSHOT_BYTES) {
        throw new Error(`${componentId} aggregated snapshot exceeds 4 MiB`);
      }
      if (page.complete === true) {
        aggregate.complete = true;
        aggregate.nextCursor = null;
        return aggregate;
      }
      if (typeof page.snapshotId !== "string" || !isObject(page.nextCursor)) {
        throw new Error(`${componentId} snapshot continuation is malformed`);
      }
      fields = {
        snapshotId: page.snapshotId,
        cursor: page.nextCursor,
      };
    }
    throw new Error(`${componentId} snapshot pagination exceeded ${MAX_SNAPSHOT_PAGES} pages`);
  }

  async awaitCondition(input: {
    source: string;
    jsonPointer: string;
    operator: string;
    expected?: JsonValue;
    timeoutMs: number;
    intervalMs?: number;
  }): Promise<JsonObject> {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 300_000) {
      throw new Error("await_condition timeoutMs is outside the parent bound");
    }
    const intervalMs = input.intervalMs ?? 25;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_000) {
      throw new Error("await_condition intervalMs is outside the parent bound");
    }
    const deadline = Date.now() + input.timeoutMs;
    let attempts = 0;
    let lastSnapshot: JsonObject | undefined;
    while (Date.now() <= deadline) {
      attempts += 1;
      const snapshot = await this.#conditionSource(input.source);
      lastSnapshot = snapshot;
      const value = jsonPointer(snapshot, input.jsonPointer);
      if (conditionMatches(input.operator, value, input.expected)) {
        return {
          matched: true,
          attempts,
          source: input.source,
          jsonPointer: input.jsonPointer,
          operator: input.operator,
          expected: input.expected ?? null,
          observed: value ?? null,
          snapshot,
          dynamic: dynamicValues(snapshot),
        };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `await_condition timed out after ${input.timeoutMs} ms; last=${JSON.stringify(lastSnapshot ?? null)}`,
    );
  }

  #stack(): ActiveStack {
    if (this.#active === null) throw new Error("case stack is not active");
    return this.#active;
  }

  #componentPlan(componentId: ComponentId): PlannedComponent {
    const component = this.#plan.components.find(({ id }) => id === componentId);
    if (component === undefined) throw new Error(`execution plan lacks ${componentId}`);
    return component;
  }

  #privateInstanceRoot(caseId: string, binding: Binding): string {
    const root = mkdtempSync(path.join(tmpdir(), `rbp-${this.#plan.runId}-${caseId}-${binding}-`));
    chmodSync(root, PRIVATE_DIRECTORY_MODE);
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("case-stack instance root is not a plain directory");
    }
    return root;
  }

  #removeComponentState(
    stack: ActiveStack,
    componentId: "gateway_stub" | "bridge_simulator",
  ): void {
    const candidate = componentId === "gateway_stub"
      ? path.join(stack.instanceRoot, "state", "gateway.json")
      : path.join(stack.instanceRoot, "state", "bridge");
    const relative = path.relative(stack.instanceRoot, path.resolve(candidate));
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`refusing to clear ${componentId} state outside its exact instance root`);
    }
    rmSync(candidate, {
      recursive: componentId === "bridge_simulator",
      force: true,
    });
  }

  async #startComponent(
    component: PlannedComponent,
    tokens: Readonly<Record<string, string>>,
    gatewayOverrides: GatewayStartupOverrides | undefined,
    tlsIdentity?: EphemeralTlsIdentity,
    scalarOverrides: Readonly<Record<string, string | number>> = {},
  ): Promise<StartedStackComponent> {
    let command = expandedCommand(component.command, tokens);
    if (component.id === "gateway_stub") {
      command = withGatewayOverrides(command, gatewayOverrides, tlsIdentity);
    }
    for (const [flag, value] of Object.entries(scalarOverrides)) {
      if (!/^--[a-z0-9-]+$/u.test(flag)) {
        throw new Error(`component scalar override flag is invalid: ${flag}`);
      }
      command = { ...command, args: setCliScalarArgument(command.args, flag, value) };
    }
    const cwd = confinedWorkingDirectory(this.#repoRoot, command);
    const identity = observedIdentity(component, command, cwd);
    if (command.readiness.kind !== "stdout_pattern") {
      throw new Error(`${component.id} must expose supervised JSON stdout readiness`);
    }
    const environment: Record<string, string | undefined> = {};
    for (const key of command.environmentKeys) environment[key] = this.#environment[key];
    this.#assertRuntimeLaunchCurrent();

    if (component.id === "gateway_stub") {
      const processHandle = await StrictReadyProcess.start({
        componentId: component.id,
        command,
        absoluteWorkingDirectory: cwd,
        environment,
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
        if (processHandle.readiness.pid !== processHandle.pid) {
          throw new Error("Gateway readiness PID does not match the spawned child");
        }
        this.#assertRuntimeLaunchCurrent();
      } catch (error) {
        return await stopAfterLaunchFailure(processHandle, error, "Gateway");
      }
      return {
        componentId: component.id,
        identity,
        pid: processHandle.pid,
        process: processHandle.process,
        readiness: processHandle.readiness,
        stop: async () => {
          const stopped = await processHandle.stop(
            command.shutdown.signal === "SIGINT" ? "SIGINT" : "SIGTERM",
            command.shutdown.timeoutMs,
          );
          return { killEscalated: stopped.killEscalated };
        },
      };
    }

    const isBridge = component.id === "bridge_simulator";
    const processHandle = await StrictJsonlProcess.start({
      componentId: component.id,
      command,
      absoluteWorkingDirectory: cwd,
      environment,
      expectedReadinessFields: isBridge
        ? {
            component: "bridge-simulator",
            componentRole: "O1-T4",
            contract: "bridge-simulator-control/v1",
          }
        : { contract: "addin-loopback/v1" },
      requiredActions: isBridge
        ? ["snapshot_soak_status", "snapshot_evidence", "shutdown"]
        : ["snapshot_evidence", "shutdown"],
    });
    try {
      if (isBridge && processHandle.readiness.pid !== processHandle.pid) {
        throw new Error("Bridge readiness PID does not match the spawned child");
      }
      this.#assertRuntimeLaunchCurrent();
    } catch (error) {
      return await stopAfterLaunchFailure(processHandle, error, component.id);
    }
    return {
      componentId: component.id,
      identity,
      pid: processHandle.pid,
      process: processHandle.process,
      readiness: processHandle.readiness,
      jsonl: processHandle,
      stop: async () => {
        const stopped = await processHandle.stop();
        return { killEscalated: stopped.killEscalated };
      },
    };
  }

  #lifecycleObservation(
    component: StartedStackComponent,
    stepId: string,
    action: string,
    phase: "started" | "stopped",
    cleanup: {
      orphanProcessCount: number;
      survivingPids: readonly number[];
      killEscalated: boolean;
      stopOrder: readonly ComponentId[];
      preserveState?: boolean;
    },
  ): ProcessObservationRecord {
    const stack = this.#stack();
    const auxiliaryIndex = stack.extraFixtures.findIndex(
      (candidate) => candidate === component,
    );
    return {
      schemaVersion: "rbp-process-observation/v2",
      observationId: `${this.#plan.runId}:${stack.caseId}:${stack.binding}:stack:${++this.#observationOrdinal}`,
      runId: this.#plan.runId,
      caseId: stack.caseId,
      binding: stack.binding,
      componentId: component.componentId,
      kind: "process_lifecycle",
      at: new Date().toISOString(),
      payload: {
        schemaVersion: "rbp-supervised-process-lifecycle/v2",
        stepId,
        action,
        spawnOwner: "parent_runner",
        processRole: auxiliaryIndex >= 0 ? "auxiliary_fixture" : "canonical_component",
        auxiliaryIndex: auxiliaryIndex >= 0 ? auxiliaryIndex + 1 : null,
        phase,
        instanceRootId: stack.instanceRootId,
        identity: component.identity,
        process: { ...component.process },
        orphanProcessCount: cleanup.orphanProcessCount,
        survivingPids: [...cleanup.survivingPids],
        killEscalated: cleanup.killEscalated,
        stopOrder: [...cleanup.stopOrder],
        preserveState: cleanup.preserveState ?? null,
      },
    };
  }

  async #conditionSource(source: string): Promise<JsonObject> {
    const fixtureMatch = /^fixture\.snapshot_evidence(?:\.([0-9]+))?$/u.exec(source);
    if (fixtureMatch !== null) {
      return await this.aggregateSnapshot(
        "addin_loopback_fixture",
        fixtureMatch[1] === undefined ? 0 : Number(fixtureMatch[1]),
      );
    }
    switch (source) {
      case "bridge.snapshot_evidence":
      case "bridge_reconnect_schedule":
        return await this.aggregateSnapshot("bridge_simulator");
      case "gateway.snapshot":
        return await this.gatewayControl("snapshot", {}) as JsonObject;
      case "gateway.compact_snapshot":
        return await this.compactGatewaySnapshot();
      case "wire_capture":
        return this.wireCapture() as unknown as JsonObject;
      default:
        throw new Error(`await_condition source is not implemented: ${source}`);
    }
  }
}

function jsonPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error("await_condition JSON pointer must start with /");
  let current: JsonValue | undefined = value;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function conditionMatches(operator: string, value: JsonValue | undefined, expected: JsonValue | undefined): boolean {
  switch (operator) {
    case "exists":
      return value !== undefined && value !== null;
    case "equals":
      return JSON.stringify(value) === JSON.stringify(expected);
    case "not_equals":
      return value !== undefined && JSON.stringify(value) !== JSON.stringify(expected);
    case "count_equals":
      return Array.isArray(value) && value.length === expected;
    case "minimum_count":
      return Array.isArray(value) && typeof expected === "number" && value.length >= expected;
    case "crosses":
      return typeof value === "number" && typeof expected === "number" && value >= expected;
    default:
      throw new Error(`await_condition operator is not implemented: ${operator}`);
  }
}

function dynamicValues(snapshot: JsonObject): JsonObject {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const rsids = sessions
    .filter(isObject)
    .map((session) => session.rsid)
    .filter((rsid): rsid is string => typeof rsid === "string");
  const firstSession = sessions.find(isObject);
  const sequences = Array.isArray(snapshot.sequences) ? snapshot.sequences : [];
  const firstSequence = sequences.find(isObject);
  const rsid = typeof firstSession?.rsid === "string" ? firstSession.rsid : null;
  const lastRxSeq = Number.isSafeInteger(firstSequence?.lastRxSeq) ? Number(firstSequence?.lastRxSeq) : 0;
  const lastPeerAck = Number.isSafeInteger(firstSequence?.lastPeerAck) ? Number(firstSequence?.lastPeerAck) : 0;
  return {
    rsid,
    rsids,
    nextSeq: lastRxSeq + 1,
    lastAck: lastPeerAck,
    grantedSessionCapabilities: Array.isArray(firstSession?.grantedSessionCapabilities)
      ? firstSession.grantedSessionCapabilities
      : [],
  };
}
