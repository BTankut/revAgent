import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import { GatewayDispatcher, type GatewayExecutor } from "./dispatch.js";
import { EntitledCatalogView, entitleAll } from "./entitledRegistry.js";
import {
  startNorthMcpEndpoint,
  type NorthMcpEndpointHandle,
} from "./northMcpEndpoint.js";
import { GatewayToolRegistry, M2_BOOTSTRAP_TOOL_RECORDS } from "./registry.js";
import {
  GatewayResourceAuthority,
  resourceScopeFromAuth,
} from "./resourceAuthority.js";
import {
  createCapturingEventSink,
  createMemoryObjectStore,
  createReadOnlyRecoveryAuthorityFixture,
  createRestartableTestStore,
} from "./testAdapters.js";

const RESOURCE_STATE_KEY = "revagent-gw9-resource-state-key-at-least-32-bytes";

function authContext(userId: string): AuthContext {
  return Object.freeze({
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: Object.freeze({
      type: "user" as const,
      tenantId: "tenant-gw9",
      userId,
      role: "user" as const,
      oidcIssuer: "https://issuer.invalid/gw9",
      oidcSubject: `subject-${userId}`,
    }),
    session: Object.freeze({
      sessionId: `gateway-${userId}`,
      clientType: "mcp" as const,
      mcpSessionId: "mcp-gw9",
      oauthClientId: `client-${userId}`,
    }),
    principalKey: `tenant-gw9:${userId}`,
    issuedAtMs: 0,
    expiresAtMs: null,
  });
}

describe("GW-9 north MCP artifact resources", () => {
  let endpoint: NorthMcpEndpointHandle | undefined;
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  beforeEach(() => {
    endpoint = undefined;
    client = undefined;
    transport = undefined;
  });

  afterEach(async () => {
    await Promise.allSettled([
      client?.close() ?? Promise.resolve(),
      transport?.close() ?? Promise.resolve(),
      endpoint?.close() ?? Promise.resolve(),
    ]);
  });

  it("serves an uploaded CSV only through its authenticated MCP resource template", async () => {
    const registry = new GatewayToolRegistry(M2_BOOTSTRAP_TOOL_RECORDS);
    const row = registry.require("core.ui.state");
    const catalog = new EntitledCatalogView(
      [
        Object.freeze({
          name: row.name,
          summary: row.summary,
          namespace: row.namespace,
          version: row.version,
          policyClass: row.policyClass,
          mutationScopePolicy: row.mutationScopePolicy,
          executor: row.executor,
          tool: row.executorMethod,
          module: "runtime" as const,
          terms: Object.freeze([]),
          variants: Object.freeze([
            Object.freeze({
              plane: "live" as const,
              executor: row.executor,
              executorMethod: row.executorMethod,
              schemaOverlay: null,
              fidelityNotes: Object.freeze([]),
            }),
          ]),
        }),
      ],
      entitleAll,
    );
    const executor: GatewayExecutor = {
      binding: "bridge",
      async execute() {
        return { state: "completed", result: { ok: true } };
      },
    };
    const dispatcher = new GatewayDispatcher(registry, [executor], {
      eventSink: createCapturingEventSink(),
      eventSource: {
        component: "gateway-gw9-test",
        version: "0.0.0-test",
        instance: "gw9-test",
      },
      newInvocationId: () => "gw9-invocation-1",
      newEventId: () => "gw9-event-1",
      recoveryAuthority: createReadOnlyRecoveryAuthorityFixture(),
    });
    const storeFixture = createRestartableTestStore();
    await storeFixture.store.open();
    const refIds = ["uploaded-csv", "tool-result", "tool-result"];
    let refIndex = 0;
    const authority = new GatewayResourceAuthority({
      protocolStore: storeFixture.store,
      objectStore: createMemoryObjectStore(),
      now: () => 10_000,
      newRefId: () => refIds[refIndex++] ?? `extra-${String(refIndex)}`,
    });
    const owner = authContext("user-a");
    const ref = await authority.uploadArtifact({
      scope: resourceScopeFromAuth(owner, "mcp-gw9"),
      filename: "schedule.csv",
      contentType: "text/csv",
      quarantineStatus: "released",
      bytes: Buffer.from("mark,count\nA,2\n", "utf8"),
    });

    endpoint = await startNorthMcpEndpoint({
      dispatcher,
      registry,
      resourceAuthority: authority,
      resourceMaxInlineResultBytes: 1,
      catalogViewFor: () => catalog,
      invocationRouteFor: (authenticated, mcpSessionId, effectiveMcpRequestScope) => ({
        tenantId: authenticated.authContext.actor.tenantId,
        principalKey: authenticated.principalKey,
        mcpSessionId,
        effectiveMcpRequestScope,
        rsid: "019f9ac3-ae89-7342-9f6d-b9269e167184",
        documentIdentity: {
          kind: "live",
          session_document_id: "gw9-document",
        },
      }),
      requestState: { key: RESOURCE_STATE_KEY },
      resourceMetadataUrl: new URL(
        "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
      ),
      authenticator: {
        async authenticate(request) {
          const authorization = request.headers.authorization;
          const selected =
            authorization === "Bearer owner"
              ? owner
              : authorization === "Bearer foreign"
                ? authContext("user-b")
                : null;
          if (selected === null) {
            return null;
          }
          const authInfo: AuthInfo = {
            token: authorization!.slice("Bearer ".length),
            clientId: selected.session.oauthClientId ?? "client-unbound",
            scopes: ["mcp:tools"],
            resource: new URL("https://gateway.example.test/mcp"),
          };
          return Object.freeze({
            authInfo,
            authContext: selected,
            principalKey: selected.principalKey,
          });
        },
      },
    });

    client = new Client({ name: "GW-9 resource client", version: "0.1.0" });
    transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
      requestInit: { headers: { authorization: "Bearer owner" } },
    });
    await client.connect(transport);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(
      expect.arrayContaining([
        "revagent://artifact/{ref_id}",
        "revagent://result/{ref_id}/{page}",
      ]),
    );
    expect(registry.records().some((record) => record.name.includes("file_fetch"))).toBe(
      false,
    );
    const resource = await client.readResource({ uri: ref.uri });
    expect(resource.contents).toEqual([
      expect.objectContaining({
        uri: ref.uri,
        mimeType: "text/csv",
        blob: Buffer.from("mark,count\nA,2\n", "utf8").toString("base64"),
      }),
    ]);

    const toolResult = await client.callTool({
      name: "core.ui.state",
      arguments: {},
    });
    expect(toolResult.structuredContent).toMatchObject({
      kind: "result_ref",
      refId: "tool-result",
      uri: "revagent://result/tool-result/0",
    });
    const resultRef = toolResult.structuredContent as {
      readonly pageCount: number;
      readonly uri: string;
    };
    const pages: Buffer[] = [];
    for (let page = 0; page < resultRef.pageCount; page += 1) {
      const resourcePage = await client.readResource({
        uri: `revagent://result/tool-result/${String(page)}`,
      });
      const content = resourcePage.contents[0];
      if (content === undefined || !("blob" in content)) {
        throw new Error("expected a blob result page");
      }
      pages.push(Buffer.from(content.blob, "base64"));
    }
    expect(JSON.parse(Buffer.concat(pages).toString("utf8"))).toMatchObject({
      ok: true,
      state: "completed",
    });

    const deliveryFailure = await client.callTool({
      name: "core.ui.state",
      arguments: {},
    });
    expect(deliveryFailure).toMatchObject({
      isError: true,
      structuredContent: {
        state: "completed",
        executorOutcomePreserved: true,
        error: { code: "result_delivery_unavailable" },
      },
    });
    await expect(
      client.readResource({ uri: "revagent://result/tool-result/0" }),
    ).resolves.toMatchObject({
      contents: [expect.objectContaining({ blob: expect.any(String) })],
    });

    await client.close();
    client = new Client({ name: "GW-9 foreign client", version: "0.1.0" });
    transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
      requestInit: { headers: { authorization: "Bearer foreign" } },
    });
    await client.connect(transport);
    await expect(client.readResource({ uri: ref.uri })).rejects.toThrow();
  });
});
