import { describe, expect, it } from "vitest";

import {
  C957_REAL_TRIO_CONTROL_SURFACE,
  REAL_TRIO_COMPONENTS,
  RealTrioCaseControlSurfaceError,
  assertRealTrioCaseControlSurface,
  callRealTrioNorthMcp,
  issueNorthCredentialControlPayload,
  realTrioCaseControlGaps,
} from "../src/realTrioCaseDriver.js";

describe("WP-12 real-trio C28/C38/C39 case-driver admission", () => {
  it("uses only the production Gateway, real C# worker, and loopback fixture identities", () => {
    expect(REAL_TRIO_COMPONENTS).toEqual([
      "gateway_production_conformance",
      "bridge_worker",
      "addin_loopback_fixture",
    ]);
    expect(JSON.stringify(REAL_TRIO_COMPONENTS)).not.toMatch(/stub|simulator/u);
  });

  it("uses an exact public north-credential control payload and refuses non-loopback MCP targets before any bearer use", async () => {
    expect(issueNorthCredentialControlPayload()).toEqual({ action: "issue_north_credential" });
    await expect(callRealTrioNorthMcp({
      endpoint: "https://localhost:443",
      certificateSha256: "sha256:deadbeef",
      credential: {
        bearer: "must-not-reach-network",
        audience: "https://127.0.0.1/mcp",
        credentialProvenance: "gateway_production_conformance",
        identityContract: "revagent.auth-context/v1",
      },
      effectiveMcpSessionId: "real-case-session-1",
      request: { jsonrpc: "2.0", id: "x", method: "tools/list" },
    })).rejects.toThrow(/numeric loopback TLS/u);
  });

  it.each(["O1-C28", "O1-C38", "O1-C39"] as const)(
    "%s preserves every frozen step and fails closed when C957 lacks a real route",
    (caseId) => {
      const gaps = realTrioCaseControlGaps(caseId, C957_REAL_TRIO_CONTROL_SURFACE);
      expect(gaps.length).toBeGreaterThan(0);
      expect(() => assertRealTrioCaseControlSurface(caseId, C957_REAL_TRIO_CONTROL_SURFACE))
        .toThrow(RealTrioCaseControlSurfaceError);
      expect(gaps.some(({ component, action }) =>
        component === "gateway_production_conformance" &&
        ["dispatch_invoke", "dispatch_batch", "dispatch_payload_recovery"].includes(action),
      )).toBe(true);
      expect(JSON.stringify(gaps)).not.toMatch(/stub|simulator/u);
    },
  );
});
