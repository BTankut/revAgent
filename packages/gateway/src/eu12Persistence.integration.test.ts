import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GatewayEventEnvelope } from "./events.js";
import { migrateUp } from "./migrate.js";
import { PostgresEu12DataStore, RetentionLeaseError, canonicalDurableReleaseManifest } from "./postgresEu12DataStore.js";
import { PostgresTenantStore } from "./postgresTenantStore.js";
import { InMemoryResultObjectStore, resultReferenceDigest } from "./resultReferenceStore.js";
import { Eu12InvocationRecorder } from "./eventResultLifecycle.js";
import { deriveMetricParity } from "./metricParity.js";
import { Eu12EventBackpressureError } from "./eventPersistence.js";

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
    const migration = await admin.query("SELECT version FROM schema_migrations WHERE version='006_eu12_physical_retention_partitions.sql'");
    expect(migration.rowCount).toBe(1);

    let nowMs = Date.now();
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
    const boundedDurableWriter = first.createBoundedEventWriter(1);
    const boundedPayload = {
      dispatch_attempt_id: "bounded-attempt", invocation_id: "bounded-invocation", idempotency_key: "eu12/bounded-a",
      tool_name: "core.inspect", tool_version: "1.0.0", policy_class: "auto", executor: "bridge",
      params_digest: `sha256:${"e".repeat(64)}`, outcome: "completed", started_at_ms: nowMs, completed_at_ms: nowMs + 1,
      duration_ms: 1, request_bytes: 1, response_bytes: 1,
    } as const;
    await expect(boundedDurableWriter.write([
      envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: boundedPayload }),
      envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: { ...boundedPayload, idempotency_key: "eu12/bounded-b" } }),
    ])).rejects.toBeInstanceOf(Eu12EventBackpressureError);
    const ref = await first.putResult({
      scope: { tenantId: tenantA, sessionId: sessionA },
      payload: { items: [1, 2, 3] },
      idempotencyKey: "eu12/restart-ref",
      invocationId: randomUUID(),
      refLabel: "R17",
      expiresAtMs: nowMs + 1_000,
      pageSizeBytes: 8,
    });
    const composedEventId = randomUUID();
    const composedInvocationId = randomUUID();
    const composed = new Eu12InvocationRecorder({ events: first.createBoundedEventWriter(8), results: first });
    const composedReceipt = await composed.record({
      eventId: composedEventId,
      tenantId: tenantA,
      sessionId: sessionA,
      actorUserId: userA,
      source: { component: "north-mcp", version: "1", instance: "durable-test" },
      sequence: 88,
      idempotencyKey: "eu12/durable-composition",
      invocationId: composedInvocationId,
      dispatchAttemptId: randomUUID(),
      toolName: "core.inspect",
      toolVersion: "1.0.0",
      policyClass: "auto",
      executor: "bridge",
      outcome: "completed",
      startedAtMs: nowMs,
      completedAtMs: nowMs + 1,
      requestBytes: 3,
      responseBytes: 4,
      params: { responseMode: "compact" },
      result: { durable: true },
      resultExpiresAtMs: nowMs + 5_000,
    });
    expect(composedReceipt.eventWrite).toMatchObject({ route: "tool_invocations", disposition: "inserted" });
    const defaultTtlInvocation = {
      eventId: randomUUID(),
      tenantId: tenantA,
      sessionId: sessionA,
      actorUserId: userA,
      source: { component: "north-mcp", version: "1", instance: "durable-default-ttl" },
      sequence: 89,
      idempotencyKey: "eu12/durable-default-ttl",
      invocationId: randomUUID(),
      dispatchAttemptId: randomUUID(),
      toolName: "core.inspect",
      toolVersion: "1.0.0",
      policyClass: "auto" as const,
      executor: "bridge" as const,
      outcome: "completed" as const,
      startedAtMs: nowMs,
      completedAtMs: nowMs + 1,
      requestBytes: 3,
      responseBytes: 4,
      params: { responseMode: "compact" },
      result: { durableDefaultTtl: true },
    };
    const defaultTtlReceipt = await composed.record(defaultTtlInvocation);
    const activeInvocationId = randomUUID();
    await first.beginActiveInvocation({ tenantId: tenantA, invocationId: activeInvocationId, sessionId: sessionA, actorUserId: userA, toolName: "core.inspect", startedAtMs: nowMs });
    const activeAttribution = await first.readPersistedParityAttribution(tenantA);
    expect(activeAttribution.activeTaskCount).toBe(1);
    await first.completeActiveInvocation({ tenantId: tenantA, invocationId: activeInvocationId, outcome: "completed", completedAtMs: nowMs + 1 });
    const persistedAttribution = await first.readPersistedParityAttribution(tenantA);
    expect(persistedAttribution.activeTaskCount).toBe(0);
    expect(persistedAttribution.toolUserAttribution["core.inspect"]?.[userA]).toBeGreaterThan(0);
    expect(persistedAttribution.modelUserAttribution["observed-model"]?.[userA]).toBeGreaterThan(0);
    const persistedParity = deriveMetricParity({
      tenantId: tenantA,
      events: await first.list({ tenantId: tenantA }),
      devices: [{ tenantId: tenantA, deviceId: "parity-device", machineName: "Parity WS", userId: userA, bridgeVersion: "1.0.0", lastSeenAtMs: nowMs }],
      currentReleaseByChannel: { pilot: "release-parity" },
      activeTaskCount: persistedAttribution.activeTaskCount,
      toolUserAttribution: persistedAttribution.toolUserAttribution,
      modelUserAttribution: persistedAttribution.modelUserAttribution,
    });
    expect(persistedParity.rows.find((row) => row.metric === "taskState/activeTask")?.value).toMatchObject({ activeTaskCount: 0 });
    expect(persistedParity.rows.find((row) => row.metric === "toolUsage/commandUsage")?.value).toMatchObject({ byToolUser: expect.any(Object) });
    expect(persistedParity.rows.find((row) => row.metric === "tokenSpend/latency/costAttribution")?.value).toMatchObject({ byModelUser: expect.any(Object) });
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
    await expect(resumed.read({ tenantId: tenantA, eventId: composedEventId })).resolves.toMatchObject({ event_id: composedEventId });
    await expect(resumed.getResultPage({ scope: { tenantId: tenantA, sessionId: sessionA }, refId: composedReceipt.resultRef.refId, pageIndex: 0 }))
      .resolves.toMatchObject({ kind: "page" });
    nowMs += 1_000;
    const resumedLifecycle = new Eu12InvocationRecorder({ events: resumed.createBoundedEventWriter(8), results: resumed });
    const defaultTtlReplay = await resumedLifecycle.record({ ...defaultTtlInvocation, eventId: randomUUID(), sequence: 90 });
    expect(defaultTtlReplay.eventWrite).toMatchObject({ disposition: "duplicate" });
    expect(defaultTtlReplay.resultRef.refId).toBe(defaultTtlReceipt.resultRef.refId);
    expect(defaultTtlReplay.resultRef.expiresAtMs).toBe(defaultTtlReceipt.resultRef.expiresAtMs);
    await expect(resumed.getResultPage({ scope: { tenantId: tenantB, sessionId: sessionA }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toEqual({ kind: "not_found" });
    nowMs += 1_001;
    await expect(resumed.expireResults({ tenantId: tenantA, nowMs })).resolves.toEqual([ref]);
    await expect(resumed.getResultPage({ scope: { tenantId: tenantA, sessionId: sessionA }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toEqual({ kind: "not_found" });

    const archiveStartedAtMs = Date.parse("2026-08-15T00:00:00.000Z");
    const archivePayload = {
      dispatch_attempt_id: "archive-attempt", invocation_id: "archive-invocation", idempotency_key: "eu12/archive-a",
      tool_name: "core.inspect", tool_version: "1.0.0", policy_class: "auto", executor: "bridge",
      params_digest: `sha256:${"c".repeat(64)}`, outcome: "completed", started_at_ms: archiveStartedAtMs, completed_at_ms: archiveStartedAtMs + 1,
      duration_ms: 1, request_bytes: 1, response_bytes: 1,
    } as const;
    const archiveA = envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: archivePayload, occurredAt: "2026-08-15T00:00:00.000Z" });
    const archiveB = envelope({ eventId: randomUUID(), tenantId: tenantB, sessionId: sessionB, userId: userB, type: "tool.invocation", payload: { ...archivePayload, idempotency_key: "eu12/archive-b" }, occurredAt: "2026-08-15T00:00:00.000Z" });
    await expect(store.emit(archiveA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.emit(archiveB)).resolves.toEqual({ ok: true, value: undefined });
    const archiveLlmA = envelope({
      eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "llm.call",
      payload: { idempotency_key: "eu12/archive-llm-a", upstream_name: "external-client", model_name: "observed-model", engine_mode: "external_client", role: "external_client", input_tokens: 3, output_tokens: 4, cache_read_tokens: 1, cache_creation_tokens: 0, duration_ms: 5, latency_ms: 5, cost_microusd: 6, stop_reason: "unknown", outcome: "completed" },
      occurredAt: "2026-08-16T00:00:00.000Z",
    });
    const archiveLlmB = envelope({
      eventId: randomUUID(), tenantId: tenantB, sessionId: sessionB, userId: userB, type: "llm.call",
      payload: { idempotency_key: "eu12/archive-llm-b", upstream_name: "external-client", model_name: "observed-model", engine_mode: "external_client", role: "external_client", input_tokens: 3, output_tokens: 4, cache_read_tokens: 1, cache_creation_tokens: 0, duration_ms: 5, latency_ms: 5, cost_microusd: 6, stop_reason: "unknown", outcome: "completed" },
      occurredAt: "2026-08-16T00:00:00.000Z",
    });
    await expect(store.emit(archiveLlmA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.emit(archiveLlmB)).resolves.toEqual({ ok: true, value: undefined });
    await admin.query("UPDATE llm_calls SET created_at='2026-08-15T00:00:00.000Z' WHERE event_id = ANY($1::uuid[])", [[archiveLlmA.event_id, archiveLlmB.event_id]]);
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
    expect(archived).toMatchObject({ state: "dropped", eventCount: 2, attempts: 2 });
    expect(await afterRestart.readArchivedEvents({ tenantId: tenantA, month: "2026-08" })).toEqual([archiveA, archiveLlmA]);
    const tenantBEvents = await admin.query("SELECT count(*)::int AS count FROM events WHERE tenant_id=$1 AND retention_partition_month='2026-08-01'", [tenantB]);
    expect(tenantBEvents.rows[0]?.count).toBe(2);
    await expect(afterRestart.archiveEvents({ tenantId: tenantA, month: "2026-08", owner: "eu12-restart" })).resolves.toMatchObject({ state: "dropped", attempts: 2 });
    await expect(afterRestart.archiveSurface({ tenantId: tenantA, month: "2026-08", surface: "tool_invocations", owner: "eu12-restart" })).resolves.toMatchObject({ state: "dropped", eventCount: 1 });
    await expect(afterRestart.readTypedArchive({ tenantId: tenantA, month: "2026-08", surface: "tool_invocations" })).resolves.toHaveLength(1);
    await expect(afterRestart.archiveSurface({ tenantId: tenantA, month: "2026-08", surface: "llm_calls", owner: "eu12-restart" })).resolves.toMatchObject({ state: "dropped", eventCount: 1 });
    await expect(afterRestart.readTypedArchive({ tenantId: tenantA, month: "2026-08", surface: "llm_calls" })).resolves.toHaveLength(1);
    await expect(afterRestart.archiveEvents({ tenantId: tenantB, month: "2026-08", owner: "tenant-b-lease", afterObjectWrite: () => { throw new Error("tenant B lease retained"); } }))
      .rejects.toThrow(/tenant B lease retained/u);
    await expect(afterRestart.archiveEvents({ tenantId: tenantB, month: "2026-08", owner: "competing-owner" }))
      .rejects.toBeInstanceOf(RetentionLeaseError);
    await expect(afterRestart.archiveEvents({ tenantId: tenantB, month: "2026-08", owner: "tenant-b-lease" }))
      .resolves.toMatchObject({ state: "dropped", eventCount: 2 });
    await expect(afterRestart.archiveSurface({ tenantId: tenantB, month: "2026-08", surface: "tool_invocations", owner: "tenant-b-lease" }))
      .resolves.toMatchObject({ state: "dropped", eventCount: 1 });
    await expect(afterRestart.archiveSurface({ tenantId: tenantB, month: "2026-08", surface: "llm_calls", owner: "tenant-b-lease" }))
      .resolves.toMatchObject({ state: "dropped", eventCount: 1 });
    const physicalPartitions = await admin.query<{ archive_kind: string; state: string; partition_table: string; table_exists: string | null }>(
      `SELECT archive_kind,state,partition_table,to_regclass(partition_table)::text AS table_exists
       FROM retention_partition_ownership WHERE tenant_id=$1 AND archive_month='2026-08-01' ORDER BY archive_kind`,
      [tenantB],
    );
    expect(physicalPartitions.rows).toEqual([
      { archive_kind: "events", state: "dropped", partition_table: expect.any(String), table_exists: null },
      { archive_kind: "llm_calls", state: "dropped", partition_table: expect.any(String), table_exists: null },
      { archive_kind: "tool_invocations", state: "dropped", partition_table: expect.any(String), table_exists: null },
    ]);

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
      .rejects.toThrow(/rollback (is forbidden|floor)/u);
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

  it("binds signed release sequence and rollback authority into the canonical durable manifest", async () => {
    const objects = new InMemoryResultObjectStore();
    const verifier = {
      verify: ({ canonicalManifest, signature }: { readonly canonicalManifest: string; readonly signature: string }) =>
        signature === resultReferenceDigest(Buffer.from(canonicalManifest, "utf8")),
    };
    const durable = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      signatureVerifier: verifier,
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const artifact = Buffer.from("signed authority artifact", "utf8");
    const artifactKey = "releases/bridge/3.0.0/bridge-3.0.0.zip";
    await objects.put({ key: artifactKey, bytes: artifact });
    const unsigned = {
      id: randomUUID(), version: "3.0.0", channel: "stable" as const, artifactStorageKey: artifactKey,
      artifactSha256: resultReferenceDigest(artifact), signature: "", signingKeyId: "release-key-1",
      minSupportedVersion: "1.0.0", releasedAtMs: Date.parse("2026-09-02T00:00:00.000Z"), releasedBy: "vendor-admin",
    };
    const release = {
      ...unsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({ release: unsigned, releaseSequence: 5, releaseRollbackFloorSequence: 5, channelRollbackFloorSequence: 5, channelRevision: 1, tenantIds: [tenantA] }), "utf8")),
    };
    await expect(durable.publishRelease({ release, releaseSequence: 5, rollbackFloorSequence: 5, tenantIds: [tenantA] })).resolves.toBeUndefined();
    await expect(durable.publishRelease({ release, releaseSequence: 6, rollbackFloorSequence: 5, tenantIds: [tenantA] }))
      .rejects.toThrow(/signature is invalid/u);

    const newerArtifact = Buffer.from("signed authority artifact newer", "utf8");
    const newerKey = "releases/bridge/3.0.1/bridge-3.0.1.zip";
    await objects.put({ key: newerKey, bytes: newerArtifact });
    const newerUnsigned = {
      id: randomUUID(), version: "3.0.1", channel: "stable" as const, artifactStorageKey: newerKey,
      artifactSha256: resultReferenceDigest(newerArtifact), signature: "", signingKeyId: "release-key-1",
      minSupportedVersion: "1.0.0", releasedAtMs: Date.parse("2026-09-02T00:00:01.000Z"), releasedBy: "vendor-admin",
    };
    const newer = {
      ...newerUnsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({ release: newerUnsigned, releaseSequence: 6, releaseRollbackFloorSequence: 6, channelRollbackFloorSequence: 6, channelRevision: 2, tenantIds: [tenantA] }), "utf8")),
    };
    await expect(durable.publishRelease({ release: newer, releaseSequence: 6, rollbackFloorSequence: 6, tenantIds: [tenantA] })).resolves.toBeUndefined();
    await expect(admin.query<{ rollout_revision: number }>(
      "SELECT rollout_revision FROM release_channel_targets WHERE channel='stable' AND tenant_id=$1", [tenantA],
    )).resolves.toMatchObject({ rows: [{ rollout_revision: 2 }] });
    const concurrentArtifact = Buffer.from("signed authority artifact concurrent", "utf8");
    const concurrentKey = "releases/bridge/3.0.2/bridge-3.0.2.zip";
    await objects.put({ key: concurrentKey, bytes: concurrentArtifact });
    const concurrentUnsigned = {
      id: randomUUID(), version: "3.0.2", channel: "stable" as const, artifactStorageKey: concurrentKey,
      artifactSha256: resultReferenceDigest(concurrentArtifact), signature: "", signingKeyId: "release-key-1",
      minSupportedVersion: "1.0.0", releasedAtMs: Date.parse("2026-09-02T00:00:02.000Z"), releasedBy: "vendor-admin",
    };
    const concurrent = {
      ...concurrentUnsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({ release: concurrentUnsigned, releaseSequence: 7, releaseRollbackFloorSequence: 7, channelRollbackFloorSequence: 7, channelRevision: 3, tenantIds: [tenantA] }), "utf8")),
    };
    const concurrentResults = await Promise.allSettled([
      durable.publishRelease({ release: concurrent, releaseSequence: 7, rollbackFloorSequence: 7, tenantIds: [tenantA] }),
      durable.publishRelease({ release: concurrent, releaseSequence: 7, rollbackFloorSequence: 7, tenantIds: [tenantA] }),
    ]);
    expect(concurrentResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rollback = {
      ...unsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({ release: unsigned, releaseSequence: 5, releaseRollbackFloorSequence: 5, channelRollbackFloorSequence: 7, channelRevision: 4, tenantIds: [tenantA] }), "utf8")),
    };
    await expect(durable.publishRelease({ release: rollback, releaseSequence: 5, rollbackFloorSequence: 5, tenantIds: [tenantA] }))
      .rejects.toThrow(/rollback is forbidden/u);
    await durable.close();
  }, 60_000);

  it("upgrades multiple legacy result refs deterministically before the R17 uniqueness constraint", async () => {
    const databaseName = `eu12_legacy_${randomBytes(8).toString("hex")}`;
    const clusterUrl = new URL(DATABASE_URL!);
    clusterUrl.pathname = "/postgres";
    const cluster = new Pool({ connectionString: clusterUrl.href });
    const legacyUrl = new URL(DATABASE_URL!);
    legacyUrl.pathname = `/${databaseName}`;
    let legacy: pg.Pool | undefined;
    try {
      await cluster.query(`CREATE DATABASE ${databaseName}`);
      await migrateUp(legacyUrl.href, { appPassword, throughVersion: "003_eu12_event_result_retention_parity.sql" });
      legacy = new Pool({ connectionString: legacyUrl.href });
      const legacyTenant = randomUUID();
      const legacyUser = randomUUID();
      const legacySession = randomUUID();
      await legacy.query("INSERT INTO tenants(id,slug,name) VALUES($1,$2,'Legacy tenant')", [legacyTenant, `legacy-${legacyTenant}`]);
      await legacy.query("INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role) VALUES($1,$2,'https://issuer.test','legacy-user','user')", [legacyUser, legacyTenant]);
      await legacy.query("INSERT INTO sessions(id,tenant_id,user_id,client_type) VALUES($1,$2,$3,'mcp')", [legacySession, legacyTenant, legacyUser]);
      await legacy.query(
        `INSERT INTO result_refs(id,tenant_id,session_id,storage_key,content_digest,byte_size,page_size_bytes,page_count,summary,expires_at)
         VALUES($1,$2,$3,'tenants/legacy/results/a.json.zst',$4,1,1,1,'{}',clock_timestamp()),
               ($5,$2,$3,'tenants/legacy/results/b.json.zst',$4,1,1,1,'{}',clock_timestamp())`,
        [randomUUID(), legacyTenant, legacySession, "d".repeat(64), randomUUID()],
      );
      await expect(migrateUp(legacyUrl.href, { appPassword, throughVersion: "004_eu12_reviewer_durability.sql" }))
        .resolves.toContain("004_eu12_reviewer_durability.sql");
      const labels = await legacy.query<{ ref_label: string }>(
        "SELECT ref_label FROM result_refs WHERE tenant_id=$1 AND session_id=$2 ORDER BY ref_label", [legacyTenant, legacySession],
      );
      expect(labels.rows.map((row) => row.ref_label)).toEqual(["R17", "R18"]);
      await expect(migrateUp(legacyUrl.href, { appPassword })).resolves.toEqual(expect.arrayContaining([
        "005_eu12_leased_typed_retention.sql",
        "006_eu12_physical_retention_partitions.sql",
      ]));
      await expect(migrateUp(legacyUrl.href, { appPassword })).resolves.toEqual([]);
    } finally {
      await legacy?.end();
      await cluster.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [databaseName]);
      await cluster.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await cluster.end();
    }
  }, 60_000);

  it("enforces two-tenant RLS negatives for events, result refs, and retention runs", async () => {
    await admin.query(
      `INSERT INTO result_refs(id,tenant_id,session_id,ref_label,storage_key,content_digest,byte_size,page_size_bytes,page_count,summary,expires_at)
       VALUES ($1,$2,$3,'R999','tenants/a/results/ref.json.zst',$4,1,1,1,'{}',clock_timestamp()),
              ($5,$6,$7,'R999','tenants/b/results/ref.json.zst',$4,1,1,1,'{}',clock_timestamp())`,
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
      for (const relation of ["events", "llm_calls", "result_refs", "retention_runs", "release_channel_targets", "retention_partition_ownership", "retention_archive_rows", "active_invocations"] as const) {
        await expect(client.query(`SELECT tenant_id FROM ${relation} WHERE tenant_id=$1`, [tenantB]))
          .resolves.toMatchObject({ rowCount: 0 });
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
