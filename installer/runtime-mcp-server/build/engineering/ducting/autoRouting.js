import { aabbFromValue, asNumber, asRecord, makeIssue, pointDistanceMm, pointFromValue, round, stringByFields, validationStatus, valueByFields, } from "./helpers.js";
function pointFromRecord(record) {
    return pointFromValue(valueByFields(record, ["pointMm", "point_mm", "point", "locationMm", "location_mm", "location"]))
        ?? pointFromValue(record);
}
function readEndpoint(raw, fallbackId) {
    const point = pointFromRecord(raw);
    if (!point)
        return undefined;
    return {
        id: stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id", "name"]) ?? fallbackId,
        point,
        raw,
    };
}
function expandAabb(aabb, clearanceMm, ductHalfHeightMm) {
    return {
        minX: aabb.minX - clearanceMm,
        minY: aabb.minY - clearanceMm,
        minZ: aabb.minZ - clearanceMm - ductHalfHeightMm,
        maxX: aabb.maxX + clearanceMm,
        maxY: aabb.maxY + clearanceMm,
        maxZ: aabb.maxZ + clearanceMm + ductHalfHeightMm,
    };
}
function readObstacles(rawObstacles, clearanceMm, ductHalfHeightMm) {
    const obstacles = [];
    rawObstacles.forEach((raw, index) => {
        const aabb = aabbFromValue(valueByFields(raw, ["aabbMm", "aabb_mm", "aabb", "box"]) ?? raw);
        if (!aabb)
            return;
        obstacles.push({
            id: stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `obstacle-${index + 1}`,
            name: stringByFields(raw, ["name", "category", "obstacleType", "obstacle_type"]),
            original: aabb,
            expanded: expandAabb(aabb, clearanceMm, ductHalfHeightMm),
        });
    });
    return obstacles;
}
function overlap1d(aMin, aMax, bMin, bMax) {
    return Math.max(aMin, bMin) <= Math.min(aMax, bMax);
}
function obstacleAppliesAtZ(obstacle, z) {
    return z >= obstacle.expanded.minZ && z <= obstacle.expanded.maxZ;
}
function pointInsideObstacle(point, obstacle) {
    if (!obstacleAppliesAtZ(obstacle, point.z))
        return false;
    return point.x >= obstacle.expanded.minX
        && point.x <= obstacle.expanded.maxX
        && point.y >= obstacle.expanded.minY
        && point.y <= obstacle.expanded.maxY;
}
function segmentHitsObstacle(start, end, obstacle) {
    if (!overlap1d(Math.min(start.z, end.z), Math.max(start.z, end.z), obstacle.expanded.minZ, obstacle.expanded.maxZ))
        return false;
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
function routeObstacleHits(points, obstacles) {
    const hits = [];
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
function routeLength(points) {
    let total = 0;
    for (let index = 1; index < points.length; index++)
        total += pointDistanceMm(points[index - 1], points[index]);
    return total;
}
function routeElbows(points) {
    let count = 0;
    for (let index = 2; index < points.length; index++) {
        const a = points[index - 2];
        const b = points[index - 1];
        const c = points[index];
        const left = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y), z: Math.sign(b.z - a.z) };
        const right = { x: Math.sign(c.x - b.x), y: Math.sign(c.y - b.y), z: Math.sign(c.z - b.z) };
        if (left.x !== right.x || left.y !== right.y || left.z !== right.z)
            count++;
    }
    return count;
}
function compressPath(points) {
    if (points.length <= 2)
        return points;
    const result = [points[0]];
    for (let index = 1; index < points.length - 1; index++) {
        const previous = result[result.length - 1];
        const current = points[index];
        const next = points[index + 1];
        const sameX = Math.abs(previous.x - current.x) < 0.001 && Math.abs(current.x - next.x) < 0.001;
        const sameY = Math.abs(previous.y - current.y) < 0.001 && Math.abs(current.y - next.y) < 0.001;
        const sameZ = Math.abs(previous.z - current.z) < 0.001 && Math.abs(current.z - next.z) < 0.001;
        if ((sameX && sameZ) || (sameY && sameZ))
            continue;
        result.push(current);
    }
    result.push(points[points.length - 1]);
    return result;
}
function buildSegments(points) {
    const segments = [];
    for (let index = 1; index < points.length; index++) {
        segments.push({
            startMm: points[index - 1],
            endMm: points[index],
            lengthMm: round(pointDistanceMm(points[index - 1], points[index])),
        });
    }
    return segments;
}
function addRangeCoordinates(values, min, max, step) {
    values.add(round(min));
    values.add(round(max));
    const start = Math.ceil(min / step) * step;
    const end = Math.floor(max / step) * step;
    for (let value = start; value <= end + 0.001; value += step)
        values.add(round(value));
}
function addBoundedCoordinate(values, value, min, max) {
    if (value >= min - 0.001 && value <= max + 0.001)
        values.add(round(value));
}
function sortedNumbers(values) {
    return Array.from(values).sort((left, right) => left - right);
}
function createCoordinateGrid(sources, target, obstacles, bounds, gridStepMm, marginMm, routeZ) {
    const allPoints = [...sources, target];
    let minX = Math.min(...allPoints.map((point) => point.x));
    let maxX = Math.max(...allPoints.map((point) => point.x));
    let minY = Math.min(...allPoints.map((point) => point.y));
    let maxY = Math.max(...allPoints.map((point) => point.y));
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
    }
    else {
        minX -= marginMm;
        maxX += marginMm;
        minY -= marginMm;
        maxY += marginMm;
    }
    const xs = new Set();
    const ys = new Set();
    addRangeCoordinates(xs, minX, maxX, gridStepMm);
    addRangeCoordinates(ys, minY, maxY, gridStepMm);
    for (const source of sources) {
        addBoundedCoordinate(xs, source.x, minX, maxX);
        addBoundedCoordinate(ys, source.y, minY, maxY);
    }
    xs.add(round(target.x));
    ys.add(round(target.y));
    const detourOffsetMm = 1;
    for (const obstacle of obstacles.filter((item) => obstacleAppliesAtZ(item, routeZ))) {
        addBoundedCoordinate(xs, obstacle.expanded.minX - detourOffsetMm, minX, maxX);
        addBoundedCoordinate(xs, obstacle.expanded.maxX + detourOffsetMm, minX, maxX);
        addBoundedCoordinate(ys, obstacle.expanded.minY - detourOffsetMm, minY, maxY);
        addBoundedCoordinate(ys, obstacle.expanded.maxY + detourOffsetMm, minY, maxY);
    }
    return { xs: sortedNumbers(xs), ys: sortedNumbers(ys) };
}
class MinHeap {
    values = [];
    get length() {
        return this.values.length;
    }
    push(item) {
        this.values.push(item);
        this.bubbleUp(this.values.length - 1);
    }
    pop() {
        if (this.values.length === 0)
            return undefined;
        const result = this.values[0];
        const tail = this.values.pop();
        if (this.values.length > 0) {
            this.values[0] = tail;
            this.sinkDown(0);
        }
        return result;
    }
    bubbleUp(index) {
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (this.values[parent].priority <= this.values[index].priority)
                break;
            [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
            index = parent;
        }
    }
    sinkDown(index) {
        while (true) {
            const left = index * 2 + 1;
            const right = index * 2 + 2;
            let smallest = index;
            if (left < this.values.length && this.values[left].priority < this.values[smallest].priority)
                smallest = left;
            if (right < this.values.length && this.values[right].priority < this.values[smallest].priority)
                smallest = right;
            if (smallest === index)
                break;
            [this.values[smallest], this.values[index]] = [this.values[index], this.values[smallest]];
            index = smallest;
        }
    }
}
function pointInsideBounds(point, bounds) {
    if (!bounds)
        return true;
    return point.x >= bounds.minX
        && point.x <= bounds.maxX
        && point.y >= bounds.minY
        && point.y <= bounds.maxY
        && point.z >= bounds.minZ
        && point.z <= bounds.maxZ;
}
function findGridPathFromSources(sources, target, obstacles, bounds, gridStepMm, marginMm, maxExpansions) {
    const routeZ = target.z;
    const validSources = sources
        .map((source, index) => ({ source, index }))
        .filter((entry) => pointInsideBounds(entry.source, bounds));
    if (!pointInsideBounds(target, bounds) || validSources.length === 0)
        return { points: [], expansions: 0, exhausted: false };
    const { xs, ys } = createCoordinateGrid(validSources.map((entry) => entry.source), target, obstacles, bounds, gridStepMm, marginMm, routeZ);
    const width = xs.length;
    const key = (ix, iy) => iy * width + ix;
    const ixFromKey = (value) => value % width;
    const iyFromKey = (value) => Math.floor(value / width);
    const point = (ix, iy) => ({ x: xs[ix], y: ys[iy], z: routeZ });
    const targetIx = xs.findIndex((value) => Math.abs(value - target.x) < 0.001);
    const targetIy = ys.findIndex((value) => Math.abs(value - target.y) < 0.001);
    const targetKey = key(targetIx, targetIy);
    const pointBlocked = (candidate) => obstacles.some((obstacle) => pointInsideObstacle(candidate, obstacle));
    const segmentBlocked = (left, right) => obstacles.some((obstacle) => segmentHitsObstacle(left, right, obstacle));
    if (pointBlocked(target))
        return { points: [], expansions: 0, exhausted: false };
    const open = new MinHeap();
    const cameFrom = new Map();
    const sourceForKey = new Map();
    const gScore = new Map();
    const closed = new Set();
    const heuristic = (candidate) => Math.abs(candidate.x - target.x) + Math.abs(candidate.y - target.y);
    for (const entry of validSources) {
        const sourceIx = xs.findIndex((value) => Math.abs(value - entry.source.x) < 0.001);
        const sourceIy = ys.findIndex((value) => Math.abs(value - entry.source.y) < 0.001);
        if (sourceIx < 0 || sourceIy < 0 || pointBlocked(entry.source))
            continue;
        const sourceKey = key(sourceIx, sourceIy);
        sourceForKey.set(sourceKey, entry.index);
        gScore.set(sourceKey, 0);
        open.push({ key: sourceKey, priority: heuristic(entry.source) });
    }
    if (open.length === 0)
        return { points: [], expansions: 0, exhausted: false };
    let expansions = 0;
    while (open.length > 0) {
        const currentKey = open.pop().key;
        if (closed.has(currentKey))
            continue;
        if (currentKey === targetKey) {
            const pathKeys = [currentKey];
            let cursor = currentKey;
            while (cameFrom.has(cursor)) {
                cursor = cameFrom.get(cursor);
                pathKeys.push(cursor);
            }
            pathKeys.reverse();
            const selectedSourceIndex = sourceForKey.get(pathKeys[0]);
            return {
                points: compressPath(pathKeys.map((entry) => {
                    return point(ixFromKey(entry), iyFromKey(entry));
                })),
                sourceIndex: selectedSourceIndex,
                expansions,
                exhausted: false,
            };
        }
        closed.add(currentKey);
        expansions++;
        if (expansions > maxExpansions)
            return { points: [], expansions, exhausted: true };
        const ix = ixFromKey(currentKey);
        const iy = iyFromKey(currentKey);
        const currentPoint = point(ix, iy);
        const neighbors = [
            [ix - 1, iy],
            [ix + 1, iy],
            [ix, iy - 1],
            [ix, iy + 1],
        ];
        for (const [nx, ny] of neighbors) {
            if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length)
                continue;
            const neighborKey = key(nx, ny);
            if (closed.has(neighborKey))
                continue;
            const neighborPoint = point(nx, ny);
            if (pointBlocked(neighborPoint) || segmentBlocked(currentPoint, neighborPoint))
                continue;
            const tentative = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + pointDistanceMm(currentPoint, neighborPoint);
            if (tentative >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY))
                continue;
            cameFrom.set(neighborKey, currentKey);
            sourceForKey.set(neighborKey, sourceForKey.get(currentKey) ?? 0);
            gScore.set(neighborKey, tentative);
            open.push({ key: neighborKey, priority: tentative + heuristic(neighborPoint) });
        }
    }
    return { points: [], expansions, exhausted: false };
}
function projectedPoint(point, routeZ) {
    return { x: point.x, y: point.y, z: routeZ };
}
function buildRouteFromSources(sources, target, obstacles, options) {
    const routeSources = sources.map((source) => projectedPoint(source.point, options.routeZ));
    const routeTarget = projectedPoint(target.point, options.routeZ);
    const path = findGridPathFromSources(routeSources, routeTarget, obstacles, options.bounds, options.gridStepMm, options.marginMm, options.maxExpansions);
    const source = path.sourceIndex !== undefined ? sources[path.sourceIndex] : sources[0];
    const issues = [];
    if (source && (Math.abs(source.point.z - options.routeZ) > 1 || Math.abs(target.point.z - options.routeZ) > 1)) {
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
            sourceIds: sources.map((entry) => entry.id),
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
function asPositiveNumber(value, fallback) {
    const parsed = asNumber(value);
    return parsed !== undefined && parsed > 0 ? parsed : fallback;
}
export function planDuctingAutoRoute(input = {}) {
    const issues = [];
    const sourceInputs = Array.isArray(input.sources) ? input.sources.map(asRecord) : [];
    const targetInputs = Array.isArray(input.targets) ? input.targets.map(asRecord) : [];
    const sources = sourceInputs.map((source, index) => readEndpoint(source, `source-${index + 1}`)).filter((item) => !!item);
    const targets = targetInputs.map((target, index) => readEndpoint(target, `target-${index + 1}`)).filter((item) => !!item);
    if (sources.length === 0)
        issues.push(makeIssue("route_source_missing", "error", "At least one source point is required for duct auto-routing."));
    if (targets.length === 0)
        issues.push(makeIssue("route_target_missing", "error", "At least one target point is required for duct auto-routing."));
    if (sources.length !== sourceInputs.length)
        issues.push(makeIssue("route_source_point_invalid", "error", "One or more source records have no valid pointMm/location."));
    if (targets.length !== targetInputs.length)
        issues.push(makeIssue("route_target_point_invalid", "error", "One or more target records have no valid pointMm/location."));
    const gridStepMm = asPositiveNumber(input.gridStepMm, 600);
    const clearanceMm = Math.max(0, asNumber(input.clearanceMm) ?? 150);
    const ductHalfHeightMm = Math.max(0, asNumber(input.ductHalfHeightMm) ?? 150);
    const marginMm = Math.max(gridStepMm, asNumber(input.boundaryMarginMm) ?? gridStepMm * 4);
    const maxExpansions = Math.max(100, Math.floor(asNumber(input.maxNodeExpansions) ?? 25000));
    const elbowPenalty = Math.max(0, asNumber(input.routeElbowPenalty) ?? 4);
    const routeZ = asNumber(input.routingElevationMm) ?? sources[0]?.point.z ?? targets[0]?.point.z ?? 0;
    const obstacles = readObstacles(Array.isArray(input.obstacles) ? input.obstacles.map(asRecord) : [], clearanceMm, ductHalfHeightMm);
    const bounds = aabbFromValue(input.routingBounds);
    const routes = [];
    if (bounds && (routeZ < bounds.minZ || routeZ > bounds.maxZ)) {
        issues.push(makeIssue("route_elevation_outside_bounds", "error", "Routing elevation is outside the supplied routing bounds.", {
            routingElevationMm: routeZ,
            minZ: bounds.minZ,
            maxZ: bounds.maxZ,
        }));
    }
    for (const source of sources) {
        if (!pointInsideBounds(projectedPoint(source.point, routeZ), bounds)) {
            issues.push(makeIssue("route_source_outside_bounds", "error", "A source point is outside the supplied routing bounds after projection.", {
                sourceId: source.id,
            }));
        }
    }
    for (const target of targets) {
        if (!pointInsideBounds(projectedPoint(target.point, routeZ), bounds)) {
            issues.push(makeIssue("route_target_outside_bounds", "error", "A target point is outside the supplied routing bounds after projection.", {
                targetId: target.id,
            }));
        }
    }
    if (issues.every((issue) => issue.severity !== "error")) {
        for (const target of targets) {
            const selected = buildRouteFromSources(sources, target, obstacles, {
                bounds,
                gridStepMm,
                marginMm,
                routeZ,
                maxExpansions,
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
