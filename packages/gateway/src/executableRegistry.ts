import { z, type ZodRawShape } from "zod";

import type { CatalogEntry } from "./entitledRegistry.js";
import {
  GatewayToolRegistry,
  type GatewayJsonSchema,
  type GatewayToolRecord,
} from "./registry.js";
import type { RegistrySeed, RegistrySeedTool } from "./registrySeed.js";

const JSON_SCHEMA_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";

/** P-GW-6: these workstation-routing fields are always server-authored. */
export const GATEWAY_SERVER_AUTHORED_INPUT_FIELDS = Object.freeze([
  "target",
  "host",
  "port",
  "taskName",
  "taskId",
  "parentTaskName",
  "parentTaskId",
] as const);

const SERVER_AUTHORED_FIELDS = new Set<string>(
  GATEWAY_SERVER_AUTHORED_INPUT_FIELDS,
);

export class ExecutableRegistryError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutableRegistryError";
  }
}

function fail(code: string, message: string): never {
  throw new ExecutableRegistryError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The frozen zod-3 collector emits draft-06-style boolean exclusive bounds
 * even though its target is 2020-12. Normalize only that mechanical mismatch
 * before Zod 4 materializes the executable validator.
 */
function normalizeLegacySchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLegacySchema(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (
      key === "minimum" &&
      value.exclusiveMinimum === true &&
      typeof member === "number"
    ) {
      continue;
    }
    if (
      key === "maximum" &&
      value.exclusiveMaximum === true &&
      typeof member === "number"
    ) {
      continue;
    }
    if (key === "exclusiveMinimum" && typeof member === "boolean") {
      if (member && typeof value.minimum === "number") {
        normalized.exclusiveMinimum = value.minimum;
      }
      continue;
    }
    if (key === "exclusiveMaximum" && typeof member === "boolean") {
      if (member && typeof value.maximum === "number") {
        normalized.exclusiveMaximum = value.maximum;
      }
      continue;
    }
    normalized[key] = normalizeLegacySchema(member);
  }
  return normalized;
}

/**
 * Projects the collected handler schema into the north-client contract.
 * Only root mixins are removed; identically named fields nested inside a
 * functional argument remain handler-owned data.
 */
export function projectGatewayInputJsonSchema(
  seedTool: RegistrySeedTool,
): GatewayJsonSchema {
  const normalized = normalizeLegacySchema(seedTool.inputJsonSchema);
  if (!isRecord(normalized) || !isRecord(normalized.properties)) {
    fail(
      "seed_schema_not_object",
      `${seedTool.name} must have an object input schema`,
    );
  }

  const properties = Object.fromEntries(
    Object.entries(normalized.properties).filter(
      ([name]) => !SERVER_AUTHORED_FIELDS.has(name),
    ),
  );
  const required = Array.isArray(normalized.required)
    ? normalized.required.filter(
        (name): name is string =>
          typeof name === "string" && !SERVER_AUTHORED_FIELDS.has(name),
      )
    : [];
  const projected: Record<string, unknown> = {
    ...normalized,
    $schema: JSON_SCHEMA_2020_12_URI,
    properties,
  };
  if (required.length > 0) {
    projected.required = required;
  } else {
    delete projected.required;
  }
  return Object.freeze(projected);
}

function materializeShape(
  seedTool: RegistrySeedTool,
): { readonly shape: ZodRawShape; readonly jsonSchema: GatewayJsonSchema } {
  const projected = projectGatewayInputJsonSchema(seedTool);
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(projected);
  } catch (error) {
    fail(
      "seed_schema_materialization_failed",
      `${seedTool.name} could not be materialized: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!(schema instanceof z.ZodObject)) {
    fail(
      "seed_schema_not_object",
      `${seedTool.name} did not materialize as a strict object schema`,
    );
  }
  const shape = Object.freeze({ ...schema.shape }) as ZodRawShape;
  const jsonSchema = z.toJSONSchema(z.object(shape).strict(), { io: "input" });
  return Object.freeze({
    shape,
    jsonSchema: Object.freeze(jsonSchema),
  });
}

/**
 * Builds the complete 40-tool executable registry from the already verified
 * seed and the GW-3 governance/catalog join. No frozen legacy module is loaded
 * at runtime; handler loading remains behind its separately verified manifest.
 */
export function buildGatewayExecutableRegistry(
  seed: RegistrySeed,
  catalog: readonly CatalogEntry[],
): GatewayToolRegistry {
  const catalogByTool = new Map(catalog.map((entry) => [entry.tool, entry]));
  const records: GatewayToolRecord[] = [];

  for (const seedTool of seed.tools) {
    const entry = catalogByTool.get(seedTool.name);
    if (entry === undefined) {
      fail(
        "catalog_entry_missing",
        `${seedTool.name} has no GW-3 catalog entry`,
      );
    }
    catalogByTool.delete(seedTool.name);
    if (entry.module !== seedTool.module) {
      fail(
        "catalog_module_mismatch",
        `${seedTool.name} disagrees with its catalog module`,
      );
    }
    const materialized = materializeShape(seedTool);
    records.push({
      name: entry.name,
      summary: entry.summary,
      namespace: entry.namespace,
      version: entry.version,
      policyClass: entry.policyClass,
      mutationScopePolicy: entry.mutationScopePolicy,
      executor: entry.executor,
      executorMethod: entry.tool,
      inputSchema: materialized.shape,
      inputJsonSchema: materialized.jsonSchema,
    });
  }

  if (catalogByTool.size > 0) {
    fail(
      "catalog_seed_missing",
      `catalog entries are absent from the seed: ${[
        ...catalogByTool.keys(),
      ]
        .sort()
        .join(", ")}`,
    );
  }
  return new GatewayToolRegistry(records);
}
