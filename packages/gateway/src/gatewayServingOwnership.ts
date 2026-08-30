import { createHash, randomUUID } from "node:crypto";

import type { GatewayPortResult } from "./gatewayPorts.js";
import type {
  GatewayPrivateObjectBinding,
  GatewayPrivateObjectIntentTicket,
  GatewayProtocolStore,
  GatewayStartupLease,
  ObjectStorePort,
  OwnedPrivateObjectStorePort,
  PrivateObjectStoreBackendPort,
  StoreOutcome,
} from "./store.js";
import { GATEWAY_PRIVATE_OBJECT_MAX_BYTES } from "./store.js";

export const GATEWAY_SESSION_DURABILITY_PROFILE_VERSION = 1 as const;

export interface SessionDurabilityProfileV1 {
  readonly version: typeof GATEWAY_SESSION_DURABILITY_PROFILE_VERSION;
  readonly mode: "private_object" | "refuse_dispatch";
  readonly maxParamsBytes: number;
  readonly maxOutboundWireBytes: number;
  readonly maxResultBytes: number;
  readonly maxPartialBytes: number;
  readonly inlineSlotBytes: 65_536;
  readonly privateObjectDomainDigest: `sha256:${string}` | null;
  readonly privateObjectMaxBytes: typeof GATEWAY_PRIVATE_OBJECT_MAX_BYTES | null;
  readonly resourceCarrierReady: boolean;
}

export type GatewayServingProfileKind =
  | "preproduction_private"
  | "production_conformance"
  | "bundled_test"
  | "refuse_dispatch";

const PRIVATE_PROFILE_LIMITS = Object.freeze({
  maxParamsBytes: 4 * 1024 * 1024,
  maxOutboundWireBytes: GATEWAY_PRIVATE_OBJECT_MAX_BYTES,
  maxResultBytes: 32 * 1024 * 1024,
  inlineSlotBytes: 65_536 as const,
});

export const REFUSE_DISPATCH_DURABILITY_PROFILE: SessionDurabilityProfileV1 =
  Object.freeze({
    version: GATEWAY_SESSION_DURABILITY_PROFILE_VERSION,
    mode: "refuse_dispatch" as const,
    maxParamsBytes: 1,
    maxOutboundWireBytes: 0,
    maxResultBytes: 1,
    maxPartialBytes: 1,
    inlineSlotBytes: 65_536 as const,
    privateObjectDomainDigest: null,
    privateObjectMaxBytes: null,
    resourceCarrierReady: false,
  });

const bundledByStore = new WeakMap<GatewayProtocolStore, GatewayServingOwnership>();

function storeFailure<T>(message: string): StoreOutcome<T> {
  return Object.freeze({ ok: false as const, code: "unavailable" as const, message });
}

function objectFailure<T>(message: string): GatewayPortResult<T> {
  return Object.freeze({
    ok: false as const,
    port: "object_store" as const,
    code: "unavailable" as const,
    message,
  });
}

function isBackend(candidate: ObjectStorePort): candidate is PrivateObjectStoreBackendPort {
  const value = candidate as Partial<PrivateObjectStoreBackendPort>;
  return typeof value.putOwned === "function" &&
    typeof value.getOwnedOptional === "function" &&
    typeof value.deleteOwned === "function" &&
    typeof value.scanOwned === "function";
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * One process owner for protocol and private-object storage.  The raw ports are
 * never returned: every operation enters this owner's drain accounting and
 * checks the immutable startup lease immediately before backend IO.
 */
export class GatewayServingOwnership {
  readonly #rawStore: GatewayProtocolStore;
  readonly #rawObjects: ObjectStorePort | null;
  readonly #backend: PrivateObjectStoreBackendPort | null;
  readonly #profileKind: GatewayServingProfileKind;
  readonly #ownerIdentity = randomUUID();
  readonly #tickets = new WeakSet<object>();
  readonly #domainDigest: `sha256:${string}`;
  readonly protocolStore: GatewayProtocolStore;
  readonly resourceObjectStore: ObjectStorePort | null;

  #lease: GatewayStartupLease | null = null;
  #state: "unowned" | "acquiring" | "startup_exclusive" | "owned_running" | "draining" | "lost" | "released" = "unowned";
  #openTask: Promise<StoreOutcome<void>> | null = null;
  #closeTask: Promise<StoreOutcome<void>> | null = null;
  #ownerTask: Promise<StoreOutcome<void>> | null = null;
  #releaseOwner: (() => void) | null = null;
  #activeIo = 0;
  #drainWaiters: Array<() => void> = [];

  public constructor(input: {
    readonly protocolStore: GatewayProtocolStore;
    readonly privateObjectStore?: ObjectStorePort;
    readonly profile: GatewayServingProfileKind;
  }) {
    this.#rawStore = input.protocolStore;
    this.#rawObjects = input.privateObjectStore ?? null;
    this.#backend = this.#rawObjects !== null && isBackend(this.#rawObjects)
      ? this.#rawObjects
      : null;
    this.#profileKind = input.profile;
    this.#domainDigest = `sha256:${createHash("sha256")
      .update("revagent/gateway/private-object-domain/v1\0")
      .update(this.#ownerIdentity)
      .digest("hex")}`;

    const startupCoordinator = Object.freeze({
      contractVersion: "revagent.protocol-store-startup/v1" as const,
      runExclusive: async <T>(
        work: (lease: GatewayStartupLease) => Promise<StoreOutcome<T>>,
      ): Promise<StoreOutcome<T>> => {
        const lease = this.#currentLease();
        if (lease === null) return storeFailure<T>("Gateway serving owner is unavailable");
        const result = await work(lease);
        return lease.isCurrent()
          ? result
          : storeFailure<T>("Gateway serving owner was lost during startup work");
      },
      listTenantIds: async (limit: number) => await this.#withIo(
        () => this.#rawStore.startupCoordinator.listTenantIds(limit),
      ),
      listKeys: async (tenantId: string, namespace: string, limit: number) =>
        await this.#withIo(
          () => this.#rawStore.startupCoordinator.listKeys(tenantId, namespace, limit),
        ),
    });

    this.protocolStore = Object.freeze({
      kind: input.protocolStore.kind,
      contractVersion: input.protocolStore.contractVersion,
      startupCoordinator,
      open: async () => await this.open(),
      transact: async <T>(scope: { readonly tenantId: string }, work: Parameters<GatewayProtocolStore["transact"]>[1]) =>
        await this.#withIo(
          () => this.#rawStore.transact(scope, work) as Promise<StoreOutcome<T>>,
        ),
      close: async () => await this.close(),
    });

    this.resourceObjectStore = this.#rawObjects === null
      ? null
      : this.bindObjectStore(this.#rawObjects);
  }

  public get ownerIdentity(): string { return this.#ownerIdentity; }
  public get ownerEpoch(): number { return this.#lease?.epoch ?? 0; }
  public get state(): string { return this.#state; }

  public bindObjectStore(store: ObjectStorePort): ObjectStorePort {
    return Object.freeze({
      kind: store.kind,
      put: async (value: Parameters<ObjectStorePort["put"]>[0]) =>
        await this.#withObjectIo(() => store.put(value)),
      get: async (value: Parameters<ObjectStorePort["get"]>[0]) =>
        await this.#withObjectIo(() => store.get(value)),
      ...(store.getOptional === undefined
        ? {}
        : {
            getOptional: async (value: Parameters<NonNullable<ObjectStorePort["getOptional"]>>[0]) =>
              await this.#withObjectIo(() => store.getOptional!(value)),
          }),
      head: async (value: Parameters<ObjectStorePort["head"]>[0]) =>
        await this.#withObjectIo(() => store.head(value)),
      delete: async (value: Parameters<ObjectStorePort["delete"]>[0]) =>
        await this.#withObjectIo(() => store.delete(value)),
    });
  }

  public durabilityProfile(): SessionDurabilityProfileV1 {
    const privateReady = this.#profileKind !== "refuse_dispatch" &&
      this.#backend !== null && this.#currentLease() !== null;
    if (!privateReady) return REFUSE_DISPATCH_DURABILITY_PROFILE;
    return Object.freeze({
      version: GATEWAY_SESSION_DURABILITY_PROFILE_VERSION,
      mode: "private_object" as const,
      ...PRIVATE_PROFILE_LIMITS,
      maxPartialBytes: this.#profileKind === "production_conformance"
        ? 1024 * 1024
        : this.#profileKind === "preproduction_private"
          ? 1
          : 64 * 1024,
      privateObjectDomainDigest: this.#domainDigest,
      privateObjectMaxBytes: GATEWAY_PRIVATE_OBJECT_MAX_BYTES,
      resourceCarrierReady: this.#profileKind === "production_conformance",
    });
  }

  public open(): Promise<StoreOutcome<void>> {
    if (this.#state === "owned_running" || this.#state === "startup_exclusive") {
      return Promise.resolve(Object.freeze({ ok: true as const, value: undefined }));
    }
    if (this.#openTask !== null) return this.#openTask;
    if (this.#state === "released") this.#closeTask = null;
    this.#openTask = this.#performOpen().finally(() => { this.#openTask = null; });
    return this.#openTask;
  }

  async #performOpen(): Promise<StoreOutcome<void>> {
    if (this.#profileKind !== "refuse_dispatch" && this.#backend === null) {
      this.#state = "lost";
      return storeFailure("owned private object store capability is unavailable");
    }
    this.#state = "acquiring";
    const opened = await this.#rawStore.open();
    if (!opened.ok) {
      this.#state = "released";
      return opened;
    }
    let acquired!: (lease: GatewayStartupLease) => void;
    const acquiredPromise = new Promise<GatewayStartupLease>((resolve) => { acquired = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    this.#releaseOwner = release;
    this.#ownerTask = this.#rawStore.startupCoordinator.runExclusive(async (lease) => {
      this.#lease = lease;
      this.#state = "startup_exclusive";
      acquired(lease);
      await releasePromise;
      return Object.freeze({ ok: true as const, value: undefined });
    });
    const ownerFailed = this.#ownerTask.then((result) => {
      if (!result.ok && this.#lease === null) throw new Error(result.message);
      return null;
    });
    try {
      const lease = await Promise.race([acquiredPromise, ownerFailed]);
      if (lease === null || !lease.isCurrent()) {
        this.#state = "lost";
        return storeFailure("Gateway serving lease was not acquired");
      }
      this.#state = "owned_running";
      return Object.freeze({ ok: true as const, value: undefined });
    } catch {
      this.#state = "lost";
      await this.#rawStore.close();
      return storeFailure("Gateway serving lease is unavailable");
    }
  }

  public close(): Promise<StoreOutcome<void>> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#closeTask = this.#performClose();
    return this.#closeTask;
  }

  async #performClose(): Promise<StoreOutcome<void>> {
    if (this.#state === "released" || this.#state === "unowned") {
      return Object.freeze({ ok: true as const, value: undefined });
    }
    this.#state = this.#currentLease() === null ? "lost" : "draining";
    await this.#drainIo();
    this.#releaseOwner?.();
    const owner = await this.#ownerTask;
    this.#lease = null;
    const closed = await this.#rawStore.close();
    this.#state = "released";
    if (owner !== null && !owner.ok) return owner;
    return closed;
  }

  public privateObjectStore(): OwnedPrivateObjectStorePort | null {
    if (this.#backend === null) return null;
    const port: OwnedPrivateObjectStorePort = {
      kind: this.#backend.kind,
      contractVersion: "revagent.gateway-owned-private-object-store/v1" as const,
      maxObjectBytes: GATEWAY_PRIVATE_OBJECT_MAX_BYTES,
      ownerIdentity: this.#ownerIdentity,
      ownerEpoch: this.ownerEpoch,
      isCurrent: () => this.#currentLease() !== null,
      put: async (ticket: GatewayPrivateObjectIntentTicket, bytes: Uint8Array) => {
        if (!this.#validTicket(ticket) || bytes.byteLength > GATEWAY_PRIVATE_OBJECT_MAX_BYTES ||
            bytes.byteLength !== ticket.binding.byteLength || digestBytes(bytes) !== ticket.binding.digest) {
          return objectFailure("private object intent or bytes are invalid");
        }
        return await this.#withObjectIo<{ readonly storageKey: string }>(
          () => this.#backend!.putOwned({ binding: ticket.binding, bytes }),
        );
      },
      get: async (binding: GatewayPrivateObjectBinding) => {
        const result = await this.#withObjectIo<
          { readonly bytes: Uint8Array; readonly contentType: string } | null
        >(
          () => this.#backend!.getOwnedOptional({ binding }),
        );
        if (!result.ok) return result;
        if (result.value === null) return objectFailure("private object is unavailable");
        if (result.value.bytes.byteLength !== binding.byteLength ||
            result.value.contentType !== binding.contentType ||
            digestBytes(result.value.bytes) !== binding.digest) {
          return objectFailure("private object readback does not match its durable descriptor");
        }
        return Object.freeze({ ok: true as const, value: result.value });
      },
      getOptional: async (binding: GatewayPrivateObjectBinding) => {
        const result = await this.#withObjectIo<
          { readonly bytes: Uint8Array; readonly contentType: string } | null
        >(
          () => this.#backend!.getOwnedOptional({ binding }),
        );
        if (!result.ok || result.value === null) return result;
        if (result.value.bytes.byteLength !== binding.byteLength ||
            result.value.contentType !== binding.contentType ||
            digestBytes(result.value.bytes) !== binding.digest) {
          return objectFailure("private object readback does not match its durable descriptor");
        }
        return result;
      },
      delete: async (ticket: GatewayPrivateObjectIntentTicket) => this.#validTicket(ticket)
        ? await this.#withObjectIo<{ readonly state: "deleted" | "missing" }>(
            () => this.#backend!.deleteOwned({ binding: ticket.binding }),
          )
        : objectFailure("private object deletion intent is invalid"),
      scanOwned: async (input: {
        readonly tenantId: string;
        readonly rsid: string;
        readonly purpose?: GatewayPrivateObjectBinding["purpose"];
        readonly afterKey: string | null;
        readonly limit: number;
      }) => {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64) {
          return objectFailure("private object inventory limit is invalid");
        }
        return await this.#withObjectIo(() => this.#backend!.scanOwned(input));
      },
    };
    return Object.freeze(port);
  }

  public mintPrivateObjectIntent(input: GatewayPrivateObjectIntentTicket): GatewayPrivateObjectIntentTicket {
    if (this.#currentLease() === null || input.binding.byteLength < 0 ||
        input.binding.byteLength > GATEWAY_PRIVATE_OBJECT_MAX_BYTES ||
        input.intentVersion < 1 || !/^sha256:[0-9a-f]{64}$/u.test(input.binding.digest)) {
      throw new Error("private object intent is unavailable");
    }
    const ticket = Object.freeze({
      binding: Object.freeze({ ...input.binding }),
      intentNamespace: input.intentNamespace,
      intentKey: input.intentKey,
      intentVersion: input.intentVersion,
    });
    this.#tickets.add(ticket);
    return ticket;
  }

  #validTicket(ticket: GatewayPrivateObjectIntentTicket): boolean {
    return this.#tickets.has(ticket as object) &&
      ticket.binding.byteLength <= GATEWAY_PRIVATE_OBJECT_MAX_BYTES;
  }

  #currentLease(): GatewayStartupLease | null {
    const lease = this.#lease;
    if (lease === null || !lease.isCurrent() ||
        (this.#state !== "startup_exclusive" && this.#state !== "owned_running")) {
      return null;
    }
    return lease;
  }

  async #withIo<T>(work: () => Promise<StoreOutcome<T>>): Promise<StoreOutcome<T>> {
    if (this.#currentLease() === null) return storeFailure("Gateway serving owner is unavailable");
    this.#activeIo += 1;
    try {
      if (this.#currentLease() === null) return storeFailure("Gateway serving owner was lost before IO");
      return await work();
    } finally {
      this.#activeIo -= 1;
      if (this.#activeIo === 0) this.#settleDrain();
    }
  }

  async #withObjectIo<T>(work: () => Promise<GatewayPortResult<T>>): Promise<GatewayPortResult<T>> {
    if (this.#currentLease() === null) return objectFailure("Gateway serving owner is unavailable");
    this.#activeIo += 1;
    try {
      if (this.#currentLease() === null) return objectFailure("Gateway serving owner was lost before IO");
      return await work();
    } finally {
      this.#activeIo -= 1;
      if (this.#activeIo === 0) this.#settleDrain();
    }
  }

  async #drainIo(): Promise<void> {
    if (this.#activeIo === 0) return;
    await new Promise<void>((resolve) => this.#drainWaiters.push(resolve));
  }

  #settleDrain(): void {
    const waiters = this.#drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

export function bindBundledTestServingOwnership(
  store: GatewayProtocolStore,
  ownership: GatewayServingOwnership,
): void {
  if (bundledByStore.has(store)) throw new Error("test serving ownership is already bound");
  bundledByStore.set(store, ownership);
}

export function resolveBundledTestServingOwnership(
  store: GatewayProtocolStore,
): GatewayServingOwnership | null {
  return bundledByStore.get(store) ?? null;
}
