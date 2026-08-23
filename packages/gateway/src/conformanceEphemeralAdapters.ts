import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile, lstat, realpath } from "node:fs/promises";
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
import type { GatewayEventEnvelope, GatewayEventSink } from "./events.js";
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

const CONTRACT = "revagent.conformance-ephemeral/v1" as const;
const failure = <T>(message: string): GatewayPortResult<T> => Object.freeze({
  ok: false as const, port: "identity" as const, code: "unavailable" as const, message,
});
const storeFailure = <T>(code: "conflict" | "invalid_record" | "unavailable", message: string): StoreOutcome<T> =>
  Object.freeze({ ok: false as const, code, message });
const storeSuccess = <T>(value: T): StoreOutcome<T> => Object.freeze({ ok: true as const, value });

export interface ConformanceCredential {
  readonly tenantId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly revoked?: boolean;
}

/** HMAC-backed loopback credential authority.  It is intentionally public-test only. */
export class ConformanceCredentialAuthority implements IdentityPort {
  readonly kind = "conformance" as const;
  readonly #secret: Buffer;
  readonly #credentials = new Map<string, ConformanceCredential>();
  readonly #audit: Array<{ readonly action: "issued" | "revoked" | "authenticated"; readonly deviceId: string }> = [];
  public constructor(credentials: readonly ConformanceCredential[], secret = randomBytes(32)) {
    this.#secret = Buffer.from(secret);
    for (const credential of credentials) this.#credentials.set(credential.deviceId, Object.freeze({ ...credential }));
  }
  public issue(deviceId: string): string {
    const credential = this.#credentials.get(deviceId);
    if (credential === undefined) throw new Error("unknown conformance device");
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
    const context: DeviceAuthContext = {
      contractVersion: GATEWAY_AUTH_CONTRACT_VERSION, actor: { type: "device", tenantId: credential.tenantId, userId: credential.userId, deviceId, seatId: `seat-${deviceId}` }, connectionId: input.connectionId, deviceStatus: "active", machineFingerprint: input.machineFingerprint as `sha256:${string}`,
      authorizationVersion: 1, identityRecordVersion: 1, connectionCapabilityVersion: 1, sessionCapabilityVersion: 1, seatAuthorityVersion: 1, seatRecordVersion: 1,
      grantedConnectionCapabilities: ["journal_v1", "transport_streamable_http"], grantedSessionCapabilities: ["batch_atomic", "doc_context_cached_v1"], deviceTokenDigest: `sha256:${createHash("sha256").update(rawToken!).digest("hex")}`,
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
  public readonly startupCoordinator: GatewayStartupCoordinator;
  public constructor(root: string) {
    this.#file = path.join(root, "sqlite.db");
    this.startupCoordinator = Object.freeze({ contractVersion: "revagent.protocol-store-startup/v1" as const,
      runExclusive: async <T>(work: () => Promise<StoreOutcome<T>>) => this.#withLock(work),
      listTenantIds: async (limit: number) => this.#inventoryTenants(limit),
      listKeys: async (tenantId: string, namespace: string, limit: number) => this.#inventoryKeys(tenantId, namespace, limit),
    });
  }
  async #withLock<T>(work: () => Promise<StoreOutcome<T>>): Promise<StoreOutcome<T>> { const previous = this.#exclusive; let release!: () => void; this.#exclusive = new Promise<void>((resolve) => { release = resolve; }); await previous; try { return await work(); } finally { release(); } }
  #db(): Database.Database { if (!this.#opened || this.#database === null) throw new Error("closed"); return this.#database; }
  async open(): Promise<StoreOutcome<void>> { try { await mkdir(path.dirname(this.#file), { recursive: true }); const database = new Database(this.#file, { timeout: 5_000 }); database.pragma("journal_mode = WAL"); database.pragma("synchronous = FULL"); database.pragma("foreign_keys = ON"); database.pragma("fullfsync = ON"); database.exec("CREATE TABLE IF NOT EXISTS conformance_records (tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), updated_at_ms INTEGER NOT NULL, PRIMARY KEY (tenant_id, namespace, key)); CREATE TABLE IF NOT EXISTS conformance_startup_lock (id INTEGER PRIMARY KEY CHECK(id = 1), generation INTEGER NOT NULL); INSERT OR IGNORE INTO conformance_startup_lock(id, generation) VALUES (1, 0);"); this.#database = database; this.#opened = true; return storeSuccess(undefined); } catch { return storeFailure("unavailable", "conformance SQLite store unavailable"); } }
  async close(): Promise<StoreOutcome<void>> { try { this.#database?.close(); this.#database = null; this.#opened = false; return storeSuccess(undefined); } catch { return storeFailure("unavailable", "conformance SQLite close failed"); } }
  async #inventoryTenants(limit: number): Promise<StoreOutcome<readonly string[]>> { if (!Number.isSafeInteger(limit) || limit < 1) return storeFailure("invalid_record", "invalid inventory limit"); try { return storeSuccess(this.#db().prepare<unknown[], { tenant_id: string }>("SELECT DISTINCT tenant_id FROM conformance_records ORDER BY tenant_id LIMIT ?").all(limit).map((row) => row.tenant_id)); } catch { return storeFailure("unavailable", "conformance SQLite inventory unavailable"); } }
  async #inventoryKeys(tenantId: string, namespace: string, limit: number): Promise<StoreOutcome<readonly string[]>> { if (!Number.isSafeInteger(limit) || limit < 1) return storeFailure("invalid_record", "invalid inventory limit"); try { return storeSuccess(this.#db().prepare<unknown[], { key: string }>("SELECT key FROM conformance_records WHERE tenant_id = ? AND namespace = ? ORDER BY key LIMIT ?").all(tenantId, namespace, limit).map((row) => row.key)); } catch { return storeFailure("unavailable", "conformance SQLite inventory unavailable"); } }
  async transact<T>(scope: { readonly tenantId: string }, fn: (tx: StoreTransaction) => Promise<T> | T): Promise<StoreOutcome<T>> { return this.#withLock(async () => { if (!scope.tenantId) return storeFailure("invalid_record", "missing tenant scope"); let database: Database.Database; try { database = this.#db(); } catch { return storeFailure("unavailable", "conformance SQLite store is closed"); } const staged: Array<{ namespace: string; key: string; value: GatewayJsonValue | null; expect: StoreExpectation }> = []; const row = (namespace: string, key: string) => database.prepare<unknown[], SqliteRow>("SELECT tenant_id, namespace, key, value_json, version, updated_at_ms FROM conformance_records WHERE tenant_id = ? AND namespace = ? AND key = ?").get(scope.tenantId, namespace, key); const toRecord = <TRecord extends GatewayJsonValue>(value: SqliteRow | undefined): StoredRecord<TRecord> | null => value === undefined ? null : { namespace: value.namespace, tenantId: value.tenant_id, key: value.key, value: JSON.parse(value.value_json) as TRecord, version: value.version, updatedAtMs: value.updated_at_ms }; const tx: StoreTransaction = { read: async <TRecord extends GatewayJsonValue>(namespace: string, key: string) => toRecord<TRecord>(row(namespace, key)), list: async (namespace: string) => database.prepare<unknown[], SqliteRow>("SELECT tenant_id, namespace, key, value_json, version, updated_at_ms FROM conformance_records WHERE tenant_id = ? AND namespace = ? ORDER BY key").all(scope.tenantId, namespace).map((item) => toRecord(item)!), stage: (write) => staged.push({ ...write }) }; let result: T; try { result = await fn(tx); } catch { return storeFailure("invalid_record", "conformance transaction rejected"); } try { database.exec("BEGIN IMMEDIATE"); for (const write of staged) { const current = row(write.namespace, write.key); if ((write.expect.kind === "absent" && current !== undefined) || (write.expect.kind === "version" && (current === undefined || current.version !== write.expect.version))) { database.exec("ROLLBACK"); return storeFailure("conflict", "conformance SQLite compare-and-swap conflicted"); } if (write.value === null) database.prepare("DELETE FROM conformance_records WHERE tenant_id = ? AND namespace = ? AND key = ?").run(scope.tenantId, write.namespace, write.key); else { const nextVersion = (current?.version ?? 0) + 1; database.prepare("INSERT INTO conformance_records(tenant_id, namespace, key, value_json, version, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, namespace, key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version, updated_at_ms = excluded.updated_at_ms").run(scope.tenantId, write.namespace, write.key, JSON.stringify(write.value), nextVersion, Date.now()); } } database.exec("COMMIT"); return storeSuccess(result); } catch { try { if (database.inTransaction) database.exec("ROLLBACK"); } catch { /* preserve durable failure */ } return storeFailure("unavailable", "conformance SQLite durable commit failed"); } }); }
}

export class DigestFileConformanceObjectStore implements ObjectStorePort {
  readonly kind = "conformance" as const;
  readonly #root: string;
  readonly #ownedTenants = new Set<string>();
  public constructor(root: string) { this.#root = path.resolve(root, "objects"); }
  #file(tenantId: string, storageKey: string): string | null { if (!/^[a-zA-Z0-9_-]+$/u.test(tenantId) || !/^sha256:[0-9a-f]{64}$/u.test(storageKey)) return null; return path.join(this.#root, tenantId, storageKey.slice(7)); }
  async #assertNoLinkComponent(candidate: string): Promise<void> { const parsed = path.parse(candidate); let current = parsed.root; for (const part of path.relative(parsed.root, candidate).split(path.sep).filter(Boolean)) { current = path.join(current, part); try { const stat = await lstat(current); if (stat.isSymbolicLink()) throw new Error("conformance object path contains a link"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } } }
  async #assertContained(candidate: string): Promise<void> { const root = await realpath(this.#root); const resolved = await realpath(candidate); if (path.relative(root, resolved).startsWith("..") || path.isAbsolute(path.relative(root, resolved))) throw new Error("conformance object path escaped root"); }
  async #ensureTenant(tenantId: string): Promise<void> { await this.#assertNoLinkComponent(path.dirname(this.#root)); await mkdir(path.dirname(this.#root), { recursive: true }); try { await mkdir(this.#root, { recursive: false, mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } const rootStat = await lstat(this.#root); if (rootStat.isSymbolicLink()) throw new Error("conformance object root is a link"); const tenant = path.join(this.#root, tenantId); if (!this.#ownedTenants.has(tenantId)) { try { await mkdir(tenant, { recursive: false, mode: 0o700 }); this.#ownedTenants.add(tenantId); } catch { throw new Error("conformance tenant directory was pre-created"); } } const stat = await lstat(tenant); if (stat.isSymbolicLink()) throw new Error("conformance tenant directory is a link"); await this.#assertContained(tenant); }
  async #readableFile(file: string): Promise<void> { const stat = await lstat(file); if (stat.isSymbolicLink()) throw new Error("conformance object is a link"); await this.#assertContained(file); }
  async #writeAtomic(file: string, bytes: Uint8Array): Promise<void> { const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(12).toString("hex")}.tmp`); const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } await rename(temporary, file); }
  async put(input: { readonly tenantId: string; readonly storageKey: string; readonly bytes: Uint8Array; readonly contentType: string }): Promise<GatewayPortResult<{ readonly storageKey: string }>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null || `sha256:${createHash("sha256").update(input.bytes).digest("hex")}` !== input.storageKey || input.contentType.length === 0 || input.contentType.length > 256) return failure("conformance object digest rejected") as GatewayPortResult<{ readonly storageKey: string }>; try { await this.#ensureTenant(input.tenantId); await this.#writeAtomic(`${file}.content-type`, Buffer.from(input.contentType, "utf8")); await this.#writeAtomic(file, input.bytes); return Object.freeze({ ok: true as const, value: { storageKey: input.storageKey } }); } catch { return failure("conformance object write refused") as GatewayPortResult<{ readonly storageKey: string }>; } }
  async get(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null) return failure("conformance object key rejected") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>; try { await this.#readableFile(file); await this.#readableFile(`${file}.content-type`); const [bytes, contentType] = await Promise.all([readFile(file), readFile(`${file}.content-type`, "utf8")]); if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== input.storageKey || contentType.length === 0 || contentType.length > 256) throw new Error("digest or sidecar invalid"); return Object.freeze({ ok: true as const, value: { bytes, contentType } }); } catch { return failure("conformance object unavailable") as GatewayPortResult<{ readonly bytes: Uint8Array; readonly contentType: string }>; } }
  async head(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<{ readonly byteSize: number }>> { const result = await this.get(input); return result.ok ? Object.freeze({ ok: true as const, value: { byteSize: result.value.bytes.byteLength } }) : result as GatewayPortResult<{ readonly byteSize: number }>; }
  async delete(input: { readonly tenantId: string; readonly storageKey: string }): Promise<GatewayPortResult<void>> { const file = this.#file(input.tenantId, input.storageKey); if (file === null) return failure("conformance object key rejected") as GatewayPortResult<void>; try { await this.#readableFile(file); await this.#readableFile(`${file}.content-type`); await rm(file); await rm(`${file}.content-type`); return Object.freeze({ ok: true as const, value: undefined }); } catch { return failure("conformance object unavailable") as GatewayPortResult<void>; } }
}

export function createConformanceSupportingPorts(): { readonly entitlement: EntitlementPort; readonly events: GatewayEventSink; readonly guardrails: GuardrailPort } {
  const ok = <T>(value: T): GatewayPortResult<T> => Object.freeze({ ok: true as const, value });
  return Object.freeze({ entitlement: Object.freeze({ kind: "conformance" as const, async checkModuleEntitlement() { return ok(true); }, async checkToolEntitlement() { return ok(true); } }), events: Object.freeze({ kind: "conformance" as const, async emit(_event: GatewayEventEnvelope) { return ok(undefined); }, async emitBatch(_events: readonly GatewayEventEnvelope[]) { return ok(undefined); }, async flush() { return ok(undefined); } }), guardrails: Object.freeze({ kind: "conformance" as const, async evaluate() { return Object.freeze({ ok: true as const }); } }) });
}
