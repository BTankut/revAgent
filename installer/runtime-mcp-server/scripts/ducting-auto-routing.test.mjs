import assert from "node:assert/strict";

import { planDuctingAutoRoute, validateRoutePreview } from "../build/engineering/ducting/index.js";

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

const trunkAndBranch = planDuctingAutoRoute({
  routingMode: "trunkAndBranch",
  trunkAxis: "x",
  sources: [{ id: "ahu-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [
    { id: "diffuser-1", pointMm: { x: 4000, y: 2000, z: 3000 } },
    { id: "diffuser-2", pointMm: { x: 8000, y: 2000, z: 3000 } },
    { id: "diffuser-3", pointMm: { x: 12000, y: 2000, z: 3000 } },
  ],
  routingZones: [
    { id: "corridor-plenum", aabbMm: { minX: -1000, minY: 1750, minZ: 2500, maxX: 13000, maxY: 2250, maxZ: 3500 } },
  ],
  routingBounds: { minX: -1000, minY: -1000, minZ: 2500, maxX: 13000, maxY: 3000, maxZ: 3500 },
  gridStepMm: 1000,
  clearanceMm: 0,
});

assert.equal(trunkAndBranch.summary.status, "pass");
assert.equal(trunkAndBranch.summary.routingMode, "trunkAndBranch");
assert.equal(trunkAndBranch.routeCandidates.length, 3);
assert.equal(trunkAndBranch.routeTree.topology, "trunkAndBranch");
assert.equal(trunkAndBranch.routeTree.axis, "x");
assert.equal(trunkAndBranch.routeTree.trunkCoordinateMm, 2000);
assert.equal(trunkAndBranch.routeTree.treeLengthMm, 14000);
assert.equal(trunkAndBranch.summary.treeLengthMm < trunkAndBranch.summary.totalLengthMm, true);
assert.equal(trunkAndBranch.routeCandidates.every((candidate) => candidate.topology === "trunkAndBranch"), true);

const fixedTrunk = planDuctingAutoRoute({
  routingMode: "trunkAndBranch",
  trunkAxis: "x",
  trunkPositionMm: 0,
  sources: [{ id: "ahu-1", pointMm: { x: 0, y: 0, z: 3000 } }],
  targets: [
    { id: "diffuser-1", pointMm: { x: 4000, y: 2000, z: 3000 } },
    { id: "diffuser-2", pointMm: { x: 8000, y: 2000, z: 3000 } },
  ],
  gridStepMm: 1000,
});

assert.equal(fixedTrunk.routeTree.trunkCoordinateMm, 0);
assert.equal(fixedTrunk.routeCandidates.length, 2);

console.error("ducting auto-routing tests passed");
