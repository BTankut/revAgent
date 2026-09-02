import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { GatewayJsonObject } from "./dispatch.js";
import type { GatewayEventEnvelope } from "./events.js";
import {
  BoundedEu12EventWriter,
  Eu12EventBackpressureError,
  InMemoryEu12EventPersistence,
  createExternalLlmMeteringEvent,
  summarizeAuditInput,
  validateEu12EventEnvelope,
  type Eu12EventPersistence,
} from "./eventPersistence.js";
import { Eu12InvocationRecorder } from "./eventResultLifecycle.js";
import { deriveMetricParity } from "./metricParity.js";
import { ReleaseChannelStore } from "./releaseChannelStore.js";
import { RetentionArchiveRunner, parseArchivedEventNdjson } from "./retentionArchive.js";
import { InMemoryResultObjectStore, ResultReferenceIdempotencyError, ResultReferenceStore } from "./resultReferenceStore.js";

const TENANT_A = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "20000000-0000-4000-8000-000000000002";
const SESSION_A = "30000000-0000-4000-8000-000000000003";
const SESSION_B = "40000000-0000-4000-8000-000000000004";
const USER_A = "50000000-0000-4000-8000-000000000005";
const USER_B = "60000000-0000-4000-8000-000000000006";

function eventId(value: number): string {
  return `70000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function event(input: {
  readonly id: number;
  readonly tenantId?: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly type?: GatewayEventEnvelope["event_type"];
  readonly occurredAt?: string;
  readonly sequence?: number;
  readonly payload?: GatewayJsonObject;
}): GatewayEventEnvelope {
  return validateEu12EventEnvelope({
    schema: "revagent.event.v2",
    event_id: eventId(input.id),
    event_type: input.type ?? "tool.invocation",
    occurred_at: input.occurredAt ?? "2026-09-02T08:00:00.000Z",
    recorded_at: input.occurredAt ?? "2026-09-02T08:00:00.000Z",
    tenant_id: input.tenantId ?? TENANT_A,
    source: { component: "eu12-test", version: "1", instance: "test" },
    actor: { type: "user", user_id: input.userId ?? USER_A },
    session_id: input.sessionId ?? SESSION_A,
    seq: input.sequence ?? input.id,
    payload: input.payload ?? {
      idempotency_key: `event-${input.id}`,
      tool_name: "core.inspect",
      tool_version: "1.0.0",
      policy_class: "auto",
      executor: "bridge",
      params_digest: `sha256:${"a".repeat(64)}`,
      outcome: "completed",
      started_at_ms: 1_000,
      completed_at_ms: 1_001,
      duration_ms: 1,
      request_bytes: 12,
      response_bytes: 13,
    },
  });
}

describe("EU-12 M5 event/result/retention/release/parity vertical", () => {
  it("validates the complete event envelope and rejects malformed audit vectors", () => {
    expect(event({ id: 1 })).toMatchObject({ schema: "revagent.event.v2", event_type: "tool.invocation" });
    expect(createExternalLlmMeteringEvent({
      eventId: eventId(9), tenantId: TENANT_A, sessionId: SESSION_A, actorUserId: USER_A,
      source: { component: "external-client", version: "1", instance: "test" }, sequence: 9,
      occurredAt: "2026-09-02T08:00:00.000Z", recordedAt: "2026-09-02T08:00:00.000Z",
      idempotencyKey: "metering-9", upstreamName: "authorized-client", modelName: "observed-model",
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, durationMs: 3, cost: 0.1,
    })).toMatchObject({ event_type: "llm.call", payload: { engine_mode: "external_client" } });
    expect(() => validateEu12EventEnvelope({
      ...event({ id: 2 }), schema: "revagent.event.v1",
    })).toThrow(/invalid revagent\.event\.v2/u);
    expect(() => validateEu12EventEnvelope({
      ...event({ id: 3 }), actor: { type: "user" },
    })).toThrow(/actor\.user_id/u);
    expect(() => validateEu12EventEnvelope({
      ...event({ id: 4 }), event_type: "llm.call", session_id: undefined,
    })).toThrow(/session_id/u);
  });

  it("writes a bounded, idempotent event stream without an unbounded queue", async () => {
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const persisted = new InMemoryEu12EventPersistence();
    const delayed: Eu12EventPersistence = {
      kind: "memory",
      async write(events) { await writeGate; return await persisted.write(events); },
      async read(scope) { return await persisted.read(scope); },
      async list(scope) { return await persisted.list(scope); },
    };
    const writer = new BoundedEu12EventWriter({ persistence: delayed, maxPendingEvents: 2 });
    const first = writer.write([event({ id: 10 })]);
    await expect(writer.write([event({ id: 11 }), event({ id: 12 })]))
      .rejects.toBeInstanceOf(Eu12EventBackpressureError);
    releaseWrite?.();
    await expect(first).resolves.toMatchObject([{ disposition: "inserted" }]);
    await expect(writer.flush()).resolves.toEqual({ ok: true, value: undefined });

    const initial = event({ id: 13, payload: { ...event({ id: 13 }).payload, idempotency_key: "replayed" } });
    const redelivery = event({
      id: 14,
      sequence: 14,
      occurredAt: "2026-09-02T08:00:01.000Z",
      payload: { ...initial.payload, idempotency_key: "replayed" },
    });
    await expect(writer.write([initial])).resolves.toMatchObject([{ disposition: "inserted" }]);
    await expect(writer.write([redelivery])).resolves.toMatchObject([{ disposition: "duplicate" }]);
    expect(await persisted.list({ tenantId: TENANT_A })).toHaveLength(2);
    expect(await persisted.read({ tenantId: TENANT_B, eventId: initial.event_id })).toBeNull();
  });

  it("preserves the approved telemetry summary shape and the canonical raw-params digest", () => {
    const params: GatewayJsonObject = {
      transactionMode: "none",
      query: "sensitive query",
      elementIds: [1, 2],
      parameters: ["a", "b"],
      nested: { z: 1, a: true },
      code: "new Transaction(doc);\nparameter.Set(42);",
    };
    const audit = summarizeAuditInput(params);
    expect(audit.paramsSummary).toEqual({
      keys: ["elementIds", "nested", "query", "transactionMode"],
      code: {
        hash: "4acedc37d1ce1f0b",
        length: 40,
        lineCount: 2,
        writePatternCount: 2,
        writePatterns: ["Parameter.Set", "Manual Transaction"],
        hasManualTransaction: true,
        preview: "new Transaction(doc);\nparameter.Set(42);",
        previewTruncated: false,
      },
      elementIds: { count: 2 },
      nested: { keys: ["a", "z"] },
      parameters: { count: 2 },
      query: {
        hash: "4e012009e642e2d1",
        length: 15,
        present: true,
        text: "sensitive query",
        textTruncated: false,
      },
      transactionMode: "none",
    });
    expect(audit.paramsDigest).toBe("sha256:8363a229ab7a06ae63c3e4ecc39a30bf5d978900be5cca7e274e9c144985c851");
  });

  it("scopes result pages to exact tenant/session and expires both row and object", async () => {
    let nowMs = 1_000;
    const objects = new InMemoryResultObjectStore();
    const results = new ResultReferenceStore({
      objects,
      now: () => nowMs,
      newRefId: () => "result-a",
      defaultPageSizeBytes: 16,
    });
    const input = {
      scope: { tenantId: TENANT_A, sessionId: SESSION_A },
      payload: { message: "a result with enough bytes to use multiple stable pages" },
      idempotencyKey: "result-idempotency",
      expiresAtMs: 2_000,
      pageSizeBytes: 16,
    } as const;
    const ref = await results.put(input);
    expect(ref.pageCount).toBeGreaterThan(1);
    expect(await results.put(input)).toEqual(ref);
    await expect(results.put({ ...input, payload: { changed: true } })).rejects.toBeInstanceOf(ResultReferenceIdempotencyError);
    const first = await results.getPage({ scope: input.scope, refId: ref.refId, pageIndex: 0 });
    const again = await results.getPage({ scope: input.scope, refId: ref.refId, pageIndex: 0 });
    expect(first).toMatchObject({ kind: "page", pageIndex: 0 });
    expect(again).toMatchObject({ kind: "page", base64: (first as Extract<typeof first, { kind: "page" }>).base64 });
    await expect(results.getPage({ scope: { tenantId: TENANT_B, sessionId: SESSION_A }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toEqual({ kind: "not_found" });
    await expect(results.getPage({ scope: { tenantId: TENANT_A, sessionId: SESSION_B }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toEqual({ kind: "not_found" });
    nowMs = 2_001;
    await expect(results.getPage({ scope: input.scope, refId: ref.refId, pageIndex: 0 })).resolves.toEqual({ kind: "expired" });
    await expect(results.expire({ nowMs })).resolves.toEqual([ref]);
    expect(objects.has(ref.storageKey)).toBe(false);
    await expect(results.getPage({ scope: input.scope, refId: ref.refId, pageIndex: 0 })).resolves.toEqual({ kind: "not_found" });
  });

  it("replays interrupted tenant-scoped archive runs and preserves another tenant's records", async () => {
    const events = new InMemoryEu12EventPersistence();
    const archivedEvent = event({ id: 20, occurredAt: "2026-08-31T23:59:59.000Z" });
    const retainedForeignEvent = event({ id: 21, tenantId: TENANT_B, sessionId: SESSION_B, userId: USER_B, occurredAt: "2026-08-31T23:59:59.000Z" });
    await events.write([archivedEvent, retainedForeignEvent]);
    const objects = new InMemoryResultObjectStore();
    let interrupted = true;
    const runner = new RetentionArchiveRunner({
      objects,
      events,
      async afterObjectWrite() {
        if (interrupted) {
          interrupted = false;
          throw new Error("synthetic interruption after durable object write");
        }
      },
    });
    await expect(runner.archive({ tenantId: TENANT_A, month: "2026-08" })).rejects.toThrow(/synthetic interruption/u);
    expect(runner.getRun({ tenantId: TENANT_A, month: "2026-08" })).toMatchObject({ state: "prepared", attempts: 1 });
    const completed = await runner.archive({ tenantId: TENANT_A, month: "2026-08" });
    expect(completed).toMatchObject({ state: "dropped", attempts: 2, eventCount: 1 });
    const archive = await objects.get({ key: completed.archiveKey });
    expect(archive).not.toBeNull();
    expect(parseArchivedEventNdjson(archive!)).toEqual([archivedEvent]);
    expect(await events.list({ tenantId: TENANT_A })).toEqual([]);
    expect(await events.list({ tenantId: TENANT_B })).toEqual([retainedForeignEvent]);
  });

  it("stores a pinned release/channel contract and denies tenants outside a staged rollout", async () => {
    const objects = new InMemoryResultObjectStore();
    const artifact = Buffer.from("bridge archive", "utf8");
    const artifactKey = "releases/bridge/1.2.3/bridge-1.2.3.zip";
    await objects.put({ key: artifactKey, bytes: artifact });
    const store = new ReleaseChannelStore({
      objects,
      pinnedSigningKeyIds: ["release-key-1"],
      signatureVerifier: { verify: ({ signingKeyId, signature }) => signingKeyId === "release-key-1" && signature === "fixture-signature" },
    });
    const release = await store.publish({
      release: {
        id: "release-1",
        version: "1.2.3",
        channel: "pilot",
        artifactStorageKey: artifactKey,
        artifactSha256: `sha256:${createHash("sha256").update(artifact).digest("hex")}`,
        signature: "fixture-signature",
        signingKeyId: "release-key-1",
        minSupportedVersion: "1.0.0",
        releasedAtMs: 1_000,
        releasedBy: "vendor-admin",
      },
    });
    const flip = store.flipChannel({ channel: "pilot", releaseId: release.id, tenantIds: [TENANT_A], actorId: "vendor-admin" });
    expect(flip.audit).toMatchObject({ eventType: "registry.published", entity: "bridge_release" });
    expect(store.readForTenant({ tenantId: TENANT_A, channel: "pilot" })).toMatchObject({ release: { id: release.id } });
    expect(store.readForTenant({ tenantId: TENANT_B, channel: "pilot" })).toBeNull();
  });

  it("derives every surviving O11 metric and explicitly classifies every dying metric", () => {
    const tool = event({
      id: 30,
      payload: {
        idempotency_key: "metric-tool",
        tool_name: "core.code.execute",
        tool_version: "1.0.0",
        policy_class: "auto",
        executor: "bridge",
        params_digest: `sha256:${"b".repeat(64)}`,
        outcome: "completed",
        started_at_ms: 1,
        completed_at_ms: 2,
        duration_ms: 1,
        request_bytes: 1,
        response_bytes: 2,
        context: {
          project: { projectId: "project-a" },
          elements: { disciplineHint: "mech", categories: ["duct"] },
          location: { levelName: "L1" },
          search: { query: "duct", riskLevel: "low", scannedElementCount: 1, partial: false, scanStoppedReason: "completed", needsScope: false },
        },
        search: { query: "duct" },
        code: { hash: "short", length: 1, line_count: 1, write_patterns: [], has_manual_transaction: false, preview: "x" },
      },
    });
    const connected = event({ id: 31, type: "bridge.connected", payload: { device_id: "device-a" } });
    const disconnected = event({ id: 32, type: "bridge.disconnected", payload: { device_id: "device-a", reason: "normal", connected_ms: 1 } });
    const update = event({ id: 33, type: "bridge.update", payload: { device_id: "device-a", status: "applied", reason: "completed" } });
    const metering = event({ id: 34, type: "llm.call", payload: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, duration_ms: 3, cost: 0.1 } });
    const report = deriveMetricParity({
      tenantId: TENANT_A,
      events: [tool, connected, disconnected, update, metering],
      devices: [{ tenantId: TENANT_A, deviceId: "device-a", machineName: "A-WS", userId: USER_A, bridgeVersion: "1.2.3", lastSeenAtMs: 1 }],
      currentReleaseByChannel: { pilot: "release-1" },
    });
    expect(report.survivingDerivable).toBe(true);
    expect(report.dyingClassified).toBe(true);
    expect(report.rows.filter((row) => row.status === "dying")).toHaveLength(8);
  });

  it("records one external invocation through unified event/audit persistence and a result reference", async () => {
    const persisted = new InMemoryEu12EventPersistence();
    const writer = new BoundedEu12EventWriter({ persistence: persisted });
    const results = new ResultReferenceStore({
      objects: new InMemoryResultObjectStore(),
      now: () => 1_000,
      newRefId: () => "invocation-result",
    });
    const recorder = new Eu12InvocationRecorder({ events: writer, results });
    const input = {
      eventId: eventId(40),
      tenantId: TENANT_A,
      sessionId: SESSION_A,
      actorUserId: USER_A,
      source: { component: "north-mcp", version: "1", instance: "external-client" },
      sequence: 40,
      idempotencyKey: "one-invocation",
      toolName: "core.inspect",
      toolVersion: "1.0.0",
      policyClass: "auto" as const,
      executor: "bridge" as const,
      outcome: "completed" as const,
      startedAtMs: 900,
      completedAtMs: 1_000,
      requestBytes: 10,
      responseBytes: 20,
      params: { responseMode: "compact", code: "parameter.Set(1);" },
      result: { items: [1, 2, 3] },
      resultExpiresAtMs: 2_000,
    };
    const recorded = await recorder.record(input);
    expect(recorded.eventWrite).toMatchObject({ route: "tool_invocations", disposition: "inserted" });
    const replay = await recorder.record({ ...input, eventId: eventId(41), sequence: 41 });
    expect(replay.eventWrite).toMatchObject({ disposition: "duplicate" });
    expect(replay.resultRef.refId).toBe(recorded.resultRef.refId);
    expect(await results.getPage({ scope: { tenantId: TENANT_B, sessionId: SESSION_A }, refId: recorded.resultRef.refId, pageIndex: 0 }))
      .toEqual({ kind: "not_found" });
  });
});
