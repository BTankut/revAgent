import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  GatewayBridgeSessionAuthority,
  type ConformancePartialCarrierCommitFailure,
} from "./bridgeSession.js";
import { GatewayRecoveryAuthority } from "./recoveryAuthority.js";
import { GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE } from "./omittedPayloadRecovery.js";
import {
  GatewayResourceAuthority,
  ResourceAuthorityProtectedKeyInventoryPort,
  type ConformanceProtectedResourceReadStage,
} from "./resourceAuthority.js";
import { GatewayDispatcher } from "./dispatch.js";
import { GatewayConfirmationAuthority } from "./confirmationAuthority.js";
import { EntitledCatalogView } from "./entitledRegistry.js";
import { GatewayToolRegistry, M2_BOOTSTRAP_TOOL_RECORDS } from "./registry.js";
import {
  MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS,
  PRODUCTION_CONFORMANCE_TOOL_RECORDS,
  productionConformanceCatalog,
} from "./productionConformanceTools.js";
import {
  MUTATION_PROBE_VERIFICATION_PROFILE,
  bindMutationProbeVerificationWorkflow,
  createMutationProbeVerificationWorkflow,
  isMutationProbeVerificationWorkflow,
  type MutationProbeVerificationWorkflow,
} from "./productionConformanceVerification.js";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { IncomingMessage } from "node:http";
import {
  ConformanceCredentialAuthority,
  DigestFileConformanceObjectStore,
  ProtectedConformanceObjectStore,
  SqliteConformanceProtocolStore,
  createConformanceSupportingPorts,
} from "./conformanceEphemeralAdapters.js";
import {
  createProductionConformanceC39OriginResendPolicy,
  startProductionGatewayHost,
} from "./productionConformanceHost.js";
import { ConformanceProtectedObjectKeyProvider } from "./protectedObjectKeyProvider.js";
import { EncryptedProtectedObjectStore } from "./protectedObjectStore.js";
import { GatewayServingOwnership } from "./gatewayServingOwnership.js";
import type { GatewayProtocolStore } from "./store.js";
import {
  GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
  GATEWAY_RBP_SESSION_V3_NAMESPACE,
  GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
  SessionHistoryStore,
} from "./sessionHistoryStore.js";
import { createConformanceRbpIngressHost } from "./rbpIngress.js";
import type { AuthorizedNorthMcpRequest, NorthMcpEndpointOptions } from "./northMcpEndpoint.js";
import type { EffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

interface CliOptions {
  readonly root: string;
  readonly certificate: string;
  readonly key: string;
  readonly controlToken: string;
  readonly port: number;
  readonly verificationProfile: typeof MUTATION_PROBE_VERIFICATION_PROFILE | null;
}

type ConformanceBinding = "wss" | "streamable_http_sse";

export interface OrderedConformanceHostShutdown {
  readonly beginShutdown: () => void;
  readonly close: () => Promise<void>;
}

/**
 * Recovery is deliberately composed from the same durable store and Bridge
 * evidence authority as the public conformance endpoint.  The conformance
 * host has no recovery-evidence control plane: a fixed denial keeps recovery
 * inspection from becoming an authorization, replay, clearance, or hold
 * mutation path.
 */
export function createProductionConformanceRecoveryAuthority(input: {
  readonly protocolStore: GatewayProtocolStore;
  readonly bridgeEvidence: GatewayBridgeSessionAuthority;
  readonly verificationWorkflow?: MutationProbeVerificationWorkflow;
  readonly confirmationAuthority?: GatewayConfirmationAuthority;
}): GatewayRecoveryAuthority {
  if (input.verificationWorkflow !== undefined &&
      !isMutationProbeVerificationWorkflow(input.verificationWorkflow, {
        protocolStore: input.protocolStore,
        bridgeAuthority: input.bridgeEvidence,
      })) {
    throw new TypeError("production conformance verification workflow is not factory branded");
  }
  const recoveryAuthority = new GatewayRecoveryAuthority(input.protocolStore, {
    bridgeEvidence: input.bridgeEvidence,
    ...(input.confirmationAuthority === undefined
      ? {}
      : { confirmationAuthority: input.confirmationAuthority }),
    evidenceDecision: input.verificationWorkflow?.evidenceDecision ?? Object.freeze({
      async decideEvidence() {
        return Object.freeze({
          kind: "rejected" as const,
          reason: "conformance_recovery_evidence_denied",
        });
      },
    }),
  });
  if (input.verificationWorkflow !== undefined) {
    bindMutationProbeVerificationWorkflow({
      workflow: input.verificationWorkflow,
      protocolStore: input.protocolStore,
      bridgeAuthority: input.bridgeEvidence,
      recoveryAuthority,
    });
  }
  return recoveryAuthority;
}

/**
 * Serializes the terminal order for the real conformance child.  In
 * particular, better-sqlite3 must be finalized while Node still owns its IPC
 * environment: releasing IPC first can run Node environment cleanup against
 * native SQLite state that is still live.
 */
export function createOrderedConformanceHostShutdown(input: {
  readonly host: OrderedConformanceHostShutdown;
  readonly closeStore: () => Promise<void>;
  readonly releaseIpc: () => void;
}): () => Promise<void> {
  let shutdown: Promise<void> | null = null;
  return (): Promise<void> => {
    if (shutdown !== null) return shutdown;
    // This is deliberately synchronous. Every caller (signal, STOP, or the
    // enclosing finally) observes the host as non-accepting before it can
    // schedule any more control/session work.
    input.host.beginShutdown();
    shutdown = (async () => {
      let failure: unknown = null;
      try {
        // The host owns accepted HTTP/control work and child session tasks.
        // Its existing close contract settles those tasks before resolving.
        await input.host.close();
      } catch (error) {
        failure = error;
      }
      try {
        // Closing the SQLite database disposes its statements with the native
        // handle. This attempt must finish before Node releases IPC/env state.
        await input.closeStore();
      } catch (error) {
        if (failure === null) failure = error;
      } finally {
        // This must run even after a close failure, but only after the store
        // close attempt has settled. It is safe for repeated STOP/signal paths.
        input.releaseIpc();
      }
      if (failure !== null) throw failure;
    })();
    return shutdown;
  };
}

const REQUIRED_SESSION_CAPABILITIES = Object.freeze([
  "batch_atomic",
  "doc_context_cached_v1",
]);

const REQUIRED_CONNECTION_CAPABILITIES = Object.freeze([
  "journal_v1",
  "chunked_results",
  "artifact_result_v1",
  "route_rebind_proof_v1",
]);

const REAL_CASE_AUDIT_SCHEMA = "revagent.wp12-real-case-audit/v1" as const;
const DOCUMENT_CONTEXT_EPOCH_SCHEMA = "revagent.wp12-document-context-epoch/v1" as const;
export const MAX_DOCUMENT_CONTEXT_OBSERVATIONS = 32;
export const MAX_DOCUMENT_CONTEXT_OBSERVATION_BYTES = 2 * 1024;
const DOCUMENT_CONTEXT_DIGEST = /^[0-9a-f]{64}$/u;

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function safeObservedSequence(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function isCanonicalUtc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function redactedSessionAudit(records: readonly { readonly namespace: string; readonly key: string; readonly value: unknown }[]): readonly Record<string, unknown>[] {
  return Object.freeze(records.slice(0, 32).map((record) => {
    const value = record.value !== null && typeof record.value === "object" && !Array.isArray(record.value)
      ? record.value as Record<string, unknown>
      : {};
    const lifecycle = value.lifecycle !== null && typeof value.lifecycle === "object" && !Array.isArray(value.lifecycle)
      ? value.lifecycle as Record<string, unknown>
      : {};
    const session = lifecycle.sessionLifecycle !== null && typeof lifecycle.sessionLifecycle === "object" && !Array.isArray(lifecycle.sessionLifecycle)
      ? lifecycle.sessionLifecycle as Record<string, unknown>
      : {};
    const binding = value.binding !== null && typeof value.binding === "object" && !Array.isArray(value.binding)
      ? value.binding as Record<string, unknown>
      : {};
    return Object.freeze({
      namespace: record.namespace,
      keyDigest: digest(record.key),
      rsidDigest: typeof value.rsid === "string" ? digest(value.rsid) : null,
      carrier: typeof binding.binding === "string" ? binding.binding : "unknown",
      phase: typeof session.phase === "string" ? session.phase : "unknown",
      dispatchAllowed: session.dispatchAllowed === true,
      recordDigest: digest(value),
    });
  }));
}

const C39_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const C39_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type C39AuditRecord = Readonly<{
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
  /** Store version is part of the v3 root/marker/page reference proof. */
  readonly version: number;
}>;

function c39Object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function c39Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && C39_DIGEST.test(value);
}

function c39Positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function c39NonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function c39StoredValueDigest(value: unknown): `sha256:${string}` | null {
  try {
    return `sha256:${createHash("sha256").update(canonicalizeJson(value as JsonValue)).digest("hex")}`;
  } catch {
    return null;
  }
}

function c39OwnerMatches(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return ["tenantId", "userId", "effectiveMcpSessionId", "sessionBindingId",
    "rsid", "recoveryInvocationId", "originInvocationId", "originResultDigest"]
    .every((field) => left[field] === right[field]) &&
    Number.isSafeInteger(left.sessionBindingVersion) &&
    left.sessionBindingVersion === right.sessionBindingVersion;
}

function c39AuditHash(domain: string, value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(`revagent/c39-audit/${domain}\0`, "utf8").update(value, "utf8").digest("hex")}`;
}

/** Fixed Bridge observation identity; this joins the value-free carrier row. */
function c39CarrierObservationRecoveryHash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update("revagent/c39-carrier-observation/v1\0", "utf8").update(value, "utf8").digest("hex")}`;
}

type C39V3Session = Readonly<{
  readonly root: Record<string, unknown>;
  readonly identity: Record<string, unknown>;
  readonly binding: Record<string, unknown>;
  readonly sequence: Record<string, unknown>;
  readonly acceptedInbound: readonly Record<string, unknown>[];
  readonly evidence: readonly Record<string, unknown>[];
}>;

function c39V3Session(
  records: readonly C39AuditRecord[],
  session: C39AuditRecord,
): C39V3Session | null {
  const root = c39Object(session.value);
  const identity = c39Object(root?.identity);
  const binding = c39Object(root?.binding);
  const sequenceHead = c39Object(root?.sequenceHead);
  const sequence = c39Object(sequenceHead?.sequence);
  const trees = Array.isArray(root?.trees) ? root.trees : null;
  if (root === null || identity === null || binding === null || sequenceHead === null ||
      sequence === null || trees === null || session.namespace !== GATEWAY_RBP_SESSION_V3_NAMESPACE ||
      root.schema !== GATEWAY_RBP_SESSION_V3_NAMESPACE || root.generation !== 3 ||
      root.tenantId !== "conformance" || root.rsid !== session.key ||
      !c39Positive(root.rootVersion) || !c39Positive(session.version)) return null;
  const markers = records.filter((row) =>
    row.namespace === GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE && row.key === session.key);
  const marker = markers.length === 1 ? c39Object(markers[0]!.value) : null;
  if (marker === null || marker.schema !== GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE ||
      marker.generation !== 3 || marker.tenantId !== "conformance" || marker.rsid !== session.key ||
      marker.rootVersion !== root.rootVersion || marker.rootDigest !== c39StoredValueDigest(root) ||
      marker.treesDigest !== c39StoredValueDigest(trees)) return null;

  const pageRows = records.filter((row) => row.namespace === GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE);
  const visited = new Set<string>();
  const readRef = (
    candidate: unknown,
    treeKind: string,
    depth: number,
  ): readonly Readonly<{ readonly key: string; readonly value: Record<string, unknown> }>[] | null => {
    const ref = c39Object(candidate);
    if (ref === null || ref.namespace !== GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE ||
        typeof ref.key !== "string" || !c39Positive(ref.version) || !c39Digest(ref.digest) ||
        typeof ref.firstKey !== "string" || typeof ref.lastKey !== "string" ||
        !c39Positive(ref.count) || !c39Positive(ref.height) || depth > 4 || visited.has(ref.key)) return null;
    const matches = pageRows.filter((row) => row.key === ref.key && row.version === ref.version);
    if (matches.length !== 1 || c39StoredValueDigest(matches[0]!.value) !== ref.digest) return null;
    const page = c39Object(matches[0]!.value);
    if (page === null || page.schema !== GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE || page.generation !== 1 ||
        page.tenantId !== "conformance" || page.rsid !== session.key || page.treeKind !== treeKind ||
        page.height !== ref.height || typeof page.pageId !== "string" ||
        ref.key !== `${session.key}/${treeKind}/${page.pageId}`) return null;
    visited.add(ref.key);
    if (page.height === 1) {
      if (!Array.isArray(page.entries) || page.entries.length !== ref.count || page.entries.length === 0) return null;
      const entries: Array<Readonly<{ readonly key: string; readonly value: Record<string, unknown> }>> = [];
      for (const candidateEntry of page.entries) {
        const entry = c39Object(candidateEntry);
        const value = c39Object(entry?.value);
        if (entry === null || value === null || typeof entry.key !== "string" ||
            !c39Digest(entry.digest) || entry.digest !== c39StoredValueDigest(entry.value) ||
            (entries.length > 0 && entries.at(-1)!.key >= entry.key)) return null;
        entries.push(Object.freeze({ key: entry.key, value }));
      }
      if (entries[0]!.key !== ref.firstKey || entries.at(-1)!.key !== ref.lastKey) return null;
      return Object.freeze(entries);
    }
    if (!Array.isArray(page.children) || page.children.length === 0) return null;
    const entries: Array<Readonly<{ readonly key: string; readonly value: Record<string, unknown> }>> = [];
    for (const child of page.children) {
      const values = readRef(child, treeKind, depth + 1);
      if (values === null) return null;
      entries.push(...values);
    }
    if (entries.length !== ref.count || entries[0]!.key !== ref.firstKey ||
        entries.at(-1)!.key !== ref.lastKey) return null;
    return Object.freeze(entries);
  };
  const lanes = new Map<string, readonly Record<string, unknown>[]>();
  for (const candidate of trees) {
    const tree = c39Object(candidate);
    if (tree === null || typeof tree.treeKind !== "string" || lanes.has(tree.treeKind) ||
        !c39NonNegative(tree.entryCount)) return null;
    if (tree.root === null) {
      if (tree.entryCount !== 0) return null;
      lanes.set(tree.treeKind, Object.freeze([]));
      continue;
    }
    const entries = readRef(tree.root, tree.treeKind, 1);
    if (entries === null || entries.length !== tree.entryCount) return null;
    lanes.set(tree.treeKind, Object.freeze(entries.map((entry) => entry.value)));
  }
  const ownedPages = pageRows.filter((row) => c39Object(row.value)?.rsid === session.key);
  if (ownedPages.length !== visited.size || !lanes.has("evidence") || !lanes.has("receipts")) return null;
  const acceptedInbound = lanes.get("receipts")!;
  const evidence = lanes.get("evidence")!;
  return Object.freeze({ root, identity, binding, sequence, acceptedInbound, evidence });
}

/**
 * Fixed, value-free C39 projection.  It is deliberately all-or-nothing per
 * origin: malformed, duplicate, expired, partial, or cross-owner evidence is
 * indistinguishable from no observed row.
 */
export function coherentC39RecoveryAudit(input: {
  readonly records: readonly C39AuditRecord[];
  readonly nowMs: number;
}): Readonly<{ readonly status: "joined" | "no_coherent_row"; readonly rows: readonly Record<string, unknown>[] }> {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    return Object.freeze({ status: "no_coherent_row" as const, rows: Object.freeze([]) });
  }
  const byNamespace = (namespace: string) => input.records.filter((row) => row.namespace === namespace);
  const omitted = byNamespace(GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE);
  const chunks = byNamespace("gateway.recovery-chunk/v1");
  const completions = byNamespace("gateway.recovery-completion/v1");
  const resources = byNamespace("gateway_resource_v1");
  const sessions = byNamespace(GATEWAY_RBP_SESSION_V3_NAMESPACE);
  const rows: Record<string, unknown>[] = [];
  for (const source of omitted) {
    const record = c39Object(source.value);
    const owner = c39Object(record?.owner);
    if (record === null || owner === null || record.schema !== GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE ||
      record.recordVersion !== 1 || record.tenantId !== "conformance" || record.state !== "completed" ||
      !C39_UUID.test(String(record.originInvocationId)) || source.key !== record.originInvocationId ||
      !C39_UUID.test(String(record.carrierRecoveryInvocationId)) || !c39Digest(record.originResultDigest) ||
      !c39Digest(record.terminalEvidenceDigest) || !c39Digest(record.resultReferenceDigest) ||
      !c39Positive(record.expiresAtMs) || Number(record.expiresAtMs) <= input.nowMs ||
      owner.userId === undefined || owner.effectiveMcpSessionId === undefined || owner.rsid === undefined ||
      !C39_UUID.test(String(owner.sessionBindingId)) || !c39Positive(owner.sessionVersion)) continue;

    const fullOwner = Object.freeze({
      tenantId: "conformance", userId: owner.userId,
      principalKey: undefined, effectiveMcpSessionId: owner.effectiveMcpSessionId,
      sessionBindingId: owner.sessionBindingId, sessionBindingVersion: owner.sessionVersion,
      rsid: owner.rsid, recoveryInvocationId: record.carrierRecoveryInvocationId,
      originInvocationId: record.originInvocationId,
      originResultDigest: record.originResultDigest,
    }) as Record<string, unknown>;
    const matchingCompletions = completions.map((row) => c39Object(row.value)).filter((value) => {
      const candidateOwner = c39Object(value?.owner);
      return value !== null && candidateOwner !== null && value.schemaVersion === "revagent-gateway-recovery/v1" &&
        value.state === "active" && c39Positive(value.expiresAtMs) && Number(value.expiresAtMs) > input.nowMs &&
        value.activatedSessionBindingId === fullOwner.sessionBindingId &&
        value.activatedSessionBindingVersion === fullOwner.sessionBindingVersion &&
        c39OwnerMatches(candidateOwner, fullOwner) && typeof value.refId === "string";
    });
    const matchingResources = resources.map((row) => c39Object(row.value)).filter((value) => {
      const protectedRecovery = c39Object(value?.protectedRecovery);
      const candidateOwner = c39Object(protectedRecovery?.owner);
      return value !== null && protectedRecovery !== null && candidateOwner !== null &&
        value.kind === "result_ref" && (value.lifecycle === undefined || value.lifecycle === "active") &&
        c39Positive(value.expiresAtMs) && Number(value.expiresAtMs) > input.nowMs &&
        value.digest === record.resultReferenceDigest &&
        protectedRecovery.resultRefDigest === record.resultReferenceDigest &&
        protectedRecovery.activatedSessionBindingId === fullOwner.sessionBindingId &&
        protectedRecovery.activatedSessionBindingVersion === fullOwner.sessionBindingVersion &&
        c39OwnerMatches(candidateOwner, fullOwner);
    });
    const matchingChunks = chunks.map((row) => c39Object(row.value)).filter((value): value is Record<string, unknown> => {
      const candidateOwner = c39Object(value?.owner);
      return value !== null && candidateOwner !== null && value.schemaVersion === "revagent-gateway-recovery/v1" &&
        value.state === "active" && c39Positive(value.expiresAtMs) && Number(value.expiresAtMs) > input.nowMs &&
        Number.isSafeInteger(value.plainLength) && Number(value.plainLength) >= 0 && Number.isSafeInteger(value.bridgeSequence) && Number(value.bridgeSequence) >= 1 &&
        Number.isSafeInteger(value.chunkIndex) && Number(value.chunkIndex) >= 0 &&
        c39Digest(value.plainDigest) && value.resultRefDigest === record.resultReferenceDigest &&
        c39OwnerMatches(candidateOwner, fullOwner);
    });
    const matchingSessions = sessions.map((row) => c39V3Session(input.records, row)).filter(
      (value): value is C39V3Session => value !== null && value.root.rsid === fullOwner.rsid &&
        value.identity.userId === fullOwner.userId &&
        C39_UUID.test(String(value.binding.sessionBindingId)) &&
        c39Positive(value.binding.sessionVersion) && value.sequence.rsid === fullOwner.rsid &&
        c39NonNegative(value.sequence.lastRxSeq),
    ).filter((value) => {
      const inboundSequences = new Set<number>();
      return value.acceptedInbound.every((accepted) => {
        if (!c39Positive(accepted.seq) || !c39Digest(accepted.immutableDigest) ||
            inboundSequences.has(accepted.seq)) return false;
        inboundSequences.add(Number(accepted.seq));
        return true;
      });
    });
    const uniqueChunkIndexes = new Set(matchingChunks.map((chunk) => chunk.chunkIndex));
    if (matchingCompletions.length !== 1 || matchingResources.length !== 1 ||
      matchingSessions.length !== 1 || matchingChunks.length < 1 ||
      uniqueChunkIndexes.size !== matchingChunks.length) continue;
    const completion = matchingCompletions[0]!;
    const resource = matchingResources[0]!;
    const protectedRecovery = c39Object(resource.protectedRecovery);
    const session = matchingSessions[0]!;
    const nestedSequence = session.sequence;
    const evidenceFor = (invocationId: unknown, requireOmitted: boolean, requireC39Authority: boolean): readonly Record<string, unknown>[] => session.evidence.filter((entry) => {
      const truth = c39Object(entry?.terminalTruth);
      const routeAuthority = c39Object(entry?.c39RouteAuthority);
      return truth !== null && entry.terminalInvocationId === invocationId &&
        entry.terminalSessionBindingId === fullOwner.sessionBindingId &&
        entry.terminalSessionVersion === fullOwner.sessionBindingVersion &&
        entry.effectiveMcpSessionId === fullOwner.effectiveMcpSessionId && c39Digest(entry.terminalDigest) &&
        c39Digest(entry.terminalCarrierDigest) && truth.state === "completed" &&
        (!requireC39Authority || (routeAuthority !== null && routeAuthority.version === 1 &&
          routeAuthority.provenance === "session_resume_route_rebind_v1" &&
          c39Digest(routeAuthority.routeAuthorityCheckpoint) && c39Digest(routeAuthority.connectionDigest) &&
          c39Digest(routeAuthority.serverProofDigest) && c39Digest(routeAuthority.authorityGenerationDigest) &&
          C39_UUID.test(String(routeAuthority.resultantSessionBindingId)) &&
          c39Positive(routeAuthority.resultantSessionVersion) && c39Positive(routeAuthority.proofCasRecordVersion))) &&
        truth.resultDigest === fullOwner.originResultDigest &&
        (requireOmitted
          ? entry.payloadOmittedRecoveryEvidenceVersion === 1 && entry.payloadOmittedRecoveryEligible === true && truth.payloadRetained === false
          : true);
    });
    // The v3 root's binding is deliberately *not* matched to fullOwner: it can
    // advance after the immutable historical terminal evidence was committed.
    const originEvidence = evidenceFor(fullOwner.originInvocationId, true, false);
    const recoveryEvidence = evidenceFor(fullOwner.recoveryInvocationId, false, true);
    const evidenceRowsFor = (invocationId: unknown) => session.evidence.filter((entry) =>
      entry.terminalInvocationId === invocationId);
    const partials = [...matchingChunks].sort((left, right) => Number(left.chunkIndex) - Number(right.chunkIndex));
    const acceptedInbound = session.acceptedInbound;
    const inboundAt = (seq: unknown): Record<string, unknown> | null => {
      const candidates = acceptedInbound.filter((accepted) =>
        accepted.seq === seq && c39Digest(accepted.immutableDigest));
      return candidates.length === 1 ? candidates[0]! : null;
    };
    const partialEvidenceValid = partials.every((partial) => inboundAt(partial.bridgeSequence) !== null);
    const contiguous = partials.every((partial, index) => Number(partial.chunkIndex) === index &&
      (index === 0 || Number(partial.bridgeSequence) > Number(partials[index - 1]!.bridgeSequence)));
    const byteLength = partials.reduce((total, partial) => total + Number(partial.plainLength), 0);
    const recoveryEntry = recoveryEvidence[0];
    const originEntry = originEvidence[0];
    const terminalCarrierDigest = recoveryEntry?.terminalCarrierDigest;
    const routeAuthority = c39Object(recoveryEntry?.c39RouteAuthority);
    const terminalCandidates = acceptedInbound.filter((accepted) =>
      c39Digest(accepted.immutableDigest) && accepted.immutableDigest === terminalCarrierDigest);
    const terminalSequence = terminalCandidates.length === 1 ? terminalCandidates[0]!.seq : null;
    if (completion.refId !== resource.refId || protectedRecovery === null ||
      originEvidence.length !== 1 || recoveryEvidence.length !== 1 ||
      evidenceRowsFor(fullOwner.originInvocationId).length !== 1 || evidenceRowsFor(fullOwner.recoveryInvocationId).length !== 1 ||
      originEntry?.terminalDigest !== record.terminalEvidenceDigest || !partialEvidenceValid || !contiguous ||
      !c39Positive(terminalSequence) || Number(terminalSequence) <= Number(partials.at(-1)!.bridgeSequence) ||
      Number(nestedSequence.lastRxSeq) < Number(terminalSequence) ||
      completion.expiresAtMs !== resource.expiresAtMs ||
      protectedRecovery.chunkIndex !== partials.length || protectedRecovery.bridgeSequence !== partials.at(-1)!.bridgeSequence ||
      protectedRecovery.plainLength !== byteLength || resource.byteSize !== byteLength ||
      protectedRecovery.plainDigest !== record.originResultDigest) continue;
    if (routeAuthority === null) continue;
    rows.push(Object.freeze({
      contractVersion: "revagent.wp12-c39-observed-recovery/v1",
      state: "active",
      originIdHash: c39AuditHash("origin", String(record.originInvocationId)),
      recoveryIdHash: c39CarrierObservationRecoveryHash(String(record.carrierRecoveryInvocationId)),
      rsidHash: c39AuditHash("rsid", String(fullOwner.rsid)),
      originDigest: record.originResultDigest,
      resultRefDigest: record.resultReferenceDigest,
      routeAuthority: Object.freeze({
        routeAuthorityCheckpoint: routeAuthority.routeAuthorityCheckpoint,
        connectionDigest: routeAuthority.connectionDigest,
        serverProofDigest: routeAuthority.serverProofDigest,
        authorityGenerationDigest: routeAuthority.authorityGenerationDigest,
        resultantSessionVersion: routeAuthority.resultantSessionVersion,
        proofCasRecordVersion: routeAuthority.proofCasRecordVersion,
        provenance: routeAuthority.provenance,
      }),
      partials: Object.freeze(partials.map((partial) => Object.freeze({
        seq: partial.bridgeSequence,
        chunkIndex: partial.chunkIndex,
        plainDigest: partial.plainDigest,
        byteLength: partial.plainLength,
        state: "active",
      }))),
      terminal: Object.freeze({
        seq: terminalSequence,
        originDigest: record.originResultDigest,
        state: "completed",
      }),
    }));
  }
  return Object.freeze({
    status: rows.length === 0 ? "no_coherent_row" as const : "joined" as const,
    rows: Object.freeze(rows.sort((left, right) => String(left.originIdHash).localeCompare(String(right.originIdHash)))),
  });
}

/** Value-free proof that the Gateway accepted a real doc_context_update. */
type DocumentContextObservation = Readonly<{
  readonly stage: "accepted";
  readonly sequence: number;
  readonly contextDigest: string;
  readonly ordinal: number;
  readonly observedAtUtc: string;
}>;

export interface DocumentContextObservationSnapshot {
  readonly processEpoch: string;
  readonly highWaterOrdinal: number;
  readonly rows: readonly DocumentContextObservation[];
}

/**
 * Value-free outcome of the bounded A/route/B/final-route audit attempt.
 * This is diagnostic-only: it must never become an alternate join authority.
 */
export const COHERENT_DOCUMENT_CONTEXT_AUDIT_STATUSES = Object.freeze([
  "joined",
  "route_absent",
  "observation_missing",
  "sequence_mismatch",
  "context_digest_mismatch",
  "route_changed",
  "record_or_binding_changed",
  "epoch_churn",
  "cursor_evicted",
  "observation_churn",
  "retry_exhausted",
] as const);

export type CoherentDocumentContextAuditStatus =
  (typeof COHERENT_DOCUMENT_CONTEXT_AUDIT_STATUSES)[number];

const MAX_COHERENT_DOCUMENT_CONTEXT_AUDIT_ATTEMPTS = 3;

function coherentAuditPriority(status: CoherentDocumentContextAuditStatus): number {
  switch (status) {
    // Churn must win over a concurrently observable lower-level mismatch so
    // an operator cannot mistake an unstable read for a stable bad row.
    case "epoch_churn": return 90;
    case "record_or_binding_changed": return 80;
    case "route_changed": return 70;
    case "cursor_evicted": return 60;
    case "observation_churn": return 55;
    case "sequence_mismatch": return 50;
    case "context_digest_mismatch": return 40;
    case "observation_missing": return 30;
    case "route_absent": return 20;
    case "retry_exhausted": return 10;
    case "joined": return 0;
  }
}

function observationSnapshot(
  processEpoch: string,
  highWaterOrdinal: number,
  rows: readonly DocumentContextObservation[],
): DocumentContextObservationSnapshot {
  return Object.freeze({
    processEpoch,
    highWaterOrdinal,
    rows: Object.freeze([...rows]),
  });
}

function sameDocumentContextRoute(
  left: ReturnType<GatewayBridgeSessionAuthority["readCurrentDocumentRouteAuditSnapshot"]>,
  right: ReturnType<GatewayBridgeSessionAuthority["readCurrentDocumentRouteAuditSnapshot"]>,
): boolean {
  return left !== null && right !== null &&
    left.rsidHash === right.rsidHash &&
    left.observedSequence === right.observedSequence &&
    left.contextDigest === right.contextDigest &&
    left.routeDigest === right.routeDigest &&
    left.recordDigest === right.recordDigest &&
    left.sessionBindingDigest === right.sessionBindingDigest &&
    left.connectionDigest === right.connectionDigest &&
    left.sessionRecordVersion === right.sessionRecordVersion;
}

function recordOrBindingChanged(
  left: NonNullable<ReturnType<GatewayBridgeSessionAuthority["readCurrentDocumentRouteAuditSnapshot"]>>,
  right: NonNullable<ReturnType<GatewayBridgeSessionAuthority["readCurrentDocumentRouteAuditSnapshot"]>>,
): boolean {
  return left.recordDigest !== right.recordDigest ||
    left.sessionBindingDigest !== right.sessionBindingDigest ||
    left.connectionDigest !== right.connectionDigest ||
    left.sessionRecordVersion !== right.sessionRecordVersion;
}

function observationStatus(
  route: NonNullable<ReturnType<GatewayBridgeSessionAuthority["readCurrentDocumentRouteAuditSnapshot"]>>,
  after: DocumentContextObservationSnapshot,
): CoherentDocumentContextAuditStatus {
  const accepted = after.rows.filter((observation) => observation.stage === "accepted" &&
    observation.ordinal >= 1 && observation.ordinal <= after.highWaterOrdinal &&
    isCanonicalUtc(observation.observedAtUtc));
  if (accepted.some((observation) => observation.contextDigest === route.contextDigest &&
      observation.sequence !== route.observedSequence)) return "sequence_mismatch";
  if (accepted.some((observation) => observation.sequence === route.observedSequence &&
      observation.contextDigest !== route.contextDigest)) return "context_digest_mismatch";
  return "observation_missing";
}

function sameObservationWindow(left: DocumentContextObservationSnapshot, right: DocumentContextObservationSnapshot): boolean {
  return left.highWaterOrdinal === right.highWaterOrdinal && left.rows.length === right.rows.length &&
    left.rows.every((row, index) => {
      const other = right.rows[index];
      return other !== undefined && row.stage === other.stage && row.sequence === other.sequence &&
        row.contextDigest === other.contextDigest && row.ordinal === other.ordinal &&
        row.observedAtUtc === other.observedAtUtc;
    });
}

/**
 * A full B window alone proves nothing about the A candidate.  Eviction is
 * reported only when the exact candidate required by the join was retained in
 * A and is now provably older than B's bounded retained window.
 */
function demonstratedCursorEviction(
  before: DocumentContextObservationSnapshot,
  after: DocumentContextObservationSnapshot,
  route: NonNullable<ReturnType<GatewayBridgeSessionAuthority["readCurrentDocumentRouteAuditSnapshot"]>> | null,
): boolean {
  if (route === null || after.rows.length !== MAX_DOCUMENT_CONTEXT_OBSERVATIONS) return false;
  const candidate = before.rows.filter((observation) => observation.stage === "accepted" &&
    observation.sequence === route.observedSequence && observation.contextDigest === route.contextDigest &&
    observation.ordinal >= 1 && observation.ordinal <= before.highWaterOrdinal &&
    isCanonicalUtc(observation.observedAtUtc));
  const oldestAfter = after.rows[0];
  return candidate.length === 1 && oldestAfter !== undefined && candidate[0]!.ordinal < oldestAfter.ordinal &&
    !after.rows.some((observation) => observation.ordinal === candidate[0]!.ordinal) &&
    after.highWaterOrdinal >= oldestAfter.ordinal;
}

/**
 * Bounded optimistic join: it only reports one exact worker/Gateway pair.
 * Any journal churn, restart, eviction, route advancement, or ambiguity
 * produces no row. It is an evidence projection, never an authority path.
 */
export interface CoherentDocumentContextAuditAuthority {
  readCurrentDocumentRouteAuditSnapshot(input: { readonly tenantId: string }): ReturnType<GatewayBridgeSessionAuthority["readCurrentDocumentRouteAuditSnapshot"]>;
}

export function coherentDocumentContextAudit(input: {
  readonly authority: CoherentDocumentContextAuditAuthority;
  readonly processEpoch: string;
  readonly snapshotObservations: () => DocumentContextObservationSnapshot;
}): Readonly<{
  readonly currentRoute: Record<string, unknown> | null;
  readonly updates: readonly Record<string, unknown>[];
  readonly highWaterOrdinal: number;
  readonly status: CoherentDocumentContextAuditStatus;
  readonly lastAttemptStatus: CoherentDocumentContextAuditStatus;
  readonly attemptCount: number;
  readonly observationCount: number;
}> {
  let highestStatus: CoherentDocumentContextAuditStatus = "retry_exhausted";
  let highestPriority = coherentAuditPriority(highestStatus);
  let lastAttemptStatus: CoherentDocumentContextAuditStatus = "retry_exhausted";
  let allAttemptsObservationChurn = true;
  let finalHighWaterOrdinal = 0;
  let finalObservationCount = 0;
  for (let attempt = 0; attempt < MAX_COHERENT_DOCUMENT_CONTEXT_AUDIT_ATTEMPTS; attempt += 1) {
    const before = input.snapshotObservations();
    const route = input.authority.readCurrentDocumentRouteAuditSnapshot({ tenantId: "conformance" });
    const after = input.snapshotObservations();
    finalHighWaterOrdinal = after.highWaterOrdinal;
    finalObservationCount = Math.min(after.rows.length, MAX_DOCUMENT_CONTEXT_OBSERVATIONS);
    let status: CoherentDocumentContextAuditStatus;
    if (before.processEpoch !== input.processEpoch || after.processEpoch !== input.processEpoch) {
      status = "epoch_churn";
    } else if (!sameObservationWindow(before, after)) {
      status = demonstratedCursorEviction(before, after, route) ? "cursor_evicted" : "observation_churn";
    } else if (route === null) {
      status = "route_absent";
    } else if (!DOCUMENT_CONTEXT_DIGEST.test(route.contextDigest)) {
      status = "retry_exhausted";
    } else {
      const matches = after.rows.filter((observation) => observation.stage === "accepted" &&
        observation.sequence === route.observedSequence &&
        observation.contextDigest === route.contextDigest &&
        observation.ordinal >= 1 && observation.ordinal <= after.highWaterOrdinal &&
        isCanonicalUtc(observation.observedAtUtc));
      if (matches.length !== 1) {
        status = observationStatus(route, after);
      } else {
        const finalRoute = input.authority.readCurrentDocumentRouteAuditSnapshot({ tenantId: "conformance" });
        if (finalRoute === null) {
          status = "route_changed";
        } else if (!sameDocumentContextRoute(route, finalRoute)) {
          status = recordOrBindingChanged(route, finalRoute) ? "record_or_binding_changed" : "route_changed";
        } else {
          const currentRoute = Object.freeze({
            processEpoch: input.processEpoch,
            rsidHash: route.rsidHash,
            observedSequence: route.observedSequence,
            contextDigest: route.contextDigest,
            routeDigest: route.routeDigest,
            recordDigest: route.recordDigest,
            sessionBindingDigest: route.sessionBindingDigest,
            connectionDigest: route.connectionDigest,
            sessionRecordVersion: route.sessionRecordVersion,
          });
          const observation = matches[0]!;
          return Object.freeze({
            currentRoute,
            updates: Object.freeze([Object.freeze({
              contractVersion: "revagent.wp12-document-context-audit/v1",
              event: "gateway.doc_context_update_observation",
              stage: "accepted",
              ...currentRoute,
              observationOrdinal: observation.ordinal,
              observedAtUtc: observation.observedAtUtc,
            })]),
            highWaterOrdinal: after.highWaterOrdinal,
            status: "joined",
            lastAttemptStatus: "joined",
            attemptCount: attempt + 1,
            observationCount: finalObservationCount,
          });
        }
      }
    }
    const priority = coherentAuditPriority(status);
    lastAttemptStatus = status;
    allAttemptsObservationChurn &&= status === "observation_churn";
    if (priority > highestPriority) {
      highestStatus = status;
      highestPriority = priority;
    }
  }
  const latest = input.snapshotObservations();
  return Object.freeze({
    currentRoute: null,
    updates: Object.freeze([]),
    highWaterOrdinal: finalHighWaterOrdinal === 0 ? latest.highWaterOrdinal : finalHighWaterOrdinal,
    status: allAttemptsObservationChurn ? "retry_exhausted" : highestStatus,
    lastAttemptStatus,
    attemptCount: MAX_COHERENT_DOCUMENT_CONTEXT_AUDIT_ATTEMPTS,
    observationCount: finalObservationCount === 0 ? Math.min(latest.rows.length, MAX_DOCUMENT_CONTEXT_OBSERVATIONS) : finalObservationCount,
  });
}

export function conformanceConnectionCapabilitiesForBinding(
  binding: ConformanceBinding,
): readonly string[] {
  return Object.freeze([
    ...REQUIRED_CONNECTION_CAPABILITIES,
    ...(binding === "streamable_http_sse" ? ["transport_streamable_http"] : []),
  ]);
}

function exactCapabilityList(value: unknown, expected: readonly string[]): value is readonly string[] {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((entry) => typeof entry === "string") &&
    new Set(value).size === value.length && expected.every((entry) => value.includes(entry));
}

/** Returns the only authority provision accepted by the public test route. */
export function validateConformanceDeviceProvision(input: {
  readonly binding: unknown;
  readonly connectionCapabilities: unknown;
  readonly sessionCapabilities: unknown;
}): { readonly binding: ConformanceBinding; readonly connectionCapabilities: readonly string[]; readonly sessionCapabilities: readonly string[] } | null {
  if (input.binding !== "wss" && input.binding !== "streamable_http_sse") return null;
  const connectionCapabilities = conformanceConnectionCapabilitiesForBinding(input.binding);
  if (!exactCapabilityList(input.connectionCapabilities, connectionCapabilities) ||
      !exactCapabilityList(input.sessionCapabilities, REQUIRED_SESSION_CAPABILITIES)) return null;
  return Object.freeze({
    binding: input.binding,
    connectionCapabilities,
    sessionCapabilities: REQUIRED_SESSION_CAPABILITIES,
  });
}

function parse(args: readonly string[]): CliOptions {
  if (args.length !== 10 && args.length !== 12) throw new Error("production conformance host requires five required --key value pairs and one optional verification profile");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values.has(key)) throw new Error("invalid production conformance host arguments");
    values.set(key, value);
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) throw new Error(`missing ${key}`);
    return value;
  };
  const rawPort = required("--port");
  const port = Number(rawPort);
  const profile = values.get("--verification-profile") ?? null;
  if (profile !== null && profile !== MUTATION_PROBE_VERIFICATION_PROFILE) throw new Error("invalid production conformance verification profile");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || values.size !== (profile === null ? 5 : 6)) throw new Error("invalid production conformance host port");
  return Object.freeze({ root: path.resolve(required("--root")), certificate: path.resolve(required("--certificate")), key: path.resolve(required("--key")), controlToken: required("--control-token"), port, verificationProfile: profile });
}

function constantTokenEquals(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Executable WP-12 Gateway composition. The admin surface is deliberately
 * loopback/TLS-only and requires an out-of-band test token. It is the sole
 * mutation route for the conformance credential authority; callers cannot
 * reach its in-process store or authority object directly.
 */
export async function runProductionConformanceHostCli(args: readonly string[]): Promise<void> {
  const options = parse(args);
  type StorageBootstrapRequest = Readonly<{
    readonly action: "bootstrap_storage_v1";
    readonly nonce: string;
    readonly rootDigest: string;
    readonly launchDigest: string;
    readonly generation: 1;
  }>;
  const bootstrapRequest = process.connected
    ? new Promise<StorageBootstrapRequest>((resolve) => {
        const onMessage = (message: unknown): void => {
          if (message === null || typeof message !== "object" || Array.isArray(message)) return;
          const value = message as Partial<StorageBootstrapRequest>;
          if (value.action !== "bootstrap_storage_v1") return;
          process.off("message", onMessage);
          resolve(value as StorageBootstrapRequest);
        };
        process.on("message", onMessage);
      })
    : null;
  const [cert, key] = await Promise.all([readFile(options.certificate), readFile(options.key)]);
  const credentials = [
    { tenantId: "conformance", userId: "conformance", deviceId: "wp12-device", token: "wp12-device-token" },
    { tenantId: "conformance", userId: "conformance-foreign", deviceId: "wp12-north-foreign", token: createHash("sha256").update("revagent.wp12.c39.foreign-north/v1\0", "utf8").update(options.controlToken, "utf8").digest("base64url") },
  ] as const;
  const identity = new ConformanceCredentialAuthority(credentials);
  const northSessions = new Map<string, Readonly<{ readonly token: string; readonly tenantId: string; readonly userId: string }>>();
  let conformanceEndpoint: string | null = null;
  const issueNorthCredential = (
    credential: typeof credentials[number],
    action: "issue_north_credential" | "issue_north_foreign_credential",
  ) => {
    if (northSessions.size >= 64 || conformanceEndpoint === null) {
      throw new Error("conformance north session issuance is unavailable");
    }
    const serverMcpSessionId = randomUUID();
    northSessions.set(serverMcpSessionId, Object.freeze({
      token: credential.token, tenantId: credential.tenantId, userId: credential.userId,
    }));
    return Object.freeze({
      ok: true as const, action, bearer: credential.token,
      audience: `${conformanceEndpoint}/mcp`, serverMcpSessionId,
      credentialProvenance: "gateway_production_conformance" as const,
      identityContract: "revagent.auth-context/v1" as const,
    });
  };
  const rawProtocolStore = new SqliteConformanceProtocolStore(options.root);
  const rawObjectStore = new DigestFileConformanceObjectStore(options.root);
  const servingOwnership = new GatewayServingOwnership({
    protocolStore: rawProtocolStore,
    privateObjectStore: rawObjectStore,
    profile: "production_conformance",
  });
  const protocolStore = servingOwnership.protocolStore;
  const objectStore = servingOwnership.resourceObjectStore!;
  let storeClose: Promise<void> | null = null;
  const closeProtocolStore = (): Promise<void> => {
    if (storeClose !== null) return storeClose;
    storeClose = protocolStore.close().then((outcome) => {
      if (!outcome.ok) throw new Error("conformance protocol store did not close");
    });
    return storeClose;
  };
  const releaseIpc = (): void => {
    // The parent owns its end of the supervision IPC channel. A child must
    // never close that endpoint itself: doing so races Node's native teardown
    // with the last SQLite handles.  This no-op keeps the ordered shutdown
    // primitive usable for non-IPC callers while the parent's exact STOP ack
    // controls IPC release.
  };
  // The carrier and the host ports must use one exact durable pair.  This is
  // deliberately composed before ingress so carrier capability grants cannot
  // pass a readiness check against an unrelated object store.
  // C39 envelopes are keyed by their authority-bound opaque storage key, not
  // the ciphertext hash.  Keep that isolated from the ordinary content-
  // addressed C38 conformance store and its `key === sha256(bytes)` rule.
  const protectedConformanceObjectStore = new ProtectedConformanceObjectStore(
    options.root,
  );
  const ownedProtectedConformanceObjectStore = servingOwnership.bindObjectStore(
    protectedConformanceObjectStore,
  );
  // This inventory reads the same durable recovery rows as production C2b;
  // only its wrapper/provider are conformance-only and have no config/env
  // selection path. The random process key is never emitted or persisted.
  const durableKeyInventory = new ResourceAuthorityProtectedKeyInventoryPort(protocolStore);
  const conformanceKeyInventory = Object.freeze({
    kind: "conformance" as const,
    async listLiveKids(): Promise<readonly string[] | null> {
      return await durableKeyInventory.listLiveKids();
    },
  });
  const protectedKeys = new ConformanceProtectedObjectKeyProvider(
    "c39-conformance-v1",
    new Map([["c39-conformance-v1", randomBytes(32)]]),
    conformanceKeyInventory,
  );
  const protectedObjectStore = new EncryptedProtectedObjectStore(
    ownedProtectedConformanceObjectStore,
    protectedKeys,
  );
  let authority: GatewayBridgeSessionAuthority | null = null;
  let c39PartialCarrierCommitFailure:
    | ConformancePartialCarrierCommitFailure
    | null = null;
  let c39ProtectedResourceReadFirst: ConformanceProtectedResourceReadStage | null = null;
  let c39ProtectedResourceReadLast: ConformanceProtectedResourceReadStage | null = null;
  const resourceAuthority = new GatewayResourceAuthority({
    protocolStore,
    objectStore,
    protectedObjectStore,
    onConformanceProtectedResourceRead(stage) {
      c39ProtectedResourceReadFirst ??= stage;
      c39ProtectedResourceReadLast = stage;
    },
    async reauthorizeRecoveryScope(owner) {
      const current = await authority?.resolveCurrentRecoveryAuthoritySnapshot(owner);
      return current === null || current === undefined
        ? null
        : Object.freeze({
          sessionBindingId: current.sessionBindingId,
          sessionBindingVersion: current.sessionBindingVersion,
        });
    },
  });
  // The test control response retains no document route or identity values.
  // A bounded stage/sequence trace distinguishes Gateway acceptance from
  // rejection without becoming a second authority path.
  const documentContextObservations: DocumentContextObservation[] = [];
  const documentContextProcessEpoch = randomUUID();
  let documentContextObservationOrdinal = 0;
  const snapshotDocumentContextObservations = (): DocumentContextObservationSnapshot =>
    observationSnapshot(
      documentContextProcessEpoch,
      documentContextObservationOrdinal,
      documentContextObservations,
    );
  authority = new GatewayBridgeSessionAuthority(protocolStore, identity, {
    resourceAuthority,
    servingOwnership,
    internalConformanceOriginResendPolicy:
      createProductionConformanceC39OriginResendPolicy(),
    onConformancePartialCarrierCommitFailure(failure) {
      // One enum only: no identifiers, digests, owners, paths, or messages.
      c39PartialCarrierCommitFailure ??= failure;
    },
    onDocumentContextObservation(observation) {
      if (documentContextObservationOrdinal >= Number.MAX_SAFE_INTEGER) return;
      if (observation.stage !== "accepted" || !DOCUMENT_CONTEXT_DIGEST.test(observation.contextDigest) ||
          !safeObservedSequence(observation.sequence)) return;
      const candidate = Object.freeze({
        stage: observation.stage,
        sequence: observation.sequence,
        contextDigest: observation.contextDigest,
        ordinal: documentContextObservationOrdinal + 1,
        observedAtUtc: new Date().toISOString(),
      }) satisfies DocumentContextObservation;
      if (!isCanonicalUtc(candidate.observedAtUtc) ||
          Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_DOCUMENT_CONTEXT_OBSERVATION_BYTES) return;
      documentContextObservationOrdinal += 1;
      if (documentContextObservations.length === MAX_DOCUMENT_CONTEXT_OBSERVATIONS) documentContextObservations.shift();
      documentContextObservations.push(candidate);
    },
  });
  const verificationWorkflow = options.verificationProfile === MUTATION_PROBE_VERIFICATION_PROFILE
    ? createMutationProbeVerificationWorkflow({
        protocolStore,
        bridgeAuthority: authority,
        runId: randomUUID(),
      })
    : undefined;
  const confirmationAuthority = verificationWorkflow === undefined
    ? undefined
    : new GatewayConfirmationAuthority(protocolStore);
  const recoveryAuthority = createProductionConformanceRecoveryAuthority({
    protocolStore,
    bridgeEvidence: authority!,
    ...(verificationWorkflow === undefined ? {} : { verificationWorkflow }),
    ...(confirmationAuthority === undefined ? {} : { confirmationAuthority }),
  });
  const ingress = createConformanceRbpIngressHost({ authority: authority! });
  const supporting = createConformanceSupportingPorts();
  const registry = new GatewayToolRegistry([
    ...M2_BOOTSTRAP_TOOL_RECORDS,
    ...PRODUCTION_CONFORMANCE_TOOL_RECORDS,
    ...(verificationWorkflow === undefined ? [] : MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS),
  ]);
  const coreUiState = registry.require("core.ui.state");
  const payloadRecoveryTool = registry.require("core.dispatch.payload_recovery");
  const entitledCatalog = new EntitledCatalogView(
    productionConformanceCatalog(
      coreUiState,
      payloadRecoveryTool,
      verificationWorkflow === undefined ? [] : MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS,
    ),
    () => true,
  );
  const dispatcher = new GatewayDispatcher(registry, [authority!.createExecutor()], {
    eventSink: supporting.events,
    eventSource: {
      component: "gateway-production-conformance",
      version: "wp12",
      instance: "loopback",
    },
    recoveryAuthority,
    ...(confirmationAuthority === undefined ? {} : { confirmationAuthority }),
    ...(verificationWorkflow === undefined ? {} : { mutationProbeVerification: verificationWorkflow }),
  });
  const auditAccesses: Array<{ readonly atMs: number; readonly tenantId: string; readonly action: string }> = [];
  const bootstrap = bootstrapRequest === null ? null : await bootstrapRequest;
  if (bootstrap !== null) {
    const expectedRootDigest = `sha256:${createHash("sha256").update(options.root).digest("hex")}`;
    const expectedLaunchDigest = `sha256:${createHash("sha256").update(JSON.stringify(args)).digest("hex")}`;
    if (!/^[0-9a-f]{64}$/u.test(bootstrap.nonce) ||
        bootstrap.rootDigest !== expectedRootDigest ||
        bootstrap.launchDigest !== expectedLaunchDigest ||
        bootstrap.generation !== 1 || Object.keys(bootstrap).sort().join(",") !==
          "action,generation,launchDigest,nonce,rootDigest") {
      throw new Error("production conformance storage bootstrap is invalid");
    }
  }
  await authority.open();
  if (bootstrap !== null && process.send !== undefined) {
    const profileDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(servingOwnership.durabilityProfile()))
      .digest("hex")}`;
    process.send(Object.freeze({
      action: "storage_owned_v1",
      nonce: bootstrap.nonce,
      ownerEpoch: servingOwnership.ownerEpoch,
      profileDigest,
    }));
  }
  const protectedReady = (await protectedObjectStore.checkReadiness()).ready;
  if (!protectedReady || authority === null) {
    throw new Error("production conformance C39 protected recovery did not become ready");
  }
  const payloadRecoveryAuthority: NonNullable<NorthMcpEndpointOptions["payloadRecovery"]> = Object.freeze({
    ready: () => protectedReady,
    async admit(input) {
      return await authority!.admitOmittedPayloadRecoveryFromNorth(input);
    },
    async replayCompleted(input) {
      return await authority!.replayOmittedPayloadRecoveryReferenceFromNorth(input);
    },
  });
  const northMcp: NorthMcpEndpointOptions = Object.freeze({
    registry,
    dispatcher,
    resourceAuthority,
    payloadRecovery: payloadRecoveryAuthority,
    resourceMaxInlineResultBytes: 32 * 1024,
    catalogViewFor: () => entitledCatalog,
    invocationRouteFor: (authenticated: AuthorizedNorthMcpRequest, _mcpSessionId: string, effectiveMcpRequestScope: EffectiveMcpRequestScopeV1) =>
      authority!.resolveLiveInvocationRoute({
        tenantId: authenticated.authContext.actor.tenantId,
        userId: authenticated.authContext.actor.userId,
        deviceId: credentials[0]!.deviceId,
        effectiveMcpRequestScope,
      }),
    requestState: { key: createHash("sha256").update(options.controlToken).digest() },
    resourceMetadataUrl: new URL("https://127.0.0.1/.well-known/oauth-protected-resource/mcp"),
    authenticator: {
      kind: "conformance",
      async authenticate(request: IncomingMessage) {
        const outcome = await identity.authenticateNorthRequest({
          authorization: request.headers.authorization,
        });
        if (!outcome.ok) return null;
        const authorization = request.headers.authorization;
        const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : "";
        const header = request.headers["mcp-session-id"];
        const serverMcpSessionId = typeof header === "string" ? header : null;
        const bound = serverMcpSessionId === null ? undefined : northSessions.get(serverMcpSessionId);
        if (bound === undefined || bound.token !== token ||
            bound.tenantId !== outcome.value.actor.tenantId ||
            bound.userId !== outcome.value.actor.userId) return null;
        const authInfo: AuthInfo = {
          token,
          clientId: "conformance-loopback",
          scopes: ["mcp:tools"],
          resource: new URL("https://127.0.0.1/mcp"),
        };
        // The loopback bearer is issued for this fixed test MCP client.  Bind
        // the callback context to that client before the north endpoint's
        // normal principal/client consistency check; no identity-port state is
        // changed and the token remains outside all emitted evidence.
        return Object.freeze({
          authInfo,
          authContext: Object.freeze({
            ...outcome.value,
            session: Object.freeze({
              ...outcome.value.session,
              oauthClientId: "conformance-loopback",
            }),
          }),
          principalKey: outcome.value.principalKey,
        });
      },
    },
  });
  try {
    const handle = await startProductionGatewayHost({
      hostProfile: "production_conformance",
      authority: authority!,
      resourceAuthority,
      northMcp,
      server: {
        config: {
          nodeEnv: "test",
          logLevel: "fatal",
          http: { bindHost: "127.0.0.1", port: options.port },
          publicUrl: "https://127.0.0.1",
          objectStore: { driver: "fs", root: null },
          credentialsPresent: { databaseUrl: false },
          ingress: { northMcpMountPath: "/mcp", rbpMountPrefix: "/bridge/v1" },
        },
        tls: { cert, key },
      },
      ports: {
        identity,
        protocolStore,
        objectStore,
        entitlement: supporting.entitlement,
        events: supporting.events,
        guardrails: supporting.guardrails,
        rbpIngress: ingress,
      },
      mountConformanceControl(app) {
        app.post("/__conformance/v1/control", async (request, reply) => {
          if (!constantTokenEquals(request.headers["x-rbp-test-control"], options.controlToken)) return reply.code(401).send({ ok: false, error: "unauthorized" });
          const body = request.body as {
            action?: unknown;
            binding?: unknown;
            connectionCapabilities?: unknown;
            sessionCapabilities?: unknown;
            tenantId?: unknown;
          } | null;
          const action = body?.action;
          if (action === "issue_device_credential") {
            const provision = validateConformanceDeviceProvision({
              binding: body?.binding,
              connectionCapabilities: body?.connectionCapabilities,
              sessionCapabilities: body?.sessionCapabilities,
            });
            if (provision === null) {
              return reply.code(400).send({ ok: false, action, error: "invalid_binding" });
            }
            if (conformanceEndpoint === null) {
              return reply.code(400).send({ ok: false, action, error: "invalid_capability_provision" });
            }
            const credential = credentials[0]!;
            const proof = identity.issue(credential.deviceId, {
              connectionCapabilities: provision.connectionCapabilities,
              sessionCapabilities: provision.sessionCapabilities,
            });
            return reply.send({
              ok: true,
              action,
              binding: provision.binding,
              deviceId: credential.deviceId,
              deviceToken: credential.token,
              deviceProof: proof,
              connectionCapabilities: provision.connectionCapabilities,
              sessionCapabilities: provision.sessionCapabilities,
              gatewayEndpoint: conformanceEndpoint,
              credentialProvenance: "gateway_production_conformance",
              adapterProvenance: {
                identity: identity.kind,
                protocolStore: protocolStore.kind,
                authority: "GatewayBridgeSessionAuthority",
              },
              audit: identity.audit(),
            });
          }
          if (action === "issue_north_credential") {
            if (Object.keys(body ?? {}).length !== 1 || conformanceEndpoint === null) {
              return reply.code(400).send({ ok: false, action, error: "invalid_north_credential_request" });
            }
            return reply.send(issueNorthCredential(credentials[0]!, action));
          }
          if (action === "issue_north_foreign_credential") {
            if (Object.keys(body ?? {}).length !== 1 || conformanceEndpoint === null) {
              return reply.code(400).send({ ok: false, action, error: "invalid_north_credential_request" });
            }
            return reply.send(issueNorthCredential(credentials[1]!, action));
          }
          if (action === "revoke_device") {
            const credential = credentials[0]!;
            const revoked = identity.revoke(credential.deviceId);
            return reply.send({ ok: true, action, revoked, audit: identity.audit() });
          }
          if (action === "snapshot_audit") {
            const keys = await protocolStore.startupCoordinator.listKeys(
              "conformance",
              GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
              1_024,
            );
            if (!keys.ok) {
              return reply.code(503).send({ ok: false, action, error: "session_audit_unavailable" });
            }
            const history = new SessionHistoryStore(protocolStore);
            const projections = [];
            for (const rsid of keys.value.slice(0, 2)) {
              const projection = await history.snapshotAudit(
                "conformance",
                rsid,
                authority?.isCurrentV3AuditCandidate(rsid) === true,
              );
              if (!projection.ok) {
                return reply.code(503).send({ ok: false, action, error: "session_audit_unavailable" });
              }
              projections.push(projection.value);
            }
            const status = keys.value.length === 0
              ? "no_candidate"
              : keys.value.length > 1
                ? "multiple"
                : projections[0]?.status ?? "not_current";
            return reply.send({
              ok: true,
              action,
              audit: identity.audit(),
              sessionAudit: {
                status,
                candidateCount: Math.min(keys.value.length, 2),
                projection: keys.value.length === 1 ? projections[0] : null,
              },
            });
          }
          if (action === "read_real_case_audit") {
            if (body?.tenantId !== "conformance" || Object.keys(body ?? {}).length !== 2) {
              return reply.code(400).send({ ok: false, action, error: "invalid_audit_scope" });
            }
            auditAccesses.push(Object.freeze({ atMs: Date.now(), tenantId: "conformance", action: "read_real_case_audit" }));
            const namespaces = [
              GATEWAY_RBP_SESSION_V3_NAMESPACE,
              GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
              GATEWAY_SESSION_HISTORY_PAGE_NAMESPACE,
              "gateway.mutation-hold/v1",
              "gateway.invocation-outcome/v1",
              "gateway.resource-carrier/v1",
              GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE,
              "gateway.recovery-chunk/v1",
              "gateway.recovery-completion/v1",
              "gateway_resource_v1",
            ];
            const readSnapshot = async (): Promise<readonly C39AuditRecord[] | null> => {
              const records: C39AuditRecord[] = [];
              for (const namespace of namespaces) {
                const result = await protocolStore.transact({ tenantId: "conformance" }, async (tx) => await tx.list(namespace));
                if (!result.ok) return null;
                records.push(...result.value.map((row) => Object.freeze({ namespace: row.namespace, key: row.key, value: row.value, version: row.version })));
              }
              return Object.freeze(records.sort((left, right) => `${left.namespace}\u0000${left.key}`.localeCompare(`${right.namespace}\u0000${right.key}`)));
            };
            let records: readonly C39AuditRecord[] | null = null;
            let c39Recovery: ReturnType<typeof coherentC39RecoveryAudit> =
              Object.freeze({ status: "no_coherent_row" as const, rows: Object.freeze([]) });
            let c39RouteRebind: Awaited<ReturnType<GatewayBridgeSessionAuthority["readRouteRebindAuditSnapshot"]>> = Object.freeze({
              status: "invalid" as const,
              candidateCount: 0 as const,
              capabilityGranted: false,
              receiptCurrent: false,
              resumeCasCurrent: false,
              routeProvenanceCurrent: false,
              currentConnection: false,
              routeAuthorityCheckpoint: null,
              connectionDigest: null,
              serverProofDigest: null,
              authorityGenerationDigest: null,
              proofCasRecordVersion: null,
            });
            // A stable pair makes this diagnostic join value-free and bounded:
            // any concurrent durable transition produces no C39 success row.
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const before = await readSnapshot();
              const after = await readSnapshot();
              if (before === null || after === null) return reply.code(503).send({ ok: false, action, error: "real_case_audit_unavailable" });
              records = after;
              if (digest(before) !== digest(after)) continue;
              c39Recovery = coherentC39RecoveryAudit({ records: after, nowMs: Date.now() });
              // This joins only the authority's bounded diagnostic projection.
              // It never reads a route from persistence here and cannot turn a
              // receipt/proof into a dispatch or recovery authorization.
              const routeBefore = await authority.readRouteRebindAuditSnapshot({ tenantId: "conformance" });
              const routeAfter = await authority.readRouteRebindAuditSnapshot({ tenantId: "conformance" });
              if (digest(routeBefore) === digest(routeAfter)) {
                c39RouteRebind = routeAfter;
                const joined = c39Recovery.rows.filter((row) => {
                  const terminal = c39Object(row.routeAuthority);
                  return routeAfter.status === "current" &&
                    terminal?.routeAuthorityCheckpoint === routeAfter.routeAuthorityCheckpoint &&
                    terminal?.connectionDigest === routeAfter.connectionDigest &&
                    terminal?.serverProofDigest === routeAfter.serverProofDigest &&
                    terminal?.authorityGenerationDigest === routeAfter.authorityGenerationDigest &&
                    terminal?.proofCasRecordVersion === routeAfter.proofCasRecordVersion;
                });
                c39Recovery = Object.freeze({
                  status: joined.length === 0 ? "no_coherent_row" as const : "joined" as const,
                  rows: Object.freeze(joined),
                });
              }
              break;
            }
            if (records === null) return reply.code(503).send({ ok: false, action, error: "real_case_audit_unavailable" });
            const rows = redactedSessionAudit(records);
            const coherentDocumentContext = coherentDocumentContextAudit({
              authority,
              processEpoch: documentContextProcessEpoch,
              snapshotObservations: snapshotDocumentContextObservations,
            });
            const mutationProbeVerification = verificationWorkflow === undefined
              ? Object.freeze({ status: "disabled" as const })
              : await verificationWorkflow.readAuditProjection();
            return reply.send({
              ok: true,
              action,
              schemaVersion: REAL_CASE_AUDIT_SCHEMA,
              tenantDigest: digest("conformance"),
              rows,
              c39Recovery,
              c39RouteRebind,
              c39PartialCarrierCommitFailure,
              c39ProtectedResourceReadFirst,
              c39ProtectedResourceReadLast,
              mutationProbeVerification,
              documentContextUpdates: coherentDocumentContext.updates,
              documentContextCurrentRoute: coherentDocumentContext.currentRoute,
              documentContextEpochSchema: DOCUMENT_CONTEXT_EPOCH_SCHEMA,
              documentContextProcessEpoch,
              // The Gateway process owns a single immutable journal epoch;
              // a bridge restart must therefore be rejected by the child
              // cursor generation, never hidden by a synthetic host reset.
              documentContextGeneration: 1,
              documentContextObservationHighWaterOrdinal: coherentDocumentContext.highWaterOrdinal,
              documentContextAuditStatus: coherentDocumentContext.status,
              documentContextAuditLastStatus: coherentDocumentContext.lastAttemptStatus,
              documentContextAuditAttemptCount: coherentDocumentContext.attemptCount,
              documentContextAuditObservationCount: coherentDocumentContext.observationCount,
              counts: Object.freeze({ records: records.length, auditAccesses: auditAccesses.length }),
              frontier: digest(rows),
              auditAccessDigest: digest(auditAccesses.map((entry) => entry.action)),
            });
          }
          return reply.code(400).send({ ok: false, error: "invalid_action" });
        });
      },
    });
    conformanceEndpoint = `https://127.0.0.1:${String(handle.port)}`;
    const close = createOrderedConformanceHostShutdown({
      host: {
        beginShutdown() {
          handle.beginShutdown();
        },
        close: async () => await handle.close(),
      },
      closeStore: closeProtocolStore,
      releaseIpc,
    });
    type ShutdownAckStatus = "closed" | "failed";
    let terminal: Promise<void> | null = null;
    let terminalStatus: ShutdownAckStatus = "closed";
    const runTerminal = (): Promise<void> => {
      if (terminal !== null) return terminal;
      terminal = close().then(
        () => { process.exitCode = 0; },
        (error: unknown) => {
          terminalStatus = "failed";
          process.exitCode = 70;
          process.stderr.write(`production-conformance-host shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
        },
      );
      return terminal;
    };
    const isStopMessage = (message: unknown): message is { readonly action: "STOP"; readonly nonce: string } => {
      if (message === null || typeof message !== "object" || Array.isArray(message)) return false;
      const candidate = message as { readonly action?: unknown; readonly nonce?: unknown };
      // Opaque UUIDs are issued by the parent. Requiring the canonical shape
      // makes stale/malformed controls inert before shutdown state changes.
      return candidate.action === "STOP" && typeof candidate.nonce === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.nonce);
    };
    let resolveStopped: (() => void) | null = null;
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
    const finishWithoutAck = (): void => {
      void runTerminal().finally(() => { resolveStopped?.(); });
    };
    process.once("SIGTERM", finishWithoutAck);
    process.once("SIGINT", finishWithoutAck);
    if (process.send !== undefined) {
      process.on("disconnect", finishWithoutAck);
      process.on("message", (message: unknown) => {
        if (isStopMessage(message)) {
          void runTerminal().then(() => {
            // This acknowledgement is deliberately narrow: it contains only
            // the parent nonce and a fixed status enum, never route/store data.
            if (process.connected && process.send !== undefined) {
              process.send({ action: "shutdown_complete", nonce: message.nonce, status: terminalStatus });
            }
            resolveStopped?.();
          });
          return;
        }
        // Test-only signal injection follows the signal path: it is silent and
        // does not create a STOP acknowledgement authority.
        if ((message as { readonly action?: unknown } | null)?.action === "emit_test_signal") finishWithoutAck();
      });
    }
    // Register STOP before publishing READY: a parent which stops immediately
    // after the ready line must still observe a normal close rather than a
    // signal-terminated child.
    // C# pins the DER certificate returned by TLS, not the PEM transport file.
    const certificateSha256 = `sha256:${createHash("sha256").update(new X509Certificate(cert).raw).digest("hex")}`;
    process.stdout.write(`${JSON.stringify({ ready: true, component: "gateway_production_conformance", contract: "wp12-production-conformance-host/v1", endpoint: conformanceEndpoint, tlsCertificateSha256: certificateSha256, controlPath: "/__conformance/v1/control", pid: process.pid })}\n`);
    await stopped;
  } finally {
    // Startup failures and repeated terminal paths use the same once-only
    // store close. IPC is released even when that close reports an error.
    try {
      await closeProtocolStore();
    } finally {
      releaseIpc();
    }
  }
}

if (process.argv[1]?.endsWith("productionConformanceHostCli.js")) {
  void runProductionConformanceHostCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`production-conformance-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 70;
  });
}
