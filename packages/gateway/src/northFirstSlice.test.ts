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
  it("derives exactly one executable callable from the verified GW-3 catalog", () => {
    expect(catalog).toHaveLength(40);

    const registry = buildNorthFirstSliceCallableRegistry(catalog);
    expect(registry.records()).toHaveLength(1);
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
