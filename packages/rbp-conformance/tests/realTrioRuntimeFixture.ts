import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  issueNorthCredentialControlPayload,
  type RealTrioNorthCredential,
} from "../src/realTrioCaseDriver.js";
import {
  hasOrderedDocumentContextStages,
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
export function buildRealTrioRuntimeFixture(): void {
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/protocol"]);
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/addin-loopback-fixture"]);
  run(node24, [npmCli, "run", "build", "--workspace", "@revagent/gateway"]);
  run(dotnet, [
    "publish",
    "packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/RevAgent.Bridge.RealWorkerHost.csproj",
    "--configuration", "Release",
    "--runtime", "win-x64",
    "--self-contained", "false",
    "-p:UseAppHost=true",
  ]);
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

export interface RealTrioRuntimeFixtureOptions {
  /** A caller-owned, empty evidence file; no production path is inferred. */
  readonly documentContextFailureEvidenceFile?: string;
  /** Test-only bound for an observed document-context failure. */
  readonly documentContextTimeoutMs?: number;
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

function isSha256(value: unknown): boolean {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
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

async function waitForOrderedDocumentContextStages(input: {
  readonly supervisor: RealTrioSupervisorResult;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState().childExited) {
      throw new Error("real trio child exited before document-context acknowledgement");
    }
    if (hasOrderedDocumentContextStages(
      input.supervisor.readDocumentContextDiagnostics(),
    )) return;
    if (Date.now() >= deadline) {
      throw new Error("real trio document-context stages were not ordered through acknowledgement");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/** The route proof must not wait for, or infer, the later heartbeat ACK. */
function hasDocumentContextSend(
  records: readonly { readonly line: string }[],
): boolean {
  const expected = ["probe", "snapshot", "queue", "send"];
  let next = 0;
  for (const record of records) {
    try {
      const value = JSON.parse(record.line) as unknown;
      if (isObject(value) && value.event === "bridge.document_context_observation" &&
          value.stage === expected[next]) next += 1;
      if (next === expected.length) return true;
    } catch { /* Redacted diagnostics are the only input. */ }
  }
  return false;
}

async function waitForDocumentContextSend(input: {
  readonly supervisor: RealTrioSupervisorResult;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState().childExited) {
      throw new Error("real trio child exited before document-context send");
    }
    if (hasDocumentContextSend(input.supervisor.readDocumentContextDiagnostics())) return;
    if (Date.now() >= deadline) {
      throw new Error("real trio document-context stages were not ordered through send");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * `ack` is emitted only by the C# coordinator after a received
 * heartbeat_ack is durably applied. Requiring a post-route record prevents a
 * public persisted route from borrowing an earlier acknowledgement.
 */
async function waitForPostRouteDocumentContextHeartbeatAck(input: {
  readonly supervisor: RealTrioSupervisorResult;
  readonly diagnosticsBeforeRoute: number;
  readonly timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? DOCUMENT_CONTEXT_WATCHER_TIMEOUT_MS);
  for (;;) {
    if (input.supervisor.readDocumentContextFailureState().childExited) {
      throw new Error("real trio child exited before post-route heartbeat acknowledgement");
    }
    const current = input.supervisor.readDocumentContextDiagnostics();
    if (current.slice(input.diagnosticsBeforeRoute).some((record) => {
      try {
        const value = JSON.parse(record.line) as unknown;
        return isObject(value) && value.event === "bridge.document_context_observation" &&
          value.stage === "ack" && value.outcome === "durably_acknowledged";
      } catch { return false; }
    })) return;
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
    if (hasRealTrioLiveDocumentRoute(snapshot)) return;
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
  options: RealTrioRuntimeFixtureOptions = {},
): Promise<RealTrioRuntimeFixture> {
  const root = mkdtempSync(path.join(tmpdir(), "revagent-wp12-real-trio-"));
  mkdirSync(path.join(root, "install"), { recursive: true });
  mkdirSync(path.join(root, "state"), { recursive: true });
  const tls = createEphemeralLoopbackTlsIdentity(root);
  const controlToken = `wp12-${path.basename(root)}`;
  const gatewayCli = requiredFile("packages/gateway/dist/productionConformanceHostCli.js");
  const fixtureCli = requiredFile("packages/addin-loopback-fixture/dist/cli.js");
  const worker = requiredFile("packages/bridge/tests/RevAgent.Bridge.RealWorkerHost/bin/Release/net9.0/win-x64/publish/RevAgent.Bridge.RealWorkerHost.exe");
  const supervisor = await startRealTrioSupervisor({
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
  const evidenceFile = options.documentContextFailureEvidenceFile ??
    path.join(root, "document-context-failure.json");
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
    // This probe is value-free and must succeed before any public Gateway
    // route can qualify. The regular 15 s C# watcher is the only forwarder.
    failureReason = "stage_timeout";
    await waitForDocumentContextSend({
      supervisor,
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
    failureReason = "route_timeout";
    await waitForLiveDocumentRoute({
      endpoint,
      controlToken,
      certificateSha256,
      supervisor,
      timeoutMs: options.documentContextTimeoutMs,
    });
    timeline.push("gateway_route");
    const diagnosticsBeforeRoute = supervisor.readDocumentContextDiagnostics().length;
    failureReason = "ack_failure";
    await waitForPostRouteDocumentContextHeartbeatAck({
      supervisor,
      diagnosticsBeforeRoute,
      timeoutMs: options.documentContextTimeoutMs,
    });
    timeline.push("heartbeat_ack");
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
    await supervisor.stop().catch(() => undefined);
    throw error;
  }
}
