import { appendFileSync } from "node:fs";
import path from "node:path";

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

describe("production artifact mutation shard B", { timeout: 45_000 }, () => {
  it.each([
    {
      label: "add-in physical Ajv copy",
      relative: "packages/addin-loopback-fixture/node_modules/ajv/dist/runtime.js",
      expected: /runtime dependency closure|runtime dependencies/u,
    },
    {
      label: "controller physical Ajv copy",
      relative: "packages/rbp-conformance/node_modules/ajv/dist/runtime.js",
      expected: /conformance harness/u,
    },
    {
      label: "ajv-formats nested physical Ajv copy",
      relative: "node_modules/ajv-formats/node_modules/ajv/dist/runtime.js",
      expected: /runtime dependency closure|runtime dependencies|conformance harness/u,
    },
    {
      label: "native runtime addon",
      relative: "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      expected: /runtime dependency closure|runtime dependencies/u,
    },
  ])("invalidates a plan when $label bytes change", ({ relative, expected }) => {
    const value = productionProvenanceFixture();
    createFixtureSidecars(value);
    const plan = buildFixturePlan(value);
    appendFileSync(path.join(value.root, relative), Buffer.from("tamper"));
    expect(() => assertFixtureCurrent(value, plan)).toThrow(expected);
  });
});
