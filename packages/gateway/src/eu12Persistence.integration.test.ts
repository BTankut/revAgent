import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GatewayEventEnvelope } from "./events.js";
import { migrateUp } from "./migrate.js";
import { PostgresTenantStore } from "./postgresTenantStore.js";

const { Pool } = pg;
const DATABASE_URL = process.env.EU10_DATABASE_URL;
const suite = DATABASE_URL === undefined ? describe.skip : describe;

function envelope(input: {
  readonly eventId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly type: GatewayEventEnvelope["event_type"];
  readonly payload: GatewayEventEnvelope["payload"];
  readonly occurredAt?: string;
}): GatewayEventEnvelope {
  const occurredAt = input.occurredAt ?? "2026-09-02T08:00:00.000Z";
  return Object.freeze({
    schema: "revagent.event.v2",
    event_id: input.eventId,
    event_type: input.type,
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    tenant_id: input.tenantId,
    source: { component: "eu12-integration", version: "1", instance: "test" },
    actor: { type: "user" as const, user_id: input.userId },
    session_id: input.sessionId,
    seq: 1,
    payload: input.payload,
  });
}

suite("EU-12 Postgres event persistence", () => {
  let admin: pg.Pool;
  let runtime: pg.Pool;
  let store: PostgresTenantStore;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let sessionA: string;
  let sessionB: string;

  beforeAll(async () => {
    const appPassword = randomBytes(32).toString("base64url");
    await migrateUp(DATABASE_URL!, { appPassword });
    admin = new Pool({ connectionString: DATABASE_URL });
    tenantA = randomUUID(); tenantB = randomUUID();
    userA = randomUUID(); userB = randomUUID();
    sessionA = randomUUID(); sessionB = randomUUID();
    await admin.query("INSERT INTO tenants(id,slug,name) VALUES ($1,$2,'EU12 Tenant A'),($3,$4,'EU12 Tenant B')", [tenantA, `eu12-a-${tenantA}`, tenantB, `eu12-b-${tenantB}`]);
    await admin.query(
      `INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role)
       VALUES ($1,$2,'https://issuer.test','eu12-a','user'),($3,$4,'https://issuer.test','eu12-b','user')`,
      [userA, tenantA, userB, tenantB],
    );
    await admin.query(
      `INSERT INTO sessions(id,tenant_id,user_id,client_type)
       VALUES ($1,$2,$3,'mcp'),($4,$5,$6,'mcp')`,
      [sessionA, tenantA, userA, sessionB, tenantB, userB],
    );
    const runtimeUrl = new URL(DATABASE_URL!);
    runtimeUrl.username = "revagent_runtime";
    runtimeUrl.password = appPassword;
    runtime = new Pool({ connectionString: runtimeUrl.href });
    store = new PostgresTenantStore(runtimeUrl.href);
  }, 30_000);

  afterAll(async () => {
    await store?.close();
    await runtime?.end();
    await admin?.end();
  });

  it("routes tool and metering events through one RLS-bound durable envelope with idempotent redelivery", async () => {
    const toolPayload = {
      idempotency_key: "eu12-tool-replay",
      tool_name: "core.inspect",
      tool_version: "1.0.0",
      policy_class: "auto",
      executor: "bridge",
      params_digest: `sha256:${"a".repeat(64)}`,
      params_summary: { keys: [] },
      outcome: "completed",
      started_at_ms: 1_000,
      completed_at_ms: 1_001,
      duration_ms: 1,
      request_bytes: 10,
      response_bytes: 11,
    } as const;
    const first = envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: toolPayload });
    await expect(store.emit(first)).resolves.toEqual({ ok: true, value: undefined });
    const replay = envelope({
      eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA,
      type: "tool.invocation", payload: toolPayload, occurredAt: "2026-09-02T08:00:01.000Z",
    });
    await expect(store.emit(replay)).resolves.toEqual({ ok: true, value: undefined });
    const metering = envelope({
      eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA,
      type: "llm.call",
      payload: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, duration_ms: 3, cost: 0.1 },
    });
    await expect(store.emit(metering)).resolves.toEqual({ ok: true, value: undefined });
    const persisted = await admin.query(
      "SELECT event_type,idempotency_key FROM events WHERE tenant_id=$1 ORDER BY event_type",
      [tenantA],
    );
    expect(persisted.rows).toEqual([
      { event_type: "llm.call", idempotency_key: null },
      { event_type: "tool.invocation", idempotency_key: "eu12-tool-replay" },
    ]);
    await expect(admin.query("SELECT event_id FROM tool_invocations WHERE tenant_id=$1 AND idempotency_key='eu12-tool-replay'", [tenantA]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(admin.query("SELECT event_id FROM llm_calls WHERE tenant_id=$1", [tenantA]))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it("enforces two-tenant RLS negatives for events, result refs, and retention runs", async () => {
    await admin.query(
      `INSERT INTO result_refs(id,tenant_id,session_id,storage_key,content_digest,byte_size,page_size_bytes,page_count,summary,expires_at)
       VALUES ($1,$2,$3,'tenants/a/results/ref.json.zst',$4,1,1,1,'{}',clock_timestamp()),
              ($5,$6,$7,'tenants/b/results/ref.json.zst',$4,1,1,1,'{}',clock_timestamp())`,
      [randomUUID(), tenantA, sessionA, "b".repeat(64), randomUUID(), tenantB, sessionB],
    );
    await admin.query(
      `INSERT INTO retention_runs(tenant_id,archive_month,state,archive_key,archive_digest,event_count)
       VALUES ($1,'2026-08-01','prepared','archive/a/events/2026-08.ndjson.zst',$3,0),
              ($2,'2026-08-01','prepared','archive/b/events/2026-08.ndjson.zst',$3,0)`,
      [tenantA, tenantB, "c".repeat(64)],
    );
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      for (const relation of ["events", "result_refs", "retention_runs"] as const) {
        await expect(client.query(`SELECT tenant_id FROM ${relation} WHERE tenant_id=$1`, [tenantB]))
          .resolves.toMatchObject({ rowCount: 0 });
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
