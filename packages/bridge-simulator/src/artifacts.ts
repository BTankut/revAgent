import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  appendStreamChunk,
  createStreamAssembler,
  finalizeStreams,
  RBP_MAX_ARTIFACTS_PER_INVOCATION,
  RBP_MAX_DECODED_CHUNK_BYTES,
  RBP_MAX_RECONSTRUCTED_INVOCATION_BYTES,
  type ArtifactDescriptor,
  type ArtifactReference,
  type CompletedStream,
  type Partial as RbpPartial,
  type StreamAssemblerState,
} from "@revagent/protocol";

export interface ArtifactInput {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ArtifactCarrier {
  readonly kind: "artifacts";
  readonly rsid: string;
  readonly invocationId: string;
  readonly result: { readonly artifacts: readonly ArtifactReference[] };
  readonly partials: readonly Extract<RbpPartial, { kind: "chunk" }>[];
  readonly descriptors: readonly ArtifactDescriptor[];
  readonly chunkBytes: number;
  readonly retainedDirectory: string;
  readonly retainedFiles: readonly string[];
}

export interface ChunkedResultCarrier {
  readonly kind: "chunked_result";
  readonly rsid: string;
  readonly invocationId: string;
  readonly partials: readonly Extract<RbpPartial, { kind: "chunk" }>[];
  readonly chunkBytes: number;
  readonly contentType: string;
  readonly totalChunks: number;
  readonly totalSize: number;
  readonly sha256: `sha256:${string}`;
  readonly retainedDirectory: string;
  readonly retainedFiles: readonly [string];
}

export type DurableResultCarrier = ArtifactCarrier | ChunkedResultCarrier;

export interface SanitizedArtifactStreamEvidence {
  readonly streamId: string;
  readonly artifactId: string | null;
  readonly artifactIndex: number | null;
  readonly filename: string | null;
  readonly contentType: string;
  readonly contentTypeTruncated: boolean;
  readonly contentTypeDigest: `sha256:${string}`;
  readonly totalChunks: number;
  readonly totalSize: number;
  readonly sha256: `sha256:${string}`;
}

export interface SanitizedArtifactCarrierEvidence {
  readonly rsid: string;
  readonly invocationId: string;
  readonly kind: DurableResultCarrier["kind"];
  readonly chunkBytes: number;
  readonly streamCount: number;
  readonly retainedFileCount: number;
  readonly totalChunks: number;
  readonly totalSize: number;
  readonly descriptorDigest: `sha256:${string}`;
  readonly streams: readonly SanitizedArtifactStreamEvidence[];
}

export interface SanitizedArtifactSpoolEvidence {
  readonly evidenceVersion: 1;
  readonly rootPathRedacted: true;
  readonly rawPathExposed: false;
  readonly carrierCount: number;
  readonly retainedFileCount: number;
  readonly totalChunks: number;
  readonly totalSize: number;
  readonly carriers: readonly SanitizedArtifactCarrierEvidence[];
}

const MAX_SPOOL_EVIDENCE_CARRIERS = 128;
const MAX_SPOOL_EVIDENCE_CONTENT_TYPE_CHARS = 128;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sanitizedContentTypeEvidence(contentType: string): Pick<
  SanitizedArtifactStreamEvidence,
  "contentType" | "contentTypeTruncated" | "contentTypeDigest"
> {
  return {
    contentType: contentType.slice(0, MAX_SPOOL_EVIDENCE_CONTENT_TYPE_CHARS),
    contentTypeTruncated: contentType.length > MAX_SPOOL_EVIDENCE_CONTENT_TYPE_CHARS,
    contentTypeDigest: sha256(Buffer.from(contentType, "utf8")),
  };
}

function safeFilename(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 255 ||
    value !== value.trim() ||
    value.startsWith(".") ||
    value.includes("..") ||
    /[\\/:<>"|?*\u0000-\u001f\u007f]/u.test(value) ||
    /[. ]$/u.test(value)
  ) {
    return false;
  }
  if (/\.(?:lnk|url|symlink)$/iu.test(value)) return false;
  const stem = (value.split(".", 1)[0] ?? "").toUpperCase();
  return !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u.test(stem);
}

function safeContentType(value: string): boolean {
  return value.length >= 1 && value.length <= 4_096;
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("artifact path is outside the managed spool root");
  }
}

function safeStorageSegment(value: string, label: string): void {
  if (
    value.length < 1 || value.length > 128 || value === "." || value === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`${label} is not a safe spool path segment`);
}

export class DeterministicUuid7Source {
  #counter = 0;

  public next(): string {
    this.#counter += 1;
    return `0197a3c2-0000-7000-8000-${this.#counter.toString().padStart(12, "0")}`;
  }
}

export class ArtifactSpool {
  readonly #root: string;
  readonly #id: () => string;

  public constructor(root: string, idFactory: () => string) {
    if (root.length === 0) throw new Error("artifact spool root is required");
    this.#root = resolve(root);
    this.#id = idFactory;
    mkdirSync(this.#root, { recursive: true });
    const stat = lstatSync(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("artifact spool root must be a real directory");
    }
  }

  public get root(): string {
    return this.#root;
  }

  public captureDeclaredPaths(
    rsid: string,
    invocationId: string,
    paths: readonly { readonly path: string; readonly contentType: string }[],
    chunkBytes: number = RBP_MAX_DECODED_CHUNK_BYTES,
  ): ArtifactCarrier {
    try {
      const realRoot = realpathSync.native(this.#root);
      const inputs: ArtifactInput[] = [];
      for (const entry of paths) {
        const candidate = resolve(entry.path);
        assertInside(this.#root, candidate);
        const realCandidate = realpathSync.native(candidate);
        assertInside(realRoot, realCandidate);
        const before = lstatSync(candidate);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
          throw new Error("artifact source must be a regular non-reparse file");
        }
        const descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let bytes: Buffer;
        try {
          const opened = fstatSync(descriptor);
          if (
            !opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino
          ) {
            throw new Error("artifact source changed during validated open");
          }
          bytes = readFileSync(descriptor);
          const openedAfterRead = fstatSync(descriptor);
          const pathAfterRead = lstatSync(candidate);
          const realAfterRead = realpathSync.native(candidate);
          assertInside(realRoot, realAfterRead);
          if (
            openedAfterRead.size !== opened.size || openedAfterRead.dev !== opened.dev || openedAfterRead.ino !== opened.ino ||
            !pathAfterRead.isFile() || pathAfterRead.isSymbolicLink() || pathAfterRead.nlink !== 1 ||
            pathAfterRead.dev !== opened.dev || pathAfterRead.ino !== opened.ino
          ) {
            throw new Error("artifact source changed while reading");
          }
        } finally {
          closeSync(descriptor);
        }
        inputs.push({ filename: basename(candidate), contentType: entry.contentType, bytes });
      }
      return this.retain(rsid, invocationId, inputs, chunkBytes);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new RangeError("declared artifact source exceeds an allowed limit");
      }
      throw new Error("declared artifact source could not be captured");
    }
  }

  public retain(
    rsid: string,
    invocationId: string,
    inputs: readonly ArtifactInput[],
    chunkBytes: number = RBP_MAX_DECODED_CHUNK_BYTES,
  ): ArtifactCarrier {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > RBP_MAX_DECODED_CHUNK_BYTES) {
      throw new RangeError("artifact chunk bytes exceed the RBP/1 partial limit");
    }
    if (inputs.length < 1 || inputs.length > RBP_MAX_ARTIFACTS_PER_INVOCATION) {
      throw new RangeError("artifact count must be between 1 and 16");
    }
    const total = inputs.reduce((sum, input) => sum + input.bytes.byteLength, 0);
    if (total > RBP_MAX_RECONSTRUCTED_INVOCATION_BYTES) {
      throw new RangeError("combined artifact bytes exceed 32 MiB");
    }
    if (inputs.some((input) => !safeFilename(input.filename))) {
      throw new Error("invalid artifact basename");
    }
    if (inputs.some((input) => !safeContentType(input.contentType))) {
      throw new Error("artifact content type must contain from 1 through 4096 characters");
    }
    const names = new Set(inputs.map((input) => input.filename.toLowerCase()));
    if (names.size !== inputs.length) throw new Error("artifact basenames must be unique");

    const directory = this.#createInvocationDirectory(rsid, invocationId);
    const partials: Extract<RbpPartial, { kind: "chunk" }>[] = [];
    const descriptors: ArtifactDescriptor[] = [];
    const references: ArtifactReference[] = [];
    const retainedFiles: string[] = [];
    try {
      inputs.forEach((input, artifactIndex) => {
        const artifactId = this.#id();
        const streamId = `artifact:${artifactId}` as const;
        const retained = join(directory, `${artifactIndex.toString().padStart(2, "0")}-${input.filename}`);
        assertInside(directory, retained);
        writeFileSync(retained, input.bytes, { flag: "wx" });
        retainedFiles.push(retained);
        let chunkIndex = 0;
        for (let offset = 0; offset < input.bytes.byteLength; offset += chunkBytes) {
          const chunk = input.bytes.slice(offset, offset + chunkBytes);
          partials.push({
            kind: "chunk",
            invocation_id: invocationId,
            stream_id: streamId,
            artifact_id: artifactId,
            artifact_index: artifactIndex,
            chunk_index: chunkIndex,
            encoding: "base64",
            content_type: input.contentType,
            data: Buffer.from(chunk).toString("base64"),
          });
          chunkIndex += 1;
        }
        references.push({ artifact_id: artifactId, artifact_index: artifactIndex });
        descriptors.push({
          artifact_id: artifactId,
          artifact_index: artifactIndex,
          stream_id: streamId,
          filename: input.filename,
          content_type: input.contentType,
          total_chunks: chunkIndex,
          total_size: input.bytes.byteLength,
          sha256: sha256(input.bytes),
        });
      });
    } catch (error) {
      rmSync(directory, { force: true, recursive: true });
      this.#removeEmptySessionDirectory(directory);
      throw error;
    }
    return {
      kind: "artifacts",
      rsid,
      invocationId,
      result: { artifacts: references },
      partials,
      descriptors,
      chunkBytes,
      retainedDirectory: directory,
      retainedFiles,
    };
  }

  public retainChunkedResult(
    rsid: string,
    invocationId: string,
    bytes: Uint8Array,
    chunkBytes: number = RBP_MAX_DECODED_CHUNK_BYTES,
    contentType = "application/json",
  ): ChunkedResultCarrier {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > RBP_MAX_DECODED_CHUNK_BYTES) {
      throw new RangeError("result chunk bytes exceed the RBP/1 partial limit");
    }
    if (bytes.byteLength < 1 || bytes.byteLength > RBP_MAX_RECONSTRUCTED_INVOCATION_BYTES) {
      throw new RangeError("chunked result bytes must be between 1 byte and 32 MiB");
    }
    if (!safeContentType(contentType)) {
      throw new Error("chunked result content type must contain from 1 through 4096 characters");
    }
    const directory = this.#createInvocationDirectory(rsid, invocationId);
    const retained = join(directory, "result.json");
    try {
      writeFileSync(retained, bytes, { flag: "wx" });
      const partials: Extract<RbpPartial, { kind: "chunk" }>[] = [];
      for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += chunkBytes, chunkIndex += 1) {
        partials.push({
          kind: "chunk",
          invocation_id: invocationId,
          stream_id: "result",
          chunk_index: chunkIndex,
          encoding: "base64",
          content_type: contentType,
          data: Buffer.from(bytes.subarray(offset, offset + chunkBytes)).toString("base64"),
        });
      }
      return {
        kind: "chunked_result",
        rsid,
        invocationId,
        partials,
        chunkBytes,
        contentType,
        totalChunks: partials.length,
        totalSize: bytes.byteLength,
        sha256: sha256(bytes),
        retainedDirectory: directory,
        retainedFiles: [retained],
      };
    } catch (error) {
      rmSync(directory, { force: true, recursive: true });
      this.#removeEmptySessionDirectory(directory);
      throw error;
    }
  }

  /** Compact durable metadata; payload bytes remain in the guarded spool. */
  public compact<T extends DurableResultCarrier>(carrier: T): T {
    return { ...carrier, partials: [] };
  }

  /**
   * Returns bounded carrier/descriptor evidence without exposing the managed
   * spool root, retained directories, or local file paths. Every selected
   * carrier is rehydrated through the same non-reparse/containment/digest
   * guards used for retransmission; malformed retained state fails closed.
   */
  public inspectRetained(
    carriers: readonly DurableResultCarrier[],
  ): SanitizedArtifactSpoolEvidence {
    if (carriers.length > MAX_SPOOL_EVIDENCE_CARRIERS) {
      throw new Error(`retained carrier evidence exceeds ${MAX_SPOOL_EVIDENCE_CARRIERS}`);
    }
    const byIdentity = new Map<string, SanitizedArtifactCarrierEvidence>();
    for (const compact of carriers) {
      const carrier = this.rehydrate(compact);
      const streams: SanitizedArtifactStreamEvidence[] = carrier.kind === "artifacts"
        ? carrier.descriptors.map((descriptor) => ({
            streamId: descriptor.stream_id,
            artifactId: descriptor.artifact_id,
            artifactIndex: descriptor.artifact_index,
            filename: descriptor.filename,
            ...sanitizedContentTypeEvidence(descriptor.content_type),
            totalChunks: descriptor.total_chunks,
            totalSize: descriptor.total_size,
            sha256: descriptor.sha256 as `sha256:${string}`,
          }))
        : [{
            streamId: "result",
            artifactId: null,
            artifactIndex: null,
            filename: null,
            ...sanitizedContentTypeEvidence(carrier.contentType),
            totalChunks: carrier.totalChunks,
            totalSize: carrier.totalSize,
            sha256: carrier.sha256,
          }];
      const evidence: SanitizedArtifactCarrierEvidence = {
        rsid: carrier.rsid,
        invocationId: carrier.invocationId,
        kind: carrier.kind,
        chunkBytes: carrier.chunkBytes,
        streamCount: streams.length,
        retainedFileCount: carrier.retainedFiles.length,
        totalChunks: streams.reduce((sum, stream) => sum + stream.totalChunks, 0),
        totalSize: streams.reduce((sum, stream) => sum + stream.totalSize, 0),
        descriptorDigest: sha256(Buffer.from(JSON.stringify(streams), "utf8")),
        streams,
      };
      const identity = `${carrier.rsid}\u0000${carrier.invocationId}`;
      const existing = byIdentity.get(identity);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(evidence)) {
        throw new Error("conflicting retained carriers share one composite identity");
      }
      byIdentity.set(identity, evidence);
    }
    const ordered = [...byIdentity.values()].sort((left, right) =>
      left.rsid.localeCompare(right.rsid) || left.invocationId.localeCompare(right.invocationId)
    );
    return {
      evidenceVersion: 1,
      rootPathRedacted: true,
      rawPathExposed: false,
      carrierCount: ordered.length,
      retainedFileCount: ordered.reduce((sum, carrier) => sum + carrier.retainedFileCount, 0),
      totalChunks: ordered.reduce((sum, carrier) => sum + carrier.totalChunks, 0),
      totalSize: ordered.reduce((sum, carrier) => sum + carrier.totalSize, 0),
      carriers: ordered,
    };
  }

  /**
   * Rebuilds the exact chunk plan after restart from a compact durable carrier.
   * Missing, moved, linked, resized, or digest-mismatched files fail closed so
   * no stale descriptor can claim replayable artifact bytes.
   */
  public rehydrate(carrier: DurableResultCarrier): DurableResultCarrier {
    if (carrier.kind === "chunked_result") return this.#rehydrateChunkedResult(carrier);
    if (
      !Number.isSafeInteger(carrier.chunkBytes) || carrier.chunkBytes < 1 ||
      carrier.chunkBytes > RBP_MAX_DECODED_CHUNK_BYTES ||
      carrier.result.artifacts.length !== carrier.descriptors.length ||
      carrier.retainedFiles.length !== carrier.descriptors.length ||
      carrier.descriptors.some((descriptor) =>
        !safeFilename(descriptor.filename) || !safeContentType(descriptor.content_type)
      )
    ) {
      throw new Error("durable artifact carrier shape is invalid");
    }
    const directory = this.#assertCarrierDirectory(carrier);
    const realRoot = realpathSync.native(this.#root);
    const realDirectory = realpathSync.native(directory);
    assertInside(realRoot, realDirectory);
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("durable artifact directory is not a real directory");
    }

    const partials: Extract<RbpPartial, { kind: "chunk" }>[] = [];
    carrier.descriptors.forEach((descriptor, index) => {
      const reference = carrier.result.artifacts[index];
      const retainedFile = carrier.retainedFiles[index];
      if (
        reference === undefined || retainedFile === undefined ||
        descriptor.artifact_index !== index || reference.artifact_index !== index ||
        reference.artifact_id !== descriptor.artifact_id ||
        descriptor.stream_id !== `artifact:${descriptor.artifact_id}`
      ) {
        throw new Error("durable artifact descriptor identity mismatch");
      }
      const candidate = resolve(retainedFile);
      assertInside(directory, candidate);
      const realCandidate = realpathSync.native(candidate);
      assertInside(realDirectory, realCandidate);
      const stat = lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error("durable artifact member is not a regular non-reparse file");
      }
      const bytes = readFileSync(candidate);
      if (bytes.byteLength !== descriptor.total_size || sha256(bytes) !== descriptor.sha256) {
        throw new Error("durable artifact member no longer matches its descriptor");
      }
      let chunkIndex = 0;
      for (let offset = 0; offset < bytes.byteLength; offset += carrier.chunkBytes) {
        partials.push({
          kind: "chunk",
          invocation_id: carrier.invocationId,
          stream_id: descriptor.stream_id,
          artifact_id: descriptor.artifact_id,
          artifact_index: descriptor.artifact_index,
          chunk_index: chunkIndex,
          encoding: "base64",
          content_type: descriptor.content_type,
          data: bytes.subarray(offset, offset + carrier.chunkBytes).toString("base64"),
        });
        chunkIndex += 1;
      }
      if (chunkIndex !== descriptor.total_chunks) {
        throw new Error("durable artifact chunk count no longer matches its descriptor");
      }
    });
    return { ...carrier, partials };
  }

  /** Cleanup is legal only after the terminal carrier has a durable RBP ack. */
  public acknowledge(carrier: DurableResultCarrier): void {
    const directory = this.#assertCarrierDirectory(carrier);
    if (!existsSync(directory)) {
      this.#removeEmptySessionDirectory(directory);
      return;
    }
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("retained result directory is not a real directory");
    }
    for (const file of carrier.retainedFiles) {
      const resolvedFile = resolve(file);
      assertInside(directory, resolvedFile);
    }
    rmSync(directory, { force: false, recursive: true });
    this.#removeEmptySessionDirectory(directory);
  }

  public expire(carrier: DurableResultCarrier): void {
    const directory = this.#assertCarrierDirectory(carrier);
    rmSync(directory, { force: true, recursive: true });
    this.#removeEmptySessionDirectory(directory);
  }

  /** Removes crash-left payloads that have no durable journal/plan reference. */
  public reconcileOrphans(referencedDirectories: ReadonlySet<string>): readonly string[] {
    const referenced = new Set([...referencedDirectories].map((entry) => resolve(entry)));
    const removed: string[] = [];
    for (const sessionEntry of readdirSync(this.#root, { withFileTypes: true })) {
      const sessionDirectory = join(this.#root, sessionEntry.name);
      assertInside(this.#root, sessionDirectory);
      if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) {
        rmSync(sessionDirectory, { force: true, recursive: true });
        removed.push(sessionDirectory);
        continue;
      }
      for (const invocationEntry of readdirSync(sessionDirectory, { withFileTypes: true })) {
        const invocationDirectory = join(sessionDirectory, invocationEntry.name);
        assertInside(sessionDirectory, invocationDirectory);
        if (!referenced.has(resolve(invocationDirectory))) {
          rmSync(invocationDirectory, { force: true, recursive: true });
          removed.push(invocationDirectory);
        }
      }
      this.#removeEmptySessionDirectory(join(sessionDirectory, "placeholder"));
    }
    return removed;
  }

  #createInvocationDirectory(rsid: string, invocationId: string): string {
    safeStorageSegment(rsid, "rsid");
    safeStorageSegment(invocationId, "invocation id");
    const sessionDirectory = join(this.#root, rsid);
    assertInside(this.#root, sessionDirectory);
    mkdirSync(sessionDirectory, { recursive: true });
    const sessionStat = lstatSync(sessionDirectory);
    if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
      throw new Error("artifact session spool must be a real directory");
    }
    const directory = join(sessionDirectory, invocationId);
    assertInside(sessionDirectory, directory);
    mkdirSync(directory, { recursive: false });
    return directory;
  }

  #assertCarrierDirectory(carrier: DurableResultCarrier): string {
    safeStorageSegment(carrier.rsid, "carrier rsid");
    safeStorageSegment(carrier.invocationId, "carrier invocation id");
    const directory = resolve(carrier.retainedDirectory);
    const expected = resolve(this.#root, carrier.rsid, carrier.invocationId);
    if (directory !== expected) throw new Error("durable result carrier path does not match its composite identity");
    assertInside(this.#root, directory);
    return directory;
  }

  #rehydrateChunkedResult(carrier: ChunkedResultCarrier): ChunkedResultCarrier {
    if (
      !Number.isSafeInteger(carrier.chunkBytes) || carrier.chunkBytes < 1 ||
      carrier.chunkBytes > RBP_MAX_DECODED_CHUNK_BYTES ||
      carrier.retainedFiles.length !== 1 || !safeContentType(carrier.contentType)
    ) throw new Error("durable chunked-result carrier shape is invalid");
    const directory = this.#assertCarrierDirectory(carrier);
    const realRoot = realpathSync.native(this.#root);
    const realDirectory = realpathSync.native(directory);
    assertInside(realRoot, realDirectory);
    const candidate = resolve(carrier.retainedFiles[0]);
    assertInside(directory, candidate);
    const realCandidate = realpathSync.native(candidate);
    assertInside(realDirectory, realCandidate);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("durable chunked result is not a regular non-reparse file");
    }
    const bytes = readFileSync(candidate);
    if (bytes.byteLength !== carrier.totalSize || sha256(bytes) !== carrier.sha256) {
      throw new Error("durable chunked result no longer matches its descriptor");
    }
    const partials: Extract<RbpPartial, { kind: "chunk" }>[] = [];
    for (let offset = 0, chunkIndex = 0; offset < bytes.byteLength; offset += carrier.chunkBytes, chunkIndex += 1) {
      partials.push({
        kind: "chunk",
        invocation_id: carrier.invocationId,
        stream_id: "result",
        chunk_index: chunkIndex,
        encoding: "base64",
        content_type: carrier.contentType,
        data: bytes.subarray(offset, offset + carrier.chunkBytes).toString("base64"),
      });
    }
    if (partials.length !== carrier.totalChunks) {
      throw new Error("durable chunked-result count no longer matches its descriptor");
    }
    return { ...carrier, partials };
  }

  #removeEmptySessionDirectory(invocationDirectory: string): void {
    const sessionDirectory = dirname(invocationDirectory);
    if (sessionDirectory === this.#root) return;
    assertInside(this.#root, sessionDirectory);
    try {
      rmdirSync(sessionDirectory);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
    }
  }
}

export class ArtifactReconstructor {
  #state: StreamAssemblerState;

  public constructor(invocationId: string) {
    this.#state = createStreamAssembler(invocationId);
  }

  public append(chunk: Extract<RbpPartial, { kind: "chunk" }>): "appended" | "duplicate" {
    const result = appendStreamChunk(this.#state, chunk);
    if (result.kind !== "appended" && result.kind !== "duplicate") {
      const detail = result.kind === "gap"
        ? `expected ${result.expectedChunkIndex}, received ${result.receivedChunkIndex}`
        : "reason" in result ? result.reason : "unexpected stream state";
      throw new Error(`artifact stream rejected: ${result.kind}/${detail}`);
    }
    this.#state = result.state;
    return result.kind;
  }

  public finalize(
    references: readonly ArtifactReference[],
    descriptors: readonly ArtifactDescriptor[],
  ): readonly CompletedStream[] {
    const result = finalizeStreams(this.#state, {
      kind: "artifact_result",
      artifactReferences: references,
      descriptors,
    });
    if (result.kind !== "complete") {
      throw new Error(`artifact reconstruction rejected: ${result.kind}/${result.reason}`);
    }
    return result.streams;
  }
}
