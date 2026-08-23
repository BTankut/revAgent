import { createHash } from "node:crypto";
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
import type { AuthContext, IdentityPort } from "./authContext.js";
import type { GatewayPortAdapterKind } from "./gatewayPorts.js";
import {
  gatewayExternalToolInputSchema,
  splitGatewayConfirmationArguments,
} from "./confirmation.js";
import type {
  GatewayDispatcher,
  GatewayJsonValue,
} from "./dispatch.js";
import type { CatalogEntry, EntitledCatalogView } from "./entitledRegistry.js";
import {
  createEffectiveMcpRequestScopeV1,
  GatewayInvocationContextError,
  type EffectiveMcpRequestScopeV1,
  type GatewayInvocationRoute,
} from "./invocationContext.js";
import {
  PHASE1_INSTRUCTION_VERSION,
  buildGatewayInstructionPackage,
  gatewayClientInstructions,
  type GatewayInstructionPackage,
} from "./instructionPackage.js";
import {
  ModeADiscoverySession,
  ModeASchemaBudgetError,
  ModeAToolUnavailableError,
  type ModeAActivationResult,
} from "./modeADiscovery.js";
import type { GatewayToolRegistry } from "./registry.js";
import {
  GatewayResourceError,
  resourceScopeFromEffectiveMcpRequestScope,
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

/** Token-free, allowlisted authorization data visible to Gateway callbacks. */
export interface NorthMcpCallbackAuthInfo {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: number;
  readonly resource?: URL;
}

/**
 * Callback context deliberately excludes the SDK's raw token and open-ended
 * `extra` bag. Catalog and route resolvers never need either credential input.
 */
export interface AuthorizedNorthMcpRequest {
  readonly authInfo: NorthMcpCallbackAuthInfo;
  readonly authContext: AuthContext;
  readonly principalKey: string;
}

export type NorthMcpAuthenticatorTrustMetadata =
  | {
      readonly mode: "production";
      readonly adapterKind: "oidc";
      readonly identity: IdentityPort & { readonly kind: "oidc" };
    }
  | {
      readonly mode: "preproduction";
      readonly adapterKind: "preproduction";
      readonly identity: IdentityPort & { readonly kind: "preproduction" };
    }
  | {
      readonly mode: "fixture";
      readonly adapterKind: Extract<
        GatewayPortAdapterKind,
        "fake" | "capture" | "memory"
      >;
      readonly identity?: IdentityPort;
    };

export const NORTH_MCP_ERROR_EVENT = "gateway.north_mcp.error" as const;
export type NorthMcpErrorCode = "sdk_error" | "request_failed";
export interface NorthMcpErrorReport {
  readonly event: typeof NORTH_MCP_ERROR_EVENT;
  readonly code: NorthMcpErrorCode;
}

export interface NorthMcpAuthenticator {
  /** Required by production composition; optional for isolated test wrappers. */
  readonly trust?: NorthMcpAuthenticatorTrustMetadata;
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
    authenticated: AuthorizedNorthMcpRequest,
  ) => EntitledCatalogView | null | Promise<EntitledCatalogView | null>;
  /** Resolves the current authenticated MCP session to one bridge route. */
  readonly invocationRouteFor: (
    authenticated: AuthorizedNorthMcpRequest,
    mcpSessionId: string,
    /** Immutable ingress authority; resolvers must not reconstruct scope. */
    effectiveMcpRequestScope?: EffectiveMcpRequestScopeV1,
  ) => GatewayInvocationRoute | Promise<GatewayInvocationRoute>;
  readonly dispatcher: GatewayDispatcher;
  /** GW-9 scoped artifact/result resources; absent means no dynamic resource surface. */
  readonly resourceAuthority?: Pick<
    GatewayResourceAuthority,
    "boundResult" | "readResource"
  >;
  readonly resourceMaxInlineResultBytes?: number;
  /** O6 instruction package pin; independent from callable tool schemas. */
  readonly instructionVersion?: string;
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
  /** Receives a fixed, value-free event; never the original Error or request. */
  readonly reportError?: (
    report: NorthMcpErrorReport,
  ) => void | Promise<void>;
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
    token: authInfo.token,
    clientId: authInfo.clientId,
    scopes: [...authInfo.scopes],
    ...(authInfo.expiresAt === undefined ? {} : { expiresAt: authInfo.expiresAt }),
    ...(authInfo.resource === undefined
      ? {}
      : { resource: new URL(authInfo.resource.href) }),
  };
}

function callbackContext(
  authenticated: AuthenticatedNorthMcpRequest,
): AuthorizedNorthMcpRequest {
  const authInfo: NorthMcpCallbackAuthInfo = Object.freeze({
    clientId: authenticated.authInfo.clientId,
    scopes: Object.freeze([...authenticated.authInfo.scopes]),
    ...(authenticated.authInfo.expiresAt === undefined
      ? {}
      : { expiresAt: authenticated.authInfo.expiresAt }),
    ...(authenticated.authInfo.resource === undefined
      ? {}
      : { resource: new URL(authenticated.authInfo.resource.href) }),
  });
  return Object.freeze({
    authInfo,
    authContext: authenticated.authContext,
    principalKey: authenticated.principalKey,
  });
}

function authBindingKey(authenticated: AuthorizedNorthMcpRequest): string {
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

function effectiveScopeKey(scope: EffectiveMcpRequestScopeV1): string {
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  // Never retain raw principal/session identifiers in the long-lived Mode-A
  // discovery map. These two hashes are the durable key prefix.
  return `p:${hash(scope.principalKey)}/s:${hash(scope.effectiveMcpSessionId)}`;
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
  authenticated: AuthorizedNorthMcpRequest,
  effectiveScope: EffectiveMcpRequestScopeV1,
  authority: Pick<GatewayResourceAuthority, "readResource">,
): void {
  const scope = resourceScopeFromEffectiveMcpRequestScope(
    authenticated.authContext,
    effectiveScope,
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

function registerInstructionResources(
  server: McpServer,
  instructionPackage: GatewayInstructionPackage,
): void {
  for (const modulePackage of instructionPackage.modules) {
    const moduleName = modulePackage.manifest.module;
    server.registerResource(
      `module-instructions-${moduleName}`,
      modulePackage.instruction.uri,
      {
        title: `revAgent ${moduleName} instructions`,
        description:
          "Version-pinned external-client instructions for an entitled revAgent module.",
        mimeType: modulePackage.instruction.mimeType,
      },
      (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: modulePackage.instruction.mimeType,
            text: modulePackage.instruction.text,
          },
        ],
      }),
    );
    server.registerResource(
      `module-manifest-${moduleName}`,
      modulePackage.manifestUri,
      {
        title: `revAgent ${moduleName} O6 manifest`,
        description:
          "Canonical entitled tool, policy, and exact executor bindings for this module.",
        mimeType: "application/json",
      },
      (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: modulePackage.manifestBytes,
          },
        ],
      }),
    );
  }
}

function createSessionServer(input: {
  readonly catalogView: EntitledCatalogView;
  readonly authenticated: AuthorizedNorthMcpRequest;
  readonly dispatcher: GatewayDispatcher;
  readonly inflightOperations: Set<Promise<unknown>>;
  readonly registry: GatewayToolRegistry;
  readonly modeASession?: ModeADiscoverySession;
  readonly notifyToolsChanged: () => void;
  readonly effectiveMcpRequestScope: EffectiveMcpRequestScopeV1;
  readonly resourceAuthority?: Pick<
    GatewayResourceAuthority,
    "boundResult" | "readResource"
  >;
  readonly resourceMaxInlineResultBytes: number;
  readonly invocationRouteFor: NorthMcpEndpointOptions["invocationRouteFor"];
  readonly instructionVersion: string;
  readonly verifyRequestState: RequestStateCodec["verify"];
}): McpServer {
  const capabilityIndexBytes = input.catalogView.capabilityIndexBytes();
  const instructionPackage = buildGatewayInstructionPackage(
    input.catalogView,
    input.instructionVersion,
  );
  const dispatcher = input.dispatcher;
  const server = new McpServer(
    {
      name: "revAgent Gateway",
      version: "0.1.0-m2",
    },
    {
      instructions: gatewayClientInstructions(instructionPackage),
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
  registerInstructionResources(server, instructionPackage);
  if (input.resourceAuthority !== undefined) {
    registerGatewayResources(
      server,
      input.authenticated,
      input.effectiveMcpRequestScope,
      input.resourceAuthority,
    );
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
        if (
          ctx.sessionId !== undefined &&
          ctx.sessionId !== input.effectiveMcpRequestScope.effectiveMcpSessionId
        ) {
          return toolResult(
            Object.freeze({
              ok: false as const,
              state: "failed" as const,
              toolName: record.name,
              requestId: "effective-mcp-scope-rejected",
              executorReached: false,
              error: Object.freeze({
                code: "invalid_invocation_context",
                detailCode: "mcp_session_binding_mismatch",
                message: "MCP request context changed after ingress binding",
              }),
            }),
          );
        }
        const mcpSessionId =
          input.effectiveMcpRequestScope.effectiveMcpSessionId;
        const outcome = await trackPromise(
          input.inflightOperations,
          dispatcher.dispatch({
            toolName: record.name,
            args: call.args,
            auth: input.authenticated.authContext,
            mcpSessionId,
            confirmationSessionId: mcpSessionId,
            effectiveMcpRequestScope: input.effectiveMcpRequestScope,
            ...(call.confirmation === undefined
              ? {}
              : { confirmation: call.confirmation }),
            resolveRoute: (authContext) => {
              if (
                authContext.principalKey !==
                input.effectiveMcpRequestScope.principalKey
              ) {
                throw new GatewayInvocationContextError(
                  "mcp_session_binding_mismatch",
                  "effective MCP route authority principal changed before dispatch",
                );
              }
              return input.invocationRouteFor(
                Object.freeze({ ...input.authenticated, authContext }),
                mcpSessionId,
                input.effectiveMcpRequestScope,
              );
            },
          }),
        );
        if (input.resourceAuthority === undefined) {
          return toolResult(outcome);
        }
        const resourceScope = resourceScopeFromEffectiveMcpRequestScope(
          input.authenticated.authContext,
          input.effectiveMcpRequestScope,
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
    authenticated: AuthorizedNorthMcpRequest,
    catalogView: EntitledCatalogView,
    effectiveMcpRequestScope: EffectiveMcpRequestScopeV1,
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

    const key = effectiveScopeKey(effectiveMcpRequestScope);
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
    AuthorizedNorthMcpRequest
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
  const reportError = (code: NorthMcpErrorCode): void => {
    const report = Object.freeze({ event: NORTH_MCP_ERROR_EVENT, code });
    try {
      if (options.reportError === undefined) {
        console.error(report);
      } else {
        void Promise.resolve(options.reportError(report)).catch(
          () => undefined,
        );
      }
    } catch {
      // Observability must not become a request or shutdown failure path.
    }
  };
  const reportMcpError = (): void => reportError("sdk_error");
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
      const effectiveMcpRequestScope = createEffectiveMcpRequestScopeV1({
        principalKey: authenticated.principalKey,
        transportMcpSessionId: mcpConnectionId,
        identityMcpSessionId: authenticated.authContext.session.mcpSessionId,
        nowMs: Date.now(),
      });
      const modeASession = modeASessionFor(
        authenticated,
        catalogView,
        effectiveMcpRequestScope,
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
        instructionVersion:
          options.instructionVersion ?? PHASE1_INSTRUCTION_VERSION,
        resourceMaxInlineResultBytes,
        ...(options.resourceAuthority === undefined
          ? {}
          : { resourceAuthority: options.resourceAuthority }),
        notifyToolsChanged: () => mcpHandler.notify.toolsChanged(),
        registry: options.registry,
        effectiveMcpRequestScope,
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
    const authorized = callbackContext(authenticated);
    const catalogView = await options.catalogViewFor(authorized);
    if (catalogView === null) {
      sendJson(response, 403, { error: "entitlement_denied" });
      return;
    }
    const requestAuthInfo = cloneAuthInfo(authenticated.authInfo);
    authenticatedByAuthInfo.set(
      requestAuthInfo,
      authorized,
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
          void error;
          reportError("request_failed");
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
