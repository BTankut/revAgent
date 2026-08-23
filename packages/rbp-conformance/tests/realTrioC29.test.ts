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
      component === "supervisor" && action === "restart_component",
    )).toBe(true);
    expect(() => assertRealTrioCaseControlSurface("O1-C29", C957_REAL_TRIO_CONTROL_SURFACE))
      .toThrow(RealTrioCaseControlSurfaceError);
    expect(JSON.stringify(gaps)).not.toMatch(/stub|simulator/u);
  });
});
