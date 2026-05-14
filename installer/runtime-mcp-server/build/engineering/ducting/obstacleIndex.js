import { aabbFromValue, stringByFields, valueByFields } from "./helpers.js";
export function expandAabb(aabb, clearanceMm, ductHalfHeightMm) {
    return {
        minX: aabb.minX - clearanceMm,
        minY: aabb.minY - clearanceMm,
        minZ: aabb.minZ - clearanceMm - ductHalfHeightMm,
        maxX: aabb.maxX + clearanceMm,
        maxY: aabb.maxY + clearanceMm,
        maxZ: aabb.maxZ + clearanceMm + ductHalfHeightMm,
    };
}
export function readObstacles(rawObstacles, clearanceMm, ductHalfHeightMm) {
    const obstacles = [];
    rawObstacles.forEach((raw, index) => {
        const aabb = aabbFromValue(valueByFields(raw, ["aabbMm", "aabb_mm", "aabb", "box"]) ?? raw);
        if (!aabb)
            return;
        obstacles.push({
            id: stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `obstacle-${index + 1}`,
            name: stringByFields(raw, ["name", "category", "obstacleType", "obstacle_type"]),
            obstacleType: stringByFields(raw, ["obstacleType", "obstacle_type"]),
            original: aabb,
            expanded: expandAabb(aabb, clearanceMm, ductHalfHeightMm),
        });
    });
    return obstacles;
}
export function pointInsideObstacle(point, obstacle) {
    const aabb = obstacle.expanded;
    return point.x >= aabb.minX
        && point.x <= aabb.maxX
        && point.y >= aabb.minY
        && point.y <= aabb.maxY
        && point.z >= aabb.minZ
        && point.z <= aabb.maxZ;
}
export function segmentHitsObstacle(start, end, obstacle) {
    const aabb = obstacle.expanded;
    const epsilon = 1e-9;
    let tEnter = 0;
    let tExit = 1;
    const axes = [
        { s: start.x, e: end.x, lo: aabb.minX, hi: aabb.maxX },
        { s: start.y, e: end.y, lo: aabb.minY, hi: aabb.maxY },
        { s: start.z, e: end.z, lo: aabb.minZ, hi: aabb.maxZ },
    ];
    for (const axis of axes) {
        const dir = axis.e - axis.s;
        if (Math.abs(dir) < epsilon) {
            if (axis.s < axis.lo || axis.s > axis.hi)
                return false;
            continue;
        }
        const inv = 1 / dir;
        let t1 = (axis.lo - axis.s) * inv;
        let t2 = (axis.hi - axis.s) * inv;
        if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
        }
        if (t1 > tEnter)
            tEnter = t1;
        if (t2 < tExit)
            tExit = t2;
        if (tEnter > tExit)
            return false;
    }
    return tEnter <= tExit;
}
function unionAabb(left, right) {
    return {
        minX: Math.min(left.minX, right.minX),
        minY: Math.min(left.minY, right.minY),
        minZ: Math.min(left.minZ, right.minZ),
        maxX: Math.max(left.maxX, right.maxX),
        maxY: Math.max(left.maxY, right.maxY),
        maxZ: Math.max(left.maxZ, right.maxZ),
    };
}
function aabbCenter(aabb, axis) {
    if (axis === "x")
        return (aabb.minX + aabb.maxX) / 2;
    if (axis === "y")
        return (aabb.minY + aabb.maxY) / 2;
    return (aabb.minZ + aabb.maxZ) / 2;
}
function longestAxis(aabb) {
    const sx = aabb.maxX - aabb.minX;
    const sy = aabb.maxY - aabb.minY;
    const sz = aabb.maxZ - aabb.minZ;
    if (sx >= sy && sx >= sz)
        return "x";
    if (sy >= sz)
        return "y";
    return "z";
}
function aabbContainsPoint(aabb, point) {
    return point.x >= aabb.minX
        && point.x <= aabb.maxX
        && point.y >= aabb.minY
        && point.y <= aabb.maxY
        && point.z >= aabb.minZ
        && point.z <= aabb.maxZ;
}
function aabbIntersectsAabb(left, right) {
    return left.minX <= right.maxX
        && left.maxX >= right.minX
        && left.minY <= right.maxY
        && left.maxY >= right.minY
        && left.minZ <= right.maxZ
        && left.maxZ >= right.minZ;
}
function segmentAabb(start, end) {
    return {
        minX: Math.min(start.x, end.x),
        minY: Math.min(start.y, end.y),
        minZ: Math.min(start.z, end.z),
        maxX: Math.max(start.x, end.x),
        maxY: Math.max(start.y, end.y),
        maxZ: Math.max(start.z, end.z),
    };
}
function buildAabbTreeNode(obstacles) {
    if (obstacles.length === 1) {
        return { aabb: obstacles[0].expanded, obstacle: obstacles[0] };
    }
    let aabb = obstacles[0].expanded;
    for (let index = 1; index < obstacles.length; index++) {
        aabb = unionAabb(aabb, obstacles[index].expanded);
    }
    const axis = longestAxis(aabb);
    const sorted = obstacles.slice().sort((a, b) => aabbCenter(a.expanded, axis) - aabbCenter(b.expanded, axis));
    const mid = Math.floor(sorted.length / 2);
    return {
        aabb,
        left: buildAabbTreeNode(sorted.slice(0, mid)),
        right: buildAabbTreeNode(sorted.slice(mid)),
    };
}
function collectForPoint(node, point, out) {
    if (!aabbContainsPoint(node.aabb, point))
        return;
    if (node.obstacle) {
        out.push(node.obstacle);
        return;
    }
    if (node.left)
        collectForPoint(node.left, point, out);
    if (node.right)
        collectForPoint(node.right, point, out);
}
function collectForSegment(node, segAabb, out) {
    if (!aabbIntersectsAabb(node.aabb, segAabb))
        return;
    if (node.obstacle) {
        out.push(node.obstacle);
        return;
    }
    if (node.left)
        collectForSegment(node.left, segAabb, out);
    if (node.right)
        collectForSegment(node.right, segAabb, out);
}
export function buildLinearObstacleIndex(obstacles) {
    const list = obstacles.slice();
    return {
        count: list.length,
        backend: "linear",
        candidatesForPoint: () => list.slice(),
        candidatesForSegment: () => list.slice(),
        obstacles: () => list.slice(),
    };
}
export function buildAabbTreeObstacleIndex(obstacles) {
    if (obstacles.length === 0) {
        return {
            count: 0,
            backend: "aabb-tree",
            candidatesForPoint: () => [],
            candidatesForSegment: () => [],
            obstacles: () => [],
        };
    }
    const list = obstacles.slice();
    const root = buildAabbTreeNode(list);
    return {
        count: list.length,
        backend: "aabb-tree",
        candidatesForPoint: (point) => {
            const out = [];
            collectForPoint(root, point, out);
            return out;
        },
        candidatesForSegment: (start, end) => {
            const out = [];
            collectForSegment(root, segmentAabb(start, end), out);
            return out;
        },
        obstacles: () => list.slice(),
    };
}
export function buildObstacleIndex(obstacles, backend = "aabb-tree") {
    return backend === "linear" ? buildLinearObstacleIndex(obstacles) : buildAabbTreeObstacleIndex(obstacles);
}
