import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildCatalog, type CatalogEntry } from "./entitledRegistry.js";
import {
  M2_NORTH_FIRST_SLICE_CALLABLE,
  NorthFirstSliceCompositionError,
  buildNorthFirstSliceCallableRegistry,
} from "./northFirstSlice.js";
import { verifyRegistrySeed } from "./registrySeed.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = buildCatalog(
  verifyRegistrySeed(
    JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8"),
    ) as unknown,
  ),
);

function replaceCallable(
  update: Partial<CatalogEntry>,
): readonly CatalogEntry[] {
  return catalog.map((entry) =>
    entry.name === M2_NORTH_FIRST_SLICE_CALLABLE
      ? Object.freeze({ ...entry, ...update })
      : entry,
  );
}

describe("M2 north first-slice composition", () => {
  it("derives the normal bootstrap and C39 recovery callables from the verified catalog", () => {
    expect(catalog).toHaveLength(41);

    const registry = buildNorthFirstSliceCallableRegistry(catalog);
    expect(registry.records()).toHaveLength(2);
    expect(registry.require(M2_NORTH_FIRST_SLICE_CALLABLE)).toMatchObject({
      name: "core.ui.state",
      executorMethod: "get_ui_state",
      policyClass: "auto",
      executor: "bridge",
      inputJsonSchema: {
        additionalProperties: false,
        properties: {},
        type: "object",
      },
    });
    expect(registry.require("core.dispatch.payload_recovery")).toMatchObject({
      executorMethod: "dispatch_payload_recovery",
      policyClass: "auto",
      executor: "bridge",
      inputJsonSchema: {
        additionalProperties: false,
        required: ["origin_invocation_id", "expected_result_digest"],
      },
    });
  });

  it.each([
    ["missing", catalog.filter((entry) => entry.name !== M2_NORTH_FIRST_SLICE_CALLABLE)],
    ["wrong method", replaceCallable({ tool: "get_revit_mcp_status" })],
    ["wrong policy", replaceCallable({ policyClass: "confirm" })],
    ["wrong executor", replaceCallable({ executor: "internal_mcp" })],
  ])("fails closed for a %s callable binding", (_caseName, candidate) => {
    expect(() => buildNorthFirstSliceCallableRegistry(candidate)).toThrow(
      NorthFirstSliceCompositionError,
    );
  });
});
