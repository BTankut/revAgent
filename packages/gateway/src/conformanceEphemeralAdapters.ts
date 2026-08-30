import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
  type DeviceAuthContext,
  type EntitlementPort,
  type IdentityPort,
} from "./authContext.js";
import type { GatewayJsonValue } from "./dispatch.js";
import type { GatewayEventSink } from "./events.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import type {
  GatewayOwnedPrivateObjectMetadata,
  GatewayPrivateObjectBinding,
  GatewayProtocolStore,
  GatewayStartupCoordinator,
  GatewayStartupLease,
  ObjectStorePort,
  PrivateObjectStoreBackendPort,
  StoreExpectation,
  StoreOutcome,
  StoreTransaction,
  StoredRecord,
} from "./store.js";
import { GATEWAY_PRIVATE_OBJECT_MAX_BYTES } from "./store.js";
import type { GuardrailPort } from "./guardrails.js";

const failure = <T>(message: string): GatewayPortResult<T> => Object.freeze({
  ok: false as const, port: "identity" as const, code: "unavailable" as const, message,
});
const storeFailure = <T>(code: "conflict" | "invalid_record" | "unavailable", message: string): StoreOutcome<T> =>
  Object.freeze({ ok: false as const, code, message });
const storeSuccess = <T>(value: T): StoreOutcome<T> => Object.freeze({ ok: true as const, value });
const STARTUP_LOCK_LEASE_MS = 30_000;
const STARTUP_LOCK_WAIT_MS = 5_000;

export interface ConformanceCredential {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly revoked?: boolean;
}

/**
 * Explicitly provisioned authority domains for one conformance launch.  This
 * is deliberately separate from a bridge's hello/session probes: the Gateway
 * computes the intersection, and the carrier never selects its own grants.
 */
export interface ConformanceDeviceCapabilityProvision {
  readonly connectionCapabilities: readonly string[];
  readonly sessionCapabilities: readonly string[];
}

const DEFAULT_CONFORMANCE_CAPABILITIES: ConformanceDeviceCapabilityProvision = Object.freeze({
  connectionCapabilities: Object.freeze([
    "journal_v1",
    "chunked_results",
    "artifact_result_v1",
    "route_rebind_proof_v1",
  ]),
  sessionCapabilities: Object.freeze(["batch_atomic", "doc_context_cached_v1"]),
});

/** HMAC-backed loopback credential authority.  It is intentionally public-test only. */
export class ConformanceCredentialAuthority implements IdentityPort {
  readonly kind = "conformance" as const;
  readonly #secret: Buffer;
  readonly #credentials = new Map<string, ConformanceCredential>();
  readonly #provisions = new Map<string, ConformanceDeviceCapabilityProvision>();
  readonly #audit: Array<{ readonly action: "issued" | "revoked" | "authenticated"; readonly deviceId: string }> = [];
  public constructor(credentials: readonly ConformanceCredential[], secret = randomBytes(32)) {
    this.#secret = Buffer.from(secret);
    for (const credential of credentials) this.#credentials.set(credential.deviceId, Object.freeze({ ...credential }));
  }
  public issue(
    deviceId: string,
    provision: ConformanceDeviceCapabilityProvision = DEFAULT_CONFORMANCE_CAPABILITIES,
  ): string {
    const credential = this.#credentials.get(deviceId);
    if (credential === undefined) throw new Error("unknown conformance device");
    if (!Array.isArray(provision.connectionCapabilities) ||
        !Array.isArray(provision.sessionCapabilities) ||
        !provision.connectionCapabilities.every((value) => typeof value === "string") ||
        !provision.sessionCapabilities.every((value) => typeof value === "string")) {
      throw new Error("invalid conformance capability provision");
    }
    this.#provisions.set(deviceId, Object.freeze({
      connectionCapabilities: Object.freeze([...provision.connectionCapabilities]),
      sessionCapabilities: Object.freeze([...provision.sessionCapabilities]),
    }));
    const proof = createHmac("sha256", this.#secret).update(`${credential.deviceId}:${credential.token}`).digest("hex");
    this.#audit.push({ action: "issued", deviceId });
    return `${credential.deviceId}.${proof}`;
  }
  public revoke(deviceId: string): boolean {
    const value = this.#credentials.get(deviceId);
    if (value === undefined) return false;
    this.#credentials.set(deviceId, Object.freeze({ ...value, revoked: true }));
    this.#audit.push({ action: "revoked", deviceId });
    return true;
  }
  public audit(): readonly { readonly action: "issued" | "revoked" | "authenticated"; readonly deviceId: string }[] {
    return Object.freeze([...this.#audit]);
  }
  async authenticateNorthRequest(input: { readonly authorization: string | undefined }): Promise<GatewayPortResult<AuthContext>> {
    const bearer = input.authorization?.replace(/^Bearer\s+/u, "");
    const match = bearer === undefined ? undefined : [...this.#credentials.values()].find((row) => row.token === bearer && !row.revoked);
    if (match === undefined) return failure("conformance north credential rejected");
    const now = Date.now();
    const context: AuthContext = {
      contractVersion: GATEWAY_AUTH_CONTRACT_VERSION, actor: { type: "user", tenantId: match.tenantId, userId: match.userId, role: "tenant_admin", oidcIssuer: "conformance://loopback", oidcSubject: match.userId },
      session: { sessionId: `conformance-${match.deviceId}`, clientType: "mcp", mcpSessionId: null, oauthClientId: null }, principalKey: `conformance:${match.tenantId}:${match.userId}`, issuedAtMs: now, expiresAtMs: now + 60_000,
    };
    return Object.freeze({ ok: true as const, value: context });
  }
  async authenticateDevice(input: { readonly deviceToken: string | undefined; readonly connectionId: string; readonly claimedDeviceId?: string; readonly machineFingerprint?: string }): Promise<GatewayPortResult<DeviceAuthContext>> {
    const rawToken = input.deviceToken;
    const [deviceId, proof] = rawToken?.split(".") ?? [];
    const credential = deviceId === undefined ? undefined : this.#credentials.get(deviceId);
    const expected = credential === undefined ? "" : createHmac("sha256", this.#secret).update(`${credential.deviceId}:${credential.token}`).digest("hex");
    const valid = proof !== undefined && proof.length === expected.length && timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
    if (!valid || credential === undefined || credential.revoked || input.claimedDeviceId !== deviceId || input.machineFingerprint === undefined || !/^sha256:[0-9a-f]{64}$/u.test(input.machineFingerprint)) return failure("conformance device credential rejected");
    this.#audit.push({ action: "authenticated", deviceId });
    const provision = this.#provisions.get(deviceId) ?? DEFAULT_CONFORMANCE_CAPABILITIES;
    const context: DeviceAuthContext = {
      contractVersion: GATEWAY_AUTH_CONTRACT_VERSION, actor: { type: "device", tenantId: credential.tenantId, userId: credential.userId, deviceId, seatId: `seat-${deviceId}` }, connectionId: input.connectionId, deviceStatus: "active", machineFingerprint: input.machineFingerprint as `sha256:${string}`,
      authorizationVersion: 1, identityRecordVersion: 1, connectionCapabilityVersion: 1, sessionCapabilityVersion: 1, seatAuthorityVersion: 1, seatRecordVersion: 1,
      grantedConnectionCapabilities: [...provision.connectionCapabilities], grantedSessionCapabilities: [...provision.sessionCapabilities], deviceTokenDigest: `sha256:${createHash("sha256").update(rawToken!).digest("hex")}`,
    };
    return Object.freeze({ ok: true as const, value: context });
  }
}

interface SqliteRow { readonly tenant_id: string; readonly namespace: string; readonly key: string; readonly value_json: string; readonly version: number; readonly updated_at_ms: number; }

/** Actual SQLite adapter: WAL+FULL, immediate CAS transactions, and cross-process startup fencing. */
export class SqliteConformanceProtocolStore implements GatewayProtocolStore {
  readonly kind = "conformance" as const;
  readonly contractVersion = "revagent.protocol-store/v1" as const;
  readonly #file: string;
  #database: Database.Database | null = null;
  #opened = false;
  #exclusive: Promise<void> = Promise.resolve();
  readonly #startupLeaseMs: number;
  readonly #startupRenewMs: number;
  #activeStartupToken: string | null = null;
  public readonly startupCoordinator: GatewayStartupCoordinator;
  public constructor(root: string, options: { readonly startupLeaseMs?: number; readonly startupRenewMs?: number } = {}) {
    this.#file = path.join(root, "sqlite.db");
    this.#startupLeaseMs = options.startupLeaseMs ?? STARTUP_LOCK_LEASE_MS;
    this.#startupRenewMs = options.startupRenewMs ?? Math.floor(STARTUP_LOCK_LEASE_MS / 4);
    if (!Number.isSafeInteger(this.#startupLeaseMs) || !Number.isSafeInteger(this.#startupRenewMs) || this.#startupLeaseMs < 30 || this.#startupRenewMs < 10 || this.#startupRenewMs >= this.#startupLeaseMs / 3) throw new RangeError("invalid conformance startup lease configuration");
    this.startupCoordinator = Object.freeze({ contractVersion: "revagent.protocol-store-startup/v1" as const,
      runExclusive: async <T>(work: (lease: GatewayStartupLease) => Promise<StoreOutcome<T>>) => this.#runStartupExclusive(work),
      listTenantIds: async (limit: number) => this.#inventoryTenants(limit),
      listKeys: async (tenantId: string, namespace: string, limit: number) => this.#inventoryKeys(tenantId, namespace, limit),
    });
  }
  async #withLock<T>(work: () => Promise<StoreOutcome<T>>): Promise<StoreOutcome<T>> { const previous = this.#exclusive; let release!: () => void; this.#exclusive = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
  #db(): Database.Database { if (!this.#opened || this.#database === null) throw new Error("closed"); return this.#database; }
  async open(): Promise<StoreOutcome<void>> { try { await mkdir(path.dirname(this.#file), { recursive: true }); const database = new Database(this.#file, { timeout: 5_000 }); database.pragma("journal_mode = WAL"); database.pragma("synchronous = FULL"); database.pragma("foreign_keys = ON"); database.pragma("fullfsync = ON"); database.exec("CREATE TABLE IF NOT EXISTS conformance_records (tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), updated_at_ms INTEGER NOT NULL, PRIMARY KEY (tenant_id, namespace, key)); CREATE TABLE IF NOT EXISTS conformance_startup_lock (id INTEGER PRIMARY KEY CHECK(id = 1), owner_token TEXT NULL, lease_expires_at_ms INTEGER NOT NULL, version INTEGER NOT NULL); INSERT OR IGNORE INTO conformance_startup_lock(id, owner_token, lease_expires_at_ms, version) VALUES (1, NULL, 0, 0);"); this.#database = database; this.#opened = true; return storeSuccess(undefined); } catch { return storeFailure("unavailable", "conformance SQLite store unavailable"); } }
  async close(): Promise<StoreOutcome<void>> { try { this.#database?.close(); this.#database = null; this.#opened = false; return storeSuccess(undefined); } catch { return storeFailure("unavailable", "conformance SQLite close failed"); } }
  async #inventoryTenants(limit: number): Promise<StoreOutcome<readonly string[]>> { if (!Number.isSafeInteger(limit) || limit < 1) return storeFailure("invalid_record", "invalid inventory limit"); try { return storeSuccess(this.#db().prepare<unknown[], { tenant_id: string }>("SELECT DISTINCT tenant_id FROM conformance_records ORDER BY tenant_id LIMIT ?").all(limit).map((row) => row.tenant_id)); } catch { return storeFailure("unavailable", "conformance SQLite inventory unavailable"); } }
  async #inventoryKeys(tenantId: string, namespace: string, limit: number): Promise<StoreOutcome<readonly string[]>> { if (!Number.isSafeInteger(limit) || limit < 1) return storeFailure("invalid_record", "invalid inventory limit"); try { return storeSuccess(this.#db().prepare<unknown[], { key: string }>("SELECT key FROM conformance_records WHERE tenant_id = ? AND namespace = ? ORDER BY key LIMIT ?").all(tenantId, namespace, limit).map((row) => row.key)); } catch { return storeFailure("unavailable", "conformance SQLite inventory unavailable"); } }
  async #runStartupExclusive<T>(
    work: (lease: GatewayStartupLease) => Promise<StoreOutcome<T>>,
  ): Promise<StoreOutcome<T>> {
    let database: Database.Database;
    try { database = this.#db(); } catch {
      return storeFailure("unavailable", "conformance SQLite store is closed");
    }
    const token = randomBytes(24).toString("hex");
    const deadline = Date.now() + STARTUP_LOCK_WAIT_MS;
    let version = -1;
    while (Date.now() < deadline && version < 0) {
      await this.#withLock(async () => {
        try {
          database.exec("BEGIN IMMEDIATE");
          const lock = database.prepare<unknown[], {
            owner_token: string | null;
            lease_expires_at_ms: number;
            version: number;
          }>("SELECT owner_token, lease_expires_at_ms, version FROM conformance_startup_lock WHERE id = 1").get();
          if (lock !== undefined &&
              (lock.owner_token === null || lock.lease_expires_at_ms <= Date.now())) {
            const result = database.prepare(
              "UPDATE conformance_startup_lock SET owner_token = ?, lease_expires_at_ms = ?, version = ? WHERE id = 1 AND version = ?",
            ).run(token, Date.now() + this.#startupLeaseMs, lock.version + 1, lock.version);
            if (result.changes === 1) version = lock.version + 1;
          }
          database.exec("COMMIT");
        } catch {
          try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { }
        }
        return storeSuccess(undefined);
      });
      if (version < 0) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    if (version < 0) return storeFailure("unavailable", "conformance startup lease timed out");

    let lost = false;
    this.#activeStartupToken = token;
    const lease: GatewayStartupLease = Object.freeze({
      contractVersion: "revagent.protocol-store-startup-lease/v1" as const,
      identity: token,
      get epoch() { return version; },
      isCurrent: () => !lost && this.#activeStartupToken === token,
    });
    const renew = (): void => {
      if (lost || this.#activeStartupToken !== token) return;
      try {
        database.exec("BEGIN IMMEDIATE");
        const result = database.prepare(
          "UPDATE conformance_startup_lock SET lease_expires_at_ms = ?, version = ? WHERE id = 1 AND owner_token = ? AND version = ?",
        ).run(Date.now() + this.#startupLeaseMs, version + 1, token, version);
        if (result.changes !== 1) lost = true;
        else version += 1;
        database.exec("COMMIT");
      } catch {
        lost = true;
        try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { }
      }
    };
    const timer = setInterval(renew, this.#startupRenewMs);
    timer.unref();
    try {
      const result = await work(lease);
      return lost ? storeFailure("unavailable", "conformance startup lease lost") : result;
    } finally {
      clearInterval(timer);
      this.#activeStartupToken = null;
      await this.#withLock(async () => {
        try {
          database.exec("BEGIN IMMEDIATE");
          const result = database.prepare(
            "UPDATE conformance_startup_lock SET owner_token = NULL, lease_expires_at_ms = 0, version = version + 1 WHERE id = 1 AND owner_token = ? AND version = ?",
          ).run(token, version);
          if (result.changes !== 1) lost = true;
          database.exec("COMMIT");
        } catch {
          lost = true;
          try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { }
        }
        return storeSuccess(undefined);
      });
    }
  }
  async transact<T>(
    scope: { readonly tenantId: string },
    fn: (tx: StoreTransaction) => Promise<T> | T,
  ): Promise<StoreOutcome<T>> {
    return await this.#withLock(async () => {
      const boundedIdentifier = (value: string): boolean =>
        value.length > 0 && Buffer.byteLength(value, "utf8") <= 512;
      if (!boundedIdentifier(scope.tenantId)) {
        return storeFailure("invalid_record", "missing or oversized tenant scope");
      }
      let database: Database.Database;
      try { database = this.#db(); }
      catch { return storeFailure("unavailable", "conformance SQLite store is closed"); }

      const activeOwnerIsForeign = (): boolean => {
        const lock = database.prepare<unknown[], {
          owner_token: string | null;
          lease_expires_at_ms: number;
        }>("SELECT owner_token, lease_expires_at_ms FROM conformance_startup_lock WHERE id = 1").get();
        return lock !== undefined && lock.owner_token !== null &&
          lock.lease_expires_at_ms > Date.now() &&
          lock.owner_token !== this.#activeStartupToken;
      };
      if (activeOwnerIsForeign()) {
        return storeFailure("unavailable", "conformance SQLite serving owner is busy");
      }

      const staged: Array<{
        namespace: string;
        key: string;
        value: GatewayJsonValue | null;
        serialized: string | null;
        valueBytes: number;
        expect: StoreExpectation;
      }> = [];
      const targets = new Set<string>();
      let invalid = false;
      const row = (namespace: string, key: string): SqliteRow | undefined =>
        database.prepare<unknown[], SqliteRow>(
          "SELECT tenant_id, namespace, key, value_json, version, updated_at_ms FROM conformance_records WHERE tenant_id = ? AND namespace = ? AND key = ?",
        ).get(scope.tenantId, namespace, key);
      const toRecord = <TRecord extends GatewayJsonValue>(
        value: SqliteRow | undefined,
      ): StoredRecord<TRecord> | null => value === undefined ? null : {
        namespace: value.namespace,
        tenantId: value.tenant_id,
        key: value.key,
        value: JSON.parse(value.value_json) as TRecord,
        version: value.version,
        updatedAtMs: value.updated_at_ms,
      };
      const tx: StoreTransaction = {
        read: async <TRecord extends GatewayJsonValue>(namespace: string, key: string) => {
          if (!boundedIdentifier(namespace) || !boundedIdentifier(key)) {
            invalid = true;
            return null;
          }
          return toRecord<TRecord>(row(namespace, key));
        },
        list: async (namespace: string) => {
          if (!boundedIdentifier(namespace)) {
            invalid = true;
            return [];
          }
          return database.prepare<unknown[], SqliteRow>(
            "SELECT tenant_id, namespace, key, value_json, version, updated_at_ms FROM conformance_records WHERE tenant_id = ? AND namespace = ? ORDER BY key",
          ).all(scope.tenantId, namespace).map((item) => toRecord(item)!);
        },
        stage: (write) => {
          if (staged.length >= 128 || !boundedIdentifier(write.namespace) ||
              !boundedIdentifier(write.key)) {
            invalid = true;
            return;
          }
          const target = `${write.namespace}\u0000${write.key}`;
          if (targets.has(target)) {
            invalid = true;
            return;
          }
          let serialized: string | null = null;
          let valueBytes = 0;
          if (write.value !== null) {
            try {
              serialized = JSON.stringify(write.value);
              valueBytes = Buffer.byteLength(serialized, "utf8");
            } catch {
              invalid = true;
              return;
            }
            if (valueBytes > 2 * 1024 * 1024) {
              invalid = true;
              return;
            }
          }
          targets.add(target);
          staged.push({ ...write, serialized, valueBytes });
        },
      };

      let result: T;
      try { result = await fn(tx); }
      catch { return storeFailure("invalid_record", "conformance transaction rejected"); }
      if (invalid || activeOwnerIsForeign()) {
        return storeFailure(
          invalid ? "invalid_record" : "unavailable",
          invalid
            ? "conformance transaction exceeded a frozen cap"
            : "conformance SQLite serving owner changed",
        );
      }

      try {
        database.exec("BEGIN IMMEDIATE");
        if (activeOwnerIsForeign()) {
          database.exec("ROLLBACK");
          return storeFailure("unavailable", "conformance SQLite serving owner changed");
        }
        const totals = database.prepare<unknown[], {
          record_count: number;
          value_bytes: number;
        }>(
          "SELECT COUNT(*) AS record_count, COALESCE(SUM(LENGTH(CAST(value_json AS BLOB))), 0) AS value_bytes FROM conformance_records",
        ).get() ?? { record_count: 0, value_bytes: 0 };
        let projectedRecords = totals.record_count;
        let projectedBytes = totals.value_bytes;
        for (const write of staged) {
          const current = row(write.namespace, write.key);
          if ((write.expect.kind === "absent" && current !== undefined) ||
              (write.expect.kind === "version" &&
                (current === undefined || current.version !== write.expect.version))) {
            database.exec("ROLLBACK");
            return storeFailure("conflict", "conformance SQLite compare-and-swap conflicted");
          }
          const currentBytes = current === undefined
            ? 0
            : Buffer.byteLength(current.value_json, "utf8");
          if (write.serialized === null) {
            if (current !== undefined) projectedRecords -= 1;
            projectedBytes -= currentBytes;
          } else {
            if (current === undefined) projectedRecords += 1;
            projectedBytes += write.valueBytes - currentBytes;
          }
        }
        if (projectedRecords > 1_024 || projectedBytes > 64 * 1024 * 1024) {
          database.exec("ROLLBACK");
          return storeFailure("invalid_record", "conformance SQLite capacity was exceeded");
        }
        const updatedAtMs = Date.now();
        for (const write of staged) {
          const current = row(write.namespace, write.key);
          if (write.serialized === null) {
            database.prepare(
              "DELETE FROM conformance_records WHERE tenant_id = ? AND namespace = ? AND key = ?",
            ).run(scope.tenantId, write.namespace, write.key);
          } else {
            const nextVersion = (current?.version ?? 0) + 1;
            if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) {
              database.exec("ROLLBACK");
              return storeFailure("invalid_record", "conformance SQLite version overflowed");
            }
            database.prepare(
              "INSERT INTO conformance_records(tenant_id, namespace, key, value_json, version, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, namespace, key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version, updated_at_ms = excluded.updated_at_ms",
            ).run(
              scope.tenantId,
              write.namespace,
              write.key,
              write.serialized,
              nextVersion,
              updatedAtMs,
            );
          }
        }
        database.exec("COMMIT");
        return storeSuccess(result);
      } catch {
        try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { }
        return storeFailure("unavailable", "conformance SQLite durable commit failed");
      }
    });
  }
}

export class DigestFileConformanceObjectStore implements PrivateObjectStoreBackendPort {
  readonly kind = "conformance" as const;
  readonly #root: string;
  #physicalRoot: string | null = null;
  #ready: Promise<void> | null = null;
  public constructor(root: string) { this.#root = path.resolve(root, "objects"); }

  #objectFailure<T>(message: string): GatewayPortResult<T> {
    return Object.freeze({
      ok: false as const,
      port: "object_store" as const,
      code: "unavailable" as const,
      message,
    });
  }

  #file(tenantId: string, storageKey: string): string | null {
    if (!/^[a-zA-Z0-9_-]+$/u.test(tenantId) ||
        !/^sha256:[0-9a-f]{64}$/u.test(storageKey)) return null;
    return path.join(this.#root, tenantId, storageKey.slice(7));
  }

  async #assertNoLinkComponent(candidate: string): Promise<void> {
    const parsed = path.parse(candidate);
    let current = parsed.root;
    for (const part of path.relative(parsed.root, candidate).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error("conformance object path contains a link");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  async #assertContained(candidate: string): Promise<void> {
    const root = await this.#assertPhysicalRootCurrent();
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("conformance object path escaped root");
    }
  }

  async #assertPhysicalRootCurrent(): Promise<string> {
    if (this.#physicalRoot === null) throw new Error("conformance object root is not opened");
    const current = await realpath(this.#root);
    const normalize = (value: string): string => process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
    if (normalize(current) !== normalize(this.#physicalRoot) ||
        (await lstat(this.#root)).isSymbolicLink()) {
      throw new Error("conformance object physical root changed");
    }
    return this.#physicalRoot;
  }

  async #withDeleteRootPinned<T>(action: () => Promise<T>): Promise<T> {
    await this.#open();
    const pin = await open(path.join(this.#root, ".conformance-owner-v1"), "r+");
    try {
      await this.#assertPhysicalRootCurrent();
      return await action();
    } finally {
      await pin.close();
    }
  }

  async #open(): Promise<void> {
    if (this.#ready !== null) return this.#ready;
    this.#ready = (async () => {
      await this.#assertNoLinkComponent(path.dirname(this.#root));
      await mkdir(path.dirname(this.#root), { recursive: true });
      const marker = path.join(this.#root, ".conformance-owner-v1");
      try {
        await mkdir(this.#root, { recursive: false, mode: 0o700 });
        await this.#writeAtomic(marker, Buffer.from("revagent-conformance-owner/v1", "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const rootStat = await lstat(this.#root);
        if (rootStat.isSymbolicLink()) throw new Error("conformance object root is a link");
        if ((await readFile(marker, "utf8")) !== "revagent-conformance-owner/v1") {
          throw new Error("conformance object root is unowned");
        }
      }
      this.#physicalRoot = await realpath(this.#root);
      await this.#assertPhysicalRootCurrent();
    })();
    return this.#ready;
  }

  async #ensureTenant(tenantId: string): Promise<void> {
    await this.#open();
    await this.#assertPhysicalRootCurrent();
    const tenant = path.join(this.#root, tenantId);
    try { await mkdir(tenant, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(tenant);
    if (stat.isSymbolicLink()) throw new Error("conformance tenant directory is a link");
    await this.#assertContained(tenant);
  }

  async #readableFile(file: string): Promise<void> {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error("conformance object is a link");
    await this.#assertContained(file);
  }

  async #writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    await rename(temporary, file);
  }

  async #writeExclusive(file: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
      await link(temporary, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #readContainer(tenantId: string, storageKey: string): Promise<{
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly owner: GatewayPrivateObjectBinding | null;
  } | null> {
    const file = this.#file(tenantId, storageKey);
    if (file === null) throw new Error("conformance object key rejected");
    try {
      await this.#open();
      await this.#readableFile(file);
      const container = await readFile(file);
      if (container.subarray(0, 5).toString("utf8") !== "RACO1") throw new Error("container magic");
      const headerLength = container.readUInt32BE(5);
      const header = JSON.parse(container.subarray(9, 9 + headerLength).toString("utf8")) as {
        v: number;
        digest: string;
        storageKey?: string;
        length: number;
        contentType: string;
        owner?: GatewayPrivateObjectBinding;
      };
      const bytes = container.subarray(9 + headerLength);
      const byteDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const ordinary = header.v === 1 && header.owner === undefined &&
        header.storageKey === undefined && header.digest === storageKey && byteDigest === storageKey;
      const owned = header.v === 2 && header.owner !== undefined &&
        header.storageKey === storageKey && header.digest === header.owner.digest &&
        header.owner.tenantId === tenantId && header.owner.storageKey === storageKey &&
        header.owner.byteLength === bytes.byteLength &&
        header.owner.contentType === header.contentType && byteDigest === header.owner.digest;
      if ((!ordinary && !owned) || header.length !== bytes.byteLength ||
          header.contentType.length === 0 || header.contentType.length > 256) {
        throw new Error("container integrity");
      }
      return { bytes, contentType: header.contentType, owner: header.owner ?? null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async #putContainer(input: {
    readonly tenantId: string;
    readonly storageKey: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly owner: GatewayPrivateObjectBinding | null;
  }): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
    const file = this.#file(input.tenantId, input.storageKey);
    const byteDigest = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`;
    const identityValid = input.owner === null
      ? byteDigest === input.storageKey
      : input.owner.tenantId === input.tenantId &&
        input.owner.storageKey === input.storageKey &&
        input.owner.byteLength === input.bytes.byteLength &&
        input.owner.digest === byteDigest && input.owner.contentType === input.contentType;
    if (file === null || input.bytes.byteLength > GATEWAY_PRIVATE_OBJECT_MAX_BYTES ||
        !identityValid || input.contentType.length === 0 || input.contentType.length > 256) {
      return this.#objectFailure("conformance object digest rejected");
    }
    try {
      await this.#ensureTenant(input.tenantId);
      const header = Buffer.from(JSON.stringify({
        v: input.owner === null ? 1 : 2,
        digest: input.owner?.digest ?? input.storageKey,
        ...(input.owner === null ? {} : { storageKey: input.storageKey }),
        length: input.bytes.byteLength,
        contentType: input.contentType,
        ...(input.owner === null ? {} : { owner: input.owner }),
      }), "utf8");
      const container = Buffer.concat([
        Buffer.from("RACO1"),
        Buffer.from(Uint32Array.of(header.byteLength).buffer).swap32(),
        header,
        input.bytes,
      ]);
      if (input.owner === null) {
        await this.#writeAtomic(file, container);
      } else if (!await this.#writeExclusive(file, container)) {
        const prior = await this.#readContainer(input.tenantId, input.storageKey);
        if (prior === null || prior.owner === null ||
            JSON.stringify(prior.owner) !== JSON.stringify(input.owner) ||
            prior.contentType !== input.contentType ||
            !Buffer.from(prior.bytes).equals(input.bytes)) {
          return this.#objectFailure("owned conformance object key is already bound");
        }
      }
      return Object.freeze({ ok: true as const, value: { storageKey: input.storageKey } });
    } catch {
      return this.#objectFailure("conformance object write refused");
    }
  }

  async put(input: Parameters<ObjectStorePort["put"]>[0]): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
    return await this.#putContainer({ ...input, owner: null });
  }

  async get(input: Parameters<ObjectStorePort["get"]>[0]): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>> {
    try {
      const value = await this.#readContainer(input.tenantId, input.storageKey);
      return value === null
        ? this.#objectFailure("conformance object unavailable")
        : Object.freeze({ ok: true as const, value: { bytes: value.bytes, contentType: value.contentType } });
    } catch { return this.#objectFailure("conformance object unavailable"); }
  }

  async getOptional(input: Parameters<NonNullable<ObjectStorePort["getOptional"]>>[0]): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>> {
    try {
      const value = await this.#readContainer(input.tenantId, input.storageKey);
      return Object.freeze({
        ok: true as const,
        value: value === null ? null : { bytes: value.bytes, contentType: value.contentType },
      });
    } catch { return this.#objectFailure("conformance object unavailable"); }
  }

  async head(input: Parameters<ObjectStorePort["head"]>[0]): Promise<GatewayPortResult<{ readonly byteSize: number }>> {
    const result = await this.get(input);
    return result.ok
      ? Object.freeze({ ok: true as const, value: { byteSize: result.value.bytes.byteLength } })
      : result;
  }

  async delete(input: Parameters<ObjectStorePort["delete"]>[0]): Promise<GatewayPortResult<void>> {
    const file = this.#file(input.tenantId, input.storageKey);
    if (file === null) return this.#objectFailure("conformance object key rejected");
    try {
      await this.#withDeleteRootPinned(async () => {
        await this.#readableFile(file);
        await rm(file);
      });
      return Object.freeze({ ok: true as const, value: undefined });
    } catch { return this.#objectFailure("conformance object unavailable"); }
  }

  async putOwned(input: {
    readonly binding: GatewayPrivateObjectBinding;
    readonly bytes: Uint8Array;
  }): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
    if (input.binding.byteLength !== input.bytes.byteLength) {
      return this.#objectFailure("owned conformance object descriptor rejected");
    }
    return await this.#putContainer({
      tenantId: input.binding.tenantId,
      storageKey: input.binding.storageKey,
      bytes: input.bytes,
      contentType: input.binding.contentType,
      owner: input.binding,
    });
  }

  async getOwnedOptional(input: { readonly binding: GatewayPrivateObjectBinding }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>> {
    try {
      const value = await this.#readContainer(input.binding.tenantId, input.binding.storageKey);
      if (value === null) return Object.freeze({ ok: true as const, value: null });
      if (value.owner === null || JSON.stringify(value.owner) !== JSON.stringify(input.binding)) {
        return this.#objectFailure("owned conformance object descriptor mismatch");
      }
      return Object.freeze({ ok: true as const, value: { bytes: value.bytes, contentType: value.contentType } });
    } catch { return this.#objectFailure("owned conformance object unavailable"); }
  }

  async deleteOwned(input: { readonly binding: GatewayPrivateObjectBinding }): Promise<GatewayPortResult<{ readonly state: "deleted" | "missing" }>> {
    const file = this.#file(input.binding.tenantId, input.binding.storageKey);
    if (file === null) return this.#objectFailure("owned conformance object key rejected");
    try {
      return await this.#withDeleteRootPinned(async () => {
        const existing = await this.getOwnedOptional(input);
        if (!existing.ok) return existing;
        if (existing.value === null) {
          return Object.freeze({ ok: true as const, value: { state: "missing" as const } });
        }
        await this.#readableFile(file);
        await rm(file);
        return Object.freeze({ ok: true as const, value: { state: "deleted" as const } });
      });
    } catch { return this.#objectFailure("owned conformance object delete failed"); }
  }

  async scanOwned(input: {
    readonly tenantId: string;
    readonly rsid: string;
    readonly purpose?: GatewayPrivateObjectBinding["purpose"];
    readonly afterKey: string | null;
    readonly limit: number;
  }): Promise<GatewayPortResult<readonly GatewayOwnedPrivateObjectMetadata[]>> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64 ||
        !/^[a-zA-Z0-9_-]+$/u.test(input.tenantId)) {
      return this.#objectFailure("owned conformance object inventory rejected");
    }
    try {
      await this.#open();
      await this.#assertPhysicalRootCurrent();
      const tenantRoot = path.join(this.#root, input.tenantId);
      let names: string[];
      try { names = await readdir(tenantRoot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return Object.freeze({ ok: true as const, value: Object.freeze([]) });
        }
        throw error;
      }
      const rows: GatewayOwnedPrivateObjectMetadata[] = [];
      for (const name of names.sort()) {
        const storageKey = `sha256:${name}`;
        if (!/^sha256:[0-9a-f]{64}$/u.test(storageKey) ||
            (input.afterKey !== null && storageKey <= input.afterKey)) continue;
        const value = await this.#readContainer(input.tenantId, storageKey);
        if (value?.owner === null || value?.owner === undefined) continue;
        if (value.owner.rsid !== input.rsid ||
            (input.purpose !== undefined && value.owner.purpose !== input.purpose)) continue;
        rows.push(Object.freeze({ ...value.owner }));
        if (rows.length === input.limit) break;
      }
      return Object.freeze({ ok: true as const, value: Object.freeze(rows) });
    } catch { return this.#objectFailure("owned conformance object inventory unavailable"); }
  }
}

/**
 * Isolated C39-only conformance backing store.  C39 object keys are opaque
 * AAD-bound identifiers, so encrypted envelopes cannot satisfy the ordinary
 * content-addressed store's `key === sha256(bytes)` invariant.  This adapter
 * deliberately keeps the same filesystem confinement while making each
 * opaque key write-once and byte-idempotent.
 */
export class ProtectedConformanceObjectStore implements ObjectStorePort {
  readonly kind = "conformance" as const;
  readonly #root: string;
  #physicalRoot: string | null = null;
  #ready: Promise<void> | null = null;

  public constructor(root: string) {
    this.#root = path.resolve(root, "protected-objects");
  }

  #file(tenantId: string, storageKey: string): string | null {
    if (!/^[a-zA-Z0-9_-]+$/u.test(tenantId) || !/^sha256:[0-9a-f]{64}$/u.test(storageKey)) return null;
    return path.join(this.#root, tenantId, storageKey.slice(7));
  }

  async #assertNoLinkComponent(candidate: string): Promise<void> {
    const parsed = path.parse(candidate);
    let current = parsed.root;
    for (const part of path.relative(parsed.root, candidate).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error("protected conformance path contains a link");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  async #assertContained(candidate: string): Promise<void> {
    const root = await this.#assertPhysicalRootCurrent();
    const resolved = await realpath(candidate);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("protected conformance object escaped root");
  }

  async #assertPhysicalRootCurrent(): Promise<string> {
    if (this.#physicalRoot === null) throw new Error("protected conformance root is not opened");
    const current = await realpath(this.#root);
    const normalize = (value: string): string => process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
    if (normalize(current) !== normalize(this.#physicalRoot) ||
        (await lstat(this.#root)).isSymbolicLink()) {
      throw new Error("protected conformance physical root changed");
    }
    return this.#physicalRoot;
  }

  async #withDeleteRootPinned<T>(action: () => Promise<T>): Promise<T> {
    await this.#open();
    const pin = await open(path.join(this.#root, ".protected-conformance-owner-v1"), "r+");
    try {
      await this.#assertPhysicalRootCurrent();
      return await action();
    } finally {
      await pin.close();
    }
  }

  async #open(): Promise<void> {
    if (this.#ready !== null) return this.#ready;
    this.#ready = (async () => {
      await this.#assertNoLinkComponent(path.dirname(this.#root));
      await mkdir(path.dirname(this.#root), { recursive: true });
      const marker = path.join(this.#root, ".protected-conformance-owner-v1");
      try {
        await mkdir(this.#root, { recursive: false, mode: 0o700 });
        await this.#writeAtomic(marker, Buffer.from("revagent-protected-conformance-owner/v1", "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await lstat(this.#root)).isSymbolicLink()) throw new Error("protected conformance root is a link");
        if ((await readFile(marker, "utf8")) !== "revagent-protected-conformance-owner/v1") throw new Error("protected conformance root is unowned");
      }
      this.#physicalRoot = await realpath(this.#root);
      await this.#assertPhysicalRootCurrent();
    })();
    return this.#ready;
  }

  async #ensureTenant(tenantId: string): Promise<void> {
    await this.#open();
    await this.#assertPhysicalRootCurrent();
    const tenant = path.join(this.#root, tenantId);
    try { await mkdir(tenant, { recursive: false, mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if ((await lstat(tenant)).isSymbolicLink()) throw new Error("protected conformance tenant directory is a link");
    await this.#assertContained(tenant);
  }

  async #readableFile(file: string): Promise<void> {
    if ((await lstat(file)).isSymbolicLink()) throw new Error("protected conformance object is a link");
    await this.#assertContained(file);
  }

  async #writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    await rename(temporary, file);
  }

  async #writeExclusive(file: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (this.#physicalRoot !== null) await this.#assertPhysicalRootCurrent();
      await link(temporary, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #readContainer(
    tenantId: string,
    storageKey: string,
  ): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null> {
    const file = this.#file(tenantId, storageKey);
    if (file === null) return null;
    try {
      await this.#open();
      await this.#readableFile(file);
      const container = await readFile(file);
      if (container.subarray(0, 5).toString("utf8") !== "RACP1") return null;
      const headerLength = container.readUInt32BE(5);
      const header = JSON.parse(container.subarray(9, 9 + headerLength).toString("utf8")) as {
        readonly v: number;
        readonly key: string;
        readonly length: number;
        readonly contentType: string;
      };
      const bytes = container.subarray(9 + headerLength);
      if (
        header.v !== 1 || header.key !== storageKey || header.length !== bytes.byteLength ||
        header.contentType !== "application/vnd.revagent.c39.protected-object"
      ) return null;
      return Object.freeze({ bytes, contentType: header.contentType });
    } catch {
      return null;
    }
  }

  async put(input: {
    readonly tenantId: string;
    readonly storageKey: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }): Promise<GatewayPortResult<{ readonly storageKey: string }>> {
    const file = this.#file(input.tenantId, input.storageKey);
    if (file === null || input.contentType !== "application/vnd.revagent.c39.protected-object") {
      return failure("protected conformance object rejected") as GatewayPortResult<{ readonly storageKey: string }>;
    }
    try {
      await this.#ensureTenant(input.tenantId);
      const header = Buffer.from(JSON.stringify({ v: 1, key: input.storageKey, length: input.bytes.byteLength, contentType: input.contentType }), "utf8");
      const container = Buffer.concat([Buffer.from("RACP1"), Buffer.from(Uint32Array.of(header.byteLength).buffer).swap32(), header, input.bytes]);
      if (await this.#writeExclusive(file, container)) {
        return Object.freeze({ ok: true as const, value: { storageKey: input.storageKey } });
      }
      const prior = await this.#readContainer(input.tenantId, input.storageKey);
      if (prior === null || prior.contentType !== input.contentType || !Buffer.from(prior.bytes).equals(input.bytes)) {
        return failure("protected conformance object write refused") as GatewayPortResult<{ readonly storageKey: string }>;
      }
      return Object.freeze({ ok: true as const, value: { storageKey: input.storageKey } });
    } catch {
      return failure("protected conformance object write refused") as GatewayPortResult<{ readonly storageKey: string }>;
    }
  }

  async get(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>> {
    const value = await this.#readContainer(input.tenantId, input.storageKey);
    return value === null
      ? failure("protected conformance object unavailable") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>
      : Object.freeze({ ok: true as const, value });
  }

  async getOptional(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>> {
    const file = this.#file(input.tenantId, input.storageKey);
    if (file === null) return failure("protected conformance object unavailable") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
    try {
      await this.#open();
      await this.#readableFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ ok: true as const, value: null });
      return failure("protected conformance object unavailable") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
    }
    const value = await this.#readContainer(input.tenantId, input.storageKey);
    return value === null
      ? failure("protected conformance object unavailable") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string } | null>
      : Object.freeze({ ok: true as const, value });
  }

  async head(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly byteSize: number }>> {
    const result = await this.get(input);
    return result.ok
      ? Object.freeze({ ok: true as const, value: { byteSize: result.value.bytes.byteLength } })
      : result as GatewayPortResult<{ readonly byteSize: number }>;
  }

  async delete(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<void>> {
    const file = this.#file(input.tenantId, input.storageKey);
    if (file === null) return failure("protected conformance object unavailable") as GatewayPortResult<void>;
    try {
      await this.#withDeleteRootPinned(async () => {
        await this.#readableFile(file);
        await rm(file);
      });
      return Object.freeze({ ok: true as const, value: undefined });
    } catch {
      return failure("protected conformance object unavailable") as GatewayPortResult<void>;
    }
  }
}

export function createConformanceSupportingPorts(): { readonly entitlement: EntitlementPort; readonly events: GatewayEventSink; readonly guardrails: GuardrailPort } {
  const ok = <T>(value: T): GatewayPortResult<T> => Object.freeze({ ok: true as const, value });
  return Object.freeze({ entitlement: Object.freeze({ kind: "conformance" as const, async checkModuleEntitlement() { return ok(true); }, async checkToolEntitlement() { return ok(true); } }), events: Object.freeze({ kind: "conformance" as const, async emit() { return ok(undefined); }, async emitBatch() { return ok(undefined); }, async flush() { return ok(undefined); } }), guardrails: Object.freeze({ kind: "conformance" as const, async evaluate() { return Object.freeze({ ok: true as const }); } }) });
}
