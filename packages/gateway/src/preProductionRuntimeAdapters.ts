import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
  type EntitlementPort,
  type GatewayModuleName,
} from "./authContext.js";
import type { GatewayJsonValue } from "./dispatch.js";
import {
  REVAGENT_EVENT_SCHEMA,
  type GatewayEventEnvelope,
  type GatewayEventSink,
} from "./events.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import {
  GATEWAY_STORE_CONTRACT_VERSION,
  type GatewayProtocolStore,
  type GatewayStartupCoordinator,
  type StoreErrorCode,
  type StoreExpectation,
  type StoreOutcome,
  type StoreTransaction,
  type StoredRecord,
} from "./store.js";

export const PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS = Object.freeze({
  maxIdentifierBytes: 512,
  maxRecords: 1_024,
  maxRecordValueBytes: 2 * 1024 * 1024,
  maxTotalRecordValueBytes: 64 * 1024 * 1024,
  maxTransactionWrites: 128,
  maxConcurrentTransactions: 32,
  maxEvents: 2_048,
  maxEventBytes: 256 * 1024,
  maxTotalEventBytes: 16 * 1024 * 1024,
} as const);

const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const STORE_UNAVAILABLE_MESSAGE =
  "pre-production protocol store is unavailable";
const STORE_INVALID_MESSAGE =
  "pre-production protocol store rejected an invalid transaction";
const STORE_CONFLICT_MESSAGE =
  "pre-production protocol store transaction conflicted";
const STORE_TENANT_MESSAGE =
  "pre-production protocol store rejected the tenant scope";
const EVENT_REFUSAL_MESSAGE =
  "pre-production event sink rejected the event batch";
const ENTITLEMENT_REFUSAL_MESSAGE =
  "pre-production entitlement request was rejected";
const MODULE_NAMES = Object.freeze([
  "core",
  "mech",
  "arch",
  "struct",
  "elec",
] as const);
const ROLES = Object.freeze(["user", "tenant_admin", "vendor_admin"] as const);
const CLIENT_TYPES = Object.freeze(["web", "mcp", "bridge"] as const);

export interface PreProductionProtocolStoreOptions {
  readonly clock?: () => number;
  readonly maxIdentifierBytes?: number;
  readonly maxRecords?: number;
  readonly maxRecordValueBytes?: number;
  readonly maxTotalRecordValueBytes?: number;
  readonly maxTransactionWrites?: number;
  readonly maxConcurrentTransactions?: number;
}

export interface PreProductionEventSinkOptions {
  readonly maxEvents?: number;
  readonly maxEventBytes?: number;
  readonly maxTotalEventBytes?: number;
}

export interface PreProductionEntitlementOptions {
  readonly allowedToolNames?: readonly string[];
  readonly allowedModules?: readonly GatewayModuleName[];
}

export interface PreProductionEventSink extends GatewayEventSink {
  readonly kind: "preproduction";
  /** A detached process-lifetime audit snapshot for bounded evidence/tests. */
  snapshot(): readonly GatewayEventEnvelope[];
}

export interface PreProductionEntitlementPort extends EntitlementPort {
  readonly kind: "preproduction";
}

export interface PreProductionRuntimeAdapters {
  readonly protocolStore: GatewayProtocolStore & {
    readonly kind: "preproduction";
  };
  readonly events: PreProductionEventSink;
  readonly entitlement: PreProductionEntitlementPort;
}

interface InternalStoredRecord {
  readonly namespace: string;
  readonly tenantId: string;
  readonly key: string;
  readonly serializedValue: string;
  readonly valueBytes: number;
  readonly version: number;
  readonly updatedAtMs: number;
}

interface StagedWrite {
  readonly namespace: string;
  readonly key: string;
  readonly serializedValue: string | null;
  readonly valueBytes: number;
  readonly expect: StoreExpectation;
}

interface JsonSnapshot<T> {
  readonly value: T;
  readonly serialized: string;
  readonly bytes: number;
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function boundedIdentifier(value: string, maxBytes: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function isJsonValue(
  value: unknown,
  seen: Set<object>,
  state: { nodes: number },
  depth = 0,
): boolean {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, seen, state, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value).every((item) =>
      isJsonValue(item, seen, state, depth + 1),
    );
  } finally {
    seen.delete(value);
  }
}

function jsonSnapshot<T>(value: T, maxBytes: number): JsonSnapshot<T> | null {
  if (!isJsonValue(value, new Set(), { nodes: 0 })) return null;
  try {
    const serialized = JSON.stringify(value);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, "utf8") > maxBytes
    ) {
      return null;
    }
    return {
      value: JSON.parse(serialized) as T,
      serialized,
      bytes: Buffer.byteLength(serialized, "utf8"),
    };
  } catch {
    return null;
  }
}

function storeFailure<T>(
  code: StoreErrorCode,
  message: string,
): StoreOutcome<T> {
  return Object.freeze({ ok: false as const, code, message });
}

function storeSuccess<T>(value: T): StoreOutcome<T> {
  return Object.freeze({ ok: true as const, value });
}

function eventSuccess(): GatewayPortResult<void> {
  return Object.freeze({ ok: true as const, value: undefined });
}

function eventFailure(): GatewayPortResult<void> {
  return Object.freeze({
    ok: false as const,
    port: "event_sink" as const,
    code: "unavailable" as const,
    message: EVENT_REFUSAL_MESSAGE,
  });
}

function entitlementSuccess(value: boolean): GatewayPortResult<boolean> {
  return Object.freeze({ ok: true as const, value });
}

function entitlementFailure(): GatewayPortResult<boolean> {
  return Object.freeze({
    ok: false as const,
    port: "entitlement" as const,
    code: "unavailable" as const,
    message: ENTITLEMENT_REFUSAL_MESSAGE,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maxBytes = 512): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function optionalBoundedString(value: unknown): boolean {
  return value === null || boundedString(value);
}

function validAuthContext(value: unknown): value is AuthContext {
  if (!isRecord(value) || !isRecord(value.actor) || !isRecord(value.session)) {
    return false;
  }
  const actor = value.actor;
  const session = value.session;
  return (
    value.contractVersion === GATEWAY_AUTH_CONTRACT_VERSION &&
    actor.type === "user" &&
    boundedString(actor.tenantId) &&
    boundedString(actor.userId) &&
    ROLES.includes(actor.role as (typeof ROLES)[number]) &&
    boundedString(actor.oidcIssuer, 2_048) &&
    boundedString(actor.oidcSubject) &&
    boundedString(session.sessionId) &&
    CLIENT_TYPES.includes(
      session.clientType as (typeof CLIENT_TYPES)[number],
    ) &&
    optionalBoundedString(session.mcpSessionId) &&
    optionalBoundedString(session.oauthClientId) &&
    boundedString(value.principalKey, 1_024) &&
    Number.isSafeInteger(value.issuedAtMs) &&
    (value.issuedAtMs as number) >= 0 &&
    (value.expiresAtMs === null ||
      (Number.isSafeInteger(value.expiresAtMs) &&
        (value.expiresAtMs as number) >= (value.issuedAtMs as number)))
  );
}

function validToolToken(value: unknown, maxBytes = 256): value is string {
  return (
    boundedString(value, maxBytes) &&
    /^[a-z0-9_.:-]+$/u.test(value)
  );
}

function createPreProductionEntitlementPort(
  options: PreProductionEntitlementOptions = {},
): PreProductionEntitlementPort {
  const modules = options.allowedModules ?? [];
  const tools = options.allowedToolNames ?? [];
  if (
    new Set(modules).size !== modules.length ||
    modules.some(
      (moduleName) =>
        !MODULE_NAMES.includes(moduleName as (typeof MODULE_NAMES)[number]),
    ) ||
    new Set(tools).size !== tools.length ||
    tools.some((toolName) => !validToolToken(toolName))
  ) {
    throw new RangeError(
      "pre-production entitlement grants must be unique exact identifiers",
    );
  }
  const allowedModules = new Set<GatewayModuleName>(modules);
  const allowedToolNames = new Set(tools);
  const port: PreProductionEntitlementPort = {
    kind: "preproduction" as const,
    async checkModuleEntitlement(input): Promise<GatewayPortResult<boolean>> {
      if (
        !validAuthContext(input?.auth) ||
        !MODULE_NAMES.includes(
          input?.moduleName as (typeof MODULE_NAMES)[number],
        )
      ) {
        return entitlementFailure();
      }
      return entitlementSuccess(allowedModules.has(input.moduleName));
    },
    async checkToolEntitlement(input): Promise<GatewayPortResult<boolean>> {
      if (
        !validAuthContext(input?.auth) ||
        !validToolToken(input?.toolName) ||
        !validToolToken(input?.toolVersion, 128)
      ) {
        return entitlementFailure();
      }
      return entitlementSuccess(allowedToolNames.has(input.toolName));
    },
  };
  return Object.freeze(port);
}

function publicRecord<T extends GatewayJsonValue>(
  record: InternalStoredRecord,
): StoredRecord<T> {
  return Object.freeze({
    namespace: record.namespace,
    tenantId: record.tenantId,
    key: record.key,
    value: JSON.parse(record.serializedValue) as T,
    version: record.version,
    updatedAtMs: record.updatedAtMs,
  });
}

function createPreProductionProtocolStore(
  options: PreProductionProtocolStoreOptions = {},
): GatewayProtocolStore & { readonly kind: "preproduction" } {
  const clock = options.clock ?? Date.now;
  const maxIdentifierBytes = positiveSafeInteger(
    "maxIdentifierBytes",
    options.maxIdentifierBytes ??
      PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxIdentifierBytes,
  );
  const maxRecords = positiveSafeInteger(
    "maxRecords",
    options.maxRecords ?? PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxRecords,
  );
  const maxRecordValueBytes = positiveSafeInteger(
    "maxRecordValueBytes",
    options.maxRecordValueBytes ??
      PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxRecordValueBytes,
  );
  const maxTotalRecordValueBytes = positiveSafeInteger(
    "maxTotalRecordValueBytes",
    options.maxTotalRecordValueBytes ??
      PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxTotalRecordValueBytes,
  );
  const maxTransactionWrites = positiveSafeInteger(
    "maxTransactionWrites",
    options.maxTransactionWrites ??
      PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxTransactionWrites,
  );
  const maxConcurrentTransactions = positiveSafeInteger(
    "maxConcurrentTransactions",
    options.maxConcurrentTransactions ??
      PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxConcurrentTransactions,
  );
  if (maxRecordValueBytes > maxTotalRecordValueBytes) {
    throw new RangeError(
      "maxRecordValueBytes must not exceed maxTotalRecordValueBytes",
    );
  }

  const tenants = new Map<
    string,
    Map<string, Map<string, InternalStoredRecord>>
  >();
  let opened = false;
  let activeTransactions = 0;
  let nextVersion = 0;
  let recordCount = 0;
  let totalValueBytes = 0;
  let startupTail = Promise.resolve();

  function recordFor(
    tenantId: string,
    namespace: string,
    key: string,
  ): InternalStoredRecord | undefined {
    return tenants.get(tenantId)?.get(namespace)?.get(key);
  }

  function listFor(
    tenantId: string,
    namespace: string,
  ): readonly InternalStoredRecord[] {
    return [...(tenants.get(tenantId)?.get(namespace)?.values() ?? [])].sort(
      (left, right) => left.key.localeCompare(right.key),
    );
  }

  function put(record: InternalStoredRecord): void {
    let namespaces = tenants.get(record.tenantId);
    if (namespaces === undefined) {
      namespaces = new Map();
      tenants.set(record.tenantId, namespaces);
    }
    let records = namespaces.get(record.namespace);
    if (records === undefined) {
      records = new Map();
      namespaces.set(record.namespace, records);
    }
    records.set(record.key, record);
  }

  function remove(tenantId: string, namespace: string, key: string): void {
    const namespaces = tenants.get(tenantId);
    const records = namespaces?.get(namespace);
    records?.delete(key);
    if (records?.size === 0) namespaces?.delete(namespace);
    if (namespaces?.size === 0) tenants.delete(tenantId);
  }

  const store: GatewayProtocolStore & { readonly kind: "preproduction" } = {
    kind: "preproduction" as const,
    contractVersion: GATEWAY_STORE_CONTRACT_VERSION,
    startupCoordinator: Object.freeze({
      contractVersion: "revagent.protocol-store-startup/v1" as const,
      async runExclusive<T>(work: () => Promise<StoreOutcome<T>>): Promise<StoreOutcome<T>> {
        const prior = startupTail;
        let release!: () => void;
        startupTail = new Promise<void>((resolve) => { release = resolve; });
        await prior;
        try { return await work(); } finally { release(); }
      },
      async listTenantIds(limit: number): Promise<StoreOutcome<readonly string[]>> {
        if (!opened || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
          return storeFailure("unavailable", STORE_UNAVAILABLE_MESSAGE);
        }
        const ids = [...tenants.keys()].sort();
        return ids.length > limit
          ? storeFailure("invalid_record", STORE_INVALID_MESSAGE)
          : storeSuccess(Object.freeze(ids));
      },
      async listKeys(tenantId: string, namespace: string, limit: number): Promise<StoreOutcome<readonly string[]>> {
        if (!opened || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000 || !boundedIdentifier(tenantId, maxIdentifierBytes) || !boundedIdentifier(namespace, maxIdentifierBytes)) {
          return storeFailure("unavailable", STORE_UNAVAILABLE_MESSAGE);
        }
        const keys = listFor(tenantId, namespace).map((record) => record.key);
        return keys.length > limit
          ? storeFailure("invalid_record", STORE_INVALID_MESSAGE)
          : storeSuccess(Object.freeze(keys));
      },
    } satisfies GatewayStartupCoordinator),
    async open(): Promise<StoreOutcome<void>> {
      opened = true;
      return storeSuccess(undefined);
    },
    async transact<T>(
      scope: { readonly tenantId: string },
      fn: (tx: StoreTransaction) => Promise<T> | T,
    ): Promise<StoreOutcome<T>> {
      if (!opened || activeTransactions >= maxConcurrentTransactions) {
        return storeFailure("unavailable", STORE_UNAVAILABLE_MESSAGE);
      }
      if (!boundedIdentifier(scope.tenantId, maxIdentifierBytes)) {
        return storeFailure(
          "tenant_isolation_violation",
          STORE_TENANT_MESSAGE,
        );
      }

      activeTransactions += 1;
      try {
        const staged: StagedWrite[] = [];
        const stagedTargets = new Set<string>();
        let invalid = false;
        const tx: StoreTransaction = {
          async read<TValue extends GatewayJsonValue>(
            namespace: string,
            key: string,
          ): Promise<StoredRecord<TValue> | null> {
            if (
              !boundedIdentifier(namespace, maxIdentifierBytes) ||
              !boundedIdentifier(key, maxIdentifierBytes)
            ) {
              invalid = true;
              return null;
            }
            const found = recordFor(scope.tenantId, namespace, key);
            return found === undefined ? null : publicRecord<TValue>(found);
          },
          async list(namespace: string): Promise<readonly StoredRecord[]> {
            if (!boundedIdentifier(namespace, maxIdentifierBytes)) {
              invalid = true;
              return [];
            }
            return listFor(scope.tenantId, namespace).map((record) =>
              publicRecord(record),
            );
          },
          stage(write): void {
            if (staged.length >= maxTransactionWrites) {
              invalid = true;
              return;
            }
            if (
              !boundedIdentifier(write.namespace, maxIdentifierBytes) ||
              !boundedIdentifier(write.key, maxIdentifierBytes) ||
              (write.expect.kind === "version" &&
                (!Number.isSafeInteger(write.expect.version) ||
                  write.expect.version < 1))
            ) {
              invalid = true;
              return;
            }
            const target = `${write.namespace.length}:${write.namespace}${write.key}`;
            if (stagedTargets.has(target)) {
              invalid = true;
              return;
            }
            const snapshot =
              write.value === null
                ? null
                : jsonSnapshot(write.value, maxRecordValueBytes);
            if (write.value !== null && snapshot === null) {
              invalid = true;
              return;
            }
            stagedTargets.add(target);
            staged.push({
              namespace: write.namespace,
              key: write.key,
              serializedValue: snapshot?.serialized ?? null,
              valueBytes: snapshot?.bytes ?? 0,
              expect: write.expect,
            });
          },
        };

        let value: T;
        try {
          value = await fn(tx);
        } catch {
          return storeFailure("invalid_record", STORE_INVALID_MESSAGE);
        }
        if (!opened) {
          return storeFailure("unavailable", STORE_UNAVAILABLE_MESSAGE);
        }
        if (invalid) {
          return storeFailure("invalid_record", STORE_INVALID_MESSAGE);
        }

        for (const write of staged) {
          const existing = recordFor(
            scope.tenantId,
            write.namespace,
            write.key,
          );
          if (
            (write.expect.kind === "absent" && existing !== undefined) ||
            (write.expect.kind === "version" &&
              existing?.version !== write.expect.version)
          ) {
            return storeFailure("conflict", STORE_CONFLICT_MESSAGE);
          }
        }

        let projectedRecordCount = recordCount;
        let projectedTotalValueBytes = totalValueBytes;
        let versionedWrites = 0;
        for (const write of staged) {
          const existing = recordFor(
            scope.tenantId,
            write.namespace,
            write.key,
          );
          if (write.serializedValue === null) {
            if (existing !== undefined) {
              projectedRecordCount -= 1;
              projectedTotalValueBytes -= existing.valueBytes;
            }
            continue;
          }
          versionedWrites += 1;
          if (existing === undefined) projectedRecordCount += 1;
          else projectedTotalValueBytes -= existing.valueBytes;
          projectedTotalValueBytes += write.valueBytes;
        }
        if (
          projectedRecordCount > maxRecords ||
          projectedTotalValueBytes > maxTotalRecordValueBytes ||
          nextVersion + versionedWrites > Number.MAX_SAFE_INTEGER
        ) {
          return storeFailure("invalid_record", STORE_INVALID_MESSAGE);
        }

        const updatedAtMs = clock();
        if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
          return storeFailure("invalid_record", STORE_INVALID_MESSAGE);
        }
        for (const write of staged) {
          if (write.serializedValue === null) {
            remove(scope.tenantId, write.namespace, write.key);
            continue;
          }
          nextVersion += 1;
          put({
            namespace: write.namespace,
            tenantId: scope.tenantId,
            key: write.key,
            serializedValue: write.serializedValue,
            valueBytes: write.valueBytes,
            version: nextVersion,
            updatedAtMs,
          });
        }
        recordCount = projectedRecordCount;
        totalValueBytes = projectedTotalValueBytes;
        return storeSuccess(value);
      } finally {
        activeTransactions -= 1;
      }
    },
    async close(): Promise<StoreOutcome<void>> {
      opened = false;
      return storeSuccess(undefined);
    },
  };
  return Object.freeze(store);
}

function createPreProductionEventSink(
  options: PreProductionEventSinkOptions = {},
): PreProductionEventSink {
  const maxEvents = positiveSafeInteger(
    "maxEvents",
    options.maxEvents ?? PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxEvents,
  );
  const maxEventBytes = positiveSafeInteger(
    "maxEventBytes",
    options.maxEventBytes ?? PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxEventBytes,
  );
  const maxTotalEventBytes = positiveSafeInteger(
    "maxTotalEventBytes",
    options.maxTotalEventBytes ??
      PRE_PRODUCTION_RUNTIME_DEFAULT_LIMITS.maxTotalEventBytes,
  );
  if (maxEventBytes > maxTotalEventBytes) {
    throw new RangeError("maxEventBytes must not exceed maxTotalEventBytes");
  }

  const serializedEvents: string[] = [];
  let totalEventBytes = 0;

  function append(events: readonly GatewayEventEnvelope[]): GatewayPortResult<void> {
    const snapshots: JsonSnapshot<GatewayEventEnvelope>[] = [];
    for (const event of events) {
      const snapshot = jsonSnapshot(event, maxEventBytes);
      if (snapshot === null || snapshot.value.schema !== REVAGENT_EVENT_SCHEMA) {
        return eventFailure();
      }
      snapshots.push(snapshot);
    }
    const batchBytes = snapshots.reduce((total, event) => total + event.bytes, 0);
    if (
      serializedEvents.length + snapshots.length > maxEvents ||
      totalEventBytes + batchBytes > maxTotalEventBytes
    ) {
      return eventFailure();
    }
    serializedEvents.push(...snapshots.map((event) => event.serialized));
    totalEventBytes += batchBytes;
    return eventSuccess();
  }

  const sink: PreProductionEventSink = {
    kind: "preproduction" as const,
    async emit(event): Promise<GatewayPortResult<void>> {
      return append([event]);
    },
    async emitBatch(events): Promise<GatewayPortResult<void>> {
      return append(events);
    },
    async flush(): Promise<GatewayPortResult<void>> {
      return eventSuccess();
    },
    snapshot(): readonly GatewayEventEnvelope[] {
      return Object.freeze(
        serializedEvents.map(
          (serialized) => JSON.parse(serialized) as GatewayEventEnvelope,
        ),
      );
    },
  };
  return Object.freeze(sink);
}

export function createPreProductionRuntimeAdapters(options: {
  /** Convenience alias for the protocol-store clock used by serving composition. */
  readonly clock?: () => number;
  readonly protocolStore?: PreProductionProtocolStoreOptions;
  readonly events?: PreProductionEventSinkOptions;
  readonly entitlement?: PreProductionEntitlementOptions;
} = {}): PreProductionRuntimeAdapters {
  if (
    options.clock !== undefined &&
    options.protocolStore?.clock !== undefined &&
    options.clock !== options.protocolStore.clock
  ) {
    throw new RangeError("pre-production runtime clock must be unambiguous");
  }
  const protocolStoreOptions: PreProductionProtocolStoreOptions = {
    ...options.protocolStore,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  return Object.freeze({
    protocolStore: createPreProductionProtocolStore(protocolStoreOptions),
    events: createPreProductionEventSink(options.events),
    entitlement: createPreProductionEntitlementPort(options.entitlement),
  });
}
