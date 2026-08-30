import {
  dataEnvelopeImmutableDigest,
  journalRecordIsIntact,
  makeJournalBindingDigest,
  makeParamsDigest,
  mutationScopeKey,
  type DataEnvelopeSnapshot,
  type InvocationJournalBinding,
  type InvocationJournalRecord,
  type JsonValue,
  type MutationHold,
  type MutationScope,
  type RecoveryClearance,
} from "@revagent/protocol";

import type { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import type { GatewayJsonValue } from "./dispatch.js";
import type { GatewayInvocationContext } from "./invocationContext.js";
import type {
  GatewayAuditedRecoveryDecisionPort,
  GatewayExpectedMutationDispatch,
  GatewayExpectedVerificationDispatch,
  GatewayRecoveryAuthority,
  GatewayRecoveryEvidenceCandidate,
  GatewayRecoveryResolutionPlan,
} from "./recoveryAuthority.js";
import type { GatewayProtocolStore, StoreTransaction } from "./store.js";
import {
  GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE,
  GATEWAY_RBP_SESSION_V3_NAMESPACE,
  SESSION_MARKER_MAX_BYTES,
  SESSION_ROOT_MAX_BYTES,
  sessionCanonicalDigest,
  sessionRecordValueBytes,
} from "./sessionHistoryStore.js";

export const MUTATION_PROBE_VERIFICATION_PROFILE = "mutation-probe-v1" as const;
export const MUTATION_PROBE_OWNER_NAMESPACE = "gateway.conformance-mutation-probe/v1" as const;
export const MUTATION_PROBE_MAX_RECORDS = 64;
export const MUTATION_PROBE_MAX_RECORD_BYTES = 8_192;
export const MUTATION_PROBE_AUTHORIZATION_MS = 600_000;

const GATEWAY_RBP_SESSION_NAMESPACE = "gateway.rbp-session/v1";
const GATEWAY_RECOVERY_NAMESPACE = "gateway.recovery-authority/v1";
const MUTATION_PROBE_RESULT_SCHEMA = "revagent.fixture-mutation-probe/v1";
const EMPTY_PARAMS_DIGEST = makeParamsDigest({});
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const HOLD_ID = /^vh:[0-9a-f]{64}$/u;

type MutationProbePhase =
  | "origin_admitted"
  | "verification_prepared"
  | "plan_ready"
  | "complete";

interface MutationProbeOwnerRecord {
  readonly schema: typeof MUTATION_PROBE_OWNER_NAMESPACE;
  readonly recordVersion: number;
  readonly profile: typeof MUTATION_PROBE_VERIFICATION_PROFILE;
  readonly runId: string;
  readonly rsid: string;
  readonly originInvocationId: string;
  readonly originIdempotencyKey: string;
  readonly originToolName: "conformance.fixture.mutation_probe_origin";
  readonly originToolVersion: "1.0.0";
  readonly originExecutorMethod: "fixture_commit_then_throw";
  readonly tenantId: string;
  readonly userId: string;
  readonly principalKey: string;
  readonly gatewaySessionId: string;
  readonly effectiveMcpSessionId: string;
  readonly sessionBindingId: string;
  readonly sessionBindingVersion: number;
  readonly connectionId: string;
  readonly mutationScope: MutationScope;
  readonly scopeKey: string;
  readonly functionalParamsDigest: string;
  readonly nativeParamsDigest: string;
  readonly originJournalBindingDigest: string;
  readonly originEnvelopeDigest: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly phase: MutationProbePhase;
  readonly holdId: string | null;
  readonly verificationInvocationId: string | null;
  readonly verificationEnvelopeDigest: string | null;
  readonly evidenceDigest: string | null;
  readonly auditId: string | null;
  readonly planId: string | null;
  readonly planIdentity: string | null;
  readonly resolutionId: string | null;
}

export interface MutationProbeOriginAdmission {
  readonly context: GatewayInvocationContext;
  readonly sessionBindingId: string;
  readonly connectionId: string;
  readonly envelope: unknown;
  readonly expected: GatewayExpectedMutationDispatch;
}

export interface MutationProbeVerificationWorkflow {
  readonly profile: typeof MUTATION_PROBE_VERIFICATION_PROFILE;
  readonly evidenceDecision: GatewayAuditedRecoveryDecisionPort;
  recordOrigin(input: MutationProbeOriginAdmission): Promise<boolean>;
  revalidateOriginPending(input: {
    readonly context: GatewayInvocationContext;
    readonly attemptId: string;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelopeDigest: string;
  }): Promise<boolean>;
  prepareVerification(input: {
    readonly context: GatewayInvocationContext;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    readonly binding: GatewayExpectedVerificationDispatch["binding"];
  }): Promise<{
    readonly holdId: string;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    readonly expected: GatewayExpectedVerificationDispatch;
  } | null>;
  recordVerificationPrepared(input: {
    readonly context: GatewayInvocationContext;
    readonly holdId: string;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelopeDigest: string;
  }): Promise<boolean>;
  recordPlan(input: {
    readonly context: GatewayInvocationContext;
    readonly hold: MutationHold;
    readonly plan: GatewayRecoveryResolutionPlan;
  }): Promise<{
    readonly journalRecord: InvocationJournalRecord;
    readonly holdId: string;
    readonly resolutionId: string;
  } | null>;
  prepareNext(input: {
    readonly context: GatewayInvocationContext;
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    readonly expected: GatewayExpectedMutationDispatch;
  }): Promise<{
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    readonly expected: GatewayExpectedMutationDispatch;
  } | null>;
  readAuditProjection(): Promise<Readonly<{
    readonly status: "absent" | "ambiguous" | "current" | "unavailable";
    readonly recordCount: number;
    readonly phase: MutationProbePhase | null;
    readonly ownerCurrent: boolean;
    readonly recordVersion: number | null;
    readonly rsidDigest: string | null;
    readonly originInvocationDigest: string | null;
    readonly holdDigest: string | null;
    readonly verificationInvocationDigest: string | null;
    readonly rawResultDigest: string | null;
    readonly auditDigest: string | null;
    readonly planDigest: string | null;
    readonly resolutionDigest: string | null;
  }>>;
}

interface WorkflowGraph {
  readonly protocolStore: GatewayProtocolStore;
  readonly bridgeAuthority: GatewayBridgeSessionAuthority;
  readonly recoveryAuthority?: GatewayRecoveryAuthority;
}

const issuedWorkflows = new WeakMap<object, WorkflowGraph>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return makeParamsDigest(left as JsonValue) === makeParamsDigest(right as JsonValue);
  } catch {
    return false;
  }
}

function ownerKey(runId: string, rsid: string): string {
  return `${runId}:${rsid}`;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function referenceDigest(kind: string, value: string | null): `sha256:${string}` | null {
  return value === null ? null : makeParamsDigest({
    domain: "revagent.mutation-probe-audit-reference/v1",
    kind,
    value,
  });
}

function ownerRecord(value: unknown): MutationProbeOwnerRecord | null {
  if (!isRecord(value) || value.schema !== MUTATION_PROBE_OWNER_NAMESPACE ||
      value.profile !== MUTATION_PROBE_VERIFICATION_PROFILE ||
      !Number.isSafeInteger(value.recordVersion) || Number(value.recordVersion) < 1 ||
      typeof value.runId !== "string" || typeof value.rsid !== "string" ||
      typeof value.originInvocationId !== "string" || typeof value.originIdempotencyKey !== "string" ||
      value.originToolName !== "conformance.fixture.mutation_probe_origin" ||
      value.originToolVersion !== "1.0.0" || value.originExecutorMethod !== "fixture_commit_then_throw" ||
      typeof value.tenantId !== "string" || typeof value.userId !== "string" ||
      typeof value.principalKey !== "string" || typeof value.gatewaySessionId !== "string" ||
      typeof value.effectiveMcpSessionId !== "string" || typeof value.sessionBindingId !== "string" ||
      !Number.isSafeInteger(value.sessionBindingVersion) || Number(value.sessionBindingVersion) < 1 ||
      typeof value.connectionId !== "string" || !isRecord(value.mutationScope) ||
      typeof value.scopeKey !== "string" || typeof value.functionalParamsDigest !== "string" ||
      typeof value.nativeParamsDigest !== "string" || typeof value.originJournalBindingDigest !== "string" ||
      typeof value.originEnvelopeDigest !== "string" || !DIGEST.test(value.functionalParamsDigest) ||
      !DIGEST.test(value.nativeParamsDigest) || !DIGEST.test(value.originJournalBindingDigest) ||
      !DIGEST.test(value.originEnvelopeDigest) || !Number.isSafeInteger(value.issuedAtMs) ||
      !Number.isSafeInteger(value.expiresAtMs) || Number(value.expiresAtMs) <= Number(value.issuedAtMs) ||
      !["origin_admitted", "verification_prepared", "plan_ready", "complete"].includes(String(value.phase)) ||
      encodedBytes(value) > MUTATION_PROBE_MAX_RECORD_BYTES) return null;
  for (const key of ["holdId", "verificationInvocationId", "verificationEnvelopeDigest", "evidenceDigest",
    "auditId", "planId", "planIdentity", "resolutionId"] as const) {
    const candidate = value[key];
    if (candidate !== null && typeof candidate !== "string") return null;
  }
  return value as unknown as MutationProbeOwnerRecord;
}

interface CurrentSessionAuthority {
  readonly tenantId: string;
  readonly userId: string;
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly sessionVersion: number;
  readonly connectionId: string;
}

async function readCurrentSessionAuthority(
  tx: Pick<StoreTransaction, "read">,
  tenantId: string,
  rsid: string,
): Promise<CurrentSessionAuthority | null> {
  const legacy = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_NAMESPACE, rsid);
  const root = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_V3_NAMESPACE, rsid);
  const marker = await tx.read<GatewayJsonValue>(GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE, rsid);
  if (root !== null || marker !== null) {
    if (legacy !== null || root === null || marker === null || !isRecord(root.value) ||
        !isRecord(marker.value)) return null;
    const value = root.value;
    const cutover = marker.value;
    const identity = value.identity;
    const binding = value.binding;
    const trees = value.trees;
    if (value.schema !== GATEWAY_RBP_SESSION_V3_NAMESPACE || value.generation !== 3 ||
        value.tenantId !== tenantId || value.rsid !== rsid || !Number.isSafeInteger(value.rootVersion) ||
        Number(value.rootVersion) < 1 || root.version !== value.rootVersion ||
        cutover.schema !== GATEWAY_RBP_SESSION_CUTOVER_V3_NAMESPACE || cutover.generation !== 3 ||
        cutover.tenantId !== tenantId || cutover.rsid !== rsid || cutover.rootVersion !== value.rootVersion ||
        marker.version !== value.rootVersion || !Array.isArray(trees) || !isRecord(identity) ||
        !isRecord(binding) || typeof identity.userId !== "string" ||
        typeof binding.sessionBindingId !== "string" || !Number.isSafeInteger(binding.sessionVersion) ||
        Number(binding.sessionVersion) < 1 || typeof binding.connectionId !== "string" ||
        cutover.rootDigest !== sessionCanonicalDigest(root.value) ||
        cutover.treesDigest !== sessionCanonicalDigest(trees as unknown as GatewayJsonValue) ||
        sessionRecordValueBytes(root.value) > SESSION_ROOT_MAX_BYTES ||
        sessionRecordValueBytes(marker.value) > SESSION_MARKER_MAX_BYTES) return null;
    return { tenantId, userId: identity.userId, rsid,
      sessionBindingId: binding.sessionBindingId,
      sessionVersion: Number(binding.sessionVersion), connectionId: binding.connectionId };
  }
  if (legacy === null || !isRecord(legacy.value)) return null;
  const value = legacy.value;
  if (value.schema !== GATEWAY_RBP_SESSION_NAMESPACE || value.tenantId !== tenantId ||
      value.rsid !== rsid || typeof value.userId !== "string" ||
      typeof value.sessionBindingId !== "string" || !Number.isSafeInteger(value.sessionVersion) ||
      Number(value.sessionVersion) < 1 || typeof value.connectionId !== "string") return null;
  return { tenantId, userId: value.userId, rsid, sessionBindingId: value.sessionBindingId,
    sessionVersion: Number(value.sessionVersion), connectionId: value.connectionId };
}

function currentSessionMatches(
  session: CurrentSessionAuthority | null,
  owner: MutationProbeOwnerRecord,
  sessionBindingId = owner.sessionBindingId,
  connectionId = owner.connectionId,
): boolean {
  return session !== null && session.tenantId === owner.tenantId &&
    session.userId === owner.userId && session.rsid === owner.rsid &&
    session.sessionBindingId === owner.sessionBindingId && session.sessionBindingId === sessionBindingId &&
    session.sessionVersion === owner.sessionBindingVersion && session.connectionId === owner.connectionId &&
    session.connectionId === connectionId;
}

function contextMatches(owner: MutationProbeOwnerRecord, context: GatewayInvocationContext): boolean {
  return owner.expiresAtMs > context.startedAtMs && owner.rsid === context.rsid &&
    owner.tenantId === context.actor.tenantId && owner.userId === context.actor.userId &&
    owner.principalKey === context.principalKey && owner.gatewaySessionId === context.gatewaySessionId &&
    owner.effectiveMcpSessionId === context.effectiveMcpRequestScope?.effectiveMcpSessionId;
}

function bindingIsExact(input: {
  readonly binding: InvocationJournalBinding;
  readonly context: GatewayInvocationContext;
  readonly method: string;
  readonly mutating: boolean;
}): boolean {
  const { binding, context } = input;
  return binding.rsid === context.rsid && binding.invocationId === context.invocationId &&
    binding.method === input.method && binding.mutating === input.mutating &&
    binding.paramsDigest === EMPTY_PARAMS_DIGEST && context.paramsDigest === EMPTY_PARAMS_DIGEST &&
    sameJson(binding.mutationScope, context.mutationScope) && binding.policy.class === context.policyClass &&
    binding.policy.decision === context.policyDecision && binding.policy.confirmation_id === context.confirmationId &&
    (binding.recoveryClearances?.length ?? 0) === 0 &&
    (binding.verification === undefined || binding.verification === null);
}

function mutationDraftIsExact(input: {
  readonly context: GatewayInvocationContext;
  readonly expected: GatewayExpectedMutationDispatch;
  readonly method: "fixture_commit_then_throw" | "fixture_complete_mutation_probe";
}): input is typeof input & { readonly context: GatewayInvocationContext & { readonly mutationScope: MutationScope } } {
  return input.context.mutating && input.context.mutationScope !== null &&
    input.expected.rsid === input.context.rsid && input.expected.correlationId === input.context.invocationId &&
    input.expected.bindings.length === 1 && input.expected.recoveryClearances.length === 0 &&
    bindingIsExact({ binding: input.expected.bindings[0]!, context: input.context,
      method: input.method, mutating: true });
}

function envelopeDigest(envelope: unknown): `sha256:${string}` | null {
  try {
    return dataEnvelopeImmutableDigest(envelope as DataEnvelopeSnapshot);
  } catch {
    return null;
  }
}

function exactOriginHold(value: unknown, owner: MutationProbeOwnerRecord): value is MutationHold {
  if (!isRecord(value)) return false;
  return typeof value.holdId === "string" && HOLD_ID.test(value.holdId) && value.rsid === owner.rsid &&
    value.scopeKey === owner.scopeKey && sameJson(value.mutationScope, owner.mutationScope) &&
    Array.isArray(value.originIdempotencyKeys) && value.originIdempotencyKeys.length === 1 &&
    value.originIdempotencyKeys[0] === owner.originIdempotencyKey;
}

function recoveryValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && value.contractVersion === "revagent.gateway-recovery/v1" ? value : null;
}

function resultState(candidate: GatewayRecoveryEvidenceCandidate): { readonly originInvocationId: string } | null {
  const terminal = candidate.journalRecord.terminalOutcome;
  const state = terminal?.payload;
  if (terminal?.status !== "completed" || terminal.payloadRetained !== true || !isRecord(state) ||
      state.schema !== MUTATION_PROBE_RESULT_SCHEMA || state.resultContractVersion !== 2 ||
      state.present !== true || state.complete !== true || typeof state.originInvocationId !== "string" ||
      state.value !== 1 || state.originWriteCount !== 1 || state.nextWriteCount !== 0 ||
      Object.keys(state).sort().join(",") !==
        "complete,nextWriteCount,originInvocationId,originWriteCount,present,resultContractVersion,schema,value") return null;
  return { originInvocationId: state.originInvocationId };
}

export function isMutationProbeVerificationWorkflow(
  value: unknown,
  expected?: Partial<WorkflowGraph>,
): value is MutationProbeVerificationWorkflow {
  if (value === null || typeof value !== "object") return false;
  const graph = issuedWorkflows.get(value as object);
  return graph !== undefined &&
    (expected?.protocolStore === undefined || graph.protocolStore === expected.protocolStore) &&
    (expected?.bridgeAuthority === undefined || graph.bridgeAuthority === expected.bridgeAuthority) &&
    (expected?.recoveryAuthority === undefined || graph.recoveryAuthority === expected.recoveryAuthority);
}

export function bindMutationProbeVerificationWorkflow(input: {
  readonly workflow: MutationProbeVerificationWorkflow;
  readonly protocolStore: GatewayProtocolStore;
  readonly bridgeAuthority: GatewayBridgeSessionAuthority;
  readonly recoveryAuthority: GatewayRecoveryAuthority;
}): void {
  const graph = issuedWorkflows.get(input.workflow as object);
  if (graph === undefined || graph.protocolStore !== input.protocolStore ||
      graph.bridgeAuthority !== input.bridgeAuthority || graph.recoveryAuthority !== undefined) {
    throw new TypeError("mutation probe verification workflow graph mismatch");
  }
  issuedWorkflows.set(input.workflow as object, Object.freeze({ ...graph, recoveryAuthority: input.recoveryAuthority }));
}

export function createMutationProbeVerificationWorkflow(input: {
  readonly protocolStore: GatewayProtocolStore;
  readonly bridgeAuthority: GatewayBridgeSessionAuthority;
  readonly runId: string;
  readonly clock?: () => number;
}): MutationProbeVerificationWorkflow {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(input.runId)) throw new TypeError("invalid mutation probe run id");
  if (input.bridgeAuthority?.store !== input.protocolStore) {
    throw new TypeError("mutation probe Bridge authority must own the exact protocol store");
  }
  const now = input.clock ?? Date.now;

  const evidenceDecision: GatewayAuditedRecoveryDecisionPort = Object.freeze({
    async decideEvidence(tx: Pick<StoreTransaction, "read" | "list">, candidate: GatewayRecoveryEvidenceCandidate) {
      const stored = await tx.read<GatewayJsonValue>(MUTATION_PROBE_OWNER_NAMESPACE, ownerKey(input.runId, candidate.rsid));
      const owner = ownerRecord(stored?.value);
      const session = owner === null ? null : await readCurrentSessionAuthority(tx, owner.tenantId, owner.rsid);
      const recovery = recoveryValue((await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, candidate.rsid))?.value);
      const ledger = recovery?.ledger;
      const holds = isRecord(ledger) && Array.isArray(ledger.holds) ? ledger.holds : [];
      const holdMatches = owner === null ? [] : holds.filter((hold) => exactOriginHold(hold, owner));
      const pending = recovery?.pendingDispatch;
      const binding = candidate.journalRecord.binding as InvocationJournalBinding | undefined;
      const state = resultState(candidate);
      const verification = binding?.verification;
      if (owner === null || owner.phase !== "verification_prepared" || owner.expiresAtMs <= now() ||
          !currentSessionMatches(session, owner) || candidate.basis !== "verification_read" ||
          candidate.originIdempotencyKey !== null || candidate.verificationInvocationId !== owner.verificationInvocationId ||
          candidate.holdId !== owner.holdId || binding === undefined ||
          !journalRecordIsIntact(candidate.journalRecord) || candidate.journalRecord.state !== "completed" ||
          candidate.journalRecord.bindingDigest !== makeJournalBindingDigest(binding) ||
          binding.rsid !== owner.rsid || binding.invocationId !== owner.verificationInvocationId ||
          binding.method !== "fixture_read_mutation_probe" || binding.mutating || binding.mutationScope !== null ||
          binding.paramsDigest !== EMPTY_PARAMS_DIGEST || binding.policy.class !== "auto" ||
          binding.policy.decision !== "auto" || binding.policy.confirmation_id !== null ||
          (binding.recoveryClearances?.length ?? 0) !== 0 || verification === undefined || verification === null ||
          verification.hold_id !== owner.holdId || !sameJson(verification.mutation_scope, owner.mutationScope) ||
          verification.purpose !== "resolve_indeterminate" ||
          candidate.journalRecord.terminalOutcome?.resultDigest !== candidate.evidenceDigest ||
          state === null || state.originInvocationId !== owner.originInvocationId || holdMatches.length !== 1 ||
          !isRecord(pending) || pending.kind !== "verification" ||
          pending.envelopeDigest !== owner.verificationEnvelopeDigest || pending.verificationHoldId !== owner.holdId ||
          pending.sessionBindingId !== owner.sessionBindingId ||
          pending.authorizedSessionVersion !== owner.sessionBindingVersion ||
          pending.preparedConnectionId !== owner.connectionId || pending.bridgeAcceptance === null ||
          !isRecord(pending.journalAttestation) || pending.journalAttestation.kind !== "known_terminal") {
        return Object.freeze({ kind: "rejected" as const, reason: "mutation_probe_postcondition_unverified" });
      }
      return Object.freeze({ kind: "decided" as const, conclusion: "postcondition_verified" as const,
        authorityReference: `mutation-probe-v1:${input.runId}`, decisionVersion: 1, decidedAtMs: now() });
    },
  });

  const workflow: MutationProbeVerificationWorkflow = Object.freeze({
    profile: MUTATION_PROBE_VERIFICATION_PROFILE,
    evidenceDecision,
    async recordOrigin(admission: MutationProbeOriginAdmission) {
      const context = admission.context;
      if (context.toolName !== "conformance.fixture.mutation_probe_origin" || context.toolVersion !== "1.0.0" ||
          context.policyClass !== "confirm" || context.policyDecision !== "confirmed" ||
          context.effectiveMcpRequestScope === undefined ||
          !mutationDraftIsExact({ context, expected: admission.expected, method: "fixture_commit_then_throw" })) return false;
      const binding = admission.expected.bindings[0]!;
      const originEnvelopeDigest = envelopeDigest(admission.envelope);
      if (originEnvelopeDigest === null) return false;
      const issuedAtMs = now();
      const outcome = await input.protocolStore.transact({ tenantId: context.actor.tenantId }, async (tx) => {
        const session = await readCurrentSessionAuthority(tx, context.actor.tenantId, context.rsid);
        if (session === null || session.userId !== context.actor.userId ||
            session.sessionBindingId !== admission.sessionBindingId ||
            session.connectionId !== admission.connectionId) return false;
        const record: MutationProbeOwnerRecord = {
          schema: MUTATION_PROBE_OWNER_NAMESPACE, recordVersion: 1,
          profile: MUTATION_PROBE_VERIFICATION_PROFILE, runId: input.runId, rsid: context.rsid,
          originInvocationId: context.invocationId, originIdempotencyKey: context.idempotencyKey,
          originToolName: "conformance.fixture.mutation_probe_origin", originToolVersion: "1.0.0",
          originExecutorMethod: "fixture_commit_then_throw", tenantId: context.actor.tenantId,
          userId: context.actor.userId, principalKey: context.principalKey,
          gatewaySessionId: context.gatewaySessionId,
          effectiveMcpSessionId: context.effectiveMcpRequestScope!.effectiveMcpSessionId,
          sessionBindingId: admission.sessionBindingId, sessionBindingVersion: session.sessionVersion,
          connectionId: admission.connectionId,
          mutationScope: structuredClone(context.mutationScope) as MutationScope,
          scopeKey: mutationScopeKey(context.mutationScope as MutationScope),
          functionalParamsDigest: context.paramsDigest,
          nativeParamsDigest: binding.paramsDigest, originJournalBindingDigest: makeJournalBindingDigest(binding),
          originEnvelopeDigest, issuedAtMs, expiresAtMs: issuedAtMs + MUTATION_PROBE_AUTHORIZATION_MS,
          phase: "origin_admitted", holdId: null, verificationInvocationId: null,
          verificationEnvelopeDigest: null, evidenceDigest: null, auditId: null,
          planId: null, planIdentity: null, resolutionId: null,
        };
        if (encodedBytes(record) > MUTATION_PROBE_MAX_RECORD_BYTES) return false;
        const existing = await tx.read<GatewayJsonValue>(MUTATION_PROBE_OWNER_NAMESPACE, ownerKey(input.runId, context.rsid));
        const rows = await tx.list(MUTATION_PROBE_OWNER_NAMESPACE);
        const runPrefix = `${input.runId}:`;
        if (existing !== null || rows.filter((row) => row.key.startsWith(runPrefix)).length >= MUTATION_PROBE_MAX_RECORDS) return false;
        tx.stage({ namespace: MUTATION_PROBE_OWNER_NAMESPACE, key: ownerKey(input.runId, context.rsid),
          value: record as unknown as GatewayJsonValue, expect: { kind: "absent" } });
        return true;
      });
      return outcome.ok && outcome.value;
    },
    async revalidateOriginPending(
      pendingInput: Parameters<MutationProbeVerificationWorkflow["revalidateOriginPending"]>[0],
    ) {
      const { context } = pendingInput;
      if (!DIGEST.test(pendingInput.envelopeDigest)) return false;
      const outcome = await input.protocolStore.transact({ tenantId: context.actor.tenantId }, async (tx) => {
        const stored = await tx.read<GatewayJsonValue>(MUTATION_PROBE_OWNER_NAMESPACE,
          ownerKey(input.runId, context.rsid));
        const owner = ownerRecord(stored?.value);
        const session = owner === null ? null : await readCurrentSessionAuthority(tx, owner.tenantId, owner.rsid);
        const recovery = recoveryValue((await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, context.rsid))?.value);
        const window = recovery?.invocationWindow;
        const pending = recovery?.pendingDispatch;
        const entries = isRecord(pending) && Array.isArray(pending.mutationEntries)
          ? pending.mutationEntries
          : [];
        const entry = entries[0];
        return owner !== null && owner.phase === "origin_admitted" && owner.expiresAtMs > now() &&
          contextMatches(owner, context) && owner.originEnvelopeDigest === pendingInput.envelopeDigest &&
          currentSessionMatches(session, owner, pendingInput.sessionBindingId, pendingInput.connectionId) &&
          isRecord(window) && window.attemptId === pendingInput.attemptId && isRecord(pending) &&
          pending.kind === "mutation" && pending.envelopeDigest === pendingInput.envelopeDigest &&
          pending.sessionBindingId === owner.sessionBindingId &&
          pending.authorizedSessionVersion === owner.sessionBindingVersion &&
          pending.preparedConnectionId === owner.connectionId && entries.length === 1 && isRecord(entry) &&
          entry.invocationId === owner.originInvocationId && entry.idempotencyKey === owner.originIdempotencyKey;
      });
      return outcome.ok && outcome.value;
    },
    async prepareVerification(
      preparation: Parameters<MutationProbeVerificationWorkflow["prepareVerification"]>[0],
    ) {
      const context = preparation.context;
      if (context.toolName !== "conformance.fixture.mutation_probe_verify" || context.toolVersion !== "1.0.0" ||
          context.policyClass !== "auto" || context.policyDecision !== "auto" || context.mutating ||
          context.effectiveMcpRequestScope === undefined ||
          !bindingIsExact({ binding: preparation.binding, context,
            method: "fixture_read_mutation_probe", mutating: false })) return null;
      const selected = await input.protocolStore.transact({ tenantId: context.actor.tenantId }, async (tx) => {
        const stored = await tx.read<GatewayJsonValue>(MUTATION_PROBE_OWNER_NAMESPACE, ownerKey(input.runId, context.rsid));
        const owner = ownerRecord(stored?.value);
        const session = owner === null ? null : await readCurrentSessionAuthority(tx, owner.tenantId, context.rsid);
        const recovery = recoveryValue((await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, context.rsid))?.value);
        const ledger = recovery?.ledger;
        const holds = isRecord(ledger) && Array.isArray(ledger.holds) ? ledger.holds : [];
        const matches = owner === null ? [] : holds.filter((hold) => exactOriginHold(hold, owner) &&
          isRecord(hold) && hold.state === "active" && Array.isArray(hold.evidenceAttempts) &&
          hold.evidenceAttempts.length === 0 && hold.selectedEvidence === null);
        if (owner === null || owner.phase !== "origin_admitted" || owner.expiresAtMs <= now() ||
            !contextMatches(owner, context) ||
            !currentSessionMatches(session, owner, preparation.sessionBindingId, preparation.connectionId) ||
            recovery?.pendingDispatch !== null || recovery.resolutionPlan !== null || matches.length !== 1) return null;
        return matches[0] as unknown as MutationHold;
      });
      if (!selected.ok || selected.value === null) return null;
      const envelope = structuredClone(preparation.envelope) as Record<string, unknown>;
      const payload = envelope.payload;
      if (!isRecord(payload)) return null;
      const verification = { hold_id: selected.value.holdId,
        mutation_scope: structuredClone(selected.value.mutationScope), purpose: "resolve_indeterminate" as const };
      payload.verification = verification;
      const binding = { ...structuredClone(preparation.binding), verification };
      return { holdId: selected.value.holdId, sessionBindingId: preparation.sessionBindingId,
        connectionId: preparation.connectionId, envelope,
        expected: { rsid: context.rsid, invocationId: context.invocationId, binding } };
    },
    async recordVerificationPrepared(
      prepared: Parameters<MutationProbeVerificationWorkflow["recordVerificationPrepared"]>[0],
    ) {
      if (!DIGEST.test(prepared.envelopeDigest) || !HOLD_ID.test(prepared.holdId)) return false;
      const context = prepared.context;
      const outcome = await input.protocolStore.transact({ tenantId: context.actor.tenantId }, async (tx) => {
        const stored = await tx.read<GatewayJsonValue>(MUTATION_PROBE_OWNER_NAMESPACE, ownerKey(input.runId, context.rsid));
        const owner = ownerRecord(stored?.value);
        const session = owner === null ? null : await readCurrentSessionAuthority(tx, owner.tenantId, context.rsid);
        const recovery = recoveryValue((await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, context.rsid))?.value);
        const pending = recovery?.pendingDispatch;
        if (stored === null || owner === null || owner.phase !== "origin_admitted" || owner.expiresAtMs <= now() ||
            !contextMatches(owner, context) ||
            !currentSessionMatches(session, owner, prepared.sessionBindingId, prepared.connectionId) ||
            !isRecord(pending) || pending.kind !== "verification" || pending.envelopeDigest !== prepared.envelopeDigest ||
            pending.verificationHoldId !== prepared.holdId || pending.sessionBindingId !== owner.sessionBindingId ||
            pending.authorizedSessionVersion !== owner.sessionBindingVersion || pending.preparedConnectionId !== owner.connectionId) return false;
        const next: MutationProbeOwnerRecord = { ...owner, recordVersion: owner.recordVersion + 1,
          phase: "verification_prepared", holdId: prepared.holdId,
          verificationInvocationId: context.invocationId, verificationEnvelopeDigest: prepared.envelopeDigest };
        if (encodedBytes(next) > MUTATION_PROBE_MAX_RECORD_BYTES) return false;
        tx.stage({ namespace: MUTATION_PROBE_OWNER_NAMESPACE, key: stored.key,
          value: next as unknown as GatewayJsonValue, expect: { kind: "version", version: stored.version } });
        return true;
      });
      return outcome.ok && outcome.value;
    },
    async recordPlan(inputPlan: Parameters<MutationProbeVerificationWorkflow["recordPlan"]>[0]) {
      const { context, hold, plan } = inputPlan;
      const outcome = await input.protocolStore.transact({ tenantId: context.actor.tenantId }, async (tx) => {
        const stored = await tx.read<GatewayJsonValue>(MUTATION_PROBE_OWNER_NAMESPACE, ownerKey(input.runId, context.rsid));
        const owner = ownerRecord(stored?.value);
        const session = owner === null ? null : await readCurrentSessionAuthority(tx, owner.tenantId, context.rsid);
        const recovery = recoveryValue((await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, context.rsid))?.value);
        const corePlan = recovery?.resolutionPlan;
        const item = plan.items[0];
        const clearance = plan.clearances[0];
        const selected = hold.selectedEvidence;
        const histories = Array.isArray(recovery?.dispatchHistory) ? recovery.dispatchHistory : [];
        const history = histories.find((candidate) => isRecord(candidate) &&
          candidate.envelopeDigest === owner?.verificationEnvelopeDigest && candidate.status === "terminal");
        const journals = isRecord(history) && Array.isArray(history.journalRecords) ? history.journalRecords : [];
        const journal = journals[0];
        if (stored === null || owner === null || owner.phase !== "verification_prepared" ||
            owner.expiresAtMs <= now() || !contextMatches(owner, context) ||
            !currentSessionMatches(session, owner) || !exactOriginHold(hold, owner) || hold.holdId !== owner.holdId ||
            hold.state !== "evidence_recorded" || selected === null || selected.basis !== "verification_read" ||
            selected.verificationInvocationId !== owner.verificationInvocationId || selected.conclusion !== "postcondition_verified" ||
            plan.rsid !== owner.rsid || plan.items.length !== 1 || plan.clearances.length !== 1 ||
            item === undefined || clearance === undefined || item.holdId !== hold.holdId || item.auditId.length < 1 ||
            item.evidenceDigest !== selected.evidenceDigest || item.verificationInvocationId !== owner.verificationInvocationId ||
            item.decision !== "postcondition_verified" || clearance.hold_id !== hold.holdId ||
            clearance.resolution_id !== item.resolutionId || clearance.audit_id !== item.auditId ||
            clearance.evidence_digest !== item.evidenceDigest || clearance.decision !== "postcondition_verified" ||
            !sameJson(clearance.mutation_scope, owner.mutationScope) || !isRecord(corePlan) ||
            corePlan.planId !== plan.planId || corePlan.planIdentity !== plan.planIdentity ||
            !isRecord(history) || journals.length !== 1 || !isRecord(journal) ||
            !journalRecordIsIntact(journal as unknown as InvocationJournalRecord) ||
            (journal as unknown as InvocationJournalRecord).terminalOutcome?.resultDigest !== selected.evidenceDigest)
          return null;
        const next: MutationProbeOwnerRecord = { ...owner, recordVersion: owner.recordVersion + 1,
          phase: "plan_ready", evidenceDigest: selected.evidenceDigest, auditId: item.auditId,
          planId: plan.planId, planIdentity: plan.planIdentity, resolutionId: item.resolutionId };
        if (encodedBytes(next) > MUTATION_PROBE_MAX_RECORD_BYTES) return null;
        tx.stage({ namespace: MUTATION_PROBE_OWNER_NAMESPACE, key: stored.key,
          value: next as unknown as GatewayJsonValue, expect: { kind: "version", version: stored.version } });
        return { journalRecord: structuredClone(journal) as unknown as InvocationJournalRecord,
          holdId: hold.holdId, resolutionId: item.resolutionId };
      });
      return outcome.ok ? outcome.value : null;
    },
    async prepareNext(preparation: Parameters<MutationProbeVerificationWorkflow["prepareNext"]>[0]) {
      const context = preparation.context;
      if (context.toolName !== "conformance.fixture.mutation_probe_next" || context.toolVersion !== "1.0.0" ||
          context.policyClass !== "confirm" || context.policyDecision !== "confirmed" ||
          context.effectiveMcpRequestScope === undefined ||
          !mutationDraftIsExact({ context, expected: preparation.expected,
            method: "fixture_complete_mutation_probe" })) return null;
      const selected = await input.protocolStore.transact({ tenantId: context.actor.tenantId }, async (tx) => {
        const stored = await tx.read<GatewayJsonValue>(MUTATION_PROBE_OWNER_NAMESPACE, ownerKey(input.runId, context.rsid));
        const owner = ownerRecord(stored?.value);
        const session = owner === null ? null : await readCurrentSessionAuthority(tx, owner.tenantId, context.rsid);
        const recovery = recoveryValue((await tx.read<GatewayJsonValue>(GATEWAY_RECOVERY_NAMESPACE, context.rsid))?.value);
        const plan = recovery?.resolutionPlan;
        const ledger = recovery?.ledger;
        const holds = isRecord(ledger) && Array.isArray(ledger.holds) ? ledger.holds : [];
        const hold = owner === null ? null : holds.find((candidate) => exactOriginHold(candidate, owner));
        const items = isRecord(plan) && Array.isArray(plan.items) ? plan.items : [];
        const clearances = isRecord(plan) && Array.isArray(plan.clearances) ? plan.clearances : [];
        const item = items[0];
        const clearance = clearances[0];
        if (owner === null || owner.phase !== "plan_ready" || owner.expiresAtMs <= now() ||
            !contextMatches(owner, context) ||
            !currentSessionMatches(session, owner, preparation.sessionBindingId, preparation.connectionId) ||
            recovery?.pendingDispatch !== null || !isRecord(plan) || plan.planId !== owner.planId ||
            plan.planIdentity !== owner.planIdentity || plan.rsid !== owner.rsid || items.length !== 1 ||
            clearances.length !== 1 || !isRecord(item) || !isRecord(clearance) || !isRecord(hold) ||
            hold.holdId !== owner.holdId || hold.state !== "evidence_recorded" || item.holdId !== owner.holdId ||
            item.auditId !== owner.auditId || item.resolutionId !== owner.resolutionId ||
            item.evidenceDigest !== owner.evidenceDigest || item.verificationInvocationId !== owner.verificationInvocationId ||
            item.decision !== "postcondition_verified" || clearance.hold_id !== owner.holdId ||
            clearance.audit_id !== owner.auditId || clearance.resolution_id !== owner.resolutionId ||
            clearance.evidence_digest !== owner.evidenceDigest || clearance.decision !== "postcondition_verified" ||
            !sameJson(clearance.mutation_scope, context.mutationScope)) return null;
        return structuredClone(clearances) as readonly RecoveryClearance[];
      });
      if (!selected.ok || selected.value === null) return null;
      const recoveryClearances = selected.value;
      const envelope = structuredClone(preparation.envelope) as Record<string, unknown>;
      if (!isRecord(envelope.payload)) return null;
      envelope.payload.recovery_clearances = recoveryClearances;
      const bindings = preparation.expected.bindings.map((binding: InvocationJournalBinding) =>
        ({ ...structuredClone(binding), recoveryClearances }));
      return { sessionBindingId: preparation.sessionBindingId, connectionId: preparation.connectionId, envelope,
        expected: { ...preparation.expected, bindings, recoveryClearances } };
    },
    async readAuditProjection() {
      const outcome = await input.protocolStore.transact({ tenantId: "conformance" }, async (tx) => {
        const prefix = `${input.runId}:`;
        const rows = (await tx.list(MUTATION_PROBE_OWNER_NAMESPACE))
          .filter((row) => row.key.startsWith(prefix));
        if (rows.length !== 1) {
          return { status: rows.length === 0 ? "absent" as const : "ambiguous" as const,
            recordCount: Math.min(rows.length, MUTATION_PROBE_MAX_RECORDS + 1), phase: null,
            ownerCurrent: false, recordVersion: null, rsidDigest: null, originInvocationDigest: null,
            holdDigest: null, verificationInvocationDigest: null, rawResultDigest: null,
            auditDigest: null, planDigest: null, resolutionDigest: null };
        }
        const owner = ownerRecord(rows[0]!.value);
        if (owner === null) {
          return { status: "unavailable" as const, recordCount: 1, phase: null,
            ownerCurrent: false, recordVersion: null, rsidDigest: null, originInvocationDigest: null,
            holdDigest: null, verificationInvocationDigest: null, rawResultDigest: null,
            auditDigest: null, planDigest: null, resolutionDigest: null };
        }
        const session = await readCurrentSessionAuthority(tx, owner.tenantId, owner.rsid);
        return {
          status: "current" as const,
          recordCount: 1,
          phase: owner.phase,
          ownerCurrent: owner.expiresAtMs > now() && currentSessionMatches(session, owner),
          recordVersion: owner.recordVersion,
          rsidDigest: referenceDigest("rsid", owner.rsid),
          originInvocationDigest: referenceDigest("origin_invocation", owner.originInvocationId),
          holdDigest: referenceDigest("hold", owner.holdId),
          verificationInvocationDigest: referenceDigest("verification_invocation", owner.verificationInvocationId),
          rawResultDigest: owner.evidenceDigest,
          auditDigest: referenceDigest("audit", owner.auditId),
          planDigest: referenceDigest("plan", owner.planId),
          resolutionDigest: referenceDigest("resolution", owner.resolutionId),
        };
      });
      return outcome.ok ? Object.freeze(outcome.value) : Object.freeze({
        status: "unavailable" as const, recordCount: 0, phase: null, ownerCurrent: false,
        recordVersion: null, rsidDigest: null, originInvocationDigest: null, holdDigest: null,
        verificationInvocationDigest: null, rawResultDigest: null, auditDigest: null,
        planDigest: null, resolutionDigest: null,
      });
    },
  });
  issuedWorkflows.set(workflow as object, Object.freeze({
    protocolStore: input.protocolStore,
    bridgeAuthority: input.bridgeAuthority,
  }));
  return workflow;
}
