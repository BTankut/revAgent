import { describe, expect, it } from "vitest";
import {
  GATEWAY_CONFIG_ENV_ALLOWLIST,
  GATEWAY_STARTUP_LOG_FIELD_ALLOWLIST,
  loadGatewayConfig,
  startupLogFields,
} from "./config.js";

const PROVIDER_PATTERN =
  /(llm|openai|anthropic|azure|bedrock|vertex|gemini|provider|model|prompt|api_?key|chat)/iu;

const VALID = {
  NODE_ENV: "development",
  PORT: "8080",
} as const;

describe("gateway config allowlist", () => {
  it("reads only the explicit names and none of them is a model/provider/raw-key setting", () => {
    // This is the acceptance criterion made mechanical. If someone adds a
    // provider key to the allowlist, this fails rather than a reviewer having
    // to notice it in a diff.
    expect(GATEWAY_CONFIG_ENV_ALLOWLIST).toHaveLength(9);
    for (const name of GATEWAY_CONFIG_ENV_ALLOWLIST) {
      expect(name).not.toMatch(PROVIDER_PATTERN);
    }
  });

  it("cannot see a provider key even when the environment carries one", () => {
    // An allowlist rather than a denylist: the point is that these are
    // unreachable, not that they are checked and rejected.
    const result = loadGatewayConfig({
      ...VALID,
      OPENAI_API_KEY: "sk-should-never-be-read",
      ANTHROPIC_API_KEY: "sk-should-never-be-read",
      MODEL_NAME: "should-never-be-read",
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("should-never-be-read");
  });

  it("permits only a protected key-file path, never a raw C39 key", () => {
    const result = loadGatewayConfig({
      ...VALID,
      C39_PROTECTED_OBJECT_KEY_FILE: "/run/revagent/c39-key.json",
      C39_PROTECTED_OBJECT_KEY: "must-not-be-read",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { objectStore: { protectedObjectKeyFile: "/run/revagent/c39-key.json" } },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-read");
  });

  it("ignores the OIDC variables the deployment still injects", () => {
    // Compose keeps supplying these for a later work package. Phase 1 must not
    // read them: that is what makes "no real OIDC is implemented here" true in
    // code rather than in prose.
    const result = loadGatewayConfig({
      ...VALID,
      OIDC_ISSUER_URL: "issuer-value",
      OIDC_CLIENT_ID: "client-value",
      OIDC_CLIENT_SECRET: "secret-value",
    });
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("issuer-value");
    expect(serialized).not.toContain("client-value");
    expect(serialized).not.toContain("secret-value");
  });

  it("keeps the startup log to an enumerated, secret-free field set", () => {
    const result = loadGatewayConfig(VALID);
    if (!result.ok) {
      throw new Error("expected a valid config");
    }
    const fields = startupLogFields(result.value);
    expect(Object.keys(fields).sort()).toEqual(
      [...GATEWAY_STARTUP_LOG_FIELD_ALLOWLIST].sort(),
    );
    for (const key of Object.keys(fields)) {
      expect(key).not.toMatch(PROVIDER_PATTERN);
    }
  });
});

describe("gateway config validation", () => {
  it("never echoes an environment value into a problem message", () => {
    // A rejected DATABASE_URL must not print its own password into a CI log.
    const result = loadGatewayConfig({
      ...VALID,
      DATABASE_URL: "postgres://user:hunter2@/",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("reduces a valid DATABASE_URL to a boolean and keeps the string nowhere", () => {
    const result = loadGatewayConfig({
      ...VALID,
      DATABASE_URL: "postgres://user:hunter2@db.internal:5432/revagent",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.value.credentialsPresent.databaseUrl).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("hunter2");
  });

  it("rejects the shipped placeholder rather than treating it as configured", () => {
    const result = loadGatewayConfig({
      ...VALID,
      DATABASE_URL: "replace-with-a-postgresql-connection-url",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a loopback bind in production", () => {
    // Otherwise the container answers its own health check while the proxy in
    // front of it gets connection refused -- green light, no traffic.
    const result = loadGatewayConfig({
      NODE_ENV: "production",
      GATEWAY_PUBLIC_URL: "https://gateway.example",
      GATEWAY_BIND_HOST: "127.0.0.1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.problems.map((p) => p.reason)).toContain(
      "loopback_bind_in_production",
    );
  });

  it("defaults the bind host to every interface", () => {
    const result = loadGatewayConfig(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.value.http.bindHost).toBe("0.0.0.0");
  });

  it("requires an https public URL in production", () => {
    expect(
      loadGatewayConfig({ NODE_ENV: "production", GATEWAY_BIND_HOST: "0.0.0.0" }).ok,
    ).toBe(false);
    expect(
      loadGatewayConfig({
        NODE_ENV: "production",
        GATEWAY_BIND_HOST: "0.0.0.0",
        GATEWAY_PUBLIC_URL: "http://gateway.example",
      }).ok,
    ).toBe(false);
  });

  it("requires an explicit https origin for pre-production LAN serving", () => {
    const missingBind = loadGatewayConfig({
      NODE_ENV: "preproduction",
      GATEWAY_PUBLIC_URL: "https://m4-gateway.example.test",
    });
    expect(missingBind.ok).toBe(false);
    if (missingBind.ok) {
      throw new Error("unreachable");
    }
    expect(missingBind.problems).toContainEqual(
      expect.objectContaining({
        variable: "GATEWAY_BIND_HOST",
        reason: "missing_required",
      }),
    );
    expect(
      loadGatewayConfig({
        NODE_ENV: "preproduction",
        GATEWAY_BIND_HOST: "0.0.0.0",
      }).ok,
    ).toBe(false);
    expect(
      loadGatewayConfig({
        NODE_ENV: "preproduction",
        GATEWAY_BIND_HOST: "0.0.0.0",
        GATEWAY_PUBLIC_URL: "http://m4-gateway.example.test",
      }).ok,
    ).toBe(false);
    const valid = loadGatewayConfig({
      NODE_ENV: "preproduction",
      // This is the explicit *container* bind. The later NETWORK/ACL card
      // separately binds Docker's host publish to 192.168.90.154.
      GATEWAY_BIND_HOST: "0.0.0.0",
      GATEWAY_PUBLIC_URL: "https://m4-gateway.example.test",
    });
    expect(valid).toMatchObject({
      ok: true,
      value: { nodeEnv: "preproduction" },
    });
    for (const bindHost of ["127.0.0.1", "::", "192.168.90.154"]) {
      const nonExact = loadGatewayConfig({
        NODE_ENV: "preproduction",
        GATEWAY_BIND_HOST: bindHost,
        GATEWAY_PUBLIC_URL: "https://m4-gateway.example.test",
      });
      expect(nonExact.ok).toBe(false);
      if (nonExact.ok) {
        throw new Error("unreachable");
      }
      expect(nonExact.problems.map((problem) => problem.reason)).toContain(
        "invalid_preproduction_bind",
      );
    }
  });

  it("reports every problem rather than stopping at the first", () => {
    const result = loadGatewayConfig({
      NODE_ENV: "banana",
      LOG_LEVEL: "chatty",
      PORT: "70000",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });

  it("does not substitute a default for a value it rejected", () => {
    const result = loadGatewayConfig({ ...VALID, PORT: "abc" });
    expect(result.ok).toBe(false);
  });
});
