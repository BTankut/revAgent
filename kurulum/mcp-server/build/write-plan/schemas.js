import { randomUUID } from "node:crypto";
import { classifyPlanRisk, riskForOperation, riskLevels } from "./risk.js";

export const schemaVersion = "1.0";

export const disciplines = [
    "hvac",
    "hydronic",
    "sanitary",
    "domestic_water",
    "fire",
    "sprinkler",
    "clash",
    "general",
];

export const writePlanModes = ["validate", "preview", "commit", "verify"];

export const initialOperations = [
    "set_parameter",
    "clear_parameter",
    "copy_parameter_value",
    "change_type",
    "pin_elements",
    "unpin_elements",
    "delete_elements",
    "view_hide_elements",
    "view_unhide_elements",
    "view_apply_overrides",
    "export_boq_report",
    "export_clash_report",
    "place_family_instance",
    "move_elements",
    "copy_elements",
    "create_duct_run",
    "resize_duct",
    "create_pipe_run",
    "resize_pipe",
    "create_schedule_or_update_schedule",
    "commit_reroute",
];

export const futureOperations = [
    "tag_elements",
    "rotate_elements",
    "align_elements",
    "create_opening_or_sleeve",
    "place_support_or_hanger",
    "create_duct_branch",
    "place_air_terminal",
    "place_damper",
    "place_vav_or_air_device",
    "connect_air_terminal_to_duct",
    "connect_ducts",
    "replace_duct_fitting",
    "apply_duct_insulation",
    "assign_air_system",
    "balance_airflows",
    "size_ducts_equal_friction",
    "calculate_duct_critical_path",
    "select_fan_by_flow_pressure",
    "create_pipe_branch",
    "place_valve",
    "place_pump",
    "place_coil_connection",
    "connect_pipes",
    "apply_pipe_insulation",
    "assign_hydronic_system",
    "calculate_pipe_pressure_loss",
    "size_pipes_by_velocity_or_friction",
    "calculate_pump_head",
    "select_pump_by_flow_head",
    "create_domestic_water_run",
    "place_fixture_connection",
    "size_domestic_water_pipe",
    "calculate_fixture_units",
    "calculate_domestic_water_pressure_loss",
    "verify_hot_water_recirculation",
    "create_sanitary_pipe_run",
    "create_vent_pipe_run",
    "create_storm_pipe_run",
    "apply_pipe_slope",
    "size_sanitary_pipe",
    "size_storm_pipe",
    "verify_gravity_flow",
    "verify_venting",
    "route_to_stack",
    "place_sprinklers",
    "create_sprinkler_branch",
    "create_sprinkler_main",
    "size_sprinkler_pipe",
    "verify_sprinkler_coverage",
    "place_fire_cabinet",
    "route_fire_cabinet_pipe",
    "calculate_fire_flow_pressure",
    "select_fire_pump_basis",
    "detect_clashes",
    "classify_clash",
    "propose_reroute",
    "preview_reroute",
    "create_coordination_issue",
    "mark_clash_resolved",
];

export const supportedOperations = [...initialOperations, ...futureOperations];

export function normalizeDiscipline(value) {
    if (!value) return "general";
    const normalized = String(value).toLowerCase().replace(/-/g, "_");
    return disciplines.includes(normalized) ? normalized : "general";
}

export function buildPlanFromArgs(args = {}, context = {}) {
    const now = new Date().toISOString();
    const steps = Array.isArray(args.steps) && args.steps.length > 0
        ? args.steps
        : [
            {
                stepId: args.stepId || "step-001",
                eId: args.eId,
                operation: args.operation,
                dependsOn: [],
                targets: args.targets || {},
                arguments: args.arguments || {},
                preconditions: args.preconditions || [],
            },
        ];
    const normalized = normalizePlan({
        schemaVersion,
        planId: args.planId || randomUUID(),
        title: args.title || titleFromOperation(args.operation),
        discipline: normalizeDiscipline(args.discipline),
        riskLevel: args.riskLevel,
        source: {
            userRequest: args.userRequest || "",
            createdBy: args.createdBy || "llm",
            revitVersion: context.revitVersion || args.revitVersion || "2022",
        },
        context: {
            documentTitle: context.documentTitle || args.documentTitle || "",
            activeViewId: context.activeViewId || args.activeViewId || 0,
            activeViewType: context.activeViewType || args.activeViewType || "",
        },
        steps,
        verification: args.verification || {},
        audit: {
            createdAt: now,
            updatedAt: now,
            ...(args.audit || {}),
        },
    });
    normalized.riskLevel = classifyPlanRisk(normalized);
    return normalized;
}

export function normalizePlan(input = {}) {
    const now = new Date().toISOString();
    const plan = {
        schemaVersion: input.schemaVersion || schemaVersion,
        planId: input.planId || randomUUID(),
        title: input.title || "Untitled write plan",
        discipline: normalizeDiscipline(input.discipline),
        riskLevel: riskLevels.includes(input.riskLevel) ? input.riskLevel : "low",
        source: {
            userRequest: input.source?.userRequest || input.userRequest || "",
            createdBy: input.source?.createdBy || input.createdBy || "llm",
            revitVersion: input.source?.revitVersion || input.revitVersion || "2022",
        },
        context: {
            documentTitle: input.context?.documentTitle || input.documentTitle || "",
            activeViewId: Number(input.context?.activeViewId || input.activeViewId || 0),
            activeViewType: input.context?.activeViewType || input.activeViewType || "",
        },
        steps: normalizeSteps(input.steps || []),
        verification: input.verification || {},
        audit: {
            createdAt: input.audit?.createdAt || now,
            updatedAt: now,
            ...(input.audit || {}),
        },
    };
    plan.riskLevel = classifyPlanRisk(plan);
    return plan;
}

export function normalizeSteps(steps) {
    return (Array.isArray(steps) ? steps : []).map((step, index) => {
        const operation = step.operation || "unknown";
        return {
            stepId: step.stepId || `step-${String(index + 1).padStart(3, "0")}`,
            eId: step.eId || undefined,
            operation,
            dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
            targets: step.targets || {},
            arguments: step.arguments || {},
            preconditions: Array.isArray(step.preconditions) ? step.preconditions : [],
            riskLevel: riskLevels.includes(step.riskLevel) ? step.riskLevel : riskForOperation(operation),
        };
    });
}

function titleFromOperation(operation) {
    if (!operation) return "Revit write plan";
    return operation
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
