import { appendFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertFixtureCurrent,
  buildFixturePlan,
  cleanupProductionProvenanceFixtures,
  createFixtureSidecars,
  productionProvenanceFixture,
} from "./productionProvenanceFixture.js";

afterEach(cleanupProductionProvenanceFixtures);

describe("production artifact mutation shard A", { timeout: 45_000 }, () => {
  it.each([
    {
      label: "component runtime output",
      relative: "packages/gateway-stub/dist/cli.js",
      expected: /entrypoint digest is stale|runtime artifacts/u,
    },
    {
      label: "controller runner or validator output",
      relative: "packages/rbp-conformance/dist/src/validator.js",
      expected: /conformance harness/u,
    },
    {
      label: "external JavaScript runtime dependency",
      relative: "node_modules/ws/index.js",
      expected: /runtime dependency closure|runtime dependencies/u,
    },
    {
      label: "protocol physical Ajv copy",
      relative: "packages/protocol/node_modules/ajv/dist/runtime.js",
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
