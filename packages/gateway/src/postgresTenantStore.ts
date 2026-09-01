import pg, { type PoolClient } from "pg";
import type { GatewayRole } from "./authContext.js";
import type { GatewayJsonObject } from "./dispatch.js";
import type { GatewayEventEnvelope, GatewayEventSink } from "./events.js";
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
    if (event.event_type !== "tool.invocation") {
      return Object.freeze({ ok: true as const, value: undefined });
    }
    try {
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
      if (
        event.session_id === undefined || event.actor.user_id === undefined ||
        !Object.values(required).every((value) => typeof value === "string" || typeof value === "number")
      ) throw new Error("tool invocation evidence is incomplete");
      if (typeof required.paramsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(required.paramsDigest)) {
        throw new Error("tool invocation params digest is invalid");
      }
      const paramsDigest = required.paramsDigest.slice("sha256:".length);
      await this.#tenantTransaction(event.tenant_id, async (client) => {
        const written = await client.query<{ id: string }>(
          `INSERT INTO tool_invocations(
             id, tenant_id, session_id, actor_user_id, tool_name, tool_version,
             policy_class, executor, params_digest, outcome, idempotency_key,
             started_at, finished_at, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12 / 1000.0),to_timestamp($13 / 1000.0),$14)
           ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
             outcome = EXCLUDED.outcome, finished_at = EXCLUDED.finished_at,
             duration_ms = EXCLUDED.duration_ms
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
            required.toolName, required.toolVersion, required.policyClass,
            required.executor, paramsDigest, required.outcome,
            required.idempotencyKey, required.startedAtMs, required.completedAtMs,
            required.durationMs],
        );
        if (written.rowCount !== 1) {
          throw new Error("idempotent tool invocation replay changed immutable fields");
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
