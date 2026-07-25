import { z, type ZodRawShape } from "zod";

export const GATEWAY_EXECUTOR_BINDINGS = [
  "bridge",
  "internal_mcp",
  "aps",
] as const;

export type GatewayExecutorBinding =
  (typeof GATEWAY_EXECUTOR_BINDINGS)[number];

export type GatewayPolicyClass = "auto" | "confirm" | "gated";

export interface GatewayToolRecord {
  readonly name: string;
  readonly summary: string;
  readonly namespace: string;
  readonly version: string;
  readonly policyClass: GatewayPolicyClass;
  readonly executor: GatewayExecutorBinding;
  readonly executorMethod: string;
  readonly inputSchema: ZodRawShape;
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
}

export class GatewayToolRegistry {
  readonly #records: readonly GatewayToolRecord[];
  readonly #recordsByName: ReadonlyMap<string, GatewayToolRecord>;
  readonly #capabilityIndex: CapabilityIndex;
  readonly #capabilityIndexBytes: string;

  public constructor(records: readonly GatewayToolRecord[]) {
    for (const record of records) {
      validateRecord(record);
    }
    const sorted = records
      .map((record) =>
        Object.freeze({
          ...record,
          inputSchema: Object.freeze({ ...record.inputSchema }),
        })
      )
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
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
    this.#capabilityIndex = Object.freeze({
      schemaVersion: "revagent-capability-index/v1",
      tools: Object.freeze(
        sorted.map((record) =>
          Object.freeze({
            name: record.name,
            summary: record.summary,
            namespace: record.namespace,
            version: record.version,
            policyClass: record.policyClass,
            executor: record.executor,
            schema: "deferred" as const,
          })
        ),
      ),
    });
    this.#capabilityIndexBytes = `${JSON.stringify(this.#capabilityIndex)}\n`;
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

  public capabilityIndex(): CapabilityIndex {
    return this.#capabilityIndex;
  }

  public capabilityIndexBytes(): string {
    return this.#capabilityIndexBytes;
  }
}

export const M2_BOOTSTRAP_TOOL_RECORDS = Object.freeze([
  Object.freeze({
    name: "core.ui.state",
    summary: "Read the current Revit user-interface state.",
    namespace: "core",
    version: "1.0.0",
    policyClass: "auto",
    executor: "bridge",
    executorMethod: "get_ui_state",
    inputSchema: Object.freeze({}),
  }),
] satisfies readonly GatewayToolRecord[]);
