import { createHash, randomUUID } from "node:crypto";

import {
  appendStreamChunk,
  createStreamAssembler,
  finalizeStreams,
  type RbpStreamChunk,
  type TerminalStreamManifest,
} from "@revagent/protocol";

import type { AuthContext } from "./authContext.js";
import type { GatewayJsonValue } from "./dispatch.js";
import type { GatewayProtocolStore, ObjectStorePort } from "./store.js";

const RESOURCE_NAMESPACE = "gateway_resource_v1";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_FILENAME_PATTERN = /^[^\\/:<>"|?*\u0000-\u001f\u007f]+$/u;

export const GW9_ALLOWED_UPLOAD_CONTENT_TYPES = Object.freeze([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/tab-separated-values",
] as const);

export const GW9_ALLOWED_OUTPUT_CONTENT_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/x-tga",
] as const);

export interface GatewayResourceScope {
  readonly tenantId: string;
  readonly actorId: string;
  readonly principalKey: string;
  readonly mcpSessionId: string;
}

export function resourceScopeFromAuth(
  auth: AuthContext,
  mcpSessionId: string,
): GatewayResourceScope {
  return Object.freeze({
    tenantId: auth.actor.tenantId,
    actorId: auth.actor.userId,
    principalKey: auth.principalKey,
    mcpSessionId,
  });
}

export type GatewayResourceKind = "artifact_ref" | "result_ref";

interface ResourceRecordBase {
  readonly schemaVersion: "revagent-gateway-resource/v1";
  readonly kind: GatewayResourceKind;
  readonly refId: string;
  readonly actorId: string;
  readonly principalKey: string;
  readonly mcpSessionId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

interface ArtifactRecord extends ResourceRecordBase {
  readonly kind: "artifact_ref";
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly storageKey: string;
  readonly quarantineStatus: "quarantined" | "released";
  readonly source: "north_upload" | "rbp_output";
  readonly invocationId: string | null;
  readonly artifactIndex: number | null;
}

interface ResultRecord extends ResourceRecordBase {
  readonly kind: "result_ref";
  readonly contentType: "application/json";
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly storageKey: string;
}

type ResourceRecord = ArtifactRecord | ResultRecord;

export type GatewayResourceErrorCode =
  | "invalid_input"
  | "content_type_denied"
  | "oversize"
  | "digest_mismatch"
  | "quarantined"
  | "not_found"
  | "expired"
  | "scope_denied"
  | "protocol_fault"
  | "incomplete"
  | "storage_unavailable";

export class GatewayResourceError extends Error {
  public constructor(
    readonly code: GatewayResourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayResourceError";
  }
}

export interface GatewayArtifactRef {
  readonly kind: "artifact_ref";
  readonly refId: string;
  readonly uri: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly expiresAtMs: number;
}

export interface GatewayResultRef {
  readonly kind: "result_ref";
  readonly refId: string;
  readonly uri: string;
  readonly contentType: "application/json";
  readonly byteSize: number;
  readonly digest: `sha256:${string}`;
  readonly pageCount: number;
  readonly expiresAtMs: number;
}

export interface GatewayResourceRead {
  readonly uri: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly nextPageUri: string | null;
}

export interface GatewayResourceAuthorityOptions {
  readonly protocolStore: GatewayProtocolStore;
  readonly objectStore: ObjectStorePort;
  readonly now?: () => number;
  readonly newRefId?: () => string;
  readonly maxUploadBytes?: number;
  readonly maxResultBytes?: number;
  readonly maxResultPageBytes?: number;
  readonly defaultTtlMs?: number;
}

export interface UploadArtifactInput {
  readonly scope: GatewayResourceScope;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly quarantineStatus: "quarantined" | "released";
  readonly expectedDigest?: `sha256:${string}`;
  readonly expiresAtMs?: number;
}

export interface IngestRbpArtifactCarrierInput {
  readonly scope: GatewayResourceScope;
  readonly invocationId: string;
  readonly chunks: readonly RbpStreamChunk[];
  readonly manifest: Extract<TerminalStreamManifest, { kind: "artifact_result" }>;
  readonly expiresAtMs?: number;
}

export type BoundedGatewayResult =
  | { readonly kind: "inline"; readonly value: GatewayJsonValue }
  | GatewayResultRef;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fail(code: GatewayResourceErrorCode, message: string): never {
  throw new GatewayResourceError(code, message);
}

function safeFilename(filename: string): boolean {
  if (
    filename.length < 1 ||
    filename.length > 255 ||
    filename !== filename.trim() ||
    !SAFE_FILENAME_PATTERN.test(filename) ||
    filename.includes("..") ||
    filename.startsWith(".") ||
    /[. ]$/u.test(filename)
  ) {
    return false;
  }
  const stem = filename.split(".", 1)[0]?.toUpperCase() ?? "";
  return !/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u.test(
    stem,
  );
}

function assertScope(scope: GatewayResourceScope): void {
  for (const [name, value] of Object.entries(scope)) {
    if (value.length < 1 || value.length > 512 || /[\u0000\r\n]/u.test(value)) {
      fail("invalid_input", `${name} is invalid`);
    }
  }
}

function asJsonRecord(value: unknown): ResourceRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Partial<ResourceRecord>;
  const sharedInvalid =
    record.schemaVersion !== "revagent-gateway-resource/v1" ||
    (record.kind !== "artifact_ref" && record.kind !== "result_ref") ||
    typeof record.refId !== "string" || record.refId.length < 1 ||
    typeof record.actorId !== "string" || record.actorId.length < 1 ||
    typeof record.principalKey !== "string" || record.principalKey.length < 1 ||
    typeof record.mcpSessionId !== "string" || record.mcpSessionId.length < 1 ||
    !Number.isSafeInteger(record.createdAtMs) || record.createdAtMs! < 0 ||
    !Number.isSafeInteger(record.expiresAtMs) ||
    record.expiresAtMs! <= record.createdAtMs!;
  if (sharedInvalid) {
    return null;
  }
  if (record.kind === "artifact_ref") {
    if (
      typeof record.filename !== "string" ||
      !safeFilename(record.filename) ||
      typeof record.contentType !== "string" ||
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize! < 0 ||
      typeof record.digest !== "string" ||
      !SHA256_PATTERN.test(record.digest) ||
      typeof record.storageKey !== "string" ||
      record.storageKey.length < 1 ||
      (record.quarantineStatus !== "quarantined" &&
        record.quarantineStatus !== "released") ||
      (record.source !== "north_upload" && record.source !== "rbp_output") ||
      (record.source === "north_upload" &&
        (record.invocationId !== null || record.artifactIndex !== null)) ||
      (record.source === "rbp_output" &&
        (typeof record.invocationId !== "string" ||
          record.invocationId.length < 1 ||
          !Number.isSafeInteger(record.artifactIndex) ||
          record.artifactIndex! < 0)) ||
      (record.invocationId !== null && typeof record.invocationId !== "string") ||
      (record.artifactIndex !== null &&
        (!Number.isSafeInteger(record.artifactIndex) || record.artifactIndex! < 0))
    ) {
      return null;
    }
    return record as ArtifactRecord;
  }
  const result = record as Partial<ResultRecord>;
  if (
    result.contentType !== "application/json" ||
    !Number.isSafeInteger(record.byteSize) ||
    record.byteSize! < 0 ||
    typeof record.digest !== "string" ||
    !SHA256_PATTERN.test(record.digest) ||
    !Number.isSafeInteger(result.pageSize) ||
    result.pageSize! < 1 ||
    !Number.isSafeInteger(result.pageCount) ||
    result.pageCount! < 1 ||
    typeof record.storageKey !== "string" ||
    record.storageKey.length < 1
  ) {
    return null;
  }
  return record as ResultRecord;
}

function recordKey(kind: GatewayResourceKind, refId: string): string {
  return `${kind}:${refId}`;
}

function storageKey(
  scope: GatewayResourceScope,
  kind: GatewayResourceKind,
  refId: string,
  digest: `sha256:${string}`,
): string {
  const tenant = createHash("sha256").update(scope.tenantId).digest("hex");
  const opaqueRef = createHash("sha256").update(`${refId}\u0000${digest}`).digest("hex");
  return `gateway-resources/${tenant}/${kind}/${opaqueRef}`;
}

function artifactUri(refId: string): string {
  return `revagent://artifact/${encodeURIComponent(refId)}`;
}

function resultUri(refId: string, page = 0): string {
  return `revagent://result/${encodeURIComponent(refId)}/${String(page)}`;
}

function splitResultBytes(bytes: Uint8Array, pageSize: number): readonly Uint8Array[] {
  const pages: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += pageSize) {
    pages.push(bytes.slice(offset, Math.min(offset + pageSize, bytes.byteLength)));
  }
  return pages.length === 0 ? [new Uint8Array()] : pages;
}

export class GatewayResourceAuthority {
  readonly #protocolStore: GatewayProtocolStore;
  readonly #objectStore: ObjectStorePort;
  readonly #now: () => number;
  readonly #newRefId: () => string;
  readonly #maxUploadBytes: number;
  readonly #maxResultBytes: number;
  readonly #maxResultPageBytes: number;
  readonly #defaultTtlMs: number;

  public constructor(options: GatewayResourceAuthorityOptions) {
    this.#protocolStore = options.protocolStore;
    this.#objectStore = options.objectStore;
    this.#now = options.now ?? Date.now;
    this.#newRefId = options.newRefId ?? randomUUID;
    this.#maxUploadBytes = options.maxUploadBytes ?? 16 * 1024 * 1024;
    this.#maxResultBytes = options.maxResultBytes ?? 32 * 1024 * 1024;
    this.#maxResultPageBytes = options.maxResultPageBytes ?? 512 * 1024;
    this.#defaultTtlMs = options.defaultTtlMs ?? 15 * 60 * 1_000;
    for (const [name, value] of Object.entries({
      maxUploadBytes: this.#maxUploadBytes,
      maxResultBytes: this.#maxResultBytes,
      maxResultPageBytes: this.#maxResultPageBytes,
      defaultTtlMs: this.#defaultTtlMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
  }

  public async uploadArtifact(input: UploadArtifactInput): Promise<GatewayArtifactRef> {
    assertScope(input.scope);
    if (!safeFilename(input.filename)) {
      fail("invalid_input", "filename is not a safe leaf name");
    }
    if (!(GW9_ALLOWED_UPLOAD_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      fail("content_type_denied", "upload content type is not allowlisted");
    }
    const bytes = new Uint8Array(input.bytes);
    if (bytes.byteLength > this.#maxUploadBytes) {
      fail("oversize", "upload exceeds the configured byte limit");
    }
    const digest = sha256(bytes);
    if (input.expectedDigest !== undefined && input.expectedDigest !== digest) {
      fail("digest_mismatch", "upload digest does not match expectedDigest");
    }
    return this.#storeArtifact({
      scope: input.scope,
      filename: input.filename,
      contentType: input.contentType,
      bytes,
      digest,
      expiresAtMs: this.#expiry(input.expiresAtMs),
      quarantineStatus: input.quarantineStatus,
      source: "north_upload",
      invocationId: null,
      artifactIndex: null,
    });
  }

  public async ingestRbpArtifactCarrier(
    input: IngestRbpArtifactCarrierInput,
  ): Promise<readonly GatewayArtifactRef[]> {
    assertScope(input.scope);
    if (input.manifest.descriptors.some((item) => !safeFilename(item.filename))) {
      fail("invalid_input", "RBP artifact filename is not a safe leaf name");
    }
    let assembler = createStreamAssembler(input.invocationId, {
      maxInvocationBytes: this.#maxResultBytes,
    });
    for (const chunk of input.chunks) {
      const appended = appendStreamChunk(assembler, chunk);
      assembler = appended.state;
      if (appended.kind === "gap") {
        fail("incomplete", "RBP artifact chunk rejected: chunk_gap");
      }
      if (appended.kind === "protocol_fault" || appended.kind === "oversize") {
        fail(
          appended.kind === "oversize" ? "oversize" : "protocol_fault",
          `RBP artifact chunk rejected: ${appended.reason}`,
        );
      }
    }
    const finalized = finalizeStreams(assembler, input.manifest);
    if (finalized.kind !== "complete") {
      fail(
        finalized.kind === "incomplete" ? "incomplete" : finalized.kind === "oversize" ? "oversize" : "protocol_fault",
        `RBP artifact carrier rejected: ${finalized.reason}`,
      );
    }
    const expiresAtMs = this.#expiry(input.expiresAtMs);
    const pending = finalized.streams.map((stream, index) => {
      const descriptor = input.manifest.descriptors[index];
      if (
        descriptor === undefined ||
        stream.artifactId !== descriptor.artifact_id ||
        stream.artifactIndex !== index ||
        !(GW9_ALLOWED_OUTPUT_CONTENT_TYPES as readonly string[]).includes(stream.contentType)
      ) {
        fail("content_type_denied", "RBP artifact output is not an allowlisted image");
      }
      return {
        scope: input.scope,
        filename: descriptor.filename,
        contentType: stream.contentType,
        bytes: stream.bytes,
        digest: stream.sha256,
        expiresAtMs,
        quarantineStatus: "released" as const,
        source: "rbp_output" as const,
        invocationId: input.invocationId,
        artifactIndex: index,
      };
    });
    return this.#storeArtifactSet(pending);
  }

  public async boundResult(input: {
    readonly scope: GatewayResourceScope;
    readonly value: GatewayJsonValue;
    readonly maxInlineBytes: number;
    readonly expiresAtMs?: number;
  }): Promise<BoundedGatewayResult> {
    assertScope(input.scope);
    if (!Number.isSafeInteger(input.maxInlineBytes) || input.maxInlineBytes < 0) {
      fail("invalid_input", "maxInlineBytes must be a non-negative safe integer");
    }
    const bytes = Buffer.from(JSON.stringify(input.value), "utf8");
    if (bytes.byteLength <= input.maxInlineBytes) {
      return Object.freeze({ kind: "inline" as const, value: input.value });
    }
    if (bytes.byteLength > this.#maxResultBytes) {
      fail("oversize", "structured result exceeds the configured byte limit");
    }
    const refId = this.#validatedRefId();
    await this.#assertRefAbsent(input.scope, "result_ref", refId);
    const digest = sha256(bytes);
    const key = storageKey(input.scope, "result_ref", refId, digest);
    const pages = splitResultBytes(bytes, this.#maxResultPageBytes);
    const put = await this.#objectStore.put({
      tenantId: input.scope.tenantId,
      storageKey: key,
      bytes,
      contentType: "application/json",
    });
    if (!put.ok) {
      fail("storage_unavailable", put.message);
    }
    if (put.value.storageKey !== key) {
      await this.#objectStore.delete({
        tenantId: input.scope.tenantId,
        storageKey: key,
      });
      fail("storage_unavailable", "object store changed the requested storage key");
    }
    const record: ResultRecord = Object.freeze({
      schemaVersion: "revagent-gateway-resource/v1",
      kind: "result_ref",
      refId,
      actorId: input.scope.actorId,
      principalKey: input.scope.principalKey,
      mcpSessionId: input.scope.mcpSessionId,
      createdAtMs: this.#now(),
      expiresAtMs: this.#expiry(input.expiresAtMs),
      contentType: "application/json",
      byteSize: bytes.byteLength,
      digest,
      pageSize: this.#maxResultPageBytes,
      pageCount: pages.length,
      storageKey: key,
    });
    const stored = await this.#writeRecords(input.scope, [record]);
    if (!stored) {
      await this.#objectStore.delete({ tenantId: input.scope.tenantId, storageKey: key });
      fail("storage_unavailable", "result_ref metadata was not durably accepted");
    }
    return Object.freeze({
      kind: "result_ref" as const,
      refId,
      uri: resultUri(refId),
      contentType: "application/json" as const,
      byteSize: bytes.byteLength,
      digest,
      pageCount: pages.length,
      expiresAtMs: record.expiresAtMs,
    });
  }

  public async consumeArtifact(
    scope: GatewayResourceScope,
    refId: string,
  ): Promise<GatewayResourceRead> {
    const record = await this.#readRecord(scope, "artifact_ref", refId);
    if (record.kind !== "artifact_ref") {
      fail("not_found", "artifact_ref was not found");
    }
    const bytes = await this.#verifiedBytes(scope, record);
    return Object.freeze({
      uri: artifactUri(refId),
      contentType: record.contentType,
      bytes,
      digest: record.digest,
      nextPageUri: null,
    });
  }

  public async readResource(
    scope: GatewayResourceScope,
    uri: URL,
  ): Promise<GatewayResourceRead> {
    assertScope(scope);
    if (uri.protocol !== "revagent:") {
      fail("not_found", "resource URI is outside the revAgent namespace");
    }
    const parts = uri.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (uri.hostname === "artifact" && parts.length === 1) {
      return this.consumeArtifact(scope, parts[0]!);
    }
    if (uri.hostname === "result" && parts.length === 2) {
      const refId = parts[0]!;
      const page = Number(parts[1]);
      const record = await this.#readRecord(scope, "result_ref", refId);
      if (record.kind !== "result_ref") {
        fail("not_found", "result_ref was not found");
      }
      if (!Number.isSafeInteger(page) || page < 0 || page >= record.pageCount) {
        fail("not_found", "result_ref page was not found");
      }
      const allBytes = await this.#verifiedBytes(scope, record);
      const start = page * record.pageSize;
      const bytes = allBytes.slice(start, Math.min(start + record.pageSize, allBytes.byteLength));
      return Object.freeze({
        uri: resultUri(refId, page),
        contentType: record.contentType,
        bytes,
        digest: sha256(bytes),
        nextPageUri: page + 1 < record.pageCount ? resultUri(refId, page + 1) : null,
      });
    }
    fail("not_found", "resource URI does not match an artifact or result ref");
  }

  async #storeArtifact(input: {
    readonly scope: GatewayResourceScope;
    readonly filename: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly expiresAtMs: number;
    readonly quarantineStatus: ArtifactRecord["quarantineStatus"];
    readonly source: ArtifactRecord["source"];
    readonly invocationId: string | null;
    readonly artifactIndex: number | null;
  }): Promise<GatewayArtifactRef> {
    const [ref] = await this.#storeArtifactSet([input]);
    if (ref === undefined) {
      fail("storage_unavailable", "artifact_ref metadata was not accepted");
    }
    return ref;
  }

  async #storeArtifactSet(inputs: readonly {
    readonly scope: GatewayResourceScope;
    readonly filename: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
    readonly expiresAtMs: number;
    readonly quarantineStatus: ArtifactRecord["quarantineStatus"];
    readonly source: ArtifactRecord["source"];
    readonly invocationId: string | null;
    readonly artifactIndex: number | null;
  }[]): Promise<readonly GatewayArtifactRef[]> {
    if (inputs.length < 1) {
      fail("invalid_input", "artifact set must not be empty");
    }
    const scope = inputs[0]!.scope;
    if (inputs.some((input) => JSON.stringify(input.scope) !== JSON.stringify(scope))) {
      fail("scope_denied", "one artifact set cannot mix authorization scopes");
    }
    const records: ArtifactRecord[] = [];
    const refIds = new Set<string>();
    for (const input of inputs) {
      const refId = this.#validatedRefId();
      if (refIds.has(refId)) {
        await this.#deleteStored(scope, records);
        fail("invalid_input", "generated resource refs must be unique");
      }
      refIds.add(refId);
      await this.#assertRefAbsent(scope, "artifact_ref", refId);
      const key = storageKey(scope, "artifact_ref", refId, input.digest);
      const put = await this.#objectStore.put({
        tenantId: scope.tenantId,
        storageKey: key,
        bytes: input.bytes,
        contentType: input.contentType,
      });
      if (!put.ok) {
        await this.#deleteStored(scope, records);
        fail("storage_unavailable", put.message);
      }
      if (put.value.storageKey !== key) {
        await this.#objectStore.delete({ tenantId: scope.tenantId, storageKey: key });
        await this.#deleteStored(scope, records);
        fail("storage_unavailable", "object store changed the requested storage key");
      }
      records.push(Object.freeze({
        schemaVersion: "revagent-gateway-resource/v1",
        kind: "artifact_ref",
        refId,
        actorId: scope.actorId,
        principalKey: scope.principalKey,
        mcpSessionId: scope.mcpSessionId,
        createdAtMs: this.#now(),
        expiresAtMs: input.expiresAtMs,
        filename: input.filename,
        contentType: input.contentType,
        byteSize: input.bytes.byteLength,
        digest: input.digest,
        storageKey: key,
        quarantineStatus: input.quarantineStatus,
        source: input.source,
        invocationId: input.invocationId,
        artifactIndex: input.artifactIndex,
      }));
    }
    const stored = await this.#writeRecords(scope, records);
    if (!stored) {
      await this.#deleteStored(scope, records);
      fail("storage_unavailable", "artifact set metadata was not durably accepted");
    }
    return Object.freeze(records.map((record) => Object.freeze({
      kind: "artifact_ref" as const,
      refId: record.refId,
      uri: artifactUri(record.refId),
      filename: record.filename,
      contentType: record.contentType,
      byteSize: record.byteSize,
      digest: record.digest,
      expiresAtMs: record.expiresAtMs,
    })));
  }

  async #writeRecords(
    scope: GatewayResourceScope,
    records: readonly ResourceRecord[],
  ): Promise<boolean> {
    const outcome = await this.#protocolStore.transact(
      { tenantId: scope.tenantId },
      (tx) => {
        for (const record of records) {
          tx.stage({
            namespace: RESOURCE_NAMESPACE,
            key: recordKey(record.kind, record.refId),
            value: record as unknown as GatewayJsonValue,
            expect: { kind: "absent" },
          });
        }
      },
    );
    return outcome.ok;
  }

  async #assertRefAbsent(
    scope: GatewayResourceScope,
    kind: GatewayResourceKind,
    refId: string,
  ): Promise<void> {
    const outcome = await this.#protocolStore.transact(
      { tenantId: scope.tenantId },
      (tx) => tx.read(RESOURCE_NAMESPACE, recordKey(kind, refId)),
    );
    if (!outcome.ok) {
      fail("storage_unavailable", outcome.message);
    }
    if (outcome.value !== null) {
      fail("invalid_input", "generated resource ref already exists");
    }
  }

  async #readRecord(
    scope: GatewayResourceScope,
    kind: GatewayResourceKind,
    refId: string,
  ): Promise<ResourceRecord> {
    assertScope(scope);
    if (refId.length < 1 || refId.length > 200 || /[\u0000\r\n/\\]/u.test(refId)) {
      fail("not_found", "resource ref is invalid");
    }
    const outcome = await this.#protocolStore.transact(
      { tenantId: scope.tenantId },
      (tx) => tx.read(RESOURCE_NAMESPACE, recordKey(kind, refId)),
    );
    if (!outcome.ok) {
      fail("storage_unavailable", outcome.message);
    }
    const record = asJsonRecord(outcome.value?.value);
    if (record === null || record.kind !== kind) {
      fail("not_found", "resource ref was not found");
    }
    if (
      record.actorId !== scope.actorId ||
      record.principalKey !== scope.principalKey ||
      record.mcpSessionId !== scope.mcpSessionId
    ) {
      fail("scope_denied", "resource ref does not belong to this actor and MCP session");
    }
    if (this.#now() >= record.expiresAtMs) {
      fail("expired", "resource ref has expired");
    }
    if (record.kind === "artifact_ref" && record.quarantineStatus !== "released") {
      fail("quarantined", "artifact_ref is not released from quarantine");
    }
    return record;
  }

  async #verifiedBytes(
    scope: GatewayResourceScope,
    record: ArtifactRecord | ResultRecord,
  ): Promise<Uint8Array> {
    const stored = await this.#objectStore.get({
      tenantId: scope.tenantId,
      storageKey: record.storageKey,
    });
    if (!stored.ok) {
      fail("storage_unavailable", stored.message);
    }
    if (
      stored.value.contentType !== record.contentType ||
      stored.value.bytes.byteLength !== record.byteSize ||
      sha256(stored.value.bytes) !== record.digest
    ) {
      fail("digest_mismatch", "stored resource bytes do not match durable metadata");
    }
    return new Uint8Array(stored.value.bytes);
  }

  async #deleteStored(
    scope: GatewayResourceScope,
    records: readonly Pick<ArtifactRecord | ResultRecord, "storageKey">[],
  ): Promise<void> {
    await Promise.allSettled(
      records.map((record) =>
        this.#objectStore.delete({
          tenantId: scope.tenantId,
          storageKey: record.storageKey,
        }),
      ),
    );
  }

  #expiry(requested: number | undefined): number {
    const now = this.#now();
    const expiry = requested ?? now + this.#defaultTtlMs;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiry) || expiry <= now) {
      fail("invalid_input", "resource expiry must be a future safe integer");
    }
    return expiry;
  }

  #validatedRefId(): string {
    const refId = this.#newRefId();
    if (refId.length < 1 || refId.length > 200 || /[\u0000\r\n/\\]/u.test(refId)) {
      fail("invalid_input", "generated resource ref is invalid");
    }
    return refId;
  }
}
