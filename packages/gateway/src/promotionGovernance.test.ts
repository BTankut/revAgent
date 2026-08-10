import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EntitledCatalogView,
  buildCatalog,
  entitleAll,
} from "./entitledRegistry.js";
import {
  GatewayPromotionGovernanceRegistry,
  PromotionGovernanceError,
  type PromotionCandidateEvidenceInput,
} from "./promotionGovernance.js";
import { verifyRegistrySeed } from "./registrySeed.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const promotionRegistry = JSON.parse(
  readFileSync(
    join(REPOSITORY_ROOT, "config/dynamic-tool-promotion-registry.json"),
    "utf8",
  ),
) as unknown;
const promotionRules = JSON.parse(
  readFileSync(
    join(REPOSITORY_ROOT, "config/dynamic-tool-promotion-rules.json"),
    "utf8",
  ),
) as unknown;

const sourceRows = Object.freeze([
  Object.freeze({
    id: "candidate-2026-08-10-repeated-code",
    registryId: "repeated_dynamic_pattern",
    matchedReasons: Object.freeze(["repeated_hash"]),
    sourceEvidence: Object.freeze({
      source: "revagent.usage.summary.v1",
      sourceRef: "summary:2026-08-10:sha256:abc123",
      observedCount: 3,
      codeDigest: `sha256:${"a".repeat(64)}`,
      evidenceRows: Object.freeze([
        Object.freeze({ eventId: "event-1", machineId: "AXL-01" }),
        Object.freeze({ eventId: "event-2", machineId: "AXL-02" }),
      ]),
    }),
    review: Object.freeze({
      state: "watch" as const,
      reviewedBy: "planner@example.test",
      reviewedAt: "2026-08-10T12:00:00.000Z",
      note: "insufficient workflow repetition for native-tool design",
    }),
  }),
  Object.freeze({
    id: "candidate-2026-08-10-manual-transaction",
    registryId: "dynamic_manual_transaction",
    matchedReasons: Object.freeze(["manual_transaction"]),
    sourceEvidence: Object.freeze({
      source: "runtime_event",
      sourceRef: "event-3",
      manualTransactionCount: 1,
    }),
    review: Object.freeze({
      state: "candidate" as const,
      reviewedBy: null,
      reviewedAt: null,
      note: null,
    }),
  }),
] satisfies readonly PromotionCandidateEvidenceInput[]);

describe("GW-20 promotion governance registry", () => {
  it("preserves source evidence and human review state in the admin feed", () => {
    const registry = new GatewayPromotionGovernanceRegistry(
      promotionRegistry,
      promotionRules,
    );
    const feed = registry.ingest(sourceRows);

    expect(feed.registry.entries).toHaveLength(3);
    expect(feed.rules).toEqual({
      schemaVersion: 1,
      repeatThreshold: 2,
      promotionTriggers: [
        "manual_transaction",
        "repeated_hash",
        "write_patterns_present",
      ],
    });
    expect(feed.candidates[1]).toMatchObject({
      id: "candidate-2026-08-10-repeated-code",
      registryId: "repeated_dynamic_pattern",
      state: "watch",
      matchedReasons: ["repeated_hash"],
      candidateAction: "promote_when_workflow_is_production_repeated",
      sourceEvidence: sourceRows[0]!.sourceEvidence,
      review: sourceRows[0]!.review,
      humanReviewRequired: true,
      automaticPromotionAuthorized: false,
      priorityAuthorization: "none",
    });
    expect(feed.feedDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(registry.feedBytes(feed).endsWith("\n")).toBe(true);
  });

  it("is deterministic across candidate input order", () => {
    const registry = new GatewayPromotionGovernanceRegistry(
      promotionRegistry,
      promotionRules,
    );
    const forward = registry.ingest(sourceRows);
    const reverse = registry.ingest([...sourceRows].reverse());

    expect(registry.feedBytes(reverse)).toBe(registry.feedBytes(forward));
    expect(reverse.feedDigest).toBe(forward.feedDigest);
  });

  it("cannot mutate or authorize the entitled callable catalog", () => {
    const seed = verifyRegistrySeed(
      JSON.parse(
        readFileSync(join(PACKAGE_ROOT, "registry-seed.json"), "utf8"),
      ) as unknown,
    );
    const catalogView = new EntitledCatalogView(buildCatalog(seed), entitleAll);
    const beforeBytes = catalogView.capabilityIndexBytes();
    const beforeDigest = catalogView.capabilityIndexDigest();

    const feed = new GatewayPromotionGovernanceRegistry(
      promotionRegistry,
      promotionRules,
    ).ingest(sourceRows);

    expect(feed.automaticPromotionAuthorized).toBe(false);
    expect(feed.priorityAuthorization).toBe("none");
    expect(feed.candidates.every((row) => row.humanReviewRequired)).toBe(true);
    expect(catalogView.capabilityIndexBytes()).toBe(beforeBytes);
    expect(catalogView.capabilityIndexDigest()).toBe(beforeDigest);
    expect(catalogView.entries()).toHaveLength(40);
  });

  it("fails closed on unknown definitions or unruled reasons", () => {
    const registry = new GatewayPromotionGovernanceRegistry(
      promotionRegistry,
      promotionRules,
    );
    expect(() =>
      registry.ingest([
        {
          ...sourceRows[0]!,
          registryId: "not_registered",
        },
      ]),
    ).toThrow(PromotionGovernanceError);
    expect(() =>
      registry.ingest([
        {
          ...sourceRows[0]!,
          matchedReasons: ["write_patterns_present"],
        },
      ]),
    ).toThrow("is not allowed by repeated_dynamic_pattern");
  });

  it("requires human reviewer evidence for any reviewed lifecycle state", () => {
    const registry = new GatewayPromotionGovernanceRegistry(
      promotionRegistry,
      promotionRules,
    );
    expect(() =>
      registry.ingest([
        {
          ...sourceRows[0]!,
          review: {
            state: "promoted",
            reviewedBy: null,
            reviewedAt: null,
            note: null,
          },
        },
      ]),
    ).toThrow("requires reviewer and review time");
  });

  it("rejects non-JSON source evidence instead of normalizing it away", () => {
    const registry = new GatewayPromotionGovernanceRegistry(
      promotionRegistry,
      promotionRules,
    );
    expect(() =>
      registry.ingest([
        {
          ...sourceRows[0]!,
          sourceEvidence: {
            ...sourceRows[0]!.sourceEvidence,
            observedCount: Number.NaN,
          },
        },
      ]),
    ).toThrow("must be a finite JSON number");
  });
});
