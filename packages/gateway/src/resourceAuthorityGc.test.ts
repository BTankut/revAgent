import { createHash } from "node:crypto";

import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import { describe, expect, it, vi } from "vitest";
import {
  GatewayResourceAuthority,
  ResourceAuthorityProtectedKeyInventoryPort,
  type GatewayResourceScope,
} from "./resourceAuthority.js";
import { createMemoryObjectStore, createRestartableTestStore } from "./testAdapters.js";

const scope: GatewayResourceScope = Object.freeze({
  tenantId: "tenant-gc",
  actorId: "user-gc",
  principalKey: "tenant-gc:user-gc",
  mcpSessionId: "session-gc",
});

function effectiveScope() {
  return createEffectiveMcpRequestScopeV1({
    principalKey: scope.principalKey,
    transportMcpSessionId: scope.mcpSessionId,
    identityMcpSessionId: null,
    nowMs: 10_000,
  });
}

describe("WP-10 durable resource expiry GC", () => {
  it("keeps expired writing/active C39 rows as key pins until authenticated deletion", async () => {
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const owner = {
      tenantId: "tenant-gc", userId: "user-gc", principalKey: "tenant-gc:user-gc",
      effectiveMcpSessionId: "mcp-gc", sessionBindingId: "binding-gc",
      sessionBindingVersion: 1, rsid: "rsid-gc",
      recoveryInvocationId: "018f0f7a-3f5e-7c00-8000-000000000001",
      originInvocationId: "018f0f7a-3f5e-7c00-8000-000000000002",
      originResultDigest: `sha256:${"a".repeat(64)}`,
    };
    await restartable.store.transact({ tenantId: "tenant-gc" }, (tx) => {
      tx.stage({
        namespace: "gateway.recovery-chunk/v1", key: "expired-active",
        value: {
          schemaVersion: "revagent-gateway-recovery/v1", state: "active", owner,
          bridgeSequence: 1, chunkIndex: 0, kid: "kid-expired",
          storageKey: `sha256:${"b".repeat(64)}`,
          plainDigest: `sha256:${"c".repeat(64)}`,
          resultRefDigest: `sha256:${"d".repeat(64)}`,
          plainLength: 1, expiresAtMs: 1,
        },
        expect: { kind: "absent" },
      });
    });
    const inventory = new ResourceAuthorityProtectedKeyInventoryPort(
      restartable.store,
      { now: () => 1_000_000 },
    );
    await expect(inventory.listLiveKids()).resolves.toStrictEqual(["kid-expired"]);
  });

  it("keeps 2MiB-1, rejects 2MiB+1, and reclaims expired object plus metadata", async () => {
    let now = 10_000;
    const restartable = createRestartableTestStore();
    const store = restartable.store;
    await store.open();
    const objects = createMemoryObjectStore();
    let next = 0;
    const authority = new GatewayResourceAuthority({
      protocolStore: store,
      objectStore: objects,
      now: () => now,
      newRefId: () => `gc-${String(++next)}`,
      defaultTtlMs: 10,
      gcOwnerId: "gc-test-owner",
    });
    const accepted = await authority.uploadArtifact({
      scope,
      filename: "under.csv",
      contentType: "text/csv",
      quarantineStatus: "released",
      bytes: new Uint8Array(2 * 1024 * 1024 - 1),
    });
    await expect(authority.uploadArtifact({
      scope,
      filename: "over.csv",
      contentType: "text/csv",
      quarantineStatus: "released",
      bytes: new Uint8Array(2 * 1024 * 1024 + 1),
    })).rejects.toMatchObject({ code: "oversize" });
    expect(objects.keys()).toHaveLength(1);
    now += 10;
    await expect(authority.consumeArtifact(scope, effectiveScope(), accepted.refId)).rejects.toMatchObject({ code: "expired" });
    await expect(authority.collectExpired({ tenantId: scope.tenantId })).resolves.toEqual({
      scanned: 1,
      claimed: 1,
      deleted: 1,
      retained: 0,
    });
    expect(objects.keys()).toEqual([]);
    await expect(authority.consumeArtifact(scope, effectiveScope(), accepted.refId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("bounds GC claims and cannot collect another tenant's scoped metadata", async () => {
    let now = 20_000;
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const objects = createMemoryObjectStore();
    let next = 0;
    const authority = new GatewayResourceAuthority({
      protocolStore: restartable.store,
      objectStore: objects,
      now: () => now,
      newRefId: () => `ref-${String(++next)}`,
      defaultTtlMs: 1,
      gcOwnerId: "bounded-gc",
    });
    const other = Object.freeze({ ...scope, tenantId: "tenant-other", principalKey: "tenant-other:user-gc" });
    await authority.uploadArtifact({ scope, filename: "a.csv", contentType: "text/csv", quarantineStatus: "released", bytes: Buffer.from("a") });
    await authority.uploadArtifact({ scope: other, filename: "b.csv", contentType: "text/csv", quarantineStatus: "released", bytes: Buffer.from("b") });
    now += 1;
    await expect(authority.collectExpired({ tenantId: scope.tenantId, limit: 1 })).resolves.toMatchObject({ scanned: 1, deleted: 1 });
    expect(objects.keys()).toHaveLength(1);
    await expect(authority.collectExpired({ tenantId: "tenant-other", limit: 101 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("admits exactly 32MiB structured evidence and rejects the next byte", async () => {
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const authority = new GatewayResourceAuthority({
      protocolStore: restartable.store,
      objectStore: createMemoryObjectStore(),
      now: () => 30_000,
      newRefId: () => "result-limit",
      maxResultBytes: 32 * 1024 * 1024,
      maxResultPageBytes: 512 * 1024,
    });
    const exact = { value: "x".repeat(32 * 1024 * 1024 - 12) };
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(32 * 1024 * 1024);
    await expect(authority.boundResult({
      scope,
      effectiveMcpRequestScope: effectiveScope(),
      value: exact,
      maxInlineBytes: 0,
    })).resolves.toMatchObject({ kind: "result_ref", byteSize: 32 * 1024 * 1024 });
    const over = { value: `${exact.value}x` };
    await expect(authority.boundResult({
      scope,
      effectiveMcpRequestScope: effectiveScope(),
      value: over,
      maxInlineBytes: 0,
    })).rejects.toMatchObject({ code: "oversize" });
  });

  it("leaves no readable allocation when the byte store refuses the write", async () => {
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const objects = createMemoryObjectStore();
    vi.spyOn(objects, "put").mockResolvedValueOnce({
      ok: false,
      port: "object_store",
      code: "unavailable",
      message: "injected object failure",
    });
    const authority = new GatewayResourceAuthority({
      protocolStore: restartable.store,
      objectStore: objects,
      now: () => 40_000,
      newRefId: () => "failed-allocation",
    });
    await expect(authority.uploadArtifact({
      scope,
      filename: "failed.csv",
      contentType: "text/csv",
      quarantineStatus: "released",
      bytes: Buffer.from("x"),
    })).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(objects.keys()).toEqual([]);
    expect(restartable.snapshot().records.filter((record) => record.namespace === "gateway_resource_v1")).toEqual([]);
  });

  it("never exposes an allocating record while the object write is in flight", async () => {
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const objects = createMemoryObjectStore();
    const originalPut = objects.put.bind(objects);
    let entered!: () => void;
    let release!: () => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    const releaseWrite = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(objects, "put").mockImplementation(async (input) => {
      entered();
      await releaseWrite;
      return originalPut(input);
    });
    const authority = new GatewayResourceAuthority({
      protocolStore: restartable.store,
      objectStore: objects,
      now: () => 50_000,
      newRefId: () => "in-flight",
    });
    const pending = authority.uploadArtifact({
      scope,
      filename: "in-flight.csv",
      contentType: "text/csv",
      quarantineStatus: "released",
      bytes: Buffer.from("x"),
    });
    await enteredWrite;
    expect(restartable.snapshot().records).toContainEqual(expect.objectContaining({
      namespace: "gateway_resource_v1",
      value: expect.objectContaining({ lifecycle: "allocating" }),
    }));
    await expect(authority.consumeArtifact(scope, effectiveScope(), "in-flight")).rejects.toMatchObject({ code: "not_found" });
    release();
    await expect(pending).resolves.toMatchObject({ refId: "in-flight" });
  });

  it("fences a failed delete to its owner/version until the 60 second lease expires", async () => {
    let now = 70_000;
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const objects = createMemoryObjectStore();
    const first = new GatewayResourceAuthority({
      protocolStore: restartable.store,
      objectStore: objects,
      now: () => now,
      newRefId: () => "lease-fenced",
      defaultTtlMs: 1,
      gcOwnerId: "owner-one",
    });
    await first.uploadArtifact({ scope, filename: "lease.csv", contentType: "text/csv", quarantineStatus: "released", bytes: Buffer.from("x") });
    now += 1;
    vi.spyOn(objects, "delete").mockResolvedValueOnce({
      ok: false,
      port: "object_store",
      code: "unavailable",
      message: "injected delete fault",
    });
    await expect(first.collectExpired({ tenantId: scope.tenantId })).resolves.toEqual({ scanned: 1, claimed: 1, deleted: 0, retained: 1 });
    expect(restartable.snapshot().records).toContainEqual(expect.objectContaining({
      namespace: "gateway_resource_v1",
      value: expect.objectContaining({ lifecycle: "gc_claimed", gcLease: expect.objectContaining({ owner: "owner-one", expiresAtMs: now + 60_000 }) }),
    }));
    const second = new GatewayResourceAuthority({
      protocolStore: restartable.store,
      objectStore: objects,
      now: () => now,
      newRefId: () => "unused",
      gcOwnerId: "owner-two",
    });
    await expect(second.collectExpired({ tenantId: scope.tenantId })).resolves.toEqual({ scanned: 1, claimed: 0, deleted: 0, retained: 1 });
    now += 60_000;
    await expect(second.collectExpired({ tenantId: scope.tenantId })).resolves.toEqual({ scanned: 1, claimed: 1, deleted: 1, retained: 0 });
    expect(objects.keys()).toEqual([]);
    expect(restartable.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
  });

  it("fences carrier GC across set, chunks, members, acknowledgements, terminal, and identity", async () => {
    let now = 90_000;
    const restartable = createRestartableTestStore(); await restartable.store.open();
    const objects = createMemoryObjectStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const input = {
      scope, effectiveMcpRequestScope: effectiveScope(), rsid: "rsid-carrier-gc",
      invocationId: "0197a3c2-0000-7000-8000-000000000010",
      chunks: [{ kind: "chunk" as const, invocation_id: "0197a3c2-0000-7000-8000-000000000010", stream_id: "artifact:0197a3c2-0000-7000-8000-000000000201" as const, artifact_id: "0197a3c2-0000-7000-8000-000000000201", artifact_index: 0, chunk_index: 0, encoding: "base64" as const, content_type: "image/png", data: Buffer.from(bytes).toString("base64") }],
      manifest: { kind: "artifact_result" as const, descriptors: [{ artifact_id: "0197a3c2-0000-7000-8000-000000000201", artifact_index: 0, stream_id: "artifact:0197a3c2-0000-7000-8000-000000000201" as const, filename: "gc.png", content_type: "image/png", total_chunks: 1, total_size: bytes.byteLength, sha256: digest }], artifactReferences: [{ artifact_id: "0197a3c2-0000-7000-8000-000000000201", artifact_index: 0 }] },
    };
    let failures = 2; const originalDelete = objects.delete.bind(objects);
    vi.spyOn(objects, "delete").mockImplementation(async (request) => {
      if (request.storageKey.startsWith("carrier/quarantine/") && failures > 0) { failures -= 1; return { ok: false, port: "object_store", code: "unavailable", message: "carrier delete fault" } as const; }
      return originalDelete(request);
    });
    const one = new GatewayResourceAuthority({ protocolStore: restartable.store, objectStore: objects, now: () => now, defaultTtlMs: 1, gcOwnerId: "carrier-owner-one" });
    await one.ingestRbpArtifactCarrier(input); now += 1;
    await one.collectExpired({ tenantId: scope.tenantId });
    const first = restartable.snapshot().records.find((row) => row.namespace === "gateway.resource-set/v1")!.value as { gcLease: { token: string; expiresAtMs: number; owner: string }; state: string };
    expect(first).toMatchObject({ state: "gc_claimed", gcLease: { owner: "carrier-owner-one", expiresAtMs: now + 60_000 } });
    const two = new GatewayResourceAuthority({ protocolStore: restartable.store, objectStore: objects, now: () => now, gcOwnerId: "carrier-owner-two" });
    await expect(two.collectExpired({ tenantId: scope.tenantId })).resolves.toMatchObject({ claimed: 0, retained: 1 });
    now += 60_000;
    await one.collectExpired({ tenantId: scope.tenantId });
    const renewed = restartable.snapshot().records.find((row) => row.namespace === "gateway.resource-set/v1")!.value as { gcLease: { token: string; owner: string }; state: string };
    expect(renewed).toMatchObject({ state: "gc_claimed", gcLease: { owner: "carrier-owner-one" } });
    expect(renewed.gcLease.token).not.toBe(first.gcLease.token);
    await expect(two.collectExpired({ tenantId: scope.tenantId })).resolves.toMatchObject({ claimed: 0, retained: 1 });
    now += 60_000;
    await expect(two.collectExpired({ tenantId: scope.tenantId })).resolves.toMatchObject({ deleted: 1, retained: 0 });
    expect(objects.keys()).toEqual([]);
    expect(restartable.snapshot().records.filter((row) => ["gateway.resource-set/v1", "gateway.carrier-chunk/v1", "gateway.resource-set-member/v1", "gateway.carrier-ack/v1", "gateway.carrier-terminal/v1", "gateway.carrier-identity/v1", "gateway_resource_v1"].includes(row.namespace))).toEqual([]);
  });

  it("collects exactly 100 expired resources and leaves the +1 record for a later bounded pass", async () => {
    let now = 80_000;
    const restartable = createRestartableTestStore();
    await restartable.store.open();
    const objects = createMemoryObjectStore();
    let sequence = 0;
    const authority = new GatewayResourceAuthority({
      protocolStore: restartable.store,
      objectStore: objects,
      now: () => now,
      newRefId: () => `bounded-${String(++sequence)}`,
      defaultTtlMs: 1,
      gcOwnerId: "bounded-hundred",
    });
    await Promise.all(Array.from({ length: 101 }, (_, index) => authority.uploadArtifact({
      scope,
      filename: `bounded-${String(index)}.csv`,
      contentType: "text/csv",
      quarantineStatus: "released",
      bytes: Buffer.from("x"),
    })));
    now += 1;
    await expect(authority.collectExpired({ tenantId: scope.tenantId })).resolves.toEqual({ scanned: 100, claimed: 100, deleted: 100, retained: 0 });
    expect(objects.keys()).toHaveLength(1);
    await expect(authority.collectExpired({ tenantId: scope.tenantId })).resolves.toEqual({ scanned: 1, claimed: 1, deleted: 1, retained: 0 });
    expect(objects.keys()).toEqual([]);
  });
});
