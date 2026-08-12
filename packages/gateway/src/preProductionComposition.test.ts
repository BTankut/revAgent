import type { IncomingMessage } from "node:http";
import { HttpSseGatewayBinding } from "../../bridge-simulator/dist/index.js";
import type { HelloEnvelope } from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import { GATEWAY_AUTH_CONTRACT_VERSION } from "./authContext.js";
import { GatewayDispatcher } from "./dispatch.js";
import { loadGatewayConfig } from "./config.js";
import {
  createPreProductionLanTestComposition,
  type PreProductionCompositionError,
  type PreProductionLanTestCompositionOptions,
} from "./preProductionComposition.js";
import { GatewayToolRegistry } from "./registry.js";
import { createFailClosedPorts, startGatewayServer } from "./server.js";
import {
  createCapturingEventSink,
  createReadOnlyRecoveryAuthorityFixture,
  createRestartableTestStore,
} from "./testAdapters.js";

const NOW_MS = 1_800_000_000_000;
const NORTH_TOKEN = "m4-02-north-token-00000000000000000001";
const TOKEN_KEY = "m4-02-token-key-000000000000000000000001";
const MACHINE_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function config(nodeEnv: "test" | "production" = "test") {
  return loadGatewayConfig(
    nodeEnv === "production"
      ? {
          NODE_ENV: "production",
          LOG_LEVEL: "fatal",
          GATEWAY_BIND_HOST: "0.0.0.0",
          GATEWAY_PUBLIC_URL: "https://gateway.lan.test",
        }
      : {
          NODE_ENV: "test",
          LOG_LEVEL: "fatal",
          GATEWAY_BIND_HOST: "127.0.0.1",
          GATEWAY_PUBLIC_URL: "https://gateway.lan.test",
        },
  );
}

function options(
  overrides: Partial<PreProductionLanTestCompositionOptions> = {},
): PreProductionLanTestCompositionOptions {
  const loaded = config();
  if (!loaded.ok) throw new Error("test Gateway configuration must be valid");
  const basePorts = createFailClosedPorts();
  const registry = new GatewayToolRegistry([]);
  const events = createCapturingEventSink();
  const dispatcher = new GatewayDispatcher(registry, [], {
    eventSink: events,
    eventSource: {
      component: "gateway-m4-02-test",
      version: "0.0.0-test",
      instance: "m4-02-test",
    },
    recoveryAuthority: createReadOnlyRecoveryAuthorityFixture(),
  });
  return {
    profile: "lan_test",
    mode: "preproduction",
    config: loaded,
    identityOptions: {
      tokenKey: TOKEN_KEY,
      clock: () => NOW_MS,
      northIdentities: [
        {
          authorization: `Bearer ${NORTH_TOKEN}`,
          context: {
            contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
            actor: {
              type: "user",
              tenantId: "tenant-m4-02",
              userId: "user-m4-02",
              role: "user",
              oidcIssuer: "https://issuer.invalid/m4-02",
              oidcSubject: "subject-m4-02",
            },
            session: {
              sessionId: "session-m4-02",
              clientType: "mcp",
              mcpSessionId: null,
              oauthClientId: "client-m4-02",
            },
            principalKey: "tenant-m4-02:user-m4-02",
            issuedAtMs: NOW_MS - 1_000,
            expiresAtMs: NOW_MS + 60_000,
          },
        },
      ],
    },
    protocolStore: createRestartableTestStore().store,
    entitlement: basePorts.entitlement,
    events,
    objectStore: basePorts.objectStore,
    guardrails: basePorts.guardrails,
    northAuth: {
      scopes: ["mcp:tools", "mcp:resources"],
      resource: new URL("https://gateway.lan.test/mcp"),
    },
    northMcp: {
      catalogViewFor: () => null,
      invocationRouteFor: () => {
        throw new Error("not reached by composition tests");
      },
      dispatcher,
      registry,
      requestState: { key: "m4-02-request-state-key-0000000000000001" },
      resourceMetadataUrl: new URL(
        "https://gateway.lan.test/.well-known/oauth-protected-resource/mcp",
      ),
    },
    ...overrides,
  };
}

function request(authorization: string): IncomingMessage {
  return { headers: { authorization } } as IncomingMessage;
}

describe("M4-02 pre-production LAN/test composition", () => {
  it("refuses invalid or production Gateway configuration before store/ingress side effects", () => {
    expect(() =>
      createPreProductionLanTestComposition(
        options({ profile: "not-lan" as "lan_test" }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_profile" }) as
        PreProductionCompositionError,
    );
    expect(() =>
      createPreProductionLanTestComposition(
        options({ mode: "production" as "preproduction" }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_mode" }) as
        PreProductionCompositionError,
    );

    const invalid = loadGatewayConfig({ NODE_ENV: "test", PORT: "not-a-port" });
    expect(() =>
      createPreProductionLanTestComposition(options({ config: invalid })),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_gateway_configuration",
      }) as PreProductionCompositionError,
    );

    expect(() =>
      createPreProductionLanTestComposition(
        options({ protocolStore: createFailClosedPorts().protocolStore }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "unavailable_protocol_store" }) as
        PreProductionCompositionError,
    );

    const production = config("production");
    expect(() =>
      createPreProductionLanTestComposition(
        options({
          config: production,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "production_mode_refused" }) as
        PreProductionCompositionError,
    );
  });

  it("binds one identity reference through north, ports, Bridge, ingress and store", () => {
    const composition = createPreProductionLanTestComposition(options());

    expect(composition.profile).toBe("lan_test");
    expect(composition.mode).toBe("preproduction");
    expect(composition.ports.identity).toBe(composition.identity);
    expect(composition.northAuthenticator.identity).toBe(composition.identity);
    expect(composition.northMcp.authenticator).toBe(
      composition.northAuthenticator,
    );
    expect(composition.bridgeAuthority.identity).toBe(composition.identity);
    expect(composition.rbpIngress.authority).toBe(
      composition.bridgeAuthority,
    );
    expect(composition.ports.rbpIngress).toBe(composition.rbpIngress);
    expect(composition.ports.protocolStore).toBe(
      composition.bridgeAuthority.store,
    );
    expect(composition.rbpIngress.kind).toBe("preproduction");
  });

  it("refuses mixed pre-production authority graphs before ingress or listener side effects", async () => {
    const first = createPreProductionLanTestComposition(options());
    const second = createPreProductionLanTestComposition(options());
    let ingressStarted = false;
    const mixedPorts = {
      ...first.ports,
      rbpIngress: {
        ...first.rbpIngress,
        async start(): Promise<void> {
          ingressStarted = true;
        },
      },
    };

    await expect(
      startGatewayServer({
        config: first.config,
        ports: mixedPorts,
        northMcp: second.northMcp,
      }),
    ).rejects.toMatchObject({
      name: "GatewayCompositionError",
      reason: "authority_graph_mismatch",
    });
    expect(ingressStarted).toBe(false);
  });

  it("projects validated north identity without a second credential path", async () => {
    const composition = createPreProductionLanTestComposition(options());
    const accepted = await composition.northAuthenticator.authenticate(
      request(`Bearer ${NORTH_TOKEN}`),
    );

    expect(accepted).not.toBeNull();
    expect(accepted?.authInfo).toMatchObject({
      token: NORTH_TOKEN,
      clientId: "client-m4-02",
      scopes: ["mcp:tools", "mcp:resources"],
      expiresAt: Math.floor((NOW_MS + 60_000) / 1_000),
    });
    expect(accepted?.authInfo.resource?.href).toBe(
      "https://gateway.lan.test/mcp",
    );
    expect(accepted?.authInfo).not.toHaveProperty("extra");
    expect(Object.isFrozen(accepted?.authInfo.scopes)).toBe(true);
    const identityResult = await composition.identity.authenticateNorthRequest({
      authorization: `Bearer ${NORTH_TOKEN}`,
    });
    expect(identityResult.ok).toBe(true);
    if (!identityResult.ok) return;
    expect(accepted?.authContext).toBe(identityResult.value);
    await expect(
      composition.northAuthenticator.authenticate(
        request("Bearer m4-02-unknown-token-000000000000000001"),
      ),
    ).resolves.toBeNull();
  });

  it("keeps raw token and callback/reporter failures out of observable surfaces", async () => {
    const sentinel = "m4-02-SENTINEL-secret-000000000000000001";
    const base = options();
    if (!base.config.ok) throw new Error("test config must be valid");
    const reports: unknown[] = [];
    let reportAttempt = 0;
    let callbackContext: unknown;
    const localConfig = loadGatewayConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      GATEWAY_BIND_HOST: "127.0.0.1",
      GATEWAY_PUBLIC_URL: "https://127.0.0.1",
    });
    if (!localConfig.ok) throw new Error("local test config must be valid");
    const composition = createPreProductionLanTestComposition({
      ...base,
      config: {
        ok: true,
        value: {
          ...localConfig.value,
          http: { bindHost: "127.0.0.1", port: 0 },
        },
      },
      identityOptions: {
        ...base.identityOptions,
        northIdentities: [
          {
            authorization: `Bearer ${sentinel}`,
            context: base.identityOptions.northIdentities[0]!.context,
          },
        ],
      },
      northAuth: {
        ...base.northAuth,
        resource: new URL("https://127.0.0.1/mcp"),
      },
      northMcp: {
        ...base.northMcp,
        catalogViewFor(context) {
          callbackContext = context;
          throw new Error(sentinel);
        },
        reportError(report) {
          reports.push(report);
          reportAttempt += 1;
          if (reportAttempt === 1) {
            throw new Error(`${sentinel}-sync-reporter`);
          }
          return Promise.reject(new Error(`${sentinel}-async-reporter`));
        },
      },
    });
    const server = await startGatewayServer({
      config: composition.config,
      ports: composition.ports,
      northMcp: composition.northMcp,
    });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetch(`${server.url}/mcp`, {
          method: "GET",
          headers: { authorization: `Bearer ${sentinel}` },
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          error: "north_mcp_request_failed",
        });
      }
      expect(callbackContext).toMatchObject({
        authInfo: {
          clientId: "client-m4-02",
          scopes: ["mcp:tools", "mcp:resources"],
        },
      });
      expect(callbackContext).not.toHaveProperty("authInfo.token");
      expect(callbackContext).not.toHaveProperty("authInfo.extra");
      expect(reports).toEqual(
        Array.from({ length: 2 }, () => ({
          event: "gateway.north_mcp.error",
          code: "request_failed",
        })),
      );
      expect(JSON.stringify({ callbackContext, reports })).not.toContain(
        sentinel,
      );
    } finally {
      await server.close();
    }
  });

  it("accepts then revokes a device through the real HTTP/SSE ingress", async () => {
    const baseOptions = options();
    if (!baseOptions.config.ok) throw new Error("test config must be valid");
    const composition = createPreProductionLanTestComposition({
      ...baseOptions,
      config: {
        ok: true,
        value: {
          ...baseOptions.config.value,
          http: { bindHost: "127.0.0.1", port: 0 },
        },
      },
    });
    const issue = composition.identity.issueEnrollmentToken({
      enrollmentId: "enrollment-m4-02",
      tenantId: "tenant-m4-02",
      userId: "user-m4-02",
      deviceId: "device-m4-02",
      seatId: "seat-m4-02",
      machineFingerprint: MACHINE_FINGERPRINT,
      grantedSessionCapabilities: ["transport_streamable_http"],
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    const exchange = composition.identity.exchangeEnrollmentToken({
      enrollmentToken: issue.value.enrollmentToken,
      machineFingerprint: MACHINE_FINGERPRINT,
    });
    expect(exchange.ok).toBe(true);
    if (!exchange.ok) return;
    const hello = (id: string): HelloEnvelope => ({
      type: "hello",
      id,
      ts: new Date(NOW_MS).toISOString(),
      payload: {
        min_protocol: 1,
        max_protocol: 1,
        capabilities: ["transport_streamable_http"],
        bridge_version: "m4-02-test",
        device_id: "device-m4-02",
        machine: { hostname: "m4-02-test", os: "windows" },
        addin_versions: ["m4-02-test"],
      },
    });
    const server = await startGatewayServer({
      config: composition.config,
      ports: composition.ports,
      northMcp: composition.northMcp,
    });
    const binding = new HttpSseGatewayBinding({
      baseUrl: `${server.url}/bridge/v1/http/connections`,
      deviceToken: exchange.value.deviceToken,
      endpointPolicy: "loopback_test_readiness",
    });
    try {
      const active = await binding.open(
        hello("018f0f7a-3f5e-7c00-8000-000000000021"),
      );
      expect(active.payload.granted_capabilities).toContain(
        "transport_streamable_http",
      );

      expect(composition.identity.revokeDevice("device-m4-02")).toMatchObject({
        ok: true,
        value: { deviceStatus: "revoked" },
      });
      const revoked = await fetch(
        `${server.url}/bridge/v1/http/connections`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${exchange.value.deviceToken}`,
            "content-type": "application/json",
            "x-rbp-versions": "1",
          },
          body: JSON.stringify(
            hello("018f0f7a-3f5e-7c00-8000-000000000022"),
          ),
        },
      );
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toMatchObject({ fault_class: "auth" });

      await expect(
        composition.bridgeAuthority.openConnection({
          deviceToken: exchange.value.deviceToken,
          binding: "wss",
          hello: hello("018f0f7a-3f5e-7c00-8000-000000000023"),
          channel: { async send() {}, async close() {} },
        }),
      ).rejects.toMatchObject({
        name: "GatewayRbpFault",
        code: "auth",
        httpStatus: 403,
        closeCode: 4403,
      });
    } finally {
      await binding.close();
      await server.close();
    }
  });
});
