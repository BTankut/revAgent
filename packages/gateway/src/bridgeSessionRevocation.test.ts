import { createHash } from "node:crypto";

import {
  canonicalizeJson,
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
  type GatewayMachineFingerprint,
  type IdentityPort,
} from "./authContext.js";
import type { GatewayExecutorRequest, GatewayJsonObject } from "./dispatch.js";
import {
  GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE,
  GATEWAY_RBP_SESSION_V2_NAMESPACE,
  GATEWAY_RBP_UNREGISTER_NAMESPACE,
  GatewayBridgeSessionAuthority,
  type BridgeConnectionChannel,
} from "./bridgeSession.js";
import { gatewayUuidV7 } from "./identifiers.js";
import {
  createPreProductionIdentityAuthority,
  type PreProductionDeviceRevocation,
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

function multiPreProductionFixture(
  devices: readonly {
    readonly deviceId: string;
    readonly seatId: string;
    readonly userId: string;
    readonly fingerprint: string;
  }[],
): {
  readonly identity: PreProductionIdentityAuthority;
  readonly tokens: ReadonlyMap<string, string>;
} {
  const identity = createPreProductionIdentityAuthority({
    mode: "preproduction",
    nodeEnv: "preproduction",
    tokenKey: "wp06-s2-multi-device-token-key-0123456789",
    clock: () => Date.now(),
    northIdentities: [
      {
        authorization: "Bearer wp06-s2-multi-north-token-0123456789",
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
            sessionId: "north-multi-session",
            clientType: "mcp",
            mcpSessionId: null,
            oauthClientId: "north-multi-client",
          },
          principalKey: `${TENANT_A}:${USER_A}`,
          issuedAtMs: 0,
          expiresAtMs: null,
        },
      },
    ],
  });
  const tokens = new Map<string, string>();
  for (const [index, device] of devices.entries()) {
    const issued = identity.issueEnrollmentToken({
      enrollmentId: `multi-enrollment-${String(index)}`,
      tenantId: TENANT_A,
      userId: device.userId,
      deviceId: device.deviceId,
      seatId: device.seatId,
      machineFingerprint: device.fingerprint,
      grantedSessionCapabilities: ["partial_progress"],
    });
    if (!issued.ok) throw new Error(issued.message);
    const exchanged = identity.exchangeEnrollmentToken({
      enrollmentToken: issued.value.enrollmentToken,
      machineFingerprint: device.fingerprint,
    });
    if (!exchanged.ok) throw new Error(exchanged.message);
    tokens.set(device.deviceId, exchanged.value.deviceToken);
  }
  return { identity, tokens };
}

function deviceRevocationScope(
  revocation: PreProductionDeviceRevocation,
  seatId: string,
) {
  return {
    tenantId: TENANT_A,
    kind: "device" as const,
    deviceId: revocation.deviceId,
    seatId,
    authorizationVersion: revocation.authorizationVersion,
    identityRecordVersion: revocation.identityRecordVersion,
    connectionCapabilityVersion: revocation.connectionCapabilityVersion,
    sessionCapabilityVersion: revocation.sessionCapabilityVersion,
    seatAuthorityVersion: revocation.seatAuthorityVersion,
    seatRecordVersion: revocation.seatRecordVersion,
  };
}

function reEnrollPreProductionDevice(
  identity: PreProductionIdentityAuthority,
  input: {
    readonly enrollmentId: string;
    readonly deviceId: string;
    readonly seatId: string;
    readonly userId: string;
    readonly fingerprint: GatewayMachineFingerprint;
  },
): string {
  const revoked = identity.revokeDevice(input.deviceId);
  if (!revoked.ok) throw new Error(revoked.message);
  const issued = identity.issueEnrollmentToken({
    enrollmentId: input.enrollmentId,
    tenantId: TENANT_A,
    userId: input.userId,
    deviceId: input.deviceId,
    seatId: input.seatId,
    machineFingerprint: input.fingerprint,
    grantedSessionCapabilities: ["partial_progress"],
  });
  if (!issued.ok) throw new Error(issued.message);
  const exchanged = identity.exchangeEnrollmentToken({
    enrollmentToken: issued.value.enrollmentToken,
    machineFingerprint: input.fingerprint,
  });
  if (!exchanged.ok) throw new Error(exchanged.message);
  return exchanged.value.deviceToken;
}

function cleanupPendingForDevice(value: unknown, deviceId: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "pending" &&
    "record" in value &&
    typeof value.record === "object" &&
    value.record !== null &&
    "deviceId" in value.record &&
    value.record.deviceId === deviceId
  );
}

function tombstoneCreatedForRsid(value: unknown, rsid: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "created" &&
    "tombstone" in value &&
    typeof value.tombstone === "object" &&
    value.tombstone !== null &&
    "schema" in value.tombstone &&
    value.tombstone.schema === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
    "rsid" in value.tombstone &&
    value.tombstone.rsid === rsid
  );
}

function delayFirstDeviceAuthentication(
  base: PreProductionIdentityAuthority,
): {
  readonly identity: PreProductionIdentityAuthority;
  readonly entered: Promise<void>;
  release(): void;
} {
  const entered = deferred();
  const release = deferred();
  let delay = true;
  const identity: PreProductionIdentityAuthority = {
    ...base,
    async authenticateDevice(input) {
      const result = await base.authenticateDevice(input);
      if (delay) {
        delay = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  };
  return { identity, entered: entered.promise, release: () => release.resolve() };
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

function executorRequest(
  rsid: string,
  userId = USER_A,
): GatewayExecutorRequest {
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
      principalKey: `${TENANT_A}:${userId}`,
      actor: { tenantId: TENANT_A, userId, role: "user" },
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

  it("denies delayed active authentication released after completed device revoke", async () => {
    const fixture = createRestartableTestStore();
    const preproduction = preProductionFixture();
    const delayed = delayFirstDeviceAuthentication(preproduction.identity);
    const authority = new GatewayBridgeSessionAuthority(fixture.store, delayed.identity);
    await authority.open();
    const opening = authority.openConnection({
      deviceToken: preproduction.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
      channel: channel(),
    });
    await delayed.entered;
    const revoked = preproduction.identity.revokeDevice(DEVICE_A);
    if (!revoked.ok) throw new Error(revoked.message);
    await authority.revokeIdentityAuthority(
      deviceRevocationScope(revoked.value, SEAT_A),
    );
    delayed.release();
    await expect(opening).rejects.toMatchObject({
      code: "auth",
      httpStatus: 403,
      closeCode: 4403,
    });
    expect(
      fixture.snapshot().records.some(
        (row) => row.namespace === "gateway.rbp-session/v1",
      ),
    ).toBe(false);
    await authority.close();
  });

  it("denies a delayed production auth result after durable cursor revocation", async () => {
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
    const base = productionIdentityFixture(fixture.store, [tenant]);
    const entered = deferred();
    const release = deferred();
    let delay = true;
    const identity = {
      ...base,
      async authenticateDevice(input: Parameters<IdentityPort["authenticateDevice"]>[0]) {
        const result = await base.authenticateDevice(input);
        if (delay) {
          delay = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    } as ProductionIdentityAuthority;
    const authority = new GatewayBridgeSessionAuthority(fixture.store, identity);
    await authority.open();
    const opening = authority.openConnection({
      deviceToken: TOKEN_A,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
      channel: channel(),
    });
    await entered.promise;
    tenant.revoked = true;
    tenant.generation += 1;
    tenant.cursorBlocked = true;
    await authority.synchronizeIdentityRevocations(TENANT_A);
    release.resolve();
    await expect(opening).rejects.toMatchObject({
      code: "auth",
      httpStatus: 403,
      closeCode: 4403,
    });
    await authority.close();
  });

  it("treats an exact equal-version device revoke as a zero-side-effect replay", async () => {
    const fixture = createRestartableTestStore();
    const preproduction = preProductionFixture();
    const authority = new GatewayBridgeSessionAuthority(
      fixture.store,
      preproduction.identity,
    );
    await authority.open();
    const session = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: preproduction.deviceToken,
      fingerprint: FINGERPRINT_A,
    });
    const revoked = preproduction.identity.revokeDevice(DEVICE_A);
    if (!revoked.ok) throw new Error(revoked.message);
    const scope = deviceRevocationScope(revoked.value, SEAT_A);
    await authority.revokeIdentityAuthority(scope);
    const versionAfterFirst = fixture.snapshot().nextVersion;
    const closesAfterFirst = session.channel.closes.length;
    await expect(authority.revokeIdentityAuthority(scope)).resolves.toBeUndefined();
    expect(fixture.snapshot().nextVersion).toBe(versionAfterFirst);
    expect(session.channel.closes).toHaveLength(closesAfterFirst);
    await authority.close();
  });

  it("rejects capability-version conflicts without mutating a revoked device fence", async () => {
    const fixture = createRestartableTestStore();
    const preproduction = preProductionFixture();
    const authority = new GatewayBridgeSessionAuthority(
      fixture.store,
      preproduction.identity,
    );
    await authority.open();
    const session = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: preproduction.deviceToken,
      fingerprint: FINGERPRINT_A,
    });
    const revoked = preproduction.identity.revokeDevice(DEVICE_A);
    if (!revoked.ok) throw new Error(revoked.message);
    const scope = deviceRevocationScope(revoked.value, SEAT_A);
    await authority.revokeIdentityAuthority(scope);
    const versionAfterRevoke = fixture.snapshot().nextVersion;
    const closesAfterRevoke = session.channel.closes.length;

    await expect(
      authority.revokeIdentityAuthority({
        ...scope,
        connectionCapabilityVersion: scope.connectionCapabilityVersion - 1,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, closeCode: 4403 });
    expect(fixture.snapshot().nextVersion).toBe(versionAfterRevoke);
    expect(session.channel.closes).toHaveLength(closesAfterRevoke);

    await expect(
      authority.revokeIdentityAuthority({
        ...scope,
        authorizationVersion: scope.authorizationVersion + 1,
        identityRecordVersion: scope.identityRecordVersion + 1,
        connectionCapabilityVersion: scope.connectionCapabilityVersion - 1,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, closeCode: 4403 });
    expect(fixture.snapshot().nextVersion).toBe(versionAfterRevoke);
    expect(session.channel.closes).toHaveLength(closesAfterRevoke);
    await authority.close();
  });

  it("denies delayed active authentication released after seat revoke", async () => {
    const fixture = createRestartableTestStore();
    const preproduction = preProductionFixture();
    const delayed = delayFirstDeviceAuthentication(preproduction.identity);
    const authority = new GatewayBridgeSessionAuthority(fixture.store, delayed.identity);
    await authority.open();
    const opening = authority.openConnection({
      deviceToken: preproduction.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
      channel: channel(),
    });
    await delayed.entered;
    await authority.revokeIdentityAuthority({
      tenantId: TENANT_A,
      kind: "seat",
      deviceId: DEVICE_A,
      seatId: SEAT_A,
      authorizationVersion: 2,
      identityRecordVersion: 2,
      connectionCapabilityVersion: 2,
      sessionCapabilityVersion: 2,
      seatAuthorityVersion: 2,
      seatRecordVersion: 2,
    });
    delayed.release();
    await expect(opening).rejects.toMatchObject({
      code: "auth",
      httpStatus: 403,
      closeCode: 4403,
    });
    await authority.close();
  });

  it("accepts coherent higher-version re-enrollment but still denies the delayed old auth", async () => {
    const fixture = createRestartableTestStore();
    const preproduction = preProductionFixture();
    const delayed = delayFirstDeviceAuthentication(preproduction.identity);
    const authority = new GatewayBridgeSessionAuthority(fixture.store, delayed.identity);
    await authority.open();
    const oldOpening = authority.openConnection({
      deviceToken: preproduction.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
      channel: channel(),
    });
    await delayed.entered;
    const revoked = preproduction.identity.revokeDevice(DEVICE_A);
    if (!revoked.ok) throw new Error(revoked.message);
    await authority.revokeIdentityAuthority(
      deviceRevocationScope(revoked.value, SEAT_A),
    );
    const issued = preproduction.identity.issueEnrollmentToken({
      enrollmentId: "enrollment-revocation-a-reenrolled",
      tenantId: TENANT_A,
      userId: USER_A,
      deviceId: DEVICE_A,
      seatId: SEAT_A,
      machineFingerprint: FINGERPRINT_A,
      grantedSessionCapabilities: ["partial_progress"],
    });
    if (!issued.ok) throw new Error(issued.message);
    const exchanged = preproduction.identity.exchangeEnrollmentToken({
      enrollmentToken: issued.value.enrollmentToken,
      machineFingerprint: FINGERPRINT_A,
    });
    if (!exchanged.ok) throw new Error(exchanged.message);
    const freshChannel = channel();
    const freshOpening = await authority.openConnection({
      deviceToken: exchanged.value.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
      channel: freshChannel,
    });
    expect(freshOpening.connectionId).toBeTypeOf("string");
    await authority.receive(
      freshOpening.connectionId,
      registration(FINGERPRINT_A),
    );
    const freshRegistered = registered(freshChannel);
    await expect(
      authority.revokeIdentityAuthority(
        deviceRevocationScope(revoked.value, SEAT_A),
      ),
    ).resolves.toBeUndefined();
    await expect(
      authority.revokeIdentityAuthority({
        tenantId: TENANT_A,
        kind: "device",
        deviceId: DEVICE_A,
        seatId: SEAT_A,
        authorizationVersion: 3,
        identityRecordVersion: 3,
        connectionCapabilityVersion: 3,
        sessionCapabilityVersion: 3,
      }),
    ).rejects.toMatchObject({ httpStatus: 409, closeCode: 4403 });
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === freshRegistered.payload.rsid,
      ),
    ).toBe(false);
    authority.assertConnectionOutbound(freshOpening.connectionId);
    delayed.release();
    await expect(oldOpening).rejects.toMatchObject({
      code: "auth",
      httpStatus: 403,
      closeCode: 4403,
    });
    expect(freshChannel.closes).toEqual([]);
    await authority.close();
  });

  it("keeps unrelated same-tenant device B registration valid during device A revoke", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: SEAT_A, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: SEAT_B, userId: USER_B, fingerprint: FINGERPRINT_B },
    ]);
    const tokenA = multi.tokens.get(DEVICE_A)!;
    const tokenB = multi.tokens.get(DEVICE_B)!;
    const authority = new GatewayBridgeSessionAuthority(gated.store, multi.identity);
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: tokenA,
      fingerprint: FINGERPRINT_A,
    });
    const channelB = channel();
    const openedB = await authority.openConnection({
      deviceToken: tokenB,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channelB,
    });
    const gate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "schema" in value &&
        value.schema === "gateway.rbp-session/v1" &&
        "deviceId" in value &&
        value.deviceId === DEVICE_B,
    );
    const registeringB = authority.receive(
      openedB.connectionId,
      registration(FINGERPRINT_B),
    );
    await gate.entered;
    const revokedA = multi.identity.revokeDevice(DEVICE_A);
    if (!revokedA.ok) throw new Error(revokedA.message);
    await bounded(
      authority.revokeIdentityAuthority(
        deviceRevocationScope(revokedA.value, SEAT_A),
      ),
      "device A revoke during device B register",
    );
    gate.release();
    await bounded(registeringB, "device B register completion");
    const registeredB = registered(channelB);
    expect(registeredB.payload.principal.tenant_id).toBe(TENANT_A);
    expect(channelB.closes).toEqual([]);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === registeredB.payload.rsid,
      ),
    ).toBe(false);
    expect(sessionA.channel.closes).toContainEqual({
      code: 4403,
      reason: "identity authority revoked",
    });
    await authority.close();
  });

  it("keeps unrelated device B dispatch and terminal delivery active during device A revoke", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: SEAT_A, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: SEAT_B, userId: USER_B, fingerprint: FINGERPRINT_B },
    ]);
    const authority = new GatewayBridgeSessionAuthority(gated.store, multi.identity);
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    const sessionB = await openAndRegister({
      authority,
      deviceId: DEVICE_B,
      deviceToken: multi.tokens.get(DEVICE_B)!,
      fingerprint: FINGERPRINT_B,
    });
    const request = executorRequest(sessionB.registered.payload.rsid, USER_B);
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
    const execution = authority.execute(request);
    await gate.entered;
    const revokedA = multi.identity.revokeDevice(DEVICE_A);
    if (!revokedA.ok) throw new Error(revokedA.message);
    await bounded(
      authority.revokeIdentityAuthority(
        deviceRevocationScope(revokedA.value, SEAT_A),
      ),
      "device A revoke during device B dispatch",
    );
    gate.release();
    while (!sessionB.channel.frames.some((frame) => frame.type === "invoke")) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const invoke = sessionB.channel.frames.find(
      (frame): frame is Extract<RbpEnvelope, { type: "invoke" }> =>
        frame.type === "invoke",
    )!;
    await authority.receive(
      sessionB.connectionId,
      terminalResult({
        rsid: sessionB.registered.payload.rsid,
        invocationId: request.context.invocationId,
        ack: invoke.seq,
      }),
    );
    await expect(execution).resolves.toEqual({
      state: "completed",
      result: { retained: true },
    });
    expect(sessionB.channel.closes).toEqual([]);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionB.registered.payload.rsid,
      ),
    ).toBe(false);
    expect(sessionA.channel.closes).toHaveLength(1);
    await authority.close();
  });

  it("rejects equal-version seat takeover, then admits only higher reassignment", async () => {
    const fixture = createRestartableTestStore();
    const sharedSeat = "seat-shared-revocation";
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: sharedSeat, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: sharedSeat, userId: USER_B, fingerprint: FINGERPRINT_B },
    ]);
    const authority = new GatewayBridgeSessionAuthority(fixture.store, multi.identity);
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    await expect(
      authority.openConnection({
        deviceToken: multi.tokens.get(DEVICE_B)!,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    authority.assertConnectionOutbound(sessionA.connectionId);
    expect(sessionA.channel.closes).toEqual([]);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionA.registered.payload.rsid,
      ),
    ).toBe(false);

    const revokedB = multi.identity.revokeDevice(DEVICE_B);
    if (!revokedB.ok) throw new Error(revokedB.message);
    const issuedB = multi.identity.issueEnrollmentToken({
      enrollmentId: "seat-reassignment-device-b",
      tenantId: TENANT_A,
      userId: USER_B,
      deviceId: DEVICE_B,
      seatId: sharedSeat,
      machineFingerprint: FINGERPRINT_B,
      grantedSessionCapabilities: ["partial_progress"],
    });
    if (!issuedB.ok) throw new Error(issuedB.message);
    const exchangedB = multi.identity.exchangeEnrollmentToken({
      enrollmentToken: issuedB.value.enrollmentToken,
      machineFingerprint: FINGERPRINT_B,
    });
    if (!exchangedB.ok) throw new Error(exchangedB.message);
    const channelB = channel();
    const openingB = await authority.openConnection({
      deviceToken: exchangedB.value.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channelB,
    });
    expect(sessionA.channel.closes[0]?.code).toBe(4403);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionA.registered.payload.rsid,
      ),
    ).toBe(true);
    await authority.receive(openingB.connectionId, registration(FINGERPRINT_B));
    const registeredB = registered(channelB);
    const versionBeforeStaleSeatNotification = fixture.snapshot().nextVersion;
    await expect(
      authority.revokeIdentityAuthority({
        tenantId: TENANT_A,
        kind: "seat",
        deviceId: DEVICE_A,
        seatId: sharedSeat,
        authorizationVersion: 2,
        identityRecordVersion: 2,
        connectionCapabilityVersion: 2,
        sessionCapabilityVersion: 2,
        seatAuthorityVersion: 2,
        seatRecordVersion: 2,
      }),
    ).resolves.toBeUndefined();
    expect(fixture.snapshot().nextVersion).toBe(
      versionBeforeStaleSeatNotification,
    );
    await expect(
      authority.openConnection({
        deviceToken: multi.tokens.get(DEVICE_A)!,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_A, fingerprint: FINGERPRINT_A }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    authority.assertConnectionOutbound(openingB.connectionId);
    expect(channelB.closes).toEqual([]);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === registeredB.payload.rsid,
      ),
    ).toBe(false);
    await authority.close();
  });

  it("keeps B revoked when a higher device revoke wins during A cleanup", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const sharedSeat = "seat-reassignment-revoke-race";
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: sharedSeat, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: sharedSeat, userId: USER_B, fingerprint: FINGERPRINT_B },
    ]);
    const authority = new GatewayBridgeSessionAuthority(gated.store, multi.identity);
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    const firstRevokedB = multi.identity.revokeDevice(DEVICE_B);
    if (!firstRevokedB.ok) throw new Error(firstRevokedB.message);
    const issuedB = multi.identity.issueEnrollmentToken({
      enrollmentId: "seat-reassignment-race-device-b",
      tenantId: TENANT_A,
      userId: USER_B,
      deviceId: DEVICE_B,
      seatId: sharedSeat,
      machineFingerprint: FINGERPRINT_B,
      grantedSessionCapabilities: ["partial_progress"],
    });
    if (!issuedB.ok) throw new Error(issuedB.message);
    const exchangedB = multi.identity.exchangeEnrollmentToken({
      enrollmentToken: issuedB.value.enrollmentToken,
      machineFingerprint: FINGERPRINT_B,
    });
    if (!exchangedB.ok) throw new Error(exchangedB.message);
    const cleanupGate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "pending" &&
        "record" in value &&
        typeof value.record === "object" &&
        value.record !== null &&
        "deviceId" in value.record &&
        value.record.deviceId === DEVICE_A,
    );
    const channelB = channel();
    const openingB = authority.openConnection({
      deviceToken: exchangedB.value.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channelB,
    });
    await bounded(cleanupGate.entered, "seat reassignment A cleanup start");
    const winningRevokeB = multi.identity.revokeDevice(DEVICE_B);
    if (!winningRevokeB.ok) throw new Error(winningRevokeB.message);
    const winningRevokeScope = {
      ...deviceRevocationScope(winningRevokeB.value, sharedSeat),
      connectionCapabilityVersion:
        winningRevokeB.value.connectionCapabilityVersion - 1,
      sessionCapabilityVersion:
        winningRevokeB.value.sessionCapabilityVersion - 1,
    };
    await bounded(
      authority.revokeIdentityAuthority(winningRevokeScope),
      "device B revoke during seat reassignment cleanup",
    );
    cleanupGate.release();
    await expect(
      bounded(openingB, "stale seat reassignment finalizer"),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    expect(channelB.frames).toEqual([]);
    expect(sessionA.channel.closes[0]?.code).toBe(4403);
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
          row.namespace === "gateway.rbp-session/v1" &&
          typeof row.value === "object" &&
          row.value !== null &&
          "deviceId" in row.value &&
          row.value.deviceId === DEVICE_B,
      ),
    ).toBe(false);
    const versionAfterRace = fixture.snapshot().nextVersion;
    await expect(
      authority.revokeIdentityAuthority(winningRevokeScope),
    ).resolves.toBeUndefined();
    const recoveryIssuedB = multi.identity.issueEnrollmentToken({
      enrollmentId: "seat-reassignment-race-device-b-recovery",
      tenantId: TENANT_A,
      userId: USER_B,
      deviceId: DEVICE_B,
      seatId: sharedSeat,
      machineFingerprint: FINGERPRINT_B,
      grantedSessionCapabilities: ["partial_progress"],
    });
    if (!recoveryIssuedB.ok) throw new Error(recoveryIssuedB.message);
    const recoveryExchangedB = multi.identity.exchangeEnrollmentToken({
      enrollmentToken: recoveryIssuedB.value.enrollmentToken,
      machineFingerprint: FINGERPRINT_B,
    });
    if (!recoveryExchangedB.ok) throw new Error(recoveryExchangedB.message);
    await expect(
      authority.openConnection({
        deviceToken: recoveryExchangedB.value.deviceToken,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    expect(fixture.snapshot().nextVersion).toBe(versionAfterRace);
    await authority.close();
  });

  it("quarantines a newer coherent B vector before the old finalizer can activate", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const sharedSeat = "seat-reassignment-newer-vector";
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: sharedSeat, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: sharedSeat, userId: USER_B, fingerprint: FINGERPRINT_B },
    ]);
    const authority = new GatewayBridgeSessionAuthority(gated.store, multi.identity);
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    const firstRevokedB = multi.identity.revokeDevice(DEVICE_B);
    if (!firstRevokedB.ok) throw new Error(firstRevokedB.message);
    const firstIssuedB = multi.identity.issueEnrollmentToken({
      enrollmentId: "seat-reassignment-old-vector-b",
      tenantId: TENANT_A,
      userId: USER_B,
      deviceId: DEVICE_B,
      seatId: sharedSeat,
      machineFingerprint: FINGERPRINT_B,
      grantedSessionCapabilities: ["partial_progress"],
    });
    if (!firstIssuedB.ok) throw new Error(firstIssuedB.message);
    const firstExchangedB = multi.identity.exchangeEnrollmentToken({
      enrollmentToken: firstIssuedB.value.enrollmentToken,
      machineFingerprint: FINGERPRINT_B,
    });
    if (!firstExchangedB.ok) throw new Error(firstExchangedB.message);
    const cleanupGate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "pending" &&
        "record" in value &&
        typeof value.record === "object" &&
        value.record !== null &&
        "deviceId" in value.record &&
        value.record.deviceId === DEVICE_A,
    );
    const oldChannelB = channel();
    const oldOpeningB = authority.openConnection({
      deviceToken: firstExchangedB.value.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: oldChannelB,
    });
    await bounded(cleanupGate.entered, "old-vector reassignment cleanup start");
    const secondRevokedB = multi.identity.revokeDevice(DEVICE_B);
    if (!secondRevokedB.ok) throw new Error(secondRevokedB.message);
    const newerIssuedB = multi.identity.issueEnrollmentToken({
      enrollmentId: "seat-reassignment-newer-vector-b",
      tenantId: TENANT_A,
      userId: USER_B,
      deviceId: DEVICE_B,
      seatId: sharedSeat,
      machineFingerprint: FINGERPRINT_B,
      grantedSessionCapabilities: ["partial_progress"],
    });
    if (!newerIssuedB.ok) throw new Error(newerIssuedB.message);
    const newerExchangedB = multi.identity.exchangeEnrollmentToken({
      enrollmentToken: newerIssuedB.value.enrollmentToken,
      machineFingerprint: FINGERPRINT_B,
    });
    if (!newerExchangedB.ok) throw new Error(newerExchangedB.message);
    await expect(
      bounded(
        authority.openConnection({
          deviceToken: newerExchangedB.value.deviceToken,
          binding: "wss",
          hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
          channel: channel(),
        }),
        "newer-vector reassignment attempt",
      ),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    cleanupGate.release();
    await expect(
      bounded(oldOpeningB, "old-vector stale finalizer"),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    expect(oldChannelB.frames).toEqual([]);
    expect(sessionA.channel.closes[0]?.code).toBe(4403);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionA.registered.payload.rsid,
      ),
    ).toBe(true);
    await expect(
      authority.openConnection({
        deviceToken: newerExchangedB.value.deviceToken,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === "gateway.rbp-session/v1" &&
          typeof row.value === "object" &&
          row.value !== null &&
          "deviceId" in row.value &&
          row.value.deviceId === DEVICE_B,
      ),
    ).toBe(false);
    await authority.close();
  });

  it("allows one exact cleanup retry but rejects its stale finalizer", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const sharedSeat = "seat-reassignment-replay";
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: sharedSeat, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: sharedSeat, userId: USER_B, fingerprint: FINGERPRINT_B },
    ]);
    const authority = new GatewayBridgeSessionAuthority(gated.store, multi.identity);
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    const revokedB = multi.identity.revokeDevice(DEVICE_B);
    if (!revokedB.ok) throw new Error(revokedB.message);
    const issuedB = multi.identity.issueEnrollmentToken({
      enrollmentId: "seat-reassignment-replay-device-b",
      tenantId: TENANT_A,
      userId: USER_B,
      deviceId: DEVICE_B,
      seatId: sharedSeat,
      machineFingerprint: FINGERPRINT_B,
      grantedSessionCapabilities: ["partial_progress"],
    });
    if (!issuedB.ok) throw new Error(issuedB.message);
    const exchangedB = multi.identity.exchangeEnrollmentToken({
      enrollmentToken: issuedB.value.enrollmentToken,
      machineFingerprint: FINGERPRINT_B,
    });
    if (!exchangedB.ok) throw new Error(exchangedB.message);
    const cleanupGate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "pending" &&
        "record" in value &&
        typeof value.record === "object" &&
        value.record !== null &&
        "deviceId" in value.record &&
        value.record.deviceId === DEVICE_A,
    );
    const firstChannel = channel();
    const secondChannel = channel();
    const firstOpening = authority.openConnection({
      deviceToken: exchangedB.value.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: firstChannel,
    });
    await bounded(cleanupGate.entered, "first seat reassignment cleanup start");
    const replayOpening = authority.openConnection({
      deviceToken: exchangedB.value.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: secondChannel,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    cleanupGate.release();
    const results = await bounded(
      Promise.allSettled([firstOpening, replayOpening]),
      "seat reassignment cleanup replay",
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const acceptedIndex = results.findIndex((result) => result.status === "fulfilled");
    const accepted = results[acceptedIndex];
    if (accepted?.status !== "fulfilled") {
      throw new Error("seat reassignment did not produce one accepted connection");
    }
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      status: "rejected",
      reason: { httpStatus: 403, closeCode: 4403 },
    });
    const acceptedChannel = acceptedIndex === 0 ? firstChannel : secondChannel;
    await authority.receive(
      accepted.value.connectionId,
      registration(FINGERPRINT_B),
    );
    const registeredB = registered(acceptedChannel);
    authority.assertConnectionOutbound(accepted.value.connectionId);
    expect(
      fixture.snapshot().records.filter(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionA.registered.payload.rsid,
      ),
    ).toHaveLength(1);
    const laterOpening = await authority.openConnection({
      deviceToken: exchangedB.value.deviceToken,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channel(),
    });
    authority.assertConnectionOutbound(laterOpening.connectionId);
    expect(registeredB.payload.rsid).toBeTypeOf("string");
    await authority.close();
  });

  it.each([
    { phase: "cleanup_started" as const },
    { phase: "tombstone_committed" as const },
  ])(
    "drains and cancels reassignment when close begins at $phase",
    async ({ phase }) => {
      const fixture = createRestartableTestStore();
      const gated = gatedStore(fixture);
      const sharedSeat = `seat-reassignment-close-${phase}`;
      const multi = multiPreProductionFixture([
        { deviceId: DEVICE_A, seatId: sharedSeat, userId: USER_A, fingerprint: FINGERPRINT_A },
        { deviceId: DEVICE_B, seatId: sharedSeat, userId: USER_B, fingerprint: FINGERPRINT_B },
      ]);
      const authority = new GatewayBridgeSessionAuthority(
        gated.store,
        multi.identity,
      );
      await authority.open();
      const sessionA = await openAndRegister({
        authority,
        deviceId: DEVICE_A,
        deviceToken: multi.tokens.get(DEVICE_A)!,
        fingerprint: FINGERPRINT_A,
      });
      const tokenB = reEnrollPreProductionDevice(multi.identity, {
        enrollmentId: `seat-reassignment-close-b-${phase}`,
        deviceId: DEVICE_B,
        seatId: sharedSeat,
        userId: USER_B,
        fingerprint: FINGERPRINT_B,
      });
      const cleanupGate = gated.holdAfterCommit((value) =>
        phase === "cleanup_started"
          ? cleanupPendingForDevice(value, DEVICE_A)
          : tombstoneCreatedForRsid(value, sessionA.registered.payload.rsid),
      );
      const channelB = channel();
      const openingB = authority.openConnection({
        deviceToken: tokenB,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
        channel: channelB,
      });
      await bounded(cleanupGate.entered, `close barrier ${phase}`);
      let closeSettled = false;
      const closing = authority.close();
      void closing.then(
        () => {
          closeSettled = true;
        },
        () => {
          closeSettled = true;
        },
      );
      expect(authority.lifecycle().state).toBe("closing");
      await expect(
        authority.openConnection({
          deviceToken: tokenB,
          binding: "wss",
          hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
          channel: channel(),
        }),
      ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      cleanupGate.release();
      const [openingResult, closeResult] = await bounded(
        Promise.allSettled([openingB, closing]),
        `close drain ${phase}`,
      );
      expect(openingResult).toMatchObject({
        status: "rejected",
        reason: { httpStatus: 503, closeCode: 1011 },
      });
      expect(closeResult.status).toBe("fulfilled");
      expect(authority.lifecycle().state).toBe("closed");
      expect(channelB.frames).toEqual([]);
      expect(sessionA.channel.closes).toHaveLength(1);
      expect(
        fixture.snapshot().records.filter(
          (row) =>
            row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
            row.key === sessionA.registered.payload.rsid,
        ),
      ).toHaveLength(1);
      expect(
        fixture.snapshot().records.some(
          (row) =>
            row.namespace === "gateway.rbp-session/v1" &&
            typeof row.value === "object" &&
            row.value !== null &&
            "deviceId" in row.value &&
            row.value.deviceId === DEVICE_B,
        ),
      ).toBe(false);
      await authority.open();
      await expect(
        authority.openConnection({
          deviceToken: tokenB,
          binding: "wss",
          hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
          channel: channel(),
        }),
      ).rejects.toMatchObject({ httpStatus: 403, closeCode: 4403 });
      await authority.close();
    },
  );

  it("does not apply the seat-drain deadline to an ordinary receive tail", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const preproduction = preProductionFixture();
    const authority = new GatewayBridgeSessionAuthority(
      gated.store,
      preproduction.identity,
      { seatReassignmentCloseDrainTimeoutMs: 20 },
    );
    await authority.open();
    const session = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: preproduction.deviceToken,
      fingerprint: FINGERPRINT_A,
    });
    const ordinaryGate = gated.holdAfterCommit(
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
    await bounded(ordinaryGate.entered, "ordinary receive close tail");
    let closeSettled = false;
    const closing = authority.close();
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    const stateWhileOrdinaryTailIsHeld = authority.lifecycle();
    const settledBeforeRelease = closeSettled;
    ordinaryGate.release();
    const [, closeResult] = await bounded(
      Promise.allSettled([heartbeat, closing]),
      "ordinary receive close completion",
    );
    expect(settledBeforeRelease).toBe(false);
    expect(stateWhileOrdinaryTailIsHeld).toMatchObject({
      state: "closing",
      protocolStore: "open",
      identity: "open",
    });
    expect(closeResult.status).toBe("fulfilled");
    expect(authority.lifecycle().state).toBe("closed");
  });

  it("separates a settled seat drain from an unrelated long ordinary tail", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const sharedSeat = "seat-reassignment-mixed-close";
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: sharedSeat, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: sharedSeat, userId: USER_B, fingerprint: FINGERPRINT_B },
      { deviceId: "device-mixed-tail-c", seatId: SEAT_B, userId: USER_B, fingerprint: `sha256:${"5".repeat(64)}` },
    ]);
    const fingerprintC = `sha256:${"5".repeat(64)}` as GatewayMachineFingerprint;
    const authority = new GatewayBridgeSessionAuthority(
      gated.store,
      multi.identity,
      { seatReassignmentCloseDrainTimeoutMs: 50 },
    );
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    const sessionC = await openAndRegister({
      authority,
      deviceId: "device-mixed-tail-c",
      deviceToken: multi.tokens.get("device-mixed-tail-c")!,
      fingerprint: fingerprintC,
    });
    const tokenB = reEnrollPreProductionDevice(multi.identity, {
      enrollmentId: "seat-reassignment-mixed-close-b",
      deviceId: DEVICE_B,
      seatId: sharedSeat,
      userId: USER_B,
      fingerprint: FINGERPRINT_B,
    });
    const seatGate = gated.holdAfterCommit((value) =>
      cleanupPendingForDevice(value, DEVICE_A),
    );
    const openingB = authority.openConnection({
      deviceToken: tokenB,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channel(),
    });
    void openingB.catch(() => undefined);
    await bounded(seatGate.entered, "mixed close seat drain");
    const ordinaryGate = gated.holdAfterCommit(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "schema" in value &&
        value.schema === "gateway.rbp-session/v1" &&
        "deviceId" in value &&
        value.deviceId === "device-mixed-tail-c" &&
        "lastHeartbeatAtMs" in value,
    );
    const heartbeat = authority.receive(sessionC.connectionId, {
      v: 1,
      type: "heartbeat",
      id: id(),
      ts: new Date().toISOString(),
      payload: {
        bridge_version: "wp06-s2-test",
        acks: [{ rsid: sessionC.registered.payload.rsid, seq: 0 }],
        sessions: [],
      },
    });
    await bounded(ordinaryGate.entered, "mixed close ordinary tail");
    let closeSettled = false;
    const closing = authority.close();
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    seatGate.release();
    await bounded(
      (async () => {
        while (
          !fixture.snapshot().records.some(
            (row) =>
              row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
              row.key === sessionA.registered.payload.rsid,
          )
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      })(),
      "mixed close seat drain settlement",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 90));
    const stateWhileOrdinaryTailIsHeld = authority.lifecycle();
    const settledBeforeOrdinaryRelease = closeSettled;
    ordinaryGate.release();
    const results = await bounded(
      Promise.allSettled([openingB, heartbeat, closing]),
      "mixed close ordinary completion",
    );
    expect(settledBeforeOrdinaryRelease).toBe(false);
    expect(stateWhileOrdinaryTailIsHeld).toMatchObject({
      state: "closing",
      protocolStore: "open",
      identity: "open",
    });
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { httpStatus: 503, closeCode: 1011 },
    });
    expect(results[2]?.status).toBe("fulfilled");
    expect(authority.lifecycle().state).toBe("closed");
  });

  it("admits the exact reassignment cap, shares one retry, and rejects cap plus one", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const deviceC = "device-reassignment-cap-c";
    const deviceD = "device-reassignment-cap-d";
    const userC = "user-reassignment-cap-c";
    const userD = "user-reassignment-cap-d";
    const seatOne = "seat-reassignment-cap-one";
    const seatTwo = "seat-reassignment-cap-two";
    const fingerprintC = `sha256:${"c".repeat(64)}` as GatewayMachineFingerprint;
    const fingerprintD = `sha256:${"d".repeat(64)}` as GatewayMachineFingerprint;
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: seatOne, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: seatOne, userId: USER_B, fingerprint: FINGERPRINT_B },
      { deviceId: deviceC, seatId: seatTwo, userId: userC, fingerprint: fingerprintC },
      { deviceId: deviceD, seatId: seatTwo, userId: userD, fingerprint: fingerprintD },
    ]);
    const authority = new GatewayBridgeSessionAuthority(
      gated.store,
      multi.identity,
      { maxActiveSeatReassignments: 1 },
    );
    await authority.open();
    await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    const sessionC = await openAndRegister({
      authority,
      deviceId: deviceC,
      deviceToken: multi.tokens.get(deviceC)!,
      fingerprint: fingerprintC,
    });
    const tokenB = reEnrollPreProductionDevice(multi.identity, {
      enrollmentId: "seat-reassignment-cap-b",
      deviceId: DEVICE_B,
      seatId: seatOne,
      userId: USER_B,
      fingerprint: FINGERPRINT_B,
    });
    const tokenD = reEnrollPreProductionDevice(multi.identity, {
      enrollmentId: "seat-reassignment-cap-d",
      deviceId: deviceD,
      seatId: seatTwo,
      userId: userD,
      fingerprint: fingerprintD,
    });
    const cleanupGate = gated.holdAfterCommit((value) =>
      cleanupPendingForDevice(value, DEVICE_A),
    );
    const firstOpeningB = authority.openConnection({
      deviceToken: tokenB,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channel(),
    });
    await bounded(cleanupGate.entered, "bounded reassignment cap");
    const exactReplayB = authority.openConnection({
      deviceToken: tokenB,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channel(),
    });
    await expect(
      authority.openConnection({
        deviceToken: tokenD,
        binding: "wss",
        hello: hello({ deviceId: deviceD, fingerprint: fingerprintD }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    cleanupGate.release();
    const bResults = await bounded(
      Promise.allSettled([firstOpeningB, exactReplayB]),
      "exact cap reassignment and replay",
    );
    expect(bResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(bResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    const openingD = await bounded(
      authority.openConnection({
        deviceToken: tokenD,
        binding: "wss",
        hello: hello({ deviceId: deviceD, fingerprint: fingerprintD }),
        channel: channel(),
      }),
      "released reassignment slot",
    );
    authority.assertConnectionOutbound(openingD.connectionId);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionC.registered.payload.rsid,
      ),
    ).toBe(true);
    await authority.close();
  });

  it("retains a timed-out slot until cleanup settles, then permits one bounded retry", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    const deviceC = "device-reassignment-timeout-c";
    const deviceD = "device-reassignment-timeout-d";
    const userC = "user-reassignment-timeout-c";
    const userD = "user-reassignment-timeout-d";
    const seatOne = "seat-reassignment-timeout-one";
    const seatTwo = "seat-reassignment-timeout-two";
    const fingerprintC = `sha256:${"e".repeat(64)}` as GatewayMachineFingerprint;
    const fingerprintD = `sha256:${"f".repeat(64)}` as GatewayMachineFingerprint;
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: seatOne, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: seatOne, userId: USER_B, fingerprint: FINGERPRINT_B },
      { deviceId: deviceC, seatId: seatTwo, userId: userC, fingerprint: fingerprintC },
      { deviceId: deviceD, seatId: seatTwo, userId: userD, fingerprint: fingerprintD },
    ]);
    const authority = new GatewayBridgeSessionAuthority(
      gated.store,
      multi.identity,
      {
        maxActiveSeatReassignments: 1,
        seatReassignmentTimeoutMs: 50,
      },
    );
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    await openAndRegister({
      authority,
      deviceId: deviceC,
      deviceToken: multi.tokens.get(deviceC)!,
      fingerprint: fingerprintC,
    });
    const tokenB = reEnrollPreProductionDevice(multi.identity, {
      enrollmentId: "seat-reassignment-timeout-b",
      deviceId: DEVICE_B,
      seatId: seatOne,
      userId: USER_B,
      fingerprint: FINGERPRINT_B,
    });
    const tokenD = reEnrollPreProductionDevice(multi.identity, {
      enrollmentId: "seat-reassignment-timeout-d",
      deviceId: deviceD,
      seatId: seatTwo,
      userId: userD,
      fingerprint: fingerprintD,
    });
    const cleanupGate = gated.holdAfterCommit((value) =>
      cleanupPendingForDevice(value, DEVICE_A),
    );
    const openingB = authority.openConnection({
      deviceToken: tokenB,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channel(),
    });
    await bounded(cleanupGate.entered, "timed-out reassignment cleanup");
    await expect(
      bounded(openingB, "first reassignment timeout"),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    await expect(
      authority.openConnection({
        deviceToken: tokenD,
        binding: "wss",
        hello: hello({ deviceId: deviceD, fingerprint: fingerprintD }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    await expect(
      bounded(
        authority.openConnection({
          deviceToken: tokenB,
          binding: "wss",
          hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
          channel: channel(),
        }),
        "retry while timed-out cleanup remains pending",
      ),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    await expect(
      authority.openConnection({
        deviceToken: tokenB,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === "gateway.rbp-session/v1" &&
          typeof row.value === "object" &&
          row.value !== null &&
          "deviceId" in row.value &&
          row.value.deviceId === DEVICE_B,
      ),
    ).toBe(false);
    cleanupGate.release();
    await bounded(
      (async () => {
        while (
          !fixture.snapshot().records.some(
            (row) =>
              row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
              row.key === sessionA.registered.payload.rsid,
          )
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      })(),
      "timed-out cleanup settlement",
    );
    const recoveredB = await bounded(
      authority.openConnection({
        deviceToken: tokenB,
        binding: "wss",
        hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
        channel: channel(),
      }),
      "bounded reassignment retry after cleanup settlement",
    );
    authority.assertConnectionOutbound(recoveredB.connectionId);
    await bounded(authority.close(), "timed-out reassignment drain on close");
    expect(
      fixture.snapshot().records.filter(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === sessionA.registered.payload.rsid,
      ),
    ).toHaveLength(1);
  });

  it("charges unresolved drains through the exact cap and makes close bounded-retryable", async () => {
    const fixture = createRestartableTestStore();
    const gated = gatedStore(fixture);
    let storeCloseCalls = 0;
    const store: GatewayProtocolStore = {
      ...gated.store,
      async close() {
        storeCloseCalls += 1;
        return gated.store.close();
      },
    };
    let nowMs = Date.now();
    const deviceC = "device-reassignment-drain-c";
    const deviceD = "device-reassignment-drain-d";
    const deviceE = "device-reassignment-drain-e";
    const deviceF = "device-reassignment-drain-f";
    const userC = "user-reassignment-drain-c";
    const userD = "user-reassignment-drain-d";
    const userE = "user-reassignment-drain-e";
    const userF = "user-reassignment-drain-f";
    const seatOne = "seat-reassignment-drain-one";
    const seatTwo = "seat-reassignment-drain-two";
    const seatThree = "seat-reassignment-drain-three";
    const fingerprintC = `sha256:${"1".repeat(64)}` as GatewayMachineFingerprint;
    const fingerprintD = `sha256:${"2".repeat(64)}` as GatewayMachineFingerprint;
    const fingerprintE = `sha256:${"3".repeat(64)}` as GatewayMachineFingerprint;
    const fingerprintF = `sha256:${"4".repeat(64)}` as GatewayMachineFingerprint;
    const multi = multiPreProductionFixture([
      { deviceId: DEVICE_A, seatId: seatOne, userId: USER_A, fingerprint: FINGERPRINT_A },
      { deviceId: DEVICE_B, seatId: seatOne, userId: USER_B, fingerprint: FINGERPRINT_B },
      { deviceId: deviceC, seatId: seatTwo, userId: userC, fingerprint: fingerprintC },
      { deviceId: deviceD, seatId: seatTwo, userId: userD, fingerprint: fingerprintD },
      { deviceId: deviceE, seatId: seatThree, userId: userE, fingerprint: fingerprintE },
      { deviceId: deviceF, seatId: seatThree, userId: userF, fingerprint: fingerprintF },
    ]);
    const authority = new GatewayBridgeSessionAuthority(store, multi.identity, {
      clock: () => nowMs,
      maxActiveSeatReassignments: 2,
      seatReassignmentTimeoutMs: 30,
      seatReassignmentCloseDrainTimeoutMs: 30,
    });
    await authority.open();
    const sessionA = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: multi.tokens.get(DEVICE_A)!,
      fingerprint: FINGERPRINT_A,
    });
    const sessionC = await openAndRegister({
      authority,
      deviceId: deviceC,
      deviceToken: multi.tokens.get(deviceC)!,
      fingerprint: fingerprintC,
    });
    const sessionE = await openAndRegister({
      authority,
      deviceId: deviceE,
      deviceToken: multi.tokens.get(deviceE)!,
      fingerprint: fingerprintE,
    });
    const tokenB = reEnrollPreProductionDevice(multi.identity, {
      enrollmentId: "seat-reassignment-drain-b",
      deviceId: DEVICE_B,
      seatId: seatOne,
      userId: USER_B,
      fingerprint: FINGERPRINT_B,
    });
    const tokenD = reEnrollPreProductionDevice(multi.identity, {
      enrollmentId: "seat-reassignment-drain-d",
      deviceId: deviceD,
      seatId: seatTwo,
      userId: userD,
      fingerprint: fingerprintD,
    });
    const tokenF = reEnrollPreProductionDevice(multi.identity, {
      enrollmentId: "seat-reassignment-drain-f",
      deviceId: deviceF,
      seatId: seatThree,
      userId: userF,
      fingerprint: fingerprintF,
    });

    const gateA = gated.holdAfterCommit((value) =>
      cleanupPendingForDevice(value, DEVICE_A),
    );
    const openingB = authority.openConnection({
      deviceToken: tokenB,
      binding: "wss",
      hello: hello({ deviceId: DEVICE_B, fingerprint: FINGERPRINT_B }),
      channel: channel(),
    });
    await bounded(gateA.entered, "first unresolved reassignment drain");
    await expect(openingB).rejects.toMatchObject({
      httpStatus: 503,
      closeCode: 1011,
    });

    const gateC = gated.holdAfterCommit((value) =>
      cleanupPendingForDevice(value, deviceC),
    );
    const openingD = authority.openConnection({
      deviceToken: tokenD,
      binding: "wss",
      hello: hello({ deviceId: deviceD, fingerprint: fingerprintD }),
      channel: channel(),
    });
    await bounded(gateC.entered, "second unresolved reassignment drain");
    await expect(openingD).rejects.toMatchObject({
      httpStatus: 503,
      closeCode: 1011,
    });

    nowMs += 2_000;
    const versionBeforePlusOne = fixture.snapshot().nextVersion;
    await expect(
      authority.openConnection({
        deviceToken: tokenF,
        binding: "wss",
        hello: hello({ deviceId: deviceF, fingerprint: fingerprintF }),
        channel: channel(),
      }),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(fixture.snapshot().nextVersion).toBe(versionBeforePlusOne);

    gateA.release();
    await bounded(
      (async () => {
        while (
          !fixture.snapshot().records.some(
            (row) =>
              row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
              row.key === sessionA.registered.payload.rsid,
          )
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      })(),
      "first unresolved drain settlement",
    );

    const gateE = gated.holdAfterCommit((value) =>
      cleanupPendingForDevice(value, deviceE),
    );
    const openingF = authority.openConnection({
      deviceToken: tokenF,
      binding: "wss",
      hello: hello({ deviceId: deviceF, fingerprint: fingerprintF }),
      channel: channel(),
    });
    await bounded(gateE.entered, "replacement capacity drain");
    await expect(openingF).rejects.toMatchObject({
      httpStatus: 503,
      closeCode: 1011,
    });

    await expect(
      bounded(authority.close(), "bounded reassignment close deadline"),
    ).rejects.toMatchObject({ httpStatus: 503, closeCode: 1011 });
    expect(authority.lifecycle()).toMatchObject({
      state: "failed",
      protocolStore: "open",
      identity: "open",
    });
    expect(storeCloseCalls).toBe(0);
    expect(sessionC.channel.closes).toEqual([]);
    expect(sessionE.channel.closes).toEqual([]);
    await expect(authority.open()).rejects.toMatchObject({
      httpStatus: 503,
      closeCode: 1011,
    });

    gateC.release();
    gateE.release();
    await bounded(
      (async () => {
        while (
          !fixture.snapshot().records.some(
            (row) =>
              row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
              row.key === sessionC.registered.payload.rsid,
          ) ||
          !fixture.snapshot().records.some(
            (row) =>
              row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
              row.key === sessionE.registered.payload.rsid,
          )
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      })(),
      "remaining unresolved drain settlement",
    );
    await bounded(authority.close(), "retry close after drain settlement");
    expect(authority.lifecycle()).toMatchObject({
      state: "closed",
      protocolStore: "closed",
      identity: "closed",
    });
    expect(storeCloseCalls).toBe(1);
    await authority.close();
    expect(storeCloseCalls).toBe(1);
  });

  it("keeps stale active-version sessions untombstoned and refreshes HTTP authority", async () => {
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
    const session = await openAndRegister({
      authority,
      deviceId: DEVICE_A,
      deviceToken: TOKEN_A,
      fingerprint: FINGERPRINT_A,
    });
    tenant.generation += 1;
    await authority.synchronizeIdentityRevocations(TENANT_A);
    expect(session.channel.closes).toEqual([]);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === session.registered.payload.rsid,
      ),
    ).toBe(false);
    await expect(
      authority.assertConnectionCredential(session.connectionId, TOKEN_A),
    ).resolves.toMatchObject({
      auth: { authorizationVersion: 2, identityRecordVersion: 2 },
    });
    expect(session.channel.closes).toEqual([]);
    expect(
      fixture.snapshot().records.some(
        (row) =>
          row.namespace === GATEWAY_RBP_UNREGISTER_NAMESPACE &&
          row.key === session.registered.payload.rsid,
      ),
    ).toBe(false);
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

  it("rejects stale resume after an active version change without tombstoning it", async () => {
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
    ).toBe(false);
    expect(resumedChannel.closes).toEqual([]);
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
    if (!revoked.ok) throw new Error(revoked.message);
    const revocation = authority.revokeIdentityAuthority(
      deviceRevocationScope(revoked.value, SEAT_A),
    );
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
    if (!revoked.ok) throw new Error(revoked.message);
    const revocation = authority.revokeIdentityAuthority(
      deviceRevocationScope(revoked.value, SEAT_A),
    );
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
    if (!revoked.ok) throw new Error(revoked.message);
    const revocation = authority.revokeIdentityAuthority(
      deviceRevocationScope(revoked.value, SEAT_A),
    );
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
    if (!revoked.ok) throw new Error(revoked.message);
    const revocation = authority.revokeIdentityAuthority(
      deviceRevocationScope(revoked.value, SEAT_A),
    );
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
    const snapshot = fixture.snapshot().records;
    const durable = snapshot.find(
      (row) =>
        row.namespace === GATEWAY_RBP_SESSION_V2_NAMESPACE &&
        row.key === session.registered.payload.rsid,
    );
    if (durable === undefined) {
      throw new Error("normalized terminal root is absent");
    }
    const root = durable.value as GatewayJsonObject;
    const evidenceRef = (root.childRefs as GatewayJsonObject[]).find(
      (ref) => ref.namespace === "gateway.rbp-session-evidence/v2",
    );
    const evidence = snapshot.find(
      (row) =>
        row.namespace === "gateway.rbp-session-evidence/v2" &&
        row.key === evidenceRef?.key,
    );
    const marker = snapshot.find(
      (row) =>
        row.namespace === GATEWAY_RBP_SESSION_CUTOVER_V2_NAMESPACE &&
        row.key === session.registered.payload.rsid,
    );
    if (evidenceRef === undefined || evidence === undefined || marker === undefined) {
      throw new Error("normalized terminal root, child, and marker proof is incomplete");
    }
    const evidenceValue = evidence.value as GatewayJsonObject;
    const markerValue = marker.value as GatewayJsonObject;
    const digest = (value: JsonValue): `sha256:${string}` =>
      `sha256:${createHash("sha256").update(canonicalizeJson(value)).digest("hex")}`;

    expect((root.sequence as GatewayJsonObject).pending).toBeNull();
    expect(evidenceValue.entry).toMatchObject({
      terminalTruth: {
        state: "completed",
        resultDigest: makeParamsDigest({ retained: true }),
        errorCode: null,
        payloadRetained: true,
      },
    });
    expect(root.childRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          namespace: evidence.namespace,
          key: evidence.key,
          version: evidence.version,
          digest: digest(evidence.value as unknown as JsonValue),
        }),
      ]),
    );
    expect(markerValue).toMatchObject({
      rootVersion: root.rootVersion,
      rootDigest: digest(root as JsonValue),
      childrenDigest: digest(root.childRefs as JsonValue),
    });
    await authority.close();
  });
});
