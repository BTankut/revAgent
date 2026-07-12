import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { compareSpatialSnapshots } from "../build/spatial/spatialDiff.js";
import { querySpatialContext } from "../build/spatial/spatialQuery.js";
import {
  createTestStore,
  makeElementNode,
  percentile,
  seedSnapshot,
} from "./spatial-phase1b-test-helpers.mjs";

const WARMUP_RUNS = 5;
const MEASURED_RUNS = 25;
const QUERY_P95_LIMIT_MS = 750;
const DIFF_P95_LIMIT_MS = 3_000;
const QUERY_HARD_GUARD_MS = 5_000;
const DIFF_HARD_GUARD_MS = 15_000;
const NODE_COUNT = 600;

function performanceNodes(revision) {
  return Array.from({ length: NODE_COUNT }, (_, index) => {
    const column = index % 30;
    const row = Math.floor(index / 30);
    const moved = revision === "head" && index === 300 ? 50 : 0;
    const x = column * 250 + moved;
    const y = row * 250;
    return makeElementNode({
      nodeId: `node:perf:${String(index).padStart(4, "0")}`,
      category: index % 2 === 0 ? "Ducts" : "Pipes",
      builtInCategory: index % 2 === 0 ? "OST_DuctCurves" : "OST_PipeCurves",
      categoryRole: "mep_curve",
      systemKey: revision === "head" && index === 450 ? "Return Air" : "Supply Air",
      aabb: {
        minMm: [x, y, 0],
        maxMm: [x + 100, y + 100, 100],
      },
    });
  });
}

function measure(call, runs) {
  const timings = [];
  for (let index = 0; index < runs; index += 1) {
    const startedAt = performance.now();
    const result = call();
    timings.push(performance.now() - startedAt);
    assert.equal(result.guarded, false);
    assert.equal(result.state, "completed");
  }
  return timings;
}

const fixture = createTestStore("performance");
try {
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:perf-base",
    nodes: performanceNodes("base"),
  });
  seedSnapshot(fixture.store, {
    snapshotId: "snapshot:perf-head",
    nodes: performanceNodes("head"),
  });

  const queryCall = () => querySpatialContext(fixture.store, {
    snapshotId: "snapshot:perf-head",
    mode: "operation",
    operation: {
      name: "nearest_elements",
      anchorNodeId: "node:perf:0000",
      maxDistanceMm: 1_000,
      limit: 100,
      filters: { categoryRoles: ["mep_curve"] },
    },
  });
  const diffCall = () => compareSpatialSnapshots(fixture.store, {
    baseSnapshotId: "snapshot:perf-base",
    headSnapshotId: "snapshot:perf-head",
    maxChanges: 5_000,
    proximityRadiusMm: 1_000,
    maxProximityPairs: 5_000,
  });

  measure(queryCall, WARMUP_RUNS);
  measure(diffCall, WARMUP_RUNS);
  const queryTimings = measure(queryCall, MEASURED_RUNS);
  const diffTimings = measure(diffCall, MEASURED_RUNS);
  assert.ok(queryTimings.length >= 20);
  assert.ok(diffTimings.length >= 20);
  assert.ok(Math.max(...queryTimings) <= QUERY_HARD_GUARD_MS,
    `A bounded spatial query exceeded the ${QUERY_HARD_GUARD_MS} ms hard stall guard.`);
  assert.ok(Math.max(...diffTimings) <= DIFF_HARD_GUARD_MS,
    `A bounded snapshot diff exceeded the ${DIFF_HARD_GUARD_MS} ms hard stall guard.`);

  const queryP95Ms = percentile(queryTimings, 95);
  const diffP95Ms = percentile(diffTimings, 95);
  assert.ok(queryP95Ms <= QUERY_P95_LIMIT_MS,
    `Bounded query p95 ${queryP95Ms.toFixed(3)} ms exceeds ${QUERY_P95_LIMIT_MS} ms.`);
  assert.ok(diffP95Ms <= DIFF_P95_LIMIT_MS,
    `Snapshot diff p95 ${diffP95Ms.toFixed(3)} ms exceeds ${DIFF_P95_LIMIT_MS} ms.`);

  console.log(JSON.stringify({
    suite: "spatial_phase1b_performance",
    fixture: {
      schemaVersion: "0.3",
      baseNodeCount: NODE_COUNT,
      headNodeCount: NODE_COUNT,
      queryKind: "nearest_elements",
    },
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS,
    query: {
      p95Ms: Number(queryP95Ms.toFixed(3)),
      maxMs: Number(Math.max(...queryTimings).toFixed(3)),
      acceptanceP95Ms: QUERY_P95_LIMIT_MS,
      hardGuardMs: QUERY_HARD_GUARD_MS,
    },
    diff: {
      p95Ms: Number(diffP95Ms.toFixed(3)),
      maxMs: Number(Math.max(...diffTimings).toFixed(3)),
      acceptanceP95Ms: DIFF_P95_LIMIT_MS,
      hardGuardMs: DIFF_HARD_GUARD_MS,
    },
  }));
} finally {
  fixture.cleanup();
}
