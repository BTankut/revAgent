export function summarizeLocalLossSamples({ discipline = "general", samples = [], sampleLimit } = {}) {
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
