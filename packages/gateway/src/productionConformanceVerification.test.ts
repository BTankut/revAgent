import {
  createReceivedJournalRecord,
  makeMutationHoldId,
  makeParamsDigest,
  markJournalExecuting,
  markJournalIndeterminate,
  recordJournalTerminal,
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
  MUTATION_PROBE_AUTHORIZATION_MS,
  MUTATION_PROBE_OWNER_NAMESPACE,
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
  GatewayRecoveryAuthority,
  GatewayRecoveryEvidenceCandidate,
  GatewayVerifiedBridgeJournalEvidence,
} from "./recoveryAuthority.js";
import type {
  GatewayProtocolStore,
  StoreOutcome,
  StoreTransaction,
} from "./store.js";
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

function faultableStore(base: GatewayProtocolStore): Readonly<{
  readonly store: GatewayProtocolStore;
  failNext(mode: "unavailable" | "cas_conflict"): void;
}> {
  let next: "unavailable" | "cas_conflict" | null = null;
  const store: GatewayProtocolStore = {
    kind: base.kind,
    contractVersion: base.contractVersion,
    startupCoordinator: base.startupCoordinator,
    open: async () => await base.open(),
    close: async () => await base.close(),
    async transact<T>(scope: { readonly tenantId: string }, fn: (
      tx: StoreTransaction,
    ) => Promise<T> | T): Promise<StoreOutcome<T>> {
      const selected = next;
      next = null;
      if (selected === "unavailable") {
        return { ok: false, code: "durability_uncertain", message: "injected write uncertainty" };
      }
      if (selected !== "cas_conflict") return await base.transact(scope, fn);
      return await base.transact(scope, async (tx) => await fn({
        read: async (namespace, key) => await tx.read(namespace, key),
        list: async (namespace) => await tx.list(namespace),
        stage(write) {
          tx.stage({
            ...write,
            expect: write.expect.kind === "version"
              ? { kind: "version", version: write.expect.version + 1 }
              : { kind: "version", version: 1 },
          });
        },
      }));
    },
  };
  return Object.freeze({
    store,
    failNext(mode) { next = mode; },
  });
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

interface DecisionHarness {
  readonly store: GatewayProtocolStore;
  readonly bridgeAuthority: GatewayBridgeSessionAuthority;
  readonly workflow: ReturnType<typeof createMutationProbeVerificationWorkflow>;
  readonly recovery: GatewayRecoveryAuthority;
  readonly verifyContext: GatewayInvocationContext;
  readonly holdId: string;
  readonly verifyAttempt: string;
  readonly verificationPending: GatewayRecoveryPendingDispatch;
  readonly journal: InvocationJournalRecord;
  readonly fixtureState: Readonly<Record<string, JsonValue>>;
}

async function createDecisionHarness(input: {
  readonly runId: string;
  readonly store?: GatewayProtocolStore;
  readonly now?: () => number;
}): Promise<DecisionHarness> {
  const store = input.store ?? createRestartableTestStore().store;
  expect((await store.open()).ok).toBe(true);
  await seedV3Session(store);
  const bridge = new TestBridgeEvidence(store);
  const bridgeAuthority = bridge as unknown as GatewayBridgeSessionAuthority;
  const workflow = createMutationProbeVerificationWorkflow({
    protocolStore: store,
    bridgeAuthority,
    runId: input.runId,
    clock: input.now ?? (() => NOW + 10),
  });
  const recovery = createProductionConformanceRecoveryAuthority({
    protocolStore: store,
    bridgeEvidence: bridgeAuthority,
    verificationWorkflow: workflow,
  });
  const originContext = context({ invocationId: uuid7(101),
    toolName: "conformance.fixture.mutation_probe_origin", method: "fixture_commit_then_throw",
    policyClass: "confirm", confirmationId: uuid7(102) });
  const originEnvelope = envelope({ context: originContext,
    method: "fixture_commit_then_throw", seq: 1 });
  const originAttempt = uuid7(103);
  expect(await recovery.acquireInvocationWindow({ tenantId: TENANT, rsid: RSID,
    attemptId: originAttempt })).toMatchObject({ kind: "acquired" });
  expect(await workflow.recordOrigin({ context: originContext,
    sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
    envelope: originEnvelope, expected: expected(originEnvelope) })).toBe(true);
  const originPrepared = await recovery.prepareMutationDispatch({ tenantId: TENANT,
    attemptId: originAttempt, sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
    envelope: originEnvelope, expected: expected(originEnvelope) });
  if (originPrepared.kind !== "prepared") throw new Error("negative harness origin prepare failed");
  const holdId = makeMutationHoldId(RSID, { kind: "session" }, [originContext.idempotencyKey]);
  bridge.observe(originPrepared.dispatch, "indeterminate", [markJournalIndeterminate(
    markJournalExecuting(originPrepared.dispatch.journalRecords[0]!), holdId,
  )]);
  expect(await recovery.reconcilePendingDispatch({ tenantId: TENANT, rsid: RSID,
    envelopeDigest: originPrepared.dispatch.envelopeDigest })).toMatchObject({ kind: "indeterminate_recorded" });
  expect(await recovery.releaseInvocationWindow({ tenantId: TENANT, rsid: RSID,
    attemptId: originAttempt })).toMatchObject({ kind: "released" });

  const verifyContext = context({ invocationId: uuid7(104),
    toolName: "conformance.fixture.mutation_probe_verify", method: "fixture_read_mutation_probe",
    policyClass: "auto" });
  const verifyDraft = envelope({ context: verifyContext, method: "fixture_read_mutation_probe", seq: 2 });
  const selected = await workflow.prepareVerification({ context: verifyContext,
    sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
    envelope: verifyDraft, binding: binding(verifyDraft) });
  if (selected === null) throw new Error("negative harness verification selection failed");
  const verifyAttempt = uuid7(105);
  expect(await recovery.acquireInvocationWindow({ tenantId: TENANT, rsid: RSID,
    attemptId: verifyAttempt })).toMatchObject({ kind: "acquired" });
  const verifyPrepared = await recovery.prepareVerificationDispatch({ tenantId: TENANT,
    attemptId: verifyAttempt, sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
    envelope: selected.envelope, expected: selected.expected });
  if (verifyPrepared.kind !== "prepared") throw new Error("negative harness verification prepare failed");
  expect(await workflow.recordVerificationPrepared({ context: verifyContext, holdId,
    sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
    envelopeDigest: verifyPrepared.dispatch.envelopeDigest })).toBe(true);
  const fixtureState = Object.freeze({ schema: "revagent.fixture-mutation-probe/v1",
    resultContractVersion: 2, present: true, complete: true,
    originInvocationId: originContext.invocationId, value: 1,
    originWriteCount: 1, nextWriteCount: 0 });
  const journal = recordJournalTerminal(markJournalExecuting(
    verifyPrepared.dispatch.journalRecords[0]!,
  ), { status: "completed", resultDigest: makeParamsDigest(fixtureState),
    payloadRetained: true, payload: fixtureState });
  bridge.observe(verifyPrepared.dispatch, "known_terminal", [journal]);
  expect(await recovery.reconcilePendingDispatch({ tenantId: TENANT, rsid: RSID,
    envelopeDigest: verifyPrepared.dispatch.envelopeDigest })).toMatchObject({
      kind: "verification_evidence_ready",
    });
  return { store, bridgeAuthority, workflow, recovery, verifyContext,
    holdId, verifyAttempt, verificationPending: verifyPrepared.dispatch, journal, fixtureState };
}

function evidenceCandidate(
  harness: DecisionHarness,
  overrides: Partial<GatewayRecoveryEvidenceCandidate> = {},
): GatewayRecoveryEvidenceCandidate {
  return {
    rsid: RSID,
    holdId: harness.holdId,
    mutationScope: { kind: "session" },
    basis: "verification_read",
    verificationInvocationId: harness.verifyContext.invocationId,
    originIdempotencyKey: null,
    evidenceDigest: harness.journal.terminalOutcome!.resultDigest!,
    journalRecord: harness.journal,
    ...overrides,
  };
}

async function decide(
  harness: DecisionHarness,
  candidate: GatewayRecoveryEvidenceCandidate,
) {
  const result = await harness.store.transact({ tenantId: TENANT }, async (tx) =>
    await harness.workflow.evidenceDecision.decideEvidence(tx, candidate));
  if (!result.ok) throw new Error(`decision transaction failed: ${JSON.stringify(result)}`);
  return result.value;
}

function journalVariant(
  harness: DecisionHarness,
  input: {
    readonly method?: string;
    readonly status?: "completed" | "guarded";
    readonly payloadRetained?: boolean;
    readonly payload?: JsonValue;
    readonly resultDigest?: string;
  },
): InvocationJournalRecord {
  const original = harness.verificationPending.journalRecords[0]!.binding;
  const receipt = createReceivedJournalRecord({
    ...structuredClone(original),
    method: input.method ?? original.method,
  });
  const payload = input.payload ?? harness.fixtureState;
  return recordJournalTerminal(markJournalExecuting(receipt), {
    status: input.status ?? "completed",
    ...(input.resultDigest === undefined
      ? { resultDigest: makeParamsDigest(payload) }
      : { resultDigest: input.resultDigest }),
    ...(input.status === "guarded" ? { guardedReason: "fixture_guarded" } : {}),
    payloadRetained: input.payloadRetained ?? true,
    ...((input.payloadRetained ?? true) ? { payload } : {}),
  });
}

async function mutateCurrentSession(
  store: GatewayProtocolStore,
  mutation: (binding: Record<string, JsonValue>) => void,
): Promise<void> {
  const outcome = await store.transact({ tenantId: TENANT }, async (tx) => {
    const rootRecord = await tx.read("gateway.rbp-session/v3", RSID);
    const markerRecord = await tx.read("gateway.rbp-session-cutover/v3", RSID);
    if (rootRecord === null || markerRecord === null) throw new Error("session topology missing");
    const root = structuredClone(rootRecord.value) as Record<string, JsonValue>;
    const bindingValue = root.binding;
    if (bindingValue === null || typeof bindingValue !== "object" || Array.isArray(bindingValue)) {
      throw new Error("session binding missing");
    }
    mutation(bindingValue as Record<string, JsonValue>);
    root.rootVersion = rootRecord.version + 1;
    const marker = structuredClone(markerRecord.value) as Record<string, JsonValue>;
    marker.rootVersion = root.rootVersion;
    marker.rootDigest = sessionCanonicalDigest(root);
    marker.treesDigest = sessionCanonicalDigest(root.trees as JsonValue);
    tx.stage({ namespace: rootRecord.namespace, key: rootRecord.key, value: root,
      expect: { kind: "version", version: rootRecord.version } });
    tx.stage({ namespace: markerRecord.namespace, key: markerRecord.key, value: marker,
      expect: { kind: "version", version: markerRecord.version } });
  });
  expect(outcome.ok).toBe(true);
}

function paddedRecord(
  owner: Record<string, JsonValue>,
  targetBytes: number,
): Record<string, JsonValue> {
  const empty = { ...owner, padding: "" };
  const current = Buffer.byteLength(JSON.stringify(empty), "utf8");
  if (current > targetBytes) throw new Error("owner record already exceeds target");
  const padded = { ...owner, padding: "x".repeat(targetBytes - current) };
  expect(Buffer.byteLength(JSON.stringify(padded), "utf8")).toBe(targetBytes);
  return padded;
}

async function seedOwnerCapacity(
  store: GatewayProtocolStore,
  runId: string,
  count: number,
): Promise<void> {
  const outcome = await store.transact({ tenantId: TENANT }, (tx) => {
    for (let index = 0; index < count; index += 1) {
      tx.stage({ namespace: MUTATION_PROBE_OWNER_NAMESPACE,
        key: `${runId}:seed-${String(index).padStart(2, "0")}`,
        value: { seeded: true, index }, expect: { kind: "absent" } });
    }
  });
  expect(outcome.ok).toBe(true);
}

describe("mutation-probe-v1 verification authority", () => {
  it("rejects every foreign coordinate, fixture-state failure, raw-digest mismatch, and substituted read source", async () => {
    const harness = await createDecisionHarness({ runId: "negative-candidates" });
    expect(await decide(harness, evidenceCandidate(harness))).toMatchObject({
      kind: "decided",
      conclusion: "postcondition_verified",
    });
    const wrongValue = { ...harness.fixtureState, value: 2 } as JsonValue;
    const absent = { schema: "revagent.fixture-mutation-probe/v1", resultContractVersion: 2,
      present: false, complete: false, originInvocationId: null, value: null,
      originWriteCount: 0, nextWriteCount: 0 } as JsonValue;
    const malformed = { ...harness.fixtureState, unexpected: true } as JsonValue;
    const cases: readonly Readonly<{
      readonly name: string;
      readonly candidate: GatewayRecoveryEvidenceCandidate;
    }>[] = [
      { name: "wrong rsid", candidate: evidenceCandidate(harness, { rsid: uuid7(700) }) },
      { name: "wrong hold", candidate: evidenceCandidate(harness, {
        holdId: makeMutationHoldId(RSID, { kind: "session" }, [`${RSID}/${uuid7(701)}`]),
      }) },
      { name: "wrong value", candidate: evidenceCandidate(harness, {
        journalRecord: journalVariant(harness, { payload: wrongValue }),
      }) },
      { name: "absent", candidate: evidenceCandidate(harness, {
        journalRecord: journalVariant(harness, { payload: absent }),
      }) },
      { name: "guarded", candidate: evidenceCandidate(harness, {
        journalRecord: journalVariant(harness, { status: "guarded" }),
      }) },
      { name: "omitted", candidate: evidenceCandidate(harness, {
        journalRecord: journalVariant(harness, { payloadRetained: false }),
      }) },
      { name: "malformed", candidate: evidenceCandidate(harness, {
        journalRecord: journalVariant(harness, { payload: malformed }),
      }) },
      { name: "raw digest mismatch", candidate: evidenceCandidate(harness, {
        evidenceDigest: `sha256:${"f".repeat(64)}`,
      }) },
      ...["fixture_echo", "fixture_counter", "get_ui_state"].map((method) => ({
        name: `substituted ${method}`,
        candidate: evidenceCandidate(harness, {
          journalRecord: journalVariant(harness, { method }),
        }),
      })),
    ];
    for (const candidate of cases) {
      expect(await decide(harness, candidate.candidate), candidate.name).toMatchObject({
        kind: "rejected",
        reason: "mutation_probe_postcondition_unverified",
      });
    }
  });

  it("denies exact session-binding and connection drift", async () => {
    for (const candidate of [
      { name: "session binding", mutate: (binding: Record<string, JsonValue>) => {
        binding.sessionBindingId = uuid7(710);
      } },
      { name: "connection", mutate: (binding: Record<string, JsonValue>) => {
        binding.connectionId = "connection-foreign";
      } },
    ] as const) {
      const harness = await createDecisionHarness({ runId: `drift-${candidate.name.replace(" ", "-")}` });
      await mutateCurrentSession(harness.store, candidate.mutate);
      expect(await decide(harness, evidenceCandidate(harness)), candidate.name).toMatchObject({
        kind: "rejected",
        reason: "mutation_probe_postcondition_unverified",
      });
    }
  });

  it("accepts the final authorization millisecond and denies the exact expiry boundary", async () => {
    let now = NOW;
    const harness = await createDecisionHarness({ runId: "expiry-boundary", now: () => now });
    now = NOW + MUTATION_PROBE_AUTHORIZATION_MS - 1;
    expect(await decide(harness, evidenceCandidate(harness))).toMatchObject({
      kind: "decided",
      conclusion: "postcondition_verified",
    });
    now += 1;
    expect(await decide(harness, evidenceCandidate(harness))).toMatchObject({
      kind: "rejected",
      reason: "mutation_probe_postcondition_unverified",
    });
  });

  it("admits record 64 and denies capacity plus one without origin execution", async () => {
    const exact = createRestartableTestStore();
    await exact.store.open();
    await seedV3Session(exact.store);
    await seedOwnerCapacity(exact.store, "cap-exact", MUTATION_PROBE_MAX_RECORDS - 1);
    expect(await admitOrigin(exact.store, "cap-exact")).toBe(true);
    const exactRows = await exact.store.transact({ tenantId: TENANT }, async (tx) =>
      (await tx.list(MUTATION_PROBE_OWNER_NAMESPACE))
        .filter((row) => row.key.startsWith("cap-exact:")));
    expect(exactRows.ok && exactRows.value).toHaveLength(MUTATION_PROBE_MAX_RECORDS);

    const plusOne = createRestartableTestStore();
    await plusOne.store.open();
    await seedV3Session(plusOne.store);
    await seedOwnerCapacity(plusOne.store, "cap-plus-one", MUTATION_PROBE_MAX_RECORDS);
    expect(await admitOrigin(plusOne.store, "cap-plus-one")).toBe(false);
    const owner = await plusOne.store.transact({ tenantId: TENANT }, (tx) =>
      tx.read(MUTATION_PROBE_OWNER_NAMESPACE, `cap-plus-one:${RSID}`));
    expect(owner).toEqual({ ok: true, value: null });
  });

  it("accepts an 8192-byte owner record and rejects serialized size plus one", async () => {
    const durable = createRestartableTestStore();
    await durable.store.open();
    await seedV3Session(durable.store);
    expect(await admitOrigin(durable.store, "record-bytes")).toBe(true);
    const source = await durable.store.transact({ tenantId: TENANT }, (tx) =>
      tx.read(MUTATION_PROBE_OWNER_NAMESPACE, `record-bytes:${RSID}`));
    if (!source.ok || source.value === null) throw new Error("source owner missing");
    const exact = paddedRecord(
      source.value.value as Record<string, JsonValue>,
      MUTATION_PROBE_MAX_RECORD_BYTES,
    );
    const seeded = await durable.store.transact({ tenantId: "conformance" }, (tx) => {
      tx.stage({ namespace: MUTATION_PROBE_OWNER_NAMESPACE, key: `record-bytes:${RSID}`,
        value: exact, expect: { kind: "absent" } });
    });
    expect(seeded.ok).toBe(true);
    const bridge = new TestBridgeEvidence(durable.store) as unknown as GatewayBridgeSessionAuthority;
    const workflow = createMutationProbeVerificationWorkflow({ protocolStore: durable.store,
      bridgeAuthority: bridge, runId: "record-bytes", clock: () => NOW });
    expect(await workflow.readAuditProjection()).toMatchObject({
      status: "current",
      recordCount: 1,
      recordVersion: 1,
    });
    const replaced = await durable.store.transact({ tenantId: "conformance" }, async (tx) => {
      const stored = await tx.read(MUTATION_PROBE_OWNER_NAMESPACE, `record-bytes:${RSID}`);
      if (stored === null) throw new Error("bounded owner missing");
      tx.stage({ namespace: stored.namespace, key: stored.key,
        value: paddedRecord(source.value!.value as Record<string, JsonValue>,
          MUTATION_PROBE_MAX_RECORD_BYTES + 1),
        expect: { kind: "version", version: stored.version } });
    });
    expect(replaced.ok).toBe(true);
    expect(await workflow.readAuditProjection()).toMatchObject({
      status: "unavailable",
      recordCount: 1,
      recordVersion: null,
    });
  });

  it("does not adopt prior-run provenance after a store restart", async () => {
    const durable = createRestartableTestStore();
    const original = await createDecisionHarness({ runId: "run-before-restart",
      store: durable.store });
    const restarted = durable.restart();
    expect((await restarted.open()).ok).toBe(true);
    const bridge = new TestBridgeEvidence(restarted) as unknown as GatewayBridgeSessionAuthority;
    const workflow = createMutationProbeVerificationWorkflow({ protocolStore: restarted,
      bridgeAuthority: bridge, runId: "run-after-restart", clock: () => NOW + 20 });
    const decision = await restarted.transact({ tenantId: TENANT }, (tx) =>
      workflow.evidenceDecision.decideEvidence(tx, evidenceCandidate(original)));
    expect(decision.ok && decision.value).toMatchObject({
      kind: "rejected",
      reason: "mutation_probe_postcondition_unverified",
    });
    const rows = await restarted.transact({ tenantId: TENANT }, (tx) =>
      tx.list(MUTATION_PROBE_OWNER_NAMESPACE));
    if (!rows.ok) throw new Error("restart owner list unavailable");
    expect(rows.value.some((row) => row.key.startsWith("run-before-restart:"))).toBe(true);
    expect(rows.value.some((row) => row.key.startsWith("run-after-restart:"))).toBe(false);
  });

  it("fails closed across pre-origin, evidence-audit, and plan-owner write faults", async () => {
    const preBase = createRestartableTestStore();
    const preFault = faultableStore(preBase.store);
    expect((await preFault.store.open()).ok).toBe(true);
    await seedV3Session(preFault.store);
    preFault.failNext("unavailable");
    expect(await admitOrigin(preFault.store, "fault-pre-origin")).toBe(false);
    const absentOwner = await preFault.store.transact({ tenantId: TENANT }, (tx) =>
      tx.read(MUTATION_PROBE_OWNER_NAMESPACE, `fault-pre-origin:${RSID}`));
    expect(absentOwner).toEqual({ ok: true, value: null });

    const auditBase = createRestartableTestStore();
    const auditFault = faultableStore(auditBase.store);
    const auditHarness = await createDecisionHarness({ runId: "fault-evidence-audit",
      store: auditFault.store });
    auditFault.failNext("unavailable");
    expect(await auditHarness.recovery.recordVerificationEvidence({ tenantId: TENANT,
      rsid: RSID, envelopeDigest: auditHarness.verificationPending.envelopeDigest }))
      .toMatchObject({ kind: "unavailable", code: "durability_uncertain" });
    const auditSnapshot = await auditHarness.recovery.snapshot({ tenantId: TENANT, rsid: RSID });
    expect(auditSnapshot).toMatchObject({ pendingDispatch: {
      envelopeDigest: auditHarness.verificationPending.envelopeDigest,
    }, resolutionPlan: null });

    const planBase = createRestartableTestStore();
    const planFault = faultableStore(planBase.store);
    const planHarness = await createDecisionHarness({ runId: "fault-plan-owner",
      store: planFault.store });
    const recorded = await planHarness.recovery.recordVerificationEvidence({ tenantId: TENANT,
      rsid: RSID, envelopeDigest: planHarness.verificationPending.envelopeDigest });
    if (recorded.kind !== "recorded") throw new Error("plan fault evidence setup failed");
    const planned = await planHarness.recovery.planRecoveryClearances({ tenantId: TENANT,
      rsid: RSID, mutationScopes: [recorded.hold.mutationScope],
      decisions: [{ holdId: recorded.hold.holdId, decision: "postcondition_verified" }] });
    if (planned.kind !== "planned") throw new Error("plan fault setup failed");
    planFault.failNext("cas_conflict");
    expect(await planHarness.workflow.recordPlan({ context: planHarness.verifyContext,
      hold: recorded.hold, plan: planned.plan })).toBeNull();
    const nextContext = context({ invocationId: uuid7(720),
      toolName: "conformance.fixture.mutation_probe_next", method: "fixture_complete_mutation_probe",
      policyClass: "confirm", confirmationId: uuid7(721) });
    const nextDraft = envelope({ context: nextContext, method: "fixture_complete_mutation_probe", seq: 4 });
    expect(await planHarness.workflow.prepareNext({ context: nextContext,
      sessionBindingId: SESSION_BINDING, connectionId: CONNECTION,
      envelope: nextDraft, expected: expected(nextDraft) })).toBeNull();
    const owners = await planFault.store.transact({ tenantId: TENANT }, (tx) =>
      tx.list(MUTATION_PROBE_OWNER_NAMESPACE));
    if (!owners.ok) throw new Error("fault owner list unavailable");
    expect(owners.value.filter((row) => row.key.startsWith("fault-plan-owner:"))).toHaveLength(1);
  });

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
    const harness = await createDecisionHarness({ runId: "run-1" });
    expect(isMutationProbeVerificationWorkflow(harness.workflow, {
      protocolStore: harness.store,
      bridgeAuthority: harness.bridgeAuthority,
      recoveryAuthority: harness.recovery,
    })).toBe(true);
    expect(isMutationProbeVerificationWorkflow({ ...harness.workflow })).toBe(false);
    const recorded = await harness.recovery.recordVerificationEvidence({ tenantId: TENANT,
      rsid: RSID, envelopeDigest: harness.verificationPending.envelopeDigest });
    if (recorded.kind !== "recorded") throw new Error("evidence not recorded");
    const planned = await harness.recovery.planRecoveryClearances({ tenantId: TENANT, rsid: RSID,
      mutationScopes: [recorded.hold.mutationScope],
      decisions: [{ holdId: recorded.hold.holdId, decision: "postcondition_verified" }] });
    if (planned.kind !== "planned") throw new Error("clearance not planned");
    expect(await harness.workflow.recordPlan({ context: harness.verifyContext,
      hold: recorded.hold, plan: planned.plan })).toMatchObject({
        holdId: harness.holdId,
        resolutionId: planned.plan.items[0]!.resolutionId,
      });
    expect(await harness.recovery.releaseInvocationWindow({ tenantId: TENANT, rsid: RSID,
      attemptId: harness.verifyAttempt }))
      .toMatchObject({ kind: "released" });

    const nextContext = context({ invocationId: uuid7(6),
      toolName: "conformance.fixture.mutation_probe_next", method: "fixture_complete_mutation_probe",
      policyClass: "confirm", confirmationId: uuid7(7) });
    const nextDraft = envelope({ context: nextContext, method: "fixture_complete_mutation_probe", seq: 3 });
    const next = await harness.workflow.prepareNext({ context: nextContext, sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION, envelope: nextDraft, expected: expected(nextDraft) });
    expect(next?.expected.recoveryClearances).toEqual(planned.plan.clearances);

    const driftedContext = context({ invocationId: uuid7(8), mcpSessionId: "mcp-b",
      toolName: "conformance.fixture.mutation_probe_next", method: "fixture_complete_mutation_probe",
      policyClass: "confirm", confirmationId: uuid7(9) });
    const driftedDraft = envelope({ context: driftedContext, method: "fixture_complete_mutation_probe", seq: 4 });
    expect(await harness.workflow.prepareNext({ context: driftedContext, sessionBindingId: SESSION_BINDING,
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
