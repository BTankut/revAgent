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

## Review Fixes (Sprint 1.12)

Round-5 Gemini review on PR #23 commit `d8fcbc7` re-flagged the two
deferred A*-state findings (vertical-reversal distinction, elbow
penalty in `stepCost`); both remain in the deferred routing-cost
sprint. One new finding was applied here.

- **Octile heuristic when `allowDiagonal` (Gemini medium).** The
  Sprint 1.8 switch to Euclidean made the heuristic admissible for
  8-way XY + pure-Z grids, but it under-uses the structure of the
  grid. Minimum achievable cost on an unobstructed 8-way XY +
  orthogonal-Z grid is `octile(|Δx|, |Δy|) + |Δz|` where
  `octile(a,b) = max(a,b) + (√2 − 1) · min(a,b)`; this stays admissible
  while being a tighter lower bound than Euclidean, so A* expands
  fewer nodes. Orthogonal-only paths keep the exact-and-tight
  Manhattan heuristic.

## Review Fixes (Sprint 1.11)

Round-4 review on PR #23 commit `fd9cee9`. Three of Gemini's perf
findings applied along with a Codex P2 correctness fix. Gemini's HIGH
finding on the A* state (vertical reversal not distinguished from a
single run) is rolled into the same deferred routing-cost sprint as
the elbow-penalty extension, since both require expanding the A*
state space and shifting route-selection baselines.

- **Allocation-free obstacle index hot path (Gemini medium).**
  `ObstacleIndex` gains `someCandidateForPoint(point, predicate)` and
  `someCandidateForSegment(start, end, predicate)`. The AABB-tree
  backend walks the tree and short-circuits on the first match without
  building an intermediate `candidates` array; `LinearObstacleIndex`
  short-circuits over its list with the same AABB pre-filter as the
  tree. `pointBlocked` / `segmentBlocked` inside the A* loop call the
  new predicate methods.
- **`LinearObstacleIndex` AABB pre-filter (Gemini medium).** The
  linear backend's `candidatesForPoint` / `candidatesForSegment` now
  apply the same AABB containment / intersection filter as the
  aabb-tree backend, instead of returning the entire obstacle list.
- **`neighborMoves` array eliminated (Gemini medium).** A* neighbour
  evaluation no longer builds a per-expansion
  `{ix,iy,iz,vertical}[]` array. Each neighbour is processed directly
  via a local helper, removing four-to-six object allocations per
  expansion on the hot loop.
- **Endpoint Z snap against the refined grid (Codex P2).**
  `createCoordinateGrid` builds zs from `allowedElevationsMm` plus the
  `verticalStepMm` refinement plus any in-bounds endpoint Z, but
  `snapPointToGridZ` was only snapping against the original
  `allowedZs`. An endpoint that lived on a refined elevation (or any
  in-bounds Z not on the user-supplied list) was therefore reported as
  projected and lost its riser tail. A new `effectiveGridZs` helper
  mirrors the grid logic exactly and is used for snapping; both the
  existing "endpoint outside the allowed range" warning case and the
  new in-bounds case are covered by tests.

## Review Fixes (Sprint 1.10)

Performance follow-ups from the round-3 Gemini review on PR #23 commit
`ef8c259`. No behaviour change; logic and assertions are identical.

- **Inlined slab-method axis loop (Gemini medium).**
  `segmentHitsObstacle` is on the A* hot path (called for every
  expanded edge through `candidatesForSegment`). The previous
  implementation built a 3-element array of `{s,e,lo,hi}` objects per
  call and iterated over it; this introduced measurable GC pressure
  on large scenes. The three axis slabs are now unrolled with stack
  locals, so the function is allocation-free.
- **Deduplicated `valueByFields` lookup in spatial-zone adapter
  (Gemini medium).** `mapSpatialZoneToRoutingContext` was calling
  `valueByFields(record, ["plenumVolumes", "plenum_volumes"])` twice
  for the same record. The result is now stored once.

## Review Fixes (Sprint 1.9)

Addresses two follow-up review findings on PR #23 commit `29db352`.
A third finding (elbow penalty missing from A* `stepCost`) is deferred
to a separate routing-cost sprint because it requires expanding the A*
state space and will shift route-selection baselines.

- **`verticalStats` defensive sign-aware counter (Gemini medium).**
  `compressPath` already collapses same-direction Z steps, so the
  per-run invariant test (`riserPerRunCoarse ≡ riserPerRunRefined`)
  passes with the existing logic. `verticalStats` now also tracks the
  previous vertical sign so the count remains correct when given
  uncompressed input and correctly treats an up→down reversal within a
  single shaft as two distinct runs.
- **`plan_ducting_auto_route` obstacle docs (Codex P2).** The schema
  description said "or flat `[minX,...,maxZ]`" which read as if the
  obstacle entry itself could be a flat array; Zod's
  `passthroughObject` and `asRecord` actually drop arrays silently.
  The description now spells out the supported forms explicitly:
  `{aabbMm: {minX,...,maxZ}}`, `{aabbMm: [minX,...,maxZ]}`,
  `{aabb_mm: {min:[x,y,z], max:[x,y,z]}}` — all of which `aabbFromValue`
  has always parsed.

## Review Fixes (Sprint 1.8)

Addresses two follow-up review findings on PR #23 commit `001607a`.

- **Cumulative 45° tolerance in compression (Codex P2).** The per-step
  diagonal gate (Sprint 1.7) admits a 1 mm slack to absorb off-pitch
  detour coordinates from obstacle edges. `compressPath` now re-checks
  the cumulative `||Δx| - |Δy|| ≤ 1 mm` invariant across the merged
  span before dropping a diagonal junction, so several individually
  accepted steps cannot collapse into an arbitrary-angle segment.
  Pure axis-aligned merges remain unconditional.
- **Euclidean heuristic when `allowDiagonal` (Gemini medium).** The A*
  heuristic was Manhattan in 3D, which over-estimates the true cost of
  45° XY diagonals (`s·√2 < 2s`) and can therefore explore suboptimal
  paths. `findGridPathFromSources` now uses `pointDistanceMm` (Euclidean)
  when diagonals are enabled and keeps Manhattan for the orthogonal-only
  case where it is both admissible and more informed.

## Review Fixes (Sprint 1.7)

Addresses the two P2 chatgpt-codex-connector review concerns on PR #23.

- **Diagonal 45° tolerance gate (P2).** When `allowDiagonal` is enabled
  the search now skips a diagonal neighbour unless
  `|Δx| ≈ |Δy|` in world space (1 mm tolerance). Previously the grid was
  built from regular pitch plus off-pitch source/target snaps and
  obstacle detour points (`expanded.minX ± 1`), so naive index pairing
  could emit arbitrary-angle segments even though the tool contract
  advertises 45° elbows. Axis-aligned neighbours always cover the same
  cell, so feasibility is preserved.
- **Spatial-zone error propagation (P2).** `mapSpatialZoneToRoutingContext`
  now reads the payload-level `errors` and `warnings` arrays emitted by
  `references/patterns/spatial-zone-extract.cs` (including the failure
  payload of empty geometry + populated `errors`). Payload errors surface
  as `severity: "error"` issues with code
  `spatial_zone_extract_error`; warnings surface as `severity: "warning"`
  issues with code `spatial_zone_extract_warning`. The planner's existing
  error-gating naturally prevents a failed extraction from producing
  reviewable "pass" route candidates.

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
