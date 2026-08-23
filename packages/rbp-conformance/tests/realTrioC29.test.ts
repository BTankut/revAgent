import { describe, expect, it } from "vitest";

import {
  C957_REAL_TRIO_CONTROL_SURFACE,
  RealTrioCaseControlSurfaceError,
  assertRealTrioCaseControlSurface,
  realTrioCaseControlGaps,
} from "../src/realTrioCaseDriver.js";

describe("WP-12 real-trio C29 crash/restart/redelivery admission", () => {
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
