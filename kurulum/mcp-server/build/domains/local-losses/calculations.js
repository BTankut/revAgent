export function connectorPathElementIds({ connectorPathfinding } = {}) {
    const terminalPaths = Array.isArray(connectorPathfinding?.terminalPaths)
        ? connectorPathfinding.terminalPaths
        : [];
    const ids = [];
    const seen = new Set();
    for (const path of terminalPaths) {
        if (path?.reachable !== true || !Array.isArray(path.pathElementIds)) continue;
        for (const value of path.pathElementIds) {
            const elementId = Number.parseInt(String(value), 10);
            if (!Number.isFinite(elementId) || elementId <= 0 || seen.has(elementId)) continue;
            seen.add(elementId);
            ids.push(elementId);
        }
    }
    return ids;
}

export function selectCriticalConnectorPath({ connectorPathfinding, localLossSamples } = {}) {
    const terminalPaths = Array.isArray(connectorPathfinding?.terminalPaths)
        ? connectorPathfinding.terminalPaths
        : [];
    const pressureByElementId = pressureDropByElementId(localLossSamples);
    const reachable = terminalPaths
        .filter((path) => path?.reachable === true && Array.isArray(path.pathElementIds) && path.pathElementIds.length > 0)
        .map((path) => ({
            elementId: path.elementId,
            hopCount: Number.isFinite(Number(path.hopCount)) ? Number(path.hopCount) : path.pathElementIds.length - 1,
            pathElementIds: path.pathElementIds
                .map((value) => Number.parseInt(String(value), 10))
                .filter((value) => Number.isFinite(value) && value > 0),
        }))
        .map((path) => {
            const pressure = path.pathElementIds.reduce((total, elementId) => {
                return total + (pressureByElementId.get(elementId)?.pressureDropPa || 0);
            }, 0);
            const pressureDropParameterCount = path.pathElementIds.reduce((total, elementId) => {
                return total + (pressureByElementId.get(elementId)?.pressureDropParameterCount || 0);
            }, 0);
            return {
                ...path,
                totalPressureDropPa: pressure,
                pressureDropParameterCount,
            };
        })
        .filter((path) => path.pathElementIds.length > 0);
    const warnings = [];
    if (!connectorPathfinding) {
        warnings.push("Connector pathfinding output was not supplied for critical-path local-loss targeting.");
    }
    if (reachable.length === 0) {
        warnings.push("No reachable connector path was available for critical-path local-loss targeting.");
        return {
            success: false,
            method: "Select live connector path with maximum hop count for targeted local-loss extraction",
            strategy: "max_hop_count",
            reachableTerminalCount: 0,
            pathElementIds: [],
            warnings,
            canCommit: false,
        };
    }
    const canRankByPressure = reachable.some((path) => path.pressureDropParameterCount > 0);
    reachable.sort((a, b) => {
        if (canRankByPressure) {
            const pressureDiff = Number(b.totalPressureDropPa || 0) - Number(a.totalPressureDropPa || 0);
            if (pressureDiff !== 0) return pressureDiff;
        }
        const hopDiff = Number(b.hopCount || 0) - Number(a.hopCount || 0);
        if (hopDiff !== 0) return hopDiff;
        return b.pathElementIds.length - a.pathElementIds.length;
    });
    const selected = reachable[0];
    return {
        success: true,
        method: canRankByPressure
            ? "Select live connector path with maximum explicit local-loss pressure drop for targeted extraction"
            : "Select live connector path with maximum hop count for targeted local-loss extraction",
        strategy: canRankByPressure ? "max_local_loss_pressure_drop" : "max_hop_count",
        selectedTerminalElementId: selected.elementId,
        selectedHopCount: selected.hopCount,
        selectedTotalPressureDropPa: selected.totalPressureDropPa,
        selectedPressureDropParameterCount: selected.pressureDropParameterCount,
        reachableTerminalCount: reachable.length,
        pathElementIds: selected.pathElementIds,
        terminalPathSummaries: reachable.map((path) => ({
            elementId: path.elementId,
            hopCount: path.hopCount,
            pathElementCount: path.pathElementIds.length,
            totalPressureDropPa: path.totalPressureDropPa,
            pressureDropParameterCount: path.pressureDropParameterCount,
        })),
        warnings,
        canCommit: false,
    };
}

export function summarizeLocalLossSamples({ discipline = "general", samples = [], sampleLimit, criticalPathSelection } = {}) {
    const safeSamples = Array.isArray(samples) ? samples : [];
    const rows = [];
    const countsByCategory = {};
    const parameterNameCounts = {};
    let elementsWithLossParameters = 0;
    let numericParameterCount = 0;
    let pressureDropParameterCount = 0;
    let lossCoefficientParameterCount = 0;
    let equivalentLengthParameterCount = 0;
    let totalPressureDropPa = 0;
    const pressureDropBySystem = {};
    const pressureDropByCategory = {};
    for (const sample of safeSamples) {
        const category = sample.category || "";
        const systemName = sample.systemName || "(unassigned)";
        countsByCategory[category || "(uncategorized)"] = (countsByCategory[category || "(uncategorized)"] || 0) + 1;
        const parameters = Array.isArray(sample.lossParameters) ? sample.lossParameters : [];
        if (parameters.length > 0) {
            elementsWithLossParameters++;
        }
        for (const parameter of parameters) {
            const valueKind = parameter.valueKind || "unknown";
            const numericValue = finiteOrNull(parameter.numericValue);
            if (numericValue !== null) {
                numericParameterCount++;
                if (valueKind === "pressure_drop_pa") {
                    pressureDropParameterCount++;
                    totalPressureDropPa += numericValue;
                    pressureDropBySystem[systemName] = (pressureDropBySystem[systemName] || 0) + numericValue;
                    pressureDropByCategory[category || "(uncategorized)"] = (pressureDropByCategory[category || "(uncategorized)"] || 0) + numericValue;
                }
                if (valueKind === "loss_coefficient") {
                    lossCoefficientParameterCount++;
                }
                if (valueKind === "equivalent_length_m") {
                    equivalentLengthParameterCount++;
                }
            }
            const parameterName = parameter.parameterName || "";
            if (parameterName) {
                parameterNameCounts[parameterName] = (parameterNameCounts[parameterName] || 0) + 1;
            }
            rows.push({
                rowType: "local_loss_parameter",
                discipline,
                elementId: sample.elementId,
                uniqueId: sample.uniqueId || "",
                category,
                systemName: sample.systemName || "(unassigned)",
                familyName: sample.familyName || "",
                typeName: sample.typeName || "",
                parameterName,
                parameterSource: parameter.parameterSource || "instance",
                valueKind,
                numericValue,
                displayValue: parameter.displayValue || "",
                storageType: parameter.storageType || "",
                source: "revitRead.localLossSamples",
                canCommit: false,
            });
        }
    }
    const warnings = [];
    if (safeSamples.length === 0) {
        warnings.push("No fitting/accessory/equipment local-loss samples were returned by the live Revit collector.");
    }
    else if (rows.length === 0) {
        warnings.push("No calibrated local-loss parameters were found in the sampled fitting/accessory/equipment elements.");
    }
    else if (pressureDropParameterCount === 0 && lossCoefficientParameterCount === 0 && equivalentLengthParameterCount === 0) {
        warnings.push("Local-loss parameters were found, but none were classified as pressure drop, loss coefficient, or equivalent length.");
    }
    return {
        success: true,
        method: "Read-only fitting/accessory/equipment parameter extraction for local-loss calibration",
        discipline,
        sampleLimit: Number.isFinite(Number(sampleLimit)) ? Number(sampleLimit) : undefined,
        ...(criticalPathSelection ? {
            criticalPathSelection,
            targetedByCriticalPath: criticalPathSelection.success === true,
        } : {}),
        inspectedElementCount: safeSamples.length,
        elementsWithLossParameters,
        localLossParameterCount: rows.length,
        numericParameterCount,
        pressureDropParameterCount,
        lossCoefficientParameterCount,
        equivalentLengthParameterCount,
        totalPressureDropPa,
        pressureContribution: buildPressureContribution({
            discipline,
            pressureDropParameterCount,
            totalPressureDropPa,
            pressureDropBySystem,
            pressureDropByCategory,
        }),
        countsByCategory,
        parameterNameCounts,
        rows,
        warnings,
        assumptions: [
            "Rows reflect explicit loss-like Revit parameters on fittings, accessories, terminals, and equipment; missing manufacturer data is reported instead of inferred.",
            "Pressure values are converted to Pa only when Revit accepts the parameter unit conversion; raw display text is retained for audit.",
            "This extraction is read-only and does not size, replace, or reconnect model elements.",
        ],
        canCommit: false,
    };
}

function buildPressureContribution({
    discipline,
    pressureDropParameterCount,
    totalPressureDropPa,
    pressureDropBySystem,
    pressureDropByCategory,
}) {
    const bySystem = objectToRows(pressureDropBySystem, "systemName");
    const byCategory = objectToRows(pressureDropByCategory, "category");
    return {
        success: true,
        discipline,
        method: "Sum of explicit numeric pressure-drop parameters extracted from live Revit local-loss elements",
        pressureDropParameterCount,
        totalPressureDropPa,
        totalPressureDropKPa: totalPressureDropPa / 1000.0,
        bySystem,
        byCategory,
        assumptions: [
            "Only numeric parameters classified as pressure_drop_pa are included in this pressure contribution.",
            "Rows are suitable as additional fan pressure or pump head input only after confirming the sampled elements belong to the design critical path/circuit.",
        ],
        canCommit: false,
    };
}

function objectToRows(valuesByKey, keyName) {
    return Object.entries(valuesByKey || {})
        .map(([key, value]) => ({
            [keyName]: key || "(unassigned)",
            pressureDropPa: value,
            pressureDropKPa: value / 1000.0,
        }))
        .sort((a, b) => Number(b.pressureDropPa || 0) - Number(a.pressureDropPa || 0));
}

function finiteOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function pressureDropByElementId(samples) {
    const byElementId = new Map();
    if (!Array.isArray(samples)) return byElementId;
    for (const sample of samples) {
        const elementId = Number.parseInt(String(sample?.elementId), 10);
        if (!Number.isFinite(elementId) || elementId <= 0) continue;
        const current = byElementId.get(elementId) || {
            pressureDropPa: 0,
            pressureDropParameterCount: 0,
        };
        const parameters = Array.isArray(sample?.lossParameters) ? sample.lossParameters : [];
        for (const parameter of parameters) {
            if (parameter?.valueKind !== "pressure_drop_pa") continue;
            const numericValue = finiteOrNull(parameter.numericValue);
            if (numericValue === null) continue;
            current.pressureDropPa += numericValue;
            current.pressureDropParameterCount++;
        }
        byElementId.set(elementId, current);
    }
    return byElementId;
}
