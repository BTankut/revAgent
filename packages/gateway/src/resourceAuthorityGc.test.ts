import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import { describe, expect, it } from "vitest";
import {
  GatewayResourceAuthority,
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
});
