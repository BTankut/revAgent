import { createHash, randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";
import pg, { type PoolClient } from "pg";

import type { GatewayJsonValue } from "./dispatch.js";
import { validateEu12EventEnvelope } from "./eventPersistence.js";
import type { GatewayEventEnvelope } from "./events.js";
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

function archiveKey(tenantId: string, month: string): string {
  return `archive/${tenantId}/events/${month}.ndjson.zst`;
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

/**
 * Authoritative EU-12 persistence adapter. The memory stores remain bounded
 * conformance fixtures; restart-sensitive metadata is read from Postgres.
 */
export class PostgresEu12DataStore {
  readonly #runtimePool: pg.Pool;
  readonly #publisherPool: pg.Pool;
  readonly #objects: ResultObjectStore;
  readonly #signatureVerifier: ReleaseSignatureVerifier;
  readonly #pinnedSigningKeyIds: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #newRefId: () => string;

  public constructor(options: PostgresEu12DataStoreOptions) {
    if (options.pinnedSigningKeyIds.length === 0) throw new Error("pinned signing key set is required");
    this.#runtimePool = new Pool({ connectionString: options.databaseUrl });
    this.#publisherPool = new Pool({ connectionString: options.publisherDatabaseUrl });
    this.#objects = options.objects;
    this.#signatureVerifier = options.signatureVerifier;
    this.#pinnedSigningKeyIds = new Set(options.pinnedSigningKeyIds);
    this.#now = options.now ?? Date.now;
    this.#newRefId = options.newRefId ?? randomUUID;
  }

  public async close(): Promise<void> {
    await Promise.all([this.#runtimePool.end(), this.#publisherPool.end()]);
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
    const refLabel = input.refLabel ?? "R17";
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
    const archiveMonth = monthStart(input.month);
    const existing = await this.#tenantTransaction(input.tenantId, async (client) => {
      const run = await client.query<{ state: RetentionArchiveRun["state"]; archive_key: string; archive_digest: string; event_count: number; attempts: number }>(
        `SELECT state,archive_key,archive_digest::text,event_count,attempts FROM retention_runs
         WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind='events' FOR UPDATE`,
        [input.tenantId, archiveMonth],
      );
      const prior = run.rows[0];
      if (prior?.state === "dropped") {
        return Object.freeze({
          run: immutableArchiveRun({ tenantId: input.tenantId, month: input.month, state: "dropped", archiveKey: prior.archive_key, archiveDigest: `sha256:${prior.archive_digest}`, eventCount: prior.event_count, attempts: prior.attempts }),
          events: Object.freeze([]) as readonly GatewayEventEnvelope[],
          raw: Buffer.alloc(0),
          alreadyDropped: true,
        });
      }
      const rows = await client.query<{
        id: string; event_type: GatewayEventEnvelope["event_type"]; occurred_at: Date; recorded_at: Date;
        source: unknown; actor: unknown; session_id: string | null; turn_id: string | null; sequence: number; payload: unknown;
      }>(
        `SELECT id::text,event_type,occurred_at,recorded_at,source,actor,session_id::text,turn_id::text,sequence,payload
         FROM events WHERE tenant_id=$1 AND retention_partition_month=$2::date ORDER BY occurred_at,id`,
        [input.tenantId, archiveMonth],
      );
      const events = rows.rows.map((row) => validateEu12EventEnvelope({
        schema: "revagent.event.v2", event_id: row.id, event_type: row.event_type,
        occurred_at: row.occurred_at.toISOString(), recorded_at: row.recorded_at.toISOString(),
        tenant_id: input.tenantId, source: row.source, actor: row.actor,
        ...(row.session_id === null ? {} : { session_id: row.session_id }),
        ...(row.turn_id === null ? {} : { turn_id: row.turn_id }), seq: Number(row.sequence), payload: row.payload,
      }));
      const raw = Buffer.from(events.map((event) => canonicalizeJson(event as unknown as JsonValue)).join(events.length === 0 ? "" : "\n") + (events.length === 0 ? "" : "\n"), "utf8");
      const key = prior?.archive_key ?? archiveKey(input.tenantId, input.month);
      const digest = archiveDigest(raw);
      const next = immutableArchiveRun({ tenantId: input.tenantId, month: input.month, state: prior?.state ?? "prepared", archiveKey: key, archiveDigest: `sha256:${digest}`, eventCount: events.length, attempts: (prior?.attempts ?? 0) + 1 });
      await client.query(
        `INSERT INTO retention_runs(tenant_id,archive_month,archive_kind,state,archive_key,archive_digest,row_digest,event_count,attempts,lease_owner,lease_expires_at)
         VALUES($1,$2::date,'events','prepared',$3,$4,$4,$5,$6,$7,clock_timestamp()+interval '5 minutes')
         ON CONFLICT (tenant_id,archive_month,archive_kind) DO UPDATE SET
           state='prepared',archive_key=EXCLUDED.archive_key,archive_digest=EXCLUDED.archive_digest,row_digest=EXCLUDED.row_digest,
           event_count=EXCLUDED.event_count,attempts=EXCLUDED.attempts,lease_owner=EXCLUDED.lease_owner,
           lease_expires_at=EXCLUDED.lease_expires_at,updated_at=clock_timestamp()`,
        [input.tenantId, archiveMonth, key, digest, events.length, next.attempts, input.owner],
      );
      return Object.freeze({ run: next, events, raw, alreadyDropped: false });
    });
    if (existing.alreadyDropped) return existing.run;
    await this.#objects.put({ key: existing.run.archiveKey, bytes: zstdCompressSync(existing.raw) });
    await input.afterObjectWrite?.(existing.run);
    await this.#tenantTransaction(input.tenantId, async (client) => {
      await client.query(
        `UPDATE retention_runs SET state='uploaded',updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind='events' AND state='prepared'`,
        [input.tenantId, archiveMonth],
      );
      await client.query(
        `DELETE FROM events WHERE tenant_id=$1 AND retention_partition_month=$2::date AND id = ANY($3::uuid[])`,
        [input.tenantId, archiveMonth, existing.events.map((event) => event.event_id)],
      );
      const remaining = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM events WHERE tenant_id=$1 AND retention_partition_month=$2::date`,
        [input.tenantId, archiveMonth],
      );
      if ((remaining.rows[0]?.count ?? 0) !== 0) throw new Error("retention archive drop did not clear its durable partition basis");
      await client.query(
        `UPDATE retention_runs SET state='dropped',dropped_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind='events'`,
        [input.tenantId, archiveMonth],
      );
    });
    return immutableArchiveRun({ ...existing.run, state: "dropped" });
  }

  public async publishRelease(input: { readonly release: BridgeReleaseContract; readonly releaseSequence: number; readonly tenantIds: readonly string[] }): Promise<void> {
    const release = input.release;
    assertUuid(release.id, "release id");
    if (!Number.isSafeInteger(input.releaseSequence) || input.releaseSequence < 1) throw new Error("release sequence is invalid");
    if (!this.#pinnedSigningKeyIds.has(release.signingKeyId)) throw new Error("bridge release signing key is not pinned");
    const artifact = await this.#objects.get({ key: release.artifactStorageKey });
    if (artifact === null || resultReferenceDigest(artifact) !== release.artifactSha256) throw new Error("bridge release artifact digest does not match stored artifact");
    const manifest = canonicalizeJson({ id: release.id, version: release.version, channel: release.channel, artifact_storage_key: release.artifactStorageKey, artifact_sha256: release.artifactSha256, signing_key_id: release.signingKeyId, min_supported_version: release.minSupportedVersion, released_at_ms: release.releasedAtMs, released_by: release.releasedBy } as JsonValue);
    if (!this.#signatureVerifier.verify({ signingKeyId: release.signingKeyId, canonicalManifest: manifest, signature: release.signature })) throw new Error("bridge release manifest signature is invalid");
    const client = await this.#publisherPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO bridge_releases(id,version,channel,artifact_storage_key,artifact_sha256,signature,signing_key_id,min_supported_version,released_at,released_by,release_sequence,manifest_digest)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),$10,$11,$5)
         ON CONFLICT (id) DO NOTHING`,
        [release.id, release.version, release.channel, release.artifactStorageKey, release.artifactSha256.slice("sha256:".length), release.signature, release.signingKeyId, release.minSupportedVersion, release.releasedAtMs, release.releasedBy, input.releaseSequence],
      );
      await client.query(
        `INSERT INTO release_channels(channel,current_release_id,staged_rollout)
         VALUES($1,$2,$3::jsonb)
         ON CONFLICT (channel) DO UPDATE SET current_release_id=EXCLUDED.current_release_id,staged_rollout=EXCLUDED.staged_rollout`,
        [release.channel, release.id, JSON.stringify({ tenantIds: input.tenantIds, revision: 1 })],
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
    const compressed = await this.#objects.get({ key: archiveKey(input.tenantId, input.month) });
    return compressed === null ? Object.freeze([]) : parseArchivedEventNdjson(compressed);
  }
}
