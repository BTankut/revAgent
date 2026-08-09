import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { AuthContext } from "./authContext.js";
import {
  REVAGENT_EVENT_SCHEMA,
  type GatewayEventEnvelope,
  type GatewayEventSink,
} from "./events.js";
import {
  createGatewayInvocationContext,
  GatewayInvocationContextError,
  runWithGatewayInvocationContext,
  type GatewayInvocationContext,
  type GatewayInvocationRoute,
} from "./invocationContext.js";
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
  readonly args: GatewayJsonObject;
  readonly context: GatewayInvocationContext;
}

export interface GatewayExecutor {
  readonly binding: GatewayExecutorBinding;
  execute(request: GatewayExecutorRequest): Promise<GatewayExecutorOutcome>;
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
          | "audit_unavailable";
        readonly message: string;
        readonly executorCode?: string;
        readonly detailCode?: string;
      };
      readonly executorReached?: boolean;
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
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isJsonValue(value)
  );
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

export interface GatewayDispatcherOptions {
  readonly eventSink: GatewayEventSink;
  readonly eventSource: GatewayEventEnvelope["source"];
  readonly clock?: () => number;
  readonly newInvocationId?: () => string;
  readonly newEventId?: () => string;
}

interface DispatchAuditInput {
  readonly auth: DispatchAuditIdentity;
  readonly route: GatewayInvocationRoute | undefined;
  readonly mcpSessionId: string;
  readonly toolName: string;
  readonly invocationId: string;
  readonly startedAtMs: number;
  readonly tool: GatewayToolRecord | undefined;
  readonly context: GatewayInvocationContext | undefined;
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

function gatewayUuidV7(timestampMs: number): string {
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    timestampMs >= 2 ** 48
  ) {
    throw new TypeError("UUIDv7 timestamp must be a non-negative 48-bit integer");
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(timestampMs, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function documentIdentityPayload(
  context: GatewayInvocationContext | undefined,
): GatewayJsonValue {
  const identity = context?.documentIdentity;
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
): GatewayJsonValue {
  const scope = context?.mutationScope;
  if (scope === undefined || scope === null) {
    return null;
  }
  return scope.kind === "session"
    ? { kind: scope.kind }
    : { kind: scope.kind, document_id: scope.document_id };
}

export class GatewayDispatcher {
  readonly #registry: GatewayToolRegistry;
  readonly #executors: ReadonlyMap<GatewayExecutorBinding, GatewayExecutor>;
  readonly #eventSink: GatewayEventSink;
  readonly #eventSource: GatewayEventEnvelope["source"];
  readonly #clock: () => number;
  readonly #newInvocationId: (timestampMs: number) => string;
  readonly #newEventId: (timestampMs: number) => string;
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
    const configuredEventId = options.newEventId;
    this.#newInvocationId =
      configuredInvocationId === undefined
        ? gatewayUuidV7
        : () => configuredInvocationId();
    this.#newEventId =
      configuredEventId === undefined
        ? gatewayUuidV7
        : () => configuredEventId();
  }

  public registry(): GatewayToolRegistry {
    return this.#registry;
  }

  public async dispatch(input: {
    readonly toolName: string;
    readonly args: unknown;
    readonly auth: AuthContext;
    readonly mcpSessionId: string;
    readonly resolveRoute: (auth: AuthContext) =>
      | GatewayInvocationRoute
      | Promise<GatewayInvocationRoute>;
  }): Promise<GatewayDispatchOutcome> {
    const startedAtMs = this.#clock();
    const invocationId = this.#newInvocationId(startedAtMs);
    const auth = snapshotAuthContext(input.auth);
    const auditBase = Object.freeze({
      auth: snapshotAuditIdentity(auth),
      mcpSessionId: input.mcpSessionId,
      toolName: input.toolName,
      invocationId,
      startedAtMs,
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

    let route: GatewayInvocationRoute;
    try {
      route = await input.resolveRoute(auth);
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
          message:
            `policy middleware is not available for ${tool.policyClass} tools`,
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
      let outcome: GatewayDispatchOutcome;
      try {
        const executorOutcome: unknown = await runWithGatewayInvocationContext(
          context,
          () =>
            executor.execute({
              toolName: tool.name,
              toolVersion: tool.version,
              executorMethod: tool.executorMethod,
              policyClass: tool.policyClass,
              args: parsedJsonArgs,
              context,
            }),
        );
        if (!isJsonObject(executorOutcome)) {
          outcome = invalidExecutorResult({
            toolName: input.toolName,
            requestId: invocationId,
            message: "executor returned a non-object outcome",
          });
        } else if (executorOutcome.state === "failed") {
          const failure = executorOutcome.error;
          if (
            !isJsonObject(failure) ||
            typeof failure.code !== "string" ||
            failure.code.length < 1 ||
            typeof failure.message !== "string" ||
            failure.message.length < 1
          ) {
            outcome = invalidExecutorResult({
              toolName: input.toolName,
              requestId: invocationId,
              message: "executor returned an invalid failure outcome",
            });
          } else {
            outcome = {
              ok: false,
              state: "failed",
              toolName: input.toolName,
              requestId: invocationId,
              error: {
                code: "executor_failed",
                executorCode: failure.code.slice(0, 120),
                message: failure.message
                  .replace(/[\r\n]+/gu, " ")
                  .slice(0, 600),
              },
            };
          }
        } else if (
          executorOutcome.state !== "completed" &&
          executorOutcome.state !== "guarded"
        ) {
          outcome = invalidExecutorResult({
            toolName: input.toolName,
            requestId: invocationId,
            message: "executor returned an unknown outcome state",
          });
        } else if (!isJsonValue(executorOutcome.result)) {
          outcome = invalidExecutorResult({
            toolName: input.toolName,
            requestId: invocationId,
            message: "executor returned a non-JSON result",
          });
        } else if (executorOutcome.state === "guarded") {
          const guardedReason = executorOutcome.reason;
          outcome =
            typeof guardedReason !== "string" ||
            guardedReason.length < 1 ||
            guardedReason.length > 600
              ? invalidExecutorResult({
                  toolName: input.toolName,
                  requestId: invocationId,
                  message: "executor returned an invalid guarded outcome",
                })
              : {
                  ok: true,
                  state: "guarded",
                  toolName: tool.name,
                  toolVersion: tool.version,
                  executor: tool.executor,
                  requestId: invocationId,
                  guardedReason,
                  result: executorOutcome.result,
                };
        } else {
          outcome = {
            ok: true,
            state: "completed",
            toolName: tool.name,
            toolVersion: tool.version,
            executor: tool.executor,
            requestId: invocationId,
            result: executorOutcome.result,
          };
        }
      } catch (error) {
        outcome = {
          ok: false,
          state: "failed",
          toolName: input.toolName,
          requestId: invocationId,
          error: {
            code: "executor_failed",
            message: errorMessage(error),
          },
        };
      }

      return this.#finish(outcome, {
        ...auditBase,
        route,
        tool,
        context,
        executorReached: true,
      });
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
      executor: input.context?.executor ?? input.tool?.executor ?? null,
      document_identity: documentIdentityPayload(input.context),
      params_digest: input.context?.paramsDigest ?? null,
      mutation_scope: mutationScopePayload(input.context),
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
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: input.invocationId,
        executorReached: input.executorReached,
        error: {
          code: "audit_unavailable",
          detailCode: `${emitted.port}:${emitted.code}`,
          message: errorMessage(emitted.message),
        },
      };
    } catch (error) {
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId: input.invocationId,
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
