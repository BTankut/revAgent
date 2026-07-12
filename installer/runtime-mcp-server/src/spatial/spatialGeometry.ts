import type { SpatialAabb, SpatialStoredNode } from "./spatialStore.js";
import type { SpatialComputedRelation } from "./spatialTypes.js";
import {
    cleanText,
    finiteNumber,
    firstDefined,
    isJsonObject,
    sha256Canonical,
} from "./spatialCanonical.js";

export type SpatialPoint3 = readonly [number, number, number];

export interface SpatialProfile {
    shape: "round" | "rectangular" | "unknown";
    diameterMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    insulationThicknessMm: number | null;
}

export interface SpatialGeometryView {
    aabb: SpatialAabb | null;
    centerline: SpatialPoint3[];
    curveType: string | null;
    point: SpatialPoint3 | null;
    boundaryLoops: SpatialPoint3[][];
    direction: SpatialPoint3 | null;
    profile: SpatialProfile;
    basis: string;
    precisionClass: string;
}

export interface SpatialContainmentResult {
    elementNodeId: string;
    spaceNodeId: string;
    status: "inside" | "partial" | "boundary" | "outside" | "unsupported";
    basis: string;
    precisionClass: "candidate" | "measured";
    verdictCapability: "context_only";
    insideSampleCount: number;
    boundarySampleCount: number;
    outsideSampleCount: number;
    segmentBoundaryCrossing: boolean;
}

const EPSILON_MM = 1e-6;

function point3(value: unknown): SpatialPoint3 | null {
    if (!Array.isArray(value) || value.length !== 3) return null;
    const coordinates = value.map(finiteNumber);
    return coordinates.every((coordinate) => coordinate !== null)
        ? [coordinates[0]!, coordinates[1]!, coordinates[2]!]
        : null;
}

function objectAt(value: unknown, paths: readonly (readonly string[])[]) {
    const candidate = firstDefined(value, paths);
    return isJsonObject(candidate) ? candidate : null;
}

function nonNegative(value: unknown): number | null {
    const parsed = finiteNumber(value);
    return parsed !== null && parsed >= 0 ? parsed : null;
}

function parseProfile(payload: Record<string, unknown>): SpatialProfile {
    const profile = objectAt(payload, [
        ["profile"],
        ["spatialProperties", "profile"],
        ["physicalProfile"],
        ["geometry", "profile"],
    ]) ?? {};
    const rawShape = (cleanText(profile.shape)
        ?? cleanText(profile.profileShape)
        ?? cleanText(firstDefined(payload, [["shape"]])))?.toLowerCase() ?? "unknown";
    const diameterMm = nonNegative(profile.diameterMm ?? profile.outerDiameterMm);
    const widthMm = nonNegative(profile.widthMm);
    const heightMm = nonNegative(profile.heightMm);
    const shape = rawShape.includes("round") || rawShape.includes("circular") || diameterMm !== null
        ? "round"
        : rawShape.includes("rect") || (widthMm !== null && heightMm !== null)
            ? "rectangular"
            : "unknown";
    return {
        shape,
        diameterMm,
        widthMm,
        heightMm,
        insulationThicknessMm: nonNegative(
            profile.insulationThicknessMm
            ?? firstDefined(payload, [
                ["spatialProperties", "insulationThicknessMm"],
                ["insulationThicknessMm"],
            ]),
        ),
    };
}

export function spatialGeometry(node: SpatialStoredNode): SpatialGeometryView {
    const geometry = objectAt(node.payload, [["geometry"]]) ?? {};
    const centerlineObject = isJsonObject(geometry.centerline) ? geometry.centerline : null;
    const centerline = Array.isArray(centerlineObject?.points)
        ? centerlineObject.points.map(point3).filter((item): item is SpatialPoint3 => item !== null)
        : [];
    const pointLocation = isJsonObject(geometry.pointLocation) ? geometry.pointLocation : null;
    const point = point3(pointLocation?.point);
    const boundaryLoops = Array.isArray(geometry.boundaryLoops)
        ? geometry.boundaryLoops
            .filter(Array.isArray)
            .map((loop) => loop.map(point3).filter((item): item is SpatialPoint3 => item !== null))
            .filter((loop) => loop.length >= 3)
        : [];
    return {
        aabb: node.aabb,
        centerline,
        curveType: cleanText(centerlineObject?.curveType),
        point,
        boundaryLoops,
        direction: point3(geometry.direction),
        profile: parseProfile(node.payload),
        basis: cleanText(geometry.basis) ?? (node.aabb ? "aabb" : "unsupported"),
        precisionClass: cleanText(geometry.precisionClass) ?? (node.aabb ? "aabb_only" : "unsupported"),
    };
}

export function inflateAabb(aabb: SpatialAabb, distanceMm: number): SpatialAabb {
    const distance = Math.max(0, distanceMm);
    return {
        minMm: [aabb.minMm[0] - distance, aabb.minMm[1] - distance, aabb.minMm[2] - distance],
        maxMm: [aabb.maxMm[0] + distance, aabb.maxMm[1] + distance, aabb.maxMm[2] + distance],
    };
}

export function mergeAabbs(left: SpatialAabb | null, right: SpatialAabb | null): SpatialAabb | null {
    if (!left) return right;
    if (!right) return left;
    return {
        minMm: [
            Math.min(left.minMm[0], right.minMm[0]),
            Math.min(left.minMm[1], right.minMm[1]),
            Math.min(left.minMm[2], right.minMm[2]),
        ],
        maxMm: [
            Math.max(left.maxMm[0], right.maxMm[0]),
            Math.max(left.maxMm[1], right.maxMm[1]),
            Math.max(left.maxMm[2], right.maxMm[2]),
        ],
    };
}

export function aabbCenter(aabb: SpatialAabb): SpatialPoint3 {
    return [
        (aabb.minMm[0] + aabb.maxMm[0]) / 2,
        (aabb.minMm[1] + aabb.maxMm[1]) / 2,
        (aabb.minMm[2] + aabb.maxMm[2]) / 2,
    ];
}

function subtract(left: SpatialPoint3, right: SpatialPoint3): SpatialPoint3 {
    return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function add(left: SpatialPoint3, right: SpatialPoint3): SpatialPoint3 {
    return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function scale(value: SpatialPoint3, factor: number): SpatialPoint3 {
    return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(left: SpatialPoint3, right: SpatialPoint3): number {
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function length(value: SpatialPoint3): number {
    return Math.sqrt(dot(value, value));
}

function normalize(value: SpatialPoint3): SpatialPoint3 | null {
    const magnitude = length(value);
    return magnitude > EPSILON_MM ? scale(value, 1 / magnitude) : null;
}

export function aabbRelation(
    sourceNodeId: string,
    targetNodeId: string,
    source: SpatialAabb,
    target: SpatialAabb,
): SpatialComputedRelation {
    const gaps: SpatialPoint3 = [
        Math.max(0, source.minMm[0] - target.maxMm[0], target.minMm[0] - source.maxMm[0]),
        Math.max(0, source.minMm[1] - target.maxMm[1], target.minMm[1] - source.maxMm[1]),
        Math.max(0, source.minMm[2] - target.maxMm[2], target.minMm[2] - source.maxMm[2]),
    ];
    const separationMm = length(gaps);
    const intersects = gaps.every((gap) => gap <= EPSILON_MM);
    const overlaps = [0, 1, 2].map((axis) => Math.min(source.maxMm[axis], target.maxMm[axis])
        - Math.max(source.minMm[axis], target.minMm[axis]));
    const direction = normalize(subtract(aabbCenter(target), aabbCenter(source)));
    return {
        sourceNodeId,
        targetNodeId,
        relation: intersects ? "intersects_candidate" : "separated",
        separationMm,
        intersects,
        penetrationDepthMm: intersects ? Math.max(0, Math.min(...overlaps)) : null,
        direction,
        basis: "aabb",
        precisionClass: "candidate",
        verdictCapability: "screening_only",
    };
}

function segmentDistance(
    firstStart: SpatialPoint3,
    firstEnd: SpatialPoint3,
    secondStart: SpatialPoint3,
    secondEnd: SpatialPoint3,
): number {
    const first = subtract(firstEnd, firstStart);
    const second = subtract(secondEnd, secondStart);
    const offset = subtract(firstStart, secondStart);
    const a = dot(first, first);
    const e = dot(second, second);
    const f = dot(second, offset);
    let firstParameter = 0;
    let secondParameter = 0;
    if (a <= EPSILON_MM && e <= EPSILON_MM) return length(offset);
    if (a <= EPSILON_MM) {
        secondParameter = Math.max(0, Math.min(1, f / e));
    } else {
        const c = dot(first, offset);
        if (e <= EPSILON_MM) {
            firstParameter = Math.max(0, Math.min(1, -c / a));
        } else {
            const b = dot(first, second);
            const denominator = a * e - b * b;
            if (Math.abs(denominator) > EPSILON_MM) {
                firstParameter = Math.max(0, Math.min(1, (b * f - c * e) / denominator));
            }
            secondParameter = (b * firstParameter + f) / e;
            if (secondParameter < 0) {
                secondParameter = 0;
                firstParameter = Math.max(0, Math.min(1, -c / a));
            } else if (secondParameter > 1) {
                secondParameter = 1;
                firstParameter = Math.max(0, Math.min(1, (b - c) / a));
            }
        }
    }
    const firstClosest = add(firstStart, scale(first, firstParameter));
    const secondClosest = add(secondStart, scale(second, secondParameter));
    return length(subtract(firstClosest, secondClosest));
}

function polylineDistance(first: readonly SpatialPoint3[], second: readonly SpatialPoint3[]): number | null {
    if (first.length < 2 || second.length < 2) return null;
    let minimum = Number.POSITIVE_INFINITY;
    for (let firstIndex = 1; firstIndex < first.length; firstIndex += 1) {
        for (let secondIndex = 1; secondIndex < second.length; secondIndex += 1) {
            minimum = Math.min(minimum, segmentDistance(
                first[firstIndex - 1],
                first[firstIndex],
                second[secondIndex - 1],
                second[secondIndex],
            ));
        }
    }
    return Number.isFinite(minimum) ? minimum : null;
}

function roundOuterRadius(profile: SpatialProfile): number | null {
    return profile.shape === "round"
        && profile.diameterMm !== null
        && profile.insulationThicknessMm !== null
        ? profile.diameterMm / 2 + profile.insulationThicknessMm
        : null;
}

export function relationBetweenNodes(source: SpatialStoredNode, target: SpatialStoredNode): SpatialComputedRelation | null {
    const sourceGeometry = spatialGeometry(source);
    const targetGeometry = spatialGeometry(target);
    const sourceRadius = roundOuterRadius(sourceGeometry.profile);
    const targetRadius = roundOuterRadius(targetGeometry.profile);
    const analyticDistance = sourceRadius !== null && targetRadius !== null
        && sourceGeometry.curveType?.toLowerCase() === "line"
        && targetGeometry.curveType?.toLowerCase() === "line"
        && sourceGeometry.centerline.length === 2 && targetGeometry.centerline.length === 2
        ? polylineDistance(sourceGeometry.centerline, targetGeometry.centerline)
        : null;
    if (analyticDistance !== null) {
        const signedSeparation = analyticDistance - sourceRadius! - targetRadius!;
        return {
            sourceNodeId: source.nodeId,
            targetNodeId: target.nodeId,
            relation: signedSeparation <= EPSILON_MM ? "intersects_analytic_profile" : "separated",
            separationMm: Math.max(0, signedSeparation),
            intersects: signedSeparation <= EPSILON_MM,
            penetrationDepthMm: signedSeparation < 0 ? -signedSeparation : null,
            direction: source.aabb && target.aabb
                ? normalize(subtract(aabbCenter(target.aabb), aabbCenter(source.aabb)))
                : null,
            basis: "analytic_straight_round_swept_profile",
            precisionClass: "measured",
            verdictCapability: "context_only",
        };
    }
    if (source.aabb && target.aabb) {
        return aabbRelation(source.nodeId, target.nodeId, source.aabb, target.aabb);
    }
    return null;
}

export function aboveBelowRelation(
    source: SpatialStoredNode,
    target: SpatialStoredNode,
    toleranceMm = 0,
): SpatialComputedRelation | null {
    if (!source.aabb || !target.aabb) return null;
    const tolerance = Math.max(0, toleranceMm);
    const base = aabbRelation(source.nodeId, target.nodeId, source.aabb, target.aabb);
    let verticalRelation: SpatialComputedRelation["verticalRelation"];
    let gap = 0;
    if (source.aabb.minMm[2] > target.aabb.maxMm[2] + tolerance + EPSILON_MM) {
        verticalRelation = "above";
        gap = source.aabb.minMm[2] - target.aabb.maxMm[2];
    } else if (source.aabb.maxMm[2] < target.aabb.minMm[2] - tolerance - EPSILON_MM) {
        verticalRelation = "below";
        gap = target.aabb.minMm[2] - source.aabb.maxMm[2];
    } else {
        const delta = aabbCenter(source.aabb)[2] - aabbCenter(target.aabb)[2];
        verticalRelation = Math.abs(delta) <= tolerance ? "coincident" : "overlapping";
    }
    return {
        ...base,
        relation: `vertical_${verticalRelation}`,
        separationMm: gap,
        verticalRelation,
        basis: "aabb_vertical_extents",
        precisionClass: "candidate",
        verdictCapability: "screening_only",
    };
}

function pointOnSegment2d(point: SpatialPoint3, start: SpatialPoint3, end: SpatialPoint3): boolean {
    const segmentX = end[0] - start[0];
    const segmentY = end[1] - start[1];
    const squaredLength = segmentX ** 2 + segmentY ** 2;
    if (squaredLength <= EPSILON_MM ** 2) {
        return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2 <= EPSILON_MM ** 2;
    }
    const cross = (point[1] - start[1]) * (end[0] - start[0])
        - (point[0] - start[0]) * (end[1] - start[1]);
    if (Math.abs(cross) > EPSILON_MM) return false;
    const dotValue = (point[0] - start[0]) * (end[0] - start[0])
        + (point[1] - start[1]) * (end[1] - start[1]);
    if (dotValue < -EPSILON_MM) return false;
    return dotValue <= squaredLength + EPSILON_MM;
}

function pointInLoops2d(point: SpatialPoint3, loops: readonly SpatialPoint3[][]): "inside" | "boundary" | "outside" {
    let crossings = 0;
    for (const loop of loops) {
        for (let index = 0; index < loop.length; index += 1) {
            const start = loop[index];
            const end = loop[(index + 1) % loop.length];
            if (pointOnSegment2d(point, start, end)) return "boundary";
            const straddles = (start[1] > point[1]) !== (end[1] > point[1]);
            if (!straddles) continue;
            const intersectionX = start[0]
                + ((point[1] - start[1]) * (end[0] - start[0])) / (end[1] - start[1]);
            if (intersectionX > point[0]) crossings += 1;
        }
    }
    return crossings % 2 === 1 ? "inside" : "outside";
}

function segmentIntersectsBoundaryWithinVerticalExtent(
    segmentStart: SpatialPoint3,
    segmentEnd: SpatialPoint3,
    boundaryStart: SpatialPoint3,
    boundaryEnd: SpatialPoint3,
    extent: SpatialAabb,
): boolean {
    const rx = segmentEnd[0] - segmentStart[0];
    const ry = segmentEnd[1] - segmentStart[1];
    const sx = boundaryEnd[0] - boundaryStart[0];
    const sy = boundaryEnd[1] - boundaryStart[1];
    const qx = boundaryStart[0] - segmentStart[0];
    const qy = boundaryStart[1] - segmentStart[1];
    const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
    const crossRs = cross(rx, ry, sx, sy);
    const crossQr = cross(qx, qy, rx, ry);
    const zAt = (parameter: number) => segmentStart[2] + (segmentEnd[2] - segmentStart[2]) * parameter;
    const parameterHasVerticalOverlap = (minimum: number, maximum: number) => {
        const lower = Math.max(0, Math.min(minimum, maximum));
        const upper = Math.min(1, Math.max(minimum, maximum));
        if (lower > upper + EPSILON_MM) return false;
        const deltaZ = segmentEnd[2] - segmentStart[2];
        if (Math.abs(deltaZ) <= EPSILON_MM) {
            return segmentStart[2] >= extent.minMm[2] - EPSILON_MM
                && segmentStart[2] <= extent.maxMm[2] + EPSILON_MM;
        }
        const first = (extent.minMm[2] - segmentStart[2]) / deltaZ;
        const second = (extent.maxMm[2] - segmentStart[2]) / deltaZ;
        const verticalLower = Math.min(first, second) - EPSILON_MM;
        const verticalUpper = Math.max(first, second) + EPSILON_MM;
        return upper >= verticalLower && lower <= verticalUpper;
    };

    if (Math.abs(crossRs) > EPSILON_MM) {
        const segmentParameter = cross(qx, qy, sx, sy) / crossRs;
        const boundaryParameter = cross(qx, qy, rx, ry) / crossRs;
        if (segmentParameter < -EPSILON_MM || segmentParameter > 1 + EPSILON_MM
            || boundaryParameter < -EPSILON_MM || boundaryParameter > 1 + EPSILON_MM) return false;
        const intersectionZ = zAt(Math.max(0, Math.min(1, segmentParameter)));
        return intersectionZ >= extent.minMm[2] - EPSILON_MM
            && intersectionZ <= extent.maxMm[2] + EPSILON_MM;
    }

    if (Math.abs(crossQr) > EPSILON_MM) return false;
    const squaredLength = rx * rx + ry * ry;
    if (squaredLength <= EPSILON_MM * EPSILON_MM) {
        return pointOnSegment2d(segmentStart, boundaryStart, boundaryEnd)
            && segmentOverlapsVerticalExtent(segmentStart, segmentEnd, extent);
    }
    const firstParameter = (qx * rx + qy * ry) / squaredLength;
    const secondParameter = ((boundaryEnd[0] - segmentStart[0]) * rx
        + (boundaryEnd[1] - segmentStart[1]) * ry) / squaredLength;
    return parameterHasVerticalOverlap(firstParameter, secondParameter);
}

function segmentOverlapsVerticalExtent(start: SpatialPoint3, end: SpatialPoint3, extent: SpatialAabb): boolean {
    const minimumZ = Math.min(start[2], end[2]);
    const maximumZ = Math.max(start[2], end[2]);
    return maximumZ >= extent.minMm[2] - EPSILON_MM
        && minimumZ <= extent.maxMm[2] + EPSILON_MM;
}

function nodeSamples(geometry: SpatialGeometryView): SpatialPoint3[] {
    if (geometry.point) return [geometry.point];
    if (geometry.centerline.length > 0) {
        const samples: SpatialPoint3[] = [];
        for (let index = 0; index < geometry.centerline.length; index += 1) {
            samples.push(geometry.centerline[index]);
            if (index > 0) {
                const prior = geometry.centerline[index - 1];
                const current = geometry.centerline[index];
                samples.push([
                    (prior[0] + current[0]) / 2,
                    (prior[1] + current[1]) / 2,
                    (prior[2] + current[2]) / 2,
                ]);
            }
        }
        return samples;
    }
    if (geometry.boundaryLoops.length > 0) {
        const samples: SpatialPoint3[] = [];
        for (const loop of geometry.boundaryLoops) {
            for (let index = 0; index < loop.length; index += 1) {
                const current = loop[index];
                const next = loop[(index + 1) % loop.length];
                samples.push(current, [
                    (current[0] + next[0]) / 2,
                    (current[1] + next[1]) / 2,
                    (current[2] + next[2]) / 2,
                ]);
            }
        }
        return samples;
    }
    return [];
}

function clippedSegmentSamplesForVerticalExtent(
    start: SpatialPoint3,
    end: SpatialPoint3,
    extent: SpatialAabb,
): SpatialPoint3[] {
    const deltaZ = end[2] - start[2];
    if (Math.abs(deltaZ) <= EPSILON_MM) return [];
    const first = (extent.minMm[2] - start[2]) / deltaZ;
    const second = (extent.maxMm[2] - start[2]) / deltaZ;
    const lower = Math.max(0, Math.min(first, second));
    const upper = Math.min(1, Math.max(first, second));
    if (lower > upper + EPSILON_MM) return [];
    const pointAt = (parameter: number): SpatialPoint3 => [
        start[0] + (end[0] - start[0]) * parameter,
        start[1] + (end[1] - start[1]) * parameter,
        start[2] + deltaZ * parameter,
    ];
    return [pointAt(lower), pointAt((lower + upper) / 2), pointAt(upper)];
}

function appendUniqueSample(samples: SpatialPoint3[], candidate: SpatialPoint3): void {
    if (samples.some((sample) => sample.every((coordinate, axis) =>
        Math.abs(coordinate - candidate[axis]) <= EPSILON_MM))) return;
    samples.push(candidate);
}

export function locateNodeInSpace(element: SpatialStoredNode, space: SpatialStoredNode): SpatialContainmentResult {
    const elementGeometry = spatialGeometry(element);
    const spaceGeometry = spatialGeometry(space);
    if (!space.aabb || spaceGeometry.boundaryLoops.length === 0) {
        return {
            elementNodeId: element.nodeId,
            spaceNodeId: space.nodeId,
            status: "unsupported",
            basis: "spatial_boundary_unavailable",
            precisionClass: "candidate",
            verdictCapability: "context_only",
            insideSampleCount: 0,
            boundarySampleCount: 0,
            outsideSampleCount: 0,
            segmentBoundaryCrossing: false,
        };
    }
    const samples = nodeSamples(elementGeometry);
    if (samples.length === 0) {
        return {
            elementNodeId: element.nodeId,
            spaceNodeId: space.nodeId,
            status: "unsupported",
            basis: "element_point_centerline_or_boundary_unavailable",
            precisionClass: "candidate",
            verdictCapability: "context_only",
            insideSampleCount: 0,
            boundarySampleCount: 0,
            outsideSampleCount: 0,
            segmentBoundaryCrossing: false,
        };
    }
    let segmentBoundaryCrossing = false;
    for (let index = 1; index < elementGeometry.centerline.length; index += 1) {
        const start = elementGeometry.centerline[index - 1];
        const end = elementGeometry.centerline[index];
        const clippedSamples = clippedSegmentSamplesForVerticalExtent(start, end, space.aabb);
        for (const sample of clippedSamples) appendUniqueSample(samples, sample);
        const crossesVerticalBoundary = start[2] < space.aabb.minMm[2] - EPSILON_MM
            || start[2] > space.aabb.maxMm[2] + EPSILON_MM
            || end[2] < space.aabb.minMm[2] - EPSILON_MM
            || end[2] > space.aabb.maxMm[2] + EPSILON_MM;
        if (crossesVerticalBoundary && clippedSamples.some((sample) =>
            pointInLoops2d(sample, spaceGeometry.boundaryLoops) !== "outside")) {
            segmentBoundaryCrossing = true;
        }
    }

    let insideSampleCount = 0;
    let boundarySampleCount = 0;
    let outsideSampleCount = 0;
    for (const sample of samples) {
        const verticallyInside = sample[2] >= space.aabb.minMm[2] - EPSILON_MM
            && sample[2] <= space.aabb.maxMm[2] + EPSILON_MM;
        const horizontal = pointInLoops2d(sample, spaceGeometry.boundaryLoops);
        if (!verticallyInside || horizontal === "outside") outsideSampleCount += 1;
        else if (horizontal === "boundary") boundarySampleCount += 1;
        else insideSampleCount += 1;
    }
    for (let index = 1; index < elementGeometry.centerline.length && !segmentBoundaryCrossing; index += 1) {
        const start = elementGeometry.centerline[index - 1];
        const end = elementGeometry.centerline[index];
        if (!segmentOverlapsVerticalExtent(start, end, space.aabb)) continue;
        for (const loop of spaceGeometry.boundaryLoops) {
            for (let edgeIndex = 0; edgeIndex < loop.length; edgeIndex += 1) {
                if (segmentIntersectsBoundaryWithinVerticalExtent(
                    start,
                    end,
                    loop[edgeIndex],
                    loop[(edgeIndex + 1) % loop.length],
                    space.aabb,
                )) {
                    segmentBoundaryCrossing = true;
                    break;
                }
            }
            if (segmentBoundaryCrossing) break;
        }
    }
    for (const elementLoop of elementGeometry.boundaryLoops) {
        for (let index = 0; index < elementLoop.length && !segmentBoundaryCrossing; index += 1) {
            const start = elementLoop[index];
            const end = elementLoop[(index + 1) % elementLoop.length];
            if (!segmentOverlapsVerticalExtent(start, end, space.aabb)) continue;
            for (const spaceLoop of spaceGeometry.boundaryLoops) {
                for (let edgeIndex = 0; edgeIndex < spaceLoop.length; edgeIndex += 1) {
                    if (segmentIntersectsBoundaryWithinVerticalExtent(
                        start,
                        end,
                        spaceLoop[edgeIndex],
                        spaceLoop[(edgeIndex + 1) % spaceLoop.length],
                        space.aabb,
                    )) {
                        segmentBoundaryCrossing = true;
                        break;
                    }
                }
                if (segmentBoundaryCrossing) break;
            }
        }
    }
    const status = boundarySampleCount > 0 && insideSampleCount === 0 && outsideSampleCount === 0
            ? "boundary"
            : insideSampleCount > 0 && outsideSampleCount === 0 && !segmentBoundaryCrossing
                ? "inside"
                : insideSampleCount > 0 || boundarySampleCount > 0 || segmentBoundaryCrossing
                    ? "partial"
                    : "outside";
    return {
        elementNodeId: element.nodeId,
        spaceNodeId: space.nodeId,
        status,
        basis: "stored_boundary_loops_and_vertical_extent",
        precisionClass: "measured",
        verdictCapability: "context_only",
        insideSampleCount,
        boundarySampleCount,
        outsideSampleCount,
        segmentBoundaryCrossing,
    };
}

function normalizedPoints(points: readonly SpatialPoint3[], anchor: SpatialPoint3): SpatialPoint3[] {
    return points.map((point) => subtract(point, anchor));
}

export function derivedPlacementFingerprint(node: SpatialStoredNode): string {
    if (node.placementFingerprint) return node.placementFingerprint;
    const geometry = spatialGeometry(node);
    const anchor = geometry.point ?? geometry.centerline[0] ?? (geometry.aabb ? aabbCenter(geometry.aabb) : [0, 0, 0]);
    return sha256Canonical({ version: "phase1b-derived-placement/1", anchor });
}

export function derivedShapeFingerprint(node: SpatialStoredNode): string {
    if (node.shapeFingerprint) return node.shapeFingerprint;
    const geometry = spatialGeometry(node);
    const anchor = geometry.point ?? geometry.centerline[0] ?? (geometry.aabb ? aabbCenter(geometry.aabb) : [0, 0, 0]);
    const extents = geometry.aabb ? [
        geometry.aabb.maxMm[0] - geometry.aabb.minMm[0],
        geometry.aabb.maxMm[1] - geometry.aabb.minMm[1],
        geometry.aabb.maxMm[2] - geometry.aabb.minMm[2],
    ] : null;
    return sha256Canonical({
        version: "phase1b-derived-shape/1",
        centerline: normalizedPoints(geometry.centerline, anchor),
        boundaryLoops: geometry.boundaryLoops.map((loop) => normalizedPoints(loop, anchor)),
        extents,
        profile: geometry.profile,
        curveType: geometry.curveType,
    });
}

export function derivedPropertyFingerprint(node: SpatialStoredNode): string {
    if (node.propertyFingerprint) return node.propertyFingerprint;
    return sha256Canonical({
        version: "phase1b-derived-property/1",
        category: node.category,
        builtInCategory: node.builtInCategory,
        categoryRole: node.categoryRole,
        levelUniqueId: node.levelUniqueId,
        levelName: node.levelName,
        systemKey: node.systemKey,
        name: firstDefined(node.payload, [["name"]]),
        familyName: firstDefined(node.payload, [["familyName"]]),
        typeName: firstDefined(node.payload, [["typeName"]]),
        spatialProperties: firstDefined(node.payload, [["spatialProperties"]]),
    });
}

export function derivedTopologyFingerprint(node: SpatialStoredNode): string | null {
    if (node.topologyFingerprint) return node.topologyFingerprint;
    const peers = firstDefined(node.payload, [
        ["connectedToNodeIds"],
        ["peerNodeIds"],
        ["topology", "connectedToNodeIds"],
    ]);
    if (node.nodeKind !== "connector" && !Array.isArray(peers)) return null;
    return sha256Canonical({
        version: "phase1b-derived-topology/1",
        ownerNodeId: node.ownerNodeId,
        peers: Array.isArray(peers) ? [...new Set(peers.map(String))].sort() : [],
        systemKey: node.systemKey,
        isConnected: firstDefined(node.payload, [["isConnected"]]) === true,
    });
}
