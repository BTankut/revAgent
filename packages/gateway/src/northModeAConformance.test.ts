import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import { gatewayExternalToolInputJsonSchema } from "./confirmation.js";
import { GatewayConfirmationAuthority } from "./confirmationAuthority.js";
import {
  GatewayDispatcher,
  type GatewayExecutor,
  type GatewayExecutorRequest,
} from "./dispatch.js";
import {
  EntitledCatalogView,
  buildCatalog,
  entitleOnly,
} from "./entitledRegistry.js";
import { buildGatewayExecutableRegistry } from "./executableRegistry.js";
import {
  buildGatewayInstructionPackage,
  gatewayClientInstructions,
} from "./instructionPackage.js";
import type { GatewayInvocationRoute } from "./invocationContext.js";
import {
  NORTH_MODE_A_META_TOOLS,
  NORTH_MODE_A_PINNED_TOOLS,
  type AuthenticatedNorthMcpRequest,
} from "./northMcpEndpoint.js";
import type { GatewayProtocolStore } from "./store.js";
import { createFailClosedPorts, createGatewayApp } from "./server.js";
import { verifyRegistrySeed } from "./registrySeed.js";
import {
  createCapturingEventSink,
  createReadOnlyRecoveryAuthorityFixture,
  createRestartableTestStore,
  type CapturingEventSink,
} from "./testAdapters.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = verifyRegistrySeed(
  JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8"),
  ) as unknown,
);

function configFor(env: Record<string, string>): GatewayConfig {
  const loaded = loadGatewayConfig(env);
  if (!loaded.ok) {
    throw new Error(`unexpected invalid config: ${JSON.stringify(loaded.problems)}`);
  }
  return loaded.value;
}

const DEV = configFor({ NODE_ENV: "development", LOG_LEVEL: "fatal" });
const catalog = buildCatalog(seed);
const registry = buildGatewayExecutableRegistry(seed, catalog);
const DENIED_TOOL = "core.code.execute";
const entitledNames = catalog
  .map((entry) => entry.name)
  .filter((name) => name !== DENIED_TOOL);
const entitledView = new EntitledCatalogView(
  catalog,
  entitleOnly(entitledNames),
);
const TOKEN = "gw10-deterministic-fake-token";
const PRINCIPAL_KEY = "tenant-gw10:user-gw10";
const GATEWAY_SESSION_ID = "gateway-gw10-session";
const REQUEST_STATE_KEY = "gw10-request-state-key-at-least-32-bytes";
const RSID = "019fa22d-535f-7a2d-9d10-85d31f03fa8d";
const RUNTIME_TOOL = "core.view.activate";
const DOCS_TOOL = "core.docs.search";
const CONFIRM_TOOL = "core.view.delete_review";

function uuid7(value: number): string {
  return `019fa22d-535f-7000-8000-${String(value).padStart(12, "0")}`;
}

function authContext(sessionId = GATEWAY_SESSION_ID): AuthContext {
  return Object.freeze({
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: Object.freeze({
      type: "user" as const,
      tenantId: "tenant-gw10",
      userId: "user-gw10",
      role: "user" as const,
      oidcIssuer: "https://fake.invalid/gw10",
      oidcSubject: "subject-gw10",
    }),
    session: Object.freeze({
      sessionId,
      clientType: "mcp" as const,
      mcpSessionId: null,
      oauthClientId: "dp10-fake-client",
    }),
    principalKey: PRINCIPAL_KEY,
    issuedAtMs: 0,
    expiresAtMs: null,
  });
}

function authenticated(
  authInfo: AuthInfo,
  sessionId = GATEWAY_SESSION_ID,
): AuthenticatedNorthMcpRequest {
  return Object.freeze({
    authInfo,
    authContext: authContext(sessionId),
    principalKey: PRINCIPAL_KEY,
  });
}

function routeFor(
  request: AuthenticatedNorthMcpRequest,
  mcpSessionId: string,
): GatewayInvocationRoute {
  return Object.freeze({
    tenantId: request.authContext.actor.tenantId,
    mcpSessionId,
    rsid: RSID,
    documentIdentity: Object.freeze({
      kind: "live" as const,
      session_document_id: "gw10-document",
    }),
  });
}

function names(tools: readonly Tool[]): string[] {
  return tools.map((tool) => tool.name).sort();
}

function structured(
  result: Awaited<ReturnType<Client["callTool"]>>,
): Record<string, unknown> {
  if (
    result.structuredContent === undefined ||
    result.structuredContent === null ||
    typeof result.structuredContent !== "object"
  ) {
    throw new TypeError("tool result has no structured content");
  }
  return result.structuredContent as Record<string, unknown>;
}

let app: FastifyInstance | undefined;
let client: Client | undefined;
let transport: StreamableHTTPClientTransport | undefined;

let confirmationStore: GatewayProtocolStore | undefined;
afterEach(async () => {
  await Promise.allSettled([client?.close(), transport?.close()]);
  await app?.close();
  app = undefined;
  client = undefined;
  await confirmationStore?.close();
  confirmationStore = undefined;
  transport = undefined;
});

describe("GW-10 north Mode-A conformance", () => {
  it("keeps entitled discovery session-sticky and dispatches runtime/docs bindings", async () => {
    const runtimeBytes = Buffer.byteLength(
      JSON.stringify(registry.require(RUNTIME_TOOL).inputJsonSchema),
      "utf8",
    );
    const docsBytes = Buffer.byteLength(
      JSON.stringify(registry.require(DOCS_TOOL).inputJsonSchema),
      "utf8",
    );
    const confirmBytes = Buffer.byteLength(
      JSON.stringify(
        gatewayExternalToolInputJsonSchema(registry.require(CONFIRM_TOOL)),
      ),
      "utf8",
    );
    const schemaBudgetBytes = Math.max(runtimeBytes, docsBytes, confirmBytes);
    expect(runtimeBytes + docsBytes + confirmBytes).toBeGreaterThan(schemaBudgetBytes);

    const executorRequests: GatewayExecutorRequest[] = [];
    const confirmationPreviewRequests: GatewayExecutorRequest[] = [];
    const executor = (binding: "bridge" | "internal_mcp"): GatewayExecutor => ({
      binding,
      async execute(request) {
        executorRequests.push(request);
        return {
          state: "completed" as const,
          result: {
            binding,
            executorMethod: request.executorMethod,
            principalKey: request.context.principalKey,
          },
        };
      },
      ...(binding === "bridge"
        ? {
            async previewConfirmation(request: GatewayExecutorRequest) {
              confirmationPreviewRequests.push(request);
              return {
                state: "completed" as const,
                result: { preview: "bounded", writes: 0 },
                previewRef: "inline:gw10-confirmation-preview",
              };
            },
          }
        : {}),
    });
    const eventSink: CapturingEventSink = createCapturingEventSink();
    const durable = createRestartableTestStore();
    confirmationStore = durable.store;
    const opened = await confirmationStore.open();
    expect(opened.ok).toBe(true);
    const confirmationAuthority = new GatewayConfirmationAuthority(
      confirmationStore,
      {
        clock: () => 1_775_000_000_000,
        newConfirmationId: () => uuid7(900_000),
        newTokenSecret: () => "S".repeat(43),
      },
    );

    let sequence = 0;
    const dispatcher = new GatewayDispatcher(
      registry,
      [executor("bridge"), executor("internal_mcp")],
      {
        eventSink,
        eventSource: {
          component: "gateway-gw10-test",
          version: "0.0.0-test",
          instance: "gw10-test",
        },
        confirmationAuthority,
        newInvocationId: () => uuid7(++sequence),
        newEventId: () => uuid7(100_000 + sequence),
        recoveryAuthority: createReadOnlyRecoveryAuthorityFixture(),
      },
    );

    app = createGatewayApp({
      config: DEV,
      ports: createFailClosedPorts(),
      northMcp: {
      authenticator: {
        async authenticate(request) {
          const bearer = request.headers.authorization;
          if (bearer !== `Bearer ${TOKEN}` && bearer !== `Bearer ${TOKEN}-isolated`) {
            return null;
          }
          const authInfo: AuthInfo = {
            token: TOKEN,
            clientId: "dp10-fake-client",
            scopes: ["mcp:tools"],
            resource: new URL("https://gateway.example.test/mcp"),
          };
          return authenticated(
            authInfo,
            bearer.endsWith("-isolated") ? "gateway-gw10-isolated" : undefined,
          );
        },
      },
      catalogViewFor: () => entitledView,
      invocationRouteFor: routeFor,
      dispatcher,
      registry,
      requestState: { key: REQUEST_STATE_KEY },
      modeA: { schemaBudgetBytes },
      resourceMetadataUrl: new URL(
        "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
      ),
      },
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (address === null || typeof address !== "object") {
      throw new Error("Fastify GW-10 mount did not expose a TCP address");
    }
    const endpointUrl = new URL(
      `http://127.0.0.1:${String(address.port)}/mcp`,
    );

    const listChanges: Tool[][] = [];
    client = new Client(
      { name: "DP-10 deterministic fake", version: "0.1.0-m2" },
      {
        versionNegotiation: { mode: "auto" },
        listChanged: {
          tools: {
            autoRefresh: true,
            debounceMs: 0,
            onChanged(error, tools) {
              if (error !== null) {
                throw error;
              }
              if (tools !== null) {
                listChanges.push(tools);
              }
            },
          },
        },
      },
    );
    transport = new StreamableHTTPClientTransport(endpointUrl, {
      requestInit: {
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    });
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getInstructions()).toBe(
      gatewayClientInstructions(buildGatewayInstructionPackage(entitledView)),
    );
    expect(entitledView.entries()).toHaveLength(39);

    const initialTools = await client.listTools();
    expect(names(initialTools.tools)).toEqual(
      [...NORTH_MODE_A_META_TOOLS, ...NORTH_MODE_A_PINNED_TOOLS].sort(),
    );

    const runtimeSearch = structured(
      await client.callTool({
        name: "tool_search",
        arguments: { query: RUNTIME_TOOL },
      }),
    );
    const docsSearch = structured(
      await client.callTool({
        name: "tool_search",
        arguments: { query: DOCS_TOOL },
      }),
    );
    expect(runtimeSearch.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: RUNTIME_TOOL })]),
    );
    expect(docsSearch.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: DOCS_TOOL })]),
    );

    const runtimeActivation = structured(
      await client.callTool({
        name: "tool_schema",
        arguments: { names: [RUNTIME_TOOL] },
      }),
    );
    expect(runtimeActivation).toMatchObject({
      ok: true,
      activatedNames: [RUNTIME_TOOL],
      evictedNames: [],
    });
    await expect
      .poll(() => listChanges.some((tools) => names(tools).includes(RUNTIME_TOOL)))
      .toBe(true);
    expect(names((await client.listTools()).tools)).toContain(RUNTIME_TOOL);

    const runtimeResult = await client.callTool({
      name: RUNTIME_TOOL,
      arguments: { viewId: 42 },
    });
    expect(runtimeResult).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        executor: "bridge",
      },
    });

    const docsActivation = structured(
      await client.callTool({
        name: "tool_schema",
        arguments: { names: [DOCS_TOOL] },
      }),
    );
    expect(docsActivation).toMatchObject({
      ok: true,
      activatedNames: [DOCS_TOOL],
    });
    await expect
      .poll(() =>
        listChanges.some((tools) => {
          const current = names(tools);
          return current.includes(DOCS_TOOL);
        }),
      )
      .toBe(true);
    const afterEviction = names((await client.listTools()).tools);
    expect(afterEviction).toContain(DOCS_TOOL);

    const docsResult = await client.callTool({
      name: DOCS_TOOL,
      arguments: { query: "FilteredElementCollector", limit: 5 },
    });
    expect(docsResult).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        executor: "internal_mcp",
      },
    });

    const confirmActivation = structured(
      await client.callTool({
        name: "tool_schema",
        arguments: { names: [CONFIRM_TOOL] },
      }),
    );
    expect(confirmActivation).toMatchObject({
      ok: true,
      activatedNames: [CONFIRM_TOOL],
    });
    expect(confirmActivation.evictedNames).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    const afterConfirmActivation = names((await client.listTools()).tools);
    expect(afterConfirmActivation).toContain(CONFIRM_TOOL);
    for (const evictedName of confirmActivation.evictedNames as string[]) {
      expect(afterConfirmActivation).not.toContain(evictedName);
    }

    const confirmationResult = await client.callTool({
      name: CONFIRM_TOOL,
      arguments: {
        viewId: 123,
      },
    });
    expect(confirmationResult).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        state: "confirmation_required",
        confirmation: {
          confirmToken: expect.any(String),
          originatingPreviewInvocationId: expect.any(String),
        },
      },
    });
    expect(confirmationPreviewRequests).toHaveLength(1);
    expect(confirmationPreviewRequests[0]?.executorMethod).toBe(
      "delete_review_view",
    );

    expect(executorRequests.map((request) => request.executorMethod)).toEqual([
      "activate_view",
      "search_api",
    ]);
    expect(
      executorRequests.map((request) => request.context.principalKey),
    ).toEqual([PRINCIPAL_KEY, PRINCIPAL_KEY]);

    const deniedSearch = structured(
      await client.callTool({
        name: "tool_search",
        arguments: { query: DENIED_TOOL },
      }),
    );
    expect(deniedSearch.results).not.toContainEqual(
      expect.objectContaining({
        name: DENIED_TOOL,
      }),
    );
    const deniedSchema = await client.callTool({
      name: "tool_schema",
      arguments: { names: [DENIED_TOOL] },
    });
    expect(deniedSchema).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "tool_unavailable" },
      },
    });
    await expect(
      client.callTool({ name: DENIED_TOOL, arguments: {} }),
    ).rejects.toMatchObject({ code: -32_602 });
    expect(executorRequests).toHaveLength(2);

    const events = eventSink.captured();
    expect(events.every((event) => event.tenant_id === "tenant-gw10")).toBe(
      true,
    );
    expect(events.every((event) => event.actor.user_id === "user-gw10")).toBe(
      true,
    );
    expect(events.every((event) => event.session_id === GATEWAY_SESSION_ID)).toBe(
      true,
    );
    const invocationEvents = events.filter(
      (event) => event.event_type === "tool.invocation",
    );
    expect(invocationEvents.map((event) => event.payload.tool_name)).toEqual([
      RUNTIME_TOOL,
      DOCS_TOOL,
      CONFIRM_TOOL,
    ]);
    expect(
      events.filter((event) => event.event_type === "tool.confirmation"),
    ).toHaveLength(1);

    const isolatedClient = new Client(
      { name: "DP-10 second connection", version: "0.1.0-m2" },
      { versionNegotiation: { mode: "auto" } },
    );
    const isolatedTransport = new StreamableHTTPClientTransport(endpointUrl, {
      requestInit: {
        headers: { authorization: `Bearer ${TOKEN}-isolated` },
      },
    });
    try {
      await isolatedClient.connect(isolatedTransport);
      expect(names((await isolatedClient.listTools()).tools)).toEqual(
        [...NORTH_MODE_A_META_TOOLS, ...NORTH_MODE_A_PINNED_TOOLS].sort(),
      );
    } finally {
      await Promise.allSettled([
        isolatedClient.close(),
        isolatedTransport.close(),
      ]);
    }
  }, 30_000);
});
