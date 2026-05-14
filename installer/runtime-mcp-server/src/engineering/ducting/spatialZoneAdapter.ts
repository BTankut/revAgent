import {
    aabbFromValue,
    asNumber,
    asRecord,
    pointFromValue,
    round,
    stringByFields,
    valueByFields,
} from "./helpers.js";
import type { AabbMm, IssueSeverity, PointMm } from "./types.js";

export interface SpatialZoneObstacleSummary {
    id: string;
    name?: string;
    obstacleType?: string;
    sourceLink?: string;
    aabbMm: AabbMm;
    raw: Record<string, unknown>;
}

export interface SpatialZoneShaftSummary {
    id: string;
    name?: string;
    centroidMm?: PointMm;
    zMinMm?: number;
    zMaxMm?: number;
    aabbMm?: AabbMm;
    raw: Record<string, unknown>;
}

export interface SpatialZonePlenumSummary {
    id: string;
    sourceRoomId?: string;
    levelName?: string;
    zMinMm?: number;
    zMaxMm?: number;
    raw: Record<string, unknown>;
}

export interface SpatialZoneRoutingContext {
    schemaVersion: "spatial-zone-extract.v1";
    obstacles: SpatialZoneObstacleSummary[];
    plenumVolumes: SpatialZonePlenumSummary[];
    shafts: SpatialZoneShaftSummary[];
    allowedElevationsMm: number[];
    routingBounds?: AabbMm;
    issues: Array<{ severity: IssueSeverity; code: string; message: string; context?: Record<string, unknown> }>;
    summary: {
        obstacleCount: number;
        plenumCount: number;
        shaftCount: number;
        derivedElevationCount: number;
    };
}

function readObstacleSummary(raw: Record<string, unknown>, index: number): SpatialZoneObstacleSummary | undefined {
    const aabb = aabbFromValue(valueByFields(raw, ["aabbMm", "aabb_mm", "aabb", "box"]) ?? raw);
    if (!aabb) return undefined;
    return {
        id: stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `obstacle-${index + 1}`,
        name: stringByFields(raw, ["name", "category", "obstacleType", "obstacle_type"]),
        obstacleType: stringByFields(raw, ["obstacleType", "obstacle_type"]),
        sourceLink: stringByFields(raw, ["sourceLink", "source_link"]),
        aabbMm: aabb,
        raw,
    };
}

function readShaftSummary(raw: Record<string, unknown>, index: number): SpatialZoneShaftSummary {
    const boundary = asRecord(valueByFields(raw, ["boundary"]));
    const boundaryAabb = aabbFromValue(boundary) ?? aabbFromValue(valueByFields(boundary, ["aabbMm", "aabb_mm", "aabb"]));
    const centroid = pointFromValue(valueByFields(raw, ["centroidMm", "centroid_mm", "centroid"]));
    const zMin = asNumber(valueByFields(raw, ["zMinMm", "z_min_mm", "zMin", "z_min"]));
    const zMax = asNumber(valueByFields(raw, ["zMaxMm", "z_max_mm", "zMax", "z_max"]));
    return {
        id: stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `shaft-${index + 1}`,
        name: stringByFields(raw, ["name", "category"]),
        centroidMm: centroid,
        zMinMm: zMin,
        zMaxMm: zMax,
        aabbMm: boundaryAabb,
        raw,
    };
}

function readPlenumSummary(raw: Record<string, unknown>, index: number): SpatialZonePlenumSummary {
    return {
        id: stringByFields(raw, ["id", "elementId", "element_id", "uniqueId", "unique_id"]) ?? `plenum-${index + 1}`,
        sourceRoomId: stringByFields(raw, ["sourceRoomId", "source_room_id", "sourceSpatialId", "source_spatial_id"]),
        levelName: stringByFields(raw, ["levelName", "level_name"]),
        zMinMm: asNumber(valueByFields(raw, ["zMinMm", "z_min_mm"])),
        zMaxMm: asNumber(valueByFields(raw, ["zMaxMm", "z_max_mm"])),
        raw,
    };
}

function uniqueSortedRounded(values: Array<number | undefined>, fractionDigits = 1): number[] {
    const seen = new Set<number>();
    const result: number[] = [];
    for (const entry of values) {
        if (entry === undefined || !Number.isFinite(entry)) continue;
        const rounded = round(entry, fractionDigits);
        if (seen.has(rounded)) continue;
        seen.add(rounded);
        result.push(rounded);
    }
    result.sort((left, right) => left - right);
    return result;
}

export function mapSpatialZoneToRoutingContext(input: unknown): SpatialZoneRoutingContext {
    const record = asRecord(input);
    const schemaVersion = stringByFields(record, ["schemaVersion", "schema_version"]) ?? "spatial-zone-extract.v1";
    const obstaclesRaw = Array.isArray(record.obstacles) ? record.obstacles.map(asRecord) : [];
    const rawPlenums = valueByFields(record, ["plenumVolumes", "plenum_volumes"]);
    const plenumsRaw = Array.isArray(rawPlenums) ? (rawPlenums as unknown[]).map(asRecord) : [];
    const shaftsRaw = Array.isArray(record.shafts) ? record.shafts.map(asRecord) : [];

    const obstacles: SpatialZoneObstacleSummary[] = [];
    let skippedObstacles = 0;
    obstaclesRaw.forEach((raw, index) => {
        const summary = readObstacleSummary(raw, index);
        if (summary) obstacles.push(summary);
        else skippedObstacles++;
    });

    const plenumVolumes = plenumsRaw.map(readPlenumSummary);
    const shafts = shaftsRaw.map(readShaftSummary);
    const allowedElevationsMm = uniqueSortedRounded(
        plenumVolumes.flatMap((entry) => [entry.zMinMm, entry.zMaxMm]),
    );

    const issues: SpatialZoneRoutingContext["issues"] = [];

    // spatial-zone-extract.cs always emits top-level `warnings` and `errors` arrays
    // (see references/patterns/spatial-zone-extract.cs). The failure payload returns
    // empty geometry plus populated `errors`; surface those so a failed extraction
    // cannot silently produce "pass" routes downstream.
    const payloadErrors = Array.isArray(record.errors)
        ? record.errors.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        : [];
    const payloadWarnings = Array.isArray(record.warnings)
        ? record.warnings.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        : [];
    for (const message of payloadErrors) {
        issues.push({
            severity: "error",
            code: "spatial_zone_extract_error",
            message,
        });
    }
    for (const message of payloadWarnings) {
        issues.push({
            severity: "warning",
            code: "spatial_zone_extract_warning",
            message,
        });
    }

    if (schemaVersion !== "spatial-zone-extract.v1") {
        issues.push({
            severity: "warning",
            code: "spatial_zone_schema_unknown",
            message: "spatial-zone schema_version did not match spatial-zone-extract.v1; treating as a best-effort match.",
            context: { schemaVersion },
        });
    }
    if (skippedObstacles > 0) {
        issues.push({
            severity: "warning",
            code: "spatial_zone_obstacle_aabb_unreadable",
            message: "Some spatial-zone obstacles were skipped because their aabb_mm could not be parsed.",
            context: { skippedObstacleCount: skippedObstacles },
        });
    }
    if (plenumVolumes.length > 0 && allowedElevationsMm.length === 0) {
        issues.push({
            severity: "warning",
            code: "spatial_zone_plenum_elevation_missing",
            message: "Plenum volumes were provided but no z_min_mm/z_max_mm could be derived; allowedElevationsMm is empty.",
            context: { plenumCount: plenumVolumes.length },
        });
    }
    if (obstacles.length === 0 && obstaclesRaw.length === 0 && plenumVolumes.length === 0 && shafts.length === 0) {
        issues.push({
            severity: "info",
            code: "spatial_zone_empty",
            message: "spatial-zone payload is empty; routing context is degraded to no-obstacle defaults.",
        });
    }

    return {
        schemaVersion: "spatial-zone-extract.v1",
        obstacles,
        plenumVolumes,
        shafts,
        allowedElevationsMm,
        issues,
        summary: {
            obstacleCount: obstacles.length,
            plenumCount: plenumVolumes.length,
            shaftCount: shafts.length,
            derivedElevationCount: allowedElevationsMm.length,
        },
    };
}
