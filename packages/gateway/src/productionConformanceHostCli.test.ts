import { describe, expect, it } from "vitest";

import {
  coherentDocumentContextAudit,
  MAX_DOCUMENT_CONTEXT_OBSERVATIONS,
  MAX_DOCUMENT_CONTEXT_OBSERVATION_BYTES,
  type DocumentContextObservationSnapshot,
} from "./productionConformanceHostCli.js";

const epoch = "123e4567-e89b-42d3-a456-426614174000";
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const contextDigest = "c".repeat(64);
const route = (overrides: Record<string, unknown> = {}) => Object.freeze({
  rsidHash: digest("a"), observedSequence: 7, contextDigest,
  routeDigest: digest("b"), recordDigest: digest("d"),
  sessionBindingDigest: digest("e"), connectionDigest: digest("f"),
  sessionRecordVersion: 9, ...overrides,
});
const observation = Object.freeze({ stage: "accepted" as const, sequence: 7, contextDigest,
  ordinal: 2, observedAtUtc: "2026-08-24T00:00:00.000Z" });
const snapshot = (rows = [observation], highWaterOrdinal = 2, processEpoch = epoch): DocumentContextObservationSnapshot =>
  Object.freeze({ processEpoch, highWaterOrdinal, rows: Object.freeze(rows) });

describe("WP-12 coherent document-context host audit", () => {
  it("emits exactly one digest-only join without changing authority", () => {
    let reads = 0;
    const result = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => { reads += 1; return route(); } },
      processEpoch: epoch, snapshotObservations: () => snapshot(),
    });
    expect(reads).toBe(2);
    expect(result.currentRoute).toMatchObject({ contextDigest, routeDigest: digest("b"), recordDigest: digest("d"), sessionBindingDigest: digest("e"), connectionDigest: digest("f") });
    expect(result.updates).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("document-live");
    expect(MAX_DOCUMENT_CONTEXT_OBSERVATIONS).toBe(32);
    expect(MAX_DOCUMENT_CONTEXT_OBSERVATION_BYTES).toBe(2048);
  });

  it("fails closed for append A/route/B, post-B route churn, restart, and eviction", () => {
    let snapshotCall = 0;
    const append = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([observation], ++snapshotCall),
    });
    expect(append.updates).toEqual([]);
    let routeRead = 0;
    const afterB = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => (++routeRead % 2 === 1 ? route() : route({ recordDigest: digest("1") })) },
      processEpoch: epoch, snapshotObservations: () => snapshot(),
    });
    expect(afterB.updates).toEqual([]);
    const restarted = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([observation], 2, "223e4567-e89b-42d3-a456-426614174000"),
    });
    expect(restarted.updates).toEqual([]);
    const evicted = coherentDocumentContextAudit({
      authority: { readCurrentDocumentRouteAuditSnapshot: () => route() }, processEpoch: epoch,
      snapshotObservations: () => snapshot([], 32),
    });
    expect(evicted.updates).toEqual([]);
  });

  it.each(["recordDigest", "sessionBindingDigest", "connectionDigest"])(
    "fails closed when final %s churns",
    (field) => {
      let read = 0;
      const result = coherentDocumentContextAudit({
        authority: { readCurrentDocumentRouteAuditSnapshot: () => (++read % 2 === 1 ? route() : route({ [field]: digest("9") })) },
        processEpoch: epoch, snapshotObservations: () => snapshot(),
      });
      expect(result.updates).toEqual([]);
    },
  );
});
