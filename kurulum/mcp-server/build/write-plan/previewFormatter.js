export function buildPreviewRows(plan, validation = {}) {
    const rows = [];
    for (const step of plan.steps || []) {
        rows.push({
            planId: plan.planId,
            stepId: step.stepId,
            eId: step.eId || "",
            operation: step.operation,
            target: describeTargets(step.targets),
            proposedChange: describeArguments(step.arguments),
            riskLevel: step.riskLevel || plan.riskLevel,
            willMutateModel: false,
            status: validation.valid === false ? "blocked" : "preview",
        });
    }
    return rows;
}

export function buildAudit(mode, plan, extra = {}) {
    return {
        mode,
        planId: plan.planId,
        at: new Date().toISOString(),
        stepCount: Array.isArray(plan.steps) ? plan.steps.length : 0,
        ...extra,
    };
}

function describeTargets(targets = {}) {
    if (targets.elementId) return `elementId=${targets.elementId}`;
    if (targets.eId) return `eId=${targets.eId}`;
    if (Array.isArray(targets.elementIds)) return `elementIds=${targets.elementIds.join(",")}`;
    return JSON.stringify(targets);
}

function describeArguments(args = {}) {
    const clone = { ...args };
    if ("value" in clone && typeof clone.value === "string" && clone.value.length > 120) {
        clone.value = `${clone.value.slice(0, 120)}...`;
    }
    return JSON.stringify(clone);
}
