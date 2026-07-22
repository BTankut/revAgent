import { createHash } from "node:crypto";

import type { ArtifactDescriptor, Partial as RbpPartial } from "./generated/envelope.js";
import { canonicalizeJson } from "./paramsDigest.js";

export const RBP_MAX_DECODED_CHUNK_BYTES = 1_048_576 as const;
export const RBP_MAX_RECONSTRUCTED_INVOCATION_BYTES = 33_554_432 as const;
export const RBP_MAX_ARTIFACTS_PER_INVOCATION = 16 as const;

export type RbpStreamChunk = Extract<RbpPartial, { kind: "chunk" }>;

export interface RetainedStreamChunk {
  readonly chunkIndex: number;
  readonly identityDigest: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

export interface StreamAssembly {
  readonly streamId: string;
  readonly contentType: string;
  readonly artifactId: string | null;
  readonly artifactIndex: number | null;
  readonly chunks: readonly RetainedStreamChunk[];
  readonly decodedBytes: number;
}

export interface StreamAssemblerState {
  readonly invocationId: string;
  readonly streams: readonly StreamAssembly[];
  readonly decodedBytes: number;
  readonly limits: {
    readonly maxChunkBytes: number;
    readonly maxInvocationBytes: number;
    readonly maxArtifacts: number;
  };
}

export type AppendStreamChunkResult =
  | { readonly kind: "appended" | "duplicate"; readonly state: StreamAssemblerState }
  | {
      readonly kind: "gap";
      readonly state: StreamAssemblerState;
      readonly streamId: string;
      readonly expectedChunkIndex: number;
      readonly receivedChunkIndex: number;
    }
  | {
      readonly kind: "protocol_fault" | "oversize";
      readonly state: StreamAssemblerState;
      readonly reason:
        | "wrong_invocation"
        | "invalid_chunk_index"
        | "invalid_base64"
        | "chunk_too_large"
        | "invocation_too_large"
        | "invalid_stream_identity"
        | "artifact_identity_collision"
        | "too_many_artifacts"
        | "content_type_mismatch"
        | "duplicate_identity_mismatch";
    };

export interface ArtifactReference {
  readonly artifact_id: string;
  readonly artifact_index: number;
}

export interface ResultStreamDescriptor {
  readonly stream_id: "result";
  readonly content_type: string;
  readonly total_chunks: number;
  readonly total_size: number;
  readonly sha256: string;
}

export type TerminalStreamManifest =
  | {
      readonly kind: "chunked_result";
      readonly descriptor: ResultStreamDescriptor;
    }
  | {
      readonly kind: "artifact_result";
      /** Registry-declared references extracted from the sanitized result in deterministic field order. */
      readonly artifactReferences: readonly ArtifactReference[];
      readonly descriptors: readonly ArtifactDescriptor[];
    };

export interface CompletedStream {
  readonly streamId: string;
  readonly contentType: string;
  readonly artifactId: string | null;
  readonly artifactIndex: number | null;
  readonly totalChunks: number;
  readonly totalSize: number;
  readonly sha256: `sha256:${string}`;
  readonly bytes: Uint8Array;
}

export type FinalizeStreamsResult =
  | {
      readonly kind: "complete";
      readonly state: StreamAssemblerState;
      readonly streams: readonly CompletedStream[];
    }
  | {
      readonly kind: "protocol_fault" | "incomplete" | "oversize";
      readonly state: StreamAssemblerState;
      readonly reason:
        | "missing_stream"
        | "unexpected_stream"
        | "descriptor_count"
        | "descriptor_order"
        | "descriptor_identity"
        | "descriptor_filename"
        | "descriptor_content_type"
        | "descriptor_chunk_count"
        | "descriptor_size"
        | "descriptor_digest"
        | "artifact_mapping"
        | "invocation_too_large";
    };

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function decodeCanonicalBase64(data: string): Uint8Array | null {
  if (data.length < 4 || !base64Pattern.test(data)) {
    return null;
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data) {
    return null;
  }
  return new Uint8Array(decoded);
}

function chunkIdentity(chunk: RbpStreamChunk): `sha256:${string}` {
  const record = chunk as RbpStreamChunk & {
    readonly artifact_id?: string;
    readonly artifact_index?: number;
  };
  const canonical = canonicalizeJson({
    artifact_id: record.artifact_id ?? null,
    artifact_index: record.artifact_index ?? null,
    chunk_index: chunk.chunk_index,
    content_type: chunk.content_type,
    data: chunk.data,
    encoding: chunk.encoding,
    invocation_id: chunk.invocation_id,
    stream_id: chunk.stream_id,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function streamIdentity(chunk: RbpStreamChunk):
  | { readonly artifactId: null; readonly artifactIndex: null }
  | { readonly artifactId: string; readonly artifactIndex: number }
  | null {
  const record = chunk as RbpStreamChunk & {
    readonly artifact_id?: string;
    readonly artifact_index?: number;
  };
  if (chunk.stream_id === "result") {
    return record.artifact_id === undefined && record.artifact_index === undefined
      ? { artifactId: null, artifactIndex: null }
      : null;
  }
  if (
    record.artifact_id === undefined ||
    record.artifact_index === undefined ||
    chunk.stream_id !== `artifact:${record.artifact_id}` ||
    !isSafeNonNegativeInteger(record.artifact_index)
  ) {
    return null;
  }
  return { artifactId: record.artifact_id, artifactIndex: record.artifact_index };
}

export function createStreamAssembler(
  invocationId: string,
  limits: Partial<StreamAssemblerState["limits"]> = {},
): StreamAssemblerState {
  if (invocationId.length === 0) {
    throw new TypeError("invocationId must not be empty");
  }
  const requested = {
    maxChunkBytes: limits.maxChunkBytes ?? RBP_MAX_DECODED_CHUNK_BYTES,
    maxInvocationBytes:
      limits.maxInvocationBytes ?? RBP_MAX_RECONSTRUCTED_INVOCATION_BYTES,
    maxArtifacts: limits.maxArtifacts ?? RBP_MAX_ARTIFACTS_PER_INVOCATION,
  };
  if (
    !Number.isSafeInteger(requested.maxChunkBytes) ||
    requested.maxChunkBytes <= 0 ||
    !Number.isSafeInteger(requested.maxInvocationBytes) ||
    requested.maxInvocationBytes <= 0 ||
    !Number.isSafeInteger(requested.maxArtifacts) ||
    requested.maxArtifacts <= 0
  ) {
    throw new RangeError("stream limits must be positive safe integers");
  }
  const resolved = {
    maxChunkBytes: Math.min(requested.maxChunkBytes, RBP_MAX_DECODED_CHUNK_BYTES),
    maxInvocationBytes: Math.min(
      requested.maxInvocationBytes,
      RBP_MAX_RECONSTRUCTED_INVOCATION_BYTES,
    ),
    maxArtifacts: Math.min(requested.maxArtifacts, RBP_MAX_ARTIFACTS_PER_INVOCATION),
  };
  return { invocationId, streams: [], decodedBytes: 0, limits: resolved };
}

export function appendStreamChunk(
  state: StreamAssemblerState,
  chunk: RbpStreamChunk,
): AppendStreamChunkResult {
  if (chunk.invocation_id !== state.invocationId) {
    return { kind: "protocol_fault", state, reason: "wrong_invocation" };
  }
  if (!isSafeNonNegativeInteger(chunk.chunk_index)) {
    return { kind: "protocol_fault", state, reason: "invalid_chunk_index" };
  }
  const identity = streamIdentity(chunk);
  if (identity === null) {
    return { kind: "protocol_fault", state, reason: "invalid_stream_identity" };
  }
  const bytes = decodeCanonicalBase64(chunk.data);
  if (bytes === null) {
    return { kind: "protocol_fault", state, reason: "invalid_base64" };
  }
  if (bytes.byteLength > state.limits.maxChunkBytes) {
    return { kind: "oversize", state, reason: "chunk_too_large" };
  }

  const existing = state.streams.find((stream) => stream.streamId === chunk.stream_id);
  if (existing !== undefined) {
    if (
      existing.contentType !== chunk.content_type ||
      existing.artifactId !== identity.artifactId ||
      existing.artifactIndex !== identity.artifactIndex
    ) {
      return {
        kind: "protocol_fault",
        state,
        reason:
          existing.contentType !== chunk.content_type
            ? "content_type_mismatch"
            : "artifact_identity_collision",
      };
    }
    if (chunk.chunk_index < existing.chunks.length) {
      const retained = existing.chunks[chunk.chunk_index];
      return retained?.identityDigest === chunkIdentity(chunk)
        ? { kind: "duplicate", state }
        : { kind: "protocol_fault", state, reason: "duplicate_identity_mismatch" };
    }
    if (chunk.chunk_index > existing.chunks.length) {
      return {
        kind: "gap",
        state,
        streamId: chunk.stream_id,
        expectedChunkIndex: existing.chunks.length,
        receivedChunkIndex: chunk.chunk_index,
      };
    }
  } else if (chunk.chunk_index !== 0) {
    return {
      kind: "gap",
      state,
      streamId: chunk.stream_id,
      expectedChunkIndex: 0,
      receivedChunkIndex: chunk.chunk_index,
    };
  }

  if (identity.artifactId !== null) {
    const collision = state.streams.find(
      (stream) =>
        stream.artifactId !== null &&
        (stream.artifactId === identity.artifactId || stream.artifactIndex === identity.artifactIndex) &&
        stream.streamId !== chunk.stream_id,
    );
    if (collision !== undefined) {
      return { kind: "protocol_fault", state, reason: "artifact_identity_collision" };
    }
    const artifactCount = state.streams.filter((stream) => stream.artifactId !== null).length;
    if (existing === undefined && artifactCount >= state.limits.maxArtifacts) {
      return { kind: "protocol_fault", state, reason: "too_many_artifacts" };
    }
  }

  if (state.decodedBytes + bytes.byteLength > state.limits.maxInvocationBytes) {
    return { kind: "oversize", state, reason: "invocation_too_large" };
  }
  const retained: RetainedStreamChunk = {
    chunkIndex: chunk.chunk_index,
    identityDigest: chunkIdentity(chunk),
    bytes: new Uint8Array(bytes),
  };
  const updated: StreamAssembly =
    existing === undefined
      ? {
          streamId: chunk.stream_id,
          contentType: chunk.content_type,
          artifactId: identity.artifactId,
          artifactIndex: identity.artifactIndex,
          chunks: [retained],
          decodedBytes: bytes.byteLength,
        }
      : {
          ...existing,
          chunks: [...existing.chunks, retained],
          decodedBytes: existing.decodedBytes + bytes.byteLength,
        };
  const streams =
    existing === undefined
      ? [...state.streams, updated]
      : state.streams.map((stream) => (stream.streamId === updated.streamId ? updated : stream));
  return {
    kind: "appended",
    state: { ...state, streams, decodedBytes: state.decodedBytes + bytes.byteLength },
  };
}

function concatenateChunks(chunks: readonly RetainedStreamChunk[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk.bytes, offset);
    offset += chunk.bytes.byteLength;
  }
  return output;
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

type StreamDescriptor = ResultStreamDescriptor | ArtifactDescriptor;

function completeStream(
  state: StreamAssemblerState,
  descriptor: StreamDescriptor,
): CompletedStream | FinalizeStreamsResult {
  if (
    !isSafeNonNegativeInteger(descriptor.total_chunks) ||
    !isSafeNonNegativeInteger(descriptor.total_size) ||
    !sha256Pattern.test(descriptor.sha256)
  ) {
    return { kind: "protocol_fault", state, reason: "descriptor_identity" };
  }
  const stream = state.streams.find((candidate) => candidate.streamId === descriptor.stream_id);
  if (stream === undefined) {
    if (descriptor.total_chunks === 0 && descriptor.total_size === 0) {
      const bytes = new Uint8Array();
      if (digestBytes(bytes) !== descriptor.sha256) {
        return { kind: "protocol_fault", state, reason: "descriptor_digest" };
      }
      return {
        streamId: descriptor.stream_id,
        contentType: descriptor.content_type,
        artifactId: "artifact_id" in descriptor ? descriptor.artifact_id : null,
        artifactIndex: "artifact_index" in descriptor ? descriptor.artifact_index : null,
        totalChunks: 0,
        totalSize: 0,
        sha256: descriptor.sha256 as `sha256:${string}`,
        bytes,
      };
    }
    return { kind: "incomplete", state, reason: "missing_stream" };
  }
  if (stream.contentType !== descriptor.content_type) {
    return { kind: "protocol_fault", state, reason: "descriptor_content_type" };
  }
  if (stream.chunks.length !== descriptor.total_chunks) {
    return { kind: "incomplete", state, reason: "descriptor_chunk_count" };
  }
  if (stream.decodedBytes !== descriptor.total_size) {
    return { kind: "protocol_fault", state, reason: "descriptor_size" };
  }
  const bytes = concatenateChunks(stream.chunks);
  const sha256 = digestBytes(bytes);
  if (sha256 !== descriptor.sha256) {
    return { kind: "protocol_fault", state, reason: "descriptor_digest" };
  }
  return {
    streamId: stream.streamId,
    contentType: stream.contentType,
    artifactId: stream.artifactId,
    artifactIndex: stream.artifactIndex,
    totalChunks: stream.chunks.length,
    totalSize: bytes.byteLength,
    sha256,
    bytes,
  };
}

function isFinalizeFailure(value: CompletedStream | FinalizeStreamsResult): value is FinalizeStreamsResult {
  return "kind" in value;
}

function validFilename(filename: string): boolean {
  if (
    filename.length < 1 ||
    filename.length > 255 ||
    filename !== filename.trim() ||
    filename.startsWith(".") ||
    filename.includes("..") ||
    /[\\/:<>"|?*\u0000-\u001f\u007f]/.test(filename) ||
    /[. ]$/.test(filename)
  ) {
    return false;
  }
  const deviceStem = (filename.split(".", 1)[0] ?? "").toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/.test(deviceStem)) {
    return false;
  }
  return !/\.(?:lnk|url|symlink)$/i.test(filename);
}

export function finalizeStreams(
  state: StreamAssemblerState,
  manifest: TerminalStreamManifest,
): FinalizeStreamsResult {
  if (manifest.kind === "chunked_result") {
    if (state.streams.some((stream) => stream.streamId !== "result")) {
      return { kind: "protocol_fault", state, reason: "unexpected_stream" };
    }
    const completed = completeStream(state, manifest.descriptor);
    return isFinalizeFailure(completed)
      ? completed
      : { kind: "complete", state, streams: [completed] };
  }

  const descriptors = manifest.descriptors;
  if (descriptors.length < 1 || descriptors.length > state.limits.maxArtifacts) {
    return { kind: "protocol_fault", state, reason: "descriptor_count" };
  }
  if (state.streams.some((stream) => stream.streamId === "result")) {
    return { kind: "protocol_fault", state, reason: "unexpected_stream" };
  }
  const ids = new Set<string>();
  const streamIds = new Set<string>();
  const completed: CompletedStream[] = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || descriptor.artifact_index !== index) {
      return { kind: "protocol_fault", state, reason: "descriptor_order" };
    }
    if (
      descriptor.stream_id !== `artifact:${descriptor.artifact_id}` ||
      ids.has(descriptor.artifact_id) ||
      streamIds.has(descriptor.stream_id)
    ) {
      return { kind: "protocol_fault", state, reason: "descriptor_identity" };
    }
    if (!validFilename(descriptor.filename)) {
      return { kind: "protocol_fault", state, reason: "descriptor_filename" };
    }
    ids.add(descriptor.artifact_id);
    streamIds.add(descriptor.stream_id);
    const stream = completeStream(state, descriptor);
    if (isFinalizeFailure(stream)) {
      return stream;
    }
    if (stream.artifactId !== descriptor.artifact_id || stream.artifactIndex !== index) {
      return { kind: "protocol_fault", state, reason: "descriptor_identity" };
    }
    completed.push(stream);
  }
  if (state.streams.some((stream) => !streamIds.has(stream.streamId))) {
    return { kind: "protocol_fault", state, reason: "unexpected_stream" };
  }
  if (
    manifest.artifactReferences.length !== descriptors.length ||
    manifest.artifactReferences.some(
      (reference, index) =>
        reference.artifact_id !== descriptors[index]?.artifact_id ||
        reference.artifact_index !== index,
    )
  ) {
    return { kind: "protocol_fault", state, reason: "artifact_mapping" };
  }
  const totalBytes = completed.reduce((sum, stream) => sum + stream.totalSize, 0);
  if (totalBytes > state.limits.maxInvocationBytes) {
    return { kind: "oversize", state, reason: "invocation_too_large" };
  }
  return { kind: "complete", state, streams: completed };
}
