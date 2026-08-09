import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import type { AuthContext } from "./authContext.js";
import type {
  GatewayExecutorBinding,
  GatewayMutationScopePolicy,
  GatewayPolicyClass,
} from "./registry.js";

export type GatewayParamsDigest = `sha256:${string}`;

export type GatewayDocumentIdentity =
  | {
      readonly kind: "live";
      readonly session_document_id: string;
    }
  | {
      readonly kind: "published";
      readonly acc_project_id: string;
      readonly item_urn: string;
      readonly version_urn: string;
      readonly version_number: number;
    };

export type GatewayMutationScope =
  | null
  | { readonly kind: "session" }
  | {
      readonly kind: "document";
      readonly document_id: string;
    };

/**
 * The authenticated north-to-bridge binding selected before dispatch.
 *
 * Tenant and MCP-session identity are repeated deliberately: this is the
 * authority boundary at which a stale or cross-tenant session-to-bridge lookup
 * is rejected instead of being trusted because authentication succeeded.
 */
export interface GatewayInvocationRoute {
  readonly tenantId: string;
  readonly mcpSessionId: string;
  readonly rsid: string;
  readonly documentIdentity: GatewayDocumentIdentity;
}

export interface GatewayInvocationContext {
  readonly invocationId: string;
  readonly idempotencyKey: string;
  readonly principalKey: string;
  readonly actor: {
    readonly tenantId: string;
    readonly userId: string;
    readonly role: AuthContext["actor"]["role"];
  };
  readonly gatewaySessionId: string;
  readonly oauthClientId: string;
  readonly mcpSessionId: string;
  readonly rsid: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly policyClass: GatewayPolicyClass;
  readonly mutationScopePolicy: GatewayMutationScopePolicy;
  readonly mutating: boolean;
  readonly executor: GatewayExecutorBinding;
  readonly documentIdentity: GatewayDocumentIdentity;
  readonly paramsDigest: GatewayParamsDigest;
  readonly mutationScope: GatewayMutationScope;
  readonly startedAtMs: number;
}

export type GatewayInvocationContextErrorCode =
  | "document_scope_mismatch"
  | "expired_auth_context"
  | "invalid_auth_context"
  | "invalid_document_identity"
  | "invalid_invocation_route"
  | "mutation_scope_policy_unsupported"
  | "session_binding_mismatch"
  | "tenant_binding_mismatch";

export class GatewayInvocationContextError extends Error {
  public constructor(
    public readonly code: GatewayInvocationContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayInvocationContextError";
  }
}

function requireBoundedString(
  value: string,
  name: string,
  code: GatewayInvocationContextErrorCode,
  maxLength = 512,
): void {
  if (value.length < 1 || value.length > maxLength || value.trim() !== value) {
    throw new GatewayInvocationContextError(
      code,
      `${name} must be a non-empty, trimmed string of at most ${maxLength} characters`,
    );
  }
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(
          "RFC 8785 input contains an unpaired high surrogate",
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("RFC 8785 input contains an unpaired low surrogate");
    }
  }
}

function quote(value: string): string {
  assertWellFormedUnicode(value);
  return JSON.stringify(value);
}

/** Mirrors the frozen RBP/1 RFC 8785 parameter canonicalizer. */
function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError("RFC 8785 input numbers must be finite");
      }
      return JSON.stringify(value);
    }
    case "string":
      return quote(value);
    case "object": {
      if (Array.isArray(value)) {
        const values: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.hasOwn(value, index) || value[index] === undefined) {
            throw new TypeError(
              `RFC 8785 input contains an undefined array item at ${index}`,
            );
          }
          values.push(canonicalJson(value[index]));
        }
        return `[${values.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(value) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("RFC 8785 input must contain only JSON objects");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(
          "RFC 8785 input cannot contain symbol-keyed members",
        );
      }
      if (
        Object.getOwnPropertyNames(value).length !== Object.keys(value).length
      ) {
        throw new TypeError(
          "RFC 8785 input cannot contain non-enumerable members",
        );
      }

      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .sort()
        .map((key) => {
          const member = record[key];
          if (member === undefined) {
            throw new TypeError(
              `RFC 8785 input contains undefined member ${key}`,
            );
          }
          return `${quote(key)}:${canonicalJson(member)}`;
        });
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`RFC 8785 input cannot contain ${typeof value}`);
  }
}

export function canonicalParamsDigest(value: unknown): GatewayParamsDigest {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function validateDocumentIdentity(
  identity: GatewayDocumentIdentity,
): GatewayDocumentIdentity {
  if (identity.kind === "live") {
    requireBoundedString(
      identity.session_document_id,
      "session_document_id",
      "invalid_document_identity",
    );
    return Object.freeze({ ...identity });
  }
  if (identity.kind !== "published") {
    throw new GatewayInvocationContextError(
      "invalid_document_identity",
      "document identity kind must be live or published",
    );
  }
  requireBoundedString(
    identity.acc_project_id,
    "acc_project_id",
    "invalid_document_identity",
  );
  requireBoundedString(
    identity.item_urn,
    "item_urn",
    "invalid_document_identity",
    2_048,
  );
  requireBoundedString(
    identity.version_urn,
    "version_urn",
    "invalid_document_identity",
    2_048,
  );
  if (
    !Number.isSafeInteger(identity.version_number) ||
    identity.version_number < 1
  ) {
    throw new GatewayInvocationContextError(
      "invalid_document_identity",
      "version_number must be a positive safe integer",
    );
  }
  return Object.freeze({ ...identity });
}

export interface GatewayInvocationAuthority {
  readonly documentIdentity: GatewayDocumentIdentity;
  readonly mutationScopePolicy: GatewayMutationScopePolicy;
  readonly mutating: boolean;
  readonly mutationScope: GatewayMutationScope;
}

export function deriveGatewayInvocationAuthority(input: {
  readonly auth: AuthContext;
  readonly route: GatewayInvocationRoute;
  readonly mcpSessionId: string;
  readonly mutationScopePolicy: GatewayMutationScopePolicy;
  readonly startedAtMs: number;
}): GatewayInvocationAuthority {
  const { auth, route } = input;
  if (auth.actor.type !== "user" || auth.session.clientType !== "mcp") {
    throw new GatewayInvocationContextError(
      "invalid_auth_context",
      "Gateway invocation requires a north MCP user AuthContext",
    );
  }
  if (auth.expiresAtMs !== null && auth.expiresAtMs <= input.startedAtMs) {
    throw new GatewayInvocationContextError(
      "expired_auth_context",
      "Gateway invocation AuthContext has expired",
    );
  }
  if (auth.session.oauthClientId === null) {
    throw new GatewayInvocationContextError(
      "invalid_auth_context",
      "Gateway invocation AuthContext is missing oauthClientId",
    );
  }
  requireBoundedString(
    auth.principalKey,
    "principalKey",
    "invalid_auth_context",
  );
  requireBoundedString(
    auth.actor.tenantId,
    "actor tenantId",
    "invalid_auth_context",
  );
  requireBoundedString(
    auth.actor.userId,
    "actor userId",
    "invalid_auth_context",
  );
  requireBoundedString(
    auth.session.sessionId,
    "Gateway sessionId",
    "invalid_auth_context",
  );
  requireBoundedString(
    route.tenantId,
    "route tenantId",
    "invalid_invocation_route",
  );
  requireBoundedString(
    input.mcpSessionId,
    "MCP sessionId",
    "invalid_invocation_route",
  );
  requireBoundedString(
    route.mcpSessionId,
    "route mcpSessionId",
    "invalid_invocation_route",
  );
  requireBoundedString(route.rsid, "route rsid", "invalid_invocation_route");
  if (route.tenantId !== auth.actor.tenantId) {
    throw new GatewayInvocationContextError(
      "tenant_binding_mismatch",
      "invocation route tenant does not match the authenticated actor",
    );
  }
  if (route.mcpSessionId !== input.mcpSessionId) {
    throw new GatewayInvocationContextError(
      "session_binding_mismatch",
      "invocation route MCP session does not match the active MCP session",
    );
  }
  if (
    auth.session.mcpSessionId !== null &&
    input.mcpSessionId !== auth.session.mcpSessionId
  ) {
    throw new GatewayInvocationContextError(
      "session_binding_mismatch",
      "invocation route MCP session does not match the authenticated session",
    );
  }

  const documentIdentity = validateDocumentIdentity(route.documentIdentity);
  const mutationScope: GatewayMutationScope =
    input.mutationScopePolicy === "none"
      ? null
      : input.mutationScopePolicy === "session"
        ? Object.freeze({ kind: "session" as const })
        : documentIdentity.kind === "live"
          ? Object.freeze({
              kind: "document" as const,
              document_id: documentIdentity.session_document_id,
            })
          : null;
  if (input.mutationScopePolicy === "document" && mutationScope === null) {
    throw new GatewayInvocationContextError(
      "mutation_scope_policy_unsupported",
      "document-scoped mutation requires one exact live session document",
    );
  }

  return Object.freeze({
    documentIdentity,
    mutationScopePolicy: input.mutationScopePolicy,
    mutating: mutationScope !== null,
    mutationScope,
  });
}

export function createGatewayInvocationContext(input: {
  readonly auth: AuthContext;
  readonly route: GatewayInvocationRoute;
  readonly mcpSessionId: string;
  readonly invocationId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly policyClass: GatewayPolicyClass;
  readonly mutationScopePolicy: GatewayMutationScopePolicy;
  readonly executor: GatewayExecutorBinding;
  readonly args: unknown;
  readonly startedAtMs: number;
}): GatewayInvocationContext {
  const { auth, route } = input;
  requireBoundedString(
    input.invocationId,
    "invocationId",
    "invalid_invocation_route",
  );
  const authority = deriveGatewayInvocationAuthority(input);
  const oauthClientId = auth.session.oauthClientId;
  if (oauthClientId === null) {
    throw new GatewayInvocationContextError(
      "invalid_auth_context",
      "Gateway invocation AuthContext is missing oauthClientId",
    );
  }

  return Object.freeze({
    invocationId: input.invocationId,
    idempotencyKey: `${route.rsid}/${input.invocationId}`,
    principalKey: auth.principalKey,
    actor: Object.freeze({
      tenantId: auth.actor.tenantId,
      userId: auth.actor.userId,
      role: auth.actor.role,
    }),
    gatewaySessionId: auth.session.sessionId,
    oauthClientId,
    mcpSessionId: input.mcpSessionId,
    rsid: route.rsid,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    policyClass: input.policyClass,
    mutationScopePolicy: input.mutationScopePolicy,
    mutating: authority.mutating,
    executor: input.executor,
    documentIdentity: authority.documentIdentity,
    paramsDigest: canonicalParamsDigest(input.args),
    mutationScope: authority.mutationScope,
    startedAtMs: input.startedAtMs,
  });
}

const invocationStorage = new AsyncLocalStorage<GatewayInvocationContext>();

export function currentGatewayInvocationContext():
  GatewayInvocationContext | undefined {
  return invocationStorage.getStore();
}

export function runWithGatewayInvocationContext<T>(
  context: GatewayInvocationContext,
  operation: () => T,
): T {
  return invocationStorage.run(context, operation);
}
