import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  attestProductionGatewayModuleGraph,
  validateProductionTrioRuntimeAttestation,
  type ProductionTrioRuntimeAttestation,
} from "../src/productionTrioConformance.js";

const digest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

function attestation(): ProductionTrioRuntimeAttestation {
  return {
    contractVersion: "revagent.production-trio-conformance/v1",
    environment: "conformance_nonproduction",
    gatewayHost: "productionGatewayHost",
    components: ["gateway_production_conformance", "bridge_worker", "addin_loopback_fixture"],
    bindings: ["wss", "streamable_http_sse"],
    gatewayImports: [
      "bridgeSession.ts", "rbpIngress.ts", "server.ts",
    ].map((name) => ({ modulePath: `packages/gateway/src/${name}`, sha256: digest })),
    adapters: ["credential", "protocol_store", "object_store", "resource_authority"].map((role) => ({
      role: role as "credential" | "protocol_store" | "object_store" | "resource_authority",
      implementation: `${role}-adapter/v1`,
      configurationRedacted: true,
      durable: role !== "credential",
    })),
    listener: { host: "127.0.0.1", pid: 42, tlsCertificateSha256: digest },
    evidenceLabels: ["conformance", "non-production"],
  };
}

describe("WP-12 production Gateway/trio conformance boundary", () => {
  it("pins exact production Gateway imports and rejects simulator/pre-production composition", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rbp-production-trio-"));
    for (const file of ["bridgeSession.ts", "rbpIngress.ts", "server.ts"]) {
      const directory = path.join(root, "packages", "gateway", "src");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, file), `${file}\n`, "utf8");
    }
    writeFileSync(path.join(root, "packages", "gateway", "src", "productionConformanceHost.ts"), [
      'import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";',
      'import { createProductionRbpIngressHost } from "./rbpIngress.js";',
      'import { startGatewayServer } from "./server.js";',
    ].join("\n"), "utf8");
    expect(attestProductionGatewayModuleGraph({ repoRoot: root, hostSource: "packages/gateway/src/productionConformanceHost.ts" })).toHaveLength(3);
    writeFileSync(path.join(root, "packages", "gateway", "src", "productionConformanceHost.ts"), 'import "gateway-stub";\n', "utf8");
    expect(() => attestProductionGatewayModuleGraph({ repoRoot: root, hostSource: "packages/gateway/src/productionConformanceHost.ts" }))
      .toThrow(/forbidden/u);
  });

  it("requires loopback-only, redacted, durable, explicitly non-production evidence", () => {
    expect(() => validateProductionTrioRuntimeAttestation(attestation())).not.toThrow();
    const invalid = attestation() as { environment: string; adapters: Array<{ configurationRedacted: boolean }> };
    invalid.environment = "production";
    invalid.adapters[1]!.configurationRedacted = false;
    expect(() => validateProductionTrioRuntimeAttestation(invalid as ProductionTrioRuntimeAttestation))
      .toThrow(/malformed/u);
  });
});
