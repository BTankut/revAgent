import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
  GATEWAY_REVOCATION_CURSOR_SCHEMA,
  IDENTITY_DEVICE_SCHEMA,
  IDENTITY_REVOCATION_EVENT_SCHEMA,
  IDENTITY_REVOCATION_HEAD_SCHEMA,
  IDENTITY_TENANT_SEAT_SCHEMA,
  createProductionCredentialScopeLocator,
  createProductionIdentityAuthority,
  type CredentialScopeLookupResult,
  type IdentityMutationResult,
  type ProductionIdentityAuthority,
  type ProductionCredentialScopeLocator,
  type ProductionIdentityStoreOptions,
  type ProvisionIdentityDeviceInput,
} from "./productionIdentityStore.js";
import type {
  GatewayProtocolStore,
  StoreOutcome,
  StoreTransaction,
} from "./store.js";
import {
  createRestartableTestStore,
  type RestartableTestStore,
} from "./testAdapters.js";

const NOW_MS = 1_900_000_000_000;
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const DEVICE_ID = "device-1";
const SEAT_ID = "seat-1";
const TOKEN_A = "device-token-a-0000000000000000000000000001";
const TOKEN_B = "device-token-b-0000000000000000000000000002";
const FINGERPRINT_A = `sha256:${"a".repeat(64)}`;
const FINGERPRINT_B = `sha256:${"b".repeat(64)}`;

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function provisionInput(
  overrides: Partial<ProvisionIdentityDeviceInput> = {},
): ProvisionIdentityDeviceInput {
  return {
    operationId: "operation-provision-1",
    tenantId: TENANT_A,
    userId: "user-1",
    deviceId: DEVICE_ID,
    seatId: SEAT_ID,
    deviceToken: TOKEN_A,
    machineFingerprint: FINGERPRINT_A,
    allowedConnectionCapabilities: ["journal_v1", "transport_streamable_http"],
    allowedSessionCapabilities: ["batch_atomic", "doc_context_cached_v1"],
    expectedDeviceRecordVersion: null,
    expectedSeatRecordVersion: null,
    ...overrides,
  };
}

function authority(
  store: GatewayProtocolStore,
  credentialLocator: ProductionCredentialScopeLocator,
  overrides: Partial<
    Omit<ProductionIdentityStoreOptions, "store" | "credentialLocator">
  > = {},
): ProductionIdentityAuthority {
  return createProductionIdentityAuthority({
    store,
    credentialLocator,
    subscriberId: "gateway-subscriber-1",
    clock: () => NOW_MS,
    ...overrides,
  });
}

async function openAuthority(
  fixture: RestartableTestStore = createRestartableTestStore(),
  locatorFixture: RestartableTestStore = createRestartableTestStore(),
): Promise<{
  readonly fixture: RestartableTestStore;
  readonly locatorFixture: RestartableTestStore;
  readonly locator: ProductionCredentialScopeLocator;
  readonly identity: ProductionIdentityAuthority;
}> {
  const locator = createProductionCredentialScopeLocator({
    store: locatorFixture.store,
    clock: () => NOW_MS,
  });
  const identity = authority(fixture.store, locator);
  expect(await identity.open()).toEqual({ ok: true, value: undefined });
  return { fixture, locatorFixture, locator, identity };
}

function committed(result: IdentityMutationResult) {
  expect(result).toMatchObject({ ok: true, kind: "committed" });
  if (!result.ok) throw new Error("expected committed identity mutation");
  return result.change;
}

async function consumeAll(
  identity: ProductionIdentityAuthority,
  tenantId = TENANT_A,
): Promise<void> {
  for (;;) {
    const consumed = await identity.consumeRevocationEvents({ tenantId });
    expect(consumed.ok).toBe(true);
    if (!consumed.ok || consumed.kind === "blocked") {
      throw new Error("expected contiguous identity event stream");
    }
    if (consumed.complete) return;
  }
}

async function exactAuth(
  identity: ProductionIdentityAuthority,
  input: {
    readonly claimedDeviceId?: string;
    readonly establishedScope?: {
      readonly tenantId: string;
      readonly deviceId: string;
    };
    readonly token?: string;
    readonly fingerprint?: string;
    readonly hostname?: string;
  } = {},
) {
  return identity.authenticateDevice({
    deviceToken: input.token ?? TOKEN_A,
    connectionId: "connection-1",
    claimedDeviceId: input.claimedDeviceId ?? DEVICE_ID,
    ...(input.establishedScope === undefined
      ? {}
      : { establishedScope: input.establishedScope }),
    machineFingerprint: input.fingerprint ?? FINGERPRINT_A,
    machineHostname: input.hostname ?? "workstation-a",
  });
}

function uncertainAfter(
  delegate: GatewayProtocolStore,
  phase: "before" | "after",
): GatewayProtocolStore {
  let inject = true;
  return {
    kind: delegate.kind,
    contractVersion: delegate.contractVersion,
    open: () => delegate.open(),
    close: () => delegate.close(),
    async transact<T>(
      scope: { readonly tenantId: string },
      fn: (tx: StoreTransaction) => Promise<T> | T,
    ): Promise<StoreOutcome<T>> {
      if (inject && phase === "before") {
        inject = false;
        return {
          ok: false,
          code: "durability_uncertain",
          message: "injected pre-commit power loss",
        };
      }
      const result = await delegate.transact(scope, fn);
      if (inject && phase === "after" && result.ok) {
        inject = false;
        return {
          ok: false,
          code: "durability_uncertain",
          message: "injected post-commit acknowledgement loss",
        };
      }
      return result;
    },
  };
}

function observedLifecycleStore(input: {
  readonly delegate: GatewayProtocolStore;
  readonly label: string;
  readonly calls: string[];
  readonly failOpenCount?: number;
  readonly failCloseCount?: number;
}): GatewayProtocolStore {
  let openFailures = input.failOpenCount ?? 0;
  let closeFailures = input.failCloseCount ?? 0;
  return {
    kind: input.delegate.kind,
    contractVersion: input.delegate.contractVersion,
    async open() {
      input.calls.push(`${input.label}.open`);
      if (openFailures > 0) {
        openFailures -= 1;
        return {
          ok: false as const,
          code: "unavailable" as const,
          message: `${input.label} injected open failure`,
        };
      }
      return input.delegate.open();
    },
    async close() {
      input.calls.push(`${input.label}.close`);
      if (closeFailures > 0) {
        closeFailures -= 1;
        return {
          ok: false as const,
          code: "unavailable" as const,
          message: `${input.label} injected close failure`,
        };
      }
      return input.delegate.close();
    },
    transact: (scope, fn) => input.delegate.transact(scope, fn),
  };
}

function failFirstLocatorMutation(
  delegate: ProductionCredentialScopeLocator,
  method: "bind" | "retire",
): {
  readonly locator: ProductionCredentialScopeLocator;
  attempts(): number;
} {
  let attempts = 0;
  const unavailable = () => ({
    ok: false as const,
    kind: "unavailable" as const,
    code: "unavailable" as const,
    message: "injected locator outage",
  });
  return {
    locator: {
      kind: delegate.kind,
      open: () => delegate.open(),
      close: () => delegate.close(),
      lookup: (input) => delegate.lookup(input),
      async bind(input) {
        if (method === "bind" && attempts++ === 0) return unavailable();
        return delegate.bind(input);
      },
      async retire(input) {
        if (method === "retire" && attempts++ === 0) return unavailable();
        return delegate.retire(input);
      },
    },
    attempts: () => attempts,
  };
}

function fixedLookupLocator(
  result: CredentialScopeLookupResult,
): ProductionCredentialScopeLocator {
  const unavailable = {
    ok: false as const,
    kind: "unavailable" as const,
    code: "unavailable" as const,
    message: "fixed lookup locator is read only",
  };
  return {
    kind: "memory",
    async open() {
      return { ok: true as const, value: undefined };
    },
    async close() {
      return { ok: true as const, value: undefined };
    },
    async lookup() {
      return structuredClone(result);
    },
    async bind() {
      return unavailable;
    },
    async retire() {
      return unavailable;
    },
  };
}

describe("production identity lifecycle", () => {
  it("is oidc, refuses pre-open auth, opens tenant then locator exactly once, and closes in reverse", async () => {
    const calls: string[] = [];
    const tenantStore = observedLifecycleStore({
      delegate: createRestartableTestStore().store,
      label: "tenant",
      calls,
    });
    const locatorStore = observedLifecycleStore({
      delegate: createRestartableTestStore().store,
      label: "locator",
      calls,
    });
    const identity = authority(
      tenantStore,
      createProductionCredentialScopeLocator({
        store: locatorStore,
        clock: () => NOW_MS,
      }),
    );
    expect(identity.kind).toBe("oidc");
    expect(identity.lifecycle()).toEqual({
      state: "closed",
      tenantAuthorityOpened: false,
      credentialLocatorOpened: false,
    });
    expect(await exactAuth(identity)).toEqual({
      ok: false,
      port: "identity",
      code: "unavailable",
      message: "production identity refused device authorization",
    });
    expect(await Promise.all([identity.open(), identity.open()])).toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
    ]);
    expect(await identity.open()).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual(["tenant.open", "locator.open"]);
    expect(identity.lifecycle()).toEqual({
      state: "open",
      tenantAuthorityOpened: true,
      credentialLocatorOpened: true,
    });
    expect(await Promise.all([identity.close(), identity.close()])).toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
    ]);
    expect(await identity.close()).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([
      "tenant.open",
      "locator.open",
      "locator.close",
      "tenant.close",
    ]);
    expect(await identity.open()).toEqual({ ok: true, value: undefined });
    expect(calls.slice(-2)).toEqual(["tenant.open", "locator.open"]);
    await identity.close();
  });

  it("rolls back tenant open when locator open fails and permits a clean reopen", async () => {
    const calls: string[] = [];
    const tenantStore = observedLifecycleStore({
      delegate: createRestartableTestStore().store,
      label: "tenant",
      calls,
    });
    const locatorStore = observedLifecycleStore({
      delegate: createRestartableTestStore().store,
      label: "locator",
      calls,
      failOpenCount: 1,
    });
    const identity = authority(
      tenantStore,
      createProductionCredentialScopeLocator({
        store: locatorStore,
        clock: () => NOW_MS,
      }),
    );
    const failed = await identity.open();
    expect(failed).toMatchObject({ ok: false, code: "unavailable" });
    if (!failed.ok) {
      expect(failed.message).toContain("locator_open:unavailable");
      expect(failed.message.length).toBeLessThanOrEqual(256);
    }
    expect(calls).toEqual(["tenant.open", "locator.open", "tenant.close"]);
    expect(identity.lifecycle()).toEqual({
      state: "closed",
      tenantAuthorityOpened: false,
      credentialLocatorOpened: false,
    });
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(await identity.open()).toEqual({ ok: true, value: undefined });
    expect(calls.slice(-2)).toEqual(["tenant.open", "locator.open"]);
    await identity.close();
  });

  it("fails closed without opening the locator when tenant authority is unavailable", async () => {
    const calls: string[] = [];
    const tenantStore = observedLifecycleStore({
      delegate: createRestartableTestStore().store,
      label: "tenant",
      calls,
      failOpenCount: 1,
    });
    const locatorStore = observedLifecycleStore({
      delegate: createRestartableTestStore().store,
      label: "locator",
      calls,
    });
    const identity = authority(
      tenantStore,
      createProductionCredentialScopeLocator({
        store: locatorStore,
        clock: () => NOW_MS,
      }),
    );
    expect(await identity.open()).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(calls).toEqual(["tenant.open"]);
    expect(identity.lifecycle()).toEqual({
      state: "failed",
      tenantAuthorityOpened: false,
      credentialLocatorOpened: false,
    });
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    await identity.close();
    expect(calls).toEqual(["tenant.open"]);
  });

  it("attempts both reverse-order closes once and returns a bounded aggregated failure", async () => {
    const calls: string[] = [];
    const tenantStore = observedLifecycleStore({
      delegate: createRestartableTestStore().store,
      label: "tenant",
      calls,
      failCloseCount: 1,
    });
    const locatorStore = observedLifecycleStore({
      delegate: createRestartableTestStore().store,
      label: "locator",
      calls,
      failCloseCount: 1,
    });
    const identity = authority(
      tenantStore,
      createProductionCredentialScopeLocator({
        store: locatorStore,
        clock: () => NOW_MS,
      }),
    );
    await identity.open();
    const failed = await identity.close();
    expect(failed).toMatchObject({ ok: false, code: "unavailable" });
    if (!failed.ok) {
      expect(failed.message).toContain("locator_close:unavailable");
      expect(failed.message).toContain("tenant_close:unavailable");
      expect(failed.message.length).toBeLessThanOrEqual(256);
    }
    expect(calls).toEqual([
      "tenant.open",
      "locator.open",
      "locator.close",
      "tenant.close",
    ]);
    expect(identity.lifecycle()).toMatchObject({ state: "failed" });
    expect(await identity.close()).toEqual(failed);
    expect(calls).toHaveLength(4);
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
  });
});

describe("production credential scope locator", () => {
  it("binds only absent/exact replay, retires by exact CAS, and never rebinds retired digests", async () => {
    const fixture = createRestartableTestStore();
    const locator = createProductionCredentialScopeLocator({
      store: fixture.store,
      clock: () => NOW_MS,
    });
    await locator.open();
    const bind = {
      operationId: "locator-bind-1",
      deviceTokenDigest: sha256(TOKEN_A),
      tenantId: TENANT_A,
      deviceId: DEVICE_ID,
    };
    expect(await locator.lookup({ deviceTokenDigest: bind.deviceTokenDigest })).toEqual({
      ok: true,
      kind: "missing",
    });
    expect(await locator.bind(bind)).toMatchObject({
      ok: true,
      kind: "committed",
      record: { state: "active", recordVersion: 1 },
    });
    expect(await locator.bind(bind)).toMatchObject({ ok: true, kind: "replay" });
    expect(
      await locator.bind({ ...bind, operationId: "locator-bind-2" }),
    ).toMatchObject({ ok: false, kind: "conflict" });
    expect(
      await locator.bind({
        ...bind,
        operationId: "locator-other-owner",
        tenantId: TENANT_B,
      }),
    ).toMatchObject({ ok: false, kind: "conflict" });
    const retire = {
      operationId: "locator-retire-1",
      deviceTokenDigest: bind.deviceTokenDigest,
      expectedRecordVersion: 1,
    };
    expect(
      await locator.retire({ ...retire, expectedRecordVersion: 2 }),
    ).toMatchObject({ ok: false, kind: "conflict" });
    expect(await locator.retire(retire)).toMatchObject({
      ok: true,
      kind: "committed",
      record: { state: "retired", recordVersion: 2 },
    });
    expect(await locator.retire(retire)).toMatchObject({
      ok: true,
      kind: "replay",
    });
    expect(await locator.bind(bind)).toMatchObject({
      ok: false,
      kind: "conflict",
    });
    expect(JSON.stringify(fixture.snapshot())).not.toContain(TOKEN_A);
  });

  it("fails closed on malformed global records and keeps exact missing distinct for reconciliation", async () => {
    const fixture = createRestartableTestStore();
    const locator = createProductionCredentialScopeLocator({
      store: fixture.store,
      clock: () => NOW_MS,
    });
    await locator.open();
    const digest = sha256(TOKEN_A);
    expect(await locator.lookup({ deviceTokenDigest: digest })).toEqual({
      ok: true,
      kind: "missing",
    });
    await fixture.store.transact(
      { tenantId: "gateway-credential-scope-global" },
      (tx) => {
        tx.stage({
          namespace: GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
          key: digest,
          value: {
            schema: GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
            tenantId: TENANT_A,
            deviceTokenDigest: digest,
            deviceId: DEVICE_ID,
            state: "active",
            lastOperationId: "malformed-locator",
            lastOperationDigest: digest,
            createdAtMs: NOW_MS,
            updatedAtMs: NOW_MS,
            recordVersion: 1,
            rawToken: TOKEN_A,
          },
          expect: { kind: "absent" },
        });
      },
    );
    expect(await locator.lookup({ deviceTokenDigest: digest })).toMatchObject({
      ok: false,
      kind: "corrupt",
    });
  });
});

describe("production identity durable records", () => {
  it("creates versioned records, reopens after restart, and returns the full auth authority", async () => {
    const { fixture, locatorFixture, identity } = await openAuthority();
    const change = committed(await identity.provisionDevice(provisionInput()));

    expect(change).toMatchObject({
      device: {
        schema: IDENTITY_DEVICE_SCHEMA,
        tenantId: TENANT_A,
        userId: "user-1",
        deviceId: DEVICE_ID,
        seatId: SEAT_ID,
        machineFingerprint: FINGERPRINT_A,
        deviceTokenDigest: sha256(TOKEN_A),
        status: "active",
        authorizationVersion: 1,
        connectionCapabilityVersion: 1,
        sessionCapabilityVersion: 1,
        recordVersion: 1,
      },
      seat: {
        schema: IDENTITY_TENANT_SEAT_SCHEMA,
        status: "active",
        seatAuthorityVersion: 1,
        recordVersion: 1,
      },
      head: {
        schema: IDENTITY_REVOCATION_HEAD_SCHEMA,
        lastSequence: 1,
      },
      event: {
        schema: IDENTITY_REVOCATION_EVENT_SCHEMA,
        sequence: 1,
        action: "seat_reassigned",
      },
    });
    expect(fixture.snapshot().records).toHaveLength(4);

    // Admission is fail closed until this subscriber catches up to the head.
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    await consumeAll(identity);
    const authenticated = await exactAuth(identity);
    expect(authenticated).toMatchObject({
      ok: true,
      value: {
        deviceStatus: "active",
        machineFingerprint: FINGERPRINT_A,
        authorizationVersion: 1,
        identityRecordVersion: 1,
        connectionCapabilityVersion: 1,
        sessionCapabilityVersion: 1,
        seatAuthorityVersion: 1,
        seatRecordVersion: 1,
        grantedConnectionCapabilities: [
          "journal_v1",
          "transport_streamable_http",
        ],
        grantedSessionCapabilities: [
          "batch_atomic",
          "doc_context_cached_v1",
        ],
      },
    });

    await identity.close();
    const restartedStore = fixture.restart();
    const restartedLocator = createProductionCredentialScopeLocator({
      store: locatorFixture.restart(),
      clock: () => NOW_MS,
    });
    const restarted = authority(restartedStore, restartedLocator);
    await restarted.open();
    const reopenedHelloCredential = {
      deviceToken: TOKEN_A,
      connectionId: "connection-1",
      claimedDeviceId: DEVICE_ID,
      machineFingerprint: FINGERPRINT_A,
      machineHostname: "renamed-workstation",
    };
    expect(await restarted.authenticateDevice(reopenedHelloCredential)).toEqual(
      authenticated,
    );
  });

  it("uses a digest-only durable locator and never authorizes a cross-scope guess", async () => {
    const { locatorFixture, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);

    const resolved = await identity.authenticateDevice({
      deviceToken: TOKEN_A,
      connectionId: "connection-resolved",
      claimedDeviceId: DEVICE_ID,
      machineFingerprint: FINGERPRINT_A,
    });
    expect(resolved).toMatchObject({ ok: true });
    const locatorRecords = locatorFixture.snapshot().records;
    expect(locatorRecords).toHaveLength(1);
    expect(locatorRecords[0]).toMatchObject({
      namespace: "gateway.credential-scope/v1",
      key: sha256(TOKEN_A),
      value: {
        deviceTokenDigest: sha256(TOKEN_A),
        tenantId: TENANT_A,
        deviceId: DEVICE_ID,
        state: "active",
      },
    });
    expect(JSON.stringify(locatorRecords)).not.toContain(TOKEN_A);
    expect(
      await identity.authenticateDevice({
        deviceToken: TOKEN_A,
        connectionId: "connection-wrong-device",
        claimedDeviceId: "device-other",
        machineFingerprint: FINGERPRINT_A,
      }),
    ).toMatchObject({ ok: false });
    const wireTenantHint = {
      deviceToken: TOKEN_A,
      connectionId: "connection-wire-tenant-hint",
      claimedDeviceId: DEVICE_ID,
      machineFingerprint: FINGERPRINT_A,
      machineHostname: "wire-host",
      tenantId: TENANT_A,
      deviceId: DEVICE_ID,
    } as unknown as Parameters<
      ProductionIdentityAuthority["authenticateDevice"]
    >[0];
    expect(await identity.authenticateDevice(wireTenantHint)).toMatchObject({
      ok: false,
    });
  });

  it("maps missing, retired, ambiguous, corrupt, wrong-owner, and claimed-device locator states to one denial", async () => {
    const { fixture, locator, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);
    const located = await locator.lookup({ deviceTokenDigest: sha256(TOKEN_A) });
    expect(located).toMatchObject({ ok: true, kind: "active" });
    if (!located.ok || located.kind !== "active") return;
    await identity.close();
    const variants: readonly {
      readonly result: CredentialScopeLookupResult;
      readonly claimedDeviceId?: string;
    }[] = [
      { result: { ok: true, kind: "missing" } },
      { result: { ok: true, kind: "ambiguous" } },
      {
        result: {
          ok: true,
          kind: "retired",
          record: { ...located.record, state: "retired" },
        },
      },
      {
        result: {
          ok: false,
          kind: "corrupt",
          code: "credential_scope_corrupt",
          message: "malformed locator",
        },
      },
      {
        result: {
          ok: true,
          kind: "active",
          record: { ...located.record, tenantId: TENANT_B },
        },
      },
      {
        result: {
          ok: true,
          kind: "active",
          record: {
            ...located.record,
            deviceTokenDigest: sha256(TOKEN_B),
          },
        },
      },
      { result: located, claimedDeviceId: "device-other" },
    ];
    const denials: unknown[] = [];
    for (const variant of variants) {
      const candidate = authority(
        fixture.restart(),
        fixedLookupLocator(variant.result),
      );
      await candidate.open();
      denials.push(
        await exactAuth(candidate, {
          claimedDeviceId: variant.claimedDeviceId ?? DEVICE_ID,
        }),
      );
      await candidate.close();
    }
    expect(denials.every((denial) => JSON.stringify(denial) === JSON.stringify(denials[0]))).toBe(
      true,
    );
    expect(denials[0]).toEqual({
      ok: false,
      port: "identity",
      code: "unavailable",
      message: "production identity refused device authorization",
    });
  });

  it("retains durable revoked status across restart", async () => {
    const { fixture, locatorFixture, identity } = await openAuthority();
    const provisioned = committed(
      await identity.provisionDevice(provisionInput()),
    );
    const revoked = committed(
      await identity.revokeDevice({
        operationId: "operation-revoke-1",
        tenantId: TENANT_A,
        deviceId: DEVICE_ID,
        expectedDeviceRecordVersion: provisioned.device!.recordVersion,
        expectedSeatRecordVersion: provisioned.seat.recordVersion,
      }),
    );
    expect(revoked.device).toMatchObject({
      status: "revoked",
      authorizationVersion: 2,
      recordVersion: 2,
    });
    expect(revoked.seat).toMatchObject({
      status: "revoked",
      seatAuthorityVersion: 2,
      recordVersion: 2,
    });
    await consumeAll(identity);
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(
      await exactAuth(identity, {
        establishedScope: { tenantId: TENANT_A, deviceId: DEVICE_ID },
      }),
    ).toMatchObject({
      ok: true,
      value: { deviceStatus: "revoked", authorizationVersion: 2 },
    });

    await identity.close();
    const restarted = authority(
      fixture.restart(),
      createProductionCredentialScopeLocator({
        store: locatorFixture.restart(),
        clock: () => NOW_MS,
      }),
    );
    await restarted.open();
    expect(await exactAuth(restarted)).toMatchObject({ ok: false });
    expect(
      await exactAuth(restarted, {
        establishedScope: { tenantId: TENANT_A, deviceId: DEVICE_ID },
      }),
    ).toMatchObject({
      ok: true,
      value: { deviceStatus: "revoked", authorizationVersion: 2 },
    });
  });
});

describe("production identity CAS and atomic event allocation", () => {
  it("treats exact duplicate replay as a no-op and rejects changed replay", async () => {
    const { fixture, identity } = await openAuthority();
    const input = provisionInput();
    const first = committed(await identity.provisionDevice(input));
    expect(await identity.provisionDevice(input)).toMatchObject({
      ok: true,
      kind: "replay",
      change: { head: { lastSequence: 1 } },
    });
    expect(fixture.snapshot().records).toHaveLength(4);

    expect(
      await identity.provisionDevice({ ...input, deviceToken: TOKEN_B }),
    ).toMatchObject({ ok: false, kind: "conflict" });

    const replacement = committed(
      await identity.provisionDevice(
        provisionInput({
          operationId: "operation-provision-replacement",
          deviceToken: TOKEN_B,
          expectedDeviceRecordVersion: first.device!.recordVersion,
          expectedSeatRecordVersion: first.seat.recordVersion,
        }),
      ),
    );
    expect(replacement).toMatchObject({
      device: { authorizationVersion: 2, recordVersion: 2 },
      seat: { seatAuthorityVersion: 2, recordVersion: 2 },
      head: { lastSequence: 2 },
      event: { sequence: 2 },
    });
  });

  it("rotates locator authority by binding new digest before retiring old", async () => {
    const { identity, locator } = await openAuthority();
    const initial = committed(await identity.provisionDevice(provisionInput()));
    committed(
      await identity.provisionDevice(
        provisionInput({
          operationId: "operation-rotate-success",
          deviceToken: TOKEN_B,
          expectedDeviceRecordVersion: initial.device!.recordVersion,
          expectedSeatRecordVersion: initial.seat.recordVersion,
        }),
      ),
    );
    expect(await locator.lookup({ deviceTokenDigest: sha256(TOKEN_B) })).toMatchObject({
      ok: true,
      kind: "active",
      record: { tenantId: TENANT_A, deviceId: DEVICE_ID },
    });
    expect(await locator.lookup({ deviceTokenDigest: sha256(TOKEN_A) })).toMatchObject({
      ok: true,
      kind: "retired",
    });
    await consumeAll(identity);
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(await exactAuth(identity, { token: TOKEN_B })).toMatchObject({
      ok: true,
      value: {
        authorizationVersion: 2,
        connectionCapabilityVersion: 2,
        sessionCapabilityVersion: 2,
      },
    });
  });

  it("returns reconciliation_required without retry or rollback when new locator bind fails", async () => {
    const authorityFixture = createRestartableTestStore();
    const locatorFixture = createRestartableTestStore();
    const firstLocator = createProductionCredentialScopeLocator({
      store: locatorFixture.store,
      clock: () => NOW_MS,
    });
    const first = authority(authorityFixture.store, firstLocator);
    await first.open();
    const initial = committed(await first.provisionDevice(provisionInput()));
    await first.close();

    const durableLocator = createProductionCredentialScopeLocator({
      store: locatorFixture.restart(),
      clock: () => NOW_MS,
    });
    const injected = failFirstLocatorMutation(durableLocator, "bind");
    const restarted = authority(authorityFixture.restart(), injected.locator);
    await restarted.open();
    const rotation = provisionInput({
      operationId: "operation-rotate-bind-cut",
      deviceToken: TOKEN_B,
      expectedDeviceRecordVersion: initial.device!.recordVersion,
      expectedSeatRecordVersion: initial.seat.recordVersion,
    });
    const partial = await restarted.provisionDevice(rotation);
    expect(partial).toMatchObject({
      ok: false,
      kind: "reconciliation_required",
      change: {
        device: { deviceTokenDigest: sha256(TOKEN_B) },
        head: { lastSequence: 2 },
      },
    });
    expect(injected.attempts()).toBe(1);
    expect(await durableLocator.lookup({ deviceTokenDigest: sha256(TOKEN_B) })).toEqual({
      ok: true,
      kind: "missing",
    });
    expect(await durableLocator.lookup({ deviceTokenDigest: sha256(TOKEN_A) })).toMatchObject({
      ok: true,
      kind: "active",
    });
    expect(await restarted.provisionDevice(rotation)).toMatchObject({
      ok: true,
      kind: "replay",
    });
    expect(injected.attempts()).toBe(2);
    expect(await durableLocator.lookup({ deviceTokenDigest: sha256(TOKEN_A) })).toMatchObject({
      ok: true,
      kind: "retired",
    });
  });

  it("keeps committed rotation/revoke truth when locator retirement crosses a cutpoint", async () => {
    const authorityFixture = createRestartableTestStore();
    const locatorFixture = createRestartableTestStore();
    const durableLocator = createProductionCredentialScopeLocator({
      store: locatorFixture.store,
      clock: () => NOW_MS,
    });
    const injected = failFirstLocatorMutation(durableLocator, "retire");
    const identity = authority(authorityFixture.store, injected.locator);
    await identity.open();
    const initial = committed(await identity.provisionDevice(provisionInput()));
    const rotationInput = provisionInput({
      operationId: "operation-rotate-retire-cut",
      deviceToken: TOKEN_B,
      expectedDeviceRecordVersion: initial.device!.recordVersion,
      expectedSeatRecordVersion: initial.seat.recordVersion,
    });
    expect(await identity.provisionDevice(rotationInput)).toMatchObject({
      ok: false,
      kind: "reconciliation_required",
      change: { head: { lastSequence: 2 } },
    });
    expect(injected.attempts()).toBe(1);
    expect(await durableLocator.lookup({ deviceTokenDigest: sha256(TOKEN_B) })).toMatchObject({
      ok: true,
      kind: "active",
    });
    expect(await durableLocator.lookup({ deviceTokenDigest: sha256(TOKEN_A) })).toMatchObject({
      ok: true,
      kind: "active",
    });
    await consumeAll(identity);
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(await exactAuth(identity, { token: TOKEN_B })).toMatchObject({
      ok: true,
      value: { authorizationVersion: 2 },
    });
    expect(await identity.provisionDevice(rotationInput)).toMatchObject({
      ok: true,
      kind: "replay",
    });
    expect(injected.attempts()).toBe(2);

    const rotated = await identity.prepareTenantResync({ tenantId: TENANT_A });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    const device = rotated.snapshot.devices[0]!;
    const seat = rotated.snapshot.seats[0]!;
    const revokeInput = {
      operationId: "operation-revoke-retire-cut",
      tenantId: TENANT_A,
      deviceId: DEVICE_ID,
      expectedDeviceRecordVersion: device.recordVersion,
      expectedSeatRecordVersion: seat.recordVersion,
    };
    const secondInjected = failFirstLocatorMutation(durableLocator, "retire");
    const revokeAuthority = authority(authorityFixture.store, secondInjected.locator);
    // Both adapters share already-open stores; no second lifecycle open is needed.
    expect(await revokeAuthority.revokeDevice(revokeInput)).toMatchObject({
      ok: false,
      kind: "reconciliation_required",
      change: { device: { status: "revoked" }, head: { lastSequence: 3 } },
    });
    expect(secondInjected.attempts()).toBe(1);
    expect(await revokeAuthority.revokeDevice(revokeInput)).toMatchObject({
      ok: true,
      kind: "replay",
    });
  });

  it("reports digest collision after tenant commit and leaves the other owner unchanged", async () => {
    const { identity, locator } = await openAuthority();
    expect(
      await locator.bind({
        operationId: "other-owner-bind",
        deviceTokenDigest: sha256(TOKEN_B),
        tenantId: TENANT_B,
        deviceId: DEVICE_ID,
      }),
    ).toMatchObject({ ok: true, kind: "committed" });
    const initial = committed(await identity.provisionDevice(provisionInput()));
    const collision = await identity.provisionDevice(
      provisionInput({
        operationId: "operation-digest-collision",
        deviceToken: TOKEN_B,
        expectedDeviceRecordVersion: initial.device!.recordVersion,
        expectedSeatRecordVersion: initial.seat.recordVersion,
      }),
    );
    expect(collision).toMatchObject({
      ok: false,
      kind: "reconciliation_required",
      change: {
        device: { deviceTokenDigest: sha256(TOKEN_B) },
        head: { lastSequence: 2 },
      },
    });
    expect(await locator.lookup({ deviceTokenDigest: sha256(TOKEN_B) })).toMatchObject({
      ok: true,
      kind: "active",
      record: { tenantId: TENANT_B, deviceId: DEVICE_ID },
    });
    await consumeAll(identity);
    expect(await exactAuth(identity, { token: TOKEN_B })).toMatchObject({
      ok: false,
    });
  });

  it("rejects existing-device seat drift without tenant or locator writes", async () => {
    const { fixture, locatorFixture, identity } = await openAuthority();
    const initial = committed(await identity.provisionDevice(provisionInput()));
    const beforeAuthority = JSON.stringify(fixture.snapshot());
    const beforeLocator = JSON.stringify(locatorFixture.snapshot());
    expect(
      await identity.provisionDevice(
        provisionInput({
          operationId: "operation-seat-drift",
          seatId: "seat-other",
          deviceToken: TOKEN_B,
          expectedDeviceRecordVersion: initial.device!.recordVersion,
          expectedSeatRecordVersion: null,
        }),
      ),
    ).toMatchObject({ ok: false, kind: "conflict" });
    expect(JSON.stringify(fixture.snapshot())).toBe(beforeAuthority);
    expect(JSON.stringify(locatorFixture.snapshot())).toBe(beforeLocator);
  });

  it("serializes issue versus revoke by CAS so only one stale writer wins", async () => {
    const { identity } = await openAuthority();
    const initial = committed(await identity.provisionDevice(provisionInput()));
    const replacement = identity.provisionDevice(
      provisionInput({
        operationId: "operation-race-replace",
        deviceToken: TOKEN_B,
        expectedDeviceRecordVersion: initial.device!.recordVersion,
        expectedSeatRecordVersion: initial.seat.recordVersion,
      }),
    );
    const revocation = identity.revokeDevice({
      operationId: "operation-race-revoke",
      tenantId: TENANT_A,
      deviceId: DEVICE_ID,
      expectedDeviceRecordVersion: initial.device!.recordVersion,
      expectedSeatRecordVersion: initial.seat.recordVersion,
    });
    const results = await Promise.all([replacement, revocation]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter((result) => !result.ok && result.kind === "conflict"),
    ).toHaveLength(1);

    const snapshot = await identity.prepareTenantResync({ tenantId: TENANT_A });
    expect(snapshot).toMatchObject({
      ok: true,
      snapshot: { headSequence: 2 },
    });
  });

  it("allocates a contiguous head under create contention with no duplicate event", async () => {
    const { identity } = await openAuthority();
    const firstInput = provisionInput({
      operationId: "operation-allocator-a",
      deviceId: "device-a",
      seatId: "seat-a",
      deviceToken: TOKEN_A,
    });
    const secondInput = provisionInput({
      operationId: "operation-allocator-b",
      deviceId: "device-b",
      seatId: "seat-b",
      deviceToken: TOKEN_B,
    });
    const raced = await Promise.all([
      identity.provisionDevice(firstInput),
      identity.provisionDevice(secondInput),
    ]);
    expect(raced.filter((result) => result.ok)).toHaveLength(1);
    expect(raced.filter((result) => !result.ok)).toHaveLength(1);
    const loser = raced[0]!.ok ? secondInput : firstInput;
    expect(await identity.provisionDevice(loser)).toMatchObject({
      ok: true,
      kind: "committed",
      change: { head: { lastSequence: 2 }, event: { sequence: 2 } },
    });
    const consumed = await identity.consumeRevocationEvents({
      tenantId: TENANT_A,
      maxEvents: 10,
    });
    expect(consumed).toMatchObject({
      ok: true,
      kind: "advanced",
      complete: true,
      events: [{ sequence: 1 }, { sequence: 2 }],
    });
  });

  it("allows an unrelated same-tenant pair to lag the current tenant head", async () => {
    const { identity } = await openAuthority();
    const first = committed(
      await identity.provisionDevice(
        provisionInput({
          operationId: "operation-unrelated-a",
          deviceId: "device-a",
          seatId: "seat-a",
          deviceToken: TOKEN_A,
        }),
      ),
    );
    committed(
      await identity.provisionDevice(
        provisionInput({
          operationId: "operation-unrelated-b",
          deviceId: "device-b",
          seatId: "seat-b",
          deviceToken: TOKEN_B,
        }),
      ),
    );
    expect(first.device).toMatchObject({ lastAuthoritySequence: 1 });
    await consumeAll(identity);
    expect(
      await exactAuth(identity, {
        claimedDeviceId: "device-a",
        token: TOKEN_A,
      }),
    ).toMatchObject({
      ok: true,
      value: { actor: { deviceId: "device-a" } },
    });
    expect(
      await exactAuth(identity, {
        claimedDeviceId: "device-b",
        token: TOKEN_B,
      }),
    ).toMatchObject({
      ok: true,
      value: { actor: { deviceId: "device-b" } },
    });
  });

  it("revokes a seat and its attached device in the same head/event transaction", async () => {
    const { identity } = await openAuthority();
    const initial = committed(await identity.provisionDevice(provisionInput()));
    const revoked = committed(
      await identity.revokeSeat({
        operationId: "operation-seat-revoke",
        tenantId: TENANT_A,
        seatId: SEAT_ID,
        expectedSeatRecordVersion: initial.seat.recordVersion,
        expectedDeviceRecordVersion: initial.device!.recordVersion,
      }),
    );
    expect(revoked).toMatchObject({
      device: { status: "revoked", authorizationVersion: 2 },
      seat: { status: "revoked", seatAuthorityVersion: 2 },
      head: { lastSequence: 2 },
      event: {
        sequence: 2,
        action: "seat_revoked",
        authorizationVersion: 2,
        seatAuthorityVersion: 2,
      },
    });
    expect(
      await identity.revokeSeat({
        operationId: "operation-seat-revoke",
        tenantId: TENANT_A,
        seatId: SEAT_ID,
        expectedSeatRecordVersion: initial.seat.recordVersion,
        expectedDeviceRecordVersion: initial.device!.recordVersion,
      }),
    ).toMatchObject({ ok: true, kind: "replay" });
  });

  it("recovers an exact post-commit acknowledgement loss and leaves no partial pre-commit state", async () => {
    const committedFixture = createRestartableTestStore();
    const committedLocatorFixture = createRestartableTestStore();
    const recoveredAuthority = authority(
      uncertainAfter(committedFixture.store, "after"),
      createProductionCredentialScopeLocator({
        store: committedLocatorFixture.store,
        clock: () => NOW_MS,
      }),
    );
    await recoveredAuthority.open();
    expect(await recoveredAuthority.provisionDevice(provisionInput())).toMatchObject({
      ok: true,
      kind: "recovered",
      change: {
        head: { lastSequence: 1 },
        event: { sequence: 1 },
      },
    });
    expect(committedFixture.snapshot().records).toHaveLength(4);

    const uncommittedFixture = createRestartableTestStore();
    const uncommittedLocatorFixture = createRestartableTestStore();
    const uncertainAuthority = authority(
      uncertainAfter(uncommittedFixture.store, "before"),
      createProductionCredentialScopeLocator({
        store: uncommittedLocatorFixture.store,
        clock: () => NOW_MS,
      }),
    );
    await uncertainAuthority.open();
    expect(await uncertainAuthority.provisionDevice(provisionInput())).toMatchObject({
      ok: false,
      kind: "unavailable",
      code: "durability_uncertain",
    });
    expect(uncommittedFixture.snapshot().records).toHaveLength(0);
  });
});

describe("revocation cursor, gap block, and bounded digest resync", () => {
  it("advances only contiguous events and requires full digest verification to unblock", async () => {
    const { fixture, identity } = await openAuthority();
    const initial = committed(await identity.provisionDevice(provisionInput()));
    committed(
      await identity.revokeDevice({
        operationId: "operation-gap-revoke",
        tenantId: TENANT_A,
        deviceId: DEVICE_ID,
        expectedDeviceRecordVersion: initial.device!.recordVersion,
        expectedSeatRecordVersion: initial.seat.recordVersion,
      }),
    );

    const eventOne = fixture
      .snapshot()
      .records.find(
        (record) =>
          record.namespace === IDENTITY_REVOCATION_EVENT_SCHEMA &&
          record.tenantId === TENANT_A &&
          record.key === `${TENANT_A}/1`,
      )!;
    expect(
      await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
        tx.stage({
          namespace: IDENTITY_REVOCATION_EVENT_SCHEMA,
          key: `${TENANT_A}/1`,
          value: null,
          expect: { kind: "version", version: eventOne.version },
        });
      }),
    ).toMatchObject({ ok: true });

    const blocked = await identity.consumeRevocationEvents({ tenantId: TENANT_A });
    expect(blocked).toMatchObject({
      ok: true,
      kind: "blocked",
      reason: "event_missing",
      cursor: { lastContiguousSequence: 0, status: "blocked" },
    });
    expect(await exactAuth(identity)).toMatchObject({ ok: false });

    const prepared = await identity.prepareTenantResync({ tenantId: TENANT_A });
    expect(prepared).toMatchObject({
      ok: true,
      snapshot: {
        headSequence: 2,
        devices: [{ status: "revoked" }],
        seats: [{ status: "revoked" }],
      },
    });
    if (!prepared.ok) return;
    expect(
      await identity.commitTenantResync({
        tenantId: TENANT_A,
        expectedAuthorityDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toMatchObject({ ok: false, kind: "conflict" });
    expect(
      await identity.consumeRevocationEvents({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: true, kind: "blocked" });

    const committedResync = await identity.commitTenantResync({
      tenantId: TENANT_A,
      expectedAuthorityDigest: prepared.snapshot.authorityDigest,
    });
    expect(committedResync).toMatchObject({
      ok: true,
      cursor: {
        lastContiguousSequence: 2,
        lastResyncHead: 2,
        lastResyncDigest: prepared.snapshot.authorityDigest,
        status: "current",
      },
    });
    expect(
      await identity.consumeRevocationEvents({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: true, kind: "current", complete: true });
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(
      await exactAuth(identity, {
        establishedScope: { tenantId: TENANT_A, deviceId: DEVICE_ID },
      }),
    ).toMatchObject({
      ok: true,
      value: { deviceStatus: "revoked" },
    });
  });

  it("persists out-of-order and corrupt event blocks instead of advancing", async () => {
    const { fixture, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    const event = fixture
      .snapshot()
      .records.find(
        (record) => record.namespace === IDENTITY_REVOCATION_EVENT_SCHEMA,
      )!;
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: event.namespace,
        key: event.key,
        value: { ...(event.value as Record<string, unknown>), sequence: 2 } as never,
        expect: { kind: "version", version: event.version },
      });
    });
    expect(
      await identity.consumeRevocationEvents({ tenantId: TENANT_A }),
    ).toMatchObject({
      ok: true,
      kind: "blocked",
      reason: "event_out_of_order",
      cursor: { lastContiguousSequence: 0 },
    });

    expect(
      await identity.prepareTenantResync({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
    const corruptEvent = fixture
      .snapshot()
      .records.find(
        (record) => record.namespace === IDENTITY_REVOCATION_EVENT_SCHEMA,
      )!;
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: event.namespace,
        key: event.key,
        value: event.value,
        expect: { kind: "version", version: corruptEvent.version },
      });
    });
    const prepared = await identity.prepareTenantResync({ tenantId: TENANT_A });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      await identity.commitTenantResync({
        tenantId: TENANT_A,
        expectedAuthorityDigest: prepared.snapshot.authorityDigest,
      }),
    ).toMatchObject({ ok: true });

    const second = committed(
      await identity.provisionDevice(
        provisionInput({
          operationId: "operation-corrupt-event-2",
          deviceToken: TOKEN_B,
          expectedDeviceRecordVersion: 1,
          expectedSeatRecordVersion: 1,
        }),
      ),
    );
    const eventTwo = fixture
      .snapshot()
      .records.find(
        (record) =>
          record.namespace === IDENTITY_REVOCATION_EVENT_SCHEMA &&
          record.key === `${TENANT_A}/${second.event.sequence}`,
      )!;
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: eventTwo.namespace,
        key: eventTwo.key,
        value: {
          ...(eventTwo.value as Record<string, unknown>),
          operationDigest: `sha256:${"F".repeat(64)}`,
        } as never,
        expect: { kind: "version", version: eventTwo.version },
      });
    });
    expect(
      await identity.consumeRevocationEvents({ tenantId: TENANT_A }),
    ).toMatchObject({
      ok: true,
      kind: "blocked",
      reason: "event_corrupt",
      cursor: { lastContiguousSequence: 1 },
    });
  });
});

describe("fingerprint claim consistency and tenant isolation", () => {
  it("rejects noncanonical enrolment, missing legacy claim, malformed claim, and mismatch", async () => {
    const { identity } = await openAuthority();
    for (const malformed of [
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
      "a".repeat(64),
    ]) {
      expect(
        await identity.provisionDevice(
          provisionInput({
            operationId: `operation-malformed-${malformed.length}`,
            machineFingerprint: malformed,
          }),
        ),
      ).toMatchObject({ ok: false, kind: "invalid_input" });
    }

    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);
    expect(
      await identity.authenticateDevice({
        deviceToken: TOKEN_A,
        connectionId: "connection-missing-legacy-claim",
        claimedDeviceId: DEVICE_ID,
      }),
    ).toMatchObject({ ok: false });
    for (const fingerprint of [
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
      FINGERPRINT_B,
    ]) {
      expect(await exactAuth(identity, { fingerprint })).toMatchObject({
        ok: false,
      });
    }
  });

  it("accepts hostname-only change and explicitly does not claim copied-token anti-cloning", async () => {
    const { identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);
    const original = await exactAuth(identity, { hostname: "host-original" });
    const renamed = await exactAuth(identity, { hostname: "host-renamed" });
    const copiedTokenAndCopiedClaim = await exactAuth(identity, {
      hostname: "different-physical-machine-claim-copy",
    });
    expect(original).toMatchObject({ ok: true });
    expect(renamed).toEqual(original);
    expect(copiedTokenAndCopiedClaim).toEqual(original);
    expect(
      await exactAuth(identity, {
        hostname: "different-physical-machine-mismatch",
        fingerprint: FINGERPRINT_B,
      }),
    ).toMatchObject({ ok: false });
  });

  it("keeps identical device and seat ids isolated by tenant", async () => {
    const { fixture, identity } = await openAuthority();
    const a = committed(await identity.provisionDevice(provisionInput()));
    committed(
      await identity.provisionDevice(
        provisionInput({
          operationId: "operation-tenant-b",
          tenantId: TENANT_B,
          deviceToken: TOKEN_B,
          machineFingerprint: FINGERPRINT_B,
        }),
      ),
    );
    await consumeAll(identity, TENANT_A);
    await consumeAll(identity, TENANT_B);
    const initialHeads = fixture
      .snapshot()
      .records.filter(
        (record) => record.namespace === IDENTITY_REVOCATION_HEAD_SCHEMA,
      )
      .map((record) => ({
        tenantId: record.tenantId,
        lastSequence: (record.value as { lastSequence: number }).lastSequence,
      }))
      .sort((left, right) => left.tenantId.localeCompare(right.tenantId));
    expect(initialHeads).toEqual([
      { tenantId: TENANT_A, lastSequence: 1 },
      { tenantId: TENANT_B, lastSequence: 1 },
    ]);
    expect(await exactAuth(identity)).toMatchObject({
      ok: true,
      value: { actor: { tenantId: TENANT_A } },
    });
    expect(
      await exactAuth(identity, {
        token: TOKEN_B,
        fingerprint: FINGERPRINT_B,
      }),
    ).toMatchObject({
      ok: true,
      value: { actor: { tenantId: TENANT_B } },
    });
    expect(
      await exactAuth(identity, {
        token: TOKEN_A,
        fingerprint: FINGERPRINT_A,
        establishedScope: { tenantId: TENANT_B, deviceId: DEVICE_ID },
      }),
    ).toMatchObject({ ok: false });

    committed(
      await identity.revokeDevice({
        operationId: "operation-tenant-a-revoke",
        tenantId: TENANT_A,
        deviceId: DEVICE_ID,
        expectedDeviceRecordVersion: a.device!.recordVersion,
        expectedSeatRecordVersion: a.seat.recordVersion,
      }),
    );
    await consumeAll(identity, TENANT_A);
    const finalHeads = fixture
      .snapshot()
      .records.filter(
        (record) => record.namespace === IDENTITY_REVOCATION_HEAD_SCHEMA,
      )
      .map((record) => ({
        tenantId: record.tenantId,
        lastSequence: (record.value as { lastSequence: number }).lastSequence,
      }))
      .sort((left, right) => left.tenantId.localeCompare(right.tenantId));
    expect(finalHeads).toEqual([
      { tenantId: TENANT_A, lastSequence: 2 },
      { tenantId: TENANT_B, lastSequence: 1 },
    ]);
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(
      await exactAuth(identity, {
        establishedScope: { tenantId: TENANT_A, deviceId: DEVICE_ID },
      }),
    ).toMatchObject({
      ok: true,
      value: { deviceStatus: "revoked" },
    });
    expect(
      await exactAuth(identity, {
        token: TOKEN_B,
        fingerprint: FINGERPRINT_B,
      }),
    ).toMatchObject({ ok: true, value: { deviceStatus: "active" } });
  });

  it("fails closed on a corrupt durable device record", async () => {
    const { fixture, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);
    const device = fixture
      .snapshot()
      .records.find((record) => record.namespace === IDENTITY_DEVICE_SCHEMA)!;
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: IDENTITY_DEVICE_SCHEMA,
        key: device.key,
        value: {
          ...(device.value as Record<string, unknown>),
          machineFingerprint: `sha256:${"A".repeat(64)}`,
        } as never,
        expect: { kind: "version", version: device.version },
      });
    });
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(
      await identity.prepareTenantResync({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("rejects a touched event whose seat id differs from the seat record", async () => {
    const { fixture, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);
    const event = fixture
      .snapshot()
      .records.find(
        (record) => record.namespace === IDENTITY_REVOCATION_EVENT_SCHEMA,
      )!;
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: event.namespace,
        key: event.key,
        value: {
          ...(event.value as Record<string, unknown>),
          seatId: "seat-wrong",
        } as never,
        expect: { kind: "version", version: event.version },
      });
    });
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(
      await identity.prepareTenantResync({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("rejects a seat-only revocation event naming the wrong seat", async () => {
    const { fixture, identity } = await openAuthority();
    const operationDigest = sha256("seat-only-operation");
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: IDENTITY_REVOCATION_HEAD_SCHEMA,
        key: TENANT_A,
        value: {
          schema: IDENTITY_REVOCATION_HEAD_SCHEMA,
          tenantId: TENANT_A,
          lastSequence: 1,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
          recordVersion: 1,
        },
        expect: { kind: "absent" },
      });
      tx.stage({
        namespace: IDENTITY_TENANT_SEAT_SCHEMA,
        key: `${TENANT_A}/${SEAT_ID}`,
        value: {
          schema: IDENTITY_TENANT_SEAT_SCHEMA,
          tenantId: TENANT_A,
          seatId: SEAT_ID,
          userId: "user-1",
          deviceId: null,
          status: "revoked",
          seatAuthorityVersion: 1,
          lastAuthorityOperationId: "seat-only-operation",
          lastAuthorityOperationDigest: operationDigest,
          lastAuthoritySequence: 1,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
          recordVersion: 1,
        },
        expect: { kind: "absent" },
      });
      tx.stage({
        namespace: IDENTITY_REVOCATION_EVENT_SCHEMA,
        key: `${TENANT_A}/1`,
        value: {
          schema: IDENTITY_REVOCATION_EVENT_SCHEMA,
          tenantId: TENANT_A,
          sequence: 1,
          deviceId: null,
          seatId: "seat-wrong",
          action: "seat_revoked",
          authorizationVersion: null,
          seatAuthorityVersion: 1,
          priorDeviceTokenDigest: null,
          deviceTokenDigest: null,
          operationId: "seat-only-operation",
          operationDigest,
          committedAtMs: NOW_MS,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
          recordVersion: 1,
        },
        expect: { kind: "absent" },
      });
    });
    expect(
      await identity.prepareTenantResync({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("rejects revoked-event records corrupted back to active state", async () => {
    const { fixture, identity } = await openAuthority();
    const initial = committed(await identity.provisionDevice(provisionInput()));
    committed(
      await identity.revokeDevice({
        operationId: "operation-revoked-active-corruption",
        tenantId: TENANT_A,
        deviceId: DEVICE_ID,
        expectedDeviceRecordVersion: initial.device!.recordVersion,
        expectedSeatRecordVersion: initial.seat.recordVersion,
      }),
    );
    await consumeAll(identity);
    const device = fixture
      .snapshot()
      .records.find((record) => record.namespace === IDENTITY_DEVICE_SCHEMA)!;
    const seat = fixture
      .snapshot()
      .records.find(
        (record) => record.namespace === IDENTITY_TENANT_SEAT_SCHEMA,
      )!;
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: device.namespace,
        key: device.key,
        value: {
          ...(device.value as Record<string, unknown>),
          status: "active",
        } as never,
        expect: { kind: "version", version: device.version },
      });
      tx.stage({
        namespace: seat.namespace,
        key: seat.key,
        value: {
          ...(seat.value as Record<string, unknown>),
          status: "active",
        } as never,
        expect: { kind: "version", version: seat.version },
      });
    });
    expect(
      await exactAuth(identity, {
        establishedScope: { tenantId: TENANT_A, deviceId: DEVICE_ID },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await identity.prepareTenantResync({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("rejects a coherent-looking device/seat pair whose sequence is ahead of head", async () => {
    const { fixture, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);
    const device = fixture
      .snapshot()
      .records.find((record) => record.namespace === IDENTITY_DEVICE_SCHEMA)!;
    const seat = fixture
      .snapshot()
      .records.find(
        (record) => record.namespace === IDENTITY_TENANT_SEAT_SCHEMA,
      )!;
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: device.namespace,
        key: device.key,
        value: {
          ...(device.value as Record<string, unknown>),
          lastAuthoritySequence: 2,
        } as never,
        expect: { kind: "version", version: device.version },
      });
      tx.stage({
        namespace: seat.namespace,
        key: seat.key,
        value: {
          ...(seat.value as Record<string, unknown>),
          lastAuthoritySequence: 2,
        } as never,
        expect: { kind: "version", version: seat.version },
      });
    });
    expect(await exactAuth(identity)).toMatchObject({ ok: false });
    expect(
      await identity.prepareTenantResync({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("blocks an empty positive head and fails bounded resync", async () => {
    const { fixture, identity } = await openAuthority();
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: IDENTITY_REVOCATION_HEAD_SCHEMA,
        key: TENANT_A,
        value: {
          schema: IDENTITY_REVOCATION_HEAD_SCHEMA,
          tenantId: TENANT_A,
          lastSequence: 1,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
          recordVersion: 1,
        },
        expect: { kind: "absent" },
      });
    });
    expect(
      await identity.consumeRevocationEvents({ tenantId: TENANT_A }),
    ).toMatchObject({
      ok: true,
      kind: "blocked",
      reason: "event_missing",
    });
    expect(
      await identity.prepareTenantResync({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("rejects a head advanced beyond every touched record", async () => {
    const { fixture, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    const head = fixture
      .snapshot()
      .records.find(
        (record) => record.namespace === IDENTITY_REVOCATION_HEAD_SCHEMA,
      )!;
    await fixture.store.transact({ tenantId: TENANT_A }, (tx) => {
      tx.stage({
        namespace: head.namespace,
        key: head.key,
        value: {
          ...(head.value as Record<string, unknown>),
          lastSequence: 2,
          recordVersion: 2,
        } as never,
        expect: { kind: "version", version: head.version },
      });
    });
    expect(
      await identity.consumeRevocationEvents({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: true, kind: "blocked", reason: "event_missing" });
    expect(
      await identity.prepareTenantResync({ tenantId: TENANT_A }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("uses the frozen gateway cursor namespace and no identity cursor alias", async () => {
    const { fixture, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);
    const namespaces = fixture.snapshot().records.map((record) => record.namespace);
    expect(namespaces).toContain(GATEWAY_REVOCATION_CURSOR_SCHEMA);
    expect(namespaces).not.toContain("identity.revocation-cursor/v1");
  });
});
