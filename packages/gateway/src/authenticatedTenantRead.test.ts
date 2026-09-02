import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
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
const KEYCLOAK_ISSUER = process.env.EU10_KEYCLOAK_ISSUER;
const KEYCLOAK_ADMIN_USERNAME = process.env.EU10_KEYCLOAK_ADMIN_USERNAME;
const KEYCLOAK_ADMIN_PASSWORD = process.env.EU10_KEYCLOAK_ADMIN_PASSWORD;
const keycloakIt = KEYCLOAK_ISSUER !== undefined && KEYCLOAK_ADMIN_USERNAME !== undefined &&
  KEYCLOAK_ADMIN_PASSWORD !== undefined ? it : it.skip;

function formAction(html: string): string {
  const action = /<form[^>]+action="([^"]+)"/iu.exec(html)?.[1];
  if (action === undefined) throw new Error("Keycloak login form action was not found");
  return action.replaceAll("&amp;", "&");
}

function responseCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return (headers.getSetCookie?.() ?? []).map((value) => value.split(";", 1)[0]).join("; ");
}

function mergeCookies(current: string, response: Response): string {
  const jar = new Map<string, string>();
  for (const cookie of [current, responseCookies(response)].flatMap((value) => value.split(/;\s*/u))) {
    const separator = cookie.indexOf("=");
    if (separator > 0) jar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

suite("EU-10 authenticated tenant read", () => {
  let store: PostgresTenantStore;
  let admin: pg.Pool;
  let runtime: pg.Pool;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let keyResolver: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const appPassword = randomBytes(32).toString("base64url");
    await migrateUp(DATABASE_URL!, { appPassword });
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
    const runtimeUrl = new URL(DATABASE_URL!);
    runtimeUrl.username = "revagent_runtime";
    runtimeUrl.password = appPassword;
    runtime = new Pool({ connectionString: runtimeUrl.href });
    store = new PostgresTenantStore(runtimeUrl.href);
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    keyResolver = createLocalJWKSet({ keys: [{ ...jwk, kid: "eu10", alg: "RS256", use: "sig" }] });
  }, 30_000);

  afterAll(async () => {
    await store?.close();
    await runtime?.end();
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

  async function keycloakLogin(tenantId: string): Promise<{ accessToken: string; userId: string; adminToken: string }> {
    const issuer = KEYCLOAK_ISSUER!;
    const realmRoot = issuer.slice(0, issuer.lastIndexOf("/realms/"));
    const adminTokenResponse = await fetch(`${realmRoot}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password", client_id: "admin-cli",
        username: KEYCLOAK_ADMIN_USERNAME!, password: KEYCLOAK_ADMIN_PASSWORD!,
      }),
    });
    expect(adminTokenResponse.ok).toBe(true);
    const adminToken = (await adminTokenResponse.json() as { access_token: string }).access_token;
    const username = `eu10-${randomBytes(8).toString("hex")}`;
    const password = randomBytes(24).toString("base64url");
    const created = await fetch(`${realmRoot}/admin/realms/revagent/users`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        username, enabled: true, email: `${username}@example.test`, emailVerified: true,
        firstName: "EU10", lastName: "Test", attributes: { tenant_id: [tenantId] },
      }),
    });
    expect(created.status).toBe(201);
    const userId = created.headers.get("location")?.split("/").at(-1);
    if (userId === undefined) throw new Error("Keycloak user id was not returned");
    const reset = await fetch(`${realmRoot}/admin/realms/revagent/users/${userId}/reset-password`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "password", value: password, temporary: false }),
    });
    expect(reset.status).toBe(204);
    const roleResponse = await fetch(`${realmRoot}/admin/realms/revagent/roles/user`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(roleResponse.ok).toBe(true);
    const assigned = await fetch(`${realmRoot}/admin/realms/revagent/users/${userId}/role-mappings/realm`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify([await roleResponse.json()]),
    });
    expect(assigned.status).toBe(204);

    const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
    expect(discoveryResponse.ok).toBe(true);
    const discovery = await discoveryResponse.json() as {
      issuer: string; authorization_endpoint: string; token_endpoint: string;
    };
    expect(discovery.issuer).toBe(issuer);
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "http://127.0.0.1:58081/callback";
    const authorization = new URL(discovery.authorization_endpoint);
    for (const [name, value] of Object.entries({
      client_id: AUDIENCE, redirect_uri: redirectUri, response_type: "code",
      scope: "openid tenant mcp:read revagent-audience", code_challenge: challenge,
      code_challenge_method: "S256", state: randomBytes(16).toString("hex"),
    })) authorization.searchParams.set(name, value);
    const loginPage = await fetch(authorization, { redirect: "manual" });
    expect(loginPage.status).toBe(200);
    let cookies = responseCookies(loginPage);
    expect(cookies).not.toBe("");
    let login = await fetch(formAction(await loginPage.text()), {
      method: "POST", redirect: "manual",
      headers: { cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username, password, credential: password }),
    });
    cookies = mergeCookies(cookies, login);
    let location = login.headers.get("location");
    if (location === null) throw new Error("Keycloak login did not redirect");
    let loginRedirect = new URL(location, issuer);
    for (let redirectCount = 0; redirectCount < 5 && loginRedirect.origin === new URL(issuer).origin; redirectCount += 1) {
      expect(loginRedirect.pathname).toMatch(/^\/identity\/realms\/revagent\/login-actions\//u);
      login = await fetch(loginRedirect, { redirect: "manual", headers: { cookie: cookies } });
      cookies = mergeCookies(cookies, login);
      location = login.headers.get("location");
      if (location === null) throw new Error("Keycloak login continuation did not redirect");
      loginRedirect = new URL(location, issuer);
    }
    expect(loginRedirect.origin).toBe("http://127.0.0.1:58081");
    expect(loginRedirect.pathname).toBe("/callback");
    const code = loginRedirect.searchParams.get("code");
    if (code === null) {
      throw new Error(`Keycloak login refused: ${loginRedirect.searchParams.get("error") ?? "no_code"} ${loginRedirect.searchParams.get("error_description") ?? ""} at ${loginRedirect.pathname}`.trim());
    }
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: AUDIENCE,
        redirect_uri: redirectUri, code, code_verifier: verifier,
      }),
    });
    expect(tokenResponse.ok).toBe(true);
    const accessToken = (await tokenResponse.json() as { access_token: string }).access_token;
    return { accessToken, userId, adminToken };
  }

  it("migrates a blank database, maps bearer identity/role, and denies invalid, expired, and foreign-tenant tokens", async () => {
    const role = await admin.query(
      "SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit FROM pg_roles WHERE rolname='revagent_runtime'",
    );
    expect(role.rows[0]).toEqual({
      rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false,
    });
    const owner = await admin.query("SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='users'");
    expect(owner.rows[0]?.tableowner).not.toBe("revagent_runtime");
    await expect(runtime.query("SELECT id FROM tenants")).rejects.toMatchObject({ code: "42501" });
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
    const client = await runtime.connect();
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
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT_B]);
      await expect(client.query(
        `INSERT INTO tool_invocations(
          id,tenant_id,session_id,actor_user_id,tool_name,tool_version,policy_class,
          executor,params_digest,outcome,idempotency_key,started_at,finished_at,duration_ms)
         VALUES ('40000000-0000-7000-8000-000000000004',$1,$2,$3,'core.bridge.list','1.0.0',
          'auto','internal_mcp',$4,'completed','eu10/foreign-fk',clock_timestamp(),clock_timestamp(),0)`,
        [TENANT_B, a.value.session.sessionId, a.value.actor.userId, "a".repeat(64)],
      )).rejects.toMatchObject({ code: "23503" });
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
    const replayStartedAt = Date.now();
    const event = (eventId: string, overrides: Partial<GatewayEventEnvelope> = {}): GatewayEventEnvelope => ({
      schema: "revagent.event.v2", event_id: eventId, event_type: "tool.invocation",
      occurred_at: new Date().toISOString(), recorded_at: new Date().toISOString(), tenant_id: TENANT_A,
      source: { component: "test", version: "1", instance: "eu10" },
      actor: { type: "user", user_id: first.actor_user_id }, session_id: first.session_id, seq: 2,
      payload: {
        idempotency_key: "eu10/idempotent", tool_name: "core.bridge.list", tool_version: "1.0.0",
        policy_class: "auto", executor: "internal_mcp",
        params_digest: `sha256:${"a".repeat(64)}`, outcome: "completed",
        started_at_ms: replayStartedAt, completed_at_ms: replayStartedAt, duration_ms: 0,
      },
      ...overrides,
    });
    expect((await store.emit(event("70000000-0000-7000-8000-000000000001"))).ok).toBe(true);
    expect((await store.emit(event("70000000-0000-7000-8000-000000000002"))).ok).toBe(true);
    const idempotent = await admin.query("SELECT count(*)::int AS count FROM tool_invocations WHERE tenant_id=$1 AND idempotency_key='eu10/idempotent'", [TENANT_A]);
    expect(idempotent.rows[0]?.count).toBe(1);
    expect((await store.emit({
      ...event("70000000-0000-7000-8000-000000000003"),
      payload: { ...event("70000000-0000-7000-8000-000000000003").payload, tool_version: "9.9.9" },
    })).ok).toBe(false);

    const tenantB = await identity().authenticateNorthRequest({
      authorization: `Bearer ${await token({ tenantId: TENANT_B, subject: "tenant-b-user" })}`,
    });
    if (!tenantB.ok) throw new Error("tenant B authentication failed");
    expect((await store.emit({
      ...event("70000000-0000-7000-8000-000000000004"),
      tenant_id: TENANT_A,
      actor: { type: "user", user_id: tenantB.value.actor.userId },
      session_id: tenantB.value.session.sessionId,
      payload: { ...event("70000000-0000-7000-8000-000000000004").payload, idempotency_key: "eu10/cross-tenant" },
    })).ok).toBe(false);
    const crossTenant = await admin.query(
      "SELECT count(*)::int AS count FROM tool_invocations WHERE idempotency_key='eu10/cross-tenant'",
    );
    expect(crossTenant.rows[0]?.count).toBe(0);
  });

  keycloakIt("maps real Keycloak Tenant A/B identities, isolates their north-MCP reads, and denies foreign/wrong authority", async () => {
    const logins = await Promise.all([
      keycloakLogin(TENANT_A),
      keycloakLogin(TENANT_B),
      keycloakLogin(TENANT_FOREIGN),
    ]);
    const [tenantA, tenantB, foreign] = logins;
    const issuer = KEYCLOAK_ISSUER!;
    const discovery = await fetch(`${issuer}/.well-known/openid-configuration`).then(async (response) =>
      await response.json() as { jwks_uri: string });
    const refusalReasons: string[] = [];
    const realIdentity = createOidcIdentityPort({
      issuer, audience: AUDIENCE, jwksUri: discovery.jwks_uri, repository: store,
      reportRefusal: (reason) => refusalReasons.push(reason),
    });
    try {
      for (const [login, expectedTenant] of [[tenantA, TENANT_A], [tenantB, TENANT_B]] as const) {
        const claims = decodeJwt(login.accessToken);
        expect(claims).toMatchObject({ iss: issuer, tenant_id: expectedTenant, aud: AUDIENCE, sub: expect.any(String) });
        const realmRoles = (claims.realm_access as { roles?: unknown[] } | undefined)?.roles;
        expect(Array.isArray(realmRoles)).toBe(true);
        expect(realmRoles).toContain("user");
        expect(String(claims.scope).split(" ")).toContain("mcp:read");
        await expect(jwtVerify(login.accessToken, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
          issuer, audience: AUDIENCE, algorithms: ["RS256"],
        })).resolves.toMatchObject({ payload: { tenant_id: expectedTenant } });
        const authenticated = await realIdentity.authenticateNorthRequest({ authorization: `Bearer ${login.accessToken}` });
        if (!authenticated.ok) throw new Error(`real Keycloak identity refused at ${refusalReasons.join(",")}`);
        expect(authenticated.value.actor).toMatchObject({ tenantId: expectedTenant, role: "user" });
      }
      await expect(realIdentity.authenticateNorthRequest({ authorization: `Bearer ${foreign.accessToken}` }))
        .resolves.toMatchObject({ ok: false });
      for (const denied of [
        createOidcIdentityPort({ issuer: `${issuer}/wrong`, audience: AUDIENCE, jwksUri: discovery.jwks_uri, repository: store }),
        createOidcIdentityPort({ issuer, audience: "wrong-audience", jwksUri: discovery.jwks_uri, repository: store }),
      ]) await expect(denied.authenticateNorthRequest({ authorization: `Bearer ${tenantA.accessToken}` })).resolves.toMatchObject({ ok: false });

      const options = createAuthenticatedTenantReadNorthMcp({
        identity: realIdentity, store,
        resource: new URL("https://gateway.example.test/mcp"),
        resourceMetadataUrl: new URL("https://gateway.example.test/.well-known/oauth-protected-resource/mcp"),
        requestStateKey: "eu10-keycloak-request-state-key-32-bytes",
      });
      const endpoint = await startNorthMcpEndpoint({ ...options, host: "127.0.0.1", port: 0 });
      try {
        for (const [login, machineName] of [[tenantA, "A-WS"], [tenantB, "B-WS"]] as const) {
          const client = new Client({ name: `eu10-keycloak-${machineName}`, version: "1.0.0" });
          const transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
            requestInit: { headers: { authorization: `Bearer ${login.accessToken}` } },
          });
          try {
            await client.connect(transport);
            await expect(client.callTool({ name: "core.bridge.list", arguments: {} })).resolves.toMatchObject({
              structuredContent: { result: { bounded: true, count: 1, devices: [{ machineName }] } },
            });
          } finally { await transport.close(); }
        }
        const response = await fetch(endpoint.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${foreign.accessToken}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        });
        expect(response.status).toBe(401);
      } finally { await endpoint.close(); }
    } finally {
      const realmRoot = issuer.slice(0, issuer.lastIndexOf("/realms/"));
      await Promise.all(logins.map(async ({ userId, adminToken }) =>
        await fetch(`${realmRoot}/admin/realms/revagent/users/${userId}`, {
          method: "DELETE", headers: { authorization: `Bearer ${adminToken}` },
        })));
    }
  }, 45_000);
});
