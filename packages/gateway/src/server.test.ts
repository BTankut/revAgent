import { describe, expect, it } from "vitest";
import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type IdentityPort,
} from "./authContext.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import type { NorthMcpEndpointOptions } from "./northMcpEndpoint.js";
import { createPreProductionIdentityAuthority } from "./preProductionIdentity.js";
import { createProductionRbpIngressHost } from "./rbpIngress.js";
import {
  GatewayCompositionError,
  GatewayFixturePortError,
  GatewayPreProductionPortError,
  assertProductionPorts,
  buildFastifyOptions,
  createFailClosedPorts,
  createGatewayApp,
  startGatewayServer,
} from "./server.js";
import {
  createFakeIdentityPort,
  createRestartableTestStore,
} from "./testAdapters.js";
import {
  GATEWAY_STORE_CONTRACT_VERSION,
  type GatewayProtocolStore,
  type StoreOutcome,
} from "./store.js";

function configFor(env: Record<string, string>): GatewayConfig {
  const loaded = loadGatewayConfig(env);
  if (!loaded.ok) {
    throw new Error(`unexpected invalid config: ${JSON.stringify(loaded.problems)}`);
  }
  return loaded.value;
}

const DEV = configFor({ NODE_ENV: "development", LOG_LEVEL: "fatal" });
const PROD = configFor({
  NODE_ENV: "production",
  LOG_LEVEL: "fatal",
  GATEWAY_BIND_HOST: "0.0.0.0",
  GATEWAY_PUBLIC_URL: "https://gateway.example",
});

function preProductionIdentity() {
  return createPreProductionIdentityAuthority({
    mode: "preproduction",
    nodeEnv: "test",
    tokenKey: "preproduction-server-gate-key-000000000000000001",
    clock: () => 1_800_000_000_000,
    northIdentities: [
      {
        authorization:
          "Bearer preproduction-server-token-000000000000000001",
        context: Object.freeze({
          contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
          actor: Object.freeze({
            type: "user" as const,
            tenantId: "tenant-preproduction",
            userId: "user-preproduction",
            role: "user" as const,
            oidcIssuer: "https://issuer.invalid/preproduction",
            oidcSubject: "subject-preproduction",
          }),
          session: Object.freeze({
            sessionId: "session-preproduction",
            clientType: "mcp" as const,
            mcpSessionId: "mcp-preproduction",
            oauthClientId: "client-preproduction",
          }),
          principalKey: "tenant-preproduction:user-preproduction",
          issuedAtMs: 1_799_999_999_000,
          expiresAtMs: 1_800_000_060_000,
        }),
      },
    ],
  });
}

function identityPort<K extends "oidc" | "fs" | "memory">(
  kind: K,
): IdentityPort & { readonly kind: K } {
  const refusal = {
    ok: false as const,
    port: "identity" as const,
    code: "unavailable" as const,
    message: `${kind} test identity is unavailable`,
  };
  return Object.freeze({
    kind,
    async authenticateNorthRequest() {
      return refusal;
    },
    async authenticateDevice() {
      return refusal;
    },
  });
}

function storePort<K extends "postgres" | "fs" | "memory">(
  kind: K,
): GatewayProtocolStore & { readonly kind: K } {
  return Object.freeze({
    kind,
    contractVersion: GATEWAY_STORE_CONTRACT_VERSION,
    async open() {
      return { ok: true as const, value: undefined };
    },
    async transact<T>(): Promise<StoreOutcome<T>> {
      return {
        ok: false as const,
        code: "unavailable" as const,
        message: `${kind} test store does not execute transactions`,
      };
    },
    async close() {
      return { ok: true as const, value: undefined };
    },
  });
}

describe("production port gate", () => {
  it("refuses to serve production traffic through a fixture adapter", () => {
    // Not "no code path selects a fake" -- that stops being true the first time
    // someone adds a convenience branch. This is an executable gate.
    const ports = { ...createFailClosedPorts(), identity: createFakeIdentityPort() };
    expect(() => assertProductionPorts(PROD, ports)).toThrow(GatewayFixturePortError);
  });

  it("allows a fixture adapter outside production", () => {
    const ports = { ...createFailClosedPorts(), identity: createFakeIdentityPort() };
    expect(() => assertProductionPorts(DEV, ports)).not.toThrow();
  });

  it("refuses the pre-production identity adapter in production", () => {
    const ports = {
      ...createFailClosedPorts(),
      identity: preProductionIdentity(),
    };
    expect(() => assertProductionPorts(PROD, ports)).toThrow(
      GatewayPreProductionPortError,
    );
    expect(() => assertProductionPorts(DEV, ports)).toThrow(
      GatewayCompositionError,
    );
  });

  it("guards both direct app creation and server startup before ingress", async () => {
    let ingressStarted = false;
    const base = createFailClosedPorts();
    const ports = {
      ...base,
      identity: preProductionIdentity(),
      rbpIngress: {
        ...base.rbpIngress,
        async start(): Promise<void> {
          ingressStarted = true;
        },
      },
    };

    expect(() => createGatewayApp({ config: PROD, ports })).toThrow(
      GatewayPreProductionPortError,
    );
    await expect(startGatewayServer({ config: PROD, ports })).rejects.toThrow(
      GatewayPreProductionPortError,
    );
    expect(ingressStarted).toBe(false);
  });

  it("accepts the fail-closed ports in production", () => {
    expect(() => assertProductionPorts(PROD, createFailClosedPorts())).not.toThrow();
  });

  it("refuses a pre-production identity hidden behind the north authenticator", async () => {
    let ingressStarted = false;
    const base = createFailClosedPorts();
    const identity = preProductionIdentity();
    const ports = {
      ...base,
      rbpIngress: {
        ...base.rbpIngress,
        async start(): Promise<void> {
          ingressStarted = true;
        },
      },
    };
    const northMcp = {
      authenticator: {
        kind: "preproduction",
        identity,
        trust: {
          mode: "preproduction",
          adapterKind: "preproduction",
          identity,
        },
        async authenticate() {
          return null;
        },
      },
    } as unknown as NorthMcpEndpointOptions;

    await expect(
      startGatewayServer({ config: PROD, ports, northMcp }),
    ).rejects.toMatchObject({
      name: "GatewayPreProductionPortError",
      port: "north_mcp",
    });
    expect(ingressStarted).toBe(false);
  });

  it("refuses a pre-production identity hidden only in fixture trust metadata", () => {
    const hiddenIdentity = preProductionIdentity();
    const northMcp = {
      authenticator: {
        trust: {
          mode: "fixture",
          adapterKind: "fake",
          identity: hiddenIdentity,
        },
        async authenticate() {
          return null;
        },
      },
    } as unknown as NorthMcpEndpointOptions;

    expect(() =>
      assertProductionPorts(DEV, createFailClosedPorts(), northMcp),
    ).toThrowError(
      expect.objectContaining({
        name: "GatewayCompositionError",
        reason: "authority_graph_mismatch",
      }) as GatewayCompositionError,
    );
  });

  it("refuses a pre-production identity hidden by a postgres-labelled RBP ingress", async () => {
    let ingressStarted = false;
    const identity = preProductionIdentity();
    const restartable = createRestartableTestStore();
    const authority = new GatewayBridgeSessionAuthority(
      restartable.store,
      identity,
    );
    const delegate = createProductionRbpIngressHost({ authority });
    const rbpIngress = {
      ...delegate,
      async start(): Promise<void> {
        ingressStarted = true;
        await delegate.start?.();
      },
    };

    await expect(
      startGatewayServer({
        config: PROD,
        ports: {
          ...createFailClosedPorts(),
          rbpIngress,
        },
      }),
    ).rejects.toMatchObject({
      name: "GatewayPreProductionPortError",
      port: "rbp_ingress",
    });
    expect(rbpIngress.kind).toBe("postgres");
    expect(ingressStarted).toBe(false);
  });

  it("rejects malformed north metadata before ingress start", async () => {
    let ingressStarted = false;
    const base = createFailClosedPorts();
    const ports = {
      ...base,
      rbpIngress: {
        ...base.rbpIngress,
        async start(): Promise<void> {
          ingressStarted = true;
        },
      },
    };
    const northMcp = {
      resourceMetadataUrl: new URL("http://gateway.invalid/metadata"),
    } as unknown as NorthMcpEndpointOptions;

    await expect(
      startGatewayServer({ config: DEV, ports, northMcp }),
    ).rejects.toThrow("resourceMetadataUrl must use HTTPS");
    expect(ingressStarted).toBe(false);
  });

  it("refuses production north MCP when authenticator trust metadata is absent", async () => {
    let ingressStarted = false;
    const base = createFailClosedPorts();
    const northMcp = {
      authenticator: { async authenticate() { return null; } },
    } as unknown as NorthMcpEndpointOptions;
    await expect(
      startGatewayServer({
        config: PROD,
        northMcp,
        ports: {
          ...base,
          rbpIngress: {
            ...base.rbpIngress,
            async start(): Promise<void> {
              ingressStarted = true;
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "GatewayCompositionError",
      port: "north_mcp",
      reason: "uninspectable_north_authenticator",
    });
    expect(ingressStarted).toBe(false);
  });

  it("accepts only explicit production OIDC authenticator metadata", () => {
    const identity = identityPort("oidc");
    const northMcp = {
      authenticator: {
        trust: {
          mode: "production",
          adapterKind: "oidc",
          identity,
        },
        async authenticate() {
          return null;
        },
      },
    } as unknown as NorthMcpEndpointOptions;
    expect(() =>
      assertProductionPorts(
        PROD,
        { ...createFailClosedPorts(), identity },
        northMcp,
      ),
    ).not.toThrow();
  });

  it("refuses a postgres ingress wrapper that hides its authority", () => {
    const identity = identityPort("oidc");
    const store = storePort("postgres");
    const delegate = createProductionRbpIngressHost({
      authority: new GatewayBridgeSessionAuthority(store, identity),
    });
    const { authority: _hidden, ...hiddenIngress } = delegate;
    void _hidden;
    expect(() =>
      assertProductionPorts(PROD, {
        ...createFailClosedPorts(),
        identity,
        protocolStore: store,
        rbpIngress: hiddenIngress,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "GatewayCompositionError",
        port: "rbp_ingress",
        reason: "uninspectable_rbp_authority",
      }) as GatewayCompositionError,
    );
  });

  it("accepts only an exact production postgres RBP authority graph", () => {
    const identity = identityPort("oidc");
    const store = storePort("postgres");
    const authority = new GatewayBridgeSessionAuthority(store, identity);
    expect(() =>
      assertProductionPorts(PROD, {
        ...createFailClosedPorts(),
        identity,
        protocolStore: store,
        rbpIngress: createProductionRbpIngressHost({ authority }),
      }),
    ).not.toThrow();
  });

  it("refuses enabled non-postgres RBP hosts before start", async () => {
    for (const kind of ["fs", "oidc"] as const) {
      let ingressStarted = false;
      const base = createFailClosedPorts();
      await expect(
        startGatewayServer({
          config: PROD,
          ports: {
            ...base,
            rbpIngress: {
              ...base.rbpIngress,
              kind,
              enabled: true,
              mount(): void {},
              async start(): Promise<void> {
                ingressStarted = true;
              },
            },
          },
        }),
      ).rejects.toMatchObject({
        name: "GatewayCompositionError",
        port: "rbp_ingress",
        reason: "invalid_rbp_ingress_shape",
      });
      expect(ingressStarted).toBe(false);
    }
  });

  it("refuses postgres RBP authorities backed by fs or memory adapters", () => {
    for (const [adapter, kind] of [
      ["identity", "fs"],
      ["identity", "memory"],
      ["store", "fs"],
      ["store", "memory"],
    ] as const) {
      const outerIdentity = identityPort("oidc");
      const outerStore = storePort("postgres");
      const authority = new GatewayBridgeSessionAuthority(
        adapter === "store" ? storePort(kind) : outerStore,
        adapter === "identity" ? identityPort(kind) : outerIdentity,
      );
      expect(() =>
        assertProductionPorts(PROD, {
          ...createFailClosedPorts(),
          identity: outerIdentity,
          protocolStore: outerStore,
          rbpIngress: createProductionRbpIngressHost({ authority }),
        }),
      ).toThrowError(expect.objectContaining({ port: "rbp_ingress" }));
    }
  });

  it("accepts only an inert unavailable disabled RBP shape", () => {
    const base = createFailClosedPorts();
    const identity = identityPort("oidc");
    const store = storePort("postgres");
    for (const surface of [
      { async start(): Promise<void> {} },
      { mount(): void {} },
      { handleUpgrade(): void {} },
      { beginDrain(): void {} },
      { async close(): Promise<void> {} },
      {
        kind: "postgres" as const,
        authority: new GatewayBridgeSessionAuthority(store, identity),
      },
    ]) {
      expect(() =>
        assertProductionPorts(PROD, {
          ...base,
          rbpIngress: { ...base.rbpIngress, ...surface },
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "GatewayCompositionError",
          port: "rbp_ingress",
          reason: "invalid_rbp_ingress_shape",
        }) as GatewayCompositionError,
      );
    }
  });

  it("does not close ingress when ingress start itself fails", async () => {
    const primary = new Error("ingress-start-primary");
    let closeCount = 0;
    const base = createFailClosedPorts();
    const ports = {
      ...base,
      rbpIngress: {
        ...base.rbpIngress,
        enabled: true,
        mount(): void {},
        async start(): Promise<void> {
          throw primary;
        },
        async close(): Promise<void> {
          closeCount += 1;
        },
      },
    };

    await expect(startGatewayServer({ config: DEV, ports })).rejects.toBe(primary);
    expect(closeCount).toBe(0);
  });

  it("bounds cleanup retries when listener bind and ingress close fail and preserves the bind error", async () => {
    let closeCount = 0;
    const secondary = new Error("ingress-close-secondary");
    const base = createFailClosedPorts();
    const ports = {
      ...base,
      rbpIngress: {
        ...base.rbpIngress,
        enabled: true,
        mount(): void {},
        async start(): Promise<void> {},
        async close(): Promise<void> {
          closeCount += 1;
          throw secondary;
        },
      },
    };
    let primary: unknown;
    try {
      await startGatewayServer({
        config: { ...DEV, http: { bindHost: "127.0.0.1", port: 70_000 } },
        ports,
      });
    } catch (error) {
      primary = error;
    }

    expect(primary).toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });
    expect(primary).not.toBe(secondary);
    expect(closeCount).toBe(2);
  });

  it("retries a failed ingress close before reporting shutdown residue", async () => {
    let closeCount = 0;
    const firstCloseFailure = new Error("ingress-close-first-attempt");
    const base = createFailClosedPorts();
    const handle = await startGatewayServer({
      config: {
        ...DEV,
        http: { bindHost: "127.0.0.1", port: 0 },
        publicUrl: "http://127.0.0.1",
      },
      ports: {
        ...base,
        rbpIngress: {
          ...base.rbpIngress,
          enabled: true,
          mount(): void {},
          async start(): Promise<void> {},
          async close(): Promise<void> {
            closeCount += 1;
            if (closeCount === 1) throw firstCloseFailure;
          },
        },
      },
    });

    await expect(handle.close()).rejects.toBe(firstCloseFailure);
    expect(closeCount).toBe(2);
    await expect(handle.close()).resolves.toBeUndefined();
    expect(closeCount).toBe(2);
  });

  it("builds and validates the app before starting ingress", async () => {
    const order: string[] = [];
    const base = createFailClosedPorts();
    const handle = await startGatewayServer({
      config: {
        ...DEV,
        http: { bindHost: "127.0.0.1", port: 0 },
        publicUrl: "http://127.0.0.1",
      },
      ports: {
        ...base,
        rbpIngress: {
          kind: "unavailable",
          mountPrefix: "/bridge/v1",
          enabled: true,
          refuse: base.rbpIngress.refuse,
          mount(): void {
            order.push("mount");
          },
          async start(): Promise<void> {
            order.push("start");
          },
          async close(): Promise<void> {
            order.push("close");
          },
        },
      },
    });
    expect(order).toEqual(["mount", "start"]);
    expect(handle.app.server.listening).toBe(true);
    await handle.app.close();
    await handle.close();
    expect(order).toEqual(["mount", "start", "close"]);
  });
});

describe("fastify options", () => {
  it("does not trust proxy headers", () => {
    // The edge proxy appends to X-Forwarded-For, so an attacker-set header
    // would become the leftmost entry and be adopted as the client address in
    // every audit-correlated log line.
    expect(buildFastifyOptions(DEV)).not.toHaveProperty("trustProxy");
  });

  it("redacts credential-bearing headers out of the request log", () => {
    const options = buildFastifyOptions(DEV);
    const logger = options.logger as { redact?: { paths: string[]; remove: boolean } };
    expect(logger.redact?.remove).toBe(true);
    expect(logger.redact?.paths).toContain("req.headers.authorization");
  });
});

describe("routes", () => {
  it("reports health with exactly two states and no inventory", async () => {
    // Served on the public hostname through the edge proxy with no path
    // matcher, so any subsystem list here is unauthenticated reconnaissance.
    const app = createGatewayApp({ config: DEV, ports: createFailClosedPorts() });
    const ok = await app.inject({ method: "GET", url: "/healthz" });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ status: "ok" });

    (app as unknown as { beginGatewayShutdown: () => void }).beginGatewayShutdown();
    const draining = await app.inject({ method: "GET", url: "/healthz" });
    expect(draining.statusCode).toBe(503);
    expect(JSON.parse(draining.body)).toEqual({ status: "shutting_down" });
    await app.close();
  });

  it("refuses the north MCP mount rather than leaving it absent", async () => {
    // A later task must replace a refusing route, never add a missing one: a
    // client that meets a 404 cannot tell "not built yet" from "wrong URL".
    const app = createGatewayApp({ config: DEV, ports: createFailClosedPorts() });
    const response = await app.inject({ method: "POST", url: "/mcp" });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "not_implemented",
      port: "north_mcp",
    });
    await app.close();
  });

  it("refuses the RBP ingress prefix and everything under it", async () => {
    const app = createGatewayApp({ config: DEV, ports: createFailClosedPorts() });
    for (const url of [
      "/bridge/v1",
      "/bridge/v1/http/connections",
      "/bridge/v1/anything/else",
    ]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        error: "not_implemented",
        port: "rbp_ingress",
      });
    }
    await app.close();
  });

  it("answers an unknown path with a structured 404", async () => {
    const app = createGatewayApp({ config: DEV, ports: createFailClosedPorts() });
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "not_found" });
    await app.close();
  });
});
