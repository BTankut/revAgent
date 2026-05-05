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
