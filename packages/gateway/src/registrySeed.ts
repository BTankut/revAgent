import { createHash } from "node:crypto";

/**
 * The build-only collector's output contract (GW-1 / P-GW-4).
 *
 * The Gateway consumes this JSON and nothing else from the legacy MCP trees: it
 * never imports a legacy module, a stdio entry point, or the zod major those
 * surfaces are authored against. That boundary is what makes "no frozen-source
 * relocation" hold at runtime rather than only by convention.
 */
export interface RegistrySeedTool {
  readonly name: string;
  readonly module: "runtime" | "docs";
  readonly description: string;
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
  /** Built module that registers this tool, relative to its tools directory. */
  readonly handlerModule: string;
  /** SHA-256 of that built module, re-verified before the tool is loadable. */
  readonly handlerDigest: string;
}

export interface RegistrySeed {
  readonly seedVersion: 1;
  readonly tools: readonly RegistrySeedTool[];
  readonly seedDigest: string;
}

export class RegistrySeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RegistrySeedError";
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/u;
const EXPECTED_COUNTS: Readonly<Record<RegistrySeedTool["module"], number>> = {
  runtime: 36,
  docs: 5,
};

/**
 * RFC 8785-shaped canonical JSON. The collector hashes the same shape, so a
 * seed produced on any machine re-verifies here byte for byte.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function fail(code: string, message: string): never {
  throw new RegistrySeedError(code, message);
}

/**
 * Fail-closed verification of a collected registry seed.
 *
 * A Gateway that loaded an unverified seed would be trusting whatever the build
 * happened to produce, which is exactly what GW-1's startup gate exists to
 * prevent: a changed handler, a dropped tool, or an edited schema must stop the
 * process rather than silently change the callable surface.
 */
export function verifyRegistrySeed(candidate: unknown): RegistrySeed {
  if (candidate === null || typeof candidate !== "object") {
    fail("seed_not_object", "The registry seed must be a JSON object.");
  }
  const seed = candidate as Record<string, unknown>;

  if (seed.seedVersion !== 1) {
    fail(
      "seed_version_unsupported",
      `The registry seed version must be 1; received ${String(seed.seedVersion)}.`,
    );
  }
  if (typeof seed.seedDigest !== "string" || !SHA256_PATTERN.test(seed.seedDigest)) {
    fail("seed_digest_malformed", "The registry seed digest must be a sha256: digest.");
  }
  if (!Array.isArray(seed.tools)) {
    fail("seed_tools_missing", "The registry seed must carry a tools array.");
  }

  const counts: Record<string, number> = { runtime: 0, docs: 0 };
  const names = new Set<string>();
  const digests = new Set<string>();
  let previousName = "";

  for (const entry of seed.tools) {
    if (entry === null || typeof entry !== "object") {
      fail("tool_not_object", "Every registry seed tool must be an object.");
    }
    const tool = entry as Record<string, unknown>;
    const name = tool.name;

    if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
      fail("tool_name_invalid", `Invalid registry seed tool name: ${String(name)}.`);
    }
    // Sorted order is part of the hashed shape; accepting an unsorted seed
    // would let two different byte sequences claim the same digest lineage.
    if (name <= previousName) {
      fail("tool_order_invalid", `Registry seed tools must be name-sorted; ${name} is out of order.`);
    }
    previousName = name;

    // `Set.add` returns the set, not a boolean, so membership is tested with
    // `has` before inserting. Testing the return value of `add` compiles and
    // reads as a duplicate check while never firing.
    if (names.has(name)) {
      fail("tool_duplicate", `Registry seed repeats tool ${name}.`);
    }
    names.add(name);
    if (tool.module !== "runtime" && tool.module !== "docs") {
      fail("tool_module_invalid", `Tool ${name} has an unknown module ${String(tool.module)}.`);
    }
    if (typeof tool.description !== "string") {
      fail("tool_description_invalid", `Tool ${name} is missing its description.`);
    }
    if (tool.inputJsonSchema === null || typeof tool.inputJsonSchema !== "object") {
      fail("tool_schema_invalid", `Tool ${name} is missing its JSON Schema.`);
    }
    if (typeof tool.handlerModule !== "string" || tool.handlerModule !== `${name}.js`) {
      fail(
        "tool_handler_module_invalid",
        `Tool ${name} must bind handler module ${name}.js.`,
      );
    }
    if (typeof tool.handlerDigest !== "string" || !SHA256_PATTERN.test(tool.handlerDigest)) {
      fail("tool_handler_digest_invalid", `Tool ${name} has a malformed handler digest.`);
    }
    // One digest per tool. The first collector build hashed the telemetry
    // wrapper every tool shares, which produced six digests for forty tools and
    // made this gate vacuous; a repeat here means that regression is back.
    if (digests.has(tool.handlerDigest)) {
      fail(
        "tool_handler_digest_shared",
        `Tool ${name} shares a handler digest with another tool; handler identity is not distinguishing.`,
      );
    }
    digests.add(tool.handlerDigest);
    counts[tool.module] += 1;
  }

  for (const [moduleName, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (counts[moduleName] !== expected) {
      fail(
        "tool_count_unexpected",
        `Expected ${expected} ${moduleName} tools; the seed carries ${counts[moduleName]}.`,
      );
    }
  }

  const body = { seedVersion: seed.seedVersion, tools: seed.tools };
  const recomputed = `sha256:${createHash("sha256")
    .update(canonicalize(body), "utf8")
    .digest("hex")}`;
  if (recomputed !== seed.seedDigest) {
    fail(
      "seed_digest_mismatch",
      "The registry seed digest does not match its content; the seed was edited after collection.",
    );
  }

  return seed as unknown as RegistrySeed;
}
