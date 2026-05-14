import {
    aabbFromValue,
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
import type { AabbMm, EngineeringIssue, PointMm } from "./types.js";

export interface DuctAutoRoutingInput {
    sources?: Record<string, unknown>[];
    targets?: Record<string, unknown>[];
    obstacles?: Record<string, unknown>[];
    routingBounds?: Record<string, unknown>;
    routingElevationMm?: number;
    gridStepMm?: number;
    clearanceMm?: number;
    ductHalfHeightMm?: number;
    boundaryMarginMm?: number;
    maxNodeExpansions?: number;
    routeElbowPenalty?: number;
}

interface RouteEndpoint {
    id: string;
    point: PointMm;
    raw: Record<string, unknown>;
}

interface RouteObstacle {
    id: string;
    name?: string;
    original: AabbMm;
    expanded: AabbMm;
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

function expandAabb(aabb: AabbMm, clearanceMm: number, ductHalfHeightMm: number): AabbMm {
    return {
        minX: aabb.minX - clearanceMm,
        minY: aabb.minY - clearanceMm,
        minZ: aabb.minZ - clearanceMm - ductHalfHeightMm,
        maxX: aabb.maxX + clearanceMm,
        maxY: aabb.maxY + clearanceMm,
        maxZ: aabb.maxZ + clearanceMm + ductHalfHeightMm,
    };
}

function readObstacles(rawObstacles: Record<string, unknown>[], clearanceMm: number, ductHalfHeightMm: number): RouteObstacle[] {
    const obstacles: RouteObstacle[] = [];
    rawObstacles.forEach((raw, index) => {
        const aabb = aabbFromValue(valueByFields(raw, ["aabbMm", "aabb_mm", "aabb", "box"]) ?? raw);
        if (!aabb) return;
        obstacles.push({
            id: stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `obstacle-${index + 1}`,
            name: stringByFields(raw, ["name", "category", "obstacleType", "obstacle_type"]),
            original: aabb,
            expanded: expandAabb(aabb, clearanceMm, ductHalfHeightMm),
        });
    });
    return obstacles;
}

function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
    return Math.max(aMin, bMin) <= Math.min(aMax, bMax);
}

function obstacleAppliesAtZ(obstacle: RouteObstacle, z: number): boolean {
    return z >= obstacle.expanded.minZ && z <= obstacle.expanded.maxZ;
}

function pointInsideObstacle(point: PointMm, obstacle: RouteObstacle): boolean {
    if (!obstacleAppliesAtZ(obstacle, point.z)) return false;
    return point.x >= obstacle.expanded.minX
        && point.x <= obstacle.expanded.maxX
        && point.y >= obstacle.expanded.minY
        && point.y <= obstacle.expanded.maxY;
}

function segmentHitsObstacle(start: PointMm, end: PointMm, obstacle: RouteObstacle): boolean {
    if (!obstacleAppliesAtZ(obstacle, start.z) && !obstacleAppliesAtZ(obstacle, end.z)) return false;
    if (Math.abs(start.y - end.y) < 0.001 && Math.abs(start.z - end.z) < 0.001) {
        return start.y >= obstacle.expanded.minY
            && start.y <= obstacle.expanded.maxY
            && overlap1d(Math.min(start.x, end.x), Math.max(start.x, end.x), obstacle.expanded.minX, obstacle.expanded.maxX);
    }
    if (Math.abs(start.x - end.x) < 0.001 && Math.abs(start.z - end.z) < 0.001) {
        return start.x >= obstacle.expanded.minX
            && start.x <= obstacle.expanded.maxX
            && overlap1d(Math.min(start.y, end.y), Math.max(start.y, end.y), obstacle.expanded.minY, obstacle.expanded.maxY);
    }
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    return overlap1d(minX, maxX, obstacle.expanded.minX, obstacle.expanded.maxX)
        && overlap1d(minY, maxY, obstacle.expanded.minY, obstacle.expanded.maxY);
}

function routeObstacleHits(points: PointMm[], obstacles: RouteObstacle[]): Array<Record<string, unknown>> {
    const hits: Array<Record<string, unknown>> = [];
    for (let index = 1; index < points.length; index++) {
        const start = points[index - 1];
        const end = points[index];
        for (const obstacle of obstacles) {
            if (segmentHitsObstacle(start, end, obstacle)) {
                hits.push({
                    obstacleId: obstacle.id,
                    obstacleName: obstacle.name,
                    segmentIndex: index - 1,
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

function compressPath(points: PointMm[]): PointMm[] {
    if (points.length <= 2) return points;
    const result: PointMm[] = [points[0]];
    for (let index = 1; index < points.length - 1; index++) {
        const previous = result[result.length - 1];
        const current = points[index];
        const next = points[index + 1];
        const sameX = Math.abs(previous.x - current.x) < 0.001 && Math.abs(current.x - next.x) < 0.001;
        const sameY = Math.abs(previous.y - current.y) < 0.001 && Math.abs(current.y - next.y) < 0.001;
        const sameZ = Math.abs(previous.z - current.z) < 0.001 && Math.abs(current.z - next.z) < 0.001;
        if ((sameX && sameZ) || (sameY && sameZ)) continue;
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
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    for (let value = start; value <= end + 0.001; value += step) values.add(round(value));
}

function sortedNumbers(values: Set<number>): number[] {
    return Array.from(values).sort((left, right) => left - right);
}

function createCoordinateGrid(
    source: PointMm,
    target: PointMm,
    obstacles: RouteObstacle[],
    bounds: AabbMm | undefined,
    gridStepMm: number,
    marginMm: number,
    routeZ: number,
): { xs: number[]; ys: number[] } {
    let minX = Math.min(source.x, target.x);
    let maxX = Math.max(source.x, target.x);
    let minY = Math.min(source.y, target.y);
    let maxY = Math.max(source.y, target.y);

    for (const obstacle of obstacles.filter((item) => obstacleAppliesAtZ(item, routeZ))) {
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
    xs.add(round(source.x));
    xs.add(round(target.x));
    ys.add(round(source.y));
    ys.add(round(target.y));

    for (const obstacle of obstacles.filter((item) => obstacleAppliesAtZ(item, routeZ))) {
        xs.add(round(obstacle.expanded.minX - gridStepMm));
        xs.add(round(obstacle.expanded.maxX + gridStepMm));
        ys.add(round(obstacle.expanded.minY - gridStepMm));
        ys.add(round(obstacle.expanded.maxY + gridStepMm));
    }

    return { xs: sortedNumbers(xs), ys: sortedNumbers(ys) };
}

class MinHeap {
    private readonly values: Array<{ key: string; priority: number }> = [];

    get length(): number {
        return this.values.length;
    }

    push(item: { key: string; priority: number }): void {
        this.values.push(item);
        this.bubbleUp(this.values.length - 1);
    }

    pop(): { key: string; priority: number } | undefined {
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

function findGridPath(
    source: PointMm,
    target: PointMm,
    obstacles: RouteObstacle[],
    bounds: AabbMm | undefined,
    gridStepMm: number,
    marginMm: number,
    maxExpansions: number,
): { points: PointMm[]; expansions: number; exhausted: boolean } {
    const routeZ = source.z;
    const { xs, ys } = createCoordinateGrid(source, target, obstacles, bounds, gridStepMm, marginMm, routeZ);
    const key = (ix: number, iy: number) => `${ix},${iy}`;
    const point = (ix: number, iy: number): PointMm => ({ x: xs[ix], y: ys[iy], z: routeZ });
    const startIx = xs.findIndex((value) => Math.abs(value - source.x) < 0.001);
    const startIy = ys.findIndex((value) => Math.abs(value - source.y) < 0.001);
    const targetIx = xs.findIndex((value) => Math.abs(value - target.x) < 0.001);
    const targetIy = ys.findIndex((value) => Math.abs(value - target.y) < 0.001);
    const startKey = key(startIx, startIy);
    const targetKey = key(targetIx, targetIy);

    const pointBlocked = (candidate: PointMm) => obstacles.some((obstacle) => pointInsideObstacle(candidate, obstacle));
    const segmentBlocked = (left: PointMm, right: PointMm) => obstacles.some((obstacle) => segmentHitsObstacle(left, right, obstacle));
    if (pointBlocked(source) || pointBlocked(target)) return { points: [], expansions: 0, exhausted: false };

    const open = new MinHeap();
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>();
    const closed = new Set<string>();
    const heuristic = (candidate: PointMm) => Math.abs(candidate.x - target.x) + Math.abs(candidate.y - target.y);

    gScore.set(startKey, 0);
    open.push({ key: startKey, priority: heuristic(source) });

    let expansions = 0;
    while (open.length > 0) {
        const currentKey = open.pop()!.key;
        if (closed.has(currentKey)) continue;
        if (currentKey === targetKey) {
            const pathKeys = [currentKey];
            let cursor = currentKey;
            while (cameFrom.has(cursor)) {
                cursor = cameFrom.get(cursor)!;
                pathKeys.push(cursor);
            }
            pathKeys.reverse();
            return {
                points: compressPath(pathKeys.map((entry) => {
                    const [ix, iy] = entry.split(",").map((part) => Number(part));
                    return point(ix, iy);
                })),
                expansions,
                exhausted: false,
            };
        }
        closed.add(currentKey);
        expansions++;
        if (expansions > maxExpansions) return { points: [], expansions, exhausted: true };

        const [ix, iy] = currentKey.split(",").map((part) => Number(part));
        const currentPoint = point(ix, iy);
        const neighbors = [
            [ix - 1, iy],
            [ix + 1, iy],
            [ix, iy - 1],
            [ix, iy + 1],
        ];
        for (const [nx, ny] of neighbors) {
            if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
            const neighborKey = key(nx, ny);
            if (closed.has(neighborKey)) continue;
            const neighborPoint = point(nx, ny);
            if (pointBlocked(neighborPoint) || segmentBlocked(currentPoint, neighborPoint)) continue;
            const tentative = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + pointDistanceMm(currentPoint, neighborPoint);
            if (tentative >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) continue;
            cameFrom.set(neighborKey, currentKey);
            gScore.set(neighborKey, tentative);
            open.push({ key: neighborKey, priority: tentative + heuristic(neighborPoint) });
        }
    }
    return { points: [], expansions, exhausted: false };
}

function projectedPoint(point: PointMm, routeZ: number): PointMm {
    return { x: point.x, y: point.y, z: routeZ };
}

function buildRoute(
    source: RouteEndpoint,
    target: RouteEndpoint,
    obstacles: RouteObstacle[],
    options: {
        bounds?: AabbMm;
        gridStepMm: number;
        marginMm: number;
        routeZ: number;
        maxExpansions: number;
        elbowPenalty: number;
    },
): PlannedRoute {
    const routeSource = projectedPoint(source.point, options.routeZ);
    const routeTarget = projectedPoint(target.point, options.routeZ);
    const path = findGridPath(routeSource, routeTarget, obstacles, options.bounds, options.gridStepMm, options.marginMm, options.maxExpansions);
    const issues: EngineeringIssue[] = [];
    if (Math.abs(source.point.z - options.routeZ) > 1 || Math.abs(target.point.z - options.routeZ) > 1) {
        issues.push(makeIssue("route_endpoint_z_projected", "warning", "Endpoint was projected to the routing elevation; vertical riser/drop is not generated in this dry-run planner.", {
            sourceId: source.id,
            targetId: target.id,
            routingElevationMm: options.routeZ,
        }));
    }
    if (path.exhausted) {
        issues.push(makeIssue("route_search_limit_exceeded", "error", "Auto-routing search exceeded maxNodeExpansions.", {
            sourceId: source.id,
            targetId: target.id,
            maxNodeExpansions: options.maxExpansions,
        }));
    }
    if (path.points.length === 0) {
        issues.push(makeIssue("route_not_found", "error", "No obstacle-free orthogonal route was found between source and target.", {
            sourceId: source.id,
            targetId: target.id,
        }));
    }

    const hits = path.points.length > 0 ? routeObstacleHits(path.points, obstacles) : [];
    if (hits.length > 0) {
        issues.push(makeIssue("route_obstacle_intersection", "error", "Generated route intersects expanded obstacle clearance volume.", {
            sourceId: source.id,
            targetId: target.id,
            hitCount: hits.length,
        }));
    }
    const lengthMm = path.points.length > 0 ? routeLength(path.points) : 0;
    const elbowCount = path.points.length > 0 ? routeElbows(path.points) : 0;
    const score = lengthMm / 1000 + elbowCount * options.elbowPenalty;
    return {
        id: `${source.id}__${target.id}`,
        status: issues.some((issue) => issue.severity === "error") ? "fail" : "pass",
        sourceId: source.id,
        targetId: target.id,
        pointsMm: path.points,
        segmentsMm: buildSegments(path.points),
        lengthMm: round(lengthMm),
        elbowCount,
        score: round(score),
        obstacleIntersections: hits,
        issues,
    };
}

function asPositiveNumber(value: unknown, fallback: number): number {
    const parsed = asNumber(value);
    return parsed !== undefined && parsed > 0 ? parsed : fallback;
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

    const gridStepMm = asPositiveNumber(input.gridStepMm, 600);
    const clearanceMm = Math.max(0, asNumber(input.clearanceMm) ?? 150);
    const ductHalfHeightMm = Math.max(0, asNumber(input.ductHalfHeightMm) ?? 150);
    const marginMm = Math.max(gridStepMm, asNumber(input.boundaryMarginMm) ?? gridStepMm * 4);
    const maxExpansions = Math.max(100, Math.floor(asNumber(input.maxNodeExpansions) ?? 25000));
    const elbowPenalty = Math.max(0, asNumber(input.routeElbowPenalty) ?? 4);
    const routeZ = asNumber(input.routingElevationMm) ?? sources[0]?.point.z ?? targets[0]?.point.z ?? 0;
    const obstacles = readObstacles(Array.isArray(input.obstacles) ? input.obstacles.map(asRecord) : [], clearanceMm, ductHalfHeightMm);
    const bounds = aabbFromValue(input.routingBounds);

    const routes: PlannedRoute[] = [];
    if (issues.every((issue) => issue.severity !== "error")) {
        for (const target of targets) {
            const candidates = sources.map((source) => buildRoute(source, target, obstacles, {
                bounds,
                gridStepMm,
                marginMm,
                routeZ,
                maxExpansions,
                elbowPenalty,
            })).sort((left, right) => left.score - right.score);
            const selected = candidates.find((candidate) => candidate.status === "pass") ?? candidates[0];
            if (selected) {
                routes.push(selected);
                issues.push(...selected.issues);
            }
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
            routeCount: routes.length,
            generatedRouteCandidateCount: routeCandidates.length,
            gridStepMm,
            clearanceMm,
            ductHalfHeightMm,
            routingElevationMm: round(routeZ),
            totalLengthMm: round(successfulRoutes.reduce((sum, route) => sum + route.lengthMm, 0)),
            totalElbowCount: successfulRoutes.reduce((sum, route) => sum + route.elbowCount, 0),
        },
        routes,
        routeCandidates,
        issues,
    };
}
