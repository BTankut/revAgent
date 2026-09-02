import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";

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
  M5_BRIDGE_ENROLLMENT_MAX_BODY_BYTES,
  M5_BRIDGE_ENROLLMENT_PATH,
} from "./m5EnrollmentEntitlementEndpoint.js";
import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import {
  GatewayM5CompositionError,
  createFailClosedPorts,
  createGatewayApp,
  startGatewayServer,
  type GatewayServerHandle,
} from "./server.js";

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
const A_DEVICE_4 = "10000000-0000-4000-8000-000000000314";
const A_DEVICE_5 = "10000000-0000-4000-8000-000000000315";
const B_DEVICE = "20000000-0000-4000-8000-000000000321";
const FINGERPRINT_A1 = `sha256:${"11".repeat(32)}` as GatewayMachineFingerprint;
const FINGERPRINT_A2 = `sha256:${"12".repeat(32)}` as GatewayMachineFingerprint;
const FINGERPRINT_A3 = `sha256:${"13".repeat(32)}` as GatewayMachineFingerprint;
const FINGERPRINT_A4 = `sha256:${"14".repeat(32)}` as GatewayMachineFingerprint;
const FINGERPRINT_A5 = `sha256:${"15".repeat(32)}` as GatewayMachineFingerprint;
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

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  if (port <= 0) throw new Error("failed to reserve an EU-11 Gateway test port");
  return port;
}

suite("EU-11 enrolled and entitled Bridge dispatch", () => {
  let cluster: pg.Pool;
  let admin: pg.Pool;
  let gateway: GatewayServerHandle;
  let gatewayConfig: GatewayConfig;
  let enrollmentUrl: string;
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
    const port = await reserveLoopbackPort();
    const loaded = loadGatewayConfig({
      NODE_ENV: "production",
      LOG_LEVEL: "fatal",
      GATEWAY_BIND_HOST: "0.0.0.0",
      PORT: String(port),
      GATEWAY_PUBLIC_URL: "https://gateway.example.test",
    });
    if (!loaded.ok) throw new Error("EU-11 production Gateway config was refused");
    gatewayConfig = loaded.value;
    gateway = await startGatewayServer({
      config: gatewayConfig,
      ports: createFailClosedPorts(),
      m5EnrollmentEntitlement: controlPlane,
    });
    enrollmentUrl = `http://127.0.0.1:${String(gateway.port)}${M5_BRIDGE_ENROLLMENT_PATH}`;
  }, 30_000);

  afterAll(async () => {
    await gateway?.close();
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
    const response = await fetch(enrollmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_token: minted.value.enrollmentCode,
        machine_fingerprint: fingerprint,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      device_id: string;
      device_token: string;
    };
    expect(body.device_id).toBe(deviceId);
    return {
      enrollmentCode: minted.value.enrollmentCode,
      deviceToken: body.device_token,
    };
  }

  it("mounts the exact control plane on the production Gateway route and refuses a structural fake", async () => {
    const health = await fetch(`http://127.0.0.1:${String(gateway.port)}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(() =>
      createGatewayApp({
        config: gatewayConfig,
        ports: createFailClosedPorts(),
        m5EnrollmentEntitlement: Object.freeze({}) as unknown as
          M5EnrollmentEntitlementControlPlane,
      }),
    ).toThrowError(GatewayM5CompositionError);
  });

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
    const oversizedIssue = await controlPlane.mintEnrollmentCode(adminA, {
      principalUserId: A_USER_2,
      deviceId: A_DEVICE_4,
      machineFingerprint: FINGERPRINT_A4,
    });
    if (!oversizedIssue.ok) {
      throw new Error(`oversized-body enrollment mint failed: ${oversizedIssue.reason}`);
    }
    const oversized = await fetch(enrollmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_token: oversizedIssue.value.enrollmentCode,
        machine_fingerprint: FINGERPRINT_A4,
        padding: "x".repeat(M5_BRIDGE_ENROLLMENT_MAX_BODY_BYTES),
      }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("cache-control")).toBe("no-store");
    expect(await oversized.json()).toEqual({
      ok: false,
      state: "refused",
      error: "invalid_enrollment_request",
    });
    const stillIssued = await admin.query(
      "SELECT status FROM enrollment_codes WHERE id=$1",
      [oversizedIssue.value.enrollmentId],
    );
    expect(stillIssued.rows[0]?.status).toBe("issued");
    const oversizedExchange = await fetch(enrollmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_token: oversizedIssue.value.enrollmentCode,
        machine_fingerprint: FINGERPRINT_A4,
      }),
    });
    expect(oversizedExchange.status).toBe(200);
    const oversizedCredential = (await oversizedExchange.json()) as {
      device_token: string;
    };
    const a1 = await enroll(adminA, A_USER_1, A_DEVICE_1, FINGERPRINT_A1);

    const reused = await fetch(enrollmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_token: a1.enrollmentCode,
        machine_fingerprint: FINGERPRINT_A1,
      }),
    });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({
      ok: false,
      state: "refused",
      error: "enrollment_token_reused",
    });

    const malformed = await fetch(enrollmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body:
        `{"enrollment_token":"${a1.enrollmentCode}",` +
        `"enrollment_\\u0074oken":"${a1.enrollmentCode}",` +
        `"machine_fingerprint":"${FINGERPRINT_A1}"}`,
    });
    expect(malformed.status).toBe(400);

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

    let markDispatchEntered: (() => void) | undefined;
    const dispatchEntered = new Promise<void>((resolve) => {
      markDispatchEntered = resolve;
    });
    const inFlightExecutor: M5BridgeExecutor = Object.freeze({
      async invoke(input: Parameters<M5BridgeExecutor["invoke"]>[0]) {
        markDispatchEntered?.();
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => reject(new Error("device revoked"));
          if (input.signal.aborted) abort();
          else input.signal.addEventListener("abort", abort, { once: true });
        });
        return Object.freeze({ unreachable: true });
      },
    });
    const isolatedCloseAttempts: string[] = [];
    const failingClose: M5BridgeCloseControl = Object.freeze({
      close() {
        isolatedCloseAttempts.push("failing");
        throw new Error("simulated close failure");
      },
    });
    const trailingClose: M5BridgeCloseControl = Object.freeze({
      close() {
        isolatedCloseAttempts.push("trailing");
      },
    });
    await expect(
      controlPlane.openBridgeConnection({
        deviceToken: rotated.value.deviceToken,
        claimedTenantId: TENANT_A,
        claimedDeviceId: A_DEVICE_1,
        principalUserId: A_USER_1,
        machineFingerprint: FINGERPRINT_A1,
        connectionId: "eu11-a-inflight-failing-close",
        executor: inFlightExecutor,
        closeControl: failingClose,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      controlPlane.openBridgeConnection({
        deviceToken: rotated.value.deviceToken,
        claimedTenantId: TENANT_A,
        claimedDeviceId: A_DEVICE_1,
        principalUserId: A_USER_1,
        machineFingerprint: FINGERPRINT_A1,
        connectionId: "eu11-a-trailing-close",
        executor,
        closeControl: trailingClose,
      }),
    ).resolves.toMatchObject({ ok: true });
    const inFlightDispatch = controlPlane.dispatch({
      tenantId: TENANT_A,
      connectionId: "eu11-a-inflight-failing-close",
      principalUserId: A_USER_1,
      deviceId: A_DEVICE_1,
      invocationId: "eu11-inflight-revoke",
      toolName: "mech.inspect",
      params: { elementId: 84 },
    });
    await dispatchEntered;
    const revoked = await controlPlane.revokeDevice(adminA, { deviceId: A_DEVICE_1 });
    expect(revoked).toMatchObject({
      ok: true,
      value: {
        changed: true,
        closeAttemptCount: 5,
        closedConnectionCount: 4,
        closeFailureCount: 1,
        withinBound: true,
      },
    });
    if (revoked.ok) {
      expect(revoked.value.maximumCloseLatencyMs).toBeLessThanOrEqual(
        M5_ACTIVE_REVOKE_BOUND_MS,
      );
      expect(revoked.value.totalCloseElapsedMs).toBeLessThanOrEqual(
        M5_ACTIVE_REVOKE_BOUND_MS,
      );
    }
    await expect(inFlightDispatch).resolves.toEqual({
      ok: false,
      reason: "device_revoked",
    });
    expect(closeEvents).toHaveLength(3);
    expect(isolatedCloseAttempts).toEqual(["failing", "trailing"]);
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
        expect.objectContaining({
          event_type: "device.revoke_connections",
          outcome: "failed",
          reason: "connection_close_failed",
        }),
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
        oversizedCredential.device_token,
        b.deviceToken,
        a2.deviceToken,
        a3.deviceToken,
      ].some((secret) => persistedText.includes(secret)),
    ).toBe(false);

    const drainIssue = await controlPlane.mintEnrollmentCode(adminA, {
      principalUserId: A_USER_3,
      deviceId: A_DEVICE_5,
      machineFingerprint: FINGERPRINT_A5,
    });
    if (!drainIssue.ok) throw new Error(`drain enrollment mint failed: ${drainIssue.reason}`);
    gateway.beginShutdown();
    const draining = await fetch(enrollmentUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enrollment_token: drainIssue.value.enrollmentCode,
        machine_fingerprint: FINGERPRINT_A5,
      }),
    });
    expect(draining.status).toBe(503);
    expect(draining.headers.get("cache-control")).toBe("no-store");
    expect(await draining.json()).toEqual({
      ok: false,
      state: "unavailable",
      error: "enrollment_exchange_unavailable",
    });
    const drainCode = await admin.query(
      "SELECT status FROM enrollment_codes WHERE id=$1",
      [drainIssue.value.enrollmentId],
    );
    expect(drainCode.rows[0]?.status).toBe("issued");
    const health = await fetch(`http://127.0.0.1:${String(gateway.port)}/healthz`);
    expect(health.status).toBe(503);
  }, 60_000);

  it("enforces tenant RLS, immutable audit, composite license binding, and locator isolation", async () => {
    const auditPrivileges = await admin.query<{
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
    }>(
      `SELECT
         has_table_privilege('revagent_app','security_events','INSERT') AS can_insert,
         has_table_privilege('revagent_app','security_events','UPDATE') AS can_update,
         has_table_privilege('revagent_app','security_events','DELETE') AS can_delete,
         has_table_privilege('revagent_app','security_events','TRUNCATE') AS can_truncate`,
    );
    expect(auditPrivileges.rows[0]).toEqual({
      can_insert: true,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    });
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

      for (const statement of [
        "UPDATE security_events SET reason='tampered' WHERE tenant_id=$1",
        "DELETE FROM security_events WHERE tenant_id=$1",
      ]) {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE revagent_app");
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT_A]);
        await expect(client.query(statement, [TENANT_A])).rejects.toMatchObject({
          code: "42501",
        });
        await client.query("ROLLBACK");
      }

      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [TENANT_A]);
      const mech = await client.query<{ id: string }>(
        "SELECT id FROM module_licenses WHERE module_name='mech'",
      );
      await expect(
        client.query(
          `INSERT INTO seat_assignments(
             id,tenant_id,license_id,module_name,user_id,device_id,assigned_at)
           VALUES ('90000000-0000-4000-8000-000000000002',$1,$2,'elec',$3,$4,clock_timestamp())`,
          [TENANT_A, mech.rows[0]?.id, A_USER_1, A_DEVICE_1],
        ),
      ).rejects.toMatchObject({ code: "23503" });
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
