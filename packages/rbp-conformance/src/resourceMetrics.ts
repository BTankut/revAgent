import { COMPONENT_IDS } from "./types.js";
import { stableJson } from "./stableJson.js";
import type {
  LeakCounters,
  ResourceEvaluation,
  ResourcePolicy,
  ResourceProfile,
  ResourceSample,
  ValidationIssue,
} from "./types.js";

export const CANONICAL_RESOURCE_POLICY: ResourcePolicy = {
  warmupSamples: 2,
  minimumMeasuredSamples: 6,
  maxResidentGrowthBytes: 67108864,
  maxResidentSlopeBytesPerSecond: 2097152,
  maxOpenFileDescriptorGrowth: 0,
  maxJournalPendingGrowth: 0,
  maxOrphanProcessCount: 0,
};

export interface ResourceEvaluationOptions {
  openFileDescriptorPhaseCount?: 2;
}

export function emptyResourceProfile(): ResourceProfile {
  return {
    schemaVersion: "rbp-resource-profile/v1",
    samplingMode: "bounded_slope",
    sampleIntervalMs: 250,
    policy: { ...CANONICAL_RESOURCE_POLICY },
    gcConfirmedComponents: [],
    samples: [],
    evaluation: null,
  };
}

function measuredSamples(profile: ResourceProfile): ResourceSample[] {
  return profile.samples.slice(profile.policy.warmupSamples);
}

function growth(values: readonly number[]): number {
  if (values.length < 2) return 0;
  return values.at(-1)! - values[0]!;
}

function peakGrowth(values: readonly number[]): number {
  if (values.length < 2) return 0;
  return Math.max(...values) - values[0]!;
}

function phasedDescriptorPeakGrowth(
  samples: readonly ResourceSample[],
  phaseCount: 1 | 2,
): number {
  return Math.max(
    ...Array.from({ length: phaseCount }, (_unused, phase) =>
      peakGrowth(
        samples
          .filter(({ index }) => index % phaseCount === phase)
          .map(({ openFileDescriptorCount }) => openFileDescriptorCount),
      )),
  );
}

function slopeBytesPerSecond(samples: readonly ResourceSample[]): number {
  if (samples.length < 2) return 0;
  const xMean = samples.reduce((sum, sample) => sum + sample.offsetMs, 0) / samples.length;
  const yMean = samples.reduce((sum, sample) => sum + sample.residentBytes, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const x = sample.offsetMs - xMean;
    numerator += x * (sample.residentBytes - yMean);
    denominator += x * x;
  }
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000);
}

export function evaluateResourceSamples(
  profile: ResourceProfile,
  orphanProcessCount: number,
  options: ResourceEvaluationOptions = {},
): ResourceEvaluation {
  const measured = measuredSamples(profile);
  const residentGrowthBytes = growth(measured.map(({ residentBytes }) => residentBytes));
  const openFileDescriptorGrowth = phasedDescriptorPeakGrowth(
    measured,
    options.openFileDescriptorPhaseCount ?? 1,
  );
  const journalPendingGrowth = peakGrowth(measured.map(({ journalPendingCount }) => journalPendingCount));
  const residentSlopeBytesPerSecond = slopeBytesPerSecond(measured);
  const enoughSamples = measured.length >= profile.policy.minimumMeasuredSamples;
  const gcModeValid =
    profile.samplingMode !== "post_gc" ||
    COMPONENT_IDS.every((componentId) => profile.gcConfirmedComponents.includes(componentId));
  return {
    sampleCount: profile.samples.length,
    measuredSampleCount: measured.length,
    residentGrowthBytes,
    residentSlopeBytesPerSecond,
    openFileDescriptorGrowth,
    journalPendingGrowth,
    orphanProcessCount,
    passed:
      enoughSamples &&
      gcModeValid &&
      residentGrowthBytes <= profile.policy.maxResidentGrowthBytes &&
      residentSlopeBytesPerSecond <= profile.policy.maxResidentSlopeBytesPerSecond &&
      openFileDescriptorGrowth <= profile.policy.maxOpenFileDescriptorGrowth &&
      journalPendingGrowth <= profile.policy.maxJournalPendingGrowth &&
      orphanProcessCount <= profile.policy.maxOrphanProcessCount,
  };
}

export function resourceProfileIssues(
  profile: ResourceProfile,
  leaks: LeakCounters,
  path = "/resources",
  evaluationOptions: ResourceEvaluationOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (stableJson(profile.policy) !== stableJson(CANONICAL_RESOURCE_POLICY)) {
    issues.push({
      path: `${path}/policy`,
      code: "resource.noncanonical_policy",
      message: "resource thresholds must equal the versioned conformance policy",
    });
  }
  profile.samples.forEach((sample, index) => {
    if (sample.index !== index) {
      issues.push({
        path: `${path}/samples/${index}/index`,
        code: "resource.sample_index",
        message: "resource sample indexes must be contiguous and zero based",
      });
    }
    if (index > 0 && sample.offsetMs <= profile.samples[index - 1]!.offsetMs) {
      issues.push({
        path: `${path}/samples/${index}/offsetMs`,
        code: "resource.sample_order",
        message: "resource sample offsets must increase strictly",
      });
    }
  });
  if (new Set(profile.gcConfirmedComponents).size !== profile.gcConfirmedComponents.length) {
    issues.push({
      path: `${path}/gcConfirmedComponents`,
      code: "resource.duplicate_gc_component",
      message: "GC confirmation component ids must be unique",
    });
  }
  if (profile.evaluation === null) {
    issues.push({
      path: `${path}/evaluation`,
      code: "resource.missing_evaluation",
      message: "passing evidence requires a measured resource evaluation",
    });
    return issues;
  }
  const expected = evaluateResourceSamples(
    profile,
    leaks.orphanProcessCount,
    evaluationOptions,
  );
  if (stableJson(profile.evaluation) !== stableJson(expected)) {
    issues.push({
      path: `${path}/evaluation`,
      code: "resource.evaluation_mismatch",
      message: "resource evaluation does not match retained samples and canonical thresholds",
    });
  }
  if (
    leaks.openFileDescriptorDelta !== expected.openFileDescriptorGrowth ||
    leaks.residentBytesDelta !== expected.residentGrowthBytes ||
    leaks.journalPendingDelta !== expected.journalPendingGrowth ||
    leaks.orphanProcessCount !== expected.orphanProcessCount
  ) {
    issues.push({
      path: "/leaks",
      code: "resource.summary_mismatch",
      message: "legacy leak summary must be derived from the measured resource profile",
    });
  }
  if (!expected.passed) {
    issues.push({
      path,
      code: "run.resource_leak",
      message: "measured resource samples exceed the canonical growth, slope, fd, journal, or orphan thresholds",
    });
  }
  return issues;
}
