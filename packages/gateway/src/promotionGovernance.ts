import { createHash } from "node:crypto";

export const PROMOTION_GOVERNANCE_FEED_SCHEMA =
  "revagent.promotion-governance-feed/v1" as const;
export const PROMOTION_GOVERNANCE_STATES = Object.freeze([
  "candidate",
  "promoted",
  "watch",
  "rejected",
] as const);

export type PromotionGovernanceState =
  (typeof PROMOTION_GOVERNANCE_STATES)[number];

export interface PromotionRegistryDefinition {
  readonly id: string;
  readonly state: PromotionGovernanceState;
  readonly matchReasons: readonly string[];
  readonly candidateAction: string;
}

export interface PromotionRegistryMetadata {
  readonly schemaVersion: 1;
  readonly defaultCandidateAction: string;
  readonly states: readonly PromotionGovernanceState[];
  readonly entries: readonly PromotionRegistryDefinition[];
}

export interface PromotionRuleMetadata {
  readonly schemaVersion: 1;
  readonly repeatThreshold: number;
  readonly promotionTriggers: readonly string[];
}

export type PromotionEvidenceJson =
  | null
  | boolean
  | number
  | string
  | readonly PromotionEvidenceJson[]
  | { readonly [key: string]: PromotionEvidenceJson };

export interface PromotionCandidateEvidenceInput {
  /** Stable evidence-row identity, not a callable tool identity. */
  readonly id: string;
  /** References one definition from dynamic-tool-promotion-registry.json. */
  readonly registryId: string;
  readonly matchedReasons: readonly string[];
  /** Copied into the feed without source-specific interpretation. */
  readonly sourceEvidence: Readonly<Record<string, PromotionEvidenceJson>>;
  readonly review: {
    readonly state: PromotionGovernanceState;
    readonly reviewedBy: string | null;
    readonly reviewedAt: string | null;
    readonly note: string | null;
  };
}

export interface PromotionGovernanceCandidate {
  readonly id: string;
  readonly registryId: string;
  readonly state: PromotionGovernanceState;
  readonly matchedReasons: readonly string[];
  readonly candidateAction: string;
  readonly sourceEvidence: Readonly<Record<string, PromotionEvidenceJson>>;
  readonly review: PromotionCandidateEvidenceInput["review"];
  readonly humanReviewRequired: true;
  readonly automaticPromotionAuthorized: false;
  readonly priorityAuthorization: "none";
}

export interface PromotionGovernanceFeed {
  readonly schemaVersion: typeof PROMOTION_GOVERNANCE_FEED_SCHEMA;
  readonly registry: PromotionRegistryMetadata;
  readonly rules: PromotionRuleMetadata;
  readonly candidates: readonly PromotionGovernanceCandidate[];
  readonly humanReviewRequired: true;
  readonly automaticPromotionAuthorized: false;
  readonly priorityAuthorization: "none";
  readonly feedDigest: string;
}

export class PromotionGovernanceError extends Error {
  public constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PromotionGovernanceError";
  }
}

function fail(code: string, message: string): never {
  throw new PromotionGovernanceError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("metadata_invalid", `${field} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("metadata_invalid", `${field} must be a non-empty string array`);
  }
  const values = value.map((item, index) =>
    nonEmptyString(item, `${field}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    fail("metadata_duplicate", `${field} contains a duplicate value`);
  }
  return Object.freeze([...values].sort());
}

function state(value: unknown, field: string): PromotionGovernanceState {
  if (
    typeof value !== "string" ||
    !PROMOTION_GOVERNANCE_STATES.includes(
      value as PromotionGovernanceState,
    )
  ) {
    fail("review_state_invalid", `${field} is not a promotion review state`);
  }
  return value as PromotionGovernanceState;
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

function digest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function cloneEvidenceValue(
  value: unknown,
  path: string,
): PromotionEvidenceJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("source_evidence_invalid", `${path} must be a finite JSON number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item, index) =>
        cloneEvidenceValue(item, `${path}[${index}]`),
      ),
    );
  }
  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [
            key,
            cloneEvidenceValue(value[key], `${path}.${key}`),
          ]),
      ),
    );
  }
  fail("source_evidence_invalid", `${path} must contain JSON values only`);
}

function verifyRegistryMetadata(raw: unknown): PromotionRegistryMetadata {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
    fail("registry_metadata_invalid", "promotion registry schemaVersion/entries are invalid");
  }
  const declaredStates = stringArray(raw.states, "registry.states");
  if (
    declaredStates.length !== PROMOTION_GOVERNANCE_STATES.length ||
    PROMOTION_GOVERNANCE_STATES.some(
      (candidate) => !declaredStates.includes(candidate),
    )
  ) {
    fail("registry_states_invalid", "promotion registry must declare the four review states");
  }
  const ids = new Set<string>();
  const entries = raw.entries.map((value, index) => {
    if (!isRecord(value)) {
      fail("registry_entry_invalid", `registry.entries[${index}] must be an object`);
    }
    const id = nonEmptyString(value.id, `registry.entries[${index}].id`);
    if (ids.has(id)) {
      fail("registry_entry_duplicate", `promotion registry repeats ${id}`);
    }
    ids.add(id);
    return Object.freeze({
      id,
      state: state(value.state, `registry.entries[${index}].state`),
      matchReasons: stringArray(
        value.matchReasons,
        `registry.entries[${index}].matchReasons`,
      ),
      candidateAction: nonEmptyString(
        value.candidateAction,
        `registry.entries[${index}].candidateAction`,
      ),
    });
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    defaultCandidateAction: nonEmptyString(
      raw.defaultCandidateAction,
      "registry.defaultCandidateAction",
    ),
    states: PROMOTION_GOVERNANCE_STATES,
    entries: Object.freeze(entries.sort((left, right) => left.id.localeCompare(right.id))),
  });
}

function verifyRuleMetadata(raw: unknown): PromotionRuleMetadata {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    !Number.isSafeInteger(raw.repeatThreshold) ||
    (raw.repeatThreshold as number) < 1
  ) {
    fail("rule_metadata_invalid", "promotion rules schemaVersion/repeatThreshold are invalid");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    repeatThreshold: raw.repeatThreshold as number,
    promotionTriggers: stringArray(
      raw.promotionTriggers,
      "rules.promotionTriggers",
    ),
  });
}

/**
 * GW-20's registry-adjacent governance surface.
 *
 * It deliberately has no catalog or entitlement mutation dependency. The
 * output is evidence for an admin/human review path only; literal false/none
 * authority fields make that boundary machine-readable as well as documented.
 */
export class GatewayPromotionGovernanceRegistry {
  readonly #registry: PromotionRegistryMetadata;
  readonly #rules: PromotionRuleMetadata;
  readonly #definitions: ReadonlyMap<string, PromotionRegistryDefinition>;

  public constructor(registryMetadata: unknown, ruleMetadata: unknown) {
    this.#registry = verifyRegistryMetadata(registryMetadata);
    this.#rules = verifyRuleMetadata(ruleMetadata);
    this.#definitions = new Map(
      this.#registry.entries.map((entry) => [entry.id, entry]),
    );
    const triggers = new Set(this.#rules.promotionTriggers);
    for (const entry of this.#registry.entries) {
      for (const reason of entry.matchReasons) {
        if (!triggers.has(reason)) {
          fail(
            "registry_reason_unruled",
            `${entry.id} uses promotion reason ${reason} absent from the rules`,
          );
        }
      }
    }
  }

  public ingest(
    inputs: readonly PromotionCandidateEvidenceInput[],
  ): PromotionGovernanceFeed {
    const seen = new Set<string>();
    const candidates = inputs.map((input) => {
      const id = nonEmptyString(input.id, "candidate.id");
      if (seen.has(id)) {
        fail("candidate_duplicate", `promotion feed repeats candidate ${id}`);
      }
      seen.add(id);
      const definition = this.#definitions.get(input.registryId);
      if (definition === undefined) {
        fail(
          "candidate_definition_missing",
          `candidate ${id} references unknown registry definition ${input.registryId}`,
        );
      }
      const matchedReasons = stringArray(
        input.matchedReasons,
        `candidate ${id} matchedReasons`,
      );
      for (const reason of matchedReasons) {
        if (!definition.matchReasons.includes(reason)) {
          fail(
            "candidate_reason_invalid",
            `candidate ${id} reason ${reason} is not allowed by ${definition.id}`,
          );
        }
      }
      const evidence = cloneEvidenceValue(
        input.sourceEvidence,
        `candidate ${id}.sourceEvidence`,
      );
      if (!isRecord(evidence)) {
        fail("source_evidence_invalid", `candidate ${id} evidence must be an object`);
      }
      const review = Object.freeze({
        state: state(input.review.state, `candidate ${id}.review.state`),
        reviewedBy:
          input.review.reviewedBy === null
            ? null
            : nonEmptyString(
                input.review.reviewedBy,
                `candidate ${id}.review.reviewedBy`,
              ),
        reviewedAt:
          input.review.reviewedAt === null
            ? null
            : nonEmptyString(
                input.review.reviewedAt,
                `candidate ${id}.review.reviewedAt`,
              ),
        note:
          input.review.note === null
            ? null
            : nonEmptyString(input.review.note, `candidate ${id}.review.note`),
      });
      if (
        review.state !== "candidate" &&
        (review.reviewedBy === null || review.reviewedAt === null)
      ) {
        fail(
          "human_review_evidence_missing",
          `candidate ${id} state ${review.state} requires reviewer and review time`,
        );
      }
      return Object.freeze({
        id,
        registryId: definition.id,
        state: review.state,
        matchedReasons,
        candidateAction: definition.candidateAction,
        sourceEvidence: evidence,
        review,
        humanReviewRequired: true as const,
        automaticPromotionAuthorized: false as const,
        priorityAuthorization: "none" as const,
      });
    });
    candidates.sort((left, right) => left.id.localeCompare(right.id));

    const body = Object.freeze({
      schemaVersion: PROMOTION_GOVERNANCE_FEED_SCHEMA,
      registry: this.#registry,
      rules: this.#rules,
      candidates: Object.freeze(candidates),
      humanReviewRequired: true as const,
      automaticPromotionAuthorized: false as const,
      priorityAuthorization: "none" as const,
    });
    return Object.freeze({
      ...body,
      feedDigest: digest(`${canonicalize(body)}\n`),
    });
  }

  public feedBytes(feed: PromotionGovernanceFeed): string {
    return `${canonicalize(feed)}\n`;
  }
}
