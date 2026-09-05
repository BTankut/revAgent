import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import type { GatewayJsonValue } from "./dispatch.js";
import type {
  GatewayProtocolStore, GatewayStartupCoordinator, GatewayStartupLease,
  StoredRecord, StoreOutcome, StoreTransaction,
} from "./store.js";

const ok = <T>(value: T): StoreOutcome<T> => ({ ok: true, value });
const fail = <T>(code: "unavailable" | "invalid_record" | "conflict" | "durability_uncertain", message: string): StoreOutcome<T> => ({ ok: false, code, message });
const identifier = (value: string): boolean => typeof value === "string" && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 512 && !value.includes("\0");
const uuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const LEASE_MS = 15_000;
class InvalidRecord extends Error {}
function validJson(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const result = Object.values(value).every(item => validJson(item, ancestors, depth + 1));
  ancestors.delete(value);
  return result;
}
interface Row { tenant_id: string; namespace: string; key: string; value_json: GatewayJsonValue; version: string; updated_at_ms: string }
function record<T extends GatewayJsonValue>(row: Row): StoredRecord<T> {
  const version = Number(row.version), updatedAtMs = Number(row.updated_at_ms);
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(updatedAtMs)) throw new Error("invalid stored record");
  return { tenantId: row.tenant_id, namespace: row.namespace, key: row.key, value: row.value_json as T, version, updatedAtMs };
}

/** PostgreSQL implementation of the existing protocol-store contract.
 * Tenant transactions lock the serving-fence row until commit: a new owner
 * cannot take over while an old owner's transaction is still committing.
 */
export class PostgresProtocolStore implements GatewayProtocolStore {
  readonly kind = "postgres" as const;
  readonly contractVersion = "revagent.protocol-store/v1" as const;
  readonly #pool: pg.Pool;
  #opened = false;
  #ownerToken: string | null = null;
  #leaseDeadline = 0;
  #epoch = 0;
  readonly startupCoordinator: GatewayStartupCoordinator;

  constructor(databaseUrl: string) {
    this.#pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5_000 });
    this.#pool.on("error", () => { this.#leaseDeadline = 0; });
    this.startupCoordinator = Object.freeze({
      contractVersion: "revagent.protocol-store-startup/v1" as const,
      runExclusive: <T>(work: (lease: GatewayStartupLease) => Promise<StoreOutcome<T>>) => this.#exclusive(work),
      listTenantIds: async (limit: number) => this.#inventoryTenants(limit),
      listKeys: async (tenantId: string, namespace: string, limit: number) => this.#inventoryKeys(tenantId, namespace, limit),
    });
  }

  async open(): Promise<StoreOutcome<void>> {
    if (this.#opened) return ok(undefined);
    try {
      const client = await this.#pool.connect();
      try {
        // A configured superuser would silently defeat RLS even with SET ROLE.
        const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
        if (role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false) return fail("unavailable", "protocol store requires a restricted runtime role");
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE revagent_app");
        await client.query("SELECT id FROM protocol_serving_owner WHERE id=1");
        await client.query("SELECT tenant_id FROM protocol_records LIMIT 0");
        await client.query("COMMIT");
        this.#opened = true;
        return ok(undefined);
      } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
    } catch { return fail("unavailable", "protocol store schema or runtime role unavailable"); }
  }

  async close(): Promise<StoreOutcome<void>> {
    this.#opened = false;
    this.#leaseDeadline = 0;
    try { await this.#pool.end(); return ok(undefined); }
    catch { return fail("unavailable", "protocol store close failed"); }
  }

  async #client(tenantId?: string): Promise<PoolClient> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
      if (tenantId !== undefined) await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      return client;
    } catch (error) { client.release(true); throw error; }
  }

  #current(): boolean { return this.#opened && this.#ownerToken !== null && performance.now() < this.#leaseDeadline; }

  async #exclusive<T>(work: (lease: GatewayStartupLease) => Promise<StoreOutcome<T>>): Promise<StoreOutcome<T>> {
    if (!this.#opened || this.#ownerToken !== null) return fail("unavailable", "protocol serving owner unavailable");
    const token = randomUUID();
    let client: PoolClient | undefined;
    try {
      client = await this.#client();
      const started = performance.now();
      const acquired = await client.query<{ epoch: string }>(
        "UPDATE protocol_serving_owner SET owner_token=$1,epoch=epoch+1,expires_at=clock_timestamp()+interval '15 seconds' WHERE id=1 AND (owner_token IS NULL OR expires_at<=clock_timestamp()) RETURNING epoch", [token]);
      await client.query("COMMIT");
      if (acquired.rowCount !== 1) return fail("unavailable", "protocol serving owner busy");
      this.#ownerToken = token;
      this.#epoch = Number(acquired.rows[0]!.epoch);
      this.#leaseDeadline = started + LEASE_MS;
    } catch { return fail("unavailable", "protocol serving owner acquisition failed"); }
    finally { if (client) { await client.query("ROLLBACK").catch(() => {}); client.release(); } }

    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || !this.#current()) return;
      renewing = true;
      void this.#renew(token).finally(() => { renewing = false; });
    }, 2_000);
    timer.unref();
    const lease: GatewayStartupLease = Object.freeze({
      contractVersion: "revagent.protocol-store-startup-lease/v1" as const,
      identity: token, epoch: this.#epoch,
      isCurrent: () => this.#ownerToken === token && this.#current(),
    });
    try {
      const result = await work(lease);
      return lease.isCurrent() ? result : fail("unavailable", "protocol serving owner lost");
    } finally {
      clearInterval(timer);
      this.#leaseDeadline = 0;
      this.#ownerToken = null;
      let releaseClient: PoolClient | undefined;
      try {
        releaseClient = await this.#client();
        await releaseClient.query("UPDATE protocol_serving_owner SET owner_token=NULL,expires_at='-infinity' WHERE id=1 AND owner_token=$1", [token]);
        await releaseClient.query("COMMIT");
      } catch { /* Expiry fences an owner whose release could not reach Postgres. */ }
      finally { if (releaseClient) { await releaseClient.query("ROLLBACK").catch(() => {}); releaseClient.release(); } }
    }
  }

  async #renew(token: string): Promise<void> {
    let client: PoolClient | undefined;
    const started = performance.now();
    try {
      client = await this.#client();
      const renewed = await client.query("UPDATE protocol_serving_owner SET expires_at=clock_timestamp()+interval '15 seconds' WHERE id=1 AND owner_token=$1 AND expires_at>clock_timestamp()", [token]);
      await client.query("COMMIT");
      if (renewed.rowCount !== 1) this.#leaseDeadline = 0;
      else if (this.#ownerToken === token && this.#current()) this.#leaseDeadline = started + LEASE_MS;
    } catch { this.#leaseDeadline = 0; }
    finally { if (client) { await client.query("ROLLBACK").catch(() => {}); client.release(); } }
  }

  async #fence(client: PoolClient): Promise<void> {
    if (!this.#current()) throw new Error("serving owner unavailable");
    const fence = await client.query("SELECT id FROM protocol_serving_owner WHERE id=1 AND owner_token=$1 AND epoch=$2 AND expires_at>clock_timestamp() FOR SHARE", [this.#ownerToken, this.#epoch]);
    if (fence.rowCount !== 1) { this.#leaseDeadline = 0; throw new Error("serving owner lost"); }
  }

  async #inventoryTenants(limit: number): Promise<StoreOutcome<readonly string[]>> {
    // The SQL function caps at 10,001, reserving one row to detect overflow.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) return fail("invalid_record", "invalid inventory bound");
    let client: PoolClient | undefined;
    try {
      client = await this.#client();
      await this.#fence(client);
      const rows = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM protocol_inventory_tenants($1)", [limit + 1]);
      await client.query("COMMIT");
      if (rows.rows.length > limit) return fail("invalid_record", "protocol tenant inventory exceeds requested limit");
      return ok(rows.rows.map(row => row.tenant_id));
    } catch { if (client) await client.query("ROLLBACK").catch(() => {}); return fail("unavailable", "protocol tenant inventory unavailable"); }
    finally { client?.release(); }
  }

  async #inventoryKeys(tenantId: string, namespace: string, limit: number): Promise<StoreOutcome<readonly string[]>> {
    if (!uuid(tenantId) || !identifier(namespace) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100_001) return fail("invalid_record", "invalid inventory scope");
    let client: PoolClient | undefined;
    try {
      client = await this.#client(tenantId);
      await this.#fence(client);
      const rows = await client.query<{ key: string }>("SELECT key FROM protocol_records WHERE namespace=$1 ORDER BY key LIMIT $2", [namespace, limit + 1]);
      await client.query("COMMIT");
      if (rows.rows.length > limit) return fail("invalid_record", "protocol key inventory exceeds requested limit");
      return ok(rows.rows.map(row => row.key));
    } catch { if (client) await client.query("ROLLBACK").catch(() => {}); return fail("unavailable", "protocol key inventory unavailable"); }
    finally { client?.release(); }
  }

  async transact<T>(scope: { readonly tenantId: string }, work: (tx: StoreTransaction) => Promise<T> | T): Promise<StoreOutcome<T>> {
    if (!uuid(scope.tenantId)) return fail("invalid_record", "invalid tenant scope");
    let client: PoolClient | undefined;
    let committing = false;
    try {
      client = await this.#client(scope.tenantId);
      await this.#fence(client);
      // Serialize tenant-local read/modify/stage work, including absent-key CAS.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope.tenantId]);
      const db = client;
      const staged: Parameters<StoreTransaction["stage"]>[0][] = [];
      const targets = new Set<string>();
      const tx: StoreTransaction = {
        read: async <V extends GatewayJsonValue>(namespace: string, key: string) => {
          if (!identifier(namespace) || !identifier(key)) throw new InvalidRecord("invalid record key");
          const rows = await db.query<Row>("SELECT * FROM protocol_records WHERE namespace=$1 AND key=$2", [namespace, key]);
          return rows.rows[0] === undefined ? null : record<V>(rows.rows[0]);
        },
        list: async (namespace: string) => {
          if (!identifier(namespace)) throw new InvalidRecord("invalid namespace");
          const rows = await db.query<Row>("SELECT * FROM protocol_records WHERE namespace=$1 ORDER BY key LIMIT 10001", [namespace]);
          if (rows.rows.length > 10_000) throw new Error("namespace inventory exceeds bound");
          return rows.rows.map(row => record(row));
        },
        stage: write => {
          const target = `${write.namespace}\0${write.key}`;
          if (!identifier(write.namespace) || !identifier(write.key) || targets.has(target) || staged.length >= 128) throw new InvalidRecord("invalid staged write");
          if (!["absent", "version", "any"].includes(write.expect.kind) || (write.expect.kind === "version" && (!Number.isSafeInteger(write.expect.version) || write.expect.version < 1))) throw new InvalidRecord("invalid expectation");
          if (!validJson(write.value)) throw new InvalidRecord("invalid staged value");
          const serialized = JSON.stringify(write.value);
          if (serialized === undefined || Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new InvalidRecord("invalid staged value");
          targets.add(target);
          staged.push({ ...write, value: JSON.parse(serialized) as GatewayJsonValue | null, expect: { ...write.expect } });
        },
      };
      const result = await work(tx);
      for (const write of staged) {
        const previous = await tx.read(write.namespace, write.key);
        if ((write.expect.kind === "absent" && previous !== null) || (write.expect.kind === "version" && previous?.version !== write.expect.version)) {
          await client.query("ROLLBACK");
          return fail("conflict", "protocol record version conflict");
        }
        if (write.value === null) await client.query("DELETE FROM protocol_records WHERE namespace=$1 AND key=$2", [write.namespace, write.key]);
        else await client.query("INSERT INTO protocol_records(tenant_id,namespace,key,value_json,version,updated_at_ms) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,namespace,key) DO UPDATE SET value_json=EXCLUDED.value_json,version=EXCLUDED.version,updated_at_ms=EXCLUDED.updated_at_ms", [scope.tenantId, write.namespace, write.key, JSON.stringify(write.value), (previous?.version ?? 0) + 1, Date.now()]);
      }
      await this.#fence(client);
      committing = true;
      await client.query("COMMIT");
      return ok(result);
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      if (committing) return fail("durability_uncertain", "protocol transaction commit outcome uncertain");
      if (error instanceof InvalidRecord) return fail("invalid_record", "protocol record rejected");
      const code = (error as { code?: string }).code;
      return fail(code === "40001" || code === "40P01" ? "conflict" : "unavailable", "protocol transaction refused");
    } finally { client?.release(); }
  }
}
