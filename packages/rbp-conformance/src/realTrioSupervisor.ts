import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import type { TLSSocket } from "node:tls";

import {
  ReadyProcessStartError,
  type JsonObject,
  type JsonValue,
  type ProcessDiagnosticSnapshot,
  type ProcessTranscriptRecord,
} from "./processHarness.js";
import {
  RealTrioProcessHarness,
  type RealTrioJsonlChild,
  type RealTrioProcessCommand,
  type RealTrioReadyChild,
} from "./realTrioProcessHarness.js";
import {
  assertRealBridgeWorkerExecutable,
  validateRealTrioAttestation,
  type RealTrioAttestation,
  type RealTrioProcessIdentity,
} from "./realTrioAttestation.js";
import { stableJson } from "./stableJson.js";
import {
  DocumentContextHistoryReducer,
  documentContextObservationInvalidReason,
  documentContextObservationLooksAdvertised,
  type RealTrioCompactSeedReason,
  type RealTrioCompactSeedStatus,
  type RealTrioPreControlWatcherSeed,
} from "./realTrioDocumentContextEvidence.js";

export const REAL_TRIO_SUPERVISOR_SCHEMA = "rbp-real-trio-supervisor/v1" as const;
export const REAL_TRIO_FAILURE_DIAGNOSTICS_SCHEMA =
  "rbp-real-trio-failure-diagnostics/v1" as const;
const MAX_REAL_TRIO_DIAGNOSTIC_RECORDS = 16;
const MAX_REAL_TRIO_READINESS_TRACE = 64;
const MAX_REAL_TRIO_RECOVERY_CARRIER_OBSERVATIONS = 64;
/**
 * The cursor journal is deliberately smaller than the child transcript.  It
 * retains only admitted, redacted document-context observations, never raw
 * stderr, and its cursor is a decimal BigInt rather than a wrapping array
 * index.
 */
export const MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS = 128;
export const MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROW_BYTES = 2 * 1024;
export const MAX_REAL_TRIO_CONTROL_BYTES = 64 * 1024;
export const MAX_REAL_TRIO_CONTROL_TIMEOUT_MS = 15_000;
/** Test-host-only cadence; the RBP/1 hello_ack remains 15 seconds on wire. */
export const REAL_TRIO_TEST_HEARTBEAT_INTERVAL_MS = 1_000;

export type RealTrioSupervisorCommand = RealTrioProcessCommand;

export interface RealTrioSupervisorLaunch {
  /** Caller-owned directory for redacted process and runtime failure evidence. */
  readonly evidenceDirectory: string;
  readonly gateway: RealTrioSupervisorCommand;
  readonly bridgeWorker: RealTrioSupervisorCommand;
  readonly fixture: RealTrioSupervisorCommand;
  readonly gatewayExpected: Readonly<Record<string, JsonValue>>;
  readonly bridgeExpected: Readonly<Record<string, JsonValue>>;
  readonly fixtureExpected: Readonly<Record<string, JsonValue>>;
  readonly csharpPublishPath: string;
  readonly gatewayBuildPath: string;
  readonly fixtureBuildPath: string;
  /** Out-of-band test secret used only on the Gateway's public loopback control route. */
  readonly gatewayControlToken: string;
}

/**
 * Rejects a legacy/simulator-labelled plan before any child starts. Process
 * harness aliases remain implementation detail; these are the only accepted
 * real-process READY identities for WP-12.
 */
export function assertDedicatedRealTrioProcessComponents(input: RealTrioSupervisorLaunch): void {
  if (input.gatewayExpected.component !== "gateway_production_conformance" ||
      input.bridgeExpected.component !== "bridge_worker" ||
      input.fixtureExpected.component !== "addin_loopback_fixture") {
    throw new Error("real trio launch must declare gateway_production_conformance, bridge_worker, and addin_loopback_fixture");
  }
}

export interface RealTrioSupervisorResult {
  readonly schemaVersion: typeof REAL_TRIO_SUPERVISOR_SCHEMA;
  readonly attestation: RealTrioAttestation;
  readonly gatewayReadiness: JsonObject;
  readonly bridgeReadiness: JsonObject;
  readonly fixtureReadiness: JsonObject;
  readonly sessionReadiness: RealTrioSessionReadiness;
  /** Fixture-only fault/evidence route; it never reaches the C# worker control channel. */
  readonly fixtureControl: (
    action: "plan_fault" | "release_stall" | "apply_document_context" | "snapshot_evidence" | "read_c39_origin_provenance",
    fields?: Readonly<Record<string, JsonValue>>,
  ) => Promise<JsonValue>;
  /** Tenant-scoped, public and redacted audit correlation for real case assertions. */
  readonly readRealCaseAudit: () => Promise<JsonObject>;
  /** Same audit call with a bounded value-free result for failure evidence. */
  readonly readRealCaseAuditOutcome: () => Promise<RealTrioAuditControlOutcome>;
  /** Fixed C39 worker IPC projection; no raw transcript or generic control. */
  readonly readRecoveryCarrierObservations: () => Promise<readonly RealTrioRecoveryCarrierObservation[]>;
  /** Actual Bridge hello_ack grant, retained only as one fixed boolean. */
  readonly readRecoveryCarrierObservationState: () => Promise<RealTrioRecoveryCarrierObservationState>;
  readonly pollDocumentContext: () => Promise<"emitted" | "no_send" | "cancelled" | "fault">;
  /** Fixed C39 reconnect readiness projection; no raw worker control/transcript. */
  readonly readReconnectWatchObservations: () => Promise<readonly RealTrioReconnectWatchObservation[]>;
  /** Value-free C# document-context lifecycle observations only. */
  readonly readDocumentContextDiagnostics: () => readonly ProcessTranscriptRecord[];
  /** Fixed document-context stage sequence for failure artifacts only. */
  readonly readDocumentContextFailureStages: () => readonly ProcessTranscriptRecord[];
  /** Atomic bounded snapshot of redacted, admitted observations. */
  readonly readDocumentContextSnapshot: () => RealTrioDocumentContextSnapshot;
  /** Exact rows strictly later than a prior snapshot high-water cursor. */
  readonly readDocumentContextSince: (
    cursor: string,
    generation: number,
  ) => RealTrioDocumentContextSince;
  /**
   * Bounded child state for a document-context failure artifact. This returns
   * no endpoint, command, control, or document values.
   */
  readonly readDocumentContextFailureState: () => RealTrioDocumentContextFailureState;
  /** Terminates the actual worker process, then relaunches its exact command/journal configuration. */
  readonly restartBridge: () => Promise<RealTrioSessionReadiness>;
  readonly stop: () => Promise<void>;
}

export interface RealTrioRecoveryCarrierObservation {
  readonly phase: "materialized" | "write" | "restart_resend" | "ack";
  readonly hashedRecoveryId: `sha256:${string}`;
  readonly sequence: number;
  readonly outerDigest: `sha256:${string}`;
  readonly ordinal: number;
  readonly routeAuthorityCheckpoint: `sha256:${string}` | null;
  readonly connectionDigest: `sha256:${string}` | null;
  readonly routeRebindProofGranted: boolean;
  readonly causalOrdinal: number;
}

export interface RealTrioRecoveryCarrierObservationState {
  readonly routeRebindProofGranted: boolean;
  readonly observations: readonly RealTrioRecoveryCarrierObservation[];
}

export interface RealTrioReconnectWatchObservation {
  readonly phase: "resume_ack_applied" | "watcher_started";
  readonly generation: number;
  readonly ordinal: number;
  readonly rsidHash: `sha256:${string}`;
  readonly sessionBindingDigest: `sha256:${string}`;
  readonly connectionDigest: `sha256:${string}`;
  readonly routeAuthorityCheckpoint: `sha256:${string}` | null;
  readonly routeRebindProofGranted: boolean;
  readonly causalOrdinal: number;
}

export type RealTrioAuditControlErrorKind =
  "timeout" | "tls_pin" | "http_status_4xx" | "http_status_5xx" |
  "invalid_shape" | "process_exited" | "ipc_error" | "unknown";

export interface RealTrioAuditControlFailure {
  readonly outcome: "failure";
  readonly error: RealTrioAuditControlErrorKind;
  readonly statusCode: number | null;
  readonly okKeyPresent: boolean;
  readonly actionKeyPresent: boolean;
}

export type RealTrioAuditControlOutcome =
  | Readonly<{ readonly outcome: "success"; readonly audit: JsonObject }>
  | RealTrioAuditControlFailure;

export class PublicGatewayControlError extends Error {
  public constructor(
    readonly kind: Exclude<RealTrioAuditControlErrorKind, "process_exited">,
    readonly statusCode: number | null = null,
    readonly okKeyPresent = false,
    readonly actionKeyPresent = false,
  ) {
    super("Gateway public control failed");
    this.name = "PublicGatewayControlError";
  }
}

export function classifyRealTrioAuditControlFailure(
  error: unknown,
  gatewayExited: boolean,
): RealTrioAuditControlFailure {
  if (gatewayExited) {
    return Object.freeze({ outcome: "failure", error: "process_exited", statusCode: null, okKeyPresent: false, actionKeyPresent: false });
  }
  if (error instanceof PublicGatewayControlError) {
    return Object.freeze({ outcome: "failure", error: error.kind, statusCode: error.statusCode,
      okKeyPresent: error.okKeyPresent, actionKeyPresent: error.actionKeyPresent });
  }
  const code = error !== null && typeof error === "object" && "code" in error
    ? (error as { readonly code?: unknown }).code : null;
  return Object.freeze({ outcome: "failure", error: typeof code === "string" ? "ipc_error" : "unknown",
    statusCode: null, okKeyPresent: false, actionKeyPresent: false });
}

export interface RealTrioDocumentContextCursorRow {
  /** Opaque, non-wrapping decimal cursor.  Callers must not derive order. */
  readonly cursor: string;
  readonly line: string;
  readonly at: string;
}

export interface RealTrioDocumentContextSnapshot {
  readonly generation: number;
  readonly lowWaterCursor: string;
  readonly highWaterCursor: string;
  readonly rows: readonly RealTrioDocumentContextCursorRow[];
  /** Present only when the whole generation prefix is independently settled. */
  readonly settledWatcherSeed?: RealTrioPreControlWatcherSeed | null;
  /** Harness-only, fixed value-free compact-seed state. */
  readonly seedStatus?: RealTrioCompactSeedStatus;
  readonly seedReason?: RealTrioCompactSeedReason | null;
}

export type RealTrioDocumentContextSince =
  | Readonly<{
    readonly state: "ok";
    readonly generation: number;
    readonly highWaterCursor: string;
    readonly rows: readonly RealTrioDocumentContextCursorRow[];
  }>
  | Readonly<{
    readonly state: "cursor_expired" | "generation_changed" | "gap";
    readonly generation: number;
    readonly highWaterCursor: string;
  }>;

export interface RealTrioSessionReadiness {
  readonly rsid: string;
  readonly localSessionKey: string;
  readonly grantedCapabilities: readonly string[];
}

export interface RealTrioDocumentContextFailureState {
  readonly childExited: boolean;
  readonly processDiagnostics: readonly ProcessDiagnosticSnapshot[];
}

export type RealTrioBinding = "wss" | "streamable_http_sse";
type PersistedRealTrioBinding = "wss" | "http_sse";

export interface RealTrioCredentialRequest {
  readonly binding: RealTrioBinding;
  readonly connectionCapabilities: readonly string[];
  readonly sessionCapabilities: readonly string[];
}

const REAL_TRIO_SESSION_CAPABILITIES = Object.freeze([
  "batch_atomic",
  "doc_context_cached_v1",
]);

const REAL_TRIO_CONNECTION_CAPABILITIES = Object.freeze([
  "journal_v1",
  "chunked_results",
  "artifact_result_v1",
  "route_rebind_proof_v1",
]);

/**
 * The two carriers use one public credential contract.  The selected HTTP
 * carrier additionally requires its explicit transport capability; neither
 * branch may silently fall back to an empty session-capability provision.
 */
export function realTrioCredentialRequest(binding: RealTrioBinding): RealTrioCredentialRequest {
  return Object.freeze({
    binding,
    connectionCapabilities: Object.freeze([
      ...REAL_TRIO_CONNECTION_CAPABILITIES,
      ...(binding === "streamable_http_sse" ? ["transport_streamable_http"] : []),
    ]),
    sessionCapabilities: REAL_TRIO_SESSION_CAPABILITIES,
  });
}

/**
 * Conformance names the external HTTP carrier `streamable_http_sse`, while
 * the durable Gateway session records its canonical `http_sse` selector.
 * This mapping is intentionally limited to readiness inspection; no command
 * or credential path is rewritten.
 */
export function persistedBindingForReadiness(
  binding: RealTrioBinding,
): PersistedRealTrioBinding {
  return binding === "streamable_http_sse" ? "http_sse" : binding;
}

/** Exact public control payload; no permissive argument bag is accepted. */
export function issueDeviceCredentialControlPayload(
  request: RealTrioCredentialRequest,
): JsonObject {
  return {
    action: "issue_device_credential",
    binding: request.binding,
    connectionCapabilities: [...request.connectionCapabilities],
    sessionCapabilities: [...request.sessionCapabilities],
  };
}

export interface RbpSessionReadinessPollOptions {
  readonly readSnapshot: () => Promise<JsonObject>;
  readonly expectedBinding: PersistedRealTrioBinding;
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
  /** Bounded redacted process evidence retained before parent cleanup. */
  readonly processDiagnostics: readonly ProcessDiagnosticSnapshot[];
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

const DOCUMENT_CONTEXT_STAGES = new Set([
  "probe", "snapshot", "queue", "send", "ack", "failure",
]);
const DOCUMENT_CONTEXT_OUTCOMES = new Set([
  "capability_absent", "started", "not_ready", "ready", "renewal_required",
  "durably_queued", "not_queued", "dispatch_not_allowed", "sent",
  "durably_acknowledged", "stale_context", "snapshot_failed", "queue_failed",
  "send_deferred",
]);
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BARE_CONTEXT_DIGEST = /^[0-9a-f]{64}$/u;

/**
 * These three stages are the only child observations that carry the document
 * context identity used by the strict current-route selector.  A digest on a
 * different stage is not evidence and must not cross the redaction boundary.
 */
function isPayloadBearingDocumentContextStage(
  stage: unknown,
  outcome: unknown,
): stage is "snapshot" | "queue" | "send" {
  return (stage === "snapshot" && outcome === "ready") ||
    (stage === "queue" && outcome === "durably_queued") ||
    (stage === "send" && outcome === "sent");
}

/**
 * A fixture cache revision is meaningful only together with the incarnation
 * that produced it.  Do not retain either half from child stderr on its own:
 * a restart can otherwise make a numerically newer revision look current.
 */
function documentContextSourcePair(value: Record<string, unknown>):
  | Readonly<{ readonly sourceRevision: number; readonly cacheIncarnationDigest: `sha256:${string}` }>
  | null {
  if (!Number.isSafeInteger(value.sourceRevision) || Number(value.sourceRevision) < 1 ||
      typeof value.cacheIncarnationDigest !== "string" || !SHA256.test(value.cacheIncarnationDigest)) {
    return null;
  }
  return Object.freeze({
    sourceRevision: Number(value.sourceRevision),
    cacheIncarnationDigest: value.cacheIncarnationDigest as `sha256:${string}`,
  });
}

function isSafeDocumentContextSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

/**
 * Drops arbitrary worker stderr. Both admitted schemas are reduced to fixed
 * enum fields and hash-presence booleans before entering diagnostic evidence.
 */
export function redactBridgeTranscript(
  transcript: readonly ProcessTranscriptRecord[],
): readonly ProcessTranscriptRecord[] {
  const retained: ProcessTranscriptRecord[] = [];
  for (const record of transcript.slice(-MAX_REAL_TRIO_DIAGNOSTIC_RECORDS)) {
    if (record.stream !== "stderr") continue;
    try {
      const parsed = JSON.parse(record.line) as unknown;
      if (!isObject(parsed)) continue;
      if (parsed.contractVersion === "revagent.wp12-real-worker-observation/v1" &&
          parsed.event === "bridge.connection_failure_observation" &&
          ["wss", "streamable_http_sse"].includes(parsed.binding as string) &&
          parsed.state === "retry_paused" && parsed.reason === "authorization_refusal") {
        retained.push(Object.freeze({
          stream: "stderr",
          at: "",
          line: stableJson({
            contractVersion: parsed.contractVersion,
            event: parsed.event,
            stage: "failure",
            outcome: "authorization_refusal",
            binding: parsed.binding,
            failureKind: "authorization_refusal",
            rsidHashPresent: false,
            payloadHashPresent: false,
          }),
        }));
        continue;
      }
      if (parsed.contractVersion === "revagent.rbp-document-context-observation/v1" &&
          parsed.event === "bridge.document_context_observation" &&
          typeof parsed.stage === "string" && DOCUMENT_CONTEXT_STAGES.has(parsed.stage) &&
          typeof parsed.outcome === "string" && DOCUMENT_CONTEXT_OUTCOMES.has(parsed.outcome) &&
          typeof parsed.rsidHash === "string" && SHA256.test(parsed.rsidHash) &&
          (parsed.payloadHash === null || typeof parsed.payloadHash === "string") &&
          (parsed.sequence === null || isSafeDocumentContextSequence(parsed.sequence))) {
        const source = documentContextSourcePair(parsed);
        const payloadBearing = isPayloadBearingDocumentContextStage(parsed.stage, parsed.outcome);
        const contextDigest = typeof parsed.contextDigest === "string" &&
          BARE_CONTEXT_DIGEST.test(parsed.contextDigest) ? parsed.contextDigest : null;
        // The real C# projection admits neither a partial pair nor malformed
        // source identity.  It is a diagnostic boundary, never a repair path.
        if ((parsed.sourceRevision === null || parsed.sourceRevision === undefined) !==
            (parsed.cacheIncarnationDigest === null || parsed.cacheIncarnationDigest === undefined) ||
            ((parsed.sourceRevision !== null && parsed.sourceRevision !== undefined) && source === null) ||
            // Snapshot is the only payload-bearing row without a queue/send
            // sequence. A missing, malformed, or uppercase digest cannot be
            // downgraded into a value-free diagnostic row.
            (payloadBearing && (source === null || contextDigest === null ||
              (parsed.stage === "snapshot" ? parsed.sequence !== null : !isSafeDocumentContextSequence(parsed.sequence))))) continue;
        retained.push(Object.freeze({
          stream: "stderr",
          at: record.at,
          line: stableJson({
            contractVersion: parsed.contractVersion,
            event: parsed.event,
            stage: parsed.stage,
            outcome: parsed.outcome,
            binding: "unknown",
            failureKind: parsed.stage === "failure" ? parsed.outcome : "none",
            rsidHash: parsed.rsidHash,
            sequence: isSafeDocumentContextSequence(parsed.sequence) ? parsed.sequence : null,
            payloadHashPresent: typeof parsed.payloadHash === "string" && SHA256.test(parsed.payloadHash),
            // Never project payloads, document ids, or raw session ids. The
            // bare digest and paired C# cache provenance are sufficient for
            // causal correlation and have independently validated grammar.
            ...(payloadBearing ? {
              contextDigest: contextDigest!,
              sourceRevision: source!.sourceRevision,
              cacheIncarnationDigest: source!.cacheIncarnationDigest,
            } : {}),
          }),
        }));
      }
    } catch {
      // Raw stderr is not evidence: it may contain an endpoint, path, or secret.
    }
  }
  return Object.freeze(retained);
}

/**
 * Monotonic cursor carrier for a single real C# child generation.  Source
 * identity, not a payload hash, is the de-duplication key: repeated
 * heartbeats that happen to have identical redacted payloads are distinct,
 * while re-reading the same child stderr line is inert.
 */
export class RealTrioDocumentContextCursorJournal {
  private generation = 1;
  private highWater = 0n;
  private rows: RealTrioDocumentContextCursorRow[] = [];
  private seenObjectLines = new WeakSet<object>();
  private seenOffsets = new Set<string>();
  private reducer = new DocumentContextHistoryReducer();
  /** Retained solely to make post-eviction continuity explicit; never published while a cycle is open. */
  private earnedSeed: RealTrioPreControlWatcherSeed | null = null;
  private restarted = false;

  private invalidateHistory(reason: RealTrioCompactSeedReason): void {
    this.reducer.invalidate(reason);
  }

  public ingest(transcript: readonly ProcessTranscriptRecord[]): void {
    for (const record of transcript) {
      if (record.stream !== "stderr") continue;
      const source = this.sourceIdentity(record);
      if (source === null) continue;
      // Mark before parsing: one malformed/oversize physical source line can
      // never become a valid observation on a later re-read.
      if (source.kind === "offset") {
        if (this.seenOffsets.has(source.value)) continue;
        this.seenOffsets.add(source.value);
      } else {
        if (this.seenObjectLines.has(source.value)) continue;
        this.seenObjectLines.add(source.value);
      }
      if (Buffer.byteLength(record.line, "utf8") > MAX_REAL_TRIO_CONTROL_BYTES) {
        if (documentContextObservationLooksAdvertised(record.line)) this.invalidateHistory("malformed");
        continue;
      }
      const redacted = redactBridgeTranscript([record]);
      const retained = redacted[0];
      if (retained === undefined ||
          Buffer.byteLength(retained.line, "utf8") > MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROW_BYTES) {
        if (documentContextObservationLooksAdvertised(record.line)) this.invalidateHistory(documentContextObservationInvalidReason(record.line));
        continue;
      }
      try {
        const parsed = JSON.parse(retained.line) as unknown;
        if (!isObject(parsed) ||
            parsed.event !== "bridge.document_context_observation") continue;
        const payloadBearing = isPayloadBearingDocumentContextStage(parsed.stage, parsed.outcome);
        if (payloadBearing &&
            (typeof parsed.contextDigest !== "string" || !BARE_CONTEXT_DIGEST.test(parsed.contextDigest) ||
             documentContextSourcePair(parsed) === null ||
             (parsed.stage === "snapshot" ? parsed.sequence !== null : !isSafeDocumentContextSequence(parsed.sequence)))) continue;
      } catch {
        if (documentContextObservationLooksAdvertised(record.line)) this.invalidateHistory(documentContextObservationInvalidReason(record.line));
        continue;
      }
      this.highWater += 1n;
      const row = Object.freeze({
        cursor: this.highWater.toString(10),
        line: retained.line,
        at: retained.at,
      });
      if (!this.reducer.accept(row)) this.invalidateHistory("malformed");
      this.restarted = false;
      this.rows.push(row);
      const settled = this.reducer.settledSeed(this.generation);
      if (settled !== null) this.earnedSeed = settled;
      if (this.rows.length > MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS) {
        if (this.earnedSeed === null) this.invalidateHistory("overflow");
        this.rows.splice(0, this.rows.length - MAX_REAL_TRIO_DOCUMENT_CONTEXT_ROWS);
      }
    }
  }

  /** A child process restart invalidates all cursors from the prior epoch. */
  public restartGeneration(): void {
    if (this.generation === Number.MAX_SAFE_INTEGER) {
      throw new Error("real trio document-context generation exhausted");
    }
    this.generation += 1;
    this.highWater = 0n;
    this.rows = [];
    this.seenObjectLines = new WeakSet<object>();
    this.seenOffsets = new Set<string>();
    this.reducer = new DocumentContextHistoryReducer();
    this.earnedSeed = null;
    this.restarted = true;
  }

  public snapshot(transcript: readonly ProcessTranscriptRecord[]): RealTrioDocumentContextSnapshot {
    this.ingest(transcript);
    const lowWater = this.rows.length === 0
      ? this.highWater + 1n
      : BigInt(this.rows[0]!.cursor);
    const diagnostics = this.reducer.seedDiagnostics(this.generation, this.restarted);
    return Object.freeze({
      generation: this.generation,
      lowWaterCursor: lowWater.toString(10),
      highWaterCursor: this.highWater.toString(10),
      rows: Object.freeze([...this.rows]),
      settledWatcherSeed: diagnostics.seedStatus === "valid" ? this.reducer.settledSeed(this.generation) : null,
      ...diagnostics,
    });
  }

  public since(
    cursor: string,
    generation: number,
    transcript: readonly ProcessTranscriptRecord[],
  ): RealTrioDocumentContextSince {
    this.ingest(transcript);
    const highWaterCursor = this.highWater.toString(10);
    if (!Number.isSafeInteger(generation) || generation !== this.generation) {
      return Object.freeze({ state: "generation_changed", generation: this.generation, highWaterCursor });
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(cursor)) {
      return Object.freeze({ state: "gap", generation: this.generation, highWaterCursor });
    }
    const requested = BigInt(cursor);
    const lowWater = this.rows.length === 0
      ? this.highWater + 1n
      : BigInt(this.rows[0]!.cursor);
    if (requested < lowWater - 1n) {
      return Object.freeze({ state: "cursor_expired", generation: this.generation, highWaterCursor });
    }
    if (requested > this.highWater) {
      return Object.freeze({ state: "gap", generation: this.generation, highWaterCursor });
    }
    const rows = this.rows.filter((row) => BigInt(row.cursor) > requested);
    // The ring must represent every valid observation after the requested
    // cursor. Anything else is a failure, never a clamp or historic search.
    if (rows.length > 0 && BigInt(rows[0]!.cursor) !== requested + 1n) {
      return Object.freeze({ state: "gap", generation: this.generation, highWaterCursor });
    }
    return Object.freeze({
      state: "ok",
      generation: this.generation,
      highWaterCursor,
      rows: Object.freeze(rows),
    });
  }

  private sourceIdentity(record: ProcessTranscriptRecord):
    | Readonly<{ readonly kind: "offset"; readonly value: string }>
    | Readonly<{ readonly kind: "object"; readonly value: object }>
    | null {
    const offset = (record as ProcessTranscriptRecord & { readonly sourceOffset?: unknown }).sourceOffset;
    if (typeof offset === "string" && /^(?:0|[1-9][0-9]*)$/u.test(offset)) {
      return Object.freeze({ kind: "offset", value: `${record.stream}:${offset}` });
    }
    if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) {
      return Object.freeze({ kind: "offset", value: `${record.stream}:${offset}` });
    }
    return typeof record === "object" && record !== null
      ? Object.freeze({ kind: "object", value: record })
      : null;
  }
}

/** Retains the fixed document-stage progression while excluding all values. */
export function redactDocumentContextFailureStages(
  transcript: readonly ProcessTranscriptRecord[],
): readonly ProcessTranscriptRecord[] {
  const retained: ProcessTranscriptRecord[] = [];
  for (const record of transcript) {
    if (retained.length === MAX_REAL_TRIO_READINESS_TRACE || record.stream !== "stderr") continue;
    try {
      const parsed = JSON.parse(record.line) as unknown;
      if (!isObject(parsed) ||
          parsed.contractVersion !== "revagent.rbp-document-context-observation/v1" ||
          parsed.event !== "bridge.document_context_observation" ||
          typeof parsed.stage !== "string" || !DOCUMENT_CONTEXT_STAGES.has(parsed.stage) ||
          typeof parsed.outcome !== "string" || !DOCUMENT_CONTEXT_OUTCOMES.has(parsed.outcome)) continue;
      retained.push(Object.freeze({
        stream: "stderr",
        at: "",
        line: stableJson({
          contractVersion: parsed.contractVersion,
          event: parsed.event,
          stage: parsed.stage,
          outcome: parsed.outcome,
          sequence: isSafeDocumentContextSequence(parsed.sequence) ? parsed.sequence : null,
          rsidHash: typeof parsed.rsidHash === "string" && SHA256.test(parsed.rsidHash) ? parsed.rsidHash : null,
          payloadHashPresent: typeof parsed.payloadHash === "string" && SHA256.test(parsed.payloadHash),
        }),
      }));
    } catch {
      // Raw child output is not failure-artifact evidence.
    }
  }
  return Object.freeze(retained);
}

export function hasOrderedDocumentContextStages(
  records: readonly ProcessTranscriptRecord[],
): boolean {
  const expected = ["probe", "snapshot", "queue", "send", "ack"];
  let next = 0;
  for (const record of records) {
    try {
      const value = JSON.parse(record.line) as unknown;
      if (isObject(value) && value.event === "bridge.document_context_observation" &&
          value.stage === expected[next]) next += 1;
      if (next === expected.length) return true;
    } catch { /* Redaction is the admission boundary. */ }
  }
  return false;
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
      processDiagnostics: Object.freeze([]),
    });
  }
}

function hashPrefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function traceReadinessSnapshot(
  snapshot: JsonObject,
  expectedBinding: PersistedRealTrioBinding,
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
  if (!grants.includes("batch_atomic") || !grants.includes("route_rebind_proof_v1")) {
    return invalid("MISSING_BATCH");
  }
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
    if (current instanceof ReadyProcessStartError) {
      return Object.freeze({
        schemaVersion: REAL_TRIO_FAILURE_DIAGNOSTICS_SCHEMA,
        gatewayAudits: Object.freeze([]),
        bridgeTranscript: Object.freeze([]),
        readinessTrace: Object.freeze([]),
        processDiagnostics: Object.freeze([current.diagnostic]),
      });
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

function sha256File(path: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
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

/**
 * The supervisor, rather than a caller, owns the short real-worker test
 * cadence. The worker still validates the same bound at its process boundary.
 */
export function testHeartbeatWorkerCommand(
  worker: RealTrioSupervisorCommand,
  heartbeatIntervalMs = REAL_TRIO_TEST_HEARTBEAT_INTERVAL_MS,
): RealTrioSupervisorCommand {
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 250 || heartbeatIntervalMs > 5_000) {
    throw new Error("real worker test heartbeat interval must be between 250 and 5000 milliseconds");
  }
  const indexes = worker.args
    .map((entry, index) => entry === "--test-heartbeat-interval-ms" ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length !== 1 || worker.args[indexes[0]! + 1] !== "{{test_heartbeat_interval_ms}}") {
    throw new Error("real worker command does not bind exact test heartbeat interval input");
  }
  return replaceTokens(worker, { test_heartbeat_interval_ms: String(heartbeatIntervalMs) });
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recoveryCarrierObservationState(value: JsonValue): RealTrioRecoveryCarrierObservationState {
  if (!isObject(value) || Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, "observations") || !Object.hasOwn(value, "reconnectWatchObservations") ||
      !Object.hasOwn(value, "routeRebindProofGranted") || typeof value.routeRebindProofGranted !== "boolean" ||
      !Array.isArray(value.observations) || !Array.isArray(value.reconnectWatchObservations) ||
      value.observations.length > MAX_REAL_TRIO_RECOVERY_CARRIER_OBSERVATIONS) {
    throw new Error("real worker recovery observation IPC is malformed");
  }
  const rows: RealTrioRecoveryCarrierObservation[] = [];
  for (const row of value.observations) {
    if (!isObject(row) ||
        (row.phase !== "materialized" && row.phase !== "write" &&
          row.phase !== "restart_resend" && row.phase !== "ack") ||
        typeof row.hashedRecoveryId !== "string" || !SHA256.test(row.hashedRecoveryId) ||
        typeof row.outerDigest !== "string" || !SHA256.test(row.outerDigest) ||
        typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
        typeof row.ordinal !== "number" || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1 ||
        typeof row.routeRebindProofGranted !== "boolean" ||
        !(row.routeAuthorityCheckpoint === null || (typeof row.routeAuthorityCheckpoint === "string" && SHA256.test(row.routeAuthorityCheckpoint))) ||
        !(row.connectionDigest === null || (typeof row.connectionDigest === "string" && SHA256.test(row.connectionDigest))) ||
        typeof row.causalOrdinal !== "number" || !Number.isSafeInteger(row.causalOrdinal) || row.causalOrdinal < 1 ||
        Object.keys(row).length !== 9) {
      throw new Error("real worker recovery observation IPC is invalid");
    }
    rows.push(Object.freeze({
      phase: row.phase,
      hashedRecoveryId: row.hashedRecoveryId as `sha256:${string}`,
      sequence: row.sequence,
      outerDigest: row.outerDigest as `sha256:${string}`,
      ordinal: row.ordinal,
      routeAuthorityCheckpoint: row.routeAuthorityCheckpoint as `sha256:${string}` | null,
      connectionDigest: row.connectionDigest as `sha256:${string}` | null,
      routeRebindProofGranted: row.routeRebindProofGranted,
      causalOrdinal: row.causalOrdinal,
    }));
  }
  return Object.freeze({ routeRebindProofGranted: value.routeRebindProofGranted, observations: Object.freeze(rows) });
}

function recoveryCarrierObservations(value: JsonValue): readonly RealTrioRecoveryCarrierObservation[] {
  return recoveryCarrierObservationState(value).observations;
}

function reconnectWatchObservations(value: JsonValue): readonly RealTrioReconnectWatchObservation[] {
  if (!isObject(value) || Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, "observations") || !Object.hasOwn(value, "reconnectWatchObservations") ||
      !Object.hasOwn(value, "routeRebindProofGranted") || typeof value.routeRebindProofGranted !== "boolean" ||
      !Array.isArray(value.observations) || !Array.isArray(value.reconnectWatchObservations) ||
      value.reconnectWatchObservations.length > MAX_REAL_TRIO_RECOVERY_CARRIER_OBSERVATIONS) {
    throw new Error("real worker reconnect observation IPC is malformed");
  }
  const rows: RealTrioReconnectWatchObservation[] = [];
  for (const row of value.reconnectWatchObservations) {
    if (!isObject(row) || (row.phase !== "resume_ack_applied" && row.phase !== "watcher_started") ||
        typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 1 ||
        typeof row.ordinal !== "number" || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1 ||
        typeof row.rsidHash !== "string" || !SHA256.test(row.rsidHash) ||
        typeof row.sessionBindingDigest !== "string" || !SHA256.test(row.sessionBindingDigest) ||
        typeof row.connectionDigest !== "string" || !SHA256.test(row.connectionDigest) ||
        !(row.routeAuthorityCheckpoint === null || (typeof row.routeAuthorityCheckpoint === "string" && SHA256.test(row.routeAuthorityCheckpoint))) ||
        typeof row.routeRebindProofGranted !== "boolean" ||
        typeof row.causalOrdinal !== "number" || !Number.isSafeInteger(row.causalOrdinal) || row.causalOrdinal < 1 ||
        Object.keys(row).length !== 9) throw new Error("real worker reconnect observation IPC is invalid");
    rows.push(Object.freeze({
      phase: row.phase, generation: row.generation, ordinal: row.ordinal,
      rsidHash: row.rsidHash as `sha256:${string}`,
      sessionBindingDigest: row.sessionBindingDigest as `sha256:${string}`,
      connectionDigest: row.connectionDigest as `sha256:${string}`,
      routeAuthorityCheckpoint: row.routeAuthorityCheckpoint as `sha256:${string}` | null,
      routeRebindProofGranted: row.routeRebindProofGranted,
      causalOrdinal: row.causalOrdinal,
    }));
  }
  return Object.freeze(rows);
}

/**
 * Reads only normalized v2 session rows from the conformance audit.  Older
 * top-level capability shapes are deliberately not tolerated: the durable
 * schema places grants in value.binding.grantedCapabilities.
 */
export function readRbpSessionV2Readiness(
  snapshot: JsonObject,
  expectedBinding: PersistedRealTrioBinding,
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
      !value.binding.grantedCapabilities.includes("batch_atomic") ||
      !value.binding.grantedCapabilities.includes("route_rebind_proof_v1")) {
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

export async function publicGatewayControl(
  endpoint: string,
  controlToken: string,
  expectedCertificateSha256: string,
  payloadObject: JsonObject,
  timeoutMs = MAX_REAL_TRIO_CONTROL_TIMEOUT_MS,
): Promise<JsonObject> {
  const url = new URL("/__conformance/v1/control", endpoint);
  const action = payloadObject.action;
  if (action !== "issue_device_credential" && action !== "issue_north_credential" &&
      action !== "issue_north_foreign_credential" && action !== "snapshot_audit" &&
      action !== "read_real_case_audit") {
    throw new PublicGatewayControlError("invalid_shape");
  }
  const payload = Buffer.from(JSON.stringify(payloadObject), "utf8");
  if (payload.byteLength > MAX_REAL_TRIO_CONTROL_BYTES) {
    throw new PublicGatewayControlError("invalid_shape");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REAL_TRIO_CONTROL_TIMEOUT_MS) {
    throw new PublicGatewayControlError("invalid_shape");
  }
  return await new Promise<JsonObject>((resolve, reject) => {
    let settled = false;
    let pinVerified = false;
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0, rejectUnauthorized: false });
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      agent.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      operation.destroy(new PublicGatewayControlError("timeout"));
      fail(new PublicGatewayControlError("timeout"));
    }, timeoutMs);
    const operation = httpsRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", agent, rejectUnauthorized: false, headers: { "content-type": "application/json", "content-length": payload.byteLength, "x-rbp-test-control": controlToken } }, (response) => {
      const peer = (response.socket as TLSSocket).getPeerCertificate(true).raw as Buffer | undefined;
      const observed = peer === undefined ? null : `sha256:${createHash("sha256").update(peer).digest("hex")}`;
      if (!pinVerified || observed !== expectedCertificateSha256) { response.resume(); operation.destroy(); clearTimeout(timer); fail(new PublicGatewayControlError("tls_pin")); return; }
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      response.on("data", (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_REAL_TRIO_CONTROL_BYTES) {
          response.destroy();
          clearTimeout(timer);
          fail(new PublicGatewayControlError("invalid_shape"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          const body = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as JsonObject : null;
          const statusCode = Number.isSafeInteger(response.statusCode) ? Number(response.statusCode) : null;
          const okKeyPresent = body !== null && Object.hasOwn(body, "ok");
          const actionKeyPresent = body !== null && Object.hasOwn(body, "action");
          if (statusCode !== 200) {
            const kind = statusCode !== null && statusCode >= 400 && statusCode < 500 ? "http_status_4xx" :
              statusCode !== null && statusCode >= 500 && statusCode < 600 ? "http_status_5xx" : "invalid_shape";
            throw new PublicGatewayControlError(kind, statusCode, okKeyPresent, actionKeyPresent);
          }
          if (body === null || body.ok !== true || body.action !== action) {
            throw new PublicGatewayControlError("invalid_shape", statusCode, okKeyPresent, actionKeyPresent);
          }
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            agent.destroy();
            resolve(body);
          }
        } catch (error) { clearTimeout(timer); fail(error instanceof PublicGatewayControlError ? error : new PublicGatewayControlError("invalid_shape")); }
      });
    });
    operation.once("socket", (socket: TLSSocket) => {
      socket.once("secureConnect", () => {
        const raw = socket.getPeerCertificate(true).raw as Buffer | undefined;
        const observed = raw === undefined ? null : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
        if (observed !== expectedCertificateSha256) {
          operation.destroy(new PublicGatewayControlError("tls_pin"));
          fail(new PublicGatewayControlError("tls_pin"));
          return;
        }
        pinVerified = true;
      });
    });
    operation.once("error", (error) => { clearTimeout(timer); fail(error); });
    operation.end(payload);
  });
}

function exactStringList(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length && expected.every((entry) => value.includes(entry));
}

export function assertProductionCredential(
  credential: JsonObject,
  request: RealTrioCredentialRequest,
  endpoint: string,
): asserts credential is JsonObject & {
  readonly deviceId: string;
  readonly deviceProof: string;
} {
  const adapters = isObject(credential.adapterProvenance)
    ? credential.adapterProvenance
    : null;
  if (typeof credential.deviceId !== "string" || credential.deviceId.length === 0 ||
      typeof credential.deviceProof !== "string" || credential.deviceProof.length === 0 ||
      credential.binding !== request.binding ||
      credential.gatewayEndpoint !== endpoint ||
      credential.credentialProvenance !== "gateway_production_conformance" ||
      adapters?.identity !== "conformance" ||
      adapters.protocolStore !== "conformance" ||
      adapters.authority !== "GatewayBridgeSessionAuthority" ||
      !exactStringList(credential.connectionCapabilities, request.connectionCapabilities) ||
      !exactStringList(credential.sessionCapabilities, request.sessionCapabilities)) {
    throw new Error("Gateway public control did not issue a production-conformance credential with exact grants");
  }
}

function transcriptHash(process: RealTrioJsonlChild | RealTrioReadyChild, stream: "stdout" | "stderr"): `sha256:${string}` {
  const records = process.transcript.filter((record) => record.stream === stream);
  return `sha256:${createHash("sha256").update(stableJson(records)).digest("hex")}`;
}

function processIdentity(
  componentId: RealTrioProcessIdentity["componentId"],
  executablePath: string,
  process: RealTrioJsonlChild | RealTrioReadyChild,
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
  assertDedicatedRealTrioProcessComponents(input);
  const harness = new RealTrioProcessHarness({ evidenceDirectory: input.evidenceDirectory });
  const bridgeExecutable = assertRealBridgeWorkerExecutable(input.bridgeWorker.executable);
  const gateway = await harness.startReady({
    componentId: "gateway_production_conformance",
    command: input.gateway,
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
      const fixture = await harness.startJsonl({
        componentId: "addin_loopback_fixture",
        command: input.fixture,
        expectedReadinessFields: input.fixtureExpected,
        // The real runtime must prove its post-registration cache update via
        // the fixture's advertised, strict control surface; accepting an
        // unadvertised action would turn this into a hidden bypass.
        requiredActions: ["apply_document_context", "snapshot_evidence", "read_c39_origin_provenance", "shutdown"],
      });
      try {
        const fixtureTokens = fixtureAttestationTokens(fixture.readiness, fixture.pid);
        const binding = input.bridgeWorker.args[input.bridgeWorker.args.indexOf("--binding") + 1];
        if (binding !== "wss" && binding !== "streamable_http_sse") {
          throw new Error("real worker command lacks one supported binding");
        }
        const credentialRequest = realTrioCredentialRequest(binding);
        const credentialControl = issueDeviceCredentialControlPayload(credentialRequest);
        const credential = await publicGatewayControl(
          endpoint,
          input.gatewayControlToken,
          certificateSha256,
          credentialControl,
        );
        assertProductionCredential(credential, credentialRequest, endpoint);
        const fixtureBoundWorker = testHeartbeatWorkerCommand(
          fixtureAttestedWorkerCommand(input.bridgeWorker, fixtureTokens),
        );
        let bridge = await harness.startJsonl({
          componentId: "bridge_worker",
          command: replaceTokens({ ...fixtureBoundWorker, executable: bridgeExecutable }, {
            gateway_endpoint: bridgeEndpointForBinding(endpoint, input.bridgeWorker.args),
            gateway_certificate_sha256: certificateSha256.replace("sha256:", ""),
            device_id: credential.deviceId,
            device_proof: credential.deviceProof,
          }),
          expectedReadinessFields: input.bridgeExpected,
          requiredActions: ["read_recovery_observations", "poll_document_context", "shutdown"],
        });
        const documentContextJournal = new RealTrioDocumentContextCursorJournal();
        let sessionReadiness: RealTrioSessionReadiness;
        try {
          sessionReadiness = await pollRbpSessionV2Readiness({
            expectedBinding: persistedBindingForReadiness(binding),
            isBridgeExited: () => bridge.process.exitCode !== null,
            readSnapshot: async () => await publicGatewayControl(
              endpoint,
              input.gatewayControlToken,
              certificateSha256,
              { action: "snapshot_audit" },
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
        const restartBridge = async (): Promise<RealTrioSessionReadiness> => {
          const stoppedBridge = await bridge.terminateForConformance();
          if (stoppedBridge.killEscalated || stoppedBridge.exitCode === 0) {
            throw new Error("real trio crash boundary did not observe an actual worker termination");
          }
          documentContextJournal.restartGeneration();
          bridge = await harness.startJsonl({
            componentId: "bridge_worker",
            command: replaceTokens({ ...fixtureBoundWorker, executable: bridgeExecutable }, {
              gateway_endpoint: bridgeEndpointForBinding(endpoint, input.bridgeWorker.args),
              gateway_certificate_sha256: certificateSha256.replace("sha256:", ""),
              device_id: credential.deviceId,
              device_proof: credential.deviceProof,
            }),
            expectedReadinessFields: input.bridgeExpected,
            requiredActions: ["read_recovery_observations", "poll_document_context", "shutdown"],
          });
          sessionReadiness = await pollRbpSessionV2Readiness({
            expectedBinding: persistedBindingForReadiness(binding),
            isBridgeExited: () => bridge.process.exitCode !== null,
            readSnapshot: async () => await publicGatewayControl(
              endpoint,
              input.gatewayControlToken,
              certificateSha256,
              { action: "snapshot_audit" },
            ),
          });
          return sessionReadiness;
        };
        const fixtureControl = async (
          action: "plan_fault" | "release_stall" | "apply_document_context" | "snapshot_evidence" | "read_c39_origin_provenance",
          fields: Readonly<Record<string, JsonValue>> = {},
        ): Promise<JsonValue> => await fixture.request(action, fields);
        const readRealCaseAuditOutcome = async (): Promise<RealTrioAuditControlOutcome> => {
          try {
            const audit = await publicGatewayControl(
              endpoint,
              input.gatewayControlToken,
              certificateSha256,
              { action: "read_real_case_audit", tenantId: "conformance" },
            );
            return Object.freeze({ outcome: "success", audit });
          } catch (error) {
            return classifyRealTrioAuditControlFailure(error, gateway.process.exitCode !== null);
          }
        };
        const readRealCaseAudit = async (): Promise<JsonObject> => {
          const outcome = await readRealCaseAuditOutcome();
          if (outcome.outcome === "success") return outcome.audit;
          throw new Error("real trio public audit control unavailable");
        };
        const readRecoveryCarrierObservations = async (): Promise<readonly RealTrioRecoveryCarrierObservation[]> =>
          recoveryCarrierObservations(await bridge.request("read_recovery_observations"));
        const readRecoveryCarrierObservationState = async (): Promise<RealTrioRecoveryCarrierObservationState> =>
          recoveryCarrierObservationState(await bridge.request("read_recovery_observations"));
        const pollDocumentContext = async (): Promise<"emitted" | "no_send" | "cancelled" | "fault"> => {
          const result = await bridge.request("poll_document_context");
          if (!isObject(result) || typeof result.state !== "string" ||
              !["emitted", "no_send", "cancelled", "fault"].includes(result.state) ||
              Object.keys(result).length !== 1) {
            throw new Error("real worker document-context poll control is invalid");
          }
          return result.state as "emitted" | "no_send" | "cancelled" | "fault";
        };
        const readReconnectWatchObservations = async (): Promise<readonly RealTrioReconnectWatchObservation[]> =>
          reconnectWatchObservations(await bridge.request("read_recovery_observations"));
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
        fixtureControl,
        readRealCaseAudit,
        readRealCaseAuditOutcome,
        readRecoveryCarrierObservations,
        readRecoveryCarrierObservationState,
        pollDocumentContext,
        readReconnectWatchObservations,
        readDocumentContextSnapshot: () => documentContextJournal.snapshot(bridge.transcript),
        readDocumentContextSince: (cursor: string, generation: number) =>
          documentContextJournal.since(cursor, generation, bridge.transcript),
        readDocumentContextDiagnostics: () => documentContextJournal.snapshot(bridge.transcript).rows
          .map((row) => Object.freeze({ stream: "stderr" as const, at: row.at, line: row.line })),
        readDocumentContextFailureStages: () => documentContextJournal.snapshot(bridge.transcript).rows
          .map((row) => Object.freeze({ stream: "stderr" as const, at: row.at, line: row.line })),
        readDocumentContextFailureState: () => Object.freeze({
          childExited: gateway.process.exitCode !== null ||
            fixture.process.exitCode !== null || bridge.process.exitCode !== null,
          processDiagnostics: Object.freeze([
            gateway.diagnostics("document_context_failure"),
            fixture.diagnostics("document_context_failure"),
            bridge.diagnostics("document_context_failure"),
          ]),
        }),
        restartBridge,
        stop,
        });
      } catch (error) { await fixture.stop(); throw error; }
    } catch (error) { throw error; }
  } catch (error) { await gateway.stop(); throw error; }
}
