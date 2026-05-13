export type HydronicCalculationMethod = "darcy_weisbach" | "hazen_williams";

export interface HydronicAnalysisOptions {
    calculationMethod?: HydronicCalculationMethod;
    defaultFluidDensityKgM3?: number;
    defaultDynamicViscosityPaS?: number;
    defaultRoughnessMm?: number;
    defaultHazenWilliamsC?: number;
    designPressureReservePa?: number;
    pumpHeadSafetyFactor?: number;
    maxPaths?: number;
    startNodeIds?: string[];
    endNodeIds?: string[];
    roleOverrides?: Record<string, string>;
}

interface NormalizedNode {
    id: string;
    raw: any;
    label: string;
    category: string;
    familyName: string;
    typeName: string;
    systemName: string;
    systemType: string;
    systemClassification: string;
    role: string;
    lengthM: number | null;
    diameterM: number | null;
    flowLps: number | null;
    equivalentLengthM: number | null;
    kValue: number | null;
    roughnessMm: number | null;
    hazenWilliamsC: number | null;
    material: string;
}

interface NormalizedEdge {
    id: string;
    raw: any;
    source: string;
    target: string;
    label: string;
    directionAmbiguous: boolean;
    lengthM: number | null;
    diameterM: number | null;
    flowLps: number | null;
    equivalentLengthM: number | null;
    kValue: number | null;
    roughnessMm: number | null;
    hazenWilliamsC: number | null;
}

interface SegmentCalculation {
    id: string;
    kind: "node" | "edge";
    role?: string;
    label: string;
    source?: string;
    target?: string;
    flow_lps: number | null;
    diameter_mm: number | null;
    length_m: number | null;
    equivalent_length_m: number;
    k_value: number;
    velocity_mps: number | null;
    reynolds_number?: number | null;
    friction_factor?: number | null;
    pressure_drop_pa: number | null;
    pressure_drop_pa_per_m: number | null;
    method: HydronicCalculationMethod;
    data_status: "computed" | "not_applicable" | "missing_data";
    missing: string[];
    assumptions: string[];
}

interface PathRecord {
    kind: "closed_loop" | "terminal_path";
    startNodeId: string;
    terminalNodeId: string | null;
    nodeIds: string[];
    edgeIds: string[];
    pressureDropPa: number;
    missingSegmentIds: string[];
}

const GRAVITY_MPS2 = 9.80665;

const DEFAULT_OPTIONS: Required<Omit<HydronicAnalysisOptions, "startNodeIds" | "endNodeIds" | "roleOverrides">> = {
    calculationMethod: "darcy_weisbach",
    defaultFluidDensityKgM3: 998.2,
    defaultDynamicViscosityPaS: 0.001002,
    defaultRoughnessMm: 0.0015,
    defaultHazenWilliamsC: 140,
    designPressureReservePa: 0,
    pumpHeadSafetyFactor: 1,
    maxPaths: 5000,
};

export function calculateVelocityMps(flowLps: number, diameterM: number): number {
    if (!Number.isFinite(flowLps) || !Number.isFinite(diameterM) || flowLps <= 0 || diameterM <= 0) {
        return NaN;
    }
    const flowM3s = flowLps / 1000;
    const areaM2 = Math.PI * Math.pow(diameterM, 2) / 4;
    return flowM3s / areaM2;
}

export function calculateReynoldsNumber(flowLps: number, diameterM: number, densityKgM3: number, dynamicViscosityPaS: number): number {
    const velocityMps = calculateVelocityMps(flowLps, diameterM);
    if (!Number.isFinite(velocityMps) || densityKgM3 <= 0 || dynamicViscosityPaS <= 0) {
        return NaN;
    }
    return densityKgM3 * velocityMps * diameterM / dynamicViscosityPaS;
}

export function calculateDarcyFrictionFactor(reynoldsNumber: number, diameterM: number, roughnessMm: number): number {
    if (!Number.isFinite(reynoldsNumber) || reynoldsNumber <= 0 || !Number.isFinite(diameterM) || diameterM <= 0) {
        return NaN;
    }
    if (reynoldsNumber < 2300) {
        return 64 / reynoldsNumber;
    }
    const roughnessM = Math.max(0, roughnessMm || 0) / 1000;
    const relativeRoughness = roughnessM / diameterM;
    const denominator = Math.pow(
        Math.log10(relativeRoughness / 3.7 + 5.74 / Math.pow(reynoldsNumber, 0.9)),
        2,
    );
    return 0.25 / denominator;
}

export function equivalentLengthFromK(kValue: number, diameterM: number, frictionFactor: number): number {
    if (!Number.isFinite(kValue) || !Number.isFinite(diameterM) || !Number.isFinite(frictionFactor) || kValue <= 0 || diameterM <= 0 || frictionFactor <= 0) {
        return NaN;
    }
    return kValue * diameterM / frictionFactor;
}

export function calculateDarcyWeisbachPressureDropPa(args: {
    flowLps: number;
    diameterM: number;
    lengthM: number;
    equivalentLengthM?: number;
    kValue?: number;
    roughnessMm?: number;
    densityKgM3?: number;
    dynamicViscosityPaS?: number;
}): {
    pressureDropPa: number;
    pressureDropPaPerM: number;
    velocityMps: number;
    reynoldsNumber: number;
    frictionFactor: number;
} {
    const densityKgM3 = args.densityKgM3 || DEFAULT_OPTIONS.defaultFluidDensityKgM3;
    const dynamicViscosityPaS = args.dynamicViscosityPaS || DEFAULT_OPTIONS.defaultDynamicViscosityPaS;
    const roughnessMm = args.roughnessMm ?? DEFAULT_OPTIONS.defaultRoughnessMm;
    const lengthM = Math.max(0, args.lengthM || 0);
    const equivalentLengthM = Math.max(0, args.equivalentLengthM || 0);
    const kValue = Math.max(0, args.kValue || 0);
    const velocityMps = calculateVelocityMps(args.flowLps, args.diameterM);
    const reynoldsNumber = calculateReynoldsNumber(args.flowLps, args.diameterM, densityKgM3, dynamicViscosityPaS);
    const frictionFactor = calculateDarcyFrictionFactor(reynoldsNumber, args.diameterM, roughnessMm);
    const dynamicPressurePa = densityKgM3 * Math.pow(velocityMps, 2) / 2;
    const pressureDropPaPerM = frictionFactor * dynamicPressurePa / args.diameterM;
    const frictionDropPa = pressureDropPaPerM * (lengthM + equivalentLengthM);
    const localDropPa = kValue * dynamicPressurePa;
    return {
        pressureDropPa: frictionDropPa + localDropPa,
        pressureDropPaPerM,
        velocityMps,
        reynoldsNumber,
        frictionFactor,
    };
}

export function calculateHazenWilliamsPressureDropPa(args: {
    flowLps: number;
    diameterM: number;
    lengthM: number;
    equivalentLengthM?: number;
    kValue?: number;
    hazenWilliamsC?: number;
    densityKgM3?: number;
}): {
    pressureDropPa: number;
    pressureDropPaPerM: number;
    velocityMps: number;
} {
    const densityKgM3 = args.densityKgM3 || DEFAULT_OPTIONS.defaultFluidDensityKgM3;
    const c = args.hazenWilliamsC || DEFAULT_OPTIONS.defaultHazenWilliamsC;
    const lengthM = Math.max(0, args.lengthM || 0);
    const equivalentLengthM = Math.max(0, args.equivalentLengthM || 0);
    const kValue = Math.max(0, args.kValue || 0);
    const flowM3s = args.flowLps / 1000;
    const velocityMps = calculateVelocityMps(args.flowLps, args.diameterM);
    const headLossMPerM = 10.67 * Math.pow(flowM3s, 1.852) / (Math.pow(c, 1.852) * Math.pow(args.diameterM, 4.871));
    const pressureDropPaPerM = densityKgM3 * GRAVITY_MPS2 * headLossMPerM;
    const dynamicPressurePa = densityKgM3 * Math.pow(velocityMps, 2) / 2;
    return {
        pressureDropPa: pressureDropPaPerM * (lengthM + equivalentLengthM) + kValue * dynamicPressurePa,
        pressureDropPaPerM,
        velocityMps,
    };
}

export function analyzeHydronicPipingGraph(rawGraph: any, options: HydronicAnalysisOptions = {}) {
    const resolvedOptions = { ...DEFAULT_OPTIONS, ...options };
    const auditMissing: any[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const graph = normalizeGraph(rawGraph, options.roleOverrides || {});

    if (graph.nodes.length === 0) {
        errors.push("Connector graph contains no nodes/elements.");
    }
    if (graph.edges.length === 0) {
        warnings.push("Connector graph contains no edges/connections.");
    }

    const adjacency = new Map<string, NormalizedEdge[]>();
    const reverseAdjacency = new Map<string, NormalizedEdge[]>();
    for (const node of graph.nodes) {
        adjacency.set(node.id, []);
        reverseAdjacency.set(node.id, []);
    }
    for (const edge of graph.edges) {
        if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) {
            auditMissing.push({
                item_id: edge.id,
                item_kind: "edge",
                field: "source_or_target",
                severity: "error",
                message: "Edge references a node id that is not present in the connector graph.",
            });
            continue;
        }
        adjacency.get(edge.source)!.push(edge);
        reverseAdjacency.get(edge.target)!.push(edge);
    }

    const components = findComponents(graph.nodes, graph.edges);
    const cycles = findDirectedCycles(graph.nodes, adjacency, resolvedOptions.maxPaths);
    const directionAmbiguousEdges = graph.edges.filter((edge) => edge.directionAmbiguous).map((edge) => edge.id);

    const pumps = graph.nodes.filter((node) => node.role === "pump");
    const coils = graph.nodes.filter((node) => node.role === "coil");
    const valves = graph.nodes.filter((node) => node.role === "valve" || node.role === "control_valve" || node.role === "balancing_valve");
    const accessories = graph.nodes.filter((node) => node.role === "accessory" || node.role === "fitting");

    const downstreamDemandCache = new Map<string, number>();
    const upstreamDemandCache = new Map<string, number>();
    const flowInferenceWarnings = new Set<string>();
    const downstreamDemand = (nodeId: string, visiting = new Set<string>()): number => {
        if (downstreamDemandCache.has(nodeId)) {
            return downstreamDemandCache.get(nodeId)!;
        }
        if (visiting.has(nodeId)) {
            flowInferenceWarnings.add(nodeId);
            return 0;
        }
        visiting.add(nodeId);
        const node = graph.nodeById.get(nodeId);
        let demand = isTerminalDemandNode(node, adjacency) && positive(node?.flowLps) ? node!.flowLps! : 0;
        for (const edge of adjacency.get(nodeId) || []) {
            demand += downstreamDemand(edge.target, visiting);
        }
        visiting.delete(nodeId);
        downstreamDemandCache.set(nodeId, demand);
        return demand;
    };

    const upstreamDemand = (nodeId: string, visiting = new Set<string>()): number => {
        if (upstreamDemandCache.has(nodeId)) {
            return upstreamDemandCache.get(nodeId)!;
        }
        if (visiting.has(nodeId)) {
            flowInferenceWarnings.add(nodeId);
            return 0;
        }
        visiting.add(nodeId);
        const node = graph.nodeById.get(nodeId);
        let demand = isTerminalDemandNode(node, adjacency) && positive(node?.flowLps) ? node!.flowLps! : 0;
        for (const edge of reverseAdjacency.get(nodeId) || []) {
            demand += upstreamDemand(edge.source, visiting);
        }
        visiting.delete(nodeId);
        upstreamDemandCache.set(nodeId, demand);
        return demand;
    };

    for (const node of graph.nodes) {
        downstreamDemand(node.id);
        upstreamDemand(node.id);
    }
    for (const nodeId of flowInferenceWarnings) {
        warnings.push(`Flow inference encountered a directed cycle at node ${nodeId}; explicit flow is required for reliable branch quantities.`);
    }

    const segmentCalculations: SegmentCalculation[] = [];
    const segmentPressureById = new Map<string, number>();
    const missingSegmentIds = new Set<string>();

    for (const node of graph.nodes) {
        const flowLps = resolveNodeFlow(node, downstreamDemand, upstreamDemand, adjacency);
        const calculation = calculateSegment("node", node.id, node.label, node.role, node.lengthM, node.diameterM, flowLps, node.equivalentLengthM, node.kValue, node.roughnessMm, node.hazenWilliamsC, resolvedOptions);
        if (calculation.data_status !== "not_applicable") {
            segmentCalculations.push(calculation);
            if (calculation.pressure_drop_pa !== null) {
                segmentPressureById.set(`node:${node.id}`, calculation.pressure_drop_pa);
            }
            else {
                missingSegmentIds.add(`node:${node.id}`);
                for (const field of calculation.missing) {
                    auditMissing.push({
                        item_id: node.id,
                        item_kind: "node",
                        role: node.role,
                        field,
                        severity: "warning",
                        message: `Cannot compute pressure drop for ${node.label}; missing ${field}.`,
                    });
                }
            }
        }
    }

    for (const edge of graph.edges) {
        const downstreamFlow = downstreamDemand(edge.target);
        const upstreamFlow = upstreamDemand(edge.source);
        const flowLps = positive(edge.flowLps) ? edge.flowLps : positive(downstreamFlow) ? downstreamFlow : upstreamFlow;
        const calculation = calculateSegment("edge", edge.id, edge.label, undefined, edge.lengthM, edge.diameterM, flowLps, edge.equivalentLengthM, edge.kValue, edge.roughnessMm, edge.hazenWilliamsC, resolvedOptions, edge.source, edge.target);
        if (calculation.data_status !== "not_applicable") {
            segmentCalculations.push(calculation);
            if (calculation.pressure_drop_pa !== null) {
                segmentPressureById.set(`edge:${edge.id}`, calculation.pressure_drop_pa);
            }
            else {
                missingSegmentIds.add(`edge:${edge.id}`);
                for (const field of calculation.missing) {
                    auditMissing.push({
                        item_id: edge.id,
                        item_kind: "edge",
                        field,
                        severity: "warning",
                        message: `Cannot compute pressure drop for ${edge.label}; missing ${field}.`,
                    });
                }
            }
        }
    }

    const starts = resolveStartNodes(graph.nodes, pumps, reverseAdjacency, options.startNodeIds);
    const ends = resolveEndNodes(graph.nodes, adjacency, options.endNodeIds);
    const pathResult = enumerateHydronicPaths(starts, ends, graph.nodeById, adjacency, segmentPressureById, missingSegmentIds, resolvedOptions.maxPaths);
    if (pathResult.truncated) {
        warnings.push(`Critical path search stopped after ${resolvedOptions.maxPaths} candidate paths; narrow the graph or provide explicit start/end node ids.`);
    }
    const directionFindings = findPossibleReversedDirections(starts, ends, adjacency, reverseAdjacency);
    for (const finding of directionFindings) {
        warnings.push(`Possible reversed graph direction: start ${finding.startNodeId} cannot reach terminal ${finding.endNodeId}, but the terminal can reach the start.`);
    }

    const criticalPath = selectCriticalPath(pathResult.paths);
    if (!criticalPath && graph.nodes.length > 0) {
        warnings.push("No complete critical path found from pump/source to coil/terminal. Check graph direction, disconnected networks, and missing start/end role data.");
    }

    const terminalReports = summarizeTerminalPaths(pathResult.paths, criticalPath, graph.nodeById);
    const density = resolvedOptions.defaultFluidDensityKgM3;
    const pumpHeadPressurePa = criticalPath
        ? (criticalPath.pressureDropPa + resolvedOptions.designPressureReservePa) * resolvedOptions.pumpHeadSafetyFactor
        : null;
    const pumpHeadM = pumpHeadPressurePa !== null ? pumpHeadPressurePa / (density * GRAVITY_MPS2) : null;

    const assumptions = [
        "Input is treated as the shared connector graph contract from the foundation branch; this analyzer does not modify the graph schema.",
        `Dry-run analysis only; no Revit geometry, parameters, or overrides are written.`,
        `Calculations use SI units: length m, diameter mm/m, flow L/s, pressure Pa, head m.`,
        resolvedOptions.calculationMethod === "darcy_weisbach"
            ? `Darcy-Weisbach uses Swamee-Jain turbulent friction, 64/Re laminar friction, density ${density} kg/m3, dynamic viscosity ${resolvedOptions.defaultDynamicViscosityPaS} Pa.s, default roughness ${resolvedOptions.defaultRoughnessMm} mm.`
            : `Hazen-Williams uses SI head-loss form with default C=${resolvedOptions.defaultHazenWilliamsC}; use only for water-like hydronic service where project standards permit it.`,
        "K values are applied as local loss K*rho*v^2/2. Equivalent length is added to straight length before friction loss.",
        "When segment flow is missing, downstream terminal/coil demand is inferred using declared graph direction and flagged when cycles make inference unreliable.",
    ];

    return {
        schema_version: "hydronic-piping-analysis.v1",
        success: errors.length === 0,
        status: errors.length > 0 ? "fail" : auditMissing.length > 0 || warnings.length > 0 ? "needs_review" : "ok",
        dry_run: true,
        summary: {
            node_count: graph.nodes.length,
            edge_count: graph.edges.length,
            component_count: components.length,
            disconnected_network_count: Math.max(0, components.length - 1),
            directed_cycle_count: cycles.length,
            pump_count: pumps.length,
            coil_count: coils.length,
            valve_count: valves.length,
            balancing_valve_count: valves.filter((node) => node.role === "balancing_valve").length,
            accessory_count: accessories.length,
            calculation_method: resolvedOptions.calculationMethod,
            computed_segment_count: segmentCalculations.filter((segment) => segment.data_status === "computed").length,
            missing_data_item_count: auditMissing.length,
            critical_path_pressure_drop_pa: criticalPath ? round(criticalPath.pressureDropPa, 3) : null,
            pump_head_pressure_pa: pumpHeadPressurePa !== null ? round(pumpHeadPressurePa, 3) : null,
            pump_head_m: pumpHeadM !== null ? round(pumpHeadM, 4) : null,
        },
        assumptions,
        graph_audit: {
            components: components.map((component, index) => ({
                index: index + 1,
                node_count: component.length,
                node_ids: component,
            })),
            direction_ambiguous_edge_ids: directionAmbiguousEdges,
            directed_cycles: cycles,
            possible_reversed_directions: directionFindings,
            missing_data: auditMissing,
        },
        equipment: {
            pumps: pumps.map(equipmentSummary),
            coils: coils.map(equipmentSummary),
            valves: valves.map(equipmentSummary),
            accessories: accessories.map(equipmentSummary),
        },
        segments: segmentCalculations.map((segment) => ({
            ...segment,
            velocity_mps: nullableRound(segment.velocity_mps, 4),
            reynolds_number: nullableRound(segment.reynolds_number, 0),
            friction_factor: nullableRound(segment.friction_factor, 6),
            pressure_drop_pa: nullableRound(segment.pressure_drop_pa, 3),
            pressure_drop_pa_per_m: nullableRound(segment.pressure_drop_pa_per_m, 3),
            flow_lps: nullableRound(segment.flow_lps, 4),
            diameter_mm: nullableRound(segment.diameter_mm, 3),
            length_m: nullableRound(segment.length_m, 4),
            equivalent_length_m: round(segment.equivalent_length_m, 4),
            k_value: round(segment.k_value, 4),
        })),
        critical_path: criticalPath ? {
            kind: criticalPath.kind,
            start_node_id: criticalPath.startNodeId,
            terminal_node_id: criticalPath.terminalNodeId,
            pressure_drop_pa: round(criticalPath.pressureDropPa, 3),
            head_m: round(criticalPath.pressureDropPa / (density * GRAVITY_MPS2), 4),
            node_ids: criticalPath.nodeIds,
            edge_ids: criticalPath.edgeIds,
            missing_segment_ids: criticalPath.missingSegmentIds,
        } : null,
        pump_head_report: {
            pump_node_ids: pumps.map((node) => node.id),
            design_pressure_reserve_pa: resolvedOptions.designPressureReservePa,
            safety_factor: resolvedOptions.pumpHeadSafetyFactor,
            required_head_pa: pumpHeadPressurePa !== null ? round(pumpHeadPressurePa, 3) : null,
            required_head_m: pumpHeadM !== null ? round(pumpHeadM, 4) : null,
            note: pumpHeadPressurePa === null
                ? "Pump head is unavailable until a complete critical path can be resolved."
                : "Required head is the computed critical path pressure plus reserve, multiplied by safety factor.",
        },
        balancing_valve_report: terminalReports,
        foundation_branch_feedback: [
            "Confirm stable graph field names and units for length, diameter, flow, material roughness, K value, equivalent length, and direction confidence so downstream analyzers do not need field aliases.",
            "Expose optional element role hints from extraction when available, while allowing calculation branches to keep their own discipline-specific role heuristics.",
            "Preserve connector direction confidence and source of flow values in the graph report so hydronic audit can distinguish Revit-provided data from inferred data.",
        ],
        warnings,
        errors,
    };
}

function normalizeGraph(rawGraph: any, roleOverrides: Record<string, string>) {
    const source = rawGraph && typeof rawGraph === "object" ? rawGraph : {};
    const rawNodes = firstArray(source, ["nodes", "elements", "vertices", "graph.nodes", "connector_graph.nodes"]);
    const rawEdges = firstArray(source, ["edges", "connections", "links", "graph.edges", "connector_graph.edges"]);
    const nodes: NormalizedNode[] = rawNodes.map((raw: any, index: number) => normalizeNode(raw, index, roleOverrides));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const edges: NormalizedEdge[] = rawEdges.map((raw: any, index: number) => normalizeEdge(raw, index)).filter((edge: NormalizedEdge | null) => edge !== null);
    return { nodes, edges, nodeById };
}

function normalizeNode(raw: any, index: number, roleOverrides: Record<string, string>): NormalizedNode {
    const id = stableId(firstDefinedPath(raw, ["id", "node_id", "nodeId", "element_id", "elementId", "owner_element_id", "ownerElementId", "element.id"]), `node_${index + 1}`);
    const category = stringValue(firstDefinedPath(raw, ["category", "category_name", "categoryName", "revit_category", "revitCategory", "element.category"]));
    const familyName = stringValue(firstDefinedPath(raw, ["family", "family_name", "familyName", "family_name_text", "element.family"]));
    const typeName = stringValue(firstDefinedPath(raw, ["type", "type_name", "typeName", "element.type"]));
    const name = stringValue(firstDefinedPath(raw, ["name", "element.name", "label"]));
    const label = name || typeName || familyName || category || id;
    const systemName = stringValue(firstDefinedPath(raw, ["system_name", "systemName", "system.name", "engineering.system_name"]));
    const systemType = stringValue(firstDefinedPath(raw, ["system_type", "systemType", "system.type", "engineering.system_type"]));
    const systemClassification = stringValue(firstDefinedPath(raw, ["system_classification", "systemClassification", "system.classification", "engineering.system_classification"]));
    const overrideRole = roleOverrides[id] || roleOverrides[String(firstDefinedPath(raw, ["element_id", "elementId"]))];
    return {
        id,
        raw,
        label,
        category,
        familyName,
        typeName,
        systemName,
        systemType,
        systemClassification,
        role: overrideRole || classifyRole({ category, familyName, typeName, name, systemName, systemType, systemClassification }),
        lengthM: readLengthM(raw),
        diameterM: readDiameterM(raw),
        flowLps: readFlowLps(raw),
        equivalentLengthM: readEquivalentLengthM(raw),
        kValue: readNumberPath(raw, ["k_value", "kValue", "minor_loss_k", "minorLossK", "loss_coefficient", "lossCoefficient"]),
        roughnessMm: readNumberPath(raw, ["roughness_mm", "roughnessMm", "material.roughness_mm", "engineering.roughness_mm"]),
        hazenWilliamsC: readNumberPath(raw, ["hazen_williams_c", "hazenWilliamsC", "material.hazen_williams_c", "engineering.hazen_williams_c"]),
        material: stringValue(firstDefinedPath(raw, ["material", "material_name", "materialName", "engineering.material"])),
    };
}

function normalizeEdge(raw: any, index: number): NormalizedEdge | null {
    const endpoints = endpointIds(raw);
    if (!endpoints) {
        return null;
    }
    const id = stableId(firstDefinedPath(raw, ["id", "edge_id", "edgeId", "connection_id", "connectionId"]), `edge_${index + 1}`);
    return {
        id,
        raw,
        source: endpoints.source,
        target: endpoints.target,
        label: stringValue(firstDefinedPath(raw, ["name", "label", "type"])) || id,
        directionAmbiguous: endpoints.directionAmbiguous || Boolean(firstDefinedPath(raw, ["direction_ambiguous", "directionAmbiguous"])) || /ambiguous|bidirectional|unknown/i.test(stringValue(firstDefinedPath(raw, ["direction", "flow_direction", "flowDirection"]))),
        lengthM: readLengthM(raw),
        diameterM: readDiameterM(raw),
        flowLps: readFlowLps(raw),
        equivalentLengthM: readEquivalentLengthM(raw),
        kValue: readNumberPath(raw, ["k_value", "kValue", "minor_loss_k", "minorLossK", "loss_coefficient", "lossCoefficient"]),
        roughnessMm: readNumberPath(raw, ["roughness_mm", "roughnessMm", "material.roughness_mm", "engineering.roughness_mm"]),
        hazenWilliamsC: readNumberPath(raw, ["hazen_williams_c", "hazenWilliamsC", "material.hazen_williams_c", "engineering.hazen_williams_c"]),
    };
}

function endpointIds(raw: any): { source: string; target: string; directionAmbiguous: boolean } | null {
    const source = firstDefinedPath(raw, ["source", "source_id", "sourceId", "source_node_id", "sourceNodeId", "from", "from_id", "fromId", "fromNodeId", "start", "startNodeId", "u"]);
    const target = firstDefinedPath(raw, ["target", "target_id", "targetId", "target_node_id", "targetNodeId", "to", "to_id", "toId", "toNodeId", "end", "endNodeId", "v"]);
    if (source !== undefined && target !== undefined) {
        return { source: stableId(source, ""), target: stableId(target, ""), directionAmbiguous: false };
    }
    const nodes = firstArray(raw, ["nodes", "node_ids", "nodeIds", "endpoints"]);
    if (nodes.length >= 2) {
        return { source: stableId(nodes[0], ""), target: stableId(nodes[1], ""), directionAmbiguous: true };
    }
    return null;
}

function classifyRole(parts: Record<string, string>): string {
    const text = `${parts.category} ${parts.familyName} ${parts.typeName} ${parts.name} ${parts.systemName} ${parts.systemType} ${parts.systemClassification}`.toLowerCase();
    if (/pump|circulator|pompa|sirkulasyon/.test(text)) return "pump";
    if (/fan coil|\bfcu\b|coil|serpantin|batarya|heat exchanger|esanj/.test(text)) return "coil";
    if (/balanc|balans|commissioning valve|circuit setter/.test(text)) return "balancing_valve";
    if (/control valve|2-way|3-way|two way|three way|motorized|actuat/.test(text)) return "control_valve";
    if (/valve|vana|check valve|shut.?off|ball valve|gate valve|butterfly/.test(text)) return "valve";
    if (/pipe fitting|fitting|elbow|tee|reducer|dirsek|te\b|transition/.test(text)) return "fitting";
    if (/pipe accessory|accessory|strainer|filter|separator|meter|sensor|flex|compensator|expansion/.test(text)) return "accessory";
    if (/\bpipe curves\b|\bpipe segment\b|\bpiping segment\b|\bboru\b/.test(text) || text.includes("ost_pipecurves")) return "pipe_segment";
    if (/mechanical equipment|terminal|unit heater|radiator|radiant|convect/.test(text)) return "terminal";
    return "unknown";
}

function calculateSegment(
    kind: "node" | "edge",
    id: string,
    label: string,
    role: string | undefined,
    lengthM: number | null,
    diameterM: number | null,
    flowLps: number | null,
    equivalentLengthM: number | null,
    kValue: number | null,
    roughnessMm: number | null,
    hazenWilliamsC: number | null,
    options: Required<Omit<HydronicAnalysisOptions, "startNodeIds" | "endNodeIds" | "roleOverrides">>,
    source?: string,
    target?: string,
): SegmentCalculation {
    const applies = role === "pipe_segment"
        || role === "fitting"
        || role === "valve"
        || role === "control_valve"
        || role === "balancing_valve"
        || role === "accessory"
        || role === "coil"
        || positive(lengthM)
        || positive(kValue)
        || positive(equivalentLengthM)
        || (kind === "edge" && (positive(lengthM) || positive(kValue) || positive(equivalentLengthM)));

    const base = {
        id,
        kind,
        role,
        label,
        source,
        target,
        flow_lps: positive(flowLps) ? flowLps : null,
        diameter_mm: positive(diameterM) ? diameterM! * 1000 : null,
        length_m: positive(lengthM) ? lengthM : null,
        equivalent_length_m: positive(equivalentLengthM) ? equivalentLengthM! : 0,
        k_value: positive(kValue) ? kValue! : 0,
        velocity_mps: null,
        pressure_drop_pa: null,
        pressure_drop_pa_per_m: null,
        method: options.calculationMethod,
        assumptions: [] as string[],
    };

    if (!applies || role === "pump") {
        return {
            ...base,
            data_status: "not_applicable",
            missing: [],
        };
    }

    const missing: string[] = [];
    if (!positive(flowLps)) missing.push("flow_lps");
    if (!positive(diameterM)) missing.push("diameter");
    if (!positive(lengthM) && !positive(kValue) && !positive(equivalentLengthM)) missing.push("length_or_local_loss");
    if (missing.length > 0) {
        return {
            ...base,
            data_status: "missing_data",
            missing,
        };
    }

    if (positive(kValue) && positive(equivalentLengthM)) {
        base.assumptions.push("Both K value and equivalent length are present and treated as additive explicit losses.");
    }
    if (!positive(lengthM) && (positive(kValue) || positive(equivalentLengthM))) {
        base.assumptions.push("Straight length is missing; only local/equivalent-length loss is included.");
    }

    if (options.calculationMethod === "hazen_williams") {
        const calc = calculateHazenWilliamsPressureDropPa({
            flowLps: flowLps!,
            diameterM: diameterM!,
            lengthM: lengthM || 0,
            equivalentLengthM: equivalentLengthM || 0,
            kValue: kValue || 0,
            hazenWilliamsC: hazenWilliamsC || options.defaultHazenWilliamsC,
            densityKgM3: options.defaultFluidDensityKgM3,
        });
        return {
            ...base,
            velocity_mps: calc.velocityMps,
            pressure_drop_pa: calc.pressureDropPa,
            pressure_drop_pa_per_m: calc.pressureDropPaPerM,
            data_status: "computed",
            missing: [],
        };
    }

    const calc = calculateDarcyWeisbachPressureDropPa({
        flowLps: flowLps!,
        diameterM: diameterM!,
        lengthM: lengthM || 0,
        equivalentLengthM: equivalentLengthM || 0,
        kValue: kValue || 0,
        roughnessMm: roughnessMm || options.defaultRoughnessMm,
        densityKgM3: options.defaultFluidDensityKgM3,
        dynamicViscosityPaS: options.defaultDynamicViscosityPaS,
    });
    return {
        ...base,
        velocity_mps: calc.velocityMps,
        reynolds_number: calc.reynoldsNumber,
        friction_factor: calc.frictionFactor,
        pressure_drop_pa: calc.pressureDropPa,
        pressure_drop_pa_per_m: calc.pressureDropPaPerM,
        data_status: "computed",
        missing: [],
    };
}

function resolveNodeFlow(
    node: NormalizedNode,
    downstreamDemand: (nodeId: string) => number,
    upstreamDemand: (nodeId: string) => number,
    adjacency: Map<string, NormalizedEdge[]>,
): number | null {
    if (positive(node.flowLps)) {
        return node.flowLps;
    }
    if (node.role === "pipe_segment" || node.role === "fitting" || node.role === "valve" || node.role === "control_valve" || node.role === "balancing_valve" || node.role === "accessory" || node.role === "pump") {
        const inferred = downstreamDemand(node.id);
        if (positive(inferred)) {
            return inferred;
        }
        const reverseInferred = upstreamDemand(node.id);
        return positive(reverseInferred) ? reverseInferred : null;
    }
    if (isTerminalDemandNode(node, adjacency)) {
        return positive(node.flowLps) ? node.flowLps : null;
    }
    return null;
}

function isTerminalDemandNode(node: NormalizedNode | undefined, adjacency: Map<string, NormalizedEdge[]>): boolean {
    if (!node) return false;
    if (node.role === "coil" || node.role === "terminal") return true;
    const outgoing = adjacency.get(node.id) || [];
    return outgoing.length === 0 && node.role !== "pump" && node.role !== "pipe_segment" && node.role !== "fitting";
}

function resolveStartNodes(nodes: NormalizedNode[], pumps: NormalizedNode[], reverseAdjacency: Map<string, NormalizedEdge[]>, startNodeIds?: string[]) {
    const explicit = (startNodeIds || []).map((id) => String(id));
    if (explicit.length > 0) return explicit;
    if (pumps.length > 0) return pumps.map((node) => node.id);
    const sources = nodes.filter((node) => (reverseAdjacency.get(node.id) || []).length === 0).map((node) => node.id);
    return sources.length > 0 ? sources : nodes.slice(0, 1).map((node) => node.id);
}

function resolveEndNodes(nodes: NormalizedNode[], adjacency: Map<string, NormalizedEdge[]>, endNodeIds?: string[]) {
    const explicit = (endNodeIds || []).map((id) => String(id));
    if (explicit.length > 0) return explicit;
    const terminals = nodes.filter((node) => node.role === "coil" || node.role === "terminal");
    if (terminals.length > 0) return terminals.map((node) => node.id);
    return nodes.filter((node) => (adjacency.get(node.id) || []).length === 0).map((node) => node.id);
}

function enumerateHydronicPaths(
    starts: string[],
    ends: string[],
    nodeById: Map<string, NormalizedNode>,
    adjacency: Map<string, NormalizedEdge[]>,
    segmentPressureById: Map<string, number>,
    missingSegmentIds: Set<string>,
    maxPaths: number,
): { paths: PathRecord[]; truncated: boolean } {
    const endSet = new Set(ends);
    const paths: PathRecord[] = [];
    let truncated = false;

    const pathCost = (nodeIds: string[], edgeIds: string[]) => {
        let pressureDropPa = 0;
        const missing: string[] = [];
        const seenNodes = new Set<string>();
        for (const nodeId of nodeIds) {
            if (seenNodes.has(nodeId)) continue;
            seenNodes.add(nodeId);
            const key = `node:${nodeId}`;
            pressureDropPa += segmentPressureById.get(key) || 0;
            if (missingSegmentIds.has(key)) missing.push(key);
        }
        for (const edgeId of edgeIds) {
            const key = `edge:${edgeId}`;
            pressureDropPa += segmentPressureById.get(key) || 0;
            if (missingSegmentIds.has(key)) missing.push(key);
        }
        return { pressureDropPa, missing };
    };

    for (const start of starts) {
        const visit = (current: string, nodePath: string[], edgePath: string[], visited: Set<string>) => {
            if (paths.length >= maxPaths) {
                truncated = true;
                return;
            }
            if (endSet.has(current) && current !== start) {
                const cost = pathCost(nodePath, edgePath);
                paths.push({
                    kind: "terminal_path",
                    startNodeId: start,
                    terminalNodeId: current,
                    nodeIds: [...nodePath],
                    edgeIds: [...edgePath],
                    pressureDropPa: cost.pressureDropPa,
                    missingSegmentIds: cost.missing,
                });
            }
            for (const edge of adjacency.get(current) || []) {
                if (edge.target === start && nodePath.length > 1) {
                    const closedNodePath = [...nodePath, start];
                    if (closedNodePath.some((id) => {
                        const node = nodeById.get(id);
                        return node?.role === "coil" || node?.role === "terminal";
                    })) {
                        const closedEdgePath = [...edgePath, edge.id];
                        const cost = pathCost(closedNodePath, closedEdgePath);
                        const terminal = closedNodePath.find((id) => {
                            const node = nodeById.get(id);
                            return node?.role === "coil" || node?.role === "terminal";
                        }) || null;
                        paths.push({
                            kind: "closed_loop",
                            startNodeId: start,
                            terminalNodeId: terminal,
                            nodeIds: closedNodePath,
                            edgeIds: closedEdgePath,
                            pressureDropPa: cost.pressureDropPa,
                            missingSegmentIds: cost.missing,
                        });
                    }
                    continue;
                }
                if (visited.has(edge.target)) {
                    continue;
                }
                const nextVisited = new Set(visited);
                nextVisited.add(edge.target);
                visit(edge.target, [...nodePath, edge.target], [...edgePath, edge.id], nextVisited);
                if (truncated) return;
            }
        };
        visit(start, [start], [], new Set([start]));
    }
    return { paths, truncated };
}

function selectCriticalPath(paths: PathRecord[]): PathRecord | null {
    if (paths.length === 0) return null;
    const closedLoops = paths.filter((path) => path.kind === "closed_loop");
    const candidates = closedLoops.length > 0 ? closedLoops : paths;
    return [...candidates].sort((a, b) => b.pressureDropPa - a.pressureDropPa)[0] || null;
}

function summarizeTerminalPaths(paths: PathRecord[], criticalPath: PathRecord | null, nodeById: Map<string, NormalizedNode>) {
    if (!criticalPath) return [];
    const byTerminal = new Map<string, PathRecord>();
    for (const path of paths) {
        if (!path.terminalNodeId) continue;
        const existing = byTerminal.get(path.terminalNodeId);
        if (!existing || path.pressureDropPa > existing.pressureDropPa || (path.kind === "closed_loop" && existing.kind !== "closed_loop")) {
            byTerminal.set(path.terminalNodeId, path);
        }
    }
    return [...byTerminal.values()].map((path) => {
        const balancingValveNodeIds = path.nodeIds.filter((id) => nodeById.get(id)?.role === "balancing_valve");
        const delta = Math.max(0, criticalPath.pressureDropPa - path.pressureDropPa);
        return {
            terminal_node_id: path.terminalNodeId,
            terminal_label: path.terminalNodeId ? nodeById.get(path.terminalNodeId)?.label || path.terminalNodeId : null,
            path_kind: path.kind,
            path_pressure_drop_pa: round(path.pressureDropPa, 3),
            required_balancing_delta_pa: round(delta, 3),
            balancing_valve_node_ids: balancingValveNodeIds,
            status: delta === 0
                ? "critical_path"
                : balancingValveNodeIds.length > 0 ? "balance_at_listed_valve" : "balancing_valve_missing_or_not_identified",
            node_ids: path.nodeIds,
            edge_ids: path.edgeIds,
        };
    }).sort((a, b) => b.path_pressure_drop_pa - a.path_pressure_drop_pa);
}

function findComponents(nodes: NormalizedNode[], edges: NormalizedEdge[]): string[][] {
    const undirected = new Map<string, string[]>();
    for (const node of nodes) undirected.set(node.id, []);
    for (const edge of edges) {
        if (!undirected.has(edge.source) || !undirected.has(edge.target)) continue;
        undirected.get(edge.source)!.push(edge.target);
        undirected.get(edge.target)!.push(edge.source);
    }
    const visited = new Set<string>();
    const components: string[][] = [];
    for (const node of nodes) {
        if (visited.has(node.id)) continue;
        const queue = [node.id];
        visited.add(node.id);
        const component: string[] = [];
        while (queue.length > 0) {
            const current = queue.shift()!;
            component.push(current);
            for (const next of undirected.get(current) || []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
        components.push(component);
    }
    return components;
}

function findDirectedCycles(nodes: NormalizedNode[], adjacency: Map<string, NormalizedEdge[]>, maxCycles: number): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();
    const path: string[] = [];

    const visit = (nodeId: string) => {
        if (cycles.length >= maxCycles) return;
        visited.add(nodeId);
        stack.add(nodeId);
        path.push(nodeId);
        for (const edge of adjacency.get(nodeId) || []) {
            if (!visited.has(edge.target)) {
                visit(edge.target);
            }
            else if (stack.has(edge.target)) {
                const startIndex = path.indexOf(edge.target);
                if (startIndex >= 0) cycles.push([...path.slice(startIndex), edge.target]);
            }
        }
        stack.delete(nodeId);
        path.pop();
    };

    for (const node of nodes) {
        if (!visited.has(node.id)) visit(node.id);
    }
    return cycles;
}

function findPossibleReversedDirections(
    starts: string[],
    ends: string[],
    adjacency: Map<string, NormalizedEdge[]>,
    reverseAdjacency: Map<string, NormalizedEdge[]>,
) {
    const findings: any[] = [];
    for (const start of starts) {
        const forwardReach = reachableFrom(start, adjacency);
        for (const end of ends) {
            if (forwardReach.has(end)) continue;
            const reverseReach = reachableFrom(end, adjacency);
            const canReachStart = reverseReach.has(start);
            const reverseGraphReach = reachableFrom(start, reverseAdjacency);
            if (canReachStart || reverseGraphReach.has(end)) {
                findings.push({ start_node_id: start, end_node_id: end });
            }
        }
    }
    return findings;
}

function reachableFrom(start: string, adjacency: Map<string, NormalizedEdge[]>) {
    const visited = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const edge of adjacency.get(current) || []) {
            if (!visited.has(edge.target)) {
                visited.add(edge.target);
                queue.push(edge.target);
            }
        }
    }
    return visited;
}

function equipmentSummary(node: NormalizedNode) {
    return {
        node_id: node.id,
        role: node.role,
        label: node.label,
        category: node.category || null,
        family_name: node.familyName || null,
        type_name: node.typeName || null,
        system_name: node.systemName || null,
        flow_lps: nullableRound(node.flowLps, 4),
    };
}

function readLengthM(raw: any): number | null {
    const meters = readNumberPath(raw, ["length_m", "lengthM", "length_meters", "lengthMeters", "engineering.length_m", "data.length_m"]);
    if (positive(meters)) return meters;
    const millimeters = readNumberPath(raw, ["length_mm", "lengthMm", "engineering.length_mm", "data.length_mm"]);
    if (positive(millimeters)) return millimeters! / 1000;
    const feet = readNumberPath(raw, ["length_ft", "lengthFeet", "length_feet"]);
    if (positive(feet)) return feet! * 0.3048;
    return null;
}

function readEquivalentLengthM(raw: any): number | null {
    const meters = readNumberPath(raw, ["equivalent_length_m", "equivalentLengthM", "equiv_length_m", "equivLengthM", "engineering.equivalent_length_m"]);
    if (positive(meters)) return meters;
    const millimeters = readNumberPath(raw, ["equivalent_length_mm", "equivalentLengthMm", "equiv_length_mm", "engineering.equivalent_length_mm"]);
    if (positive(millimeters)) return millimeters! / 1000;
    return null;
}

function readDiameterM(raw: any): number | null {
    const meters = readNumberPath(raw, ["diameter_m", "diameterM", "inside_diameter_m", "insideDiameterM", "engineering.diameter_m"]);
    if (positive(meters)) return meters;
    const millimeters = readNumberPath(raw, ["diameter_mm", "diameterMm", "inside_diameter_mm", "insideDiameterMm", "nominal_diameter_mm", "nominalDiameterMm", "engineering.diameter_mm"]);
    if (positive(millimeters)) return millimeters! / 1000;
    const ambiguous = readNumberPath(raw, ["diameter", "insideDiameter", "nominalDiameter"]);
    if (positive(ambiguous)) {
        return ambiguous! > 3 ? ambiguous! / 1000 : ambiguous!;
    }
    return null;
}

function readFlowLps(raw: any): number | null {
    const lps = readNumberPath(raw, ["flow_lps", "flowLps", "flow_l_s", "flowLitersPerSecond", "engineering.flow_lps", "data.flow_lps"]);
    if (positive(lps)) return lps;
    const m3h = readNumberPath(raw, ["flow_m3h", "flowM3h", "flow_cubic_meters_per_hour", "engineering.flow_m3h"]);
    if (positive(m3h)) return m3h! / 3.6;
    const m3s = readNumberPath(raw, ["flow_m3s", "flowM3s", "flow_cubic_meters_per_second", "engineering.flow_m3s"]);
    if (positive(m3s)) return m3s! * 1000;
    const gpm = readNumberPath(raw, ["flow_gpm", "flowGpm"]);
    if (positive(gpm)) return gpm! * 0.0630902;
    const unit = stringValue(firstDefinedPath(raw, ["flow_unit", "flowUnit", "engineering.flow_unit"])).toLowerCase();
    const flow = readNumberPath(raw, ["flow", "engineering.flow", "data.flow"]);
    if (positive(flow) && unit) {
        if (/l\/?s|liter/.test(unit)) return flow;
        if (/m3\/?h|m\^3\/?h|cubic meters per hour/.test(unit)) return flow! / 3.6;
        if (/m3\/?s|m\^3\/?s|cubic meters per second/.test(unit)) return flow! * 1000;
        if (/gpm/.test(unit)) return flow! * 0.0630902;
    }
    return null;
}

function firstArray(source: any, paths: string[]): any[] {
    for (const path of paths) {
        const value = getPath(source, path);
        if (Array.isArray(value)) return value;
    }
    return [];
}

function readNumberPath(source: any, paths: string[]): number | null {
    const value = firstDefinedPath(source, paths);
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(",", ".")) : NaN;
    return Number.isFinite(number) ? number : null;
}

function firstDefinedPath(source: any, paths: string[]) {
    for (const path of paths) {
        const value = getPath(source, path);
        if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
}

function getPath(source: any, path: string) {
    if (!source || typeof source !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(source, path)) return source[path];
    const parts = path.split(".");
    let current = source;
    for (const part of parts) {
        if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

function stableId(value: any, fallback: string): string {
    if (value && typeof value === "object") {
        const nested = firstDefinedPath(value, ["id", "node_id", "nodeId", "element_id", "elementId", "unique_id", "uniqueId"]);
        if (nested !== undefined) return String(nested);
    }
    if (value !== undefined && value !== null && value !== "") return String(value);
    return fallback;
}

function stringValue(value: any): string {
    return value === undefined || value === null ? "" : String(value);
}

function positive(value: number | null | undefined): value is number {
    return Number.isFinite(value) && (value as number) > 0;
}

function round(value: number, digits: number): number {
    const scale = Math.pow(10, digits);
    return Math.round(value * scale) / scale;
}

function nullableRound(value: number | null | undefined, digits: number): number | null {
    if (!Number.isFinite(value)) return null;
    return round(value as number, digits);
}
