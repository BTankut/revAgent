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
  type AuthInfo,
  type McpRequestContext,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { GatewayDispatcher } from "./dispatch.js";
import type { GatewayToolRegistry } from "./registry.js";

const NORTH_MCP_PATH = "/mcp";
const CAPABILITY_INDEX_URI = "revagent://capability-index";
const MAX_POST_BODY_BYTES = 1024 * 1024;
const SUPPORTED_METHODS = new Set(["DELETE", "GET", "POST"]);

type AuthenticatedIncomingMessage = IncomingMessage & {
  auth?: AuthInfo;
};

export interface AuthenticatedNorthMcpRequest {
  readonly authInfo: AuthInfo;
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
  readonly dispatcher: GatewayDispatcher;
  readonly registry: GatewayToolRegistry;
  readonly requestState: {
    readonly key: string | Uint8Array;
    readonly ttlSeconds?: number;
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
    ...(authInfo.extra === undefined
      ? {}
      : { extra: { ...authInfo.extra } }),
  };
}

function authBindingKey(
  authenticated: AuthenticatedNorthMcpRequest,
): string {
  return JSON.stringify([
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
    throw new RequestBodyError(
      "request body is not valid JSON",
      400,
      -32_700,
    );
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
    const pending = new Set(
      trackedSets.flatMap((tracked) => [...tracked]),
    );
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

function toolResult(outcome: Awaited<ReturnType<GatewayDispatcher["dispatch"]>>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
    structuredContent: outcome as unknown as Record<string, unknown>,
    isError: !outcome.ok,
  };
}

function createSessionServer(input: {
  readonly authenticated: AuthenticatedNorthMcpRequest;
  readonly dispatcher: GatewayDispatcher;
  readonly inflightOperations: Set<Promise<unknown>>;
  readonly registry: GatewayToolRegistry;
  readonly requestScopeId: string;
  readonly verifyRequestState: RequestStateCodec["verify"];
}): McpServer {
  const capabilityIndexBytes = input.registry.capabilityIndexBytes();
  const dispatcher = input.dispatcher;
  const principalKey = input.authenticated.principalKey;
  const oauthClientId = input.authenticated.authInfo.clientId;
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

  for (const record of input.registry.records()) {
    server.registerTool(
      record.name,
      {
        description: record.summary,
        inputSchema: z.object(record.inputSchema).strict(),
      },
      async (args, ctx) =>
        toolResult(
          await trackPromise(
            input.inflightOperations,
            dispatcher.dispatch({
              toolName: record.name,
              args,
              principalKey,
              oauthClientId,
              mcpSessionId:
                ctx.sessionId ?? `stateless-request:${input.requestScopeId}`,
            }),
          ),
        ),
    );
  }

  return server;
}

export async function startNorthMcpEndpoint(
  options: NorthMcpEndpointOptions,
): Promise<NorthMcpEndpointHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new RangeError("the first M2 north endpoint may bind only to loopback");
  }
  if (
    !Number.isInteger(requestedPort) ||
    requestedPort < 0 ||
    requestedPort > 65_535
  ) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  if (options.resourceMetadataUrl.protocol !== "https:") {
    throw new RangeError("resourceMetadataUrl must use HTTPS");
  }
  if (options.dispatcher.registry() !== options.registry) {
    throw new TypeError(
      "north MCP endpoint and dispatcher must share one Gateway registry",
    );
  }

  const principalByAuthInfo = new WeakMap<AuthInfo, string>();
  const requestStateCodec = createRequestStateCodec({
    key: options.requestState.key,
    ...(options.requestState.ttlSeconds === undefined
      ? {}
      : { ttlSeconds: options.requestState.ttlSeconds }),
    bind: (context) => {
      const authInfo = context.http?.authInfo;
      const principalKey =
        authInfo === undefined
          ? undefined
          : principalByAuthInfo.get(authInfo);
      if (authInfo === undefined || principalKey === undefined) {
        throw new Error("trusted north MCP auth context is missing");
      }
      return `${context.mcpReq.method}\0${authBindingKey({
        authInfo,
        principalKey,
      })}`;
    },
  });
  const inflightOperations = new Set<Promise<unknown>>();
  const requestTasks = new Set<Promise<unknown>>();
  let boundPort = 0;
  let closing = false;
  let activeRequests = 0;
  const reportMcpError = (error: Error): void => {
    console.error(error);
  };
  const mcpHandler = createMcpHandler(
    (context: McpRequestContext) => {
      const authInfo = context.authInfo;
      const principalKey =
        authInfo === undefined
          ? undefined
          : principalByAuthInfo.get(authInfo);
      if (authInfo === undefined || principalKey === undefined) {
        throw new Error("trusted north MCP auth context is missing");
      }
      return createSessionServer({
        authenticated: { authInfo, principalKey },
        dispatcher: options.dispatcher,
        inflightOperations,
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
  const httpServer = createServer((request, response) => {
    void trackPromise(
      requestTasks,
      handleRequest(request, response).catch((error: unknown) => {
        console.error(
          error instanceof Error ? error : new Error(String(error)),
        );
        sendJson(response, 500, { error: "north_mcp_request_failed" });
      }),
    );
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = (request.url ?? "").split("?", 1)[0];
    if (path !== NORTH_MCP_PATH) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!isAllowedHostHeader(request.headers.host, host, boundPort)) {
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
          "www-authenticate":
            `Bearer resource_metadata="${options.resourceMetadataUrl.href}"`,
        },
      );
      return;
    }
    if (closing) {
      sendJson(response, 503, { error: "north_mcp_endpoint_closing" });
      return;
    }
    const requestAuthInfo = cloneAuthInfo(authenticated.authInfo);
    principalByAuthInfo.set(requestAuthInfo, authenticated.principalKey);
    (request as AuthenticatedIncomingMessage).auth = requestAuthInfo;

    let parsedPostBody: unknown;
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

  try {
    await new Promise<void>((resolve, reject) => {
      const handleListenError = (error: Error): void => {
        reject(error);
      };
      httpServer.once("error", handleListenError);
      httpServer.listen(requestedPort, host, () => {
        httpServer.off("error", handleListenError);
        resolve();
      });
    });
  } catch (error) {
    await Promise.allSettled([
      mcpHandler.close(),
      closeHttpServer(httpServer),
    ]);
    throw error;
  }

  const address = httpServer.address() as AddressInfo | null;
  if (address === null) {
    await Promise.allSettled([
      mcpHandler.close(),
      closeHttpServer(httpServer),
    ]);
    throw new Error("north MCP endpoint did not expose a TCP address");
  }
  boundPort = address.port;

  let closePromise: Promise<void> | undefined;
  return {
    endpoint: new URL(`http://${host}:${boundPort}${NORTH_MCP_PATH}`),
    host,
    port: boundPort,
    activeRequestCount: () => activeRequests,
    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closing = true;
      closePromise = (async () => {
        const closeResults = await Promise.allSettled([
          mcpHandler.close(),
          closeHttpServer(httpServer),
        ]);
        const closeErrors = closeResults
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason);
        closeErrors.push(
          ...await drainTrackedPromises([
            inflightOperations,
            requestTasks,
          ]),
        );
        if (closeErrors.length > 0) {
          throw new AggregateError(
            closeErrors,
            "north MCP endpoint did not close cleanly",
          );
        }
      })();
      return closePromise;
    },
  };
}
