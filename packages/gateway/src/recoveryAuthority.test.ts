import {
  makeBatchDigest,
  makeMutationHoldId,
  makeParamsDigest,
  markJournalExecuting,
  markJournalIndeterminate,
  recordJournalTerminal,
  type BatchResult,
  type BatchStep,
  type HoldEvidenceConclusion,
  type HelloEnvelope,
  type InvocationJournalBinding,
  type InvocationJournalRecord,
  type InvokeBatchEnvelope,
  type InvokeEnvelope,
  type JsonValue,
  type MutationScope,
  type RbpEnvelope,
  type RecoveryClearance,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import type {
  GatewayConfirmationProof,
  GatewayConfirmationTransactionAuthority,
} from "./confirmationAuthority.js";
import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import {
  GATEWAY_RECOVERY_NAMESPACE,
  GatewayRecoveryAuthority,
  type GatewayAuditedRecoveryDecisionPort,
  type GatewayBridgeEvidenceLookup,
  type GatewayBridgeCumulativeAckReceipt,
  type GatewayDurableBridgeEvidencePort,
  type GatewayDurableBatchTerminal,
  type GatewayDurableDispatchObservation,
  type GatewayExpectedDispatchBinding,
  type GatewayExpectedMutationDispatch,
  type GatewayExpectedVerificationDispatch,
  type GatewayRecoveryEvidenceCandidate,
  type GatewayRecoveryPendingDispatch,
  type GatewayRecoveryRecord,
  type GatewayRecoveryResolutionPlan,
  type GatewayVerifiedBridgeJournalEvidence,
} from "./recoveryAuthority.js";
import {
  createRestartableTestStore,
  type RestartableTestStore,
} from "./testAdapters.js";
import {
  GatewayBridgeSessionAuthority,
  type BridgeConnectionChannel,
  type DispatchTransportHandoff,
} from "./bridgeSession.js";
import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type DeviceAuthContext,
  type IdentityPort,
} from "./authContext.js";
import type { GatewayExecutorRequest } from "./dispatch.js";

const NOW = "2026-08-09T12:00:00.000Z";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const RSID_A = "rsid-a";
const RSID_B = "rsid-b";
const SESSION_BINDING = "session-binding-a";
const CONNECTION = "connection-a";
const TEST_ATTEMPT_ID = uuid7(42);
const DOC_A: MutationScope = { kind: "document", document_id: "doc-a" };
const DOC_B: MutationScope = { kind: "document", document_id: "doc-b" };
const SESSION_SCOPE: MutationScope = { kind: "session" };

function uuid7(value: number): string {
  return `0197a3c2-0000-7000-8000-${String(value).padStart(12, "0")}`;
}

interface RecoveryHarness {
  readonly durable: RestartableTestStore;
  readonly bridgeEvidence: TestBridgeEvidence;
  readonly evidenceDecision: TestEvidenceDecision;
  readonly authority: GatewayRecoveryAuthority;
  restart(): Promise<GatewayRecoveryAuthority>;
}

const evidenceDecisionByAuthority = new WeakMap<
  GatewayRecoveryAuthority,
  TestEvidenceDecision
>();

class TestEvidenceDecision implements GatewayAuditedRecoveryDecisionPort {
  readonly candidates: GatewayRecoveryEvidenceCandidate[] = [];
  #nextConclusion: HoldEvidenceConclusion = "inconclusive";
  #version = 0;

  public decideNext(conclusion: HoldEvidenceConclusion): void {
    this.#nextConclusion = conclusion;
  }

  public async decideEvidence(
    _tx: Parameters<GatewayAuditedRecoveryDecisionPort["decideEvidence"]>[0],
    candidate: GatewayRecoveryEvidenceCandidate,
  ): Promise<
    Awaited<ReturnType<GatewayAuditedRecoveryDecisionPort["decideEvidence"]>>
  > {
    this.candidates.push(structuredClone(candidate));
    this.#version += 1;
    return {
      kind: "decided",
      conclusion: this.#nextConclusion,
      authorityReference: `fixture-decision-${String(this.#version)}`,
      decisionVersion: this.#version,
      decidedAtMs: 1_775_000_001_000 + this.#version,
    };
  }
}

class TestBridgeEvidence implements GatewayDurableBridgeEvidencePort {
  readonly #lookups = new Map<string, GatewayBridgeEvidenceLookup>();
  readonly inspected: GatewayExpectedDispatchBinding[] = [];
  readonly dispatchTargets: Parameters<
    GatewayDurableBridgeEvidencePort["authorizeDispatchTarget"]
  >[1][] = [];
  #dispatchAuthorization: Awaited<
    ReturnType<GatewayDurableBridgeEvidencePort["authorizeDispatchTarget"]>
  > = { kind: "authorized", sessionVersion: 1 };
  #resumeAuthorization: Awaited<
    ReturnType<GatewayDurableBridgeEvidencePort["authorizeResumeTarget"]>
  > = { kind: "authorized", sessionVersion: 1 };

  public refuseDispatch(reason: string): void {
    this.#dispatchAuthorization = { kind: "not_authorized", reason };
  }

  public authorizeDispatchVersion(sessionVersion: number): void {
    this.#dispatchAuthorization = { kind: "authorized", sessionVersion };
  }

  public authorizeResumeVersion(sessionVersion: number): void {
    this.#resumeAuthorization = { kind: "authorized", sessionVersion };
  }

  public observe(
    pending: GatewayRecoveryPendingDispatch,
    input: {
      readonly acceptance?: GatewayBridgeCumulativeAckReceipt | null;
      readonly journalKind?:
        GatewayVerifiedBridgeJournalEvidence["kind"] | null;
      readonly journalRecords?: readonly InvocationJournalRecord[];
      readonly batchTerminal?: GatewayDurableBatchTerminal | null;
      readonly durableJournalVersion?: number;
      readonly recordedAtMs?: number;
      readonly noSend?: GatewayDurableDispatchObservation["noSend"];
    },
  ): void {
    const journal: GatewayVerifiedBridgeJournalEvidence | null =
      input.journalKind === undefined || input.journalKind === null
        ? null
        : {
            kind: input.journalKind,
            rsid: pending.envelope.rsid,
            sessionBindingId: pending.sessionBindingId,
            envelopeDigest: pending.envelopeDigest,
            journalRecords: structuredClone(input.journalRecords ?? []),
            batchTerminal: structuredClone(input.batchTerminal ?? null),
            durableJournalVersion: input.durableJournalVersion ?? 1,
            recordedAtMs: input.recordedAtMs ?? 1_775_000_000_600,
          };
    const observation: GatewayDurableDispatchObservation = {
      acceptance: structuredClone(input.acceptance ?? null),
      journal,
      ...(input.noSend === undefined ? {} : { noSend: structuredClone(input.noSend) }),
    };
    this.#lookups.set(pending.envelopeDigest, {
      kind: "found",
      observation,
    });
  }

  public setLookup(
    envelopeDigest: string,
    lookup: GatewayBridgeEvidenceLookup,
  ): void {
    this.#lookups.set(envelopeDigest, structuredClone(lookup));
  }

  public async inspectDispatch(
    _tx: Parameters<GatewayDurableBridgeEvidencePort["inspectDispatch"]>[0],
    expected: GatewayExpectedDispatchBinding,
  ): Promise<GatewayBridgeEvidenceLookup> {
    this.inspected.push(structuredClone(expected));
    return structuredClone(
      this.#lookups.get(expected.envelopeDigest) ?? {
        kind: "not_durable_yet" as const,
      },
    );
  }

  public async authorizeDispatchTarget(
    _tx: Parameters<
      GatewayDurableBridgeEvidencePort["authorizeDispatchTarget"]
    >[0],
    expected: Parameters<
      GatewayDurableBridgeEvidencePort["authorizeDispatchTarget"]
    >[1],
  ): Promise<
    Awaited<
      ReturnType<GatewayDurableBridgeEvidencePort["authorizeDispatchTarget"]>
    >
  > {
    this.dispatchTargets.push(structuredClone(expected));
    return structuredClone(this.#dispatchAuthorization);
  }

  public async authorizeResumeTarget(): Promise<
    Awaited<
      ReturnType<GatewayDurableBridgeEvidencePort["authorizeResumeTarget"]>
    >
  > {
    return structuredClone(this.#resumeAuthorization);
  }
}

async function createHarness(): Promise<RecoveryHarness> {
  const durable = createRestartableTestStore();
  const bridgeEvidence = new TestBridgeEvidence();
  const evidenceDecision = new TestEvidenceDecision();
  let now = 1_775_000_000_000;
  let nextId = 800_000;
  const options = {
    bridgeEvidence,
    evidenceDecision,
    clock: (): number => ++now,
    newId: (): string => uuid7(++nextId),
  };
  await durable.store.open();
  const authority = new GatewayRecoveryAuthority(durable.store, options);
  evidenceDecisionByAuthority.set(authority, evidenceDecision);
  return {
    durable,
    bridgeEvidence,
    evidenceDecision,
    authority,
    async restart(): Promise<GatewayRecoveryAuthority> {
      const restarted = durable.restart();
      await restarted.open();
      const restartedAuthority = new GatewayRecoveryAuthority(
        restarted,
        options,
      );
      evidenceDecisionByAuthority.set(restartedAuthority, evidenceDecision);
      return restartedAuthority;
    },
  };
}

function mutationEnvelope(input: {
  readonly rsid?: string;
  readonly seq: number;
  readonly invocationId: string;
  readonly scope: MutationScope;
  readonly clearances?: readonly RecoveryClearance[];
  readonly value?: number;
}): InvokeEnvelope {
  return {
    v: 1,
    type: "invoke",
    id: uuid7(100_000 + input.seq),
    ts: NOW,
    rsid: input.rsid ?? RSID_A,
    seq: input.seq,
    ack: 0,
    payload: {
      invocation_id: input.invocationId,
      method: "set_element_parameter",
      params: { value: input.value ?? input.seq },
      timeout_ms: 120_000,
      mutating: true,
      mutation_scope: structuredClone(input.scope),
      policy: {
        class: "confirm",
        decision: "confirmed",
        confirmation_id: uuid7(200_000 + input.seq),
      },
      verification: null,
      recovery_clearances: structuredClone(
        input.clearances === undefined ? [] : [...input.clearances],
      ),
    },
  };
}

function originRedeliveryEnvelope(
  envelope: InvokeEnvelope | InvokeBatchEnvelope,
  seq: number,
): InvokeEnvelope | InvokeBatchEnvelope {
  return {
    ...structuredClone(envelope),
    id: uuid7(900_000 + seq),
    seq,
    ack: envelope.seq,
    ts: NOW,
  };
}

function verificationEnvelope(input: {
  readonly rsid?: string;
  readonly seq: number;
  readonly invocationId: string;
  readonly holdId: string;
  readonly scope: MutationScope;
}): InvokeEnvelope {
  return {
    v: 1,
    type: "invoke",
    id: uuid7(300_000 + input.seq),
    ts: NOW,
    rsid: input.rsid ?? RSID_A,
    seq: input.seq,
    ack: 0,
    payload: {
      invocation_id: input.invocationId,
      method: "inspect_elements",
      params: { evidence: input.seq },
      timeout_ms: 120_000,
      mutating: false,
      mutation_scope: null,
      policy: { class: "auto", decision: "auto", confirmation_id: null },
      verification: {
        hold_id: input.holdId,
        mutation_scope: structuredClone(input.scope),
        purpose: "resolve_indeterminate",
      },
      recovery_clearances: [],
    },
  };
}

function batchMutationEnvelope(input: {
  readonly rsid?: string;
  readonly seq: number;
  readonly batchId: string;
  readonly atomic?: boolean;
  readonly steps: readonly {
    readonly invocationId: string;
    readonly scope: MutationScope;
  }[];
}): InvokeBatchEnvelope {
  const steps = input.steps.map((item, index): BatchStep => {
    const params = { index };
    return {
      invocation_id: item.invocationId,
      method: "set_element_parameter",
      params,
      params_digest: makeParamsDigest(params),
      mutating: true,
      mutation_scope: structuredClone(item.scope),
      policy: {
        class: "confirm",
        decision: "confirmed",
        confirmation_id: uuid7(400_000 + input.seq + index),
      },
    };
  }) as [BatchStep, ...BatchStep[]];
  const timeoutMs = 120_000;
  const atomic = input.atomic ?? false;
  const recoveryClearances: RecoveryClearance[] = [];
  return {
    v: 1,
    type: "invoke_batch",
    id: uuid7(500_000 + input.seq),
    ts: NOW,
    rsid: input.rsid ?? RSID_A,
    seq: input.seq,
    ack: 0,
    payload: {
      batch_id: input.batchId,
      atomic,
      timeout_ms: timeoutMs,
      recovery_clearances: recoveryClearances,
      steps,
      batch_digest: makeBatchDigest({
        batch_id: input.batchId,
        atomic,
        timeout_ms: timeoutMs,
        recovery_clearances: recoveryClearances as unknown as JsonValue[],
        steps: steps.map((step) => ({
          invocation_id: step.invocation_id,
          method: step.method,
          mutating: step.mutating,
          mutation_scope: step.mutation_scope as unknown as JsonValue,
          params_digest: step.params_digest,
          policy: step.policy,
        })),
      }),
    },
  };
}

function journalBindingsFor(
  envelope: InvokeEnvelope | InvokeBatchEnvelope,
): readonly InvocationJournalBinding[] {
  if (envelope.type === "invoke") {
    return [
      {
        rsid: envelope.rsid,
        invocationId: envelope.payload.invocation_id,
        method: envelope.payload.method,
        mutating: envelope.payload.mutating,
        mutationScope: envelope.payload.mutation_scope,
        paramsDigest: makeParamsDigest(envelope.payload.params as JsonValue),
        policy: {
          class: envelope.payload.policy.class,
          decision: envelope.payload.policy.decision,
          confirmation_id: envelope.payload.policy.confirmation_id,
        },
        verification: envelope.payload.verification,
        recoveryClearances: envelope.payload.recovery_clearances,
      },
    ];
  }
  return envelope.payload.steps.map((step, batchIndex) => ({
    rsid: envelope.rsid,
    invocationId: step.invocation_id,
    method: step.method,
    mutating: step.mutating,
    mutationScope: step.mutation_scope,
    paramsDigest: step.params_digest,
    policy: {
      class: step.policy.class,
      decision: step.policy.decision,
      confirmation_id: step.policy.confirmation_id,
    },
    verification: null,
    recoveryClearances: envelope.payload.recovery_clearances,
    batchId: envelope.payload.batch_id,
    batchIndex,
    batchDigest: envelope.payload.batch_digest,
  }));
}

function expectedMutationDispatch(
  envelope: InvokeEnvelope | InvokeBatchEnvelope,
): GatewayExpectedMutationDispatch {
  return {
    rsid: envelope.rsid,
    correlationId:
      envelope.type === "invoke"
        ? envelope.payload.invocation_id
        : envelope.payload.batch_id,
    bindings: journalBindingsFor(envelope),
    recoveryClearances: envelope.payload.recovery_clearances,
  };
}

function expectedVerificationDispatch(
  envelope: InvokeEnvelope,
): GatewayExpectedVerificationDispatch {
  return {
    rsid: envelope.rsid,
    invocationId: envelope.payload.invocation_id,
    binding: journalBindingsFor(envelope)[0]!,
  };
}

async function prepareMutation(
  authority: GatewayRecoveryAuthority,
  input: Omit<
    Parameters<GatewayRecoveryAuthority["prepareMutationDispatch"]>[0],
    "attemptId" | "expected" | "envelope"
  > & {
    readonly attemptId?: string;
    readonly envelope: InvokeEnvelope | InvokeBatchEnvelope;
  },
): ReturnType<GatewayRecoveryAuthority["prepareMutationDispatch"]> {
  const attemptId = input.attemptId ?? TEST_ATTEMPT_ID;
  const window = await authority.acquireInvocationWindow({
    tenantId: input.tenantId,
    rsid: input.envelope.rsid,
    attemptId,
  });
  if (window.kind !== "acquired" && window.kind !== "already_acquired") {
    throw new Error(`expected test invocation window, received ${window.kind}`);
  }
  return authority.prepareMutationDispatch({
    tenantId: input.tenantId,
    attemptId,
    sessionBindingId: input.sessionBindingId,
    connectionId: input.connectionId,
    envelope: input.envelope,
    expected: expectedMutationDispatch(input.envelope),
  });
}

async function prepareVerification(
  authority: GatewayRecoveryAuthority,
  input: Omit<
    Parameters<GatewayRecoveryAuthority["prepareVerificationDispatch"]>[0],
    "attemptId" | "expected" | "envelope"
  > & { readonly envelope: InvokeEnvelope },
): ReturnType<GatewayRecoveryAuthority["prepareVerificationDispatch"]> {
  const window = await authority.acquireInvocationWindow({
    tenantId: input.tenantId,
    rsid: input.envelope.rsid,
    attemptId: TEST_ATTEMPT_ID,
  });
  if (window.kind !== "acquired" && window.kind !== "already_acquired") {
    throw new Error(`expected test invocation window, received ${window.kind}`);
  }
  return authority.prepareVerificationDispatch({
    ...input,
    attemptId: TEST_ATTEMPT_ID,
    expected: expectedVerificationDispatch(input.envelope),
  });
}

function requirePending(
  result: Awaited<
    ReturnType<GatewayRecoveryAuthority["prepareMutationDispatch"]>
  >,
): GatewayRecoveryPendingDispatch {
  if (result.kind !== "prepared" && result.kind !== "already_prepared") {
    throw new Error(
      `expected prepared recovery dispatch, received ${JSON.stringify(result)}`,
    );
  }
  return result.dispatch;
}

function requireVerificationPending(
  result: Awaited<
    ReturnType<GatewayRecoveryAuthority["prepareVerificationDispatch"]>
  >,
): GatewayRecoveryPendingDispatch {
  if (result.kind !== "prepared" && result.kind !== "already_prepared") {
    throw new Error(
      `expected prepared verification dispatch, received ${JSON.stringify(result)}`,
    );
  }
  return result.dispatch;
}

function requireRecord(
  result: Awaited<ReturnType<GatewayRecoveryAuthority["snapshot"]>>,
): GatewayRecoveryRecord {
  if ("kind" in result) {
    throw new Error(`recovery snapshot unavailable: ${result.code}`);
  }
  return result;
}

function receiptFor(
  pending: GatewayRecoveryPendingDispatch,
  overrides: Partial<GatewayBridgeCumulativeAckReceipt> = {},
): GatewayBridgeCumulativeAckReceipt {
  const correlationId = pending.envelope.type === "invoke"
    ? pending.envelope.payload.invocation_id
    : pending.envelope.payload.batch_id;
  return {
    source: "durable_rbp_sequence",
    receiptVersion: 1,
    tenantId: TENANT_A,
    rsid: pending.envelope.rsid,
    sessionBindingId: pending.sessionBindingId,
    acceptedConnectionId: pending.preparedConnectionId,
    authorizedSessionVersion: pending.authorizedSessionVersion,
    invocationId: correlationId,
    correlationId,
    proofDigest: `sha256:${"a".repeat(64)}`,
    routeSnapshotDigest: `sha256:${"b".repeat(64)}`,
    egressEpoch: 1,
    leaseTicket: 1,
    intent: "dispatch",
    gatewaySequence: pending.gatewaySequence,
    cumulativeAck: pending.gatewaySequence,
    envelopeDigest: pending.envelopeDigest,
    durableSequenceVersion: 1,
    acceptedAtMs: 1_775_000_000_500,
    ...overrides,
  };
}

function reconstructedReceiptFor(
  pending: GatewayRecoveryPendingDispatch,
): GatewayBridgeCumulativeAckReceipt {
  const {
    invocationId,
    correlationId,
    proofDigest,
    routeSnapshotDigest,
    egressEpoch,
    leaseTicket,
    intent,
    ...base
  } = receiptFor(pending);
  void invocationId;
  void correlationId;
  void proofDigest;
  void routeSnapshotDigest;
  void egressEpoch;
  void leaseTicket;
  void intent;
  return base;
}

function noSendFor(
  pending: GatewayRecoveryPendingDispatch,
): NonNullable<GatewayDurableDispatchObservation["noSend"]> {
  const correlationId = pending.envelope.type === "invoke"
    ? pending.envelope.payload.invocation_id
    : pending.envelope.payload.batch_id;
  return {
    schema: "gateway.dispatch-no-send/v1",
    tenantId: TENANT_A,
    rsid: pending.envelope.rsid,
    effectiveMcpSessionId: "mcp-no-send",
    principalKey: "tenant-a:user-a",
    effectiveScopeDigest: `sha256:${"c".repeat(64)}`,
    sessionBindingId: pending.sessionBindingId,
    acceptedConnectionId: pending.preparedConnectionId,
    durableSessionVersion: pending.authorizedSessionVersion,
    invocationId: correlationId,
    correlationId,
    envelopeDigest: pending.envelopeDigest,
    gatewaySequence: pending.gatewaySequence,
    durableSequenceVersion: pending.authorizedSessionVersion,
    egressEpoch: 1,
    leaseVersion: 1,
    leaseTicket: 1,
    leaseHolderInstanceId: "gateway-instance-no-send",
    proofDigest: `sha256:${"a".repeat(64)}`,
    routeSnapshotDigest: `sha256:${"b".repeat(64)}`,
    intentDigest: `sha256:${"d".repeat(64)}`,
    authorityDigest: `sha256:${"e".repeat(64)}`,
    transportStarted: false,
    cumulativeAck: null,
    recordedAtMs: 1_775_000_000_700,
  };
}

function completedJournal(
  record: InvocationJournalRecord,
  proof: string,
): InvocationJournalRecord {
  const payload = { proof };
  return recordJournalTerminal(markJournalExecuting(record), {
    status: "completed",
    resultDigest: makeParamsDigest(payload),
    payloadRetained: true,
    payload,
  });
}

function failedJournal(
  record: InvocationJournalRecord,
  message: string,
): InvocationJournalRecord {
  return recordJournalTerminal(markJournalExecuting(record), {
    status: "failed",
    payloadRetained: true,
    payload: { fault_class: "revit_api", message },
  });
}

function durableBatchTerminal(
  result: BatchResult,
): GatewayDurableBatchTerminal {
  return {
    result: structuredClone(result),
    resultDigest: makeParamsDigest(result as unknown as JsonValue),
  };
}

interface InstalledHold {
  readonly envelope: InvokeEnvelope;
  readonly envelopeDigest: string;
  readonly holdId: string;
  readonly idempotencyKey: string;
  readonly scope: MutationScope;
  readonly journal: InvocationJournalRecord;
}

async function installIndeterminateHold(input: {
  readonly authority: GatewayRecoveryAuthority;
  readonly bridgeEvidence: TestBridgeEvidence;
  readonly tenantId?: string;
  readonly rsid?: string;
  readonly seq: number;
  readonly invocationId: string;
  readonly scope: MutationScope;
  readonly reportedHoldId?: string;
}): Promise<{
  readonly installed: InstalledHold;
  readonly result: Awaited<
    ReturnType<GatewayRecoveryAuthority["reconcilePendingDispatch"]>
  >;
}> {
  const tenantId = input.tenantId ?? TENANT_A;
  const rsid = input.rsid ?? RSID_A;
  const envelope = mutationEnvelope({
    rsid,
    seq: input.seq,
    invocationId: input.invocationId,
    scope: input.scope,
  });
  const pending = requirePending(
    await prepareMutation(input.authority, {
      tenantId,
      sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION,
      envelope,
    }),
  );
  const idempotencyKey = `${rsid}/${input.invocationId}`;
  const holdId = makeMutationHoldId(rsid, input.scope, [idempotencyKey]);
  const journal = markJournalIndeterminate(
    markJournalExecuting(pending.journalRecords[0]!),
    input.reportedHoldId ?? holdId,
  );
  input.bridgeEvidence.observe(pending, {
    acceptance: receiptFor(pending),
    journalKind: "indeterminate",
    journalRecords: [journal],
  });
  const result = await input.authority.reconcilePendingDispatch({
    tenantId,
    rsid,
    envelopeDigest: pending.envelopeDigest,
  });
  return {
    installed: {
      envelope,
      envelopeDigest: pending.envelopeDigest,
      holdId,
      idempotencyKey,
      scope: structuredClone(input.scope),
      journal,
    },
    result,
  };
}

async function recordVerification(input: {
  readonly authority: GatewayRecoveryAuthority;
  readonly bridgeEvidence: TestBridgeEvidence;
  readonly holdId: string;
  readonly scope: MutationScope;
  readonly seq: number;
  readonly conclusion: HoldEvidenceConclusion;
  readonly tenantId?: string;
  readonly rsid?: string;
}): Promise<void> {
  const tenantId = input.tenantId ?? TENANT_A;
  const rsid = input.rsid ?? RSID_A;
  const envelope = verificationEnvelope({
    rsid,
    seq: input.seq,
    invocationId: uuid7(600_000 + input.seq),
    holdId: input.holdId,
    scope: input.scope,
  });
  const pending = requireVerificationPending(
    await prepareVerification(input.authority, {
      tenantId,
      sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION,
      envelope,
    }),
  );
  const journal = completedJournal(
    pending.journalRecords[0]!,
    `verification-${String(input.seq)}`,
  );
  input.bridgeEvidence.observe(pending, {
    acceptance: receiptFor(pending),
    journalKind: "known_terminal",
    journalRecords: [journal],
  });
  const reconciled = await input.authority.reconcilePendingDispatch({
    tenantId,
    rsid,
    envelopeDigest: pending.envelopeDigest,
  });
  if (reconciled.kind !== "verification_evidence_ready") {
    throw new Error(
      `expected durable verification evidence, received ${reconciled.kind}`,
    );
  }
  const decisionAuthority = evidenceDecisionByAuthority.get(input.authority);
  if (decisionAuthority === undefined) {
    throw new Error("verification test authority has no decision fixture");
  }
  decisionAuthority.decideNext(input.conclusion);
  const result = await input.authority.recordVerificationEvidence({
    tenantId,
    rsid,
    envelopeDigest: pending.envelopeDigest,
  });
  const expectedKind =
    input.conclusion === "inconclusive" ? "inconclusive_recorded" : "recorded";
  if (result.kind !== expectedKind) {
    throw new Error(
      `expected ${expectedKind} evidence, received ${result.kind}`,
    );
  }
}

async function twoEvidenceRecordedHolds(
  authority: GatewayRecoveryAuthority,
  bridgeEvidence: TestBridgeEvidence,
): Promise<{
  readonly holds: readonly InstalledHold[];
  readonly plan: GatewayRecoveryResolutionPlan;
}> {
  const first = await installIndeterminateHold({
    authority,
    bridgeEvidence,
    seq: 10,
    invocationId: uuid7(10),
    scope: DOC_A,
  });
  const second = await installIndeterminateHold({
    authority,
    bridgeEvidence,
    seq: 11,
    invocationId: uuid7(11),
    scope: DOC_B,
  });
  if (
    first.result.kind !== "indeterminate_recorded" ||
    second.result.kind !== "indeterminate_recorded"
  ) {
    throw new Error("failed to install the two recovery holds");
  }
  await recordVerification({
    authority,
    bridgeEvidence,
    holdId: first.installed.holdId,
    scope: first.installed.scope,
    seq: 20,
    conclusion: "postcondition_verified",
  });
  await recordVerification({
    authority,
    bridgeEvidence,
    holdId: second.installed.holdId,
    scope: second.installed.scope,
    seq: 21,
    conclusion: "postcondition_verified",
  });
  const snapshot = requireRecord(
    await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
  );
  const decisions = snapshot.ledger.holds.map((hold) => ({
    holdId: hold.holdId,
    decision: "postcondition_verified" as const,
  }));
  const planned = await authority.planRecoveryClearances({
    tenantId: TENANT_A,
    rsid: RSID_A,
    mutationScopes: [SESSION_SCOPE],
    decisions,
  });
  if (planned.kind !== "planned" && planned.kind !== "already_planned") {
    throw new Error(`expected a recovery plan, received ${planned.kind}`);
  }
  return { holds: [first.installed, second.installed], plan: planned.plan };
}

describe("GatewayRecoveryAuthority durable safety", () => {
  it("requires every versioned no-send coordinate before terminalizing a pending dispatch", async () => {
    const harness = await createHarness();
    const pending = requirePending(await prepareMutation(harness.authority, {
      tenantId: TENANT_A,
      sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION,
      envelope: mutationEnvelope({
        seq: 701,
        invocationId: uuid7(701_000),
        scope: DOC_A,
      }),
    }));
    const journal = completedJournal(pending.journalRecords[0]!, "no-send");
    const valid = noSendFor(pending);
    const invalid = [
      { ...valid, tenantId: TENANT_B },
      { ...valid, rsid: RSID_B },
      { ...valid, sessionBindingId: "foreign-binding" },
      { ...valid, acceptedConnectionId: "foreign-connection" },
      { ...valid, durableSessionVersion: valid.durableSessionVersion + 1 },
      { ...valid, gatewaySequence: valid.gatewaySequence + 1 },
      { ...valid, durableSequenceVersion: valid.durableSequenceVersion + 1 },
      { ...valid, leaseVersion: 2 as never },
      { ...valid, leaseTicket: 0 },
      { ...valid, effectiveMcpSessionId: "" },
      { ...valid, principalKey: "" },
      { ...valid, effectiveScopeDigest: "sha256:not-a-digest" as never },
      { ...valid, proofDigest: "sha256:not-a-digest" as never },
      { ...valid, routeSnapshotDigest: "sha256:not-a-digest" as never },
      { ...valid, intentDigest: "sha256:not-a-digest" as never },
      { ...valid, transportStarted: true as never },
      { ...valid, cumulativeAck: 701 as never },
    ];
    for (const receipt of invalid) {
      harness.bridgeEvidence.observe(pending, {
        journalKind: "known_terminal",
        journalRecords: [journal],
        noSend: receipt,
      });
      await expect(harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      })).resolves.toMatchObject({ kind: "protocol_fault" });
      expect(requireRecord(await harness.authority.snapshot({
        tenantId: TENANT_A,
        rsid: RSID_A,
      })).pendingDispatch?.envelopeDigest).toBe(pending.envelopeDigest);
    }
    harness.bridgeEvidence.observe(pending, {
      journalKind: "known_terminal",
      journalRecords: [journal],
      noSend: valid,
    });
    await expect(harness.authority.reconcilePendingDispatch({
      tenantId: TENANT_A,
      rsid: RSID_A,
      envelopeDigest: pending.envelopeDigest,
    })).resolves.toMatchObject({ kind: "terminal_recorded" });
  });

  it("persists one invocation window across restart and acquires the same attempt idempotently", async () => {
    const harness = await createHarness();
    const attemptId = uuid7(900_001);

    await expect(
      harness.authority.acquireInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId,
      }),
    ).resolves.toEqual({ kind: "acquired" });

    const restarted = await harness.restart();
    await expect(
      restarted.acquireInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId,
      }),
    ).resolves.toEqual({ kind: "already_acquired" });
    await expect(
      restarted.acquireInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId: uuid7(900_002),
      }),
    ).resolves.toEqual({ kind: "blocked", activeAttemptId: attemptId });

    expect(
      requireRecord(
        await restarted.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).invocationWindow,
    ).toEqual({ attemptId, acquiredAtMs: 1_775_000_000_001 });
  });

  it("uses the store CAS so cross-instance concurrent attempts cannot both acquire", async () => {
    const harness = await createHarness();
    const peer = new GatewayRecoveryAuthority(harness.durable.store, {
      bridgeEvidence: harness.bridgeEvidence,
      evidenceDecision: harness.evidenceDecision,
      clock: () => 1_775_000_001_000,
    });
    const attempts = [uuid7(900_010), uuid7(900_011)] as const;

    const results = await Promise.all([
      harness.authority.acquireInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId: attempts[0],
      }),
      peer.acquireInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId: attempts[1],
      }),
    ]);

    const acquiredIndex = results.findIndex(
      (result) => result.kind === "acquired",
    );
    const blockedIndex = results.findIndex(
      (result) => result.kind === "blocked",
    );
    expect(acquiredIndex).toBeGreaterThanOrEqual(0);
    expect(blockedIndex).toBeGreaterThanOrEqual(0);
    expect(acquiredIndex).not.toBe(blockedIndex);
    expect(results[blockedIndex]).toEqual({
      kind: "blocked",
      activeAttemptId: attempts[acquiredIndex],
    });
    expect(
      requireRecord(await peer.snapshot({ tenantId: TENANT_A, rsid: RSID_A }))
        .invocationWindow?.attemptId,
    ).toBe(attempts[acquiredIndex]);
  });

  it("rejects a foreign release and makes the owning release idempotent", async () => {
    const harness = await createHarness();
    const attemptId = uuid7(900_020);
    await harness.authority.acquireInvocationWindow({
      tenantId: TENANT_A,
      rsid: RSID_A,
      attemptId,
    });

    await expect(
      harness.authority.releaseInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId: uuid7(900_021),
      }),
    ).resolves.toEqual({
      kind: "protocol_fault",
      reason: "invocation_window_attempt_mismatch",
    });
    await expect(
      harness.authority.releaseInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId,
      }),
    ).resolves.toEqual({ kind: "released" });

    const restarted = await harness.restart();
    await expect(
      restarted.releaseInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId,
      }),
    ).resolves.toEqual({ kind: "already_released" });
  });

  it("keeps the invocation window while a dispatch is pending and releases after durable terminal evidence", async () => {
    const harness = await createHarness();
    const attemptId = uuid7(900_030);
    await harness.authority.acquireInvocationWindow({
      tenantId: TENANT_A,
      rsid: RSID_A,
      attemptId,
    });
    const pending = requirePending(
      await prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        attemptId,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: mutationEnvelope({
          seq: 900,
          invocationId: uuid7(900_031),
          scope: DOC_A,
        }),
      }),
    );

    await expect(
      harness.authority.releaseInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId,
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "dispatch_pending" });
    expect(
      requireRecord(
        await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).invocationWindow?.attemptId,
    ).toBe(attemptId);

    const terminalJournal = completedJournal(
      pending.journalRecords[0]!,
      "window-terminal",
    );
    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "known_terminal",
      journalRecords: [terminalJournal],
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({ kind: "terminal_recorded" });

    const restarted = await harness.restart();
    await expect(
      restarted.releaseInvocationWindow({
        tenantId: TENANT_A,
        rsid: RSID_A,
        attemptId,
      }),
    ).resolves.toEqual({ kind: "released" });
  });

  it("rejects malformed invocation-window inputs without creating durable state", async () => {
    const { authority } = await createHarness();
    const invalidInputs = [
      { tenantId: "", rsid: RSID_A, attemptId: uuid7(900_040) },
      { tenantId: TENANT_A, rsid: "", attemptId: uuid7(900_041) },
      { tenantId: TENANT_A, rsid: RSID_A, attemptId: "" },
      { tenantId: TENANT_A, rsid: RSID_A, attemptId: "not-a-uuid-v7" },
      { tenantId: TENANT_A, rsid: RSID_A, attemptId: "x".repeat(513) },
    ] as const;

    for (const input of invalidInputs) {
      await expect(authority.acquireInvocationWindow(input)).resolves.toEqual({
        kind: "protocol_fault",
        reason: "invalid_input",
      });
      await expect(authority.releaseInvocationWindow(input)).resolves.toEqual({
        kind: "protocol_fault",
        reason: "invalid_input",
      });
    }
    expect(
      requireRecord(
        await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).invocationWindow,
    ).toBeNull();
  });

  it("fails closed when a persisted invocation window violates its runtime contract", async () => {
    const harness = await createHarness();
    const attemptId = uuid7(900_050);
    await harness.authority.acquireInvocationWindow({
      tenantId: TENANT_A,
      rsid: RSID_A,
      attemptId,
    });
    const corrupted = await harness.durable.store.transact(
      { tenantId: TENANT_A },
      async (tx) => {
        const stored = await tx.read(GATEWAY_RECOVERY_NAMESPACE, RSID_A);
        if (
          stored === null ||
          stored.value === null ||
          typeof stored.value !== "object" ||
          Array.isArray(stored.value)
        ) {
          throw new Error("expected persisted recovery record");
        }
        tx.stage({
          namespace: GATEWAY_RECOVERY_NAMESPACE,
          key: RSID_A,
          value: {
            ...stored.value,
            invocationWindow: {
              attemptId,
              acquiredAtMs: -1,
              forged: true,
            },
          },
          expect: { kind: "version", version: stored.version },
        });
      },
    );
    expect(corrupted).toMatchObject({ ok: true });

    await expect(
      harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    ).resolves.toMatchObject({ kind: "unavailable", code: "invalid_record" });
  });

  it("preserves a pending dispatch and its later hold across restarts", async () => {
    const harness = await createHarness();
    const envelope = mutationEnvelope({
      seq: 1,
      invocationId: uuid7(1),
      scope: DOC_A,
    });
    const pending = requirePending(
      await prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    const restarted = await harness.restart();
    const afterRestart = requireRecord(
      await restarted.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(afterRestart.pendingDispatch?.envelopeDigest).toBe(
      pending.envelopeDigest,
    );
    await expect(
      restarted.preflightMutation({
        tenantId: TENANT_A,
        rsid: RSID_A,
        mutationScopes: [DOC_A],
      }),
    ).resolves.toMatchObject({ kind: "blocked", reason: "dispatch_in_flight" });

    const holdId = makeMutationHoldId(RSID_A, DOC_A, [
      `${RSID_A}/${envelope.payload.invocation_id}`,
    ]);
    const indeterminate = markJournalIndeterminate(
      markJournalExecuting(pending.journalRecords[0]!),
      holdId,
    );
    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "indeterminate",
      journalRecords: [indeterminate],
    });
    await expect(
      restarted.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [holdId],
    });

    const restartedAgain = await harness.restart();
    const durable = requireRecord(
      await restartedAgain.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(durable.pendingDispatch).toBeNull();
    expect(durable.ledger.holds).toMatchObject([{ holdId, state: "active" }]);
    await expect(
      restartedAgain.preflightMutation({
        tenantId: TENANT_A,
        rsid: RSID_A,
        mutationScopes: [DOC_A],
      }),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "mutation_hold",
      holdIds: [holdId],
    });
  });

  it("requires durable per-session target authority before persisting a first send", async () => {
    const harness = await createHarness();
    harness.bridgeEvidence.refuseDispatch("connection_not_bound");
    const envelope = mutationEnvelope({
      seq: 2,
      invocationId: uuid7(2),
      scope: DOC_A,
    });

    await expect(
      prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: "foreign-connection",
        envelope,
      }),
    ).resolves.toEqual({
      kind: "blocked",
      reason: "dispatch_target_connection_not_bound",
      holdIds: [],
    });
    expect(harness.bridgeEvidence.dispatchTargets).toMatchObject([
      {
        rsid: RSID_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: "foreign-connection",
        gatewaySequence: envelope.seq,
        requiredSessionCapabilities: [],
      },
    ]);
    expect(
      requireRecord(
        await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).pendingDispatch,
    ).toBeNull();
  });

  it("rejects a resume target session-version downgrade without changing the outbox", async () => {
    const harness = await createHarness();
    harness.bridgeEvidence.authorizeDispatchVersion(2);
    const envelope = mutationEnvelope({
      seq: 59,
      invocationId: uuid7(59),
      scope: DOC_A,
    });
    const pending = requirePending(
      await prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    expect(pending.authorizedSessionVersion).toBe(2);
    const before = requireRecord(
      await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    ).pendingDispatch;

    harness.bridgeEvidence.authorizeResumeVersion(1);
    const restarted = await harness.restart();
    await expect(
      restarted.resumePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: "downgraded-connection",
      }),
    ).resolves.toEqual({
      kind: "blocked",
      reason: "resume_session_version_regression",
    });
    expect(
      requireRecord(
        await restarted.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).pendingDispatch,
    ).toEqual(before);
  });

  it("blocks fresh invocation ids and a multi-scope batch before dispatch", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const first = await installIndeterminateHold({
      authority,
      bridgeEvidence,
      seq: 2,
      invocationId: uuid7(2),
      scope: DOC_A,
    });
    const second = await installIndeterminateHold({
      authority,
      bridgeEvidence,
      seq: 3,
      invocationId: uuid7(3),
      scope: DOC_B,
    });
    expect(first.result.kind).toBe("indeterminate_recorded");
    expect(second.result.kind).toBe("indeterminate_recorded");
    const expectedHoldIds = [
      first.installed.holdId,
      second.installed.holdId,
    ].sort();

    const fresh = await prepareMutation(authority, {
      tenantId: TENANT_A,
      sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION,
      envelope: mutationEnvelope({
        seq: 4,
        invocationId: uuid7(4),
        scope: DOC_A,
      }),
    });
    expect(fresh).toMatchObject({
      kind: "blocked",
      reason: "mutation_hold",
      holdIds: [first.installed.holdId],
    });

    const batch = await prepareMutation(authority, {
      tenantId: TENANT_A,
      sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION,
      envelope: batchMutationEnvelope({
        seq: 5,
        batchId: uuid7(5),
        steps: [
          { invocationId: uuid7(51), scope: DOC_A },
          { invocationId: uuid7(52), scope: DOC_B },
        ],
      }),
    });
    expect(batch.kind).toBe("blocked");
    if (batch.kind !== "blocked")
      throw new Error("batch bypass was not blocked");
    expect(batch.holdIds).toEqual(expectedHoldIds);
  });

  it("guards every mutating member of an atomic batch and rejects a changed batch binding", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const batchId = uuid7(60);
    const invocationIds = [uuid7(61), uuid7(62)] as const;
    const envelope = batchMutationEnvelope({
      seq: 60,
      batchId,
      atomic: true,
      steps: [
        { invocationId: invocationIds[0], scope: DOC_A },
        { invocationId: invocationIds[1], scope: DOC_B },
      ],
    });
    const pending = requirePending(
      await prepareMutation(authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    expect(pending.requiredSessionCapabilities).toEqual(["batch_atomic"]);
    expect(bridgeEvidence.dispatchTargets.at(-1)).toMatchObject({
      gatewaySequence: envelope.seq,
      requiredSessionCapabilities: ["batch_atomic"],
    });
    const holdA = makeMutationHoldId(RSID_A, DOC_A, [
      `${RSID_A}/${invocationIds[0]}`,
    ]);
    const holdB = makeMutationHoldId(RSID_A, DOC_B, [
      `${RSID_A}/${invocationIds[1]}`,
    ]);
    const expectedHoldIds = [holdA, holdB].sort();
    const journalRecords = [
      markJournalIndeterminate(
        markJournalExecuting(pending.journalRecords[0]!),
        holdA,
      ),
      completedJournal(pending.journalRecords[1]!, "atomic-sibling-terminal"),
    ];
    bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "indeterminate",
      journalRecords,
    });

    await expect(
      authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "protocol_fault",
      reason: "atomic_indeterminate_member_mismatch",
      installedHoldIds: expectedHoldIds,
    });
    expect(
      requireRecord(
        await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).ledger.holds,
    ).toMatchObject(
      expectedHoldIds.map((holdId) => ({ holdId, state: "active" })),
    );

    await expect(
      prepareMutation(authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: batchMutationEnvelope({
          seq: 61,
          batchId,
          atomic: true,
          steps: [
            { invocationId: invocationIds[0], scope: DOC_A },
            { invocationId: uuid7(63), scope: DOC_B },
          ],
        }),
      }),
    ).resolves.toMatchObject({
      kind: "protocol_fault",
      reason: "batch_binding_mismatch",
    });
  });

  it("does not clear a multi-origin atomic hold from one late-terminal decision", async () => {
    const harness = await createHarness();
    const invocationIds = [uuid7(641), uuid7(642)] as const;
    const envelope = batchMutationEnvelope({
      seq: 64,
      batchId: uuid7(640),
      atomic: true,
      steps: invocationIds.map((invocationId) => ({
        invocationId,
        scope: DOC_A,
      })),
    });
    const pending = requirePending(
      await prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    const originKeys = invocationIds.map(
      (invocationId) => `${RSID_A}/${invocationId}`,
    );
    const holdId = makeMutationHoldId(RSID_A, DOC_A, originKeys);
    const indeterminate = pending.journalRecords.map((journal) =>
      markJournalIndeterminate(markJournalExecuting(journal), holdId),
    );
    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "indeterminate",
      journalRecords: indeterminate,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [holdId],
    });

    const redeliveryEnvelope = originRedeliveryEnvelope(envelope, 640);
    const redelivery = requirePending(
      await harness.authority.prepareOriginRedelivery({
        tenantId: TENANT_A,
        attemptId: TEST_ATTEMPT_ID,
        rsid: RSID_A,
        idempotencyKey: originKeys[0]!,
        sessionBindingId: SESSION_BINDING,
        connectionId: "connection-multi-origin-redelivery",
        envelope: redeliveryEnvelope,
        expected: expectedMutationDispatch(redeliveryEnvelope),
      }),
    );
    const payloads = [{ proof: "late-atomic-a" }, { proof: "late-atomic-b" }];
    const journals = redelivery.journalRecords.map((journal, index) =>
      recordJournalTerminal(journal, {
        status: "completed",
        resultDigest: makeParamsDigest(payloads[index]!),
        payloadRetained: true,
        payload: payloads[index]!,
      }),
    );
    const batchResult: BatchResult = {
      kind: "batch",
      batch_id: envelope.payload.batch_id,
      atomic: true,
      status: "completed",
      transaction_state: "committed",
      failed_step_index: null,
      replayed: true,
      steps: journals.map((journal, index) => ({
        index,
        invocation_id: invocationIds[index]!,
        status: "completed" as const,
        result: payloads[index]!,
        replayed: true as const,
        late_after_indeterminate: true as const,
        verification_hold_id: holdId,
        result_digest: journal.lateTerminalOutcome!.resultDigest!,
      })) as BatchResult["steps"],
    };
    harness.bridgeEvidence.observe(redelivery, {
      acceptance: receiptFor(redelivery),
      journalKind: "late_terminal",
      journalRecords: journals,
      batchTerminal: durableBatchTerminal(batchResult),
      durableJournalVersion: 2,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: redelivery.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [holdId],
    });

    harness.evidenceDecision.decideNext("postcondition_verified");
    await expect(
      harness.authority.recordLateTerminalEvidence({
        tenantId: TENANT_A,
        rsid: RSID_A,
        holdId,
        originIdempotencyKey: originKeys[0]!,
      }),
    ).resolves.toEqual({
      kind: "rejected",
      reason: "late_terminal_requires_single_origin_hold",
    });
    const after = requireRecord(
      await harness.authority.snapshot({
        tenantId: TENANT_A,
        rsid: RSID_A,
      }),
    );
    expect(after.ledger.holds).toMatchObject([
      {
        holdId,
        originIdempotencyKeys: originKeys,
        state: "active",
        evidenceAttempts: [],
      },
    ]);
    expect(after.evidenceDecisions).toEqual([]);
  });

  it("retains and replays the exact Section 11.1 batch carrier with a not-started suffix", async () => {
    const harness = await createHarness();
    const invocationIds = [uuid7(651), uuid7(652), uuid7(653)] as const;
    const envelope = batchMutationEnvelope({
      seq: 65,
      batchId: uuid7(650),
      atomic: false,
      steps: invocationIds.map((invocationId) => ({
        invocationId,
        scope: DOC_A,
      })),
    });
    const pending = requirePending(
      await prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    const journals = [
      completedJournal(pending.journalRecords[0]!, "batch-prefix"),
      failedJournal(pending.journalRecords[1]!, "batch-step-failed"),
      pending.journalRecords[2]!,
    ];
    const result: BatchResult = {
      kind: "batch",
      batch_id: envelope.payload.batch_id,
      atomic: false,
      status: "failed",
      transaction_state: "not_applicable",
      failed_step_index: 1,
      replayed: false,
      steps: [
        {
          index: 0,
          invocation_id: invocationIds[0],
          status: "completed",
          replayed: false,
          result: { proof: "batch-prefix" },
        },
        {
          index: 1,
          invocation_id: invocationIds[1],
          status: "failed",
          replayed: false,
          error: {
            message: "batch-step-failed",
            retryable: false,
            fault_class: "revit_api",
            outcome: "known",
            verification_required: false,
            replayed: false,
          },
        },
        {
          index: 2,
          invocation_id: invocationIds[2],
          status: "not_started",
          replayed: false,
        },
      ],
    };
    const terminal = durableBatchTerminal(result);

    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "known_terminal",
      journalRecords: journals,
      batchTerminal: {
        ...terminal,
        resultDigest: `sha256:${"0".repeat(64)}`,
      },
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "protocol_fault",
      reason: "bridge_evidence_binding_mismatch",
    });
    expect(
      requireRecord(
        await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).pendingDispatch?.envelopeDigest,
    ).toBe(pending.envelopeDigest);

    harness.bridgeEvidence.observe(pending, {
      journalKind: "known_terminal",
      journalRecords: journals,
      batchTerminal: terminal,
      durableJournalVersion: 2,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "pending",
      installedHoldIds: [],
      clearedHoldIds: [],
    });
    expect(
      requireRecord(
        await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).pendingDispatch,
    ).toMatchObject({
      journalRecords: journals,
      batchTerminal: terminal,
      journalAttestation: { kind: "known_terminal" },
      bridgeAcceptance: null,
    });
    harness.bridgeEvidence.observe(pending, {
      journalKind: "known_terminal",
      journalRecords: journals,
      batchTerminal: terminal,
      durableJournalVersion: 1,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "protocol_fault",
      reason: "pending_journal_attestation_version_regression",
    });

    const restarted = await harness.restart();
    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
    });
    await expect(
      restarted.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "terminal_recorded",
      installedHoldIds: [],
      clearedHoldIds: [],
      terminalJournalRecords: journals,
      terminalBatch: terminal,
    });
    expect(
      requireRecord(
        await restarted.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).dispatchHistory[0]?.batchTerminal,
    ).toEqual(terminal);
    await expect(
      restarted.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "terminal_recorded",
      terminalBatch: terminal,
    });
  });

  it("permits only exact retained origin redelivery", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const { installed, result } = await installIndeterminateHold({
      authority,
      bridgeEvidence,
      seq: 6,
      invocationId: uuid7(6),
      scope: DOC_A,
    });
    expect(result.kind).toBe("indeterminate_recorded");
    const unknownOriginEnvelope = originRedeliveryEnvelope(
      installed.envelope,
      60,
    );

    await expect(
      prepareMutation(authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: installed.envelope,
      }),
    ).resolves.toMatchObject({
      kind: "protocol_fault",
      reason: "origin_redelivery_requires_retained_path",
    });
    await expect(
      authority.prepareOriginRedelivery({
        tenantId: TENANT_A,
        attemptId: TEST_ATTEMPT_ID,
        rsid: RSID_A,
        idempotencyKey: `${RSID_A}/${uuid7(999)}`,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: unknownOriginEnvelope,
        expected: expectedMutationDispatch(unknownOriginEnvelope),
      }),
    ).resolves.toMatchObject({
      kind: "protocol_fault",
      reason: "origin_not_retained",
    });
    await expect(
      prepareMutation(authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: mutationEnvelope({
          seq: installed.envelope.seq,
          invocationId: installed.envelope.payload.invocation_id,
          scope: DOC_A,
          value: 999,
        }),
      }),
    ).resolves.toMatchObject({
      kind: "protocol_fault",
      reason: "idempotency_binding_mismatch",
    });
    await expect(
      prepareMutation(authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: mutationEnvelope({
          seq: 7,
          invocationId: uuid7(7),
          scope: DOC_A,
          value: 999,
        }),
      }),
    ).resolves.toMatchObject({
      kind: "blocked",
      reason: "mutation_hold",
      holdIds: [installed.holdId],
    });

    const exactRedeliveryEnvelope = originRedeliveryEnvelope(
      installed.envelope,
      61,
    );
    const redelivery = requirePending(
      await authority.prepareOriginRedelivery({
        tenantId: TENANT_A,
        attemptId: TEST_ATTEMPT_ID,
        rsid: RSID_A,
        idempotencyKey: installed.idempotencyKey,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: exactRedeliveryEnvelope,
        expected: expectedMutationDispatch(exactRedeliveryEnvelope),
      }),
    );
    expect(redelivery.originRedelivery).toBe(true);
    expect(redelivery.envelopeDigest).not.toBe(installed.envelopeDigest);
    expect(redelivery.envelope).toEqual(exactRedeliveryEnvelope);
    expect(redelivery.envelope.payload).toEqual(installed.envelope.payload);
    expect(redelivery.journalRecords).toEqual([installed.journal]);
  });

  it("redelivers an exact non-atomic batch without treating terminal siblings as uncertain origins", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const invocationIds = [uuid7(641), uuid7(642), uuid7(643)] as const;
    const envelope = batchMutationEnvelope({
      seq: 64,
      batchId: uuid7(640),
      atomic: false,
      steps: invocationIds.map((invocationId) => ({
        invocationId,
        scope: DOC_A,
      })),
    });
    const pending = requirePending(
      await prepareMutation(authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    const uncertainOriginKey = `${RSID_A}/${invocationIds[1]}`;
    const holdId = makeMutationHoldId(RSID_A, DOC_A, [uncertainOriginKey]);
    bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "indeterminate",
      journalRecords: [
        completedJournal(pending.journalRecords[0]!, "completed-prefix"),
        markJournalIndeterminate(
          markJournalExecuting(pending.journalRecords[1]!),
          holdId,
        ),
        pending.journalRecords[2]!,
      ],
    });
    await expect(
      authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [holdId],
    });

    const redeliveryEnvelope = originRedeliveryEnvelope(envelope, 65);
    await expect(
      authority.prepareOriginRedelivery({
        tenantId: TENANT_A,
        attemptId: TEST_ATTEMPT_ID,
        rsid: RSID_A,
        idempotencyKey: uncertainOriginKey,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: redeliveryEnvelope,
        expected: expectedMutationDispatch(redeliveryEnvelope),
      }),
    ).resolves.toMatchObject({
      kind: "prepared",
      dispatch: { originRedelivery: true, recoveryHoldIds: [holdId] },
    });
  });

  it("retains inconclusive verification and records only conclusive evidence", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const { installed, result } = await installIndeterminateHold({
      authority,
      bridgeEvidence,
      seq: 8,
      invocationId: uuid7(8),
      scope: DOC_A,
    });
    expect(result.kind).toBe("indeterminate_recorded");

    await recordVerification({
      authority,
      bridgeEvidence,
      holdId: installed.holdId,
      scope: DOC_A,
      seq: 30,
      conclusion: "inconclusive",
    });
    const inconclusive = requireRecord(
      await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    ).ledger.holds[0]!;
    expect(inconclusive).toMatchObject({
      holdId: installed.holdId,
      state: "active",
      selectedEvidence: null,
    });
    expect(inconclusive.evidenceAttempts).toHaveLength(1);
    await expect(
      authority.preflightMutation({
        tenantId: TENANT_A,
        rsid: RSID_A,
        mutationScopes: [DOC_A],
      }),
    ).resolves.toMatchObject({ kind: "blocked", reason: "mutation_hold" });

    await recordVerification({
      authority,
      bridgeEvidence,
      holdId: installed.holdId,
      scope: DOC_A,
      seq: 31,
      conclusion: "postcondition_verified",
    });
    const conclusive = requireRecord(
      await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    ).ledger.holds[0]!;
    expect(conclusive).toMatchObject({
      holdId: installed.holdId,
      state: "evidence_recorded",
      selectedEvidence: { conclusion: "postcondition_verified" },
    });
    expect(conclusive.evidenceAttempts).toHaveLength(2);
  });

  it("decides verification from the persisted journal attestation after restart", async () => {
    const harness = await createHarness();
    const { installed } = await installIndeterminateHold({
      authority: harness.authority,
      bridgeEvidence: harness.bridgeEvidence,
      seq: 32,
      invocationId: uuid7(320),
      scope: DOC_A,
    });
    const envelope = verificationEnvelope({
      seq: 33,
      invocationId: uuid7(330),
      holdId: installed.holdId,
      scope: DOC_A,
    });
    const pending = requireVerificationPending(
      await prepareVerification(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    const original = completedJournal(
      pending.journalRecords[0]!,
      "persisted-verification",
    );
    harness.bridgeEvidence.observe(pending, {
      journalKind: "known_terminal",
      journalRecords: [original],
      durableJournalVersion: 4,
      recordedAtMs: 1_775_000_000_604,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({ kind: "verification_evidence_ready" });

    const restarted = await harness.restart();
    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
    });
    await expect(
      restarted.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({ kind: "verification_evidence_ready" });
    const drifted = completedJournal(
      pending.journalRecords[0]!,
      "later-bridge-lookup-drift",
    );
    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "known_terminal",
      journalRecords: [drifted],
      durableJournalVersion: 4,
      recordedAtMs: 1_775_000_000_604,
    });
    const lookupsBeforeDecision = harness.bridgeEvidence.inspected.length;
    harness.evidenceDecision.decideNext("postcondition_verified");
    await expect(
      restarted.recordVerificationEvidence({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "recorded",
      hold: {
        holdId: installed.holdId,
        state: "evidence_recorded",
      },
    });
    expect(harness.bridgeEvidence.inspected).toHaveLength(
      lookupsBeforeDecision,
    );
    expect(harness.evidenceDecision.candidates.at(-1)?.journalRecord).toEqual(
      original,
    );
    expect(
      requireRecord(
        await restarted.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).evidenceDecisions.at(-1)?.evidenceDigest,
    ).toBe(original.terminalOutcome?.resultDigest);
  });

  it("rejects every malformed two-hold clearance set without a partial transition", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const { plan } = await twoEvidenceRecordedHolds(authority, bridgeEvidence);
    const before = requireRecord(
      await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(before.ledger.holds.map((hold) => hold.state)).toEqual([
      "evidence_recorded",
      "evidence_recorded",
    ]);

    const extra: RecoveryClearance = {
      hold_id: `vh:${"f".repeat(64)}`,
      mutation_scope: SESSION_SCOPE,
      resolution_id: uuid7(910_001),
      basis: "verification_read",
      verification_invocation_id: uuid7(910_002),
      evidence_digest: makeParamsDigest({ extra: true }),
      decision: "postcondition_verified",
      audit_id: uuid7(910_003),
    };
    const stale = plan.clearances.map((clearance, index) =>
      index === 0 ? { ...clearance, resolution_id: uuid7(920_001) } : clearance,
    );
    const cases: readonly {
      readonly name: string;
      readonly clearances: readonly RecoveryClearance[];
    }[] = [
      { name: "missing", clearances: plan.clearances.slice(0, 1) },
      {
        name: "extra",
        clearances: [...plan.clearances, extra].sort((left, right) =>
          left.hold_id < right.hold_id
            ? -1
            : left.hold_id > right.hold_id
              ? 1
              : 0,
        ),
      },
      {
        name: "duplicate",
        clearances: [
          plan.clearances[0]!,
          plan.clearances[0]!,
          plan.clearances[1]!,
        ],
      },
      { name: "unsorted", clearances: [...plan.clearances].reverse() },
      { name: "stale", clearances: stale },
    ];

    for (const [index, candidate] of cases.entries()) {
      const attempt = await prepareMutation(authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: mutationEnvelope({
          seq: 100 + index,
          invocationId: uuid7(700_000 + index),
          scope: SESSION_SCOPE,
          clearances: candidate.clearances,
        }),
      });
      expect(
        ["protocol_fault", "blocked"],
        `${candidate.name} clearance set must fail closed`,
      ).toContain(attempt.kind);
      const after = requireRecord(
        await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      );
      expect(
        after,
        `${candidate.name} must not persist a partial transition`,
      ).toEqual(before);
    }
  });

  it("accepts only the closed reconstructed base receipt from the durable Bridge port", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const pending = requirePending(await prepareMutation(authority, {
      tenantId: TENANT_A,
      sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION,
      envelope: mutationEnvelope({
        seq: 199,
        invocationId: uuid7(749_999),
        scope: SESSION_SCOPE,
      }),
    }));
    const journal = completedJournal(pending.journalRecords[0]!, "reconstructed-base");
    const receipt = reconstructedReceiptFor(pending);
    bridgeEvidence.observe(pending, {
      acceptance: receipt,
      journalKind: "known_terminal",
      journalRecords: [journal],
    });
    await expect(authority.reconcilePendingDispatch({
      tenantId: TENANT_A,
      rsid: RSID_A,
      envelopeDigest: pending.envelopeDigest,
    })).resolves.toMatchObject({ kind: "terminal_recorded" });
    for (const field of ["invocationId", "correlationId", "proofDigest", "routeSnapshotDigest",
      "egressEpoch", "leaseTicket", "intent"] as const) {
      expect(receipt).not.toHaveProperty(field);
    }
  });

  it("clears every-and-only resolved hold only after the exact durable cumulative ACK", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const { plan } = await twoEvidenceRecordedHolds(authority, bridgeEvidence);
    const pending = requirePending(
      await prepareMutation(authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope: mutationEnvelope({
          seq: 200,
          invocationId: uuid7(750_000),
          scope: SESSION_SCOPE,
          clearances: plan.clearances,
        }),
      }),
    );
    const holdIds = plan.clearances.map((clearance) => clearance.hold_id);
    const prepared = requireRecord(
      await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(prepared.ledger.holds.map((hold) => hold.state)).toEqual([
      "resolved_pending_bridge",
      "resolved_pending_bridge",
    ]);
    expect(prepared.pendingDispatch?.recoveryHoldIds).toEqual(holdIds);

    const publicSurface = authority as unknown as Record<string, unknown>;
    expect(publicSurface.acceptBridgeCumulativeAck).toBeUndefined();
    expect(publicSurface.recordKnownTerminal).toBeUndefined();
    expect(publicSurface.recordIndeterminate).toBeUndefined();

    const terminalJournals = pending.journalRecords.map((journal, index) =>
      completedJournal(journal, `mutation-${String(index)}`),
    );
    bridgeEvidence.observe(pending, {
      journalKind: "known_terminal",
      journalRecords: terminalJournals,
    });
    await expect(
      authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "pending",
      installedHoldIds: [],
      clearedHoldIds: [],
    });
    expect(
      requireRecord(
        await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).ledger.holds.map((hold) => hold.state),
    ).toEqual(["resolved_pending_bridge", "resolved_pending_bridge"]);

    const reconstructed = reconstructedReceiptFor(pending);
    const full = receiptFor(pending);
    const partialReceipts = ([
      "invocationId",
      "correlationId",
      "proofDigest",
      "routeSnapshotDigest",
      "egressEpoch",
      "leaseTicket",
      "intent",
    ] as const).map((field) => ({
      ...reconstructed,
      [field]: full[field],
    }) as GatewayBridgeCumulativeAckReceipt);
    const wrongAcks: readonly GatewayBridgeCumulativeAckReceipt[] = [
      receiptFor(pending, {
        cumulativeAck: pending.gatewaySequence - 1,
      }),
      receiptFor(pending, {
        envelopeDigest: makeParamsDigest({ wrong: "envelope" }),
      }),
      receiptFor(pending, {
        acceptedConnectionId: "different-connection",
      }),
      receiptFor(pending, {
        authorizedSessionVersion: pending.authorizedSessionVersion + 1,
      }),
      receiptFor(pending, {
        tenantId: "tenant-foreign",
      }),
      receiptFor(pending, {
        correlationId: uuid7(750_001),
      }),
      receiptFor(pending, {
        proofDigest: `sha256:${"z".repeat(64)}` as `sha256:${string}`,
      }),
      ...partialReceipts,
    ];
    for (const receipt of wrongAcks) {
      bridgeEvidence.observe(pending, { acceptance: receipt });
      await expect(
        authority.reconcilePendingDispatch({
          tenantId: TENANT_A,
          rsid: RSID_A,
          envelopeDigest: pending.envelopeDigest,
        }),
      ).resolves.toMatchObject({
        kind: "protocol_fault",
        reason: "bridge_evidence_binding_mismatch",
      });
      expect(
        requireRecord(
          await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
        ).ledger.holds.map((hold) => hold.state),
      ).toEqual(["resolved_pending_bridge", "resolved_pending_bridge"]);
    }

    const exactReceipt = receiptFor(pending);
    bridgeEvidence.observe(pending, { acceptance: exactReceipt });
    await expect(
      authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "terminal_recorded",
      installedHoldIds: [],
      clearedHoldIds: holdIds,
      terminalJournalRecords: terminalJournals,
      terminalBatch: null,
    });
    const accepted = requireRecord(
      await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(accepted.ledger.holds.map((hold) => hold.state)).toEqual([
      "cleared",
      "cleared",
    ]);
    expect(accepted.ledger.holds.map((hold) => hold.clearedBy)).toEqual([
      pending.envelopeDigest,
      pending.envelopeDigest,
    ]);
    bridgeEvidence.observe(pending, {
      acceptance: exactReceipt,
      journalKind: "known_terminal",
      journalRecords: terminalJournals,
    });
    await expect(
      authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "terminal_recorded",
      installedHoldIds: [],
      clearedHoldIds: holdIds,
      terminalJournalRecords: terminalJournals,
      terminalBatch: null,
    });
    expect(
      requireRecord(
        await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ).pendingDispatch,
    ).toBeNull();
  });

  it("retains a pre-ACK clearance dispatch across restart and retransmits only its exact envelope", async () => {
    const harness = await createHarness();
    const { plan } = await twoEvidenceRecordedHolds(
      harness.authority,
      harness.bridgeEvidence,
    );
    const envelope = mutationEnvelope({
      seq: 250,
      invocationId: uuid7(760_000),
      scope: SESSION_SCOPE,
      clearances: plan.clearances,
    });
    const pending = requirePending(
      await prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    const holdIds = plan.clearances.map((clearance) => clearance.hold_id);
    const bridgeReportedHold = makeMutationHoldId(RSID_A, SESSION_SCOPE, [
      `${RSID_A}/${envelope.payload.invocation_id}`,
    ]);
    const indeterminate = markJournalIndeterminate(
      markJournalExecuting(pending.journalRecords[0]!),
      bridgeReportedHold,
    );
    harness.bridgeEvidence.observe(pending, {
      journalKind: "indeterminate",
      journalRecords: [indeterminate],
    });

    const reconciled = await harness.authority.reconcilePendingDispatch({
      tenantId: TENANT_A,
      rsid: RSID_A,
      envelopeDigest: pending.envelopeDigest,
    });
    expect(reconciled).toMatchObject({ installedHoldIds: holdIds });
    const beforeRestart = requireRecord(
      await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(beforeRestart.pendingDispatch?.envelope).toEqual(envelope);
    expect(beforeRestart.pendingDispatch?.bridgeAcceptance).toBeNull();
    expect(beforeRestart.ledger.holds).toHaveLength(holdIds.length);
    expect(beforeRestart.ledger.holds.map((hold) => hold.holdId)).toEqual(
      holdIds,
    );
    expect(beforeRestart.ledger.holds.map((hold) => hold.state)).toEqual([
      "resolved_pending_bridge",
      "resolved_pending_bridge",
    ]);

    const restarted = await harness.restart();
    const resumed = await restarted.resumePendingDispatch({
      tenantId: TENANT_A,
      rsid: RSID_A,
      sessionBindingId: SESSION_BINDING,
      connectionId: "connection-after-restart",
    });
    expect(resumed.kind).toBe("retransmit");
    if (resumed.kind !== "retransmit") {
      throw new Error(`expected exact retransmit, received ${resumed.kind}`);
    }
    expect(resumed.dispatch.envelope).toEqual(pending.envelope);
    expect(resumed.dispatch.envelopeDigest).toBe(pending.envelopeDigest);
    expect(resumed.dispatch.gatewaySequence).toBe(pending.gatewaySequence);
    expect(resumed.dispatch.recoveryClearances).toEqual(plan.clearances);
    expect(resumed.dispatch.mutationEntries).toEqual(pending.mutationEntries);
    const afterResume = requireRecord(
      await restarted.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(afterResume.ledger.holds.map((hold) => hold.holdId)).toEqual(
      holdIds,
    );
    expect(afterResume.pendingDispatch?.envelopeDigest).toBe(
      pending.envelopeDigest,
    );
  });

  it("redelivers an accepted clearance envelope exactly after its own outcome becomes indeterminate", async () => {
    const harness = await createHarness();
    const { plan } = await twoEvidenceRecordedHolds(
      harness.authority,
      harness.bridgeEvidence,
    );
    const envelope = mutationEnvelope({
      seq: 260,
      invocationId: uuid7(761_000),
      scope: SESSION_SCOPE,
      clearances: plan.clearances,
    });
    const pending = requirePending(
      await prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    const originKey = `${RSID_A}/${envelope.payload.invocation_id}`;
    const originHoldId = makeMutationHoldId(RSID_A, SESSION_SCOPE, [originKey]);
    const indeterminate = markJournalIndeterminate(
      markJournalExecuting(pending.journalRecords[0]!),
      originHoldId,
    );
    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "indeterminate",
      journalRecords: [indeterminate],
    });

    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [originHoldId],
      clearedHoldIds: plan.clearances.map((clearance) => clearance.hold_id),
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [originHoldId],
      clearedHoldIds: plan.clearances.map((clearance) => clearance.hold_id),
    });

    const restarted = await harness.restart();
    const redeliveryEnvelope = originRedeliveryEnvelope(envelope, 261);
    const redelivery = await restarted.prepareOriginRedelivery({
      tenantId: TENANT_A,
      attemptId: TEST_ATTEMPT_ID,
      rsid: RSID_A,
      idempotencyKey: originKey,
      sessionBindingId: SESSION_BINDING,
      connectionId: "connection-clearance-redelivery",
      envelope: redeliveryEnvelope,
      expected: expectedMutationDispatch(redeliveryEnvelope),
    });
    expect(redelivery.kind).toBe("prepared");
    if (redelivery.kind !== "prepared") {
      throw new Error(
        `expected exact origin redelivery, received ${redelivery.kind}`,
      );
    }
    expect(redelivery.dispatch).toMatchObject({
      originRedelivery: true,
      envelope: redeliveryEnvelope,
      recoveryHoldIds: [originHoldId],
      recoveryClearances: plan.clearances,
    });
    expect(redelivery.dispatch.envelopeDigest).not.toBe(pending.envelopeDigest);

    const lateTerminal = recordJournalTerminal(
      redelivery.dispatch.journalRecords[0]!,
      {
        status: "completed",
        resultDigest: makeParamsDigest({ late: true }),
        payloadRetained: true,
        payload: { late: true },
      },
    );
    harness.bridgeEvidence.observe(redelivery.dispatch, {
      acceptance: receiptFor(redelivery.dispatch),
      journalKind: "late_terminal",
      journalRecords: [lateTerminal],
      durableJournalVersion: 2,
      recordedAtMs: 1_775_000_000_601,
    });
    await expect(
      restarted.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: redelivery.dispatch.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [originHoldId],
    });
    evidenceDecisionByAuthority
      .get(restarted)!
      .decideNext("postcondition_verified");
    await expect(
      restarted.recordLateTerminalEvidence({
        tenantId: TENANT_A,
        rsid: RSID_A,
        holdId: originHoldId,
        originIdempotencyKey: originKey,
      }),
    ).resolves.toMatchObject({
      kind: "recorded",
      hold: {
        holdId: originHoldId,
        state: "evidence_recorded",
        selectedEvidence: { basis: "late_terminal" },
      },
    });
  });

  it("keeps an indeterminate binding monotonic and preserves pending state on stale or conflicting attestations", async () => {
    const harness = await createHarness();
    const envelope = mutationEnvelope({
      seq: 262,
      invocationId: uuid7(762_000),
      scope: DOC_A,
    });
    const pending = requirePending(
      await prepareMutation(harness.authority, {
        tenantId: TENANT_A,
        sessionBindingId: SESSION_BINDING,
        connectionId: CONNECTION,
        envelope,
      }),
    );
    const originKey = `${RSID_A}/${envelope.payload.invocation_id}`;
    const holdId = makeMutationHoldId(RSID_A, DOC_A, [originKey]);
    const indeterminate = markJournalIndeterminate(
      markJournalExecuting(pending.journalRecords[0]!),
      holdId,
    );
    harness.bridgeEvidence.observe(pending, {
      journalKind: "indeterminate",
      journalRecords: [indeterminate],
      durableJournalVersion: 2,
      recordedAtMs: 1_775_000_000_602,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [holdId],
    });

    const beforeFault = requireRecord(
      await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(beforeFault.pendingDispatch?.envelopeDigest).toBe(
      pending.envelopeDigest,
    );
    expect(beforeFault.ledger.holds).toMatchObject([
      { holdId, state: "active" },
    ]);
    expect(beforeFault.dispatchHistory).toMatchObject([
      {
        status: "indeterminate",
        journalAttestation: { kind: "indeterminate", durableJournalVersion: 2 },
      },
    ]);

    harness.bridgeEvidence.observe(pending, {
      journalKind: "indeterminate",
      journalRecords: [indeterminate],
      durableJournalVersion: 2,
      recordedAtMs: 1_775_000_000_603,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "protocol_fault",
      reason: "journal_attestation_equal_version_mismatch",
    });
    expect(
      requireRecord(
        await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ),
    ).toEqual(beforeFault);

    const terminal = completedJournal(
      pending.journalRecords[0]!,
      "stale-terminal",
    );
    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "known_terminal",
      journalRecords: [terminal],
      durableJournalVersion: 1,
      recordedAtMs: 1_775_000_000_601,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "protocol_fault",
      reason: "journal_attestation_version_regression",
    });
    expect(
      requireRecord(
        await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ),
    ).toEqual(beforeFault);

    harness.bridgeEvidence.observe(pending, {
      acceptance: receiptFor(pending),
      journalKind: "known_terminal",
      journalRecords: [terminal],
      durableJournalVersion: 3,
      recordedAtMs: 1_775_000_000_604,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toEqual({
      kind: "protocol_fault",
      reason: "indeterminate_journal_reclassification",
    });
    expect(
      requireRecord(
        await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
      ),
    ).toEqual(beforeFault);

    harness.bridgeEvidence.observe(pending, {
      journalKind: "indeterminate",
      journalRecords: [indeterminate],
      durableJournalVersion: 2,
      recordedAtMs: 1_775_000_000_602,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: pending.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [holdId],
    });
  });

  it("records late-terminal evidence from the newest intact repeated-origin history", async () => {
    const harness = await createHarness();
    const { installed } = await installIndeterminateHold({
      authority: harness.authority,
      bridgeEvidence: harness.bridgeEvidence,
      seq: 270,
      invocationId: uuid7(770_000),
      scope: DOC_A,
    });

    const firstRedeliveryEnvelope = originRedeliveryEnvelope(
      installed.envelope,
      271,
    );
    const firstRedelivery = requirePending(
      await harness.authority.prepareOriginRedelivery({
        tenantId: TENANT_A,
        attemptId: TEST_ATTEMPT_ID,
        rsid: RSID_A,
        idempotencyKey: installed.idempotencyKey,
        sessionBindingId: SESSION_BINDING,
        connectionId: "connection-first-redelivery",
        envelope: firstRedeliveryEnvelope,
        expected: expectedMutationDispatch(firstRedeliveryEnvelope),
      }),
    );
    harness.bridgeEvidence.observe(firstRedelivery, {
      acceptance: receiptFor(firstRedelivery),
      journalKind: "indeterminate",
      journalRecords: firstRedelivery.journalRecords,
      durableJournalVersion: 2,
      recordedAtMs: 1_775_000_000_601,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: firstRedelivery.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [installed.holdId],
    });

    const secondRedeliveryEnvelope = originRedeliveryEnvelope(
      installed.envelope,
      272,
    );
    const secondRedelivery = requirePending(
      await harness.authority.prepareOriginRedelivery({
        tenantId: TENANT_A,
        attemptId: TEST_ATTEMPT_ID,
        rsid: RSID_A,
        idempotencyKey: installed.idempotencyKey,
        sessionBindingId: SESSION_BINDING,
        connectionId: "connection-second-redelivery",
        envelope: secondRedeliveryEnvelope,
        expected: expectedMutationDispatch(secondRedeliveryEnvelope),
      }),
    );
    const lateTerminal = recordJournalTerminal(
      secondRedelivery.journalRecords[0]!,
      {
        status: "completed",
        resultDigest: makeParamsDigest({ proof: "newest-repeated-origin" }),
        payloadRetained: true,
        payload: { proof: "newest-repeated-origin" },
      },
    );
    harness.bridgeEvidence.observe(secondRedelivery, {
      acceptance: receiptFor(secondRedelivery),
      journalKind: "late_terminal",
      journalRecords: [lateTerminal],
      durableJournalVersion: 3,
      recordedAtMs: 1_775_000_000_602,
    });
    await expect(
      harness.authority.reconcilePendingDispatch({
        tenantId: TENANT_A,
        rsid: RSID_A,
        envelopeDigest: secondRedelivery.envelopeDigest,
      }),
    ).resolves.toMatchObject({
      kind: "indeterminate_recorded",
      installedHoldIds: [installed.holdId],
    });

    const beforeEvidence = requireRecord(
      await harness.authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(
      beforeEvidence.dispatchHistory.map(
        (history) => history.journalAttestation,
      ),
    ).toMatchObject([
      { kind: "indeterminate", durableJournalVersion: 1 },
      { kind: "late_terminal", durableJournalVersion: 3 },
    ]);
    harness.evidenceDecision.decideNext("postcondition_verified");
    await expect(
      harness.authority.recordLateTerminalEvidence({
        tenantId: TENANT_A,
        rsid: RSID_A,
        holdId: installed.holdId,
        originIdempotencyKey: installed.idempotencyKey,
      }),
    ).resolves.toMatchObject({
      kind: "recorded",
      hold: {
        holdId: installed.holdId,
        state: "evidence_recorded",
        selectedEvidence: { basis: "late_terminal" },
      },
    });
  });

  it("installs the local guard before reporting a bridge hold-id mismatch", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const wrongHoldId = `vh:${"e".repeat(64)}`;
    const { installed, result } = await installIndeterminateHold({
      authority,
      bridgeEvidence,
      seq: 300,
      invocationId: uuid7(300),
      scope: DOC_A,
      reportedHoldId: wrongHoldId,
    });
    expect(result).toEqual({
      kind: "protocol_fault",
      reason: "reported_hold_id_mismatch",
      installedHoldIds: [installed.holdId],
    });
    const snapshot = requireRecord(
      await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(snapshot.pendingDispatch).toBeNull();
    expect(snapshot.ledger.holds).toMatchObject([
      { holdId: installed.holdId, state: "active" },
    ]);
    expect(
      snapshot.ledger.holds.some((hold) => hold.holdId === wrongHoldId),
    ).toBe(false);
    await expect(
      authority.preflightMutation({
        tenantId: TENANT_A,
        rsid: RSID_A,
        mutationScopes: [DOC_A],
      }),
    ).resolves.toMatchObject({ kind: "blocked", holdIds: [installed.holdId] });
  });

  it("isolates recovery state by both tenant and rsid", async () => {
    const { authority, bridgeEvidence } = await createHarness();
    const { installed, result } = await installIndeterminateHold({
      authority,
      bridgeEvidence,
      tenantId: TENANT_A,
      rsid: RSID_A,
      seq: 400,
      invocationId: uuid7(400),
      scope: DOC_A,
    });
    expect(result.kind).toBe("indeterminate_recorded");

    await expect(
      authority.preflightMutation({
        tenantId: TENANT_A,
        rsid: RSID_A,
        mutationScopes: [DOC_A],
      }),
    ).resolves.toMatchObject({ kind: "blocked", holdIds: [installed.holdId] });
    await expect(
      authority.preflightMutation({
        tenantId: TENANT_B,
        rsid: RSID_A,
        mutationScopes: [DOC_A],
      }),
    ).resolves.toEqual({ kind: "clear" });
    await expect(
      authority.preflightMutation({
        tenantId: TENANT_A,
        rsid: RSID_B,
        mutationScopes: [DOC_A],
      }),
    ).resolves.toEqual({ kind: "clear" });
    expect(
      requireRecord(
        await authority.snapshot({ tenantId: TENANT_B, rsid: RSID_A }),
      ).ledger.holds,
    ).toEqual([]);
    expect(
      requireRecord(
        await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_B }),
      ).ledger.holds,
    ).toEqual([]);
  });

  it("snapshots caller-owned inputs before the first await", async () => {
    const { authority } = await createHarness();
    const envelope = mutationEnvelope({
      seq: 500,
      invocationId: uuid7(500),
      scope: DOC_A,
      value: 1,
    });
    const originalEnvelope = structuredClone(envelope);
    const attemptId = uuid7(500_001);
    await authority.acquireInvocationWindow({
      tenantId: TENANT_A,
      rsid: RSID_A,
      attemptId,
    });
    const input = {
      tenantId: TENANT_A,
      attemptId,
      sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION,
      envelope,
      expected: expectedMutationDispatch(envelope),
    };
    const preparing = authority.prepareMutationDispatch(input);

    input.tenantId = TENANT_B;
    input.sessionBindingId = "mutated-session-binding";
    input.connectionId = "mutated-connection";
    envelope.rsid = RSID_B;
    envelope.payload.params = { value: 999 };
    envelope.payload.mutation_scope = {
      kind: "document",
      document_id: "doc-mutated",
    };

    const pending = requirePending(await preparing);
    expect(pending.envelope).toEqual(originalEnvelope);
    expect(pending.sessionBindingId).toBe(SESSION_BINDING);
    expect(pending.preparedConnectionId).toBe(CONNECTION);
    const originalTenant = requireRecord(
      await authority.snapshot({ tenantId: TENANT_A, rsid: RSID_A }),
    );
    expect(originalTenant.pendingDispatch?.envelope).toEqual(originalEnvelope);
    const mutatedTenant = requireRecord(
      await authority.snapshot({ tenantId: TENANT_B, rsid: RSID_B }),
    );
    expect(mutatedTenant.pendingDispatch).toBeNull();
    expect(mutatedTenant.ledger.holds).toEqual([]);
  });

  it("restores a frozen, field-identical confirmation scope after clone before authority validation", async () => {
    const durable = createRestartableTestStore();
    await durable.store.open();
    const bridgeEvidence = new TestBridgeEvidence();
    const evidenceDecision = new TestEvidenceDecision();
    const seen: GatewayConfirmationProof[] = [];
    const confirmationAuthority: GatewayConfirmationTransactionAuthority = {
      usesStore: (store) => store === durable.store,
      async validatePendingAction(_tx, proof) {
        seen.push(proof);
        return {
          kind: "rejected" as const,
          reason: "not_found" as const,
          confirmationId: null,
          pendingAction: null,
        };
      },
      stageConsumption() {
        throw new Error("rejected proof must not stage consumption");
      },
    };
    const authority = new GatewayRecoveryAuthority(durable.store, {
      bridgeEvidence,
      evidenceDecision,
      confirmationAuthority,
      clock: () => 1_775_000_000_000,
      newId: () => uuid7(920_000),
    });
    const envelope = mutationEnvelope({
      seq: 910,
      invocationId: uuid7(910),
      scope: SESSION_SCOPE,
    });
    const scope = createEffectiveMcpRequestScopeV1({
      principalKey: "tenant-a:user-a",
      transportMcpSessionId: "mcp-session-a",
      identityMcpSessionId: null,
      nowMs: 1_775_000_000_000,
    });
    const confirmationId = envelope.payload.policy.confirmation_id;
    const proof: GatewayConfirmationProof = {
      confirmToken: `rvc2.${confirmationId}.${"a".repeat(64)}.${"b".repeat(64)}.${"C".repeat(43)}`,
      originatingPreviewInvocationId: uuid7(911),
      commitInvocationId: envelope.payload.invocation_id,
      binding: {
        tenantId: TENANT_A,
        principalKey: "tenant-a:user-a",
        userId: "user-a",
        gatewaySessionId: "gateway-session-a",
        confirmationSessionId: "mcp-session-a",
        oauthClientId: "codex-desktop-a",
        rsid: envelope.rsid,
        toolName: envelope.payload.method,
        toolVersion: "1.0.0",
        commitArgsDigest: makeParamsDigest(
          envelope.payload.params as JsonValue,
        ),
        mutationScope: SESSION_SCOPE,
        documentIdentity: { kind: "live", session_document_id: "doc-a" },
      },
      effectiveMcpRequestScope: scope,
    };
    const attemptId = uuid7(912);
    await authority.acquireInvocationWindow({
      tenantId: TENANT_A,
      rsid: envelope.rsid,
      attemptId,
    });
    const input = {
      tenantId: TENANT_A,
      attemptId,
      sessionBindingId: SESSION_BINDING,
      connectionId: CONNECTION,
      envelope,
      expected: expectedMutationDispatch(envelope),
      confirmationProof: proof,
    };
    const preparing = authority.prepareMutationDispatch(input);
    (input.confirmationProof as { effectiveMcpRequestScope: typeof scope })
      .effectiveMcpRequestScope = createEffectiveMcpRequestScopeV1({
      principalKey: "tenant-a:user-mutated",
      transportMcpSessionId: "mcp-session-mutated",
      identityMcpSessionId: null,
      nowMs: 1_775_000_000_001,
    });

    await expect(preparing).resolves.toMatchObject({
      kind: "confirmation_rejected",
      reason: "not_found",
    });
    expect(seen).toHaveLength(1);
    const carried = seen[0]!.effectiveMcpRequestScope;
    expect(carried).toEqual(scope);
    expect(carried).not.toBe(scope);
    expect(Object.isFrozen(carried)).toBe(true);
    expect(() => {
      (carried as { principalKey: string }).principalKey = "mutated";
    }).toThrow();
    expect(carried).toEqual(scope);
  });

  it.each(["wss", "http_sse"] as const)(
    "PUBLIC-PORT BLOCKER: exposes its own real reserved-cancellation receipt: %s",
    async (binding) => {
      const context = await createRealNoSendContext({
        binding,
        principal: `public-${binding}`,
      });
      try {
        const observed = await inspectRealNoSendRaw(context);
        // Expected: a Gateway-authored reserved cancellation is public
        // recovery evidence with no ACK and an exact no-send receipt.
        // Actual on cb48: inspectDispatch returns protocol_fault because it
        // compares null acceptance.gatewaySequence to the expected sequence.
        expect(observed).toMatchObject({
          kind: "found",
          observation: {
            acceptance: null,
            noSend: expect.objectContaining({
              envelopeDigest: context.pending.envelopeDigest,
              transportStarted: false,
              cumulativeAck: null,
            }),
          },
        });
      } finally {
        await context.bridge.close();
      }
    },
  );
});

type RealBinding = "wss" | "http_sse";

interface RealNoSendContext {
  readonly tenantId: string;
  readonly rsid: string;
  readonly store: RestartableTestStore;
  readonly bridge: GatewayBridgeSessionAuthority;
  readonly recovery: GatewayRecoveryAuthority;
  readonly pending: GatewayRecoveryPendingDispatch;
}

function realIdentity(input: {
  readonly tenantId: string;
  readonly principal: string;
}): IdentityPort {
  return {
    kind: "fake" as const,
    async authenticateNorthRequest() {
      return {
        ok: false as const,
        port: "identity" as const,
        code: "not_configured" as const,
        message: "north identity is outside the foreign-receipt fixture",
      };
    },
    async authenticateDevice(request) {
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: {
          type: "device",
          tenantId: input.tenantId,
          userId: `user-${input.principal}`,
          deviceId: `device-${input.principal}`,
          seatId: `seat-${input.principal}`,
        },
        connectionId: request.connectionId,
        deviceStatus: "active",
        grantedConnectionCapabilities: ["transport_streamable_http"],
        grantedSessionCapabilities: [],
        deviceTokenDigest: `sha256:${(input.principal.endsWith("a") ? "a" : "b").repeat(64)}`,
      };
      return { ok: true as const, value: context };
    },
  };
}

function realHello(principal: string): HelloEnvelope {
  return {
    type: "hello",
    id: uuid7(810_000 + principal.length),
    ts: NOW,
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["transport_streamable_http"],
      bridge_version: "foreign-receipt-fixture",
      device_id: `device-${principal}`,
      machine: { hostname: `host-${principal}`, os: "windows" },
      addin_versions: ["foreign-receipt-fixture"],
    },
  };
}

function realRegistration(principal: string): Extract<RbpEnvelope, { type: "session_register" }> {
  return {
    v: 1,
    type: "session_register",
    id: uuid7(820_000 + principal.length),
    ts: NOW,
    payload: {
      local_session_key: `local-${principal}`,
      user_hint: { name: principal },
      machine: {
        hostname: `host-${principal}`,
        fingerprint: `sha256:${"1".repeat(64)}`,
      },
      revit: { version: "2026", build: "fixture", pid: 4100 },
      addin_version: "foreign-receipt-fixture",
      result_contract_version: 1,
      session_capabilities: [],
      bridge_version: "foreign-receipt-fixture",
      documents: [],
      port: 48884,
    },
  };
}

function cancellationChannel(): BridgeConnectionChannel {
  return {
    async send(): Promise<void> {},
    sendDispatchStarted(
      _serialized: string,
      handoff: DispatchTransportHandoff,
    ) {
      const failure = Promise.reject(new Error("fixture cancels before carrier invocation"));
      void failure.catch(() => undefined);
      return {
        started: failure,
        completion: failure,
        cancel: handoff.cancelBeforeStart,
      };
    },
    async close(): Promise<void> {},
  };
}

function realRequest(input: {
  readonly tenantId: string;
  readonly principal: string;
  readonly rsid: string;
  readonly ordinal: number;
}): GatewayExecutorRequest {
  const args: JsonValue = { fixture: "foreign-receipt" };
  return {
    toolName: "core.set_parameter",
    toolVersion: "1.0.0",
    executorMethod: "set_element_parameter",
    policyClass: "auto",
    mutationScopePolicy: "session",
    args,
    context: {
      invocationId: uuid7(830_000 + input.principal.length + input.ordinal),
      idempotencyKey: `${input.rsid}/${uuid7(830_000 + input.principal.length + input.ordinal)}`,
      principalKey: `${input.tenantId}:${input.principal}`,
      actor: { tenantId: input.tenantId, userId: `user-${input.principal}`, role: "user" },
      gatewaySessionId: `gateway-${input.principal}`,
      oauthClientId: `oauth-${input.principal}`,
      mcpSessionId: `mcp-${input.principal}`,
      effectiveMcpRequestScope: createEffectiveMcpRequestScopeV1({
        principalKey: `${input.tenantId}:${input.principal}`,
        transportMcpSessionId: `mcp-${input.principal}`,
        identityMcpSessionId: null,
        nowMs: 1_775_000_100_000,
      }),
      rsid: input.rsid,
      toolName: "core.set_parameter",
      toolVersion: "1.0.0",
      policyClass: "auto",
      policyDecision: "auto",
      confirmationId: null,
      originatingPreviewInvocationId: null,
      mutationScopePolicy: "session",
      mutating: true,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: `doc-${input.principal}` },
      paramsDigest: makeParamsDigest(args),
      mutationScope: SESSION_SCOPE,
      startedAtMs: 1_775_000_100_000,
    },
  };
}

function expectedFromPending(pending: GatewayRecoveryPendingDispatch): GatewayExpectedDispatchBinding {
  return {
    rsid: pending.envelope.rsid,
    sessionBindingId: pending.sessionBindingId,
    gatewaySequence: pending.gatewaySequence,
    envelopeDigest: pending.envelopeDigest,
    invocationBindings: pending.journalRecords.map((journal) => ({
      idempotencyKey: `${journal.binding.rsid}/${journal.binding.invocationId}`,
      bindingDigest: journal.bindingDigest,
    })),
  };
}

async function createRealNoSendContext(input: {
  readonly binding: RealBinding;
  readonly principal: string;
}): Promise<RealNoSendContext> {
  const tenantId = "tenant-foreign-receipt";
  const store = createRestartableTestStore();
  const bridge = new GatewayBridgeSessionAuthority(
    store.store,
    realIdentity({ tenantId, principal: input.principal }),
  );
  await bridge.open();
  const opened = await bridge.openConnection({
    deviceToken: `token-${input.principal}`,
    binding: input.binding,
    hello: realHello(input.principal),
    channel: cancellationChannel(),
  });
  await bridge.receive(opened.connectionId, realRegistration(input.principal));
  // The public registration ACK is retained by the connection channel, but
  // this test deliberately avoids a fixture-authored receipt. Read the rsid
  // through the public build surface after discovering the sole real session.
  const snapshot = store.snapshot();
  const root = snapshot.records.find(
    (record) => record.tenantId === tenantId && record.namespace === "gateway.rbp-session/v3",
  );
  if (root === undefined || typeof root.value !== "object" || root.value === null || !("rsid" in root.value)) {
    throw new Error("real bridge registration did not create a v3 session root");
  }
  const rsid = root.value.rsid;
  if (typeof rsid !== "string") throw new Error("registered rsid is invalid");
  const request = realRequest({
    tenantId,
    principal: input.principal,
    rsid,
    ordinal: 100,
  });
  const draft = bridge.buildEnvelope(request);
  const recovery = new GatewayRecoveryAuthority(store.store, {
    bridgeEvidence: bridge,
    evidenceDecision: {
      async decideEvidence() {
        return {
          kind: "decided" as const,
          conclusion: "inconclusive" as const,
          authorityReference: "foreign-receipt-fixture",
          decisionVersion: 1,
          decidedAtMs: 1_775_000_100_001,
        };
      },
    },
    clock: () => 1_775_000_100_002,
    newId: () => uuid7(840_000 + input.principal.length),
  });
  const attemptId = uuid7(850_000 + input.principal.length);
  await recovery.acquireInvocationWindow({ tenantId, rsid, attemptId });
  const prepareInput = {
    tenantId,
    attemptId,
    sessionBindingId: draft.sessionBindingId,
    connectionId: draft.connectionId,
    envelope: draft.envelope,
    expected: draft.expected,
  };
  const pending = requirePending(await recovery.prepareMutationDispatch(prepareInput));
  await expect(bridge.execute(request, pending)).resolves.toMatchObject({
    state: "failed",
    error: { code: "executor_unavailable" },
  });
  return { tenantId, rsid, store, bridge, recovery, pending };
}

async function inspectRealNoSendRaw(input: RealNoSendContext): Promise<GatewayBridgeEvidenceLookup> {
  const result = await input.store.store.transact(
    { tenantId: input.tenantId },
    async (tx) => await input.bridge.inspectDispatch(tx, expectedFromPending(input.pending)),
  );
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
