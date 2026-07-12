import assert from "node:assert/strict";
import { summarizeSpatialState } from "../build/spatial/spatialSummary.js";
import {
  createTestStore,
  operationFixtureNodes,
  seedSnapshot,
} from "./spatial-phase1b-test-helpers.mjs";

const fixture = createTestStore("summary");
try {
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:summary-v03",
    nodes: operationFixtureNodes(),
  });
  const summary = summarizeSpatialState(fixture.store, {
    snapshotId: "snapshot:summary-v03",
    requireCurrent: true,
    trust: { liveness: "current" },
    includeSystems: true,
  });
  assert.equal(summary.guarded, false);
  assert.equal(summary.action, "summarize_spatial_state");
  assert.equal(summary.advisory, true);
  assert.equal(summary.quotableAsVerification, false);
  assert.equal(summary.verdictCapability, "context_only");
  assert.equal(summary.capabilityCoverage.adapter, "native_v03");
  assert.equal(summary.partial, false);
  assert.equal(summary.truncated, false);
  assert.ok(summary.warnings.includes("spatial_state_summary_is_advisory_only"));
  assert.match(summary.notices.join(" "), /never verification evidence/i);

  const level = summary.levels.find((entry) => entry.levelUniqueId === "level:01");
  assert.ok(level);
  assert.equal(level.levelName, "Level 01");
  assert.equal(level.nodeCount, 5);
  assert.equal(level.nodesByKind.revit_element, 5);
  assert.equal(level.nodesByCategory.Ducts, 2);
  assert.equal(level.nodesByCategory.Pipes, 1);
  assert.equal(level.nodesByRole.mep_curve, 3);
  assert.equal(level.nodesBySystem["Supply Air"], 2);
  assert.deepEqual(level.bounds, {
    minMm: [-500, -500, -200],
    maxMm: [2_000, 1_000, 1_000],
  });
  assert.equal(summary.levels.some((entry) => entry.levelKey === "<unscoped>"), true,
    "Connector rows without a source Level must stay explicitly unscoped.");

  const serialized = JSON.stringify(summary).toLowerCase();
  for (const forbidden of ["clearanceverdict", "clashverdict", "clashfree", "verifiedclearance"]) {
    assert.equal(serialized.includes(forbidden), false, `Advisory summary leaked forbidden claim field ${forbidden}.`);
  }

  const withoutSystems = summarizeSpatialState(fixture.store, {
    snapshotId: "snapshot:summary-v03",
    trust: { liveness: "current" },
    includeSystems: false,
  });
  assert.equal(withoutSystems.guarded, false);
  assert.ok(withoutSystems.levels.every((entry) => !Object.hasOwn(entry, "nodesBySystem")));

  const bounded = summarizeSpatialState(fixture.store, {
    snapshotId: "snapshot:summary-v03",
    trust: { liveness: "current" },
    maxLevels: 1,
  });
  assert.equal(bounded.guarded, false);
  assert.equal(bounded.partial, true);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.scanStoppedReason, "max_items");
  assert.equal(bounded.counts.omittedLevelCount, 1);

  const unknownCurrent = summarizeSpatialState(fixture.store, {
    snapshotId: "snapshot:summary-v03",
    requireCurrent: true,
    trust: { liveness: "unknown" },
  });
  assert.equal(unknownCurrent.guarded, true);
  assert.equal(unknownCurrent.reason, "snapshot_not_current");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:summary-incomplete",
    nodes: operationFixtureNodes(),
    partial: true,
  });
  const incomplete = summarizeSpatialState(fixture.store, {
    snapshotId: "snapshot:summary-incomplete",
    requireCurrent: true,
    trust: { liveness: "current" },
  });
  assert.equal(incomplete.guarded, true,
    "A current liveness probe cannot promote incomplete extraction coverage into a summary.");
  assert.equal(incomplete.reason, "incomplete_snapshot");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:summary-v02",
    schemaVersion: "0.2",
    nodes: operationFixtureNodes(),
  });
  const legacyFiltered = summarizeSpatialState(fixture.store, {
    snapshotId: "snapshot:summary-v02",
    filters: { categories: ["Ducts"] },
  });
  assert.equal(legacyFiltered.guarded, true);
  assert.equal(legacyFiltered.reason, "unsupported_snapshot_capability");
  const legacyExplicit = summarizeSpatialState(fixture.store, {
    snapshotId: "snapshot:summary-v02",
    filters: { nodeIds: ["node:duct-a"], categories: ["Ducts"] },
  });
  assert.equal(legacyExplicit.guarded, false);
  assert.equal(legacyExplicit.capabilityCoverage.adapter, "legacy_v02");
  assert.equal(legacyExplicit.counts.nodeCount, 1);
} finally {
  fixture.cleanup();
}

console.log("spatial Phase 1b advisory summary tests: ok");
