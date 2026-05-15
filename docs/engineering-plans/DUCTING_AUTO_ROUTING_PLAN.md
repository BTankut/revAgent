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

## Review Fixes (Sprint 1.25)

Round-18 review on PR #23 commit `70057af`. One Gemini medium
robustness fix; the other three findings are re-flags of items already
in the pending / deferred queues.

- **`segmentHitsObstacle` slab epsilon = 1 µm (Gemini medium).** The
  parallel-axis tolerance was `1e-9`, far below double-precision float
  drift at mm scale. A near-axis-aligned segment with `dir ≈ 1e-6`
  would slip through the "not parallel" branch and use a huge
  `1/dir`, producing numerically unstable `t1`/`t2`. Raised to a
  named `SLAB_PARALLEL_EPSILON_MM = 1e-3` (1 µm), matching the
  `GEOM_TOLERANCE_MM` convention the rest of the planner uses.
- _Not applied_ (re-flag of existing queue items):
  - `point()` allocation + heap object allocation — still in the
    Pending heavier-rewrites queue.
  - A* state vertical reversal (`ARRIVE_UP` vs `ARRIVE_DOWN`) — still
    in the Deferred routing-cost sprint.
  - `gridKey` overflow risk — theoretical (1 km bounds + 10 mm step
    is well under `Number.MAX_SAFE_INTEGER` at ~1e13); leaving as-is
    until a real workload reaches the limit.

## Review Fixes (Sprint 1.24)

Round-17 review on PR #23 commit `18be1cd`. Two small Gemini medium
fixes; one related Gemini HIGH (`point()` + heap object allocations)
remains in the pending heavier-rewrite queue.

- **`pointInsideBounds` uses `GEOM_TOLERANCE_MM` (Gemini medium).**
  The bounds check was strict inequality, so a point that lies
  exactly on a routing boundary could be rejected by floating-point
  drift introduced by the snap/round trip. Now matches the tolerance
  every other bounds check in the planner uses.
- **`buildAabbTreeNodeInRange` single AABB per node (Gemini medium).**
  The union loop was calling `unionAabb` per obstacle, allocating a
  fresh `{minX,...,maxZ}` object on every iteration (O(N) allocations
  per node, O(N log N) for the whole tree). Replaced with a
  single-pass min/max over local scalars and one final AABB literal
  per node.

## Review Fixes (Sprint 1.23)

Round-16 review on PR #23 commit `e4cda98`. One Codex P2 correctness
fix that closes two related preflight gaps the earlier snap fixes had
not reached.

- **Bounds preflight uses the refined Z grid (Codex P2).**
  `buildRouteFromSources` was snapping endpoints against the refined
  `effectiveGridZs` since Sprint 1.11, but two outer preflight checks
  still ran against the raw `allowedZs`:
  - the `route_elevation_outside_bounds` preflight rejected
    configurations like `allowed=[3000, 9000]`, `verticalStepMm=1000`,
    `bounds.z=[5500, 6500]` even though `z=6000` is a perfectly valid
    refined stop. It now passes when at least one effective Z lies
    inside bounds.
  - the source/target `route_*_outside_bounds` preflight snapped
    endpoints with the raw `allowedZs`, so a source at the refined
    `z=6000` was snapped to `z=3000` (or `z=9000`) and flagged
    outside the same `[5500, 6500]` bounds. The preflight now uses
    `effectiveGridZs(allowedZs, verticalStepMm)` so it matches the
    actual routing snap.
  Regression test asserts the `z=6000` refined-stop endpoint with
  tight `[5500, 6500]` bounds now produces a pass route.

## Review Fixes (Sprint 1.22)

Round-15 review on PR #23 commit `330a5fb`. Two small Gemini medium
allocation cleanups; no behaviour change.

- **`routeElbows` inline sign compare (Gemini medium).** The function
  built two `{x, y, z}` objects per junction (~3 N allocations for a
  path of length N) just to compare direction signs. The function now
  reads six local sign variables directly.
- **`partitionByCenter` tmp swaps (Gemini medium).** The AABB-tree
  build's three array-destructured swaps allocated a two-element
  intermediate each. Replaced with classic tmp swaps for parity with
  the Sprint 1.21 `MinHeap` cleanup.

## Review Fixes (Sprint 1.21)

Round-14 review on PR #23 commit `fce32cb`. Four small Gemini medium
fixes; no behaviour change, all assertions remain green.

- **MinHeap swap uses a tmp variable (Gemini medium ×2).** The push
  bubble-up and pop sift-down used array destructuring
  `[a, b] = [b, a]` which allocates an intermediate two-element array
  on every heap shuffle. Replaced with the classic three-line tmp
  swap on both call sites — same logic, no allocation.
- **Tighter admissible heuristic `hypot(Δx, Δy) + Δz` when
  `allowDiagonal=true` (Gemini medium).** Sprint 1.20 reverted to
  pure 3D Euclidean (`sqrt(dx² + dy² + dz²)`) after octile turned
  out to be inadmissible on the 1 mm-slack diagonal grid. Z moves
  are still pure-orthogonal (no XY+Z diagonal step exists), so the
  true minimum cost is `hypot(|Δx|, |Δy|) + |Δz|`. By Minkowski
  inequality that is `≥ sqrt(dx² + dy² + dz²)`, so it stays admissible
  while being a tighter lower bound and A* expands fewer nodes.
- **`Math.hypot` for the diagonal step cost (Gemini medium).**
  `Math.sqrt(dxStep² + dyStep²)` replaced with `Math.hypot(dxStep, dyStep)`
  on the A* edge-cost path. Same numerical result for our coordinate
  range, more idiomatic, overflow-robust on extreme inputs.

## Review Fixes (Sprint 1.20)

Round-13 review on PR #23 commit `6e3abcf`. One Codex P2 admissibility
fix that reverts a Sprint 1.12 over-optimisation plus two small Gemini
medium robustness fixes.

- **Heuristic reverted to Euclidean when `allowDiagonal=true`
  (Codex P2).** Sprint 1.12 switched from Euclidean to the octile
  `max + (√2-1)·min` heuristic on the assumption that diagonals are
  exactly `Δx == Δy`. The Sprint 1.7 / 1.8 tolerance gate actually
  admits `||Δx| - |Δy|| ≤ 1 mm`, so the true edge cost is
  `hypot(Δx, Δy)` and can be smaller than octile (e.g. Δx=1000, Δy=999
  → hypot=1413.51 < octile=1413.80). That makes octile inadmissible
  and lets A* pop a slightly worse target path before finding the
  cheaper one, producing non-minimum candidates. Reverting to
  Euclidean keeps the search admissible at the cost of a few extra
  expansions; the orthogonal-only case keeps Manhattan, which is
  exact and tight there.
- **Inferred-bounds halo for obstacle expansion (Gemini medium).**
  Before, when `routingBounds` was inferred (caller did not supply
  it), every obstacle whose Z range overlapped the route's plenum
  range pulled the grid outward, even if it sat 100 m from the
  source/target action zone. Now the expansion is gated by
  `action bbox ± marginMm`: obstacles outside that halo are ignored
  for bounds calculation, so big Revit models with distant obstacles
  no longer blow up the grid and search budget.
- **`MIN_GRID_STEP_MM` floor for `gridStepMm` / `verticalStepMm`
  (Gemini medium).** An accidental 0.1 mm step would turn
  `addRangeCoordinates` into a ~100 k-iteration loop with megabytes
  of `Set<number>` entries — a server-side foot-gun. Both inputs are
  now clamped to `MIN_GRID_STEP_MM = 10` (zero verticalStepMm is
  still honoured because it disables refinement entirely).

## Review Fixes (Sprint 1.19)

Round-12 review on PR #23 commit `c5f59df`. Three small Gemini medium
overflow-hardening fixes; no behaviour change.

- **`createCoordinateGrid` bounds without spread (Gemini medium ×2).**
  The X/Y bounds were computed via four separate
  `Math.min/max(...allPoints.map(...))` spreads, which crashes V8 with
  `RangeError: Maximum call stack size exceeded` past ≈120 k arguments.
  Replaced with a single in-place loop. The Z bounds (`Math.min/max
  (...allowedZs)`) hit the same risk but `allowedZs` is sorted, so we
  read `allowedZs[0]` and `allowedZs[length-1]` directly.
- **`effectiveGridZs` bounds without spread (Gemini medium).** Same
  fix in the snap-target builder: `allowedZs` is sorted ascending so
  the spread is replaced with first/last index access.

## Review Fixes (Sprint 1.18)

Round-11 review on PR #23 commit `fcacc59`. Two small Gemini medium
perf optimisations; no behaviour change.

- **Binary search in `findIndex` (Gemini medium).** The helper used
  `Array.prototype.findIndex`, an O(N) linear scan, even though
  `xs`/`ys`/`zs` are constructed by `createCoordinateGrid` via
  `Array.from(set).sort(...)` and are therefore monotonically
  increasing. The lookup is now a standard `Math.floor((lo+hi)/2)`
  binary search bounded by `GEOM_TOLERANCE_MM`, dropping the cost from
  O(N) to O(log N) per source/target index resolution.
- **Cached `xs.length` / `ys.length` / `zs.length` (Gemini medium).**
  The hot path was reading these properties on every neighbour bounds
  check and on every "is there a Z axis?" gate. The new `depth` local
  joins the existing `width` / `height` locals; the inner neighbour
  loop, the `evalNeighbor` bounds test, and the vertical-axis check
  all use the cached values.

## Review Fixes (Sprint 1.17)

Round-10 review on PR #23 commit `7358d77`. One Gemini HIGH
correctness fix and one small Gemini medium dead-carry cleanup.

- **`ductHalfWidthMm` parameter on X/Y obstacle expansion (Gemini
  HIGH).** `expandAabb` previously expanded obstacles by
  `clearanceMm + ductHalfHeightMm` on Z but only `clearanceMm` on
  X/Y, so the duct's physical half-width was silently ignored on the
  horizontal axes. A duct with a non-zero half-width could clip the
  obstacle face before the planner noticed. The MCP tool now accepts a
  new optional `ductHalfWidthMm` (default `0`, preserving legacy
  behaviour where the caller bakes the half-width into `clearanceMm`);
  `expandAabb` adds it to both X and Y. Z keeps using
  `ductHalfHeightMm`. Regression test asserts the per-axis expansion
  math directly via `readObstacles`.
- **Dead `defaultRouteZ` carry in `buildRouteFromSources` (Gemini
  medium).** The options type declared `defaultRouteZ: number` and the
  caller passed it through, but the function body never read it.
  Removed from both the type and the call site.

## Review Fixes (Sprint 1.16)

Round-9 review on PR #23 commit `9538b72`. One Codex P2 correctness
fix plus two small Gemini overflow-hardening fixes. The heavier
A* hot-path rewrites flagged by Gemini round-8 (point-allocation
reuse, typed-array A* state) are still on the next-sprint queue.

- **Explicit `routingElevationMm` wins over spatial-derived elevations
  (Codex P2).** When the caller supplied `routingElevationMm` and
  `spatialZone` but omitted `allowedElevationsMm`, the planner was
  reaching for `spatialContext.allowedElevationsMm` (derived from
  `plenum_volumes`), routing at e.g. `z=2800` even though the caller
  asked for `z=3200`. The new precedence — matching the schema
  contract — is:
    1. `input.allowedElevationsMm` (multi-elevation list)
    2. `input.routingElevationMm` (explicit single elevation)
    3. `spatialContext.allowedElevationsMm` (derived default)
    4. `[defaultRouteZ]` (heuristic fallback)
  A regression test asserts that `routingElevationMm: 3200` with a
  `plenum_volumes` of `2800..3600` and no `allowedElevationsMm` runs
  the route at `z=3200` with no projected-endpoint warning.
- **AABB-tree midpoint uses `Math.floor`, not bitwise shift (Gemini
  medium ×2).** `(lo + hi) >> 1` coerces to 32-bit signed and silently
  overflows past `2^31 − 1`. Replaced with `Math.floor((lo + hi) / 2)`
  in both `partitionByCenter` and `buildAabbTreeNodeInRange`. Practical
  impact is small (it would need >1 B obstacles to manifest) but the
  hardened form is cheap and unambiguous.

## Review Fixes (Sprint 1.15)

Round-8 review on PR #23 commit `bcbd5a4`. Four findings applied; two
heavier perf rewrites (point-allocation reuse, typed-array A* state) are
held over to Sprint 1.16 pending review.

- **Collapsed source/target route rejected (Codex P2).** When source
  and target snap to the same grid node `findGridPathFromSources`
  returned a one-point path; the old `=== 0` check only caught the
  empty-path failure mode so the planner emitted a `pass` candidate
  with `lengthMm: 0` and no segments. The check is now `< 2` and emits
  `route_not_found` with a `reason` context (`collapsed_to_single_point`
  or `no_path`), so the downstream evaluator no longer has to clean up
  a zero-length candidate.
- **Static neighbour-deltas (Gemini medium).** The 4-way / 8-way
  `[dx, dy]` arrays are now module-level `Object.freeze`d constants
  (`HORIZONTAL_NEIGHBORS_4WAY` / `HORIZONTAL_NEIGHBORS_8WAY`) instead
  of being allocated on every `findGridPathFromSources` invocation.
- **Step-cost without `Math.sqrt` for non-diagonal moves (Gemini
  medium).** `evalNeighbor` now computes the step cost from the move
  type: `|Δz|` for vertical moves, `|Δx|` or `|Δy|` for axis-aligned
  horizontal moves, and `sqrt(Δx² + Δy²)` only for XY diagonals. Same
  numerical result, but the majority of expansions avoid a sqrt.
- **Hoisted `currentG` / `currentSource` lookups (Gemini medium).**
  Both values are constant across all neighbours of an expansion. They
  are now read once outside the neighbour loop and passed to
  `evalNeighbor` as arguments, removing 4-6 redundant `Map.get` calls
  per expansion.

## Review Fixes (Sprint 1.14)

Round-7 review on PR #23 commit `9041b6f`. Two findings applied.

- **Endpoint Z snap respects the allowed-elevation contract
  (Codex P2).** Sprint 1.11 over-fixed Codex's round-4 finding by
  adding *any* in-bounds endpoint Z to `effectiveGridZs`, which made a
  source at e.g. `z=4750` (with `allowedElevationsMm: [3000, 6000]`,
  `verticalStepMm: 500`) snap to itself with no warning even though
  4750 is neither an allowed elevation nor a refined stop. The
  snap-target set is now strictly `allowed + verticalStepMm refined
  stops`; endpoints on those snap exactly (preserving the round-4 fix
  for `z=6000` with `verticalStepMm: 1000`), endpoints off them are
  projected to the nearest stop with `route_endpoint_z_projected`.
- **AABB tree construction with quickselect (Gemini medium).**
  `buildAabbTreeNode` used to call `slice().sort()` at every recursion
  level (O(N log² N) overall). The tree now partitions the obstacle
  array in place via a median-of-three quickselect on the splitting
  axis (expected O(N) per level, O(N log N) overall), so very large
  scenes pay a noticeably smaller setup cost. The block/no-block
  parity invariant with `LinearObstacleIndex` (see test at the bottom
  of `ducting-auto-routing.test.mjs`) continues to hold.

## Review Fixes (Sprint 1.13)

Round-6 Gemini review on PR #23 commit `8b729e4`. Three maintainability
/ perf refactors; no behaviour change, all assertions remain green.

- **`evalNeighbor` hoisted out of the while loop (Gemini medium).** The
  arrow function was being re-allocated for every expanded node (~25 k
  per A* run). It now lives outside the loop, closes over the
  search-wide state only, and receives the per-expansion state
  (`currentPoint`, `currentComp`, `currentArrival`) as parameters.
- **45° tolerance helper (Gemini medium).** The repeated
  `Math.abs(Math.abs(a) - Math.abs(b)) ≤ 1` check used in the neighbour
  gate and in `compressPath` is now a single `is45DegreeDiagonalXY`
  helper that both call.
- **Shared `GEOM_TOLERANCE_MM` constant (Gemini medium).** The hardcoded
  `0.001` geometric epsilon used across `verticalStats`,
  `addBoundedCoordinate`, `createCoordinateGrid`, `findIndex`,
  `effectiveGridZs`, and the bounds-check helper is now a single named
  constant declared at the top of the module. The 45° tolerance gets
  the same treatment via `DIAGONAL_45_TOLERANCE_MM`.

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
