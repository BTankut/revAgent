import { describe, expect, it } from "vitest";

import {
  C957_REAL_TRIO_CONTROL_SURFACE,
  REAL_TRIO_COMPONENTS,
  RealTrioCaseControlSurfaceError,
  assertRealTrioCaseControlSurface,
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
