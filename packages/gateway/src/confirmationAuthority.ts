import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { makeParamsDigest, type JsonValue } from "@revagent/protocol";
import { z } from "zod";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import type { GatewayJsonValue } from "./dispatch.js";
import { gatewayUuidV7, isGatewayUuidV7 } from "./identifiers.js";
import type {
  GatewayDocumentIdentity,
  GatewayMutationScope,
} from "./invocationContext.js";
import {
  assertEffectiveMcpRequestScopeV1,
  type EffectiveMcpRequestScopeV1,
} from "./invocationContext.js";
import type {
  GatewayProtocolStore,
  StoreErrorCode,
  StoreTransaction,
} from "./store.js";

export const GATEWAY_CONFIRMATION_NAMESPACE =
  "gateway.confirmation-authority/v1" as const;
export const GATEWAY_CONFIRMATION_AUDIT_NAMESPACE =
  "gateway.confirmation-approval-audit/v1" as const;
export const GATEWAY_CONFIRMATION_CONTRACT_VERSION =
  "revagent.gateway-confirmation/v1" as const;
export const GATEWAY_CONFIRMATION_AUDIT_CONTRACT_VERSION =
  "revagent.gateway-confirmation-approval-audit/v1" as const;
export const GATEWAY_CONFIRMATION_TTL_MS = 10 * 60 * 1_000;

/** v2 tokens bind only digest material; no principal or session identifier leaks. */
const TOKEN_PREFIX = "rvc2";
const TOKEN_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DIGEST_HEX_PATTERN = /^[0-9a-f]{64}$/u;

const mutationScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z
    .object({
      kind: z.literal("document"),
      document_id: z.string().min(1).max(4_096),
    })
    .strict(),
]);

const pendingActionSchema = z
  .object({
    contractVersion: z.literal(GATEWAY_CONFIRMATION_CONTRACT_VERSION),
    state: z.enum(["pending", "consumed", "expired"]),
    confirmationId: z.string().min(1).max(512),
    tokenDigest: z.string().regex(DIGEST_PATTERN),
    tenantId: z.string().min(1).max(512),
    principalKey: z.string().min(1).max(512),
    principalKeyHash: z.string().regex(DIGEST_PATTERN),
    userId: z.string().min(1).max(512),
    gatewaySessionId: z.string().min(1).max(512),
    confirmationSessionId: z.string().min(1).max(512),
    effectiveMcpSessionIdHash: z.string().regex(DIGEST_PATTERN),
    oauthClientId: z.string().min(1).max(512).nullable(),
    rsid: z.string().min(1).max(512),
    toolName: z.string().min(1).max(512),
    toolVersion: z.string().min(1).max(128),
    commitArgsDigest: z.string().regex(DIGEST_PATTERN),
    mutationScope: mutationScopeSchema,
    mutationScopeDigest: z.string().regex(DIGEST_PATTERN),
    documentIdentityDigest: z.string().regex(DIGEST_PATTERN),
    originatingPreviewInvocationId: z.string().min(1).max(512),
    previewDigest: z.string().regex(DIGEST_PATTERN),
    previewRef: z.string().min(1).max(2_048),
    issuedAtMs: z.number().int().nonnegative().safe(),
    expiresAtMs: z.number().int().nonnegative().safe(),
    consumedAtMs: z.number().int().nonnegative().safe().nullable(),
    commitInvocationId: z.string().min(1).max(512).nullable(),
  })
  .strict();

const approvalAuditSchema = z
  .object({
    contractVersion: z.literal(GATEWAY_CONFIRMATION_AUDIT_CONTRACT_VERSION),
    state: z.literal("approved"),
    confirmationId: z.string().min(1).max(512),
    tenantId: z.string().min(1).max(512),
    principalKey: z.string().min(1).max(512),
    principalKeyHash: z.string().regex(DIGEST_PATTERN),
    userId: z.string().min(1).max(512),
    gatewaySessionId: z.string().min(1).max(512),
    confirmationSessionId: z.string().min(1).max(512),
    effectiveMcpSessionIdHash: z.string().regex(DIGEST_PATTERN),
    oauthClientId: z.string().min(1).max(512).nullable(),
    rsid: z.string().min(1).max(512),
    toolName: z.string().min(1).max(512),
    toolVersion: z.string().min(1).max(128),
    commitArgsDigest: z.string().regex(DIGEST_PATTERN),
    originatingPreviewInvocationId: z.string().min(1).max(512),
    commitInvocationId: z.string().min(1).max(512),
    approvedAtMs: z.number().int().nonnegative().safe(),
  })
  .strict();

export interface GatewayPendingActionRecord {
  readonly contractVersion: typeof GATEWAY_CONFIRMATION_CONTRACT_VERSION;
  readonly state: "pending" | "consumed" | "expired";
  readonly confirmationId: string;
  readonly tokenDigest: `sha256:${string}`;
  readonly tenantId: string;
  readonly principalKey: string;
  readonly principalKeyHash: `sha256:${string}`;
  readonly userId: string;
  readonly gatewaySessionId: string;
  readonly confirmationSessionId: string;
  readonly effectiveMcpSessionIdHash: `sha256:${string}`;
  readonly oauthClientId: string | null;
  readonly rsid: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly commitArgsDigest: `sha256:${string}`;
  readonly mutationScope: Exclude<GatewayMutationScope, null>;
  readonly mutationScopeDigest: `sha256:${string}`;
  readonly documentIdentityDigest: `sha256:${string}`;
  readonly originatingPreviewInvocationId: string;
  readonly previewDigest: `sha256:${string}`;
  readonly previewRef: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly consumedAtMs: number | null;
  readonly commitInvocationId: string | null;
}

export interface GatewayConfirmationApprovalAuditRecord {
  readonly contractVersion: typeof GATEWAY_CONFIRMATION_AUDIT_CONTRACT_VERSION;
  readonly state: "approved";
  readonly confirmationId: string;
  readonly tenantId: string;
  readonly principalKey: string;
  readonly principalKeyHash: `sha256:${string}`;
  readonly userId: string;
  readonly gatewaySessionId: string;
  readonly confirmationSessionId: string;
  readonly effectiveMcpSessionIdHash: `sha256:${string}`;
  readonly oauthClientId: string | null;
  readonly rsid: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly commitArgsDigest: `sha256:${string}`;
  readonly originatingPreviewInvocationId: string;
  readonly commitInvocationId: string;
  readonly approvedAtMs: number;
}

export interface GatewayPendingActionBinding {
  readonly tenantId: string;
  readonly principalKey: string;
  readonly userId: string;
  readonly gatewaySessionId: string;
  readonly confirmationSessionId: string;
  readonly oauthClientId: string | null;
  readonly rsid: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly commitArgsDigest: `sha256:${string}`;
  readonly mutationScope: Exclude<GatewayMutationScope, null>;
  readonly documentIdentity: GatewayDocumentIdentity;
}

export interface GatewayPendingActionIssueInput
  extends GatewayPendingActionBinding {
  /** Exact ingress carrier; durable records retain only its validated fields. */
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly originatingPreviewInvocationId: string;
  readonly previewDigest: `sha256:${string}`;
  readonly previewRef: string;
}

export type GatewayPendingActionIssueResult =
  | {
      readonly kind: "issued";
      readonly confirmToken: string;
      readonly pendingAction: GatewayPendingActionRecord;
    }
  | GatewayConfirmationStoreFailure;

export interface GatewayConfirmationProof {
  readonly confirmToken: string;
  readonly originatingPreviewInvocationId: string;
  readonly commitInvocationId: string;
  readonly binding: GatewayPendingActionBinding;
  /** The exact frozen ingress scope received by the committing request. */
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
}

export type GatewayConfirmationRefusalReason =
  | "malformed_token"
  | "not_found"
  | "replayed"
  | "expired"
  | "foreign_tenant"
  | "foreign_actor"
  | "foreign_session"
  | "route_mismatch"
  | "tool_mismatch"
  | "tool_version_mismatch"
  | "args_mismatch"
  | "scope_mismatch"
  | "document_mismatch"
  | "preview_mismatch";

export interface GatewayConfirmationStoreFailure {
  readonly kind: "unavailable";
  readonly code: StoreErrorCode;
  readonly message: string;
}

export type GatewayConfirmationValidationResult =
  | {
      readonly kind: "validated";
      readonly pendingAction: GatewayPendingActionRecord;
      readonly storedVersion: number;
      readonly recordKey: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason: GatewayConfirmationRefusalReason;
      readonly confirmationId: string | null;
      readonly pendingAction: GatewayPendingActionRecord | null;
    };

export interface GatewayConfirmationTransactionAuthority {
  usesStore(store: GatewayProtocolStore): boolean;
  validatePendingAction(
    tx: StoreTransaction,
    proof: GatewayConfirmationProof,
    nowMs: number,
  ): Promise<GatewayConfirmationValidationResult>;
  stageConsumption(
    tx: StoreTransaction,
    validation: Extract<
      GatewayConfirmationValidationResult,
      { readonly kind: "validated" }
    >,
    commitInvocationId: string,
    consumedAtMs: number,
  ): GatewayPendingActionRecord;
}

export interface GatewayConfirmationAuthorityOptions {
  readonly clock?: () => number;
  readonly newConfirmationId?: (timestampMs: number) => string;
  readonly newTokenSecret?: () => string;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function valueDigest(value: unknown): `sha256:${string}` {
  return makeParamsDigest(value as JsonValue);
}

function digestHex(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function tokenParts(token: string):
  | {
      readonly confirmationId: string;
      readonly principalKeyHash: `sha256:${string}`;
      readonly effectiveMcpSessionIdHash: `sha256:${string}`;
      readonly tokenDigest: `sha256:${string}`;
    }
  | null {
  if (token.length > 512) return null;
  const [
    prefix,
    confirmationId,
    principalKeyHashHex,
    effectiveMcpSessionIdHashHex,
    secret,
    ...extra
  ] = token.split(".");
  if (
    prefix !== TOKEN_PREFIX ||
    confirmationId === undefined ||
    !isGatewayUuidV7(confirmationId) ||
    principalKeyHashHex === undefined ||
    !DIGEST_HEX_PATTERN.test(principalKeyHashHex) ||
    effectiveMcpSessionIdHashHex === undefined ||
    !DIGEST_HEX_PATTERN.test(effectiveMcpSessionIdHashHex) ||
    secret === undefined ||
    !TOKEN_SECRET_PATTERN.test(secret) ||
    extra.length !== 0
  ) {
    return null;
  }
  return Object.freeze({
    confirmationId,
    principalKeyHash: `sha256:${principalKeyHashHex}`,
    effectiveMcpSessionIdHash: `sha256:${effectiveMcpSessionIdHashHex}`,
    tokenDigest: sha256(token),
  });
}

export function confirmationIdFromToken(token: string): string | null {
  return tokenParts(token)?.confirmationId ?? null;
}

function recordKey(input: {
  readonly principalKeyHash: `sha256:${string}`;
  readonly effectiveMcpSessionIdHash: `sha256:${string}`;
  readonly rsid: string;
  readonly tokenDigest: `sha256:${string}`;
}): string {
  return `${input.principalKeyHash}/${input.effectiveMcpSessionIdHash}/${input.rsid}/${digestHex(input.tokenDigest)}`;
}

function auditKey(input: {
  readonly principalKeyHash: `sha256:${string}`;
  readonly effectiveMcpSessionIdHash: `sha256:${string}`;
  readonly confirmationId: string;
}): string {
  return `${input.principalKeyHash}/${input.effectiveMcpSessionIdHash}/${input.confirmationId}`;
}

function storeFailure(
  code: StoreErrorCode,
  message: string,
): GatewayConfirmationStoreFailure {
  return Object.freeze({ kind: "unavailable" as const, code, message });
}

function decodePendingAction(value: GatewayJsonValue): GatewayPendingActionRecord {
  const parsed = pendingActionSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("persisted pending action has an invalid contract shape");
  }
  const record = parsed.data as GatewayPendingActionRecord;
  if (
    !isGatewayUuidV7(record.confirmationId) ||
    !isGatewayUuidV7(record.originatingPreviewInvocationId) ||
    record.expiresAtMs !== record.issuedAtMs + GATEWAY_CONFIRMATION_TTL_MS ||
    (record.state === "pending" &&
      (record.consumedAtMs !== null || record.commitInvocationId !== null)) ||
    (record.state === "consumed" &&
      (record.consumedAtMs === null ||
        record.commitInvocationId === null ||
        !isGatewayUuidV7(record.commitInvocationId))) ||
    (record.state === "expired" && record.commitInvocationId !== null)
  ) {
    throw new TypeError("persisted pending action violates state invariants");
  }
  return Object.freeze(structuredClone(record));
}

function rejection(
  reason: GatewayConfirmationRefusalReason,
  confirmationId: string | null,
  pendingAction: GatewayPendingActionRecord | null = null,
): GatewayConfirmationValidationResult {
  return Object.freeze({
    kind: "rejected" as const,
    reason,
    confirmationId,
    pendingAction,
  });
}

function validateBinding(
  record: GatewayPendingActionRecord,
  proof: GatewayConfirmationProof,
): GatewayConfirmationRefusalReason | null {
  const binding = proof.binding;
  if (record.tenantId !== binding.tenantId) return "foreign_tenant";
  if (
    record.principalKey !== binding.principalKey ||
    record.userId !== binding.userId
  ) {
    return "foreign_actor";
  }
  if (
    record.gatewaySessionId !== binding.gatewaySessionId ||
    record.confirmationSessionId !== binding.confirmationSessionId ||
    record.oauthClientId !== binding.oauthClientId
  ) {
    return "foreign_session";
  }
  if (record.rsid !== binding.rsid) return "route_mismatch";
  if (record.toolName !== binding.toolName) return "tool_mismatch";
  if (record.toolVersion !== binding.toolVersion) {
    return "tool_version_mismatch";
  }
  if (record.commitArgsDigest !== binding.commitArgsDigest) {
    return "args_mismatch";
  }
  if (record.mutationScopeDigest !== valueDigest(binding.mutationScope)) {
    return "scope_mismatch";
  }
  if (record.documentIdentityDigest !== valueDigest(binding.documentIdentity)) {
    return "document_mismatch";
  }
  if (
    record.originatingPreviewInvocationId !==
    proof.originatingPreviewInvocationId
  ) {
    return "preview_mismatch";
  }
  return null;
}

/**
 * Rejects a proof before it can address durable confirmation state.  The scope
 * is not reconstructed: this boundary accepts only the frozen ingress object
 * carried by the commit request.
 */
function validateProofScope(
  proof: GatewayConfirmationProof,
): GatewayConfirmationRefusalReason | null {
  const scope = proof.effectiveMcpRequestScope;
  try {
    assertEffectiveMcpRequestScopeV1({
      scope,
      auth: Object.freeze({
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: Object.freeze({
          type: "user" as const,
          tenantId: proof.binding.tenantId,
          userId: proof.binding.userId,
          role: "user" as const,
          oidcIssuer: "confirmation-authority",
          oidcSubject: proof.binding.userId,
        }),
        session: Object.freeze({
          sessionId: proof.binding.gatewaySessionId,
          clientType: "mcp" as const,
          mcpSessionId: scope.effectiveMcpSessionId,
          oauthClientId: proof.binding.oauthClientId,
        }),
        principalKey: scope.principalKey,
        issuedAtMs: 0,
        expiresAtMs: null,
      }),
      mcpSessionId: scope.effectiveMcpSessionId,
    });
  } catch {
    return "scope_mismatch";
  }
  if (scope.principalKey !== proof.binding.principalKey) {
    return "foreign_actor";
  }
  if (
    scope.effectiveMcpSessionId !== proof.binding.confirmationSessionId
  ) {
    return "foreign_session";
  }
  return null;
}

function snapshotBinding(
  input: GatewayPendingActionBinding,
): GatewayPendingActionBinding {
  return Object.freeze(structuredClone(input));
}

export function confirmationSessionIdFor(
  auth: AuthContext,
  dispatchMcpSessionId: string,
): string {
  return auth.session.mcpSessionId ?? dispatchMcpSessionId;
}

export class GatewayConfirmationAuthority
  implements GatewayConfirmationTransactionAuthority
{
  readonly #store: GatewayProtocolStore;
  readonly #clock: () => number;
  readonly #newConfirmationId: (timestampMs: number) => string;
  readonly #newTokenSecret: () => string;

  public constructor(
    store: GatewayProtocolStore,
    options: GatewayConfirmationAuthorityOptions = {},
  ) {
    this.#store = store;
    this.#clock = options.clock ?? Date.now;
    this.#newConfirmationId = options.newConfirmationId ?? gatewayUuidV7;
    this.#newTokenSecret =
      options.newTokenSecret ?? (() => randomBytes(32).toString("base64url"));
  }

  public usesStore(store: GatewayProtocolStore): boolean {
    return this.#store === store;
  }

  public async createPendingAction(
    input: GatewayPendingActionIssueInput,
  ): Promise<GatewayPendingActionIssueResult> {
    try {
      assertEffectiveMcpRequestScopeV1({
        scope: input.effectiveMcpRequestScope,
        auth: Object.freeze({
          contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
          actor: Object.freeze({
            type: "user" as const,
            tenantId: input.tenantId,
            userId: input.userId,
            role: "user" as const,
            oidcIssuer: "confirmation-authority",
            oidcSubject: input.userId,
          }),
          session: Object.freeze({
            sessionId: input.gatewaySessionId,
            clientType: "mcp" as const,
            mcpSessionId: input.effectiveMcpRequestScope.effectiveMcpSessionId,
            oauthClientId: input.oauthClientId,
          }),
          principalKey: input.principalKey,
          issuedAtMs: 0,
          expiresAtMs: null,
        }),
        mcpSessionId: input.confirmationSessionId,
      });
    } catch (error) {
      return storeFailure(
        "invalid_record",
        error instanceof Error ? error.message : String(error),
      );
    }
    let frozen: GatewayPendingActionIssueInput;
    try {
      frozen = Object.freeze(structuredClone(input));
    } catch {
      return storeFailure("invalid_record", "pending action input is not cloneable");
    }
    const nowMs = this.#clock();
    const confirmationId = this.#newConfirmationId(nowMs);
    const secret = this.#newTokenSecret();
    if (
      !isGatewayUuidV7(confirmationId) ||
      !isGatewayUuidV7(frozen.originatingPreviewInvocationId) ||
      !TOKEN_SECRET_PATTERN.test(secret)
    ) {
      return storeFailure(
        "invalid_record",
        "confirmation authority generated an invalid identifier",
      );
    }
    const principalKeyHash = sha256(frozen.effectiveMcpRequestScope.principalKey);
    const effectiveMcpSessionIdHash = sha256(
      frozen.effectiveMcpRequestScope.effectiveMcpSessionId,
    );
    const confirmToken = `${TOKEN_PREFIX}.${confirmationId}.${digestHex(principalKeyHash)}.${digestHex(effectiveMcpSessionIdHash)}.${secret}`;
    const tokenDigest = sha256(confirmToken);
    const binding = snapshotBinding(frozen);
    const pendingAction: GatewayPendingActionRecord = Object.freeze({
      contractVersion: GATEWAY_CONFIRMATION_CONTRACT_VERSION,
      state: "pending" as const,
      confirmationId,
      tokenDigest,
      tenantId: binding.tenantId,
      principalKey: binding.principalKey,
      principalKeyHash,
      userId: binding.userId,
      gatewaySessionId: binding.gatewaySessionId,
      confirmationSessionId: binding.confirmationSessionId,
      effectiveMcpSessionIdHash,
      oauthClientId: binding.oauthClientId,
      rsid: binding.rsid,
      toolName: binding.toolName,
      toolVersion: binding.toolVersion,
      commitArgsDigest: binding.commitArgsDigest,
      mutationScope: structuredClone(binding.mutationScope),
      mutationScopeDigest: valueDigest(binding.mutationScope),
      documentIdentityDigest: valueDigest(binding.documentIdentity),
      originatingPreviewInvocationId: frozen.originatingPreviewInvocationId,
      previewDigest: frozen.previewDigest,
      previewRef: frozen.previewRef,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + GATEWAY_CONFIRMATION_TTL_MS,
      consumedAtMs: null,
      commitInvocationId: null,
    });
    try {
      decodePendingAction(
        structuredClone(pendingAction) as unknown as GatewayJsonValue,
      );
      const outcome = await this.#store.transact(
        { tenantId: frozen.tenantId },
        async (tx) => {
          tx.stage({
            namespace: GATEWAY_CONFIRMATION_NAMESPACE,
            key: recordKey({
              principalKeyHash,
              effectiveMcpSessionIdHash,
              rsid: frozen.rsid,
              tokenDigest,
            }),
            value: structuredClone(
              pendingAction,
            ) as unknown as GatewayJsonValue,
            expect: { kind: "absent" },
          });
        },
      );
      if (!outcome.ok) return storeFailure(outcome.code, outcome.message);
      return Object.freeze({
        kind: "issued" as const,
        confirmToken,
        pendingAction,
      });
    } catch (error) {
      return storeFailure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public async validatePendingAction(
    tx: StoreTransaction,
    proof: GatewayConfirmationProof,
    nowMs: number,
  ): Promise<GatewayConfirmationValidationResult> {
    const parts = tokenParts(proof.confirmToken);
    if (parts === null) return rejection("malformed_token", null);
    const scopeError = validateProofScope(proof);
    if (scopeError !== null) return rejection(scopeError, parts.confirmationId);
    const expectedPrincipalKeyHash = sha256(
      proof.effectiveMcpRequestScope.principalKey,
    );
    if (!constantTimeEqual(parts.principalKeyHash, expectedPrincipalKeyHash)) {
      return rejection("foreign_actor", parts.confirmationId);
    }
    const expectedEffectiveMcpSessionIdHash = sha256(
      proof.effectiveMcpRequestScope.effectiveMcpSessionId,
    );
    if (
      !constantTimeEqual(
        parts.effectiveMcpSessionIdHash,
        expectedEffectiveMcpSessionIdHash,
      )
    ) {
      return rejection("foreign_session", parts.confirmationId);
    }
    const key = recordKey({
      principalKeyHash: expectedPrincipalKeyHash,
      effectiveMcpSessionIdHash: expectedEffectiveMcpSessionIdHash,
      rsid: proof.binding.rsid,
      tokenDigest: parts.tokenDigest,
    });
    const stored = await tx.read(GATEWAY_CONFIRMATION_NAMESPACE, key);
    if (stored === null) return rejection("not_found", parts.confirmationId);
    const record = decodePendingAction(stored.value);
    if (
      !constantTimeEqual(record.confirmationId, parts.confirmationId) ||
      !constantTimeEqual(record.tokenDigest, parts.tokenDigest) ||
      !constantTimeEqual(record.principalKeyHash, parts.principalKeyHash) ||
      !constantTimeEqual(
        record.effectiveMcpSessionIdHash,
        parts.effectiveMcpSessionIdHash,
      )
    ) {
      return rejection("not_found", parts.confirmationId);
    }
    if (record.state === "consumed") {
      return rejection("replayed", record.confirmationId, record);
    }
    if (record.state === "expired" || nowMs >= record.expiresAtMs) {
      if (record.state === "pending") {
        const expired: GatewayPendingActionRecord = Object.freeze({
          ...record,
          state: "expired" as const,
          consumedAtMs: nowMs,
        });
        tx.stage({
          namespace: GATEWAY_CONFIRMATION_NAMESPACE,
          key,
          value: structuredClone(expired) as unknown as GatewayJsonValue,
          expect: { kind: "version", version: stored.version },
        });
      }
      return rejection("expired", record.confirmationId, record);
    }
    const bindingError = validateBinding(record, proof);
    if (bindingError !== null) {
      return rejection(bindingError, record.confirmationId, record);
    }
    return Object.freeze({
      kind: "validated" as const,
      pendingAction: record,
      storedVersion: stored.version,
      recordKey: key,
    });
  }

  public stageConsumption(
    tx: StoreTransaction,
    validation: Extract<
      GatewayConfirmationValidationResult,
      { readonly kind: "validated" }
    >,
    commitInvocationId: string,
    consumedAtMs: number,
  ): GatewayPendingActionRecord {
    if (!isGatewayUuidV7(commitInvocationId)) {
      throw new TypeError("commit invocation id must be UUIDv7");
    }
    const consumed: GatewayPendingActionRecord = Object.freeze({
      ...validation.pendingAction,
      state: "consumed" as const,
      consumedAtMs,
      commitInvocationId,
    });
    const approvalAudit: GatewayConfirmationApprovalAuditRecord =
      Object.freeze({
        contractVersion: GATEWAY_CONFIRMATION_AUDIT_CONTRACT_VERSION,
        state: "approved" as const,
        confirmationId: consumed.confirmationId,
        tenantId: consumed.tenantId,
        principalKey: consumed.principalKey,
        principalKeyHash: consumed.principalKeyHash,
        userId: consumed.userId,
        gatewaySessionId: consumed.gatewaySessionId,
        confirmationSessionId: consumed.confirmationSessionId,
        effectiveMcpSessionIdHash: consumed.effectiveMcpSessionIdHash,
        oauthClientId: consumed.oauthClientId,
        rsid: consumed.rsid,
        toolName: consumed.toolName,
        toolVersion: consumed.toolVersion,
        commitArgsDigest: consumed.commitArgsDigest,
        originatingPreviewInvocationId:
          consumed.originatingPreviewInvocationId,
        commitInvocationId,
        approvedAtMs: consumedAtMs,
      });
    approvalAuditSchema.parse(approvalAudit);
    tx.stage({
      namespace: GATEWAY_CONFIRMATION_NAMESPACE,
      key: validation.recordKey,
      value: structuredClone(consumed) as unknown as GatewayJsonValue,
      expect: { kind: "version", version: validation.storedVersion },
    });
    tx.stage({
      namespace: GATEWAY_CONFIRMATION_AUDIT_NAMESPACE,
      key: auditKey({
        principalKeyHash: consumed.principalKeyHash,
        effectiveMcpSessionIdHash: consumed.effectiveMcpSessionIdHash,
        confirmationId: consumed.confirmationId,
      }),
      value: structuredClone(approvalAudit) as unknown as GatewayJsonValue,
      expect: { kind: "absent" },
    });
    return consumed;
  }
}
