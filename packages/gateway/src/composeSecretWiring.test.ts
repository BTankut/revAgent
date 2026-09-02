import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

describe("EU-10 ephemeral Compose/CI credential wiring", () => {
  it("keeps the Keycloak bootstrap value in a host-only Compose secret file", () => {
    const compose = read("deploy/phase1/docker-compose.yml");
    const launcher = read("deploy/phase1/keycloak/start-keycloak.sh");
    expect(compose).not.toMatch(/^\s*KC_BOOTSTRAP_ADMIN_PASSWORD\s*:/mu);
    expect(compose).toContain("keycloak_bootstrap_credential");
    expect(compose).toContain("KEYCLOAK_BOOTSTRAP_CREDENTIAL_FILE");
    expect(compose).toContain("/opt/revagent/start-keycloak.sh");
    expect(read("deploy/phase1/keycloak/docker-compose.test.yml")).toContain("127.0.0.1:58080:8080");
    expect(launcher).toContain("/run/secrets/keycloak_bootstrap_credential");
    expect(launcher).toContain('KC_BOOTSTRAP_ADMIN_PASSWORD="$bootstrap_value"');
  });

  it("uses trust-only ephemeral Postgres and generated Keycloak bootstrap input in CI", () => {
    const workflow = read(".github/workflows/gateway-ci.yml");
    expect(workflow).toContain("POSTGRES_HOST_AUTH_METHOD: trust");
    expect(workflow).not.toMatch(/^\s*POSTGRES_PASSWORD\s*:/mu);
    expect(workflow).toContain('admin_password="$(openssl rand -hex 32)"');
    expect(workflow).toContain("KEYCLOAK_BOOTSTRAP_CREDENTIAL_FILE");
    expect(workflow).toContain("docker compose");
    expect(workflow).toContain('sudo chown 1000:1000 "$credential_file" "$keycloak_data"');
    expect(workflow).toContain("logs keycloak");
    expect(workflow).not.toContain("docker logs revagent-eu10-keycloak");
    expect(workflow).not.toMatch(/admin_password\s*=\s*["'][A-Za-z0-9_-]{16,}["']/u);
  });
});
