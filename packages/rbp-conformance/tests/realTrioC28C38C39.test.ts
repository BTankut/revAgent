import { describe, expect, it } from "vitest";

import {
  C957_REAL_TRIO_CONTROL_SURFACE,
  REAL_TRIO_COMPONENTS,
  RealTrioCaseControlSurfaceError,
  assertRealTrioCaseControlSurface,
  callRealTrioNorthMcp,
  issueNorthCredentialControlPayload,
  REAL_TRIO_NORTH_CASE_TOOL_MAP,
  REAL_TRIO_CASE_SEMANTIC_MAPPINGS,
  realTrioNorthToolForCase,
  realTrioSemanticMappingForCase,
  realTrioCaseControlGaps,
} from "../src/realTrioCaseDriver.js";

describe("WP-12 real-trio C28/C38/C39 case-driver admission", () => {
  it("maps every frozen C28/C29/C38/C39 program to one public north tool for both carriers", () => {
    expect(REAL_TRIO_NORTH_CASE_TOOL_MAP).toEqual({
      "O1-C28": { toolName: "conformance.fixture.c28_mutation", confirmation: true },
      "O1-C29": { toolName: "conformance.fixture.c29_atomic_batch", confirmation: true },
      "O1-C38": { toolName: "core.ui.state", confirmation: false },
      "O1-C39": { toolName: "conformance.fixture.c39_multifile", confirmation: false },
    });
    for (const caseId of ["O1-C28", "O1-C29", "O1-C38", "O1-C39"] as const) {
      expect(realTrioNorthToolForCase(caseId)).toBe(REAL_TRIO_NORTH_CASE_TOOL_MAP[caseId]);
    }
  });

  it("maps frozen controls to audited public routes and rejects private worker mutations", () => {
    expect(REAL_TRIO_CASE_SEMANTIC_MAPPINGS).toEqual({
      "O1-C28": expect.objectContaining({
        operations: ["audited_readiness", "fixture_fault", "north_tool_call", "north_confirm_commit", "public_audit_poll"],
      }),
      "O1-C29": expect.objectContaining({
        operations: ["audited_readiness", "fixture_fault", "north_tool_call", "north_confirm_commit", "public_audit_poll", "supervisor_restart"],
      }),
      "O1-C38": expect.objectContaining({
        operations: ["audited_readiness", "fixture_fault", "raw_binding", "public_audit_poll"],
      }),
      "O1-C39": expect.objectContaining({
        operations: ["audited_readiness", "north_tool_call", "public_audit_poll"],
      }),
    });
    const serialized = JSON.stringify(REAL_TRIO_CASE_SEMANTIC_MAPPINGS);
    expect(serialized).toContain("journal_mutate");
    expect(serialized).toContain("crash_latch_mutate");
    expect(serialized).toContain("resource_store_mutate");
    expect(REAL_TRIO_CASE_SEMANTIC_MAPPINGS["O1-C28"].operations).not.toContain("supervisor_restart");
    expect(realTrioSemanticMappingForCase("O1-C39")).toBe(
      REAL_TRIO_CASE_SEMANTIC_MAPPINGS["O1-C39"],
    );
  });
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
      if (caseId === "O1-C38") {
        expect(gaps.some(({ component, action }) =>
          component === "public_binding" && action === "send_binding_frame",
        )).toBe(true);
      } else {
        expect(gaps.some(({ component, action }) =>
          component === "gateway_production_conformance" &&
          ["dispatch_invoke", "dispatch_batch", "dispatch_payload_recovery"].includes(action),
        )).toBe(true);
      }
      expect(JSON.stringify(gaps)).not.toMatch(/stub|simulator/u);
    },
  );
});
