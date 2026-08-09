import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createRequestStateCodec,
  type AuthInfo,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import {
  GatewayDispatcher,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayExecutorRequest,
  type GatewayJsonObject,
  type GatewayJsonValue,
} from "./dispatch.js";
import {
  EntitledCatalogView,
  buildCatalog,
  entitleAll,
  entitleOnly,
} from "./entitledRegistry.js";
import type { GatewayInvocationRoute } from "./invocationContext.js";
import {
  buildNorthFirstSliceCallableRegistry,
} from "./northFirstSlice.js";
import {
  type AuthenticatedNorthMcpRequest,
  type NorthMcpEndpointHandle,
  startNorthMcpEndpoint,
} from "./northMcpEndpoint.js";
import { verifyRegistrySeed } from "./registrySeed.js";
import { createCapturingEventSink } from "./testAdapters.js";

interface FixtureAddress {
  readonly host: string;
  readonly port: number;
}

interface FixtureLike {
  start(): Promise<FixtureAddress>;
  stop(): Promise<void>;
  getMethodExecutionCount(method: string): number;
}

interface FixtureModule {
  readonly AddinLoopbackFixture: new () => FixtureLike;
}

interface ProbeLike {
  readonly localSessionKey: string;
  readonly sessionCapabilities: readonly string[];
}

interface JournalLike {
  close(): void;
}

interface SimulatorLike {
  registrationForProbe(input: {
    readonly probe: ProbeLike;
    readonly requestId: string;
    readonly userHint: string;
    readonly hostname: string;
    readonly fingerprint: string;
    readonly bridgeVersion: string;
  }): Promise<unknown>;
  attachSession(input: {
    readonly rsid: string;
    readonly resumeToken: string;
    readonly resumeExpiresAt: string;
    readonly grantedSessionCapabilities: readonly string[];
    readonly probe: ProbeLike;
    readonly registration: unknown;
  }): unknown;
  invoke(envelope: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

interface SimulatorModule {
  readonly ArtifactSpool: new (
    root: string,
    nextId: () => string,
  ) => unknown;
  readonly BridgeSimulator: new (
    journal: JournalLike,
    spool: unknown,
  ) => SimulatorLike;
  readonly DeterministicUuid7Source: new () => {
    next(): string;
  };
  readonly DurableBridgeJournal: new (path: string) => JournalLike;
  readonly discoverAddinSessions: (input: {
    readonly explicitTarget: FixtureAddress;
  }) => Promise<{ readonly sessions: readonly ProbeLike[] }>;
}

const TOKEN = "m2-test-token";
const OTHER_TOKEN = "m2-other-test-token";
const PRINCIPAL_KEY = "tenant-a:user-a";
const REQUEST_STATE_KEY =
  "revagent-m2-request-state-test-key-32-bytes-minimum";
const REQUEST_STATE_TTL_SECONDS = 60;
const RSID = "019f9ac3-ae89-7342-9f6d-b9269e167184";
const REGISTRATION_ID = "019f9ac3-ae89-7342-9f6d-b9269e167185";
const ENVELOPE_IDS = [
  "019f9ac3-ae89-7342-9f6d-b9269e167186",
  "019f9ac3-ae89-7342-9f6d-b9269e167188",
  "019f9ac3-ae89-7342-9f6d-b9269e16718a",
] as const;
const INVOCATION_IDS = [
  "019f9ac3-ae89-7342-9f6d-b9269e167187",
  "019f9ac3-ae89-7342-9f6d-b9269e167189",
  "019f9ac3-ae89-7342-9f6d-b9269e16718b",
] as const;

function testAuthContext(
  principalKey: string,
  clientId: string,
  gatewaySessionId?: string,
): AuthContext {
  const userId = principalKey.endsWith(":user-b") ? "user-b" : "user-a";
  return Object.freeze({
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: Object.freeze({
      type: "user" as const,
      tenantId: "tenant-a",
      userId,
      role: "user" as const,
      oidcIssuer: "https://issuer.invalid/north-test",
      oidcSubject: `subject-${userId}`,
    }),
    session: Object.freeze({
      sessionId: gatewaySessionId ?? `gateway-${userId}`,
      clientType: "mcp" as const,
      mcpSessionId: null,
      oauthClientId: clientId,
    }),
    principalKey,
    issuedAtMs: 0,
    expiresAtMs: null,
  });
}

function authenticatedRequest(
  principalKey: string,
  authInfo: AuthInfo,
  gatewaySessionId?: string,
): AuthenticatedNorthMcpRequest {
  return Object.freeze({
    authInfo,
    authContext: testAuthContext(
      principalKey,
      authInfo.clientId,
      gatewaySessionId,
    ),
    principalKey,
  });
}

function invocationRouteFor(
  authenticated: AuthenticatedNorthMcpRequest,
  mcpSessionId: string,
): GatewayInvocationRoute {
  return Object.freeze({
    tenantId: authenticated.authContext.actor.tenantId,
    mcpSessionId,
    rsid: RSID,
    documentIdentity: Object.freeze({
      kind: "live" as const,
      session_document_id: "north-test-document",
    }),
    mutationScope: null,
  });
}

function dispatcherOptions() {
  let sequence = 0;
  return {
    eventSink: createCapturingEventSink(),
    eventSource: {
      component: "gateway-north-test",
      version: "0.0.0-test",
      instance: "north-test",
    },
    newInvocationId: () => `north-invocation-${++sequence}`,
    newEventId: () => `north-event-${sequence}`,
  } as const;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFIED_CATALOG = buildCatalog(
  verifyRegistrySeed(
    JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8"),
    ) as unknown,
  ),
);
const FULL_CATALOG_VIEW = new EntitledCatalogView(
  VERIFIED_CATALOG,
  entitleAll,
);
const NO_TOOLS_CATALOG_VIEW = new EntitledCatalogView(
  VERIFIED_CATALOG,
  entitleOnly([]),
);

async function loadFixtureModules(): Promise<{
  readonly fixture: FixtureModule;
  readonly simulator: SimulatorModule;
}> {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const fixtureUrl = pathToFileURL(
    resolve(
      sourceDirectory,
      "../../addin-loopback-fixture/dist/index.js",
    ),
  ).href;
  const simulatorUrl = pathToFileURL(
    resolve(sourceDirectory, "../../bridge-simulator/dist/index.js"),
  ).href;
  return {
    fixture: (await import(fixtureUrl)) as unknown as FixtureModule,
    simulator: (await import(simulatorUrl)) as unknown as SimulatorModule,
  };
}

function jsonRoundTrip(value: unknown): GatewayJsonValue {
  return JSON.parse(JSON.stringify(value)) as GatewayJsonValue;
}

function jsonObject(value: GatewayJsonValue): GatewayJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bridge simulator outcome must be a JSON object");
  }
  return value as GatewayJsonObject;
}

function recordingFetch(bodies: unknown[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      const text = await request.clone().text();
      if (text.length > 0) {
        bodies.push(JSON.parse(text) as unknown);
      }
    }
    return fetch(input, init);
  };
}

function recordedMethods(bodies: readonly unknown[]): string[] {
  return bodies.flatMap((body) => {
    const messages = Array.isArray(body) ? body : [body];
    return messages.flatMap((message) => {
      if (
        message !== null &&
        typeof message === "object" &&
        "method" in message &&
        typeof message.method === "string"
      ) {
        return [message.method];
      }
      return [];
    });
  });
}

function modernToolCallBody(
  protocolVersion: string,
  id: string,
  requestState?: string,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "core.ui.state",
      arguments: {},
      ...(requestState === undefined ? {} : { requestState }),
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        [CLIENT_INFO_META_KEY]: {
          name: "revAgent Gateway raw modern test",
          version: "0.1.0-m2",
        },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };
}

function testAuthBindingKey(input: {
  readonly principalKey: string;
  readonly authInfo: AuthInfo;
  readonly gatewaySessionId?: string;
}): string {
  const authenticated = authenticatedRequest(
    input.principalKey,
    input.authInfo,
    input.gatewaySessionId,
  );
  return JSON.stringify([
    authenticated.authContext.contractVersion,
    authenticated.authContext.actor.tenantId,
    authenticated.authContext.actor.userId,
    authenticated.authContext.actor.role,
    authenticated.authContext.actor.oidcIssuer,
    authenticated.authContext.actor.oidcSubject,
    authenticated.authContext.session.sessionId,
    authenticated.principalKey,
    input.authInfo.clientId,
    input.authInfo.resource?.href ?? null,
    [...input.authInfo.scopes].sort(),
  ]);
}

async function mintTestRequestState(input: {
  readonly principalKey: string;
  readonly authInfo: AuthInfo;
  readonly gatewaySessionId?: string;
  readonly method?: string;
  readonly ttlSeconds?: number;
}): Promise<string> {
  const codec = createRequestStateCodec({
    key: REQUEST_STATE_KEY,
    ttlSeconds: input.ttlSeconds ?? REQUEST_STATE_TTL_SECONDS,
    bind: (context) =>
      `${context.mcpReq.method}\0${testAuthBindingKey(input)}`,
  });
  return codec.mint(
    { round: 1 },
    {
      mcpReq: { method: input.method ?? "tools/call" },
    } as ServerContext,
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("M2 north MCP first slice", () => {
  it("exposes a registry index and dispatches one tool through the Bridge simulator", async () => {
    const temporaryRoot = mkdtempSync(
      join(tmpdir(), "revagent-gateway-m2-"),
    );
    const modules = await loadFixtureModules();
    const fixture = new modules.fixture.AddinLoopbackFixture();
    let endpoint: NorthMcpEndpointHandle | undefined;
    let legacyClient: Client | undefined;
    let legacyTransport: StreamableHTTPClientTransport | undefined;
    let modernClient: Client | undefined;
    let modernTransport: StreamableHTTPClientTransport | undefined;
    let otherClient: Client | undefined;
    let otherTransport: StreamableHTTPClientTransport | undefined;
    let simulator: SimulatorLike | undefined;
    let journal: JournalLike | undefined;

    try {
      const address = await fixture.start();
      const discovery = await modules.simulator.discoverAddinSessions({
        explicitTarget: address,
      });
      const probe = discovery.sessions[0];
      if (probe === undefined) {
        throw new Error("Bridge simulator did not discover the fixture");
      }

      journal = new modules.simulator.DurableBridgeJournal(
        join(temporaryRoot, "bridge.db"),
      );
      const ids = new modules.simulator.DeterministicUuid7Source();
      simulator = new modules.simulator.BridgeSimulator(
        journal,
        new modules.simulator.ArtifactSpool(
          join(temporaryRoot, "spool"),
          () => ids.next(),
        ),
      );
      const registration = await simulator.registrationForProbe({
        probe,
        requestId: REGISTRATION_ID,
        userHint: "gateway-test-user",
        hostname: "gateway-test-host",
        fingerprint: "gateway-test-fingerprint",
        bridgeVersion: "gateway-first-slice",
      });
      simulator.attachSession({
        rsid: RSID,
        resumeToken: "gateway-test-resume-token",
        resumeExpiresAt: "2026-07-26T00:00:00.000Z",
        grantedSessionCapabilities: probe.sessionCapabilities,
        probe,
        registration,
      });

      let sequence = 0;
      const executorRequests: GatewayExecutorRequest[] = [];
      const bridgeExecutor: GatewayExecutor = {
        binding: "bridge",
        async execute(request): Promise<GatewayExecutorOutcome> {
          sequence += 1;
          executorRequests.push(request);
          const envelopeId = ENVELOPE_IDS[sequence - 1];
          const invocationId = INVOCATION_IDS[sequence - 1];
          if (envelopeId === undefined || invocationId === undefined) {
            throw new Error("test invocation id budget exhausted");
          }
          const outcome = await simulator!.invoke({
            v: 1,
            type: "invoke",
            id: envelopeId,
            rsid: RSID,
            seq: sequence,
            ts: "2026-07-25T20:00:00.000Z",
            payload: {
              invocation_id: invocationId,
              method: request.executorMethod,
              params: request.args,
              timeout_ms: 5_000,
              mutating: false,
              mutation_scope: null,
              policy: {
                class: request.policyClass,
                decision: "auto",
                confirmation_id: null,
              },
              verification: null,
              recovery_clearances: [],
            },
          });
          const normalized = jsonObject(jsonRoundTrip(outcome));
          if (
            normalized.kind === "result" &&
            normalized.status === "completed"
          ) {
            return { state: "completed", result: normalized };
          }
          if (
            normalized.kind === "result" &&
            normalized.status === "guarded"
          ) {
            return {
              state: "guarded",
              reason:
                typeof normalized.guardedReason === "string"
                  ? normalized.guardedReason
                  : "Bridge guarded the invocation",
              result: normalized,
            };
          }
          return {
            state: "failed",
            error: {
              code:
                typeof normalized.kind === "string"
                  ? `bridge_${normalized.kind}`
                  : "bridge_invalid_outcome",
              message:
                typeof normalized.message === "string"
                  ? normalized.message
                  : "Bridge did not return a completed or guarded result",
            },
          };
        },
      };

      const registry = buildNorthFirstSliceCallableRegistry(VERIFIED_CATALOG);
      const dispatcher = new GatewayDispatcher(
        registry,
        [bridgeExecutor],
        dispatcherOptions(),
      );
      endpoint = await startNorthMcpEndpoint({
        dispatcher,
        registry,
        catalogViewFor: (authenticated) =>
          authenticated.principalKey === PRINCIPAL_KEY
            ? FULL_CATALOG_VIEW
            : NO_TOOLS_CATALOG_VIEW,
        invocationRouteFor,
        requestState: {
          key: REQUEST_STATE_KEY,
          ttlSeconds: REQUEST_STATE_TTL_SECONDS,
        },
        resourceMetadataUrl: new URL(
          "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
        ),
        authenticator: {
          async authenticate(request) {
            const authorization = request.headers.authorization;
            if (
              authorization !== `Bearer ${TOKEN}` &&
              authorization !== `Bearer ${OTHER_TOKEN}`
            ) {
              return null;
            }
            const otherPrincipal =
              authorization === `Bearer ${OTHER_TOKEN}`;
            const principalKey = otherPrincipal
              ? "tenant-a:user-b"
              : PRINCIPAL_KEY;
            const authInfo: AuthInfo = {
              token: otherPrincipal ? OTHER_TOKEN : TOKEN,
              clientId: otherPrincipal
                ? "claude-code-test"
                : "codex-desktop-test",
              scopes: ["mcp:tools"],
              expiresAt: 4_102_444_800,
              resource: new URL("https://gateway.example.test/mcp"),
              extra: {
                tenantId: "tenant-a",
                userId: otherPrincipal ? "user-b" : "user-a",
              },
            };
            return authenticatedRequest(principalKey, authInfo);
          },
        },
      });

      const unauthorized = await fetch(endpoint.endpoint, { method: "GET" });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain(
        "oauth-protected-resource",
      );

      const legacyBodies: unknown[] = [];
      legacyClient = new Client({
        name: "revAgent Gateway legacy test",
        version: "0.1.0-m2",
      });
      legacyTransport = new StreamableHTTPClientTransport(endpoint.endpoint, {
        fetch: recordingFetch(legacyBodies),
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      });
      await legacyClient.connect(legacyTransport);
      expect(legacyClient.getProtocolEra()).toBe("legacy");
      expect(legacyClient.getDiscoverResult()).toBeUndefined();
      expect(legacyTransport.sessionId).toBeUndefined();
      expect(recordedMethods(legacyBodies)).toContain("initialize");
      expect(recordedMethods(legacyBodies)).not.toContain("server/discover");

      expect(legacyClient.getInstructions()).toBe(
        FULL_CATALOG_VIEW.capabilityIndexBytes(),
      );
      const resources = await legacyClient.listResources();
      expect(resources.resources).toEqual([
        expect.objectContaining({
          uri: "revagent://capability-index",
          mimeType: "application/json",
        }),
      ]);
      const capabilityResource = await legacyClient.readResource({
        uri: "revagent://capability-index",
      });
      expect(capabilityResource.contents).toEqual([
        expect.objectContaining({
          uri: "revagent://capability-index",
          text: FULL_CATALOG_VIEW.capabilityIndexBytes(),
        }),
      ]);
      expect(FULL_CATALOG_VIEW.entries()).toHaveLength(40);
      expect(FULL_CATALOG_VIEW.capabilityIndex().tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "core.ui.state",
            schema: "deferred",
          }),
          expect.objectContaining({
            name: "core.code.execute",
            schema: "deferred",
          }),
        ]),
      );

      const legacyTools = await legacyClient.listTools();
      expect(legacyTools.tools.map((tool) => tool.name)).toEqual([
        "core.ui.state",
      ]);
      for (const tool of legacyTools.tools) {
        expect(tool.inputSchema).toEqual(
          registry.require(tool.name).inputJsonSchema,
        );
        expect(tool.inputSchema.properties).toEqual({});
      }
      expect(fixture.getMethodExecutionCount("mcp_status")).toBe(1);
      expect(fixture.getMethodExecutionCount("get_ui_state")).toBe(0);

      await expect(
        legacyClient.callTool({
          name: "core.code.execute",
          arguments: {},
        }),
      ).rejects.toMatchObject({ code: -32_602 });
      await expect(
        legacyClient.callTool({
          name: "core.ui.state",
          arguments: { target: "forged-client-route" },
        }),
      ).resolves.toMatchObject({ isError: true });
      expect(executorRequests).toHaveLength(0);

      const oversizedPost = await fetch(endpoint.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ oversized: "x".repeat(1024 * 1024) }),
      });
      expect(oversizedPost.status).toBe(413);
      await expect(oversizedPost.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32_600 },
        id: null,
      });

      const malformedPost = await fetch(endpoint.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: "{",
      });
      expect(malformedPost.status).toBe(400);
      await expect(malformedPost.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32_700 },
        id: null,
      });

      for (const body of ["{", ""]) {
        const unsupportedMediaTypePost = await fetch(endpoint.endpoint, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${TOKEN}`,
            "content-type": "text/plain",
          },
          body,
        });
        expect(unsupportedMediaTypePost.status).toBe(415);
        await expect(unsupportedMediaTypePost.json()).resolves.toEqual({
          jsonrpc: "2.0",
          error: {
            code: -32_000,
            message:
              "Unsupported Media Type: Content-Type must be application/json",
          },
          id: null,
        });
      }

      const emptyPost = await fetch(endpoint.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: "",
      });
      expect(emptyPost.status).toBe(400);
      await expect(emptyPost.json()).resolves.toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32_600,
          message: "request body is required",
        },
        id: null,
      });

      const legacyResult = await legacyClient.callTool({
        name: "core.ui.state",
        arguments: {},
      });
      expect(legacyResult.isError).not.toBe(true);
      expect(legacyResult.structuredContent).toMatchObject({
        ok: true,
        state: "completed",
        toolName: "core.ui.state",
        executor: "bridge",
        result: {
          kind: "result",
          status: "completed",
          addinContacted: true,
        },
      });
      expect(fixture.getMethodExecutionCount("get_ui_state")).toBe(1);
      expect(fixture.getMethodExecutionCount("mcp_status")).toBe(1);

      const modernBodies: unknown[] = [];
      modernClient = new Client(
        {
          name: "revAgent Gateway modern test",
          version: "0.1.0-m2",
        },
        {
          versionNegotiation: { mode: "auto" },
        },
      );
      modernTransport = new StreamableHTTPClientTransport(endpoint.endpoint, {
        fetch: recordingFetch(modernBodies),
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      });
      await modernClient.connect(modernTransport);
      expect(modernClient.getProtocolEra()).toBe("modern");
      expect(modernClient.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      expect(modernClient.getDiscoverResult()).toBeDefined();
      expect(recordedMethods(modernBodies)).toContain("server/discover");
      expect(recordedMethods(modernBodies)).not.toContain("initialize");
      expect(modernTransport.sessionId).toBeUndefined();

      const modernTools = await modernClient.listTools();
      expect(modernTools.tools.map((tool) => tool.name)).toEqual([
        "core.ui.state",
      ]);
      for (const tool of modernTools.tools) {
        expect(tool.inputSchema).toEqual(
          registry.require(tool.name).inputJsonSchema,
        );
      }
      const modernResult = await modernClient.callTool({
        name: "core.ui.state",
        arguments: {},
      });
      expect(modernResult.isError).not.toBe(true);
      expect(modernResult.structuredContent).toMatchObject({
        ok: true,
        state: "completed",
        toolName: "core.ui.state",
        executor: "bridge",
      });

      otherClient = new Client({
        name: "revAgent Gateway second-principal test",
        version: "0.1.0-m2",
      });
      otherTransport = new StreamableHTTPClientTransport(endpoint.endpoint, {
        requestInit: {
          headers: { authorization: `Bearer ${OTHER_TOKEN}` },
        },
      });
      await otherClient.connect(otherTransport);
      expect(otherClient.getInstructions()).toBe(
        NO_TOOLS_CATALOG_VIEW.capabilityIndexBytes(),
      );
      expect((await otherClient.listTools()).tools).toEqual([]);
      await expect(
        otherClient.callTool({
          name: "core.ui.state",
          arguments: {},
        }),
      ).rejects.toMatchObject({ code: -32_601 });

      expect(executorRequests).toHaveLength(2);
      expect(
        executorRequests.map(({ context }) => ({
          principalKey: context.principalKey,
          oauthClientId: context.oauthClientId,
          requestScope: context.mcpSessionId,
        })),
      ).toEqual([
        {
          principalKey: PRINCIPAL_KEY,
          oauthClientId: "codex-desktop-test",
          requestScope: expect.stringMatching(
            /^stateless-request:[0-9a-f-]{36}$/u,
          ),
        },
        {
          principalKey: PRINCIPAL_KEY,
          oauthClientId: "codex-desktop-test",
          requestScope: expect.stringMatching(
            /^stateless-request:[0-9a-f-]{36}$/u,
          ),
        },
      ]);
      expect(
        new Set(
          executorRequests.map(
            ({ context }) => context.mcpSessionId,
          ),
        ).size,
      ).toBe(2);

      const versionMismatch = await fetch(endpoint.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "core.ui.state",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify(
          modernToolCallBody("2026-07-28", "version-mismatch"),
        ),
      });
      expect(versionMismatch.status).toBe(400);
      await expect(versionMismatch.json()).resolves.toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32_020,
          message:
            "Bad Request: the request headers and body disagree: " +
            "the body envelope names protocol version 2026-07-28 but " +
            "the MCP-Protocol-Version header names 2025-11-25",
          data: {
            mismatch: {
              header: "2025-11-25",
              body:
                "the body envelope names protocol version 2026-07-28 but " +
                "the MCP-Protocol-Version header names 2025-11-25",
            },
          },
        },
        id: "version-mismatch",
      });

      const unsupportedVersion = await fetch(endpoint.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "core.ui.state",
          "mcp-protocol-version": "2030-01-01",
        },
        body: JSON.stringify(
          modernToolCallBody("2030-01-01", "unsupported-version"),
        ),
      });
      expect(unsupportedVersion.status).toBe(400);
      await expect(unsupportedVersion.json()).resolves.toEqual({
        jsonrpc: "2.0",
        error: {
          code: -32_022,
          message: "Unsupported protocol version: 2030-01-01",
          data: {
            supported: ["2026-07-28"],
            requested: "2030-01-01",
          },
        },
        id: "unsupported-version",
      });
      expect(executorRequests).toHaveLength(2);

      const statelessGet = await fetch(endpoint.endpoint, {
        method: "GET",
        headers: {
          authorization: `Bearer ${TOKEN}`,
        },
      });
      expect(statelessGet.status).toBe(405);
      await expect
        .poll(() => endpoint?.activeRequestCount() ?? -1)
        .toBe(0);
    } finally {
      await Promise.allSettled([
        legacyClient?.close(),
        legacyTransport?.close(),
        modernClient?.close(),
        modernTransport?.close(),
        otherClient?.close(),
        otherTransport?.close(),
      ]);
      await endpoint?.close();
      simulator?.close();
      journal?.close();
      await fixture.stop();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("verifies signed requestState before dispatch and binds it to actor, Gateway session, and method", async () => {
    const reorderedScopesToken = "m2-reordered-scopes-test-token";
    const crossClientToken = "m2-cross-client-test-token";
    const crossResourceToken = "m2-cross-resource-test-token";
    const crossScopeToken = "m2-cross-scope-test-token";
    const crossSessionToken = "m2-cross-session-test-token";
    const resource = new URL("https://gateway.example.test/mcp");
    const registry = buildNorthFirstSliceCallableRegistry(VERIFIED_CATALOG);
    const executorRequests: GatewayExecutorRequest[] = [];
    const dispatcher = new GatewayDispatcher(
      registry,
      [
        {
          binding: "bridge",
          async execute(
            request: GatewayExecutorRequest,
          ): Promise<GatewayExecutorOutcome> {
            executorRequests.push(request);
            return {
              state: "completed",
              result: { acceptedRequestState: true },
            };
          },
        },
      ],
      dispatcherOptions(),
    );
    const primaryAuthInfo: AuthInfo = {
      token: TOKEN,
      clientId: "request-state-client",
      scopes: ["mcp:resources", "mcp:tools"],
      resource,
    };
    const otherAuthInfo: AuthInfo = {
      token: OTHER_TOKEN,
      clientId: "request-state-client",
      scopes: ["mcp:resources", "mcp:tools"],
      resource,
    };
    const reorderedScopesAuthInfo: AuthInfo = {
      token: reorderedScopesToken,
      clientId: "request-state-client",
      scopes: ["mcp:tools", "mcp:resources"],
      resource,
    };
    const crossClientAuthInfo: AuthInfo = {
      token: crossClientToken,
      clientId: "request-state-other-client",
      scopes: ["mcp:resources", "mcp:tools"],
      resource,
    };
    const crossResourceAuthInfo: AuthInfo = {
      token: crossResourceToken,
      clientId: "request-state-client",
      scopes: ["mcp:resources", "mcp:tools"],
      resource: new URL("https://gateway.example.test/other-mcp"),
    };
    const crossScopeAuthInfo: AuthInfo = {
      token: crossScopeToken,
      clientId: "request-state-client",
      scopes: ["mcp:tools"],
      resource,
    };
    const crossSessionAuthInfo: AuthInfo = {
      token: crossSessionToken,
      clientId: "request-state-client",
      scopes: ["mcp:resources", "mcp:tools"],
      resource,
    };
    const authByAuthorization = new Map<
      string,
      AuthenticatedNorthMcpRequest
    >([
      [
        `Bearer ${TOKEN}`,
        authenticatedRequest(PRINCIPAL_KEY, primaryAuthInfo),
      ],
      [
        `Bearer ${OTHER_TOKEN}`,
        authenticatedRequest("tenant-a:user-b", otherAuthInfo),
      ],
      [
        `Bearer ${reorderedScopesToken}`,
        authenticatedRequest(PRINCIPAL_KEY, reorderedScopesAuthInfo),
      ],
      [
        `Bearer ${crossClientToken}`,
        authenticatedRequest(PRINCIPAL_KEY, crossClientAuthInfo),
      ],
      [
        `Bearer ${crossResourceToken}`,
        authenticatedRequest(PRINCIPAL_KEY, crossResourceAuthInfo),
      ],
      [
        `Bearer ${crossScopeToken}`,
        authenticatedRequest(PRINCIPAL_KEY, crossScopeAuthInfo),
      ],
      [
        `Bearer ${crossSessionToken}`,
        authenticatedRequest(
          PRINCIPAL_KEY,
          crossSessionAuthInfo,
          "gateway-user-a-other-session",
        ),
      ],
    ]);
    let endpoint: NorthMcpEndpointHandle | undefined;

    try {
      endpoint = await startNorthMcpEndpoint({
        dispatcher,
        registry,
        catalogViewFor: () => FULL_CATALOG_VIEW,
        invocationRouteFor,
        requestState: {
          key: REQUEST_STATE_KEY,
          ttlSeconds: REQUEST_STATE_TTL_SECONDS,
        },
        resourceMetadataUrl: new URL(
          "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
        ),
        authenticator: {
          async authenticate(request) {
            return authByAuthorization.get(
              request.headers.authorization ?? "",
            ) ?? null;
          },
        },
      });

      const validState = await mintTestRequestState({
        principalKey: PRINCIPAL_KEY,
        authInfo: primaryAuthInfo,
      });
      const expiredState = await mintTestRequestState({
        principalKey: PRINCIPAL_KEY,
        authInfo: primaryAuthInfo,
        ttlSeconds: -1,
      });
      const wrongMethodState = await mintTestRequestState({
        principalKey: PRINCIPAL_KEY,
        authInfo: primaryAuthInfo,
        method: "prompts/get",
      });
      const macStart = validState.lastIndexOf(".") + 1;
      const firstMacCharacter = validState.charAt(macStart);
      const tamperedState =
        validState.slice(0, macStart) +
        (firstMacCharacter === "A" ? "B" : "A") +
        validState.slice(macStart + 1);
      const postState = (
        token: string,
        id: string,
        requestState: string,
      ) =>
        fetch(endpoint!.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-method": "tools/call",
            "mcp-name": "core.ui.state",
            "mcp-protocol-version": "2026-07-28",
          },
          body: JSON.stringify(
            modernToolCallBody("2026-07-28", id, requestState),
          ),
        });

      const validResponse = await postState(
        TOKEN,
        "valid-request-state",
        validState,
      );
      expect(validResponse.status).toBe(200);
      await expect(validResponse.json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: "valid-request-state",
        result: {
          structuredContent: {
            ok: true,
            state: "completed",
            result: { acceptedRequestState: true },
          },
        },
      });
      expect(executorRequests).toHaveLength(1);

      const reorderedScopesResponse = await postState(
        reorderedScopesToken,
        "reordered-scopes-request-state",
        validState,
      );
      expect(reorderedScopesResponse.status).toBe(200);
      await expect(
        reorderedScopesResponse.json(),
      ).resolves.toMatchObject({
        jsonrpc: "2.0",
        id: "reordered-scopes-request-state",
        result: {
          structuredContent: {
            ok: true,
            state: "completed",
            result: { acceptedRequestState: true },
          },
        },
      });
      expect(executorRequests).toHaveLength(2);

      for (const rejection of [
        {
          id: "tampered-request-state",
          state: tamperedState,
          token: TOKEN,
        },
        {
          id: "expired-request-state",
          state: expiredState,
          token: TOKEN,
        },
        {
          id: "cross-principal-request-state",
          state: validState,
          token: OTHER_TOKEN,
        },
        {
          id: "cross-method-request-state",
          state: wrongMethodState,
          token: TOKEN,
        },
        {
          id: "cross-client-request-state",
          state: validState,
          token: crossClientToken,
        },
        {
          id: "cross-resource-request-state",
          state: validState,
          token: crossResourceToken,
        },
        {
          id: "cross-scope-request-state",
          state: validState,
          token: crossScopeToken,
        },
        {
          id: "cross-gateway-session-request-state",
          state: validState,
          token: crossSessionToken,
        },
      ]) {
        const response = await postState(
          rejection.token,
          rejection.id,
          rejection.state,
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
          jsonrpc: "2.0",
          error: {
            code: -32_602,
            message: "Invalid or expired requestState",
            data: { reason: "invalid_request_state" },
          },
          id: rejection.id,
        });
      }
      expect(executorRequests).toHaveLength(2);
    } finally {
      await endpoint?.close().catch(() => undefined);
    }
  });

  it.each(["legacy", "modern"] as const)(
    "drains an in-flight %s dispatch before close resolves",
    async (era) => {
      const started = deferred<void>();
      const release = deferred<void>();
      const registry = buildNorthFirstSliceCallableRegistry(VERIFIED_CATALOG);
      const dispatcher = new GatewayDispatcher(
        registry,
        [
          {
            binding: "bridge",
            async execute(): Promise<GatewayExecutorOutcome> {
              started.resolve(undefined);
              await release.promise;
              return {
                state: "completed",
                result: { completedAfterCloseStarted: true, era },
              };
            },
          },
        ],
        dispatcherOptions(),
      );
      let endpoint: NorthMcpEndpointHandle | undefined;
      let client: Client | undefined;
      let transport: StreamableHTTPClientTransport | undefined;
      let closePromise: Promise<void> | undefined;

      try {
        endpoint = await startNorthMcpEndpoint({
          dispatcher,
          registry,
          catalogViewFor: () => FULL_CATALOG_VIEW,
          invocationRouteFor,
          requestState: {
            key: REQUEST_STATE_KEY,
            ttlSeconds: REQUEST_STATE_TTL_SECONDS,
          },
          resourceMetadataUrl: new URL(
            "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
          ),
          authenticator: {
            async authenticate(request) {
              if (
                request.headers.authorization !== `Bearer ${TOKEN}`
              ) {
                return null;
              }
              const authInfo: AuthInfo = {
                token: TOKEN,
                clientId: "close-drain-test",
                scopes: ["mcp:tools"],
              };
              return authenticatedRequest(PRINCIPAL_KEY, authInfo);
            },
          },
        });
        client = new Client(
          {
            name: `revAgent Gateway ${era} close-drain test`,
            version: "0.1.0-m2",
          },
          era === "modern"
            ? { versionNegotiation: { mode: "auto" } }
            : undefined,
        );
        transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
          requestInit: {
            headers: { authorization: `Bearer ${TOKEN}` },
          },
        });
        await client.connect(transport);

        const callPromise = client.callTool({
          name: "core.ui.state",
          arguments: {},
        }).catch(() => undefined);
        await started.promise;
        expect(endpoint.activeRequestCount()).toBe(1);

        let closeResolved = false;
        closePromise = endpoint.close().then(() => {
          closeResolved = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(closeResolved).toBe(false);

        release.resolve(undefined);
        await closePromise;
        expect(endpoint.activeRequestCount()).toBe(0);
        await callPromise;
      } finally {
        release.resolve(undefined);
        await closePromise?.catch(() => undefined);
        await client?.close().catch(() => undefined);
        await transport?.close().catch(() => undefined);
        await endpoint?.close().catch(() => undefined);
      }
    },
    15_000,
  );
});
