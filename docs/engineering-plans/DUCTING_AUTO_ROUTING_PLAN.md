# Ducting Auto-Routing Plan

## Goal

Create a production-safe duct auto-routing foundation that turns reviewed source and target points into obstacle-aware route candidates before any Revit duct creation is allowed.

## Phase 1 in This Branch

- Add `plan_ducting_auto_route` as a read-only MCP runtime tool.
- Accept source points, target points, routing elevation, optional bounds, grid spacing, and spatial foundation obstacle AABBs.
- Generate orthogonal dry-run route candidates with length, elbow count, score, segments, and obstacle-intersection evidence.
- Return route candidates in a shape that can be reviewed by `evaluate_ducting_design`.
- Keep `revitWriteAction=none`.

## Engineering Scope

- This is a planner, not a Revit writer.
- The first solver routes each target independently from the best source.
- Obstacles are checked as expanded AABBs using clearance and duct half-height.
- Trunk sharing, fitting optimization, native duct sizing, and actual `Duct.Create` commit remain later gates.

## Review Fixes (Sprint 1.6)

Addresses the three gemini-code-assist review concerns on PR #23 without
changing the user-visible parameter semantics.

- **Per-run riser penalty (HIGH).** The A* state is now lifted to
  `(gridKey, arrivalDirection)` so `riserPenalty` is charged exactly once
  per vertical run (on the horizontal→vertical transition). This matches
  the final score formula
  `length/1000 + elbows·elbowPenalty + verticalRunCount·riserPenalty/1000`.
  Refining the Z grid no longer inflates the riser charge and therefore
  no longer biases multi-source selection.
- **Slab segment-AABB test (MEDIUM).** `segmentHitsObstacle` (now in
  `obstacleIndex.ts`) is a 3D slab-method intersection test. It is exact
  for both axis-aligned and 45° diagonal segments and replaces the
  conservative bounding-box overlap that produced false positives near
  obstacle corners when `allowDiagonal` was enabled.
- **Spatial obstacle index (MEDIUM).** New `obstacleIndex.ts` exports an
  `ObstacleIndex` abstraction with two backends:
  - `AabbTreeObstacleIndex` (default for production): bounding-volume
    hierarchy built via median-split on the longest axis. Point and
    segment queries traverse only nodes whose AABB intersects the query
    region.
  - `LinearObstacleIndex`: original O(N) scan, retained for tests,
    debugging, and tiny scenes.
  The planner exposes a new `obstacleIndexBackend` MCP input
  (`"aabb-tree"` default, `"linear"` opt-in). The two backends return
  identical block decisions; tests assert this for a representative
  scene.

## Spatial Zone Integration (Sprint 1.5)

The planner now consumes the JSON emitted by
`references/patterns/spatial-zone-extract.cs` directly:

- Pass the full payload as the new optional `spatialZone` input. The
  planner runs `mapSpatialZoneToRoutingContext` (exported from
  `installer/runtime-mcp-server/src/engineering/ducting/spatialZoneAdapter.ts`)
  and wires:
  - `spatialZone.obstacles[].aabb_mm` → planner obstacles. The
    `aabbFromValue` helper accepts the spatial-zone shape
    `{min:[x,y,z], max:[x,y,z], min_mm:[x,y,z], max_mm:[x,y,z]}` as well
    as the legacy `{minX, minY, minZ, ...}` form.
  - `spatialZone.plenum_volumes[].z_min_mm` / `z_max_mm` → automatic
    `allowedElevationsMm` when the caller did not supply one. The
    deduplicated set drives the 3D Z-grid.
  - `spatialZone.shafts[]` → echoed back in
    `summary.spatialZone.shafts` for orchestration layers. Shaft-aware
    A* biasing remains a later phase.
- User-supplied `obstacles` and `allowedElevationsMm` still win and are
  merged by id with the spatial-zone payload. Schema mismatches and
  unreadable AABBs are reported as `spatial_zone_*` engineering issues
  so the orchestrator can surface them to the human reviewer.

## Phase 2 in This Branch — 3D Pathfinding (Sprint 1)

Extends Phase 1's planner to a true 3D A* search while keeping the legacy 2D
behavior as the default when no new parameters are supplied.

New tool inputs:

- `allowedElevationsMm: number[]` — Explicit list of allowed routing elevations
  (plenum top, ceiling void, raised-floor cavity, intermediate riser stops).
  Two or more values activate vertical riser generation.
- `verticalStepMm: number` — Optional Z-axis refinement step between
  min/max allowed elevations (mm). `0` keeps only the supplied list.
- `riserPenalty: number` — Extra cost (mm) added to each Z move during A*
  search and as a tie-breaker in the final score. Default `0` preserves
  legacy 2D scoring exactly.
- `allowDiagonal: boolean` — Enables 8-way XY diagonal neighbors (45°
  elbows). Vertical moves remain pure-Z. Default `false`.

New report fields:

- `routes[].verticalRunCount`, `routes[].verticalRunLengthMm`
- `summary.allowedElevationsMm`, `summary.riserPenalty`,
  `summary.allowDiagonal`, `summary.totalVerticalRunCount`,
  `summary.totalVerticalRunLengthMm`

Behavioral notes:

- When `allowedElevationsMm` is omitted, the planner falls back to a
  single-elevation grid (derived from `routingElevationMm` or the source
  Z). The Z-axis has length 1 and no riser neighbors are generated, so the
  scoring and route geometry are bit-for-bit equivalent to Phase 1.
- Endpoints whose Z does not match an allowed elevation are snapped to the
  nearest allowed Z and a `route_endpoint_z_projected` warning is emitted.
  The Phase 1 warning code is preserved.
- Obstacle expansion still uses clearance + duct half-height on Z. Vertical
  segments are checked against the obstacle's expanded AABB the same way
  horizontal segments are.

## Reference Basis

- `RevitAirflowDesigner`: route option workflow and duct creation concept.
- `OpenMEP`: duct/pipe creation and connector API patterns for the future write phase.
- Current spatial foundation snippets: obstacle AABB extraction and plenum validation.
- Current ducting evaluator: route candidate review and commit gate.

## Next Phase

- Phase 3: Trunk/branch tree optimizer so shared trunks are preferred over
  independent branches (Steiner-heuristic over clustered targets).
- Phase 4: Multi-solution strategist (`shortest` / `least-elbow` /
  `max-clearance` profiles) producing Pareto-ranked alternatives.
- Preview visualization through safe Revit model lines or temporary detail
  elements.
- A separate gated Revit write tool that creates placeholder ducts first.
- Re-export connector graph after write and require connected-network plus
  native sizing validation before production commit.
