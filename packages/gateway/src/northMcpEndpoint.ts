import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer, isInitializeRequest } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
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
  readonly resourceMetadataUrl: URL;
  readonly host?: "127.0.0.1" | "localhost";
  readonly port?: number;
}

export interface NorthMcpEndpointHandle {
  readonly endpoint: URL;
  readonly host: string;
  readonly port: number;
  activeSessionCount(): number;
  close(): Promise<void>;
}

interface NorthMcpSession {
  readonly server: McpServer;
  readonly transport: NodeStreamableHTTPServerTransport;
  readonly authBindingKey: string;
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
  code: -32_700 | -32_600,
  message: string,
): void {
  sendJson(response, statusCode, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function headerValue(
  value: string | readonly string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : value?.[0];
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
  readonly registry: GatewayToolRegistry;
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
          await dispatcher.dispatch({
            toolName: record.name,
            args,
            principalKey,
            oauthClientId,
            mcpSessionId: ctx.sessionId ?? "session-initializing",
          }),
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

  const sessions = new Map<string, NorthMcpSession>();
  const pendingServers = new Set<McpServer>();
  let boundPort = 0;
  let closing = false;
  const httpServer = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      console.error(error instanceof Error ? error : new Error(String(error)));
      sendJson(response, 500, { error: "north_mcp_request_failed" });
    });
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
    (request as AuthenticatedIncomingMessage).auth = authenticated.authInfo;
    const requestAuthBindingKey = authBindingKey(authenticated);
    if (closing) {
      sendJson(response, 503, { error: "north_mcp_endpoint_closing" });
      return;
    }

    let parsedPostBody: unknown;
    if (request.method === "POST") {
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

    const sessionId = headerValue(request.headers["mcp-session-id"]);
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        sendJson(response, 404, { error: "unknown_mcp_session" });
        return;
      }
      if (session.authBindingKey !== requestAuthBindingKey) {
        sendJson(response, 404, { error: "unknown_mcp_session" });
        return;
      }
      try {
        await session.transport.handleRequest(
          request,
          response,
          parsedPostBody,
        );
      } catch (error) {
        console.error(error instanceof Error ? error : new Error(String(error)));
        sendJson(response, 500, { error: "mcp_transport_failed" });
      }
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 400, { error: "mcp_session_id_required" });
      return;
    }

    if (!isInitializeRequest(parsedPostBody)) {
      sendJsonRpcError(
        response,
        400,
        -32_600,
        "initialize request is required when no MCP session is present",
      );
      return;
    }
    if (closing) {
      sendJson(response, 503, { error: "north_mcp_endpoint_closing" });
      return;
    }

    const server = createSessionServer({
      authenticated,
      dispatcher: options.dispatcher,
      registry: options.registry,
    });
    pendingServers.add(server);
    const transport = new NodeStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (initializedSessionId) => {
        pendingServers.delete(server);
        if (closing) {
          void server.close().catch((error: unknown) => {
            console.error(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
          return;
        }
        sessions.set(initializedSessionId, {
          server,
          transport,
          authBindingKey: requestAuthBindingKey,
        });
      },
    });
    transport.onclose = () => {
      const initializedSessionId = transport.sessionId;
      if (initializedSessionId !== undefined) {
        sessions.delete(initializedSessionId);
      }
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, parsedPostBody);
    } catch (error) {
      await server.close().catch(() => undefined);
      console.error(error instanceof Error ? error : new Error(String(error)));
      sendJson(response, 500, { error: "mcp_initialize_failed" });
    } finally {
      pendingServers.delete(server);
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
    await closeHttpServer(httpServer);
    throw error;
  }

  const address = httpServer.address() as AddressInfo | null;
  if (address === null) {
    await closeHttpServer(httpServer);
    throw new Error("north MCP endpoint did not expose a TCP address");
  }
  boundPort = address.port;

  let closePromise: Promise<void> | undefined;
  return {
    endpoint: new URL(`http://${host}:${boundPort}${NORTH_MCP_PATH}`),
    host,
    port: boundPort,
    activeSessionCount: () => sessions.size,
    close(): Promise<void> {
      if (closePromise !== undefined) {
        return closePromise;
      }
      closing = true;
      closePromise = (async () => {
        const serversToClose = new Set([
          ...[...sessions.values()].map((session) => session.server),
          ...pendingServers,
        ]);
        const sessionCloseResults = await Promise.allSettled(
          [...serversToClose].map(async (server) => server.close()),
        );
        sessions.clear();
        pendingServers.clear();
        let httpCloseError: unknown;
        try {
          await closeHttpServer(httpServer);
        } catch (error) {
          httpCloseError = error;
        }
        const closeErrors = sessionCloseResults
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )
          .map((result) => result.reason);
        if (httpCloseError !== undefined) {
          closeErrors.push(httpCloseError);
        }
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
