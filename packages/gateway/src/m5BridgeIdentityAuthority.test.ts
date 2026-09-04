import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AddinLoopbackFixture } from "../../addin-loopback-fixture/dist/index.js";
import {
  ArtifactSpool,
  BridgeSimulator,
  DeterministicUuid7Source,
  DurableBridgeJournal,
  HttpSseGatewayBinding,
  discoverAddinSessions,
  type GatewayBinding,
} from "../../bridge-simulator/dist/index.js";
import {
  makeParamsDigest,
  type HelloEnvelope,
  type InvokeEnvelope,
  type RbpEnvelope,
  type SessionRegisteredEnvelope,
} from "@revagent/protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
  type GatewayMachineFingerprint,
  type IdentityPort,
} from "./authContext.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import type { GatewayExecutorRequest, GatewayJsonObject } from "./dispatch.js";
import { gatewayUuidV7 } from "./identifiers.js";
import { createEffectiveMcpRequestScopeV1 } from "./invocationContext.js";
import { createM5BridgeIdentityAuthority } from "./m5BridgeIdentityAuthority.js";
import { M5EnrollmentEntitlementControlPlane } from "./m5EnrollmentEntitlement.js";
import {
  M5_BRIDGE_ENROLLMENT_PATH,
} from "./m5EnrollmentEntitlementEndpoint.js";
import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import { createProductionRbpIngressHost } from "./rbpIngress.js";
import {
  createFailClosedPorts,
  startGatewayServer,
  type GatewayServerHandle,
} from "./server.js";
import { createRestartableTestStore } from "./testAdapters.js";

const { Pool } = pg;

const CLUSTER_URL = process.env.EU11_DATABASE_URL ?? process.env.EU10_DATABASE_URL;
const suite = CLUSTER_URL === undefined ? describe.skip : describe.sequential;

const TENANT_A = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "20000000-0000-4000-8000-000000000002";
const A_ADMIN = "10000000-0000-4000-8000-000000000101";
const A_USER_1 = "10000000-0000-4000-8000-000000000111";
const B_USER = "20000000-0000-4000-8000-000000000211";
const A_DEVICE_1 = "10000000-0000-4000-8000-000000000311";
const B_DEVICE = "20000000-0000-4000-8000-000000000321";
const FINGERPRINT_A1 = `sha256:${"11".repeat(32)}` as GatewayMachineFingerprint;
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
      oauthClientId: "eu20-test-client",
    }),
    principalKey: `principal-${userId}`,
    issuedAtMs: 1_800_000_000_000,
    expiresAtMs: null,
  });
}

/**
 * A minimal, real `IdentityPort` (`kind: "oidc"`) for `authenticateNorthRequest`
 * only — exactly the dependency `M5BridgeIdentityAuthority` actually declares
 * for north-user auth (see its constructor). It is not a
 * `ProductionIdentityAuthority`: this composition has no device-decision
 * store of its own to wrap, which is EU-20-AUTH-INGRESS's outcome 4 held
 * structurally (there is nothing else a device decision could come from).
 */
function northIdentityStub(): IdentityPort & { readonly kind: "oidc" } {
  return Object.freeze({
    kind: "oidc" as const,
    async authenticateNorthRequest() {
      return Object.freeze({
        ok: false as const,
        port: "identity" as const,
        code: "unavailable" as const,
        message: "north identity test fixture has no credential",
      });
    },
    // `M5BridgeIdentityAuthority` never delegates device auth to this port
    // (only `authenticateNorthRequest`, per its constructor); this satisfies
    // the `IdentityPort` shape only and must never be reached.
    async authenticateDevice() {
      throw new Error("north identity stub's authenticateDevice must never be reached");
    },
  });
}

/**
 * Wraps `northIdentityStub()` so every call is recorded. Used to assert
 * outcome 4 directly: `authenticateNorthRequest` is a north-user (not
 * Bridge-device) concern, so Bridge ingress flows must never call it.
 */
function spiedNorthIdentity(calls: string[]): IdentityPort & { readonly kind: "oidc" } {
  const identity = northIdentityStub();
  return Object.freeze({
    kind: "oidc" as const,
    authenticateNorthRequest: (input: Parameters<IdentityPort["authenticateNorthRequest"]>[0]) => {
      calls.push("authenticateNorthRequest");
      return identity.authenticateNorthRequest(input);
    },
    authenticateDevice: (input: Parameters<IdentityPort["authenticateDevice"]>[0]) => {
      calls.push("authenticateDevice");
      return identity.authenticateDevice(input);
    },
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
  if (port <= 0) throw new Error("failed to reserve an EU-20 Gateway test port");
  return port;
}

suite("EU-20-AUTH-INGRESS: M5-bound production Bridge identity authority", () => {
  let cluster: pg.Pool;
  let admin: pg.Pool;
  let databaseUrl: string;
  let databaseName: string;
  let nowMs = 1_800_000_000_000;
  let controlPlane: M5EnrollmentEntitlementControlPlane;
  let gateway: GatewayServerHandle;
  let gatewayConfig: GatewayConfig;
  let enrollmentUrl: string;
  // Stable across the suite exactly like a real deployment's configured
  // secret: outcome 7 (restart persistence) reconnects with this same
  // pepper, simulating a fresh process reusing its durable configuration —
  // a freshly-*random* pepper per instance would never validate any
  // previously-issued digest, in production or in this test.
  const tokenPepper = randomBytes(32).toString("base64url");

  const adminA = auth(TENANT_A, A_ADMIN, "tenant_admin");

  beforeAll(async () => {
    const clusterUrl = new URL(CLUSTER_URL!);
    databaseName = `revagent_eu20_${process.pid}_${randomBytes(6).toString("hex")}`;
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
       ($1,'eu20-a','EU20 Tenant A'),($2,'eu20-b','EU20 Tenant B')
       ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name`,
      [TENANT_A, TENANT_B],
    );
    await admin.query(
      `INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role,status) VALUES
       ($1,$3,'https://identity.example.test','a-admin','tenant_admin','active'),
       ($2,$3,'https://identity.example.test','a-user-1','user','active'),
       ($4,$5,'https://identity.example.test','b-user','user','active')`,
      [A_ADMIN, A_USER_1, TENANT_A, B_USER, TENANT_B],
    );
    controlPlane = new M5EnrollmentEntitlementControlPlane({
      databaseUrl,
      tokenPepper,
      rotationGraceMs: ROTATION_GRACE_MS,
      clock: () => nowMs,
      capabilities: [
        { name: "mech.inspect", module: "mech", summary: "Inspect mechanical model" },
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
    if (!loaded.ok) throw new Error("EU-20 production Gateway config was refused");
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

  /** Outcomes 1+2: a real EU-11 enrollment code minted and exchanged over HTTP. */
  async function enroll(
    principalUserId: string,
    deviceId: string,
    fingerprint: GatewayMachineFingerprint,
  ): Promise<string> {
    const minted = await controlPlane.mintEnrollmentCode(adminA, {
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
    const body = (await response.json()) as { device_token: string };
    return body.device_token;
  }

  it("outcome 3+4: validates a real EU-11 credential exclusively against the M5 plane, never the unused base authority", async () => {
    const deviceToken = await enroll(A_USER_1, A_DEVICE_1, FINGERPRINT_A1);
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: northIdentityStub(),
      plane: controlPlane,
    });
    const result = await authority.authenticateDevice({
      deviceToken,
      connectionId: "conn-outcome-3",
      claimedDeviceId: A_DEVICE_1,
      machineFingerprint: FINGERPRINT_A1,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        actor: {
          type: "device",
          tenantId: TENANT_A,
          userId: A_USER_1,
          deviceId: A_DEVICE_1,
        },
        deviceStatus: "active",
      },
    });
  });

  it("outcome 9: fails closed on malformed, unknown, wrong-device, and foreign-tenant credentials", async () => {
    const deviceId = "10000000-0000-4000-8000-000000000316";
    const fingerprint = `sha256:${"66".repeat(32)}` as GatewayMachineFingerprint;
    const deviceToken = await enroll(A_USER_1, deviceId, fingerprint);
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: northIdentityStub(),
      plane: controlPlane,
    });
    // malformed: absent token
    await expect(
      authority.authenticateDevice({
        deviceToken: undefined,
        connectionId: "conn-malformed",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: false });
    // unknown token
    await expect(
      authority.authenticateDevice({
        deviceToken: "not-a-real-device-token-at-all-000000",
        connectionId: "conn-unknown",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: false });
    // wrong-device: real token, but hello claims a different device id
    await expect(
      authority.authenticateDevice({
        deviceToken,
        connectionId: "conn-wrong-device",
        claimedDeviceId: B_DEVICE,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: false });
    // foreign-tenant: valid device credential, but a reassert established a
    // different tenant than the credential actually resolves to
    await expect(
      authority.authenticateDevice({
        deviceToken,
        connectionId: "conn-foreign-tenant",
        claimedDeviceId: deviceId,
        establishedScope: { tenantId: TENANT_B, deviceId },
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: false });
    // wrong-principal is not a caller-suppliable claim in this design (the
    // principal is always *derived* from the credential, never asserted), so
    // there is no wire input that could make one device authenticate as a
    // different principal; this is verified structurally by outcome 3 above
    // always returning the true owning principal.
  });

  it("outcome 9: fails closed once the device is revoked", async () => {
    const deviceId = "10000000-0000-4000-8000-000000000312";
    const fingerprint = `sha256:${"22".repeat(32)}` as GatewayMachineFingerprint;
    const deviceToken = await enroll(A_USER_1, deviceId, fingerprint);
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: northIdentityStub(),
      plane: controlPlane,
    });
    await expect(
      authority.authenticateDevice({
        deviceToken,
        connectionId: "conn-before-revoke",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: true });
    const revoked = await controlPlane.revokeDevice(adminA, { deviceId });
    expect(revoked).toMatchObject({ ok: true, value: { changed: true } });
    await expect(
      authority.authenticateDevice({
        deviceToken,
        connectionId: "conn-after-revoke",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("outcome 8: honors rotation grace and rejects the old credential once the grace window elapses", async () => {
    const deviceId = "10000000-0000-4000-8000-000000000313";
    const fingerprint = `sha256:${"33".repeat(32)}` as GatewayMachineFingerprint;
    const oldToken = await enroll(A_USER_1, deviceId, fingerprint);
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: northIdentityStub(),
      plane: controlPlane,
    });
    const rotated = await controlPlane.rotateDeviceCredential(adminA, { deviceId });
    if (!rotated.ok) throw new Error(`rotation failed: ${rotated.reason}`);
    const newToken = rotated.value.deviceToken;

    await expect(
      authority.authenticateDevice({
        deviceToken: oldToken,
        connectionId: "conn-old-in-grace",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      authority.authenticateDevice({
        deviceToken: newToken,
        connectionId: "conn-new-in-grace",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: true });

    nowMs = rotated.value.previousValidUntilMs + 1;
    await expect(
      authority.authenticateDevice({
        deviceToken: oldToken,
        connectionId: "conn-old-after-grace",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      authority.authenticateDevice({
        deviceToken: newToken,
        connectionId: "conn-new-after-grace",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("outcome 7: restart persistence — a fresh control-plane instance against the same database still authenticates the credential", async () => {
    const deviceId = "10000000-0000-4000-8000-000000000314";
    const fingerprint = `sha256:${"44".repeat(32)}` as GatewayMachineFingerprint;
    const deviceToken = await enroll(A_USER_1, deviceId, fingerprint);

    // Simulates a Gateway process restart: a brand-new control-plane
    // instance and a brand-new adapter, sharing nothing in memory with the
    // one that minted/exchanged the credential above, connected to the same
    // durable Postgres database.
    const restarted = new M5EnrollmentEntitlementControlPlane({
      databaseUrl,
      tokenPepper,
      capabilities: [
        { name: "mech.inspect", module: "mech", summary: "Inspect mechanical model" },
      ],
    });
    try {
      const authority = createM5BridgeIdentityAuthority({
        northIdentity: northIdentityStub(),
        plane: restarted,
      });
      await expect(
        authority.authenticateDevice({
          deviceToken,
          connectionId: "conn-restart",
          claimedDeviceId: deviceId,
          machineFingerprint: fingerprint,
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: { actor: { tenantId: TENANT_A, deviceId } },
      });
    } finally {
      await restarted.close();
    }
  });

  it("outcome 5: an enrolled Bridge registers a production RBP session through the bound authority, and reasserts, and a revoke closes it", async () => {
    const deviceId = "10000000-0000-4000-8000-000000000315";
    const fingerprint = `sha256:${"55".repeat(32)}` as GatewayMachineFingerprint;
    const deviceToken = await enroll(A_USER_1, deviceId, fingerprint);

    // Outcome 4, asserted directly: the north-identity port is spied on and
    // must never be called for any step of establishing or reasserting this
    // Bridge (device) session — it is a north-user concern, and this
    // composition has no other store a device decision could come from.
    const baseCalls: string[] = [];
    const northIdentity = spiedNorthIdentity(baseCalls);
    const authority = createM5BridgeIdentityAuthority({ northIdentity, plane: controlPlane });

    const restartable = createRestartableTestStore();
    const session = new GatewayBridgeSessionAuthority(restartable.store, authority);
    await session.open();
    try {
      const sent: unknown[] = [];
      const opened = await session.openConnection({
        deviceToken,
        binding: "wss",
        hello: {
          type: "hello",
          id: "01900000-0000-7000-8000-000000000001",
          ts: new Date().toISOString(),
          payload: {
            min_protocol: 1,
            max_protocol: 1,
            capabilities: ["journal_v1"],
            bridge_version: "eu20-test",
            device_id: deviceId,
            machine: { hostname: "eu20-test-host", os: "windows", fingerprint },
            addin_versions: ["eu20-test"],
          },
        },
        channel: {
          async send(serialized) {
            sent.push(JSON.parse(serialized));
          },
          async close() {},
        },
      });
      expect(opened.connectionId).toEqual(expect.any(String));
      expect(opened.helloAck).toMatchObject({
        type: "hello_ack",
        payload: { connection_id: opened.connectionId },
      });
      const reasserted = await session.assertConnectionCredential(
        opened.connectionId,
        deviceToken,
      );
      expect(reasserted.auth.actor).toMatchObject({ tenantId: TENANT_A, deviceId });

      // Revoking through M5's own admin surface (never through `base`)
      // takes effect on the very next reassertion, fully through the bound
      // authority — outcome 9's "revoked... fail closed" at the RBP layer.
      const revoked = await controlPlane.revokeDevice(adminA, { deviceId });
      expect(revoked).toMatchObject({ ok: true, value: { changed: true } });
      await expect(
        session.assertConnectionCredential(opened.connectionId, deviceToken),
      ).rejects.toBeTruthy();

      expect(baseCalls).toEqual([]);
    } finally {
      await session.close();
    }
  });

  /**
   * Outcome 6. Reuses the exact production dispatch pipeline
   * (`GatewayBridgeSessionAuthority.createExecutor().execute`) and the exact
   * real, CI-exercised Node Bridge fixtures already used by this package's
   * own GW-16 suite (`AddinLoopbackFixture` from `packages/addin-loopback-fixture`,
   * `BridgeSimulator` from `packages/bridge-simulator`) — the "add-in
   * loopback fixture" the card names. The real dotnet C# Bridge trio
   * (`packages/rbp-conformance` real-trio tests) was not run in this pass:
   * that harness wires its own fixture identity
   * (`ConformanceCredentialAuthority` in `productionConformanceHostCli.ts`),
   * not this card's `IdentityPort`, and rewiring its identity composition is
   * outside this bounded adapter's scope. What ran here is the closest
   * existing CI-exercised fixture, stated exactly.
   */
  it("outcome 6: one entitled read-only dispatch completes through the production Gateway, the Bridge simulator, and the real add-in loopback fixture", async () => {
    const deviceId = "10000000-0000-4000-8000-000000000317";
    const fingerprint = `sha256:${"77".repeat(32)}` as GatewayMachineFingerprint;
    const deviceToken = await enroll(A_USER_1, deviceId, fingerprint);
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: northIdentityStub(),
      plane: controlPlane,
    });
    const restartable = createRestartableTestStore();
    const session = new GatewayBridgeSessionAuthority(restartable.store, authority);
    await session.open();
    const root = mkdtempSync(join(tmpdir(), "eu20-outcome6-"));
    const fixture = new AddinLoopbackFixture();
    let journal: DurableBridgeJournal | undefined;
    try {
      const sent: RbpEnvelope[] = [];
      const opened = await session.openConnection({
        deviceToken,
        binding: "wss",
        hello: {
          type: "hello",
          id: "01900000-0000-7000-8000-000000000002",
          ts: new Date().toISOString(),
          payload: {
            min_protocol: 1,
            max_protocol: 1,
            capabilities: ["journal_v1"],
            bridge_version: "eu20-test",
            device_id: deviceId,
            machine: { hostname: "eu20-test-host", os: "windows", fingerprint },
            addin_versions: ["eu20-test"],
          },
        } satisfies HelloEnvelope,
        channel: {
          async send(serialized) {
            sent.push(JSON.parse(serialized) as RbpEnvelope);
          },
          async close() {},
        },
      });

      await session.receive(opened.connectionId, {
        v: 1,
        type: "session_register",
        id: gatewayUuidV7(Date.now()),
        ts: new Date().toISOString(),
        payload: {
          local_session_key: "eu20-outcome6-local",
          user_hint: { name: "eu20-fixture" },
          machine: { hostname: "eu20-test-host", fingerprint },
          revit: { version: "2025", build: "eu20-fixture", pid: 2020 },
          addin_version: "eu20-test",
          result_contract_version: 1,
          session_capabilities: ["batch_atomic"],
          bridge_version: "eu20-test",
          documents: [],
          port: 48884,
        },
      });
      const registered = sent
        .slice()
        .reverse()
        .find((frame): frame is SessionRegisteredEnvelope => frame.type === "session_registered");
      if (registered === undefined) throw new Error("outcome 6: session did not register");
      const rsid = registered.payload.rsid;

      const invocationId = gatewayUuidV7(Date.now());
      const args: GatewayJsonObject = {};
      const effectiveMcpRequestScope = createEffectiveMcpRequestScopeV1({
        principalKey: `${TENANT_A}:${A_USER_1}`,
        transportMcpSessionId: "mcp-eu20-outcome6",
        identityMcpSessionId: null,
        nowMs: Date.now(),
      });
      const request: GatewayExecutorRequest = {
        toolName: "core.get_status",
        toolVersion: "1.0.0",
        executorMethod: "mcp_status",
        policyClass: "auto",
        mutationScopePolicy: "none",
        args,
        context: {
          invocationId,
          idempotencyKey: `${rsid}/${invocationId}`,
          principalKey: `${TENANT_A}:${A_USER_1}`,
          actor: { tenantId: TENANT_A, userId: A_USER_1, role: "user" },
          gatewaySessionId: "gateway-eu20-outcome6",
          oauthClientId: "oauth-eu20-outcome6",
          mcpSessionId: "mcp-eu20-outcome6",
          effectiveMcpRequestScope,
          rsid,
          toolName: "core.get_status",
          toolVersion: "1.0.0",
          policyClass: "auto",
          policyDecision: "auto",
          confirmationId: null,
          originatingPreviewInvocationId: null,
          mutationScopePolicy: "none",
          // Read-only: this is exactly the RBP dispatch pipeline's
          // non-mutating path (no atomic-batch/recovery machinery), the
          // right fit for outcome 6's "one entitled *read-only* dispatch".
          mutating: false,
          executor: "bridge",
          documentIdentity: { kind: "live", session_document_id: "eu20-outcome6-document" },
          paramsDigest: makeParamsDigest(args as unknown as Parameters<typeof makeParamsDigest>[0]),
          mutationScope: null,
          startedAtMs: Date.now(),
        },
      };
      const outcome = session.createExecutor().execute(request);

      const invoke = await (async (): Promise<Extract<RbpEnvelope, { type: "invoke" }>> => {
        for (let turn = 0; turn < 200; turn += 1) {
          const frame = sent.find(
            (candidate): candidate is Extract<RbpEnvelope, { type: "invoke" }> =>
              candidate.type === "invoke" && candidate.payload.invocation_id === invocationId,
          );
          if (frame !== undefined) return frame;
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("outcome 6: dispatch did not emit an invoke frame");
      })();

      // The real add-in loopback fixture + the real Bridge simulator answer
      // the exact invoke envelope the production Gateway just emitted.
      await fixture.start();
      const address = fixture.address ?? (await fixture.start());
      const discovery = await discoverAddinSessions({ explicitTarget: address });
      const probe = discovery.sessions[0];
      if (probe === undefined) throw new Error("outcome 6: add-in loopback fixture was not discovered");
      journal = new DurableBridgeJournal(join(root, "bridge.db"));
      const ids = new DeterministicUuid7Source();
      const simulator = new BridgeSimulator(journal, new ArtifactSpool(join(root, "spool"), () => ids.next()));
      const bridgeRegistration = await simulator.registrationForProbe({
        probe,
        requestId: gatewayUuidV7(Date.now()),
        userHint: "eu20-outcome6-user",
        hostname: "eu20-outcome6-host",
        fingerprint: "eu20-outcome6-fingerprint",
        bridgeVersion: "bridge-simulator-eu20-test",
      });
      simulator.attachSession({
        rsid,
        resumeToken: "eu20-outcome6-resume-token",
        resumeExpiresAt: "2027-01-01T00:00:00.000Z",
        grantedSessionCapabilities: probe.sessionCapabilities,
        probe,
        registration: bridgeRegistration,
      });
      const bridgeOutcome = await simulator.invoke(invoke as unknown as InvokeEnvelope);
      if (bridgeOutcome.kind !== "result" || bridgeOutcome.status !== "completed") {
        throw new Error(`outcome 6: fixture did not complete the read-only invoke: ${JSON.stringify(bridgeOutcome)}`);
      }

      await session.receive(opened.connectionId, {
        v: 1,
        type: "result",
        id: gatewayUuidV7(Date.now()),
        rsid,
        seq: 1,
        ack: invoke.seq,
        ts: new Date().toISOString(),
        payload: {
          kind: "invocation",
          invocation_id: invocationId,
          status: "completed",
          replayed: false,
          result: bridgeOutcome.result ?? null,
          metrics: { execute_ms: 1, request_bytes: 1, response_bytes: 1, framing: "length-prefixed" },
        },
      });

      await expect(outcome).resolves.toMatchObject({ state: "completed" });
    } finally {
      await session.close();
      await fixture.stop();
      // The journal's native better-sqlite3 handle must be released before
      // the directory removal below can unlink its file on Windows.
      journal?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("outcome 9: authenticateDevice returns the plane-resolved principal and ignores an extraneous attacker-supplied principal field", async () => {
    const deviceId = "10000000-0000-4000-8000-000000000318";
    const fingerprint = `sha256:${"88".repeat(32)}` as GatewayMachineFingerprint;
    const deviceToken = await enroll(A_USER_1, deviceId, fingerprint);
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: northIdentityStub(),
      plane: controlPlane,
    });
    const result = await authority.authenticateDevice({
      deviceToken,
      connectionId: "conn-wrong-principal",
      claimedDeviceId: deviceId,
      machineFingerprint: fingerprint,
      // Structural argument for outcome 9's "wrong-principal" case: the
      // `IdentityPort.authenticateDevice` input has no principal/userId
      // field at all (the principal is always *derived* from the resolved
      // credential, never asserted by a caller), so this extraneous field
      // is not part of the typed contract. It is included here, cast
      // through `unknown`, to prove that even an attacker-supplied
      // out-of-contract `userId` on the raw input object is structurally
      // inert: the returned principal is exactly the one the credential
      // resolves to (A_USER_1's real enrolled id), never the injected one.
      ...({ userId: "attacker-supplied-principal-0000000000000001" } as unknown as object),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { actor: { userId: A_USER_1, deviceId } },
    });
    if (result.ok) {
      expect(result.value.actor.userId).not.toBe(
        "attacker-supplied-principal-0000000000000001",
      );
    }
  });

  it("outcome 9: fails closed on an expired (post-rotation-grace) credential", async () => {
    const deviceId = "10000000-0000-4000-8000-000000000319";
    const fingerprint = `sha256:${"99".repeat(32)}` as GatewayMachineFingerprint;
    const oldToken = await enroll(A_USER_1, deviceId, fingerprint);
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: northIdentityStub(),
      plane: controlPlane,
    });
    const rotated = await controlPlane.rotateDeviceCredential(adminA, { deviceId });
    if (!rotated.ok) throw new Error(`rotation failed: ${rotated.reason}`);
    // Past the rotation-grace boundary: the old credential is now expired,
    // not merely "wrong" — this is the dedicated expired-credential case
    // outcome 9 requires, distinct from outcome 8's grace-window coverage.
    nowMs = rotated.value.previousValidUntilMs + 1;
    await expect(
      authority.authenticateDevice({
        deviceToken: oldToken,
        connectionId: "conn-expired",
        claimedDeviceId: deviceId,
        machineFingerprint: fingerprint,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  /**
   * Outcomes 3+4+5 through the REAL production composition and the REAL
   * production RBP ingress transport (`createProductionRbpIngressHost`),
   * per the review's outcome-3+4 finding: it is not enough for
   * `createM5BridgeIdentityAuthority` to be exercised only by its own unit
   * tests — it must be proven wired into the same ingress a deployed
   * Gateway serves. `packages/gateway/src/main.ts` (the real container
   * entry point, `package.json`'s `"start": "node dist/main.js"`) now
   * composes exactly this via `productionM5IdentityComposition.ts`; these
   * tests drive the identical `GatewayBridgeSessionAuthority` +
   * `createProductionRbpIngressHost` composition `main.ts` builds
   * (`startProductionGatewayHost` itself is not reused because it
   * hard-refuses any non-"conformance" port, including identity, and is
   * WP-12's distinct conformance-only harness, not the production
   * entrypoint).
   */
  function productionLikeRbpConfig(): GatewayConfig {
    return {
      nodeEnv: "development",
      logLevel: "fatal",
      http: { bindHost: "127.0.0.1", port: 0 },
      publicUrl: "http://127.0.0.1",
      objectStore: { driver: "fs", root: null },
      credentialsPresent: { databaseUrl: true },
      ingress: { northMcpMountPath: "/mcp", rbpMountPrefix: "/bridge/v1" },
    };
  }

  it("outcome 3+4+5 (http_sse): a real enrolled Bridge authenticates through the production RBP ingress exclusively via M5, and the north identity is never called", async () => {
    const deviceId = "10000000-0000-4000-8000-00000000032b";
    const fingerprint = `sha256:${"bb".repeat(32)}` as GatewayMachineFingerprint;
    const deviceToken = await enroll(A_USER_1, deviceId, fingerprint);
    const northCalls: string[] = [];
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: spiedNorthIdentity(northCalls),
      plane: controlPlane,
    });
    const restartable = createRestartableTestStore();
    const bridgeSession = new GatewayBridgeSessionAuthority(restartable.store, authority);
    const ingress = createProductionRbpIngressHost({ authority: bridgeSession });
    const server = await startGatewayServer({
      config: productionLikeRbpConfig(),
      ports: {
        ...createFailClosedPorts(),
        identity: authority,
        protocolStore: restartable.store,
        rbpIngress: ingress,
      },
    });
    const binding: GatewayBinding = new HttpSseGatewayBinding({
      baseUrl: `http://127.0.0.1:${String(server.port)}/bridge/v1/http/connections`,
      deviceToken,
      endpointPolicy: "loopback_test_readiness",
    });
    try {
      const ack = await binding.open({
        type: "hello",
        id: gatewayUuidV7(Date.now()),
        ts: new Date().toISOString(),
        payload: {
          min_protocol: 1,
          max_protocol: 1,
          capabilities: ["journal_v1", "transport_streamable_http"],
          bridge_version: "eu20-production-composition-test",
          device_id: deviceId,
          machine: { hostname: "eu20-prod-host", os: "windows", fingerprint },
          addin_versions: ["eu20-production-composition-test"],
        } satisfies HelloEnvelope["payload"],
      });
      expect(ack.payload.connection_id).toBe(binding.connectionId);
      expect(northCalls).toEqual([]);
    } finally {
      await binding.close();
      await server.close();
    }
  });

  /**
   * WSS case, following `rbpIngress.test.ts`'s own real-`ws`-client pattern
   * exactly ("serializes two valid hello arrivals into one authenticate/open
   * claim", :744-797) rather than `WssGatewayBinding`: a raw `ws.WebSocket`
   * against the real, running production host, retained until `hello_ack`
   * arrives on its `message` event. That existing suite already proves
   * arbitrary async-identity latency over a real socket is tolerated
   * end-to-end; this drives the same real socket through the real M5 plane.
   */
  // Root-caused: `hello_ack` arrives on the client (auth+registration via M5
  // succeed); the failure was in `GatewayBridgeSessionAuthority`'s own
  // shutdown drain, which sent a best-effort "goodbye" to this already-
  // terminated client and, on that expected send failure, re-threw it as a
  // fatal `drainFailure` from `authority.close()` — independent of M5. Fixed
  // in `bridgeSession.ts`'s `#performClose` drain loop (see erratum); no
  // O1/wire or reconnect-behaviour change.
  it("outcome 3+4+5 (wss): a real enrolled Bridge authenticates through the production RBP ingress exclusively via M5, and the north identity is never called", async () => {
    const deviceId = "10000000-0000-4000-8000-00000000032a";
    const fingerprint = `sha256:${"aa".repeat(32)}` as GatewayMachineFingerprint;
    const deviceToken = await enroll(A_USER_1, deviceId, fingerprint);
    const northCalls: string[] = [];
    const authority = createM5BridgeIdentityAuthority({
      northIdentity: spiedNorthIdentity(northCalls),
      plane: controlPlane,
    });
    const restartable = createRestartableTestStore();
    const bridgeSession = new GatewayBridgeSessionAuthority(restartable.store, authority);
    const ingress = createProductionRbpIngressHost({ authority: bridgeSession });
    const server = await startGatewayServer({
      config: productionLikeRbpConfig(),
      ports: {
        ...createFailClosedPorts(),
        identity: authority,
        protocolStore: restartable.store,
        rbpIngress: ingress,
      },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${String(server.port)}/bridge/v1`, {
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "X-RBP-Versions": "1",
      },
    });
    const messages: RbpEnvelope[] = [];
    const diagnostics: string[] = [];
    socket.on("message", (raw) => {
      diagnostics.push(`message:${raw.toString().slice(0, 200)}`);
      messages.push(JSON.parse(raw.toString()) as RbpEnvelope);
    });
    socket.on("close", (code, reason) => {
      diagnostics.push(`close:${String(code)}:${reason.toString("utf8")}`);
    });
    socket.on("error", (error) => {
      diagnostics.push(`error:${String(error)}`);
    });
    socket.on("unexpected-response", (_req, res) => {
      diagnostics.push(`unexpected-response:${String(res.statusCode)}`);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      let helloAck: Extract<RbpEnvelope, { type: "hello_ack" }>;
      try {
        helloAck = await new Promise<Extract<RbpEnvelope, { type: "hello_ack" }>>(
          (resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("outcome 3+4+5 (wss): no hello_ack within 10s")),
              10_000,
            );
            const onMessage = (): void => {
              const found = messages.find(
                (frame): frame is Extract<RbpEnvelope, { type: "hello_ack" }> =>
                  frame.type === "hello_ack",
              );
              if (found !== undefined) {
                clearTimeout(timeout);
                socket.off("message", onMessage);
                resolve(found);
              }
            };
            socket.on("message", onMessage);
            const hello: HelloEnvelope = {
              type: "hello",
              id: gatewayUuidV7(Date.now()),
              ts: new Date().toISOString(),
              payload: {
                min_protocol: 1,
                max_protocol: 1,
                capabilities: ["journal_v1"],
                bridge_version: "eu20-production-composition-test",
                device_id: deviceId,
                machine: { hostname: "eu20-prod-host", os: "windows", fingerprint },
                addin_versions: ["eu20-production-composition-test"],
              },
            };
            socket.send(JSON.stringify(hello));
          },
        );
      } catch (error) {
        throw new Error(
          `outcome 3+4+5 (wss) diagnostic failure: ${String(error)}; events=${JSON.stringify(diagnostics)}`,
        );
      }
      expect(helloAck.payload.connection_id).toEqual(expect.any(String));
      expect(northCalls).toEqual([]);
    } finally {
      // The client socket is terminated first, then the server is closed
      // separately below: `authority.close()`'s shutdown drain now sends its
      // best-effort "goodbye" to this already-terminated connection without
      // that expected send failure becoming a fatal `drainFailure` (see the
      // `bridgeSession.ts` `#performClose` fix).
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    await server.close();
  });
});
