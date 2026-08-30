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
  type InvocationPolicy,
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
  retryMutationProbeOriginReconcile,
  type GatewayDispatcherOptions,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayExecutorRequest,
} from "./dispatch.js";
import { GatewayRbpFault, type GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import {
  GATEWAY_CONFIRMATION_AUDIT_NAMESPACE,
  GatewayConfirmationAuthority,
} from "./confirmationAuthority.js";
import {
  canonicalParamsDigest,
  createEffectiveMcpRequestScopeV1,
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
  bindMutationProbeVerificationWorkflow,
  createMutationProbeVerificationWorkflow,
} from "./productionConformanceVerification.js";
import {
  MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS,
  PRODUCTION_CONFORMANCE_TOOL_RECORDS,
} from "./productionConformanceTools.js";
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

const confirmRecord: GatewayToolRecord = {
  name: "core.test.confirm",
  summary: "Preview and confirm one test write.",
  namespace: "core",
  version: "1.0.0",
  policyClass: "confirm",
  mutationScopePolicy: "session",
  executor: "bridge",
  executorMethod: "set_element_parameter",
  inputSchema: {
    value: z.string().min(1),
    mode: z.enum(["dryRun", "commit"]).optional(),
  },
  inputJsonSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: {
      value: { minLength: 1, type: "string" },
      mode: { enum: ["dryRun", "commit"], type: "string" },
    },
    required: ["value"],
    type: "object",
  },
};

const rawCodeConfirmRecord: GatewayToolRecord = {
  name: "core.test.raw_code_confirm",
  summary: "Preview and confirm one raw-code action.",
  namespace: "core",
  version: "1.0.0",
  policyClass: "confirm",
  mutationScopePolicy: "session",
  executor: "bridge",
  executorMethod: "send_code_to_revit",
  inputSchema: {
    code: z.string().min(1),
  },
  inputJsonSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: {
      code: { minLength: 1, type: "string" },
    },
    required: ["code"],
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
      readonly params: JsonValue;
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
  principalKey: "tenant-a:user-a",
  mcpSessionId: "mcp-session-test",
  effectiveMcpRequestScope: createEffectiveMcpRequestScopeV1({
    principalKey: "tenant-a:user-a",
    transportMcpSessionId: "mcp-session-test",
    identityMcpSessionId: null,
    nowMs: 1_775_000_000_000,
  }),
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
  const correlationId = pending.envelope.type === "invoke"
    ? pending.envelope.payload.invocation_id
    : pending.envelope.payload.batch_id;
  return {
    source: "durable_rbp_sequence",
    receiptVersion: 1,
    tenantId: "tenant-a",
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
  const policy: InvocationPolicy = (() => {
    if (
      request.context.policyClass === "auto" &&
      request.context.policyDecision === "auto" &&
      request.context.confirmationId === null
    ) {
      return { class: "auto", decision: "auto", confirmation_id: null };
    }
    if (
      request.context.policyClass === "confirm" &&
      request.context.policyDecision === "confirmed" &&
      request.context.confirmationId !== null
    ) {
      return {
        class: "confirm",
        decision: "confirmed",
        confirmation_id: request.context.confirmationId,
      };
    }
    if (
      request.context.policyClass === "gated" &&
      request.context.policyDecision === "gated_approved" &&
      request.context.confirmationId !== null
    ) {
      return {
        class: "gated",
        decision: "gated_approved",
        confirmation_id: request.context.confirmationId,
      };
    }
    throw new Error("mutation test executor received a non-dispatch policy");
  })();
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
      policy,
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
  readonly preview?: (
    request: GatewayExecutorRequest,
  ) => Promise<GatewayExecutorOutcome & { readonly previewRef?: string }>;
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
    ...(input.preview === undefined
      ? {}
      : {
          previewConfirmation: input.preview,
        }),
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
  readonly confirmationAuthority?: GatewayDispatcherOptions["confirmationAuthority"];
  readonly eventSink?: CapturingEventSink;
}): {
  readonly dispatcher: GatewayDispatcher;
  readonly eventSink: CapturingEventSink;
  readonly mintedInvocationIds: () => readonly string[];
} {
  const eventSink = input.eventSink ?? createCapturingEventSink();
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
        ...(input.confirmationAuthority === undefined
          ? {}
          : { confirmationAuthority: input.confirmationAuthority }),
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

function createApprovalFailingEventSink(): CapturingEventSink {
  const capture = createCapturingEventSink();
  return {
    kind: "capture" as const,
    async emit(event) {
      const recorded = await capture.emit(event);
      if (
        event.event_type === "tool.confirmation" &&
        event.payload.state === "approved"
      ) {
        return Object.freeze({
          ok: false as const,
          port: "event_sink" as const,
          code: "unavailable" as const,
          message: "approval audit sink unavailable",
        });
      }
      return recorded;
    },
    async emitBatch(events) {
      return capture.emitBatch(events);
    },
    async flush() {
      return capture.flush();
    },
    captured() {
      return capture.captured();
    },
    clear() {
      capture.clear();
    },
  };
}

async function createRecoveryAuthority(
  input: {
    readonly openStore?: boolean;
    readonly durable?: RestartableTestStore;
    readonly bridgeEvidence?: DispatchBridgeEvidence;
    readonly confirmationAuthority?: GatewayConfirmationAuthority;
    readonly clock?: () => number;
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
      ...(input.confirmationAuthority === undefined
        ? {}
        : { confirmationAuthority: input.confirmationAuthority }),
      clock: input.clock ?? (() => 1_775_000_000_000),
      newId: (timestampMs) => uuid7(timestampMs % 1_000_000),
    }),
  };
}

interface ConfirmationDispatchHarness {
  readonly bridgeEvidence: DispatchBridgeEvidence;
  readonly confirmationAuthority: GatewayConfirmationAuthority;
  readonly dispatcher: GatewayDispatcher;
  readonly durable: RestartableTestStore;
  readonly eventSink: CapturingEventSink;
  readonly executor: RecoveryExecutorHarness;
  readonly recoveryAuthority: GatewayRecoveryAuthority;
  readonly mintedInvocationIds: () => readonly string[];
  readonly previewRequests: () => readonly GatewayExecutorRequest[];
  setNow(value: number): void;
}

async function createConfirmationDispatchHarness(
  input: {
    readonly durable?: RestartableTestStore;
    readonly eventSink?: CapturingEventSink;
    readonly idBase?: number;
    readonly openStore?: boolean;
    readonly record?: GatewayToolRecord;
  } = {},
): Promise<ConfirmationDispatchHarness> {
  const durable = input.durable ?? createRestartableTestStore();
  let now = 1_775_000_000_000;
  let confirmationSequence = 900_000;
  const previewRequests: GatewayExecutorRequest[] = [];
  const confirmationAuthority = new GatewayConfirmationAuthority(
    durable.store,
    {
      clock: () => now,
      newConfirmationId: () => uuid7(++confirmationSequence),
      newTokenSecret: () => "S".repeat(43),
    },
  );
  const recovery = await createRecoveryAuthority({
    durable,
    confirmationAuthority,
    clock: () => now,
    openStore: input.openStore,
  });
  const executor = createRecoveryExecutor({
    bridgeEvidence: recovery.bridgeEvidence,
    async preview(request) {
      previewRequests.push(request);
      return {
        state: "completed",
        result: { preview: "bounded", writes: 0 },
        previewRef: "inline:confirmation-preview",
      };
    },
  });
  const dispatch = createMutationDispatcher({
    recoveryAuthority: recovery.authority,
    confirmationAuthority,
    executor: executor.executor,
    record: input.record ?? confirmRecord,
    idBase: input.idBase,
    ...(input.eventSink === undefined ? {} : { eventSink: input.eventSink }),
  });
  return {
    bridgeEvidence: recovery.bridgeEvidence,
    confirmationAuthority,
    dispatcher: dispatch.dispatcher,
    durable,
    eventSink: dispatch.eventSink,
    executor,
    recoveryAuthority: recovery.authority,
    mintedInvocationIds: dispatch.mintedInvocationIds,
    previewRequests: () => [...previewRequests],
    setNow(value) {
      now = value;
    },
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
    readonly toolName?: string;
    readonly confirmation?: {
      readonly confirmToken: string;
      readonly originatingPreviewInvocationId: string;
    };
    readonly confirmationSessionId?: string;
    readonly mcpSessionId?: string;
    readonly effectiveMcpRequestScope?: ReturnType<
      typeof createEffectiveMcpRequestScopeV1
    >;
    readonly resolveRoute?: (
      auth: AuthContext,
      effectiveMcpRequestScope: ReturnType<
        typeof createEffectiveMcpRequestScopeV1
      >,
    ) => GatewayInvocationRoute | Promise<GatewayInvocationRoute>;
    readonly route?: GatewayInvocationRoute;
  } = {},
) {
  const selectedAuth = overrides.auth ?? auth;
  const selectedRoute = overrides.route ?? route;
  return {
    toolName: overrides.toolName ?? autoRecord.name,
    args,
    auth: selectedAuth,
    mcpSessionId:
      overrides.mcpSessionId ??
      selectedAuth.session.mcpSessionId ??
      selectedRoute.mcpSessionId,
    effectiveMcpRequestScope: overrides.effectiveMcpRequestScope ?? createEffectiveMcpRequestScopeV1({
      principalKey: selectedAuth.principalKey,
      transportMcpSessionId:
        overrides.mcpSessionId ??
        selectedAuth.session.mcpSessionId ??
        selectedRoute.mcpSessionId,
      identityMcpSessionId: null,
      nowMs: 1_775_000_000_000,
    }),
    resolveRoute: overrides.resolveRoute ?? ((
      _auth: AuthContext,
      scope: ReturnType<typeof createEffectiveMcpRequestScopeV1>,
    ) =>
      Object.freeze({ ...selectedRoute, effectiveMcpRequestScope: scope })),
    ...(overrides.confirmationSessionId === undefined
      ? {}
      : { confirmationSessionId: overrides.confirmationSessionId }),
    ...(overrides.confirmation === undefined
      ? {}
      : { confirmation: overrides.confirmation }),
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
  it("retries only the exact origin journal-before-ACK race without another send and times out closed", async () => {
    const mismatch = { kind: "protocol_fault" as const,
      reason: "bridge_evidence_dispatch_evidence_mismatch" };
    let sends = 1;
    let reads = 0;
    let validations = 0;
    let clock = 0;
    const recovered = await retryMutationProbeOriginReconcile({
      initial: mismatch,
      now: () => clock,
      delay: async (milliseconds) => { clock += milliseconds; },
      revalidateCurrentOwner: async () => { validations += 1; return true; },
      reconcile: async () => {
        reads += 1;
        return reads === 1 ? mismatch : {
          kind: "indeterminate_recorded" as const,
          installedHoldIds: ["vh:test"],
          clearedHoldIds: [],
        };
      },
    });
    expect(recovered).toMatchObject({ kind: "indeterminate_recorded" });
    expect({ sends, reads, validations }).toEqual({ sends: 1, reads: 2, validations: 2 });

    reads = 0;
    validations = 0;
    clock = 0;
    const timedOut = await retryMutationProbeOriginReconcile({
      initial: mismatch,
      now: () => clock,
      delay: async () => { clock = 5_001; },
      revalidateCurrentOwner: async () => { validations += 1; return true; },
      reconcile: async () => { reads += 1; return mismatch; },
    });
    expect(timedOut).toEqual(mismatch);
    expect({ sends, reads, validations }).toEqual({ sends: 1, reads: 0, validations: 0 });

    const foreignFault = { kind: "protocol_fault" as const, reason: "journal_binding_mismatch" };
    expect(await retryMutationProbeOriginReconcile({
      initial: foreignFault,
      reconcile: async () => { reads += 1; return mismatch; },
      revalidateCurrentOwner: async () => true,
    })).toEqual(foreignFault);
    expect(reads).toBe(0);
  });

  it("rejects a branded verification workflow bound to a different recovery authority", () => {
    const durable = createRestartableTestStore();
    const evidence = new DispatchBridgeEvidence();
    const bridge = Object.assign(evidence, { store: durable.store }) as unknown as GatewayBridgeSessionAuthority;
    const workflow = createMutationProbeVerificationWorkflow({
      protocolStore: durable.store,
      bridgeAuthority: bridge,
      runId: "dispatch-graph",
    });
    const ownerRecovery = new GatewayRecoveryAuthority(durable.store, {
      bridgeEvidence: evidence,
      evidenceDecision: workflow.evidenceDecision,
    });
    bindMutationProbeVerificationWorkflow({ workflow, protocolStore: durable.store,
      bridgeAuthority: bridge, recoveryAuthority: ownerRecovery });
    const substitutedRecovery = new GatewayRecoveryAuthority(durable.store, {
      bridgeEvidence: evidence,
      evidenceDecision: workflow.evidenceDecision,
    });
    expect(() => new GatewayDispatcher(
      new GatewayToolRegistry([autoRecord]),
      [{ binding: "bridge", async execute() { return { state: "completed", result: {} }; } }],
      {
        eventSink: createCapturingEventSink(),
        eventSource: { component: "gateway-test", version: "1", instance: "dispatch" },
        recoveryAuthority: substitutedRecovery,
        mutationProbeVerification: workflow,
      },
    )).toThrow(/factory branded/u);
  });

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

  it.each([
    ["confirm", "confirmation_unavailable"],
    ["gated", "policy_enforcement_unavailable"],
  ] as const)(
    "fails closed for an unconfigured %s policy",
    async (policyClass, code) => {
      const harness = createDispatcher({
        record:
          policyClass === "confirm"
            ? confirmRecord
            : { ...autoRecord, policyClass },
        execute: async () => ({ state: "completed", result: { ok: true } }),
      });

      await expect(
        harness.dispatcher.dispatch(
          dispatchInput(
            { value: "ready" },
            policyClass === "confirm"
              ? { toolName: confirmRecord.name }
              : undefined,
          ),
        ),
      ).resolves.toMatchObject({
        ok: false,
        state: "failed",
        error: { code },
      });
      expect(harness.executionCount()).toBe(0);
    },
  );

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

  it.each([
    ["Error", () => new Error("read-executor-secret"), "error"],
    ["cancellation", () => new DOMException("cancelled", "AbortError"), "abort"],
    ["unknown", () => Object.freeze({ private: "read-executor-secret" }), "unknown"],
  ] as const)(
    "normalizes a read executor %s without leaking it",
    async (_kind, createThrown, errorClass) => {
      const harness = createDispatcher({
        execute: async () => {
          throw createThrown();
        },
      });

      const outcome = await harness.dispatcher.dispatch(
        dispatchInput({ value: "ready" }),
      );
      expect(outcome).toEqual({
        ok: false,
        state: "failed",
        toolName: autoRecord.name,
        requestId: "invocation-1",
        executorReached: true,
        error: { code: "dispatch_unavailable", phase: "executor", class: errorClass },
      });
      expect(JSON.stringify(outcome)).not.toContain("read-executor-secret");
      expect(harness.executionCount()).toBe(1);
    },
  );

  it("normalizes a read execution failure before Bridge contact", async () => {
    const base = createReadOnlyRecoveryAuthorityFixture();
    const harness = createDispatcher({
      recoveryAuthority: {
        ...base,
        async acquireInvocationWindow() {
          throw new Error("read-window-secret");
        },
      },
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    const outcome = await harness.dispatcher.dispatch(
      dispatchInput({ value: "ready" }),
    );
    expect(outcome).toEqual({
      ok: false,
      state: "failed",
      toolName: autoRecord.name,
      requestId: "invocation-1",
      executorReached: false,
      error: { code: "dispatch_unavailable", phase: "window_acquire", class: "error" },
    });
    expect(JSON.stringify(outcome)).not.toContain("read-window-secret");
    expect(harness.executionCount()).toBe(0);
  });

  it.each(["auth", "protocol", "unsupported", "unavailable"] as const)(
    "retains only an allowlisted Gateway RBP fault code for a read executor",
    async (upstreamCode) => {
      const harness = createDispatcher({
        execute: async () => {
          throw new GatewayRbpFault(upstreamCode, "must-not-leak", 503, 1011);
        },
      });
      const outcome = await harness.dispatcher.dispatch(
        dispatchInput({ value: "ready" }),
      );
      expect(outcome).toEqual({
        ok: false,
        state: "failed",
        toolName: autoRecord.name,
        requestId: "invocation-1",
        executorReached: true,
        error: {
          code: "dispatch_unavailable",
          phase: "executor",
          class: "gateway_rbp_fault",
          upstreamCode,
        },
      });
      expect(JSON.stringify(outcome)).not.toContain("must-not-leak");
    },
  );

  it("does not classify an arbitrary Error name or code as an RBP fault", async () => {
    const thrown = Object.assign(new Error("must-not-leak"), {
      name: "GatewayRbpFault",
      code: "protocol",
    });
    const harness = createDispatcher({
      execute: async () => { throw thrown; },
    });
    await expect(harness.dispatcher.dispatch(dispatchInput({ value: "ready" })))
      .resolves.toMatchObject({
        error: {
          code: "dispatch_unavailable",
          phase: "executor",
          class: "error",
        },
      });
  });

  it("normalizes a read failure after Bridge contact without treating contact as terminal", async () => {
    const base = createReadOnlyRecoveryAuthorityFixture();
    const harness = createDispatcher({
      recoveryAuthority: {
        ...base,
        async releaseInvocationWindow() {
          throw new Error("read-release-secret");
        },
      },
      execute: async () => ({ state: "completed", result: { ok: true } }),
    });

    const outcome = await harness.dispatcher.dispatch(
      dispatchInput({ value: "ready" }),
    );
    expect(outcome).toEqual({
      ok: false,
      state: "failed",
      toolName: autoRecord.name,
      requestId: "invocation-1",
      executorReached: true,
      error: { code: "dispatch_unavailable", phase: "window_release", class: "error" },
    });
    expect(JSON.stringify(outcome)).not.toContain("read-release-secret");
    expect(harness.executionCount()).toBe(1);
  });

  it("returns structured executor_unavailable for an APS-bound invocation", async () => {
    const apsRecord: GatewayToolRecord = {
      ...autoRecord,
      name: "core.published.read",
      executor: "aps",
      executorMethod: "published_read",
    };
    const dispatcher = new GatewayDispatcher(
      new GatewayToolRegistry([apsRecord]),
      [],
      {
        eventSink: createCapturingEventSink(),
        eventSource: {
          component: "gateway-aps-seam-test",
          version: "0.0.0-test",
          instance: "aps-seam-test",
        },
        newInvocationId: () => "aps-invocation",
        newEventId: () => "aps-event",
        recoveryAuthority: createReadOnlyRecoveryAuthorityFixture(),
      },
    );

    await expect(
      dispatcher.dispatch(
        dispatchInput(
          { value: "ready" },
          { toolName: apsRecord.name },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      state: "failed",
      error: {
        code: "executor_unavailable",
        message: "executor binding is unavailable: aps",
      },
    });
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
    let routeScope: ReturnType<typeof createEffectiveMcpRequestScopeV1> | undefined;
    const harness = createDispatcher({
      execute: async (request) => {
        expect(currentGatewayInvocationContext()).toBe(request.context);
        return { state: "completed", result: { ok: true } };
      },
    });

    const input = dispatchInput(
      { value: "ready" },
      {
        resolveRoute: (_auth, effectiveMcpRequestScope) => {
          routeScope = effectiveMcpRequestScope;
          return Object.freeze({
            ...route,
            effectiveMcpRequestScope,
          });
        },
      },
    );
    await expect(harness.dispatcher.dispatch(input)).resolves.toMatchObject({
      ok: true,
      requestId: "invocation-1",
      state: "completed",
    });
    expect(currentGatewayInvocationContext()).toBeUndefined();

    const request = harness.executorRequests()[0];
    expect(request?.context.effectiveMcpRequestScope).toBe(
      input.effectiveMcpRequestScope,
    );
    expect(routeScope).toBe(input.effectiveMcpRequestScope);
    expect(
      (harness.eventSink.captured()[0] as unknown as {
        effectiveMcpRequestScope?: unknown;
      }).effectiveMcpRequestScope,
    ).toBe(input.effectiveMcpRequestScope);
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
    "matches the protocol-owned frozen O1 $name parameter digest vector",
    ({ params, digest }) => {
      const gatewayDigest = canonicalParamsDigest(params);
      expect(gatewayDigest).toBe(makeParamsDigest(params));
      expect(gatewayDigest).toBe(digest);
    },
  );

  it("preserves the protocol-owned malformed-input guards", () => {
    const sparse: unknown[] = new Array(1);
    const symbolMember: Record<PropertyKey, unknown> = { value: 1 };
    symbolMember[Symbol("hidden")] = true;
    const nonEnumerable = { visible: true };
    Object.defineProperty(nonEnumerable, "hidden", {
      enumerable: false,
      value: true,
    });

    expect(() => canonicalParamsDigest(Number.NaN)).toThrow(/finite/);
    expect(() => canonicalParamsDigest("\ud800")).toThrow(/surrogate/);
    expect(() => canonicalParamsDigest(sparse)).toThrow(/undefined array item/);
    expect(() => canonicalParamsDigest(symbolMember)).toThrow(/symbol-keyed/);
    expect(() => canonicalParamsDigest(nonEnumerable)).toThrow(/non-enumerable/);
  });

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
          resolveRoute: async (resolvedAuth, effectiveMcpRequestScope) => {
            expect(Object.isFrozen(resolvedAuth)).toBe(true);
            expect(Object.isFrozen(resolvedAuth.actor)).toBe(true);
            expect(Object.isFrozen(resolvedAuth.session)).toBe(true);
            routeStarted.resolve();
            await releaseRoute.promise;
            return {
              ...route,
              tenantId: resolvedAuth.actor.tenantId,
              effectiveMcpRequestScope,
            };
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

describe("GW-8 durable confirmation round trip", () => {
  it("routes mutation-probe preview as an auto read while retaining confirm audit authority", async () => {
    const record = MUTATION_PROBE_CONFORMANCE_TOOL_RECORDS[0]!;
    const harness = await createConfirmationDispatchHarness({ record });
    const outcome = await harness.dispatcher.dispatch(
      dispatchInput({}, { toolName: record.name }),
    );
    expect(outcome).toMatchObject({ ok: true, state: "confirmation_required" });
    expect(harness.previewRequests()).toHaveLength(1);
    expect(harness.previewRequests()[0]).toMatchObject({
      executorMethod: "get_ui_state",
      policyClass: "auto",
      mutationScopePolicy: "none",
      args: {},
      context: {
        toolName: record.name,
        policyClass: "auto",
        policyDecision: "auto",
        mutating: false,
        mutationScope: null,
        confirmationId: null,
      },
    });
  });

  it("runs closed C28/C29 previews as auto reads and denies commits at an active hold with zero mutation calls", async () => {
    const c28 = PRODUCTION_CONFORMANCE_TOOL_RECORDS.find((record) =>
      record.name === "conformance.fixture.c28_mutation")!;
    const c29 = PRODUCTION_CONFORMANCE_TOOL_RECORDS.find((record) =>
      record.name === "conformance.fixture.c29_atomic_batch")!;
    const c29Params = {
      viewName: "revAgent_QA_WP12_fixture",
      exactName: true,
      mode: "commit",
      confirmDelete: true,
    } as const;
    const cases = [
      { record: c28, args: { vector: "O1-C28", fixtureOnly: true } },
      { record: c29, args: {
        batchContractVersion: 1,
        batchId: uuid7(810_000),
        batchDigest: `sha256:${"a".repeat(64)}`,
        atomic: true,
        rollbackPolicy: "rollback_on_non_success",
        maxAggregateResultBytes: 1_024,
        steps: [{ index: 0, invocationId: uuid7(810_001), method: "delete_review_view",
          params: c29Params, paramsDigest: makeParamsDigest(c29Params), effect: "model_transaction" }],
      } },
    ] as const;
    for (const candidate of cases) {
      const harness = await createConfirmationDispatchHarness({ record: candidate.record });
      const holdId = await installSessionHold({
        authority: harness.recoveryAuthority,
        bridgeEvidence: harness.bridgeEvidence,
      });
      const preview = await harness.dispatcher.dispatch(
        dispatchInput(candidate.args, { toolName: candidate.record.name }),
      );
      expect(preview).toMatchObject({ ok: true, state: "confirmation_required" });
      if (!preview.ok || preview.state !== "confirmation_required") {
        throw new Error("expected conformance confirmation preview");
      }
      expect(harness.previewRequests()).toHaveLength(1);
      expect(harness.previewRequests()[0]).toMatchObject({
        executorMethod: "get_ui_state",
        policyClass: "auto",
        mutationScopePolicy: "none",
        args: {},
        context: { policyClass: "auto", policyDecision: "auto", mutating: false, mutationScope: null },
      });
      const commit = await harness.dispatcher.dispatch(dispatchInput(candidate.args, {
        toolName: candidate.record.name,
        confirmation: {
          confirmToken: preview.confirmation.confirmToken,
          originatingPreviewInvocationId: preview.confirmation.originatingPreviewInvocationId,
        },
      }));
      expect(commit).toMatchObject({ ok: false, executorReached: false,
        error: { code: "recovery_blocked", detailCode: "mutation_hold" } });
      expect(harness.executor.prepareCount()).toBe(0);
      expect(harness.executor.sentDispatches()).toEqual([]);
      expect(harness.executor.plainExecutionCount()).toBe(0);
      expect(harness.eventSink.captured().at(-1)?.payload).toMatchObject({
        recovery_hold_ids: [holdId],
        executor_reached: false,
      });
    }
  });

  async function preview(
    harness: ConfirmationDispatchHarness,
    args: Readonly<Record<string, unknown>> = { value: "ready" },
  ) {
    const outcome = await harness.dispatcher.dispatch(
      dispatchInput(args, { toolName: confirmRecord.name }),
    );
    if (!outcome.ok || outcome.state !== "confirmation_required") {
      throw new Error(`expected confirmation preview: ${JSON.stringify(outcome)}`);
    }
    return outcome;
  }

  function confirmationFor(
    outcome: Awaited<ReturnType<typeof preview>>,
  ) {
    return {
      confirmToken: outcome.confirmation.confirmToken,
      originatingPreviewInvocationId:
        outcome.confirmation.originatingPreviewInvocationId,
    } as const;
  }

  async function createRawCodePreviewHarness(
    previewOutcome: GatewayExecutorOutcome,
  ) {
    const durable = createRestartableTestStore();
    const confirmationAuthority = new GatewayConfirmationAuthority(
      durable.store,
      {
        clock: () => 1_775_000_000_000,
        newConfirmationId: () => uuid7(910_000),
        newTokenSecret: () => "R".repeat(43),
      },
    );
    const recovery = await createRecoveryAuthority({
      durable,
      confirmationAuthority,
    });
    const executor = createRecoveryExecutor({
      bridgeEvidence: recovery.bridgeEvidence,
      async preview() {
        return previewOutcome;
      },
    });
    const dispatch = createMutationDispatcher({
      recoveryAuthority: recovery.authority,
      confirmationAuthority,
      executor: executor.executor,
      record: rawCodeConfirmRecord,
      idBase: 95_000,
    });
    return { ...dispatch, durable, executor };
  }

  it("mints a raw-code token only for the exact safe-wrapper static preview contract", async () => {
    const reason = "safe_wrapper_rejected_write_looking_code";
    const completed = await createRawCodePreviewHarness({
      state: "completed",
      result: {
        success: true,
        guarded: false,
        state: "completed",
        action: "send_code_to_revit_safe",
        intent: "writePreview",
        response: { result: "read-only preview" },
      },
    });
    await expect(
      completed.dispatcher.dispatch(
        dispatchInput(
          { code: "return document.Title;" },
          { toolName: rawCodeConfirmRecord.name },
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      state: "confirmation_required",
    });

    const accepted = await createRawCodePreviewHarness({
      state: "guarded",
      reason,
      result: {
        success: false,
        guarded: true,
        state: "guarded",
        action: "send_code_to_revit_safe_preflight",
        error: "Rejected write-looking code for intent 'writePreview'.",
        reason,
        safetyReason: reason,
        writePatterns: ["Parameter.Set"],
      },
    });

    await expect(
      accepted.dispatcher.dispatch(
        dispatchInput(
          { code: "parameter.Set(1);" },
          { toolName: rawCodeConfirmRecord.name },
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      state: "confirmation_required",
    });
    expect(accepted.executor.prepareCount()).toBe(0);
    expect(accepted.executor.sentDispatches()).toHaveLength(0);

    const rejectedCases: readonly GatewayExecutorOutcome[] = [
      {
        state: "completed",
        result: { preview: "not the safe-wrapper result contract" },
      },
      {
        state: "guarded",
        reason: "safe_wrapper_requires_transactionMode_none",
        result: {
          success: false,
          guarded: true,
          state: "guarded",
          action: "send_code_to_revit_safe_preflight",
          reason: "safe_wrapper_requires_transactionMode_none",
          safetyReason: "safe_wrapper_requires_transactionMode_none",
          writePatterns: ["Parameter.Set"],
        },
      },
      {
        state: "guarded",
        reason,
        result: {
          success: false,
          guarded: true,
          state: "guarded",
          action: "send_code_to_revit_safe",
          reason,
          safetyReason: reason,
          writePatterns: [],
        },
      },
    ];

    for (const previewOutcome of rejectedCases) {
      const rejected = await createRawCodePreviewHarness(previewOutcome);
      const outcome = await rejected.dispatcher.dispatch(
        dispatchInput(
          { code: "parameter.Set(1);" },
          { toolName: rawCodeConfirmRecord.name },
        ),
      );
      expect(outcome).toMatchObject({
        ok: true,
        state: previewOutcome.state,
      });
      expect(outcome.state).not.toBe("confirmation_required");
      expect(rejected.executor.prepareCount()).toBe(0);
      expect(rejected.executor.sentDispatches()).toHaveLength(0);
      expect(
        rejected.eventSink
          .captured()
          .filter((event) => event.event_type === "tool.confirmation"),
      ).toHaveLength(0);
      expect(JSON.stringify(rejected.durable.snapshot())).not.toContain(
        "gateway.confirmation-authority/v1",
      );
      expect(rejected.eventSink.captured().at(-1)).toMatchObject({
        event_type: "tool.invocation",
        payload: { confirmation_reason: "preview_not_authorizable" },
      });
    }
  });

  it("previews without a write and commits exactly once under a new invocation with linked audits", async () => {
    const harness = await createConfirmationDispatchHarness();
    const previewed = await preview(harness);

    expect(harness.previewRequests()).toHaveLength(1);
    expect(harness.previewRequests()[0]).toMatchObject({
      executorMethod: "set_element_parameter",
      args: { value: "ready", mode: "dryRun" },
      context: {
        mutating: false,
        mutationScope: null,
        policyClass: "confirm",
        policyDecision: "preview",
      },
    });
    expect(harness.executor.prepareCount()).toBe(0);
    expect(harness.executor.sentDispatches()).toHaveLength(0);

    const committed = await harness.dispatcher.dispatch(
      dispatchInput(
        { value: "ready", mode: "commit" },
        {
          toolName: confirmRecord.name,
          confirmation: confirmationFor(previewed),
        },
      ),
    );

    expect(committed).toMatchObject({ ok: true, state: "completed" });
    expect(committed.requestId).not.toBe(previewed.requestId);
    expect(harness.executor.prepareCount()).toBe(1);
    expect(harness.executor.sentDispatches()).toHaveLength(1);
    expect(harness.executor.preparedRequests()[0]).toMatchObject({
      args: { value: "ready", mode: "commit" },
      context: {
        invocationId: committed.requestId,
        policyClass: "confirm",
        policyDecision: "confirmed",
        confirmationId: previewed.confirmation.confirmationId,
        originatingPreviewInvocationId: previewed.requestId,
      },
    });
    expect(harness.executor.sentDispatches()[0]?.envelope).toMatchObject({
      payload: {
        invocation_id: committed.requestId,
        params: { value: "ready", mode: "commit" },
        policy: {
          class: "confirm",
          decision: "confirmed",
          confirmation_id: previewed.confirmation.confirmationId,
        },
      },
    });

    const confirmationEvents = harness.eventSink
      .captured()
      .filter((event) => event.event_type === "tool.confirmation");
    expect(confirmationEvents).toMatchObject([
      {
        payload: {
          state: "requested",
          confirmation_id: previewed.confirmation.confirmationId,
          originating_preview_invocation_id: previewed.requestId,
          commit_invocation_id: null,
          mcp_session_id: "mcp-session-test",
        },
      },
      {
        payload: {
          state: "approved",
          confirmation_id: previewed.confirmation.confirmationId,
          originating_preview_invocation_id: previewed.requestId,
          commit_invocation_id: committed.requestId,
          mcp_session_id: "mcp-session-test",
        },
      },
    ]);
    const invocationEvents = harness.eventSink
      .captured()
      .filter((event) => event.event_type === "tool.invocation");
    expect(invocationEvents).toMatchObject([
      {
        payload: {
          invocation_id: previewed.requestId,
          policy_decision: "preview",
          confirmation_id: previewed.confirmation.confirmationId,
          originating_preview_invocation_id: previewed.requestId,
        },
      },
      {
        payload: {
          invocation_id: committed.requestId,
          policy_decision: "confirmed",
          confirmation_id: previewed.confirmation.confirmationId,
          originating_preview_invocation_id: previewed.requestId,
        },
      },
    ]);
    const durableAndAuditText = JSON.stringify({
      durable: harness.durable.snapshot(),
      events: harness.eventSink.captured(),
    });
    expect(durableAndAuditText).not.toContain(
      previewed.confirmation.confirmToken,
    );
    expect(durableAndAuditText).not.toContain("S".repeat(43));

    const replay = await harness.dispatcher.dispatch(
      dispatchInput(
        { value: "ready", mode: "commit" },
        {
          toolName: confirmRecord.name,
          confirmation: confirmationFor(previewed),
        },
      ),
    );
    expect(replay).toMatchObject({
      ok: false,
      error: { code: "confirmation_denied", detailCode: "replayed" },
      executorReached: false,
    });
    expect(harness.executor.sentDispatches()).toHaveLength(1);
    expect(harness.eventSink.captured().at(-2)).toMatchObject({
      event_type: "tool.confirmation",
      payload: {
        state: "denied",
        confirmation_id: previewed.confirmation.confirmationId,
        originating_preview_invocation_id: previewed.requestId,
        reason: "replayed",
      },
    });
  });

  it("persists approval and the pending dispatch atomically before an unavailable external audit sink", async () => {
    const eventSink = createApprovalFailingEventSink();
    const harness = await createConfirmationDispatchHarness({ eventSink });
    const previewed = await preview(harness);

    const outcome = await harness.dispatcher.dispatch(
      dispatchInput(
        { value: "ready", mode: "commit" },
        {
          toolName: confirmRecord.name,
          confirmation: confirmationFor(previewed),
        },
      ),
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "audit_unavailable",
        detailCode: "event_sink:unavailable",
      },
      executorReached: false,
    });
    expect(harness.executor.prepareCount()).toBe(1);
    expect(harness.executor.sentDispatches()).toHaveLength(0);

    const snapshot = harness.durable.snapshot();
    expect(
      snapshot.records.filter(
        (record) =>
          record.namespace === GATEWAY_CONFIRMATION_AUDIT_NAMESPACE,
      ),
    ).toMatchObject([
      {
        value: {
          state: "approved",
          confirmationId: previewed.confirmation.confirmationId,
          originatingPreviewInvocationId: previewed.requestId,
          commitInvocationId: outcome.requestId,
        },
      },
    ]);
    const recoveryRecord = snapshot.records.find(
      (record) => record.namespace === GATEWAY_RECOVERY_NAMESPACE,
    )?.value as GatewayRecoveryRecord | undefined;
    expect(recoveryRecord?.pendingDispatch).toMatchObject({
      envelope: {
        payload: {
          invocation_id: outcome.requestId,
          policy: {
            class: "confirm",
            decision: "confirmed",
            confirmation_id: previewed.confirmation.confirmationId,
          },
        },
      },
    });
    expect(
      eventSink
        .captured()
        .filter(
          (event) =>
            event.event_type === "tool.confirmation" &&
            event.payload.state === "approved",
        ),
    ).toHaveLength(1);
  });

  it("audits binding mismatches separately without consuming the valid token", async () => {
    const harness = await createConfirmationDispatchHarness({ idBase: 20_000 });
    const previewed = await preview(harness);
    const confirmation = confirmationFor(previewed);
    harness.eventSink.clear();

    const foreignActor: AuthContext = Object.freeze({
      ...auth,
      actor: Object.freeze({ ...auth.actor, userId: "user-b" }),
      principalKey: "tenant-a:user-b",
    });
    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          {
            auth: foreignActor,
            toolName: confirmRecord.name,
            route: { ...route, principalKey: foreignActor.principalKey },
            confirmation,
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { detailCode: "foreign_actor" },
      executorReached: false,
    });

    const foreignSession: AuthContext = Object.freeze({
      ...auth,
      session: Object.freeze({
        ...auth.session,
        sessionId: "gateway-session-b",
      }),
    });
    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          { auth: foreignSession, toolName: confirmRecord.name, confirmation },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { detailCode: "foreign_session" },
      executorReached: false,
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "changed", mode: "commit" },
          { toolName: confirmRecord.name, confirmation },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { detailCode: "args_mismatch" },
      executorReached: false,
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          {
            toolName: confirmRecord.name,
            confirmation: {
              ...confirmation,
              originatingPreviewInvocationId: uuid7(990_001),
            },
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { detailCode: "preview_mismatch" },
      executorReached: false,
    });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: 42, mode: "commit" },
          { toolName: confirmRecord.name, confirmation },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
      executorReached: false,
    });

    const changedVersion = createMutationDispatcher({
      recoveryAuthority: (
        await createRecoveryAuthority({
          durable: harness.durable,
          bridgeEvidence: harness.bridgeEvidence,
          confirmationAuthority: harness.confirmationAuthority,
          openStore: false,
        })
      ).authority,
      confirmationAuthority: harness.confirmationAuthority,
      executor: harness.executor.executor,
      record: { ...confirmRecord, version: "1.0.1" },
      idBase: 30_000,
    });
    await expect(
      changedVersion.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          { toolName: confirmRecord.name, confirmation },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { detailCode: "tool_version_mismatch" },
      executorReached: false,
    });

    expect(harness.executor.sentDispatches()).toHaveLength(0);
    const denialReasons = [
      ...harness.eventSink.captured(),
      ...changedVersion.eventSink.captured(),
    ]
      .filter((event) => event.event_type === "tool.confirmation")
      .map((event) => event.payload.reason);
    expect(denialReasons).toEqual([
      "foreign_actor",
      "foreign_session",
      "args_mismatch",
      "preview_mismatch",
      "invalid_arguments",
      "tool_version_mismatch",
    ]);

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          { toolName: confirmRecord.name, confirmation },
        ),
      ),
    ).resolves.toMatchObject({ ok: true, state: "completed" });
    expect(harness.executor.sentDispatches()).toHaveLength(1);
  });

  it("persists expiry and rejects at the exact ten-minute boundary before send", async () => {
    const harness = await createConfirmationDispatchHarness({ idBase: 40_000 });
    const previewed = await preview(harness);
    harness.eventSink.clear();
    harness.setNow(previewed.confirmation.expiresAtMs);

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          {
            toolName: confirmRecord.name,
            confirmation: confirmationFor(previewed),
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "confirmation_denied", detailCode: "expired" },
      executorReached: false,
    });
    expect(harness.executor.sentDispatches()).toHaveLength(0);
    expect(harness.eventSink.captured()[0]).toMatchObject({
      event_type: "tool.confirmation",
      payload: { state: "expired", reason: "expired" },
    });
    expect(JSON.stringify(harness.durable.snapshot())).toContain(
      '"state":"expired"',
    );
  });

  it("binds an unbound AuthContext to the dispatcher-supplied MCP confirmation session", async () => {
    const harness = await createConfirmationDispatchHarness({ idBase: 45_000 });
    const unboundAuth: AuthContext = Object.freeze({
      ...auth,
      session: Object.freeze({ ...auth.session, mcpSessionId: null }),
    });
    const routeFor = (mcpSessionId: string): GatewayInvocationRoute =>
      Object.freeze({ ...route, mcpSessionId });
    const previewedOutcome = await harness.dispatcher.dispatch(
      dispatchInput(
        { value: "ready" },
        {
          auth: unboundAuth,
          toolName: confirmRecord.name,
          mcpSessionId: "transport-session-a",
          confirmationSessionId: "transport-session-a",
          route: routeFor("transport-session-a"),
        },
      ),
    );
    if (
      !previewedOutcome.ok ||
      previewedOutcome.state !== "confirmation_required"
    ) {
      throw new Error(
        `expected confirmation preview: ${JSON.stringify(previewedOutcome)}`,
      );
    }
    const confirmation = confirmationFor(previewedOutcome);

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          {
            auth: unboundAuth,
            toolName: confirmRecord.name,
            mcpSessionId: "transport-session-b",
            confirmationSessionId: "transport-session-b",
            route: routeFor("transport-session-b"),
            confirmation,
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { detailCode: "foreign_session" },
      executorReached: false,
    });
    expect(harness.executor.sentDispatches()).toHaveLength(0);

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          {
            auth: unboundAuth,
            toolName: confirmRecord.name,
            mcpSessionId: "transport-session-a",
            confirmationSessionId: "transport-session-a",
            route: routeFor("transport-session-a"),
            confirmation,
          },
        ),
      ),
    ).resolves.toMatchObject({ ok: true, state: "completed" });
    expect(harness.executor.sentDispatches()).toHaveLength(1);
  });

  it("survives a store restart and preserves single use", async () => {
    const first = await createConfirmationDispatchHarness({ idBase: 50_000 });
    const previewed = await preview(first);
    const restartedStore = first.durable.restart();
    await expect(restartedStore.open()).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    const restartedConfirmation = new GatewayConfirmationAuthority(
      restartedStore,
      { clock: () => 1_775_000_000_000 },
    );
    const restartedRecovery = new GatewayRecoveryAuthority(restartedStore, {
      bridgeEvidence: first.bridgeEvidence,
      confirmationAuthority: restartedConfirmation,
      evidenceDecision: {
        async decideEvidence() {
          return {
            kind: "decided" as const,
            conclusion: "inconclusive" as const,
            authorityReference: "dispatch-restart-decision",
            decisionVersion: 1,
            decidedAtMs: 1_775_000_001_000,
          };
        },
      },
      clock: () => 1_775_000_000_000,
      newId: (timestampMs) => uuid7(timestampMs % 1_000_000),
    });
    const restartedExecutor = createRecoveryExecutor({
      bridgeEvidence: first.bridgeEvidence,
      async preview() {
        throw new Error("restart commit must not preview again");
      },
    });
    const restarted = createMutationDispatcher({
      recoveryAuthority: restartedRecovery,
      confirmationAuthority: restartedConfirmation,
      executor: restartedExecutor.executor,
      record: confirmRecord,
      idBase: 60_000,
    });
    const commitInput = dispatchInput(
      { value: "ready", mode: "commit" },
      {
        toolName: confirmRecord.name,
        confirmation: confirmationFor(previewed),
      },
    );

    await expect(restarted.dispatcher.dispatch(commitInput)).resolves.toMatchObject({
      ok: true,
      state: "completed",
    });
    await expect(restarted.dispatcher.dispatch(commitInput)).resolves.toMatchObject({
      ok: false,
      error: { detailCode: "replayed" },
    });
    expect(restartedExecutor.sentDispatches()).toHaveLength(1);
  });

  it("audits direct commit and client always-allow attempts and keeps gated approval out of band", async () => {
    const harness = await createConfirmationDispatchHarness({ idBase: 70_000 });

    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          { toolName: confirmRecord.name },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { detailCode: "direct_commit_without_confirmation" },
      executorReached: false,
    });
    await expect(
      harness.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", always_allow: true },
          { toolName: confirmRecord.name },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
      executorReached: false,
    });

    const previewed = await preview(harness);
    const gatedRecord: GatewayToolRecord = {
      ...confirmRecord,
      name: "core.test.gated",
      policyClass: "gated",
    };
    const gated = createMutationDispatcher({
      recoveryAuthority: (
        await createRecoveryAuthority({
          durable: harness.durable,
          bridgeEvidence: harness.bridgeEvidence,
          confirmationAuthority: harness.confirmationAuthority,
          openStore: false,
        })
      ).authority,
      confirmationAuthority: harness.confirmationAuthority,
      executor: harness.executor.executor,
      record: gatedRecord,
      idBase: 80_000,
    });
    await expect(
      gated.dispatcher.dispatch(
        dispatchInput(
          { value: "ready", mode: "commit" },
          {
            toolName: gatedRecord.name,
            confirmation: confirmationFor(previewed),
          },
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "policy_enforcement_unavailable",
        detailCode: "gated_in_channel_approval_forbidden",
      },
      executorReached: false,
    });

    expect(harness.executor.sentDispatches()).toHaveLength(0);
    expect(
      [...harness.eventSink.captured(), ...gated.eventSink.captured()]
        .filter((event) => event.event_type === "tool.confirmation")
        .map((event) => event.payload.reason)
        .filter((reason) => reason !== null),
    ).toEqual([
      "direct_commit_without_confirmation",
      "invalid_arguments",
      "gated_in_channel_approval_forbidden",
    ]);
  });
});
