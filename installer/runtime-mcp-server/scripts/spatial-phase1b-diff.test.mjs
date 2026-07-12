import assert from "node:assert/strict";
import { compareSpatialSnapshots } from "../build/spatial/spatialDiff.js";
import {
  TEST_NOW_MS,
  createTestStore,
  diffFixtureNodes,
  makeElementNode,
  seedSnapshot,
  sourceRevision,
} from "./spatial-phase1b-test-helpers.mjs";

const fixture = createTestStore("diff");
try {
  const baseSnapshotId = "snapshot:diff-base";
  const headSnapshotId = "snapshot:diff-head";
  seedSnapshot(fixture.store, {
    snapshotId: baseSnapshotId,
    nodes: diffFixtureNodes("base"),
    capturedAtMs: TEST_NOW_MS - 20_000,
    sources: [sourceRevision("fixture:host", {
      sequence: 10,
      loadedVersion: "fixture-v1",
      translation: [0, 0, 0],
    })],
  });
  seedSnapshot(fixture.store, {
    snapshotId: headSnapshotId,
    nodes: diffFixtureNodes("head"),
    capturedAtMs: TEST_NOW_MS - 10_000,
    sources: [sourceRevision("fixture:host", {
      sequence: 11,
      loadedVersion: "fixture-v2",
      translation: [250, 0, 0],
    })],
  });

  const diff = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId,
    headSnapshotId,
    maxChanges: 1_000,
    proximityRadiusMm: 1_000,
    maxProximityPairs: 1_000,
  });
  assert.equal(diff.guarded, false);
  assert.equal(diff.state, "completed");
  assert.equal(diff.partial, false);
  assert.equal(diff.scanStoppedReason, "completed");
  assert.equal(diff.baseRevisionFingerprint, `revision:${baseSnapshotId}`);
  assert.equal(diff.headRevisionFingerprint, `revision:${headSnapshotId}`);
  assert.equal(diff.capabilityCoverage.full, false);
  assert.deepEqual(diff.capabilityCoverage.geometryChanges, {
    classification: "capability_limited",
    baseAabbOnlyNodeCount: 6,
    headAabbOnlyNodeCount: 6,
    indeterminateChangeCount: 1,
  });
  assert.deepEqual(diff.added.map((node) => node.nodeId), ["node:added"]);
  assert.deepEqual(diff.removed.map((node) => node.nodeId), ["node:removed"]);
  assert.equal(diff.sourceAvailabilityChanges.length, 1);
  assert.equal(diff.sourceAvailabilityChanges[0].changeType, "source_reloaded_or_content_version_changed");
  assert.equal(diff.transformChanges.length, 1);
  assert.equal(diff.transformChanges[0].changeType, "source_to_host_transform_changed");

  assert.ok(diff.moved.some((change) => change.nodeId === "node:moved"));
  assert.ok(diff.moved.some((change) => change.nodeId === "connector:diff-a"));
  assert.equal(diff.moved.some((change) => change.nodeId === "node:resized"), false,
    "Symmetric resizing must not be misclassified as movement.");
  assert.ok(diff.geometryChanges.some((change) => change.nodeId === "node:resized"));
  assert.equal(diff.geometryChanges.some((change) => change.nodeId === "node:moved"), false,
    "A pure translation with stable extents/profile must not be a geometry change.");
  assert.ok(diff.geometryIndeterminate.some((change) =>
    change.nodeId === "node:moved" && change.changedFields.includes("aabb_or_geometry_fingerprint")),
    "An AABB-only moved node must retain explicit geometry-classification uncertainty.");
  assert.ok(diff.propertyChanges.some((change) =>
    change.nodeId === "node:property" && change.changedFields.includes("systemKey")));
  assert.ok(diff.connectorChanges.some((change) => change.nodeId === "connector:diff-a"));
  assert.ok(diff.connectivityChanges.some((change) => change.nodeId === "connector:diff-a"));
  assert.ok(diff.proximityChanges.length > 0, "Affected-neighborhood proximity changes must be classified.");
  assert.ok(diff.counts.totalChangeCount >= 10);
  assert.equal(diff.counts.geometryIndeterminateCount, 1);
  assert.ok(diff.warnings.includes("aabb_only_geometry_change_classification_is_capability_limited"));

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-other-scope",
    nodes: diffFixtureNodes("head"),
    scopeFingerprint: "scope:phase1b:other-level",
  });
  const scopeGuard = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId,
    headSnapshotId: "snapshot:diff-other-scope",
  });
  assert.equal(scopeGuard.guarded, true);
  assert.equal(scopeGuard.reason, "incomparable_scopes");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-partial",
    nodes: diffFixtureNodes("head"),
    partial: true,
  });
  const partialGuard = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId,
    headSnapshotId: "snapshot:diff-partial",
  });
  assert.equal(partialGuard.guarded, true);
  assert.equal(partialGuard.reason, "incomplete_snapshot");

  const legacyBaseNodes = [makeElementNode({
    nodeId: "node:legacy",
    aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
  })];
  const legacyHeadNodes = [makeElementNode({
    nodeId: "node:legacy",
    aabb: { minMm: [100, 0, 0], maxMm: [200, 100, 100] },
  })];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-v02-base",
    schemaVersion: "0.2",
    nodes: legacyBaseNodes,
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-v02-head",
    schemaVersion: "0.2",
    nodes: legacyHeadNodes,
  });

  const legacyDefault = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-v02-base",
    headSnapshotId: "snapshot:diff-v02-head",
  });
  assert.equal(legacyDefault.guarded, true);
  assert.equal(legacyDefault.reason, "unsupported_snapshot_capability");

  const legacyExplicit = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-v02-base",
    headSnapshotId: "snapshot:diff-v02-head",
    allowLegacyV02: true,
  });
  assert.equal(legacyExplicit.guarded, false);
  assert.equal(legacyExplicit.capabilityCoverage.full, false);
  assert.equal(legacyExplicit.capabilityCoverage.base.adapter, "legacy_v02");
  assert.ok(legacyExplicit.warnings.includes("legacy_v02_diff_is_capability_limited"));
  assert.ok(legacyExplicit.moved.some((change) => change.nodeId === "node:legacy"));

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-mixed-v03",
    schemaVersion: "0.3",
    nodes: legacyHeadNodes,
  });
  const mixedSchema = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-v02-base",
    headSnapshotId: "snapshot:diff-mixed-v03",
    allowLegacyV02: true,
  });
  assert.equal(mixedSchema.guarded, true,
    "Native and derived fingerprint algorithms must not classify every mixed-schema node as changed.");
  assert.equal(mixedSchema.reason, "snapshot_capability_mismatch");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-coordinate-host",
    nodes: legacyBaseNodes,
    coordinateFrame: "host_internal_mm",
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-coordinate-shared",
    nodes: legacyBaseNodes,
    coordinateFrame: "shared_coordinates_mm",
  });
  const coordinateMismatch = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-coordinate-host",
    headSnapshotId: "snapshot:diff-coordinate-shared",
  });
  assert.equal(coordinateMismatch.guarded, true,
    "An equal claimed scope fingerprint cannot hide a coordinate-policy mismatch.");
  assert.equal(coordinateMismatch.reason, "incomparable_scopes");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-session-a",
    documentKey: "session-only:session-a",
    nodes: [makeElementNode({
      nodeId: "node:session-only",
      documentKey: "session-only:session-a",
      aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
    })],
    sources: [sourceRevision("session-only:session-a", {
      documentSessionId: "session:a",
      crossSessionComparable: false,
    })],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-session-b",
    documentKey: "session-only:session-b",
    nodes: [makeElementNode({
      nodeId: "node:session-only",
      documentKey: "session-only:session-b",
      aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
    })],
    sources: [sourceRevision("session-only:session-b", {
      documentSessionId: "session:b",
      crossSessionComparable: false,
    })],
  });
  const sessionMismatch = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-session-a",
    headSnapshotId: "snapshot:diff-session-b",
  });
  assert.equal(sessionMismatch.guarded, true);
  assert.equal(sessionMismatch.reason, "incomparable_scopes");

  const fingerprintBaseNode = makeElementNode({
    nodeId: "node:fingerprint-version",
    aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
  });
  const fingerprintHeadNode = structuredClone(fingerprintBaseNode);
  fingerprintHeadNode.payload.fingerprints.version = "phase1b-spatial-fingerprint/2.0";
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-fingerprint-v1",
    nodes: [fingerprintBaseNode],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-fingerprint-v2",
    nodes: [fingerprintHeadNode],
  });
  const fingerprintMismatch = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-fingerprint-v1",
    headSnapshotId: "snapshot:diff-fingerprint-v2",
  });
  assert.equal(fingerprintMismatch.guarded, true);
  assert.equal(fingerprintMismatch.reason, "snapshot_capability_mismatch");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-source-cap-base",
    nodes: [],
    sources: [
      sourceRevision("fixture:host"),
      ...Array.from({ length: 5 }, (_, index) => sourceRevision(`fixture:source-base-${index}`)),
    ],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-source-cap-head",
    nodes: [],
    sources: [
      sourceRevision("fixture:host"),
      ...Array.from({ length: 5 }, (_, index) => sourceRevision(`fixture:source-head-${index}`)),
    ],
  });
  const sourceCapped = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-source-cap-base",
    headSnapshotId: "snapshot:diff-source-cap-head",
    maxChanges: 3,
  });
  assert.equal(sourceCapped.guarded, false);
  assert.equal(sourceCapped.partial, true);
  assert.equal(sourceCapped.truncated, true);
  assert.equal(sourceCapped.scanStoppedReason, "max_items");
  const returnedSourceChanges = sourceCapped.sourceAvailabilityChanges.length + sourceCapped.transformChanges.length;
  assert.ok(returnedSourceChanges <= 3, "maxChanges must be one global returned-output budget, including sources.");
  assert.ok(sourceCapped.counts.totalChangeCount >= 10,
    "Observed change counts must remain visible even when returned rows are capped.");

  const thickInsulationNode = (nodeId, centerlineY) => makeElementNode({
    nodeId,
    category: nodeId.endsWith("anchor") ? "Ducts" : "Pipes",
    builtInCategory: nodeId.endsWith("anchor") ? "OST_DuctCurves" : "OST_PipeCurves",
    categoryRole: "mep_curve",
    aabb: {
      minMm: [-350, centerlineY - 350, -350],
      maxMm: [1_350, centerlineY + 350, 350],
    },
    centerline: [[0, centerlineY, 0], [1_000, centerlineY, 0]],
    profile: { shape: "round", diameterMm: 100, insulationThicknessMm: 300 },
  });
  const thickInsulationAnchor = thickInsulationNode("node:diff-thick-insulation-anchor", 0);
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-thick-insulation-base",
    nodes: [
      thickInsulationAnchor,
      thickInsulationNode("node:diff-thick-insulation-candidate", 850),
    ],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-thick-insulation-head",
    nodes: [
      thickInsulationAnchor,
      thickInsulationNode("node:diff-thick-insulation-candidate", 1_050),
    ],
  });
  const thickInsulationDiff = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-thick-insulation-base",
    headSnapshotId: "snapshot:diff-thick-insulation-head",
    maxChanges: 100,
    proximityRadiusMm: 150,
    maxProximityPairs: 100,
  });
  assert.equal(thickInsulationDiff.guarded, false);
  assert.ok(thickInsulationDiff.moved.some((row) =>
    row.nodeId === "node:diff-thick-insulation-candidate"));
  const thickInsulationProximity = thickInsulationDiff.proximityChanges.find((row) =>
    new Set([row.sourceNodeId, row.targetNodeId]).has("node:diff-thick-insulation-anchor")
      && new Set([row.sourceNodeId, row.targetNodeId]).has("node:diff-thick-insulation-candidate"));
  assert.ok(thickInsulationProximity,
    "Diff proximity must not drop a thick-insulation analytic pair on the conservative AABB radius boundary.");
  assert.equal(thickInsulationProximity.relation, "proximity_removed");
  assert.equal(thickInsulationProximity.changeType, "removed");
  assert.equal(thickInsulationProximity.separationMm, 150);
  assert.equal(thickInsulationProximity.basis, "analytic_straight_round_swept_profile");
  assert.equal(thickInsulationProximity.precisionClass, "measured");

  const proximityBaseNodes = Array.from({ length: 5 }, (_, index) => makeElementNode({
    nodeId: `node:proximity-${index}`,
    aabb: { minMm: [index * 100, 0, 0], maxMm: [index * 100 + 50, 50, 50] },
  }));
  const proximityHeadNodes = proximityBaseNodes.map((node, index) => index === 0
    ? makeElementNode({
      nodeId: node.nodeId,
      aabb: { minMm: [5_000, 0, 0], maxMm: [5_050, 50, 50] },
    })
    : node);
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-proximity-base",
    nodes: proximityBaseNodes,
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:diff-proximity-head",
    nodes: proximityHeadNodes,
  });
  const proximityCapped = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:diff-proximity-base",
    headSnapshotId: "snapshot:diff-proximity-head",
    maxChanges: 100,
    proximityRadiusMm: 1_000,
    maxProximityPairs: 2,
  });
  assert.equal(proximityCapped.guarded, false);
  assert.equal(proximityCapped.partial, true);
  assert.equal(proximityCapped.scanStoppedReason, "max_items");
  assert.ok(proximityCapped.proximityChanges.length <= 2);
} finally {
  fixture.cleanup();
}

console.log("spatial Phase 1b snapshot diff tests: ok");
