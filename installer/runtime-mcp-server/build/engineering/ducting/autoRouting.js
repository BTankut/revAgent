import { aabbFromValue, asBoolean, asNumber, asRecord, makeIssue, pointDistanceMm, pointFromValue, round, stringByFields, validationStatus, valueByFields, } from "./helpers.js";
import { buildObstacleIndex, pointInsideObstacle, readObstacles, segmentHitsObstacle, } from "./obstacleIndex.js";
import { mapSpatialZoneToRoutingContext } from "./spatialZoneAdapter.js";
const GEOM_TOLERANCE_MM = 0.001;
const DIAGONAL_45_TOLERANCE_MM = 1;
function is45DegreeDiagonalXY(dxMm, dyMm) {
    return Math.abs(Math.abs(dxMm) - Math.abs(dyMm)) <= DIAGONAL_45_TOLERANCE_MM;
}
const HORIZONTAL_NEIGHBORS_4WAY = Object.freeze([
    [-1, 0], [1, 0], [0, -1], [0, 1],
]);
const HORIZONTAL_NEIGHBORS_8WAY = Object.freeze([
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
]);
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
function overlap1d(aMin, aMax, bMin, bMax) {
    return Math.max(aMin, bMin) <= Math.min(aMax, bMax);
}
function routeObstacleHits(points, index) {
    const hits = [];
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
        const dx1 = Math.sign(b.x - a.x);
        const dy1 = Math.sign(b.y - a.y);
        const dz1 = Math.sign(b.z - a.z);
        const dx2 = Math.sign(c.x - b.x);
        const dy2 = Math.sign(c.y - b.y);
        const dz2 = Math.sign(c.z - b.z);
        if (dx1 !== dx2 || dy1 !== dy2 || dz1 !== dz2)
            count++;
    }
    return count;
}
function verticalStats(points) {
    let runCount = 0;
    let runLengthMm = 0;
    let previousVerticalSign = 0;
    for (let index = 1; index < points.length; index++) {
        const dz = points[index].z - points[index - 1].z;
        if (Math.abs(dz) > GEOM_TOLERANCE_MM) {
            const sign = Math.sign(dz);
            if (sign !== previousVerticalSign)
                runCount++;
            previousVerticalSign = sign;
            runLengthMm += Math.abs(dz);
        }
        else {
            previousVerticalSign = 0;
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
        if (dxLeft === dxRight && dyLeft === dyRight && dzLeft === dzRight) {
            const xyDiagonal = dxLeft !== 0 && dyLeft !== 0;
            if (!xyDiagonal || is45DegreeDiagonalXY(next.x - previous.x, next.y - previous.y))
                continue;
        }
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
    for (let value = start; value <= end + GEOM_TOLERANCE_MM; value += step)
        values.add(round(value));
}
function addBoundedCoordinate(values, value, min, max) {
    if (value >= min - GEOM_TOLERANCE_MM && value <= max + GEOM_TOLERANCE_MM)
        values.add(round(value));
}
function sortedNumbers(values) {
    return Array.from(values).sort((left, right) => left - right);
}
function createCoordinateGrid(sources, target, obstacles, bounds, gridStepMm, verticalStepMm, marginMm, allowedZs) {
    const allPoints = [...sources, target];
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of allPoints) {
        if (p.x < minX)
            minX = p.x;
        if (p.x > maxX)
            maxX = p.x;
        if (p.y < minY)
            minY = p.y;
        if (p.y > maxY)
            maxY = p.y;
    }
    const zMin = allowedZs[0];
    const zMax = allowedZs[allowedZs.length - 1];
    const actionMinX = minX;
    const actionMaxX = maxX;
    const actionMinY = minY;
    const actionMaxY = maxY;
    const inferredHalo = marginMm;
    for (const obstacle of obstacles) {
        if (!overlap1d(obstacle.expanded.minZ, obstacle.expanded.maxZ, zMin, zMax))
            continue;
        if (!bounds) {
            if (obstacle.expanded.maxX < actionMinX - inferredHalo)
                continue;
            if (obstacle.expanded.minX > actionMaxX + inferredHalo)
                continue;
            if (obstacle.expanded.maxY < actionMinY - inferredHalo)
                continue;
            if (obstacle.expanded.minY > actionMaxY + inferredHalo)
                continue;
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
        if (source.z >= zMin - GEOM_TOLERANCE_MM && source.z <= zMax + GEOM_TOLERANCE_MM)
            zs.add(round(source.z));
    }
    if (target.z >= zMin - GEOM_TOLERANCE_MM && target.z <= zMax + GEOM_TOLERANCE_MM)
        zs.add(round(target.z));
    let zArray = sortedNumbers(zs);
    if (bounds) {
        zArray = zArray.filter((z) => z >= bounds.minZ - GEOM_TOLERANCE_MM && z <= bounds.maxZ + GEOM_TOLERANCE_MM);
    }
    return { xs: sortedNumbers(xs), ys: sortedNumbers(ys), zs: zArray };
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
            const tmp = this.values[parent];
            this.values[parent] = this.values[index];
            this.values[index] = tmp;
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
            const tmp = this.values[smallest];
            this.values[smallest] = this.values[index];
            this.values[index] = tmp;
            index = smallest;
        }
    }
}
function pointInsideBounds(point, bounds) {
    if (!bounds)
        return true;
    return point.x >= bounds.minX - GEOM_TOLERANCE_MM
        && point.x <= bounds.maxX + GEOM_TOLERANCE_MM
        && point.y >= bounds.minY - GEOM_TOLERANCE_MM
        && point.y <= bounds.maxY + GEOM_TOLERANCE_MM
        && point.z >= bounds.minZ - GEOM_TOLERANCE_MM
        && point.z <= bounds.maxZ + GEOM_TOLERANCE_MM;
}
function findGridPathFromSources(sources, target, obstacleIndex, options) {
    const validSources = sources
        .map((source, index) => ({ source, index }))
        .filter((entry) => pointInsideBounds(entry.source, options.bounds));
    if (!pointInsideBounds(target, options.bounds) || validSources.length === 0) {
        return { points: [], expansions: 0, exhausted: false };
    }
    const grid = createCoordinateGrid(validSources.map((entry) => entry.source), target, obstacleIndex.obstacles(), options.bounds, options.gridStepMm, options.verticalStepMm, options.marginMm, options.allowedZs);
    const { xs, ys, zs } = grid;
    if (xs.length === 0 || ys.length === 0 || zs.length === 0) {
        return { points: [], expansions: 0, exhausted: false };
    }
    const width = xs.length;
    const height = ys.length;
    const depth = zs.length;
    const gridKey = (ix, iy, iz) => (iz * height + iy) * width + ix;
    const ixFromGridKey = (value) => value % width;
    const iyFromGridKey = (value) => Math.floor(value / width) % height;
    const izFromGridKey = (value) => Math.floor(value / (width * height));
    const point = (ix, iy, iz) => ({ x: xs[ix], y: ys[iy], z: zs[iz] });
    const ARRIVE_HORIZ = 0;
    const ARRIVE_VERT = 1;
    const compose = (gk, arrival) => gk * 2 + arrival;
    const gridFromComposite = (comp) => Math.floor(comp / 2);
    const arrivalFromComposite = (comp) => comp % 2;
    const findIndex = (values, target) => {
        let lo = 0;
        let hi = values.length - 1;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const value = values[mid];
            if (Math.abs(value - target) < GEOM_TOLERANCE_MM)
                return mid;
            if (value < target)
                lo = mid + 1;
            else
                hi = mid - 1;
        }
        return -1;
    };
    const targetIx = findIndex(xs, target.x);
    const targetIy = findIndex(ys, target.y);
    const targetIz = findIndex(zs, target.z);
    if (targetIx < 0 || targetIy < 0 || targetIz < 0)
        return { points: [], expansions: 0, exhausted: false };
    const targetGridKey = gridKey(targetIx, targetIy, targetIz);
    const pointBlocked = (candidate) => obstacleIndex.someCandidateForPoint(candidate, (obstacle) => pointInsideObstacle(candidate, obstacle));
    const segmentBlocked = (left, right) => obstacleIndex.someCandidateForSegment(left, right, (obstacle) => segmentHitsObstacle(left, right, obstacle));
    if (pointBlocked(target))
        return { points: [], expansions: 0, exhausted: false };
    const open = new MinHeap();
    const cameFrom = new Map();
    const sourceForKey = new Map();
    const gScore = new Map();
    const closed = new Set();
    const heuristic = (candidate) => {
        const dx = Math.abs(candidate.x - target.x);
        const dy = Math.abs(candidate.y - target.y);
        const dz = Math.abs(candidate.z - target.z);
        if (!options.allowDiagonal)
            return dx + dy + dz;
        return Math.hypot(dx, dy) + dz;
    };
    for (const entry of validSources) {
        const sourceIx = findIndex(xs, entry.source.x);
        const sourceIy = findIndex(ys, entry.source.y);
        const sourceIz = findIndex(zs, entry.source.z);
        if (sourceIx < 0 || sourceIy < 0 || sourceIz < 0 || pointBlocked(entry.source))
            continue;
        const sourceComp = compose(gridKey(sourceIx, sourceIy, sourceIz), ARRIVE_HORIZ);
        const existingG = gScore.get(sourceComp);
        if (existingG !== undefined && existingG <= 0)
            continue;
        sourceForKey.set(sourceComp, entry.index);
        gScore.set(sourceComp, 0);
        open.push({ key: sourceComp, priority: heuristic(entry.source) });
    }
    if (open.length === 0)
        return { points: [], expansions: 0, exhausted: false };
    const horizontalNeighbors = options.allowDiagonal
        ? HORIZONTAL_NEIGHBORS_8WAY
        : HORIZONTAL_NEIGHBORS_4WAY;
    const evalNeighbor = (nIx, nIy, nIz, vertical, currentPoint, currentComp, currentArrival, currentG, currentSource) => {
        if (nIx < 0 || nIy < 0 || nIz < 0 || nIx >= width || nIy >= height || nIz >= depth)
            return;
        const neighborArrival = vertical ? ARRIVE_VERT : ARRIVE_HORIZ;
        const neighborComp = compose(gridKey(nIx, nIy, nIz), neighborArrival);
        if (closed.has(neighborComp))
            return;
        const neighborPoint = point(nIx, nIy, nIz);
        if (pointBlocked(neighborPoint) || segmentBlocked(currentPoint, neighborPoint))
            return;
        const startingRiser = vertical && currentArrival !== ARRIVE_VERT;
        const transitionPenalty = startingRiser ? options.riserPenalty : 0;
        let stepCost;
        if (vertical) {
            stepCost = Math.abs(neighborPoint.z - currentPoint.z);
        }
        else {
            const dxStep = Math.abs(neighborPoint.x - currentPoint.x);
            const dyStep = Math.abs(neighborPoint.y - currentPoint.y);
            if (dxStep < GEOM_TOLERANCE_MM)
                stepCost = dyStep;
            else if (dyStep < GEOM_TOLERANCE_MM)
                stepCost = dxStep;
            else
                stepCost = Math.hypot(dxStep, dyStep);
        }
        stepCost += transitionPenalty;
        const tentative = currentG + stepCost;
        if (tentative >= (gScore.get(neighborComp) ?? Number.POSITIVE_INFINITY))
            return;
        cameFrom.set(neighborComp, currentComp);
        sourceForKey.set(neighborComp, currentSource);
        gScore.set(neighborComp, tentative);
        open.push({ key: neighborComp, priority: tentative + heuristic(neighborPoint) });
    };
    let expansions = 0;
    while (open.length > 0) {
        const currentComp = open.pop().key;
        if (closed.has(currentComp))
            continue;
        const currentGridKey = gridFromComposite(currentComp);
        const currentArrival = arrivalFromComposite(currentComp);
        if (currentGridKey === targetGridKey) {
            const pathComps = [currentComp];
            let cursor = currentComp;
            while (cameFrom.has(cursor)) {
                cursor = cameFrom.get(cursor);
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
        if (expansions > options.maxExpansions)
            return { points: [], expansions, exhausted: true };
        const ix = ixFromGridKey(currentGridKey);
        const iy = iyFromGridKey(currentGridKey);
        const iz = izFromGridKey(currentGridKey);
        const currentPoint = point(ix, iy, iz);
        const currentG = gScore.get(currentComp) ?? Number.POSITIVE_INFINITY;
        const currentSource = sourceForKey.get(currentComp) ?? 0;
        for (const [dx, dy] of horizontalNeighbors) {
            const newIx = ix + dx;
            const newIy = iy + dy;
            if (dx !== 0 && dy !== 0) {
                if (newIx < 0 || newIx >= width || newIy < 0 || newIy >= height)
                    continue;
                if (!is45DegreeDiagonalXY(xs[newIx] - xs[ix], ys[newIy] - ys[iy]))
                    continue;
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
function effectiveGridZs(allowedZs, verticalStepMm) {
    const zs = new Set();
    for (const z of allowedZs)
        zs.add(round(z));
    if (allowedZs.length > 1 && verticalStepMm > 0) {
        const zMin = allowedZs[0];
        const zMax = allowedZs[allowedZs.length - 1];
        addRangeCoordinates(zs, zMin, zMax, verticalStepMm);
    }
    return Array.from(zs).sort((a, b) => a - b);
}
function buildRouteFromSources(sources, target, obstacleIndex, options) {
    const snapZs = effectiveGridZs(options.allowedZs, options.verticalStepMm);
    const projectedSources = sources.map((source) => {
        const snapped = snapPointToGridZ(source.point, snapZs);
        return { id: source.id, point: snapped.point, projected: snapped.projected, raw: source.raw };
    });
    const snappedTarget = snapPointToGridZ(target.point, snapZs);
    const path = findGridPathFromSources(projectedSources.map((entry) => entry.point), snappedTarget.point, obstacleIndex, options);
    const pathHasRoute = path.points.length >= 2;
    const sourceEntry = path.sourceIndex !== undefined ? projectedSources[path.sourceIndex] : undefined;
    const issues = [];
    const projectedSourceIds = pathHasRoute && sourceEntry
        ? (sourceEntry.projected ? [sourceEntry.id] : [])
        : projectedSources.filter((entry) => entry.projected).map((entry) => entry.id);
    const sourceProjected = projectedSourceIds.length > 0;
    if (sourceProjected || snappedTarget.projected) {
        issues.push(makeIssue("route_endpoint_z_projected", "warning", "Endpoint was projected to the nearest allowed routing elevation; vertical riser/drop tail beyond the grid is not generated in this dry-run planner.", {
            sourceId: pathHasRoute ? sourceEntry?.id : (projectedSourceIds.length === 1 ? projectedSourceIds[0] : "(multiple-or-unselected)"),
            sourceIds: projectedSourceIds,
            targetId: target.id,
            allowedElevationsMm: options.allowedZs.slice(),
            sourceProjected,
            targetProjected: snappedTarget.projected,
        }));
    }
    if (path.exhausted) {
        issues.push(makeIssue("route_search_limit_exceeded", "error", "Auto-routing search exceeded maxNodeExpansions.", {
            sourceId: pathHasRoute ? sourceEntry?.id : "(unselected)",
            sourceIds: pathHasRoute ? undefined : projectedSources.map((entry) => entry.id),
            targetId: target.id,
            maxNodeExpansions: options.maxExpansions,
        }));
    }
    if (path.points.length < 2) {
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
    const sourceId = path.points.length >= 2 && path.sourceIndex !== undefined && sources[path.sourceIndex]
        ? sources[path.sourceIndex].id
        : "(unselected)";
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
        const aabb = aabbFromValue(valueByFields(raw, ["aabbMm", "aabb_mm", "aabb", "box"]) ?? raw);
        if (!aabb)
            return;
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
    const rawVerticalStepMm = Math.max(0, asNumber(input.verticalStepMm) ?? 0);
    const verticalStepMm = rawVerticalStepMm > 0 ? Math.max(MIN_GRID_STEP_MM, rawVerticalStepMm) : 0;
    const defaultRouteZ = asNumber(input.routingElevationMm) ?? sources[0]?.point.z ?? targets[0]?.point.z ?? 0;
    let spatialContext;
    if (input.spatialZone !== undefined && input.spatialZone !== null) {
        spatialContext = mapSpatialZoneToRoutingContext(input.spatialZone);
        for (const adapterIssue of spatialContext.issues) {
            issues.push(makeIssue(adapterIssue.code, adapterIssue.severity, adapterIssue.message, adapterIssue.context));
        }
    }
    const providedElevations = readAllowedElevations(input.allowedElevationsMm);
    const explicitRoutingElevation = asNumber(input.routingElevationMm);
    let allowedZs;
    if (providedElevations.length > 0) {
        allowedZs = providedElevations;
    }
    else if (explicitRoutingElevation !== undefined) {
        allowedZs = [round(explicitRoutingElevation)];
    }
    else if (spatialContext && spatialContext.allowedElevationsMm.length > 0) {
        allowedZs = spatialContext.allowedElevationsMm.slice();
    }
    else {
        allowedZs = [round(defaultRouteZ)];
    }
    const userObstacleRaw = Array.isArray(input.obstacles) ? input.obstacles.map(asRecord) : [];
    let userObstaclesSkipped = 0;
    const skippedUserObstacleIds = [];
    userObstacleRaw.forEach((raw, index) => {
        const aabb = aabbFromValue(valueByFields(raw, ["aabbMm", "aabb_mm", "aabb", "box"]) ?? raw);
        if (!aabb) {
            userObstaclesSkipped++;
            const id = stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `obstacle-${index + 1}`;
            skippedUserObstacleIds.push(id);
        }
    });
    if (userObstaclesSkipped > 0) {
        const noun = userObstaclesSkipped === 1 ? "entry" : "entries";
        const verb = userObstaclesSkipped === 1 ? "was" : "were";
        issues.push(makeIssue("route_user_obstacle_unreadable", "warning", `${userObstaclesSkipped} user-supplied obstacle ${noun} could not be parsed (missing or invalid AABB) and ${verb} skipped.`, {
            skippedCount: userObstaclesSkipped,
            totalSupplied: userObstacleRaw.length,
            skippedIds: skippedUserObstacleIds,
        }));
    }
    const spatialObstacleRaw = spatialContext ? spatialContext.obstacles.map((entry) => ({
        id: entry.id,
        name: entry.name,
        obstacleType: entry.obstacleType,
        sourceLink: entry.sourceLink,
        aabbMm: entry.aabbMm,
    })) : [];
    const mergedObstacleRaw = mergeObstacleSources(spatialObstacleRaw, userObstacleRaw);
    const obstacles = readObstacles(mergedObstacleRaw, clearanceMm, ductHalfWidthMm, ductHalfHeightMm);
    const obstacleIndexBackend = input.obstacleIndexBackend === "linear" ? "linear" : "aabb-tree";
    const obstacleIndex = buildObstacleIndex(obstacles, obstacleIndexBackend);
    const bounds = aabbFromValue(input.routingBounds);
    const routes = [];
    if (bounds) {
        const effectiveBoundsZs = effectiveGridZs(allowedZs, verticalStepMm);
        const hasViable = effectiveBoundsZs.some((z) => z >= bounds.minZ - GEOM_TOLERANCE_MM && z <= bounds.maxZ + GEOM_TOLERANCE_MM);
        if (!hasViable) {
            const closest = effectiveBoundsZs.reduce((best, z) => Math.abs(z - (bounds.minZ + bounds.maxZ) / 2) < Math.abs(best - (bounds.minZ + bounds.maxZ) / 2) ? z : best, effectiveBoundsZs[0]);
            issues.push(makeIssue("route_elevation_outside_bounds", "error", "No allowed routing elevation (including verticalStepMm refined stops) lies within the supplied routing bounds.", {
                elevationMm: closest,
                minZ: bounds.minZ,
                maxZ: bounds.maxZ,
            }));
        }
    }
    const preflightSnapZs = effectiveGridZs(allowedZs, verticalStepMm);
    for (const source of sources) {
        const snapped = snapPointToGridZ(source.point, preflightSnapZs);
        if (!pointInsideBounds(snapped.point, bounds)) {
            issues.push(makeIssue("route_source_outside_bounds", "error", "A source point is outside the supplied routing bounds after projection to the nearest allowed elevation.", {
                sourceId: source.id,
            }));
        }
    }
    for (const target of targets) {
        const snapped = snapPointToGridZ(target.point, preflightSnapZs);
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
