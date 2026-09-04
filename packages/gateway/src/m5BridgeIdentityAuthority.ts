import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  isCanonicalMachineFingerprint,
  type GatewayMachineFingerprint,
} from "./authContext.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import {
  M5EnrollmentEntitlementControlPlane,
  type M5TenantDeviceSnapshotRow,
} from "./m5EnrollmentEntitlement.js";
import {
  GATEWAY_REVOCATION_CURSOR_SCHEMA,
  IDENTITY_DEVICE_SCHEMA,
  IDENTITY_TENANT_SEAT_SCHEMA,
  type GatewayRevocationCursorV1,
  type IdentityDeviceV2,
  type IdentityMutationResult,
  type IdentityOperationFailure,
  type IdentityResyncCommitResult,
  type IdentityResyncPrepareResult,
  type IdentityResyncSnapshot,
  type IdentityRevocationConsumeResult,
  type IdentityTenantSeatV1,
  type ProductionCredentialScope,
  type ProductionDeviceAuthContext,
  type ProductionIdentityAuthority,
  type ProductionIdentityLifecycleSnapshot,
  type ProductionIdentityManagedResources,
} from "./productionIdentityStore.js";
import type { GatewayProtocolStore, StoreOutcome } from "./store.js";

export const M5_BRIDGE_IDENTITY_AUTHORITY_CONTRACT_VERSION =
  "revagent.m5-bridge-identity-authority/v1" as const;

/**
 * RBP/1 connection- and session-capability names this adapter is willing to
 * provision. M5 has no independent connection/session capability catalog of
 * its own (its `M5Capability` axis is tool/module entitlement, checked
 * separately by the `EntitlementPort`, not by `IdentityPort`): granting the
 * full implemented set here is a safe superset, because `bridgeSession.ts`
 * always intersects a device's granted set with what it actually implements
 * and what the Bridge actually requests. Provisioning more than that never
 * grants more than the Gateway itself implements.
 */
const M5_GRANTED_CONNECTION_CAPABILITIES = Object.freeze([
  "journal_v1",
  "chunked_results",
  "artifact_result_v1",
  "transport_streamable_http",
  "route_rebind_proof_v1",
]);
const M5_GRANTED_SESSION_CAPABILITIES = Object.freeze([
  "batch_atomic",
  "doc_context_cached_v1",
]);

/**
 * Every field a device row needs to satisfy both `#connectionMatchesSnapshot`
 * (bridgeSession.ts) and `IdentityDeviceV2`/`IdentityTenantSeatV1`, derived
 * once from one M5 snapshot row so a live connection's `authenticateDevice`
 * result and the tenant resync snapshot can never structurally disagree
 * about the same device.
 */
function deviceIdentityFields(row: M5TenantDeviceSnapshotRow): {
  readonly machineFingerprint: GatewayMachineFingerprint;
  readonly deviceTokenDigest: `sha256:${string}`;
  readonly authorizationVersion: number;
  readonly identityRecordVersion: number;
  readonly connectionCapabilityVersion: number;
  readonly sessionCapabilityVersion: number;
  readonly seatAuthorityVersion: number;
  readonly seatRecordVersion: number;
} {
  return {
    machineFingerprint: row.machineFingerprint as GatewayMachineFingerprint,
    deviceTokenDigest: row.currentTokenDigestTag,
    authorizationVersion: row.credentialVersion,
    identityRecordVersion: row.credentialVersion,
    connectionCapabilityVersion: 1,
    sessionCapabilityVersion: 1,
    seatAuthorityVersion: 1,
    seatRecordVersion: 1,
  };
}

function identityUnavailable(message: string): IdentityOperationFailure {
  return Object.freeze({
    ok: false as const,
    kind: "unavailable" as const,
    code: "unavailable" as const,
    message,
  });
}

/**
 * Stable, generic refusal for every `authenticateDevice` failure path,
 * mirroring `StoreBackedProductionIdentityAuthority`'s own `identityRefusal`
 * convention: the message never varies by *why* a credential was refused
 * (unknown device, wrong fingerprint, revoked, expired, foreign tenant, wrong
 * principal, malformed input), so a caller cannot use the refusal itself as
 * an oracle. Reason-specific detail is recorded only in EU-11's own
 * `security_events` audit trail (see `M5EnrollmentEntitlementControlPlane`),
 * never returned on the wire.
 */
function deviceRefusal(): GatewayPortResult<never> {
  return Object.freeze({
    ok: false as const,
    port: "identity" as const,
    code: "unavailable" as const,
    message: "production identity refused device authorization",
  });
}

/**
 * EU-20-AUTH-INGRESS bounded composition/authority adapter.
 *
 * `GatewayBridgeSessionAuthority` grants its elevated, revocation-aware
 * "production identity" branding (`asProductionIdentityAuthority` in
 * `bridgeSession.ts`) to exactly one closed contract: `ProductionIdentityAuthority`
 * (`kind: "oidc"`, plus lifecycle/managedResources/usesStore/revocation-event
 * resync methods). That contract models an event-sourced revocation head and
 * optimistic-concurrency tenant resync that M5's EU-11 Postgres schema does
 * not share and that this unit must not reinvent as a parallel protocol.
 *
 * Rather than reimplementing that contract atop M5's schema, this adapter
 * *decorates* an existing, already-tested `ProductionIdentityAuthority`
 * (`base`, from `createProductionIdentityAuthority`) and replaces exactly the
 * one method that is the actual Bridge-device security decision:
 * `authenticateDevice`. Every other method — north-user OIDC authentication,
 * lifecycle open/close, revocation-event consumption/resync, and `base`'s own
 * device provisioning/revocation — passes straight through to `base`,
 * unmodified, so none of that already-reviewed machinery is touched or
 * duplicated.
 *
 * Once this adapter is composed as the Gateway's `ports.identity`, `base`'s
 * own device/credential store is never consulted to decide whether a Bridge
 * may connect: that decision is made exclusively by the real EU-11
 * Postgres-backed `M5EnrollmentEntitlementControlPlane` (`plane`), through
 * `plane.resolveBridgeDeviceCredential`. No separate in-memory or shadow
 * device-credential authority remains the production composition's source of
 * truth for Bridge sessions.
 */
export class M5BridgeIdentityAuthority implements ProductionIdentityAuthority {
  readonly #base: ProductionIdentityAuthority;
  readonly #plane: M5EnrollmentEntitlementControlPlane;

  public constructor(options: {
    readonly base: ProductionIdentityAuthority;
    readonly plane: M5EnrollmentEntitlementControlPlane;
  }) {
    if (options.base.kind !== "oidc") {
      throw new TypeError(
        "M5BridgeIdentityAuthority requires an oidc-kind base identity authority",
      );
    }
    if (!(options.plane instanceof M5EnrollmentEntitlementControlPlane)) {
      throw new TypeError(
        "M5BridgeIdentityAuthority requires a real EU-11 control plane instance",
      );
    }
    this.#base = options.base;
    this.#plane = options.plane;
  }

  public get kind(): "oidc" {
    return "oidc";
  }

  public authenticateNorthRequest(
    input: Parameters<ProductionIdentityAuthority["authenticateNorthRequest"]>[0],
  ): ReturnType<ProductionIdentityAuthority["authenticateNorthRequest"]> {
    return this.#base.authenticateNorthRequest(input);
  }

  public async authenticateDevice(input: {
    readonly deviceToken: string | undefined;
    readonly connectionId: string;
    readonly claimedDeviceId?: string;
    readonly establishedScope?: ProductionCredentialScope;
    readonly tenantId?: string;
    readonly deviceId?: string;
    readonly machineFingerprint?: string;
    readonly machineHostname?: string;
  }): Promise<GatewayPortResult<ProductionDeviceAuthContext>> {
    // Transitional compatibility claims are rejected outright, exactly as the
    // base production adapter rejects them: production initial auth never
    // trusts a caller-asserted tenant/device.
    if (
      typeof input.deviceToken !== "string" ||
      typeof input.connectionId !== "string" ||
      input.connectionId.length === 0 ||
      "tenantId" in input ||
      "deviceId" in input ||
      !isCanonicalMachineFingerprint(input.machineFingerprint)
    ) {
      return deviceRefusal();
    }
    const resolved = await this.#plane.resolveBridgeDeviceCredential({
      deviceToken: input.deviceToken,
      claimedDeviceId: input.claimedDeviceId,
      machineFingerprint: input.machineFingerprint,
    });
    if (!resolved.ok) return deviceRefusal();
    const value = resolved.value;
    // Reassertion (`assertConnectionCredential`) always supplies the tenant
    // and device id established at `hello`. Requiring an exact match here
    // fails closed on any drift between the previously-bound identity and
    // whatever the credential resolves to now (e.g. a rotated/reissued
    // credential that migrated device or tenant, which must never happen).
    if (
      input.establishedScope !== undefined &&
      (input.establishedScope.tenantId !== value.tenantId ||
        input.establishedScope.deviceId !== value.deviceId)
    ) {
      return deviceRefusal();
    }
    const shared = deviceIdentityFields({
      deviceId: value.deviceId,
      principalUserId: value.principalUserId,
      machineFingerprint: input.machineFingerprint,
      currentTokenDigestTag: value.currentTokenDigestTag,
      credentialVersion: value.credentialVersion,
      status: "active",
    });
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: Object.freeze({
          type: "device" as const,
          tenantId: value.tenantId,
          userId: value.principalUserId,
          deviceId: value.deviceId,
          // M5 has no independent per-module "seat" concept at the
          // connection/auth layer (its seats gate *dispatch entitlement*, a
          // separate `EntitlementPort` concern): the device id doubles as a
          // stable per-device pseudo-seat key so capability-authority
          // fencing keyed on `seatId` still behaves deterministically.
          seatId: value.deviceId,
        }),
        connectionId: input.connectionId,
        // `resolveBridgeDeviceCredential` only ever succeeds while the
        // device and its principal are both active, so a resolved value here
        // is always the active case.
        deviceStatus: "active" as const,
        grantedConnectionCapabilities: M5_GRANTED_CONNECTION_CAPABILITIES,
        grantedSessionCapabilities: M5_GRANTED_SESSION_CAPABILITIES,
        ...shared,
      }),
    });
  }

  // Lifecycle and north-identity authentication are unrelated to *which*
  // authority admits a Bridge device (that is `authenticateDevice` above,
  // exclusively M5-backed) and pass straight through to `base`, unmodified.
  public open(): Promise<StoreOutcome<void>> {
    return this.#base.open();
  }

  public close(): Promise<StoreOutcome<void>> {
    return this.#base.close();
  }

  public lifecycle(): ProductionIdentityLifecycleSnapshot {
    return this.#base.lifecycle();
  }

  public managedResources(): ProductionIdentityManagedResources {
    return this.#base.managedResources();
  }

  public usesStore(store: GatewayProtocolStore): boolean {
    return this.#base.usesStore(store);
  }

  /**
   * Every remaining method decides or reports Bridge device/seat state.
   * None of them may ever reach `base` — that would make `base`'s own,
   * unrelated store a second, shadow place a device decision could come
   * from. `provisionDevice`/`revokeDevice`/`revokeSeat` are true
   * operator-gated mutations this bounded unit does not perform (device
   * lifecycle mutation stays on M5's own admin surface,
   * `M5EnrollmentEntitlementControlPlane.rotateDeviceCredential` /
   * `revokeDevice`); this composition refuses them outright rather than
   * silently no-op them against an authority nothing else consults.
   */
  public async provisionDevice(): Promise<IdentityMutationResult> {
    return identityUnavailable(
      "device provisioning is not performed through this composition; use the M5 enrollment endpoint",
    );
  }

  public async revokeDevice(): Promise<IdentityMutationResult> {
    return identityUnavailable(
      "device revocation is not performed through this composition; use M5EnrollmentEntitlementControlPlane.revokeDevice",
    );
  }

  public async revokeSeat(): Promise<IdentityMutationResult> {
    return identityUnavailable(
      "seat revocation is not performed through this composition",
    );
  }

  /**
   * M5 keeps no incremental revocation-event log (see
   * `M5EnrollmentEntitlementControlPlane.tenantDeviceRevocationHead`): this
   * reports "current, no new events" whenever the caller's cached head
   * sequence already matches M5's live counter, and directs
   * `synchronizeIdentityRevocations` to a full {@link prepareTenantResync}
   * whenever it does not (including the very first call for a tenant, where
   * there is no cached head yet) — never a fabricated per-event stream.
   */
  public async consumeRevocationEvents(input: {
    readonly tenantId: string;
    readonly maxEvents?: number;
  }): Promise<IdentityRevocationConsumeResult> {
    const head = await this.#plane.tenantDeviceRevocationHead({
      tenantId: input.tenantId,
    });
    if (!head.ok) {
      return identityUnavailable("M5 device revocation head is unavailable");
    }
    return Object.freeze({
      ok: true as const,
      kind: "current" as const,
      headSequence: head.value.headSequence,
      complete: true,
      events: Object.freeze([]),
      cursor: this.#cursor(input.tenantId, head.value.headSequence, null),
    });
  }

  public async prepareTenantResync(input: {
    readonly tenantId: string;
  }): Promise<IdentityResyncPrepareResult> {
    const snapshot = await this.#buildResyncSnapshot(input.tenantId);
    if (snapshot === null) {
      return identityUnavailable("M5 tenant device snapshot is unavailable");
    }
    return Object.freeze({ ok: true as const, snapshot });
  }

  public async commitTenantResync(input: {
    readonly tenantId: string;
    readonly expectedAuthorityDigest: string;
  }): Promise<IdentityResyncCommitResult> {
    const snapshot = await this.#buildResyncSnapshot(input.tenantId);
    if (snapshot === null) {
      return identityUnavailable("M5 tenant device snapshot is unavailable");
    }
    if (snapshot.authorityDigest !== input.expectedAuthorityDigest) {
      return Object.freeze({
        ok: false as const,
        kind: "conflict" as const,
        code: "authority_conflict" as const,
        message: "M5 tenant device state changed during resync",
      });
    }
    return Object.freeze({
      ok: true as const,
      kind: "committed" as const,
      snapshot,
      cursor: this.#cursor(input.tenantId, snapshot.headSequence, snapshot.authorityDigest),
    });
  }

  #cursor(
    tenantId: string,
    headSequence: number,
    resyncedToDigest: `sha256:${string}` | null,
  ): GatewayRevocationCursorV1 {
    const now = Date.now();
    return Object.freeze({
      schema: GATEWAY_REVOCATION_CURSOR_SCHEMA,
      tenantId,
      createdAtMs: now,
      updatedAtMs: now,
      recordVersion: 1,
      subscriberId: "m5-bridge-identity-authority",
      lastContiguousSequence: headSequence,
      lastResyncHead: headSequence,
      lastResyncDigest: resyncedToDigest,
      status: "current" as const,
      blockedReason: null,
    });
  }

  async #buildResyncSnapshot(tenantId: string): Promise<IdentityResyncSnapshot | null> {
    const result = await this.#plane.tenantDeviceSnapshot({ tenantId });
    if (!result.ok) return null;
    const now = Date.now();
    const devices: IdentityDeviceV2[] = result.value.devices.map((row) => {
      const shared = deviceIdentityFields(row);
      return Object.freeze({
        schema: IDENTITY_DEVICE_SCHEMA,
        tenantId,
        createdAtMs: now,
        updatedAtMs: now,
        recordVersion: shared.identityRecordVersion,
        userId: row.principalUserId,
        deviceId: row.deviceId,
        seatId: row.deviceId,
        status: row.status,
        allowedConnectionCapabilities: M5_GRANTED_CONNECTION_CAPABILITIES,
        allowedSessionCapabilities: M5_GRANTED_SESSION_CAPABILITIES,
        lastAuthorityOperationId: row.deviceId,
        lastAuthorityOperationDigest: row.currentTokenDigestTag,
        lastAuthoritySequence: shared.authorizationVersion,
        ...shared,
      });
    });
    const seats: IdentityTenantSeatV1[] = result.value.devices.map((row) =>
      Object.freeze({
        schema: IDENTITY_TENANT_SEAT_SCHEMA,
        tenantId,
        createdAtMs: now,
        updatedAtMs: now,
        recordVersion: 1,
        seatId: row.deviceId,
        userId: row.principalUserId,
        deviceId: row.deviceId,
        status: row.status,
        seatAuthorityVersion: 1,
        lastAuthorityOperationId: row.deviceId,
        lastAuthorityOperationDigest: row.currentTokenDigestTag,
        lastAuthoritySequence: 1,
      }),
    );
    return Object.freeze({
      tenantId,
      headSequence: result.value.headSequence,
      authorityDigest: result.value.authorityDigest,
      devices: Object.freeze(devices),
      seats: Object.freeze(seats),
    });
  }
}

/** Convenience factory mirroring `createProductionIdentityAuthority`. */
export function createM5BridgeIdentityAuthority(options: {
  readonly base: ProductionIdentityAuthority;
  readonly plane: M5EnrollmentEntitlementControlPlane;
}): ProductionIdentityAuthority {
  return new M5BridgeIdentityAuthority(options);
}
