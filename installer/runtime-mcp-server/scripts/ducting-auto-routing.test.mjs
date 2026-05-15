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

// An endpoint that is *out of bounds* (below min or above max of the allowed
// elevations) still snaps to the nearest boundary and emits the projected-
// endpoint warning. Sprint 1.11 fixed the in-bounds case (z that lies on the
// refined grid — including the endpoint Z addition — must snap to itself);
// out-of-bounds endpoints continue to be projected.
const projectedEndpoint = planDuctingAutoRoute({
  sources: [{ id: "ahu-1", pointMm: { x: 0, y: 0, z: 2000 } }],
  targets: [{ id: "vav-1", pointMm: { x: 6000, y: 0, z: 2000 } }],
  allowedElevationsMm: [3000, 6000],
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(projectedEndpoint.summary.status, "warn");
assert.equal(
  projectedEndpoint.issues.some((issue) => issue.code === "route_endpoint_z_projected"),
  true,
  "an out-of-bounds 2000mm endpoint must snap to the nearest allowed elevation (3000) with the projected-endpoint warning",
);
assert.equal(projectedEndpoint.routeCandidates[0].pointsMm[0].z, 3000);

// Sprint 1.17 (Gemini HIGH): ductHalfWidthMm must expand obstacle AABBs on the
// X/Y axes the same way ductHalfHeightMm expands them on Z. The expansion
// asymmetry would otherwise let a route at the duct centerline cut into the
// obstacle by half the duct width before the planner notices.
const pillarObstacle = readObstacles(
  [
    {
      id: "pillar",
      aabbMm: { minX: 2000, minY: 2000, minZ: 2900, maxX: 2200, maxY: 2200, maxZ: 3100 },
    },
  ],
  100, // clearanceMm
  300, // ductHalfWidthMm
  50,  // ductHalfHeightMm
)[0];
// Expanded AABB picks up `clearance + halfWidth` on X/Y and
// `clearance + halfHeight` on Z. Asymmetry between width and height is the
// expected case for rectangular ducts; round ducts pass equal values.
assert.equal(pillarObstacle.expanded.minX, 1600, "ductHalfWidthMm must subtract from minX");
assert.equal(pillarObstacle.expanded.minY, 1600, "ductHalfWidthMm must subtract from minY");
assert.equal(pillarObstacle.expanded.minZ, 2750, "ductHalfHeightMm must subtract from minZ");
assert.equal(pillarObstacle.expanded.maxX, 2600, "ductHalfWidthMm must add to maxX");
assert.equal(pillarObstacle.expanded.maxY, 2600, "ductHalfWidthMm must add to maxY");
assert.equal(pillarObstacle.expanded.maxZ, 3250, "ductHalfHeightMm must add to maxZ");

// Default ductHalfWidthMm is 0, preserving legacy behaviour (callers that
// previously baked the half-width into clearanceMm keep working unchanged).
const legacyExpansion = readObstacles(
  [{ id: "p", aabbMm: { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 100, maxZ: 100 } }],
  50, 0, 50,
)[0];
assert.equal(legacyExpansion.expanded.minX, -50, "halfWidth=0 → X expansion is clearance-only");
assert.equal(legacyExpansion.expanded.maxX, 150);
assert.equal(legacyExpansion.expanded.minZ, -100, "Z expansion is clearance + halfHeight");
assert.equal(legacyExpansion.expanded.maxZ, 200);

// Sprint 1.29 (Gemini medium): when A* fails to find a route, the
// `route_endpoint_z_projected` warning must aggregate ALL projected sources
// instead of misleadingly attributing the projection to the first listed
// source. Two sources both out-of-bounds → both projected → both reported.
const multiSourceProjection = planDuctingAutoRoute({
  sources: [
    { id: "ahu-1", pointMm: { x: 0, y: 0, z: 2000 } }, // below allowed 3000
    { id: "ahu-2", pointMm: { x: 0, y: 1000, z: 2000 } }, // also below
  ],
  // No usable target: pillar at the only routing elevation cuts both routes.
  targets: [{ id: "vav", pointMm: { x: 4000, y: 0, z: 2000 } }],
  allowedElevationsMm: [3000, 6000],
  obstacles: [
    { id: "wall", aabbMm: { minX: 1500, minY: -2000, minZ: 2900, maxX: 1600, maxY: 2000, maxZ: 6100 } },
  ],
  routingBounds: { minX: -200, minY: -2000, minZ: 2900, maxX: 4200, maxY: 2000, maxZ: 6100 },
  gridStepMm: 500,
  clearanceMm: 0,
});
const projectionIssue = multiSourceProjection.issues.find(
  (issue) => issue.code === "route_endpoint_z_projected",
);
assert.ok(projectionIssue, "must emit route_endpoint_z_projected for out-of-bounds sources");
assert.deepEqual(
  projectionIssue.context?.sourceIds,
  ["ahu-1", "ahu-2"],
  "no-path projection warning must report every projected source, not just the first",
);
assert.equal(
  projectionIssue.context?.sourceId,
  "(multiple-or-unselected)",
  "with multiple projected sources and no selected route, scalar sourceId should disambiguate",
);

// Sprint 1.28 (Codex P2): A* must not expand grid nodes outside routingBounds.
// With bounds.z=[5500,6500], allowed=[3000,9000], verticalStepMm=1000, the
// raw grid contains z=7000 — outside the caller's routing volume. A blocking
// obstacle at z=6000 would otherwise tempt A* to detour through z=7000 and
// silently violate the bounds contract. The Z grid must now be clipped to
// bounds before search.
const boundsClippedRoute = planDuctingAutoRoute({
  sources: [{ id: "ahu", pointMm: { x: 0, y: 0, z: 6000 } }],
  targets: [{ id: "vav", pointMm: { x: 4000, y: 0, z: 6000 } }],
  allowedElevationsMm: [3000, 9000],
  verticalStepMm: 1000,
  obstacles: [
    { id: "beam", aabbMm: { minX: 1800, minY: -500, minZ: 5900, maxX: 2200, maxY: 500, maxZ: 6100 } },
  ],
  routingBounds: { minX: -200, minY: -500, minZ: 5500, maxX: 4200, maxY: 500, maxZ: 6500 },
  gridStepMm: 500,
  clearanceMm: 0,
});
assert.equal(boundsClippedRoute.summary.status, "fail",
  "with the corridor blocked at z=6000 and bounds.z capped at 6500, no detour through z=7000 is allowed");
assert.ok(
  boundsClippedRoute.issues.some((issue) => issue.code === "route_not_found"),
  "blocked-corridor scenario must emit route_not_found",
);

// Companion sanity check: when the obstacle is removed, the same bounds let
// the route run cleanly at z=6000.
const boundsClippedNoBlock = planDuctingAutoRoute({
  sources: [{ id: "ahu", pointMm: { x: 0, y: 0, z: 6000 } }],
  targets: [{ id: "vav", pointMm: { x: 4000, y: 0, z: 6000 } }],
  allowedElevationsMm: [3000, 9000],
  verticalStepMm: 1000,
  routingBounds: { minX: -200, minY: -500, minZ: 5500, maxX: 4200, maxY: 500, maxZ: 6500 },
  gridStepMm: 500,
  clearanceMm: 0,
});
assert.equal(boundsClippedNoBlock.summary.status, "pass");
for (const point of boundsClippedNoBlock.routeCandidates[0].pointsMm) {
  assert.ok(point.z >= 5500 && point.z <= 6500,
    `every route waypoint must stay inside bounds.z [5500, 6500]; got z=${point.z}`);
}

// Sprint 1.27 (Codex P2): a user-supplied obstacle whose AABB cannot be parsed
// must NOT silently drop the valid spatial-zone obstacle that shares its id.
// Before this fix, an invalid user override would (1) win the merge by id,
// (2) get skipped by readObstacles, leaving the planner with no obstacle and
// routing straight through what should be a real model element.
const invalidUserOverrideKeepsSpatial = planDuctingAutoRoute({
  sources: [{ id: "s", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "t", pointMm: { x: 4000, y: 0, z: 3000 } }],
  spatialZone: {
    schema_version: "spatial-zone-extract.v1",
    obstacles: [
      {
        id: "beam-A",
        category: "Structural Framing",
        aabb_mm: { min: [1500, -1000, 2900], max: [2500, 1000, 3100] },
      },
    ],
    plenum_volumes: [{ id: "p", z_min_mm: 2900, z_max_mm: 3100 }],
    shafts: [],
  },
  obstacles: [
    { id: "beam-A" }, // override attempt with missing AABB
  ],
  routingBounds: { minX: -200, minY: -1500, minZ: 2900, maxX: 4200, maxY: 1500, maxZ: 3100 },
  gridStepMm: 500,
  clearanceMm: 0,
});
assert.equal(
  invalidUserOverrideKeepsSpatial.summary.obstacleCount,
  1,
  "spatial-zone obstacle must survive when its id is matched by an unparseable user override",
);
assert.ok(
  invalidUserOverrideKeepsSpatial.issues.some((issue) => issue.code === "route_user_obstacle_unreadable"),
  "the rejected user override must still surface as the route_user_obstacle_unreadable warning",
);
// The valid spatial obstacle blocks the straight path; the route must detour
// rather than slice through (1500-2500, -1000-1000).
const detourRoute = invalidUserOverrideKeepsSpatial.routeCandidates[0];
assert.ok(detourRoute, "a route candidate must still be generated using the surviving spatial obstacle");
const cutsThroughBeam = detourRoute.segmentsMm.some((segment) => {
  const x1 = segment.startMm.x;
  const x2 = segment.endMm.x;
  const y = (segment.startMm.y + segment.endMm.y) / 2;
  return y > -1000 && y < 1000 && Math.min(x1, x2) < 2500 && Math.max(x1, x2) > 1500;
});
assert.equal(cutsThroughBeam, false,
  "route must not slice through the spatial-zone beam that survived the failed override");

// Sprint 1.26 (Gemini medium): user-supplied obstacles whose AABB cannot be
// parsed must surface as a warning issue, parallel to the existing
// spatial_zone_obstacle_aabb_unreadable issue for spatial-zone obstacles.
const partiallyInvalidObstacles = planDuctingAutoRoute({
  sources: [{ id: "s", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "t", pointMm: { x: 5000, y: 0, z: 3000 } }],
  obstacles: [
    { id: "valid-pillar", aabbMm: { minX: 1500, minY: -100, minZ: 2900, maxX: 2500, maxY: 100, maxZ: 3100 } },
    { id: "missing-aabb" },
    { id: "bad-aabb", aabbMm: "not a real aabb" },
  ],
  gridStepMm: 1000,
  clearanceMm: 0,
});
const skipIssue = partiallyInvalidObstacles.issues.find((issue) => issue.code === "route_user_obstacle_unreadable");
assert.ok(skipIssue, "must emit route_user_obstacle_unreadable warning when user obstacles fail to parse");
assert.equal(skipIssue.severity, "warning");
assert.equal(skipIssue.context?.skippedCount, 2);
assert.equal(skipIssue.context?.totalSupplied, 3);
assert.deepEqual(skipIssue.context?.skippedIds, ["missing-aabb", "bad-aabb"]);
assert.equal(
  partiallyInvalidObstacles.summary.status,
  "warn",
  "warning-only issues should keep the summary at `warn` (the valid obstacle still allows a route)",
);

// Sprint 1.23 (Codex P2): the bounds preflight check (separate from the route
// generation snap fixed in Sprint 1.11/1.14) was still snapping against the
// raw allowedZs. With allowed=[3000,9000], verticalStepMm=1000, a source at
// z=6000 lives on the refined grid; tight routingBounds around z=6000 must
// not cause the preflight to falsely report it outside bounds.
const refinedBoundsPreflight = planDuctingAutoRoute({
  sources: [{ id: "ahu-pf", pointMm: { x: 0, y: 0, z: 6000 } }],
  targets: [{ id: "vav-pf", pointMm: { x: 4000, y: 0, z: 6000 } }],
  allowedElevationsMm: [3000, 9000],
  verticalStepMm: 1000,
  routingBounds: { minX: -200, minY: -200, minZ: 5500, maxX: 4200, maxY: 200, maxZ: 6500 },
  gridStepMm: 1000,
  clearanceMm: 0,
});
assert.equal(refinedBoundsPreflight.summary.status, "pass",
  "z=6000 sits on the verticalStepMm refined grid; bounds preflight must accept it");
assert.equal(
  refinedBoundsPreflight.issues.some((issue) =>
    issue.code === "route_source_outside_bounds" || issue.code === "route_target_outside_bounds"),
  false,
  "refined-grid endpoints must not be flagged outside the supplied routing bounds",
);
assert.equal(refinedBoundsPreflight.routeCandidates[0].pointsMm[0].z, 6000);

// Sprint 1.16 (Codex P2): explicit `routingElevationMm` must win over
// spatial-zone-derived allowedElevationsMm when the caller did not supply
// `allowedElevationsMm`. Prior behaviour silently picked the plenum_volumes
// min/max (2800/3600 below), routing at z=2800 even though the caller
// asked for z=3200.
const explicitRoutingOverSpatial = planDuctingAutoRoute({
  sources: [{ id: "ahu-explicit", pointMm: { x: 0, y: 0, z: 3200 } }],
  targets: [{ id: "vav-explicit", pointMm: { x: 4000, y: 0, z: 3200 } }],
  routingElevationMm: 3200,
  spatialZone: {
    schema_version: "spatial-zone-extract.v1",
    obstacles: [],
    plenum_volumes: [{ id: "p1", z_min_mm: 2800, z_max_mm: 3600 }],
    shafts: [],
  },
  gridStepMm: 1000,
  clearanceMm: 0,
});
assert.equal(explicitRoutingOverSpatial.summary.status, "pass");
assert.equal(
  explicitRoutingOverSpatial.summary.routingElevationMm,
  3200,
  "summary must echo the explicit routingElevationMm",
);
assert.deepEqual(
  explicitRoutingOverSpatial.summary.allowedElevationsMm,
  [3200],
  "explicit routingElevationMm must override spatial-zone-derived allowedElevationsMm",
);
assert.equal(
  explicitRoutingOverSpatial.routeCandidates[0].pointsMm[0].z,
  3200,
  "route must run at the explicit routing elevation (3200), not the plenum min (2800)",
);
assert.equal(
  explicitRoutingOverSpatial.issues.some((issue) => issue.code === "route_endpoint_z_projected"),
  false,
  "endpoint at the explicit routing elevation must not emit the projected-endpoint warning",
);

// Sprint 1.15 (Codex P2): a route whose source and target collapse to the same
// grid node (identical points, or endpoint snapping merging them) must not
// emit a `pass` candidate. The planner now rejects single-point paths with a
// `route_not_found` issue so the downstream ducting evaluator does not have
// to clean up a `lengthMm: 0` candidate.
const collapsedRoute = planDuctingAutoRoute({
  sources: [{ id: "collapsed-s", pointMm: { x: 1000, y: 1000, z: 3000 } }],
  targets: [{ id: "collapsed-t", pointMm: { x: 1000, y: 1000, z: 3000 } }],
  gridStepMm: 1000,
  clearanceMm: 0,
});
assert.equal(collapsedRoute.summary.status, "fail",
  "source and target at the same point must not produce a pass candidate");
assert.equal(
  collapsedRoute.issues.some(
    (issue) => issue.code === "route_not_found"
      && issue.severity === "error"
      && (issue.context?.reason === "collapsed_to_single_point" || issue.context?.reason === "no_path"),
  ),
  true,
  "collapsed route must emit route_not_found with a reason context",
);

// Sprint 1.14 (Codex P2): an in-bounds endpoint that is NOT on an allowed
// elevation or a verticalStepMm refined stop must still be projected with
// the warning. Otherwise the planner would route at an arbitrary elevation
// the caller never approved. Here z=5500 sits between allowed=[3000, 6000]
// with no verticalStepMm, so it snaps to 6000 (the nearest allowed).
const inBoundsOffGrid = planDuctingAutoRoute({
  sources: [{ id: "ahu-off", pointMm: { x: 0, y: 0, z: 5500 } }],
  targets: [{ id: "vav-off", pointMm: { x: 6000, y: 0, z: 5500 } }],
  allowedElevationsMm: [3000, 6000],
  gridStepMm: 1000,
  clearanceMm: 0,
});
assert.equal(inBoundsOffGrid.summary.status, "warn");
assert.equal(
  inBoundsOffGrid.issues.some((issue) => issue.code === "route_endpoint_z_projected"),
  true,
  "in-bounds endpoint z=5500 is off the allowed-elevation grid and must be projected",
);
assert.equal(inBoundsOffGrid.routeCandidates[0].pointsMm[0].z, 6000);

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

// Sprint 1.7: diagonal moves must be true 45° elbows even when the grid is non-uniform.
// An off-grid source at x=50 forces xs to contain {50, 1000, ...} so naive index pairing
// would create arbitrary-angle segments. The 45° tolerance gate must skip those moves,
// leaving the route composed only of axis-aligned or |dx|≈|dy| diagonal segments.
const asymmetricDiagonal = planDuctingAutoRoute({
  sources: [{ id: "ahu-asym", pointMm: { x: 50, y: 0, z: 3000 } }],
  targets: [{ id: "vav-asym", pointMm: { x: 5000, y: 5000, z: 3000 } }],
  gridStepMm: 1000,
  allowDiagonal: true,
  clearanceMm: 0,
});
assert.equal(asymmetricDiagonal.summary.status, "pass");
for (const segment of asymmetricDiagonal.routeCandidates[0].segmentsMm) {
  const dx = Math.abs(segment.endMm.x - segment.startMm.x);
  const dy = Math.abs(segment.endMm.y - segment.startMm.y);
  const dz = Math.abs(segment.endMm.z - segment.startMm.z);
  const xOnly = dy < 1 && dz < 1 && dx >= 1;
  const yOnly = dx < 1 && dz < 1 && dy >= 1;
  const zOnly = dx < 1 && dy < 1 && dz >= 1;
  const trueDiagonal = dz < 1 && dx >= 1 && dy >= 1 && Math.abs(dx - dy) < 1;
  assert.ok(
    xOnly || yOnly || zOnly || trueDiagonal,
    `segment must be axis-aligned or 45° diagonal; got dx=${dx} dy=${dy} dz=${dz}`,
  );
}

// Sprint 1.8: even after the per-step diagonal gate accepts each move, the
// segment compression must NOT collapse adjacent diagonals whose cumulative
// |Δx|/|Δy| drift past the 1 mm tolerance — otherwise downstream consumers
// see arbitrary-angle duct segments. This setup forces an off-pitch detour
// (obstacle at minX=2099 generates expanded-corner coords like 2098 / 2802)
// that would have produced a non-45° merged segment under the old compression.
const compressionTolerance = planDuctingAutoRoute({
  sources: [{ id: "ahu-c", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-c", pointMm: { x: 5000, y: 5000, z: 3000 } }],
  obstacles: [
    { id: "off-pitch", aabbMm: { minX: 2099, minY: 2099, minZ: 2900, maxX: 2801, maxY: 2801, maxZ: 3100 } },
  ],
  routingBounds: { minX: -200, minY: -200, minZ: 2900, maxX: 5200, maxY: 5200, maxZ: 3100 },
  gridStepMm: 1000,
  clearanceMm: 0,
  allowDiagonal: true,
});
assert.equal(compressionTolerance.summary.status, "pass");
for (const segment of compressionTolerance.routeCandidates[0].segmentsMm) {
  const dx = Math.abs(segment.endMm.x - segment.startMm.x);
  const dy = Math.abs(segment.endMm.y - segment.startMm.y);
  const dz = Math.abs(segment.endMm.z - segment.startMm.z);
  const xOnly = dy < 1 && dz < 1 && dx >= 1;
  const yOnly = dx < 1 && dz < 1 && dy >= 1;
  const zOnly = dx < 1 && dy < 1 && dz >= 1;
  const trueDiagonal = dz < 1 && dx >= 1 && dy >= 1 && Math.abs(dx - dy) <= 1;
  assert.ok(
    xOnly || yOnly || zOnly || trueDiagonal,
    `compressed segment must remain axis-aligned or 45°; got dx=${dx} dy=${dy} dz=${dz}`,
  );
}

// Sprint 1.11 (Codex P2): endpoint Z snap must use the refined grid. With
// allowedElevationsMm=[3000, 9000] and verticalStepMm=1000, createCoordinateGrid
// builds zs={3000,4000,...,9000}. A source at z=6000 lives ON the refined grid,
// so it must NOT be snapped down to 3000 with a projected-endpoint warning, and
// the route must actually start at z=6000.
const refinedSnap = planDuctingAutoRoute({
  sources: [{ id: "ahu-refined", pointMm: { x: 0, y: 0, z: 6000 } }],
  targets: [{ id: "vav-refined", pointMm: { x: 4000, y: 0, z: 9000 } }],
  allowedElevationsMm: [3000, 9000],
  verticalStepMm: 1000,
  gridStepMm: 1000,
  clearanceMm: 0,
});
assert.equal(refinedSnap.summary.status, "pass");
assert.equal(
  refinedSnap.issues.some((issue) => issue.code === "route_endpoint_z_projected"),
  false,
  "z=6000 endpoint lies on the refined verticalStepMm grid; it must not be flagged as projected",
);
assert.equal(
  refinedSnap.routeCandidates[0].pointsMm[0].z,
  6000,
  "route must actually start at the refined-grid source z (6000), not the original allowed elevation (3000)",
);

// Also confirm the endpoint snap still uses verticalStepMm refinement when the
// source z is BETWEEN two refined stops (not exactly on one) — it should snap
// to the nearest refined stop (within 1 mm tolerance, projected=false). Source
// at z=4500 with verticalStepMm=500 → grid contains 4500 exactly.
const refinedSnapMid = planDuctingAutoRoute({
  sources: [{ id: "ahu-mid", pointMm: { x: 0, y: 0, z: 4500 } }],
  targets: [{ id: "vav-mid", pointMm: { x: 4000, y: 0, z: 6000 } }],
  allowedElevationsMm: [3000, 6000],
  verticalStepMm: 500,
  gridStepMm: 1000,
  clearanceMm: 0,
});
assert.equal(refinedSnapMid.summary.status, "pass");
assert.equal(
  refinedSnapMid.issues.some((issue) => issue.code === "route_endpoint_z_projected"),
  false,
  "z=4500 lies on the refined grid (verticalStepMm=500); no projected warning",
);
assert.equal(refinedSnapMid.routeCandidates[0].pointsMm[0].z, 4500);

// Sprint 1.7: spatial-zone payload errors/warnings must propagate.
// references/patterns/spatial-zone-extract.cs returns the failure payload with empty
// geometry plus an `errors` array; that must surface as error-severity issues so the
// planner cannot quietly return "pass" routes built from no obstacles.
const failedExtraction = planDuctingAutoRoute({
  sources: [{ id: "ahu-failed", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [{ id: "vav-failed", pointMm: { x: 4000, y: 0, z: 3000 } }],
  spatialZone: {
    schema_version: "spatial-zone-extract.v1",
    obstacles: [],
    plenum_volumes: [],
    shafts: [],
    warnings: ["Boundary loops unavailable; bounding box fallback used."],
    errors: ["No Revit level could be resolved in the host model."],
  },
  gridStepMm: 1000,
  clearanceMm: 0,
});
assert.equal(
  failedExtraction.summary.status,
  "fail",
  "spatial-zone payload errors must block route generation",
);
assert.equal(
  failedExtraction.issues.some(
    (issue) => issue.severity === "error" && issue.code === "spatial_zone_extract_error",
  ),
  true,
  "spatial-zone payload errors must surface as error-severity issues",
);
assert.equal(
  failedExtraction.issues.some(
    (issue) => issue.severity === "warning" && issue.code === "spatial_zone_extract_warning",
  ),
  true,
  "spatial-zone payload warnings must surface as warning-severity issues",
);
assert.equal(
  failedExtraction.routeCandidates.length,
  0,
  "spatial-zone errors must prevent route candidates from being produced",
);

const adapterWithErrors = mapSpatialZoneToRoutingContext({
  schema_version: "spatial-zone-extract.v1",
  errors: ["extraction crashed"],
  warnings: ["stale link skipped"],
});
assert.ok(
  adapterWithErrors.issues.some(
    (issue) => issue.severity === "error" && issue.code === "spatial_zone_extract_error",
  ),
  "adapter must emit error-severity issues for payload errors",
);
assert.ok(
  adapterWithErrors.issues.some(
    (issue) => issue.severity === "warning" && issue.code === "spatial_zone_extract_warning",
  ),
  "adapter must emit warning-severity issues for payload warnings",
);

console.error("ducting auto-routing tests passed");
