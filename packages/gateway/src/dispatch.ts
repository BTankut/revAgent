import {
  journalRecordIsIntact,
  makeParamsDigest,
  type InvocationJournalRecord,
  type JsonValue,
} from "@revagent/protocol";
import { z } from "zod";

import type { AuthContext } from "./authContext.js";
import {
  buildConfirmationCommitProjection,
  buildConfirmationPreviewProjection,
  type GatewayConfirmationControl,
} from "./confirmation.js";
import {
  confirmationIdFromToken,
  confirmationSessionIdFor,
  type GatewayConfirmationAuthority,
} from "./confirmationAuthority.js";
import {
  REVAGENT_EVENT_SCHEMA,
  type GatewayEventEnvelope,
  type GatewayEventSink,
} from "./events.js";
import {
  createGatewayInvocationContext,
  deriveGatewayInvocationAuthority,
  GatewayInvocationContextError,
  runWithGatewayInvocationContext,
  type GatewayInvocationContext,
  type GatewayInvocationAuthority,
  type GatewayInvocationRoute,
} from "./invocationContext.js";
import { gatewayUuidV7 } from "./identifiers.js";
import type {
  GatewayDurableBatchTerminal,
  GatewayExpectedMutationDispatch,
  GatewayRecoveryAuthority,
  GatewayRecoveryPendingDispatch,
} from "./recoveryAuthority.js";
import type {
  GatewayExecutorBinding,
  GatewayToolRecord,
  GatewayToolRegistry,
} from "./registry.js";

export type GatewayJsonPrimitive = boolean | number | string | null;
export type GatewayJsonValue =
  | GatewayJsonPrimitive
  | readonly GatewayJsonValue[]
  | { readonly [key: string]: GatewayJsonValue };
export type GatewayJsonObject = {
  readonly [key: string]: GatewayJsonValue;
};

export interface GatewayExecutorRequest {
  readonly toolName: string;
  readonly toolVersion: string;
  readonly executorMethod: string;
  readonly policyClass: GatewayToolRecord["policyClass"];
  readonly mutationScopePolicy: GatewayToolRecord["mutationScopePolicy"];
  readonly args: GatewayJsonObject;
  readonly context: GatewayInvocationContext;
}

/**
 * A server-authored atomic batch. Callers must obtain this value through the
 * registry authorization helper before invoking an executor batch seam.
 */
export interface GatewayAtomicBatchExecutorRequest {
  readonly batchId: string;
  readonly atomic: true;
  readonly steps: readonly GatewayExecutorRequest[];
}

export interface GatewayExecutor {
  readonly binding: GatewayExecutorBinding;
  execute(request: GatewayExecutorRequest): Promise<GatewayExecutorOutcome>;
  /**
   * Executes only the server-authored non-mutating preview projection. It must
   * never call the durable mutation prepare/send seam.
   */
  previewConfirmation?(
    request: GatewayExecutorRequest,
  ): Promise<GatewayExecutorOutcome & { readonly previewRef?: string }>;
  /** Synchronous pure envelope construction; it MUST NOT contact Bridge/Revit. */
  buildMutationDispatch?(request: GatewayExecutorRequest): {
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    /** Actual low-level Bridge binding(s), not the outer north-tool args. */
    readonly expected: GatewayExpectedMutationDispatch;
  };
  /** Sends exactly the authority-persisted envelope; it MUST NOT reconstruct it. */
  executePreparedMutation?(
    request: GatewayExecutorRequest,
    dispatch: GatewayRecoveryPendingDispatch,
  ): Promise<GatewayExecutorOutcome>;
  /** Pure construction of one atomic invoke_batch carrier. */
  buildAtomicBatchDispatch?(request: GatewayAtomicBatchExecutorRequest): {
    readonly sessionBindingId: string;
    readonly connectionId: string;
    readonly envelope: unknown;
    readonly expected: GatewayExpectedMutationDispatch;
  };
  /** Sends the exact authority-persisted atomic batch without rebuilding it. */
  executePreparedAtomicBatch?(
    request: GatewayAtomicBatchExecutorRequest,
    dispatch: GatewayRecoveryPendingDispatch,
  ): Promise<GatewayExecutorOutcome>;
}

export type GatewayExecutorOutcome =
  | {
      readonly state: "completed";
      readonly result: GatewayJsonValue;
    }
  | {
      readonly state: "guarded";
      readonly reason: string;
      readonly result: GatewayJsonValue;
    }
  | {
      readonly state: "failed";
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export type GatewayDispatchOutcome =
  | {
      readonly ok: true;
      readonly state: "completed";
      readonly toolName: string;
      readonly toolVersion: string;
      readonly executor: GatewayExecutorBinding;
      readonly requestId: string;
      readonly result: GatewayJsonValue;
      readonly auditDelivery?: "recorded" | "unavailable";
      readonly auditError?: {
        readonly detailCode: string;
        readonly message: string;
      };
    }
  | {
      readonly ok: true;
      readonly state: "guarded";
      readonly toolName: string;
      readonly toolVersion: string;
      readonly executor: GatewayExecutorBinding;
      readonly requestId: string;
      readonly guardedReason: string;
      readonly result: GatewayJsonValue;
      readonly auditDelivery?: "recorded" | "unavailable";
      readonly auditError?: {
        readonly detailCode: string;
        readonly message: string;
      };
    }
  | {
      readonly ok: true;
      readonly state: "confirmation_required";
      readonly toolName: string;
      readonly toolVersion: string;
      readonly executor: GatewayExecutorBinding;
      readonly requestId: string;
      readonly result: GatewayJsonValue;
      readonly confirmation: {
        readonly confirmToken: string;
        readonly confirmationId: string;
        readonly originatingPreviewInvocationId: string;
        readonly previewDigest: `sha256:${string}`;
        readonly previewRef: string;
        readonly commitArgsDigest: `sha256:${string}`;
        readonly expiresAtMs: number;
      };
      readonly auditDelivery?: "recorded" | "unavailable";
      readonly auditError?: {
        readonly detailCode: string;
        readonly message: string;
      };
    }
  | {
      readonly ok: false;
      readonly state: "failed";
      readonly toolName: string;
      readonly requestId: string;
      readonly error: {
        readonly code:
          | "tool_not_found"
          | "invalid_arguments"
          | "policy_enforcement_unavailable"
          | "executor_unavailable"
          | "executor_failed"
          | "invalid_executor_result"
          | "invalid_invocation_context"
          | "confirmation_denied"
          | "confirmation_unavailable"
          | "recovery_blocked"
          | "recovery_protocol_fault"
          | "recovery_unavailable"
          | "audit_unavailable";
        readonly message: string;
        readonly executorCode?: string;
        readonly detailCode?: string;
      };
      readonly executorReached?: boolean;
      /** Exact durable RBP batch carrier when the aggregate batch failed. */
      readonly result?: GatewayJsonValue;
      readonly auditDelivery?: "recorded" | "unavailable";
      readonly auditError?: {
        readonly detailCode: string;
        readonly message: string;
      };
    };

type GatewaySuccessfulDispatchOutcome = Extract<
  GatewayDispatchOutcome,
  { readonly ok: true }
>;

export type { GatewayInvocationContext } from "./invocationContext.js";

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    return false;
  }
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, seen))
    : Object.entries(value).every(
        ([key, entry]) => key.length > 0 && isJsonValue(entry, seen),
      );
  seen.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is GatewayJsonObject {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      isJsonValue(value)
    );
  } catch {
    return false;
  }
}

const RAW_CODE_STATIC_PREVIEW_REASON =
  "safe_wrapper_rejected_write_looking_code" as const;

function isAuthorizableRawCodePreview(
  outcome: GatewayDispatchOutcome,
): outcome is GatewaySuccessfulDispatchOutcome {
  if (!outcome.ok || !isJsonObject(outcome.result)) {
    return false;
  }
  const result = outcome.result;
  if (outcome.state === "completed") {
    return (
      result.success === true &&
      result.guarded === false &&
      result.state === "completed" &&
      result.action === "send_code_to_revit_safe" &&
      result.intent === "writePreview" &&
      Object.prototype.hasOwnProperty.call(result, "response")
    );
  }
  if (outcome.state !== "guarded") {
    return false;
  }
  const writePatterns = result.writePatterns;
  return (
    outcome.guardedReason === RAW_CODE_STATIC_PREVIEW_REASON &&
    result.success === false &&
    result.guarded === true &&
    result.state === "guarded" &&
    result.action === "send_code_to_revit_safe_preflight" &&
    result.reason === RAW_CODE_STATIC_PREVIEW_REASON &&
    result.safetyReason === RAW_CODE_STATIC_PREVIEW_REASON &&
    Array.isArray(writePatterns) &&
    writePatterns.length > 0 &&
    writePatterns.every(
      (pattern) => typeof pattern === "string" && pattern.length > 0,
    )
  );
}

function isAuthorizableConfirmationPreview(
  tool: GatewayToolRecord,
  outcome: GatewayDispatchOutcome,
): outcome is GatewaySuccessfulDispatchOutcome {
  if (!outcome.ok) {
    return false;
  }
  return tool.executorMethod === "send_code_to_revit"
    ? isAuthorizableRawCodePreview(outcome)
    : outcome.state === "completed";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 600);
}

function invalidExecutorResult(input: {
  readonly toolName: string;
  readonly requestId: string;
  readonly message: string;
}): GatewayDispatchOutcome {
  return {
    ok: false,
    state: "failed",
    toolName: input.toolName,
    requestId: input.requestId,
    error: {
      code: "invalid_executor_result",
      message: input.message,
    },
  };
}

function normalizeExecutorOutcome(input: {
  readonly tool: GatewayToolRecord;
  readonly requestId: string;
  readonly executorOutcome?: unknown;
  readonly executorError?: unknown;
  readonly threw: boolean;
}): GatewayDispatchOutcome {
  if (input.threw) {
    return {
      ok: false,
      state: "failed",
      toolName: input.tool.name,
      requestId: input.requestId,
      error: {
        code: "executor_failed",
        message: errorMessage(input.executorError),
      },
    };
  }
  const executorOutcome = input.executorOutcome;
  if (!isJsonObject(executorOutcome)) {
    return invalidExecutorResult({
      toolName: input.tool.name,
      requestId: input.requestId,
      message: "executor returned a non-object outcome",
    });
  }
  if (executorOutcome.state === "failed") {
    const failure = executorOutcome.error;
    if (
      !isJsonObject(failure) ||
      typeof failure.code !== "string" ||
      failure.code.length < 1 ||
      typeof failure.message !== "string" ||
      failure.message.length < 1
    ) {
      return invalidExecutorResult({
        toolName: input.tool.name,
        requestId: input.requestId,
        message: "executor returned an invalid failure outcome",
      });
    }
    return {
      ok: false,
      state: "failed",
      toolName: input.tool.name,
      requestId: input.requestId,
      error: {
        code: "executor_failed",
        executorCode: failure.code.slice(0, 120),
        message: failure.message.replace(/[\r\n]+/gu, " ").slice(0, 600),
      },
    };
  }
  if (
    executorOutcome.state !== "completed" &&
    executorOutcome.state !== "guarded"
  ) {
    return invalidExecutorResult({
      toolName: input.tool.name,
      requestId: input.requestId,
      message: "executor returned an unknown outcome state",
    });
  }
  if (!isJsonValue(executorOutcome.result)) {
    return invalidExecutorResult({
      toolName: input.tool.name,
      requestId: input.requestId,
      message: "executor returned a non-JSON result",
    });
  }
  if (executorOutcome.state === "guarded") {
    const guardedReason = executorOutcome.reason;
    return typeof guardedReason !== "string" ||
      guardedReason.length < 1 ||
      guardedReason.length > 600
      ? invalidExecutorResult({
          toolName: input.tool.name,
          requestId: input.requestId,
          message: "executor returned an invalid guarded outcome",
        })
      : {
          ok: true,
          state: "guarded",
          toolName: input.tool.name,
          toolVersion: input.tool.version,
          executor: input.tool.executor,
          requestId: input.requestId,
          guardedReason,
          result: executorOutcome.result,
        };
  }
  return {
    ok: true,
    state: "completed",
    toolName: input.tool.name,
    toolVersion: input.tool.version,
    executor: input.tool.executor,
    requestId: input.requestId,
    result: executorOutcome.result,
  };
}

function outcomeFromDurableTerminal(input: {
  readonly tool: GatewayToolRecord;
  readonly requestId: string;
  readonly journalRecords: readonly InvocationJournalRecord[];
  readonly batchTerminal: GatewayDurableBatchTerminal | null;
}): GatewayDispatchOutcome {
  const journal = input.journalRecords[0];
  const terminal = journal?.terminalOutcome;
  const fault = (reason: string): GatewayDispatchOutcome => ({
    ok: false,
    state: "failed",
    toolName: input.tool.name,
    requestId: input.requestId,
    error: {
      code: "recovery_protocol_fault",
      detailCode: reason,
      message: `durable terminal evidence rejected: ${reason}`,
    },
  });
  if (input.batchTerminal !== null) {
    const batch = input.batchTerminal.result;
    if (
      input.batchTerminal.resultDigest !==
      makeParamsDigest(batch as unknown as JsonValue)
    ) {
      return fault("terminal_batch_digest_mismatch");
    }
    if (batch.status === "completed") {
      return {
        ok: true,
        state: "completed",
        toolName: input.tool.name,
        toolVersion: input.tool.version,
        executor: input.tool.executor,
        requestId: input.requestId,
        result: batch as unknown as GatewayJsonValue,
      };
    }
    if (batch.status === "guarded") {
      const guarded = batch.steps.find((step) => step.status === "guarded");
      if (guarded === undefined) return fault("guarded_batch_reason_missing");
      return {
        ok: true,
        state: "guarded",
        toolName: input.tool.name,
        toolVersion: input.tool.version,
        executor: input.tool.executor,
        requestId: input.requestId,
        guardedReason: guarded.guarded_reason,
        result: batch as unknown as GatewayJsonValue,
      };
    }
    if (batch.status === "failed" || batch.status === "cancelled") {
      return {
        ok: false,
        state: "failed",
        toolName: input.tool.name,
        requestId: input.requestId,
        result: batch as unknown as GatewayJsonValue,
        error: {
          code: "executor_failed",
          executorCode: batch.status,
          message: `durable Bridge batch recorded ${batch.status}`,
        },
      };
    }
    return fault("terminal_batch_indeterminate");
  }
  if (
    input.journalRecords.length !== 1 ||
    journal === undefined ||
    !journalRecordIsIntact(journal) ||
    terminal === null
  ) {
    return fault("terminal_journal_invalid");
  }
  if (
    (terminal.status === "completed" || terminal.status === "guarded") &&
    (!terminal.payloadRetained || terminal.payload === undefined)
  ) {
    return {
      ok: false,
      state: "failed",
      toolName: input.tool.name,
      requestId: input.requestId,
      error: {
        code: "executor_failed",
        executorCode: "payload_omitted",
        message: "durable Bridge outcome omitted the inline result payload",
      },
    };
  }
  if (terminal.status === "completed") {
    return {
      ok: true,
      state: "completed",
      toolName: input.tool.name,
      toolVersion: input.tool.version,
      executor: input.tool.executor,
      requestId: input.requestId,
      result: terminal.payload as GatewayJsonValue,
    };
  }
  if (terminal.status === "guarded") {
    if (terminal.guardedReason === undefined) {
      return fault("guarded_reason_missing");
    }
    return {
      ok: true,
      state: "guarded",
      toolName: input.tool.name,
      toolVersion: input.tool.version,
      executor: input.tool.executor,
      requestId: input.requestId,
      guardedReason: terminal.guardedReason,
      result: terminal.payload as GatewayJsonValue,
    };
  }
  return {
    ok: false,
    state: "failed",
    toolName: input.tool.name,
    requestId: input.requestId,
    error: {
      code: "executor_failed",
      executorCode: terminal.status,
      message: `durable Bridge journal recorded ${terminal.status}`,
    },
  };
}

export interface GatewayDispatcherOptions {
  readonly eventSink: GatewayEventSink;
  readonly eventSource: GatewayEventEnvelope["source"];
  readonly clock?: () => number;
  readonly newInvocationId?: () => string;
  readonly newAttemptId?: () => string;
  readonly newEventId?: () => string;
  readonly confirmationAuthority?: Pick<
    GatewayConfirmationAuthority,
    "createPendingAction"
  >;
  readonly recoveryAuthority: Pick<
    GatewayRecoveryAuthority,
    | "acquireInvocationWindow"
    | "releaseInvocationWindow"
    | "preflightMutation"
    | "prepareMutationDispatch"
    | "reconcilePendingDispatch"
  >;
}

interface DispatchAuditInput {
  readonly auth: DispatchAuditIdentity;
  readonly route: GatewayInvocationRoute | undefined;
  readonly mcpSessionId: string;
  readonly toolName: string;
  readonly invocationId: string | null;
  readonly attemptId?: string;
  readonly startedAtMs: number;
  readonly tool: GatewayToolRecord | undefined;
  readonly context: GatewayInvocationContext | undefined;
  readonly authority?: GatewayInvocationAuthority;
  readonly paramsDigest?: string;
  readonly recoveryHoldIds?: readonly string[];
  readonly recoveryResolutionIds?: readonly string[];
  readonly executorReached: boolean;
  readonly confirmation?: {
    readonly decision: "preview" | "confirmed" | "denied";
    readonly confirmationId: string | null;
    readonly originatingPreviewInvocationId: string | null;
    readonly previewDigest?: `sha256:${string}` | null;
    readonly previewRef?: string | null;
    readonly commitArgsDigest?: `sha256:${string}` | null;
    readonly reason?: string | null;
  };
}

export interface GatewayDispatchRequest {
  readonly toolName: string;
  readonly args: unknown;
  readonly auth: AuthContext;
  readonly mcpSessionId: string;
  /** Stable confirmation authority when transport requests are stateless. */
  readonly confirmationSessionId?: string;
  readonly confirmation?: GatewayConfirmationControl;
  readonly resolveRoute: (
    auth: AuthContext,
  ) => GatewayInvocationRoute | Promise<GatewayInvocationRoute>;
}

interface DispatchAuditIdentity {
  readonly principalKey: string;
  readonly actor: {
    readonly tenantId: string;
    readonly userId: string;
    readonly role: AuthContext["actor"]["role"];
  };
  readonly session: {
    readonly sessionId: string;
    readonly mcpSessionId: string | null;
    readonly oauthClientId: string | null;
  };
}

function snapshotAuthContext(auth: AuthContext): AuthContext {
  return Object.freeze({
    contractVersion: auth.contractVersion,
    actor: Object.freeze({
      type: auth.actor.type,
      tenantId: auth.actor.tenantId,
      userId: auth.actor.userId,
      role: auth.actor.role,
      oidcIssuer: auth.actor.oidcIssuer,
      oidcSubject: auth.actor.oidcSubject,
    }),
    session: Object.freeze({
      sessionId: auth.session.sessionId,
      clientType: auth.session.clientType,
      mcpSessionId: auth.session.mcpSessionId,
      oauthClientId: auth.session.oauthClientId,
    }),
    principalKey: auth.principalKey,
    issuedAtMs: auth.issuedAtMs,
    expiresAtMs: auth.expiresAtMs,
  });
}

function snapshotAuditIdentity(auth: AuthContext): DispatchAuditIdentity {
  return Object.freeze({
    principalKey: auth.principalKey,
    actor: Object.freeze({
      tenantId: auth.actor.tenantId,
      userId: auth.actor.userId,
      role: auth.actor.role,
    }),
    session: Object.freeze({
      sessionId: auth.session.sessionId,
      mcpSessionId: auth.session.mcpSessionId,
      oauthClientId: auth.session.oauthClientId,
    }),
  });
}

function snapshotInvocationRoute(
  route: GatewayInvocationRoute,
): GatewayInvocationRoute {
  const documentIdentity =
    route.documentIdentity.kind === "live"
      ? Object.freeze({
          kind: "live" as const,
          session_document_id: route.documentIdentity.session_document_id,
        })
      : Object.freeze({
          kind: "published" as const,
          acc_project_id: route.documentIdentity.acc_project_id,
          item_urn: route.documentIdentity.item_urn,
          version_urn: route.documentIdentity.version_urn,
          version_number: route.documentIdentity.version_number,
        });
  return Object.freeze({
    tenantId: route.tenantId,
    mcpSessionId: route.mcpSessionId,
    rsid: route.rsid,
    documentIdentity,
  });
}

function documentIdentityPayload(
  context: GatewayInvocationContext | undefined,
  authority?: GatewayInvocationAuthority,
): GatewayJsonValue {
  const identity = context?.documentIdentity ?? authority?.documentIdentity;
  if (identity === undefined) {
    return null;
  }
  if (identity.kind === "live") {
    return {
      kind: identity.kind,
      session_document_id: identity.session_document_id,
    };
  }
  return {
    kind: identity.kind,
    acc_project_id: identity.acc_project_id,
    item_urn: identity.item_urn,
    version_urn: identity.version_urn,
    version_number: identity.version_number,
  };
}

function mutationScopePayload(
  context: GatewayInvocationContext | undefined,
  authority?: GatewayInvocationAuthority,
): GatewayJsonValue {
  const scope = context?.mutationScope ?? authority?.mutationScope;
  if (scope === undefined || scope === null) {
    return null;
  }
  return scope.kind === "session"
    ? { kind: scope.kind }
    : { kind: scope.kind, document_id: scope.document_id };
}

function preparedMutationAuthorityError(input: {
  readonly expected: GatewayExpectedMutationDispatch;
  readonly context: GatewayInvocationContext;
  readonly tool: GatewayToolRecord;
}): string | null {
  const { expected, context, tool } = input;
  if (
    expected.rsid !== context.rsid ||
    expected.correlationId !== context.invocationId ||
    expected.bindings.length < 1 ||
    expected.recoveryClearances.length !== 0
  ) {
    return "prepared_dispatch_outer_binding_mismatch";
  }
  let mutatingCount = 0;
  for (const binding of expected.bindings) {
    if (
      binding.rsid !== context.rsid ||
      binding.policy.class !== tool.policyClass ||
      binding.policy.decision !== context.policyDecision ||
      binding.policy.confirmation_id !== context.confirmationId ||
      binding.verification !== null ||
      (binding.recoveryClearances ?? []).length !== 0
    ) {
      return "prepared_dispatch_policy_binding_mismatch";
    }
    if (binding.mutating) {
      mutatingCount += 1;
      if (
        context.mutationScope === null ||
        makeParamsDigest(binding.mutationScope as JsonValue) !==
          makeParamsDigest(context.mutationScope as JsonValue)
      ) {
        return "prepared_dispatch_scope_binding_mismatch";
      }
    } else if (binding.mutationScope !== null) {
      return "prepared_dispatch_read_scope_mismatch";
    }
  }
  return mutatingCount > 0 ? null : "prepared_dispatch_has_no_mutation";
}

export class GatewayDispatcher {
  readonly #registry: GatewayToolRegistry;
  readonly #executors: ReadonlyMap<GatewayExecutorBinding, GatewayExecutor>;
  readonly #eventSink: GatewayEventSink;
  readonly #eventSource: GatewayEventEnvelope["source"];
  readonly #clock: () => number;
  readonly #newInvocationId: (timestampMs: number) => string;
  readonly #newAttemptId: (timestampMs: number) => string;
  readonly #newEventId: (timestampMs: number) => string;
  readonly #recoveryAuthority: GatewayDispatcherOptions["recoveryAuthority"];
  readonly #confirmationAuthority:
    | GatewayDispatcherOptions["confirmationAuthority"]
    | undefined;
  readonly #rsidTails = new Map<string, Promise<void>>();
  #eventSequence = 0;

  public constructor(
    registry: GatewayToolRegistry,
    executors: readonly GatewayExecutor[],
    options: GatewayDispatcherOptions,
  ) {
    const byBinding = new Map<GatewayExecutorBinding, GatewayExecutor>();
    for (const executor of executors) {
      if (byBinding.has(executor.binding)) {
        throw new TypeError(
          `duplicate Gateway executor binding: ${executor.binding}`,
        );
      }
      byBinding.set(executor.binding, executor);
    }
    this.#registry = registry;
    this.#executors = byBinding;
    this.#eventSink = options.eventSink;
    this.#eventSource = Object.freeze({ ...options.eventSource });
    this.#clock = options.clock ?? Date.now;
    const configuredInvocationId = options.newInvocationId;
    const configuredAttemptId = options.newAttemptId;
    const configuredEventId = options.newEventId;
    this.#newInvocationId =
      configuredInvocationId === undefined
        ? gatewayUuidV7
        : () => configuredInvocationId();
    this.#newAttemptId =
      configuredAttemptId === undefined
        ? gatewayUuidV7
        : () => configuredAttemptId();
    this.#newEventId =
      configuredEventId === undefined
        ? gatewayUuidV7
        : () => configuredEventId();
    this.#recoveryAuthority = options.recoveryAuthority;
    this.#confirmationAuthority = options.confirmationAuthority;
  }

  public registry(): GatewayToolRegistry {
    return this.#registry;
  }

  public async dispatch(
    input: GatewayDispatchRequest,
  ): Promise<GatewayDispatchOutcome> {
    const tool = this.#registry.get(input.toolName);
    if (
      tool?.policyClass === "confirm" &&
      input.confirmation === undefined
    ) {
      return this.#dispatchConfirmationPreview(input, tool);
    }
    return tool?.mutationScopePolicy === "session" ||
      tool?.mutationScopePolicy === "document"
      ? this.#dispatchMutation(input, tool)
      : this.#dispatchRead(input);
  }

  async #dispatchConfirmationPreview(
    input: GatewayDispatchRequest,
    tool: GatewayToolRecord,
  ): Promise<GatewayDispatchOutcome> {
    const startedAtMs = this.#clock();
    const attemptId = this.#newAttemptId(startedAtMs);
    const auth = snapshotAuthContext(input.auth);
    const auditIdentity = snapshotAuditIdentity(auth);
    const confirmationSessionId = confirmationSessionIdFor(
      auth,
      input.confirmationSessionId ?? input.mcpSessionId,
    );
    let route: GatewayInvocationRoute | undefined;
    let authority: GatewayInvocationAuthority | undefined;
    const previewAuditState: { paramsDigest?: string } = {};

    const finishFailure = async (failure: {
      readonly code: Extract<
        GatewayDispatchOutcome,
        { readonly ok: false }
      >["error"]["code"];
      readonly message: string;
      readonly detailCode?: string;
      readonly invocationId?: string;
      readonly context?: GatewayInvocationContext;
      readonly executorReached?: boolean;
      readonly confirmation?: DispatchAuditInput["confirmation"];
    }): Promise<GatewayDispatchOutcome> => {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: failure.invocationId ?? attemptId,
        error: {
          code: failure.code,
          ...(failure.detailCode === undefined
            ? {}
            : { detailCode: failure.detailCode }),
          message: failure.message,
        },
        executorReached: failure.executorReached ?? false,
      };
      return this.#finish(outcome, {
        auth: auditIdentity,
        route,
        mcpSessionId: input.mcpSessionId,
        toolName: input.toolName,
        invocationId: failure.invocationId ?? null,
        attemptId,
        startedAtMs,
        tool,
        context: failure.context,
        authority,
        paramsDigest: previewAuditState.paramsDigest,
        executorReached: failure.executorReached ?? false,
        confirmation: failure.confirmation,
      });
    };

    if (!isJsonObject(input.args)) {
      return finishFailure({
        code: "invalid_arguments",
        message: "tool arguments must be a finite JSON object",
      });
    }
    const parsedArgs = (() => {
      try {
        return z.object(tool.inputSchema).strict().safeParse(input.args);
      } catch {
        return null;
      }
    })();
    if (
      parsedArgs === null ||
      !parsedArgs.success ||
      !isJsonObject(parsedArgs.data)
    ) {
      await this.#emitConfirmationEvent({
        auth: auditIdentity,
        confirmationSessionId,
        status: "denied",
        tool,
        confirmationId: null,
        originatingPreviewInvocationId: null,
        commitInvocationId: null,
        commitArgsDigest: null,
        previewDigest: null,
        previewRef: null,
        reason: "invalid_arguments",
      });
      return finishFailure({
        code: "invalid_arguments",
        message:
          parsedArgs === null
            ? "registry schema validation did not complete"
            : "tool arguments do not match the registry schema",
        confirmation: {
          decision: "denied",
          confirmationId: null,
          originatingPreviewInvocationId: null,
          reason: "invalid_arguments",
        },
      });
    }
    const projection = buildConfirmationPreviewProjection(
      tool,
      parsedArgs.data,
    );
    if (!projection.ok) {
      await this.#emitConfirmationEvent({
        auth: auditIdentity,
        confirmationSessionId,
        status: "denied",
        tool,
        confirmationId: null,
        originatingPreviewInvocationId: null,
        commitInvocationId: null,
        commitArgsDigest: null,
        previewDigest: null,
        previewRef: null,
        reason: projection.reason,
      });
      return finishFailure({
        code: "confirmation_denied",
        detailCode: projection.reason,
        message: "confirmation policy denied the request",
        confirmation: {
          decision: "denied",
          confirmationId: null,
          originatingPreviewInvocationId: null,
          reason: projection.reason,
        },
      });
    }
    previewAuditState.paramsDigest = makeParamsDigest(
      projection.previewArgs as JsonValue,
    );

    try {
      route = snapshotInvocationRoute(await input.resolveRoute(auth));
      authority = deriveGatewayInvocationAuthority({
        auth,
        route,
        mcpSessionId: input.mcpSessionId,
        mutationScopePolicy: tool.mutationScopePolicy,
        startedAtMs,
      });
    } catch (error) {
      return finishFailure({
        code: "invalid_invocation_context",
        detailCode:
          error instanceof GatewayInvocationContextError
            ? error.code
            : "route_resolution_failed",
        message: errorMessage(error),
      });
    }
    if (!authority.mutating || authority.mutationScope === null) {
      return finishFailure({
        code: "confirmation_unavailable",
        detailCode: "confirm_tool_has_no_mutation_scope",
        message: "confirm-class tool has no authoritative mutation scope",
      });
    }
    const confirmationAuthority = this.#confirmationAuthority;
    const executor = this.#executors.get(tool.executor);
    if (confirmationAuthority === undefined) {
      return finishFailure({
        code: "confirmation_unavailable",
        detailCode: "confirmation_authority_unavailable",
        message: "durable confirmation authority is unavailable",
      });
    }
    if (executor?.previewConfirmation === undefined) {
      return finishFailure({
        code: "confirmation_unavailable",
        detailCode: "confirmation_preview_unavailable",
        message: "confirm-class tool has no safe preview executor",
      });
    }

    return this.#serialize(route.rsid, async () => {
      const recovery = this.#recoveryAuthority;
      const window = await recovery.acquireInvocationWindow({
        tenantId: auth.actor.tenantId,
        rsid: route!.rsid,
        attemptId,
      });
      if (window.kind === "blocked") {
        return finishFailure({
          code: "recovery_blocked",
          detailCode: "dispatch_window_active",
          message: `another invocation owns the durable rsid window: ${window.activeAttemptId}`,
        });
      }
      if (window.kind === "protocol_fault") {
        return finishFailure({
          code: "recovery_protocol_fault",
          detailCode: window.reason,
          message: `durable invocation window rejected: ${window.reason}`,
        });
      }
      if (window.kind === "unavailable") {
        return finishFailure({
          code: "recovery_unavailable",
          detailCode: window.code,
          message: window.message,
        });
      }

      try {
        const invocationId = this.#newInvocationId(this.#clock());
        let context: GatewayInvocationContext;
        try {
          context = createGatewayInvocationContext({
            auth,
            route: route!,
            mcpSessionId: input.mcpSessionId,
            invocationId,
            toolName: tool.name,
            toolVersion: tool.version,
            policyClass: tool.policyClass,
            policyDecision: "preview",
            mutationScopePolicy: "none",
            executor: tool.executor,
            args: projection.previewArgs,
            startedAtMs,
          });
        } catch (error) {
          return finishFailure({
            code: "invalid_invocation_context",
            detailCode:
              error instanceof GatewayInvocationContextError
                ? error.code
                : undefined,
            message: errorMessage(error),
            invocationId,
          });
        }
        const request: GatewayExecutorRequest = {
          toolName: tool.name,
          toolVersion: tool.version,
          executorMethod: projection.previewExecutorMethod,
          policyClass: tool.policyClass,
          mutationScopePolicy: "none",
          args: projection.previewArgs,
          context,
        };
        let rawPreview: Awaited<
          ReturnType<NonNullable<GatewayExecutor["previewConfirmation"]>>
        >;
        try {
          rawPreview = await runWithGatewayInvocationContext(context, () =>
            executor.previewConfirmation!(request),
          );
        } catch (error) {
          rawPreview = {
            state: "failed",
            error: {
              code: "confirmation_preview_failed",
              message: errorMessage(error),
            },
          };
        }
        const previewOutcome = normalizeExecutorOutcome({
          tool,
          requestId: invocationId,
          executorOutcome: rawPreview,
          threw: false,
        });
        const previewIsAuthorizable = isAuthorizableConfirmationPreview(
          tool,
          previewOutcome,
        );
        if (!previewIsAuthorizable) {
          return this.#finish(previewOutcome, {
            auth: auditIdentity,
            route,
            mcpSessionId: input.mcpSessionId,
            toolName: input.toolName,
            invocationId,
            attemptId,
            startedAtMs,
            tool,
            context,
            authority,
            paramsDigest: previewAuditState.paramsDigest,
            executorReached: true,
            confirmation: {
              decision: "preview",
              confirmationId: null,
              originatingPreviewInvocationId: invocationId,
              commitArgsDigest: projection.commitArgsDigest,
              reason: "preview_not_authorizable",
            },
          });
        }

        const previewDigest = makeParamsDigest(
          previewOutcome.result as JsonValue,
        );
        const candidatePreviewRef = rawPreview.previewRef;
        const previewRef =
          typeof candidatePreviewRef === "string" &&
          candidatePreviewRef.length > 0 &&
          candidatePreviewRef.length <= 2_048
            ? candidatePreviewRef
            : `inline:${previewDigest}`;
        const issued = await confirmationAuthority.createPendingAction({
          tenantId: auth.actor.tenantId,
          principalKey: auth.principalKey,
          userId: auth.actor.userId,
          gatewaySessionId: auth.session.sessionId,
          confirmationSessionId,
          oauthClientId: auth.session.oauthClientId,
          rsid: route!.rsid,
          toolName: tool.name,
          toolVersion: tool.version,
          commitArgsDigest: projection.commitArgsDigest,
          mutationScope: authority!.mutationScope!,
          documentIdentity: authority!.documentIdentity,
          originatingPreviewInvocationId: invocationId,
          previewDigest,
          previewRef,
        });
        if (issued.kind !== "issued") {
          return finishFailure({
            code: "confirmation_unavailable",
            detailCode: issued.code,
            message: issued.message,
            invocationId,
            context,
            executorReached: true,
            confirmation: {
              decision: "preview",
              confirmationId: null,
              originatingPreviewInvocationId: invocationId,
              previewDigest,
              previewRef,
              commitArgsDigest: projection.commitArgsDigest,
              reason: "pending_action_not_durable",
            },
          });
        }
        const requestedAudit = await this.#emitConfirmationEvent({
          auth: auditIdentity,
          confirmationSessionId,
          status: "requested",
          tool,
          confirmationId: issued.pendingAction.confirmationId,
          originatingPreviewInvocationId: invocationId,
          commitInvocationId: null,
          commitArgsDigest: projection.commitArgsDigest,
          previewDigest,
          previewRef,
          reason: null,
        });
        if (!requestedAudit.ok) {
          return finishFailure({
            code: "audit_unavailable",
            detailCode: requestedAudit.detailCode,
            message: requestedAudit.message,
            invocationId,
            context,
            executorReached: true,
            confirmation: {
              decision: "preview",
              confirmationId: issued.pendingAction.confirmationId,
              originatingPreviewInvocationId: invocationId,
              previewDigest,
              previewRef,
              commitArgsDigest: projection.commitArgsDigest,
              reason: "requested_audit_unavailable",
            },
          });
        }
        const outcome: GatewayDispatchOutcome = Object.freeze({
          ok: true as const,
          state: "confirmation_required" as const,
          toolName: tool.name,
          toolVersion: tool.version,
          executor: tool.executor,
          requestId: invocationId,
          result: previewOutcome.result,
          confirmation: Object.freeze({
            confirmToken: issued.confirmToken,
            confirmationId: issued.pendingAction.confirmationId,
            originatingPreviewInvocationId: invocationId,
            previewDigest,
            previewRef,
            commitArgsDigest: projection.commitArgsDigest,
            expiresAtMs: issued.pendingAction.expiresAtMs,
          }),
        });
        return this.#finish(outcome, {
          auth: auditIdentity,
          route,
          mcpSessionId: input.mcpSessionId,
          toolName: input.toolName,
          invocationId,
          attemptId,
          startedAtMs,
          tool,
          context,
          authority,
          paramsDigest: previewAuditState.paramsDigest,
          executorReached: true,
          confirmation: {
            decision: "preview",
            confirmationId: issued.pendingAction.confirmationId,
            originatingPreviewInvocationId: invocationId,
            previewDigest,
            previewRef,
            commitArgsDigest: projection.commitArgsDigest,
            reason: null,
          },
        });
      } finally {
        await recovery.releaseInvocationWindow({
          tenantId: auth.actor.tenantId,
          rsid: route!.rsid,
          attemptId,
        });
      }
    });
  }

  async #dispatchMutation(
    input: GatewayDispatchRequest,
    tool: GatewayToolRecord,
  ): Promise<GatewayDispatchOutcome> {
    const startedAtMs = this.#clock();
    const attemptId = this.#newAttemptId(startedAtMs);
    const auth = snapshotAuthContext(input.auth);
    const auditIdentity = snapshotAuditIdentity(auth);
    const confirmationSessionId = confirmationSessionIdFor(
      auth,
      input.confirmationSessionId ?? input.mcpSessionId,
    );
    let route: GatewayInvocationRoute | undefined;
    let authority: GatewayInvocationAuthority | undefined;
    let paramsDigest: string | undefined;
    let confirmationId: string | null = null;
    let commitArgsDigest: `sha256:${string}` | null = null;
    try {
      if (isJsonValue(input.args)) {
        paramsDigest = makeParamsDigest(input.args as JsonValue);
      }
    } catch {
      // A non-canonical value is rejected below; no false digest is audited.
    }

    const finishFailure = async (failure: {
      readonly code: Extract<
        GatewayDispatchOutcome,
        { readonly ok: false }
      >["error"]["code"];
      readonly message: string;
      readonly detailCode?: string;
      readonly executorReached?: boolean;
      readonly invocationId?: string;
      readonly context?: GatewayInvocationContext;
      readonly recoveryHoldIds?: readonly string[];
      readonly recoveryResolutionIds?: readonly string[];
      readonly confirmation?: DispatchAuditInput["confirmation"];
    }): Promise<GatewayDispatchOutcome> => {
      const requestId = failure.invocationId ?? attemptId;
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        executorReached: failure.executorReached ?? false,
        error: {
          code: failure.code,
          ...(failure.detailCode === undefined
            ? {}
            : { detailCode: failure.detailCode }),
          message: failure.message,
        },
      };
      return this.#finish(outcome, {
        auth: auditIdentity,
        route,
        mcpSessionId: input.mcpSessionId,
        toolName: input.toolName,
        invocationId: failure.invocationId ?? null,
        attemptId,
        startedAtMs,
        tool,
        context: failure.context,
        authority,
        paramsDigest,
        recoveryHoldIds: failure.recoveryHoldIds ?? [],
        recoveryResolutionIds: failure.recoveryResolutionIds ?? [],
        executorReached: failure.executorReached ?? false,
        confirmation: failure.confirmation,
      });
    };

    const auditInvalidConfirmationArguments = async (): Promise<
      DispatchAuditInput["confirmation"] | undefined
    > => {
      if (tool.policyClass !== "confirm" || input.confirmation === undefined) {
        return undefined;
      }
      const suppliedConfirmationId = confirmationIdFromToken(
        input.confirmation.confirmToken,
      );
      await this.#emitConfirmationEvent({
        auth: auditIdentity,
        confirmationSessionId,
        status: "denied",
        tool,
        confirmationId: suppliedConfirmationId,
        originatingPreviewInvocationId:
          input.confirmation.originatingPreviewInvocationId,
        commitInvocationId: null,
        commitArgsDigest: null,
        previewDigest: null,
        previewRef: null,
        reason: "invalid_arguments",
      });
      return {
        decision: "denied",
        confirmationId: suppliedConfirmationId,
        originatingPreviewInvocationId:
          input.confirmation.originatingPreviewInvocationId,
        reason: "invalid_arguments",
      };
    };

    if (!isJsonObject(input.args)) {
      return finishFailure({
        code: "invalid_arguments",
        message: "tool arguments must be a finite JSON object",
        confirmation: await auditInvalidConfirmationArguments(),
      });
    }
    const parsedArgs = (() => {
      try {
        return z.object(tool.inputSchema).strict().safeParse(input.args);
      } catch {
        return null;
      }
    })();
    if (parsedArgs === null) {
      return finishFailure({
        code: "invalid_arguments",
        message: "registry schema validation did not complete",
        confirmation: await auditInvalidConfirmationArguments(),
      });
    }
    if (!parsedArgs.success || !isJsonObject(parsedArgs.data)) {
      return finishFailure({
        code: "invalid_arguments",
        message: "tool arguments do not match the registry schema",
        confirmation: await auditInvalidConfirmationArguments(),
      });
    }
    const parsedJsonArgs: GatewayJsonObject = parsedArgs.data;
    try {
      paramsDigest = makeParamsDigest(parsedJsonArgs as JsonValue);
    } catch {
      return finishFailure({
        code: "invalid_arguments",
        message: "tool arguments cannot be canonically digested",
        confirmation: await auditInvalidConfirmationArguments(),
      });
    }
    if (tool.policyClass === "confirm") {
      if (input.confirmation === undefined) {
        return finishFailure({
          code: "confirmation_denied",
          detailCode: "confirmation_proof_missing",
          message: "confirmation policy denied the request",
        });
      }
      const projection = buildConfirmationCommitProjection(
        tool,
        parsedJsonArgs,
      );
      if (!projection.ok) {
        await this.#emitConfirmationEvent({
          auth: auditIdentity,
          confirmationSessionId,
          status: "denied",
          tool,
          confirmationId: confirmationIdFromToken(
            input.confirmation.confirmToken,
          ),
          originatingPreviewInvocationId:
            input.confirmation.originatingPreviewInvocationId,
          commitInvocationId: null,
          commitArgsDigest: null,
          previewDigest: null,
          previewRef: null,
          reason: projection.reason,
        });
        return finishFailure({
          code: "confirmation_denied",
          detailCode: projection.reason,
          message: "confirmation policy denied the request",
          confirmation: {
            decision: "denied",
            confirmationId: confirmationIdFromToken(
              input.confirmation.confirmToken,
            ),
            originatingPreviewInvocationId:
              input.confirmation.originatingPreviewInvocationId,
            reason: projection.reason,
          },
        });
      }
      confirmationId = confirmationIdFromToken(
        input.confirmation.confirmToken,
      );
      commitArgsDigest = projection.commitArgsDigest;
      if (confirmationId === null) {
        await this.#emitConfirmationEvent({
          auth: auditIdentity,
          confirmationSessionId,
          status: "denied",
          tool,
          confirmationId: null,
          originatingPreviewInvocationId:
            input.confirmation.originatingPreviewInvocationId,
          commitInvocationId: null,
          commitArgsDigest,
          previewDigest: null,
          previewRef: null,
          reason: "malformed_token",
        });
        return finishFailure({
          code: "confirmation_denied",
          detailCode: "malformed_token",
          message: "confirmation policy denied the request",
          confirmation: {
            decision: "denied",
            confirmationId: null,
            originatingPreviewInvocationId:
              input.confirmation.originatingPreviewInvocationId,
            commitArgsDigest,
            reason: "malformed_token",
          },
        });
      }
    }

    try {
      route = snapshotInvocationRoute(await input.resolveRoute(auth));
      authority = deriveGatewayInvocationAuthority({
        auth,
        route,
        mcpSessionId: input.mcpSessionId,
        mutationScopePolicy: tool.mutationScopePolicy,
        startedAtMs,
      });
    } catch (error) {
      return finishFailure({
        code: "invalid_invocation_context",
        detailCode:
          error instanceof GatewayInvocationContextError
            ? error.code
            : "route_resolution_failed",
        message: errorMessage(error),
      });
    }
    if (!authority.mutating || authority.mutationScope === null) {
      return finishFailure({
        code: "recovery_protocol_fault",
        detailCode: "registry_effect_mismatch",
        message:
          "mutating registry row produced no authoritative mutation scope",
      });
    }
    if (tool.policyClass === "gated") {
      if (input.confirmation !== undefined) {
        const suppliedConfirmationId = confirmationIdFromToken(
          input.confirmation.confirmToken,
        );
        await this.#emitConfirmationEvent({
          auth: auditIdentity,
          confirmationSessionId,
          status: "denied",
          tool,
          confirmationId: suppliedConfirmationId,
          originatingPreviewInvocationId:
            input.confirmation.originatingPreviewInvocationId,
          commitInvocationId: null,
          commitArgsDigest: null,
          previewDigest: null,
          previewRef: null,
          reason: "gated_in_channel_approval_forbidden",
        });
        return finishFailure({
          code: "policy_enforcement_unavailable",
          detailCode: "gated_in_channel_approval_forbidden",
          message:
            "gated tools require an out-of-band role-checked approval authority",
          confirmation: {
            decision: "denied",
            confirmationId: suppliedConfirmationId,
            originatingPreviewInvocationId:
              input.confirmation.originatingPreviewInvocationId,
            reason: "gated_in_channel_approval_forbidden",
          },
        });
      }
      return finishFailure({
        code: "policy_enforcement_unavailable",
        message:
          "gated tools require an out-of-band role-checked approval authority",
      });
    }
    if (tool.policyClass === "auto" && input.confirmation !== undefined) {
      return finishFailure({
        code: "confirmation_denied",
        detailCode: "confirmation_fields_not_allowed",
        message: "confirmation control is not accepted for an auto tool",
      });
    }
    const executor = this.#executors.get(tool.executor);
    if (executor === undefined) {
      return finishFailure({
        code: "executor_unavailable",
        message: `executor binding is unavailable: ${tool.executor}`,
      });
    }

    return this.#serialize(route.rsid, async () => {
      const recovery = this.#recoveryAuthority;
      const window = await recovery.acquireInvocationWindow({
        tenantId: auth.actor.tenantId,
        rsid: route!.rsid,
        attemptId,
      });
      if (window.kind === "blocked") {
        return finishFailure({
          code: "recovery_blocked",
          detailCode: "dispatch_window_active",
          message: `another invocation owns the durable rsid window: ${window.activeAttemptId}`,
        });
      }
      if (window.kind === "protocol_fault") {
        return finishFailure({
          code: "recovery_protocol_fault",
          detailCode: window.reason,
          message: `durable invocation window rejected: ${window.reason}`,
        });
      }
      if (window.kind === "unavailable") {
        return finishFailure({
          code: "recovery_unavailable",
          detailCode: window.code,
          message: window.message,
        });
      }

      try {
        const preflight = await recovery.preflightMutation({
          tenantId: auth.actor.tenantId,
          rsid: route!.rsid,
          mutationScopes: [authority!.mutationScope!],
        });
        if (preflight.kind !== "clear") {
          if (preflight.kind === "blocked") {
            return finishFailure({
              code: "recovery_blocked",
              detailCode: preflight.reason,
              message: `mutation recovery hold blocks dispatch: ${preflight.holdIds.join(",")}`,
              recoveryHoldIds: preflight.holdIds,
            });
          }
          if (preflight.kind === "protocol_fault") {
            return finishFailure({
              code: "recovery_protocol_fault",
              detailCode: preflight.reason,
              message: `mutation recovery preflight rejected: ${preflight.reason}`,
            });
          }
          return finishFailure({
            code: "recovery_unavailable",
            detailCode: preflight.code,
            message: preflight.message,
          });
        }

        const invocationId = this.#newInvocationId(this.#clock());
        let context: GatewayInvocationContext;
        try {
          context = createGatewayInvocationContext({
            auth,
            route: route!,
            mcpSessionId: input.mcpSessionId,
            invocationId,
            toolName: tool.name,
            toolVersion: tool.version,
            policyClass: tool.policyClass,
            policyDecision:
              tool.policyClass === "confirm" ? "confirmed" : "auto",
            confirmationId,
            originatingPreviewInvocationId:
              tool.policyClass === "confirm"
                ? input.confirmation!.originatingPreviewInvocationId
                : null,
            mutationScopePolicy: tool.mutationScopePolicy,
            executor: tool.executor,
            args: parsedJsonArgs,
            startedAtMs,
          });
        } catch (error) {
          return finishFailure({
            code: "invalid_invocation_context",
            detailCode:
              error instanceof GatewayInvocationContextError
                ? error.code
                : undefined,
            message: errorMessage(error),
            invocationId,
          });
        }
        if (
          executor.buildMutationDispatch === undefined ||
          executor.executePreparedMutation === undefined
        ) {
          return finishFailure({
            code: "recovery_unavailable",
            detailCode: "executor_recovery_seam_missing",
            message: "mutating executor has no durable prepare/send seam",
            invocationId,
            context,
          });
        }

        const request: GatewayExecutorRequest = {
          toolName: tool.name,
          toolVersion: tool.version,
          executorMethod: tool.executorMethod,
          policyClass: tool.policyClass,
          mutationScopePolicy: tool.mutationScopePolicy,
          args: parsedJsonArgs,
          context,
        };
        let draft: ReturnType<
          NonNullable<GatewayExecutor["buildMutationDispatch"]>
        >;
        try {
          draft = runWithGatewayInvocationContext(context, () =>
            executor.buildMutationDispatch!(request),
          );
        } catch (error) {
          return finishFailure({
            code: "recovery_unavailable",
            detailCode: "envelope_prepare_failed",
            message: errorMessage(error),
            invocationId,
            context,
          });
        }
        const authorityError = preparedMutationAuthorityError({
          expected: draft.expected,
          context,
          tool,
        });
        if (authorityError !== null) {
          return finishFailure({
            code: "recovery_protocol_fault",
            detailCode: authorityError,
            message: `prepared Bridge dispatch rejected: ${authorityError}`,
            invocationId,
            context,
          });
        }
        const prepared = await recovery.prepareMutationDispatch({
          tenantId: auth.actor.tenantId,
          attemptId,
          sessionBindingId: draft.sessionBindingId,
          connectionId: draft.connectionId,
          envelope: draft.envelope,
          expected: draft.expected,
          ...(tool.policyClass === "confirm"
            ? {
                confirmationProof: {
                  confirmToken: input.confirmation!.confirmToken,
                  originatingPreviewInvocationId:
                    input.confirmation!.originatingPreviewInvocationId,
                  commitInvocationId: invocationId,
                  binding: {
                    tenantId: auth.actor.tenantId,
                    principalKey: auth.principalKey,
                    userId: auth.actor.userId,
                    gatewaySessionId: auth.session.sessionId,
                    confirmationSessionId,
                    oauthClientId: auth.session.oauthClientId,
                    rsid: route!.rsid,
                    toolName: tool.name,
                    toolVersion: tool.version,
                    commitArgsDigest: commitArgsDigest!,
                    mutationScope: authority!.mutationScope!,
                    documentIdentity: authority!.documentIdentity,
                  },
                },
              }
            : {}),
        });
        if (
          prepared.kind !== "prepared" &&
          prepared.kind !== "already_prepared"
        ) {
          if (prepared.kind === "confirmation_rejected") {
            const status =
              prepared.reason === "expired" ? "expired" : "denied";
            await this.#emitConfirmationEvent({
              auth: auditIdentity,
              confirmationSessionId,
              status,
              tool,
              confirmationId: prepared.confirmationId,
              originatingPreviewInvocationId:
                input.confirmation!.originatingPreviewInvocationId,
              commitInvocationId: invocationId,
              commitArgsDigest,
              previewDigest:
                prepared.pendingAction?.previewDigest ?? null,
              previewRef: prepared.pendingAction?.previewRef ?? null,
              reason: prepared.reason,
            });
            return finishFailure({
              code: "confirmation_denied",
              detailCode: prepared.reason,
              message: "confirmation policy denied the request",
              invocationId,
              context,
              confirmation: {
                decision: "denied",
                confirmationId: prepared.confirmationId,
                originatingPreviewInvocationId:
                  input.confirmation!.originatingPreviewInvocationId,
                previewDigest:
                  prepared.pendingAction?.previewDigest ?? null,
                previewRef: prepared.pendingAction?.previewRef ?? null,
                commitArgsDigest,
                reason: prepared.reason,
              },
            });
          }
          if (prepared.kind === "blocked") {
            return finishFailure({
              code: "recovery_blocked",
              detailCode: prepared.reason,
              message: `durable mutation prepare blocked: ${prepared.reason}`,
              invocationId,
              context,
              recoveryHoldIds: prepared.holdIds,
            });
          }
          if (prepared.kind === "unavailable") {
            return finishFailure({
              code: "recovery_unavailable",
              detailCode: prepared.code,
              message: prepared.message,
              invocationId,
              context,
            });
          }
          return finishFailure({
            code: "recovery_protocol_fault",
            detailCode:
              prepared.kind === "protocol_fault"
                ? prepared.reason
                : "unexpected_terminal_replay",
            message:
              prepared.kind === "protocol_fault"
                ? `durable mutation prepare rejected: ${prepared.reason}`
                : "a fresh mutation collided with retained terminal identity",
            invocationId,
            context,
          });
        }

        const pending = prepared.dispatch;
        const recoveryHoldIds = pending.recoveryHoldIds;
        const recoveryResolutionIds = pending.recoveryClearances.map(
          (clearance) => clearance.resolution_id,
        );
        if (tool.policyClass === "confirm") {
          const approvalAudit = await this.#emitConfirmationEvent({
            auth: auditIdentity,
            confirmationSessionId,
            status: "approved",
            tool,
            confirmationId,
            originatingPreviewInvocationId:
              input.confirmation!.originatingPreviewInvocationId,
            commitInvocationId: invocationId,
            commitArgsDigest,
            previewDigest: null,
            previewRef: null,
            reason: null,
          });
          if (!approvalAudit.ok) {
            return finishFailure({
              code: "audit_unavailable",
              detailCode: approvalAudit.detailCode,
              message: approvalAudit.message,
              invocationId,
              context,
              confirmation: {
                decision: "confirmed",
                confirmationId,
                originatingPreviewInvocationId:
                  input.confirmation!.originatingPreviewInvocationId,
                commitArgsDigest,
                reason: "approval_audit_unavailable",
              },
            });
          }
        }
        try {
          await runWithGatewayInvocationContext(context, () =>
            executor.executePreparedMutation!(request, pending),
          );
        } catch {
          // The durable Bridge sequence/journal evidence below is authoritative.
          // A transport/parser exception cannot overwrite a persisted terminal.
        }

        const reconciled = await recovery.reconcilePendingDispatch({
          tenantId: auth.actor.tenantId,
          rsid: context.rsid,
          envelopeDigest: pending.envelopeDigest,
        });
        if (reconciled.kind === "indeterminate_recorded") {
          return finishFailure({
            code: "recovery_blocked",
            detailCode: "journal_indeterminate",
            message:
              "mutation outcome is indeterminate; durable recovery hold remains active",
            executorReached: true,
            invocationId,
            context,
            recoveryHoldIds: reconciled.installedHoldIds,
            recoveryResolutionIds,
          });
        }
        if (reconciled.kind !== "terminal_recorded") {
          if (reconciled.kind === "protocol_fault") {
            return finishFailure({
              code: "recovery_protocol_fault",
              detailCode: reconciled.reason,
              message: `durable Bridge evidence rejected: ${reconciled.reason}`,
              executorReached: true,
              invocationId,
              context,
              recoveryHoldIds,
              recoveryResolutionIds,
            });
          }
          if (reconciled.kind === "unavailable") {
            return finishFailure({
              code: "recovery_unavailable",
              detailCode: reconciled.code,
              message: reconciled.message,
              executorReached: true,
              invocationId,
              context,
              recoveryHoldIds,
              recoveryResolutionIds,
            });
          }
          return finishFailure({
            code: "recovery_unavailable",
            detailCode:
              reconciled.kind === "rejected"
                ? reconciled.reason
                : reconciled.kind,
            message:
              "executor returned before terminal Bridge evidence became durable",
            executorReached: true,
            invocationId,
            context,
            recoveryHoldIds,
            recoveryResolutionIds,
          });
        }

        const outcome = outcomeFromDurableTerminal({
          tool,
          requestId: invocationId,
          journalRecords: reconciled.terminalJournalRecords,
          batchTerminal: reconciled.terminalBatch,
        });
        return this.#finish(outcome, {
          auth: auditIdentity,
          route,
          mcpSessionId: input.mcpSessionId,
          toolName: input.toolName,
          invocationId,
          attemptId,
          startedAtMs,
          tool,
          context,
          authority,
          recoveryHoldIds: [
            ...new Set([...recoveryHoldIds, ...reconciled.clearedHoldIds]),
          ].sort(),
          recoveryResolutionIds,
          executorReached: true,
          confirmation:
            tool.policyClass === "confirm"
              ? {
                  decision: "confirmed",
                  confirmationId,
                  originatingPreviewInvocationId:
                    input.confirmation!.originatingPreviewInvocationId,
                  commitArgsDigest,
                  reason: null,
                }
              : undefined,
        });
      } finally {
        // A pending durable dispatch intentionally keeps the window fenced.
        // All pre-dispatch and terminal paths release it through the same CAS.
        await recovery.releaseInvocationWindow({
          tenantId: auth.actor.tenantId,
          rsid: route!.rsid,
          attemptId,
        });
      }
    });
  }

  /** Effect-classified non-mutating path. Never call this for a mutating registry row. */
  async #dispatchRead(
    input: GatewayDispatchRequest,
  ): Promise<GatewayDispatchOutcome> {
    const startedAtMs = this.#clock();
    const attemptId = this.#newAttemptId(startedAtMs);
    const invocationId = this.#newInvocationId(startedAtMs);
    const auth = snapshotAuthContext(input.auth);
    const confirmationSessionId = confirmationSessionIdFor(
      auth,
      input.confirmationSessionId ?? input.mcpSessionId,
    );
    let paramsDigest: string | undefined;
    try {
      if (isJsonValue(input.args)) {
        paramsDigest = makeParamsDigest(input.args as JsonValue);
      }
    } catch {
      // A non-canonical value is rejected below; no false digest is audited.
    }
    const auditBase = Object.freeze({
      auth: snapshotAuditIdentity(auth),
      mcpSessionId: input.mcpSessionId,
      toolName: input.toolName,
      invocationId,
      attemptId,
      startedAtMs,
      paramsDigest,
    });
    const tool = this.#registry.get(input.toolName);
    if (tool === undefined) {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "tool_not_found",
          message: `unknown Gateway tool: ${input.toolName}`,
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route: undefined,
        tool,
        context: undefined,
        executorReached: false,
      });
    }
    if (input.confirmation !== undefined && tool.policyClass !== "confirm") {
      await this.#emitConfirmationEvent({
        auth: auditBase.auth,
        confirmationSessionId,
        status: "denied",
        tool,
        confirmationId: confirmationIdFromToken(
          input.confirmation.confirmToken,
        ),
        originatingPreviewInvocationId:
          input.confirmation.originatingPreviewInvocationId,
        commitInvocationId: invocationId,
        commitArgsDigest: null,
        previewDigest: null,
        previewRef: null,
        reason: "confirmation_fields_not_allowed",
      });
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "confirmation_denied",
          detailCode: "confirmation_fields_not_allowed",
          message: "confirmation control is not accepted for this tool",
        },
        executorReached: false,
      };
      return this.#finish(outcome, {
        ...auditBase,
        route: undefined,
        tool,
        context: undefined,
        executorReached: false,
        confirmation: {
          decision: "denied",
          confirmationId: confirmationIdFromToken(
            input.confirmation.confirmToken,
          ),
          originatingPreviewInvocationId:
            input.confirmation.originatingPreviewInvocationId,
          reason: "confirmation_fields_not_allowed",
        },
      });
    }
    if (!isJsonObject(input.args)) {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "invalid_arguments",
          message: "tool arguments must be a finite JSON object",
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route: undefined,
        tool,
        context: undefined,
        executorReached: false,
      });
    }

    const parsedArgs = (() => {
      try {
        return z.object(tool.inputSchema).strict().safeParse(input.args);
      } catch {
        return null;
      }
    })();
    if (parsedArgs === null) {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "invalid_arguments",
          message: "registry schema validation did not complete",
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route: undefined,
        tool,
        context: undefined,
        executorReached: false,
      });
    }
    if (!parsedArgs.success || !isJsonObject(parsedArgs.data)) {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "invalid_arguments",
          message: "tool arguments do not match the registry schema",
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route: undefined,
        tool,
        context: undefined,
        executorReached: false,
      });
    }
    const parsedJsonArgs: GatewayJsonObject = parsedArgs.data;
    try {
      paramsDigest = makeParamsDigest(parsedJsonArgs as JsonValue);
    } catch {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "invalid_arguments",
          message: "tool arguments cannot be canonically digested",
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route: undefined,
        tool,
        context: undefined,
        executorReached: false,
      });
    }

    let route: GatewayInvocationRoute;
    try {
      route = snapshotInvocationRoute(await input.resolveRoute(auth));
    } catch (error) {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "invalid_invocation_context",
          detailCode: "route_resolution_failed",
          message: errorMessage(error),
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route: undefined,
        tool,
        context: undefined,
        paramsDigest,
        executorReached: false,
      });
    }

    let context: GatewayInvocationContext;
    try {
      context = createGatewayInvocationContext({
        auth,
        route,
        mcpSessionId: input.mcpSessionId,
        invocationId,
        toolName: tool.name,
        toolVersion: tool.version,
        policyClass: tool.policyClass,
        mutationScopePolicy: tool.mutationScopePolicy,
        executor: tool.executor,
        args: parsedJsonArgs,
        startedAtMs,
      });
    } catch (error) {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "invalid_invocation_context",
          ...(error instanceof GatewayInvocationContextError
            ? { detailCode: error.code }
            : {}),
          message: errorMessage(error),
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route,
        tool,
        context: undefined,
        paramsDigest,
        executorReached: false,
      });
    }

    if (tool.policyClass !== "auto") {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "policy_enforcement_unavailable",
          message: `policy middleware is not available for ${tool.policyClass} tools`,
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route,
        tool,
        context,
        executorReached: false,
      });
    }

    const executor = this.#executors.get(tool.executor);
    if (executor === undefined) {
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: invocationId,
        error: {
          code: "executor_unavailable",
          message: `executor binding is unavailable: ${tool.executor}`,
        },
      };
      return this.#finish(outcome, {
        ...auditBase,
        route,
        tool,
        context,
        executorReached: false,
      });
    }

    return this.#serialize(context.rsid, async () => {
      const recovery = this.#recoveryAuthority;
      const window = await recovery.acquireInvocationWindow({
        tenantId: auth.actor.tenantId,
        rsid: context.rsid,
        attemptId,
      });
      if (
        window.kind === "blocked" ||
        window.kind === "protocol_fault" ||
        window.kind === "unavailable"
      ) {
        const outcome: GatewayDispatchOutcome = {
          ok: false,
          state: "failed",
          toolName: input.toolName,
          requestId: invocationId,
          error:
            window.kind === "blocked"
              ? {
                  code: "recovery_blocked",
                  detailCode: "dispatch_window_active",
                  message: `another invocation owns the durable rsid window: ${window.activeAttemptId}`,
                }
              : window.kind === "protocol_fault"
                ? {
                    code: "recovery_protocol_fault",
                    detailCode: window.reason,
                    message: `durable invocation window rejected: ${window.reason}`,
                  }
                : {
                    code: "recovery_unavailable",
                    detailCode: window.code,
                    message: window.message,
                  },
        };
        return this.#finish(outcome, {
          ...auditBase,
          route,
          tool,
          context,
          executorReached: false,
        });
      }

      try {
        let outcome: GatewayDispatchOutcome;
        try {
          const executorOutcome: unknown =
            await runWithGatewayInvocationContext(context, () =>
              executor.execute({
                toolName: tool.name,
                toolVersion: tool.version,
                executorMethod: tool.executorMethod,
                policyClass: tool.policyClass,
                mutationScopePolicy: tool.mutationScopePolicy,
                args: parsedJsonArgs,
                context,
              }),
            );
          outcome = normalizeExecutorOutcome({
            tool,
            requestId: invocationId,
            executorOutcome,
            threw: false,
          });
        } catch (error) {
          outcome = normalizeExecutorOutcome({
            tool,
            requestId: invocationId,
            executorError: error,
            threw: true,
          });
        }

        return this.#finish(outcome, {
          ...auditBase,
          route,
          tool,
          context,
          executorReached: true,
        });
      } finally {
        await recovery.releaseInvocationWindow({
          tenantId: auth.actor.tenantId,
          rsid: context.rsid,
          attemptId,
        });
      }
    });
  }

  async #serialize<T>(rsid: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#rsidTails.get(rsid) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#rsidTails.set(rsid, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#rsidTails.get(rsid) === tail) {
        this.#rsidTails.delete(rsid);
      }
    }
  }

  async #emitConfirmationEvent(input: {
    readonly auth: DispatchAuditIdentity;
    readonly confirmationSessionId: string;
    readonly status: "requested" | "approved" | "denied" | "expired";
    readonly tool: GatewayToolRecord;
    readonly confirmationId: string | null;
    readonly originatingPreviewInvocationId: string | null;
    readonly commitInvocationId: string | null;
    readonly commitArgsDigest: `sha256:${string}` | null;
    readonly previewDigest: `sha256:${string}` | null;
    readonly previewRef: string | null;
    readonly reason: string | null;
  }): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly detailCode: string;
        readonly message: string;
      }
  > {
    const recordedAtMs = this.#clock();
    this.#eventSequence += 1;
    const recordedAt = new Date(recordedAtMs).toISOString();
    const event: GatewayEventEnvelope = Object.freeze({
      schema: REVAGENT_EVENT_SCHEMA,
      event_id: this.#newEventId(recordedAtMs),
      event_type: "tool.confirmation",
      occurred_at: recordedAt,
      recorded_at: recordedAt,
      tenant_id: input.auth.actor.tenantId,
      source: this.#eventSource,
      actor: Object.freeze({
        type: "user" as const,
        user_id: input.auth.actor.userId,
      }),
      session_id: input.auth.session.sessionId,
      seq: this.#eventSequence,
      payload: Object.freeze({
        invocation_id:
          input.commitInvocationId ?? input.originatingPreviewInvocationId,
        state: input.status,
        confirmation_id: input.confirmationId,
        originating_preview_invocation_id:
          input.originatingPreviewInvocationId,
        commit_invocation_id: input.commitInvocationId,
        principal_key: input.auth.principalKey,
        actor_role: input.auth.actor.role,
        gateway_session_id: input.auth.session.sessionId,
        mcp_session_id: input.confirmationSessionId,
        confirmation_session_id: input.confirmationSessionId,
        oauth_client_id: input.auth.session.oauthClientId,
        tool_name: input.tool.name,
        tool_version: input.tool.version,
        commit_args_digest: input.commitArgsDigest,
        preview_digest: input.previewDigest,
        preview_ref: input.previewRef,
        reason: input.reason,
        recorded_at_ms: recordedAtMs,
      }),
    });
    try {
      const emitted = await this.#eventSink.emit(event);
      return emitted.ok
        ? Object.freeze({ ok: true as const })
        : Object.freeze({
            ok: false as const,
            detailCode: `${emitted.port}:${emitted.code}`,
            message: errorMessage(emitted.message),
          });
    } catch (error) {
      return Object.freeze({
        ok: false as const,
        detailCode: "event_sink:emit_exception",
        message: errorMessage(error),
      });
    }
  }

  async #finish(
    outcome: GatewayDispatchOutcome,
    input: DispatchAuditInput,
  ): Promise<GatewayDispatchOutcome> {
    const completedAtMs = this.#clock();
    this.#eventSequence += 1;
    const occurredAt = new Date(completedAtMs).toISOString();
    const payload: GatewayJsonObject = Object.freeze({
      dispatch_attempt_id: input.attemptId ?? outcome.requestId,
      invocation_id: input.invocationId,
      idempotency_key: input.context?.idempotencyKey ?? null,
      principal_key: input.context?.principalKey ?? input.auth.principalKey,
      actor_role: input.context?.actor.role ?? input.auth.actor.role,
      gateway_session_id:
        input.context?.gatewaySessionId ?? input.auth.session.sessionId,
      oauth_client_id:
        input.context?.oauthClientId ?? input.auth.session.oauthClientId,
      mcp_session_id: input.context?.mcpSessionId ?? input.mcpSessionId,
      rsid: input.context?.rsid ?? input.route?.rsid ?? null,
      tool_name: input.toolName,
      tool_version: input.context?.toolVersion ?? input.tool?.version ?? null,
      policy_class:
        input.context?.policyClass ?? input.tool?.policyClass ?? null,
      policy_decision:
        input.context?.policyDecision ?? input.confirmation?.decision ?? null,
      confirmation_id:
        input.context?.confirmationId ??
        input.confirmation?.confirmationId ??
        null,
      originating_preview_invocation_id:
        input.context?.originatingPreviewInvocationId ??
        input.confirmation?.originatingPreviewInvocationId ??
        null,
      preview_digest: input.confirmation?.previewDigest ?? null,
      preview_ref: input.confirmation?.previewRef ?? null,
      commit_args_digest: input.confirmation?.commitArgsDigest ?? null,
      confirmation_reason: input.confirmation?.reason ?? null,
      mutation_scope_policy:
        input.context?.mutationScopePolicy ??
        input.authority?.mutationScopePolicy ??
        input.tool?.mutationScopePolicy ??
        null,
      mutating: input.context?.mutating ?? input.authority?.mutating ?? null,
      executor: input.context?.executor ?? input.tool?.executor ?? null,
      document_identity: documentIdentityPayload(
        input.context,
        input.authority,
      ),
      params_digest: input.context?.paramsDigest ?? input.paramsDigest ?? null,
      mutation_scope: mutationScopePayload(input.context, input.authority),
      recovery_hold_ids: input.recoveryHoldIds ?? [],
      recovery_resolution_ids: input.recoveryResolutionIds ?? [],
      outcome: outcome.state,
      outcome_error_code: outcome.ok ? null : outcome.error.code,
      executor_reached: input.executorReached,
      started_at_ms: input.startedAtMs,
      completed_at_ms: completedAtMs,
      duration_ms: Math.max(0, completedAtMs - input.startedAtMs),
    });
    const event: GatewayEventEnvelope = Object.freeze({
      schema: REVAGENT_EVENT_SCHEMA,
      event_id: this.#newEventId(completedAtMs),
      event_type: "tool.invocation",
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      tenant_id: input.context?.actor.tenantId ?? input.auth.actor.tenantId,
      source: this.#eventSource,
      actor: Object.freeze({
        type: "user" as const,
        user_id: input.context?.actor.userId ?? input.auth.actor.userId,
      }),
      session_id:
        input.context?.gatewaySessionId ?? input.auth.session.sessionId,
      seq: this.#eventSequence,
      payload,
    });

    try {
      const emitted = await this.#eventSink.emit(event);
      if (emitted.ok) {
        return outcome;
      }
      if (input.context?.mutating === true && input.executorReached) {
        return {
          ...outcome,
          auditDelivery: "unavailable",
          auditError: {
            detailCode: `${emitted.port}:${emitted.code}`,
            message: errorMessage(emitted.message),
          },
        };
      }
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: outcome.requestId,
        executorReached: input.executorReached,
        error: {
          code: "audit_unavailable",
          detailCode: `${emitted.port}:${emitted.code}`,
          message: errorMessage(emitted.message),
        },
      };
    } catch (error) {
      if (input.context?.mutating === true && input.executorReached) {
        return {
          ...outcome,
          auditDelivery: "unavailable",
          auditError: {
            detailCode: "event_sink:emit_exception",
            message: errorMessage(error),
          },
        };
      }
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: outcome.requestId,
        executorReached: input.executorReached,
        error: {
          code: "audit_unavailable",
          detailCode: "event_sink:emit_exception",
          message: errorMessage(error),
        },
      };
    }
  }
}
