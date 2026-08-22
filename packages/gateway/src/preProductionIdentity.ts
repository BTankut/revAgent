import { createHash, createHmac } from "node:crypto";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  isCanonicalMachineFingerprint,
  machineFingerprintClaimsEqual,
  type AuthContext,
  type DeviceAuthContext,
  type GatewayMachineFingerprint,
  type IdentityPort,
} from "./authContext.js";
import type { GatewayNodeEnv } from "./config.js";
import type { GatewayPortResult } from "./gatewayPorts.js";

export const PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION =
  "revagent.preproduction-identity/v1" as const;

const DEFAULT_ENROLLMENT_TTL_MS = 10 * 60 * 1_000;
const MAX_ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1_000;
const MIN_OPAQUE_SECRET_LENGTH = 32;
const MAX_OPAQUE_SECRET_LENGTH = 4_096;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CAPABILITY_LENGTH = 128;
const CAPABILITY_PATTERN = /^[a-z0-9_.:-]+$/u;

export type PreProductionEnrollmentDeviceStatus = "active" | "seat_denied";

export type PreProductionIdentityRefusalReason =
  | "invalid_request"
  | "enrollment_conflict"
  | "enrollment_token_unknown"
  | "enrollment_token_reused"
  | "enrollment_token_expired"
  | "enrollment_denied"
  | "device_not_found";

export interface PreProductionIdentityRefusal {
  readonly ok: false;
  readonly reason: PreProductionIdentityRefusalReason;
  readonly message: string;
}

export type PreProductionIdentityResult<T> =
  | { readonly ok: true; readonly value: T }
  | PreProductionIdentityRefusal;

export interface PreProductionNorthIdentityFixture {
  /** Exact bearer header accepted by the adapter. It is retained only by digest. */
  readonly authorization: string;
  readonly context: AuthContext;
}

export interface PreProductionIdentityOptions {
  /** No default: callers must opt into the non-production trust model. */
  readonly mode: "preproduction";
  /**
   * The factory rejects `production`; the server adapter-kind gate is a second,
   * independent defense when a test-created adapter is injected elsewhere.
   */
  readonly nodeEnv: GatewayNodeEnv;
  /** Caller-supplied pre-production key; no default credential exists in code. */
  readonly tokenKey: string;
  /** Required clock keeps expiry behavior deterministic and testable. */
  readonly clock: () => number;
  readonly enrollmentTtlMs?: number;
  readonly northIdentities: readonly PreProductionNorthIdentityFixture[];
}

export interface PreProductionEnrollmentIssueInput {
  readonly enrollmentId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly machineFingerprint: string;
  readonly grantedConnectionCapabilities?: readonly string[];
  readonly grantedSessionCapabilities?: readonly string[];
  readonly deviceStatus?: PreProductionEnrollmentDeviceStatus;
}

export interface PreProductionEnrollmentIssue {
  readonly contractVersion: typeof PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION;
  readonly enrollmentId: string;
  readonly enrollmentToken: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface PreProductionEnrollmentExchangeInput {
  readonly enrollmentToken: string | undefined;
  readonly machineFingerprint: string;
}

export interface PreProductionEnrollmentExchange {
  readonly contractVersion: typeof PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION;
  readonly deviceId: string;
  readonly deviceToken: string;
}

export interface PreProductionDeviceRevocation {
  readonly contractVersion: typeof PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION;
  readonly deviceId: string;
  readonly priorStatus: DeviceAuthContext["deviceStatus"];
  readonly deviceStatus: "revoked";
  readonly changed: boolean;
  readonly authorizationVersion: number;
  readonly identityRecordVersion: number;
  readonly connectionCapabilityVersion: number;
  readonly sessionCapabilityVersion: number;
  readonly seatAuthorityVersion: number;
  readonly seatRecordVersion: number;
}

export interface PreProductionIdentityAuthority extends IdentityPort {
  readonly kind: "preproduction";
  issueEnrollmentToken(
    input: PreProductionEnrollmentIssueInput,
  ): PreProductionIdentityResult<PreProductionEnrollmentIssue>;
  exchangeEnrollmentToken(
    input: PreProductionEnrollmentExchangeInput,
  ): PreProductionIdentityResult<PreProductionEnrollmentExchange>;
  revokeDevice(
    deviceId: string,
  ): PreProductionIdentityResult<PreProductionDeviceRevocation>;
}

export type PreProductionIdentityConfigurationErrorReason =
  | "production_mode"
  | "invalid_fixture";

export class PreProductionIdentityConfigurationError extends Error {
  readonly code = "preproduction_identity_configuration_refused" as const;

  constructor(
    readonly reason: PreProductionIdentityConfigurationErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "PreProductionIdentityConfigurationError";
  }
}

type EnrollmentState = "issued" | "consumed" | "expired";

interface EnrollmentRecord {
  readonly enrollmentId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly machineFingerprint: GatewayMachineFingerprint;
  readonly grantedConnectionCapabilities: readonly string[];
  readonly grantedSessionCapabilities: readonly string[];
  readonly deviceStatus: PreProductionEnrollmentDeviceStatus;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  state: EnrollmentState;
}

interface DeviceRecord {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly machineFingerprint: GatewayMachineFingerprint;
  readonly grantedConnectionCapabilities: readonly string[];
  readonly grantedSessionCapabilities: readonly string[];
  readonly deviceTokenDigest: `sha256:${string}`;
  authorizationVersion: number;
  identityRecordVersion: number;
  connectionCapabilityVersion: number;
  sessionCapabilityVersion: number;
  seatAuthorityVersion: number;
  seatRecordVersion: number;
  deviceStatus: DeviceAuthContext["deviceStatus"];
}

function configurationError(message: string): never {
  throw new PreProductionIdentityConfigurationError("invalid_fixture", message);
}

function refusal(
  reason: PreProductionIdentityRefusalReason,
  message: string,
): PreProductionIdentityRefusal {
  return Object.freeze({ ok: false as const, reason, message });
}

function identityRefusal(message: string): GatewayPortResult<never> {
  return Object.freeze({
    ok: false as const,
    port: "identity" as const,
    code: "unavailable" as const,
    message,
  });
}

function isOpaqueSecret(value: string): boolean {
  return (
    value.length >= MIN_OPAQUE_SECRET_LENGTH &&
    value.length <= MAX_OPAQUE_SECRET_LENGTH &&
    [...value].every((character) => character >= "!" && character <= "~")
  );
}

function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return isOpaqueSecret(token) ? token : null;
}

function isBoundedIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    [...value].every((character) => character >= "!" && character <= "~")
  );
}

function tokenDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function deriveToken(
  tokenKey: string,
  label: "enrollment" | "device",
  parts: readonly string[],
): string {
  const digest = createHmac("sha256", tokenKey)
    .update(
      JSON.stringify([
        PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
        label,
        ...parts,
      ]),
      "utf8",
    )
    .digest("base64url");
  return `pp-${label}-${digest}`;
}

function freezeAuthContext(context: AuthContext): AuthContext {
  return Object.freeze({
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: Object.freeze({
      type: "user" as const,
      tenantId: context.actor.tenantId,
      userId: context.actor.userId,
      role: context.actor.role,
      oidcIssuer: context.actor.oidcIssuer,
      oidcSubject: context.actor.oidcSubject,
    }),
    session: Object.freeze({
      sessionId: context.session.sessionId,
      clientType: context.session.clientType,
      mcpSessionId: context.session.mcpSessionId,
      oauthClientId: context.session.oauthClientId,
    }),
    principalKey: context.principalKey,
    issuedAtMs: context.issuedAtMs,
    expiresAtMs: context.expiresAtMs,
  });
}

function validateNorthContext(context: AuthContext): void {
  if (
    context.contractVersion !== GATEWAY_AUTH_CONTRACT_VERSION ||
    context.actor.type !== "user" ||
    !isBoundedIdentifier(context.actor.tenantId) ||
    !isBoundedIdentifier(context.actor.userId) ||
    !["user", "tenant_admin", "vendor_admin"].includes(context.actor.role) ||
    !isBoundedIdentifier(context.actor.oidcIssuer) ||
    !isBoundedIdentifier(context.actor.oidcSubject) ||
    context.session.clientType !== "mcp" ||
    !isBoundedIdentifier(context.session.sessionId) ||
    (context.session.mcpSessionId !== null &&
      !isBoundedIdentifier(context.session.mcpSessionId)) ||
    context.session.oauthClientId === null ||
    !isBoundedIdentifier(context.session.oauthClientId) ||
    context.principalKey !==
      `${context.actor.tenantId}:${context.actor.userId}` ||
    !Number.isSafeInteger(context.issuedAtMs) ||
    context.issuedAtMs < 0 ||
    (context.expiresAtMs !== null &&
      (!Number.isSafeInteger(context.expiresAtMs) ||
        context.expiresAtMs <= context.issuedAtMs))
  ) {
    configurationError(
      "the pre-production north identity fixture violates AuthContext v1",
    );
  }
}

function canonicalCapabilities(
  capabilities: readonly string[] | undefined,
): readonly string[] | null {
  const values = capabilities ?? [];
  if (
    values.some(
      (value) =>
        value.length === 0 ||
        value.length > MAX_CAPABILITY_LENGTH ||
        !CAPABILITY_PATTERN.test(value),
    )
  ) {
    return null;
  }
  return Object.freeze([...new Set(values)].sort());
}

function validIssueInput(input: PreProductionEnrollmentIssueInput): boolean {
  return (
    isBoundedIdentifier(input.enrollmentId) &&
    isBoundedIdentifier(input.tenantId) &&
    isBoundedIdentifier(input.userId) &&
    isBoundedIdentifier(input.deviceId) &&
    isBoundedIdentifier(input.seatId) &&
    isCanonicalMachineFingerprint(input.machineFingerprint) &&
    (input.deviceStatus === undefined ||
      input.deviceStatus === "active" ||
      input.deviceStatus === "seat_denied")
  );
}

/**
 * Creates the M4 deterministic identity/device-authority adapter.
 *
 * No listener, environment reader, OAuth authenticator or credential default is
 * included. Raw bearer/device values are accepted only at their boundary and
 * retained internally by SHA-256 digest. Enrollment and device tokens are
 * returned once by their explicit issue/exchange operations because the Bridge
 * must persist them; no auth context, refusal, snapshot or error can carry them.
 */
export function createPreProductionIdentityAuthority(
  options: PreProductionIdentityOptions,
): PreProductionIdentityAuthority {
  if (options.mode !== "preproduction") {
    configurationError(
      "the deterministic identity adapter requires explicit preproduction mode",
    );
  }
  if (options.nodeEnv === "production") {
    throw new PreProductionIdentityConfigurationError(
      "production_mode",
      "the deterministic identity adapter is restricted to pre-production use",
    );
  }
  if (!isOpaqueSecret(options.tokenKey)) {
    configurationError(
      "the pre-production token key must be 32 through 4096 visible ASCII characters",
    );
  }
  if (options.northIdentities.length === 0) {
    configurationError(
      "at least one explicit pre-production north identity is required",
    );
  }
  const enrollmentTtlMs =
    options.enrollmentTtlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
  if (
    !Number.isSafeInteger(enrollmentTtlMs) ||
    enrollmentTtlMs <= 0 ||
    enrollmentTtlMs > MAX_ENROLLMENT_TTL_MS
  ) {
    configurationError(
      "the pre-production enrollment TTL must be a positive integer no greater than 24 hours",
    );
  }
  const clock = options.clock;
  const tokenKey = options.tokenKey;

  const northByTokenDigest = new Map<string, AuthContext>();
  for (const fixture of options.northIdentities) {
    const token = bearerToken(fixture.authorization);
    if (token === null) {
      configurationError(
        "pre-production north authorization must use a bounded Bearer token",
      );
    }
    validateNorthContext(fixture.context);
    const digest = tokenDigest(token);
    if (northByTokenDigest.has(digest)) {
      configurationError(
        "pre-production north authorization entries must be unique",
      );
    }
    northByTokenDigest.set(digest, freezeAuthContext(fixture.context));
  }

  // This is intentionally a process-lifetime authority. Durable enrollment
  // replay state and reboot evidence belong to the later RES-30 integration
  // slice; M4-01 must not imply a store or persistence guarantee it lacks.
  const enrollmentIds = new Set<string>();
  const enrollmentsByTokenDigest = new Map<string, EnrollmentRecord>();
  const pendingEnrollmentByDeviceId = new Map<string, string>();
  const devicesById = new Map<string, DeviceRecord>();
  const devicesByTokenDigest = new Map<string, DeviceRecord>();

  function nowMs(): number {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      configurationError(
        "the pre-production identity clock must return a non-negative safe integer",
      );
    }
    return value;
  }

  const authority: PreProductionIdentityAuthority = {
    kind: "preproduction" as const,

    async authenticateNorthRequest(
      input,
    ): Promise<GatewayPortResult<AuthContext>> {
      const token = bearerToken(input.authorization);
      const context =
        token === null ? undefined : northByTokenDigest.get(tokenDigest(token));
      const now = nowMs();
      if (
        context === undefined ||
        context.issuedAtMs > now ||
        (context.expiresAtMs !== null && context.expiresAtMs <= now)
      ) {
        return identityRefusal(
          "pre-production identity refused north authorization",
        );
      }
      return Object.freeze({ ok: true as const, value: context });
    },

    async authenticateDevice(
      input,
    ): Promise<GatewayPortResult<DeviceAuthContext>> {
      if (
        input.deviceToken === undefined ||
        !isOpaqueSecret(input.deviceToken) ||
        !isBoundedIdentifier(input.connectionId)
      ) {
        return identityRefusal(
          "pre-production identity refused device authorization",
        );
      }
      const record = devicesByTokenDigest.get(tokenDigest(input.deviceToken));
      if (record === undefined) {
        return identityRefusal(
          "pre-production identity refused device authorization",
        );
      }
      if (
        input.machineFingerprint !== undefined &&
        !machineFingerprintClaimsEqual(
          record.machineFingerprint,
          input.machineFingerprint,
        )
      ) {
        return identityRefusal(
          "pre-production identity refused device authorization",
        );
      }
      if (
        input.claimedDeviceId !== undefined &&
        input.claimedDeviceId !== record.deviceId
      ) {
        return identityRefusal(
          "pre-production identity refused device authorization",
        );
      }
      const context: DeviceAuthContext = Object.freeze({
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: Object.freeze({
          type: "device" as const,
          tenantId: record.tenantId,
          userId: record.userId,
          deviceId: record.deviceId,
          seatId: record.seatId,
        }),
        connectionId: input.connectionId,
        deviceStatus: record.deviceStatus,
        machineFingerprint: record.machineFingerprint,
        authorizationVersion: record.authorizationVersion,
        identityRecordVersion: record.identityRecordVersion,
        connectionCapabilityVersion: record.connectionCapabilityVersion,
        sessionCapabilityVersion: record.sessionCapabilityVersion,
        seatAuthorityVersion: record.seatAuthorityVersion,
        seatRecordVersion: record.seatRecordVersion,
        grantedConnectionCapabilities: record.grantedConnectionCapabilities,
        grantedSessionCapabilities: record.grantedSessionCapabilities,
        deviceTokenDigest: record.deviceTokenDigest,
      });
      return Object.freeze({ ok: true as const, value: context });
    },

    issueEnrollmentToken(
      input,
    ): PreProductionIdentityResult<PreProductionEnrollmentIssue> {
      const capabilities = canonicalCapabilities(
        input.grantedSessionCapabilities,
      );
      const connectionCapabilities = canonicalCapabilities(
        input.grantedConnectionCapabilities,
      );
      if (
        !validIssueInput(input) ||
        capabilities === null ||
        connectionCapabilities === null
      ) {
        return refusal(
          "invalid_request",
          "pre-production enrollment issue input is invalid",
        );
      }
      const issuedAtMs = nowMs();
      const pendingDigest = pendingEnrollmentByDeviceId.get(input.deviceId);
      if (pendingDigest !== undefined) {
        const pending = enrollmentsByTokenDigest.get(pendingDigest);
        if (
          pending !== undefined &&
          pending.state === "issued" &&
          pending.expiresAtMs <= issuedAtMs
        ) {
          pending.state = "expired";
          pendingEnrollmentByDeviceId.delete(input.deviceId);
        }
      }
      const existingDevice = devicesById.get(input.deviceId);
      if (
        enrollmentIds.has(input.enrollmentId) ||
        pendingEnrollmentByDeviceId.has(input.deviceId) ||
        (existingDevice !== undefined &&
          existingDevice.deviceStatus !== "revoked")
      ) {
        return refusal(
          "enrollment_conflict",
          "pre-production enrollment already exists for this identity",
        );
      }

      const expiresAtMs = issuedAtMs + enrollmentTtlMs;
      if (!Number.isSafeInteger(expiresAtMs)) {
        return refusal(
          "invalid_request",
          "pre-production enrollment expiry is outside the supported range",
        );
      }
      const enrollmentToken = deriveToken(tokenKey, "enrollment", [
        input.enrollmentId,
        input.tenantId,
        input.userId,
        input.deviceId,
        input.seatId,
        input.machineFingerprint,
        input.deviceStatus ?? "active",
        "connection",
        ...connectionCapabilities,
        "session",
        ...capabilities,
      ]);
      const digest = tokenDigest(enrollmentToken);
      if (enrollmentsByTokenDigest.has(digest)) {
        return refusal(
          "enrollment_conflict",
          "pre-production enrollment token identity collided",
        );
      }

      const record: EnrollmentRecord = {
        enrollmentId: input.enrollmentId,
        tenantId: input.tenantId,
        userId: input.userId,
        deviceId: input.deviceId,
        seatId: input.seatId,
        machineFingerprint: input.machineFingerprint as GatewayMachineFingerprint,
        grantedConnectionCapabilities: connectionCapabilities,
        grantedSessionCapabilities: capabilities,
        deviceStatus: input.deviceStatus ?? "active",
        issuedAtMs,
        expiresAtMs,
        state: "issued",
      };
      enrollmentIds.add(input.enrollmentId);
      enrollmentsByTokenDigest.set(digest, record);
      pendingEnrollmentByDeviceId.set(input.deviceId, digest);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          contractVersion: PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
          enrollmentId: input.enrollmentId,
          enrollmentToken,
          issuedAtMs,
          expiresAtMs,
        }),
      });
    },

    exchangeEnrollmentToken(
      input,
    ): PreProductionIdentityResult<PreProductionEnrollmentExchange> {
      if (
        input.enrollmentToken === undefined ||
        !isOpaqueSecret(input.enrollmentToken) ||
        !isCanonicalMachineFingerprint(input.machineFingerprint)
      ) {
        return refusal(
          "invalid_request",
          "pre-production enrollment exchange input is invalid",
        );
      }
      const digest = tokenDigest(input.enrollmentToken);
      const record = enrollmentsByTokenDigest.get(digest);
      if (record === undefined) {
        return refusal(
          "enrollment_token_unknown",
          "pre-production enrollment token is not recognized",
        );
      }
      if (record.state === "consumed") {
        return refusal(
          "enrollment_token_reused",
          "pre-production enrollment token was already consumed",
        );
      }
      if (record.state === "expired" || record.expiresAtMs <= nowMs()) {
        record.state = "expired";
        if (pendingEnrollmentByDeviceId.get(record.deviceId) === digest) {
          pendingEnrollmentByDeviceId.delete(record.deviceId);
        }
        return refusal(
          "enrollment_token_expired",
          "pre-production enrollment token has expired",
        );
      }
      if (
        !machineFingerprintClaimsEqual(
          record.machineFingerprint,
          input.machineFingerprint,
        )
      ) {
        return refusal(
          "enrollment_denied",
          "pre-production enrollment fingerprint does not match the issue record",
        );
      }

      const deviceToken = deriveToken(tokenKey, "device", [
        record.enrollmentId,
        digest,
        record.machineFingerprint,
        record.deviceId,
      ]);
      const deviceTokenDigest = tokenDigest(deviceToken);
      if (devicesByTokenDigest.has(deviceTokenDigest)) {
        return refusal(
          "enrollment_conflict",
          "pre-production device token identity collided",
        );
      }
      const priorDevice = devicesById.get(record.deviceId);
      if (priorDevice !== undefined) {
        devicesByTokenDigest.delete(priorDevice.deviceTokenDigest);
      }
      const device: DeviceRecord = {
        tenantId: record.tenantId,
        userId: record.userId,
        deviceId: record.deviceId,
        seatId: record.seatId,
        machineFingerprint: record.machineFingerprint,
        grantedConnectionCapabilities: record.grantedConnectionCapabilities,
        grantedSessionCapabilities: record.grantedSessionCapabilities,
        deviceTokenDigest,
        authorizationVersion: (priorDevice?.authorizationVersion ?? 0) + 1,
        identityRecordVersion: (priorDevice?.identityRecordVersion ?? 0) + 1,
        connectionCapabilityVersion:
          (priorDevice?.connectionCapabilityVersion ?? 0) + 1,
        sessionCapabilityVersion:
          (priorDevice?.sessionCapabilityVersion ?? 0) + 1,
        seatAuthorityVersion: (priorDevice?.seatAuthorityVersion ?? 0) + 1,
        seatRecordVersion: (priorDevice?.seatRecordVersion ?? 0) + 1,
        deviceStatus: record.deviceStatus,
      };
      devicesById.set(device.deviceId, device);
      devicesByTokenDigest.set(device.deviceTokenDigest, device);
      record.state = "consumed";
      if (pendingEnrollmentByDeviceId.get(record.deviceId) === digest) {
        pendingEnrollmentByDeviceId.delete(record.deviceId);
      }

      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          contractVersion: PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
          deviceId: record.deviceId,
          deviceToken,
        }),
      });
    },

    revokeDevice(
      deviceId,
    ): PreProductionIdentityResult<PreProductionDeviceRevocation> {
      if (!isBoundedIdentifier(deviceId)) {
        return refusal(
          "invalid_request",
          "pre-production device revocation input is invalid",
        );
      }
      const record = devicesById.get(deviceId);
      if (record === undefined) {
        return refusal(
          "device_not_found",
          "pre-production device identity is not recognized",
        );
      }
      const priorStatus = record.deviceStatus;
      record.deviceStatus = "revoked";
      if (priorStatus !== "revoked") {
        record.authorizationVersion += 1;
        record.identityRecordVersion += 1;
        record.connectionCapabilityVersion += 1;
        record.sessionCapabilityVersion += 1;
        record.seatAuthorityVersion += 1;
        record.seatRecordVersion += 1;
      }
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({
          contractVersion: PRE_PRODUCTION_IDENTITY_CONTRACT_VERSION,
          deviceId,
          priorStatus,
          deviceStatus: "revoked" as const,
          changed: priorStatus !== "revoked",
          authorizationVersion: record.authorizationVersion,
          identityRecordVersion: record.identityRecordVersion,
          connectionCapabilityVersion: record.connectionCapabilityVersion,
          sessionCapabilityVersion: record.sessionCapabilityVersion,
          seatAuthorityVersion: record.seatAuthorityVersion,
          seatRecordVersion: record.seatRecordVersion,
        }),
      });
    },
  };

  return Object.freeze(authority);
}
