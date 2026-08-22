import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GATEWAY_REVOCATION_CURSOR_SCHEMA,
  IDENTITY_DEVICE_SCHEMA,
  IDENTITY_REVOCATION_EVENT_SCHEMA,
  IDENTITY_REVOCATION_HEAD_SCHEMA,
  IDENTITY_TENANT_SEAT_SCHEMA,
  createProductionIdentityAuthority,
  type IdentityMutationResult,
  type ProductionIdentityAuthority,
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
  overrides: Partial<ProductionIdentityStoreOptions> = {},
): ProductionIdentityAuthority {
  return createProductionIdentityAuthority({
    store,
    subscriberId: "gateway-subscriber-1",
    clock: () => NOW_MS,
    ...overrides,
  });
}

async function openAuthority(
  fixture: RestartableTestStore = createRestartableTestStore(),
): Promise<{
  readonly fixture: RestartableTestStore;
  readonly identity: ProductionIdentityAuthority;
}> {
  const identity = authority(fixture.store);
  expect(await identity.open()).toEqual({ ok: true, value: undefined });
  return { fixture, identity };
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
    readonly tenantId?: string;
    readonly deviceId?: string;
    readonly token?: string;
    readonly fingerprint?: string;
    readonly hostname?: string;
  } = {},
) {
  return identity.authenticateDevice({
    deviceToken: input.token ?? TOKEN_A,
    connectionId: "connection-1",
    tenantId: input.tenantId ?? TENANT_A,
    deviceId: input.deviceId ?? DEVICE_ID,
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

describe("production identity durable records", () => {
  it("creates versioned records, reopens after restart, and returns the full auth authority", async () => {
    const { fixture, identity } = await openAuthority();
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
    const restarted = authority(restartedStore);
    await restarted.open();
    expect(
      await exactAuth(restarted, { hostname: "renamed-workstation" }),
    ).toEqual(authenticated);
  });

  it("uses a digest-only exact credential locator and never authorizes a cross-scope guess", async () => {
    const fixture = createRestartableTestStore();
    const observed: string[] = [];
    const identity = authority(fixture.store, {
      credentialScopeResolver: {
        async resolveCredentialScope(input) {
          observed.push(input.deviceTokenDigest);
          return input.deviceTokenDigest === sha256(TOKEN_A)
            ? { tenantId: TENANT_A, deviceId: DEVICE_ID }
            : null;
        },
      },
    });
    await identity.open();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);

    const resolved = await identity.authenticateDevice({
      deviceToken: TOKEN_A,
      connectionId: "connection-resolved",
      deviceId: DEVICE_ID,
      machineFingerprint: FINGERPRINT_A,
    });
    expect(resolved).toMatchObject({ ok: true });
    expect(observed).toEqual([sha256(TOKEN_A)]);
    expect(JSON.stringify(observed)).not.toContain(TOKEN_A);
    expect(
      await identity.authenticateDevice({
        deviceToken: TOKEN_A,
        connectionId: "connection-wrong-device",
        deviceId: "device-other",
        machineFingerprint: FINGERPRINT_A,
      }),
    ).toMatchObject({ ok: false });
  });

  it("retains durable revoked status across restart", async () => {
    const { fixture, identity } = await openAuthority();
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
    expect(await exactAuth(identity)).toMatchObject({
      ok: true,
      value: { deviceStatus: "revoked", authorizationVersion: 2 },
    });

    await identity.close();
    const restarted = authority(fixture.restart());
    await restarted.open();
    expect(await exactAuth(restarted)).toMatchObject({
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
    const recoveredAuthority = authority(
      uncertainAfter(committedFixture.store, "after"),
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
    const uncertainAuthority = authority(
      uncertainAfter(uncommittedFixture.store, "before"),
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
    expect(await exactAuth(identity)).toMatchObject({
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
        tenantId: TENANT_A,
        deviceId: DEVICE_ID,
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
    const { identity } = await openAuthority();
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
    expect(await exactAuth(identity)).toMatchObject({
      ok: true,
      value: { actor: { tenantId: TENANT_A } },
    });
    expect(
      await exactAuth(identity, {
        tenantId: TENANT_B,
        token: TOKEN_B,
        fingerprint: FINGERPRINT_B,
      }),
    ).toMatchObject({
      ok: true,
      value: { actor: { tenantId: TENANT_B } },
    });
    expect(
      await exactAuth(identity, {
        tenantId: TENANT_B,
        token: TOKEN_A,
        fingerprint: FINGERPRINT_A,
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
    expect(await exactAuth(identity)).toMatchObject({
      ok: true,
      value: { deviceStatus: "revoked" },
    });
    expect(
      await exactAuth(identity, {
        tenantId: TENANT_B,
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

  it("uses the frozen gateway cursor namespace and no identity cursor alias", async () => {
    const { fixture, identity } = await openAuthority();
    committed(await identity.provisionDevice(provisionInput()));
    await consumeAll(identity);
    const namespaces = fixture.snapshot().records.map((record) => record.namespace);
    expect(namespaces).toContain(GATEWAY_REVOCATION_CURSOR_SCHEMA);
    expect(namespaces).not.toContain("identity.revocation-cursor/v1");
  });
});
