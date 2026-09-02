import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GatewayEventEnvelope } from "./events.js";
import { migrateUp } from "./migrate.js";
import { PostgresEu12DataStore } from "./postgresEu12DataStore.js";
import { PostgresTenantStore } from "./postgresTenantStore.js";
import { InMemoryResultObjectStore, resultReferenceDigest } from "./resultReferenceStore.js";

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
  let appPassword: string;
  let runtimeDatabaseUrl: string;

  beforeAll(async () => {
    appPassword = randomBytes(32).toString("base64url");
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
    runtimeDatabaseUrl = runtimeUrl.href;
    runtime = new Pool({ connectionString: runtimeDatabaseUrl });
    store = new PostgresTenantStore(runtimeDatabaseUrl);
  }, 30_000);

  afterAll(async () => {
    await store?.close();
    await runtime?.end();
    await admin?.end();
  });

  it("routes tool and metering events through one RLS-bound durable envelope with idempotent redelivery", async () => {
    const toolPayload = {
      dispatch_attempt_id: "eu12-dispatch-attempt",
      invocation_id: "eu12-invocation",
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
      payload: {
        idempotency_key: "eu12-metering", upstream_name: "external-client", model_name: "observed-model",
        engine_mode: "external_client", role: "external_client", input_tokens: 1, output_tokens: 2,
        cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 3, latency_ms: 3,
        cost_microusd: 100_000, stop_reason: "unknown", outcome: "completed",
      },
    });
    await expect(store.emit(metering)).resolves.toEqual({ ok: true, value: undefined });
    const persisted = await admin.query(
      "SELECT event_type,idempotency_key FROM events WHERE tenant_id=$1 ORDER BY event_type",
      [tenantA],
    );
    expect(persisted.rows).toEqual([
      { event_type: "llm.call", idempotency_key: "eu12-metering" },
      { event_type: "tool.invocation", idempotency_key: "eu12-tool-replay" },
    ]);
    await expect(admin.query("SELECT event_id FROM tool_invocations WHERE tenant_id=$1 AND idempotency_key='eu12-tool-replay'", [tenantA]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(admin.query("SELECT event_id FROM llm_calls WHERE tenant_id=$1", [tenantA]))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it("survives migration replay and restart for result refs, archive runs, and tenant-scoped release channels", async () => {
    await expect(migrateUp(DATABASE_URL!, { appPassword })).resolves.toEqual([]);
    const migration = await admin.query("SELECT version FROM schema_migrations WHERE version='004_eu12_reviewer_durability.sql'");
    expect(migration.rowCount).toBe(1);

    let nowMs = Date.parse("2026-09-02T00:00:00.000Z");
    const objects = new InMemoryResultObjectStore();
    const first = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const ref = await first.putResult({
      scope: { tenantId: tenantA, sessionId: sessionA },
      payload: { items: [1, 2, 3] },
      idempotencyKey: "eu12/restart-ref",
      invocationId: randomUUID(),
      refLabel: "R17",
      expiresAtMs: nowMs + 1_000,
      pageSizeBytes: 8,
    });
    await first.close();

    const resumed = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    await expect(resumed.getResultPage({ scope: { tenantId: tenantA, sessionId: sessionA }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toMatchObject({ kind: "page" });
    await expect(resumed.getResultPage({ scope: { tenantId: tenantB, sessionId: sessionA }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toEqual({ kind: "not_found" });
    nowMs += 1_001;
    await expect(resumed.expireResults({ tenantId: tenantA, nowMs })).resolves.toEqual([ref]);
    await expect(resumed.getResultPage({ scope: { tenantId: tenantA, sessionId: sessionA }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toEqual({ kind: "not_found" });

    const archivePayload = {
      dispatch_attempt_id: "archive-attempt", invocation_id: "archive-invocation", idempotency_key: "eu12/archive-a",
      tool_name: "core.inspect", tool_version: "1.0.0", policy_class: "auto", executor: "bridge",
      params_digest: `sha256:${"c".repeat(64)}`, outcome: "completed", started_at_ms: 1, completed_at_ms: 2,
      duration_ms: 1, request_bytes: 1, response_bytes: 1,
    } as const;
    const archiveA = envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: archivePayload, occurredAt: "2026-08-15T00:00:00.000Z" });
    const archiveB = envelope({ eventId: randomUUID(), tenantId: tenantB, sessionId: sessionB, userId: userB, type: "tool.invocation", payload: { ...archivePayload, idempotency_key: "eu12/archive-b" }, occurredAt: "2026-08-15T00:00:00.000Z" });
    await expect(store.emit(archiveA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.emit(archiveB)).resolves.toEqual({ ok: true, value: undefined });
    await expect(resumed.archiveEvents({ tenantId: tenantA, month: "2026-08", owner: "eu12-restart", afterObjectWrite: () => { throw new Error("synthetic restart boundary"); } }))
      .rejects.toThrow(/synthetic restart boundary/u);
    await resumed.close();

    const afterRestart = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const archived = await afterRestart.archiveEvents({ tenantId: tenantA, month: "2026-08", owner: "eu12-restart" });
    expect(archived).toMatchObject({ state: "dropped", eventCount: 1, attempts: 2 });
    expect(await afterRestart.readArchivedEvents({ tenantId: tenantA, month: "2026-08" })).toEqual([archiveA]);
    const tenantBEvents = await admin.query("SELECT count(*)::int AS count FROM events WHERE tenant_id=$1 AND retention_partition_month='2026-08-01'", [tenantB]);
    expect(tenantBEvents.rows[0]?.count).toBe(1);
    await expect(afterRestart.archiveEvents({ tenantId: tenantA, month: "2026-08", owner: "eu12-restart" })).resolves.toMatchObject({ state: "dropped", attempts: 2 });

    const artifact = Buffer.from("durable bridge archive", "utf8");
    const artifactKey = "releases/bridge/2.0.0/bridge-2.0.0.zip";
    await objects.put({ key: artifactKey, bytes: artifact });
    const releaseId = randomUUID();
    const release = {
      id: releaseId, version: "2.0.0", channel: "pilot" as const, artifactStorageKey: artifactKey,
      artifactSha256: resultReferenceDigest(artifact), signature: "fixture-signature", signingKeyId: "release-key-1",
      minSupportedVersion: "1.0.0", releasedAtMs: nowMs, releasedBy: "vendor-admin",
    };
    await afterRestart.publishRelease({
      release,
      releaseSequence: 2,
      tenantIds: [tenantA],
    });
    const newerArtifact = Buffer.from("durable bridge archive newer", "utf8");
    const newerArtifactKey = "releases/bridge/2.0.1/bridge-2.0.1.zip";
    await objects.put({ key: newerArtifactKey, bytes: newerArtifact });
    const newerReleaseId = randomUUID();
    await afterRestart.publishRelease({
      release: {
        id: newerReleaseId, version: "2.0.1", channel: "pilot", artifactStorageKey: newerArtifactKey,
        artifactSha256: resultReferenceDigest(newerArtifact), signature: "fixture-signature", signingKeyId: "release-key-1",
        minSupportedVersion: "1.0.0", releasedAtMs: nowMs + 1, releasedBy: "vendor-admin",
      },
      releaseSequence: 3,
      tenantIds: [tenantA],
    });
    await expect(afterRestart.publishRelease({ release, releaseSequence: 2, tenantIds: [tenantA] }))
      .rejects.toThrow(/rollback is forbidden/u);
    await afterRestart.close();

    const releaseRestart = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    await expect(releaseRestart.readReleaseForTenant({ tenantId: tenantA, channel: "pilot" })).resolves.toMatchObject({ id: newerReleaseId });
    await expect(releaseRestart.readReleaseForTenant({ tenantId: tenantB, channel: "pilot" })).resolves.toBeNull();
    await releaseRestart.close();
  }, 60_000);

  it("enforces two-tenant RLS negatives for events, result refs, and retention runs", async () => {
    await admin.query(
      `INSERT INTO result_refs(id,tenant_id,session_id,ref_label,storage_key,content_digest,byte_size,page_size_bytes,page_count,summary,expires_at)
       VALUES ($1,$2,$3,'R18','tenants/a/results/ref.json.zst',$4,1,1,1,'{}',clock_timestamp()),
              ($5,$6,$7,'R18','tenants/b/results/ref.json.zst',$4,1,1,1,'{}',clock_timestamp())`,
      [randomUUID(), tenantA, sessionA, "b".repeat(64), randomUUID(), tenantB, sessionB],
    );
    await admin.query(
      `INSERT INTO retention_runs(tenant_id,archive_month,state,archive_key,archive_digest,event_count)
       VALUES ($1,'2026-07-01','prepared','archive/a/events/2026-07.ndjson.zst',$3,0),
              ($2,'2026-07-01','prepared','archive/b/events/2026-07.ndjson.zst',$3,0)`,
      [tenantA, tenantB, "c".repeat(64)],
    );
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      for (const relation of ["events", "llm_calls", "result_refs", "retention_runs", "release_channel_targets"] as const) {
        await expect(client.query(`SELECT tenant_id FROM ${relation} WHERE tenant_id=$1`, [tenantB]))
          .resolves.toMatchObject({ rowCount: 0 });
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
