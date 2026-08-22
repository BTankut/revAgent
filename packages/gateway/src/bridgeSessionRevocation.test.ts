import { createHash } from "node:crypto";

import {
  makeParamsDigest,
  type JsonValue,
  type HelloEnvelope,
  type RbpEnvelope,
  type ResultEnvelope,
  type SessionRegisteredEnvelope,
} from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type DeviceAuthContext,
  type IdentityPort,
} from "./authContext.js";
import type { GatewayExecutorRequest, GatewayJsonObject } from "./dispatch.js";
import {
  GATEWAY_RBP_UNREGISTER_NAMESPACE,
  GatewayBridgeSessionAuthority,
  type BridgeConnectionChannel,
} from "./bridgeSession.js";
import { gatewayUuidV7 } from "./identifiers.js";
import {
  createPreProductionIdentityAuthority,
  type PreProductionIdentityAuthority,
} from "./preProductionIdentity.js";
import type {
  GatewayRevocationCursorV1,
  IdentityDeviceV2,
  IdentityResyncSnapshot,
  IdentityTenantSeatV1,
  ProductionIdentityAuthority,
} from "./productionIdentityStore.js";
import type {
  GatewayProtocolStore,
  StoreOutcome,
  StoreTransaction,
} from "./store.js";
import { createRestartableTestStore } from "./testAdapters.js";

const TENANT_A = "tenant-revocation-a";
const TENANT_B = "tenant-revocation-b";
const DEVICE_A = "device-revocation-a";
const DEVICE_B = "device-revocation-b";
const SEAT_A = "seat-revocation-a";
const SEAT_B = "seat-revocation-b";
const USER_A = "user-revocation-a";
const USER_B = "user-revocation-b";
const TOKEN_A = "device-token-revocation-a-0123456789";
const TOKEN_B = "device-token-revocation-b-0123456789";
const FINGERPRINT_A = `sha256:${"a".repeat(64)}` as const;
const FINGERPRINT_B = `sha256:${"b".repeat(64)}` as const;
const AUTHORITY_DIGEST_A = `sha256:${"1".repeat(64)}` as const;
const AUTHORITY_DIGEST_B = `sha256:${"2".repeat(64)}` as const;

let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);
const ok = (): StoreOutcome<void> => ({ ok: true, value: undefined });

interface CapturingChannel extends BridgeConnectionChannel {
  readonly frames: RbpEnvelope[];
  readonly closes: { readonly code: number; readonly reason: string }[];
}

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function gatedStore(fixture: ReturnType<typeof createRestartableTestStore>): {
  readonly store: GatewayProtocolStore;
  holdAfterCommit(predicate: (value: unknown) => boolean): {
    readonly entered: Promise<void>;
    release(): void;
  };
} {
  let pending: {
    readonly predicate: (value: unknown) => boolean;
    readonly entered: Deferred;
    readonly release: Deferred;
  } | null = null;
  const store: GatewayProtocolStore = {
    ...fixture.store,
    async transact<T>(
      scope: { readonly tenantId: string },
      operation: (tx: StoreTransaction) => Promise<T> | T,
    ): Promise<StoreOutcome<T>> {
      const result = await fixture.store.transact<T>(scope, operation);
      const gate = pending;
      if (gate !== null && result.ok && gate.predicate(result.value)) {
        pending = null;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return result;
    },
  };
  return {
    store,
    holdAfterCommit(predicate) {
      if (pending !== null) throw new Error("a store gate is already armed");
      const entered = deferred();
      const release = deferred();
      pending = { predicate, entered, release };
      return {
        entered: entered.promise,
        release: () => release.resolve(),
      };
    },
  };
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded the lock-order watchdog`)),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function waitForOutboundFence(
  authority: GatewayBridgeSessionAuthority,
  connectionId: string,
): Promise<void> {
  await bounded(
    (async () => {
      while (true) {
        try {
          authority.assertConnectionOutbound(connectionId);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        } catch {
          return;
        }
      }
    })(),
    "revocation phase-one fence",
  );
}

function channel(): CapturingChannel {
  const frames: RbpEnvelope[] = [];
  const closes: { code: number; reason: string }[] = [];
  return {
    frames,
    closes,
    async send(serialized): Promise<void> {
      frames.push(JSON.parse(serialized) as RbpEnvelope);
    },
    async close(code, reason): Promise<void> {
      closes.push({ code, reason });
    },
  };
}

function hello(input: {
  readonly deviceId: string;
  readonly hostname?: string;
  readonly fingerprint?: string;
}): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: ["partial_progress"],
      bridge_version: "wp06-s2-test",
      device_id: input.deviceId,
      machine: {
        hostname: input.hostname ?? "host-a",
        os: "windows",
        ...(input.fingerprint === undefined
          ? {}
          : { fingerprint: input.fingerprint }),
      },
      addin_versions: ["wp06-s2-test"],
    },
  };
}

function registration(
  fingerprint: string,
): Extract<RbpEnvelope, { type: "session_register" }> {
  return {
    v: 1,
    type: "session_register",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      local_session_key: id(),
      user_hint: { name: "WP-06 S2" },
      machine: { hostname: "renamed-host", fingerprint },
      revit: { version: "2022", build: "fixture", pid: 42 },
      addin_version: "wp06-s2-test",
      result_contract_version: 1,
      session_capabilities: ["partial_progress"],
      bridge_version: "wp06-s2-test",
      documents: [],
      port: 48884,
    },
  };
}

function registered(channelValue: CapturingChannel): SessionRegisteredEnvelope {
  const frame = channelValue.frames.find(
    (candidate): candidate is SessionRegisteredEnvelope =>
      candidate.type === "session_registered",
  );
  if (frame === undefined) throw new Error("session_registered was not emitted");
  return frame;
}

function preProductionFixture(): {
  readonly identity: PreProductionIdentityAuthority;
  readonly deviceToken: string;
} {
  const identity = createPreProductionIdentityAuthority({
    mode: "preproduction",
    nodeEnv: "preproduction",
    tokenKey: "wp06-s2-preproduction-token-key-0123456789",
    clock: () => Date.now(),
    northIdentities: [
      {
        authorization: "Bearer wp06-s2-north-authorization-token-0123456789",
        context: {
          contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
          actor: {
            type: "user",
            tenantId: TENANT_A,
            userId: USER_A,
            role: "user",
            oidcIssuer: "https://identity.invalid",
            oidcSubject: USER_A,
          },
          session: {
            sessionId: "north-session",
            clientType: "mcp",
            mcpSessionId: null,
            oauthClientId: "north-client",
          },
          principalKey: `${TENANT_A}:${USER_A}`,
          issuedAtMs: 0,
          expiresAtMs: null,
        },
      },
    ],
  });
  const issued = identity.issueEnrollmentToken({
    enrollmentId: "enrollment-revocation-a",
    tenantId: TENANT_A,
    userId: USER_A,
    deviceId: DEVICE_A,
    seatId: SEAT_A,
    machineFingerprint: FINGERPRINT_A,
    grantedSessionCapabilities: ["partial_progress"],
  });
  if (!issued.ok) throw new Error(issued.message);
  const exchanged = identity.exchangeEnrollmentToken({
    enrollmentToken: issued.value.enrollmentToken,
    machineFingerprint: FINGERPRINT_A,
  });
  if (!exchanged.ok) throw new Error(exchanged.message);
  return { identity, deviceToken: exchanged.value.deviceToken };
}

interface MutableIdentityTenant {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly seatId: string;
  readonly deviceToken: string;
  readonly fingerprint: typeof FINGERPRINT_A | typeof FINGERPRINT_B;
  readonly digest: typeof AUTHORITY_DIGEST_A | typeof AUTHORITY_DIGEST_B;
  generation: number;
  consumeCalls: number;
  revokeOnConsumeCall?: number;
  revoked: boolean;
  cursorBlocked: boolean;
}

function tokenDigest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function productionIdentityFixture(
  store: GatewayProtocolStore,
  tenants: readonly MutableIdentityTenant[],
  lifecycleEvents: string[] = [],
): ProductionIdentityAuthority {
  let lifecycleState: "closed" | "open" = "closed";
  const tenantByToken = new Map(tenants.map((tenant) => [tenant.deviceToken, tenant]));
  const tenantById = new Map(tenants.map((tenant) => [tenant.tenantId, tenant]));
  const snapshotFor = (tenant: MutableIdentityTenant): IdentityResyncSnapshot => {
    const sequence = tenant.generation;
    const device: IdentityDeviceV2 = {
      schema: "identity.device/v2",
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      deviceId: tenant.deviceId,
      seatId: tenant.seatId,
      machineFingerprint: tenant.fingerprint,
      deviceTokenDigest: tokenDigest(tenant.deviceToken),
      status: tenant.revoked ? "revoked" : "active",
      authorizationVersion: sequence,
      connectionCapabilityVersion: 1,
      sessionCapabilityVersion: 1,
      allowedConnectionCapabilities: [],
      allowedSessionCapabilities: ["partial_progress"],
      lastAuthorityOperationId: tenant.revoked ? "revoke" : "issue",
      lastAuthorityOperationDigest: tenant.digest,
      lastAuthoritySequence: sequence,
      createdAtMs: 1,
      updatedAtMs: sequence,
      recordVersion: sequence,
    };
    const seat: IdentityTenantSeatV1 = {
      schema: "identity.tenant-seat/v1",
      tenantId: tenant.tenantId,
      seatId: tenant.seatId,
      userId: tenant.userId,
      deviceId: tenant.deviceId,
      status: tenant.revoked ? "revoked" : "active",
      seatAuthorityVersion: sequence,
      lastAuthorityOperationId: tenant.revoked ? "revoke" : "issue",
      lastAuthorityOperationDigest: tenant.digest,
      lastAuthoritySequence: sequence,
      createdAtMs: 1,
      updatedAtMs: sequence,
      recordVersion: sequence,
    };
    return {
      tenantId: tenant.tenantId,
      headSequence: sequence,
      authorityDigest: tenant.digest,
      devices: [device],
      seats: [seat],
    };
  };
  const cursorFor = (
    tenant: MutableIdentityTenant,
    status: "current" | "blocked",
  ): GatewayRevocationCursorV1 => ({
    schema: "gateway.revocation-cursor/v1",
    tenantId: tenant.tenantId,
    subscriberId: "wp06-s2-test",
    lastContiguousSequence: tenant.generation,
    lastResyncHead: tenant.generation,
    lastResyncDigest: tenant.digest,
    status,
    blockedReason: status === "blocked" ? "event_missing" : null,
    createdAtMs: 1,
    updatedAtMs: tenant.generation,
    recordVersion: tenant.generation,
  });
  const identity: IdentityPort & Record<string, unknown> = {
    kind: "oidc",
    async authenticateNorthRequest() {
      return {
        ok: false as const,
        port: "identity" as const,
        code: "unavailable" as const,
        message: "north identity is outside the test",
      };
    },
    async authenticateDevice(input) {
      const tenant = input.deviceToken === undefined
        ? undefined
        : tenantByToken.get(input.deviceToken);
      if (
        lifecycleState !== "open" ||
        tenant === undefined ||
        input.claimedDeviceId !== tenant.deviceId ||
        input.machineFingerprint !== tenant.fingerprint
      ) {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "device identity refused",
        };
      }
      const snapshot = snapshotFor(tenant);
      const device = snapshot.devices[0]!;
      const seat = snapshot.seats[0]!;
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: {
          type: "device",
          tenantId: tenant.tenantId,
          userId: tenant.userId,
          deviceId: tenant.deviceId,
          seatId: tenant.seatId,
        },
        connectionId: input.connectionId,
        deviceStatus: tenant.revoked ? "revoked" : "active",
        machineFingerprint: tenant.fingerprint,
        authorizationVersion: device.authorizationVersion,
        identityRecordVersion: device.recordVersion,
        connectionCapabilityVersion: device.connectionCapabilityVersion,
        sessionCapabilityVersion: device.sessionCapabilityVersion,
        seatAuthorityVersion: seat.seatAuthorityVersion,
        seatRecordVersion: seat.recordVersion,
        grantedConnectionCapabilities: [],
        grantedSessionCapabilities: ["partial_progress"],
        deviceTokenDigest: device.deviceTokenDigest,
      };
      return { ok: true as const, value: context };
    },
    async open() {
      lifecycleEvents.push("identity.open");
      lifecycleState = "open";
      return ok();
    },
    async close() {
      lifecycleEvents.push("identity.close");
      lifecycleState = "closed";
      return ok();
    },
    lifecycle() {
      return {
        state: lifecycleState,
        resources: {
          tenantStore: lifecycleState,
          credentialLocator: lifecycleState,
          northIdentity: lifecycleState,
        },
      };
    },
    managedResources() {
      return {
        tenantStore: { ownership: "external", managed: false },
        credentialLocator: { managed: true },
        northIdentity: { managed: true },
      };
    },
    usesStore(candidate: GatewayProtocolStore) {
      return candidate === store;
    },
    async consumeRevocationEvents(input: { readonly tenantId: string }) {
      const tenant = tenantById.get(input.tenantId)!;
      tenant.consumeCalls += 1;
      if (tenant.revokeOnConsumeCall === tenant.consumeCalls) {
        tenant.revoked = true;
        tenant.cursorBlocked = true;
        tenant.generation += 1;
      }
      const snapshot = snapshotFor(tenant);
      if (tenant.cursorBlocked) {
        return {
          ok: true as const,
          kind: "blocked" as const,
          headSequence: snapshot.headSequence,
          reason: "event_missing" as const,
          events: [] as const,
          cursor: cursorFor(tenant, "blocked"),
        };
      }
      return {
        ok: true as const,
        kind: "current" as const,
        headSequence: snapshot.headSequence,
        complete: true,
        events: [] as const,
        cursor: cursorFor(tenant, "current"),
      };
    },
    async prepareTenantResync(input: { readonly tenantId: string }) {
      return { ok: true as const, snapshot: snapshotFor(tenantById.get(input.tenantId)!) };
    },
    async commitTenantResync(input: { readonly tenantId: string }) {
      const tenant = tenantById.get(input.tenantId)!;
      tenant.cursorBlocked = false;
      const snapshot = snapshotFor(tenant);
      return {
        ok: true as const,
        kind: "committed" as const,
        snapshot,
        cursor: cursorFor(tenant, "current"),
      };
    },
    async provisionDevice() {
      return { ok: false as const, kind: "invalid_input" as const };
    },
    async revokeDevice() {
      return { ok: false as const, kind: "invalid_input" as const };
    },
    async revokeSeat() {
      return { ok: false as const, kind: "invalid_input" as const };
    },
  };
  return identity as unknown as ProductionIdentityAuthority;
}

async function openAndRegister(input: {
  readonly authority: GatewayBridgeSessionAuthority;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly fingerprint: string;
}): Promise<{
  readonly connectionId: string;
  readonly channel: CapturingChannel;
  readonly registered: SessionRegisteredEnvelope;
}> {
  const openedChannel = channel();
  const opened = await input.authority.openConnection({
    deviceToken: input.deviceToken,
    binding: "wss",
    hello: hello({
      deviceId: input.deviceId,
      fingerprint: input.fingerprint,
    }),
    channel: openedChannel,
  });
  await input.authority.receive(
    opened.connectionId,
    registration(input.fingerprint),
  );
  return {
    connectionId: opened.connectionId,
    channel: openedChannel,
    registered: registered(openedChannel),
  };
}

function executorRequest(rsid: string): GatewayExecutorRequest {
  const args: GatewayJsonObject = { probe: "wp06-terminal" };
  const invocationId = id();
  return {
    toolName: "core.get_status",
    toolVersion: "1.0.0",
    executorMethod: "get_revit_mcp_status",
    policyClass: "auto",
    mutationScopePolicy: "none",
    args,
    context: {
      invocationId,
      idempotencyKey: `${rsid}/${invocationId}`,
      principalKey: `${TENANT_A}:${USER_A}`,
      actor: { tenantId: TENANT_A, userId: USER_A, role: "user" },
      gatewaySessionId: "gateway-wp06",
      oauthClientId: "oauth-wp06",
      mcpSessionId: "mcp-wp06",
      rsid,
      toolName: "core.get_status",
      toolVersion: "1.0.0",
      policyClass: "auto",
      policyDecision: "auto",
      confirmationId: null,
      originatingPreviewInvocationId: null,
      mutationScopePolicy: "none",
      mutating: false,
      executor: "bridge",
      documentIdentity: { kind: "live", session_document_id: "document-wp06" },
      paramsDigest: makeParamsDigest(args as unknown as JsonValue),
      mutationScope: null,
      startedAtMs: Date.now(),
    },
  };
}

function terminalResult(input: {
  readonly rsid: string;
  readonly invocationId: string;
  readonly ack: number;
}): ResultEnvelope {
  const result = { retained: true };
  return {
    v: 1,
    type: "result",
    id: id(),
    rsid: input.rsid,
    seq: 1,
    ack: input.ack,
    ts: new Date().toISOString(),
    payload: {
      kind: "invocation",
      invocation_id: input.invocationId,
      status: "completed",
      result,
      result_digest: makeParamsDigest(result),
      metrics: {
        execute_ms: 1,
        request_bytes: 1,
        response_bytes: 1,
        framing: "length-prefixed",
      },
    },
  };
}

describe("WP-06 Gateway identity composition and active revocation", () => {
  it("fails closed before store open for an incomplete OIDC authority", async () => {
    const fixture = createRestartableTestStore();
    let storeOpenCalls = 0;
    const store: GatewayProtocolStore = {
      ...fixture.store,
      async open() {
        storeOpenCalls += 1;
        return fixture.store.open();
      },
    };
    const incomplete: IdentityPort = {
      kind: "oidc",
      async authenticateNorthRequest() {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "incomplete OIDC authority",
        };
      },
      async authenticateDevice() {
        return {
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "incomplete OIDC authority",
        };
      },
    };
    const authority = new GatewayBridgeSessionAuthority(store, incomplete);
    await expect(authority.open()).rejects.toMatchObject({
      code: "unavailable",
      httpStatus: 503,
      closeCode: 1011,
    });
    expect(storeOpenCalls).toBe(0);
    expect(authority.lifecycle().state).toBe("closed");
  });

  it("opens a shared external store once and closes identity before the store", async () => {
    const fixture = createRestartableTestStore();
    const lifecycleEvents: string[] = [];
    const store: GatewayProtocolStore = {
      ...fixture.store,
      async open() {
        lifecycleEvents.push("store.open");
        return fixture.store.open();
      },
      async close() {
        lifecycleEvents.push("store.close");
        return fixture.store.close();
      },
    };
    const tenant: MutableIdentityTenant = {
      tenantId: TENANT_A,
      userId: USER_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
      digest: AUTHORITY_DIGEST_A,
      generation: 1,
      consumeCalls: 0,
      revoked: false,
      cursorBlocked: false,
    };
    const authority = new GatewayBridgeSessionAuthority(
      store,
      productionIdentityFixture(store, [tenant], lifecycleEvents),
    );

    await expect(
      authority.openConnection({
        deviceToken: TOKEN_A,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ code: "unavailable", httpStatus: 503 });
    expect(lifecycleEvents).toEqual([]);
    await Promise.all([authority.open(), authority.open()]);
    expect(lifecycleEvents).toEqual(["store.open", "identity.open"]);
    expect(authority.lifecycle()).toMatchObject({
      state: "open",
      protocolStoreManagedBy: "bridge",
    });
    await authority.close();
    expect(lifecycleEvents).toEqual([
      "store.open",
      "identity.open",
      "identity.close",
      "store.close",
    ]);
  });

  it("rolls opening back in reverse order and retries an unknown close before store close", async () => {
    const fixture = createRestartableTestStore();
    const lifecycleEvents: string[] = [];
    const store: GatewayProtocolStore = {
      ...fixture.store,
      async open() {
        lifecycleEvents.push("store.open");
        return fixture.store.open();
      },
      async close() {
        lifecycleEvents.push("store.close");
        return fixture.store.close();
      },
    };
    const tenant: MutableIdentityTenant = {
      tenantId: TENANT_A,
      userId: USER_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
      digest: AUTHORITY_DIGEST_A,
      generation: 1,
      consumeCalls: 0,
      revoked: false,
      cursorBlocked: false,
    };
    const base = productionIdentityFixture(store, [tenant], lifecycleEvents);
    let closeAttempts = 0;
    const unknownThenClosed = {
      ...base,
      async close(): Promise<StoreOutcome<void>> {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          lifecycleEvents.push("identity.close.unknown");
          return { ok: false, code: "unavailable", message: "unknown close" };
        }
        return base.close();
      },
    } as ProductionIdentityAuthority;
    const authority = new GatewayBridgeSessionAuthority(store, unknownThenClosed);
    await authority.open();
    await expect(authority.close()).rejects.toMatchObject({ code: "unavailable" });
    expect(lifecycleEvents).not.toContain("store.close");
    expect(authority.lifecycle().state).toBe("failed");
    await authority.close();
    expect(lifecycleEvents.slice(-2)).toEqual(["identity.close", "store.close"]);

    const rollbackEvents: string[] = [];
    const rollbackFixture = createRestartableTestStore();
    const rollbackStore: GatewayProtocolStore = {
      ...rollbackFixture.store,
      async open() {
        rollbackEvents.push("store.open");
        return rollbackFixture.store.open();
      },
      async close() {
        rollbackEvents.push("store.close");
        return rollbackFixture.store.close();
      },
    };
    const rollbackBase = productionIdentityFixture(
      rollbackStore,
      [{ ...tenant, consumeCalls: 0 }],
      rollbackEvents,
    );
    const openingFailure = {
      ...rollbackBase,
      async open(): Promise<StoreOutcome<void>> {
        rollbackEvents.push("identity.open.failed");
        return { ok: false, code: "unavailable", message: "open failed" };
      },
    } as ProductionIdentityAuthority;
    const rollbackAuthority = new GatewayBridgeSessionAuthority(
      rollbackStore,
      openingFailure,
    );
    await expect(rollbackAuthority.open()).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(rollbackEvents).toEqual([
      "store.open",
      "identity.open.failed",
      "identity.close",
      "store.close",
    ]);
    expect(rollbackAuthority.lifecycle().state).toBe("closed");
  });

  it("rejects copied-token claim drift, accepts the same claim after hostname change, and makes no anti-cloning claim", async () => {
    const fixture = createRestartableTestStore();
    const preproduction = preProductionFixture();
    const authenticationInputs: Parameters<IdentityPort["authenticateDevice"]>[0][] = [];
    const capturedIdentity: PreProductionIdentityAuthority = {
      ...preproduction.identity,
      async authenticateDevice(input) {
        authenticationInputs.push(input);
        return preproduction.identity.authenticateDevice(input);
      },
    };
    const authority = new GatewayBridgeSessionAuthority(
      fixture.store,
      capturedIdentity,
    );
    await authority.open();

    await expect(
      authority.openConnection({
        deviceToken: preproduction.deviceToken,
        binding: "wss",
        hello: hello({
          deviceId: DEVICE_A,
          hostname: "host-b",
          fingerprint: FINGERPRINT_B,
        }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ code: "auth", httpStatus: 403, closeCode: 4403 });

    const openedChannel = channel();
    const opened = await authority.openConnection({
      deviceToken: preproduction.deviceToken,
      binding: "wss",
      hello: hello({
        deviceId: DEVICE_A,
        hostname: "renamed-host",
        fingerprint: FINGERPRINT_A,
      }),
      channel: openedChannel,
    });
    expect(authenticationInputs.at(-1)).toEqual(
      expect.objectContaining({
        claimedDeviceId: DEVICE_A,
        machineFingerprint: FINGERPRINT_A,
        machineHostname: "renamed-host",
      }),
    );
    await expect(
      authority.receive(opened.connectionId, registration(FINGERPRINT_B)),
    ).rejects.toMatchObject({ code: "auth", httpStatus: 403, closeCode: 4403 });
    await expect(
      authority.receive(opened.connectionId, registration(FINGERPRINT_A)),
    ).resolves.toBeUndefined();
    expect(registered(openedChannel).payload.principal.tenant_id).toBe(TENANT_A);
    await authority.close();
  });

  it("resyncs a blocked cursor, durably revokes before 4403, and isolates another tenant", async () => {
    const fixture = createRestartableTestStore();
    const tenantA: MutableIdentityTenant = {
      tenantId: TENANT_A,
      userId: USER_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
      digest: AUTHORITY_DIGEST_A,
      generation: 1,
      consumeCalls: 0,
      revoked: false,
      cursorBlocked: false,
    };
    const tenantB: MutableIdentityTenant = {
      tenantId: TENANT_B,
      userId: USER_B,
      deviceId: DEVICE_B,
      seatId: SEAT_B,
      deviceToken: TOKEN_B,
      fingerprint: FINGERPRINT_B,
      digest: AUTHORITY_DIGEST_B,
      generation: 1,
      consumeCalls: 0,
      revoked: false,
      cursorBlocked: false,
    };
    const identity = productionIdentityFixture(fixture.store, [tenantA, tenantB]);
    const authority = new GatewayBridgeSessionAuthority(fixture.store, identity);
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
    });
    const sessionA2 = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
    });
    const sessionB = await openAndRegister({
      authority,
      deviceId: DEVICE_B,
      deviceToken: TOKEN_B,
      fingerprint: FINGERPRINT_B,
    });

    tenantA.revoked = true;
    tenantA.generation += 1;
    tenantA.cursorBlocked = true;
    await authority.synchronizeIdentityRevocations(TENANT_A);

    expect(sessionA.channel.closes).toContainEqual({
      code: 4403,
      reason: "identity authority revoked",
    });
    expect(sessionA2.channel.closes).toContainEqual({
      code: 4403,
      reason: "identity authority revoked",
    });
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionA.registered.payload.rsid,
      ),
    ).toBe(true);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionA2.registered.payload.rsid,
      ),
    ).toBe(true);
    await expect(
      authority.assertConnectionCredential(sessionA.connectionId, TOKEN_A),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    await expect(
      authority.assertConnectionCredential(sessionB.connectionId, TOKEN_B),
    ).resolves.toMatchObject({ auth: { actor: { tenantId: TENANT_B } } });
    expect(sessionB.channel.closes).toEqual([]);
    await authority.close();

    const restartedStore = fixture.restart();
    const restarted = new GatewayBridgeSessionAuthority(
      restartedStore,
      productionIdentityFixture(restartedStore, [tenantA, tenantB]),
    );
    await restarted.open();
    await expect(
      restarted.openConnection({
        deviceToken: TOKEN_A,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ code: "auth", httpStatus: 403, closeCode: 4403 });
    await restarted.close();
  });

  it("rejects resume after an active authority-version change", async () => {
    const fixture = createRestartableTestStore();
    const tenant: MutableIdentityTenant = {
      tenantId: TENANT_A,
      userId: USER_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
      digest: AUTHORITY_DIGEST_A,
      generation: 1,
      consumeCalls: 0,
      revoked: false,
      cursorBlocked: false,
    };
    const identity = productionIdentityFixture(fixture.store, [tenant]);
    const authority = new GatewayBridgeSessionAuthority(fixture.store, identity);
    await authority.open();
    const original = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
    });
    await authority.detach(original.connectionId);
    tenant.generation += 1;
    const resumedChannel = channel();
    const replacement = await authority.openConnection({
      deviceToken: TOKEN_A,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
      channel: resumedChannel,
    });
    await expect(
      authority.receive(replacement.connectionId, {
        v: 1,
        type: "session_resume",
        id: id(),
        ts: new Date().toISOString(),
        payload: {
          rsid: original.registered.payload.rsid,
          resume_token: original.registered.payload.resume_token,
          last_rx_seq: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "auth", httpStatus: 403, closeCode: 4403 });
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === original.registered.payload.rsid,
      ),
    ).toBe(true);
    await authority.close();
  });

  it("fences a register that commits across the revocation scan without lock inversion", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const preproduction = preProductionFixture();
    const authority = new GatewayBridgeSessionAuthority(
      gated.store,
      preproduction.identity,
    );
    await authority.open();
    const openedChannel = channel();
    const opened = await authority.openConnection({
      deviceToken: preproduction.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
      channel: openedChannel,
    });
    const gate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "schema" in value &&
        value.schema === "gateway.rbp-session/v1" &&
        "sessionVersion" in value &&
        value.sessionVersion === 1,
    );
    const registering = authority.receive(
      opened.connectionId,
      registration(FINGERPRINT_A),
    );
    await gate.entered;
    const revoked = preproduction.identity.revokeDevice(DEVICE_A);
    expect(revoked.ok).toBe(true);
    const revocation = authority.revokeIdentityAuthority({
      tenantId: TENANT_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
    });
    await waitForOutboundFence(authority, opened.connectionId);
    gate.release();
    const [registerResult, revokeResult] = await bounded(
      Promise.allSettled([registering, revocation]),
      "register versus revoke",
    );
    expect(registerResult.status).toBe("rejected");
    expect(revokeResult.status).toBe("fulfilled");
    expect(
      openedChannel.frames.some((frame) => frame.type === "session_registered"),
    ).toBe(false);
    expect(
      fixture.snapshot().records.some(
        (row) => row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE,
      ),
    ).toBe(true);
    await authority.close();
  });

  it("fences resume_ack when device and seat revocation wins its committed reservation", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const preproduction = preProductionFixture();
    const authority = new GatewayBridgeSessionAuthority(
      gated.store,
      preproduction.identity,
    );
    await authority.open();
    const original = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: preproduction.deviceToken,
      fingerprint: FINGERPRINT_A,
    });
    await authority.detach(original.connectionId);
    const replacementChannel = channel();
    const replacement = await authority.openConnection({
      deviceToken: preproduction.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
      channel: replacementChannel,
    });
    const gate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "lease" in value &&
        typeof value.lease === "object" &&
        value.lease !== null &&
        "operation" in value.lease &&
        value.lease.operation === "resume_ack",
    );
    const resuming = authority.receive(replacement.connectionId, {
      v: 1,
      type: "session_resume",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        rsid: original.registered.payload.rsid,
        resume_token: original.registered.payload.resume_token,
        last_rx_seq: 0,
      },
    });
    await gate.entered;
    const revoked = preproduction.identity.revokeDevice(DEVICE_A);
    expect(revoked.ok).toBe(true);
    const revocation = authority.revokeIdentityAuthority({
      tenantId: TENANT_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
    });
    await waitForOutboundFence(authority, replacement.connectionId);
    gate.release();
    const [resumeResult, revokeResult] = await bounded(
      Promise.allSettled([resuming, revocation]),
      "resume versus revoke",
    );
    expect(resumeResult.status).toBe("rejected");
    expect(revokeResult.status).toBe("fulfilled");
    expect(
      replacementChannel.frames.some((frame) => frame.type === "resume_ack"),
    ).toBe(false);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === original.registered.payload.rsid,
      ),
    ).toBe(true);
    await authority.close();
  });

  it("fences a dispatch reservation before transport send and completes without deadlock", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const preproduction = preProductionFixture();
    const authority = new GatewayBridgeSessionAuthority(
      gated.store,
      preproduction.identity,
    );
    await authority.open();
    const session = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: preproduction.deviceToken,
      fingerprint: FINGERPRINT_A,
    });
    const gate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "lease" in value &&
        typeof value.lease === "object" &&
        value.lease !== null &&
        "operation" in value.lease &&
        value.lease.operation === "dispatch",
    );
    const execution = authority.execute(
      executorRequest(session.registered.payload.rsid),
    );
    await gate.entered;
    const revoked = preproduction.identity.revokeDevice(DEVICE_A);
    expect(revoked.ok).toBe(true);
    const revocation = authority.revokeIdentityAuthority({
      tenantId: TENANT_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
    });
    await waitForOutboundFence(authority, session.connectionId);
    gate.release();
    const [executionResult, revokeResult] = await bounded(
      Promise.all([execution, revocation]),
      "dispatch versus revoke",
    );
    expect(executionResult).toMatchObject({
      state: "failed",
      error: { code: "executor_unavailable" },
    });
    expect(revokeResult).toBeUndefined();
    expect(session.channel.frames.some((frame) => frame.type === "invoke")).toBe(false);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === session.registered.payload.rsid,
      ),
    ).toBe(true);
    await authority.close();
  });

  it("suppresses heartbeat_ack when the authority epoch changes after its durable update", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const preproduction = preProductionFixture();
    const authority = new GatewayBridgeSessionAuthority(
      gated.store,
      preproduction.identity,
    );
    await authority.open();
    const session = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: preproduction.deviceToken,
      fingerprint: FINGERPRINT_A,
    });
    const heartbeatAcksBefore = session.channel.frames.filter(
      (frame) => frame.type === "heartbeat_ack",
    ).length;
    const gate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "schema" in value &&
        value.schema === "gateway.rbp-session/v1" &&
        "lastHeartbeatAtMs" in value,
    );
    const heartbeat = authority.receive(session.connectionId, {
      v: 1,
      type: "heartbeat",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        bridge_version: "wp06-s2-test",
        acks: [{ rsid: session.registered.payload.rsid, seq: 0 }],
        sessions: [],
      },
    });
    await gate.entered;
    const revoked = preproduction.identity.revokeDevice(DEVICE_A);
    expect(revoked.ok).toBe(true);
    const revocation = authority.revokeIdentityAuthority({
      tenantId: TENANT_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
    });
    await waitForOutboundFence(authority, session.connectionId);
    gate.release();
    const [heartbeatResult, revokeResult] = await bounded(
      Promise.allSettled([heartbeat, revocation]),
      "heartbeat versus revoke",
    );
    expect(heartbeatResult.status).toBe("rejected");
    expect(revokeResult.status).toBe("fulfilled");
    expect(
      session.channel.frames.filter((frame) => frame.type === "heartbeat_ack"),
    ).toHaveLength(heartbeatAcksBefore);
    await authority.close();
  });

  it("retains terminal truth but suppresses delivery when revocation wins the post-terminal check", async () => {
    const fixture = createRestartableTestStore();
    const terminalCommitted = deferred();
    const releaseTerminalReadback = deferred();
    let holdTerminalReadback = false;
    const store: GatewayProtocolStore = {
      ...fixture.store,
      async transact<T>(
        scope: { readonly tenantId: string },
        operation: (tx: StoreTransaction) => Promise<T> | T,
      ): Promise<StoreOutcome<T>> {
        const result = await fixture.store.transact<T>(scope, operation);
        if (
          holdTerminalReadback &&
          result.ok &&
          typeof result.value === "object" &&
          result.value !== null &&
          "evidence" in result.value &&
          Array.isArray(result.value.evidence) &&
          result.value.evidence.some(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              "terminalTruth" in entry &&
              entry.terminalTruth !== null,
          )
        ) {
          holdTerminalReadback = false;
          terminalCommitted.resolve();
          await releaseTerminalReadback.promise;
        }
        return result;
      },
    };
    const tenant: MutableIdentityTenant = {
      tenantId: TENANT_A,
      userId: USER_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
      digest: AUTHORITY_DIGEST_A,
      generation: 1,
      consumeCalls: 0,
      revoked: false,
      cursorBlocked: false,
    };
    const identity = productionIdentityFixture(store, [tenant]);
    const authority = new GatewayBridgeSessionAuthority(store, identity);
    await authority.open();
    const session = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
    });
    const request = executorRequest(session.registered.payload.rsid);
    const execution = authority.execute(request);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const invoke = session.channel.frames.find(
      (frame): frame is Extract<RbpEnvelope, { type: "invoke" }> =>
        frame.type === "invoke",
    );
    if (invoke === undefined) throw new Error("invoke was not emitted");
    holdTerminalReadback = true;
    const terminalReceive = authority.receive(
      session.connectionId,
      terminalResult({
        rsid: session.registered.payload.rsid,
        invocationId: request.context.invocationId,
        ack: invoke.seq,
      }),
    );
    await terminalCommitted.promise;
    tenant.revoked = true;
    tenant.generation += 1;
    tenant.cursorBlocked = true;
    const revocation = authority.synchronizeIdentityRevocations(TENANT_A);
    while (true) {
      try {
        authority.assertConnectionOutbound(session.connectionId);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } catch {
        break;
      }
    }
    releaseTerminalReadback.resolve();
    await terminalReceive;
    await revocation;
    await expect(execution).resolves.toMatchObject({
      state: "failed",
      error: { code: "executor_unavailable" },
    });
    const durable = fixture.snapshot().records.find(
      (row) =>
        row.namespace === "gateway.rbp-session/v1" &&
        row.key === session.registered.payload.rsid,
    )?.value as GatewayJsonObject;
    expect(durable.pending).toBeNull();
    expect(durable.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          terminalTruth: {
            state: "completed",
            resultDigest: makeParamsDigest({ retained: true }),
            errorCode: null,
            payloadRetained: true,
          },
        }),
      ]),
    );
    await authority.close();
  });
});
