import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { ConformanceProtectedObjectKeyProvider } from "./protectedObjectKeyProvider.js";
import { EncryptedProtectedObjectStore } from "./protectedObjectStore.js";
import {
  GatewayResourceAuthority,
  recoveryResultRefDigest,
  type GatewayResourceScope,
  type RecoveryOwner,
} from "./resourceAuthority.js";
import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import { createMemoryObjectStore, createRestartableTestStore } from "./testAdapters.js";
import type { StoreTransaction } from "./store.js";

const scope: GatewayResourceScope = Object.freeze({ tenantId: "tenant-c39", actorId: "user-c39", principalKey: "tenant-c39:user-c39", mcpSessionId: "mcp-c39" });
const effective = createEffectiveMcpRequestScopeV1({ principalKey: scope.principalKey, transportMcpSessionId: scope.mcpSessionId, identityMcpSessionId: null, nowMs: 1_775_000_000_000 });
const digest = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function owner(raw: Uint8Array): RecoveryOwner {
  return Object.freeze({ tenantId: scope.tenantId, userId: scope.actorId, principalKey: scope.principalKey, effectiveMcpSessionId: scope.mcpSessionId, sessionBindingId: "binding-c39", sessionBindingVersion: 1, rsid: "rsid-c39", recoveryInvocationId: "0197a3c2-0000-7000-8000-000000000111", originInvocationId: "0197a3c2-0000-7000-8000-000000000112", originResultDigest: digest(raw) });
}

describe("C39 recovery resource authority", () => {
  let now = 1_775_000_000_000;
  beforeEach(() => { now = 1_775_000_000_000; });

  function subject(options: { readonly authorize?: () => boolean } = {}) {
    const state = createRestartableTestStore();
    const objects = createMemoryObjectStore();
    const inventory = Object.freeze({ kind: "conformance" as const, async listLiveKids() { return Object.freeze(["c39-test-key"]); } });
    const keys = new ConformanceProtectedObjectKeyProvider("c39-test-key", new Map([["c39-test-key", Buffer.alloc(32, 7)]]), inventory);
    const authority = new GatewayResourceAuthority({ protocolStore: state.store, objectStore: objects, protectedObjectStore: new EncryptedProtectedObjectStore(objects, keys), reauthorizeRecoveryScope: () => options.authorize?.() === false ? null : Object.freeze({ sessionBindingId: "binding-c39", sessionBindingVersion: 1 }), now: () => now, newRefId: () => "recovery-ref-1" });
    return { state, objects, authority };
  }

  it("encrypts staged bytes and returns only a scoped result reference after current-scope reauth", async () => {
    const raw = Buffer.from('{"recovered":true}', "utf8");
    const { state, objects, authority } = subject();
    await expect(state.store.open()).resolves.toMatchObject({ ok: true });
    const inputOwner = owner(raw);
    await authority.stageRecoveryChunk({ scope, effectiveMcpRequestScope: effective, owner: inputOwner, bridgeSequence: 4, chunkIndex: 0, data: raw.toString("base64"), contentType: "application/json", expiresAtMs: now + 60_000 });
    expect(objects.keys()).toHaveLength(1);
    const ref = await authority.finalizeRecoveryResultRef({ scope, effectiveMcpRequestScope: effective, owner: inputOwner, terminalChunkCount: 1, terminalByteLength: raw.byteLength, expiresAtMs: now + 60_000 });
    expect(ref).toMatchObject({ kind: "result_ref", refId: "recovery-ref-1", digest: recoveryResultRefDigest(raw) });
    expect(ref.digest).not.toBe(digest(raw));
    expect(JSON.stringify(ref)).not.toContain("recovered");
    const read = await authority.readResource(scope, effective, new URL(ref.uri));
    expect(Buffer.from(read.bytes)).toEqual(raw);
  });

  it("fails closed on duplicate mismatch, post-stream binding drift, and foreign read scope", async () => {
    const raw = Buffer.from('{"recovered":true}', "utf8");
    let allowed = true;
    const { state, authority } = subject({ authorize: () => allowed });
    await state.store.open();
    const inputOwner = owner(raw);
    const stage = { scope, effectiveMcpRequestScope: effective, owner: inputOwner, bridgeSequence: 4, chunkIndex: 0, data: raw.toString("base64"), contentType: "application/json" as const, expiresAtMs: now + 60_000 };
    await authority.stageRecoveryChunk(stage);
    await expect(authority.stageRecoveryChunk({ ...stage, data: Buffer.from("different").toString("base64") })).rejects.toMatchObject({ code: "not_found" });
    allowed = false;
    await expect(authority.finalizeRecoveryResultRef({ scope, effectiveMcpRequestScope: effective, owner: inputOwner, terminalChunkCount: 1, terminalByteLength: raw.byteLength, expiresAtMs: now + 60_000 })).rejects.toMatchObject({ code: "scope_denied" });
    allowed = true;
    const ref = await authority.finalizeRecoveryResultRef({ scope, effectiveMcpRequestScope: effective, owner: inputOwner, terminalChunkCount: 1, terminalByteLength: raw.byteLength, expiresAtMs: now + 60_000 });
    const foreign = Object.freeze({ ...scope, actorId: "other", principalKey: "tenant-c39:other" });
    const foreignEffective = createEffectiveMcpRequestScopeV1({ principalKey: foreign.principalKey, transportMcpSessionId: foreign.mcpSessionId, identityMcpSessionId: null, nowMs: now });
    await expect(authority.readResource(foreign, foreignEffective, new URL(ref.uri))).rejects.toMatchObject({ code: "scope_denied" });
  });

  it("joins concurrent immutable retries but rejects sequence gaps and reauths an active completion", async () => {
    const raw = Buffer.from('{"one":1,"two":2}', "utf8");
    let allowed = true;
    const { state, authority } = subject({ authorize: () => allowed });
    await state.store.open();
    const inputOwner = owner(raw);
    const first = Buffer.from('{"one":1,', "utf8");
    const second = Buffer.from('"two":2}', "utf8");
    const common = { scope, effectiveMcpRequestScope: effective, owner: inputOwner, contentType: "application/json" as const, expiresAtMs: now + 60_000 };
    await expect(authority.stageRecoveryChunk({ ...common, bridgeSequence: 5, chunkIndex: 1, data: second.toString("base64") })).rejects.toMatchObject({ code: "not_found" });
    await Promise.all([
      authority.stageRecoveryChunk({ ...common, bridgeSequence: 4, chunkIndex: 0, data: first.toString("base64") }),
      authority.stageRecoveryChunk({ ...common, bridgeSequence: 4, chunkIndex: 0, data: first.toString("base64") }),
    ]);
    await authority.stageRecoveryChunk({ ...common, bridgeSequence: 5, chunkIndex: 1, data: second.toString("base64") });
    const ref = await authority.finalizeRecoveryResultRef({ scope, effectiveMcpRequestScope: effective, owner: inputOwner, terminalChunkCount: 2, terminalByteLength: raw.byteLength, expiresAtMs: now + 60_000 });
    expect(ref.digest).toBe(recoveryResultRefDigest(raw));
    expect(ref.digest).not.toBe(inputOwner.originResultDigest);
    allowed = false;
    await expect(authority.finalizeRecoveryResultRef({ scope, effectiveMcpRequestScope: effective, owner: inputOwner, terminalChunkCount: 2, terminalByteLength: raw.byteLength, expiresAtMs: now + 60_000 })).rejects.toMatchObject({ code: "not_found" });
    await expect(authority.readResource(scope, effective, new URL(ref.uri))).rejects.toMatchObject({ code: "not_found" });
  });

  it("makes concurrent same-first staging invoke the exact active receipt callback for both callers", async () => {
    const raw = Buffer.from('{"duplicate":true}', "utf8");
    const { state, authority } = subject();
    await state.store.open();
    const inputOwner = owner(raw);
    let callbackCount = 0;
    const input = {
      scope, effectiveMcpRequestScope: effective, owner: inputOwner,
      bridgeSequence: 3, chunkIndex: 0, data: raw.toString("base64"),
      contentType: "application/json" as const, expiresAtMs: now + 60_000,
      commitBridge: async (tx: StoreTransaction) => {
        callbackCount += 1;
        const current = await tx.read("c39-test-bridge", "last-rx");
        tx.stage({ namespace: "c39-test-bridge", key: "last-rx", value: { lastRxSeq: 3, duplicate: current !== null }, expect: current === null ? { kind: "absent" } : { kind: "version", version: current.version } });
      },
    };
    await Promise.all([authority.stageRecoveryChunk(input), authority.stageRecoveryChunk(input)]);
    // A failed CAS may execute a staged callback before its transaction rolls
    // back; the durable bridge record, not an in-memory counter, proves both
    // callers received exactly one committed continuation.
    expect(callbackCount).toBeGreaterThanOrEqual(2);
    expect(state.snapshot().records.find((row) => row.namespace === "gateway.recovery-chunk/v1")?.value).toMatchObject({ state: "active", bridgeSequence: 3 });
    expect(state.snapshot().records.find((row) => row.namespace === "c39-test-bridge")).toMatchObject({ version: 2, value: { lastRxSeq: 3, duplicate: true } });
    await expect(authority.stageRecoveryChunk({ ...input, data: Buffer.from("mismatch").toString("base64") })).rejects.toMatchObject({ code: "not_found" });
    expect(state.snapshot().records.find((row) => row.namespace === "c39-test-bridge")?.version).toBe(2);
  });

  it("retries a durable seq-5/index-0 writing receipt through one atomic activation and Bridge continuation", async () => {
    const raw = Buffer.from('{"restart":true}', "utf8");
    const { state, authority } = subject();
    await state.store.open();
    const inputOwner = owner(raw);
    const input = {
      scope,
      effectiveMcpRequestScope: effective,
      owner: inputOwner,
      bridgeSequence: 5,
      chunkIndex: 0,
      data: raw.toString("base64"),
      contentType: "application/json" as const,
      expiresAtMs: now + 60_000,
    };
    await expect(authority.stageRecoveryChunk({
      ...input,
      commitBridge: async () => {
        throw new Error("simulated post-write interruption");
      },
    })).rejects.toBeDefined();
    expect(state.snapshot().records.find((row) => row.namespace === "gateway.recovery-chunk/v1")?.value)
      .toMatchObject({ state: "writing", bridgeSequence: 5, chunkIndex: 0 });
    await authority.stageRecoveryChunk({
      ...input,
      commitBridge: async (tx) => {
        tx.stage({
          namespace: "c39-test-bridge",
          key: "seq-5",
          value: { lastRxSeq: 5 },
          expect: { kind: "absent" },
        });
      },
    });
    expect(state.snapshot().records.find((row) => row.namespace === "gateway.recovery-chunk/v1")?.value)
      .toMatchObject({ state: "active", bridgeSequence: 5, chunkIndex: 0 });
    expect(state.snapshot().records.find((row) => row.namespace === "c39-test-bridge")?.value)
      .toEqual({ lastRxSeq: 5 });
  });

  it("keeps a derived result-ref and terminal acknowledgement uncommitted when the exact completion callback rejects", async () => {
    const raw = Buffer.from('{"terminal":"guarded"}', "utf8");
    const { state, authority } = subject();
    await state.store.open();
    const inputOwner = owner(raw);
    await authority.stageRecoveryChunk({
      scope,
      effectiveMcpRequestScope: effective,
      owner: inputOwner,
      bridgeSequence: 5,
      chunkIndex: 0,
      data: raw.toString("base64"),
      contentType: "application/json",
      expiresAtMs: now + 60_000,
    });
    const bridgeDigest: { current: string | null } = { current: null };
    await expect(authority.finalizeRecoveryResultRef({
      scope,
      effectiveMcpRequestScope: effective,
      owner: inputOwner,
      terminalChunkCount: 1,
      terminalByteLength: raw.byteLength,
      expiresAtMs: now + 60_000,
      commitBridge: async (_tx, resultReferenceDigest) => {
        bridgeDigest.current = resultReferenceDigest;
        throw new Error("exact Bridge completion rejected");
      },
    })).rejects.toBeDefined();
    expect(bridgeDigest.current).toBe(recoveryResultRefDigest(raw));
    expect(await authority.resumeRecoveryResultRef({
      scope,
      effectiveMcpRequestScope: effective,
      owner: inputOwner,
    })).toBeNull();
    expect(state.snapshot().records.find((row) => row.namespace === "gateway_resource_v1")?.value)
      .toMatchObject({ lifecycle: "allocating" });
    expect(state.snapshot().records.find((row) => row.namespace === "gateway.recovery-completion/v1")?.value)
      .toMatchObject({ state: "writing" });
  });
});
