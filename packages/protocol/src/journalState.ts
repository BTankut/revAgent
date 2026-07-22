import { createHash } from "node:crypto";

import type { MutationScope, RecoveryClearance, Verification } from "./generated/envelope.js";
import { canonicalizeJson, type JsonValue } from "./paramsDigest.js";

export type InvocationJournalState =
  | "received"
  | "executing"
  | "completed"
  | "failed"
  | "guarded"
  | "cancelled"
  | "indeterminate";

export type KnownTerminalJournalState = Exclude<
  InvocationJournalState,
  "received" | "executing" | "indeterminate"
>;

export interface JournalPolicyBinding {
  readonly class: "auto" | "confirm" | "gated";
  readonly decision: "auto" | "confirmed" | "gated_approved";
  readonly confirmation_id: string | null;
}

export interface InvocationJournalBinding {
  readonly rsid: string;
  readonly invocationId: string;
  readonly method: string;
  readonly mutating: boolean;
  readonly mutationScope: MutationScope | null;
  readonly paramsDigest: string;
  readonly policy: JournalPolicyBinding;
  /** Present on an ordinary invoke and non-null only for a hold-correlated read. */
  readonly verification?: Verification | null;
  readonly recoveryClearances?: readonly RecoveryClearance[];
  readonly batchId?: string;
  readonly batchIndex?: number;
  readonly batchDigest?: string;
}

export interface TerminalJournalOutcome {
  readonly status: KnownTerminalJournalState;
  readonly resultDigest?: string;
  readonly guardedReason?: string;
  readonly payloadRetained: boolean;
  readonly payload?: JsonValue;
}

export interface InvocationJournalRecord {
  readonly binding: InvocationJournalBinding;
  readonly bindingDigest: `sha256:${string}`;
  readonly state: InvocationJournalState;
  readonly dispatchMayHaveStarted: boolean;
  readonly readRecoveryConsumed: boolean;
  readonly abandoned: boolean;
  readonly terminalOutcome: TerminalJournalOutcome | null;
  /** Digest of the complete immutable terminal outcome snapshot. */
  readonly terminalOutcomeDigest: `sha256:${string}` | null;
  /** A real outcome retained after the original classification became indeterminate. */
  readonly lateTerminalOutcome: TerminalJournalOutcome | null;
  /** Digest of the complete immutable late-terminal outcome snapshot. */
  readonly lateTerminalOutcomeDigest: `sha256:${string}` | null;
  readonly verificationHoldId: string | null;
}

export type JournalRedeliveryDecision =
  | {
      readonly kind: "protocol_fault";
      readonly record: InvocationJournalRecord;
      readonly reason: "binding_mismatch" | "journal_integrity_mismatch";
    }
  | {
      readonly kind: "replay_terminal";
      readonly record: InvocationJournalRecord;
      readonly outcome: TerminalJournalOutcome;
    }
  | {
      readonly kind: "replay_late_terminal";
      readonly record: InvocationJournalRecord;
      readonly outcome: TerminalJournalOutcome;
      readonly verificationHoldId: string;
    }
  | {
      readonly kind: "return_indeterminate";
      readonly record: InvocationJournalRecord;
      readonly verificationHoldId: string | null;
    }
  | {
      readonly kind: "reexecute_read";
      readonly record: InvocationJournalRecord;
    }
  | {
      readonly kind: "read_recovery_already_consumed";
      readonly record: InvocationJournalRecord;
    }
  | {
      readonly kind: "promote_mutation_indeterminate";
      readonly record: InvocationJournalRecord;
    };

export type CancellationDecision =
  | {
      readonly kind: "cancelled_before_dispatch";
      readonly record: InvocationJournalRecord;
    }
  | {
      readonly kind: "await_real_outcome";
      readonly record: InvocationJournalRecord;
    }
  | {
      readonly kind: "already_terminal";
      readonly record: InvocationJournalRecord;
    };

export type UnregisterJournalDecision =
  | {
      readonly kind: "unchanged_terminal";
      readonly record: InvocationJournalRecord;
    }
  | {
      readonly kind: "known_addin_unreachable";
      readonly record: InvocationJournalRecord;
    }
  | {
      readonly kind: "mutation_indeterminate";
      readonly record: InvocationJournalRecord;
      readonly requiresHold: true;
    };

export type BatchStepStatus =
  | "completed"
  | "guarded"
  | "failed"
  | "cancelled"
  | "indeterminate"
  | "not_started";

export interface AtomicFalseBatchPlanStep {
  readonly index: number;
  readonly invocationId: string;
  readonly action: "replay" | "execute_read" | "return_indeterminate" | "wait" | "not_started";
  readonly status: BatchStepStatus | "pending";
}

export interface AtomicFalseBatchPlan {
  readonly kind: "planned";
  readonly steps: readonly AtomicFalseBatchPlanStep[];
  readonly failedStepIndex: number | null;
  readonly replayed: boolean;
  readonly records: readonly InvocationJournalRecord[];
}

export interface BatchIdentityFault {
  readonly kind: "protocol_fault";
  readonly reason: "batch_binding_mismatch";
  readonly records: readonly InvocationJournalRecord[];
}

export type AtomicFalseBatchPlanResult = AtomicFalseBatchPlan | BatchIdentityFault;

export interface AtomicBatchBinding {
  readonly batchId: string;
  readonly batchDigest: string;
  readonly orderedStepBindingDigests: readonly string[];
}

export interface AtomicBatchJournalRecord {
  readonly binding: AtomicBatchBinding;
  readonly state: "received" | "dispatched" | "terminal" | "indeterminate";
  readonly dispatchMayHaveStarted: boolean;
  readonly terminalDigest: string | null;
}

export type AtomicBatchRedeliveryDecision =
  | { readonly kind: "replay_terminal"; readonly record: AtomicBatchJournalRecord }
  | { readonly kind: "execute_atomic"; readonly record: AtomicBatchJournalRecord }
  | { readonly kind: "return_indeterminate"; readonly record: AtomicBatchJournalRecord }
  | {
      readonly kind: "protocol_fault";
      readonly record: AtomicBatchJournalRecord;
      readonly reason: "batch_binding_mismatch";
    };

function normalizeScope(scope: MutationScope | null): JsonValue {
  if (scope === null) {
    return null;
  }
  return scope.kind === "session"
    ? { kind: "session" }
    : { document_id: scope.document_id, kind: "document" };
}

function normalizeClearance(clearance: RecoveryClearance): JsonValue {
  return {
    audit_id: clearance.audit_id,
    basis: clearance.basis,
    decision: clearance.decision,
    evidence_digest: clearance.evidence_digest,
    hold_id: clearance.hold_id,
    mutation_scope: normalizeScope(clearance.mutation_scope),
    resolution_id: clearance.resolution_id,
    verification_invocation_id: clearance.verification_invocation_id,
  };
}

function normalizedBinding(binding: InvocationJournalBinding): JsonValue {
  return {
    batch_digest: binding.batchDigest ?? null,
    batch_id: binding.batchId ?? null,
    batch_index: binding.batchIndex ?? null,
    invocation_id: binding.invocationId,
    method: binding.method,
    mutating: binding.mutating,
    mutation_scope: normalizeScope(binding.mutationScope),
    params_digest: binding.paramsDigest,
    policy: {
      class: binding.policy.class,
      confirmation_id: binding.policy.confirmation_id,
      decision: binding.policy.decision,
    },
    recovery_clearances: (binding.recoveryClearances ?? []).map(normalizeClearance),
    rsid: binding.rsid,
    verification:
      binding.verification == null
        ? null
        : {
            hold_id: binding.verification.hold_id,
            mutation_scope: normalizeScope(binding.verification.mutation_scope),
            purpose: binding.verification.purpose,
          },
  };
}

export function makeJournalBindingDigest(
  binding: InvocationJournalBinding,
): `sha256:${string}` {
  const canonical = canonicalizeJson(normalizedBinding(binding));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function assertBinding(binding: InvocationJournalBinding): void {
  if (binding.rsid.length === 0 || binding.invocationId.length === 0 || binding.method.length === 0) {
    throw new TypeError("rsid, invocationId, and method are required");
  }
  if (binding.mutating !== (binding.mutationScope !== null)) {
    throw new TypeError("mutationScope must be non-null exactly when mutating is true");
  }
  if (binding.mutating && binding.verification != null) {
    throw new TypeError("a mutating invocation cannot carry verification correlation");
  }
  if (!binding.mutating && (binding.recoveryClearances?.length ?? 0) > 0) {
    throw new TypeError("a read invocation cannot carry recovery clearances");
  }
  if (binding.verification != null) {
    if (
      binding.verification.hold_id.length === 0 ||
      binding.verification.purpose !== "resolve_indeterminate"
    ) {
      throw new TypeError("verification correlation is incomplete");
    }
    normalizeScope(binding.verification.mutation_scope);
  }
  if (
    binding.batchIndex !== undefined &&
    (!Number.isSafeInteger(binding.batchIndex) || binding.batchIndex < 0)
  ) {
    throw new RangeError("batchIndex must be a non-negative safe integer");
  }
}

export function createReceivedJournalRecord(
  binding: InvocationJournalBinding,
): InvocationJournalRecord {
  assertBinding(binding);
  const snapshot = structuredClone(binding);
  return {
    binding: snapshot,
    bindingDigest: makeJournalBindingDigest(snapshot),
    state: "received",
    dispatchMayHaveStarted: false,
    readRecoveryConsumed: false,
    abandoned: false,
    terminalOutcome: null,
    terminalOutcomeDigest: null,
    lateTerminalOutcome: null,
    lateTerminalOutcomeDigest: null,
    verificationHoldId: null,
  };
}

export function markJournalExecuting(record: InvocationJournalRecord): InvocationJournalRecord {
  if (record.state !== "received") {
    throw new Error(`cannot start invocation from ${record.state}`);
  }
  return { ...record, state: "executing", dispatchMayHaveStarted: true };
}

function validateTerminalOutcome(outcome: TerminalJournalOutcome): void {
  if (outcome.status === "guarded") {
    if (outcome.guardedReason === undefined || !/^[a-z][a-z0-9_]{0,63}$/.test(outcome.guardedReason)) {
      throw new TypeError("guarded terminal outcome requires a valid guardedReason");
    }
  } else if (outcome.guardedReason !== undefined) {
    throw new TypeError("guardedReason is legal only for a guarded outcome");
  }
  const hasPayload = Object.hasOwn(outcome, "payload");
  if (outcome.payloadRetained && (!hasPayload || outcome.payload === undefined)) {
    throw new TypeError("a retained terminal payload must be present");
  }
  if (!outcome.payloadRetained && hasPayload) {
    throw new TypeError("an omitted terminal payload cannot retain payload bytes");
  }
  if (!outcome.payloadRetained && outcome.resultDigest === undefined) {
    throw new TypeError("an omitted terminal payload requires resultDigest");
  }
  if (outcome.resultDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(outcome.resultDigest)) {
    throw new TypeError("resultDigest must be sha256 plus 64 lowercase hexadecimal characters");
  }
}

function terminalOutcomeIdentity(outcome: TerminalJournalOutcome): string {
  return canonicalizeJson({
    guarded_reason: outcome.guardedReason ?? null,
    payload: Object.hasOwn(outcome, "payload") ? (outcome.payload ?? null) : null,
    payload_present: Object.hasOwn(outcome, "payload"),
    payload_retained: outcome.payloadRetained,
    result_digest: outcome.resultDigest ?? null,
    status: outcome.status,
  });
}

export function makeJournalTerminalOutcomeDigest(
  outcome: TerminalJournalOutcome,
): `sha256:${string}` {
  const canonical = terminalOutcomeIdentity(outcome);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function journalRecordIsIntact(record: InvocationJournalRecord): boolean {
  try {
    if (makeJournalBindingDigest(record.binding) !== record.bindingDigest) {
      return false;
    }
    if (record.terminalOutcome === null) {
      if (record.terminalOutcomeDigest !== null) return false;
    } else {
      validateTerminalOutcome(record.terminalOutcome);
      if (
        record.state !== record.terminalOutcome.status ||
        record.terminalOutcomeDigest !== makeJournalTerminalOutcomeDigest(record.terminalOutcome) ||
        record.lateTerminalOutcome !== null ||
        record.lateTerminalOutcomeDigest !== null ||
        (record.binding.verification != null && record.terminalOutcome.resultDigest === undefined)
      ) {
        return false;
      }
    }
    if (record.lateTerminalOutcome === null) {
      if (record.lateTerminalOutcomeDigest !== null) return false;
    } else {
      validateTerminalOutcome(record.lateTerminalOutcome);
      if (
        record.state !== "indeterminate" ||
        record.terminalOutcome !== null ||
        record.terminalOutcomeDigest !== null ||
        record.lateTerminalOutcome.resultDigest === undefined ||
        record.lateTerminalOutcomeDigest !==
          makeJournalTerminalOutcomeDigest(record.lateTerminalOutcome)
      ) {
        return false;
      }
    }
    const terminalState =
      record.state === "completed" ||
      record.state === "failed" ||
      record.state === "guarded" ||
      record.state === "cancelled";
    return !terminalState || record.terminalOutcome !== null;
  } catch {
    return false;
  }
}

function digestTerminalPayload(payload: JsonValue): `sha256:${string}` {
  const canonical = canonicalizeJson(payload);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function recordJournalTerminal(
  record: InvocationJournalRecord,
  outcome: TerminalJournalOutcome,
): InvocationJournalRecord {
  if (!journalRecordIsIntact(record)) {
    throw new Error("journal integrity mismatch");
  }
  validateTerminalOutcome(outcome);
  if (record.binding.verification != null && outcome.resultDigest === undefined) {
    throw new TypeError("a hold-correlated verification terminal requires resultDigest");
  }
  const snapshot = structuredClone(outcome);
  const snapshotDigest = makeJournalTerminalOutcomeDigest(snapshot);
  if (record.state === "indeterminate") {
    if (outcome.resultDigest === undefined) {
      throw new TypeError("a late-after-indeterminate outcome requires resultDigest");
    }
    if (record.lateTerminalOutcome !== null) {
      if (
        record.lateTerminalOutcomeDigest !==
        makeJournalTerminalOutcomeDigest(record.lateTerminalOutcome)
      ) {
        throw new Error("late terminal journal integrity mismatch");
      }
      if (record.lateTerminalOutcomeDigest === snapshotDigest) {
        return record;
      }
      throw new Error("conflicting late terminal outcome");
    }
    return {
      ...record,
      lateTerminalOutcome: snapshot,
      lateTerminalOutcomeDigest: snapshotDigest,
    };
  }
  if (record.terminalOutcome !== null) {
    if (
      record.terminalOutcomeDigest !== makeJournalTerminalOutcomeDigest(record.terminalOutcome)
    ) {
      throw new Error("terminal journal integrity mismatch");
    }
    if (record.terminalOutcomeDigest === snapshotDigest) {
      return record;
    }
    throw new Error("conflicting terminal outcome");
  }
  if (record.lateTerminalOutcome !== null) {
    throw new Error("journal already has late terminal evidence");
  }
  if (record.state !== "received" && record.state !== "executing") {
    throw new Error(`cannot record a terminal outcome from ${record.state}`);
  }
  return {
    ...record,
    state: outcome.status,
    terminalOutcome: snapshot,
    terminalOutcomeDigest: snapshotDigest,
  };
}

export function markJournalIndeterminate(
  record: InvocationJournalRecord,
  verificationHoldId: string | null,
): InvocationJournalRecord {
  if (record.state !== "received" && record.state !== "executing") {
    throw new Error(`cannot mark ${record.state} indeterminate`);
  }
  if (record.binding.mutating && verificationHoldId === null) {
    throw new TypeError("a mutating indeterminate row requires verificationHoldId");
  }
  if (!record.binding.mutating && verificationHoldId !== null) {
    throw new TypeError("a non-mutating indeterminate row cannot carry verificationHoldId");
  }
  return { ...record, state: "indeterminate", verificationHoldId };
}

export function decideJournalRedelivery(
  record: InvocationJournalRecord,
  incoming: InvocationJournalBinding,
  verificationHoldIdForPromotion: string | null = null,
): JournalRedeliveryDecision {
  assertBinding(incoming);
  if (!journalRecordIsIntact(record)) {
    return { kind: "protocol_fault", record, reason: "journal_integrity_mismatch" };
  }
  if (makeJournalBindingDigest(incoming) !== record.bindingDigest) {
    return { kind: "protocol_fault", record, reason: "binding_mismatch" };
  }

  if (record.terminalOutcome !== null) {
    return { kind: "replay_terminal", record, outcome: record.terminalOutcome };
  }
  if (record.lateTerminalOutcome !== null) {
    if (record.verificationHoldId === null) {
      throw new Error("late terminal evidence is missing its verification hold id");
    }
    return {
      kind: "replay_late_terminal",
      record,
      outcome: record.lateTerminalOutcome,
      verificationHoldId: record.verificationHoldId,
    };
  }
  if (record.state === "indeterminate") {
    return {
      kind: "return_indeterminate",
      record,
      verificationHoldId: record.verificationHoldId,
    };
  }
  if (record.binding.mutating) {
    if (verificationHoldIdForPromotion === null) {
      throw new TypeError("mutating redelivery promotion requires a verification hold id");
    }
    const promoted = markJournalIndeterminate(record, verificationHoldIdForPromotion);
    return { kind: "promote_mutation_indeterminate", record: promoted };
  }
  if (record.readRecoveryConsumed) {
    return { kind: "read_recovery_already_consumed", record };
  }
  return {
    kind: "reexecute_read",
    record: {
      ...record,
      state: "executing",
      dispatchMayHaveStarted: true,
      readRecoveryConsumed: true,
    },
  };
}

export function requestJournalCancellation(
  record: InvocationJournalRecord,
): CancellationDecision {
  if (record.terminalOutcome !== null || record.state === "indeterminate") {
    return { kind: "already_terminal", record };
  }
  if (record.state === "received" && !record.dispatchMayHaveStarted) {
    const payload: JsonValue = { cancellation: "before_dispatch" };
    const cancelled = recordJournalTerminal(record, {
      status: "cancelled",
      payloadRetained: true,
      payload,
      ...(record.binding.verification == null
        ? {}
        : { resultDigest: digestTerminalPayload(payload) }),
    });
    return { kind: "cancelled_before_dispatch", record: cancelled };
  }
  return { kind: "await_real_outcome", record: { ...record, abandoned: true } };
}

export function handleJournalSessionUnregister(
  record: InvocationJournalRecord,
  nonExecutionProven: boolean,
  verificationHoldId: string | null = null,
): UnregisterJournalDecision {
  if (record.terminalOutcome !== null || record.state === "indeterminate") {
    return { kind: "unchanged_terminal", record };
  }
  if (record.binding.mutating && !nonExecutionProven) {
    if (verificationHoldId === null) {
      throw new TypeError("uncertain mutating unregistration requires a verification hold id");
    }
    return {
      kind: "mutation_indeterminate",
      record: markJournalIndeterminate(record, verificationHoldId),
      requiresHold: true,
    };
  }
  const payload: JsonValue = {
    fault_class: "addin_unreachable",
    non_execution_proven: nonExecutionProven,
  };
  const failed = recordJournalTerminal(record, {
    status: "failed",
    payloadRetained: true,
    payload,
    ...(record.binding.verification == null
      ? {}
      : { resultDigest: digestTerminalPayload(payload) }),
  });
  return { kind: "known_addin_unreachable", record: failed };
}

function recordTerminalStatus(record: InvocationJournalRecord): BatchStepStatus | null {
  if (record.terminalOutcome !== null) {
    return record.terminalOutcome.status;
  }
  if (record.lateTerminalOutcome !== null) {
    return record.lateTerminalOutcome.status;
  }
  return record.state === "indeterminate" ? "indeterminate" : null;
}

function validBatchRecordOrder(
  records: readonly InvocationJournalRecord[],
  incomingBindings: readonly InvocationJournalBinding[],
): boolean {
  if (records.length === 0 || records.length !== incomingBindings.length) {
    return false;
  }
  const first = incomingBindings[0];
  if (
    first === undefined ||
    first.batchId === undefined ||
    first.batchDigest === undefined
  ) {
    return false;
  }
  const invocationIds = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const incoming = incomingBindings[index];
    if (
      record === undefined ||
      incoming === undefined ||
      incoming.batchId !== first.batchId ||
      incoming.batchDigest !== first.batchDigest ||
      incoming.batchIndex !== index ||
      incoming.rsid !== first.rsid ||
      record.binding.batchId !== first.batchId ||
      record.binding.batchDigest !== first.batchDigest ||
      record.binding.batchIndex !== index ||
      record.binding.rsid !== first.rsid ||
      !journalRecordIsIntact(record) ||
      record.bindingDigest !== makeJournalBindingDigest(incoming) ||
      invocationIds.has(incoming.invocationId)
    ) {
      return false;
    }
    invocationIds.add(incoming.invocationId);
  }
  return true;
}

/**
 * Plans only the safe next action for an atomic:false redelivery. Successors remain
 * not_started until the planned read becomes terminal-successful.
 */
export function planAtomicFalseBatchRedelivery(
  records: readonly InvocationJournalRecord[],
  incomingBindings: readonly InvocationJournalBinding[],
  holdIdsByInvocation: Readonly<Record<string, string>> = {},
): AtomicFalseBatchPlanResult {
  if (!validBatchRecordOrder(records, incomingBindings)) {
    return { kind: "protocol_fault", reason: "batch_binding_mismatch", records };
  }
  const nextRecords = [...records];
  const steps: AtomicFalseBatchPlanStep[] = [];
  let failedStepIndex: number | null = null;
  let stopped = false;
  let executed = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = nextRecords[index];
    if (record === undefined) {
      throw new Error(`missing batch step ${index}`);
    }
    if (stopped) {
      steps.push({
        index,
        invocationId: record.binding.invocationId,
        action: "not_started",
        status: "not_started",
      });
      continue;
    }

    const terminalStatus = recordTerminalStatus(record);
    if (terminalStatus !== null) {
      steps.push({
        index,
        invocationId: record.binding.invocationId,
        action: "replay",
        status: terminalStatus,
      });
      if (terminalStatus !== "completed") {
        failedStepIndex = index;
        stopped = true;
      }
      continue;
    }

    const decision = decideJournalRedelivery(
      record,
      record.binding,
      holdIdsByInvocation[record.binding.invocationId] ?? null,
    );
    if (decision.kind === "reexecute_read") {
      nextRecords[index] = decision.record;
      steps.push({
        index,
        invocationId: record.binding.invocationId,
        action: "execute_read",
        status: "pending",
      });
      executed = true;
      stopped = true;
      continue;
    }
    if (decision.kind === "promote_mutation_indeterminate") {
      nextRecords[index] = decision.record;
      steps.push({
        index,
        invocationId: record.binding.invocationId,
        action: "return_indeterminate",
        status: "indeterminate",
      });
      failedStepIndex = index;
      stopped = true;
      continue;
    }
    if (decision.kind === "read_recovery_already_consumed") {
      steps.push({
        index,
        invocationId: record.binding.invocationId,
        action: "wait",
        status: "pending",
      });
      stopped = true;
      continue;
    }
    if (decision.kind === "return_indeterminate") {
      steps.push({
        index,
        invocationId: record.binding.invocationId,
        action: "return_indeterminate",
        status: "indeterminate",
      });
      failedStepIndex = index;
      stopped = true;
      continue;
    }
    throw new Error(`unexpected batch redelivery decision ${decision.kind}`);
  }

  return { kind: "planned", steps, failedStepIndex, replayed: !executed, records: nextRecords };
}

export function validateAtomicFalseBatchStatuses(
  statuses: readonly BatchStepStatus[],
): { readonly valid: true; readonly failedStepIndex: number | null } | { readonly valid: false } {
  const firstNonSuccess = statuses.findIndex((status) => status !== "completed");
  if (firstNonSuccess === -1) {
    return { valid: true, failedStepIndex: null };
  }
  if (statuses[firstNonSuccess] === "not_started") {
    return { valid: false };
  }
  for (let index = firstNonSuccess + 1; index < statuses.length; index += 1) {
    if (statuses[index] !== "not_started") {
      return { valid: false };
    }
  }
  return { valid: true, failedStepIndex: firstNonSuccess };
}

export function decideAtomicBatchRedelivery(
  record: AtomicBatchJournalRecord,
  incoming: AtomicBatchBinding,
): AtomicBatchRedeliveryDecision {
  const recordIdentity = canonicalizeJson({
    batch_digest: record.binding.batchDigest,
    batch_id: record.binding.batchId,
    ordered_step_binding_digests: [...record.binding.orderedStepBindingDigests],
  });
  const incomingIdentity = canonicalizeJson({
    batch_digest: incoming.batchDigest,
    batch_id: incoming.batchId,
    ordered_step_binding_digests: [...incoming.orderedStepBindingDigests],
  });
  if (recordIdentity !== incomingIdentity) {
    return { kind: "protocol_fault", record, reason: "batch_binding_mismatch" };
  }
  if (record.state === "terminal") {
    if (record.terminalDigest === null) {
      throw new Error("terminal atomic batch is missing terminalDigest");
    }
    return { kind: "replay_terminal", record };
  }
  if (record.state === "received" && !record.dispatchMayHaveStarted) {
    return {
      kind: "execute_atomic",
      record: { ...record, state: "dispatched", dispatchMayHaveStarted: true },
    };
  }
  return {
    kind: "return_indeterminate",
    record: { ...record, state: "indeterminate", terminalDigest: null },
  };
}
