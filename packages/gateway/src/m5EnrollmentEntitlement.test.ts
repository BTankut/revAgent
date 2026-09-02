import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
  type GatewayMachineFingerprint,
} from "./authContext.js";
import {
  M5_ACTIVE_REVOKE_BOUND_MS,
  M5EnrollmentEntitlementControlPlane,
  type M5BridgeCloseControl,
  type M5BridgeExecutor,
} from "./m5EnrollmentEntitlement.js";
import {
  M5_BRIDGE_ENROLLMENT_PATH,
  mountM5BridgeEnrollmentEndpoint,
} from "./m5EnrollmentEntitlementEndpoint.js";

const { Pool } = pg;

const CLUSTER_URL = process.env.EU11_DATABASE_URL ?? process.env.EU10_DATABASE_URL;
const suite = CLUSTER_URL === undefined ? describe.skip : describe.sequential;

const TENANT_A = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "20000000-0000-4000-8000-000000000002";
const A_ADMIN = "10000000-0000-4000-8000-000000000101";
const A_USER_1 = "10000000-0000-4000-8000-000000000111";
const A_USER_2 = "10000000-0000-4000-8000-000000000112";
const A_USER_3 = "10000000-0000-4000-8000-000000000113";
const B_ADMIN = "20000000-0000-4000-8000-000000000201";
const B_USER = "20000000-0000-4000-8000-000000000211";
const A_DEVICE_1 = "10000000-0000-4000-8000-000000000311";
const A_DEVICE_2 = "10000000-0000-4000-8000-000000000312";
const A_DEVICE_3 = "10000000-0000-4000-8000-000000000313";
const B_DEVICE = "20000000-0000-4000-8000-000000000321";
const FINGERPRINT_A1 = `sha256:${"11".repeat(32)}` as GatewayMachineFingerprint;
const FINGERPRINT_A2 = `sha256:${"12".repeat(32)}` as GatewayMachineFingerprint;
const FINGERPRINT_A3 = `sha256:${"13".repeat(32)}` as GatewayMachineFingerprint;
const FINGERPRINT_B = `sha256:${"21".repeat(32)}` as GatewayMachineFingerprint;
const ROTATION_GRACE_MS = 2_000;

function auth(
  tenantId: string,
  userId: string,
  role: "user" | "tenant_admin",
): AuthContext {
  return Object.freeze({
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: Object.freeze({
      type: "user" as const,
      tenantId,
      userId,
      role,
      oidcIssuer: "https://identity.example.test/realms/revagent",
      oidcSubject: `subject-${userId}`,
    }),
    session: Object.freeze({
      sessionId: `session-${userId}`,
      clientType: "mcp" as const,
      mcpSessionId: `mcp-${userId}`,
      oauthClientId: "eu11-test-client",
    }),
    principalKey: `principal-${userId}`,
    issuedAtMs: 1_800_000_000_000,
    expiresAtMs: null,
  });
}

suite("EU-11 enrolled and entitled Bridge dispatch", () => {
  let cluster: pg.Pool;
  let admin: pg.Pool;
  let app: FastifyInstance;
  let controlPlane: M5EnrollmentEntitlementControlPlane;
  let databaseName: string;
  let databaseUrl: string;
  let nowMs = 1_800_000_000_000;

  const adminA = auth(TENANT_A, A_ADMIN, "tenant_admin");
  const adminB = auth(TENANT_B, B_ADMIN, "tenant_admin");

  beforeAll(async () => {
    const clusterUrl = new URL(CLUSTER_URL!);
    databaseName = `revagent_eu11_${process.pid}_${randomBytes(6).toString("hex")}`;
    cluster = new Pool({ connectionString: clusterUrl.href });
    await cluster.query(`CREATE DATABASE "${databaseName}"`);
    clusterUrl.pathname = `/${databaseName}`;
    databaseUrl = clusterUrl.href;
    admin = new Pool({ connectionString: databaseUrl });
    for (const migration of [
      "001_eu10_authenticated_tenant_read.sql",
      "002_eu11_enrollment_entitlement_dispatch.sql",
    ]) {
      const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      await admin.query(sql);
    }
    await admin.query(
      `INSERT INTO tenants(id,slug,name) VALUES
       ($1,'eu11-a','EU11 Tenant A'),($2,'eu11-b','EU11 Tenant B')
       ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name`,
      [TENANT_A, TENANT_B],
    );
    await admin.query(
      `INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role,status)
       VALUES
       ($1,$6,'https://identity.example.test','a-admin','tenant_admin','active'),
       ($2,$6,'https://identity.example.test','a-user-1','user','active'),
       ($3,$6,'https://identity.example.test','a-user-2','user','active'),
       ($4,$6,'https://identity.example.test','a-user-3','user','active'),
       ($5,$7,'https://identity.example.test','b-admin','tenant_admin','active'),
       ($8,$7,'https://identity.example.test','b-user','user','active')`,
      [A_ADMIN, A_USER_1, A_USER_2, A_USER_3, B_ADMIN, TENANT_A, TENANT_B, B_USER],
    );
    controlPlane = new M5EnrollmentEntitlementControlPlane({
      databaseUrl,
      tokenPepper: randomBytes(32).toString("base64url"),
      rotationGraceMs: ROTATION_GRACE_MS,
      clock: () => nowMs,
      capabilities: [
        { name: "mech.inspect", module: "mech", summary: "Inspect mechanical model" },
        { name: "arch.inspect", module: "arch", summary: "Inspect architectural model" },
      ],
    });
    app = Fastify({ logger: false });
    mountM5BridgeEnrollmentEndpoint(app, controlPlane);
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await controlPlane?.close();
    await admin?.end();
    if (cluster !== undefined && databaseName !== undefined) {
      await cluster.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await cluster?.end();
  });

  async function enroll(
    actor: AuthContext,
    principalUserId: string,
    deviceId: string,
    fingerprint: GatewayMachineFingerprint,
  ): Promise<{ readonly enrollmentCode: string; readonly deviceToken: string }> {
    const minted = await controlPlane.mintEnrollmentCode(actor, {
      principalUserId,
      deviceId,
      machineFingerprint: fingerprint,
    });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    const response = await app.inject({
      method: "POST",
      url: M5_BRIDGE_ENROLLMENT_PATH,
      headers: { "content-type": "application/json" },
      payload: {
        enrollment_token: minted.value.enrollmentCode,
        machine_fingerprint: fingerprint,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{ device_id: string; device_token: string }>();
    expect(body.device_id).toBe(deviceId);
    return {
      enrollmentCode: minted.value.enrollmentCode,
      deviceToken: body.device_token,
    };
  }

  it("runs mint, exact Bridge exchange, handshake, atomic seat, filtered dispatch, rotation grace, and active revoke", async () => {
    await expect(
      controlPlane.mintEnrollmentCode(auth(TENANT_A, A_USER_1, "user"), {
        principalUserId: A_USER_1,
        deviceId: A_DEVICE_1,
        machineFingerprint: FINGERPRINT_A1,
      }),
    ).resolves.toEqual({ ok: false, reason: "admin_required" });
    const mechLicense = await controlPlane.grantModuleLicense(adminA, {
      module: "mech",
      seatLimit: 1,
    });
    expect(mechLicense.ok).toBe(true);
    const a1 = await enroll(adminA, A_USER_1, A_DEVICE_1, FINGERPRINT_A1);

    const reused = await app.inject({
      method: "POST",
      url: M5_BRIDGE_ENROLLMENT_PATH,
      headers: { "content-type": "application/json" },
      payload: {
        enrollment_token: a1.enrollmentCode,
        machine_fingerprint: FINGERPRINT_A1,
      },
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toEqual({
      ok: false,
      state: "refused",
      error: "enrollment_token_reused",
    });

    const malformed = await app.inject({
      method: "POST",
      url: M5_BRIDGE_ENROLLMENT_PATH,
      headers: { "content-type": "application/json" },
      payload:
        `{"enrollment_token":"${a1.enrollmentCode}",` +
        `"enrollment_\\u0074oken":"${a1.enrollmentCode}",` +
        `"machine_fingerprint":"${FINGERPRINT_A1}"}`,
    });
    expect(malformed.statusCode).toBe(400);

    const bridgeCalls: string[] = [];
    const closeEvents: string[] = [];
    const executor: M5BridgeExecutor = Object.freeze({
      async invoke(input: Parameters<M5BridgeExecutor["invoke"]>[0]) {
        bridgeCalls.push(`${input.invocationId}:${input.toolName}`);
        return Object.freeze({ bridge: "called", tool: input.toolName });
      },
    });
    const closeControl: M5BridgeCloseControl = Object.freeze({
      close(
        code: Parameters<M5BridgeCloseControl["close"]>[0],
        reason: Parameters<M5BridgeCloseControl["close"]>[1],
      ) {
        closeEvents.push(`${code}:${reason}`);
      },
    });
    const opened = await controlPlane.openBridgeConnection({
      deviceToken: a1.deviceToken,
      claimedTenantId: TENANT_A,
      claimedDeviceId: A_DEVICE_1,
      principalUserId: A_USER_1,
      machineFingerprint: FINGERPRINT_A1,
      connectionId: "eu11-a-primary",
      executor,
      closeControl,
    });
    expect(opened).toMatchObject({ ok: true, value: { usedPreviousCredential: false } });

    await expect(
      controlPlane.capabilityIndex({
        tenantId: TENANT_A,
        principalUserId: A_USER_1,
        deviceId: A_DEVICE_1,
      }),
    ).resolves.toEqual({ ok: true, value: [] });
    const seat = await controlPlane.assignSeat(adminA, {
      module: "mech",
      principalUserId: A_USER_1,
      deviceId: A_DEVICE_1,
    });
    expect(seat).toMatchObject({ ok: true, value: { module: "mech", replayed: false } });
    const index = await controlPlane.capabilityIndex({
      tenantId: TENANT_A,
      principalUserId: A_USER_1,
      deviceId: A_DEVICE_1,
    });
    expect(index).toEqual({
      ok: true,
      value: [{ name: "mech.inspect", module: "mech", summary: "Inspect mechanical model" }],
    });

    const dispatched = await controlPlane.dispatch({
      tenantId: TENANT_A,
      connectionId: "eu11-a-primary",
      principalUserId: A_USER_1,
      deviceId: A_DEVICE_1,
      invocationId: "eu11-invocation-1",
      toolName: "mech.inspect",
      params: { elementId: 42 },
    });
    expect(dispatched).toMatchObject({
      ok: true,
      value: { invocationId: "eu11-invocation-1", replayed: false },
    });
    const replayed = await controlPlane.dispatch({
      tenantId: TENANT_A,
      connectionId: "eu11-a-primary",
      principalUserId: A_USER_1,
      deviceId: A_DEVICE_1,
      invocationId: "eu11-invocation-1",
      toolName: "mech.inspect",
      params: { elementId: 42 },
    });
    expect(replayed).toMatchObject({ ok: true, value: { replayed: true } });
    expect(bridgeCalls).toEqual(["eu11-invocation-1:mech.inspect"]);

    const forged = await controlPlane.dispatch({
      tenantId: TENANT_A,
      connectionId: "eu11-a-primary",
      principalUserId: A_USER_1,
      deviceId: A_DEVICE_1,
      invocationId: "eu11-forged-arch",
      toolName: "arch.inspect",
      params: {},
    });
    expect(forged).toEqual({ ok: false, reason: "entitlement_denied" });
    expect(bridgeCalls).toHaveLength(1);

    const rotated = await controlPlane.rotateDeviceCredential(adminA, {
      deviceId: A_DEVICE_1,
    });
    if (!rotated.ok) throw new Error(`rotation failed: ${rotated.reason}`);
    const oldInsideGrace = await controlPlane.openBridgeConnection({
      deviceToken: a1.deviceToken,
      claimedTenantId: TENANT_A,
      claimedDeviceId: A_DEVICE_1,
      principalUserId: A_USER_1,
      machineFingerprint: FINGERPRINT_A1,
      connectionId: "eu11-a-old-grace",
      executor,
      closeControl,
    });
    expect(oldInsideGrace).toMatchObject({
      ok: true,
      value: { usedPreviousCredential: true },
    });
    nowMs = rotated.value.previousValidUntilMs + 1;
    const oldAfterGrace = await controlPlane.openBridgeConnection({
      deviceToken: a1.deviceToken,
      claimedTenantId: TENANT_A,
      claimedDeviceId: A_DEVICE_1,
      principalUserId: A_USER_1,
      machineFingerprint: FINGERPRINT_A1,
      connectionId: "eu11-a-old-expired",
      executor,
      closeControl,
    });
    expect(oldAfterGrace).toEqual({ ok: false, reason: "device_credential_denied" });
    const current = await controlPlane.openBridgeConnection({
      deviceToken: rotated.value.deviceToken,
      claimedTenantId: TENANT_A,
      claimedDeviceId: A_DEVICE_1,
      principalUserId: A_USER_1,
      machineFingerprint: FINGERPRINT_A1,
      connectionId: "eu11-a-current",
      executor,
      closeControl,
    });
    expect(current).toMatchObject({ ok: true, value: { credentialVersion: 2 } });

    const crossTenantHandshake = await controlPlane.openBridgeConnection({
      deviceToken: rotated.value.deviceToken,
      claimedTenantId: TENANT_B,
      claimedDeviceId: A_DEVICE_1,
      principalUserId: A_USER_1,
      machineFingerprint: FINGERPRINT_A1,
      connectionId: "eu11-cross-tenant",
      executor,
      closeControl,
    });
    expect(crossTenantHandshake).toEqual({ ok: false, reason: "tenant_binding_denied" });
    const crossPrincipalHandshake = await controlPlane.openBridgeConnection({
      deviceToken: rotated.value.deviceToken,
      claimedTenantId: TENANT_A,
      claimedDeviceId: A_DEVICE_1,
      principalUserId: B_USER,
      machineFingerprint: FINGERPRINT_A1,
      connectionId: "eu11-cross-principal",
      executor,
      closeControl,
    });
    expect(crossPrincipalHandshake).toEqual({
      ok: false,
      reason: "principal_binding_denied",
    });

    const b = await enroll(adminB, B_USER, B_DEVICE, FINGERPRINT_B);
    expect(b.deviceToken).toHaveLength(43);
    await expect(
      controlPlane.assignSeat(adminA, {
        module: "mech",
        principalUserId: B_USER,
        deviceId: B_DEVICE,
      }),
    ).resolves.toEqual({ ok: false, reason: "seat_binding_denied" });
    await expect(
      controlPlane.assignSeat(adminB, {
        module: "mech",
        principalUserId: A_USER_1,
        deviceId: A_DEVICE_1,
      }),
    ).resolves.toEqual({ ok: false, reason: "entitlement_denied" });

    const a2 = await enroll(adminA, A_USER_2, A_DEVICE_2, FINGERPRINT_A2);
    const a3 = await enroll(adminA, A_USER_3, A_DEVICE_3, FINGERPRINT_A3);
    expect(a2.deviceToken).not.toBe(a3.deviceToken);
    await expect(
      controlPlane.grantModuleLicense(adminA, { module: "arch", seatLimit: 1 }),
    ).resolves.toMatchObject({ ok: true });
    const competing = await Promise.all([
      controlPlane.assignSeat(adminA, {
        module: "arch",
        principalUserId: A_USER_2,
        deviceId: A_DEVICE_2,
      }),
      controlPlane.assignSeat(adminA, {
        module: "arch",
        principalUserId: A_USER_3,
        deviceId: A_DEVICE_3,
      }),
    ]);
    expect(competing.filter((result) => result.ok)).toHaveLength(1);
    expect(
      competing.filter((result) => !result.ok).map((result) => result.reason),
    ).toEqual(["seat_cap_exceeded"]);

    const revoked = await controlPlane.revokeDevice(adminA, { deviceId: A_DEVICE_1 });
    expect(revoked).toMatchObject({
      ok: true,
      value: {
        changed: true,
        closedConnectionCount: 3,
        withinBound: true,
      },
    });
    if (revoked.ok) {
      expect(revoked.value.maximumCloseLatencyMs).toBeLessThanOrEqual(
        M5_ACTIVE_REVOKE_BOUND_MS,
      );
    }
    expect(closeEvents).toHaveLength(3);
    const afterRevoke = await controlPlane.openBridgeConnection({
      deviceToken: rotated.value.deviceToken,
      claimedTenantId: TENANT_A,
      claimedDeviceId: A_DEVICE_1,
      principalUserId: A_USER_1,
      machineFingerprint: FINGERPRINT_A1,
      connectionId: "eu11-a-after-revoke",
      executor,
      closeControl,
    });
    expect(afterRevoke).toEqual({ ok: false, reason: "device_revoked" });

    const audit = await admin.query<{
      event_type: string;
      outcome: string;
      reason: string | null;
      details: unknown;
    }>(
      `SELECT event_type,outcome,reason,details FROM security_events
       WHERE tenant_id=$1 ORDER BY occurred_at,id`,
      [TENANT_A],
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "bridge.dispatch",
          outcome: "denied",
          reason: "entitlement_denied",
        }),
        expect.objectContaining({ event_type: "device_credential.rotate", outcome: "completed" }),
        expect.objectContaining({ event_type: "device.revoke", outcome: "completed" }),
      ]),
    );
    const persistence = await admin.query(
      `SELECT code_digest::text AS digest FROM enrollment_codes
       UNION ALL SELECT current_token_digest::text FROM device_credentials
       UNION ALL SELECT previous_token_digest::text FROM device_credentials
         WHERE previous_token_digest IS NOT NULL`,
    );
    expect(persistence.rows.every((row) => /^[0-9a-f]{64}$/u.test(String(row.digest))))
      .toBe(true);
    const persistedText = JSON.stringify({ persistence: persistence.rows, audit: audit.rows });
    expect(
      [
        a1.enrollmentCode,
        a1.deviceToken,
        rotated.value.deviceToken,
        b.deviceToken,
        a2.deviceToken,
        a3.deviceToken,
      ].some((secret) => persistedText.includes(secret)),
    ).toBe(false);
  }, 60_000);

  it("enforces tenant RLS and isolates the digest locator role", async () => {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT_A]);
      const hidden = await client.query(
        "SELECT id FROM enrollment_codes WHERE tenant_id=$1",
        [TENANT_B],
      );
      expect(hidden.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO security_events(
             id,tenant_id,event_type,outcome,details,occurred_at)
           VALUES ('90000000-0000-4000-8000-000000000001',$1,'forbidden','denied','{}',clock_timestamp())`,
          [TENANT_B],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await expect(client.query("SELECT token_digest FROM credential_scopes"))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_credential_locator");
      const locators = await client.query("SELECT token_digest FROM credential_scopes");
      expect(locators.rowCount).toBeGreaterThan(0);
      await expect(client.query("SELECT id FROM users"))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
