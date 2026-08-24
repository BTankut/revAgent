import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createRequestStateCodec,
  type AuthInfo,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type AuthContext,
} from "./authContext.js";
import {
  GatewayDispatcher,
  type GatewayDispatchOutcome,
  type GatewayExecutor,
  type GatewayExecutorOutcome,
  type GatewayExecutorRequest,
  type GatewayJsonObject,
  type GatewayJsonValue,
} from "./dispatch.js";
import {
  gatewayExternalToolInputJsonSchema,
} from "./confirmation.js";
import {
  EntitledCatalogView,
  buildCatalog,
  entitleAll,
  entitleOnly,
} from "./entitledRegistry.js";
import {
  buildGatewayInstructionPackage,
  gatewayClientInstructions,
} from "./instructionPackage.js";
import {
  createEffectiveMcpRequestScopeV1,
  type EffectiveMcpRequestScopeV1,
  type GatewayInvocationRoute,
} from "./invocationContext.js";
import { isGatewayUuidV7 } from "./identifiers.js";
import { buildNorthFirstSliceCallableRegistry } from "./northFirstSlice.js";
import {
  type AuthenticatedNorthMcpRequest,
  type AuthorizedNorthMcpRequest,
  type NorthMcpEndpointHandle,
  startNorthMcpEndpoint,
} from "./northMcpEndpoint.js";
import type { GatewayResourceAuthority } from "./resourceAuthority.js";
import {
  GatewayToolRegistry,
  type GatewayToolRecord,
} from "./registry.js";
import { verifyRegistrySeed } from "./registrySeed.js";
import {
  createCapturingEventSink,
  createReadOnlyRecoveryAuthorityFixture,
} from "./testAdapters.js";

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
  readonly ArtifactSpool: new (root: string, nextId: () => string) => unknown;
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
const REQUEST_STATE_KEY = "revagent-m2-request-state-test-key-32-bytes-minimum";
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
  mcpSessionId?: string,
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
      mcpSessionId: mcpSessionId ?? null,
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
  mcpSessionId?: string,
): AuthenticatedNorthMcpRequest {
  return Object.freeze({
    authInfo,
    authContext: testAuthContext(
      principalKey,
      authInfo.clientId,
      gatewaySessionId,
      mcpSessionId,
    ),
    principalKey,
  });
}

function invocationRouteFor(
  authenticated: AuthorizedNorthMcpRequest,
  mcpSessionId: string,
  effectiveMcpRequestScope: EffectiveMcpRequestScopeV1,
): GatewayInvocationRoute {
  expect(authenticated.authInfo).not.toHaveProperty("token");
  expect(authenticated.authInfo).not.toHaveProperty("extra");
  return Object.freeze({
    tenantId: authenticated.authContext.actor.tenantId,
    principalKey: authenticated.principalKey,
    mcpSessionId,
    effectiveMcpRequestScope,
    rsid: RSID,
    documentIdentity: Object.freeze({
      kind: "live" as const,
      session_document_id: "north-test-document",
    }),
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
    recoveryAuthority: createReadOnlyRecoveryAuthorityFixture(),
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
const FULL_CATALOG_VIEW = new EntitledCatalogView(VERIFIED_CATALOG, entitleAll);
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
    resolve(sourceDirectory, "../../addin-loopback-fixture/dist/index.js"),
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
    authenticated.authContext.session.mcpSessionId,
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
    bind: (context) => `${context.mcpReq.method}\0${testAuthBindingKey(input)}`,
  });
  return codec.mint({ round: 1 }, {
    mcpReq: { method: input.method ?? "tools/call" },
  } as ServerContext);
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
  it("binds one immutable effective MCP scope and mints a UUIDv7 only for stateless requests", () => {
    const transportOnly = createEffectiveMcpRequestScopeV1({
      principalKey: PRINCIPAL_KEY,
      transportMcpSessionId: "transport-session",
      identityMcpSessionId: null,
      nowMs: 1_775_000_000_000,
    });
    const identityOnly = createEffectiveMcpRequestScopeV1({
      principalKey: PRINCIPAL_KEY,
      transportMcpSessionId: null,
      identityMcpSessionId: "identity-session",
      nowMs: 1_775_000_000_000,
    });
    const stateless = createEffectiveMcpRequestScopeV1({
      principalKey: PRINCIPAL_KEY,
      transportMcpSessionId: null,
      identityMcpSessionId: null,
      nowMs: 1_775_000_000_000,
    });
    const secondStateless = createEffectiveMcpRequestScopeV1({
      principalKey: PRINCIPAL_KEY,
      transportMcpSessionId: null,
      identityMcpSessionId: null,
      nowMs: 1_775_000_000_001,
    });

    expect(transportOnly.effectiveMcpSessionId).toBe("transport-session");
    expect(identityOnly.effectiveMcpSessionId).toBe("identity-session");
    expect(stateless.effectiveMcpSessionId).toMatch(/^stateless-request:/u);
    expect(isGatewayUuidV7(stateless.effectiveMcpSessionId.slice(18))).toBe(true);
    expect(secondStateless.effectiveMcpSessionId).not.toBe(
      stateless.effectiveMcpSessionId,
    );
    expect(Object.isFrozen(stateless)).toBe(true);
  });

  it("rejects a transport/identity session mismatch before route resolution or dispatch", async () => {
    const registry = buildNorthFirstSliceCallableRegistry(VERIFIED_CATALOG);
    const dispatcher = new GatewayDispatcher(
      registry,
      [
        {
          binding: "bridge",
          async execute(): Promise<GatewayExecutorOutcome> {
            return { state: "completed", result: { unexpected: true } };
          },
        },
      ],
      dispatcherOptions(),
    );
    const dispatchSpy = vi.spyOn(dispatcher, "dispatch");
    const routeSpy = vi.fn(invocationRouteFor);
    const authInfo: AuthInfo = {
      token: TOKEN,
      clientId: "wp09-mismatch",
      scopes: ["mcp:tools"],
    };
    const endpoint = await startNorthMcpEndpoint({
      dispatcher,
      registry,
      catalogViewFor: () => FULL_CATALOG_VIEW,
      invocationRouteFor: routeSpy,
      requestState: { key: REQUEST_STATE_KEY },
      resourceMetadataUrl: new URL(
        "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
      ),
      authenticator: {
        async authenticate(request) {
          return request.headers.authorization === `Bearer ${TOKEN}`
            ? authenticatedRequest(
                PRINCIPAL_KEY,
                authInfo,
                "gateway-wp09",
                "identity-session",
              )
            : null;
        },
      },
    });
    try {
      const response = await fetch(endpoint.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": "transport-session",
        },
        body: JSON.stringify(modernToolCallBody("2026-07-28", "wp09-mismatch")),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(routeSpy).not.toHaveBeenCalled();
    } finally {
      await endpoint.close().catch(() => undefined);
    }
  });

  it("keeps each request-local effective scope object across applicable north boundaries", async () => {
    type Boundary = "mode_a" | "resource" | "route" | "dispatch" | "result";
    const observed: Array<{
      readonly boundary: Boundary;
      readonly scope: EffectiveMcpRequestScopeV1;
    }> = [];
    const routeScopes: EffectiveMcpRequestScopeV1[] = [];
    const executorScopes: EffectiveMcpRequestScopeV1[] = [];
    const resultScopes: EffectiveMcpRequestScopeV1[] = [];
    const resourceScopes: EffectiveMcpRequestScopeV1[] = [];
    const eventSink = createCapturingEventSink();
    const registry = buildNorthFirstSliceCallableRegistry(VERIFIED_CATALOG);
    const catalogEntry = FULL_CATALOG_VIEW.get("core.ui.state");
    if (catalogEntry === undefined) {
      throw new Error("combined scope oracle catalog entry is unavailable");
    }
    const catalogView = new EntitledCatalogView([catalogEntry], entitleAll);
    const dispatcher = new GatewayDispatcher(
      registry,
      [
        {
          binding: "bridge",
          async execute(request): Promise<GatewayExecutorOutcome> {
            const scope = request.context.effectiveMcpRequestScope;
            if (scope === undefined) {
              throw new Error("north dispatch omitted the effective MCP scope");
            }
            executorScopes.push(scope);
            return { state: "completed", result: { bounded: true } };
          },
        },
      ],
      {
        ...dispatcherOptions(),
        eventSink,
      },
    );
    const dispatchSpy = vi.spyOn(dispatcher, "dispatch");
    const resourceAuthority: Pick<
      GatewayResourceAuthority,
      "boundResult" | "readResource"
    > = {
      async boundResult(input) {
        resultScopes.push(input.effectiveMcpRequestScope);
        return Object.freeze({ kind: "inline" as const, value: input.value });
      },
      async readResource(_scope, effectiveMcpRequestScope, uri) {
        resourceScopes.push(effectiveMcpRequestScope);
        return Object.freeze({
          uri: uri.href,
          contentType: "application/json",
          bytes: Buffer.from("{}", "utf8"),
          digest: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
          nextPageUri: null,
        });
      },
    };
    const options = {
      dispatcher,
      registry,
      catalogViewFor: () => catalogView,
      invocationRouteFor: (
        authenticated: AuthorizedNorthMcpRequest,
        mcpSessionId: string,
        effectiveMcpRequestScope: EffectiveMcpRequestScopeV1,
      ) => {
        routeScopes.push(effectiveMcpRequestScope);
        return invocationRouteFor(
          authenticated,
          mcpSessionId,
          effectiveMcpRequestScope,
        );
      },
      requestState: { key: REQUEST_STATE_KEY },
      modeA: {
        schemaBudgetBytes: 0,
        pinnedToolNames: ["core.ui.state"],
      },
      resourceAuthority,
      resourceMetadataUrl: new URL(
        "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
      ),
      authenticator: {
        async authenticate(request: IncomingMessage) {
          return request.headers.authorization === `Bearer ${TOKEN}`
            ? authenticatedRequest(PRINCIPAL_KEY, {
                token: TOKEN,
                clientId: "wp09-combined-oracle",
                scopes: ["mcp:resources", "mcp:tools"],
              })
            : null;
        },
      },
    };
    Object.defineProperty(options, "__revAgentTestObserveEffectiveMcpScope", {
      configurable: true,
      enumerable: false,
      value: (entry: {
        readonly boundary: Boundary;
        readonly scope: EffectiveMcpRequestScopeV1;
      }) => observed.push(entry),
    });
    expect(Object.keys(options)).not.toContain(
      "__revAgentTestObserveEffectiveMcpScope",
    );

    let endpoint: NorthMcpEndpointHandle | undefined;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;
    try {
      endpoint = await startNorthMcpEndpoint(options);
      client = new Client({
        name: "wp09 combined scope oracle",
        version: "0.0.0-test",
      });
      transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      });
      await client.connect(transport);
      await expect(
        client.callTool({ name: "core.ui.state", arguments: {} }),
      ).resolves.toMatchObject({
        structuredContent: { result: { bounded: true } },
      });
      await expect(
        client.readResource({
          uri: `revagent://artifact/p/${"a".repeat(64)}/s/${"b".repeat(64)}/t/${"c".repeat(64)}/a/${"d".repeat(64)}/r/${"e".repeat(64)}`,
        }),
      ).resolves.toMatchObject({ contents: [{ mimeType: "application/json" }] });

      const toolScope = routeScopes.at(-1);
      const dispatchScope = dispatchSpy.mock.calls.at(-1)?.[0]
        .effectiveMcpRequestScope;
      const contextScope = executorScopes.at(-1);
      const auditScope = eventSink
        .captured()
        .map((event) =>
          Object.getOwnPropertyDescriptor(event, "effectiveMcpRequestScope")
            ?.value,
        )
        .find((scope): scope is EffectiveMcpRequestScopeV1 => scope !== undefined);
      const resultScope = resultScopes.at(-1);
      const resourceScope = resourceScopes.at(-1);
      if (
        toolScope === undefined ||
        dispatchScope === undefined ||
        contextScope === undefined ||
        auditScope === undefined ||
        resultScope === undefined ||
        resourceScope === undefined
      ) {
        throw new Error("combined scope oracle did not reach every required boundary");
      }

      const requestBoundaryTable = [
        ["tool route", toolScope, toolScope],
        ["tool dispatch", dispatchScope, toolScope],
        ["tool context", contextScope, toolScope],
        ["tool audit", auditScope, toolScope],
        ["tool result", resultScope, toolScope],
        ["tool Mode-A", observed.find((entry) => entry.boundary === "mode_a" && entry.scope === toolScope)?.scope, toolScope],
        ["resource read", resourceScope, resourceScope],
        ["resource observer", observed.find((entry) => entry.boundary === "resource" && entry.scope === resourceScope)?.scope, resourceScope],
        ["resource Mode-A", observed.find((entry) => entry.boundary === "mode_a" && entry.scope === resourceScope)?.scope, resourceScope],
      ] as const;
      for (const [boundary, actual, expected] of requestBoundaryTable) {
        expect(actual, boundary).toBe(expected);
        expect(Object.isFrozen(actual)).toBe(true);
      }
      expect(observed.some((entry) => entry.boundary === "dispatch" && entry.scope === toolScope)).toBe(true);
      expect(observed.some((entry) => entry.boundary === "route" && entry.scope === toolScope)).toBe(true);
      expect(observed.some((entry) => entry.boundary === "result" && entry.scope === toolScope)).toBe(true);
    } finally {
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      await endpoint?.close().catch(() => undefined);
    }
  }, 15_000);

  it("returns a fixed, message-free failure after post-dispatch result delivery fails", async () => {
    const registry = buildNorthFirstSliceCallableRegistry(VERIFIED_CATALOG);
    const record = registry.require("core.ui.state");
    const catalogEntry = FULL_CATALOG_VIEW.get(record.name);
    if (catalogEntry === undefined) throw new Error("delivery test catalog entry is unavailable");
    const dispatcher = new GatewayDispatcher(registry, [{
      binding: "bridge",
      async execute(): Promise<GatewayExecutorOutcome> {
        return { state: "completed", result: {} };
      },
    }], dispatcherOptions());
    const outcomes: GatewayDispatchOutcome[] = [
      {
        ok: true, state: "completed", toolName: record.name, toolVersion: record.version,
        executor: record.executor, requestId: "delivery-secret-completed", result: { committed: true },
      },
      {
        ok: true, state: "guarded", toolName: record.name, toolVersion: record.version,
        executor: record.executor, requestId: "delivery-secret-guarded", guardedReason: "guard-secret", result: { guarded: true },
      },
      {
        ok: false, state: "failed", toolName: record.name, requestId: "delivery-secret-not-reached",
        executorReached: false, error: { code: "executor_failed", message: "must-not-leak" },
      },
      {
        ok: false, state: "failed", toolName: record.name, requestId: "delivery-secret-reached",
        executorReached: true, error: { code: "executor_failed", message: "must-not-leak" },
      },
      {
        ok: true, state: "confirmation_required", toolName: record.name, toolVersion: record.version,
        executor: record.executor, requestId: "delivery-secret-confirmation", result: { preview: true },
        confirmation: {
          confirmToken: "confirmation-secret", confirmationId: "019f9ac3-ae89-7342-9f6d-b9269e1671ff",
          originatingPreviewInvocationId: "019f9ac3-ae89-7342-9f6d-b9269e1671fe",
          previewDigest: `sha256:${"a".repeat(64)}`, previewRef: "inline:secret",
          commitArgsDigest: `sha256:${"b".repeat(64)}`, expiresAtMs: 1,
        },
      },
      {
        ok: true, state: "future_dispatch_state", toolName: record.name, toolVersion: record.version,
        executor: record.executor, requestId: "delivery-secret-unknown", result: { secret: true },
      } as unknown as GatewayDispatchOutcome,
    ];
    vi.spyOn(dispatcher, "dispatch").mockImplementation(async () => {
      const next = outcomes.shift();
      if (next === undefined) throw new Error("unexpected delivery test dispatch");
      return next;
    });
    const resourceAuthority: Pick<GatewayResourceAuthority, "boundResult" | "readResource"> = {
      async boundResult() { throw new Error("delivery exception must not leak"); },
      async readResource() { throw new Error("not used"); },
    };
    let endpoint: NorthMcpEndpointHandle | undefined;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;
    try {
      endpoint = await startNorthMcpEndpoint({
        dispatcher,
        registry,
        catalogViewFor: () => new EntitledCatalogView([catalogEntry], entitleAll),
        invocationRouteFor,
        requestState: { key: REQUEST_STATE_KEY },
        resourceAuthority,
        resourceMetadataUrl: new URL("https://gateway.example.test/.well-known/oauth-protected-resource/mcp"),
        authenticator: {
          async authenticate(request) {
            return request.headers.authorization === `Bearer ${TOKEN}`
              ? authenticatedRequest(PRINCIPAL_KEY, { token: TOKEN, clientId: "delivery-failure", scopes: ["mcp:tools"] })
              : null;
          },
        },
      });
      client = new Client({ name: "post-dispatch delivery test", version: "0.0.0-test" });
      transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      });
      await client.connect(transport);
      const cases = [
        ["completed", true, true, "completed", "delivery-secret-completed"],
        ["guarded", true, true, "guarded", "delivery-secret-guarded"],
        ["failed", false, false, null, "delivery-secret-not-reached"],
        ["failed", false, true, null, "delivery-secret-reached"],
        ["confirmation_required", true, true, null, "delivery-secret-confirmation"],
        ["failed", true, true, null, "delivery-secret-unknown"],
      ] as const;
      for (const [dispatchState, dispatchOk, executorReached, terminalKnown, requestId] of cases) {
        const result = await client.callTool({ name: record.name, arguments: {} });
        const requestIdDigest = `sha256:${createHash("sha256")
          .update("revagent:north-mcp:post-dispatch-delivery:v1\0", "utf8")
          .update(requestId, "utf8").digest("hex")}`;
        expect(result.isError).toBe(true);
        expect(result.content).toHaveLength(1);
        expect(result.structuredContent).toEqual({
          ok: false,
          state: "failed",
          toolName: record.name,
          requestIdDigest,
          error: { code: "result_delivery_unavailable" },
          delivery: {
            phase: "post_dispatch", dispatchState, dispatchOk, executorReached, terminalKnown,
            mutationDisposition: "not_reclassified",
          },
          resultContractVersion: 2,
        });
        expect(JSON.parse((result.content[0] as { readonly text: string }).text)).toEqual(result.structuredContent);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(requestId);
        for (const forbidden of ["message", "audit", "cause", "params", "artifacts", "tokens"]) {
          expect(serialized).not.toContain(forbidden);
        }
      }
    } finally {
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      await endpoint?.close().catch(() => undefined);
    }
  });

  it("threads an ordinary MCP confirmation re-invocation without exposing controls to functional args", async () => {
    const catalogEntry = FULL_CATALOG_VIEW.get("core.parameter.set");
    if (catalogEntry === undefined) {
      throw new Error("confirm test catalog entry is unavailable");
    }
    const inputSchema = {
      value: z.string().min(1),
      mode: z.enum(["dryRun", "commit"]).optional(),
    };
    const record: GatewayToolRecord = Object.freeze({
      name: catalogEntry.name,
      summary: catalogEntry.summary,
      namespace: catalogEntry.namespace,
      version: catalogEntry.version,
      policyClass: catalogEntry.policyClass,
      mutationScopePolicy: catalogEntry.mutationScopePolicy,
      executor: catalogEntry.executor,
      executorMethod: catalogEntry.tool,
      inputSchema,
      inputJsonSchema: z.toJSONSchema(z.object(inputSchema).strict(), {
        io: "input",
      }),
    });
    const registry = new GatewayToolRegistry([record]);
    const dispatcher = new GatewayDispatcher(
      registry,
      [
        {
          binding: "bridge",
          async execute(): Promise<GatewayExecutorOutcome> {
            throw new Error("spied north confirmation test reached executor");
          },
        },
      ],
      dispatcherOptions(),
    );
    const previewInvocationId =
      "019f9ac3-ae89-7342-9f6d-b9269e167190";
    const confirmationId = "019f9ac3-ae89-7342-9f6d-b9269e167191";
    const commitInvocationId = "019f9ac3-ae89-7342-9f6d-b9269e167192";
    const digest = `sha256:${"a".repeat(64)}` as const;
    const confirmToken = `${confirmationId}.${"t".repeat(43)}`;
    const previewOutcome: GatewayDispatchOutcome = {
      ok: true,
      state: "confirmation_required",
      toolName: record.name,
      toolVersion: record.version,
      executor: record.executor,
      requestId: previewInvocationId,
      result: { preview: "bounded", writes: 0 },
      confirmation: {
        confirmToken,
        confirmationId,
        originatingPreviewInvocationId: previewInvocationId,
        previewDigest: digest,
        previewRef: `inline:${digest}`,
        commitArgsDigest: digest,
        expiresAtMs: 1_775_000_600_000,
      },
    };
    const commitOutcome: GatewayDispatchOutcome = {
      ok: true,
      state: "completed",
      toolName: record.name,
      toolVersion: record.version,
      executor: record.executor,
      requestId: commitInvocationId,
      result: { committed: true },
    };
    const dispatchSpy = vi
      .spyOn(dispatcher, "dispatch")
      .mockResolvedValueOnce(previewOutcome)
      .mockResolvedValueOnce(commitOutcome);
    const view = new EntitledCatalogView([catalogEntry], entitleAll);
    const authInfo: AuthInfo = {
      token: TOKEN,
      clientId: "codex-confirmation-test",
      scopes: ["mcp:tools"],
    };
    let endpoint: NorthMcpEndpointHandle | undefined;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;

    try {
      endpoint = await startNorthMcpEndpoint({
        dispatcher,
        registry,
        catalogViewFor: () => view,
        invocationRouteFor,
        requestState: { key: REQUEST_STATE_KEY },
        resourceMetadataUrl: new URL(
          "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
        ),
        authenticator: {
          async authenticate(request) {
            return request.headers.authorization === `Bearer ${TOKEN}`
              ? authenticatedRequest(
                  PRINCIPAL_KEY,
                  authInfo,
                  "gateway-confirmation-session",
                  "mcp-confirmation-session",
                )
              : null;
          },
        },
      });
      client = new Client({
        name: "revAgent confirmation round-trip test",
        version: "0.1.0-m2",
      });
      transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      });
      await client.connect(transport);

      const instructionPackage = buildGatewayInstructionPackage(view);
      expect(client.getInstructions()).toBe(
        gatewayClientInstructions(instructionPackage),
      );
      const instructionResources = await client.listResources();
      expect(instructionResources.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            uri: instructionPackage.modules[0]!.instruction.uri,
            mimeType: "text/markdown",
          }),
          expect.objectContaining({
            uri: instructionPackage.modules[0]!.manifestUri,
            mimeType: "application/json",
          }),
        ]),
      );
      const manifestResource = await client.readResource({
        uri: instructionPackage.modules[0]!.manifestUri,
      });
      const manifestContent = manifestResource.contents[0];
      if (manifestContent === undefined || !("text" in manifestContent)) {
        throw new Error("O6 manifest resource did not return text");
      }
      expect(JSON.parse(manifestContent.text)).toMatchObject({
        module: "core",
        tools: [
          {
            name: record.name,
            policyClass: record.policyClass,
            executor: record.executor,
            executorMethod: record.executorMethod,
          },
        ],
      });

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([record.name]);
      expect(listed.tools[0]?.inputSchema).toEqual(
        gatewayExternalToolInputJsonSchema(record),
      );
      expect(listed.tools.some((tool) => tool.name === "confirm_action")).toBe(
        false,
      );

      const first = await client.callTool({
        name: record.name,
        arguments: { value: "ready" },
      });
      expect(first).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          state: "confirmation_required",
          requestId: previewInvocationId,
          confirmation: {
            confirmToken,
            originatingPreviewInvocationId: previewInvocationId,
          },
        },
      });
      const second = await client.callTool({
        name: record.name,
        arguments: {
          value: "ready",
          mode: "commit",
          confirm_token: confirmToken,
          originating_preview_invocation_id: previewInvocationId,
        },
      });
      expect(second).toMatchObject({
        isError: false,
        structuredContent: {
          ok: true,
          state: "completed",
          requestId: commitInvocationId,
        },
      });
      expect(dispatchSpy).toHaveBeenCalledTimes(2);
      expect(dispatchSpy.mock.calls[0]?.[0]).toMatchObject({
        toolName: record.name,
        args: { value: "ready" },
      });
      expect(dispatchSpy.mock.calls[0]?.[0]).not.toHaveProperty(
        "confirmation",
      );
      expect(dispatchSpy.mock.calls[1]?.[0]).toMatchObject({
        toolName: record.name,
        args: { value: "ready", mode: "commit" },
        confirmation: {
          confirmToken,
          originatingPreviewInvocationId: previewInvocationId,
        },
      });
      expect(
        dispatchSpy.mock.calls.map(([request]) => request.mcpSessionId),
      ).toEqual(["mcp-confirmation-session", "mcp-confirmation-session"]);
      expect(
        dispatchSpy.mock.calls.map(
          ([request]) => request.confirmationSessionId,
        ),
      ).toEqual(["mcp-confirmation-session", "mcp-confirmation-session"]);
      expect(dispatchSpy.mock.calls[1]?.[0].args).not.toHaveProperty(
        "confirm_token",
      );
      expect(dispatchSpy.mock.calls[1]?.[0].args).not.toHaveProperty(
        "originating_preview_invocation_id",
      );
    } finally {
      await Promise.allSettled([client?.close(), transport?.close()]);
      await endpoint?.close().catch(() => undefined);
      dispatchSpy.mockRestore();
    }
  });

  it("fails closed when callable catalog and registry disagree on mutation scope policy", async () => {
    const mismatchedCatalog = VERIFIED_CATALOG.map((entry) =>
      entry.name === "core.ui.state"
        ? Object.freeze({
            ...entry,
            mutationScopePolicy: "session" as const,
          })
        : entry,
    );
    const mismatchedView = new EntitledCatalogView(
      mismatchedCatalog,
      entitleAll,
    );
    const registry = buildNorthFirstSliceCallableRegistry(VERIFIED_CATALOG);
    let executorCalls = 0;
    const dispatcher = new GatewayDispatcher(
      registry,
      [
        {
          binding: "bridge",
          async execute(): Promise<GatewayExecutorOutcome> {
            executorCalls += 1;
            return { state: "completed", result: { ok: true } };
          },
        },
      ],
      dispatcherOptions(),
    );
    const authInfo: AuthInfo = {
      token: TOKEN,
      clientId: "catalog-coherence-test",
      scopes: ["mcp:tools"],
    };
    const reports: unknown[] = [];
    let endpoint: NorthMcpEndpointHandle | undefined;
    let client: Client | undefined;
    let transport: StreamableHTTPClientTransport | undefined;

    try {
      endpoint = await startNorthMcpEndpoint({
        dispatcher,
        registry,
        catalogViewFor: () => mismatchedView,
        invocationRouteFor,
        requestState: { key: REQUEST_STATE_KEY },
        resourceMetadataUrl: new URL(
          "https://gateway.example.test/.well-known/oauth-protected-resource/mcp",
        ),
        authenticator: {
          async authenticate(request) {
            return request.headers.authorization === `Bearer ${TOKEN}`
              ? authenticatedRequest(PRINCIPAL_KEY, authInfo)
              : null;
          },
        },
        reportError(report) {
          reports.push(report);
        },
      });
      client = new Client({
        name: "revAgent catalog coherence test",
        version: "0.1.0-m2",
      });
      transport = new StreamableHTTPClientTransport(endpoint.endpoint, {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      });

      await expect(client.connect(transport)).rejects.toThrow();
      expect(executorCalls).toBe(0);
      expect(reports.length).toBeGreaterThan(0);
      expect(reports).toContainEqual({
        event: "gateway.north_mcp.error",
        code: "sdk_error",
      });
      expect(JSON.stringify(reports)).not.toContain(
        "north callable core.ui.state disagrees",
      );
    } finally {
      await Promise.allSettled([client?.close(), transport?.close()]);
      await endpoint?.close().catch(() => undefined);
    }
  });

  it("exposes a registry index and dispatches one tool through the Bridge simulator", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "revagent-gateway-m2-"));
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
        new modules.simulator.ArtifactSpool(join(temporaryRoot, "spool"), () =>
          ids.next(),
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
          if (normalized.kind === "result" && normalized.status === "guarded") {
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
            const otherPrincipal = authorization === `Bearer ${OTHER_TOKEN}`;
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

      const instructionPackage =
        buildGatewayInstructionPackage(FULL_CATALOG_VIEW);
      expect(legacyClient.getInstructions()).toBe(
        gatewayClientInstructions(instructionPackage),
      );
      const resources = await legacyClient.listResources();
      expect(resources.resources).toEqual(
        expect.arrayContaining([
        expect.objectContaining({
          uri: "revagent://capability-index",
          mimeType: "application/json",
        }),
          expect.objectContaining({
            uri: instructionPackage.modules[0]!.instruction.uri,
            mimeType: "text/markdown",
          }),
          expect.objectContaining({
            uri: instructionPackage.modules[0]!.manifestUri,
            mimeType: "application/json",
          }),
        ]),
      );
      const capabilityResource = await legacyClient.readResource({
        uri: "revagent://capability-index",
      });
      expect(capabilityResource.contents).toEqual([
        expect.objectContaining({
          uri: "revagent://capability-index",
          text: FULL_CATALOG_VIEW.capabilityIndexBytes(),
        }),
      ]);
      const instructionResource = await legacyClient.readResource({
        uri: instructionPackage.modules[0]!.instruction.uri,
      });
      expect(instructionResource.contents).toEqual([
        expect.objectContaining({
          uri: instructionPackage.modules[0]!.instruction.uri,
          text: instructionPackage.modules[0]!.instruction.text,
        }),
      ]);
      const manifestResource = await legacyClient.readResource({
        uri: instructionPackage.modules[0]!.manifestUri,
      });
      expect(manifestResource.contents).toEqual([
        expect.objectContaining({
          uri: instructionPackage.modules[0]!.manifestUri,
          text: instructionPackage.modules[0]!.manifestBytes,
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
      const noToolsInstructionPackage = buildGatewayInstructionPackage(
        NO_TOOLS_CATALOG_VIEW,
      );
      expect(otherClient.getInstructions()).toBe(
        gatewayClientInstructions(noToolsInstructionPackage),
      );
      expect(
        (await otherClient.listResources()).resources.map(
          (resource) => resource.uri,
        ),
      ).toEqual(["revagent://capability-index"]);
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
        new Set(executorRequests.map(({ context }) => context.mcpSessionId))
          .size,
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
      await expect.poll(() => endpoint?.activeRequestCount() ?? -1).toBe(0);
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
    const authByAuthorization = new Map<string, AuthenticatedNorthMcpRequest>([
      [`Bearer ${TOKEN}`, authenticatedRequest(PRINCIPAL_KEY, primaryAuthInfo)],
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
            return (
              authByAuthorization.get(request.headers.authorization ?? "") ??
              null
            );
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
      const postState = (token: string, id: string, requestState: string) =>
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
      await expect(reorderedScopesResponse.json()).resolves.toMatchObject({
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
              if (request.headers.authorization !== `Bearer ${TOKEN}`) {
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

        const callPromise = client
          .callTool({
            name: "core.ui.state",
            arguments: {},
          })
          .catch(() => undefined);
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
