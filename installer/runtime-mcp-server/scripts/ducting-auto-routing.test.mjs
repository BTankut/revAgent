import assert from "node:assert/strict";

import { mapSpatialZoneToRoutingContext, planDuctingAutoRoute, validateRoutePreview } from "../build/engineering/ducting/index.js";

const clear = planDuctingAutoRoute({
  sources: [{ id: "shaft-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(clear.summary.status, "pass");
assert.equal(clear.routeCandidates.length, 1);
assert.equal(clear.routeCandidates[0].lengthMm, 6000);
assert.equal(clear.routeCandidates[0].elbowCount, 0);

const detour = planDuctingAutoRoute({
  sources: [{ id: "shaft-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  obstacles: [
    {
      id: "beam-1",
      aabbMm: { minX: 2500, minY: -500, minZ: 2500, maxX: 3500, maxY: 500, maxZ: 3500 },
    },
  ],
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(detour.summary.status, "pass");
assert.equal(detour.routeCandidates.length, 1);
assert.equal(detour.routeCandidates[0].obstacleIntersections.length, 0);
assert.equal(detour.routeCandidates[0].lengthMm > 6000, true);
assert.equal(detour.routeCandidates[0].elbowCount >= 2, true);
assert.equal(validateRoutePreview(detour.routeCandidates).status, "pass");
assert.deepEqual(
  detour.routeCandidates[0].pointsMm.some((point) => Math.abs(point.y) > 500),
  true,
);

const boundedBlocked = planDuctingAutoRoute({
  sources: [{ id: "shaft-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  obstacles: [
    {
      id: "beam-1",
      aabbMm: { minX: 2500, minY: -500, minZ: 2500, maxX: 3500, maxY: 500, maxZ: 3500 },
    },
  ],
  routingBounds: { minX: 0, minY: -500, minZ: 2500, maxX: 6000, maxY: 500, maxZ: 3500 },
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(boundedBlocked.summary.status, "fail");
assert.equal(boundedBlocked.routeCandidates.length, 0);
assert.equal(boundedBlocked.issues.some((issue) => issue.code === "route_not_found"), true);

const multiSource = planDuctingAutoRoute({
  sources: [
    { id: "shaft-far", pointMm: { x: 0, y: 0, z: 3000 } },
    { id: "shaft-near", pointMm: { x: 5000, y: 0, z: 3000 } },
  ],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  gridStepMm: 1000,
});

assert.equal(multiSource.summary.status, "pass");
assert.equal(multiSource.routeCandidates[0].sourceId, "shaft-near");
assert.equal(multiSource.routeCandidates[0].lengthMm, 1000);

const blockedStart = planDuctingAutoRoute({
  sources: [{ id: "shaft-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  obstacles: [
    {
      id: "blocked-shaft",
      aabbMm: { minX: -100, minY: -100, minZ: 2500, maxX: 100, maxY: 100, maxZ: 3500 },
    },
  ],
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(blockedStart.summary.status, "fail");
assert.equal(blockedStart.routeCandidates.length, 0);
assert.equal(blockedStart.issues.some((issue) => issue.code === "route_not_found"), true);

// --- 3D pathfinding tests (Sprint 1: multi-elevation + vertical risers) ---

const multiLevel = planDuctingAutoRoute({
  sources: [{ id: "ahu-1", pointMm: { x: 0, y: 0, z: 6000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  allowedElevationsMm: [3000, 6000],
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(multiLevel.summary.status, "pass", "multi-level should succeed");
assert.equal(multiLevel.routeCandidates.length, 1);
assert.equal(multiLevel.routeCandidates[0].verticalRunCount >= 1, true, "should have at least one vertical run");
assert.equal(multiLevel.routeCandidates[0].verticalRunLengthMm, 3000, "vertical run should be exactly 3000 mm");
assert.equal(multiLevel.summary.totalVerticalRunCount >= 1, true);
assert.equal(multiLevel.summary.totalVerticalRunLengthMm, 3000);
assert.deepEqual(multiLevel.summary.allowedElevationsMm, [3000, 6000]);

const riserPenaltyOff = planDuctingAutoRoute({
  sources: [
    { id: "ahu-top", pointMm: { x: 0, y: 0, z: 6000 } },
    { id: "ahu-low", pointMm: { x: 8000, y: 0, z: 3000 } },
  ],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  allowedElevationsMm: [3000, 6000],
  gridStepMm: 1000,
  riserPenalty: 0,
});
const riserPenaltyOn = planDuctingAutoRoute({
  sources: [
    { id: "ahu-top", pointMm: { x: 0, y: 0, z: 6000 } },
    { id: "ahu-low", pointMm: { x: 8000, y: 0, z: 3000 } },
  ],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  allowedElevationsMm: [3000, 6000],
  gridStepMm: 1000,
  riserPenalty: 100000,
});

assert.equal(riserPenaltyOff.summary.status, "pass");
assert.equal(riserPenaltyOn.summary.status, "pass");
assert.equal(
  riserPenaltyOn.routeCandidates[0].verticalRunCount <= riserPenaltyOff.routeCandidates[0].verticalRunCount,
  true,
  "high riser penalty should not increase vertical run count",
);
assert.equal(
  riserPenaltyOn.routeCandidates[0].sourceId,
  "ahu-low",
  "high riser penalty should pick the same-elevation source over the riser route",
);

// A continuous slab between source and target with tight horizontal bounds blocks every riser.
const blockingSlab = planDuctingAutoRoute({
  sources: [{ id: "ahu-roof", pointMm: { x: 0, y: 0, z: 9000 } }],
  targets: [{ id: "vav-floor", pointMm: { x: 6000, y: 0, z: 3000 } }],
  allowedElevationsMm: [3000, 6000, 9000],
  routingBounds: { minX: -100, minY: -100, minZ: 2900, maxX: 6100, maxY: 100, maxZ: 9100 },
  obstacles: [
    {
      id: "slab-solid",
      aabbMm: { minX: -200, minY: -200, minZ: 5900, maxX: 6200, maxY: 200, maxZ: 6100 },
    },
  ],
  gridStepMm: 1000,
  clearanceMm: 0,
  ductHalfHeightMm: 0,
});

assert.equal(blockingSlab.summary.status, "fail", "a continuous slab with tight bounds must block the route");
assert.equal(blockingSlab.issues.some((issue) => issue.code === "route_not_found"), true);

// Two slab pieces with a shaft opening between them let the route drop through the gap.
const shaftRoute = planDuctingAutoRoute({
  sources: [{ id: "ahu-roof", pointMm: { x: 0, y: 0, z: 9000 } }],
  targets: [{ id: "vav-floor", pointMm: { x: 9000, y: 0, z: 3000 } }],
  allowedElevationsMm: [3000, 6000, 9000],
  routingBounds: { minX: -100, minY: -100, minZ: 2900, maxX: 9100, maxY: 100, maxZ: 9100 },
  obstacles: [
    { id: "slab-left", aabbMm: { minX: -200, minY: -200, minZ: 5900, maxX: 3500, maxY: 200, maxZ: 6100 } },
    { id: "slab-right", aabbMm: { minX: 5500, minY: -200, minZ: 5900, maxX: 9200, maxY: 200, maxZ: 6100 } },
  ],
  gridStepMm: 1000,
  clearanceMm: 0,
  ductHalfHeightMm: 0,
});

assert.equal(shaftRoute.summary.status, "pass", "shaft opening between the slab pieces must yield a route");
assert.equal(shaftRoute.routeCandidates[0].verticalRunCount >= 1, true, "route through the shaft must traverse multiple elevations");
assert.equal(shaftRoute.routeCandidates[0].obstacleIntersections.length, 0);
assert.equal(
  shaftRoute.routeCandidates[0].pointsMm.some((point) => point.x > 3500 && point.x < 5500 && point.z === 6000),
  true,
  "route must cross z=6000 inside the shaft gap",
);

const diagonalOff = planDuctingAutoRoute({
  sources: [{ id: "ahu-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 5000, y: 5000, z: 3000 } }],
  gridStepMm: 1000,
  allowDiagonal: false,
  clearanceMm: 0,
});
const diagonalOn = planDuctingAutoRoute({
  sources: [{ id: "ahu-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 5000, y: 5000, z: 3000 } }],
  gridStepMm: 1000,
  allowDiagonal: true,
  clearanceMm: 0,
});

assert.equal(diagonalOff.summary.status, "pass");
assert.equal(diagonalOn.summary.status, "pass");
assert.equal(
  diagonalOn.routeCandidates[0].lengthMm < diagonalOff.routeCandidates[0].lengthMm,
  true,
  "diagonal routing should yield a shorter total length on a 5x5 L-shaped run",
);

const projectedEndpoint = planDuctingAutoRoute({
  sources: [{ id: "ahu-1", pointMm: { x: 0, y: 0, z: 5500 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 5500 } }],
  allowedElevationsMm: [3000, 6000],
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(projectedEndpoint.summary.status, "warn");
assert.equal(
  projectedEndpoint.issues.some((issue) => issue.code === "route_endpoint_z_projected"),
  true,
  "snapping a 5500mm endpoint to 6000mm should emit the projected-endpoint warning",
);
assert.equal(projectedEndpoint.routeCandidates[0].pointsMm[0].z, 6000);

// --- Backward compatibility: single allowedElevationsMm must match legacy 2D output ---

const legacy = planDuctingAutoRoute({
  sources: [{ id: "shaft-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  gridStepMm: 1000,
  clearanceMm: 0,
});
const legacyExplicit = planDuctingAutoRoute({
  sources: [{ id: "shaft-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  allowedElevationsMm: [3000],
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(legacy.routeCandidates[0].lengthMm, legacyExplicit.routeCandidates[0].lengthMm);
assert.equal(legacy.routeCandidates[0].elbowCount, legacyExplicit.routeCandidates[0].elbowCount);
assert.equal(legacy.routeCandidates[0].verticalRunCount, 0);
assert.equal(legacyExplicit.routeCandidates[0].verticalRunCount, 0);

// --- spatial-zone-extract.v1 consumption ---

const spatialZonePayload = {
  schema_version: "spatial-zone-extract.v1",
  summary: { obstacle_count: 1, shaft_count: 1, plenum_count: 2 },
  rooms: [],
  plenum_volumes: [
    {
      id: "room-101:plenum",
      source_room_id: "room-101",
      level_name: "L1",
      z_min_mm: 3000,
      z_max_mm: 3600,
    },
    {
      id: "room-201:plenum",
      source_room_id: "room-201",
      level_name: "L2",
      z_min_mm: 6000,
      z_max_mm: 6600,
    },
  ],
  shafts: [
    {
      id: "shaft-A",
      name: "Mechanical Shaft A",
      centroid_mm: { x: 4500, y: 1000, z: 4500 },
      z_min_mm: 0,
      z_max_mm: 9000,
      boundary: { min_mm: [4000, 500, 0], max_mm: [5000, 1500, 9000] },
    },
  ],
  obstacles: [
    {
      id: "beam-1",
      obstacle_type: "beam",
      source_link: "host",
      aabb_mm: {
        min_mm: [2000, -500, 5800],
        max_mm: [3000, 500, 6000],
        min: [2000, -500, 5800],
        max: [3000, 500, 6000],
      },
    },
  ],
  preferred_zones: [],
  forbidden_zones: [],
  warnings: [],
  errors: [],
};

const adapter = mapSpatialZoneToRoutingContext(spatialZonePayload);
assert.equal(adapter.obstacles.length, 1, "adapter must parse the spatial-zone obstacle");
assert.equal(adapter.obstacles[0].aabbMm.minZ, 5800);
assert.equal(adapter.obstacles[0].aabbMm.maxX, 3000);
assert.deepEqual(adapter.allowedElevationsMm, [3000, 3600, 6000, 6600]);
assert.equal(adapter.shafts.length, 1);
assert.equal(adapter.shafts[0].zMaxMm, 9000);

const usingSpatialZone = planDuctingAutoRoute({
  sources: [{ id: "ahu-roof", pointMm: { x: 0, y: 0, z: 6000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  spatialZone: spatialZonePayload,
  gridStepMm: 1000,
});

assert.equal(usingSpatialZone.summary.spatialZone.schemaVersion, "spatial-zone-extract.v1");
assert.equal(usingSpatialZone.summary.spatialZone.obstacleCount, 1);
assert.equal(usingSpatialZone.summary.spatialZone.shaftCount, 1);
assert.deepEqual(usingSpatialZone.summary.allowedElevationsMm, [3000, 3600, 6000, 6600]);
assert.equal(usingSpatialZone.summary.obstacleCount, 1, "spatial-zone obstacles must be parsed and counted");
assert.equal(usingSpatialZone.summary.status === "pass" || usingSpatialZone.summary.status === "warn", true);

// User-supplied obstacles override spatial-zone obstacles by id.
const overrideUser = planDuctingAutoRoute({
  sources: [{ id: "ahu-roof", pointMm: { x: 0, y: 0, z: 6000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  spatialZone: spatialZonePayload,
  obstacles: [
    {
      id: "beam-1",
      aabbMm: { minX: -100000, minY: -100000, minZ: -100000, maxX: 100000, maxY: 100000, maxZ: 100000 },
    },
  ],
  gridStepMm: 1000,
});
assert.equal(overrideUser.summary.status, "fail", "user override of beam-1 to a huge AABB must block every route");

// Missing plenum z but obstacles present → adapter still parses obstacles, allowedElevations empty.
const noPlenum = mapSpatialZoneToRoutingContext({
  schema_version: "spatial-zone-extract.v1",
  obstacles: [
    {
      id: "wall-1",
      aabb_mm: { min: [0, 0, 0], max: [100, 100, 100] },
    },
  ],
});
assert.equal(noPlenum.obstacles.length, 1);
assert.deepEqual(noPlenum.allowedElevationsMm, []);

// Unknown schema version surfaces a warning.
const unknownSchema = mapSpatialZoneToRoutingContext({ schema_version: "spatial-zone-extract.v2" });
assert.equal(unknownSchema.issues.some((entry) => entry.code === "spatial_zone_schema_unknown"), true);

console.error("ducting auto-routing tests passed");
