import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  issueNorthCredentialControlPayload,
  type RealTrioNorthCredential,
} from "../src/realTrioCaseDriver.js";
import {
  publicGatewayControl,
  startRealTrioSupervisor,
  type RealTrioBinding,
  type RealTrioDocumentContextCursorRow,
  type RealTrioDocumentContextSnapshot,
  type RealTrioDocumentContextFailureState,
  type RealTrioAuditControlFailure,
  type RealTrioAuditControlOutcome,
  type RealTrioSupervisorResult,
} from "../src/realTrioSupervisor.js";
import { stableJson } from "../src/stableJson.js";
import { createEphemeralLoopbackTlsIdentity } from "../src/ephemeralTlsIdentity.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const node24 = process.execPath;
const npmCli = "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js";
const dotnet = "C:/Program Files/dotnet/dotnet.exe";

function run(executable: string, args: readonly string[]): void {
  execFileSync(executable, [...args], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: "pipe",
    timeout: 180_000,
  });
}

/**
 * The real-case suite intentionally compiles/publishes the three components
 * itself.  It must never borrow the old simulator production plan or a
 * sibling worktree's compiled output.
 */
export function realTrioWorkerBuildPlan(artifactsPath: string): Readonly<{
  readonly restore: readonly string[];
  readonly build: readonly string[];
  readonly publish: readonly string[];
  readonly worker: string;
}> {
  const project = "packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/RevAgent.Bridge.RealWorkerHost.csproj";
  const output = path.join(artifactsPath, "publish");
  return Object.freeze({
    restore: Object.freeze([
      "restore",
      project,
      "--locked-mode",
      "--runtime", "win-x64",
      "--artifacts-path", artifactsPath,
    ]),
    build: Object.freeze([
      "build",
      project,
      "--configuration", "Release",
      "--runtime", "win-x64",
      "--no-restore",
      "--artifacts-path", artifactsPath,
    ]),
    publish: Object.freeze([
      "publish",
      project,
      "--configuration", "Release",
      "--runtime", "win-x64",
      "--self-contained", "false",
      "-p:UseAppHost=true",
      "--no-restore",
      "--artifacts-path", artifactsPath,
      "--output", output,
    ]),
    worker: path.join(output, "RevAgent.Bridge.RealWorkerHost.exe"),
  });
}

export function buildRealTrioRuntimeFixture(): void {
  const artifactsPath = mkdtempSync(path.join(tmpdir(), "revagent-wp12-real-trio-build-"));
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/protocol"]);
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/addin-loopback-fixture"]);
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/gateway"]);
  const plan = realTrioWorkerBuildPlan(artifactsPath);
  run(dotnet, plan.restore);
  run(dotnet, plan.build);
  run(dotnet, plan.publish);
  realTrioRuntimeWorker = plan.worker;
}

let realTrioRuntimeWorker: string | undefined;

function requiredRealTrioWorker(): string {
  if (realTrioRuntimeWorker === undefined) {
    throw new Error("real trio runtime fixture must be built before it is started");
  }
  return realTrioRuntimeWorker;
}

function requiredFile(relative: string): string {
  const candidate = path.resolve(repoRoot, relative);
  return candidate;
}

function credential(value: Record<string, unknown>): RealTrioNorthCredential {
  if (typeof value.bearer !== "string" || typeof value.audience !== "string" ||
      value.credentialProvenance !== "gateway_production_conformance" ||
      value.identityContract !== "revagent.auth-context/v1") {
    throw new Error("real trio north credential control response is malformed");
  }
  return Object.freeze({
    bearer: value.bearer,
    audience: value.audience,
    credentialProvenance: value.credentialProvenance,
    identityContract: value.identityContract,
  });
}

export interface RealTrioRuntimeFixture {
  readonly root: string;
  readonly binding: RealTrioBinding;
  readonly supervisor: RealTrioSupervisorResult;
  readonly credential: RealTrioNorthCredential;
  readonly endpoint: string;
  readonly certificateSha256: string;
  /** Revalidates the current post-control proof immediately around north I/O. */
  verifyNorthDispatchFence(): Promise<void>;
  /** Value-free proof that a controlled cache update preceded the public route. */
  readonly documentContextAudit: RealTrioDocumentContextAudit;
  stop(): Promise<void>;
}

/** Deliberately differs from the fixture's boot cache identity. */
export const REAL_TRIO_FIXTURE_DOCUMENT_ID = "fixture-document-wp12-control-1" as const;
const DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS = 20_000;
const MAX_DOCUMENT_CONTEXT_FAILURE_STAGES = 64;
const MAX_DOCUMENT_CONTEXT_FAILURE_AUDITS = 32;
export const REAL_TRIO_DOCUMENT_CONTEXT_FAILURE_SCHEMA =
  "rbp-real-trio-document-context-failure/v1" as const;

export interface RealTrioDocumentContextAudit {
  readonly revision: number;
  readonly cachedContextHash: string;
  readonly activeDocumentIdentityHash: string;
  readonly acknowledgementHash: string;
  readonly cacheReadCount: number;
  readonly pollRequestCount: number;
}

interface RealTrioDocumentContextCorrelation {
  readonly rsidHash: `sha256:${string}`;
  readonly sequence: number;
  /** Selected journal ordinal; never infer this from an array index. */
  readonly sendCursor: string;
  readonly generation: number;
  readonly sendTranscriptIndex: number;
  readonly sendRecordedAt: string | null;
}

/**
 * The route selector deliberately consumes the one redacted Gateway audit
 * response rather than combining a session listing with a later audit read.
 * Those independently consistent responses can describe different durable
 * session versions.
 */
export interface RealTrioCurrentRouteSelectorInput {
  readonly rows: readonly RealTrioDocumentContextCursorRow[];
  readonly generation: number;
  readonly controlCursor: string;
  readonly precedingProbe: RealTrioDocumentContextCursorRow | null;
  readonly audit: unknown;
  readonly baseline: RealTrioGatewayAuditBaseline;
}

export interface RealTrioGatewayAuditBaseline {
  readonly processEpoch: string;
  readonly observationOrdinal: number;
}

export interface RealTrioRuntimeFixtureOptions {
  /** Mandatory caller-owned directory; no production evidence path is inferred. */
  readonly evidenceDirectory: string;
  /** Test-only bound for an observed document-context failure. */
  readonly documentContextTimeoutMs?: number;
}

export const REAL_TRIO_RUNTIME_FAILURE_SCHEMA =
  "rbp-real-trio-runtime-failure/v1" as const;

export interface RealTrioRuntimeFailure {
  readonly schemaVersion: typeof REAL_TRIO_RUNTIME_FAILURE_SCHEMA;
  readonly binding: RealTrioBinding;
  readonly phase: "document_context" | "credential_issue";
  readonly commandHash: string;
  readonly childDiagnostics: readonly unknown[];
  readonly documentContextEvidence: unknown | null;
  readonly gatewayAuditPresent: boolean;
  readonly toolEvidence: Readonly<{ readonly action: string; readonly outcome: "failed" }>;
}

export interface RealTrioDocumentContextFailure {
  readonly schemaVersion: typeof REAL_TRIO_DOCUMENT_CONTEXT_FAILURE_SCHEMA;
  readonly reason: "ack_failure" | "stage_timeout" | "route_timeout" | "child_exit";
  readonly binding: RealTrioBinding;
  readonly timeline: readonly (
    "control_ack" | "ordered_stages" | "document_sent" | "fixture_probe" |
    "gateway_route" | "heartbeat_ack"
  )[];
  /** Fixed stage/outcome fields only; no correlation identifiers or payloads. */
  readonly documentStages: readonly Readonly<{
    readonly stage: string;
    readonly outcome: string;
    readonly sequence: number | null;
    readonly rsidHashPresent: boolean;
    readonly payloadHashPresent: boolean;
  }> [];
  readonly fixtureSnapshot: Readonly<{
    readonly cacheReadCount: number | null;
    readonly pollRequestCount: number | null;
    readonly cachedContextHashPresent: boolean;
    readonly activeDocumentIdentityHashPresent: boolean;
    readonly acknowledgementHashPresent: boolean;
  }>;
  /** Last public Gateway rows, reduced to route booleans and one-way hashes. */
  readonly gatewayRouteAudits: readonly Readonly<{
    readonly routePresent: boolean;
    readonly dispatchAllowed: boolean;
    readonly routeHash: string | null;
    readonly recordHash: string;
  }> [];
  /** Bounded status emitted by the Gateway's existing A/route/B/final audit. */
  readonly gatewayCoherentAudit: Readonly<{
    readonly status: "joined" | "route_absent" | "observation_missing" |
      "sequence_mismatch" | "context_digest_mismatch" | "route_changed" |
      "record_or_binding_changed" | "epoch_churn" | "cursor_evicted" |
      "observation_churn" | "retry_exhausted" | null;
    readonly lastAttemptStatus: "joined" | "route_absent" | "observation_missing" |
      "sequence_mismatch" | "context_digest_mismatch" | "route_changed" |
      "record_or_binding_changed" | "epoch_churn" | "cursor_evicted" |
      "observation_churn" | "retry_exhausted" | null;
    readonly attemptCount: number | null;
    readonly observationCount: number | null;
    readonly highWaterOrdinal: number | null;
  }>;
  /** Success-empty audit is distinct from a failed control call. */
  readonly gatewayAuditControl: Readonly<{
    readonly outcome: "success" | "failure" | "not_attempted";
    readonly error: "timeout" | "tls_pin" | "http_status_4xx" | "http_status_5xx" |
      "invalid_shape" | "process_exited" | "ipc_error" | "unknown" | null;
    readonly statusCode: number | null;
    readonly okKeyPresent: boolean;
    readonly actionKeyPresent: boolean;
  }>;
  readonly childState: RealTrioDocumentContextFailureState;
}

export class RealTrioDocumentContextFailureError extends Error {
  public constructor(
    message: string,
    readonly failureEvidence: RealTrioDocumentContextFailure,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "RealTrioDocumentContextFailureError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isCanonicalUtc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isProcessEpoch(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function documentContextStages(
  records: readonly { readonly line: string }[],
): RealTrioDocumentContextFailure["documentStages"] {
  const retained: Array<RealTrioDocumentContextFailure["documentStages"][number]> = [];
  for (const record of records) {
    if (retained.length === MAX_DOCUMENT_CONTEXT_FAILURE_STAGES) break;
    try {
      const value = JSON.parse(record.line) as unknown;
      if (!isObject(value) ||
          value.contractVersion !== "revagent.rbp-document-context-observation/v1" ||
          value.event !== "bridge.document_context_observation" ||
          typeof value.stage !== "string" || typeof value.outcome !== "string") continue;
      retained.push(Object.freeze({
        stage: value.stage,
        outcome: value.outcome,
        sequence: Number.isSafeInteger(value.sequence) ? Number(value.sequence) : null,
        rsidHashPresent: value.rsidHashPresent === true || isSha256(value.rsidHash),
        payloadHashPresent: value.payloadHashPresent === true || isSha256(value.payloadHash),
      }));
    } catch {
      // Unstructured child output is deliberately not persisted.
    }
  }
  return Object.freeze(retained);
}

function fixtureSnapshot(value: unknown): RealTrioDocumentContextFailure["fixtureSnapshot"] {
  const evidence = isObject(value) && isObject(value.documentContextEvidence)
    ? value.documentContextEvidence
    : {};
  return Object.freeze({
    cacheReadCount: Number.isSafeInteger(evidence.cacheReadCount) ? Number(evidence.cacheReadCount) : null,
    pollRequestCount: Number.isSafeInteger(evidence.pollRequestCount) ? Number(evidence.pollRequestCount) : null,
    cachedContextHashPresent: isSha256(evidence.cachedContextHash),
    activeDocumentIdentityHashPresent: isSha256(evidence.activeDocumentIdentityHash),
    acknowledgementHashPresent: isSha256(evidence.lastControlAcknowledgementHash),
  });
}

function gatewayRouteAudits(value: unknown): RealTrioDocumentContextFailure["gatewayRouteAudits"] {
  const rows = isObject(value) && Array.isArray(value.sessions) ? value.sessions : [];
  return Object.freeze(rows.slice(-MAX_DOCUMENT_CONTEXT_FAILURE_AUDITS).flatMap((row) => {
    if (!isObject(row) || !isObject(row.value)) return [];
    const lifecycle = isObject(row.value.lifecycle) ? row.value.lifecycle : {};
    const sessionLifecycle = isObject(lifecycle.sessionLifecycle) ? lifecycle.sessionLifecycle : {};
    const route = lifecycle.liveDocumentRoute;
    return [Object.freeze({
      routePresent: isObject(route),
      dispatchAllowed: sessionLifecycle.dispatchAllowed === true,
      routeHash: isObject(route) ? digest(route) : null,
      recordHash: digest(row.value),
    })];
  }));
}

const coherentAuditStatuses = new Set([
  "joined", "route_absent", "observation_missing", "sequence_mismatch",
  "context_digest_mismatch", "route_changed", "record_or_binding_changed",
  "epoch_churn", "cursor_evicted", "observation_churn", "retry_exhausted",
]);

function gatewayCoherentAudit(value: unknown): RealTrioDocumentContextFailure["gatewayCoherentAudit"] {
  if (!isObject(value) || typeof value.documentContextAuditStatus !== "string" ||
      !coherentAuditStatuses.has(value.documentContextAuditStatus)) {
    return Object.freeze({ status: null, lastAttemptStatus: null, attemptCount: null, observationCount: null, highWaterOrdinal: null });
  }
  const count = (candidate: unknown, maximum: number): number | null =>
    Number.isSafeInteger(candidate) && Number(candidate) >= 0 && Number(candidate) <= maximum ? Number(candidate) : null;
  return Object.freeze({
    status: value.documentContextAuditStatus as RealTrioDocumentContextFailure["gatewayCoherentAudit"]["status"],
    lastAttemptStatus: typeof value.documentContextAuditLastStatus === "string" &&
      coherentAuditStatuses.has(value.documentContextAuditLastStatus)
      ? value.documentContextAuditLastStatus as RealTrioDocumentContextFailure["gatewayCoherentAudit"]["lastAttemptStatus"]
      : null,
    attemptCount: count(value.documentContextAuditAttemptCount, 3),
    observationCount: count(value.documentContextAuditObservationCount, 32),
    highWaterOrdinal: count(value.documentContextObservationHighWaterOrdinal, Number.MAX_SAFE_INTEGER),
  });
}

function gatewayAuditControl(outcome: RealTrioAuditControlOutcome | null): RealTrioDocumentContextFailure["gatewayAuditControl"] {
  if (outcome === null) return Object.freeze({ outcome: "not_attempted", error: null, statusCode: null, okKeyPresent: false, actionKeyPresent: false });
  if (outcome.outcome === "success") return Object.freeze({ outcome: "success", error: null, statusCode: null, okKeyPresent: false, actionKeyPresent: false });
  return Object.freeze({ outcome: "failure", error: outcome.error, statusCode: outcome.statusCode,
    okKeyPresent: outcome.okKeyPresent, actionKeyPresent: outcome.actionKeyPresent });
}

interface GatewayAuditCapture {
  lastSuccessfulAudit: unknown | null;
  lastControlOutcome: RealTrioAuditControlOutcome | null;
}

async function readCapturedRealCaseAudit(
  supervisor: Pick<RealTrioSupervisorResult, "readRealCaseAuditOutcome">,
  capture: GatewayAuditCapture,
): Promise<unknown> {
  const outcome = await supervisor.readRealCaseAuditOutcome();
  capture.lastControlOutcome = outcome;
  if (outcome.outcome === "success") {
    capture.lastSuccessfulAudit = outcome.audit;
    return outcome.audit;
  }
  throw new Error("real trio public audit control unavailable");
}

/**
 * Creates a bounded, value-free diagnostic object before process cleanup.
 * Input objects are never retained; only fixed fields, counts, booleans, and
 * one-way hashes cross this boundary.
 */
export function createRealTrioDocumentContextFailure(input: {
  readonly reason: RealTrioDocumentContextFailure["reason"];
  readonly binding: RealTrioBinding;
  readonly timeline: readonly ("control_ack" | "ordered_stages" | "fixture_probe" | "gateway_route")[];
  readonly transcript: readonly { readonly line: string }[];
  readonly fixtureEvidence: unknown;
  readonly gatewayAudit: unknown;
  readonly coherentAudit: unknown;
  readonly coherentAuditControl: RealTrioAuditControlOutcome | null;
  readonly childState: RealTrioDocumentContextFailureState;
}): RealTrioDocumentContextFailure {
  return Object.freeze({
    schemaVersion: REAL_TRIO_DOCUMENT_CONTEXT_FAILURE_SCHEMA,
    reason: input.reason,
    binding: input.binding,
    timeline: Object.freeze([...input.timeline]),
    documentStages: documentContextStages(input.transcript),
    fixtureSnapshot: fixtureSnapshot(input.fixtureEvidence),
    gatewayRouteAudits: gatewayRouteAudits(input.gatewayAudit),
    gatewayCoherentAudit: gatewayCoherentAudit(input.coherentAudit),
    gatewayAuditControl: gatewayAuditControl(input.coherentAuditControl),
    childState: input.childState,
  });
}

/** Writes a single stable JSON artifact to the explicitly supplied path. */
export function writeRealTrioDocumentContextFailure(
  evidenceFile: string,
  failure: RealTrioDocumentContextFailure,
): void {
  mkdirSync(path.dirname(evidenceFile), { recursive: true });
  writeFileSync(evidenceFile, `${stableJson(failure)}\n`, { encoding: "utf8", flag: "wx" });
}

export function writeRealTrioRuntimeFailure(
  evidenceDirectory: string,
  failure: RealTrioRuntimeFailure,
): void {
  mkdirSync(evidenceDirectory, { recursive: true });
  const destination = path.join(evidenceDirectory, `${failure.binding}.runtime-failure.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, `${stableJson(failure)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, destination);
}

async function persistRuntimeFailure(input: {
  readonly evidenceDirectory: string;
  readonly binding: RealTrioBinding;
  readonly phase: RealTrioRuntimeFailure["phase"];
  readonly supervisor: RealTrioSupervisorResult;
  readonly documentContextEvidence: unknown | null;
  readonly toolAction: string;
}): Promise<void> {
  let gatewayAuditPresent = false;
  try {
    const audit = await input.supervisor.readRealCaseAudit();
    gatewayAuditPresent = audit !== null && typeof audit === "object";
  } catch {
    // Failure evidence records only the availability bit, never the audit body.
  }
  const failure: RealTrioRuntimeFailure = Object.freeze({
    schemaVersion: REAL_TRIO_RUNTIME_FAILURE_SCHEMA,
    binding: input.binding,
    phase: input.phase,
    commandHash: digest({ binding: input.binding, phase: input.phase }),
    childDiagnostics: input.supervisor.readDocumentContextFailureState().processDiagnostics,
    documentContextEvidence: input.documentContextEvidence,
    gatewayAuditPresent,
    toolEvidence: Object.freeze({ action: input.toolAction, outcome: "failed" }),
  });
  writeRealTrioRuntimeFailure(input.evidenceDirectory, failure);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`fixture ${label} is not a SHA-256 value`);
  }
  return value;
}

function documentContextControlAudit(value: unknown): RealTrioDocumentContextAudit {
  if (!isObject(value) || value.action !== "apply_document_context" ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 ||
      value.activeDocumentIdentityHash === null) {
    throw new Error("fixture apply_document_context acknowledgement is malformed");
  }
  return Object.freeze({
    revision: Number(value.revision),
    cachedContextHash: hash(value.cachedContextHash, "cached context hash"),
    activeDocumentIdentityHash: hash(value.activeDocumentIdentityHash, "document identity hash"),
    acknowledgementHash: hash(value.acknowledgementHash, "control acknowledgement hash"),
  });
}

/** Reads only value-free cache evidence produced after a strict control ACK. */
export function probeRealTrioFixtureDocumentContext(
  value: unknown,
  expected: RealTrioDocumentContextAudit,
): Pick<RealTrioDocumentContextAudit, "cacheReadCount" | "pollRequestCount"> {
  if (!isObject(value) || !isObject(value.documentContextEvidence)) {
    throw new Error("fixture snapshot_evidence lacks document-context evidence");
  }
  const evidence = value.documentContextEvidence;
  if (evidence.currentRevision !== expected.revision ||
      evidence.cachedContextHash !== expected.cachedContextHash ||
      evidence.activeDocumentIdentityHash !== expected.activeDocumentIdentityHash ||
      evidence.lastControlAcknowledgementHash !== expected.acknowledgementHash) {
    throw new Error("fixture snapshot_evidence does not confirm the controlled cached document context");
  }
  if (!Number.isSafeInteger(evidence.cacheReadCount) || Number(evidence.cacheReadCount) <= 0 ||
      !Number.isSafeInteger(evidence.pollRequestCount) || Number(evidence.pollRequestCount) <= 0) {
    throw new Error("fixture snapshot_evidence lacks a completed document-context poll");
  }
  return Object.freeze({
    cacheReadCount: Number(evidence.cacheReadCount),
    pollRequestCount: Number(evidence.pollRequestCount),
  });
}

/**
 * Selects one controlled ordered lifecycle.  A watcher probe which began just
 * before the control acknowledgement is admissible only as a one-record
 * prefix; completed or ambiguous historical lifecycles remain inert.
 */
export function correlatedDocumentContextSendSince(
  records: readonly { readonly line: string; readonly at?: string }[],
  floor: number,
): RealTrioDocumentContextCorrelation | null {
  if (!Number.isSafeInteger(floor) || floor < 0 || floor > records.length) return null;
  const expected = Object.freeze([
    Object.freeze({ stage: "probe", outcome: "started" }),
    Object.freeze({ stage: "snapshot", outcome: "ready" }),
    Object.freeze({ stage: "queue", outcome: "durably_queued" }),
    Object.freeze({ stage: "send", outcome: "sent" }),
  ]);
  type Observation = Record<string, unknown>;
  const observationAt = (index: number): Observation | null => {
    try {
      const value = JSON.parse(records[index]!.line) as unknown;
      return isObject(value) && value.event === "bridge.document_context_observation" ? value : null;
    } catch { return null; }
  };
  const controlFloorProbe = (): Observation | null => {
    if (floor === 0) return null;
    const prefix = observationAt(floor - 1);
    if (prefix === null || prefix.stage !== "probe" || prefix.outcome !== "started" ||
        !isSha256(prefix.rsidHash) || !(prefix.sequence === null || Number.isSafeInteger(prefix.sequence)) ||
        (prefix.sequence !== null && Number(prefix.sequence) < 1)) return null;
    // The immediately preceding probe is usable only when it is the sole,
    // still-active observation for this exact RSID before the control floor.
    for (let index = 0; index < floor - 1; index += 1) {
      const prior = observationAt(index);
      if (prior === null) {
        // Diagnostics are pre-filtered to this event type. A malformed row in
        // a direct caller therefore cannot be silently used to bridge a floor.
        try { JSON.parse(records[index]!.line); } catch { return null; }
        continue;
      }
      if (!isSha256(prior.rsidHash) || prior.rsidHash !== prefix.rsidHash) continue;
      // Any earlier same-RSID lifecycle row (including an earlier probe) makes
      // this prefix stale, duplicated, or otherwise non-canonical.
      return null;
    }
    return prefix;
  };
  const prefix = controlFloorProbe();
  let next = 0;
  let canonicalHash: `sha256:${string}` | null = null;
  let canonicalSequence: number | null = null;
  for (let index = floor; index < records.length; index += 1) {
    const record = records[index]!;
    try {
      const value = JSON.parse(record.line) as unknown;
      if (!isObject(value) || value.event !== "bridge.document_context_observation") continue;
      if (value.stage === "failure" || value.stage === "completed") return null;
      // A control-floor prefix is allowed only when the first post-floor
      // lifecycle row is its exact snapshot; queue/send remain post-floor.
      if (next === 0 && value.stage === "snapshot" && value.outcome === "ready") {
        if (prefix === null) return null;
        canonicalHash = prefix.rsidHash as `sha256:${string}`;
        const prefixSequence = prefix.sequence === null ? null : Number(prefix.sequence);
        canonicalSequence = prefixSequence;
        next = 1;
      }
      const expectedStep = expected[next];
      if (expectedStep === undefined || value.stage !== expectedStep.stage || value.outcome !== expectedStep.outcome ||
          !isSha256(value.rsidHash) || !(value.sequence === null || Number.isSafeInteger(value.sequence))) return null;
      if (canonicalHash === null) canonicalHash = value.rsidHash;
      else if (canonicalHash !== value.rsidHash) return null;
      const sequence = value.sequence === null ? null : Number(value.sequence);
      if (sequence !== null && sequence < 1) return null;
      if (sequence !== null) {
        if (canonicalSequence === null) canonicalSequence = sequence;
        else if (canonicalSequence !== sequence) return null;
      }
      if ((value.stage === "queue" || value.stage === "send") && sequence === null) return null;
      next += 1;
      if (next === expected.length) {
        if (canonicalHash === null || canonicalSequence === null) return null;
        return Object.freeze({ rsidHash: canonicalHash, sequence: canonicalSequence,
          sendCursor: String(index + 1), generation: 1,
          sendTranscriptIndex: index, sendRecordedAt: typeof record.at === "string" ? record.at : null });
      }
    } catch { return null; }
  }
  return null;
}

function documentObservation(row: RealTrioDocumentContextCursorRow): Record<string, unknown> | null {
  try {
    const value = JSON.parse(row.line) as unknown;
    return isObject(value) && value.event === "bridge.document_context_observation" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Captures the only pre-control observation that may participate in a later
 * lifecycle: the last retained, otherwise-unmatched probe.  It is an opaque
 * cursor row, not a transcript position and not a payload identity.
 */
export function unmatchedDocumentContextProbe(
  snapshot: RealTrioDocumentContextSnapshot,
): RealTrioDocumentContextCursorRow | null {
  const candidate = snapshot.rows.at(-1);
  if (candidate === undefined) return null;
  const probe = documentObservation(candidate);
  if (probe === null || probe.stage !== "probe" || probe.outcome !== "started" ||
      !isSha256(probe.rsidHash) ||
      !(probe.sequence === null || (Number.isSafeInteger(probe.sequence) && Number(probe.sequence) >= 1))) return null;
  for (const row of snapshot.rows.slice(0, -1)) {
    const prior = documentObservation(row);
    if (prior !== null && prior.rsidHash === probe.rsidHash) return null;
  }
  return candidate;
}

/**
 * Cursor-native lifecycle selection. `rows` must be the exact result of one
 * `since(controlCursor, generation)` call. An immediately pre-control probe
 * is admitted only when supplied as the separate snapshot row.
 */
export function correlatedDocumentContextSendFromCursor(
  rows: readonly RealTrioDocumentContextCursorRow[],
  generation: number,
  precedingProbe: RealTrioDocumentContextCursorRow | null,
): RealTrioDocumentContextCorrelation | null {
  if (rows.length === 0) return null;
  const first = rows[0];
  if (first === undefined || !/^[1-9][0-9]*$/u.test(first.cursor)) return null;
  const allRows = precedingProbe === null ? rows : [precedingProbe, ...rows];
  const controlCursor = (BigInt(allRows[0]!.cursor) - 1n).toString();
  const parsed = parseDocumentContextGrammar({ rows: allRows, generation, controlCursor, precedingProbe: null });
  return parsed?.candidates.length === 1 ? parsed.candidates[0]! : null;
}

interface LocalDocumentContextCandidate extends RealTrioDocumentContextCorrelation {
  readonly contextDigest: string;
}

interface StrictDocumentContextCandidate extends LocalDocumentContextCandidate {
  readonly routeDigest: `sha256:${string}`;
  readonly controlCursor: string;
  readonly precedingProbe: RealTrioDocumentContextCursorRow | null;
  readonly watcherOrdinal: number;
}

type StrictDocumentObservation = Readonly<{
  readonly stage: "probe" | "snapshot" | "queue" | "send" | "ack";
  readonly rsidHash: `sha256:${string}`;
  readonly sequence: number | null;
  readonly contextDigest: string | null;
}>;

/**
 * A document observation is an ordered journal fact, not a best-effort log
 * hint.  Non-document records are intentionally outside this grammar, but an
 * advertised document observation must be complete and known.
 */
function strictDocumentObservation(row: RealTrioDocumentContextCursorRow): StrictDocumentObservation | null | undefined {
  let value: unknown;
  try {
    value = JSON.parse(row.line) as unknown;
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.event !== "bridge.document_context_observation") return undefined;
  if (!isSha256(value.rsidHash) || !(value.sequence === null ||
      (Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 1))) return null;
  const sequence = value.sequence === null ? null : Number(value.sequence);
  const context = typeof value.contextDigest === "string" && /^[0-9a-f]{64}$/u.test(value.contextDigest)
    ? value.contextDigest
    : null;
  if (value.stage === "probe" && value.outcome === "started") {
    return Object.freeze({ stage: "probe", rsidHash: value.rsidHash, sequence, contextDigest: null });
  }
  if (value.stage === "ack" && value.outcome === "durably_acknowledged" && sequence !== null) {
    return Object.freeze({ stage: "ack", rsidHash: value.rsidHash, sequence, contextDigest: null });
  }
  if ((value.stage === "snapshot" && value.outcome === "ready") ||
      (value.stage === "queue" && value.outcome === "durably_queued") ||
      (value.stage === "send" && value.outcome === "sent")) {
    // A snapshot establishes only watcher identity and context.  The durable
    // queue operation is the sole source of the cycle sequence.
    if ((value.stage === "snapshot" && sequence !== null) ||
        (value.stage !== "snapshot" && sequence === null) || context === null) return null;
    return Object.freeze({ stage: value.stage, rsidHash: value.rsidHash, sequence, contextDigest: context });
  }
  // `failure`, a malformed stage, and a future/unknown document event are all
  // terminal for this retained grammar.  They must never be compressed away.
  return null;
}

interface ParsedDocumentContextCandidate extends LocalDocumentContextCandidate {
  readonly startCursor: string;
  readonly startTranscriptIndex: number;
  readonly watcherOrdinal: number;
}

interface ParsedDocumentContextGrammar {
  readonly candidates: readonly ParsedDocumentContextCandidate[];
  readonly acknowledgements: ReadonlyMap<string, number>;
  readonly currentWatcherOrdinal: number;
}

function candidateKey(watcherOrdinal: number, rsidHash: `sha256:${string}`, sequence: number): string {
  return `${watcherOrdinal}:${rsidHash}:${sequence}`;
}

/**
 * Parse every retained document fact in ordinal order.  A watcher is opened
 * only by probe/started.  It may contain many complete cycles; a new probe
 * starts a new watcher and deliberately makes prior ACK eligibility inert.
 */
function parseDocumentContextGrammar(input: {
  readonly rows: readonly RealTrioDocumentContextCursorRow[];
  readonly generation: number;
  readonly controlCursor: string;
  readonly precedingProbe: RealTrioDocumentContextCursorRow | null;
}): ParsedDocumentContextGrammar | null {
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 ||
      !/^(?:0|[1-9][0-9]*)$/u.test(input.controlCursor)) return null;
  const control = BigInt(input.controlCursor);
  let previous = control;
  for (const row of input.rows) {
    if (!/^[1-9][0-9]*$/u.test(row.cursor) || BigInt(row.cursor) !== previous + 1n) return null;
    previous = BigInt(row.cursor);
  }

  let watcher: {
    readonly ordinal: number;
    readonly rsidHash: `sha256:${string}`;
    lastSentSequence: number | null;
    lastAcknowledgedSequence: number | null;
    cycle: { readonly sequence: number | null; readonly contextDigest: string; readonly startCursor: string; readonly startIndex: number; readonly stage: "snapshot" | "queue" } | null;
    readonly sent: Map<number, ParsedDocumentContextCandidate>;
  } | null = null;
  const candidates: ParsedDocumentContextCandidate[] = [];
  const acknowledgements = new Map<string, number>();
  let nextWatcherOrdinal = 0;

  const openProbe = (observation: StrictDocumentObservation): boolean => {
    if (observation.stage !== "probe") return false;
    if (watcher !== null && watcher.cycle !== null) return false;
    watcher = {
      ordinal: nextWatcherOrdinal += 1,
      rsidHash: observation.rsidHash,
      lastSentSequence: null,
      lastAcknowledgedSequence: null,
      cycle: null,
      sent: new Map(),
    };
    return true;
  };

  if (input.precedingProbe !== null) {
    if (input.precedingProbe.cursor !== input.controlCursor) return null;
    const prefix = strictDocumentObservation(input.precedingProbe);
    if (prefix === null || prefix === undefined || !openProbe(prefix)) return null;
  }

  for (let index = 0; index < input.rows.length; index += 1) {
    const row = input.rows[index]!;
    const observation = strictDocumentObservation(row);
    if (observation === undefined) continue; // ordinal retained; non-document output is inert.
    if (observation === null) return null;

    if (observation.stage === "probe") {
      if (!openProbe(observation)) return null;
      continue;
    }
    if (watcher === null || watcher.rsidHash !== observation.rsidHash) return null;

    if (observation.stage === "ack") {
      const sent = watcher.sent.get(observation.sequence!);
      if (sent === undefined || (watcher.lastAcknowledgedSequence !== null &&
          observation.sequence! <= watcher.lastAcknowledgedSequence)) return null;
      watcher.lastAcknowledgedSequence = observation.sequence!;
      acknowledgements.set(candidateKey(watcher.ordinal, observation.rsidHash, observation.sequence!), index);
      continue;
    }

    if (observation.stage === "snapshot") {
      if (watcher.cycle !== null) return null;
      watcher.cycle = {
        sequence: null,
        contextDigest: observation.contextDigest!,
        startCursor: row.cursor,
        startIndex: index,
        stage: "snapshot",
      };
      continue;
    }
    if (observation.stage === "queue") {
      if (watcher.cycle === null || watcher.cycle.stage !== "snapshot" ||
          watcher.cycle.contextDigest !== observation.contextDigest ||
          (watcher.lastSentSequence !== null && observation.sequence! <= watcher.lastSentSequence)) return null;
      watcher.cycle = { ...watcher.cycle, sequence: observation.sequence!, stage: "queue" };
      continue;
    }
    // send/sent completes exactly the snapshot -> queue -> send cycle.
    if (watcher.cycle === null || watcher.cycle.stage !== "queue" ||
        watcher.cycle.sequence !== observation.sequence ||
        watcher.cycle.contextDigest !== observation.contextDigest) return null;
    const candidate = Object.freeze({
      rsidHash: watcher.rsidHash,
      sequence: observation.sequence!,
      sendCursor: row.cursor,
      generation: input.generation,
      sendTranscriptIndex: index,
      sendRecordedAt: row.at.length === 0 ? null : row.at,
      contextDigest: observation.contextDigest!,
      startCursor: watcher.cycle.startCursor,
      startTranscriptIndex: watcher.cycle.startIndex,
      watcherOrdinal: watcher.ordinal,
    });
    watcher.sent.set(candidate.sequence, candidate);
    watcher.lastSentSequence = candidate.sequence;
    watcher.cycle = null;
    candidates.push(candidate);
  }
  if (watcher !== null && watcher.cycle !== null) return null;
  return Object.freeze({ candidates: Object.freeze(candidates), acknowledgements,
    currentWatcherOrdinal: watcher?.ordinal ?? 0 });
}

interface CurrentRouteAuditIdentity {
  readonly rsidHash: `sha256:${string}`;
  readonly sequence: number;
  readonly contextDigest: string;
  readonly routeDigest: `sha256:${string}`;
  readonly recordDigest: `sha256:${string}`;
  readonly sessionBindingDigest: `sha256:${string}`;
  readonly connectionDigest: `sha256:${string}`;
  readonly sessionRecordVersion: number;
}

function currentRouteAuditIdentity(audit: unknown, baseline: RealTrioGatewayAuditBaseline): CurrentRouteAuditIdentity | null {
  if (!isObject(audit) || audit.documentContextEpochSchema !== "revagent.wp12-document-context-epoch/v1" ||
      audit.documentContextProcessEpoch !== baseline.processEpoch || !isProcessEpoch(audit.documentContextProcessEpoch) ||
      !Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal) ||
      Number(audit.documentContextObservationHighWaterOrdinal) < baseline.observationOrdinal ||
      !isObject(audit.documentContextCurrentRoute)) return null;
  const route = audit.documentContextCurrentRoute;
  if (route.processEpoch !== baseline.processEpoch || !isSha256(route.rsidHash) ||
      !Number.isSafeInteger(route.observedSequence) || Number(route.observedSequence) < 1 ||
      typeof route.contextDigest !== "string" || !/^[0-9a-f]{64}$/u.test(route.contextDigest) ||
      !isSha256(route.routeDigest) || !isSha256(route.recordDigest) ||
      !isSha256(route.sessionBindingDigest) || !isSha256(route.connectionDigest) ||
      !Number.isSafeInteger(route.sessionRecordVersion) ||
      Number(route.sessionRecordVersion) < 1) return null;
  return Object.freeze({
    rsidHash: route.rsidHash,
    sequence: Number(route.observedSequence),
    contextDigest: route.contextDigest,
    routeDigest: route.routeDigest,
    recordDigest: route.recordDigest,
    sessionBindingDigest: route.sessionBindingDigest,
    connectionDigest: route.connectionDigest,
    sessionRecordVersion: Number(route.sessionRecordVersion),
  });
}

function hasOneCurrentAcceptedObservation(
  audit: unknown,
  current: CurrentRouteAuditIdentity,
  baseline: RealTrioGatewayAuditBaseline,
): boolean {
  if (!isObject(audit) || !Array.isArray(audit.documentContextUpdates)) return false;
  const matches = audit.documentContextUpdates.filter((value) => isObject(value) &&
    value.contractVersion === "revagent.wp12-document-context-audit/v1" &&
    value.event === "gateway.doc_context_update_observation" && value.stage === "accepted" &&
    value.processEpoch === baseline.processEpoch && value.rsidHash === current.rsidHash &&
    value.observedSequence === current.sequence && value.contextDigest === current.contextDigest &&
    value.routeDigest === current.routeDigest && value.recordDigest === current.recordDigest &&
    value.sessionBindingDigest === current.sessionBindingDigest && value.connectionDigest === current.connectionDigest &&
    value.sessionRecordVersion === current.sessionRecordVersion &&
    Number.isSafeInteger(value.observationOrdinal) && Number(value.observationOrdinal) > baseline.observationOrdinal &&
    Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal) &&
    Number(value.observationOrdinal) <= Number(audit.documentContextObservationHighWaterOrdinal));
  return matches.length === 1;
}

/**
 * Select exactly one complete lifecycle for the single authoritative current
 * route represented in one audit snapshot. Any missing coherent-route field,
 * cursor gap/expiry, generation change, duplicate accepted audit observation,
 * or zero/multiple candidate fails closed.
 */
export function selectCurrentDocumentContextSendFromCursor(
  input: RealTrioCurrentRouteSelectorInput,
): StrictDocumentContextCandidate | null {
  if (!isObject(input.audit) || input.audit.documentContextGeneration !== input.generation) return null;
  const parsed = parseDocumentContextGrammar(input);
  const current = currentRouteAuditIdentity(input.audit, input.baseline);
  if (parsed === null || current === null || !hasOneCurrentAcceptedObservation(input.audit, current, input.baseline)) {
    return null;
  }
  const selected = parsed.candidates.filter((candidate) => candidate.watcherOrdinal === parsed.currentWatcherOrdinal &&
    candidate.rsidHash === current.rsidHash && candidate.sequence === current.sequence &&
    candidate.contextDigest === current.contextDigest);
  if (selected.length !== 1) return null;
  return Object.freeze({ ...selected[0]!, routeDigest: current.routeDigest,
    controlCursor: input.controlCursor, precedingProbe: input.precedingProbe });
}

function cursorSinceOrThrow(input: {
  readonly supervisor: RealTrioSupervisorResult;
  readonly cursor: string;
  readonly generation: number;
}): readonly RealTrioDocumentContextCursorRow[] {
  const before = input.supervisor.readDocumentContextSnapshot();
  if (before.generation !== input.generation) {
    throw new Error("real trio document-context generation changed before cursor query");
  }
  const result = input.supervisor.readDocumentContextSince(input.cursor, input.generation);
  const after = input.supervisor.readDocumentContextSnapshot();
  if (after.generation !== input.generation) {
    throw new Error("real trio document-context generation changed during cursor query");
  }
  if (result.state !== "ok" || result.generation !== input.generation) {
    throw new Error(`real trio document-context cursor query failed closed: ${result.state}`);
  }
  return result.rows;
}

async function waitForDocumentContextSend(input: {
  readonly supervisor: RealTrioSupervisorResult;
  readonly controlCursor: string;
  readonly generation: number;
  readonly precedingProbe: RealTrioDocumentContextCursorRow | null;
  readonly gatewayBaseline: RealTrioGatewayAuditBaseline;
  readonly auditCapture: GatewayAuditCapture;
  readonly timeoutMs?: number;
}): Promise<StrictDocumentContextCandidate> {
  const deadline = Date.now() + (input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState().childExited) {
      throw new Error("real trio child exited before document-context send");
    }
    const rows = cursorSinceOrThrow({ supervisor: input.supervisor, cursor: input.controlCursor, generation: input.generation });
    // One audit call is the route/acceptance authority for this iteration.
    // Do not pair rows with a separate session snapshot: a route advance can
    // otherwise select a stale lifecycle from the preceding record version.
    const expected = selectCurrentDocumentContextSendFromCursor({
      rows,
      generation: input.generation,
      controlCursor: input.controlCursor,
      precedingProbe: input.precedingProbe,
      audit: await readCapturedRealCaseAudit(input.supervisor, input.auditCapture),
      baseline: input.gatewayBaseline,
    });
    if (expected !== null) return expected;
    if (Date.now() >= deadline) {
      throw new Error("real trio document-context current-route proof was not coherent through send");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * `ack` is emitted only by the C# coordinator after a received
 * heartbeat_ack is durably applied. The control-completion floor excludes
 * historical output while retaining an ACK produced during route observation.
 */
export function hasDurableDocumentContextHeartbeatAckSince(
  records: readonly { readonly line: string; readonly at?: string }[],
  baseline: number,
  expected: RealTrioDocumentContextCorrelation,
): boolean {
  const start = Math.max(baseline, expected.sendTranscriptIndex + 1);
  let acknowledged = false;
  for (let index = start; index < records.length; index += 1) {
    const record = records[index]!;
    try {
      const value = JSON.parse(record.line) as unknown;
      if (!isObject(value) || value.event !== "bridge.document_context_observation") continue;
      if (acknowledged || value.stage !== "ack" || value.outcome !== "durably_acknowledged" ||
          !isSha256(value.rsidHash) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
          value.rsidHash !== expected.rsidHash || value.sequence !== expected.sequence) return false;
      acknowledged = true;
    } catch { return false; }
  }
  return acknowledged;
}

/**
 * Cursor-native ACK proof replays the complete retained grammar.  The ACK is
 * tied to the selected send's watcher, not merely to a matching line later in
 * a slice; a later valid cycle in that watcher is harmless, while a new probe
 * makes the old watcher ineligible.
 */
export function hasDurableDocumentContextHeartbeatAckFromCursor(
  rows: readonly RealTrioDocumentContextCursorRow[],
  expected: StrictDocumentContextCandidate,
): boolean {
  const parsed = parseDocumentContextGrammar({ rows, generation: expected.generation,
    controlCursor: expected.controlCursor, precedingProbe: expected.precedingProbe });
  if (parsed === null || expected.watcherOrdinal !== parsed.currentWatcherOrdinal) return false;
  const selected = parsed.candidates.filter((candidate) => candidate.watcherOrdinal === expected.watcherOrdinal &&
    candidate.rsidHash === expected.rsidHash && candidate.sequence === expected.sequence &&
    candidate.contextDigest === expected.contextDigest && candidate.sendCursor === expected.sendCursor);
  if (selected.length !== 1 || selected[0]!.sendTranscriptIndex !== expected.sendTranscriptIndex) return false;
  const acknowledgementOrdinal = parsed.acknowledgements.get(
    candidateKey(expected.watcherOrdinal, expected.rsidHash, expected.sequence),
  );
  return acknowledgementOrdinal !== undefined && acknowledgementOrdinal > expected.sendTranscriptIndex;
}

export function hasGatewayAcceptedDocumentContextRoute(
  audit: unknown,
  expected: RealTrioDocumentContextCorrelation,
  baseline: RealTrioGatewayAuditBaseline,
): boolean {
  const current = currentRouteAuditIdentity(audit, baseline);
  const routeDigest = (expected as Partial<StrictDocumentContextCandidate>).routeDigest;
  const contextDigest = (expected as Partial<StrictDocumentContextCandidate>).contextDigest;
  if (!isObject(audit) || !Array.isArray(audit.documentContextUpdates) ||
      audit.documentContextEpochSchema !== "revagent.wp12-document-context-epoch/v1" ||
      audit.documentContextProcessEpoch !== baseline.processEpoch || !isProcessEpoch(audit.documentContextProcessEpoch) ||
      !Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal) ||
      Number(audit.documentContextObservationHighWaterOrdinal) < baseline.observationOrdinal ||
      !isCanonicalUtc(expected.sendRecordedAt) || current === null || !isSha256(routeDigest) ||
      current.rsidHash !== expected.rsidHash || current.sequence !== expected.sequence ||
      current.contextDigest !== contextDigest ||
      current.routeDigest !== routeDigest) return false;
  const candidates = audit.documentContextUpdates.filter((value) => isObject(value) &&
    value.contractVersion === "revagent.wp12-document-context-audit/v1" &&
    value.event === "gateway.doc_context_update_observation" && value.stage === "accepted" &&
    value.rsidHash === expected.rsidHash && value.observedSequence === expected.sequence &&
    value.processEpoch === baseline.processEpoch && value.contextDigest === current.contextDigest &&
    value.routeDigest === current.routeDigest && value.recordDigest === current.recordDigest &&
    value.sessionBindingDigest === current.sessionBindingDigest && value.connectionDigest === current.connectionDigest &&
    value.sessionRecordVersion === current.sessionRecordVersion &&
    isSha256(value.rsidHash) && Number.isSafeInteger(value.observedSequence) && Number(value.observedSequence) >= 1 &&
    Number.isSafeInteger(value.observationOrdinal) && Number(value.observationOrdinal) > baseline.observationOrdinal &&
    Number(value.observationOrdinal) <= Number(audit.documentContextObservationHighWaterOrdinal) &&
    isCanonicalUtc(value.observedAtUtc) && Date.parse(value.observedAtUtc) >= Date.parse(expected.sendRecordedAt));
  return candidates.length === 1;
}

export function gatewayAuditBaseline(audit: unknown): RealTrioGatewayAuditBaseline | null {
  if (!isObject(audit) || audit.documentContextEpochSchema !== "revagent.wp12-document-context-epoch/v1" ||
      !isProcessEpoch(audit.documentContextProcessEpoch) || !Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal) ||
      Number(audit.documentContextObservationHighWaterOrdinal) < 0) return null;
  return Object.freeze({ processEpoch: audit.documentContextProcessEpoch,
    observationOrdinal: Number(audit.documentContextObservationHighWaterOrdinal) });
}

async function waitForPostRouteDocumentContextHeartbeatAck(input: {
  readonly supervisor: RealTrioSupervisorResult;
  readonly expected: RealTrioDocumentContextCorrelation;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState().childExited) {
      throw new Error("real trio child exited before post-route heartbeat acknowledgement");
    }
    if (hasDurableDocumentContextHeartbeatAckFromCursor(
      cursorSinceOrThrow({ supervisor: input.supervisor, cursor: input.expected.controlCursor, generation: input.expected.generation }),
      input.expected,
    )) return;
    if (Date.now() >= deadline) {
      throw new Error("real trio did not durably acknowledge document context after route persistence");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

export function realTrioFixtureDocumentContextEvent(
  documentId = REAL_TRIO_FIXTURE_DOCUMENT_ID,
): Record<string, unknown> {
  return Object.freeze({
    capturedAtUtc: "2026-08-23T00:00:00.000Z",
    cacheState: "ready",
    unavailableReason: null,
    documents: [Object.freeze({
      documentId,
      title: "WP12 Fixture Document",
      pathDigest: null,
      isWorkshared: false,
      isActive: true,
    })],
    activeDocumentId: documentId,
    activeView: Object.freeze({
      documentId,
      id: "1001",
      name: "Fixture View",
      type: "FloorPlan",
      level: "Level 01",
    }),
    disciplineHint: "mechanical",
  });
}

export function hasRealTrioLiveDocumentRoute(
  snapshot: Record<string, unknown>,
  expectedDocumentId = REAL_TRIO_FIXTURE_DOCUMENT_ID,
): boolean {
  const sessions = snapshot.sessions;
  if (!Array.isArray(sessions) || sessions.length !== 1) return false;
  const row = sessions[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  const value = (row as Record<string, unknown>).value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const lifecycle = (value as Record<string, unknown>).lifecycle;
  if (lifecycle === null || typeof lifecycle !== "object" || Array.isArray(lifecycle)) return false;
  const route = (lifecycle as Record<string, unknown>).liveDocumentRoute;
  return route !== null && typeof route === "object" && !Array.isArray(route) &&
    (route as Record<string, unknown>).sessionDocumentId === expectedDocumentId;
}

async function waitForLiveDocumentRoute(input: {
  readonly endpoint: string;
  readonly controlToken: string;
  readonly certificateSha256: string;
  readonly supervisor: RealTrioSupervisorResult;
  readonly expected: RealTrioDocumentContextCorrelation;
  readonly gatewayBaseline: RealTrioGatewayAuditBaseline;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState().childExited) {
      throw new Error("real trio child exited before document-context route");
    }
    const snapshot = await publicGatewayControl(
      input.endpoint,
      input.controlToken,
      input.certificateSha256,
      { action: "snapshot_audit" },
    );
    const audit = await input.supervisor.readRealCaseAudit();
    if (hasRealTrioLiveDocumentRoute(snapshot) &&
        hasGatewayAcceptedDocumentContextRoute(audit, input.expected, input.gatewayBaseline)) return;
    if (Date.now() >= deadline) {
      throw new Error("real trio fixture document context did not produce a live Gateway route");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

async function documentContextFailureError(input: {
  readonly error: unknown;
  readonly reason: RealTrioDocumentContextFailure["reason"];
  readonly binding: RealTrioBinding;
  readonly timeline: readonly RealTrioDocumentContextFailure["timeline"][number][];
  readonly supervisor: RealTrioSupervisorResult;
  readonly endpoint: string;
  readonly controlToken: string;
  readonly certificateSha256: string;
  readonly evidenceFile: string;
  readonly auditCapture: GatewayAuditCapture;
}): Promise<RealTrioDocumentContextFailureError> {
  const [fixtureEvidence, gatewayAudit, finalAuditOutcome] = await Promise.all([
    input.supervisor.fixtureControl("snapshot_evidence").catch(() => null),
    publicGatewayControl(
      input.endpoint,
      input.controlToken,
      input.certificateSha256,
      { action: "snapshot_audit" },
    ).catch(() => null),
    input.supervisor.readRealCaseAuditOutcome(),
  ]);
  input.auditCapture.lastControlOutcome = finalAuditOutcome;
  if (finalAuditOutcome.outcome === "success") input.auditCapture.lastSuccessfulAudit = finalAuditOutcome.audit;
  const childState = input.supervisor.readDocumentContextFailureState();
  const failure = createRealTrioDocumentContextFailure({
    reason: childState.childExited ? "child_exit" : input.reason,
    binding: input.binding,
    timeline: input.timeline,
    transcript: input.supervisor.readDocumentContextFailureStages(),
    fixtureEvidence,
    gatewayAudit,
    coherentAudit: input.auditCapture.lastSuccessfulAudit,
    coherentAuditControl: input.auditCapture.lastControlOutcome,
    childState,
  });
  try {
    writeRealTrioDocumentContextFailure(input.evidenceFile, failure);
  } catch {
    // The failure object remains attached even if an operator-supplied target
    // was unavailable; do not replace the original document-context failure.
  }
  const message = input.error instanceof Error ? input.error.message : "real trio document-context failure";
  return new RealTrioDocumentContextFailureError(message, failure, input.error);
}

export async function startRealTrioRuntimeFixture(
  binding: RealTrioBinding,
  options: RealTrioRuntimeFixtureOptions,
): Promise<RealTrioRuntimeFixture> {
  const root = mkdtempSync(path.join(tmpdir(), "revagent-wp12-real-trio-"));
  mkdirSync(path.join(root, "install"), { recursive: true });
  mkdirSync(path.join(root, "state"), { recursive: true });
  const tls = createEphemeralLoopbackTlsIdentity(root);
  const controlToken = `wp12-${path.basename(root)}`;
  const gatewayCli = requiredFile("packages/gateway/dist/productionConformanceHostCli.js");
  const fixtureCli = requiredFile("packages/addin-loopback-fixture/dist/cli.js");
  const worker = requiredRealTrioWorker();
  const supervisor = await startRealTrioSupervisor({
    evidenceDirectory: options.evidenceDirectory,
    gateway: {
      executable: node24,
      args: [gatewayCli, "--root", path.join(root, "gateway"), "--certificate", tls.certificatePath, "--key", tls.privateKeyPath, "--control-token", controlToken, "--port", "0"],
      workingDirectory: repoRoot,
    },
    bridgeWorker: {
      executable: worker,
      args: [
        "--binding", binding,
        "--gateway-uri", "{{gateway_endpoint}}",
        "--addin-port", "{{fixture_port}}",
        "--fixture-pid", "{{fixture_pid}}",
        "--install-root", path.join(root, "install"),
        "--state-root", path.join(root, "state"),
        "--device-id", "{{device_id}}",
        "--device-token", "{{device_proof}}",
        "--fingerprint", `sha256:${"a".repeat(64)}`,
        "--certificate-sha256", "{{gateway_certificate_sha256}}",
        "--test-heartbeat-interval-ms", "{{test_heartbeat_interval_ms}}",
      ],
      workingDirectory: repoRoot,
    },
    fixture: {
      executable: node24,
      args: [fixtureCli, "--host", "127.0.0.1", "--port", "0"],
      workingDirectory: repoRoot,
    },
    gatewayExpected: { component: "gateway_production_conformance", contract: "wp12-production-conformance-host/v1" },
    bridgeExpected: { component: "bridge_worker", contract: "wp12-real-worker-host/v1" },
    fixtureExpected: { component: "addin_loopback_fixture", contract: "addin-loopback/v1" },
    csharpPublishPath: worker,
    gatewayBuildPath: gatewayCli,
    fixtureBuildPath: fixtureCli,
    gatewayControlToken: controlToken,
  });
  const endpoint = supervisor.gatewayReadiness.endpoint;
  const certificateSha256 = supervisor.gatewayReadiness.tlsCertificateSha256;
  if (typeof endpoint !== "string" || typeof certificateSha256 !== "string") {
    await supervisor.stop();
    throw new Error("real trio Gateway readiness did not contain its loopback pin");
  }
  const evidenceFile = path.join(options.evidenceDirectory, `${binding}.document-context-failure.json`);
  const timeline: Array<RealTrioDocumentContextFailure["timeline"][number]> = [];
  const auditCapture: GatewayAuditCapture = { lastSuccessfulAudit: null, lastControlOutcome: null };
  let failureReason: RealTrioDocumentContextFailure["reason"] = "ack_failure";
  let documentContextAudit: RealTrioDocumentContextAudit;
  try {
    // This is the normal attested loopback fixture document-context event;
    // route authority is still earned only when the C# watcher forwards it
    // and the Gateway's public audit observes the live route.
    const controlAudit = documentContextControlAudit(await supervisor.fixtureControl("apply_document_context", {
      event: realTrioFixtureDocumentContextEvent(),
    }));
    // Capture exactly at the acknowledged control boundary. Its final,
    // unmatched probe (if any) is carried separately; all later lifecycle and
    // ACK checks use opaque cursor `since` queries, never array lengths.
    const controlAckSnapshot = supervisor.readDocumentContextSnapshot();
    const precedingProbe = unmatchedDocumentContextProbe(controlAckSnapshot);
    timeline.push("control_ack");
    const gatewayBaseline = gatewayAuditBaseline(await readCapturedRealCaseAudit(supervisor, auditCapture));
    if (gatewayBaseline === null) throw new Error("real trio Gateway audit baseline is unavailable");
    // This probe is value-free and must succeed before any public Gateway
    // route can qualify. The regular 15 s C# watcher is the only forwarder.
    failureReason = "stage_timeout";
    const expected = await waitForDocumentContextSend({
      supervisor,
      controlCursor: controlAckSnapshot.highWaterCursor,
      generation: controlAckSnapshot.generation,
      precedingProbe,
      gatewayBaseline,
      auditCapture,
      timeoutMs: options.documentContextTimeoutMs,
    });
    timeline.push("document_sent");
    failureReason = "ack_failure";
    const counts = probeRealTrioFixtureDocumentContext(
      await supervisor.fixtureControl("snapshot_evidence"),
      controlAudit,
    );
    documentContextAudit = Object.freeze({ ...controlAudit, ...counts });
    timeline.push("fixture_probe");
    // `waitForDocumentContextSend` has already selected this exact candidate
    // against one coherent current-route/accepted-observation audit snapshot.
    // A separate snapshot_audit read would reintroduce a record-version race.
    timeline.push("gateway_route");
    failureReason = "ack_failure";
    await waitForPostRouteDocumentContextHeartbeatAck({
      supervisor,
      expected,
      timeoutMs: options.documentContextTimeoutMs,
    });
    timeline.push("heartbeat_ack");
    const finalAudit = await readCapturedRealCaseAudit(supervisor, auditCapture);
    if (!hasDurableDocumentContextHeartbeatAckFromCursor(
      cursorSinceOrThrow({ supervisor, cursor: expected.controlCursor, generation: expected.generation }), expected,
    ) || !hasGatewayAcceptedDocumentContextRoute(finalAudit, expected, gatewayBaseline)) {
      throw new Error("real trio document-context proof changed before north dispatch");
    }
  } catch (error) {
    const failure = await documentContextFailureError({
      error,
      reason: failureReason,
      binding,
      timeline,
      supervisor,
      endpoint,
      controlToken,
      certificateSha256,
      evidenceFile,
      auditCapture,
    });
    await persistRuntimeFailure({
      evidenceDirectory: options.evidenceDirectory,
      binding,
      phase: "document_context",
      supervisor,
      documentContextEvidence: failure.failureEvidence,
      toolAction: "apply_document_context",
    }).catch(() => undefined);
    await supervisor.stop().catch(() => undefined);
    throw failure;
  }
  try {
    const issued = await publicGatewayControl(
      endpoint,
      controlToken,
      certificateSha256,
      issueNorthCredentialControlPayload(),
    );
    return Object.freeze({
      root,
      binding,
      supervisor,
      credential: credential(issued),
      endpoint,
      certificateSha256,
      documentContextAudit,
      verifyNorthDispatchFence: async (): Promise<void> => {
        const audit = await supervisor.readRealCaseAudit();
        if (!hasDurableDocumentContextHeartbeatAckFromCursor(
          cursorSinceOrThrow({ supervisor, cursor: expected.controlCursor, generation: expected.generation }), expected,
        ) || !hasGatewayAcceptedDocumentContextRoute(audit, expected, gatewayBaseline)) {
          throw new Error("real trio north dispatch fence rejected stale route evidence");
        }
      },
      stop: async () => await supervisor.stop(),
    });
  } catch (error) {
    await persistRuntimeFailure({
      evidenceDirectory: options.evidenceDirectory,
      binding,
      phase: "credential_issue",
      supervisor,
      documentContextEvidence: null,
      toolAction: "issue_north_credential",
    }).catch(() => undefined);
    await supervisor.stop().catch(() => undefined);
    throw error;
  }
}
