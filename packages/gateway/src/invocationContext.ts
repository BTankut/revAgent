import { AsyncLocalStorage } from "node:async_hooks";
import { makeParamsDigest, type JsonValue } from "@revagent/protocol";

import type { AuthContext } from "./authContext.js";
import { gatewayUuidV7 } from "./identifiers.js";
import type {
  GatewayExecutorBinding,
  GatewayMutationScopePolicy,
  GatewayPolicyClass,
} from "./registry.js";

export type GatewayParamsDigest = `sha256:${string}`;

/**
 * The sole MCP session identity admitted for one north request.  It is minted
 * once at ingress and deliberately carries the authenticated principal so
 * downstream authority cannot accidentally mix a transport session with an
 * identity-session or a different bearer.
 */
export interface EffectiveMcpRequestScopeV1 {
  readonly contractVersion: "revagent.effective-mcp-request-scope/v1";
  readonly principalKey: string;
  readonly effectiveMcpSessionId: string;
  readonly transportMcpSessionId: string | null;
  readonly identityMcpSessionId: string | null;
}

/** Validates the frozen scope supplied to a downstream authority boundary. */
export function assertEffectiveMcpRequestScopeV1(input: {
  readonly scope: EffectiveMcpRequestScopeV1;
  readonly auth: AuthContext;
  readonly mcpSessionId: string;
}): void {
  const { scope, auth, mcpSessionId } = input;
  if (
    !Object.isFrozen(scope) ||
    scope.contractVersion !== "revagent.effective-mcp-request-scope/v1"
  ) {
    throw new GatewayInvocationContextError(
      "invalid_invocation_route",
      "effective MCP request scope must be a frozen v1 authority object",
    );
  }
  requireBoundedString(scope.principalKey, "effective scope principalKey", "invalid_auth_context");
  requireBoundedString(scope.effectiveMcpSessionId, "effective MCP sessionId", "invalid_invocation_route");
  for (const [name, value] of [
    ["effective transport MCP sessionId", scope.transportMcpSessionId],
    ["effective identity MCP sessionId", scope.identityMcpSessionId],
  ] as const) {
    if (value !== null) {
      requireBoundedString(value, name, "invalid_invocation_route");
    }
  }
  if (scope.principalKey !== auth.principalKey || mcpSessionId !== scope.effectiveMcpSessionId) {
    throw new GatewayInvocationContextError(
      "mcp_session_binding_mismatch",
      "dispatch MCP authority does not match the effective ingress scope",
    );
  }
  if (
    scope.transportMcpSessionId !== null &&
    scope.identityMcpSessionId !== null &&
    scope.transportMcpSessionId !== scope.identityMcpSessionId
  ) {
    throw new GatewayInvocationContextError(
      "mcp_session_binding_mismatch",
      "effective MCP scope has conflicting transport and identity sessions",
    );
  }
}

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
  /** Principal selected with the tenant/session route; never inferred later. */
  readonly principalKey: string;
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
  /** Set by the north-dispatch constructor; legacy test fixtures omit it. */
  readonly effectiveMcpRequestScope?: EffectiveMcpRequestScopeV1;
  readonly rsid: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly policyClass: GatewayPolicyClass;
  readonly policyDecision:
    | "auto"
    | "preview"
    | "confirmed"
    | "gated_approved"
    | "denied";
  readonly confirmationId: string | null;
  readonly originatingPreviewInvocationId: string | null;
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
  | "mcp_session_binding_mismatch"
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

/**
 * Resolves the only MCP session identity allowed to cross the north boundary.
 * A transport/identity disagreement is a pre-dispatch authority failure.  A
 * request with neither identity receives a UUIDv7-scoped stateless identity;
 * it is intentionally never derived from the Gateway session identifier.
 */
export function createEffectiveMcpRequestScopeV1(input: {
  readonly principalKey: string;
  readonly transportMcpSessionId: string | null;
  readonly identityMcpSessionId: string | null;
  readonly nowMs: number;
}): EffectiveMcpRequestScopeV1 {
  requireBoundedString(
    input.principalKey,
    "principalKey",
    "invalid_auth_context",
  );
  for (const [name, value] of [
    ["transport MCP sessionId", input.transportMcpSessionId],
    ["identity MCP sessionId", input.identityMcpSessionId],
  ] as const) {
    if (value !== null) {
      requireBoundedString(value, name, "invalid_invocation_route");
    }
  }
  if (
    input.transportMcpSessionId !== null &&
    input.identityMcpSessionId !== null &&
    input.transportMcpSessionId !== input.identityMcpSessionId
  ) {
    throw new GatewayInvocationContextError(
      "mcp_session_binding_mismatch",
      "transport MCP session does not match the authenticated identity session",
    );
  }
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new GatewayInvocationContextError(
      "invalid_invocation_route",
      "effective MCP scope clock must return a non-negative safe integer",
    );
  }
  const effectiveMcpSessionId =
    input.transportMcpSessionId ??
    input.identityMcpSessionId ??
    `stateless-request:${gatewayUuidV7(input.nowMs)}`;
  return Object.freeze({
    contractVersion: "revagent.effective-mcp-request-scope/v1" as const,
    principalKey: input.principalKey,
    effectiveMcpSessionId,
    transportMcpSessionId: input.transportMcpSessionId,
    identityMcpSessionId: input.identityMcpSessionId,
  });
}

export function canonicalParamsDigest(value: unknown): GatewayParamsDigest {
  return makeParamsDigest(value as JsonValue);
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
    route.principalKey,
    "route principalKey",
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
  if (route.principalKey !== auth.principalKey) {
    throw new GatewayInvocationContextError(
      "session_binding_mismatch",
      "invocation route principal does not match the authenticated actor",
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
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly invocationId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly policyClass: GatewayPolicyClass;
  readonly policyDecision?: GatewayInvocationContext["policyDecision"];
  readonly confirmationId?: string | null;
  readonly originatingPreviewInvocationId?: string | null;
  readonly mutationScopePolicy: GatewayMutationScopePolicy;
  readonly executor: GatewayExecutorBinding;
  readonly args: unknown;
  readonly startedAtMs: number;
}): GatewayInvocationContext {
  const { auth, route } = input;
  assertEffectiveMcpRequestScopeV1({
    scope: input.effectiveMcpRequestScope,
    auth,
    mcpSessionId: input.mcpSessionId,
  });
  requireBoundedString(
    input.invocationId,
    "invocationId",
    "invalid_invocation_route",
  );
  const authority = deriveGatewayInvocationAuthority(input);
  const policyDecision =
    input.policyDecision ??
    (input.policyClass === "auto"
      ? "auto"
      : input.policyClass === "confirm"
        ? "preview"
        : "denied");
  const confirmationId = input.confirmationId ?? null;
  const originatingPreviewInvocationId =
    input.originatingPreviewInvocationId ?? null;
  if (
    (policyDecision === "auto" && input.policyClass !== "auto") ||
    (policyDecision === "preview" && input.policyClass !== "confirm") ||
    (policyDecision === "confirmed" && input.policyClass !== "confirm") ||
    (policyDecision === "gated_approved" && input.policyClass !== "gated")
  ) {
    throw new GatewayInvocationContextError(
      "invalid_invocation_route",
      "policy decision does not match the registry policy class",
    );
  }
  if (policyDecision === "confirmed") {
    if (confirmationId === null || originatingPreviewInvocationId === null) {
      throw new GatewayInvocationContextError(
        "invalid_invocation_route",
        "confirmed policy requires confirmation and preview identities",
      );
    }
    requireBoundedString(
      confirmationId,
      "confirmationId",
      "invalid_invocation_route",
    );
    requireBoundedString(
      originatingPreviewInvocationId,
      "originatingPreviewInvocationId",
      "invalid_invocation_route",
    );
  } else if (
    confirmationId !== null ||
    originatingPreviewInvocationId !== null
  ) {
    throw new GatewayInvocationContextError(
      "invalid_invocation_route",
      "only a confirmed policy may carry confirmation identities",
    );
  }
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
    effectiveMcpRequestScope: input.effectiveMcpRequestScope,
    rsid: route.rsid,
    toolName: input.toolName,
    toolVersion: input.toolVersion,
    policyClass: input.policyClass,
    policyDecision,
    confirmationId,
    originatingPreviewInvocationId,
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
