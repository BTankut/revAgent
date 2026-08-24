import { makeParamsDigest, type JsonValue } from "@revagent/protocol";
import { z, type ZodRawShape } from "zod";

import type {
  GatewayJsonObject,
  GatewayJsonValue,
} from "./dispatch.js";
import type {
  GatewayJsonSchema,
  GatewayToolRecord,
} from "./registry.js";

export const GATEWAY_CONFIRM_TOKEN_FIELD = "confirm_token" as const;
export const GATEWAY_PREVIEW_INVOCATION_FIELD =
  "originating_preview_invocation_id" as const;

const TOKEN_MAX_LENGTH = 512;
const INVOCATION_ID_MAX_LENGTH = 512;
const COMMIT_MODE_METHODS = new Set([
  "delete_review_view",
  "set_element_parameter",
  "set_schedule_cells",
  "set_schedule_cells_by_text",
  "execute_batch",
]);
const RAW_CODE_SAFE_PREVIEW_FIELDS = new Set([
  "target",
  "host",
  "port",
  "taskName",
  "taskId",
  "parentTaskName",
  "parentTaskId",
  "code",
  "timeoutMs",
  "parseJsonResult",
]);

export interface GatewayConfirmationControl {
  readonly confirmToken: string;
  readonly originatingPreviewInvocationId: string;
}

export class GatewayConfirmationControlError extends Error {
  public constructor(
    public readonly code:
      | "confirmation_fields_incomplete"
      | "confirmation_fields_not_allowed",
    message: string,
  ) {
    super(message);
    this.name = "GatewayConfirmationControlError";
  }
}

export type GatewayConfirmationPreviewProjection =
  | {
      readonly ok: true;
      readonly previewArgs: GatewayJsonObject;
      readonly previewExecutorMethod: string;
      readonly commitArgs: GatewayJsonObject;
      readonly commitArgsDigest: `sha256:${string}`;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "direct_commit_without_confirmation"
        | "confirmation_preview_strategy_unavailable"
        | "confirmation_preview_parameters_unsupported";
    };

export type GatewayConfirmationCommitProjection =
  | {
      readonly ok: true;
      readonly commitArgs: GatewayJsonObject;
      readonly commitArgsDigest: `sha256:${string}`;
    }
  | {
      readonly ok: false;
      readonly reason: "confirmation_commit_mode_required";
    };

function jsonObjectWith(
  value: GatewayJsonObject,
  updates: Readonly<Record<string, GatewayJsonValue | undefined>>,
): GatewayJsonObject {
  const next: Record<string, GatewayJsonValue> = structuredClone(value);
  for (const [key, member] of Object.entries(updates)) {
    if (member === undefined) {
      delete next[key];
    } else {
      next[key] = member;
    }
  }
  return Object.freeze(next);
}

function digestArgs(args: GatewayJsonObject): `sha256:${string}` {
  return makeParamsDigest(args as JsonValue);
}

function usesCommitMode(tool: GatewayToolRecord): boolean {
  return COMMIT_MODE_METHODS.has(tool.executorMethod);
}

function usesModeFlag(tool: GatewayToolRecord): boolean {
  return tool.executorMethod !== "execute_batch" && usesCommitMode(tool);
}

/**
 * Produces the only preview and commit projections trusted by the dispatcher.
 * The caller's phase flags are never forwarded across phases.
 */
export function buildConfirmationPreviewProjection(
  tool: GatewayToolRecord,
  parsedArgs: GatewayJsonObject,
): GatewayConfirmationPreviewProjection {
  if (usesModeFlag(tool) && parsedArgs.mode === "commit") {
    return Object.freeze({
      ok: false as const,
      reason: "direct_commit_without_confirmation" as const,
    });
  }

  if (tool.executorMethod === "send_code_to_revit") {
    if (tool.name === "conformance.fixture.c28_mutation") {
      return Object.freeze({
        ok: true as const,
        previewArgs: Object.freeze({}),
        previewExecutorMethod: "get_ui_state",
        commitArgs: Object.freeze(structuredClone(parsedArgs)),
        commitArgsDigest: digestArgs(parsedArgs),
      });
    }
    const commitArgs = Object.freeze(structuredClone(parsedArgs));
    const previewBase: Record<string, GatewayJsonValue> = {};
    for (const [name, value] of Object.entries(parsedArgs)) {
      if (RAW_CODE_SAFE_PREVIEW_FIELDS.has(name)) {
        previewBase[name] = structuredClone(value);
      }
    }
    if (parsedArgs.parameters !== undefined) {
      if (
        !Array.isArray(parsedArgs.parameters) ||
        parsedArgs.parameters.some(
          (value) =>
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean",
        )
      ) {
        return Object.freeze({
          ok: false as const,
          reason: "confirmation_preview_parameters_unsupported" as const,
        });
      }
      previewBase.parameters = structuredClone(parsedArgs.parameters);
    }
    const previewArgs = jsonObjectWith(Object.freeze(previewBase), {
      intent: "writePreview",
      transactionMode: "none",
    });
    return Object.freeze({
      ok: true as const,
      previewArgs,
      previewExecutorMethod: "send_code_to_revit_safe",
      commitArgs,
      commitArgsDigest: digestArgs(commitArgs),
    });
  }

  // Atomic batches have no wire-level dry-run field. Their preview is the
  // existing read-only UI probe; commit retains the exact signed batch args.
  // This keeps the public confirm protocol while never sending a batch before
  // the confirmation authority grants its single-use token.
  if (tool.executorMethod === "execute_batch") {
    return Object.freeze({
      ok: true as const,
      previewArgs: Object.freeze({}),
      previewExecutorMethod: "get_ui_state",
      commitArgs: Object.freeze(structuredClone(parsedArgs)),
      commitArgsDigest: digestArgs(parsedArgs),
    });
  }

  if (!usesCommitMode(tool)) {
    return Object.freeze({
      ok: false as const,
      reason: "confirmation_preview_strategy_unavailable" as const,
    });
  }

  const previewArgs = jsonObjectWith(parsedArgs, {
    mode: "dryRun",
    ...(tool.executorMethod === "delete_review_view"
      ? { confirmDelete: false }
      : {}),
  });
  const commitArgs = jsonObjectWith(parsedArgs, {
    mode: "commit",
    ...(tool.executorMethod === "delete_review_view"
      ? { confirmDelete: true }
      : {}),
  });
  return Object.freeze({
    ok: true as const,
    previewArgs,
    previewExecutorMethod: tool.executorMethod,
    commitArgs,
    commitArgsDigest: digestArgs(commitArgs),
  });
}

export function buildConfirmationCommitProjection(
  tool: GatewayToolRecord,
  parsedArgs: GatewayJsonObject,
): GatewayConfirmationCommitProjection {
  if (
    usesModeFlag(tool) &&
    (parsedArgs.mode !== "commit" ||
      (tool.executorMethod === "delete_review_view" &&
        parsedArgs.confirmDelete !== true))
  ) {
    return Object.freeze({
      ok: false as const,
      reason: "confirmation_commit_mode_required" as const,
    });
  }
  const commitArgs = Object.freeze(structuredClone(parsedArgs));
  return Object.freeze({
    ok: true as const,
    commitArgs,
    commitArgsDigest: digestArgs(commitArgs),
  });
}

function confirmationControlShape(): ZodRawShape {
  return {
    [GATEWAY_CONFIRM_TOKEN_FIELD]: z
      .string()
      .min(1)
      .max(TOKEN_MAX_LENGTH)
      .describe(
        "Gateway-issued single-use confirmation token. Supply only when re-invoking this exact previewed action.",
      )
      .optional(),
    [GATEWAY_PREVIEW_INVOCATION_FIELD]: z
      .string()
      .min(1)
      .max(INVOCATION_ID_MAX_LENGTH)
      .describe(
        "Immutable invocation id returned by the originating Gateway preview.",
      )
      .optional(),
  };
}

function confirmationDependentRequired() {
  return Object.freeze({
    [GATEWAY_CONFIRM_TOKEN_FIELD]: Object.freeze([
      GATEWAY_PREVIEW_INVOCATION_FIELD,
    ]),
    [GATEWAY_PREVIEW_INVOCATION_FIELD]: Object.freeze([
      GATEWAY_CONFIRM_TOKEN_FIELD,
    ]),
  });
}

/** Client schema only; functional handler and registry schemas stay frozen. */
export function gatewayExternalToolInputSchema(
  tool: GatewayToolRecord,
) {
  const shape =
    tool.policyClass === "confirm"
      ? { ...tool.inputSchema, ...confirmationControlShape() }
      : tool.inputSchema;
  const schema = z
    .object(shape)
    .strict()
    .superRefine((value, context) => {
      const hasToken = GATEWAY_CONFIRM_TOKEN_FIELD in value;
      const hasPreview = GATEWAY_PREVIEW_INVOCATION_FIELD in value;
      if (hasToken !== hasPreview) {
        context.addIssue({
          code: "custom",
          message:
            "confirm_token and originating_preview_invocation_id must be supplied together",
        });
      }
    });
  return tool.policyClass === "confirm"
    ? schema.meta({ dependentRequired: confirmationDependentRequired() })
    : schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON Schema companion used by deferred Mode-A schema activation. */
export function gatewayExternalToolInputJsonSchema(
  tool: GatewayToolRecord,
): GatewayJsonSchema {
  if (tool.policyClass !== "confirm") {
    return tool.inputJsonSchema;
  }
  const properties = isRecord(tool.inputJsonSchema.properties)
    ? tool.inputJsonSchema.properties
    : {};
  return Object.freeze({
    ...tool.inputJsonSchema,
    properties: Object.freeze({
      ...properties,
      [GATEWAY_CONFIRM_TOKEN_FIELD]: Object.freeze({
        description:
          "Gateway-issued single-use confirmation token. Supply only when re-invoking this exact previewed action.",
        maxLength: TOKEN_MAX_LENGTH,
        minLength: 1,
        type: "string",
      }),
      [GATEWAY_PREVIEW_INVOCATION_FIELD]: Object.freeze({
        description:
          "Immutable invocation id returned by the originating Gateway preview.",
        maxLength: INVOCATION_ID_MAX_LENGTH,
        minLength: 1,
        type: "string",
      }),
    }),
    dependentRequired: confirmationDependentRequired(),
  });
}

export function splitGatewayConfirmationArguments(
  tool: GatewayToolRecord,
  value: Readonly<Record<string, unknown>>,
): {
  readonly args: Readonly<Record<string, unknown>>;
  readonly confirmation?: GatewayConfirmationControl;
} {
  const hasToken = Object.hasOwn(value, GATEWAY_CONFIRM_TOKEN_FIELD);
  const hasPreview = Object.hasOwn(value, GATEWAY_PREVIEW_INVOCATION_FIELD);
  if (hasToken !== hasPreview) {
    throw new GatewayConfirmationControlError(
      "confirmation_fields_incomplete",
      "confirmation control fields must be supplied together",
    );
  }
  if ((hasToken || hasPreview) && tool.policyClass !== "confirm") {
    throw new GatewayConfirmationControlError(
      "confirmation_fields_not_allowed",
      "confirmation control fields are accepted only for confirm-class tools",
    );
  }

  const args: Record<string, unknown> = { ...value };
  delete args[GATEWAY_CONFIRM_TOKEN_FIELD];
  delete args[GATEWAY_PREVIEW_INVOCATION_FIELD];
  if (!hasToken) {
    return Object.freeze({ args: Object.freeze(args) });
  }
  return Object.freeze({
    args: Object.freeze(args),
    confirmation: Object.freeze({
      confirmToken: String(value[GATEWAY_CONFIRM_TOKEN_FIELD]),
      originatingPreviewInvocationId: String(
        value[GATEWAY_PREVIEW_INVOCATION_FIELD],
      ),
    }),
  });
}
