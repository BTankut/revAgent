import { describe, expect, it } from "vitest";

import {
  emptyResourceProfile,
  evaluateResourceSamples,
  resourceProfileIssues,
} from "../src/resourceMetrics.js";

function profile(growthPerSample = 1024) {
  const value = emptyResourceProfile();
  value.samples = Array.from({ length: 8 }, (_, index) => ({
    index,
    offsetMs: index * 250,
    residentBytes: 100_000_000 + index * growthPerSample,
    openFileDescriptorCount: 20,
    journalPendingCount: 0,
  }));
  value.evaluation = evaluateResourceSamples(value, 0);
  return value;
}

describe("measured resource policy", () => {
  it("allows bounded nonzero RSS movement instead of demanding an impossible exact zero delta", () => {
    const value = profile();
    const leaks = {
      openFileDescriptorDelta: value.evaluation!.openFileDescriptorGrowth,
      residentBytesDelta: value.evaluation!.residentGrowthBytes,
      journalPendingDelta: value.evaluation!.journalPendingGrowth,
      orphanProcessCount: 0,
    };
    expect(leaks.residentBytesDelta).toBeGreaterThan(0);
    expect(resourceProfileIssues(value, leaks)).toEqual([]);
  });

  it("rejects sustained RSS slope above the canonical bound", () => {
    const value = profile(2 * 1024 * 1024);
    const leaks = {
      openFileDescriptorDelta: value.evaluation!.openFileDescriptorGrowth,
      residentBytesDelta: value.evaluation!.residentGrowthBytes,
      journalPendingDelta: value.evaluation!.journalPendingGrowth,
      orphanProcessCount: 0,
    };
    expect(resourceProfileIssues(value, leaks).map(({ code }) => code)).toContain("run.resource_leak");
  });
});
