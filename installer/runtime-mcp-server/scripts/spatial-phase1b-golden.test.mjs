import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareSpatialSnapshots } from "../build/spatial/spatialDiff.js";
import { locateNodeInSpace } from "../build/spatial/spatialGeometry.js";
import { querySpatialContext } from "../build/spatial/spatialQuery.js";
import { summarizeSpatialState } from "../build/spatial/spatialSummary.js";
import {
  createTestStore,
  diffFixtureNodes,
  makeConnectorNode,
  makeElementNode,
  normalizePhase1bResult,
  operationFixtureNodes,
  seedSnapshot,
  sourceRevision,
} from "./spatial-phase1b-test-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(__dirname, "fixtures", "spatial");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8"));

const frozenGold = Object.fromEntries([
  "phase1b-operation.golden.json",
  "phase1b-diff.golden.json",
  "phase1b-compatibility.golden.json",
].map((fixtureName) => [fixtureName, readJson(fixtureName)]));
for (const [fixtureName, document] of Object.entries(frozenGold)) {
  assert.match(document.suite, /^spatial_phase1b_/);
  const normalizedOnce = normalizePhase1bResult(document);
  const normalizedTwice = normalizePhase1bResult(normalizedOnce);
  assert.deepEqual(normalizedTwice, normalizedOnce, `${fixtureName} normalization must be idempotent.`);
}
const operationGold = frozenGold["phase1b-operation.golden.json"];

function projectComputed(value) {
  if (Array.isArray(value)) return value.map(projectComputed);
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => !["nodes", "edges"].includes(key))
    .sort()
    .map((key) => [key, projectComputed(value[key])]));
}

function normalizedResultSha256(result) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(normalizePhase1bResult(result)))
    .digest("hex")}`;
}

function exactOperationProjection(result) {
  return normalizePhase1bResult({
    success: result.success,
    guarded: result.guarded,
    state: result.state,
    action: result.action,
    reason: result.reason ?? null,
    snapshotId: result.snapshotId ?? null,
    revisionFingerprint: result.revisionFingerprint ?? null,
    liveness: result.liveness ?? null,
    mode: result.mode ?? null,
    operation: result.operation ?? null,
    inputs: result.inputs ?? null,
    nodeIds: result.nodes?.map((node) => node.nodeId) ?? [],
    edges: result.edges?.map((edge) => ({
      relationType: edge.relationType,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      bidirectional: edge.bidirectional,
    })) ?? [],
    computed: projectComputed(result.computed),
    capabilityCoverage: result.capabilityCoverage ?? null,
    basis: result.basis ?? null,
    precisionClass: result.precisionClass ?? null,
    verdictCapability: result.verdictCapability ?? null,
    partial: result.partial,
    truncated: result.truncated,
    scanStoppedReason: result.scanStoppedReason,
    scanPolicy: result.scanPolicy,
    suggestedNextScopes: result.suggestedNextScopes,
    nextCursor: result.nextCursor,
    counts: result.counts ?? null,
    warnings: result.warnings,
    notices: result.notices,
    normalizedResultSha256: normalizedResultSha256(result),
  });
}

function exactDiffProjection(result) {
  const changeRows = (rows) => (rows ?? []).map((row) => ({
    nodeId: row.nodeId ?? null,
    nodeKind: row.nodeKind ?? null,
    documentKey: row.documentKey ?? null,
    changedFields: row.changedFields ?? null,
    sourceNodeId: row.sourceNodeId ?? null,
    targetNodeId: row.targetNodeId ?? null,
    relation: row.relation ?? null,
    changeType: row.changeType ?? null,
    separationMm: row.separationMm ?? null,
    intersects: row.intersects ?? null,
    basis: row.basis ?? null,
    precisionClass: row.precisionClass ?? null,
  }));
  return normalizePhase1bResult({
    success: result.success,
    guarded: result.guarded,
    state: result.state,
    action: result.action,
    reason: result.reason ?? null,
    baseSnapshotId: result.baseSnapshotId ?? null,
    headSnapshotId: result.headSnapshotId ?? null,
    scopeFingerprint: result.scopeFingerprint ?? null,
    baseRevisionFingerprint: result.baseRevisionFingerprint ?? null,
    headRevisionFingerprint: result.headRevisionFingerprint ?? null,
    addedIds: result.added?.map((node) => node.nodeId) ?? [],
    removedIds: result.removed?.map((node) => node.nodeId) ?? [],
    sourceAvailabilityChanges: (result.sourceAvailabilityChanges ?? []).map((row) => ({
      sourceKey: row.sourceKey,
      changeType: row.changeType,
    })),
    transformChanges: (result.transformChanges ?? []).map((row) => ({
      sourceKey: row.sourceKey,
      changeType: row.changeType,
    })),
    moved: changeRows(result.moved),
    geometryChanges: changeRows(result.geometryChanges),
    geometryIndeterminate: changeRows(result.geometryIndeterminate),
    propertyChanges: changeRows(result.propertyChanges),
    connectorChanges: changeRows(result.connectorChanges),
    connectivityChanges: changeRows(result.connectivityChanges),
    proximityChanges: changeRows(result.proximityChanges),
    capabilityCoverage: result.capabilityCoverage ?? null,
    partial: result.partial,
    truncated: result.truncated,
    scanStoppedReason: result.scanStoppedReason,
    scanPolicy: result.scanPolicy,
    suggestedNextScopes: result.suggestedNextScopes,
    counts: result.counts ?? null,
    warnings: result.warnings,
    notices: result.notices,
    normalizedResultSha256: normalizedResultSha256(result),
  });
}

assert.deepEqual(
  normalizePhase1bResult({
    queryId: "random-a",
    reportId: "random-b",
    summaryId: "random-c",
    elapsedMs: 99.123456789,
    nodes: [{ nodeId: "b", separationMm: 1.00000049 }, { nodeId: "a", separationMm: 2 }],
    warnings: ["z", "a"],
  }),
  {
    nodes: [{ nodeId: "a", separationMm: 2 }, { nodeId: "b", separationMm: 1 }],
    warnings: ["a", "z"],
  },
  "Gold normalization must remove evidence ids/timing, round millimetres, and sort deterministic arrays.",
);

const fixture = createTestStore("golden");
try {
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-operation",
    nodes: operationFixtureNodes(),
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-diff-base",
    nodes: diffFixtureNodes("base"),
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-diff-head",
    nodes: diffFixtureNodes("head"),
  });

  const pointNode = (nodeId, point) => makeElementNode({
    nodeId,
    aabb: { minMm: point, maxMm: point },
    point,
  });
  const roomLoops = [
    [[0, 0, 0], [10_000, 0, 0], [10_000, 10_000, 0], [0, 10_000, 0], [0, 0, 0]],
    [[4_000, 4_000, 0], [4_000, 6_000, 0], [6_000, 6_000, 0], [6_000, 4_000, 0], [4_000, 4_000, 0]],
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-containment",
    nodes: [
      makeElementNode({
        nodeId: "node:room-main",
        category: "Rooms",
        categoryRole: "spatial",
        aabb: { minMm: [0, 0, 0], maxMm: [10_000, 10_000, 3_000] },
        boundaryLoops: roomLoops,
      }),
      makeElementNode({
        nodeId: "node:duct-inside",
        aabb: { minMm: [1_000, 1_000, 2_000], maxMm: [2_000, 2_000, 2_200] },
        centerline: [[1_000, 1_500, 2_100], [2_000, 1_500, 2_100]],
      }),
      pointNode("node:duct-in-hole", [5_000, 5_000, 2_100]),
      pointNode("node:duct-above-room", [1_500, 1_500, 3_600]),
      pointNode("node:boundary-point", [0, 2_000, 1_500]),
      makeElementNode({
        nodeId: "node:room-z-band",
        category: "Rooms",
        categoryRole: "spatial",
        aabb: { minMm: [0, 0, 0], maxMm: [10, 10, 10] },
        boundaryLoops: [[
          [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 0],
        ]],
      }),
      makeElementNode({
        nodeId: "node:z-band-crossing-segment",
        aabb: { minMm: [-5, 5, -20], maxMm: [5, 5, 10] },
        centerline: [[-5, 5, 10], [5, 5, -20]],
      }),
      makeElementNode({
        nodeId: "node:z-band-vertical-boundary-overlap",
        aabb: { minMm: [0, 5, -100], maxMm: [0, 5, 90] },
        centerline: [[0, 5, -100], [0, 5, 90]],
      }),
      makeElementNode({
        nodeId: "node:z-band-vertical-interior-overlap",
        aabb: { minMm: [5, 5, -100], maxMm: [5, 5, 90] },
        centerline: [[5, 5, -100], [5, 5, 90]],
      }),
    ],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-direction",
    nodes: [
      makeElementNode({
        nodeId: "node:duct-inside",
        aabb: { minMm: [1_000, 1_000, 2_000], maxMm: [2_000, 2_000, 2_200] },
        centerline: [[1_000, 1_500, 2_100], [2_000, 1_500, 2_100]],
      }),
      makeElementNode({
        nodeId: "node:pipe-below",
        aabb: { minMm: [1_000, 1_000, 1_000], maxMm: [2_000, 2_000, 1_100] },
      }),
      makeElementNode({
        nodeId: "node:nearest-a",
        aabb: { minMm: [2_500, 1_400, 2_050], maxMm: [2_600, 1_600, 2_150] },
      }),
    ],
  });
  const linkedA = makeElementNode({
    nodeId: "node:room-linked-a",
    aabb: { minMm: [20_000, 0, 0], maxMm: [30_000, 10_000, 3_000] },
  });
  linkedA.elementUniqueId = "fixture-room-source-101";
  linkedA.linkInstanceUniqueId = "fixture-link-a";
  const linkedB = structuredClone(linkedA);
  linkedB.nodeId = "node:room-linked-b";
  linkedB.linkInstanceUniqueId = "fixture-link-b";
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-links",
    nodes: [linkedA, linkedB],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-nearest",
    nodes: [
      makeElementNode({
        nodeId: "node:duct-inside",
        categoryRole: "mep_curve",
        aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
      }),
      makeElementNode({
        nodeId: "node:nearest-a",
        categoryRole: "mep_curve",
        aabb: { minMm: [600, 0, 0], maxMm: [700, 100, 100] },
      }),
      makeElementNode({
        nodeId: "node:nearest-b",
        categoryRole: "mep_curve",
        aabb: { minMm: [-600, 0, 0], maxMm: [-500, 100, 100] },
      }),
    ],
  });

  const owner = (nodeId, x) => makeElementNode({
    nodeId,
    category: "Ducts",
    builtInCategory: "OST_DuctCurves",
    categoryRole: "mep_curve",
    systemKey: "Supply Air",
    aabb: { minMm: [x, 0, 0], maxMm: [x + 100, 100, 100] },
  });
  const lineOwners = [
    owner("node:owner-a", 0), owner("node:owner-b", 1_000),
    owner("node:owner-c", 2_000), owner("node:owner-f", 3_000),
  ];
  const lineConnectors = [
    ["connector:a-out", "node:owner-a", "connector:b-in"],
    ["connector:b-in", "node:owner-b", "connector:a-out"],
    ["connector:b-out", "node:owner-b", "connector:c-in"],
    ["connector:c-in", "node:owner-c", "connector:b-out"],
    ["connector:b-branch", "node:owner-b", "connector:f-in"],
    ["connector:f-in", "node:owner-f", "connector:b-branch"],
  ].map(([nodeId, ownerNodeId, peer], index) => makeConnectorNode({
    nodeId, ownerNodeId, connectedToNodeIds: [peer], point: [index * 100, 0, 0], systemKey: "Supply Air",
  }));
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-topology-line",
    nodes: [...lineOwners, ...lineConnectors],
  });
  const cycleConnectors = [
    ...lineConnectors.map((node) => structuredClone(node)),
    makeConnectorNode({
      nodeId: "connector:c-out", ownerNodeId: "node:owner-c",
      connectedToNodeIds: ["connector:a-in"], systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:a-in", ownerNodeId: "node:owner-a",
      connectedToNodeIds: ["connector:c-out"], systemKey: "Supply Air",
    }),
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-topology-cycle",
    nodes: [...lineOwners.map((node) => structuredClone(node)), ...cycleConnectors],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-topology-disconnected",
    nodes: [
      owner("node:owner-d", 0), owner("node:owner-e", 200),
      makeConnectorNode({
        nodeId: "connector:coincident-disconnected-a", ownerNodeId: "node:owner-d", point: [100, 100, 100],
      }),
      makeConnectorNode({
        nodeId: "connector:coincident-disconnected-b", ownerNodeId: "node:owner-e", point: [100, 100, 100],
      }),
    ],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-topology-ambiguous",
    nodes: [
      owner("node:owner-g", 0), owner("node:owner-d", 200),
      makeConnectorNode({
        nodeId: "connector:g-ambiguous", ownerNodeId: "node:owner-g", ambiguousConnectorCount: 1,
      }),
    ],
  });

  const clearanceNodes = [
    makeElementNode({
      nodeId: "node:rect-clearance",
      aabb: { minMm: [0, 11_775, 1_875], maxMm: [5_000, 12_225, 2_125] },
      centerline: [[0, 12_000, 2_000], [5_000, 12_000, 2_000]],
      profile: { shape: "rectangular", diameterMm: null, widthMm: 400, heightMm: 200, insulationThicknessMm: 25 },
    }),
    makeElementNode({
      nodeId: "node:round-clearance",
      aabb: { minMm: [-75, 12_425, 1_925], maxMm: [5_075, 12_575, 2_075] },
      centerline: [[0, 12_500, 2_000], [5_000, 12_500, 2_000]],
      profile: { shape: "round", diameterMm: 100, widthMm: null, heightMm: null, insulationThicknessMm: 25 },
    }),
    makeElementNode({
      nodeId: "node:round-clearance-peer",
      aabb: { minMm: [-75, 12_775, 1_925], maxMm: [5_075, 12_925, 2_075] },
      centerline: [[0, 12_850, 2_000], [5_000, 12_850, 2_000]],
      profile: { shape: "round", diameterMm: 100, widthMm: null, heightMm: null, insulationThicknessMm: 25 },
    }),
    makeElementNode({ nodeId: "node:unsupported-geometry", aabb: null }),
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-clearance",
    nodes: clearanceNodes,
  });
  const overlapOwners = [
    owner("node:overlap-a", 0),
    owner("node:overlap-b", 50),
    makeConnectorNode({
      nodeId: "connector:overlap-a", ownerNodeId: "node:overlap-a",
      connectedToNodeIds: ["connector:overlap-b"], systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:overlap-b", ownerNodeId: "node:overlap-b",
      connectedToNodeIds: ["connector:overlap-a"], systemKey: "Supply Air",
    }),
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:gold-connected-overlap",
    nodes: overlapOwners,
  });

  const current = { liveness: "current" };
  const analytic = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:gold-operation",
    mode: "operation",
    trust: current,
    operation: { name: "clearance_between", sourceNodeId: "node:duct-a", targetNodeId: "node:pipe-b" },
  });
  const screening = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:gold-operation",
    mode: "operation",
    trust: current,
    operation: { name: "clearance_between", sourceNodeId: "node:pipe-b", targetNodeId: "node:rect-c" },
  });
  const summary = summarizeSpatialState(fixture.store, {
    snapshotId: "snapshot:gold-operation",
    trust: current,
  });
  const diff = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:gold-diff-base",
    headSnapshotId: "snapshot:gold-diff-head",
    proximityRadiusMm: 1_000,
  });

  const runOperation = (snapshotId, operation) => querySpatialContext(fixture.store, {
    snapshotId,
    mode: "operation",
    trust: current,
    operation,
  });
  const executedFrozenCases = new Set();
  const exactOperationActual = {};
  for (const testCase of operationGold.cases) {
    const expected = testCase.expectedNormalizedOutput;
    executedFrozenCases.add(testCase.caseId);
    switch (testCase.caseId) {
      case "containment_inside_outer_loop":
      case "containment_rejects_polygon_hole":
      case "containment_rejects_vertical_outside":
      case "containment_ignores_xy_crossing_outside_vertical_band":
      case "containment_detects_vertical_boundary_overlap":
      case "containment_detects_vertical_interior_overlap":
      case "containment_boundary_is_inclusive": {
        const nodeId = testCase.input.nodeId;
        const result = runOperation("snapshot:gold-containment", {
          name: "locate_in_space",
          nodeId,
          spaceNodeIds: testCase.input.spaceNodeIds,
        });
        const exactProjection = exactOperationProjection(result);
        if ([
          "containment_ignores_xy_crossing_outside_vertical_band",
          "containment_detects_vertical_boundary_overlap",
          "containment_detects_vertical_interior_overlap",
        ].includes(testCase.caseId)) {
          const containmentEvaluation = locateNodeInSpace(
            fixture.store.getStoredNode("snapshot:gold-containment", nodeId),
            fixture.store.getStoredNode("snapshot:gold-containment", "node:room-z-band"),
          );
          exactProjection.containmentEvaluation = projectComputed(containmentEvaluation);
          const expectedEvaluation = testCase.caseId === "containment_ignores_xy_crossing_outside_vertical_band"
            ? {
              elementNodeId: "node:z-band-crossing-segment",
              status: "outside",
              insideSampleCount: 0,
              boundarySampleCount: 0,
              outsideSampleCount: 5,
              segmentBoundaryCrossing: false,
            }
            : {
              elementNodeId: testCase.caseId === "containment_detects_vertical_boundary_overlap"
                ? "node:z-band-vertical-boundary-overlap"
                : "node:z-band-vertical-interior-overlap",
              status: "partial",
              insideSampleCount: testCase.caseId === "containment_detects_vertical_interior_overlap" ? 3 : 0,
              boundarySampleCount: testCase.caseId === "containment_detects_vertical_boundary_overlap" ? 3 : 0,
              outsideSampleCount: 3,
              segmentBoundaryCrossing: true,
            };
          assert.deepEqual(containmentEvaluation, {
            ...expectedEvaluation,
            spaceNodeId: "node:room-z-band",
            basis: "stored_boundary_loops_and_vertical_extent",
            precisionClass: "measured",
            verdictCapability: "context_only",
          });
        }
        exactOperationActual[testCase.caseId] = exactProjection;
        assert.equal(result.guarded, false, testCase.caseId);
        const located = result.computed.some((row) =>
          row.status === "inside" || row.status === "boundary" || row.status === "partial");
        assert.equal(located, expected.computed.located, testCase.caseId);
        if (testCase.caseId === "containment_boundary_is_inclusive") {
          assert.equal(result.computed[0].status, "boundary");
        }
        break;
      }
      case "direction_above_below":
      case "direction_overlapping_ranges_is_indeterminate": {
        const first = testCase.input.firstNodeId;
        const second = testCase.input.secondNodeId;
        const result = runOperation("snapshot:gold-direction", {
          name: "above_below",
          sourceNodeId: first,
          targetNodeId: second,
          toleranceMm: testCase.input.toleranceMm,
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        assert.equal(result.guarded, false, testCase.caseId);
        const relation = result.computed.verticalRelation === "above"
          ? "first_above_second"
          : "overlapping_vertical_ranges";
        assert.equal(relation, expected.computed.relation, testCase.caseId);
        assert.equal(result.computed.separationMm, expected.computed.separationMm, testCase.caseId);
        break;
      }
      case "double_placed_link_identity": {
        const result = querySpatialContext(fixture.store, {
          snapshotId: "snapshot:gold-links",
          mode: "retrieve",
          filters: { nodeIds: ["node:room-linked-a", "node:room-linked-b"] },
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        assert.equal(result.guarded, false);
        assert.deepEqual(result.nodes.map((node) => node.nodeId), expected.nodes.map((node) => node.nodeId));
        assert.equal(new Set(result.nodes.map((node) => node.linkInstanceUniqueId)).size, 2);
        break;
      }
      case "nearest_tie_orders_by_node_id":
      case "elements_within_includes_boundary": {
        const result = runOperation("snapshot:gold-nearest", {
          name: testCase.caseId.startsWith("nearest") ? "nearest_elements" : "elements_within",
          anchorNodeId: "node:duct-inside",
          ...(testCase.caseId.startsWith("nearest") ? { maxDistanceMm: 500, limit: 2 } : { distanceMm: 500, limit: 2 }),
          filters: { categoryRoles: ["mep_curve"] },
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        assert.equal(result.guarded, false);
        const actualIds = result.computed.map((row) => row.targetNodeId);
        const expectedIds = testCase.caseId.startsWith("nearest")
          ? expected.computed.nearest.map((row) => row.nodeId)
          : expected.computed.matchingNodeIds;
        assert.deepEqual(actualIds, expectedIds, `${testCase.caseId} must preserve semantic output order.`);
        assert.ok(result.computed.every((row) => row.separationMm === 500));
        break;
      }
      case "topology_traces_native_adjacency":
      case "topology_branch_is_deterministic": {
        const result = runOperation("snapshot:gold-topology-line", {
          name: "trace_connectivity",
          startNodeId: testCase.input.startNodeId,
          targetNodeId: testCase.input.targetNodeId,
          maxDepth: 10,
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        assert.equal(result.guarded, false, testCase.caseId);
        assert.equal(result.computed.reachedTarget, expected.computed.connected);
        assert.deepEqual(
          result.computed.pathNodeIds.filter((nodeId) => nodeId.startsWith("node:")),
          expected.computed.ownerPath,
          `${testCase.caseId} owner path order changed.`,
        );
        break;
      }
      case "topology_does_not_infer_coincident_connection": {
        const result = runOperation("snapshot:gold-topology-disconnected", {
          name: "trace_connectivity",
          startNodeId: "node:owner-d",
          targetNodeId: "node:owner-e",
          maxDepth: 10,
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        assert.equal(result.guarded, false);
        assert.equal(result.computed.reachedTarget, expected.computed.connected);
        assert.equal(result.edges.some((edge) => edge.relationType === "connected_to"), false);
        break;
      }
      case "topology_cycle_terminates_without_duplicates": {
        const result = runOperation("snapshot:gold-topology-cycle", {
          name: "trace_connectivity",
          startNodeId: "node:owner-a",
          maxDepth: 20,
          maxNodes: 100,
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        assert.equal(result.guarded, false);
        const owners = result.computed.visitedNodeIds.filter((nodeId) => nodeId.startsWith("node:"));
        assert.deepEqual(owners, expected.computed.connectedOwnerNodeIds);
        assert.equal(new Set(result.computed.visitedNodeIds).size, result.computed.visitedNodeIds.length);
        assert.equal(new Set(result.edges.map((edge) => edge.edgeId)).size, result.edges.length);
        break;
      }
      case "topology_ambiguity_fails_closed": {
        const result = runOperation("snapshot:gold-topology-ambiguous", {
          name: "trace_connectivity",
          startNodeId: "node:owner-g",
          targetNodeId: "node:owner-d",
          maxDepth: 10,
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        assert.equal(result.guarded, expected.guarded);
        assert.equal(result.reason, "incomplete_topology_coverage");
        break;
      }
      case "analytic_clearance_round_round":
      case "rectangular_clearance_is_screening_only":
      case "unsupported_geometry_fails_closed": {
        const result = runOperation("snapshot:gold-clearance", {
          name: "clearance_between",
          sourceNodeId: testCase.input.firstNodeId,
          targetNodeId: testCase.input.secondNodeId,
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        assert.equal(result.guarded, expected.guarded, testCase.caseId);
        if (!result.guarded) {
          assert.equal(result.computed.separationMm, expected.computed.separationMm, testCase.caseId);
          assert.equal(result.precisionClass, expected.precisionClass, testCase.caseId);
          assert.equal(result.verdictCapability, expected.verdictCapability, testCase.caseId);
          assert.equal(Object.hasOwn(result.computed, "clearanceVerdict"), false);
        }
        break;
      }
      case "intended_connected_overlap_is_not_a_verdict": {
        const result = runOperation("snapshot:gold-connected-overlap", {
          name: "relation_between",
          sourceNodeId: "node:overlap-a",
          targetNodeId: "node:overlap-b",
        });
        exactOperationActual[testCase.caseId] = exactOperationProjection(result);
        const connected = fixture.store.queryStoredEdges({
          snapshotId: "snapshot:gold-connected-overlap",
          relationTypes: ["connected_to"],
        }).edges.length === 1;
        assert.equal(result.guarded, false);
        assert.equal(result.computed.intersects, expected.computed.intersects);
        assert.equal(connected, expected.computed.connected);
        assert.equal(Object.hasOwn(result.computed, "clashVerdict"), false);
        break;
      }
      default:
        assert.fail(`Frozen operation gold case has no executable adapter: ${testCase.caseId}`);
    }
  }
  assert.equal(executedFrozenCases.size, operationGold.cases.length,
    "Every frozen operation gold case must execute against runtime geometry/topology code.");

  const diffGold = frozenGold["phase1b-diff.golden.json"];
  const exactDiffActual = {};
  const sha = (character) => `sha256:${character.repeat(64)}`;
  const explicitFingerprints = (placement, shape, property, topology) => ({
    version: "phase1b-spatial-fingerprint/1.0",
    placement: sha(placement),
    shape: sha(shape),
    property: sha(property),
    topology: sha(topology),
  });
  for (const scenario of diffGold.scenarios) {
    const base = scenario.base;
    const head = scenario.head;
    switch (scenario.caseId) {
      case "link_reload_add_remove_unload": {
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId,
          nodes: [],
          scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint,
          sources: [
            sourceRevision("fixture:host"),
            sourceRevision("fixture:reload", { linkInstanceUniqueId: "fixture-link-reload", loadedVersion: "v1" }),
            sourceRevision("fixture:remove", { linkInstanceUniqueId: "fixture-link-remove", loadedVersion: "v1" }),
            sourceRevision("fixture:unload", { linkInstanceUniqueId: "fixture-link-unload", loadedVersion: "v1" }),
          ],
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId,
          nodes: [],
          scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
          sources: [
            sourceRevision("fixture:host"),
            sourceRevision("fixture:add", { linkInstanceUniqueId: "fixture-link-add", loadedVersion: "v1" }),
            sourceRevision("fixture:reload", { linkInstanceUniqueId: "fixture-link-reload", loadedVersion: "v2" }),
          ],
        });
        break;
      }
      case "link_transform_change_preserves_node_identity": {
        const baseNode = makeElementNode({
          nodeId: "node:linked-transform-element",
          aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
          fingerprints: explicitFingerprints("1", "2", "3", "4"),
        });
        const headNode = makeElementNode({
          nodeId: "node:linked-transform-element",
          aabb: { minMm: [1_000, 500, 0], maxMm: [1_100, 600, 100] },
          fingerprints: explicitFingerprints("5", "2", "3", "4"),
        });
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, nodes: [baseNode], scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint,
          sources: [sourceRevision("fixture:host"), sourceRevision("fixture:transform", {
            linkInstanceUniqueId: "fixture-link-transform", loadedVersion: "v1", translation: [0, 0, 0],
          })],
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, nodes: [headNode], scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
          sources: [sourceRevision("fixture:host"), sourceRevision("fixture:transform", {
            linkInstanceUniqueId: "fixture-link-transform", loadedVersion: "v1", translation: [1_000, 500, 0],
          })],
        });
        break;
      }
      case "resized_but_unmoved_duct": {
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint,
          nodes: [makeElementNode({
            nodeId: "node:duct-resize",
            aabb: { minMm: [-200, -100, 0], maxMm: [200, 100, 100] },
            profile: { shape: "rectangular", diameterMm: null, widthMm: 400, heightMm: 200, insulationThicknessMm: 0 },
          })],
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
          nodes: [makeElementNode({
            nodeId: "node:duct-resize",
            aabb: { minMm: [-300, -150, 0], maxMm: [300, 150, 100] },
            profile: { shape: "rectangular", diameterMm: null, widthMm: 600, heightMm: 300, insulationThicknessMm: 0 },
          })],
        });
        break;
      }
      case "moved_same_shape": {
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint,
          nodes: [makeElementNode({
            nodeId: "node:duct-move", aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
          })],
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
          nodes: [makeElementNode({
            nodeId: "node:duct-move", aabb: { minMm: [1_000, 500, 0], maxMm: [1_100, 600, 100] },
          })],
        });
        break;
      }
      case "system_property_change": {
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint,
          nodes: [makeElementNode({
            nodeId: "node:duct-system", systemKey: "Supply Air",
            aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
          })],
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
          nodes: [makeElementNode({
            nodeId: "node:duct-system", systemKey: "Return Air",
            aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
          })],
        });
        break;
      }
      case "connector_topology_rewire": {
        const owners = ["a", "b", "c"].map((suffix, index) => owner(`node:rewire-owner-${suffix}`, index * 100));
        const connectorSet = (rewired) => [
          makeConnectorNode({
            nodeId: "connector:rewire-a", ownerNodeId: "node:rewire-owner-a",
            connectedToNodeIds: [rewired ? "connector:rewire-c" : "connector:rewire-b"], systemKey: "Supply Air",
          }),
          makeConnectorNode({
            nodeId: "connector:rewire-b", ownerNodeId: "node:rewire-owner-b",
            connectedToNodeIds: rewired ? [] : ["connector:rewire-a"], systemKey: "Supply Air",
          }),
          makeConnectorNode({
            nodeId: "connector:rewire-c", ownerNodeId: "node:rewire-owner-c",
            connectedToNodeIds: rewired ? ["connector:rewire-a"] : [], systemKey: "Supply Air",
          }),
        ];
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint,
          nodes: [...owners, ...connectorSet(false)],
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
          nodes: [...owners.map((node) => structuredClone(node)), ...connectorSet(true)],
        });
        break;
      }
      case "journal_gap_allows_historical_diff_only": {
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, nodes: [], scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint,
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, nodes: [], scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
        });
        break;
      }
      case "partial_snapshot_is_not_diffable": {
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, nodes: [], scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint, partial: true, coverageStatus: "incomplete_budget",
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, nodes: [], scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
        });
        break;
      }
      default:
        assert.fail(`Frozen diff gold scenario has no runtime adapter: ${scenario.caseId}`);
    }
    exactDiffActual[scenario.caseId] = exactDiffProjection(compareSpatialSnapshots(fixture.store, {
      baseSnapshotId: base.snapshotId,
      headSnapshotId: head.snapshotId,
      maxChanges: 10_000,
      proximityRadiusMm: 1_000,
      maxProximityPairs: 10_000,
    }));
  }

  const compatibilityGold = frozenGold["phase1b-compatibility.golden.json"];
  const exactCompatibilityActual = {};
  for (const testCase of compatibilityGold.cases) {
    switch (testCase.caseId) {
      case "v0_1_identity_only_is_not_current_query_evidence": {
        const snapshot = testCase.input.snapshot;
        seedSnapshot(fixture.store, {
          snapshotId: snapshot.snapshotId, schemaVersion: "0.1",
          scopeFingerprint: snapshot.scopeFingerprint, revisionFingerprint: snapshot.revisionFingerprint,
          nodes: [pointNode("node:compat-v01", [0, 0, 0])],
        });
        exactCompatibilityActual[testCase.caseId] = exactOperationProjection(querySpatialContext(fixture.store, {
          snapshotId: snapshot.snapshotId,
          mode: "operation",
          trust: { liveness: "unknown" },
          operation: { name: "above_below", sourceNodeId: "node:compat-v01", targetNodeId: "node:missing" },
        }));
        break;
      }
      case "v0_2_aabb_direction_adapter_is_explicit": {
        const snapshot = testCase.input.snapshot;
        seedSnapshot(fixture.store, {
          snapshotId: snapshot.snapshotId, schemaVersion: "0.2",
          scopeFingerprint: snapshot.scopeFingerprint, revisionFingerprint: snapshot.revisionFingerprint,
          nodes: [
            makeElementNode({
              nodeId: "node:compat-v02-high", aabb: { minMm: [0, 0, 2_000], maxMm: [1_000, 1_000, 2_200] },
            }),
            makeElementNode({
              nodeId: "node:compat-v02-low", aabb: { minMm: [0, 0, 1_000], maxMm: [1_000, 1_000, 1_100] },
            }),
          ],
        });
        exactCompatibilityActual[testCase.caseId] = exactOperationProjection(querySpatialContext(fixture.store, {
          snapshotId: snapshot.snapshotId,
          mode: "operation",
          trust: { liveness: "stale" },
          operation: {
            name: "above_below", sourceNodeId: "node:compat-v02-high", targetNodeId: "node:compat-v02-low",
          },
        }));
        break;
      }
      case "v0_2_topology_is_not_inferred_from_is_connected": {
        const snapshot = testCase.input.snapshot;
        seedSnapshot(fixture.store, {
          snapshotId: snapshot.snapshotId, schemaVersion: "0.2",
          scopeFingerprint: snapshot.scopeFingerprint, revisionFingerprint: snapshot.revisionFingerprint,
          nodes: [
            owner("node:compat-owner-a", 0), owner("node:compat-owner-b", 100),
            makeConnectorNode({
              nodeId: "connector:compat-v02-a", ownerNodeId: "node:compat-owner-a",
              connectedToNodeIds: [], point: [100, 100, 100],
            }),
            makeConnectorNode({
              nodeId: "connector:compat-v02-b", ownerNodeId: "node:compat-owner-b",
              connectedToNodeIds: [], point: [100, 100, 100],
            }),
          ],
        });
        exactCompatibilityActual[testCase.caseId] = exactOperationProjection(querySpatialContext(fixture.store, {
          snapshotId: snapshot.snapshotId,
          mode: "operation",
          trust: { liveness: "stale" },
          operation: {
            name: "trace_connectivity", startNodeId: "node:compat-owner-a", targetNodeId: "node:compat-owner-b",
          },
        }));
        break;
      }
      case "v0_2_v0_3_precise_diff_requires_capability_adapter": {
        const base = testCase.input.baseSnapshot;
        const head = testCase.input.headSnapshot;
        const mixedNode = makeElementNode({
          nodeId: "node:compat-mixed", aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
        });
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, schemaVersion: "0.2", nodes: [mixedNode],
          scopeFingerprint: base.scopeFingerprint, revisionFingerprint: base.revisionFingerprint,
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, schemaVersion: "0.3", nodes: [structuredClone(mixedNode)],
          scopeFingerprint: head.scopeFingerprint, revisionFingerprint: head.revisionFingerprint,
        });
        exactCompatibilityActual[testCase.caseId] = exactDiffProjection(compareSpatialSnapshots(fixture.store, {
          baseSnapshotId: base.snapshotId, headSnapshotId: head.snapshotId, allowLegacyV02: true,
        }));
        break;
      }
      case "coordinate_policy_mismatch_is_incomparable": {
        const base = testCase.input.baseSnapshot;
        const head = testCase.input.headSnapshot;
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, nodes: [], scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint, coordinateFrame: "host_internal_mm",
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, nodes: [], scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint, coordinateFrame: "shared_coordinates_mm",
        });
        exactCompatibilityActual[testCase.caseId] = exactDiffProjection(compareSpatialSnapshots(fixture.store, {
          baseSnapshotId: base.snapshotId, headSnapshotId: head.snapshotId,
        }));
        break;
      }
      case "partial_v0_3_is_not_a_diff_base": {
        const base = testCase.input.baseSnapshot;
        const head = testCase.input.headSnapshot;
        seedSnapshot(fixture.store, {
          snapshotId: base.snapshotId, nodes: [], scopeFingerprint: base.scopeFingerprint,
          revisionFingerprint: base.revisionFingerprint, partial: true, coverageStatus: "incomplete_omissions",
        });
        seedSnapshot(fixture.store, {
          snapshotId: head.snapshotId, nodes: [], scopeFingerprint: head.scopeFingerprint,
          revisionFingerprint: head.revisionFingerprint,
        });
        exactCompatibilityActual[testCase.caseId] = exactDiffProjection(compareSpatialSnapshots(fixture.store, {
          baseSnapshotId: base.snapshotId, headSnapshotId: head.snapshotId,
        }));
        break;
      }
      default:
        assert.fail(`Frozen compatibility gold case has no runtime adapter: ${testCase.caseId}`);
    }
  }

  const exactRuntimeBundle = {
    fixtureVersion: "1.0",
    normalizationContract: "phase1b-runtime-exact-projection/2",
    operationCases: exactOperationActual,
    diffScenarios: exactDiffActual,
    compatibilityCases: exactCompatibilityActual,
  };
  if (process.env.REVAGENT_DUMP_PHASE1B_EXACT_GOLD === "1") {
    console.log(`PHASE1B_EXACT_GOLD=${JSON.stringify(exactRuntimeBundle, null, 2)}`);
  } else {
    const exactFixturePath = path.join(fixtureRoot, "phase1b-runtime-exact.golden.json");
    assert.ok(fs.existsSync(exactFixturePath), "Exact Phase 1b runtime golden fixture is missing.");
    const exactExpected = readJson("phase1b-runtime-exact.golden.json");
    assert.deepEqual(Object.keys(exactExpected.operationCases).sort(), operationGold.cases.map((row) => row.caseId).sort());
    assert.deepEqual(Object.keys(exactExpected.diffScenarios).sort(), diffGold.scenarios.map((row) => row.caseId).sort());
    assert.deepEqual(Object.keys(exactExpected.compatibilityCases).sort(), compatibilityGold.cases.map((row) => row.caseId).sort());
    assert.deepEqual(exactRuntimeBundle, exactExpected,
      "Frozen Phase 1b operation/diff/compatibility runtime projections changed.");
  }

  const actualGold = normalizePhase1bResult({
    analytic: {
      action: analytic.action,
      guarded: analytic.guarded,
      basis: analytic.basis,
      precisionClass: analytic.precisionClass,
      verdictCapability: analytic.verdictCapability,
      computed: {
        relation: analytic.computed.relation,
        separationMm: analytic.computed.separationMm,
        intersects: analytic.computed.intersects,
      },
    },
    screening: {
      action: screening.action,
      guarded: screening.guarded,
      basis: screening.basis,
      precisionClass: screening.precisionClass,
      verdictCapability: screening.verdictCapability,
      computed: {
        relation: screening.computed.relation,
        separationMm: screening.computed.separationMm,
        intersects: screening.computed.intersects,
      },
    },
    summary: {
      action: summary.action,
      guarded: summary.guarded,
      advisory: summary.advisory,
      quotableAsVerification: summary.quotableAsVerification,
      verdictCapability: summary.verdictCapability,
      levels: summary.levels.map((level) => ({ levelKey: level.levelKey, nodeCount: level.nodeCount })),
    },
    diff: {
      action: diff.action,
      guarded: diff.guarded,
      added: diff.added.map((node) => ({ nodeId: node.nodeId })),
      removed: diff.removed.map((node) => ({ nodeId: node.nodeId })),
      moved: diff.moved.map((change) => ({ nodeId: change.nodeId })),
      geometryChanges: diff.geometryChanges.map((change) => ({ nodeId: change.nodeId })),
      geometryIndeterminate: diff.geometryIndeterminate.map((change) => ({ nodeId: change.nodeId })),
      propertyChanges: diff.propertyChanges.map((change) => ({ nodeId: change.nodeId })),
      connectorChanges: diff.connectorChanges.map((change) => ({ nodeId: change.nodeId })),
      connectivityChanges: diff.connectivityChanges.map((change) => ({ nodeId: change.nodeId })),
      capabilityFull: diff.capabilityCoverage.full,
    },
  });

  const expectedGold = normalizePhase1bResult({
    analytic: {
      action: "query_spatial_context",
      guarded: false,
      basis: "analytic_straight_round_swept_profile",
      precisionClass: "measured",
      verdictCapability: "context_only",
      computed: { relation: "separated", separationMm: 200, intersects: false },
    },
    screening: {
      action: "query_spatial_context",
      guarded: false,
      basis: "aabb",
      precisionClass: "candidate",
      verdictCapability: "screening_only",
      computed: { relation: "clearance_screening", separationMm: 150, intersects: false },
    },
    summary: {
      action: "summarize_spatial_state",
      guarded: false,
      advisory: true,
      quotableAsVerification: false,
      verdictCapability: "context_only",
      levels: [
        { levelKey: "<unscoped>", nodeCount: 2 },
        { levelKey: "level:01", nodeCount: 5 },
      ],
    },
    diff: {
      action: "compare_spatial_snapshots",
      guarded: false,
      added: [{ nodeId: "node:added" }],
      removed: [{ nodeId: "node:removed" }],
      moved: [{ nodeId: "connector:diff-a" }, { nodeId: "node:moved" }],
      geometryChanges: [{ nodeId: "node:resized" }],
      geometryIndeterminate: [{ nodeId: "node:moved" }],
      propertyChanges: [{ nodeId: "node:property" }],
      connectorChanges: [{ nodeId: "connector:diff-a" }],
      connectivityChanges: [
        { nodeId: "connector:diff-a" },
        { nodeId: "connector:diff-b" },
        { nodeId: "connector:diff-c" },
      ],
      capabilityFull: false,
    },
  });
  assert.deepEqual(actualGold, expectedGold);
} finally {
  fixture.cleanup();
}

console.log("spatial Phase 1b executable golden normalization tests: ok");
