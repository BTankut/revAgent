import { describe, expect, it } from "vitest";

import { startProductionGatewayHost } from "./productionConformanceHost.js";
import type { GatewayServerOptions } from "./server.js";
import { createFailClosedPorts } from "./server.js";

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
      hostProfile: "production_conformance",
    })).rejects.toThrow(/conformance-only/u);
    await expect(startProductionGatewayHost({
      server: server("test", "localhost"),
      ports: null as unknown as GatewayServerOptions["ports"],
      authority: null as unknown as never,
      hostProfile: "production_conformance",
    })).rejects.toThrow(/numeric loopback/u);
  });
  it("requires the explicit profile and a complete conformance tuple before opening a socket", async () => {
    const ports = createFailClosedPorts();
    await expect(startProductionGatewayHost({
      server: { ...server("test", "127.0.0.1"), tls: { key: Buffer.from("test"), cert: Buffer.from("test") } }, ports,
      authority: null as unknown as never,
      hostProfile: "not_conformance" as never,
    })).rejects.toThrow(/host profile/u);
    await expect(startProductionGatewayHost({
      server: { ...server("test", "127.0.0.1"), tls: { key: Buffer.from("test"), cert: Buffer.from("test") } }, ports,
      authority: null as unknown as never,
      hostProfile: "production_conformance",
    })).rejects.toThrow(/explicit conformance identity/u);
  });
  it("refuses a plaintext listener before any adapter startup", async () => {
    await expect(startProductionGatewayHost({
      server: server("test", "127.0.0.1"),
      ports: null as unknown as GatewayServerOptions["ports"],
      authority: null as unknown as never,
      hostProfile: "production_conformance",
    })).rejects.toThrow(/loopback TLS/u);
  });
});
