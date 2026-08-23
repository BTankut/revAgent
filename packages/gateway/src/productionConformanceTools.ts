import { z } from "zod";

import type { CatalogEntry } from "./entitledRegistry.js";
import type { GatewayToolRecord } from "./registry.js";

const schema = (shape: Record<string, z.ZodType>): GatewayToolRecord["inputJsonSchema"] =>
  z.toJSONSchema(z.object(shape).strict(), { io: "input" });

/**
 * Fixed, non-production-only tools used by the WP-12 real carrier cases.
 * They deliberately live outside M2_BOOTSTRAP_TOOL_RECORDS: shipping or
 * pre-production registries must never acquire a fixture mutation surface.
 */
const C28_INPUT = Object.freeze({
  vector: z.literal("O1-C28"),
  fixtureOnly: z.literal(true),
});

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const C29_STEP = z.object({
  index: z.number().int().min(0).max(63),
  invocationId: z.string().regex(UUID_V7),
  method: z.literal("delete_review_view"),
  params: z.object({
    viewName: z.literal("revAgent_QA_WP12_fixture"),
    exactName: z.literal(true),
    mode: z.literal("commit"),
    confirmDelete: z.literal(true),
  }).strict(),
  paramsDigest: z.string().regex(SHA256),
  effect: z.literal("model_transaction"),
}).strict();
const C29_INPUT = Object.freeze({
  batchContractVersion: z.literal(1),
  batchId: z.string().regex(UUID_V7),
  batchDigest: z.string().regex(SHA256),
  atomic: z.literal(true),
  rollbackPolicy: z.literal("rollback_on_non_success"),
  maxAggregateResultBytes: z.number().int().min(1).max(33_554_432),
  steps: z.array(C29_STEP).min(1).max(64),
});

const C39_INPUT = Object.freeze({
  scenario: z.literal("valid_multifile"),
  fileCount: z.number().int().min(1).max(16),
  bytesPerFile: z.number().int().min(1).max(1_048_576),
  contentType: z.literal("application/octet-stream"),
});

export const PRODUCTION_CONFORMANCE_TOOL_RECORDS = Object.freeze([
  Object.freeze({
    name: "conformance.fixture.c28_mutation",
    summary: "Execute the fixed O1-C28 fixture mutation only.",
    namespace: "conformance",
    version: "1.0.0",
    policyClass: "confirm",
    mutationScopePolicy: "session",
    executor: "bridge",
    executorMethod: "send_code_to_revit",
    inputSchema: C28_INPUT,
    inputJsonSchema: schema(C28_INPUT),
  }),
  Object.freeze({
    name: "conformance.fixture.c29_atomic_batch",
    summary: "Execute the fixed O1-C29 fixture atomic review-view batch.",
    namespace: "conformance",
    version: "1.0.0",
    policyClass: "confirm",
    mutationScopePolicy: "document",
    executor: "bridge",
    executorMethod: "execute_batch",
    inputSchema: C29_INPUT,
    inputJsonSchema: schema(C29_INPUT),
  }),
  Object.freeze({
    name: "conformance.fixture.c39_multifile",
    summary: "Create bounded O1-C39 fixture multi-file output only.",
    namespace: "conformance",
    version: "1.0.0",
    policyClass: "auto",
    mutationScopePolicy: "none",
    executor: "bridge",
    executorMethod: "fixture_multi_file_output",
    inputSchema: C39_INPUT,
    inputJsonSchema: schema(C39_INPUT),
  }),
] satisfies readonly GatewayToolRecord[]);

export function productionConformanceCatalog(
  coreRecord: GatewayToolRecord,
): readonly CatalogEntry[] {
  const records = [coreRecord, ...PRODUCTION_CONFORMANCE_TOOL_RECORDS];
  return Object.freeze(records.map((record) => Object.freeze({
    name: record.name,
    summary: record.summary,
    namespace: record.namespace,
    version: record.version,
    tool: record.executorMethod,
    module: "runtime" as const,
    policyClass: record.policyClass,
    mutationScopePolicy: record.mutationScopePolicy,
    executor: record.executor,
    variants: Object.freeze([Object.freeze({
      plane: "live" as const,
      executor: record.executor,
      executorMethod: record.executorMethod,
      schemaOverlay: null,
      fidelityNotes: Object.freeze(["production_conformance fixture only"]),
    })]),
    terms: Object.freeze(record.name.split(".").flatMap((part) => part.split("_"))),
  })).sort((left, right) => left.name.localeCompare(right.name)));
}
