import { createHash, randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

import type { GatewayJsonValue } from "./dispatch.js";

export const RESULT_REFERENCE_MAX_BYTES = 5 * 1024 * 1024;
export const RESULT_REFERENCE_DEFAULT_PAGE_BYTES = 64 * 1024;
export const RESULT_REFERENCE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ResultReferenceScope {
  readonly tenantId: string;
  readonly sessionId: string;
}

export interface ResultReferenceSummary {
  readonly byteLength: number;
  readonly pageCount: number;
  readonly firstPageBase64: string;
  readonly truncated: boolean;
}

export interface ResultReference {
  readonly refId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly storageKey: string;
  readonly digest: `sha256:${string}`;
  readonly expiresAtMs: number;
  readonly pageSizeBytes: number;
  readonly pageCount: number;
  readonly summary: ResultReferenceSummary;
}

export type ResultReferencePage =
  | {
      readonly kind: "page";
      readonly ref: ResultReference;
      readonly pageIndex: number;
      readonly bytes: Uint8Array;
      readonly base64: string;
    }
  | { readonly kind: "not_found" }
  | { readonly kind: "expired" }
  | { readonly kind: "page_out_of_range" };

export interface ResultObjectStore {
  put(input: { readonly key: string; readonly bytes: Uint8Array }): Promise<void>;
  get(input: { readonly key: string }): Promise<Uint8Array | null>;
  delete(input: { readonly key: string }): Promise<void>;
}

export class ResultReferenceIdempotencyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResultReferenceIdempotencyError";
  }
}

export class InMemoryResultObjectStore implements ResultObjectStore {
  readonly #objects = new Map<string, Uint8Array>();

  public async put(input: { readonly key: string; readonly bytes: Uint8Array }): Promise<void> {
    this.#objects.set(input.key, new Uint8Array(input.bytes));
  }

  public async get(input: { readonly key: string }): Promise<Uint8Array | null> {
    const value = this.#objects.get(input.key);
    return value === undefined ? null : new Uint8Array(value);
  }

  public async delete(input: { readonly key: string }): Promise<void> {
    this.#objects.delete(input.key);
  }

  public has(key: string): boolean {
    return this.#objects.has(key);
  }
}

interface StoredResultReference {
  readonly ref: ResultReference;
  readonly idempotencyKey: string | null;
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function scopedKey(scope: ResultReferenceScope, refId: string): string {
  return `${scope.tenantId}/${scope.sessionId}/${refId}`;
}

function idempotencyKey(scope: ResultReferenceScope, value: string): string {
  return `${scope.tenantId}/${scope.sessionId}/${value}`;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function storageKey(scope: ResultReferenceScope, refId: string, nowMs: number): string {
  const date = new Date(nowMs);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `tenants/${scope.tenantId}/results/${year}/${month}/${scope.sessionId}/${refId}.json.zst`;
}

function boundedPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > RESULT_REFERENCE_MAX_BYTES) {
    throw new Error("result reference page size is outside the bounded range");
  }
  return value;
}

function immutableRef(ref: ResultReference): ResultReference {
  return Object.freeze({
    ...ref,
    summary: Object.freeze({ ...ref.summary }),
  });
}

export interface ResultReferenceStoreOptions {
  readonly objects: ResultObjectStore;
  readonly now?: () => number;
  readonly newRefId?: () => string;
  readonly defaultPageSizeBytes?: number;
  readonly defaultTtlMs?: number;
}

/**
 * Result references intentionally reveal no cross-tenant or cross-session
 * existence information: an incorrect scope always receives `not_found`.
 */
export class ResultReferenceStore {
  readonly #objects: ResultObjectStore;
  readonly #now: () => number;
  readonly #newRefId: () => string;
  readonly #defaultPageSizeBytes: number;
  readonly #defaultTtlMs: number;
  readonly #records = new Map<string, StoredResultReference>();
  readonly #idempotency = new Map<string, StoredResultReference>();

  public constructor(options: ResultReferenceStoreOptions) {
    this.#objects = options.objects;
    this.#now = options.now ?? Date.now;
    this.#newRefId = options.newRefId ?? randomUUID;
    this.#defaultPageSizeBytes = boundedPageSize(options.defaultPageSizeBytes ?? RESULT_REFERENCE_DEFAULT_PAGE_BYTES);
    this.#defaultTtlMs = options.defaultTtlMs ?? RESULT_REFERENCE_DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(this.#defaultTtlMs) || this.#defaultTtlMs < 1) {
      throw new Error("result reference ttl must be a positive integer");
    }
  }

  public async put(input: {
    readonly scope: ResultReferenceScope;
    readonly payload: GatewayJsonValue;
    readonly idempotencyKey?: string;
    readonly expiresAtMs?: number;
    readonly pageSizeBytes?: number;
  }): Promise<ResultReference> {
    if (!validIdentifier(input.scope.tenantId) || !validIdentifier(input.scope.sessionId)) {
      throw new Error("result reference scope is invalid");
    }
    if (input.idempotencyKey !== undefined && !validIdentifier(input.idempotencyKey)) {
      throw new Error("result reference idempotency key is invalid");
    }
    const nowMs = this.#now();
    const expiresAtMs = input.expiresAtMs ?? nowMs + this.#defaultTtlMs;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new Error("result reference expiry must be after creation");
    }
    const pageSizeBytes = boundedPageSize(input.pageSizeBytes ?? this.#defaultPageSizeBytes);
    const bytes = Buffer.from(canonicalizeJson(input.payload as JsonValue), "utf8");
    if (bytes.byteLength > RESULT_REFERENCE_MAX_BYTES) {
      throw new Error("result reference payload exceeds the five MiB limit");
    }
    const digest = sha256(bytes);
    const prior = input.idempotencyKey === undefined
      ? undefined
      : this.#idempotency.get(idempotencyKey(input.scope, input.idempotencyKey));
    if (prior !== undefined) {
      if (prior.ref.digest !== digest || prior.ref.expiresAtMs !== expiresAtMs || prior.ref.pageSizeBytes !== pageSizeBytes) {
        throw new ResultReferenceIdempotencyError("result reference idempotency replay changed immutable payload or lifecycle");
      }
      return prior.ref;
    }
    const refId = this.#newRefId();
    if (!validIdentifier(refId)) throw new Error("generated result reference id is invalid");
    const key = storageKey(input.scope, refId, nowMs);
    const pageCount = Math.max(1, Math.ceil(bytes.byteLength / pageSizeBytes));
    const firstPage = bytes.subarray(0, Math.min(bytes.byteLength, pageSizeBytes));
    const ref = immutableRef({
      refId,
      tenantId: input.scope.tenantId,
      sessionId: input.scope.sessionId,
      storageKey: key,
      digest,
      expiresAtMs,
      pageSizeBytes,
      pageCount,
      summary: Object.freeze({
        byteLength: bytes.byteLength,
        pageCount,
        firstPageBase64: firstPage.toString("base64"),
        truncated: pageCount > 1,
      }),
    });
    await this.#objects.put({ key, bytes: zstdCompressSync(bytes) });
    const stored = Object.freeze({ ref, idempotencyKey: input.idempotencyKey ?? null });
    this.#records.set(scopedKey(input.scope, refId), stored);
    if (input.idempotencyKey !== undefined) this.#idempotency.set(idempotencyKey(input.scope, input.idempotencyKey), stored);
    return ref;
  }

  public async getPage(input: {
    readonly scope: ResultReferenceScope;
    readonly refId: string;
    readonly pageIndex: number;
  }): Promise<ResultReferencePage> {
    if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0) return Object.freeze({ kind: "page_out_of_range" });
    const stored = this.#records.get(scopedKey(input.scope, input.refId));
    if (stored === undefined) return Object.freeze({ kind: "not_found" });
    if (stored.ref.expiresAtMs <= this.#now()) return Object.freeze({ kind: "expired" });
    if (input.pageIndex >= stored.ref.pageCount) return Object.freeze({ kind: "page_out_of_range" });
    const compressed = await this.#objects.get({ key: stored.ref.storageKey });
    if (compressed === null) return Object.freeze({ kind: "not_found" });
    const bytes = zstdDecompressSync(compressed);
    if (sha256(bytes) !== stored.ref.digest) return Object.freeze({ kind: "not_found" });
    const start = input.pageIndex * stored.ref.pageSizeBytes;
    const page = new Uint8Array(bytes.subarray(start, Math.min(bytes.byteLength, start + stored.ref.pageSizeBytes)));
    return Object.freeze({
      kind: "page" as const,
      ref: stored.ref,
      pageIndex: input.pageIndex,
      bytes: page,
      base64: Buffer.from(page).toString("base64"),
    });
  }

  public async expire(input: { readonly nowMs?: number; readonly limit?: number }): Promise<readonly ResultReference[]> {
    const nowMs = input.nowMs ?? this.#now();
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("result expiry limit is outside the bounded range");
    const expired = [...this.#records.entries()]
      .map(([key, stored]) => ({ key, stored }))
      .filter(({ stored }) => stored.ref.expiresAtMs <= nowMs)
      .sort((left, right) => left.stored.ref.expiresAtMs - right.stored.ref.expiresAtMs || left.stored.ref.refId.localeCompare(right.stored.ref.refId))
      .slice(0, limit);
    for (const { key, stored } of expired) {
      await this.#objects.delete({ key: stored.ref.storageKey });
      this.#records.delete(key);
      if (stored.idempotencyKey !== null) this.#idempotency.delete(idempotencyKey({ tenantId: stored.ref.tenantId, sessionId: stored.ref.sessionId }, stored.idempotencyKey));
    }
    return Object.freeze(expired.map(({ stored }) => stored.ref));
  }
}
