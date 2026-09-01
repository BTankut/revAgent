import type { GatewayJsonValue } from "./dispatch.js";
import { isGatewayUuidV7 } from "./identifiers.js";
import type { StoreTransaction } from "./store.js";

/**
 * Private, Gateway-owned admission ledger for an already-recorded terminal
 * whose RBP result deliberately omitted its payload.  This is not an MCP
 * tool, a resource reference, or a replay mechanism.
 */
export const GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE =
  "gateway.omitted-payload-recovery/v1" as const;
const GATEWAY_OMITTED_PAYLOAD_RECOVERY_INVOCATION_NAMESPACE =
  "gateway.omitted-payload-recovery-invocation/v1" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_STRING = 4_096;
export const OMITTED_PAYLOAD_RECOVERY_MAX_AGE_MS = 5 * 60 * 1_000;

export interface OmittedPayloadRecoveryOwner {
  readonly tenantId: string;
  readonly userId: string;
  readonly effectiveMcpSessionId: string;
  readonly rsid: string;
  readonly sessionBindingId: string;
  readonly sessionVersion: number;
}

export interface OmittedPayloadRecoveryAdmission {
  readonly owner: OmittedPayloadRecoveryOwner;
  readonly originInvocationId: string;
  readonly originResultDigest: `sha256:${string}`;
  /** Candidate used only if this exact durable identity has no prior record. */
  readonly newCarrierRecoveryInvocationId: string;
  /** Gateway terminal-persistence proof; never supplied by an RBP peer. */
  readonly terminalEvidenceDigest: `sha256:${string}`;
  /** Bound by the admitted terminal's own bounded retention window. */
  readonly terminalRetentionExpiresAtMs: number;
  /** Bound independently by the current owner session. */
  readonly ownerSessionExpiresAtMs: number;
  readonly nowMs: number;
}

/** Supplied only by the current Bridge/MCP authority at resume or completion. */
export interface OmittedPayloadRecoveryCurrentOwner extends OmittedPayloadRecoveryOwner {
  readonly active: true;
  readonly ownerSessionExpiresAtMs: number;
  readonly nowMs: number;
}

export interface OmittedPayloadRecoveryRecord {
  readonly schema: typeof GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE;
  readonly recordVersion: 1;
  readonly tenantId: string;
  readonly owner: Omit<OmittedPayloadRecoveryOwner, "tenantId">;
  readonly originInvocationId: string;
  readonly originResultDigest: `sha256:${string}`;
  /** Durable Bridge/C1 carrier identity, never a North MCP request id. */
  readonly carrierRecoveryInvocationId: string;
  readonly terminalEvidenceDigest: `sha256:${string}`;
  readonly state: "awaiting_correlated_read" | "completed";
  readonly expiresAtMs: number;
  /** A recovery result reference digest, deliberately distinct from origin. */
  readonly resultReferenceDigest: `sha256:${string}` | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type OmittedPayloadRecoveryClaim =
  | { readonly kind: "admitted"; readonly record: OmittedPayloadRecoveryRecord }
  | { readonly kind: "resume"; readonly record: OmittedPayloadRecoveryRecord }
  | { readonly kind: "completed"; readonly record: OmittedPayloadRecoveryRecord }
  | { readonly kind: "guarded" };

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING;
}

function validOwner(value: OmittedPayloadRecoveryOwner): boolean {
  return bounded(value.tenantId) && bounded(value.userId) &&
    bounded(value.effectiveMcpSessionId) && bounded(value.rsid) &&
    isGatewayUuidV7(value.sessionBindingId) &&
    Number.isSafeInteger(value.sessionVersion) && value.sessionVersion > 0;
}

function validAdmission(value: OmittedPayloadRecoveryAdmission): boolean {
  return validOwner(value.owner) && isGatewayUuidV7(value.originInvocationId) &&
    isGatewayUuidV7(value.newCarrierRecoveryInvocationId) &&
    DIGEST.test(value.originResultDigest) && DIGEST.test(value.terminalEvidenceDigest) &&
    Number.isSafeInteger(value.nowMs) && value.nowMs >= 0 &&
    Number.isSafeInteger(value.ownerSessionExpiresAtMs) &&
    Number.isSafeInteger(value.terminalRetentionExpiresAtMs) &&
    value.ownerSessionExpiresAtMs > value.nowMs &&
    value.terminalRetentionExpiresAtMs > value.nowMs;
}

function validCurrentOwner(value: OmittedPayloadRecoveryCurrentOwner, admission: OmittedPayloadRecoveryAdmission): boolean {
  return value.active === true && validOwner(value) &&
    Number.isSafeInteger(value.nowMs) && value.nowMs >= 0 &&
    Number.isSafeInteger(value.ownerSessionExpiresAtMs) &&
    value.ownerSessionExpiresAtMs > value.nowMs &&
    value.tenantId === admission.owner.tenantId && value.userId === admission.owner.userId &&
    value.effectiveMcpSessionId === admission.owner.effectiveMcpSessionId &&
    value.rsid === admission.owner.rsid && value.sessionBindingId === admission.owner.sessionBindingId &&
    value.sessionVersion === admission.owner.sessionVersion &&
    value.ownerSessionExpiresAtMs === admission.ownerSessionExpiresAtMs;
}

function keyFor(originInvocationId: string): string {
  return originInvocationId;
}

function parseRecord(value: GatewayJsonValue, tenantId: string, key: string): OmittedPayloadRecoveryRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as unknown as Partial<OmittedPayloadRecoveryRecord>;
  const owner = candidate.owner;
  const createdAtMs = candidate.createdAtMs;
  const updatedAtMs = candidate.updatedAtMs;
  const expiresAtMs = candidate.expiresAtMs;
  if (
    candidate.schema !== GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE ||
    candidate.recordVersion !== 1 || candidate.tenantId !== tenantId ||
    candidate.originInvocationId !== key || !isGatewayUuidV7(candidate.originInvocationId) ||
    typeof candidate.carrierRecoveryInvocationId !== "string" || !isGatewayUuidV7(candidate.carrierRecoveryInvocationId) ||
    typeof candidate.originResultDigest !== "string" || !DIGEST.test(candidate.originResultDigest) ||
    typeof candidate.terminalEvidenceDigest !== "string" || !DIGEST.test(candidate.terminalEvidenceDigest) ||
    owner === undefined || !validOwner({ tenantId, ...owner }) ||
    (candidate.state !== "awaiting_correlated_read" && candidate.state !== "completed") ||
    !(candidate.resultReferenceDigest === null ||
      (typeof candidate.resultReferenceDigest === "string" && DIGEST.test(candidate.resultReferenceDigest))) ||
    typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 ||
    typeof createdAtMs !== "number" || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0 ||
    typeof updatedAtMs !== "number" || !Number.isSafeInteger(updatedAtMs) || updatedAtMs < createdAtMs
  ) return null;
  return candidate as OmittedPayloadRecoveryRecord;
}

function sameBinding(record: OmittedPayloadRecoveryRecord, admission: OmittedPayloadRecoveryAdmission): boolean {
  const { owner } = admission;
  return record.tenantId === owner.tenantId &&
    record.owner.userId === owner.userId &&
    record.owner.effectiveMcpSessionId === owner.effectiveMcpSessionId &&
    record.owner.rsid === owner.rsid &&
    record.owner.sessionBindingId === owner.sessionBindingId &&
    record.owner.sessionVersion === owner.sessionVersion &&
    record.originInvocationId === admission.originInvocationId &&
    record.originResultDigest === admission.originResultDigest &&
    record.terminalEvidenceDigest === admission.terminalEvidenceDigest &&
    record.expiresAtMs === Math.min(admission.ownerSessionExpiresAtMs, admission.terminalRetentionExpiresAtMs);
}

/**
 * CAS admission only.  It deliberately has no executor, payload, or origin
 * dispatch input, so a crash can only resume the bounded correlated lookup.
 */
export async function claimOmittedPayloadRecovery(
  tx: StoreTransaction,
  admission: OmittedPayloadRecoveryAdmission,
  currentOwner: OmittedPayloadRecoveryCurrentOwner,
): Promise<OmittedPayloadRecoveryClaim> {
  if (!validAdmission(admission) || !validCurrentOwner(currentOwner, admission)) return Object.freeze({ kind: "guarded" as const });
  const key = keyFor(admission.originInvocationId);
  const stored = await tx.read<GatewayJsonValue>(GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE, key);
  if (stored === null) {
    const record: OmittedPayloadRecoveryRecord = Object.freeze({
      schema: GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE,
      recordVersion: 1,
      tenantId: admission.owner.tenantId,
      owner: Object.freeze({
        userId: admission.owner.userId,
        effectiveMcpSessionId: admission.owner.effectiveMcpSessionId,
        rsid: admission.owner.rsid,
        sessionBindingId: admission.owner.sessionBindingId,
        sessionVersion: admission.owner.sessionVersion,
      }),
      originInvocationId: admission.originInvocationId,
      originResultDigest: admission.originResultDigest,
      carrierRecoveryInvocationId: admission.newCarrierRecoveryInvocationId,
      terminalEvidenceDigest: admission.terminalEvidenceDigest,
      state: "awaiting_correlated_read",
      expiresAtMs: Math.min(admission.ownerSessionExpiresAtMs, admission.terminalRetentionExpiresAtMs),
      resultReferenceDigest: null,
      createdAtMs: admission.nowMs,
      updatedAtMs: admission.nowMs,
    });
    tx.stage({
      namespace: GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE,
      key,
      value: record as unknown as GatewayJsonValue,
      expect: { kind: "absent" },
    });
    tx.stage({
      namespace: GATEWAY_OMITTED_PAYLOAD_RECOVERY_INVOCATION_NAMESPACE,
      key: admission.newCarrierRecoveryInvocationId,
      value: Object.freeze({
        originInvocationId: admission.originInvocationId,
        tenantId: admission.owner.tenantId,
      }) as unknown as GatewayJsonValue,
      expect: { kind: "absent" },
    });
    return Object.freeze({ kind: "admitted" as const, record });
  }
  const record = parseRecord(stored.value, admission.owner.tenantId, key);
  const invocation = await tx.read<GatewayJsonValue>(
    GATEWAY_OMITTED_PAYLOAD_RECOVERY_INVOCATION_NAMESPACE,
    record?.carrierRecoveryInvocationId ?? admission.newCarrierRecoveryInvocationId,
  );
  if (
    record === null || !sameBinding(record, admission) ||
    !isRecordInvocationIndex(invocation?.value, admission) ||
    record.expiresAtMs <= currentOwner.nowMs
  ) {
    return Object.freeze({ kind: "guarded" as const });
  }
  return Object.freeze({
    kind: record.state === "completed" ? "completed" as const : "resume" as const,
    record,
  });
}

function isRecordInvocationIndex(
  value: GatewayJsonValue | undefined,
  admission: OmittedPayloadRecoveryAdmission,
): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (value as { originInvocationId?: unknown }).originInvocationId === admission.originInvocationId &&
    (value as { tenantId?: unknown }).tenantId === admission.owner.tenantId;
}

/**
 * Fail-closed reservation probe for C39 carrier admission. Any durable reverse
 * index row in the current tenant reserves the invocation id, even when the
 * primary row is stale or malformed; reserved ids must never fall through to
 * the generic C38 carrier path.
 */
export async function isOmittedPayloadRecoveryInvocationReserved(
  tx: StoreTransaction,
  tenantId: string,
  carrierRecoveryInvocationId: string,
): Promise<boolean> {
  if (!bounded(tenantId) || !isGatewayUuidV7(carrierRecoveryInvocationId)) return false;
  return await tx.read<GatewayJsonValue>(
    GATEWAY_OMITTED_PAYLOAD_RECOVERY_INVOCATION_NAMESPACE,
    carrierRecoveryInvocationId,
  ) !== null;
}

/**
 * Durable reverse lookup used only by the Bridge's C39 carrier admission.
 * It returns no payload and requires the same live owner tuple that created
 * the admission; malformed or stale rows are deliberately indistinguishable.
 */
export async function readOmittedPayloadRecoveryByInvocation(
  tx: StoreTransaction,
  owner: OmittedPayloadRecoveryCurrentOwner,
  carrierRecoveryInvocationId: string,
): Promise<OmittedPayloadRecoveryRecord | null> {
  if (!validOwner(owner) || owner.active !== true || !isGatewayUuidV7(carrierRecoveryInvocationId)) return null;
  const index = await tx.read<GatewayJsonValue>(
    GATEWAY_OMITTED_PAYLOAD_RECOVERY_INVOCATION_NAMESPACE,
    carrierRecoveryInvocationId,
  );
  const indexValue = index?.value;
  if (
    indexValue === null || typeof indexValue !== "object" || Array.isArray(indexValue) ||
    (indexValue as { tenantId?: unknown }).tenantId !== owner.tenantId ||
    typeof (indexValue as { originInvocationId?: unknown }).originInvocationId !== "string"
  ) return null;
  const originInvocationId = (indexValue as { originInvocationId: string }).originInvocationId;
  const stored = await tx.read<GatewayJsonValue>(GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE, originInvocationId);
  const record = stored === null ? null : parseRecord(stored.value, owner.tenantId, originInvocationId);
  return record !== null && record.carrierRecoveryInvocationId === carrierRecoveryInvocationId &&
    record.owner.userId === owner.userId &&
    record.owner.effectiveMcpSessionId === owner.effectiveMcpSessionId &&
    record.owner.rsid === owner.rsid &&
    record.owner.sessionBindingId === owner.sessionBindingId &&
    record.owner.sessionVersion === owner.sessionVersion &&
    record.expiresAtMs > owner.nowMs ? record : null;
}

/**
 * A later authority-owned lookup may mark the exact admitted origin complete.
 * It cannot change owner/origin binding and cannot dispatch the origin.
 */
export async function completeOmittedPayloadRecovery(
  tx: StoreTransaction,
  admission: OmittedPayloadRecoveryAdmission,
  currentOwner: OmittedPayloadRecoveryCurrentOwner,
  resultReferenceDigest: `sha256:${string}`,
): Promise<OmittedPayloadRecoveryClaim> {
  if (!validAdmission(admission) || !validCurrentOwner(currentOwner, admission) || !DIGEST.test(resultReferenceDigest)) {
    return Object.freeze({ kind: "guarded" as const });
  }
  const key = keyFor(admission.originInvocationId);
  const stored = await tx.read<GatewayJsonValue>(GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE, key);
  if (stored === null) return Object.freeze({ kind: "guarded" as const });
  const record = parseRecord(stored.value, admission.owner.tenantId, key);
  if (record === null || !sameBinding(record, admission) || record.expiresAtMs <= currentOwner.nowMs) return Object.freeze({ kind: "guarded" as const });
  if (record.state === "completed") {
    return record.resultReferenceDigest === resultReferenceDigest
      ? Object.freeze({ kind: "completed" as const, record })
      : Object.freeze({ kind: "guarded" as const });
  }
  const next: OmittedPayloadRecoveryRecord = Object.freeze({
    ...record,
    state: "completed",
    resultReferenceDigest,
    updatedAtMs: Math.max(currentOwner.nowMs, record.updatedAtMs + 1),
  });
  tx.stage({
    namespace: GATEWAY_OMITTED_PAYLOAD_RECOVERY_NAMESPACE,
    key,
    value: next as unknown as GatewayJsonValue,
    expect: { kind: "version", version: stored.version },
  });
  return Object.freeze({ kind: "completed" as const, record: next });
}
