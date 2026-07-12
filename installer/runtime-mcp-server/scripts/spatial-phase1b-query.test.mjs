import assert from "node:assert/strict";
import { querySpatialContext } from "../build/spatial/spatialQuery.js";
import {
  createTestStore,
  makeConnectorNode,
  makeElementNode,
  operationFixtureNodes,
  seedSnapshot,
} from "./spatial-phase1b-test-helpers.mjs";

const fixture = createTestStore("query");
try {
  const snapshotId = "snapshot:query-v03";
  seedSnapshot(fixture.store, { snapshotId, nodes: operationFixtureNodes() });
  const current = { liveness: "current" };
  const operation = (payload) => querySpatialContext(fixture.store, {
    snapshotId,
    mode: "operation",
    requireCurrent: true,
    trust: current,
    operation: payload,
  });

  const relation = operation({
    name: "relation_between",
    sourceNodeId: "node:duct-a",
    targetNodeId: "node:pipe-b",
  });
  assert.equal(relation.guarded, false);
  assert.equal(relation.operation, "relation_between");
  assert.equal(relation.computed.separationMm, 200);
  assert.equal(relation.basis, "analytic_straight_round_swept_profile");
  assert.equal(relation.precisionClass, "measured");
  assert.equal(relation.verdictCapability, "context_only");

  const nearest = operation({
    name: "nearest_elements",
    anchorNodeId: "node:duct-a",
    maxDistanceMm: 500,
    limit: 10,
    filters: { categoryRoles: ["mep_curve"] },
  });
  assert.equal(nearest.guarded, false);
  assert.deepEqual(nearest.computed.map((row) => row.targetNodeId), ["node:pipe-b", "node:rect-c"]);
  assert.deepEqual(nearest.computed.map((row) => row.separationMm), [200, 450]);

  const within = operation({
    name: "elements_within",
    anchorNodeId: "node:duct-a",
    distanceMm: 200,
    limit: 10,
    filters: { categoryRoles: ["mep_curve"] },
  });
  assert.equal(within.guarded, false);
  assert.deepEqual(within.computed.map((row) => row.targetNodeId), ["node:pipe-b"],
    "elements_within must include an exact distance-boundary match.");

  const thickInsulationNodes = [
    makeElementNode({
      nodeId: "node:thick-insulation-anchor",
      category: "Ducts",
      builtInCategory: "OST_DuctCurves",
      categoryRole: "mep_curve",
      aabb: { minMm: [-350, -350, -350], maxMm: [1_350, 350, 350] },
      centerline: [[0, 0, 0], [1_000, 0, 0]],
      profile: { shape: "round", diameterMm: 100, insulationThicknessMm: 300 },
    }),
    makeElementNode({
      nodeId: "node:thick-insulation-candidate",
      category: "Pipes",
      builtInCategory: "OST_PipeCurves",
      categoryRole: "mep_curve",
      aabb: { minMm: [-350, 500, -350], maxMm: [1_350, 1_200, 350] },
      centerline: [[0, 850, 0], [1_000, 850, 0]],
      profile: { shape: "round", diameterMm: 100, insulationThicknessMm: 300 },
    }),
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-thick-insulation",
    nodes: thickInsulationNodes,
  });
  const thickInsulationOperation = (payload) => querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-thick-insulation",
    mode: "operation",
    requireCurrent: true,
    trust: current,
    operation: payload,
  });
  for (const [name, radiusKey] of [
    ["nearest_elements", "maxDistanceMm"],
    ["elements_within", "distanceMm"],
  ]) {
    const thickInsulationResult = thickInsulationOperation({
      name,
      anchorNodeId: "node:thick-insulation-anchor",
      [radiusKey]: 150,
      limit: 10,
      filters: { categoryRoles: ["mep_curve"] },
    });
    assert.equal(thickInsulationResult.guarded, false, `${name} thick-insulation query must complete.`);
    assert.deepEqual(
      thickInsulationResult.computed.map((row) => row.targetNodeId),
      ["node:thick-insulation-candidate"],
      `${name} must not drop a thick-insulation analytic candidate on the conservative AABB radius boundary.`,
    );
    assert.equal(thickInsulationResult.computed[0].separationMm, 150);
    assert.equal(thickInsulationResult.computed[0].basis, "analytic_straight_round_swept_profile");
    assert.equal(thickInsulationResult.computed[0].precisionClass, "measured");
  }

  const analyticClearance = operation({
    name: "clearance_between",
    sourceNodeId: "node:duct-a",
    targetNodeId: "node:pipe-b",
  });
  assert.equal(analyticClearance.guarded, false);
  assert.equal(analyticClearance.computed.separationMm, 200);
  assert.equal(analyticClearance.precisionClass, "measured");
  assert.equal(analyticClearance.verdictCapability, "context_only");
  assert.equal(Object.hasOwn(analyticClearance.computed, "clearanceVerdict"), false);

  const screenedClearance = operation({
    name: "clearance_between",
    sourceNodeId: "node:pipe-b",
    targetNodeId: "node:rect-c",
  });
  assert.equal(screenedClearance.guarded, false,
    "Rectangular AABB evidence is a completed screening result, not missing geometry.");
  assert.equal(screenedClearance.computed.relation, "clearance_screening");
  assert.equal(screenedClearance.computed.separationMm, 150);
  assert.equal(screenedClearance.basis, "aabb");
  assert.equal(screenedClearance.precisionClass, "candidate");
  assert.equal(screenedClearance.verdictCapability, "screening_only");
  assert.equal(Object.hasOwn(screenedClearance.computed, "clearanceVerdict"), false);

  const nullInsulationNode = makeElementNode({
    nodeId: "node:null-insulation",
    category: "Pipes",
    categoryRole: "mep_curve",
    aabb: { minMm: [0, 250, -50], maxMm: [1_000, 350, 50] },
    centerline: [[0, 300, 0], [1_000, 300, 0]],
    profile: { shape: "round", diameterMm: 100, widthMm: null, heightMm: null, insulationThicknessMm: null },
  });
  const nonLineNode = makeElementNode({
    nodeId: "node:non-line-round",
    category: "Pipes",
    categoryRole: "mep_curve",
    aabb: { minMm: [-50, 550, -50], maxMm: [1_050, 650, 50] },
    centerline: [[0, 600, 0], [1_000, 600, 0]],
    profile: { shape: "round", diameterMm: 100, widthMm: null, heightMm: null, insulationThicknessMm: 0 },
  });
  nonLineNode.payload.geometry.centerline.curveType = "arc";
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-analytic-fail-closed",
    nodes: [operationFixtureNodes().find((node) => node.nodeId === "node:duct-a"), nullInsulationNode, nonLineNode],
  });
  for (const [targetNodeId, expectedSeparationMm] of [
    ["node:null-insulation", 200],
    ["node:non-line-round", 500],
  ]) {
    const result = querySpatialContext(fixture.store, {
      snapshotId: "snapshot:query-analytic-fail-closed",
      mode: "operation",
      operation: { name: "clearance_between", sourceNodeId: "node:duct-a", targetNodeId },
    });
    assert.equal(result.guarded, false);
    assert.equal(result.basis, "aabb");
    assert.equal(result.precisionClass, "candidate");
    assert.equal(result.verdictCapability, "screening_only");
    assert.equal(result.computed.separationMm, expectedSeparationMm);
  }

  const connectivity = operation({
    name: "trace_connectivity",
    startNodeId: "node:duct-a",
    targetNodeId: "node:pipe-b",
    maxDepth: 10,
    maxNodes: 100,
  });
  assert.equal(connectivity.guarded, false);
  assert.equal(connectivity.computed.reachedTarget, true);
  assert.deepEqual(connectivity.computed.pathNodeIds, [
    "node:duct-a", "connector:a", "connector:b", "node:pipe-b",
  ]);
  assert.equal(connectivity.basis, "stored_connector_topology");

  const zeroDepth = operation({
    name: "trace_connectivity",
    startNodeId: "node:duct-a",
    targetNodeId: "node:pipe-b",
    maxDepth: 0,
    maxNodes: 100,
  });
  assert.equal(zeroDepth.guarded, false);
  assert.equal(zeroDepth.scanPolicy.maxDepth, 0);
  assert.deepEqual(zeroDepth.computed.visitedNodeIds, ["node:duct-a"]);
  assert.deepEqual(zeroDepth.computed.pathEdgeIds, []);
  assert.equal(zeroDepth.edges.length, 1,
    "The boundary adjacency may be evidence for truncation but must not be traversed at depth zero.");
  assert.equal(zeroDepth.computed.reachedTarget, null,
    "A zero-depth bound with unvisited adjacency must not claim disconnected.");
  assert.equal(zeroDepth.partial, true);

  const containment = operation({
    name: "locate_in_space",
    nodeId: "node:duct-a",
    spaceNodeIds: ["node:space"],
  });
  assert.equal(containment.guarded, false);
  assert.equal(containment.computed.length, 1);
  assert.equal(containment.computed[0].status, "inside");
  assert.equal(containment.precisionClass, "measured");

  const closedOuter = [
    [0, 0, 0],
    [1_000, 0, 0],
    [1_000, 0, 0],
    [1_000, 1_000, 0],
    [0, 1_000, 0],
    [0, 0, 0],
  ];
  const closedHole = [
    [400, 400, 0],
    [600, 400, 0],
    [600, 600, 0],
    [600, 600, 0],
    [400, 600, 0],
    [400, 400, 0],
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-closed-boundaries",
    nodes: [
      makeElementNode({
        nodeId: "node:closed-space",
        category: "Spaces",
        categoryRole: "spatial",
        aabb: { minMm: [0, 0, 0], maxMm: [1_000, 1_000, 3_000] },
        boundaryLoops: [closedOuter, closedHole],
      }),
      makeElementNode({
        nodeId: "node:closed-inside",
        aabb: { minMm: [100, 100, 1_000], maxMm: [100, 100, 1_000] },
        point: [100, 100, 1_000],
      }),
      makeElementNode({
        nodeId: "node:closed-hole",
        aabb: { minMm: [500, 500, 1_000], maxMm: [500, 500, 1_000] },
        point: [500, 500, 1_000],
      }),
      makeElementNode({
        nodeId: "node:closed-outside",
        aabb: { minMm: [1_500, 500, 1_000], maxMm: [1_500, 500, 1_000] },
        point: [1_500, 500, 1_000],
      }),
    ],
  });
  const locateClosed = (nodeId) => querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-closed-boundaries",
    mode: "operation",
    operation: { name: "locate_in_space", nodeId, spaceNodeIds: ["node:closed-space"] },
  });
  const closedInside = locateClosed("node:closed-inside");
  assert.equal(closedInside.guarded, false);
  assert.equal(closedInside.computed[0].status, "inside");
  const closedHoleResult = locateClosed("node:closed-hole");
  assert.equal(closedHoleResult.guarded, false);
  assert.deepEqual(closedHoleResult.computed, [],
    "A closed-loop hole with duplicate zero-length segments must still exclude its interior.");
  const closedOutsideResult = locateClosed("node:closed-outside");
  assert.equal(closedOutsideResult.guarded, false);
  assert.deepEqual(closedOutsideResult.computed, []);

  const vertical = operation({
    name: "above_below",
    sourceNodeId: "node:above",
    targetNodeId: "node:duct-a",
    toleranceMm: 0,
  });
  assert.equal(vertical.guarded, false);
  assert.equal(vertical.computed.verticalRelation, "above");
  assert.equal(vertical.computed.separationMm, 450);
  assert.equal(vertical.basis, "aabb_vertical_extents");
  assert.equal(vertical.precisionClass, "candidate");
  assert.equal(vertical.verdictCapability, "screening_only");

  const firstPage = querySpatialContext(fixture.store, {
    snapshotId,
    mode: "retrieve",
    requireCurrent: true,
    trust: current,
    filters: { nodeKinds: ["revit_element"] },
    includeEdges: false,
    limit: 2,
  });
  assert.equal(firstPage.guarded, false);
  assert.equal(firstPage.nodes.length, 2);
  assert.equal(firstPage.truncated, true);
  assert.match(firstPage.nextCursor, /^spatial-query-cursor-v1\./);

  const secondPage = querySpatialContext(fixture.store, {
    snapshotId,
    mode: "retrieve",
    requireCurrent: true,
    trust: current,
    filters: { nodeKinds: ["revit_element"] },
    includeEdges: false,
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.guarded, false);
  assert.equal(secondPage.nodes.some((node) => firstPage.nodes.some((first) => first.nodeId === node.nodeId)), false,
    "Opaque retrieve pagination must not repeat the previous page boundary row.");

  const cursorParts = firstPage.nextCursor.split(".");
  cursorParts[2] = `${cursorParts[2][0] === "A" ? "B" : "A"}${cursorParts[2].slice(1)}`;
  const tampered = querySpatialContext(fixture.store, {
    snapshotId,
    mode: "retrieve",
    requireCurrent: true,
    trust: current,
    filters: { nodeKinds: ["revit_element"] },
    limit: 2,
    cursor: cursorParts.join("."),
  });
  assert.equal(tampered.guarded, true);
  assert.equal(tampered.reason, "invalid_cursor");

  const mismatched = querySpatialContext(fixture.store, {
    snapshotId,
    mode: "retrieve",
    requireCurrent: true,
    trust: current,
    filters: { nodeKinds: ["connector"] },
    limit: 2,
    cursor: firstPage.nextCursor,
  });
  assert.equal(mismatched.guarded, true);
  assert.equal(mismatched.reason, "invalid_cursor");

  const missingTraceTarget = operation({
    name: "trace_connectivity",
    startNodeId: "node:duct-a",
    targetNodeId: "node:missing-target",
  });
  assert.equal(missingTraceTarget.guarded, true);
  assert.equal(missingTraceTarget.reason, "node_not_found",
    "An explicit missing trace target must not be presented as a completed disconnected path.");

  const stale = querySpatialContext(fixture.store, {
    snapshotId,
    mode: "retrieve",
    requireCurrent: true,
    trust: { liveness: "stale" },
    filters: { nodeIds: ["node:duct-a"] },
  });
  assert.equal(stale.guarded, true);
  assert.equal(stale.reason, "snapshot_not_current");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-incomplete",
    nodes: operationFixtureNodes(),
    partial: true,
    coverageStatus: "incomplete_budget",
  });
  for (const input of [
    {
      snapshotId: "snapshot:query-incomplete",
      mode: "retrieve",
      requireCurrent: true,
      trust: current,
      filters: { nodeIds: ["node:duct-a"] },
    },
    {
      snapshotId: "snapshot:query-incomplete",
      mode: "operation",
      requireCurrent: true,
      trust: current,
      operation: { name: "relation_between", sourceNodeId: "node:duct-a", targetNodeId: "node:pipe-b" },
    },
  ]) {
    const result = querySpatialContext(fixture.store, input);
    assert.equal(result.guarded, true, "No query mode may present an incomplete snapshot as deterministic evidence.");
    assert.equal(result.reason, "incomplete_snapshot");
    assert.equal(result.partial, true,
      "The public guard must not overwrite an incomplete snapshot with partial=false.");
    assert.equal(result.coverageStatus, "incomplete_budget",
      "The public guard must preserve the stored coverage status.");
  }

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-topology-incomplete",
    nodes: operationFixtureNodes({ topologyComplete: false }),
  });
  const topologyGuard = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-topology-incomplete",
    mode: "operation",
    requireCurrent: true,
    trust: current,
    operation: { name: "trace_connectivity", startNodeId: "node:duct-a", targetNodeId: "node:pipe-b" },
  });
  assert.equal(topologyGuard.guarded, true);
  assert.equal(topologyGuard.reason, "incomplete_topology_coverage");

  const topologyOwners = [
    makeElementNode({
      nodeId: "node:topology-owner-a",
      aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
    }),
    makeElementNode({
      nodeId: "node:topology-owner-b",
      aabb: { minMm: [200, 0, 0], maxMm: [300, 100, 100] },
    }),
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-topology-one-way",
    nodes: [
      ...topologyOwners,
      makeConnectorNode({
        nodeId: "connector:one-way-a",
        ownerNodeId: "node:topology-owner-a",
        connectedToNodeIds: ["connector:one-way-b"],
      }),
      makeConnectorNode({
        nodeId: "connector:one-way-b",
        ownerNodeId: "node:topology-owner-b",
        connectedToNodeIds: [],
      }),
    ],
  });
  const oneWayCapability = fixture.store.getSnapshotTopologyCapability("snapshot:query-topology-one-way");
  assert.equal(oneWayCapability.targetMembershipValidated, false,
    "One-way native adjacency is not a validated committed topology graph.");
  const oneWayTrace = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-topology-one-way",
    mode: "operation",
    operation: {
      name: "trace_connectivity",
      startNodeId: "node:topology-owner-a",
      targetNodeId: "node:topology-owner-b",
    },
  });
  assert.equal(oneWayTrace.guarded, true);
  assert.equal(oneWayTrace.reason, "incomplete_topology_coverage");

  const countMismatchConnector = makeConnectorNode({
    nodeId: "connector:count-a",
    ownerNodeId: "node:topology-owner-a",
    connectedToNodeIds: ["connector:count-b"],
  });
  countMismatchConnector.payload.topologyCoverage.referencedConnectorCount = 2;
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-topology-count-mismatch",
    nodes: [
      ...topologyOwners,
      countMismatchConnector,
      makeConnectorNode({
        nodeId: "connector:count-b",
        ownerNodeId: "node:topology-owner-b",
        connectedToNodeIds: ["connector:count-a"],
      }),
    ],
  });
  assert.equal(
    fixture.store.getSnapshotTopologyCapability("snapshot:query-topology-count-mismatch").targetMembershipValidated,
    false,
  );
  const countMismatchTrace = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-topology-count-mismatch",
    mode: "operation",
    operation: {
      name: "trace_connectivity",
      startNodeId: "node:topology-owner-a",
      targetNodeId: "node:topology-owner-b",
    },
  });
  assert.equal(countMismatchTrace.guarded, true);
  assert.equal(countMismatchTrace.reason, "incomplete_topology_coverage");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-topology-ambiguous",
    nodes: [
      ...topologyOwners,
      makeConnectorNode({
        nodeId: "connector:ambiguous",
        ownerNodeId: "node:topology-owner-a",
        connectedToNodeIds: [],
        ambiguousConnectorCount: 1,
      }),
    ],
  });
  const ambiguousCapability = fixture.store.getSnapshotTopologyCapability("snapshot:query-topology-ambiguous");
  assert.ok(ambiguousCapability.ambiguousConnectorCount > 0);
  assert.equal(ambiguousCapability.targetMembershipValidated, false);
  const ambiguousTrace = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-topology-ambiguous",
    mode: "operation",
    operation: { name: "trace_connectivity", startNodeId: "node:topology-owner-a" },
  });
  assert.equal(ambiguousTrace.guarded, true);
  assert.equal(ambiguousTrace.reason, "incomplete_topology_coverage");

  const denseOwners = ["node:dense-owner-a", "node:dense-owner-b"];
  const denseConnectors = [
    ...Array.from({ length: 7 }, (_, index) => makeConnectorNode({
      nodeId: `connector:dense-a-${index}`,
      ownerNodeId: denseOwners[0],
      point: [index, 0, 0],
    })),
    ...Array.from({ length: 5 }, (_, index) => makeConnectorNode({
      nodeId: `connector:dense-b-${index}`,
      ownerNodeId: denseOwners[1],
      point: [100 + index, 0, 0],
    })),
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-dense-edges",
    nodes: [
      makeElementNode({
        nodeId: denseOwners[0],
        aabb: { minMm: [0, 0, 0], maxMm: [10, 10, 10] },
      }),
      makeElementNode({
        nodeId: denseOwners[1],
        aabb: { minMm: [100, 0, 0], maxMm: [110, 10, 10] },
      }),
      ...denseConnectors,
    ],
  });
  const denseInput = {
    snapshotId: "snapshot:query-dense-edges",
    mode: "retrieve",
    filters: { nodeIds: denseOwners },
    includeEdges: true,
    relationTypes: ["owns_connector"],
    limit: 1,
    edgeLimit: 2,
  };
  const denseFirst = querySpatialContext(fixture.store, denseInput);
  assert.equal(denseFirst.guarded, false);
  assert.equal(denseFirst.nodes.length, 1);
  assert.equal(denseFirst.edges.length, 2);
  assert.ok(denseFirst.nextCursor);
  for (const changedLimit of [
    { limit: 2 },
    { edgeLimit: 3 },
  ]) {
    const mismatch = querySpatialContext(fixture.store, {
      ...denseInput,
      ...changedLimit,
      cursor: denseFirst.nextCursor,
    });
    assert.equal(mismatch.guarded, true);
    assert.equal(mismatch.reason, "invalid_cursor");
  }

  const denseNodeIds = denseFirst.nodes.map((node) => node.nodeId);
  const denseEdgeIds = denseFirst.edges.map((edge) => edge.edgeId);
  let denseCursor = denseFirst.nextCursor;
  let zeroNodeContinuationCount = 0;
  let continuationCount = 0;
  while (denseCursor) {
    continuationCount += 1;
    assert.ok(continuationCount < 20, "Dense edge pagination failed to make bounded cursor progress.");
    const pageResult = querySpatialContext(fixture.store, { ...denseInput, cursor: denseCursor });
    assert.equal(pageResult.guarded, false);
    if (pageResult.nodes.length === 0) zeroNodeContinuationCount += 1;
    denseNodeIds.push(...pageResult.nodes.map((node) => node.nodeId));
    denseEdgeIds.push(...pageResult.edges.map((edge) => edge.edgeId));
    denseCursor = pageResult.nextCursor;
  }
  assert.ok(zeroNodeContinuationCount > 0,
    "Edge overflow continuations must not repeat their owning node page.");
  assert.deepEqual(denseNodeIds, denseOwners);
  assert.equal(new Set(denseNodeIds).size, denseNodeIds.length);
  assert.equal(denseEdgeIds.length, 12);
  assert.equal(new Set(denseEdgeIds).size, denseEdgeIds.length,
    "Dense edge continuation must neither repeat nor skip stored edges.");

  const topologyOwner = (nodeId, x) => makeElementNode({
    nodeId,
    category: "Ducts",
    builtInCategory: "OST_DuctCurves",
    categoryRole: "mep_curve",
    systemKey: "Supply Air",
    aabb: { minMm: [x, 0, 0], maxMm: [x + 50, 50, 50] },
  });
  const topologyGraphNodes = [
    topologyOwner("node:graph-a", 0),
    topologyOwner("node:graph-b", 100),
    topologyOwner("node:graph-c", 200),
    topologyOwner("node:graph-f", 300),
    topologyOwner("node:graph-d", 400),
    topologyOwner("node:graph-e", 500),
    makeConnectorNode({
      nodeId: "connector:graph-a-out",
      ownerNodeId: "node:graph-a",
      connectedToNodeIds: ["connector:graph-b-in"],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-b-in",
      ownerNodeId: "node:graph-b",
      connectedToNodeIds: ["connector:graph-a-out"],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-b-out",
      ownerNodeId: "node:graph-b",
      connectedToNodeIds: ["connector:graph-c-in"],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-c-in",
      ownerNodeId: "node:graph-c",
      connectedToNodeIds: ["connector:graph-b-out"],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-b-branch",
      ownerNodeId: "node:graph-b",
      connectedToNodeIds: ["connector:graph-f-in"],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-f-in",
      ownerNodeId: "node:graph-f",
      connectedToNodeIds: ["connector:graph-b-branch"],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-c-out",
      ownerNodeId: "node:graph-c",
      connectedToNodeIds: ["connector:graph-a-in"],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-a-in",
      ownerNodeId: "node:graph-a",
      connectedToNodeIds: ["connector:graph-c-out"],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-d-disconnected",
      ownerNodeId: "node:graph-d",
      point: [1_000, 1_000, 1_000],
      systemKey: "Supply Air",
    }),
    makeConnectorNode({
      nodeId: "connector:graph-e-disconnected",
      ownerNodeId: "node:graph-e",
      point: [1_000, 1_000, 1_000],
      systemKey: "Supply Air",
    }),
  ];
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-topology-graph",
    nodes: topologyGraphNodes,
  });
  const graphOperation = (operationInput) => querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-topology-graph",
    mode: "operation",
    operation: operationInput,
  });
  const branch = graphOperation({
    name: "trace_connectivity",
    startNodeId: "node:graph-b",
    targetNodeId: "node:graph-f",
    maxDepth: 6,
  });
  assert.equal(branch.guarded, false);
  assert.equal(branch.computed.reachedTarget, true);
  assert.deepEqual(branch.computed.pathNodeIds, [
    "node:graph-b",
    "connector:graph-b-branch",
    "connector:graph-f-in",
    "node:graph-f",
  ], "Branch routing must preserve deterministic path order.");

  const cycle = graphOperation({
    name: "trace_connectivity",
    startNodeId: "node:graph-a",
    maxDepth: 20,
    maxNodes: 100,
  });
  assert.equal(cycle.guarded, false);
  assert.equal(cycle.computed.truncated, false);
  assert.equal(new Set(cycle.computed.visitedNodeIds).size, cycle.computed.visitedNodeIds.length);
  assert.equal(new Set(cycle.edges.map((edge) => edge.edgeId)).size, cycle.edges.length);
  for (const expectedOwner of ["node:graph-a", "node:graph-b", "node:graph-c", "node:graph-f"]) {
    assert.ok(cycle.computed.visitedNodeIds.includes(expectedOwner));
  }

  const coincidentDisconnected = graphOperation({
    name: "trace_connectivity",
    startNodeId: "node:graph-d",
    targetNodeId: "node:graph-e",
    maxDepth: 10,
  });
  assert.equal(coincidentDisconnected.guarded, false);
  assert.equal(coincidentDisconnected.computed.reachedTarget, false);
  assert.deepEqual(coincidentDisconnected.computed.pathNodeIds, []);
  assert.equal(coincidentDisconnected.edges.some((edge) => edge.relationType === "connected_to"), false,
    "Coincident connector origins must never fabricate native adjacency.");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-aabb-only-containment",
    nodes: [
      makeElementNode({
        nodeId: "node:aabb-only",
        aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
      }),
      operationFixtureNodes().find((node) => node.nodeId === "node:space"),
    ],
  });
  const aabbOnlyContainment = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-aabb-only-containment",
    mode: "operation",
    requireCurrent: true,
    trust: current,
    operation: {
      name: "locate_in_space",
      nodeId: "node:aabb-only",
      spaceNodeIds: ["node:space"],
    },
  });
  assert.equal(aabbOnlyContainment.guarded, true,
    "An AABB center must never be invented as containment evidence.");
  assert.equal(aabbOnlyContainment.reason, "unsupported_geometry");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-missing-geometry",
    nodes: [
      makeElementNode({ nodeId: "node:no-geometry-a", aabb: null }),
      makeElementNode({ nodeId: "node:no-geometry-b", aabb: null }),
    ],
  });
  const missingGeometry = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-missing-geometry",
    mode: "operation",
    requireCurrent: true,
    trust: current,
    operation: {
      name: "clearance_between",
      sourceNodeId: "node:no-geometry-a",
      targetNodeId: "node:no-geometry-b",
    },
  });
  assert.equal(missingGeometry.guarded, true);
  assert.equal(missingGeometry.reason, "node_not_found_or_geometry_unsupported");

  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:query-v02",
    schemaVersion: "0.2",
    nodes: operationFixtureNodes(),
  });
  const legacyRelation = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-v02",
    mode: "operation",
    operation: { name: "above_below", sourceNodeId: "node:above", targetNodeId: "node:duct-a" },
  });
  assert.equal(legacyRelation.guarded, false);
  assert.equal(legacyRelation.capabilityCoverage.adapter, "legacy_v02");
  assert.equal(legacyRelation.capabilityCoverage.topology, false);
  assert.ok(legacyRelation.warnings.length > 0);

  const legacyMetadataScan = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-v02",
    mode: "retrieve",
    filters: { categories: ["Ducts"] },
  });
  assert.equal(legacyMetadataScan.guarded, true);
  assert.equal(legacyMetadataScan.reason, "unsupported_snapshot_capability");

  const legacyExplicit = querySpatialContext(fixture.store, {
    snapshotId: "snapshot:query-v02",
    mode: "retrieve",
    filters: { nodeIds: ["node:duct-a"], categories: ["Ducts"] },
  });
  assert.equal(legacyExplicit.guarded, false);
  assert.deepEqual(legacyExplicit.nodes.map((node) => node.nodeId), ["node:duct-a"]);

  for (const unsupportedOperation of [
    { name: "trace_connectivity", startNodeId: "node:duct-a" },
    { name: "clearance_between", sourceNodeId: "node:duct-a", targetNodeId: "node:pipe-b" },
  ]) {
    const result = querySpatialContext(fixture.store, {
      snapshotId: "snapshot:query-v02",
      mode: "operation",
      operation: unsupportedOperation,
    });
    assert.equal(result.guarded, true);
    assert.equal(result.reason, "unsupported_snapshot_capability");
  }
} finally {
  fixture.cleanup();
}

console.log("spatial Phase 1b query integration tests: ok");
