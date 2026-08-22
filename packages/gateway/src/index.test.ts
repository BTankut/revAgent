import { describe, expect, it } from "vitest";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  GATEWAY_CREDENTIAL_SCOPE_SCHEMA,
  GatewayCompositionError,
  createProductionCredentialScopeLocator,
  createProductionIdentityAuthority,
  gatewayScaffold,
  isCanonicalMachineFingerprint,
  machineFingerprintClaimsEqual,
  type GatewayCompositionErrorReason,
} from "./index.js";

describe("gateway scaffold", () => {
  it("carries no M0 transport spike and declares the collected registry seed", () => {
    // GW-1 removed the W1-5 spike and the `bundle:legacy` graph it loaded:
    // the Gateway must never import the legacy stdio entry point or an M0
    // bundle, so the seed is the only legacy-derived input it declares.
    expect(gatewayScaffold).toMatchObject({
      milestone: "M2",
      protocol: "RBP/1",
      transportImplemented: true,
      registrySeedAvailable: true,
      m2FirstSliceAvailable: true,
      invocationAuthorityAvailable: true,
      modeADiscoveryAvailable: true,
    });
    expect(gatewayScaffold).not.toHaveProperty("transportSpikeAvailable");
  });

  it("loads the split MCP SDK v2 Node transport surface", () => {
    expect(NodeStreamableHTTPServerTransport).toBeTypeOf("function");
  });

  it("exports the production composition refusal contract", () => {
    const reason: GatewayCompositionErrorReason = "invalid_rbp_ingress_shape";
    expect(new GatewayCompositionError("rbp_ingress", reason)).toMatchObject({
      code: "gateway_composition_refused",
      port: "rbp_ingress",
      reason,
    });
  });

  it("exports the WP-06 production identity and fingerprint contracts", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    expect(GATEWAY_CREDENTIAL_SCOPE_SCHEMA).toBe(
      "gateway.credential-scope/v1",
    );
    expect(createProductionCredentialScopeLocator).toBeTypeOf("function");
    expect(createProductionIdentityAuthority).toBeTypeOf("function");
    expect(isCanonicalMachineFingerprint(fingerprint)).toBe(true);
    expect(machineFingerprintClaimsEqual(fingerprint, fingerprint)).toBe(true);
    expect(
      machineFingerprintClaimsEqual(fingerprint, `sha256:${"b".repeat(64)}`),
    ).toBe(false);
  });
});
