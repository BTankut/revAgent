import assert from "node:assert/strict";

import {
  buildAabbTreeObstacleIndex,
  buildLinearObstacleIndex,
  buildObstacleIndex,
  mapSpatialZoneToRoutingContext,
  planDuctingAutoRoute,
  pointInsideObstacle,
  readObstacles,
  segmentHitsObstacle,
  validateRoutePreview,
} from "../build/engineering/ducting/index.js";

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
  shaftRoute.routeCandidates[0].segmentsMm.some((segment) => {
    const verticalSegment = Math.abs(segment.startMm.x - segment.endMm.x) < 0.1
      && Math.abs(segment.startMm.y - segment.endMm.y) < 0.1
      && Math.abs(segment.startMm.z - segment.endMm.z) > 0.1;
    if (!verticalSegment) return false;
    const inShaft = segment.startMm.x > 3500 && segment.startMm.x < 5500;
    const crossesSlabZ = Math.min(segment.startMm.z, segment.endMm.z) <= 6000
      && Math.max(segment.startMm.z, segment.endMm.z) >= 6000;
    return inShaft && crossesSlabZ;
  }),
  true,
  "route must contain a vertical segment that crosses z=6000 inside the shaft gap",
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

// --- Review-driven fixes: per-run riser penalty consistency, slab segment-AABB,
//     and ObstacleIndex backend equivalence ---

// Per-run riser penalty invariant: refining the Z grid (adding intermediate
// allowed elevations between the same source and target) must NOT change
// which source the planner picks. Pre-fix, A* charged riserPenalty per
// vertical step, so refining the grid inflated the riser-source's cost
// enough to flip the multi-source selection.
//
// Scene: ahu-far makes a single 6 m riser to reach the target; ahu-close is
// farther horizontally but at the target's elevation (no riser). With
// riserPenalty=2000 (mm-equivalent):
//   ahu-far  per-run: 10000 + 1*2000 = 12000 → ahu-far wins (12000 < 15000)
//   ahu-far  per-step (refined, 6 steps): 10000 + 6*2000 = 22000 → ahu-close wins (22000 > 15000)
const perRunSources = [
  { id: "ahu-far", pointMm: { x: 0, y: 0, z: 9000 } },
  { id: "ahu-close", pointMm: { x: -11000, y: 0, z: 3000 } },
];
const perRunTarget = [{ id: "vav-1", pointMm: { x: 4000, y: 0, z: 3000 } }];
const riserPerRunCoarse = planDuctingAutoRoute({
  sources: perRunSources,
  targets: perRunTarget,
  allowedElevationsMm: [3000, 9000],
  gridStepMm: 1000,
  riserPenalty: 2000,
  clearanceMm: 0,
});
const riserPerRunRefined = planDuctingAutoRoute({
  sources: perRunSources,
  targets: perRunTarget,
  allowedElevationsMm: [3000, 4000, 5000, 6000, 7000, 8000, 9000],
  gridStepMm: 1000,
  riserPenalty: 2000,
  clearanceMm: 0,
});

assert.equal(riserPerRunCoarse.summary.status, "pass");
assert.equal(riserPerRunRefined.summary.status, "pass");
assert.equal(
  riserPerRunCoarse.routeCandidates[0].sourceId,
  "ahu-far",
  "coarse grid must pick ahu-far as the cheaper source",
);
assert.equal(
  riserPerRunCoarse.routeCandidates[0].sourceId,
  riserPerRunRefined.routeCandidates[0].sourceId,
  "refining the Z grid must not flip the multi-source selection (per-run riser invariant)",
);
assert.equal(
  riserPerRunCoarse.routeCandidates[0].verticalRunCount,
  riserPerRunRefined.routeCandidates[0].verticalRunCount,
  "vertical run count must stay 1 across grid refinement",
);
assert.equal(
  riserPerRunCoarse.routeCandidates[0].verticalRunLengthMm,
  riserPerRunRefined.routeCandidates[0].verticalRunLengthMm,
  "total vertical run length must stay 6000 mm across grid refinement",
);

// Per-run riser penalty: a very high penalty still selects the same-elevation source.
const riserPerRunHigh = planDuctingAutoRoute({
  sources: [
    { id: "ahu-top", pointMm: { x: 0, y: 0, z: 9000 } },
    { id: "ahu-low", pointMm: { x: 8000, y: 0, z: 3000 } },
  ],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  allowedElevationsMm: [3000, 6000, 9000],
  gridStepMm: 1000,
  riserPenalty: 50000,
  clearanceMm: 0,
});
assert.equal(riserPerRunHigh.routeCandidates[0].sourceId, "ahu-low");
assert.equal(riserPerRunHigh.routeCandidates[0].verticalRunCount, 0);

// Slab segment-AABB test: a diagonal segment that passes through the union
// AABB of source and target but actually misses the obstacle in 3D used to
// be flagged by the conservative axis-aligned AABB-overlap test. The slab
// method admits it.
//
// The pillar lives in the upper-right of the routing region; the descending
// diagonal (0,5000) → (5000,0) stays in the lower-right and never crosses
// the pillar's XY rectangle, yet the segment's bounding box (the full
// 0..5000 square) DOES overlap the pillar — the exact bug.
const obstacles = readObstacles(
  [
    {
      id: "pillar",
      aabbMm: { minX: 3500, minY: 3500, minZ: 2900, maxX: 4500, maxY: 4500, maxZ: 3100 },
    },
  ],
  0,
  0,
);
const obstacle = obstacles[0];
const diagonalSegmentClose = segmentHitsObstacle(
  { x: 0, y: 5000, z: 3000 },
  { x: 5000, y: 0, z: 3000 },
  obstacle,
);
const diagonalSegmentInside = segmentHitsObstacle(
  { x: 1000, y: 1000, z: 3000 },
  { x: 6000, y: 6000, z: 3000 },
  obstacle,
);
assert.equal(diagonalSegmentClose, false, "diagonal segment that misses the pillar must not be flagged");
assert.equal(diagonalSegmentInside, true, "diagonal segment that passes through the pillar must be flagged");

// Vertical segment passing exactly through a beam still hits.
const beamObstacle = readObstacles(
  [
    {
      id: "beam-x",
      aabbMm: { minX: 1500, minY: -500, minZ: 5800, maxX: 2500, maxY: 500, maxZ: 6100 },
    },
  ],
  0,
  0,
)[0];
const verticalThroughBeam = segmentHitsObstacle(
  { x: 2000, y: 0, z: 9000 },
  { x: 2000, y: 0, z: 3000 },
  beamObstacle,
);
assert.equal(verticalThroughBeam, true, "pure vertical segment through a beam must still hit");

// Diagonal routing succeeds across a corner case where the conservative AABB
// fast path would have falsely rejected the route.
const diagonalCorner = planDuctingAutoRoute({
  sources: [{ id: "ahu", pointMm: { x: 0, y: 5000, z: 3000 } }],
  targets: [{ id: "vav", pointMm: { x: 5000, y: 0, z: 3000 } }],
  obstacles: [
    {
      id: "corner-pillar",
      aabbMm: { minX: 2200, minY: 2200, minZ: 2900, maxX: 2800, maxY: 2800, maxZ: 3100 },
    },
  ],
  routingBounds: { minX: -200, minY: -200, minZ: 2900, maxX: 5200, maxY: 5200, maxZ: 3100 },
  gridStepMm: 1000,
  clearanceMm: 0,
  ductHalfHeightMm: 0,
  allowDiagonal: true,
});
assert.equal(diagonalCorner.summary.status, "pass");
assert.equal(diagonalCorner.routeCandidates[0].obstacleIntersections.length, 0);

// ObstacleIndex backends: linear and aabb-tree must produce identical block decisions.
const sceneObstacles = readObstacles(
  [
    { id: "o1", aabbMm: { minX: 1000, minY: 1000, minZ: 2900, maxX: 2000, maxY: 2000, maxZ: 3100 } },
    { id: "o2", aabbMm: { minX: 3500, minY: 1500, minZ: 2900, maxX: 4500, maxY: 2500, maxZ: 3100 } },
    { id: "o3", aabbMm: { minX: 0, minY: 4000, minZ: 5800, maxX: 6000, maxY: 5000, maxZ: 6100 } },
    { id: "o4", aabbMm: { minX: 4500, minY: 0, minZ: 5800, maxX: 5500, maxY: 1500, maxZ: 6100 } },
    { id: "o5", aabbMm: { minX: 1500, minY: 0, minZ: 8800, maxX: 2500, maxY: 1500, maxZ: 9100 } },
  ],
  0,
  0,
);
const linearIndex = buildLinearObstacleIndex(sceneObstacles);
const treeIndex = buildAabbTreeObstacleIndex(sceneObstacles);
assert.equal(linearIndex.backend, "linear");
assert.equal(treeIndex.backend, "aabb-tree");
assert.equal(buildObstacleIndex(sceneObstacles).backend, "aabb-tree");
assert.equal(linearIndex.count, treeIndex.count);

const probePoints = [
  { x: 0, y: 0, z: 3000 },
  { x: 1500, y: 1500, z: 3000 },
  { x: 4000, y: 2000, z: 3000 },
  { x: 5000, y: 4500, z: 6000 },
  { x: 9000, y: 9000, z: 9000 },
  { x: 2000, y: 1000, z: 9000 },
];
for (const probe of probePoints) {
  const linearBlocks = linearIndex.candidatesForPoint(probe).some((o) => pointInsideObstacle(probe, o));
  const treeBlocks = treeIndex.candidatesForPoint(probe).some((o) => pointInsideObstacle(probe, o));
  assert.equal(linearBlocks, treeBlocks, `point block decision must match for ${JSON.stringify(probe)}`);
}
const probeSegments = [
  [{ x: 0, y: 0, z: 3000 }, { x: 6000, y: 0, z: 3000 }],
  [{ x: 0, y: 2000, z: 3000 }, { x: 6000, y: 2000, z: 3000 }],
  [{ x: 0, y: 0, z: 3000 }, { x: 6000, y: 6000, z: 3000 }],
  [{ x: 2000, y: 1000, z: 9000 }, { x: 2000, y: 1000, z: 3000 }],
  [{ x: 0, y: 0, z: 9000 }, { x: 6000, y: 6000, z: 3000 }],
];
for (const [start, end] of probeSegments) {
  const linearBlocks = linearIndex.candidatesForSegment(start, end).some((o) => segmentHitsObstacle(start, end, o));
  const treeBlocks = treeIndex.candidatesForSegment(start, end).some((o) => segmentHitsObstacle(start, end, o));
  assert.equal(linearBlocks, treeBlocks, `segment block decision must match for ${JSON.stringify({ start, end })}`);
}

// End-to-end: planner with linear backend matches aabb-tree backend on the same scene.
const sharedInput = {
  sources: [{ id: "ahu-1", pointMm: { x: 0, y: 0, z: 9000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 3000 } }],
  allowedElevationsMm: [3000, 6000, 9000],
  obstacles: [
    { id: "beam-1", aabbMm: { minX: 1500, minY: -500, minZ: 5800, maxX: 2500, maxY: 500, maxZ: 6100 } },
  ],
  gridStepMm: 1000,
  clearanceMm: 0,
};
const planLinear = planDuctingAutoRoute({ ...sharedInput, obstacleIndexBackend: "linear" });
const planTree = planDuctingAutoRoute({ ...sharedInput, obstacleIndexBackend: "aabb-tree" });
assert.equal(planLinear.summary.obstacleIndexBackend, "linear");
assert.equal(planTree.summary.obstacleIndexBackend, "aabb-tree");
assert.equal(planLinear.summary.status, planTree.summary.status);
assert.equal(planLinear.routeCandidates[0].lengthMm, planTree.routeCandidates[0].lengthMm);
assert.equal(planLinear.routeCandidates[0].elbowCount, planTree.routeCandidates[0].elbowCount);
assert.equal(planLinear.routeCandidates[0].verticalRunCount, planTree.routeCandidates[0].verticalRunCount);
assert.equal(planLinear.routeCandidates[0].score, planTree.routeCandidates[0].score);
assert.deepEqual(planLinear.routeCandidates[0].pointsMm, planTree.routeCandidates[0].pointsMm);

console.error("ducting auto-routing tests passed");
