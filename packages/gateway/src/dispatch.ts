import { randomUUID } from "node:crypto";

import { z } from "zod";

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

export interface GatewayInvocationContext {
  readonly requestId: string;
  readonly principalKey: string;
  readonly oauthClientId: string;
  readonly mcpSessionId: string;
}

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
          | "invalid_executor_result";
        readonly message: string;
        readonly executorCode?: string;
      };
    };

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

export class GatewayDispatcher {
  readonly #registry: GatewayToolRegistry;
  readonly #executors: ReadonlyMap<GatewayExecutorBinding, GatewayExecutor>;

  public constructor(
    registry: GatewayToolRegistry,
    executors: readonly GatewayExecutor[],
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
  }

  public registry(): GatewayToolRegistry {
    return this.#registry;
  }

  public async dispatch(input: {
    readonly toolName: string;
    readonly args: unknown;
    readonly principalKey: string;
    readonly oauthClientId: string;
    readonly mcpSessionId: string;
  }): Promise<GatewayDispatchOutcome> {
    const requestId = randomUUID();
    const tool = this.#registry.get(input.toolName);
    if (tool === undefined) {
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        error: {
          code: "tool_not_found",
          message: `unknown Gateway tool: ${input.toolName}`,
        },
      };
    }
    if (!isJsonObject(input.args)) {
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        error: {
          code: "invalid_arguments",
          message: "tool arguments must be a finite JSON object",
        },
      };
    }
    if (tool.policyClass !== "auto") {
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        error: {
          code: "policy_enforcement_unavailable",
          message:
            `policy middleware is not available for ${tool.policyClass} tools`,
        },
      };
    }

    const parsedArgs = (() => {
      try {
        return z.object(tool.inputSchema).strict().safeParse(input.args);
      } catch {
        return null;
      }
    })();
    if (parsedArgs === null) {
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        error: {
          code: "invalid_arguments",
          message: "registry schema validation did not complete",
        },
      };
    }
    if (!parsedArgs.success || !isJsonObject(parsedArgs.data)) {
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        error: {
          code: "invalid_arguments",
          message: "tool arguments do not match the registry schema",
        },
      };
    }

    const executor = this.#executors.get(tool.executor);
    if (executor === undefined) {
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        error: {
          code: "executor_unavailable",
          message: `executor binding is unavailable: ${tool.executor}`,
        },
      };
    }

    try {
      const executorOutcome: unknown = await executor.execute({
        toolName: tool.name,
        toolVersion: tool.version,
        executorMethod: tool.executorMethod,
        policyClass: tool.policyClass,
        args: parsedArgs.data,
        context: {
          requestId,
          principalKey: input.principalKey,
          oauthClientId: input.oauthClientId,
          mcpSessionId: input.mcpSessionId,
        },
      });
      if (!isJsonObject(executorOutcome)) {
        return invalidExecutorResult({
          toolName: input.toolName,
          requestId,
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
            toolName: input.toolName,
            requestId,
            message: "executor returned an invalid failure outcome",
          });
        }
        return {
          ok: false,
          state: "failed",
          toolName: input.toolName,
          requestId,
          error: {
            code: "executor_failed",
            executorCode: failure.code.slice(0, 120),
            message: failure.message
              .replace(/[\r\n]+/gu, " ")
              .slice(0, 600),
          },
        };
      }
      if (
        executorOutcome.state !== "completed" &&
        executorOutcome.state !== "guarded"
      ) {
        return invalidExecutorResult({
          toolName: input.toolName,
          requestId,
          message: "executor returned an unknown outcome state",
        });
      }
      if (!isJsonValue(executorOutcome.result)) {
        return invalidExecutorResult({
          toolName: input.toolName,
          requestId,
          message: "executor returned a non-JSON result",
        });
      }
      if (executorOutcome.state === "guarded") {
        const guardedReason = executorOutcome.reason;
        if (
          typeof guardedReason !== "string" ||
          guardedReason.length < 1 ||
          guardedReason.length > 600
        ) {
          return invalidExecutorResult({
            toolName: input.toolName,
            requestId,
            message: "executor returned an invalid guarded outcome",
          });
        }
        return {
          ok: true,
          state: "guarded",
          toolName: tool.name,
          toolVersion: tool.version,
          executor: tool.executor,
          requestId,
          guardedReason,
          result: executorOutcome.result,
        };
      }
      return {
        ok: true,
        state: "completed",
        toolName: tool.name,
        toolVersion: tool.version,
        executor: tool.executor,
        requestId,
        result: executorOutcome.result,
      };
    } catch (error) {
      return {
        ok: false,
        state: "failed",
        toolName: input.toolName,
        requestId,
        error: {
          code: "executor_failed",
          message: errorMessage(error),
        },
      };
    }
  }
}
