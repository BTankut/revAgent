import pg, { type PoolClient } from "pg";
import type { GatewayRole } from "./authContext.js";
import type { GatewayJsonObject } from "./dispatch.js";
import type { GatewayEventEnvelope, GatewayEventSink } from "./events.js";
import {
  eventEnvelopeDigest,
  eventIdempotencyDigest,
  routeEu12Event,
  validateEu12EventEnvelope,
} from "./eventPersistence.js";
import type { GatewayPortResult } from "./gatewayPorts.js";

const { Pool } = pg;

export interface OidcPrincipalInput {
  readonly tenantId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly role: GatewayRole;
  readonly sessionId: string;
  readonly clientType: "mcp" | "web";
}

export interface TenantDeviceSummary {
  readonly deviceId: string;
  readonly machineName: string;
  readonly bridgeVersion: string | null;
  readonly addinVersion: string | null;
  readonly status: "active" | "revoked";
}

export class PostgresTenantStore implements GatewayEventSink {
  readonly kind = "postgres" as const;
  readonly #pool: pg.Pool;

  public constructor(databaseUrl: string) {
    this.#pool = new Pool({ connectionString: databaseUrl });
  }

  public async close(): Promise<void> {
    await this.#pool.end();
  }

  async #tenantTransaction<T>(
    tenantId: string,
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async upsertOidcPrincipal(input: OidcPrincipalInput): Promise<{
    readonly userId: string;
  } | null> {
    return await this.#tenantTransaction(input.tenantId, async (client) => {
      const tenant = await client.query("SELECT id FROM tenants WHERE id = $1 AND status = 'active'", [input.tenantId]);
      if (tenant.rowCount !== 1) return null;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users(tenant_id, oidc_issuer, oidc_subject, email, display_name, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, oidc_issuer, oidc_subject) DO UPDATE SET
           email = EXCLUDED.email, display_name = EXCLUDED.display_name,
           role = EXCLUDED.role, last_login_at = clock_timestamp()
         RETURNING id`,
        [input.tenantId, input.issuer, input.subject, input.email, input.displayName, input.role],
      );
      const userId = user.rows[0]?.id;
      if (userId === undefined) return null;
      await client.query(
        `INSERT INTO sessions(id, tenant_id, user_id, client_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET last_activity_at = clock_timestamp()
         WHERE sessions.tenant_id = EXCLUDED.tenant_id AND sessions.user_id = EXCLUDED.user_id`,
        [input.sessionId, input.tenantId, userId, input.clientType],
      );
      return Object.freeze({ userId });
    });
  }

  public async listDevices(auth: { readonly actor: { readonly tenantId: string } }, limit = 32): Promise<readonly TenantDeviceSummary[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 32));
    return await this.#tenantTransaction(auth.actor.tenantId, async (client) => {
      const result = await client.query<{
        id: string; machine_name: string; bridge_version: string | null;
        addin_version: string | null; status: "active" | "revoked";
      }>(
        `SELECT id, machine_name, bridge_version, addin_version, status
         FROM devices ORDER BY machine_name, id LIMIT $1`,
        [boundedLimit],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        deviceId: row.id,
        machineName: row.machine_name,
        bridgeVersion: row.bridge_version,
        addinVersion: row.addin_version,
        status: row.status,
      })));
    });
  }

  public async emit(event: GatewayEventEnvelope): Promise<GatewayPortResult<void>> {
    try {
      const validated = validateEu12EventEnvelope(event);
      await this.#tenantTransaction(validated.tenant_id, async (client) => {
        const inserted = await this.#writeEnvelope(client, validated);
        if (!inserted) return;
        if (routeEu12Event(validated) === "tool_invocations") {
          await this.#writeToolInvocation(client, validated);
        } else if (routeEu12Event(validated) === "llm_calls") {
          await this.#writeMeteringRecord(client, validated);
        }
      });
      return Object.freeze({ ok: true as const, value: undefined });
    } catch {
      return Object.freeze({
        ok: false as const, port: "event_sink" as const, code: "unavailable" as const,
        message: "tenant audit persistence failed",
      });
    }
  }

  async #writeEnvelope(client: PoolClient, event: GatewayEventEnvelope): Promise<boolean> {
    const envelopeDigest = eventEnvelopeDigest(event).slice("sha256:".length);
    const idempotencyDigest = eventIdempotencyDigest(event).slice("sha256:".length);
    const payload = event.payload as GatewayJsonObject;
    const idempotencyKey = typeof payload.idempotency_key === "string" ? payload.idempotency_key : null;
    const sameId = await client.query<{ tenant_id: string; envelope_digest: string }>(
      "SELECT tenant_id::text, envelope_digest FROM events WHERE id=$1",
      [event.event_id],
    );
    if (sameId.rowCount === 1) {
      const prior = sameId.rows[0];
      if (prior?.tenant_id !== event.tenant_id || prior.envelope_digest !== envelopeDigest) {
        throw new Error("event_id replay changed immutable event evidence");
      }
      return false;
    }
    if (idempotencyKey !== null) {
      const sameKey = await client.query<{ id: string; idempotency_digest: string }>(
        "SELECT id::text, idempotency_digest FROM events WHERE tenant_id=$1 AND idempotency_key=$2",
        [event.tenant_id, idempotencyKey],
      );
      if (sameKey.rowCount === 1) {
        if (sameKey.rows[0]?.idempotency_digest !== idempotencyDigest) {
          throw new Error("idempotency_key replay changed immutable event evidence");
        }
        return false;
      }
    }
    await client.query(
      `INSERT INTO events(
         id,tenant_id,event_type,occurred_at,recorded_at,source,actor,session_id,
         turn_id,sequence,payload,envelope_digest,idempotency_digest,idempotency_key)
       VALUES (
         $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,$14
       )`,
      [event.event_id, event.tenant_id, event.event_type, event.occurred_at,
        event.recorded_at, JSON.stringify(event.source), JSON.stringify(event.actor),
        event.session_id ?? null, event.turn_id ?? null, event.seq,
        JSON.stringify(event.payload), envelopeDigest, idempotencyDigest, idempotencyKey],
    );
    return true;
  }

  async #writeToolInvocation(client: PoolClient, event: GatewayEventEnvelope): Promise<void> {
    const payload = event.payload as GatewayJsonObject;
    const required = {
      idempotencyKey: payload.idempotency_key,
      toolName: payload.tool_name,
      toolVersion: payload.tool_version,
      policyClass: payload.policy_class,
      executor: payload.executor,
      paramsDigest: payload.params_digest,
      outcome: payload.outcome,
      startedAtMs: payload.started_at_ms,
      completedAtMs: payload.completed_at_ms,
      durationMs: payload.duration_ms,
    };
    if (event.session_id === undefined || event.actor.user_id === undefined ||
      !Object.values(required).every((value) => typeof value === "string" || typeof value === "number")) {
      throw new Error("tool invocation evidence is incomplete");
    }
    if (typeof required.paramsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(required.paramsDigest)) {
      throw new Error("tool invocation params digest is invalid");
    }
    const optionalNumber = (value: unknown): number | null =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const written = await client.query<{ id: string }>(
      `INSERT INTO tool_invocations(
         id, tenant_id, session_id, actor_user_id, tool_name, tool_version,
         policy_class, executor, params_digest, outcome, idempotency_key,
         started_at, finished_at, duration_ms, params_summary, code_summary,
         request_bytes, response_bytes, event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12 / 1000.0),to_timestamp($13 / 1000.0),$14,$15::jsonb,$16::jsonb,$17,$18,$19)
       ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
         outcome = EXCLUDED.outcome, finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms,
         params_summary = EXCLUDED.params_summary, code_summary = EXCLUDED.code_summary,
         request_bytes = EXCLUDED.request_bytes, response_bytes = EXCLUDED.response_bytes,
         event_id = COALESCE(tool_invocations.event_id, EXCLUDED.event_id)
       WHERE tool_invocations.session_id = EXCLUDED.session_id
         AND tool_invocations.actor_user_id = EXCLUDED.actor_user_id
         AND tool_invocations.tool_name = EXCLUDED.tool_name
         AND tool_invocations.tool_version = EXCLUDED.tool_version
         AND tool_invocations.policy_class = EXCLUDED.policy_class
         AND tool_invocations.executor = EXCLUDED.executor
         AND tool_invocations.params_digest = EXCLUDED.params_digest
         AND tool_invocations.started_at = EXCLUDED.started_at
       RETURNING id`,
      [event.event_id, event.tenant_id, event.session_id, event.actor.user_id,
        required.toolName, required.toolVersion, required.policyClass, required.executor,
        required.paramsDigest.slice("sha256:".length), required.outcome, required.idempotencyKey,
        required.startedAtMs, required.completedAtMs, required.durationMs,
        JSON.stringify(payload.params_summary ?? {}), JSON.stringify(payload.code ?? {}),
        optionalNumber(payload.request_bytes), optionalNumber(payload.response_bytes), event.event_id],
    );
    if (written.rowCount !== 1) throw new Error("idempotent tool invocation replay changed immutable fields");
  }

  async #writeMeteringRecord(client: PoolClient, event: GatewayEventEnvelope): Promise<void> {
    const payload = event.payload as GatewayJsonObject;
    const fields = ["input_tokens", "output_tokens", "cache_read_tokens", "duration_ms", "cost"] as const;
    if (event.session_id === undefined || fields.some((field) => typeof payload[field] !== "number" || !Number.isFinite(payload[field] as number) || (payload[field] as number) < 0)) {
      throw new Error("llm call instrumentation is incomplete");
    }
    await client.query(
      `INSERT INTO llm_calls(event_id,tenant_id,session_id,input_tokens,output_tokens,cache_read_tokens,duration_ms,cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.event_id, event.tenant_id, event.session_id, payload.input_tokens,
        payload.output_tokens, payload.cache_read_tokens, payload.duration_ms, payload.cost],
    );
  }

  public async emitBatch(events: readonly GatewayEventEnvelope[]): Promise<GatewayPortResult<void>> {
    for (const event of events) {
      const emitted = await this.emit(event);
      if (!emitted.ok) return emitted;
    }
    return Object.freeze({ ok: true as const, value: undefined });
  }

  public async flush(): Promise<GatewayPortResult<void>> {
    return Object.freeze({ ok: true as const, value: undefined });
  }
}
