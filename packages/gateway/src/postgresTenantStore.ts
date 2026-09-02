import pg, { type PoolClient } from "pg";

import type { GatewayRole } from "./authContext.js";
import type { GatewayEventEnvelope, GatewayEventSink } from "./events.js";
import type { GatewayPortResult } from "./gatewayPorts.js";
import { PostgresEu12EventPersistence } from "./postgresEu12EventPersistence.js";

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

/** Identity/read repository plus a delegated single authority for O7 routing. */
export class PostgresTenantStore implements GatewayEventSink {
  public readonly kind = "postgres" as const;
  readonly #pool: pg.Pool;
  readonly #events: PostgresEu12EventPersistence;

  public constructor(databaseUrl: string) {
    this.#pool = new Pool({ connectionString: databaseUrl });
    this.#events = new PostgresEu12EventPersistence(databaseUrl);
  }

  public async close(): Promise<void> {
    await Promise.all([this.#pool.end(), this.#events.close()]);
  }

  async #tenantTransaction<T>(tenantId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
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

  public async upsertOidcPrincipal(input: OidcPrincipalInput): Promise<{ readonly userId: string } | null> {
    return await this.#tenantTransaction(input.tenantId, async (client) => {
      const tenant = await client.query("SELECT id FROM tenants WHERE id = $1 AND status = 'active'", [input.tenantId]);
      if (tenant.rowCount !== 1) return null;
      const user = await client.query<{ id: string }>(
        `INSERT INTO users(tenant_id,oidc_issuer,oidc_subject,email,display_name,role)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id,oidc_issuer,oidc_subject) DO UPDATE SET
           email=EXCLUDED.email,display_name=EXCLUDED.display_name,role=EXCLUDED.role,last_login_at=clock_timestamp()
         RETURNING id`,
        [input.tenantId,input.issuer,input.subject,input.email,input.displayName,input.role],
      );
      const userId = user.rows[0]?.id;
      if (userId === undefined) return null;
      await client.query(
        `INSERT INTO sessions(id,tenant_id,user_id,client_type)
         VALUES($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET last_activity_at=clock_timestamp()
         WHERE sessions.tenant_id=EXCLUDED.tenant_id AND sessions.user_id=EXCLUDED.user_id`,
        [input.sessionId,input.tenantId,userId,input.clientType],
      );
      return Object.freeze({ userId });
    });
  }

  public async listDevices(auth: { readonly actor: { readonly tenantId: string } }, limit = 32): Promise<readonly TenantDeviceSummary[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 32));
    return await this.#tenantTransaction(auth.actor.tenantId, async (client) => {
      const result = await client.query<{ id: string; machine_name: string; bridge_version: string | null; addin_version: string | null; status: "active" | "revoked" }>(
        `SELECT id,machine_name,bridge_version,addin_version,status FROM devices ORDER BY machine_name,id LIMIT $1`,
        [boundedLimit],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        deviceId: row.id, machineName: row.machine_name, bridgeVersion: row.bridge_version,
        addinVersion: row.addin_version, status: row.status,
      })));
    });
  }

  public async emit(event: GatewayEventEnvelope): Promise<GatewayPortResult<void>> {
    try {
      await this.#events.write([event]);
      return Object.freeze({ ok: true as const, value: undefined });
    } catch {
      return Object.freeze({ ok: false as const, port: "event_sink" as const, code: "unavailable" as const, message: "tenant audit persistence failed" });
    }
  }

  public async emitBatch(events: readonly GatewayEventEnvelope[]): Promise<GatewayPortResult<void>> {
    try {
      await this.#events.write(events);
      return Object.freeze({ ok: true as const, value: undefined });
    } catch {
      return Object.freeze({ ok: false as const, port: "event_sink" as const, code: "unavailable" as const, message: "tenant audit persistence failed" });
    }
  }

  public async flush(): Promise<GatewayPortResult<void>> {
    return Object.freeze({ ok: true as const, value: undefined });
  }
}
