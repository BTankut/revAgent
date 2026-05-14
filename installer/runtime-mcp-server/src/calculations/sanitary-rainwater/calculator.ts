// @ts-nocheck
export const CONNECTOR_GRAPH_SCHEMA_VERSION = "mep.connector-graph.v1";
export const SANITARY_RAINWATER_REPORT_SCHEMA_VERSION = "sanitary-rainwater-sizing.v1";
export const SANITARY_RAINWATER_WRITEBACK_SCHEMA_VERSION = "sanitary-rainwater-writeback-plan.v1";

export const DEFAULT_DRAINAGE_TABLES = {
    profile: "generic-metric-drainage-v1",
    reviewRequired: true,
    sanitary: {
        horizontal: [
            { diameterMm: 40, capacities: [{ minSlope: 0.02, maxFixtureUnits: 3 }] },
            { diameterMm: 50, capacities: [{ minSlope: 0.01, maxFixtureUnits: 6 }, { minSlope: 0.02, maxFixtureUnits: 8 }] },
            { diameterMm: 75, capacities: [{ minSlope: 0.01, maxFixtureUnits: 20 }, { minSlope: 0.02, maxFixtureUnits: 36 }] },
            { diameterMm: 100, capacities: [{ minSlope: 0.005, maxFixtureUnits: 180 }, { minSlope: 0.01, maxFixtureUnits: 216 }, { minSlope: 0.02, maxFixtureUnits: 250 }] },
            { diameterMm: 150, capacities: [{ minSlope: 0.005, maxFixtureUnits: 700 }, { minSlope: 0.01, maxFixtureUnits: 840 }, { minSlope: 0.02, maxFixtureUnits: 1000 }] },
        ],
        vertical: [
            { diameterMm: 40, maxFixtureUnits: 3 },
            { diameterMm: 50, maxFixtureUnits: 6 },
            { diameterMm: 75, maxFixtureUnits: 20 },
            { diameterMm: 100, maxFixtureUnits: 160 },
            { diameterMm: 150, maxFixtureUnits: 360 },
        ],
    },
    rainwater: {
        horizontal: [
            { diameterMm: 75, capacities: [{ minSlope: 0.01, maxFlowLps: 6 }, { minSlope: 0.02, maxFlowLps: 8 }] },
            { diameterMm: 100, capacities: [{ minSlope: 0.005, maxFlowLps: 12 }, { minSlope: 0.01, maxFlowLps: 18 }, { minSlope: 0.02, maxFlowLps: 25 }] },
            { diameterMm: 150, capacities: [{ minSlope: 0.005, maxFlowLps: 35 }, { minSlope: 0.01, maxFlowLps: 50 }, { minSlope: 0.02, maxFlowLps: 70 }] },
            { diameterMm: 200, capacities: [{ minSlope: 0.005, maxFlowLps: 75 }, { minSlope: 0.01, maxFlowLps: 105 }, { minSlope: 0.02, maxFlowLps: 145 }] },
        ],
        vertical: [
            { diameterMm: 75, maxFlowLps: 12 },
            { diameterMm: 100, maxFlowLps: 30 },
            { diameterMm: 150, maxFlowLps: 85 },
            { diameterMm: 200, maxFlowLps: 180 },
        ],
    },
};

const SANITARY_TERMS = ["sanitary", "waste", "soil", "sewer", "drain", "pis su", "pissu", "atik su", "atiksu", "foul"];
const RAINWATER_TERMS = ["rain", "rainwater", "storm", "roof drain", "leader", "yagmur", "yagmur suyu", "overflow"];
const VENT_TERMS = ["vent", "havalik", "havalandirma"];
const PIPE_TERMS = ["pipe", "pipes", "boru"];

function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function round(value, digits = 3) {
    if (!Number.isFinite(value)) {
        return null;
    }
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function lowerText(value) {
    return String(value || "")
        .toLocaleLowerCase("en-US")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function nodeText(node) {
    return lowerText([
        node?.id,
        node?.category,
        node?.familyName,
        node?.typeName,
        node?.systemClassification,
        node?.systemName,
        node?.systemType,
    ].filter(Boolean).join(" "));
}

function hasAny(text, terms) {
    return terms.some((term) => text.includes(term));
}

function addFinding(findings, severity, code, message, details = {}) {
    findings.push({
        severity,
        code,
        message,
        nodeIds: details.nodeIds || [],
        edgeIds: details.edgeIds || [],
        connectorIds: details.connectorIds || [],
        data: details.data || undefined,
    });
}

function normalizeGraphInput(input) {
    if (typeof input === "string") {
        return JSON.parse(input);
    }
    if (input && typeof input === "object") {
        return input;
    }
    throw new Error("Graph input must be a connector graph JSON object or JSON string.");
}

function tableSetFromOptions(options = {}) {
    if (options.tableConfig && typeof options.tableConfig === "object") {
        return options.tableConfig;
    }
    return DEFAULT_DRAINAGE_TABLES;
}

function isPipeNode(node) {
    const text = nodeText(node);
    return node?.category === "Pipes" || hasAny(text, PIPE_TERMS);
}

function systemKindForNode(node, requestedMode = "auto") {
    if (requestedMode === "sanitary" || requestedMode === "rainwater") {
        return requestedMode;
    }
    const text = nodeText(node);
    if (hasAny(text, RAINWATER_TERMS)) {
        return "rainwater";
    }
    if (hasAny(text, SANITARY_TERMS) || positiveNumber(node?.engineering?.fixtureUnits) > 0) {
        return "sanitary";
    }
    if (positiveNumber(node?.engineering?.flowLps) > 0) {
        return "rainwater";
    }
    return "unknown";
}

function pipeRoleForNode(node, systemKind) {
    const text = nodeText(node);
    if (hasAny(text, VENT_TERMS)) {
        return "vent";
    }
    if (text.includes("stack")) {
        return "stack";
    }
    if (systemKind === "rainwater" && text.includes("leader")) {
        return "leader";
    }
    if (text.includes("building drain") || text.includes("main")) {
        return "buildingDrain";
    }
    if (text.includes("branch")) {
        return "branch";
    }
    return systemKind === "rainwater" ? "stormDrain" : "drain";
}

function classifyOrientation(node) {
    const text = nodeText(node);
    if (text.includes("stack") || text.includes("vertical") || text.includes("leader")) {
        return "vertical";
    }

    const connectors = Array.isArray(node?.connectors) ? node.connectors : [];
    let best = null;
    for (let left = 0; left < connectors.length; left++) {
        for (let right = left + 1; right < connectors.length; right++) {
            const a = connectors[left]?.origin || {};
            const b = connectors[right]?.origin || {};
            const dx = asNumber(a.x) - asNumber(b.x);
            const dy = asNumber(a.y) - asNumber(b.y);
            const dz = asNumber(a.z) - asNumber(b.z);
            const planar = Math.sqrt(dx * dx + dy * dy);
            const vertical = Math.abs(dz);
            const distance = Math.sqrt(planar * planar + vertical * vertical);
            if (!best || distance > best.distance) {
                best = { planar, vertical, distance };
            }
        }
    }

    if (best && best.vertical > 50 && best.vertical >= best.planar) {
        return "vertical";
    }
    return "horizontal";
}

function connectorOwnerMap(nodes) {
    const owners = new Map();
    for (const node of nodes) {
        for (const connector of Array.isArray(node?.connectors) ? node.connectors : []) {
            if (connector?.id) {
                owners.set(connector.id, node.id);
            }
        }
    }
    return owners;
}

function buildDirectedGraph(graph, findings) {
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const ownerByConnector = connectorOwnerMap(nodes);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const adjacency = new Map(nodes.map((node) => [node.id, []]));
    const incoming = new Map(nodes.map((node) => [node.id, []]));
    const directedEdges = [];

    for (const edge of edges) {
        const fromNodeId = edge.fromNodeId || ownerByConnector.get(edge.fromConnectorId);
        const toNodeId = edge.toNodeId || ownerByConnector.get(edge.toConnectorId);
        if (!edge.id || !fromNodeId || !toNodeId || !nodeById.has(fromNodeId) || !nodeById.has(toNodeId)) {
            addFinding(findings, "error", "edge_endpoint_invalid", "A graph edge has missing or unknown node endpoints.", {
                edgeIds: edge.id ? [edge.id] : [],
                nodeIds: [fromNodeId, toNodeId].filter(Boolean),
                connectorIds: [edge.fromConnectorId, edge.toConnectorId].filter(Boolean),
            });
            continue;
        }

        let sourceNodeId = fromNodeId;
        let targetNodeId = toNodeId;
        if (edge.direction === "toFrom") {
            sourceNodeId = toNodeId;
            targetNodeId = fromNodeId;
        }
        else if (edge.direction !== "fromTo") {
            addFinding(findings, "error", "direction_ambiguous", "A drainage graph edge has ambiguous or unknown direction; write-back must stay blocked.", {
                edgeIds: [edge.id],
                nodeIds: [fromNodeId, toNodeId],
            });
            continue;
        }

        const directed = {
            id: edge.id,
            sourceNodeId,
            targetNodeId,
            raw: edge,
        };
        directedEdges.push(directed);
        adjacency.get(sourceNodeId).push(directed);
        incoming.get(targetNodeId).push(directed);
    }

    for (const list of adjacency.values()) {
        list.sort((left, right) => left.targetNodeId.localeCompare(right.targetNodeId) || left.id.localeCompare(right.id));
    }
    for (const list of incoming.values()) {
        list.sort((left, right) => left.sourceNodeId.localeCompare(right.sourceNodeId) || left.id.localeCompare(right.id));
    }

    return { nodes, edges, nodeById, adjacency, incoming, directedEdges };
}

function topologicalOrder(directed, findings) {
    const indegree = new Map(directed.nodes.map((node) => [node.id, 0]));
    for (const edge of directed.directedEdges) {
        indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) || 0) + 1);
    }

    const queue = [...indegree.entries()]
        .filter((entry) => entry[1] === 0)
        .map((entry) => entry[0])
        .sort();
    const order = [];
    while (queue.length > 0) {
        const nodeId = queue.shift();
        order.push(nodeId);
        for (const edge of directed.adjacency.get(nodeId) || []) {
            const next = (indegree.get(edge.targetNodeId) || 0) - 1;
            indegree.set(edge.targetNodeId, next);
            if (next === 0) {
                queue.push(edge.targetNodeId);
                queue.sort();
            }
        }
    }

    if (order.length !== directed.nodes.length) {
        const cycleNodeIds = [...indegree.entries()].filter((entry) => entry[1] > 0).map((entry) => entry[0]).sort();
        addFinding(findings, "error", "cycle_detected", "The connector graph contains a directed cycle; downstream accumulation cannot be trusted.", {
            nodeIds: cycleNodeIds,
        });
        return [...new Set([...order, ...directed.nodes.map((node) => node.id).sort()])];
    }

    return order;
}

function loadForNode(node, systemKind, requestedMode) {
    const kind = systemKindForNode(node, requestedMode);
    if (systemKind === "sanitary") {
        return kind === "sanitary" ? positiveNumber(node?.engineering?.fixtureUnits) : 0;
    }
    if (systemKind === "rainwater") {
        return kind === "rainwater" ? positiveNumber(node?.engineering?.flowLps) : 0;
    }
    return 0;
}

function accumulateLoads(directed, order, systemKind, requestedMode, findings) {
    const accumulated = new Map(directed.nodes.map((node) => [node.id, 0]));
    const ownLoads = new Map();

    for (const node of directed.nodes) {
        const load = loadForNode(node, systemKind, requestedMode);
        ownLoads.set(node.id, load);
        if (load > 0) {
            accumulated.set(node.id, (accumulated.get(node.id) || 0) + load);
        }
    }

    for (const nodeId of order) {
        const currentLoad = accumulated.get(nodeId) || 0;
        const ownLoad = ownLoads.get(nodeId) || 0;
        const outgoing = directed.adjacency.get(nodeId) || [];
        const node = directed.nodeById.get(nodeId);
        if (ownLoad > 0 && outgoing.length === 0 && !isPipeNode(node)) {
            addFinding(findings, "error", "disconnected_source_load", "A sanitary fixture or rainwater source has load but no downstream directed edge.", {
                nodeIds: [nodeId],
                data: { systemKind, load: ownLoad },
            });
        }
        if (currentLoad > 0 && outgoing.length > 1) {
            addFinding(findings, "warning", "flow_split", "A drainage source load reaches more than one downstream edge; the full load was propagated to each path for review.", {
                nodeIds: [nodeId],
                edgeIds: outgoing.map((edge) => edge.id),
                data: { systemKind, load: currentLoad },
            });
        }
        for (const edge of outgoing) {
            accumulated.set(edge.targetNodeId, (accumulated.get(edge.targetNodeId) || 0) + currentLoad);
        }
    }

    return { accumulated, ownLoads };
}

function selectedCapacityForSlope(row, slope, capacityKey) {
    const capacities = Array.isArray(row.capacities) ? row.capacities : [];
    return capacities
        .filter((capacity) => Number(capacity.minSlope) <= slope + 1e-9 && Number.isFinite(Number(capacity[capacityKey])))
        .sort((left, right) => Number(right.minSlope) - Number(left.minSlope))[0] || null;
}

function lowestSlopeForRows(rows) {
    let lowest = Infinity;
    for (const row of rows) {
        for (const capacity of Array.isArray(row.capacities) ? row.capacities : []) {
            const slope = Number(capacity.minSlope);
            if (Number.isFinite(slope) && slope < lowest) {
                lowest = slope;
            }
        }
    }
    return Number.isFinite(lowest) ? lowest : null;
}

function lookupByLoad(rows, load, orientation, slope, capacityKey, findings, node) {
    const sortedRows = [...(rows || [])].sort((left, right) => Number(left.diameterMm) - Number(right.diameterMm));
    if (load <= 0) {
        return null;
    }

    if (orientation === "vertical") {
        for (const row of sortedRows) {
            const capacity = Number(row[capacityKey]);
            if (Number.isFinite(capacity) && capacity >= load) {
                return {
                    diameterMm: Number(row.diameterMm),
                    tableRow: { diameterMm: Number(row.diameterMm), capacity },
                };
            }
        }
        addFinding(findings, "error", "table_capacity_exceeded", "No vertical drainage table row can carry the accumulated load.", {
            nodeIds: [node.id],
            data: { load, capacityKey },
        });
        return null;
    }

    const actualSlope = Number(slope);
    const lowestSlope = lowestSlopeForRows(sortedRows);
    if (!Number.isFinite(actualSlope) || actualSlope <= 0) {
        addFinding(findings, "error", "slope_missing", "Horizontal drainage pipe is missing a positive slope value.", {
            nodeIds: [node.id],
        });
        return null;
    }
    if (lowestSlope !== null && actualSlope + 1e-9 < lowestSlope) {
        addFinding(findings, "error", "slope_violation", "Horizontal drainage pipe slope is below the lowest configured table slope.", {
            nodeIds: [node.id],
            data: { actualSlope, minimumConfiguredSlope: lowestSlope },
        });
        return null;
    }

    for (const row of sortedRows) {
        const capacity = selectedCapacityForSlope(row, actualSlope, capacityKey);
        if (capacity && Number(capacity[capacityKey]) >= load) {
            return {
                diameterMm: Number(row.diameterMm),
                tableRow: {
                    diameterMm: Number(row.diameterMm),
                    minSlope: Number(capacity.minSlope),
                    capacity: Number(capacity[capacityKey]),
                },
            };
        }
    }

    addFinding(findings, "error", "table_capacity_exceeded", "No horizontal drainage table row can carry the accumulated load at the pipe slope.", {
        nodeIds: [node.id],
        data: { load, slope: actualSlope, capacityKey },
    });
    return null;
}

function lookupSanitaryDiameter(node, orientation, fixtureUnits, tables, findings) {
    const rows = orientation === "vertical" ? tables?.sanitary?.vertical : tables?.sanitary?.horizontal;
    return lookupByLoad(rows, fixtureUnits, orientation, node?.engineering?.slope, "maxFixtureUnits", findings, node);
}

function lookupRainwaterDiameter(node, orientation, flowLps, tables, findings) {
    const rows = orientation === "vertical" ? tables?.rainwater?.vertical : tables?.rainwater?.horizontal;
    return lookupByLoad(rows, flowLps, orientation, node?.engineering?.slope, "maxFlowLps", findings, node);
}

function nodeHasLikelyMissingLoad(node, requestedMode) {
    const text = nodeText(node);
    const kind = systemKindForNode(node, requestedMode);
    if (isPipeNode(node)) {
        return null;
    }
    if (kind === "sanitary" && positiveNumber(node?.engineering?.fixtureUnits) === 0 && (hasAny(text, SANITARY_TERMS) || text.includes("fixture"))) {
        return "missing_fixture_units";
    }
    if (kind === "rainwater" && positiveNumber(node?.engineering?.flowLps) === 0 && (hasAny(text, RAINWATER_TERMS) || text.includes("drain"))) {
        return "missing_storm_flow";
    }
    return null;
}

function staticFoundationFeedback(graph) {
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const hasRainNode = nodes.some((node) => systemKindForNode(node, "auto") === "rainwater");
    const hasVentNode = nodes.some((node) => hasAny(nodeText(node), VENT_TERMS));
    const feedback = [
        {
            code: "explicit_drainage_role",
            message: "Calculation branches currently infer fixture, stack, leader, branch, building drain, vent, and outfall roles from Revit text fields. Foundation schema should consider an explicit drainage role field if multiple sizing branches need deterministic role handling.",
        },
    ];
    if (hasRainNode) {
        feedback.push({
            code: "storm_load_inputs",
            message: "Rainwater sizing can consume engineering.flowLps, but roof area, vertical wall area, rainfall intensity, runoff coefficient, and primary/secondary overflow identity are not explicit in the graph contract.",
        });
    }
    if (hasVentNode) {
        feedback.push({
            code: "vent_sizing_inputs",
            message: "Vent sizing generally needs vent role and developed length/context. The current graph has segment length but no explicit vent sizing context or terminal/source semantics.",
        });
    }
    return feedback;
}

export function calculateSanitaryRainwater(input, options = {}) {
    const graph = normalizeGraphInput(input);
    const findings = [];
    const requestedMode = options.systemMode || "auto";
    const tables = tableSetFromOptions(options);

    if (graph.schemaVersion !== CONNECTOR_GRAPH_SCHEMA_VERSION) {
        addFinding(findings, "error", "schema_version_unsupported", "The calculation module only consumes the shared connector graph schema version mep.connector-graph.v1.", {
            data: { received: graph.schemaVersion || null },
        });
    }
    if (!Array.isArray(graph.nodes)) {
        addFinding(findings, "error", "nodes_missing", "Connector graph nodes must be an array.");
    }
    if (!Array.isArray(graph.edges)) {
        addFinding(findings, "error", "edges_missing", "Connector graph edges must be an array.");
    }
    if (tables?.reviewRequired !== false) {
        addFinding(findings, "warning", "table_profile_review_required", "The active drainage table profile is configurable and must be reviewed against the project code basis before production write-back.", {
            data: { tableProfile: tables?.profile || "custom" },
        });
    }

    const directed = buildDirectedGraph(graph, findings);
    const order = topologicalOrder(directed, findings);
    const sanitaryLoads = accumulateLoads(directed, order, "sanitary", requestedMode, findings);
    const rainwaterLoads = accumulateLoads(directed, order, "rainwater", requestedMode, findings);

    for (const node of directed.nodes) {
        const missingLoad = nodeHasLikelyMissingLoad(node, requestedMode);
        if (missingLoad === "missing_fixture_units") {
            addFinding(findings, "warning", missingLoad, "A likely sanitary fixture has no engineering.fixtureUnits value.", { nodeIds: [node.id] });
        }
        if (missingLoad === "missing_storm_flow") {
            addFinding(findings, "warning", missingLoad, "A likely roof/storm drain has no engineering.flowLps value.", { nodeIds: [node.id] });
        }
        if (systemKindForNode(node, requestedMode) === "unknown" && isPipeNode(node)) {
            addFinding(findings, "warning", "missing_system_data", "A pipe node has no recognizable sanitary or rainwater system classification.", { nodeIds: [node.id] });
        }
    }

    const baseCalculations = new Map();
    for (const node of directed.nodes) {
        if (!isPipeNode(node)) {
            continue;
        }

        const sanitaryDfu = sanitaryLoads.accumulated.get(node.id) || 0;
        const rainFlowLps = rainwaterLoads.accumulated.get(node.id) || 0;
        if (sanitaryDfu <= 0 && rainFlowLps <= 0) {
            continue;
        }
        if (sanitaryDfu > 0 && rainFlowLps > 0) {
            addFinding(findings, "error", "mixed_drainage_load", "A pipe accumulated both sanitary DFU and rainwater flow; system classification or graph connectivity must be reviewed.", {
                nodeIds: [node.id],
                data: { sanitaryDfu, rainFlowLps },
            });
            continue;
        }

        const systemKind = sanitaryDfu > 0 ? "sanitary" : "rainwater";
        const role = pipeRoleForNode(node, systemKind);
        const orientation = classifyOrientation(node);
        const currentDiameterMm = positiveNumber(node?.engineering?.diameterMm) || null;
        let lookup = null;
        if (role === "vent") {
            addFinding(findings, "warning", "vent_sizing_not_implemented", "Vent pipes are detected but are not resized by the current sanitary/rainwater table profile.", {
                nodeIds: [node.id],
            });
        }
        else if (systemKind === "sanitary") {
            lookup = lookupSanitaryDiameter(node, orientation, sanitaryDfu, tables, findings);
        }
        else {
            lookup = lookupRainwaterDiameter(node, orientation, rainFlowLps, tables, findings);
        }

        baseCalculations.set(node.id, {
            node,
            systemKind,
            role,
            orientation,
            sanitaryDfu,
            rainFlowLps,
            slope: Number.isFinite(Number(node?.engineering?.slope)) ? Number(node.engineering.slope) : null,
            currentDiameterMm,
            baseDiameterMm: lookup?.diameterMm || null,
            recommendedDiameterMm: lookup?.diameterMm || null,
            tableTrace: lookup?.tableRow || null,
            noReductionRaisedFromMm: null,
            noReductionReason: null,
        });
    }

    const propagatedMinimum = new Map();
    const respectExisting = options.respectExistingUpstreamDiameters !== false;
    for (const nodeId of order) {
        const inherited = positiveNumber(propagatedMinimum.get(nodeId));
        const calc = baseCalculations.get(nodeId);
        let outgoingMinimum = inherited;
        if (calc) {
            if (calc.baseDiameterMm && inherited > calc.baseDiameterMm) {
                calc.noReductionRaisedFromMm = calc.baseDiameterMm;
                calc.noReductionReason = "Raised to avoid downstream reduction below upstream pipe recommendation.";
                calc.recommendedDiameterMm = inherited;
            }
            if (calc.recommendedDiameterMm) {
                outgoingMinimum = Math.max(outgoingMinimum, calc.recommendedDiameterMm);
            }
            if (respectExisting && calc.currentDiameterMm) {
                outgoingMinimum = Math.max(outgoingMinimum, calc.currentDiameterMm);
            }
        }
        for (const edge of directed.adjacency.get(nodeId) || []) {
            propagatedMinimum.set(edge.targetNodeId, Math.max(positiveNumber(propagatedMinimum.get(edge.targetNodeId)), outgoingMinimum));
        }
    }

    const recommendations = [...baseCalculations.values()]
        .map((calc) => {
            const elementId = Number.isFinite(Number(calc.node.elementId)) ? Number(calc.node.elementId) : null;
            const requiresDiameterChange = !!(calc.currentDiameterMm && calc.recommendedDiameterMm && calc.recommendedDiameterMm > calc.currentDiameterMm + 0.1);
            const writeBackEligible = !!(elementId && calc.recommendedDiameterMm && calc.role !== "vent");
            return {
                nodeId: calc.node.id,
                elementId,
                uniqueId: calc.node.uniqueId || null,
                systemKind: calc.systemKind,
                pipeRole: calc.role,
                orientation: calc.orientation,
                accumulatedFixtureUnits: calc.sanitaryDfu > 0 ? round(calc.sanitaryDfu) : null,
                accumulatedFlowLps: calc.rainFlowLps > 0 ? round(calc.rainFlowLps) : null,
                slope: calc.slope,
                currentDiameterMm: calc.currentDiameterMm ? round(calc.currentDiameterMm) : null,
                requiredDiameterMm: calc.baseDiameterMm ? round(calc.baseDiameterMm) : null,
                recommendedDiameterMm: calc.recommendedDiameterMm ? round(calc.recommendedDiameterMm) : null,
                noReductionRaisedFromMm: calc.noReductionRaisedFromMm ? round(calc.noReductionRaisedFromMm) : null,
                noReductionReason: calc.noReductionReason,
                requiresDiameterChange,
                tableTrace: calc.tableTrace,
                writeBack: {
                    eligible: writeBackEligible,
                    reason: writeBackEligible ? "Pipe element has a traceable recommendation." : "No writable pipe diameter recommendation was produced.",
                },
            };
        })
        .sort((left, right) => String(left.nodeId).localeCompare(String(right.nodeId)));

    const hasErrors = findings.some((finding) => finding.severity === "error");
    const hasWarnings = findings.some((finding) => finding.severity === "warning");
    const status = hasErrors ? "fail" : (hasWarnings ? "warn" : "pass");
    const writeBackCandidates = recommendations.filter((item) => item.writeBack.eligible && item.requiresDiameterChange);

    return {
        schemaVersion: SANITARY_RAINWATER_REPORT_SCHEMA_VERSION,
        sourceGraphSchemaVersion: graph.schemaVersion || null,
        status,
        summary: {
            tableProfile: tables?.profile || "custom",
            systemMode: requestedMode,
            nodeCount: directed.nodes.length,
            edgeCount: directed.edges.length,
            directedEdgeCount: directed.directedEdges.length,
            pipeCount: directed.nodes.filter(isPipeNode).length,
            recommendationCount: recommendations.length,
            writeBackCandidateCount: writeBackCandidates.length,
            blockerCount: findings.filter((finding) => finding.severity === "error").length,
        },
        recommendations,
        findings,
        foundationFeedback: staticFoundationFeedback(graph),
    };
}

export function createWriteBackPlan(report, options = {}) {
    const findings = Array.isArray(report?.findings) ? report.findings : [];
    const blocked = report?.status === "fail" || findings.some((finding) => finding.severity === "error");
    let changes = (Array.isArray(report?.recommendations) ? report.recommendations : [])
        .filter((item) => item?.writeBack?.eligible && item.requiresDiameterChange && item.recommendedDiameterMm && item.elementId)
        .map((item) => ({
            nodeId: item.nodeId,
            elementId: item.elementId,
            uniqueId: item.uniqueId,
            systemKind: item.systemKind,
            pipeRole: item.pipeRole,
            currentDiameterMm: item.currentDiameterMm,
            targetDiameterMm: item.recommendedDiameterMm,
            accumulatedFixtureUnits: item.accumulatedFixtureUnits,
            accumulatedFlowLps: item.accumulatedFlowLps,
            trace: item.tableTrace,
        }))
        .sort((left, right) => Number(left.elementId) - Number(right.elementId));

    const maxWrites = Number(options.maxWrites || 0);
    if (Number.isFinite(maxWrites) && maxWrites > 0) {
        changes = changes.slice(0, maxWrites);
    }

    return {
        schemaVersion: SANITARY_RAINWATER_WRITEBACK_SCHEMA_VERSION,
        status: blocked ? "blocked" : (changes.length > 0 ? "ready" : "no_changes"),
        summary: {
            blocked,
            changeCount: changes.length,
            maxWrites: Number.isFinite(maxWrites) && maxWrites > 0 ? maxWrites : null,
            sourceReportStatus: report?.status || null,
        },
        changes,
        blockers: blocked ? findings.filter((finding) => finding.severity === "error") : [],
    };
}
