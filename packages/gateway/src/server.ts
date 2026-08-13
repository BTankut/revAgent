import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { GatewayConfig } from "./config.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import {
  createUnavailableEntitlementPort,
  createUnavailableIdentityPort,
  type EntitlementPort,
  type IdentityPort,
} from "./authContext.js";
import { createUnavailableEventSink, type GatewayEventSink } from "./events.js";
import {
  GATEWAY_FIXTURE_ADAPTER_KINDS,
  isFixtureAdapterKind,
  type GatewayPortAdapterKind,
  type GatewayPortName,
} from "./gatewayPorts.js";
import {
  createUnavailableGuardrailPort,
  type GuardrailPort,
} from "./guardrails.js";
import {
  createUnavailableRbpIngressHost,
  type RbpIngressHost,
} from "./rbpIngress.js";
import {
  createNorthMcpHttpHandler,
  type NorthMcpEndpointOptions,
} from "./northMcpEndpoint.js";
import {
  createUnavailableObjectStore,
  createUnavailableProtocolStore,
  type GatewayProtocolStore,
  type ObjectStorePort,
} from "./store.js";

/**
 * The Phase-1 Gateway HTTP process (GW-2 / GW-12).
 *
 * The shell owns the public surface and remains fail closed when no adapter is
 * injected. GW-12 replaces only the reserved RBP paths with one production
 * ingress host; all other absent ports still answer structured refusals.
 *
 * `northMcpEndpoint.ts` is deliberately not mounted here. It refuses any
 * non-loopback bind and enforces a loopback Host allowlist, so it cannot serve
 * `caddy -> gateway:8080`; it stays the loopback test fixture it is, and the
 * production north surface belongs to a later task.
 */
export interface GatewayServerPorts {
  readonly identity: IdentityPort;
  readonly entitlement: EntitlementPort;
  readonly events: GatewayEventSink;
  readonly protocolStore: GatewayProtocolStore;
  readonly objectStore: ObjectStorePort;
  readonly guardrails: GuardrailPort;
  readonly rbpIngress: RbpIngressHost;
}

/**
 * Every port unavailable, in every environment.
 *
 * Takes no argument, so there is no parameter a later convenience branch could
 * use to swap in a fixture.
 */
export function createFailClosedPorts(): GatewayServerPorts {
  return Object.freeze({
    identity: createUnavailableIdentityPort(),
    entitlement: createUnavailableEntitlementPort(),
    events: createUnavailableEventSink(),
    protocolStore: createUnavailableProtocolStore(),
    objectStore: createUnavailableObjectStore(),
    guardrails: createUnavailableGuardrailPort(),
    rbpIngress: createUnavailableRbpIngressHost(),
  });
}

export class GatewayFixturePortError extends Error {
  readonly code = "fixture_adapter_refused" as const;
  constructor(
    readonly port: GatewayPortName,
    readonly adapterKind: GatewayPortAdapterKind,
  ) {
    super(
      `refusing to start in production: the ${port} port is a ${adapterKind} fixture adapter ` +
        `(fixture kinds: ${GATEWAY_FIXTURE_ADAPTER_KINDS.join(", ")})`,
    );
    this.name = "GatewayFixturePortError";
  }
}

export class GatewayPreProductionPortError extends Error {
  readonly code = "preproduction_adapter_refused" as const;
  readonly adapterKind = "preproduction" as const;
  constructor(readonly port: GatewayPortName) {
    super(
      `refusing to start in production: the ${port} port uses the deterministic preproduction adapter`,
    );
    this.name = "GatewayPreProductionPortError";
  }
}

export type GatewayCompositionErrorReason =
  | "uninspectable_north_authenticator"
  | "uninspectable_rbp_authority"
  | "invalid_rbp_ingress_shape"
  | "preproduction_tls_required"
  | "authority_graph_mismatch";

export class GatewayCompositionError extends Error {
  readonly code = "gateway_composition_refused" as const;
  public constructor(
    readonly port: GatewayPortName,
    readonly reason: GatewayCompositionErrorReason,
  ) {
    super(`refusing Gateway composition: ${port} ${reason}`);
    this.name = "GatewayCompositionError";
  }
}

function refuseAdapterKind(
  port: GatewayPortName,
  kind: GatewayPortAdapterKind,
): void {
  if (kind === "preproduction") {
    throw new GatewayPreProductionPortError(port);
  }
  if (isFixtureAdapterKind(kind)) {
    throw new GatewayFixturePortError(port, kind);
  }
}

function northAdapterKind(
  northMcp: NorthMcpEndpointOptions | undefined,
): GatewayPortAdapterKind | undefined {
  return (
    northMcp?.authenticator as
      | { readonly kind?: GatewayPortAdapterKind }
      | undefined
  )?.kind;
}

function assertPreProductionGraph(
  ports: GatewayServerPorts,
  northMcp: NorthMcpEndpointOptions | undefined,
): void {
  const trust = (
    northMcp?.authenticator as
      | NorthMcpEndpointOptions["authenticator"]
      | undefined
  )?.trust;
  const authority = ports.rbpIngress.authority;
  const hasPreProductionAdapter =
    ports.identity.kind === "preproduction" ||
    ports.rbpIngress.kind === "preproduction" ||
    northAdapterKind(northMcp) === "preproduction" ||
    trust?.mode === "preproduction" ||
    trust?.identity?.kind === "preproduction" ||
    authority?.identity.kind === "preproduction";
  if (!hasPreProductionAdapter) {
    return;
  }
  if (
    ports.identity.kind !== "preproduction" ||
    northMcp === undefined ||
    northAdapterKind(northMcp) !== "preproduction" ||
    trust?.mode !== "preproduction" ||
    trust.adapterKind !== "preproduction" ||
    trust.identity !== ports.identity ||
    ports.rbpIngress.kind !== "preproduction" ||
    !ports.rbpIngress.enabled ||
    !(authority instanceof GatewayBridgeSessionAuthority) ||
    authority.identity !== ports.identity ||
    authority.store !== ports.protocolStore
  ) {
    throw new GatewayCompositionError(
      "identity",
      "authority_graph_mismatch",
    );
  }
}

function assertProductionRbpIngress(ports: GatewayServerPorts): void {
  const ingress = ports.rbpIngress;
  if (!ingress.enabled) {
    const hasOperationalSurface =
      ingress.start !== undefined ||
      ingress.mount !== undefined ||
      ingress.handleUpgrade !== undefined ||
      ingress.beginDrain !== undefined ||
      ingress.close !== undefined;
    if (
      ingress.kind !== "unavailable" ||
      ingress.authority !== undefined ||
      hasOperationalSurface
    ) {
      throw new GatewayCompositionError(
        "rbp_ingress",
        "invalid_rbp_ingress_shape",
      );
    }
    return;
  }

  if (ingress.kind !== "postgres") {
    throw new GatewayCompositionError(
      "rbp_ingress",
      "invalid_rbp_ingress_shape",
    );
  }
  const authority = ingress.authority;
  if (!(authority instanceof GatewayBridgeSessionAuthority)) {
    throw new GatewayCompositionError(
      "rbp_ingress",
      "uninspectable_rbp_authority",
    );
  }
  refuseAdapterKind("rbp_ingress", authority.identity.kind);
  refuseAdapterKind("rbp_ingress", authority.store.kind);
  if (
    authority.identity.kind !== "oidc" ||
    authority.store.kind !== "postgres" ||
    authority.identity !== ports.identity ||
    authority.store !== ports.protocolStore
  ) {
    throw new GatewayCompositionError(
      "rbp_ingress",
      "authority_graph_mismatch",
    );
  }
}

/**
 * Refuses to run production traffic against a fixture or pre-production seam.
 *
 * This is a runtime gate rather than a claim that no code path selects a fake.
 * Fake identity is the one adapter whose accidental promotion authenticates
 * everybody, and "there is no code path" stops being true the first time
 * someone adds a convenience branch.
 */
export function assertProductionPorts(
  config: GatewayConfig,
  ports: GatewayServerPorts,
  northMcp?: NorthMcpEndpointOptions,
): void {
  if (config.nodeEnv !== "production") {
    assertPreProductionGraph(ports, northMcp);
    return;
  }
  const entries: readonly (readonly [GatewayPortName, GatewayPortAdapterKind])[] = [
    ["identity", ports.identity.kind],
    ["entitlement", ports.entitlement.kind],
    ["event_sink", ports.events.kind],
    ["protocol_store", ports.protocolStore.kind],
    ["object_store", ports.objectStore.kind],
    ["guardrails", ports.guardrails.kind],
    ["rbp_ingress", ports.rbpIngress.kind],
  ];
  for (const [name, kind] of entries) {
    refuseAdapterKind(name, kind);
  }

  if (northMcp !== undefined) {
    const trust = northMcp.authenticator.trust;
    if (trust === undefined) {
      throw new GatewayCompositionError(
        "north_mcp",
        "uninspectable_north_authenticator",
      );
    }
    refuseAdapterKind("north_mcp", trust.adapterKind);
    if (
      trust.mode !== "production" ||
      trust.adapterKind !== "oidc" ||
      trust.identity.kind !== "oidc" ||
      trust.identity !== ports.identity
    ) {
      throw new GatewayCompositionError(
        "north_mcp",
        "authority_graph_mismatch",
      );
    }
  }

  assertProductionRbpIngress(ports);
}

/**
 * Exported so a test can assert what is *absent*.
 *
 * `trustProxy` is deliberately not set: the edge proxy appends to
 * `X-Forwarded-For`, so an attacker-supplied header would become the leftmost
 * entry and be adopted as the client address in every audit-correlated log line.
 */
export function buildFastifyOptions(config: GatewayConfig): FastifyServerOptions {
  let requestCounter = 0;
  return {
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.headers['x-device-token']",
        ],
        remove: true,
      },
    },
    genReqId: () => {
      requestCounter += 1;
      return `req-${String(requestCounter)}`;
    },
    disableRequestLogging: false,
  };
}

function refusalBody(port: GatewayPortName, detail: string): {
  readonly error: "not_implemented";
  readonly port: GatewayPortName;
  readonly message: string;
} {
  return {
    error: "not_implemented",
    port,
    message: detail,
  };
}

export interface GatewayServerHandle {
  readonly app: FastifyInstance;
  readonly url: string;
  readonly port: number;
  beginShutdown(): void;
  close(): Promise<void>;
}

export interface GatewayServerTlsMaterial {
  readonly key: Buffer;
  readonly cert: Buffer;
}

export interface GatewayServerOptions {
  readonly config: GatewayConfig;
  readonly northMcp?: NorthMcpEndpointOptions;
  readonly ports: GatewayServerPorts;
  /** Explicit TLS material; absent preserves the production proxy/HTTP default. */
  readonly tls?: GatewayServerTlsMaterial;
}

function buildGatewayApp(
  options: GatewayServerOptions,
  closeIngressOnAppClose: (() => Promise<void>) | null,
): FastifyInstance {
  const { config, ports } = options;
  // `createGatewayApp` is public for injection tests. Keep the same executable
  // production gate here so a caller cannot bypass `startGatewayServer` and
  // call `app.listen()` directly with a non-production identity adapter.
  assertProductionPorts(config, ports, options.northMcp);
  if (config.nodeEnv === "preproduction" && options.tls === undefined) {
    throw new GatewayCompositionError(
      "north_mcp",
      "preproduction_tls_required",
    );
  }
  const fastifyOptions =
    options.tls === undefined
      ? buildFastifyOptions(config)
      : ({
          ...buildFastifyOptions(config),
          https: {
            key: options.tls.key,
            cert: options.tls.cert,
          },
        } as FastifyServerOptions);
  const app = Fastify(fastifyOptions);
  const publicHostname = new URL(config.publicUrl).hostname.toLowerCase();
  const northMcp =
    options.northMcp === undefined
      ? undefined
      : createNorthMcpHttpHandler(options.northMcp, (hostHeader) => {
          if (hostHeader === undefined) {
            return false;
          }
          try {
            return (
              new URL(`http://${hostHeader}`).hostname.toLowerCase() ===
              publicHostname
            );
          } catch {
            return false;
          }
        });

  let shuttingDown = false;

  // The body is exactly two states and nothing else. This endpoint is served on
  // the public hostname through the edge proxy with no path matcher, so any
  // subsystem inventory here would be unauthenticated reconnaissance telling a
  // caller which parts are stubbed.
  app.get("/healthz", async (_request, reply) => {
    if (shuttingDown) {
      return reply.code(503).send({ status: "shutting_down" });
    }
    return reply.code(200).send({ status: "ok" });
  });

  app.all("/mcp", async (request, reply) => {
    if (northMcp === undefined) {
      return reply
        .code(503)
        .send(
          refusalBody(
            "north_mcp",
            "the north MCP surface is not configured",
          ),
        );
    }
    reply.hijack();
    await northMcp.handle(request.raw, reply.raw, request.body);
  });

  if (northMcp !== undefined) {
    app.addHook("onClose", async () => northMcp.close());
  }

  if (ports.rbpIngress.enabled && ports.rbpIngress.mount !== undefined) {
    ports.rbpIngress.mount(app);
  } else {
    const refuseIngress = async (
      request: { readonly url: string },
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ): Promise<unknown> => {
      const refusal = ports.rbpIngress.refuse({ path: request.url, kind: "http" });
      return reply.code(503).send({
        error: refusal.code,
        port: refusal.port,
        message: refusal.message,
      });
    };
    app.all("/bridge/v1", refuseIngress);
    app.all("/bridge/v1/*", refuseIngress);
  }

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: "not_found" }),
  );

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "gateway.unhandled_error");
    return reply.code(500).send({ error: "internal_error" });
  });

  // Fastify attaches no `upgrade` listener without a websocket plugin. Route
  // an enabled GW-12 host explicitly; otherwise write the original structured
  // refusal so an absent adapter is not misclassified as a retryable reset.
  app.server.on("upgrade", (request, socket, head) => {
    if (
      ports.rbpIngress.enabled &&
      ports.rbpIngress.handleUpgrade !== undefined
    ) {
      ports.rbpIngress.handleUpgrade(request, socket, head);
      return;
    }
    const refusal = ports.rbpIngress.refuse({
      path: request.url ?? "/",
      kind: "upgrade",
    });
    const body = JSON.stringify({
      error: refusal.code,
      port: refusal.port,
      message: refusal.message,
    });
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\n" +
        "Content-Type: application/json\r\n" +
        "Connection: close\r\n" +
        `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
        "\r\n" +
        body,
    );
    socket.destroy();
  });

  Object.defineProperty(app, "beginGatewayShutdown", {
    value: () => {
      shuttingDown = true;
      ports.rbpIngress.beginDrain?.();
    },
    enumerable: false,
  });

  if (closeIngressOnAppClose !== null) {
    app.addHook("onClose", closeIngressOnAppClose);
  }

  return app;
}

export function createGatewayApp(
  options: GatewayServerOptions,
): FastifyInstance {
  // A directly constructed app retains its historical ownership of ingress
  // close. The starter uses the internal variant so it can distinguish a
  // failed start from a started ingress whose listener subsequently failed.
  return buildGatewayApp(
    options,
    options.ports.rbpIngress.close === undefined
      ? null
      : async () => options.ports.rbpIngress.close!(),
  );
}

export async function startGatewayServer(
  options: GatewayServerOptions,
): Promise<GatewayServerHandle> {
  // First, before any socket exists.
  assertProductionPorts(options.config, options.ports, options.northMcp);

  let ingressStarted = false;
  let ingressClosed = false;
  let ingressCloseAttempt: Promise<void> | null = null;
  const closeIngressOnce = async (): Promise<void> => {
    if (!ingressStarted || ingressClosed) {
      return;
    }
    if (ingressCloseAttempt === null) {
      ingressCloseAttempt = (async () => {
        await options.ports.rbpIngress.close?.();
        ingressClosed = true;
      })();
    }
    try {
      await ingressCloseAttempt;
    } catch (error) {
      ingressCloseAttempt = null;
      throw error;
    }
  };
  // Constructing the app validates the north handler, Host policy and mounted
  // ingress routes without opening a listener or durable ingress. Its close
  // hook is started-state-aware so public `handle.app.close()` retains the
  // same resource ownership without closing an ingress whose start failed.
  const app = buildGatewayApp(options, closeIngressOnce);
  try {
    await options.ports.rbpIngress.start?.();
    ingressStarted = true;
    await app.listen({
      host: options.config.http.bindHost,
      port: options.config.http.port,
    });
  } catch (error) {
    try {
      await app.close();
    } catch {
      // Preserve the validation/start/listen failure as the primary cause.
    }
    try {
      await closeIngressOnce();
    } catch {
      // Preserve the validation/start/listen failure as the primary cause.
    }
    throw error;
  }

  const address = app.server.address();
  const port =
    address !== null && typeof address === "object" ? address.port : options.config.http.port;

  return {
    app,
    url: `${options.tls === undefined ? "http" : "https"}://${options.config.http.bindHost}:${String(port)}`,
    port,
    beginShutdown(): void {
      (app as unknown as { beginGatewayShutdown: () => void }).beginGatewayShutdown();
    },
    async close(): Promise<void> {
      let primaryError: unknown;
      try {
        await app.close();
      } catch (error) {
        primaryError = error;
      }
      try {
        await closeIngressOnce();
      } catch (error) {
        primaryError ??= error;
      }
      if (primaryError !== undefined) {
        throw primaryError;
      }
    },
  };
}
