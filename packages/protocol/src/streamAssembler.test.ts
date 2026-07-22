import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  appendStreamChunk,
  createStreamAssembler,
  finalizeStreams,
  type ArtifactDescriptor,
  type RbpStreamChunk,
  type StreamAssemblerState,
} from "./index.js";

const invocationId = "0197a3c2-0000-7000-8000-000000000010";
const artifactA = "0197a3c2-0000-7000-8000-000000000201";
const artifactB = "0197a3c2-0000-7000-8000-000000000202";

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function resultChunk(index: number, bytes: Uint8Array): RbpStreamChunk {
  return {
    kind: "chunk",
    invocation_id: invocationId,
    stream_id: "result",
    chunk_index: index,
    encoding: "base64",
    content_type: "application/json",
    data: Buffer.from(bytes).toString("base64"),
  };
}

function artifactChunk(
  artifactId: string,
  artifactIndex: number,
  chunkIndex: number,
  bytes: Uint8Array,
): RbpStreamChunk {
  return {
    kind: "chunk",
    invocation_id: invocationId,
    stream_id: `artifact:${artifactId}`,
    artifact_id: artifactId,
    artifact_index: artifactIndex,
    chunk_index: chunkIndex,
    encoding: "base64",
    content_type: "application/octet-stream",
    data: Buffer.from(bytes).toString("base64"),
  };
}

function appendOrThrow(state: StreamAssemblerState, chunk: RbpStreamChunk): StreamAssemblerState {
  const result = appendStreamChunk(state, chunk);
  if (result.kind !== "appended") {
    throw new Error(`chunk did not append: ${result.kind}`);
  }
  return result.state;
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
    content_type: "application/octet-stream",
    total_chunks: 1,
    total_size: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

describe("ordered result and artifact stream assembler", () => {
  it("reconstructs an ordered result stream and verifies terminal size and digest", () => {
    const first = new TextEncoder().encode("{\"rows\":");
    const second = new TextEncoder().encode("3}");
    let state = createStreamAssembler(invocationId);
    state = appendOrThrow(state, resultChunk(0, first));
    state = appendOrThrow(state, resultChunk(1, second));
    const combined = new Uint8Array([...first, ...second]);
    const result = finalizeStreams(state, {
      kind: "chunked_result",
      descriptor: {
        stream_id: "result",
        content_type: "application/json",
        total_chunks: 2,
        total_size: combined.byteLength,
        sha256: sha256(combined),
      },
    });
    expect(result).toMatchObject({ kind: "complete", streams: [{ totalChunks: 2 }] });
    if (result.kind === "complete") {
      expect([...result.streams[0]!.bytes]).toEqual([...combined]);
    }
  });

  it("deduplicates byte-identical retransmission and rejects changed duplicate identity", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const state = appendOrThrow(createStreamAssembler(invocationId), resultChunk(0, bytes));
    expect(appendStreamChunk(state, resultChunk(0, bytes))).toMatchObject({ kind: "duplicate" });
    expect(appendStreamChunk(state, resultChunk(0, new Uint8Array([1, 2, 4])))).toMatchObject({
      kind: "protocol_fault",
      reason: "duplicate_identity_mismatch",
    });
  });

  it("rejects gaps, cross-invocation chunks, invalid Base64, and oversize decoded chunks", () => {
    const state = createStreamAssembler(invocationId, { maxChunkBytes: 3 });
    expect(appendStreamChunk(state, resultChunk(1, new Uint8Array([1])))).toMatchObject({
      kind: "gap",
      expectedChunkIndex: 0,
    });
    expect(
      appendStreamChunk(state, { ...resultChunk(0, new Uint8Array([1])), invocation_id: "foreign" }),
    ).toMatchObject({ kind: "protocol_fault", reason: "wrong_invocation" });
    expect(
      appendStreamChunk(state, { ...resultChunk(0, new Uint8Array([1])), data: "AB==" }),
    ).toMatchObject({ kind: "protocol_fault", reason: "invalid_base64" });
    expect(appendStreamChunk(state, resultChunk(0, new Uint8Array([1, 2, 3, 4])))).toMatchObject({
      kind: "oversize",
      reason: "chunk_too_large",
    });
  });

  it("allows interleaved artifact streams while keeping independent indices", () => {
    const a0 = new Uint8Array([1, 2]);
    const b0 = new Uint8Array([3]);
    const a1 = new Uint8Array([4]);
    let state = createStreamAssembler(invocationId);
    state = appendOrThrow(state, artifactChunk(artifactA, 0, 0, a0));
    state = appendOrThrow(state, artifactChunk(artifactB, 1, 0, b0));
    state = appendOrThrow(state, artifactChunk(artifactA, 0, 1, a1));
    expect(state.streams).toMatchObject([
      { artifactId: artifactA, artifactIndex: 0, chunks: [{ chunkIndex: 0 }, { chunkIndex: 1 }] },
      { artifactId: artifactB, artifactIndex: 1, chunks: [{ chunkIndex: 0 }] },
    ]);
  });

  it("validates a multi-file carrier all-or-nothing", () => {
    const bytesA = new Uint8Array([80, 78, 71, 49]);
    const bytesB = new Uint8Array([80, 78, 71, 50]);
    let state = createStreamAssembler(invocationId);
    state = appendOrThrow(state, artifactChunk(artifactA, 0, 0, bytesA));
    state = appendOrThrow(state, artifactChunk(artifactB, 1, 0, bytesB));
    const descriptors = [
      descriptor(artifactA, 0, bytesA, "plan.bin"),
      descriptor(artifactB, 1, bytesB, "detail.bin"),
    ] as const;
    const references = [
      { artifact_id: artifactA, artifact_index: 0 },
      { artifact_id: artifactB, artifact_index: 1 },
    ] as const;

    expect(
      finalizeStreams(state, {
        kind: "artifact_result",
        descriptors,
        artifactReferences: references,
      }),
    ).toMatchObject({ kind: "complete", streams: [{ artifactId: artifactA }, { artifactId: artifactB }] });

    const corrupt = [{ ...descriptors[0], sha256: `sha256:${"0".repeat(64)}` }, descriptors[1]];
    expect(
      finalizeStreams(state, {
        kind: "artifact_result",
        descriptors: corrupt,
        artifactReferences: references,
      }),
    ).toEqual(expect.objectContaining({ kind: "protocol_fault", reason: "descriptor_digest" }));
    expect(
      finalizeStreams(state, {
        kind: "artifact_result",
        descriptors,
        artifactReferences: [references[1], references[0]],
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "artifact_mapping" });
  });

  it("rejects descriptor identity, order, basename, and undeclared stream defects", () => {
    const bytes = new Uint8Array([1]);
    let state = createStreamAssembler(invocationId);
    state = appendOrThrow(state, artifactChunk(artifactA, 0, 0, bytes));
    const good = descriptor(artifactA, 0, bytes, "one.bin");
    expect(
      finalizeStreams(state, {
        kind: "artifact_result",
        descriptors: [{ ...good, artifact_index: 1 }],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 1 }],
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "descriptor_order" });
    expect(
      finalizeStreams(state, {
        kind: "artifact_result",
        descriptors: [{ ...good, filename: "C:\\temp\\one.bin" }],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "descriptor_filename" });

    state = appendOrThrow(state, artifactChunk(artifactB, 1, 0, bytes));
    expect(
      finalizeStreams(state, {
        kind: "artifact_result",
        descriptors: [good],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "unexpected_stream" });
  });

  it("enforces the combined reconstructed invocation limit across streams", () => {
    let state = createStreamAssembler(invocationId, { maxInvocationBytes: 3 });
    state = appendOrThrow(state, artifactChunk(artifactA, 0, 0, new Uint8Array([1, 2])));
    expect(
      appendStreamChunk(state, artifactChunk(artifactB, 1, 0, new Uint8Array([3, 4]))),
    ).toMatchObject({ kind: "oversize", reason: "invocation_too_large" });
  });

  it("never permits caller overrides above normative chunk, invocation, or artifact caps", () => {
    const state = createStreamAssembler(invocationId, {
      maxChunkBytes: 2_000_000,
      maxInvocationBytes: 99_000_000,
      maxArtifacts: 99,
    });
    expect(state.limits).toEqual({
      maxChunkBytes: 1_048_576,
      maxInvocationBytes: 33_554_432,
      maxArtifacts: 16,
    });
    expect(
      appendStreamChunk(state, resultChunk(0, new Uint8Array(1_048_577))),
    ).toMatchObject({ kind: "oversize", reason: "chunk_too_large" });

    let artifacts = state;
    for (let index = 0; index < 16; index += 1) {
      const id = `0197a3c2-0000-7000-8000-${String(300 + index).padStart(12, "0")}`;
      artifacts = appendOrThrow(artifacts, artifactChunk(id, index, 0, new Uint8Array([index])));
    }
    const seventeenth = "0197a3c2-0000-7000-8000-000000000399";
    expect(appendStreamChunk(artifacts, artifactChunk(seventeenth, 16, 0, new Uint8Array([1])))).toMatchObject({
      kind: "protocol_fault",
      reason: "too_many_artifacts",
    });
  });

  it.each([
    "",
    ".",
    "..",
    ".hidden.png",
    "part..png",
    "folder/part.png",
    "folder\\part.png",
    "C:part.png",
    "part.png.",
    "part.png ",
    "CON",
    "nul.txt",
    "COM1.png",
    "shortcut.lnk",
    "pointer.url",
  ])("rejects unsafe artifact basename %j", (filename) => {
    const bytes = new Uint8Array([1]);
    const state = appendOrThrow(
      createStreamAssembler(invocationId),
      artifactChunk(artifactA, 0, 0, bytes),
    );
    expect(
      finalizeStreams(state, {
        kind: "artifact_result",
        descriptors: [descriptor(artifactA, 0, bytes, filename)],
        artifactReferences: [{ artifact_id: artifactA, artifact_index: 0 }],
      }),
    ).toMatchObject({ kind: "protocol_fault", reason: "descriptor_filename" });
  });

  it("reconstructs arbitrary non-empty chunk partitions without changing bytes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 64 }), {
          minLength: 1,
          maxLength: 12,
        }),
        (parts) => {
          let state = createStreamAssembler(invocationId);
          for (let index = 0; index < parts.length; index += 1) {
            state = appendOrThrow(state, resultChunk(index, parts[index]!));
          }
          const combined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
          let offset = 0;
          for (const part of parts) {
            combined.set(part, offset);
            offset += part.byteLength;
          }
          const result = finalizeStreams(state, {
            kind: "chunked_result",
            descriptor: {
              stream_id: "result",
              content_type: "application/json",
              total_chunks: parts.length,
              total_size: combined.byteLength,
              sha256: sha256(combined),
            },
          });
          expect(result.kind).toBe("complete");
          if (result.kind === "complete") {
            expect([...result.streams[0]!.bytes]).toEqual([...combined]);
          }
        },
      ),
    );
  });
});
