import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

import {
  StrictJsonlProcess,
  StrictReadyProcess,
  type JsonObject,
  type JsonValue,
  type ProcessTranscriptRecord,
} from "./processHarness.js";
import type { ProcessCommandDescriptor } from "./types.js";
import {
  assertRealBridgeWorkerExecutable,
  validateRealTrioAttestation,
  type RealTrioAttestation,
  type RealTrioProcessIdentity,
} from "./realTrioAttestation.js";
import { stableJson } from "./stableJson.js";

export const REAL_TRIO_SUPERVISOR_SCHEMA = "rbp-real-trio-supervisor/v1" as const;
export const REAL_TRIO_FAILURE_DIAGNOSTICS_SCHEMA =
  "rbp-real-trio-failure-diagnostics/v1" as const;
const MAX_REAL_TRIO_DIAGNOSTIC_RECORDS = 16;
const MAX_REAL_TRIO_READINESS_TRACE = 64;

export interface RealTrioSupervisorCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: string;
}

export interface RealTrioSupervisorLaunch {
  readonly gateway: RealTrioSupervisorCommand;
  readonly bridgeWorker: RealTrioSupervisorCommand;
  readonly fixture: RealTrioSupervisorCommand;
  readonly gatewayExpected: Readonly<Record<string, JsonValue>>;
  readonly fixtureExpected: Readonly<Record<string, JsonValue>>;
  readonly csharpPublishPath: string;
  readonly gatewayBuildPath: string;
  readonly fixtureBuildPath: string;
  /** Out-of-band test secret used only on the Gateway's public loopback control route. */
  readonly gatewayControlToken: string;
}

export interface RealTrioSupervisorResult {
  readonly schemaVersion: typeof REAL_TRIO_SUPERVISOR_SCHEMA;
  readonly attestation: RealTrioAttestation;
  readonly gatewayReadiness: JsonObject;
  readonly bridgeReadiness: JsonObject;
  readonly fixtureReadiness: JsonObject;
  readonly sessionReadiness: RealTrioSessionReadiness;
  readonly stop: () => Promise<void>;
}

export interface RealTrioSessionReadiness {
  readonly rsid: string;
  readonly localSessionKey: string;
  readonly grantedCapabilities: readonly string[];
}

export interface RbpSessionReadinessPollOptions {
  readonly readSnapshot: () => Promise<JsonObject>;
  readonly expectedBinding: "wss" | "streamable_http_sse";
  readonly isBridgeExited: () => boolean;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface RealTrioFailureDiagnostics {
  readonly schemaVersion: typeof REAL_TRIO_FAILURE_DIAGNOSTICS_SCHEMA;
  /** Last 32 public Gateway audits, reduced to value-free session state. */
  readonly gatewayAudits: readonly JsonObject[];
  /** Only schema-valid value-free worker observations are retained. */
  readonly bridgeTranscript: readonly ProcessTranscriptRecord[];
  readonly readinessTrace: readonly RealTrioReadinessTrace[];
}

export interface RealTrioReadinessTrace {
  readonly outcome: "VALID" | "NO_ROW" | "MULTIPLE" | "LEGACY" | "INVALID_BINDING" | "RSID_MISMATCH" | "MISSING_BATCH" | "INVALID_LIFECYCLE" | "ERROR_TYPE";
  readonly fingerprint: string | null;
  readonly rsidEqual: boolean | null;
  readonly batchAtomicPresent: boolean;
  readonly grantOrderHash: string | null;
  readonly stableCount: number;
  readonly resetReason: "initial" | "fingerprint_changed" | "invalid" | "error";
}

function boundedText(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

function redactGatewayAudit(snapshot: JsonObject): JsonObject {
  const rows = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const namespaces = rows
    .filter(isObject)
    .map((row) => boundedText(row.namespace, 128))
    .filter((value): value is string => value !== null)
    .slice(0, MAX_REAL_TRIO_DIAGNOSTIC_RECORDS);
  const sessions = rows
    .filter(isObject)
    .slice(0, MAX_REAL_TRIO_DIAGNOSTIC_RECORDS)
    .map((row) => {
      const value = isObject(row.value) ? row.value : {};
      const binding = isObject(value.binding) ? value.binding : {};
      const lifecycle = isObject(value.lifecycle) ? value.lifecycle : {};
      const sessionLifecycle = isObject(lifecycle.sessionLifecycle)
        ? lifecycle.sessionLifecycle
        : {};
      return {
        binding: boundedText(binding.binding, 64) ?? "unknown",
        lifecyclePhase: boundedText(sessionLifecycle.phase, 64) ?? "unknown",
        dispatchAllowed: sessionLifecycle.dispatchAllowed === true,
        localKeyPresent: boundedText(sessionLifecycle.localSessionKey, 512) !== null,
        created: lifecycle.createdAtMs !== undefined,
        updated: lifecycle.updatedAtMs !== undefined,
      };
    });
  return Object.freeze({
    sessionCount: rows.length,
    namespaces: [...namespaces],
    sessions,
  });
}

function redactBridgeTranscript(
  transcript: readonly ProcessTranscriptRecord[],
): readonly ProcessTranscriptRecord[] {
  const retained: ProcessTranscriptRecord[] = [];
  for (const record of transcript.slice(-MAX_REAL_TRIO_DIAGNOSTIC_RECORDS)) {
    if (record.stream !== "stderr") continue;
    try {
      const parsed = JSON.parse(record.line) as unknown;
      if (!isObject(parsed) ||
          parsed.contractVersion !== "revagent.wp12-real-worker-observation/v1" ||
          parsed.event !== "bridge.connection_failure_observation" ||
          !["wss", "streamable_http_sse"].includes(parsed.binding as string) ||
          parsed.state !== "retry_paused" || parsed.reason !== "authorization_refusal") continue;
      const timestamp = boundedText(parsed.timestamp, 64);
      if (timestamp === null) continue;
      retained.push(Object.freeze({
        stream: "stderr",
        at: boundedText(record.at, 64) ?? "",
        line: stableJson({
          contractVersion: parsed.contractVersion,
          event: parsed.event,
          timestamp,
          binding: parsed.binding,
          state: parsed.state,
          reason: parsed.reason,
        }),
      }));
    } catch {
      // Raw stderr is not evidence: it may contain an endpoint, path, or secret.
    }
  }
  return Object.freeze(retained);
}

export class RealTrioSessionReadinessPollError extends Error {
  public constructor(
    message: string,
    readonly audits: readonly JsonObject[],
    /** The final public Gateway v2/audit observation at the bounded deadline. */
    readonly lastGatewayAudit: JsonObject | null = audits.at(-1) ?? null,
    /** Real C# carrier stdout/stderr retained without reading its private state. */
    readonly bridgeReceiveTranscript: readonly ProcessTranscriptRecord[] = [],
    readonly readinessTrace: readonly RealTrioReadinessTrace[] = [],
  ) {
    super(message);
  }

  public get failureDiagnostics(): RealTrioFailureDiagnostics {
    const audits = this.audits.length > 0
      ? this.audits
      : this.lastGatewayAudit === null ? [] : [this.lastGatewayAudit];
    return Object.freeze({
      schemaVersion: REAL_TRIO_FAILURE_DIAGNOSTICS_SCHEMA,
      gatewayAudits: audits
        .slice(-32)
        .map((audit) => redactGatewayAudit(audit)),
      bridgeTranscript: redactBridgeTranscript(this.bridgeReceiveTranscript),
      readinessTrace: Object.freeze([...this.readinessTrace].slice(-MAX_REAL_TRIO_READINESS_TRACE)),
    });
  }
}

function hashPrefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function traceReadinessSnapshot(
  snapshot: JsonObject,
  expectedBinding: "wss" | "streamable_http_sse",
  stableCount: number,
  priorFingerprint: string | null,
): RealTrioReadinessTrace {
  const invalid = (outcome: Exclude<RealTrioReadinessTrace["outcome"], "VALID">, resetReason: "invalid" | "error" = "invalid"): RealTrioReadinessTrace => ({ outcome, fingerprint: null, rsidEqual: null, batchAtomicPresent: false, grantOrderHash: null, stableCount: 0, resetReason });
  const rows = snapshot.sessions;
  if (!Array.isArray(rows) || rows.length === 0) return invalid("NO_ROW");
  if (rows.length !== 1) return invalid("MULTIPLE");
  const row = rows[0];
  if (!isObject(row) || row.namespace !== "gateway.rbp-session/v2" || !isObject(row.value) || row.value.schema !== "gateway.rbp-session/v2") return invalid("LEGACY");
  const value = row.value;
  if (typeof value.rsid !== "string" || !isObject(value.binding) || !isObject(value.lifecycle) || !isObject(value.lifecycle.sessionLifecycle)) return invalid("ERROR_TYPE", "error");
  const binding = value.binding;
  if (binding.binding !== expectedBinding) return invalid("INVALID_BINDING");
  const lifecycle = value.lifecycle.sessionLifecycle;
  if (typeof lifecycle.rsid !== "string" || lifecycle.rsid !== value.rsid) return invalid("RSID_MISMATCH");
  if (!Array.isArray(binding.grantedCapabilities) || !binding.grantedCapabilities.every((item) => typeof item === "string")) return invalid("ERROR_TYPE", "error");
  const grants = binding.grantedCapabilities as string[];
  if (!grants.includes("batch_atomic")) return invalid("MISSING_BATCH");
  if (typeof lifecycle.localSessionKey !== "string" || lifecycle.localSessionKey.length === 0 || lifecycle.phase !== "registered" || lifecycle.dispatchAllowed !== true) return invalid("INVALID_LIFECYCLE");
  const fingerprint = hashPrefix(`${value.rsid}\u0000${lifecycle.localSessionKey}\u0000${grants.join("\u0001")}`);
  const nextStable = fingerprint === priorFingerprint ? stableCount + 1 : 1;
  return Object.freeze({ outcome: "VALID", fingerprint, rsidEqual: true, batchAtomicPresent: true, grantOrderHash: hashPrefix(grants.join("\u0001")), stableCount: nextStable, resetReason: priorFingerprint === null ? "initial" : fingerprint === priorFingerprint ? "initial" : "fingerprint_changed" });
}

/** Extracts the bounded, redacted real-process diagnostics through error wraps. */
export function realTrioFailureDiagnostics(error: unknown): RealTrioFailureDiagnostics | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof RealTrioSessionReadinessPollError) return current.failureDiagnostics;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

function sha256File(path: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function command(input: RealTrioSupervisorCommand): ProcessCommandDescriptor {
  return {
    executable: input.executable,
    args: [...input.args],
    workingDirectory: input.workingDirectory,
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "ready", timeoutMs: 30_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 10_000 },
  };
}

function replaceTokens(input: RealTrioSupervisorCommand, values: Readonly<Record<string, string>>): RealTrioSupervisorCommand {
  const replace = (value: string): string => Object.entries(values).reduce((current, [token, replacement]) => current.replaceAll(`{{${token}}}`, replacement), value);
  return { executable: replace(input.executable), args: input.args.map(replace), workingDirectory: replace(input.workingDirectory) };
}

/**
 * Derive the bridge route from the Gateway READY origin. The child owns the
 * origin (and its DER pin); this supervisor owns the fixed bridge route.
 * Keeping the route here prevents a READY payload from smuggling a different
 * loopback path, credentials, query, or fragment into the real C# carrier.
 */
export function bridgeEndpointForBinding(endpoint: string, workerArgs: readonly string[]): string {
  const index = workerArgs.indexOf("--binding");
  const binding = index < 0 ? undefined : workerArgs[index + 1];
  if (binding !== "wss" && binding !== "streamable_http_sse") throw new Error("real worker command lacks one supported binding");
  let ready: URL;
  try {
    ready = new URL(endpoint);
  } catch {
    throw new Error("real trio Gateway READY endpoint is malformed");
  }
  if (ready.protocol !== "https:") throw new Error("real trio Gateway READY endpoint is not HTTPS");
  if (ready.hostname !== "127.0.0.1" || ready.port.length === 0) throw new Error("real trio Gateway endpoint is not numeric loopback with an explicit port");
  if (ready.username.length > 0 || ready.password.length > 0) throw new Error("real trio Gateway READY endpoint must not contain userinfo");
  if (ready.search.length > 0 || ready.hash.length > 0) throw new Error("real trio Gateway READY endpoint must not contain query or fragment");
  if (ready.pathname !== "/" && ready.pathname !== "/bridge/v1") throw new Error("real trio Gateway READY endpoint has an unexpected path");

  const bridge = new URL(`https://localhost:${ready.port}/bridge/v1`);
  bridge.protocol = binding === "wss" ? "wss:" : "https:";
  return bridge.toString().replace(/\/$/u, "");
}

/**
 * Binds the C# test host to the exact process and IPv4 endpoint that emitted
 * the fixture's strict READY record.  This is intentionally separate from
 * the bridge endpoint derivation: a fixture cannot substitute a hostname,
 * IPv6 address, or a stale process id through token replacement.
 */
export function fixtureAttestationTokens(
  readiness: JsonObject,
  processId: number,
): Readonly<Record<"fixture_port" | "fixture_pid", string>> {
  if (readiness.host !== "127.0.0.1") {
    throw new Error("real trio fixture READY host is not exact IPv4 loopback");
  }
  const port = readiness.port;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("real trio fixture readiness lacks an exact loopback port");
  }
  if (!Number.isSafeInteger(processId) || processId < 1) {
    throw new Error("real trio fixture process lacks an exact pid");
  }
  return Object.freeze({ fixture_port: String(port), fixture_pid: String(processId) });
}

/**
 * The real-worker command is a closed test-only contract.  Requiring both
 * placeholders before starting it means malformed fixture identity cannot
 * create a bridge connection and therefore cannot register a catalog route.
 */
export function fixtureAttestedWorkerCommand(
  worker: RealTrioSupervisorCommand,
  tokens: Readonly<Record<"fixture_port" | "fixture_pid", string>>,
): RealTrioSupervisorCommand {
  const required: ReadonlyArray<readonly [string, string]> = [
    ["--addin-port", "{{fixture_port}}"],
    ["--fixture-pid", "{{fixture_pid}}"],
  ];
  for (const [key, placeholder] of required) {
    const indexes = worker.args
      .map((entry, index) => entry === key ? index : -1)
      .filter((index) => index >= 0);
    if (indexes.length !== 1 || worker.args[indexes[0]! + 1] !== placeholder) {
      throw new Error(`real worker command does not bind exact ${key} fixture attestation input`);
    }
  }
  return replaceTokens(worker, tokens);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads only normalized v2 session rows from the conformance audit.  Older
 * top-level capability shapes are deliberately not tolerated: the durable
 * schema places grants in value.binding.grantedCapabilities.
 */
export function readRbpSessionV2Readiness(
  snapshot: JsonObject,
  expectedBinding: "wss" | "streamable_http_sse",
): RealTrioSessionReadiness {
  const rows = snapshot.sessions;
  if (!Array.isArray(rows) || rows.length !== 1 || !isObject(rows[0])) {
    throw new Error("real trio session audit lacks one normalized v2 session row");
  }
  const row = rows[0];
  if (row.namespace !== "gateway.rbp-session/v2" || !isObject(row.value)) {
    throw new Error("real trio session audit contains a legacy or malformed session row");
  }
  const value = row.value;
  if (value.schema !== "gateway.rbp-session/v2" || typeof value.rsid !== "string" || value.rsid.length === 0 ||
      !isObject(value.binding) || !isObject(value.lifecycle) || !isObject(value.lifecycle.sessionLifecycle)) {
    throw new Error("real trio v2 session row is malformed");
  }
  if (value.binding.binding !== expectedBinding || !Array.isArray(value.binding.grantedCapabilities) ||
      !value.binding.grantedCapabilities.every((capability) => typeof capability === "string") ||
      !value.binding.grantedCapabilities.includes("batch_atomic")) {
    throw new Error("real trio v2 session binding or nested grants are invalid");
  }
  const lifecycle = value.lifecycle.sessionLifecycle;
  const localSessionKey = lifecycle.localSessionKey;
  if (typeof localSessionKey !== "string" || localSessionKey.length === 0 ||
      typeof lifecycle.phase !== "string" || typeof lifecycle.dispatchAllowed !== "boolean" ||
      typeof lifecycle.rsid !== "string") {
    throw new Error("real trio v2 session row is malformed");
  }
  if (lifecycle.phase !== "registered" || lifecycle.dispatchAllowed !== true || lifecycle.rsid !== value.rsid) {
    throw new Error("real trio v2 session is not active with a local session key");
  }
  return Object.freeze({
    rsid: value.rsid,
    localSessionKey,
    grantedCapabilities: Object.freeze([...value.binding.grantedCapabilities]),
  });
}

/**
 * Polls only the Gateway's public loopback audit route after the real worker
 * has reached READY. Two equal observations prevent a transient migration
 * view from qualifying as smoke evidence; bounded retained audits explain a
 * timeout without reaching into the protocol store or database.
 */
export async function pollRbpSessionV2Readiness(
  options: RbpSessionReadinessPollOptions,
): Promise<RealTrioSessionReadiness> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 150;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 250) {
    throw new Error("real trio session readiness poll bounds are invalid");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (async (milliseconds: number) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const audits: JsonObject[] = [];
  const trace: RealTrioReadinessTrace[] = [];
  let previous: string | null = null;
  let identicalObservations = 0;
  for (;;) {
    if (options.isBridgeExited()) {
      throw new RealTrioSessionReadinessPollError("real trio bridge exited before session readiness", Object.freeze([...audits]), undefined, [], Object.freeze([...trace]));
    }
    const snapshot = await options.readSnapshot();
    if (audits.length === 32) audits.shift();
    audits.push(snapshot);
    const classified = traceReadinessSnapshot(
      snapshot,
      options.expectedBinding,
      identicalObservations,
      previous,
    );
    if (trace.length === MAX_REAL_TRIO_READINESS_TRACE) trace.shift();
    trace.push(classified);
    try {
      const current = readRbpSessionV2Readiness(snapshot, options.expectedBinding);
      const fingerprint = stableJson(current);
      identicalObservations = fingerprint === previous ? identicalObservations + 1 : 1;
      previous = fingerprint;
      if (identicalObservations >= 2) return current;
    } catch {
      previous = null;
      identicalObservations = 0;
    }
    if (now() - startedAt >= timeoutMs) {
      throw new RealTrioSessionReadinessPollError("real trio session readiness timed out", Object.freeze([...audits]), undefined, [], Object.freeze([...trace]));
    }
    await sleep(intervalMs);
  }
}

async function publicGatewayControl(
  endpoint: string,
  controlToken: string,
  expectedCertificateSha256: string,
  action: "issue_device_credential" | "snapshot_audit",
): Promise<JsonObject> {
  const url = new URL("/__conformance/v1/control", endpoint);
  const payload = Buffer.from(JSON.stringify({ action }), "utf8");
  return await new Promise<JsonObject>((resolve, reject) => {
    const operation = httpsRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", rejectUnauthorized: false, headers: { "content-type": "application/json", "content-length": payload.byteLength, "x-rbp-test-control": controlToken } }, (response) => {
      const peer = (response.socket as TLSSocket).getPeerCertificate(true).raw as Buffer | undefined;
      const observed = peer === undefined ? null : `sha256:${createHash("sha256").update(peer).digest("hex")}`;
      if (observed !== expectedCertificateSha256) { response.resume(); reject(new Error("Gateway control TLS pin mismatch")); return; }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
          if (response.statusCode !== 200 || body.ok !== true || body.action !== action) throw new Error("Gateway public control refused request");
          resolve(body);
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    operation.once("error", reject);
    operation.end(payload);
  });
}

function transcriptHash(process: StrictJsonlProcess | StrictReadyProcess, stream: "stdout" | "stderr"): `sha256:${string}` {
  const records = process.transcript.filter((record) => record.stream === stream);
  return `sha256:${createHash("sha256").update(stableJson(records)).digest("hex")}`;
}

function processIdentity(
  componentId: RealTrioProcessIdentity["componentId"],
  executablePath: string,
  process: StrictJsonlProcess | StrictReadyProcess,
): RealTrioProcessIdentity {
  if (process.process.exitCode !== 0) {
    throw new Error(`real trio ${componentId} is not cleanly stopped`);
  }
  return Object.freeze({
    componentId,
    executablePath,
    executableSha256: sha256File(executablePath),
    pid: process.pid,
    exitCode: process.process.exitCode,
    stdoutSha256: transcriptHash(process, "stdout"),
    stderrSha256: transcriptHash(process, "stderr"),
  });
}

/**
 * Supervises only actual processes. It has no response simulator and cannot
 * manufacture a case outcome: WSS/HTTP-SSE callers must use the public
 * binding drivers against the Gateway endpoint advertised by the child.
 */
export async function startRealTrioSupervisor(input: RealTrioSupervisorLaunch): Promise<RealTrioSupervisorResult> {
  const bridgeExecutable = assertRealBridgeWorkerExecutable(input.bridgeWorker.executable);
  const gateway = await StrictReadyProcess.start({
    componentId: "gateway_stub",
    command: command(input.gateway),
    absoluteWorkingDirectory: input.gateway.workingDirectory,
    useTestSignalProxy: true,
    validateReadiness(value) {
      for (const [key, expected] of Object.entries(input.gatewayExpected)) {
        if (JSON.stringify(value[key]) !== JSON.stringify(expected)) throw new Error(`Gateway readiness ${key} is not exact`);
      }
      if (value.component !== "gateway_production_conformance" || typeof value.endpoint !== "string" || !value.endpoint.startsWith("https://127.0.0.1:")) throw new Error("real trio Gateway readiness is not a loopback production composition");
    },
  });
  try {
    const endpoint = gateway.readiness.endpoint;
    const certificateSha256 = gateway.readiness.tlsCertificateSha256;
    if (typeof endpoint !== "string" || typeof certificateSha256 !== "string") throw new Error("Gateway readiness lacks endpoint pin");
    try {
      const fixture = await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command(input.fixture),
        absoluteWorkingDirectory: input.fixture.workingDirectory,
        expectedReadinessFields: input.fixtureExpected,
        requiredActions: ["snapshot_evidence", "shutdown"],
      });
      try {
        const fixtureTokens = fixtureAttestationTokens(fixture.readiness, fixture.pid);
        const credential = await publicGatewayControl(endpoint, input.gatewayControlToken, certificateSha256, "issue_device_credential");
        if (typeof credential.deviceId !== "string" || typeof credential.deviceProof !== "string") throw new Error("Gateway public control did not issue a bridge credential");
        const fixtureBoundWorker = fixtureAttestedWorkerCommand(input.bridgeWorker, fixtureTokens);
        const bridge = await StrictJsonlProcess.start({
          componentId: "bridge_simulator",
          command: command(replaceTokens({ ...fixtureBoundWorker, executable: bridgeExecutable }, {
            gateway_endpoint: bridgeEndpointForBinding(endpoint, input.bridgeWorker.args),
            gateway_certificate_sha256: certificateSha256.replace("sha256:", ""),
            device_id: credential.deviceId,
            device_proof: credential.deviceProof,
          })),
          absoluteWorkingDirectory: input.bridgeWorker.workingDirectory,
          expectedReadinessFields: { component: "bridge_worker", contract: "wp12-real-worker-host/v1" },
          requiredActions: ["shutdown"],
        });
        const binding = input.bridgeWorker.args[input.bridgeWorker.args.indexOf("--binding") + 1];
        if (binding !== "wss" && binding !== "streamable_http_sse") {
          throw new Error("real worker command lacks one supported binding");
        }
        let sessionReadiness: RealTrioSessionReadiness;
        try {
          sessionReadiness = await pollRbpSessionV2Readiness({
            expectedBinding: binding,
            isBridgeExited: () => bridge.process.exitCode !== null,
            readSnapshot: async () => await publicGatewayControl(
              endpoint,
              input.gatewayControlToken,
              certificateSha256,
              "snapshot_audit",
            ),
          });
        } catch (error) {
          if (error instanceof RealTrioSessionReadinessPollError) {
            throw new RealTrioSessionReadinessPollError(
              error.message,
              error.audits,
              error.lastGatewayAudit,
              Object.freeze([...bridge.transcript]),
              error.readinessTrace,
            );
          }
          throw error;
        }
        let stopped = false;
        const stop = async (): Promise<void> => {
          if (stopped) return;
          stopped = true;
          const bridgeStop = await bridge.stop();
          const fixtureStop = await fixture.stop();
          const gatewayStop = await gateway.stop();
          if (fixtureStop.exitCode !== 0 || bridgeStop.exitCode !== 0 || gatewayStop.exitCode !== 0 || fixtureStop.killEscalated || bridgeStop.killEscalated || gatewayStop.killEscalated) throw new Error("real trio did not close cleanly");
        };
        return Object.freeze({
        schemaVersion: REAL_TRIO_SUPERVISOR_SCHEMA,
        get attestation(): RealTrioAttestation {
          if (!stopped) throw new Error("real trio attestation is unavailable before exact clean STOP");
          const value: RealTrioAttestation = {
            schemaVersion: "rbp-real-trio-attestation/v1", bindings: ["wss", "streamable_http_sse"],
            components: [processIdentity("gateway", input.gateway.executable, gateway), processIdentity("bridge_worker", bridgeExecutable, bridge), processIdentity("addin_loopback_fixture", input.fixture.executable, fixture)],
            csharpPublishSha256: sha256File(input.csharpPublishPath), gatewayBuildSha256: sha256File(input.gatewayBuildPath), fixtureBuildSha256: sha256File(input.fixtureBuildPath),
          };
          validateRealTrioAttestation(value);
          return value;
        },
        gatewayReadiness: gateway.readiness,
        bridgeReadiness: bridge.readiness,
        fixtureReadiness: fixture.readiness,
        sessionReadiness,
        stop,
        });
      } catch (error) { await fixture.stop(); throw error; }
    } catch (error) { throw error; }
  } catch (error) { await gateway.stop(); throw error; }
}
