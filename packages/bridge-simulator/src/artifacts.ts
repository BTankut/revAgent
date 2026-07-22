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
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

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
  readonly invocationId: string;
  readonly result: { readonly artifacts: readonly ArtifactReference[] };
  readonly partials: readonly Extract<RbpPartial, { kind: "chunk" }>[];
  readonly descriptors: readonly ArtifactDescriptor[];
  readonly retainedDirectory: string;
  readonly retainedFiles: readonly string[];
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
  const stem = (value.split(".", 1)[0] ?? "").toUpperCase();
  return !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u.test(stem);
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("artifact path is outside the managed spool root");
  }
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
    invocationId: string,
    paths: readonly { readonly path: string; readonly contentType: string }[],
  ): ArtifactCarrier {
    const realRoot = realpathSync.native(this.#root);
    const inputs: ArtifactInput[] = [];
    for (const entry of paths) {
      const candidate = resolve(entry.path);
      assertInside(realRoot, candidate);
      const before = lstatSync(candidate);
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new Error("artifact source must be a regular non-reparse file");
      }
      const descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const opened = fstatSync(descriptor);
        if (!opened.isFile() || opened.size !== before.size) {
          throw new Error("artifact source changed during validated open");
        }
        bytes = readFileSync(descriptor);
        if (fstatSync(descriptor).size !== opened.size) {
          throw new Error("artifact source changed while reading");
        }
      } finally {
        closeSync(descriptor);
      }
      inputs.push({ filename: basename(candidate), contentType: entry.contentType, bytes });
    }
    return this.retain(invocationId, inputs);
  }

  public retain(invocationId: string, inputs: readonly ArtifactInput[]): ArtifactCarrier {
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
    const names = new Set(inputs.map((input) => input.filename.toLowerCase()));
    if (names.size !== inputs.length) throw new Error("artifact basenames must be unique");

    const directory = join(this.#root, invocationId);
    assertInside(this.#root, directory);
    mkdirSync(directory, { recursive: false });
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
        for (let offset = 0; offset < input.bytes.byteLength; offset += RBP_MAX_DECODED_CHUNK_BYTES) {
          const chunk = input.bytes.slice(offset, offset + RBP_MAX_DECODED_CHUNK_BYTES);
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
      throw error;
    }
    return {
      invocationId,
      result: { artifacts: references },
      partials,
      descriptors,
      retainedDirectory: directory,
      retainedFiles,
    };
  }

  /** Cleanup is legal only after the terminal carrier has a durable RBP ack. */
  public acknowledge(carrier: ArtifactCarrier): void {
    const directory = resolve(carrier.retainedDirectory);
    assertInside(this.#root, directory);
    if (!existsSync(directory)) return;
    for (const file of carrier.retainedFiles) {
      const resolvedFile = resolve(file);
      assertInside(directory, resolvedFile);
      if (statSync(resolvedFile).isDirectory()) throw new Error("retained artifact became a directory");
    }
    rmSync(directory, { force: false, recursive: true });
  }

  public expire(carrier: ArtifactCarrier): void {
    const directory = resolve(carrier.retainedDirectory);
    assertInside(this.#root, directory);
    rmSync(directory, { force: true, recursive: true });
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
