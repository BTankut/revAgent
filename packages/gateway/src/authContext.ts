import { timingSafeEqual } from "node:crypto";

import {
  portNotImplemented,
  type GatewayPortAdapterKind,
  type GatewayPortResult,
} from "./gatewayPorts.js";

/**
 * The identity contract the Gateway is built against (GW-2 / EXT-AUTH-CONTRACT).
 *
 * `02-gateway-core.md` defines EXT-AUTH-CONTRACT as the frozen
 * `AuthContext`/`DeviceAuthContext` interfaces plus a deterministic fake
 * identity provider **delivered by GW-2 and reviewed by WP4**. GW-2 therefore
 * authors these shapes; WP4 reviews them and later substitutes a real adapter.
 * No OIDC or device enrollment is implemented here, and this module reads no
 * configuration.
 */
export const GATEWAY_AUTH_CONTRACT_VERSION = "revagent.auth-context/v1" as const;

/** P-AUTH-3. Closed set: an unknown role must fail to typecheck, not default. */
export type GatewayRole = "user" | "tenant_admin" | "vendor_admin";

export type GatewayClientType = "web" | "mcp" | "bridge";

export type GatewayMachineFingerprint = `sha256:${string}`;

const MACHINE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EMPTY_SHA256 = Buffer.alloc(32);

/** A machine claim is canonical only in the frozen `sha256:<64hex>` form. */
export function isCanonicalMachineFingerprint(
  value: unknown,
): value is GatewayMachineFingerprint {
  return typeof value === "string" && MACHINE_FINGERPRINT_PATTERN.test(value);
}

/**
 * Compares two already bounded fingerprint claims without a data-dependent
 * byte comparison. Invalid encodings still take the same 32-byte comparison
 * path and can never compare equal.
 */
export function machineFingerprintClaimsEqual(
  left: unknown,
  right: unknown,
): boolean {
  const leftValid = isCanonicalMachineFingerprint(left);
  const rightValid = isCanonicalMachineFingerprint(right);
  const leftBytes = leftValid
    ? Buffer.from(left.slice("sha256:".length), "hex")
    : EMPTY_SHA256;
  const rightBytes = rightValid
    ? Buffer.from(right.slice("sha256:".length), "hex")
    : EMPTY_SHA256;
  const equal = timingSafeEqual(leftBytes, rightBytes);
  return leftValid && rightValid && equal;
}

/** P-LIC-1. Closed rather than `string`, so a typo cannot mint a module. */
export type GatewayModuleName = "core" | "mech" | "arch" | "struct" | "elec";

/**
 * The north-side (human) actor for an invocation.
 *
 * `actor.type` is a discriminant so `AuthContext` and `DeviceAuthContext` are
 * structurally non-assignable to each other. That is the code-level enforcement
 * of the frozen requirement that the north-side OIDC actor is retained
 * separately from the bridge principal: passing a device where a user is
 * expected is a compile error rather than an audit gap.
 */
export interface AuthContext {
  readonly contractVersion: typeof GATEWAY_AUTH_CONTRACT_VERSION;
  readonly actor: {
    readonly type: "user";
    readonly tenantId: string;
    readonly userId: string;
    readonly role: GatewayRole;
    readonly oidcIssuer: string;
    readonly oidcSubject: string;
  };
  readonly session: {
    readonly sessionId: string;
    readonly clientType: GatewayClientType;
    readonly mcpSessionId: string | null;
    readonly oauthClientId: string | null;
  };
  /** Audit-safe stable key. Must never carry a credential. */
  readonly principalKey: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number | null;
}

/**
 * The bridge-side (device) principal.
 *
 * Deliberately carries only a digest of the device token. The frozen protocol
 * forbids retaining the raw token, and a shape that cannot hold one cannot leak
 * one.
 */
export interface DeviceAuthContext {
  readonly contractVersion: typeof GATEWAY_AUTH_CONTRACT_VERSION;
  readonly actor: {
    readonly type: "device";
    readonly tenantId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly seatId: string;
  };
  readonly connectionId: string;
  readonly deviceStatus: "active" | "revoked" | "seat_denied";
  /**
   * WP-06 production contexts always populate the versioned identity fields.
   * They remain optional during the stacked migration so older deterministic
   * test doubles cannot accidentally be represented as durable authority.
   */
  readonly machineFingerprint?: GatewayMachineFingerprint;
  readonly authorizationVersion?: number;
  readonly identityRecordVersion?: number;
  readonly seatAuthorityVersion?: number;
  readonly seatRecordVersion?: number;
  readonly grantedConnectionCapabilities?: readonly string[];
  readonly grantedSessionCapabilities: readonly string[];
  readonly deviceTokenDigest: `sha256:${string}`;
}

export interface IdentityPort {
  readonly kind: GatewayPortAdapterKind;
  authenticateNorthRequest(input: {
    readonly authorization: string | undefined;
  }): Promise<GatewayPortResult<AuthContext>>;
  authenticateDevice(input: {
    readonly deviceToken: string | undefined;
    readonly connectionId: string;
    /** Exact scope hints avoid any broad identity-store scan. */
    readonly tenantId?: string;
    readonly deviceId?: string;
    /** Required by the production adapter; legacy absence means re-enrolment. */
    readonly machineFingerprint?: string;
    /** Observational only and never participates in authority. */
    readonly machineHostname?: string;
  }): Promise<GatewayPortResult<DeviceAuthContext>>;
}

/**
 * Entitlement is a query, never a snapshot on `AuthContext`.
 *
 * A cached `entitledModules` array on the context would be a fail-open
 * licensing shortcut: a seat released mid-session would keep working for the
 * life of that context. Asking the port each time is what makes revocation take
 * effect.
 */
export interface EntitlementPort {
  readonly kind: GatewayPortAdapterKind;
  checkModuleEntitlement(input: {
    readonly auth: AuthContext;
    readonly moduleName: GatewayModuleName;
  }): Promise<GatewayPortResult<boolean>>;
  checkToolEntitlement(input: {
    readonly auth: AuthContext;
    readonly toolName: string;
    readonly toolVersion: string;
  }): Promise<GatewayPortResult<boolean>>;
}

export function createUnavailableIdentityPort(): IdentityPort {
  return Object.freeze({
    kind: "unavailable" as const,
    async authenticateNorthRequest(): Promise<GatewayPortResult<AuthContext>> {
      return portNotImplemented(
        "identity",
        "no OIDC adapter is configured in Phase 1",
      );
    },
    async authenticateDevice(): Promise<GatewayPortResult<DeviceAuthContext>> {
      return portNotImplemented(
        "identity",
        "device enrollment is not implemented in Phase 1",
      );
    },
  });
}

export function createUnavailableEntitlementPort(): EntitlementPort {
  return Object.freeze({
    kind: "unavailable" as const,
    async checkModuleEntitlement(): Promise<GatewayPortResult<boolean>> {
      return portNotImplemented(
        "entitlement",
        "no entitlement store is configured in Phase 1",
      );
    },
    async checkToolEntitlement(): Promise<GatewayPortResult<boolean>> {
      return portNotImplemented(
        "entitlement",
        "no entitlement store is configured in Phase 1",
      );
    },
  });
}
