import { missingStandardsForDiscipline } from "../office-standards/defaults.js";
import { riskForOperation, riskLevels } from "./risk.js";
import { initialOperations, schemaVersion, supportedOperations, writePlanModes } from "./schemas.js";

export function validateWritePlan(plan, options = {}) {
    const errors = [];
    const warnings = [];
    if (!plan || typeof plan !== "object") {
        return { valid: false, errors: ["plan must be an object"], warnings };
    }
    if (plan.schemaVersion !== schemaVersion) {
        errors.push(`schemaVersion must be ${schemaVersion}`);
    }
    if (!isNonEmptyString(plan.planId)) {
        errors.push("planId is required");
    }
    if (!isNonEmptyString(plan.title)) {
        errors.push("title is required");
    }
    if (!isNonEmptyString(plan.discipline)) {
        errors.push("discipline is required");
    }
    if (!riskLevels.includes(plan.riskLevel)) {
        errors.push("riskLevel must be low, medium, high, or critical");
    }
    if (!plan.source || typeof plan.source !== "object") {
        errors.push("source is required");
    }
    if (!plan.context || typeof plan.context !== "object") {
        errors.push("context is required");
    }
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
        errors.push("steps must contain at least one step");
    }
    else {
        const stepIds = new Set();
        for (const [index, step] of plan.steps.entries()) {
            const stepResult = validateStep(step, index, options.officeStandards);
            errors.push(...stepResult.errors);
            warnings.push(...stepResult.warnings);
            if (step.stepId) {
                if (stepIds.has(step.stepId)) {
                    errors.push(`steps[${index}].stepId is duplicated: ${step.stepId}`);
                }
                stepIds.add(step.stepId);
            }
        }
    }
    if (options.mode && !writePlanModes.includes(options.mode)) {
        errors.push(`Unsupported mode: ${options.mode}`);
    }
    if (options.requireInitialOperationsOnly) {
        for (const step of plan.steps || []) {
            if (!initialOperations.includes(step.operation)) {
                errors.push(`Operation is cataloged but not implemented in the native starter executor: ${step.operation}`);
            }
        }
    }
    const missingStandards = options.officeStandards
        ? missingStandardsForDiscipline(plan.discipline, options.officeStandards)
        : [];
    const requiresOfficeStandard = missingStandards.length > 0 && hasEngineeringOperation(plan);
    if (requiresOfficeStandard) {
        warnings.push(`Missing office standards: ${missingStandards.join(", ")}`);
    }
    return {
        valid: errors.length === 0,
        errors,
        warnings,
        requiresOfficeStandard,
        missingStandards,
        canCommit: errors.length === 0 && !requiresOfficeStandard,
    };
}

export function validateStep(step, index = 0, officeStandards = null) {
    const prefix = `steps[${index}]`;
    const errors = [];
    const warnings = [];
    if (!step || typeof step !== "object") {
        return { errors: [`${prefix} must be an object`], warnings };
    }
    if (!isNonEmptyString(step.stepId)) {
        errors.push(`${prefix}.stepId is required`);
    }
    if (!isNonEmptyString(step.operation)) {
        errors.push(`${prefix}.operation is required`);
    }
    else if (!supportedOperations.includes(step.operation)) {
        errors.push(`${prefix}.operation is not in the write operation catalog: ${step.operation}`);
    }
    if (!step.targets || typeof step.targets !== "object") {
        errors.push(`${prefix}.targets must be an object`);
    }
    if (!step.arguments || typeof step.arguments !== "object") {
        errors.push(`${prefix}.arguments must be an object`);
    }
    if (!Array.isArray(step.dependsOn)) {
        errors.push(`${prefix}.dependsOn must be an array`);
    }
    if (!Array.isArray(step.preconditions)) {
        errors.push(`${prefix}.preconditions must be an array`);
    }
    if (!riskLevels.includes(step.riskLevel || riskForOperation(step.operation))) {
        errors.push(`${prefix}.riskLevel is invalid`);
    }
    validateOperationPayload(step, prefix, errors, warnings, officeStandards);
    return { errors, warnings };
}

function validateOperationPayload(step, prefix, errors, warnings, officeStandards = null) {
    const targets = step.targets || {};
    const args = step.arguments || {};
    switch (step.operation) {
        case "set_parameter":
            requireTargetElement(targets, prefix, errors);
            if (!isNonEmptyString(args.parameterName)) errors.push(`${prefix}.arguments.parameterName is required`);
            validateAllowedParameterName(args.parameterName, "arguments.parameterName", prefix, errors, warnings, officeStandards);
            if (!("value" in args)) errors.push(`${prefix}.arguments.value is required`);
            break;
        case "clear_parameter":
            requireTargetElement(targets, prefix, errors);
            if (!isNonEmptyString(args.parameterName)) errors.push(`${prefix}.arguments.parameterName is required`);
            validateAllowedParameterName(args.parameterName, "arguments.parameterName", prefix, errors, warnings, officeStandards);
            break;
        case "copy_parameter_value":
            requireTargetElement(targets, prefix, errors);
            if (!hasElementReference(args.sourceElementId, args.sourceEId)) errors.push(`${prefix}.arguments.sourceElementId or sourceEId is required`);
            if (!isNonEmptyString(args.sourceParameterName)) errors.push(`${prefix}.arguments.sourceParameterName is required`);
            if (!isNonEmptyString(args.targetParameterName)) errors.push(`${prefix}.arguments.targetParameterName is required`);
            validateAllowedParameterName(args.sourceParameterName, "arguments.sourceParameterName", prefix, errors, warnings, officeStandards);
            validateAllowedParameterName(args.targetParameterName, "arguments.targetParameterName", prefix, errors, warnings, officeStandards);
            break;
        case "change_type":
            requireTargetElement(targets, prefix, errors);
            if (!Number.isFinite(Number(args.typeId))) errors.push(`${prefix}.arguments.typeId is required`);
            break;
        case "pin_elements":
        case "unpin_elements":
        case "delete_elements":
        case "tag_elements":
        case "view_hide_elements":
        case "view_unhide_elements":
        case "view_apply_overrides":
        case "move_elements":
        case "copy_elements":
        case "rotate_elements":
        case "align_elements":
            if (!hasAnyTargetElements(targets)) errors.push(`${prefix}.targets.elementIds or elementId is required`);
            if (step.operation === "view_apply_overrides" &&
                !args.projectionLineColor &&
                args.projectionLineWeight == null) {
                errors.push(`${prefix}.arguments.projectionLineColor or projectionLineWeight is required`);
            }
            if (step.operation === "tag_elements") {
                if (!args.point) errors.push(`${prefix}.arguments.point is required`);
            }
            if ((step.operation === "move_elements" || step.operation === "copy_elements") && !args.vector) errors.push(`${prefix}.arguments.vector is required`);
            if (step.operation === "align_elements") {
                if (!args.sourcePoint || !args.targetPoint) errors.push(`${prefix}.arguments.sourcePoint and targetPoint are required`);
                if (args.axes != null && !Array.isArray(args.axes) && typeof args.axes !== "string") errors.push(`${prefix}.arguments.axes must be a string or array when provided`);
            }
            if (step.operation === "rotate_elements") {
                if (!args.axis?.start || !args.axis?.end) errors.push(`${prefix}.arguments.axis.start/end is required`);
                if (args.angle == null && args.angleRadians == null && args.angleDegrees == null) errors.push(`${prefix}.arguments.angleRadians or angleDegrees is required`);
            }
            break;
        case "place_family_instance":
            if (!args.point) errors.push(`${prefix}.arguments.point is required`);
            if (!args.familySymbolId && !(args.familyName && args.typeName)) errors.push(`${prefix}.arguments.familySymbolId or familyName/typeName is required`);
            break;
        case "create_duct_run":
            if (!Array.isArray(args.points) || args.points.length < 2) errors.push(`${prefix}.arguments.points must contain at least two points`);
            if (!Number.isFinite(Number(args.systemTypeId))) errors.push(`${prefix}.arguments.systemTypeId is required`);
            if (!Number.isFinite(Number(args.ductTypeId)) && !Number.isFinite(Number(args.typeId))) errors.push(`${prefix}.arguments.ductTypeId or typeId is required`);
            if (!Number.isFinite(Number(args.levelId))) errors.push(`${prefix}.arguments.levelId is required`);
            break;
        case "create_pipe_run":
            if (!Array.isArray(args.points) || args.points.length < 2) errors.push(`${prefix}.arguments.points must contain at least two points`);
            if (!Number.isFinite(Number(args.systemTypeId))) errors.push(`${prefix}.arguments.systemTypeId is required`);
            if (!Number.isFinite(Number(args.pipeTypeId)) && !Number.isFinite(Number(args.typeId))) errors.push(`${prefix}.arguments.pipeTypeId or typeId is required`);
            if (!Number.isFinite(Number(args.levelId))) errors.push(`${prefix}.arguments.levelId is required`);
            break;
        case "resize_duct":
            requireTargetElement(targets, prefix, errors);
            if (args.width == null && args.height == null && args.diameter == null) errors.push(`${prefix}.arguments.width/height or diameter is required`);
            break;
        case "resize_pipe":
            requireTargetElement(targets, prefix, errors);
            if (args.diameter == null) errors.push(`${prefix}.arguments.diameter is required`);
            break;
        case "create_schedule_or_update_schedule":
            if (!isNonEmptyString(args.scheduleName)) errors.push(`${prefix}.arguments.scheduleName is required`);
            if (!Number.isFinite(Number(args.scheduleId)) &&
                !Number.isFinite(Number(targets.elementId)) &&
                !Number.isFinite(Number(args.categoryId)) &&
                !isNonEmptyString(args.category)) {
                errors.push(`${prefix}.arguments.category/categoryId or scheduleId/targets.elementId is required`);
            }
            if (args.fields && !Array.isArray(args.fields)) {
                errors.push(`${prefix}.arguments.fields must be an array when provided`);
            }
            if (Array.isArray(args.fields) && args.fields.length === 0) {
                warnings.push(`${prefix}.arguments.fields is empty; schedule will be created or renamed without adding fields`);
            }
            break;
        case "commit_reroute":
            if (!Array.isArray(args.points) || args.points.length < 2) {
                errors.push(`${prefix}.arguments.points must contain at least two points`);
            }
            if (!Number.isFinite(Number(args.systemTypeId))) {
                errors.push(`${prefix}.arguments.systemTypeId is required`);
            }
            if (String(args.curveType || "duct").toLowerCase() === "pipe") {
                if (!Number.isFinite(Number(args.pipeTypeId)) && !Number.isFinite(Number(args.typeId))) {
                    errors.push(`${prefix}.arguments.pipeTypeId or typeId is required`);
                }
            }
            else if (!Number.isFinite(Number(args.ductTypeId)) && !Number.isFinite(Number(args.typeId))) {
                errors.push(`${prefix}.arguments.ductTypeId or typeId is required`);
            }
            if (!Number.isFinite(Number(args.levelId))) {
                errors.push(`${prefix}.arguments.levelId is required`);
            }
            if (args.obstacleBoxes && !Array.isArray(args.obstacleBoxes)) {
                errors.push(`${prefix}.arguments.obstacleBoxes must be an array when provided`);
            }
            if (args.obstacles && !Array.isArray(args.obstacles)) {
                errors.push(`${prefix}.arguments.obstacles must be an array when provided`);
            }
            if ((args.deleteSource === true || args.replaceSource === true) &&
                !Number.isFinite(Number(args.sourceElementId)) &&
                !Number.isFinite(Number(targets.sourceElementId))) {
                errors.push(`${prefix}.arguments.sourceElementId or targets.sourceElementId is required when deleteSource/replaceSource is true`);
            }
            if ((args.reconnect === true || args.reconnectSource === true) &&
                !Number.isFinite(Number(args.sourceElementId)) &&
                !Number.isFinite(Number(targets.sourceElementId))) {
                errors.push(`${prefix}.arguments.sourceElementId or targets.sourceElementId is required when reconnect/reconnectSource is true`);
            }
            if (args.expectedSourceConnectionCount !== undefined && (!Number.isInteger(Number(args.expectedSourceConnectionCount)) || Number(args.expectedSourceConnectionCount) < 0)) {
                errors.push(`${prefix}.arguments.expectedSourceConnectionCount must be a non-negative integer when provided`);
            }
            break;
        case "export_boq_report":
        case "export_clash_report":
            if (args.format && !["csv", "json"].includes(String(args.format).toLowerCase())) {
                errors.push(`${prefix}.arguments.format must be csv or json`);
            }
            if (args.rows && !Array.isArray(args.rows)) {
                errors.push(`${prefix}.arguments.rows must be an array when provided`);
            }
            if (args.reportRows && !Array.isArray(args.reportRows)) {
                errors.push(`${prefix}.arguments.reportRows must be an array when provided`);
            }
            if (!args.rows && !args.reportRows) {
                warnings.push(`${prefix} has no rows; report export will create an empty file`);
            }
            break;
        default:
            if (!initialOperations.includes(step.operation)) {
                warnings.push(`${prefix}.operation is cataloged as a foundation operation; native execution may not be implemented yet`);
            }
            break;
    }
}

function requireTargetElement(targets, prefix, errors) {
    if (!hasElementReference(targets.elementId, targets.eId) && !hasAnyTargetElements(targets)) {
        errors.push(`${prefix}.targets.elementId, eId, or elementIds is required`);
    }
}

function validateAllowedParameterName(parameterName, argumentPath, prefix, errors, warnings, officeStandards) {
    if (!officeStandards || !isNonEmptyString(parameterName)) {
        return;
    }
    const allowedNames = collectAllowedParameterNames(officeStandards);
    if (allowedNames.size === 0 || allowedNames.has(parameterName.trim())) {
        return;
    }
    const message = `${prefix}.${argumentPath} "${parameterName}" is not in officeStandards.allowedParameterNames or exactSchemaMappings`;
    if (officeStandards.enforceAllowedParameterNames === true) {
        errors.push(message);
    }
    else {
        warnings.push(`${message}; allowedParameterNames: ${summarizeAllowedParameterNames(officeStandards.allowedParameterNames)}`);
    }
}

function collectAllowedParameterNames(officeStandards) {
    const names = new Set();
    for (const name of normalizeAllowedParameterNameList(officeStandards.allowedParameterNames)) {
        addAllowedParameterName(names, name);
    }
    collectExactSchemaMappingNames(names, officeStandards.exactSchemaMappings);
    return names;
}

function collectExactSchemaMappingNames(names, mappings) {
    if (!mappings || typeof mappings !== "object") {
        return;
    }
    if (Array.isArray(mappings)) {
        for (const item of mappings) {
            collectExactSchemaMappingValueNames(names, item);
        }
        return;
    }
    for (const value of Object.values(mappings)) {
        if (typeof value === "string") {
            addAllowedParameterName(names, value);
        }
        else if (Array.isArray(value)) {
            for (const item of value) {
                collectExactSchemaMappingValueNames(names, item);
            }
        }
        else if (value && typeof value === "object") {
            collectExactSchemaMappingValueNames(names, value);
        }
    }
}

function collectExactSchemaMappingValueNames(names, value) {
    if (typeof value === "string") {
        addAllowedParameterName(names, value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            collectExactSchemaMappingValueNames(names, item);
        }
        return;
    }
    if (!value || typeof value !== "object") {
        return;
    }
    for (const field of ["parameterName", "sourceParameterName", "targetParameterName", "name", "revitParameterName"]) {
        addAllowedParameterName(names, value[field]);
    }
}

function addAllowedParameterName(names, value) {
    if (isNonEmptyString(value)) {
        names.add(value.trim());
    }
}

function summarizeAllowedParameterNames(allowedParameterNames = []) {
    const names = normalizeAllowedParameterNameList(allowedParameterNames).filter(isNonEmptyString).map((name) => name.trim());
    if (names.length === 0) {
        return "(none)";
    }
    const visible = names.slice(0, 10).join(", ");
    return names.length > 10 ? `${visible}, ...` : visible;
}

function normalizeAllowedParameterNameList(value) {
    if (Array.isArray(value)) {
        return value;
    }
    return isNonEmptyString(value) ? [value] : [];
}

function hasAnyTargetElements(targets) {
    return Array.isArray(targets.elementIds) && targets.elementIds.length > 0;
}

function hasElementReference(elementId, eId) {
    return Number.isFinite(Number(elementId)) || isNonEmptyString(eId);
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function hasEngineeringOperation(plan) {
    return (plan.steps || []).some((step) => /duct|pipe|sprinkler|hydraulic|pump|fan|flow|pressure|clash|reroute|sizing/.test(step.operation || ""));
}
