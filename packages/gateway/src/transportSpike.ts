import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const SPIKE_PATH = "/mcp";
const SUPPORTED_METHODS = new Set(["DELETE", "GET", "POST"]);
const PACKAGE_ROOT_URL = new URL("../", import.meta.url);
const RUNTIME_REGISTER_TOOLS_URL = new URL(
  "dist/runtime/tools/register.js",
  PACKAGE_ROOT_URL,
);

interface RuntimeRegisterModule {
  registerTools(server: McpServer): Promise<void>;
}

export interface TransportSpikeOptions {
  host?: "127.0.0.1" | "localhost";
  port?: number;
}

export interface TransportSpikeHandle {
  endpoint: URL;
  host: string;
  port: number;
  close(): Promise<void>;
}

async function registerExistingRuntimeTools(server: McpServer): Promise<void> {
  const runtimeModule = (await import(
    RUNTIME_REGISTER_TOOLS_URL.href
  )) as unknown as RuntimeRegisterModule;
  if (typeof runtimeModule.registerTools !== "function") {
    throw new TypeError(
      `registerTools export is missing from ${RUNTIME_REGISTER_TOOLS_URL.pathname}`,
    );
  }
  await runtimeModule.registerTools(server);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
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

async function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
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

export async function startTransportSpike(
  options: TransportSpikeOptions = {},
): Promise<TransportSpikeHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;

  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new RangeError("the M0 transport spike may bind only to loopback");
  }

  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }

  const mcpServer = new McpServer({
    name: "revAgent transport spike",
    version: "0.0.0-m0",
  });
  await registerExistingRuntimeTools(mcpServer);

  const transport = new StreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: randomUUID,
  });
  await mcpServer.connect(transport);

  let boundPort = 0;
  const httpServer = createServer((request, response) => {
    void handleRequest(request, response);
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = (request.url ?? "").split("?", 1)[0];
    if (path !== SPIKE_PATH) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }

    if (!isAllowedHostHeader(request.headers.host, host, boundPort)) {
      sendJson(response, 403, { error: "invalid_host" });
      return;
    }

    if (!SUPPORTED_METHODS.has(request.method ?? "")) {
      response.setHeader("allow", [...SUPPORTED_METHODS].join(", "));
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }

    try {
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error(error instanceof Error ? error : new Error(String(error)));
      sendJson(response, 500, {
        jsonrpc: "2.0",
        error: { code: -32_603, message: "Transport spike request failed" },
        id: null,
      });
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
    await mcpServer.close();
    throw error;
  }

  const address = httpServer.address() as AddressInfo | null;
  if (address === null) {
    await closeHttpServer(httpServer);
    await mcpServer.close();
    throw new Error("transport spike server did not expose a TCP address");
  }
  boundPort = address.port;

  let closed = false;
  return {
    endpoint: new URL(`http://${host}:${boundPort}${SPIKE_PATH}`),
    host,
    port: boundPort,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await closeHttpServer(httpServer);
      await mcpServer.close();
    },
  };
}
