export const CONNECTOR_GRAPH_SCHEMA_VERSION = "mep.connector-graph.v1";
export const FIRE_AUDIT_SCHEMA_VERSION = "mep.fire-piping-audit.v1";
export const FIRE_SOLVER_ADAPTER_SCHEMA_VERSION = "mep.fire-solver-adapter.v0";
const DEFAULT_SIZING_SCHEDULE = {
    sprinkler: [
        { maxCount: 1, diameterMm: 25 },
        { maxCount: 2, diameterMm: 32 },
        { maxCount: 4, diameterMm: 40 },
        { maxCount: 8, diameterMm: 50 },
        { maxCount: 18, diameterMm: 65 },
        { maxCount: 36, diameterMm: 80 },
        { maxCount: 55, diameterMm: 100 },
        { maxCount: Number.POSITIVE_INFINITY, diameterMm: 150 },
    ],
    cabinet: [
        { maxCount: 1, diameterMm: 50 },
        { maxCount: 2, diameterMm: 65 },
        { maxCount: 4, diameterMm: 80 },
        { maxCount: Number.POSITIVE_INFINITY, diameterMm: 100 },
    ],
};
const K_FACTOR_KEYS = ["kFactor", "k-factor", "k factor", "sprinklerKFactor"];
const DESIGN_DENSITY_KEYS = ["designDensity", "design density", "density", "remoteAreaDensity"];
const HOSE_ALLOWANCE_KEYS = ["hoseAllowance", "hose allowance", "cabinetAllowance", "hoseFlowLps"];
const C_FACTOR_KEYS = ["cFactor", "c-factor", "hazenWilliamsC", "hazen williams c"];
const EQUIVALENT_LENGTH_KEYS = ["equivalentLengthMm", "equivalent length", "equivalentLengthM", "eqLengthMm"];
const REMOTE_AREA_KEYS = ["remoteArea", "remoteAreaId", "remote area", "remoteAreaName"];
export function createFirePipingTopologyAudit(rawGraph, options = {}) {
    const graph = normalizeGraph(rawGraph);
    const findings = [];
    const sizingSchedule = mergeSizingSchedule(options.sizingSchedule);
    if (graph.schemaVersion !== CONNECTOR_GRAPH_SCHEMA_VERSION) {
        findings.push({
            severity: "error",
            code: "schema_version_unsupported",
            message: `Expected ${CONNECTOR_GRAPH_SCHEMA_VERSION}; received ${graph.schemaVersion || "missing"}.`,
        });
    }
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const nodeById = new Map();
    const connectorToNode = new Map();
    const connectedConnectorIds = new Set();
    for (const node of nodes) {
        const id = safeId(node.id);
        if (!id) {
            findings.push({
                severity: "error",
                code: "node_id_missing",
                message: "Connector graph node is missing id.",
            });
            continue;
        }
        if (nodeById.has(id)) {
            findings.push({
                severity: "error",
                code: "node_id_duplicate",
                message: `Duplicate connector graph node id '${id}'.`,
                nodeId: id,
            });
            continue;
        }
        nodeById.set(id, node);
        for (const connector of node.connectors || []) {
            const connectorId = safeId(connector.id);
            if (!connectorId) {
                findings.push({
                    severity: "warning",
                    code: "connector_id_missing",
                    message: `Node '${id}' has a connector without id.`,
                    nodeId: id,
                });
                continue;
            }
            connectorToNode.set(connectorId, id);
        }
    }
    const normalizedEdges = [];
    const adjacency = createAdjacency([...nodeById.keys()]);
    for (const edge of edges) {
        const normalized = normalizeEdge(edge, connectorToNode, normalizedEdges.length + 1);
        if (edge.fromConnectorId)
            connectedConnectorIds.add(edge.fromConnectorId);
        if (edge.toConnectorId)
            connectedConnectorIds.add(edge.toConnectorId);
        if (!normalized.fromNodeId || !normalized.toNodeId) {
            findings.push({
                severity: "error",
                code: "edge_endpoint_unknown",
                message: `Edge '${normalized.id}' cannot be mapped to owner nodes.`,
                edgeId: normalized.id,
            });
            continue;
        }
        if (!nodeById.has(normalized.fromNodeId) || !nodeById.has(normalized.toNodeId)) {
            findings.push({
                severity: "error",
                code: "edge_endpoint_missing",
                message: `Edge '${normalized.id}' references a node that is not present in the graph.`,
                edgeId: normalized.id,
            });
            continue;
        }
        normalizedEdges.push(normalized);
        addUndirected(adjacency, normalized.fromNodeId, normalized.toNodeId, normalized.id);
    }
    const classified = new Map();
    for (const [id, node] of nodeById.entries()) {
        const roleInfo = classifyNode(node);
        classified.set(id, {
            node,
            id,
            primaryRole: roleInfo.primaryRole,
            roleTags: roleInfo.roleTags,
            searchText: roleInfo.searchText,
            degree: adjacency.get(id)?.length || 0,
            distanceFromSource: null,
            downstreamSprinklerCount: 0,
            downstreamCabinetCount: 0,
        });
    }
    const openEnds = collectOpenEnds(nodes, connectedConnectorIds, findings);
    const components = findComponents([...nodeById.keys()], adjacency);
    const componentByNode = new Map();
    components.forEach((component, index) => {
        const componentId = `component-${index + 1}`;
        for (const nodeId of component.nodeIds) {
            componentByNode.set(nodeId, componentId);
            const item = classified.get(nodeId);
            if (item)
                item.componentId = componentId;
        }
    });
    if (components.length > 1) {
        findings.push({
            severity: "warning",
            code: "disconnected_network",
            message: `Connector graph contains ${components.length} disconnected networks.`,
        });
    }
    const sourceNodeIds = selectSourceNodes(options, classified, normalizedEdges, findings);
    const terminals = selectTerminalNodes(classified);
    const cycleEdges = detectCycles([...nodeById.keys()], adjacency);
    if (cycleEdges.length > 0) {
        findings.push({
            severity: "warning",
            code: "cycle_detected",
            message: "Fire piping graph contains at least one loop. Same-depth loop edges are kept out of downstream counts and reported as orientation ties.",
        });
    }
    validateComponents(components, classified, sourceNodeIds, terminals, findings);
    const orientation = orientFromSources(sourceNodeIds, normalizedEdges, adjacency, classified, findings);
    applyDownstreamCounts(classified, orientation.outgoing);
    markBranchMains(classified);
    const sizingAudit = buildSizingAudit(classified, sizingSchedule);
    const reducerReport = buildReducerReport(classified, normalizedEdges, adjacency, findings);
    const missingHydraulicInputs = buildMissingHydraulicInputs(graph, classified);
    for (const finding of missingHydraulicInputs)
        findings.push(finding);
    const solverAdapter = options.includeSolverAdapter === false
        ? undefined
        : buildSolverAdapter(graph, classified, orientation.orientedEdges, missingHydraulicInputs);
    const sprinklerCount = [...classified.values()].filter((item) => hasRole(item, "sprinkler")).length;
    const cabinetCount = [...classified.values()].filter((item) => hasRole(item, "cabinet")).length;
    const sizingIssueCount = sizingAudit.filter((item) => item.status !== "ok" && item.status !== "not_applicable").length;
    const reducerIssueCount = reducerReport.transitions.filter((item) => item.status !== "reducer_present").length;
    const errorCount = findings.filter((item) => item.severity === "error").length;
    const warningCount = findings.filter((item) => item.severity === "warning").length;
    return {
        schemaVersion: FIRE_AUDIT_SCHEMA_VERSION,
        sourceSchemaVersion: graph.schemaVersion || null,
        reportLabel: "audit/schematic",
        complianceClaim: "none",
        hydraulicApproval: false,
        writePolicy: {
            modelWritesAllowed: false,
            requiredWorkflow: ["dry-run", "preview", "validate", "commit", "report"],
        },
        summary: {
            nodeCount: nodes.length,
            edgeCount: edges.length,
            componentCount: components.length,
            sourceCount: sourceNodeIds.length,
            sprinklerCount,
            cabinetCount,
            openEndCount: openEnds.length,
            cycleDetected: cycleEdges.length > 0,
            missingHydraulicInputCount: missingHydraulicInputs.length,
            sizingIssueCount,
            reducerIssueCount,
            errorCount,
            warningCount,
            solverAdapterStatus: solverAdapter?.status || "not_requested",
        },
        sources: sourceNodeIds.map((nodeId) => summarizeNode(classified.get(nodeId))),
        terminals: terminals.map((nodeId) => summarizeNode(classified.get(nodeId))),
        components: components.map((component, index) => summarizeComponent(component, index, classified, sourceNodeIds)),
        nodes: [...classified.values()]
            .sort(compareById)
            .map((item) => ({
            nodeId: item.id,
            elementId: item.node.elementId ?? null,
            uniqueId: item.node.uniqueId ?? null,
            primaryRole: item.primaryRole,
            roleTags: item.roleTags,
            componentId: item.componentId || null,
            sourceNodeId: item.sourceNodeId || null,
            distanceFromSource: item.distanceFromSource,
            downstreamSprinklerCount: item.downstreamSprinklerCount,
            downstreamCabinetCount: item.downstreamCabinetCount,
            diameterMm: readDiameterMm(item.node),
            levelName: item.node.levelName || null,
            elevationMm: readElevationMm(item.node),
        })),
        orientedEdges: orientation.orientedEdges,
        openEnds,
        sizingAudit,
        reducerReport,
        missingHydraulicInputs,
        solverAdapter,
        findings: findings.sort(compareFindings),
        limitations: [
            "Count-based size checks are schematic audit checks only.",
            "No NFPA/EN hydraulic compliance is asserted.",
            "Hydraulic approval requires K-factor, design density, hose allowance, C-factor, elevation, equivalent length, remote area and a reviewed solver workflow.",
        ],
    };
}
function normalizeGraph(rawGraph) {
    const graph = rawGraph || {};
    return {
        ...graph,
        metadata: graph.metadata || {},
        nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
        edges: Array.isArray(graph.edges) ? graph.edges : [],
    };
}
function mergeSizingSchedule(partial) {
    return {
        sprinkler: normalizeRules(partial?.sprinkler, DEFAULT_SIZING_SCHEDULE.sprinkler),
        cabinet: normalizeRules(partial?.cabinet, DEFAULT_SIZING_SCHEDULE.cabinet),
    };
}
function normalizeRules(rules, fallback) {
    const source = Array.isArray(rules) && rules.length > 0 ? rules : fallback;
    return source
        .filter((rule) => Number.isFinite(rule.maxCount) || rule.maxCount === Number.POSITIVE_INFINITY)
        .filter((rule) => Number.isFinite(rule.diameterMm) && rule.diameterMm > 0)
        .sort((a, b) => a.maxCount - b.maxCount);
}
function safeId(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeEdge(edge, connectorToNode, ordinal) {
    const fromConnectorId = safeId(edge.fromConnectorId);
    const toConnectorId = safeId(edge.toConnectorId);
    return {
        edge,
        id: safeId(edge.id) || `edge-${ordinal}`,
        fromNodeId: safeId(edge.fromNodeId) || connectorToNode.get(fromConnectorId) || "",
        toNodeId: safeId(edge.toNodeId) || connectorToNode.get(toConnectorId) || "",
        fromConnectorId,
        toConnectorId,
    };
}
function createAdjacency(nodeIds) {
    const adjacency = new Map();
    for (const nodeId of nodeIds)
        adjacency.set(nodeId, []);
    return adjacency;
}
function addUndirected(adjacency, a, b, edgeId) {
    if (!a || !b || a === b)
        return;
    adjacency.get(a)?.push({ nodeId: b, edgeId });
    adjacency.get(b)?.push({ nodeId: a, edgeId });
}
function classifyNode(node) {
    const text = nodeSearchText(node);
    const identityText = nodeIdentityText(node);
    const tags = new Set();
    const explicitRole = normalizeText(readProperty(node, ["fireRole", "role", "mepRole"]));
    if (containsAny(explicitRole, ["source", "feed", "supply"]))
        tags.add("source");
    if (containsAny(explicitRole, ["riser", "standpipe", "kolon"]))
        tags.add("riser");
    if (containsAny(explicitRole, ["sprinkler"]))
        tags.add("sprinkler");
    if (containsAny(explicitRole, ["cabinet", "hose"]))
        tags.add("cabinet");
    if (containsAny(explicitRole, ["valve", "vana"]))
        tags.add("valve");
    if (containsAny(explicitRole, ["reducer", "transition"]))
        tags.add("reducer");
    const isFireSystem = containsAny(text, ["fire", "sprinkler", "yangin", "standpipe", "hose", "cabinet"]);
    if (containsAny(identityText, ["sprinkler", "pendent", "upright", "sidewall", "concealed head"]))
        tags.add("sprinkler");
    if (containsAny(identityText, ["fire hose cabinet", "hose cabinet", "fire cabinet", "yangin dolabi", "fhc"]))
        tags.add("cabinet");
    if (containsAny(identityText, ["riser", "standpipe", "kolon", "vertical main"]))
        tags.add("riser");
    if (containsAny(identityText, ["fire pump", "water tank", "fire water source", "supply source"]) || (isFireSystem && containsAny(identityText, ["pump"])))
        tags.add("source");
    if (containsAny(identityText, ["valve", "vana", "alarm check", "zone control", "test and drain", "check valve"]))
        tags.add("valve");
    if (containsAny(identityText, ["reducer", "reducing", "transition", "concentric", "eccentric"]))
        tags.add("reducer");
    if (containsAny(identityText, ["pipe fitting", "tee", "elbow", "coupling"]))
        tags.add("fitting");
    const categoryText = normalizeText(node.category);
    const familyTypeText = normalizeText([node.familyName, node.typeName].filter(Boolean).join(" "));
    const familyTypeLooksLikePipe = containsAny(familyTypeText, ["pipe"])
        && !containsAny(familyTypeText, ["fitting", "valve", "reducer", "cabinet", "sprinkler"]);
    if (categoryText === "pipes" || familyTypeLooksLikePipe)
        tags.add("pipe");
    if (tags.has("reducer"))
        tags.add("fitting");
    if (tags.has("cabinet") && tags.has("valve"))
        tags.delete("valve");
    const priority = ["source", "riser", "sprinkler", "cabinet", "reducer", "valve", "pipe", "fitting"];
    const primaryRole = priority.find((role) => tags.has(role)) || "unknown";
    return {
        primaryRole,
        roleTags: tags.size > 0 ? [...tags].sort() : ["unknown"],
        searchText: text,
    };
}
function nodeSearchText(node) {
    const props = node.properties || {};
    const pieces = [
        node.category,
        node.familyName,
        node.typeName,
        node.systemClassification,
        node.systemName,
        node.systemType,
        node.levelName,
        ...Object.keys(props),
        ...Object.values(props).map((value) => String(value)),
    ];
    return normalizeText(pieces.filter(Boolean).join(" "));
}
function nodeIdentityText(node) {
    const props = node.properties || {};
    const pieces = [
        node.category,
        node.familyName,
        node.typeName,
        ...Object.keys(props),
        ...Object.values(props).map((value) => String(value)),
    ];
    return normalizeText(pieces.filter(Boolean).join(" "));
}
function normalizeText(value) {
    return String(value || "")
        .replace(/\u0131/g, "i")
        .replace(/\u0130/g, "i")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}
function containsAny(text, tokens) {
    return tokens.some((token) => text.includes(normalizeText(token)));
}
function normalizeKey(value) {
    return normalizeText(value).replace(/[^a-z0-9]/g, "");
}
function readProperty(source, aliases) {
    const properties = source?.properties || {};
    const aliasSet = new Set(aliases.map(normalizeKey));
    for (const [key, value] of Object.entries(properties)) {
        if (aliasSet.has(normalizeKey(key)))
            return value;
    }
    return undefined;
}
function readNumericProperty(source, aliases) {
    const value = readProperty(source, aliases);
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const parsed = Number(value.replace(",", ".").replace(/[^0-9.+-]/g, ""));
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function readGlobalProperty(graph, aliases) {
    return readProperty(graph.metadata, aliases);
}
function readGlobalNumericProperty(graph, aliases) {
    return readNumericProperty(graph.metadata, aliases);
}
function collectOpenEnds(nodes, connectedConnectorIds, findings) {
    const openEnds = [];
    for (const node of nodes) {
        const nodeId = safeId(node.id);
        for (const connector of node.connectors || []) {
            const connectorId = safeId(connector.id);
            if (!connectorId || connector.isConnectionExpected === false)
                continue;
            if (!connectedConnectorIds.has(connectorId)) {
                const openEnd = {
                    nodeId,
                    connectorId,
                    elementId: node.elementId ?? null,
                    category: node.category || null,
                    familyName: node.familyName || null,
                    typeName: node.typeName || null,
                };
                openEnds.push(openEnd);
                findings.push({
                    severity: "warning",
                    code: "open_end",
                    message: `Expected connector '${connectorId}' is not connected.`,
                    nodeId,
                    connectorId,
                });
            }
        }
    }
    return openEnds.sort((a, b) => a.connectorId.localeCompare(b.connectorId));
}
function findComponents(nodeIds, adjacency) {
    const visited = new Set();
    const components = [];
    for (const start of nodeIds.sort()) {
        if (visited.has(start))
            continue;
        const nodeSet = new Set();
        const edgeSet = new Set();
        const queue = [start];
        visited.add(start);
        while (queue.length > 0) {
            const nodeId = queue.shift();
            nodeSet.add(nodeId);
            for (const next of adjacency.get(nodeId) || []) {
                edgeSet.add(next.edgeId);
                if (!visited.has(next.nodeId)) {
                    visited.add(next.nodeId);
                    queue.push(next.nodeId);
                }
            }
        }
        components.push({
            nodeIds: [...nodeSet].sort(),
            edgeIds: [...edgeSet].sort(),
        });
    }
    return components;
}
function selectSourceNodes(options, classified, edges, findings) {
    const result = new Set();
    for (const nodeId of options.sourceNodeIds || []) {
        if (classified.has(nodeId)) {
            result.add(nodeId);
        }
        else {
            findings.push({
                severity: "warning",
                code: "source_node_missing",
                message: `Requested source node '${nodeId}' is not present in the graph.`,
                nodeId,
            });
        }
    }
    for (const item of classified.values()) {
        if (hasRole(item, "source") || hasRole(item, "riser"))
            result.add(item.id);
    }
    if (result.size === 0) {
        for (const nodeId of inferSourcesFromDirectedEdges(classified, edges)) {
            result.add(nodeId);
            findings.push({
                severity: "warning",
                code: "source_inferred_from_edge_direction",
                message: `Source was inferred from directed graph edges at node '${nodeId}'. Add explicit source/riser tagging in the graph if possible.`,
                nodeId,
            });
        }
    }
    if (result.size === 0) {
        findings.push({
            severity: "error",
            code: "no_source_found",
            message: "No source or riser node could be identified for fire flow orientation.",
        });
    }
    return [...result].sort();
}
function inferSourcesFromDirectedEdges(classified, edges) {
    const inDegree = new Map();
    const outDegree = new Map();
    for (const nodeId of classified.keys()) {
        inDegree.set(nodeId, 0);
        outDegree.set(nodeId, 0);
    }
    for (const edge of edges) {
        const direction = normalizeDirection(edge.edge.direction);
        if (direction === "fromTo") {
            outDegree.set(edge.fromNodeId, (outDegree.get(edge.fromNodeId) || 0) + 1);
            inDegree.set(edge.toNodeId, (inDegree.get(edge.toNodeId) || 0) + 1);
        }
        else if (direction === "toFrom") {
            outDegree.set(edge.toNodeId, (outDegree.get(edge.toNodeId) || 0) + 1);
            inDegree.set(edge.fromNodeId, (inDegree.get(edge.fromNodeId) || 0) + 1);
        }
    }
    return [...classified.values()]
        .filter((item) => !isTerminal(item))
        .filter((item) => (outDegree.get(item.id) || 0) > 0 && (inDegree.get(item.id) || 0) === 0)
        .map((item) => item.id)
        .sort();
}
function selectTerminalNodes(classified) {
    return [...classified.values()]
        .filter(isTerminal)
        .map((item) => item.id)
        .sort();
}
function detectCycles(nodeIds, adjacency) {
    const visited = new Set();
    const cycleEdges = new Set();
    function visit(nodeId, parentNodeId, parentEdgeId) {
        visited.add(nodeId);
        for (const next of adjacency.get(nodeId) || []) {
            if (next.edgeId === parentEdgeId && next.nodeId === parentNodeId)
                continue;
            if (visited.has(next.nodeId)) {
                cycleEdges.add(next.edgeId);
                continue;
            }
            visit(next.nodeId, nodeId, next.edgeId);
        }
    }
    for (const nodeId of nodeIds) {
        if (!visited.has(nodeId))
            visit(nodeId, null, null);
    }
    return [...cycleEdges].sort();
}
function validateComponents(components, classified, sourceNodeIds, terminalNodeIds, findings) {
    const sourceSet = new Set(sourceNodeIds);
    const terminalSet = new Set(terminalNodeIds);
    components.forEach((component, index) => {
        const componentId = `component-${index + 1}`;
        const sourceCount = component.nodeIds.filter((nodeId) => sourceSet.has(nodeId)).length;
        const terminalCount = component.nodeIds.filter((nodeId) => terminalSet.has(nodeId)).length;
        const valveCount = component.nodeIds.filter((nodeId) => hasRole(classified.get(nodeId), "valve")).length;
        if (terminalCount > 0 && sourceCount === 0) {
            findings.push({
                severity: "error",
                code: "terminal_component_without_source",
                message: `Component '${componentId}' has sprinkler/cabinet terminals but no source or riser.`,
                componentId,
            });
        }
        if (sourceCount > 0 && terminalCount > 0 && valveCount === 0) {
            findings.push({
                severity: "warning",
                code: "missing_control_valve",
                message: `Component '${componentId}' has fire terminals but no valve/accessory classified as a control or alarm valve.`,
                componentId,
            });
        }
        if (component.nodeIds.length === 1 && terminalCount === 1) {
            findings.push({
                severity: "error",
                code: "isolated_terminal",
                message: `Component '${componentId}' contains an isolated sprinkler/cabinet terminal.`,
                componentId,
                nodeId: component.nodeIds[0],
            });
        }
    });
}
function orientFromSources(sourceNodeIds, edges, adjacency, classified, findings) {
    const distance = new Map();
    const sourceForNode = new Map();
    const queue = [];
    for (const nodeId of classified.keys())
        distance.set(nodeId, Number.POSITIVE_INFINITY);
    for (const sourceNodeId of sourceNodeIds) {
        if (!classified.has(sourceNodeId))
            continue;
        distance.set(sourceNodeId, 0);
        sourceForNode.set(sourceNodeId, sourceNodeId);
        queue.push(sourceNodeId);
    }
    while (queue.length > 0) {
        const nodeId = queue.shift();
        const nodeDistance = distance.get(nodeId) || 0;
        for (const next of adjacency.get(nodeId) || []) {
            if ((distance.get(next.nodeId) || Number.POSITIVE_INFINITY) <= nodeDistance + 1)
                continue;
            distance.set(next.nodeId, nodeDistance + 1);
            sourceForNode.set(next.nodeId, sourceForNode.get(nodeId) || nodeId);
            queue.push(next.nodeId);
        }
    }
    for (const item of classified.values()) {
        const nodeDistance = distance.get(item.id);
        item.distanceFromSource = Number.isFinite(nodeDistance) ? nodeDistance : null;
        item.sourceNodeId = sourceForNode.get(item.id);
    }
    const outgoing = new Map();
    const orientedEdges = [];
    for (const edge of edges) {
        const fromDistance = distance.get(edge.fromNodeId) || Number.POSITIVE_INFINITY;
        const toDistance = distance.get(edge.toNodeId) || Number.POSITIVE_INFINITY;
        const graphDirection = normalizeDirection(edge.edge.direction);
        let orientedFromNodeId = null;
        let orientedToNodeId = null;
        let orientationStatus = "oriented";
        if (!Number.isFinite(fromDistance) || !Number.isFinite(toDistance)) {
            orientationStatus = "unreached";
            findings.push({
                severity: "warning",
                code: "edge_unreached_from_source",
                message: `Edge '${edge.id}' is not reachable from an identified source/riser.`,
                edgeId: edge.id,
            });
        }
        else if (fromDistance < toDistance) {
            orientedFromNodeId = edge.fromNodeId;
            orientedToNodeId = edge.toNodeId;
        }
        else if (toDistance < fromDistance) {
            orientedFromNodeId = edge.toNodeId;
            orientedToNodeId = edge.fromNodeId;
        }
        else {
            orientationStatus = "tie";
            findings.push({
                severity: "warning",
                code: "edge_orientation_tie",
                message: `Edge '${edge.id}' connects nodes at the same source distance and is not used for downstream count propagation.`,
                edgeId: edge.id,
            });
        }
        if (orientedFromNodeId && orientedToNodeId) {
            if (graphDirection === "ambiguous" || graphDirection === "unknown") {
                findings.push({
                    severity: "info",
                    code: "edge_direction_not_authoritative",
                    message: `Edge '${edge.id}' had ${graphDirection} graph direction; fire orientation used source distance.`,
                    edgeId: edge.id,
                });
            }
            else if (directionConflicts(edge, orientedFromNodeId, orientedToNodeId, graphDirection)) {
                findings.push({
                    severity: "warning",
                    code: "edge_direction_conflicts_with_source_orientation",
                    message: `Edge '${edge.id}' graph direction conflicts with source/riser orientation.`,
                    edgeId: edge.id,
                });
            }
            if (!outgoing.has(orientedFromNodeId))
                outgoing.set(orientedFromNodeId, []);
            outgoing.get(orientedFromNodeId)?.push(orientedToNodeId);
        }
        orientedEdges.push({
            edgeId: edge.id,
            fromNodeId: orientedFromNodeId,
            toNodeId: orientedToNodeId,
            sourceDistanceFrom: orientedFromNodeId ? distance.get(orientedFromNodeId) : null,
            sourceDistanceTo: orientedToNodeId ? distance.get(orientedToNodeId) : null,
            orientationStatus,
            graphDirection: edge.edge.direction || "unknown",
            kind: edge.edge.kind || "physical",
            systemClassification: edge.edge.systemClassification || null,
        });
    }
    for (const [nodeId, children] of outgoing.entries()) {
        outgoing.set(nodeId, [...new Set(children)].sort());
    }
    return { outgoing, orientedEdges };
}
function normalizeDirection(value) {
    const normalized = normalizeKey(String(value || ""));
    if (normalized === "fromto")
        return "fromTo";
    if (normalized === "tofrom")
        return "toFrom";
    if (normalized === "bidirectional")
        return "bidirectional";
    if (normalized === "ambiguous")
        return "ambiguous";
    return "unknown";
}
function directionConflicts(edge, orientedFromNodeId, orientedToNodeId, graphDirection) {
    if (graphDirection === "fromTo") {
        return edge.fromNodeId !== orientedFromNodeId || edge.toNodeId !== orientedToNodeId;
    }
    if (graphDirection === "toFrom") {
        return edge.toNodeId !== orientedFromNodeId || edge.fromNodeId !== orientedToNodeId;
    }
    return false;
}
function applyDownstreamCounts(classified, outgoing) {
    const terminalSets = new Map();
    const ordered = [...classified.values()].sort((a, b) => {
        const aDistance = a.distanceFromSource ?? Number.POSITIVE_INFINITY;
        const bDistance = b.distanceFromSource ?? Number.POSITIVE_INFINITY;
        return bDistance - aDistance || a.id.localeCompare(b.id);
    });
    for (const item of ordered) {
        const downstream = new Set();
        if (isTerminal(item))
            downstream.add(item.id);
        for (const childId of outgoing.get(item.id) || []) {
            const childSet = terminalSets.get(childId);
            if (childSet) {
                for (const terminalId of childSet)
                    downstream.add(terminalId);
            }
        }
        terminalSets.set(item.id, downstream);
    }
    for (const item of classified.values()) {
        const terminalIds = terminalSets.get(item.id) || new Set();
        item.downstreamSprinklerCount = [...terminalIds].filter((nodeId) => hasRole(classified.get(nodeId), "sprinkler")).length;
        item.downstreamCabinetCount = [...terminalIds].filter((nodeId) => hasRole(classified.get(nodeId), "cabinet")).length;
    }
}
function markBranchMains(classified) {
    for (const item of classified.values()) {
        if (!hasRole(item, "pipe"))
            continue;
        const downstreamTotal = item.downstreamSprinklerCount + item.downstreamCabinetCount;
        if (item.degree >= 3 || downstreamTotal >= 3) {
            item.primaryRole = "branchMain";
            if (!item.roleTags.includes("branchMain"))
                item.roleTags.push("branchMain");
            item.roleTags.sort();
        }
    }
}
function buildSizingAudit(classified, sizingSchedule) {
    return [...classified.values()]
        .filter((item) => hasRole(item, "pipe") || hasRole(item, "branchMain"))
        .sort(compareById)
        .map((item) => {
        const sprinklerDiameter = lookupDiameter(item.downstreamSprinklerCount, sizingSchedule.sprinkler);
        const cabinetDiameter = lookupDiameter(item.downstreamCabinetCount, sizingSchedule.cabinet);
        const requiredDiameterMm = Math.max(sprinklerDiameter || 0, cabinetDiameter || 0);
        const currentDiameterMm = readDiameterMm(item.node);
        let status = "not_applicable";
        if (requiredDiameterMm > 0 && currentDiameterMm == null) {
            status = "missing_diameter";
        }
        else if (requiredDiameterMm > 0 && currentDiameterMm != null && currentDiameterMm + 0.5 < requiredDiameterMm) {
            status = "undersized_schematic";
        }
        else if (requiredDiameterMm > 0) {
            status = "ok";
        }
        return {
            nodeId: item.id,
            elementId: item.node.elementId ?? null,
            primaryRole: item.primaryRole,
            downstreamSprinklerCount: item.downstreamSprinklerCount,
            downstreamCabinetCount: item.downstreamCabinetCount,
            currentDiameterMm,
            requiredDiameterMm: requiredDiameterMm || null,
            status,
            auditBasis: "count-based schematic only; not hydraulic approval",
        };
    });
}
function lookupDiameter(count, rules) {
    if (count <= 0)
        return null;
    const rule = rules.find((candidate) => count <= candidate.maxCount);
    return rule?.diameterMm || null;
}
function buildReducerReport(classified, edges, adjacency, findings) {
    const transitions = [];
    for (const edge of edges) {
        const from = classified.get(edge.fromNodeId);
        const to = classified.get(edge.toNodeId);
        if (!from || !to)
            continue;
        const fromDiameter = readDiameterMm(from.node);
        const toDiameter = readDiameterMm(to.node);
        if (fromDiameter == null || toDiameter == null)
            continue;
        if (Math.abs(fromDiameter - toDiameter) < 0.5)
            continue;
        const hasReducerEndpoint = hasRole(from, "reducer") || hasRole(to, "reducer");
        const bothPipeSegments = hasRole(from, "pipe") && hasRole(to, "pipe");
        let status = hasReducerEndpoint ? "reducer_present" : "diameter_transition";
        if (bothPipeSegments && !hasReducerEndpoint) {
            status = "missing_reducer";
            findings.push({
                severity: "warning",
                code: "missing_reducer_between_pipe_segments",
                message: `Pipe diameter changes from ${fromDiameter} mm to ${toDiameter} mm on edge '${edge.id}' without a reducer node.`,
                edgeId: edge.id,
            });
        }
        transitions.push({
            edgeId: edge.id,
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId,
            fromDiameterMm: fromDiameter,
            toDiameterMm: toDiameter,
            status,
        });
    }
    for (const item of classified.values()) {
        if (!hasRole(item, "reducer") && !hasRole(item, "fitting"))
            continue;
        const neighboringPipeDiameters = (adjacency.get(item.id) || [])
            .map((next) => classified.get(next.nodeId))
            .filter((next) => Boolean(next))
            .filter((next) => hasRole(next, "pipe") || hasRole(next, "branchMain"))
            .map((next) => readDiameterMm(next.node))
            .filter((value) => typeof value === "number");
        const distinct = [...new Set(neighboringPipeDiameters.map((value) => Math.round(value * 10) / 10))].sort((a, b) => a - b);
        if (distinct.length < 2)
            continue;
        if (hasRole(item, "reducer")) {
            transitions.push({
                reducerNodeId: item.id,
                connectedPipeDiametersMm: distinct,
                status: "reducer_present",
            });
        }
        else {
            findings.push({
                severity: "warning",
                code: "diameter_transition_without_reducer_role",
                message: `Fitting '${item.id}' connects different pipe diameters but is not classified as a reducer.`,
                nodeId: item.id,
            });
            transitions.push({
                fittingNodeId: item.id,
                connectedPipeDiametersMm: distinct,
                status: "diameter_transition_without_reducer_role",
            });
        }
    }
    return {
        transitions: transitions.sort((a, b) => String(a.edgeId || a.reducerNodeId || a.fittingNodeId).localeCompare(String(b.edgeId || b.reducerNodeId || b.fittingNodeId))),
    };
}
function buildMissingHydraulicInputs(graph, classified) {
    const findings = [];
    const hasSprinklers = [...classified.values()].some((item) => hasRole(item, "sprinkler"));
    const hasCabinets = [...classified.values()].some((item) => hasRole(item, "cabinet"));
    if (hasSprinklers && readGlobalProperty(graph, DESIGN_DENSITY_KEYS) == null) {
        findings.push({
            severity: "warning",
            code: "missing_design_density",
            message: "Design density is missing from graph metadata/properties.",
        });
    }
    if (hasSprinklers && readGlobalProperty(graph, REMOTE_AREA_KEYS) == null) {
        findings.push({
            severity: "warning",
            code: "missing_remote_area",
            message: "Remote area definition is missing from graph metadata/properties.",
        });
    }
    if (hasCabinets && readGlobalProperty(graph, HOSE_ALLOWANCE_KEYS) == null) {
        findings.push({
            severity: "warning",
            code: "missing_hose_allowance",
            message: "Hose allowance is missing from graph metadata/properties.",
        });
    }
    const globalCFactor = readGlobalNumericProperty(graph, C_FACTOR_KEYS);
    for (const item of classified.values()) {
        const downstreamTotal = item.downstreamSprinklerCount + item.downstreamCabinetCount;
        const inHydraulicPath = downstreamTotal > 0 || isTerminal(item);
        if (hasRole(item, "sprinkler") && readNumericProperty(item.node, K_FACTOR_KEYS) == null) {
            findings.push({
                severity: "warning",
                code: "missing_k_factor",
                message: `Sprinkler '${item.id}' is missing K-factor data.`,
                nodeId: item.id,
            });
        }
        if (inHydraulicPath && readElevationMm(item.node) == null) {
            findings.push({
                severity: "warning",
                code: "missing_elevation",
                message: `Node '${item.id}' is missing elevation data needed by a hydraulic solver.`,
                nodeId: item.id,
            });
        }
        if (inHydraulicPath && (hasRole(item, "pipe") || hasRole(item, "branchMain")) && globalCFactor == null && readNumericProperty(item.node, C_FACTOR_KEYS) == null) {
            findings.push({
                severity: "warning",
                code: "missing_c_factor",
                message: `Pipe '${item.id}' is missing Hazen-Williams C-factor data.`,
                nodeId: item.id,
            });
        }
        if (inHydraulicPath && requiresEquivalentLength(item) && readEquivalentLengthMm(item.node) == null) {
            findings.push({
                severity: "warning",
                code: "missing_equivalent_length",
                message: `Node '${item.id}' is missing equivalent length data.`,
                nodeId: item.id,
            });
        }
    }
    return findings.sort(compareFindings);
}
function requiresEquivalentLength(item) {
    return hasRole(item, "pipe")
        || hasRole(item, "branchMain")
        || hasRole(item, "fitting")
        || hasRole(item, "reducer")
        || hasRole(item, "valve");
}
function buildSolverAdapter(graph, classified, orientedEdges, missingHydraulicInputs) {
    const nodePayload = [...classified.values()].sort(compareById).map((item) => ({
        id: item.id,
        role: item.primaryRole,
        elevationMm: readElevationMm(item.node),
        downstreamSprinklerCount: item.downstreamSprinklerCount,
        downstreamCabinetCount: item.downstreamCabinetCount,
        demandPlaceholder: isTerminal(item)
            ? {
                type: hasRole(item, "sprinkler") ? "sprinkler" : "cabinet",
                kFactor: readNumericProperty(item.node, K_FACTOR_KEYS),
                hoseAllowance: readGlobalNumericProperty(graph, HOSE_ALLOWANCE_KEYS),
                designDensity: readGlobalNumericProperty(graph, DESIGN_DENSITY_KEYS),
            }
            : null,
    }));
    const nodeById = new Map([...classified.values()].map((item) => [item.id, item]));
    const links = orientedEdges
        .filter((edge) => edge.orientationStatus === "oriented" && edge.fromNodeId && edge.toNodeId)
        .map((edge) => {
        const from = nodeById.get(String(edge.fromNodeId));
        const to = nodeById.get(String(edge.toNodeId));
        return {
            id: edge.edgeId,
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId,
            diameterMm: readDiameterMm(from?.node) ?? readDiameterMm(to?.node),
            lengthMm: readEquivalentLengthMm(to?.node) ?? readEquivalentLengthMm(from?.node),
            cFactor: readNumericProperty(from?.node, C_FACTOR_KEYS) ?? readGlobalNumericProperty(graph, C_FACTOR_KEYS),
            status: "placeholder",
        };
    });
    return {
        schemaVersion: FIRE_SOLVER_ADAPTER_SCHEMA_VERSION,
        label: "audit/schematic",
        status: missingHydraulicInputs.length > 0 ? "not_ready_missing_hydraulic_inputs" : "schematic_ready_for_solver_mapping",
        targetSolvers: ["EPANET", "WNTR", "SprayHydraulic"],
        hydraulicApproval: false,
        nodes: nodePayload,
        links,
        missingInputs: missingHydraulicInputs.map((finding) => ({
            code: finding.code,
            nodeId: finding.nodeId || null,
            edgeId: finding.edgeId || null,
        })),
    };
}
function summarizeNode(item) {
    if (!item)
        return null;
    return {
        nodeId: item.id,
        elementId: item.node.elementId ?? null,
        primaryRole: item.primaryRole,
        roleTags: item.roleTags,
        familyName: item.node.familyName || null,
        typeName: item.node.typeName || null,
    };
}
function summarizeComponent(component, index, classified, sourceNodeIds) {
    const sourceSet = new Set(sourceNodeIds);
    return {
        componentId: `component-${index + 1}`,
        nodeCount: component.nodeIds.length,
        edgeCount: component.edgeIds.length,
        sourceNodeIds: component.nodeIds.filter((nodeId) => sourceSet.has(nodeId)),
        sprinklerCount: component.nodeIds.filter((nodeId) => hasRole(classified.get(nodeId), "sprinkler")).length,
        cabinetCount: component.nodeIds.filter((nodeId) => hasRole(classified.get(nodeId), "cabinet")).length,
        valveCount: component.nodeIds.filter((nodeId) => hasRole(classified.get(nodeId), "valve")).length,
    };
}
function readDiameterMm(node) {
    if (!node)
        return null;
    const engineering = node.engineering || {};
    const value = engineering.diameterMm ?? engineering.DiameterMm ?? readProperty(node, ["diameterMm", "diameter", "dnMm", "nominalDiameterMm"]);
    return numeric(value);
}
function readEquivalentLengthMm(node) {
    if (!node)
        return null;
    const propertyValue = readNumericProperty(node, EQUIVALENT_LENGTH_KEYS);
    if (propertyValue != null)
        return propertyValue;
    const engineering = node.engineering || {};
    return numeric(engineering.lengthMm ?? engineering.LengthMm);
}
function readElevationMm(node) {
    if (!node)
        return null;
    const direct = numeric(node.elevationMm);
    if (direct != null)
        return direct;
    for (const connector of node.connectors || []) {
        const z = numeric(connector.origin?.z);
        if (z != null)
            return z;
    }
    return null;
}
function numeric(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const parsed = Number(value.replace(",", ".").replace(/[^0-9.+-]/g, ""));
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function isTerminal(item) {
    return Boolean(item && (hasRole(item, "sprinkler") || hasRole(item, "cabinet")));
}
function hasRole(item, role) {
    return Boolean(item?.roleTags.includes(role));
}
function compareById(a, b) {
    return a.id.localeCompare(b.id);
}
function compareFindings(a, b) {
    const severityRank = { error: 0, warning: 1, info: 2 };
    return severityRank[a.severity] - severityRank[b.severity]
        || a.code.localeCompare(b.code)
        || String(a.nodeId || "").localeCompare(String(b.nodeId || ""))
        || String(a.edgeId || "").localeCompare(String(b.edgeId || ""));
}
