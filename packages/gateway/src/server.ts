import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import type { GatewayConfig } from "./config.js";
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
  createUnavailableObjectStore,
  createUnavailableProtocolStore,
  type GatewayProtocolStore,
  type ObjectStorePort,
} from "./store.js";

/**
 * The Phase-1 Gateway HTTP process (GW-2).
 *
 * The shell owns the public surface and refuses on all of it. Every functional
 * route answers 503 with a structured `not_implemented`, so a later task
 * replaces a *refusing* route rather than adding an absent one — a client that
 * meets a 404 cannot tell "not built yet" from "wrong URL", and a bridge that
 * meets a bare connection reset classifies it as transient and retries forever.
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

/**
 * Refuses to run production traffic against a fixture.
 *
 * This is a runtime gate rather than a claim that no code path selects a fake.
 * Fake identity is the one adapter whose accidental promotion authenticates
 * everybody, and "there is no code path" stops being true the first time
 * someone adds a convenience branch.
 */
export function assertProductionPorts(
  config: GatewayConfig,
  ports: GatewayServerPorts,
): void {
  if (config.nodeEnv !== "production") {
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
    if (isFixtureAdapterKind(kind)) {
      throw new GatewayFixturePortError(name, kind);
    }
  }
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

export function createGatewayApp(options: {
  readonly config: GatewayConfig;
  readonly ports: GatewayServerPorts;
}): FastifyInstance {
  const { config, ports } = options;
  const app = Fastify(buildFastifyOptions(config));
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

  // Reserves the north MCP mount so the later task replaces a refusing route.
  app.all("/mcp", async (_request, reply) =>
    reply
      .code(503)
      .send(
        refusalBody(
          "north_mcp",
          "the north MCP surface is not implemented in Phase 1",
        ),
      ),
  );

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

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: "not_found" }),
  );

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, "gateway.unhandled_error");
    return reply.code(500).send({ error: "internal_error" });
  });

  // Fastify attaches no `upgrade` listener without a websocket plugin, and Node
  // then closes the socket with no status line at all. A bridge dialing
  // `wss://.../bridge/v1` would see a bare reset, which its reconnect state
  // machine reads as a transient fault and retries forever. Writing a real 503
  // makes the refusal legible instead of a retryable environment guess.
  app.server.on("upgrade", (request, socket) => {
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
    },
    enumerable: false,
  });

  return app;
}

export async function startGatewayServer(options: {
  readonly config: GatewayConfig;
  readonly ports: GatewayServerPorts;
}): Promise<GatewayServerHandle> {
  // First, before any socket exists.
  assertProductionPorts(options.config, options.ports);

  const app = createGatewayApp(options);
  await app.listen({
    host: options.config.http.bindHost,
    port: options.config.http.port,
  });

  const address = app.server.address();
  const port =
    address !== null && typeof address === "object" ? address.port : options.config.http.port;

  return {
    app,
    url: `http://${options.config.http.bindHost}:${String(port)}`,
    port,
    beginShutdown(): void {
      (app as unknown as { beginGatewayShutdown: () => void }).beginGatewayShutdown();
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}
