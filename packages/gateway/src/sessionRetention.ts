import { createHash, randomUUID } from "node:crypto";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

import type { GatewayJsonValue } from "./dispatch.js";
import type {
  DurableRbpSessionV3,
  SessionHistoryTreeRef,
  SessionRetentionClosureV1,
  SessionRetentionObjectIntentRef,
} from "./sessionHistoryStore.js";

export const DEFAULT_SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
export const MINIMUM_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type SessionRetentionPinReason =
  | "not_terminal"
  | "still_resumable"
  | "retention_not_elapsed"
  | "clock_rollback"
  | "producer_not_settled"
  | "pending_dispatch"
  | "unfinished_batch"
  | "active_egress_lease"
  | "unresolved_hold"
  | "c39_dependency"
  | "migration_dependency"
  | "missing_or_malformed_index"
  | "dependency_inventory_incomplete";

export interface SessionRetentionDependencyRef {
  readonly role: string;
  readonly namespace: string;
  readonly key: string;
  readonly version: number;
  readonly digest: `sha256:${string}`;
  readonly state: string;
}

export interface SessionRetentionCandidate {
  readonly tenantId: string;
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly sessionBindingVersion: number;
  readonly lifecyclePhase: string;
  readonly dispatchAllowed: boolean;
  readonly resumable: boolean;
  readonly resumeExpiresAtMs: number;
  readonly retirementAnchorMs: number;
  readonly lastObservedNowMs: number;
  readonly producerState: "settled" | "active" | "unknown";
  readonly pendingDispatch: boolean;
  readonly unfinishedBatch: boolean;
  readonly activeEgressLease: boolean;
  readonly unresolvedHold: boolean;
  readonly c39Dependency: boolean;
  readonly migrationDependency: boolean;
  readonly indicesComplete: boolean;
  readonly dependencyInventoryComplete: boolean;
  readonly unregisterRef: SessionRetentionDependencyRef | null;
  readonly dependencyRefs: readonly SessionRetentionDependencyRef[];
  readonly treeRoots: readonly SessionHistoryTreeRef[];
  readonly privateObjects: readonly SessionRetentionObjectIntentRef[];
  readonly plannedEntries: number;
  readonly plannedRecords: number;
  readonly plannedObjects: number;
}

export type SessionRetentionDecision =
  | Readonly<{
      readonly kind: "retained";
      readonly reasons: readonly SessionRetentionPinReason[];
    }>
  | Readonly<{
      readonly kind: "eligible";
      readonly eligibilityCutoffMs: number;
      readonly retentionAnchorMs: number;
      readonly dependencyClosureDigest: `sha256:${string}`;
    }>;

export interface SessionRetentionOwner {
  readonly identity: string;
  readonly epoch: number;
}

export interface SessionClosureCompletion {
  readonly completedAtMs: number;
  readonly retiredAuthorityDigest: `sha256:${string}`;
  readonly completionDigest: `sha256:${string}`;
  readonly closureReceipt: GatewayJsonValue;
  readonly retiredBinding: GatewayJsonValue;
  readonly retiredLifecycle: GatewayJsonValue;
  readonly retiredSequenceHead: GatewayJsonValue;
}

function asJson(value: unknown): GatewayJsonValue {
  return value as GatewayJsonValue;
}

export function retentionDigest(value: GatewayJsonValue): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(value as JsonValue))
    .digest("hex")}`;
}

function orderedDependencies(
  values: readonly SessionRetentionDependencyRef[],
): readonly SessionRetentionDependencyRef[] {
  const sorted = [...values].sort((left, right) =>
    left.role.localeCompare(right.role) ||
    left.namespace.localeCompare(right.namespace) ||
    left.key.localeCompare(right.key));
  const seen = new Map<string, SessionRetentionDependencyRef>();
  for (const value of sorted) {
    const id = `${value.role}\u0000${value.namespace}\u0000${value.key}`;
    const prior = seen.get(id);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(value)) {
      throw new Error("retention dependency inventory disagrees on a duplicate");
    }
    seen.set(id, value);
  }
  return Object.freeze([...seen.values()]);
}

export function evaluateSessionRetention(
  candidate: SessionRetentionCandidate,
  input: {
    readonly nowMs: number;
    readonly retentionMs?: number;
  },
): SessionRetentionDecision {
  const retentionMs = input.retentionMs ?? DEFAULT_SESSION_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < MINIMUM_SESSION_RETENTION_MS) {
    throw new Error("session retention duration is below the seven-day floor");
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
      !Number.isSafeInteger(candidate.resumeExpiresAtMs) ||
      !Number.isSafeInteger(candidate.retirementAnchorMs)) {
    throw new Error("session retention clock input is invalid");
  }
  const reasons: SessionRetentionPinReason[] = [];
  if (candidate.lifecyclePhase !== "terminal_retained" &&
      candidate.lifecyclePhase !== "unregistered" &&
      candidate.lifecyclePhase !== "retired") reasons.push("not_terminal");
  if (candidate.dispatchAllowed || candidate.resumable || input.nowMs <= candidate.resumeExpiresAtMs) {
    reasons.push("still_resumable");
  }
  const retentionAnchorMs = Math.max(
    candidate.retirementAnchorMs,
    candidate.resumeExpiresAtMs,
  );
  if (input.nowMs < candidate.lastObservedNowMs) reasons.push("clock_rollback");
  if (input.nowMs < retentionAnchorMs + retentionMs) reasons.push("retention_not_elapsed");
  if (candidate.producerState !== "settled") reasons.push("producer_not_settled");
  if (candidate.pendingDispatch) reasons.push("pending_dispatch");
  if (candidate.unfinishedBatch) reasons.push("unfinished_batch");
  if (candidate.activeEgressLease) reasons.push("active_egress_lease");
  if (candidate.unresolvedHold) reasons.push("unresolved_hold");
  if (candidate.c39Dependency) reasons.push("c39_dependency");
  if (candidate.migrationDependency) reasons.push("migration_dependency");
  if (!candidate.indicesComplete) reasons.push("missing_or_malformed_index");
  if (!candidate.dependencyInventoryComplete) reasons.push("dependency_inventory_incomplete");
  if (reasons.length > 0) {
    return Object.freeze({ kind: "retained" as const, reasons: Object.freeze(reasons) });
  }
  const dependencies = orderedDependencies(candidate.dependencyRefs);
  const dependencyClosureDigest = retentionDigest(asJson({
    domain: "revagent/gateway/session-gc-dependencies/v1",
    tenantId: candidate.tenantId,
    rsid: candidate.rsid,
    eligibilityCutoffMs: input.nowMs,
    retentionAnchorMs,
    sessionLifecyclePhase: candidate.lifecyclePhase,
    dispatchAllowed: candidate.dispatchAllowed,
    resumeExpiresAtMs: candidate.resumeExpiresAtMs,
    producerState: "settled",
    unregisterRef: candidate.unregisterRef,
    orderedDependencyRefs: dependencies,
  }));
  return Object.freeze({
    kind: "eligible" as const,
    eligibilityCutoffMs: input.nowMs,
    retentionAnchorMs,
    dependencyClosureDigest,
  });
}

export function createSessionRetentionClosure(input: {
  readonly candidate: SessionRetentionCandidate;
  readonly decision: Extract<SessionRetentionDecision, { readonly kind: "eligible" }>;
  readonly owner: SessionRetentionOwner;
  readonly preClaimRootRef: GatewayJsonValue;
  readonly preClaimMarkerRef: GatewayJsonValue;
  readonly claimToken?: string;
  readonly claimExpiresAtMs: number;
}): SessionRetentionClosureV1 {
  const orderedTreeRoots = [...input.candidate.treeRoots]
    .sort((left, right) => left.treeKind.localeCompare(right.treeKind));
  const orderedPrivateObjects = [...input.candidate.privateObjects]
    .sort((left, right) => left.key.localeCompare(right.key));
  if (orderedPrivateObjects.some((value, index) =>
      index > 0 && value.key === orderedPrivateObjects[index - 1]!.key)) {
    throw new Error("retention private object inventory is duplicated");
  }
  const closureId = randomUUID();
  const planDigest = retentionDigest(asJson({
    domain: "revagent/gateway/session-gc-plan/v1",
    tenantId: input.candidate.tenantId,
    rsid: input.candidate.rsid,
    closureId,
    eligibilityCutoffMs: input.decision.eligibilityCutoffMs,
    sessionBindingId: input.candidate.sessionBindingId,
    sessionBindingVersion: input.candidate.sessionBindingVersion,
    resumeExpiresAtMs: input.candidate.resumeExpiresAtMs,
    preClaimRootRef: input.preClaimRootRef,
    preClaimMarkerRef: input.preClaimMarkerRef,
    orderedTreeRoots,
    orderedPrivateObjects,
    dependencyClosureDigest: input.decision.dependencyClosureDigest,
    plannedEntries: input.candidate.plannedEntries,
    plannedRecords: input.candidate.plannedRecords,
    plannedObjects: input.candidate.plannedObjects,
  }));
  return Object.freeze({
    schema: "revagent.gateway.session-gc-closure/v1",
    closureId,
    planDigest,
    state: "claimed" as const,
    eligibilityCutoffMs: input.decision.eligibilityCutoffMs,
    roots: Object.freeze(orderedTreeRoots),
    objectIntents: Object.freeze(orderedPrivateObjects),
    creator: Object.freeze({
      ownerIdentity: input.owner.identity,
      ownerEpoch: input.owner.epoch,
    }),
    claim: Object.freeze({
      ownerIdentity: input.owner.identity,
      ownerEpoch: input.owner.epoch,
      token: input.claimToken ?? randomUUID(),
      generation: 1,
      expiresAtMs: input.claimExpiresAtMs,
    }),
    cursor: Object.freeze({
      lane: "private_pending_bytes",
      treeKind: null,
      path: Object.freeze([]),
      leafEntryIndex: 0,
      blobSlotIndex: 0,
      lastProcessedKey: null,
      objectInventoryAfterKey: null,
    }),
    counts: Object.freeze({
      plannedEntries: input.candidate.plannedEntries,
      plannedRecords: input.candidate.plannedRecords,
      plannedObjects: input.candidate.plannedObjects,
      processedEntries: 0,
      deletedRecords: 0,
      deletedObjects: 0,
      positiveAbsences: 0,
    }),
    completionDigest: null,
  });
}

export function takeOverSessionRetentionClaim(input: {
  readonly closure: SessionRetentionClosureV1;
  readonly owner: SessionRetentionOwner;
  readonly nowMs: number;
  readonly oldOwnerInactive: boolean;
  readonly claimExpiresAtMs: number;
  readonly token?: string;
}): SessionRetentionClosureV1 {
  if (input.closure.state === "complete") throw new Error("completed retention cannot be reclaimed");
  if (!input.oldOwnerInactive || input.nowMs < input.closure.claim.expiresAtMs ||
      input.owner.epoch <= input.closure.claim.ownerEpoch) {
    throw new Error("retention claim takeover is not authorized");
  }
  return Object.freeze({
    ...input.closure,
    claim: Object.freeze({
      ownerIdentity: input.owner.identity,
      ownerEpoch: input.owner.epoch,
      token: input.token ?? randomUUID(),
      generation: input.closure.claim.generation + 1,
      expiresAtMs: input.claimExpiresAtMs,
    }),
  });
}

export function completeSessionRetention(input: {
  readonly root: DurableRbpSessionV3;
  readonly closure: SessionRetentionClosureV1;
  readonly dependencyClosureDigest: `sha256:${string}`;
  readonly completedAtMs: number;
  readonly migrationProof: GatewayJsonValue;
  readonly antiDowngradeRefs: GatewayJsonValue;
}): SessionClosureCompletion {
  const counts = input.closure.counts;
  if (counts.plannedEntries !== counts.processedEntries ||
      counts.plannedRecords !== counts.deletedRecords ||
      counts.plannedObjects !== counts.deletedObjects) {
    throw new Error("retention closure counters are not exhausted");
  }
  const closureReceipt = Object.freeze({
    planDigest: input.closure.planDigest,
    dependencyClosureDigest: input.dependencyClosureDigest,
    plannedEntries: counts.plannedEntries,
    plannedRecords: counts.plannedRecords,
    plannedObjects: counts.plannedObjects,
    processedEntries: counts.processedEntries,
    deletedRecords: counts.deletedRecords,
    deletedObjects: counts.deletedObjects,
    positiveAbsences: counts.positiveAbsences,
    completedAtMs: input.completedAtMs,
  });
  const currentBinding = input.root.binding as Record<string, unknown>;
  const retiredBinding = asJson({
    ...currentBinding,
    connectionId: null,
    binding: null,
    resumeTokenDigest: null,
    grantedCapabilities: [],
  });
  const retiredLifecycle = asJson({
    phase: "retired",
    dispatchAllowed: false,
    resumable: false,
    resumeExpiresAtMs: (input.root.binding as { readonly resumeExpiresAtMs?: number }).resumeExpiresAtMs ?? 0,
    retiredAtMs: input.completedAtMs,
  });
  const currentHead = input.root.sequenceHead as Record<string, unknown>;
  const currentSequence = (currentHead.sequence ?? currentHead) as Record<string, unknown>;
  const retiredSequenceHead = asJson({
    nextTxSeq: currentSequence.nextTxSeq ?? null,
    highestTxSeq: currentSequence.highestTxSeq ?? 0,
    lastRxSeq: currentSequence.lastRxSeq ?? 0,
    lastPeerAck: currentSequence.lastPeerAck ?? 0,
  });
  const retiredAuthorityDigest = retentionDigest(asJson({
    domain: "revagent/gateway/session-gc-retired-authority/v1",
    schema: input.root.schema,
    generation: input.root.generation,
    rootVersion: input.root.rootVersion + 1,
    tenantId: input.root.tenantId,
    rsid: input.root.rsid,
    identity: input.root.identity,
    binding: retiredBinding,
    retiredLifecycle,
    sequenceHead: retiredSequenceHead,
    migrationProof: input.migrationProof,
    antiDowngradeRefs: input.antiDowngradeRefs,
    servingRefs: {
      pending: null,
      egress: null,
      conflictIndex: null,
      evidenceIndex: null,
      receiptIndex: null,
      outboxIndex: null,
    },
    closureReceipt,
  }));
  const completionDigest = retentionDigest(asJson({
    domain: "revagent/gateway/session-gc-completion/v1",
    planDigest: input.closure.planDigest,
    ...counts,
    completedAtMs: input.completedAtMs,
    retiredAuthorityDigest,
  }));
  return Object.freeze({
    completedAtMs: input.completedAtMs,
    retiredAuthorityDigest,
    completionDigest,
    closureReceipt: asJson(closureReceipt),
    retiredBinding,
    retiredLifecycle,
    retiredSequenceHead,
  });
}
