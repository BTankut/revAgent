import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildCatalog } from "./entitledRegistry.js";
import {
  GATEWAY_SERVER_AUTHORED_INPUT_FIELDS,
  buildGatewayExecutableRegistry,
} from "./executableRegistry.js";
import { verifyRegistrySeed } from "./registrySeed.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seed = verifyRegistrySeed(
  JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8"),
  ) as unknown,
);
const catalog = buildCatalog(seed);

describe("GW-10 executable registry", () => {
  it("materializes all 41 governed tools with exact executor bindings", () => {
    const registry = buildGatewayExecutableRegistry(seed, catalog);

    expect(registry.records()).toHaveLength(41);
    expect(
      registry
        .records()
        .filter(
          (record) =>
            record.name.startsWith("core.docs.") &&
            record.executor === "internal_mcp",
        ),
    ).toHaveLength(5);
    expect(registry.require("core.element.query")).toMatchObject({
      executor: "bridge",
      executorMethod: "find_elements",
    });
    expect(registry.require("core.docs.search")).toMatchObject({
      executor: "internal_mcp",
      executorMethod: "search_api",
    });
  });

  it("strips only the seven server-authored root fields from north schemas", () => {
    const registry = buildGatewayExecutableRegistry(seed, catalog);

    for (const record of registry.records()) {
      const properties = record.inputJsonSchema.properties as Record<
        string,
        unknown
      >;
      for (const field of GATEWAY_SERVER_AUTHORED_INPUT_FIELDS) {
        expect(properties).not.toHaveProperty(field);
      }
    }
    expect(
      (
        registry.require("core.spatial.capture").inputJsonSchema
          .properties as Record<string, unknown>
      ).levelNames,
    ).toBeDefined();
  });

  it("preserves executable validation after JSON Schema materialization", () => {
    const registry = buildGatewayExecutableRegistry(seed, catalog);
    const docs = registry.require("core.docs.search");
    const docsSchema = z.object(docs.inputSchema).strict();

    expect(docsSchema.safeParse({ query: "Wall.Create" }).success).toBe(true);
    expect(docsSchema.safeParse({ query: "" }).success).toBe(false);
    expect(docsSchema.safeParse({ query: "Wall", limit: 100 }).success).toBe(
      true,
    );
    expect(docsSchema.safeParse({ query: "Wall", limit: 101 }).success).toBe(
      false,
    );
  });
});
