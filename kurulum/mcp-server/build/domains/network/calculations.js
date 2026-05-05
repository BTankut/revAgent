function normalizeId(value) {
    return String(value ?? "").trim();
}

function edgeKey(a, b) {
    return `${normalizeId(a)}->${normalizeId(b)}`;
}

function undirectedEdgeKey(a, b) {
    const left = normalizeId(a);
    const right = normalizeId(b);
    return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function edgeLossPa(edge) {
    const direct = Number(edge.lossPa ?? edge.pressureLossPa ?? 0);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const lossPerM = Number(edge.pressureLossPaPerM ?? 0);
    const lengthM = Number(edge.lengthM ?? 0);
    if (Number.isFinite(lossPerM) && Number.isFinite(lengthM) && lossPerM > 0 && lengthM > 0) {
        return lossPerM * lengthM;
    }
    return 0;
}

export function analyzeWeightedNetwork({
    nodes = [],
    edges = [],
    rootNodeId,
    terminalNodeIds = [],
    terminalDemands = {},
    directed = false,
} = {}) {
    const nodeIds = collectNodeIds({ nodes, edges, terminalNodeIds, terminalDemands });
    const root = normalizeId(rootNodeId);
    const warnings = [];
    const errors = [];
    if (!root || !nodeIds.has(root)) {
        errors.push("rootNodeId must identify a node in the network");
    }

    const adjacency = new Map();
    for (const node of nodeIds) adjacency.set(node, []);
    const uniqueUndirectedEdges = new Set();
    let skippedEdgeCount = 0;
    for (const edge of edges) {
        const from = normalizeId(edge.from);
        const to = normalizeId(edge.to);
        if (!from || !to || from === to) {
            skippedEdgeCount++;
            continue;
        }
        if (!adjacency.has(from)) adjacency.set(from, []);
        if (!adjacency.has(to)) adjacency.set(to, []);
        const lossPa = edgeLossPa(edge);
        adjacency.get(from).push({ to, lossPa, edge });
        if (!directed) adjacency.get(to).push({ to: from, lossPa, edge });
        uniqueUndirectedEdges.add(undirectedEdgeKey(from, to));
    }
    if (skippedEdgeCount > 0) warnings.push(`skipped ${skippedEdgeCount} invalid edge(s)`);
    if (errors.length > 0) {
        return { success: false, errors, warnings, canCommit: false };
    }

    const components = connectedComponents(adjacency);
    const rootComponent = components.find((component) => component.includes(root)) || [];
    const cyclesLikely = uniqueUndirectedEdges.size > Math.max(0, nodeIds.size - components.length);
    if (cyclesLikely) {
        warnings.push("network contains cycles; shortest-path traversal uses accumulated edge loss and does not infer flow split");
    }
    if (rootComponent.length !== nodeIds.size) {
        warnings.push("network contains nodes disconnected from root");
    }

    const shortest = shortestPathsByLoss(adjacency, root);
    const terminalSet = new Set([
        ...terminalNodeIds.map(normalizeId).filter(Boolean),
        ...Object.entries(terminalDemands)
            .filter(([, demand]) => Number.isFinite(Number(demand)) && Number(demand) > 0)
            .map(([node]) => normalizeId(node))
            .filter(Boolean),
    ]);
    const terminalPaths = [...terminalSet].sort().map((terminalNodeId) => {
        const totalLossPa = shortest.distances.get(terminalNodeId);
        const reachable = Number.isFinite(totalLossPa);
        return {
            terminalNodeId,
            reachable,
            totalLossPa: reachable ? totalLossPa : null,
            demand: Number(terminalDemands[terminalNodeId] ?? 0),
            nodeIds: reachable ? pathToNode(shortest.previous, root, terminalNodeId) : [],
        };
    });
    const reachableTerminalPaths = terminalPaths.filter((path) => path.reachable);
    const criticalPath = reachableTerminalPaths.reduce((selected, candidate) => {
        if (!selected || candidate.totalLossPa > selected.totalLossPa) return candidate;
        return selected;
    }, null);

    return {
        success: true,
        errors,
        warnings,
        assumptions: [
            "Pathfinding uses accumulated edge pressure loss as weight.",
            "Cyclic networks are traversed read-only; flow direction and split must be resolved before commit-level sizing.",
            "Critical path is the reachable terminal with the highest shortest-path accumulated loss.",
        ],
        nodeCount: nodeIds.size,
        edgeCount: edges.length,
        rootNodeId: root,
        directed: Boolean(directed),
        componentCount: components.length,
        connectedComponentNodeCounts: components.map((component) => component.length).sort((a, b) => b - a),
        reachableNodeCount: rootComponent.length,
        cycleDetected: cyclesLikely,
        terminalCount: terminalSet.size,
        terminalPaths,
        criticalPath: criticalPath
            ? {
                terminalNodeId: criticalPath.terminalNodeId,
                totalLossPa: criticalPath.totalLossPa,
                demand: criticalPath.demand,
                nodeIds: criticalPath.nodeIds,
            }
            : null,
        canCommit: false,
    };
}

export function analyzeTreeNetwork({ nodes = [], edges = [], rootNodeId, terminalDemands = {} } = {}) {
    const nodeIds = new Set(nodes.map(normalizeId).filter(Boolean));
    for (const edge of edges) {
        const from = normalizeId(edge.from);
        const to = normalizeId(edge.to);
        if (from) nodeIds.add(from);
        if (to) nodeIds.add(to);
    }
    const root = normalizeId(rootNodeId);
    const warnings = [];
    const errors = [];
    if (!root || !nodeIds.has(root)) {
        errors.push("rootNodeId must identify a node in the network");
    }
    const adjacency = new Map();
    for (const node of nodeIds) adjacency.set(node, []);
    const edgeLossByPair = new Map();
    for (const edge of edges) {
        const from = normalizeId(edge.from);
        const to = normalizeId(edge.to);
        if (!from || !to || from === to) {
            warnings.push("skipped invalid edge");
            continue;
        }
        if (!adjacency.has(from)) adjacency.set(from, []);
        if (!adjacency.has(to)) adjacency.set(to, []);
        adjacency.get(from).push(to);
        adjacency.get(to).push(from);
        edgeLossByPair.set(undirectedEdgeKey(from, to), edgeLossPa(edge));
    }
    if (errors.length > 0) {
        return { success: false, errors, warnings, canCommit: false };
    }

    const parent = new Map([[root, null]]);
    const order = [];
    let hasCycle = false;
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        order.push(current);
        for (const next of adjacency.get(current) || []) {
            if (next === parent.get(current)) continue;
            if (parent.has(next)) {
                hasCycle = true;
                continue;
            }
            parent.set(next, current);
            stack.push(next);
        }
    }
    const disconnectedNodes = [...nodeIds].filter((node) => !parent.has(node));
    if (hasCycle) warnings.push("network contains cycles; branch flow aggregation assumes a tree");
    if (disconnectedNodes.length > 0) warnings.push("network contains nodes disconnected from root");

    const demandByNode = new Map();
    for (const node of nodeIds) {
        const demand = Number(terminalDemands[node] ?? 0);
        demandByNode.set(node, Number.isFinite(demand) && demand > 0 ? demand : 0);
    }
    const subtreeDemandByNode = new Map([...demandByNode.entries()]);
    const branchFlows = [];
    for (const node of [...order].reverse()) {
        const parentNode = parent.get(node);
        if (!parentNode) continue;
        const nodeDemand = subtreeDemandByNode.get(node) || 0;
        subtreeDemandByNode.set(parentNode, (subtreeDemandByNode.get(parentNode) || 0) + nodeDemand);
        branchFlows.push({
            from: parentNode,
            to: node,
            flow: nodeDemand,
        });
    }
    branchFlows.reverse();

    const cumulativeLossByNode = new Map([[root, 0]]);
    const pathByNode = new Map([[root, [root]]]);
    for (const node of order) {
        const baseLoss = cumulativeLossByNode.get(node) || 0;
        for (const next of adjacency.get(node) || []) {
            if (parent.get(next) !== node) continue;
            const nextLoss = baseLoss + (edgeLossByPair.get(undirectedEdgeKey(node, next)) || 0);
            cumulativeLossByNode.set(next, nextLoss);
            pathByNode.set(next, [...(pathByNode.get(node) || [node]), next]);
        }
    }
    const terminalNodes = [...nodeIds].filter((node) => (demandByNode.get(node) || 0) > 0);
    let criticalNode = terminalNodes[0] || root;
    for (const node of terminalNodes) {
        if ((cumulativeLossByNode.get(node) || 0) > (cumulativeLossByNode.get(criticalNode) || 0)) {
            criticalNode = node;
        }
    }

    return {
        success: true,
        errors,
        warnings,
        assumptions: [
            "Branch flow aggregation assumes a rooted tree; cyclic networks require resolved flow directions before commit-level sizing.",
            "Critical path is selected by maximum accumulated edge loss to a terminal demand node.",
        ],
        nodeCount: nodeIds.size,
        edgeCount: edges.length,
        rootNodeId: root,
        isTree: !hasCycle && disconnectedNodes.length === 0 && edges.length === Math.max(0, nodeIds.size - 1),
        disconnectedNodes,
        terminalCount: terminalNodes.length,
        totalDemand: subtreeDemandByNode.get(root) || 0,
        branchFlows,
        criticalPath: {
            terminalNodeId: criticalNode,
            totalLossPa: cumulativeLossByNode.get(criticalNode) || 0,
            nodeIds: pathByNode.get(criticalNode) || [root],
        },
        canCommit: false,
    };
}

export function exampleAirsideTreeNetwork() {
    return analyzeTreeNetwork({
        rootNodeId: "fan",
        nodes: ["fan", "main", "branch-a", "branch-b", "term-a", "term-b"],
        edges: [
            { from: "fan", to: "main", pressureLossPa: 35 },
            { from: "main", to: "branch-a", pressureLossPa: 18 },
            { from: "main", to: "branch-b", pressureLossPa: 22 },
            { from: "branch-a", to: "term-a", pressureLossPa: 40 },
            { from: "branch-b", to: "term-b", pressureLossPa: 55 },
        ],
        terminalDemands: {
            "term-a": 180,
            "term-b": 220,
        },
    });
}

export function exampleAirsideWeightedNetwork() {
    return analyzeWeightedNetwork({
        rootNodeId: "fan",
        nodes: ["fan", "main", "branch-a", "branch-b", "term-a", "term-b", "bypass"],
        edges: [
            { from: "fan", to: "main", pressureLossPa: 35 },
            { from: "main", to: "branch-a", pressureLossPa: 18 },
            { from: "main", to: "branch-b", pressureLossPa: 22 },
            { from: "branch-a", to: "term-a", pressureLossPa: 40 },
            { from: "branch-b", to: "term-b", pressureLossPa: 55 },
            { from: "main", to: "bypass", pressureLossPa: 30 },
            { from: "bypass", to: "term-b", pressureLossPa: 95 },
        ],
        terminalDemands: {
            "term-a": 180,
            "term-b": 220,
        },
    });
}

export function exampleHydronicTreeNetwork() {
    return analyzeTreeNetwork({
        rootNodeId: "pump",
        nodes: ["pump", "riser", "coil-a", "coil-b"],
        edges: [
            { from: "pump", to: "riser", pressureLossPa: 1200 },
            { from: "riser", to: "coil-a", pressureLossPa: 2400 },
            { from: "riser", to: "coil-b", pressureLossPa: 3100 },
        ],
        terminalDemands: {
            "coil-a": 0.35,
            "coil-b": 0.42,
        },
    });
}

export function exampleHydronicWeightedNetwork() {
    return analyzeWeightedNetwork({
        rootNodeId: "pump",
        nodes: ["pump", "riser", "coil-a", "coil-b", "bypass"],
        edges: [
            { from: "pump", to: "riser", pressureLossPa: 1200 },
            { from: "riser", to: "coil-a", pressureLossPa: 2400 },
            { from: "riser", to: "coil-b", pressureLossPa: 3100 },
            { from: "riser", to: "bypass", pressureLossPa: 700 },
            { from: "bypass", to: "coil-b", pressureLossPa: 4500 },
        ],
        terminalDemands: {
            "coil-a": 0.35,
            "coil-b": 0.42,
        },
    });
}

function collectNodeIds({ nodes, edges, terminalNodeIds, terminalDemands }) {
    const nodeIds = new Set(nodes.map(normalizeId).filter(Boolean));
    for (const edge of edges) {
        const from = normalizeId(edge.from);
        const to = normalizeId(edge.to);
        if (from) nodeIds.add(from);
        if (to) nodeIds.add(to);
    }
    for (const node of terminalNodeIds || []) {
        const id = normalizeId(node);
        if (id) nodeIds.add(id);
    }
    for (const node of Object.keys(terminalDemands || {})) {
        const id = normalizeId(node);
        if (id) nodeIds.add(id);
    }
    return nodeIds;
}

function connectedComponents(adjacency) {
    const visited = new Set();
    const components = [];
    for (const node of adjacency.keys()) {
        if (visited.has(node)) continue;
        const component = [];
        const stack = [node];
        visited.add(node);
        while (stack.length > 0) {
            const current = stack.pop();
            component.push(current);
            for (const edge of adjacency.get(current) || []) {
                if (visited.has(edge.to)) continue;
                visited.add(edge.to);
                stack.push(edge.to);
            }
        }
        components.push(component);
    }
    return components;
}

function shortestPathsByLoss(adjacency, root) {
    const distances = new Map();
    const previous = new Map();
    const unvisited = new Set(adjacency.keys());
    for (const node of adjacency.keys()) {
        distances.set(node, Number.POSITIVE_INFINITY);
        previous.set(node, null);
    }
    distances.set(root, 0);

    while (unvisited.size > 0) {
        let current = null;
        let currentDistance = Number.POSITIVE_INFINITY;
        for (const node of unvisited) {
            const distance = distances.get(node);
            if (distance < currentDistance) {
                current = node;
                currentDistance = distance;
            }
        }
        if (!current || !Number.isFinite(currentDistance)) break;
        unvisited.delete(current);
        for (const edge of adjacency.get(current) || []) {
            if (!unvisited.has(edge.to)) continue;
            const alternate = currentDistance + Math.max(0, Number(edge.lossPa || 0));
            if (alternate < distances.get(edge.to)) {
                distances.set(edge.to, alternate);
                previous.set(edge.to, current);
            }
        }
    }
    return { distances, previous };
}

function pathToNode(previous, root, target) {
    const path = [];
    let current = target;
    const guard = new Set();
    while (current && !guard.has(current)) {
        path.push(current);
        if (current === root) break;
        guard.add(current);
        current = previous.get(current);
    }
    path.reverse();
    return path[0] === root ? path : [];
}
