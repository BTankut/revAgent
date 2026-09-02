import { createHash, randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";
import pg, { type PoolClient } from "pg";

import type { GatewayJsonValue } from "./dispatch.js";
import type { Eu12EventWriteReceipt } from "./eventPersistence.js";
import { validateEu12EventEnvelope } from "./eventPersistence.js";
import type { GatewayEventEnvelope } from "./events.js";
import { PostgresEu12EventPersistence } from "./postgresEu12EventPersistence.js";
import type { BridgeReleaseChannel, BridgeReleaseContract, ReleaseSignatureVerifier } from "./releaseChannelStore.js";
import {
  RESULT_REFERENCE_DEFAULT_PAGE_BYTES,
  RESULT_REFERENCE_DEFAULT_TTL_MS,
  RESULT_REFERENCE_MAX_BYTES,
  ResultReferenceIdempotencyError,
  type ResultObjectStore,
  type ResultReference,
  type ResultReferencePage,
  type ResultReferenceScope,
  freezeResultReference,
  resultReferenceDigest,
  resultReferenceStorageKey,
  validateResultReferencePageSize,
} from "./resultReferenceStore.js";
import { parseArchivedEventNdjson, type RetentionArchiveRun } from "./retentionArchive.js";

const { Pool } = pg;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

export type RetentionSurface = "events" | "tool_invocations" | "llm_calls";

export class RetentionLeaseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RetentionLeaseError";
  }
}

function archiveKey(tenantId: string, surface: RetentionSurface, month: string): string {
  return `archive/${tenantId}/${surface}/${month}.ndjson.zst`;
}

function archiveDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function monthStart(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) throw new Error("archive month must be YYYY-MM");
  return `${month}-01`;
}

function immutableArchiveRun(run: RetentionArchiveRun): RetentionArchiveRun {
  return Object.freeze({ ...run });
}

export function canonicalDurableReleaseManifest(input: {
  readonly release: BridgeReleaseContract;
  readonly releaseSequence: number;
  readonly releaseRollbackFloorSequence: number;
  readonly channelRollbackFloorSequence: number;
  readonly channelRevision: number;
  readonly tenantIds: readonly string[];
}): string {
  const release = input.release;
  return canonicalizeJson({
    id: release.id,
    version: release.version,
    channel: release.channel,
    artifact_storage_key: release.artifactStorageKey,
    artifact_sha256: release.artifactSha256,
    signing_key_id: release.signingKeyId,
    min_supported_version: release.minSupportedVersion,
    released_at_ms: release.releasedAtMs,
    released_by: release.releasedBy,
    release_sequence: input.releaseSequence,
    release_rollback_floor_sequence: input.releaseRollbackFloorSequence,
    channel_revision: input.channelRevision,
    channel_rollback_floor_sequence: input.channelRollbackFloorSequence,
    staged_tenant_ids: [...input.tenantIds].sort(),
  } as JsonValue);
}

function parseReferenceRow(row: {
  id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
  byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
}): ResultReference {
  const summary = row.summary as { byteLength: number; pageCount: number; firstPageBase64: string; truncated: boolean };
  return freezeResultReference({
    refId: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    storageKey: row.storage_key,
    digest: `sha256:${row.content_digest}`,
    expiresAtMs: row.expires_at.getTime(),
    pageSizeBytes: row.page_size_bytes,
    pageCount: row.page_count,
    summary: Object.freeze({ ...summary }),
  });
}

export interface PostgresEu12DataStoreOptions {
  readonly databaseUrl: string;
  readonly publisherDatabaseUrl: string;
  readonly objects: ResultObjectStore;
  readonly signatureVerifier: ReleaseSignatureVerifier;
  readonly pinnedSigningKeyIds: readonly string[];
  readonly now?: () => number;
  readonly newRefId?: () => string;
}

export interface PersistedParityAttribution {
  readonly activeTaskCount: number;
  readonly toolUserAttribution: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly modelUserAttribution: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/**
 * Authoritative EU-12 persistence adapter. The memory stores remain bounded
 * conformance fixtures; restart-sensitive metadata is read from Postgres.
 */
export class PostgresEu12DataStore {
  readonly #runtimePool: pg.Pool;
  readonly #publisherPool: pg.Pool;
  readonly #events: PostgresEu12EventPersistence;
  readonly #objects: ResultObjectStore;
  readonly #signatureVerifier: ReleaseSignatureVerifier;
  readonly #pinnedSigningKeyIds: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #newRefId: () => string;

  public constructor(options: PostgresEu12DataStoreOptions) {
    if (options.pinnedSigningKeyIds.length === 0) throw new Error("pinned signing key set is required");
    this.#runtimePool = new Pool({ connectionString: options.databaseUrl });
    this.#publisherPool = new Pool({ connectionString: options.publisherDatabaseUrl });
    this.#events = new PostgresEu12EventPersistence(options.databaseUrl);
    this.#objects = options.objects;
    this.#signatureVerifier = options.signatureVerifier;
    this.#pinnedSigningKeyIds = new Set(options.pinnedSigningKeyIds);
    this.#now = options.now ?? Date.now;
    this.#newRefId = options.newRefId ?? randomUUID;
  }

  public async close(): Promise<void> {
    await Promise.all([this.#runtimePool.end(), this.#publisherPool.end(), this.#events.close()]);
  }

  /** The same typed O7 writer used by PostgresTenantStore. */
  public async write(events: readonly GatewayEventEnvelope[]): Promise<readonly Eu12EventWriteReceipt[]> {
    return await this.#events.write(events);
  }

  public async read(scope: { readonly tenantId: string; readonly eventId: string }): Promise<GatewayEventEnvelope | null> {
    return await this.#events.read(scope);
  }

  public async list(scope: { readonly tenantId: string }): Promise<readonly GatewayEventEnvelope[]> {
    return await this.#events.list(scope);
  }

  /** Structural counterpart of ResultReferenceStore.put for real lifecycle composition. */
  public async put(input: {
    readonly scope: ResultReferenceScope;
    readonly payload: GatewayJsonValue;
    readonly idempotencyKey?: string;
    readonly invocationId?: string;
    readonly refLabel?: string;
    readonly expiresAtMs?: number;
    readonly pageSizeBytes?: number;
  }): Promise<ResultReference> {
    if (input.idempotencyKey === undefined || input.invocationId === undefined) {
      throw new Error("durable result composition requires idempotency and invocation identities");
    }
    return await this.putResult({
      scope: input.scope,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      invocationId: input.invocationId,
      refLabel: input.refLabel,
      expiresAtMs: input.expiresAtMs,
      pageSizeBytes: input.pageSizeBytes,
    });
  }

  async #tenantTransaction<T>(tenantId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    assertUuid(tenantId, "tenant id");
    const client = await this.#runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await action(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async putResult(input: {
    readonly scope: ResultReferenceScope;
    readonly payload: GatewayJsonValue;
    readonly idempotencyKey: string;
    readonly invocationId: string;
    readonly refLabel?: string;
    readonly expiresAtMs?: number;
    readonly pageSizeBytes?: number;
  }): Promise<ResultReference> {
    assertUuid(input.scope.tenantId, "tenant id");
    assertUuid(input.scope.sessionId, "session id");
    assertUuid(input.invocationId, "invocation id");
    const nowMs = this.#now();
    const expiresAtMs = input.expiresAtMs ?? nowMs + RESULT_REFERENCE_DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw new Error("result reference expiry must be after creation");
    const pageSizeBytes = validateResultReferencePageSize(input.pageSizeBytes ?? RESULT_REFERENCE_DEFAULT_PAGE_BYTES);
    const bytes = Buffer.from(canonicalizeJson(input.payload as JsonValue), "utf8");
    if (bytes.byteLength > RESULT_REFERENCE_MAX_BYTES) throw new Error("result reference payload exceeds the five MiB limit");
    const digest = resultReferenceDigest(bytes);
    const existing = await this.#tenantTransaction(input.scope.tenantId, async (client) => {
      const row = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `SELECT id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                byte_size,page_size_bytes,page_count,summary,expires_at
         FROM result_refs WHERE tenant_id=$1 AND session_id=$2 AND idempotency_key=$3`,
        [input.scope.tenantId, input.scope.sessionId, input.idempotencyKey],
      );
      return row.rows[0] === undefined ? null : parseReferenceRow(row.rows[0]);
    });
    if (existing !== null) {
      if (existing.digest !== digest || existing.expiresAtMs !== expiresAtMs || existing.pageSizeBytes !== pageSizeBytes) {
        throw new ResultReferenceIdempotencyError("result reference idempotency replay changed immutable payload or lifecycle");
      }
      return existing;
    }
    const refId = this.#newRefId();
    assertUuid(refId, "result reference id");
    const refLabel = input.refLabel ?? await this.#tenantTransaction(input.scope.tenantId, async (client) => {
      const labels = await client.query<{ ref_label: string }>(
        "SELECT ref_label FROM result_refs WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE",
        [input.scope.tenantId, input.scope.sessionId],
      );
      const maximum = labels.rows.reduce((current, row) => Math.max(current, Number.parseInt(row.ref_label.slice(1), 10) || 16), 16);
      return `R${String(maximum + 1)}`;
    });
    if (!/^R[1-9][0-9]{0,5}$/u.test(refLabel)) throw new Error("result reference label must be R17-style");
    const key = resultReferenceStorageKey(input.scope, refId, nowMs);
    const pageCount = Math.max(1, Math.ceil(bytes.byteLength / pageSizeBytes));
    const firstPage = bytes.subarray(0, Math.min(bytes.byteLength, pageSizeBytes));
    const ref = freezeResultReference({
      refId,
      tenantId: input.scope.tenantId,
      sessionId: input.scope.sessionId,
      storageKey: key,
      digest,
      expiresAtMs,
      pageSizeBytes,
      pageCount,
      summary: Object.freeze({ byteLength: bytes.byteLength, pageCount, firstPageBase64: firstPage.toString("base64"), truncated: pageCount > 1 }),
    });
    await this.#objects.put({ key, bytes: zstdCompressSync(bytes) });
    return await this.#tenantTransaction(input.scope.tenantId, async (client) => {
      const inserted = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `INSERT INTO result_refs(
           id,tenant_id,session_id,invocation_id,ref_label,content_type,storage_key,content_digest,
           byte_size,page_size_bytes,page_count,summary,idempotency_key,expires_at)
         VALUES($1,$2,$3,$4,$5,'application/json',$6,$7,$8,$9,$10,$11::jsonb,$12,to_timestamp($13/1000.0))
         ON CONFLICT (tenant_id,session_id,idempotency_key) DO NOTHING
         RETURNING id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                   byte_size,page_size_bytes,page_count,summary,expires_at`,
        [ref.refId, ref.tenantId, ref.sessionId, input.invocationId, refLabel, ref.storageKey,
          ref.digest.slice("sha256:".length), ref.summary.byteLength, ref.pageSizeBytes,
          ref.pageCount, JSON.stringify(ref.summary), input.idempotencyKey, ref.expiresAtMs],
      );
      if (inserted.rows[0] !== undefined) return parseReferenceRow(inserted.rows[0]);
      const raced = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `SELECT id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                byte_size,page_size_bytes,page_count,summary,expires_at
         FROM result_refs WHERE tenant_id=$1 AND session_id=$2 AND idempotency_key=$3`,
        [input.scope.tenantId, input.scope.sessionId, input.idempotencyKey],
      );
      const prior = raced.rows[0];
      if (prior === undefined) throw new Error("result reference insert race lost durable row");
      const durable = parseReferenceRow(prior);
      if (durable.digest !== digest || durable.expiresAtMs !== expiresAtMs || durable.pageSizeBytes !== pageSizeBytes) throw new ResultReferenceIdempotencyError("result reference idempotency replay changed immutable payload or lifecycle");
      return durable;
    });
  }

  public async getResultPage(input: { readonly scope: ResultReferenceScope; readonly refId: string; readonly pageIndex: number }): Promise<ResultReferencePage> {
    if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0) return Object.freeze({ kind: "page_out_of_range" });
    assertUuid(input.scope.tenantId, "tenant id"); assertUuid(input.scope.sessionId, "session id"); assertUuid(input.refId, "result reference id");
    const ref = await this.#tenantTransaction(input.scope.tenantId, async (client) => {
      const row = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `SELECT id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                byte_size,page_size_bytes,page_count,summary,expires_at
         FROM result_refs WHERE tenant_id=$1 AND session_id=$2 AND id=$3 AND lifecycle='active'`,
        [input.scope.tenantId, input.scope.sessionId, input.refId],
      );
      return row.rows[0] === undefined ? null : parseReferenceRow(row.rows[0]);
    });
    if (ref === null) return Object.freeze({ kind: "not_found" });
    if (ref.expiresAtMs <= this.#now()) return Object.freeze({ kind: "expired" });
    if (input.pageIndex >= ref.pageCount) return Object.freeze({ kind: "page_out_of_range" });
    const compressed = await this.#objects.get({ key: ref.storageKey });
    if (compressed === null) return Object.freeze({ kind: "not_found" });
    const bytes = zstdDecompressSync(compressed);
    if (resultReferenceDigest(bytes) !== ref.digest) return Object.freeze({ kind: "not_found" });
    const start = input.pageIndex * ref.pageSizeBytes;
    const page = new Uint8Array(bytes.subarray(start, Math.min(bytes.byteLength, start + ref.pageSizeBytes)));
    return Object.freeze({ kind: "page", ref, pageIndex: input.pageIndex, bytes: page, base64: Buffer.from(page).toString("base64") });
  }

  public async expireResults(input: { readonly tenantId: string; readonly nowMs?: number; readonly limit?: number }): Promise<readonly ResultReference[]> {
    const nowMs = input.nowMs ?? this.#now();
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("result expiry limit is outside the bounded range");
    const candidates = await this.#tenantTransaction(input.tenantId, async (client) => {
      const rows = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `SELECT id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                byte_size,page_size_bytes,page_count,summary,expires_at
         FROM result_refs
         WHERE tenant_id=$1 AND expires_at <= to_timestamp($2/1000.0) AND lifecycle IN ('active','deleting')
         ORDER BY expires_at,id LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [input.tenantId, nowMs, limit],
      );
      await client.query(
        `UPDATE result_refs SET lifecycle='deleting'
         WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
        [input.tenantId, rows.rows.map((row) => row.id)],
      );
      return rows.rows.map(parseReferenceRow);
    });
    for (const ref of candidates) await this.#objects.delete({ key: ref.storageKey });
    await this.#tenantTransaction(input.tenantId, async (client) => {
      await client.query(
        `DELETE FROM result_refs WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND lifecycle='deleting'`,
        [input.tenantId, candidates.map((ref) => ref.refId)],
      );
    });
    return Object.freeze(candidates);
  }

  public async archiveEvents(input: { readonly tenantId: string; readonly month: string; readonly owner: string; readonly afterObjectWrite?: (run: RetentionArchiveRun) => Promise<void> | void }): Promise<RetentionArchiveRun> {
    // Preserve FK integrity: typed child surfaces are write-before-drop
    // archived first, then their envelope rows can be removed safely.
    await this.archiveSurface({ tenantId: input.tenantId, month: input.month, owner: input.owner, surface: "tool_invocations" });
    await this.archiveSurface({ tenantId: input.tenantId, month: input.month, owner: input.owner, surface: "llm_calls" });
    return await this.archiveSurface({ ...input, surface: "events" });
  }

  /** Archive each governed typed table using a durable tenant/month/surface lease. */
  public async archiveSurface(input: {
    readonly tenantId: string;
    readonly month: string;
    readonly surface: RetentionSurface;
    readonly owner: string;
    readonly afterObjectWrite?: (run: RetentionArchiveRun) => Promise<void> | void;
  }): Promise<RetentionArchiveRun> {
    const archiveMonth = monthStart(input.month);
    const prepared = await this.#tenantTransaction(input.tenantId, async (client) => {
      const priorResult = await client.query<{
        state: RetentionArchiveRun["state"]; archive_key: string; archive_digest: string; event_count: number;
        attempts: number; lease_owner: string | null; lease_expires_at: Date | null; lease_epoch: number;
      }>(
        `SELECT state,archive_key,archive_digest::text,event_count,attempts,lease_owner,lease_expires_at,lease_epoch
         FROM retention_runs WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind=$3 FOR UPDATE`,
        [input.tenantId, archiveMonth, input.surface],
      );
      const prior = priorResult.rows[0];
      if (prior?.state === "dropped") {
        return Object.freeze({
          run: immutableArchiveRun({ tenantId: input.tenantId, month: input.month, state: "dropped", archiveKey: prior.archive_key, archiveDigest: `sha256:${prior.archive_digest}`, eventCount: prior.event_count, attempts: prior.attempts }),
          raw: Buffer.alloc(0), ids: Object.freeze([]) as readonly string[], epoch: prior.lease_epoch, alreadyDropped: true,
        });
      }
      const nowMs = this.#now();
      if (prior !== undefined && prior.lease_owner !== null && prior.lease_owner !== input.owner && (prior.lease_expires_at?.getTime() ?? 0) > nowMs) {
        throw new RetentionLeaseError("retention partition lease is held by another owner");
      }
      const rows = await this.#readArchiveRows(client, input.tenantId, archiveMonth, input.surface);
      const raw = Buffer.from(rows.values.map((value) => canonicalizeJson(value as JsonValue)).join(rows.values.length === 0 ? "" : "\n") + (rows.values.length === 0 ? "" : "\n"), "utf8");
      const digest = archiveDigest(raw);
      const key = prior?.archive_key ?? archiveKey(input.tenantId, input.surface, input.month);
      const attempts = (prior?.attempts ?? 0) + 1;
      const epoch = (prior?.lease_epoch ?? 0) + 1;
      await client.query(
        `INSERT INTO retention_runs(tenant_id,archive_month,archive_kind,state,archive_key,archive_digest,row_digest,event_count,attempts,lease_owner,lease_expires_at,lease_epoch)
         VALUES($1,$2::date,$3,'prepared',$4,$5,$5,$6,$7,$8,to_timestamp($9/1000.0),$10)
         ON CONFLICT (tenant_id,archive_month,archive_kind) DO UPDATE SET
           state='prepared',archive_key=EXCLUDED.archive_key,archive_digest=EXCLUDED.archive_digest,row_digest=EXCLUDED.row_digest,
           event_count=EXCLUDED.event_count,attempts=EXCLUDED.attempts,lease_owner=EXCLUDED.lease_owner,
           lease_expires_at=EXCLUDED.lease_expires_at,lease_epoch=EXCLUDED.lease_epoch,updated_at=clock_timestamp()`,
        [input.tenantId, archiveMonth, input.surface, key, digest, rows.ids.length, attempts, input.owner, nowMs + 300_000, epoch],
      );
      return Object.freeze({
        run: immutableArchiveRun({ tenantId: input.tenantId, month: input.month, state: "prepared", archiveKey: key, archiveDigest: `sha256:${digest}`, eventCount: rows.ids.length, attempts }),
        raw, ids: rows.ids, epoch, alreadyDropped: false,
      });
    });
    if (prepared.alreadyDropped) return prepared.run;
    await this.#objects.put({ key: prepared.run.archiveKey, bytes: zstdCompressSync(prepared.raw) });
    await input.afterObjectWrite?.(prepared.run);
    await this.#tenantTransaction(input.tenantId, async (client) => {
      const uploaded = await client.query(
        `UPDATE retention_runs SET state='uploaded',lease_expires_at=to_timestamp($6/1000.0),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind=$3 AND state='prepared'
           AND lease_owner=$4 AND lease_epoch=$5 AND lease_expires_at > clock_timestamp()`,
        [input.tenantId, archiveMonth, input.surface, input.owner, prepared.epoch, this.#now() + 300_000],
      );
      if (uploaded.rowCount !== 1) throw new RetentionLeaseError("retention lease was lost before durable archive commit");
      await this.#dropArchiveRows(client, input.tenantId, archiveMonth, input.surface, prepared.ids);
      const remaining = await this.#countArchiveRows(client, input.tenantId, archiveMonth, input.surface);
      if (remaining !== 0) throw new Error("retention archive drop did not clear its typed partition basis");
      const dropped = await client.query(
        `UPDATE retention_runs SET state='dropped',dropped_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind=$3 AND state='uploaded'
           AND lease_owner=$4 AND lease_epoch=$5`,
        [input.tenantId, archiveMonth, input.surface, input.owner, prepared.epoch],
      );
      if (dropped.rowCount !== 1) throw new RetentionLeaseError("retention lease was lost before partition drop completion");
    });
    return immutableArchiveRun({ ...prepared.run, state: "dropped" });
  }

  async #readArchiveRows(client: PoolClient, tenantId: string, archiveMonth: string, surface: RetentionSurface): Promise<Readonly<{ readonly ids: readonly string[]; readonly values: readonly GatewayJsonValue[] }>> {
    if (surface === "events") {
      const result = await client.query<{
        id: string; event_type: GatewayEventEnvelope["event_type"]; occurred_at: Date; recorded_at: Date;
        source: unknown; actor: unknown; session_id: string | null; turn_id: string | null; sequence: number | string; payload: unknown;
      }>(
        `SELECT id::text,event_type,occurred_at,recorded_at,source,actor,session_id::text,turn_id::text,sequence,payload
         FROM events WHERE tenant_id=$1 AND retention_partition_month=$2::date ORDER BY occurred_at,id`, [tenantId, archiveMonth],
      );
      const values = result.rows.map((row) => validateEu12EventEnvelope({
        schema: "revagent.event.v2", event_id: row.id, event_type: row.event_type,
        occurred_at: row.occurred_at.toISOString(), recorded_at: row.recorded_at.toISOString(), tenant_id: tenantId,
        source: row.source, actor: row.actor, ...(row.session_id === null ? {} : { session_id: row.session_id }),
        ...(row.turn_id === null ? {} : { turn_id: row.turn_id }), seq: Number(row.sequence), payload: row.payload,
      }) as unknown as GatewayJsonValue);
      return Object.freeze({ ids: Object.freeze(result.rows.map((row) => row.id)), values: Object.freeze(values) });
    }
    const table = surface === "tool_invocations" ? "tool_invocations" : "llm_calls";
    const timeColumn = surface === "tool_invocations" ? "started_at" : "created_at";
    const result = await client.query<{ id: string; record: GatewayJsonValue }>(
      `SELECT id::text,row_to_json(source)::jsonb AS record FROM ${table} AS source
       WHERE tenant_id=$1 AND retention_partition_month=$2::date ORDER BY ${timeColumn},id`, [tenantId, archiveMonth],
    );
    return Object.freeze({ ids: Object.freeze(result.rows.map((row) => row.id)), values: Object.freeze(result.rows.map((row) => row.record)) });
  }

  async #dropArchiveRows(client: PoolClient, tenantId: string, archiveMonth: string, surface: RetentionSurface, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const table = surface === "events" ? "events" : surface;
    await client.query(
      `DELETE FROM ${table} WHERE tenant_id=$1 AND retention_partition_month=$2::date AND id = ANY($3::uuid[])`,
      [tenantId, archiveMonth, ids],
    );
  }

  async #countArchiveRows(client: PoolClient, tenantId: string, archiveMonth: string, surface: RetentionSurface): Promise<number> {
    const table = surface === "events" ? "events" : surface;
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1 AND retention_partition_month=$2::date`,
      [tenantId, archiveMonth],
    );
    return result.rows[0]?.count ?? 0;
  }

  public async publishRelease(input: { readonly release: BridgeReleaseContract; readonly releaseSequence: number; readonly rollbackFloorSequence?: number; readonly tenantIds: readonly string[] }): Promise<void> {
    const release = input.release;
    assertUuid(release.id, "release id");
    if (!Number.isSafeInteger(input.releaseSequence) || input.releaseSequence < 1 || !Number.isSafeInteger(input.rollbackFloorSequence ?? 0) || (input.rollbackFloorSequence ?? 0) < 0 || (input.rollbackFloorSequence ?? 0) > input.releaseSequence) throw new Error("release sequence authority is invalid");
    if (!this.#pinnedSigningKeyIds.has(release.signingKeyId)) throw new Error("bridge release signing key is not pinned");
    const artifact = await this.#objects.get({ key: release.artifactStorageKey });
    if (artifact === null || resultReferenceDigest(artifact) !== release.artifactSha256) throw new Error("bridge release artifact digest does not match stored artifact");
    const client = await this.#publisherPool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query<{ channel_revision: number; rollback_floor_sequence: string | number }>(
        "SELECT channel_revision,rollback_floor_sequence FROM release_channels WHERE channel=$1 FOR UPDATE", [release.channel],
      );
      const channelRevision = (prior.rows[0]?.channel_revision ?? 0) + 1;
      const channelRollbackFloorSequence = Math.max(Number(prior.rows[0]?.rollback_floor_sequence ?? 0), input.rollbackFloorSequence ?? 0);
      const manifest = canonicalDurableReleaseManifest({ release, releaseSequence: input.releaseSequence, releaseRollbackFloorSequence: input.rollbackFloorSequence ?? 0, channelRollbackFloorSequence, channelRevision, tenantIds: input.tenantIds });
      if (!this.#signatureVerifier.verify({ signingKeyId: release.signingKeyId, canonicalManifest: manifest, signature: release.signature })) throw new Error("bridge release manifest signature is invalid");
      await client.query(
        `INSERT INTO bridge_releases(id,version,channel,artifact_storage_key,artifact_sha256,signature,signing_key_id,min_supported_version,released_at,released_by,release_sequence,manifest_digest,rollback_floor_sequence)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),$10,$11,$5,$12)
         ON CONFLICT (id) DO NOTHING`,
        [release.id, release.version, release.channel, release.artifactStorageKey, release.artifactSha256.slice("sha256:".length), release.signature, release.signingKeyId, release.minSupportedVersion, release.releasedAtMs, release.releasedBy, input.releaseSequence, input.rollbackFloorSequence ?? 0],
      );
      await client.query(
        `INSERT INTO release_channels(channel,current_release_id,staged_rollout,channel_revision,rollback_floor_sequence)
         VALUES($1,$2,$3::jsonb,$4,$5)
         ON CONFLICT (channel) DO UPDATE SET current_release_id=EXCLUDED.current_release_id,staged_rollout=EXCLUDED.staged_rollout,
           channel_revision=EXCLUDED.channel_revision,rollback_floor_sequence=EXCLUDED.rollback_floor_sequence`,
        [release.channel, release.id, JSON.stringify({ tenantIds: input.tenantIds, revision: channelRevision }), channelRevision, input.rollbackFloorSequence ?? 0],
      );
      await client.query("DELETE FROM release_channel_targets WHERE channel=$1", [release.channel]);
      for (const tenantId of input.tenantIds) {
        assertUuid(tenantId, "release target tenant id");
        await client.query("INSERT INTO release_channel_targets(channel,tenant_id,rollout_revision) VALUES($1,$2,1)", [release.channel, tenantId]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  }

  public async readReleaseForTenant(input: { readonly tenantId: string; readonly channel: BridgeReleaseChannel }): Promise<BridgeReleaseContract | null> {
    return await this.#tenantTransaction(input.tenantId, async (client) => {
      const row = await client.query<{
        id: string; version: string; channel: BridgeReleaseChannel; artifact_storage_key: string; artifact_sha256: string;
        signature: string; signing_key_id: string; min_supported_version: string; released_at: Date; released_by: string;
      }>(
        `SELECT release.id::text,release.version,release.channel,release.artifact_storage_key,release.artifact_sha256::text,
                release.signature,release.signing_key_id,release.min_supported_version,release.released_at,release.released_by
         FROM release_channel_targets target
         JOIN release_channels channel ON channel.channel=target.channel
         JOIN bridge_releases release ON release.id=channel.current_release_id
         WHERE target.tenant_id=$1 AND target.channel=$2`,
        [input.tenantId, input.channel],
      );
      const release = row.rows[0];
      return release === undefined ? null : Object.freeze({
        id: release.id, version: release.version, channel: release.channel,
        artifactStorageKey: release.artifact_storage_key, artifactSha256: `sha256:${release.artifact_sha256}`,
        signature: release.signature, signingKeyId: release.signing_key_id,
        minSupportedVersion: release.min_supported_version, releasedAtMs: release.released_at.getTime(), releasedBy: release.released_by,
      });
    });
  }

  public async readArchivedEvents(input: { readonly tenantId: string; readonly month: string }): Promise<readonly GatewayEventEnvelope[]> {
    const compressed = await this.#objects.get({ key: archiveKey(input.tenantId, "events", input.month) });
    return compressed === null ? Object.freeze([]) : parseArchivedEventNdjson(compressed);
  }

  public async readTypedArchive(input: { readonly tenantId: string; readonly month: string; readonly surface: RetentionSurface }): Promise<readonly GatewayJsonValue[]> {
    const compressed = await this.#objects.get({ key: archiveKey(input.tenantId, input.surface, input.month) });
    if (compressed === null) return Object.freeze([]);
    const ndjson = zstdDecompressSync(compressed).toString("utf8");
    return Object.freeze(ndjson.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as GatewayJsonValue));
  }

  /** Actual attribution from persisted typed rows, not inferred placeholder values. */
  public async readPersistedParityAttribution(tenantId: string): Promise<PersistedParityAttribution> {
    return await this.#tenantTransaction(tenantId, async (client) => {
      const active = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM tool_invocations WHERE tenant_id=$1 AND finished_at IS NULL", [tenantId],
      );
      const tools = await client.query<{ tool_name: string; user_id: string; count: number }>(
        `SELECT tool_name,actor_user_id::text AS user_id,count(*)::int AS count
         FROM tool_invocations WHERE tenant_id=$1 GROUP BY tool_name,actor_user_id ORDER BY tool_name,user_id`, [tenantId],
      );
      const models = await client.query<{ model: string; user_id: string; count: number }>(
        `SELECT llm.model,session.user_id::text AS user_id,count(*)::int AS count
         FROM llm_calls llm JOIN sessions session ON session.tenant_id=llm.tenant_id AND session.id=llm.session_id
         WHERE llm.tenant_id=$1 GROUP BY llm.model,session.user_id ORDER BY llm.model,user_id`, [tenantId],
      );
      const collect = <T extends { readonly count: number }>(rows: readonly T[], group: (row: T) => string, user: (row: T) => string): Record<string, Record<string, number>> => {
        const result: Record<string, Record<string, number>> = {};
        for (const row of rows) {
          const groupName = group(row);
          const users = result[groupName] ?? {};
          users[user(row)] = row.count;
          result[groupName] = users;
        }
        return result;
      };
      return Object.freeze({
        activeTaskCount: active.rows[0]?.count ?? 0,
        toolUserAttribution: Object.freeze(collect(tools.rows, (row) => row.tool_name, (row) => row.user_id)),
        modelUserAttribution: Object.freeze(collect(models.rows, (row) => row.model, (row) => row.user_id)),
      });
    });
  }
}
