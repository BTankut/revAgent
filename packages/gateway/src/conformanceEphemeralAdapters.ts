import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm, lstat, realpath } from "node:fs/promises";
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
  GatewayProtocolStore,
  GatewayStartupCoordinator,
  ObjectStorePort,
  StoreExpectation,
  StoreOutcome,
  StoreTransaction,
  StoredRecord,
} from "./store.js";
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
    "transport_streamable_http",
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
  public readonly startupCoordinator: GatewayStartupCoordinator;
  public constructor(root: string, options: { readonly startupLeaseMs?: number; readonly startupRenewMs?: number } = {}) {
    this.#file = path.join(root, "sqlite.db");
    this.#startupLeaseMs = options.startupLeaseMs ?? STARTUP_LOCK_LEASE_MS;
    this.#startupRenewMs = options.startupRenewMs ?? Math.floor(STARTUP_LOCK_LEASE_MS / 4);
    if (!Number.isSafeInteger(this.#startupLeaseMs) || !Number.isSafeInteger(this.#startupRenewMs) || this.#startupLeaseMs < 30 || this.#startupRenewMs < 10 || this.#startupRenewMs >= this.#startupLeaseMs / 3) throw new RangeError("invalid conformance startup lease configuration");
    this.startupCoordinator = Object.freeze({ contractVersion: "revagent.protocol-store-startup/v1" as const,
      runExclusive: async <T>(work: () => Promise<StoreOutcome<T>>) => this.#runStartupExclusive(work),
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
  async #runStartupExclusive<T>(work: () => Promise<StoreOutcome<T>>): Promise<StoreOutcome<T>> { return this.#withLock(async () => { let database: Database.Database; try { database = this.#db(); } catch { return storeFailure("unavailable", "conformance SQLite store is closed"); } const token = randomBytes(24).toString("hex"); const deadline = Date.now() + STARTUP_LOCK_WAIT_MS; let version = -1; while (Date.now() < deadline && version < 0) { try { database.exec("BEGIN IMMEDIATE"); const lock = database.prepare<unknown[], { owner_token: string | null; lease_expires_at_ms: number; version: number }>("SELECT owner_token, lease_expires_at_ms, version FROM conformance_startup_lock WHERE id = 1").get(); if (lock !== undefined && (lock.owner_token === null || lock.lease_expires_at_ms <= Date.now())) { const result = database.prepare("UPDATE conformance_startup_lock SET owner_token = ?, lease_expires_at_ms = ?, version = ? WHERE id = 1 AND version = ?").run(token, Date.now() + this.#startupLeaseMs, lock.version + 1, lock.version); if (result.changes === 1) version = lock.version + 1; } database.exec("COMMIT"); } catch { try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { } } if (version < 0) await new Promise<void>((resolve) => setTimeout(resolve, 25)); } if (version < 0) return storeFailure("unavailable", "conformance startup lease timed out"); let lost = false; const renew = (): void => { try { database.exec("BEGIN IMMEDIATE"); const result = database.prepare("UPDATE conformance_startup_lock SET lease_expires_at_ms = ?, version = ? WHERE id = 1 AND owner_token = ? AND version = ?").run(Date.now() + this.#startupLeaseMs, version + 1, token, version); if (result.changes !== 1) lost = true; else version += 1; database.exec("COMMIT"); } catch { lost = true; try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { } } }; const timer = setInterval(renew, this.#startupRenewMs); try { const result = await work(); return lost ? storeFailure("unavailable", "conformance startup lease lost") : result; } finally { clearInterval(timer); try { database.exec("BEGIN IMMEDIATE"); const result = database.prepare("UPDATE conformance_startup_lock SET owner_token = NULL, lease_expires_at_ms = 0, version = version + 1 WHERE id = 1 AND owner_token = ? AND version = ?").run(token, version); if (result.changes !== 1) lost = true; database.exec("COMMIT"); } catch { try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { } } } }); }
  async transact<T>(scope: { readonly tenantId: string }, fn: (tx: StoreTransaction) => Promise<T> | T): Promise<StoreOutcome<T>> { return this.#withLock(async () => { if (!scope.tenantId) return storeFailure("invalid_record", "missing tenant scope"); let database: Database.Database; try { database = this.#db(); } catch { return storeFailure("unavailable", "conformance SQLite store is closed"); } const staged: Array<{ namespace: string; key: string; value: GatewayJsonValue | null; expect: StoreExpectation }> = []; const row = (namespace: string, key: string) => database.prepare<unknown[], SqliteRow>("SELECT tenant_id, namespace, key, value_json, version, updated_at_ms FROM conformance_records WHERE tenant_id = ? AND namespace = ? AND key = ?").get(scope.tenantId, namespace, key); const toRecord = <TRecord extends GatewayJsonValue>(value: SqliteRow | undefined): StoredRecord<TRecord> | null => value === undefined ? null : { namespace: value.namespace, tenantId: value.tenant_id, key: value.key, value: JSON.parse(value.value_json) as TRecord, version: value.version, updatedAtMs: value.updated_at_ms }; const tx: StoreTransaction = { read: async <TRecord extends GatewayJsonValue>(namespace: string, key: string) => toRecord<TRecord>(row(namespace, key)), list: async (namespace: string) => database.prepare<unknown[], SqliteRow>("SELECT tenant_id, namespace, key, value_json, version, updated_at_ms FROM conformance_records WHERE tenant_id = ? AND namespace = ? ORDER BY key").all(scope.tenantId, namespace).map((item) => toRecord(item)!), stage: (write) => staged.push({ ...write }) }; let result: T; try { result = await fn(tx); } catch { return storeFailure("invalid_record", "conformance transaction rejected"); } try { database.exec("BEGIN IMMEDIATE"); for (const write of staged) { const current = row(write.namespace, write.key); if ((write.expect.kind === "absent" && current !== undefined) || (write.expect.kind === "version" && (current === undefined || current.version !== write.expect.version))) { database.exec("ROLLBACK"); return storeFailure("conflict", "conformance SQLite compare-and-swap conflicted"); } if (write.value === null) database.prepare("DELETE FROM conformance_records WHERE tenant_id = ? AND namespace = ? AND key = ?").run(scope.tenantId, write.namespace, write.key); else { const nextVersion = (current?.version ?? 0) + 1; database.prepare("INSERT INTO conformance_records(tenant_id, namespace, key, value_json, version, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, namespace, key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version, updated_at_ms = excluded.updated_at_ms").run(scope.tenantId, write.namespace, write.key, JSON.stringify(write.value), nextVersion, Date.now()); } } database.exec("COMMIT"); return storeSuccess(result); } catch { try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { /* preserve durable failure */ } return storeFailure("unavailable", "conformance SQLite durable commit failed"); } }); }
}

export class DigestFileConformanceObjectStore implements ObjectStorePort {
  readonly kind = "conformance" as const;
  readonly #root: string;
  #ready: Promise<void> | null = null;
  public constructor(root: string) { this.#root = path.resolve(root, "objects"); }
  #file(tenantId: string, storageKey: string): string | null { if (!/^[a-zA-Z0-9_-]+$/u.test(tenantId) || !/^sha256:[0-9a-f]{64}$/u.test(storageKey)) return null; return path.join(this.#root, tenantId, storageKey.slice(7)); }
  async #assertNoLinkComponent(candidate: string): Promise<void> { const parsed = path.parse(candidate); let current = parsed.root; for (const part of path.relative(parsed.root, candidate).split(path.sep).filter(Boolean)) { current = path.join(current, part); try { const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error("conformance object path contains a link"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } } }
  async #assertContained(candidate: string): Promise<void> { const root = await realpath(this.#root); const resolved = await realpath(candidate); if (path.relative(root, resolved).startsWith("..") || path.isAbsolute(path.relative(root, resolved))) throw new Error("conformance object path escaped root"); }
  async #open(): Promise<void> { if (this.#ready !== null) return this.#ready; this.#ready = (async () => { await this.#assertNoLinkComponent(path.dirname(this.#root)); await mkdir(path.dirname(this.#root), { recursive: true }); const marker = path.join(this.#root, ".conformance-owner-v1"); try { await mkdir(this.#root, { recursive: false, mode: 0o700 }); await this.#writeAtomic(marker, Buffer.from("revagent-conformance-owner/v1", "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const rootStat = await lstat(this.#root); if (rootStat.isSymbolicLink()) throw new Error("conformance object root is a link"); if ((await readFile(marker, "utf8")) !== "revagent-conformance-owner/v1") throw new Error("conformance object root is unowned"); } })(); return this.#ready; }
  async #ensureTenant(tenantId: string): Promise<void> { await this.#open(); const tenant = path.join(this.#root, tenantId); try { await mkdir(tenant, { recursive: false, mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; const stat = await lstat(tenant); if (stat.isSymbolicLink()) throw new Error("conformance tenant directory is a link"); } const stat = await lstat(tenant); if (stat.isSymbolicLink()) throw new Error("conformance tenant directory is a link"); await this.#assertContained(tenant); }
  async #readableFile(file: string): Promise<void> { const stat = await lstat(file); if (stat.isSymbolicLink()) throw new Error("conformance object is a link"); await this.#assertContained(file); }
  async #writeAtomic(file: string, bytes: Uint8Array): Promise<void> { const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`); const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); }
  async put(input: { readonly tenantId: string; readonly storageKey: string; readonly bytes: Uint8Array; readonly contentType: string }): Promise<GatewayPortResult<{ readonly storageKey: string }>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null || `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` !== input.storageKey || input.contentType.length === 0 || input.contentType.length > 256) return failure("conformance object digest rejected") as GatewayPortResult<{ readonly storageKey: string }>; try { await this.#ensureTenant(input.tenantId); const header = Buffer.from(JSON.stringify({ v: 1, digest: input.storageKey, length: input.bytes.byteLength, contentType: input.contentType }), "utf8"); const container = Buffer.concat([Buffer.from("RACO1"), Buffer.from(Uint32Array.of(header.byteLength).buffer).swap32(), header, input.bytes]); await this.#writeAtomic(file, container); return Object.freeze({ ok: true as const, value: { storageKey: input.storageKey } }); } catch { return failure("conformance object write refused") as GatewayPortResult<{ readonly storageKey: string }>; } }
  async get(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null) return failure("conformance object key rejected") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>; try { await this.#open(); await this.#readableFile(file); const container = await readFile(file); if (container.subarray(0, 5).toString("utf8") !== "RACO1") throw new Error("container magic"); const headerLength = container.readUInt32BE(5); const header = JSON.parse(container.subarray(9, 9 + headerLength).toString("utf8")) as { v: number; digest: string; length: number; contentType: string }; const bytes = container.subarray(9 + headerLength); if (header.v !== 1 || header.digest !== input.storageKey || header.length !== bytes.byteLength || header.contentType.length === 0 || header.contentType.length > 256 || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== input.storageKey) throw new Error("container integrity"); return Object.freeze({ ok: true as const, value: { bytes, contentType: header.contentType } }); } catch { return failure("conformance object unavailable") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>; } }
  async head(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly byteSize: number }>> { const result = await this.get(input); return result.ok ? Object.freeze({ ok: true as const, value: { byteSize: result.value.bytes.byteLength } }) : result as GatewayPortResult<{ readonly byteSize: number }>; }
  async delete(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<void>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null) return failure("conformance object key rejected") as GatewayPortResult<void>; try { await this.#open(); await this.#readableFile(file); await rm(file); return Object.freeze({ ok: true as const, value: undefined }); } catch { return failure("conformance object unavailable") as GatewayPortResult<void>; } }
}

export function createConformanceSupportingPorts(): { readonly entitlement: EntitlementPort; readonly events: GatewayEventSink; readonly guardrails: GuardrailPort } {
  const ok = <T>(value: T): GatewayPortResult<T> => Object.freeze({ ok: true as const, value });
  return Object.freeze({ entitlement: Object.freeze({ kind: "conformance" as const, async checkModuleEntitlement() { return ok(true); }, async checkToolEntitlement() { return ok(true); } }), events: Object.freeze({ kind: "conformance" as const, async emit() { return ok(undefined); }, async emitBatch() { return ok(undefined); }, async flush() { return ok(undefined); } }), guardrails: Object.freeze({ kind: "conformance" as const, async evaluate() { return Object.freeze({ ok: true as const }); } }) });
}
