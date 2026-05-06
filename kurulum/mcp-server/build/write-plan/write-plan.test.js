import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPreviewRows } from "./previewFormatter.js";
import { classifyPlanRisk } from "./risk.js";
import { commitRuntimeReportPlan, isRuntimeReportPlan, previewRuntimeReportPlan, verifyRuntimeReportPlan } from "./runtimeReportExecutor.js";
import { buildPlanFromArgs, normalizePlan } from "./schemas.js";
import { validateWritePlan } from "./validators.js";
import {
    addWorkflowMappings,
    clearWorkflowState,
    getPlanRecord,
    getWorkflowMappings,
    hydratePlanTargetsFromMappings,
    upsertPlanRecord,
} from "./workflowStore.js";

process.env.REVIT_MCP_WORKFLOW_STATE_FILE = path.join(os.tmpdir(), `revit-mcp-workflow-test-${process.pid}.json`);

const invalid = validateWritePlan(normalizePlan({}), { mode: "validate" });
assert.equal(invalid.valid, false);
assert(invalid.errors.includes("steps must contain at least one step"));

const plan = buildPlanFromArgs({
    title: "Set test parameter",
    discipline: "general",
    operation: "set_parameter",
    targets: { elementId: 123 },
    arguments: { parameterName: "Comments", value: "MCP test" },
});

const validation = validateWritePlan(plan, { mode: "validate" });
assert.equal(validation.valid, true);
assert.equal(classifyPlanRisk(plan), "low");

const rows = buildPreviewRows(plan, validation);
assert.equal(rows.length, 1);
assert.equal(rows[0].operation, "set_parameter");
assert.equal(rows[0].willMutateModel, false);

upsertPlanRecord(plan, { validation, status: "prepared" });
assert.equal(getPlanRecord(plan.planId).status, "prepared");

addWorkflowMappings(plan.planId, [
    {
        eId: "duct-main-001",
        stepId: "step-001",
        elementId: 456,
        uniqueId: "unique-456",
        category: "OST_DuctCurves",
        createdByPlan: true,
    },
]);
assert.equal(getWorkflowMappings(plan.planId).length, 1);

const eIdPlan = normalizePlan({
    ...plan,
    steps: [
        {
            stepId: "step-002",
            eId: "duct-main-001",
            operation: "set_parameter",
            dependsOn: [],
            targets: { eId: "duct-main-001" },
            arguments: { parameterName: "Comments", value: "eId update" },
            preconditions: [],
            riskLevel: "low",
        },
    ],
});
const hydrated = hydratePlanTargetsFromMappings(eIdPlan, getWorkflowMappings(plan.planId));
assert.equal(hydrated.hydration.applied.length, 1);
assert.equal(hydrated.plan.steps[0].targets.elementId, 456);
assert.equal(hydrated.plan.steps[0].targets.uniqueId, "unique-456");

const commitValidation = validateWritePlan(plan, { mode: "commit" });
assert.equal(commitValidation.valid, true);

const clearPlan = buildPlanFromArgs({
    title: "Clear test parameter",
    discipline: "general",
    operation: "clear_parameter",
    targets: { elementId: 124 },
    arguments: { parameterName: "Comments" },
});
const clearValidation = validateWritePlan(clearPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(clearValidation.valid, true);
assert.equal(classifyPlanRisk(clearPlan), "low");

const invalidClearPlan = buildPlanFromArgs({
    title: "Reject clear without parameter",
    discipline: "general",
    operation: "clear_parameter",
    targets: { elementId: 124 },
    arguments: {},
});
const invalidClearValidation = validateWritePlan(invalidClearPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidClearValidation.valid, false);
assert(invalidClearValidation.errors.includes("steps[0].arguments.parameterName is required"));

const copyParameterPlan = buildPlanFromArgs({
    title: "Copy test parameter",
    discipline: "general",
    operation: "copy_parameter_value",
    targets: { elementId: 125 },
    arguments: {
        sourceElementId: 124,
        sourceParameterName: "Comments",
        targetParameterName: "Comments",
    },
});
const copyParameterValidation = validateWritePlan(copyParameterPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(copyParameterValidation.valid, true);
assert.equal(classifyPlanRisk(copyParameterPlan), "low");

const parameterOfficeStandards = {
    allowedParameterNames: ["Comments"],
    enforceAllowedParameterNames: false,
    exactSchemaMappings: {
        approvedCustomNote: { parameterName: "Approved Custom Note" },
    },
};

const allowedParameterValidation = validateWritePlan(plan, { mode: "commit", officeStandards: parameterOfficeStandards });
assert.equal(allowedParameterValidation.valid, true);
assert.equal(allowedParameterValidation.warnings.some((warning) => warning.includes("officeStandards.allowedParameterNames")), false);

const singleAllowedParameterValidation = validateWritePlan(plan, { mode: "commit", officeStandards: { allowedParameterNames: "Comments" } });
assert.equal(singleAllowedParameterValidation.valid, true);
assert.equal(singleAllowedParameterValidation.warnings.some((warning) => warning.includes("officeStandards.allowedParameterNames")), false);

const mappedParameterPlan = buildPlanFromArgs({
    title: "Set mapped parameter",
    discipline: "general",
    operation: "set_parameter",
    targets: { elementId: 126 },
    arguments: { parameterName: "Approved Custom Note", value: "Mapped value" },
});
const mappedParameterValidation = validateWritePlan(mappedParameterPlan, { mode: "commit", officeStandards: parameterOfficeStandards });
assert.equal(mappedParameterValidation.valid, true);
assert.equal(mappedParameterValidation.warnings.some((warning) => warning.includes("officeStandards.allowedParameterNames")), false);

const mappingAliasParameterPlan = buildPlanFromArgs({
    title: "Warn on logical mapping alias as parameter",
    discipline: "general",
    operation: "set_parameter",
    targets: { elementId: 126 },
    arguments: { parameterName: "approvedCustomNote", value: "Alias value" },
});
const mappingAliasParameterValidation = validateWritePlan(mappingAliasParameterPlan, { mode: "commit", officeStandards: parameterOfficeStandards });
assert.equal(mappingAliasParameterValidation.valid, true);
assert(mappingAliasParameterValidation.warnings.some((warning) => warning.includes("steps[0].arguments.parameterName \"approvedCustomNote\" is not in officeStandards.allowedParameterNames or exactSchemaMappings")));

const disallowedParameterPlan = buildPlanFromArgs({
    title: "Warn on unapproved parameter",
    discipline: "general",
    operation: "set_parameter",
    targets: { elementId: 127 },
    arguments: { parameterName: "Unapproved Parameter", value: "Unsafe target" },
});
const disallowedParameterValidation = validateWritePlan(disallowedParameterPlan, { mode: "commit", officeStandards: parameterOfficeStandards });
assert.equal(disallowedParameterValidation.valid, true);
assert(disallowedParameterValidation.warnings.some((warning) => warning.includes("steps[0].arguments.parameterName \"Unapproved Parameter\" is not in officeStandards.allowedParameterNames or exactSchemaMappings")));

const enforcedDisallowedParameterValidation = validateWritePlan(disallowedParameterPlan, {
    mode: "commit",
    officeStandards: { ...parameterOfficeStandards, enforceAllowedParameterNames: true },
});
assert.equal(enforcedDisallowedParameterValidation.valid, false);
assert(enforcedDisallowedParameterValidation.errors.some((error) => error.includes("steps[0].arguments.parameterName \"Unapproved Parameter\" is not in officeStandards.allowedParameterNames or exactSchemaMappings")));

const disallowedCopyParameterPlan = buildPlanFromArgs({
    title: "Warn on unapproved copy parameter",
    discipline: "general",
    operation: "copy_parameter_value",
    targets: { elementId: 128 },
    arguments: {
        sourceElementId: 124,
        sourceParameterName: "Comments",
        targetParameterName: "Unapproved Target",
    },
});
const disallowedCopyParameterValidation = validateWritePlan(disallowedCopyParameterPlan, { mode: "commit", officeStandards: parameterOfficeStandards });
assert.equal(disallowedCopyParameterValidation.valid, true);
assert(disallowedCopyParameterValidation.warnings.some((warning) => warning.includes("steps[0].arguments.targetParameterName \"Unapproved Target\" is not in officeStandards.allowedParameterNames or exactSchemaMappings")));

const invalidCopyParameterPlan = buildPlanFromArgs({
    title: "Reject copy parameter without source",
    discipline: "general",
    operation: "copy_parameter_value",
    targets: { elementId: 125 },
    arguments: {
        sourceParameterName: "Comments",
        targetParameterName: "Comments",
    },
});
const invalidCopyParameterValidation = validateWritePlan(invalidCopyParameterPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidCopyParameterValidation.valid, false);
assert(invalidCopyParameterValidation.errors.includes("steps[0].arguments.sourceElementId or sourceEId is required"));

const schedulePlan = buildPlanFromArgs({
    title: "Create mechanical equipment schedule",
    discipline: "general",
    operation: "create_schedule_or_update_schedule",
    targets: {},
    arguments: {
        scheduleName: "Codex Mechanical Equipment Schedule",
        category: "OST_MechanicalEquipment",
        fields: [
            { builtInParameter: "ELEM_FAMILY_AND_TYPE_PARAM", heading: "Family and Type" },
            { builtInParameter: "ALL_MODEL_MARK", heading: "Mark" },
        ],
    },
});
const scheduleValidation = validateWritePlan(schedulePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(scheduleValidation.valid, true);
assert.equal(classifyPlanRisk(schedulePlan), "medium");

const pinPlan = buildPlanFromArgs({
    title: "Pin protected model elements",
    discipline: "general",
    operation: "pin_elements",
    targets: { elementIds: [101, 102] },
    arguments: {},
});
const pinValidation = validateWritePlan(pinPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(pinValidation.valid, true);
assert.equal(classifyPlanRisk(pinPlan), "low");

const invalidPinPlan = buildPlanFromArgs({
    title: "Reject pin without targets",
    discipline: "general",
    operation: "pin_elements",
    targets: {},
    arguments: {},
});
const invalidPinValidation = validateWritePlan(invalidPinPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidPinValidation.valid, false);
assert(invalidPinValidation.errors.includes("steps[0].targets.elementIds or elementId is required"));

const deletePlan = buildPlanFromArgs({
    title: "Delete disposable model elements",
    discipline: "general",
    operation: "delete_elements",
    targets: { elementIds: [201] },
    arguments: {},
});
const deleteValidation = validateWritePlan(deletePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(deleteValidation.valid, true);
assert.equal(classifyPlanRisk(deletePlan), "critical");

const invalidDeletePlan = buildPlanFromArgs({
    title: "Reject delete without targets",
    discipline: "general",
    operation: "delete_elements",
    targets: {},
    arguments: {},
});
const invalidDeleteValidation = validateWritePlan(invalidDeletePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidDeleteValidation.valid, false);
assert(invalidDeleteValidation.errors.includes("steps[0].targets.elementIds or elementId is required"));

const tagPlan = buildPlanFromArgs({
    title: "Tag disposable model elements",
    discipline: "general",
    operation: "tag_elements",
    targets: { elementIds: [251] },
    arguments: { point: { x: 0, y: 0, z: 0 }, unit: "m" },
});
const tagValidation = validateWritePlan(tagPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(tagValidation.valid, true);
assert.equal(classifyPlanRisk(tagPlan), "medium");

const invalidTagPlan = buildPlanFromArgs({
    title: "Reject tag without point",
    discipline: "general",
    operation: "tag_elements",
    targets: { elementIds: [251] },
    arguments: {},
});
const invalidTagValidation = validateWritePlan(invalidTagPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidTagValidation.valid, false);
assert(invalidTagValidation.errors.includes("steps[0].arguments.point is required"));

const overridePlan = buildPlanFromArgs({
    title: "Apply view override",
    discipline: "general",
    operation: "view_apply_overrides",
    targets: { elementIds: [275] },
    arguments: { projectionLineColor: { red: 255, green: 0, blue: 0 }, projectionLineWeight: 5 },
});
const overrideValidation = validateWritePlan(overridePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(overrideValidation.valid, true);
assert.equal(classifyPlanRisk(overridePlan), "low");

const invalidOverridePlan = buildPlanFromArgs({
    title: "Reject empty view override",
    discipline: "general",
    operation: "view_apply_overrides",
    targets: { elementIds: [275] },
    arguments: {},
});
const invalidOverrideValidation = validateWritePlan(invalidOverridePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidOverrideValidation.valid, false);
assert(invalidOverrideValidation.errors.includes("steps[0].arguments.projectionLineColor or projectionLineWeight is required"));

const copyPlan = buildPlanFromArgs({
    title: "Copy disposable model elements",
    discipline: "general",
    operation: "copy_elements",
    targets: { elementIds: [301] },
    arguments: { vector: { x: 1, y: 0, z: 0 }, unit: "m" },
});
const copyValidation = validateWritePlan(copyPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(copyValidation.valid, true);
assert.equal(classifyPlanRisk(copyPlan), "medium");

const invalidCopyPlan = buildPlanFromArgs({
    title: "Reject copy without vector",
    discipline: "general",
    operation: "copy_elements",
    targets: { elementIds: [301] },
    arguments: {},
});
const invalidCopyValidation = validateWritePlan(invalidCopyPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidCopyValidation.valid, false);
assert(invalidCopyValidation.errors.includes("steps[0].arguments.vector is required"));

const movePlan = buildPlanFromArgs({
    title: "Move disposable model elements",
    discipline: "general",
    operation: "move_elements",
    targets: { elementIds: [351] },
    arguments: { vector: { x: 1, y: 0, z: 0 }, unit: "m" },
});
const moveValidation = validateWritePlan(movePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(moveValidation.valid, true);
assert.equal(classifyPlanRisk(movePlan), "medium");

const invalidMovePlan = buildPlanFromArgs({
    title: "Reject move without vector",
    discipline: "general",
    operation: "move_elements",
    targets: { elementIds: [351] },
    arguments: {},
});
const invalidMoveValidation = validateWritePlan(invalidMovePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidMoveValidation.valid, false);
assert(invalidMoveValidation.errors.includes("steps[0].arguments.vector is required"));

const placePlan = buildPlanFromArgs({
    title: "Place family instance",
    discipline: "general",
    operation: "place_family_instance",
    targets: {},
    arguments: { familySymbolId: 701, point: { x: 0, y: 0, z: 0 }, unit: "m" },
});
const placeValidation = validateWritePlan(placePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(placeValidation.valid, true);
assert.equal(classifyPlanRisk(placePlan), "medium");

const invalidPlacePlan = buildPlanFromArgs({
    title: "Reject place without symbol",
    discipline: "general",
    operation: "place_family_instance",
    targets: {},
    arguments: { point: { x: 0, y: 0, z: 0 }, unit: "m" },
});
const invalidPlaceValidation = validateWritePlan(invalidPlacePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidPlaceValidation.valid, false);
assert(invalidPlaceValidation.errors.includes("steps[0].arguments.familySymbolId or familyName/typeName is required"));

const rotatePlan = buildPlanFromArgs({
    title: "Rotate disposable model elements",
    discipline: "general",
    operation: "rotate_elements",
    targets: { elementIds: [401] },
    arguments: {
        axis: { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 1 } },
        angleDegrees: 90,
        unit: "m",
    },
});
const rotateValidation = validateWritePlan(rotatePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(rotateValidation.valid, true);
assert.equal(classifyPlanRisk(rotatePlan), "medium");

const invalidRotatePlan = buildPlanFromArgs({
    title: "Reject rotate without axis",
    discipline: "general",
    operation: "rotate_elements",
    targets: { elementIds: [401] },
    arguments: { angleDegrees: 90 },
});
const invalidRotateValidation = validateWritePlan(invalidRotatePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidRotateValidation.valid, false);
assert(invalidRotateValidation.errors.includes("steps[0].arguments.axis.start/end is required"));

const alignPlan = buildPlanFromArgs({
    title: "Align disposable model elements",
    discipline: "general",
    operation: "align_elements",
    targets: { elementIds: [501] },
    arguments: {
        sourcePoint: { x: 0, y: 0, z: 0 },
        targetPoint: { x: 2, y: 0, z: 0 },
        axes: ["x"],
        unit: "m",
    },
});
const alignValidation = validateWritePlan(alignPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(alignValidation.valid, true);
assert.equal(classifyPlanRisk(alignPlan), "medium");

const invalidAlignPlan = buildPlanFromArgs({
    title: "Reject align without points",
    discipline: "general",
    operation: "align_elements",
    targets: { elementIds: [501] },
    arguments: {},
});
const invalidAlignValidation = validateWritePlan(invalidAlignPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidAlignValidation.valid, false);
assert(invalidAlignValidation.errors.includes("steps[0].arguments.sourcePoint and targetPoint are required"));

const ductRunPlan = buildPlanFromArgs({
    title: "Create simple duct run",
    discipline: "hvac",
    operation: "create_duct_run",
    targets: {},
    arguments: {
        systemTypeId: 11,
        ductTypeId: 22,
        levelId: 33,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 3 },
            { x: 2, y: 0, z: 3 },
        ],
        width: 0.3,
        height: 0.3,
    },
});
const ductRunValidation = validateWritePlan(ductRunPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(ductRunValidation.valid, true);
assert.equal(classifyPlanRisk(ductRunPlan), "high");

const invalidDuctRunPlan = buildPlanFromArgs({
    title: "Reject duct run without type ids",
    discipline: "hvac",
    operation: "create_duct_run",
    targets: {},
    arguments: {
        points: [
            { x: 0, y: 0, z: 3 },
            { x: 2, y: 0, z: 3 },
        ],
    },
});
const invalidDuctRunValidation = validateWritePlan(invalidDuctRunPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidDuctRunValidation.valid, false);
assert(invalidDuctRunValidation.errors.includes("steps[0].arguments.systemTypeId is required"));
assert(invalidDuctRunValidation.errors.includes("steps[0].arguments.ductTypeId or typeId is required"));
assert(invalidDuctRunValidation.errors.includes("steps[0].arguments.levelId is required"));

const reroutePlan = buildPlanFromArgs({
    title: "Commit explicit reroute geometry",
    discipline: "clash",
    operation: "commit_reroute",
    targets: {},
    arguments: {
        curveType: "duct",
        systemTypeId: 11,
        ductTypeId: 22,
        levelId: 33,
        sourceElementId: 44,
        deleteSource: true,
        reconnect: true,
        requireReconnect: true,
        expectedSourceConnectionCount: 2,
        requireRouteFittings: true,
        expectedRouteFittingCount: 1,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
            { x: 1, y: 1, z: 3 },
        ],
        obstacleBoxes: [
            { min: { x: 0.25, y: 0.25, z: 2.8 }, max: { x: 0.75, y: 0.75, z: 3.2 } },
        ],
        clearanceM: 0.1,
    },
});
const rerouteValidation = validateWritePlan(reroutePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(rerouteValidation.valid, true);
assert.equal(classifyPlanRisk(reroutePlan), "critical");

const rerouteFittingCreationPlan = buildPlanFromArgs({
    title: "Commit reroute with created route fittings",
    discipline: "clash",
    operation: "commit_reroute",
    targets: {},
    arguments: {
        curveType: "duct",
        systemTypeId: 11,
        ductTypeId: 22,
        levelId: 33,
        connectSegments: true,
        createRouteFittings: true,
        expectedRouteFittingCount: 1,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
            { x: 1, y: 1, z: 3 },
        ],
    },
});
const rerouteFittingCreationValidation = validateWritePlan(rerouteFittingCreationPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(rerouteFittingCreationValidation.valid, true);
assert.equal(classifyPlanRisk(rerouteFittingCreationPlan), "critical");

const invalidRerouteFittingExpectation = buildPlanFromArgs({
    title: "Reject negative reroute fitting expectation",
    discipline: "clash",
    operation: "commit_reroute",
    targets: {},
    arguments: {
        curveType: "duct",
        systemTypeId: 11,
        ductTypeId: 22,
        levelId: 33,
        expectedRouteFittingCount: -1,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
        ],
    },
});
const invalidRerouteFittingValidation = validateWritePlan(invalidRerouteFittingExpectation, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidRerouteFittingValidation.valid, false);
assert(invalidRerouteFittingValidation.errors.includes("steps[0].arguments.expectedRouteFittingCount must be a non-negative integer when provided"));

const invalidReconnectReroute = buildPlanFromArgs({
    title: "Reject reconnect without source element",
    discipline: "clash",
    operation: "commit_reroute",
    targets: {},
    arguments: {
        curveType: "duct",
        systemTypeId: 11,
        ductTypeId: 22,
        levelId: 33,
        reconnectSource: true,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
        ],
    },
});
const invalidReconnectValidation = validateWritePlan(invalidReconnectReroute, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidReconnectValidation.valid, false);
assert(invalidReconnectValidation.errors.includes("steps[0].arguments.sourceElementId or targets.sourceElementId is required when reconnect/reconnectSource is true"));

const connectedReroutePlan = buildPlanFromArgs({
    title: "Commit connected pipe drop reroute",
    discipline: "clash",
    operation: "commit_reroute",
    targets: {},
    arguments: {
        curveType: "pipe",
        systemTypeId: 11,
        pipeTypeId: 22,
        levelId: 33,
        sourceElementId: 1021819,
        connectedEndpointPolicy: "preserve_external_connector",
        expectedSourceConnectionCount: 1,
        expectedOpenConnectorCount: 1,
        preserveConnectedOwnerIds: [1026094],
        expectedClashReduction: 1,
        forbidNewClashElementIds: true,
        commitBatchSize: 1,
        postCommitAudit: true,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 0 },
            { x: 0, y: -1, z: 0 },
            { x: 0, y: -1, z: 1 },
        ],
    },
});
const connectedRerouteValidation = validateWritePlan(connectedReroutePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(connectedRerouteValidation.valid, true);
assert.equal(classifyPlanRisk(connectedReroutePlan), "critical");

const invalidConnectedReroutePlan = buildPlanFromArgs({
    title: "Reject connected pipe drop reroute without safety contract",
    discipline: "clash",
    operation: "commit_reroute",
    targets: {},
    arguments: {
        curveType: "pipe",
        systemTypeId: 11,
        pipeTypeId: 22,
        levelId: 33,
        sourceElementId: 1021819,
        connectedEndpointPolicy: "preserve_external_connector",
        expectedSourceConnectionCount: 1,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 0 },
            { x: 0, y: -1, z: 0 },
        ],
    },
});
const invalidConnectedRerouteValidation = validateWritePlan(invalidConnectedReroutePlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidConnectedRerouteValidation.valid, false);
assert(invalidConnectedRerouteValidation.errors.includes("steps[0].arguments.expectedOpenConnectorCount is required when preserving an external connector"));
assert(invalidConnectedRerouteValidation.errors.includes("steps[0].arguments.preserveConnectedOwnerIds must contain the fitting/equipment owner ids to preserve"));
assert(invalidConnectedRerouteValidation.errors.includes("steps[0].arguments.expectedClashReduction must be at least 1 when preserving an external connector"));
assert(invalidConnectedRerouteValidation.errors.includes("steps[0].arguments.forbidNewClashElementIds must be true when preserving an external connector"));
assert(invalidConnectedRerouteValidation.errors.includes("steps[0].arguments.postCommitAudit must be true when preserving an external connector"));

const endpointStitchPlan = buildPlanFromArgs({
    title: "Preview duct endpoint stitch",
    discipline: "hvac",
    operation: "connect_ducts",
    targets: { elementIds: [1021038, 1021044] },
    arguments: {
        connectionMode: "endpoint_to_endpoint",
        maxDistanceMm: 5,
        requireSameSystemType: true,
        rollbackPreviewRequired: true,
        commitBatchSize: 1,
        heartbeatRequired: true,
        postCommitAudit: true,
        forbidNewElementCreation: true,
        expectedConnectedConnectorIncrease: 2,
        timeoutRecoveryPlan: "Abort the single-pair transaction, report the pair id, and require Revit failure state cleanup before retry.",
    },
});
const endpointStitchValidation = validateWritePlan(endpointStitchPlan, { mode: "preview" });
assert.equal(endpointStitchValidation.valid, true);
assert.equal(classifyPlanRisk(endpointStitchPlan), "critical");
assert(endpointStitchValidation.warnings.some((warning) => warning.includes("dynamic code commits are not acceptable for endpoint stitching")));

const endpointStitchCommitValidation = validateWritePlan(endpointStitchPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(endpointStitchCommitValidation.valid, false);
assert(endpointStitchCommitValidation.errors.includes("Operation is cataloged but not implemented in the native starter executor: connect_ducts"));

const invalidEndpointStitchPlan = buildPlanFromArgs({
    title: "Reject unsafe pipe endpoint stitch",
    discipline: "hydronic",
    operation: "connect_pipes",
    targets: { elementIds: [1021788, 1021810, 1021816] },
    arguments: {
        connectionMode: "endpoint_to_endpoint",
        maxDistanceMm: 1000,
        requireSameSystemType: false,
        commitBatchSize: 5,
    },
});
const invalidEndpointStitchValidation = validateWritePlan(invalidEndpointStitchPlan, { mode: "preview" });
assert.equal(invalidEndpointStitchValidation.valid, false);
assert(invalidEndpointStitchValidation.errors.includes("steps[0].targets.elementIds must contain exactly two ids for connect_pipes"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.maxDistanceMm must be greater than 0 and no more than 500"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.requireSameSystemType must be true for endpoint connection commits"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.rollbackPreviewRequired must be true"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.commitBatchSize must be 1"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.heartbeatRequired must be true"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.postCommitAudit must be true"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.forbidNewElementCreation must be true for endpoint stitching"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.expectedConnectedConnectorIncrease must be an integer of at least 2"));
assert(invalidEndpointStitchValidation.errors.includes("steps[0].arguments.timeoutRecoveryPlan is required"));

const pipeHeaderOverlapPlan = buildPlanFromArgs({
    title: "Preview pipe header overlap normalization",
    discipline: "domestic_water",
    operation: "normalize_pipe_header_overlap",
    targets: { elementIds: [1022539, 1022601] },
    arguments: {
        normalizationMode: "overlap_to_tee_header",
        requireSameSystemType: true,
        requireCollinearOverlap: true,
        requireSameDiameter: true,
        requireBothOppositeEndsConnected: true,
        preserveBranchConnectivity: true,
        allowFittingReplacement: true,
        branchConnectorOwnerRequirement: "pipe_or_flex_pipe",
        rollbackPreviewRequired: true,
        commitBatchSize: 1,
        heartbeatRequired: true,
        postCommitAudit: true,
        expectedDeviceConnectivityUnchanged: true,
        expectedClashIncrease: 0,
        timeoutRecoveryPlan: "Abort the single overlap normalization, roll back the transaction, report the header/overlap pair and failure stage, then require Revit failure state cleanup before retry.",
    },
});
const pipeHeaderOverlapValidation = validateWritePlan(pipeHeaderOverlapPlan, { mode: "preview" });
assert.equal(pipeHeaderOverlapValidation.valid, true);
assert.equal(classifyPlanRisk(pipeHeaderOverlapPlan), "critical");
assert(pipeHeaderOverlapValidation.warnings.some((warning) => warning.includes("native header/tee normalization support")));

const pipeHeaderOverlapCommitValidation = validateWritePlan(pipeHeaderOverlapPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(pipeHeaderOverlapCommitValidation.valid, false);
assert(pipeHeaderOverlapCommitValidation.errors.includes("Operation is cataloged but not implemented in the native starter executor: normalize_pipe_header_overlap"));

const invalidPipeHeaderOverlapPlan = buildPlanFromArgs({
    title: "Reject unsafe pipe header overlap normalization",
    discipline: "domestic_water",
    operation: "normalize_pipe_header_overlap",
    targets: { elementIds: [1022539, 1022601, 1022607] },
    arguments: {
        normalizationMode: "endpoint_to_endpoint",
        requireSameSystemType: false,
        requireCollinearOverlap: false,
        requireSameDiameter: false,
        requireBothOppositeEndsConnected: false,
        preserveBranchConnectivity: false,
        allowFittingReplacement: false,
        branchConnectorOwnerRequirement: "any_connector",
        commitBatchSize: 5,
        expectedClashIncrease: 1,
    },
});
const invalidPipeHeaderOverlapValidation = validateWritePlan(invalidPipeHeaderOverlapPlan, { mode: "preview" });
assert.equal(invalidPipeHeaderOverlapValidation.valid, false);
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].targets.elementIds must contain exactly two ids for normalize_pipe_header_overlap"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.normalizationMode must be overlap_to_tee_header"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.requireSameSystemType must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.requireCollinearOverlap must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.requireSameDiameter must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.requireBothOppositeEndsConnected must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.preserveBranchConnectivity must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.allowFittingReplacement must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.branchConnectorOwnerRequirement must be pipe_or_flex_pipe"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.rollbackPreviewRequired must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.commitBatchSize must be 1"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.heartbeatRequired must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.postCommitAudit must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.expectedDeviceConnectivityUnchanged must be true"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.expectedClashIncrease must be 0"));
assert(invalidPipeHeaderOverlapValidation.errors.includes("steps[0].arguments.timeoutRecoveryPlan is required"));

const invalidDeleteSourceReroute = buildPlanFromArgs({
    title: "Reject source delete without source element",
    discipline: "clash",
    operation: "commit_reroute",
    targets: {},
    arguments: {
        curveType: "duct",
        systemTypeId: 11,
        ductTypeId: 22,
        levelId: 33,
        deleteSource: true,
        unit: "m",
        points: [
            { x: 0, y: 0, z: 3 },
            { x: 1, y: 0, z: 3 },
        ],
    },
});
const invalidDeleteSourceValidation = validateWritePlan(invalidDeleteSourceReroute, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(invalidDeleteSourceValidation.valid, false);
assert(invalidDeleteSourceValidation.errors.includes("steps[0].arguments.sourceElementId or targets.sourceElementId is required when deleteSource/replaceSource is true"));

const reportOutputDir = path.join(os.tmpdir(), `revit-mcp-report-test-${process.pid}`);
const reportPlan = normalizePlan({
    schemaVersion: "1.0",
    planId: "report-plan-001",
    title: "Export BOQ report",
    discipline: "general",
    riskLevel: "low",
    source: { userRequest: "export report", createdBy: "llm", revitVersion: "2022" },
    context: { documentTitle: "test", activeViewId: 0, activeViewType: "" },
    steps: [
        {
            stepId: "report-001",
            operation: "export_boq_report",
            dependsOn: [],
            targets: {},
            arguments: {
                outputDirectory: reportOutputDir,
                fileName: "boq.csv",
                rows: [{ elementId: "123", category: "Ducts", quantity: 2 }],
            },
            preconditions: [],
            riskLevel: "low",
        },
    ],
});
assert.equal(isRuntimeReportPlan(reportPlan), true);
const reportValidation = validateWritePlan(reportPlan, { mode: "commit", requireInitialOperationsOnly: true });
assert.equal(reportValidation.valid, true);
const reportPreview = previewRuntimeReportPlan(reportPlan);
assert.equal(reportPreview.success, true);
assert.equal(reportPreview.mutateModel, false);
assert.equal(reportPreview.previewRows[0].rowCount, 1);
const reportCommit = commitRuntimeReportPlan(reportPlan);
assert.equal(reportCommit.success, true);
assert.equal(reportCommit.mutateModel, false);
assert.equal(reportCommit.writesFiles, true);
assert.equal(fs.existsSync(reportCommit.files[0].outputPath), true);
assert(fs.readFileSync(reportCommit.files[0].outputPath, "utf8").includes("elementId"));
const reportVerify = verifyRuntimeReportPlan(reportPlan);
assert.equal(reportVerify.success, true);
assert.equal(reportVerify.mutateModel, false);
assert.equal(reportVerify.writesFiles, false);
assert.equal(reportVerify.files[0].exists, true);
assert.equal(reportVerify.files[0].contentMatches, true);

clearWorkflowState();

console.log("write-plan schema/state/risk tests passed");
