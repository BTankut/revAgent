import { describe, expect, it } from "vitest";
import { loadGatewayConfig, type GatewayConfig } from "./config.js";
import {
  GatewayFixturePortError,
  assertProductionPorts,
  buildFastifyOptions,
  createFailClosedPorts,
  createGatewayApp,
} from "./server.js";
import { createFakeIdentityPort } from "./testAdapters.js";

function configFor(env: Record<string, string>): GatewayConfig {
  const loaded = loadGatewayConfig(env);
  if (!loaded.ok) {
    throw new Error(`unexpected invalid config: ${JSON.stringify(loaded.problems)}`);
  }
  return loaded.value;
}

const DEV = configFor({ NODE_ENV: "development", LOG_LEVEL: "fatal" });
const PROD = configFor({
  NODE_ENV: "production",
  LOG_LEVEL: "fatal",
  GATEWAY_BIND_HOST: "0.0.0.0",
  GATEWAY_PUBLIC_URL: "https://gateway.example",
});

describe("production port gate", () => {
  it("refuses to serve production traffic through a fixture adapter", () => {
    // Not "no code path selects a fake" -- that stops being true the first time
    // someone adds a convenience branch. This is an executable gate.
    const ports = { ...createFailClosedPorts(), identity: createFakeIdentityPort() };
    expect(() => assertProductionPorts(PROD, ports)).toThrow(GatewayFixturePortError);
  });

  it("allows a fixture adapter outside production", () => {
    const ports = { ...createFailClosedPorts(), identity: createFakeIdentityPort() };
    expect(() => assertProductionPorts(DEV, ports)).not.toThrow();
  });

  it("accepts the fail-closed ports in production", () => {
    expect(() => assertProductionPorts(PROD, createFailClosedPorts())).not.toThrow();
  });
});

describe("fastify options", () => {
  it("does not trust proxy headers", () => {
    // The edge proxy appends to X-Forwarded-For, so an attacker-set header
    // would become the leftmost entry and be adopted as the client address in
    // every audit-correlated log line.
    expect(buildFastifyOptions(DEV)).not.toHaveProperty("trustProxy");
  });

  it("redacts credential-bearing headers out of the request log", () => {
    const options = buildFastifyOptions(DEV);
    const logger = options.logger as { redact?: { paths: string[]; remove: boolean } };
    expect(logger.redact?.remove).toBe(true);
    expect(logger.redact?.paths).toContain("req.headers.authorization");
  });
});

describe("routes", () => {
  it("reports health with exactly two states and no inventory", async () => {
    // Served on the public hostname through the edge proxy with no path
    // matcher, so any subsystem list here is unauthenticated reconnaissance.
    const app = createGatewayApp({ config: DEV, ports: createFailClosedPorts() });
    const ok = await app.inject({ method: "GET", url: "/healthz" });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ status: "ok" });

    (app as unknown as { beginGatewayShutdown: () => void }).beginGatewayShutdown();
    const draining = await app.inject({ method: "GET", url: "/healthz" });
    expect(draining.statusCode).toBe(503);
    expect(JSON.parse(draining.body)).toEqual({ status: "shutting_down" });
    await app.close();
  });

  it("refuses the north MCP mount rather than leaving it absent", async () => {
    // A later task must replace a refusing route, never add a missing one: a
    // client that meets a 404 cannot tell "not built yet" from "wrong URL".
    const app = createGatewayApp({ config: DEV, ports: createFailClosedPorts() });
    const response = await app.inject({ method: "POST", url: "/mcp" });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({
      error: "not_implemented",
      port: "north_mcp",
    });
    await app.close();
  });

  it("refuses the RBP ingress prefix and everything under it", async () => {
    const app = createGatewayApp({ config: DEV, ports: createFailClosedPorts() });
    for (const url of [
      "/bridge/v1",
      "/bridge/v1/http/connections",
      "/bridge/v1/anything/else",
    ]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        error: "not_implemented",
        port: "rbp_ingress",
      });
    }
    await app.close();
  });

  it("answers an unknown path with a structured 404", async () => {
    const app = createGatewayApp({ config: DEV, ports: createFailClosedPorts() });
    const response = await app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "not_found" });
    await app.close();
  });
});
