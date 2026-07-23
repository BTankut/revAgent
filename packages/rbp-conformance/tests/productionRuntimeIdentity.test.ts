import { describe, expect, it } from "vitest";

import { sanitizedProductionRuntimeEnvironment } from "../src/productionRuntimeIdentity.js";

describe("production runtime environment", () => {
  it("removes every Node and ws resolution switch without mutating unrelated values", () => {
    const result = sanitizedProductionRuntimeEnvironment({
      PATH: "C:/tools",
      SAFE_VALUE: "retained",
      NODE_OPTIONS: "--import=attacker.mjs",
      node_path: "C:/unbound-modules",
      Node_Preserve_Symlinks: "1",
      NODE_COMPILE_CACHE: "C:/cache",
      node_disable_compile_cache: "1",
      WS_NO_BUFFER_UTIL: "1",
      ws_no_utf_8_validate: "1",
    });
    expect(result).toEqual({
      PATH: "C:/tools",
      SAFE_VALUE: "retained",
    });
  });

  it("rejects attempts to reintroduce a stripped switch through overrides", () => {
    expect(() =>
      sanitizedProductionRuntimeEnvironment(
        { SAFE_VALUE: "retained" },
        { node_options: "--require=attacker.cjs" },
      )).toThrow(/cannot set node_options/u);
  });
});
