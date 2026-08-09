import {
  journalRecordIsIntact,
  makeParamsDigest,
  type InvocationJournalRecord,
  type JsonValue,
} from "@revagent/protocol";
import { z } from "zod";

import type { AuthContext } from "./authContext.js";
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

export interface GatewayExecutor {
  readonly binding: GatewayExecutorBinding;
  execute(request: GatewayExecutorRequest): Promise<GatewayExecutorOutcome>;
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
      binding.policy.decision !== "auto" ||
      binding.policy.confirmation_id !== null ||
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
  }

  public registry(): GatewayToolRegistry {
    return this.#registry;
  }

  public async dispatch(input: {
    readonly toolName: string;
    readonly args: unknown;
    readonly auth: AuthContext;
    readonly mcpSessionId: string;
    readonly resolveRoute: (
      auth: AuthContext,
    ) => GatewayInvocationRoute | Promise<GatewayInvocationRoute>;
  }): Promise<GatewayDispatchOutcome> {
    const tool = this.#registry.get(input.toolName);
    return tool?.mutationScopePolicy === "session" ||
      tool?.mutationScopePolicy === "document"
      ? this.#dispatchMutation(input, tool)
      : this.#dispatchRead(input);
  }

  async #dispatchMutation(
    input: {
      readonly toolName: string;
      readonly args: unknown;
      readonly auth: AuthContext;
      readonly mcpSessionId: string;
      readonly resolveRoute: (
        auth: AuthContext,
      ) => GatewayInvocationRoute | Promise<GatewayInvocationRoute>;
    },
    tool: GatewayToolRecord,
  ): Promise<GatewayDispatchOutcome> {
    const startedAtMs = this.#clock();
    const attemptId = this.#newAttemptId(startedAtMs);
    const auth = snapshotAuthContext(input.auth);
    const auditIdentity = snapshotAuditIdentity(auth);
    let route: GatewayInvocationRoute | undefined;
    let authority: GatewayInvocationAuthority | undefined;
    let paramsDigest: string | undefined;
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
    }): Promise<GatewayDispatchOutcome> => {
      const requestId = failure.invocationId ?? attemptId;
      const outcome: GatewayDispatchOutcome = {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        ...(failure.executorReached === undefined
          ? {}
          : { executorReached: failure.executorReached }),
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
    if (parsedArgs === null) {
      return finishFailure({
        code: "invalid_arguments",
        message: "registry schema validation did not complete",
      });
    }
    if (!parsedArgs.success || !isJsonObject(parsedArgs.data)) {
      return finishFailure({
        code: "invalid_arguments",
        message: "tool arguments do not match the registry schema",
      });
    }
    const parsedJsonArgs: GatewayJsonObject = parsedArgs.data;
    try {
      paramsDigest = makeParamsDigest(parsedJsonArgs as JsonValue);
    } catch {
      return finishFailure({
        code: "invalid_arguments",
        message: "tool arguments cannot be canonically digested",
      });
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
    if (tool.policyClass !== "auto") {
      return finishFailure({
        code: "policy_enforcement_unavailable",
        message: `policy middleware is not available for ${tool.policyClass} tools`,
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
        });
        if (
          prepared.kind !== "prepared" &&
          prepared.kind !== "already_prepared"
        ) {
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
  async #dispatchRead(input: {
    readonly toolName: string;
    readonly args: unknown;
    readonly auth: AuthContext;
    readonly mcpSessionId: string;
    readonly resolveRoute: (
      auth: AuthContext,
    ) => GatewayInvocationRoute | Promise<GatewayInvocationRoute>;
  }): Promise<GatewayDispatchOutcome> {
    const startedAtMs = this.#clock();
    const attemptId = this.#newAttemptId(startedAtMs);
    const invocationId = this.#newInvocationId(startedAtMs);
    const auth = snapshotAuthContext(input.auth);
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
