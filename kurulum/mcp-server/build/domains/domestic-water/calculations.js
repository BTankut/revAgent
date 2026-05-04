export function calculateFixtureDemand({ fixtures = [], fixtureUnitTable = null } = {}) {
    if (!fixtureUnitTable) {
        return missingStandard("domesticWater.fixtureUnitTable");
    }
    const rows = [];
    let coldFixtureUnits = 0;
    let hotFixtureUnits = 0;
    let totalFixtureUnits = 0;
    for (const fixture of fixtures) {
        const count = Number(fixture.count || 0);
        const type = fixture.fixtureType || fixture.type || "";
        const basis = fixtureUnitTable[type];
        if (!basis) {
            rows.push({
                fixtureType: type,
                count,
                error: "Fixture type is not in the configured fixture unit table.",
            });
            continue;
        }
        const cold = count * Number(basis.coldFixtureUnits || 0);
        const hot = count * Number(basis.hotFixtureUnits || 0);
        const total = count * Number(basis.totalFixtureUnits || basis.coldFixtureUnits || 0);
        coldFixtureUnits += cold;
        hotFixtureUnits += hot;
        totalFixtureUnits += total;
        rows.push({
            fixtureType: type,
            count,
            coldFixtureUnits: cold,
            hotFixtureUnits: hot,
            totalFixtureUnits: total,
        });
    }
    return {
        success: rows.every((row) => !row.error),
        method: "Configured fixture-unit summation",
        rows,
        totals: {
            coldFixtureUnits,
            hotFixtureUnits,
            totalFixtureUnits,
        },
        assumptions: [
            "Demand conversion from fixture units to flow is not performed without the configured office standard curve.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function checkRecirculationContinuity({ nodes = [], edges = [], requiredLoopNodeIds = [] } = {}) {
    const graph = new Map();
    for (const node of nodes) graph.set(String(node.id), new Set());
    for (const edge of edges) {
        const a = String(edge.from);
        const b = String(edge.to);
        if (!graph.has(a)) graph.set(a, new Set());
        if (!graph.has(b)) graph.set(b, new Set());
        graph.get(a).add(b);
        graph.get(b).add(a);
    }
    const issues = [];
    for (const nodeId of requiredLoopNodeIds.map(String)) {
        const degree = graph.has(nodeId) ? graph.get(nodeId).size : 0;
        if (degree < 2) {
            issues.push({
                nodeId,
                issue: "recirculation node is not part of a continuous loop",
                degree,
            });
        }
    }
    return {
        success: issues.length === 0,
        method: "Undirected graph degree continuity check",
        issues,
        canCommit: false,
        riskLevel: "medium",
    };
}

function missingStandard(name) {
    return {
        success: false,
        requiresOfficeStandard: true,
        missingStandards: [name],
        canCommit: false,
    };
}
