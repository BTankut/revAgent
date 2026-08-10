import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  createRequestStateCodec,
  isJsonContentType,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type AuthInfo,
  type McpRequestContext,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuthContext } from "./authContext.js";
import {
  gatewayExternalToolInputSchema,
  splitGatewayConfirmationArguments,
} from "./confirmation.js";
import type {
  GatewayDispatcher,
  GatewayJsonValue,
} from "./dispatch.js";
import type { CatalogEntry, EntitledCatalogView } from "./entitledRegistry.js";
import type { GatewayInvocationRoute } from "./invocationContext.js";
import {
  ModeADiscoverySession,
  ModeASchemaBudgetError,
  ModeAToolUnavailableError,
  type ModeAActivationResult,
} from "./modeADiscovery.js";
import type { GatewayToolRegistry } from "./registry.js";
import {
  GatewayResourceError,
  resourceScopeFromAuth,
  type GatewayResourceAuthority,
} from "./resourceAuthority.js";

const NORTH_MCP_PATH = "/mcp";
const CAPABILITY_INDEX_URI = "revagent://capability-index";
const MAX_POST_BODY_BYTES = 1024 * 1024;
const SUPPORTED_METHODS = new Set(["DELETE", "GET", "POST"]);

export const NORTH_MODE_A_META_TOOLS = Object.freeze([
  "tool_search",
  "tool_schema",
] as const);
export const NORTH_MODE_A_PINNED_TOOLS = Object.freeze([
  "core.element.query",
  "core.document.context",
  "core.view.context",
  "core.session.status",
] as const);
const DEFAULT_MODE_A_SESSION_TTL_MS = 30 * 60 * 1_000;

type AuthenticatedIncomingMessage = IncomingMessage & {
  auth?: AuthInfo;
};

export interface AuthenticatedNorthMcpRequest {
  readonly authInfo: AuthInfo;
  readonly authContext: AuthContext;
  readonly principalKey: string;
}

export interface NorthMcpAuthenticator {
  /**
   * Implementations own token signature, expiry, audience/resource, scope,
   * tenant/user, revocation, and identity validation. Return null when any
   * required check fails.
   */
  authenticate(
    request: IncomingMessage,
  ): Promise<AuthenticatedNorthMcpRequest | null>;
}

export interface NorthMcpEndpointOptions {
  readonly authenticator: NorthMcpAuthenticator;
  /**
   * Resolves the one entitlement-filtered GW-3 catalog view used by every
   * north surface for this request. Null refuses the request before MCP
   * initialization or executor contact.
   */
  readonly catalogViewFor: (
    authenticated: AuthenticatedNorthMcpRequest,
  ) => EntitledCatalogView | null | Promise<EntitledCatalogView | null>;
  /** Resolves the current authenticated MCP session to one bridge route. */
  readonly invocationRouteFor: (
    authenticated: AuthenticatedNorthMcpRequest,
    mcpSessionId: string,
  ) => GatewayInvocationRoute | Promise<GatewayInvocationRoute>;
  readonly dispatcher: GatewayDispatcher;
  /** GW-9 scoped artifact/result resources; absent means no dynamic resource surface. */
  readonly resourceAuthority?: Pick<
    GatewayResourceAuthority,
    "boundResult" | "readResource"
  >;
  readonly resourceMaxInlineResultBytes?: number;
  /** Complete executable registry when Mode A is enabled. */
  readonly registry: GatewayToolRegistry;
  readonly requestState: {
    readonly key: string | Uint8Array;
    readonly ttlSeconds?: number;
  };
  readonly modeA?: {
    /** Non-pinned callable schemas retained for one authenticated MCP session. */
    readonly schemaBudgetBytes: number;
    readonly pinnedToolNames?: readonly string[];
    readonly sessionTtlMs?: number;
    /** Deterministic clock seam for conformance and expiry tests. */
    readonly now?: () => number;
  };
  readonly resourceMetadataUrl: URL;
  readonly host?: "127.0.0.1" | "localhost";
  readonly port?: number;
}

export interface NorthMcpEndpointHandle {
  readonly endpoint: URL;
  readonly host: string;
  readonly port: number;
  activeRequestCount(): number;
  close(): Promise<void>;
}

/** Reusable north MCP request handler mounted by Fastify or a loopback proof. */
export interface NorthMcpHttpHandler {
  activeRequestCount(): number;
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void>;
  close(): Promise<void>;
}

export type NorthMcpHostHeaderPolicy = (
  hostHeader: string | undefined,
) => boolean;

class RequestBodyError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly jsonRpcCode: -32_700 | -32_600,
  ) {
    super(message);
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function sendJsonRpcError(
  response: ServerResponse,
  statusCode: number,
  code: -32_700 | -32_600 | -32_000,
  message: string,
): void {
  sendJson(response, statusCode, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function isAllowedHostHeader(
  hostHeader: string | undefined,
  host: string,
  port: number,
): boolean {
  if (hostHeader === undefined) {
    return false;
  }
  const normalized = hostHeader.toLowerCase();
  return new Set([
    `${host}:${port}`.toLowerCase(),
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]).has(normalized);
}

function cloneAuthInfo(authInfo: AuthInfo): AuthInfo {
  return {
    ...authInfo,
    scopes: [...authInfo.scopes],
    ...(authInfo.extra === undefined ? {} : { extra: { ...authInfo.extra } }),
  };
}

function authBindingKey(authenticated: AuthenticatedNorthMcpRequest): string {
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
    authenticated.authInfo.clientId,
    authenticated.authInfo.resource?.href ?? null,
    [...authenticated.authInfo.scopes].sort(),
  ]);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_POST_BODY_BYTES) {
      throw new RequestBodyError("request body is too large", 413, -32_600);
    }
    chunks.push(bytes);
  }
  if (size === 0) {
    throw new RequestBodyError("request body is required", 400, -32_600);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestBodyError("request body is not valid JSON", 400, -32_700);
  }
}

async function closeHttpServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

function trackPromise<T>(
  tracked: Set<Promise<unknown>>,
  promise: Promise<T>,
): Promise<T> {
  tracked.add(promise);
  void promise.then(
    () => tracked.delete(promise),
    () => tracked.delete(promise),
  );
  return promise;
}

async function drainTrackedPromises(
  trackedSets: readonly ReadonlySet<Promise<unknown>>[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  while (trackedSets.some((tracked) => tracked.size > 0)) {
    const pending = new Set(trackedSets.flatMap((tracked) => [...tracked]));
    const results = await Promise.allSettled(pending);
    errors.push(
      ...results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) => result.reason),
    );
  }
  return errors;
}

function toolResult(
  outcome: Awaited<ReturnType<GatewayDispatcher["dispatch"]>>,
  structuredContent: Readonly<Record<string, unknown>> =
    outcome as unknown as Readonly<Record<string, unknown>>,
  forceError = false,
) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent: structuredContent as Record<string, unknown>,
    isError: forceError || !outcome.ok,
  };
}

function modeAToolResult(
  value: Readonly<Record<string, unknown>>,
  isError = false,
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError,
  };
}

function modeAErrorResult(
  error: ModeAToolUnavailableError | ModeASchemaBudgetError,
) {
  return modeAToolResult(
    Object.freeze({
      ok: false,
      error: Object.freeze({
        code: error.code,
        message: error.message,
      }),
    }),
    true,
  );
}

const MODE_A_SEARCH_INPUT = z
  .object({
    query: z.string().min(1).max(512),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const MODE_A_SCHEMA_INPUT = z
  .object({
    names: z.array(z.string().min(1).max(160)).min(1).max(20),
  })
  .strict();

function registerModeAMetaTools(
  server: McpServer,
  session: ModeADiscoverySession,
  notifyToolsChanged: () => void,
): void {
  server.registerTool(
    "tool_search",
    {
      description:
        "Search the entitled revAgent capability index without activating schemas.",
      inputSchema: MODE_A_SEARCH_INPUT,
    },
    ({ query, limit }) =>
      modeAToolResult(
        Object.freeze({
          ok: true,
          results: session.search(query, limit),
        }),
      ),
  );
  server.registerTool(
    "tool_schema",
    {
      description:
        "Return and session-activate selected entitled revAgent tool schemas.",
      inputSchema: MODE_A_SCHEMA_INPUT,
    },
    ({ names }) => {
      try {
        const activation: ModeAActivationResult = session.activate(names);
        if (activation.callableSetChanged) {
          notifyToolsChanged();
        }
        return modeAToolResult(
          Object.freeze({
            ok: true,
            ...activation,
            callableNames: session.callableNames(),
          }),
        );
      } catch (error) {
        if (
          error instanceof ModeAToolUnavailableError ||
          error instanceof ModeASchemaBudgetError
        ) {
          return modeAErrorResult(error);
        }
        throw error;
      }
    },
  );
}


function assertCallableCatalogCoherence(
  record: ReturnType<GatewayToolRegistry["require"]>,
  catalogEntry: CatalogEntry,
): void {
  if (
    catalogEntry.name !== record.name ||
    catalogEntry.summary !== record.summary ||
    catalogEntry.namespace !== record.namespace ||
    catalogEntry.version !== record.version ||
    catalogEntry.policyClass !== record.policyClass ||
    catalogEntry.mutationScopePolicy !== record.mutationScopePolicy ||
    catalogEntry.executor !== record.executor ||
    catalogEntry.tool !== record.executorMethod
  ) {
    throw new TypeError(
      `north callable ${record.name} disagrees with its GW-3 catalog entry`,
    );
  }
}

function registerGatewayResources(
  server: McpServer,
  authenticated: AuthenticatedNorthMcpRequest,
  authority: Pick<GatewayResourceAuthority, "readResource">,
): void {
  const scope = resourceScopeFromAuth(
    authenticated.authContext,
    authenticated.authContext.session.mcpSessionId ??
      authenticated.authContext.session.sessionId,
  );
  const read = async (uri: URL) => {
    try {
      const resource = await authority.readResource(scope, uri);
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.contentType,
            blob: Buffer.from(resource.bytes).toString("base64"),
          },
        ],
        ...(resource.nextPageUri === null
          ? {}
          : { _meta: { nextPageUri: resource.nextPageUri } }),
      };
    } catch (error) {
      if (
        error instanceof GatewayResourceError &&
        ["expired", "not_found", "quarantined", "scope_denied"].includes(
          error.code,
        )
      ) {
        // Do not disclose whether a ref exists outside the authenticated scope.
        throw new ResourceNotFoundError(uri.href);
      }
      throw error;
    }
  };
  server.registerResource(
    "artifact-ref",
    new ResourceTemplate("revagent://artifact/{ref_id}", { list: undefined }),
    { description: "Authenticated, expiring revAgent artifact." },
    read,
  );
  server.registerResource(
    "result-ref-page",
    new ResourceTemplate("revagent://result/{ref_id}/{page}", { list: undefined }),
    { description: "Authenticated, paged revAgent structured result." },
    read,
  );
}

function createSessionServer(input: {
  readonly catalogView: EntitledCatalogView;
  readonly authenticated: AuthenticatedNorthMcpRequest;
  readonly dispatcher: GatewayDispatcher;
  readonly inflightOperations: Set<Promise<unknown>>;
  readonly registry: GatewayToolRegistry;
  readonly modeASession?: ModeADiscoverySession;
  readonly notifyToolsChanged: () => void;
  readonly requestScopeId: string;
  readonly resourceAuthority?: Pick<
    GatewayResourceAuthority,
    "boundResult" | "readResource"
  >;
  readonly resourceMaxInlineResultBytes: number;
  readonly invocationRouteFor: NorthMcpEndpointOptions["invocationRouteFor"];
  readonly verifyRequestState: RequestStateCodec["verify"];
}): McpServer {
  const capabilityIndexBytes = input.catalogView.capabilityIndexBytes();
  const dispatcher = input.dispatcher;
  const server = new McpServer(
    {
      name: "revAgent Gateway",
      version: "0.1.0-m2",
    },
    {
      instructions: capabilityIndexBytes,
      requestState: {
        verify: input.verifyRequestState,
      },
    },
  );

  server.registerResource(
    "capability-index",
    CAPABILITY_INDEX_URI,
    {
      title: "revAgent capability index",
      description: "Byte-stable entitled Gateway capability index.",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: capabilityIndexBytes,
        },
      ],
    }),
  );
  if (input.resourceAuthority !== undefined) {
    registerGatewayResources(server, input.authenticated, input.resourceAuthority);
  }
  if (input.modeASession !== undefined) {
    registerModeAMetaTools(
      server,
      input.modeASession,
      input.notifyToolsChanged,
    );
  }


  for (const record of input.registry.records()) {
    const catalogEntry = input.catalogView.get(record.name);
    if (
      catalogEntry === undefined ||
      (input.modeASession !== undefined &&
        !input.modeASession.isCallable(record.name))
    ) {
      continue;
    }
    assertCallableCatalogCoherence(record, catalogEntry);
    server.registerTool(
      record.name,
      {
        description: record.summary,
        inputSchema: gatewayExternalToolInputSchema(record),
      },
      async (args, ctx) => {
        if (input.modeASession !== undefined) {
          try {
            input.modeASession.requireCallable(record.name);
          } catch (error) {
            return modeAErrorResult(error as ModeAToolUnavailableError);
          }
        }
        const call = splitGatewayConfirmationArguments(record, args);
        const mcpSessionId =
          ctx.sessionId ??
          input.authenticated.authContext.session.mcpSessionId ??
          `stateless-request:${input.requestScopeId}`;
        const confirmationSessionId =
          input.authenticated.authContext.session.mcpSessionId ??
          ctx.sessionId ??
          input.authenticated.authContext.session.sessionId;
        const outcome = await trackPromise(
          input.inflightOperations,
          dispatcher.dispatch({
            toolName: record.name,
            args: call.args,
            auth: input.authenticated.authContext,
            mcpSessionId,
            confirmationSessionId,
            ...(call.confirmation === undefined
              ? {}
              : { confirmation: call.confirmation }),
            resolveRoute: (authContext) =>
              input.invocationRouteFor(
                Object.freeze({ ...input.authenticated, authContext }),
                mcpSessionId,
              ),
          }),
        );
        if (input.resourceAuthority === undefined) {
          return toolResult(outcome);
        }
        const resourceScope = resourceScopeFromAuth(
          input.authenticated.authContext,
          input.authenticated.authContext.session.mcpSessionId ??
            input.authenticated.authContext.session.sessionId,
        );
        try {
          const bounded = await input.resourceAuthority.boundResult({
            scope: resourceScope,
            value: outcome as unknown as GatewayJsonValue,
            maxInlineBytes: input.resourceMaxInlineResultBytes,
          });
          const content = bounded.kind === "inline" ? bounded.value : bounded;
          return toolResult(
            outcome,
            content as unknown as Readonly<Record<string, unknown>>,
          );
        } catch (error) {
          return toolResult(
            outcome,
            Object.freeze({
              ok: false,
              state: outcome.state,
              toolName: outcome.toolName,
              requestId: outcome.requestId,
              executorOutcomePreserved: true,
              error: Object.freeze({
                code: "result_delivery_unavailable",
                message: error instanceof Error ? error.message : String(error),
              }),
            }),
            true,
          );
        }
      },
    );
  }

  return server;
}

export function createNorthMcpHttpHandler(
  options: NorthMcpEndpointOptions,
  allowHostHeader: NorthMcpHostHeaderPolicy,
): NorthMcpHttpHandler {
  if (options.resourceMetadataUrl.protocol !== "https:") {
    throw new RangeError("resourceMetadataUrl must use HTTPS");
  }
  const resourceMaxInlineResultBytes =
    options.resourceMaxInlineResultBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isSafeInteger(resourceMaxInlineResultBytes) ||
    resourceMaxInlineResultBytes < 0
  ) {
    throw new RangeError("resourceMaxInlineResultBytes must be a non-negative safe integer");
  }
  if (options.dispatcher.registry() !== options.registry) {
    throw new TypeError(
      "north MCP endpoint and dispatcher must share one Gateway registry",
    );
  }
  const modeANow = options.modeA?.now ?? Date.now;
  const modeASessionTtlMs =
    options.modeA?.sessionTtlMs ?? DEFAULT_MODE_A_SESSION_TTL_MS;
  if (
    options.modeA !== undefined &&
    (!Number.isSafeInteger(modeASessionTtlMs) || modeASessionTtlMs < 1)
  ) {
    throw new RangeError("Mode A sessionTtlMs must be a positive safe integer");
  }
  const modeASessions = new Map<
    string,
    {
      readonly capabilityIndexDigest: string;
      readonly discovery: ModeADiscoverySession;
      lastSeenMs: number;
    }
  >();

  function modeASessionFor(
    authenticated: AuthenticatedNorthMcpRequest,
    catalogView: EntitledCatalogView,
    mcpConnectionId: string | null,
  ): ModeADiscoverySession | undefined {
    if (options.modeA === undefined) {
      return undefined;
    }
    const now = modeANow();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("Mode A clock must return a non-negative safe integer");
    }
    for (const [key, state] of modeASessions) {
      if (now - state.lastSeenMs >= modeASessionTtlMs) {
        modeASessions.delete(key);
      }
    }

    const key = `${authBindingKey(authenticated)}\0${
      mcpConnectionId ?? "initial-or-legacy"
    }`;
    const capabilityIndexDigest = catalogView.capabilityIndexDigest();
    const current = modeASessions.get(key);
    if (
      current !== undefined &&
      current.capabilityIndexDigest === capabilityIndexDigest
    ) {
      current.lastSeenMs = now;
      return current.discovery;
    }

    const visibleNames = catalogView.entries().map((entry) => {
      const record = options.registry.require(entry.name);
      assertCallableCatalogCoherence(record, entry);
      return record.name;
    });
    const discovery = new ModeADiscoverySession(
      options.registry.view(visibleNames),
      options.modeA.pinnedToolNames ?? NORTH_MODE_A_PINNED_TOOLS,
      options.modeA.schemaBudgetBytes,
    );
    modeASessions.set(key, {
      capabilityIndexDigest,
      discovery,
      lastSeenMs: now,
    });
    return discovery;
  }



  const authenticatedByAuthInfo = new WeakMap<
    AuthInfo,
    AuthenticatedNorthMcpRequest
  >();
  const catalogViewByAuthInfo = new WeakMap<AuthInfo, EntitledCatalogView>();
  const requestStateCodec = createRequestStateCodec({
    key: options.requestState.key,
    ...(options.requestState.ttlSeconds === undefined
      ? {}
      : { ttlSeconds: options.requestState.ttlSeconds }),
    bind: (context) => {
      const authInfo = context.http?.authInfo;
      const authenticated =
        authInfo === undefined
          ? undefined
          : authenticatedByAuthInfo.get(authInfo);
      if (authInfo === undefined || authenticated === undefined) {
        throw new Error("trusted north MCP auth context is missing");
      }
      return `${context.mcpReq.method}\0${authBindingKey(authenticated)}`;
    },
  });
  const inflightOperations = new Set<Promise<unknown>>();
  const requestTasks = new Set<Promise<unknown>>();
  let closing = false;
  let activeRequests = 0;
  const reportMcpError = (error: Error): void => {
    console.error(error);
  };
  const mcpHandler = createMcpHandler(
    (context: McpRequestContext) => {
      const authInfo = context.authInfo;
      const authenticated =
        authInfo === undefined
          ? undefined
          : authenticatedByAuthInfo.get(authInfo);
      if (authInfo === undefined || authenticated === undefined) {
        throw new Error("trusted north MCP auth context is missing");
      }
      const catalogView = catalogViewByAuthInfo.get(authInfo);
      if (catalogView === undefined) {
        throw new Error("trusted north MCP entitlement context is missing");
      }
      const mcpConnectionId =
        context.requestInfo?.headers.get("mcp-session-id") ?? null;
      if (
        mcpConnectionId !== null &&
        (mcpConnectionId.length < 1 || mcpConnectionId.length > 512)
      ) {
        throw new Error("invalid MCP connection identifier");
      }
      const modeASession = modeASessionFor(
        authenticated,
        catalogView,
        mcpConnectionId,
      );
      return createSessionServer({
        catalogView,
        authenticated,
        dispatcher: options.dispatcher,
        inflightOperations,
        ...(modeASession === undefined
          ? {}
          : { modeASession }),
        invocationRouteFor: options.invocationRouteFor,
        resourceMaxInlineResultBytes,
        ...(options.resourceAuthority === undefined
          ? {}
          : { resourceAuthority: options.resourceAuthority }),
        notifyToolsChanged: () => mcpHandler.notify.toolsChanged(),
        registry: options.registry,
        requestScopeId: randomUUID(),
        verifyRequestState: requestStateCodec.verify,
      });
    },
    {
      legacy: "stateless",
      onerror: reportMcpError,
    },
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: reportMcpError,
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    providedPostBody?: unknown,
  ): Promise<void> {
    const path = (request.url ?? "").split("?", 1)[0];
    if (path !== NORTH_MCP_PATH) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!allowHostHeader(request.headers.host)) {
      sendJson(response, 403, { error: "invalid_host" });
      return;
    }
    if (!SUPPORTED_METHODS.has(request.method ?? "")) {
      sendJson(
        response,
        405,
        { error: "method_not_allowed" },
        { allow: [...SUPPORTED_METHODS].join(", ") },
      );
      return;
    }

    const authenticated = await options.authenticator.authenticate(request);
    if (authenticated === null) {
      sendJson(
        response,
        401,
        { error: "unauthorized" },
        {
          "www-authenticate": `Bearer resource_metadata="${options.resourceMetadataUrl.href}"`,
        },
      );
      return;
    }
    if (
      authenticated.authContext.principalKey !== authenticated.principalKey ||
      authenticated.authContext.session.oauthClientId !==
        authenticated.authInfo.clientId
    ) {
      sendJson(response, 401, { error: "invalid_auth_binding" });
      return;
    }
    if (closing) {
      sendJson(response, 503, { error: "north_mcp_endpoint_closing" });
      return;
    }
    const catalogView = await options.catalogViewFor(authenticated);
    if (catalogView === null) {
      sendJson(response, 403, { error: "entitlement_denied" });
      return;
    }
    const requestAuthInfo = cloneAuthInfo(authenticated.authInfo);
    authenticatedByAuthInfo.set(
      requestAuthInfo,
      Object.freeze({ ...authenticated, authInfo: requestAuthInfo }),
    );
    catalogViewByAuthInfo.set(requestAuthInfo, catalogView);
    (request as AuthenticatedIncomingMessage).auth = requestAuthInfo;

    let parsedPostBody = providedPostBody;
    if (request.method === "POST") {
      const contentType = request.headers["content-type"];
      if (
        !isJsonContentType(
          Array.isArray(contentType) ? contentType[0] : contentType,
        )
      ) {
        sendJsonRpcError(
          response,
          415,
          -32_000,
          "Unsupported Media Type: Content-Type must be application/json",
        );
        return;
      }
      if (providedPostBody === undefined) {
        try {
          parsedPostBody = await readJsonBody(request);
        } catch (error) {
          if (error instanceof RequestBodyError) {
            sendJsonRpcError(
              response,
              error.statusCode,
              error.jsonRpcCode,
              error.message,
            );
            return;
          }
          throw error;
        }
      }
    }

    if (closing) {
      sendJson(response, 503, { error: "north_mcp_endpoint_closing" });
      return;
    }

    activeRequests += 1;
    try {
      await nodeHandler(request, response, parsedPostBody);
    } finally {
      activeRequests -= 1;
    }
  }

  let closePromise: Promise<void> | undefined;
  return {
    activeRequestCount: () => activeRequests,
    handle(
      request: IncomingMessage,
      response: ServerResponse,
      parsedBody?: unknown,
    ): Promise<void> {
      return trackPromise(
        requestTasks,
        handleRequest(request, response, parsedBody).catch((error: unknown) => {
          console.error(
            error instanceof Error ? error : new Error(String(error)),
          );
          sendJson(response, 500, { error: "north_mcp_request_failed" });
        }),
      );
    },
    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closing = true;
      closePromise = (async () => {
        const closeErrors: unknown[] = [];
        try {
          await mcpHandler.close();
        } catch (error) {
          closeErrors.push(error);
        }
        closeErrors.push(
          ...(await drainTrackedPromises([inflightOperations, requestTasks])),
        );
        if (closeErrors.length > 0) {
          throw new AggregateError(
            closeErrors,
            "north MCP handler did not close cleanly",
          );
        }
      })();
      return closePromise;
    },
  };
}

export async function startNorthMcpEndpoint(
  options: NorthMcpEndpointOptions,
): Promise<NorthMcpEndpointHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new RangeError(
      "the first M2 north endpoint may bind only to loopback",
    );
  }
  if (
    !Number.isInteger(requestedPort) ||
    requestedPort < 0 ||
    requestedPort > 65_535
  ) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }

  let boundPort = 0;
  const handler = createNorthMcpHttpHandler(
    options,
    (hostHeader) => isAllowedHostHeader(hostHeader, host, boundPort),
  );
  const httpServer = createServer((request, response) => {
    void handler.handle(request, response);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const handleListenError = (error: Error): void => reject(error);
      httpServer.once("error", handleListenError);
      httpServer.listen(requestedPort, host, () => {
        httpServer.off("error", handleListenError);
        resolve();
      });
    });
  } catch (error) {
    await Promise.allSettled([handler.close(), closeHttpServer(httpServer)]);
    throw error;
  }

  const address = httpServer.address() as AddressInfo | null;
  if (address === null) {
    await Promise.allSettled([handler.close(), closeHttpServer(httpServer)]);
    throw new Error("north MCP endpoint did not expose a TCP address");
  }
  boundPort = address.port;

  let closePromise: Promise<void> | undefined;
  return {
    endpoint: new URL(`http://${host}:${boundPort}${NORTH_MCP_PATH}`),
    host,
    port: boundPort,
    activeRequestCount: () => handler.activeRequestCount(),
    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closePromise = (async () => {
        const results = await Promise.allSettled([
          handler.close(),
          closeHttpServer(httpServer),
        ]);
        const errors = results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason);
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            "north MCP endpoint did not close cleanly",
          );
        }
      })();
      return closePromise;
    },
  };
}
