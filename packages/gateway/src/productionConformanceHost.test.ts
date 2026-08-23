import { describe, expect, it } from "vitest";

import { startProductionGatewayHost } from "./productionConformanceHost.js";
import type { GatewayServerOptions } from "./server.js";

function server(nodeEnv: "test" | "production", bindHost: string): Omit<GatewayServerOptions, "ports"> {
  return {
    config: {
      nodeEnv,
      logLevel: "fatal",
      http: { bindHost, port: 0 },
      publicUrl: "https://gateway.invalid",
      objectStore: { driver: "fs", root: null },
      credentialsPresent: { databaseUrl: false },
      ingress: { northMcpMountPath: "/mcp", rbpMountPrefix: "/bridge/v1" },
    },
  };
}

describe("productionGatewayHost", () => {
  it("is explicitly non-production and numeric-loopback only before any port can start", async () => {
    await expect(startProductionGatewayHost({
      server: server("production", "127.0.0.1"),
      ports: null as unknown as GatewayServerOptions["ports"],
      authority: null as unknown as never,
    })).rejects.toThrow(/conformance-only/u);
    await expect(startProductionGatewayHost({
      server: server("test", "localhost"),
      ports: null as unknown as GatewayServerOptions["ports"],
      authority: null as unknown as never,
    })).rejects.toThrow(/numeric loopback/u);
  });
});
