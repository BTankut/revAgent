import { z, type ZodRawShape } from "zod";

export const GATEWAY_EXECUTOR_BINDINGS = [
  "bridge",
  "internal_mcp",
  "aps",
] as const;

export type GatewayExecutorBinding = (typeof GATEWAY_EXECUTOR_BINDINGS)[number];

export type GatewayPolicyClass = "auto" | "confirm" | "gated";

/**
 * Server-authored recovery scope for one registry tool.
 *
 * This is deliberately independent from policy class: O1 has auto tools that
 * mutate document/view state, while confirm is an approval decision rather
 * than an effect classifier.
 */
export type GatewayMutationScopePolicy = "none" | "document" | "session";

export type GatewayJsonSchema = Readonly<Record<string, unknown>>;

const JSON_SCHEMA_2020_12_URI = "https://json-schema.org/draft/2020-12/schema";

export interface GatewayToolRecord {
  readonly name: string;
  readonly summary: string;
  readonly namespace: string;
  readonly version: string;
  readonly policyClass: GatewayPolicyClass;
  readonly mutationScopePolicy: GatewayMutationScopePolicy;
  readonly executor: GatewayExecutorBinding;
  readonly executorMethod: string;
  readonly inputSchema: ZodRawShape;
  /**
   * Serializable schema emitted by the build-only registry collector.
   * The registry validates it against the declared MCP SDK converter so
   * deferred tool_schema output cannot diverge from tools/list or dispatch.
   */
  readonly inputJsonSchema: GatewayJsonSchema;
}

export interface CapabilityIndexTool {
  readonly name: string;
  readonly summary: string;
  readonly namespace: string;
  readonly version: string;
  readonly policyClass: GatewayPolicyClass;
  readonly executor: GatewayExecutorBinding;
  readonly schema: "deferred";
}

export interface CapabilityIndex {
  readonly schemaVersion: "revagent-capability-index/v1";
  readonly tools: readonly CapabilityIndexTool[];
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const EXECUTOR_BINDINGS = new Set<string>(GATEWAY_EXECUTOR_BINDINGS);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must contain only JSON values`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain circular JSON values`);
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item, index) =>
        cloneJsonValue(item, `${path}[${index}]`, nextAncestors),
      ),
    );
  }
  if (!isPlainRecord(value)) {
    throw new TypeError(`${path} must contain only plain JSON objects`);
  }
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    clone[key] = cloneJsonValue(value[key], `${path}.${key}`, nextAncestors);
  }
  return Object.freeze(clone);
}

function normalizeInputJsonSchema(
  record: GatewayToolRecord,
): GatewayJsonSchema {
  if (!isPlainRecord(record.inputJsonSchema)) {
    throw new TypeError(
      `${record.name}.inputJsonSchema must be a plain JSON object`,
    );
  }
  const normalized = cloneJsonValue(
    record.inputJsonSchema,
    `${record.name}.inputJsonSchema`,
    new Set(),
  ) as GatewayJsonSchema;
  if (normalized.type !== "object") {
    throw new TypeError(`${record.name}.inputJsonSchema.type must be object`);
  }
  if (normalized.additionalProperties !== false) {
    throw new TypeError(
      `${record.name}.inputJsonSchema.additionalProperties must be false`,
    );
  }
  if (!isPlainRecord(normalized.properties)) {
    throw new TypeError(
      `${record.name}.inputJsonSchema.properties must be a plain object`,
    );
  }
  if (normalized.$schema !== JSON_SCHEMA_2020_12_URI) {
    throw new TypeError(
      `${record.name}.inputJsonSchema.$schema must select JSON Schema 2020-12`,
    );
  }
  const zodFields = Object.keys(record.inputSchema).sort();
  const jsonFields = Object.keys(normalized.properties).sort();
  if (
    zodFields.length !== jsonFields.length ||
    zodFields.some((field, index) => field !== jsonFields[index])
  ) {
    throw new TypeError(
      `${record.name}.inputJsonSchema properties must match inputSchema fields`,
    );
  }
  return normalized;
}

function canonicalInputJsonSchema(
  record: GatewayToolRecord,
): GatewayJsonSchema {
  const generated = z.toJSONSchema(z.object(record.inputSchema).strict(), {
    io: "input",
  });
  return cloneJsonValue(
    generated,
    `${record.name}.canonicalInputJsonSchema`,
    new Set(),
  ) as GatewayJsonSchema;
}

function assertCanonicalInputJsonSchema(record: GatewayToolRecord): void {
  const supplied = normalizeInputJsonSchema(record);
  const canonical = canonicalInputJsonSchema(record);
  if (JSON.stringify(supplied) !== JSON.stringify(canonical)) {
    throw new TypeError(
      `${record.name}.inputJsonSchema must match the canonical executable schema`,
    );
  }
}

function boundedSingleLine(
  value: string,
  label: string,
  maximumLength: number,
): void {
  if (
    value.length < 1 ||
    value.length > maximumLength ||
    /[\r\n]/u.test(value)
  ) {
    throw new TypeError(
      `${label} must be a non-empty single-line string no longer than ${maximumLength} characters`,
    );
  }
}

function validateRecord(record: GatewayToolRecord): void {
  if (!TOOL_NAME_PATTERN.test(record.name)) {
    throw new TypeError(`invalid Gateway tool name: ${record.name}`);
  }
  boundedSingleLine(record.summary, `${record.name}.summary`, 240);
  boundedSingleLine(record.namespace, `${record.name}.namespace`, 80);
  boundedSingleLine(
    record.executorMethod,
    `${record.name}.executorMethod`,
    160,
  );
  if (record.namespace !== record.name.split(".", 1)[0]) {
    throw new TypeError(
      `${record.name}.namespace must match the first tool-name segment`,
    );
  }
  if (!VERSION_PATTERN.test(record.version)) {
    throw new TypeError(`${record.name}.version must use major.minor.patch`);
  }
  if (!EXECUTOR_BINDINGS.has(record.executor)) {
    throw new TypeError(
      `${record.name}.executor is not a supported Gateway binding`,
    );
  }
  if (
    record.policyClass !== "auto" &&
    record.policyClass !== "confirm" &&
    record.policyClass !== "gated"
  ) {
    throw new TypeError(`${record.name}.policyClass is not supported`);
  }
  if (
    record.mutationScopePolicy !== "none" &&
    record.mutationScopePolicy !== "document" &&
    record.mutationScopePolicy !== "session"
  ) {
    throw new TypeError(`${record.name}.mutationScopePolicy is not supported`);
  }
  if (!isPlainRecord(record.inputSchema)) {
    throw new TypeError(`${record.name}.inputSchema must be a Zod raw shape`);
  }
  for (const [fieldName, fieldSchema] of Object.entries(record.inputSchema)) {
    if (!(fieldSchema instanceof z.ZodType)) {
      throw new TypeError(
        `${record.name}.inputSchema.${fieldName} must be a Zod schema`,
      );
    }
  }
  z.object(record.inputSchema).strict();
  assertCanonicalInputJsonSchema(record);
}

function capabilityIndexFor(
  records: readonly GatewayToolRecord[],
): CapabilityIndex {
  return Object.freeze({
    schemaVersion: "revagent-capability-index/v1",
    tools: Object.freeze(
      records.map((record) =>
        Object.freeze({
          name: record.name,
          summary: record.summary,
          namespace: record.namespace,
          version: record.version,
          policyClass: record.policyClass,
          executor: record.executor,
          schema: "deferred" as const,
        }),
      ),
    ),
  });
}

export class GatewayRegistryView {
  readonly #registry: GatewayToolRegistry;
  readonly #records: readonly GatewayToolRecord[];
  readonly #recordsByName: ReadonlyMap<string, GatewayToolRecord>;
  readonly #capabilityIndex: CapabilityIndex;
  readonly #capabilityIndexBytes: string;

  public constructor(
    registry: GatewayToolRegistry,
    records: readonly GatewayToolRecord[],
  ) {
    const sorted = [...records].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const [index, record] of sorted.entries()) {
      if (registry.get(record.name) !== record) {
        throw new TypeError(
          "Gateway registry view records must originate from its registry",
        );
      }
      if (index > 0 && sorted[index - 1]?.name === record.name) {
        throw new TypeError("Gateway registry view contains a duplicate tool");
      }
    }
    this.#registry = registry;
    this.#records = Object.freeze(sorted);
    this.#recordsByName = new Map(
      sorted.map((record) => [record.name, record]),
    );
    this.#capabilityIndex = capabilityIndexFor(this.#records);
    this.#capabilityIndexBytes = `${JSON.stringify(this.#capabilityIndex)}\n`;
  }

  public registry(): GatewayToolRegistry {
    return this.#registry;
  }

  public records(): readonly GatewayToolRecord[] {
    return this.#records;
  }

  public get(name: string): GatewayToolRecord | undefined {
    return this.#recordsByName.get(name);
  }

  public require(name: string): GatewayToolRecord {
    const record = this.get(name);
    if (record === undefined) {
      throw new RangeError("unknown or unentitled Gateway tool");
    }
    return record;
  }

  public capabilityIndex(): CapabilityIndex {
    return this.#capabilityIndex;
  }

  public capabilityIndexBytes(): string {
    return this.#capabilityIndexBytes;
  }
}

export class GatewayToolRegistry {
  readonly #records: readonly GatewayToolRecord[];
  readonly #recordsByName: ReadonlyMap<string, GatewayToolRecord>;
  readonly #fullView: GatewayRegistryView;

  public constructor(records: readonly GatewayToolRecord[]) {
    for (const record of records) {
      validateRecord(record);
    }
    const sorted = records
      .map((record) =>
        Object.freeze({
          ...record,
          inputSchema: Object.freeze({ ...record.inputSchema }),
          inputJsonSchema: normalizeInputJsonSchema(record),
        }),
      )
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    const byName = new Map<string, GatewayToolRecord>();

    for (const record of sorted) {
      if (byName.has(record.name)) {
        throw new TypeError(`duplicate Gateway tool name: ${record.name}`);
      }
      byName.set(record.name, record);
    }

    this.#records = Object.freeze(sorted);
    this.#recordsByName = byName;
    this.#fullView = new GatewayRegistryView(this, this.#records);
  }

  public records(): readonly GatewayToolRecord[] {
    return this.#records;
  }

  public get(name: string): GatewayToolRecord | undefined {
    return this.#recordsByName.get(name);
  }

  public require(name: string): GatewayToolRecord {
    const record = this.get(name);
    if (record === undefined) {
      throw new RangeError(`unknown Gateway tool: ${name}`);
    }
    return record;
  }

  public view(visibleToolNames: readonly string[]): GatewayRegistryView {
    const names = new Set(visibleToolNames);
    const visibleRecords: GatewayToolRecord[] = [];
    for (const name of names) {
      const record = this.get(name);
      if (record === undefined) {
        throw new RangeError(`unknown Gateway tool in registry view: ${name}`);
      }
      visibleRecords.push(record);
    }
    visibleRecords.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    return new GatewayRegistryView(this, visibleRecords);
  }

  public fullView(): GatewayRegistryView {
    return this.#fullView;
  }

  public capabilityIndex(): CapabilityIndex {
    return this.#fullView.capabilityIndex();
  }

  public capabilityIndexBytes(): string {
    return this.#fullView.capabilityIndexBytes();
  }
}

export const M2_BOOTSTRAP_TOOL_RECORDS = Object.freeze([
  Object.freeze({
    name: "core.ui.state",
    summary: "Read the current Revit user-interface state.",
    namespace: "core",
    version: "1.0.0",
    policyClass: "auto",
    mutationScopePolicy: "none",
    executor: "bridge",
    executorMethod: "get_ui_state",
    inputSchema: Object.freeze({}),
    inputJsonSchema: Object.freeze({
      $schema: JSON_SCHEMA_2020_12_URI,
      additionalProperties: false,
      properties: Object.freeze({}),
      type: "object",
    }),
  }),
] satisfies readonly GatewayToolRecord[]);
