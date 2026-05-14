import { aabbFromValue, asBoolean, asNumber, asRecord, makeIssue, pointDistanceMm, pointFromValue, round, stringByFields, validationStatus, valueByFields, } from "./helpers.js";
import { mapSpatialZoneToRoutingContext } from "./spatialZoneAdapter.js";
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
function pointInsideObstacle(point, obstacle) {
    return point.x >= obstacle.expanded.minX
        && point.x <= obstacle.expanded.maxX
        && point.y >= obstacle.expanded.minY
        && point.y <= obstacle.expanded.maxY
        && point.z >= obstacle.expanded.minZ
        && point.z <= obstacle.expanded.maxZ;
}
function segmentHitsObstacle(start, end, obstacle) {
    const segMinX = Math.min(start.x, end.x);
    const segMaxX = Math.max(start.x, end.x);
    const segMinY = Math.min(start.y, end.y);
    const segMaxY = Math.max(start.y, end.y);
    const segMinZ = Math.min(start.z, end.z);
    const segMaxZ = Math.max(start.z, end.z);
    return overlap1d(segMinX, segMaxX, obstacle.expanded.minX, obstacle.expanded.maxX)
        && overlap1d(segMinY, segMaxY, obstacle.expanded.minY, obstacle.expanded.maxY)
        && overlap1d(segMinZ, segMaxZ, obstacle.expanded.minZ, obstacle.expanded.maxZ);
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
function verticalStats(points) {
    let runCount = 0;
    let runLengthMm = 0;
    for (let index = 1; index < points.length; index++) {
        const dz = points[index].z - points[index - 1].z;
        if (Math.abs(dz) > 0.001) {
            runCount++;
            runLengthMm += Math.abs(dz);
        }
    }
    return { runCount, runLengthMm };
}
function compressPath(points) {
    if (points.length <= 2)
        return points;
    const result = [points[0]];
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
        if (dxLeft === dxRight && dyLeft === dyRight && dzLeft === dzRight)
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
function createCoordinateGrid(sources, target, obstacles, bounds, gridStepMm, verticalStepMm, marginMm, allowedZs) {
    const allPoints = [...sources, target];
    let minX = Math.min(...allPoints.map((point) => point.x));
    let maxX = Math.max(...allPoints.map((point) => point.x));
    let minY = Math.min(...allPoints.map((point) => point.y));
    let maxY = Math.max(...allPoints.map((point) => point.y));
    const zMin = Math.min(...allowedZs);
    const zMax = Math.max(...allowedZs);
    for (const obstacle of obstacles) {
        if (!overlap1d(obstacle.expanded.minZ, obstacle.expanded.maxZ, zMin, zMax))
            continue;
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
    for (const obstacle of obstacles) {
        if (!overlap1d(obstacle.expanded.minZ, obstacle.expanded.maxZ, zMin, zMax))
            continue;
        addBoundedCoordinate(xs, obstacle.expanded.minX - detourOffsetMm, minX, maxX);
        addBoundedCoordinate(xs, obstacle.expanded.maxX + detourOffsetMm, minX, maxX);
        addBoundedCoordinate(ys, obstacle.expanded.minY - detourOffsetMm, minY, maxY);
        addBoundedCoordinate(ys, obstacle.expanded.maxY + detourOffsetMm, minY, maxY);
    }
    const zs = new Set();
    for (const z of allowedZs)
        zs.add(round(z));
    if (allowedZs.length === 1) {
    }
    else if (verticalStepMm > 0) {
        addRangeCoordinates(zs, zMin, zMax, verticalStepMm);
    }
    for (const source of sources) {
        if (source.z >= zMin - 0.001 && source.z <= zMax + 0.001)
            zs.add(round(source.z));
    }
    if (target.z >= zMin - 0.001 && target.z <= zMax + 0.001)
        zs.add(round(target.z));
    return { xs: sortedNumbers(xs), ys: sortedNumbers(ys), zs: sortedNumbers(zs) };
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
function findGridPathFromSources(sources, target, obstacles, options) {
    const validSources = sources
        .map((source, index) => ({ source, index }))
        .filter((entry) => pointInsideBounds(entry.source, options.bounds));
    if (!pointInsideBounds(target, options.bounds) || validSources.length === 0) {
        return { points: [], expansions: 0, exhausted: false };
    }
    const grid = createCoordinateGrid(validSources.map((entry) => entry.source), target, obstacles, options.bounds, options.gridStepMm, options.verticalStepMm, options.marginMm, options.allowedZs);
    const { xs, ys, zs } = grid;
    if (xs.length === 0 || ys.length === 0 || zs.length === 0) {
        return { points: [], expansions: 0, exhausted: false };
    }
    const width = xs.length;
    const height = ys.length;
    const key = (ix, iy, iz) => (iz * height + iy) * width + ix;
    const ixFromKey = (value) => value % width;
    const iyFromKey = (value) => Math.floor(value / width) % height;
    const izFromKey = (value) => Math.floor(value / (width * height));
    const point = (ix, iy, iz) => ({ x: xs[ix], y: ys[iy], z: zs[iz] });
    const findIndex = (values, target) => values.findIndex((value) => Math.abs(value - target) < 0.001);
    const targetIx = findIndex(xs, target.x);
    const targetIy = findIndex(ys, target.y);
    const targetIz = findIndex(zs, target.z);
    if (targetIx < 0 || targetIy < 0 || targetIz < 0)
        return { points: [], expansions: 0, exhausted: false };
    const targetKey = key(targetIx, targetIy, targetIz);
    const pointBlocked = (candidate) => obstacles.some((obstacle) => pointInsideObstacle(candidate, obstacle));
    const segmentBlocked = (left, right) => obstacles.some((obstacle) => segmentHitsObstacle(left, right, obstacle));
    if (pointBlocked(target))
        return { points: [], expansions: 0, exhausted: false };
    const open = new MinHeap();
    const cameFrom = new Map();
    const sourceForKey = new Map();
    const gScore = new Map();
    const closed = new Set();
    const heuristic = (candidate) => Math.abs(candidate.x - target.x) + Math.abs(candidate.y - target.y) + Math.abs(candidate.z - target.z);
    for (const entry of validSources) {
        const sourceIx = findIndex(xs, entry.source.x);
        const sourceIy = findIndex(ys, entry.source.y);
        const sourceIz = findIndex(zs, entry.source.z);
        if (sourceIx < 0 || sourceIy < 0 || sourceIz < 0 || pointBlocked(entry.source))
            continue;
        const sourceKey = key(sourceIx, sourceIy, sourceIz);
        const existingG = gScore.get(sourceKey);
        if (existingG !== undefined && existingG <= 0)
            continue;
        sourceForKey.set(sourceKey, entry.index);
        gScore.set(sourceKey, 0);
        open.push({ key: sourceKey, priority: heuristic(entry.source) });
    }
    if (open.length === 0)
        return { points: [], expansions: 0, exhausted: false };
    const horizontalNeighbors = options.allowDiagonal
        ? [
            [-1, 0], [1, 0], [0, -1], [0, 1],
            [-1, -1], [-1, 1], [1, -1], [1, 1],
        ]
        : [
            [-1, 0], [1, 0], [0, -1], [0, 1],
        ];
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
                points: compressPath(pathKeys.map((entry) => point(ixFromKey(entry), iyFromKey(entry), izFromKey(entry)))),
                sourceIndex: selectedSourceIndex,
                expansions,
                exhausted: false,
            };
        }
        closed.add(currentKey);
        expansions++;
        if (expansions > options.maxExpansions)
            return { points: [], expansions, exhausted: true };
        const ix = ixFromKey(currentKey);
        const iy = iyFromKey(currentKey);
        const iz = izFromKey(currentKey);
        const currentPoint = point(ix, iy, iz);
        const neighborMoves = [];
        for (const [dx, dy] of horizontalNeighbors) {
            neighborMoves.push({ ix: ix + dx, iy: iy + dy, iz, vertical: false });
        }
        if (zs.length > 1) {
            neighborMoves.push({ ix, iy, iz: iz - 1, vertical: true });
            neighborMoves.push({ ix, iy, iz: iz + 1, vertical: true });
        }
        for (const move of neighborMoves) {
            if (move.ix < 0 || move.iy < 0 || move.iz < 0 || move.ix >= xs.length || move.iy >= ys.length || move.iz >= zs.length)
                continue;
            const neighborKey = key(move.ix, move.iy, move.iz);
            if (closed.has(neighborKey))
                continue;
            const neighborPoint = point(move.ix, move.iy, move.iz);
            if (pointBlocked(neighborPoint) || segmentBlocked(currentPoint, neighborPoint))
                continue;
            const stepCost = pointDistanceMm(currentPoint, neighborPoint) + (move.vertical ? options.riserPenalty : 0);
            const tentative = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + stepCost;
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
function nearestAllowedZ(z, allowedZs) {
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
function snapPointToGridZ(point, allowedZs) {
    const nearest = nearestAllowedZ(point.z, allowedZs);
    if (Math.abs(nearest - point.z) <= 1)
        return { point: { x: point.x, y: point.y, z: nearest }, projected: false };
    return { point: { x: point.x, y: point.y, z: nearest }, projected: true };
}
function buildRouteFromSources(sources, target, obstacles, options) {
    const projectedSources = sources.map((source) => {
        const snapped = snapPointToGridZ(source.point, options.allowedZs);
        return { id: source.id, point: snapped.point, projected: snapped.projected, raw: source.raw };
    });
    const snappedTarget = snapPointToGridZ(target.point, options.allowedZs);
    const path = findGridPathFromSources(projectedSources.map((entry) => entry.point), snappedTarget.point, obstacles, options);
    const sourceEntry = path.sourceIndex !== undefined ? projectedSources[path.sourceIndex] : projectedSources[0];
    const issues = [];
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
    if (path.points.length === 0) {
        issues.push(makeIssue("route_not_found", "error", "No obstacle-free orthogonal route was found between source and target.", {
            sourceIds: sources.map((entry) => entry.id),
            targetId: target.id,
        }));
    }
    const hits = path.points.length > 0 ? routeObstacleHits(path.points, obstacles) : [];
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
function asPositiveNumber(value, fallback) {
    const parsed = asNumber(value);
    return parsed !== undefined && parsed > 0 ? parsed : fallback;
}
function mergeObstacleSources(spatial, user) {
    const byId = new Map();
    const userIds = new Set();
    user.forEach((raw, index) => {
        const id = stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `user-obstacle-${index + 1}`;
        userIds.add(id);
        byId.set(id, { ...raw, id });
    });
    spatial.forEach((raw, index) => {
        const id = stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `spatial-obstacle-${index + 1}`;
        if (userIds.has(id))
            return;
        byId.set(id, { ...raw, id });
    });
    return Array.from(byId.values());
}
function readAllowedElevations(raw) {
    if (!Array.isArray(raw))
        return [];
    const values = [];
    const seen = new Set();
    for (const entry of raw) {
        const parsed = asNumber(entry);
        if (parsed === undefined)
            continue;
        const rounded = round(parsed);
        if (seen.has(rounded))
            continue;
        seen.add(rounded);
        values.push(rounded);
    }
    return values.sort((left, right) => left - right);
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
    const riserPenalty = Math.max(0, asNumber(input.riserPenalty) ?? 0);
    const allowDiagonal = asBoolean(input.allowDiagonal) ?? false;
    const verticalStepMm = Math.max(0, asNumber(input.verticalStepMm) ?? 0);
    const defaultRouteZ = asNumber(input.routingElevationMm) ?? sources[0]?.point.z ?? targets[0]?.point.z ?? 0;
    let spatialContext;
    if (input.spatialZone !== undefined && input.spatialZone !== null) {
        spatialContext = mapSpatialZoneToRoutingContext(input.spatialZone);
        for (const adapterIssue of spatialContext.issues) {
            issues.push(makeIssue(adapterIssue.code, adapterIssue.severity, adapterIssue.message, adapterIssue.context));
        }
    }
    const providedElevations = readAllowedElevations(input.allowedElevationsMm);
    const allowedZs = providedElevations.length > 0
        ? providedElevations
        : (spatialContext && spatialContext.allowedElevationsMm.length > 0 ? spatialContext.allowedElevationsMm.slice() : [round(defaultRouteZ)]);
    const userObstacleRaw = Array.isArray(input.obstacles) ? input.obstacles.map(asRecord) : [];
    const spatialObstacleRaw = spatialContext ? spatialContext.obstacles.map((entry) => ({
        id: entry.id,
        name: entry.name,
        obstacleType: entry.obstacleType,
        sourceLink: entry.sourceLink,
        aabbMm: entry.aabbMm,
    })) : [];
    const mergedObstacleRaw = mergeObstacleSources(spatialObstacleRaw, userObstacleRaw);
    const obstacles = readObstacles(mergedObstacleRaw, clearanceMm, ductHalfHeightMm);
    const bounds = aabbFromValue(input.routingBounds);
    const routes = [];
    if (bounds) {
        for (const z of allowedZs) {
            if (z < bounds.minZ - 0.001 || z > bounds.maxZ + 0.001) {
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
            const selected = buildRouteFromSources(sources, target, obstacles, {
                bounds,
                gridStepMm,
                verticalStepMm,
                marginMm,
                maxExpansions,
                riserPenalty,
                allowDiagonal,
                allowedZs,
                elbowPenalty,
                defaultRouteZ,
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
            routeCount: routes.length,
            generatedRouteCandidateCount: routeCandidates.length,
            gridStepMm,
            verticalStepMm,
            clearanceMm,
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
