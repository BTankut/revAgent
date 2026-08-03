import type {
  AuthContext,
  DeviceAuthContext,
  EntitlementPort,
  GatewayModuleName,
  IdentityPort,
} from "./authContext.js";
import { GATEWAY_AUTH_CONTRACT_VERSION } from "./authContext.js";
import type { GatewayEventEnvelope, GatewayEventSink, GatewayEventType } from "./events.js";
import { REVAGENT_EVENT_SCHEMA } from "./events.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import type {
  GatewayProtocolStore,
  StoreExpectation,
  StoreOutcome,
  StoreTransaction,
  StoredRecord,
} from "./store.js";
import { GATEWAY_STORE_CONTRACT_VERSION } from "./store.js";
import type { GatewayJsonObject, GatewayJsonValue } from "./dispatch.js";

/**
 * Deterministic fixture adapters (GW-2).
 *
 * These exist so later work packages can write tests with stable identities,
 * stable event ordering and a store that survives a simulated restart, without
 * anything real behind them.
 *
 * This module is **never re-exported from `index.ts`**. That is deliberate and
 * is half of the guarantee that a fake never reaches production: the other half
 * is the server refusing to start when an injected port reports a fixture kind
 * while `NODE_ENV` is `production`. A convention alone would not survive a
 * hurried import.
 */

export interface FakeIdentityTable {
  readonly northTokens: Readonly<Record<string, AuthContext>>;
  readonly deviceTokens: Readonly<Record<string, DeviceAuthContext>>;
}

function user(
  userId: string,
  role: AuthContext["actor"]["role"],
  sessionId: string,
): AuthContext {
  return Object.freeze({
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: Object.freeze({
      type: "user" as const,
      tenantId: "tenant-fixture-1",
      userId,
      role,
      oidcIssuer: "https://issuer.invalid/fixture",
      oidcSubject: `sub-${userId}`,
    }),
    session: Object.freeze({
      sessionId,
      clientType: "mcp" as const,
      mcpSessionId: `mcp-${sessionId}`,
      oauthClientId: "client-fixture",
    }),
    principalKey: `tenant-fixture-1:${userId}`,
    issuedAtMs: 0,
    expiresAtMs: null,
  });
}

function device(
  deviceId: string,
  status: DeviceAuthContext["deviceStatus"],
): DeviceAuthContext {
  return Object.freeze({
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: Object.freeze({
      type: "device" as const,
      tenantId: "tenant-fixture-1",
      userId: "user-fixture-1",
      deviceId,
      seatId: `seat-${deviceId}`,
    }),
    connectionId: `conn-${deviceId}`,
    deviceStatus: status,
    grantedSessionCapabilities: Object.freeze([]),
    deviceTokenDigest: `sha256:${"0".repeat(64)}` as const,
  });
}

/**
 * One tenant, two roles, and three device states.
 *
 * The revoked and seat-denied devices are here so later negative tests have
 * deterministic material rather than each inventing its own denial fixture and
 * drifting apart.
 */
export const FAKE_IDENTITY_TABLE_V1: FakeIdentityTable = Object.freeze({
  northTokens: Object.freeze({
    "Bearer fixture-user": user("user-fixture-1", "user", "session-fixture-1"),
    "Bearer fixture-admin": user(
      "user-fixture-2",
      "tenant_admin",
      "session-fixture-2",
    ),
  }),
  deviceTokens: Object.freeze({
    "device-fixture-active": device("device-fixture-active", "active"),
    "device-fixture-revoked": device("device-fixture-revoked", "revoked"),
    "device-fixture-seat-denied": device("device-fixture-seat-denied", "seat_denied"),
  }),
});

export function createFakeIdentityPort(
  table: FakeIdentityTable = FAKE_IDENTITY_TABLE_V1,
): IdentityPort {
  const port: IdentityPort = {
    kind: "fake" as const,
    async authenticateNorthRequest(input): Promise<GatewayPortResult<AuthContext>> {
      const found =
        input.authorization === undefined
          ? undefined
          : table.northTokens[input.authorization];
      if (found === undefined) {
        return Object.freeze({
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "fixture identity table has no entry for this authorization",
        });
      }
      return Object.freeze({ ok: true as const, value: found });
    },
    async authenticateDevice(input): Promise<GatewayPortResult<DeviceAuthContext>> {
      const found =
        input.deviceToken === undefined ? undefined : table.deviceTokens[input.deviceToken];
      if (found === undefined) {
        return Object.freeze({
          ok: false as const,
          port: "identity" as const,
          code: "unavailable" as const,
          message: "fixture identity table has no entry for this device token",
        });
      }
      return Object.freeze({ ok: true as const, value: found });
    },
  };
  return Object.freeze(port);
}

export function createFakeEntitlementPort(
  grants: {
    readonly modules?: readonly GatewayModuleName[];
    readonly tools?: readonly string[];
  } = {},
): EntitlementPort {
  const modules = new Set<string>(grants.modules ?? ["core"]);
  const tools = grants.tools === undefined ? null : new Set(grants.tools);
  const port: EntitlementPort = {
    kind: "fake" as const,
    async checkModuleEntitlement(input): Promise<GatewayPortResult<boolean>> {
      return Object.freeze({ ok: true as const, value: modules.has(input.moduleName) });
    },
    async checkToolEntitlement(input): Promise<GatewayPortResult<boolean>> {
      return Object.freeze({
        ok: true as const,
        value: tools === null ? true : tools.has(input.toolName),
      });
    },
  };
  return Object.freeze(port);
}

export interface CapturingEventSink extends GatewayEventSink {
  captured(): readonly GatewayEventEnvelope[];
  clear(): void;
}

export function createCapturingEventSink(): CapturingEventSink {
  const buffer: GatewayEventEnvelope[] = [];
  const ok = (): GatewayPortResult<void> =>
    Object.freeze({ ok: true as const, value: undefined });
  return {
    kind: "capture" as const,
    async emit(event): Promise<GatewayPortResult<void>> {
      buffer.push(event);
      return ok();
    },
    async emitBatch(events): Promise<GatewayPortResult<void>> {
      buffer.push(...events);
      return ok();
    },
    async flush(): Promise<GatewayPortResult<void>> {
      return ok();
    },
    captured(): readonly GatewayEventEnvelope[] {
      return [...buffer];
    },
    clear(): void {
      buffer.length = 0;
    },
  };
}

/**
 * Builds envelopes with an injected clock and id source.
 *
 * `seq` and both timestamps come from the caller so a test asserting ordering
 * is deterministic rather than dependent on how fast the machine ran.
 */
export function createEventEnvelopeFactory(options: {
  readonly source: GatewayEventEnvelope["source"];
  readonly clock: () => number;
  readonly newEventId: () => string;
  readonly tenantId: string;
}): (input: {
  readonly eventType: GatewayEventType;
  readonly actor: GatewayEventEnvelope["actor"];
  readonly payload: GatewayJsonObject;
  readonly sessionId?: string;
  readonly turnId?: string;
}) => GatewayEventEnvelope {
  let seq = 0;
  return (input) => {
    seq += 1;
    const at = new Date(options.clock()).toISOString();
    return Object.freeze({
      schema: REVAGENT_EVENT_SCHEMA,
      event_id: options.newEventId(),
      event_type: input.eventType,
      occurred_at: at,
      recorded_at: at,
      tenant_id: options.tenantId,
      source: options.source,
      actor: input.actor,
      ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
      ...(input.turnId === undefined ? {} : { turn_id: input.turnId }),
      seq,
      payload: input.payload,
    });
  };
}

export interface GatewayProtocolStoreSnapshot {
  readonly records: readonly StoredRecord[];
  readonly nextVersion: number;
}

export interface RestartableTestStore {
  readonly store: GatewayProtocolStore;
  snapshot(): GatewayProtocolStoreSnapshot;
  /**
   * Returns a fresh store over the same committed state.
   *
   * "Restartable" has to mean that only committed writes survive: durable
   * recovery work later depends on being able to prove that an uncommitted
   * transaction leaves nothing behind, and a fake that kept staged writes would
   * make that test pass for the wrong reason.
   */
  restart(): GatewayProtocolStore;
}

interface MemoryState {
  records: Map<string, StoredRecord>;
  nextVersion: number;
  open: boolean;
}

function recordKey(namespace: string, tenantId: string, key: string): string {
  return `${tenantId} ${namespace} ${key}`;
}

function buildMemoryStore(state: MemoryState): GatewayProtocolStore {
  return {
    kind: "memory" as const,
    contractVersion: GATEWAY_STORE_CONTRACT_VERSION,
    async open(): Promise<StoreOutcome<void>> {
      state.open = true;
      return Object.freeze({ ok: true as const, value: undefined });
    },
    async transact<T>(
      scope: { readonly tenantId: string },
      fn: (tx: StoreTransaction) => Promise<T> | T,
    ): Promise<StoreOutcome<T>> {
      if (!state.open) {
        return Object.freeze({
          ok: false as const,
          code: "unavailable" as const,
          message: "store is not open",
        });
      }
      const staged: {
        namespace: string;
        key: string;
        value: GatewayJsonValue | null;
        expect: StoreExpectation;
      }[] = [];
      const tx: StoreTransaction = {
        async read<T2 extends GatewayJsonValue>(
          namespace: string,
          key: string,
        ): Promise<StoredRecord<T2> | null> {
          const found = state.records.get(recordKey(namespace, scope.tenantId, key));
          return (found as StoredRecord<T2> | undefined) ?? null;
        },
        async list(namespace: string): Promise<readonly StoredRecord[]> {
          return [...state.records.values()].filter(
            (r) => r.namespace === namespace && r.tenantId === scope.tenantId,
          );
        },
        stage(write): void {
          staged.push({ ...write });
        },
      };

      let value: T;
      try {
        value = await fn(tx);
      } catch (error) {
        // Staged writes are discarded: a failed transaction must leave nothing.
        return Object.freeze({
          ok: false as const,
          code: "invalid_record" as const,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      for (const write of staged) {
        const composite = recordKey(write.namespace, scope.tenantId, write.key);
        const existing = state.records.get(composite);
        if (write.expect.kind === "absent" && existing !== undefined) {
          return Object.freeze({
            ok: false as const,
            code: "conflict" as const,
            message: `${write.namespace}/${write.key} already exists`,
          });
        }
        if (
          write.expect.kind === "version" &&
          existing?.version !== write.expect.version
        ) {
          return Object.freeze({
            ok: false as const,
            code: "conflict" as const,
            message: `${write.namespace}/${write.key} is not at the expected version`,
          });
        }
      }

      for (const write of staged) {
        const composite = recordKey(write.namespace, scope.tenantId, write.key);
        if (write.value === null) {
          state.records.delete(composite);
          continue;
        }
        state.nextVersion += 1;
        state.records.set(
          composite,
          Object.freeze({
            namespace: write.namespace,
            tenantId: scope.tenantId,
            key: write.key,
            value: write.value,
            version: state.nextVersion,
            updatedAtMs: 0,
          }),
        );
      }
      return Object.freeze({ ok: true as const, value });
    },
    async close(): Promise<StoreOutcome<void>> {
      state.open = false;
      return Object.freeze({ ok: true as const, value: undefined });
    },
  };
}

export function createRestartableTestStore(): RestartableTestStore {
  const state: MemoryState = { records: new Map(), nextVersion: 0, open: false };
  return {
    store: buildMemoryStore(state),
    snapshot(): GatewayProtocolStoreSnapshot {
      return Object.freeze({
        records: [...state.records.values()],
        nextVersion: state.nextVersion,
      });
    },
    restart(): GatewayProtocolStore {
      state.open = false;
      return buildMemoryStore(state);
    },
  };
}
