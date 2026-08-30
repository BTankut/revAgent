import {
  makeMutationHoldId,
  makeParamsDigest,
  markJournalExecuting,
  markJournalIndeterminate,
  recordJournalTerminal,
  rbpEnvelopeErrors,
  validateRbpEnvelope,
  type InvocationJournalBinding,
  type InvocationJournalRecord,
  type InvokeEnvelope,
  type JsonValue,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import type { AuthContext } from "./authContext.js";
import type { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import {
  createEffectiveMcpRequestScopeV1,
  createGatewayInvocationContext,
  type EffectiveMcpRequestScopeV1,
  type GatewayInvocationContext,
} from "./invocationContext.js";
import { createProductionConformanceRecoveryAuthority } from "./productionConformanceHostCli.js";
import {
  MUTATION_PROBE_MAX_RECORDS,
  MUTATION_PROBE_MAX_RECORD_BYTES,
  MUTATION_PROBE_VERIFICATION_PROFILE,
  createMutationProbeVerificationWorkflow,
  isMutationProbeVerificationWorkflow,
} from "./productionConformanceVerification.js";
import type {
  GatewayBridgeCumulativeAckReceipt,
  GatewayBridgeEvidenceLookup,
  GatewayDurableBridgeEvidencePort,
  GatewayExpectedDispatchBinding,
  GatewayRecoveryPendingDispatch,
  GatewayVerifiedBridgeJournalEvidence,
} from "./recoveryAuthority.js";
import type { GatewayProtocolStore } from "./store.js";
import { createRestartableTestStore } from "./testAdapters.js";
import { sessionCanonicalDigest } from "./sessionHistoryStore.js";

const TENANT = "tenant-a";
const USER = "user-a";
const RSID = "0197a3c2-0000-7000-8000-000000000050";
const SESSION_BINDING = "0197a3c2-0000-7000-8000-000000000010";
const CONNECTION = "connection-a";
const NOW = 1_775_000_000_000;

function uuid7(value: number): string {
  return `0197a3c2-0000-7000-8000-${String(value).padStart(12, "0")}`;
}

class TestBridgeEvidence implements GatewayDurableBridgeEvidencePort {
  public readonly store: GatewayProtocolStore;
  readonly #lookups = new Map<string, GatewayBridgeEvidenceLookup>();

  public constructor(store: GatewayProtocolStore) { this.store = store; }

  public async authorizeDispatchTarget(): Promise<{ readonly kind: "authorized"; readonly sessionVersion: number }> {
    return { kind: "authorized", sessionVersion: 1 };
  }

  public async authorizeResumeTarget(): Promise<{ readonly kind: "authorized"; readonly sessionVersion: number }> {
    return { kind: "authorized", sessionVersion: 1 };
  }

  public async inspectDispatch(
    _tx: Parameters<GatewayDurableBridgeEvidencePort["inspectDispatch"]>[0],
    expected: GatewayExpectedDispatchBinding,
  ): Promise<GatewayBridgeEvidenceLookup> {
    return structuredClone(this.#lookups.get(expected.envelopeDigest) ?? { kind: "not_durable_yet" as const });
  }

  public observe(
    pending: GatewayRecoveryPendingDispatch,
    kind: GatewayVerifiedBridgeJournalEvidence["kind"],
    journalRecords: readonly InvocationJournalRecord[],
  ): void {
    const journal: GatewayVerifiedBridgeJournalEvidence = {
      kind,
      rsid: pending.envelope.rsid,
      sessionBindingId: pending.sessionBindingId,
      envelopeDigest: pending.envelopeDigest,
      journalRecords: structuredClone(journalRecords),
      batchTerminal: null,
      durableJournalVersion: 1,
      recordedAtMs: NOW + 2,
    };
    this.#lookups.set(pending.envelopeDigest, {
      kind: "found",
      observation: { acceptance: receiptFor(pending), journal },
    });
  }
}

function receiptFor(pending: GatewayRecoveryPendingDispatch): GatewayBridgeCumulativeAckReceipt {
  const invocationId = pending.envelope.type === "invoke"
    ? pending.envelope.payload.invocation_id
    : pending.envelope.payload.batch_id;
  return {
    source: "durable_rbp_sequence", receiptVersion: 1, tenantId: TENANT,
    rsid: pending.envelope.rsid, sessionBindingId: pending.sessionBindingId,
    acceptedConnectionId: pending.preparedConnectionId,
    authorizedSessionVersion: pending.authorizedSessionVersion,
    invocationId, correlationId: invocationId,
    proofDigest: `sha256:${"a".repeat(64)}`, routeSnapshotDigest: `sha256:${"b".repeat(64)}`,
    egressEpoch: 1, leaseTicket: 1, intent: "dispatch",
    gatewaySequence: pending.gatewaySequence, cumulativeAck: pending.gatewaySequence,
    envelopeDigest: pending.envelopeDigest, durableSequenceVersion: 1, acceptedAtMs: NOW + 1,
  };
}

function auth(): AuthContext {
  return Object.freeze({
    contractVersion: "revagent.auth-context/v1" as const,
    actor: Object.freeze({ type: "user" as const, tenantId: TENANT, userId: USER,
      role: "user" as const, oidcIssuer: "https://issuer.invalid", oidcSubject: "subject-a" }),
    session: Object.freeze({ sessionId: "gateway-session-a", clientType: "mcp" as const,
      mcpSessionId: null, oauthClientId: "client-a" }),
    principalKey: `${TENANT}:${USER}`,
    issuedAtMs: 1,
    expiresAtMs: null,
  });
}

function scope(mcpSessionId: string): EffectiveMcpRequestScopeV1 {
  return createEffectiveMcpRequestScopeV1({ principalKey: auth().principalKey,
    transportMcpSessionId: mcpSessionId, identityMcpSessionId: null, nowMs: 1 });
}

function context(input: {
  readonly invocationId: string;
  readonly toolName: string;
  readonly method: string;
  readonly policyClass: "auto" | "confirm";
  readonly mcpSessionId?: string;
  readonly confirmationId?: string;
}): GatewayInvocationContext {
  const mcpSessionId = input.mcpSessionId ?? "mcp-a";
  const effective = scope(mcpSessionId);
  return createGatewayInvocationContext({
    auth: auth(),
    route: Object.freeze({ tenantId: TENANT, principalKey: auth().principalKey,
      mcpSessionId, effectiveMcpRequestScope: effective, rsid: RSID,
      documentIdentity: Object.freeze({ kind: "live" as const, session_document_id: "fixture-document" }) }),
    mcpSessionId,
    effectiveMcpRequestScope: effective,
    invocationId: input.invocationId,
    toolName: input.toolName,
    toolVersion: "1.0.0",
    policyClass: input.policyClass,
    policyDecision: input.policyClass === "confirm" ? "confirmed" : "auto",
    confirmationId: input.confirmationId ?? null,
    originatingPreviewInvocationId: input.policyClass === "confirm" ? uuid7(900) : null,
    mutationScopePolicy: input.policyClass === "confirm" ? "session" : "none",
    executor: "bridge",
    args: {},
    startedAtMs: NOW,
  });
}

function envelope(input: {
  readonly context: GatewayInvocationContext;
  readonly method: string;
  readonly seq: number;
}): InvokeEnvelope {
  return {
    v: 1, type: "invoke", id: uuid7(100 + input.seq), ts: "2026-08-30T12:00:00.000Z",
    rsid: RSID, seq: input.seq, ack: 0,
    payload: {
      invocation_id: input.context.invocationId,
      method: input.method,
      params: {},
      timeout_ms: 120_000,
      mutating: input.context.mutating,
      mutation_scope: input.context.mutationScope,
      policy: { class: input.context.policyClass,
        decision: input.context.policyDecision as "auto" | "confirmed",
        confirmation_id: input.context.confirmationId },
      verification: null,
      recovery_clearances: [],
    },
  };
}

function binding(value: InvokeEnvelope): InvocationJournalBinding {
  return {
    rsid: value.rsid,
    invocationId: value.payload.invocation_id,
    method: value.payload.method,
    mutating: value.payload.mutating,
    mutationScope: value.payload.mutation_scope,
    paramsDigest: makeParamsDigest(value.payload.params as JsonValue),
    policy: { class: value.payload.policy.class, decision: value.payload.policy.decision,
      confirmation_id: value.payload.policy.confirmation_id },
    verification: value.payload.verification,
    recoveryClearances: value.payload.recovery_clearances,
  };
}

function expected(value: InvokeEnvelope) {
  return { rsid: value.rsid, correlationId: value.payload.invocation_id,
    bindings: [binding(value)], recoveryClearances: value.payload.recovery_clearances };
}

async function seedV1Session(store: GatewayProtocolStore): Promise<void> {
  const result = await store.transact({ tenantId: TENANT }, (tx) => {
    tx.stage({ namespace: "gateway.rbp-session/v1", key: RSID, expect: { kind: "absent" },
      value: { schema: "gateway.rbp-session/v1", tenantId: TENANT, userId: USER, rsid: RSID,
        sessionBindingId: SESSION_BINDING, sessionVersion: 1, connectionId: CONNECTION } });
  });
  expect(result.ok).toBe(true);
}

async function seedV3Session(
  store: GatewayProtocolStore,
  options: { readonly corruptRootDigest?: boolean } = {},
): Promise<void> {
  const root = {
    schema: "gateway.rbp-session/v3",
    generation: 3,
    rootVersion: 1,
    tenantId: TENANT,
    rsid: RSID,
    identity: { userId: USER },
    binding: { sessionBindingId: SESSION_BINDING, sessionVersion: 1, connectionId: CONNECTION },
    lifecycle: {},
    sequenceHead: {},
    migrationProof: {},
    durabilityProfile: {},
    trees: [],
    singletonRefs: [],
    antiDowngradeRefs: [],
    retentionClosure: null,
    retiredAuthorityDigest: null,
    completionDigest: null,
  };
  const marker = {
    schema: "gateway.rbp-session-cutover/v3",
    generation: 3,
    tenantId: TENANT,
    rsid: RSID,
    rootVersion: 1,
    rootDigest: options.corruptRootDigest === true
      ? `sha256:${"f".repeat(64)}`
      : sessionCanonicalDigest(root),
    treesDigest: sessionCanonicalDigest([]),
    migratedAtMs: NOW,
  };
  const result = await store.transact({ tenantId: TENANT }, (tx) => {
    tx.stage({ namespace: "gateway.rbp-session/v3", key: RSID,
      value: root, expect: { kind: "absent" } });
    tx.stage({ namespace: "gateway.rbp-session-cutover/v3", key: RSID,
      value: marker, expect: { kind: "absent" } });
  });
  expect(result.ok).toBe(true);
}

async function admitOrigin(store: GatewayProtocolStore, runId: string): Promise<boolean> {
  const bridge = new TestBridgeEvidence(store) as unknown as GatewayBridgeSessionAuthority;
  const workflow = createMutationProbeVerificationWorkflow({
    protocolStore: store,
    bridgeAuthority: bridge,
    runId,
    clock: () => NOW,
  });
  const originContext = context({ invocationId: uuid7(70),
    toolName: "conformance.fixture.mutation_probe_origin", method: "fixture_commit_then_throw",
    policyClass: "confirm", confirmationId: uuid7(71) });
  const originEnvelope = envelope({ context: originContext, method: "fixture_commit_then_throw", seq: 1 });
  return await workflow.recordOrigin({ context: originContext, sessionBindingId: SESSION_BINDING,
    connectionId: CONNECTION, envelope: originEnvelope, expected: expected(originEnvelope) });
}

describe("mutation-probe-v1 verification authority", () => {
  it("uses canonical v3, admits only a physical v1 compatibility row, and denies ambiguous or corrupt topology", async () => {
    const v1 = createRestartableTestStore();
    await v1.store.open();
    await seedV1Session(v1.store);
    expect(await admitOrigin(v1.store, "v1-run")).toBe(true);

    const ambiguous = createRestartableTestStore();
    await ambiguous.store.open();
    await seedV3Session(ambiguous.store);
    await seedV1Session(ambiguous.store);
    expect(await admitOrigin(ambiguous.store, "ambiguous-run")).toBe(false);

    const corrupt = createRestartableTestStore();
    await corrupt.store.open();
    await seedV3Session(corrupt.store, { corruptRootDigest: true });
    expect(await admitOrigin(corrupt.store, "corrupt-run")).toBe(false);
  });

  it("runs admitted origin -> audited routed read -> private plan and denies owner drift", async () => {
    const durable = createRestartableTestStore();
    expect((await durable.store.open()).ok).toBe(true);
    await seedV3Session(durable.store);
    const bridge = new TestBridgeEvidence(durable.store);
    const bridgeAuthority = bridge as unknown as GatewayBridgeSessionAuthority;
    const workflow = createMutationProbeVerificationWorkflow({
      protocolStore: durable.store, bridgeAuthority, runId: "run-1", clock: () => NOW + 10,
    });
    const recovery = createProductionConformanceRecoveryAuthority({
      protocolStore: durable.store, bridgeEvidence: bridgeAuthority, verificationWorkflow: workflow,
    });
    expect(isMutationProbeVerificationWorkflow(workflow, {
      protocolStore: durable.store, bridgeAuthority, recoveryAuthority: recovery,
    })).toBe(true);
    expect(isMutationProbeVerificationWorkflow({ ...workflow })).toBe(false);

    const originContext = context({ invocationId: uuid7(1),
      toolName: "conformance.fixture.mutation_probe_origin", method: "fixture_commit_then_throw",
      policyClass: "confirm", confirmationId: uuid7(2) });
    const originEnvelope = envelope({ context: originContext, method: "fixture_commit_then_throw", seq: 1 });
    if (!validateRbpEnvelope(originEnvelope)) {
      throw new Error(`invalid origin envelope: ${JSON.stringify(rbpEnvelopeErrors(originEnvelope))}`);
    }
    const originAttempt = uuid7(3);
    expect(await recovery.acquireInvocationWindow({ tenantId: TENANT, rsid: RSID, attemptId: originAttempt }))
      .toMatchObject({ kind: "acquired" });
    expect(await workflow.recordOrigin({ context: originContext, sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION, envelope: originEnvelope, expected: expected(originEnvelope) })).toBe(true);
    const originPrepared = await recovery.prepareMutationDispatch({ tenantId: TENANT, attemptId: originAttempt,
      sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
      envelope: originEnvelope, expected: expected(originEnvelope) });
    if (originPrepared.kind !== "prepared") throw new Error(`origin not prepared: ${JSON.stringify(originPrepared)}`);
    const holdId = makeMutationHoldId(RSID, { kind: "session" }, [originContext.idempotencyKey]);
    const originJournal = markJournalIndeterminate(
      markJournalExecuting(originPrepared.dispatch.journalRecords[0]!), holdId,
    );
    bridge.observe(originPrepared.dispatch, "indeterminate", [originJournal]);
    expect(await recovery.reconcilePendingDispatch({ tenantId: TENANT, rsid: RSID,
      envelopeDigest: originPrepared.dispatch.envelopeDigest })).toMatchObject({ kind: "indeterminate_recorded" });
    expect(await recovery.releaseInvocationWindow({ tenantId: TENANT, rsid: RSID, attemptId: originAttempt }))
      .toMatchObject({ kind: "released" });

    const verifyContext = context({ invocationId: uuid7(4),
      toolName: "conformance.fixture.mutation_probe_verify", method: "fixture_read_mutation_probe",
      policyClass: "auto" });
    const verifyDraft = envelope({ context: verifyContext, method: "fixture_read_mutation_probe", seq: 2 });
    const selected = await workflow.prepareVerification({ context: verifyContext,
      sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
      envelope: verifyDraft, binding: binding(verifyDraft) });
    expect(selected).toMatchObject({ holdId });
    if (selected === null) throw new Error("verification not selected");
    const verifyAttempt = uuid7(5);
    expect(await recovery.acquireInvocationWindow({ tenantId: TENANT, rsid: RSID, attemptId: verifyAttempt }))
      .toMatchObject({ kind: "acquired" });
    const verifyPrepared = await recovery.prepareVerificationDispatch({ tenantId: TENANT,
      attemptId: verifyAttempt, sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
      envelope: selected.envelope, expected: selected.expected });
    expect(verifyPrepared.kind).toBe("prepared");
    if (verifyPrepared.kind !== "prepared") throw new Error("verification not prepared");
    expect(await workflow.recordVerificationPrepared({ context: verifyContext, holdId,
      sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
      envelopeDigest: verifyPrepared.dispatch.envelopeDigest })).toBe(true);
    const fixtureState = { schema: "revagent.fixture-mutation-probe/v1", resultContractVersion: 2,
      present: true, complete: true, originInvocationId: originContext.invocationId,
      value: 1, originWriteCount: 1, nextWriteCount: 0 };
    const verifyJournal = recordJournalTerminal(markJournalExecuting(verifyPrepared.dispatch.journalRecords[0]!), {
      status: "completed", resultDigest: makeParamsDigest(fixtureState), payloadRetained: true,
      payload: fixtureState,
    });
    bridge.observe(verifyPrepared.dispatch, "known_terminal", [verifyJournal]);
    expect(await recovery.reconcilePendingDispatch({ tenantId: TENANT, rsid: RSID,
      envelopeDigest: verifyPrepared.dispatch.envelopeDigest })).toMatchObject({ kind: "verification_evidence_ready" });
    const recorded = await recovery.recordVerificationEvidence({ tenantId: TENANT, rsid: RSID,
      envelopeDigest: verifyPrepared.dispatch.envelopeDigest });
    expect(recorded.kind).toBe("recorded");
    if (recorded.kind !== "recorded") throw new Error("evidence not recorded");
    const planned = await recovery.planRecoveryClearances({ tenantId: TENANT, rsid: RSID,
      mutationScopes: [recorded.hold.mutationScope],
      decisions: [{ holdId: recorded.hold.holdId, decision: "postcondition_verified" }] });
    expect(planned.kind).toBe("planned");
    if (planned.kind !== "planned") throw new Error("clearance not planned");
    expect(await workflow.recordPlan({ context: verifyContext, hold: recorded.hold, plan: planned.plan }))
      .toMatchObject({ holdId, resolutionId: planned.plan.items[0]!.resolutionId });
    expect(await recovery.releaseInvocationWindow({ tenantId: TENANT, rsid: RSID, attemptId: verifyAttempt }))
      .toMatchObject({ kind: "released" });

    const nextContext = context({ invocationId: uuid7(6),
      toolName: "conformance.fixture.mutation_probe_next", method: "fixture_complete_mutation_probe",
      policyClass: "confirm", confirmationId: uuid7(7) });
    const nextDraft = envelope({ context: nextContext, method: "fixture_complete_mutation_probe", seq: 3 });
    const next = await workflow.prepareNext({ context: nextContext, sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION, envelope: nextDraft, expected: expected(nextDraft) });
    expect(next?.expected.recoveryClearances).toEqual(planned.plan.clearances);

    const driftedContext = context({ invocationId: uuid7(8), mcpSessionId: "mcp-b",
      toolName: "conformance.fixture.mutation_probe_next", method: "fixture_complete_mutation_probe",
      policyClass: "confirm", confirmationId: uuid7(9) });
    const driftedDraft = envelope({ context: driftedContext, method: "fixture_complete_mutation_probe", seq: 4 });
    expect(await workflow.prepareNext({ context: driftedContext, sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION, envelope: driftedDraft, expected: expected(driftedDraft) })).toBeNull();
  });

  it("binds the exact graph and refuses missing provenance or invalid run identities", async () => {
    const durable = createRestartableTestStore();
    await durable.store.open();
    const bridge = new TestBridgeEvidence(durable.store) as unknown as GatewayBridgeSessionAuthority;
    const workflow = createMutationProbeVerificationWorkflow({ protocolStore: durable.store,
      bridgeAuthority: bridge, runId: "run-2", clock: () => NOW });
    expect(workflow.profile).toBe(MUTATION_PROBE_VERIFICATION_PROFILE);
    expect(MUTATION_PROBE_MAX_RECORDS).toBe(64);
    expect(MUTATION_PROBE_MAX_RECORD_BYTES).toBe(8_192);
    const outcome = await durable.store.transact({ tenantId: TENANT }, async (tx) =>
      workflow.evidenceDecision.decideEvidence(tx, {
        rsid: RSID, holdId: `vh:${"a".repeat(64)}`, mutationScope: { kind: "session" },
        basis: "verification_read", verificationInvocationId: uuid7(20), originIdempotencyKey: null,
        evidenceDigest: `sha256:${"a".repeat(64)}`, journalRecord: {} as never,
      }));
    if (!outcome.ok) throw new Error(`decision transaction failed: ${JSON.stringify(outcome)}`);
    expect(outcome.value).toMatchObject({ kind: "rejected",
      reason: "mutation_probe_postcondition_unverified" });
    const other = createRestartableTestStore();
    expect(() => createMutationProbeVerificationWorkflow({ protocolStore: other.store,
      bridgeAuthority: bridge, runId: "wrong-store" })).toThrow(/exact protocol store/u);
    expect(() => createMutationProbeVerificationWorkflow({ protocolStore: durable.store,
      bridgeAuthority: bridge, runId: "" })).toThrow();
    expect(() => createMutationProbeVerificationWorkflow({ protocolStore: durable.store,
      bridgeAuthority: bridge, runId: "x".repeat(129) })).toThrow();
  });
});
