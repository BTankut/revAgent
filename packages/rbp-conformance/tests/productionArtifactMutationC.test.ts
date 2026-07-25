import { appendFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as yieldToWorkerControlPlane } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/productionLaunchAttestation.js", () => ({
  assertTrustedProductionLaunch: vi.fn(),
}));

import {
  assertFixtureCurrent,
  buildFixturePlan,
  cleanupProductionProvenanceFixtures,
  createFixtureSidecars,
  productionProvenanceFixture,
} from "./productionProvenanceFixture.js";

afterEach(cleanupProductionProvenanceFixtures);

describe("production artifact mutation shard C", { timeout: 45_000 }, () => {
  it.each([
    {
      label: "full TypeScript compiler runtime",
      relative: "node_modules/typescript/lib/_tsc.js",
      expected: /build toolchain provenance/u,
    },
    {
      label: "build generator transitive dependency",
      relative: "node_modules/generator-transitive/index.js",
      expected: /build-generator dependency provenance/u,
    },
    {
      label: "npm launcher main",
      relative: "node_modules/npm/bin/npm-cli.js",
      expected: /build toolchain provenance/u,
    },
    {
      label: "npm package runtime",
      relative: "node_modules/npm/node_modules/npm-runtime/index.js",
      expected: /build toolchain provenance/u,
    },
  ])("invalidates a plan when $label bytes change", async ({ relative, expected }) => {
    await yieldToWorkerControlPlane();
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const plan = buildFixturePlan(value);
    appendFileSync(path.join(value.root, relative), Buffer.from("tamper"));
    expect(() => assertFixtureCurrent(value, plan)).toThrow(expected);
  });
});
