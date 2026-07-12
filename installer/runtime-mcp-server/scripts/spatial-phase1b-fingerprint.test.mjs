import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareSpatialSnapshots } from "../build/spatial/spatialDiff.js";
import { canonicalJson, sha256Canonical } from "../build/spatial/spatialCanonical.js";
import {
  derivedPlacementFingerprint,
  derivedPropertyFingerprint,
  derivedShapeFingerprint,
  derivedTopologyFingerprint,
} from "../build/spatial/spatialGeometry.js";
import {
  createTestStore,
  makeConnectorNode,
  makeElementNode,
  seedSnapshot,
} from "./spatial-phase1b-test-helpers.mjs";

assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
assert.equal(canonicalJson(-0), "0");
assert.equal(sha256Canonical({ b: [2, 1], a: 0 }), sha256Canonical({ a: -0, b: [2, 1] }));
assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/i);
assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), /non-finite/i);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.REVIT_MCP_REPO_ROOT
  ? path.resolve(process.env.REVIT_MCP_REPO_ROOT)
  : path.resolve(__dirname, "..", "..", "..");
const nativeHelpers = fs.readFileSync(path.join(
  repoRoot,
  "src",
  "revit-plugin",
  "revAgentCommandSet",
  "Commands",
  "Spatial",
  "SpatialSnapshotHelpers.cs",
), "utf8");
const nativeShapeBasis = nativeHelpers.slice(
  nativeHelpers.indexOf("private static Dictionary<string, object> BuildShapeFingerprintBasis"),
  nativeHelpers.indexOf("private static Dictionary<string, object> BuildPlacementFingerprintBasis"),
);
assert.match(nativeShapeBasis, /shapeSupport.*aabb_only_not_rotation_invariant/s);
assert.doesNotMatch(nativeShapeBasis, /aabbSizeMm/,
  "AABB-only native shape identity must not turn rigid rotation/extents swap into a resize.");

function derivedOnly(node) {
  return {
    ...node,
    geometryFingerprint: null,
    placementFingerprint: null,
    shapeFingerprint: null,
    propertyFingerprint: null,
    topologyFingerprint: null,
  };
}

function reverseObject(value) {
  if (Array.isArray(value)) return value.map(reverseObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse()
    .map(([key, child]) => [key, reverseObject(child)]));
}

const fixture = createTestStore("fingerprint");
try {
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:fingerprint",
    nodes: [
      makeElementNode({
        nodeId: "node:fingerprint",
        category: "Ducts",
        builtInCategory: "OST_DuctCurves",
        categoryRole: "mep_curve",
        systemKey: "Supply Air",
        name: "Duct A",
        familyName: "Rectangular Duct",
        typeName: "400x200",
        aabb: { minMm: [-50, -100, -100], maxMm: [50, 100, 100] },
        profile: {
          shape: "rectangular",
          diameterMm: null,
          widthMm: 200,
          heightMm: 200,
          insulationThicknessMm: 0,
        },
      }),
      makeElementNode({
        nodeId: "node:connector-owner-fp",
        aabb: { minMm: [500, 0, 0], maxMm: [600, 100, 100] },
      }),
      makeConnectorNode({
        nodeId: "connector:fingerprint",
        ownerNodeId: "node:connector-owner-fp",
        connectedToNodeIds: ["connector:peer-a", "connector:peer-b"],
      }),
      makeConnectorNode({
        nodeId: "connector:peer-a",
        ownerNodeId: "node:connector-owner-fp",
        connectedToNodeIds: ["connector:fingerprint"],
        point: [10, 0, 0],
      }),
      makeConnectorNode({
        nodeId: "connector:peer-b",
        ownerNodeId: "node:connector-owner-fp",
        connectedToNodeIds: ["connector:fingerprint"],
        point: [20, 0, 0],
      }),
    ],
  });

  const original = derivedOnly(fixture.store.getStoredNode("snapshot:fingerprint", "node:fingerprint"));
  const reordered = { ...original, payload: reverseObject(original.payload) };
  assert.equal(derivedPlacementFingerprint(reordered), derivedPlacementFingerprint(original));
  assert.equal(derivedShapeFingerprint(reordered), derivedShapeFingerprint(original));
  assert.equal(derivedPropertyFingerprint(reordered), derivedPropertyFingerprint(original));

  const moved = {
    ...original,
    aabb: { minMm: [950, -100, -100], maxMm: [1_050, 100, 100] },
  };
  assert.notEqual(derivedPlacementFingerprint(moved), derivedPlacementFingerprint(original));
  assert.equal(derivedShapeFingerprint(moved), derivedShapeFingerprint(original),
    "Translation must change placement without changing shape.");

  const resized = {
    ...original,
    aabb: { minMm: [-100, -200, -100], maxMm: [100, 200, 100] },
  };
  assert.equal(derivedPlacementFingerprint(resized), derivedPlacementFingerprint(original),
    "Symmetric resize must preserve the placement anchor.");
  assert.notEqual(derivedShapeFingerprint(resized), derivedShapeFingerprint(original));

  const propertyChanged = {
    ...original,
    systemKey: "Return Air",
    payload: {
      ...original.payload,
      spatialProperties: {
        ...original.payload.spatialProperties,
        systemKey: "Return Air",
      },
    },
  };
  assert.equal(derivedPlacementFingerprint(propertyChanged), derivedPlacementFingerprint(original));
  assert.equal(derivedShapeFingerprint(propertyChanged), derivedShapeFingerprint(original));
  assert.notEqual(derivedPropertyFingerprint(propertyChanged), derivedPropertyFingerprint(original));

  const connector = derivedOnly(fixture.store.getStoredNode("snapshot:fingerprint", "connector:fingerprint"));
  const reorderedPeers = {
    ...connector,
    payload: {
      ...connector.payload,
      connectedToNodeIds: ["connector:peer-b", "connector:peer-a", "connector:peer-a"],
    },
  };
  assert.equal(derivedTopologyFingerprint(reorderedPeers), derivedTopologyFingerprint(connector),
    "Topology fingerprints must be invariant to peer order and duplicates.");
  const rewired = {
    ...connector,
    payload: { ...connector.payload, connectedToNodeIds: ["connector:peer-a"] },
  };
  assert.notEqual(derivedTopologyFingerprint(rewired), derivedTopologyFingerprint(connector));

  const sha = (character) => `sha256:${character.repeat(64)}`;
  const commonFingerprints = {
    version: "phase1b-spatial-fingerprint/1.0",
    shape: sha("a"),
    property: sha("b"),
    topology: sha("c"),
  };
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:fingerprint-rotation-base",
    nodes: [makeElementNode({
      nodeId: "node:aabb-only-rotated",
      aabb: { minMm: [-100, -50, 0], maxMm: [100, 50, 100] },
      fingerprints: { ...commonFingerprints, placement: sha("d") },
    })],
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:fingerprint-rotation-head",
    nodes: [makeElementNode({
      nodeId: "node:aabb-only-rotated",
      aabb: { minMm: [-50, -100, 0], maxMm: [50, 100, 100] },
      fingerprints: { ...commonFingerprints, placement: sha("e") },
    })],
  });
  const rotationDiff = compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:fingerprint-rotation-base",
    headSnapshotId: "snapshot:fingerprint-rotation-head",
  });
  assert.equal(rotationDiff.guarded, false);
  assert.deepEqual(rotationDiff.moved.map((change) => change.nodeId), ["node:aabb-only-rotated"]);
  assert.deepEqual(rotationDiff.geometryChanges, [],
    "Native AABB-only extents swap under rigid rotation must not be classified as resize.");
  assert.deepEqual(rotationDiff.geometryIndeterminate.map((change) => ({
    nodeId: change.nodeId,
    changedFields: change.changedFields,
  })), [{
    nodeId: "node:aabb-only-rotated",
    changedFields: ["aabb_or_geometry_fingerprint"],
  }], "AABB-only rotation/resize ambiguity must remain explicit instead of disappearing.");
  assert.equal(rotationDiff.capabilityCoverage.full, false);
  assert.deepEqual(rotationDiff.capabilityCoverage.geometryChanges, {
    classification: "capability_limited",
    baseAabbOnlyNodeCount: 1,
    headAabbOnlyNodeCount: 1,
    indeterminateChangeCount: 1,
  });
  assert.equal(rotationDiff.counts.geometryIndeterminateCount, 1);
  assert.equal(rotationDiff.counts.observedGeometryIndeterminateCount, 1);
  assert.ok(rotationDiff.warnings.includes("aabb_only_shape_change_not_classified_without_rotation_invariant_primitive"));
  assert.ok(rotationDiff.warnings.includes("aabb_only_geometry_change_classification_is_capability_limited"));
} finally {
  fixture.cleanup();
}

console.log("spatial Phase 1b canonical fingerprint tests: ok");
