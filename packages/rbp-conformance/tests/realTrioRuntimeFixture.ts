import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdtempSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  issueForeignNorthCredentialControlPayload,
  issueNorthCredentialControlPayload,
  type RealTrioNorthCredential,
} from "../src/realTrioCaseDriver.js";
import {
  RealTrioNorthToolResultError,
  type RealTrioNorthToolResultEvidence,
} from "../src/realTrioMcpClient.js";
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
  classifyRealTrioAuditControlFailure,
} from "../src/realTrioSupervisor.js";
import {
  documentContextSourcePair as sharedDocumentContextSourcePair,
  type ParsedDocumentContextCandidate,
  type RealTrioDocumentContextCorrelation,
  type RealTrioDocumentContextSourcePair,
  type RealTrioPreControlWatcherSeed,
} from "../src/realTrioDocumentContextEvidence.js";
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
      value.identityContract !== "revagent.auth-context/v1" ||
      (value.serverMcpSessionId !== undefined &&
        (typeof value.serverMcpSessionId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.serverMcpSessionId)))) {
    throw new Error("real trio north credential control response is malformed");
  }
  return Object.freeze({
    bearer: value.bearer,
    audience: value.audience,
    credentialProvenance: value.credentialProvenance,
    identityContract: value.identityContract,
    ...(typeof value.serverMcpSessionId === "string"
      ? { serverMcpSessionId: value.serverMcpSessionId }
      : {}),
  });
}

export interface RealTrioRuntimeFixture {
  readonly root: string;
  readonly binding: RealTrioBinding;
  readonly supervisor: RealTrioSupervisorResult;
  readonly credential: RealTrioNorthCredential;
  /** Mints a same-principal, different server-bound MCP session for denial tests. */
  issueReboundNorthCredential(): Promise<RealTrioNorthCredential>;
  /** Mints a same-tenant, different-principal server-bound credential. */
  issueForeignNorthCredential(): Promise<RealTrioNorthCredential>;
  readonly endpoint: string;
  readonly certificateSha256: string;
  /** Revalidates the current post-control proof immediately around north I/O. */
  verifyNorthDispatchFence(): Promise<void>;
  /** One strict, two-phase revision refresh for the same fixture document. */
  refreshNorthDispatchFenceAfterControl(): Promise<RealTrioDocumentContextAudit>;
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
  /** Fixture-local cache epoch; revision is never compared without this. */
  readonly cacheIncarnationDigest: `sha256:${string}`;
  readonly cachedContextHash: string;
  readonly activeDocumentIdentityHash: string;
  readonly acknowledgementHash: string;
  readonly cacheReadCount: number;
  readonly pollRequestCount: number;
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
  /** Snapshot-native, value-free pre-control watcher identity. */
  readonly precedingSeed?: RealTrioPreControlWatcherSeed | null;
  readonly audit: unknown;
  readonly baseline: RealTrioGatewayAuditBaseline;
  /** Exact fixture control pair; lifecycle rows cannot borrow an older cache. */
  readonly control: Pick<RealTrioDocumentContextAudit, "revision" | "cacheIncarnationDigest">;
}

export interface RealTrioGatewayAuditBaseline {
  readonly processEpoch: string;
  readonly observationOrdinal: number;
  /** Present only for a successful real-case audit with one current acceptance. */
  readonly acceptedObservationOrdinal?: number;
  /** Value-free exact identity of the baseline's current durable route. */
  readonly currentIdentity?: `sha256:${string}`;
}

/**
 * Fixed, value-free explanation for why the strict selector did not admit a
 * lifecycle.  This is diagnostics-only: callers may proceed only on
 * `selected` and still receive the original candidate/null contract.
 */
export type RealTrioCurrentRouteSelectorReason =
  | "selected"
  | "baseline_missing"
  | "grammar_invalid"
  | "source_pair_missing"
  | "source_pair_mismatch"
  | "audit_join_missing"
  | "audit_epoch_mismatch"
  | "accepted_ordinal_not_fresh"
  | "route_identity_mismatch"
  | "no_candidate"
  | "multiple_candidates"
  | "generation_changed"
  | "cursor_expired";

type RealTrioCurrentRouteSelectorResult =
  | Readonly<{ readonly reason: "selected"; readonly candidate: StrictDocumentContextCandidate }>
  | Readonly<{ readonly reason: Exclude<RealTrioCurrentRouteSelectorReason, "selected"> }>;

export interface RealTrioRuntimeFixtureOptions {
  /** Mandatory caller-owned directory; no production evidence path is inferred. */
  readonly evidenceDirectory: string;
  /** Test-only bound for an observed document-context failure. */
  readonly documentContextTimeoutMs?: number;
  /** C39-only fixed worker launch profile; never a production selector. */
  readonly c39D0PostWriteFault?: boolean;
  /** C39-only terminal fault after durable write observation, before peer delivery. */
  readonly c39TerminalPrePeerFault?: boolean;
  /** Unit-only supervisor/credential seam; production paths never supply it. */
  readonly controlledHarness?: Readonly<{
    readonly supervisor: RealTrioSupervisorResult;
    readonly issueNorthCredential: () => Promise<Record<string, unknown>>;
  }>;
}

export type RealTrioC39WorkerProfile = "none" | "d0_postwrite_once" | "c39_terminal_prepeer_once";

export function resolveRealTrioC39WorkerProfile(options: Pick<
  RealTrioRuntimeFixtureOptions,
  "c39D0PostWriteFault" | "c39TerminalPrePeerFault"
>): RealTrioC39WorkerProfile {
  if (options.c39D0PostWriteFault === true && options.c39TerminalPrePeerFault === true) {
    throw new Error("C39 real trio worker fault profiles are mutually exclusive");
  }
  if (options.c39TerminalPrePeerFault === true) return "c39_terminal_prepeer_once";
  return options.c39D0PostWriteFault === true ? "d0_postwrite_once" : "none";
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
    /** Presence only; cache incarnation values never enter failure evidence. */
    readonly sourcePairPresent: boolean;
    /** Optional only for a valid, positive source pair. */
    readonly sourceRevision?: number;
  }> [];
  /** Immutable pre-control baseline shape, deliberately value-free. */
  readonly preControlBaselinePresent: boolean;
  readonly preControlBaseline: Readonly<{
    readonly processEpochPresent: boolean;
    readonly observationOrdinalPresent: boolean;
    readonly highWaterOrdinalPresent: boolean;
    /** Count of retained audit update rows; this is not an acceptance count. */
    readonly retainedUpdateCount: number | null;
  }>;
  /** Last fixed selector result, retained independently from post-failure audit control. */
  readonly selectorReason: RealTrioCurrentRouteSelectorReason | null;
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
      const source = sourcePair(value);
      retained.push(Object.freeze({
        stage: value.stage,
        outcome: value.outcome,
        sequence: Number.isSafeInteger(value.sequence) ? Number(value.sequence) : null,
        rsidHashPresent: value.rsidHashPresent === true || isSha256(value.rsidHash),
        payloadHashPresent: value.payloadHashPresent === true || isSha256(value.payloadHash),
        sourcePairPresent: source !== null,
        ...(source === null ? {} : { sourceRevision: source.sourceRevision }),
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

function preControlBaselineEvidence(
  baseline: RealTrioGatewayAuditBaseline | null,
  audit: unknown,
): RealTrioDocumentContextFailure["preControlBaseline"] {
  const updateCount = isObject(audit) && Array.isArray(audit.documentContextUpdates)
    ? Math.min(audit.documentContextUpdates.length, MAX_DOCUMENT_CONTEXT_FAILURE_AUDITS)
    : null;
  return Object.freeze({
    processEpochPresent: baseline !== null && isProcessEpoch(baseline.processEpoch),
    observationOrdinalPresent: baseline !== null && Number.isSafeInteger(baseline.observationOrdinal) &&
      baseline.observationOrdinal >= 0,
    highWaterOrdinalPresent: isObject(audit) && Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal) &&
      Number(audit.documentContextObservationHighWaterOrdinal) >= 0,
    retainedUpdateCount: updateCount,
  });
}

interface GatewayAuditCapture {
  lastSuccessfulAudit: unknown | null;
  lastControlOutcome: RealTrioAuditControlOutcome | null;
  preControlBaseline: RealTrioGatewayAuditBaseline | null;
  preControlAudit: unknown | null;
  lastSelectorReason: RealTrioCurrentRouteSelectorReason | null;
}

async function readCapturedRealCaseAuditOutcome(
  supervisor: Pick<RealTrioSupervisorResult, "readRealCaseAuditOutcome">,
  capture: GatewayAuditCapture,
): Promise<RealTrioAuditControlOutcome> {
  const outcome = await supervisor.readRealCaseAuditOutcome();
  capture.lastControlOutcome = outcome;
  if (outcome.outcome === "success") {
    capture.lastSuccessfulAudit = outcome.audit;
  }
  return outcome;
}

async function readCapturedRealCaseAudit(
  supervisor: Pick<RealTrioSupervisorResult, "readRealCaseAuditOutcome">,
  capture: GatewayAuditCapture,
): Promise<unknown> {
  const outcome = await readCapturedRealCaseAuditOutcome(supervisor, capture);
  if (outcome.outcome === "success") {
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
  readonly preControlBaseline?: RealTrioGatewayAuditBaseline | null;
  readonly preControlAudit?: unknown;
  readonly selectorReason?: RealTrioCurrentRouteSelectorReason | null;
  readonly childState: RealTrioDocumentContextFailureState;
}): RealTrioDocumentContextFailure {
  return Object.freeze({
    schemaVersion: REAL_TRIO_DOCUMENT_CONTEXT_FAILURE_SCHEMA,
    reason: input.reason,
    binding: input.binding,
    timeline: Object.freeze([...input.timeline]),
    documentStages: documentContextStages(input.transcript),
    preControlBaselinePresent: input.preControlBaseline !== undefined && input.preControlBaseline !== null,
    preControlBaseline: preControlBaselineEvidence(input.preControlBaseline ?? null, input.preControlAudit),
    selectorReason: input.selectorReason ?? null,
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

/**
 * C38 must retain a redacted, deterministic record when the production MCP
 * boundary returns an explicit isError result.  This deliberately copies only
 * the fixed evidence shape emitted by RealTrioNorthToolResultError; it never
 * serializes the Error object, response, payload, key names, tokens, or paths.
 */
export const REAL_TRIO_MCP_TOOL_RESULT_FAILURE_SCHEMA = "rbp-real-trio-mcp-tool-result-failure/v1" as const;
export const REAL_TRIO_MCP_TOOL_RESULT_WRITE_FAILURE_SCHEMA = "rbp-real-trio-mcp-tool-result-write-failure/v1" as const;
const MAX_MCP_TOOL_RESULT_COLLISION_ARTIFACTS = 8;

export interface RealTrioMcpToolResultFailure {
  readonly schemaVersion: typeof REAL_TRIO_MCP_TOOL_RESULT_FAILURE_SCHEMA;
  readonly binding: RealTrioBinding;
  readonly stage: "north_tool_call";
  readonly resultKeyPresence: RealTrioNorthToolResultEvidence["resultKeyPresence"];
  readonly isError: true;
  readonly content: Readonly<{
    readonly count: number | null;
    readonly items: RealTrioNorthToolResultEvidence["contentItems"];
  }>;
  readonly diagnostic: Readonly<{
    readonly statePresent: boolean;
    readonly reasonPresent: boolean;
    readonly codePresent: boolean;
    readonly errorCodePresent: boolean;
    readonly nestedErrorCodePresent: boolean;
    readonly phasePresent: boolean;
    readonly classPresent: boolean;
    readonly upstreamCodePresent: boolean;
    readonly deliveryOutcomePresent: boolean;
    readonly state: string | null;
    readonly reason: string | null;
    readonly code: string | null;
    readonly errorCode: string | null;
    readonly nestedErrorCode: string | null;
    readonly phase: string | null;
    readonly class: string | null;
    readonly upstreamCode: string | null;
    readonly deliveryOutcome: string | null;
  }>;
}

export interface RealTrioMcpToolResultWriteFailure {
  readonly schemaVersion: typeof REAL_TRIO_MCP_TOOL_RESULT_WRITE_FAILURE_SCHEMA;
  readonly binding: RealTrioBinding;
  readonly stage: "north_tool_call";
  readonly originalError: "RealTrioNorthToolResultError";
  readonly primaryEvidenceSha256: `sha256:${string}`;
  readonly primaryArtifactOutcome: "collision" | "write_failed";
}

export interface RealTrioMcpToolResultPersistence {
  readonly primaryWritten: boolean;
  readonly primaryEvidenceSha256: `sha256:${string}`;
  readonly secondaryWritten: boolean;
}

function copyMcpToolResultFailure(
  binding: RealTrioBinding,
  evidence: RealTrioNorthToolResultEvidence,
): RealTrioMcpToolResultFailure | null {
  // This artifact has one strict meaning: the server marked this tool result
  // isError. Other parser failures retain their original error only.
  if (evidence.isError !== true) return null;
  const diagnostic = evidence.diagnostic;
  return Object.freeze({
    schemaVersion: REAL_TRIO_MCP_TOOL_RESULT_FAILURE_SCHEMA,
    binding,
    stage: "north_tool_call",
    resultKeyPresence: evidence.resultKeyPresence === null ? null : Object.freeze({
      isError: evidence.resultKeyPresence.isError,
      structuredContent: evidence.resultKeyPresence.structuredContent,
      content: evidence.resultKeyPresence.content,
    }),
    isError: true,
    content: Object.freeze({
      count: evidence.contentCount,
      items: Object.freeze(evidence.contentItems.map((item) => Object.freeze({
        type: item.type,
        textUtf8Bytes: item.textUtf8Bytes,
        textSha256: item.textSha256,
      }))),
    }),
    diagnostic: Object.freeze({
      statePresent: diagnostic.statePresent,
      reasonPresent: diagnostic.reasonPresent,
      codePresent: diagnostic.codePresent,
      errorCodePresent: diagnostic.errorCodePresent,
      nestedErrorCodePresent: diagnostic.nestedErrorCodePresent,
      phasePresent: diagnostic.phasePresent,
      classPresent: diagnostic.classPresent,
      upstreamCodePresent: diagnostic.upstreamCodePresent,
      deliveryOutcomePresent: diagnostic.deliveryOutcomePresent,
      state: diagnostic.state,
      reason: diagnostic.reason,
      code: diagnostic.code,
      errorCode: diagnostic.errorCode,
      nestedErrorCode: diagnostic.nestedErrorCode,
      phase: diagnostic.phase,
      class: diagnostic.class,
      upstreamCode: diagnostic.upstreamCode,
      deliveryOutcome: diagnostic.deliveryOutcome,
    }),
  });
}

export type AtomicEvidencePublisher = (temporary: string, destination: string) => void;
type AtomicEvidenceWriteResult = "published" | "exists";

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && (error as { readonly code?: unknown }).code === "EEXIST";
}

/**
 * Publish with a hard-link no-replace primitive.  `rename` is intentionally
 * prohibited here because Windows rename can replace an existing destination.
 */
function writeAtomicEvidence(
  evidenceDirectory: string,
  filename: string,
  value: RealTrioMcpToolResultFailure | RealTrioMcpToolResultWriteFailure,
  publish: AtomicEvidencePublisher = linkSync,
): AtomicEvidenceWriteResult {
  mkdirSync(evidenceDirectory, { recursive: true });
  const destination = path.join(evidenceDirectory, filename);
  const temporary = path.join(evidenceDirectory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  let handle: number | undefined;
  try {
    try {
      handle = openSync(temporary, "wx", 0o600);
      writeSync(handle, `${stableJson(value)}\n`, undefined, "utf8");
      fsyncSync(handle);
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
    try {
      publish(temporary, destination);
      return "published";
    } catch (error) {
      if (isAlreadyExists(error)) return "exists";
      throw error;
    }
  } finally {
    // The evidence is immutable once linked; every temporary is private and
    // must be removed on success, EEXIST, or unsupported-publish failure.
    try { unlinkSync(temporary); } catch { /* no secondary filesystem detail */ }
  }
}

/**
 * Best-effort persistence intentionally never throws: C38 retains the
 * original MCP exception, while a successful secondary artifact makes a
 * primary write failure observable without disclosing its filesystem detail.
 */
export function persistRealTrioMcpToolResultFailure(input: {
  readonly evidenceDirectory: string;
  readonly binding: RealTrioBinding;
  readonly error: RealTrioNorthToolResultError;
  /** Test seam only; production C38 always uses the hard-link publisher. */
  readonly publishForTest?: AtomicEvidencePublisher;
}): RealTrioMcpToolResultPersistence | null {
  const failure = copyMcpToolResultFailure(input.binding, input.error.evidence);
  if (failure === null) return null;
  const primaryEvidenceSha256 = digest(failure) as `sha256:${string}`;
  try {
    const primary = writeAtomicEvidence(
      input.evidenceDirectory,
      "mcp-tool-result-failure.json",
      failure,
      input.publishForTest,
    );
    if (primary === "published") {
      return Object.freeze({ primaryWritten: true, primaryEvidenceSha256, secondaryWritten: false });
    }
    for (let slot = 0; slot < MAX_MCP_TOOL_RESULT_COLLISION_ARTIFACTS; slot += 1) {
      const secondary: RealTrioMcpToolResultWriteFailure = Object.freeze({
        schemaVersion: REAL_TRIO_MCP_TOOL_RESULT_WRITE_FAILURE_SCHEMA,
        binding: input.binding,
        stage: "north_tool_call",
        originalError: "RealTrioNorthToolResultError",
        primaryEvidenceSha256,
        primaryArtifactOutcome: "collision",
      });
      const result = writeAtomicEvidence(
        input.evidenceDirectory,
        `mcp-tool-result-failure-collision-${String(slot)}.json`,
        secondary,
        input.publishForTest,
      );
      if (result === "published") {
        return Object.freeze({ primaryWritten: false, primaryEvidenceSha256, secondaryWritten: true });
      }
    }
    return Object.freeze({ primaryWritten: false, primaryEvidenceSha256, secondaryWritten: false });
  } catch {
    const secondary: RealTrioMcpToolResultWriteFailure = Object.freeze({
      schemaVersion: REAL_TRIO_MCP_TOOL_RESULT_WRITE_FAILURE_SCHEMA,
      binding: input.binding,
      stage: "north_tool_call",
      originalError: "RealTrioNorthToolResultError",
      primaryEvidenceSha256,
      primaryArtifactOutcome: "write_failed",
    });
    try {
      const result = writeAtomicEvidence(
        input.evidenceDirectory,
        "mcp-tool-result-failure-write-failure.json",
        secondary,
        input.publishForTest,
      );
      return Object.freeze({ primaryWritten: false, primaryEvidenceSha256, secondaryWritten: result === "published" });
    } catch {
      return Object.freeze({ primaryWritten: false, primaryEvidenceSha256, secondaryWritten: false });
    }
  }
}

/** The C38 catch path keeps the original error identity and failure outcome. */
export function rethrowRealTrioC38Failure(input: {
  readonly evidenceDirectory: string;
  readonly binding: RealTrioBinding;
  readonly error: unknown;
}): never {
  if (input.error instanceof RealTrioNorthToolResultError) {
    persistRealTrioMcpToolResultFailure({
      evidenceDirectory: input.evidenceDirectory,
      binding: input.binding,
      error: input.error,
    });
  }
  throw input.error;
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
      value.activeDocumentIdentityHash === null || !isSha256(value.cacheIncarnationDigest)) {
    throw new Error("fixture apply_document_context acknowledgement is malformed");
  }
  return Object.freeze({
    revision: Number(value.revision),
    cacheIncarnationDigest: value.cacheIncarnationDigest,
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
      evidence.cacheIncarnationDigest !== expected.cacheIncarnationDigest ||
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

interface StrictDocumentContextCandidate extends ParsedDocumentContextCandidate {
  readonly routeDigest: `sha256:${string}`;
  readonly controlCursor: string;
  readonly precedingProbe: RealTrioDocumentContextCursorRow | null;
  readonly precedingSeed: RealTrioPreControlWatcherSeed | null;
}

type StrictDocumentObservation = Readonly<{
  readonly stage: "probe" | "snapshot" | "queue" | "send" | "ack" | "idle";
  readonly rsidHash: `sha256:${string}`;
  readonly sequence: number | null;
  readonly contextDigest: string | null;
  readonly source: RealTrioDocumentContextSourcePair | null;
}>;

function sourcePair(value: Record<string, unknown>): RealTrioDocumentContextSourcePair | null {
  return sharedDocumentContextSourcePair(value);
}

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
    // A retained row is a journal fact, not an opaque log stream. Once its
    // JSON grammar is broken, a complete pre-control history cannot prove
    // that an omitted document observation was inert.
    return null;
  }
  if (!isObject(value) || value.event !== "bridge.document_context_observation") return undefined;
  if (!isSha256(value.rsidHash) || !(value.sequence === null ||
      (Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 1))) return null;
  const sequence = value.sequence === null ? null : Number(value.sequence);
  const hasContextDigest = value.contextDigest !== null && value.contextDigest !== undefined;
  const context = typeof value.contextDigest === "string" && /^[0-9a-f]{64}$/u.test(value.contextDigest)
    ? value.contextDigest
    : null;
  const hasRevision = value.sourceRevision !== null && value.sourceRevision !== undefined;
  const hasIncarnation = value.cacheIncarnationDigest !== null && value.cacheIncarnationDigest !== undefined;
  if (hasRevision !== hasIncarnation) return null;
  const source = hasRevision ? sourcePair(value) : null;
  if (hasRevision && source === null) return null;
  if (value.stage === "probe" && value.outcome === "started") {
    return Object.freeze({ stage: "probe", rsidHash: value.rsidHash, sequence, contextDigest: null, source });
  }
  if (value.stage === "ack" && value.outcome === "durably_acknowledged" && sequence !== null) {
    return Object.freeze({ stage: "ack", rsidHash: value.rsidHash, sequence, contextDigest: null, source });
  }
  if ((value.stage === "snapshot" && value.outcome === "ready") ||
      (value.stage === "queue" && value.outcome === "durably_queued") ||
      (value.stage === "send" && value.outcome === "sent")) {
    // A snapshot establishes only watcher identity and context.  The durable
    // queue operation is the sole source of the cycle sequence.
    if ((value.stage === "snapshot" && sequence !== null) ||
        (value.stage !== "snapshot" && sequence === null) || context === null || source === null) return null;
    return Object.freeze({ stage: value.stage, rsidHash: value.rsidHash, sequence, contextDigest: context, source });
  }
  // A warming cache is an explicit value-free poll result. It can separate
  // settled watcher epochs, but it cannot carry or complete a route cycle.
  if (value.stage === "snapshot" && value.outcome === "not_ready") {
    if (sequence !== null || hasContextDigest || hasRevision || hasIncarnation) return null;
    return Object.freeze({ stage: "idle", rsidHash: value.rsidHash, sequence: null,
      contextDigest: null, source: null });
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
  readonly currentWatcher: RealTrioPreControlWatcherSeed | null;
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
  readonly precedingSeed?: RealTrioPreControlWatcherSeed | null;
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
    cycle: { readonly sequence: number | null; readonly contextDigest: string; readonly source: RealTrioDocumentContextSourcePair; readonly startCursor: string; readonly startIndex: number; readonly stage: "snapshot" | "queue" } | null;
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

  if (input.precedingProbe !== null && input.precedingSeed !== undefined && input.precedingSeed !== null) return null;
  if (input.precedingSeed !== undefined && input.precedingSeed !== null) {
    const seed = input.precedingSeed;
    if (seed.generation !== input.generation || !Number.isSafeInteger(seed.watcherOrdinal) || seed.watcherOrdinal < 1 ||
        !isSha256(seed.rsidHash) ||
        !(seed.lastSentSequence === null || (Number.isSafeInteger(seed.lastSentSequence) && seed.lastSentSequence >= 1)) ||
        !(seed.lastAckSequence === null || (Number.isSafeInteger(seed.lastAckSequence) && seed.lastAckSequence >= 1)) ||
        ((seed.lastSentSequence === null) !== (seed.lastAckSequence === null)) ||
        (seed.lastSentSequence !== null && seed.lastAckSequence! < seed.lastSentSequence)) return null;
    watcher = {
      ordinal: seed.watcherOrdinal,
      rsidHash: seed.rsidHash,
      lastSentSequence: seed.lastSentSequence,
      lastAcknowledgedSequence: seed.lastAckSequence,
      cycle: null,
      sent: new Map(),
    };
    nextWatcherOrdinal = seed.watcherOrdinal;
  } else if (input.precedingProbe !== null) {
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

    if (observation.stage === "idle") {
      if (watcher.cycle !== null) return null;
      continue;
    }

    if (observation.stage === "ack") {
      const sequence = observation.sequence!;
      const sent = watcher.sent.get(sequence);
      if (sent === undefined) {
        // The observer can attach after durable journal sends already exist.
        // A monotonic ACK with no locally observed candidate establishes only
        // a value-free settled sequence baseline; it never creates a route.
        if (watcher.cycle !== null || watcher.lastSentSequence !== watcher.lastAcknowledgedSequence ||
            (watcher.lastAcknowledgedSequence !== null && sequence <= watcher.lastAcknowledgedSequence)) return null;
        watcher.lastSentSequence = sequence;
        watcher.lastAcknowledgedSequence = sequence;
        continue;
      }
      if (watcher.lastAcknowledgedSequence !== null && sequence <= watcher.lastAcknowledgedSequence) return null;
      watcher.lastAcknowledgedSequence = sequence;
      acknowledgements.set(candidateKey(watcher.ordinal, observation.rsidHash, sequence), index);
      continue;
    }

    if (observation.stage === "snapshot") {
      if (watcher.cycle !== null) return null;
      watcher.cycle = {
        sequence: null,
        contextDigest: observation.contextDigest!,
        source: observation.source!,
        startCursor: row.cursor,
        startIndex: index,
        stage: "snapshot",
      };
      continue;
    }
    if (observation.stage === "queue") {
      if (watcher.cycle === null || watcher.cycle.stage !== "snapshot" ||
          watcher.cycle.contextDigest !== observation.contextDigest ||
          watcher.cycle.source.sourceRevision !== observation.source!.sourceRevision ||
          watcher.cycle.source.cacheIncarnationDigest !== observation.source!.cacheIncarnationDigest ||
          (watcher.lastSentSequence !== null && observation.sequence! <= watcher.lastSentSequence)) return null;
      watcher.cycle = { ...watcher.cycle, sequence: observation.sequence!, stage: "queue" };
      continue;
    }
    // send/sent completes exactly the snapshot -> queue -> send cycle.
    if (watcher.cycle === null || watcher.cycle.stage !== "queue" ||
        watcher.cycle.sequence !== observation.sequence ||
        watcher.cycle.contextDigest !== observation.contextDigest ||
        watcher.cycle.source.sourceRevision !== observation.source!.sourceRevision ||
        watcher.cycle.source.cacheIncarnationDigest !== observation.source!.cacheIncarnationDigest) return null;
    const candidate = Object.freeze({
      rsidHash: watcher.rsidHash,
      sequence: observation.sequence!,
      sendCursor: row.cursor,
      generation: input.generation,
      sendTranscriptIndex: index,
      sendRecordedAt: row.at.length === 0 ? null : row.at,
      contextDigest: observation.contextDigest!,
      source: observation.source!,
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
    currentWatcherOrdinal: watcher?.ordinal ?? 0,
    currentWatcher: watcher === null ? null : Object.freeze({
      generation: input.generation,
      highWaterCursor: previous.toString(),
      watcherOrdinal: watcher.ordinal,
      rsidHash: watcher.rsidHash,
      lastSentSequence: watcher.lastSentSequence,
      lastAckSequence: watcher.lastAcknowledgedSequence,
    }) });
}

/**
 * A seed may be made only from the complete retained generation.  The ring is
 * not a historic lookup facility: a non-genesis low-water cursor means the
 * opening probe could already have been evicted and is therefore unsafe.
 */
export function preControlWatcherSeedFromSnapshot(
  snapshot: RealTrioDocumentContextSnapshot,
): RealTrioPreControlWatcherSeed | null {
  const state = preControlWatcherSnapshotState(snapshot);
  return state.kind === "seed" ? state.seed : null;
}

type PreControlWatcherSnapshotState =
  | Readonly<{ readonly kind: "seed"; readonly seed: RealTrioPreControlWatcherSeed }>
  | Readonly<{ readonly kind: "ack_pending" }>
  | Readonly<{ readonly kind: "bootstrap_pending" }>
  | Readonly<{ readonly kind: "invalid" }>;

function preControlWatcherSnapshotState(
  snapshot: RealTrioDocumentContextSnapshot,
): PreControlWatcherSnapshotState {
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
      !/^(?:0|[1-9][0-9]*)$/u.test(snapshot.lowWaterCursor) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(snapshot.highWaterCursor)) return Object.freeze({ kind: "invalid" });
  const lowWater = BigInt(snapshot.lowWaterCursor);
  const highWater = BigInt(snapshot.highWaterCursor);
  const compact = snapshot.settledWatcherSeed;
  const compactValid = compact !== undefined && compact !== null &&
    compact.generation === snapshot.generation && compact.highWaterCursor === snapshot.highWaterCursor &&
    Number.isSafeInteger(compact.watcherOrdinal) && compact.watcherOrdinal >= 1 && isSha256(compact.rsidHash) &&
    ((compact.lastSentSequence === null && compact.lastAckSequence === null) ||
      (Number.isSafeInteger(compact.lastSentSequence) && Number(compact.lastSentSequence) >= 1 &&
       Number.isSafeInteger(compact.lastAckSequence) && Number(compact.lastAckSequence) >= Number(compact.lastSentSequence)));
  // A new process may expose an exact empty genesis ring before its first
  // watcher probe. This is a wait-only state, never a usable route seed.
  if (snapshot.rows.length === 0 && lowWater === 0n && highWater === 0n) {
    return Object.freeze({ kind: "bootstrap_pending" });
  }
  if (lowWater > 1n) {
    return compactValid ? Object.freeze({ kind: "seed", seed: compact! }) : Object.freeze({ kind: "invalid" });
  }
  if (snapshot.rows.length === 0 || snapshot.rows.some((row) => !/^[1-9][0-9]*$/u.test(row.cursor)) ||
      lowWater !== 1n || highWater < lowWater ||
      BigInt(snapshot.rows[0]!.cursor) !== lowWater ||
      BigInt(snapshot.rows.at(-1)!.cursor) !== highWater) return Object.freeze({ kind: "invalid" });
  const parsed = parseDocumentContextGrammar({ rows: snapshot.rows, generation: snapshot.generation,
    controlCursor: "0", precedingProbe: null });
  if (parsed === null || parsed.currentWatcher === null || parsed.currentWatcher.watcherOrdinal < 1) {
    return Object.freeze({ kind: "invalid" });
  }
  // A seed is valid only after every retained watcher history has settled.
  // In particular, a later empty probe cannot erase an unacknowledged send in
  // an earlier watcher. `parseDocumentContextGrammar` binds ACKs to their
  // watcher and rejects wrong/backward/duplicate ACKs; this pass requires one
  // exact post-send ACK for every completed cycle through high water.
  const unacknowledged = parsed.candidates.filter((candidate) => {
    const acknowledgedAt = parsed.acknowledgements.get(
      candidateKey(candidate.watcherOrdinal, candidate.rsidHash, candidate.sequence),
    );
    return acknowledgedAt === undefined || acknowledgedAt <= candidate.sendTranscriptIndex;
  });
  if (unacknowledged.length === 0) {
    if (compact !== undefined && (!compactValid || compact!.watcherOrdinal !== parsed.currentWatcher.watcherOrdinal ||
        compact!.rsidHash !== parsed.currentWatcher.rsidHash || compact!.lastSentSequence !== parsed.currentWatcher.lastSentSequence ||
        compact!.lastAckSequence !== parsed.currentWatcher.lastAckSequence)) return Object.freeze({ kind: "invalid" });
    return Object.freeze({ kind: "seed", seed: parsed.currentWatcher });
  }
  const outstanding = unacknowledged[0];
  if (unacknowledged.length === 1 && outstanding !== undefined &&
      outstanding.watcherOrdinal === parsed.currentWatcher.watcherOrdinal &&
      outstanding.sequence === parsed.currentWatcher.lastSentSequence) {
    return Object.freeze({ kind: "ack_pending" });
  }
  return Object.freeze({ kind: "invalid" });
}

function snapshotsAreSameCompleteGeneration(
  first: RealTrioDocumentContextSnapshot,
  second: RealTrioDocumentContextSnapshot,
): boolean {
  const sameRows = first.rows.length === second.rows.length && first.rows.every((row, index) => {
    const candidate = second.rows[index];
    return candidate !== undefined && candidate.cursor === row.cursor && candidate.at === row.at && candidate.line === row.line;
  });
  return first.generation === second.generation && first.highWaterCursor === second.highWaterCursor &&
    first.lowWaterCursor === second.lowWaterCursor && sameRows;
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

function currentAcceptedObservationState(
  audit: unknown,
  current: CurrentRouteAuditIdentity,
  baseline: RealTrioGatewayAuditBaseline,
): "one" | "missing" | "not_fresh" | "multiple" {
  if (!isObject(audit) || !Array.isArray(audit.documentContextUpdates) ||
      !Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal)) return "missing";
  const matching = audit.documentContextUpdates.filter((value) => isObject(value) &&
    value.contractVersion === "revagent.wp12-document-context-audit/v1" &&
    value.event === "gateway.doc_context_update_observation" && value.stage === "accepted" &&
    value.processEpoch === baseline.processEpoch && value.rsidHash === current.rsidHash &&
    value.observedSequence === current.sequence && value.contextDigest === current.contextDigest &&
    value.routeDigest === current.routeDigest && value.recordDigest === current.recordDigest &&
    value.sessionBindingDigest === current.sessionBindingDigest && value.connectionDigest === current.connectionDigest &&
    value.sessionRecordVersion === current.sessionRecordVersion);
  if (matching.length === 0) return "missing";
  const highWater = Number(audit.documentContextObservationHighWaterOrdinal);
  const fresh = matching.filter((value) => Number.isSafeInteger(value.observationOrdinal) &&
    Number(value.observationOrdinal) > baseline.observationOrdinal && Number(value.observationOrdinal) <= highWater);
  if (fresh.length === 1) return "one";
  if (fresh.length > 1) return "multiple";
  return "not_fresh";
}

function cursorState(input: RealTrioCurrentRouteSelectorInput): "ok" | "expired" | "invalid" {
  if (input.rows.length === 0) return "ok";
  const first = input.rows[0];
  if (first === undefined || !/^[1-9][0-9]*$/u.test(first.cursor) ||
      !/^(?:0|[1-9][0-9]*)$/u.test(input.controlCursor)) return "invalid";
  const expected = BigInt(input.controlCursor) + 1n;
  const actual = BigInt(first.cursor);
  return actual > expected ? "expired" : actual === expected ? "ok" : "invalid";
}

function isPayloadBearingDocumentContextStage(stage: unknown, outcome: unknown): boolean {
  return (stage === "snapshot" && outcome === "ready") ||
    (stage === "queue" && outcome === "durably_queued") ||
    (stage === "send" && outcome === "sent");
}

function hasMissingSourcePair(input: RealTrioCurrentRouteSelectorInput): boolean {
  for (const row of input.rows) {
    try {
      const value = JSON.parse(row.line) as unknown;
      if (!isObject(value) || !isPayloadBearingDocumentContextStage(value.stage, value.outcome)) continue;
      if (sourcePair(value) === null) return true;
    } catch {
      // Grammar owns malformed JSON/non-document rows; do not relabel it.
    }
  }
  return false;
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
  const result = selectCurrentDocumentContextSendReason(input);
  return result.reason === "selected" ? result.candidate : null;
}

/** Internal fixed-reason selector; acceptance remains the wrapper above. */
export function selectCurrentDocumentContextSendReason(
  input: RealTrioCurrentRouteSelectorInput,
): RealTrioCurrentRouteSelectorResult {
  if (!isProcessEpoch(input.baseline.processEpoch) || !Number.isSafeInteger(input.baseline.observationOrdinal) ||
      input.baseline.observationOrdinal < 0) return Object.freeze({ reason: "baseline_missing" });
  if (!isObject(input.audit)) return Object.freeze({ reason: "audit_join_missing" });
  if (!Number.isSafeInteger(input.audit.documentContextGeneration)) return Object.freeze({ reason: "audit_join_missing" });
  if (input.audit.documentContextGeneration !== input.generation) return Object.freeze({ reason: "generation_changed" });
  if (input.audit.documentContextProcessEpoch !== input.baseline.processEpoch) {
    return Object.freeze({ reason: "audit_epoch_mismatch" });
  }
  if (!Number.isSafeInteger(input.audit.documentContextObservationHighWaterOrdinal) ||
      Number(input.audit.documentContextObservationHighWaterOrdinal) < input.baseline.observationOrdinal) {
    return Object.freeze({ reason: "accepted_ordinal_not_fresh" });
  }
  const cursor = cursorState(input);
  if (cursor === "expired") return Object.freeze({ reason: "cursor_expired" });
  if (cursor === "invalid") return Object.freeze({ reason: "grammar_invalid" });
  if (hasMissingSourcePair(input)) return Object.freeze({ reason: "source_pair_missing" });
  const parsed = parseDocumentContextGrammar(input);
  const current = currentRouteAuditIdentity(input.audit, input.baseline);
  if (parsed === null) return Object.freeze({ reason: "grammar_invalid" });
  if (current === null) return Object.freeze({ reason: "audit_join_missing" });
  const acceptance = currentAcceptedObservationState(input.audit, current, input.baseline);
  if (acceptance === "not_fresh") return Object.freeze({ reason: "accepted_ordinal_not_fresh" });
  if (acceptance === "multiple") return Object.freeze({ reason: "multiple_candidates" });
  if (acceptance !== "one") return Object.freeze({ reason: "audit_join_missing" });
  const watcherCandidates = parsed.candidates.filter((candidate) => candidate.watcherOrdinal === parsed.currentWatcherOrdinal);
  if (watcherCandidates.length === 0) return Object.freeze({ reason: "no_candidate" });
  const routeCandidates = watcherCandidates.filter((candidate) =>
    candidate.rsidHash === current.rsidHash && candidate.sequence === current.sequence &&
    candidate.contextDigest === current.contextDigest);
  if (routeCandidates.length === 0) return Object.freeze({ reason: "route_identity_mismatch" });
  const selected = routeCandidates.filter((candidate) =>
    candidate.source.sourceRevision === input.control.revision &&
    candidate.source.cacheIncarnationDigest === input.control.cacheIncarnationDigest);
  if (selected.length === 0) return Object.freeze({ reason: "source_pair_mismatch" });
  if (selected.length !== 1) return Object.freeze({ reason: "multiple_candidates" });
  return Object.freeze({ reason: "selected", candidate: Object.freeze({ ...selected[0]!, routeDigest: current.routeDigest,
    controlCursor: input.controlCursor, precedingProbe: input.precedingProbe,
    precedingSeed: input.precedingSeed ?? null }) });
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
  readonly precedingSeed: RealTrioPreControlWatcherSeed | null;
  readonly gatewayBaseline: RealTrioGatewayAuditBaseline;
  readonly control: Pick<RealTrioDocumentContextAudit, "revision" | "cacheIncarnationDigest">;
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
    const selection = selectCurrentDocumentContextSendReason({
      rows,
      generation: input.generation,
      controlCursor: input.controlCursor,
      precedingProbe: input.precedingProbe,
      precedingSeed: input.precedingSeed,
      audit: await readCapturedRealCaseAudit(input.supervisor, input.auditCapture),
      baseline: input.gatewayBaseline,
      control: input.control,
    });
    input.auditCapture.lastSelectorReason = selection.reason;
    if (selection.reason === "selected") return selection.candidate;
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
    controlCursor: expected.controlCursor, precedingProbe: expected.precedingProbe,
    precedingSeed: expected.precedingSeed });
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
      current === null || !isSha256(routeDigest) ||
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
    Number(value.observationOrdinal) <= Number(audit.documentContextObservationHighWaterOrdinal));
  return candidates.length === 1;
}

export function gatewayAuditBaseline(audit: unknown): RealTrioGatewayAuditBaseline | null {
  if (!isObject(audit) || audit.documentContextEpochSchema !== "revagent.wp12-document-context-epoch/v1" ||
      !isProcessEpoch(audit.documentContextProcessEpoch) || !Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal) ||
      Number(audit.documentContextObservationHighWaterOrdinal) < 0) return null;
  const baseline = Object.freeze({ processEpoch: audit.documentContextProcessEpoch,
    observationOrdinal: Number(audit.documentContextObservationHighWaterOrdinal) });
  const current = currentRouteAuditIdentity(audit, baseline);
  if (current === null || !Array.isArray(audit.documentContextUpdates)) return baseline;
  const accepted = audit.documentContextUpdates.filter((value) => isObject(value) &&
    value.contractVersion === "revagent.wp12-document-context-audit/v1" &&
    value.event === "gateway.doc_context_update_observation" && value.stage === "accepted" &&
    value.processEpoch === baseline.processEpoch && value.rsidHash === current.rsidHash &&
    value.observedSequence === current.sequence && value.contextDigest === current.contextDigest &&
    value.routeDigest === current.routeDigest && value.recordDigest === current.recordDigest &&
    value.sessionBindingDigest === current.sessionBindingDigest && value.connectionDigest === current.connectionDigest &&
    value.sessionRecordVersion === current.sessionRecordVersion && Number.isSafeInteger(value.observationOrdinal) &&
    Number(value.observationOrdinal) >= 1 && Number(value.observationOrdinal) <= baseline.observationOrdinal);
  if (accepted.length !== 1) return baseline;
  return Object.freeze({ ...baseline, acceptedObservationOrdinal: Number(accepted[0]!.observationOrdinal),
    currentIdentity: digest(current) as `sha256:${string}` });
}

export interface RealTrioPreControlBundle {
  readonly snapshot: RealTrioDocumentContextSnapshot;
  readonly baseline: RealTrioGatewayAuditBaseline;
  readonly audit: unknown;
  readonly seed: RealTrioPreControlWatcherSeed;
}

export class RealTrioPreControlCaptureError extends Error {
  public constructor(
    readonly reason: "ack_timeout" | "invalid_history" | "generation_changed" | "child_exit" |
      `audit_${RealTrioAuditControlFailure["error"]}`,
  ) {
    super(`real trio pre-control capture failed closed: ${reason}`);
    this.name = "RealTrioPreControlCaptureError";
  }
}

export function verifiedRealTrioDocumentContextState(
  expected: StrictDocumentContextCandidate | undefined,
  gatewayBaseline: RealTrioGatewayAuditBaseline | undefined,
): Readonly<{ readonly expected: StrictDocumentContextCandidate; readonly gatewayBaseline: RealTrioGatewayAuditBaseline }> {
  if (expected === undefined || gatewayBaseline === undefined) {
    throw new Error("real trio internal-state missing verified document-context proof");
  }
  return Object.freeze({
    expected: Object.freeze({ ...expected }),
    gatewayBaseline: Object.freeze({ ...gatewayBaseline }),
  });
}

/**
 * Capture an atomic causal floor before the fixture control. The two complete
 * ring snapshots prevent a Gateway audit from being paired with a cursor
 * history that advanced or was evicted while it was read. A send that has not
 * yet been durably ACKed is retried as a whole bundle; it is never seeded.
 */
export async function capturePreControlDocumentContextBundle(input: {
  readonly supervisor: Pick<RealTrioSupervisorResult, "readDocumentContextSnapshot"> &
    Partial<Pick<RealTrioSupervisorResult, "readDocumentContextFailureState">>;
  readonly readGatewayAuditOutcome: () => Promise<RealTrioAuditControlOutcome>;
  /** Existing document-context ACK/route deadline; default covers 15 s production heartbeat plus jitter. */
  readonly timeoutMs?: number;
  /** Bounded observation poll. Production callers use 100 ms; tests may inject 50-100 ms. */
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<RealTrioPreControlBundle> {
  const timeoutMs = input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 50 || pollIntervalMs > 100) throw new Error("invalid real trio pre-control capture timing bound");
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (milliseconds: number): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  });
  const deadline = now() + timeoutMs;
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState?.().childExited === true) {
      throw new RealTrioPreControlCaptureError("child_exit");
    }
    const first = input.supervisor.readDocumentContextSnapshot();
    let audit: unknown = null;
    let baseline: RealTrioGatewayAuditBaseline | null = null;
    let auditFailure: RealTrioAuditControlFailure | null = null;
    try {
      const outcome = await input.readGatewayAuditOutcome();
      if (outcome.outcome === "success") {
        audit = outcome.audit;
        baseline = gatewayAuditBaseline(audit);
      } else auditFailure = outcome;
    } catch (error) {
      auditFailure = classifyRealTrioAuditControlFailure(error, false);
    }
    if (auditFailure !== null && !isTransientPreControlAuditFailure(auditFailure)) {
      throw new RealTrioPreControlCaptureError(`audit_${auditFailure.error}`);
    }
    // Timeouts and the explicit 503 real-case-audit-unavailable shape are
    // transient only until this one document-context deadline.
    const second = input.supervisor.readDocumentContextSnapshot();
    if (first.generation !== second.generation) throw new RealTrioPreControlCaptureError("generation_changed");
    const firstState = preControlWatcherSnapshotState(first);
    const secondState = preControlWatcherSnapshotState(second);
    if (firstState.kind === "invalid" || secondState.kind === "invalid") {
      throw new RealTrioPreControlCaptureError("invalid_history");
    }
    if (snapshotsAreSameCompleteGeneration(first, second) && secondState.kind === "seed" &&
        baseline !== null && baseline.acceptedObservationOrdinal !== undefined && baseline.currentIdentity !== undefined) {
      return Object.freeze({ snapshot: second, baseline, audit, seed: secondState.seed });
    }
    if (now() >= deadline) throw new RealTrioPreControlCaptureError("ack_timeout");
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
}

function isTransientPreControlAuditFailure(failure: RealTrioAuditControlFailure): boolean {
  return failure.error === "timeout" || (failure.error === "http_status_5xx" &&
    failure.statusCode === 503 && failure.okKeyPresent && failure.actionKeyPresent);
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
  const audit = snapshot.sessionAudit;
  if (audit === null || typeof audit !== "object" || Array.isArray(audit) ||
      (audit as Record<string, unknown>).status !== "candidate" ||
      (audit as Record<string, unknown>).candidateCount !== 1) return false;
  const projection = (audit as Record<string, unknown>).projection;
  if (projection === null || typeof projection !== "object" || Array.isArray(projection)) return false;
  const readiness = (projection as Record<string, unknown>).readiness;
  if (readiness === null || typeof readiness !== "object" || Array.isArray(readiness)) return false;
  const route = (readiness as Record<string, unknown>).liveDocumentRoute;
  return route !== null && typeof route === "object" && !Array.isArray(route) &&
    (route as Record<string, unknown>).sessionDocumentId === expectedDocumentId;
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
    preControlBaseline: input.auditCapture.preControlBaseline,
    preControlAudit: input.auditCapture.preControlAudit,
    selectorReason: input.auditCapture.lastSelectorReason,
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
  const c39Profile = resolveRealTrioC39WorkerProfile(options);
  const root = mkdtempSync(path.join(tmpdir(), "revagent-wp12-real-trio-"));
  mkdirSync(path.join(root, "install"), { recursive: true });
  mkdirSync(path.join(root, "state"), { recursive: true });
  const tls = createEphemeralLoopbackTlsIdentity(root);
  const controlToken = `wp12-${path.basename(root)}`;
  const controlledHarness = options.controlledHarness;
  const gatewayCli = controlledHarness === undefined
    ? requiredFile("packages/gateway/dist/productionConformanceHostCli.js") : "controlled-gateway";
  const fixtureCli = controlledHarness === undefined
    ? requiredFile("packages/addin-loopback-fixture/dist/cli.js") : "controlled-fixture";
  const worker = controlledHarness === undefined ? requiredRealTrioWorker() : "controlled-worker";
  const supervisor = controlledHarness?.supervisor ?? await startRealTrioSupervisor({
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
        ...(c39Profile !== "none"
          ? ["--test-c39-profile", c39Profile]
          : []),
      ],
      workingDirectory: repoRoot,
    },
    fixture: {
      executable: node24,
      args: [fixtureCli, "--host", "127.0.0.1", "--port", "0"],
      workingDirectory: repoRoot,
    },
    gatewayExpected: { component: "gateway_production_conformance", contract: "wp12-production-conformance-host/v1" },
    bridgeExpected: {
      component: "bridge_worker",
      contract: "wp12-real-worker-host/v1",
      c39Profile,
    },
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
  const auditCapture: GatewayAuditCapture = { lastSuccessfulAudit: null, lastControlOutcome: null,
    preControlBaseline: null, preControlAudit: null, lastSelectorReason: null };
  let failureReason: RealTrioDocumentContextFailure["reason"] = "ack_failure";
  let documentContextAudit: RealTrioDocumentContextAudit;
  let expected: StrictDocumentContextCandidate | undefined;
  let gatewayBaseline: RealTrioGatewayAuditBaseline | undefined;
  try {
    // This is the normal attested loopback fixture document-context event;
    // route authority is still earned only when the C# watcher forwards it
    // and the Gateway's public audit observes the live route.
    // Snapshot A / successful Gateway audit / snapshot B is one immutable
    // causal floor. The retained generation must be complete and settled
    // through its latest watcher ACK before the control may be applied.
    const preControl = await capturePreControlDocumentContextBundle({
      supervisor,
      readGatewayAuditOutcome: () => readCapturedRealCaseAuditOutcome(supervisor, auditCapture),
      timeoutMs: options.documentContextTimeoutMs,
    });
    const preControlSnapshot = preControl.snapshot;
    const preControlAudit = preControl.audit;
    const selectedGatewayBaseline = preControl.baseline;
    gatewayBaseline = selectedGatewayBaseline;
    const precedingSeed = preControl.seed;
    auditCapture.preControlAudit = preControlAudit;
    auditCapture.preControlBaseline = selectedGatewayBaseline;
    const controlAudit = documentContextControlAudit(await supervisor.fixtureControl("apply_document_context", {
      event: realTrioFixtureDocumentContextEvent(),
    }));
    // Capture exactly at the acknowledged control boundary. Post-control
    // parsing starts snapshot-first from the value-free settled watcher seed;
    // all later lifecycle and ACK checks use opaque cursor `since` queries.
    const controlAckSnapshot = supervisor.readDocumentContextSnapshot();
    if (controlAckSnapshot.generation !== preControlSnapshot.generation ||
        BigInt(controlAckSnapshot.highWaterCursor) < BigInt(preControlSnapshot.highWaterCursor)) {
      throw new Error("real trio document-context generation changed across control");
    }
    timeline.push("control_ack");
    if (typeof supervisor.pollDocumentContext === "function" &&
        await supervisor.pollDocumentContext() !== "emitted") {
      throw new Error("real worker immediate document-context poll did not emit a changed context");
    }
    timeline.push("poll_requested");
    // This probe is value-free and must succeed before any public Gateway
    // route can qualify. The regular 15 s C# watcher is the only forwarder.
    failureReason = "stage_timeout";
    const selectedExpected = await waitForDocumentContextSend({
      supervisor,
      controlCursor: preControlSnapshot.highWaterCursor,
      generation: preControlSnapshot.generation,
      precedingProbe: null,
      precedingSeed,
      gatewayBaseline: selectedGatewayBaseline,
      control: controlAudit,
      auditCapture,
      timeoutMs: options.documentContextTimeoutMs,
    });
    expected = selectedExpected;
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
      expected: selectedExpected,
      timeoutMs: options.documentContextTimeoutMs,
    });
    timeline.push("heartbeat_ack");
    const finalAudit = await readCapturedRealCaseAudit(supervisor, auditCapture);
    if (!hasDurableDocumentContextHeartbeatAckFromCursor(
      cursorSinceOrThrow({ supervisor, cursor: selectedExpected.controlCursor, generation: selectedExpected.generation }), selectedExpected,
    ) || !hasGatewayAcceptedDocumentContextRoute(finalAudit, selectedExpected, selectedGatewayBaseline)) {
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
  let verified: Readonly<{ readonly expected: StrictDocumentContextCandidate; readonly gatewayBaseline: RealTrioGatewayAuditBaseline }>;
  try {
    verified = verifiedRealTrioDocumentContextState(expected, gatewayBaseline);
  } catch (error) {
    await supervisor.stop().catch(() => undefined);
    throw error;
  }
  let verifiedExpected = verified.expected;
  let verifiedGatewayBaseline = verified.gatewayBaseline;
  try {
    const issued = controlledHarness === undefined
      ? await publicGatewayControl(endpoint, controlToken, certificateSha256, issueNorthCredentialControlPayload())
      : await controlledHarness.issueNorthCredential();
    return Object.freeze({
      root,
      binding,
      supervisor,
      credential: credential(issued),
      issueReboundNorthCredential: async (): Promise<RealTrioNorthCredential> => {
        if (controlledHarness !== undefined) {
          return credential(await controlledHarness.issueNorthCredential());
        }
        return credential(await publicGatewayControl(
          endpoint, controlToken, certificateSha256, issueNorthCredentialControlPayload(),
        ));
      },
      issueForeignNorthCredential: async (): Promise<RealTrioNorthCredential> => {
        if (controlledHarness !== undefined) {
          throw new Error("controlled real-trio harness cannot mint a foreign C39 credential");
        }
        return credential(await publicGatewayControl(
          endpoint, controlToken, certificateSha256, issueForeignNorthCredentialControlPayload(),
        ));
      },
      endpoint,
      certificateSha256,
      documentContextAudit,
      verifyNorthDispatchFence: async (): Promise<void> => {
        const audit = await supervisor.readRealCaseAudit();
        if (!hasDurableDocumentContextHeartbeatAckFromCursor(
          cursorSinceOrThrow({ supervisor, cursor: verifiedExpected.controlCursor, generation: verifiedExpected.generation }), verifiedExpected,
        ) || !hasGatewayAcceptedDocumentContextRoute(audit, verifiedExpected, verifiedGatewayBaseline)) {
          throw new Error("real trio north dispatch fence rejected stale route evidence");
        }
      },
      refreshNorthDispatchFenceAfterControl: async (): Promise<RealTrioDocumentContextAudit> => {
        const refreshAuditCapture: GatewayAuditCapture = {
          lastSuccessfulAudit: null, lastControlOutcome: null,
          preControlBaseline: null, preControlAudit: null, lastSelectorReason: null,
        };
        const deadline = Date.now() + (options.documentContextTimeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
        let firstAudit: JsonObject;
        let firstSnapshot: RealTrioDocumentContextSnapshot;
        let refreshBaseline: RealTrioGatewayAuditBaseline;
        let refreshSeed: RealTrioPreControlWatcherSeed;
        let lastBaselineReason = "transition";
        for (;;) {
          const candidateFirstAudit = await readCapturedRealCaseAudit(supervisor, refreshAuditCapture);
          const candidateFirstSnapshot = supervisor.readDocumentContextSnapshot();
          const candidateSecondAudit = await readCapturedRealCaseAudit(supervisor, refreshAuditCapture);
          const candidateSecondSnapshot = supervisor.readDocumentContextSnapshot();
          const candidateBaseline = gatewayAuditBaseline(candidateFirstAudit);
          const secondBaseline = gatewayAuditBaseline(candidateSecondAudit);
          const candidateSeed = preControlWatcherSeedFromSnapshot(candidateSecondSnapshot);
          const sameBaseline = candidateBaseline !== null && secondBaseline !== null &&
            candidateBaseline.processEpoch === secondBaseline.processEpoch &&
            candidateBaseline.acceptedObservationOrdinal === secondBaseline.acceptedObservationOrdinal &&
            candidateBaseline.currentIdentity === secondBaseline.currentIdentity;
          const absent = candidateFirstAudit.documentContextCurrentRoute === null && candidateSecondAudit.documentContextCurrentRoute === null &&
            Array.isArray(candidateFirstAudit.documentContextUpdates) && candidateFirstAudit.documentContextUpdates.length === 0 &&
            Array.isArray(candidateSecondAudit.documentContextUpdates) && candidateSecondAudit.documentContextUpdates.length === 0 &&
            candidateBaseline?.acceptedObservationOrdinal === undefined && candidateBaseline?.currentIdentity === undefined;
          const current = candidateFirstAudit.documentContextCurrentRoute !== null && candidateSecondAudit.documentContextCurrentRoute !== null &&
            candidateBaseline?.acceptedObservationOrdinal !== undefined && candidateBaseline?.currentIdentity !== undefined;
          const reason = candidateBaseline === null || secondBaseline === null ? "malformed" :
            candidateFirstSnapshot.generation !== candidateSecondSnapshot.generation ? "snapshot_generation" :
            BigInt(candidateSecondSnapshot.highWaterCursor) < BigInt(candidateFirstSnapshot.highWaterCursor) ? "highwater_decrease" :
            candidateSeed === null ? `seed_missing:${candidateSecondSnapshot.seedStatus ?? "invalid"}:${candidateSecondSnapshot.seedReason ?? "malformed"}` :
            !sameBaseline && candidateBaseline.processEpoch !== secondBaseline.processEpoch ? "audit_epoch" :
            !sameBaseline && candidateBaseline.currentIdentity !== secondBaseline.currentIdentity ? "current_identity" :
            !sameBaseline && candidateBaseline.acceptedObservationOrdinal !== secondBaseline.acceptedObservationOrdinal ? "accepted_ordinal" :
            (!absent && !current) ? "route_shape_mixed" : "rows";
          if (candidateFirstSnapshot.generation === candidateSecondSnapshot.generation &&
              BigInt(candidateSecondSnapshot.highWaterCursor) >= BigInt(candidateFirstSnapshot.highWaterCursor) &&
              sameBaseline && (absent || current) && candidateSeed !== null) {
            firstAudit = candidateFirstAudit; firstSnapshot = candidateSecondSnapshot;
            refreshBaseline = candidateBaseline!; refreshSeed = candidateSeed;
            break;
          }
          lastBaselineReason = reason;
          if (Date.now() >= deadline) throw new Error(`real trio route refresh baseline did not stabilize:${lastBaselineReason}`);
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        /* Stable pair captured above; do not average or mix observations. */
        const secondAudit = firstAudit;
        const secondSnapshot = firstSnapshot;
        const secondBaseline = refreshBaseline;
        const sameBaseline = refreshBaseline !== null && secondBaseline !== null &&
          refreshBaseline.processEpoch === secondBaseline.processEpoch &&
          refreshBaseline.acceptedObservationOrdinal === secondBaseline.acceptedObservationOrdinal &&
          refreshBaseline.currentIdentity === secondBaseline.currentIdentity;
        const absent = isObject(firstAudit) && isObject(secondAudit) &&
          firstAudit.documentContextCurrentRoute === null && secondAudit.documentContextCurrentRoute === null &&
          Array.isArray(firstAudit.documentContextUpdates) && firstAudit.documentContextUpdates.length === 0 &&
          Array.isArray(secondAudit.documentContextUpdates) && secondAudit.documentContextUpdates.length === 0 &&
          refreshBaseline?.acceptedObservationOrdinal === undefined &&
          refreshBaseline?.currentIdentity === undefined;
        const current = isObject(firstAudit) && isObject(secondAudit) &&
          firstAudit.documentContextCurrentRoute !== null && secondAudit.documentContextCurrentRoute !== null &&
          refreshBaseline?.acceptedObservationOrdinal !== undefined &&
          refreshBaseline?.currentIdentity !== undefined;
        if (refreshBaseline === null || firstSnapshot.generation !== secondSnapshot.generation ||
            BigInt(secondSnapshot.highWaterCursor) < BigInt(firstSnapshot.highWaterCursor) ||
            !sameBaseline || (!absent && !current) || refreshSeed === null) {
          throw new Error("real trio route refresh baseline is not stable");
        }
        const control = documentContextControlAudit(await supervisor.fixtureControl("apply_document_context", {
          event: realTrioFixtureDocumentContextEvent(),
        }));
        if (control.revision !== documentContextAudit.revision + 1) {
          throw new Error("real trio route refresh did not advance exactly one fixture revision");
        }
        if (typeof supervisor.pollDocumentContext === "function" &&
            await supervisor.pollDocumentContext() !== "emitted") {
          throw new Error("real worker refreshed document-context poll did not emit a changed context");
        }
        const candidate = await waitForDocumentContextSend({
          supervisor,
          controlCursor: firstSnapshot.highWaterCursor,
          generation: firstSnapshot.generation,
          precedingProbe: null,
          precedingSeed: refreshSeed,
          gatewayBaseline: refreshBaseline,
          control,
          auditCapture: refreshAuditCapture,
          timeoutMs: options.documentContextTimeoutMs,
        });
        await waitForPostRouteDocumentContextHeartbeatAck({
          supervisor, expected: candidate, timeoutMs: options.documentContextTimeoutMs,
        });
        const audit = await readCapturedRealCaseAudit(supervisor, refreshAuditCapture);
        if (hasGatewayAcceptedDocumentContextRoute(audit, verifiedExpected, verifiedGatewayBaseline)) {
          throw new Error("real trio stale revision proof remained accepted after route refresh");
        }
        const next = verifiedRealTrioDocumentContextState(candidate, refreshBaseline);
        verifiedExpected = next.expected;
        verifiedGatewayBaseline = next.gatewayBaseline;
        return Object.freeze({
          ...control,
          ...probeRealTrioFixtureDocumentContext(await supervisor.fixtureControl("snapshot_evidence"), control),
        });
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
