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

    value.samples = value.samples.map((sample) => ({
      ...sample,
      openFileDescriptorCount: sample.index % 2 === 0 ? 1_425 : 1_427,
    }));
    const singleSeries = evaluateResourceSamples(value, 0);
    expect(singleSeries).toMatchObject({
      openFileDescriptorGrowth: 2,
      passed: false,
    });
    const phaseStable = evaluateResourceSamples(
      value,
      0,
      { openFileDescriptorPhaseCount: 2 },
    );
    expect(phaseStable).toMatchObject({
      openFileDescriptorGrowth: 0,
      passed: true,
    });

    value.samples[4]!.openFileDescriptorCount += 1;
    const samePhaseLeak = evaluateResourceSamples(
      value,
      0,
      { openFileDescriptorPhaseCount: 2 },
    );
    expect(samePhaseLeak).toMatchObject({
      openFileDescriptorGrowth: 1,
      passed: false,
    });
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
