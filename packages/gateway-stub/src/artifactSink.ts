import type {
  ArtifactReference,
  InvocationResult,
  Partial as RbpPartial,
  StreamAssemblerState,
  TerminalStreamManifest,
} from "@revagent/protocol";
import {
  appendStreamChunk,
  createStreamAssembler,
  finalizeStreams,
} from "@revagent/protocol";

import type {
  PersistedArtifact,
  PersistedChunkedResult,
  PersistedSession,
  PersistedStreamAssembler,
} from "./types.js";

export class CarrierValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CarrierValidationError";
  }
}

function persistAssembler(state: StreamAssemblerState): PersistedStreamAssembler {
  return {
    invocationId: state.invocationId,
    decodedBytes: state.decodedBytes,
    limits: structuredClone(state.limits),
    streams: state.streams.map((stream) => ({
      streamId: stream.streamId,
      contentType: stream.contentType,
      artifactId: stream.artifactId,
      artifactIndex: stream.artifactIndex,
      decodedBytes: stream.decodedBytes,
      chunks: stream.chunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        identityDigest: chunk.identityDigest,
        bytesBase64: Buffer.from(chunk.bytes).toString("base64"),
      })),
    })),
  };
}

function hydrateAssembler(state: PersistedStreamAssembler): StreamAssemblerState {
  return {
    invocationId: state.invocationId,
    decodedBytes: state.decodedBytes,
    limits: structuredClone(state.limits),
    streams: state.streams.map((stream) => ({
      streamId: stream.streamId,
      contentType: stream.contentType,
      artifactId: stream.artifactId,
      artifactIndex: stream.artifactIndex,
      decodedBytes: stream.decodedBytes,
      chunks: stream.chunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        identityDigest: chunk.identityDigest,
        bytes: new Uint8Array(Buffer.from(chunk.bytesBase64, "base64")),
      })),
    })),
  };
}

function collectArtifactReferences(value: unknown, output: ArtifactReference[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectArtifactReferences(item, output);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.artifact_id === "string" && Number.isSafeInteger(record.artifact_index)) {
    output.push({
      artifact_id: record.artifact_id,
      artifact_index: record.artifact_index as number,
    });
  }
  for (const child of Object.values(record)) {
    collectArtifactReferences(child, output);
  }
}

function manifestFor(result: InvocationResult): TerminalStreamManifest | null {
  if (result.chunked === true && result.stream_id === "result") {
    return {
      kind: "chunked_result",
      descriptor: {
        stream_id: result.stream_id,
        content_type: result.content_type,
        total_chunks: result.total_chunks,
        total_size: result.total_size,
        sha256: result.sha256,
      },
    };
  }
  if (Array.isArray(result.artifacts)) {
    const artifactReferences: ArtifactReference[] = [];
    collectArtifactReferences(result.result, artifactReferences);
    return {
      kind: "artifact_result",
      artifactReferences,
      descriptors: result.artifacts,
    };
  }
  return null;
}

export function recordPartial(session: PersistedSession, partial: RbpPartial): void {
  if (partial.kind === "progress") {
    return;
  }
  const current = session.streamAssemblers[partial.invocation_id];
  const state = current === undefined
    ? createStreamAssembler(partial.invocation_id)
    : hydrateAssembler(current);
  const result = appendStreamChunk(state, partial);
  if (result.kind === "protocol_fault" || result.kind === "oversize") {
    throw new CarrierValidationError(`chunk rejected: ${result.reason}`);
  }
  if (result.kind === "gap") {
    throw new CarrierValidationError(
      `chunk gap for ${result.streamId}: expected ${result.expectedChunkIndex}, received ${result.receivedChunkIndex}`,
    );
  }
  session.streamAssemblers[partial.invocation_id] = persistAssembler(result.state);
}

export function discardInvocationStreams(session: PersistedSession, invocationId: string): void {
  delete session.streamAssemblers[invocationId];
}

export function finalizeInvocationCarrier(
  session: PersistedSession,
  result: InvocationResult,
): { artifacts: PersistedArtifact[]; chunkedResult: PersistedChunkedResult | null } {
  const manifest = manifestFor(result);
  const retained = session.streamAssemblers[result.invocation_id];
  if (manifest === null) {
    if (retained !== undefined && retained.streams.length > 0) {
      throw new CarrierValidationError("inline terminal result leaves unreferenced chunk streams");
    }
    delete session.streamAssemblers[result.invocation_id];
    session.artifacts[result.invocation_id] = [];
    return { artifacts: [], chunkedResult: null };
  }

  const state = retained === undefined
    ? createStreamAssembler(result.invocation_id)
    : hydrateAssembler(retained);
  const finalized = finalizeStreams(state, manifest);
  if (finalized.kind !== "complete") {
    throw new CarrierValidationError(`terminal carrier rejected: ${finalized.kind}/${finalized.reason}`);
  }

  const byStream = new Map(finalized.streams.map((stream) => [stream.streamId, stream]));
  let chunkedResult: PersistedChunkedResult | null = null;
  const artifacts: PersistedArtifact[] = [];
  if (manifest.kind === "chunked_result") {
    const stream = finalized.streams[0]!;
    chunkedResult = {
      streamId: "result",
      contentType: stream.contentType,
      totalChunks: stream.totalChunks,
      totalSize: stream.totalSize,
      sha256: stream.sha256,
      bytesBase64: Buffer.from(stream.bytes).toString("base64"),
    };
    session.chunkedResults[result.invocation_id] = chunkedResult;
  } else {
    for (const descriptor of manifest.descriptors) {
      const stream = byStream.get(descriptor.stream_id)!;
      artifacts.push({
        artifactId: descriptor.artifact_id,
        artifactIndex: descriptor.artifact_index,
        streamId: descriptor.stream_id,
        filename: descriptor.filename,
        contentType: descriptor.content_type,
        totalChunks: stream.totalChunks,
        totalSize: stream.totalSize,
        sha256: stream.sha256,
        bytesBase64: Buffer.from(stream.bytes).toString("base64"),
      });
    }
  }
  session.artifacts[result.invocation_id] = artifacts;
  delete session.streamAssemblers[result.invocation_id];
  return { artifacts, chunkedResult };
}
