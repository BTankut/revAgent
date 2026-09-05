import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "./migrate.js";
import { PostgresProtocolStore } from "./postgresProtocolStore.js";
import { GatewayServingOwnership } from "./gatewayServingOwnership.js";
import { GatewayBridgeSessionAuthority, GATEWAY_RBP_SESSION_NAMESPACE } from "./bridgeSession.js";
import { createUnavailableIdentityPort } from "./authContext.js";

const url = process.env.EU20_DATABASE_URL;
const suite = url === undefined ? describe.skip : describe.sequential;
suite("production PostgreSQL protocol store", () => {
  let admin: pg.Pool;
  let cluster: pg.Pool;
  const databaseName = `eu20_store_${randomBytes(8).toString("hex")}`;
  let runtime: pg.Pool;
  let runtimeUrl: string;
  let owner: GatewayServingOwnership;
  const a = randomUUID(), b = randomUUID();
  beforeAll(async () => {
    cluster = new pg.Pool({ connectionString: url });
    await cluster.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUri = new URL(url!);
    databaseUri.pathname = `/${databaseName}`;
    const password = randomBytes(32).toString("base64url");
    const applied = await migrateUp(databaseUri.href, { appPassword: password });
    expect(applied).toContain("010_eu20_protocol_store.sql");
    expect(await migrateUp(databaseUri.href, { appPassword: password })).toEqual([]);
    admin = new pg.Pool({ connectionString: databaseUri.href });
    await admin.query("INSERT INTO tenants(id,slug,name) VALUES($1,$2,'A'),($3,$4,'B')", [a,a,b,b]);
    const runtimeUri = new URL(databaseUri.href);
    runtimeUri.username = "revagent_runtime"; runtimeUri.password = password;
    runtimeUrl = runtimeUri.href;
    runtime = new pg.Pool({ connectionString: runtimeUrl });
    owner = new GatewayServingOwnership({ protocolStore: new PostgresProtocolStore(runtimeUrl), profile: "refuse_dispatch" });
    expect(await owner.open()).toMatchObject({ ok: true });
  }, 60_000);
  afterAll(async () => {
    await owner?.close();
    await runtime?.end();
    await admin?.end();
    if (cluster) { await cluster.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await cluster.end(); }
  });
  it("commits atomically, isolates equal keys across tenants and persists after restart", async () => {
    for (const tenantId of [a,b]) {
      expect(await owner.protocolStore.transact({ tenantId }, tx => {
        tx.stage({ namespace: "case", key: "same", value: { tenant: tenantId }, expect: { kind: "absent" } });
      })).toMatchObject({ ok: true });
    }
    await owner.close();
    owner = new GatewayServingOwnership({ protocolStore: new PostgresProtocolStore(runtimeUrl), profile: "refuse_dispatch" });
    expect(await owner.open()).toMatchObject({ ok: true });
    for (const tenantId of [a,b]) {
      const result = await owner.protocolStore.transact({ tenantId }, tx => tx.read("case", "same"));
      expect(result).toMatchObject({ ok: true, value: { tenantId, version: 1, value: { tenant: tenantId } } });
    }
  });
  it("enforces RLS with the actual runtime role, independently of caller filters", async () => {
    const client = await runtime.connect();
    try {
      await client.query("BEGIN"); await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [a]);
      expect((await client.query("SELECT tenant_id FROM protocol_records")).rows).toEqual([{ tenant_id: a }]);
      await expect(client.query("INSERT INTO protocol_records VALUES($1,'x','x','{}',1,1)", [b])).rejects.toMatchObject({ code: "42501" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("does not commit earlier staged writes after a later CAS conflict", async () => {
    const result = await owner.protocolStore.transact({ tenantId: a }, tx => {
      tx.stage({ namespace: "case", key: "rolled-back", value: { value: 1 }, expect: { kind: "absent" } });
      tx.stage({ namespace: "case", key: "same", value: {}, expect: { kind: "version", version: 999 } });
    });
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(await owner.protocolStore.transact({ tenantId: a }, tx => tx.read("case", "rolled-back"))).toEqual({ ok: true, value: null });
  });
  it("serializes concurrent absent-key claims with one winner", async () => {
    const results = await Promise.all([1,2].map(value => owner.protocolStore.transact({ tenantId: a }, tx => {
      tx.stage({ namespace: "case", key: "raced", value: { value }, expect: { kind: "absent" } });
    })));
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual([expect.objectContaining({ code: "conflict" })]);
  });
  it("refuses a second serving owner and a superuser runtime", async () => {
    const rival = new GatewayServingOwnership({ protocolStore: new PostgresProtocolStore(runtimeUrl), profile: "refuse_dispatch" });
    expect(await rival.open()).toMatchObject({ ok: false });
    await rival.close();
    const unsafe = new PostgresProtocolStore(url!);
    expect(await unsafe.open()).toMatchObject({ ok: false });
    await unsafe.close();
  });
  it("bounds startup inventory and preserves both tenant identifiers", async () => {
    expect(await owner.protocolStore.startupCoordinator.listTenantIds(10)).toEqual({ ok: true, value: [a,b].sort() });
    expect(await owner.protocolStore.startupCoordinator.listKeys(a,"case",10)).toEqual({ ok: true, value: ["raced","same"] });
    expect(await owner.protocolStore.startupCoordinator.listTenantIds(0)).toMatchObject({ ok: false });
  });
  it("returns complete inventory at the exact limit and refuses limit-plus-one rows", async () => {
    expect(await owner.protocolStore.startupCoordinator.listTenantIds(2)).toEqual({ ok: true, value: [a,b].sort() });
    expect(await owner.protocolStore.startupCoordinator.listTenantIds(1)).toMatchObject({ ok: false, code: "invalid_record" });
    expect(await owner.protocolStore.startupCoordinator.listKeys(a,"case",2)).toEqual({ ok: true, value: ["raced","same"] });
    expect(await owner.protocolStore.startupCoordinator.listKeys(a,"case",1)).toMatchObject({ ok: false, code: "invalid_record" });
    expect(await owner.protocolStore.startupCoordinator.listTenantIds(10_001)).toMatchObject({ ok: false, code: "invalid_record" });
  });
  it("rejects non-JSON values without silently converting or committing them", async () => {
    expect(await owner.protocolStore.transact({ tenantId: a }, tx => {
      tx.stage({ namespace: "case", key: "invalid", value: { value: Number.NaN }, expect: { kind: "absent" } });
    })).toMatchObject({ ok: false, code: "invalid_record" });
    expect(await owner.protocolStore.transact({ tenantId: a }, tx => tx.read("case", "invalid"))).toEqual({ ok: true, value: null });
  });
  it("refuses actual Bridge startup readiness when a session inventory overflows", async () => {
    await owner.close();
    await admin.query("INSERT INTO protocol_records(tenant_id,namespace,key,value_json,version,updated_at_ms) SELECT $1,$2,'overflow-'||i,'{}',1,1 FROM generate_series(1,10001) i", [a, GATEWAY_RBP_SESSION_NAMESPACE]);
    owner = new GatewayServingOwnership({ protocolStore: new PostgresProtocolStore(runtimeUrl), profile: "refuse_dispatch" });
    // No authentication is attempted; the real startup inventory must refuse
    // before malformed sentinel rows can be imported or readiness published.
    const authority = new GatewayBridgeSessionAuthority(owner.protocolStore, createUnavailableIdentityPort(), { servingOwnership: owner });
    await expect(authority.open()).rejects.toMatchObject({ message: "protocol key inventory exceeds requested limit" });
    expect(authority.lifecycle().state).not.toBe("open");
    await authority.close();
  });
});
