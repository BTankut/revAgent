import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ArtifactDescriptor, RbpStreamChunk } from "@revagent/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BridgeCarrierTerminalAborted,
  GatewayResourceAuthority,
  type GatewayResourceError,
  type GatewayResourceScope,
} from "./resourceAuthority.js";
import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import {
  createMemoryObjectStore,
  createRestartableTestStore,
  type MemoryObjectStore,
  type RestartableTestStore,
} from "./testAdapters.js";
import type { GatewayProtocolStore, StoreTransaction } from "./store.js";

const invocationId = "0197a3c2-0000-7000-8000-000000000010";
const artifactA = "0197a3c2-0000-7000-8000-000000000201";
const artifactB = "0197a3c2-0000-7000-8000-000000000202";
type ScopedUriComparisonSlot = "p" | "s" | "t" | "a";
const scope: GatewayResourceScope = Object.freeze({
  tenantId: "tenant-1",
  actorId: "user-1",
  principalKey: "tenant-1:user-1",
  mcpSessionId: "mcp-session-1",
});
const effectiveMcpRequestScope = createEffectiveMcpRequestScopeV1({
  principalKey: scope.principalKey,
  transportMcpSessionId: scope.mcpSessionId,
  identityMcpSessionId: null,
  nowMs: 1_775_000_000_000,
});

function effectiveScopeFor(input: GatewayResourceScope) {
  return createEffectiveMcpRequestScopeV1({
    principalKey: input.principalKey,
    transportMcpSessionId: input.mcpSessionId,
    identityMcpSessionId: null,
    nowMs: 1_775_000_000_000,
  });
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifactChunk(
  artifactId: string,
  artifactIndex: number,
  bytes: Uint8Array,
  chunkIndex = 0,
): RbpStreamChunk {
  return {
    kind: "chunk",
    invocation_id: invocationId,
    stream_id: `artifact:${artifactId}`,
    artifact_id: artifactId,
    artifact_index: artifactIndex,
    chunk_index: chunkIndex,
    encoding: "base64",
    content_type: "image/png",
    data: Buffer.from(bytes).toString("base64"),
  };
}

function resultChunk(
  bytes: Uint8Array,
  chunkIndex = 0,
): RbpStreamChunk {
  return {
    kind: "chunk",
    invocation_id: invocationId,
    stream_id: "result",
    chunk_index: chunkIndex,
    encoding: "base64",
    content_type: "application/json",
    data: Buffer.from(bytes).toString("base64"),
  };
}

function descriptor(
  artifactId: string,
  artifactIndex: number,
  bytes: Uint8Array,
  filename: string,
): ArtifactDescriptor {
  return {
    artifact_id: artifactId,
    artifact_index: artifactIndex,
    stream_id: `artifact:${artifactId}`,
    filename,
    content_type: "image/png",
    total_chunks: 1,
    total_size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function chunkedDescriptor(
  artifactId: string,
  artifactIndex: number,
  bytes: Uint8Array,
  filename: string,
  totalChunks: number,
): ArtifactDescriptor {
  return {
    ...descriptor(artifactId, artifactIndex, bytes, filename),
    total_chunks: totalChunks,
  };
}

function splitArtifactChunks(
  artifactId: string,
  artifactIndex: number,
  bytes: Uint8Array,
  chunkSize: number,
): readonly RbpStreamChunk[] {
  const chunks: RbpStreamChunk[] = [];
  for (let start = 0, index = 0; start < bytes.byteLength; start += chunkSize, index += 1) {
    chunks.push(artifactChunk(artifactId, artifactIndex, bytes.slice(start, start + chunkSize), index));
  }
  return chunks;
}

function expectResourceError(
  operation: Promise<unknown>,
  code: GatewayResourceError["code"],
): Promise<void> {
  return expect(operation).rejects.toMatchObject({
    name: "GatewayResourceError",
    code,
  });
}

describe("GW-9 scoped artifact and result authority", () => {
  it("pins protected keys through every live and deletion state", async () => {
    const source = await readFile(new URL("./resourceAuthority.ts", import.meta.url), "utf8");
    expect(source).toContain('chunk.state === "writing" || chunk.state === "active" || chunk.state === "deleting"');
    expect(source).toContain('["allocating", "active", "deleting", "claimed"]');
    expect(source).not.toContain("expiresAtMs > this.#now()");
  });

  let now: number;
  let restartableStore: RestartableTestStore;
  let protocolStore: GatewayProtocolStore;
  let objectStore: MemoryObjectStore;
  let authority: GatewayResourceAuthority;
  let refSequence: number;
  let comparisonSlots: ScopedUriComparisonSlot[];

  beforeEach(async () => {
    now = 10_000;
    refSequence = 0;
    comparisonSlots = [];
    restartableStore = createRestartableTestStore();
    protocolStore = restartableStore.store;
    await protocolStore.open();
    objectStore = createMemoryObjectStore();
    const authorityOptions = {
      protocolStore,
      objectStore,
      now: () => now,
      newRefId: () => `ref-${String(++refSequence)}`,
      maxUploadBytes: 16,
      maxResultBytes: 128,
      maxResultPageBytes: 8,
      defaultTtlMs: 1_000,
    };
    Object.defineProperty(
      authorityOptions,
      "__revAgentTestObserveScopedUriComparison",
      {
        configurable: true,
        enumerable: false,
        value: (slot: ScopedUriComparisonSlot) => comparisonSlots.push(slot),
      },
    );
    authority = new GatewayResourceAuthority(authorityOptions);
  });

  it("uploads an allowlisted CSV and gives a file-aware executor bytes, never a path", async () => {
    const bytes = Buffer.from("mark,count\nA,2\n", "utf8");
    const ref = await authority.uploadArtifact({
      scope,
      filename: "schedule.csv",
      contentType: "text/csv",
      quarantineStatus: "released",
      bytes,
      expectedDigest: sha256(bytes),
    });

    expect(ref).toMatchObject({
      kind: "artifact_ref",
      uri: expect.stringMatching(/^revagent:\/\/artifact\/p\/[0-9a-f]{64}\/s\/[0-9a-f]{64}\/t\/[0-9a-f]{64}\/a\/[0-9a-f]{64}\/r\/[0-9a-f]{64}$/u),
      filename: "schedule.csv",
      contentType: "text/csv",
      byteSize: bytes.byteLength,
    });
    const consumed = await authority.consumeArtifact(
      scope,
      effectiveMcpRequestScope,
      ref.refId,
    );
    expect(Buffer.from(consumed.bytes).toString("utf8")).toBe(
      "mark,count\nA,2\n",
    );
    expect(JSON.stringify(consumed)).not.toContain("schedule.csv");
    expect(JSON.stringify(consumed)).not.toMatch(/[A-Za-z]:\\/u);
  });

  it("keeps a quarantined upload durable but unreadable", async () => {
    const ref = await authority.uploadArtifact({
      scope,
      filename: "pending.csv",
      contentType: "text/csv",
      quarantineStatus: "quarantined",
      bytes: Buffer.from("a,b\n", "utf8"),
    });
    expect(ref).toMatchObject({
      kind: "artifact_ref",
      filename: "pending.csv",
    });
    await expectResourceError(
      authority.consumeArtifact(scope, effectiveMcpRequestScope, ref.refId),
      "quarantined",
    );
  });

  it("fails closed on raw paths, denied types, oversize, and expected digest mismatch", async () => {
    const bytes = Buffer.from("a,b\n", "utf8");
    await expectResourceError(
      authority.uploadArtifact({
        scope,
        filename: "C:\\Users\\BT\\secret.csv",
        contentType: "text/csv",
        quarantineStatus: "released",
        bytes,
      }),
      "invalid_input",
    );
    await expectResourceError(
      authority.uploadArtifact({
        scope,
        filename: "payload.exe",
        contentType: "application/octet-stream",
        quarantineStatus: "released",
        bytes,
      }),
      "content_type_denied",
    );
    await expectResourceError(
      authority.uploadArtifact({
        scope,
        filename: "large.csv",
        contentType: "text/csv",
        quarantineStatus: "released",
        bytes: new Uint8Array(17),
      }),
      "oversize",
    );
    await expectResourceError(
      authority.uploadArtifact({
        scope,
        filename: "digest.csv",
        contentType: "text/csv",
        quarantineStatus: "released",
        bytes,
        expectedDigest: `sha256:${"0".repeat(64)}`,
      }),
      "digest_mismatch",
    );
    // Invalid terminals never publish north-facing resources.  Durable chunks
    // may remain quarantined for fenced cleanup/restart inspection.
    expect(restartableStore.snapshot().records.filter((record) => record.namespace === "gateway_resource_v1")).toEqual([]);
  });

  it("hash-prefixes durable keys and rejects foreign effective scopes before metadata or object lookup", async () => {
    const ref = await authority.uploadArtifact({
      scope,
      filename: "source.tsv",
      contentType: "text/tab-separated-values",
      quarantineStatus: "released",
      bytes: Buffer.from("A\t2", "utf8"),
    });
    const objectGet = vi.spyOn(objectStore, "get");
    const transact = vi.spyOn(protocolStore, "transact");
    const uriParts = new URL(ref.uri).pathname.split("/");
    const deniedUris = [
      { label: "malformed", index: 1, value: "invalid-scope-label" },
      { label: "principal", index: 2, value: "f".repeat(64) },
      { label: "session", index: 4, value: "f".repeat(64) },
      { label: "tenant", index: 6, value: "f".repeat(64) },
      { label: "actor", index: 8, value: "f".repeat(64) },
    ];
    for (const denied of deniedUris) {
      const deniedUri = new URL(ref.uri);
      const parts = [...uriParts];
      parts[denied.index] = denied.value;
      deniedUri.pathname = parts.join("/");
      comparisonSlots = [];
      await expectResourceError(
        authority.readResource(
          scope,
          effectiveMcpRequestScope,
          deniedUri,
        ),
        "scope_denied",
      );
      expect(comparisonSlots).toEqual(["p", "s", "t", "a"]);
    }
    comparisonSlots = [];
    await expectResourceError(
      authority.readResource(
        { ...scope, tenantId: "tenant-2" },
        effectiveMcpRequestScope,
        new URL(ref.uri),
      ),
      "scope_denied",
    );
    expect(comparisonSlots).toEqual(["p", "s", "t", "a"]);
    expect(objectGet).not.toHaveBeenCalled();
    expect(transact).not.toHaveBeenCalled();

    comparisonSlots = [];
    await expectResourceError(
      authority.readResource(
        scope,
        effectiveMcpRequestScope,
        new URL(`revagent://artifact/${ref.refId}`),
      ),
      "scope_denied",
    );
    expect(comparisonSlots).toEqual(["p", "s", "t", "a"]);
    expect(objectGet).not.toHaveBeenCalled();
    expect(transact).not.toHaveBeenCalled();

    const sameBearerOtherSession = Object.freeze({
      ...scope,
      mcpSessionId: "mcp-session-2",
    });
    comparisonSlots = [];
    await expectResourceError(
      authority.readResource(
        sameBearerOtherSession,
        effectiveScopeFor(sameBearerOtherSession),
        new URL(ref.uri),
      ),
      "scope_denied",
    );
    expect(comparisonSlots).toEqual(["p", "s", "t", "a"]);
    expect(objectGet).not.toHaveBeenCalled();
    expect(transact).not.toHaveBeenCalled();

    const [key] = objectStore.keys();
    expect(key).toMatch(
      /^p:[0-9a-f]{64}\/s:[0-9a-f]{64}\/t:[0-9a-f]{64}\/a:[0-9a-f]{64}\/artifact_ref\/r:[0-9a-f]{64}$/u,
    );
    objectStore.corrupt(key!, Buffer.from("changed", "utf8"));
    await expectResourceError(
      authority.consumeArtifact(scope, effectiveMcpRequestScope, ref.refId),
      "digest_mismatch",
    );

    now = ref.expiresAtMs;
    await expectResourceError(
      authority.consumeArtifact(scope, effectiveMcpRequestScope, ref.refId),
      "expired",
    );
  });

  it("bounds oversized structured JSON into independently digest-checked pages", async () => {
    const value = Object.freeze({ rows: ["alpha", "beta", "gamma"] });
    await expect(
      authority.boundResult({
        scope,
        effectiveMcpRequestScope,
        value,
        maxInlineBytes: 200,
      }),
    ).resolves.toEqual({ kind: "inline", value });

    const ref = await authority.boundResult({
      scope,
      effectiveMcpRequestScope,
      value,
      maxInlineBytes: 4,
    });
    expect(ref.kind).toBe("result_ref");
    if (ref.kind !== "result_ref") {
      throw new Error("expected result_ref");
    }
    expect(ref.pageCount).toBeGreaterThan(1);
    const collected: Buffer[] = [];
    for (let page = 0; page < ref.pageCount; page += 1) {
      const read = await authority.readResource(
        scope,
        effectiveMcpRequestScope,
        new URL(page === 0 ? ref.uri : ref.uri.replace(/\/page\/0$/u, `/page/${String(page)}`)),
      );
      expect(read.digest).toBe(sha256(read.bytes));
      expect(read.nextPageUri).toBe(
        page + 1 < ref.pageCount
          ? ref.uri.replace(/\/page\/0$/u, `/page/${String(page + 1)}`)
          : null,
      );
      collected.push(Buffer.from(read.bytes));
    }
    expect(JSON.parse(Buffer.concat(collected).toString("utf8"))).toEqual(value);
    await expectResourceError(
      authority.readResource(
        { ...scope, mcpSessionId: "foreign" },
        effectiveScopeFor({ ...scope, mcpSessionId: "foreign" }),
        new URL(ref.uri),
      ),
      "scope_denied",
    );
  });

  it("publishes a two-image RBP carrier only after all siblings validate", async () => {
    const bytesA = new Uint8Array([137, 80, 78, 71, 1]);
    const bytesB = new Uint8Array([137, 80, 78, 71, 2]);
    const descriptors = [
      descriptor(artifactA, 0, bytesA, "plan.png"),
      descriptor(artifactB, 1, bytesB, "detail.png"),
    ] as const;
    const artifactReferences = [
      { artifact_id: artifactA, artifact_index: 0 },
      { artifact_id: artifactB, artifact_index: 1 },
    ] as const;

    const refs = await authority.ingestRbpArtifactCarrier({
      scope,
      effectiveMcpRequestScope,
      rsid: "rsid-resource-a",
      invocationId,
      chunks: [
        artifactChunk(artifactA, 0, bytesA),
        artifactChunk(artifactB, 1, bytesB),
      ],
      manifest: { kind: "artifact_result", descriptors, artifactReferences },
    });
    expect(refs).toMatchObject([
      { filename: "plan.png", contentType: "image/png" },
      { filename: "detail.png", contentType: "image/png" },
    ]);
    await expect(
      Promise.all(refs.map((ref) => authority.readResource(scope, effectiveMcpRequestScope, new URL(ref.uri)))),
    ).resolves.toMatchObject([
      { contentType: "image/png", nextPageUri: null },
      { contentType: "image/png", nextPageUri: null },
    ]);
    const durable = restartableStore.snapshot().records;
    const set = durable.find((record) => record.namespace === "gateway.resource-set/v1");
    expect(set?.value).toMatchObject({
      rsid: "rsid-resource-a",
      invocationId,
      tenantId: scope.tenantId,
      principalKey: scope.principalKey,
      effectiveMcpSessionId: scope.mcpSessionId,
      state: "active",
    });
    expect((set?.value as { setId?: string } | undefined)?.setId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(durable.filter((record) => record.namespace === "gateway.carrier-chunk/v1")).toHaveLength(2);
    expect(durable.filter((record) => record.namespace === "gateway.resource-set-member/v1")).toHaveLength(2);
    expect(durable.filter((record) => record.namespace === "gateway.carrier-ack/v1").map((record) => record.value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "chunk_durable", seq: 0 }),
        expect.objectContaining({ state: "terminal_accepted" }),
      ]),
    );

    const restartedStore = restartableStore.restart();
    await restartedStore.open();
    const restartedAuthority = new GatewayResourceAuthority({
      protocolStore: restartedStore,
      objectStore,
      now: () => now,
      newRefId: () => "unused-after-restart",
    });
    await expect(
      restartedAuthority.readResource(scope, effectiveMcpRequestScope, new URL(refs[1]!.uri)),
    ).resolves.toMatchObject({ contentType: "image/png" });
    now = refs[0]!.expiresAtMs;
    await expect(authority.collectExpired({ tenantId: scope.tenantId })).resolves.toMatchObject({
      scanned: 3,
      claimed: 3,
      deleted: 3,
      retained: 0,
    });
    expect(objectStore.keys()).toEqual([]);
    expect(restartableStore.snapshot().records.filter((row) => [
      "gateway_resource_v1", "gateway.resource-set/v1", "gateway.carrier-chunk/v1",
      "gateway.resource-set-member/v1", "gateway.carrier-ack/v1", "gateway.carrier-identity/v1",
      "gateway.carrier-terminal/v1",
    ].includes(row.namespace))).toEqual([]);
  });

  it("binds direct durable receipt to the effective scope and rejects a conflicting replay", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const setId = "0197a3c2-0000-7000-8000-000000000099";
    const staged = {
      scope,
      effectiveMcpRequestScope,
      setId,
      rsid: "rsid-direct-stage",
      invocationId,
      streamDigest: createHash("sha256").update("artifact:direct").digest("hex"),
      chunkIndex: 0,
      sequence: 3,
      bytes,
      digest: sha256(bytes),
      streamId: "artifact:direct",
      contentType: "image/png",
      artifactId: "direct",
      artifactIndex: 0,
    } as const;
    await authority.stageChunk(staged);
    await authority.stageChunk(staged);
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway.carrier-ack/v1")).toContainEqual(expect.objectContaining({
      value: expect.objectContaining({ state: "chunk_durable", seq: 3, setId }),
    }));
    await expectResourceError(authority.stageChunk({ ...staged, bytes: new Uint8Array([9]), digest: sha256(new Uint8Array([9])) }), "protocol_fault");
    await expectResourceError(authority.stageChunk({ ...staged, effectiveMcpRequestScope: effectiveScopeFor({ ...scope, mcpSessionId: "other" }) }), "scope_denied");
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
    await expect(authority.recoverAll({ scope, effectiveMcpRequestScope })).resolves.toEqual([]);
    expect(objectStore.keys()).toEqual([]);
    expect(restartableStore.snapshot().records.filter((row) => row.namespace.startsWith("gateway.carrier") || row.namespace === "gateway.resource-set/v1")).toEqual([]);
  });

  it("commits the Bridge receipt and terminal callbacks with carrier Tx-B and Tx-C", async () => {
    const bytes = new Uint8Array([4, 2, 4, 2]);
    const rsid = "rsid-bridge-atomic-carrier";
    const bridgeNamespace = "gateway.test-bridge-carrier/v1";
    expect(authority.isBridgeCarrierReady(protocolStore)).toBe(true);
    let chunkCommitted = false;
    await authority.acceptBridgeChunk({
      scope,
      effectiveMcpRequestScope,
      rsid,
      invocationId,
      sequence: 7,
      chunk: artifactChunk(artifactA, 0, bytes),
      commitBridge: (tx) => {
        tx.stage({ namespace: bridgeNamespace, key: "chunk", value: { state: "rx-advanced" }, expect: { kind: "absent" } });
        chunkCommitted = true;
      },
    });
    expect(chunkCommitted).toBe(true);
    const afterChunk = restartableStore.snapshot().records;
    expect(afterChunk.find((row) => row.namespace === bridgeNamespace && row.key === "chunk")).toBeDefined();
    expect(afterChunk.find((row) => row.namespace === "gateway.carrier-ack/v1")?.value).toMatchObject({ state: "chunk_durable", seq: 7 });

    let terminalCommitted = false;
    const refs = await authority.acceptBridgeTerminal({
      scope,
      effectiveMcpRequestScope,
      rsid,
      invocationId,
      manifest: {
        kind: "artifact_result",
        descriptors: [descriptor(artifactA, 0, bytes, "atomic.png")],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
      },
      commitBridge: (tx) => {
        tx.stage({ namespace: bridgeNamespace, key: "terminal", value: { state: "pending-cleared" }, expect: { kind: "absent" } });
        terminalCommitted = true;
      },
    });
    expect(refs).toHaveLength(1);
    expect(terminalCommitted).toBe(true);
    const afterTerminal = restartableStore.snapshot().records;
    expect(afterTerminal.find((row) => row.namespace === bridgeNamespace && row.key === "terminal")).toBeDefined();
    expect(afterTerminal.find((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "terminal_accepted")).toBeDefined();
    expect(afterTerminal.filter((row) => row.namespace === "gateway_resource_v1")).toHaveLength(1);
  });

  it("releases a chunked JSON result only after its terminal Tx-C callback", async () => {
    const bytes = Buffer.from('{"safe":true,"count":2}', "utf8");
    const rsid = "rsid-bridge-chunked-result";
    const bridgeNamespace = "gateway.test-bridge-result/v1";
    await authority.acceptBridgeChunk({
      scope,
      effectiveMcpRequestScope,
      rsid,
      invocationId,
      sequence: 11,
      chunk: resultChunk(bytes),
      commitBridge: (tx) => tx.stage({ namespace: bridgeNamespace, key: "chunk", value: { state: "durable" }, expect: { kind: "absent" } }),
    });
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
    const result = await authority.acceptBridgeChunkedResultTerminal({
      scope,
      effectiveMcpRequestScope,
      rsid,
      invocationId,
      manifest: {
        kind: "chunked_result",
        descriptor: {
          stream_id: "result",
          content_type: "application/json",
          total_chunks: 1,
          total_size: bytes.byteLength,
          sha256: sha256(bytes),
        },
      },
      commitBridge: (tx) => tx.stage({ namespace: bridgeNamespace, key: "terminal", value: { state: "accepted" }, expect: { kind: "absent" } }),
    });
    expect(result).toEqual({ safe: true, count: 2 });
    const committed = restartableStore.snapshot().records;
    expect(committed.find((row) => row.namespace === bridgeNamespace && row.key === "terminal")).toBeDefined();
    expect(committed.find((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "terminal_accepted")).toBeDefined();
  });

  it("aborts both terminal carrier forms before activation or terminal ACK", async () => {
    const artifactBytes = new Uint8Array([8, 6, 7, 5]);
    const jsonBytes = Buffer.from('{"private":true}', "utf8");
    const abort = () => ({ kind: "aborted" as const, reason: "terminal_revoked" as const });
    await authority.acceptBridgeChunk({
      scope, effectiveMcpRequestScope, rsid: "rsid-abort-artifact", invocationId,
      sequence: 17, chunk: artifactChunk(artifactA, 0, artifactBytes), commitBridge: () => undefined,
    });
    await expect(authority.acceptBridgeTerminal({
      scope, effectiveMcpRequestScope, rsid: "rsid-abort-artifact", invocationId,
      manifest: {
        kind: "artifact_result",
        descriptors: [descriptor(artifactA, 0, artifactBytes, "private.png")],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
      },
      commitBridge: abort,
    })).rejects.toBeInstanceOf(BridgeCarrierTerminalAborted);
    await authority.acceptBridgeChunk({
      scope, effectiveMcpRequestScope, rsid: "rsid-abort-json", invocationId,
      sequence: 19, chunk: resultChunk(jsonBytes), commitBridge: () => undefined,
    });
    await expect(authority.acceptBridgeChunkedResultTerminal({
      scope, effectiveMcpRequestScope, rsid: "rsid-abort-json", invocationId,
      manifest: {
        kind: "chunked_result",
        descriptor: { stream_id: "result", content_type: "application/json", total_chunks: 1, total_size: jsonBytes.byteLength, sha256: sha256(jsonBytes) },
      },
      commitBridge: abort,
    })).rejects.toBeInstanceOf(BridgeCarrierTerminalAborted);
    const records = restartableStore.snapshot().records;
    expect(records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
    expect(records.filter((row) => row.namespace === "gateway.carrier-ack/v1" && (row.value as { seq?: string }).seq === "terminal")).toEqual([]);
    expect(records.filter((row) => row.namespace === "gateway.resource-set/v1").map((row) => row.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ rsid: "rsid-abort-artifact", state: "verified" }),
      expect.objectContaining({ rsid: "rsid-abort-json", state: "declared" }),
    ]));
  });

  it("serializes concurrent carrier replays onto one durable identity and rejects a terminal conflict", async () => {
    const bytes = new Uint8Array([3, 1, 4, 1]);
    const input = {
      scope,
      effectiveMcpRequestScope,
      rsid: "rsid-concurrent-one-set",
      invocationId,
      chunks: [artifactChunk(artifactA, 0, bytes)],
      manifest: {
        kind: "artifact_result" as const,
        descriptors: [descriptor(artifactA, 0, bytes, "one.png")],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
      },
    };
    const [left, right] = await Promise.all([
      authority.ingestRbpArtifactCarrier(input),
      authority.ingestRbpArtifactCarrier(input),
    ]);
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(left[0]!.refId).toBe(right[0]!.refId);
    const sets = restartableStore.snapshot().records.filter((row) => row.namespace === "gateway.resource-set/v1");
    expect(sets).toHaveLength(1);
    expect(sets[0]!.value).toMatchObject({ state: "active", rsid: input.rsid, invocationId });
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway.carrier-identity/v1")).toHaveLength(1);

    await expectResourceError(authority.ingestRbpArtifactCarrier({
      ...input,
      manifest: {
        ...input.manifest,
        descriptors: [descriptor(artifactA, 0, bytes, "conflict.png")],
      },
    }), "incomplete");
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toHaveLength(1);
  });

  it("records receipt aggregates before object writes and fails the artifact byte cap", async () => {
    const bytes = new Uint8Array(1_048_576);
    const setId = "0197a3c2-0000-7000-8000-000000000077";
    const base = {
      scope, effectiveMcpRequestScope, setId, rsid: "rsid-receipt-cap", invocationId,
      streamDigest: createHash("sha256").update("artifact:cap").digest("hex"), bytes,
      digest: sha256(bytes), streamId: "artifact:cap", contentType: "image/png",
      artifactId: "cap", artifactIndex: 0,
    } as const;
    await authority.stageChunk({ ...base, chunkIndex: 0, sequence: 0 });
    await authority.stageChunk({ ...base, chunkIndex: 1, sequence: 1 });
    await expectResourceError(authority.stageChunk({ ...base, chunkIndex: 2, sequence: 2 }), "protocol_fault");
    expect(restartableStore.snapshot().records.find((row) => row.namespace === "gateway.resource-set/v1")?.value).toMatchObject({
      receivedChunkCount: 2,
      receivedByteCount: 2 * 1_048_576,
    });
  });

  it("requires contiguous multi-chunk receipts with terminal count and digest before publication", async () => {
    const bytes = new Uint8Array([10, 11, 12, 13, 14, 15]);
    const chunks = splitArtifactChunks(artifactA, 0, bytes, 2);
    const manifest = {
      kind: "artifact_result" as const,
      descriptors: [chunkedDescriptor(artifactA, 0, bytes, "multi.png", chunks.length)],
      artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
    };
    const refs = await authority.ingestRbpArtifactCarrier({
      scope,
      effectiveMcpRequestScope,
      rsid: "rsid-multi-chunk",
      invocationId,
      chunks,
      manifest,
    });
    expect(refs).toHaveLength(1);
    const durableChunks = restartableStore.snapshot().records.filter((row) => row.namespace === "gateway.carrier-chunk/v1");
    expect(durableChunks).toHaveLength(3);
    expect(durableChunks.map((row) => row.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ chunkIndex: 0, sequence: 0, digest: sha256(bytes.slice(0, 2)) }),
      expect.objectContaining({ chunkIndex: 1, sequence: 1, digest: sha256(bytes.slice(2, 4)) }),
      expect.objectContaining({ chunkIndex: 2, sequence: 2, digest: sha256(bytes.slice(4, 6)) }),
    ]));

    await expectResourceError(authority.ingestRbpArtifactCarrier({
      scope,
      effectiveMcpRequestScope,
      rsid: "rsid-multi-bad-count",
      invocationId,
      chunks,
      manifest: { ...manifest, descriptors: [chunkedDescriptor(artifactA, 0, bytes, "bad.png", 2)] },
    }), "incomplete");
    await expectResourceError(authority.ingestRbpArtifactCarrier({
      scope,
      effectiveMcpRequestScope,
      rsid: "rsid-multi-gap",
      invocationId,
      chunks: [chunks[0]!, chunks[2]!],
      manifest,
    }), "incomplete");
  });

  it("keeps terminal-less receipts private across restart and fences cleanup from a later stage", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const setId = "0197a3c2-0000-7000-8000-000000000077";
    const staged = {
      scope,
      effectiveMcpRequestScope,
      setId,
      rsid: "rsid-terminal-less",
      invocationId,
      streamDigest: createHash("sha256").update("artifact:terminal-less").digest("hex"),
      chunkIndex: 0,
      sequence: 0,
      bytes,
      digest: sha256(bytes),
      streamId: "artifact:terminal-less",
      contentType: "image/png",
      artifactId: "terminal-less",
      artifactIndex: 0,
    } as const;
    await authority.stageChunk(staged);
    const restarted = restartableStore.restart();
    await restarted.open();
    const recovered = new GatewayResourceAuthority({ protocolStore: restarted, objectStore, now: () => now, newRefId: () => "unused" });
    await expect(recovered.recoverAll({ scope, effectiveMcpRequestScope })).resolves.toEqual([]);
    expect(objectStore.keys()).toEqual([]);
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
    // A legitimate replay may begin a new private set only after the old
    // terminal-less set was durably removed; it still cannot resurrect a ref.
    await expect(recovered.stageChunk(staged)).resolves.toBeUndefined();
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
  });

  it("keeps A/B object-store faults private and restart recovery only publishes after the final object verifies", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const direct = {
      scope,
      effectiveMcpRequestScope,
      setId: "0197a3c2-0000-7000-8000-000000000088",
      rsid: "rsid-stage-a-fault",
      invocationId,
      streamDigest: createHash("sha256").update("artifact:stage-a").digest("hex"),
      chunkIndex: 0,
      sequence: 0,
      bytes,
      digest: sha256(bytes),
      streamId: "artifact:stage-a",
      contentType: "image/png",
      artifactId: "stage-a",
      artifactIndex: 0,
    } as const;
    vi.spyOn(objectStore, "put").mockResolvedValueOnce({ ok: false, port: "object_store", code: "unavailable", message: "stage A object fault" });
    await expectResourceError(authority.stageChunk(direct), "storage_unavailable");
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);

    vi.restoreAllMocks();
    const input = {
      scope,
      effectiveMcpRequestScope,
      rsid: "rsid-stage-b-fault",
      invocationId,
      chunks: [artifactChunk(artifactA, 0, bytes)],
      manifest: {
        kind: "artifact_result" as const,
        descriptors: [descriptor(artifactA, 0, bytes, "recovery.png")],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
      },
    };
    const originalPut = objectStore.put.bind(objectStore);
    vi.spyOn(objectStore, "put").mockImplementation(async (write) => {
      if (write.contentType === "image/png") {
        return { ok: false, port: "object_store", code: "unavailable", message: "stage B final object fault" } as const;
      }
      return originalPut(write);
    });
    await expectResourceError(authority.ingestRbpArtifactCarrier(input), "storage_unavailable");
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
    const restarted = restartableStore.restart();
    await restarted.open();
    vi.restoreAllMocks();
    const recovered = new GatewayResourceAuthority({ protocolStore: restarted, objectStore, now: () => now, newRefId: () => "recovered-ref" });
    const refs = await recovered.recoverAll({ scope, effectiveMcpRequestScope });
    expect(refs).toHaveLength(1);
    await expect(recovered.readResource(scope, effectiveMcpRequestScope, new URL(refs[0]!.uri))).resolves.toMatchObject({ digest: sha256(bytes) });
  });

  it("recovers exactly one Stage C after a post-B CAS fault and rejects a wrong final content type", async () => {
    const bytes = new Uint8Array([6, 7, 8]);
    let failPublication = true;
    const faultingStore: GatewayProtocolStore = {
      ...protocolStore,
      async transact<T>(storeScope: { readonly tenantId: string }, work: (tx: StoreTransaction) => Promise<T> | T) {
        return protocolStore.transact(storeScope, async (tx) => {
          let publishes = false;
          const result = await work({
            read: tx.read.bind(tx), list: tx.list.bind(tx),
            stage: (entry: Parameters<StoreTransaction["stage"]>[0]) => { if (entry.namespace === "gateway_resource_v1") publishes = true; tx.stage(entry); },
          });
          if (publishes && failPublication) { failPublication = false; throw new Error("injected C CAS fault"); }
          return result;
        });
      },
    };
    const faulting = new GatewayResourceAuthority({ protocolStore: faultingStore, objectStore, now: () => now, newRefId: () => "stage-c-ref" });
    const input = {
      scope, effectiveMcpRequestScope, rsid: "rsid-stage-c-fault", invocationId,
      chunks: [artifactChunk(artifactA, 0, bytes)],
      manifest: { kind: "artifact_result" as const, descriptors: [descriptor(artifactA, 0, bytes, "stage-c.png")], artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }] },
    };
    await expectResourceError(faulting.ingestRbpArtifactCarrier(input), "storage_unavailable");
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1" || (row.namespace === "gateway.carrier-ack/v1" && (row.value as { state?: string }).state === "terminal_accepted"))).toEqual([]);
    const restarted = restartableStore.restart(); await restarted.open();
    const recovered = new GatewayResourceAuthority({ protocolStore: restarted, objectStore, now: () => now, newRefId: () => "unused" });
    const originalGet = objectStore.get.bind(objectStore);
    vi.spyOn(objectStore, "get").mockImplementationOnce(async (request) => {
      const result = await originalGet(request);
      return result.ok ? { ...result, value: { ...result.value, contentType: "image/jpeg" } } : result;
    });
    await expectResourceError(recovered.recoverAll({ scope, effectiveMcpRequestScope }), "storage_unavailable");
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toEqual([]);
    vi.restoreAllMocks();
    const refs = await recovered.recoverAll({ scope, effectiveMcpRequestScope });
    expect(refs).toHaveLength(1);
    await expect(recovered.recoverAll({ scope, effectiveMcpRequestScope })).resolves.toEqual([]);
    expect(restartableStore.snapshot().records.filter((row) => row.namespace === "gateway_resource_v1")).toHaveLength(refs.length);
  });

  it("isolates carrier refs across tenant, principal, and effective session boundaries", async () => {
    const bytes = new Uint8Array([5, 4, 3]);
    const refs = await authority.ingestRbpArtifactCarrier({
      scope,
      effectiveMcpRequestScope,
      rsid: "rsid-isolation",
      invocationId,
      chunks: [artifactChunk(artifactA, 0, bytes)],
      manifest: {
        kind: "artifact_result",
        descriptors: [descriptor(artifactA, 0, bytes, "isolation.png")],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
      },
    });
    const denied = [
      { ...scope, tenantId: "other-tenant", principalKey: "other-tenant:user-1" },
      { ...scope, principalKey: "tenant-1:user-other", actorId: "user-other" },
      { ...scope, mcpSessionId: "other-session" },
    ];
    for (const foreign of denied) {
      await expectResourceError(
        authority.readResource(foreign, effectiveScopeFor(foreign), new URL(refs[0]!.uri)),
        "scope_denied",
      );
    }
  });

  it("rejects stream collision, missing sibling, and digest mismatch without publishing refs", async () => {
    const bytesA = new Uint8Array([1, 2, 3]);
    const bytesB = new Uint8Array([4, 5, 6]);
    const descriptors = [
      descriptor(artifactA, 0, bytesA, "a.png"),
      descriptor(artifactB, 1, bytesB, "b.png"),
    ] as const;
    const artifactReferences = [
      { artifact_id: artifactA, artifact_index: 0 },
      { artifact_id: artifactB, artifact_index: 1 },
    ] as const;

    await expectResourceError(
      authority.ingestRbpArtifactCarrier({
        scope,
        effectiveMcpRequestScope,
        rsid: "rsid-resource-a",
        invocationId,
        chunks: [artifactChunk(artifactA, 0, bytesA)],
        manifest: { kind: "artifact_result", descriptors, artifactReferences },
      }),
      "incomplete",
    );
    await expectResourceError(
      authority.ingestRbpArtifactCarrier({
        scope,
        effectiveMcpRequestScope,
        rsid: "rsid-resource-a",
        invocationId,
        chunks: [
          artifactChunk(artifactA, 0, bytesA),
          artifactChunk(artifactB, 0, bytesB),
        ],
        manifest: { kind: "artifact_result", descriptors, artifactReferences },
      }),
      "protocol_fault",
    );
    await expectResourceError(
      authority.ingestRbpArtifactCarrier({
        scope,
        effectiveMcpRequestScope,
        rsid: "rsid-resource-a",
        invocationId,
        chunks: [
          artifactChunk(artifactA, 0, bytesA),
          artifactChunk(artifactB, 1, bytesB),
        ],
        manifest: {
          kind: "artifact_result",
          descriptors: [
            { ...descriptors[0], sha256: `sha256:${"0".repeat(64)}` },
            descriptors[1],
          ],
          artifactReferences,
        },
      }),
      "protocol_fault",
    );
    await expectResourceError(
      authority.ingestRbpArtifactCarrier({
        scope,
        effectiveMcpRequestScope,
        rsid: "rsid-resource-a",
        invocationId,
        chunks: [
          artifactChunk(artifactA, 0, bytesA),
          artifactChunk(artifactB, 1, bytesB),
        ],
        manifest: {
          kind: "artifact_result",
          descriptors: [
            { ...descriptors[0], filename: "C:\\Users\\BT\\a.png" },
            descriptors[1],
          ],
          artifactReferences,
        },
      }),
      "invalid_input",
    );
    // Invalid terminals never publish north-facing resources.  Durable chunks
    // may remain quarantined for fenced cleanup/restart inspection.
    expect(restartableStore.snapshot().records.filter((record) => record.namespace === "gateway_resource_v1")).toEqual([]);
  });
});
