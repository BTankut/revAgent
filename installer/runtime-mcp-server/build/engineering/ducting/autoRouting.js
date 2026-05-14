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
function normalizeRoutingMode(value) {
    return String(value ?? "pointToPoint").toLowerCase() === "trunkandbranch" ? "trunkAndBranch" : "pointToPoint";
}
function normalizeAxis(value, bounds, points) {
    const raw = String(value ?? "auto").toLowerCase();
    if (raw === "x" || raw === "horizontal")
        return "x";
    if (raw === "y" || raw === "vertical")
        return "y";
    if (bounds)
        return (bounds.maxX - bounds.minX) >= (bounds.maxY - bounds.minY) ? "x" : "y";
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    return (maxX - minX) >= (maxY - minY) ? "x" : "y";
}
function median(values) {
    if (values.length === 0)
        return undefined;
    const sorted = [...values].sort((left, right) => left - right);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1)
        return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function pointOnAxis(axis, along, cross, z) {
    return axis === "x" ? { x: along, y: cross, z } : { x: cross, y: along, z };
}
function alongValue(axis, point) {
    return axis === "x" ? point.x : point.y;
}
function crossValue(axis, point) {
    return axis === "x" ? point.y : point.x;
}
function spanBounds(axis, bounds) {
    if (!bounds)
        return undefined;
    return axis === "x" ? { min: bounds.minX, max: bounds.maxX } : { min: bounds.minY, max: bounds.maxY };
}
function crossBounds(axis, bounds) {
    if (!bounds)
        return undefined;
    return axis === "x" ? { min: bounds.minY, max: bounds.maxY } : { min: bounds.minX, max: bounds.maxX };
}
function segmentFromPoints(startMm, endMm) {
    return { startMm, endMm, lengthMm: round(pointDistanceMm(startMm, endMm)) };
}
function activeZoneAabbs(input, routeZ) {
    const rawZones = [
        ...(Array.isArray(input.routingZones) ? input.routingZones : []),
        ...(Array.isArray(input.routingCorridors) ? input.routingCorridors : []),
    ].map(asRecord);
    return rawZones
        .map((zone) => aabbFromValue(valueByFields(zone, ["aabbMm", "aabb_mm", "aabb", "bounds", "box"]) ?? zone))
        .filter((zone) => !!zone && routeZ >= zone.minZ && routeZ <= zone.maxZ);
}
function chooseTrunkBounds(inputBounds, zones, axis) {
    if (zones.length === 0)
        return inputBounds;
    const ranked = [...zones].sort((left, right) => {
        const leftAlong = axis === "x" ? left.maxX - left.minX : left.maxY - left.minY;
        const rightAlong = axis === "x" ? right.maxX - right.minX : right.maxY - right.minY;
        const leftArea = (left.maxX - left.minX) * (left.maxY - left.minY);
        const rightArea = (right.maxX - right.minX) * (right.maxY - right.minY);
        return rightAlong - leftAlong || rightArea - leftArea;
    });
    return ranked[0] ?? inputBounds;
}
function candidateTrunkCoordinates(input, axis, points, bounds, zoneBounds, gridStepMm) {
    const candidates = new Set();
    const explicit = asNumber(input.trunkPositionMm);
    const limits = crossBounds(axis, zoneBounds ?? bounds);
    if (explicit !== undefined) {
        candidates.add(round(limits ? clamp(explicit, limits.min, limits.max) : explicit));
        return sortedNumbers(candidates);
    }
    const pointCrosses = points.map((point) => crossValue(axis, point));
    const pointMedian = median(pointCrosses);
    if (pointMedian !== undefined)
        candidates.add(round(pointMedian));
    for (const point of points)
        candidates.add(round(crossValue(axis, point)));
    if (zoneBounds) {
        const cross = crossBounds(axis, zoneBounds);
        candidates.add(round((cross.min + cross.max) / 2));
        addRangeCoordinates(candidates, cross.min, cross.max, gridStepMm);
    }
    else if (bounds) {
        const cross = crossBounds(axis, bounds);
        candidates.add(round((cross.min + cross.max) / 2));
        addRangeCoordinates(candidates, cross.min, cross.max, gridStepMm);
    }
    return sortedNumbers(new Set(sortedNumbers(candidates).filter((value) => !limits || (value >= limits.min && value <= limits.max))));
}
function routeFromTrunk(axis, sourcePoint, targetPoint, trunkCoordinateMm) {
    const sourceTapMm = pointOnAxis(axis, alongValue(axis, sourcePoint), trunkCoordinateMm, sourcePoint.z);
    const targetTapMm = pointOnAxis(axis, alongValue(axis, targetPoint), trunkCoordinateMm, targetPoint.z);
    return {
        points: compressPath([sourcePoint, sourceTapMm, targetTapMm, targetPoint]),
        sourceTapMm,
        targetTapMm,
    };
}
function scoreTrunkCoordinate(axis, coordinate, sourcePoint, targetPoints, trunkStartMm, trunkEndMm, obstacles) {
    const trunkHits = routeObstacleHits([trunkStartMm, trunkEndMm], obstacles).length;
    let branchHits = routeObstacleHits([sourcePoint, pointOnAxis(axis, alongValue(axis, sourcePoint), coordinate, sourcePoint.z)], obstacles).length;
    let branchLengthMm = Math.abs(crossValue(axis, sourcePoint) - coordinate);
    for (const target of targetPoints) {
        const tap = pointOnAxis(axis, alongValue(axis, target), coordinate, target.z);
        branchHits += routeObstacleHits([tap, target], obstacles).length;
        branchLengthMm += Math.abs(crossValue(axis, target) - coordinate);
    }
    return {
        score: (trunkHits + branchHits) * 1_000_000 + branchLengthMm,
        hitCount: trunkHits + branchHits,
        branchLengthMm,
    };
}
function buildTrunkAndBranchRoutes(sources, targets, obstacles, input, options) {
    const issues = [];
    const source = sources[0];
    const projectedSource = projectedPoint(source.point, options.routeZ);
    const projectedTargets = targets.map((target) => ({ endpoint: target, point: projectedPoint(target.point, options.routeZ) }));
    const allPoints = [projectedSource, ...projectedTargets.map((target) => target.point)];
    const axis = normalizeAxis(input.trunkAxis, options.bounds, allPoints);
    const zones = activeZoneAabbs(input, options.routeZ);
    const trunkBounds = chooseTrunkBounds(options.bounds, zones, axis);
    const axisSpan = spanBounds(axis, trunkBounds);
    const alongValues = allPoints.map((point) => alongValue(axis, point));
    const spanMin = axisSpan ? clamp(Math.min(...alongValues), axisSpan.min, axisSpan.max) : Math.min(...alongValues);
    const spanMax = axisSpan ? clamp(Math.max(...alongValues), axisSpan.min, axisSpan.max) : Math.max(...alongValues);
    const trunkCoordinates = candidateTrunkCoordinates(input, axis, allPoints, options.bounds, trunkBounds, options.gridStepMm);
    if (trunkCoordinates.length === 0) {
        issues.push(makeIssue("route_trunk_coordinate_missing", "error", "No trunk coordinate could be derived from targets, bounds, or routing zones."));
    }
    let selectedCoordinate = trunkCoordinates[0] ?? crossValue(axis, projectedSource);
    let bestScore = Number.POSITIVE_INFINITY;
    let bestHitCount = Number.POSITIVE_INFINITY;
    for (const coordinate of trunkCoordinates) {
        const trunkStartMm = pointOnAxis(axis, spanMin, coordinate, options.routeZ);
        const trunkEndMm = pointOnAxis(axis, spanMax, coordinate, options.routeZ);
        const scored = scoreTrunkCoordinate(axis, coordinate, projectedSource, projectedTargets.map((target) => target.point), trunkStartMm, trunkEndMm, obstacles);
        if (scored.score < bestScore) {
            bestScore = scored.score;
            bestHitCount = scored.hitCount;
            selectedCoordinate = coordinate;
        }
    }
    if (bestHitCount > 0) {
        issues.push(makeIssue("route_trunk_obstacle_conflict", "warning", "The selected trunk/branch line crosses expanded obstacle geometry; spatial-zone or trunk overrides should be reviewed.", {
            conflictCount: bestHitCount,
        }));
    }
    const trunkStartMm = pointOnAxis(axis, spanMin, selectedCoordinate, options.routeZ);
    const trunkEndMm = pointOnAxis(axis, spanMax, selectedCoordinate, options.routeZ);
    const sourceTapMm = pointOnAxis(axis, alongValue(axis, projectedSource), selectedCoordinate, options.routeZ);
    const trunkSegmentsMm = [segmentFromPoints(trunkStartMm, trunkEndMm)].filter((segment) => segment.lengthMm > 0);
    const sourceFeedSegmentsMm = [segmentFromPoints(projectedSource, sourceTapMm)].filter((segment) => segment.lengthMm > 0);
    const branchSegmentsMm = [];
    const routes = [];
    for (const target of projectedTargets) {
        const route = routeFromTrunk(axis, projectedSource, target.point, selectedCoordinate);
        const routeIssues = [];
        if (Math.abs(source.point.z - options.routeZ) > 1 || Math.abs(target.endpoint.point.z - options.routeZ) > 1) {
            routeIssues.push(makeIssue("route_endpoint_z_projected", "warning", "Endpoint was projected to the routing elevation; vertical riser/drop is not generated in this dry-run planner.", {
                sourceId: source.id,
                targetId: target.endpoint.id,
                routingElevationMm: options.routeZ,
            }));
        }
        const hits = routeObstacleHits(route.points, obstacles);
        if (hits.length > 0) {
            routeIssues.push(makeIssue("route_obstacle_intersection", "error", "Generated trunk/branch route intersects expanded obstacle clearance volume.", {
                sourceId: source.id,
                targetId: target.endpoint.id,
                hitCount: hits.length,
            }));
        }
        const lengthMm = routeLength(route.points);
        const elbowCount = routeElbows(route.points);
        const score = lengthMm / 1000 + elbowCount * options.elbowPenalty;
        const branchSegment = segmentFromPoints(route.targetTapMm, target.point);
        if (branchSegment.lengthMm > 0) {
            branchSegmentsMm.push({ targetId: target.endpoint.id, ...branchSegment });
        }
        routes.push({
            id: `${source.id}__${target.endpoint.id}`,
            status: routeIssues.some((issue) => issue.severity === "error") ? "fail" : "pass",
            sourceId: source.id,
            targetId: target.endpoint.id,
            pointsMm: route.points,
            segmentsMm: buildSegments(route.points),
            lengthMm: round(lengthMm),
            elbowCount,
            score: round(score),
            obstacleIntersections: hits,
            issues: routeIssues,
        });
    }
    const treeLengthMm = round(trunkSegmentsMm.reduce((sum, segment) => sum + segment.lengthMm, 0)
        + sourceFeedSegmentsMm.reduce((sum, segment) => sum + segment.lengthMm, 0)
        + branchSegmentsMm.reduce((sum, segment) => sum + segment.lengthMm, 0));
    const routeTree = {
        axis,
        trunkCoordinateMm: round(selectedCoordinate),
        trunkStartMm,
        trunkEndMm,
        sourceTapMm,
        trunkSegmentsMm,
        sourceFeedSegmentsMm,
        branchSegmentsMm,
        treeLengthMm,
        routeCandidatesExtra: {
            topology: "trunkAndBranch",
            trunkAxis: axis,
            trunkCoordinateMm: round(selectedCoordinate),
        },
        issues,
    };
    return { routes, routeTree };
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
    const routingMode = normalizeRoutingMode(input.routingMode);
    let routes = [];
    let routeTree;
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
        if (routingMode === "trunkAndBranch") {
            const planned = buildTrunkAndBranchRoutes(sources, targets, obstacles, input, {
                bounds,
                gridStepMm,
                routeZ,
                elbowPenalty,
            });
            routes = planned.routes;
            routeTree = planned.routeTree;
            issues.push(...planned.routeTree.issues);
            for (const route of planned.routes)
                issues.push(...route.issues);
        }
        else {
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
    }
    if (routes.length > 1 && routingMode === "pointToPoint") {
        issues.push(makeIssue("route_tree_not_optimized", "info", "This first auto-routing planner creates independent source-to-target branches; trunk sharing and fitting optimization are a later phase."));
    }
    else if (routes.length > 1 && routingMode === "trunkAndBranch") {
        issues.push(makeIssue("route_tree_generated", "info", "Routes were generated with a shared trunk and terminal branches. Review the trunk coordinate against spatial-zone/plenum evidence before commit.", {
            trunkAxis: routeTree?.axis,
            trunkCoordinateMm: routeTree?.trunkCoordinateMm,
        }));
    }
    const successfulRoutes = routes.filter((route) => route.status === "pass");
    const routeCandidates = successfulRoutes.map((route) => ({
        id: route.id,
        status: "generated",
        reviewed: false,
        generatedBy: "plan_ducting_auto_route",
        topology: routingMode,
        sourceId: route.sourceId,
        targetId: route.targetId,
        pointsMm: route.pointsMm,
        segmentsMm: route.segmentsMm,
        lengthMm: route.lengthMm,
        elbowCount: route.elbowCount,
        obstacleIntersections: route.obstacleIntersections,
        score: route.score,
        ...(routeTree?.routeCandidatesExtra ?? {}),
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
            routingMode,
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
            treeLengthMm: routeTree?.treeLengthMm,
            trunkAxis: routeTree?.axis,
            trunkCoordinateMm: routeTree?.trunkCoordinateMm,
        },
        routeTree: routeTree ? {
            topology: "trunkAndBranch",
            axis: routeTree.axis,
            trunkCoordinateMm: routeTree.trunkCoordinateMm,
            trunkStartMm: routeTree.trunkStartMm,
            trunkEndMm: routeTree.trunkEndMm,
            sourceTapMm: routeTree.sourceTapMm,
            trunkSegmentsMm: routeTree.trunkSegmentsMm,
            sourceFeedSegmentsMm: routeTree.sourceFeedSegmentsMm,
            branchSegmentsMm: routeTree.branchSegmentsMm,
            treeLengthMm: routeTree.treeLengthMm,
            issues: routeTree.issues,
        } : undefined,
        routes,
        routeCandidates,
        issues,
    };
}
