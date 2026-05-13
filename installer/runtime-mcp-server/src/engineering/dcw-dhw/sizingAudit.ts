// @ts-nocheck
import crypto from "node:crypto";

export const CONNECTOR_GRAPH_SCHEMA_VERSION = "mep.connector-graph.v1";
export const DCW_DHW_REPORT_SCHEMA_VERSION = "dcw-dhw-sizing-audit.v1";

const DEFAULT_DIAMETER_CATALOG_MM = [15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200];
const DEFAULT_MIN_FLOW_LPS = 0.0001;

export const DEFAULT_FIXTURE_UNIT_TABLES = {
    mixed: {
        id: "project-default-mixed-fu-to-flow-v1",
        description: "Project default interpolation table. Replace with the approved local code/project table before production issue.",
        points: [
            [0, 0],
            [1, 0.19],
            [2, 0.25],
            [3, 0.31],
            [4, 0.36],
            [5, 0.41],
            [6, 0.45],
            [8, 0.52],
            [10, 0.59],
            [15, 0.75],
            [20, 0.9],
            [30, 1.14],
            [40, 1.34],
            [60, 1.7],
            [80, 2.02],
            [100, 2.31],
            [150, 2.89],
            [200, 3.39],
            [300, 4.37],
            [400, 5.18],
            [500, 5.86],
            [750, 7.25],
            [1000, 8.58],
        ],
    },
    flushTank: {
        id: "project-default-flush-tank-fu-to-flow-v1",
        description: "Project default flush-tank interpolation table. Replace with the approved local code/project table before production issue.",
        points: [
            [0, 0],
            [1, 0.16],
            [2, 0.22],
            [3, 0.27],
            [5, 0.35],
            [8, 0.45],
            [10, 0.52],
            [15, 0.66],
            [20, 0.8],
            [30, 1.02],
            [40, 1.22],
            [60, 1.54],
            [80, 1.84],
            [100, 2.1],
            [150, 2.66],
            [200, 3.12],
            [300, 4.06],
            [500, 5.44],
            [750, 6.82],
            [1000, 8.05],
        ],
    },
    flushValve: {
        id: "project-default-flush-valve-fu-to-flow-v1",
        description: "Project default flush-valve interpolation table. Replace with the approved local code/project table before production issue.",
        points: [
            [0, 0],
            [5, 0.55],
            [10, 0.82],
            [15, 1.02],
            [20, 1.22],
            [30, 1.52],
            [40, 1.78],
            [60, 2.22],
            [80, 2.62],
            [100, 2.98],
            [150, 3.72],
            [200, 4.36],
            [300, 5.52],
            [400, 6.48],
            [500, 7.3],
            [750, 8.95],
            [1000, 10.35],
        ],
    },
};

const PROPERTY_KEY_ALIASES = {
    dcwFixtureUnits: [
        "dcwFixtureUnits",
        "fixtureUnitsCold",
        "coldFixtureUnits",
        "ColdWaterFixtureUnits",
        "Cold Water Fixture Units",
        "CW Fixture Units",
        "CWFU",
        "DCW FU",
        "Domestic Cold Water Fixture Units",
    ],
    dhwFixtureUnits: [
        "dhwFixtureUnits",
        "fixtureUnitsHot",
        "hotFixtureUnits",
        "HotWaterFixtureUnits",
        "Hot Water Fixture Units",
        "HW Fixture Units",
        "HWFU",
        "DHW FU",
        "Domestic Hot Water Fixture Units",
    ],
    genericFixtureUnits: [
        "fixtureUnits",
        "Fixture Units",
        "WSFU",
        "Water Supply Fixture Units",
        "FU",
    ],
    flushType: [
        "flushType",
        "fixtureFlushType",
        "Fixture Flush Type",
        "Water Closet Flush Type",
        "Flush Type",
        "DPE_Flush_Type",
    ],
    heatLossW: [
        "heatLossW",
        "Heat Loss W",
        "DPE_HeatLoss_W",
        "DHW Heat Loss W",
    ],
    heatLossWPerM: [
        "heatLossWPerM",
        "Heat Loss W/m",
        "DPE_HeatLoss_WPerM",
        "DHW Heat Loss W/m",
    ],
};

function stableStringify(value) {
    if (value === null || value === undefined) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    if (typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function computeApprovalToken(actions) {
    const normalized = (actions || []).map((action) => ({
        actionId: action.actionId,
        writeKind: action.writeKind,
        elementId: action.elementId,
        nodeId: action.nodeId,
        parameterName: action.parameterName || null,
        targetDiameterMm: action.targetDiameterMm ?? null,
        parameterValue: action.parameterValue ?? null,
        parameterUnit: action.parameterUnit || null,
    })).sort((a, b) => String(a.actionId).localeCompare(String(b.actionId)));
    return crypto.createHash("sha256").update(stableStringify(normalized)).digest("hex");
}

function toArray(value) {
    return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && value !== "") {
            return value;
        }
    }
    return undefined;
}

function readField(value, ...keys) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    for (const key of keys) {
        if (value[key] !== undefined) {
            return value[key];
        }
        const found = Object.keys(value).find((candidate) => candidate.toLowerCase() === String(key).toLowerCase());
        if (found) {
            return value[found];
        }
    }
    return undefined;
}

function readEngineering(node, ...keys) {
    return readField(readField(node, "engineering", "Engineering") || {}, ...keys);
}

function readProperties(owner, aliases) {
    const properties = readField(owner, "properties", "Properties") || {};
    for (const alias of aliases) {
        const value = readField(properties, alias);
        if (value !== undefined && value !== null && value !== "") {
            return value;
        }
    }
    return undefined;
}

function asNumber(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    const normalized = String(value).trim().replace(",", ".");
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!match) {
        return null;
    }
    const parsed = Number.parseFloat(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeToken(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function includesAny(value, tokens) {
    const normalized = normalizeToken(value);
    return tokens.some((token) => normalized.includes(normalizeToken(token)));
}

function nodeLabel(node) {
    return [readField(node, "systemClassification", "SystemClassification"), readField(node, "systemType", "SystemType"), readField(node, "systemName", "SystemName"), readField(node, "familyName", "FamilyName"), readField(node, "typeName", "TypeName")].filter(Boolean).join(" ");
}

export function classifySystemKind(owner) {
    const text = nodeLabel(owner);
    const normalized = normalizeToken(text);
    if (!normalized) {
        return "other";
    }
    if ((normalized.includes("dhwr") || normalized.includes("recirc") || normalized.includes("recirculation") || normalized.includes("return")) && (normalized.includes("domestic") || normalized.includes("hotwater") || normalized.includes("dhw"))) {
        return "dhwr";
    }
    if (normalized.includes("domesticcoldwater") || normalized.includes("dcw") || normalized.includes("coldwater")) {
        return "dcw";
    }
    if (normalized.includes("domestichotwater") || normalized.includes("dhw") || normalized.includes("hotwater")) {
        return "dhw";
    }
    return "other";
}

function isPipeNode(node) {
    const category = String(readField(node, "category", "Category") || "");
    const normalized = normalizeToken(category);
    return normalized === "pipe" ||
        normalized === "pipes" ||
        normalized === "pipecurves" ||
        normalized === "ostpipecurves";
}

function isFixtureNode(node) {
    const category = String(readField(node, "category", "Category") || "");
    if (includesAny(category, ["plumbingfixture", "plumbingfixtures", "fixture"])) {
        return true;
    }
    return asNumber(readProperties(node, PROPERTY_KEY_ALIASES.dcwFixtureUnits)) !== null ||
        asNumber(readProperties(node, PROPERTY_KEY_ALIASES.dhwFixtureUnits)) !== null ||
        asNumber(readEngineering(node, "fixtureUnits", "FixtureUnits")) !== null ||
        asNumber(readProperties(node, PROPERTY_KEY_ALIASES.genericFixtureUnits)) !== null;
}

function classifyFlushType(node) {
    const explicit = String(readProperties(node, PROPERTY_KEY_ALIASES.flushType) || "");
    const text = `${explicit} ${readField(node, "familyName", "FamilyName") || ""} ${readField(node, "typeName", "TypeName") || ""}`;
    if (includesAny(text, ["flushometer", "flush valve", "flushvalve", "valve"])) {
        return "flushValve";
    }
    if (includesAny(text, ["tank", "cistern", "reservoir"])) {
        return "flushTank";
    }
    return "unknown";
}

function readFixtureDemand(node) {
    const generic = firstDefined(
        readEngineering(node, "fixtureUnits", "FixtureUnits"),
        readProperties(node, PROPERTY_KEY_ALIASES.genericFixtureUnits),
    );
    const dcw = firstDefined(readProperties(node, PROPERTY_KEY_ALIASES.dcwFixtureUnits), generic);
    const dhw = firstDefined(readProperties(node, PROPERTY_KEY_ALIASES.dhwFixtureUnits));
    return {
        nodeId: readField(node, "id", "Id"),
        elementId: readField(node, "elementId", "ElementId"),
        uniqueId: readField(node, "uniqueId", "UniqueId"),
        familyName: readField(node, "familyName", "FamilyName"),
        typeName: readField(node, "typeName", "TypeName"),
        systemKind: classifySystemKind(node),
        dcwFixtureUnits: asNumber(dcw),
        dhwFixtureUnits: asNumber(dhw),
        genericFixtureUnits: asNumber(generic),
        flushType: classifyFlushType(node),
    };
}

function normalizeTable(input, fallback) {
    const table = input || fallback;
    const rawPoints = toArray(table.points || table).map((point) => {
        if (Array.isArray(point)) {
            return { fixtureUnits: Number(point[0]), flowLps: Number(point[1]), ruleId: point[2] };
        }
        return {
            fixtureUnits: Number(point.fixtureUnits ?? point.fu),
            flowLps: Number(point.flowLps ?? point.lps),
            ruleId: point.ruleId,
        };
    }).filter((point) => Number.isFinite(point.fixtureUnits) && Number.isFinite(point.flowLps) && point.fixtureUnits >= 0 && point.flowLps >= 0)
        .sort((a, b) => a.fixtureUnits - b.fixtureUnits);
    return {
        id: table.id || table.tableId || fallback.id,
        description: table.description || fallback.description,
        points: rawPoints,
    };
}

function getTables(options = {}) {
    return {
        mixed: normalizeTable(options.flowTables?.mixed || options.flowTable, DEFAULT_FIXTURE_UNIT_TABLES.mixed),
        flushTank: normalizeTable(options.flowTables?.flushTank, DEFAULT_FIXTURE_UNIT_TABLES.flushTank),
        flushValve: normalizeTable(options.flowTables?.flushValve, DEFAULT_FIXTURE_UNIT_TABLES.flushValve),
    };
}

export function convertFixtureUnitsToFlow(fixtureUnits, tableInput = DEFAULT_FIXTURE_UNIT_TABLES.mixed) {
    const table = normalizeTable(tableInput, DEFAULT_FIXTURE_UNIT_TABLES.mixed);
    const fu = Math.max(0, Number(fixtureUnits || 0));
    if (table.points.length < 2) {
        throw new Error(`Fixture-unit table '${table.id}' must contain at least two points.`);
    }
    if (fu <= table.points[0].fixtureUnits) {
        return {
            fixtureUnits: fu,
            flowLps: table.points[0].flowLps,
            tableId: table.id,
            ruleId: `${table.id}:at-min`,
            interpolation: "atMin",
            lower: table.points[0],
            upper: table.points[0],
        };
    }
    for (let index = 1; index < table.points.length; index += 1) {
        const lower = table.points[index - 1];
        const upper = table.points[index];
        if (fu <= upper.fixtureUnits) {
            const span = upper.fixtureUnits - lower.fixtureUnits;
            const ratio = span > 0 ? (fu - lower.fixtureUnits) / span : 0;
            const flowLps = lower.flowLps + ratio * (upper.flowLps - lower.flowLps);
            return {
                fixtureUnits: fu,
                flowLps: round(flowLps, 5),
                tableId: table.id,
                ruleId: `${table.id}:${lower.fixtureUnits}-${upper.fixtureUnits}`,
                interpolation: ratio === 0 ? "exact" : "linear",
                lower,
                upper,
            };
        }
    }
    const lower = table.points[table.points.length - 2];
    const upper = table.points[table.points.length - 1];
    const span = upper.fixtureUnits - lower.fixtureUnits;
    const ratio = span > 0 ? (fu - upper.fixtureUnits) / span : 0;
    const flowLps = upper.flowLps + ratio * (upper.flowLps - lower.flowLps);
    return {
        fixtureUnits: fu,
        flowLps: round(flowLps, 5),
        tableId: table.id,
        ruleId: `${table.id}:above-${upper.fixtureUnits}`,
        interpolation: "extrapolatedAboveTable",
        lower,
        upper,
    };
}

function round(value, digits = 3) {
    if (!Number.isFinite(Number(value))) {
        return value;
    }
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function connectorIdsForNode(node) {
    return toArray(readField(node, "connectors", "Connectors")).map((connector) => readField(connector, "id", "Id")).filter(Boolean);
}

function buildGraphIndex(graph) {
    const nodes = toArray(readField(graph, "nodes", "Nodes"));
    const edges = toArray(readField(graph, "edges", "Edges"));
    const nodeById = new Map();
    const connectorToNode = new Map();
    for (const node of nodes) {
        const id = readField(node, "id", "Id");
        if (!id) {
            continue;
        }
        nodeById.set(id, node);
        for (const connectorId of connectorIdsForNode(node)) {
            connectorToNode.set(connectorId, id);
        }
    }

    const adjacency = new Map();
    const reverse = new Map();
    const connectedConnectorIds = new Set();
    const ambiguousEdges = [];

    function addDirected(from, to, edge) {
        if (!from || !to) {
            return;
        }
        if (!adjacency.has(from)) {
            adjacency.set(from, []);
        }
        if (!reverse.has(to)) {
            reverse.set(to, []);
        }
        adjacency.get(from).push({ nodeId: to, edge });
        reverse.get(to).push({ nodeId: from, edge });
    }

    for (const edge of edges) {
        const direction = normalizeToken(readField(edge, "direction", "Direction"));
        const fromConnectorId = readField(edge, "fromConnectorId", "FromConnectorId");
        const toConnectorId = readField(edge, "toConnectorId", "ToConnectorId");
        const from = firstDefined(readField(edge, "fromNodeId", "FromNodeId"), connectorToNode.get(fromConnectorId));
        const to = firstDefined(readField(edge, "toNodeId", "ToNodeId"), connectorToNode.get(toConnectorId));
        if (fromConnectorId) {
            connectedConnectorIds.add(fromConnectorId);
        }
        if (toConnectorId) {
            connectedConnectorIds.add(toConnectorId);
        }
        if (direction === "fromto") {
            addDirected(from, to, edge);
        } else if (direction === "tofrom") {
            addDirected(to, from, edge);
        } else if (direction === "bidirectional") {
            addDirected(from, to, edge);
            addDirected(to, from, edge);
        } else {
            ambiguousEdges.push(edge);
        }
    }

    for (const node of nodes) {
        const id = readField(node, "id", "Id");
        if (!adjacency.has(id)) {
            adjacency.set(id, []);
        }
        if (!reverse.has(id)) {
            reverse.set(id, []);
        }
    }

    return { nodes, edges, nodeById, connectorToNode, adjacency, reverse, connectedConnectorIds, ambiguousEdges };
}

function reachableFixtureIds(startNodeId, index, fixtureByNodeId) {
    const output = new Set();
    const visited = new Set([startNodeId]);
    const stack = [startNodeId];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const next of index.adjacency.get(current) || []) {
            if (visited.has(next.nodeId)) {
                continue;
            }
            visited.add(next.nodeId);
            if (fixtureByNodeId.has(next.nodeId)) {
                output.add(next.nodeId);
            }
            stack.push(next.nodeId);
        }
    }
    return [...output].sort();
}

function selectFlowTableKey(aggregate, systemKind) {
    if (systemKind === "dhw") {
        return "mixed";
    }
    if (aggregate.flushValveFixtureUnits > 0) {
        return "flushValve";
    }
    if (aggregate.flushTankFixtureUnits > 0 && aggregate.unknownFlushFixtureUnits <= 0) {
        return "flushTank";
    }
    return "mixed";
}

function selectDiameter(flowLps, systemKind, options = {}) {
    function velocityLimit(kind, fallback) {
        const input = options.maxVelocityMps;
        if (typeof input === "number" && Number.isFinite(input) && input > 0) {
            return input;
        }
        if (input && typeof input === "object") {
            const specific = Number(input[kind]);
            if (Number.isFinite(specific) && specific > 0) {
                return specific;
            }
        }
        return fallback;
    }
    const velocityLimits = {
        dcw: velocityLimit("dcw", 2.0),
        dhw: velocityLimit("dhw", 1.5),
        dhwr: velocityLimit("dhwr", 1.0),
    };
    const maxVelocityMps = velocityLimits[systemKind] || 2.0;
    const catalog = toArray(options.diameterCatalogMm).length > 0
        ? toArray(options.diameterCatalogMm).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
        : DEFAULT_DIAMETER_CATALOG_MM;
    const qM3s = Math.max(0, Number(flowLps || 0)) / 1000;
    if (qM3s <= 0) {
        return {
            proposedDiameterMm: null,
            velocityMps: 0,
            maxVelocityMps,
            ruleId: "no-flow",
        };
    }
    const requiredDiameterMm = Math.sqrt((4 * qM3s) / (Math.PI * maxVelocityMps)) * 1000;
    const proposedDiameterMm = catalog.find((diameter) => diameter + 1e-9 >= requiredDiameterMm) || catalog[catalog.length - 1];
    const areaM2 = Math.PI * (proposedDiameterMm / 1000) ** 2 / 4;
    return {
        proposedDiameterMm,
        velocityMps: round(qM3s / areaM2, 4),
        maxVelocityMps,
        requiredDiameterMm: round(requiredDiameterMm, 3),
        ruleId: `velocity<=${maxVelocityMps}mps,next-catalog-diameter`,
    };
}

function finding(severity, code, message, refs = {}) {
    return {
        severity,
        code,
        message,
        nodeIds: toArray(refs.nodeIds),
        connectorIds: toArray(refs.connectorIds),
        edgeIds: toArray(refs.edgeIds),
        actionIds: toArray(refs.actionIds),
    };
}

function collectTopologyFindings(graph) {
    const topology = readField(graph, "topology", "Topology") || {};
    return toArray(readField(topology, "findings", "Findings")).map((item) => finding(
        String(readField(item, "severity", "Severity") || "warning").toLowerCase(),
        readField(item, "code", "Code") || "topology_finding",
        readField(item, "message", "Message") || "Connector graph topology finding.",
        {
            nodeIds: readField(item, "nodeIds", "NodeIds"),
            connectorIds: readField(item, "connectorIds", "ConnectorIds"),
            edgeIds: readField(item, "edgeIds", "EdgeIds"),
        },
    ));
}

function validateConnectorClassification(index, findings) {
    for (const node of index.nodes) {
        const nodeId = readField(node, "id", "Id");
        const nodeKind = classifySystemKind(node);
        for (const connector of toArray(readField(node, "connectors", "Connectors"))) {
            const connectorId = readField(connector, "id", "Id");
            const domain = normalizeToken(readField(connector, "domain", "Domain"));
            if (domain && domain !== "piping" && nodeKind !== "other") {
                findings.push(finding("warning", "wrong_connector_domain", "Domestic water node connector is not in the piping domain.", {
                    nodeIds: [nodeId],
                    connectorIds: [connectorId],
                }));
            }
            const connectorKind = classifySystemKind({
                systemClassification: readField(connector, "systemClassification", "SystemClassification"),
                systemType: readField(node, "systemType", "SystemType"),
                systemName: readField(node, "systemName", "SystemName"),
            });
            if (connectorKind !== "other" && nodeKind !== "other" && connectorKind !== nodeKind) {
                findings.push(finding("warning", "connector_system_mismatch", "Connector domestic system classification does not match its owner node.", {
                    nodeIds: [nodeId],
                    connectorIds: [connectorId],
                }));
            }
            const expected = readField(connector, "isConnectionExpected", "IsConnectionExpected");
            if (expected !== false && connectorId && !index.connectedConnectorIds.has(connectorId)) {
                findings.push(finding("warning", "open_end", "Expected connector is not referenced by any graph edge.", {
                    nodeIds: [nodeId],
                    connectorIds: [connectorId],
                }));
            }
        }
    }
}

function aggregateFixturesForPipe(pipeNode, index, fixtureByNodeId, systemKind) {
    const fixtureIds = reachableFixtureIds(readField(pipeNode, "id", "Id"), index, fixtureByNodeId);
    const aggregate = {
        fixtureNodeIds: fixtureIds,
        fixtureCount: fixtureIds.length,
        fixtureUnits: 0,
        flushTankFixtureUnits: 0,
        flushValveFixtureUnits: 0,
        unknownFlushFixtureUnits: 0,
    };
    for (const fixtureId of fixtureIds) {
        const demand = fixtureByNodeId.get(fixtureId);
        const fu = systemKind === "dhw" ? demand.dhwFixtureUnits : demand.dcwFixtureUnits;
        const numericFu = Number(fu || 0);
        aggregate.fixtureUnits += numericFu;
        if (systemKind === "dcw") {
            if (demand.flushType === "flushTank") {
                aggregate.flushTankFixtureUnits += numericFu;
            } else if (demand.flushType === "flushValve") {
                aggregate.flushValveFixtureUnits += numericFu;
            } else {
                aggregate.unknownFlushFixtureUnits += numericFu;
            }
        }
    }
    aggregate.fixtureUnits = round(aggregate.fixtureUnits, 5);
    aggregate.flushTankFixtureUnits = round(aggregate.flushTankFixtureUnits, 5);
    aggregate.flushValveFixtureUnits = round(aggregate.flushValveFixtureUnits, 5);
    aggregate.unknownFlushFixtureUnits = round(aggregate.unknownFlushFixtureUnits, 5);
    return aggregate;
}

function readHeatLossForNode(node, options, findings) {
    const nodeId = readField(node, "id", "Id");
    const explicitW = asNumber(readProperties(node, PROPERTY_KEY_ALIASES.heatLossW));
    if (explicitW !== null) {
        return {
            heatLossW: explicitW,
            source: "node.properties.heatLossW",
            assumed: false,
        };
    }
    const wPerM = asNumber(readProperties(node, PROPERTY_KEY_ALIASES.heatLossWPerM));
    const lengthMm = asNumber(readEngineering(node, "lengthMm", "LengthMm"));
    if (wPerM !== null && lengthMm !== null) {
        return {
            heatLossW: wPerM * lengthMm / 1000,
            heatLossWPerM: wPerM,
            source: "node.properties.heatLossWPerM*engineering.lengthMm",
            assumed: false,
        };
    }
    if (isPipeNode(node) && lengthMm !== null && lengthMm > 0) {
        const defaultHeatLossWPerM = Number(options.defaultDhwrHeatLossWPerM || 10);
        findings.push(finding("warning", "heat_loss_missing", "DHW recirculation pipe has no segment heat-loss data; default W/m assumption was used.", {
            nodeIds: [nodeId],
        }));
        return {
            heatLossW: defaultHeatLossWPerM * lengthMm / 1000,
            heatLossWPerM: defaultHeatLossWPerM,
            source: "options.defaultDhwrHeatLossWPerM*engineering.lengthMm",
            assumed: true,
        };
    }
    return {
        heatLossW: 0,
        source: "not-applicable",
        assumed: false,
    };
}

function analyzeRecirculation(index, options, findings) {
    const recircNodes = index.nodes.filter((node) => classifySystemKind(node) === "dhwr");
    const recircNodeIds = new Set(recircNodes.map((node) => readField(node, "id", "Id")));
    const deltaTC = Number(options.dhwrDeltaTC || options.recirculationDeltaTC || 5);
    const cpJPerKgK = Number(options.waterCpJPerKgK || 4186);
    const densityKgPerL = Number(options.waterDensityKgPerL || 0.997);
    if (!Number.isFinite(deltaTC) || deltaTC <= 0) {
        findings.push(finding("error", "dhwr_delta_t_invalid", "DHW recirculation delta-T must be greater than zero."));
    }
    if (recircNodes.length === 0) {
        return {
            status: "notApplicable",
            assumptions: [],
            segmentHeatLosses: [],
            criticalPath: null,
            totalHeatLossW: 0,
            totalReturnFlowLps: 0,
        };
    }
    const segmentHeatLosses = recircNodes.map((node) => {
        const heat = readHeatLossForNode(node, options, findings);
        return {
            nodeId: readField(node, "id", "Id"),
            elementId: readField(node, "elementId", "ElementId"),
            isPipe: isPipeNode(node),
            lengthMm: asNumber(readEngineering(node, "lengthMm", "LengthMm")),
            diameterMm: asNumber(readEngineering(node, "diameterMm", "DiameterMm")),
            heatLossW: round(heat.heatLossW, 3),
            heatLossSource: heat.source,
            assumed: heat.assumed,
        };
    });
    const heatByNodeId = new Map(segmentHeatLosses.map((segment) => [segment.nodeId, Number(segment.heatLossW || 0)]));
    const recircAdjacency = new Map();
    const indegree = new Map();
    for (const nodeId of recircNodeIds) {
        recircAdjacency.set(nodeId, []);
        indegree.set(nodeId, 0);
    }
    for (const [fromNodeId, items] of index.adjacency.entries()) {
        if (!recircNodeIds.has(fromNodeId)) {
            continue;
        }
        for (const item of items) {
            if (recircNodeIds.has(item.nodeId)) {
                recircAdjacency.get(fromNodeId).push(item.nodeId);
                indegree.set(item.nodeId, (indegree.get(item.nodeId) || 0) + 1);
            }
        }
    }
    let roots = [...recircNodeIds].filter((nodeId) => (indegree.get(nodeId) || 0) === 0);
    const assumptions = [
        `Return flow uses q = heatLossW / (${densityKgPerL} kg/L * ${cpJPerKgK} J/kgK * ${deltaTC} K).`,
    ];
    if (roots.length === 0) {
        roots = [...recircNodeIds].sort();
        findings.push(finding("warning", "dhwr_cycle_limited", "DHW recirculation graph has no directed root; critical path search was cycle-limited from each node."));
    }
    let best = { heatLossW: -1, nodeIds: [] };
    function visit(nodeId, path, heatLossW) {
        const nextHeat = heatLossW + (heatByNodeId.get(nodeId) || 0);
        const nextPath = [...path, nodeId];
        if (nextHeat > best.heatLossW) {
            best = { heatLossW: nextHeat, nodeIds: nextPath };
        }
        for (const nextNodeId of recircAdjacency.get(nodeId) || []) {
            if (nextPath.includes(nextNodeId)) {
                continue;
            }
            visit(nextNodeId, nextPath, nextHeat);
        }
    }
    for (const root of roots) {
        visit(root, [], 0);
    }
    const totalHeatLossW = segmentHeatLosses.reduce((sum, segment) => sum + Number(segment.heatLossW || 0), 0);
    const denominator = densityKgPerL * cpJPerKgK * deltaTC;
    const totalReturnFlowLps = denominator > 0 ? totalHeatLossW / denominator : 0;
    const criticalReturnFlowLps = denominator > 0 ? best.heatLossW / denominator : 0;
    return {
        status: "ok",
        assumptions,
        segmentHeatLosses,
        criticalPath: {
            nodeIds: best.nodeIds,
            heatLossW: round(best.heatLossW, 3),
            returnFlowLps: round(criticalReturnFlowLps, 5),
        },
        totalHeatLossW: round(totalHeatLossW, 3),
        totalReturnFlowLps: round(totalReturnFlowLps, 5),
        deltaTC,
        waterCpJPerKgK: cpJPerKgK,
        waterDensityKgPerL: densityKgPerL,
    };
}

function createNativeSizingPreparation(fixtures, sizingResults, findings) {
    return {
        status: "prepared",
        notes: [
            "Revit native pipe sizing can be used as a checked tool after fixture units, connector classifications, and system types are clean.",
            "The PlumbingFixtureFlowServer approach is a native Revit hook and requires an installed Revit add-in that registers the calculation server; this runtime module does not silently install or register that hook.",
            "Excel/Dynamo examples are treated as table and workflow references only; this module does not depend on Excel or Dynamo at runtime.",
        ],
        requiredFixtureParameters: [
            "Cold Water Fixture Units",
            "Hot Water Fixture Units",
            "Flush Type / flush tank / flush valve classification where applicable",
        ],
        requiredPipeParameters: [
            "System Type",
            "System Classification",
            "Flow",
            "Diameter",
        ],
        fixtureReadiness: fixtures.map((fixture) => ({
            nodeId: fixture.nodeId,
            elementId: fixture.elementId,
            dcwFixtureUnits: fixture.dcwFixtureUnits,
            dhwFixtureUnits: fixture.dhwFixtureUnits,
            flushType: fixture.flushType,
            isReady: fixture.dcwFixtureUnits !== null || fixture.dhwFixtureUnits !== null,
        })),
        affectedPipeNodeIds: sizingResults.map((result) => result.nodeId),
        blockingFindings: findings.filter((item) => ["error"].includes(item.severity)).map((item) => item.code),
    };
}

function createWriteBackPlan(sizingResults, options = {}) {
    const diameterToleranceMm = Number(options.diameterToleranceMm || 0.5);
    const actions = [];
    for (const result of sizingResults) {
        if (!result.elementId || !result.proposedDiameterMm || result.systemKind === "other") {
            continue;
        }
        const current = Number(result.currentDiameterMm || 0);
        if (!Number.isFinite(current) || current <= 0 || Math.abs(current - result.proposedDiameterMm) > diameterToleranceMm) {
            actions.push({
                actionId: `diameter:${result.nodeId}:${result.elementId}`,
                writeKind: "diameter",
                nodeId: result.nodeId,
                elementId: result.elementId,
                currentDiameterMm: result.currentDiameterMm,
                targetDiameterMm: result.proposedDiameterMm,
                trace: {
                    graphNodeId: result.nodeId,
                    systemKind: result.systemKind,
                    fixtureUnits: result.fixtureUnits,
                    designFlowLps: result.designFlowLps,
                    tableRuleId: result.tableRuleId,
                    sizingRuleId: result.diameterRuleId,
                    velocityMps: result.velocityMps,
                    downstreamFixtureNodeIds: result.downstreamFixtureNodeIds,
                },
            });
        }
        if (options.parameterWriteBack?.includeDesignFlowParameter) {
            actions.push({
                actionId: `parameter:flow:${result.nodeId}:${result.elementId}`,
                writeKind: "parameter",
                nodeId: result.nodeId,
                elementId: result.elementId,
                parameterName: options.parameterWriteBack.designFlowParameterName || "DPE_DCW_DHW_DesignFlow_Lps",
                parameterValue: result.designFlowLps,
                parameterUnit: "L/s",
                trace: {
                    graphNodeId: result.nodeId,
                    tableRuleId: result.tableRuleId,
                },
            });
        }
        if (options.parameterWriteBack?.includeFixtureUnitsParameter) {
            actions.push({
                actionId: `parameter:fu:${result.nodeId}:${result.elementId}`,
                writeKind: "parameter",
                nodeId: result.nodeId,
                elementId: result.elementId,
                parameterName: options.parameterWriteBack.fixtureUnitsParameterName || "DPE_DCW_DHW_FixtureUnits",
                parameterValue: result.fixtureUnits,
                parameterUnit: "FU",
                trace: {
                    graphNodeId: result.nodeId,
                    tableRuleId: result.tableRuleId,
                },
            });
        }
    }
    const approvalToken = computeApprovalToken(actions);
    return {
        mode: "previewOnly",
        approvalToken,
        actionCount: actions.length,
        actions,
        controls: [
            "No model write is performed by the audit tool.",
            "Apply requires the exact approvalToken and confirmWriteBack='APPLY_DCW_DHW_WRITEBACK'.",
            "Each action carries graph node, flow, fixture-unit, and table-rule trace data.",
        ],
    };
}

function summarizeFindings(findings) {
    const bySeverity = {};
    const byCode = {};
    for (const item of findings) {
        bySeverity[item.severity] = (bySeverity[item.severity] || 0) + 1;
        byCode[item.code] = (byCode[item.code] || 0) + 1;
    }
    return { bySeverity, byCode };
}

export function auditDcwDhwGraph(graph, options = {}) {
    const index = buildGraphIndex(graph || {});
    const findings = collectTopologyFindings(graph || {});
    const schemaVersion = readField(graph, "schemaVersion", "SchemaVersion");
    if (schemaVersion !== CONNECTOR_GRAPH_SCHEMA_VERSION) {
        findings.push(finding("error", "schema_version_unsupported", `Expected ${CONNECTOR_GRAPH_SCHEMA_VERSION}; received ${schemaVersion || "missing"}.`));
    }
    validateConnectorClassification(index, findings);
    for (const edge of index.ambiguousEdges) {
        findings.push(finding("warning", "direction_ambiguous", "Graph edge direction is unknown or ambiguous; downstream fixture aggregation excludes that edge.", {
            edgeIds: [readField(edge, "id", "Id")],
        }));
    }

    const fixtures = index.nodes.filter(isFixtureNode).map(readFixtureDemand);
    const fixtureByNodeId = new Map(fixtures.map((fixture) => [fixture.nodeId, fixture]));
    for (const fixture of fixtures) {
        if (fixture.dcwFixtureUnits === null && fixture.dhwFixtureUnits === null) {
            findings.push(finding("warning", "fixture_units_missing", "Plumbing fixture has no readable DCW/DHW fixture-unit value.", {
                nodeIds: [fixture.nodeId],
            }));
        }
    }

    const tables = getTables(options);
    const sizingResults = [];
    const minFlowLps = Number(options.minPipeFlowLps || DEFAULT_MIN_FLOW_LPS);
    for (const node of index.nodes.filter(isPipeNode)) {
        const nodeId = readField(node, "id", "Id");
        const systemKind = classifySystemKind(node);
        if (!["dcw", "dhw"].includes(systemKind)) {
            continue;
        }
        const aggregate = aggregateFixturesForPipe(node, index, fixtureByNodeId, systemKind);
        const tableKey = selectFlowTableKey(aggregate, systemKind);
        const conversion = convertFixtureUnitsToFlow(aggregate.fixtureUnits, tables[tableKey]);
        const graphFlowLps = asNumber(readEngineering(node, "flowLps", "FlowLps"));
        const designFlowLps = options.preferGraphFlow === true && graphFlowLps !== null && graphFlowLps > 0
            ? graphFlowLps
            : conversion.flowLps;
        const diameter = selectDiameter(designFlowLps, systemKind, options);
        const currentDiameterMm = asNumber(readEngineering(node, "diameterMm", "DiameterMm"));
        if (designFlowLps <= minFlowLps) {
            findings.push(finding("warning", "zero_flow_section", "Domestic water pipe has no downstream fixture-unit demand or design flow.", {
                nodeIds: [nodeId],
            }));
        }
        if (conversion.interpolation === "extrapolatedAboveTable") {
            findings.push(finding("warning", "fixture_unit_table_extrapolated", "Fixture-unit demand is above the last point in the selected flow table.", {
                nodeIds: [nodeId],
            }));
        }
        sizingResults.push({
            nodeId,
            elementId: readField(node, "elementId", "ElementId"),
            uniqueId: readField(node, "uniqueId", "UniqueId"),
            systemKind,
            systemName: readField(node, "systemName", "SystemName"),
            systemType: readField(node, "systemType", "SystemType"),
            currentDiameterMm,
            fixtureUnits: round(aggregate.fixtureUnits, 5),
            flushTankFixtureUnits: aggregate.flushTankFixtureUnits,
            flushValveFixtureUnits: aggregate.flushValveFixtureUnits,
            unknownFlushFixtureUnits: aggregate.unknownFlushFixtureUnits,
            downstreamFixtureNodeIds: aggregate.fixtureNodeIds,
            designFlowLps: round(designFlowLps, 5),
            graphFlowLps,
            flowSource: options.preferGraphFlow === true && graphFlowLps !== null && graphFlowLps > 0 ? "graph.engineering.flowLps" : "fixture-unit-table",
            flowTableId: conversion.tableId,
            tableRuleId: conversion.ruleId,
            tableInterpolation: conversion.interpolation,
            proposedDiameterMm: diameter.proposedDiameterMm,
            requiredDiameterMm: diameter.requiredDiameterMm,
            velocityMps: diameter.velocityMps,
            maxVelocityMps: diameter.maxVelocityMps,
            diameterRuleId: diameter.ruleId,
        });
    }

    const recirculation = analyzeRecirculation(index, options, findings);
    const writeBackPlan = createWriteBackPlan(sizingResults, options);
    const findingSummary = summarizeFindings(findings);
    const status = findingSummary.bySeverity.error > 0
        ? "error"
        : findingSummary.bySeverity.warning > 0 ? "warning" : "ok";

    return {
        schemaVersion: DCW_DHW_REPORT_SCHEMA_VERSION,
        sourceGraphSchemaVersion: schemaVersion || null,
        status,
        summary: {
            nodeCount: index.nodes.length,
            edgeCount: index.edges.length,
            fixtureCount: fixtures.length,
            domesticPipeCount: sizingResults.length,
            dcwPipeCount: sizingResults.filter((result) => result.systemKind === "dcw").length,
            dhwPipeCount: sizingResults.filter((result) => result.systemKind === "dhw").length,
            dhwrNodeCount: recirculation.segmentHeatLosses.length,
            writeBackActionCount: writeBackPlan.actionCount,
            findings: findingSummary,
        },
        fixtureUnitReads: fixtures,
        sizing: sizingResults,
        dhwRecirculation: recirculation,
        nativeSizingPreparation: createNativeSizingPreparation(fixtures, sizingResults, findings),
        missingDataReport: {
            findings,
        },
        writeBackPlan,
        foundationRecommendations: [
            "Consider optional segment heat-loss fields in the shared graph contract so DHWR reports do not depend on exporter-specific properties keys.",
            "Consider optional pipe role or domestic system kind fields if future branches need to distinguish DHW supply, DHWR return, and equipment bypasses without text normalization.",
        ],
        assumptions: [
            "Graph schema is consumed as mep.connector-graph.v1 without changing the schema in this branch.",
            "Default fixture-unit and sizing tables are project placeholders and can be overridden by tool options.",
            "All write-back is previewed first; audit mode performs no model write.",
        ],
    };
}
