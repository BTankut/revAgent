import { createHash } from "node:crypto";
import type { CapabilityIndex, CapabilityIndexTool } from "./registry.js";
import type { RegistrySeed } from "./registrySeed.js";
import {
  E5_TOOL_BINDINGS,
  mutationScopePolicyForTool,
  type ToolBindingRow,
} from "./toolBindings.js";

/**
 * The entitled registry view, capability index and search corpus (GW-3).
 *
 * Built from the collected registry seed joined to the E5 binding table, not
 * from `GatewayToolRecord`: those carry an executable zod shape that the
 * registry validates against its JSON Schema, and the seed deliberately ships
 * JSON Schema only — the collector serializes zod at build time precisely so
 * the Gateway never imports a legacy module. Deferred schema delivery and
 * dispatch validation need the executable shape; an index and a search corpus
 * do not, so this layer is built from what the seed actually contains rather
 * than from a fabricated zod shape that would typecheck and be wrong.
 */

/** One tool as the index and the corpus see it, before entitlement filtering. */
export interface CatalogEntry {
  readonly name: string;
  readonly summary: string;
  readonly namespace: string;
  readonly version: string;
  readonly tool: string;
  readonly module: "runtime" | "docs";
  readonly policyClass: ToolBindingRow["policyClass"];
  readonly mutationScopePolicy: ReturnType<typeof mutationScopePolicyForTool>;
  readonly executor: ToolBindingRow["executor"];
  /** Lower-cased search terms, deduplicated and sorted. */
  readonly terms: readonly string[];
}

const CATALOG_VERSION = "1.0.0";

/**
 * Bracket tags are stripped from anything the client sees.
 *
 * The legacy descriptions carry hand-rolled prefixes like
 * `[PRODUCTION_PARAMETER_WRITE]` that encode a proto policy class in prose. The
 * registry now carries that as a structured field, so republishing the tag
 * would state the same fact twice and let the two disagree.
 */
function stripTags(description: string): string {
  return description
    .replace(/\[[A-Z0-9_]+\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * A bounded one-liner derived from the legacy description.
 *
 * E5 records that the shipped descriptions run to hundreds of characters and
 * that authored one-liners are owed. This takes the first sentence, capped, as
 * an explicit interim: it keeps the index byte-stable and bounded today without
 * pretending the authoring work is done.
 */
function summarize(description: string): string {
  const stripped = stripTags(description);
  const firstSentence = /^(.*?[.!?])(\s|$)/u.exec(stripped)?.[1] ?? stripped;
  const bounded =
    firstSentence.length > 160
      ? `${firstSentence.slice(0, 157)}...`
      : firstSentence;
  return bounded.length === 0 ? "No description available." : bounded;
}

function termsFor(entry: {
  readonly name: string;
  readonly tool: string;
  readonly summary: string;
  readonly schema: Readonly<Record<string, unknown>>;
}): readonly string[] {
  const terms = new Set<string>();
  const add = (value: string): void => {
    for (const piece of value.toLowerCase().split(/[^a-z0-9]+/u)) {
      if (piece.length >= 2) {
        terms.add(piece);
      }
    }
  };
  add(entry.name);
  add(entry.tool);
  add(entry.summary);
  const properties = entry.schema.properties;
  if (properties !== null && typeof properties === "object") {
    for (const argument of Object.keys(properties)) {
      add(argument);
    }
  }
  // Sorted so the corpus is a pure function of its inputs rather than of
  // insertion order.
  return Object.freeze([...terms].sort());
}

export class CatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

/**
 * Joins the verified seed to the E5 binding table.
 *
 * Fails closed on any tool present in one and absent from the other: a seeded
 * tool with no binding would have no policy class, and a bound tool with no
 * seed entry would be published without a schema behind it.
 */
export function buildCatalog(
  seed: RegistrySeed,
  bindings: readonly ToolBindingRow[] = E5_TOOL_BINDINGS,
): readonly CatalogEntry[] {
  const byTool = new Map(bindings.map((row) => [row.tool, row]));
  const entries: CatalogEntry[] = [];

  for (const tool of seed.tools) {
    const binding = byTool.get(tool.name);
    if (binding === undefined) {
      throw new CatalogError(
        "tool_unbound",
        `${tool.name} is in the registry seed but has no E5 binding`,
      );
    }
    byTool.delete(tool.name);
    const summary = summarize(tool.description);
    entries.push(
      Object.freeze({
        name: binding.target,
        summary,
        namespace: binding.target.split(".")[0] ?? "core",
        version: CATALOG_VERSION,
        tool: tool.name,
        module: binding.module,
        policyClass: binding.policyClass,
        mutationScopePolicy: mutationScopePolicyForTool(binding.tool),
        executor: binding.executor,
        terms: termsFor({
          name: binding.target,
          tool: tool.name,
          summary,
          schema: tool.inputJsonSchema,
        }),
      }),
    );
  }

  if (byTool.size > 0) {
    throw new CatalogError(
      "binding_unseeded",
      `bound but absent from the registry seed: ${[...byTool.keys()].sort().join(", ")}`,
    );
  }

  // Sorted by published name so every downstream artifact is order-independent.
  return Object.freeze(
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
  );
}

export interface EntitlementDecision {
  /** Returns true when this principal may see the tool at all. */
  (entry: CatalogEntry): boolean;
}

/**
 * An entitlement-filtered view.
 *
 * Filtering happens once, here, and every downstream surface reads from this
 * object. The alternative — filtering separately in the index, in search and in
 * schema delivery — is how a tool ends up hidden from the index and still
 * reachable by name.
 */
export class EntitledCatalogView {
  readonly #entries: readonly CatalogEntry[];
  readonly #byName: ReadonlyMap<string, CatalogEntry>;

  public constructor(
    entries: readonly CatalogEntry[],
    isEntitled: EntitlementDecision,
  ) {
    // Sorted here, not merely assumed sorted by the caller. Byte stability is
    // this object's guarantee, and a guarantee that depends on an unstated
    // precondition holds until the first caller who does not know about it.
    const visible = entries
      .filter((entry) => isEntitled(entry))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
    this.#entries = Object.freeze(visible);
    this.#byName = new Map(visible.map((entry) => [entry.name, entry]));
  }

  public entries(): readonly CatalogEntry[] {
    return this.#entries;
  }

  /** Undefined for an unentitled tool, exactly as for one that does not exist. */
  public get(name: string): CatalogEntry | undefined {
    return this.#byName.get(name);
  }

  public capabilityIndex(): CapabilityIndex {
    const tools: CapabilityIndexTool[] = this.#entries.map((entry) =>
      Object.freeze({
        name: entry.name,
        summary: entry.summary,
        namespace: entry.namespace,
        version: entry.version,
        policyClass: entry.policyClass,
        executor: entry.executor,
        schema: "deferred" as const,
      }),
    );
    return Object.freeze({
      schemaVersion: "revagent-capability-index/v1" as const,
      tools: Object.freeze(tools),
    });
  }

  /**
   * Canonical bytes: keys sorted at every level, one trailing newline.
   *
   * Byte stability is the property later work depends on for caching and for
   * proving two tenants with the same entitlements receive the identical index,
   * so it is produced by a canonical serializer rather than by `JSON.stringify`
   * over an object whose key order happens to be stable today.
   */
  public capabilityIndexBytes(): string {
    return `${canonicalize(this.capabilityIndex())}\n`;
  }

  public capabilityIndexDigest(): string {
    return `sha256:${createHash("sha256").update(this.capabilityIndexBytes(), "utf8").digest("hex")}`;
  }

  /**
   * Deterministic search over the entitled set only.
   *
   * Ties break on name so equal scores cannot reorder between runs, and an
   * unentitled tool is not merely ranked last -- it is absent from the corpus,
   * so no score can surface it.
   */
  public search(query: string, limit = 10): readonly CatalogEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((term) => term.length >= 2);
    if (terms.length === 0) {
      return Object.freeze([]);
    }
    const scored = this.#entries
      .map((entry) => {
        let score = 0;
        for (const term of terms) {
          if (entry.terms.includes(term)) {
            score += 2;
          } else if (
            entry.terms.some((candidate) => candidate.startsWith(term))
          ) {
            score += 1;
          }
        }
        return { entry, score };
      })
      .filter((candidate) => candidate.score > 0);

    scored.sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.entry.name < right.entry.name
          ? -1
          : 1,
    );
    return Object.freeze(
      scored.slice(0, limit).map((candidate) => candidate.entry),
    );
  }
}

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

/** Entitles everything. Named so a test reads as deliberately unfiltered. */
export const entitleAll: EntitlementDecision = () => true;

/** Entitles an explicit set of published tool names. */
export function entitleOnly(names: readonly string[]): EntitlementDecision {
  const allowed = new Set(names);
  return (entry) => allowed.has(entry.name);
}
