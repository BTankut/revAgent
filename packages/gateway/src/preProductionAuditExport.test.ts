import { describe, expect, it } from "vitest";

import {
  PRE_PRODUCTION_AUDIT_EXPORT_CONTRACT_VERSION,
  PreProductionAuditExportError,
  projectPreProductionAudit,
  type PreProductionAuditExportInput,
} from "./preProductionAuditExport.js";

const STARTED_AT_MS = Date.parse("2026-08-14T09:00:00.000Z");
const COMPLETED_AT_MS = STARTED_AT_MS + 25;
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

const CANARIES = Object.freeze({
  tenantId: "SYNTHETIC-TENANT-PETRUCCI-TAIL",
  userId: "SYNTHETIC-USER-WS2-MIDDLE",
  principalKey: "SYNTHETIC-PRINCIPAL-HEAD-VALUE",
  gatewaySessionId: "SYNTHETIC-GATEWAY-SESSION-TAIL",
  oauthClientId: "SYNTHETIC-OAUTH-CLIENT-MIDDLE",
  mcpSessionId: "SYNTHETIC-MCP-SESSION-HEAD",
  previewRef: "SYNTHETIC-PREVIEW-REFERENCE-TAIL",
  reason: "SYNTHETIC-CONFIRMATION-REASON-MIDDLE",
  documentId: "SYNTHETIC-DOCUMENT-MODEL-HEAD",
  idempotencyKey: "SYNTHETIC-IDEMPOTENCY-TAIL",
  sourceInstance: "SYNTHETIC-HOST-ENDPOINT-PATH-MIDDLE",
});

const IDS = Object.freeze({
  invocationEvent: "018f1f5a-7b00-7000-8000-000000000001",
  confirmationEvent: "018f1f5a-7b00-7000-8000-000000000002",
  attempt: "018f1f5a-7b00-7000-8000-000000000003",
  invocation: "018f1f5a-7b00-7000-8000-000000000004",
  confirmation: "018f1f5a-7b00-7000-8000-000000000005",
  previewInvocation: "018f1f5a-7b00-7000-8000-000000000006",
  commitInvocation: "018f1f5a-7b00-7000-8000-000000000007",
});

const APPROVED_TOOL = Object.freeze({
  name: "revit.inspect_model",
  version: "1.2.3",
  policyClass: "auto" as const,
  mutationScopePolicy: "none" as const,
  executor: "bridge" as const,
});

const CONFIRM_TOOL = Object.freeze({
  name: "revit.confirm_action",
  version: "2.0.0",
  policyClass: "confirm" as const,
  mutationScopePolicy: "document" as const,
  executor: "bridge" as const,
});

const GATED_TOOL = Object.freeze({
  name: "revit.gated_action",
  version: "3.0.0",
  policyClass: "gated" as const,
  mutationScopePolicy: "session" as const,
  executor: "internal_mcp" as const,
});

function eventId(index: number): string {
  return `018f1f5a-7b00-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

function invocationEvent(input: {
  readonly seq?: number;
  readonly id?: string;
  readonly completedAtMs?: number;
  readonly toolName?: string;
} = {}) {
  const completedAtMs = input.completedAtMs ?? COMPLETED_AT_MS;
  const occurredAt = new Date(completedAtMs).toISOString();
  return {
    schema: "revagent.event.v2",
    event_id: input.id ?? IDS.invocationEvent,
    event_type: "tool.invocation",
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    tenant_id: CANARIES.tenantId,
    source: {
      component: "revagent-gateway",
      version: "revagent.m4-preproduction-serving/v1",
      instance: "m4-lan-test",
    },
    actor: { type: "user", user_id: CANARIES.userId },
    session_id: CANARIES.gatewaySessionId,
    seq: input.seq ?? 2,
    payload: {
      dispatch_attempt_id: IDS.attempt,
      invocation_id: IDS.invocation,
      idempotency_key: CANARIES.idempotencyKey,
      principal_key: CANARIES.principalKey,
      actor_role: "user",
      gateway_session_id: CANARIES.gatewaySessionId,
      oauth_client_id: CANARIES.oauthClientId,
      mcp_session_id: CANARIES.mcpSessionId,
      rsid: "SYNTHETIC-RBP-SESSION-TAIL",
      tool_name: input.toolName ?? "revit.inspect_model",
      tool_version: "1.2.3",
      policy_class: "auto",
      policy_decision: "auto",
      confirmation_id: IDS.confirmation,
      originating_preview_invocation_id: IDS.previewInvocation,
      preview_digest: DIGEST_A,
      preview_ref: CANARIES.previewRef,
      commit_args_digest: DIGEST_B,
      confirmation_reason: CANARIES.reason,
      mutation_scope_policy: "none",
      mutating: false,
      executor: "bridge",
      document_identity: {
        kind: "live",
        session_document_id: CANARIES.documentId,
      },
      params_digest: DIGEST_C,
      mutation_scope: null,
      recovery_hold_ids: ["SYNTHETIC-RECOVERY-HOLD-MIDDLE"],
      recovery_resolution_ids: ["SYNTHETIC-RECOVERY-RESOLUTION-TAIL"],
      outcome: "completed",
      outcome_error_code: null,
      executor_reached: true,
      started_at_ms: completedAtMs - 25,
      completed_at_ms: completedAtMs,
      duration_ms: 25,
    },
  };
}

function confirmationEvent(input: {
  readonly seq?: number;
  readonly id?: string;
  readonly recordedAtMs?: number;
  readonly state?: "requested" | "approved" | "denied" | "expired";
  readonly toolName?: string;
  readonly toolVersion?: string;
  readonly nullableCorrelationIds?: boolean;
} = {}) {
  const recordedAtMs = input.recordedAtMs ?? COMPLETED_AT_MS + 25;
  const recordedAt = new Date(recordedAtMs).toISOString();
  return {
    schema: "revagent.event.v2",
    event_id: input.id ?? IDS.confirmationEvent,
    event_type: "tool.confirmation",
    occurred_at: recordedAt,
    recorded_at: recordedAt,
    tenant_id: CANARIES.tenantId,
    source: {
      component: "revagent-gateway",
      version: "revagent.m4-preproduction-serving/v1",
      instance: "m4-lan-test",
    },
    actor: { type: "user", user_id: CANARIES.userId },
    session_id: CANARIES.gatewaySessionId,
    seq: input.seq ?? 3,
    payload: {
      invocation_id: input.nullableCorrelationIds ? null : IDS.commitInvocation,
      state: input.state ?? "approved",
      confirmation_id: input.nullableCorrelationIds ? null : IDS.confirmation,
      originating_preview_invocation_id: input.nullableCorrelationIds
        ? null
        : IDS.previewInvocation,
      commit_invocation_id: input.nullableCorrelationIds
        ? null
        : IDS.commitInvocation,
      principal_key: CANARIES.principalKey,
      actor_role: "user",
      gateway_session_id: CANARIES.gatewaySessionId,
      mcp_session_id: CANARIES.mcpSessionId,
      confirmation_session_id: CANARIES.mcpSessionId,
      oauth_client_id: CANARIES.oauthClientId,
      tool_name: input.toolName ?? CONFIRM_TOOL.name,
      tool_version: input.toolVersion ?? CONFIRM_TOOL.version,
      commit_args_digest: DIGEST_B,
      preview_digest: DIGEST_A,
      preview_ref: CANARIES.previewRef,
      reason: CANARIES.reason,
      recorded_at_ms: recordedAtMs,
    },
  };
}

function validInput(
  events: readonly unknown[],
  approvedTools: PreProductionAuditExportInput["approvedTools"] = [
    APPROVED_TOOL,
    CONFIRM_TOOL,
  ],
): PreProductionAuditExportInput {
  return {
    profile: "lan_test",
    mode: "preproduction",
    selector: {
      tenantId: CANARIES.tenantId,
      userId: CANARIES.userId,
      principalKey: CANARIES.principalKey,
      gatewaySessionId: CANARIES.gatewaySessionId,
    },
    approvedTools,
    events,
  };
}

function expectRefusal(
  execute: () => unknown,
  reason: ConstructorParameters<typeof PreProductionAuditExportError>[0],
): void {
  try {
    execute();
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(PreProductionAuditExportError);
    expect(error).toMatchObject({
      code: "preproduction_audit_export_refused",
      reason,
    });
    const retainedText = JSON.stringify(error) + String(error) + String((error as Error).stack);
    for (const canary of Object.values(CANARIES)) {
      expect(retainedText).not.toContain(canary);
    }
    expect(retainedText).not.toContain("SYNTHETIC-");
  }
}

describe("projectPreProductionAudit", () => {
  it("emits a deterministic closed bundle with boolean-only selector evidence", () => {
    const bundle = projectPreProductionAudit(
      validInput([confirmationEvent({ seq: 3 }), invocationEvent({ seq: 2 })]),
    );

    expect(bundle).toMatchObject({
      contractVersion: PRE_PRODUCTION_AUDIT_EXPORT_CONTRACT_VERSION,
      profile: "lan_test",
      mode: "preproduction",
      approvedLiveSelector: true,
      complete: true,
      selector: {
        tenantBound: true,
        userBound: true,
        principalBound: true,
        gatewaySessionBound: true,
      },
      recordCount: 2,
    });
    expect(bundle.records.map(({ seq }) => seq)).toEqual([2, 3]);
    expect(Object.keys(bundle)).toEqual([
      "contractVersion",
      "profile",
      "mode",
      "approvedLiveSelector",
      "complete",
      "selector",
      "recordCount",
      "records",
    ]);
    expect(Object.keys(bundle.selector)).toEqual([
      "tenantBound",
      "userBound",
      "principalBound",
      "gatewaySessionBound",
    ]);
    expect(bundle.records[0]).toEqual({
      recordType: "invocation",
      schema: "revagent.event.v2",
      eventId: IDS.invocationEvent,
      eventType: "tool.invocation",
      occurredAt: new Date(COMPLETED_AT_MS).toISOString(),
      recordedAt: new Date(COMPLETED_AT_MS).toISOString(),
      seq: 2,
      dispatchAttemptId: IDS.attempt,
      invocationId: IDS.invocation,
      confirmationId: IDS.confirmation,
      originatingPreviewInvocationId: IDS.previewInvocation,
      toolName: "revit.inspect_model",
      toolVersion: "1.2.3",
      policyClass: "auto",
      policyDecision: "auto",
      mutationScopePolicy: "none",
      mutating: false,
      executor: "bridge",
      paramsDigest: DIGEST_C,
      previewDigest: DIGEST_A,
      commitArgsDigest: DIGEST_B,
      outcome: "completed",
      executorReached: true,
      startedAtMs: STARTED_AT_MS,
      completedAtMs: COMPLETED_AT_MS,
      durationMs: 25,
    });
    expect(Object.keys(bundle.records[1]!)).toEqual([
      "recordType",
      "schema",
      "eventId",
      "eventType",
      "occurredAt",
      "recordedAt",
      "seq",
      "invocationId",
      "state",
      "confirmationId",
      "originatingPreviewInvocationId",
      "commitInvocationId",
      "toolName",
      "toolVersion",
      "commitArgsDigest",
      "previewDigest",
      "recordedAtMs",
    ]);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.selector)).toBe(true);
    expect(Object.isFrozen(bundle.records)).toBe(true);
    expect(bundle.records.every((record) => Object.isFrozen(record))).toBe(true);

    const exportedText = JSON.stringify(bundle);
    for (const canary of Object.values(CANARIES)) {
      expect(exportedText).not.toContain(canary);
    }
    for (const fragment of [
      "SYNTHETIC-",
      "PETRUCCI-TAIL",
      "WS2-MIDDLE",
      "OAUTH-CLIENT",
      "PREVIEW-REFERENCE",
      "CONFIRMATION-REASON",
      "DOCUMENT-MODEL",
      "HOST-ENDPOINT-PATH",
    ]) {
      expect(exportedText).not.toContain(fragment);
    }
  });

  it.each([
    [
      "already_attempted" as const,
      "pre-production audit export was already attempted",
    ],
    [
      "source_unavailable" as const,
      "pre-production audit event source is unavailable",
    ],
  ])("keeps %s refusal fixed and value-free", (reason, message) => {
    const error = new PreProductionAuditExportError(reason);
    expect(error).toMatchObject({
      name: "PreProductionAuditExportError",
      code: "preproduction_audit_export_refused",
      reason,
      message,
    });
    const retainedText = JSON.stringify(error) + String(error) + String(error.stack);
    expect(retainedText).not.toContain("SYNTHETIC-");
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("projects the real denied-confirmation null correlation shape without leaking raw fields", () => {
    const bundle = projectPreProductionAudit(
      validInput([
        confirmationEvent({ state: "denied", nullableCorrelationIds: true }),
      ]),
    );

    expect(bundle.records).toEqual([
      expect.objectContaining({
        recordType: "confirmation",
        state: "denied",
        invocationId: null,
        confirmationId: null,
        originatingPreviewInvocationId: null,
        commitInvocationId: null,
      }),
    ]);
    expect(JSON.stringify(bundle)).not.toContain(CANARIES.reason);
    expect(JSON.stringify(bundle)).not.toContain(CANARIES.previewRef);
  });

  it("admits mutating null only for the real pre-authority failed invocation shape", () => {
    const event = invocationEvent();
    const earlyFailure = {
      ...event,
      payload: {
        ...event.payload,
        idempotency_key: null,
        rsid: null,
        policy_decision: null,
        confirmation_id: null,
        originating_preview_invocation_id: null,
        preview_digest: null,
        preview_ref: null,
        commit_args_digest: null,
        confirmation_reason: null,
        mutating: null,
        document_identity: null,
        params_digest: null,
        mutation_scope: null,
        recovery_hold_ids: [],
        recovery_resolution_ids: [],
        outcome: "failed",
        outcome_error_code: "invalid_arguments",
        executor_reached: false,
      },
    };

    const bundle = projectPreProductionAudit(validInput([earlyFailure]));
    expect(bundle.records).toEqual([
      expect.objectContaining({
        recordType: "invocation",
        policyClass: "auto",
        mutationScopePolicy: "none",
        mutating: null,
        executor: "bridge",
        outcome: "failed",
        executorReached: false,
      }),
    ]);

    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput([
            {
              ...earlyFailure,
              payload: {
                ...earlyFailure.payload,
                outcome: "completed",
                executor_reached: true,
              },
            },
          ]),
        ),
      "event_schema_refused",
    );
  });

  it.each(["requested", "approved", "expired"] as const)(
    "refuses %s confirmation evidence for a non-confirm registry tool",
    (state) => {
      expectRefusal(
        () =>
          projectPreProductionAudit(
            validInput(
              [
                confirmationEvent({
                  state,
                  toolName: APPROVED_TOOL.name,
                  toolVersion: APPROVED_TOOL.version,
                }),
              ],
              [APPROVED_TOOL],
            ),
          ),
        "event_schema_refused",
      );
    },
  );

  it("keeps nullable confirmation correlation identifiers denied-only", () => {
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput([
            confirmationEvent({
              state: "approved",
              nullableCorrelationIds: true,
            }),
          ]),
        ),
      "event_schema_refused",
    );
  });

  it.each([APPROVED_TOOL, CONFIRM_TOOL, GATED_TOOL])(
    "admits denied misuse evidence for $policyClass registry policy",
    (tool) => {
      const bundle = projectPreProductionAudit(
        validInput(
          [
            confirmationEvent({
              state: "denied",
              toolName: tool.name,
              toolVersion: tool.version,
              nullableCorrelationIds: true,
            }),
          ],
          [tool],
        ),
      );
      expect(bundle.records).toEqual([
        expect.objectContaining({ recordType: "confirmation", state: "denied" }),
      ]);
    },
  );

  it("refuses a target event whose configured live selector differs", () => {
    const event = invocationEvent();
    expectRefusal(
      () =>
        projectPreProductionAudit({
          ...validInput([event]),
          selector: {
            ...validInput([]).selector,
            userId: "SYNTHETIC-DIFFERENT-USER-TAIL",
          },
        }),
      "selector_mismatch",
    );
  });

  it("fails closed on unknown raw payload fields without retaining their value", () => {
    const event = invocationEvent();
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput([
            {
              ...event,
              payload: {
                ...event.payload,
                unknown_secret: "SYNTHETIC-UNKNOWN-SECRET-HEAD-MIDDLE-TAIL",
              },
            },
          ]),
        ),
      "event_schema_refused",
    );
  });

  it.each([
    ["component", "spoof-gateway"],
    ["version", "revagent.m4-preproduction-serving/v2"],
    ["instance", "m4-production"],
  ])("refuses spoofed pre-production source %s", (field, value) => {
    const event = invocationEvent();
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput([
            { ...event, source: { ...event.source, [field]: value } },
          ]),
        ),
      "event_schema_refused",
    );
  });

  it.each([
    ["tool_name", "revit.spoofed_tool"],
    ["tool_version", "9.9.9"],
    ["policy_class", "confirm"],
    ["policy_decision", "preview"],
    ["mutation_scope_policy", "session"],
    ["mutating", true],
    ["executor", "aps"],
  ])("refuses registry-binding spoof %s", (field, value) => {
    const event = invocationEvent();
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput([
            { ...event, payload: { ...event.payload, [field]: value } },
          ]),
        ),
      "event_schema_refused",
    );
  });

  it("refuses a confirmation that is absent from the approved registry bindings", () => {
    const event = confirmationEvent();
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput([
            {
              ...event,
              payload: { ...event.payload, tool_version: "9.9.9" },
            },
          ]),
        ),
      "event_schema_refused",
    );
  });

  it("refuses duplicate sequence and event identifiers", () => {
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput([
            invocationEvent({ seq: 7, id: eventId(21) }),
            confirmationEvent({ seq: 7, id: eventId(22) }),
          ]),
        ),
      "duplicate_sequence",
    );
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput([
            invocationEvent({ seq: 7, id: eventId(23) }),
            confirmationEvent({ seq: 8, id: eventId(23) }),
          ]),
        ),
      "duplicate_event_id",
    );
  });

  it("refuses missing records and both input and selected-record limit excess", () => {
    expectRefusal(
      () => projectPreProductionAudit(validInput([])),
      "selected_record_missing",
    );
    expectRefusal(
      () => projectPreProductionAudit(validInput(Array.from({ length: 129 }))),
      "input_event_limit_exceeded",
    );

    const selected = Array.from({ length: 65 }, (_, index) =>
      invocationEvent({
        seq: index + 1,
        id: eventId(index + 100),
        completedAtMs: COMPLETED_AT_MS + index,
      }),
    );
    expectRefusal(
      () => projectPreProductionAudit(validInput(selected)),
      "selected_record_limit_exceeded",
    );
  });

  it("enforces record and total serialized-byte ceilings", () => {
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput(
            [invocationEvent({ toolName: `revit.${"a".repeat(5_000)}` })],
            [{ ...APPROVED_TOOL, name: `revit.${"a".repeat(5_000)}` }],
          ),
        ),
      "record_byte_limit_exceeded",
    );

    const selected = Array.from({ length: 64 }, (_, index) =>
      invocationEvent({
        seq: index + 1,
        id: eventId(index + 300),
        completedAtMs: COMPLETED_AT_MS + index,
        toolName: `revit.${"a".repeat(1_900)}`,
      }),
    );
    expectRefusal(
      () =>
        projectPreProductionAudit(
          validInput(selected, [
            { ...APPROVED_TOOL, name: `revit.${"a".repeat(1_900)}` },
          ]),
        ),
      "total_byte_limit_exceeded",
    );
  });

  it("refuses non-LAN/test and non-preproduction invocations value-free", () => {
    expectRefusal(
      () =>
        projectPreProductionAudit({
          ...validInput([invocationEvent()]),
          profile: "production",
        } as never),
      "invalid_selector",
    );
    expectRefusal(
      () =>
        projectPreProductionAudit({
          ...validInput([invocationEvent()]),
          mode: "production",
        } as never),
      "invalid_selector",
    );
  });
});
