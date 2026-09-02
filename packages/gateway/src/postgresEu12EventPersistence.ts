import pg, { type PoolClient } from "pg";

import type { GatewayJsonObject } from "./dispatch.js";
import {
  eventEnvelopeDigest,
  eventIdempotencyDigest,
  routeEu12Event,
  validateEu12EventEnvelope,
  type Eu12EventPersistence,
  type Eu12EventWriteReceipt,
} from "./eventPersistence.js";
import type { GatewayEventEnvelope } from "./events.js";

const { Pool } = pg;

/**
 * The sole PostgreSQL authority for O7 envelope routing. Both tenant-facing
 * events and the durable EU-12 invocation composition use this adapter.
 */
export class PostgresEu12EventPersistence implements Eu12EventPersistence {
  public readonly kind = "postgres" as const;
  readonly #pool: pg.Pool;

  public constructor(databaseUrl: string) {
    this.#pool = new Pool({ connectionString: databaseUrl });
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  async #tenantTransaction<T>(tenantId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
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

  public async write(events: readonly GatewayEventEnvelope[]): Promise<readonly Eu12EventWriteReceipt[]> {
    const receipts: Eu12EventWriteReceipt[] = [];
    for (const raw of events) {
      const event = validateEu12EventEnvelope(raw);
      const receipt = await this.#tenantTransaction(event.tenant_id, async (client) => {
        const inserted = await this.#writeEnvelope(client, event);
        if (inserted) {
          if (routeEu12Event(event) === "tool_invocations") await this.#writeToolInvocation(client, event);
          if (routeEu12Event(event) === "llm_calls") await this.#writeMeteringRecord(client, event);
        }
        return Object.freeze({
          eventId: event.event_id,
          tenantId: event.tenant_id,
          route: routeEu12Event(event),
          digest: eventEnvelopeDigest(event),
          disposition: inserted ? "inserted" as const : "duplicate" as const,
        });
      });
      receipts.push(receipt);
    }
    return Object.freeze(receipts);
  }

  public async read(scope: { readonly tenantId: string; readonly eventId: string }): Promise<GatewayEventEnvelope | null> {
    return await this.#tenantTransaction(scope.tenantId, async (client) => {
      const result = await client.query<{
        id: string; event_type: GatewayEventEnvelope["event_type"]; occurred_at: Date; recorded_at: Date;
        source: unknown; actor: unknown; session_id: string | null; turn_id: string | null; sequence: number | string; payload: unknown;
      }>(
        `SELECT event.id::text,event.event_type,event.occurred_at,event.recorded_at,event.source,event.actor,event.session_id::text,event.turn_id::text,event.sequence,event.payload
         FROM events AS event
         JOIN retention_hot_rows AS hot ON hot.tenant_id=event.tenant_id AND hot.archive_kind='events' AND hot.row_id=event.id
         WHERE event.tenant_id=$1 AND event.id=$2`,
        [scope.tenantId, scope.eventId],
      );
      const row = result.rows[0];
      return row === undefined ? null : validateEu12EventEnvelope({
        schema: "revagent.event.v2", event_id: row.id, event_type: row.event_type,
        occurred_at: row.occurred_at.toISOString(), recorded_at: row.recorded_at.toISOString(),
        tenant_id: scope.tenantId, source: row.source, actor: row.actor,
        ...(row.session_id === null ? {} : { session_id: row.session_id }),
        ...(row.turn_id === null ? {} : { turn_id: row.turn_id }),
        seq: Number(row.sequence), payload: row.payload,
      });
    });
  }

  public async list(scope: { readonly tenantId: string }): Promise<readonly GatewayEventEnvelope[]> {
    return await this.#tenantTransaction(scope.tenantId, async (client) => {
      const result = await client.query<{
        id: string; event_type: GatewayEventEnvelope["event_type"]; occurred_at: Date; recorded_at: Date;
        source: unknown; actor: unknown; session_id: string | null; turn_id: string | null; sequence: number | string; payload: unknown;
      }>(
        `SELECT event.id::text,event.event_type,event.occurred_at,event.recorded_at,event.source,event.actor,event.session_id::text,event.turn_id::text,event.sequence,event.payload
         FROM events AS event
         JOIN retention_hot_rows AS hot ON hot.tenant_id=event.tenant_id AND hot.archive_kind='events' AND hot.row_id=event.id
         WHERE event.tenant_id=$1 ORDER BY event.occurred_at,event.id`,
        [scope.tenantId],
      );
      return Object.freeze(result.rows.map((row) => validateEu12EventEnvelope({
        schema: "revagent.event.v2", event_id: row.id, event_type: row.event_type,
        occurred_at: row.occurred_at.toISOString(), recorded_at: row.recorded_at.toISOString(),
        tenant_id: scope.tenantId, source: row.source, actor: row.actor,
        ...(row.session_id === null ? {} : { session_id: row.session_id }),
        ...(row.turn_id === null ? {} : { turn_id: row.turn_id }),
        seq: Number(row.sequence), payload: row.payload,
      })));
    });
  }

  async #writeEnvelope(client: PoolClient, event: GatewayEventEnvelope): Promise<boolean> {
    const envelopeDigest = eventEnvelopeDigest(event).slice("sha256:".length);
    const idempotencyDigest = eventIdempotencyDigest(event).slice("sha256:".length);
    const payload = event.payload as GatewayJsonObject;
    const idempotencyKey = typeof payload.idempotency_key === "string" ? payload.idempotency_key : null;
    const sameId = await client.query<{ tenant_id: string; envelope_digest: string }>(
      "SELECT tenant_id::text, envelope_digest FROM events WHERE id=$1", [event.event_id],
    );
    if (sameId.rowCount === 1) {
      const prior = sameId.rows[0];
      if (prior?.tenant_id !== event.tenant_id || prior.envelope_digest !== envelopeDigest) throw new Error("event_id replay changed immutable event evidence");
      return false;
    }
    if (idempotencyKey !== null) {
      const sameKey = await client.query<{ idempotency_digest: string }>(
        "SELECT idempotency_digest FROM events WHERE tenant_id=$1 AND idempotency_key=$2", [event.tenant_id, idempotencyKey],
      );
      if (sameKey.rowCount === 1) {
        if (sameKey.rows[0]?.idempotency_digest !== idempotencyDigest) throw new Error("idempotency_key replay changed immutable event evidence");
        return false;
      }
    }
    await client.query(
      `INSERT INTO events(
         id,tenant_id,event_type,occurred_at,recorded_at,source,actor,session_id,
         turn_id,sequence,payload,envelope_digest,idempotency_digest,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
      [event.event_id, event.tenant_id, event.event_type, event.occurred_at, event.recorded_at,
        JSON.stringify(event.source), JSON.stringify(event.actor), event.session_id ?? null,
        event.turn_id ?? null, event.seq, JSON.stringify(event.payload), envelopeDigest, idempotencyDigest, idempotencyKey],
    );
    return true;
  }

  async #writeToolInvocation(client: PoolClient, event: GatewayEventEnvelope): Promise<void> {
    const payload = event.payload as GatewayJsonObject;
    const required = {
      idempotencyKey: payload.idempotency_key, toolName: payload.tool_name, toolVersion: payload.tool_version,
      policyClass: payload.policy_class, executor: payload.executor, paramsDigest: payload.params_digest,
      outcome: payload.outcome, startedAtMs: payload.started_at_ms, completedAtMs: payload.completed_at_ms,
      durationMs: payload.duration_ms,
    };
    if (event.session_id === undefined || event.actor.user_id === undefined || !Object.values(required).every((value) => typeof value === "string" || typeof value === "number")) throw new Error("tool invocation evidence is incomplete");
    if (typeof required.paramsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(required.paramsDigest)) throw new Error("tool invocation params digest is invalid");
    const optionalNumber = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const written = await client.query<{ id: string }>(
      `INSERT INTO tool_invocations(
         id,tenant_id,session_id,actor_user_id,tool_name,tool_version,policy_class,executor,params_digest,outcome,idempotency_key,
         started_at,finished_at,duration_ms,params_summary,code_summary,request_bytes,response_bytes,event_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12/1000.0),to_timestamp($13/1000.0),$14,$15::jsonb,$16::jsonb,$17,$18,$19)
       ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET
         outcome=EXCLUDED.outcome,finished_at=EXCLUDED.finished_at,duration_ms=EXCLUDED.duration_ms,
         params_summary=EXCLUDED.params_summary,code_summary=EXCLUDED.code_summary,
         request_bytes=EXCLUDED.request_bytes,response_bytes=EXCLUDED.response_bytes,event_id=COALESCE(tool_invocations.event_id,EXCLUDED.event_id)
       WHERE tool_invocations.session_id=EXCLUDED.session_id AND tool_invocations.actor_user_id=EXCLUDED.actor_user_id
         AND tool_invocations.tool_name=EXCLUDED.tool_name AND tool_invocations.tool_version=EXCLUDED.tool_version
         AND tool_invocations.policy_class=EXCLUDED.policy_class AND tool_invocations.executor=EXCLUDED.executor
         AND tool_invocations.params_digest=EXCLUDED.params_digest AND tool_invocations.started_at=EXCLUDED.started_at
       RETURNING id`,
      [event.event_id,event.tenant_id,event.session_id,event.actor.user_id,required.toolName,required.toolVersion,
        required.policyClass,required.executor,required.paramsDigest.slice("sha256:".length),required.outcome,
        required.idempotencyKey,required.startedAtMs,required.completedAtMs,required.durationMs,
        JSON.stringify(payload.params_summary ?? {}),JSON.stringify(payload.code ?? {}),
        optionalNumber(payload.request_bytes),optionalNumber(payload.response_bytes),event.event_id],
    );
    if (written.rowCount !== 1) throw new Error("idempotent tool invocation replay changed immutable fields");
  }

  async #writeMeteringRecord(client: PoolClient, event: GatewayEventEnvelope): Promise<void> {
    const payload = event.payload as GatewayJsonObject;
    const numeric = ["input_tokens","output_tokens","cache_read_tokens","cache_creation_tokens","duration_ms","latency_ms","cost_microusd"] as const;
    const text = ["upstream_name","model_name","role","engine_mode","outcome","stop_reason"] as const;
    if (event.session_id === undefined || numeric.some((field) => typeof payload[field] !== "number" || !Number.isFinite(payload[field] as number) || (payload[field] as number) < 0) || text.some((field) => typeof payload[field] !== "string")) throw new Error("llm call dimensions are incomplete");
    await client.query(
      `INSERT INTO llm_calls(
         id,event_id,tenant_id,session_id,turn_id,provider,model,role,engine_mode,input_tokens,output_tokens,cache_read_tokens,
          cache_creation_input_tokens,duration_ms,latency_ms,stop_reason,outcome,cost,cost_microusd,created_at)
        VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,to_timestamp($19))
       ON CONFLICT (event_id) DO NOTHING`,
      [event.event_id,event.tenant_id,event.session_id,event.turn_id ?? null,payload.upstream_name,payload.model_name,
        payload.role,payload.engine_mode,payload.input_tokens,payload.output_tokens,payload.cache_read_tokens,
        payload.cache_creation_tokens,payload.duration_ms,payload.latency_ms,payload.stop_reason,payload.outcome,
        Number(payload.cost_microusd) / 1_000_000,payload.cost_microusd,Date.parse(event.occurred_at) / 1_000],
    );
  }
}
