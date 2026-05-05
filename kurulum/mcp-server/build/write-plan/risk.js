export const riskLevels = ["low", "medium", "high", "critical"];

const operationRisk = {
    set_parameter: "low",
    clear_parameter: "low",
    copy_parameter_value: "low",
    pin_elements: "low",
    unpin_elements: "low",
    view_hide_elements: "low",
    view_unhide_elements: "low",
    view_apply_overrides: "low",
    export_boq_report: "low",
    export_clash_report: "low",
    change_type: "medium",
    place_family_instance: "medium",
    move_elements: "medium",
    copy_elements: "medium",
    rotate_elements: "medium",
    resize_duct: "medium",
    resize_pipe: "medium",
    create_schedule_or_update_schedule: "medium",
    create_duct_run: "high",
    create_pipe_run: "high",
    delete_elements: "critical",
    commit_reroute: "critical",
    replace_equipment: "critical",
};

const nonModelMutatingOperations = new Set([
    "export_boq_report",
    "export_clash_report",
]);

export function riskForOperation(operation) {
    return operationRisk[operation] || "medium";
}

export function compareRisk(a, b) {
    return riskLevels.indexOf(a) - riskLevels.indexOf(b);
}

export function maxRisk(...risks) {
    return risks
        .filter((risk) => riskLevels.includes(risk))
        .sort(compareRisk)
        .pop() || "low";
}

export function classifyPlanRisk(plan) {
    const stepRisks = (plan.steps || []).map((step) => step.riskLevel || riskForOperation(step.operation));
    return maxRisk(plan.riskLevel, ...stepRisks);
}

export function requiresExplicitApproval(riskLevel) {
    return riskLevel === "high" || riskLevel === "critical";
}

export function operationMutatesModel(operation) {
    return Boolean(operationRisk[operation]) && !nonModelMutatingOperations.has(operation);
}
