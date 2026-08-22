import { createHash, timingSafeEqual } from "node:crypto";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  isCanonicalMachineFingerprint,
  machineFingerprintClaimsEqual,
  type AuthContext,
  type DeviceAuthContext,
  type GatewayMachineFingerprint,
  type IdentityPort,
} from "./authContext.js";
import type { GatewayJsonValue } from "./dispatch.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import type {
  GatewayProtocolStore,
  StoreErrorCode,
  StoreOutcome,
  StoreTransaction,
  StoredRecord,
} from "./store.js";

export const IDENTITY_DEVICE_SCHEMA = "identity.device/v2" as const;
export const IDENTITY_TENANT_SEAT_SCHEMA = "identity.tenant-seat/v1" as const;
export const IDENTITY_REVOCATION_HEAD_SCHEMA =
  "identity.revocation-head/v1" as const;
export const IDENTITY_REVOCATION_EVENT_SCHEMA =
  "identity.revocation-event/v1" as const;
export const GATEWAY_REVOCATION_CURSOR_SCHEMA =
  "gateway.revocation-cursor/v1" as const;
export const GATEWAY_CREDENTIAL_SCOPE_SCHEMA =
  "gateway.credential-scope/v1" as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:@-]+$/u;
const CAPABILITY_PATTERN = /^[a-z0-9_.:-]+$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_CAPABILITY_BYTES = 128;
const MAX_TOKEN_BYTES = 4_096;
const DEFAULT_MAX_RESYNC_DEVICES = 10_000;
const DEFAULT_MAX_RESYNC_SEATS = 10_000;
const DEFAULT_MAX_CONSUME_EVENTS = 1_000;
const EMPTY_SHA256 = Buffer.alloc(32);
const CREDENTIAL_SCOPE_STORE_TENANT = "gateway-credential-scope-global";

type Sha256Digest = `sha256:${string}`;

export type IdentityDeviceStatus = "active" | "revoked";
export type IdentityTenantSeatStatus =
  | "available"
  | "active"
  | "denied"
  | "revoked";
export type IdentityRevocationAction =
  | "device_revoked"
  | "seat_revoked"
  | "seat_reassigned";
export type IdentityCursorBlockReason =
  | "cursor_ahead"
  | "event_missing"
  | "event_out_of_order"
  | "event_corrupt";

interface VersionedIdentityRecord {
  readonly tenantId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly recordVersion: number;
}

export interface IdentityDeviceV2 extends VersionedIdentityRecord {
  readonly schema: typeof IDENTITY_DEVICE_SCHEMA;
  readonly userId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly machineFingerprint: GatewayMachineFingerprint;
  readonly deviceTokenDigest: Sha256Digest;
  readonly status: IdentityDeviceStatus;
  readonly authorizationVersion: number;
  readonly connectionCapabilityVersion: number;
  readonly sessionCapabilityVersion: number;
  readonly allowedConnectionCapabilities: readonly string[];
  readonly allowedSessionCapabilities: readonly string[];
  readonly lastAuthorityOperationId: string;
  readonly lastAuthorityOperationDigest: Sha256Digest;
  readonly lastAuthoritySequence: number;
}

export interface IdentityTenantSeatV1 extends VersionedIdentityRecord {
  readonly schema: typeof IDENTITY_TENANT_SEAT_SCHEMA;
  readonly seatId: string;
  readonly userId: string;
  readonly deviceId: string | null;
  readonly status: IdentityTenantSeatStatus;
  readonly seatAuthorityVersion: number;
  readonly lastAuthorityOperationId: string;
  readonly lastAuthorityOperationDigest: Sha256Digest;
  readonly lastAuthoritySequence: number;
}

export interface IdentityRevocationHeadV1 extends VersionedIdentityRecord {
  readonly schema: typeof IDENTITY_REVOCATION_HEAD_SCHEMA;
  readonly lastSequence: number;
}

export interface IdentityRevocationEventV1 extends VersionedIdentityRecord {
  readonly schema: typeof IDENTITY_REVOCATION_EVENT_SCHEMA;
  readonly sequence: number;
  readonly deviceId: string | null;
  readonly seatId: string | null;
  readonly action: IdentityRevocationAction;
  readonly authorizationVersion: number | null;
  readonly seatAuthorityVersion: number | null;
  readonly priorDeviceTokenDigest: Sha256Digest | null;
  readonly deviceTokenDigest: Sha256Digest | null;
  readonly operationId: string;
  readonly operationDigest: Sha256Digest;
  readonly committedAtMs: number;
}

export interface GatewayRevocationCursorV1 extends VersionedIdentityRecord {
  readonly schema: typeof GATEWAY_REVOCATION_CURSOR_SCHEMA;
  readonly subscriberId: string;
  readonly lastContiguousSequence: number;
  readonly lastResyncHead: number;
  readonly lastResyncDigest: Sha256Digest | null;
  readonly status: "current" | "blocked";
  readonly blockedReason: IdentityCursorBlockReason | null;
}

export interface GatewayCredentialScopeV1 extends VersionedIdentityRecord {
  readonly schema: typeof GATEWAY_CREDENTIAL_SCOPE_SCHEMA;
  readonly deviceTokenDigest: Sha256Digest;
  readonly deviceId: string;
  readonly state: "active" | "retired";
  readonly lastOperationId: string;
  readonly lastOperationDigest: Sha256Digest;
}

export interface ProductionCredentialScope {
  readonly tenantId: string;
  readonly deviceId: string;
}

/**
 * Durable global digest index. It is a credential-boundary hint, never final
 * authority: the tenant device/seat/head/cursor transaction must still agree.
 */
export interface CredentialScopeFailure {
  readonly ok: false;
  readonly kind: "invalid_input" | "conflict" | "unavailable" | "corrupt";
  readonly code:
    | "invalid_input"
    | "credential_scope_conflict"
    | "credential_scope_corrupt"
    | StoreErrorCode;
  readonly message: string;
}

export type CredentialScopeLookupResult =
  | {
      readonly ok: true;
      readonly kind: "active" | "retired";
      readonly record: GatewayCredentialScopeV1;
    }
  | { readonly ok: true; readonly kind: "missing" | "ambiguous" }
  | CredentialScopeFailure;

export type CredentialScopeMutationResult =
  | {
      readonly ok: true;
      readonly kind: "committed" | "replay";
      readonly record: GatewayCredentialScopeV1;
    }
  | CredentialScopeFailure;

export interface ProductionCredentialScopeLocator {
  readonly kind: GatewayProtocolStore["kind"];
  open(): Promise<StoreOutcome<void>>;
  close(): Promise<StoreOutcome<void>>;
  lookup(input: {
    readonly deviceTokenDigest: string;
  }): Promise<CredentialScopeLookupResult>;
  bind(input: {
    readonly operationId: string;
    readonly deviceTokenDigest: string;
    readonly tenantId: string;
    readonly deviceId: string;
  }): Promise<CredentialScopeMutationResult>;
  retire(input: {
    readonly operationId: string;
    readonly deviceTokenDigest: string;
    readonly expectedRecordVersion: number;
  }): Promise<CredentialScopeMutationResult>;
}

export interface ProductionCredentialScopeLocatorOptions {
  readonly store: GatewayProtocolStore;
  readonly clock: () => number;
}

export interface ProductionIdentityStoreOptions {
  readonly store: GatewayProtocolStore;
  readonly credentialLocator: ProductionCredentialScopeLocator;
  readonly subscriberId: string;
  readonly clock: () => number;
  readonly northIdentity?: Pick<IdentityPort, "authenticateNorthRequest">;
  readonly maxResyncDevices?: number;
  readonly maxResyncSeats?: number;
}

export type ProductionIdentityLifecycleState =
  | "closed"
  | "opening"
  | "open"
  | "closing"
  | "failed";

export type ProductionIdentityLifecycleStage =
  | "tenant_open"
  | "locator_open"
  | "tenant_open_rollback"
  | "locator_close"
  | "tenant_close";

export interface ProductionIdentityLifecycleSnapshot {
  readonly state: ProductionIdentityLifecycleState;
  readonly tenantAuthorityOpened: boolean;
  readonly credentialLocatorOpened: boolean;
}

/** Durable production authentication always carries the full authority tuple. */
export interface ProductionDeviceAuthContext extends DeviceAuthContext {
  readonly machineFingerprint: GatewayMachineFingerprint;
  readonly authorizationVersion: number;
  readonly identityRecordVersion: number;
  readonly connectionCapabilityVersion: number;
  readonly sessionCapabilityVersion: number;
  readonly seatAuthorityVersion: number;
  readonly seatRecordVersion: number;
  readonly grantedConnectionCapabilities: readonly string[];
}

export interface ProvisionIdentityDeviceInput {
  readonly operationId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly deviceToken: string;
  readonly machineFingerprint: string;
  readonly allowedConnectionCapabilities: readonly string[];
  readonly allowedSessionCapabilities: readonly string[];
  /** `null` asserts absence; a number authorizes replacement of that version. */
  readonly expectedDeviceRecordVersion: number | null;
  readonly expectedSeatRecordVersion: number | null;
}

export interface RevokeIdentityDeviceInput {
  readonly operationId: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly expectedDeviceRecordVersion: number;
  readonly expectedSeatRecordVersion: number;
}

export interface RevokeIdentitySeatInput {
  readonly operationId: string;
  readonly tenantId: string;
  readonly seatId: string;
  readonly expectedSeatRecordVersion: number;
  readonly expectedDeviceRecordVersion: number | null;
}

export interface IdentityAuthorityChange {
  readonly device: IdentityDeviceV2 | null;
  readonly seat: IdentityTenantSeatV1;
  readonly head: IdentityRevocationHeadV1;
  readonly event: IdentityRevocationEventV1;
}

export interface IdentityOperationFailure {
  readonly ok: false;
  readonly kind: "invalid_input" | "conflict" | "unavailable" | "corrupt";
  readonly code:
    | "invalid_input"
    | "authority_conflict"
    | "corrupt_authority"
    | StoreErrorCode;
  readonly message: string;
}

export interface IdentityReconciliationRequired {
  readonly ok: false;
  readonly kind: "reconciliation_required";
  readonly code: "credential_scope_reconciliation_required";
  readonly message: string;
  readonly change: IdentityAuthorityChange;
}

export type IdentityMutationResult =
  | {
      readonly ok: true;
      readonly kind: "committed" | "replay" | "recovered";
      readonly change: IdentityAuthorityChange;
    }
  | IdentityReconciliationRequired
  | IdentityOperationFailure;

export interface IdentityResyncSnapshot {
  readonly tenantId: string;
  readonly headSequence: number;
  readonly authorityDigest: Sha256Digest;
  readonly devices: readonly IdentityDeviceV2[];
  readonly seats: readonly IdentityTenantSeatV1[];
}

export type IdentityResyncPrepareResult =
  | { readonly ok: true; readonly snapshot: IdentityResyncSnapshot }
  | IdentityOperationFailure;

export type IdentityResyncCommitResult =
  | {
      readonly ok: true;
      readonly kind: "committed";
      readonly snapshot: IdentityResyncSnapshot;
      readonly cursor: GatewayRevocationCursorV1;
    }
  | IdentityOperationFailure;

export type IdentityRevocationConsumeResult =
  | {
      readonly ok: true;
      readonly kind: "current" | "advanced";
      readonly headSequence: number;
      readonly complete: boolean;
      readonly events: readonly IdentityRevocationEventV1[];
      readonly cursor: GatewayRevocationCursorV1;
    }
  | {
      readonly ok: true;
      readonly kind: "blocked";
      readonly headSequence: number;
      readonly reason: IdentityCursorBlockReason;
      readonly events: readonly [];
      readonly cursor: GatewayRevocationCursorV1;
    }
  | IdentityOperationFailure;

export interface ProductionIdentityAuthority extends IdentityPort {
  readonly kind: "oidc";
  authenticateDevice(input: {
    readonly deviceToken: string | undefined;
    readonly connectionId: string;
    readonly claimedDeviceId?: string;
    readonly establishedScope?: ProductionCredentialScope;
    readonly machineFingerprint?: string;
    readonly machineHostname?: string;
  }): Promise<GatewayPortResult<ProductionDeviceAuthContext>>;
  open(): Promise<StoreOutcome<void>>;
  close(): Promise<StoreOutcome<void>>;
  lifecycle(): ProductionIdentityLifecycleSnapshot;
  provisionDevice(
    input: ProvisionIdentityDeviceInput,
  ): Promise<IdentityMutationResult>;
  revokeDevice(input: RevokeIdentityDeviceInput): Promise<IdentityMutationResult>;
  revokeSeat(input: RevokeIdentitySeatInput): Promise<IdentityMutationResult>;
  consumeRevocationEvents(input: {
    readonly tenantId: string;
    readonly maxEvents?: number;
  }): Promise<IdentityRevocationConsumeResult>;
  prepareTenantResync(input: {
    readonly tenantId: string;
  }): Promise<IdentityResyncPrepareResult>;
  commitTenantResync(input: {
    readonly tenantId: string;
    readonly expectedAuthorityDigest: string;
  }): Promise<IdentityResyncCommitResult>;
}

class CorruptIdentityAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptIdentityAuthorityError";
  }
}

function failure(
  kind: IdentityOperationFailure["kind"],
  code: IdentityOperationFailure["code"],
  message: string,
): IdentityOperationFailure {
  return Object.freeze({ ok: false as const, kind, code, message });
}

function invalidInput(): IdentityOperationFailure {
  return failure(
    "invalid_input",
    "invalid_input",
    "production identity input is invalid",
  );
}

function authorityConflict(message = "identity authority CAS conflict"): IdentityOperationFailure {
  return failure("conflict", "authority_conflict", message);
}

function corruptAuthority(message = "identity authority is corrupt"): IdentityOperationFailure {
  return failure("corrupt", "corrupt_authority", message);
}

function storeFailure(code: StoreErrorCode, message: string): IdentityOperationFailure {
  if (code === "conflict") return authorityConflict();
  if (code === "invalid_record" || code === "tenant_isolation_violation") {
    return corruptAuthority();
  }
  return failure("unavailable", code, message);
}

type FailedStoreOutcome = Extract<StoreOutcome<void>, { readonly ok: false }>;

function lifecycleSuccess(): StoreOutcome<void> {
  return Object.freeze({ ok: true as const, value: undefined });
}

function lifecycleFailure(
  operation: "open" | "close",
  failures: readonly {
    readonly stage: ProductionIdentityLifecycleStage;
    readonly outcome: FailedStoreOutcome;
  }[],
): FailedStoreOutcome {
  const code = failures.some(
    (failure) => failure.outcome.code === "durability_uncertain",
  )
    ? "durability_uncertain"
    : (failures[0]?.outcome.code ?? "unavailable");
  const stages = failures
    .slice(0, 3)
    .map((failure) => `${failure.stage}:${failure.outcome.code}`)
    .join(",");
  return Object.freeze({
    ok: false as const,
    code,
    message: `production identity lifecycle ${operation} failed [${stages}]`.slice(
      0,
      256,
    ),
  });
}

function identityRefusal(): GatewayPortResult<never> {
  return Object.freeze({
    ok: false as const,
    port: "identity" as const,
    code: "unavailable" as const,
    message: "production identity refused device authorization",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function isOpaqueToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES &&
    [...value].every((character) => character >= "!" && character <= "~")
  );
}

function canonicalCapabilities(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        Buffer.byteLength(entry, "utf8") > MAX_CAPABILITY_BYTES ||
        !CAPABILITY_PATTERN.test(entry),
    )
  ) {
    return null;
  }
  const canonical = [...new Set(value as string[])].sort();
  if (
    canonical.length !== value.length ||
    canonical.some((entry, index) => entry !== value[index])
  ) {
    return null;
  }
  return Object.freeze(canonical);
}

function canonicalizeCapabilities(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        Buffer.byteLength(entry, "utf8") > MAX_CAPABILITY_BYTES ||
        !CAPABILITY_PATTERN.test(entry),
    )
  ) {
    return null;
  }
  return Object.freeze([...new Set(value as string[])].sort());
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function digestEqual(left: unknown, right: unknown): boolean {
  const leftValid = isSha256Digest(left);
  const rightValid = isSha256Digest(right);
  const leftBytes = leftValid
    ? Buffer.from(left.slice("sha256:".length), "hex")
    : EMPTY_SHA256;
  const rightBytes = rightValid
    ? Buffer.from(right.slice("sha256:".length), "hex")
    : EMPTY_SHA256;
  const equal = timingSafeEqual(leftBytes, rightBytes);
  return leftValid && rightValid && equal;
}

function sha256(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function tokenDigest(value: string): Sha256Digest {
  return sha256(value);
}

function safeIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new CorruptIdentityAuthorityError("identity authority version overflow");
  }
  return value + 1;
}

function asJson(value: unknown): GatewayJsonValue {
  return structuredClone(value) as GatewayJsonValue;
}

function deviceKey(tenantId: string, deviceId: string): string {
  return `${tenantId}/${deviceId}`;
}

function seatKey(tenantId: string, seatId: string): string {
  return `${tenantId}/${seatId}`;
}

function headKey(tenantId: string): string {
  return tenantId;
}

function eventKey(tenantId: string, sequence: number): string {
  return `${tenantId}/${sequence}`;
}

function cursorKey(tenantId: string, subscriberId: string): string {
  return `${tenantId}/${subscriberId}`;
}

function assertStoredEnvelope(
  stored: StoredRecord,
  namespace: string,
  tenantId: string,
  key: string,
): void {
  if (
    stored.namespace !== namespace ||
    stored.tenantId !== tenantId ||
    stored.key !== key ||
    !isSafePositiveInteger(stored.version) ||
    !isSafeNonNegativeInteger(stored.updatedAtMs)
  ) {
    throw new CorruptIdentityAuthorityError("identity stored envelope mismatch");
  }
}

const VERSIONED_KEYS = ["tenantId", "createdAtMs", "updatedAtMs", "recordVersion"];

function validVersioned(
  value: Record<string, unknown>,
  tenantId: string,
): boolean {
  return (
    value.tenantId === tenantId &&
    isSafeNonNegativeInteger(value.createdAtMs) &&
    isSafeNonNegativeInteger(value.updatedAtMs) &&
    (value.updatedAtMs as number) >= (value.createdAtMs as number) &&
    isSafePositiveInteger(value.recordVersion)
  );
}

function parseDevice(
  stored: StoredRecord,
  tenantId: string,
  expectedDeviceId?: string,
): IdentityDeviceV2 {
  const value = stored.value;
  if (!isRecord(value)) throw new CorruptIdentityAuthorityError("malformed device record");
  const keys = [
    ...VERSIONED_KEYS,
    "schema",
    "userId",
    "deviceId",
    "seatId",
    "machineFingerprint",
    "deviceTokenDigest",
    "status",
    "authorizationVersion",
    "connectionCapabilityVersion",
    "sessionCapabilityVersion",
    "allowedConnectionCapabilities",
    "allowedSessionCapabilities",
    "lastAuthorityOperationId",
    "lastAuthorityOperationDigest",
    "lastAuthoritySequence",
  ];
  const connectionCapabilities = canonicalCapabilities(
    value.allowedConnectionCapabilities,
  );
  const sessionCapabilities = canonicalCapabilities(value.allowedSessionCapabilities);
  if (
    !hasExactKeys(value, keys) ||
    !validVersioned(value, tenantId) ||
    value.schema !== IDENTITY_DEVICE_SCHEMA ||
    !isIdentifier(value.userId) ||
    !isIdentifier(value.deviceId) ||
    (expectedDeviceId !== undefined && value.deviceId !== expectedDeviceId) ||
    !isIdentifier(value.seatId) ||
    !isCanonicalMachineFingerprint(value.machineFingerprint) ||
    !isSha256Digest(value.deviceTokenDigest) ||
    (value.status !== "active" && value.status !== "revoked") ||
    !isSafePositiveInteger(value.authorizationVersion) ||
    !isSafePositiveInteger(value.connectionCapabilityVersion) ||
    !isSafePositiveInteger(value.sessionCapabilityVersion) ||
    connectionCapabilities === null ||
    sessionCapabilities === null ||
    !isIdentifier(value.lastAuthorityOperationId) ||
    !isSha256Digest(value.lastAuthorityOperationDigest) ||
    !isSafePositiveInteger(value.lastAuthoritySequence)
  ) {
    throw new CorruptIdentityAuthorityError("malformed device record");
  }
  assertStoredEnvelope(
    stored,
    IDENTITY_DEVICE_SCHEMA,
    tenantId,
    deviceKey(tenantId, value.deviceId),
  );
  return Object.freeze({
    ...(value as unknown as IdentityDeviceV2),
    allowedConnectionCapabilities: connectionCapabilities,
    allowedSessionCapabilities: sessionCapabilities,
  });
}

function parseSeat(
  stored: StoredRecord,
  tenantId: string,
  expectedSeatId?: string,
): IdentityTenantSeatV1 {
  const value = stored.value;
  if (!isRecord(value)) throw new CorruptIdentityAuthorityError("malformed seat record");
  const keys = [
    ...VERSIONED_KEYS,
    "schema",
    "seatId",
    "userId",
    "deviceId",
    "status",
    "seatAuthorityVersion",
    "lastAuthorityOperationId",
    "lastAuthorityOperationDigest",
    "lastAuthoritySequence",
  ];
  if (
    !hasExactKeys(value, keys) ||
    !validVersioned(value, tenantId) ||
    value.schema !== IDENTITY_TENANT_SEAT_SCHEMA ||
    !isIdentifier(value.seatId) ||
    (expectedSeatId !== undefined && value.seatId !== expectedSeatId) ||
    !isIdentifier(value.userId) ||
    (value.deviceId !== null && !isIdentifier(value.deviceId)) ||
    !["available", "active", "denied", "revoked"].includes(
      value.status as string,
    ) ||
    !isSafePositiveInteger(value.seatAuthorityVersion) ||
    !isIdentifier(value.lastAuthorityOperationId) ||
    !isSha256Digest(value.lastAuthorityOperationDigest) ||
    !isSafePositiveInteger(value.lastAuthoritySequence) ||
    (value.status === "active" && value.deviceId === null) ||
    (value.status === "available" && value.deviceId !== null)
  ) {
    throw new CorruptIdentityAuthorityError("malformed seat record");
  }
  assertStoredEnvelope(
    stored,
    IDENTITY_TENANT_SEAT_SCHEMA,
    tenantId,
    seatKey(tenantId, value.seatId),
  );
  return Object.freeze(value as unknown as IdentityTenantSeatV1);
}

function parseHead(
  stored: StoredRecord,
  tenantId: string,
): IdentityRevocationHeadV1 {
  const value = stored.value;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [...VERSIONED_KEYS, "schema", "lastSequence"]) ||
    !validVersioned(value, tenantId) ||
    value.schema !== IDENTITY_REVOCATION_HEAD_SCHEMA ||
    !isSafeNonNegativeInteger(value.lastSequence)
  ) {
    throw new CorruptIdentityAuthorityError("malformed revocation head");
  }
  assertStoredEnvelope(
    stored,
    IDENTITY_REVOCATION_HEAD_SCHEMA,
    tenantId,
    headKey(tenantId),
  );
  return Object.freeze(value as unknown as IdentityRevocationHeadV1);
}

function parseEvent(
  stored: StoredRecord,
  tenantId: string,
  expectedSequence: number,
): IdentityRevocationEventV1 {
  const value = stored.value;
  const keys = [
    ...VERSIONED_KEYS,
    "schema",
    "sequence",
    "deviceId",
    "seatId",
    "action",
    "authorizationVersion",
    "seatAuthorityVersion",
    "priorDeviceTokenDigest",
    "deviceTokenDigest",
    "operationId",
    "operationDigest",
    "committedAtMs",
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    !validVersioned(value, tenantId) ||
    value.schema !== IDENTITY_REVOCATION_EVENT_SCHEMA ||
    value.sequence !== expectedSequence ||
    !isSafePositiveInteger(value.sequence) ||
    (value.deviceId !== null && !isIdentifier(value.deviceId)) ||
    (value.seatId !== null && !isIdentifier(value.seatId)) ||
    !["device_revoked", "seat_revoked", "seat_reassigned"].includes(
      value.action as string,
    ) ||
    (value.authorizationVersion !== null &&
      !isSafePositiveInteger(value.authorizationVersion)) ||
    (value.seatAuthorityVersion !== null &&
      !isSafePositiveInteger(value.seatAuthorityVersion)) ||
    (value.priorDeviceTokenDigest !== null &&
      !isSha256Digest(value.priorDeviceTokenDigest)) ||
    (value.deviceTokenDigest !== null &&
      !isSha256Digest(value.deviceTokenDigest)) ||
    !isIdentifier(value.operationId) ||
    !isSha256Digest(value.operationDigest) ||
    !isSafeNonNegativeInteger(value.committedAtMs) ||
    value.createdAtMs !== value.committedAtMs ||
    value.updatedAtMs !== value.committedAtMs ||
    (value.deviceId === null &&
      (value.authorizationVersion !== null ||
        value.priorDeviceTokenDigest !== null ||
        value.deviceTokenDigest !== null)) ||
    (value.deviceId !== null &&
      (value.authorizationVersion === null || value.deviceTokenDigest === null)) ||
    (value.action === "device_revoked" &&
      (value.deviceId === null ||
        value.seatId === null ||
        value.authorizationVersion === null ||
        value.seatAuthorityVersion === null ||
        value.deviceTokenDigest === null)) ||
    (value.action === "seat_reassigned" &&
      (value.deviceId === null ||
        value.seatId === null ||
        value.authorizationVersion === null ||
        value.seatAuthorityVersion === null ||
        value.deviceTokenDigest === null)) ||
    (value.action === "seat_reassigned" &&
      ((value.authorizationVersion === 1 &&
        value.priorDeviceTokenDigest !== null) ||
        ((value.authorizationVersion as number) > 1 &&
          value.priorDeviceTokenDigest === null))) ||
    (value.action !== "seat_reassigned" &&
      value.deviceId !== null &&
      !digestEqual(value.priorDeviceTokenDigest, value.deviceTokenDigest)) ||
    (value.action === "seat_revoked" &&
      (value.seatId === null || value.seatAuthorityVersion === null))
  ) {
    throw new CorruptIdentityAuthorityError("malformed revocation event");
  }
  assertStoredEnvelope(
    stored,
    IDENTITY_REVOCATION_EVENT_SCHEMA,
    tenantId,
    eventKey(tenantId, expectedSequence),
  );
  return Object.freeze(value as unknown as IdentityRevocationEventV1);
}

function parseCursor(
  stored: StoredRecord,
  tenantId: string,
  subscriberId: string,
): GatewayRevocationCursorV1 {
  const value = stored.value;
  const keys = [
    ...VERSIONED_KEYS,
    "schema",
    "subscriberId",
    "lastContiguousSequence",
    "lastResyncHead",
    "lastResyncDigest",
    "status",
    "blockedReason",
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    !validVersioned(value, tenantId) ||
    value.schema !== GATEWAY_REVOCATION_CURSOR_SCHEMA ||
    value.subscriberId !== subscriberId ||
    !isSafeNonNegativeInteger(value.lastContiguousSequence) ||
    !isSafeNonNegativeInteger(value.lastResyncHead) ||
    (value.lastResyncDigest !== null && !isSha256Digest(value.lastResyncDigest)) ||
    (value.status !== "current" && value.status !== "blocked") ||
    (value.blockedReason !== null &&
      !["cursor_ahead", "event_missing", "event_out_of_order", "event_corrupt"].includes(
        value.blockedReason as string,
      )) ||
    (value.status === "current" && value.blockedReason !== null) ||
    (value.status === "blocked" && value.blockedReason === null)
  ) {
    throw new CorruptIdentityAuthorityError("malformed revocation cursor");
  }
  assertStoredEnvelope(
    stored,
    GATEWAY_REVOCATION_CURSOR_SCHEMA,
    tenantId,
    cursorKey(tenantId, subscriberId),
  );
  return Object.freeze(value as unknown as GatewayRevocationCursorV1);
}

function parseCredentialScope(
  stored: StoredRecord,
  expectedDigest: Sha256Digest,
): GatewayCredentialScopeV1 {
  const value = stored.value;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      ...VERSIONED_KEYS,
      "schema",
      "deviceTokenDigest",
      "deviceId",
      "state",
      "lastOperationId",
      "lastOperationDigest",
    ]) ||
    !isIdentifier(value.tenantId) ||
    !validVersioned(value, value.tenantId) ||
    value.schema !== GATEWAY_CREDENTIAL_SCOPE_SCHEMA ||
    value.deviceTokenDigest !== expectedDigest ||
    !isSha256Digest(value.deviceTokenDigest) ||
    !isIdentifier(value.deviceId) ||
    (value.state !== "active" && value.state !== "retired") ||
    !isIdentifier(value.lastOperationId) ||
    !isSha256Digest(value.lastOperationDigest)
  ) {
    throw new CorruptIdentityAuthorityError("malformed credential scope record");
  }
  assertStoredEnvelope(
    stored,
    GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
    CREDENTIAL_SCOPE_STORE_TENANT,
    expectedDigest,
  );
  return Object.freeze(value as unknown as GatewayCredentialScopeV1);
}

function stageRecord(
  tx: StoreTransaction,
  namespace: string,
  key: string,
  value: unknown,
  stored: StoredRecord | null,
): void {
  tx.stage({
    namespace,
    key,
    value: asJson(value),
    expect:
      stored === null
        ? { kind: "absent" as const }
        : { kind: "version" as const, version: stored.version },
  });
}

function operationDigest(kind: string, value: unknown): Sha256Digest {
  return sha256(JSON.stringify({ schema: "identity.authority-operation/v1", kind, value }));
}

function credentialFailure(
  kind: CredentialScopeFailure["kind"],
  code: CredentialScopeFailure["code"],
  message: string,
): CredentialScopeFailure {
  return Object.freeze({ ok: false as const, kind, code, message });
}

function credentialStoreFailure(
  code: StoreErrorCode,
  message: string,
): CredentialScopeFailure {
  if (code === "conflict") {
    return credentialFailure(
      "conflict",
      "credential_scope_conflict",
      "credential scope CAS conflict",
    );
  }
  if (code === "invalid_record" || code === "tenant_isolation_violation") {
    return credentialFailure(
      "corrupt",
      "credential_scope_corrupt",
      "credential scope authority is corrupt",
    );
  }
  return credentialFailure("unavailable", code, message);
}

class StoreBackedProductionCredentialScopeLocator
  implements ProductionCredentialScopeLocator
{
  public readonly kind: GatewayProtocolStore["kind"];

  readonly #store: GatewayProtocolStore;
  readonly #clock: () => number;

  constructor(options: ProductionCredentialScopeLocatorOptions) {
    if (typeof options.clock !== "function") {
      throw new TypeError("credential scope locator configuration is invalid");
    }
    this.#store = options.store;
    this.#clock = options.clock;
    this.kind = options.store.kind;
  }

  public open(): Promise<StoreOutcome<void>> {
    return this.#store.open();
  }

  public close(): Promise<StoreOutcome<void>> {
    return this.#store.close();
  }

  #now(): number {
    const value = this.#clock();
    if (!isSafeNonNegativeInteger(value)) {
      throw new TypeError("credential scope locator clock is invalid");
    }
    return value;
  }

  public async lookup(input: {
    readonly deviceTokenDigest: string;
  }): Promise<CredentialScopeLookupResult> {
    if (!isRecord(input) || !isSha256Digest(input.deviceTokenDigest)) {
      return credentialFailure(
        "invalid_input",
        "invalid_input",
        "credential scope input is invalid",
      );
    }
    const deviceTokenDigest = input.deviceTokenDigest as Sha256Digest;
    const outcome = await this.#store.transact(
      { tenantId: CREDENTIAL_SCOPE_STORE_TENANT },
      async (tx): Promise<CredentialScopeLookupResult> => {
        const stored = await tx.read(
          GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
          deviceTokenDigest,
        );
        if (stored === null) {
          return Object.freeze({ ok: true as const, kind: "missing" as const });
        }
        const record = parseCredentialScope(stored, deviceTokenDigest);
        return Object.freeze({
          ok: true as const,
          kind: record.state,
          record,
        });
      },
    );
    return outcome.ok
      ? outcome.value
      : credentialStoreFailure(outcome.code, outcome.message);
  }

  public async bind(input: {
    readonly operationId: string;
    readonly deviceTokenDigest: string;
    readonly tenantId: string;
    readonly deviceId: string;
  }): Promise<CredentialScopeMutationResult> {
    if (
      !isRecord(input) ||
      !isIdentifier(input.operationId) ||
      !isSha256Digest(input.deviceTokenDigest) ||
      !isIdentifier(input.tenantId) ||
      !isIdentifier(input.deviceId)
    ) {
      return credentialFailure(
        "invalid_input",
        "invalid_input",
        "credential scope input is invalid",
      );
    }
    const deviceTokenDigest = input.deviceTokenDigest as Sha256Digest;
    const requestDigest = operationDigest("credential_scope_bind", {
      deviceTokenDigest,
      tenantId: input.tenantId,
      deviceId: input.deviceId,
    });
    const outcome = await this.#store.transact(
      { tenantId: CREDENTIAL_SCOPE_STORE_TENANT },
      async (tx): Promise<CredentialScopeMutationResult> => {
        const stored = await tx.read(
          GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
          deviceTokenDigest,
        );
        if (stored !== null) {
          const current = parseCredentialScope(stored, deviceTokenDigest);
          if (
            current.state === "active" &&
            current.tenantId === input.tenantId &&
            current.deviceId === input.deviceId &&
            current.lastOperationId === input.operationId &&
            digestEqual(current.lastOperationDigest, requestDigest)
          ) {
            return Object.freeze({
              ok: true as const,
              kind: "replay" as const,
              record: current,
            });
          }
          return credentialFailure(
            "conflict",
            "credential_scope_conflict",
            "credential scope is already bound or retired",
          );
        }
        const nowMs = this.#now();
        const record: GatewayCredentialScopeV1 = Object.freeze({
          schema: GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
          tenantId: input.tenantId,
          deviceTokenDigest,
          deviceId: input.deviceId,
          state: "active",
          lastOperationId: input.operationId,
          lastOperationDigest: requestDigest,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          recordVersion: 1,
        });
        stageRecord(
          tx,
          GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
          deviceTokenDigest,
          record,
          null,
        );
        return Object.freeze({
          ok: true as const,
          kind: "committed" as const,
          record,
        });
      },
    );
    return outcome.ok
      ? outcome.value
      : credentialStoreFailure(outcome.code, outcome.message);
  }

  public async retire(input: {
    readonly operationId: string;
    readonly deviceTokenDigest: string;
    readonly expectedRecordVersion: number;
  }): Promise<CredentialScopeMutationResult> {
    if (
      !isRecord(input) ||
      !isIdentifier(input.operationId) ||
      !isSha256Digest(input.deviceTokenDigest) ||
      !isSafePositiveInteger(input.expectedRecordVersion)
    ) {
      return credentialFailure(
        "invalid_input",
        "invalid_input",
        "credential scope input is invalid",
      );
    }
    const deviceTokenDigest = input.deviceTokenDigest as Sha256Digest;
    const requestDigest = operationDigest("credential_scope_retire", {
      deviceTokenDigest,
      expectedRecordVersion: input.expectedRecordVersion,
    });
    const outcome = await this.#store.transact(
      { tenantId: CREDENTIAL_SCOPE_STORE_TENANT },
      async (tx): Promise<CredentialScopeMutationResult> => {
        const stored = await tx.read(
          GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
          deviceTokenDigest,
        );
        if (stored === null) {
          return credentialFailure(
            "conflict",
            "credential_scope_conflict",
            "credential scope is missing",
          );
        }
        const current = parseCredentialScope(stored, deviceTokenDigest);
        if (
          current.state === "retired" &&
          current.lastOperationId === input.operationId &&
          digestEqual(current.lastOperationDigest, requestDigest)
        ) {
          return Object.freeze({
            ok: true as const,
            kind: "replay" as const,
            record: current,
          });
        }
        if (
          current.state !== "active" ||
          current.recordVersion !== input.expectedRecordVersion
        ) {
          return credentialFailure(
            "conflict",
            "credential_scope_conflict",
            "credential scope retire CAS conflict",
          );
        }
        const record: GatewayCredentialScopeV1 = Object.freeze({
          ...current,
          state: "retired",
          lastOperationId: input.operationId,
          lastOperationDigest: requestDigest,
          updatedAtMs: this.#now(),
          recordVersion: safeIncrement(current.recordVersion),
        });
        stageRecord(
          tx,
          GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
          deviceTokenDigest,
          record,
          stored,
        );
        return Object.freeze({
          ok: true as const,
          kind: "committed" as const,
          record,
        });
      },
    );
    return outcome.ok
      ? outcome.value
      : credentialStoreFailure(outcome.code, outcome.message);
  }
}

function requestIsExactReplay(
  operationId: string,
  digest: Sha256Digest,
  record: Pick<
    IdentityDeviceV2 | IdentityTenantSeatV1,
    "lastAuthorityOperationId" | "lastAuthorityOperationDigest"
  >,
): boolean {
  return (
    record.lastAuthorityOperationId === operationId &&
    digestEqual(record.lastAuthorityOperationDigest, digest)
  );
}

function operationIdWasReused(
  operationId: string,
  digest: Sha256Digest,
  record: Pick<
    IdentityDeviceV2 | IdentityTenantSeatV1,
    "lastAuthorityOperationId" | "lastAuthorityOperationDigest"
  >,
): boolean {
  return (
    record.lastAuthorityOperationId === operationId &&
    !digestEqual(record.lastAuthorityOperationDigest, digest)
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPairCoherence(
  device: IdentityDeviceV2,
  seat: IdentityTenantSeatV1,
  headSequence: number,
): void {
  if (
    device.seatId !== seat.seatId ||
    device.userId !== seat.userId ||
    seat.deviceId !== device.deviceId ||
    device.lastAuthoritySequence !== seat.lastAuthoritySequence ||
    device.lastAuthoritySequence > headSequence
  ) {
    throw new CorruptIdentityAuthorityError(
      "device and seat authority versions are incoherent",
    );
  }
}

function assertChangeCoherence(change: IdentityAuthorityChange): void {
  const { device, seat, head, event } = change;
  assertSeatEventCoherence(seat, event, head.lastSequence);
  if (device === null) {
    if (
      event.action !== "seat_revoked" ||
      seat.status !== "revoked" ||
      event.deviceId !== null ||
      event.authorizationVersion !== null
    ) {
      throw new CorruptIdentityAuthorityError(
        "device-free authority event carries device state",
      );
    }
    return;
  }
  assertPairCoherence(device, seat, head.lastSequence);
  assertDeviceEventCoherence(device, event, head.lastSequence);
  if (
    (event.action === "seat_reassigned" &&
      (device.status !== "active" || seat.status !== "active")) ||
    (event.action === "device_revoked" &&
      (device.status !== "revoked" || seat.status !== "revoked")) ||
    (event.action === "seat_revoked" &&
      (device.status !== "revoked" || seat.status !== "revoked"))
  ) {
    throw new CorruptIdentityAuthorityError(
      "authority event action does not match touched record state",
    );
  }
}

function assertSeatEventCoherence(
  seat: IdentityTenantSeatV1,
  event: IdentityRevocationEventV1,
  headSequence: number,
): void {
  if (
    seat.lastAuthoritySequence !== event.sequence ||
    event.sequence > headSequence ||
    event.seatId !== seat.seatId ||
    seat.seatAuthorityVersion !== event.seatAuthorityVersion ||
    seat.lastAuthorityOperationId !== event.operationId ||
    !digestEqual(seat.lastAuthorityOperationDigest, event.operationDigest)
  ) {
    throw new CorruptIdentityAuthorityError(
      "seat authority does not match its event",
    );
  }
}

function assertDeviceEventCoherence(
  device: IdentityDeviceV2,
  event: IdentityRevocationEventV1,
  headSequence: number,
): void {
  if (
    device.lastAuthoritySequence !== event.sequence ||
    event.sequence > headSequence ||
    event.deviceId !== device.deviceId ||
    event.seatId !== device.seatId ||
    device.authorizationVersion !== event.authorizationVersion ||
    !digestEqual(device.deviceTokenDigest, event.deviceTokenDigest) ||
    device.lastAuthorityOperationId !== event.operationId ||
    !digestEqual(device.lastAuthorityOperationDigest, event.operationDigest)
  ) {
    throw new CorruptIdentityAuthorityError(
      "device authority does not match its event",
    );
  }
}

function frozenChange(change: IdentityAuthorityChange): IdentityAuthorityChange {
  assertChangeCoherence(change);
  return Object.freeze({
    device: change.device === null ? null : Object.freeze(structuredClone(change.device)),
    seat: Object.freeze(structuredClone(change.seat)),
    head: Object.freeze(structuredClone(change.head)),
    event: Object.freeze(structuredClone(change.event)),
  });
}

function mutationSuccess(
  kind: "committed" | "replay" | "recovered",
  change: IdentityAuthorityChange,
): IdentityMutationResult {
  return Object.freeze({ ok: true as const, kind, change: frozenChange(change) });
}

function reconciliationRequired(
  change: IdentityAuthorityChange,
): IdentityReconciliationRequired {
  return Object.freeze({
    ok: false as const,
    kind: "reconciliation_required" as const,
    code: "credential_scope_reconciliation_required" as const,
    message:
      "tenant identity authority committed but credential scope reconciliation is required",
    change: frozenChange(change),
  });
}

function makeHead(
  tenantId: string,
  prior: IdentityRevocationHeadV1 | null,
  nowMs: number,
  nextSequence: number,
): IdentityRevocationHeadV1 {
  return Object.freeze({
    schema: IDENTITY_REVOCATION_HEAD_SCHEMA,
    tenantId,
    lastSequence: nextSequence,
    createdAtMs: prior?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
    recordVersion: prior === null ? 1 : safeIncrement(prior.recordVersion),
  });
}

function makeCursor(
  tenantId: string,
  subscriberId: string,
  prior: GatewayRevocationCursorV1 | null,
  nowMs: number,
  input: Pick<
    GatewayRevocationCursorV1,
    | "lastContiguousSequence"
    | "lastResyncHead"
    | "lastResyncDigest"
    | "status"
    | "blockedReason"
  >,
): GatewayRevocationCursorV1 {
  return Object.freeze({
    schema: GATEWAY_REVOCATION_CURSOR_SCHEMA,
    tenantId,
    subscriberId,
    ...input,
    createdAtMs: prior?.createdAtMs ?? nowMs,
    updatedAtMs: nowMs,
    recordVersion: prior === null ? 1 : safeIncrement(prior.recordVersion),
  });
}

interface LoadedAuthoritySnapshot {
  readonly headStored: StoredRecord | null;
  readonly head: IdentityRevocationHeadV1 | null;
  readonly devices: readonly IdentityDeviceV2[];
  readonly seats: readonly IdentityTenantSeatV1[];
  readonly digest: Sha256Digest;
}

function authorityDigest(
  tenantId: string,
  headSequence: number,
  devices: readonly IdentityDeviceV2[],
  seats: readonly IdentityTenantSeatV1[],
): Sha256Digest {
  const projectedDevices = devices.map((record) => ({
    userId: record.userId,
    deviceId: record.deviceId,
    seatId: record.seatId,
    machineFingerprint: record.machineFingerprint,
    deviceTokenDigest: record.deviceTokenDigest,
    status: record.status,
    authorizationVersion: record.authorizationVersion,
    connectionCapabilityVersion: record.connectionCapabilityVersion,
    sessionCapabilityVersion: record.sessionCapabilityVersion,
    allowedConnectionCapabilities: record.allowedConnectionCapabilities,
    allowedSessionCapabilities: record.allowedSessionCapabilities,
    lastAuthorityOperationId: record.lastAuthorityOperationId,
    lastAuthorityOperationDigest: record.lastAuthorityOperationDigest,
    lastAuthoritySequence: record.lastAuthoritySequence,
    recordVersion: record.recordVersion,
  }));
  const projectedSeats = seats.map((record) => ({
    seatId: record.seatId,
    userId: record.userId,
    deviceId: record.deviceId,
    status: record.status,
    seatAuthorityVersion: record.seatAuthorityVersion,
    lastAuthorityOperationId: record.lastAuthorityOperationId,
    lastAuthorityOperationDigest: record.lastAuthorityOperationDigest,
    lastAuthoritySequence: record.lastAuthoritySequence,
    recordVersion: record.recordVersion,
  }));
  return sha256(
    JSON.stringify({
      schema: "identity.authority-resync/v1",
      tenantId,
      headSequence,
      devices: projectedDevices,
      seats: projectedSeats,
    }),
  );
}

async function loadAuthoritySnapshot(
  tx: StoreTransaction,
  tenantId: string,
  maxDevices: number,
  maxSeats: number,
): Promise<LoadedAuthoritySnapshot> {
  const headStored = await tx.read(IDENTITY_REVOCATION_HEAD_SCHEMA, headKey(tenantId));
  const head = headStored === null ? null : parseHead(headStored, tenantId);
  const rawDevices = await tx.list(IDENTITY_DEVICE_SCHEMA);
  const rawSeats = await tx.list(IDENTITY_TENANT_SEAT_SCHEMA);
  if (rawDevices.length > maxDevices || rawSeats.length > maxSeats) {
    throw new CorruptIdentityAuthorityError("bounded identity resync limit exceeded");
  }
  const devices = rawDevices
    .map((record) => parseDevice(record, tenantId))
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  const seats = rawSeats
    .map((record) => parseSeat(record, tenantId))
    .sort((left, right) => left.seatId.localeCompare(right.seatId));
  if (head === null && (devices.length > 0 || seats.length > 0)) {
    throw new CorruptIdentityAuthorityError("identity authority has records without a head");
  }
  const deviceIds = new Set(devices.map((record) => record.deviceId));
  const seatIds = new Set(seats.map((record) => record.seatId));
  if (deviceIds.size !== devices.length || seatIds.size !== seats.length) {
    throw new CorruptIdentityAuthorityError("duplicate identity authority key");
  }
  const devicesById = new Map(devices.map((record) => [record.deviceId, record]));
  const seatsById = new Map(seats.map((record) => [record.seatId, record]));
  const headSequence = head?.lastSequence ?? 0;
  const eventsBySequence = new Map<number, IdentityRevocationEventV1>();
  const eventFor = async (sequence: number): Promise<IdentityRevocationEventV1> => {
    const cached = eventsBySequence.get(sequence);
    if (cached !== undefined) return cached;
    const stored = await tx.read(
      IDENTITY_REVOCATION_EVENT_SCHEMA,
      eventKey(tenantId, sequence),
    );
    if (stored === null) {
      throw new CorruptIdentityAuthorityError(
        "identity authority record event is missing",
      );
    }
    const event = parseEvent(stored, tenantId, sequence);
    eventsBySequence.set(sequence, event);
    return event;
  };
  let highestAuthoritySequence = 0;
  for (const device of devices) {
    highestAuthoritySequence = Math.max(
      highestAuthoritySequence,
      device.lastAuthoritySequence,
    );
    const deviceEvent = await eventFor(device.lastAuthoritySequence);
    const seat = seatsById.get(device.seatId);
    if (
      device.status === "active" &&
      (seat === undefined ||
        seat.status !== "active" ||
        seat.deviceId !== device.deviceId ||
        seat.userId !== device.userId)
    ) {
      throw new CorruptIdentityAuthorityError("active device has no active seat");
    }
    if (
      device.status === "revoked" &&
      seat?.deviceId === device.deviceId &&
      seat.status === "active"
    ) {
      throw new CorruptIdentityAuthorityError("revoked device retains an active seat");
    }
    if (seat?.deviceId === device.deviceId) {
      if (head === null) {
        throw new CorruptIdentityAuthorityError(
          "paired identity authority has no head",
        );
      }
      assertChangeCoherence({ device, seat, head, event: deviceEvent });
    } else {
      assertDeviceEventCoherence(device, deviceEvent, headSequence);
    }
  }
  for (const seat of seats) {
    highestAuthoritySequence = Math.max(
      highestAuthoritySequence,
      seat.lastAuthoritySequence,
    );
    const seatEvent = await eventFor(seat.lastAuthoritySequence);
    if (seat.deviceId === null) {
      if (head === null) {
        throw new CorruptIdentityAuthorityError(
          "seat-only identity authority has no head",
        );
      }
      assertChangeCoherence({ device: null, seat, head, event: seatEvent });
    } else {
      assertSeatEventCoherence(seat, seatEvent, headSequence);
    }
    if (seat.deviceId !== null && !devicesById.has(seat.deviceId)) {
      throw new CorruptIdentityAuthorityError(
        "seat references a missing device authority",
      );
    }
    if (seat.status !== "active") continue;
    const device = seat.deviceId === null ? undefined : devicesById.get(seat.deviceId);
    if (
      device === undefined ||
      device.status !== "active" ||
      device.seatId !== seat.seatId ||
      device.userId !== seat.userId
    ) {
      throw new CorruptIdentityAuthorityError("active seat has no active device");
    }
  }
  if (highestAuthoritySequence > headSequence) {
    throw new CorruptIdentityAuthorityError("identity authority sequence exceeds head");
  }
  if (headSequence > 0 && highestAuthoritySequence !== headSequence) {
    throw new CorruptIdentityAuthorityError(
      "identity authority head has no touched record at its sequence",
    );
  }
  return {
    headStored,
    head,
    devices: Object.freeze(devices),
    seats: Object.freeze(seats),
    digest: authorityDigest(tenantId, headSequence, devices, seats),
  };
}

function publicSnapshot(
  tenantId: string,
  loaded: LoadedAuthoritySnapshot,
): IdentityResyncSnapshot {
  return Object.freeze({
    tenantId,
    headSequence: loaded.head?.lastSequence ?? 0,
    authorityDigest: loaded.digest,
    devices: Object.freeze(loaded.devices.map((record) => Object.freeze(structuredClone(record)))),
    seats: Object.freeze(loaded.seats.map((record) => Object.freeze(structuredClone(record)))),
  });
}

class StoreBackedProductionIdentityAuthority implements ProductionIdentityAuthority {
  public readonly kind = "oidc" as const;

  readonly #store: GatewayProtocolStore;
  readonly #credentialLocator: ProductionCredentialScopeLocator;
  readonly #subscriberId: string;
  readonly #clock: () => number;
  readonly #northIdentity: Pick<IdentityPort, "authenticateNorthRequest"> | undefined;
  readonly #maxResyncDevices: number;
  readonly #maxResyncSeats: number;
  #lifecycleState: ProductionIdentityLifecycleState = "closed";
  #tenantAuthorityOpened = false;
  #credentialLocatorOpened = false;
  #openPromise: Promise<StoreOutcome<void>> | null = null;
  #closePromise: Promise<StoreOutcome<void>> | null = null;
  #lastLifecycleFailure: FailedStoreOutcome | null = null;

  constructor(options: ProductionIdentityStoreOptions) {
    if (
      !isIdentifier(options.subscriberId) ||
      typeof options.clock !== "function" ||
      !isRecord(options.credentialLocator) ||
      typeof options.credentialLocator.open !== "function" ||
      typeof options.credentialLocator.close !== "function" ||
      typeof options.credentialLocator.lookup !== "function" ||
      typeof options.credentialLocator.bind !== "function" ||
      typeof options.credentialLocator.retire !== "function" ||
      !isSafePositiveInteger(options.maxResyncDevices ?? DEFAULT_MAX_RESYNC_DEVICES) ||
      !isSafePositiveInteger(options.maxResyncSeats ?? DEFAULT_MAX_RESYNC_SEATS)
    ) {
      throw new TypeError("production identity configuration is invalid");
    }
    this.#store = options.store;
    this.#credentialLocator = options.credentialLocator;
    this.#subscriberId = options.subscriberId;
    this.#clock = options.clock;
    this.#northIdentity = options.northIdentity;
    this.#maxResyncDevices = options.maxResyncDevices ?? DEFAULT_MAX_RESYNC_DEVICES;
    this.#maxResyncSeats = options.maxResyncSeats ?? DEFAULT_MAX_RESYNC_SEATS;
  }

  public lifecycle(): ProductionIdentityLifecycleSnapshot {
    return Object.freeze({
      state: this.#lifecycleState,
      tenantAuthorityOpened: this.#tenantAuthorityOpened,
      credentialLocatorOpened: this.#credentialLocatorOpened,
    });
  }

  public open(): Promise<StoreOutcome<void>> {
    if (this.#lifecycleState === "open") return Promise.resolve(lifecycleSuccess());
    if (this.#openPromise !== null) return this.#openPromise;
    if (
      this.#lifecycleState === "closing" ||
      this.#lifecycleState === "failed"
    ) {
      return Promise.resolve(
        this.#lastLifecycleFailure ??
          lifecycleFailure("open", [
            {
              stage: "tenant_open",
              outcome: {
                ok: false,
                code: "unavailable",
                message: "lifecycle is not openable",
              },
            },
          ]),
      );
    }
    this.#openPromise = this.#performOpen();
    return this.#openPromise;
  }

  async #performOpen(): Promise<StoreOutcome<void>> {
    this.#lifecycleState = "opening";
    this.#lastLifecycleFailure = null;
    try {
      let authority: StoreOutcome<void>;
      try {
        authority = await this.#store.open();
      } catch {
        authority = {
          ok: false,
          code: "unavailable",
          message: "tenant authority open threw",
        };
      }
      if (!authority.ok) {
        const failed = lifecycleFailure("open", [
          { stage: "tenant_open", outcome: authority },
        ]);
        this.#lifecycleState = "failed";
        this.#lastLifecycleFailure = failed;
        return failed;
      }
      this.#tenantAuthorityOpened = true;

      let locator: StoreOutcome<void>;
      try {
        locator = await this.#credentialLocator.open();
      } catch {
        locator = {
          ok: false,
          code: "unavailable",
          message: "credential locator open threw",
        };
      }
      if (!locator.ok) {
        let rollback: StoreOutcome<void>;
        try {
          rollback = await this.#store.close();
        } catch {
          rollback = {
            ok: false,
            code: "unavailable",
            message: "tenant authority rollback threw",
          };
        }
        if (rollback.ok) this.#tenantAuthorityOpened = false;
        const failures = [
          { stage: "locator_open" as const, outcome: locator },
          ...(rollback.ok
            ? []
            : [
                {
                  stage: "tenant_open_rollback" as const,
                  outcome: rollback,
                },
              ]),
        ];
        const failed = lifecycleFailure("open", failures);
        this.#lifecycleState = rollback.ok ? "closed" : "failed";
        this.#lastLifecycleFailure = rollback.ok ? null : failed;
        return failed;
      }
      this.#credentialLocatorOpened = true;
      this.#lifecycleState = "open";
      return lifecycleSuccess();
    } finally {
      this.#openPromise = null;
    }
  }

  public close(): Promise<StoreOutcome<void>> {
    if (this.#lifecycleState === "closed") {
      return Promise.resolve(lifecycleSuccess());
    }
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#lifecycleState === "opening") {
      return Promise.resolve(
        lifecycleFailure("close", [
          {
            stage: "locator_close",
            outcome: {
              ok: false,
              code: "unavailable",
              message: "lifecycle is opening",
            },
          },
        ]),
      );
    }
    if (
      this.#lifecycleState === "failed" &&
      !this.#tenantAuthorityOpened &&
      !this.#credentialLocatorOpened &&
      this.#lastLifecycleFailure !== null
    ) {
      return Promise.resolve(this.#lastLifecycleFailure);
    }
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<StoreOutcome<void>> {
    this.#lifecycleState = "closing";
    const failures: {
      stage: ProductionIdentityLifecycleStage;
      outcome: FailedStoreOutcome;
    }[] = [];
    try {
      if (this.#credentialLocatorOpened) {
        let locator: StoreOutcome<void>;
        try {
          locator = await this.#credentialLocator.close();
        } catch {
          locator = {
            ok: false,
            code: "unavailable",
            message: "credential locator close threw",
          };
        }
        this.#credentialLocatorOpened = false;
        if (!locator.ok) failures.push({ stage: "locator_close", outcome: locator });
      }
      if (this.#tenantAuthorityOpened) {
        let authority: StoreOutcome<void>;
        try {
          authority = await this.#store.close();
        } catch {
          authority = {
            ok: false,
            code: "unavailable",
            message: "tenant authority close threw",
          };
        }
        this.#tenantAuthorityOpened = false;
        if (!authority.ok) failures.push({ stage: "tenant_close", outcome: authority });
      }
      if (failures.length > 0) {
        const failed = lifecycleFailure("close", failures);
        this.#lifecycleState = "failed";
        this.#lastLifecycleFailure = failed;
        return failed;
      }
      this.#lifecycleState = "closed";
      this.#lastLifecycleFailure = null;
      return lifecycleSuccess();
    } finally {
      this.#closePromise = null;
    }
  }

  public async authenticateNorthRequest(input: {
    readonly authorization: string | undefined;
  }): Promise<GatewayPortResult<AuthContext>> {
    if (this.#lifecycleState !== "open") return identityRefusal();
    if (this.#northIdentity === undefined) {
      return Object.freeze({
        ok: false as const,
        port: "identity" as const,
        code: "not_configured" as const,
        message: "production north identity is not configured",
      });
    }
    return this.#northIdentity.authenticateNorthRequest(input);
  }

  async #resolveScope(input: {
    readonly deviceTokenDigest: Sha256Digest;
    readonly claimedDeviceId: string;
    readonly establishedScope?: ProductionCredentialScope;
  }): Promise<ProductionCredentialScope | null> {
    if (input.establishedScope !== undefined) {
      if (
        !isIdentifier(input.establishedScope.tenantId) ||
        !isIdentifier(input.establishedScope.deviceId) ||
        input.establishedScope.deviceId !== input.claimedDeviceId
      ) {
        return null;
      }
      return Object.freeze({
        tenantId: input.establishedScope.tenantId,
        deviceId: input.establishedScope.deviceId,
      });
    }
    const resolved = await this.#credentialLocator.lookup({
      deviceTokenDigest: input.deviceTokenDigest,
    });
    const locatorRecord = resolved.ok && "record" in resolved
      ? resolved.record
      : null;
    if (
      !resolved.ok ||
      resolved.kind !== "active" ||
      locatorRecord === null ||
      !isRecord(locatorRecord) ||
      !hasExactKeys(locatorRecord, [
        ...VERSIONED_KEYS,
        "schema",
        "deviceTokenDigest",
        "deviceId",
        "state",
        "lastOperationId",
        "lastOperationDigest",
      ]) ||
      locatorRecord.schema !== GATEWAY_CREDENTIAL_SCOPE_SCHEMA ||
      locatorRecord.state !== "active" ||
      !isIdentifier(locatorRecord.tenantId) ||
      !validVersioned(locatorRecord, locatorRecord.tenantId) ||
      !digestEqual(locatorRecord.deviceTokenDigest, input.deviceTokenDigest) ||
      !isIdentifier(locatorRecord.deviceId) ||
      locatorRecord.deviceId !== input.claimedDeviceId ||
      !isIdentifier(locatorRecord.lastOperationId) ||
      !isSha256Digest(locatorRecord.lastOperationDigest)
    ) {
      return null;
    }
    return Object.freeze({
      tenantId: locatorRecord.tenantId,
      deviceId: locatorRecord.deviceId,
    });
  }

  public async authenticateDevice(input: {
    readonly deviceToken: string | undefined;
    readonly connectionId: string;
    readonly claimedDeviceId?: string;
    readonly establishedScope?: ProductionCredentialScope;
    readonly machineFingerprint?: string;
    readonly machineHostname?: string;
  }): Promise<GatewayPortResult<ProductionDeviceAuthContext>> {
    if (!isRecord(input)) return identityRefusal();
    if (this.#lifecycleState !== "open") return identityRefusal();
    if (
      !isOpaqueToken(input.deviceToken) ||
      !isIdentifier(input.connectionId) ||
      !isIdentifier(input.claimedDeviceId) ||
      "tenantId" in input ||
      "deviceId" in input ||
      !isCanonicalMachineFingerprint(input.machineFingerprint)
    ) {
      return identityRefusal();
    }
    const digest = tokenDigest(input.deviceToken);
    let scope: ProductionCredentialScope | null;
    try {
      scope = await this.#resolveScope({
        deviceTokenDigest: digest,
        claimedDeviceId: input.claimedDeviceId,
        ...(input.establishedScope === undefined
          ? {}
          : { establishedScope: input.establishedScope }),
      });
    } catch {
      return identityRefusal();
    }
    if (scope === null) return identityRefusal();

    const outcome = await this.#store.transact(
      { tenantId: scope.tenantId },
      async (tx): Promise<ProductionDeviceAuthContext | null> => {
        const headStored = await tx.read(
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(scope.tenantId),
        );
        const cursorStored = await tx.read(
          GATEWAY_REVOCATION_CURSOR_SCHEMA,
          cursorKey(scope.tenantId, this.#subscriberId),
        );
        const deviceStored = await tx.read(
          IDENTITY_DEVICE_SCHEMA,
          deviceKey(scope.tenantId, scope.deviceId),
        );
        if (headStored === null || cursorStored === null || deviceStored === null) {
          return null;
        }
        const head = parseHead(headStored, scope.tenantId);
        const cursor = parseCursor(
          cursorStored,
          scope.tenantId,
          this.#subscriberId,
        );
        const device = parseDevice(deviceStored, scope.tenantId, scope.deviceId);
        const seatStored = await tx.read(
          IDENTITY_TENANT_SEAT_SCHEMA,
          seatKey(scope.tenantId, device.seatId),
        );
        if (seatStored === null) return null;
        const seat = parseSeat(seatStored, scope.tenantId, device.seatId);
        assertPairCoherence(device, seat, head.lastSequence);
        const eventStored = await tx.read(
          IDENTITY_REVOCATION_EVENT_SCHEMA,
          eventKey(scope.tenantId, device.lastAuthoritySequence),
        );
        if (eventStored === null) return null;
        assertChangeCoherence({
          device,
          seat,
          head,
          event: parseEvent(
            eventStored,
            scope.tenantId,
            device.lastAuthoritySequence,
          ),
        });
        if (
          cursor.status !== "current" ||
          cursor.lastContiguousSequence !== head.lastSequence ||
          seat.deviceId !== device.deviceId ||
          seat.userId !== device.userId ||
          !digestEqual(device.deviceTokenDigest, digest) ||
          !machineFingerprintClaimsEqual(
            device.machineFingerprint,
            input.machineFingerprint,
          ) ||
          (device.status === "revoked" && seat.status === "active")
        ) {
          return null;
        }
        const deviceStatus: DeviceAuthContext["deviceStatus"] =
          device.status === "revoked"
            ? "revoked"
            : seat.status === "active"
              ? "active"
              : "seat_denied";
        return Object.freeze({
          contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
          actor: Object.freeze({
            type: "device" as const,
            tenantId: device.tenantId,
            userId: device.userId,
            deviceId: device.deviceId,
            seatId: device.seatId,
          }),
          connectionId: input.connectionId,
          deviceStatus,
          machineFingerprint: device.machineFingerprint,
          authorizationVersion: device.authorizationVersion,
          identityRecordVersion: device.recordVersion,
          connectionCapabilityVersion: device.connectionCapabilityVersion,
          sessionCapabilityVersion: device.sessionCapabilityVersion,
          seatAuthorityVersion: seat.seatAuthorityVersion,
          seatRecordVersion: seat.recordVersion,
          grantedConnectionCapabilities: device.allowedConnectionCapabilities,
          grantedSessionCapabilities: device.allowedSessionCapabilities,
          deviceTokenDigest: device.deviceTokenDigest,
        });
      },
    );
    return outcome.ok && outcome.value !== null
      ? Object.freeze({ ok: true as const, value: outcome.value })
      : identityRefusal();
  }

  #now(): number {
    const value = this.#clock();
    if (!isSafeNonNegativeInteger(value)) {
      throw new TypeError("production identity clock is invalid");
    }
    return value;
  }

  async #loadReplayChange(
    tx: StoreTransaction,
    tenantId: string,
    sequence: number,
    device: IdentityDeviceV2 | null,
    seat: IdentityTenantSeatV1,
  ): Promise<IdentityAuthorityChange> {
    const headStored = await tx.read(IDENTITY_REVOCATION_HEAD_SCHEMA, headKey(tenantId));
    const eventStored = await tx.read(
      IDENTITY_REVOCATION_EVENT_SCHEMA,
      eventKey(tenantId, sequence),
    );
    if (headStored === null || eventStored === null) {
      throw new CorruptIdentityAuthorityError("idempotent authority event is missing");
    }
    const head = parseHead(headStored, tenantId);
    const event = parseEvent(eventStored, tenantId, sequence);
    if (head.lastSequence < sequence) {
      throw new CorruptIdentityAuthorityError("idempotent authority event exceeds head");
    }
    return { device, seat, head, event };
  }

  async #recoverPlannedChange(
    tenantId: string,
    planned: IdentityAuthorityChange,
  ): Promise<IdentityMutationResult> {
    const readback = await this.#store.transact(
      { tenantId },
      async (tx): Promise<boolean> => {
        const headStored = await tx.read(
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(tenantId),
        );
        const eventStored = await tx.read(
          IDENTITY_REVOCATION_EVENT_SCHEMA,
          eventKey(tenantId, planned.event.sequence),
        );
        const seatStored = await tx.read(
          IDENTITY_TENANT_SEAT_SCHEMA,
          seatKey(tenantId, planned.seat.seatId),
        );
        const deviceStored =
          planned.device === null
            ? null
            : await tx.read(
                IDENTITY_DEVICE_SCHEMA,
                deviceKey(tenantId, planned.device.deviceId),
              );
        if (
          headStored === null ||
          eventStored === null ||
          seatStored === null ||
          (planned.device !== null && deviceStored === null)
        ) {
          return false;
        }
        const head = parseHead(headStored, tenantId);
        const event = parseEvent(eventStored, tenantId, planned.event.sequence);
        const seat = parseSeat(seatStored, tenantId, planned.seat.seatId);
        const device =
          planned.device === null || deviceStored === null
            ? null
            : parseDevice(deviceStored, tenantId, planned.device.deviceId);
        return (
          deepEqual(head, planned.head) &&
          deepEqual(event, planned.event) &&
          deepEqual(seat, planned.seat) &&
          deepEqual(device, planned.device)
        );
      },
    );
    if (!readback.ok) return storeFailure(readback.code, readback.message);
    return readback.value
      ? mutationSuccess("recovered", planned)
      : failure(
          "unavailable",
          "durability_uncertain",
          "identity authority durability remains uncertain after exact readback",
        );
  }

  async #finishMutation(
    tenantId: string,
    outcome: StoreOutcome<IdentityMutationResult>,
    planned: IdentityAuthorityChange | null,
  ): Promise<IdentityMutationResult> {
    if (outcome.ok) return outcome.value;
    if (outcome.code === "durability_uncertain" && planned !== null) {
      return this.#recoverPlannedChange(tenantId, planned);
    }
    return storeFailure(outcome.code, outcome.message);
  }

  async #retireCredentialScope(input: {
    readonly operationId: string;
    readonly deviceTokenDigest: Sha256Digest;
    readonly tenantId: string;
    readonly deviceId: string;
  }): Promise<boolean> {
    const located = await this.#credentialLocator.lookup({
      deviceTokenDigest: input.deviceTokenDigest,
    });
    if (
      !located.ok ||
      (located.kind !== "active" && located.kind !== "retired") ||
      located.record.tenantId !== input.tenantId ||
      located.record.deviceId !== input.deviceId
    ) {
      return false;
    }
    const expectedRecordVersion =
      located.record.state === "retired"
        ? located.record.recordVersion - 1
        : located.record.recordVersion;
    if (!isSafePositiveInteger(expectedRecordVersion)) return false;
    const retired = await this.#credentialLocator.retire({
      operationId: input.operationId,
      deviceTokenDigest: input.deviceTokenDigest,
      expectedRecordVersion,
    });
    return retired.ok;
  }

  async #reconcileCredentialScope(
    result: IdentityMutationResult,
  ): Promise<IdentityMutationResult> {
    if (!result.ok) return result;
    const { change } = result;
    const { event, device } = change;
    if (device === null || event.deviceTokenDigest === null) return result;
    const scope = {
      tenantId: event.tenantId,
      deviceId: device.deviceId,
    };
    if (event.action === "seat_reassigned") {
      if (
        event.priorDeviceTokenDigest === null ||
        !digestEqual(event.priorDeviceTokenDigest, event.deviceTokenDigest)
      ) {
        const bound = await this.#credentialLocator.bind({
          operationId: event.operationId,
          deviceTokenDigest: event.deviceTokenDigest,
          ...scope,
        });
        if (!bound.ok) return reconciliationRequired(change);
      } else {
        const located = await this.#credentialLocator.lookup({
          deviceTokenDigest: event.deviceTokenDigest,
        });
        if (
          !located.ok ||
          located.kind !== "active" ||
          located.record.tenantId !== scope.tenantId ||
          located.record.deviceId !== scope.deviceId
        ) {
          return reconciliationRequired(change);
        }
      }
      if (
        event.priorDeviceTokenDigest !== null &&
        !digestEqual(event.priorDeviceTokenDigest, event.deviceTokenDigest) &&
        !(await this.#retireCredentialScope({
          operationId: event.operationId,
          deviceTokenDigest: event.priorDeviceTokenDigest,
          ...scope,
        }))
      ) {
        return reconciliationRequired(change);
      }
      return result;
    }
    return (await this.#retireCredentialScope({
      operationId: event.operationId,
      deviceTokenDigest: event.deviceTokenDigest,
      ...scope,
    }))
      ? result
      : reconciliationRequired(change);
  }

  public async provisionDevice(
    input: ProvisionIdentityDeviceInput,
  ): Promise<IdentityMutationResult> {
    if (!isRecord(input)) return invalidInput();
    let frozen: ProvisionIdentityDeviceInput;
    try {
      frozen = structuredClone(input);
    } catch {
      return invalidInput();
    }
    const connectionCapabilities = canonicalizeCapabilities(
      frozen.allowedConnectionCapabilities,
    );
    const sessionCapabilities = canonicalizeCapabilities(
      frozen.allowedSessionCapabilities,
    );
    if (
      !isIdentifier(frozen.operationId) ||
      !isIdentifier(frozen.tenantId) ||
      !isIdentifier(frozen.userId) ||
      !isIdentifier(frozen.deviceId) ||
      !isIdentifier(frozen.seatId) ||
      !isOpaqueToken(frozen.deviceToken) ||
      !isCanonicalMachineFingerprint(frozen.machineFingerprint) ||
      connectionCapabilities === null ||
      sessionCapabilities === null ||
      (frozen.expectedDeviceRecordVersion !== null &&
        !isSafePositiveInteger(frozen.expectedDeviceRecordVersion)) ||
      (frozen.expectedSeatRecordVersion !== null &&
        !isSafePositiveInteger(frozen.expectedSeatRecordVersion))
    ) {
      return invalidInput();
    }
    const digest = tokenDigest(frozen.deviceToken);
    const requestDigest = operationDigest("provision_device", {
      tenantId: frozen.tenantId,
      userId: frozen.userId,
      deviceId: frozen.deviceId,
      seatId: frozen.seatId,
      deviceTokenDigest: digest,
      machineFingerprint: frozen.machineFingerprint,
      allowedConnectionCapabilities: connectionCapabilities,
      allowedSessionCapabilities: sessionCapabilities,
      expectedDeviceRecordVersion: frozen.expectedDeviceRecordVersion,
      expectedSeatRecordVersion: frozen.expectedSeatRecordVersion,
    });
    let planned: IdentityAuthorityChange | null = null;
    const outcome = await this.#store.transact(
      { tenantId: frozen.tenantId },
      async (tx): Promise<IdentityMutationResult> => {
        const storedDevice = await tx.read(
          IDENTITY_DEVICE_SCHEMA,
          deviceKey(frozen.tenantId, frozen.deviceId),
        );
        const storedSeat = await tx.read(
          IDENTITY_TENANT_SEAT_SCHEMA,
          seatKey(frozen.tenantId, frozen.seatId),
        );
        const storedHead = await tx.read(
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(frozen.tenantId),
        );
        const device =
          storedDevice === null
            ? null
            : parseDevice(storedDevice, frozen.tenantId, frozen.deviceId);
        const seat =
          storedSeat === null
            ? null
            : parseSeat(storedSeat, frozen.tenantId, frozen.seatId);
        const head =
          storedHead === null ? null : parseHead(storedHead, frozen.tenantId);
        if (
          device !== null &&
          seat !== null &&
          requestIsExactReplay(frozen.operationId, requestDigest, device) &&
          requestIsExactReplay(frozen.operationId, requestDigest, seat)
        ) {
          const replay = await this.#loadReplayChange(
            tx,
            frozen.tenantId,
            device.lastAuthoritySequence,
            device,
            seat,
          );
          return mutationSuccess("replay", replay);
        }
        if (
          (device !== null &&
            operationIdWasReused(frozen.operationId, requestDigest, device)) ||
          (seat !== null &&
            operationIdWasReused(frozen.operationId, requestDigest, seat))
        ) {
          return authorityConflict("identity authority operation id was reused");
        }
        if (
          (device?.recordVersion ?? null) !== frozen.expectedDeviceRecordVersion ||
          (seat?.recordVersion ?? null) !== frozen.expectedSeatRecordVersion ||
          (device !== null && device.seatId !== frozen.seatId) ||
          (seat !== null &&
            seat.deviceId !== null &&
            seat.deviceId !== frozen.deviceId)
        ) {
          return authorityConflict();
        }
        if (head === null && (device !== null || seat !== null)) {
          throw new CorruptIdentityAuthorityError("identity record exists without head");
        }
        if (device !== null && seat === null) {
          throw new CorruptIdentityAuthorityError("device seat record is missing");
        }
        if (device !== null && seat !== null) {
          assertPairCoherence(device, seat, head?.lastSequence ?? 0);
        }
        const nowMs = this.#now();
        const sequence = safeIncrement(head?.lastSequence ?? 0);
        const nextDevice: IdentityDeviceV2 = Object.freeze({
          schema: IDENTITY_DEVICE_SCHEMA,
          tenantId: frozen.tenantId,
          userId: frozen.userId,
          deviceId: frozen.deviceId,
          seatId: frozen.seatId,
          machineFingerprint:
            frozen.machineFingerprint as GatewayMachineFingerprint,
          deviceTokenDigest: digest,
          status: "active",
          authorizationVersion:
            device === null ? 1 : safeIncrement(device.authorizationVersion),
          connectionCapabilityVersion:
            device === null
              ? 1
              : safeIncrement(device.connectionCapabilityVersion),
          sessionCapabilityVersion:
            device === null
              ? 1
              : safeIncrement(device.sessionCapabilityVersion),
          allowedConnectionCapabilities: connectionCapabilities,
          allowedSessionCapabilities: sessionCapabilities,
          lastAuthorityOperationId: frozen.operationId,
          lastAuthorityOperationDigest: requestDigest,
          lastAuthoritySequence: sequence,
          createdAtMs: device?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          recordVersion: device === null ? 1 : safeIncrement(device.recordVersion),
        });
        const nextSeat: IdentityTenantSeatV1 = Object.freeze({
          schema: IDENTITY_TENANT_SEAT_SCHEMA,
          tenantId: frozen.tenantId,
          seatId: frozen.seatId,
          userId: frozen.userId,
          deviceId: frozen.deviceId,
          status: "active",
          seatAuthorityVersion:
            seat === null ? 1 : safeIncrement(seat.seatAuthorityVersion),
          lastAuthorityOperationId: frozen.operationId,
          lastAuthorityOperationDigest: requestDigest,
          lastAuthoritySequence: sequence,
          createdAtMs: seat?.createdAtMs ?? nowMs,
          updatedAtMs: nowMs,
          recordVersion: seat === null ? 1 : safeIncrement(seat.recordVersion),
        });
        const nextHead = makeHead(frozen.tenantId, head, nowMs, sequence);
        const event: IdentityRevocationEventV1 = Object.freeze({
          schema: IDENTITY_REVOCATION_EVENT_SCHEMA,
          tenantId: frozen.tenantId,
          sequence,
          deviceId: frozen.deviceId,
          seatId: frozen.seatId,
          action: "seat_reassigned",
          authorizationVersion: nextDevice.authorizationVersion,
          seatAuthorityVersion: nextSeat.seatAuthorityVersion,
          priorDeviceTokenDigest: device?.deviceTokenDigest ?? null,
          deviceTokenDigest: nextDevice.deviceTokenDigest,
          operationId: frozen.operationId,
          operationDigest: requestDigest,
          committedAtMs: nowMs,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          recordVersion: 1,
        });
        planned = { device: nextDevice, seat: nextSeat, head: nextHead, event };
        stageRecord(
          tx,
          IDENTITY_DEVICE_SCHEMA,
          deviceKey(frozen.tenantId, frozen.deviceId),
          nextDevice,
          storedDevice,
        );
        stageRecord(
          tx,
          IDENTITY_TENANT_SEAT_SCHEMA,
          seatKey(frozen.tenantId, frozen.seatId),
          nextSeat,
          storedSeat,
        );
        stageRecord(
          tx,
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(frozen.tenantId),
          nextHead,
          storedHead,
        );
        stageRecord(
          tx,
          IDENTITY_REVOCATION_EVENT_SCHEMA,
          eventKey(frozen.tenantId, sequence),
          event,
          null,
        );
        return mutationSuccess("committed", planned);
      },
    );
    return this.#reconcileCredentialScope(
      await this.#finishMutation(frozen.tenantId, outcome, planned),
    );
  }

  public async revokeDevice(
    input: RevokeIdentityDeviceInput,
  ): Promise<IdentityMutationResult> {
    if (!isRecord(input)) return invalidInput();
    let frozen: RevokeIdentityDeviceInput;
    try {
      frozen = structuredClone(input);
    } catch {
      return invalidInput();
    }
    if (
      !isIdentifier(frozen.operationId) ||
      !isIdentifier(frozen.tenantId) ||
      !isIdentifier(frozen.deviceId) ||
      !isSafePositiveInteger(frozen.expectedDeviceRecordVersion) ||
      !isSafePositiveInteger(frozen.expectedSeatRecordVersion)
    ) {
      return invalidInput();
    }
    const requestDigest = operationDigest("revoke_device", frozen);
    let planned: IdentityAuthorityChange | null = null;
    const outcome = await this.#store.transact(
      { tenantId: frozen.tenantId },
      async (tx): Promise<IdentityMutationResult> => {
        const storedDevice = await tx.read(
          IDENTITY_DEVICE_SCHEMA,
          deviceKey(frozen.tenantId, frozen.deviceId),
        );
        if (storedDevice === null) return authorityConflict();
        const device = parseDevice(storedDevice, frozen.tenantId, frozen.deviceId);
        const storedSeat = await tx.read(
          IDENTITY_TENANT_SEAT_SCHEMA,
          seatKey(frozen.tenantId, device.seatId),
        );
        const storedHead = await tx.read(
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(frozen.tenantId),
        );
        if (storedSeat === null || storedHead === null) {
          throw new CorruptIdentityAuthorityError("device authority dependency is missing");
        }
        const seat = parseSeat(storedSeat, frozen.tenantId, device.seatId);
        const head = parseHead(storedHead, frozen.tenantId);
        assertPairCoherence(device, seat, head.lastSequence);
        if (
          requestIsExactReplay(frozen.operationId, requestDigest, device) &&
          requestIsExactReplay(frozen.operationId, requestDigest, seat)
        ) {
          const replay = await this.#loadReplayChange(
            tx,
            frozen.tenantId,
            device.lastAuthoritySequence,
            device,
            seat,
          );
          return mutationSuccess("replay", replay);
        }
        if (
          operationIdWasReused(frozen.operationId, requestDigest, device) ||
          operationIdWasReused(frozen.operationId, requestDigest, seat) ||
          device.status !== "active" ||
          device.recordVersion !== frozen.expectedDeviceRecordVersion ||
          seat.recordVersion !== frozen.expectedSeatRecordVersion ||
          seat.deviceId !== device.deviceId ||
          seat.userId !== device.userId
        ) {
          return authorityConflict();
        }
        const nowMs = this.#now();
        const sequence = safeIncrement(head.lastSequence);
        const nextDevice: IdentityDeviceV2 = Object.freeze({
          ...device,
          status: "revoked",
          authorizationVersion: safeIncrement(device.authorizationVersion),
          lastAuthorityOperationId: frozen.operationId,
          lastAuthorityOperationDigest: requestDigest,
          lastAuthoritySequence: sequence,
          updatedAtMs: nowMs,
          recordVersion: safeIncrement(device.recordVersion),
        });
        const nextSeat: IdentityTenantSeatV1 = Object.freeze({
          ...seat,
          status: "revoked",
          seatAuthorityVersion: safeIncrement(seat.seatAuthorityVersion),
          lastAuthorityOperationId: frozen.operationId,
          lastAuthorityOperationDigest: requestDigest,
          lastAuthoritySequence: sequence,
          updatedAtMs: nowMs,
          recordVersion: safeIncrement(seat.recordVersion),
        });
        const nextHead = makeHead(frozen.tenantId, head, nowMs, sequence);
        const event: IdentityRevocationEventV1 = Object.freeze({
          schema: IDENTITY_REVOCATION_EVENT_SCHEMA,
          tenantId: frozen.tenantId,
          sequence,
          deviceId: device.deviceId,
          seatId: seat.seatId,
          action: "device_revoked",
          authorizationVersion: nextDevice.authorizationVersion,
          seatAuthorityVersion: nextSeat.seatAuthorityVersion,
          priorDeviceTokenDigest: device.deviceTokenDigest,
          deviceTokenDigest: nextDevice.deviceTokenDigest,
          operationId: frozen.operationId,
          operationDigest: requestDigest,
          committedAtMs: nowMs,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          recordVersion: 1,
        });
        planned = { device: nextDevice, seat: nextSeat, head: nextHead, event };
        stageRecord(
          tx,
          IDENTITY_DEVICE_SCHEMA,
          deviceKey(frozen.tenantId, device.deviceId),
          nextDevice,
          storedDevice,
        );
        stageRecord(
          tx,
          IDENTITY_TENANT_SEAT_SCHEMA,
          seatKey(frozen.tenantId, seat.seatId),
          nextSeat,
          storedSeat,
        );
        stageRecord(
          tx,
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(frozen.tenantId),
          nextHead,
          storedHead,
        );
        stageRecord(
          tx,
          IDENTITY_REVOCATION_EVENT_SCHEMA,
          eventKey(frozen.tenantId, sequence),
          event,
          null,
        );
        return mutationSuccess("committed", planned);
      },
    );
    return this.#reconcileCredentialScope(
      await this.#finishMutation(frozen.tenantId, outcome, planned),
    );
  }

  public async revokeSeat(
    input: RevokeIdentitySeatInput,
  ): Promise<IdentityMutationResult> {
    if (!isRecord(input)) return invalidInput();
    let frozen: RevokeIdentitySeatInput;
    try {
      frozen = structuredClone(input);
    } catch {
      return invalidInput();
    }
    if (
      !isIdentifier(frozen.operationId) ||
      !isIdentifier(frozen.tenantId) ||
      !isIdentifier(frozen.seatId) ||
      !isSafePositiveInteger(frozen.expectedSeatRecordVersion) ||
      (frozen.expectedDeviceRecordVersion !== null &&
        !isSafePositiveInteger(frozen.expectedDeviceRecordVersion))
    ) {
      return invalidInput();
    }
    const requestDigest = operationDigest("revoke_seat", frozen);
    let planned: IdentityAuthorityChange | null = null;
    const outcome = await this.#store.transact(
      { tenantId: frozen.tenantId },
      async (tx): Promise<IdentityMutationResult> => {
        const storedSeat = await tx.read(
          IDENTITY_TENANT_SEAT_SCHEMA,
          seatKey(frozen.tenantId, frozen.seatId),
        );
        const storedHead = await tx.read(
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(frozen.tenantId),
        );
        if (storedSeat === null || storedHead === null) return authorityConflict();
        const seat = parseSeat(storedSeat, frozen.tenantId, frozen.seatId);
        const head = parseHead(storedHead, frozen.tenantId);
        const storedDevice =
          seat.deviceId === null
            ? null
            : await tx.read(
                IDENTITY_DEVICE_SCHEMA,
                deviceKey(frozen.tenantId, seat.deviceId),
              );
        const device =
          storedDevice === null
            ? null
            : parseDevice(storedDevice, frozen.tenantId, seat.deviceId ?? undefined);
        if (device !== null) {
          assertPairCoherence(device, seat, head.lastSequence);
        }
        if (
          requestIsExactReplay(frozen.operationId, requestDigest, seat) &&
          (device === null || requestIsExactReplay(frozen.operationId, requestDigest, device))
        ) {
          const replay = await this.#loadReplayChange(
            tx,
            frozen.tenantId,
            seat.lastAuthoritySequence,
            device,
            seat,
          );
          return mutationSuccess("replay", replay);
        }
        if (
          operationIdWasReused(frozen.operationId, requestDigest, seat) ||
          (device !== null &&
            operationIdWasReused(frozen.operationId, requestDigest, device)) ||
          seat.status === "revoked" ||
          seat.recordVersion !== frozen.expectedSeatRecordVersion ||
          (device?.recordVersion ?? null) !== frozen.expectedDeviceRecordVersion ||
          (seat.deviceId !== null && device === null) ||
          (device !== null &&
            (device.seatId !== seat.seatId || device.userId !== seat.userId))
        ) {
          return authorityConflict();
        }
        const nowMs = this.#now();
        const sequence = safeIncrement(head.lastSequence);
        const nextDevice: IdentityDeviceV2 | null =
          device === null
            ? null
            : Object.freeze({
                ...device,
                status: "revoked" as const,
                authorizationVersion: safeIncrement(device.authorizationVersion),
                lastAuthorityOperationId: frozen.operationId,
                lastAuthorityOperationDigest: requestDigest,
                lastAuthoritySequence: sequence,
                updatedAtMs: nowMs,
                recordVersion: safeIncrement(device.recordVersion),
              });
        const nextSeat: IdentityTenantSeatV1 = Object.freeze({
          ...seat,
          status: "revoked",
          seatAuthorityVersion: safeIncrement(seat.seatAuthorityVersion),
          lastAuthorityOperationId: frozen.operationId,
          lastAuthorityOperationDigest: requestDigest,
          lastAuthoritySequence: sequence,
          updatedAtMs: nowMs,
          recordVersion: safeIncrement(seat.recordVersion),
        });
        const nextHead = makeHead(frozen.tenantId, head, nowMs, sequence);
        const event: IdentityRevocationEventV1 = Object.freeze({
          schema: IDENTITY_REVOCATION_EVENT_SCHEMA,
          tenantId: frozen.tenantId,
          sequence,
          deviceId: nextDevice?.deviceId ?? null,
          seatId: seat.seatId,
          action: "seat_revoked",
          authorizationVersion: nextDevice?.authorizationVersion ?? null,
          seatAuthorityVersion: nextSeat.seatAuthorityVersion,
          priorDeviceTokenDigest: device?.deviceTokenDigest ?? null,
          deviceTokenDigest: nextDevice?.deviceTokenDigest ?? null,
          operationId: frozen.operationId,
          operationDigest: requestDigest,
          committedAtMs: nowMs,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          recordVersion: 1,
        });
        planned = { device: nextDevice, seat: nextSeat, head: nextHead, event };
        if (nextDevice !== null && storedDevice !== null) {
          stageRecord(
            tx,
            IDENTITY_DEVICE_SCHEMA,
            deviceKey(frozen.tenantId, nextDevice.deviceId),
            nextDevice,
            storedDevice,
          );
        }
        stageRecord(
          tx,
          IDENTITY_TENANT_SEAT_SCHEMA,
          seatKey(frozen.tenantId, seat.seatId),
          nextSeat,
          storedSeat,
        );
        stageRecord(
          tx,
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(frozen.tenantId),
          nextHead,
          storedHead,
        );
        stageRecord(
          tx,
          IDENTITY_REVOCATION_EVENT_SCHEMA,
          eventKey(frozen.tenantId, sequence),
          event,
          null,
        );
        return mutationSuccess("committed", planned);
      },
    );
    return this.#reconcileCredentialScope(
      await this.#finishMutation(frozen.tenantId, outcome, planned),
    );
  }

  public async consumeRevocationEvents(input: {
    readonly tenantId: string;
    readonly maxEvents?: number;
  }): Promise<IdentityRevocationConsumeResult> {
    if (!isRecord(input)) return invalidInput();
    const maxEvents = input.maxEvents ?? DEFAULT_MAX_CONSUME_EVENTS;
    if (!isIdentifier(input.tenantId) || !isSafePositiveInteger(maxEvents) || maxEvents > 10_000) {
      return invalidInput();
    }
    const outcome = await this.#store.transact(
      { tenantId: input.tenantId },
      async (tx): Promise<IdentityRevocationConsumeResult> => {
        const storedHead = await tx.read(
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(input.tenantId),
        );
        const storedCursor = await tx.read(
          GATEWAY_REVOCATION_CURSOR_SCHEMA,
          cursorKey(input.tenantId, this.#subscriberId),
        );
        const nowMs = this.#now();
        const head =
          storedHead === null ? null : parseHead(storedHead, input.tenantId);
        const headSequence = head?.lastSequence ?? 0;
        const cursor =
          storedCursor === null
            ? null
            : parseCursor(storedCursor, input.tenantId, this.#subscriberId);
        if (cursor?.status === "blocked") {
          return Object.freeze({
            ok: true as const,
            kind: "blocked" as const,
            headSequence,
            reason: cursor.blockedReason!,
            events: Object.freeze([]) as readonly [],
            cursor,
          });
        }
        const currentSequence = cursor?.lastContiguousSequence ?? 0;
        const block = (
          reason: IdentityCursorBlockReason,
          lastContiguousSequence: number,
        ): IdentityRevocationConsumeResult => {
          const blocked = makeCursor(
            input.tenantId,
            this.#subscriberId,
            cursor,
            nowMs,
            {
              lastContiguousSequence,
              lastResyncHead: cursor?.lastResyncHead ?? 0,
              lastResyncDigest: cursor?.lastResyncDigest ?? null,
              status: "blocked",
              blockedReason: reason,
            },
          );
          stageRecord(
            tx,
            GATEWAY_REVOCATION_CURSOR_SCHEMA,
            cursorKey(input.tenantId, this.#subscriberId),
            blocked,
            storedCursor,
          );
          return Object.freeze({
            ok: true as const,
            kind: "blocked" as const,
            headSequence,
            reason,
            events: Object.freeze([]) as readonly [],
            cursor: blocked,
          });
        };
        if (currentSequence > headSequence) return block("cursor_ahead", currentSequence);
        const targetSequence = Math.min(headSequence, currentSequence + maxEvents);
        const events: IdentityRevocationEventV1[] = [];
        for (let sequence = currentSequence + 1; sequence <= targetSequence; sequence += 1) {
          const storedEvent = await tx.read(
            IDENTITY_REVOCATION_EVENT_SCHEMA,
            eventKey(input.tenantId, sequence),
          );
          if (storedEvent === null) return block("event_missing", sequence - 1);
          if (
            isRecord(storedEvent.value) &&
            storedEvent.value.sequence !== sequence
          ) {
            return block("event_out_of_order", sequence - 1);
          }
          try {
            const event = parseEvent(storedEvent, input.tenantId, sequence);
            events.push(event);
          } catch {
            return block("event_corrupt", sequence - 1);
          }
        }
        const nextCursor = makeCursor(
          input.tenantId,
          this.#subscriberId,
          cursor,
          nowMs,
          {
            lastContiguousSequence: targetSequence,
            lastResyncHead: cursor?.lastResyncHead ?? 0,
            lastResyncDigest: cursor?.lastResyncDigest ?? null,
            status: "current",
            blockedReason: null,
          },
        );
        if (storedHead === null) {
          const initialHead = makeHead(input.tenantId, null, nowMs, 0);
          stageRecord(
            tx,
            IDENTITY_REVOCATION_HEAD_SCHEMA,
            headKey(input.tenantId),
            initialHead,
            null,
          );
        }
        stageRecord(
          tx,
          GATEWAY_REVOCATION_CURSOR_SCHEMA,
          cursorKey(input.tenantId, this.#subscriberId),
          nextCursor,
          storedCursor,
        );
        return Object.freeze({
          ok: true as const,
          kind: events.length === 0 ? ("current" as const) : ("advanced" as const),
          headSequence,
          complete: targetSequence === headSequence,
          events: Object.freeze(events.map((event) => Object.freeze(structuredClone(event)))),
          cursor: nextCursor,
        });
      },
    );
    return outcome.ok ? outcome.value : storeFailure(outcome.code, outcome.message);
  }

  public async prepareTenantResync(input: {
    readonly tenantId: string;
  }): Promise<IdentityResyncPrepareResult> {
    if (!isRecord(input)) return invalidInput();
    if (!isIdentifier(input.tenantId)) return invalidInput();
    const outcome = await this.#store.transact(
      { tenantId: input.tenantId },
      async (tx): Promise<IdentityResyncSnapshot> =>
        publicSnapshot(
          input.tenantId,
          await loadAuthoritySnapshot(
            tx,
            input.tenantId,
            this.#maxResyncDevices,
            this.#maxResyncSeats,
          ),
        ),
    );
    return outcome.ok
      ? Object.freeze({ ok: true as const, snapshot: outcome.value })
      : storeFailure(outcome.code, outcome.message);
  }

  public async commitTenantResync(input: {
    readonly tenantId: string;
    readonly expectedAuthorityDigest: string;
  }): Promise<IdentityResyncCommitResult> {
    if (!isRecord(input)) return invalidInput();
    if (!isIdentifier(input.tenantId) || !isSha256Digest(input.expectedAuthorityDigest)) {
      return invalidInput();
    }
    const outcome = await this.#store.transact(
      { tenantId: input.tenantId },
      async (tx): Promise<IdentityResyncCommitResult> => {
        const loaded = await loadAuthoritySnapshot(
          tx,
          input.tenantId,
          this.#maxResyncDevices,
          this.#maxResyncSeats,
        );
        if (!digestEqual(loaded.digest, input.expectedAuthorityDigest)) {
          return authorityConflict("identity resync digest changed before commit");
        }
        const storedCursor = await tx.read(
          GATEWAY_REVOCATION_CURSOR_SCHEMA,
          cursorKey(input.tenantId, this.#subscriberId),
        );
        const cursor =
          storedCursor === null
            ? null
            : parseCursor(storedCursor, input.tenantId, this.#subscriberId);
        const nowMs = this.#now();
        const headSequence = loaded.head?.lastSequence ?? 0;
        const nextHead = makeHead(
          input.tenantId,
          loaded.head,
          nowMs,
          headSequence,
        );
        const nextCursor = makeCursor(
          input.tenantId,
          this.#subscriberId,
          cursor,
          nowMs,
          {
            lastContiguousSequence: headSequence,
            lastResyncHead: headSequence,
            lastResyncDigest: loaded.digest,
            status: "current",
            blockedReason: null,
          },
        );
        stageRecord(
          tx,
          IDENTITY_REVOCATION_HEAD_SCHEMA,
          headKey(input.tenantId),
          nextHead,
          loaded.headStored,
        );
        stageRecord(
          tx,
          GATEWAY_REVOCATION_CURSOR_SCHEMA,
          cursorKey(input.tenantId, this.#subscriberId),
          nextCursor,
          storedCursor,
        );
        return Object.freeze({
          ok: true as const,
          kind: "committed" as const,
          snapshot: publicSnapshot(input.tenantId, loaded),
          cursor: nextCursor,
        });
      },
    );
    return outcome.ok ? outcome.value : storeFailure(outcome.code, outcome.message);
  }
}

/**
 * Creates the required durable global digest-to-scope locator over a store
 * separate from the tenant identity authority. The adapter accepts digests
 * only; raw bearer/device tokens cannot enter its API or records.
 */
export function createProductionCredentialScopeLocator(
  options: ProductionCredentialScopeLocatorOptions,
): ProductionCredentialScopeLocator {
  return new StoreBackedProductionCredentialScopeLocator(options);
}

/**
 * Creates the WP-06 durable identity/revocation authority over the existing
 * tenant-scoped transactional store port. No process-memory adapter is
 * promoted: durability is exactly the injected store's contract and kind.
 */
export function createProductionIdentityAuthority(
  options: ProductionIdentityStoreOptions,
): ProductionIdentityAuthority {
  return new StoreBackedProductionIdentityAuthority(options);
}
