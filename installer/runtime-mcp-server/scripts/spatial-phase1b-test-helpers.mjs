import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpatialStore } from "../build/spatial/spatialStore.js";

export const TEST_NOW_MS = Date.parse("2026-07-12T09:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function fingerprint(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function aabbCenter(aabb) {
  return aabb
    ? aabb.minMm.map((minimum, axis) => (minimum + aabb.maxMm[axis]) / 2)
    : null;
}

export function identityTransform(translation = [0, 0, 0]) {
  return {
    representation: "affine_4x4_row_major",
    fromFrame: "source_internal",
    toFrame: "host_internal_mm",
    lengthUnit: "mm",
    matrix: [
      1, 0, 0, translation[0],
      0, 1, 0, translation[1],
      0, 0, 1, translation[2],
      0, 0, 0, 1,
    ],
  };
}

export function sourceRevision(documentKey, {
  sequence = 1,
  loadedVersion = `loaded:${documentKey}:1`,
  translation = [0, 0, 0],
  linkInstanceUniqueId = null,
  documentSessionId = `session:${documentKey}`,
  crossSessionComparable = true,
} = {}) {
  return {
    documentKey,
    documentSessionId,
    trackerSessionId: `tracker:${documentKey}`,
    loadedVersion,
    changeSequence: sequence,
    changeSequenceState: "tracked",
    oldestRetainedSequence: 0,
    journalEntryCount: sequence,
    journalCapacity: 512,
    journalTruncated: false,
    linkInstanceUniqueId,
    sourceToHostTransform: identityTransform(translation),
    documentKeyResolution: {
      resolverVersion: "phase1b-test/1",
      basis: "synthetic_local_fixture",
      crossSessionComparable,
    },
  };
}

export function createTestStore(label = "fixture") {
  const root = mkdtempSync(join(tmpdir(), `revagent-spatial-phase1b-${label}-`));
  const databasePath = join(root, "spatial.db");
  const store = new SpatialStore({
    databasePath,
    now: () => TEST_NOW_MS,
    retentionPolicy: false,
    cleanupExpiredStagingOnOpen: false,
  });
  return {
    root,
    databasePath,
    store,
    cleanup() {
      try {
        store.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

export function makeElementNode({
  nodeId,
  documentKey = "fixture:host",
  nodeKind = "revit_element",
  aabb = null,
  category = "Generic Models",
  builtInCategory = "OST_GenericModel",
  categoryRole = "mep_element",
  levelUniqueId = "level:01",
  levelName = "Level 01",
  systemKey = null,
  centerline = null,
  point = null,
  boundaryLoops = null,
  profile = null,
  name = null,
  familyName = null,
  typeName = null,
  fingerprints = null,
  extraPayload = {},
}) {
  const normalizedProfile = profile ?? {
    shape: "unknown",
    diameterMm: null,
    widthMm: null,
    heightMm: null,
    insulationThicknessMm: 0,
  };
  const spatialProperties = {
    systemKey,
    systemName: null,
    systemClassification: null,
  };
  const geometry = {
    basis: aabb ? "stored_geometry" : "unsupported",
    precisionClass: centerline || point || boundaryLoops ? "analytic" : (aabb ? "aabb_only" : "unsupported"),
    ...(aabb ? { aabb: { min: aabb.minMm, max: aabb.maxMm } } : {}),
    ...(centerline ? { centerline: { curveType: "line", points: centerline } } : {}),
    ...(point ? { pointLocation: { point } } : {}),
    ...(boundaryLoops ? { boundaryLoops } : {}),
  };
  const automaticFingerprints = {
    version: "phase1b-spatial-fingerprint/1.0",
    placement: fingerprint({ anchor: point ?? centerline?.[0] ?? aabbCenter(aabb) }),
    shape: fingerprint({
      extents: aabb ? aabb.minMm.map((minimum, axis) => aabb.maxMm[axis] - minimum) : null,
      profile: normalizedProfile,
      centerlineVectors: centerline?.slice(1).map((candidate, index) => candidate
        .map((coordinate, axis) => coordinate - centerline[index][axis])) ?? [],
      boundaryLoopSizes: boundaryLoops?.map((loop) => loop.length) ?? [],
    }),
    property: fingerprint({
      category,
      builtInCategory,
      categoryRole,
      levelUniqueId,
      levelName,
      spatialProperties,
      name,
      familyName,
      typeName,
    }),
    topology: fingerprint({ ownerNodeId: null, connectedToNodeIds: [] }),
  };
  return {
    nodeId,
    documentKey,
    nodeKind,
    elementUniqueId: `element:${nodeId}`,
    aabb,
    payload: {
      category,
      builtInCategory,
      categoryRole,
      levelRef: {
        sourceLevelUniqueId: levelUniqueId,
        sourceLevelName: levelName,
      },
      spatialProperties,
      ...(name ? { name } : {}),
      ...(familyName ? { familyName } : {}),
      ...(typeName ? { typeName } : {}),
      geometry,
      profile: normalizedProfile,
      fingerprints: fingerprints ?? automaticFingerprints,
      ...extraPayload,
    },
  };
}

export function makeConnectorNode({
  nodeId,
  ownerNodeId,
  connectedToNodeIds = [],
  documentKey = "fixture:host",
  point = [0, 0, 0],
  aabb = null,
  systemKey = null,
  readComplete = true,
  ambiguousConnectorCount = 0,
  unresolvedPeerReferenceCount = 0,
  fingerprints = null,
}) {
  const connectorAabb = aabb ?? {
    minMm: [point[0] - 1, point[1] - 1, point[2] - 1],
    maxMm: [point[0] + 1, point[1] + 1, point[2] + 1],
  };
  const normalizedProfile = {
    shape: "unknown",
    diameterMm: null,
    widthMm: null,
    heightMm: null,
    insulationThicknessMm: 0,
  };
  const automaticFingerprints = {
    version: "phase1b-spatial-fingerprint/1.0",
    placement: fingerprint({ anchor: point }),
    shape: fingerprint({
      extents: connectorAabb.minMm.map((minimum, axis) => connectorAabb.maxMm[axis] - minimum),
      profile: normalizedProfile,
    }),
    property: fingerprint({ systemKey }),
    topology: fingerprint({ ownerNodeId, connectedToNodeIds: [...connectedToNodeIds].sort() }),
  };
  const reasons = [
    ...(!readComplete ? ["all_refs_unread"] : []),
    ...(ambiguousConnectorCount > 0 ? ["ambiguous_peer_reference"] : []),
    ...(unresolvedPeerReferenceCount > 0 ? ["unresolved_peer_reference"] : []),
  ];
  return {
    nodeId,
    documentKey,
    nodeKind: "connector",
    aabb: connectorAabb,
    payload: {
      ownerNodeId,
      connectedToNodeIds,
      connectedOwnerNodeIds: [],
      connectionRefs: connectedToNodeIds.map((targetConnectorNodeId) => ({
        targetOwnerNodeId: null,
        targetConnectorNodeId,
        relationKind: "physical",
        basis: "revit_connector_all_refs",
        resolved: true,
      })),
      isConnected: connectedToNodeIds.length > 0,
      topologyCoverage: {
        basis: "revit_connector_all_refs",
        complete: readComplete && ambiguousConnectorCount === 0 && unresolvedPeerReferenceCount === 0,
        targetMembershipValidated: false,
        isConnectedRead: true,
        allRefsRead: readComplete,
        referencedConnectorCount: connectedToNodeIds.length + unresolvedPeerReferenceCount,
        resolvedConnectorNodeCount: connectedToNodeIds.length,
        unresolvedConnectorCount: unresolvedPeerReferenceCount,
        reasons,
      },
      spatialProperties: {
        systemKey,
        systemName: null,
        systemClassification: null,
      },
      profile: normalizedProfile,
      geometry: {
        basis: "connector_origin",
        precisionClass: "measured",
        pointLocation: { point },
      },
      fingerprints: fingerprints ?? automaticFingerprints,
    },
  };
}

function nodeKindCounts(nodes) {
  const counts = { revit_element: 0, connector: 0, derived: 0 };
  for (const node of nodes) counts[node.nodeKind] = (counts[node.nodeKind] ?? 0) + 1;
  return counts;
}

export function seedSnapshot(store, {
  snapshotId,
  nodes,
  schemaVersion = "0.3",
  documentKey = "fixture:host",
  scopeFingerprint = "scope:phase1b:level-01",
  revisionFingerprint = `revision:${snapshotId}`,
  capturedAtMs = TEST_NOW_MS - 10_000,
  partial = false,
  coverageStatus = partial ? "incomplete_omissions" : "complete",
  omissions = [],
  sources = [sourceRevision(documentKey)],
  coordinateFrame = "host_internal_mm",
  captureMetadata = {},
}) {
  const captureId = `capture:${snapshotId}`;
  const countsByKind = nodeKindCounts(nodes);
  const payloadBytes = Buffer.byteLength(JSON.stringify({ nodes, omissions }), "utf8");
  store.beginCapture({
    captureId,
    snapshotId,
    documentKey,
    scopeFingerprint,
    revisionFingerprint,
    schemaVersion,
    extractorVersion: "phase1b-test/1",
    scope: {
      documentKey,
      coordinateFrame,
      lengthUnit: "mm",
      requestedLevelUniqueIds: ["level:01"],
    },
    counts: { expectedSupportedNodes: nodes.length },
    effectiveSourcePolicy: { includeHost: true, includeLinks: false },
    coverage: { complete: !partial },
    transformValidation: { maxRoundTripErrorMm: 0 },
    captureMetadata: { atomic: true, fixture: true, coordinateFrame, ...captureMetadata },
    capturedAtMs,
    expiresAtMs: TEST_NOW_MS + DAY_MS,
  });
  store.stagePage({
    captureId,
    ordinal: 0,
    priorPageHash: null,
    pageHash: `hash:${snapshotId}:0`,
    hasMore: false,
    payloadBytes,
    nodes,
    omissions,
  });
  return store.commitCapture({
    captureId,
    sourceRevisions: sources,
    counts: {
      totalNodes: nodes.length,
      nodesByKind: countsByKind,
      expectedSupportedNodes: nodes.length + omissions.length,
      extractedSupportedNodes: nodes.length,
      omittedSupportedNodes: omissions.length,
      omissionsByReason: Object.fromEntries(
        [...new Set(omissions.map((item) => item.reason))]
          .map((reason) => [reason, omissions.filter((item) => item.reason === reason).length]),
      ),
    },
    coverage: {
      totalOrderedRowCount: nodes.length + omissions.length,
      sourceAvailabilityOmissionCount: 0,
      complete: !partial,
    },
    expectedPageCount: 1,
    expectedPayloadBytes: payloadBytes,
    expectedNodeCount: nodes.length,
    expectedOmissionCount: omissions.length,
    expectedNodesByKind: countsByKind,
    partial,
    coverageStatus,
    scanStoppedReason: partial ? "read_failed" : "completed",
    suggestedNextScopes: partial ? ["exact_source"] : [],
  });
}

export function operationFixtureNodes({ topologyComplete = true } = {}) {
  const level = { levelUniqueId: "level:01", levelName: "Level 01" };
  return [
    makeElementNode({
      nodeId: "node:duct-a",
      ...level,
      category: "Ducts",
      builtInCategory: "OST_DuctCurves",
      categoryRole: "mep_curve",
      systemKey: "Supply Air",
      aabb: { minMm: [-50, -50, -50], maxMm: [1_050, 50, 50] },
      centerline: [[0, 0, 0], [1_000, 0, 0]],
      profile: { shape: "round", diameterMm: 100, insulationThicknessMm: 0 },
    }),
    makeElementNode({
      nodeId: "node:pipe-b",
      ...level,
      category: "Pipes",
      builtInCategory: "OST_PipeCurves",
      categoryRole: "mep_curve",
      systemKey: "Supply Air",
      aabb: { minMm: [-50, 250, -50], maxMm: [1_050, 350, 50] },
      centerline: [[0, 300, 0], [1_000, 300, 0]],
      profile: { shape: "round", diameterMm: 100, insulationThicknessMm: 0 },
    }),
    makeElementNode({
      nodeId: "node:rect-c",
      ...level,
      category: "Ducts",
      builtInCategory: "OST_DuctCurves",
      categoryRole: "mep_curve",
      systemKey: "Return Air",
      aabb: { minMm: [0, 500, -100], maxMm: [1_000, 700, 100] },
      centerline: [[0, 600, 0], [1_000, 600, 0]],
      profile: { shape: "rectangular", widthMm: 200, heightMm: 200, insulationThicknessMm: 0 },
    }),
    makeElementNode({
      nodeId: "node:above",
      ...level,
      category: "Mechanical Equipment",
      builtInCategory: "OST_MechanicalEquipment",
      categoryRole: "equipment",
      aabb: { minMm: [0, 0, 500], maxMm: [100, 100, 600] },
      point: [50, 50, 550],
    }),
    makeElementNode({
      nodeId: "node:space",
      ...level,
      category: "Spaces",
      builtInCategory: "OST_MEPSpaces",
      categoryRole: "spatial",
      aabb: { minMm: [-500, -500, -200], maxMm: [2_000, 1_000, 1_000] },
      boundaryLoops: [[
        [-500, -500, 0], [2_000, -500, 0], [2_000, 1_000, 0], [-500, 1_000, 0],
      ]],
    }),
    makeConnectorNode({
      nodeId: "connector:a",
      ownerNodeId: "node:duct-a",
      connectedToNodeIds: ["connector:b"],
      point: [1_000, 0, 0],
      systemKey: "Supply Air",
      readComplete: topologyComplete,
    }),
    makeConnectorNode({
      nodeId: "connector:b",
      ownerNodeId: "node:pipe-b",
      connectedToNodeIds: ["connector:a"],
      point: [1_000, 300, 0],
      systemKey: "Supply Air",
      readComplete: topologyComplete,
    }),
  ];
}

export function diffFixtureNodes(revision) {
  const base = revision === "base";
  const topologyPeers = base
    ? { a: ["connector:diff-b"], b: ["connector:diff-a"], c: [] }
    : { a: ["connector:diff-c"], b: [], c: ["connector:diff-a"] };
  return [
    makeElementNode({
      nodeId: "node:fixed-neighbor",
      aabb: { minMm: [250, 2_000, 0], maxMm: [350, 2_100, 100] },
    }),
    makeElementNode({
      nodeId: "node:moved",
      aabb: base
        ? { minMm: [0, 2_000, 0], maxMm: [100, 2_100, 100] }
        : { minMm: [3_000, 2_000, 0], maxMm: [3_100, 2_100, 100] },
    }),
    makeElementNode({
      nodeId: "node:resized",
      aabb: base
        ? { minMm: [4_950, 4_950, -50], maxMm: [5_050, 5_050, 50] }
        : { minMm: [4_900, 4_900, -100], maxMm: [5_100, 5_100, 100] },
    }),
    makeElementNode({
      nodeId: "node:property",
      systemKey: base ? "Supply Air" : "Return Air",
      aabb: { minMm: [7_000, 0, 0], maxMm: [7_100, 100, 100] },
    }),
    ...(base ? [makeElementNode({
      nodeId: "node:removed",
      aabb: { minMm: [8_000, 0, 0], maxMm: [8_100, 100, 100] },
    })] : [makeElementNode({
      nodeId: "node:added",
      aabb: { minMm: [9_000, 0, 0], maxMm: [9_100, 100, 100] },
    })]),
    makeElementNode({
      nodeId: "node:connector-owner",
      aabb: { minMm: [10_000, 0, 0], maxMm: [10_100, 100, 100] },
    }),
    makeConnectorNode({
      nodeId: "connector:diff-a",
      ownerNodeId: "node:connector-owner",
      connectedToNodeIds: topologyPeers.a,
      point: base ? [10_000, 0, 0] : [10_010, 0, 0],
    }),
    makeConnectorNode({
      nodeId: "connector:diff-b",
      ownerNodeId: "node:connector-owner",
      connectedToNodeIds: topologyPeers.b,
      point: [10_100, 0, 0],
    }),
    makeConnectorNode({
      nodeId: "connector:diff-c",
      ownerNodeId: "node:connector-owner",
      connectedToNodeIds: topologyPeers.c,
      point: [10_200, 0, 0],
    }),
  ];
}

export function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
}

export function normalizePhase1bResult(value) {
  const ignoredKeys = new Set(["queryId", "reportId", "summaryId", "elapsedMs", "evaluatedAt"]);
  const recurse = (item, key = "") => {
    if (typeof item === "number") return Number(item.toFixed(6));
    if (Array.isArray(item)) {
      const normalized = item.map((entry) => recurse(entry));
      if (["warnings", "notices", "suggestedNextScopes", "evidenceNodeIds"].includes(key)) {
        return normalized.sort((left, right) => String(left).localeCompare(String(right)));
      }
      if (key === "nodes") {
        return normalized.sort((left, right) => String(left.nodeId).localeCompare(String(right.nodeId)));
      }
      if (key === "edges") {
        return normalized.sort((left, right) => String(left.relationType).localeCompare(String(right.relationType))
          || String(left.sourceNodeId).localeCompare(String(right.sourceNodeId))
          || String(left.targetNodeId).localeCompare(String(right.targetNodeId))
          || String(left.edgeId).localeCompare(String(right.edgeId)));
      }
      if (key === "levels") {
        return normalized.sort((left, right) => String(left.levelKey).localeCompare(String(right.levelKey)));
      }
      return normalized;
    }
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item)
        .filter((childKey) => !ignoredKeys.has(childKey))
        .sort()
        .map((childKey) => [childKey, recurse(item[childKey], childKey)]));
    }
    return item;
  };
  return recurse(value);
}
