import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  StrictJsonError,
  parseStrictJsonBytes,
  type JsonObject,
  type JsonValue as FixtureJsonValue,
} from "@revagent/addin-loopback-fixture";
import type {
  InvokeBatchEnvelope,
  InvokeEnvelope,
  MutationHold,
  SessionUnregister,
} from "@revagent/protocol";

import { ArtifactSpool, DeterministicUuid7Source } from "./artifacts.js";
import {
  BridgeSimulator,
  InjectedBridgeCrash,
  type BridgeCrashPoint,
  type RegisteredBridgeSession,
} from "./bridgeSimulator.js";
import { DurableBridgeJournal, type JournalDurabilityProfile } from "./journal.js";
import {
  discoverAddinSessions,
  type DiscoveryEvidence,
  type ProbedAddinSession,
} from "./loopback.js";
import { BridgeGatewayPeer } from "./peer.js";
import {
  HttpSseGatewayBinding,
  WssGatewayBinding,
  openPrimaryThenFallback,
  type GatewayBinding,
} from "./transport.js";

export const BRIDGE_CONTROL_VERSION = 1;
export const MAX_BRIDGE_CONTROL_LINE_BYTES = 64 * 1024;
export const BRIDGE_CONTROL_ACTIONS = [
  "discover_fixture",
  "attach_fixture_session",
  "open_transport",
  "start_run_loop",
  "session_register",
  "session_resume",
  "session_unregister",
  "tick",
  "poll_document_context",
  "flush_outbound",
  "invoke_local",
  "record_verification_attempt",
  "record_late_evidence",
  "resolve_hold",
  "clearance_for_hold",
  "inject_crash",
  "restart_simulator",
  "snapshot_evidence",
  "shutdown",
] as const;

const MAX_ACTIVE_EVIDENCE_SNAPSHOTS = 4;
const ROWS_PER_PAGE = 8;
const EVENTS_PER_PAGE = 16;

interface EvidenceCursor {
  invocationOffset: number;
  holdOffset: number;
  durabilityOffset: number;
  sessionOffset: number;
  sequenceOffset: number;
}

interface BridgeEvidenceSnapshot {
  readonly evidenceVersion: 1;
  readonly componentContract: "bridge-simulator-control/v1";
  readonly durabilityProfile: JournalDurabilityProfile;
  readonly invocations: readonly JsonObject[];
  readonly holds: readonly JsonObject[];
  readonly durabilityEvents: readonly JsonObject[];
  readonly sessions: readonly JsonObject[];
  readonly sequences: readonly JsonObject[];
  readonly discovery: JsonObject | null;
  readonly peer: JsonObject | null;
  readonly crash: JsonObject;
  readonly transport: JsonObject;
  readonly openLoopbackClientCount: number;
  readonly journalClosed: boolean;
}

interface ControlSuccess extends JsonObject {
  controlVersion: 1;
  id: string;
  ok: true;
  result: FixtureJsonValue;
}

interface ControlFailure extends JsonObject {
  controlVersion: 1;
  id: string | null;
  ok: false;
  error: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`Unknown control field: ${unknown}`);
  const missing = required.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`Missing control field: ${missing}`);
}

function boundedString(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be a non-empty bounded single-line string`);
  }
  return value;
}

function boundedId(value: unknown, label: string): string {
  return boundedString(value, label, 128);
}

function uuidV7(value: unknown, label: string): string {
  const id = boundedString(value, label, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
    throw new Error(`${label} must be a lowercase UUIDv7`);
  }
  return id;
}

function sha256Digest(value: unknown, label: string): string {
  const digest = boundedString(value, label, 71);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new Error(`${label} must be a sha256 digest`);
  return digest;
}

function verificationHoldId(value: unknown, label: string): string {
  const holdId = boundedString(value, label, 67);
  if (!/^vh:[0-9a-f]{64}$/u.test(holdId)) throw new Error(`${label} must be a verification hold id`);
  return holdId;
}

function holdEvidenceConclusion(value: unknown):
  | "non_execution_proven"
  | "postcondition_verified"
  | "inconclusive"
  | "failed"
  | "omitted"
  | "ambiguous" {
  if (
    value !== "non_execution_proven" &&
    value !== "postcondition_verified" &&
    value !== "inconclusive" &&
    value !== "failed" &&
    value !== "omitted" &&
    value !== "ambiguous"
  ) {
    throw new Error("conclusion must be a supported hold evidence conclusion");
  }
  return value;
}

function holdResolutionDecision(value: unknown): "non_execution_proven" | "postcondition_verified" {
  if (value !== "non_execution_proven" && value !== "postcondition_verified") {
    throw new Error("decision must be non_execution_proven or postcondition_verified");
  }
  return value;
}

function holdResolutionBasis(value: unknown): "verification_read" | "late_terminal" {
  if (value !== "verification_read" && value !== "late_terminal") {
    throw new Error("basis must be verification_read or late_terminal");
  }
  return value;
}

function holdControlSummary(hold: MutationHold): JsonObject {
  return {
    rsid: hold.rsid,
    holdId: hold.holdId,
    mutationScope: hold.mutationScope as unknown as FixtureJsonValue,
    scopeKey: hold.scopeKey,
    state: hold.state,
    originIdempotencyKeys: [...hold.originIdempotencyKeys],
    evidenceAttemptCount: hold.evidenceAttempts.length,
    selectedEvidence: hold.selectedEvidence === null
      ? null
      : {
          basis: hold.selectedEvidence.basis,
          verificationInvocationId: hold.selectedEvidence.verificationInvocationId,
          originIdempotencyKey: hold.selectedEvidence.originIdempotencyKey,
          evidenceDigest: hold.selectedEvidence.evidenceDigest,
          conclusion: hold.selectedEvidence.conclusion,
        },
    resolution: hold.resolution === null
      ? null
      : {
          resolutionId: hold.resolution.resolutionId,
          basis: hold.resolution.basis,
          verificationInvocationId: hold.resolution.verificationInvocationId,
          evidenceDigest: hold.resolution.evidenceDigest,
          decision: hold.resolution.decision,
          auditId: hold.resolution.auditId,
          authorizedDispatchIdentity: hold.resolution.authorizedDispatchIdentity,
        },
    clearedBy: hold.clearedBy,
  };
}

function safeInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function loopbackEndpointPolicy(value: unknown): "loopback_test_readiness" {
  if (value !== "loopback_test_readiness") {
    throw new Error("endpointPolicy must equal loopback_test_readiness when supplied");
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return [...value];
}

function crashPoint(value: unknown): BridgeCrashPoint {
  if (
    value !== "after_received_before_dispatch" &&
    value !== "after_executing_before_addin_write" &&
    value !== "after_addin_response_before_terminal"
  ) {
    throw new Error("point must be a supported Bridge crash point");
  }
  return value;
}

function unregisterReason(value: unknown): SessionUnregister["reason"] {
  if (
    value !== "revit_exited" &&
    value !== "bridge_shutdown" &&
    value !== "session_replaced" &&
    value !== "operator_requested"
  ) {
    throw new Error("reason must be a supported session_unregister reason");
  }
  return value;
}

function classifyWssFailure(error: unknown): "retryable_network" | "auth" | "version" | "trust" | "protocol" {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden/u.test(message)) return "auth";
  if (/version|4426/u.test(message)) return "version";
  if (/certificate|tls|trust|self.signed/u.test(message)) return "trust";
  if (/protocol|validation|invalid envelope|4400/u.test(message)) return "protocol";
  return "retryable_network";
}

function failure(id: string | null, code: string, message: string): ControlFailure {
  return {
    controlVersion: 1,
    id,
    ok: false,
    error: { code, message: message.replace(/[\r\n]+/gu, " ").slice(0, 600) },
  };
}

function zeroCursor(): EvidenceCursor {
  return {
    invocationOffset: 0,
    holdOffset: 0,
    durabilityOffset: 0,
    sessionOffset: 0,
    sequenceOffset: 0,
  };
}

function parseCursor(value: unknown): EvidenceCursor {
  if (!isObject(value)) throw new Error("cursor must be an object");
  const keys = [
    "invocationOffset",
    "holdOffset",
    "durabilityOffset",
    "sessionOffset",
    "sequenceOffset",
  ] as const;
  exactKeys(value, keys);
  return {
    invocationOffset: safeInteger(value.invocationOffset, "cursor.invocationOffset"),
    holdOffset: safeInteger(value.holdOffset, "cursor.holdOffset"),
    durabilityOffset: safeInteger(value.durabilityOffset, "cursor.durabilityOffset"),
    sessionOffset: safeInteger(value.sessionOffset, "cursor.sessionOffset"),
    sequenceOffset: safeInteger(value.sequenceOffset, "cursor.sequenceOffset"),
  };
}

function evidencePage(snapshotId: string, snapshot: BridgeEvidenceSnapshot, cursor: EvidenceCursor): JsonObject {
  for (const [offset, length, label] of [
    [cursor.invocationOffset, snapshot.invocations.length, "invocationOffset"],
    [cursor.holdOffset, snapshot.holds.length, "holdOffset"],
    [cursor.durabilityOffset, snapshot.durabilityEvents.length, "durabilityOffset"],
    [cursor.sessionOffset, snapshot.sessions.length, "sessionOffset"],
    [cursor.sequenceOffset, snapshot.sequences.length, "sequenceOffset"],
  ] as const) {
    if (offset > length) throw new Error(`cursor.${label} exceeds snapshot length`);
  }
  const invocations = snapshot.invocations.slice(cursor.invocationOffset, cursor.invocationOffset + ROWS_PER_PAGE);
  const holds = snapshot.holds.slice(cursor.holdOffset, cursor.holdOffset + ROWS_PER_PAGE);
  const durabilityEvents = snapshot.durabilityEvents.slice(
    cursor.durabilityOffset,
    cursor.durabilityOffset + EVENTS_PER_PAGE,
  );
  const sessions = snapshot.sessions.slice(cursor.sessionOffset, cursor.sessionOffset + ROWS_PER_PAGE);
  const sequences = snapshot.sequences.slice(cursor.sequenceOffset, cursor.sequenceOffset + ROWS_PER_PAGE);
  const nextCursor: EvidenceCursor = {
    invocationOffset: cursor.invocationOffset + invocations.length,
    holdOffset: cursor.holdOffset + holds.length,
    durabilityOffset: cursor.durabilityOffset + durabilityEvents.length,
    sessionOffset: cursor.sessionOffset + sessions.length,
    sequenceOffset: cursor.sequenceOffset + sequences.length,
  };
  const complete =
    nextCursor.invocationOffset === snapshot.invocations.length &&
    nextCursor.holdOffset === snapshot.holds.length &&
    nextCursor.durabilityOffset === snapshot.durabilityEvents.length &&
    nextCursor.sessionOffset === snapshot.sessions.length &&
    nextCursor.sequenceOffset === snapshot.sequences.length;
  return {
    snapshotId,
    evidenceVersion: snapshot.evidenceVersion,
    componentContract: snapshot.componentContract,
    durabilityProfile: snapshot.durabilityProfile as unknown as FixtureJsonValue,
    invocations: invocations as unknown as FixtureJsonValue,
    holds: holds as unknown as FixtureJsonValue,
    durabilityEvents: durabilityEvents as unknown as FixtureJsonValue,
    sessions: sessions as unknown as FixtureJsonValue,
    sequences: sequences as unknown as FixtureJsonValue,
    discovery: snapshot.discovery,
    peer: snapshot.peer,
    crash: snapshot.crash,
    transport: snapshot.transport,
    openLoopbackClientCount: snapshot.openLoopbackClientCount,
    journalClosed: snapshot.journalClosed,
    complete,
    nextCursor: complete ? null : nextCursor as unknown as FixtureJsonValue,
  };
}

interface SavedSession {
  readonly session: RegisteredBridgeSession;
  readonly host: string;
  readonly port: number;
}

export class BridgeDaemonRuntime {
  readonly #journalPath: string;
  readonly #spoolPath: string;
  readonly #ids = new DeterministicUuid7Source();
  #journal: DurableBridgeJournal;
  #simulator: BridgeSimulator;
  #probes: ProbedAddinSession[] = [];
  #discoveryEvidence: DiscoveryEvidence | null = null;
  #binding: GatewayBinding | null = null;
  #peer: BridgeGatewayPeer | null = null;
  #runLoop: Promise<void> | null = null;
  #runLoopAbort: AbortController | null = null;
  #runLoopError: string | null = null;
  #clockMs = Date.now();
  #nextCrashPoint: BridgeCrashPoint | null = null;
  #crashedAt: BridgeCrashPoint | null = null;
  #journalClosed = false;

  public constructor(stateRoot: string) {
    this.#journalPath = join(stateRoot, "bridge.db");
    this.#spoolPath = join(stateRoot, "spool");
    this.#journal = new DurableBridgeJournal(this.#journalPath);
    this.#simulator = this.#newSimulator();
  }

  public durabilityProfile(): JournalDurabilityProfile {
    return this.#journal.durabilityProfile;
  }

  public async execute(record: JsonObject, id: string): Promise<{ value: FixtureJsonValue; shutdown: boolean }> {
    switch (record.action) {
      case "discover_fixture":
        return { value: await this.#discover(record), shutdown: false };
      case "attach_fixture_session":
        return { value: await this.#attach(record, id), shutdown: false };
      case "open_transport":
        return { value: await this.#openTransport(record), shutdown: false };
      case "start_run_loop":
        return { value: this.#startRunLoop(record), shutdown: false };
      case "session_register":
        return { value: await this.#register(record, id), shutdown: false };
      case "session_resume":
        return { value: await this.#resume(record), shutdown: false };
      case "session_unregister":
        return { value: await this.#unregister(record), shutdown: false };
      case "tick":
        return { value: await this.#tick(record), shutdown: false };
      case "poll_document_context":
        return { value: await this.#pollContext(record), shutdown: false };
      case "flush_outbound":
        return { value: await this.#flush(record), shutdown: false };
      case "invoke_local":
        return { value: await this.#invoke(record), shutdown: false };
      case "record_verification_attempt":
        return { value: this.#recordVerificationAttempt(record), shutdown: false };
      case "record_late_evidence":
        return { value: this.#recordLateEvidence(record), shutdown: false };
      case "resolve_hold":
        return { value: this.#resolveHold(record), shutdown: false };
      case "clearance_for_hold":
        return { value: this.#clearanceForHold(record), shutdown: false };
      case "inject_crash":
        return { value: this.#injectCrash(record), shutdown: false };
      case "restart_simulator":
        return { value: await this.#restart(record), shutdown: false };
      case "snapshot_evidence":
        throw new Error("snapshot_evidence is handled by the JSONL controller");
      case "shutdown": {
        exactKeys(record, ["controlVersion", "id", "action"]);
        return { value: await this.shutdown(), shutdown: true };
      }
      default:
        throw new Error(`Unsupported control action: ${String(record.action)}`);
    }
  }

  public snapshotEvidence(): BridgeEvidenceSnapshot {
    this.#assertJournalOpen();
    const records = this.#journal.listInvocations();
    const holds = this.#journal.listHolds();
    const rsids = [...new Set([
      ...records.map((record) => record.binding.rsid),
      ...holds.map((hold) => hold.rsid),
      ...this.#simulator.registeredSessions().map((session) => session.rsid),
    ])].sort();
    const peerSnapshot = this.#peer?.snapshot(this.#clockMs) ?? null;
    return {
      evidenceVersion: 1,
      componentContract: "bridge-simulator-control/v1",
      durabilityProfile: this.durabilityProfile(),
      invocations: records.map((record) => ({
        rsid: record.binding.rsid,
        invocationId: record.binding.invocationId,
        method: record.binding.method,
        state: record.state,
        mutating: record.binding.mutating,
        bindingDigest: record.bindingDigest,
        paramsDigest: record.binding.paramsDigest,
        dispatchMayHaveStarted: record.dispatchMayHaveStarted,
        abandoned: record.abandoned,
        verificationHoldId: record.verificationHoldId,
        terminalOutcomeDigest: record.terminalOutcomeDigest,
        lateTerminalOutcomeDigest: record.lateTerminalOutcomeDigest,
      })),
      holds: holds.map((hold) => ({
        rsid: hold.rsid,
        holdId: hold.holdId,
        scopeKey: hold.scopeKey,
        state: hold.state,
        originIdempotencyKeys: [...hold.originIdempotencyKeys],
        evidenceDigests: hold.evidenceAttempts.map((attempt) => attempt.evidenceDigest),
        clearedBy: hold.clearedBy,
      })),
      durabilityEvents: this.#journal.durabilityEvents().map((event) => ({ ...event })),
      sessions: this.#simulator.registeredSessions().map((session) => ({
        rsid: session.rsid,
        localSessionKey: session.probe.localSessionKey,
        target: { host: session.probe.target.host, port: session.probe.target.port },
        grantedSessionCapabilities: [...session.grantedSessionCapabilities],
        resumeExpiresAt: session.resumeExpiresAt,
      })),
      sequences: rsids.map((rsid) => {
        const state = this.#journal.loadSequence(rsid);
        return {
          rsid,
          nextTxSeq: state.nextTxSeq,
          highestTxSeq: state.highestTxSeq,
          lastRxSeq: state.lastRxSeq,
          lastPeerAck: state.lastPeerAck,
          outbox: state.outbox.map((entry) => ({
            seq: entry.envelope.seq,
            type: entry.envelope.type,
            id: entry.envelope.id,
            immutableDigest: entry.immutableDigest,
          })),
          acceptedInbound: state.acceptedInbound.map((entry) => ({ ...entry })),
        };
      }),
      discovery: this.#discoveryEvidence === null ? null : this.#sanitizeDiscovery(this.#discoveryEvidence),
      peer: peerSnapshot === null
        ? null
        : {
            ...peerSnapshot,
            runLoopError: this.#runLoopError,
          } as unknown as JsonObject,
      crash: { crashed: this.#crashedAt !== null, point: this.#crashedAt },
      transport: {
        kind: this.#binding?.kind ?? null,
        open: this.#binding?.connectionId !== null && this.#binding !== null,
        connectionId: this.#binding?.connectionId ?? null,
        runLoopActive: peerSnapshot?.runLoopActive ?? false,
      },
      openLoopbackClientCount: this.#probes.filter((probe) => !probe.client.closed).length,
      journalClosed: this.#journalClosed,
    };
  }

  public async shutdown(): Promise<JsonObject> {
    if (this.#peer !== null) await this.#peer.shutdown();
    await this.#stopTransport();
    this.#simulator.close();
    this.#closeProbes();
    if (!this.#journalClosed) {
      this.#journal.close();
      this.#journalClosed = true;
    }
    return {
      stopped: true,
      openLoopbackClientCount: 0,
      transportOpen: false,
      runLoopActive: false,
      journalClosed: true,
      pendingControlCount: 0,
      activeEvidenceSnapshotCount: 0,
    };
  }

  async #discover(record: JsonObject): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(
      record,
      ["controlVersion", "id", "action"],
      ["host", "port", "firstPort", "lastPort", "probeTimeoutMs"],
    );
    if (this.#simulator.registeredSessions().length > 0) {
      throw new Error("discover_fixture requires no attached sessions");
    }
    const host = record.host === undefined ? undefined : boundedString(record.host, "host", 64);
    const port = record.port === undefined ? undefined : safeInteger(record.port, "port", 1, 65_535);
    if (port !== undefined && host === undefined) throw new Error("port requires host");
    if (port !== undefined && (record.firstPort !== undefined || record.lastPort !== undefined)) {
      throw new Error("explicit port cannot be combined with a scan range");
    }
    this.#closeProbes();
    const discovery = await discoverAddinSessions({
      ...(port === undefined ? {} : { explicitTarget: { host: host as string, port } }),
      ...(port !== undefined || host === undefined ? {} : { host }),
      ...(record.firstPort === undefined
        ? {}
        : { firstPort: safeInteger(record.firstPort, "firstPort", 1, 65_535) }),
      ...(record.lastPort === undefined
        ? {}
        : { lastPort: safeInteger(record.lastPort, "lastPort", 1, 65_535) }),
      ...(record.probeTimeoutMs === undefined
        ? {}
        : { probeTimeoutMs: safeInteger(record.probeTimeoutMs, "probeTimeoutMs", 1, 30_000) }),
    });
    this.#probes = [...discovery.sessions];
    this.#discoveryEvidence = discovery.evidence;
    return {
      sessions: this.#probes.map((probe, probeIndex) => ({
        probeIndex,
        target: { ...probe.target },
        localSessionKey: probe.localSessionKey,
        addinVersion: probe.addinVersion,
        resultContractVersion: probe.resultContractVersion,
        revit: { ...probe.revit },
        sessionCapabilities: [...probe.sessionCapabilities],
        batchableCommands: [...probe.batchableCommands],
      })) as unknown as FixtureJsonValue,
      evidence: this.#sanitizeDiscovery(discovery.evidence),
    };
  }

  async #attach(record: JsonObject, id: string): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, [
      "controlVersion",
      "id",
      "action",
      "probeIndex",
      "rsid",
      "resumeToken",
      "resumeExpiresAt",
      "userHint",
      "hostname",
      "fingerprint",
      "bridgeVersion",
    ], ["grantedSessionCapabilities"]);
    const probe = this.#probe(record.probeIndex);
    const rsid = boundedId(record.rsid, "rsid");
    const registration = await this.#registration(record, probe, `${id}-registration`);
    const granted = record.grantedSessionCapabilities === undefined
      ? [...probe.sessionCapabilities]
      : stringArray(record.grantedSessionCapabilities, "grantedSessionCapabilities");
    const session = this.#simulator.attachSession({
      rsid,
      resumeToken: boundedString(record.resumeToken, "resumeToken", 2_048),
      resumeExpiresAt: boundedString(record.resumeExpiresAt, "resumeExpiresAt", 64),
      grantedSessionCapabilities: granted,
      probe,
      registration,
    });
    return {
      attached: true,
      rsid: session.rsid,
      localSessionKey: session.probe.localSessionKey,
      grantedSessionCapabilities: [...session.grantedSessionCapabilities],
      registration: registration as unknown as FixtureJsonValue,
    };
  }

  async #openTransport(record: JsonObject): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action", "kind", "deviceToken", "hello"], [
      "wssUrl",
      "fallbackUrl",
      "fallbackProvisioned",
      "endpointPolicy",
    ]);
    if (this.#binding !== null || this.#peer !== null) throw new Error("transport is already open");
    const kind = record.kind;
    if (kind !== "wss" && kind !== "streamable_http_sse" && kind !== "primary_then_fallback") {
      throw new Error("kind must be wss, streamable_http_sse, or primary_then_fallback");
    }
    const deviceToken = boundedString(record.deviceToken, "deviceToken", 8_192);
    const endpointPolicy = record.endpointPolicy === undefined
      ? undefined
      : loopbackEndpointPolicy(record.endpointPolicy);
    const helloInput = record.hello;
    if (!isObject(helloInput)) throw new Error("hello must be an object");
    exactKeys(helloInput, ["id", "ts", "bridgeVersion", "deviceId", "hostname", "os"], ["fingerprint"]);
    const hello = this.#simulator.buildHello({
      id: boundedId(helloInput.id, "hello.id"),
      ts: boundedString(helloInput.ts, "hello.ts", 64),
      bridgeVersion: boundedString(helloInput.bridgeVersion, "hello.bridgeVersion", 64),
      deviceId: boundedId(helloInput.deviceId, "hello.deviceId"),
      hostname: boundedString(helloInput.hostname, "hello.hostname", 255),
      os: boundedString(helloInput.os, "hello.os", 255),
      ...(helloInput.fingerprint === undefined
        ? {}
        : { fingerprint: sha256Digest(helloInput.fingerprint, "hello.fingerprint") }),
    });
    let wssUrl: string | null = null;
    let fallbackUrl: string | null = null;
    let fallbackProvisioned = false;
    if (kind === "wss") {
      if (record.fallbackUrl !== undefined || record.fallbackProvisioned !== undefined) {
        throw new Error("wss transport does not accept fallback fields");
      }
      wssUrl = boundedString(record.wssUrl, "wssUrl", 2_048);
    } else if (kind === "streamable_http_sse") {
      if (record.wssUrl !== undefined || record.fallbackProvisioned !== undefined) {
        throw new Error("streamable_http_sse does not accept WSS selection fields");
      }
      fallbackUrl = boundedString(record.fallbackUrl, "fallbackUrl", 2_048);
    } else {
      wssUrl = boundedString(record.wssUrl, "wssUrl", 2_048);
      fallbackUrl = boundedString(record.fallbackUrl, "fallbackUrl", 2_048);
      fallbackProvisioned = booleanValue(record.fallbackProvisioned, "fallbackProvisioned");
    }

    let transportOpenAttempt = 0;
    const openConfiguredTransport = async (): Promise<{
      readonly binding: GatewayBinding;
      readonly helloAck: Awaited<ReturnType<GatewayBinding["open"]>>;
    }> => {
      const attemptHello = transportOpenAttempt === 0
        ? hello
        : { ...hello, id: this.#ids.next(), ts: new Date(this.#clockMs).toISOString() };
      transportOpenAttempt += 1;
      const created: GatewayBinding[] = [];
      try {
        if (kind === "wss") {
          if (wssUrl === null) throw new Error("validated WSS URL is missing");
          const binding = new WssGatewayBinding({
            baseUrl: wssUrl,
            deviceToken,
            ...(endpointPolicy === undefined ? {} : { endpointPolicy }),
          });
          created.push(binding);
          return { binding, helloAck: await binding.open(attemptHello) };
        }
        if (kind === "streamable_http_sse") {
          if (fallbackUrl === null) throw new Error("validated fallback URL is missing");
          const binding = new HttpSseGatewayBinding({
            baseUrl: fallbackUrl,
            deviceToken,
            ...(endpointPolicy === undefined ? {} : { endpointPolicy }),
          });
          created.push(binding);
          return { binding, helloAck: await binding.open(attemptHello) };
        }
        if (wssUrl === null || fallbackUrl === null) throw new Error("validated transport URLs are missing");
        const wss = new WssGatewayBinding({
          baseUrl: wssUrl,
          deviceToken,
          ...(endpointPolicy === undefined ? {} : { endpointPolicy }),
        });
        const fallback = new HttpSseGatewayBinding({
          baseUrl: fallbackUrl,
          deviceToken,
          ...(endpointPolicy === undefined ? {} : { endpointPolicy }),
        });
        created.push(wss, fallback);
        return await openPrimaryThenFallback({
          hello: attemptHello,
          wss,
          fallback,
          fallbackProvisioned,
          classifyWssFailure,
        });
      } catch (error) {
        await Promise.allSettled(created.map(async (binding) => await binding.close()));
        throw error;
      }
    };

    const selected = await openConfiguredTransport();
    this.#binding = selected.binding;
    this.#peer = new BridgeGatewayPeer(this.#simulator, selected.binding, selected.helloAck, {
      nowMs: () => this.#clockMs,
      reconnect: async () => {
        const reconnected = await openConfiguredTransport();
        this.#binding = reconnected.binding;
        return reconnected;
      },
    });
    return {
      requestedKind: kind,
      selectedKind: selected.binding.kind,
      connectionId: selected.helloAck.payload.connection_id,
      helloAck: selected.helloAck as unknown as FixtureJsonValue,
    };
  }

  #startRunLoop(record: JsonObject): FixtureJsonValue {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action"]);
    const peer = this.#requirePeer();
    if (this.#runLoop !== null) throw new Error("Gateway run loop is already started");
    const abort = new AbortController();
    this.#runLoopAbort = abort;
    this.#runLoopError = null;
    this.#runLoop = peer.run(abort.signal).catch((error: unknown) => {
      this.#runLoopError = error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600);
    });
    return { started: true, runLoopActive: peer.snapshot(this.#clockMs).runLoopActive };
  }

  async #register(record: JsonObject, id: string): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, [
      "controlVersion",
      "id",
      "action",
      "probeIndex",
      "userHint",
      "hostname",
      "fingerprint",
      "bridgeVersion",
    ]);
    const probe = this.#probe(record.probeIndex);
    const registration = await this.#registration(record, probe, `${id}-registration`);
    const requestId = await this.#requirePeer().registerSession({ probe, registration });
    return { sent: true, requestId, localSessionKey: probe.localSessionKey };
  }

  async #resume(record: JsonObject): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action", "rsid"]);
    const rsid = boundedId(record.rsid, "rsid");
    await this.#requirePeer().resumeSession(rsid);
    return { sent: true, rsid };
  }

  async #unregister(record: JsonObject): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action", "rsid", "reason"]);
    const rsid = boundedId(record.rsid, "rsid");
    const reason = unregisterReason(record.reason);
    const decisions = await this.#requirePeer().unregisterSession(rsid, reason);
    return { sent: true, rsid, reason, journalDecisions: decisions as unknown as FixtureJsonValue };
  }

  async #tick(record: JsonObject): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action", "nowMs"]);
    this.#clockMs = safeInteger(record.nowMs, "nowMs");
    const peer = this.#requirePeer();
    const liveness = await peer.tick(this.#clockMs);
    return { nowMs: this.#clockMs, liveness, peer: peer.snapshot(this.#clockMs) as unknown as FixtureJsonValue };
  }

  async #pollContext(record: JsonObject): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action", "rsid"], ["force"]);
    const rsid = boundedId(record.rsid, "rsid");
    const pushed = await this.#requirePeer().pollDocumentContext(
      rsid,
      record.force === undefined ? false : booleanValue(record.force, "force"),
    );
    return { rsid, pushed };
  }

  async #flush(record: JsonObject): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action"], ["rsid"]);
    const rsid = record.rsid === undefined ? undefined : boundedId(record.rsid, "rsid");
    const peer = this.#requirePeer();
    await peer.flushOutbound(rsid);
    return { flushed: true, rsid: rsid ?? null, peer: peer.snapshot(this.#clockMs) as unknown as FixtureJsonValue };
  }

  async #invoke(record: JsonObject): Promise<FixtureJsonValue> {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action", "envelope"], ["crashAt"]);
    if (!isObject(record.envelope)) throw new Error("envelope must be an object");
    const inlineCrash = record.crashAt === undefined ? null : crashPoint(record.crashAt);
    if (inlineCrash !== null && this.#nextCrashPoint !== null) {
      throw new Error("crashAt cannot be combined with a queued inject_crash point");
    }
    const selectedCrash = inlineCrash ?? this.#nextCrashPoint;
    this.#nextCrashPoint = null;
    try {
      let outcome;
      if (record.envelope.type === "invoke") {
        outcome = await this.#simulator.invoke(
          record.envelope as unknown as InvokeEnvelope,
          selectedCrash === null ? {} : { crashAt: selectedCrash },
        );
      } else if (record.envelope.type === "invoke_batch") {
        outcome = await this.#simulator.invokeBatch(
          record.envelope as unknown as InvokeBatchEnvelope,
          selectedCrash === null ? {} : { crashAt: selectedCrash },
        );
      } else {
        throw new Error("invoke_local envelope.type must be invoke or invoke_batch");
      }
      return { crashed: false, outcome: outcome as unknown as FixtureJsonValue };
    } catch (error) {
      if (!(error instanceof InjectedBridgeCrash)) throw error;
      this.#crashedAt = error.point;
      return { crashed: true, point: error.point };
    }
  }

  #recordVerificationAttempt(record: JsonObject): FixtureJsonValue {
    this.#assertOperational();
    exactKeys(record, [
      "controlVersion",
      "id",
      "action",
      "rsid",
      "holdId",
      "verificationInvocationId",
      "evidenceDigest",
      "conclusion",
      "atMs",
    ]);
    const hold = this.#journal.recordVerificationAttempt({
      rsid: uuidV7(record.rsid, "rsid"),
      holdId: verificationHoldId(record.holdId, "holdId"),
      verificationInvocationId: uuidV7(record.verificationInvocationId, "verificationInvocationId"),
      evidenceDigest: sha256Digest(record.evidenceDigest, "evidenceDigest"),
      conclusion: holdEvidenceConclusion(record.conclusion),
      atMs: safeInteger(record.atMs, "atMs"),
    });
    return { recorded: true, hold: holdControlSummary(hold) };
  }

  #recordLateEvidence(record: JsonObject): FixtureJsonValue {
    this.#assertOperational();
    exactKeys(record, [
      "controlVersion",
      "id",
      "action",
      "rsid",
      "holdId",
      "originInvocationId",
      "evidenceDigest",
      "conclusion",
      "atMs",
    ]);
    const hold = this.#journal.recordLateEvidence({
      rsid: uuidV7(record.rsid, "rsid"),
      holdId: verificationHoldId(record.holdId, "holdId"),
      originInvocationId: uuidV7(record.originInvocationId, "originInvocationId"),
      evidenceDigest: sha256Digest(record.evidenceDigest, "evidenceDigest"),
      conclusion: holdEvidenceConclusion(record.conclusion),
      atMs: safeInteger(record.atMs, "atMs"),
    });
    return { recorded: true, hold: holdControlSummary(hold) };
  }

  #resolveHold(record: JsonObject): FixtureJsonValue {
    this.#assertOperational();
    exactKeys(record, [
      "controlVersion",
      "id",
      "action",
      "rsid",
      "holdId",
      "basis",
      "verificationInvocationId",
      "evidenceDigest",
      "decision",
      "resolutionId",
      "auditId",
      "authorizedDispatchIdentity",
      "atMs",
    ]);
    const basis = holdResolutionBasis(record.basis);
    const verificationInvocationId = record.verificationInvocationId;
    if (basis === "verification_read" && verificationInvocationId === null) {
      throw new Error("verification_read requires verificationInvocationId");
    }
    if (basis === "late_terminal" && verificationInvocationId !== null) {
      throw new Error("late_terminal requires verificationInvocationId=null");
    }
    const hold = this.#journal.resolveHold({
      rsid: uuidV7(record.rsid, "rsid"),
      holdId: verificationHoldId(record.holdId, "holdId"),
      basis,
      verificationInvocationId: verificationInvocationId === null
        ? null
        : uuidV7(verificationInvocationId, "verificationInvocationId"),
      evidenceDigest: sha256Digest(record.evidenceDigest, "evidenceDigest"),
      decision: holdResolutionDecision(record.decision),
      resolutionId: uuidV7(record.resolutionId, "resolutionId"),
      auditId: uuidV7(record.auditId, "auditId"),
      authorizedDispatchIdentity: sha256Digest(
        record.authorizedDispatchIdentity,
        "authorizedDispatchIdentity",
      ),
      atMs: safeInteger(record.atMs, "atMs"),
    });
    return { resolved: true, hold: holdControlSummary(hold) };
  }

  #clearanceForHold(record: JsonObject): FixtureJsonValue {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action", "rsid", "holdId"]);
    const clearance = this.#journal.clearanceForHold(
      uuidV7(record.rsid, "rsid"),
      verificationHoldId(record.holdId, "holdId"),
    );
    return { clearance: clearance as unknown as FixtureJsonValue };
  }

  #injectCrash(record: JsonObject): FixtureJsonValue {
    this.#assertOperational();
    exactKeys(record, ["controlVersion", "id", "action", "point"]);
    if (this.#nextCrashPoint !== null) throw new Error("a crash point is already queued");
    this.#nextCrashPoint = crashPoint(record.point);
    return { queued: true, point: this.#nextCrashPoint };
  }

  async #restart(record: JsonObject): Promise<FixtureJsonValue> {
    exactKeys(record, ["controlVersion", "id", "action"]);
    this.#assertJournalOpen();
    const saved: SavedSession[] = this.#simulator.registeredSessions().map((session) => ({
      session,
      host: session.probe.target.host,
      port: session.probe.target.port,
    }));
    await this.#stopTransport();
    this.#simulator.close();
    this.#closeProbes();
    this.#journal.close();
    this.#journalClosed = true;
    this.#journal = new DurableBridgeJournal(this.#journalPath);
    this.#journalClosed = false;
    this.#simulator = this.#newSimulator();
    for (const savedSession of saved) {
      const discovery = await discoverAddinSessions({
        explicitTarget: { host: savedSession.host, port: savedSession.port },
      });
      const probe = discovery.sessions[0];
      if (probe === undefined) throw new Error(`failed to reconnect ${savedSession.host}:${savedSession.port}`);
      this.#probes.push(probe);
      this.#simulator.attachSession({
        rsid: savedSession.session.rsid,
        resumeToken: savedSession.session.resumeToken,
        resumeExpiresAt: savedSession.session.resumeExpiresAt,
        grantedSessionCapabilities: savedSession.session.grantedSessionCapabilities,
        probe,
        registration: savedSession.session.registration,
      });
    }
    const interrupted = this.#journal.listInvocations().filter((entry) => entry.state === "indeterminate").length;
    const crashPointBeforeRestart = this.#crashedAt;
    this.#crashedAt = null;
    this.#nextCrashPoint = null;
    return {
      restarted: true,
      restoredSessionCount: saved.length,
      indeterminateInvocationCount: interrupted,
      previousCrashPoint: crashPointBeforeRestart,
      transportOpen: false,
    };
  }

  async #registration(record: JsonObject, probe: ProbedAddinSession, requestId: string) {
    return this.#simulator.registrationForProbe({
      probe,
      requestId,
      userHint: boundedString(record.userHint, "userHint", 255),
      hostname: boundedString(record.hostname, "hostname", 255),
      fingerprint: sha256Digest(record.fingerprint, "fingerprint"),
      bridgeVersion: boundedString(record.bridgeVersion, "bridgeVersion", 64),
    });
  }

  #probe(value: unknown): ProbedAddinSession {
    const index = safeInteger(value, "probeIndex", 0, Math.max(0, this.#probes.length - 1));
    const probe = this.#probes[index];
    if (probe === undefined) throw new Error("probeIndex does not identify a discovered fixture");
    return probe;
  }

  #newSimulator(): BridgeSimulator {
    return new BridgeSimulator(
      this.#journal,
      new ArtifactSpool(this.#spoolPath, () => this.#ids.next()),
    );
  }

  #requirePeer(): BridgeGatewayPeer {
    if (this.#peer === null) throw new Error("open_transport must complete first");
    return this.#peer;
  }

  #assertOperational(): void {
    this.#assertJournalOpen();
    if (this.#crashedAt !== null) throw new Error("Bridge is crash-stopped; restart_simulator is required");
  }

  #assertJournalOpen(): void {
    if (this.#journalClosed) throw new Error("Bridge journal is closed");
  }

  #closeProbes(): void {
    for (const probe of this.#probes) probe.client.close();
    this.#probes = [];
  }

  async #stopTransport(): Promise<void> {
    this.#runLoopAbort?.abort();
    this.#runLoopAbort = null;
    if (this.#peer !== null) await this.#peer.close();
    else if (this.#binding !== null) await this.#binding.close();
    const runLoop = this.#runLoop;
    this.#runLoop = null;
    if (runLoop !== null) {
      await Promise.race([
        runLoop,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    this.#peer = null;
    this.#binding = null;
  }

  #sanitizeDiscovery(evidence: DiscoveryEvidence): JsonObject {
    return {
      source: evidence.source,
      probedTargets: evidence.probedTargets.map((target) => ({ ...target })),
      acceptedTargets: evidence.acceptedTargets.map((target) => ({ ...target })),
      rejectedTargets: evidence.rejectedTargets.map((entry) => ({
        target: { ...entry.target },
        reason: entry.reason,
      })),
      tempRegistryReads: evidence.tempRegistryReads,
      filesystemLocksCreated: evidence.filesystemLocksCreated,
    };
  }
}

interface PendingControlResponse {
  readonly response: ControlSuccess | ControlFailure;
  readonly shutdown: boolean;
}

const EXCLUSIVE_CONTROL_ACTIONS = new Set<string>([
  "discover_fixture",
  "attach_fixture_session",
  "open_transport",
  "start_run_loop",
  "session_register",
  "session_resume",
  "session_unregister",
  "tick",
  "inject_crash",
  "restart_simulator",
  "snapshot_evidence",
  "shutdown",
]);

export class BridgeJsonlControl {
  readonly #snapshots = new Map<string, BridgeEvidenceSnapshot>();
  #buffer = Buffer.alloc(0);
  #discardingOversizeLine = false;
  #barrierTail: Promise<void> = Promise.resolve();
  readonly #tasks = new Set<Promise<void>>();
  readonly #responses = new Map<number, PendingControlResponse>();
  #writeChain: Promise<void> = Promise.resolve();
  #writeError: Error | null = null;
  #nextRequestSequence = 0;
  #nextResponseSequence = 0;
  #accepting = true;
  #closed = false;
  readonly #onData = (chunk: Buffer): void => this.#consume(chunk);

  public constructor(
    private readonly runtime: BridgeDaemonRuntime,
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onShutdown: () => void = () => undefined,
  ) {}

  public start(): void {
    if (this.#closed || !this.#accepting) throw new Error("Bridge JSONL control is closed");
    this.input.on("data", this.#onData);
    this.input.resume();
  }

  public close(): void {
    if (this.#closed) return;
    this.#accepting = false;
    this.#closed = true;
    this.#detachInput();
    this.#buffer = Buffer.alloc(0);
    this.#snapshots.clear();
  }

  /** Stops accepting input, lets already accepted work cross its barriers, then closes. */
  public async stopAndDrain(): Promise<void> {
    this.#accepting = false;
    this.#detachInput();
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
    await this.#writeChain;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.#snapshots.clear();
    if (this.#writeError !== null) throw this.#writeError;
  }

  #consume(chunk: Buffer): void {
    if (!this.#accepting) return;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const segment = chunk.subarray(offset, end);
      if (!this.#discardingOversizeLine) {
        if (this.#buffer.byteLength + segment.byteLength > MAX_BRIDGE_CONTROL_LINE_BYTES) {
          this.#buffer = Buffer.alloc(0);
          this.#discardingOversizeLine = true;
          this.#enqueueFailure(failure(
            null,
            "control_line_too_large",
            `Control line exceeds ${MAX_BRIDGE_CONTROL_LINE_BYTES} bytes`,
          ));
        } else if (segment.byteLength > 0) {
          this.#buffer = this.#buffer.byteLength === 0
            ? Buffer.from(segment)
            : Buffer.concat([this.#buffer, segment]);
        }
      }
      if (newline >= 0) {
        if (!this.#discardingOversizeLine) {
          const line = this.#buffer.at(-1) === 0x0d
            ? this.#buffer.subarray(0, this.#buffer.byteLength - 1)
            : this.#buffer;
          this.#enqueueLine(Buffer.from(line));
        }
        this.#buffer = Buffer.alloc(0);
        this.#discardingOversizeLine = false;
        offset = newline + 1;
      } else {
        offset = chunk.byteLength;
      }
    }
  }

  #enqueueFailure(response: ControlFailure): void {
    this.#schedule(async () => ({ response, shutdown: false }), false);
  }

  #enqueueLine(line: Buffer): void {
    this.#schedule(
      async () => this.#handleLine(line),
      this.#lineRequiresBarrier(line),
    );
  }

  #schedule(
    operation: () => Promise<PendingControlResponse>,
    barrier: boolean,
  ): void {
    const sequence = this.#nextRequestSequence;
    this.#nextRequestSequence += 1;
    const previousBarrier = this.#barrierTail;
    const preceding = barrier ? [...this.#tasks] : [];
    const ready = barrier
      ? Promise.allSettled([previousBarrier, ...preceding]).then(() => undefined)
      : previousBarrier;
    const task = ready.then(async () => {
      if (this.#closed) return;
      let result: PendingControlResponse;
      try {
        result = await operation();
      } catch (error) {
        result = {
          response: failure(null, "control_internal_error", String(error)),
          shutdown: false,
        };
      }
      this.#publish(sequence, result);
      if (result.shutdown) await this.#writeChain;
    });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
    if (barrier) this.#barrierTail = task.catch(() => undefined);
  }

  #lineRequiresBarrier(line: Buffer): boolean {
    try {
      const value = parseStrictJsonBytes(line, MAX_BRIDGE_CONTROL_LINE_BYTES);
      if (!isObject(value) || typeof value.action !== "string") return false;
      if (!BRIDGE_CONTROL_ACTIONS.includes(value.action as typeof BRIDGE_CONTROL_ACTIONS[number])) {
        return true;
      }
      return EXCLUSIVE_CONTROL_ACTIONS.has(value.action);
    } catch {
      return false;
    }
  }

  #publish(sequence: number, result: PendingControlResponse): void {
    this.#responses.set(sequence, result);
    this.#writeChain = this.#writeChain
      .then(async () => {
        while (!this.#closed) {
          const next = this.#responses.get(this.#nextResponseSequence);
          if (next === undefined) return;
          this.#responses.delete(this.#nextResponseSequence);
          this.#nextResponseSequence += 1;
          await this.#write(next.response);
          if (next.shutdown) {
            this.close();
            this.onShutdown();
            return;
          }
        }
      })
      .catch((error: unknown) => {
        this.#writeError = error instanceof Error ? error : new Error(String(error));
        this.close();
      });
  }

  #detachInput(): void {
    this.input.off("data", this.#onData);
    this.input.pause();
  }

  async #handleLine(line: Buffer): Promise<{
    response: ControlSuccess | ControlFailure;
    shutdown: boolean;
  }> {
    if (line.byteLength === 0) {
      return { response: failure(null, "invalid_control_json", "Control line is empty"), shutdown: false };
    }
    let value: unknown;
    try {
      value = parseStrictJsonBytes(line, MAX_BRIDGE_CONTROL_LINE_BYTES);
    } catch (error) {
      const code = error instanceof StrictJsonError ? error.code : "invalid_json";
      return {
        response: failure(null, `control_${code}`, error instanceof Error ? error.message : String(error)),
        shutdown: false,
      };
    }
    if (!isObject(value)) {
      return { response: failure(null, "invalid_control_shape", "Control record must be an object"), shutdown: false };
    }
    const correlationId =
      typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 128
        ? value.id
        : null;
    try {
      if (value.controlVersion !== BRIDGE_CONTROL_VERSION) throw new Error("controlVersion must equal 1");
      const id = boundedId(value.id, "id");
      if (typeof value.action !== "string") throw new Error("action must be a string");
      let result: { value: FixtureJsonValue; shutdown: boolean };
      if (value.action === "snapshot_evidence") {
        result = { value: this.#snapshot(value, id), shutdown: false };
      } else if (value.action === "shutdown") {
        exactKeys(value, ["controlVersion", "id", "action"]);
        this.#snapshots.clear();
        result = { value: await this.runtime.shutdown(), shutdown: true };
      } else {
        result = await this.runtime.execute(value, id);
      }
      return {
        response: { controlVersion: 1, id, ok: true, result: result.value },
        shutdown: result.shutdown,
      };
    } catch (error) {
      return {
        response: failure(
          correlationId,
          "invalid_control_request",
          error instanceof Error ? error.message : String(error),
        ),
        shutdown: false,
      };
    }
  }

  #snapshot(record: JsonObject, id: string): FixtureJsonValue {
    exactKeys(record, ["controlVersion", "id", "action"], ["snapshotId", "cursor"]);
    let snapshotId: string;
    let snapshot: BridgeEvidenceSnapshot;
    let cursor: EvidenceCursor;
    if (record.snapshotId === undefined) {
      if (record.cursor !== undefined) throw new Error("cursor requires snapshotId");
      if (this.#snapshots.size >= MAX_ACTIVE_EVIDENCE_SNAPSHOTS) {
        throw new Error(`At most ${MAX_ACTIVE_EVIDENCE_SNAPSHOTS} evidence snapshots may be active`);
      }
      snapshotId = id;
      if (this.#snapshots.has(snapshotId)) throw new Error("snapshot id already exists");
      snapshot = this.runtime.snapshotEvidence();
      cursor = zeroCursor();
      this.#snapshots.set(snapshotId, snapshot);
    } else {
      snapshotId = boundedId(record.snapshotId, "snapshotId");
      const retained = this.#snapshots.get(snapshotId);
      if (retained === undefined) throw new Error("snapshotId is unknown or complete");
      snapshot = retained;
      cursor = parseCursor(record.cursor);
    }
    const page = evidencePage(snapshotId, snapshot, cursor);
    if (page.complete === true) this.#snapshots.delete(snapshotId);
    return page;
  }

  async #write(response: ControlSuccess | ControlFailure): Promise<void> {
    let bytes = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
    if (bytes.byteLength > MAX_BRIDGE_CONTROL_LINE_BYTES) {
      bytes = Buffer.from(`${JSON.stringify(failure(
        typeof response.id === "string" ? response.id : null,
        "control_response_too_large",
        `Control response exceeds ${MAX_BRIDGE_CONTROL_LINE_BYTES} bytes`,
      ))}\n`, "utf8");
    }
    await new Promise<void>((resolve, reject) => {
      this.output.write(bytes, (error) => error ? reject(error) : resolve());
    });
  }
}
