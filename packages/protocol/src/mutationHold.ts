import { createHash } from "node:crypto";

import type { MutationScope, RecoveryClearance } from "./generated/envelope.js";
import {
  journalRecordIsIntact,
  type InvocationJournalRecord,
  type KnownTerminalJournalState,
} from "./journalState.js";
import { canonicalizeJson, type JsonValue } from "./paramsDigest.js";

export type MutationHoldState =
  | "active"
  | "evidence_recorded"
  | "resolved_pending_bridge"
  | "cleared";

export type HoldResolutionDecision = "non_execution_proven" | "postcondition_verified";
export type HoldEvidenceConclusion = HoldResolutionDecision | "inconclusive" | "failed" | "omitted" | "ambiguous";

export interface HoldEvidenceAttempt {
  readonly basis: "verification_read" | "late_terminal";
  readonly verificationInvocationId: string | null;
  readonly originIdempotencyKey: string | null;
  readonly evidenceDigest: string;
  readonly conclusion: HoldEvidenceConclusion;
  readonly journalBindingDigest: `sha256:${string}`;
  readonly journalOutcomeDigest: `sha256:${string}`;
  readonly terminalKind: "terminal" | "late_terminal";
  readonly terminalStatus: KnownTerminalJournalState;
}

export interface HoldResolution {
  readonly resolutionId: string;
  readonly basis: "verification_read" | "late_terminal";
  readonly verificationInvocationId: string | null;
  readonly evidenceDigest: string;
  readonly decision: HoldResolutionDecision;
  readonly auditId: string;
  /** Exact durable digest/identity of the one envelope this evidence authorizes. */
  readonly authorizedDispatchIdentity: string;
  readonly journalBindingDigest: `sha256:${string}`;
  readonly journalOutcomeDigest: `sha256:${string}`;
  readonly terminalKind: "terminal" | "late_terminal";
  readonly terminalStatus: KnownTerminalJournalState;
}

export interface MutationHold {
  readonly rsid: string;
  readonly mutationScope: MutationScope;
  readonly scopeKey: string;
  readonly holdId: `vh:${string}`;
  readonly originIdempotencyKeys: readonly string[];
  readonly state: MutationHoldState;
  readonly evidenceAttempts: readonly HoldEvidenceAttempt[];
  readonly selectedEvidence: HoldEvidenceAttempt | null;
  readonly resolution: HoldResolution | null;
  readonly clearedBy: string | null;
}

export interface MutationHoldLedger {
  readonly holds: readonly MutationHold[];
}

export interface UncertainMutation {
  readonly originIdempotencyKey: string;
  readonly mutationScope: MutationScope;
}

export type InstallMutationHoldsResult =
  | {
      readonly kind: "installed" | "already_present";
      readonly ledger: MutationHoldLedger;
      readonly holds: readonly MutationHold[];
    }
  | {
      readonly kind: "blocked";
      readonly ledger: MutationHoldLedger;
      readonly conflictingHolds: readonly MutationHold[];
    };

export type RecordHoldEvidenceResult =
  | {
      readonly kind: "recorded" | "inconclusive_recorded";
      readonly ledger: MutationHoldLedger;
      readonly hold: MutationHold;
    }
  | {
      readonly kind: "rejected";
      readonly ledger: MutationHoldLedger;
      readonly reason:
        | "foreign_hold"
        | "scope_mismatch"
        | "origin_mismatch"
        | "invalid_state"
        | "journal_binding_mismatch"
        | "journal_integrity_mismatch"
        | "journal_state_mismatch"
        | "evidence_digest_mismatch";
    };

export type ResolveMutationHoldResult =
  | { readonly kind: "resolved"; readonly ledger: MutationHoldLedger; readonly hold: MutationHold }
  | {
      readonly kind: "rejected";
      readonly ledger: MutationHoldLedger;
      readonly reason: "foreign_hold" | "invalid_state" | "evidence_mismatch" | "inconclusive_evidence";
    };

export type AuthorizeMutationResult =
  | {
      readonly kind: "allowed";
      readonly ledger: MutationHoldLedger;
      readonly clearedHoldIds: readonly string[];
    }
  | {
      readonly kind: "blocked";
      readonly ledger: MutationHoldLedger;
      readonly conflictingHolds: readonly MutationHold[];
    }
  | {
      readonly kind: "protocol_fault";
      readonly ledger: MutationHoldLedger;
      readonly reason:
        | "foreign_clearance"
        | "missing_clearance"
        | "unsorted_clearances"
        | "clearance_mismatch"
        | "clearance_not_ready";
    };

const digestPattern = /^sha256:[0-9a-f]{64}$/;

function normalizedScope(scope: MutationScope): JsonValue {
  return scope.kind === "session"
    ? { kind: "session" }
    : { document_id: scope.document_id, kind: "document" };
}

export function mutationScopeKey(scope: MutationScope): string {
  if (scope.kind === "document" && scope.document_id.length === 0) {
    throw new TypeError("document mutation scope requires document_id");
  }
  return canonicalizeJson(normalizedScope(scope));
}

export function mutationScopesConflict(left: MutationScope, right: MutationScope): boolean {
  return (
    left.kind === "session" ||
    right.kind === "session" ||
    left.document_id === right.document_id
  );
}

export function makeMutationHoldId(
  rsid: string,
  mutationScope: MutationScope,
  originIdempotencyKeys: readonly string[],
): `vh:${string}` {
  if (rsid.length === 0 || originIdempotencyKeys.length === 0) {
    throw new TypeError("rsid and at least one origin idempotency key are required");
  }
  if (new Set(originIdempotencyKeys).size !== originIdempotencyKeys.length) {
    throw new TypeError("origin idempotency keys must be unique and ordered");
  }
  for (const key of originIdempotencyKeys) {
    if (!key.startsWith(`${rsid}/`) || key.length === rsid.length + 1) {
      throw new TypeError("origin idempotency key must use the exact rsid/invocation_id form");
    }
  }
  const material = canonicalizeJson({
    mutation_scope: normalizedScope(mutationScope),
    origin_idempotency_keys: [...originIdempotencyKeys],
    rsid,
  });
  return `vh:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

export function createMutationHoldLedger(): MutationHoldLedger {
  return { holds: [] };
}

function isUncleared(hold: MutationHold): boolean {
  return hold.state !== "cleared";
}

export function conflictingMutationHolds(
  ledger: MutationHoldLedger,
  rsid: string,
  mutationScopes: readonly MutationScope[],
): readonly MutationHold[] {
  return ledger.holds
    .filter(
      (hold) =>
        isUncleared(hold) &&
        hold.rsid === rsid &&
        mutationScopes.some((scope) => mutationScopesConflict(hold.mutationScope, scope)),
    )
    .sort((left, right) => (left.holdId < right.holdId ? -1 : left.holdId > right.holdId ? 1 : 0));
}

function candidateHolds(rsid: string, uncertain: readonly UncertainMutation[]): readonly MutationHold[] {
  if (uncertain.length === 0) {
    throw new TypeError("at least one uncertain mutation is required");
  }
  const origins = uncertain.map((entry) => entry.originIdempotencyKey);
  if (new Set(origins).size !== origins.length) {
    throw new TypeError("uncertain mutation origin keys must be unique");
  }

  const scopesWithOrigins: Array<{
    scope: MutationScope;
    origins: string[];
  }> = [];
  if (uncertain.some((entry) => entry.mutationScope.kind === "session")) {
    scopesWithOrigins.push({ scope: { kind: "session" }, origins });
  } else {
    for (const entry of uncertain) {
      const scopeKey = mutationScopeKey(entry.mutationScope);
      const group = scopesWithOrigins.find((candidate) => mutationScopeKey(candidate.scope) === scopeKey);
      if (group === undefined) {
        scopesWithOrigins.push({ scope: structuredClone(entry.mutationScope), origins: [entry.originIdempotencyKey] });
      } else {
        group.origins.push(entry.originIdempotencyKey);
      }
    }
  }

  return scopesWithOrigins.map(({ scope, origins: groupOrigins }) => ({
    rsid,
    mutationScope: scope,
    scopeKey: mutationScopeKey(scope),
    holdId: makeMutationHoldId(rsid, scope, groupOrigins),
    originIdempotencyKeys: [...groupOrigins],
    state: "active",
    evidenceAttempts: [],
    selectedEvidence: null,
    resolution: null,
    clearedBy: null,
  }));
}

export function installMutationHolds(
  ledger: MutationHoldLedger,
  rsid: string,
  uncertain: readonly UncertainMutation[],
): InstallMutationHoldsResult {
  const candidates = candidateHolds(rsid, uncertain);
  const exactExisting = candidates.map((candidate) =>
    ledger.holds.find(
      (hold) => isUncleared(hold) && hold.holdId === candidate.holdId && hold.scopeKey === candidate.scopeKey,
    ),
  );
  if (exactExisting.every((hold) => hold !== undefined)) {
    return {
      kind: "already_present",
      ledger,
      holds: exactExisting.filter((hold): hold is MutationHold => hold !== undefined),
    };
  }

  const conflicts = candidates.flatMap((candidate) =>
    conflictingMutationHolds(ledger, rsid, [candidate.mutationScope]),
  );
  const uniqueConflicts = [...new Map(conflicts.map((hold) => [hold.holdId, hold])).values()];
  if (uniqueConflicts.length > 0) {
    return { kind: "blocked", ledger, conflictingHolds: uniqueConflicts };
  }

  const holds = [...ledger.holds, ...candidates].sort((left, right) =>
    left.holdId < right.holdId ? -1 : left.holdId > right.holdId ? 1 : 0,
  );
  return { kind: "installed", ledger: { holds }, holds: candidates };
}

function updateHold(
  ledger: MutationHoldLedger,
  updated: MutationHold,
): MutationHoldLedger {
  return {
    holds: ledger.holds.map((hold) => (hold.holdId === updated.holdId ? updated : hold)),
  };
}

function findExactHold(
  ledger: MutationHoldLedger,
  rsid: string,
  holdId: string,
): MutationHold | undefined {
  return ledger.holds.find((hold) => hold.rsid === rsid && hold.holdId === holdId);
}

function assertEvidenceDigest(evidenceDigest: string): void {
  if (!digestPattern.test(evidenceDigest)) {
    throw new TypeError("evidenceDigest must be sha256 plus 64 lowercase hexadecimal characters");
  }
}

function attestedTerminalOutcome(
  record: InvocationJournalRecord,
): {
  readonly status: KnownTerminalJournalState;
  readonly resultDigest: string;
  readonly outcomeDigest: `sha256:${string}`;
} | null {
  const outcome = record.terminalOutcome;
  if (
    outcome === null ||
    record.lateTerminalOutcome !== null ||
    record.state !== outcome.status ||
    record.terminalOutcomeDigest === null ||
    outcome.resultDigest === undefined ||
    !digestPattern.test(outcome.resultDigest)
  ) {
    return null;
  }
  return {
    status: outcome.status,
    resultDigest: outcome.resultDigest,
    outcomeDigest: record.terminalOutcomeDigest,
  };
}

function attestedLateTerminalOutcome(
  record: InvocationJournalRecord,
): {
  readonly status: KnownTerminalJournalState;
  readonly resultDigest: string;
  readonly outcomeDigest: `sha256:${string}`;
} | null {
  const outcome = record.lateTerminalOutcome;
  if (
    outcome === null ||
    record.terminalOutcome !== null ||
    record.state !== "indeterminate" ||
    record.lateTerminalOutcomeDigest === null ||
    outcome.resultDigest === undefined ||
    !digestPattern.test(outcome.resultDigest)
  ) {
    return null;
  }
  return {
    status: outcome.status,
    resultDigest: outcome.resultDigest,
    outcomeDigest: record.lateTerminalOutcomeDigest,
  };
}

export function recordVerificationEvidence(
  ledger: MutationHoldLedger,
  input: {
    readonly rsid: string;
    readonly holdId: string;
    readonly mutationScope: MutationScope;
    readonly verificationInvocationId: string;
    readonly evidenceDigest: string;
    readonly conclusion: HoldEvidenceConclusion;
    readonly journalRecord: InvocationJournalRecord;
  },
): RecordHoldEvidenceResult {
  assertEvidenceDigest(input.evidenceDigest);
  if (input.verificationInvocationId.length === 0) {
    throw new TypeError("verificationInvocationId must not be empty");
  }
  const hold = findExactHold(ledger, input.rsid, input.holdId);
  if (hold === undefined) {
    return { kind: "rejected", ledger, reason: "foreign_hold" };
  }
  if (hold.scopeKey !== mutationScopeKey(input.mutationScope)) {
    return { kind: "rejected", ledger, reason: "scope_mismatch" };
  }
  if (hold.state === "resolved_pending_bridge" || hold.state === "cleared") {
    return { kind: "rejected", ledger, reason: "invalid_state" };
  }

  const journal = input.journalRecord;
  if (!journalRecordIsIntact(journal)) {
    return { kind: "rejected", ledger, reason: "journal_integrity_mismatch" };
  }
  const verification = journal.binding.verification;
  if (
    journal.binding.rsid !== input.rsid ||
    journal.binding.invocationId !== input.verificationInvocationId ||
    journal.binding.mutating ||
    journal.binding.mutationScope !== null ||
    journal.verificationHoldId !== null ||
    verification == null ||
    verification.hold_id !== input.holdId ||
    verification.purpose !== "resolve_indeterminate"
  ) {
    return { kind: "rejected", ledger, reason: "journal_binding_mismatch" };
  }
  if (mutationScopeKey(verification.mutation_scope) !== hold.scopeKey) {
    return { kind: "rejected", ledger, reason: "scope_mismatch" };
  }
  const terminal = attestedTerminalOutcome(journal);
  if (terminal === null) {
    return { kind: "rejected", ledger, reason: "journal_state_mismatch" };
  }
  if (terminal.resultDigest !== input.evidenceDigest) {
    return { kind: "rejected", ledger, reason: "evidence_digest_mismatch" };
  }

  const attempt: HoldEvidenceAttempt = {
    basis: "verification_read",
    verificationInvocationId: journal.binding.invocationId,
    originIdempotencyKey: null,
    evidenceDigest: terminal.resultDigest,
    conclusion: input.conclusion,
    journalBindingDigest: journal.bindingDigest,
    journalOutcomeDigest: terminal.outcomeDigest,
    terminalKind: "terminal",
    terminalStatus: terminal.status,
  };
  const conclusive =
    input.conclusion === "non_execution_proven" || input.conclusion === "postcondition_verified";
  const updated: MutationHold = {
    ...hold,
    state: conclusive ? "evidence_recorded" : hold.state,
    evidenceAttempts: [...hold.evidenceAttempts, attempt],
    selectedEvidence: conclusive ? attempt : hold.selectedEvidence,
  };
  const next = updateHold(ledger, updated);
  return {
    kind: conclusive ? "recorded" : "inconclusive_recorded",
    ledger: next,
    hold: updated,
  };
}

export function recordLateTerminalEvidence(
  ledger: MutationHoldLedger,
  input: {
    readonly rsid: string;
    readonly holdId: string;
    readonly originIdempotencyKey: string;
    readonly evidenceDigest: string;
    readonly conclusion: HoldEvidenceConclusion;
    readonly journalRecord: InvocationJournalRecord;
  },
): RecordHoldEvidenceResult {
  assertEvidenceDigest(input.evidenceDigest);
  const hold = findExactHold(ledger, input.rsid, input.holdId);
  if (hold === undefined) {
    return { kind: "rejected", ledger, reason: "foreign_hold" };
  }
  if (!hold.originIdempotencyKeys.includes(input.originIdempotencyKey)) {
    return { kind: "rejected", ledger, reason: "origin_mismatch" };
  }
  if (hold.state === "resolved_pending_bridge" || hold.state === "cleared") {
    return { kind: "rejected", ledger, reason: "invalid_state" };
  }

  const journal = input.journalRecord;
  if (!journalRecordIsIntact(journal)) {
    return { kind: "rejected", ledger, reason: "journal_integrity_mismatch" };
  }
  const journalOriginKey = `${journal.binding.rsid}/${journal.binding.invocationId}`;
  if (
    journal.binding.rsid !== input.rsid ||
    journalOriginKey !== input.originIdempotencyKey ||
    !journal.binding.mutating ||
    journal.binding.mutationScope === null ||
    journal.binding.verification != null ||
    journal.verificationHoldId !== input.holdId
  ) {
    return { kind: "rejected", ledger, reason: "journal_binding_mismatch" };
  }
  if (mutationScopeKey(journal.binding.mutationScope) !== hold.scopeKey) {
    return { kind: "rejected", ledger, reason: "scope_mismatch" };
  }
  const terminal = attestedLateTerminalOutcome(journal);
  if (terminal === null) {
    return { kind: "rejected", ledger, reason: "journal_state_mismatch" };
  }
  if (terminal.resultDigest !== input.evidenceDigest) {
    return { kind: "rejected", ledger, reason: "evidence_digest_mismatch" };
  }

  const attempt: HoldEvidenceAttempt = {
    basis: "late_terminal",
    verificationInvocationId: null,
    originIdempotencyKey: journalOriginKey,
    evidenceDigest: terminal.resultDigest,
    conclusion: input.conclusion,
    journalBindingDigest: journal.bindingDigest,
    journalOutcomeDigest: terminal.outcomeDigest,
    terminalKind: "late_terminal",
    terminalStatus: terminal.status,
  };
  const conclusive =
    input.conclusion === "non_execution_proven" || input.conclusion === "postcondition_verified";
  const updated: MutationHold = {
    ...hold,
    state: conclusive ? "evidence_recorded" : hold.state,
    evidenceAttempts: [...hold.evidenceAttempts, attempt],
    selectedEvidence: conclusive ? attempt : hold.selectedEvidence,
  };
  const next = updateHold(ledger, updated);
  return {
    kind: conclusive ? "recorded" : "inconclusive_recorded",
    ledger: next,
    hold: updated,
  };
}

export function resolveMutationHold(
  ledger: MutationHoldLedger,
  input: {
    readonly rsid: string;
    readonly holdId: string;
    readonly basis: "verification_read" | "late_terminal";
    readonly verificationInvocationId: string | null;
    readonly evidenceDigest: string;
    readonly decision: HoldResolutionDecision;
    readonly resolutionId: string;
    readonly auditId: string;
    /** Exact durable digest/identity of the complete invoke or batch envelope. */
    readonly authorizedDispatchIdentity: string;
  },
): ResolveMutationHoldResult {
  if (input.authorizedDispatchIdentity.length === 0) {
    throw new TypeError("authorizedDispatchIdentity must not be empty");
  }
  const hold = findExactHold(ledger, input.rsid, input.holdId);
  if (hold === undefined) {
    return { kind: "rejected", ledger, reason: "foreign_hold" };
  }
  if (hold.state !== "evidence_recorded" || hold.selectedEvidence === null) {
    return {
      kind: "rejected",
      ledger,
      reason: hold.selectedEvidence?.conclusion === "inconclusive" ? "inconclusive_evidence" : "invalid_state",
    };
  }
  const evidence = hold.selectedEvidence;
  if (
    evidence.basis !== input.basis ||
    evidence.verificationInvocationId !== input.verificationInvocationId ||
    evidence.evidenceDigest !== input.evidenceDigest ||
    evidence.conclusion !== input.decision
  ) {
    return { kind: "rejected", ledger, reason: "evidence_mismatch" };
  }

  const resolution: HoldResolution = {
    resolutionId: input.resolutionId,
    basis: evidence.basis,
    verificationInvocationId: evidence.verificationInvocationId,
    evidenceDigest: evidence.evidenceDigest,
    decision: input.decision,
    auditId: input.auditId,
    authorizedDispatchIdentity: input.authorizedDispatchIdentity,
    journalBindingDigest: evidence.journalBindingDigest,
    journalOutcomeDigest: evidence.journalOutcomeDigest,
    terminalKind: evidence.terminalKind,
    terminalStatus: evidence.terminalStatus,
  };
  const updated: MutationHold = { ...hold, state: "resolved_pending_bridge", resolution };
  const next = updateHold(ledger, updated);
  return { kind: "resolved", ledger: next, hold: updated };
}

function resolutionMatchesSelectedEvidence(hold: MutationHold): boolean {
  const evidence = hold.selectedEvidence;
  const resolution = hold.resolution;
  return (
    resolution !== null &&
    evidence !== null &&
    evidence.basis === resolution.basis &&
    evidence.verificationInvocationId === resolution.verificationInvocationId &&
    evidence.evidenceDigest === resolution.evidenceDigest &&
    evidence.conclusion === resolution.decision &&
    evidence.journalBindingDigest === resolution.journalBindingDigest &&
    evidence.journalOutcomeDigest === resolution.journalOutcomeDigest &&
    evidence.terminalKind === resolution.terminalKind &&
    evidence.terminalStatus === resolution.terminalStatus
  );
}

export function recoveryClearanceForHold(hold: MutationHold): RecoveryClearance {
  const evidence = hold.selectedEvidence;
  const resolution = hold.resolution;
  if (hold.state !== "resolved_pending_bridge" || resolution === null || evidence === null) {
    throw new Error("hold is not ready for bridge clearance");
  }
  if (!resolutionMatchesSelectedEvidence(hold)) {
    throw new Error("hold resolution is not bound to its journal-attested evidence");
  }
  return {
    hold_id: hold.holdId,
    mutation_scope: structuredClone(hold.mutationScope),
    resolution_id: resolution.resolutionId,
    basis: evidence.basis,
    verification_invocation_id: evidence.verificationInvocationId,
    evidence_digest: evidence.evidenceDigest,
    decision: resolution.decision,
    audit_id: resolution.auditId,
  } as RecoveryClearance;
}

function clearanceMatches(hold: MutationHold, clearance: RecoveryClearance): boolean {
  if (hold.resolution === null || !resolutionMatchesSelectedEvidence(hold)) {
    return false;
  }
  return (
    clearance.hold_id === hold.holdId &&
    mutationScopeKey(clearance.mutation_scope) === hold.scopeKey &&
    clearance.resolution_id === hold.resolution.resolutionId &&
    clearance.basis === hold.resolution.basis &&
    clearance.verification_invocation_id === hold.resolution.verificationInvocationId &&
    clearance.evidence_digest === hold.resolution.evidenceDigest &&
    clearance.decision === hold.resolution.decision &&
    clearance.audit_id === hold.resolution.auditId
  );
}

/**
 * Atomically checks all conflicting holds and consumes exactly matching, sorted,
 * evidence-bound clearances for one accepted mutation envelope or batch.
 */
export function authorizeMutationDispatch(
  ledger: MutationHoldLedger,
  input: {
    readonly rsid: string;
    readonly mutationScopes: readonly MutationScope[];
    readonly recoveryClearances: readonly RecoveryClearance[];
    /** Exact durable digest/identity of the complete accepted invoke or batch envelope. */
    readonly dispatchIdentity: string;
  },
): AuthorizeMutationResult {
  if (input.mutationScopes.length === 0 || input.dispatchIdentity.length === 0) {
    throw new TypeError("mutationScopes and dispatchIdentity are required");
  }
  for (const scope of input.mutationScopes) {
    mutationScopeKey(scope);
  }
  const sortedIds = input.recoveryClearances.map((clearance) => clearance.hold_id);
  if (sortedIds.some((id, index) => index > 0 && (sortedIds[index - 1] ?? "") >= id)) {
    return { kind: "protocol_fault", ledger, reason: "unsorted_clearances" };
  }

  const conflicts = conflictingMutationHolds(ledger, input.rsid, input.mutationScopes);
  if (conflicts.length === 0) {
    if (input.recoveryClearances.length === 0) {
      return { kind: "allowed", ledger, clearedHoldIds: [] };
    }
    const duplicateHolds = input.recoveryClearances.map((clearance) =>
      ledger.holds.find(
        (hold) =>
          hold.state === "cleared" &&
          hold.rsid === input.rsid &&
          hold.holdId === clearance.hold_id &&
          hold.clearedBy === input.dispatchIdentity &&
          input.mutationScopes.some((scope) =>
            mutationScopesConflict(hold.mutationScope, scope),
          ) &&
          clearanceMatches(hold, clearance),
      ),
    );
    if (duplicateHolds.every((hold) => hold !== undefined)) {
      return {
        kind: "allowed",
        ledger,
        clearedHoldIds: duplicateHolds.map((hold) => hold?.holdId ?? ""),
      };
    }
    return { kind: "protocol_fault", ledger, reason: "foreign_clearance" };
  }
  if (input.recoveryClearances.length === 0) {
    return { kind: "blocked", ledger, conflictingHolds: conflicts };
  }
  if (input.recoveryClearances.length !== conflicts.length) {
    return { kind: "protocol_fault", ledger, reason: "missing_clearance" };
  }
  if (conflicts.some((hold) => hold.state !== "resolved_pending_bridge")) {
    return { kind: "protocol_fault", ledger, reason: "clearance_not_ready" };
  }
  for (let index = 0; index < conflicts.length; index += 1) {
    const hold = conflicts[index];
    const clearance = input.recoveryClearances[index];
    if (
      hold === undefined ||
      clearance === undefined ||
      hold.resolution?.authorizedDispatchIdentity !== input.dispatchIdentity ||
      !clearanceMatches(hold, clearance)
    ) {
      return { kind: "protocol_fault", ledger, reason: "clearance_mismatch" };
    }
  }

  const clearedIds = new Set(conflicts.map((hold) => hold.holdId));
  const holds = ledger.holds.map((hold) =>
    clearedIds.has(hold.holdId)
      ? { ...hold, state: "cleared" as const, clearedBy: input.dispatchIdentity }
      : hold,
  );
  return { kind: "allowed", ledger: { holds }, clearedHoldIds: [...clearedIds] };
}

/** Origin redelivery is exempt from its own active hold; a fresh id is never exempt. */
export function isOriginRedeliveryExempt(
  ledger: MutationHoldLedger,
  rsid: string,
  idempotencyKey: string,
): boolean {
  return ledger.holds.some(
    (hold) =>
      hold.rsid === rsid &&
      isUncleared(hold) &&
      hold.originIdempotencyKeys.includes(idempotencyKey),
  );
}
