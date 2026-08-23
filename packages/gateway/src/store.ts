import {
  portNotImplemented,
  type GatewayPortAdapterKind,
  type GatewayPortResult,
} from "./gatewayPorts.js";
import type { GatewayJsonValue } from "./dispatch.js";

/**
 * The durable-state contract the Gateway is built against (GW-2).
 *
 * GW-2 freezes the *interface* only — `open`/`transact`/`close` and the
 * expectation/outcome vocabulary. It deliberately freezes no record payloads:
 * connection state, hold state machines and redelivery bookkeeping are the
 * acceptance criteria of later tasks, and a shell that pinned their shapes now
 * would force a contract amendment the first time one of them needed a field it
 * had not anticipated. Callers supply their own `T`.
 */
export const GATEWAY_STORE_CONTRACT_VERSION = "revagent.protocol-store/v1" as const;

export interface StoredRecord<T extends GatewayJsonValue = GatewayJsonValue> {
  /**
   * Free-form rather than a closed union: later work packages introduce
   * namespaces this shell cannot enumerate, and a frozen union would make each
   * one a breaking change to this file.
   */
  readonly namespace: string;
  readonly tenantId: string;
  readonly key: string;
  readonly value: T;
  readonly version: number;
  readonly updatedAtMs: number;
}

export type StoreExpectation =
  | { readonly kind: "absent" }
  | { readonly kind: "version"; readonly version: number }
  | { readonly kind: "any" };

/**
 * `durability_uncertain` is distinct from `unavailable` on purpose: a write
 * that may or may not have landed cannot be retried blindly, and collapsing it
 * into a generic failure is how duplicate side effects get created.
 */
export type StoreErrorCode =
  | "conflict"
  | "tenant_isolation_violation"
  | "durability_uncertain"
  | "invalid_record"
  | "not_implemented"
  | "unavailable";

export type StoreOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: StoreErrorCode; readonly message: string };

export interface StoreTransaction {
  read<T extends GatewayJsonValue>(
    namespace: string,
    key: string,
  ): Promise<StoredRecord<T> | null>;
  list(namespace: string): Promise<readonly StoredRecord[]>;
  /** `value: null` deletes. Staged writes apply atomically at commit. */
  stage(write: {
    readonly namespace: string;
    readonly key: string;
    readonly value: GatewayJsonValue | null;
    readonly expect: StoreExpectation;
  }): void;
}

/**
 * Adapter-owned, store-global startup fence.  It deliberately exposes only
 * bounded inventory and a serialized callback: migrations cannot substitute a
 * lazy request-path scan or assume a particular backing-store implementation.
 */
export interface GatewayStartupCoordinator {
  readonly contractVersion: "revagent.protocol-store-startup/v1";
  runExclusive<T>(
    work: () => Promise<StoreOutcome<T>>,
  ): Promise<StoreOutcome<T>>;
  listTenantIds(limit: number): Promise<StoreOutcome<readonly string[]>>;
  listKeys(
    tenantId: string,
    namespace: string,
    limit: number,
  ): Promise<StoreOutcome<readonly string[]>>;
}

export interface GatewayProtocolStore {
  readonly kind: GatewayPortAdapterKind;
  readonly contractVersion: typeof GATEWAY_STORE_CONTRACT_VERSION;
  open(): Promise<StoreOutcome<void>>;
  /**
   * `scope.tenantId` is a first-class argument rather than something the caller
   * remembers to filter by, so the in-memory fake and the future Postgres
   * adapter enforce cross-tenant isolation through the same seam.
   */
  transact<T>(
    scope: { readonly tenantId: string },
    fn: (tx: StoreTransaction) => Promise<T> | T,
  ): Promise<StoreOutcome<T>>;
  close(): Promise<StoreOutcome<void>>;
  /** Absent adapters cannot participate in startup-locked normalization. */
  readonly startupCoordinator?: GatewayStartupCoordinator;
}

export interface ObjectStorePort {
  readonly kind: GatewayPortAdapterKind;
  put(input: {
    readonly tenantId: string;
    readonly storageKey: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }): Promise<GatewayPortResult<{ readonly storageKey: string }>>;
  get(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<
    GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>
  >;
  head(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<GatewayPortResult<{ readonly byteSize: number }>>;
  delete(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<GatewayPortResult<void>>;
}

export function createUnavailableProtocolStore(): GatewayProtocolStore {
  const refusal = <T>(): StoreOutcome<T> =>
    Object.freeze({
      ok: false as const,
      code: "not_implemented" as const,
      message:
        "protocol_store port is not implemented in Phase 1: no durable store is configured",
    });
  return Object.freeze({
    kind: "unavailable" as const,
    contractVersion: GATEWAY_STORE_CONTRACT_VERSION,
    async open(): Promise<StoreOutcome<void>> {
      return refusal<void>();
    },
    async transact<T>(): Promise<StoreOutcome<T>> {
      return refusal<T>();
    },
    async close(): Promise<StoreOutcome<void>> {
      return refusal<void>();
    },
  });
}

/**
 * Phase 1 ships no byte writer anywhere.
 *
 * An implemented filesystem object store alongside stubbed guardrails would
 * mean the one component that writes attacker-influenced bytes to disk is the
 * one with no policy in front of it.
 */
export function createUnavailableObjectStore(): ObjectStorePort {
  const refuse = <T>(): GatewayPortResult<T> =>
    portNotImplemented("object_store", "no object store is configured in Phase 1");
  return Object.freeze({
    kind: "unavailable" as const,
    async put(): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
      return refuse();
    },
    async get(): Promise<
      GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>
    > {
      return refuse();
    },
    async head(): Promise<GatewayPortResult<{ readonly byteSize: number }>> {
      return refuse();
    },
    async delete(): Promise<GatewayPortResult<void>> {
      return refuse();
    },
  });
}
