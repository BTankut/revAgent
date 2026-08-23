import { describe, expect, it } from "vitest";

import {
  C957_REAL_TRIO_CONTROL_SURFACE,
  REAL_TRIO_CASE_SEMANTIC_MAPPINGS,
  RealTrioCaseControlSurfaceError,
  assertRealTrioCaseControlSurface,
  realTrioCaseControlGaps,
} from "../src/realTrioCaseDriver.js";

describe("WP-12 real-trio C29 crash/restart/redelivery admission", () => {
  it("uses only the real supervisor restart mapping and keeps journal evidence read-only", () => {
    const mapping = REAL_TRIO_CASE_SEMANTIC_MAPPINGS["O1-C29"];
    expect(mapping.operations).toContain("supervisor_restart");
    expect(mapping.operations).toContain("public_audit_poll");
    expect(mapping.rejectedFrozenActions).toEqual(expect.arrayContaining([
      "inject_crash",
      "restart_simulator",
      "journal_mutate",
      "crash_latch_mutate",
    ]));
  });

  it("does not replace the real worker crash/restart boundary with a synthetic controller", () => {
    const gaps = realTrioCaseControlGaps("O1-C29", C957_REAL_TRIO_CONTROL_SURFACE);
    expect(gaps.some(({ component, action }) =>
      component === "bridge_worker" && action === "inject_crash",
    )).toBe(true);
    expect(gaps.some(({ component, action }) =>
      component === "bridge_worker" && action === "restart_simulator",
    )).toBe(true);
    expect(() => assertRealTrioCaseControlSurface("O1-C29", C957_REAL_TRIO_CONTROL_SURFACE))
      .toThrow(RealTrioCaseControlSurfaceError);
    // The frozen program's historical action token is `restart_simulator`;
    // admission must not manufacture a simulator *component* to satisfy it.
    expect(gaps.map(({ component }) => component)).not.toContain("simulator");
  });
});
