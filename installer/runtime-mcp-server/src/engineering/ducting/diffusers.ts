import {
    aabbFromValue,
    asRecord,
    makeIssue,
    numberByFields,
    round,
    stringByFields,
    validationStatus,
} from "./helpers.js";
import type {
    AirSystemKind,
    AirflowAssignment,
    AabbMm,
    DiffuserCandidate,
    DiffuserSelection,
    DiffuserType,
    DuctingRules,
    EngineeringIssue,
    SpaceDiffuserPlan,
    SpaceRecord,
    ValidationResult,
} from "./types.js";

function normalizeSystem(value: unknown): AirSystemKind | undefined {
    const text = String(value ?? "").trim().toLowerCase();
    if (["supply", "sa", "besleme"].includes(text)) return "supply";
    if (["return", "ra", "donus"].includes(text)) return "return";
    if (["exhaust", "ea", "egzoz"].includes(text)) return "exhaust";
    return undefined;
}

export function normalizeDiffuserCatalog(input: Record<string, unknown>[] = []): DiffuserType[] {
    const result: DiffuserType[] = [];
    input.forEach((raw, index) => {
        const record = asRecord(raw);
        const system = normalizeSystem(stringByFields(record, ["system", "airSystem", "air_system", "classification"]));
        const minFlowLps = numberByFields(record, ["minFlowLps", "min_flow_lps", "minimumFlowLps", "min_lps"]) ?? 0;
        const maxFlowLps = numberByFields(record, ["maxFlowLps", "max_flow_lps", "maximumFlowLps", "max_lps"]);
        if (!system || maxFlowLps === undefined || maxFlowLps <= 0) return;
        result.push({
            id: stringByFields(record, ["id", "typeId", "type_id", "model"]) ?? `diffuser-type-${index + 1}`,
            model: stringByFields(record, ["model", "typeName", "type_name", "familyType", "family_type"]) ?? `Diffuser ${index + 1}`,
            system,
            minFlowLps: Math.max(0, minFlowLps),
            maxFlowLps,
            preferredFlowLps: numberByFields(record, ["preferredFlowLps", "preferred_flow_lps", "nominalFlowLps", "nominal_flow_lps"]),
            noiseCriterion: numberByFields(record, ["noiseCriterion", "noise_criterion", "nc", "nr"]),
            throwM: numberByFields(record, ["throwM", "throw_m"]),
            neckSizeMm: stringByFields(record, ["neckSizeMm", "neck_size_mm", "neckSize"]),
            source: record,
        });
    });
    return result;
}

function flowForSystem(assignment: AirflowAssignment, system: AirSystemKind): number {
    if (system === "supply") return assignment.flows.supplyLps;
    if (system === "return") return assignment.flows.returnLps;
    return assignment.flows.exhaustLps;
}

function selectDiffuserType(
    system: AirSystemKind,
    totalAirflowLps: number,
    catalog: DiffuserType[],
    rules: DuctingRules,
): DiffuserSelection {
    const issues: EngineeringIssue[] = [];
    const maxDiffusers = Math.max(1, Math.floor(rules.maxDiffusersPerSpace ?? 12));
    const available = catalog.filter((entry) => entry.system === system);
    if (available.length === 0) {
        return {
            system,
            diffuserCount: 0,
            airflowPerDiffuserLps: 0,
            totalAirflowLps,
            issues: [makeIssue("no_valid_diffuser_type", "error", "No diffuser type is available for this air system.", { system })],
        };
    }

    let best: { type: DiffuserType; count: number; flow: number; score: number } | undefined;
    for (const type of available) {
        for (let count = 1; count <= maxDiffusers; count++) {
            const perDiffuser = totalAirflowLps / count;
            if (perDiffuser < type.minFlowLps || perDiffuser > type.maxFlowLps) continue;
            const preferred = type.preferredFlowLps ?? (type.minFlowLps + type.maxFlowLps) / 2;
            const balanceScore = Math.abs(perDiffuser - preferred) / Math.max(1, preferred);
            const countScore = count * 0.05;
            const score = balanceScore + countScore;
            if (!best || score < best.score) best = { type, count, flow: perDiffuser, score };
        }
    }

    if (!best) {
        const maximumPossible = Math.max(...available.map((type) => type.maxFlowLps)) * maxDiffusers;
        const code = totalAirflowLps > maximumPossible ? "diffuser_flow_exceeds_catalog" : "no_valid_diffuser_type";
        return {
            system,
            diffuserCount: 0,
            airflowPerDiffuserLps: 0,
            totalAirflowLps,
            issues: [makeIssue(code, "error", "Airflow cannot be assigned to the available diffuser catalog within min/max limits.", {
                system,
                totalAirflowLps: round(totalAirflowLps),
                maxDiffusers,
                maximumCatalogCapacityLps: round(maximumPossible),
            })],
        };
    }

    if (best.type.noiseCriterion === undefined || best.type.throwM === undefined) {
        issues.push(makeIssue("diffuser_performance_placeholder", "warning", "Diffuser selection is missing noise or throw data; keep NC/throw as a reviewed placeholder.", {
            diffuserTypeId: best.type.id,
        }));
    }

    return {
        system,
        diffuserType: best.type,
        diffuserCount: best.count,
        airflowPerDiffuserLps: round(best.flow),
        totalAirflowLps: round(totalAirflowLps),
        issues,
    };
}

function candidateGrid(space: SpaceRecord, count: number, rules: DuctingRules): { points: Array<{ x: number; y: number; z: number }>; issues: EngineeringIssue[] } {
    const issues: EngineeringIssue[] = [];
    const clearance = Math.max(0, rules.minWallClearanceMm ?? 600);
    const minSpacing = Math.max(0, rules.minDiffuserSpacingMm ?? 1200);
    if (!space.aabbMm) {
        if (!space.centroidMm) {
            return { points: [], issues: [makeIssue("diffuser_candidate_geometry_missing", "error", "Space has no AABB or centroid for diffuser candidate layout.", { spaceId: space.id })] };
        }
        return {
            points: Array.from({ length: count }, () => ({ ...space.centroidMm! })),
            issues: [makeIssue("diffuser_candidate_layout_centroid_fallback", "warning", "Space has no AABB; all diffuser candidates use centroid fallback.", { spaceId: space.id })],
        };
    }

    const width = Math.max(0, space.aabbMm.maxX - space.aabbMm.minX - clearance * 2);
    const depth = Math.max(0, space.aabbMm.maxY - space.aabbMm.minY - clearance * 2);
    if (width <= 0 || depth <= 0) {
        issues.push(makeIssue("diffuser_candidate_room_too_small", "warning", "Wall clearance leaves no room for a diffuser grid; using room center fallback.", { spaceId: space.id }));
        const z = space.aabbMm.maxZ;
        return {
            points: Array.from({ length: count }, () => ({
                x: (space.aabbMm!.minX + space.aabbMm!.maxX) / 2,
                y: (space.aabbMm!.minY + space.aabbMm!.maxY) / 2,
                z,
            })),
            issues,
        };
    }

    const aspect = width / Math.max(depth, 1);
    const columns = Math.max(1, Math.ceil(Math.sqrt(count * aspect)));
    const rows = Math.max(1, Math.ceil(count / columns));
    const spacingX = columns > 1 ? width / (columns - 1) : width;
    const spacingY = rows > 1 ? depth / (rows - 1) : depth;
    if ((columns > 1 && spacingX < minSpacing) || (rows > 1 && spacingY < minSpacing)) {
        issues.push(makeIssue("diffuser_spacing_below_rule", "warning", "Diffuser grid spacing is below the project rule.", {
            spaceId: space.id,
            minDiffuserSpacingMm: minSpacing,
            spacingX: round(spacingX),
            spacingY: round(spacingY),
        }));
    }

    const points = [];
    for (let row = 0; row < rows && points.length < count; row++) {
        for (let column = 0; column < columns && points.length < count; column++) {
            const x = columns === 1 ? (space.aabbMm.minX + space.aabbMm.maxX) / 2 : space.aabbMm.minX + clearance + spacingX * column;
            const y = rows === 1 ? (space.aabbMm.minY + space.aabbMm.maxY) / 2 : space.aabbMm.minY + clearance + spacingY * row;
            points.push({ x, y, z: space.aabbMm.maxZ });
        }
    }
    return { points, issues };
}

function plenumId(plenum: Record<string, unknown>): string | undefined {
    return stringByFields(plenum, ["id", "plenumId", "plenum_id"]);
}

function plenumAabb(plenum: Record<string, unknown>): AabbMm | undefined {
    return aabbFromValue(plenum.aabbMm ?? plenum.aabb_mm ?? plenum.bboxMm ?? plenum.bbox_mm);
}

function findPlenum(space: SpaceRecord, plenums: Record<string, unknown>[]): Record<string, unknown> | undefined {
    return plenums.find((plenum) => {
        const sourceSpace = stringByFields(plenum, ["sourceSpatialId", "source_spatial_id", "sourceRoomId", "source_room_id", "spaceId", "space_id", "roomId", "room_id"]);
        if (sourceSpace && sourceSpace === space.id) return true;
        const aabb = plenumAabb(plenum);
        const centroid = space.centroidMm;
        if (aabb && centroid) {
            return centroid.x >= aabb.minX && centroid.x <= aabb.maxX && centroid.y >= aabb.minY && centroid.y <= aabb.maxY;
        }
        return false;
    });
}

function isBlockingIntersection(intersection: Record<string, unknown>): boolean {
    const explicit = String(intersection.blocked ?? intersection.status ?? intersection.severity ?? "").toLowerCase();
    if (["blocked", "fail", "error"].includes(explicit)) return true;
    const overlapVolume = numberByFields(intersection, ["overlapVolumeM3", "overlap_volume_m3"]);
    const overlapArea = numberByFields(intersection, ["overlapAreaM2", "overlap_area_m2"]);
    return (overlapVolume !== undefined && overlapVolume > 0) || (overlapArea !== undefined && overlapArea > 0);
}

function validatePlenum(
    space: SpaceRecord,
    candidates: DiffuserCandidate[],
    plenums: Record<string, unknown>[],
    intersections: Record<string, unknown>[],
    rules: DuctingRules,
): ValidationResult {
    const issues: EngineeringIssue[] = [];
    if (candidates.length === 0) {
        return { status: "not_run", issues, summary: { candidateCount: 0 } };
    }

    const plenum = findPlenum(space, plenums);
    if (!plenum) {
        issues.push(makeIssue("plenum_missing", "error", "No plenum volume matched diffuser candidates for this space.", { spaceId: space.id }));
        return { status: validationStatus(issues), issues, summary: { candidateCount: candidates.length } };
    }

    const id = plenumId(plenum);
    const aabb = plenumAabb(plenum);
    const minHeight = Math.max(0, rules.minPlenumHeightMm ?? 300);
    const heightMm = numberByFields(plenum, ["heightMm", "height_mm", "plenumHeightMm", "plenum_height_mm"])
        ?? (aabb ? aabb.maxZ - aabb.minZ : undefined);
    if (heightMm !== undefined && heightMm < minHeight) {
        issues.push(makeIssue("plenum_height_below_rule", "error", "Matched plenum height is below the project rule.", {
            spaceId: space.id,
            plenumId: id,
            heightMm: round(heightMm),
            minPlenumHeightMm: minHeight,
        }));
    }

    const blockingIntersections = intersections.filter((intersection) => {
        const intersectionPlenumId = stringByFields(intersection, ["plenumId", "plenum_id"]);
        return (!id || !intersectionPlenumId || intersectionPlenumId === id) && isBlockingIntersection(intersection);
    });
    if (blockingIntersections.length > 0) {
        issues.push(makeIssue(rules.blockOnPlenumObstacle === false ? "plenum_obstacle_warning" : "plenum_blocked", rules.blockOnPlenumObstacle === false ? "warning" : "error", "Plenum obstacle intersections affect diffuser placement.", {
            spaceId: space.id,
            plenumId: id,
            intersectionCount: blockingIntersections.length,
        }));
    }

    return {
        status: validationStatus(issues),
        issues,
        summary: {
            candidateCount: candidates.length,
            plenumId: id,
            heightMm: heightMm === undefined ? undefined : round(heightMm),
            blockingIntersectionCount: blockingIntersections.length,
        },
    };
}

export function buildDiffuserPlans(
    assignments: AirflowAssignment[],
    catalogInput: Record<string, unknown>[] = [],
    rules: DuctingRules = {},
    plenumVolumes: Record<string, unknown>[] = [],
    plenumObstacleIntersections: Record<string, unknown>[] = [],
): { catalog: DiffuserType[]; plans: SpaceDiffuserPlan[]; issues: EngineeringIssue[] } {
    const catalog = normalizeDiffuserCatalog(catalogInput);
    const issues: EngineeringIssue[] = [];
    if (catalog.length === 0) {
        issues.push(makeIssue("diffuser_catalog_empty", "error", "Diffuser catalog is empty or invalid."));
    }

    const plans = assignments.map((assignment) => {
        const selections: DiffuserSelection[] = [];
        const candidates: DiffuserCandidate[] = [];
        const planIssues: EngineeringIssue[] = [];
        for (const system of ["supply", "return", "exhaust"] as AirSystemKind[]) {
            const total = flowForSystem(assignment, system);
            if (total <= 0) continue;
            const selection = selectDiffuserType(system, total, catalog, rules);
            selections.push(selection);
            planIssues.push(...selection.issues);
            if (selection.diffuserType && selection.diffuserCount > 0) {
                const grid = candidateGrid(assignment.space, selection.diffuserCount, rules);
                planIssues.push(...grid.issues);
                grid.points.forEach((point, index) => {
                    candidates.push({
                        id: `${assignment.space.id}-${system}-${index + 1}`,
                        spaceId: assignment.space.id,
                        system,
                        pointMm: { x: round(point.x), y: round(point.y), z: round(point.z) },
                        airflowLps: selection.airflowPerDiffuserLps,
                        diffuserTypeId: selection.diffuserType?.id,
                    });
                });
            }
        }
        const plenumValidation = validatePlenum(assignment.space, candidates, plenumVolumes, plenumObstacleIntersections, rules);
        planIssues.push(...plenumValidation.issues);
        return {
            space: assignment.space,
            selections,
            candidates,
            plenumValidation,
            issues: planIssues,
        };
    });

    return { catalog, plans, issues };
}
