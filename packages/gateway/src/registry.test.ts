import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  GatewayRegistryView,
  GatewayToolRegistry,
  type GatewayToolRecord,
} from "./registry.js";

const records: readonly GatewayToolRecord[] = [
  {
    name: "docs.type.details",
    summary: "Read Revit API type details.",
    namespace: "docs",
    version: "1.0.0",
    policyClass: "auto",
    mutationScopePolicy: "none",
    executor: "internal_mcp",
    executorMethod: "get_type_details",
    inputSchema: {},
    inputJsonSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {},
      type: "object",
    },
  },
  {
    name: "core.ui.state",
    summary: "Read the current Revit user-interface state.",
    namespace: "core",
    version: "1.0.0",
    policyClass: "auto",
    mutationScopePolicy: "none",
    executor: "bridge",
    executorMethod: "get_ui_state",
    inputSchema: {},
    inputJsonSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      additionalProperties: false,
      properties: {},
      type: "object",
    },
  },
];

describe("GatewayToolRegistry", () => {
  it("derives byte-stable capability-index bytes from registry order", () => {
    const forward = new GatewayToolRegistry(records);
    const reverse = new GatewayToolRegistry([...records].reverse());

    expect(forward.capabilityIndexBytes()).toBe(reverse.capabilityIndexBytes());
    expect(forward.capabilityIndex()).toEqual({
      schemaVersion: "revagent-capability-index/v1",
      tools: [
        {
          name: "core.ui.state",
          summary: "Read the current Revit user-interface state.",
          namespace: "core",
          version: "1.0.0",
          policyClass: "auto",
          executor: "bridge",
          schema: "deferred",
        },
        {
          name: "docs.type.details",
          summary: "Read Revit API type details.",
          namespace: "docs",
          version: "1.0.0",
          policyClass: "auto",
          executor: "internal_mcp",
          schema: "deferred",
        },
      ],
    });
    expect(forward.capabilityIndexBytes().endsWith("\n")).toBe(true);
  });

  it("derives immutable entitlement views from the same registry truth", () => {
    const registry = new GatewayToolRegistry(records);
    const coreOnly = registry.view(["core.ui.state"]);

    expect(coreOnly.registry()).toBe(registry);
    expect(coreOnly.records().map((record) => record.name)).toEqual([
      "core.ui.state",
    ]);
    expect(coreOnly.capabilityIndex().tools.map((tool) => tool.name)).toEqual([
      "core.ui.state",
    ]);
    expect(coreOnly.get("docs.type.details")).toBeUndefined();
    expect(() => coreOnly.require("docs.type.details")).toThrow(
      "unknown or unentitled",
    );
    expect(() => registry.view(["missing.tool"])).toThrow(
      "unknown Gateway tool in registry view",
    );
    expect(
      () =>
        new GatewayRegistryView(
          registry,
          new GatewayToolRegistry([records[0]!]).records(),
        ),
    ).toThrow("must originate from its registry");
  });

  it("fails closed on duplicate north names", () => {
    expect(() => new GatewayToolRegistry([records[0]!, records[0]!])).toThrow(
      "duplicate Gateway tool name",
    );
  });

  it("rejects a registry seed whose raw shape is not made of Zod schemas", () => {
    expect(
      () =>
        new GatewayToolRegistry([
          {
            ...records[0]!,
            inputSchema: { value: {} as never },
          },
        ]),
    ).toThrow("must be a Zod schema");
  });

  it.each([null, [], new Date(0), new Map()])(
    "rejects a non-plain raw input shape before copying it",
    (inputSchema) => {
      expect(
        () =>
          new GatewayToolRegistry([
            {
              ...records[0]!,
              inputSchema: inputSchema as never,
            },
          ]),
      ).toThrow("must be a Zod raw shape");
    },
  );

  it("requires the serializable schema to match the runtime shape", () => {
    expect(
      () =>
        new GatewayToolRegistry([
          {
            ...records[0]!,
            inputSchema: { value: z.string() },
            inputJsonSchema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              additionalProperties: false,
              properties: { value: { type: "number" } },
              required: ["value"],
              type: "object",
            },
          },
        ]),
    ).toThrow("must match the canonical executable schema");
  });
});
