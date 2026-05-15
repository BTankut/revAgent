import { aabbFromValue, stringByFields, valueByFields } from "./helpers.js";
export function expandAabb(aabb, clearanceMm, ductHalfWidthMm, ductHalfHeightMm) {
    return {
        minX: aabb.minX - clearanceMm - ductHalfWidthMm,
        minY: aabb.minY - clearanceMm - ductHalfWidthMm,
        minZ: aabb.minZ - clearanceMm - ductHalfHeightMm,
        maxX: aabb.maxX + clearanceMm + ductHalfWidthMm,
        maxY: aabb.maxY + clearanceMm + ductHalfWidthMm,
        maxZ: aabb.maxZ + clearanceMm + ductHalfHeightMm,
    };
}
export function readObstacles(rawObstacles, clearanceMm, ductHalfWidthMm, ductHalfHeightMm) {
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
            expanded: expandAabb(aabb, clearanceMm, ductHalfWidthMm, ductHalfHeightMm),
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
    const dx = end.x - start.x;
    if (Math.abs(dx) < epsilon) {
        if (start.x < aabb.minX || start.x > aabb.maxX)
            return false;
    }
    else {
        const invX = 1 / dx;
        let t1 = (aabb.minX - start.x) * invX;
        let t2 = (aabb.maxX - start.x) * invX;
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
    const dy = end.y - start.y;
    if (Math.abs(dy) < epsilon) {
        if (start.y < aabb.minY || start.y > aabb.maxY)
            return false;
    }
    else {
        const invY = 1 / dy;
        let t1 = (aabb.minY - start.y) * invY;
        let t2 = (aabb.maxY - start.y) * invY;
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
    const dz = end.z - start.z;
    if (Math.abs(dz) < epsilon) {
        if (start.z < aabb.minZ || start.z > aabb.maxZ)
            return false;
    }
    else {
        const invZ = 1 / dz;
        let t1 = (aabb.minZ - start.z) * invZ;
        let t2 = (aabb.maxZ - start.z) * invZ;
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
function partitionByCenter(obstacles, axis, lo, hi, mid) {
    while (lo < hi) {
        const center = Math.floor((lo + hi) / 2);
        const a = aabbCenter(obstacles[lo].expanded, axis);
        const b = aabbCenter(obstacles[center].expanded, axis);
        const c = aabbCenter(obstacles[hi].expanded, axis);
        let pivotIndex;
        if ((a <= b && b <= c) || (c <= b && b <= a))
            pivotIndex = center;
        else if ((b <= a && a <= c) || (c <= a && a <= b))
            pivotIndex = lo;
        else
            pivotIndex = hi;
        const pivotValue = aabbCenter(obstacles[pivotIndex].expanded, axis);
        let tmp = obstacles[pivotIndex];
        obstacles[pivotIndex] = obstacles[hi];
        obstacles[hi] = tmp;
        let store = lo;
        for (let i = lo; i < hi; i++) {
            if (aabbCenter(obstacles[i].expanded, axis) < pivotValue) {
                tmp = obstacles[store];
                obstacles[store] = obstacles[i];
                obstacles[i] = tmp;
                store++;
            }
        }
        tmp = obstacles[store];
        obstacles[store] = obstacles[hi];
        obstacles[hi] = tmp;
        if (store === mid)
            return;
        if (store < mid)
            lo = store + 1;
        else
            hi = store - 1;
    }
}
function buildAabbTreeNodeInRange(obstacles, lo, hi) {
    if (lo === hi) {
        return { aabb: obstacles[lo].expanded, obstacle: obstacles[lo] };
    }
    const first = obstacles[lo].expanded;
    let minX = first.minX;
    let minY = first.minY;
    let minZ = first.minZ;
    let maxX = first.maxX;
    let maxY = first.maxY;
    let maxZ = first.maxZ;
    for (let index = lo + 1; index <= hi; index++) {
        const o = obstacles[index].expanded;
        if (o.minX < minX)
            minX = o.minX;
        if (o.minY < minY)
            minY = o.minY;
        if (o.minZ < minZ)
            minZ = o.minZ;
        if (o.maxX > maxX)
            maxX = o.maxX;
        if (o.maxY > maxY)
            maxY = o.maxY;
        if (o.maxZ > maxZ)
            maxZ = o.maxZ;
    }
    const aabb = { minX, minY, minZ, maxX, maxY, maxZ };
    const axis = longestAxis(aabb);
    const mid = Math.floor((lo + hi) / 2);
    partitionByCenter(obstacles, axis, lo, hi, mid);
    return {
        aabb,
        left: buildAabbTreeNodeInRange(obstacles, lo, mid),
        right: buildAabbTreeNodeInRange(obstacles, mid + 1, hi),
    };
}
function buildAabbTreeNode(obstacles) {
    return buildAabbTreeNodeInRange(obstacles, 0, obstacles.length - 1);
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
function someForPoint(node, point, predicate) {
    if (!aabbContainsPoint(node.aabb, point))
        return false;
    if (node.obstacle)
        return predicate(node.obstacle);
    if (node.left && someForPoint(node.left, point, predicate))
        return true;
    if (node.right && someForPoint(node.right, point, predicate))
        return true;
    return false;
}
function someForSegment(node, segAabb, predicate) {
    if (!aabbIntersectsAabb(node.aabb, segAabb))
        return false;
    if (node.obstacle)
        return predicate(node.obstacle);
    if (node.left && someForSegment(node.left, segAabb, predicate))
        return true;
    if (node.right && someForSegment(node.right, segAabb, predicate))
        return true;
    return false;
}
export function buildLinearObstacleIndex(obstacles) {
    const list = obstacles.slice();
    return {
        count: list.length,
        backend: "linear",
        candidatesForPoint: (point) => list.filter((obstacle) => aabbContainsPoint(obstacle.expanded, point)),
        candidatesForSegment: (start, end) => {
            const segAabb = segmentAabb(start, end);
            return list.filter((obstacle) => aabbIntersectsAabb(obstacle.expanded, segAabb));
        },
        someCandidateForPoint: (point, predicate) => {
            for (const obstacle of list) {
                if (aabbContainsPoint(obstacle.expanded, point) && predicate(obstacle))
                    return true;
            }
            return false;
        },
        someCandidateForSegment: (start, end, predicate) => {
            const segAabb = segmentAabb(start, end);
            for (const obstacle of list) {
                if (aabbIntersectsAabb(obstacle.expanded, segAabb) && predicate(obstacle))
                    return true;
            }
            return false;
        },
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
            someCandidateForPoint: () => false,
            someCandidateForSegment: () => false,
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
        someCandidateForPoint: (point, predicate) => someForPoint(root, point, predicate),
        someCandidateForSegment: (start, end, predicate) => someForSegment(root, segmentAabb(start, end), predicate),
        obstacles: () => list.slice(),
    };
}
export function buildObstacleIndex(obstacles, backend = "aabb-tree") {
    return backend === "linear" ? buildLinearObstacleIndex(obstacles) : buildAabbTreeObstacleIndex(obstacles);
}
