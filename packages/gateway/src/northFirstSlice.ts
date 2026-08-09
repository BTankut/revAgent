import {
  GatewayToolRegistry,
  M2_BOOTSTRAP_TOOL_RECORDS,
  type GatewayToolRecord,
} from "./registry.js";
import type { CatalogEntry } from "./entitledRegistry.js";

/**
 * The one callable tool in the bounded M2 north vertical slice.
 *
 * The complete entitled catalog is visible through the capability index, but
 * executable schema materialization remains a later GW-10 responsibility.
 */
export const M2_NORTH_FIRST_SLICE_CALLABLE = "core.ui.state" as const;

export class NorthFirstSliceCompositionError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NorthFirstSliceCompositionError";
  }
}

function fail(code: string, message: string): never {
  throw new NorthFirstSliceCompositionError(code, message);
}

/**
 * Builds the deliberately one-tool executable registry from GW-3 catalog
 * metadata and the reviewed empty-argument bootstrap schema.
 *
 * The catalog owns the published name, summary, version, policy and executor.
 * The bootstrap record owns only this slice's safe north schema. The legacy
 * seed's routing/task mixins are intentionally not exposed to the client.
 */
export function buildNorthFirstSliceCallableRegistry(
  catalog: readonly CatalogEntry[],
): GatewayToolRegistry {
  const matches = catalog.filter(
    (entry) => entry.name === M2_NORTH_FIRST_SLICE_CALLABLE,
  );
  if (matches.length !== 1) {
    fail(
      "callable_catalog_entry_count",
      `${M2_NORTH_FIRST_SLICE_CALLABLE} must appear exactly once in the GW-3 catalog`,
    );
  }

  const entry = matches[0]!;
  if (
    entry.tool !== "get_ui_state" ||
    entry.module !== "runtime" ||
    entry.policyClass !== "auto" ||
    entry.mutationScopePolicy !== "none" ||
    entry.executor !== "bridge"
  ) {
    fail(
      "callable_binding_mismatch",
      `${M2_NORTH_FIRST_SLICE_CALLABLE} must bind runtime/get_ui_state through the auto bridge executor`,
    );
  }

  const bootstrap = M2_BOOTSTRAP_TOOL_RECORDS[0];
  if (bootstrap === undefined) {
    fail(
      "callable_schema_missing",
      `${M2_NORTH_FIRST_SLICE_CALLABLE} has no reviewed bootstrap schema`,
    );
  }

  const record: GatewayToolRecord = Object.freeze({
    ...bootstrap,
    name: entry.name,
    summary: entry.summary,
    namespace: entry.namespace,
    version: entry.version,
    policyClass: entry.policyClass,
    mutationScopePolicy: entry.mutationScopePolicy,
    executor: entry.executor,
    executorMethod: entry.tool,
  });
  return new GatewayToolRegistry([record]);
}
