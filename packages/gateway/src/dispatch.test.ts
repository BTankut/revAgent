import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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
  type MutationScope,
} from "@revagent/protocol";
import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import {
  GatewayDispatcher,
  type GatewayDispatcherOptions,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayExecutorRequest,
} from "./dispatch.js";
import {
  canonicalParamsDigest,
  currentGatewayInvocationContext,
  type GatewayInvocationRoute,
} from "./invocationContext.js";
import { createUnavailableEventSink } from "./events.js";
import {
  GATEWAY_RECOVERY_NAMESPACE,
  GatewayRecoveryAuthority,
  type GatewayBridgeCumulativeAckReceipt,
  type GatewayBridgeEvidenceLookup,
  type GatewayDurableBridgeEvidencePort,
  type GatewayDurableDispatchObservation,
  type GatewayExpectedDispatchBinding,
  type GatewayExpectedMutationDispatch,
  type GatewayRecoveryPendingDispatch,
  type GatewayRecoveryRecord,
  type GatewayVerifiedBridgeJournalEvidence,
} from "./recoveryAuthority.js";
import { GatewayToolRegistry, type GatewayToolRecord } from "./registry.js";
import {
  createCapturingEventSink,
  createReadOnlyRecoveryAuthorityFixture,
  createRestartableTestStore,
  type CapturingEventSink,
  type RestartableTestStore,
} from "./testAdapters.js";

const autoRecord: GatewayToolRecord = {
  name: "core.test.read",
  summary: "Read a test value.",
  namespace: "core",
  version: "1.0.0",
  policyClass: "auto",
  mutationScopePolicy: "none",
  executor: "bridge",
  executorMethod: "test_read",
  inputSchema: { value: z.string().min(1) },
  inputJsonSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: {
      value: { minLength: 1, type: "string" },
    },
    required: ["value"],
    type: "object",
  },
};

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const O1_PARAMS_DIGEST_VECTORS = (
  JSON.parse(
    readFileSync(
      new URL(
        "../../protocol/conformance/fixtures/params-digest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    readonly vectors: readonly {
      readonly name: string;
      readonly params: unknown;
      readonly digest: string;
    }[];
  }
).vectors;

const auth: AuthContext = Object.freeze({
  contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
  actor: Object.freeze({
    type: "user" as const,
    tenantId: "tenant-a",
    userId: "user-a",
    role: "user" as const,
    oidcIssuer: "https://issuer.invalid/test",
    oidcSubject: "subject-a",
  }),
  session: Object.freeze({
    sessionId: "gateway-session-a",
    clientType: "mcp" as const,
    mcpSessionId: "mcp-session-test",
    oauthClientId: "codex-desktop-test",
  }),
  principalKey: "tenant-a:user-a",
  issuedAtMs: 1_000,
  expiresAtMs: null,
});

const route: GatewayInvocationRoute = Object.freeze({
  tenantId: "tenant-a",
  mcpSessionId: "mcp-session-test",
  rsid: "rsid-test-a",
  documentIdentity: Object.freeze({
    kind: "live" as const,
    session_document_id: "document-live-a",
  }),
});

const RECOVERY_NOW = "2026-08-09T12:00:00.000Z";
const SESSION_SCOPE: MutationScope = Object.freeze({
  kind: "session" as const,
});

function uuid7(value: number): string {
  return `0197a3c2-0000-7000-8000-${String(value).padStart(12, "0")}`;
}

function requirePrepared(
  result: Awaited<
    ReturnType<GatewayRecoveryAuthority["prepareMutationDispatch"]>
  >,
): GatewayRecoveryPendingDispatch {
  if (result.kind !== "prepared" && result.kind !== "already_prepared") {
    throw new Error(
      `expected prepared mutation, received ${JSON.stringify(result)}`,
    );
  }
  return result.dispatch;
}

function completedJournal(
  record: InvocationJournalRecord,
): InvocationJournalRecord {
  const payload = { ok: true };
  return recordJournalTerminal(markJournalExecuting(record), {
    status: "completed",
    resultDigest: makeParamsDigest(payload),
    payloadRetained: true,
    payload,
  });
}

function acceptanceFor(
  pending: GatewayRecoveryPendingDispatch,
): GatewayBridgeCumulativeAckReceipt {
  return {
    source: "durable_rbp_sequence",
    rsid: pending.envelope.rsid,
    sessionBindingId: pending.sessionBindingId,
    acceptedConnectionId: pending.preparedConnectionId,
    authorizedSessionVersion: pending.authorizedSessionVersion,
    gatewaySequence: pending.gatewaySequence,
    cumulativeAck: pending.gatewaySequence,
    envelopeDigest: pending.envelopeDigest,
    durableSequenceVersion: 1,
    acceptedAtMs: 1_775_000_000_500,
  };
}

class DispatchBridgeEvidence implements GatewayDurableBridgeEvidencePort {
  readonly #lookups = new Map<string, GatewayBridgeEvidenceLookup>();

  public observeTerminal(
    pending: GatewayRecoveryPendingDispatch,
    journalRecords: readonly InvocationJournalRecord[] = pending.journalRecords.map(
      completedJournal,
    ),
  ): void {
    this.#observe(pending, "known_terminal", journalRecords);
  }

  public observeIndeterminate(
    pending: GatewayRecoveryPendingDispatch,
    holdId: string,
  ): void {
    this.#observe(
      pending,
      "indeterminate",
      pending.journalRecords.map((record) =>
        markJournalIndeterminate(markJournalExecuting(record), holdId),
      ),
    );
  }

  #observe(
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
      recordedAtMs: 1_775_000_000_600,
    };
    const observation: GatewayDurableDispatchObservation = {
      acceptance: acceptanceFor(pending),
      journal,
    };
    this.#lookups.set(pending.envelopeDigest, {
      kind: "found",
      observation,
    });
  }

  public async inspectDispatch(
    _tx: Parameters<GatewayDurableBridgeEvidencePort["inspectDispatch"]>[0],
    expected: GatewayExpectedDispatchBinding,
  ): Promise<GatewayBridgeEvidenceLookup> {
    return structuredClone(
      this.#lookups.get(expected.envelopeDigest) ?? {
        kind: "not_durable_yet" as const,
      },
    );
  }

  public async authorizeDispatchTarget(): Promise<
    Awaited<
      ReturnType<GatewayDurableBridgeEvidencePort["authorizeDispatchTarget"]>
    >
  > {
    return { kind: "authorized", sessionVersion: 1 };
  }

  public async authorizeResumeTarget(): Promise<
    Awaited<
      ReturnType<GatewayDurableBridgeEvidencePort["authorizeResumeTarget"]>
    >
  > {
    return { kind: "authorized", sessionVersion: 1 };
  }
}

function mutationEnvelopeFor(
  request: GatewayExecutorRequest,
  sequence: number,
): InvokeEnvelope {
  if (request.context.mutationScope === null) {
    throw new Error("mutation test executor received a read-only context");
  }
  return {
    v: 1,
    type: "invoke",
    id: uuid7(700_000 + sequence),
    ts: RECOVERY_NOW,
    rsid: request.context.rsid,
    seq: sequence,
    ack: 0,
    payload: {
      invocation_id: request.context.invocationId,
      method: request.executorMethod,
      params: structuredClone(request.args),
      timeout_ms: 120_000,
      mutating: true,
      mutation_scope: structuredClone(request.context.mutationScope),
      policy: {
        class: "auto",
        decision: "auto",
        confirmation_id: null,
      },
      verification: null,
      recovery_clearances: [],
    },
  };
}

function expectedMutationForEnvelope(
  envelope: InvokeEnvelope,
): GatewayExpectedMutationDispatch {
  const binding: InvocationJournalBinding = {
    rsid: envelope.rsid,
    invocationId: envelope.payload.invocation_id,
    method: envelope.payload.method,
    mutating: envelope.payload.mutating,
    mutationScope: envelope.payload.mutation_scope,
    paramsDigest: makeParamsDigest(envelope.payload.params as JsonValue),
    policy: envelope.payload.policy,
    verification: envelope.payload.verification,
    recoveryClearances: envelope.payload.recovery_clearances,
  };
  return {
    rsid: envelope.rsid,
    correlationId: envelope.payload.invocation_id,
    bindings: [binding],
    recoveryClearances: envelope.payload.recovery_clearances,
  };
}

interface RecoveryExecutorHarness {
  readonly executor: GatewayExecutor;
  readonly plainExecutionCount: () => number;
  readonly prepareCount: () => number;
  readonly preparedRequests: () => readonly GatewayExecutorRequest[];
  readonly sentDispatches: () => readonly GatewayRecoveryPendingDispatch[];
}

function createRecoveryExecutor(input: {
  readonly bridgeEvidence: DispatchBridgeEvidence;
  readonly sequenceBase?: number;
  readonly terminalJournal?: (
    record: InvocationJournalRecord,
  ) => InvocationJournalRecord;
  readonly beforeExternalSend?: (
    request: GatewayExecutorRequest,
    pending: GatewayRecoveryPendingDispatch,
  ) => void | Promise<void>;
}): RecoveryExecutorHarness {
  let plainExecutions = 0;
  let prepares = 0;
  let envelopeSequence = input.sequenceBase ?? 1;
  const preparedRequests: GatewayExecutorRequest[] = [];
  const sentDispatches: GatewayRecoveryPendingDispatch[] = [];
  const executor: GatewayExecutor = {
    binding: "bridge",
    async execute() {
      plainExecutions += 1;
      return {
        state: "failed",
        error: { code: "wrong_path", message: "mutation used read execute" },
      };
    },
    buildMutationDispatch(request) {
      prepares += 1;
      preparedRequests.push(request);
      const envelope = mutationEnvelopeFor(request, envelopeSequence++);
      return {
        sessionBindingId: "session-binding-dispatch-test",
        connectionId: "connection-dispatch-test",
        envelope,
        expected: expectedMutationForEnvelope(envelope),
      };
    },
    async executePreparedMutation(request, pending) {
      sentDispatches.push(pending);
      await input.beforeExternalSend?.(request, pending);
      input.bridgeEvidence.observeTerminal(
        pending,
        pending.journalRecords.map(input.terminalJournal ?? completedJournal),
      );
      return { state: "completed", result: { ok: true } };
    },
  };
  return {
    executor,
    plainExecutionCount: () => plainExecutions,
    prepareCount: () => prepares,
    preparedRequests: () => [...preparedRequests],
    sentDispatches: () => [...sentDispatches],
  };
}

function createMutationDispatcher(input: {
  readonly recoveryAuthority: NonNullable<
    GatewayDispatcherOptions["recoveryAuthority"]
  >;
  readonly executor: GatewayExecutor;
  readonly record?: GatewayToolRecord;
  readonly idBase?: number;
}): {
  readonly dispatcher: GatewayDispatcher;
  readonly eventSink: CapturingEventSink;
  readonly mintedInvocationIds: () => readonly string[];
} {
  const eventSink = createCapturingEventSink();
  const mintedInvocationIds: string[] = [];
  let idSequence = input.idBase ?? 10_000;
  let eventSequence = 0;
  let now = 1_775_000_000_000;
  const record = input.record ?? {
    ...autoRecord,
    mutationScopePolicy: "session" as const,
  };
  return {
    dispatcher: new GatewayDispatcher(
      new GatewayToolRegistry([record]),
      [input.executor],
      {
        eventSink,
        eventSource: {
          component: "gateway-recovery-test",
          version: "0.0.0-test",
          instance: "dispatch-recovery-test",
        },
        recoveryAuthority: input.recoveryAuthority,
        clock: () => ++now,
        newAttemptId: () => uuid7(idSequence + 100_000 + ++eventSequence),
        newInvocationId: () => {
          const id = uuid7(++idSequence);
          mintedInvocationIds.push(id);
          return id;
        },
        newEventId: () => uuid7(idSequence + 200_000 + ++eventSequence),
      },
    ),
    eventSink,
    mintedInvocationIds: () => [...mintedInvocationIds],
  };
}

async function createRecoveryAuthority(
  input: {
    readonly openStore?: boolean;
    readonly durable?: RestartableTestStore;
    readonly bridgeEvidence?: DispatchBridgeEvidence;
  } = {},
): Promise<{
  readonly authority: GatewayRecoveryAuthority;
  readonly bridgeEvidence: DispatchBridgeEvidence;
  readonly durable: RestartableTestStore;
}> {
  const durable = input.durable ?? createRestartableTestStore();
  const bridgeEvidence = input.bridgeEvidence ?? new DispatchBridgeEvidence();
  if (input.openStore !== false) {
    await durable.store.open();
  }
  return {
    durable,
    bridgeEvidence,
    authority: new GatewayRecoveryAuthority(durable.store, {
      bridgeEvidence,
      evidenceDecision: {
        async decideEvidence() {
          return {
            kind: "decided" as const,
            conclusion: "inconclusive" as const,
            authorityReference: "dispatch-test-decision",
            decisionVersion: 1,
            decidedAtMs: 1_775_000_001_000,
          };
        },
      },
      clock: () => 1_775_000_000_000,
      newId: (timestampMs) => uuid7(timestampMs % 1_000_000),
    }),
  };
}

async function installSessionHold(input: {
  readonly authority: GatewayRecoveryAuthority;
  readonly bridgeEvidence: DispatchBridgeEvidence;
}): Promise<string> {
  const invocationId = uuid7(500_001);
  const params = { value: "uncertain" };
  const binding: InvocationJournalBinding = {
    rsid: route.rsid,
    invocationId,
    method: autoRecord.executorMethod,
    mutating: true,
    mutationScope: SESSION_SCOPE,
    paramsDigest: makeParamsDigest(params),
    policy: { class: "auto", decision: "auto", confirmation_id: null },
    verification: null,
    recoveryClearances: [],
  };
  const envelope: InvokeEnvelope = {
    v: 1,
    type: "invoke",
    id: uuid7(500_002),
    ts: RECOVERY_NOW,
    rsid: route.rsid,
    seq: 1,
    ack: 0,
    payload: {
      invocation_id: invocationId,
      method: autoRecord.executorMethod,
      params,
      timeout_ms: 120_000,
      mutating: true,
      mutation_scope: SESSION_SCOPE,
      policy: { class: "auto", decision: "auto", confirmation_id: null },
      verification: null,
      recovery_clearances: [],
    },
  };
  const recoveryAttemptId = uuid7(500_000);
  const window = await input.authority.acquireInvocationWindow({
    tenantId: auth.actor.tenantId,
    rsid: route.rsid,
    attemptId: recoveryAttemptId,
  });
  if (window.kind !== "acquired" && window.kind !== "already_acquired") {
    throw new Error(`expected recovery window, received ${window.kind}`);
  }
  const pending = requirePrepared(
    await input.authority.prepareMutationDispatch({
      tenantId: auth.actor.tenantId,
      attemptId: recoveryAttemptId,
      sessionBindingId: "session-binding-hold",
      connectionId: "connection-hold",
      envelope,
      expected: {
        rsid: route.rsid,
        correlationId: invocationId,
        bindings: [binding],
        recoveryClearances: [],
      },
    }),
  );
  const idempotencyKey = `${route.rsid}/${invocationId}`;
  const holdId = makeMutationHoldId(route.rsid, SESSION_SCOPE, [
    idempotencyKey,
  ]);
  input.bridgeEvidence.observeIndeterminate(pending, holdId);
  const reconciled = await input.authority.reconcilePendingDispatch({
    tenantId: auth.actor.tenantId,
    rsid: route.rsid,
    envelopeDigest: pending.envelopeDigest,
  });
  if (reconciled.kind !== "indeterminate_recorded") {
    throw new Error(
      `expected durable hold, received ${JSON.stringify(reconciled)}`,
    );
  }
  const released = await input.authority.releaseInvocationWindow({
    tenantId: auth.actor.tenantId,
    rsid: route.rsid,
    attemptId: recoveryAttemptId,
  });
  if (released.kind !== "released") {
    throw new Error(
      `expected recovery window release, received ${released.kind}`,
    );
  }
  return holdId;
}

function dispatchInput(
  args: unknown,
  overrides: {
    readonly auth?: AuthContext;
    readonly mcpSessionId?: string;
    readonly resolveRoute?: (
      auth: AuthContext,
    ) => GatewayInvocationRoute | Promise<GatewayInvocationRoute>;
    readonly route?: GatewayInvocationRoute;
  } = {},
) {
  const selectedAuth = overrides.auth ?? auth;
  const selectedRoute = overrides.route ?? route;
  return {
    toolName: autoRecord.name,
    args,
    auth: selectedAuth,
    mcpSessionId:
      overrides.mcpSessionId ??
      selectedAuth.session.mcpSessionId ??
      selectedRoute.mcpSessionId,
    resolveRoute: overrides.resolveRoute ?? (() => selectedRoute),
  } as const;
}

function createDispatcher(input: {
  readonly record?: GatewayToolRecord;
  readonly recoveryAuthority?: GatewayDispatcherOptions["recoveryAuthority"];
  readonly execute: (
    request: GatewayExecutorRequest,
  ) => Promise<GatewayExecutorOutcome>;
}): {
  readonly dispatcher: GatewayDispatcher;
  readonly executionCount: () => number;
  readonly executorRequests: () => readonly GatewayExecutorRequest[];
  readonly eventSink: CapturingEventSink;
} {
  let executions = 0;
  let sequence = 0;
  let now = 10_000;
  const executorRequests: GatewayExecutorRequest[] = [];
  const eventSink = createCapturingEventSink();
  const executor: GatewayExecutor = {
    binding: "bridge",
    async execute(request) {
      executions += 1;
      executorRequests.push(request);
      return input.execute(request);
    },
  };
  return {
    dispatcher: new GatewayDispatcher(
      new GatewayToolRegistry([input.record ?? autoRecord]),
      [executor],
      {
        eventSink,
        eventSource: {
          component: "gateway-test",
          version: "0.0.0-test",
          instance: "dispatch-test",
        },
        clock: () => {
          now += 10;
          return now;
        },
        newInvocationId: () => `invocation-${++sequence}`,
        newEventId: () => `event-${sequence}`,
        recoveryAuthority:
          input.recoveryAuthority ?? createReadOnlyRecoveryAuthorityFixture(),
      },
    ),
    executionCount: () => executions,
    executorRequests: () => [...executorRequests],
    eventSink,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("GatewayDispatcher fail-closed boundaries", () => {
  it("validates direct dispatch arguments against the registry Zod shape", async () => {
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: 42 })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: { code: "invalid_arguments" },
    });
    expect(harness.executionCount()).toBe(0);
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      params_digest: canonicalParamsDigest({ value: 42 }),
      executor_reached: false,
    });
  });

  it("audits a canonical digest for schema-invalid mutation arguments before recovery contact", async () => {
    const recovery = await createRecoveryAuthority();
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
    });
    const harness = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: executor.executor,
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: 42 })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: { code: "invalid_arguments" },
    });
    expect(harness.mintedInvocationIds()).toEqual([]);
    expect(executor.prepareCount()).toBe(0);
    expect(executor.sentDispatches()).toEqual([]);
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      params_digest: canonicalParamsDigest({ value: 42 }),
      executor_reached: false,
    });
  });

  it("blocks confirm and gated tools until policy middleware exists", async () => {
    const harness = createDispatcher({
      record: { ...autoRecord, policyClass: "confirm" },
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: { code: "policy_enforcement_unavailable" },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("preserves an executor failure as an MCP-error dispatch outcome", async () => {
    const harness = createDispatcher({
      execute: async () => ({
        state: "failed",
        error: {
          code: "bridge_revit_busy",
          message: "Revit is busy",
        },
      }),
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: {
        code: "executor_failed",
        executorCode: "bridge_revit_busy",
        message: "Revit is busy",
      },
    });
    expect(harness.executionCount()).toBe(1);
  });

  it("rejects an unknown runtime executor outcome state", async () => {
    const harness = createDispatcher({
      execute: async () =>
        ({
          state: "cancelled",
          result: {},
        }) as unknown as GatewayExecutorOutcome,
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: { code: "invalid_executor_result" },
    });
    expect(harness.executionCount()).toBe(1);
  });

  it.each([new Date(0), new Map([["value", "ready"]])])(
    "rejects a non-plain executor result instead of silently serializing it",
    async (result) => {
      const harness = createDispatcher({
        execute: async () =>
          ({
            state: "completed",
            result,
          }) as unknown as GatewayExecutorOutcome,
      });

      await expect(
        harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
      ).resolves.toMatchObject({
        ok: false,
        state: "failed",
        error: { code: "invalid_executor_result" },
      });
      expect(harness.executionCount()).toBe(1);
    },
  );

  it("binds the authenticated route, canonical digest and audit event", async () => {
    const harness = createDispatcher({
      execute: async (request) => {
        expect(currentGatewayInvocationContext()).toBe(request.context);
        return { state: "completed", result: { ok: true } };
      },
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: true,
      requestId: "invocation-1",
      state: "completed",
    });
    expect(currentGatewayInvocationContext()).toBeUndefined();

    const request = harness.executorRequests()[0];
    expect(request?.context).toMatchObject({
      actor: {
        role: "user",
        tenantId: "tenant-a",
        userId: "user-a",
      },
      documentIdentity: {
        kind: "live",
        session_document_id: "document-live-a",
      },
      executor: "bridge",
      gatewaySessionId: "gateway-session-a",
      idempotencyKey: "rsid-test-a/invocation-1",
      invocationId: "invocation-1",
      mcpSessionId: "mcp-session-test",
      mutationScope: null,
      oauthClientId: "codex-desktop-test",
      paramsDigest: canonicalParamsDigest({ value: "ready" }),
      policyClass: "auto",
      principalKey: "tenant-a:user-a",
      rsid: "rsid-test-a",
      toolName: "core.test.read",
      toolVersion: "1.0.0",
    });
    expect(harness.eventSink.captured()).toEqual([
      expect.objectContaining({
        actor: { type: "user", user_id: "user-a" },
        event_id: "event-1",
        event_type: "tool.invocation",
        seq: 1,
        session_id: "gateway-session-a",
        tenant_id: "tenant-a",
        payload: expect.objectContaining({
          completed_at_ms: 10_020,
          document_identity: {
            kind: "live",
            session_document_id: "document-live-a",
          },
          executor: "bridge",
          executor_reached: true,
          idempotency_key: "rsid-test-a/invocation-1",
          invocation_id: "invocation-1",
          mcp_session_id: "mcp-session-test",
          mutation_scope: null,
          outcome: "completed",
          outcome_error_code: null,
          params_digest: canonicalParamsDigest({ value: "ready" }),
          policy_class: "auto",
          rsid: "rsid-test-a",
          started_at_ms: 10_010,
          tool_name: "core.test.read",
          tool_version: "1.0.0",
        }),
      }),
    ]);
  });

  it.each([
    ["tenant", { ...route, tenantId: "tenant-b" }, "tenant_binding_mismatch"],
    [
      "MCP session",
      { ...route, mcpSessionId: "mcp-session-other" },
      "session_binding_mismatch",
    ],
  ] as const)(
    "rejects a cross-%s route before executor contact",
    async (_label, mismatchedRoute, detailCode) => {
      const harness = createDispatcher({
        execute: async () => ({ state: "completed", result: { ok: true } }),
      });

      await expect(
        harness.dispatcher.dispatch(
          dispatchInput(
            { value: "ready" },
            { route: mismatchedRoute as GatewayInvocationRoute },
          ),
        ),
      ).resolves.toMatchObject({
        ok: false,
        state: "failed",
        error: {
          code: "invalid_invocation_context",
          detailCode,
        },
      });
      expect(harness.executionCount()).toBe(0);
      expect(harness.eventSink.captured()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            executor_reached: false,
            outcome: "failed",
            outcome_error_code: "invalid_invocation_context",
          }),
        }),
      ]);
    },
  );

  it("rejects a resolved session mismatch while AuthContext is not yet MCP-bound", async () => {
    const unboundAuth: AuthContext = {
      ...auth,
      session: { ...auth.session, mcpSessionId: null },
    };
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready" },
          {
            auth: unboundAuth,
            mcpSessionId: "mcp-session-current",
            route: { ...route, mcpSessionId: "mcp-session-stale" },
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_invocation_context",
        detailCode: "session_binding_mismatch",
      },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("audits route-resolution failure without executor contact", async () => {
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready" },
          {
            resolveRoute: () => {
              throw new Error("authenticated route store is unavailable");
            },
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_invocation_context",
        detailCode: "route_resolution_failed",
      },
    });
    expect(harness.executionCount()).toBe(0);
    expect(harness.eventSink.captured()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          executor_reached: false,
          mcp_session_id: "mcp-session-test",
          outcome: "failed",
          rsid: null,
        }),
      }),
    ]);
  });

  it("serializes executor contact per rsid", async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const started: string[] = [];
    const harness = createDispatcher({
      execute: async (request) => {
        started.push(request.context.invocationId);
        if (request.context.invocationId === "invocation-1") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { state: "completed", result: { ok: true } };
      },
    });

    const first = harness.dispatcher.dispatch(
      dispatchInput({ value: "first" }),
    );
    await firstStarted.promise;
    const second = harness.dispatcher.dispatch(
      dispatchInput({ value: "second" }),
    );
    await Promise.resolve();
    expect(started).toEqual(["invocation-1"]);

    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(started).toEqual(["invocation-1", "invocation-2"]);
  });

  it("blocks a read in a second dispatcher while the durable rsid window is owned", async () => {
    const recovery = await createRecoveryAuthority();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = createDispatcher({
      recoveryAuthority: recovery.authority,
      execute: async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
        return { state: "completed", result: { owner: "first" } };
      },
    });
    const second = createDispatcher({
      recoveryAuthority: recovery.authority,
      execute: async () => ({
        state: "completed",
        result: { owner: "second" },
      }),
    });

    const firstOutcome = first.dispatcher.dispatch(
      dispatchInput({ value: "first" }),
    );
    await firstStarted.promise;
    await expect(
      second.dispatcher.dispatch(dispatchInput({ value: "second" })),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "recovery_blocked",
        detailCode: "dispatch_window_active",
      },
    });
    expect(second.executionCount()).toBe(0);

    releaseFirst.resolve();
    await expect(firstOutcome).resolves.toMatchObject({
      ok: true,
      state: "completed",
    });
  });

  it("allows independent rsids to execute concurrently", async () => {
    const bothStarted = deferred<void>();
    const release = deferred<void>();
    let active = 0;
    let peak = 0;
    const harness = createDispatcher({
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        if (active === 2) {
          bothStarted.resolve();
        }
        await release.promise;
        active -= 1;
        return { state: "completed", result: { ok: true } };
      },
    });

    const first = harness.dispatcher.dispatch(
      dispatchInput(
        { value: "first" },
        { route: { ...route, rsid: "rsid-a" } },
      ),
    );
    const second = harness.dispatcher.dispatch(
      dispatchInput(
        { value: "second" },
        { route: { ...route, rsid: "rsid-b" } },
      ),
    );

    await bothStarted.promise;
    expect(peak).toBe(2);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("keeps parameter digests stable across object insertion order", () => {
    expect(
      canonicalParamsDigest({
        zeta: 1,
        alpha: { second: true, first: false },
      }),
    ).toBe(
      canonicalParamsDigest({
        alpha: { first: false, second: true },
        zeta: 1,
      }),
    );
  });

  it.each(O1_PARAMS_DIGEST_VECTORS)(
    "matches the frozen O1 $name parameter digest vector",
    ({ params, digest }) => {
      expect(canonicalParamsDigest(params)).toBe(digest);
    },
  );

  it("rejects non-RFC-8785 Unicode before executor contact", async () => {
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "\ud800" })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("carries the frozen RBP session mutation scope", async () => {
    const recovery = await createRecoveryAuthority();
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
    });
    const harness = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: executor.executor,
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({ ok: true, state: "completed" });
    expect(executor.preparedRequests()[0]?.context).toMatchObject({
      mutating: true,
      mutationScope: { kind: "session" },
      mutationScopePolicy: "session",
    });
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      mutation_scope: { kind: "session" },
    });
  });

  it("derives a future document scope from the exact live route", async () => {
    const recovery = await createRecoveryAuthority();
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
    });
    const harness = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: executor.executor,
      record: { ...autoRecord, mutationScopePolicy: "document" },
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({ ok: true });
    expect(executor.preparedRequests()[0]?.context).toMatchObject({
      mutating: true,
      mutationScope: {
        kind: "document",
        document_id: "document-live-a",
      },
    });
  });

  it("checks a durable hold before minting an invocation or touching either executor mutation seam", async () => {
    const recovery = await createRecoveryAuthority();
    const holdId = await installSessionHold(recovery);
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
    });
    const harness = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: executor.executor,
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "blocked" })),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "recovery_blocked",
        detailCode: "mutation_hold",
      },
    });
    expect(harness.mintedInvocationIds()).toEqual([]);
    expect(executor.prepareCount()).toBe(0);
    expect(executor.sentDispatches()).toEqual([]);
    expect(executor.plainExecutionCount()).toBe(0);
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      invocation_id: null,
      params_digest: canonicalParamsDigest({ value: "blocked" }),
      recovery_hold_ids: [holdId],
      recovery_resolution_ids: [],
      executor_reached: false,
    });
  });

  it("fails closed before mint or executor contact when the durable authority is unavailable", async () => {
    const recovery = await createRecoveryAuthority({ openStore: false });
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
    });
    const harness = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: executor.executor,
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "unavailable" })),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "recovery_unavailable",
        detailCode: "unavailable",
      },
    });
    expect(harness.mintedInvocationIds()).toEqual([]);
    expect(executor.prepareCount()).toBe(0);
    expect(executor.sentDispatches()).toEqual([]);
    expect(executor.plainExecutionCount()).toBe(0);
  });

  it("commits the exact envelope before external send and preserves one minted id through context, journal, and audit", async () => {
    const recovery = await createRecoveryAuthority();
    let committedBeforeSend = false;
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
      beforeExternalSend(request, pending) {
        const stored = recovery.durable
          .snapshot()
          .records.find(
            (record) =>
              record.namespace === GATEWAY_RECOVERY_NAMESPACE &&
              record.tenantId === auth.actor.tenantId &&
              record.key === request.context.rsid,
          );
        expect(stored).toBeDefined();
        const durableRecord = stored?.value as unknown as GatewayRecoveryRecord;
        expect(durableRecord.pendingDispatch?.envelopeDigest).toBe(
          pending.envelopeDigest,
        );
        expect(durableRecord.pendingDispatch?.envelope).toEqual(
          pending.envelope,
        );
        expect(Object.isFrozen(pending)).toBe(true);
        expect(Object.isFrozen(pending.envelope)).toBe(true);
        expect(Object.isFrozen(pending.envelope.payload)).toBe(true);
        expect(Object.isFrozen(pending.envelope.payload.params)).toBe(true);
        expect(() => {
          (pending.envelope.payload.params as { value: string }).value =
            "tampered-after-commit";
        }).toThrow(TypeError);
        committedBeforeSend = true;
      },
    });
    const harness = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: executor.executor,
      idBase: 20_000,
    });

    const outcome = await harness.dispatcher.dispatch(
      dispatchInput({ value: "exact" }),
    );
    expect(outcome).toMatchObject({ ok: true, state: "completed" });
    expect(committedBeforeSend).toBe(true);
    expect(harness.mintedInvocationIds()).toHaveLength(1);

    const invocationId = harness.mintedInvocationIds()[0]!;
    const request = executor.preparedRequests()[0]!;
    const pending = executor.sentDispatches()[0]!;
    expect(request.context.invocationId).toBe(invocationId);
    expect(request.context.idempotencyKey).toBe(
      `${route.rsid}/${invocationId}`,
    );
    expect(pending.envelope.type).toBe("invoke");
    if (pending.envelope.type !== "invoke") {
      throw new Error("expected one invocation envelope");
    }
    expect(pending.envelope.payload.invocation_id).toBe(invocationId);
    expect(pending.mutationEntries[0]).toMatchObject({
      invocationId,
      idempotencyKey: `${route.rsid}/${invocationId}`,
    });
    expect(pending.journalRecords[0]?.binding).toMatchObject({
      invocationId,
      rsid: route.rsid,
      paramsDigest: request.context.paramsDigest,
    });
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      invocation_id: invocationId,
      idempotency_key: `${route.rsid}/${invocationId}`,
      recovery_hold_ids: [],
      recovery_resolution_ids: [],
    });
  });

  it("snapshots the mutable route before recovery awaits and releases the original rsid window", async () => {
    const recovery = await createRecoveryAuthority();
    const mutableRoute: GatewayInvocationRoute = {
      ...route,
      documentIdentity: {
        kind: "live",
        session_document_id: "document-live-a",
      },
    };
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
      beforeExternalSend() {
        (mutableRoute as { rsid: string }).rsid = "rsid-mutated";
        (
          mutableRoute.documentIdentity as {
            session_document_id: string;
          }
        ).session_document_id = "document-mutated";
      },
    });
    const harness = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: executor.executor,
      record: { ...autoRecord, mutationScopePolicy: "document" },
      idBase: 22_000,
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput({ value: "route-snapshot" }, { route: mutableRoute }),
      ),
    ).resolves.toMatchObject({ ok: true, state: "completed" });
    expect(executor.preparedRequests()[0]?.context).toMatchObject({
      rsid: "rsid-test-a",
      documentIdentity: {
        kind: "live",
        session_document_id: "document-live-a",
      },
      mutationScope: {
        kind: "document",
        document_id: "document-live-a",
      },
    });
    expect(executor.sentDispatches()[0]?.envelope.rsid).toBe("rsid-test-a");
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      rsid: "rsid-test-a",
      document_identity: {
        kind: "live",
        session_document_id: "document-live-a",
      },
    });
    const originalRecord = await recovery.authority.snapshot({
      tenantId: auth.actor.tenantId,
      rsid: "rsid-test-a",
    });
    if ("kind" in originalRecord) {
      throw new Error(`recovery snapshot failed: ${originalRecord.code}`);
    }
    expect(originalRecord.invocationWindow).toBeNull();
  });

  it("accepts a durable raw-response digest without rehashing the parsed result", async () => {
    const recovery = await createRecoveryAuthority();
    const rawResponseBody = Buffer.from(
      '{"jsonrpc":"2.0","id":"raw","result":{"ok":true}}',
      "utf8",
    );
    const rawResponseDigest =
      `sha256:${createHash("sha256").update(rawResponseBody).digest("hex")}` as const;
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
      terminalJournal(record) {
        return recordJournalTerminal(markJournalExecuting(record), {
          status: "completed",
          resultDigest: rawResponseDigest,
          payloadRetained: true,
          payload: { ok: true },
        });
      },
    });
    const harness = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: executor.executor,
      idBase: 25_000,
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "raw-digest" })),
    ).resolves.toMatchObject({
      ok: true,
      state: "completed",
      result: { ok: true },
    });
    expect(rawResponseDigest).not.toBe(makeParamsDigest({ ok: true }));
  });

  it("allows only one external send when two dispatchers race on one durable rsid", async () => {
    const recovery = await createRecoveryAuthority();
    const firstReachedSend = deferred<void>();
    const releaseFirstSend = deferred<void>();
    const firstExecutor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
      sequenceBase: 10,
      beforeExternalSend: async () => {
        firstReachedSend.resolve();
        await releaseFirstSend.promise;
      },
    });
    const secondExecutor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
      sequenceBase: 20,
    });
    const first = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: firstExecutor.executor,
      idBase: 30_000,
    });
    const second = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      executor: secondExecutor.executor,
      idBase: 40_000,
    });

    const firstDispatch = first.dispatcher.dispatch(
      dispatchInput({ value: "first" }),
    );
    await firstReachedSend.promise;
    const secondDispatch = second.dispatcher.dispatch(
      dispatchInput({ value: "second" }),
    );
    const secondOutcome = await secondDispatch;
    releaseFirstSend.resolve();
    const firstOutcome = await firstDispatch;
    const outcomes = [firstOutcome, secondOutcome];

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) =>
          !outcome.ok &&
          (outcome.error.code === "recovery_blocked" ||
            outcome.error.code === "recovery_unavailable"),
      ),
    ).toHaveLength(1);
    expect(
      firstExecutor.sentDispatches().length +
        secondExecutor.sentDispatches().length,
    ).toBe(1);
    expect(
      firstExecutor.plainExecutionCount() +
        secondExecutor.plainExecutionCount(),
    ).toBe(0);
    expect(secondExecutor.prepareCount()).toBe(0);
  });

  it("binds recovery hold and resolution identifiers into the normalized audit event", async () => {
    const bridgeEvidence = new DispatchBridgeEvidence();
    const executor = createRecoveryExecutor({ bridgeEvidence });
    const holdId = `vh:${"a".repeat(64)}`;
    const resolutionId = uuid7(600_001);
    const evidenceDigest = `sha256:${"b".repeat(64)}`;
    const envelopeDigest = `sha256:${"c".repeat(64)}` as `sha256:${string}`;
    let terminalJournalRecords: readonly InvocationJournalRecord[] = [];
    const recoveryAuthority = {
      async acquireInvocationWindow() {
        return { kind: "acquired" as const };
      },
      async releaseInvocationWindow() {
        return { kind: "released" as const };
      },
      async preflightMutation() {
        return { kind: "clear" as const };
      },
      async prepareMutationDispatch(input) {
        const envelope = input.envelope as InvokeEnvelope;
        const clearance = {
          hold_id: holdId,
          mutation_scope: SESSION_SCOPE,
          resolution_id: resolutionId,
          basis: "late_terminal" as const,
          verification_invocation_id: null,
          evidence_digest: evidenceDigest,
          decision: "postcondition_verified" as const,
          audit_id: uuid7(600_002),
        };
        terminalJournalRecords = input.expected.bindings.map((binding) =>
          completedJournal(createReceivedJournalRecord(binding)),
        );
        return {
          kind: "prepared" as const,
          dispatch: {
            kind: "mutation" as const,
            envelope,
            envelopeDigest,
            gatewaySequence: envelope.seq,
            sessionBindingId: input.sessionBindingId,
            preparedConnectionId: input.connectionId,
            authorizedSessionVersion: 1,
            requiredSessionCapabilities: [],
            mutationEntries: [],
            journalRecords: terminalJournalRecords,
            journalAttestation: null,
            batchTerminal: null,
            recoveryHoldIds: [holdId],
            recoveryClearances: [clearance],
            verificationHoldId: null,
            originRedelivery: false,
            bridgeAcceptance: null,
            preparedAtMs: 1_775_000_000_000,
          },
        };
      },
      async reconcilePendingDispatch() {
        return {
          kind: "terminal_recorded" as const,
          installedHoldIds: [],
          clearedHoldIds: [holdId],
          terminalJournalRecords,
          terminalBatch: null,
        };
      },
    } satisfies NonNullable<GatewayDispatcherOptions["recoveryAuthority"]>;
    const harness = createMutationDispatcher({
      recoveryAuthority,
      executor: executor.executor,
      idBase: 50_000,
    });

    await expect(
      harness.dispatcher.dispatch(dispatchInput({ value: "recovered" })),
    ).resolves.toMatchObject({ ok: true, state: "completed" });
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      recovery_hold_ids: [holdId],
      recovery_resolution_ids: [resolutionId],
    });
  });

  it("carries the RES-14 published document identity without APS execution", async () => {
    const publishedRoute: GatewayInvocationRoute = {
      ...route,
      documentIdentity: {
        kind: "published",
        acc_project_id: "acc-project-a",
        item_urn: "urn:adsk.wipprod:dm.lineage:item-a",
        version_urn: "urn:adsk.wipprod:fs.file:vf.item-a?version=7",
        version_number: 7,
      },
    };
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput({ value: "ready" }, { route: publishedRoute }),
      ),
    ).resolves.toMatchObject({ ok: true, state: "completed" });
    expect(harness.executorRequests()[0]?.context.documentIdentity).toEqual(
      publishedRoute.documentIdentity,
    );
    expect(harness.executorRequests()[0]?.context.mutationScope).toBeNull();
    expect(harness.eventSink.captured()[0]?.payload).toMatchObject({
      document_identity: publishedRoute.documentIdentity,
    });
  });

  it("fails closed when future document mutation authority targets a published model", async () => {
    const publishedRoute: GatewayInvocationRoute = {
      ...route,
      documentIdentity: {
        kind: "published",
        acc_project_id: "acc-project-a",
        item_urn: "urn:adsk.wipprod:dm.lineage:item-a",
        version_urn: "urn:adsk.wipprod:fs.file:vf.item-a?version=7",
        version_number: 7,
      },
    };
    const harness = createDispatcher({
      record: { ...autoRecord, mutationScopePolicy: "document" },
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput({ value: "ready" }, { route: publishedRoute }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_invocation_context",
        detailCode: "mutation_scope_policy_unsupported",
      },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("rejects an invalid published identity before executor contact", async () => {
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready" },
          {
            route: {
              ...route,
              documentIdentity: {
                kind: "published",
                acc_project_id: "acc-project-a",
                item_urn: "urn:item-a",
                version_urn: "urn:item-a:version:0",
                version_number: 0,
              },
            },
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_invocation_context",
        detailCode: "invalid_document_identity",
      },
    });
    expect(harness.executionCount()).toBe(0);
  });

  it("reports audit unavailability without hiding executor contact", async () => {
    const executor: GatewayExecutor = {
      binding: "bridge",
      async execute() {
        return { state: "completed", result: { ok: true } };
      },
    };
    const dispatcher = new GatewayDispatcher(
      new GatewayToolRegistry([autoRecord]),
      [executor],
      {
        eventSink: createUnavailableEventSink(),
        eventSource: {
          component: "gateway-test",
          version: "0.0.0-test",
          instance: "audit-unavailable-test",
        },
        newInvocationId: () => "audit-unavailable-invocation",
        newEventId: () => "audit-unavailable-event",
        recoveryAuthority: createReadOnlyRecoveryAuthorityFixture(),
      },
    );

    await expect(
      dispatcher.dispatch(dispatchInput({ value: "ready" })),
    ).resolves.toMatchObject({
      ok: false,
      executorReached: true,
      error: {
        code: "audit_unavailable",
        detailCode: "event_sink:not_implemented",
      },
    });
  });

  it("does not reclassify a durable mutation outcome when audit delivery fails", async () => {
    const recovery = await createRecoveryAuthority();
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
    });
    let sequence = 700_000;
    const dispatcher = new GatewayDispatcher(
      new GatewayToolRegistry([
        { ...autoRecord, mutationScopePolicy: "session" as const },
      ]),
      [executor.executor],
      {
        eventSink: createUnavailableEventSink(),
        eventSource: {
          component: "gateway-test",
          version: "0.0.0-test",
          instance: "mutation-audit-unavailable-test",
        },
        recoveryAuthority: recovery.authority,
        newAttemptId: () => uuid7(++sequence),
        newInvocationId: () => uuid7(++sequence),
        newEventId: () => uuid7(++sequence),
      },
    );

    await expect(
      dispatcher.dispatch(dispatchInput({ value: "durable" })),
    ).resolves.toMatchObject({
      ok: true,
      state: "completed",
      auditDelivery: "unavailable",
      auditError: { detailCode: "event_sink:not_implemented" },
    });
    expect(executor.sentDispatches()).toHaveLength(1);
  });

  it("mints UUIDv7 invocation and event identities by default", async () => {
    const eventSink = createCapturingEventSink();
    const dispatcher = new GatewayDispatcher(
      new GatewayToolRegistry([autoRecord]),
      [
        {
          binding: "bridge",
          async execute(): Promise<GatewayExecutorOutcome> {
            return { state: "completed", result: { ok: true } };
          },
        },
      ],
      {
        eventSink,
        eventSource: {
          component: "gateway-test",
          version: "0.0.0-test",
          instance: "uuid-v7-test",
        },
        clock: () => 1_750_000_000_000,
        recoveryAuthority: createReadOnlyRecoveryAuthorityFixture(),
      },
    );

    const outcome = await dispatcher.dispatch(
      dispatchInput({ value: "ready" }),
    );
    expect(outcome.requestId).toMatch(UUID_V7_PATTERN);
    expect(eventSink.captured()[0]?.event_id).toMatch(UUID_V7_PATTERN);
  });

  it("keeps route, executor, and audit identity on one pre-await snapshot", async () => {
    const routeStarted = deferred<void>();
    const releaseRoute = deferred<void>();
    const mutableActor = {
      type: "user" as const,
      tenantId: "tenant-a",
      userId: "user-a",
      role: "user" as const,
      oidcIssuer: "https://issuer.invalid/test",
      oidcSubject: "subject-a",
    };
    const mutableSession = {
      sessionId: "gateway-session-a",
      clientType: "mcp" as const,
      mcpSessionId: "mcp-session-test",
      oauthClientId: "codex-desktop-test",
    };
    const mutableAuth = {
      ...auth,
      actor: mutableActor,
      session: mutableSession,
      principalKey: "tenant-a:user-a",
    };
    const harness = createDispatcher({
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    const dispatchPromise = harness.dispatcher.dispatch(
      dispatchInput(
        { value: "ready" },
        {
          auth: mutableAuth,
          resolveRoute: async (resolvedAuth) => {
            expect(Object.isFrozen(resolvedAuth)).toBe(true);
            expect(Object.isFrozen(resolvedAuth.actor)).toBe(true);
            expect(Object.isFrozen(resolvedAuth.session)).toBe(true);
            routeStarted.resolve();
            await releaseRoute.promise;
            return { ...route, tenantId: resolvedAuth.actor.tenantId };
          },
        },
      ),
    );
    await routeStarted.promise;
    mutableActor.tenantId = "tenant-mutated";
    mutableActor.userId = "user-mutated";
    mutableSession.sessionId = "gateway-session-mutated";
    mutableAuth.principalKey = "tenant-mutated:user-mutated";
    releaseRoute.resolve();

    await expect(dispatchPromise).resolves.toMatchObject({ ok: true });
    expect(harness.executorRequests()[0]?.context).toMatchObject({
      actor: { tenantId: "tenant-a", userId: "user-a" },
      gatewaySessionId: "gateway-session-a",
      principalKey: "tenant-a:user-a",
    });
    expect(harness.eventSink.captured()[0]).toMatchObject({
      actor: { type: "user", user_id: "user-a" },
      session_id: "gateway-session-a",
      tenant_id: "tenant-a",
      payload: {
        gateway_session_id: "gateway-session-a",
        principal_key: "tenant-a:user-a",
      },
    });
  });
});
