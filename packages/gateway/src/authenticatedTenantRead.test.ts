import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthenticatedTenantReadNorthMcp } from "./authenticatedTenantRead.js";
import { migrateUp } from "./migrate.js";
import { createOidcIdentityPort } from "./oidcIdentity.js";
import { PostgresTenantStore } from "./postgresTenantStore.js";
import { startNorthMcpEndpoint } from "./northMcpEndpoint.js";
import type { GatewayEventEnvelope } from "./events.js";

const { Pool } = pg;
const DATABASE_URL = process.env.EU10_DATABASE_URL;
const suite = DATABASE_URL === undefined ? describe.skip : describe;
const TENANT_A = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "20000000-0000-4000-8000-000000000002";
const TENANT_FOREIGN = "30000000-0000-4000-8000-000000000003";
const ISSUER = "https://identity.example.test/realms/revagent";
const AUDIENCE = "revagent-north-mcp";

suite("EU-10 authenticated tenant read", () => {
  let store: PostgresTenantStore;
  let admin: pg.Pool;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let keyResolver: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    await migrateUp(DATABASE_URL!);
    admin = new Pool({ connectionString: DATABASE_URL });
    await admin.query("TRUNCATE tool_invocations, sessions, users, devices, tenants CASCADE");
    await admin.query(
      "INSERT INTO tenants(id,slug,name) VALUES ($1,'tenant-a','Tenant A'),($2,'tenant-b','Tenant B')",
      [TENANT_A, TENANT_B],
    );
    await admin.query(
      `INSERT INTO devices(id,tenant_id,machine_name,bridge_version,addin_version)
       VALUES ('10000000-0000-4000-8000-000000000011',$1,'A-WS','1.0','1.0'),
              ('20000000-0000-4000-8000-000000000022',$2,'B-WS','2.0','2.0')`,
      [TENANT_A, TENANT_B],
    );
    store = new PostgresTenantStore(DATABASE_URL!);
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    keyResolver = createLocalJWKSet({ keys: [{ ...jwk, kid: "eu10", alg: "RS256", use: "sig" }] });
  }, 30_000);

  afterAll(async () => {
    await store?.close();
    await admin?.end();
  });

  async function token(input: {
    tenantId: string; subject?: string; role?: "user" | "tenant_admin";
    expiresIn?: string; key?: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  }): Promise<string> {
    return await new SignJWT({
      tenant_id: input.tenantId,
      scope: "mcp:read",
      realm_access: { roles: [input.role ?? "user"] },
      sid: `sid-${input.subject ?? "alice"}`,
      azp: AUDIENCE,
    }).setProtectedHeader({ alg: "RS256", kid: "eu10" })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(input.subject ?? "alice")
      .setIssuedAt().setExpirationTime(input.expiresIn ?? "5m")
      .sign(input.key ?? privateKey);
  }

  function identity() {
    return createOidcIdentityPort({
      issuer: ISSUER, audience: AUDIENCE,
      jwksUri: "https://unused.invalid/jwks", keyResolver, repository: store,
    });
  }

  it("migrates a blank database, maps bearer identity/role, and denies invalid, expired, and foreign-tenant tokens", async () => {
    const port = identity();
    const valid = await port.authenticateNorthRequest({ authorization: `Bearer ${await token({ tenantId: TENANT_A, role: "tenant_admin" })}` });
    expect(valid.ok && valid.value.actor).toMatchObject({ tenantId: TENANT_A, role: "tenant_admin", oidcSubject: "alice" });

    const wrongKeys = await generateKeyPair("RS256");
    await expect(port.authenticateNorthRequest({ authorization: `Bearer ${await token({ tenantId: TENANT_A, key: wrongKeys.privateKey })}` }))
      .resolves.toMatchObject({ ok: false });
    await expect(port.authenticateNorthRequest({ authorization: `Bearer ${await token({ tenantId: TENANT_A, expiresIn: "-1s" })}` }))
      .resolves.toMatchObject({ ok: false });
    await expect(port.authenticateNorthRequest({ authorization: `Bearer ${await token({ tenantId: TENANT_FOREIGN })}` }))
      .resolves.toMatchObject({ ok: false });
  });

  it("enforces RLS read/write negatives for two tenants", async () => {
    const a = await identity().authenticateNorthRequest({ authorization: `Bearer ${await token({ tenantId: TENANT_A })}` });
    if (!a.ok) throw new Error("tenant A authentication failed");
    await expect(store.listDevices(a.value)).resolves.toEqual([
      expect.objectContaining({ machineName: "A-WS" }),
    ]);
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT_A]);
      await expect(client.query("SELECT id FROM devices WHERE tenant_id=$1", [TENANT_B]))
        .resolves.toMatchObject({ rowCount: 0 });
      await expect(client.query(
        "INSERT INTO devices(tenant_id,machine_name) VALUES ($1,'FORBIDDEN')", [TENANT_B],
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });

  it("executes one external north-MCP bounded read and persists one tenant-bound idempotent audit row", async () => {
    const bearer = await token({ tenantId: TENANT_A, subject: "mcp-user" });
    const options = createAuthenticatedTenantReadNorthMcp({
      identity: identity(), store,
      resource: new URL("https://gateway.example.test/mcp"),
      resourceMetadataUrl: new URL("https://gateway.example.test/.well-known/oauth-protected-resource/mcp"),
      requestStateKey: "eu10-request-state-key-at-least-32-bytes-long",
    });
    const endpoint = await startNorthMcpEndpoint({ ...options, host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "eu10-external-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    });
    try {
      const wrongKeys = await generateKeyPair("RS256");
      for (const denied of [
        await token({ tenantId: TENANT_A, key: wrongKeys.privateKey }),
        await token({ tenantId: TENANT_A, expiresIn: "-1s" }),
        await token({ tenantId: TENANT_FOREIGN }),
      ]) {
        const response = await fetch(endpoint.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${denied}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        });
        expect(response.status).toBe(401);
      }
      await client.connect(transport);
      await expect(client.callTool({ name: "core.bridge.list", arguments: {} })).resolves.toMatchObject({
        structuredContent: { result: { bounded: true, count: 1, devices: [{ machineName: "A-WS" }] } },
      });
    } finally {
      await transport.close();
      await endpoint.close();
    }
    const rows = await admin.query("SELECT tenant_id, actor_user_id, session_id, tool_name, idempotency_key FROM tool_invocations WHERE tenant_id=$1", [TENANT_A]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({ tenant_id: TENANT_A, tool_name: "core.bridge.list" });

    const first = rows.rows[0] as { actor_user_id: string; session_id: string; idempotency_key: string };
    const event = (eventId: string): GatewayEventEnvelope => ({
      schema: "revagent.event.v2", event_id: eventId, event_type: "tool.invocation",
      occurred_at: new Date().toISOString(), recorded_at: new Date().toISOString(), tenant_id: TENANT_A,
      source: { component: "test", version: "1", instance: "eu10" },
      actor: { type: "user", user_id: first.actor_user_id }, session_id: first.session_id, seq: 2,
      payload: {
        idempotency_key: "eu10/idempotent", tool_name: "core.bridge.list", tool_version: "1.0.0",
        policy_class: "auto", executor: "internal_mcp",
        params_digest: `sha256:${"a".repeat(64)}`, outcome: "completed",
        started_at_ms: Date.now(), completed_at_ms: Date.now(), duration_ms: 0,
      },
    });
    expect((await store.emit(event("70000000-0000-7000-8000-000000000001"))).ok).toBe(true);
    expect((await store.emit(event("70000000-0000-7000-8000-000000000002"))).ok).toBe(true);
    const idempotent = await admin.query("SELECT count(*)::int AS count FROM tool_invocations WHERE tenant_id=$1 AND idempotency_key='eu10/idempotent'", [TENANT_A]);
    expect(idempotent.rows[0]?.count).toBe(1);
  });
});
