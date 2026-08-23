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
  type RealTrioDocumentContextFailureState,
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
  readonly sendTranscriptIndex: number;
  readonly sendRecordedAt: string | null;
}

interface RealTrioGatewayAuditBaseline {
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

/** Selects one post-control ordered lifecycle; historical worker output is inert. */
export function correlatedDocumentContextSendSince(
  records: readonly { readonly line: string; readonly at?: string }[],
  floor: number,
): RealTrioDocumentContextCorrelation | null {
  if (!Number.isSafeInteger(floor) || floor < 0) return null;
  const expected = Object.freeze([
    Object.freeze({ stage: "probe", outcome: "started" }),
    Object.freeze({ stage: "snapshot", outcome: "ready" }),
    Object.freeze({ stage: "queue", outcome: "durably_queued" }),
    Object.freeze({ stage: "send", outcome: "sent" }),
  ]);
  let next = 0;
  let canonicalHash: `sha256:${string}` | null = null;
  let canonicalSequence: number | null = null;
  for (let index = floor; index < records.length; index += 1) {
    const record = records[index]!;
    try {
      const value = JSON.parse(record.line) as unknown;
      if (!isObject(value) || value.event !== "bridge.document_context_observation") continue;
      if (value.stage === "failure") return null;
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
          sendTranscriptIndex: index, sendRecordedAt: typeof record.at === "string" ? record.at : null });
      }
    } catch { return null; }
  }
  return null;
}

async function waitForDocumentContextSend(input: {
  readonly supervisor: RealTrioSupervisorResult;
  readonly transcriptFloor: number;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState().childExited) {
      throw new Error("real trio child exited before document-context send");
    }
    if (correlatedDocumentContextSendSince(
      input.supervisor.readDocumentContextDiagnostics(), input.transcriptFloor,
    ) !== null) return;
    if (Date.now() >= deadline) {
      throw new Error("real trio document-context stages were not ordered through send");
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

export function hasGatewayAcceptedDocumentContextRoute(
  audit: unknown,
  expected: RealTrioDocumentContextCorrelation,
  baseline: RealTrioGatewayAuditBaseline,
): boolean {
  if (!isObject(audit) || !Array.isArray(audit.documentContextUpdates) ||
      !Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal) ||
      Number(audit.documentContextObservationHighWaterOrdinal) < baseline.observationOrdinal ||
      !isCanonicalUtc(expected.sendRecordedAt)) return false;
  const candidates = audit.documentContextUpdates.filter((value) => isObject(value) &&
    value.contractVersion === "revagent.wp12-document-context-audit/v1" &&
    value.event === "gateway.doc_context_update_observation" && value.stage === "accepted" &&
    value.rsidHash === expected.rsidHash && value.observedSequence === expected.sequence &&
    isSha256(value.rsidHash) && Number.isSafeInteger(value.observedSequence) && Number(value.observedSequence) >= 1 &&
    Number.isSafeInteger(value.observationOrdinal) && Number(value.observationOrdinal) > baseline.observationOrdinal &&
    Number(value.observationOrdinal) <= Number(audit.documentContextObservationHighWaterOrdinal) &&
    isCanonicalUtc(value.observedAtUtc) && Date.parse(value.observedAtUtc) >= Date.parse(expected.sendRecordedAt));
  return candidates.length === 1;
}

export function gatewayAuditBaseline(audit: unknown): RealTrioGatewayAuditBaseline | null {
  if (!isObject(audit) || !Number.isSafeInteger(audit.documentContextObservationHighWaterOrdinal) ||
      Number(audit.documentContextObservationHighWaterOrdinal) < 0) return null;
  return Object.freeze({ observationOrdinal: Number(audit.documentContextObservationHighWaterOrdinal) });
}

async function waitForPostRouteDocumentContextHeartbeatAck(input: {
  readonly supervisor: RealTrioSupervisorResult;
  readonly transcriptFloor: number;
  readonly expected: RealTrioDocumentContextCorrelation;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState().childExited) {
      throw new Error("real trio child exited before post-route heartbeat acknowledgement");
    }
    if (hasDurableDocumentContextHeartbeatAckSince(
      input.supervisor.readDocumentContextDiagnostics(), input.transcriptFloor, input.expected,
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
}): Promise<RealTrioDocumentContextFailureError> {
  const [fixtureEvidence, gatewayAudit] = await Promise.all([
    input.supervisor.fixtureControl("snapshot_evidence").catch(() => null),
    publicGatewayControl(
      input.endpoint,
      input.controlToken,
      input.certificateSha256,
      { action: "snapshot_audit" },
    ).catch(() => null),
  ]);
  const childState = input.supervisor.readDocumentContextFailureState();
  const failure = createRealTrioDocumentContextFailure({
    reason: childState.childExited ? "child_exit" : input.reason,
    binding: input.binding,
    timeline: input.timeline,
    transcript: input.supervisor.readDocumentContextFailureStages(),
    fixtureEvidence,
    gatewayAudit,
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
  let failureReason: RealTrioDocumentContextFailure["reason"] = "ack_failure";
  let documentContextAudit: RealTrioDocumentContextAudit;
  try {
    // This is the normal attested loopback fixture document-context event;
    // route authority is still earned only when the C# watcher forwards it
    // and the Gateway's public audit observes the live route.
    const controlAudit = documentContextControlAudit(await supervisor.fixtureControl("apply_document_context", {
      event: realTrioFixtureDocumentContextEvent(),
    }));
    timeline.push("control_ack");
    const gatewayBaseline = gatewayAuditBaseline(await supervisor.readRealCaseAudit());
    if (gatewayBaseline === null) throw new Error("real trio Gateway audit baseline is unavailable");
    // Capture immediately after control completion: historical valid sends
    // cannot establish this controlled case's route correlation.
    const transcriptFloor = supervisor.readDocumentContextDiagnostics().length;
    // This probe is value-free and must succeed before any public Gateway
    // route can qualify. The regular 15 s C# watcher is the only forwarder.
    failureReason = "stage_timeout";
    await waitForDocumentContextSend({
      supervisor,
      transcriptFloor,
      timeoutMs: options.documentContextTimeoutMs,
    });
    timeline.push("document_sent");
    const expected = correlatedDocumentContextSendSince(
      supervisor.readDocumentContextDiagnostics(), transcriptFloor,
    );
    if (expected === null) throw new Error("real trio document-context send lacks strict route correlation");
    failureReason = "ack_failure";
    const counts = probeRealTrioFixtureDocumentContext(
      await supervisor.fixtureControl("snapshot_evidence"),
      controlAudit,
    );
    documentContextAudit = Object.freeze({ ...controlAudit, ...counts });
    timeline.push("fixture_probe");
    failureReason = "route_timeout";
    await waitForLiveDocumentRoute({
      endpoint,
      controlToken,
      certificateSha256,
      supervisor,
      expected,
      gatewayBaseline,
      timeoutMs: options.documentContextTimeoutMs,
    });
    timeline.push("gateway_route");
    failureReason = "ack_failure";
    await waitForPostRouteDocumentContextHeartbeatAck({
      supervisor,
      transcriptFloor,
      expected,
      timeoutMs: options.documentContextTimeoutMs,
    });
    timeline.push("heartbeat_ack");
    const finalAudit = await supervisor.readRealCaseAudit();
    if (!hasDurableDocumentContextHeartbeatAckSince(
      supervisor.readDocumentContextDiagnostics(), transcriptFloor, expected,
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
