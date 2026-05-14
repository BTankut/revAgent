export const CONNECTOR_GRAPH_SCHEMA_VERSION = "mep.connector-graph.v1";
export const FIRE_AUDIT_SCHEMA_VERSION = "mep.fire-piping-audit.v1";
export const FIRE_SOLVER_ADAPTER_SCHEMA_VERSION = "mep.fire-solver-adapter.v0";

type Severity = "info" | "warning" | "error";
type NodeRole =
    | "source"
    | "riser"
    | "sprinkler"
    | "cabinet"
    | "valve"
    | "pipe"
    | "fitting"
    | "reducer"
    | "branchMain"
    | "unknown";

interface ConnectorGraphDocument {
    schemaVersion?: string;
    metadata?: Record<string, unknown>;
    units?: Record<string, unknown>;
    nodes?: ConnectorGraphNode[];
    edges?: ConnectorGraphEdge[];
    topology?: Record<string, unknown>;
}

interface ConnectorGraphNode {
    id?: string;
    elementId?: number;
    uniqueId?: string;
    category?: string;
    familyName?: string;
    typeName?: string;
    systemClassification?: string;
    systemName?: string;
    systemType?: string;
    levelName?: string;
    elevationMm?: number;
    engineering?: Record<string, unknown>;
    connectors?: ConnectorPort[];
    properties?: Record<string, unknown>;
}

interface ConnectorPort {
    id?: string;
    ownerNodeId?: string;
    ownerElementId?: number;
    ownerUniqueId?: string;
    connectorIndex?: number;
    domain?: string;
    origin?: Point3D;
    direction?: Point3D;
    flowDirection?: string;
    isConnectionExpected?: boolean;
    systemClassification?: string;
    properties?: Record<string, unknown>;
}

interface ConnectorGraphEdge {
    id?: string;
    fromNodeId?: string;
    fromConnectorId?: string;
    toNodeId?: string;
    toConnectorId?: string;
    direction?: string;
    kind?: string;
    domain?: string;
    systemClassification?: string;
    properties?: Record<string, unknown>;
}

interface Point3D {
    x?: number;
    y?: number;
    z?: number;
}

interface FireAuditOptions {
    sourceNodeIds?: string[];
    includeSolverAdapter?: boolean;
    sizingSchedule?: Partial<FireSizingSchedule>;
}

interface FireSizingSchedule {
    sprinkler: CountDiameterRule[];
    cabinet: CountDiameterRule[];
}

interface CountDiameterRule {
    maxCount: number;
    diameterMm: number;
}

interface FireAuditFinding {
    severity: Severity;
    code: string;
    message: string;
    nodeId?: string;
    connectorId?: string;
    edgeId?: string;
    componentId?: string;
}

interface ClassifiedNode {
    node: ConnectorGraphNode;
    id: string;
    primaryRole: NodeRole;
    roleTags: NodeRole[];
    searchText: string;
    degree: number;
    componentId?: string;
    sourceNodeId?: string;
    distanceFromSource?: number | null;
    downstreamSprinklerCount: number;
    downstreamCabinetCount: number;
}

interface NormalizedEdge {
    edge: ConnectorGraphEdge;
    id: string;
    fromNodeId: string;
    toNodeId: string;
    fromConnectorId?: string;
    toConnectorId?: string;
}

interface OrientedFireEdge {
    edgeId: string;
    fromNodeId: string | null;
    toNodeId: string | null;
    sourceDistanceFrom: number | null;
    sourceDistanceTo: number | null;
    orientationStatus: string;
    graphDirection: unknown;
    kind: unknown;
    systemClassification: string | null;
}

const DEFAULT_SIZING_SCHEDULE: FireSizingSchedule = {
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

export function createFirePipingTopologyAudit(
    rawGraph: ConnectorGraphDocument,
    options: FireAuditOptions = {},
) {
    const graph = normalizeGraph(rawGraph);
    const findings: FireAuditFinding[] = [];
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
    const nodeById = new Map<string, ConnectorGraphNode>();
    const connectorToNode = new Map<string, string>();
    const connectedConnectorIds = new Set<string>();

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

    const normalizedEdges: NormalizedEdge[] = [];
    const adjacency = createAdjacency([...nodeById.keys()]);

    for (const edge of edges) {
        const normalized = normalizeEdge(edge, connectorToNode, normalizedEdges.length + 1);
        if (edge.fromConnectorId) connectedConnectorIds.add(edge.fromConnectorId);
        if (edge.toConnectorId) connectedConnectorIds.add(edge.toConnectorId);

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

    const classified = new Map<string, ClassifiedNode>();
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
    const componentByNode = new Map<string, string>();
    components.forEach((component, index) => {
        const componentId = `component-${index + 1}`;
        for (const nodeId of component.nodeIds) {
            componentByNode.set(nodeId, componentId);
            const item = classified.get(nodeId);
            if (item) item.componentId = componentId;
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

    const orientation = orientFromSources(
        sourceNodeIds,
        normalizedEdges,
        adjacency,
        classified,
        findings,
    );

    applyDownstreamCounts(classified, orientation.outgoing);
    markBranchMains(classified);

    const sizingAudit = buildSizingAudit(classified, sizingSchedule);
    const reducerReport = buildReducerReport(classified, normalizedEdges, adjacency, findings);
    const missingHydraulicInputs = buildMissingHydraulicInputs(graph, classified);
    for (const finding of missingHydraulicInputs) findings.push(finding);

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

function normalizeGraph(rawGraph: ConnectorGraphDocument): ConnectorGraphDocument {
    const graph = rawGraph || {};
    return {
        ...graph,
        metadata: graph.metadata || {},
        nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
        edges: Array.isArray(graph.edges) ? graph.edges : [],
    };
}

function mergeSizingSchedule(partial?: Partial<FireSizingSchedule>): FireSizingSchedule {
    return {
        sprinkler: normalizeRules(partial?.sprinkler, DEFAULT_SIZING_SCHEDULE.sprinkler),
        cabinet: normalizeRules(partial?.cabinet, DEFAULT_SIZING_SCHEDULE.cabinet),
    };
}

function normalizeRules(rules: CountDiameterRule[] | undefined, fallback: CountDiameterRule[]): CountDiameterRule[] {
    const source = Array.isArray(rules) && rules.length > 0 ? rules : fallback;
    return source
        .filter((rule) => Number.isFinite(rule.maxCount) || rule.maxCount === Number.POSITIVE_INFINITY)
        .filter((rule) => Number.isFinite(rule.diameterMm) && rule.diameterMm > 0)
        .sort((a, b) => a.maxCount - b.maxCount);
}

function safeId(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeEdge(
    edge: ConnectorGraphEdge,
    connectorToNode: Map<string, string>,
    ordinal: number,
): NormalizedEdge {
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

function createAdjacency(nodeIds: string[]) {
    const adjacency = new Map<string, { nodeId: string; edgeId: string }[]>();
    for (const nodeId of nodeIds) adjacency.set(nodeId, []);
    return adjacency;
}

function addUndirected(
    adjacency: Map<string, { nodeId: string; edgeId: string }[]>,
    a: string,
    b: string,
    edgeId: string,
) {
    if (!a || !b || a === b) return;
    adjacency.get(a)?.push({ nodeId: b, edgeId });
    adjacency.get(b)?.push({ nodeId: a, edgeId });
}

function classifyNode(node: ConnectorGraphNode): { primaryRole: NodeRole; roleTags: NodeRole[]; searchText: string } {
    const text = nodeSearchText(node);
    const identityText = nodeIdentityText(node);
    const tags = new Set<NodeRole>();
    const explicitRole = normalizeText(readProperty(node, ["fireRole", "role", "mepRole"]));

    if (containsAny(explicitRole, ["source", "feed", "supply"])) tags.add("source");
    if (containsAny(explicitRole, ["riser", "standpipe", "kolon"])) tags.add("riser");
    if (containsAny(explicitRole, ["sprinkler"])) tags.add("sprinkler");
    if (containsAny(explicitRole, ["cabinet", "hose"])) tags.add("cabinet");
    if (containsAny(explicitRole, ["valve", "vana"])) tags.add("valve");
    if (containsAny(explicitRole, ["reducer", "transition"])) tags.add("reducer");

    const isFireSystem = containsAny(text, ["fire", "sprinkler", "yangin", "standpipe", "hose", "cabinet"]);
    if (containsAny(identityText, ["sprinkler", "pendent", "upright", "sidewall", "concealed head"])) tags.add("sprinkler");
    if (containsAny(identityText, ["fire hose cabinet", "hose cabinet", "fire cabinet", "yangin dolabi", "fhc"])) tags.add("cabinet");
    if (containsAny(identityText, ["riser", "standpipe", "kolon", "vertical main"])) tags.add("riser");
    if (containsAny(identityText, ["fire pump", "water tank", "fire water source", "supply source"]) || (isFireSystem && containsAny(identityText, ["pump"]))) tags.add("source");
    if (containsAny(identityText, ["valve", "vana", "alarm check", "zone control", "test and drain", "check valve"])) tags.add("valve");
    if (containsAny(identityText, ["reducer", "reducing", "transition", "concentric", "eccentric"])) tags.add("reducer");
    if (containsAny(identityText, ["pipe fitting", "tee", "elbow", "coupling"])) tags.add("fitting");

    const categoryText = normalizeText(node.category);
    const familyTypeText = normalizeText([node.familyName, node.typeName].filter(Boolean).join(" "));
    const familyTypeLooksLikePipe = containsAny(familyTypeText, ["pipe"])
        && !containsAny(familyTypeText, ["fitting", "valve", "reducer", "cabinet", "sprinkler"]);
    if (categoryText === "pipes" || familyTypeLooksLikePipe) tags.add("pipe");

    if (tags.has("reducer")) tags.add("fitting");
    if (tags.has("cabinet") && tags.has("valve")) tags.delete("valve");

    const priority: NodeRole[] = ["source", "riser", "sprinkler", "cabinet", "reducer", "valve", "pipe", "fitting"];
    const primaryRole = priority.find((role) => tags.has(role)) || "unknown";
    return {
        primaryRole,
        roleTags: tags.size > 0 ? [...tags].sort() : ["unknown"],
        searchText: text,
    };
}

function nodeSearchText(node: ConnectorGraphNode): string {
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

function nodeIdentityText(node: ConnectorGraphNode): string {
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

function normalizeText(value: unknown): string {
    return String(value || "")
        .replace(/\u0131/g, "i")
        .replace(/\u0130/g, "i")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function containsAny(text: string, tokens: string[]): boolean {
    return tokens.some((token) => text.includes(normalizeText(token)));
}

function normalizeKey(value: string): string {
    return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function readProperty(source: { properties?: Record<string, unknown> } | undefined, aliases: string[]): unknown {
    const properties = source?.properties || {};
    const aliasSet = new Set(aliases.map(normalizeKey));
    for (const [key, value] of Object.entries(properties)) {
        if (aliasSet.has(normalizeKey(key))) return value;
    }
    return undefined;
}

function readNumericProperty(source: { properties?: Record<string, unknown> } | undefined, aliases: string[]): number | null {
    const value = readProperty(source, aliases);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value.replace(",", ".").replace(/[^0-9.+-]/g, ""));
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function readGlobalProperty(graph: ConnectorGraphDocument, aliases: string[]): unknown {
    return readProperty(graph.metadata as { properties?: Record<string, unknown> }, aliases);
}

function readGlobalNumericProperty(graph: ConnectorGraphDocument, aliases: string[]): number | null {
    return readNumericProperty(graph.metadata as { properties?: Record<string, unknown> }, aliases);
}

function collectOpenEnds(
    nodes: ConnectorGraphNode[],
    connectedConnectorIds: Set<string>,
    findings: FireAuditFinding[],
) {
    const openEnds = [];
    for (const node of nodes) {
        const nodeId = safeId(node.id);
        for (const connector of node.connectors || []) {
            const connectorId = safeId(connector.id);
            if (!connectorId || connector.isConnectionExpected === false) continue;
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

function findComponents(
    nodeIds: string[],
    adjacency: Map<string, { nodeId: string; edgeId: string }[]>,
) {
    const visited = new Set<string>();
    const components: { nodeIds: string[]; edgeIds: string[] }[] = [];
    for (const start of nodeIds.sort()) {
        if (visited.has(start)) continue;
        const nodeSet = new Set<string>();
        const edgeSet = new Set<string>();
        const queue = [start];
        visited.add(start);
        let head = 0;
        while (head < queue.length) {
            const nodeId = queue[head++] as string;
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

function selectSourceNodes(
    options: FireAuditOptions,
    classified: Map<string, ClassifiedNode>,
    edges: NormalizedEdge[],
    findings: FireAuditFinding[],
): string[] {
    const result = new Set<string>();
    for (const nodeId of options.sourceNodeIds || []) {
        if (classified.has(nodeId)) {
            result.add(nodeId);
        } else {
            findings.push({
                severity: "warning",
                code: "source_node_missing",
                message: `Requested source node '${nodeId}' is not present in the graph.`,
                nodeId,
            });
        }
    }

    for (const item of classified.values()) {
        if (hasRole(item, "source") || hasRole(item, "riser")) result.add(item.id);
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

function inferSourcesFromDirectedEdges(classified: Map<string, ClassifiedNode>, edges: NormalizedEdge[]): string[] {
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const nodeId of classified.keys()) {
        inDegree.set(nodeId, 0);
        outDegree.set(nodeId, 0);
    }

    for (const edge of edges) {
        const direction = normalizeDirection(edge.edge.direction);
        if (direction === "fromTo") {
            outDegree.set(edge.fromNodeId, (outDegree.get(edge.fromNodeId) || 0) + 1);
            inDegree.set(edge.toNodeId, (inDegree.get(edge.toNodeId) || 0) + 1);
        } else if (direction === "toFrom") {
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

function selectTerminalNodes(classified: Map<string, ClassifiedNode>): string[] {
    return [...classified.values()]
        .filter(isTerminal)
        .map((item) => item.id)
        .sort();
}

function detectCycles(
    nodeIds: string[],
    adjacency: Map<string, { nodeId: string; edgeId: string }[]>,
): string[] {
    const visited = new Set<string>();
    const cycleEdges = new Set<string>();

    function visit(nodeId: string, parentNodeId: string | null, parentEdgeId: string | null) {
        visited.add(nodeId);
        for (const next of adjacency.get(nodeId) || []) {
            if (next.edgeId === parentEdgeId && next.nodeId === parentNodeId) continue;
            if (visited.has(next.nodeId)) {
                cycleEdges.add(next.edgeId);
                continue;
            }
            visit(next.nodeId, nodeId, next.edgeId);
        }
    }

    for (const nodeId of nodeIds) {
        if (!visited.has(nodeId)) visit(nodeId, null, null);
    }
    return [...cycleEdges].sort();
}

function validateComponents(
    components: { nodeIds: string[]; edgeIds: string[] }[],
    classified: Map<string, ClassifiedNode>,
    sourceNodeIds: string[],
    terminalNodeIds: string[],
    findings: FireAuditFinding[],
) {
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

function orientFromSources(
    sourceNodeIds: string[],
    edges: NormalizedEdge[],
    adjacency: Map<string, { nodeId: string; edgeId: string }[]>,
    classified: Map<string, ClassifiedNode>,
    findings: FireAuditFinding[],
) {
    const distance = new Map<string, number>();
    const sourceForNode = new Map<string, string>();
    const queue: string[] = [];

    for (const nodeId of classified.keys()) distance.set(nodeId, Number.POSITIVE_INFINITY);
    for (const sourceNodeId of sourceNodeIds) {
        if (!classified.has(sourceNodeId)) continue;
        distance.set(sourceNodeId, 0);
        sourceForNode.set(sourceNodeId, sourceNodeId);
        queue.push(sourceNodeId);
    }

    let head = 0;
    while (head < queue.length) {
        const nodeId = queue[head++] as string;
        const nodeDistance = distance.get(nodeId) ?? 0;
        for (const next of adjacency.get(nodeId) || []) {
            if ((distance.get(next.nodeId) ?? Number.POSITIVE_INFINITY) <= nodeDistance + 1) continue;
            distance.set(next.nodeId, nodeDistance + 1);
            sourceForNode.set(next.nodeId, sourceForNode.get(nodeId) ?? nodeId);
            queue.push(next.nodeId);
        }
    }

    for (const item of classified.values()) {
        const nodeDistance = distance.get(item.id);
        item.distanceFromSource = Number.isFinite(nodeDistance) ? nodeDistance as number : null;
        item.sourceNodeId = sourceForNode.get(item.id);
    }

    const outgoing = new Map<string, string[]>();
    const orientedEdges: OrientedFireEdge[] = [];

    for (const edge of edges) {
        const fromDistance = distance.get(edge.fromNodeId) ?? Number.POSITIVE_INFINITY;
        const toDistance = distance.get(edge.toNodeId) ?? Number.POSITIVE_INFINITY;
        const graphDirection = normalizeDirection(edge.edge.direction);

        let orientedFromNodeId: string | null = null;
        let orientedToNodeId: string | null = null;
        let orientationStatus = "oriented";

        if (!Number.isFinite(fromDistance) || !Number.isFinite(toDistance)) {
            orientationStatus = "unreached";
            findings.push({
                severity: "warning",
                code: "edge_unreached_from_source",
                message: `Edge '${edge.id}' is not reachable from an identified source/riser.`,
                edgeId: edge.id,
            });
        } else if (fromDistance < toDistance) {
            orientedFromNodeId = edge.fromNodeId;
            orientedToNodeId = edge.toNodeId;
        } else if (toDistance < fromDistance) {
            orientedFromNodeId = edge.toNodeId;
            orientedToNodeId = edge.fromNodeId;
        } else {
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
            } else if (directionConflicts(edge, orientedFromNodeId, orientedToNodeId, graphDirection)) {
                findings.push({
                    severity: "warning",
                    code: "edge_direction_conflicts_with_source_orientation",
                    message: `Edge '${edge.id}' graph direction conflicts with source/riser orientation.`,
                    edgeId: edge.id,
                });
            }
            if (!outgoing.has(orientedFromNodeId)) outgoing.set(orientedFromNodeId, []);
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

function normalizeDirection(value: unknown): "fromTo" | "toFrom" | "bidirectional" | "ambiguous" | "unknown" {
    const normalized = normalizeKey(String(value || ""));
    if (normalized === "fromto") return "fromTo";
    if (normalized === "tofrom") return "toFrom";
    if (normalized === "bidirectional") return "bidirectional";
    if (normalized === "ambiguous") return "ambiguous";
    return "unknown";
}

function directionConflicts(
    edge: NormalizedEdge,
    orientedFromNodeId: string,
    orientedToNodeId: string,
    graphDirection: string,
) {
    if (graphDirection === "fromTo") {
        return edge.fromNodeId !== orientedFromNodeId || edge.toNodeId !== orientedToNodeId;
    }
    if (graphDirection === "toFrom") {
        return edge.toNodeId !== orientedFromNodeId || edge.fromNodeId !== orientedToNodeId;
    }
    return false;
}

function applyDownstreamCounts(
    classified: Map<string, ClassifiedNode>,
    outgoing: Map<string, string[]>,
) {
    const countsByNodeId = new Map<string, { sprinkler: number; cabinet: number }>();
    const ordered = [...classified.values()].sort((a, b) => {
        const aDistance = a.distanceFromSource ?? Number.POSITIVE_INFINITY;
        const bDistance = b.distanceFromSource ?? Number.POSITIVE_INFINITY;
        return bDistance - aDistance || a.id.localeCompare(b.id);
    });

    for (const item of ordered) {
        const counts = {
            sprinkler: hasRole(item, "sprinkler") ? 1 : 0,
            cabinet: hasRole(item, "cabinet") ? 1 : 0,
        };
        for (const childId of outgoing.get(item.id) || []) {
            const childCounts = countsByNodeId.get(childId);
            if (childCounts) {
                counts.sprinkler += childCounts.sprinkler;
                counts.cabinet += childCounts.cabinet;
            }
        }
        countsByNodeId.set(item.id, counts);
    }

    for (const item of classified.values()) {
        const counts = countsByNodeId.get(item.id) || { sprinkler: 0, cabinet: 0 };
        item.downstreamSprinklerCount = counts.sprinkler;
        item.downstreamCabinetCount = counts.cabinet;
    }
}

function markBranchMains(classified: Map<string, ClassifiedNode>) {
    for (const item of classified.values()) {
        if (!hasRole(item, "pipe")) continue;
        const downstreamTotal = item.downstreamSprinklerCount + item.downstreamCabinetCount;
        if (item.degree >= 3 || downstreamTotal >= 3) {
            item.primaryRole = "branchMain";
            if (!item.roleTags.includes("branchMain")) item.roleTags.push("branchMain");
            item.roleTags.sort();
        }
    }
}

function buildSizingAudit(
    classified: Map<string, ClassifiedNode>,
    sizingSchedule: FireSizingSchedule,
) {
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
            } else if (requiredDiameterMm > 0 && currentDiameterMm != null && currentDiameterMm + 0.5 < requiredDiameterMm) {
                status = "undersized_schematic";
            } else if (requiredDiameterMm > 0) {
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

function lookupDiameter(count: number, rules: CountDiameterRule[]): number | null {
    if (count <= 0) return null;
    const rule = rules.find((candidate) => count <= candidate.maxCount);
    return rule?.diameterMm || null;
}

function buildReducerReport(
    classified: Map<string, ClassifiedNode>,
    edges: NormalizedEdge[],
    adjacency: Map<string, { nodeId: string; edgeId: string }[]>,
    findings: FireAuditFinding[],
) {
    const transitions = [];

    for (const edge of edges) {
        const from = classified.get(edge.fromNodeId);
        const to = classified.get(edge.toNodeId);
        if (!from || !to) continue;
        const fromDiameter = readDiameterMm(from.node);
        const toDiameter = readDiameterMm(to.node);
        if (fromDiameter == null || toDiameter == null) continue;
        if (Math.abs(fromDiameter - toDiameter) < 0.5) continue;

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
        if (!hasRole(item, "reducer") && !hasRole(item, "fitting")) continue;
        const neighboringPipeDiameters = (adjacency.get(item.id) || [])
            .map((next) => classified.get(next.nodeId))
            .filter((next): next is ClassifiedNode => Boolean(next))
            .filter((next) => hasRole(next, "pipe") || hasRole(next, "branchMain"))
            .map((next) => readDiameterMm(next.node))
            .filter((value): value is number => typeof value === "number");
        const distinct = [...new Set(neighboringPipeDiameters.map((value) => Math.round(value * 10) / 10))].sort((a, b) => a - b);
        if (distinct.length < 2) continue;

        if (hasRole(item, "reducer")) {
            transitions.push({
                reducerNodeId: item.id,
                connectedPipeDiametersMm: distinct,
                status: "reducer_present",
            });
        } else {
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

function buildMissingHydraulicInputs(
    graph: ConnectorGraphDocument,
    classified: Map<string, ClassifiedNode>,
): FireAuditFinding[] {
    const findings: FireAuditFinding[] = [];
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

function requiresEquivalentLength(item: ClassifiedNode): boolean {
    return hasRole(item, "pipe")
        || hasRole(item, "branchMain")
        || hasRole(item, "fitting")
        || hasRole(item, "reducer")
        || hasRole(item, "valve");
}

function buildSolverAdapter(
    graph: ConnectorGraphDocument,
    classified: Map<string, ClassifiedNode>,
    orientedEdges: OrientedFireEdge[],
    missingHydraulicInputs: FireAuditFinding[],
) {
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
    const attributedLengthNodeIds = new Set<string>();
    const links = orientedEdges
        .filter((edge) => edge.orientationStatus === "oriented" && edge.fromNodeId && edge.toNodeId)
        .map((edge) => {
            const from = nodeById.get(String(edge.fromNodeId));
            const to = nodeById.get(String(edge.toNodeId));
            const physicalNode = [to, from].find((item) => item && hasRole(item, "pipe") && !attributedLengthNodeIds.has(item.id));
            if (physicalNode) {
                attributedLengthNodeIds.add(physicalNode.id);
            }
            return {
                id: edge.edgeId,
                fromNodeId: edge.fromNodeId,
                toNodeId: edge.toNodeId,
                diameterMm: physicalNode ? readDiameterMm(physicalNode.node) : readDiameterMm(from?.node) ?? readDiameterMm(to?.node),
                lengthMm: physicalNode ? readEquivalentLengthMm(physicalNode.node) : null,
                cFactor: physicalNode
                    ? readNumericProperty(physicalNode.node, C_FACTOR_KEYS) ?? readGlobalNumericProperty(graph, C_FACTOR_KEYS)
                    : readNumericProperty(from?.node, C_FACTOR_KEYS) ?? readGlobalNumericProperty(graph, C_FACTOR_KEYS),
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

function summarizeNode(item: ClassifiedNode | undefined) {
    if (!item) return null;
    return {
        nodeId: item.id,
        elementId: item.node.elementId ?? null,
        primaryRole: item.primaryRole,
        roleTags: item.roleTags,
        familyName: item.node.familyName || null,
        typeName: item.node.typeName || null,
    };
}

function summarizeComponent(
    component: { nodeIds: string[]; edgeIds: string[] },
    index: number,
    classified: Map<string, ClassifiedNode>,
    sourceNodeIds: string[],
) {
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

function readDiameterMm(node: ConnectorGraphNode | undefined): number | null {
    if (!node) return null;
    const engineering = node.engineering || {};
    const value = engineering.diameterMm ?? engineering.DiameterMm ?? readProperty(node, ["diameterMm", "diameter", "dnMm", "nominalDiameterMm"]);
    return numeric(value);
}

function readEquivalentLengthMm(node: ConnectorGraphNode | undefined): number | null {
    if (!node) return null;
    const propertyValue = readNumericProperty(node, EQUIVALENT_LENGTH_KEYS);
    if (propertyValue != null) return propertyValue;
    const engineering = node.engineering || {};
    return numeric(engineering.lengthMm ?? engineering.LengthMm);
}

function readElevationMm(node: ConnectorGraphNode | undefined): number | null {
    if (!node) return null;
    const direct = numeric(node.elevationMm);
    if (direct != null) return direct;
    for (const connector of node.connectors || []) {
        const z = numeric(connector.origin?.z);
        if (z != null) return z;
    }
    return null;
}

function numeric(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const match = value.trim().replace(/\s+/g, "").match(/-?[\d.,]+/);
        if (!match) return null;
        let normalized = match[0];
        const lastComma = normalized.lastIndexOf(",");
        const lastDot = normalized.lastIndexOf(".");
        if (lastComma >= 0 && lastDot >= 0) {
            const decimalSeparator = lastComma > lastDot ? "," : ".";
            const thousandsSeparator = decimalSeparator === "," ? "." : ",";
            normalized = normalized.replace(new RegExp(`\\${thousandsSeparator}`, "g"), "");
            normalized = normalized.replace(decimalSeparator, ".");
        } else if (lastComma >= 0) {
            const parts = normalized.split(",");
            normalized = parts.length > 2 || parts[parts.length - 1].length === 3 ? parts.join("") : normalized.replace(",", ".");
        } else if (lastDot >= 0) {
            const parts = normalized.split(".");
            normalized = parts.length > 2 || parts[parts.length - 1].length === 3 ? parts.join("") : normalized;
        }
        const parsed = Number(normalized);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function isTerminal(item: ClassifiedNode | undefined): boolean {
    return Boolean(item && (hasRole(item, "sprinkler") || hasRole(item, "cabinet")));
}

function hasRole(item: ClassifiedNode | undefined, role: NodeRole): boolean {
    return Boolean(item?.roleTags.includes(role));
}

function compareById(a: ClassifiedNode, b: ClassifiedNode): number {
    return a.id.localeCompare(b.id);
}

function compareFindings(a: FireAuditFinding, b: FireAuditFinding): number {
    const severityRank = { error: 0, warning: 1, info: 2 };
    return severityRank[a.severity] - severityRank[b.severity]
        || a.code.localeCompare(b.code)
        || String(a.nodeId || "").localeCompare(String(b.nodeId || ""))
        || String(a.edgeId || "").localeCompare(String(b.edgeId || ""));
}
