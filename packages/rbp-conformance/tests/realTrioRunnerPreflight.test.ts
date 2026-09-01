import { describe, expect, it } from "vitest";

// @ts-expect-error -- the preflight stays plain Node ESM so it can run before TS compilation.
import {
  assertCleanRealTrioSource,
  assertNoForbiddenRealTrioReferences,
  assertRealTrioNode24,
} from "../scripts/real-trio-runner-preflight.mjs";

describe("WP-12 dedicated real-trio runner preflight", () => {
  it("accepts a clean exact source and Node 24 ABI 137", () => {
    expect(() => assertCleanRealTrioSource("", "a".repeat(40), "b".repeat(40))).not.toThrow();
    expect(() => assertRealTrioNode24({ node: "24.14.1", modules: "137" })).not.toThrow();
  });

  it("fails closed for dirty source or malformed source anchor", () => {
    expect(() => assertCleanRealTrioSource(" M packages/gateway/src/index.ts", "a".repeat(40), "b".repeat(40)))
      .toThrow(/clean committed worktree/u);
    expect(() => assertCleanRealTrioSource("", "not-a-sha", "b".repeat(40)))
      .toThrow(/invalid HEAD commit/u);
  });

  it("fails closed for a non-Node-24 or non-ABI-137 process", () => {
    expect(() => assertRealTrioNode24({ node: "22.22.2", modules: "127" }))
      .toThrow(/Node >=24 with ABI 137/u);
    expect(() => assertRealTrioNode24({ node: "24.14.1", modules: "127" }))
      .toThrow(/Node >=24 with ABI 137/u);
  });

  it("rejects legacy setup, supervisor, and surrogate component imports", () => {
    for (const source of [
      'import "./globalSetup.js";',
      'import { supervisor } from "../src/caseStackSupervisor.js";',
      'const component = "gateway_stub";',
    ]) {
      expect(() => assertNoForbiddenRealTrioReferences(source)).toThrow(/forbidden/u);
    }
  });
});
