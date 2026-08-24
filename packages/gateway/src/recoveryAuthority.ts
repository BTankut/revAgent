import {
  authorizeMutationDispatch,
  canonicalizeJson,
  conflictingMutationHolds,
  createMutationHoldLedger,
  createReceivedJournalRecord,
  dataEnvelopeImmutableDigest,
  installMutationHolds,
  isOriginRedeliveryExempt,
  journalRecordIsIntact,
  makeJournalBindingDigest,
  makeMutationHoldId,
  makeParamsDigest,
  mutationScopeKey,
  mutationScopesConflict,
  recordLateTerminalEvidence as recordProtocolLateTerminalEvidence,
  recordVerificationEvidence as recordProtocolVerificationEvidence,
  resolveMutationHold,
  validateRbpEnvelope,
  type BatchResult,
  type HoldEvidenceConclusion,
  type HoldResolutionDecision,
  type InvocationJournalBinding,
  type InvocationJournalRecord,
  type JsonValue,
  type MutationHold,
  type MutationHoldLedger,
  type MutationScope,
  type RbpEnvelope,
  type RecoveryClearance,
  type UncertainMutation,
} from "@revagent/protocol";
import { z } from "zod";

import type {
  GatewayConfirmationProof,
  GatewayConfirmationRefusalReason,
  GatewayConfirmationTransactionAuthority,
  GatewayPendingActionRecord,
} from "./confirmationAuthority.js";
import { confirmationIdFromToken } from "./confirmationAuthority.js";
import type { GatewayJsonValue } from "./dispatch.js";
import { gatewayUuidV7, isGatewayUuidV7 } from "./identifiers.js";
import type {
  GatewayProtocolStore,
  StoreErrorCode,
  StoreTransaction,
  StoredRecord,
} from "./store.js";

export const GATEWAY_RECOVERY_NAMESPACE =
  "gateway.recovery-authority/v1" as const;
export const GATEWAY_RECOVERY_CONTRACT_VERSION =
  "revagent.gateway-recovery/v1" as const;

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const holdIdPattern = /^vh:[0-9a-f]{64}$/u;

type MutationEnvelope = Extract<
  RbpEnvelope,
  { readonly type: "invoke" | "invoke_batch" }
>;
type VerificationEnvelope = Extract<RbpEnvelope, { readonly type: "invoke" }>;

const mutationScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z
    .object({
      kind: z.literal("document"),
      document_id: z.string().min(1).max(4_096),
    })
    .strict(),
]);

const evidenceAttemptSchema = z
  .object({
    basis: z.enum(["verification_read", "late_terminal"]),
    verificationInvocationId: z.string().min(1).nullable(),
    originIdempotencyKey: z.string().min(1).nullable(),
    evidenceDigest: z.string().regex(digestPattern),
    conclusion: z.enum([
      "non_execution_proven",
      "postcondition_verified",
      "inconclusive",
      "failed",
      "omitted",
      "ambiguous",
    ]),
    journalBindingDigest: z.string().regex(digestPattern),
    journalOutcomeDigest: z.string().regex(digestPattern),
    terminalKind: z.enum(["terminal", "late_terminal"]),
    terminalStatus: z.enum(["completed", "failed", "guarded", "cancelled"]),
  })
  .strict();

const holdResolutionSchema = z
  .object({
    resolutionId: z.string().refine(isGatewayUuidV7),
    basis: z.enum(["verification_read", "late_terminal"]),
    verificationInvocationId: z.string().min(1).nullable(),
    evidenceDigest: z.string().regex(digestPattern),
    decision: z.enum(["non_execution_proven", "postcondition_verified"]),
    auditId: z.string().refine(isGatewayUuidV7),
    authorizedDispatchIdentity: z.string().regex(digestPattern),
    journalBindingDigest: z.string().regex(digestPattern),
    journalOutcomeDigest: z.string().regex(digestPattern),
    terminalKind: z.enum(["terminal", "late_terminal"]),
    terminalStatus: z.enum(["completed", "failed", "guarded", "cancelled"]),
  })
  .strict();

const mutationHoldSchema = z
  .object({
    rsid: z.string().min(1).max(512),
    mutationScope: mutationScopeSchema,
    scopeKey: z.string().min(1),
    holdId: z.string().regex(holdIdPattern),
    originIdempotencyKeys: z.array(z.string().min(1)).min(1),
    state: z.enum([
      "active",
      "evidence_recorded",
      "resolved_pending_bridge",
      "cleared",
    ]),
    evidenceAttempts: z.array(evidenceAttemptSchema),
    selectedEvidence: evidenceAttemptSchema.nullable(),
    resolution: holdResolutionSchema.nullable(),
    clearedBy: z.string().regex(digestPattern).nullable(),
  })
  .strict();

const mutationHoldLedgerSchema = z
  .object({ holds: z.array(mutationHoldSchema) })
  .strict();

const evidenceDecisionAuditSchema = z
  .object({
    auditId: z.string().refine(isGatewayUuidV7),
    holdId: z.string().regex(holdIdPattern),
    basis: z.enum(["verification_read", "late_terminal"]),
    verificationInvocationId: z.string().min(1).nullable(),
    originIdempotencyKey: z.string().min(1).nullable(),
    evidenceDigest: z.string().regex(digestPattern),
    conclusion: z.enum([
      "non_execution_proven",
      "postcondition_verified",
      "inconclusive",
      "failed",
      "omitted",
      "ambiguous",
    ]),
    journalBindingDigest: z.string().regex(digestPattern),
    journalOutcomeDigest: z.string().regex(digestPattern),
    terminalKind: z.enum(["terminal", "late_terminal"]),
    terminalStatus: z.enum(["completed", "failed", "guarded", "cancelled"]),
    authorityReference: z.string().min(1).max(512),
    decisionVersion: z.number().int().positive().safe(),
    decidedAtMs: z.number().int().nonnegative().safe(),
  })
  .strict();

export interface GatewayRecoveryMutationEntry {
  readonly invocationId: string;
  readonly idempotencyKey: string;
  readonly mutationScope: MutationScope;
  readonly journalBindingDigest: `sha256:${string}`;
}

export interface GatewayRecoveryResolutionPlanItem {
  readonly holdId: string;
  readonly resolutionId: string;
  readonly auditId: string;
  readonly basis: "verification_read" | "late_terminal";
  readonly verificationInvocationId: string | null;
  readonly evidenceDigest: string;
  readonly decision: HoldResolutionDecision;
  readonly journalBindingDigest: string;
  readonly journalOutcomeDigest: string;
}

export interface GatewayRecoveryResolutionPlan {
  readonly planId: string;
  readonly planIdentity: `sha256:${string}`;
  readonly rsid: string;
  readonly mutationScopes: readonly MutationScope[];
  readonly items: readonly GatewayRecoveryResolutionPlanItem[];
  readonly clearances: readonly RecoveryClearance[];
  readonly createdAtMs: number;
}

export interface GatewayRecoveryEvidenceCandidate {
  readonly rsid: string;
  readonly holdId: string;
  readonly mutationScope: MutationScope;
  readonly basis: "verification_read" | "late_terminal";
  readonly verificationInvocationId: string | null;
  readonly originIdempotencyKey: string | null;
  readonly evidenceDigest: string;
  readonly journalRecord: InvocationJournalRecord;
}

export type GatewayRecoveryEvidenceDecision =
  | {
      readonly kind: "decided";
      readonly conclusion: HoldEvidenceConclusion;
      readonly authorityReference: string;
      readonly decisionVersion: number;
      readonly decidedAtMs: number;
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly message: string };

export interface GatewayAuditedRecoveryDecisionPort {
  decideEvidence(
    tx: Pick<StoreTransaction, "read" | "list">,
    candidate: GatewayRecoveryEvidenceCandidate,
  ): Promise<GatewayRecoveryEvidenceDecision>;
}

export interface GatewayRecoveryEvidenceDecisionAudit {
  readonly auditId: string;
  readonly holdId: string;
  readonly basis: "verification_read" | "late_terminal";
  readonly verificationInvocationId: string | null;
  readonly originIdempotencyKey: string | null;
  readonly evidenceDigest: string;
  readonly conclusion: HoldEvidenceConclusion;
  readonly journalBindingDigest: string;
  readonly journalOutcomeDigest: string;
  readonly terminalKind: "terminal" | "late_terminal";
  readonly terminalStatus: "completed" | "failed" | "guarded" | "cancelled";
  readonly authorityReference: string;
  readonly decisionVersion: number;
  readonly decidedAtMs: number;
}

export interface GatewayBridgeCumulativeAckReceipt {
  /** Persisted output of the trusted RBP sequence authority, never caller input. */
  readonly source: "durable_rbp_sequence";
  readonly receiptVersion?: 1;
  readonly tenantId?: string;
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly acceptedConnectionId: string;
  readonly authorizedSessionVersion: number;
  readonly invocationId?: string;
  readonly correlationId?: string;
  /** Digest-only nominal proof and route coordinates; never wire material. */
  readonly proofDigest?: `sha256:${string}`;
  readonly routeSnapshotDigest?: `sha256:${string}`;
  readonly egressEpoch?: number;
  readonly leaseTicket?: number;
  readonly intent?: "dispatch";
  readonly gatewaySequence: number;
  readonly cumulativeAck: number;
  readonly envelopeDigest: `sha256:${string}`;
  readonly durableSequenceVersion: number;
  readonly acceptedAtMs: number;
}

export interface GatewayExpectedInvocationBinding {
  readonly idempotencyKey: string;
  readonly bindingDigest: `sha256:${string}`;
}

export interface GatewayExpectedDispatchBinding {
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly gatewaySequence: number;
  readonly envelopeDigest: `sha256:${string}`;
  readonly invocationBindings: readonly GatewayExpectedInvocationBinding[];
}

export interface GatewayExpectedDispatchTarget extends GatewayExpectedDispatchBinding {
  readonly connectionId: string;
  readonly requiredSessionCapabilities: readonly "batch_atomic"[];
}

export interface GatewayExpectedMutationDispatch {
  readonly rsid: string;
  readonly correlationId: string;
  readonly bindings: readonly InvocationJournalBinding[];
  readonly recoveryClearances: readonly RecoveryClearance[];
}

export interface GatewayExpectedVerificationDispatch {
  readonly rsid: string;
  readonly invocationId: string;
  readonly binding: InvocationJournalBinding;
}

export interface GatewayVerifiedBridgeJournalEvidence {
  readonly kind: "known_terminal" | "indeterminate" | "late_terminal";
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly envelopeDigest: `sha256:${string}`;
  readonly journalRecords: readonly InvocationJournalRecord[];
  /** Exact durable Section 11.1 carrier for an invoke_batch observation. */
  readonly batchTerminal: GatewayDurableBatchTerminal | null;
  readonly durableJournalVersion: number;
  readonly recordedAtMs: number;
}

export interface GatewayDurableBatchTerminal {
  readonly result: BatchResult;
  readonly resultDigest: `sha256:${string}`;
}

/**
 * A Gateway-authored, digest-only receipt that proves a specific dispatch
 * reservation was cancelled before the WSS/SSE invocation boundary.  It is
 * not north-client input and it can never authorize a replay.
 */
export interface GatewayBridgeNoSendReceipt {
  readonly schema: "gateway.dispatch-no-send/v1";
  readonly tenantId: string;
  readonly rsid: string;
  readonly effectiveMcpSessionId: string;
  readonly principalKey: string;
  readonly effectiveScopeDigest: `sha256:${string}`;
  readonly sessionBindingId: string;
  readonly acceptedConnectionId: string;
  readonly durableSessionVersion: number;
  readonly invocationId: string;
  readonly correlationId: string;
  readonly envelopeDigest: `sha256:${string}`;
  readonly gatewaySequence: number;
  readonly durableSequenceVersion: number;
  readonly egressEpoch: number;
  readonly leaseVersion: 1;
  readonly leaseTicket: number;
  readonly leaseHolderInstanceId: string;
  readonly proofDigest: `sha256:${string}`;
  readonly routeSnapshotDigest: `sha256:${string}`;
  readonly intentDigest: `sha256:${string}`;
  /** Must equal the Gateway-retained reservation authority digest. */
  readonly authorityDigest: `sha256:${string}`;
  readonly transportStarted: false;
  readonly cumulativeAck: null;
  readonly recordedAtMs: number;
}

export interface GatewayDurableDispatchObservation {
  readonly acceptance: GatewayBridgeCumulativeAckReceipt | null;
  readonly journal: GatewayVerifiedBridgeJournalEvidence | null;
  /** Undefined is legacy/no-observation; only a validated receipt is truth. */
  readonly noSend?: GatewayBridgeNoSendReceipt | null;
}

export type GatewayBridgeEvidenceLookup =
  | {
      readonly kind: "found";
      readonly observation: GatewayDurableDispatchObservation;
    }
  | { readonly kind: "not_durable_yet" }
  | { readonly kind: "protocol_fault"; readonly reason: string }
  | {
      readonly kind: "unavailable";
      readonly code: StoreErrorCode;
      readonly message: string;
    };

export type GatewayBridgeResumeAuthorization =
  | { readonly kind: "authorized"; readonly sessionVersion: number }
  | { readonly kind: "not_authorized"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Trusted seam implemented by the durable RBP ingress in GW-12.
 *
 * The port receives the recovery transaction's read view and must derive its
 * answer from durable sequence/journal authority. A generic executor outcome,
 * a north-client payload, or a self-consistent caller-authored receipt is not
 * evidence. The deterministic fake lives only in test code.
 */
export interface GatewayDurableBridgeEvidencePort {
  inspectDispatch(
    tx: Pick<StoreTransaction, "read" | "list">,
    expected: GatewayExpectedDispatchBinding,
  ): Promise<GatewayBridgeEvidenceLookup>;
  authorizeDispatchTarget(
    tx: Pick<StoreTransaction, "read" | "list">,
    expected: GatewayExpectedDispatchTarget,
  ): Promise<GatewayBridgeResumeAuthorization>;
  authorizeResumeTarget(
    tx: Pick<StoreTransaction, "read" | "list">,
    expected: GatewayExpectedDispatchTarget,
  ): Promise<GatewayBridgeResumeAuthorization>;
}

export interface GatewayRecoveryPendingDispatch {
  readonly kind: "mutation" | "verification";
  readonly envelope: MutationEnvelope | VerificationEnvelope;
  readonly envelopeDigest: `sha256:${string}`;
  readonly gatewaySequence: number;
  readonly sessionBindingId: string;
  readonly preparedConnectionId: string;
  readonly authorizedSessionVersion: number;
  readonly requiredSessionCapabilities: readonly "batch_atomic"[];
  readonly mutationEntries: readonly GatewayRecoveryMutationEntry[];
  readonly journalRecords: readonly InvocationJournalRecord[];
  readonly journalAttestation: GatewayRecoveryJournalAttestation | null;
  readonly batchTerminal: GatewayDurableBatchTerminal | null;
  readonly recoveryHoldIds: readonly string[];
  readonly recoveryClearances: readonly RecoveryClearance[];
  readonly verificationHoldId: string | null;
  readonly originRedelivery: boolean;
  readonly bridgeAcceptance: GatewayBridgeCumulativeAckReceipt | null;
  readonly preparedAtMs: number;
}

export interface GatewayRecoveryJournalAttestation {
  readonly kind: GatewayVerifiedBridgeJournalEvidence["kind"];
  readonly evidenceEnvelopeDigest: `sha256:${string}`;
  readonly durableJournalVersion: number;
  readonly recordedAtMs: number;
  readonly batchResultDigest: `sha256:${string}` | null;
}

export interface GatewayRecoveryDispatchHistory {
  readonly status: "terminal" | "indeterminate";
  readonly envelope: MutationEnvelope | VerificationEnvelope;
  readonly envelopeDigest: `sha256:${string}`;
  readonly sessionBindingId: string;
  readonly authorizedSessionVersion: number;
  readonly requiredSessionCapabilities: readonly "batch_atomic"[];
  readonly mutationEntries: readonly GatewayRecoveryMutationEntry[];
  readonly journalRecords: readonly InvocationJournalRecord[];
  readonly batchTerminal: GatewayDurableBatchTerminal | null;
  readonly journalAttestation: GatewayRecoveryJournalAttestation;
  readonly holdIds: readonly string[];
  readonly bridgeAcceptance: GatewayBridgeCumulativeAckReceipt | null;
  readonly recordedAtMs: number;
}

export interface GatewayRecoveryRecord {
  readonly contractVersion: typeof GATEWAY_RECOVERY_CONTRACT_VERSION;
  readonly rsid: string;
  readonly invocationWindow: GatewayRecoveryInvocationWindow | null;
  readonly evidenceDecisions: readonly GatewayRecoveryEvidenceDecisionAudit[];
  readonly ledger: MutationHoldLedger;
  readonly resolutionPlan: GatewayRecoveryResolutionPlan | null;
  readonly pendingDispatch: GatewayRecoveryPendingDispatch | null;
  readonly dispatchHistory: readonly GatewayRecoveryDispatchHistory[];
}

export interface GatewayRecoveryInvocationWindow {
  readonly attemptId: string;
  readonly acquiredAtMs: number;
}

export interface GatewayRecoveryStoreFailure {
  readonly kind: "unavailable";
  readonly code: StoreErrorCode;
  readonly message: string;
}

export interface GatewayRecoveryProtocolFault {
  readonly kind: "protocol_fault";
  readonly reason: string;
  readonly installedHoldIds?: readonly string[];
}

export type GatewayRecoveryPreflightResult =
  | { readonly kind: "clear" }
  | {
      readonly kind: "blocked";
      readonly reason: "dispatch_in_flight" | "mutation_hold";
      readonly holdIds: readonly string[];
    }
  | GatewayRecoveryProtocolFault
  | GatewayRecoveryStoreFailure;

export type GatewayRecoveryWindowAcquireResult =
  | { readonly kind: "acquired" | "already_acquired" }
  | { readonly kind: "blocked"; readonly activeAttemptId: string }
  | GatewayRecoveryProtocolFault
  | GatewayRecoveryStoreFailure;

export type GatewayRecoveryWindowReleaseResult =
  | { readonly kind: "released" | "already_released" }
  | { readonly kind: "blocked"; readonly reason: "dispatch_pending" }
  | GatewayRecoveryProtocolFault
  | GatewayRecoveryStoreFailure;

export type GatewayRecoveryPlanResult =
  | {
      readonly kind: "planned" | "already_planned";
      readonly plan: GatewayRecoveryResolutionPlan;
    }
  | { readonly kind: "blocked"; readonly holdIds: readonly string[] }
  | { readonly kind: "rejected"; readonly reason: string }
  | GatewayRecoveryProtocolFault
  | GatewayRecoveryStoreFailure;

export type GatewayRecoveryPrepareResult =
  | {
      readonly kind: "prepared" | "already_prepared";
      readonly dispatch: GatewayRecoveryPendingDispatch;
    }
  | {
      readonly kind: "replay_terminal";
      readonly history: GatewayRecoveryDispatchHistory;
    }
  | {
      readonly kind: "blocked";
      readonly reason: string;
      readonly holdIds: readonly string[];
    }
  | {
      readonly kind: "confirmation_rejected";
      readonly reason: GatewayConfirmationRefusalReason;
      readonly confirmationId: string | null;
      readonly pendingAction: GatewayPendingActionRecord | null;
    }
  | GatewayRecoveryProtocolFault
  | GatewayRecoveryStoreFailure;

export type GatewayRecoveryResumeResult =
  | {
      readonly kind: "retransmit";
      readonly dispatch: GatewayRecoveryPendingDispatch;
    }
  | { readonly kind: "already_accepted" | "none" }
  | { readonly kind: "blocked"; readonly reason: string }
  | GatewayRecoveryProtocolFault
  | GatewayRecoveryStoreFailure;

export type GatewayRecoveryReconcileResult =
  | {
      readonly kind:
        | "pending"
        | "accepted"
        | "indeterminate_recorded"
        | "verification_evidence_ready";
      readonly installedHoldIds: readonly string[];
      readonly clearedHoldIds: readonly string[];
    }
  | {
      readonly kind: "terminal_recorded";
      readonly installedHoldIds: readonly string[];
      readonly clearedHoldIds: readonly string[];
      readonly terminalJournalRecords: readonly InvocationJournalRecord[];
      readonly terminalBatch: GatewayDurableBatchTerminal | null;
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | GatewayRecoveryProtocolFault
  | GatewayRecoveryStoreFailure;

export type GatewayRecoveryEvidenceResult =
  | {
      readonly kind: "recorded" | "inconclusive_recorded";
      readonly hold: MutationHold;
    }
  | { readonly kind: "rejected"; readonly reason: string }
  | GatewayRecoveryProtocolFault
  | GatewayRecoveryStoreFailure;

export interface GatewayRecoveryAuthorityOptions {
  readonly bridgeEvidence: GatewayDurableBridgeEvidencePort;
  readonly evidenceDecision: GatewayAuditedRecoveryDecisionPort;
  readonly confirmationAuthority?: GatewayConfirmationTransactionAuthority;
  readonly clock?: () => number;
  readonly newId?: (timestampMs: number) => string;
}

interface LoadedRecoveryRecord {
  readonly value: GatewayRecoveryRecord;
  readonly stored: StoredRecord | null;
}

interface DerivedEnvelope {
  readonly envelope: MutationEnvelope | VerificationEnvelope;
  readonly digest: `sha256:${string}`;
  readonly correlationId: string;
  readonly mutationEntries: readonly GatewayRecoveryMutationEntry[];
  readonly bindings: readonly InvocationJournalBinding[];
  readonly clearances: readonly RecoveryClearance[];
  readonly verificationHoldId: string | null;
}

function canonical(value: unknown): string {
  return canonicalizeJson(value as JsonValue);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function assertBoundedString(
  value: unknown,
  name: string,
  maximum = 4_096,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TypeError(`${name} must be a non-empty trimmed string`);
  }
}

function assertSafePositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertSafeNonNegativeInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertSortedUnique(values: readonly string[], name: string): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    assertBoundedString(value, `${name}[${String(index)}]`);
    if (index > 0 && (values[index - 1] ?? "") >= value) {
      throw new TypeError(`${name} must contain unique ascending values`);
    }
  }
}

function normalizeScopes(
  scopes: readonly MutationScope[],
): readonly MutationScope[] {
  if (scopes.length === 0) {
    throw new TypeError("at least one mutation scope is required");
  }
  const byKey = new Map<string, MutationScope>();
  for (const candidate of structuredClone(scopes)) {
    const parsed = mutationScopeSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new TypeError("mutation scope is not canonical");
    }
    const scope = parsed.data as MutationScope;
    byKey.set(mutationScopeKey(scope), scope);
  }
  return Object.freeze(
    [...byKey.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, scope]) => Object.freeze(structuredClone(scope))),
  );
}

function journalPolicy(policy: {
  readonly class: "auto" | "confirm" | "gated";
  readonly decision: "auto" | "confirmed" | "gated_approved";
  readonly confirmation_id: string | null;
}): InvocationJournalBinding["policy"] {
  return {
    class: policy.class,
    decision: policy.decision,
    confirmation_id: policy.confirmation_id,
  };
}

function deriveEnvelope(
  value: unknown,
  expectedRsid?: string,
): DerivedEnvelope {
  const envelope = structuredClone(value);
  if (
    !validateRbpEnvelope(envelope) ||
    (envelope.type !== "invoke" && envelope.type !== "invoke_batch")
  ) {
    throw new TypeError(
      "dispatch envelope is not a valid invoke or invoke_batch RBP envelope",
    );
  }
  if (expectedRsid !== undefined && envelope.rsid !== expectedRsid) {
    throw new TypeError(
      "dispatch envelope rsid does not match recovery authority scope",
    );
  }
  assertSafePositiveInteger(envelope.seq, "gateway sequence");
  const digest = dataEnvelopeImmutableDigest({
    v: envelope.v,
    type: envelope.type,
    id: envelope.id,
    rsid: envelope.rsid,
    seq: envelope.seq,
    payload: envelope.payload as JsonValue,
  });
  const bindings: InvocationJournalBinding[] = [];
  const mutationEntries: GatewayRecoveryMutationEntry[] = [];

  if (envelope.type === "invoke") {
    const payload = envelope.payload;
    const binding: InvocationJournalBinding = {
      rsid: envelope.rsid,
      invocationId: payload.invocation_id,
      method: payload.method,
      mutating: payload.mutating,
      mutationScope: payload.mutation_scope,
      paramsDigest: makeParamsDigest(payload.params as JsonValue),
      policy: journalPolicy(payload.policy),
      verification: payload.verification,
      recoveryClearances: payload.recovery_clearances,
    };
    bindings.push(binding);
    if (payload.mutating) {
      mutationEntries.push({
        invocationId: payload.invocation_id,
        idempotencyKey: `${envelope.rsid}/${payload.invocation_id}`,
        mutationScope: structuredClone(payload.mutation_scope),
        journalBindingDigest: makeJournalBindingDigest(binding),
      });
    }
    return {
      envelope,
      digest,
      correlationId: payload.invocation_id,
      mutationEntries,
      bindings,
      clearances: payload.recovery_clearances,
      verificationHoldId: payload.verification?.hold_id ?? null,
    };
  }

  const payload = envelope.payload;
  for (const [index, step] of payload.steps.entries()) {
    const binding: InvocationJournalBinding = {
      rsid: envelope.rsid,
      invocationId: step.invocation_id,
      method: step.method,
      mutating: step.mutating,
      mutationScope: step.mutation_scope,
      paramsDigest: step.params_digest,
      policy: journalPolicy(step.policy),
      verification: null,
      recoveryClearances: payload.recovery_clearances,
      batchId: payload.batch_id,
      batchIndex: index,
      batchDigest: payload.batch_digest,
    };
    bindings.push(binding);
    if (step.mutating) {
      mutationEntries.push({
        invocationId: step.invocation_id,
        idempotencyKey: `${envelope.rsid}/${step.invocation_id}`,
        mutationScope: structuredClone(step.mutation_scope),
        journalBindingDigest: makeJournalBindingDigest(binding),
      });
    }
  }
  return {
    envelope,
    digest,
    correlationId: payload.batch_id,
    mutationEntries,
    bindings,
    clearances: payload.recovery_clearances,
    verificationHoldId: null,
  };
}

type RetainedIdentityClassification =
  | { readonly kind: "new" }
  | {
      readonly kind: "exact_pending";
      readonly pending: GatewayRecoveryPendingDispatch;
    }
  | {
      readonly kind: "exact_terminal" | "exact_indeterminate";
      readonly history: GatewayRecoveryDispatchHistory;
    }
  | {
      readonly kind: "protocol_fault";
      readonly reason:
        "idempotency_binding_mismatch" | "batch_binding_mismatch";
    };

function bindingIndex(derived: DerivedEnvelope): ReadonlyMap<string, string> {
  return new Map(
    derived.bindings.map((binding) => [
      `${binding.rsid}/${binding.invocationId}`,
      makeJournalBindingDigest(binding),
    ]),
  );
}

function classifyRetainedIdentity(
  record: GatewayRecoveryRecord,
  derived: DerivedEnvelope,
): RetainedIdentityClassification {
  if (record.pendingDispatch?.envelopeDigest === derived.digest) {
    return { kind: "exact_pending", pending: record.pendingDispatch };
  }
  const exactHistory = record.dispatchHistory.find(
    (history) => history.envelopeDigest === derived.digest,
  );
  if (exactHistory !== undefined) {
    return exactHistory.status === "terminal"
      ? { kind: "exact_terminal", history: exactHistory }
      : { kind: "exact_indeterminate", history: exactHistory };
  }

  const incomingBindings = bindingIndex(derived);
  const retained = [
    ...(record.pendingDispatch === null ? [] : [record.pendingDispatch]),
    ...record.dispatchHistory,
  ];
  for (const candidate of retained) {
    const retainedDerived = deriveEnvelope(candidate.envelope, record.rsid);
    if (
      derived.envelope.type === "invoke_batch" &&
      retainedDerived.envelope.type === "invoke_batch" &&
      derived.correlationId === retainedDerived.correlationId
    ) {
      return { kind: "protocol_fault", reason: "batch_binding_mismatch" };
    }
    const retainedBindings = bindingIndex(retainedDerived);
    for (const [key] of incomingBindings) {
      const retainedDigest = retainedBindings.get(key);
      if (retainedDigest !== undefined) {
        return {
          kind: "protocol_fault",
          reason: "idempotency_binding_mismatch",
        };
      }
    }
  }
  return { kind: "new" };
}

function assertJournalBindings(
  records: readonly InvocationJournalRecord[],
  bindings: readonly InvocationJournalBinding[],
): void {
  if (records.length !== bindings.length) {
    throw new TypeError(
      "journal record count does not match the exact dispatch envelope",
    );
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const binding = bindings[index];
    if (
      record === undefined ||
      binding === undefined ||
      !journalRecordIsIntact(record) ||
      record.bindingDigest !== makeJournalBindingDigest(binding)
    ) {
      throw new TypeError(
        "journal record is not intact and bound to the exact dispatch envelope",
      );
    }
  }
}

function createJournalRecords(
  bindings: readonly InvocationJournalBinding[],
): readonly InvocationJournalRecord[] {
  return Object.freeze(
    bindings.map((binding) => createReceivedJournalRecord(binding)),
  );
}

function evidenceMatchesResolution(hold: MutationHold): boolean {
  const evidence = hold.selectedEvidence;
  const resolution = hold.resolution;
  return (
    evidence !== null &&
    resolution !== null &&
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

function assertLedgerIntegrity(ledger: MutationHoldLedger, rsid: string): void {
  let previousHoldId = "";
  const seen = new Set<string>();
  for (const hold of ledger.holds) {
    if (hold.rsid !== rsid)
      throw new TypeError("recovery ledger contains a foreign rsid");
    if (seen.has(hold.holdId) || hold.holdId <= previousHoldId) {
      throw new TypeError("recovery ledger hold ids must be unique and sorted");
    }
    seen.add(hold.holdId);
    previousHoldId = hold.holdId;
    if (
      new Set(hold.originIdempotencyKeys).size !==
      hold.originIdempotencyKeys.length
    ) {
      throw new TypeError("recovery hold contains duplicate origin keys");
    }
    if (
      hold.scopeKey !== mutationScopeKey(hold.mutationScope) ||
      hold.holdId !==
        makeMutationHoldId(
          hold.rsid,
          hold.mutationScope,
          hold.originIdempotencyKeys,
        )
    ) {
      throw new TypeError("recovery hold identity is not canonical");
    }
    if (
      hold.selectedEvidence !== null &&
      !hold.evidenceAttempts.some((attempt) =>
        sameValue(attempt, hold.selectedEvidence),
      )
    ) {
      throw new TypeError("selected recovery evidence is not retained");
    }
    if (hold.state === "active") {
      if (
        hold.selectedEvidence !== null ||
        hold.resolution !== null ||
        hold.clearedBy !== null
      ) {
        throw new TypeError("active recovery hold contains resolution state");
      }
    } else if (hold.state === "evidence_recorded") {
      if (
        hold.selectedEvidence === null ||
        hold.resolution !== null ||
        hold.clearedBy !== null
      ) {
        throw new TypeError(
          "evidence_recorded hold has an invalid state shape",
        );
      }
    } else {
      if (!evidenceMatchesResolution(hold)) {
        throw new TypeError("recovery hold resolution is not evidence-bound");
      }
      if (hold.state === "resolved_pending_bridge" && hold.clearedBy !== null) {
        throw new TypeError("pending recovery hold is already cleared");
      }
      if (
        hold.state === "cleared" &&
        (hold.clearedBy === null ||
          hold.clearedBy !== hold.resolution?.authorizedDispatchIdentity)
      ) {
        throw new TypeError("cleared recovery hold is not dispatch-bound");
      }
    }
  }
}

function planMaterial(input: {
  readonly rsid: string;
  readonly mutationScopes: readonly MutationScope[];
  readonly items: readonly Pick<
    GatewayRecoveryResolutionPlanItem,
    | "holdId"
    | "basis"
    | "verificationInvocationId"
    | "evidenceDigest"
    | "decision"
  >[];
}): JsonValue {
  return {
    rsid: input.rsid,
    mutation_scopes: input.mutationScopes as unknown as JsonValue,
    items: input.items.map((item) => ({
      basis: item.basis,
      decision: item.decision,
      evidence_digest: item.evidenceDigest,
      hold_id: item.holdId,
      verification_invocation_id: item.verificationInvocationId,
    })),
  };
}

function planIdentity(
  input: Parameters<typeof planMaterial>[0],
): `sha256:${string}` {
  return makeParamsDigest(planMaterial(input));
}

function assertPlanIntegrity(
  plan: GatewayRecoveryResolutionPlan,
  ledger: MutationHoldLedger,
  rsid: string,
  evidenceDecisions: readonly GatewayRecoveryEvidenceDecisionAudit[],
): void {
  if (plan.rsid !== rsid || !isGatewayUuidV7(plan.planId)) {
    throw new TypeError("recovery resolution plan identity is invalid");
  }
  assertSafeNonNegativeInteger(plan.createdAtMs, "resolution plan timestamp");
  const scopes = normalizeScopes(plan.mutationScopes);
  if (!sameValue(scopes, plan.mutationScopes)) {
    throw new TypeError("recovery resolution plan scopes are not canonical");
  }
  const itemIds = plan.items.map((item) => item.holdId);
  assertSortedUnique(itemIds, "resolution plan hold ids");
  if (
    plan.planIdentity !==
    planIdentity({
      rsid,
      mutationScopes: plan.mutationScopes,
      items: plan.items,
    })
  ) {
    throw new TypeError("recovery resolution plan digest is invalid");
  }
  if (
    !sameStrings(
      plan.clearances.map((clearance) => clearance.hold_id),
      itemIds,
    )
  ) {
    throw new TypeError(
      "recovery resolution plan clearances are not every-and-only",
    );
  }
  for (let index = 0; index < plan.items.length; index += 1) {
    const item = plan.items[index];
    const clearance = plan.clearances[index];
    const hold = ledger.holds.find(
      (candidate) => candidate.holdId === item?.holdId,
    );
    const audit = evidenceDecisions.find(
      (candidate) => candidate.auditId === item?.auditId,
    );
    if (
      item === undefined ||
      clearance === undefined ||
      hold === undefined ||
      audit === undefined ||
      hold.state !== "evidence_recorded" ||
      hold.selectedEvidence === null ||
      !isGatewayUuidV7(item.resolutionId) ||
      !isGatewayUuidV7(item.auditId) ||
      hold.selectedEvidence.basis !== item.basis ||
      hold.selectedEvidence.verificationInvocationId !==
        item.verificationInvocationId ||
      hold.selectedEvidence.evidenceDigest !== item.evidenceDigest ||
      hold.selectedEvidence.conclusion !== item.decision ||
      hold.selectedEvidence.journalBindingDigest !==
        item.journalBindingDigest ||
      hold.selectedEvidence.journalOutcomeDigest !==
        item.journalOutcomeDigest ||
      audit.holdId !== item.holdId ||
      audit.basis !== item.basis ||
      audit.verificationInvocationId !== item.verificationInvocationId ||
      audit.evidenceDigest !== item.evidenceDigest ||
      audit.conclusion !== item.decision ||
      audit.journalBindingDigest !== item.journalBindingDigest ||
      audit.journalOutcomeDigest !== item.journalOutcomeDigest ||
      audit.terminalKind !== hold.selectedEvidence.terminalKind ||
      audit.terminalStatus !== hold.selectedEvidence.terminalStatus ||
      clearance.hold_id !== item.holdId ||
      clearance.resolution_id !== item.resolutionId ||
      clearance.audit_id !== item.auditId ||
      clearance.basis !== item.basis ||
      clearance.verification_invocation_id !== item.verificationInvocationId ||
      clearance.evidence_digest !== item.evidenceDigest ||
      clearance.decision !== item.decision ||
      mutationScopeKey(clearance.mutation_scope) !== hold.scopeKey
    ) {
      throw new TypeError(
        "recovery resolution plan is not bound to selected evidence",
      );
    }
  }
}

function assertReceiptIntegrity(
  receipt: GatewayBridgeCumulativeAckReceipt,
  pending: GatewayRecoveryPendingDispatch,
  tenantId?: string,
): void {
  const derived = deriveEnvelope(pending.envelope, pending.envelope.rsid);
  if (
    receipt.source !== "durable_rbp_sequence" ||
    receipt.receiptVersion !== 1 ||
    (tenantId !== undefined && receipt.tenantId !== tenantId) ||
    receipt.rsid !== pending.envelope.rsid ||
    receipt.sessionBindingId !== pending.sessionBindingId ||
    receipt.acceptedConnectionId !== pending.preparedConnectionId ||
    receipt.authorizedSessionVersion !== pending.authorizedSessionVersion ||
    receipt.invocationId !== derived.correlationId ||
    receipt.correlationId !== derived.correlationId ||
    receipt.intent !== "dispatch" ||
    receipt.gatewaySequence !== pending.gatewaySequence ||
    receipt.envelopeDigest !== pending.envelopeDigest ||
    receipt.cumulativeAck < pending.gatewaySequence
  ) {
    throw new TypeError(
      "Bridge cumulative ACK is not bound to the pending dispatch",
    );
  }
  if (typeof receipt.tenantId !== "string") {
    throw new TypeError("accepted tenantId is missing");
  }
  assertBoundedString(receipt.tenantId, "accepted tenantId", 512);
  assertBoundedString(receipt.acceptedConnectionId, "acceptedConnectionId");
  assertBoundedString(receipt.invocationId, "accepted invocationId");
  assertBoundedString(receipt.correlationId, "accepted correlationId");
  if (
    typeof receipt.proofDigest !== "string" ||
    typeof receipt.routeSnapshotDigest !== "string" ||
    !digestPattern.test(receipt.proofDigest) ||
    !digestPattern.test(receipt.routeSnapshotDigest)
  ) {
    throw new TypeError("accepted dispatch receipt proof is invalid");
  }
  if (
    typeof receipt.egressEpoch !== "number" ||
    typeof receipt.leaseTicket !== "number"
  ) {
    throw new TypeError("accepted dispatch receipt fence is missing");
  }
  assertSafeNonNegativeInteger(receipt.egressEpoch, "accepted egressEpoch");
  assertSafePositiveInteger(receipt.leaseTicket, "accepted leaseTicket");
  assertSafePositiveInteger(
    receipt.authorizedSessionVersion,
    "accepted authorizedSessionVersion",
  );
  assertSafePositiveInteger(receipt.gatewaySequence, "gatewaySequence");
  assertSafeNonNegativeInteger(receipt.cumulativeAck, "cumulativeAck");
  assertSafePositiveInteger(
    receipt.durableSequenceVersion,
    "durableSequenceVersion",
  );
  assertSafeNonNegativeInteger(receipt.acceptedAtMs, "acceptedAtMs");
}

function expectedDerivedDispatchBinding(
  derived: DerivedEnvelope,
  sessionBindingId: string,
): GatewayExpectedDispatchBinding {
  return Object.freeze({
    rsid: derived.envelope.rsid,
    sessionBindingId,
    gatewaySequence: derived.envelope.seq,
    envelopeDigest: derived.digest,
    invocationBindings: Object.freeze(
      derived.bindings.map((binding) =>
        Object.freeze({
          idempotencyKey: `${binding.rsid}/${binding.invocationId}`,
          bindingDigest: makeJournalBindingDigest(binding),
        }),
      ),
    ),
  });
}

function expectedDispatchBinding(
  pending: GatewayRecoveryPendingDispatch,
): GatewayExpectedDispatchBinding {
  return expectedDerivedDispatchBinding(
    deriveEnvelope(pending.envelope, pending.envelope.rsid),
    pending.sessionBindingId,
  );
}

function requiredSessionCapabilities(
  derived: DerivedEnvelope,
): readonly "batch_atomic"[] {
  return derived.envelope.type === "invoke_batch" &&
    derived.envelope.payload.atomic
    ? Object.freeze(["batch_atomic" as const])
    : Object.freeze([]);
}

function expectedDispatchTarget(input: {
  readonly derived: DerivedEnvelope;
  readonly sessionBindingId: string;
  readonly connectionId: string;
}): GatewayExpectedDispatchTarget {
  return Object.freeze({
    ...expectedDerivedDispatchBinding(input.derived, input.sessionBindingId),
    connectionId: input.connectionId,
    requiredSessionCapabilities: requiredSessionCapabilities(input.derived),
  });
}

function batchTerminalDigest(result: BatchResult): `sha256:${string}` {
  return makeParamsDigest(result as unknown as JsonValue);
}

function assertBatchTerminalIntegrity(input: {
  readonly envelope: MutationEnvelope | VerificationEnvelope;
  readonly journalRecords: readonly InvocationJournalRecord[];
  readonly evidenceKind: GatewayVerifiedBridgeJournalEvidence["kind"];
  readonly batchTerminal: GatewayDurableBatchTerminal | null;
}): void {
  if (input.envelope.type !== "invoke_batch") {
    if (input.batchTerminal !== null) {
      throw new TypeError(
        "ordinary invocation evidence carries a batch terminal",
      );
    }
    return;
  }
  if (input.batchTerminal === null) {
    if (input.evidenceKind === "indeterminate") return;
    throw new TypeError(
      "terminal batch evidence omitted its Section 11.1 carrier",
    );
  }

  const { result, resultDigest } = input.batchTerminal;
  if (resultDigest !== batchTerminalDigest(result)) {
    throw new TypeError("durable batch terminal digest mismatch");
  }
  const carrierEnvelope = {
    v: 1,
    type: "result",
    id: input.envelope.id,
    ts: input.envelope.ts,
    rsid: input.envelope.rsid,
    seq: input.envelope.seq,
    ...(input.envelope.ack === undefined ? {} : { ack: input.envelope.ack }),
    payload: result,
  };
  if (
    !validateRbpEnvelope(carrierEnvelope) ||
    carrierEnvelope.type !== "result" ||
    carrierEnvelope.payload.kind !== "batch"
  ) {
    throw new TypeError(
      "durable batch terminal is not a valid RBP result carrier",
    );
  }
  if (
    result.batch_id !== input.envelope.payload.batch_id ||
    result.atomic !== input.envelope.payload.atomic ||
    result.steps.length !== input.envelope.payload.steps.length ||
    result.steps.length !== input.journalRecords.length
  ) {
    throw new TypeError(
      "durable batch terminal is not bound to the exact batch",
    );
  }
  if (
    (input.evidenceKind === "indeterminate") !==
    (result.status === "indeterminate")
  ) {
    throw new TypeError(
      "durable batch terminal disagrees with its evidence kind",
    );
  }

  for (let index = 0; index < result.steps.length; index += 1) {
    const step = result.steps[index]!;
    const expectedStep = input.envelope.payload.steps[index]!;
    const journal = input.journalRecords[index]!;
    if (
      step.index !== index ||
      step.invocation_id !== expectedStep.invocation_id
    ) {
      throw new TypeError("durable batch terminal step identity mismatch");
    }
    if (step.status === "indeterminate") {
      if (journal.state !== "indeterminate") {
        throw new TypeError(
          "indeterminate batch step lacks an indeterminate journal",
        );
      }
      continue;
    }
    if (step.status === "not_started") {
      const neverDispatched =
        journal.state === "received" && !journal.dispatchMayHaveStarted;
      const atomicallyCancelled =
        journal.terminalOutcome?.status === "cancelled";
      if (!neverDispatched && !atomicallyCancelled) {
        throw new TypeError(
          "not-started batch step has a contradictory journal",
        );
      }
      continue;
    }

    const terminal =
      input.evidenceKind === "late_terminal" &&
      journal.lateTerminalOutcome !== null
        ? journal.lateTerminalOutcome
        : journal.terminalOutcome;
    if (terminal === null || terminal.status !== step.status) {
      throw new TypeError("terminal batch step disagrees with its journal");
    }
    if (
      step.status === "guarded" &&
      terminal.guardedReason !== step.guarded_reason
    ) {
      throw new TypeError(
        "guarded batch step reason disagrees with its journal",
      );
    }
    const stepResultDigest =
      "result_digest" in step && typeof step.result_digest === "string"
        ? step.result_digest
        : null;
    if (
      stepResultDigest !== null &&
      terminal.resultDigest !== stepResultDigest
    ) {
      throw new TypeError(
        "batch step result digest disagrees with its journal",
      );
    }
  }
}

function assertJournalEvidenceIntegrity(
  evidence: GatewayVerifiedBridgeJournalEvidence,
  pending: GatewayRecoveryPendingDispatch,
): void {
  const expected = expectedDispatchBinding(pending);
  if (
    evidence.rsid !== expected.rsid ||
    evidence.sessionBindingId !== expected.sessionBindingId ||
    evidence.envelopeDigest !== expected.envelopeDigest
  ) {
    throw new TypeError(
      "durable Bridge journal evidence is not dispatch-bound",
    );
  }
  assertSafePositiveInteger(
    evidence.durableJournalVersion,
    "durableJournalVersion",
  );
  assertSafeNonNegativeInteger(
    evidence.recordedAtMs,
    "journal evidence recordedAtMs",
  );
  const derived = deriveEnvelope(pending.envelope, pending.envelope.rsid);
  assertJournalBindings(evidence.journalRecords, derived.bindings);
  assertBatchTerminalIntegrity({
    envelope: pending.envelope,
    journalRecords: evidence.journalRecords,
    evidenceKind: evidence.kind,
    batchTerminal: evidence.batchTerminal,
  });
  const terminalStates = new Set([
    "completed",
    "failed",
    "guarded",
    "cancelled",
  ]);
  if (
    pending.envelope.type !== "invoke_batch" &&
    evidence.kind === "known_terminal" &&
    evidence.journalRecords.some(
      (journal) => !terminalStates.has(journal.state),
    )
  ) {
    throw new TypeError(
      "known-terminal Bridge evidence contains a non-terminal journal",
    );
  }
  if (
    evidence.kind === "indeterminate" &&
    !evidence.journalRecords.some(
      (journal) => journal.state === "indeterminate",
    )
  ) {
    throw new TypeError(
      "indeterminate Bridge evidence contains no indeterminate journal",
    );
  }
  if (
    evidence.kind === "late_terminal" &&
    !evidence.journalRecords.some(
      (journal) =>
        journal.state === "indeterminate" &&
        journal.lateTerminalOutcome !== null &&
        journal.lateTerminalOutcomeDigest !== null,
    )
  ) {
    throw new TypeError(
      "late-terminal Bridge evidence contains no attested late outcome",
    );
  }
}

function assertObservationIntegrity(
  observation: GatewayDurableDispatchObservation,
  pending: GatewayRecoveryPendingDispatch,
  tenantId: string,
): void {
  if (observation.acceptance !== null) {
    assertReceiptIntegrity(observation.acceptance, pending, tenantId);
  }
  if (observation.journal !== null) {
    assertJournalEvidenceIntegrity(observation.journal, pending);
  }
  const noSend = observation.noSend ?? null;
  if (noSend !== null) {
    const derived = deriveEnvelope(pending.envelope, pending.envelope.rsid);
    if (
      noSend.schema !== "gateway.dispatch-no-send/v1" ||
      noSend.tenantId !== tenantId ||
      noSend.rsid !== pending.envelope.rsid ||
      noSend.invocationId !== derived.correlationId ||
      noSend.correlationId !== derived.correlationId ||
      noSend.envelopeDigest !== pending.envelopeDigest ||
      noSend.sessionBindingId !== pending.sessionBindingId ||
      noSend.acceptedConnectionId !== pending.preparedConnectionId ||
      noSend.durableSessionVersion !== pending.authorizedSessionVersion ||
      noSend.gatewaySequence !== pending.gatewaySequence ||
      noSend.durableSequenceVersion !== pending.authorizedSessionVersion ||
      noSend.leaseVersion !== 1 ||
      !Number.isSafeInteger(noSend.leaseTicket) ||
      noSend.leaseTicket < 1 ||
      !Number.isSafeInteger(noSend.egressEpoch) ||
      noSend.egressEpoch < 0 ||
      typeof noSend.leaseHolderInstanceId !== "string" ||
      noSend.leaseHolderInstanceId.length === 0 ||
      typeof noSend.effectiveMcpSessionId !== "string" ||
      noSend.effectiveMcpSessionId.length === 0 ||
      typeof noSend.principalKey !== "string" ||
      noSend.principalKey.length === 0 ||
      !digestPattern.test(noSend.effectiveScopeDigest) ||
      !digestPattern.test(noSend.proofDigest) ||
      !digestPattern.test(noSend.routeSnapshotDigest) ||
      !digestPattern.test(noSend.intentDigest) ||
      !digestPattern.test(noSend.authorityDigest) ||
      noSend.transportStarted !== false ||
      noSend.cumulativeAck !== null ||
      !Number.isSafeInteger(noSend.recordedAtMs) ||
      noSend.recordedAtMs < 0 ||
      observation.acceptance !== null ||
      observation.journal?.kind !== "known_terminal"
    ) {
      throw new TypeError("no-send receipt is not bound to the exact pending dispatch");
    }
  }
}

function journalAttestation(
  evidence: GatewayVerifiedBridgeJournalEvidence,
): GatewayRecoveryDispatchHistory["journalAttestation"] {
  return Object.freeze({
    kind: evidence.kind,
    evidenceEnvelopeDigest: evidence.envelopeDigest,
    durableJournalVersion: evidence.durableJournalVersion,
    recordedAtMs: evidence.recordedAtMs,
    batchResultDigest: evidence.batchTerminal?.resultDigest ?? null,
  });
}

function sharesApplicationBinding(
  history: GatewayRecoveryDispatchHistory,
  pending: GatewayRecoveryPendingDispatch,
): boolean {
  return pending.mutationEntries.some((pendingEntry) =>
    history.mutationEntries.some(
      (historyEntry) =>
        historyEntry.idempotencyKey === pendingEntry.idempotencyKey &&
        historyEntry.journalBindingDigest === pendingEntry.journalBindingDigest,
    ),
  );
}

function journalEvidenceMatchesHistory(
  evidence: GatewayVerifiedBridgeJournalEvidence,
  history: GatewayRecoveryDispatchHistory,
): boolean {
  return sameValue(evidence, {
    kind: history.journalAttestation.kind,
    rsid: history.envelope.rsid,
    sessionBindingId: history.sessionBindingId,
    envelopeDigest: history.journalAttestation.evidenceEnvelopeDigest,
    journalRecords: history.journalRecords,
    batchTerminal: history.batchTerminal,
    durableJournalVersion: history.journalAttestation.durableJournalVersion,
    recordedAtMs: history.journalAttestation.recordedAtMs,
  });
}

function journalEvidenceFromPending(
  pending: GatewayRecoveryPendingDispatch,
): GatewayVerifiedBridgeJournalEvidence | null {
  const attestation = pending.journalAttestation;
  if (attestation === null) return null;
  return {
    kind: attestation.kind,
    rsid: pending.envelope.rsid,
    sessionBindingId: pending.sessionBindingId,
    envelopeDigest: attestation.evidenceEnvelopeDigest,
    journalRecords: pending.journalRecords,
    batchTerminal: pending.batchTerminal,
    durableJournalVersion: attestation.durableJournalVersion,
    recordedAtMs: attestation.recordedAtMs,
  };
}

function journalEvidenceContent(
  evidence: GatewayVerifiedBridgeJournalEvidence,
): Omit<
  GatewayVerifiedBridgeJournalEvidence,
  "durableJournalVersion" | "recordedAtMs"
> {
  return {
    kind: evidence.kind,
    rsid: evidence.rsid,
    sessionBindingId: evidence.sessionBindingId,
    envelopeDigest: evidence.envelopeDigest,
    journalRecords: evidence.journalRecords,
    batchTerminal: evidence.batchTerminal,
  };
}

function pendingJournalAttestationFault(
  pending: GatewayRecoveryPendingDispatch,
  evidence: GatewayVerifiedBridgeJournalEvidence,
): string | null {
  const retained = journalEvidenceFromPending(pending);
  if (retained === null) return null;
  if (evidence.durableJournalVersion < retained.durableJournalVersion) {
    return "pending_journal_attestation_version_regression";
  }
  if (evidence.durableJournalVersion === retained.durableJournalVersion) {
    return sameValue(evidence, retained)
      ? null
      : "pending_journal_attestation_equal_version_mismatch";
  }
  if (evidence.recordedAtMs < retained.recordedAtMs) {
    return "pending_journal_attestation_timestamp_regression";
  }
  if (retained.kind === "indeterminate" && evidence.kind === "late_terminal") {
    return null;
  }
  return sameValue(
    journalEvidenceContent(evidence),
    journalEvidenceContent(retained),
  )
    ? null
    : "pending_journal_attestation_content_mismatch";
}

function retainedJournalAttestationFault(
  histories: readonly GatewayRecoveryDispatchHistory[],
  pending: GatewayRecoveryPendingDispatch,
  evidence: GatewayVerifiedBridgeJournalEvidence,
): string | null {
  const matchingHistories = histories.filter((history) =>
    sharesApplicationBinding(history, pending),
  );
  for (const history of matchingHistories) {
    if (
      evidence.durableJournalVersion <
      history.journalAttestation.durableJournalVersion
    ) {
      return "journal_attestation_version_regression";
    }
  }
  for (const history of matchingHistories) {
    if (
      evidence.durableJournalVersion ===
        history.journalAttestation.durableJournalVersion &&
      !journalEvidenceMatchesHistory(evidence, history)
    ) {
      return "journal_attestation_equal_version_mismatch";
    }
  }
  if (
    evidence.kind === "known_terminal" &&
    matchingHistories.some((history) => history.status === "indeterminate")
  ) {
    return "indeterminate_journal_reclassification";
  }
  return null;
}

function assertPendingIntegrity(
  pending: GatewayRecoveryPendingDispatch,
  rsid: string,
): void {
  const derived = deriveEnvelope(pending.envelope, rsid);
  if (
    pending.envelopeDigest !== derived.digest ||
    pending.gatewaySequence !== derived.envelope.seq ||
    !sameValue(pending.mutationEntries, derived.mutationEntries) ||
    !sameValue(pending.recoveryClearances, derived.clearances)
  ) {
    throw new TypeError(
      "pending recovery dispatch is not bound to its exact envelope",
    );
  }
  assertBoundedString(pending.sessionBindingId, "sessionBindingId");
  assertBoundedString(pending.preparedConnectionId, "preparedConnectionId");
  assertSafePositiveInteger(
    pending.authorizedSessionVersion,
    "authorizedSessionVersion",
  );
  assertSafeNonNegativeInteger(pending.preparedAtMs, "preparedAtMs");
  if (
    !sameStrings(
      pending.requiredSessionCapabilities,
      requiredSessionCapabilities(derived),
    )
  ) {
    throw new TypeError(
      "pending recovery dispatch has stale session capability authority",
    );
  }
  assertJournalBindings(pending.journalRecords, derived.bindings);
  if (pending.journalAttestation === null) {
    if (pending.batchTerminal !== null) {
      throw new TypeError("pending batch terminal lacks a journal attestation");
    }
  } else {
    assertJournalEvidenceIntegrity(
      {
        kind: pending.journalAttestation.kind,
        rsid,
        sessionBindingId: pending.sessionBindingId,
        envelopeDigest: pending.journalAttestation.evidenceEnvelopeDigest,
        journalRecords: pending.journalRecords,
        batchTerminal: pending.batchTerminal,
        durableJournalVersion: pending.journalAttestation.durableJournalVersion,
        recordedAtMs: pending.journalAttestation.recordedAtMs,
      },
      pending,
    );
    if (
      pending.journalAttestation.batchResultDigest !==
      (pending.batchTerminal?.resultDigest ?? null)
    ) {
      throw new TypeError("pending batch terminal is not attested");
    }
  }
  assertSortedUnique(pending.recoveryHoldIds, "pending recovery hold ids");
  if (
    !pending.originRedelivery &&
    !sameStrings(
      pending.recoveryClearances.map((clearance) => clearance.hold_id),
      pending.recoveryHoldIds,
    )
  ) {
    throw new TypeError("pending recovery clearances are not every-and-only");
  }
  if (pending.kind === "mutation") {
    if (
      derived.mutationEntries.length === 0 ||
      derived.verificationHoldId !== null
    ) {
      throw new TypeError(
        "pending mutation dispatch has no exact mutation entries",
      );
    }
    if (pending.verificationHoldId !== null) {
      throw new TypeError(
        "pending mutation cannot carry verification correlation",
      );
    }
  } else if (
    derived.envelope.type !== "invoke" ||
    derived.mutationEntries.length !== 0 ||
    derived.verificationHoldId === null ||
    pending.verificationHoldId !== derived.verificationHoldId ||
    pending.recoveryHoldIds.length !== 0 ||
    pending.originRedelivery
  ) {
    throw new TypeError(
      "pending verification dispatch is not an exact correlated read",
    );
  }
  if (pending.bridgeAcceptance !== null) {
    assertReceiptIntegrity(pending.bridgeAcceptance, pending);
  }
}

function assertHistoryIntegrity(
  history: GatewayRecoveryDispatchHistory,
  rsid: string,
  tenantId?: string,
): void {
  const derived = deriveEnvelope(history.envelope, rsid);
  if (
    history.envelopeDigest !== derived.digest ||
    !sameValue(history.mutationEntries, derived.mutationEntries)
  ) {
    throw new TypeError("recovery history is not bound to its exact envelope");
  }
  assertBoundedString(history.sessionBindingId, "history sessionBindingId");
  assertSafePositiveInteger(
    history.authorizedSessionVersion,
    "history authorizedSessionVersion",
  );
  assertSafeNonNegativeInteger(history.recordedAtMs, "history recordedAtMs");
  if (
    !sameStrings(
      history.requiredSessionCapabilities,
      requiredSessionCapabilities(derived),
    )
  ) {
    throw new TypeError(
      "recovery history has stale session capability authority",
    );
  }
  assertSortedUnique(history.holdIds, "history hold ids");
  assertJournalBindings(history.journalRecords, derived.bindings);
  assertBatchTerminalIntegrity({
    envelope: history.envelope,
    journalRecords: history.journalRecords,
    evidenceKind: history.journalAttestation.kind,
    batchTerminal: history.batchTerminal,
  });
  if (
    history.journalAttestation.batchResultDigest !==
    (history.batchTerminal?.resultDigest ?? null)
  ) {
    throw new TypeError("recovery history batch terminal is not attested");
  }
  if (
    !digestPattern.test(history.journalAttestation.evidenceEnvelopeDigest) ||
    (history.journalAttestation.evidenceEnvelopeDigest !==
      history.envelopeDigest &&
      history.journalAttestation.kind !== "late_terminal")
  ) {
    throw new TypeError(
      "recovery history journal attestation is not transport-bound",
    );
  }
  assertSafePositiveInteger(
    history.journalAttestation.durableJournalVersion,
    "history durableJournalVersion",
  );
  assertSafeNonNegativeInteger(
    history.journalAttestation.recordedAtMs,
    "history journal recordedAtMs",
  );
  if (
    history.envelope.type !== "invoke_batch" &&
    history.status === "terminal" &&
    history.journalRecords.some(
      (record) =>
        record.state !== "completed" &&
        record.state !== "failed" &&
        record.state !== "guarded" &&
        record.state !== "cancelled",
    )
  ) {
    throw new TypeError(
      "terminal recovery history contains a non-terminal journal",
    );
  }
  if (
    history.status === "indeterminate" &&
    !history.journalRecords.some((record) => record.state === "indeterminate")
  ) {
    throw new TypeError(
      "indeterminate recovery history contains no indeterminate journal",
    );
  }
  if (history.bridgeAcceptance !== null) {
    const pendingShape: GatewayRecoveryPendingDispatch = {
      kind: derived.mutationEntries.length > 0 ? "mutation" : "verification",
      envelope: history.envelope,
      envelopeDigest: history.envelopeDigest,
      gatewaySequence: history.envelope.seq,
      sessionBindingId: history.sessionBindingId,
      preparedConnectionId: history.bridgeAcceptance.acceptedConnectionId,
      authorizedSessionVersion: history.authorizedSessionVersion,
      requiredSessionCapabilities: history.requiredSessionCapabilities,
      mutationEntries: history.mutationEntries,
      journalRecords: history.journalRecords,
      journalAttestation: null,
      batchTerminal: null,
      recoveryHoldIds: [],
      recoveryClearances: [],
      verificationHoldId: derived.verificationHoldId,
      originRedelivery: false,
      bridgeAcceptance: null,
      preparedAtMs: history.recordedAtMs,
    };
    assertReceiptIntegrity(history.bridgeAcceptance, pendingShape, tenantId);
  }
}

function decodeRecord(
  value: GatewayJsonValue,
  rsid: string,
  tenantId?: string,
): GatewayRecoveryRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("persisted recovery record must be an object");
  }
  const candidate = structuredClone(value) as unknown as GatewayRecoveryRecord;
  if (
    candidate.contractVersion !== GATEWAY_RECOVERY_CONTRACT_VERSION ||
    candidate.rsid !== rsid ||
    !Array.isArray(candidate.dispatchHistory) ||
    !Array.isArray(candidate.evidenceDecisions) ||
    !("invocationWindow" in candidate) ||
    !("ledger" in candidate) ||
    !("resolutionPlan" in candidate) ||
    !("pendingDispatch" in candidate)
  ) {
    throw new TypeError(
      "persisted recovery record has an invalid contract shape",
    );
  }
  if (candidate.invocationWindow !== null) {
    if (
      typeof candidate.invocationWindow !== "object" ||
      Array.isArray(candidate.invocationWindow) ||
      Object.keys(candidate.invocationWindow).length !== 2 ||
      !("attemptId" in candidate.invocationWindow) ||
      !("acquiredAtMs" in candidate.invocationWindow)
    ) {
      throw new TypeError(
        "persisted invocation window has an invalid contract shape",
      );
    }
    assertBoundedString(
      candidate.invocationWindow.attemptId,
      "invocation window attemptId",
      512,
    );
    if (!isGatewayUuidV7(candidate.invocationWindow.attemptId)) {
      throw new TypeError(
        "persisted invocation window attemptId must be UUIDv7",
      );
    }
    assertSafeNonNegativeInteger(
      candidate.invocationWindow.acquiredAtMs,
      "invocation window acquiredAtMs",
    );
  }
  const parsedLedger = mutationHoldLedgerSchema.safeParse(candidate.ledger);
  if (!parsedLedger.success) {
    throw new TypeError(
      "persisted recovery ledger does not match the frozen schema",
    );
  }
  const ledger = parsedLedger.data as unknown as MutationHoldLedger;
  assertLedgerIntegrity(ledger, rsid);
  const parsedDecisions = z
    .array(evidenceDecisionAuditSchema)
    .safeParse(candidate.evidenceDecisions);
  if (!parsedDecisions.success) {
    throw new TypeError(
      "persisted recovery evidence decisions do not match the contract",
    );
  }
  const evidenceDecisions =
    parsedDecisions.data as readonly GatewayRecoveryEvidenceDecisionAudit[];
  const auditIds = evidenceDecisions.map((decision) => decision.auditId);
  if (new Set(auditIds).size !== auditIds.length) {
    throw new TypeError(
      "persisted recovery evidence decisions repeat an audit id",
    );
  }
  if (candidate.resolutionPlan !== null) {
    assertPlanIntegrity(
      candidate.resolutionPlan,
      ledger,
      rsid,
      evidenceDecisions,
    );
  }
  if (candidate.pendingDispatch !== null) {
    if (candidate.invocationWindow === null) {
      throw new TypeError(
        "pending recovery dispatch requires an invocation window",
      );
    }
    assertPendingIntegrity(candidate.pendingDispatch, rsid);
  }
  const historyDigests = new Set<string>();
  for (const history of candidate.dispatchHistory) {
    assertHistoryIntegrity(history, rsid, tenantId);
    if (historyDigests.has(history.envelopeDigest)) {
      throw new TypeError(
        "persisted recovery history repeats an envelope digest",
      );
    }
    historyDigests.add(history.envelopeDigest);
  }
  return structuredClone({ ...candidate, ledger, evidenceDecisions });
}

function emptyRecord(rsid: string): GatewayRecoveryRecord {
  return {
    contractVersion: GATEWAY_RECOVERY_CONTRACT_VERSION,
    rsid,
    invocationWindow: null,
    evidenceDecisions: [],
    ledger: createMutationHoldLedger(),
    resolutionPlan: null,
    pendingDispatch: null,
    dispatchHistory: [],
  };
}

async function loadRecord(
  tx: StoreTransaction,
  rsid: string,
): Promise<LoadedRecoveryRecord> {
  const stored = await tx.read(GATEWAY_RECOVERY_NAMESPACE, rsid);
  return {
    value:
      stored === null
        ? emptyRecord(rsid)
        : decodeRecord(stored.value, rsid, stored.tenantId),
    stored,
  };
}

function stageRecord(
  tx: StoreTransaction,
  loaded: LoadedRecoveryRecord,
  value: GatewayRecoveryRecord,
): void {
  tx.stage({
    namespace: GATEWAY_RECOVERY_NAMESPACE,
    key: value.rsid,
    value: structuredClone(value) as unknown as GatewayJsonValue,
    expect:
      loaded.stored === null
        ? { kind: "absent" }
        : { kind: "version", version: loaded.stored.version },
  });
}

function historyWith(
  current: readonly GatewayRecoveryDispatchHistory[],
  next: GatewayRecoveryDispatchHistory,
): readonly GatewayRecoveryDispatchHistory[] {
  return Object.freeze([
    ...current.filter((entry) => entry.envelopeDigest !== next.envelopeDigest),
    next,
  ]);
}

function deepFreezeSnapshot<T>(input: T): T {
  const snapshot = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
      return;
    }
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

function freezePending(
  input: GatewayRecoveryPendingDispatch,
): GatewayRecoveryPendingDispatch {
  return deepFreezeSnapshot(input);
}

function freezePlan(
  input: GatewayRecoveryResolutionPlan,
): GatewayRecoveryResolutionPlan {
  return deepFreezeSnapshot(input);
}

function makePending(input: {
  readonly kind: "mutation" | "verification";
  readonly derived: DerivedEnvelope;
  readonly sessionBindingId: string;
  readonly connectionId: string;
  readonly authorizedSessionVersion: number;
  readonly recoveryHoldIds?: readonly string[];
  readonly verificationHoldId?: string | null;
  readonly originRedelivery?: boolean;
  readonly journalRecords?: readonly InvocationJournalRecord[];
  readonly preparedAtMs: number;
}): GatewayRecoveryPendingDispatch {
  assertBoundedString(input.sessionBindingId, "sessionBindingId");
  assertBoundedString(input.connectionId, "connectionId");
  const pending: GatewayRecoveryPendingDispatch = {
    kind: input.kind,
    envelope: input.derived.envelope,
    envelopeDigest: input.derived.digest,
    gatewaySequence: input.derived.envelope.seq,
    sessionBindingId: input.sessionBindingId,
    preparedConnectionId: input.connectionId,
    authorizedSessionVersion: input.authorizedSessionVersion,
    requiredSessionCapabilities: requiredSessionCapabilities(input.derived),
    mutationEntries: input.derived.mutationEntries,
    journalRecords:
      input.journalRecords ?? createJournalRecords(input.derived.bindings),
    journalAttestation: null,
    batchTerminal: null,
    recoveryHoldIds: input.recoveryHoldIds ?? [],
    recoveryClearances: input.derived.clearances,
    verificationHoldId: input.verificationHoldId ?? null,
    originRedelivery: input.originRedelivery ?? false,
    bridgeAcceptance: null,
    preparedAtMs: input.preparedAtMs,
  };
  assertPendingIntegrity(pending, pending.envelope.rsid);
  return freezePending(pending);
}

function snapshotInput<T>(input: T): T | null {
  try {
    return structuredClone(input);
  } catch {
    return null;
  }
}

/**
 * structuredClone deliberately drops frozen descriptors. Confirmation proof
 * scope is an authority carrier, so restore it as a fresh frozen v1 object at
 * the recovery boundary before it reaches confirmation validation.
 */
function restoreFrozenConfirmationScope<T extends {
  readonly confirmationProof?: GatewayConfirmationProof;
}>(input: T): T {
  if (input.confirmationProof === undefined) return input;
  const carried = input.confirmationProof.effectiveMcpRequestScope;
  const effectiveMcpRequestScope = Object.freeze({
    contractVersion: carried.contractVersion,
    principalKey: carried.principalKey,
    effectiveMcpSessionId: carried.effectiveMcpSessionId,
    transportMcpSessionId: carried.transportMcpSessionId,
    identityMcpSessionId: carried.identityMcpSessionId,
  });
  return Object.freeze({
    ...input,
    confirmationProof: Object.freeze({
      ...input.confirmationProof,
      effectiveMcpRequestScope,
    }),
  }) as T;
}

function protocolFault(reason: string): GatewayRecoveryProtocolFault {
  return Object.freeze({ kind: "protocol_fault" as const, reason });
}

function invocationWindowFault(
  record: GatewayRecoveryRecord,
  attemptId: string,
): GatewayRecoveryProtocolFault | null {
  if (record.invocationWindow === null) {
    return protocolFault("invocation_window_not_acquired");
  }
  return record.invocationWindow.attemptId === attemptId
    ? null
    : protocolFault("invocation_window_attempt_mismatch");
}

export class GatewayRecoveryAuthority {
  readonly #store: GatewayProtocolStore;
  readonly #bridgeEvidence: GatewayDurableBridgeEvidencePort;
  readonly #evidenceDecision: GatewayAuditedRecoveryDecisionPort;
  readonly #confirmationAuthority:
    | GatewayConfirmationTransactionAuthority
    | undefined;
  readonly #clock: () => number;
  readonly #newId: (timestampMs: number) => string;

  public constructor(
    store: GatewayProtocolStore,
    options: GatewayRecoveryAuthorityOptions,
  ) {
    if (
      options.bridgeEvidence === undefined ||
      typeof options.bridgeEvidence.inspectDispatch !== "function" ||
      typeof options.bridgeEvidence.authorizeDispatchTarget !== "function" ||
      typeof options.bridgeEvidence.authorizeResumeTarget !== "function"
    ) {
      throw new TypeError(
        "Gateway recovery authority requires durable Bridge evidence",
      );
    }
    if (
      options.evidenceDecision === undefined ||
      typeof options.evidenceDecision.decideEvidence !== "function"
    ) {
      throw new TypeError(
        "Gateway recovery authority requires audited evidence decisions",
      );
    }
    if (
      options.confirmationAuthority !== undefined &&
      !options.confirmationAuthority.usesStore(store)
    ) {
      throw new TypeError(
        "Gateway recovery and confirmation authorities must share one durable store",
      );
    }
    this.#store = store;
    this.#bridgeEvidence = options.bridgeEvidence;
    this.#evidenceDecision = options.evidenceDecision;
    this.#confirmationAuthority = options.confirmationAuthority;
    this.#clock = options.clock ?? Date.now;
    this.#newId = options.newId ?? gatewayUuidV7;
  }

  async #transact<T>(
    tenantId: string,
    operation: (tx: StoreTransaction) => Promise<T> | T,
  ): Promise<T | GatewayRecoveryStoreFailure> {
    try {
      const outcome = await this.#store.transact({ tenantId }, operation);
      if (outcome.ok) return outcome.value;
      return Object.freeze({
        kind: "unavailable" as const,
        code: outcome.code,
        message: outcome.message,
      });
    } catch (error) {
      return Object.freeze({
        kind: "unavailable" as const,
        code: "unavailable" as const,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #mintId(): string {
    const id = this.#newId(this.#clock());
    if (!isGatewayUuidV7(id)) {
      throw new TypeError(
        "Gateway recovery authority must mint UUIDv7 identifiers",
      );
    }
    return id;
  }

  async #transactInvocationWindow<T>(
    tenantId: string,
    operation: (tx: StoreTransaction) => Promise<T> | T,
  ): Promise<T | GatewayRecoveryStoreFailure> {
    let result: T | GatewayRecoveryStoreFailure;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await this.#transact(tenantId, operation);
      if (
        typeof result !== "object" ||
        result === null ||
        !("kind" in result) ||
        result.kind !== "unavailable" ||
        !("code" in result) ||
        result.code !== "conflict"
      ) {
        return result;
      }
    }
    return result!;
  }

  public async acquireInvocationWindow(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly attemptId: string;
  }): Promise<GatewayRecoveryWindowAcquireResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    let acquiredAtMs: number;
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.rsid, "rsid", 512);
      assertBoundedString(frozen.attemptId, "attemptId", 512);
      if (!isGatewayUuidV7(frozen.attemptId))
        throw new TypeError("attemptId must be UUIDv7");
      acquiredAtMs = this.#clock();
      assertSafeNonNegativeInteger(
        acquiredAtMs,
        "invocation window acquiredAtMs",
      );
    } catch {
      return protocolFault("invalid_input");
    }

    const result = await this.#transactInvocationWindow(
      frozen.tenantId,
      async (tx) => {
        const loaded = await loadRecord(tx, frozen.rsid);
        const active = loaded.value.invocationWindow;
        if (active !== null) {
          return active.attemptId === frozen.attemptId
            ? { kind: "already_acquired" as const }
            : {
                kind: "blocked" as const,
                activeAttemptId: active.attemptId,
              };
        }
        if (loaded.value.pendingDispatch !== null) {
          return protocolFault("pending_dispatch_without_invocation_window");
        }
        stageRecord(tx, loaded, {
          ...loaded.value,
          invocationWindow: Object.freeze({
            attemptId: frozen.attemptId,
            acquiredAtMs,
          }),
        });
        return { kind: "acquired" as const };
      },
    );
    return result as GatewayRecoveryWindowAcquireResult;
  }

  public async releaseInvocationWindow(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly attemptId: string;
  }): Promise<GatewayRecoveryWindowReleaseResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.rsid, "rsid", 512);
      assertBoundedString(frozen.attemptId, "attemptId", 512);
      if (!isGatewayUuidV7(frozen.attemptId))
        throw new TypeError("attemptId must be UUIDv7");
    } catch {
      return protocolFault("invalid_input");
    }

    const result = await this.#transactInvocationWindow(
      frozen.tenantId,
      async (tx) => {
        const loaded = await loadRecord(tx, frozen.rsid);
        const active = loaded.value.invocationWindow;
        if (active === null) {
          return loaded.value.pendingDispatch === null
            ? { kind: "already_released" as const }
            : protocolFault("pending_dispatch_without_invocation_window");
        }
        if (active.attemptId !== frozen.attemptId) {
          return protocolFault("invocation_window_attempt_mismatch");
        }
        if (loaded.value.pendingDispatch !== null) {
          return {
            kind: "blocked" as const,
            reason: "dispatch_pending" as const,
          };
        }
        stageRecord(tx, loaded, {
          ...loaded.value,
          invocationWindow: null,
        });
        return { kind: "released" as const };
      },
    );
    return result as GatewayRecoveryWindowReleaseResult;
  }

  async #authorizeDispatchTarget(input: {
    readonly tx: StoreTransaction;
    readonly derived: DerivedEnvelope;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly resume: boolean;
  }): Promise<GatewayBridgeResumeAuthorization> {
    let authorization: GatewayBridgeResumeAuthorization;
    try {
      const target = expectedDispatchTarget(input);
      authorization = input.resume
        ? await this.#bridgeEvidence.authorizeResumeTarget(input.tx, target)
        : await this.#bridgeEvidence.authorizeDispatchTarget(input.tx, target);
    } catch (error) {
      return {
        kind: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (authorization.kind === "authorized") {
      try {
        assertSafePositiveInteger(
          authorization.sessionVersion,
          "authorized Bridge session version",
        );
      } catch {
        return { kind: "not_authorized", reason: "invalid_session_version" };
      }
    } else if (authorization.kind === "not_authorized") {
      try {
        assertBoundedString(
          authorization.reason,
          "dispatch authorization reason",
          256,
        );
      } catch {
        return {
          kind: "not_authorized",
          reason: "invalid_authorization_reason",
        };
      }
    }
    return authorization;
  }

  async #authorizeEvidenceDecision(input: {
    readonly tx: StoreTransaction;
    readonly candidate: GatewayRecoveryEvidenceCandidate;
  }): Promise<
    | {
        readonly kind: "decided";
        readonly audit: GatewayRecoveryEvidenceDecisionAudit;
      }
    | { readonly kind: "rejected"; readonly reason: string }
    | { readonly kind: "unavailable"; readonly message: string }
  > {
    let decision: GatewayRecoveryEvidenceDecision;
    try {
      decision = await this.#evidenceDecision.decideEvidence(
        input.tx,
        deepFreezeSnapshot(input.candidate),
      );
    } catch (error) {
      return {
        kind: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (decision.kind === "unavailable") {
      return { kind: "unavailable", message: decision.message };
    }
    if (decision.kind === "rejected") {
      return { kind: "rejected", reason: decision.reason };
    }
    const journal = input.candidate.journalRecord;
    const terminalOutcome =
      input.candidate.basis === "verification_read"
        ? journal.terminalOutcome
        : journal.lateTerminalOutcome;
    const journalOutcomeDigest =
      input.candidate.basis === "verification_read"
        ? journal.terminalOutcomeDigest
        : journal.lateTerminalOutcomeDigest;
    try {
      assertBoundedString(
        decision.authorityReference,
        "evidence decision authorityReference",
        512,
      );
      assertSafePositiveInteger(
        decision.decisionVersion,
        "evidence decision version",
      );
      assertSafeNonNegativeInteger(
        decision.decidedAtMs,
        "evidence decision timestamp",
      );
      if (
        ![
          "non_execution_proven",
          "postcondition_verified",
          "inconclusive",
          "failed",
          "omitted",
          "ambiguous",
        ].includes(decision.conclusion) ||
        terminalOutcome === null ||
        journalOutcomeDigest === null
      ) {
        throw new TypeError("invalid audited evidence decision");
      }
      if (
        input.candidate.basis === "verification_read" &&
        terminalOutcome.status !== "completed" &&
        (decision.conclusion === "non_execution_proven" ||
          decision.conclusion === "postcondition_verified")
      ) {
        return {
          kind: "rejected",
          reason: "verification_terminal_not_successful",
        };
      }
      const audit: GatewayRecoveryEvidenceDecisionAudit = {
        auditId: this.#mintId(),
        holdId: input.candidate.holdId,
        basis: input.candidate.basis,
        verificationInvocationId: input.candidate.verificationInvocationId,
        originIdempotencyKey: input.candidate.originIdempotencyKey,
        evidenceDigest: input.candidate.evidenceDigest,
        conclusion: decision.conclusion,
        journalBindingDigest: journal.bindingDigest,
        journalOutcomeDigest,
        terminalKind:
          input.candidate.basis === "verification_read"
            ? "terminal"
            : "late_terminal",
        terminalStatus: terminalOutcome.status,
        authorityReference: decision.authorityReference,
        decisionVersion: decision.decisionVersion,
        decidedAtMs: decision.decidedAtMs,
      };
      if (!evidenceDecisionAuditSchema.safeParse(audit).success) {
        throw new TypeError("invalid evidence decision audit");
      }
      return { kind: "decided", audit: Object.freeze(audit) };
    } catch {
      return { kind: "rejected", reason: "invalid_evidence_decision" };
    }
  }

  public async preflightMutation(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly mutationScopes: readonly MutationScope[];
  }): Promise<GatewayRecoveryPreflightResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    let scopes: readonly MutationScope[];
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.rsid, "rsid", 512);
      scopes = normalizeScopes(frozen.mutationScopes);
    } catch {
      return protocolFault("invalid_input");
    }
    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const { value } = await loadRecord(tx, frozen.rsid);
      if (value.pendingDispatch !== null) {
        return {
          kind: "blocked" as const,
          reason: "dispatch_in_flight" as const,
          holdIds: value.pendingDispatch.recoveryHoldIds,
        };
      }
      const conflicts = conflictingMutationHolds(
        value.ledger,
        frozen.rsid,
        scopes,
      );
      return conflicts.length === 0
        ? { kind: "clear" as const }
        : {
            kind: "blocked" as const,
            reason: "mutation_hold" as const,
            holdIds: conflicts.map((hold) => hold.holdId),
          };
    });
    return result as GatewayRecoveryPreflightResult;
  }

  public async planRecoveryClearances(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly mutationScopes: readonly MutationScope[];
    readonly decisions: readonly {
      readonly holdId: string;
      readonly decision: HoldResolutionDecision;
    }[];
  }): Promise<GatewayRecoveryPlanResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    let scopes: readonly MutationScope[];
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.rsid, "rsid", 512);
      scopes = normalizeScopes(frozen.mutationScopes);
      assertSortedUnique(
        frozen.decisions.map((decision) => decision.holdId),
        "resolution decision hold ids",
      );
    } catch {
      return protocolFault("invalid_input");
    }

    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const loaded = await loadRecord(tx, frozen.rsid);
      const record = loaded.value;
      if (record.pendingDispatch !== null) {
        return { kind: "rejected" as const, reason: "dispatch_in_flight" };
      }
      const conflicts = conflictingMutationHolds(
        record.ledger,
        frozen.rsid,
        scopes,
      );
      if (conflicts.length === 0) {
        return { kind: "rejected" as const, reason: "no_conflicting_holds" };
      }
      const conflictIds = conflicts.map((hold) => hold.holdId);
      const decisionIds = frozen.decisions.map((decision) => decision.holdId);
      if (!sameStrings(conflictIds, decisionIds)) {
        return { kind: "blocked" as const, holdIds: conflictIds };
      }
      const draftItems = conflicts.map((hold, index) => {
        const decision = frozen.decisions[index];
        const evidence = hold.selectedEvidence;
        const audit = record.evidenceDecisions.find(
          (candidate) =>
            candidate.holdId === hold.holdId &&
            candidate.basis === evidence?.basis &&
            candidate.verificationInvocationId ===
              evidence?.verificationInvocationId &&
            candidate.evidenceDigest === evidence?.evidenceDigest &&
            candidate.conclusion === evidence?.conclusion &&
            candidate.journalBindingDigest === evidence?.journalBindingDigest &&
            candidate.journalOutcomeDigest === evidence?.journalOutcomeDigest,
        );
        if (
          decision === undefined ||
          evidence === null ||
          audit === undefined ||
          hold.state !== "evidence_recorded" ||
          evidence.conclusion !== decision.decision
        ) {
          return null;
        }
        return {
          holdId: hold.holdId,
          basis: evidence.basis,
          verificationInvocationId: evidence.verificationInvocationId,
          evidenceDigest: evidence.evidenceDigest,
          decision: decision.decision,
          journalBindingDigest: evidence.journalBindingDigest,
          journalOutcomeDigest: evidence.journalOutcomeDigest,
          auditId: audit.auditId,
        };
      });
      if (draftItems.some((item) => item === null)) {
        return { kind: "rejected" as const, reason: "evidence_not_conclusive" };
      }
      const identity = planIdentity({
        rsid: frozen.rsid,
        mutationScopes: scopes,
        items: draftItems as Exclude<(typeof draftItems)[number], null>[],
      });
      if (record.resolutionPlan !== null) {
        return record.resolutionPlan.planIdentity === identity
          ? {
              kind: "already_planned" as const,
              plan: freezePlan(record.resolutionPlan),
            }
          : {
              kind: "rejected" as const,
              reason: "different_resolution_plan_pending",
            };
      }

      let plan: GatewayRecoveryResolutionPlan;
      try {
        const items: GatewayRecoveryResolutionPlanItem[] = conflicts.map(
          (hold, index) => {
            const draft = draftItems[index]!;
            return {
              ...draft,
              resolutionId: this.#mintId(),
            };
          },
        );
        const clearances: RecoveryClearance[] = items.map(
          (item, index) =>
            ({
              hold_id: item.holdId,
              mutation_scope: structuredClone(conflicts[index]!.mutationScope),
              resolution_id: item.resolutionId,
              basis: item.basis,
              verification_invocation_id: item.verificationInvocationId,
              evidence_digest: item.evidenceDigest,
              decision: item.decision,
              audit_id: item.auditId,
            }) as RecoveryClearance,
        );
        plan = {
          planId: this.#mintId(),
          planIdentity: identity,
          rsid: frozen.rsid,
          mutationScopes: scopes,
          items,
          clearances,
          createdAtMs: this.#clock(),
        };
        assertPlanIntegrity(
          plan,
          record.ledger,
          frozen.rsid,
          record.evidenceDecisions,
        );
      } catch {
        return { kind: "rejected" as const, reason: "identifier_mint_failed" };
      }
      const next: GatewayRecoveryRecord = {
        ...record,
        resolutionPlan: plan,
      };
      stageRecord(tx, loaded, next);
      return { kind: "planned" as const, plan: freezePlan(plan) };
    });
    return result as GatewayRecoveryPlanResult;
  }

  public async prepareMutationDispatch(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    readonly expected: GatewayExpectedMutationDispatch;
    readonly confirmationProof?: GatewayConfirmationProof;
  }): Promise<GatewayRecoveryPrepareResult> {
    const snapshot = snapshotInput(input);
    if (snapshot === null) return protocolFault("invalid_input");
    const frozen = restoreFrozenConfirmationScope(snapshot);
    let derived: DerivedEnvelope;
    let confirmedPolicyId: string | null = null;
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.attemptId, "attemptId", 512);
      if (!isGatewayUuidV7(frozen.attemptId)) {
        throw new TypeError("attemptId must be UUIDv7");
      }
      assertBoundedString(frozen.sessionBindingId, "sessionBindingId", 512);
      assertBoundedString(frozen.connectionId, "connectionId", 512);
      derived = deriveEnvelope(frozen.envelope);
      if (
        derived.mutationEntries.length === 0 ||
        derived.verificationHoldId !== null
      ) {
        throw new TypeError(
          "mutation dispatch must contain a mutating invocation",
        );
      }
      assertBoundedString(frozen.expected.rsid, "expected rsid", 512);
      assertBoundedString(
        frozen.expected.correlationId,
        "expected correlationId",
        512,
      );
      if (
        frozen.expected.rsid !== derived.envelope.rsid ||
        frozen.expected.correlationId !== derived.correlationId ||
        !sameValue(frozen.expected.recoveryClearances, derived.clearances) ||
        frozen.expected.bindings.length !== derived.bindings.length ||
        frozen.expected.bindings.some(
          (binding, index) =>
            makeJournalBindingDigest(binding) !==
            makeJournalBindingDigest(derived.bindings[index]!),
        )
      ) {
        throw new TypeError(
          "mutation envelope is not bound to server-authored dispatch authority",
        );
      }
      if (this.#confirmationAuthority !== undefined) {
        const confirmedBindings = derived.bindings.filter(
          (binding) => binding.policy.class === "confirm",
        );
        if (confirmedBindings.length > 0) {
          const confirmationIds = new Set(
            confirmedBindings.map((binding) => binding.policy.confirmation_id),
          );
          if (
            confirmedBindings.length !== derived.bindings.length ||
            confirmationIds.size !== 1 ||
            confirmedBindings.some(
              (binding) =>
                binding.policy.decision !== "confirmed" ||
                binding.policy.confirmation_id === null,
            )
          ) {
            throw new TypeError("confirmed mutation policy is inconsistent");
          }
          confirmedPolicyId = confirmedBindings[0]!.policy.confirmation_id;
          if (
            frozen.confirmationProof === undefined ||
            frozen.confirmationProof.commitInvocationId !==
              derived.correlationId ||
            confirmationIdFromToken(frozen.confirmationProof.confirmToken) !==
              confirmedPolicyId
          ) {
            throw new TypeError(
              "confirmed mutation is missing its exact confirmation proof",
            );
          }
        } else if (frozen.confirmationProof !== undefined) {
          throw new TypeError(
            "non-confirm mutation cannot carry a confirmation proof",
          );
        }
      }
    } catch {
      return protocolFault("invalid_input");
    }

    const confirmationAtMs = this.#clock();
    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const confirmationValidation =
        frozen.confirmationProof === undefined
          ? null
          : this.#confirmationAuthority === undefined
            ? null
            : await this.#confirmationAuthority.validatePendingAction(
                tx,
                frozen.confirmationProof,
                confirmationAtMs,
              );
      if (
        frozen.confirmationProof !== undefined &&
        this.#confirmationAuthority === undefined
      ) {
        return {
          kind: "unavailable" as const,
          code: "not_implemented" as const,
          message: "durable confirmation authority is not configured",
        };
      }
      if (
        confirmationValidation !== null &&
        confirmationValidation.kind === "rejected"
      ) {
        return {
          kind: "confirmation_rejected" as const,
          reason: confirmationValidation.reason,
          confirmationId: confirmationValidation.confirmationId,
          pendingAction: confirmationValidation.pendingAction,
        };
      }
      const loaded = await loadRecord(tx, derived.envelope.rsid);
      const record = loaded.value;
      const windowFault = invocationWindowFault(record, frozen.attemptId);
      if (windowFault !== null) return windowFault;
      const retained = classifyRetainedIdentity(record, derived);
      if (retained.kind === "exact_pending") {
        return retained.pending.sessionBindingId === frozen.sessionBindingId &&
          retained.pending.preparedConnectionId === frozen.connectionId
          ? {
              kind: "already_prepared" as const,
              dispatch: freezePending(retained.pending),
            }
          : protocolFault("pending_redelivery_requires_retained_path");
      }
      if (retained.kind === "exact_terminal") {
        return {
          kind: "replay_terminal" as const,
          history: structuredClone(retained.history),
        };
      }
      if (retained.kind === "exact_indeterminate") {
        return protocolFault("origin_redelivery_requires_retained_path");
      }
      if (retained.kind === "protocol_fault") {
        return protocolFault(retained.reason);
      }
      if (record.pendingDispatch !== null) {
        return {
          kind: "blocked" as const,
          reason: "dispatch_in_flight",
          holdIds: record.pendingDispatch.recoveryHoldIds,
        };
      }

      const scopes = derived.mutationEntries.map(
        (entry) => entry.mutationScope,
      );
      const conflicts = conflictingMutationHolds(
        record.ledger,
        record.rsid,
        scopes,
      );
      let ledger = record.ledger;
      let recoveryHoldIds: readonly string[] = [];
      if (conflicts.length === 0) {
        if (derived.clearances.length !== 0) {
          return protocolFault("foreign_clearance");
        }
      } else {
        const plan = record.resolutionPlan;
        if (derived.clearances.length === 0) {
          return {
            kind: "blocked" as const,
            reason: "mutation_hold",
            holdIds: conflicts.map((hold) => hold.holdId),
          };
        }
        if (
          plan === null ||
          !sameValue(plan.mutationScopes, normalizeScopes(scopes)) ||
          !sameValue(plan.clearances, derived.clearances)
        ) {
          return protocolFault("resolution_plan_mismatch");
        }
        for (const item of plan.items) {
          const resolved = resolveMutationHold(ledger, {
            rsid: record.rsid,
            holdId: item.holdId,
            basis: item.basis,
            verificationInvocationId: item.verificationInvocationId,
            evidenceDigest: item.evidenceDigest,
            decision: item.decision,
            resolutionId: item.resolutionId,
            auditId: item.auditId,
            authorizedDispatchIdentity: derived.digest,
          });
          if (resolved.kind === "rejected") {
            return protocolFault(`hold_resolution_${resolved.reason}`);
          }
          ledger = resolved.ledger;
        }
        const authorization = authorizeMutationDispatch(ledger, {
          rsid: record.rsid,
          mutationScopes: scopes,
          recoveryClearances: derived.clearances,
          dispatchIdentity: derived.digest,
        });
        if (authorization.kind === "blocked") {
          return {
            kind: "blocked" as const,
            reason: "mutation_hold",
            holdIds: authorization.conflictingHolds.map((hold) => hold.holdId),
          };
        }
        if (authorization.kind === "protocol_fault") {
          return protocolFault(authorization.reason);
        }
        // Deliberately discard authorization.ledger. Bridge durable acceptance
        // is the only event that may persist the cleared form.
        recoveryHoldIds = authorization.clearedHoldIds;
      }

      const targetAuthorization = await this.#authorizeDispatchTarget({
        tx,
        derived,
        sessionBindingId: frozen.sessionBindingId,
        connectionId: frozen.connectionId,
        resume: false,
      });
      if (targetAuthorization.kind === "unavailable") {
        return {
          kind: "unavailable" as const,
          code: "unavailable" as const,
          message: targetAuthorization.message,
        };
      }
      if (targetAuthorization.kind !== "authorized") {
        return {
          kind: "blocked" as const,
          reason: `dispatch_target_${targetAuthorization.reason}`,
          holdIds: recoveryHoldIds,
        };
      }

      const pending = makePending({
        kind: "mutation",
        derived,
        sessionBindingId: frozen.sessionBindingId,
        connectionId: frozen.connectionId,
        authorizedSessionVersion: targetAuthorization.sessionVersion,
        recoveryHoldIds,
        preparedAtMs: this.#clock(),
      });
      const next: GatewayRecoveryRecord = {
        ...record,
        ledger,
        resolutionPlan: conflicts.length === 0 ? record.resolutionPlan : null,
        pendingDispatch: pending,
      };
      if (
        confirmationValidation !== null &&
        confirmationValidation.kind === "validated"
      ) {
        if (
          confirmedPolicyId === null ||
          confirmationValidation.pendingAction.confirmationId !==
            confirmedPolicyId
        ) {
          return protocolFault("confirmation_policy_binding_mismatch");
        }
        this.#confirmationAuthority!.stageConsumption(
          tx,
          confirmationValidation,
          derived.correlationId,
          confirmationAtMs,
        );
      }
      stageRecord(tx, loaded, next);
      return { kind: "prepared" as const, dispatch: pending };
    });
    return result as GatewayRecoveryPrepareResult;
  }

  /**
   * Returns only the exact persisted outbox envelope after a trusted resume
   * binding check. Callers cannot supply a replacement id, sequence, payload,
   * scope, policy, or clearance array.
   */
  public async resumePendingDispatch(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly sessionBindingId: string;
    readonly connectionId: string;
  }): Promise<GatewayRecoveryResumeResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.rsid, "rsid", 512);
      assertBoundedString(frozen.sessionBindingId, "sessionBindingId", 512);
      assertBoundedString(frozen.connectionId, "connectionId", 512);
    } catch {
      return protocolFault("invalid_input");
    }
    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const loaded = await loadRecord(tx, frozen.rsid);
      const pending = loaded.value.pendingDispatch;
      if (pending === null) return { kind: "none" as const };
      if (pending.sessionBindingId !== frozen.sessionBindingId) {
        return protocolFault("session_binding_mismatch");
      }
      const authorization = await this.#authorizeDispatchTarget({
        tx,
        derived: deriveEnvelope(pending.envelope, frozen.rsid),
        sessionBindingId: pending.sessionBindingId,
        connectionId: frozen.connectionId,
        resume: true,
      });
      if (authorization.kind === "unavailable") {
        return {
          kind: "unavailable" as const,
          code: "unavailable" as const,
          message: authorization.message,
        };
      }
      if (authorization.kind !== "authorized") {
        return {
          kind: "blocked" as const,
          reason: `resume_target_${authorization.reason}`,
        };
      }
      if (authorization.sessionVersion < pending.authorizedSessionVersion) {
        return {
          kind: "blocked" as const,
          reason: "resume_session_version_regression",
        };
      }
      if (pending.bridgeAcceptance !== null) {
        return { kind: "already_accepted" as const };
      }
      const retransmit = freezePending({
        ...pending,
        preparedConnectionId: frozen.connectionId,
        authorizedSessionVersion: authorization.sessionVersion,
      });
      stageRecord(tx, loaded, { ...loaded.value, pendingDispatch: retransmit });
      return { kind: "retransmit" as const, dispatch: retransmit };
    });
    return result as GatewayRecoveryResumeResult;
  }

  public async prepareOriginRedelivery(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly rsid: string;
    readonly idempotencyKey: string;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    readonly expected: GatewayExpectedMutationDispatch;
  }): Promise<GatewayRecoveryPrepareResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    let redelivery: DerivedEnvelope;
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.attemptId, "attemptId", 512);
      if (!isGatewayUuidV7(frozen.attemptId)) {
        throw new TypeError("attemptId must be UUIDv7");
      }
      assertBoundedString(frozen.rsid, "rsid", 512);
      assertBoundedString(frozen.idempotencyKey, "idempotencyKey", 1_024);
      assertBoundedString(frozen.sessionBindingId, "sessionBindingId", 512);
      assertBoundedString(frozen.connectionId, "connectionId", 512);
      if (!frozen.idempotencyKey.startsWith(`${frozen.rsid}/`)) {
        throw new TypeError("origin key has the wrong rsid");
      }
      redelivery = deriveEnvelope(frozen.envelope, frozen.rsid);
      if (
        redelivery.mutationEntries.length === 0 ||
        redelivery.verificationHoldId !== null ||
        frozen.expected.rsid !== redelivery.envelope.rsid ||
        frozen.expected.correlationId !== redelivery.correlationId ||
        !sameValue(frozen.expected.recoveryClearances, redelivery.clearances) ||
        frozen.expected.bindings.length !== redelivery.bindings.length ||
        frozen.expected.bindings.some(
          (binding, index) =>
            makeJournalBindingDigest(binding) !==
            makeJournalBindingDigest(redelivery.bindings[index]!),
        )
      ) {
        throw new TypeError("origin redelivery is not server-authorized");
      }
    } catch {
      return protocolFault("invalid_input");
    }
    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const loaded = await loadRecord(tx, frozen.rsid);
      const record = loaded.value;
      const windowFault = invocationWindowFault(record, frozen.attemptId);
      if (windowFault !== null) return windowFault;
      const history = [...record.dispatchHistory]
        .reverse()
        .find(
          (candidate) =>
            candidate.status === "indeterminate" &&
            candidate.mutationEntries.some(
              (entry) => entry.idempotencyKey === frozen.idempotencyKey,
            ),
        );
      if (history === undefined) return protocolFault("origin_not_retained");
      const origin = deriveEnvelope(history.envelope, frozen.rsid);
      if (
        redelivery.envelope.type !== origin.envelope.type ||
        redelivery.envelope.id === origin.envelope.id ||
        redelivery.envelope.seq <= origin.envelope.seq ||
        redelivery.digest === origin.digest ||
        !sameValue(redelivery.envelope.payload, origin.envelope.payload) ||
        !sameValue(redelivery.bindings, origin.bindings)
      ) {
        return protocolFault("origin_redelivery_binding_mismatch");
      }
      if (history.sessionBindingId !== frozen.sessionBindingId) {
        return protocolFault("session_binding_mismatch");
      }
      if (record.pendingDispatch !== null) {
        return record.pendingDispatch.envelopeDigest === redelivery.digest &&
          record.pendingDispatch.sessionBindingId === frozen.sessionBindingId &&
          record.pendingDispatch.preparedConnectionId === frozen.connectionId
          ? {
              kind: "already_prepared" as const,
              dispatch: freezePending(record.pendingDispatch),
            }
          : {
              kind: "blocked" as const,
              reason: "dispatch_in_flight",
              holdIds: record.pendingDispatch.recoveryHoldIds,
            };
      }
      const targetAuthorization = await this.#authorizeDispatchTarget({
        tx,
        derived: redelivery,
        sessionBindingId: history.sessionBindingId,
        connectionId: frozen.connectionId,
        resume: false,
      });
      if (targetAuthorization.kind === "unavailable") {
        return {
          kind: "unavailable" as const,
          code: "unavailable" as const,
          message: targetAuthorization.message,
        };
      }
      if (targetAuthorization.kind !== "authorized") {
        return {
          kind: "blocked" as const,
          reason: `dispatch_target_${targetAuthorization.reason}`,
          holdIds: history.holdIds,
        };
      }
      const scopes = redelivery.mutationEntries.map(
        (entry) => entry.mutationScope,
      );
      const conflicts = conflictingMutationHolds(
        record.ledger,
        frozen.rsid,
        scopes,
      );
      const conflictIds = conflicts.map((hold) => hold.holdId);
      const exactOrigin =
        conflicts.length > 0 &&
        sameStrings(conflictIds, history.holdIds) &&
        conflicts.every((hold) =>
          hold.originIdempotencyKeys.every((originKey) => {
            const originEntry = history.mutationEntries.find(
              (entry) => entry.idempotencyKey === originKey,
            );
            return (
              originEntry !== undefined &&
              mutationScopesConflict(
                originEntry.mutationScope,
                hold.mutationScope,
              ) &&
              isOriginRedeliveryExempt(record.ledger, frozen.rsid, originKey)
            );
          }),
        );
      if (!exactOrigin) {
        return {
          kind: "blocked" as const,
          reason: "origin_binding_mismatch",
          holdIds: conflictIds,
        };
      }
      const pending = makePending({
        kind: "mutation",
        derived: redelivery,
        sessionBindingId: frozen.sessionBindingId,
        connectionId: frozen.connectionId,
        authorizedSessionVersion: targetAuthorization.sessionVersion,
        // These are the holds created by this exact origin's indeterminate
        // outcome. Any clearance embedded in the retained envelope belongs to
        // its original dispatch and is never re-authorized on redelivery.
        recoveryHoldIds: history.holdIds,
        originRedelivery: true,
        journalRecords: history.journalRecords,
        preparedAtMs: this.#clock(),
      });
      const next = { ...record, pendingDispatch: pending };
      stageRecord(tx, loaded, next);
      return { kind: "prepared" as const, dispatch: pending };
    });
    return result as GatewayRecoveryPrepareResult;
  }

  public async prepareVerificationDispatch(input: {
    readonly tenantId: string;
    readonly attemptId: string;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    readonly expected: GatewayExpectedVerificationDispatch;
  }): Promise<GatewayRecoveryPrepareResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    let derived: DerivedEnvelope;
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.attemptId, "attemptId", 512);
      if (!isGatewayUuidV7(frozen.attemptId)) {
        throw new TypeError("attemptId must be UUIDv7");
      }
      assertBoundedString(frozen.sessionBindingId, "sessionBindingId", 512);
      assertBoundedString(frozen.connectionId, "connectionId", 512);
      derived = deriveEnvelope(frozen.envelope);
      if (
        derived.envelope.type !== "invoke" ||
        derived.mutationEntries.length !== 0 ||
        derived.verificationHoldId === null ||
        derived.clearances.length !== 0
      ) {
        throw new TypeError(
          "verification dispatch must be one correlated read",
        );
      }
      if (
        frozen.expected.rsid !== derived.envelope.rsid ||
        frozen.expected.invocationId !== derived.correlationId ||
        derived.bindings.length !== 1 ||
        makeJournalBindingDigest(frozen.expected.binding) !==
          makeJournalBindingDigest(derived.bindings[0]!)
      ) {
        throw new TypeError(
          "verification envelope is not bound to server-authored dispatch authority",
        );
      }
    } catch {
      return protocolFault("invalid_input");
    }
    const verification = (derived.envelope as VerificationEnvelope).payload
      .verification;
    if (verification === null) {
      return protocolFault("invalid_input");
    }
    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const loaded = await loadRecord(tx, derived.envelope.rsid);
      const record = loaded.value;
      const windowFault = invocationWindowFault(record, frozen.attemptId);
      if (windowFault !== null) return windowFault;
      const retained = classifyRetainedIdentity(record, derived);
      if (retained.kind === "exact_pending") {
        return retained.pending.sessionBindingId === frozen.sessionBindingId &&
          retained.pending.preparedConnectionId === frozen.connectionId
          ? {
              kind: "already_prepared" as const,
              dispatch: freezePending(retained.pending),
            }
          : protocolFault("pending_redelivery_requires_retained_path");
      }
      if (retained.kind === "exact_terminal") {
        return {
          kind: "replay_terminal" as const,
          history: structuredClone(retained.history),
        };
      }
      if (retained.kind === "exact_indeterminate") {
        return protocolFault("origin_redelivery_requires_retained_path");
      }
      if (retained.kind === "protocol_fault") {
        return protocolFault(retained.reason);
      }
      if (record.pendingDispatch !== null) {
        return {
          kind: "blocked" as const,
          reason: "dispatch_in_flight",
          holdIds: record.pendingDispatch.recoveryHoldIds,
        };
      }
      if (record.resolutionPlan !== null) {
        return protocolFault("resolution_plan_pending");
      }
      const hold = record.ledger.holds.find(
        (candidate) =>
          candidate.holdId === verification.hold_id &&
          candidate.rsid === record.rsid &&
          candidate.scopeKey === mutationScopeKey(verification.mutation_scope),
      );
      if (
        hold === undefined ||
        hold.state === "resolved_pending_bridge" ||
        hold.state === "cleared"
      ) {
        return {
          kind: "blocked" as const,
          reason: "verification_hold_invalid",
          holdIds: [verification.hold_id],
        };
      }
      const targetAuthorization = await this.#authorizeDispatchTarget({
        tx,
        derived,
        sessionBindingId: frozen.sessionBindingId,
        connectionId: frozen.connectionId,
        resume: false,
      });
      if (targetAuthorization.kind === "unavailable") {
        return {
          kind: "unavailable" as const,
          code: "unavailable" as const,
          message: targetAuthorization.message,
        };
      }
      if (targetAuthorization.kind !== "authorized") {
        return {
          kind: "blocked" as const,
          reason: `dispatch_target_${targetAuthorization.reason}`,
          holdIds: [verification.hold_id],
        };
      }
      const pending = makePending({
        kind: "verification",
        derived,
        sessionBindingId: frozen.sessionBindingId,
        connectionId: frozen.connectionId,
        authorizedSessionVersion: targetAuthorization.sessionVersion,
        verificationHoldId: verification.hold_id,
        preparedAtMs: this.#clock(),
      });
      stageRecord(tx, loaded, { ...record, pendingDispatch: pending });
      return { kind: "prepared" as const, dispatch: pending };
    });
    return result as GatewayRecoveryPrepareResult;
  }

  public async reconcilePendingDispatch(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly envelopeDigest: string;
  }): Promise<GatewayRecoveryReconcileResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.rsid, "rsid", 512);
      if (!digestPattern.test(frozen.envelopeDigest))
        throw new TypeError("invalid digest");
    } catch {
      return protocolFault("invalid_input");
    }

    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const loaded = await loadRecord(tx, frozen.rsid);
      const record = loaded.value;
      const pending = record.pendingDispatch;
      if (pending === null) {
        const history = record.dispatchHistory.find(
          (candidate) => candidate.envelopeDigest === frozen.envelopeDigest,
        );
        const acceptedClearanceIds =
          history === undefined || history.bridgeAcceptance === null
            ? []
            : deriveEnvelope(history.envelope, frozen.rsid).clearances.map(
                (clearance) => clearance.hold_id,
              );
        if (history === undefined) {
          return {
            kind: "rejected" as const,
            reason: "pending_dispatch_mismatch",
          };
        }
        return history.status === "terminal"
          ? {
              kind: "terminal_recorded" as const,
              installedHoldIds: [],
              clearedHoldIds: acceptedClearanceIds,
              terminalJournalRecords: structuredClone(history.journalRecords),
              terminalBatch: structuredClone(history.batchTerminal),
            }
          : {
              kind: "indeterminate_recorded" as const,
              installedHoldIds: history.holdIds,
              clearedHoldIds: acceptedClearanceIds,
            };
      }
      if (pending.envelopeDigest !== frozen.envelopeDigest) {
        return {
          kind: "rejected" as const,
          reason: "pending_dispatch_mismatch",
        };
      }

      let lookup: GatewayBridgeEvidenceLookup;
      try {
        lookup = await this.#bridgeEvidence.inspectDispatch(
          tx,
          expectedDispatchBinding(pending),
        );
      } catch (error) {
        return {
          kind: "unavailable" as const,
          code: "unavailable" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (lookup.kind === "not_durable_yet") {
        return {
          kind: "pending" as const,
          installedHoldIds: [],
          clearedHoldIds: [],
        };
      }
      if (lookup.kind === "protocol_fault") {
        return protocolFault(`bridge_evidence_${lookup.reason}`);
      }
      if (lookup.kind === "unavailable") {
        return {
          kind: "unavailable" as const,
          code: lookup.code,
          message: lookup.message,
        };
      }
      try {
        assertObservationIntegrity(lookup.observation, pending, frozen.tenantId);
      } catch {
        return protocolFault("bridge_evidence_binding_mismatch");
      }

      const observedJournalEvidence = lookup.observation.journal;
      if (observedJournalEvidence !== null) {
        const attestationFault = retainedJournalAttestationFault(
          record.dispatchHistory,
          pending,
          observedJournalEvidence,
        );
        if (attestationFault !== null) {
          return protocolFault(attestationFault);
        }
        const pendingAttestationFault = pendingJournalAttestationFault(
          pending,
          observedJournalEvidence,
        );
        if (pendingAttestationFault !== null) {
          return protocolFault(pendingAttestationFault);
        }
      }
      const journalEvidence =
        observedJournalEvidence ?? journalEvidenceFromPending(pending);

      const observedAcceptance = lookup.observation.acceptance;
      if (
        pending.bridgeAcceptance !== null &&
        observedAcceptance !== null &&
        !sameValue(pending.bridgeAcceptance, observedAcceptance)
      ) {
        return protocolFault("different_bridge_acceptance");
      }
      const effectiveAcceptance =
        observedAcceptance ?? pending.bridgeAcceptance;
      let ledger = record.ledger;
      let clearedHoldIds: readonly string[] = [];
      if (
        effectiveAcceptance !== null &&
        pending.recoveryHoldIds.length > 0 &&
        !pending.originRedelivery
      ) {
        const authorization = authorizeMutationDispatch(ledger, {
          rsid: record.rsid,
          mutationScopes: pending.mutationEntries.map(
            (entry) => entry.mutationScope,
          ),
          recoveryClearances: pending.recoveryClearances,
          dispatchIdentity: pending.envelopeDigest,
        });
        if (
          authorization.kind !== "allowed" ||
          !sameStrings(authorization.clearedHoldIds, pending.recoveryHoldIds)
        ) {
          return protocolFault(
            authorization.kind === "protocol_fault"
              ? authorization.reason
              : "stale_bridge_acceptance_authorization",
          );
        }
        ledger = authorization.ledger;
        clearedHoldIds = authorization.clearedHoldIds;
      }

      const acceptedPending = freezePending({
        ...pending,
        bridgeAcceptance: effectiveAcceptance,
        ...(journalEvidence === null
          ? {}
          : {
              journalRecords: journalEvidence.journalRecords,
              journalAttestation: journalAttestation(journalEvidence),
              batchTerminal: journalEvidence.batchTerminal,
            }),
      });
      if (journalEvidence === null) {
        if (effectiveAcceptance !== null && pending.bridgeAcceptance === null) {
          stageRecord(tx, loaded, {
            ...record,
            ledger,
            pendingDispatch: acceptedPending,
          });
        }
        return {
          kind:
            effectiveAcceptance === null
              ? ("pending" as const)
              : ("accepted" as const),
          installedHoldIds: [],
          clearedHoldIds,
        };
      }

      // A no-send receipt is authoritative only with the exact terminal
      // journal retained by the durable RBP session.  It proves that neither
      // WSS nor HTTP/SSE crossed its invocation boundary, so it closes this
      // exact pending record without treating a missing ACK as an unknown
      // mutation and without licensing a replay.
      if ((lookup.observation.noSend ?? null) !== null) {
        if (pending.originRedelivery) {
          return protocolFault("origin_redelivery_no_send_not_authoritative");
        }
        const history: GatewayRecoveryDispatchHistory = {
          status: "terminal",
          envelope: pending.envelope,
          envelopeDigest: pending.envelopeDigest,
          sessionBindingId: pending.sessionBindingId,
          authorizedSessionVersion: pending.authorizedSessionVersion,
          requiredSessionCapabilities: pending.requiredSessionCapabilities,
          mutationEntries: pending.mutationEntries,
          journalRecords: journalEvidence.journalRecords,
          batchTerminal: null,
          journalAttestation: journalAttestation(journalEvidence),
          // No mutation was admitted to the bridge. Existing recovery holds
          // remain untouched; this cancellation creates no new hold and
          // clears no unrelated hold.
          holdIds: pending.recoveryHoldIds,
          bridgeAcceptance: null,
          recordedAtMs: this.#clock(),
        };
        assertHistoryIntegrity(history, frozen.rsid);
        stageRecord(tx, loaded, {
          ...record,
          ledger,
          pendingDispatch: null,
          dispatchHistory: historyWith(record.dispatchHistory, history),
        });
        return {
          kind: "terminal_recorded" as const,
          installedHoldIds: [],
          clearedHoldIds: [],
          terminalJournalRecords: structuredClone(journalEvidence.journalRecords),
          terminalBatch: null,
        };
      }

      if (
        pending.originRedelivery &&
        journalEvidence.kind === "known_terminal"
      ) {
        return protocolFault("origin_redelivery_terminal_must_be_late");
      }

      if (pending.kind === "verification") {
        if (journalEvidence.kind !== "known_terminal") {
          return protocolFault("verification_evidence_not_terminal");
        }
        stageRecord(tx, loaded, {
          ...record,
          ledger,
          pendingDispatch: acceptedPending,
        });
        return {
          kind: "verification_evidence_ready" as const,
          installedHoldIds: [],
          clearedHoldIds,
        };
      }

      if (journalEvidence.kind === "known_terminal") {
        if (effectiveAcceptance === null) {
          if (!sameValue(acceptedPending, pending)) {
            stageRecord(tx, loaded, {
              ...record,
              ledger,
              pendingDispatch: acceptedPending,
            });
          }
          return {
            kind: "pending" as const,
            installedHoldIds: [],
            clearedHoldIds: [],
          };
        }
        const history: GatewayRecoveryDispatchHistory = {
          status: "terminal",
          envelope: pending.envelope,
          envelopeDigest: pending.envelopeDigest,
          sessionBindingId: pending.sessionBindingId,
          authorizedSessionVersion: pending.authorizedSessionVersion,
          requiredSessionCapabilities: pending.requiredSessionCapabilities,
          mutationEntries: pending.mutationEntries,
          journalRecords: journalEvidence.journalRecords,
          batchTerminal: journalEvidence.batchTerminal,
          journalAttestation: journalAttestation(journalEvidence),
          holdIds: pending.recoveryHoldIds,
          bridgeAcceptance: effectiveAcceptance,
          recordedAtMs: this.#clock(),
        };
        assertHistoryIntegrity(history, frozen.rsid);
        stageRecord(tx, loaded, {
          ...record,
          ledger,
          pendingDispatch: null,
          dispatchHistory: historyWith(record.dispatchHistory, history),
        });
        return {
          kind: "terminal_recorded" as const,
          installedHoldIds: [],
          clearedHoldIds,
          terminalJournalRecords: structuredClone(
            journalEvidence.journalRecords,
          ),
          terminalBatch: structuredClone(journalEvidence.batchTerminal),
        };
      }

      if (journalEvidence.kind === "late_terminal") {
        const reverseHistoryIndex = pending.originRedelivery
          ? [...record.dispatchHistory]
              .reverse()
              .findIndex(
                (candidate: GatewayRecoveryDispatchHistory) =>
                  candidate.status === "indeterminate" &&
                  sameStrings(candidate.holdIds, pending.recoveryHoldIds) &&
                  pending.mutationEntries.every((entry) =>
                    candidate.mutationEntries.some(
                      (origin: GatewayRecoveryMutationEntry) =>
                        origin.idempotencyKey === entry.idempotencyKey &&
                        origin.journalBindingDigest ===
                          entry.journalBindingDigest,
                    ),
                  ),
              )
          : -1;
        const historyIndex = pending.originRedelivery
          ? reverseHistoryIndex < 0
            ? -1
            : record.dispatchHistory.length - 1 - reverseHistoryIndex
          : record.dispatchHistory.findIndex(
              (candidate) =>
                candidate.envelopeDigest === pending.envelopeDigest,
            );
        const history = record.dispatchHistory[historyIndex];
        if (history === undefined || history.status !== "indeterminate") {
          return protocolFault("late_terminal_origin_not_retained");
        }
        const updatedHistory: GatewayRecoveryDispatchHistory = {
          ...history,
          journalRecords: journalEvidence.journalRecords,
          batchTerminal: journalEvidence.batchTerminal,
          journalAttestation: journalAttestation(journalEvidence),
          bridgeAcceptance: pending.originRedelivery
            ? history.bridgeAcceptance
            : (effectiveAcceptance ?? history.bridgeAcceptance),
          recordedAtMs: this.#clock(),
        };
        assertHistoryIntegrity(updatedHistory, frozen.rsid);
        const histories = [...record.dispatchHistory];
        histories[historyIndex] = updatedHistory;
        stageRecord(tx, loaded, {
          ...record,
          ledger,
          pendingDispatch:
            effectiveAcceptance === null ? acceptedPending : null,
          dispatchHistory: histories,
        });
        return {
          kind: "indeterminate_recorded" as const,
          installedHoldIds: history.holdIds,
          clearedHoldIds,
        };
      }

      const derived = deriveEnvelope(pending.envelope, frozen.rsid);
      const journalsByDigest = new Map(
        journalEvidence.journalRecords.map((journal) => [
          journal.bindingDigest,
          journal,
        ]),
      );
      const atomicBatch =
        derived.envelope.type === "invoke_batch" &&
        derived.envelope.payload.atomic;
      let reportedMismatch = false;
      let uncertain: readonly UncertainMutation[];
      if (atomicBatch) {
        if (
          pending.mutationEntries.some(
            (entry) =>
              journalsByDigest.get(entry.journalBindingDigest)?.state !==
              "indeterminate",
          )
        ) {
          reportedMismatch = true;
        }
        uncertain = pending.mutationEntries.map((entry) => ({
          originIdempotencyKey: entry.idempotencyKey,
          mutationScope: entry.mutationScope,
        }));
      } else {
        uncertain = pending.mutationEntries
          .filter(
            (entry) =>
              journalsByDigest.get(entry.journalBindingDigest)?.state ===
              "indeterminate",
          )
          .map((entry) => ({
            originIdempotencyKey: entry.idempotencyKey,
            mutationScope: entry.mutationScope,
          }));
      }
      if (uncertain.length === 0) {
        return protocolFault("indeterminate_mutation_missing");
      }

      let installedHoldIds: readonly string[] = [];
      const retainsPreAckResolution =
        pending.recoveryHoldIds.length > 0 && effectiveAcceptance === null;
      if (retainsPreAckResolution || pending.originRedelivery) {
        installedHoldIds = pending.originRedelivery
          ? sortedUnique(
              conflictingMutationHolds(
                ledger,
                frozen.rsid,
                uncertain.map((entry) => entry.mutationScope),
              ).map((hold) => hold.holdId),
            )
          : pending.recoveryHoldIds;
      } else {
        const installed = installMutationHolds(ledger, frozen.rsid, uncertain);
        if (installed.kind === "blocked") {
          const everyOrigin = uncertain.every((entry) =>
            isOriginRedeliveryExempt(
              ledger,
              frozen.rsid,
              entry.originIdempotencyKey,
            ),
          );
          if (!everyOrigin) {
            return protocolFault("indeterminate_conflicts_with_existing_hold");
          }
          installedHoldIds = sortedUnique(
            installed.conflictingHolds.map((hold) => hold.holdId),
          );
        } else {
          ledger = installed.ledger;
          installedHoldIds = installed.holds.map((hold) => hold.holdId).sort();
        }
      }

      for (const entry of pending.mutationEntries) {
        const journal = journalsByDigest.get(entry.journalBindingDigest);
        if (!atomicBatch && journal?.state !== "indeterminate") continue;
        const expected = ledger.holds.find(
          (hold) =>
            hold.rsid === frozen.rsid &&
            hold.originIdempotencyKeys.includes(entry.idempotencyKey) &&
            mutationScopesConflict(hold.mutationScope, entry.mutationScope),
        );
        if (
          expected === undefined ||
          journal?.verificationHoldId !== expected.holdId
        ) {
          reportedMismatch = true;
        }
      }

      const history: GatewayRecoveryDispatchHistory = {
        status: "indeterminate",
        envelope: pending.envelope,
        envelopeDigest: pending.envelopeDigest,
        sessionBindingId: pending.sessionBindingId,
        authorizedSessionVersion: pending.authorizedSessionVersion,
        requiredSessionCapabilities: pending.requiredSessionCapabilities,
        mutationEntries: pending.mutationEntries,
        journalRecords: journalEvidence.journalRecords,
        batchTerminal: journalEvidence.batchTerminal,
        journalAttestation: journalAttestation(journalEvidence),
        holdIds: installedHoldIds,
        bridgeAcceptance: effectiveAcceptance,
        recordedAtMs: this.#clock(),
      };
      assertHistoryIntegrity(history, frozen.rsid);
      stageRecord(tx, loaded, {
        ...record,
        ledger,
        pendingDispatch:
          effectiveAcceptance === null
            ? freezePending({
                ...acceptedPending,
                journalRecords: journalEvidence.journalRecords,
                journalAttestation: journalAttestation(journalEvidence),
                batchTerminal: journalEvidence.batchTerminal,
              })
            : null,
        dispatchHistory: historyWith(record.dispatchHistory, history),
      });
      return reportedMismatch
        ? {
            kind: "protocol_fault" as const,
            reason: atomicBatch
              ? "atomic_indeterminate_member_mismatch"
              : "reported_hold_id_mismatch",
            installedHoldIds,
          }
        : {
            kind: "indeterminate_recorded" as const,
            installedHoldIds,
            clearedHoldIds,
          };
    });
    return result as GatewayRecoveryReconcileResult;
  }

  public async recordVerificationEvidence(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly envelopeDigest: string;
  }): Promise<GatewayRecoveryEvidenceResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.rsid, "rsid", 512);
      if (!digestPattern.test(frozen.envelopeDigest))
        throw new TypeError("invalid digest");
    } catch {
      return protocolFault("invalid_input");
    }
    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const loaded = await loadRecord(tx, frozen.rsid);
      const record = loaded.value;
      const pending = record.pendingDispatch;
      if (
        pending === null ||
        pending.kind !== "verification" ||
        pending.envelopeDigest !== frozen.envelopeDigest ||
        pending.verificationHoldId === null ||
        pending.envelope.type !== "invoke"
      ) {
        return {
          kind: "rejected" as const,
          reason: "accepted_verification_not_found",
        };
      }
      if (
        pending.bridgeAcceptance === null ||
        pending.journalAttestation?.kind !== "known_terminal" ||
        pending.journalRecords.length !== 1
      ) {
        return {
          kind: "rejected" as const,
          reason: "verification_evidence_not_durable",
        };
      }
      const acceptance = pending.bridgeAcceptance;
      const journalRecord = pending.journalRecords[0]!;
      const journalEvidence: GatewayVerifiedBridgeJournalEvidence = {
        kind: pending.journalAttestation.kind,
        rsid: frozen.rsid,
        sessionBindingId: pending.sessionBindingId,
        envelopeDigest: pending.journalAttestation.evidenceEnvelopeDigest,
        journalRecords: pending.journalRecords,
        batchTerminal: pending.batchTerminal,
        durableJournalVersion: pending.journalAttestation.durableJournalVersion,
        recordedAtMs: pending.journalAttestation.recordedAtMs,
      };
      const derived = deriveEnvelope(pending.envelope, frozen.rsid);
      try {
        assertJournalBindings([journalRecord], derived.bindings);
      } catch {
        return {
          kind: "rejected" as const,
          reason: "journal_binding_mismatch",
        };
      }
      const evidenceDigest = journalRecord.terminalOutcome?.resultDigest;
      const verification = pending.envelope.payload.verification!;
      if (evidenceDigest === undefined) {
        return {
          kind: "rejected" as const,
          reason: "journal_result_digest_missing",
        };
      }
      const decision = await this.#authorizeEvidenceDecision({
        tx,
        candidate: {
          rsid: frozen.rsid,
          holdId: pending.verificationHoldId,
          mutationScope: verification.mutation_scope,
          basis: "verification_read",
          verificationInvocationId: pending.envelope.payload.invocation_id,
          originIdempotencyKey: null,
          evidenceDigest,
          journalRecord,
        },
      });
      if (decision.kind === "unavailable") {
        return {
          kind: "unavailable" as const,
          code: "unavailable" as const,
          message: decision.message,
        };
      }
      if (decision.kind === "rejected") {
        return { kind: "rejected" as const, reason: decision.reason };
      }
      const recorded = recordProtocolVerificationEvidence(record.ledger, {
        rsid: frozen.rsid,
        holdId: pending.verificationHoldId,
        mutationScope: verification.mutation_scope,
        verificationInvocationId: pending.envelope.payload.invocation_id,
        evidenceDigest,
        conclusion: decision.audit.conclusion,
        journalRecord,
      });
      if (recorded.kind === "rejected") {
        return { kind: "rejected" as const, reason: recorded.reason };
      }
      const history: GatewayRecoveryDispatchHistory = {
        status: "terminal",
        envelope: pending.envelope,
        envelopeDigest: pending.envelopeDigest,
        sessionBindingId: pending.sessionBindingId,
        authorizedSessionVersion: pending.authorizedSessionVersion,
        requiredSessionCapabilities: pending.requiredSessionCapabilities,
        mutationEntries: [],
        journalRecords: [journalRecord],
        batchTerminal: null,
        journalAttestation: journalAttestation(journalEvidence),
        holdIds: [pending.verificationHoldId],
        bridgeAcceptance: acceptance,
        recordedAtMs: this.#clock(),
      };
      stageRecord(tx, loaded, {
        ...record,
        ledger: recorded.ledger,
        evidenceDecisions: [...record.evidenceDecisions, decision.audit],
        pendingDispatch: null,
        dispatchHistory: historyWith(record.dispatchHistory, history),
      });
      return { kind: recorded.kind, hold: recorded.hold };
    });
    return result as GatewayRecoveryEvidenceResult;
  }

  public async recordLateTerminalEvidence(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly holdId: string;
    readonly originIdempotencyKey: string;
  }): Promise<GatewayRecoveryEvidenceResult> {
    const frozen = snapshotInput(input);
    if (frozen === null) return protocolFault("invalid_input");
    try {
      assertBoundedString(frozen.tenantId, "tenantId", 512);
      assertBoundedString(frozen.rsid, "rsid", 512);
      assertBoundedString(frozen.holdId, "holdId", 128);
      assertBoundedString(
        frozen.originIdempotencyKey,
        "originIdempotencyKey",
        1_024,
      );
    } catch {
      return protocolFault("invalid_input");
    }
    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const loaded = await loadRecord(tx, frozen.rsid);
      const record = loaded.value;
      if (record.resolutionPlan !== null) {
        return { kind: "rejected" as const, reason: "resolution_plan_pending" };
      }
      let retainedOrigin = false;
      let selected:
        | {
            readonly historyIndex: number;
            readonly history: GatewayRecoveryDispatchHistory;
            readonly journalRecord: InvocationJournalRecord;
          }
        | undefined;
      for (
        let historyIndex = record.dispatchHistory.length - 1;
        historyIndex >= 0;
        historyIndex -= 1
      ) {
        const history = record.dispatchHistory[historyIndex];
        if (
          history === undefined ||
          history.status !== "indeterminate" ||
          !history.holdIds.includes(frozen.holdId) ||
          !history.mutationEntries.some(
            (entry) => entry.idempotencyKey === frozen.originIdempotencyKey,
          )
        ) {
          continue;
        }
        retainedOrigin = true;
        if (history.journalAttestation.kind !== "late_terminal") {
          continue;
        }
        const derived = deriveEnvelope(history.envelope, frozen.rsid);
        const expectedBinding = derived.bindings.find(
          (binding) =>
            `${binding.rsid}/${binding.invocationId}` ===
            frozen.originIdempotencyKey,
        );
        const journalRecord = history.journalRecords.find(
          (journal) =>
            expectedBinding !== undefined &&
            journal.bindingDigest === makeJournalBindingDigest(expectedBinding),
        );
        if (
          expectedBinding !== undefined &&
          journalRecord !== undefined &&
          journalRecordIsIntact(journalRecord) &&
          journalRecord.bindingDigest ===
            makeJournalBindingDigest(expectedBinding) &&
          journalRecord.lateTerminalOutcome?.resultDigest !== undefined
        ) {
          selected = { historyIndex, history, journalRecord };
          break;
        }
      }
      if (selected === undefined && !retainedOrigin) {
        return {
          kind: "rejected" as const,
          reason: "origin_dispatch_not_retained",
        };
      }
      if (selected === undefined) {
        return {
          kind: "rejected" as const,
          reason: "late_terminal_digest_missing",
        };
      }
      const { historyIndex, history, journalRecord } = selected;
      const evidenceDigest = journalRecord.lateTerminalOutcome?.resultDigest;
      if (evidenceDigest === undefined) {
        return {
          kind: "rejected" as const,
          reason: "late_terminal_digest_missing",
        };
      }
      const hold = record.ledger.holds.find(
        (candidate) =>
          candidate.rsid === frozen.rsid && candidate.holdId === frozen.holdId,
      );
      if (hold === undefined) {
        return { kind: "rejected" as const, reason: "hold_not_found" };
      }
      const decision = await this.#authorizeEvidenceDecision({
        tx,
        candidate: {
          rsid: frozen.rsid,
          holdId: frozen.holdId,
          mutationScope: hold.mutationScope,
          basis: "late_terminal",
          verificationInvocationId: null,
          originIdempotencyKey: frozen.originIdempotencyKey,
          evidenceDigest,
          journalRecord,
        },
      });
      if (decision.kind === "unavailable") {
        return {
          kind: "unavailable" as const,
          code: "unavailable" as const,
          message: decision.message,
        };
      }
      if (decision.kind === "rejected") {
        return { kind: "rejected" as const, reason: decision.reason };
      }
      const conclusive =
        decision.audit.conclusion === "non_execution_proven" ||
        decision.audit.conclusion === "postcondition_verified";
      if (conclusive && hold.originIdempotencyKeys.length !== 1) {
        return {
          kind: "rejected" as const,
          reason: "late_terminal_requires_single_origin_hold",
        };
      }
      const recorded = recordProtocolLateTerminalEvidence(record.ledger, {
        rsid: frozen.rsid,
        holdId: frozen.holdId,
        originIdempotencyKey: frozen.originIdempotencyKey,
        evidenceDigest,
        conclusion: decision.audit.conclusion,
        journalRecord,
      });
      if (recorded.kind === "rejected") {
        return { kind: "rejected" as const, reason: recorded.reason };
      }
      const updatedJournals = history.journalRecords.map((journal) =>
        journal.bindingDigest === journalRecord.bindingDigest
          ? journalRecord
          : journal,
      );
      const updatedHistory: GatewayRecoveryDispatchHistory = {
        ...history,
        journalRecords: updatedJournals,
        recordedAtMs: this.#clock(),
      };
      const updatedHistories = [...record.dispatchHistory];
      updatedHistories[historyIndex] = updatedHistory;
      stageRecord(tx, loaded, {
        ...record,
        ledger: recorded.ledger,
        evidenceDecisions: [...record.evidenceDecisions, decision.audit],
        dispatchHistory: updatedHistories,
      });
      return { kind: recorded.kind, hold: recorded.hold };
    });
    return result as GatewayRecoveryEvidenceResult;
  }

  public async snapshot(input: {
    readonly tenantId: string;
    readonly rsid: string;
  }): Promise<GatewayRecoveryRecord | GatewayRecoveryStoreFailure> {
    const frozen = snapshotInput(input);
    if (frozen === null) {
      return {
        kind: "unavailable",
        code: "invalid_record",
        message: "snapshot input is not cloneable",
      };
    }
    const result = await this.#transact(frozen.tenantId, async (tx) => {
      const { value } = await loadRecord(tx, frozen.rsid);
      return structuredClone(value);
    });
    return result as GatewayRecoveryRecord | GatewayRecoveryStoreFailure;
  }
}
