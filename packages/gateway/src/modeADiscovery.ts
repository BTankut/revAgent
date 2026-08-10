import type {
  GatewayJsonSchema,
  GatewayRegistryView,
  GatewayToolRecord,
} from "./registry.js";
import { gatewayExternalToolInputJsonSchema } from "./confirmation.js";

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

type RegistryView = Pick<GatewayRegistryView, "records" | "require">;

interface SearchCorpus {
  readonly record: GatewayToolRecord;
  readonly name: string;
  readonly summary: string;
  readonly argumentNames: readonly string[];
  readonly argumentDescriptions: readonly string[];
}

interface ActiveSchema {
  readonly record: GatewayToolRecord;
  readonly bytes: number;
  readonly lastUsed: number;
}

export interface ModeASearchResult {
  readonly name: string;
  readonly summary: string;
  readonly score: number;
}

export interface ModeASchemaResult {
  readonly name: string;
  readonly inputSchema: GatewayJsonSchema;
}

export interface ModeAActivationResult {
  readonly schemas: readonly ModeASchemaResult[];
  readonly activatedNames: readonly string[];
  readonly evictedNames: readonly string[];
  readonly activeSchemaBytes: number;
  readonly callableSetChanged: boolean;
}

export class ModeAToolUnavailableError extends Error {
  public readonly code = "tool_unavailable";

  public constructor() {
    super("Gateway tool is unavailable");
    this.name = "ModeAToolUnavailableError";
  }
}

export class ModeASchemaBudgetError extends Error {
  public readonly code = "schema_budget_exceeded";

  public constructor() {
    super("requested Gateway tool schemas exceed the session budget");
    this.name = "ModeASchemaBudgetError";
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectArguments(
  schema: GatewayJsonSchema,
): {
  readonly names: readonly string[];
  readonly descriptions: readonly string[];
} {
  const names = new Set<string>();
  const descriptions = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (typeof value.description === "string") {
      descriptions.add(normalizeSearchText(value.description));
    }
    if (isRecord(value.properties)) {
      for (const name of Object.keys(value.properties).sort(compareNames)) {
        names.add(normalizeSearchText(name));
        visit(value.properties[name]);
      }
    }
    for (const key of Object.keys(value).sort(compareNames)) {
      if (key !== "properties" && key !== "description") {
        visit(value[key]);
      }
    }
  };
  visit(schema);
  return {
    names: Object.freeze([...names].sort(compareNames)),
    descriptions: Object.freeze([...descriptions].sort(compareNames)),
  };
}

function fieldScore(term: string, value: string, weights: {
  readonly exact: number;
  readonly prefix: number;
  readonly contains: number;
}): number {
  if (value === term) {
    return weights.exact;
  }
  if (value.startsWith(term)) {
    return weights.prefix;
  }
  return value.includes(term) ? weights.contains : 0;
}

function scoreTerm(term: string, corpus: SearchCorpus): number {
  let score = fieldScore(term, corpus.name, {
    exact: 1_000,
    prefix: 700,
    contains: 500,
  });
  score = Math.max(
    score,
    fieldScore(term, corpus.summary, {
      exact: 400,
      prefix: 300,
      contains: 220,
    }),
  );
  for (const name of corpus.argumentNames) {
    score = Math.max(
      score,
      fieldScore(term, name, {
        exact: 600,
        prefix: 450,
        contains: 320,
      }),
    );
  }
  for (const description of corpus.argumentDescriptions) {
    score = Math.max(
      score,
      fieldScore(term, description, {
        exact: 260,
        prefix: 200,
        contains: 140,
      }),
    );
  }
  return score;
}

function schemaBytes(record: GatewayToolRecord): number {
  return Buffer.byteLength(
    JSON.stringify(gatewayExternalToolInputJsonSchema(record)),
    "utf8",
  );
}

export class ModeADiscoverySession {
  readonly #view: RegistryView;
  readonly #corpora: readonly SearchCorpus[];
  readonly #visibleNames: ReadonlySet<string>;
  readonly #pinnedNames: ReadonlySet<string>;
  readonly #schemaBudgetBytes: number;
  #active = new Map<string, ActiveSchema>();
  #clock = 0;

  public constructor(
    view: RegistryView,
    pinnedNames: readonly string[],
    schemaBudgetBytes: number,
  ) {
    if (
      !Number.isSafeInteger(schemaBudgetBytes) ||
      schemaBudgetBytes < 0
    ) {
      throw new RangeError(
        "schemaBudgetBytes must be a non-negative safe integer",
      );
    }
    const records = [...view.records()].sort((left, right) =>
      compareNames(left.name, right.name)
    );
    const visibleNames = new Set(records.map((record) => record.name));
    const corpora = records.map((record) => {
      const args = collectArguments(record.inputJsonSchema);
      return Object.freeze({
        record,
        name: normalizeSearchText(record.name),
        summary: normalizeSearchText(record.summary),
        argumentNames: args.names,
        argumentDescriptions: args.descriptions,
      });
    });

    this.#view = view;
    this.#corpora = Object.freeze(corpora);
    this.#visibleNames = visibleNames;
    this.#pinnedNames = new Set(
      [...new Set(pinnedNames)]
        .filter((name) => visibleNames.has(name))
        .sort(compareNames),
    );
    this.#schemaBudgetBytes = schemaBudgetBytes;
  }

  public search(
    query: string,
    limit = DEFAULT_SEARCH_LIMIT,
  ): readonly ModeASearchResult[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw new RangeError(
        `limit must be an integer from 1 through ${MAX_SEARCH_LIMIT}`,
      );
    }
    const terms = [
      ...new Set(
        normalizeSearchText(query)
          .split(/[\s._-]+/u)
          .filter((term) => term.length > 0),
      ),
    ];
    if (terms.length === 0) {
      return Object.freeze([]);
    }

    return Object.freeze(
      this.#corpora
        .map((corpus) => {
          let score = 0;
          for (const term of terms) {
            const termScore = scoreTerm(term, corpus);
            if (termScore === 0) {
              return undefined;
            }
            score += termScore;
          }
          return Object.freeze({
            name: corpus.record.name,
            summary: corpus.record.summary,
            score,
          });
        })
        .filter((result): result is ModeASearchResult => result !== undefined)
        .sort(
          (left, right) =>
            right.score - left.score || compareNames(left.name, right.name),
        )
        .slice(0, limit),
    );
  }

  public activate(names: readonly string[]): ModeAActivationResult {
    const requestedNames = [...new Set(names)].sort(compareNames);
    const records = requestedNames.map((name) => this.#requireVisible(name));
    const requestedBudgetRecords = records.filter(
      (record) => !this.#pinnedNames.has(record.name),
    );
    const requestedBytes = requestedBudgetRecords.reduce(
      (total, record) => total + schemaBytes(record),
      0,
    );
    if (requestedBytes > this.#schemaBudgetBytes) {
      throw new ModeASchemaBudgetError();
    }

    const beforeNames = this.activeNames();
    const working = new Map(this.#active);
    const requestedBudgetNames = new Set(
      requestedBudgetRecords.map((record) => record.name),
    );
    const nextClock =
      requestedBudgetRecords.length > 0 ? this.#clock + 1 : this.#clock;
    for (const record of requestedBudgetRecords) {
      working.set(record.name, {
        record,
        bytes: schemaBytes(record),
        lastUsed: nextClock,
      });
    }

    let activeBytes = [...working.values()].reduce(
      (total, active) => total + active.bytes,
      0,
    );
    const evictionCandidates = [...working.entries()]
      .filter(([name]) => !requestedBudgetNames.has(name))
      .sort(
        ([leftName, left], [rightName, right]) =>
          left.lastUsed - right.lastUsed ||
          compareNames(leftName, rightName),
      );
    const evictedNames: string[] = [];
    for (const [name, active] of evictionCandidates) {
      if (activeBytes <= this.#schemaBudgetBytes) {
        break;
      }
      working.delete(name);
      activeBytes -= active.bytes;
      evictedNames.push(name);
    }

    this.#active = working;
    this.#clock = nextClock;
    const afterNames = this.activeNames();
    const activatedNames = afterNames.filter(
      (name) => !beforeNames.includes(name),
    );
    return Object.freeze({
      schemas: Object.freeze(
        records.map((record) =>
          Object.freeze({
            name: record.name,
            inputSchema: gatewayExternalToolInputJsonSchema(record),
          })
        ),
      ),
      activatedNames: Object.freeze(activatedNames),
      evictedNames: Object.freeze(evictedNames.sort(compareNames)),
      activeSchemaBytes: activeBytes,
      callableSetChanged:
        activatedNames.length > 0 || evictedNames.length > 0,
    });
  }

  public isCallable(name: string): boolean {
    return (
      this.#visibleNames.has(name) &&
      (this.#pinnedNames.has(name) || this.#active.has(name))
    );
  }

  public requireCallable(name: string): GatewayToolRecord {
    if (!this.isCallable(name)) {
      throw new ModeAToolUnavailableError();
    }
    const record = this.#requireVisible(name);
    const active = this.#active.get(name);
    if (active !== undefined) {
      this.#clock += 1;
      this.#active.set(name, {
        ...active,
        lastUsed: this.#clock,
      });
    }
    return record;
  }

  public activeNames(): readonly string[] {
    return Object.freeze([...this.#active.keys()].sort(compareNames));
  }

  public callableNames(): readonly string[] {
    return Object.freeze(
      [...new Set([...this.#pinnedNames, ...this.#active.keys()])].sort(
        compareNames,
      ),
    );
  }

  public activeSchemaBytes(): number {
    return [...this.#active.values()].reduce(
      (total, active) => total + active.bytes,
      0,
    );
  }

  #requireVisible(name: string): GatewayToolRecord {
    try {
      return this.#view.require(name);
    } catch {
      throw new ModeAToolUnavailableError();
    }
  }
}
