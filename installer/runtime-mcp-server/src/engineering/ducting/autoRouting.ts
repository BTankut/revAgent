import {
    aabbFromValue,
    asBoolean,
    asNumber,
    asRecord,
    makeIssue,
    pointDistanceMm,
    pointFromValue,
    round,
    stringByFields,
    validationStatus,
    valueByFields,
} from "./helpers.js";
import {
    buildObstacleIndex,
    pointInsideObstacle,
    readObstacles,
    segmentHitsObstacle,
    type ObstacleAabb,
    type ObstacleIndex,
    type ObstacleIndexBackend,
} from "./obstacleIndex.js";
import { mapSpatialZoneToRoutingContext, type SpatialZoneRoutingContext } from "./spatialZoneAdapter.js";
import type { AabbMm, EngineeringIssue, PointMm } from "./types.js";

// Geometric epsilon used for "same point / same coordinate" comparisons across
// the planner (Z-equality checks, grid-index lookup, bounds tolerance, etc).
// 1 µm is well below any modelling precision Revit produces.
const GEOM_TOLERANCE_MM = 0.001;
// Per-step and cumulative tolerance for the 45° XY-diagonal contract.
// The grid contains off-pitch detour coordinates (obstacle expanded.minX ± 1,
// endpoint snaps), so a strict |Δx| === |Δy| check would discard legitimate
// neighbours; 1 mm absorbs those snaps without admitting arbitrary-angle
// segments.
const DIAGONAL_45_TOLERANCE_MM = 1;

function is45DegreeDiagonalXY(dxMm: number, dyMm: number): boolean {
    return Math.abs(Math.abs(dxMm) - Math.abs(dyMm)) <= DIAGONAL_45_TOLERANCE_MM;
}

// Static neighbour deltas — defined once at module load instead of per
// findGridPathFromSources call. Frozen so consumers cannot accidentally
// mutate the shared array.
const HORIZONTAL_NEIGHBORS_4WAY: ReadonlyArray<readonly [number, number]> = Object.freeze([
    [-1, 0], [1, 0], [0, -1], [0, 1],
]);
const HORIZONTAL_NEIGHBORS_8WAY: ReadonlyArray<readonly [number, number]> = Object.freeze([
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
]);

export interface DuctAutoRoutingInput {
    sources?: Record<string, unknown>[];
    targets?: Record<string, unknown>[];
    obstacles?: Record<string, unknown>[];
    spatialZone?: Record<string, unknown>;
    routingBounds?: Record<string, unknown>;
    routingElevationMm?: number;
    allowedElevationsMm?: number[];
    gridStepMm?: number;
    verticalStepMm?: number;
    clearanceMm?: number;
    ductHalfWidthMm?: number;
    ductHalfHeightMm?: number;
    boundaryMarginMm?: number;
    maxNodeExpansions?: number;
    routeElbowPenalty?: number;
    riserPenalty?: number;
    allowDiagonal?: boolean;
    obstacleIndexBackend?: ObstacleIndexBackend;
}

interface RouteEndpoint {
    id: string;
    point: PointMm;
    raw: Record<string, unknown>;
}

interface PlannedRoute {
    id: string;
    status: "pass" | "fail";
    sourceId: string;
    targetId: string;
    pointsMm: PointMm[];
    segmentsMm: Array<{ startMm: PointMm; endMm: PointMm; lengthMm: number }>;
    lengthMm: number;
    elbowCount: number;
    verticalRunCount: number;
    verticalRunLengthMm: number;
    score: number;
    obstacleIntersections: Array<Record<string, unknown>>;
    issues: EngineeringIssue[];
}

export interface DuctAutoRoutingReport {
    schemaVersion: "ducting-auto-route-plan.v1";
    workflow: {
        revitWriteAction: "none";
        nextAllowedAction: "review_route_candidates" | "fix_inputs";
    };
    summary: Record<string, unknown>;
    routes: PlannedRoute[];
    routeCandidates: Record<string, unknown>[];
    issues: EngineeringIssue[];
}

function pointFromRecord(record: Record<string, unknown>): PointMm | undefined {
    return pointFromValue(valueByFields(record, ["pointMm", "point_mm", "point", "locationMm", "location_mm", "location"]))
        ?? pointFromValue(record);
}

function readEndpoint(raw: Record<string, unknown>, fallbackId: string): RouteEndpoint | undefined {
    const point = pointFromRecord(raw);
    if (!point) return undefined;
    return {
        id: stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id", "name"]) ?? fallbackId,
        point,
        raw,
    };
}

function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
    return Math.max(aMin, bMin) <= Math.min(aMax, bMax);
}

function routeObstacleHits(points: PointMm[], index: ObstacleIndex): Array<Record<string, unknown>> {
    const hits: Array<Record<string, unknown>> = [];
    for (let i = 1; i < points.length; i++) {
        const start = points[i - 1];
        const end = points[i];
        for (const obstacle of index.candidatesForSegment(start, end)) {
            if (segmentHitsObstacle(start, end, obstacle)) {
                hits.push({
                    obstacleId: obstacle.id,
                    obstacleName: obstacle.name,
                    segmentIndex: i - 1,
                });
            }
        }
    }
    return hits;
}

function routeLength(points: PointMm[]): number {
    let total = 0;
    for (let index = 1; index < points.length; index++) total += pointDistanceMm(points[index - 1], points[index]);
    return total;
}

function routeElbows(points: PointMm[]): number {
    let count = 0;
    for (let index = 2; index < points.length; index++) {
        const a = points[index - 2];
        const b = points[index - 1];
        const c = points[index];
        const left = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y), z: Math.sign(b.z - a.z) };
        const right = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y), z: Math.sign(c.z - b.z) };
        if (left.x !== right.x || left.y !== right.y || left.z !== right.z) count++;
    }
    return count;
}

function verticalStats(points: PointMm[]): { runCount: number; runLengthMm: number } {
    let runCount = 0;
    let runLengthMm = 0;
    // `compressPath` already collapses same-direction Z steps, but we still
    // track the previous vertical sign so the count is robust to uncompressed
    // input and correctly treats a direction reversal (up→down within the same
    // shaft, no horizontal break) as two distinct runs.
    let previousVerticalSign = 0;
    for (let index = 1; index < points.length; index++) {
        const dz = points[index].z - points[index - 1].z;
        if (Math.abs(dz) > GEOM_TOLERANCE_MM) {
            const sign = Math.sign(dz);
            if (sign !== previousVerticalSign) runCount++;
            previousVerticalSign = sign;
            runLengthMm += Math.abs(dz);
        } else {
            previousVerticalSign = 0;
        }
    }
    return { runCount, runLengthMm };
}

function compressPath(points: PointMm[]): PointMm[] {
    if (points.length <= 2) return points;
    const result: PointMm[] = [points[0]];
    for (let index = 1; index < points.length - 1; index++) {
        const previous = result[result.length - 1];
        const current = points[index];
        const next = points[index + 1];
        const dxLeft = Math.sign(current.x - previous.x);
        const dyLeft = Math.sign(current.y - previous.y);
        const dzLeft = Math.sign(current.z - previous.z);
        const dxRight = Math.sign(next.x - current.x);
        const dyRight = Math.sign(next.y - current.y);
        const dzRight = Math.sign(next.z - current.z);
        if (dxLeft === dxRight && dyLeft === dyRight && dzLeft === dzRight) {
            // Pure axis-aligned moves can be merged unconditionally. XY diagonals
            // also need the cumulative |Δx|≈|Δy| invariant: the per-step neighbor
            // gate admits a 1 mm slack to absorb off-pitch detour coordinates,
            // and that slack must not accumulate across a merged span into an
            // arbitrary-angle segment.
            const xyDiagonal = dxLeft !== 0 && dyLeft !== 0;
            if (!xyDiagonal || is45DegreeDiagonalXY(next.x - previous.x, next.y - previous.y)) continue;
        }
        result.push(current);
    }
    result.push(points[points.length - 1]);
    return result;
}

function buildSegments(points: PointMm[]): Array<{ startMm: PointMm; endMm: PointMm; lengthMm: number }> {
    const segments: Array<{ startMm: PointMm; endMm: PointMm; lengthMm: number }> = [];
    for (let index = 1; index < points.length; index++) {
        segments.push({
            startMm: points[index - 1],
            endMm: points[index],
            lengthMm: round(pointDistanceMm(points[index - 1], points[index])),
        });
    }
    return segments;
}

function addRangeCoordinates(values: Set<number>, min: number, max: number, step: number): void {
    values.add(round(min));
    values.add(round(max));
    const start = Math.ceil(min / step) * step;
    const end = Math.floor(max / step) * step;
    for (let value = start; value <= end + GEOM_TOLERANCE_MM; value += step) values.add(round(value));
}

function addBoundedCoordinate(values: Set<number>, value: number, min: number, max: number): void {
    if (value >= min - GEOM_TOLERANCE_MM && value <= max + GEOM_TOLERANCE_MM) values.add(round(value));
}

function sortedNumbers(values: Set<number>): number[] {
    return Array.from(values).sort((left, right) => left - right);
}

interface CoordinateGrid {
    xs: number[];
    ys: number[];
    zs: number[];
}

function createCoordinateGrid(
    sources: PointMm[],
    target: PointMm,
    obstacles: ObstacleAabb[],
    bounds: AabbMm | undefined,
    gridStepMm: number,
    verticalStepMm: number,
    marginMm: number,
    allowedZs: number[],
): CoordinateGrid {
    const allPoints = [...sources, target];
    // Single-pass min/max so the bounds calculation never spreads a large array
    // into Math.min/max (V8 stack overflow risk past ~120 k arguments).
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of allPoints) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    // allowedZs is monotonically ascending (createCoordinateGrid is the only
    // call site and it always passes a sorted-unique array).
    const zMin = allowedZs[0];
    const zMax = allowedZs[allowedZs.length - 1];

    // Snapshot the source/target bbox before obstacles can pull it outward;
    // we use it to ignore obstacles that sit far from the actual action zone
    // when `bounds` is inferred. Otherwise a beam 100 m away from the route
    // corridor would still grow the grid and waste search budget.
    const actionMinX = minX;
    const actionMaxX = maxX;
    const actionMinY = minY;
    const actionMaxY = maxY;
    const inferredHalo = marginMm;

    for (const obstacle of obstacles) {
        if (!overlap1d(obstacle.expanded.minZ, obstacle.expanded.maxZ, zMin, zMax)) continue;
        if (!bounds) {
            // Ignore obstacles outside the action bbox + halo; they cannot
            // constrain a route from sources to target and would otherwise
            // inflate the grid on large Revit models.
            if (obstacle.expanded.maxX < actionMinX - inferredHalo) continue;
            if (obstacle.expanded.minX > actionMaxX + inferredHalo) continue;
            if (obstacle.expanded.maxY < actionMinY - inferredHalo) continue;
            if (obstacle.expanded.minY > actionMaxY + inferredHalo) continue;
        }
        minX = Math.min(minX, obstacle.expanded.minX);
        maxX = Math.max(maxX, obstacle.expanded.maxX);
        minY = Math.min(minY, obstacle.expanded.minY);
        maxY = Math.max(maxY, obstacle.expanded.maxY);
    }

    if (bounds) {
        minX = bounds.minX;
        maxX = bounds.maxX;
        minY = bounds.minY;
        maxY = bounds.maxY;
    } else {
        minX -= marginMm;
        maxX += marginMm;
        minY -= marginMm;
        maxY += marginMm;
    }

    const xs = new Set<number>();
    const ys = new Set<number>();
    addRangeCoordinates(xs, minX, maxX, gridStepMm);
    addRangeCoordinates(ys, minY, maxY, gridStepMm);
    for (const source of sources) {
        addBoundedCoordinate(xs, source.x, minX, maxX);
        addBoundedCoordinate(ys, source.y, minY, maxY);
    }
    xs.add(round(target.x));
    ys.add(round(target.y));

    const detourOffsetMm = 1;
    for (const obstacle of obstacles) {
        if (!overlap1d(obstacle.expanded.minZ, obstacle.expanded.maxZ, zMin, zMax)) continue;
        addBoundedCoordinate(xs, obstacle.expanded.minX - detourOffsetMm, minX, maxX);
        addBoundedCoordinate(xs, obstacle.expanded.maxX + detourOffsetMm, minX, maxX);
        addBoundedCoordinate(ys, obstacle.expanded.minY - detourOffsetMm, minY, maxY);
        addBoundedCoordinate(ys, obstacle.expanded.maxY + detourOffsetMm, minY, maxY);
    }

    const zs = new Set<number>();
    for (const z of allowedZs) zs.add(round(z));
    if (allowedZs.length === 1) {
        // Single-elevation grid → preserves 2D behavior.
    } else if (verticalStepMm > 0) {
        addRangeCoordinates(zs, zMin, zMax, verticalStepMm);
    }
    for (const source of sources) {
        if (source.z >= zMin - GEOM_TOLERANCE_MM && source.z <= zMax + GEOM_TOLERANCE_MM) zs.add(round(source.z));
    }
    if (target.z >= zMin - GEOM_TOLERANCE_MM && target.z <= zMax + GEOM_TOLERANCE_MM) zs.add(round(target.z));

    return { xs: sortedNumbers(xs), ys: sortedNumbers(ys), zs: sortedNumbers(zs) };
}

class MinHeap {
    private readonly values: Array<{ key: number; priority: number }> = [];

    get length(): number {
        return this.values.length;
    }

    push(item: { key: number; priority: number }): void {
        this.values.push(item);
        this.bubbleUp(this.values.length - 1);
    }

    pop(): { key: number; priority: number } | undefined {
        if (this.values.length === 0) return undefined;
        const result = this.values[0];
        const tail = this.values.pop()!;
        if (this.values.length > 0) {
            this.values[0] = tail;
            this.sinkDown(0);
        }
        return result;
    }

    private bubbleUp(index: number): void {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.values[parent].priority <= this.values[index].priority) break;
            [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
            index = parent;
        }
    }

    private sinkDown(index: number): void {
        while (true) {
            const left = index * 2 + 1;
            const right = index * 2 + 2;
            let smallest = index;
            if (left < this.values.length && this.values[left].priority < this.values[smallest].priority) smallest = left;
            if (right < this.values.length && this.values[right].priority < this.values[smallest].priority) smallest = right;
            if (smallest === index) break;
            [this.values[smallest], this.values[index]] = [this.values[index], this.values[smallest]];
            index = smallest;
        }
    }
}

function pointInsideBounds(point: PointMm, bounds: AabbMm | undefined): boolean {
    if (!bounds) return true;
    return point.x >= bounds.minX
        && point.x <= bounds.maxX
        && point.y >= bounds.minY
        && point.y <= bounds.maxY
        && point.z >= bounds.minZ
        && point.z <= bounds.maxZ;
}

interface PathSearchOptions {
    bounds?: AabbMm;
    gridStepMm: number;
    verticalStepMm: number;
    marginMm: number;
    maxExpansions: number;
    riserPenalty: number;
    allowDiagonal: boolean;
    allowedZs: number[];
}

function findGridPathFromSources(
    sources: PointMm[],
    target: PointMm,
    obstacleIndex: ObstacleIndex,
    options: PathSearchOptions,
): { points: PointMm[]; sourceIndex?: number; expansions: number; exhausted: boolean } {
    const validSources = sources
        .map((source, index) => ({ source, index }))
        .filter((entry) => pointInsideBounds(entry.source, options.bounds));
    if (!pointInsideBounds(target, options.bounds) || validSources.length === 0) {
        return { points: [], expansions: 0, exhausted: false };
    }

    const grid = createCoordinateGrid(
        validSources.map((entry) => entry.source),
        target,
        obstacleIndex.obstacles(),
        options.bounds,
        options.gridStepMm,
        options.verticalStepMm,
        options.marginMm,
        options.allowedZs,
    );
    const { xs, ys, zs } = grid;
    if (xs.length === 0 || ys.length === 0 || zs.length === 0) {
        return { points: [], expansions: 0, exhausted: false };
    }

    const width = xs.length;
    const height = ys.length;
    const depth = zs.length;
    const gridKey = (ix: number, iy: number, iz: number) => (iz * height + iy) * width + ix;
    const ixFromGridKey = (value: number) => value % width;
    const iyFromGridKey = (value: number) => Math.floor(value / width) % height;
    const izFromGridKey = (value: number) => Math.floor(value / (width * height));
    const point = (ix: number, iy: number, iz: number): PointMm => ({ x: xs[ix], y: ys[iy], z: zs[iz] });

    // State expansion: each grid cell carries two A* states based on how it was reached.
    // 0 = arrived horizontally (or starting source), 1 = arrived via a vertical step.
    // The riser penalty is charged exactly once per vertical run by adding it on the
    // transition from arrival state 0 → arrival state 1.
    const ARRIVE_HORIZ = 0;
    const ARRIVE_VERT = 1;
    const compose = (gk: number, arrival: number) => gk * 2 + arrival;
    const gridFromComposite = (comp: number) => Math.floor(comp / 2);
    const arrivalFromComposite = (comp: number) => comp % 2;

    // Binary search the sorted coordinate array for `target` within
    // GEOM_TOLERANCE_MM. xs/ys/zs are built monotonically by createCoordinateGrid
    // (set → Array.from → sort ascending), so the O(log N) probe is correct.
    const findIndex = (values: number[], target: number): number => {
        let lo = 0;
        let hi = values.length - 1;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const value = values[mid];
            if (Math.abs(value - target) < GEOM_TOLERANCE_MM) return mid;
            if (value < target) lo = mid + 1;
            else hi = mid - 1;
        }
        return -1;
    };
    const targetIx = findIndex(xs, target.x);
    const targetIy = findIndex(ys, target.y);
    const targetIz = findIndex(zs, target.z);
    if (targetIx < 0 || targetIy < 0 || targetIz < 0) return { points: [], expansions: 0, exhausted: false };
    const targetGridKey = gridKey(targetIx, targetIy, targetIz);

    const pointBlocked = (candidate: PointMm) =>
        obstacleIndex.someCandidateForPoint(candidate, (obstacle) => pointInsideObstacle(candidate, obstacle));
    const segmentBlocked = (left: PointMm, right: PointMm) =>
        obstacleIndex.someCandidateForSegment(left, right, (obstacle) => segmentHitsObstacle(left, right, obstacle));
    if (pointBlocked(target)) return { points: [], expansions: 0, exhausted: false };

    const open = new MinHeap();
    const cameFrom = new Map<number, number>();
    const sourceForKey = new Map<number, number>();
    const gScore = new Map<number, number>();
    const closed = new Set<number>();
    // Heuristic admissibility:
    //   - Orthogonal-only grid: Manhattan is exact and tight.
    //   - With 8-way XY diagonals + pure-Z verticals: we must stay below the
    //     true edge cost. Sprint 1.12 tried octile because it is tighter than
    //     Euclidean on equal-pitch diagonals, but the neighbour gate accepts
    //     `|Δx| ≈ |Δy|` within DIAGONAL_45_TOLERANCE_MM, so the actual edge
    //     cost is `hypot(Δx, Δy)`. Octile's `max + (√2-1)·min` can exceed
    //     hypot for those 1 mm-slack diagonals (e.g. Δx=1000, Δy=999 →
    //     hypot=1413.51 < octile=1413.80), which makes it inadmissible and
    //     lets A* return non-minimum paths. Reverting to Euclidean keeps the
    //     search admissible at the cost of a few extra expansions.
    const heuristic = (candidate: PointMm) => {
        const dx = Math.abs(candidate.x - target.x);
        const dy = Math.abs(candidate.y - target.y);
        const dz = Math.abs(candidate.z - target.z);
        if (!options.allowDiagonal) return dx + dy + dz;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };

    for (const entry of validSources) {
        const sourceIx = findIndex(xs, entry.source.x);
        const sourceIy = findIndex(ys, entry.source.y);
        const sourceIz = findIndex(zs, entry.source.z);
        if (sourceIx < 0 || sourceIy < 0 || sourceIz < 0 || pointBlocked(entry.source)) continue;
        const sourceComp = compose(gridKey(sourceIx, sourceIy, sourceIz), ARRIVE_HORIZ);
        const existingG = gScore.get(sourceComp);
        if (existingG !== undefined && existingG <= 0) continue;
        sourceForKey.set(sourceComp, entry.index);
        gScore.set(sourceComp, 0);
        open.push({ key: sourceComp, priority: heuristic(entry.source) });
    }
    if (open.length === 0) return { points: [], expansions: 0, exhausted: false };

    const horizontalNeighbors = options.allowDiagonal
        ? HORIZONTAL_NEIGHBORS_8WAY
        : HORIZONTAL_NEIGHBORS_4WAY;

    // evalNeighbor is hoisted out of the while-loop so the closure is allocated
    // once per A* run instead of once per expansion (~25 k allocations). It
    // closes over the search-wide state (xs/ys/zs, maps, options, heuristic);
    // the per-expansion state is passed as parameters, including `currentG`
    // (gScore lookup for currentComp, hoisted once per expansion so we don't
    // pay a Map.get per neighbour) and `currentSource` (same for sourceForKey).
    const evalNeighbor = (
        nIx: number, nIy: number, nIz: number, vertical: boolean,
        currentPoint: PointMm, currentComp: number, currentArrival: number,
        currentG: number, currentSource: number,
    ): void => {
        if (nIx < 0 || nIy < 0 || nIz < 0 || nIx >= width || nIy >= height || nIz >= depth) return;
        const neighborArrival = vertical ? ARRIVE_VERT : ARRIVE_HORIZ;
        const neighborComp = compose(gridKey(nIx, nIy, nIz), neighborArrival);
        if (closed.has(neighborComp)) return;
        const neighborPoint = point(nIx, nIy, nIz);
        if (pointBlocked(neighborPoint) || segmentBlocked(currentPoint, neighborPoint)) return;
        // Per-run riser penalty: charged once when transitioning into a vertical run.
        const startingRiser = vertical && currentArrival !== ARRIVE_VERT;
        const transitionPenalty = startingRiser ? options.riserPenalty : 0;
        // Step cost without Math.sqrt for axis-aligned and pure-vertical moves
        // (the majority). Math.sqrt is kept for XY diagonals where it is exact.
        let stepCost: number;
        if (vertical) {
            stepCost = Math.abs(neighborPoint.z - currentPoint.z);
        } else {
            const dxStep = Math.abs(neighborPoint.x - currentPoint.x);
            const dyStep = Math.abs(neighborPoint.y - currentPoint.y);
            if (dxStep < GEOM_TOLERANCE_MM) stepCost = dyStep;
            else if (dyStep < GEOM_TOLERANCE_MM) stepCost = dxStep;
            else stepCost = Math.sqrt(dxStep * dxStep + dyStep * dyStep);
        }
        stepCost += transitionPenalty;
        const tentative = currentG + stepCost;
        if (tentative >= (gScore.get(neighborComp) ?? Number.POSITIVE_INFINITY)) return;
        cameFrom.set(neighborComp, currentComp);
        sourceForKey.set(neighborComp, currentSource);
        gScore.set(neighborComp, tentative);
        open.push({ key: neighborComp, priority: tentative + heuristic(neighborPoint) });
    };

    let expansions = 0;
    while (open.length > 0) {
        const currentComp = open.pop()!.key;
        if (closed.has(currentComp)) continue;
        const currentGridKey = gridFromComposite(currentComp);
        const currentArrival = arrivalFromComposite(currentComp);
        if (currentGridKey === targetGridKey) {
            const pathComps = [currentComp];
            let cursor = currentComp;
            while (cameFrom.has(cursor)) {
                cursor = cameFrom.get(cursor)!;
                pathComps.push(cursor);
            }
            pathComps.reverse();
            const selectedSourceIndex = sourceForKey.get(pathComps[0]);
            const pathPoints = pathComps.map((entry) => {
                const gk = gridFromComposite(entry);
                return point(ixFromGridKey(gk), iyFromGridKey(gk), izFromGridKey(gk));
            });
            return {
                points: compressPath(pathPoints),
                sourceIndex: selectedSourceIndex,
                expansions,
                exhausted: false,
            };
        }
        closed.add(currentComp);
        expansions++;
        if (expansions > options.maxExpansions) return { points: [], expansions, exhausted: true };

        const ix = ixFromGridKey(currentGridKey);
        const iy = iyFromGridKey(currentGridKey);
        const iz = izFromGridKey(currentGridKey);
        const currentPoint = point(ix, iy, iz);
        // Hoisted once per expansion so the inner evalNeighbor does not repeat
        // a Map.get / coalesce per neighbour (4-6 redundant lookups per
        // expansion otherwise).
        const currentG = gScore.get(currentComp) ?? Number.POSITIVE_INFINITY;
        const currentSource = sourceForKey.get(currentComp) ?? 0;

        for (const [dx, dy] of horizontalNeighbors) {
            const newIx = ix + dx;
            const newIy = iy + dy;
            if (dx !== 0 && dy !== 0) {
                // Diagonal moves are advertised as 45° elbows, but the grid is non-uniform
                // (obstacle detour points and endpoint snapping insert off-pitch coordinates).
                // Skip the diagonal unless |Δx| ≈ |Δy| in world space; the four axis-aligned
                // moves still cover this neighbor.
                if (newIx < 0 || newIx >= width || newIy < 0 || newIy >= height) continue;
                if (!is45DegreeDiagonalXY(xs[newIx] - xs[ix], ys[newIy] - ys[iy])) continue;
            }
            evalNeighbor(newIx, newIy, iz, false, currentPoint, currentComp, currentArrival, currentG, currentSource);
        }
        if (depth > 1) {
            evalNeighbor(ix, iy, iz - 1, true, currentPoint, currentComp, currentArrival, currentG, currentSource);
            evalNeighbor(ix, iy, iz + 1, true, currentPoint, currentComp, currentArrival, currentG, currentSource);
        }
    }
    return { points: [], expansions, exhausted: false };
}

function nearestAllowedZ(z: number, allowedZs: number[]): number {
    let best = allowedZs[0];
    let bestDelta = Math.abs(z - best);
    for (const candidate of allowedZs) {
        const delta = Math.abs(z - candidate);
        if (delta < bestDelta) {
            best = candidate;
            bestDelta = delta;
        }
    }
    return best;
}

function snapPointToGridZ(point: PointMm, allowedZs: number[]): { point: PointMm; projected: boolean } {
    const nearest = nearestAllowedZ(point.z, allowedZs);
    if (Math.abs(nearest - point.z) <= 1) return { point: { x: point.x, y: point.y, z: nearest }, projected: false };
    return { point: { x: point.x, y: point.y, z: nearest }, projected: true };
}

function effectiveGridZs(allowedZs: number[], verticalStepMm: number): number[] {
    // The snap target = allowed elevations + verticalStepMm refined stops only.
    // Arbitrary in-bounds endpoint Zs are NOT added here: that would let a
    // source at e.g. z=4750 (with allowed=[3000,6000], verticalStepMm=500)
    // snap to itself with no projected-endpoint warning, producing a route
    // at an elevation the caller never approved. Off-grid endpoints must
    // continue to project to the nearest allowed / refined stop.
    const zs = new Set<number>();
    for (const z of allowedZs) zs.add(round(z));
    if (allowedZs.length > 1 && verticalStepMm > 0) {
        // allowedZs is sorted ascending (readAllowedElevations / uniqueSortedRounded
        // both guarantee this), so the bounds are just the first/last entries.
        const zMin = allowedZs[0];
        const zMax = allowedZs[allowedZs.length - 1];
        addRangeCoordinates(zs, zMin, zMax, verticalStepMm);
    }
    return Array.from(zs).sort((a, b) => a - b);
}

function buildRouteFromSources(
    sources: RouteEndpoint[],
    target: RouteEndpoint,
    obstacleIndex: ObstacleIndex,
    options: PathSearchOptions & { elbowPenalty: number },
): PlannedRoute {
    // Snap against the refined Z grid (allowedZs + verticalStepMm stops).
    // Endpoints that land exactly on an allowed elevation or a refined stop
    // snap to themselves (no warning); endpoints between stops are projected
    // to the nearest stop with `route_endpoint_z_projected` — including the
    // legitimate "in-bounds but off-grid" case, since routing at an
    // unapproved elevation would violate the allowed-elevation contract.
    const snapZs = effectiveGridZs(options.allowedZs, options.verticalStepMm);
    const projectedSources = sources.map((source) => {
        const snapped = snapPointToGridZ(source.point, snapZs);
        return { id: source.id, point: snapped.point, projected: snapped.projected, raw: source.raw };
    });
    const snappedTarget = snapPointToGridZ(target.point, snapZs);
    const path = findGridPathFromSources(
        projectedSources.map((entry) => entry.point),
        snappedTarget.point,
        obstacleIndex,
        options,
    );
    const sourceEntry = path.sourceIndex !== undefined ? projectedSources[path.sourceIndex] : projectedSources[0];
    const issues: EngineeringIssue[] = [];
    const sourceProjected = sourceEntry?.projected ?? false;
    if (sourceProjected || snappedTarget.projected) {
        issues.push(makeIssue("route_endpoint_z_projected", "warning", "Endpoint was projected to the nearest allowed routing elevation; vertical riser/drop tail beyond the grid is not generated in this dry-run planner.", {
            sourceId: sourceEntry?.id,
            targetId: target.id,
            allowedElevationsMm: options.allowedZs.slice(),
            sourceProjected,
            targetProjected: snappedTarget.projected,
        }));
    }
    if (path.exhausted) {
        issues.push(makeIssue("route_search_limit_exceeded", "error", "Auto-routing search exceeded maxNodeExpansions.", {
            sourceId: sourceEntry?.id,
            targetId: target.id,
            maxNodeExpansions: options.maxExpansions,
        }));
    }
    if (path.points.length < 2) {
        // A single-point path means source and target collapsed to the same
        // grid node (e.g. both endpoints projected to the same elevation, or
        // the caller supplied identical XYZ for source and target). The
        // resulting "route" has lengthMm=0 and no segments, so we reject it
        // here rather than letting it propagate as a pass candidate that the
        // downstream evaluator will refuse with route_length_invalid.
        issues.push(makeIssue("route_not_found", "error", "No usable route was generated between source and target.", {
            sourceIds: sources.map((entry) => entry.id),
            targetId: target.id,
            reason: path.points.length === 1 ? "collapsed_to_single_point" : "no_path",
        }));
    }

    const hits = path.points.length > 0 ? routeObstacleHits(path.points, obstacleIndex) : [];
    if (hits.length > 0) {
        issues.push(makeIssue("route_obstacle_intersection", "error", "Generated route intersects expanded obstacle clearance volume.", {
            sourceId: sourceEntry?.id,
            targetId: target.id,
            hitCount: hits.length,
        }));
    }
    const lengthMm = path.points.length > 0 ? routeLength(path.points) : 0;
    const elbowCount = path.points.length > 0 ? routeElbows(path.points) : 0;
    const verticals = path.points.length > 0 ? verticalStats(path.points) : { runCount: 0, runLengthMm: 0 };
    const score = lengthMm / 1000 + elbowCount * options.elbowPenalty + verticals.runCount * options.riserPenalty / 1000;
    const sourceId = sources[path.sourceIndex ?? 0]?.id ?? "source";
    return {
        id: `${sourceId}__${target.id}`,
        status: issues.some((issue) => issue.severity === "error") ? "fail" : "pass",
        sourceId,
        targetId: target.id,
        pointsMm: path.points,
        segmentsMm: buildSegments(path.points),
        lengthMm: round(lengthMm),
        elbowCount,
        verticalRunCount: verticals.runCount,
        verticalRunLengthMm: round(verticals.runLengthMm),
        score: round(score),
        obstacleIntersections: hits,
        issues,
    };
}

function asPositiveNumber(value: unknown, fallback: number): number {
    const parsed = asNumber(value);
    return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

function mergeObstacleSources(spatial: Record<string, unknown>[], user: Record<string, unknown>[]): Record<string, unknown>[] {
    const byId = new Map<string, Record<string, unknown>>();
    const userIds = new Set<string>();
    user.forEach((raw, index) => {
        const id = stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `user-obstacle-${index + 1}`;
        userIds.add(id);
        byId.set(id, { ...raw, id });
    });
    spatial.forEach((raw, index) => {
        const id = stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `spatial-obstacle-${index + 1}`;
        if (userIds.has(id)) return;
        byId.set(id, { ...raw, id });
    });
    return Array.from(byId.values());
}

function readAllowedElevations(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    const values: number[] = [];
    const seen = new Set<number>();
    for (const entry of raw) {
        const parsed = asNumber(entry);
        if (parsed === undefined) continue;
        const rounded = round(parsed);
        if (seen.has(rounded)) continue;
        seen.add(rounded);
        values.push(rounded);
    }
    return values.sort((left, right) => left - right);
}

export function planDuctingAutoRoute(input: DuctAutoRoutingInput = {}): DuctAutoRoutingReport {
    const issues: EngineeringIssue[] = [];
    const sourceInputs = Array.isArray(input.sources) ? input.sources.map(asRecord) : [];
    const targetInputs = Array.isArray(input.targets) ? input.targets.map(asRecord) : [];
    const sources = sourceInputs.map((source, index) => readEndpoint(source, `source-${index + 1}`)).filter((item): item is RouteEndpoint => !!item);
    const targets = targetInputs.map((target, index) => readEndpoint(target, `target-${index + 1}`)).filter((item): item is RouteEndpoint => !!item);

    if (sources.length === 0) issues.push(makeIssue("route_source_missing", "error", "At least one source point is required for duct auto-routing."));
    if (targets.length === 0) issues.push(makeIssue("route_target_missing", "error", "At least one target point is required for duct auto-routing."));
    if (sources.length !== sourceInputs.length) issues.push(makeIssue("route_source_point_invalid", "error", "One or more source records have no valid pointMm/location."));
    if (targets.length !== targetInputs.length) issues.push(makeIssue("route_target_point_invalid", "error", "One or more target records have no valid pointMm/location."));

    // Minimum grid step protects against accidentally tiny values that would
    // turn `addRangeCoordinates` into a near-infinite loop (a 10 m span with a
    // 0.1 mm step is 100 k iterations and ~1 MB of `Set<number>` entries —
    // exactly the kind of accidental DoS we want to refuse server-side).
    const MIN_GRID_STEP_MM = 10;
    const gridStepMm = Math.max(MIN_GRID_STEP_MM, asPositiveNumber(input.gridStepMm, 600));
    const clearanceMm = Math.max(0, asNumber(input.clearanceMm) ?? 150);
    const ductHalfWidthMm = Math.max(0, asNumber(input.ductHalfWidthMm) ?? 0);
    const ductHalfHeightMm = Math.max(0, asNumber(input.ductHalfHeightMm) ?? 150);
    const marginMm = Math.max(gridStepMm, asNumber(input.boundaryMarginMm) ?? gridStepMm * 4);
    const maxExpansions = Math.max(100, Math.floor(asNumber(input.maxNodeExpansions) ?? 25000));
    const elbowPenalty = Math.max(0, asNumber(input.routeElbowPenalty) ?? 4);
    const riserPenalty = Math.max(0, asNumber(input.riserPenalty) ?? 0);
    const allowDiagonal = asBoolean(input.allowDiagonal) ?? false;
    // verticalStepMm = 0 disables Z refinement entirely; non-zero values get
    // the same MIN_GRID_STEP_MM floor as the horizontal step.
    const rawVerticalStepMm = Math.max(0, asNumber(input.verticalStepMm) ?? 0);
    const verticalStepMm = rawVerticalStepMm > 0 ? Math.max(MIN_GRID_STEP_MM, rawVerticalStepMm) : 0;
    const defaultRouteZ = asNumber(input.routingElevationMm) ?? sources[0]?.point.z ?? targets[0]?.point.z ?? 0;

    let spatialContext: SpatialZoneRoutingContext | undefined;
    if (input.spatialZone !== undefined && input.spatialZone !== null) {
        spatialContext = mapSpatialZoneToRoutingContext(input.spatialZone);
        for (const adapterIssue of spatialContext.issues) {
            issues.push(makeIssue(adapterIssue.code, adapterIssue.severity, adapterIssue.message, adapterIssue.context));
        }
    }

    const providedElevations = readAllowedElevations(input.allowedElevationsMm);
    // Precedence (matches the schema contract on plan_ducting_auto_route):
    //   1. User-supplied `allowedElevationsMm`           — explicit multi-elevation list wins.
    //   2. User-supplied `routingElevationMm`            — explicit single elevation; must win
    //                                                      over spatial-zone-derived defaults so
    //                                                      callers who want a fixed plenum are not
    //                                                      silently re-routed onto plenum_volumes
    //                                                      min/max.
    //   3. `spatialContext.allowedElevationsMm`          — derived from plenum_volumes when no
    //                                                      explicit input was given.
    //   4. `[defaultRouteZ]`                             — heuristic fallback (source or target z).
    const explicitRoutingElevation = asNumber(input.routingElevationMm);
    let allowedZs: number[];
    if (providedElevations.length > 0) {
        allowedZs = providedElevations;
    } else if (explicitRoutingElevation !== undefined) {
        allowedZs = [round(explicitRoutingElevation)];
    } else if (spatialContext && spatialContext.allowedElevationsMm.length > 0) {
        allowedZs = spatialContext.allowedElevationsMm.slice();
    } else {
        allowedZs = [round(defaultRouteZ)];
    }

    const userObstacleRaw = Array.isArray(input.obstacles) ? input.obstacles.map(asRecord) : [];
    const spatialObstacleRaw = spatialContext ? spatialContext.obstacles.map((entry) => ({
        id: entry.id,
        name: entry.name,
        obstacleType: entry.obstacleType,
        sourceLink: entry.sourceLink,
        aabbMm: entry.aabbMm,
    }) as Record<string, unknown>) : [];
    const mergedObstacleRaw = mergeObstacleSources(spatialObstacleRaw, userObstacleRaw);
    const obstacles = readObstacles(mergedObstacleRaw, clearanceMm, ductHalfWidthMm, ductHalfHeightMm);
    const obstacleIndexBackend: ObstacleIndexBackend = input.obstacleIndexBackend === "linear" ? "linear" : "aabb-tree";
    const obstacleIndex = buildObstacleIndex(obstacles, obstacleIndexBackend);
    const bounds = aabbFromValue(input.routingBounds);

    const routes: PlannedRoute[] = [];
    if (bounds) {
        for (const z of allowedZs) {
            if (z < bounds.minZ - GEOM_TOLERANCE_MM || z > bounds.maxZ + GEOM_TOLERANCE_MM) {
                issues.push(makeIssue("route_elevation_outside_bounds", "error", "Allowed routing elevation is outside the supplied routing bounds.", {
                    elevationMm: z,
                    minZ: bounds.minZ,
                    maxZ: bounds.maxZ,
                }));
            }
        }
    }
    for (const source of sources) {
        const snapped = snapPointToGridZ(source.point, allowedZs);
        if (!pointInsideBounds(snapped.point, bounds)) {
            issues.push(makeIssue("route_source_outside_bounds", "error", "A source point is outside the supplied routing bounds after projection to the nearest allowed elevation.", {
                sourceId: source.id,
            }));
        }
    }
    for (const target of targets) {
        const snapped = snapPointToGridZ(target.point, allowedZs);
        if (!pointInsideBounds(snapped.point, bounds)) {
            issues.push(makeIssue("route_target_outside_bounds", "error", "A target point is outside the supplied routing bounds after projection to the nearest allowed elevation.", {
                targetId: target.id,
            }));
        }
    }

    if (issues.every((issue) => issue.severity !== "error")) {
        for (const target of targets) {
            const selected = buildRouteFromSources(sources, target, obstacleIndex, {
                bounds,
                gridStepMm,
                verticalStepMm,
                marginMm,
                maxExpansions,
                riserPenalty,
                allowDiagonal,
                allowedZs,
                elbowPenalty,
            });
            routes.push(selected);
            issues.push(...selected.issues);
        }
    }

    if (routes.length > 1) {
        issues.push(makeIssue("route_tree_not_optimized", "info", "This first auto-routing planner creates independent source-to-target branches; trunk sharing and fitting optimization are a later phase."));
    }
    const successfulRoutes = routes.filter((route) => route.status === "pass");
    const routeCandidates = successfulRoutes.map((route) => ({
        id: route.id,
        status: "generated",
        reviewed: false,
        generatedBy: "plan_ducting_auto_route",
        sourceId: route.sourceId,
        targetId: route.targetId,
        pointsMm: route.pointsMm,
        segmentsMm: route.segmentsMm,
        lengthMm: route.lengthMm,
        elbowCount: route.elbowCount,
        verticalRunCount: route.verticalRunCount,
        verticalRunLengthMm: route.verticalRunLengthMm,
        obstacleIntersections: route.obstacleIntersections,
        score: route.score,
    }));
    const status = routes.length === 0 && issues.every((issue) => issue.severity !== "error") ? "not_run" : validationStatus(issues);

    return {
        schemaVersion: "ducting-auto-route-plan.v1",
        workflow: {
            revitWriteAction: "none",
            nextAllowedAction: status === "fail" ? "fix_inputs" : "review_route_candidates",
        },
        summary: {
            status,
            sourceCount: sources.length,
            targetCount: targets.length,
            obstacleCount: obstacles.length,
            obstacleIndexBackend,
            routeCount: routes.length,
            generatedRouteCandidateCount: routeCandidates.length,
            gridStepMm,
            verticalStepMm,
            clearanceMm,
            ductHalfWidthMm,
            ductHalfHeightMm,
            allowedElevationsMm: allowedZs.slice(),
            routingElevationMm: round(defaultRouteZ),
            riserPenalty,
            allowDiagonal,
            spatialZone: spatialContext ? {
                schemaVersion: spatialContext.schemaVersion,
                obstacleCount: spatialContext.summary.obstacleCount,
                plenumCount: spatialContext.summary.plenumCount,
                shaftCount: spatialContext.summary.shaftCount,
                derivedElevationCount: spatialContext.summary.derivedElevationCount,
                shafts: spatialContext.shafts.map((shaft) => ({
                    id: shaft.id,
                    name: shaft.name,
                    zMinMm: shaft.zMinMm,
                    zMaxMm: shaft.zMaxMm,
                    centroidMm: shaft.centroidMm,
                })),
            } : undefined,
            totalLengthMm: round(successfulRoutes.reduce((sum, route) => sum + route.lengthMm, 0)),
            totalElbowCount: successfulRoutes.reduce((sum, route) => sum + route.elbowCount, 0),
            totalVerticalRunCount: successfulRoutes.reduce((sum, route) => sum + route.verticalRunCount, 0),
            totalVerticalRunLengthMm: round(successfulRoutes.reduce((sum, route) => sum + route.verticalRunLengthMm, 0)),
        },
        routes,
        routeCandidates,
        issues,
    };
}
