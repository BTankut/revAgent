import { aabbFromValue, asRecord, stringByFields, valueByFields } from "./helpers.js";
import type { AabbMm, PointMm } from "./types.js";

export interface ObstacleAabb {
    id: string;
    name?: string;
    obstacleType?: string;
    original: AabbMm;
    expanded: AabbMm;
}

export type ObstacleIndexBackend = "linear" | "aabb-tree";

export interface ObstacleIndex {
    readonly count: number;
    readonly backend: ObstacleIndexBackend;
    candidatesForPoint(point: PointMm): ObstacleAabb[];
    candidatesForSegment(start: PointMm, end: PointMm): ObstacleAabb[];
    obstacles(): ObstacleAabb[];
    /**
     * Allocation-free hot-path traversals. Returns true the moment the predicate
     * returns true, mirroring `Array.prototype.some`. The A* search calls these
     * for every expanded neighbour, so they must not build an intermediate
     * candidates array.
     */
    someCandidateForPoint(point: PointMm, predicate: (obstacle: ObstacleAabb) => boolean): boolean;
    someCandidateForSegment(start: PointMm, end: PointMm, predicate: (obstacle: ObstacleAabb) => boolean): boolean;
}

export function expandAabb(aabb: AabbMm, clearanceMm: number, ductHalfHeightMm: number): AabbMm {
    return {
        minX: aabb.minX - clearanceMm,
        minY: aabb.minY - clearanceMm,
        minZ: aabb.minZ - clearanceMm - ductHalfHeightMm,
        maxX: aabb.maxX + clearanceMm,
        maxY: aabb.maxY + clearanceMm,
        maxZ: aabb.maxZ + clearanceMm + ductHalfHeightMm,
    };
}

export function readObstacles(rawObstacles: Record<string, unknown>[], clearanceMm: number, ductHalfHeightMm: number): ObstacleAabb[] {
    const obstacles: ObstacleAabb[] = [];
    rawObstacles.forEach((raw, index) => {
        const aabb = aabbFromValue(valueByFields(raw, ["aabbMm", "aabb_mm", "aabb", "box"]) ?? raw);
        if (!aabb) return;
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

export function pointInsideObstacle(point: PointMm, obstacle: ObstacleAabb): boolean {
    const aabb = obstacle.expanded;
    return point.x >= aabb.minX
        && point.x <= aabb.maxX
        && point.y >= aabb.minY
        && point.y <= aabb.maxY
        && point.z >= aabb.minZ
        && point.z <= aabb.maxZ;
}

/**
 * Exact 3D segment-AABB intersection using the slab method.
 * Correct for both axis-aligned and diagonal segments.
 */
export function segmentHitsObstacle(start: PointMm, end: PointMm, obstacle: ObstacleAabb): boolean {
    const aabb = obstacle.expanded;
    const epsilon = 1e-9;
    let tEnter = 0;
    let tExit = 1;

    // Axis loops are unrolled because this is the A* hot path; the per-call
    // 3-object array allocation showed up as measurable GC pressure on
    // larger scenes.

    const dx = end.x - start.x;
    if (Math.abs(dx) < epsilon) {
        if (start.x < aabb.minX || start.x > aabb.maxX) return false;
    } else {
        const invX = 1 / dx;
        let t1 = (aabb.minX - start.x) * invX;
        let t2 = (aabb.maxX - start.x) * invX;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tEnter) tEnter = t1;
        if (t2 < tExit) tExit = t2;
        if (tEnter > tExit) return false;
    }

    const dy = end.y - start.y;
    if (Math.abs(dy) < epsilon) {
        if (start.y < aabb.minY || start.y > aabb.maxY) return false;
    } else {
        const invY = 1 / dy;
        let t1 = (aabb.minY - start.y) * invY;
        let t2 = (aabb.maxY - start.y) * invY;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tEnter) tEnter = t1;
        if (t2 < tExit) tExit = t2;
        if (tEnter > tExit) return false;
    }

    const dz = end.z - start.z;
    if (Math.abs(dz) < epsilon) {
        if (start.z < aabb.minZ || start.z > aabb.maxZ) return false;
    } else {
        const invZ = 1 / dz;
        let t1 = (aabb.minZ - start.z) * invZ;
        let t2 = (aabb.maxZ - start.z) * invZ;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tEnter) tEnter = t1;
        if (t2 < tExit) tExit = t2;
        if (tEnter > tExit) return false;
    }

    return tEnter <= tExit;
}

function unionAabb(left: AabbMm, right: AabbMm): AabbMm {
    return {
        minX: Math.min(left.minX, right.minX),
        minY: Math.min(left.minY, right.minY),
        minZ: Math.min(left.minZ, right.minZ),
        maxX: Math.max(left.maxX, right.maxX),
        maxY: Math.max(left.maxY, right.maxY),
        maxZ: Math.max(left.maxZ, right.maxZ),
    };
}

function aabbCenter(aabb: AabbMm, axis: "x" | "y" | "z"): number {
    if (axis === "x") return (aabb.minX + aabb.maxX) / 2;
    if (axis === "y") return (aabb.minY + aabb.maxY) / 2;
    return (aabb.minZ + aabb.maxZ) / 2;
}

function longestAxis(aabb: AabbMm): "x" | "y" | "z" {
    const sx = aabb.maxX - aabb.minX;
    const sy = aabb.maxY - aabb.minY;
    const sz = aabb.maxZ - aabb.minZ;
    if (sx >= sy && sx >= sz) return "x";
    if (sy >= sz) return "y";
    return "z";
}

function aabbContainsPoint(aabb: AabbMm, point: PointMm): boolean {
    return point.x >= aabb.minX
        && point.x <= aabb.maxX
        && point.y >= aabb.minY
        && point.y <= aabb.maxY
        && point.z >= aabb.minZ
        && point.z <= aabb.maxZ;
}

function aabbIntersectsAabb(left: AabbMm, right: AabbMm): boolean {
    return left.minX <= right.maxX
        && left.maxX >= right.minX
        && left.minY <= right.maxY
        && left.maxY >= right.minY
        && left.minZ <= right.maxZ
        && left.maxZ >= right.minZ;
}

function segmentAabb(start: PointMm, end: PointMm): AabbMm {
    return {
        minX: Math.min(start.x, end.x),
        minY: Math.min(start.y, end.y),
        minZ: Math.min(start.z, end.z),
        maxX: Math.max(start.x, end.x),
        maxY: Math.max(start.y, end.y),
        maxZ: Math.max(start.z, end.z),
    };
}

interface AabbTreeNode {
    aabb: AabbMm;
    obstacle?: ObstacleAabb;
    left?: AabbTreeNode;
    right?: AabbTreeNode;
}

function buildAabbTreeNode(obstacles: ObstacleAabb[]): AabbTreeNode {
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

function collectForPoint(node: AabbTreeNode, point: PointMm, out: ObstacleAabb[]): void {
    if (!aabbContainsPoint(node.aabb, point)) return;
    if (node.obstacle) {
        out.push(node.obstacle);
        return;
    }
    if (node.left) collectForPoint(node.left, point, out);
    if (node.right) collectForPoint(node.right, point, out);
}

function collectForSegment(node: AabbTreeNode, segAabb: AabbMm, out: ObstacleAabb[]): void {
    if (!aabbIntersectsAabb(node.aabb, segAabb)) return;
    if (node.obstacle) {
        out.push(node.obstacle);
        return;
    }
    if (node.left) collectForSegment(node.left, segAabb, out);
    if (node.right) collectForSegment(node.right, segAabb, out);
}

function someForPoint(node: AabbTreeNode, point: PointMm, predicate: (obstacle: ObstacleAabb) => boolean): boolean {
    if (!aabbContainsPoint(node.aabb, point)) return false;
    if (node.obstacle) return predicate(node.obstacle);
    if (node.left && someForPoint(node.left, point, predicate)) return true;
    if (node.right && someForPoint(node.right, point, predicate)) return true;
    return false;
}

function someForSegment(node: AabbTreeNode, segAabb: AabbMm, predicate: (obstacle: ObstacleAabb) => boolean): boolean {
    if (!aabbIntersectsAabb(node.aabb, segAabb)) return false;
    if (node.obstacle) return predicate(node.obstacle);
    if (node.left && someForSegment(node.left, segAabb, predicate)) return true;
    if (node.right && someForSegment(node.right, segAabb, predicate)) return true;
    return false;
}

export function buildLinearObstacleIndex(obstacles: ObstacleAabb[]): ObstacleIndex {
    const list = obstacles.slice();
    return {
        count: list.length,
        backend: "linear",
        // AABB pre-filter mirrors the aabb-tree backend; callers do the final
        // pointInsideObstacle / segmentHitsObstacle check on the survivors.
        candidatesForPoint: (point) => list.filter((obstacle) => aabbContainsPoint(obstacle.expanded, point)),
        candidatesForSegment: (start, end) => {
            const segAabb = segmentAabb(start, end);
            return list.filter((obstacle) => aabbIntersectsAabb(obstacle.expanded, segAabb));
        },
        someCandidateForPoint: (point, predicate) => {
            for (const obstacle of list) {
                if (aabbContainsPoint(obstacle.expanded, point) && predicate(obstacle)) return true;
            }
            return false;
        },
        someCandidateForSegment: (start, end, predicate) => {
            const segAabb = segmentAabb(start, end);
            for (const obstacle of list) {
                if (aabbIntersectsAabb(obstacle.expanded, segAabb) && predicate(obstacle)) return true;
            }
            return false;
        },
        obstacles: () => list.slice(),
    };
}

export function buildAabbTreeObstacleIndex(obstacles: ObstacleAabb[]): ObstacleIndex {
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
            const out: ObstacleAabb[] = [];
            collectForPoint(root, point, out);
            return out;
        },
        candidatesForSegment: (start, end) => {
            const out: ObstacleAabb[] = [];
            collectForSegment(root, segmentAabb(start, end), out);
            return out;
        },
        someCandidateForPoint: (point, predicate) => someForPoint(root, point, predicate),
        someCandidateForSegment: (start, end, predicate) => someForSegment(root, segmentAabb(start, end), predicate),
        obstacles: () => list.slice(),
    };
}

export function buildObstacleIndex(obstacles: ObstacleAabb[], backend: ObstacleIndexBackend = "aabb-tree"): ObstacleIndex {
    return backend === "linear" ? buildLinearObstacleIndex(obstacles) : buildAabbTreeObstacleIndex(obstacles);
}
