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
  /** No default: every adapter declares whether startup migration is possible. */
  readonly startupCoordinator: GatewayStartupCoordinator;
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
  /**
   * Optional explicit absence probe.  `null` means the backing store has
   * positively established not-found; a refusal remains unavailable/unknown.
   * It is only consumed by C39's authenticated deletion retry path.
   */
  getOptional?(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>>;
  head(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<GatewayPortResult<{ readonly byteSize: number }>>;
  delete(input: {
    readonly tenantId: string;
    readonly storageKey: string;
  }): Promise<GatewayPortResult<void>>;
}

/**
 * C39's protected result-object seam is intentionally separate from the
 * ordinary object port.  It cannot accidentally be selected by a legacy
 * caller which only knows `ObjectStorePort`: every read and write has to
 * present the complete authority-bound context used as AES-GCM AAD.
 */
export interface ProtectedObjectBinding {
  readonly tenantId: string;
  readonly userId: string;
  readonly principalKey: string;
  readonly effectiveMcpSessionId: string;
  readonly sessionBindingId: string;
  readonly sessionBindingVersion: number;
  readonly rsid: string;
  readonly recoveryInvocationId: string;
  readonly originInvocationId: string;
  readonly originResultDigest: string;
  /** Domain-separated result-ref identity, never the raw origin digest. */
  readonly resultRefDigest: string;
  readonly bridgeSequence: number;
  readonly chunkIndex: number;
  readonly plainDigest: string;
  readonly plainLength: number;
  readonly purpose: "dispatch_payload_recovery";
  readonly expiresAtMs: number;
}

export interface ProtectedObjectStorePort {
  readonly kind: "fs" | "conformance" | "unavailable";
  readonly readiness: {
    readonly ready: boolean;
    readonly reason: "ready" | "unsupported_platform" | "not_configured" | "key_unavailable";
  };
  /**
   * Returns the key id that will be used for a new protected object.  C39
   * persists this before the object write so rotation cannot strand a
   * crash-window object outside the durable live-key inventory.
   */
  activeKid(): Promise<string | null>;
  putProtected(input: {
    readonly storageKey: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly binding: ProtectedObjectBinding;
    /** Recovery durability pins the pre-reserved live key across restart. */
    readonly kid?: string;
  }): Promise<GatewayPortResult<{ readonly storageKey: string }>>;
  getProtected(input: {
    readonly storageKey: string;
    readonly contentType: string;
    readonly binding: ProtectedObjectBinding;
  }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>>;
  /**
   * Authenticated ciphertext deletion.  The wrapper verifies the exact
   * envelope/AAD/plain identity using its own backing store before deletion;
   * callers never receive an ordinary object-store delete capability.
   */
  deleteProtected(input: {
    readonly storageKey: string;
    readonly contentType: string;
    readonly binding: ProtectedObjectBinding;
    readonly expectedKid: string;
    /** Exact durable deletion claim; absence is never accepted without it. */
    readonly deletionClaim: { readonly id: string; readonly version: number };
  }): Promise<GatewayPortResult<{ readonly state: "deleted" | "missing" }>>;
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
    startupCoordinator: Object.freeze({
      contractVersion: "revagent.protocol-store-startup/v1" as const,
      async runExclusive<T>(): Promise<StoreOutcome<T>> { return refusal<T>(); },
      async listTenantIds(): Promise<StoreOutcome<readonly string[]>> { return refusal<readonly string[]>(); },
      async listKeys(): Promise<StoreOutcome<readonly string[]>> { return refusal<readonly string[]>(); },
    }),
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
