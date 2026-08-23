import { createHash } from "node:crypto";

import type { ArtifactDescriptor, RbpStreamChunk } from "@revagent/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
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
import type { GatewayProtocolStore } from "./store.js";

const invocationId = "0197a3c2-0000-7000-8000-000000000010";
const artifactA = "0197a3c2-0000-7000-8000-000000000201";
const artifactB = "0197a3c2-0000-7000-8000-000000000202";
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
  let now: number;
  let restartableStore: RestartableTestStore;
  let protocolStore: GatewayProtocolStore;
  let objectStore: MemoryObjectStore;
  let authority: GatewayResourceAuthority;
  let refSequence: number;

  beforeEach(async () => {
    now = 10_000;
    refSequence = 0;
    restartableStore = createRestartableTestStore();
    protocolStore = restartableStore.store;
    await protocolStore.open();
    objectStore = createMemoryObjectStore();
    authority = new GatewayResourceAuthority({
      protocolStore,
      objectStore,
      now: () => now,
      newRefId: () => `ref-${String(++refSequence)}`,
      maxUploadBytes: 16,
      maxResultBytes: 128,
      maxResultPageBytes: 8,
      defaultTtlMs: 1_000,
    });
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
      uri: "revagent://artifact/ref-1",
      filename: "schedule.csv",
      contentType: "text/csv",
      byteSize: bytes.byteLength,
    });
    const consumed = await authority.consumeArtifact(scope, ref.refId);
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
      authority.consumeArtifact(scope, ref.refId),
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
    expect(objectStore.keys()).toEqual([]);
  });

  it("hash-prefixes durable keys and returns not_found for a foreign scope before object lookup", async () => {
    const ref = await authority.uploadArtifact({
      scope,
      filename: "source.tsv",
      contentType: "text/tab-separated-values",
      quarantineStatus: "released",
      bytes: Buffer.from("A\t2", "utf8"),
    });
    const objectGet = vi.spyOn(objectStore, "get");
    for (const denied of [
      { ...scope, actorId: "user-2" },
      { ...scope, principalKey: "tenant-1:user-2" },
      { ...scope, mcpSessionId: "mcp-session-2" },
    ]) {
      await expectResourceError(
        authority.consumeArtifact(denied, ref.refId),
        "not_found",
      );
    }
    await expectResourceError(
      authority.consumeArtifact({ ...scope, tenantId: "tenant-2" }, ref.refId),
      "not_found",
    );
    expect(objectGet).not.toHaveBeenCalled();

    const [key] = objectStore.keys();
    expect(key).toMatch(
      /^gateway-resources\/[0-9a-f]{64}\/[0-9a-f]{64}\/[0-9a-f]{64}\/[0-9a-f]{64}\/artifact_ref\/[0-9a-f]{64}$/u,
    );
    objectStore.corrupt(key!, Buffer.from("changed", "utf8"));
    await expectResourceError(
      authority.consumeArtifact(scope, ref.refId),
      "digest_mismatch",
    );

    now = ref.expiresAtMs;
    await expectResourceError(
      authority.consumeArtifact(scope, ref.refId),
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
        new URL(`revagent://result/${ref.refId}/${String(page)}`),
      );
      expect(read.digest).toBe(sha256(read.bytes));
      expect(read.nextPageUri).toBe(
        page + 1 < ref.pageCount
          ? `revagent://result/${ref.refId}/${String(page + 1)}`
          : null,
      );
      collected.push(Buffer.from(read.bytes));
    }
    expect(JSON.parse(Buffer.concat(collected).toString("utf8"))).toEqual(value);
    await expectResourceError(
      authority.readResource(
        { ...scope, mcpSessionId: "foreign" },
        new URL(ref.uri),
      ),
      "not_found",
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
      Promise.all(refs.map((ref) => authority.readResource(scope, new URL(ref.uri)))),
    ).resolves.toMatchObject([
      { contentType: "image/png", nextPageUri: null },
      { contentType: "image/png", nextPageUri: null },
    ]);

    const restartedStore = restartableStore.restart();
    await restartedStore.open();
    const restartedAuthority = new GatewayResourceAuthority({
      protocolStore: restartedStore,
      objectStore,
      now: () => now,
      newRefId: () => "unused-after-restart",
    });
    await expect(
      restartedAuthority.readResource(scope, new URL(refs[1]!.uri)),
    ).resolves.toMatchObject({ contentType: "image/png" });
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
        invocationId,
        chunks: [artifactChunk(artifactA, 0, bytesA)],
        manifest: { kind: "artifact_result", descriptors, artifactReferences },
      }),
      "incomplete",
    );
    await expectResourceError(
      authority.ingestRbpArtifactCarrier({
        scope,
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
    expect(objectStore.keys()).toEqual([]);
  });
});
